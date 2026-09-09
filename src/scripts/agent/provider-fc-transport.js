import { getReasoningSamplerPolicy } from '../api/model-capabilities.js';
import { readOpenRouterModelCapabilities } from '../api/openrouter-model-capabilities.js';
import { readOllamaModelCapabilities } from '../api/ollama-model-capabilities.js';
import {
  compileGeminiProviderSafeSchema,
  isGeminiPhoneTerminalTool,
} from './gemini-provider-safe-schema.js';
import { readChatFcCapability } from './chat-fc-capability-catalog.js';
import { compileOpenRouterProviderSafeSchema } from './openrouter-provider-safe-schema.js';

export const PROVIDER_FC_FAMILIES = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  unsupported: 'unsupported',
});

export const PROVIDER_FC_TOOL_CHOICE_MODES = Object.freeze({
  forcedTerminal: 'forced_terminal',
  auto: 'auto',
});

const PROVIDER_FC_TOOL_CHOICE_MODE_SET = new Set(Object.values(PROVIDER_FC_TOOL_CHOICE_MODES));

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = (value, fallback = null) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const PROVIDER_FC_OWNED_REQUEST_OPTION_KEYS = Object.freeze([
  'tools',
  'tool_choice',
  'toolChoice',
  'toolConfig',
  'reasoning_effort',
  'thinking',
  'response_format',
  'responseFormat',
  'deepseekPrefix',
  'stream',
  'onProviderUsage',
  'onProviderToolCallDelta',
  'openaiApi',
  'openai_api',
]);

export const sanitizeProviderFcInheritedRequestOptions = ({
  provider = '',
  options = {},
} = {}) => {
  const out = isPlainObject(options) ? { ...options } : {};
  PROVIDER_FC_OWNED_REQUEST_OPTION_KEYS.forEach(key => { delete out[key]; });
  const normalizedProvider = trim(provider).toLowerCase();
  if (normalizedProvider === 'openrouter' || normalizedProvider === 'ollama') {
    // OpenRouter's verified route rejects these under require_parameters=true;
    // Ollama's compatibility contract does not require support for them.
    delete out.frequency_penalty;
    delete out.presence_penalty;
    delete out.n;
  }
  if (normalizedProvider === 'ollama') delete out.reasoning;
  return out;
};

export const buildProviderFcRequestOptionsForLocalDiagnostics = (plan = {}) => {
  if (plan?.ok !== true) return {};
  const requestOptions = isPlainObject(plan?.requestOptions)
    ? clone(plan.requestOptions, {})
    : {};
  // The full local schema has its own Prompt panel section. Keeping it here would
  // duplicate a large payload and make the ordinary options row unreadable.
  delete requestOptions.tools;
  return {
    ...(isPlainObject(plan?.generationOptions) ? clone(plan.generationOptions, {}) : {}),
    ...requestOptions,
  };
};

const readHostname = (value = '') => {
  const raw = trim(value);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isOfficialOpenCodeGoBaseUrl = (value = '') => {
  const raw = trim(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'opencode.ai'
      && !url.port
      && !url.username
      && !url.password
      && url.pathname.replace(/\/+$/u, '') === '/zen/go/v1'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
};

const isOfficialOpenRouterBaseUrl = (value = '') => {
  const raw = trim(value, 'https://openrouter.ai/api/v1');
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'openrouter.ai'
      && !url.port
      && !url.username
      && !url.password
      && url.pathname.replace(/\/+$/u, '') === '/api/v1'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
};

const classifyOfficialKimiBaseUrl = (value = '') => {
  const raw = trim(value, 'https://api.moonshot.ai/v1');
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.port
      || url.username
      || url.password
      || url.pathname.replace(/\/+$/u, '') !== '/v1'
      || url.search
      || url.hash
    ) return '';
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'api.moonshot.ai') return 'global';
    if (hostname === 'api.moonshot.cn') return 'china';
    return '';
  } catch {
    return '';
  }
};

const isOfficialZhipuBaseUrl = (value = '') => {
  const raw = trim(value, 'https://open.bigmodel.cn/api/paas/v4');
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'open.bigmodel.cn'
      && !url.port
      && !url.username
      && !url.password
      && url.pathname.replace(/\/+$/u, '') === '/api/paas/v4'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
};

const classifyOllamaBaseUrl = (value = '') => {
  const raw = trim(value, 'http://127.0.0.1:11434/v1');
  try {
    const url = new URL(raw);
    if (
      url.username
      || url.password
      || url.pathname.replace(/\/+$/u, '') !== '/v1'
      || url.search
      || url.hash
    ) return '';
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol === 'https:'
      && !url.port
      && (hostname === 'ollama.com' || hostname === 'www.ollama.com')
    ) return 'cloud';
    if (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]')
    ) return 'local';
    return '';
  } catch {
    return '';
  }
};

const supported = ({ provider, family, endpoint }) => ({
  supported: true,
  reason: '',
  provider,
  family,
  endpoint,
});

const unsupported = ({ provider, reason }) => ({
  supported: false,
  reason,
  provider,
  family: PROVIDER_FC_FAMILIES.unsupported,
  endpoint: '',
});

const familyForTransportAdapter = (adapter = '') => {
  const normalized = trim(adapter).toLowerCase();
  if (normalized === 'anthropic_messages') return PROVIDER_FC_FAMILIES.anthropic;
  if (normalized === 'gemini_generate_content') return PROVIDER_FC_FAMILIES.gemini;
  if (normalized === 'openai_responses' || normalized === 'openai_chat_completions') {
    return PROVIDER_FC_FAMILIES.openai;
  }
  return PROVIDER_FC_FAMILIES.unsupported;
};

export const resolveProviderFcTransport = (config = {}, { localRuleOverride = null } = {}) => {
  const provider = trim(config?.provider).toLowerCase();
  const localCapability = readChatFcCapability({
    providerId: provider,
    baseUrl: config?.baseUrl,
    modelId: config?.model,
    route: config?.providerRoute || config?.route,
    localRuleOverride,
  });
  if (localCapability.blocked === true) {
    return {
      ...unsupported({ provider, reason: localCapability.blockReason || 'local_rule_circuit_open' }),
      capabilityLayer: localCapability.layer,
      capabilityRuleId: localCapability.ruleId,
      localRuleHealth: clone(localCapability.health, {}),
    };
  }
  if (localCapability.matched && localCapability.layer === 'local_advanced') {
    if (config.apiFormat === 'responses' && ['custom', 'opencode'].includes(provider)
      && localCapability.identity?.transportAdapter !== 'openai_responses') {
      return unsupported({ provider, reason: 'configured_api_format_mismatch' });
    }
    const family = familyForTransportAdapter(localCapability.identity?.transportAdapter);
    if (family !== PROVIDER_FC_FAMILIES.unsupported) {
      return supported({
        provider,
        family,
        endpoint: trim(localCapability.identity?.endpointClass),
      });
    }
  }
  const hostname = readHostname(config?.baseUrl);
  if (provider === 'custom') return unsupported({ provider, reason: 'unverified_custom_endpoint' });
  if (hostname === null) return unsupported({ provider, reason: 'unverified_provider_endpoint' });

  if (provider === 'deepseek') {
    return !hostname || hostname === 'api.deepseek.com'
      ? supported({ provider, family: PROVIDER_FC_FAMILIES.openai, endpoint: 'official_deepseek_responses' })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'openai') {
    return !hostname || hostname === 'api.openai.com'
      ? supported({ provider, family: PROVIDER_FC_FAMILIES.openai, endpoint: 'official_openai_responses' })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'opencode') {
    if (config.apiFormat === 'responses') return unsupported({ provider, reason: 'unverified_responses_capabilities' });
    const direct = trim(config?.connectionMode, 'direct').toLowerCase() !== 'reverse_proxy';
    return direct && isOfficialOpenCodeGoBaseUrl(config?.baseUrl)
      ? supported({
          provider,
          family: PROVIDER_FC_FAMILIES.openai,
          endpoint: 'official_opencode_go_chat_completions',
        })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'kimi') {
    const direct = trim(config?.connectionMode, 'direct').toLowerCase() !== 'reverse_proxy';
    const site = direct ? classifyOfficialKimiBaseUrl(config?.baseUrl) : '';
    return site
      ? supported({
          provider,
          family: PROVIDER_FC_FAMILIES.openai,
          endpoint: site === 'global'
            ? 'official_kimi_global_chat_completions'
            : 'official_kimi_china_chat_completions',
        })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'zhipu') {
    const direct = trim(config?.connectionMode, 'direct').toLowerCase() !== 'reverse_proxy';
    return direct && isOfficialZhipuBaseUrl(config?.baseUrl)
      ? supported({
          provider,
          family: PROVIDER_FC_FAMILIES.openai,
          endpoint: 'official_zhipu_chat_completions',
        })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'openrouter') {
    const direct = trim(config?.connectionMode, 'direct').toLowerCase() !== 'reverse_proxy';
    return direct && isOfficialOpenRouterBaseUrl(config?.baseUrl)
      ? supported({
          provider,
          family: PROVIDER_FC_FAMILIES.openai,
          endpoint: 'official_openrouter_chat_completions',
        })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'ollama') {
    const direct = trim(config?.connectionMode, 'direct').toLowerCase() !== 'reverse_proxy';
    const mode = direct ? classifyOllamaBaseUrl(config?.baseUrl) : '';
    return mode
      ? supported({
          provider,
          family: PROVIDER_FC_FAMILIES.openai,
          endpoint: mode === 'cloud'
            ? 'official_ollama_cloud_chat_completions'
            : 'official_ollama_local_chat_completions',
        })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'anthropic') {
    return !hostname || hostname === 'api.anthropic.com'
      ? supported({ provider, family: PROVIDER_FC_FAMILIES.anthropic, endpoint: 'official_anthropic_messages' })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'gemini' || provider === 'makersuite') {
    if (trim(config?.connectionMode, 'direct').toLowerCase() === 'reverse_proxy') {
      return unsupported({ provider, reason: 'unverified_provider_endpoint' });
    }
    const official = !hostname
      || hostname === 'generativelanguage.googleapis.com'
      || hostname === 'aiplatform.googleapis.com'
      || hostname.endsWith('-aiplatform.googleapis.com');
    return official
      ? supported({ provider, family: PROVIDER_FC_FAMILIES.gemini, endpoint: 'official_gemini_generate_content' })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  if (provider === 'vertexai') {
    if (trim(config?.connectionMode, 'direct').toLowerCase() === 'reverse_proxy') {
      return unsupported({ provider, reason: 'unverified_provider_endpoint' });
    }
    const official = !hostname
      || hostname === 'aiplatform.googleapis.com'
      || hostname.endsWith('-aiplatform.googleapis.com');
    return official
      ? supported({ provider, family: PROVIDER_FC_FAMILIES.gemini, endpoint: 'official_vertexai_generate_content' })
      : unsupported({ provider, reason: 'unverified_provider_endpoint' });
  }
  return unsupported({ provider, reason: 'unsupported_provider' });
};

const transportAdapterFor = (transport = {}) => {
  if (transport.family === PROVIDER_FC_FAMILIES.anthropic) return 'anthropic_messages';
  if (transport.family === PROVIDER_FC_FAMILIES.gemini) return 'gemini_generate_content';
  return String(transport.endpoint || '').includes('responses')
    ? 'openai_responses'
    : 'openai_chat_completions';
};

export const resolveProviderFcProbationEligibility = ({
  config = {},
  thinkingEnabled = false,
  reasoningOptions = {},
  localRuleOverride = null,
} = {}) => {
  const transport = resolveProviderFcTransport(config, { localRuleOverride });
  const model = trim(config?.model).toLowerCase();
  const base = {
    eligible: false,
    reason: '',
    provider: transport.provider,
    model,
    endpoint: transport.endpoint || '',
    transportAdapter: transport.supported ? transportAdapterFor(transport) : '',
    capabilityLayer: transport.capabilityLayer || '',
    capabilityRuleId: transport.capabilityRuleId || '',
  };
  if (!transport.supported) return { ...base, reason: transport.reason };
  if (!model) return { ...base, reason: 'model_required' };
  if (transport.provider === 'ollama') return { ...base, reason: 'ollama_probation_deferred' };
  if (transport.provider === 'kimi' || transport.provider === 'zhipu') {
    return { ...base, reason: 'forced_terminal_unavailable' };
  }
  if (transport.provider === 'deepseek' && thinkingEnabled === true) {
    return { ...base, reason: 'thinking_preservation_requires_json' };
  }
  if (
    transport.family === PROVIDER_FC_FAMILIES.anthropic
    && thinkingEnabled === true
    && trim(reasoningOptions?.thinking?.type).toLowerCase() !== 'adaptive'
  ) {
    return { ...base, reason: 'thinking_preservation_requires_json' };
  }
  if (transport.provider === 'openrouter') {
    if (model === 'openrouter/auto') return { ...base, reason: 'openrouter_auto_model_unsupported' };
    const modelCapabilities = readOpenRouterModelCapabilities({
      baseUrl: config?.baseUrl,
      model,
    });
    if (!modelCapabilities.known) {
      return { ...base, reason: 'openrouter_model_capabilities_unknown' };
    }
    if (!modelCapabilities.supportsTools || !modelCapabilities.supportsToolChoice) {
      return { ...base, reason: 'openrouter_model_tools_unsupported' };
    }
  }
  return { ...base, eligible: true, reason: '' };
};

export const resolveChatStructuredThinkingPreference = ({
  config = {},
  thinkingEnabled = false,
  reasoningOptions = {},
  preference = 'preserve',
  localRuleOverride = null,
} = {}) => {
  const requested = thinkingEnabled === true;
  const normalizedPreference = trim(preference).toLowerCase() === 'stable_format'
    ? 'stable_format'
    : 'preserve';
  const requestedRoute = resolveProviderFcProbationEligibility({
    config,
    thinkingEnabled: requested,
    reasoningOptions,
    localRuleOverride,
  });
  const requiresAlternateRoute = requested
    && requestedRoute.reason === 'thinking_preservation_requires_json';
  if (requiresAlternateRoute && normalizedPreference === 'stable_format') {
    return {
      preference: normalizedPreference,
      thinkingRequested: true,
      thinkingEnabled: false,
      thinkingOverrideReason: 'user_prefers_stable_format',
      switchesRequestMode: false,
      probation: resolveProviderFcProbationEligibility({
        config,
        thinkingEnabled: false,
        reasoningOptions,
        localRuleOverride,
      }),
    };
  }
  return {
    preference: normalizedPreference,
    thinkingRequested: requested,
    thinkingEnabled: requested,
    thinkingOverrideReason: '',
    switchesRequestMode: requiresAlternateRoute,
    probation: requestedRoute,
  };
};

const RELEASED_CHAT_FC_PROVIDERS = new Set([
  'deepseek',
  'openai',
  'anthropic',
  'opencode',
  'makersuite',
  'openrouter',
  'ollama',
  'zhipu',
]);

const readVerifiedChatFcCapability = (
  provider,
  endpoint,
  model,
  config = {},
  localRuleOverride = null,
) => {
  let ollamaCapabilityIdentity = '';
  if (provider === 'ollama') {
    const modelCapabilities = readOllamaModelCapabilities({
      baseUrl: config?.baseUrl,
      model,
    });
    ollamaCapabilityIdentity = modelCapabilities.capabilityIdentity;
  }
  return readChatFcCapability({
    providerId: provider,
    baseUrl: config?.baseUrl,
    endpointClass: endpoint,
    modelId: model,
    route: config?.providerRoute || config?.route,
    ollamaCapabilityIdentity,
    localRuleOverride,
  });
};

export const resolveChatProviderFcRelease = (config = {}) => {
  const transport = resolveProviderFcTransport(config);
  const model = trim(config?.model).toLowerCase();
  if (!transport.supported) {
    return {
      enabled: false,
      reason: transport.reason,
      provider: transport.provider,
      model,
      capabilitySource: '',
      capabilityLayer: transport.capabilityLayer || '',
      capabilityRuleId: transport.capabilityRuleId || '',
      localRuleHealth: clone(transport.localRuleHealth, {}),
      capabilities: {},
    };
  }
  const capabilityRecord = readVerifiedChatFcCapability(
    transport.provider,
    transport.endpoint,
    model,
    config,
  );
  const localAdvanced = capabilityRecord.layer === 'local_advanced';
  if (!localAdvanced && !RELEASED_CHAT_FC_PROVIDERS.has(transport.provider)) {
    return {
      enabled: false,
      reason: 'provider_rollout_deferred',
      provider: transport.provider,
      model,
      capabilitySource: '',
      capabilities: {},
    };
  }
  const capabilities = capabilityRecord.capabilities;
  if (transport.provider === 'openrouter') {
    const modelCapabilities = readOpenRouterModelCapabilities({
      baseUrl: config?.baseUrl,
      model,
    });
    if (
      modelCapabilities.known
      && (!modelCapabilities.supportsTools || !modelCapabilities.supportsToolChoice)
    ) {
      return {
        enabled: false,
        reason: 'openrouter_model_tools_unsupported',
        provider: transport.provider,
        model,
        capabilitySource: '',
        capabilities: {},
      };
    }
  }
  if (transport.provider === 'ollama') {
    const modelCapabilities = readOllamaModelCapabilities({
      baseUrl: config?.baseUrl,
      model,
    });
    if (!modelCapabilities.known) {
      return {
        enabled: false,
        reason: 'ollama_model_capabilities_unknown',
        provider: transport.provider,
        model,
        capabilitySource: '',
        capabilities: {},
      };
    }
    if (!modelCapabilities.modelPresent) {
      return {
        enabled: false,
        reason: 'ollama_model_missing',
        provider: transport.provider,
        model,
        capabilitySource: '',
        capabilities: {},
      };
    }
    if (!modelCapabilities.supportsTools) {
      return {
        enabled: false,
        reason: 'ollama_model_tools_unsupported',
        provider: transport.provider,
        model,
        capabilitySource: '',
        capabilities: {},
      };
    }
  }
  if (capabilities.basicToolCall !== true || capabilities.uniqueTerminalTool !== true) {
    return {
      enabled: false,
      reason: 'provider_model_not_verified',
      provider: transport.provider,
      model,
      capabilitySource: '',
      capabilities: {},
    };
  }
  return {
    enabled: true,
    reason: '',
    provider: transport.provider,
    model,
    capabilitySource: localAdvanced ? 'local_advanced' : 'verified_seed',
    capabilityLayer: capabilityRecord.layer,
    capabilityRevision: capabilityRecord.revision,
    capabilityRuleId: capabilityRecord.ruleId,
    capabilities,
  };
};

const normalizeOpenAITool = (tool = {}) => {
  const fn = isPlainObject(tool?.function) ? tool.function : {};
  const name = trim(fn.name);
  if (trim(tool?.type).toLowerCase() !== 'function' || !name) return null;
  return {
    type: 'function',
    function: {
      name,
      description: trim(fn.description, name),
      parameters: isPlainObject(fn.parameters)
        ? clone(fn.parameters, { type: 'object', properties: {} })
        : { type: 'object', properties: {} },
      ...(fn.strict === true ? { strict: true } : {}),
    },
  };
};

const GEMINI_SCHEMA_TYPES = Object.freeze({
  object: 'OBJECT',
  string: 'STRING',
  integer: 'INTEGER',
  number: 'NUMBER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
});

const inferGeminiConstType = (value) => {
  if (typeof value === 'string') return GEMINI_SCHEMA_TYPES.string;
  if (typeof value === 'boolean') return GEMINI_SCHEMA_TYPES.boolean;
  if (Number.isInteger(value)) return GEMINI_SCHEMA_TYPES.integer;
  if (typeof value === 'number' && Number.isFinite(value)) return GEMINI_SCHEMA_TYPES.number;
  return '';
};

const toGeminiSchema = (value) => {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!isPlainObject(value)) return value;
  const out = {};
  const hasConst = Object.prototype.hasOwnProperty.call(value, 'const');
  if (hasConst) {
    const inferredType = inferGeminiConstType(value.const);
    if (inferredType) {
      out.enum = [value.const];
      out.type = inferredType;
    }
  }
  Object.entries(value).forEach(([key, child]) => {
    if (key === 'additionalProperties' || key === 'const' || (key === 'enum' && hasConst)) return;
    if (key === 'oneOf') {
      out.anyOf = toGeminiSchema(child);
      return;
    }
    if (key === 'type' && typeof child === 'string') {
      out.type = GEMINI_SCHEMA_TYPES[child.toLowerCase()] || child;
      return;
    }
    out[key] = toGeminiSchema(child);
  });
  return out;
};

const buildOpenAIRequestOptions = ({
  tools,
  provider,
  endpoint = '',
  model = '',
  providerOptions = {},
  config = {},
  localRuleOverride = null,
  toolChoiceMode = PROVIDER_FC_TOOL_CHOICE_MODES.forcedTerminal,
}) => {
  const auto = toolChoiceMode === PROVIDER_FC_TOOL_CHOICE_MODES.auto;
  if (provider === 'deepseek') {
    const only = tools.length === 1 ? tools[0] : null;
    return {
      tools,
      tool_choice: auto
        ? 'auto'
        : (only ? { type: 'function', name: only.function.name } : 'required'),
      openaiApi: 'responses',
      parallel_tool_calls: false,
    };
  }
  if (provider === 'opencode') {
    const only = tools.length === 1 ? tools[0] : null;
    return {
      tools,
      tool_choice: auto
        ? 'auto'
        : (only
            ? { type: 'function', function: { name: only.function.name } }
            : 'required'),
      parallel_tool_calls: false,
    };
  }
  if (provider === 'kimi' || provider === 'zhipu') {
    return {
      tools,
      // 两家官方 Chat Completions 当前都只接受 auto/none；终态仍由提示词与本地严格 IR 校验保证。
      tool_choice: 'auto',
    };
  }
  if (provider === 'openrouter') {
    const providerTools = tools.map(tool => (
      isGeminiPhoneTerminalTool(tool.function.name)
        ? {
            ...tool,
            function: {
              ...tool.function,
              parameters: compileOpenRouterProviderSafeSchema(tool.function.parameters, {
                geminiUpstream: /^google\/gemini-/u.test(model),
              }),
            },
          }
        : tool
    ));
    const configuredRouting = isPlainObject(providerOptions?.provider)
      ? clone(providerOptions.provider, {})
      : {};
    const verified = readVerifiedChatFcCapability(
      provider,
      endpoint,
      model,
      config,
      localRuleOverride,
    ).capabilities;
    const providerRoute = trim(verified?.providerRoute).toLowerCase();
    return {
      tools: providerTools,
      tool_choice: auto ? 'auto' : 'required',
      provider: {
        ...configuredRouting,
        ...(providerRoute
          ? { only: [providerRoute], allow_fallbacks: false }
          : {}),
        require_parameters: true,
      },
    };
  }
  if (provider === 'ollama') {
    return {
      tools,
      tool_choice: auto ? 'auto' : 'required',
    };
  }
  return {
    tools,
    tool_choice: auto ? 'auto' : 'required',
    ...(provider === 'openai' ? { openaiApi: 'responses', parallel_tool_calls: false } : {}),
  };
};

const buildAnthropicRequestOptions = (
  tools = [],
  toolChoiceMode = PROVIDER_FC_TOOL_CHOICE_MODES.forcedTerminal,
) => {
  const mapped = tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: clone(tool.function.parameters, { type: 'object', properties: {} }),
    ...(tool.function.strict === true ? { strict: true } : {}),
  }));
  const only = mapped.length === 1 ? mapped[0] : null;
  return {
    tools: mapped,
    tool_choice: toolChoiceMode === PROVIDER_FC_TOOL_CHOICE_MODES.auto
      ? { type: 'auto', disable_parallel_tool_use: true }
      : {
          type: only ? 'tool' : 'any',
          ...(only ? { name: only.name } : {}),
          disable_parallel_tool_use: true,
        },
  };
};

const buildGeminiRequestOptions = (
  tools = [],
  toolChoiceMode = PROVIDER_FC_TOOL_CHOICE_MODES.forcedTerminal,
) => {
  const declarations = tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: isGeminiPhoneTerminalTool(tool.function.name)
      ? compileGeminiProviderSafeSchema(tool.function.parameters)
      : toGeminiSchema(tool.function.parameters),
  }));
  return {
    tools: [{ functionDeclarations: declarations }],
    toolConfig: {
      functionCallingConfig: {
        mode: toolChoiceMode === PROVIDER_FC_TOOL_CHOICE_MODES.auto ? 'AUTO' : 'ANY',
        allowedFunctionNames: declarations.map(item => item.name),
      },
    },
  };
};

const buildGenerationOptions = ({ config, thinkingEnabled, temperature, reasoningOptions = {} }) => {
  const provider = trim(config?.provider).toLowerCase();
  const model = trim(config?.model).toLowerCase();
  if (provider === 'deepseek') {
    return {
      reasoning: { effort: 'none' },
      ...(Number.isFinite(temperature) ? { temperature } : {}),
    };
  }
  // Kimi 的默认深度思考可能在短终态预算内耗尽而不产生 tool_calls；
  // 官方支持关闭思考，FC 终态由严格 IR 校验而不是推理正文保证。
  if (provider === 'kimi') return { thinking: { type: 'disabled' } };
  if (provider === 'zhipu') return {};
  if (provider === 'anthropic') {
    const thinking = isPlainObject(reasoningOptions?.thinking) ? clone(reasoningOptions.thinking, {}) : null;
    const thinkingType = trim(thinking?.type).toLowerCase();
    if (thinkingType === 'adaptive') {
      return {
        thinking,
        ...(isPlainObject(reasoningOptions?.output_config)
          ? { output_config: clone(reasoningOptions.output_config, {}) }
          : {}),
      };
    }
  }
  if (provider === 'openai' && /^gpt-5\.6-sol(?:$|[-:])/u.test(model)) {
    return { reasoning_effort: 'none' };
  }
  if (getReasoningSamplerPolicy({
    provider,
    model,
    baseUrl: config?.baseUrl,
    requestReasoning: thinkingEnabled === true,
  }).disabledFields.includes('temperature')) {
    return {};
  }
  return Number.isFinite(temperature) ? { temperature } : {};
};

export const buildProviderFcRequestPlan = ({
  config = {},
  tools = [],
  thinkingEnabled = false,
  temperature = 0,
  reasoningOptions = {},
  toolChoiceMode = PROVIDER_FC_TOOL_CHOICE_MODES.forcedTerminal,
  intermediateToolsEnabled = false,
  localRuleOverride = null,
  probationMode = false,
} = {}) => {
  const transport = resolveProviderFcTransport(config, { localRuleOverride });
  if (!transport.supported) {
    return {
      ok: false,
      reason: transport.reason,
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  const normalizedToolChoiceMode = trim(toolChoiceMode).toLowerCase();
  if (!PROVIDER_FC_TOOL_CHOICE_MODE_SET.has(normalizedToolChoiceMode)) {
    return {
      ok: false,
      reason: 'provider_fc_tool_choice_mode_unsupported',
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  if (
    normalizedToolChoiceMode === PROVIDER_FC_TOOL_CHOICE_MODES.auto
    && intermediateToolsEnabled !== true
  ) {
    return {
      ok: false,
      reason: 'provider_fc_intermediate_tools_not_enabled',
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  const providerModel = trim(config?.model).toLowerCase();
  const capabilityRecord = readVerifiedChatFcCapability(
    transport.provider,
    transport.endpoint,
    providerModel,
    config,
    localRuleOverride,
  );
  const localAdvanced = capabilityRecord.layer === 'local_advanced';
  if (
    transport.provider === 'deepseek'
    && !localAdvanced
    && probationMode !== true
    && !/^deepseek-v4-(?:flash|pro)$/u.test(providerModel)
  ) {
    return {
      ok: false,
      reason: 'deepseek_responses_model_unsupported',
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  if (
    transport.provider === 'opencode'
    && !localAdvanced
    && probationMode !== true
    && (
      capabilityRecord.capabilities?.basicToolCall !== true
      || capabilityRecord.capabilities?.uniqueTerminalTool !== true
    )
  ) {
    return {
      ok: false,
      reason: 'opencode_go_model_unsupported',
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  if (transport.provider === 'openrouter') {
    if (!providerModel || providerModel === 'openrouter/auto') {
      return {
        ok: false,
        reason: 'openrouter_auto_model_unsupported',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
    const modelCapabilities = readOpenRouterModelCapabilities({
      baseUrl: config?.baseUrl,
      model: providerModel,
    });
    if (!capabilityRecord.matched && !modelCapabilities.known) {
      return {
        ok: false,
        reason: 'openrouter_model_capabilities_unknown',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
    if (
      modelCapabilities.known
      && (!modelCapabilities.supportsTools || !modelCapabilities.supportsToolChoice)
    ) {
      return {
        ok: false,
        reason: 'openrouter_model_tools_unsupported',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
  }
  if (transport.provider === 'ollama') {
    const modelCapabilities = readOllamaModelCapabilities({
      baseUrl: config?.baseUrl,
      model: providerModel,
    });
    if (!modelCapabilities.known) {
      return {
        ok: false,
        reason: 'ollama_model_capabilities_unknown',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
    if (!modelCapabilities.modelPresent) {
      return {
        ok: false,
        reason: 'ollama_model_missing',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
    if (!modelCapabilities.supportsTools) {
      return {
        ok: false,
        reason: 'ollama_model_tools_unsupported',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
  }
  if (normalizedToolChoiceMode === PROVIDER_FC_TOOL_CHOICE_MODES.auto) {
    if (capabilityRecord.capabilities?.toolResultContinuation !== true) {
      return {
        ok: false,
        reason: 'provider_model_tool_continuation_not_verified',
        transport,
        requestOptions: {},
        generationOptions: {},
      };
    }
  }
  const normalizedTools = (Array.isArray(tools) ? tools : [])
    .map(normalizeOpenAITool)
    .filter(Boolean);
  if (!normalizedTools.length) {
    return {
      ok: false,
      reason: 'provider_fc_tools_empty',
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  const anthropicThinkingType = trim(reasoningOptions?.thinking?.type).toLowerCase();
  if (
    transport.family === PROVIDER_FC_FAMILIES.anthropic
    && thinkingEnabled === true
    && anthropicThinkingType !== 'adaptive'
  ) {
    return {
      ok: false,
      reason: 'anthropic_manual_thinking_forced_tool_unsupported',
      transport,
      requestOptions: {},
      generationOptions: {},
    };
  }
  const requestOptions = transport.family === PROVIDER_FC_FAMILIES.anthropic
    ? buildAnthropicRequestOptions(normalizedTools, normalizedToolChoiceMode)
    : (transport.family === PROVIDER_FC_FAMILIES.gemini
        ? buildGeminiRequestOptions(normalizedTools, normalizedToolChoiceMode)
        : buildOpenAIRequestOptions({
            tools: normalizedTools,
            provider: transport.provider,
            endpoint: transport.endpoint,
            model: providerModel,
            providerOptions: reasoningOptions,
            config,
            localRuleOverride,
            toolChoiceMode: normalizedToolChoiceMode,
          }));
  const deepSeekThinkingOverridden = transport.provider === 'deepseek' && thinkingEnabled === true;
  const autoOnlyToolChoice = (
    normalizedToolChoiceMode === PROVIDER_FC_TOOL_CHOICE_MODES.forcedTerminal
    && (transport.provider === 'kimi' || transport.provider === 'zhipu')
  );
  return {
    ok: true,
    reason: '',
    transport,
    requestOptions,
    generationOptions: buildGenerationOptions({
      config,
      thinkingEnabled,
      temperature,
      reasoningOptions,
    }),
    diagnostics: {
      toolChoiceMode: normalizedToolChoiceMode,
      thinkingRequested: thinkingEnabled === true,
      thinkingEnabled: deepSeekThinkingOverridden ? false : thinkingEnabled === true,
      thinkingOverrideReason: deepSeekThinkingOverridden
        ? 'deepseek_forced_tool_choice_incompatible'
        : '',
      providerToolChoice: autoOnlyToolChoice ? 'auto' : normalizedToolChoiceMode,
      toolChoiceOverrideReason: autoOnlyToolChoice
        ? `${transport.provider}_tool_choice_auto_only`
        : '',
      probationMode: probationMode === true,
    },
  };
};
