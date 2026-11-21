import { t } from '../../i18n/index.js';
import { detachRegexPresetBind } from '../../ui/regex-preset-binding-utils.js';
import { PRESET_TYPES, batchResult, confirmRequest, resolveNamedTarget, summarizeBatch } from './preset-regex-script-tools.js';

/* 女仆编辑预设：读对话预设的条目与生成参数、改条目内容／新增／排序、改生成参数、复制、改名。
   写入都经 presetStore.upsert（与预设面板保存同一条路），做法同其他写入工具：
   冻结目标 → 一次结构化确认 → 执行前复验（预设在确认期间被改动就不写）→ 读回核对。
   复制照面板的「新建」：整份复制预设、换名字，不切换、不带绑定的脚本与正则。 */

const trim = value => String(value ?? '').trim();
const nameKey = value => trim(value).toLowerCase().replace(/\s+/g, '');
const clone = value => JSON.parse(JSON.stringify(value));
const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const PROMPT_ORDER_CHARACTER_ID = 100001;
const ROLES = Object.freeze(['system', 'user', 'assistant']);
const REASONING_EFFORTS = Object.freeze(['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// 与预设面板的「生成参数」同一组栏位与预设值
export const PRESET_PARAM_FIELDS = Object.freeze({
  temperature: { type: 'number', minimum: 0, maximum: 2, fallback: 1 },
  top_p: { type: 'number', minimum: 0, maximum: 1, fallback: 0.98 },
  top_k: { type: 'integer', minimum: 0, maximum: 500, fallback: 64 },
  presence_penalty: { type: 'number', minimum: -2, maximum: 2, fallback: 0 },
  frequency_penalty: { type: 'number', minimum: -2, maximum: 2, fallback: 0 },
  openai_max_tokens: { type: 'integer', minimum: 1, maximum: 1000000, fallback: 8192 },
  openai_max_context: { type: 'integer', minimum: 512, maximum: 10000000, fallback: 131072 },
  request_reasoning: { type: 'boolean', fallback: true },
  reasoning_effort: { type: 'string', enum: REASONING_EFFORTS, fallback: 'high' },
  stream_openai: { type: 'boolean', fallback: true },
});
const PARAM_KEYS = Object.keys(PRESET_PARAM_FIELDS);
const paramValue = (preset, key) => preset?.[key] ?? PRESET_PARAM_FIELDS[key].fallback;
const showValue = value => (typeof value === 'boolean' ? (value ? t('开启') : t('关闭')) : String(value));
const isAllowed = (context = {}, kind = '') => context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind;

const orderBlock = (preset) => {
  if (!Array.isArray(preset.prompt_order) || !preset.prompt_order.length) preset.prompt_order = [{ character_id: PROMPT_ORDER_CHARACTER_ID, order: [] }];
  const block = preset.prompt_order.find(item => Number(item?.character_id) === PROMPT_ORDER_CHARACTER_ID) || preset.prompt_order[0];
  if (!Array.isArray(block.order)) block.order = [];
  return block;
};
const listEntries = (preset = {}) => {
  const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
  const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
  const block = orders.find(item => Number(item?.character_id) === PROMPT_ORDER_CHARACTER_ID) || orders[0];
  return (Array.isArray(block?.order) ? block.order : []).map(row => {
    const identifier = trim(row?.identifier);
    const prompt = prompts.find(item => trim(item?.identifier) === identifier) || {};
    return { identifier, name: trim(prompt.name) || identifier, enabled: row?.enabled !== false, prompt };
  }).filter(entry => entry.identifier);
};
const entryFingerprint = preset => JSON.stringify({ prompts: preset?.prompts || [], order: listEntries(preset).map(entry => [entry.identifier, entry.enabled]) });
const paramFingerprint = preset => JSON.stringify(PARAM_KEYS.map(key => preset?.[key]));
const newIdentifier = taken => {
  let id;
  do id = `maid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; while (taken.has(id));
  return id;
};

export const createPresetEditAgentTools = ({
  presetStore = null,
  regexStore = null,
  scriptStore = null,
  getCurrentSessionId = () => '',
  getUiMode = () => '',
  onPresetsChanged = null,
  // 当前会话所用连线会忽略的生成参数（推理模式停用的取样参数、连线档排除的参数）
  getIgnoredParams = () => [],
} = {}) => {
  const snapshots = new WeakMap();
  const ready = async store => { try { await store?.ready; } catch {} return store; };
  const notify = () => { try { onPresetsChanged?.(); } catch {} };
  // 与预设工具相同：有摘要接口就不整份复制整类预设
  const summaries = type => (typeof presetStore?.listSummaries === 'function' ? presetStore.listSummaries(type) : presetStore?.list?.(type)) || [];
  const presetById = (type, id) => {
    if (!id) return null;
    if (typeof presetStore?.getPreset === 'function') return presetStore.getPreset(type, id) || null;
    return (presetStore?.list?.(type) || []).find(item => item.id === id) || null;
  };
  const presetContext = context => ({ sessionId: trim(context?.sessionId || getCurrentSessionId?.()), uiMode: trim(context?.uiMode || getUiMode?.()) });
  const inUseId = context => trim(presetStore?.getResolvedActiveId?.('openai', presetContext(context))?.presetId);

  // 指定 preset 时按 id 或准确名称；没指定就用当前会话在用的对话预设
  const resolveOpenAi = (query, context) => {
    if (trim(query)) {
      const found = resolveNamedTarget(summaries('openai'), query);
      if (found.error) return { error: { ok: false, reason: found.error, preset: trim(query), ...(found.candidates ? { candidates: found.candidates } : {}) } };
      return { preset: presetById('openai', found.item.id) };
    }
    const preset = presetById('openai', inUseId(context));
    return preset ? { preset } : { error: { ok: false, reason: 'no_active_openai_preset' } };
  };
  const resolveAny = (type, query) => {
    const found = resolveNamedTarget(summaries(type), query);
    if (found.error) return { error: { ok: false, reason: found.error, type, preset: trim(query), ...(found.candidates ? { candidates: found.candidates } : {}) } };
    return { preset: presetById(type, found.item.id) };
  };
  const nameTaken = (type, name, exceptId = '') => summaries(type).some(item => item.id !== exceptId && nameKey(item.name || item.id) === nameKey(name));

  /* ───────────── preset.read ───────────── */

  const readPreset = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { ok: false, reason: 'preset_store_unavailable' };
    const target = resolveOpenAi(args.preset, context);
    if (target.error) return target.error;
    const preset = target.preset;
    const entries = listEntries(preset);
    const base = { ok: true, presetId: preset.id, name: trim(preset.name) || preset.id, inUse: preset.id === inUseId(context) };
    if (trim(args.entry)) {
      const found = resolveNamedTarget(entries, args.entry, { idOf: entry => entry.identifier });
      if (found.error) return { ok: false, reason: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) };
      const { prompt, ...entry } = found.item;
      const max = Math.min(Math.max(Number(args.maxContentLength) || 8000, 200), 20000);
      return {
        ...base,
        entry: {
          ...entry, role: prompt.role || 'system', marker: prompt.marker === true,
          ...(Number(prompt.injection_position) === 1 ? { injection: { position: 'absolute', depth: Number(prompt.injection_depth) || 0 } } : {}),
          length: String(prompt.content || '').length, content: clip(prompt.content, max),
        },
      };
    }
    const ordered = new Set(entries.map(entry => entry.identifier));
    return {
      ...base,
      params: Object.fromEntries(PARAM_KEYS.map(key => [key, paramValue(preset, key)])),
      ignoredByConnection: (getIgnoredParams(preset) || []).filter(key => PARAM_KEYS.includes(key)),
      entries: entries.slice(0, 200).map(({ prompt, ...entry }, index) => ({
        index: index + 1, ...entry, role: prompt.role || 'system',
        ...(prompt.marker === true ? { marker: true } : {}),
        ...(Number(prompt.injection_position) === 1 ? { injection: { position: 'absolute', depth: Number(prompt.injection_depth) || 0 } } : {}),
        length: String(prompt.content || '').length,
        ...(prompt.marker === true ? {} : { preview: clip(String(prompt.content || '').replace(/\s+/g, ' '), 120) }),
      })),
      ...(entries.length > 200 ? { truncated: entries.length - 200 } : {}),
      notInOrder: (preset.prompts || []).filter(item => !ordered.has(trim(item?.identifier))).length,
    };
  };

  /* ───────────── preset.prompt_entries.upsert ───────────── */

  const captureEntryUpsert = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const target = resolveOpenAi(args.preset, context);
    if (target.error) return { error: target.error };
    const { id, ...data } = clone(target.preset);
    data.prompts = Array.isArray(data.prompts) ? data.prompts : [];
    const block = orderBlock(data);
    const taken = new Set(data.prompts.map(item => trim(item?.identifier)));
    const roleLabel = role => ({ system: t('系统'), user: t('用户'), assistant: 'AI' })[role] || role;
    const describe = prompt => [roleLabel(prompt.role || 'system'), t('{count} 字', { count: String(prompt.content || '').length })].join(' · ');
    const items = (Array.isArray(args.entries) ? args.entries : []).map((raw = {}, index) => {
      const label = trim(raw.name) || trim(raw.entry);
      const fail = (reason, extra = {}) => ({ index, label, status: 'failed', reason, ...extra });
      if (Boolean(trim(raw.entry)) === Boolean(raw.create)) return fail('entry_or_create_required');
      if ([raw.before, raw.after, raw.index].filter(value => value !== undefined).length > 1) return fail('one_position_only');
      const working = listEntries(data);
      let prompt;
      let row;
      let before = '';
      // 先解析目标与参照位置，都成立才动草稿：失败的项目不能留下半套改动
      if (raw.create) {
        if (!trim(raw.name) || typeof raw.content !== 'string') return fail('name_and_content_required');
      } else {
        const found = resolveNamedTarget(working, raw.entry, { idOf: entry => entry.identifier });
        if (found.error) return { index, label, status: found.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) };
        prompt = data.prompts.find(item => trim(item?.identifier) === found.item.identifier);
        row = block.order.find(item => trim(item?.identifier) === found.item.identifier);
        if (!prompt || !row) return fail('not_found');
        if (prompt.marker === true && ['name', 'content', 'role'].some(key => raw[key] !== undefined)) {
          return { index, label: found.item.name, identifier: found.item.identifier, status: 'protected', reason: 'marker_entry' };
        }
        before = describe(prompt);
      }
      let anchorId = '';
      if (raw.before !== undefined || raw.after !== undefined) {
        const anchor = resolveNamedTarget(working, raw.before ?? raw.after, { idOf: entry => entry.identifier });
        if (anchor.error) return fail(`anchor_${anchor.error}`, anchor.candidates ? { candidates: anchor.candidates } : {});
        if (row && anchor.item.identifier === trim(row.identifier)) return fail('anchor_is_self');
        anchorId = anchor.item.identifier;
      }
      if (raw.create) {
        const identifier = newIdentifier(taken);
        taken.add(identifier);
        prompt = { identifier, name: trim(raw.name), role: raw.role || 'system', system_prompt: true, marker: false, content: raw.content };
        data.prompts.push(prompt);
        row = { identifier, enabled: raw.enabled !== false };
        // 没给位置照面板的习惯放在最前面
        block.order.unshift(row);
      }
      const beforeIndex = block.order.indexOf(row);
      const beforeState = JSON.stringify([prompt.name, prompt.content, prompt.role, row.enabled]);
      if (!raw.create) {
        if (raw.name !== undefined) prompt.name = trim(raw.name) || prompt.name;
        if (raw.content !== undefined) prompt.content = raw.content;
        if (raw.role !== undefined) prompt.role = raw.role;
        if (raw.enabled !== undefined) row.enabled = raw.enabled;
      }
      if (anchorId || raw.index !== undefined) {
        block.order.splice(block.order.indexOf(row), 1);
        const at = anchorId
          ? block.order.findIndex(item => trim(item?.identifier) === anchorId) + (raw.after !== undefined ? 1 : 0)
          : Math.min(Math.max(Math.trunc(raw.index) - 1, 0), block.order.length);
        block.order.splice(at, 0, row);
      }
      const afterIndex = block.order.indexOf(row);
      const moved = !raw.create && afterIndex !== beforeIndex;
      if (!raw.create && !moved && JSON.stringify([prompt.name, prompt.content, prompt.role, row.enabled]) === beforeState) {
        return { index, label: prompt.name, identifier: prompt.identifier, status: 'skipped', reason: 'no_change' };
      }
      const parts = [];
      if (!raw.create) {
        if (raw.content !== undefined) parts.push(t('内容：{before} ⇒ {after}', { before, after: describe(prompt) }));
        if (raw.name !== undefined) parts.push(t('名称 ⇒ {name}', { name: prompt.name }));
        if (raw.role !== undefined) parts.push(t('角色 ⇒ {role}', { role: roleLabel(prompt.role) }));
        if (raw.enabled !== undefined) parts.push(row.enabled ? t('开启') : t('关闭'));
        if (moved) parts.push(t('位置：第 {from} 个 ⇒ 第 {to} 个', { from: beforeIndex + 1, to: afterIndex + 1 }));
      }
      return {
        index, label: prompt.name, identifier: prompt.identifier, status: 'planned', action: raw.create ? 'create' : 'update',
        meta: raw.create ? t('新增（第 {to} 个）：{detail}', { to: afterIndex + 1, detail: describe(prompt) }) : parts.join(' · '),
        expect: { name: prompt.name, content: prompt.content, role: prompt.role || 'system', enabled: row.enabled !== false },
      };
    });
    const plannedCount = items.filter(item => item.status === 'planned').length;
    return {
      presetId: id, presetName: trim(target.preset.name) || id, data, items, plannedCount,
      fingerprint: entryFingerprint(target.preset), expectedOrder: block.order.map(row => trim(row.identifier)),
    };
  };

  const entryUpsertTool = {
    name: 'preset.prompt_entries.upsert',
    title: 'Edit preset prompt entries',
    description: 'Edit the prompt entries (prompt manager items) of a chat-completion (openai) preset in one confirmation: change name, content, role (system/user/assistant) or on/off of an entry (entry = identifier or exact name from preset.read), add a new entry (create:true with name and content; it goes first unless a position is given), or move an entry (before / after another entry, or index = 1-based position). Items run in order. Marker entries such as chat history or world info can only be moved or switched. Defaults to the preset in use for the current session. Read the full text with preset.read entry before rewriting long content.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['entries'], additionalProperties: false,
      properties: {
        preset: { type: 'string', minLength: 1, maxLength: 200 },
        entries: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              entry: { type: 'string', maxLength: 200 },
              create: { type: 'boolean' },
              name: { type: 'string', maxLength: 120 },
              content: { type: 'string', maxLength: 40000 },
              role: { type: 'string', enum: ROLES },
              enabled: { type: 'boolean' },
              before: { type: 'string', maxLength: 200 },
              after: { type: 'string', maxLength: 200 },
              index: { type: 'integer', minimum: 1, maximum: 500 },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_preset_entries', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureEntryUpsert(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'preset.prompt_entries.upsert', operationType: 'write_preset_entries', danger: false,
          title: t('编辑预设条目'),
          message: t('将修改预设「{preset}」的 {count} 个条目。', { preset: snap.presetName, count: snap.plannedCount }),
          confirmText: t('保存'),
          items: snap.items.map(item => ({ id: item.identifier || `entry_${item.index}`, label: item.label, status: item.status, reason: item.reason, meta: item.meta || '' })),
          denyReason: 'preset_entries_upsert_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureEntryUpsert(args, context);
      if (snap.error) return snap.error;
      const extra = { presetId: snap.presetId, presetName: snap.presetName };
      const strip = ({ expect: _expect, meta: _meta, ...item }) => item;
      if (!snap.plannedCount) return batchResult('preset.prompt_entries.upsert', snap.items.map(strip), { extra });
      if (!isAllowed(context, 'preset.prompt_entries.upsert')) return { ok: false, reason: 'confirmation_required', ...extra };
      if (context.signal?.aborted) return batchResult('preset.prompt_entries.upsert', snap.items.map(item => (item.status === 'planned' ? { ...strip(item), status: 'cancelled', reason: 'user_aborted' } : strip(item))), { extra });
      const current = presetById('openai', snap.presetId);
      if (!current) return { ok: false, reason: 'preset_deleted_during_operation', ...extra };
      if (entryFingerprint(current) !== snap.fingerprint) return { ok: false, reason: 'target_changed_during_confirmation', ...extra };
      await presetStore.upsert('openai', { id: snap.presetId, name: snap.data.name, data: snap.data, makeActive: false });
      notify();
      const after = presetById('openai', snap.presetId);
      const entries = listEntries(after);
      const orderOk = JSON.stringify(entries.map(entry => entry.identifier)) === JSON.stringify(snap.expectedOrder);
      const results = snap.items.map(item => {
        if (item.status !== 'planned') return strip(item);
        const entry = entries.find(candidate => candidate.identifier === item.identifier);
        const ok = orderOk && entry && entry.name === item.expect.name && String(entry.prompt.content ?? '') === item.expect.content
          && (entry.prompt.role || 'system') === item.expect.role && entry.enabled === item.expect.enabled;
        return ok ? { ...strip(item), status: 'succeeded' } : { ...strip(item), status: 'failed', reason: 'verification_failed' };
      });
      return batchResult('preset.prompt_entries.upsert', results, { requestedCount: snap.items.length, extra });
    },
    summarizeResult: summarizeBatch('preset entries upsert'),
  };

  /* ───────────── preset.params.update ───────────── */

  const captureParams = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const target = resolveOpenAi(args.preset, context);
    if (target.error) return { error: target.error };
    const { id, ...data } = clone(target.preset);
    const changes = [];
    for (const [key, value] of Object.entries(args.params || {})) {
      if (!PARAM_KEYS.includes(key)) continue;
      const before = paramValue(data, key);
      if (before === value) continue;
      data[key] = value;
      changes.push({ key, before, after: value });
    }
    const ignored = (getIgnoredParams(data) || []).filter(key => changes.some(change => change.key === key));
    return { presetId: id, presetName: trim(target.preset.name) || id, data, changes, ignored, fingerprint: paramFingerprint(target.preset) };
  };

  const paramsSchema = Object.fromEntries(PARAM_KEYS.map(key => {
    const { fallback: _fallback, ...rule } = PRESET_PARAM_FIELDS[key];
    return [key, rule];
  }));

  const paramsUpdateTool = {
    name: 'preset.params.update',
    title: 'Change preset generation parameters',
    description: 'Change the generation parameters of a chat-completion (openai) preset: temperature, top_p, top_k, presence_penalty, frequency_penalty, openai_max_tokens (reply length), openai_max_context (context size), request_reasoning, reasoning_effort, stream_openai. Defaults to the preset in use for the current session; preset.read shows the current values and which ones the current connection ignores.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['params'], additionalProperties: false,
      properties: {
        preset: { type: 'string', minLength: 1, maxLength: 200 },
        params: { type: 'object', additionalProperties: false, minProperties: 1, properties: paramsSchema },
      },
    },
    safety: {
      operationType: 'write_preset_params', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureParams(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.changes.length) return { destructive: false };
        return confirmRequest({
          kind: 'preset.params.update', operationType: 'write_preset_params', danger: false,
          title: t('修改生成参数'),
          message: [
            t('将修改预设「{preset}」的 {count} 个生成参数。', { preset: snap.presetName, count: snap.changes.length }),
            ...(snap.ignored.length ? [t('当前连线会忽略：{params}。', { params: snap.ignored.join('、') })] : []),
          ].join(''),
          confirmText: t('保存'),
          items: snap.changes.map(change => ({ id: change.key, label: change.key, status: 'planned', meta: `${showValue(change.before)} ⇒ ${showValue(change.after)}` })),
          denyReason: 'preset_params_update_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureParams(args, context);
      if (snap.error) return snap.error;
      const head = { presetId: snap.presetId, presetName: snap.presetName };
      if (!snap.changes.length) return { ok: true, skipped: true, reason: 'no_change', ...head };
      if (!isAllowed(context, 'preset.params.update')) return { ok: false, reason: 'confirmation_required', ...head };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted', ...head };
      const current = presetById('openai', snap.presetId);
      if (!current) return { ok: false, reason: 'preset_deleted_during_operation', ...head };
      if (paramFingerprint(current) !== snap.fingerprint) return { ok: false, reason: 'target_changed_during_confirmation', ...head };
      await presetStore.upsert('openai', { id: snap.presetId, name: snap.data.name, data: snap.data, makeActive: false });
      notify();
      const after = presetById('openai', snap.presetId);
      const failed = snap.changes.filter(change => paramValue(after, change.key) !== change.after).map(change => change.key);
      return failed.length
        ? { ok: false, reason: 'verification_failed', failed, ...head }
        : { ok: true, ...head, changes: snap.changes, ...(snap.ignored.length ? { ignoredByConnection: snap.ignored } : {}) };
    },
    summarizeResult: result => (result?.ok
      ? (result.skipped ? 'preset params unchanged' : `preset params updated; ${Number(result.changes?.length || 0)} change(s)`)
      : `preset params update failed: ${trim(result?.reason)}`),
  };

  /* ───────────── preset.copy／preset.rename ───────────── */

  const captureCopy = async (args = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const type = PRESET_TYPES.includes(args.type) ? args.type : 'openai';
    const target = resolveAny(type, args.preset);
    if (target.error) return { error: target.error };
    const name = trim(args.name);
    if (!name) return { error: { ok: false, reason: 'name_required' } };
    if (nameTaken(type, name)) return { error: { ok: false, reason: 'name_taken', name } };
    const source = target.preset;
    await ready(scriptStore); await ready(regexStore);
    const scripts = type === 'openai' ? (scriptStore?.getScripts?.('preset', source.id) || []).length : 0;
    const regexSets = (regexStore?.listLocalSets?.() || []).filter(set => detachRegexPresetBind(set?.bind, { presetType: type, presetId: source.id }).matched).length;
    return { type, sourceId: source.id, sourceName: trim(source.name) || source.id, name, appScope: source.app_scope, scripts, regexSets };
  };

  const copyTool = {
    name: 'preset.copy',
    title: 'Copy a preset',
    description: 'Make a copy of a preset under a new name (like 新建 in the preset panel): the whole preset is duplicated, the copy is not switched to, and scripts or regex sets bound to the original are not copied. type defaults to openai; preset = id or exact name; name must not match another preset of the same type.',
    source: 'maid-app-content', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'delete_copy', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['preset', 'name'], additionalProperties: false,
      properties: {
        type: { type: 'string', enum: PRESET_TYPES },
        preset: { type: 'string', minLength: 1, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
    safety: {
      operationType: 'create_preset', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureCopy(args, context);
        snapshots.set(args, snap);
        if (snap.error) return { destructive: false };
        const left = [snap.scripts ? t('{count} 个脚本', { count: snap.scripts }) : '', snap.regexSets ? t('{count} 组正则', { count: snap.regexSets }) : ''].filter(Boolean).join('、');
        return confirmRequest({
          kind: 'preset.copy', operationType: 'create_preset', danger: false,
          title: t('复制预设'),
          message: [
            t('将把预设「{preset}」复制为「{name}」，不会切换过去。', { preset: snap.sourceName, name: snap.name }),
            ...(left ? [t('原预设绑定的{items}不会一起复制。', { items: left })] : []),
          ].join(''),
          confirmText: t('复制'),
          items: [{ id: snap.sourceId, label: snap.name, status: 'planned', meta: t('复制自「{preset}」', { preset: snap.sourceName }) }],
          denyReason: 'preset_copy_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureCopy(args, context);
      if (snap.error) return snap.error;
      const head = { type: snap.type, sourceId: snap.sourceId, sourceName: snap.sourceName, name: snap.name };
      if (!isAllowed(context, 'preset.copy')) return { ok: false, reason: 'confirmation_required', ...head };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted', ...head };
      const source = presetById(snap.type, snap.sourceId);
      if (!source) return { ok: false, reason: 'preset_deleted_during_operation', ...head };
      if (nameTaken(snap.type, snap.name)) return { ok: false, reason: 'name_taken', ...head };
      const { id: _id, ...data } = clone(source);
      const presetId = await presetStore.upsert(snap.type, { name: snap.name, data: { ...data, name: snap.name }, makeActive: false, appScope: snap.appScope });
      notify();
      const copied = presetById(snap.type, presetId);
      if (!copied || trim(copied.name) !== snap.name) return { ok: false, reason: 'verification_failed', ...head };
      return { ok: true, ...head, presetId, ...(snap.scripts || snap.regexSets ? { notCopied: { scripts: snap.scripts, regexSets: snap.regexSets } } : {}) };
    },
    summarizeResult: result => (result?.ok ? `preset copied: ${trim(result.name)}` : `preset copy failed: ${trim(result?.reason)}`),
  };

  const captureRename = async (args = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const type = PRESET_TYPES.includes(args.type) ? args.type : 'openai';
    const target = resolveAny(type, args.preset);
    if (target.error) return { error: target.error };
    const name = trim(args.name);
    if (!name) return { error: { ok: false, reason: 'name_required' } };
    const preset = target.preset;
    const before = trim(preset.name) || preset.id;
    if (before === name) return { type, presetId: preset.id, before, name, noChange: true };
    if (nameTaken(type, name, preset.id)) return { error: { ok: false, reason: 'name_taken', name } };
    return { type, presetId: preset.id, before, name };
  };

  const renameTool = {
    name: 'preset.rename',
    title: 'Rename a preset',
    description: 'Rename a preset. type defaults to openai; preset = id or exact name; the new name must not match another preset of the same type.',
    source: 'maid-app-content', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'rename_back', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['preset', 'name'], additionalProperties: false,
      properties: {
        type: { type: 'string', enum: PRESET_TYPES },
        preset: { type: 'string', minLength: 1, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
    safety: {
      operationType: 'rename_preset', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureRename(args, context);
        snapshots.set(args, snap);
        if (snap.error || snap.noChange) return { destructive: false };
        return confirmRequest({
          kind: 'preset.rename', operationType: 'rename_preset', danger: false,
          title: t('重命名预设'),
          message: t('将把预设「{before}」改名为「{name}」。', { before: snap.before, name: snap.name }),
          confirmText: t('改名'),
          items: [{ id: snap.presetId, label: snap.name, status: 'planned', meta: `${snap.before} ⇒ ${snap.name}` }],
          denyReason: 'preset_rename_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureRename(args, context);
      if (snap.error) return snap.error;
      const head = { type: snap.type, presetId: snap.presetId, before: snap.before, name: snap.name };
      if (snap.noChange) return { ok: true, skipped: true, reason: 'no_change', ...head };
      if (!isAllowed(context, 'preset.rename')) return { ok: false, reason: 'confirmation_required', ...head };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted', ...head };
      const current = presetById(snap.type, snap.presetId);
      if (!current) return { ok: false, reason: 'preset_deleted_during_operation', ...head };
      if ((trim(current.name) || current.id) !== snap.before) return { ok: false, reason: 'target_changed_during_confirmation', ...head };
      if (nameTaken(snap.type, snap.name, snap.presetId)) return { ok: false, reason: 'name_taken', ...head };
      const { id, ...data } = clone(current);
      await presetStore.upsert(snap.type, { id, name: snap.name, data: { ...data, name: snap.name }, makeActive: false });
      notify();
      return trim(presetById(snap.type, snap.presetId)?.name) === snap.name
        ? { ok: true, ...head }
        : { ok: false, reason: 'verification_failed', ...head };
    },
    summarizeResult: result => (result?.ok ? (result.skipped ? 'preset name unchanged' : `preset renamed: ${trim(result.name)}`) : `preset rename failed: ${trim(result?.reason)}`),
  };

  return [
    {
      name: 'preset.read',
      title: 'Read a preset',
      description: 'Read a chat-completion (openai) preset: its generation parameters (and which ones the current connection ignores) and its prompt entries in order with role, on/off, length and a short preview. entry = identifier or exact name returns that entry\'s full content (maxContentLength, default 8000). Defaults to the preset in use for the current session.',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          preset: { type: 'string', minLength: 1, maxLength: 200 },
          entry: { type: 'string', minLength: 1, maxLength: 200 },
          maxContentLength: { type: 'integer', minimum: 200, maximum: 20000 },
        },
      },
      execute: readPreset,
      summarizeResult: result => (result?.ok
        ? (result.entry ? `read preset entry ${trim(result.entry.name)}` : `read preset ${trim(result.name)}; ${Number(result.entries?.length || 0)} entries`)
        : `preset read failed: ${trim(result?.reason)}`),
    },
    entryUpsertTool,
    paramsUpdateTool,
    copyTool,
    renameTool,
  ];
};

export const registerPresetEditAgentTools = (registry, deps = {}) => registry.registerMany(createPresetEditAgentTools(deps));
