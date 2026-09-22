const REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]);

const OPENAI_GPT51_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]);

const OPENAI_GPT5_PRO_REASONING_OPTIONS = Object.freeze([
  { value: 'high', label: '高' },
]);

const GEMINI_FLASH_LEVEL_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]);

const GEMINI_PRO_LEVEL_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]);

const GEMINI_LOW_HIGH_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
]);

const GEMINI_MINIMAL_HIGH_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'minimal', label: '极低' },
  { value: 'high', label: '高' },
]);

const GEMINI_OPENAI_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]);

const DEEPSEEK_REASONING_OPTIONS = Object.freeze([
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最大' },
]);

const ANTHROPIC_ADAPTIVE_REASONING_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]);

const KNOWN_REASONING_EFFORTS = new Set(
  REASONING_EFFORT_OPTIONS.map((item) => item.value),
);
const REASONING_EFFORT_RAW_VALUE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const normalizeText = (value) => String(value || '').trim().toLowerCase();
const modelSlug = (model) => {
  const raw = normalizeText(model);
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
};

export const isKnownReasoningEffort = (value) => KNOWN_REASONING_EFFORTS.has(normalizeText(value));

export const isValidReasoningEffortValue = (value) => (
  REASONING_EFFORT_RAW_VALUE_PATTERN.test(normalizeText(value))
);

export const normalizeReasoningEffort = (value, fallback = 'high', { allowCustom = false } = {}) => {
  const next = normalizeText(value);
  if (KNOWN_REASONING_EFFORTS.has(next)) return next;
  if (allowCustom && isValidReasoningEffortValue(next)) return next;
  const safeFallback = normalizeText(fallback);
  if (KNOWN_REASONING_EFFORTS.has(safeFallback)) return safeFallback;
  if (allowCustom && isValidReasoningEffortValue(safeFallback)) return safeFallback;
  return 'high';
};

const isOpenAIReasoningModel = (model) => {
  const m = normalizeText(model);
  const slug = modelSlug(model);
  if (!m) return false;
  return [m, slug].some(item =>
    item.startsWith('gpt-5') ||
    item.startsWith('o1') ||
    item.startsWith('o3') ||
    item.startsWith('o4')
  );
};

const isDeepSeekModel = (model) => normalizeText(model).startsWith('deepseek');
const isGeminiModel = (model) => normalizeText(model).includes('gemini');

const isAnthropicThinkingModel = (model) => {
  const m = normalizeText(model);
  if (!m) return false;
  return (
    isAnthropicAdaptiveThinkingModel(m) ||
    m.includes('claude-3-7-sonnet') ||
    m.includes('claude-sonnet-4') ||
    m.includes('claude-opus-4')
  );
};

const isAnthropicAlwaysAdaptiveThinkingModel = (model) => {
  const m = normalizeText(model);
  if (!m) return false;
  return (
    m.includes('claude-fable-5') ||
    m.includes('claude-mythos-5') ||
    m.includes('claude-mythos-preview') ||
    // 2026-08-16 真实 400 实测：`temperature` is deprecated for this model.
    m.includes('claude-opus-5') ||
    m.includes('claude-sonnet-5')
  );
};

const isAnthropicAdaptiveRequestModel = (model) => {
  const m = normalizeText(model);
  if (!m) return false;
  return (
    m.includes('claude-opus-4-8') ||
    m.includes('claude-opus-4-7')
  );
};

const isAnthropicAdaptiveThinkingModel = (model) => (
  isAnthropicAlwaysAdaptiveThinkingModel(model) ||
  isAnthropicAdaptiveRequestModel(model)
);

const isGeminiBudgetModel = (model) => normalizeText(model).includes('gemini-2.5');
const isGeminiLevelModel = (model) => normalizeText(model).includes('gemini-3');

const getGeminiLevelReasoningOptions = (model) => {
  const m = normalizeText(model);
  if (m.includes('flash-lite-image')) return GEMINI_MINIMAL_HIGH_REASONING_OPTIONS;
  if (m.includes('gemini-3.1-pro')) return GEMINI_PRO_LEVEL_REASONING_OPTIONS;
  if (m.includes('flash')) return GEMINI_FLASH_LEVEL_REASONING_OPTIONS;
  return GEMINI_LOW_HIGH_REASONING_OPTIONS;
};

const isOpenRouterReasoningModel = (model) => {
  const m = normalizeText(model);
  return (
    isOpenAIReasoningModel(m) ||
    isAnthropicThinkingModel(m) ||
    isGeminiBudgetModel(m) ||
    isGeminiLevelModel(m) ||
    m.includes('deepseek-r1') ||
    m.includes('deepseek-reasoner')
  );
};

const isGpt51Family = (model) => modelSlug(model).startsWith('gpt-5.1');
const isGpt5ProFamily = (model) => modelSlug(model).startsWith('gpt-5-pro');

const isOfficialGeminiOpenAIBaseUrl = (baseUrl) => {
  try {
    const url = new URL(String(baseUrl || '').trim());
    return (
      url.hostname === 'generativelanguage.googleapis.com' &&
      url.pathname.split('/').filter(Boolean).includes('openai')
    );
  } catch (_e) {
    return false;
  }
};

const budgetFromEffort = ({ effort, maxOutputTokens }) => {
  const safeMax = Number.isFinite(Number(maxOutputTokens))
    ? Math.max(1024, Math.trunc(Number(maxOutputTokens)))
    : 8192;
  const normalized = normalizeReasoningEffort(effort, 'high');
  if (normalized === 'auto') return null;
  if (normalized === 'minimal') return 1024;
  if (normalized === 'low') return Math.max(1024, Math.trunc(safeMax * 0.1));
  if (normalized === 'medium') return Math.max(1024, Math.trunc(safeMax * 0.25));
  if (normalized === 'high') return Math.max(1024, Math.trunc(safeMax * 0.5));
  if (normalized === 'xhigh') return Math.max(1024, Math.trunc(safeMax * 0.95));
  return Math.max(1024, Math.trunc(safeMax * 0.5));
};

const geminiLevelFromEffort = (effort, supportedOptions = []) => {
  const normalized = normalizeReasoningEffort(effort, 'high', { allowCustom: true });
  if (normalized === 'auto') return null;
  const supported = new Set(
    (Array.isArray(supportedOptions) ? supportedOptions : [])
      .map((option) => normalizeText(option?.value))
      .filter(Boolean),
  );
  if (supported.has(normalized)) return normalized;
  if (!isKnownReasoningEffort(normalized)) return normalized;
  if ((normalized === 'high' || normalized === 'xhigh' || normalized === 'max') && supported.has('high')) return 'high';
  if (normalized === 'minimal' && supported.has('low')) return 'low';
  if (normalized === 'medium' && supported.has('low')) return 'low';
  return supported.has('high') ? 'high' : (supported.values().next().value || 'high');
};

const deepSeekEffortFromSetting = (effort) => {
  const normalized = normalizeReasoningEffort(effort, 'high');
  if (normalized === 'max') return 'max';
  if (normalized === 'low' || normalized === 'minimal') return 'low';
  return 'high';
};

const anthropicAdaptiveEffortFromSetting = (effort) => {
  const normalized = normalizeReasoningEffort(effort, 'high', { allowCustom: true });
  if (normalized === 'auto') return null;
  if (normalized === 'minimal') return 'low';
  return normalized;
};

const openRouterReasoningEffortFromSetting = (effort) => {
  const normalized = normalizeReasoningEffort(effort, 'high', { allowCustom: true });
  if (normalized === 'auto') return null;
  if (normalized === 'max') return 'xhigh';
  return normalized;
};

const openAIReasoningEffortFromSetting = ({ model, effort }) => {
  const normalized = normalizeReasoningEffort(effort, 'high', { allowCustom: true });
  if (normalized === 'auto') return null;
  if (isGpt5ProFamily(model)) return isKnownReasoningEffort(normalized) ? 'high' : normalized;
  if (isGpt51Family(model)) {
    if (normalized === 'minimal' || normalized === 'xhigh') return 'high';
    return normalized;
  }
  return normalized;
};

const geminiOpenAIReasoningEffortFromSetting = (effort) => {
  const normalized = normalizeReasoningEffort(effort, 'high', { allowCustom: true });
  if (normalized === 'auto') return null;
  if (normalized === 'minimal') return 'minimal';
  if (normalized === 'low') return 'low';
  if (normalized === 'medium') return 'medium';
  if (!isKnownReasoningEffort(normalized)) return normalized;
  return 'high';
};

export const getReasoningCapability = ({ provider, model, baseUrl } = {}) => {
  const p = normalizeText(provider);
  const m = normalizeText(model);

  if (p === 'anthropic' && isAnthropicAdaptiveThinkingModel(m)) {
    const alwaysOn = isAnthropicAlwaysAdaptiveThinkingModel(m);
    const samplerRestricted = alwaysOn || isAnthropicAdaptiveRequestModel(m);
    return {
      supported: true,
      strategy: 'anthropic-adaptive',
      requestControl: true,
      effortControl: true,
      effortOptions: ANTHROPIC_ADAPTIVE_REASONING_OPTIONS,
      allowCustomEffort: true,
      samplingRestricted: samplerRestricted,
      hint: alwaysOn
        ? '该 Claude 模型的自适应推理始终开启，不能关闭；勾选后会请求返回推理摘要，并用 effort 控制强度。thinking 始终开启时会自动停用 temperature/top_p/top_k。'
        : '该 Claude 模型使用自适应推理；勾选后发送 thinking.type=adaptive，并用 effort 控制强度，不再发送 budget_tokens。此型号已停用 temperature/top_p/top_k。',
    };
  }

  if (p === 'anthropic' && isAnthropicThinkingModel(m)) {
    return {
      supported: true,
      strategy: 'anthropic-budget',
      requestControl: true,
      effortControl: true,
      effortOptions: REASONING_EFFORT_OPTIONS,
      allowCustomEffort: false,
      hint: '会从最大输出中划出一部分给推理预算：极低 1024，低 10%，中 25%，高 50%，极高 95%，最低 1024；自动则不额外请求推理。',
    };
  }

  if ((p === 'gemini' || p === 'makersuite' || p === 'vertexai') && isGeminiBudgetModel(m)) {
    return {
      supported: true,
      strategy: 'gemini-budget',
      requestControl: true,
      effortControl: true,
      effortOptions: REASONING_EFFORT_OPTIONS,
      allowCustomEffort: false,
      hint: 'Gemini 2.5 使用 thinkingBudget；极低 1024，低 10%，中 25%，高 50%，极高 95%，自动则不额外请求推理预算。',
    };
  }

  if ((p === 'gemini' || p === 'makersuite' || p === 'vertexai') && isGeminiLevelModel(m)) {
    return {
      supported: true,
      strategy: 'gemini-level',
      requestControl: true,
      effortControl: true,
      effortOptions: getGeminiLevelReasoningOptions(m),
      allowCustomEffort: true,
      hint: 'Gemini 3 使用 thinkingLevel；选项会按当前具体型号筛选。自定义值会作为未验证的 API 原始值发送。',
    };
  }

  if (p === 'deepseek' && isDeepSeekModel(m)) {
    return {
      supported: true,
      strategy: 'deepseek-thinking',
      requestControl: true,
      effortControl: true,
      effortOptions: DEEPSEEK_REASONING_OPTIONS,
      allowCustomEffort: false,
      hint: 'DeepSeek 推理强度：低 / 高（默认）/ 最大。思考模式下 temperature 等采样参数会被忽略。',
    };
  }

  if (p === 'openai' && isOpenAIReasoningModel(m)) {
    return {
      supported: true,
      strategy: 'openai-effort',
      requestControl: true,
      effortControl: true,
      effortOptions: isGpt5ProFamily(m)
        ? OPENAI_GPT5_PRO_REASONING_OPTIONS
        : isGpt51Family(m)
          ? OPENAI_GPT51_REASONING_OPTIONS
          : REASONING_EFFORT_OPTIONS,
      allowCustomEffort: !isGpt5ProFamily(m),
      hint: 'OpenAI 推理模型会映射到 reasoning_effort。',
    };
  }

  if (p === 'openrouter' && isOpenRouterReasoningModel(m)) {
    return {
      supported: true,
      strategy: 'openrouter-reasoning',
      requestControl: true,
      effortControl: true,
      effortOptions: REASONING_EFFORT_OPTIONS,
      allowCustomEffort: true,
      hint: 'OpenRouter 推理模型使用 reasoning.effort；OpenRouter 会按底层模型映射到对应 thinking/reasoning 参数。',
    };
  }

  if (p === 'custom') {
    if (isDeepSeekModel(m)) {
      return {
        supported: true,
        strategy: 'deepseek-thinking',
        requestControl: true,
        effortControl: true,
        effortOptions: DEEPSEEK_REASONING_OPTIONS,
        allowCustomEffort: false,
        hint: 'DeepSeek 推理强度：低 / 高（默认）/ 最大。思考模式下 temperature 等采样参数会被忽略。',
      };
    }
    if (isGeminiModel(m) && isOfficialGeminiOpenAIBaseUrl(baseUrl)) {
      return {
        supported: true,
        strategy: 'gemini-openai-effort',
        requestControl: true,
        effortControl: true,
        effortOptions: GEMINI_OPENAI_REASONING_OPTIONS,
        allowCustomEffort: true,
        hint: '自定义 Gemini OpenAI 兼容端点按 reasoning_effort 发送；不要同时发送 thinkingLevel/thinkingBudget。',
      };
    }
    if (isOpenAIReasoningModel(m)) {
      return {
        supported: true,
        strategy: 'openai-effort',
        requestControl: true,
        effortControl: true,
        effortOptions: isGpt5ProFamily(m)
          ? OPENAI_GPT5_PRO_REASONING_OPTIONS
          : isGpt51Family(m)
            ? OPENAI_GPT51_REASONING_OPTIONS
            : REASONING_EFFORT_OPTIONS,
        allowCustomEffort: !isGpt5ProFamily(m),
        hint: '自定义 OpenAI 兼容端点当前按 reasoning_effort 发送。',
      };
    }
  }

  return {
    supported: false,
    strategy: 'none',
    requestControl: false,
    effortControl: false,
    effortOptions: [],
    allowCustomEffort: false,
    hint: '',
  };
};

export const buildReasoningRequestOptions = ({
  provider,
  model,
  baseUrl,
  requestReasoning,
  reasoningEffort,
  maxOutputTokens,
} = {}) => {
  const capability = getReasoningCapability({ provider, model, baseUrl });
  if (!capability.supported) return {};
  if (requestReasoning !== true) {
    return normalizeText(provider) === 'deepseek' && capability.strategy === 'deepseek-thinking'
      ? { thinking: { type: 'disabled' } }
      : {};
  }

  switch (capability.strategy) {
    case 'openai-effort': {
      const effort = openAIReasoningEffortFromSetting({ model, effort: reasoningEffort });
      return effort ? { reasoning_effort: effort } : {};
    }
    case 'gemini-openai-effort': {
      const effort = geminiOpenAIReasoningEffortFromSetting(reasoningEffort);
      return effort ? { reasoning_effort: effort } : {};
    }
    case 'openrouter-reasoning': {
      const effort = openRouterReasoningEffortFromSetting(reasoningEffort);
      return effort ? { reasoning: { effort } } : {};
    }
    case 'anthropic-budget': {
      const budget = budgetFromEffort({ effort: reasoningEffort, maxOutputTokens });
      return budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {};
    }
    case 'anthropic-adaptive': {
      const effort = anthropicAdaptiveEffortFromSetting(reasoningEffort);
      const request = { thinking: { type: 'adaptive', display: 'summarized' } };
      if (effort) request.output_config = { effort };
      return request;
    }
    case 'gemini-budget': {
      const budget = budgetFromEffort({ effort: reasoningEffort, maxOutputTokens });
      return budget ? { thinkingBudget: budget } : {};
    }
    case 'gemini-level': {
      const thinkingLevel = geminiLevelFromEffort(reasoningEffort, capability.effortOptions);
      return thinkingLevel ? { thinkingLevel } : {};
    }
    case 'deepseek-thinking': {
      const dsEffort = deepSeekEffortFromSetting(reasoningEffort);
      return { thinking: { type: 'enabled' }, reasoning_effort: dsEffort };
    }
    default:
      return {};
  }
};

export const getReasoningSamplerPolicy = ({
  provider,
  model,
  baseUrl,
  requestReasoning,
} = {}) => {
  const p = normalizeText(provider);
  const capability = getReasoningCapability({ provider, model, baseUrl });
  const openAIRestrictedSampling = p === 'openai' && capability.strategy === 'openai-effort';
  const active = capability.samplingRestricted === true || (capability.supported && requestReasoning === true) || openAIRestrictedSampling;
  const disabledFields = new Set();

  if (!active) {
    return { active: false, disabledFields: [] };
  }

  // ST-style, provider-aware rules:
  // - Claude extended thinking is not compatible with temperature/top_k modifications,
  //   and top_p is constrained to a narrow range, so we disable these controls together.
  // - OpenAI reasoning models are treated as managed reasoning requests and hide classic
  //   sampling controls while reasoning is requested.
  // - Google thinking models keep their sampling controls.
  // - DeepSeek thinking mode ignores temperature/top_p/presence_penalty/frequency_penalty.
  if (capability.strategy === 'anthropic-budget' || capability.strategy === 'anthropic-adaptive' || capability.strategy === 'openai-effort' || capability.strategy === 'deepseek-thinking') {
    disabledFields.add('temperature');
    disabledFields.add('top_p');
    disabledFields.add('top_k');
  }
  if (openAIRestrictedSampling) {
    disabledFields.add('presence_penalty');
    disabledFields.add('frequency_penalty');
    disabledFields.add('seed');
    disabledFields.add('n');
  }

  return {
    active: disabledFields.size > 0,
    disabledFields: Array.from(disabledFields),
  };
};
