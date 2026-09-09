// Generation controls have one editing home in Preset. Match semantic paths even
// when a profile supplies a different protocol spelling or an entire object.
import { getReasoningCapability } from './model-capabilities.js';
const fields = {
  temperature: ['temperature', 'temp_openai', 'generationConfig.temperature'],
  top_p: ['top_p', 'topP', 'top_p_openai', 'generationConfig.topP', 'generationConfig.top_p'],
  top_k: ['top_k', 'topK', 'generationConfig.topK', 'generationConfig.top_k'],
  max_output_tokens: ['maxTokens', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens', 'openai_max_tokens', 'generationConfig.maxOutputTokens'],
  max_context: ['max_context', 'openai_max_context'],
  presence_penalty: ['presence_penalty', 'presencePenalty', 'generationConfig.presencePenalty'],
  frequency_penalty: ['frequency_penalty', 'frequencyPenalty', 'generationConfig.frequencyPenalty'],
  reasoning: ['request_reasoning', 'reasoning_effort', 'reasoningEffort',
    'reasoning.effort', 'reasoning.enabled', 'reasoning.max_tokens',
    'thinking.type', 'thinking.budget_tokens', 'output_config.effort',
    'thinkingBudget', 'thinkingLevel', 'thinkingConfig.thinkingBudget', 'thinkingConfig.thinkingLevel',
    'generationConfig.thinkingConfig.thinkingBudget', 'generationConfig.thinkingConfig.thinkingLevel'],
};
const entries = Object.entries(fields).flatMap(([field, paths]) => paths.map(path => ({ field, path })));
const within = (name, path) => name === path || name.startsWith(path + '.');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const editableEntries = config => {
  if (!config) return entries;
  const capability = getReasoningCapability(config);
  return capability.supported && capability.requestControl ? entries : entries.filter(entry => entry.field !== 'reasoning');
};
export const getPresetRequestParamField = (name, { config } = {}) => editableEntries(config).find(entry => within(String(name || ''), entry.path))?.field || '';

export const partitionPresetRequestParam = (row, { config } = {}) => {
  const blocked = [];
  const available = editableEntries(config);
  const visit = (name, value) => {
    const direct = available.find(entry => within(name, entry.path))?.field;
    if (direct) { blocked.push({ path: name, field: direct }); return { hasValue: false }; }
    const descendants = available.filter(entry => within(entry.path, name));
    if (!descendants.length) return { hasValue: true, value };
    // A scalar/array at a managed container would erase its preset-owned leaves.
    if (!plain(value)) {
      blocked.push(...descendants.map(entry => ({ path: name, field: entry.field })));
      return { hasValue: false };
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const next = visit(name + '.' + key, item);
      if (next.hasValue) result[key] = next.value;
    }
    return { value: result, hasValue: Object.keys(result).length > 0 || Object.keys(value).length === 0 };
  };
  const result = visit(String(row?.name || '').trim(), row?.value);
  return { ...result, blocked, status: blocked.length ? (result.hasValue ? 'partially_preset' : 'preset') : '' };
};

export const getPresetNativeParamPaths = (field, protocol) => {
  if (field === 'max_context') return [];
  if (field === 'reasoning') return protocol === 'gemini'
    ? ['generationConfig.thinkingConfig.thinkingBudget', 'generationConfig.thinkingConfig.thinkingLevel']
    : protocol === 'responses' ? ['reasoning.effort']
      : protocol === 'anthropic' ? ['thinking.type', 'thinking.budget_tokens', 'output_config.effort']
        : ['reasoning_effort', 'reasoning.effort', 'reasoning.enabled', 'reasoning.max_tokens', 'thinking.type', 'thinking.budget_tokens', 'output_config.effort'];
  if (field === 'max_output_tokens') return protocol === 'gemini' ? ['generationConfig.maxOutputTokens']
    : protocol === 'responses' ? ['max_output_tokens'] : protocol === 'anthropic' ? ['max_tokens'] : ['max_tokens', 'max_completion_tokens'];
  return protocol === 'gemini' ? [{ temperature: 'generationConfig.temperature', top_p: 'generationConfig.topP', top_k: 'generationConfig.topK',
    presence_penalty: 'generationConfig.presencePenalty', frequency_penalty: 'generationConfig.frequencyPenalty' }[field]].filter(Boolean) : [field];
};
