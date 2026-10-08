import { buildReasoningRequestOptions, getReasoningCapability, getReasoningSamplerPolicy, normalizeReasoningEffort } from '../api/model-capabilities.js';

const suggestion = config => config.id === 'text_completion' || config.kind === 'input_suggestion';
const inputAgent = config => String(config.id || '').startsWith('input-agent:') || config.kind === 'input_agent';
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(value)) || fallback));

// 与 API 配置「请求超时」的范围一致（10–9000 秒），Agent 自定义值不得另设更窄的上限。
export const AGENT_TIMEOUT_MAX_SECONDS = 9000;
export const AGENT_SUGGESTION_TIMEOUT_SECONDS = 12;
// 旧版本为每类 Agent 填的默认等待时间；未经用户改动的旧值迁移为「跟随模型配置」。
const legacyTimeoutDefaults = config => {
  const base = suggestion(config) ? 12 : inputAgent(config) && !config.tools?.enabled ? 30 : ['reply_check', 'archive_naming'].includes(config.id) ? 60 : 120;
  return [base, Math.max(60, base)];
};

// Agent generation settings belong to its scoped configuration, never a preset.
// 超时：默认跟随所用模型配置的请求超时（timeoutSeconds 为 null）；只有用户自定义时才优先于 API 配置。
// 文本建议例外：补全晚到即失效，默认自定义 12 秒。
export const normalizeAgentGenerationSettings = (value = {}, id = value.id) => {
  const config = { ...value, id };
  const reasoningMode = ['default', 'off', 'on'].includes(value.reasoningMode) ? value.reasoningMode : suggestion(config) ? 'off' : 'default';
  const thinking = reasoningMode === 'on';
  const defaultTokens = suggestion(config) ? 96 : inputAgent(config) ? 1200 : 6000;
  const seconds = Math.trunc(Number(value.timeoutSeconds));
  const hasSeconds = value.timeoutSeconds != null && value.timeoutSeconds !== '' && Number.isFinite(seconds) && seconds > 0;
  const custom = value.timeoutMode === 'custom' ? hasSeconds || suggestion(config)
    : value.timeoutMode === 'follow' ? false
      : hasSeconds ? suggestion(config) || !legacyTimeoutDefaults(config).includes(seconds) : suggestion(config);
  return {
    reasoningMode, reasoningEffort: normalizeReasoningEffort(value.reasoningEffort, 'auto'),
    maxTokens: bounded(value.maxTokens, thinking ? Math.max(4096, defaultTokens) : defaultTokens, thinking ? 2048 : 16, 16000),
    timeoutMode: custom ? 'custom' : 'follow',
    timeoutSeconds: custom ? bounded(hasSeconds ? seconds : AGENT_SUGGESTION_TIMEOUT_SECONDS, AGENT_SUGGESTION_TIMEOUT_SECONDS, 5, AGENT_TIMEOUT_MAX_SECONDS) : null,
  };
};

export const changeAgentReasoningMode = (config, mode) => normalizeAgentGenerationSettings({ ...config, reasoningMode: mode,
  ...(mode === 'on' ? {
    maxTokens: Number(config.maxTokens) < 2048 ? 4096 : config.maxTokens,
    ...(config.timeoutMode === 'custom' && Number(config.timeoutSeconds) < 60 ? { timeoutSeconds: 60 } : {}),
  } : {}),
});

// 自定义超时的毫秒数；跟随模型配置时返回 null，由模型配置自身的请求超时决定，不再另起计时器。
export const agentRequestTimeoutMs = (config = {}) => {
  const settings = normalizeAgentGenerationSettings(config);
  return settings.timeoutMode === 'custom' ? settings.timeoutSeconds * 1000 : null;
};
// 把 Agent 的自定义超时套到捕获的模型配置上；跟随时保留模型配置自己的 timeout。
export const applyAgentTimeout = (model = {}, config = {}) => {
  const ms = agentRequestTimeoutMs(config);
  return ms ? { ...model, timeout: ms } : model;
};

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
