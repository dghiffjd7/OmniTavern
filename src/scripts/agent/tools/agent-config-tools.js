import { t } from '../../i18n/index.js';
import { normalizeAgentConfiguration } from '../../storage/agent-config-store.js';
import { validateAgentConfiguration } from '../agent-configuration-service.js';
import { agentInvocationLabel, getAgentInvocationMode } from '../agent-invocation.js';
import { RECAP_AGENT_ID } from '../recap-agent.js';
import {
  STEWARD_CONFIG_ID,
  STEWARD_CUSTOM_INPUTS,
  STEWARD_CUSTOM_OUTPUTS,
  STEWARD_CUSTOM_TASK_LIMIT,
  STEWARD_TASKS,
  STEWARD_TRANSLATION_LANGUAGES,
  createStewardCustomTaskId,
  normalizeStewardCustomTasks,
} from '../steward-tasks.js';
import { batchResult, confirmRequest, resolveNamedTarget, summarizeBatch } from './preset-regex-script-tools.js';

/* 女仆设定 Agent Center 里的 Agent（回复 Agent 如「正文润色」、输入助手、格式修复与文本建议的开关和模型）与小管家。
   读写都经 Agent 设定服务（与编辑器同一套保存检查与版本号），做法同正则工具：
   冻结目标 → 一次结构化确认 → 保存时用确认前的版本号复验 → 读回核对。
   作用范围沿用编辑器：local＝当前聊天（创意写作为当前角色卡），global＝全部聊天（或全部创意写作）。 */

const trim = value => String(value ?? '').trim();
const clip = (value, max = 120) => {
  const text = trim(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const fingerprint = value => JSON.stringify(value, (key, child) => {
  if (key === 'updatedAt') return undefined;
  return child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)))
    : child;
});

const CUSTOM_AGENT_LIMIT = 8;
const BUILTIN_AGENT_IDS = Object.freeze(['reply_check', 'text_completion']);
const BUILTIN_EDITABLE_FIELDS = Object.freeze(['id', 'enabled', 'invocation', 'model']);
const TYPE_BY_KIND = Object.freeze({
  text_edit: 'reply_agent', input_agent: 'input_agent', format_review: 'format_repair',
  input_suggestion: 'text_suggestion', archive_naming: 'steward',
});
const NEW_AGENT_DEFAULTS = Object.freeze({
  // 与 Agent 设定服务的 createTextEditAgent／createInputAgent 默认值一致
  reply_agent: {
    title: '正文润色', prompt: '润色正文，保留事实、人物语气和原意。',
    context: { history: { enabled: false, unit: 'turns', count: 3, includeTarget: true } },
    invocationMode: 'auto', modelMode: 'follow_current', target: { mode: 'rendered' },
  },
  input_agent: {
    title: '输入助手', prompt: '根据用户的草稿，给出简短、有用的写作建议。', inputOutput: 'note',
    context: { history: { enabled: false, unit: 'turns', count: 3, includeTarget: true } }, invocationMode: 'auto',
  },
});
const PLACEHOLDER_IDS = Object.freeze({ reply_agent: 'text-edit:new', input_agent: 'input-agent:new' });

const agentType = config => (config?.id === RECAP_AGENT_ID ? 'recap' : TYPE_BY_KIND[config?.kind] || trim(config?.kind));
const scopeOf = value => (value === 'global' ? 'global' : 'local');
const scopeLabel = (scope, place) => (scope === 'global'
  ? (place === 'writing' ? t('全部创意写作') : t('全部聊天'))
  : (place === 'writing' ? t('当前角色卡的创意写作') : t('当前聊天')));
const isAllowed = (context = {}, kind = '') => (
  context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind
);
const notFoundItem = (index, label, found) => ({
  index, label, status: found.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: found.error,
  ...(found.candidates ? { candidates: found.candidates } : {}),
});

const profileName = (profiles, id) => profiles.find(profile => profile.id === id)?.name || trim(id);
const modelLabel = (config, profiles) => (config.modelMode === 'profile' && config.modelProfileId
  ? profileName(profiles, config.modelProfileId)
  : config.modelMode === 'follow_current' ? t('跟随当前模型') : t('未选择'));
const describeAgent = (config, profiles) => [
  config.enabled ? t('开启') : t('关闭'),
  ...(config.kind === 'archive_naming' ? [] : [t(agentInvocationLabel(config))]),
  t('模型：{model}', { model: modelLabel(config, profiles) }),
  ...(config.kind === 'text_edit' ? [config.outputMode === 'note' ? t('写成备注') : t('改写原文')] : []),
].join(' · ');

const pickTarget = (target = {}) => ({
  mode: target.mode,
  ...(target.mode === 'tags' ? { start: target.start, end: target.end } : {}),
  ...(target.mode === 'regex' ? { pattern: target.pattern, flags: target.flags, group: target.group } : {}),
});

const summarizeSteward = (config, profiles, full) => ({
  tasks: STEWARD_TASKS.map((task) => {
    const row = config.tasks?.[task.id] || {};
    return {
      id: task.id, title: t(task.title), trigger: t(task.trigger), enabled: row.enabled === true,
      model: row.modelProfileId
        ? { mode: 'profile', profileId: row.modelProfileId, profileName: profileName(profiles, row.modelProfileId) }
        : { mode: 'shared' },
      ...(task.id === 'translate_message' ? { targetLanguage: row.targetLanguage || '' } : {}),
    };
  }),
  customTasks: normalizeStewardCustomTasks(config.customTasks).map(task => ({ ...task, prompt: full ? task.prompt : clip(task.prompt, 160) })),
});

const summarizeAgent = (record, profiles, { full = false } = {}) => {
  const config = record.config;
  const type = agentType(config);
  const summary = {
    id: config.id, type, title: config.title, enabled: config.enabled === true, definedIn: record.source,
    model: config.modelMode === 'profile'
      ? { mode: 'profile', profileId: config.modelProfileId, profileName: profileName(profiles, config.modelProfileId) }
      : { mode: config.modelMode },
  };
  if (type !== 'steward') summary.invocation = getAgentInvocationMode(config);
  if (['reply_agent', 'recap', 'input_agent'].includes(type)) {
    summary.promptSource = config.promptSource;
    if (config.promptSource === 'preset') summary.presetId = config.presetId;
    summary.prompt = full ? config.prompt : clip(config.prompt, 200);
  }
  if (type === 'reply_agent' || type === 'recap') {
    summary.outputMode = config.outputMode;
    summary.target = pickTarget(config.target);
  }
  if (type === 'input_agent') summary.inputOutput = config.inputOutput;
  if (type === 'format_repair') summary.formatGuideSet = Boolean(trim(config.formatGuide));
  if (type === 'steward') Object.assign(summary, summarizeSteward(config, profiles, full));
  return summary;
};

const MODEL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['follow_current', 'profile'] },
    profile: { type: 'string', maxLength: 200 },
  },
};

export const createAgentConfigAgentTools = ({ getActions, getContext, listPresets, getFlowBoard } = {}) => {
  const snapshots = new WeakMap();
  const actionsOrNull = () => {
    try { return getActions?.() || null; } catch { return null; }
  };
  const currentContext = () => {
    const context = getContext?.() || {};
    return { place: context.place === 'writing' ? 'writing' : 'chat', sessionId: trim(context.sessionId), scopeId: trim(context.scopeId) };
  };
  // 模型档清单与编辑器同源（Agent 设定服务读取时附带）
  const readProfiles = (actions, context) => {
    try { return actions.getAgentConfiguration({ id: 'text_completion', scope: 'local', context })?.profiles || []; } catch { return []; }
  };
  // 创意写作用自定义流程板时，只有放在板上的回复 Agent 会在回复后执行；推导板会排进所有自动的
  const readFlowBoard = (context) => {
    try {
      const board = getFlowBoard?.(context);
      return board ? { custom: board.custom === true, agentIds: new Set(board.agentIds || []) } : null;
    } catch { return null; }
  };
  const flowNote = () => t('当前创意写作用的是自定义流程板，这个 Agent 不在板上，回复后不会自动执行；要放进流程板才会跑。');
  const resolveModel = (model, profiles) => {
    if (!model) return { patch: {} };
    if (model.mode === 'follow_current') return { patch: { modelMode: 'follow_current', modelProfileId: '' } };
    const found = resolveNamedTarget(profiles, model.profile);
    if (found.error) return { error: `model_profile_${found.error}`, candidates: found.candidates || profiles.slice(0, 12).map(p => ({ id: p.id, name: p.name })) };
    return { patch: { modelMode: 'profile', modelProfileId: found.item.id } };
  };
  const resolvePreset = (query) => {
    if (trim(query) === '') return { patch: { promptSource: 'prompt', presetId: '' } };
    const presets = (listPresets?.() || []).map(item => ({ id: trim(item.id), name: trim(item.name) || trim(item.id) }));
    const found = resolveNamedTarget(presets, query);
    if (found.error) return { error: `preset_${found.error}`, candidates: found.candidates };
    return { patch: { promptSource: 'preset', presetId: found.item.id } };
  };

  // ── agent.list ──
  const listAgents = async (args = {}) => {
    const actions = actionsOrNull();
    if (!actions?.listAgentConfigurations) return { ok: false, reason: 'agent_config_unavailable' };
    const context = currentContext();
    const scope = args.scope === 'global' ? 'global' : 'effective';
    const records = actions.listAgentConfigurations({ scope, context }) || [];
    const profiles = readProfiles(actions, context);
    const flow = readFlowBoard(context);
    const base = {
      ok: true, place: context.place, scope: scope === 'global' ? 'global' : 'local',
      scopeLabel: scopeLabel(scope === 'global' ? 'global' : 'local', context.place),
      ...(flow ? { flowBoard: flow.custom ? 'custom' : 'derived' } : {}),
      modelProfiles: profiles.map(profile => ({ id: profile.id, name: profile.name, model: profile.model })),
      limits: { customAgentsPerType: CUSTOM_AGENT_LIMIT, stewardCustomTasks: STEWARD_CUSTOM_TASK_LIMIT },
    };
    const summarize = (record, options) => {
      const summary = summarizeAgent(record, profiles, options);
      return flow?.custom && (summary.type === 'reply_agent' || summary.type === 'recap')
        ? { ...summary, onFlowBoard: flow.agentIds.has(summary.id) } : summary;
    };
    if (trim(args.agent)) {
      const found = resolveNamedTarget(records, args.agent, { idOf: record => record.config.id, nameOf: record => record.config.title });
      if (found.error) return { ok: false, reason: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) };
      return { ...base, agent: summarize(found.item, { full: true }) };
    }
    return { ...base, agents: records.map(record => summarize(record)) };
  };

  // ── agent.upsert ──
  const captureUpsert = async (args = {}) => {
    const actions = actionsOrNull();
    if (!actions?.saveAgentConfiguration) return { error: { ok: false, reason: 'agent_config_unavailable' } };
    const context = currentContext();
    const scope = scopeOf(args.scope);
    if (scope === 'local' && !context.sessionId) return { error: { ok: false, reason: 'no_current_session' } };
    const records = actions.listAgentConfigurations({ scope: scope === 'global' ? 'global' : 'effective', context }) || [];
    const reference = actions.getAgentConfiguration({ id: 'text_completion', scope, context }) || {};
    const profiles = reference.profiles || [];
    const flow = readFlowBoard(context);
    const counts = {
      reply_agent: records.filter(record => record.config.kind === 'text_edit').length,
      input_agent: records.filter(record => record.config.kind === 'input_agent').length,
    };
    const items = (Array.isArray(args.agents) ? args.agents : []).map((raw = {}, index) => {
      const label = trim(raw.title) || trim(raw.id) || trim(raw.create);
      const fail = (reason, extra = {}) => ({ index, label, status: 'failed', reason, ...extra });
      if (Boolean(trim(raw.id)) === Boolean(raw.create)) return fail('id_or_create_required');
      let current = null;
      let saved = null;
      let type = raw.create;
      if (raw.create) {
        if (counts[type] >= CUSTOM_AGENT_LIMIT) return fail('agent_limit', { message: t('当前范围最多 {count} 个同类 Agent', { count: CUSTOM_AGENT_LIMIT }) });
        counts[type] += 1;
      } else {
        const found = resolveNamedTarget(records, raw.id, { idOf: record => record.config.id, nameOf: record => record.config.title });
        if (found.error) return notFoundItem(index, label, found);
        type = agentType(found.item.config);
        if (type === 'steward') return fail('use_steward_configure');
        saved = actions.getAgentConfiguration({ id: found.item.config.id, scope, context });
        current = saved?.config;
        if (!current) return fail('not_found');
        if (BUILTIN_AGENT_IDS.includes(current.id)) {
          const extra = Object.keys(raw).filter(key => !BUILTIN_EDITABLE_FIELDS.includes(key));
          if (extra.length) return fail('field_not_editable', { fields: extra });
        }
      }
      const isReplyAgent = type === 'reply_agent' || type === 'recap';
      if ((raw.outputMode !== undefined || raw.target !== undefined) && !isReplyAgent) return fail('field_not_supported', { fields: ['outputMode', 'target'].filter(key => raw[key] !== undefined) });
      if (raw.inputOutput !== undefined && type !== 'input_agent') return fail('field_not_supported', { fields: ['inputOutput'] });
      const patch = {};
      if (raw.title !== undefined) patch.title = raw.title;
      if (raw.enabled !== undefined) patch.enabled = raw.enabled;
      else if (raw.create) patch.enabled = true;
      if (raw.invocation !== undefined) patch.invocationMode = raw.invocation;
      if (raw.prompt !== undefined) patch.prompt = raw.prompt;
      if (raw.outputMode !== undefined) patch.outputMode = raw.outputMode;
      if (raw.inputOutput !== undefined) patch.inputOutput = raw.inputOutput;
      if (raw.target !== undefined) patch.target = { ...raw.target };
      const model = resolveModel(raw.model, profiles);
      if (model.error) return fail(model.error, { candidates: model.candidates });
      Object.assign(patch, model.patch);
      if (raw.preset !== undefined) {
        const preset = resolvePreset(raw.preset);
        if (preset.error) return fail(preset.error, { ...(preset.candidates ? { candidates: preset.candidates } : {}) });
        Object.assign(patch, preset.patch);
      }
      const patchKeys = Object.keys(patch);
      const id = current?.id || PLACEHOLDER_IDS[type];
      const next = normalizeAgentConfiguration({ ...(current || NEW_AGENT_DEFAULTS[type]), ...patch }, id);
      const invalid = validateAgentConfiguration(next, { place: context.place, bodyRule: (saved || reference).bodyRule });
      if (invalid) return fail('invalid_configuration', { message: t(invalid) });
      // 读出的格式修复会带上方案投射的栏位，先整理成同样的形状再比
      if (current && fingerprint(next) === fingerprint(normalizeAgentConfiguration(current, id))) {
        return { index, label: current.title, id: current.id, status: 'skipped', reason: 'no_change' };
      }
      // 回复 Agent 设为自动后每条回复都会多一次模型调用（格式修复另有检查条件，不在此提示）
      const auto = next.enabled && next.kind === 'text_edit' && getAgentInvocationMode(next) !== 'manual';
      const offBoard = auto && Boolean(flow?.custom) && !flow.agentIds.has(current?.id || '');
      return {
        index, status: 'planned', action: raw.create ? 'create' : 'update', type,
        id: current?.id || '', label: next.title, config: next, revision: saved?.revision, patchKeys,
        before: current ? describeAgent(current, profiles) : '', after: describeAgent(next, profiles),
        autoRun: auto && !offBoard, offBoard,
      };
    });
    return { context, scope, profiles, flow, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  // 只核对这次改到的栏位与开关：格式修复等内建 Agent 有些栏位由方案投射，保存后会重新计算
  const verifyAgent = (actual, expected, keys) => Boolean(actual) && [...new Set(['enabled', ...keys])]
    .every(key => (key === 'target'
      ? fingerprint(pickTarget(actual.target)) === fingerprint(pickTarget(expected.target))
      : fingerprint(actual[key]) === fingerprint(expected[key])));

  const saveFailure = (result) => {
    const reason = trim(result?.reason);
    if (reason === 'config_changed') return { reason: 'target_changed_during_confirmation' };
    if (reason === 'context_changed') return { reason: 'context_changed_during_confirmation' };
    return { reason: reason || 'save_failed', ...(result?.message ? { message: t(result.message) } : {}) };
  };

  const agentUpsertTool = {
    name: 'agent.upsert',
    title: 'Create or update Agents',
    description: 'Create a reply Agent (create:"reply_agent", e.g. one that polishes every AI reply after it is generated) or an input assistant (create:"input_agent"), or update an existing Agent by id or exact title from agent.list. Built-in format repair (reply_check) and text suggestion (text_completion) accept only enabled, invocation and model. invocation auto runs after every reply, manual is used from the Agent toolbox, both allows either. model {mode:"follow_current"} or {mode:"profile", profile: id or name from agent.list modelProfiles}; input assistants need a profile. preset = an openai chat preset id or name to use instead of prompt ("" stops using it). Reply Agents: outputMode edit rewrites the reply, note adds a note under it; target.mode rendered (default, the displayed reply), full, body, tags (start/end) or regex (pattern). New Agents are enabled unless enabled:false. scope local (default) = the current chat (or the current card in creative writing), global = all chats (or all creative writing). In creative writing with a custom flow board (agent.list flowBoard "custom"), an auto reply Agent runs only when it is on that board; results report onFlowBoard. Use steward.configure for the steward.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['agents'], additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['local', 'global'] },
        agents: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', maxLength: 120 },
              create: { type: 'string', enum: ['reply_agent', 'input_agent'] },
              title: { type: 'string', minLength: 1, maxLength: 80 },
              enabled: { type: 'boolean' },
              invocation: { type: 'string', enum: ['auto', 'manual', 'both'] },
              model: MODEL_SCHEMA,
              prompt: { type: 'string', maxLength: 8000 },
              preset: { type: 'string', maxLength: 200 },
              outputMode: { type: 'string', enum: ['edit', 'note'] },
              inputOutput: { type: 'string', enum: ['suggestion', 'rewrite', 'note'] },
              target: {
                type: 'object', additionalProperties: false, required: ['mode'],
                properties: {
                  mode: { type: 'string', enum: ['rendered', 'full', 'body', 'tags', 'regex'] },
                  start: { type: 'string', maxLength: 200 },
                  end: { type: 'string', maxLength: 200 },
                  pattern: { type: 'string', maxLength: 2000 },
                  flags: { type: 'string', maxLength: 10 },
                },
              },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_agent_config', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureUpsert(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        const planned = snap.items.filter(item => item.status === 'planned');
        return confirmRequest({
          kind: 'agent.upsert', operationType: 'write_agent_config', danger: false,
          title: t('设定 Agent'),
          message: [
            t('将在{scope}新建或修改 {count} 个 Agent。', { scope: scopeLabel(snap.scope, snap.context.place), count: snap.plannedCount }),
            ...(planned.some(item => item.autoRun) ? [t('设为自动的回复 Agent 会在每条回复后再调用一次模型。')] : []),
            ...(planned.some(item => item.offBoard) ? [t('当前创意写作用的是自定义流程板，自动的 Agent 要放进流程板才会在回复后执行。')] : []),
          ].join(''),
          confirmText: t('保存'),
          items: snap.items.map(item => ({
            id: item.id || `agent_${item.index}`, label: item.label, status: item.status, reason: item.reason,
            meta: item.status === 'planned'
              ? (item.action === 'update' ? t('修改：{before} ⇒ {after}', { before: item.before, after: item.after }) : t('新建：{after}', { after: item.after }))
              : clip(item.message || item.reason, 80),
          })),
          denyReason: 'agent_upsert_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureUpsert(args, context);
      if (snap.error) return snap.error;
      if (snap.plannedCount && !isAllowed(context, 'agent.upsert')) return { ok: false, reason: 'confirmation_required' };
      const actions = actionsOrNull();
      const results = snap.items.filter(item => item.status !== 'planned').map(({ config: _config, revision: _revision, patchKeys: _keys, ...item }) => item);
      for (const item of snap.items.filter(entry => entry.status === 'planned')) {
        const base = { index: item.index, title: item.label, action: item.action, type: item.type };
        if (context.signal?.aborted) {
          results.push({ ...base, id: item.id, status: 'cancelled', reason: 'user_aborted' });
          continue;
        }
        let id = item.id;
        let saved;
        if (item.action === 'create') {
          const create = item.type === 'input_agent' ? actions?.createInputAgent : actions?.createTextEditAgent;
          const { id: _placeholder, enabled, ...config } = item.config;
          const created = await create?.({ scope: snap.scope, context: snap.context, config });
          if (!created?.ok) {
            results.push({ ...base, status: 'failed', ...saveFailure(created) });
            continue;
          }
          id = created.id;
          saved = enabled
            ? await actions.saveAgentConfiguration({ id, scope: snap.scope, context: snap.context, revision: created.revision, config: { ...item.config, id, enabled: true } })
            : created;
          if (!saved?.ok) {
            // 已建立但没能开启：保留关闭状态的 Agent，如实回报
            results.push({ ...base, id, status: 'failed', changed: true, ...saveFailure(saved) });
            continue;
          }
        } else {
          saved = await actions.saveAgentConfiguration({ id, scope: snap.scope, context: snap.context, revision: item.revision, config: item.config });
          if (!saved?.ok) {
            results.push({ ...base, id, status: 'failed', ...saveFailure(saved) });
            continue;
          }
        }
        const after = actions.getAgentConfiguration({ id, scope: snap.scope, context: snap.context })?.config;
        const ok = verifyAgent(after, { ...item.config, id }, item.patchKeys);
        const placement = snap.flow?.custom && after?.kind === 'text_edit'
          ? { onFlowBoard: snap.flow.agentIds.has(id), ...(item.offBoard ? { note: flowNote() } : {}) } : {};
        results.push({ ...base, id, status: ok ? 'succeeded' : 'failed', ...(ok ? { summary: describeAgent(after, snap.profiles), ...placement } : { reason: 'verification_failed' }) });
      }
      return batchResult('agent.upsert', results, {
        requestedCount: snap.items.length,
        extra: { scope: snap.scope, scopeLabel: scopeLabel(snap.scope, snap.context.place) },
      });
    },
    summarizeResult: summarizeBatch('agent upsert'),
  };

  // ── agent.delete_many ──
  const captureDelete = async (args = {}) => {
    const actions = actionsOrNull();
    if (!actions?.removeAgentConfiguration) return { error: { ok: false, reason: 'agent_config_unavailable' } };
    const context = currentContext();
    if (!context.sessionId) return { error: { ok: false, reason: 'no_current_session' } };
    const records = actions.listAgentConfigurations({ scope: 'effective', context }) || [];
    const seen = new Set();
    const items = (Array.isArray(args.targets) ? args.targets : []).map((query, index) => {
      const found = resolveNamedTarget(records, query, { idOf: record => record.config.id, nameOf: record => record.config.title });
      if (found.error) return notFoundItem(index, trim(query), found);
      const { config, source } = found.item;
      if (seen.has(config.id)) return { index, label: config.title, id: config.id, status: 'skipped', reason: 'duplicate_target' };
      seen.add(config.id);
      if (!/^(text-edit|input-agent):/.test(config.id)) return { index, label: config.title, id: config.id, status: 'protected', reason: 'builtin_agent' };
      const scope = args.scope ? scopeOf(args.scope) : source === 'global' ? 'global' : 'local';
      const record = actions.getAgentConfiguration({ id: config.id, scope, context });
      if (!record?.config) return { index, label: config.title, id: config.id, status: 'missing', reason: 'not_in_scope' };
      return { index, status: 'planned', id: config.id, label: config.title, type: agentType(config), scope, revision: record.revision };
    });
    return { context, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const agentDeleteTool = {
    name: 'agent.delete_many',
    title: 'Delete Agents',
    description: 'Delete user-made Agents (reply Agents such as 正文润色, and input assistants) by id or exact title from agent.list, with one confirmation. Built-in Agents (format repair, text suggestion, steward) cannot be deleted; turn them off with agent.upsert enabled:false. By default each Agent is deleted where it is defined (an Agent shared to all chats is deleted for all of them); scope local hides it only in the current chat.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['targets'], additionalProperties: false,
      properties: {
        targets: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 120 } },
        scope: { type: 'string', enum: ['local', 'global'] },
      },
    },
    safety: {
      operationType: 'delete_agent_config', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureDelete(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'agent.delete_many', operationType: 'delete_agent_config',
          title: t('删除 Agent'),
          message: t('将删除 {count} 个 Agent，删除后无法恢复。', { count: snap.plannedCount }),
          confirmText: t('删除'),
          items: snap.items.map(item => ({
            id: item.id || `agent_${item.index}`, label: item.label, status: item.status, reason: item.reason,
            meta: item.status === 'planned' ? scopeLabel(item.scope, snap.context.place) : clip(item.reason, 80),
          })),
          denyReason: 'agent_delete_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureDelete(args, context);
      if (snap.error) return snap.error;
      if (snap.plannedCount && !isAllowed(context, 'agent.delete_many')) return { ok: false, reason: 'confirmation_required' };
      const actions = actionsOrNull();
      const results = snap.items.filter(item => item.status !== 'planned').map(({ revision: _revision, ...item }) => item);
      for (const item of snap.items.filter(entry => entry.status === 'planned')) {
        const base = { index: item.index, id: item.id, title: item.label, scope: item.scope };
        if (context.signal?.aborted) {
          results.push({ ...base, status: 'cancelled', reason: 'user_aborted' });
          continue;
        }
        const removed = await actions.removeAgentConfiguration({ id: item.id, scope: item.scope, context: snap.context, revision: item.revision });
        if (!removed?.ok) {
          results.push({ ...base, status: 'failed', ...saveFailure(removed) });
          continue;
        }
        const gone = !actions.getAgentConfiguration({ id: item.id, scope: item.scope, context: snap.context })?.config;
        results.push({ ...base, status: gone ? 'succeeded' : 'failed', ...(gone ? {} : { reason: 'verification_failed' }) });
      }
      return batchResult('agent.delete_many', results, { requestedCount: snap.items.length });
    },
    summarizeResult: summarizeBatch('agent delete'),
  };

  // ── steward.configure ──
  const captureSteward = async (args = {}) => {
    const actions = actionsOrNull();
    if (!actions?.saveAgentConfiguration) return { error: { ok: false, reason: 'agent_config_unavailable' } };
    const context = currentContext();
    const scope = scopeOf(args.scope);
    if (scope === 'local' && !context.sessionId) return { error: { ok: false, reason: 'no_current_session' } };
    const saved = actions.getAgentConfiguration({ id: STEWARD_CONFIG_ID, scope, context });
    const current = saved?.config;
    if (!current) return { error: { ok: false, reason: 'steward_unavailable' } };
    const profiles = saved.profiles || [];
    const errors = [];
    const changes = [];
    const next = JSON.parse(JSON.stringify(current));
    if (args.enabled !== undefined && args.enabled !== current.enabled) {
      next.enabled = args.enabled;
      changes.push({ label: t('小管家'), meta: `${current.enabled ? t('开启') : t('关闭')} ⇒ ${args.enabled ? t('开启') : t('关闭')}` });
    }
    if (args.model) {
      const found = resolveNamedTarget(profiles, args.model.profile);
      if (found.error) errors.push({ label: t('共用模型'), reason: `model_profile_${found.error}`, candidates: found.candidates || profiles.slice(0, 12).map(p => ({ id: p.id, name: p.name })) });
      else if (found.item.id !== current.modelProfileId || current.modelMode !== 'profile') {
        next.modelMode = 'profile';
        next.modelProfileId = found.item.id;
        changes.push({ label: t('共用模型'), meta: `${modelLabel(current, profiles)} ⇒ ${found.item.name}` });
      }
    }
    (Array.isArray(args.tasks) ? args.tasks : []).forEach((task = {}) => {
      const definition = STEWARD_TASKS.find(item => item.id === task.id);
      if (!definition) return errors.push({ label: trim(task.id), reason: 'unknown_task' });
      const row = { ...(next.tasks?.[task.id] || {}) };
      const before = { ...row };
      if (task.enabled !== undefined) row.enabled = task.enabled;
      if (task.model) {
        if (task.model.mode === 'shared') row.modelProfileId = '';
        else {
          const found = resolveNamedTarget(profiles, task.model.profile);
          if (found.error) return errors.push({ label: t(definition.title), reason: `model_profile_${found.error}` });
          row.modelProfileId = found.item.id;
        }
      }
      if (task.targetLanguage !== undefined) {
        if (task.id !== 'translate_message') return errors.push({ label: t(definition.title), reason: 'field_not_supported' });
        row.targetLanguage = task.targetLanguage;
      }
      if (fingerprint(row) === fingerprint(before)) return undefined;
      next.tasks = { ...next.tasks, [task.id]: row };
      const parts = [];
      const switchLabel = value => (value ? t('开启') : t('关闭'));
      const taskModel = value => (value ? profileName(profiles, value) : t('共用模型'));
      const language = value => STEWARD_TRANSLATION_LANGUAGES.find(item => item.id === value)?.label || t('跟随界面语言');
      if (row.enabled !== before.enabled) parts.push(`${switchLabel(before.enabled)} ⇒ ${switchLabel(row.enabled)}`);
      if (row.modelProfileId !== before.modelProfileId) parts.push(t('模型：{model}', { model: `${taskModel(before.modelProfileId)} ⇒ ${taskModel(row.modelProfileId)}` }));
      if (row.targetLanguage !== before.targetLanguage) parts.push(t('翻译成：{language}', { language: `${language(before.targetLanguage)} ⇒ ${language(row.targetLanguage)}` }));
      changes.push({ label: t(definition.title), meta: parts.join(' · ') });
      return undefined;
    });
    let customTasks = normalizeStewardCustomTasks(next.customTasks);
    (Array.isArray(args.customTasks) ? args.customTasks : []).forEach((task = {}) => {
      const existing = trim(task.id) ? resolveNamedTarget(customTasks, task.id) : null;
      if (existing?.error) return errors.push({ label: trim(task.id), reason: existing.error, ...(existing.candidates ? { candidates: existing.candidates } : {}) });
      if (task.remove) {
        if (!existing) return errors.push({ label: trim(task.name), reason: 'missing_target' });
        customTasks = customTasks.filter(item => item.id !== existing.item.id);
        changes.push({ label: existing.item.name, meta: t('删除自定义任务') });
        return undefined;
      }
      const fields = ['name', 'input', 'recentCount', 'prompt', 'output', 'enabled'].filter(key => task[key] !== undefined);
      if (existing) {
        const updated = normalizeStewardCustomTasks([{ ...existing.item, ...Object.fromEntries(fields.map(key => [key, task[key]])) }])[0];
        if (fingerprint(updated) === fingerprint(existing.item)) return undefined;
        customTasks = customTasks.map(item => (item.id === existing.item.id ? updated : item));
        changes.push({ label: updated.name, meta: t('修改自定义任务') });
        return undefined;
      }
      if (!trim(task.prompt)) return errors.push({ label: trim(task.name) || t('自定义任务'), reason: 'prompt_required' });
      if (customTasks.length >= STEWARD_CUSTOM_TASK_LIMIT) return errors.push({ label: trim(task.name), reason: 'custom_task_limit' });
      const created = normalizeStewardCustomTasks([{ id: createStewardCustomTaskId(), ...Object.fromEntries(fields.map(key => [key, task[key]])) }])[0];
      customTasks = [...customTasks, created];
      changes.push({ label: created.name, meta: t('新建自定义任务') });
      return undefined;
    });
    next.customTasks = customTasks;
    const config = normalizeAgentConfiguration(next, STEWARD_CONFIG_ID);
    const invalid = !errors.length && changes.length ? validateAgentConfiguration(config, { place: context.place }) : '';
    if (invalid) errors.push({ label: t('小管家'), reason: 'invalid_configuration', message: t(invalid) });
    return { context, scope, profiles, saved, config, changes, errors, plannedCount: errors.length ? 0 : changes.length };
  };

  const stewardResult = (snap, extra = {}) => ({
    scope: snap.scope, scopeLabel: scopeLabel(snap.scope, snap.context.place),
    changes: snap.changes, ...(snap.errors.length ? { errors: snap.errors } : {}), ...extra,
  });

  const stewardTool = {
    name: 'steward.configure',
    title: 'Configure the steward',
    description: `Configure the steward (小管家, small-model helper tasks): enabled, the shared model (model.profile, required to turn it on), each task (tasks[].id: ${STEWARD_TASKS.map(task => task.id).join(', ')}; enabled, model {mode:"shared"} or {mode:"profile", profile}, targetLanguage for translate_message: "" follows the APP language, or ${STEWARD_TRANSLATION_LANGUAGES.map(item => item.id).join('/')}) and custom tasks (customTasks[]: id or name of an existing task to update, remove:true to delete; new tasks need name and prompt; input ${STEWARD_CUSTOM_INPUTS.join('/')}, output ${STEWARD_CUSTOM_OUTPUTS.join('/')}, at most ${STEWARD_CUSTOM_TASK_LIMIT}). Read the current state with agent.list first. Nothing is saved when any requested change is invalid.`,
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['local', 'global'] },
        enabled: { type: 'boolean' },
        model: { type: 'object', additionalProperties: false, required: ['profile'], properties: { profile: { type: 'string', minLength: 1, maxLength: 200 } } },
        tasks: {
          type: 'array', maxItems: STEWARD_TASKS.length,
          items: {
            type: 'object', additionalProperties: false, required: ['id'],
            properties: {
              id: { type: 'string', enum: STEWARD_TASKS.map(task => task.id) },
              enabled: { type: 'boolean' },
              model: {
                type: 'object', additionalProperties: false, required: ['mode'],
                properties: { mode: { type: 'string', enum: ['shared', 'profile'] }, profile: { type: 'string', maxLength: 200 } },
              },
              targetLanguage: { type: 'string', enum: ['', ...STEWARD_TRANSLATION_LANGUAGES.map(item => item.id)] },
            },
          },
        },
        customTasks: {
          type: 'array', maxItems: STEWARD_CUSTOM_TASK_LIMIT,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', maxLength: 80 },
              remove: { type: 'boolean' },
              name: { type: 'string', maxLength: 24 },
              input: { type: 'string', enum: STEWARD_CUSTOM_INPUTS },
              recentCount: { type: 'integer', minimum: 2, maximum: 30 },
              prompt: { type: 'string', maxLength: 4000 },
              output: { type: 'string', enum: STEWARD_CUSTOM_OUTPUTS },
              enabled: { type: 'boolean' },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_agent_config', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureSteward(args, context);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'steward.configure', operationType: 'write_agent_config', danger: false,
          title: t('设定小管家'),
          message: t('将修改{scope}的小管家设定（{count} 项）。', { scope: scopeLabel(snap.scope, snap.context.place), count: snap.plannedCount }),
          confirmText: t('保存'),
          items: snap.changes.map((change, index) => ({ id: `steward_${index}`, label: change.label, status: 'planned', meta: change.meta })),
          denyReason: 'steward_configure_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureSteward(args, context);
      if (snap.error) return snap.error;
      if (snap.errors.length) return { ok: false, reason: 'invalid_request', ...stewardResult(snap) };
      if (!snap.changes.length) return { ok: true, skipped: true, reason: 'no_change', ...stewardResult(snap) };
      if (!isAllowed(context, 'steward.configure')) return { ok: false, reason: 'confirmation_required' };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted', ...stewardResult(snap) };
      const actions = actionsOrNull();
      const saved = await actions.saveAgentConfiguration({ id: STEWARD_CONFIG_ID, scope: snap.scope, context: snap.context, revision: snap.saved.revision, config: snap.config });
      if (!saved?.ok) return { ok: false, ...saveFailure(saved), ...stewardResult(snap) };
      const after = actions.getAgentConfiguration({ id: STEWARD_CONFIG_ID, scope: snap.scope, context: snap.context })?.config;
      const keys = ['enabled', 'modelMode', 'modelProfileId', 'tasks', 'customTasks'];
      const ok = Boolean(after) && keys.every(key => fingerprint(after[key]) === fingerprint(snap.config[key]));
      return ok
        ? { ok: true, ...stewardResult(snap) }
        : { ok: false, reason: 'verification_failed', ...stewardResult(snap) };
    },
    summarizeResult: result => (result?.ok
      ? (result.skipped ? 'steward unchanged' : `steward configured; ${Number(result.changes?.length || 0)} change(s)`)
      : `steward configure failed: ${trim(result?.reason)}`),
  };

  return [
    {
      name: 'agent.list',
      title: 'List Agents',
      description: 'List the Agents in Agent Center for the current chat or creative-writing card: reply Agents (e.g. 正文润色, run after replies), input assistants, the built-in format repair and text suggestion, the recap Agent and the steward with its tasks. Shows enabled state, auto/manual invocation, model, where each is defined (local/global) and the model profiles that can be chosen. agent = id or exact title returns one Agent with its full prompt. scope global lists the settings shared by all chats (or all creative writing).',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['local', 'global'] },
          agent: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      execute: listAgents,
      summarizeResult: result => (result?.ok
        ? (result.agent ? `read agent ${trim(result.agent.title)}` : `listed ${Number(result.agents?.length || 0)} agent(s)`)
        : `agent list failed: ${trim(result?.reason)}`),
    },
    agentUpsertTool,
    agentDeleteTool,
    stewardTool,
  ];
};

export const registerAgentConfigAgentTools = (registry, deps = {}) => registry.registerMany(createAgentConfigAgentTools(deps));
