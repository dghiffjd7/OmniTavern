import { PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS } from './provider-tool-runner-handoff.js';
import {
  copyProviderToolContinuationContext,
  readProviderToolContinuationContext,
} from './provider-tool-continuation-context.js';
import { resolveProviderToolNativeRunnerContract } from './provider-tool-native-runner-contract.js';
import { PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS } from './provider-tool-runner-request-draft.js';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const readTimestamp = (now = Date.now) => Number(now?.() || Date.now()) || Date.now();

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const stripRunnerRequestOptions = (options = {}) => {
  const source = isPlainObject(options) ? options : {};
  const next = { ...source };
  delete next.onProviderToolCallDelta;
  delete next.onChunk;
  delete next.onMessage;
  delete next.writeMessage;
  delete next.commitMessage;
  delete next.chatStore;
  delete next.bridge;
  delete next.app;
  if (isPlainObject(next.options)) {
    next.options = stripRunnerRequestOptions(next.options);
  }
  return next;
};

const getRunnerRequest = (runnerRequestDraft = {}) => (
  isPlainObject(runnerRequestDraft?.request) ? runnerRequestDraft.request : null
);

const normalizeProviderFamily = (provider = '', format = '') => {
  const value = trim(provider).toLowerCase();
  const fmt = trim(format).toLowerCase();
  if (value.includes('anthropic') || value.includes('claude') || fmt.includes('anthropic')) return 'anthropic';
  if (value.includes('gemini') || value.includes('maker') || value.includes('vertex') || fmt.includes('gemini')) return 'gemini';
  if (value.includes('custom') || value.includes('deepseek') || value.includes('openai') || fmt.includes('openai')) return 'openai';
  return value || 'generic';
};

export const resolveProviderToolRealRunnerCapability = ({
  provider = '',
  requestPreviewFormat = '',
  payloadKind = '',
  providerClient = null,
} = {}) => {
  const providerFamily = normalizeProviderFamily(provider, requestPreviewFormat);
  const hasNativeRunner = providerClient && typeof providerClient.runProviderToolRequest === 'function';
  const hasStreamChat = providerClient && typeof providerClient.streamChat === 'function';
  const hasChat = providerClient && typeof providerClient.chat === 'function';
  const base = {
    providerFamily,
    payloadKind: trim(payloadKind),
    requestPreviewFormat: trim(requestPreviewFormat),
    runnerKind: '',
    clientMethod: '',
    supportsNetwork: false,
    requiresProviderNativeRunner: false,
  };

  if (hasNativeRunner) {
    return {
      ...base,
      ok: true,
      status: 'ready',
      reason: '',
      runnerKind: 'provider_native',
      clientMethod: 'runProviderToolRequest',
      supportsNetwork: true,
      requiresProviderNativeRunner: providerFamily !== 'openai',
    };
  }
  if (providerFamily === 'openai' && payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.messages && hasStreamChat) {
    return {
      ...base,
      ok: true,
      status: 'ready',
      reason: '',
      runnerKind: 'llmclient_stream_chat',
      clientMethod: 'streamChat',
      supportsNetwork: true,
    };
  }
  if (providerFamily === 'openai' && payloadKind === PROVIDER_TOOL_RUNNER_PAYLOAD_KINDS.messages && hasChat) {
    return {
      ...base,
      ok: true,
      status: 'ready',
      reason: '',
      runnerKind: 'llmclient_chat',
      clientMethod: 'chat',
      supportsNetwork: true,
    };
  }
  if (providerFamily === 'anthropic') {
    return {
      ...base,
      ok: false,
      status: 'unsupported',
      reason: 'anthropic tool_result payload requires a provider-native runner',
      requiresProviderNativeRunner: true,
    };
  }
  if (providerFamily === 'gemini') {
    return {
      ...base,
      ok: false,
      status: 'unsupported',
      reason: 'gemini functionResponse contents require a provider-native runner',
      requiresProviderNativeRunner: true,
    };
  }
  return {
    ...base,
    ok: false,
    status: 'unsupported',
    reason: `provider client cannot run payload kind: ${trim(payloadKind) || '-'}`,
  };
};

const resolveClientMethod = ({ providerClient = null, capability = null } = {}) => {
  const method = trim(capability?.clientMethod);
  if (providerClient && typeof providerClient.runProviderToolRequest === 'function') {
    return 'runProviderToolRequest';
  }
  if (method === 'streamChat' && providerClient && typeof providerClient.streamChat === 'function') {
    return 'streamChat';
  }
  if (method === 'chat' && providerClient && typeof providerClient.chat === 'function') {
    return 'chat';
  }
  return '';
};

export const buildProviderToolRealRunnerBoundary = ({
  runnerRequestDraft = null,
  providerClient = null,
  allowNetwork = false,
} = {}) => {
  const draft = isPlainObject(runnerRequestDraft) ? runnerRequestDraft : null;
  const request = getRunnerRequest(draft);
  const payloadKind = trim(draft?.payloadKind);
  const provider = trim(draft?.provider || request?.provider);
  const requestPreviewFormat = trim(draft?.requestPreviewFormat || request?.format);
  const capability = resolveProviderToolRealRunnerCapability({
    provider,
    requestPreviewFormat,
    payloadKind,
    providerClient,
  });
  const clientMethod = resolveClientMethod({ providerClient, capability });
  const nativeRunnerContract = clientMethod === 'runProviderToolRequest'
    ? resolveProviderToolNativeRunnerContract({ runnerRequestDraft: draft })
    : null;
  const base = {
    input: 'runnerRequestDraft.request',
    output: PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS.providerStreamEvents,
    network: allowNetwork === true,
    writesChat: false,
    provider,
    model: trim(draft?.model || request?.model),
    sessionId: trim(draft?.sessionId || request?.sessionId),
    requestPreviewFormat,
    payloadKind,
    payloadCount: Number(draft?.payloadCount || 0) || 0,
    capability,
    clientMethod,
    nativeRunnerContract,
    allowedInputs: ['runnerRequestDraft.request', 'providerClient', 'requestOptions', 'signal', 'requestId'],
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
      reason: 'real runner output must be provider stream events',
    };
  }
  if (draft.network === true) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      reason: 'real runner draft must not contain pre-executed network work',
    };
  }
  if (draft.writesChat === true) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      reason: 'real runner must not write chat messages directly',
    };
  }
  if (!request) {
    return {
      ...base,
      ok: false,
      status: 'skipped',
      reason: 'runner request payload missing',
    };
  }
  if (capability.ok !== true || !clientMethod) {
    return {
      ...base,
      ok: false,
      status: trim(capability.status, 'unsupported'),
      reason: trim(capability.reason, `provider client cannot run payload kind: ${payloadKind || '-'}`),
    };
  }
  if (clientMethod === 'runProviderToolRequest' && nativeRunnerContract?.ok !== true) {
    return {
      ...base,
      ok: false,
      status: trim(nativeRunnerContract?.status, 'unsupported'),
      reason: trim(nativeRunnerContract?.reason, 'provider-native runner contract is not ready'),
    };
  }

  return {
    ...base,
    ok: true,
    status: 'ready',
    reason: '',
  };
};

const readChunkText = (chunk = null) => {
  if (typeof chunk === 'string') return chunk;
  if (!isPlainObject(chunk)) return String(chunk ?? '');
  if (chunk.__chatappStream === true && chunk.kind === 'reasoning') return '';
  const value = chunk.content ?? chunk.text ?? chunk.delta ?? chunk.value;
  return String(value ?? '');
};

const consumeStreamToEvents = async ({
  stream,
  provider = '',
  model = '',
  sessionId = '',
  network = false,
  now = Date.now,
} = {}) => {
  const events = [];
  const createdAt = readTimestamp(now);
  let accumulatedText = '';
  events.push({
    type: 'provider_stream_start',
    provider,
    model,
    sessionId,
    network: network === true,
    writesChat: false,
    createdAt,
  });
  for await (const chunk of stream) {
    const textDelta = readChunkText(chunk);
    if (!textDelta) continue;
    accumulatedText += textDelta;
    events.push({
      type: 'provider_stream_delta',
      provider,
      model,
      sessionId,
      textDelta,
      accumulatedText,
      network: network === true,
      writesChat: false,
      createdAt: readTimestamp(now),
    });
  }
  events.push({
    type: 'provider_stream_end',
    provider,
    model,
    sessionId,
    finishReason: 'stop',
    finalText: accumulatedText,
    network: network === true,
    writesChat: false,
    createdAt: readTimestamp(now),
  });
  return { events, finalText: accumulatedText };
};

const toAsyncIterable = async function* (value) {
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    yield* value;
    return;
  }
  if (value && typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') {
    yield* value;
    return;
  }
  yield value;
};

const runProviderClient = async ({
  boundary,
  providerClient,
  request,
  requestOptions = {},
} = {}) => {
  const continuationContext = readProviderToolContinuationContext(request);
  const options = {
    ...(isPlainObject(continuationContext?.providerRequestOptions)
      ? clone(continuationContext.providerRequestOptions)
      : {}),
    ...stripRunnerRequestOptions(requestOptions),
  };
  options.requestContext = continuationContext?.providerRequestOptions?.requestContext
    || options.requestContext || { sessionId: request.sessionId };
  if (boundary.clientMethod === 'runProviderToolRequest') {
    const nativeRequest = clone(request);
    copyProviderToolContinuationContext(request, nativeRequest);
    return providerClient.runProviderToolRequest(nativeRequest, {
      ...options,
      nativeRunnerContract: clone(boundary.nativeRunnerContract),
    });
  }
  const historyMessages = Array.isArray(continuationContext?.historyMessages)
    ? continuationContext.historyMessages
    : [];
  const messages = [...clone(historyMessages), ...clone(request.messages || [])];
  if (boundary.clientMethod === 'streamChat') {
    return providerClient.streamChat(messages, options);
  }
  if (boundary.clientMethod === 'chat') {
    return providerClient.chat(messages, options);
  }
  return null;
};

export const runProviderToolRealRunnerAdapter = async ({
  runnerRequestDraft = null,
  providerClient = null,
  enabled = false,
  allowNetwork = false,
  requestOptions = {},
  now = Date.now,
} = {}) => {
  const createdAt = readTimestamp(now);
  const boundary = buildProviderToolRealRunnerBoundary({
    runnerRequestDraft,
    providerClient,
    allowNetwork,
  });
  const base = {
    output: PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS.providerStreamEvents,
    network: false,
    writesChat: false,
    events: [],
    eventCount: 0,
    finalText: '',
    runnerBoundary: boundary,
    provider: trim(boundary.provider),
    model: trim(boundary.model),
    sessionId: trim(boundary.sessionId),
    createdAt,
    updatedAt: createdAt,
  };

  if (enabled !== true) {
    return {
      ...base,
      ok: false,
      status: 'disabled',
      reason: 'real provider runner adapter disabled',
    };
  }
  if (allowNetwork !== true) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      reason: 'real provider runner adapter requires explicit network allowance',
    };
  }
  if (boundary.ok !== true) {
    return {
      ...base,
      ok: false,
      status: trim(boundary.status, 'skipped'),
      reason: trim(boundary.reason, 'real provider runner boundary is not ready'),
    };
  }

  const request = getRunnerRequest(runnerRequestDraft);
  try {
    const raw = await runProviderClient({
      boundary,
      providerClient,
      request,
      requestOptions: {
        ...requestOptions,
        requestId: trim(requestOptions?.requestId, `provider-tool-runner-${createdAt}`),
      },
    });
    if (isPlainObject(raw) && Array.isArray(raw.events)) {
      return {
        ...base,
        ok: raw.ok !== false,
        status: trim(raw.status, raw.ok === false ? 'failed' : 'succeeded'),
        reason: trim(raw.reason),
        network: true,
        writesChat: false,
        events: clone(raw.events),
        eventCount: raw.events.length,
        finalText: String(raw.finalText || ''),
        updatedAt: readTimestamp(now),
      };
    }
    const { events, finalText } = await consumeStreamToEvents({
      stream: toAsyncIterable(raw),
      provider: trim(boundary.provider),
      model: trim(boundary.model),
      sessionId: trim(boundary.sessionId),
      network: true,
      now,
    });
    return {
      ...base,
      ok: true,
      status: 'succeeded',
      reason: '',
      network: true,
      writesChat: false,
      events,
      eventCount: events.length,
      finalText,
      updatedAt: readTimestamp(now),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      reason: trim(error?.message || error, 'real provider runner failed'),
      updatedAt: readTimestamp(now),
    };
  }
};

export const createProviderToolRealRunnerAdapter = ({
  providerClient = null,
  enabled = false,
  requestOptions = {},
  now = Date.now,
} = {}) => async (runnerRequestDraft, context = {}) => runProviderToolRealRunnerAdapter({
  runnerRequestDraft,
  providerClient,
  enabled,
  allowNetwork: context?.allowNetwork === true,
  requestOptions,
  now,
});
