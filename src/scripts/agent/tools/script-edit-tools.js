import { t } from '../../i18n/index.js';
import { analyzeScriptCompatibility } from '../../import/script-capability-preflight.js';
import { buildScriptPermissionLines } from '../../ui/script-authorization-utils.js';
import { batchResult, confirmRequest, summarizeBatch } from './preset-regex-script-tools.js';

/* 女仆读写脚本代码与脚本设定。用户决定（2026-11-20）：
   - 女仆可以新建与修改脚本代码；新建的一律保持关闭、未授权（source 'maid'），启用另走 script.toggle_many 确认；
   - 改已启用脚本的代码、打开脚本总开关或权限，确认卡跟一般写入一样给记住选项，卡上写明后果。
   做法同其他写入工具：冻结目标 → 一次结构化确认 → 执行前复验 → 读回核对。
   脚本写入经 scriptStore（含兼容性检查：被拦截的代码会让脚本保持关闭）；设定照设置面板写 appSettings。 */

const trim = value => String(value ?? '').trim();
const nameKey = value => trim(value).toLowerCase().replace(/\s+/g, '');
const clip = (value, max = 160) => {
  const text = trim(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const cancelledItem = (item, extra = {}) => ({ ...item, ...extra, status: 'cancelled', reason: 'user_aborted' });
const isAllowed = (context = {}, kind = '') => context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind;

const SCRIPT_SCOPES = Object.freeze(['global', 'character', 'preset']);
const SCOPE_LABELS = Object.freeze({ global: '全局', character: '角色卡', preset: '预设' });
const READ_CHUNK = 20000;
const MAX_UPSERT_ITEMS = 10;
// 工具参数 → appSettings 键；读值规则同设置面板（读取聊天记录、修改变量默认允许，访问网络默认禁用）
const SETTING_FIELDS = Object.freeze([
  { arg: 'scriptsEnabled', key: 'scriptEnabled', label: '全局脚本开关', master: true, read: settings => settings.scriptEnabled === true },
  { arg: 'allowReadMessages', key: 'scriptAllowReadMessages', label: '读取聊天记录', read: settings => settings.scriptAllowReadMessages !== false },
  { arg: 'allowModifyVariables', key: 'scriptAllowModifyVariables', label: '修改变量', read: settings => settings.scriptAllowModifyVariables !== false },
  { arg: 'allowNetwork', key: 'scriptAllowNetwork', label: '访问网络', read: settings => settings.scriptAllowNetwork === true },
]);
// 确认期间被别处改动的判断：名称、说明、代码、启用状态
const scriptFingerprint = script => JSON.stringify([String(script?.name ?? ''), String(script?.info ?? ''), String(script?.content ?? ''), script?.enabled === true]);
const blockReasonOf = compatibility => clip((compatibility?.reasons || []).join('；') || compatibility?.message);

// 每个 find 在现有代码里必须恰好出现一次、彼此不重叠；任何一处不符整项不写
export const applyScriptEdits = (content = '', edits = []) => {
  const source = String(content ?? '');
  const spans = [];
  for (const [editIndex, edit] of edits.entries()) {
    const find = String(edit?.find ?? '');
    if (!find) return { error: 'empty_find', editIndex };
    const at = source.indexOf(find);
    if (at < 0) return { error: 'find_not_found', editIndex };
    if (source.indexOf(find, at + 1) >= 0) return { error: 'find_not_unique', editIndex };
    spans.push({ at, end: at + find.length, replace: String(edit?.replace ?? ''), editIndex });
  }
  spans.sort((a, b) => a.at - b.at);
  const overlap = spans.find((span, i) => i > 0 && span.at < spans[i - 1].end);
  if (overlap) return { error: 'edits_overlap', editIndex: overlap.editIndex };
  let next = '';
  let cursor = 0;
  spans.forEach((span) => { next += source.slice(cursor, span.at) + span.replace; cursor = span.end; });
  return { content: next + source.slice(cursor) };
};

export const createScriptEditAgentTools = ({
  scriptStore = null,
  presetStore = null,
  getCurrentPersonaId = () => '',
  getPersonaName = () => '',
  getScriptSettings = () => ({}),
  // 照设置面板写 appSettings，并发出脚本运行时监听的设定变更事件
  updateScriptSettings = null,
  onScriptsChanged = null,
} = {}) => {
  const snapshots = new WeakMap();
  const ready = async (store) => { try { await store?.ready; } catch {} return store; };
  const notify = () => { try { onScriptsChanged?.(); } catch {} };
  const presetName = (id) => {
    const list = typeof presetStore?.listSummaries === 'function' ? presetStore.listSummaries('openai') : presetStore?.list?.('openai');
    return trim((Array.isArray(list) ? list : []).find(item => trim(item?.id) === id)?.name);
  };
  const scopeLabelOf = (scope, scopeId) => {
    if (scope === 'global') return t('全局');
    const name = scope === 'character' ? trim(getPersonaName?.(scopeId)) : presetName(scopeId);
    return `${t(SCOPE_LABELS[scope])}：${name || scopeId}`;
  };
  const settingsNow = () => getScriptSettings?.() || {};
  const settingsSummary = settings => ({ scriptsRunGlobally: settings.scriptEnabled === true, permissions: buildScriptPermissionLines(settings) });

  const collectScripts = () => {
    const scopes = scriptStore?.listScopes?.() || {};
    return [
      ['global', ''],
      ...(scopes.character || []).map(id => ['character', id]),
      ...(scopes.preset || []).map(id => ['preset', id]),
    ].flatMap(([scope, scopeId]) => (scriptStore?.getScripts?.(scope, scopeId) || []).map(script => ({ scope, scopeId, script })));
  };
  const readScript = (scope, scopeId, id) => (scriptStore.getScripts(scope, scopeId) || []).find(script => trim(script.id) === id) || null;
  const scopeHasName = (scope, scopeId, name, exceptId = '') => (scriptStore.getScripts(scope, scopeId) || [])
    .some(script => trim(script.id) !== exceptId && nameKey(script.name) === nameKey(name));

  // 按 id 精确命中，否则按名称（忽略空白与大小写）；同名或同 id 在多个范围时不猜，回候选；scope 可缩小范围
  const resolveScript = (query = '', scope = '') => {
    const text = trim(query);
    if (!text) return { error: 'missing_target' };
    const pool = collectScripts().filter(entry => !scope || entry.scope === scope);
    const byId = pool.filter(entry => trim(entry.script.id) === text);
    const matches = byId.length ? byId : pool.filter(entry => nameKey(entry.script.name || entry.script.id) === nameKey(text));
    if (matches.length === 1) return { entry: matches[0] };
    if (matches.length > 1) {
      return {
        error: 'ambiguous_target',
        candidates: matches.slice(0, 8).map(({ scope: s, scopeId, script }) => ({ id: trim(script.id), name: trim(script.name), scope: s, scopeLabel: scopeLabelOf(s, scopeId) })),
      };
    }
    return { error: 'not_found' };
  };

  /* ───────────── 读代码 ───────────── */

  const readCode = async (args = {}) => {
    if (!await ready(scriptStore)) return { ok: false, reason: 'script_store_unavailable' };
    const found = resolveScript(args.script, trim(args.scope));
    if (found.error) return { ok: false, reason: found.error, script: trim(args.script), ...(found.candidates ? { candidates: found.candidates } : {}) };
    const { scope, scopeId, script } = found.entry;
    const content = String(script.content || '');
    const offset = Math.min(Math.max(0, Math.trunc(Number(args.offset) || 0)), content.length);
    const end = Math.min(content.length, offset + READ_CHUNK);
    const blocked = script.compatibility?.blocked === true;
    return {
      ok: true,
      id: trim(script.id),
      name: trim(script.name) || trim(script.id),
      scope,
      scopeId,
      scopeLabel: scopeLabelOf(scope, scopeId),
      enabled: script.enabled === true,
      blocked,
      ...(blocked ? { blockReason: blockReasonOf(script.compatibility) } : {}),
      ...(trim(script.info) ? { info: clip(script.info, 2000) } : {}),
      length: content.length,
      offset,
      content: content.slice(offset, end),
      nextOffset: end < content.length ? end : null,
    };
  };

  /* ───────────── 新建与修改 ───────────── */

  const resolveCreateScope = (scope) => {
    if (scope === 'global') return { scopeId: '' };
    if (scope === 'character') {
      const scopeId = trim(getCurrentPersonaId?.());
      return scopeId ? { scopeId } : { error: 'no_current_character' };
    }
    const scopeId = trim(presetStore?.getActiveId?.('openai'));
    return scopeId ? { scopeId } : { error: 'no_active_preset' };
  };

  const planCreate = (raw, index, claimed) => {
    const name = trim(raw.name);
    const base = { index, action: 'create', name: name || t('脚本 {index}', { index: index + 1 }) };
    if (raw.edits !== undefined) return { ...base, status: 'failed', reason: 'edits_need_existing_script' };
    if (!name) return { ...base, status: 'failed', reason: 'missing_name' };
    if (!SCRIPT_SCOPES.includes(raw.scope)) return { ...base, status: 'failed', reason: 'missing_scope' };
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (!content.trim()) return { ...base, status: 'failed', reason: 'missing_content' };
    const scoped = resolveCreateScope(raw.scope);
    if (scoped.error) return { ...base, scope: raw.scope, status: 'failed', reason: scoped.error };
    const scopeLabel = scopeLabelOf(raw.scope, scoped.scopeId);
    const claimKey = `${raw.scope}:${scoped.scopeId}:${nameKey(name)}`;
    if (claimed.has(claimKey) || scopeHasName(raw.scope, scoped.scopeId, name)) {
      return { ...base, scope: raw.scope, scopeId: scoped.scopeId, scopeLabel, status: 'failed', reason: 'name_exists' };
    }
    claimed.add(claimKey);
    const compatibility = analyzeScriptCompatibility(content);
    return {
      ...base, status: 'planned', scope: raw.scope, scopeId: scoped.scopeId, scopeLabel,
      content, info: typeof raw.info === 'string' ? raw.info : '',
      blocked: compatibility.blocked === true, blockReason: blockReasonOf(compatibility),
    };
  };

  const planUpdate = (raw, index, claimed, touched) => {
    const found = resolveScript(raw.script, trim(raw.scope));
    const base = { index, action: 'update', target: trim(raw.script), name: trim(raw.script) };
    if (found.error) {
      return { ...base, status: found.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) };
    }
    const { scope, scopeId, script } = found.entry;
    const id = trim(script.id);
    const currentName = trim(script.name) || id;
    const located = { ...base, id, name: currentName, scope, scopeId, scopeLabel: scopeLabelOf(scope, scopeId) };
    const key = `${scope}:${scopeId}:${id}`;
    if (touched.has(key)) return { ...located, status: 'failed', reason: 'duplicate_target' };
    touched.add(key);
    if (raw.content !== undefined && raw.edits !== undefined) return { ...located, status: 'failed', reason: 'content_and_edits' };
    const beforeContent = String(script.content || '');
    let nextContent = beforeContent;
    let editCount = 0;
    if (typeof raw.content === 'string') nextContent = raw.content;
    else if (Array.isArray(raw.edits)) {
      const edited = applyScriptEdits(beforeContent, raw.edits);
      if (edited.error) return { ...located, status: 'failed', reason: edited.error, editIndex: edited.editIndex };
      nextContent = edited.content;
      editCount = raw.edits.length;
    }
    if (raw.name !== undefined && !trim(raw.name)) return { ...located, status: 'failed', reason: 'missing_name' };
    const nextName = raw.name !== undefined ? trim(raw.name) : currentName;
    const beforeInfo = String(script.info ?? '');
    const nextInfo = typeof raw.info === 'string' ? raw.info : beforeInfo;
    const nameChanged = nextName !== currentName;
    const contentChanged = nextContent !== beforeContent;
    const infoChanged = nextInfo !== beforeInfo;
    if (nameChanged && nameKey(nextName) !== nameKey(currentName)) {
      const claimKey = `${scope}:${scopeId}:${nameKey(nextName)}`;
      if (claimed.has(claimKey) || scopeHasName(scope, scopeId, nextName, id)) return { ...located, status: 'failed', reason: 'name_exists', nextName };
      claimed.add(claimKey);
    }
    if (!nameChanged && !contentChanged && !infoChanged) return { ...located, status: 'skipped', reason: 'no_change' };
    const compatibility = contentChanged ? analyzeScriptCompatibility(nextContent) : (script.compatibility || {});
    return {
      ...located,
      status: 'planned',
      fingerprint: scriptFingerprint(script),
      patch: { ...(nameChanged ? { name: nextName } : {}), ...(infoChanged ? { info: nextInfo } : {}), ...(contentChanged ? { content: nextContent } : {}) },
      nextName, nextInfo, nextContent,
      nameChanged, infoChanged, contentChanged, editCount,
      beforeLength: beforeContent.length,
      afterLength: nextContent.length,
      enabled: script.enabled === true,
      blocked: compatibility.blocked === true,
      blockReason: blockReasonOf(compatibility),
    };
  };

  const captureUpsert = async (args = {}) => {
    if (!await ready(scriptStore)) return { error: { ok: false, reason: 'script_store_unavailable' } };
    const rawItems = Array.isArray(args.items) ? args.items : [];
    if (rawItems.length > MAX_UPSERT_ITEMS) return { error: { ok: false, reason: 'too_many_items', maxItems: MAX_UPSERT_ITEMS } };
    // 同一批里新建与改名占用的名称、修改过的脚本：避免一批内互相撞名或重复修改同一个脚本
    const claimed = new Set();
    const touched = new Set();
    const items = rawItems.map((raw, index) => (trim(raw?.script) ? planUpdate(raw, index, claimed, touched) : planCreate(raw || {}, index, claimed)));
    const planned = items.filter(item => item.status === 'planned');
    return {
      items,
      plannedCount: planned.length,
      // 改到已启用脚本的代码：新代码在脚本重新载入后就会运行
      runsNewCode: planned.some(item => item.action === 'update' && item.enabled && item.contentChanged && !item.blocked),
    };
  };

  const upsertItemMeta = (item) => {
    if (item.status !== 'planned') return '';
    if (item.action === 'create') {
      return [t('新建'), item.scopeLabel, t('{count} 字（建立后保持关闭）', { count: item.content.length })].join(' · ')
        + (item.blocked ? `；${t('新代码会被兼容性检查拦截，之后无法启用')}` : '');
    }
    const changes = [
      item.nameChanged ? t('名称 {before} ⇒ {after}', { before: item.name, after: item.nextName }) : '',
      item.contentChanged
        ? (item.editCount
          ? t('代码 {before} ⇒ {after} 字（{count} 处替换）', { before: item.beforeLength, after: item.afterLength, count: item.editCount })
          : t('代码 {before} ⇒ {after} 字', { before: item.beforeLength, after: item.afterLength }))
        : '',
      item.infoChanged ? t('说明已修改') : '',
    ].filter(Boolean);
    const notes = item.contentChanged ? [
      item.enabled && !item.blocked ? t('已启用，新代码在脚本重新载入后就会运行') : '',
      item.enabled && item.blocked ? t('新代码会被兼容性检查拦截，写入后这个脚本会被关掉') : '',
      !item.enabled && item.blocked ? t('新代码会被兼容性检查拦截，之后无法启用') : '',
    ].filter(Boolean) : [];
    return [t('修改'), item.scopeLabel, changes.join('、')].join(' · ') + notes.map(note => `；${note}`).join('');
  };

  const writeCreate = async (item, base) => {
    // 确认期间同范围出现同名脚本：不再新建
    if (scopeHasName(item.scope, item.scopeId, item.name)) return { ...base, status: 'failed', reason: 'name_exists' };
    const id = trim(await scriptStore.upsertScript(item.scope, item.scopeId, {
      name: item.name, content: item.content, info: item.info, enabled: false,
    }, { source: 'maid', authorized: false }));
    const after = id ? readScript(item.scope, item.scopeId, id) : null;
    const ok = Boolean(after) && after.content === item.content && trim(after.name) === item.name
      && after.enabled !== true && after.authorized !== true;
    return {
      ...base, id, status: ok ? 'succeeded' : 'failed', enabled: false,
      ...(item.blocked ? { blocked: true, blockReason: item.blockReason } : {}),
      ...(ok ? {} : { reason: 'verification_failed' }),
    };
  };

  const writeUpdate = async (item, base) => {
    const current = readScript(item.scope, item.scopeId, item.id);
    if (!current) return { ...base, status: 'failed', reason: 'target_removed_during_confirmation' };
    if (scriptFingerprint(current) !== item.fingerprint) return { ...base, status: 'failed', reason: 'target_changed_during_confirmation' };
    const changed = await scriptStore.updateScript(item.scope, item.scopeId, item.id, item.patch);
    const after = readScript(item.scope, item.scopeId, item.id);
    // 被兼容性检查拦截的新代码会让脚本关闭（存储的正规化），读回时按这个预期核对
    const expectEnabled = item.enabled && !item.blocked;
    const ok = changed !== false && Boolean(after)
      && String(after.content ?? '') === item.nextContent
      && trim(after.name) === item.nextName
      && String(after.info ?? '') === item.nextInfo
      && (after.enabled === true) === expectEnabled;
    return {
      ...base, name: item.nextName, status: ok ? 'succeeded' : 'failed', enabled: after?.enabled === true,
      ...(item.contentChanged && item.blocked ? { blocked: true, blockReason: item.blockReason, ...(item.enabled ? { disabledByCompatibility: true } : {}) } : {}),
      ...(ok ? {} : { reason: 'verification_failed' }),
    };
  };

  const upsertTool = {
    name: 'script.upsert',
    title: 'Create or edit scripts',
    description: 'Create new TavernHelper-style scripts or edit existing ones, up to 10 items with one confirmation. A new script item has name, scope (global; character = the current character card; preset = the current chat-completion preset) and content, optional info; it fails when that scope already has a script with the same name. New scripts are saved disabled; enable them with script.toggle_many. An edit item has script (id or exact name from script.list; scope narrows a name used in several scopes), optional name and info, and for code either content (replaces the whole code) or edits [{find, replace}]: each find is copied from the current code (script.read) and must occur exactly once, otherwise the item is not written at all. Editing an enabled script\'s code runs the new code once scripts reload. Code blocked by the compatibility check keeps a new script disabled and turns an enabled script off.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['items'], additionalProperties: false,
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: MAX_UPSERT_ITEMS,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              script: { type: 'string', minLength: 1, maxLength: 200 },
              scope: { type: 'string', enum: SCRIPT_SCOPES },
              name: { type: 'string', maxLength: 200 },
              info: { type: 'string', maxLength: 4000 },
              content: { type: 'string', maxLength: 200000 },
              edits: {
                type: 'array', minItems: 1, maxItems: 30,
                items: {
                  type: 'object', required: ['find', 'replace'], additionalProperties: false,
                  properties: { find: { type: 'string', minLength: 1, maxLength: 50000 }, replace: { type: 'string', maxLength: 50000 } },
                },
              },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_scripts', destructive: 'conditional',
      preflight: async (args) => {
        const snap = await captureUpsert(args);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        const settings = settingsNow();
        return confirmRequest({
          kind: 'script.upsert', operationType: 'write_scripts', danger: snap.runsNewCode,
          title: t('写入脚本'),
          message: [
            snap.items.some(item => item.status === 'planned' && item.action === 'create')
              ? t('将新建或修改 {count} 个脚本；新建的脚本保持关闭，启用要另外确认。', { count: snap.plannedCount })
              : t('将修改 {count} 个脚本。', { count: snap.plannedCount }),
            ...(snap.runsNewCode ? [
              t('其中有已启用的脚本，改动的代码在脚本重新载入后就会运行，可能使用以下权限：'),
              ...buildScriptPermissionLines(settings).map(line => `· ${line}`),
              ...(settings.scriptEnabled === true ? [] : [t('全局脚本开关目前关闭，要等开关打开才会运行。')]),
            ] : []),
          ].join('\n'),
          confirmText: t('写入'),
          items: snap.items.map(item => ({
            id: item.id || `new_${item.index}`,
            label: item.name,
            status: item.status,
            reason: item.reason,
            meta: upsertItemMeta(item),
          })),
          denyReason: 'script_upsert_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureUpsert(args);
      if (snap.error) return snap.error;
      if (snap.plannedCount && !isAllowed(context, 'script.upsert')) return { ok: false, reason: 'confirmation_required' };
      const results = [];
      for (const item of snap.items) {
        const base = {
          index: item.index, action: item.action, name: item.name,
          ...(item.id ? { id: item.id } : {}),
          ...(item.scope ? { scope: item.scope, scopeId: item.scopeId, scopeLabel: item.scopeLabel } : {}),
        };
        if (item.status !== 'planned') {
          results.push({
            ...base, status: item.status, reason: item.reason,
            ...(item.candidates ? { candidates: item.candidates } : {}),
            ...(item.editIndex !== undefined ? { editIndex: item.editIndex } : {}),
          });
          continue;
        }
        if (context.signal?.aborted) { results.push(cancelledItem(base)); continue; }
        try {
          results.push(item.action === 'create' ? await writeCreate(item, base) : await writeUpdate(item, base));
        } catch (error) {
          results.push(context.signal?.aborted
            ? cancelledItem(base, { errorMessage: clip(error?.message) })
            : { ...base, status: 'failed', reason: 'write_failed', errorMessage: clip(error?.message) });
        }
      }
      if (results.some(item => item.status === 'succeeded')) notify();
      return batchResult('script.upsert', results, { requestedCount: snap.items.length });
    },
    summarizeResult: summarizeBatch('script write'),
  };

  /* ───────────── 脚本设定 ───────────── */

  const captureSettings = (args = {}) => {
    if (typeof updateScriptSettings !== 'function') return { error: { ok: false, reason: 'settings_unavailable' } };
    const before = settingsNow();
    const changes = SETTING_FIELDS
      .filter(field => typeof args[field.arg] === 'boolean' && field.read(before) !== args[field.arg])
      .map(field => ({ ...field, before: field.read(before), after: args[field.arg] }));
    const next = { ...before, ...Object.fromEntries(changes.map(change => [change.key, change.after])) };
    return { changes, next, turnsOn: changes.some(change => change.after === true) };
  };
  const showSetting = (field, value) => (field.master ? (value ? t('开启') : t('关闭')) : (value ? t('允许') : t('禁用')));

  const settingsTool = {
    name: 'script.settings.update',
    title: 'Change script settings',
    description: 'Change the app-wide script settings with one confirmation: scriptsEnabled (the global script switch; enabled scripts only run while it is on), allowReadMessages (scripts may read the chat history), allowModifyVariables (scripts may change variables), allowNetwork (scripts may access the network). Pass only the settings to change; read the current values with script.list (scriptsRunGlobally and permissions). A conversation can also override the script switch for itself in its contact settings.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_toggle', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(SETTING_FIELDS.map(field => [field.arg, { type: 'boolean' }])),
    },
    safety: {
      operationType: 'write_script_settings', destructive: 'conditional',
      preflight: async (args) => {
        const snap = captureSettings(args);
        snapshots.set(args, snap);
        if (snap.error || !snap.changes.length) return { destructive: false };
        return confirmRequest({
          kind: 'script.settings.update', operationType: 'write_script_settings', danger: snap.turnsOn,
          title: t('修改脚本设定'),
          message: [
            t('将修改 {count} 项脚本设定。', { count: snap.changes.length }),
            ...(snap.turnsOn ? [
              t('改完后脚本的权限：'),
              ...buildScriptPermissionLines(snap.next).map(line => `· ${line}`),
              snap.next.scriptEnabled === true ? t('全局脚本开关开启时，已启用的脚本会立即运行。') : t('全局脚本开关关闭，脚本要等开关打开才会运行。'),
            ] : []),
          ].join('\n'),
          confirmText: t('保存'),
          items: snap.changes.map(change => ({
            id: change.arg, label: t(change.label), status: 'planned',
            meta: `${showSetting(change, change.before)} ⇒ ${showSetting(change, change.after)}`,
          })),
          denyReason: 'script_settings_update_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || captureSettings(args);
      if (snap.error) return snap.error;
      if (!snap.changes.length) return { ok: true, skipped: true, reason: 'no_change', ...settingsSummary(settingsNow()) };
      if (!isAllowed(context, 'script.settings.update')) return { ok: false, reason: 'confirmation_required' };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted' };
      const now = settingsNow();
      if (snap.changes.some(change => change.read(now) !== change.before)) return { ok: false, reason: 'target_changed_during_confirmation' };
      await updateScriptSettings(Object.fromEntries(snap.changes.map(change => [change.key, change.after])));
      const after = settingsNow();
      const failed = snap.changes.filter(change => change.read(after) !== change.after).map(change => change.arg);
      return failed.length
        ? { ok: false, reason: 'verification_failed', failed, ...settingsSummary(after) }
        : {
          ok: true, applied: true,
          changed: snap.changes.map(change => ({ setting: change.arg, before: change.before, after: change.after })),
          ...settingsSummary(after),
        };
    },
    summarizeResult: result => (result?.skipped ? 'script settings unchanged'
      : result?.ok ? `script settings updated; ${(result.changed || []).length} changed` : `script settings update failed: ${trim(result?.reason)}`),
  };

  return [
    {
      name: 'script.read',
      title: 'Read script code',
      description: 'Read the full code of one TavernHelper-style script (global, character-card or preset scope). script is the id or exact name from script.list; scope narrows a name used in several scopes. Returns name, scope, enabled state, compatibility block and its reason, total length, and up to 20000 characters of content starting at offset; nextOffset is set while more code follows.',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: {
        type: 'object', required: ['script'], additionalProperties: false,
        properties: {
          script: { type: 'string', minLength: 1, maxLength: 200 },
          scope: { type: 'string', enum: SCRIPT_SCOPES },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      execute: readCode,
      summarizeResult: result => (result?.ok
        ? `read script ${trim(result.name)}: ${Number(result.content?.length || 0)} of ${Number(result.length || 0)} chars from ${Number(result.offset || 0)}`
        : `script read failed: ${trim(result?.reason)}`),
    },
    upsertTool,
    settingsTool,
  ];
};

export const registerScriptEditAgentTools = (registry, deps = {}) => {
  if (!registry?.registerMany) return [];
  return registry.registerMany(createScriptEditAgentTools(deps));
};
