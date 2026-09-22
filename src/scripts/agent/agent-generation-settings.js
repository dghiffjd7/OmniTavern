import { buildReasoningRequestOptions, getReasoningCapability, getReasoningSamplerPolicy, normalizeReasoningEffort } from '../api/model-capabilities.js';

const suggestion = config => config.id === 'text_completion' || config.kind === 'input_suggestion';
const inputAgent = config => String(config.id || '').startsWith('input-agent:') || config.kind === 'input_agent';
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(value)) || fallback));

// Agent generation settings belong to its scoped configuration, never a preset.
// Missing fields preserve the former budgets/timeouts and short autocomplete policy.
export const normalizeAgentGenerationSettings = (value = {}, id = value.id) => {
  const config = { ...value, id };
  const reasoningMode = ['default', 'off', 'on'].includes(value.reasoningMode) ? value.reasoningMode : suggestion(config) ? 'off' : 'default';
  const thinking = reasoningMode === 'on';
  const defaultTokens = suggestion(config) ? 96 : inputAgent(config) ? 1200 : 6000;
  const defaultTimeout = suggestion(config) ? 12 : inputAgent(config) && !config.tools?.enabled ? 30 : id === 'reply_check' ? 60 : 120;
  return {
    reasoningMode, reasoningEffort: normalizeReasoningEffort(value.reasoningEffort, 'auto'),
    maxTokens: bounded(value.maxTokens, thinking ? Math.max(4096, defaultTokens) : defaultTokens, thinking ? 2048 : 16, 16000),
    timeoutSeconds: bounded(value.timeoutSeconds, thinking ? Math.max(60, defaultTimeout) : defaultTimeout, 5, 300),
  };
};

export const changeAgentReasoningMode = (config, mode) => normalizeAgentGenerationSettings({ ...config, reasoningMode: mode,
  ...(mode === 'on' ? {
    maxTokens: Number(config.maxTokens) < 2048 ? 4096 : config.maxTokens,
    timeoutSeconds: Number(config.timeoutSeconds) < 60 ? 60 : config.timeoutSeconds,
  } : {}),
});

// The optional fallback preserves injected timers in runtimes with legacy callers.
export const agentRequestTimeoutMs = (config = {}, fallback) => config.timeoutSeconds == null && fallback != null
  ? fallback : normalizeAgentGenerationSettings(config).timeoutSeconds * 1000;

export const getAgentReasoningControl = model => {
  const capability = getReasoningCapability(model);
  const effortOptions = [{ value: 'auto', label: '自动' }, ...capability.effortOptions.filter(item => item.value !== 'auto')];
  return { ...capability, effortOptions,
    // Only offer a guaranteed shutdown where our existing provider mapping sends one.
    canDisable: capability.strategy === 'deepseek-thinking',
  };
};

export const buildAgentGenerationOptions = (params = {}, model = {}, config = {}) => {
  const settings = normalizeAgentGenerationSettings(config);
  const maxTokens = config.maxTokens == null && config.reasoningMode !== 'on'
    ? (params.maxTokens ?? params.max_tokens ?? settings.maxTokens) : settings.maxTokens;
  const options = { ...params, maxTokens };
  const capability = getReasoningCapability(model);
  const effort = capability.effortOptions.some(item => item.value === settings.reasoningEffort) ? settings.reasoningEffort : 'auto';
  if (settings.reasoningMode !== 'default') {
    for (const key of ['thinking', 'reasoning_effort', 'reasoning', 'thinkingBudget', 'thinkingLevel', 'output_config']) delete options[key];
    if (settings.reasoningMode === 'on') {
      // Built-in presets use the same provider mapping, but no preset state is read.
      Object.assign(options, buildReasoningRequestOptions({ ...model, requestReasoning: true,
        reasoningEffort: capability.strategy === 'anthropic-budget' && effort === 'auto' ? 'high' : effort, maxOutputTokens: maxTokens }));
    } else if (capability.strategy === 'deepseek-thinking') options.thinking = { type: 'disabled' };
  }
  const policy = getReasoningSamplerPolicy({ ...model, requestReasoning: settings.reasoningMode === 'on' });
  for (const key of policy.disabledFields) delete options[key];
  return options;
};
