/**
 * OpenAI API 适配器
 */

import { finalizeTextRequestBody, getRequestParamReport } from '../request-params.js';
import { handleSSE } from '../stream.js';
import { createLinkedAbortController, invokeNativeHttpRequest, splitRequestOptions } from '../abort.js';
import {
  createReasoningStreamEvent,
  extractOpenAICompatibleStreamParts,
} from '../native-reasoning.js';
import { prepareTransportRequest } from '../transport.js';
import { reportProviderUsage } from '../provider-usage.js';
import { reportProviderWebSources } from '../web-search-runtime.js';
import { attachSafeProviderErrorMetadata } from '../provider-error-metadata.js';
import { isStreamOptionsRejectionError, streamUsageCompat } from '../stream-usage-compat.js';
import { emitDebugLog } from '../../utils/debug-log.js';
import {
  ensureTailAssistantPrefillUserTurn,
  isDeepSeekApiRequest,
  normalizeChatRole,
  normalizeDeepSeekReasonerMessages,
  resolveDeepSeekBetaBaseUrl,
} from './deepseek-compat.js';
import {
  chatResponses,
  prepareResponsesRequest,
  streamResponsesEvents,
  streamChatResponses,
} from './openai-responses-runtime.js';

const getTauriInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
  // Tauri v2 typically exposes __TAURI__.core.invoke; some builds expose __TAURI_INVOKE__.
  const inv =
    g?.__TAURI__?.core?.invoke ||
    g?.__TAURI__?.invoke ||
    g?.__TAURI_INVOKE__ ||
    g?.__TAURI_INTERNALS__?.invoke;
  return inv;
};

const isTauriWebview = () => {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
    const origin = String(g?.location?.origin || '');
    return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || origin.includes('tauri.localhost'));
  } catch (_e) {
    return false;
  }
};

const parseSSEText = function* (text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data);
    } catch (_e) {
      // ignore partial/invalid lines
    }
  }
};

const makeAbortError = () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeNonNegativeSeed = (value) => {
  if (String(value ?? '').trim() === '') return undefined;
  const seed = Math.trunc(Number(value));
  if (!Number.isFinite(seed) || seed < 0) return undefined;
  return seed;
};

const CACHE_DEBUG_RESPONSE_HEADER_KEYS = [
  'cf-cache-status',
  'x-cache',
  'x-cache-status',
  'x-request-id',
  'request-id',
  'x-openai-request-id',
];

const pickCacheDebugHeaders = (headers = {}) => {
  const src = headers && typeof headers === 'object' ? headers : {};
  const out = {};
  Object.entries(src).forEach(([rawKey, rawValue]) => {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!key) return;
    if (CACHE_DEBUG_RESPONSE_HEADER_KEYS.includes(key) || key.includes('cache')) {
      out[key] = String(rawValue ?? '').trim();
    }
  });
  return out;
};

const extractCacheDebugUsage = (body = {}) => {
  const usage = body?.usage && typeof body.usage === 'object' ? body.usage : {};
  const promptTokensDetails =
    usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? usage.prompt_tokens_details
      : {};
  const metrics = {};
  const assign = (key, value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    metrics[key] = num;
  };
  assign('prompt_tokens', usage?.prompt_tokens);
  assign('completion_tokens', usage?.completion_tokens);
  assign('total_tokens', usage?.total_tokens);
  assign('prompt_cache_hit_tokens', usage?.prompt_cache_hit_tokens);
  assign('prompt_cache_miss_tokens', usage?.prompt_cache_miss_tokens);
  assign('cache_creation_input_tokens', usage?.cache_creation_input_tokens);
  assign('cache_read_input_tokens', usage?.cache_read_input_tokens);
  assign('cached_tokens', usage?.cached_tokens);
  assign('prompt_cached_tokens', promptTokensDetails?.cached_tokens);
  assign('input_cached_tokens', usage?.input_cached_tokens);
  return metrics;
};

const formatCacheDebugHeaders = (headers = {}) => {
  const entries = Object.entries(headers || {}).filter(([, value]) => String(value || '').trim());
  if (!entries.length) return 'none';
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
};

const formatCacheDebugUsage = (usage = {}) => {
  const entries = Object.entries(usage || {}).filter(([, value]) => Number.isFinite(Number(value)));
  if (!entries.length) return 'none';
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
};

const pickOpenAICompatibleFinishReason = (body = {}) => {
  const direct = String(body?.finish_reason || body?.finishReason || body?.stop_reason || body?.stopReason || '').trim();
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const reasons = choices
    .map(choice => String(choice?.finish_reason || choice?.finishReason || choice?.stop_reason || choice?.stopReason || '').trim())
    .filter(Boolean);
  if (reasons.length) return reasons.join(',');
  return direct;
};

const emitOpenAIResponseDiagnostics = ({
  phase = '',
  provider = '',
  model = '',
  stream = false,
  transport = '',
  requestId = '',
  status = 0,
  payload = {},
  finishReason = '',
  outputChars = 0,
  reasoningChars = 0,
  deltaCount = 0,
  usageBody = null,
  errorMessage = '',
} = {}) => {
  if (typeof window === 'undefined') return;
  const maxTokens = Number.isFinite(Number(payload?.max_tokens)) ? Number(payload.max_tokens) : '';
  const maxCompletionTokens = Number.isFinite(Number(payload?.max_completion_tokens))
    ? Number(payload.max_completion_tokens)
    : '';
  const usage = usageBody && typeof usageBody === 'object'
    ? extractCacheDebugUsage(usageBody?.usage ? usageBody : { usage: usageBody })
    : {};
  const message = [
    `phase=${phase || '-'}`,
    `provider=${String(provider || '').trim() || '-'}`,
    `model=${String(model || '').trim() || '-'}`,
    `stream=${stream ? 1 : 0}`,
    `transport=${String(transport || '').trim() || '-'}`,
    `status=${Number(status || 0)}`,
    `finish_reason=${String(finishReason || '').trim() || '-'}`,
    `output_chars=${Math.max(0, Math.trunc(Number(outputChars) || 0))}`,
    `reasoning_chars=${Math.max(0, Math.trunc(Number(reasoningChars) || 0))}`,
    `deltas=${Math.max(0, Math.trunc(Number(deltaCount) || 0))}`,
    `max_tokens=${maxTokens || '-'}`,
    `max_completion_tokens=${maxCompletionTokens || '-'}`,
    `timeout_ms=${Number.isFinite(Number(payload?.__timeoutMs)) ? Number(payload.__timeoutMs) : '-'}`,
    `usage=${formatCacheDebugUsage(usage)}`,
    `requestId=${String(requestId || '').trim() || '-'}`,
    errorMessage ? `error=${String(errorMessage || '').replace(/\s+/g, ' ').slice(0, 240)}` : '',
  ].filter(Boolean).join(' ');
  console.info('[openai-response-diagnostics]', message);
  emitDebugLog({
    source: 'openai-response-diagnostics',
    type: errorMessage ? 'warn' : 'info',
    message,
    force: true,
  });
};

const imageGenerationModelSupportsResponseFormat = (model = '') => {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return true;
  // The newer gpt-image family returns base64 image data by default and rejects response_format.
  if (raw.startsWith('gpt-image')) return false;
  return true;
};

const isOpenAIGptImageModel = (model = '') => {
  const raw = String(model || '').trim().toLowerCase();
  return raw.startsWith('gpt-image');
};

const normalizeImageReferenceInputs = (referenceImages = []) => {
  return (Array.isArray(referenceImages) ? referenceImages : [])
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      return String(item?.image_url || item?.imageUrl || item?.url || item?.dataUrl || '').trim();
    })
    .filter(Boolean)
    .slice(0, 16);
};

const openAIChatModelUsesMaxCompletionTokens = (model = '') => {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.startsWith('gpt-5') || raw.startsWith('o1') || raw.startsWith('o3') || raw.startsWith('o4');
};

const openAIChatModelHasRestrictedSampling = (model = '') => openAIChatModelUsesMaxCompletionTokens(model);

const emitOpenAICacheDebug = ({
  phase = 'response',
  provider = '',
  model = '',
  url = '',
  stream = false,
  requestId = '',
  status = 0,
  headers = {},
  body = null,
} = {}) => {
  const pickedHeaders = pickCacheDebugHeaders(headers);
  const usage = extractCacheDebugUsage(body);
  emitDebugLog({
    source: 'llm-cache',
    type: 'info',
    message:
      `phase=${phase} provider=${String(provider || '').trim() || '-'} model=${String(model || '').trim() || '-'} ` +
      `stream=${stream ? 1 : 0} status=${Number(status || 0)} requestId=${String(requestId || '').trim() || '-'} ` +
      `url=${String(url || '').trim() || '-'} headers=${formatCacheDebugHeaders(pickedHeaders)} usage=${formatCacheDebugUsage(usage)}`,
  });
};

const estimateOpenAIRequestChars = ({ model, messages, stream, options } = {}) => {
  const arr = Array.isArray(messages) ? messages : [];
  let n = 0;
  n += String(model || '').length + 64;
  n += stream ? 32 : 16;
  n += (options && typeof options === 'object') ? 256 : 0;
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    n += 64;
    if (typeof m.role === 'string') n += m.role.length;
    if (typeof m.name === 'string') n += m.name.length;
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') n += part.text.length;
        const imageUrl = part?.image_url?.url;
        if (typeof imageUrl === 'string') n += imageUrl.length;
        const audioData = part?.input_audio?.data;
        if (typeof audioData === 'string') n += audioData.length;
      }
    } else if (typeof m.content === 'string') {
      n += m.content.length;
    }
  }
  return n;
};

const normalizeDeepSeekPrefixRequest = (raw) => {
  const src = raw && typeof raw === 'object' ? raw : null;
  if (!src) return null;
  const prefix = typeof src.prefix === 'string' ? src.prefix : '';
  if (!prefix) return null;
  const reasoningContent = typeof src.reasoningContent === 'string' ? src.reasoningContent : '';
  const mode = String(src.mode || 'assistant_prefill').trim().toLowerCase() || 'assistant_prefill';
  return {
    mode,
    prefix,
    reasoningContent,
  };
};

const isOpenAIResponsesRequested = (options = {}) => (
  String(options?.openaiApi || options?.openai_api || '').trim().toLowerCase() === 'responses'
);


const buildMessageRoleWindow = (messages, index, radius = 4) => {
  const arr = Array.isArray(messages) ? messages : [];
  const idx = Math.trunc(Number(index));
  if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(arr.length, idx + radius + 1);
  return arr
    .slice(start, end)
    .map((msg, offset) => {
      const absolute = start + offset;
      const marker = absolute === idx ? '*' : '';
      return `${marker}${absolute}:${normalizeChatRole(msg?.role || 'system')}`;
    })
    .join(' | ');
};

const attachMessageIndexDiagnostics = (error, messages) => {
  const text = String(error?.message || '');
  const match = text.match(/message index\s+(\d+)/i);
  if (!match) return error;
  const roleWindow = buildMessageRoleWindow(messages, Number(match[1]));
  if (!roleWindow) return error;
  error.message = `${text} [payload roles: ${roleWindow}]`;
  error.requestMessageRoles = roleWindow;
  return error;
};

export class OpenAIProvider {
  constructor(config) {
    this.transportConfig = config || {};
    this.provider = config.provider || 'openai';
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.model = config.model || 'gpt-3.5-turbo';
    this.timeout = config.timeout || 60000;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  canUseNativeHttp() {
    try {
      return typeof getTauriInvoker() === 'function';
    } catch (_e) {
      return false;
    }
  }

  normalizeOptions(options = {}) {
    const src = (options && typeof options === 'object') ? options : {};
    const out = {};
    const isDeepSeek = isDeepSeekApiRequest({
      provider: this.provider,
      model: this.model,
      baseUrl: this.baseUrl,
    });
    const isOpenAIRestrictedSampling =
      this.provider === 'openai' && openAIChatModelHasRestrictedSampling(this.model);

    // Common OpenAI-compatible parameters
    if (!isOpenAIRestrictedSampling) {
      if (typeof src.temperature === 'number') out.temperature = src.temperature;
      if (typeof src.top_p === 'number') out.top_p = src.top_p;
      if (typeof src.presence_penalty === 'number') out.presence_penalty = src.presence_penalty;
      if (typeof src.frequency_penalty === 'number') out.frequency_penalty = src.frequency_penalty;
    }
    if (typeof src.reasoning_effort === 'string' && src.reasoning_effort.trim()) {
      out.reasoning_effort = String(src.reasoning_effort).trim();
    }
    if (src.reasoning && typeof src.reasoning === 'object' && !Array.isArray(src.reasoning)) {
      out.reasoning = { ...src.reasoning };
    }
    const responseFormat = src.response_format ?? src.responseFormat;
    if (typeof responseFormat === 'string' && responseFormat.trim()) {
      out.response_format = { type: responseFormat.trim() };
    } else if (
      responseFormat &&
      typeof responseFormat === 'object' &&
      !Array.isArray(responseFormat) &&
      typeof responseFormat.type === 'string' &&
      responseFormat.type.trim()
    ) {
      out.response_format = { ...responseFormat, type: responseFormat.type.trim() };
    }

    // Token limits. Newer OpenAI reasoning/chat models reject max_tokens and require max_completion_tokens.
    const tokenLimit = Number.isFinite(src.max_completion_tokens)
      ? Math.trunc(src.max_completion_tokens)
      : Number.isFinite(src.max_tokens)
        ? Math.trunc(src.max_tokens)
        : Number.isFinite(src.maxTokens)
          ? Math.trunc(src.maxTokens)
          : null;
    if (Number.isFinite(tokenLimit)) {
      if (this.provider === 'openai' && openAIChatModelUsesMaxCompletionTokens(this.model)) {
        out.max_completion_tokens = tokenLimit;
      } else {
        out.max_tokens = tokenLimit;
      }
    }

    // stop can be string or array
    if (typeof src.stop === 'string' || Array.isArray(src.stop)) out.stop = src.stop;
    if (Array.isArray(src.tools) && src.tools.length) out.tools = src.tools;
    if (Object.prototype.hasOwnProperty.call(src, 'tool_choice')) out.tool_choice = src.tool_choice;
    if (typeof src.parallel_tool_calls === 'boolean') out.parallel_tool_calls = src.parallel_tool_calls;
    if (
      this.provider === 'openrouter'
      && src.provider
      && typeof src.provider === 'object'
      && !Array.isArray(src.provider)
    ) {
      out.provider = { ...src.provider };
    }
    if (Number.isFinite(src.max_tool_calls)) {
      out.max_tool_calls = Math.max(1, Math.trunc(src.max_tool_calls));
    }

    // Some servers reject unsupported fields (DeepSeek is stricter).
    if (isDeepSeek) {
      const thinkingType = String(src?.thinking?.type || '').trim().toLowerCase();
      if (thinkingType === 'enabled' || thinkingType === 'disabled') {
        out.thinking = { type: thinkingType };
      }
    } else if (!isOpenAIRestrictedSampling) {
      if (Number.isFinite(src.n)) out.n = Math.trunc(src.n);
      const seed = normalizeNonNegativeSeed(src.seed);
      if (seed !== undefined) out.seed = seed;
    }

    return out;
  }

  extractErrorDetail(bodyText) {
    const raw = String(bodyText ?? '').trim();
    if (!raw) return '';
    try {
      const j = JSON.parse(raw);
      const msg = j?.error?.message || j?.message || j?.detail || j?.error || '';
      if (msg) return String(msg);
    } catch (_e) {}
    return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
  }

  prepareChatRequest(messages, options = {}) {
    if (isOpenAIResponsesRequested(options)) {
      return this.prepareResponsesRequest(messages, options, { stream: options.stream === true });
    }
    const { signal, requestId, onProviderToolCallDelta, onProviderSources, options: rawPayloadOptions } = splitRequestOptions(options);
    const payloadOptions = (rawPayloadOptions && typeof rawPayloadOptions === 'object') ? { ...rawPayloadOptions } : {};
    const deepseekPrefix = normalizeDeepSeekPrefixRequest(payloadOptions.deepseekPrefix);
    delete payloadOptions.deepseekPrefix;

    const normalizedOptions = this.normalizeOptions(payloadOptions);
    const requestInfo = {
      provider: this.provider,
      model: this.model,
      baseUrl: this.baseUrl,
    };
    const reasonerCompat = normalizeDeepSeekReasonerMessages(messages, requestInfo);
    let payloadMessages = Array.isArray(reasonerCompat.messages) ? reasonerCompat.messages.slice() : [];
    let prefixCompat = { inserted: false };
    let requestBaseUrl = this.baseUrl;
    let responsePrefix = '';

    if (deepseekPrefix && isDeepSeekApiRequest(requestInfo)) {
      requestBaseUrl = resolveDeepSeekBetaBaseUrl(this.baseUrl);
      responsePrefix = deepseekPrefix.prefix;
      payloadMessages.push({
        role: 'assistant',
        content: deepseekPrefix.prefix,
        prefix: true,
        ...(deepseekPrefix.reasoningContent ? { reasoning_content: deepseekPrefix.reasoningContent } : {}),
      });
      prefixCompat = ensureTailAssistantPrefillUserTurn(payloadMessages);
      payloadMessages = prefixCompat.messages;
    }

    const basePayload = { model: this.model, messages: payloadMessages, ...normalizedOptions, stream: options.stream === true };
    const payload = finalizeTextRequestBody(options.stream === true
      ? streamUsageCompat.applyStreamUsageOptions(basePayload, this.baseUrl) : basePayload,
      { config: this.transportConfig, options, protocol: 'chat_completions' });

    return {
      signal,
      requestId,
      onProviderToolCallDelta,
      onProviderSources,
      url: `${requestBaseUrl}/chat/completions`,
      payload,
      body: payload,
      parameterReport: getRequestParamReport(payload),
      messages: payloadMessages,
      normalizedOptions,
      responsePrefix,
      compat: {
        reasoner: reasonerCompat,
        prefix: prefixCompat,
        prefixMode: deepseekPrefix?.mode || '',
        usesDeepSeekPrefix: Boolean(deepseekPrefix && isDeepSeekApiRequest(requestInfo)),
      },
    };
  }

  async request({ url, method = 'GET', headers = {}, body = undefined, signal, requestId = '' } = {}) {
    const prepared = prepareTransportRequest({
      config: this.transportConfig,
      provider: this.provider,
      url,
      headers,
    });
    const mergedHeaders = { ...(prepared.headers || {}) };
    const invoker = getTauriInvoker();
    if (typeof invoker === 'function') {
      if (signal?.aborted) throw makeAbortError();
      try {
        return await invokeNativeHttpRequest({
          invoker,
          signal,
          requestId,
          args: {
            url: prepared.url,
            method,
            headers: mergedHeaders,
            body: typeof body === 'string' ? body : body == null ? null : String(body),
            timeoutMs: this.timeout,
          },
        });
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw makeAbortError();
        if (isTauriWebview()) {
          const e = new Error(`native http_request failed: ${err?.message || err}`);
          e.cause = err;
          throw e;
        }
        console.warn('native http_request failed, fallback to fetch:', err);
      }
    }

    const { controller, cleanup } = createLinkedAbortController({ timeoutMs: this.timeout, signal });
    try {
      const response = await fetch(prepared.url, {
        method,
        headers: mergedHeaders,
        signal: controller.signal,
        body,
      });
      const text = await response.text();
      const outHeaders = {};
      response.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      return { status: response.status, ok: response.ok, headers: outHeaders, body: text };
    } finally {
      cleanup();
    }
  }

  async requestJson({ url, method = 'GET', headers = {}, body = undefined, signal, requestId = '' } = {}) {
    const res = await this.request({ url, method, headers, body, signal, requestId });
    if (!res.ok) {
      const detail = this.extractErrorDetail(res.body);
      const error = new Error(`OpenAI API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
      error.status = res.status;
      error.response = res.body;
      throw attachSafeProviderErrorMetadata(error, res.body);
    }
    try {
      return JSON.parse(res.body || '{}');
    } catch (e) {
      const error = new Error(`Invalid JSON response: ${e.message}`);
      error.status = res.status;
      error.response = res.body;
      throw error;
    }
  }

  /**
   * 发送聊天消息（非流式）
   */
  async chatResponses(messages, options = {}) {
    return chatResponses(this, messages, options);
  }

  prepareResponsesRequest(messages, options = {}, settings = {}) {
    return prepareResponsesRequest(this, messages, options, settings);
  }

  async *streamResponsesEvents(prepared = {}) {
    yield* streamResponsesEvents(this, prepared);
  }

  async *streamChatResponses(messages, options = {}) {
    yield* streamChatResponses(this, messages, options, emitOpenAIResponseDiagnostics);
  }

  async chat(messages, options = {}) {
    if (isOpenAIResponsesRequested(options)) {
      return this.chatResponses(messages, options);
    }
    const prepared = this.prepareChatRequest(messages, { ...options, stream: false });
    const { signal, requestId } = prepared;
    messages = prepared.messages;
    const normalized = prepared.normalizedOptions;
    if (prepared.compat.reasoner.changed) {
      console.warn(
        `DeepSeek reasoner request normalized: merged=${prepared.compat.reasoner.merged}, separated=${prepared.compat.reasoner.separated}, systemToUser=${prepared.compat.reasoner.systemToUser}`,
      );
    }
    if (prepared.compat.prefix.inserted) {
      console.warn('DeepSeek prefix completion inserted a blank user turn before tail assistant prefill');
    }
    const estimatedChars = estimateOpenAIRequestChars({
      model: this.model,
      messages,
      stream: false,
      options: normalized,
    });
    if (estimatedChars > 1_800_000) {
      throw new Error(
        `请求过大（约 ${Math.round(estimatedChars / 1024)} KB），可能导致 Android WebView OOM；请减少历史/摘要/世界书注入或清理该聊天室。`,
      );
    }
    let res;
    let data;
    try {
      res = await this.request({
        url: prepared.url,
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(prepared.payload),
        signal,
        requestId,
      });
      if (!res.ok) {
        const detail = this.extractErrorDetail(res.body);
        const error = new Error(`OpenAI API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
        error.status = res.status;
        error.response = res.body;
        throw attachSafeProviderErrorMetadata(error, res.body);
      }
      try {
        data = JSON.parse(res.body || '{}');
      } catch (e) {
        const error = new Error(`Invalid JSON response: ${e.message}`);
        error.status = res.status;
        error.response = res.body;
        throw error;
      }
    } catch (error) {
      emitOpenAIResponseDiagnostics({
        phase: 'chat-error',
        provider: this.provider,
        model: this.model,
        stream: false,
        transport: this.canUseNativeHttp() ? 'native-http' : 'fetch',
        requestId,
        status: res?.status || error?.status || 0,
        payload: { ...prepared.payload, __timeoutMs: this.timeout },
        finishReason: data ? pickOpenAICompatibleFinishReason(data) : '',
        outputChars: 0,
        usageBody: data,
        errorMessage: error?.message || String(error || ''),
      });
      throw attachMessageIndexDiagnostics(error, messages);
    }
    emitOpenAICacheDebug({
      phase: 'chat',
      provider: this.provider,
      model: this.model,
      url: prepared.url,
      stream: false,
      requestId,
      status: res?.status,
      headers: res?.headers,
      body: data,
    });

    try {
      prepared.onProviderToolCallDelta?.(data, { provider: this.provider, model: this.model });
    } catch {}
    reportProviderWebSources(options, data, { provider: this.provider });

    const content = data.choices?.[0]?.message?.content ?? '';
    const { reasoning } = extractOpenAICompatibleStreamParts({ delta: data.choices?.[0]?.message });
    emitOpenAIResponseDiagnostics({
      phase: 'chat',
      provider: this.provider,
      model: this.model,
      stream: false,
      transport: this.canUseNativeHttp() ? 'native-http' : 'fetch',
      requestId,
      status: res?.status,
      payload: { ...prepared.payload, __timeoutMs: this.timeout },
      finishReason: pickOpenAICompatibleFinishReason(data),
      outputChars: typeof content === 'string' ? content.length : String(content ?? '').length,
      reasoningChars: reasoning.length,
      usageBody: data,
    });

    reportProviderUsage(options, {
      body: data,
      model: this.model,
      provider: this.provider,
      finishReason: pickOpenAICompatibleFinishReason(data),
    });

    return content;
  }

  /**
   * 流式聊天
   */
  // 流式带 stream_options.include_usage 才能拿到 usage 校准样本；严格中转对该字段
  // 报 4xx 点名拒绝时，记忆该端点并去掉重试一次（拒绝发生在首个增量之前，重启安全）。
  async *streamChat(messages, options = {}) {
    if (isOpenAIResponsesRequested(options)) {
      yield* this.streamChatResponses(messages, options);
      return;
    }
    // 只在尚未产出任何增量时才允许去掉 stream_options 重试一次：
    // 已产出的增量无法收回，整段重跑会把开头内容重复发给用户。
    let yieldedAny = false;
    try {
      for await (const delta of this.streamChatUnguarded(messages, options)) {
        yieldedAny = true;
        yield delta;
      }
    } catch (error) {
      if (
        !yieldedAny
        && isStreamOptionsRejectionError(error)
        && !streamUsageCompat.isMarkedUnsupported(this.baseUrl)
      ) {
        streamUsageCompat.markUnsupported(this.baseUrl);
        yield* this.streamChatUnguarded(messages, options);
        return;
      }
      throw error;
    }
  }

  async *streamChatUnguarded(messages, options = {}) {
    const prepared = this.prepareChatRequest(messages, { ...options, stream: true });
    const { signal, requestId } = prepared;
    const notifyProviderToolCallDelta = data => {
      try {
        prepared.onProviderToolCallDelta?.(data, { provider: this.provider, model: this.model });
      } catch {}
    };
    const notifyProviderSources = data => reportProviderWebSources(options, data, { provider: this.provider });
    messages = prepared.messages;
    const normalized = prepared.normalizedOptions;
    if (prepared.compat.reasoner.changed) {
      console.warn(
        `DeepSeek reasoner stream request normalized: merged=${prepared.compat.reasoner.merged}, separated=${prepared.compat.reasoner.separated}, systemToUser=${prepared.compat.reasoner.systemToUser}`,
      );
    }
    if (prepared.compat.prefix.inserted) {
      console.warn('DeepSeek prefix completion inserted a blank user turn before tail assistant prefill');
    }
    const estimatedChars = estimateOpenAIRequestChars({
      model: this.model,
      messages,
      stream: true,
      options: normalized,
    });
    if (estimatedChars > 1_800_000) {
      throw new Error(
        `请求过大（约 ${Math.round(estimatedChars / 1024)} KB），可能导致 Android WebView OOM；请减少历史/摘要/世界书注入或清理该聊天室。`,
      );
    }
    const payload = JSON.stringify(prepared.payload);
    const transport = prepareTransportRequest({
      config: this.transportConfig,
      provider: this.provider,
      url: prepared.url,
      headers: { ...this.getHeaders(), Accept: 'text/event-stream' },
    });

    if (this.canUseNativeHttp()) {
      const invoker = getTauriInvoker();
      const nativeStreamRequestId = String(
        requestId || `http_stream_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
      ).trim();
      let started = false;
      let responseStatus = null;
      let responseOk = null;
      let rawErrorBody = '';
      let sseBuffer = '';
      let lastUsage = null;
      let lastFinishReason = '';
      let outputChars = 0;
      let reasoningChars = 0;
      let deltaCount = 0;
      const emitParsedDelta = function* (data) {
        notifyProviderToolCallDelta(data);
        notifyProviderSources(data);
        if (data?.usage && typeof data.usage === 'object') lastUsage = data;
        const finishReason = pickOpenAICompatibleFinishReason(data);
        if (finishReason) lastFinishReason = finishReason;
        const parts = extractOpenAICompatibleStreamParts(data);
        if (parts.content || parts.reasoning || finishReason) deltaCount += 1;
        if (parts.reasoning) {
          reasoningChars += parts.reasoning.length;
          yield createReasoningStreamEvent(parts.reasoning, { provider: 'openai' });
        }
        if (parts.content) {
          outputChars += parts.content.length;
          yield parts.content;
        }
      };
      const flushSseBuffer = function* (final = false) {
        const lines = String(sseBuffer || '').split('\n');
        sseBuffer = final ? '' : (lines.pop() || '');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payloadText = line.slice(6).trim();
          if (!payloadText || payloadText === '[DONE]') continue;
          try {
            const data = JSON.parse(payloadText);
            yield* emitParsedDelta(data);
          } catch (_e) {}
        }
      };
      try {
        if (signal?.aborted) throw makeAbortError();
        await invoker('http_stream_request_start', {
          url: transport.url,
          method: 'POST',
          headers: transport.headers,
          body: payload,
          timeoutMs: this.timeout,
          requestId: nativeStreamRequestId,
        });
        started = true;

        while (true) {
          if (signal?.aborted) throw makeAbortError();
          const batch = await invoker('http_stream_request_read', {
            requestId: nativeStreamRequestId,
            maxChunks: 32,
          });
          if (Number.isFinite(Number(batch?.status))) responseStatus = Number(batch.status);
          if (typeof batch?.ok === 'boolean') responseOk = batch.ok;

          const chunks = Array.isArray(batch?.chunks) ? batch.chunks.map((chunk) => String(chunk || '')) : [];
          if (responseOk === false) {
            rawErrorBody += chunks.join('');
          } else {
            for (const chunk of chunks) {
              sseBuffer += chunk;
              yield* flushSseBuffer(false);
            }
          }

          const nativeError = String(batch?.error || '').trim();
          if (nativeError) {
            if (/aborted/i.test(nativeError)) throw makeAbortError();
            const error = new Error(`native http_stream_request failed: ${nativeError}`);
            error.status = Number.isFinite(responseStatus) ? responseStatus : 0;
            error.response = rawErrorBody;
            throw error;
          }

          if (batch?.done) {
            if (responseOk === false) {
              const detail = this.extractErrorDetail(rawErrorBody);
              const error = new Error(`OpenAI API Error: ${responseStatus || 0}${detail ? ` - ${detail}` : ''}`);
              error.status = responseStatus || 0;
              error.response = rawErrorBody;
              throw attachSafeProviderErrorMetadata(error, rawErrorBody);
            }
            yield* flushSseBuffer(true);
            emitOpenAICacheDebug({
              phase: 'stream-native',
              provider: this.provider,
              model: this.model,
              url: transport.url,
              stream: true,
              requestId: nativeStreamRequestId,
              status: responseStatus || 0,
              headers: {},
              body: lastUsage,
            });
            emitOpenAIResponseDiagnostics({
              phase: 'stream-native',
              provider: this.provider,
              model: this.model,
              stream: true,
              transport: 'native-stream',
              requestId: nativeStreamRequestId,
              status: responseStatus || 0,
              payload: { ...prepared.payload, __timeoutMs: this.timeout },
              finishReason: lastFinishReason,
              outputChars,
              reasoningChars,
              deltaCount,
              usageBody: lastUsage,
            });
            reportProviderUsage(options, {
              body: lastUsage,
              model: this.model,
              provider: this.provider,
              finishReason: lastFinishReason,
            });
            return;
          }

          if (!chunks.length) {
            await delay(20);
          }
        }
      } catch (error) {
        emitOpenAIResponseDiagnostics({
          phase: 'stream-native-error',
          provider: this.provider,
          model: this.model,
          stream: true,
          transport: 'native-stream',
          requestId: nativeStreamRequestId,
          status: responseStatus || 0,
          payload: { ...prepared.payload, __timeoutMs: this.timeout },
          finishReason: lastFinishReason,
          outputChars,
          reasoningChars,
          deltaCount,
          usageBody: lastUsage,
          errorMessage: error?.message || String(error || ''),
        });
        throw attachMessageIndexDiagnostics(error, messages);
      } finally {
        if (started) {
          invoker('http_stream_request_close', { requestId: nativeStreamRequestId }).catch(() => {});
        }
      }
    }

    const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs: this.timeout, signal, idle: true });
    let responseStatus = 0;
    let responseHeaders = {};
    let lastUsage = null;
    let lastFinishReason = '';
    let outputChars = 0;
    let reasoningChars = 0;
    let deltaCount = 0;
    try {
      const response = await fetch(transport.url, {
        method: 'POST',
        headers: transport.headers,
        signal: controller.signal,
        body: payload,
      });
      responseStatus = response.status;

      if (!response.ok) {
        const txt = await response.text();
        const detail = this.extractErrorDetail(txt);
        const error = new Error(`OpenAI API Error: ${response.status}${detail ? ` - ${detail}` : ''}`);
        error.status = response.status;
        error.response = txt;
        throw attachMessageIndexDiagnostics(
          attachSafeProviderErrorMetadata(error, txt),
          messages,
        );
      }

      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      for await (const data of handleSSE(response)) {
        touch();
        notifyProviderToolCallDelta(data);
        notifyProviderSources(data);
        if (data?.usage && typeof data.usage === 'object') lastUsage = data;
        const finishReason = pickOpenAICompatibleFinishReason(data);
        if (finishReason) lastFinishReason = finishReason;
        const parts = extractOpenAICompatibleStreamParts(data);
        if (parts.content || parts.reasoning || finishReason) deltaCount += 1;
        if (parts.reasoning) {
          reasoningChars += parts.reasoning.length;
          yield createReasoningStreamEvent(parts.reasoning, { provider: 'openai' });
        }
        if (parts.content) {
          outputChars += parts.content.length;
          yield parts.content;
        }
      }
      emitOpenAICacheDebug({
        phase: 'stream-fetch',
        provider: this.provider,
        model: this.model,
        url: transport.url,
        stream: true,
        requestId,
        status: response?.status,
        headers: responseHeaders,
        body: lastUsage,
      });
      emitOpenAIResponseDiagnostics({
        phase: 'stream-fetch',
        provider: this.provider,
        model: this.model,
        stream: true,
        transport: 'fetch-stream',
        requestId,
        status: responseStatus,
        payload: { ...prepared.payload, __timeoutMs: this.timeout },
        finishReason: lastFinishReason,
        outputChars,
        reasoningChars,
        deltaCount,
        usageBody: lastUsage,
      });
      reportProviderUsage(options, {
        body: lastUsage,
        model: this.model,
        provider: this.provider,
        finishReason: lastFinishReason,
      });
    } catch (error) {
      emitOpenAIResponseDiagnostics({
        phase: 'stream-fetch-error',
        provider: this.provider,
        model: this.model,
        stream: true,
        transport: 'fetch-stream',
        requestId,
        status: responseStatus,
        payload: { ...prepared.payload, __timeoutMs: this.timeout },
        finishReason: lastFinishReason,
        outputChars,
        reasoningChars,
        deltaCount,
        usageBody: lastUsage,
        errorMessage: error?.message || String(error || ''),
      });
      throw error;
    } finally {
      cleanup();
    }
  }

  /**
   * 生成图片
   * @param {string} prompt
   * @param {Object} options
   */
  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    let outputFormat = String(options.outputFormat || options.output_format || 'png').toLowerCase();
    if (isOpenAIGptImageModel(this.model) && options.background === 'transparent' && outputFormat === 'jpeg') {
      outputFormat = 'png';
      options = { ...options, outputFormat, output_format: outputFormat };
    }
    if (outputFormat === 'png') {
      options = { ...options };
      delete options.outputCompression;
      delete options.output_compression;
    }
    const referenceImages = normalizeImageReferenceInputs(options.referenceImages);
    if (referenceImages.length) {
      if (!isOpenAIGptImageModel(this.model)) {
        throw new Error(`当前 OpenAI 图片模型不支持参考图: ${this.model}`);
      }
      const payload = {
        model: this.model,
        prompt: String(prompt || '').trim(),
        images: referenceImages.map(imageUrl => ({ image_url: imageUrl })),
        n: Number.isFinite(options.n) ? Math.trunc(options.n) : 1,
      };
      if (options.size) payload.size = options.size;
      if (options.quality) payload.quality = options.quality;
      if (options.background) payload.background = options.background;
      if (options.outputFormat || options.output_format) {
        payload.output_format = options.outputFormat || options.output_format;
      }
      if (Number.isFinite(options.outputCompression) || Number.isFinite(options.output_compression)) {
        payload.output_compression = Number.isFinite(options.outputCompression)
          ? Math.trunc(options.outputCompression)
          : Math.trunc(options.output_compression);
      }
      if (options.moderation) payload.moderation = options.moderation;
      if (options.user) payload.user = options.user;

      const data = await this.requestJson({
        url: `${this.baseUrl}/images/edits`,
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal,
      });

      const list = Array.isArray(data?.data) ? data.data : [];
      return list.map((item, index) => {
        const b64 = item?.b64_json || item?.b64 || '';
        if (b64) {
          return { dataUrl: `data:image/${data.output_format || outputFormat};base64,${b64}`, index };
        }
        const url = String(item?.url || '').trim();
        return { url, index };
      });
    }

    const payload = {
      model: this.model,
      prompt: String(prompt || '').trim(),
      n: Number.isFinite(options.n) ? Math.trunc(options.n) : 1,
    };
    const responseFormat = options.responseFormat || options.response_format || '';
    if (responseFormat && imageGenerationModelSupportsResponseFormat(this.model)) {
      payload.response_format = responseFormat;
    }
    if (options.size) payload.size = options.size;
    if (options.quality) payload.quality = options.quality;
    if (options.style && !isOpenAIGptImageModel(this.model)) payload.style = options.style;
    if (isOpenAIGptImageModel(this.model)) {
      if (options.background) payload.background = options.background;
      if (options.outputFormat || options.output_format) {
        payload.output_format = options.outputFormat || options.output_format;
      }
      if (Number.isFinite(options.outputCompression) || Number.isFinite(options.output_compression)) {
        payload.output_compression = Number.isFinite(options.outputCompression)
          ? Math.trunc(options.outputCompression)
          : Math.trunc(options.output_compression);
      }
      if (options.moderation) payload.moderation = options.moderation;
      if (options.user) payload.user = options.user;
    }

    const data = await this.requestJson({
      url: `${this.baseUrl}/images/generations`,
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map((item, index) => {
      const b64 = item?.b64_json || item?.b64 || '';
      if (b64) {
        return { dataUrl: `data:image/${data.output_format || outputFormat};base64,${b64}`, index };
      }
      const url = String(item?.url || '').trim();
      return { url, index };
    });
  }

  /**
   * 获取可用模型列表
   */
  async listModels() {
    const data = await this.requestJson({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: this.getHeaders(),
    });

    return (data.data || []).filter(m => m.id.includes('gpt')).map(m => m.id);
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      await this.listModels();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
