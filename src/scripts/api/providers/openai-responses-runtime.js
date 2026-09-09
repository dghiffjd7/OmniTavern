// Shared Responses wire adapter for official and explicitly configured compatible APIs.
// Protocol: https://developers.openai.com/api/docs/guides/migrate-to-responses
import { finalizeTextRequestBody, getRequestParamReport } from '../request-params.js';
import { handleSSE, parseSSEBuffer } from '../stream.js';
import { createLinkedAbortController, splitRequestOptions } from '../abort.js';
import { createReasoningStreamEvent } from '../native-reasoning.js';
import { prepareTransportRequest } from '../transport.js';
import { reportProviderUsage } from '../provider-usage.js';
import { reportProviderWebSources } from '../web-search-runtime.js';
import { attachSafeProviderErrorMetadata } from '../provider-error-metadata.js';
import { resolveOpenAIResponsesUrl } from '../openai-api-format.js';
import { buildOpenAIResponsesOptions, buildOpenAIResponsesRequestBody, extractOpenAIResponsesText } from './openai-responses-utils.js';

const getTauriInvoker = () => globalThis.__TAURI__?.core?.invoke || globalThis.__TAURI__?.invoke
  || globalThis.__TAURI_INVOKE__ || globalThis.__TAURI_INTERNALS__?.invoke;
const canUseNativeHttp = provider => typeof provider.canUseNativeHttp === 'function'
  ? provider.canUseNativeHttp() : typeof getTauriInvoker() === 'function';
const makeAbortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const extractErrorDetail = body => {
  const raw = String(body || '').trim();
  try { const data = JSON.parse(raw); return String(data?.error?.message || data?.message || data?.detail || data?.error || ''); }
  catch { return raw.slice(0, 240); }
};

export const assertResponsesSuccess = data => {
  if (data?.error || ['failed', 'cancelled'].includes(data?.status)) {
    const error = new Error(String(data?.error?.message || data?.error || `Responses ${data.status}`));
    error.response = data;
    throw attachSafeProviderErrorMetadata(error, data);
  }
  if (!Array.isArray(data?.output) && typeof data?.output_text !== 'string') {
    throw new Error('接口返回的内容不是 Responses 格式，请检查接口格式与地址');
  }
};

export async function chatResponses(provider, messages, options = {}) {
  const prepared = provider.prepareResponsesRequest(messages, options, { stream: false });
  const { signal, requestId, onProviderToolCallDelta, body } = prepared;
  if (signal?.aborted) throw makeAbortError();
  const data = await provider.requestJson({
    url: prepared.url,
    method: 'POST',
    headers: provider.getHeaders(),
    body: JSON.stringify(body),
    signal,
    requestId,
  });
  assertResponsesSuccess(data);
  try {
    onProviderToolCallDelta?.(data, { provider: provider.provider, model: provider.model, api: 'responses' });
  } catch {}
  reportProviderWebSources(options, data, { provider: provider.provider });
  reportProviderUsage(options, {
    body: data,
    model: provider.model,
    provider: provider.provider,
    finishReason: String(data?.incomplete_details?.reason || data?.status || ''),
  });
  return extractOpenAIResponsesText(data);
}

export function prepareResponsesRequest(provider, messages, options = {}, { stream = false } = {}) {
  const responsesUrl = resolveOpenAIResponsesUrl({
    ...provider.transportConfig, provider: provider.provider, baseUrl: provider.baseUrl,
  });
  if (!responsesUrl) {
    if (['custom', 'opencode'].includes(provider.provider)) throw new Error('请为 Responses 配置有效的 HTTP 或 HTTPS API 地址');
    throw new Error('Responses API requires an official api.openai.com or api.deepseek.com endpoint');
  }
  const {
    signal,
    requestId,
    onProviderToolCallDelta,
    onProviderSources,
    options: rawPayloadOptions,
  } = splitRequestOptions(options);
  const payloadOptions = { ...(rawPayloadOptions || {}) };
  delete payloadOptions.openaiApi;
  delete payloadOptions.openai_api;
  const body = finalizeTextRequestBody(buildOpenAIResponsesRequestBody({
    model: provider.model,
    messages,
    options: payloadOptions,
    stream,
  }), { config: provider.transportConfig, options, protocol: 'responses' });
  const estimatedChars = JSON.stringify(body).length;
  if (estimatedChars > 1_800_000) {
    throw new Error(
      `请求过大（约 ${Math.round(estimatedChars / 1024)} KB），可能导致 Android WebView OOM；请减少历史/摘要/世界书注入或清理该聊天室。`,
    );
  }
  return {
    signal,
    requestId,
    onProviderToolCallDelta,
    onProviderSources,
    url: responsesUrl,
    body,
    payload: body,
    parameterReport: getRequestParamReport(body),
    messages,
    normalizedOptions: buildOpenAIResponsesOptions(payloadOptions),
    responsePrefix: '',
  };
}

export async function* streamResponsesEvents(provider, prepared = {}) {
  const transport = prepareTransportRequest({
    config: provider.transportConfig,
    provider: provider.provider,
    url: prepared.url,
    headers: { ...provider.getHeaders(), Accept: 'text/event-stream' },
  });
  const payload = JSON.stringify(prepared.body || {});
  const { signal } = prepared;

  if (canUseNativeHttp(provider)) {
    const invoker = getTauriInvoker();
    const rawRequestId = String(
      prepared.requestId || `responses_stream_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
    ).trim();
    const nativeRequestId = rawRequestId.replace(/[^a-z0-9._-]+/giu, '_').slice(0, 160)
      || `responses_stream_${Date.now().toString(36)}`;
    let started = false;
    let responseStatus = 0;
    let responseOk = null;
    let rawErrorBody = '';
    let sseBuffer = '';
    const parseBufferedEvents = (final = false) => {
      const parsed = parseSSEBuffer(sseBuffer, { final });
      sseBuffer = parsed.rest;
      return parsed.events;
    };
    const close = () => {
      if (started) invoker('http_stream_request_close', { requestId: nativeRequestId }).catch(() => {});
    };
    try {
      if (signal?.aborted) throw makeAbortError();
      signal?.addEventListener('abort', close, { once: true });
      await invoker('http_stream_request_start', {
        url: transport.url,
        method: 'POST',
        headers: transport.headers,
        body: payload,
        timeoutMs: provider.timeout,
        requestId: nativeRequestId,
      });
      started = true;
      while (true) {
        if (signal?.aborted) throw makeAbortError();
        const batch = await invoker('http_stream_request_read', {
          requestId: nativeRequestId,
          maxChunks: 32,
        });
        if (signal?.aborted) throw makeAbortError();
        if (Number.isFinite(Number(batch?.status))) responseStatus = Number(batch.status);
        if (typeof batch?.ok === 'boolean') responseOk = batch.ok;
        const chunks = Array.isArray(batch?.chunks)
          ? batch.chunks.map(chunk => String(chunk || ''))
          : [];
        if (responseOk === false) {
          rawErrorBody = (rawErrorBody + chunks.join('')).slice(0, 65536);
        } else {
          for (const chunk of chunks) {
            sseBuffer += chunk;
            for (const event of parseBufferedEvents(false)) yield event;
          }
        }
        const nativeError = String(batch?.error || '').trim();
        if (nativeError) {
          if (/aborted/iu.test(nativeError)) throw makeAbortError();
          const error = new Error(`native http_stream_request failed: ${nativeError}`);
          error.status = responseStatus;
          error.response = rawErrorBody;
          throw error;
        }
        if (batch?.done) {
          if (responseOk === false) {
            const detail = extractErrorDetail(rawErrorBody);
            const error = new Error(`${provider.errorLabel || 'OpenAI API'} Error: ${responseStatus}${detail ? ` - ${detail}` : ''}`);
            error.status = responseStatus;
            error.response = rawErrorBody;
            throw attachSafeProviderErrorMetadata(error, rawErrorBody);
          }
          sseBuffer += '\n\n';
          for (const event of parseBufferedEvents(true)) yield event;
          return;
        }
        if (!chunks.length) await delay(20);
      }
    } finally {
      signal?.removeEventListener('abort', close);
      close();
    }
  }

  const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs: provider.timeout, signal, idle: true });
  try {
    const response = await fetch(transport.url, {
      method: 'POST',
      headers: transport.headers,
      signal: controller.signal,
      body: payload,
    });
    if (!response.ok) {
      const rawErrorBody = await response.text();
      const detail = extractErrorDetail(rawErrorBody);
      const error = new Error(`${provider.errorLabel || 'OpenAI API'} Error: ${response.status}${detail ? ` - ${detail}` : ''}`);
      error.status = response.status;
      error.response = rawErrorBody;
      throw attachSafeProviderErrorMetadata(error, rawErrorBody);
    }
    for await (const event of handleSSE(response)) {
      touch();
      yield event;
    }
  } finally {
    controller.abort();
    cleanup();
  }
}

export async function* streamChatResponses(provider, messages, options = {}, onDiagnostics = null) {
  const prepared = provider.prepareResponsesRequest(messages, options, { stream: true });
  let finalResponse = null;
  let outputChars = 0;
  let reasoningChars = 0;
  let deltaCount = 0;
  try {
    if (prepared.signal?.aborted) throw makeAbortError();
    for await (const event of provider.streamResponsesEvents(prepared)) {
      const type = String(event?.type || '').trim();
      if (type === 'error' || type === 'response.failed' || type === 'response.cancelled') {
        const detail = event?.error?.message || event?.response?.error?.message || event?.message || 'Responses stream failed';
        const error = new Error(String(detail));
        error.response = event;
        throw error;
      }
      try {
        prepared.onProviderToolCallDelta?.(event, {
          provider: provider.provider,
          model: provider.model,
          api: 'responses',
        });
      } catch {}
      reportProviderWebSources(options, event, { provider: provider.provider });
      deltaCount += 1;
      if (type === 'response.completed' || type === 'response.incomplete') finalResponse = event?.response || null;
      const reasoningDelta = (
        type === 'response.reasoning_summary_text.delta'
        || type === 'response.reasoning_text.delta'
      ) && typeof event?.delta === 'string'
        ? event.delta
        : '';
      if (reasoningDelta) {
        reasoningChars += reasoningDelta.length;
        yield createReasoningStreamEvent(reasoningDelta, { provider: provider.provider });
      }
      if (['response.output_text.delta', 'response.refusal.delta'].includes(type) && typeof event?.delta === 'string' && event.delta) {
        outputChars += event.delta.length;
        yield event.delta;
      }
    }
    if (!finalResponse) throw new Error('Responses 流在完成事件前中断，请重试');
    if (finalResponse) {
      assertResponsesSuccess(finalResponse);
      if (!outputChars) {
        const text = extractOpenAIResponsesText(finalResponse);
        if (text) { outputChars += text.length; yield text; }
      }
      reportProviderWebSources(options, finalResponse, { provider: provider.provider });
      reportProviderUsage(options, {
        body: finalResponse,
        model: provider.model,
        provider: provider.provider,
        finishReason: String(finalResponse?.incomplete_details?.reason || finalResponse?.status || ''),
      });
    }
    onDiagnostics?.({
      phase: 'responses-stream',
      provider: provider.provider,
      model: provider.model,
      stream: true,
      transport: canUseNativeHttp(provider) ? 'native-stream' : 'fetch-stream',
      requestId: prepared.requestId,
      status: finalResponse ? 200 : 0,
      payload: { ...prepared.body, __timeoutMs: provider.timeout },
      finishReason: String(finalResponse?.status || ''),
      outputChars,
      reasoningChars,
      deltaCount,
      usageBody: finalResponse,
    });
  } catch (error) {
    onDiagnostics?.({
      phase: 'responses-stream-error',
      provider: provider.provider,
      model: provider.model,
      stream: true,
      transport: canUseNativeHttp(provider) ? 'native-stream' : 'fetch-stream',
      requestId: prepared.requestId,
      status: error?.status || 0,
      payload: { ...prepared.body, __timeoutMs: provider.timeout },
      outputChars,
      reasoningChars,
      deltaCount,
      usageBody: finalResponse,
      errorMessage: error?.message || String(error || ''),
    });
    throw error;
  }
}
