import { finalizeTextRequestBody } from '../api/request-params.js';
import { createLinkedAbortController, splitRequestOptions } from '../api/abort.js';
import { prepareTransportRequest } from '../api/transport.js';
import { bindOpenCodeRequestContext } from '../api/opencode-request-headers.js';
import { buildOpenAICompatibleEndpoint } from '../api/openai-api-format.js';
import { assertResponsesSuccess } from '../api/providers/openai-responses-runtime.js';
import {
  buildOpenAIResponsesRequestBody,
  extractOpenAIResponsesText,
} from '../api/providers/openai-responses-utils.js';
import { PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS } from './provider-tool-runner-handoff.js';
import {
  PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS,
  resolveProviderToolNativeRunnerContract,
} from './provider-tool-native-runner-contract.js';
import { readProviderToolContinuationContext } from './provider-tool-continuation-context.js';

const GEMINI_SAFETY = Object.freeze([
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]);

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

const getTauriInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
  return (
    g?.__TAURI__?.core?.invoke ||
    g?.__TAURI__?.invoke ||
    g?.__TAURI_INVOKE__ ||
    g?.__TAURI_INTERNALS__?.invoke
  );
};

const normalizeProviderFamily = (provider = '', format = '') => {
  const value = trim(provider).toLowerCase();
  const fmt = trim(format).toLowerCase();
  if (value.includes('anthropic') || value.includes('claude') || fmt.includes('anthropic')) return 'anthropic';
  if (value.includes('gemini') || value.includes('maker') || value.includes('vertex') || fmt.includes('gemini')) return 'gemini';
  if (value.includes('custom') || value.includes('deepseek') || value.includes('openai') || fmt.includes('openai')) return 'openai';
  return value || 'generic';
};

const sanitizePayloadOptions = (options = {}) => {
  const { signal, requestId, options: payloadOptions } = splitRequestOptions(options);
  const source = isPlainObject(payloadOptions) ? payloadOptions : {};
  const next = { ...source };
  delete next.nativeRunnerContract;
  delete next.fetchFn;
  delete next.runnerBoundary;
  delete next.onChunk;
  delete next.onMessage;
  delete next.writeMessage;
  delete next.commitMessage;
  delete next.chatStore;
  delete next.bridge;
  delete next.app;
  return { signal, requestId, payloadOptions: next };
};

const buildProviderStreamEvents = ({
  provider = '',
  model = '',
  sessionId = '',
  finalText = '',
  adapter = '',
  network = true,
  now = Date.now,
} = {}) => {
  const createdAt = readTimestamp(now);
  const text = String(finalText || '');
  return [
    {
      type: 'provider_stream_start',
      provider,
      model,
      sessionId,
      adapter,
      network: network === true,
      writesChat: false,
      createdAt,
    },
    {
      type: 'provider_stream_delta',
      provider,
      model,
      sessionId,
      adapter,
      textDelta: text,
      accumulatedText: text,
      network: network === true,
      writesChat: false,
      createdAt: readTimestamp(now),
    },
    {
      type: 'provider_stream_end',
      provider,
      model,
      sessionId,
      adapter,
      finishReason: 'stop',
      finalText: text,
      network: network === true,
      writesChat: false,
      createdAt: readTimestamp(now),
    },
  ];
};

const extractAnthropicText = (data = {}) => {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter(block => block?.type === 'text' && typeof block?.text === 'string')
    .map(block => block.text)
    .join('');
};

const extractGeminiText = (data = {}) => {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const content = candidates[0]?.content ?? candidates[0]?.output;
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts
    .filter(part => !part?.thought && typeof part?.text === 'string')
    .map(part => part.text)
    .join('\n\n');
};

const assertJsonOk = (res = {}, providerLabel = 'Provider') => {
  if (res?.ok !== false) {
    try {
      return JSON.parse(String(res?.body || '{}'));
    } catch (error) {
      throw new Error(`${providerLabel} invalid JSON response: ${error.message}`);
    }
  }
  let detail = '';
  try {
    const parsed = JSON.parse(String(res?.body || '{}'));
    detail = String(parsed?.error?.message || parsed?.message || parsed?.error || '').trim();
  } catch {}
  const error = new Error(`${providerLabel} API Error: ${res.status || 0}${detail ? ` - ${detail}` : ''}`);
  error.status = res.status || 0;
  error.response = res?.body;
  throw error;
};

const requestJson = async ({
  providerObject = null,
  providerFamily = 'generic',
  transportProvider = 'generic',
  url = '',
  headers = {},
  body = {},
  requestParamOptions = {},
  signal = null,
  requestId = '',
  timeoutMs = 60000,
  fetchFn = null,
} = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(finalizeTextRequestBody(body, {
    config: providerObject?.transportConfig || {}, options: requestParamOptions,
    protocol: providerFamily === 'OpenAI Responses' ? 'responses'
      : providerFamily === 'Anthropic' ? 'anthropic' : 'gemini',
  }));
  if (providerObject && typeof providerObject.requestJson === 'function') {
    return providerObject.requestJson({
      url,
      method: 'POST',
      headers,
      body: payload,
      signal,
      requestId,
    });
  }
  if (providerObject && typeof providerObject.request === 'function') {
    return assertJsonOk(await providerObject.request({
      url,
      method: 'POST',
      headers,
      body: payload,
      signal,
      requestId,
    }), providerFamily);
  }

  const prepared = prepareTransportRequest({
    config: providerObject?.transportConfig,
    provider: transportProvider,
    url,
    headers,
  });
  const invoker = getTauriInvoker();
  if (typeof invoker === 'function') {
    const res = await invoker('http_request', {
      url: prepared.url,
      method: 'POST',
      headers: prepared.headers,
      body: payload,
      timeoutMs,
      requestId: requestId || null,
    });
    return assertJsonOk(res, providerFamily);
  }

  const doFetch = typeof fetchFn === 'function' ? fetchFn : globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== 'function') {
    throw new Error('fetch is not available for provider-native runner');
  }
  const { controller, cleanup } = createLinkedAbortController({ timeoutMs, signal });
  try {
    const response = await doFetch(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      signal: controller.signal,
      body: payload,
    });
    const text = await response.text();
    return assertJsonOk({ ok: response.ok, status: response.status, body: text }, providerFamily);
  } finally {
    cleanup();
  }
};

const buildGeminiGenerationConfig = (options = {}) => {
  const config = {
    temperature: options.temperature ?? 0.7,
    topP: options.top_p ?? options.topP ?? 0.9,
    topK: options.top_k ?? options.topK ?? 40,
    maxOutputTokens: options.maxTokens ?? options.max_tokens ?? options.maxOutputTokens ?? 2048,
  };
  if (Number.isFinite(options.thinkingBudget) || typeof options.thinkingLevel === 'string') {
    config.thinkingConfig = {};
    if (Number.isFinite(options.thinkingBudget)) {
      config.thinkingConfig.thinkingBudget = Math.trunc(options.thinkingBudget);
    }
    if (typeof options.thinkingLevel === 'string' && options.thinkingLevel.trim()) {
      config.thinkingConfig.thinkingLevel = String(options.thinkingLevel).trim();
    }
  }
  return config;
};

const buildGeminiNativeBody = (request = {}, options = {}) => {
  const body = {
    contents: clone(request.contents || []),
    safetySettings: clone(GEMINI_SAFETY),
    generationConfig: buildGeminiGenerationConfig(options),
  };
  if (request.systemInstruction) {
    body.systemInstruction = clone(request.systemInstruction);
  }
  if (Array.isArray(options.tools) && options.tools.length) {
    body.tools = clone(options.tools);
  }
  if (isPlainObject(options.toolConfig)) {
    body.toolConfig = clone(options.toolConfig);
  }
  return body;
};

const getGeminiUrl = (providerObject = {}, request = {}) => {
  if (typeof providerObject.buildUrl === 'function') {
    return providerObject.buildUrl(false);
  }
  if (typeof providerObject.buildUrlFor === 'function') {
    return providerObject.buildUrlFor({
      stream: false,
      region: providerObject.region,
      baseHost: providerObject.baseHost || providerObject.baseUrl,
      model: request.model || providerObject.model,
    });
  }
  throw new Error('Gemini provider does not expose a native request URL builder');
};

const getProviderHeaders = async (providerObject = {}) => {
  if (typeof providerObject.getHeaders === 'function') {
    return await providerObject.getHeaders();
  }
  return { 'Content-Type': 'application/json' };
};

const runAnthropicNativeRequest = async ({
  providerObject = null,
  request = {},
  options = {},
  now = Date.now,
} = {}) => {
  const { signal, requestId, payloadOptions } = sanitizePayloadOptions(options);
  const continuationContext = readProviderToolContinuationContext(request) || {};
  const history = Array.isArray(continuationContext.historyMessages)
    ? continuationContext.historyMessages
    : [];
  const converted = history.length && typeof providerObject?.convertMessages === 'function'
    ? providerObject.convertMessages(history)
    : { system: undefined, messages: [] };
  const { options: providerRequestOptions } = splitRequestOptions(continuationContext.providerRequestOptions);
  const maxTokens = payloadOptions.maxTokens ?? payloadOptions.max_tokens ?? 4096;
  const providerModel = request.model || providerObject?.model || '';
  const body = {
    model: providerModel,
    messages: [...clone(converted.messages || []), ...clone(request.messages || [])],
    system: request.system || converted.system,
    max_tokens: maxTokens,
    stream: false,
    ...clone(providerRequestOptions),
    ...payloadOptions,
  };
  delete body.maxTokens;
  const data = await requestJson({
    providerObject,
    providerFamily: 'Anthropic',
    transportProvider: 'anthropic',
    url: `${providerObject?.baseUrl || 'https://api.anthropic.com/v1'}/messages`,
    headers: typeof providerObject?.getHeaders === 'function' ? providerObject.getHeaders() : {},
    body,
    signal,
    requestId,
    timeoutMs: providerObject?.timeout,
    fetchFn: options.fetchFn,
    requestParamOptions: { ...providerRequestOptions, ...options },
  });
  const finalText = extractAnthropicText(data);
  return {
    adapter: PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.anthropicMessages,
    finalText,
    events: buildProviderStreamEvents({
      provider: 'anthropic',
      model: providerModel,
      sessionId: trim(request.sessionId),
      finalText,
      adapter: PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.anthropicMessages,
      now,
    }),
  };
};

const runGeminiNativeRequest = async ({
  providerObject = null,
  request = {},
  options = {},
  providerFamily = 'gemini',
  now = Date.now,
} = {}) => {
  const { signal, requestId, payloadOptions } = sanitizePayloadOptions(options);
  const continuationContext = readProviderToolContinuationContext(request) || {};
  const history = Array.isArray(continuationContext.historyMessages)
    ? continuationContext.historyMessages
    : [];
  const converted = history.length && typeof providerObject?.convertMessages === 'function'
    ? providerObject.convertMessages(history)
    : { contents: [], systemInstruction: '' };
  const { options: providerRequestOptions } = splitRequestOptions(continuationContext.providerRequestOptions);
  const nativeRequest = {
    ...request,
    contents: [...clone(converted.contents || []), ...clone(request.contents || [])],
    systemInstruction: request.systemInstruction || (converted.systemInstruction
      ? { role: 'user', parts: [{ text: converted.systemInstruction }] }
      : undefined),
  };
  const nativeOptions = { ...clone(providerRequestOptions), ...payloadOptions };
  const url = getGeminiUrl(providerObject, request);
  const headers = await getProviderHeaders(providerObject);
  const data = await requestJson({
    providerObject,
    providerFamily: providerFamily === 'vertexai' ? 'Vertex AI' : 'Gemini',
    transportProvider: providerFamily,
    url,
    headers,
    body: buildGeminiNativeBody(nativeRequest, nativeOptions),
    signal,
    requestId,
    timeoutMs: providerObject?.timeout,
    fetchFn: options.fetchFn,
    requestParamOptions: { ...providerRequestOptions, ...options },
  });
  const finalText = extractGeminiText(data);
  return {
    adapter: PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.geminiContents,
    finalText,
    events: buildProviderStreamEvents({
      provider: providerFamily,
      model: request.model || providerObject?.model || '',
      sessionId: trim(request.sessionId),
      finalText,
      adapter: PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.geminiContents,
      now,
    }),
  };
};

const runOpenAIResponsesNativeRequest = async ({
  providerObject = null,
  request = {},
  options = {},
  now = Date.now,
} = {}) => {
  const { signal, requestId, payloadOptions } = sanitizePayloadOptions(options);
  const continuationContext = readProviderToolContinuationContext(request) || {};
  const history = Array.isArray(continuationContext.historyMessages)
    ? continuationContext.historyMessages
    : [];
  const { options: providerRequestOptions } = splitRequestOptions(continuationContext.providerRequestOptions);
  const providerModel = request.model || providerObject?.model || '';
  const body = buildOpenAIResponsesRequestBody({
    model: providerModel,
    messages: history,
    input: request.input,
    options: { ...clone(providerRequestOptions), ...payloadOptions },
  });
  const prepared = typeof providerObject?.prepareResponsesRequest === 'function'
    ? providerObject.prepareResponsesRequest([...history, ...(request.input || [])], {
        ...clone(providerRequestOptions), ...payloadOptions,
      })
    : null;
  const data = await requestJson({
    providerObject,
    providerFamily: 'OpenAI Responses',
    transportProvider: providerObject?.provider || request.sourceProvider || 'openai',
    url: prepared?.url || buildOpenAICompatibleEndpoint(providerObject?.baseUrl || 'https://api.openai.com/v1', 'responses'),
    headers: await getProviderHeaders(providerObject),
    body,
    signal,
    requestId,
    timeoutMs: providerObject?.timeout,
    fetchFn: options.fetchFn,
    requestParamOptions: { ...providerRequestOptions, ...options },
  });
  assertResponsesSuccess(data);
  const finalText = extractOpenAIResponsesText(data);
  return {
    adapter: PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiResponses,
    finalText,
    events: buildProviderStreamEvents({
      provider: providerObject?.provider || request.sourceProvider || 'openai',
      model: providerModel,
      sessionId: trim(request.sessionId),
      finalText,
      adapter: PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiResponses,
      now,
    }),
  };
};

export const createProviderToolLlmClientNativeRunner = ({
  llmClient = null,
  provider = null,
  now = Date.now,
  fetchFn = null,
} = {}) => {
  const baseProvider = provider || llmClient?.provider || null;
  return {
    async runProviderToolRequest(request = {}, options = {}) {
      const continuationContext = readProviderToolContinuationContext(request);
      const providerObject = bindOpenCodeRequestContext(baseProvider,
        continuationContext?.providerRequestOptions?.requestContext
        || options.requestContext || { sessionId: request.sessionId });
      const runnerRequestDraft = {
        ok: true,
        status: 'ready',
        output: PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS.providerStreamEvents,
        network: false,
        writesChat: false,
        provider: request.provider,
        model: request.model,
        sessionId: request.sessionId,
        payloadKind: Array.isArray(request.contents)
          ? 'contents'
          : (Array.isArray(request.input)
              ? 'input'
              : (Array.isArray(request.messages) ? 'messages' : 'tool_results')),
        requestPreviewFormat: request.format,
        request,
      };
      const contract = resolveProviderToolNativeRunnerContract({ runnerRequestDraft });
      const base = {
        output: PROVIDER_TOOL_RUNNER_HANDOFF_OUTPUTS.providerStreamEvents,
        provider: trim(request.provider),
        model: trim(request.model || providerObject?.model),
        sessionId: trim(request.sessionId),
        network: true,
        writesChat: false,
        events: [],
        eventCount: 0,
        finalText: '',
        nativeRunnerShim: {
          status: contract.status,
          contractKind: trim(contract.contractKind),
          providerFamily: trim(contract.providerFamily),
          usesLlmClientProvider: Boolean(providerObject),
        },
      };
      if (!providerObject) {
        return {
          ...base,
          ok: false,
          status: 'blocked',
          reason: 'LLMClient provider missing for native runner shim',
        };
      }
      if (contract.ok !== true) {
        return {
          ...base,
          ok: false,
          status: trim(contract.status, 'unsupported'),
          reason: trim(contract.reason, 'provider-native runner contract is not ready'),
        };
      }
      const family = normalizeProviderFamily(request.provider || providerObject?.constructor?.name, request.format);
      if (family === 'openai') {
        if (contract.contractKind !== PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiResponses) {
          return {
            ...base,
            ok: false,
            status: 'unsupported',
            reason: 'OpenAI native message payloads should use streamChat/chat runner instead of LLMClient native shim',
          };
        }
      }
      if (family !== 'openai' && family !== 'anthropic' && family !== 'gemini') {
        return {
          ...base,
          ok: false,
          status: 'unsupported',
          reason: `LLMClient native shim does not support provider: ${family || '-'}`,
        };
      }
      const providerLabel = trim(request.provider || family).toLowerCase();
      const result = family === 'openai'
        ? await runOpenAIResponsesNativeRequest({ providerObject, request, options: { ...options, fetchFn }, now })
        : (family === 'anthropic'
            ? await runAnthropicNativeRequest({ providerObject, request, options: { ...options, fetchFn }, now })
            : await runGeminiNativeRequest({
                providerObject,
                request,
                options: { ...options, fetchFn },
                providerFamily: providerLabel.includes('vertex') ? 'vertexai' : (providerLabel.includes('maker') ? 'makersuite' : 'gemini'),
                now,
              }));
      return {
        ...base,
        ok: true,
        status: 'succeeded',
        reason: '',
        adapter: result.adapter,
        events: result.events,
        eventCount: result.events.length,
        finalText: result.finalText,
        nativeRunnerShim: {
          ...base.nativeRunnerShim,
          status: 'succeeded',
          adapter: result.adapter,
        },
        updatedAt: readTimestamp(now),
      };
    },
  };
};
