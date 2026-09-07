/**
 * Google Vertex AI Provider
 * Supports both Express mode (API key) and Full mode (Service Account JSON)
 */

import { handleSSE, parseSSEBuffer } from '../stream.js';
import { createLinkedAbortController, invokeNativeHttpRequest, splitRequestOptions } from '../abort.js';
import { createReasoningStreamEvent, extractGeminiStreamParts } from '../native-reasoning.js';
import { prepareTransportRequest } from '../transport.js';
import { reportProviderWebSources } from '../web-search-runtime.js';
import {
  getGeminiFinishReason,
  mergeGeminiProviderMeta,
  reportProviderUsage,
} from '../provider-usage.js';
import {
  VERTEX_AUTH_MODE_EXPRESS,
  VERTEX_AUTH_MODE_SERVICE_ACCOUNT,
  normalizeVertexAuthMode,
} from '../vertexai-config-utils.js';

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

const b64UrlFromBytes = (bytes) => {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const b64UrlFromJson = (obj) => {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  return b64UrlFromBytes(bytes);
};

const pemToArrayBuffer = (pem) => {
  const raw = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

const makeAbortError = () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
};

const request = async ({
  provider = 'vertexai',
  transportConfig = null,
  url,
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 60000,
  signal,
  requestId = '',
  allowProxy = true,
} = {}) => {
  const prepared = prepareTransportRequest({
    config: transportConfig,
    provider,
    url,
    headers,
    allowProxy,
  });
  const invoker = getTauriInvoker();
  if (typeof invoker === 'function') {
    if (signal?.aborted) throw makeAbortError();
    return invokeNativeHttpRequest({
      invoker,
      signal,
      requestId,
      args: {
        url: prepared.url,
        method,
        headers: prepared.headers,
        body: typeof body === 'string' ? body : body == null ? null : String(body),
        timeoutMs,
      },
    });
  }

  if (isTauriWebview()) {
    throw new Error('Tauri invoke not available for Vertex AI; cannot use fetch due to CORS');
  }

  const { controller, cleanup } = createLinkedAbortController({ timeoutMs, signal });
  try {
    const resp = await fetch(prepared.url, {
      method,
      headers: prepared.headers,
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    const outHeaders = {};
    resp.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { status: resp.status, ok: resp.ok, headers: outHeaders, body: text };
  } finally {
    cleanup();
  }
};

const requestJson = async ({
  provider = 'vertexai',
  transportConfig = null,
  url,
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 60000,
  signal,
  requestId = '',
  allowProxy = true,
} = {}) => {
  const res = await request({
    provider,
    transportConfig,
    url,
    method,
    headers,
    body,
    timeoutMs,
    signal,
    requestId,
    allowProxy,
  });
  if (!res.ok) {
    const raw = String(res.body || '').trim();
    let detail = '';
    try {
      const j = JSON.parse(raw);
      detail = String(j?.error?.message || j?.message || j?.error || '').trim();
    } catch (_e) {}
    const err = new Error(`Vertex AI Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
    err.status = res.status;
    err.response = res.body;
    throw err;
  }
  return JSON.parse(res.body || '{}');
};

const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

const getHostForRegion = (region) => {
  const r = String(region || '').trim() || 'us-central1';
  return r === 'global' ? 'https://aiplatform.googleapis.com' : `https://${r}-aiplatform.googleapis.com`;
};

export class VertexAIProvider {
  constructor(config) {
    this.transportConfig = config || {};
    this.timeout = config.timeout || 60000;
    this.model = config.model || 'gemini-3.5-flash';
    this.region = config.vertexaiRegion || 'global';

    this.serviceAccountJson = config.vertexaiServiceAccount;
    this.apiKey = config.apiKey;
    this.authMode = normalizeVertexAuthMode(config.vertexaiAuthMode, config);

    // Extract Project ID from Service Account JSON if available
    if (this.serviceAccountJson) {
      try {
        const sa = typeof this.serviceAccountJson === 'string'
          ? JSON.parse(this.serviceAccountJson)
          : this.serviceAccountJson;
        this.projectId = sa.project_id;
      } catch (e) {
        console.warn('Failed to parse Service Account JSON:', e);
      }
    }

    // Fall back to explicit projectId if provided
    if (!this.projectId) {
      this.projectId = config.vertexaiProjectId;
    }

    const derivedHost = this.authMode === VERTEX_AUTH_MODE_EXPRESS
      ? getHostForRegion('global')
      : getHostForRegion(this.region);
    const baseUrl = String(config.baseUrl || '').trim();
    // If user provided a valid aiplatform host, respect it; otherwise derive from region (ST-like behavior).
    this.baseUrl = this.authMode === VERTEX_AUTH_MODE_EXPRESS
      ? derivedHost
      : ((baseUrl && baseUrl.includes('aiplatform.googleapis.com')) ? baseUrl : derivedHost);
    this.baseHost = this.baseUrl;

    // Cache for OAuth2 token
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  /**
   * Get OAuth2 access token from Service Account JSON
   */
  async getAccessToken({ signal } = {}) {
    if (signal?.aborted) throw makeAbortError();
    // Check if we have a cached valid token
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountJson) {
      throw new Error('Service Account JSON is required for Vertex AI authentication');
    }

    try {
      // Parse service account JSON
      const serviceAccount = typeof this.serviceAccountJson === 'string'
        ? JSON.parse(this.serviceAccountJson)
        : this.serviceAccountJson;

      if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
        throw new Error('Invalid Service Account JSON (missing client_email/private_key)');
      }

      if (!globalThis?.crypto?.subtle) {
        throw new Error('WebCrypto 不可用，无法在前端签名 Vertex AI JWT');
      }

      // Create JWT for OAuth2 (same approach as SillyTavern backend, but sign via WebCrypto in WebView)
      const header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: serviceAccount.private_key_id,
      };

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: serviceAccount.client_email,
        sub: serviceAccount.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
      };

      const headerB64 = b64UrlFromJson(header);
      const payloadB64 = b64UrlFromJson(payload);
      const signingInput = `${headerB64}.${payloadB64}`;

      const keyBuf = pemToArrayBuffer(serviceAccount.private_key);
      const cryptoKey = await crypto.subtle.importKey(
        'pkcs8',
        keyBuf,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );

      const sigBuf = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        cryptoKey,
        new TextEncoder().encode(signingInput)
      );
      const sigB64 = b64UrlFromBytes(new Uint8Array(sigBuf));
      const jwt = `${signingInput}.${sigB64}`;

      const form = new URLSearchParams();
      form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      form.set('assertion', jwt);

      const tok = await requestJson({
        provider: 'vertexai',
        transportConfig: this.transportConfig,
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: this.timeout,
        signal,
        allowProxy: false,
      });

      const accessToken = String(tok?.access_token || '').trim();
      const expiresIn = Number(tok?.expires_in || 3600);
      if (!accessToken) throw new Error('Failed to obtain access_token');

      this.accessToken = accessToken;
      // refresh slightly earlier
      this.tokenExpiry = Date.now() + Math.max(30, expiresIn - 30) * 1000;
      return this.accessToken;

    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(`Failed to authenticate with Service Account: ${error.message}`);
    }
  }

  /**
   * Convert OpenAI-style messages to Gemini format
   */
  convertMessages(messages) {
    const contents = [];
    let systemInstruction = '';
    const parseDataUrl = (url) => {
      const raw = String(url || '').trim();
      if (!raw.startsWith('data:')) return null;
      const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
      if (!match) return null;
      return { mime: match[1], data: match[2] };
    };
    const toGeminiParts = (content) => {
      if (Array.isArray(content)) {
        const parts = [];
        content.forEach((part) => {
          if (!part || typeof part !== 'object') return;
          if (part.type === 'text') {
            const text = String(part.text || '');
            if (text) parts.push({ text });
            return;
          }
          if (part.type === 'image_url') {
            const url = part?.image_url?.url;
            const parsed = parseDataUrl(url);
            if (parsed?.data) {
              parts.push({ inlineData: { mimeType: parsed.mime || 'image/jpeg', data: parsed.data } });
            } else if (url) {
              parts.push({ text: `[图片] ${String(url)}` });
            }
          }
        });
        return parts.length ? parts : [{ text: '' }];
      }
      return [{ text: String(content ?? '') }];
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

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = toSystemText(msg.content);
        systemInstruction += (systemInstruction ? '\n\n' : '') + text;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: toGeminiParts(msg.content),
        });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * Build the request URL
   */
  buildUrl(stream = false) {
    return this.buildUrlFor({ stream, region: this.region, baseHost: this.baseHost, model: this.model });
  }

  buildUrlFor({ stream = false, region, baseHost, model }) {
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';

    if (this.authMode === VERTEX_AUTH_MODE_EXPRESS) {
      const url = `${getHostForRegion('global')}/v1/publishers/google/models/${model}:${endpoint}`;
      return stream ? `${url}?alt=sse` : url;
    }

    if (!this.projectId) {
      throw new Error('Vertex AI 完整模式需要 Service Account 中的 project_id');
    }

    const url = `${baseHost}/v1/projects/${this.projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`;
    return stream ? `${url}?alt=sse` : url;
  }

  async getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.authMode === VERTEX_AUTH_MODE_EXPRESS) {
      const apiKey = String(this.apiKey || '').trim();
      if (!apiKey) throw new Error('Vertex AI Express 模式需要 API Key');
      headers['x-goog-api-key'] = apiKey;
      return headers;
    }

    if (!this.serviceAccountJson) throw new Error('Vertex AI 完整模式需要 Service Account（JSON）');
    const token = await this.getAccessToken();
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Build request body in Gemini format
   */
  buildRequestBody(messages, options = {}) {
    const { contents, systemInstruction } = this.convertMessages(messages);

    const body = {
      contents,
      safetySettings: GEMINI_SAFETY,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        topP: options.top_p ?? 0.9,
        topK: options.top_k ?? 40,
        maxOutputTokens: options.maxTokens ?? 2048,
      },
    };

    if (Number.isFinite(options.thinkingBudget) || typeof options.thinkingLevel === 'string') {
      body.generationConfig.thinkingConfig = {};
      if (Number.isFinite(options.thinkingBudget)) {
        body.generationConfig.thinkingConfig.thinkingBudget = Math.trunc(options.thinkingBudget);
      }
      if (typeof options.thinkingLevel === 'string' && options.thinkingLevel.trim()) {
        body.generationConfig.thinkingConfig.thinkingLevel = String(options.thinkingLevel).trim();
      }
    }

    if (systemInstruction) {
      body.systemInstruction = {
        role: 'user',
        parts: [{ text: systemInstruction }],
      };
    }
    if (Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools;
    }
    if (options.toolConfig && typeof options.toolConfig === 'object') {
      body.toolConfig = options.toolConfig;
    }

    return body;
  }

  /**
   * Send chat message (non-streaming)
   */
  async chat(messages, options = {}) {
    const { signal, requestId, onProviderToolCallDelta, options: payloadOptions } = splitRequestOptions(options);
    const headers = await this.getHeaders();
    const body = this.buildRequestBody(messages, payloadOptions);
    const tryOnce = async ({ region, baseHost }) => {
      const url = this.buildUrlFor({ stream: false, region, baseHost, model: this.model });
      return requestJson({
        provider: 'vertexai',
        transportConfig: this.transportConfig,
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeoutMs: this.timeout,
        signal,
        requestId,
      });
    };

    let data;
    try {
      data = await tryOnce({ region: this.region, baseHost: this.baseHost });
    } catch (err) {
      // Some Gemini models are only available in `global` location; ST can still use them.
      if (this.authMode === VERTEX_AUTH_MODE_SERVICE_ACCOUNT && err?.status === 404 && this.region !== 'global') {
        data = await tryOnce({ region: 'global', baseHost: getHostForRegion('global') });
      } else {
        throw err;
      }
    }

    const candidates = data?.candidates;
    try {
      onProviderToolCallDelta?.(data, { provider: 'vertexai', model: this.model });
    } catch {}
    reportProviderWebSources(options, data, { provider: 'vertexai' });
    reportProviderUsage(options, {
      body: data,
      provider: 'vertexai',
      model: this.model,
      finishReason: getGeminiFinishReason(data),
    });
    if (!candidates || candidates.length === 0) {
      let errorMsg = 'No candidates returned';
      if (data?.promptFeedback?.blockReason) {
        errorMsg += `: ${data.promptFeedback.blockReason}`;
      }
      throw new Error(errorMsg);
    }

    const responseContent = candidates[0].content ?? candidates[0].output;
    const responseParts = Array.isArray(responseContent?.parts) ? responseContent.parts : [];
    const hasFunctionCall = responseParts.some(part => part?.functionCall && typeof part.functionCall === 'object');
    const responseText = typeof responseContent === 'string'
      ? responseContent
      : responseParts
          .filter(part => !part.thought && typeof part?.text === 'string')
          .map(part => part.text)
          .join('\n\n');

    if (!responseText && !hasFunctionCall) {
      throw new Error('Empty response from Vertex AI');
    }

    return responseText || '';
  }

  /**
   * Stream chat messages
   */
  async *streamChat(messages, options = {}) {
    const { signal, requestId, onProviderToolCallDelta, options: payloadOptions } = splitRequestOptions(options);
    const headers = await this.getHeaders();
    const body = this.buildRequestBody(messages, payloadOptions);
    const notifyProviderToolCallDelta = data => {
      try {
        onProviderToolCallDelta?.(data, { provider: 'vertexai', model: this.model });
      } catch {}
    };
    let providerMeta = null;
    const emitStreamData = function* (data) {
      providerMeta = mergeGeminiProviderMeta(providerMeta, data);
      notifyProviderToolCallDelta(data);
      reportProviderWebSources(options, data, { provider: 'vertexai' });
      const candidates = data?.candidates;
      if (!candidates?.length) return;
      const parts = extractGeminiStreamParts(candidates[0].content);
      if (parts.reasoning) {
        yield createReasoningStreamEvent(parts.reasoning, { provider: 'vertexai' });
      }
      if (parts.content) yield parts.content;
    };

    const invoker = getTauriInvoker();
    const tryStreamOnce = async function* ({ region, baseHost }) {
      const url = this.buildUrlFor({ stream: true, region, baseHost, model: this.model });

      if (typeof invoker === 'function') {
        if (signal?.aborted) throw makeAbortError();
        const prepared = prepareTransportRequest({
          config: this.transportConfig,
          provider: 'vertexai',
          url,
          headers: { ...headers, Accept: 'text/event-stream' },
        });
        const rawRequestId = String(
          requestId || `vertex_stream_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
        ).trim();
        const nativeRequestId = rawRequestId.replace(/[^a-z0-9._-]+/giu, '_').slice(0, 160)
          || `vertex_stream_${Date.now().toString(36)}`;
        let started = false;
        let responseStatus = 0;
        let responseOk = null;
        let rawErrorBody = '';
        let sseBuffer = '';
        const abortNative = () => {
          try {
            Promise.resolve(invoker('http_abort_request', { requestId: nativeRequestId })).catch(() => {});
          } catch {}
        };
        try {
          await invoker('http_stream_request_start', {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            body: JSON.stringify(body),
            timeoutMs: this.timeout,
            requestId: nativeRequestId,
          });
          started = true;
          signal?.addEventListener?.('abort', abortNative, { once: true });
          if (signal?.aborted) {
            abortNative();
            throw makeAbortError();
          }

          while (true) {
            if (signal?.aborted) throw makeAbortError();
            const batch = await invoker('http_stream_request_read', {
              requestId: nativeRequestId,
              maxChunks: 32,
            });
            if (Number.isFinite(Number(batch?.status))) responseStatus = Number(batch.status);
            if (typeof batch?.ok === 'boolean') responseOk = batch.ok;
            const chunks = Array.isArray(batch?.chunks)
              ? batch.chunks.map(chunk => String(chunk || ''))
              : [];
            if (responseOk === false) {
              rawErrorBody += chunks.join('');
            } else {
              for (const chunk of chunks) {
                sseBuffer += chunk;
                const parsed = parseSSEBuffer(sseBuffer);
                sseBuffer = parsed.rest;
                for (const data of parsed.events) {
                  yield* emitStreamData(data);
                }
              }
            }

            const nativeError = String(batch?.error || '').trim();
            if (nativeError) {
              if (/aborted/iu.test(nativeError)) throw makeAbortError();
              const err = new Error(`native http_stream_request failed: ${nativeError}`);
              err.status = responseStatus;
              err.response = rawErrorBody;
              throw err;
            }
            if (batch?.done) {
              if (responseOk === false) {
                let detail = '';
                try {
                  const parsed = JSON.parse(rawErrorBody || '{}');
                  detail = String(parsed?.error?.message || parsed?.message || parsed?.error || '').trim();
                } catch {}
                const err = new Error(`Vertex AI Error: ${responseStatus}${detail ? ` - ${detail}` : ''}`);
                err.status = responseStatus;
                err.response = rawErrorBody;
                throw err;
              }
              const parsed = parseSSEBuffer(sseBuffer, { final: true });
              for (const data of parsed.events) {
                yield* emitStreamData(data);
              }
              return;
            }
            if (!chunks.length) {
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
        } finally {
          try { signal?.removeEventListener?.('abort', abortNative); } catch {}
          if (started) {
            invoker('http_stream_request_close', { requestId: nativeRequestId }).catch(() => {});
          }
        }
      }

      // Browser fallback
      const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs: this.timeout, signal, idle: true });
      try {
        const prepared = prepareTransportRequest({
          config: this.transportConfig,
          provider: 'vertexai',
          url,
          headers: { ...headers, Accept: 'text/event-stream' },
        });
        const response = await fetch(prepared.url, {
          method: 'POST',
          headers: prepared.headers,
          signal: controller.signal,
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`Vertex AI Error: ${response.status} ${errorText}`);
          err.status = response.status;
          throw err;
        }
        for await (const data of handleSSE(response)) {
          touch();
          yield* emitStreamData(data);
        }
      } finally {
        cleanup();
      }
    }.bind(this);

    try {
      yield* tryStreamOnce({ region: this.region, baseHost: this.baseHost });
      reportProviderUsage(options, {
        body: providerMeta,
        provider: 'vertexai',
        model: this.model,
        finishReason: providerMeta?.finishReason,
      });
      return;
    } catch (err) {
      if (this.authMode === VERTEX_AUTH_MODE_SERVICE_ACCOUNT && err?.status === 404 && this.region !== 'global') {
        providerMeta = null;
        yield* tryStreamOnce({ region: 'global', baseHost: getHostForRegion('global') });
        reportProviderUsage(options, {
          body: providerMeta,
          provider: 'vertexai',
          model: this.model,
          finishReason: providerMeta?.finishReason,
        });
        return;
      }
      throw err;
    }
  }

  /**
   * List available models
   */
  async listModels() {
    if (this.authMode === VERTEX_AUTH_MODE_EXPRESS) {
      const error = new Error('Vertex AI Express 模式不提供模型目录查询；已显示内建候选');
      error.code = 'VERTEX_EXPRESS_MODEL_LIST_UNAVAILABLE';
      error.fallbackModels = this.getFallbackModels();
      throw error;
    }
    try {
      const headers = await this.getHeaders();
      const out = [];
      const seen = new Set();
      let pageToken = '';
      const pageTokensSeen = new Set();
      let pages = 0;
      while (true) {
        const qs = new URLSearchParams();
        qs.set('pageSize', '300');
        if (pageToken) qs.set('pageToken', pageToken);
        // Base publisher models are a global Model Garden collection. The current API
        // explicitly rejects a projects/{project}/locations/{location} prefix here.
        const url = `${getHostForRegion('global')}/v1beta1/publishers/google/models?${qs.toString()}`;
        const data = await requestJson({
          provider: 'vertexai',
          transportConfig: this.transportConfig,
          url,
          method: 'GET',
          headers,
          timeoutMs: this.timeout,
        });
        const models = Array.isArray(data?.publisherModels)
          ? data.publisherModels
          : (Array.isArray(data?.models) ? data.models : []);
        models.forEach((model) => {
          const id = String(model?.name || '').split('/').pop();
          if (!id || seen.has(id)) return;
          seen.add(id);
          out.push(id);
        });

        pageToken = String(data?.nextPageToken || '').trim();
        pages++;
        if (!pageToken || pageTokensSeen.has(pageToken) || pages > 200) break;
        pageTokensSeen.add(pageToken);
      }

      const gemini = out.filter(id => id.toLowerCase().includes('gemini'));
      const rest = out.filter(id => !id.toLowerCase().includes('gemini'));
      const merged = [...gemini, ...rest];
      if (!merged.length) throw new Error('Vertex AI 模型目录返回空列表');
      return merged;
    } catch (error) {
      console.warn('Failed to list Vertex AI models:', error);
      const wrapped = new Error(`无法从 Vertex AI 获取模型目录：${error.message}`);
      wrapped.cause = error;
      wrapped.status = error?.status;
      wrapped.fallbackModels = this.getFallbackModels();
      throw wrapped;
    }
  }

  getFallbackModels() {
    return [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ];
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const testMessages = [{ role: 'user', content: 'Hi' }];
      await this.chat(testMessages);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
