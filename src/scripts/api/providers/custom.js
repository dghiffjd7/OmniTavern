/**
 * 自定义 API 适配器
 * 支持兼容 OpenAI 格式的自建 API
 */

import { finalizeTextRequestBody, getRequestParamReport } from '../request-params.js';
import { handleSSE, parseSSEBuffer } from '../stream.js';
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
import { usesConfiguredResponses, buildOpenAICompatibleEndpoint } from '../openai-api-format.js';
import { chatResponses, prepareResponsesRequest, streamResponsesEvents, streamChatResponses } from './openai-responses-runtime.js';

const DEFAULT_IMAGE_MIME = 'image/png';

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

const makeAbortError = () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const extractErrorDetail = (body) => {
    const raw = String(body || '').trim();
    if (!raw) return '';
    try {
        const j = JSON.parse(raw);
        return String(j?.error?.message || j?.message || j?.detail || j?.error || '').trim();
    } catch (_e) {
        return raw.slice(0, 240);
    }
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

const hasOpenAICompatibleToolDelta = (body = {}) => {
    if (Array.isArray(body?.tool_calls) && body.tool_calls.length) return true;
    const choices = Array.isArray(body?.choices) ? body.choices : [];
    return choices.some((choice) => {
        const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : {};
        const message = choice?.message && typeof choice.message === 'object' ? choice.message : {};
        return (
            (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
            (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
            String(choice?.finish_reason || choice?.finishReason || '').trim() === 'tool_calls'
        );
    });
};

const summarizeMessageRoles = (messages = [], limit = 12) => {
    const roles = (Array.isArray(messages) ? messages : [])
        .map(item => String(item?.role || '').trim().toLowerCase() || 'unknown');
    if (!roles.length) return '';
    const tail = roles.slice(-Math.max(1, Math.trunc(Number(limit) || 12)));
    return tail.join('>');
};

const buildEmptyCustomStreamError = ({
    status = 0,
    finishReason = '',
    messages = [],
    baseUrl = '',
    model = '',
} = {}) => {
    const roleTail = summarizeMessageRoles(messages);
    const roles = (Array.isArray(messages) ? messages : [])
        .map(item => String(item?.role || '').trim().toLowerCase() || 'unknown');
    const lastRole = roles[roles.length - 1] || '';
    const lastNonSystem = [...roles].reverse().find(role => role && role !== 'system') || '';
    const rawBaseUrl = String(baseUrl || '').trim().toLowerCase();
    const rawModel = String(model || '').trim().toLowerCase();
    const likelyClaudeCompat =
        rawBaseUrl.includes('pioneer') ||
        rawModel.includes('claude') ||
        rawModel.includes('opus') ||
        rawModel.includes('sonnet');
    const roleHint = likelyClaudeCompat && (lastRole === 'system' || lastNonSystem === 'assistant')
        ? '；可能原因：请求尾部不是有效 user 轮（如预填充/系统注入在最后），Claude/OpenAI-compatible 网关会返回空流。请在该连线配置将「提示词后处理」设为 semi 或 strict'
        : '';
    const reasonText = finishReason ? `，finish_reason=${finishReason}` : '';
    // 报错正文只保留真实原因与可行动提示；请求角色序列留在 error 字段供调试面板/日志使用。
    const error = new Error(
        `模型返回了空回复（HTTP ${Number(status || 0) || 0}${reasonText}）${roleHint}`
    );
    error.status = Number(status || 0) || 0;
    error.finishReason = finishReason;
    error.requestMessageRoles = roleTail;
    return error;
};

const normalizeNonNegativeSeed = (value) => {
    if (String(value ?? '').trim() === '') return undefined;
    const seed = Math.trunc(Number(value));
    if (!Number.isFinite(seed) || seed < 0) return undefined;
    return seed;
};

const normalizeImageReferenceInputs = (referenceImages = []) => {
    return (Array.isArray(referenceImages) ? referenceImages : [])
        .map((item) => {
            if (typeof item === 'string') {
                return { dataUrl: item.trim(), name: '', mime: '' };
            }
            return {
                dataUrl: String(item?.dataUrl || item?.data_url || item?.image_url || item?.imageUrl || item?.url || '').trim(),
                name: String(item?.name || item?.fileName || item?.filename || '').trim(),
                mime: String(item?.mime || item?.mimeType || item?.type || '').trim(),
            };
        })
        .filter(item => item.dataUrl)
        .slice(0, 16);
};

const base64ToBytes = (base64 = '') => {
    const raw = String(base64 || '').replace(/\s+/g, '');
    if (!raw) return new Uint8Array();
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(raw, 'base64'));
    }
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
};

const bytesToBase64 = (bytes) => {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(arr).toString('base64');
    }
    let bin = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < arr.length; i += chunkSize) {
        bin += String.fromCharCode(...arr.subarray(i, i + chunkSize));
    }
    return btoa(bin);
};

const encodeUtf8 = (text = '') => {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    return new Uint8Array(Buffer.from(String(text), 'utf8'));
};

const concatBytes = (chunks = []) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
        out.set(chunk, offset);
        offset += chunk.length;
    });
    return out;
};

const escapeMultipartName = (value = '') => String(value || '').replace(/["\r\n]/g, '_');

const mimeToExtension = (mime = '') => {
    const raw = String(mime || '').toLowerCase();
    if (raw.includes('jpeg') || raw.includes('jpg')) return 'jpg';
    if (raw.includes('webp')) return 'webp';
    if (raw.includes('gif')) return 'gif';
    if (raw.includes('avif')) return 'avif';
    return 'png';
};

const decodeImageDataUrl = (dataUrl = '') => {
    const raw = String(dataUrl || '').trim();
    const match = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i);
    if (!match) {
        throw new Error('自定义图片参考图需要本地上传的 data:image/...;base64 数据');
    }
    const mime = String(match[1] || DEFAULT_IMAGE_MIME).trim() || DEFAULT_IMAGE_MIME;
    if (!mime.toLowerCase().startsWith('image/')) {
        throw new Error(`自定义图片参考图不是图片 MIME: ${mime}`);
    }
    const bytes = base64ToBytes(match[2]);
    if (!bytes.length) throw new Error('自定义图片参考图为空');
    return { mime, bytes };
};

const appendMultipartText = (chunks, boundary, name, value) => {
    if (value === undefined || value === null || String(value) === '') return;
    chunks.push(encodeUtf8([
        `--${boundary}`,
        `Content-Disposition: form-data; name="${escapeMultipartName(name)}"`,
        '',
        String(value),
        '',
    ].join('\r\n')));
};

const appendMultipartFile = (chunks, boundary, name, file) => {
    chunks.push(encodeUtf8([
        `--${boundary}`,
        `Content-Disposition: form-data; name="${escapeMultipartName(name)}"; filename="${escapeMultipartName(file.filename)}"`,
        `Content-Type: ${file.mime || DEFAULT_IMAGE_MIME}`,
        '',
        '',
    ].join('\r\n')));
    chunks.push(file.bytes);
    chunks.push(encodeUtf8('\r\n'));
};

const buildCustomImageEditMultipart = ({ prompt, model, options = {}, referenceImages = [] } = {}) => {
    const boundary = `MiPhoneCustomImage${Date.now().toString(36)}${Math.random().toString(16).slice(2)}`;
    const chunks = [];
    appendMultipartText(chunks, boundary, 'model', model);
    appendMultipartText(chunks, boundary, 'prompt', String(prompt || '').trim());
    appendMultipartText(chunks, boundary, 'n', Number.isFinite(options.n) ? Math.trunc(options.n) : 1);
    if (options.size) appendMultipartText(chunks, boundary, 'size', options.size);
    if (options.quality) appendMultipartText(chunks, boundary, 'quality', options.quality);
    if (options.style) appendMultipartText(chunks, boundary, 'style', options.style);
    if (options.background) appendMultipartText(chunks, boundary, 'background', options.background);
    if (options.outputFormat || options.output_format) {
        appendMultipartText(chunks, boundary, 'output_format', options.outputFormat || options.output_format);
    }
    if (Number.isFinite(options.outputCompression) || Number.isFinite(options.output_compression)) {
        appendMultipartText(
            chunks,
            boundary,
            'output_compression',
            Number.isFinite(options.outputCompression) ? Math.trunc(options.outputCompression) : Math.trunc(options.output_compression),
        );
    }
    if (options.moderation) appendMultipartText(chunks, boundary, 'moderation', options.moderation);
    if (options.user) appendMultipartText(chunks, boundary, 'user', options.user);
    const responseFormat = options.responseFormat || options.response_format || '';
    if (responseFormat) appendMultipartText(chunks, boundary, 'response_format', responseFormat);
    const seed = normalizeNonNegativeSeed(options.seed);
    if (seed !== undefined) appendMultipartText(chunks, boundary, 'seed', seed);

    referenceImages.forEach((item, index) => {
        const decoded = decodeImageDataUrl(item.dataUrl);
        const mime = item.mime || decoded.mime || DEFAULT_IMAGE_MIME;
        const fallbackName = `reference_${index + 1}.${mimeToExtension(mime)}`;
        appendMultipartFile(chunks, boundary, 'image[]', {
            filename: item.name || fallbackName,
            mime,
            bytes: decoded.bytes,
        });
    });
    chunks.push(encodeUtf8(`--${boundary}--\r\n`));
    const body = concatBytes(chunks);
    return {
        body,
        bodyBase64: bytesToBase64(body),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
};

const buildEndpointUrl = (baseUrl, path) => {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const nextPath = String(path || '').replace(/^\/+/, '');
    return `${base}/${nextPath}`;
};

// 参考图接入形态因渠道而异：OpenAI 官方走 multipart /images/edits；BytePlus、SiliconFlow 等
// 走 /images/generations + image 字段。按 baseUrl+model 记住成功形态，避免每次双打。
const customImageReferenceRouteCache = new Map();

const describeImageResponseFailure = (data) => {
    const message = String(
        data?.error?.message || data?.error?.msg || data?.message || data?.msg || data?.error_msg || '',
    ).trim();
    const code = String(data?.error?.code || data?.code || '').trim();
    if (message) return `${code ? `[${code}] ` : ''}${message}`.slice(0, 300);
    try {
        return JSON.stringify(data).slice(0, 300);
    } catch (_e) {
        return String(data).slice(0, 300);
    }
};

const extractImageListFromResponse = (data) => {
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
        .map((item, index) => {
            const b64 = item?.b64_json || item?.b64 || '';
            if (b64) {
                return { dataUrl: `data:image/png;base64,${b64}`, index };
            }
            const url = String(item?.url || '').trim();
            return url ? { url, index } : null;
        })
        .filter(Boolean);
};

const isOfficialGeminiOpenAIEndpoint = (baseUrl) => {
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

const normalizeOpenAICompatiblePayloadOptions = (options = {}, { officialGeminiOpenAIEndpoint = false } = {}) => {
    const out = { ...(options && typeof options === 'object' ? options : {}) };
    if (out.maxTokens !== undefined) {
        if (out.max_tokens === undefined && out.max_completion_tokens === undefined) out.max_tokens = out.maxTokens;
        delete out.maxTokens;
    }
    if (out.toolChoice !== undefined) {
        if (out.tool_choice === undefined) out.tool_choice = out.toolChoice;
        delete out.toolChoice;
    }
    if (officialGeminiOpenAIEndpoint) {
        delete out.deepseekPrefix;
        delete out.thinkingBudget;
        delete out.thinkingLevel;
        delete out.stream;
    }

    if (Object.hasOwn(out, 'seed')) {
        const seed = normalizeNonNegativeSeed(out.seed);
        if (seed === undefined || officialGeminiOpenAIEndpoint) {
            delete out.seed;
        } else {
            out.seed = seed;
        }
    }
    if (officialGeminiOpenAIEndpoint && Object.hasOwn(out, 'n')) {
        const n = Math.trunc(Number(out.n));
        if (!Number.isFinite(n) || n <= 1) {
            delete out.n;
        } else {
            out.n = n;
        }
    }
    if (officialGeminiOpenAIEndpoint && Object.hasOwn(out, 'presence_penalty')) {
        const value = Number(out.presence_penalty);
        if (!Number.isFinite(value) || value === 0) {
            delete out.presence_penalty;
        } else {
            out.presence_penalty = value;
        }
    }
    if (officialGeminiOpenAIEndpoint && Object.hasOwn(out, 'frequency_penalty')) {
        const value = Number(out.frequency_penalty);
        if (!Number.isFinite(value) || value === 0) {
            delete out.frequency_penalty;
        } else {
            out.frequency_penalty = value;
        }
    }
    return out;
};

export class CustomProvider {
    constructor(config) {
        this.transportConfig = { ...config, provider: config.provider || 'custom' };
        this.provider = config.provider || 'custom';
        this.apiKey = config.apiKey || '';
        this.baseUrl = config.baseUrl;
        this.model = config.model || 'default';
        this.timeout = config.timeout || 60000;
        this.errorLabel = String(config.errorLabel || 'Custom API').trim() || 'Custom API';
    }

    getHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        return headers;
    }

    async request({ url, method = 'GET', headers = {}, body = undefined, bodyBase64 = '', signal, requestId = '' } = {}) {
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
                        body: bodyBase64 ? null : (typeof body === 'string' ? body : body == null ? null : String(body)),
                        bodyBase64: bodyBase64 || null,
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
                // Non-Tauri fallback
            }
        }

        const { controller, cleanup } = createLinkedAbortController({ timeoutMs: this.timeout, signal });
        try {
            const fetchBody = body !== undefined ? body : (bodyBase64 ? base64ToBytes(bodyBase64) : body);
            const response = await fetch(prepared.url, {
                method,
                headers: mergedHeaders,
                signal: controller.signal,
                body: fetchBody,
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

    async requestJson({ url, method = 'GET', headers = {}, body = undefined, bodyBase64 = '', signal, requestId = '' } = {}) {
        const res = await this.request({ url, method, headers, body, bodyBase64, signal, requestId });
        if (!res.ok) {
            const detail = extractErrorDetail(res.body);
            const error = new Error(`${this.errorLabel} Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
            error.status = res.status;
            error.response = res.body;
            throw attachSafeProviderErrorMetadata(error, res.body);
        }
        return JSON.parse(res.body || '{}');
    }

    /**
     * 准备聊天请求，供发送链路和调试面板复用同一份实际 payload。
     */
    normalizeOptions(options = {}) {
        return normalizeOpenAICompatiblePayloadOptions(options, {
            officialGeminiOpenAIEndpoint: isOfficialGeminiOpenAIEndpoint(this.baseUrl),
        });
    }

    prepareChatRequest(messages, options = {}) {
        if (usesConfiguredResponses(this.transportConfig)) {
            return this.prepareResponsesRequest(messages, options, { stream: options.stream === true });
        }
        const { signal, requestId, onProviderToolCallDelta, onProviderSources, options: rawPayloadOptions } = splitRequestOptions(options);
        const officialGeminiOpenAIEndpoint = isOfficialGeminiOpenAIEndpoint(this.baseUrl);
        const normalizedOptions = this.normalizeOptions(rawPayloadOptions);
        const payloadMessages = Array.isArray(messages) ? messages : [];
        const basePayload = { model: this.model, messages: payloadMessages, ...normalizedOptions, stream: options.stream === true };
        const payload = finalizeTextRequestBody(options.stream === true
            ? streamUsageCompat.applyStreamUsageOptions(basePayload, this.baseUrl) : basePayload,
            { config: this.transportConfig, options, protocol: 'chat_completions' });
        return {
            signal,
            requestId,
            onProviderToolCallDelta,
            onProviderSources,
            url: officialGeminiOpenAIEndpoint
                ? buildEndpointUrl(this.baseUrl, 'chat/completions')
                : `${this.baseUrl}/chat/completions`,
            payload,
            body: payload,
            parameterReport: getRequestParamReport(payload),
            messages: payloadMessages,
            normalizedOptions,
            responsePrefix: '',
        };
    }

    /**
     * 发送聊天消息（非流式）
     */
    async chat(messages, options = {}) {
        if (usesConfiguredResponses(this.transportConfig)) return chatResponses(this, messages, options);
        const request = this.prepareChatRequest(messages, { ...options, stream: false });
        const data = await this.requestJson({
            url: request.url,
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(request.payload),
            signal: request.signal,
            requestId: request.requestId,
        });

        try {
            request.onProviderToolCallDelta?.(data, { provider: this.provider, model: this.model });
        } catch {}
        reportProviderWebSources(options, data, { provider: this.provider });

        reportProviderUsage(options, {
            body: data,
            model: this.model,
            provider: this.provider,
            finishReason: pickOpenAICompatibleFinishReason(data),
        });

        if (data.choices && data.choices[0]) {
            return data.choices[0].message?.content || data.choices[0].text || '';
        } else if (data.response) {
            return data.response;
        } else if (data.content) {
            return data.content;
        }

        throw new Error('Unknown response format');
    }

    /**
     * 流式聊天
     */
    // 同 openai.js：流式带 include_usage 拿校准样本；端点点名拒绝时记忆并去掉重试一次。
    async *streamChat(messages, options = {}) {
        if (usesConfiguredResponses(this.transportConfig)) {
            yield* streamChatResponses(this, messages, options);
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

    prepareResponsesRequest(messages, options = {}, settings = {}) {
        return prepareResponsesRequest(this, messages, options, settings);
    }

    async *streamResponsesEvents(prepared = {}) {
        yield* streamResponsesEvents(this, prepared);
    }

    async *streamChatUnguarded(messages, options = {}) {
        const request = this.prepareChatRequest(messages, { ...options, stream: true });
        const providerName = this.provider || 'custom';
        const notifyProviderToolCallDelta = data => {
            try {
                request.onProviderToolCallDelta?.(data, { provider: providerName, model: this.model });
            } catch {}
        };
        const payload = JSON.stringify(request.payload);

        const invoker = getTauriInvoker();
        if (typeof invoker === 'function') {
            if (request.signal?.aborted) throw makeAbortError();
            const transport = prepareTransportRequest({
                config: this.transportConfig,
                provider: this.provider,
                url: request.url,
                headers: { ...this.getHeaders(), Accept: 'text/event-stream' },
            });
            const nativeStreamRequestId = String(
                request.requestId || `custom_stream_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
            ).trim();
            let started = false;
            let responseStatus = 0;
            let responseOk = null;
            let rawErrorBody = '';
            let sseBuffer = '';
            let outputChars = 0;
            let reasoningChars = 0;
            let toolDeltaCount = 0;
            let finishReason = '';
            let lastUsage = null;
            const reportUsage = () => reportProviderUsage(options, {
                body: lastUsage, model: this.model, provider: this.provider, finishReason,
            });
            const emitParsed = function* (data) {
                notifyProviderToolCallDelta(data);
                reportProviderWebSources(options, data, { provider: providerName });
                if (data?.usage && typeof data.usage === 'object') lastUsage = data;
                if (hasOpenAICompatibleToolDelta(data)) toolDeltaCount += 1;
                const nextFinishReason = pickOpenAICompatibleFinishReason(data);
                if (nextFinishReason) finishReason = nextFinishReason;
                const parts = extractOpenAICompatibleStreamParts(data);
                if (parts.reasoning) {
                    reasoningChars += parts.reasoning.length;
                    yield createReasoningStreamEvent(parts.reasoning, { provider: providerName });
                }
                if (parts.content) {
                    outputChars += parts.content.length;
                    yield parts.content;
                }
            };
            const throwIfEmptyStream = () => {
                if (outputChars > 0 || reasoningChars > 0 || toolDeltaCount > 0) return;
                throw buildEmptyCustomStreamError({
                    status: responseStatus,
                    finishReason,
                    messages: request.messages,
                    baseUrl: this.baseUrl,
                    model: this.model,
                });
            };
            try {
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
                    if (request.signal?.aborted) throw makeAbortError();
                    const batch = await invoker('http_stream_request_read', {
                        requestId: nativeStreamRequestId,
                        maxChunks: 32,
                    });
                    if (Number.isFinite(Number(batch?.status))) responseStatus = Number(batch.status);
                    if (typeof batch?.ok === 'boolean') responseOk = batch.ok;

                    const chunks = Array.isArray(batch?.chunks) ? batch.chunks.map(chunk => String(chunk || '')) : [];
                    if (responseOk === false) {
                        rawErrorBody += chunks.join('');
                    } else {
                        for (const chunk of chunks) {
                            sseBuffer += chunk;
                            const parsed = parseSSEBuffer(sseBuffer, { final: false });
                            sseBuffer = parsed.rest;
                            for (const data of parsed.events) yield* emitParsed(data);
                            if (parsed.done) {
                                throwIfEmptyStream();
                                reportUsage();
                                return;
                            }
                        }
                    }

                    const nativeError = String(batch?.error || '').trim();
                    if (nativeError) {
                        if (/aborted/i.test(nativeError)) throw makeAbortError();
                        const error = new Error(`${this.errorLabel} stream request failed: ${nativeError}`);
                        error.status = responseStatus;
                        error.response = rawErrorBody;
                        throw error;
                    }

                    if (batch?.done) {
                        if (responseOk === false) {
                            const detail = extractErrorDetail(rawErrorBody);
                            const error = new Error(`${this.errorLabel} Error: ${responseStatus || 0}${detail ? ` - ${detail}` : ''}`);
                            error.status = responseStatus || 0;
                            error.response = rawErrorBody;
                            throw attachSafeProviderErrorMetadata(error, rawErrorBody);
                        }
                        const parsed = parseSSEBuffer(sseBuffer, { final: true });
                        for (const data of parsed.events) yield* emitParsed(data);
                        throwIfEmptyStream();
                        reportUsage();
                        return;
                    }

                    if (!chunks.length) await delay(20);
                }
            } finally {
                if (started) {
                    invoker('http_stream_request_close', { requestId: nativeStreamRequestId }).catch(() => {});
                }
            }
        }

        const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs: this.timeout, signal: request.signal, idle: true });
        try {
            const prepared = prepareTransportRequest({
                config: this.transportConfig,
                provider: this.provider,
                url: request.url,
                headers: { ...this.getHeaders(), Accept: 'text/event-stream' },
            });
            const response = await fetch(prepared.url, {
                method: 'POST',
                headers: prepared.headers,
                signal: controller.signal,
                body: payload
            });

            if (!response.ok) {
                const txt = await response.text();
                const detail = extractErrorDetail(txt);
                const error = new Error(`${this.errorLabel} Error: ${response.status}${detail ? ` - ${detail}` : ''}`);
                error.status = response.status;
                error.response = txt;
                throw attachSafeProviderErrorMetadata(error, txt);
            }

            let outputChars = 0;
            let reasoningChars = 0;
            let toolDeltaCount = 0;
            let finishReason = '';
            let lastUsage = null;
            for await (const data of handleSSE(response)) {
                touch();
                notifyProviderToolCallDelta(data);
                reportProviderWebSources(options, data, { provider: providerName });
                if (data?.usage && typeof data.usage === 'object') lastUsage = data;
                if (hasOpenAICompatibleToolDelta(data)) toolDeltaCount += 1;
                const nextFinishReason = pickOpenAICompatibleFinishReason(data);
                if (nextFinishReason) finishReason = nextFinishReason;
                const parts = extractOpenAICompatibleStreamParts(data);
                if (parts.reasoning) {
                    reasoningChars += parts.reasoning.length;
                    yield createReasoningStreamEvent(parts.reasoning, { provider: providerName });
                }
                if (parts.content) {
                    outputChars += parts.content.length;
                    yield parts.content;
                }
            }
            if (outputChars <= 0 && reasoningChars <= 0 && toolDeltaCount <= 0) {
                throw buildEmptyCustomStreamError({
                    status: response.status,
                    finishReason,
                    messages: request.messages,
                    baseUrl: this.baseUrl,
                    model: this.model,
                });
            }
            reportProviderUsage(options, {
                body: lastUsage, model: this.model, provider: this.provider, finishReason,
            });
        } finally {
            cleanup();
        }
    }

    /**
     * 生成图片（OpenAI 兼容 /images/generations）
     */
    async generateImage(prompt, options = {}) {
        const { signal } = options || {};
        const referenceImages = normalizeImageReferenceInputs(options.referenceImages || options.reference_images);
        if (referenceImages.length) {
            return await this.generateImageWithReferences(prompt, options, referenceImages, signal);
        }

        const data = await this.requestJson({
            url: `${this.baseUrl}/images/generations`,
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(this.buildImageGenerationsPayload(prompt, options)),
            signal,
        });
        const images = extractImageListFromResponse(data);
        if (!images.length) {
            throw new Error(`图片接口未返回图片数据：${describeImageResponseFailure(data)}`);
        }
        return images;
    }

    buildImageGenerationsPayload(prompt, options = {}) {
        const payload = {
            model: this.model,
            prompt: String(prompt || '').trim(),
            n: Number.isFinite(options.n) ? Math.trunc(options.n) : 1,
        };
        const responseFormat = options.responseFormat || options.response_format || '';
        if (responseFormat) payload.response_format = responseFormat;
        if (options.size) payload.size = options.size;
        if (options.quality) payload.quality = options.quality;
        if (options.style) payload.style = options.style;
        const seed = normalizeNonNegativeSeed(options.seed);
        if (seed !== undefined) payload.seed = seed;
        return payload;
    }

    // 带参考图：依次尝试两种主流 OpenAI 兼容形态，成功后按 baseUrl+model 缓存路由。
    async generateImageWithReferences(prompt, options, referenceImages, signal) {
        const attempts = {
            generations: () => this.requestImageGenerationsWithImage(prompt, options, referenceImages, signal),
            edits: () => this.requestImageEditsMultipart(prompt, options, referenceImages, signal),
        };
        const preferEdits = /gpt-image|dall[-. ]?e/i.test(String(this.model || ''));
        let order = preferEdits ? ['edits', 'generations'] : ['generations', 'edits'];
        const cacheKey = `${this.baseUrl}::${this.model}`;
        const cached = customImageReferenceRouteCache.get(cacheKey);
        if (cached && order.includes(cached)) {
            order = [cached, ...order.filter(key => key !== cached)];
        }
        const failures = [];
        for (const key of order) {
            try {
                const images = await attempts[key]();
                customImageReferenceRouteCache.set(cacheKey, key);
                return images;
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                const label = key === 'edits' ? 'images/edits(multipart)' : 'images/generations+image';
                failures.push(`${label} → ${error?.message || String(error || '')}`);
            }
        }
        throw new Error(`参考图两种接入方式都失败：${failures.join('；')}`);
    }

    async requestImageGenerationsWithImage(prompt, options, referenceImages, signal) {
        const payload = this.buildImageGenerationsPayload(prompt, options);
        payload.image = referenceImages.length === 1
            ? referenceImages[0].dataUrl
            : referenceImages.map(item => item.dataUrl);
        const data = await this.requestJson({
            url: `${this.baseUrl}/images/generations`,
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload),
            signal,
        });
        const images = extractImageListFromResponse(data);
        if (!images.length) {
            throw new Error(`图片接口未返回图片数据：${describeImageResponseFailure(data)}`);
        }
        return images;
    }

    async requestImageEditsMultipart(prompt, options, referenceImages, signal) {
        const multipart = buildCustomImageEditMultipart({
            prompt,
            model: this.model,
            options,
            referenceImages,
        });
        const data = await this.requestJson({
            url: `${this.baseUrl}/images/edits`,
            method: 'POST',
            headers: {
                ...this.getHeaders(),
                'Content-Type': multipart.contentType,
            },
            body: multipart.body,
            bodyBase64: multipart.bodyBase64,
            signal,
        });
        const images = extractImageListFromResponse(data);
        if (!images.length) {
            throw new Error(`图片接口未返回图片数据：${describeImageResponseFailure(data)}`);
        }
        return images;
    }

    /**
     * 获取可用模型列表
     */
    async listModels() {
        try {
            const res = await this.request({
                url: usesConfiguredResponses(this.transportConfig)
                    ? buildOpenAICompatibleEndpoint(this.baseUrl, 'models')
                    : `${this.baseUrl}/models`,
                method: 'GET',
                headers: this.getHeaders(),
            });
            if (!res.ok) return [this.model];
            const data = JSON.parse(res.body || '{}');
            if (Array.isArray(data)) return data.map(m => m.id || m.name || m);
            if (data.data && Array.isArray(data.data)) return data.data.map(m => m.id || m.name || m);
            return [this.model];
        } catch (error) {
            console.warn('Failed to fetch models:', error);
            return [this.model];
        }
    }

    /**
     * 健康检查
     */
    async healthCheck() {
        try {
            const testMessages = [{ role: 'user', content: 'test' }];
            await this.chat(testMessages, { max_tokens: usesConfiguredResponses(this.transportConfig) ? 128 : 5 });
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }
}
