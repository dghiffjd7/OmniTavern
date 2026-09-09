import { PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS } from './provider-tool-runner-handoff.js';
import { PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS } from './provider-tool-runner-request-draft.js';

export const PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS = Object.freeze({
  openaiMessages: 'openai_messages_tool_result',
  openaiResponses: 'openai_responses_function_call_output',
  anthropicMessages: 'anthropic_messages_tool_result',
  geminiContents: 'gemini_function_response',
  genericToolResults: 'generic_tool_results',
});

export const PROVIDER_TOOL_NATIVE_RUNNER_ENTRYPOINT = 'providerClient.runProviderToolRequest';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeProviderFamily = (provider = '', format = '') => {
  const value = trim(provider).toLowerCase();
  const fmt = trim(format).toLowerCase();
  if (value.includes('anthropic') || value.includes('claude') || fmt.includes('anthropic')) return 'anthropic';
  if (value.includes('gemini') || value.includes('maker') || value.includes('vertex') || fmt.includes('gemini')) return 'gemini';
  if (value.includes('custom') || value.includes('deepseek') || value.includes('openai') || fmt.includes('openai')) return 'openai';
  return value || 'generic';
};

const countOpenAIToolMessages = (messages = []) => (
  messages.filter(message => trim(message?.role) === 'tool' && trim(message?.tool_call_id)).length
);

const countOpenAIToolCalls = (messages = []) => (
  messages.reduce((sum, message) => (
    sum + (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0)
  ), 0)
);

const countAnthropicParts = (messages = [], type = '') => (
  messages.reduce((sum, message) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    return sum + content.filter(part => trim(part?.type) === type).length;
  }, 0)
);

const countGeminiParts = (contents = [], key = '') => (
  contents.reduce((sum, content) => {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return sum + parts.filter(part => isPlainObject(part?.[key])).length;
  }, 0)
);

const getPayloadCount = (request = {}) => {
  if (Array.isArray(request?.input)) return request.input.length;
  if (Array.isArray(request?.messages)) return request.messages.length;
  if (Array.isArray(request?.contents)) return request.contents.length;
  if (Array.isArray(request?.toolResults)) return request.toolResults.length;
  return 0;
};

const buildReady = (base = {}, contractKind = '', details = {}) => ({
  ...base,
  ok: true,
  status: 'ready',
  reason: '',
  contractKind,
  entrypoint: PROVIDER_TOOL_NATIVE_RUNNER_ENTRYPOINT,
  ...details,
});

const buildUnsupported = (base = {}, reason = '') => ({
  ...base,
  ok: false,
  status: 'unsupported',
  reason: trim(reason, `unsupported provider-native runner payload: ${trim(base.payloadKind, '-')}`),
});

export const resolveProviderToolNativeRunnerContract = ({
  runnerRequestDraft = null,
} = {}) => {
  const draft = isPlainObject(runnerRequestDraft) ? runnerRequestDraft : null;
  const request = isPlainObject(draft?.request) ? draft.request : null;
  const providerFamily = normalizeProviderFamily(
    draft?.provider || request?.provider,
    draft?.requestPreviewFormat || request?.format,
  );
  const payloadKind = trim(draft?.payloadKind);
  const requestPreviewFormat = trim(draft?.requestPreviewFormat || request?.format);
  const base = {
    input: 'runnerRequestDraft.request',
    output: PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS.providerStreamEvents,
    entrypoint: PROVIDER_TOOL_NATIVE_RUNNER_ENTRYPOINT,
    providerFamily,
    provider: trim(draft?.provider || request?.provider),
    model: trim(draft?.model || request?.model),
    sessionId: trim(draft?.sessionId || request?.sessionId),
    payloadKind,
    requestPreviewFormat,
    payloadCount: getPayloadCount(request),
    network: false,
    writesChat: false,
    allowedInputs: ['runnerRequestDraft.request', 'requestOptions', 'signal', 'requestId'],
    forbiddenInputs: ['bridge', 'chatStore', 'window.appBridge', 'messageStore', 'chatUi'],
  };

  if (!draft) {
    return {
      ...base,
      ok: false,
      status: 'skipped',
      reason: 'runner request draft missing',
    };
  }
  if (draft.ok !== true) {
    return {
      ...base,
      ok: false,
      status: trim(draft.status, 'skipped'),
      reason: trim(draft.reason, 'runner request draft is not ready'),
    };
  }
  if (trim(draft.output) !== PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS.providerStreamEvents) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      reason: 'provider-native runner output must be provider stream events',
    };
  }
  if (draft.network === true) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      reason: 'provider-native runner draft must not contain pre-executed network work',
    };
  }
  if (draft.writesChat === true) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      reason: 'provider-native runner must not write chat messages directly',
    };
  }
  if (!request) {
    return {
      ...base,
      ok: false,
      status: 'skipped',
      reason: 'provider-native runner request payload missing',
    };
  }

  if (providerFamily === 'openai' && payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.input && Array.isArray(request.input)) {
    const functionCallCount = request.input.filter(item => trim(item?.type) === 'function_call').length;
    const functionCallOutputCount = request.input.filter(item => (
      trim(item?.type) === 'function_call_output' && trim(item?.call_id)
    )).length;
    if (!functionCallOutputCount) {
      return buildUnsupported(base, 'openai responses native runner input requires a function_call_output item');
    }
    if (!['openai', 'custom', 'opencode'].includes(trim(request.sourceProvider || request.provider).toLowerCase())) {
      return buildUnsupported(base, 'responses native runner requires an OpenAI or explicitly configured compatible provider');
    }
    return buildReady(base, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiResponses, {
      requestKeys: ['input'],
      functionCallCount,
      functionCallOutputCount,
      requiresProviderNativeRunner: true,
    });
  }

  if (providerFamily === 'openai' && payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.messages && Array.isArray(request.messages)) {
    const toolMessageCount = countOpenAIToolMessages(request.messages);
    const toolCallCount = countOpenAIToolCalls(request.messages);
    if (!toolMessageCount) {
      return buildUnsupported(base, 'openai native runner messages require a tool result message');
    }
    return buildReady(base, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiMessages, {
      requestKeys: ['messages'],
      toolMessageCount,
      toolCallCount,
      requiresProviderNativeRunner: false,
    });
  }

  if (providerFamily === 'anthropic' && payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.messages && Array.isArray(request.messages)) {
    const toolUseCount = countAnthropicParts(request.messages, 'tool_use');
    const toolResultCount = countAnthropicParts(request.messages, 'tool_result');
    if (!toolResultCount) {
      return buildUnsupported(base, 'anthropic native runner messages require a tool_result content part');
    }
    return buildReady(base, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.anthropicMessages, {
      requestKeys: ['messages'],
      toolUseCount,
      toolResultCount,
      requiresProviderNativeRunner: true,
    });
  }

  if (providerFamily === 'gemini' && payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.contents && Array.isArray(request.contents)) {
    const functionCallCount = countGeminiParts(request.contents, 'functionCall');
    const functionResponseCount = countGeminiParts(request.contents, 'functionResponse');
    const thoughtSignatureCount = request.contents.reduce((sum, content) => (
      sum + (Array.isArray(content?.parts)
        ? content.parts.filter(part => trim(part?.thoughtSignature)).length
        : 0)
    ), 0);
    if (!functionResponseCount) {
      return buildUnsupported(base, 'gemini native runner contents require a functionResponse part');
    }
    return buildReady(base, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.geminiContents, {
      requestKeys: ['contents'],
      functionCallCount,
      functionResponseCount,
      thoughtSignatureCount,
      requiresProviderNativeRunner: true,
    });
  }

  if (payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.toolResults && Array.isArray(request.toolResults)) {
    if (!request.toolResults.length) {
      return buildUnsupported(base, 'generic native runner requires at least one tool result');
    }
    return buildReady(base, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.genericToolResults, {
      requestKeys: ['toolResults'],
      toolResultCount: request.toolResults.length,
      requiresProviderNativeRunner: true,
    });
  }

  return buildUnsupported(base);
};
