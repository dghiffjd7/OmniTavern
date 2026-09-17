import { getAgentInvocationMode, isInputAgent } from '../agent/agent-invocation.js';
import { agentConfigScopeKey } from '../storage/agent-config-store.js';

const ids = value => [...new Set((Array.isArray(value) ? value : []).filter(id => typeof id === 'string'))].slice(0, 64);
export const isAgentToolToggle = config => isInputAgent(config) && (config.id === 'text_completion' || config.inputOutput === 'suggestion') && getAgentInvocationMode(config) !== 'manual';
export const normalizeToolboxPreferences = (value = {}) => ({
  version: 2, order: ids(value.order), pinned: ids(value.pinned), shortcut: value.shortcut?.code ? value.shortcut : null,
  legendDismissed: value.legendDismissed === true,
  scopes: Object.fromEntries(Object.entries(value.scopes || {}).slice(-80).map(([key, scope]) => [key, { visible: ids(scope?.visible), hidden: ids(scope?.hidden) }])),
});
export const reconcileToolboxPreferences = (prefs, configs, context) => {
  const key = agentConfigScopeKey(context), known = new Set(configs.map(config => config.id));
  const current = prefs.scopes[key] || { visible: prefs.pinned.filter(id => known.has(id)), hidden: [] };
  // The built-in input switch must be discoverable before it is turned on.
  const visible = ids([...current.visible, ...configs.filter(config => config.enabled || config.id === 'text_completion').map(config => config.id)])
    .filter(id => known.has(id) && !current.hidden.includes(id));
  const scopes = { ...prefs.scopes, [key]: { visible, hidden: current.hidden } };
  return { ...prefs, scopes: Object.fromEntries(Object.entries(scopes).slice(-80)) };
};
export const getToolboxItems = (prefs, configs, context) => {
  const visible = prefs.scopes[agentConfigScopeKey(context)]?.visible || [];
  const order = ids([...prefs.order, ...prefs.pinned, ...visible]);
  return configs.filter(config => visible.includes(config.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
};
export const setToolboxItemVisible = (prefs, id, visible, context) => {
  const key = agentConfigScopeKey(context), scope = prefs.scopes[key] || { visible: [], hidden: [] };
  return { ...prefs, scopes: { ...prefs.scopes, [key]: {
    visible: visible ? ids([...scope.visible, id]) : scope.visible.filter(value => value !== id),
    hidden: visible ? scope.hidden.filter(value => value !== id) : ids([...scope.hidden, id]),
  } } };
};
// 32px faces in adjacent 44px hit areas; reserve settings and, if needed, more.
export const toolboxVisibleCount = (width, count) => {
  const slots = Math.max(2, Math.floor(width / 44));
  return Math.min(count, Math.max(0, slots - 1 - (count > slots - 1 ? 1 : 0)));
};
