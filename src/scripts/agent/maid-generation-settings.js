import { buildAgentGenerationOptions } from './agent-generation-settings.js';
import { normalizeReasoningEffort } from '../api/model-capabilities.js';

/* 女仆的思考设置：与预设参数独立，沿用 Agent 的思考映射（按模型把强度换成对应服务商参数）。
   默认不开思考：规划/ReAct 输出是小 JSON，思考只增加延迟与消耗；能关闭思考的模型（如 DeepSeek）会显式关闭，
   其他模型不额外请求、沿用模型自身行为。 */
export const MAID_REASONING_MODES = Object.freeze(['off', 'on', 'default']);

export const normalizeMaidGenerationSettings = (value = {}) => {
  const src = value && typeof value === 'object' ? value : {};
  return {
    reasoningMode: MAID_REASONING_MODES.includes(src.reasoningMode) ? src.reasoningMode : 'off',
    reasoningEffort: normalizeReasoningEffort(src.reasoningEffort, 'low'),
  };
};

const REASONING_OPTION_KEYS = ['thinking', 'reasoning_effort', 'reasoning', 'thinkingBudget', 'thinkingLevel', 'output_config'];

// 为某个模型的一次调用套用女仆思考设置；输出上限沿用调用方给的值。没有设置时原样返回。
export const buildMaidGenerationOptions = (params = {}, model = {}, settings = null) => {
  if (!settings) return params;
  const normalized = normalizeMaidGenerationSettings(settings);
  if (normalized.reasoningMode === 'default') return params;
  const maxTokens = params.maxTokens ?? params.max_tokens;
  const options = buildAgentGenerationOptions(params, model || {}, { ...normalized, ...(maxTokens != null ? { maxTokens } : {}) });
  if (params.max_tokens != null) options.max_tokens = options.maxTokens;
  return options;
};

// 只取思考相关参数（给服务商函数调用路径做底：该路径对部分服务商有自己的思考兼容规则，规则优先）
export const buildMaidReasoningBaseOptions = (model = {}, settings = null) => {
  const options = buildMaidGenerationOptions({}, model, settings);
  return Object.fromEntries(Object.entries(options).filter(([key]) => REASONING_OPTION_KEYS.includes(key)));
};

export const hasReasoningOptions = (options = {}) => REASONING_OPTION_KEYS.some(key => options?.[key] !== undefined);
