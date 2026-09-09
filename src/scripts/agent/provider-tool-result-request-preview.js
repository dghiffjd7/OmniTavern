import { normalizeProviderToolCall } from './provider-tool-call-parts.js';
import {
  toInternalProviderToolName,
  toProviderToolModelName,
} from './provider-tool-name-map.js';
import { attachProviderToolContinuationContext } from './provider-tool-continuation-context.js';

export const PROVIDER_TOOL_RESULT_PREVIEW_FORMATS = Object.freeze({
  openai: 'openai_chat_completions_tool_result',
  openaiResponses: 'openai_responses_function_call_output',
  anthropic: 'anthropic_messages_tool_result',
  gemini: 'gemini_function_response',
  generic: 'generic_tool_result_preview',
});

const FILTERED_KEYS = new Set([
  'absolutePath',
  'checks',
  'debug',
  'filePath',
  'localPath',
  'nativePath',
  'permission',
  'raw',
  'rawPayload',
  'stack',
]);

const DEFAULT_MODEL_RESULT_TOOLS = Object.freeze([
  'contact_profile.list',
  'contact_profile.get',
]);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const cloneSanitized = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => cloneSanitized(item, seen));
  const out = {};
  Object.entries(value).forEach(([key, child]) => {
    if (FILTERED_KEYS.has(key)) return;
    out[key] = cloneSanitized(child, seen);
  });
  return out;
};

const stringifyJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value ?? ''));
  }
};

const truncateForModel = (value, maxChars = 2000) => {
  const limit = Math.max(0, Math.trunc(Number(maxChars || 0)) || 0);
  const raw = stringifyJson(value);
  if (!limit || raw.length <= limit) return value;
  return {
    truncated: true,
    originalLength: raw.length,
    value: raw.slice(0, limit),
  };
};

const normalizeProvider = (provider = '') => {
  const value = trim(provider).toLowerCase();
  if (value.includes('anthropic') || value.includes('claude')) return 'anthropic';
  if (value.includes('gemini') || value.includes('maker') || value.includes('vertex')) return 'gemini';
  if (value.includes('openai') || value.includes('deepseek') || value.includes('custom') || value === 'opencode') return 'openai';
  return value || 'generic';
};

export const buildProviderToolResultForModel = (toolCall = {}, toolResult = {}, {
  maxContentChars = 2000,
  allowedTools = DEFAULT_MODEL_RESULT_TOOLS,
} = {}) => {
  const normalizedToolCall = normalizeProviderToolCall(toolCall);
  const src = isPlainObject(toolResult) ? toolResult : {};
  const explicit = Object.prototype.hasOwnProperty.call(src, 'resultForModel');
  const allowlist = new Set((Array.isArray(allowedTools) ? allowedTools : [allowedTools])
    .map(item => trim(item))
    .filter(Boolean));
  if (!explicit && !allowlist.has(normalizedToolCall.toolName)) {
    return {
      allowed: false,
      reason: `tool result is not allowed in model context: ${normalizedToolCall.toolName || '-'}`,
      resultForModel: null,
    };
  }
  const status = trim(src.status || src.output?.status, src.ok === false ? 'failed' : 'succeeded');
  const summary = trim(
    src.output?.summary || src.summary || src.reason || src.errorMessage,
    status === 'succeeded' ? 'tool result ready' : 'tool result failed',
  );
  const result = explicit
    ? src.resultForModel
    : {
        toolName: toProviderToolModelName(normalizedToolCall.toolName),
        status,
        summary,
      };
  return {
    allowed: true,
    reason: '',
    resultForModel: truncateForModel(cloneSanitized(result), maxContentChars),
  };
};

const normalizeToolCallList = (assistantToolCalls = [], fallbackResults = [], context = {}) => {
  const fromCalls = (Array.isArray(assistantToolCalls) ? assistantToolCalls : [assistantToolCalls])
    .filter(Boolean);
  const source = fromCalls.length
    ? fromCalls
    : (Array.isArray(fallbackResults) ? fallbackResults : [])
        .map(result => result?.toolCall)
        .filter(Boolean);
  return source.map(call => normalizeProviderToolCall(call, context));
};

const findResultForCall = (toolResults = [], toolCall = {}) => {
  const list = Array.isArray(toolResults) ? toolResults : [toolResults];
  return list.find((result) => {
    const resultId = trim(result?.toolCallId || result?.id || result?.toolCall?.toolCallId || result?.toolCall?.id);
    const resultName = toInternalProviderToolName(trim(result?.toolName || result?.toolCall?.toolName || result?.toolCall?.name));
    return (resultId && resultId === toolCall.toolCallId) ||
      (!resultId && resultName && resultName === toolCall.toolName);
  }) || {};
};

const buildToolResultItems = (toolCalls = [], toolResults = [], options = {}) => {
  const items = [];
  const skipped = [];
  toolCalls.forEach((toolCall) => {
    const result = findResultForCall(toolResults, toolCall);
    const status = trim(result.status || result.output?.status, result.ok === false ? 'failed' : 'succeeded');
    const modelPayload = buildProviderToolResultForModel(toolCall, result, options);
    if (!modelPayload.allowed) {
      skipped.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        status,
        reason: modelPayload.reason,
      });
      return;
    }
    items.push({
      toolCall,
      providerToolName: toProviderToolModelName(toolCall.toolName),
      status,
      resultForModel: modelPayload.resultForModel,
      errorMessage: trim(result.errorMessage || result.reason),
    });
  });
  return { items, skipped };
};

const buildOpenAIPreview = (items = []) => ({
  format: PROVIDER_TOOL_RESULT_PREVIEW_FORMATS.openai,
  messages: [
    {
      role: 'assistant',
      content: '',
      tool_calls: items.map(item => ({
        id: item.toolCall.toolCallId,
        type: 'function',
        function: {
          name: item.providerToolName,
          arguments: stringifyJson(item.toolCall.arguments || {}),
        },
      })),
    },
    ...items.map(item => ({
      role: 'tool',
      tool_call_id: item.toolCall.toolCallId,
      content: stringifyJson(item.resultForModel),
    })),
  ],
});

const dedupeOpenAIResponseOutput = (items = []) => {
  const seen = new Set();
  const output = [];
  items.forEach((item) => {
    const continuation = isPlainObject(item?.toolCall?.providerContinuation)
      ? item.toolCall.providerContinuation
      : {};
    const source = Array.isArray(continuation.assistantOutput)
      ? continuation.assistantOutput
      : [];
    source.forEach((entry) => {
      if (!isPlainObject(entry)) return;
      const key = [trim(entry.type), trim(entry.id || entry.call_id), trim(entry.call_id)].join(':');
      if (seen.has(key)) return;
      seen.add(key);
      output.push(cloneSanitized(entry));
    });
  });
  return output;
};

const buildOpenAIResponsesPreview = (items = []) => ({
  format: PROVIDER_TOOL_RESULT_PREVIEW_FORMATS.openaiResponses,
  input: [
    ...dedupeOpenAIResponseOutput(items),
    ...items.map(item => ({
      type: 'function_call_output',
      call_id: item.toolCall.toolCallId,
      output: stringifyJson(item.resultForModel),
    })),
  ],
});

const readSharedAssistantContent = (items = [], api = '') => {
  for (const item of items) {
    const continuation = isPlainObject(item?.toolCall?.providerContinuation)
      ? item.toolCall.providerContinuation
      : {};
    if (api && trim(continuation.api) !== api) continue;
    if (Array.isArray(continuation.assistantContent) && continuation.assistantContent.length) {
      return cloneSanitized(continuation.assistantContent);
    }
    if (isPlainObject(continuation.assistantContent) && Array.isArray(continuation.assistantContent.parts)) {
      return cloneSanitized(continuation.assistantContent.parts);
    }
  }
  return null;
};

const buildAnthropicPreview = (items = []) => ({
  format: PROVIDER_TOOL_RESULT_PREVIEW_FORMATS.anthropic,
  messages: [
    {
      role: 'assistant',
      content: readSharedAssistantContent(items, 'anthropic_messages') || items.map(item => ({
          type: 'tool_use',
          id: item.toolCall.toolCallId,
          name: item.providerToolName,
          input: item.toolCall.arguments || {},
        })),
    },
    {
      role: 'user',
      content: items.map(item => ({
        type: 'tool_result',
        tool_use_id: item.toolCall.toolCallId,
        content: stringifyJson(item.resultForModel),
        is_error: item.status !== 'succeeded',
      })),
    },
  ],
});

const buildGeminiPreview = (items = []) => ({
  format: PROVIDER_TOOL_RESULT_PREVIEW_FORMATS.gemini,
  contents: [
    {
      role: 'model',
      parts: readSharedAssistantContent(items, 'gemini_generate_content') || items.map(item => ({
          functionCall: {
            name: item.providerToolName,
            args: item.toolCall.arguments || {},
          },
        })),
    },
    {
      role: 'user',
      parts: items.map(item => ({
        functionResponse: {
          name: item.providerToolName,
          response: item.resultForModel,
        },
      })),
    },
  ],
});

const buildGenericPreview = (items = []) => ({
  format: PROVIDER_TOOL_RESULT_PREVIEW_FORMATS.generic,
  toolResults: items.map(item => ({
    toolCallId: item.toolCall.toolCallId,
    toolName: item.providerToolName,
    status: item.status,
    result: item.resultForModel,
  })),
});

export const buildProviderToolResultRequestPreview = ({
  provider = '',
  model = '',
  assistantToolCalls = [],
  toolResults = [],
  sessionId = '',
  maxContentChars = 2000,
  allowedTools = DEFAULT_MODEL_RESULT_TOOLS,
  historyMessages = [],
  providerRequestOptions = {},
} = {}) => {
  const normalizedProvider = normalizeProvider(provider);
  const toolCalls = normalizeToolCallList(assistantToolCalls, toolResults, {
    provider,
    model,
    sessionId,
  });
  const { items, skipped } = buildToolResultItems(toolCalls, toolResults, { maxContentChars, allowedTools });
  const base = {
    provider: normalizedProvider,
    sourceProvider: trim(provider, normalizedProvider),
    model: trim(model),
    sessionId: trim(sessionId),
    network: false,
    toolCallCount: toolCalls.length,
    toolResultCount: items.length,
    skippedToolResultCount: skipped.length,
    skippedToolResults: skipped,
  };
  if (!toolCalls.length || !items.length || skipped.length) {
    return {
      ...base,
      format: PROVIDER_TOOL_RESULT_PREVIEW_FORMATS.generic,
      toolResults: [],
    };
  }
  const usesOpenAIResponses = normalizedProvider === 'openai' && items.some(item => (
    trim(item?.toolCall?.providerContinuation?.api) === 'openai_responses'
  ));
  const preview = usesOpenAIResponses
    ? { ...base, ...buildOpenAIResponsesPreview(items) }
    : (normalizedProvider === 'openai'
        ? { ...base, ...buildOpenAIPreview(items) }
        : (normalizedProvider === 'anthropic'
            ? { ...base, ...buildAnthropicPreview(items) }
            : (normalizedProvider === 'gemini'
                ? { ...base, ...buildGeminiPreview(items) }
                : { ...base, ...buildGenericPreview(items) })));
  return attachProviderToolContinuationContext(preview, {
    historyMessages: Array.isArray(historyMessages) ? historyMessages : [],
    providerRequestOptions: isPlainObject(providerRequestOptions) ? providerRequestOptions : {},
    providerApi: usesOpenAIResponses ? 'openai_responses' : '',
  });
};
