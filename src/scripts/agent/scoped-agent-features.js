import { CONFIGURABLE_AGENT_IDS } from '../storage/agent-config-store.js';

// Compatibility facade: unrelated legacy features keep their original storage.
export const createScopedAgentFeatures = ({ legacy, store, getContext }) => {
  const settings = sessionId => {
    const result = legacy.getSettings(), context = getContext(sessionId);
    for (const id of CONFIGURABLE_AGENT_IDS) result.features[id] = store.read(id, context).config;
    return result;
  };
  const update = async (id, patch, fallback) => {
    if (!CONFIGURABLE_AGENT_IDS.includes(id)) return fallback();
    const context = getContext(), current = store.read(id, context);
    const result = await store.save({ id, context, scope: 'local', revision: current.revision, config: { ...current.config, ...patch } });
    if (!result.ok) throw new Error(result.reason === 'config_changed' ? '配置已变化，请重新打开' : '配置保存失败');
    return settings();
  };
  return { ...legacy, getSettings: settings,
    listFeatures: () => legacy.listFeatures().map(item => ({ ...item, state: settings().features[item.id], enabled: settings().features[item.id]?.enabled === true })),
    isEnabled: (id, sid) => settings(sid).features[id]?.enabled === true,
    setEnabled: (id, enabled, opts) => update(id, { enabled: enabled === true, ...(id === 'text_completion' && enabled ? { inputConsent: true } : {}) }, () => legacy.setEnabled(id, enabled, opts)),
    setModel: (id, opts, meta) => update(id, Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined)), () => legacy.setModel(id, opts, meta)),
    setTriggerMode: (id, triggerMode, meta) => update(id, { triggerMode, invocationMode: triggerMode === 'manual' ? 'manual' : 'both' }, () => legacy.setTriggerMode(id, triggerMode, meta)),
  };
};
