// 独立 Agent 的完整配置；旧功能设置只读回退，显式保存才建立作用域覆盖。
import { getAgentInvocationMode } from '../agent/agent-invocation.js';
import { normalizeAgentReferenceConfig } from '../agent/agent-reference-context.js';
import { normalizeAgentIcon } from '../agent/agent-icons.js';
import { normalizeAgentGenerationSettings } from '../agent/agent-generation-settings.js';
import { normalizeFormatRepairProfiles, mergeFormatRepairProfiles, diffFormatRepairProfiles, resolveFormatRepairProfile, formatRepairProfileTooLong } from '../agent/format-repair-profiles.js';
export const AGENT_CONFIG_KEY = 'agent_config_library_v1';
export const CONFIGURABLE_AGENT_IDS = ['text_completion', 'reply_check', 'archive_naming', 'reply_scoring'];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
export const BODY_SELECTOR_ID = 'body-selector';
const storedId = id => id === BODY_SELECTOR_ID || isConfigurableAgent(id);
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = value => String(value ?? '').trim();
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(value)) || fallback));
export const isConfigurableAgent = id => CONFIGURABLE_AGENT_IDS.includes(id) || /^(text-edit|input-agent):[a-zA-Z0-9_-]+$/.test(id || '');
export const createTextAgentId = () => `text-edit:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const createInputAgentId = () => createTextAgentId().replace('text-edit:', 'input-agent:');
export const normalizeAgentConfigContext = (context = {}) => ({
  place: context.place === 'writing' ? 'writing' : 'chat',
  sessionId: text(context.sessionId), scopeId: text(context.scopeId),
});
export const agentConfigScopeKey = (context = {}, scope = 'local') => {
  const c = normalizeAgentConfigContext(context);
  return JSON.stringify(scope === 'global' ? [c.place, 'global']
    : c.place === 'writing' ? [c.place, 'card', c.sessionId] : [c.place, 'chat', c.scopeId, c.sessionId]);
};
export const normalizeAgentConfiguration = (value = {}, id = value.id) => ({
  id: text(id), kind: ['archive_naming', 'reply_scoring'].includes(id) ? id : id === 'text_completion' ? 'input_suggestion' : String(id).startsWith('input-agent:') ? 'input_agent' : id === 'reply_check' ? 'format_review' : 'text_edit',
  title: text(value.title).slice(0, 80) || ({ archive_naming: '小管家', reply_scoring: '正文评分' }[id] || (id === 'text_completion' ? '文本建议' : String(id).startsWith('input-agent:') ? '输入助手' : id === 'reply_check' ? '格式修复' : '正文润色')),
  icon: normalizeAgentIcon(value.icon),
  enabled: value.enabled === true,
  modelMode: ['none', 'profile', 'follow_current'].includes(value.modelMode) ? value.modelMode : 'none',
  modelProfileId: text(value.modelProfileId), modelOverride: text(value.modelOverride),
  invocationMode: getAgentInvocationMode({ ...value, id }),
  triggerMode: getAgentInvocationMode({ ...value, id }) === 'manual' ? 'manual' : 'auto',
  inputOutput: id === 'text_completion' ? 'suggestion' : ['suggestion', 'rewrite', 'note'].includes(value.inputOutput) ? value.inputOutput : 'note',
  prompt: String(value.prompt ?? ''), formatGuide: String(value.formatGuide ?? ''),
  ...(CONFIGURABLE_AGENT_IDS.includes(id) ? { taskPromptMode: value.taskPromptMode === 'replace' ? 'replace' : 'append' } : {}),
  blocks: (Array.isArray(value.blocks) ? value.blocks : []).slice(0, 12).map((block, index) => ({
    id: text(block.id) || `block-${index}`, name: text(block.name), text: String(block.text ?? ''),
    role: block.role === 'user' ? 'user' : 'system', enabled: block.enabled !== false,
  })),
  context: normalizeAgentReferenceConfig(value.context ?? (id === 'text_completion'
    ? { history: { enabled: true, unit: 'messages', count: 1, includeTarget: false } } : undefined)),
  outputMode: value.outputMode === 'note' ? 'note' : 'edit',
  tools: { enabled: value.tools?.enabled === true && /^(text-edit|input-agent):/.test(String(id)),
    ids: [...new Set((Array.isArray(value.tools?.ids) ? value.tools.ids : []).map(text).filter(Boolean))].slice(0, 12),
    maxRounds: integer(value.tools?.maxRounds, 4, 1, 8) },
  target: { mode: ['rendered', 'body', 'full', 'tags', 'regex'].includes(value.target?.mode) ? value.target.mode : 'body',
    start: String(value.target?.start ?? ''), end: String(value.target?.end ?? ''),
    pattern: String(value.target?.pattern ?? ''), flags: text(value.target?.flags), group: integer(value.target?.group, 1, 1, 20) },
  inputConsent: value.inputConsent === true,
  ...normalizeAgentGenerationSettings(value, id),
  ...(['archive_naming', 'reply_scoring'].includes(id) ? {
    invocationMode: id === 'archive_naming' ? 'auto' : 'manual', triggerMode: id === 'archive_naming' ? 'auto' : 'manual',
    ...normalizeAgentGenerationSettings({ reasoningMode: 'off', maxTokens: id === 'archive_naming' ? 128 : 4096, timeoutSeconds: 60, ...value }, id),
    scoreThreshold: value.scoreThreshold == null || !Number.isFinite(Number(value.scoreThreshold)) ? .6 : Math.min(1, Math.max(0, Number(value.scoreThreshold))),
  } : {}),
  updatedAt: Number(value.updatedAt) || 0,
  ...(id === 'reply_check' ? { repairProfiles: normalizeFormatRepairProfiles(value.repairProfiles, value), repairCheckType: value.repairCheckType === 'tableEdit' ? 'tableEdit' : 'custom' } : {}),
});
const normalizeState = raw => {
  const scopes = {};
  if (plain(raw?.scopes)) for (const [key, entries] of Object.entries(raw.scopes)) {
    if (!plain(entries)) continue;
    scopes[key] = {};
    for (const [id, entry] of Object.entries(entries)) if (storedId(id) && plain(entry)) {
      scopes[key][id] = { updatedAt: Number(entry.updatedAt) || 0,
        ...(entry.deleted === true ? { deleted: true } : entry.follow === true ? { follow: true }
          : { config: normalizeAgentConfiguration(entry.config || {}, id) }) };
    }
  }
  return { version: 1, updatedAt: Number(raw?.updatedAt) || 0, scopes };
};
export const createAgentConfigStore = ({ storage = globalThis.localStorage, loadKv, saveKv,
  getLegacy = () => null, onChange = () => {}, now = Date.now, logger = console } = {}) => {
  let state;
  try { state = normalizeState(JSON.parse(storage?.getItem?.(AGENT_CONFIG_KEY) || '{}')); } catch { state = normalizeState({}); }
  let chain = Promise.resolve();
  const hydrate = async () => {
    if (!loadKv) return;
    try { const raw = await loadKv(AGENT_CONFIG_KEY); if (plain(raw) && Number(raw.updatedAt || 0) >= state.updatedAt) state = normalizeState(raw); }
    catch (error) { logger?.debug?.('agent config hydrate failed', error); }
  };
  const read = (id, context, scope = 'effective') => {
    const c = normalizeAgentConfigContext(context), globalKey = agentConfigScopeKey(c, 'global'), localKey = agentConfigScopeKey(c);
    const local = scope === 'global' ? null : state.scopes[localKey]?.[id];
    const shared = state.scopes[globalKey]?.[id];
    const legacy = getLegacy(id, c, { includeLocal: scope !== 'global' && !local?.follow }) || null;
    let entry = local?.follow ? shared : local || shared;
    const source = entry ? (entry === local ? 'local' : 'global') : legacy ? 'legacy' : 'default';
    const config = entry?.deleted ? null : entry?.config || (legacy || (CONFIGURABLE_AGENT_IDS.includes(id) ? {} : null));
    let normalized = config ? clone(normalizeAgentConfiguration(config, id)) : null;
    let repairProfileSources, repairGlobalProfileIds;
    if (id === 'reply_check' && normalized) {
      const globalConfig = shared?.config || getLegacy(id, c, { includeLocal: false }) || {};
      const globalLibrary = normalizeFormatRepairProfiles(globalConfig.repairProfiles, globalConfig);
      repairGlobalProfileIds = globalLibrary.items.map(item => item.id);
      const localLibrary = normalized.repairProfiles;
      normalized.repairProfiles = local && local === entry ? mergeFormatRepairProfiles(globalLibrary, localLibrary) : localLibrary;
      repairProfileSources = Object.fromEntries(normalized.repairProfiles.items.map(item => [item.id,
        local && local === entry && (!localLibrary.partial || localLibrary.items.some(row => row.id === item.id)) ? 'local'
          : local && local === entry ? shared?.config ? 'global' : 'legacy' : source]));
      normalized = resolveFormatRepairProfile(normalized);
    }
    return { id, context: c, scope: scope === 'global' ? 'global' : 'local', source,
      revision: JSON.stringify([local || null, shared || null, legacy]),
      inherited: scope !== 'global' && source !== 'local', config: normalized, ...(repairProfileSources ? { repairProfileSources, repairGlobalProfileIds } : {}) };
  };
  const list = (context, scope = 'effective') => {
    const global = state.scopes[agentConfigScopeKey(context, 'global')] || {};
    const local = scope === 'global' ? {} : state.scopes[agentConfigScopeKey(context)] || {};
    return [...new Set([...CONFIGURABLE_AGENT_IDS, ...Object.keys(global), ...Object.keys(local)])]
      .filter(isConfigurableAgent).map(id => read(id, context, scope)).filter(item => item.config);
  };
  const commit = (options, makeEntry) => {
    const context = normalizeAgentConfigContext(options.context), scope = options.scope === 'global' ? 'global' : 'local';
    const id = text(options.id), key = agentConfigScopeKey(context, scope);
    const job = chain.then(async () => {
      if (!storedId(id) || (scope === 'local' && !context.sessionId)) return { ok: false, reason: 'invalid_context' };
      const current = read(id, context, scope);
      if (options.revision !== undefined && options.revision !== current.revision) return { ok: false, reason: 'config_changed' };
      const timestamp = Math.max(now(), state.updatedAt + 1);
      const entry = makeEntry(timestamp, current);
      if (entry?.error) return { ok: false, reason: entry.error };
      const entries = { ...(state.scopes[key] || {}) };
      if (entry) entries[id] = entry; else delete entries[id];
      if (options.bodyRule) {
        if (options.bodyRevision !== read(BODY_SELECTOR_ID, context, scope).revision) return { ok: false, reason: 'config_changed' };
        entries[BODY_SELECTOR_ID] = { updatedAt: timestamp, config: normalizeAgentConfiguration({ target: options.bodyRule }, BODY_SELECTOR_ID) };
      }
      if (Object.keys(entries).length > 66) return { ok: false, reason: 'agent_limit' };
      const next = { ...state, updatedAt: timestamp, scopes: { ...state.scopes, [key]: entries } };
      // A newly shared Agent also joins every local scope that inherits it. Check
      // the combined count so a valid default workflow always fits its 8 houses.
      const globalKey = agentConfigScopeKey(context, 'global');
      const affectedKeys = scope === 'global'
        ? [...new Set([globalKey, ...Object.keys(next.scopes).filter(k => { try { return JSON.parse(k)[0] === context.place; } catch { return false; } })])]
        : [key];
      const count = (snapshot, localKey, prefix) => {
        const shared = snapshot.scopes[globalKey] || {}, local = localKey === globalKey ? {} : snapshot.scopes[localKey] || {};
        return [...new Set([...Object.keys(shared), ...Object.keys(local)])].filter(agentId => {
          const item = local[agentId]?.follow ? shared[agentId] : local[agentId] || shared[agentId];
          return agentId.startsWith(prefix) && item?.config && !item.deleted;
        }).length;
      };
      for (const prefix of ['text-edit:', 'input-agent:']) if (affectedKeys.some(k => count(next, k, prefix) > 8 && count(next, k, prefix) > count(state, k, prefix))) return { ok: false, reason: 'agent_limit', message: '配置合并后每类最多 8 个自定义 Agent，请先移除其他 Agent' };
      try {
        if (saveKv && await saveKv(AGENT_CONFIG_KEY, clone(next)) === false) throw new Error('save rejected');
        if (!saveKv && !storage?.setItem) throw new Error('storage unavailable');
        try { storage?.setItem?.(AGENT_CONFIG_KEY, JSON.stringify(next)); } catch (error) { if (!saveKv) throw error; }
      } catch (error) { logger?.warn?.('agent config save failed', error); return { ok: false, reason: 'save_failed' }; }
      state = next;
      onChange({ id, context, scope });
      return { ok: true, ...read(id, context, scope) };
    });
    chain = job.catch(() => {}); return job;
  };
  return {
    hydrate, read, list,
    save: options => commit(options, timestamp => {
      const config = normalizeAgentConfiguration(options.config, options.id);
      if (formatRepairProfileTooLong(config)) return { error: 'prompt_too_long' };
      if (options.id === 'reply_check') {
        if (config.repairProfiles.items.length > 100) return { error: 'profile_limit' };
        // Legacy callers update the automatic profile's visible fields. Profile
        // editors supply the entire library and keep that projection consistent.
        const automatic = config.repairProfiles.items.find(item => item.id === config.repairProfiles.automaticId);
        if (automatic) automatic.config = normalizeFormatRepairProfiles(null, config).items[0].config;
        if (options.scope !== 'global') config.repairProfiles = diffFormatRepairProfiles(config.repairProfiles,
          read('reply_check', options.context, 'global').config.repairProfiles);
      }
      return { updatedAt: timestamp, config: { ...config, updatedAt: timestamp } };
    }),
    reset: options => commit(options, timestamp => options.scope === 'global' ? null : { follow: true, updatedAt: timestamp }),
    remove: options => commit(options, timestamp => CONFIGURABLE_AGENT_IDS.includes(options.id)
      ? { error: 'builtin_agent' } : { deleted: true, updatedAt: timestamp }),
    exportState: () => clone(state),
  };
};
