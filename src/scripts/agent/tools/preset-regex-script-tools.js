import { t } from '../../i18n/index.js';
import { detachRegexPresetBind, getRegexPresetBindIds } from '../../ui/regex-preset-binding-utils.js';
import { buildScriptPermissionLines } from '../../ui/script-authorization-utils.js';

/* 女仆管理预设、正则与脚本。沿用世界书工具的做法：
   先解析并冻结目标（preflight 快照）→ 一次结构化确认 → 执行前复验 → 写入后读回核对，
   批量操作逐项报告 succeeded / skipped / protected / failed。
   用户决定（2026-09-23）：切换预设默认只对当前会话生效；可新建/修改正则规则内容；
   启用脚本每次都要确认、不提供“始终允许”，兼容性拦截的脚本不能启用。 */

const trim = value => String(value ?? '').trim();
const nameKey = value => trim(value).toLowerCase().replace(/\s+/g, '');
const clip = (value, max = 120) => {
  const text = trim(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : [values]).map(trim).filter(Boolean))];

export const PRESET_TYPES = Object.freeze(['openai', 'sysprompt', 'context', 'instruct', 'reasoning']);
const PRESET_TYPE_LABELS = Object.freeze({
  openai: '对话预设',
  sysprompt: '系统提示词',
  context: '上下文模板',
  instruct: '指令模板',
  reasoning: '推理模板',
});
const PROMPT_ORDER_CHARACTER_ID = 100001;
const REGEX_LIST_AUTO_COMPACT_RULES = 30;
export const REGEX_PLACEMENTS = Object.freeze({
  user_input: 1,
  ai_output: 2,
  slash_command: 3,
  world_info: 5,
  reasoning: 6,
});
const PLACEMENT_NAMES = Object.freeze(Object.fromEntries(Object.entries(REGEX_PLACEMENTS).map(([name, value]) => [value, name])));
const SCRIPT_SCOPES = Object.freeze(['global', 'character', 'preset']);
const SCRIPT_SCOPE_LABELS = Object.freeze({ global: '全局', character: '角色卡', preset: '预设' });

const isAllowed = (context = {}, kind = '') => (
  context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind
);

// preview:true 只列出将被删除的项目，不执行、不弹确认；女仆据此生成“待确认清单”，用户确认后再按同样参数执行
const deletePreviewResult = (snap, items) => ({
  ok: true,
  preview: true,
  plannedCount: snap.plannedCount,
  ...(snap.sessionId ? { sessionId: snap.sessionId } : {}),
  items,
  message: snap.plannedCount ? `预览：将删除 ${snap.plannedCount} 项，尚未执行。` : '预览：没有可删除的项目。',
});

// 按 id 精确命中，否则按名称（忽略空白与大小写）；重名不猜目标
export const resolveNamedTarget = (items = [], query = '', { idOf = item => item.id, nameOf = item => item.name } = {}) => {
  const text = trim(query);
  if (!text) return { error: 'missing_target' };
  const byId = items.filter(item => trim(idOf(item)) === text);
  if (byId.length === 1) return { item: byId[0] };
  const byName = items.filter(item => nameKey(nameOf(item)) === nameKey(text));
  if (byName.length === 1) return { item: byName[0] };
  if (byName.length > 1) {
    return { error: 'ambiguous_target', candidates: byName.slice(0, 8).map(item => ({ id: trim(idOf(item)), name: trim(nameOf(item)) })) };
  }
  return { error: 'not_found' };
};

// 确认续接只按预览的 id + 容器/作用域找项目，原 id 不存在时绝不再把它当作名称匹配。
const resolveDeleteTargets = (items, queries, context, toolName) => {
  const frozen = context?.maidConfirmedDelete;
  if (frozen?.toolName !== toolName) return uniqueStrings(queries).map(query => ({ query, target: resolveNamedTarget(items, query) }));
  // 不按 id 去重：导入的规则/脚本可能在不同容器复用同一 id，作用域才是完整身份。
  return (frozen.targets || []).map(expected => {
    const query = trim(expected.id);
    const matches = items.filter(item => trim(item.id) === query &&
      ['type', 'containerKey', 'scope', 'scopeId'].every(key => expected[key] === undefined || trim(item[key]) === expected[key]));
    return { query, target: matches.length === 1 ? { item: matches[0] } : { error: matches.length ? 'ambiguous_target' : 'not_found' } };
  });
};

// 编译校验：支持 /pattern/flags 与裸 pattern
export const compileRegexSource = (source = '') => {
  const text = String(source ?? '');
  if (!text.trim()) return { ok: false, reason: 'empty_regex' };
  const match = text.match(/^\/([\s\S]*)\/([a-z]*)$/);
  try {
    // eslint-disable-next-line no-new
    new RegExp(match ? match[1] : text, match ? match[2] : '');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'invalid_regex', message: clip(error?.message, 160) };
  }
};

const batchResult = (toolName, results, { requestedCount, retryArgs = null, extra = {} } = {}) => {
  const succeededCount = results.filter(item => item.status === 'succeeded').length;
  const failed = results.filter(item => item.status === 'failed');
  return {
    ok: failed.length === 0 && results.some(item => item.status === 'succeeded' || item.status === 'skipped'),
    partial: failed.length > 0 && succeededCount > 0,
    requestedCount: requestedCount ?? results.length,
    succeededCount,
    skippedCount: results.filter(item => ['skipped', 'protected', 'missing', 'ambiguous'].includes(item.status)).length,
    failedCount: failed.length,
    results,
    retry: failed.length && retryArgs ? { toolName, args: retryArgs(failed) } : null,
    ...extra,
  };
};

const summarizeBatch = label => result => (result?.reason && !Array.isArray(result?.results)
  ? `${label} failed: ${trim(result.reason)}`
  : `${label} ${result?.ok ? 'completed' : 'incomplete'}; ${Number(result?.succeededCount || 0)} succeeded; ${Number(result?.skippedCount || 0)} skipped; ${Number(result?.failedCount || 0)} failed`);

const confirmRequest = ({
  kind, operationType, title, message, confirmText, danger = true, allowAlways = false, items = [], denyReason, denyResult = {},
}) => ({
  destructive: true,
  kind,
  operationType,
  title,
  message,
  confirmText,
  cancelText: t('取消'),
  danger,
  allowAlways,
  details: { items: items.slice(0, 100) },
  onDeny: { action: 'skip', reason: denyReason, result: { ok: false, skipped: true, reason: denyReason, ...denyResult } },
});

const promptOrderList = (preset = {}) => {
  const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
  const entry = orders.find(item => Number(item?.character_id) === PROMPT_ORDER_CHARACTER_ID) || orders[0] || null;
  return Array.isArray(entry?.order) ? entry.order : [];
};

const promptEntries = (preset = {}) => {
  const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
  return promptOrderList(preset).map(item => {
    const identifier = trim(item?.identifier);
    const prompt = prompts.find(candidate => trim(candidate?.identifier) === identifier);
    return { identifier, name: trim(prompt?.name) || identifier, enabled: item?.enabled !== false };
  }).filter(item => item.identifier);
};

const describeRegexBind = (bind = null, presetName = () => '') => {
  if (!bind) return '未绑定';
  if (bind.type === 'preset') {
    const ids = getRegexPresetBindIds(bind);
    return `绑定预设：${ids.map(id => presetName(bind.presetType, id) || id).join('、')}`;
  }
  if (bind.type === 'world') return `绑定世界书/角色：${trim(bind.worldId)}`;
  return '未绑定';
};

const regexRuleSummary = (rule = {}, { includeRules = false } = {}) => ({
  id: trim(rule.id),
  name: trim(rule.scriptName) || trim(rule.id),
  enabled: rule.disabled !== true,
  placement: (Array.isArray(rule.placement) ? rule.placement : []).map(value => PLACEMENT_NAMES[value] || String(value)),
  ...(rule.markdownOnly ? { displayOnly: true } : {}),
  ...(rule.promptOnly ? { promptOnly: true } : {}),
  ...(includeRules ? { findRegex: clip(rule.findRegex, 400), replaceString: clip(rule.replaceString, 400) } : {}),
});

export const createPresetRegexScriptAgentTools = ({
  presetStore = null,
  regexStore = null,
  scriptStore = null,
  getCurrentSessionId = () => '',
  getUiMode = () => '',
  getCurrentPersonaId = () => '',
  getPersonaName = () => '',
  getScriptSettings = () => ({}),
  isPresetEligibleForMode = () => true,
  onPresetsChanged = null,
  onRegexChanged = null,
  onScriptsChanged = null,
} = {}) => {
  const snapshots = new WeakMap();
  const sessionIdOf = context => trim(context?.sessionId || getCurrentSessionId?.());
  const presetContext = context => ({ sessionId: sessionIdOf(context), uiMode: trim(context?.uiMode || getUiMode?.()) });
  const ready = async store => { try { await store?.ready; } catch {} return store; };
  // 只需 id/名称/适用范围时读摘要（顺序同 list()），避免整份复制整类预设（导入预设单个可达 MB 级）
  const presetSummaries = (type) => {
    const list = typeof presetStore?.listSummaries === 'function' ? presetStore.listSummaries(type) : presetStore?.list?.(type);
    return (Array.isArray(list) ? list : []).slice()
      .sort((a, b) => String(a?.name || a?.id).localeCompare(String(b?.name || b?.id)));
  };
  const presetById = (type, id) => (typeof presetStore?.getPreset === 'function'
    ? presetStore.getPreset(type, id)
    : (presetStore?.list?.(type) || []).find(item => item.id === id)) || null;
  const presetName = (type, id) => trim(presetSummaries(type).find(item => item.id === id)?.name);
  const notify = callback => { try { callback?.(); } catch {} };

  /* ───────────── 预设 ───────────── */

  const listPresets = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { ok: false, reason: 'preset_store_unavailable' };
    const ctx = presetContext(context);
    const types = args.type ? [args.type] : PRESET_TYPES;
    const out = {};
    // 数量与在用项放在最前、每项只保留为真的标记：五类预设全部列出时容易被截断，数量不能跟着丢
    const counts = {};
    for (const type of types) {
      const list = presetSummaries(type);
      counts[type] = list.length;
      const resolved = presetStore.getResolvedActiveId(type, ctx) || {};
      const sessionBound = ctx.sessionId ? presetStore.getSessionBindingId?.(type, ctx.sessionId) : null;
      const globalActive = presetStore.getActiveId(type);
      out[type] = {
        label: PRESET_TYPE_LABELS[type],
        count: list.length,
        enabled: presetStore.getEnabled?.(type) !== false,
        inUse: { presetId: resolved.presetId || '', name: presetName(type, resolved.presetId), source: resolved.source || '' },
        presets: list.slice(0, 100).map(preset => ({
          id: preset.id,
          name: trim(preset.name) || preset.id,
          ...(trim(preset.app_scope) ? { appScope: trim(preset.app_scope) } : {}),
          ...(preset.id === resolved.presetId ? { inUse: true } : {}),
          ...(preset.id === sessionBound ? { sessionBound: true } : {}),
          ...(preset.id === globalActive ? { globalDefault: true } : {}),
        })),
        ...(list.length > 100 ? { truncated: list.length - 100 } : {}),
      };
      if (args.includeEntries === true && type === 'openai' && resolved.presetId) {
        const preset = presetById(type, resolved.presetId);
        out[type].entries = promptEntries(preset).slice(0, 200);
      }
    }
    return { ok: true, sessionId: ctx.sessionId, counts, presets: out };
  };

  const capturePresetSwitch = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const type = trim(args.type || 'openai');
    const scope = args.scope === 'global' ? 'global' : 'session';
    const ctx = presetContext(context);
    if (scope === 'session' && !ctx.sessionId) return { error: { ok: false, reason: 'no_current_session', type, scope } };
    const target = resolveNamedTarget(presetSummaries(type), args.preset);
    if (target.error) return { error: { ok: false, reason: target.error, type, scope, preset: trim(args.preset), candidates: target.candidates } };
    const preset = target.item;
    const resolved = presetStore.getResolvedActiveId(type, ctx) || {};
    if (scope === 'session' && isPresetEligibleForMode(preset, resolved.mode || ctx.uiMode) === false) {
      return { error: { ok: false, reason: 'preset_not_available_in_mode', type, scope, presetId: preset.id, name: preset.name, mode: resolved.mode } };
    }
    const previousId = scope === 'session' ? trim(presetStore.getSessionBindingId?.(type, ctx.sessionId)) : trim(presetStore.getActiveId(type));
    return { type, scope, ctx, presetId: preset.id, name: trim(preset.name) || preset.id, previousId, previousName: presetName(type, previousId) || previousId };
  };

  const presetSwitchTool = {
    name: 'preset.switch',
    title: 'Switch preset',
    description: 'Switch which preset of a type (openai/sysprompt/context/instruct/reasoning) is used. scope "session" (default) binds it to the current chat session only; use scope "global" only when the user explicitly asks to change the global default. Identify the preset by id or exact name from preset.list.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_switch_back', modelContext: 'none', confirmation: 'allow_once' },
    schema: {
      type: 'object', required: ['preset'], additionalProperties: false,
      properties: {
        type: { type: 'string', enum: PRESET_TYPES },
        preset: { type: 'string', minLength: 1, maxLength: 200 },
        scope: { type: 'string', enum: ['session', 'global'] },
      },
    },
    safety: {
      operationType: 'switch_preset', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capturePresetSwitch(args, context);
        snapshots.set(args, snap);
        if (snap.error || snap.previousId === snap.presetId) return { destructive: false };
        return confirmRequest({
          kind: 'preset.switch', operationType: 'switch_preset', danger: false, allowAlways: true,
          title: t('切换预设'),
          message: t(snap.previousName ? '将{scope}的{type}从「{previous}」切换为「{next}」。' : '将{scope}的{type}切换为「{next}」。', {
            scope: snap.scope === 'session' ? t('当前会话') : t('全局默认'),
            type: t(PRESET_TYPE_LABELS[snap.type] || snap.type),
            previous: snap.previousName,
            next: snap.name,
          }),
          confirmText: t('切换'),
          items: [{ id: snap.presetId, label: snap.name, meta: snap.scope === 'session' ? t('仅当前会话') : t('全局默认'), status: 'planned' }],
          denyReason: 'preset_switch_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await capturePresetSwitch(args, context);
      if (snap.error) return snap.error;
      const base = { type: snap.type, scope: snap.scope, presetId: snap.presetId, name: snap.name, previousId: snap.previousId };
      if (snap.previousId === snap.presetId) return { ok: true, changed: false, ...base };
      if (!isAllowed(context, 'preset.switch')) return { ok: false, reason: 'confirmation_required', ...base };
      if (!presetSummaries(snap.type).some(item => item.id === snap.presetId)) return { ok: false, reason: 'preset_deleted_during_operation', ...base };
      if (snap.scope === 'session') await presetStore.setSessionBinding(snap.type, snap.ctx.sessionId, snap.presetId);
      else await presetStore.setActive(snap.type, snap.presetId);
      const verified = snap.scope === 'session'
        ? trim(presetStore.getSessionBindingId?.(snap.type, snap.ctx.sessionId)) === snap.presetId
        : trim(presetStore.getActiveId(snap.type)) === snap.presetId;
      notify(onPresetsChanged);
      const resolved = presetStore.getResolvedActiveId(snap.type, snap.ctx) || {};
      return {
        ok: verified, changed: verified, verified, ...base,
        ...(verified ? {} : { reason: 'verification_failed' }),
        inUseForCurrentSession: { presetId: resolved.presetId || '', source: resolved.source || '' },
        ...(snap.scope === 'global' && resolved.presetId !== snap.presetId ? { note: 'current_session_uses_its_own_binding' } : {}),
      };
    },
    summarizeResult: result => (result?.ok
      ? `preset ${result.changed ? 'switched' : 'already active'}: ${trim(result.name)} (${trim(result.scope)})`
      : `preset switch failed: ${trim(result?.reason)}`),
  };

  const captureEntryToggle = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const ctx = presetContext(context);
    let preset;
    if (trim(args.preset)) {
      const target = resolveNamedTarget(presetSummaries('openai'), args.preset);
      if (target.error) return { error: { ok: false, reason: target.error, preset: trim(args.preset), candidates: target.candidates } };
      preset = presetById('openai', target.item.id);
    } else {
      const resolvedId = presetStore.getResolvedActiveId('openai', ctx)?.presetId;
      preset = resolvedId ? presetById('openai', resolvedId) : null;
      if (!preset) return { error: { ok: false, reason: 'no_active_openai_preset' } };
    }
    const entries = promptEntries(preset);
    const enabled = args.enabled === true;
    const items = uniqueStrings(args.entries).map(query => {
      const target = resolveNamedTarget(entries, query, { idOf: item => item.identifier });
      if (target.error) return { target: query, status: target.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: target.error, candidates: target.candidates };
      const entry = target.item;
      return { target: query, identifier: entry.identifier, name: entry.name, status: entry.enabled === enabled ? 'skipped' : 'planned', reason: entry.enabled === enabled ? 'already_in_state' : '' };
    });
    return { presetId: preset.id, presetName: trim(preset.name) || preset.id, enabled, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const presetEntriesTool = {
    name: 'preset.prompt_entries.toggle',
    title: 'Toggle preset prompt entries',
    description: 'Enable or disable prompt entries (the prompt manager items) of a chat-completion (openai) preset in one batch. Defaults to the preset in use for the current session. Identify entries by identifier or exact name from preset.list includeEntries:true.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_toggle', modelContext: 'none', confirmation: 'allow_once' },
    schema: {
      type: 'object', required: ['entries', 'enabled'], additionalProperties: false,
      properties: {
        preset: { type: 'string', minLength: 1, maxLength: 200 },
        entries: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } },
        enabled: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'toggle_prompt_entries', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureEntryToggle(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'preset.prompt_entries.toggle', operationType: 'toggle_prompt_entries', danger: false, allowAlways: true,
          title: snap.enabled ? t('启用预设条目') : t('停用预设条目'),
          message: t(snap.enabled ? '将在预设「{preset}」中启用 {count} 个条目。' : '将在预设「{preset}」中停用 {count} 个条目。', { preset: snap.presetName, count: snap.plannedCount }),
          confirmText: snap.enabled ? t('启用') : t('停用'),
          items: snap.items.map(item => ({ id: item.identifier || item.target, label: item.name || item.target, status: item.status, reason: item.reason })),
          denyReason: 'prompt_entries_toggle_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureEntryToggle(args, context);
      if (snap.error) return snap.error;
      const pending = snap.items.filter(item => item.status === 'planned');
      if (pending.length && !isAllowed(context, 'preset.prompt_entries.toggle')) return { ok: false, reason: 'confirmation_required', presetId: snap.presetId };
      const current = presetById('openai', snap.presetId);
      if (!current) return { ok: false, reason: 'preset_deleted_during_operation', presetId: snap.presetId };
      if (pending.length) {
        const { id, ...data } = JSON.parse(JSON.stringify(current));
        const order = promptOrderList(data);
        pending.forEach(item => {
          const row = order.find(candidate => trim(candidate?.identifier) === item.identifier);
          if (row) row.enabled = snap.enabled;
        });
        await presetStore.upsert('openai', { id, name: data.name, data, makeActive: false });
        notify(onPresetsChanged);
      }
      const after = promptEntries(presetById('openai', snap.presetId));
      const results = snap.items.map(item => {
        if (item.status !== 'planned') return { target: item.target, identifier: item.identifier, name: item.name, status: item.status, reason: item.reason };
        const row = after.find(entry => entry.identifier === item.identifier);
        return row?.enabled === snap.enabled
          ? { target: item.target, identifier: item.identifier, name: item.name, status: 'succeeded' }
          : { target: item.target, identifier: item.identifier, name: item.name, status: 'failed', reason: 'verification_failed' };
      });
      return batchResult('preset.prompt_entries.toggle', results, {
        requestedCount: snap.items.length,
        retryArgs: failed => ({ preset: snap.presetId, entries: failed.map(item => item.identifier), enabled: snap.enabled }),
        extra: { presetId: snap.presetId, presetName: snap.presetName, enabled: snap.enabled },
      });
    },
    summarizeResult: summarizeBatch('preset prompt entries toggle'),
  };

  const capturePresetDelete = async (args = {}, context = {}) => {
    if (!await ready(presetStore)) return { error: { ok: false, reason: 'preset_store_unavailable' } };
    const type = trim(args.type);
    const includeBound = args.includeBound === true;
    const list = presetSummaries(type);
    const builtinId = trim((presetStore.getSelectionState?.() || presetStore.getState?.())?.builtinActive?.[type]);
    await ready(regexStore);
    const regexSets = regexStore?.listLocalSets?.() || [];
    const seen = new Set();
    const items = resolveDeleteTargets(list, args.presets, context, 'preset.delete_many').map(({ query, target }) => {
      if (target.error) return { target: query, status: target.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: target.error, candidates: target.candidates };
      const preset = target.item;
      if (seen.has(preset.id)) return { target: query, presetId: preset.id, name: preset.name, status: 'skipped', reason: 'duplicate_target' };
      seen.add(preset.id);
      const boundRegexSets = regexSets.filter(set => detachRegexPresetBind(set?.bind, { presetType: type, presetId: preset.id }).matched).map(set => set.id);
      const boundScripts = type === 'openai' ? (scriptStore?.getScripts?.('preset', preset.id) || []).length : 0;
      const item = { target: query, presetId: preset.id, name: trim(preset.name) || preset.id, boundRegexSets, boundScripts, status: 'planned', reason: '' };
      if (preset.id === builtinId) return { ...item, status: 'protected', reason: 'builtin_default_protected' };
      return item;
    });
    const planned = items.filter(item => item.status === 'planned');
    if (planned.length && planned.length >= list.length) {
      planned.at(-1).status = 'protected';
      planned.at(-1).reason = 'last_preset_protected';
    }
    return { type, includeBound, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const presetDeleteTool = {
    name: 'preset.delete_many',
    title: 'Delete multiple presets',
    description: 'Permanently delete explicit presets of one type with one confirmation. Session/mode bindings to them are cleared. By default regex sets and preset scripts bound to them are kept; includeBound:true also removes regex sets bound only to that preset (shared sets are just detached) and the preset\'s scripts. The built-in default and the last remaining preset are protected.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['type', 'presets'], additionalProperties: false,
      properties: {
        type: { type: 'string', enum: PRESET_TYPES },
        presets: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } },
        includeBound: { type: 'boolean' },
        preview: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'delete_presets', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capturePresetDelete(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount || args.preview === true) return { destructive: false };
        return confirmRequest({
          kind: 'preset.delete_many', operationType: 'delete_presets',
          title: t('批量删除预设'),
          message: t(snap.includeBound ? '将永久删除 {count} 个{type}，并一并删除只绑定它们的正则和它们的脚本。' : '将永久删除 {count} 个{type}，绑定的正则和脚本会保留。', {
            count: snap.plannedCount, type: t(PRESET_TYPE_LABELS[snap.type] || snap.type),
          }),
          confirmText: t('确认删除'),
          items: snap.items.map(item => ({
            id: item.presetId || item.target, label: item.name || item.target, status: item.status, reason: item.reason,
            meta: item.presetId ? t('正则 {regex} 组 · 脚本 {scripts} 条', { regex: item.boundRegexSets?.length || 0, scripts: item.boundScripts || 0 }) : '',
          })),
          denyReason: 'preset_batch_delete_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await capturePresetDelete(args, context);
      if (snap.error) return snap.error;
      if (args.preview === true) return deletePreviewResult(snap, snap.items.map(item => ({ target: item.target, id: item.presetId, name: item.name || item.target, status: item.status, reason: item.reason })));
      if (snap.plannedCount && !isAllowed(context, 'preset.delete_many')) return { ok: false, reason: 'confirmation_required', type: snap.type };
      const results = [];
      let regexTouched = false;
      for (const item of snap.items) {
        const base = { target: item.target, presetId: item.presetId, name: item.name };
        if (item.status !== 'planned') { results.push({ ...base, status: item.status, reason: item.reason }); continue; }
        if (!presetSummaries(snap.type).some(preset => preset.id === item.presetId)) {
          results.push({ ...base, status: 'skipped', reason: 'already_absent' });
          continue;
        }
        const warnings = [];
        if (snap.includeBound) {
          try {
            for (const set of regexStore?.listLocalSets?.() || []) {
              const detached = detachRegexPresetBind(set?.bind, { presetType: snap.type, presetId: item.presetId });
              if (!detached.matched) continue;
              if (detached.bind) await regexStore.upsertLocalSet({ ...set, enabled: set.manualEnabled !== false, bind: detached.bind });
              else await regexStore.removeLocalSet(set.id);
              regexTouched = true;
            }
          } catch { warnings.push('regex_cleanup_failed'); }
          try {
            if (snap.type === 'openai') await scriptStore?.removeScope?.('preset', item.presetId);
          } catch { warnings.push('script_cleanup_failed'); }
        }
        try {
          await presetStore.remove(snap.type, item.presetId);
          const gone = !presetSummaries(snap.type).some(preset => preset.id === item.presetId);
          results.push(gone
            ? { ...base, status: 'succeeded', ...(warnings.length ? { warnings } : {}) }
            : { ...base, status: 'failed', reason: 'verification_failed' });
        } catch (error) {
          results.push({ ...base, status: 'failed', reason: 'delete_failed', errorMessage: clip(error?.message || error) });
        }
      }
      if (regexTouched) notify(onRegexChanged);
      if (results.some(item => item.status === 'succeeded')) notify(onPresetsChanged);
      return batchResult('preset.delete_many', results, {
        requestedCount: snap.items.length,
        retryArgs: failed => ({ type: snap.type, presets: failed.map(item => item.presetId), includeBound: snap.includeBound }),
        extra: { type: snap.type, includeBound: snap.includeBound },
      });
    },
    summarizeResult: summarizeBatch('batch preset deletion'),
  };

  /* ───────────── 正则 ───────────── */

  // 正则的三层容器：global / 规则集 / 当前会话；统一展开成可定位的条目
  const collectRegexTargets = (sessionId = '') => {
    const global = regexStore?.getGlobal?.() || { enabled: true, rules: [] };
    const sets = regexStore?.listLocalSets?.() || [];
    const session = sessionId ? (regexStore?.getSession?.(sessionId) || { enabled: true, rules: [] }) : null;
    const containers = [
      { key: 'global', kind: 'global', label: t('全局'), rules: global.rules || [] },
      ...sets.map(set => ({ key: `set:${set.id}`, kind: 'set', setId: set.id, label: trim(set.name) || set.id, set, rules: set.rules || [] })),
      ...(session ? [{ key: 'session', kind: 'session', label: t('当前会话'), rules: session.rules || [] }] : []),
    ];
    const targets = [
      ...sets.map(set => ({ type: 'set', id: set.id, name: trim(set.name) || set.id, containerKey: `set:${set.id}`, enabled: set.manualEnabled !== false })),
      ...containers.flatMap(container => (container.rules || []).map(rule => ({
        type: 'rule', id: trim(rule.id), name: trim(rule.scriptName) || trim(rule.id), containerKey: container.key, containerLabel: container.label, enabled: rule.disabled !== true,
      }))),
    ];
    return { global, sets, session, containers, targets };
  };

  const readContainerRules = (containerKey, sessionId) => {
    if (containerKey === 'global') return regexStore.getGlobal()?.rules || [];
    if (containerKey === 'session') return regexStore.getSession(sessionId)?.rules || [];
    return regexStore.getLocalSet(containerKey.slice(4))?.rules || [];
  };

  const writeContainerRules = async (containerKey, sessionId, rules) => {
    if (containerKey === 'global') return regexStore.setGlobal({ ...regexStore.getGlobal(), rules });
    if (containerKey === 'session') return regexStore.setSession(sessionId, { ...(regexStore.getSession(sessionId) || { enabled: true }), rules });
    const set = regexStore.getLocalSet(containerKey.slice(4));
    if (!set) throw new Error('regex_set_missing');
    return regexStore.upsertLocalSet({ ...set, enabled: set.manualEnabled !== false, rules });
  };

  const listRegex = async (args = {}, context = {}) => {
    if (!await ready(regexStore)) return { ok: false, reason: 'regex_store_unavailable' };
    const sessionId = sessionIdOf(context);
    const { global, sets, session } = collectRegexTargets(sessionId);
    const includeRules = args.includeRules === true;
    // includeRules:false 明确只要容器清单：只给规则数，不列规则（规则集多时列出全部规则会让观察被截断，模型反复重读）
    // 未指定 includeRules 且没限定容器时，规则总数过多就自动只给规则数：完整列出会让观察被截断、看不到后面的规则集
    const totalRules = (global.rules || []).length + sets.reduce((sum, set) => sum + (set.rules || []).length, 0) + (session?.rules || []).length;
    const autoCompact = args.includeRules === undefined && !trim(args.container) && totalRules > REGEX_LIST_AUTO_COMPACT_RULES;
    const omitRules = args.includeRules === false || autoCompact;
    const listRules = (rules = []) => (omitRules
      ? { ruleCount: rules.length }
      : { rules: rules.slice(0, 200).map(rule => regexRuleSummary(rule, { includeRules })) });
    let scope = trim(args.scope || 'all');
    // container：只读一个容器（global / session / 规则集 id 或名称），写后读回只核对目标，不必列出全部规则集
    const container = trim(args.container);
    let onlySet = null;
    if (container) {
      if (container === 'global' || container === 'session') scope = container;
      else {
        const found = resolveNamedTarget(sets, container);
        if (found.error) return { ok: false, reason: found.error === 'ambiguous_target' ? 'ambiguous_container' : 'container_not_found', container, candidates: found.candidates };
        onlySet = found.item;
        scope = 'sets';
      }
    }
    const out = { ok: true, sessionId };
    if (scope === 'all' || scope === 'global') out.global = { enabled: global.enabled !== false, ...listRules(global.rules || []) };
    if (scope === 'all' || scope === 'sets') {
      out.sets = (onlySet ? [onlySet] : sets.slice(0, 100)).map(set => ({
        id: set.id, name: trim(set.name) || set.id, enabled: set.manualEnabled !== false, activeNow: set.enabled !== false,
        bind: describeRegexBind(set.bind, presetName), ...listRules(set.rules || []),
      }));
    }
    if ((scope === 'all' || scope === 'session') && session) out.session = { enabled: session.enabled !== false, ...listRules(session.rules || []) };
    if (autoCompact) out.note = `规则共 ${totalRules} 条，这里只列出规则集与规则数；需要某个规则集的规则时，用 container 传它的 id 或名称再读。`;
    return out;
  };

  const captureRegexTargets = async (args = {}, context = {}, { forToggle = false } = {}) => {
    if (!await ready(regexStore)) return { error: { ok: false, reason: 'regex_store_unavailable' } };
    const sessionId = sessionIdOf(context);
    const { targets } = collectRegexTargets(sessionId);
    const kind = trim(args.kind || 'auto');
    const pool = kind === 'set' ? targets.filter(item => item.type === 'set') : kind === 'rule' ? targets.filter(item => item.type === 'rule') : targets;
    const enabled = args.enabled === true;
    const seen = new Set();
    const items = resolveDeleteTargets(pool, args.targets, forToggle ? {} : context, 'regex.delete_many').map(({ query, target }) => {
      if (target.error) return { target: query, status: target.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: target.error, candidates: target.candidates };
      const found = target.item;
      const key = `${found.type}:${found.containerKey}:${found.id}`;
      if (seen.has(key)) return { target: query, ...found, status: 'skipped', reason: 'duplicate_target' };
      seen.add(key);
      if (forToggle && found.enabled === enabled) return { target: query, ...found, status: 'skipped', reason: 'already_in_state' };
      return { target: query, ...found, status: 'planned', reason: '' };
    });
    return { sessionId, enabled, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const regexItemLabel = item => (item.type === 'set' ? t('规则集「{name}」', { name: item.name }) : `${item.containerLabel || ''}·${item.name}`);

  const regexToggleTool = {
    name: 'regex.toggle',
    title: 'Enable or disable regex rules',
    description: 'Enable or disable regex rule sets and/or individual rules (global, rule sets, or the current session) in one batch. Targets are ids or exact names from regex.list; kind "set"/"rule" narrows ambiguous names.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_toggle', modelContext: 'none', confirmation: 'allow_once' },
    schema: {
      type: 'object', required: ['targets', 'enabled'], additionalProperties: false,
      properties: {
        targets: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } },
        enabled: { type: 'boolean' },
        kind: { type: 'string', enum: ['auto', 'set', 'rule'] },
      },
    },
    safety: {
      operationType: 'toggle_regex', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureRegexTargets(args, context, { forToggle: true });
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'regex.toggle', operationType: 'toggle_regex', danger: false, allowAlways: true,
          title: snap.enabled ? t('启用正则') : t('停用正则'),
          message: t(snap.enabled ? '将启用 {count} 项正则。' : '将停用 {count} 项正则。', { count: snap.plannedCount }),
          confirmText: snap.enabled ? t('启用') : t('停用'),
          items: snap.items.map(item => ({ id: item.id || item.target, label: item.id ? regexItemLabel(item) : item.target, status: item.status, reason: item.reason })),
          denyReason: 'regex_toggle_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureRegexTargets(args, context, { forToggle: true });
      if (snap.error) return snap.error;
      if (snap.plannedCount && !isAllowed(context, 'regex.toggle')) return { ok: false, reason: 'confirmation_required' };
      const results = [];
      try {
        for (const item of snap.items) {
          const base = { target: item.target, type: item.type, id: item.id, name: item.name };
          if (item.status !== 'planned') { results.push({ ...base, status: item.status, reason: item.reason }); continue; }
          if (item.type === 'set') {
            const set = regexStore.getLocalSet(item.id);
            if (!set) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
            await regexStore.upsertLocalSet({ ...set, enabled: snap.enabled });
            const ok = (regexStore.getLocalSet(item.id)?.manualEnabled !== false) === snap.enabled;
            results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
            continue;
          }
          const rules = readContainerRules(item.containerKey, snap.sessionId);
          const index = rules.findIndex(rule => trim(rule.id) === item.id);
          if (index < 0) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
          const next = rules.map((rule, i) => (i === index ? { ...rule, disabled: !snap.enabled } : rule));
          await writeContainerRules(item.containerKey, snap.sessionId, next);
          const after = readContainerRules(item.containerKey, snap.sessionId).find(rule => trim(rule.id) === item.id);
          const ok = Boolean(after) && (after.disabled !== true) === snap.enabled;
          results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
        }
      } catch (error) {
        return { ok: false, reason: trim(error?.message) === 'regex_store_read_unavailable' ? 'regex_store_read_unavailable' : 'regex_write_failed', errorMessage: clip(error?.message), results };
      }
      if (results.some(item => item.status === 'succeeded')) notify(onRegexChanged);
      return batchResult('regex.toggle', results, {
        requestedCount: snap.items.length,
        retryArgs: failed => ({ targets: failed.map(item => item.id), enabled: snap.enabled }),
        extra: { enabled: snap.enabled },
      });
    },
    summarizeResult: summarizeBatch('regex toggle'),
  };

  const normalizePlacement = (value) => {
    const list = (Array.isArray(value) ? value : [value]).map(item => REGEX_PLACEMENTS[trim(item)] ?? Number(item)).filter(Number.isFinite);
    return list.length ? [...new Set(list)] : null;
  };

  const captureRegexUpsert = async (args = {}, context = {}) => {
    if (!await ready(regexStore)) return { error: { ok: false, reason: 'regex_store_unavailable' } };
    const sessionId = sessionIdOf(context);
    const { sets } = collectRegexTargets(sessionId);
    let containerKey = '';
    let containerLabel = '';
    const newSetName = trim(args.newSetName);
    if (newSetName) {
      containerKey = 'new_set';
      containerLabel = t('新规则集「{name}」', { name: newSetName });
    } else if (trim(args.target || 'global') === 'global') {
      containerKey = 'global'; containerLabel = t('全局');
    } else if (trim(args.target) === 'session') {
      if (!sessionId) return { error: { ok: false, reason: 'no_current_session' } };
      containerKey = 'session'; containerLabel = t('当前会话');
    } else {
      const target = resolveNamedTarget(sets, args.target);
      if (target.error) return { error: { ok: false, reason: target.error, target: trim(args.target), candidates: target.candidates } };
      containerKey = `set:${target.item.id}`;
      containerLabel = t('规则集「{name}」', { name: trim(target.item.name) || target.item.id });
    }
    const existing = containerKey === 'new_set' ? [] : readContainerRules(containerKey, sessionId);
    const items = (Array.isArray(args.rules) ? args.rules : []).map((raw, index) => {
      const ruleId = trim(raw?.id);
      const previous = ruleId ? existing.find(rule => trim(rule.id) === ruleId) : null;
      const label = trim(raw?.scriptName) || trim(previous?.scriptName) || t('规则 {index}', { index: index + 1 });
      if (ruleId && !previous) return { index, label, status: 'missing', reason: 'rule_not_found', ruleId };
      const merged = {
        ...(previous || {}),
        ...(raw?.scriptName !== undefined ? { scriptName: trim(raw.scriptName) } : {}),
        ...(raw?.findRegex !== undefined ? { findRegex: String(raw.findRegex) } : {}),
        ...(raw?.replaceString !== undefined ? { replaceString: String(raw.replaceString) } : {}),
        ...(raw?.trimStrings !== undefined ? { trimStrings: raw.trimStrings } : {}),
        ...(raw?.markdownOnly !== undefined ? { markdownOnly: raw.markdownOnly === true } : {}),
        ...(raw?.promptOnly !== undefined ? { promptOnly: raw.promptOnly === true } : {}),
        ...(raw?.disabled !== undefined ? { disabled: raw.disabled === true } : {}),
      };
      const placement = raw?.placement !== undefined ? normalizePlacement(raw.placement) : null;
      if (placement) merged.placement = placement;
      else if (!previous) merged.placement = [REGEX_PLACEMENTS.ai_output];
      const compiled = compileRegexSource(merged.findRegex);
      if (!compiled.ok) return { index, label, status: 'failed', reason: compiled.reason, errorMessage: compiled.message };
      return {
        index, label, status: 'planned', reason: '', action: previous ? 'update' : 'create', ruleId: trim(previous?.id), rule: merged,
        before: previous ? `${clip(previous.findRegex, 60)} → ${clip(previous.replaceString, 40) || t('（空）')}` : '',
        after: `${clip(merged.findRegex, 60)} → ${clip(merged.replaceString, 40) || t('（空）')}`,
      };
    });
    return { sessionId, containerKey, containerLabel, newSetName, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const regexUpsertTool = {
    name: 'regex.upsert_rules',
    title: 'Create or update regex rules',
    description: 'Create new regex rules or update existing ones (find/replace content) in the global set (target "global", default), the current session (target "session"), an existing rule set (target = set id or exact name), or a new unbound rule set (newSetName). To update, pass the rule id from regex.list and only the fields to change. findRegex accepts /pattern/flags; every pattern is compiled before writing. placement values: user_input, ai_output (default for new rules), slash_command, world_info, reasoning. Does not change rule-set bindings.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['rules'], additionalProperties: false,
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 200 },
        newSetName: { type: 'string', minLength: 1, maxLength: 120 },
        rules: {
          type: 'array', minItems: 1, maxItems: 30,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', maxLength: 120 },
              scriptName: { type: 'string', maxLength: 200 },
              findRegex: { type: 'string', maxLength: 4000 },
              replaceString: { type: 'string', maxLength: 8000 },
              placement: { type: 'array', maxItems: 5, items: { type: 'string', enum: Object.keys(REGEX_PLACEMENTS) } },
              trimStrings: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
              markdownOnly: { type: 'boolean' },
              promptOnly: { type: 'boolean' },
              disabled: { type: 'boolean' },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_regex_rules', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureRegexUpsert(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'regex.upsert_rules', operationType: 'write_regex_rules', danger: false,
          title: t('写入正则规则'),
          message: t('将在{target}新建或修改 {count} 条正则规则，它们会改变聊天内容的显示或发送给模型的文本。', { target: snap.containerLabel, count: snap.plannedCount }),
          confirmText: t('写入'),
          items: snap.items.map(item => ({
            id: item.ruleId || `rule_${item.index}`, label: item.label, status: item.status, reason: item.reason,
            meta: item.status === 'planned'
              ? (item.action === 'update' ? t('修改：{before} ⇒ {after}', { before: item.before, after: item.after }) : t('新建：{after}', { after: item.after }))
              : clip(item.errorMessage, 80),
          })),
          denyReason: 'regex_upsert_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureRegexUpsert(args, context);
      if (snap.error) return snap.error;
      if (snap.plannedCount && !isAllowed(context, 'regex.upsert_rules')) return { ok: false, reason: 'confirmation_required' };
      const planned = snap.items.filter(item => item.status === 'planned');
      let containerKey = snap.containerKey;
      const results = snap.items.filter(item => item.status !== 'planned').map(item => ({ index: item.index, name: item.label, status: item.status, reason: item.reason, ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}) }));
      if (planned.length) {
        try {
          let rules;
          if (containerKey === 'new_set') {
            const setId = await regexStore.upsertLocalSet({ name: snap.newSetName, enabled: true, bind: null, rules: [] });
            containerKey = `set:${setId}`;
            rules = [];
          } else {
            rules = readContainerRules(containerKey, snap.sessionId);
          }
          const next = rules.slice();
          planned.forEach(item => {
            const index = item.ruleId ? next.findIndex(rule => trim(rule.id) === item.ruleId) : -1;
            if (index >= 0) next[index] = { ...next[index], ...item.rule };
            else next.push({ ...item.rule });
          });
          await writeContainerRules(containerKey, snap.sessionId, next);
          const after = readContainerRules(containerKey, snap.sessionId);
          planned.forEach(item => {
            const found = item.ruleId
              ? after.find(rule => trim(rule.id) === item.ruleId)
              : after.find(rule => rule.findRegex === item.rule.findRegex && trim(rule.scriptName) === trim(item.rule.scriptName));
            const ok = Boolean(found) && found.findRegex === item.rule.findRegex && String(found.replaceString ?? '') === String(item.rule.replaceString ?? '');
            results.push({ index: item.index, name: item.label, action: item.action, ruleId: trim(found?.id), status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
          });
        } catch (error) {
          return { ok: false, reason: trim(error?.message) === 'regex_store_read_unavailable' ? 'regex_store_read_unavailable' : 'regex_write_failed', errorMessage: clip(error?.message), results };
        }
        notify(onRegexChanged);
      }
      results.sort((a, b) => a.index - b.index);
      return batchResult('regex.upsert_rules', results, {
        requestedCount: snap.items.length,
        extra: { target: containerKey === 'global' || containerKey === 'session' ? containerKey : containerKey.replace(/^set:/, ''), containerLabel: snap.containerLabel },
      });
    },
    summarizeResult: summarizeBatch('regex rules write'),
  };

  const regexDeleteTool = {
    name: 'regex.delete_many',
    title: 'Delete regex rules or sets',
    description: 'Permanently delete regex rule sets and/or individual rules (global, rule sets, current session) with one confirmation. Targets are ids or exact names from regex.list; kind "set"/"rule" narrows ambiguous names.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['targets'], additionalProperties: false,
      properties: {
        targets: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } },
        kind: { type: 'string', enum: ['auto', 'set', 'rule'] },
        preview: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'delete_regex', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureRegexTargets(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount || args.preview === true) return { destructive: false };
        return confirmRequest({
          kind: 'regex.delete_many', operationType: 'delete_regex',
          title: t('删除正则'),
          message: t('将永久删除 {count} 项正则（整组删除会连同组内全部规则）。', { count: snap.plannedCount }),
          confirmText: t('确认删除'),
          items: snap.items.map(item => ({ id: item.id || item.target, label: item.id ? regexItemLabel(item) : item.target, status: item.status, reason: item.reason })),
          denyReason: 'regex_delete_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureRegexTargets(args, context);
      if (snap.error) return snap.error;
      if (args.preview === true) return deletePreviewResult(snap, snap.items.map(item => ({ target: item.target, id: item.id, type: item.type, containerKey: item.containerKey, name: item.id ? regexItemLabel(item) : item.target, status: item.status, reason: item.reason })));
      if (snap.plannedCount && !isAllowed(context, 'regex.delete_many')) return { ok: false, reason: 'confirmation_required' };
      const results = [];
      try {
        for (const item of snap.items) {
          const base = { target: item.target, type: item.type, id: item.id, name: item.name };
          if (item.status !== 'planned') { results.push({ ...base, status: item.status, reason: item.reason }); continue; }
          if (item.type === 'set') {
            if (!regexStore.getLocalSet(item.id)) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
            await regexStore.removeLocalSet(item.id);
            const ok = !regexStore.getLocalSet(item.id);
            results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
            continue;
          }
          if (item.containerKey.startsWith('set:') && !regexStore.getLocalSet(item.containerKey.slice(4))) {
            results.push({ ...base, status: 'skipped', reason: 'already_absent' });
            continue;
          }
          const rules = readContainerRules(item.containerKey, snap.sessionId);
          if (!rules.some(rule => trim(rule.id) === item.id)) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
          await writeContainerRules(item.containerKey, snap.sessionId, rules.filter(rule => trim(rule.id) !== item.id));
          const ok = !readContainerRules(item.containerKey, snap.sessionId).some(rule => trim(rule.id) === item.id);
          results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
        }
      } catch (error) {
        return { ok: false, reason: trim(error?.message) === 'regex_store_read_unavailable' ? 'regex_store_read_unavailable' : 'regex_write_failed', errorMessage: clip(error?.message), results };
      }
      if (results.some(item => item.status === 'succeeded')) notify(onRegexChanged);
      return batchResult('regex.delete_many', results, {
        requestedCount: snap.items.length,
        retryArgs: failed => ({ targets: failed.map(item => item.id) }),
      });
    },
    summarizeResult: summarizeBatch('regex deletion'),
  };

  /* ───────────── 脚本 ───────────── */

  const collectScripts = () => {
    const scopes = scriptStore?.listScopes?.() || { character: [], preset: [] };
    const buckets = [
      ['global', ''],
      ...(scopes.character || []).map(id => ['character', id]),
      ...(scopes.preset || []).map(id => ['preset', id]),
    ];
    return buckets.flatMap(([scope, scopeId]) => (scriptStore?.getScripts?.(scope, scopeId) || []).map(script => ({
      id: trim(script.id),
      name: trim(script.name) || trim(script.id),
      scope,
      scopeId,
      scopeLabel: scope === 'global' ? t('全局') : scope === 'character' ? (trim(getPersonaName?.(scopeId)) || scopeId) : (presetName('openai', scopeId) || scopeId),
      enabled: script.enabled === true,
      authorized: script.authorized === true,
      blocked: script.compatibility?.blocked === true,
      blockReason: clip((script.compatibility?.reasons || []).join('；') || script.compatibility?.message, 160),
      content: String(script.content || ''),
    })));
  };

  const scriptSettingsSummary = () => {
    const settings = getScriptSettings?.() || {};
    return { scriptsRunGlobally: settings.scriptEnabled === true, permissions: buildScriptPermissionLines(settings) };
  };

  const listScripts = async (args = {}) => {
    if (!await ready(scriptStore)) return { ok: false, reason: 'script_store_unavailable' };
    const scope = trim(args.scope || 'all');
    const personaId = trim(getCurrentPersonaId?.());
    const presetId = trim(presetStore?.getActiveId?.('openai'));
    const activeIds = new Set((scriptStore.getActiveScripts?.({ personaId, presetId }) || []).map(script => `${script.scope}:${trim(script.scopeId)}:${trim(script.id)}`));
    const scripts = collectScripts()
      .filter(script => scope === 'all' || script.scope === scope)
      .slice(0, 200)
      .map(({ content, ...script }) => ({
        ...script,
        scopeLabel: `${t(SCRIPT_SCOPE_LABELS[script.scope])}${script.scope === 'global' ? '' : `：${script.scopeLabel}`}`,
        activeForCurrentContext: activeIds.has(`${script.scope}:${script.scopeId}:${script.id}`),
        ...(args.includeCode === true ? { code: clip(content, 4000) } : {}),
      }));
    return { ok: true, ...scriptSettingsSummary(), scripts };
  };

  const captureScripts = async (args = {}, { forToggle = false, context = {} } = {}) => {
    if (!await ready(scriptStore)) return { error: { ok: false, reason: 'script_store_unavailable' } };
    const all = collectScripts();
    const enabled = args.enabled === true;
    const seen = new Set();
    const items = resolveDeleteTargets(all, args.scripts, forToggle ? {} : context, 'script.delete_many').map(({ query, target }) => {
      if (target.error) return { target: query, status: target.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: target.error, candidates: target.candidates };
      const { content, ...script } = target.item;
      const key = `${script.scope}:${script.scopeId}:${script.id}`;
      if (seen.has(key)) return { target: query, ...script, status: 'skipped', reason: 'duplicate_target' };
      seen.add(key);
      if (forToggle && enabled && script.blocked) return { target: query, ...script, status: 'protected', reason: 'blocked_by_compatibility' };
      if (forToggle && script.enabled === enabled) return { target: query, ...script, status: 'skipped', reason: 'already_in_state' };
      return { target: query, ...script, status: 'planned', reason: '' };
    });
    return { enabled, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const scriptItem = item => ({
    id: item.id || item.target,
    label: item.name || item.target,
    meta: item.scope ? `${t(SCRIPT_SCOPE_LABELS[item.scope])}${item.scope === 'global' ? '' : `：${item.scopeLabel}`}` : '',
    status: item.status,
    reason: item.reason,
  });

  const readScript = item => (scriptStore.getScripts(item.scope, item.scopeId) || []).find(script => trim(script.id) === item.id) || null;

  const scriptToggleTool = {
    name: 'script.toggle_many',
    title: 'Enable or disable scripts',
    description: 'Enable or disable TavernHelper-style scripts (global, character-card or preset scope) in one batch. Enabling lets the script run code with the app\'s script permissions, so it always asks the user and never offers "always allow"; scripts blocked by the compatibility check cannot be enabled. Scripts only actually run when the global script switch is on (reported as scriptsRunGlobally).',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_toggle', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['scripts', 'enabled'], additionalProperties: false,
      properties: {
        scripts: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } },
        enabled: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'toggle_scripts', destructive: 'conditional',
      preflight: async (args) => {
        const snap = await captureScripts(args, { forToggle: true });
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        const summary = scriptSettingsSummary();
        return snap.enabled
          ? confirmRequest({
            kind: 'script.enable', operationType: 'enable_scripts', danger: true, allowAlways: false,
            title: t('启用脚本'),
            message: [
              t('将启用 {count} 个脚本。脚本会在后台运行代码，可能使用以下权限：', { count: snap.plannedCount }),
              ...summary.permissions.map(line => `· ${line}`),
              summary.scriptsRunGlobally ? t('全局脚本开关已开启，启用后会立即运行。') : t('全局脚本开关目前关闭，启用后要等开关打开才会运行。'),
            ].join('\n'),
            confirmText: t('启用'),
            items: snap.items.map(scriptItem),
            denyReason: 'script_enable_cancelled',
          })
          : confirmRequest({
            kind: 'script.disable', operationType: 'disable_scripts', danger: false, allowAlways: true,
            title: t('停用脚本'),
            message: t('将停用 {count} 个脚本。', { count: snap.plannedCount }),
            confirmText: t('停用'),
            items: snap.items.map(scriptItem),
            denyReason: 'script_disable_cancelled',
          });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureScripts(args, { forToggle: true });
      if (snap.error) return snap.error;
      const kind = snap.enabled ? 'script.enable' : 'script.disable';
      if (snap.plannedCount && !isAllowed(context, kind)) return { ok: false, reason: 'confirmation_required' };
      const results = [];
      for (const item of snap.items) {
        const base = { target: item.target, id: item.id, name: item.name, scope: item.scope, scopeId: item.scopeId };
        if (item.status !== 'planned') { results.push({ ...base, status: item.status, reason: item.reason }); continue; }
        if (!readScript(item)) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
        try {
          const changed = await scriptStore.toggleScript(item.scope, item.scopeId, item.id, snap.enabled);
          const after = readScript(item);
          const ok = changed !== false && Boolean(after) && (after.enabled === true) === snap.enabled;
          results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: changed === false && snap.enabled ? 'blocked_by_compatibility' : 'verification_failed' }) });
        } catch (error) {
          results.push({ ...base, status: 'failed', reason: 'toggle_failed', errorMessage: clip(error?.message) });
        }
      }
      if (results.some(item => item.status === 'succeeded')) notify(onScriptsChanged);
      return batchResult('script.toggle_many', results, {
        requestedCount: snap.items.length,
        retryArgs: failed => ({ scripts: failed.map(item => item.id), enabled: snap.enabled }),
        extra: { enabled: snap.enabled, scriptsRunGlobally: scriptSettingsSummary().scriptsRunGlobally },
      });
    },
    summarizeResult: summarizeBatch('script toggle'),
  };

  const scriptDeleteTool = {
    name: 'script.delete_many',
    title: 'Delete scripts',
    description: 'Permanently delete TavernHelper-style scripts (any scope) with one confirmation. Targets are ids or exact names from script.list.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['scripts'], additionalProperties: false,
      properties: { scripts: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } }, preview: { type: 'boolean' } },
    },
    safety: {
      operationType: 'delete_scripts', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureScripts(args, { context });
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount || args.preview === true) return { destructive: false };
        return confirmRequest({
          kind: 'script.delete_many', operationType: 'delete_scripts',
          title: t('删除脚本'),
          message: t('将永久删除 {count} 个脚本及其代码。', { count: snap.plannedCount }),
          confirmText: t('确认删除'),
          items: snap.items.map(scriptItem),
          denyReason: 'script_delete_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureScripts(args, { context });
      if (snap.error) return snap.error;
      if (args.preview === true) return deletePreviewResult(snap, snap.items.map(item => ({ ...scriptItem(item), scope: item.scope, scopeId: item.scopeId })));
      if (snap.plannedCount && !isAllowed(context, 'script.delete_many')) return { ok: false, reason: 'confirmation_required' };
      const results = [];
      for (const item of snap.items) {
        const base = { target: item.target, id: item.id, name: item.name, scope: item.scope, scopeId: item.scopeId };
        if (item.status !== 'planned') { results.push({ ...base, status: item.status, reason: item.reason }); continue; }
        if (!readScript(item)) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
        try {
          await scriptStore.deleteScript(item.scope, item.scopeId, item.id);
          const ok = !readScript(item);
          results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
        } catch (error) {
          results.push({ ...base, status: 'failed', reason: 'delete_failed', errorMessage: clip(error?.message) });
        }
      }
      if (results.some(item => item.status === 'succeeded')) notify(onScriptsChanged);
      return batchResult('script.delete_many', results, {
        requestedCount: snap.items.length,
        retryArgs: failed => ({ scripts: failed.map(item => item.id) }),
      });
    },
    summarizeResult: summarizeBatch('script deletion'),
  };

  const readTool = ({ name, title, description, schema, execute, summarize }) => ({
    name, title, description,
    source: 'maid-app-content', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
    schema: { type: 'object', additionalProperties: false, properties: schema },
    execute,
    summarizeResult: summarize,
  });

  return [
    readTool({
      name: 'preset.list', title: 'List presets',
      description: 'List saved presets of each type (openai chat-completion, sysprompt, context, instruct, reasoning) with which one is in use for the current session and why (session binding / mode binding / global / built-in). includeEntries:true also lists the prompt entries of the in-use openai preset with their enabled state.',
      schema: { type: { type: 'string', enum: PRESET_TYPES }, includeEntries: { type: 'boolean' } },
      execute: listPresets,
      summarize: result => (result?.ok ? `listed presets for ${Object.keys(result.presets || {}).length} type(s)` : `preset list failed: ${trim(result?.reason)}`),
    }),
    presetSwitchTool,
    presetEntriesTool,
    presetDeleteTool,
    readTool({
      name: 'regex.list', title: 'List regex rules',
      description: 'List regex rules across the global set, rule sets (with their preset/worldbook bindings) and the current session, with ids, enabled state and placement. includeRules:false lists only the containers with rule counts (use it to answer "which sets exist"); includeRules:true adds find/replace text; scope narrows to global/sets/session; container reads just one of global, session, or a rule set (id or exact name).',
      schema: { scope: { type: 'string', enum: ['all', 'global', 'sets', 'session'] }, container: { type: 'string', minLength: 1, maxLength: 200 }, includeRules: { type: 'boolean' } },
      execute: listRegex,
      summarize: result => (result?.ok ? `listed regex: ${(result.sets || []).length} set(s)` : `regex list failed: ${trim(result?.reason)}`),
    }),
    regexToggleTool,
    regexUpsertTool,
    regexDeleteTool,
    readTool({
      name: 'script.list', title: 'List scripts',
      description: 'List TavernHelper-style scripts in global, character-card and preset scopes with enabled/authorized state, compatibility blocks, whether they apply to the current card/preset, the global script switch and script permissions. Code is omitted unless includeCode:true.',
      schema: { scope: { type: 'string', enum: ['all', ...SCRIPT_SCOPES] }, includeCode: { type: 'boolean' } },
      execute: listScripts,
      summarize: result => (result?.ok ? `listed ${(result.scripts || []).length} script(s)` : `script list failed: ${trim(result?.reason)}`),
    }),
    scriptToggleTool,
    scriptDeleteTool,
  ];
};

export const registerPresetRegexScriptAgentTools = (registry, deps = {}) => {
  if (!registry?.registerMany) return [];
  return registry.registerMany(createPresetRegexScriptAgentTools(deps));
};
