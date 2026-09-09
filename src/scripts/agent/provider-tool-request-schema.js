import { toProviderToolModelName } from './provider-tool-name-map.js';
import { usesConfiguredResponses } from '../api/openai-api-format.js';

export const PROVIDER_TOOL_REQUEST_FORMATS = Object.freeze({
  openai: 'openai_chat_completions',
  openaiResponses: 'openai_responses',
  anthropic: 'anthropic_messages',
  gemini: 'gemini_function_declarations',
  unsupported: 'unsupported',
});

export const DEFAULT_PROVIDER_BASE_MODEL_CONTEXT_TOOLS = Object.freeze([
  'contact_profile.list',
  'contact_profile.get',
]);

export const CHAT_EMIT_PROVIDER_MODEL_CONTEXT_TOOLS = Object.freeze([
  'chat.emit_private',
  'chat.emit_group',
  'chat.emit_moment_comment',
  'chat.emit_moment_post',
]);

export const WRITE_PREVIEW_PROVIDER_MODEL_CONTEXT_TOOLS = Object.freeze([
  'memory.preview_actions',
  'variable.preview_commands',
  'worldbook.preview_actions',
]);

export const DEFAULT_PROVIDER_MODEL_CONTEXT_TOOLS = Object.freeze([
  ...DEFAULT_PROVIDER_BASE_MODEL_CONTEXT_TOOLS,
  ...WRITE_PREVIEW_PROVIDER_MODEL_CONTEXT_TOOLS,
]);

export const ALL_PROVIDER_MODEL_CONTEXT_TOOLS = Object.freeze([
  ...DEFAULT_PROVIDER_MODEL_CONTEXT_TOOLS,
  ...CHAT_EMIT_PROVIDER_MODEL_CONTEXT_TOOLS,
]);

const GEMINI_SCHEMA_TYPES = Object.freeze({
  object: 'OBJECT',
  string: 'STRING',
  integer: 'INTEGER',
  number: 'NUMBER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
});

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const isOfficialOpenAIEndpoint = (baseUrl = '') => {
  const raw = trim(baseUrl);
  if (!raw) return true;
  try {
    return new URL(raw).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
};

const normalizeProviderFormat = (provider = '', baseUrl = '', apiFormat = '') => {
  const value = trim(provider).toLowerCase();
  if (usesConfiguredResponses({ provider: value, apiFormat })) return PROVIDER_TOOL_REQUEST_FORMATS.openaiResponses;
  if (value === 'anthropic' || value.includes('claude')) return PROVIDER_TOOL_REQUEST_FORMATS.anthropic;
  if (value === 'gemini' || value === 'makersuite' || value === 'vertexai') {
    return PROVIDER_TOOL_REQUEST_FORMATS.gemini;
  }
  if (value === 'openai' && isOfficialOpenAIEndpoint(baseUrl)) {
    return PROVIDER_TOOL_REQUEST_FORMATS.openaiResponses;
  }
  if (value === 'openai' || value === 'custom' || value === 'deepseek') {
    return PROVIDER_TOOL_REQUEST_FORMATS.openai;
  }
  return PROVIDER_TOOL_REQUEST_FORMATS.unsupported;
};

const hasExistingToolOptions = (sources = []) => (
  (Array.isArray(sources) ? sources : [sources])
    .some((source) => {
      if (!isPlainObject(source)) return false;
      return Object.prototype.hasOwnProperty.call(source, 'tools') ||
        Object.prototype.hasOwnProperty.call(source, 'tool_choice') ||
        Object.prototype.hasOwnProperty.call(source, 'toolChoice') ||
        Object.prototype.hasOwnProperty.call(source, 'toolConfig');
    })
);

const resolveAction = (debugUiRegistry = null, name = '') => {
  const action = debugUiRegistry?.actions?.[name];
  return typeof action === 'function' ? action : null;
};

const resolveSessionGate = (debugUiRegistry = null, {
  sessionId = '',
  sessionGate = null,
} = {}) => {
  if (isPlainObject(sessionGate)) return sessionGate;
  const action = resolveAction(debugUiRegistry, 'getProviderToolSessionGate');
  if (!action) return null;
  try {
    const gate = action({ sessionId });
    return isPlainObject(gate) ? gate : null;
  } catch {
    return null;
  }
};

const resolveTool = (debugUiRegistry = null, toolName = '') => {
  const getAgentTool = resolveAction(debugUiRegistry, 'getAgentTool');
  if (getAgentTool) {
    try {
      const tool = getAgentTool(toolName);
      if (isPlainObject(tool)) return tool;
    } catch {}
  }
  const listAgentTools = resolveAction(debugUiRegistry, 'listAgentTools');
  if (listAgentTools) {
    try {
      const tools = listAgentTools();
      if (Array.isArray(tools)) {
        return tools.find(tool => trim(tool?.name) === toolName) || null;
      }
    } catch {}
  }
  return null;
};

const normalizeJsonSchema = (schema = {}) => {
  const value = clone(schema);
  return isPlainObject(value)
    ? value
    : { type: 'object', additionalProperties: false, properties: {} };
};

const toGeminiSchema = (schema = {}) => {
  if (Array.isArray(schema)) return schema.map(item => toGeminiSchema(item));
  if (!isPlainObject(schema)) return schema;
  const out = {};
  Object.entries(schema).forEach(([key, value]) => {
    if (key === 'additionalProperties') return;
    if (key === 'type' && typeof value === 'string') {
      out.type = GEMINI_SCHEMA_TYPES[value.toLowerCase()] || value;
      return;
    }
    if (key === 'properties' && isPlainObject(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, toGeminiSchema(child)]),
      );
      return;
    }
    if (key === 'items') {
      out.items = toGeminiSchema(value);
      return;
    }
    out[key] = toGeminiSchema(value);
  });
  return out;
};

const normalizeToolDefinition = (tool = {}) => {
  if (!isPlainObject(tool)) return null;
  const internalName = trim(tool.name);
  if (!internalName) return null;
  return {
    internalName,
    providerName: toProviderToolModelName(internalName),
    title: trim(tool.title),
    description: trim(tool.description || tool.title, internalName),
    schema: normalizeJsonSchema(tool.schema),
  };
};

const buildOpenAIOptions = (tools = [], { responses = false } = {}) => ({
  tools: tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.providerName,
      description: tool.description,
      parameters: tool.schema,
    },
  })),
  tool_choice: 'auto',
  ...(responses ? { openaiApi: 'responses', parallel_tool_calls: false } : {}),
});

const buildAnthropicOptions = (tools = []) => ({
  tools: tools.map(tool => ({
    name: tool.providerName,
    description: tool.description,
    input_schema: tool.schema,
  })),
});

const buildGeminiOptions = (tools = []) => ({
  tools: [{
    functionDeclarations: tools.map(tool => ({
      name: tool.providerName,
      description: tool.description,
      parameters: toGeminiSchema(tool.schema),
    })),
  }],
});

const buildOptionsForFormat = (format, tools = []) => {
  if (format === PROVIDER_TOOL_REQUEST_FORMATS.openai) return buildOpenAIOptions(tools);
  if (format === PROVIDER_TOOL_REQUEST_FORMATS.openaiResponses) {
    return buildOpenAIOptions(tools, { responses: true });
  }
  if (format === PROVIDER_TOOL_REQUEST_FORMATS.anthropic) return buildAnthropicOptions(tools);
  if (format === PROVIDER_TOOL_REQUEST_FORMATS.gemini) return buildGeminiOptions(tools);
  return {};
};

const disabled = (diagnostics = {}) => ({
  enabled: false,
  requestOptions: {},
  diagnostics: {
    enabled: false,
    reason: '',
    provider: '',
    model: '',
    sessionId: '',
    format: PROVIDER_TOOL_REQUEST_FORMATS.unsupported,
    sessionGateEnabled: false,
    internalToolNames: [],
    providerToolNames: [],
    writesChat: false,
    network: false,
    requiresSessionGate: true,
    ...diagnostics,
  },
});

export const buildProviderToolRequestSchema = ({
  debugUiRegistry = null,
  provider = '',
  baseUrl = '',
  apiFormat = '',
  model = '',
  sessionId = '',
  sessionGate = null,
  existingOptions = [],
  allowedModelContextTools = DEFAULT_PROVIDER_MODEL_CONTEXT_TOOLS,
} = {}) => {
  const normalizedProvider = trim(provider);
  const normalizedModel = trim(model);
  const normalizedSessionId = trim(sessionId);
  const format = normalizeProviderFormat(normalizedProvider, baseUrl, apiFormat);
  const baseDiagnostics = {
    provider: normalizedProvider,
    model: normalizedModel,
    sessionId: normalizedSessionId,
    format,
  };
  if (format === PROVIDER_TOOL_REQUEST_FORMATS.unsupported) {
    return disabled({
      ...baseDiagnostics,
      reason: 'provider does not support model tool schema injection',
    });
  }
  if (hasExistingToolOptions(existingOptions)) {
    return disabled({
      ...baseDiagnostics,
      reason: 'request already contains provider tool options',
    });
  }
  const gate = resolveSessionGate(debugUiRegistry, {
    sessionId: normalizedSessionId,
    sessionGate,
  });
  if (gate?.enabled !== true) {
    return disabled({
      ...baseDiagnostics,
      sessionGateEnabled: gate?.enabled === true,
      reason: 'provider tool session gate is disabled',
    });
  }

  const modelContextAllowlist = new Set(list(allowedModelContextTools));
  const gateTools = list(gate.allowedTools).filter(name => modelContextAllowlist.has(name));
  const normalizedTools = gateTools
    .map(toolName => normalizeToolDefinition(resolveTool(debugUiRegistry, toolName)))
    .filter(Boolean);
  if (!normalizedTools.length) {
    return disabled({
      ...baseDiagnostics,
      sessionGateEnabled: true,
      reason: 'no allowed provider tools are registered',
    });
  }

  const requestOptions = buildOptionsForFormat(format, normalizedTools);
  return {
    enabled: true,
    requestOptions,
    diagnostics: {
      enabled: true,
      reason: '',
      provider: normalizedProvider,
      model: normalizedModel,
      sessionId: normalizedSessionId,
      format,
      sessionGateEnabled: true,
      internalToolNames: normalizedTools.map(tool => tool.internalName),
      providerToolNames: normalizedTools.map(tool => tool.providerName),
      writesChat: false,
      network: false,
      requiresSessionGate: true,
    },
  };
};
