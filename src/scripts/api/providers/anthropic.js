/**
 * Anthropic (Claude) API 适配器
 */

import { finalizeTextRequestBody, getRequestParamReport } from '../request-params.js';
import { handleSSE } from '../stream.js';
import { createLinkedAbortController, invokeNativeHttpRequest, splitRequestOptions } from '../abort.js';
import { createReasoningStreamEvent, extractAnthropicStreamParts } from '../native-reasoning.js';
import { prepareTransportRequest } from '../transport.js';
import { emitDebugLog } from '../../utils/debug-log.js';
import { reportProviderUsage } from '../provider-usage.js';
import { reportProviderWebSources } from '../web-search-runtime.js';
import { attachSafeProviderErrorMetadata } from '../provider-error-metadata.js';

const getTauriInvoker = () => {
    const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
    return (
        g?.__TAURI__?.core?.invoke ||
        g?.__TAURI__?.invoke ||
        g?.__TAURI_INVOKE__ ||
        g?.__TAURI_INTERNALS__?.invoke
    );
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
        } catch (_e) {}
    }
};

const makeAbortError = () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
};

const summarizeUrlForLog = (value) => {
    try {
        const parsed = new URL(String(value || ''));
        return `${parsed.origin}${parsed.pathname}`;
    } catch (_e) {
        return String(value || '');
    }
};

const logStreamDebug = (message, type = 'info') => {
    const text = String(message || '').trim();
    if (!text) return;
    emitDebugLog({ source: 'anthropic-stream', type, message: text, force: true });
    try {
        const fn = type === 'warn' || type === 'error' ? console.warn : console.info;
        fn(`[anthropic-stream] ${text}`);
    } catch (_e) {}
};

const isFetchNetworkFailure = (error) => {
    const name = String(error?.name || '').trim();
    const message = String(error?.message || '').trim();
    return name === 'TypeError' && /failed to fetch|load failed|networkerror/i.test(message);
};

const describeFetchFailure = (url, error) => {
    let origin = '';
    let originProtocol = '';
    let targetOrigin = '';
    let targetProtocol = '';
    let sameOrigin = false;
    let mixedContentRisk = false;
    let secureContext = false;
    try {
        const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
        origin = String(g?.location?.origin || '');
        originProtocol = String(g?.location?.protocol || '');
        secureContext = Boolean(g?.isSecureContext);
        const parsed = new URL(String(url || ''));
        targetOrigin = parsed.origin;
        targetProtocol = parsed.protocol;
        sameOrigin = Boolean(origin && parsed.origin === origin);
        mixedContentRisk = originProtocol === 'https:' && parsed.protocol === 'http:';
    } catch (_e) {}
    const name = String(error?.name || '').trim() || 'Error';
    const message = String(error?.message || '').trim() || String(error || '');
    return [
        `name=${name}`,
        `message=${message}`,
        `origin=${origin || 'unknown'}`,
        `target=${targetOrigin || summarizeUrlForLog(url)}`,
        `originProtocol=${originProtocol || 'unknown'}`,
        `targetProtocol=${targetProtocol || 'unknown'}`,
        `sameOrigin=${sameOrigin ? 1 : 0}`,
        `mixedContentRisk=${mixedContentRisk ? 1 : 0}`,
        `secureContext=${secureContext ? 1 : 0}`,
        `tauri=${isTauriWebview() ? 1 : 0}`,
    ].join(' ');
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ANTHROPIC_EMPTY_TEXT_PLACEHOLDER = '\u200b';
const normalizeAnthropicTextBlock = (value) => {
    const text = String(value ?? '');
    return text.trim().length ? text : ANTHROPIC_EMPTY_TEXT_PLACEHOLDER;
};

// Anthropic 流式 usage 分散在事件里：message_start 带 input_tokens 与 cache 字段，
// message_delta 带 output_tokens；逐事件合并成完整 usage 供计量上报。
export const collectAnthropicStreamUsage = (data, current = null) => {
    const eventUsage = data?.type === 'message_start' ? data?.message?.usage : data?.usage;
    if (!eventUsage || typeof eventUsage !== 'object') return current;
    return { ...(current || {}), ...eventUsage };
};

export class AnthropicProvider {
    constructor(config) {
        this.transportConfig = config || {};
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
        this.model = config.model || 'claude-3-5-sonnet-20241022';
        this.timeout = config.timeout || 60000;
        this.apiVersion = '2023-06-01';
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': this.apiVersion
        };
    }

    canUseNativeHttp() {
        try {
            return typeof getTauriInvoker() === 'function';
        } catch (_e) {
            return false;
        }
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

    async request({ url, method = 'GET', headers = {}, body = undefined, signal, requestId = '' } = {}) {
        const prepared = prepareTransportRequest({
            config: this.transportConfig,
            provider: 'anthropic',
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
            const error = new Error(`Anthropic API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
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
     * 转换消息格式（OpenAI -> Anthropic）
     */
    convertMessages(messages) {
        const parseDataUrl = (url) => {
            const raw = String(url || '').trim();
            if (!raw.startsWith('data:')) return null;
            const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
            if (!match) return null;
            return { mime: match[1], data: match[2] };
        };
        const toAnthropicContent = (content) => {
            if (Array.isArray(content)) {
                const parts = [];
                content.forEach((part) => {
                    if (!part || typeof part !== 'object') return;
                    if (part.type === 'text') {
                        parts.push({ type: 'text', text: normalizeAnthropicTextBlock(part.text) });
                        return;
                    }
                    if (part.type === 'image_url') {
                        const url = part?.image_url?.url;
                        const parsed = parseDataUrl(url);
                        if (parsed?.data) {
                            parts.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: parsed.mime || 'image/jpeg',
                                    data: parsed.data,
                                },
                            });
                        } else if (url) {
                            parts.push({ type: 'text', text: `[图片] ${String(url)}` });
                        }
                    }
                });
                return parts.length ? parts : [{ type: 'text', text: ANTHROPIC_EMPTY_TEXT_PLACEHOLDER }];
            }
            return [{ type: 'text', text: normalizeAnthropicTextBlock(content) }];
        };
        const toSystemText = (content) => {
            if (Array.isArray(content)) {
                return content
                    .map((part) => (part?.type === 'text' ? String(part.text || '') : ''))
                    .filter(Boolean)
                    .join('\n');
            }
            return String(content ?? '');
        };
        const systemMessages = messages.filter(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');

        const system = systemMessages.map(m => toSystemText(m.content)).join('\n');

        return {
            system: system || undefined,
            messages: otherMessages.map(m => ({
                role: m.role,
                content: toAnthropicContent(m.content),
            })),
        };
    }

    prepareChatRequest(messages, options = {}) {
        const { options: raw, ...runtime } = splitRequestOptions(options);
        const { maxTokens, ...payloadOptions } = raw;
        const converted = this.convertMessages(messages);
        const body = finalizeTextRequestBody({
            ...payloadOptions,
            model: this.model,
            messages: converted.messages,
            system: converted.system,
            max_tokens: maxTokens || payloadOptions.max_tokens || 4096,
            stream: options.stream === true,
        }, { config: this.transportConfig, options, protocol: 'anthropic' });
        return { ...runtime, body, payload: body, messages, url: `${this.baseUrl}/messages`,
            parameterReport: getRequestParamReport(body), responsePrefix: '' };
    }

    /**
     * 发送聊天消息（非流式）
     */
    async chat(messages, options = {}) {
        const prepared = this.prepareChatRequest(messages, { ...options, stream: false });
        const { signal, requestId, onProviderToolCallDelta } = prepared;

        const data = await this.requestJson({
            url: `${this.baseUrl}/messages`,
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(prepared.body),
            signal,
            requestId,
        });

        try {
            onProviderToolCallDelta?.(data, { provider: 'anthropic', model: this.model });
        } catch {}

        reportProviderWebSources(options, data, { provider: 'anthropic' });

        reportProviderUsage(options, {
            body: data,
            model: this.model,
            provider: 'anthropic',
            finishReason: String(data?.stop_reason || ''),
        });

        const textBlocks = Array.isArray(data?.content)
            ? data.content.filter((block) => block?.type === 'text' && typeof block?.text === 'string')
            : [];
        return textBlocks.map((block) => block.text).join('') || '';
    }

    /**
     * 流式聊天
     */
    async *streamChat(messages, options = {}) {
        const request = this.prepareChatRequest(messages, { ...options, stream: true });
        const { signal, requestId, onProviderToolCallDelta } = request;
        const payload = JSON.stringify(request.body);

        const prepared = prepareTransportRequest({
            config: this.transportConfig,
            provider: 'anthropic',
            url: `${this.baseUrl}/messages`,
            headers: { ...this.getHeaders(), Accept: 'text/event-stream' },
        });
        const useFetchStreaming = prepared.connectionMode === 'reverse_proxy';
        let deltaCount = 0;
        let totalChars = 0;
        let sawFirstDelta = false;
        let streamUsage = null;
        let streamStopReason = '';
        const blockKinds = new Map();
        const notifyProviderToolCallDelta = data => {
            try {
                onProviderToolCallDelta?.(data, { provider: 'anthropic', model: this.model });
            } catch {}
        };
        const reportStreamUsage = () => reportProviderUsage(options, {
            body: { usage: streamUsage },
            model: this.model,
            provider: 'anthropic',
            finishReason: streamStopReason,
        });

        const emitDelta = function* (data, transportLabel) {
            notifyProviderToolCallDelta(data);
            reportProviderWebSources(options, data, { provider: 'anthropic' });
            streamUsage = collectAnthropicStreamUsage(data, streamUsage);
            if (data?.delta?.stop_reason) streamStopReason = String(data.delta.stop_reason);
            const parts = extractAnthropicStreamParts(data, blockKinds);
            if (parts.reasoning) {
                yield createReasoningStreamEvent(parts.reasoning, { provider: 'anthropic' });
            }
            if (!parts.content) return;
            deltaCount += 1;
            totalChars += parts.content.length;
            if (!sawFirstDelta) {
                sawFirstDelta = true;
                logStreamDebug(
                    `first-delta transport=${transportLabel} mode=${prepared.connectionMode || 'direct'} chars=${parts.content.length}`,
                );
            }
            yield parts.content;
        };

        if (this.canUseNativeHttp()) {
            const invoker = getTauriInvoker();
            const nativeStreamRequestId = String(
                requestId || `http_stream_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
            ).trim();
            let started = false;
            let rawErrorBody = '';
            let sseBuffer = '';
            let responseStatus = null;
            let responseOk = null;
            const flushSseBuffer = function* (transportLabel, final = false) {
                const lines = String(sseBuffer || '').split('\n');
                sseBuffer = final ? '' : (lines.pop() || '');
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payloadText = line.slice(6).trim();
                    if (!payloadText || payloadText === '[DONE]') continue;
                    try {
                        const data = JSON.parse(payloadText);
                        yield* emitDelta(data, transportLabel);
                    } catch (_e) {}
                }
            };
            try {
                logStreamDebug(
                    `transport=native-stream mode=${prepared.connectionMode || 'direct'} url=${summarizeUrlForLog(prepared.url)}`,
                );
                await invoker('http_stream_request_start', {
                    url: prepared.url,
                    method: 'POST',
                    headers: prepared.headers,
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
                    if (Number.isFinite(Number(batch?.status))) {
                        responseStatus = Number(batch.status);
                    }
                    if (typeof batch?.ok === 'boolean') {
                        responseOk = batch.ok;
                    }
                    const chunks = Array.isArray(batch?.chunks) ? batch.chunks.map((chunk) => String(chunk || '')) : [];
                    if (responseOk === false) {
                        rawErrorBody += chunks.join('');
                    } else {
                        for (const chunk of chunks) {
                            sseBuffer += chunk;
                            yield* flushSseBuffer('native-stream', false);
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
                            const error = new Error(
                                `Anthropic API Error: ${responseStatus || 0}${detail ? ` - ${detail}` : ''}`,
                            );
                            error.status = responseStatus || 0;
                            error.response = rawErrorBody;
                            throw attachSafeProviderErrorMetadata(error, rawErrorBody);
                        }
                        yield* flushSseBuffer('native-stream', true);
                        logStreamDebug(
                            `complete transport=native-stream mode=${prepared.connectionMode || 'direct'} deltas=${deltaCount} chars=${totalChars}`,
                        );
                        reportStreamUsage();
                        return;
                    }

                    if (!chunks.length) {
                        await delay(20);
                    }
                }
            } finally {
                if (started) {
                    invoker('http_stream_request_close', { requestId: nativeStreamRequestId }).catch(() => {});
                }
            }

        }

        if (!useFetchStreaming) {
            logStreamDebug(
                `transport=fetch mode=${prepared.connectionMode || 'direct'} url=${summarizeUrlForLog(prepared.url)}`,
            );
        } else {
            logStreamDebug(
                `transport=fetch mode=${prepared.connectionMode || 'direct'} url=${summarizeUrlForLog(prepared.url)}`,
            );
        }
        const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs: this.timeout, signal, idle: true });
        try {
            const response = await fetch(prepared.url, {
                method: 'POST',
                headers: prepared.headers,
                signal: controller.signal,
                body: payload
            });

            if (!response.ok) {
                const txt = await response.text();
                const detail = this.extractErrorDetail(txt);
                const error = new Error(`Anthropic API Error: ${response.status}${detail ? ` - ${detail}` : ''}`);
                error.status = response.status;
                error.response = txt;
                throw attachSafeProviderErrorMetadata(error, txt);
            }

            for await (const data of handleSSE(response)) {
                touch();
                yield* emitDelta(data, 'fetch');
            }
            logStreamDebug(
                `complete transport=fetch mode=${prepared.connectionMode || 'direct'} deltas=${deltaCount} chars=${totalChars}`,
            );
            reportStreamUsage();
            return;
        } catch (error) {
            if (useFetchStreaming && isFetchNetworkFailure(error)) {
                logStreamDebug(
                    `fetch-failed mode=${prepared.connectionMode || 'direct'} url=${summarizeUrlForLog(prepared.url)} ${describeFetchFailure(prepared.url, error)}`,
                    'warn',
                );
            } else if (useFetchStreaming) {
                logStreamDebug(
                    `fetch-stream-error mode=${prepared.connectionMode || 'direct'} url=${summarizeUrlForLog(prepared.url)} name=${String(error?.name || 'Error')} message=${String(error?.message || error || '')}`,
                    'warn',
                );
            }
            throw error;
        } finally {
            cleanup();
        }
    }

    /**
     * 获取可用模型列表
     */
    async listModels() {
        const fallbackModels = [
            'claude-3-5-sonnet-20241022',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307'
        ];

        try {
            const data = await this.requestJson({
                url: `${this.baseUrl}/models`,
                method: 'GET',
                headers: this.getHeaders(),
            });
            const rawItems = Array.isArray(data)
                ? data
                : Array.isArray(data?.data)
                    ? data.data
                    : [];
            const models = rawItems
                .map((item) => {
                    if (typeof item === 'string') return item.trim();
                    return String(item?.id || item?.name || '').trim();
                })
                .filter(Boolean);

            return models.length ? Array.from(new Set(models)) : fallbackModels;
        } catch {
            return fallbackModels;
        }
    }

    /**
     * 健康检查
     */
    async healthCheck() {
        try {
            // 发送一个最小的请求来验证连接
            const testMessages = [{ role: 'user', content: 'Hi' }];
            await this.chat(testMessages, { maxTokens: 10 });
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }
}
