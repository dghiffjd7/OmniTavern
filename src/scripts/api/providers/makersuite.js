/**
 * Google AI Studio (Makersuite) API Provider
 * Uses API key in URL parameter
 */

import { finalizeTextRequestBody, getRequestParamReport } from '../request-params.js';
import { handleSSE } from '../stream.js';
import { createLinkedAbortController, invokeNativeHttpRequest, splitRequestOptions } from '../abort.js';
import { createReasoningStreamEvent, extractGeminiStreamParts } from '../native-reasoning.js';
import { prepareTransportRequest } from '../transport.js';
import { reportProviderWebSources } from '../web-search-runtime.js';
import {
  getGeminiFinishReason,
  mergeGeminiProviderMeta,
  reportProviderUsage,
} from '../provider-usage.js';

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

const extractErrorDetail = (bodyText) => {
  const raw = String(bodyText ?? '').trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const msg = j?.error?.message || j?.message || j?.detail || j?.error || '';
    if (msg) return String(msg);
  } catch (_e) {}
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
};

const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

export class MakersuiteProvider {
  constructor(config) {
    this.transportConfig = config || {};
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-2.0-flash-exp';
    this.timeout = config.timeout || 60000;
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
    this.apiVersion = config.apiVersion || 'v1beta';
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
        // Accumulate system messages into systemInstruction
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
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:${endpoint}`;
    const keyParam = `key=${this.apiKey}`;
    return stream ? `${url}?${keyParam}&alt=sse` : `${url}?${keyParam}`;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
    };
  }

  async request({ url, method = 'GET', headers = {}, body = undefined, signal, requestId = '' } = {}) {
    const prepared = prepareTransportRequest({
      config: this.transportConfig,
      provider: 'makersuite',
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

  /**
   * Build request body in Gemini format
   */
  buildRequestBody(messages, options = {}, { requestParams = true } = {}) {
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

    // Add system instruction if present
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

    return requestParams ? finalizeTextRequestBody(body, {
      config: this.transportConfig, options, protocol: 'gemini',
    }) : body;
  }

  prepareChatRequest(messages, options = {}) {
    const body = this.buildRequestBody(messages, options);
    return { url: this.buildUrl(options.stream === true), body, payload: body, messages,
      parameterReport: getRequestParamReport(body), responsePrefix: '' };
  }

  /**
   * Send chat message (non-streaming)
   */
  async chat(messages, options = {}) {
    const { signal, requestId, onProviderToolCallDelta, options: payloadOptions } = splitRequestOptions(options);
    const { controller, cleanup } = createLinkedAbortController({ timeoutMs: this.timeout, signal });

    try {
      const url = this.buildUrl(false);
      const body = this.buildRequestBody(messages, options);

      const res = await this.request({
        url,
        method: 'POST',
        headers: this.getHeaders(),
        signal: controller.signal,
        body: JSON.stringify(body),
        requestId,
      });
      if (!res.ok) {
        const detail = extractErrorDetail(res.body);
        const error = new Error(`Gemini API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
        error.status = res.status;
        error.response = res.body;
        throw error;
      }
      const data = JSON.parse(res.body || '{}');
      try {
        onProviderToolCallDelta?.(data, { provider: 'makersuite', model: this.model });
      } catch {}
      reportProviderWebSources(options, data, { provider: 'makersuite' });
      reportProviderUsage(options, {
        body: data,
        provider: 'makersuite',
        model: this.model,
        finishReason: getGeminiFinishReason(data),
      });

      // Check for candidates
      const candidates = data?.candidates;
      if (!candidates || candidates.length === 0) {
        let errorMsg = 'No candidates returned';
        if (data?.promptFeedback?.blockReason) {
          errorMsg += `: ${data.promptFeedback.blockReason}`;
        }
        throw new Error(errorMsg);
      }

      // Extract text from response
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
        throw new Error('Empty response from Gemini');
      }

      return responseText || '';
    } finally {
      cleanup();
    }
  }

  /**
   * Stream chat messages
   */
  async *streamChat(messages, options = {}) {
    const { signal, onProviderToolCallDelta, options: payloadOptions } = splitRequestOptions(options);
    const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs: this.timeout, signal, idle: true });
    const notifyProviderToolCallDelta = data => {
      try {
        onProviderToolCallDelta?.(data, { provider: 'makersuite', model: this.model });
      } catch {}
    };

    try {
      const url = this.buildUrl(true);
      const body = this.buildRequestBody(messages, options);
      const prepared = prepareTransportRequest({
        config: this.transportConfig,
        provider: 'makersuite',
        url,
        headers: this.getHeaders(),
      });

      const response = await fetch(prepared.url, {
        method: 'POST',
        headers: prepared.headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} ${errorText}`);
      }

      // Handle SSE stream
      let providerMeta = null;
      for await (const data of handleSSE(response)) {
        touch();
        providerMeta = mergeGeminiProviderMeta(providerMeta, data);
        notifyProviderToolCallDelta(data);
        reportProviderWebSources(options, data, { provider: 'makersuite' });
        const candidates = data?.candidates;
        if (candidates && candidates.length > 0) {
          const parts = extractGeminiStreamParts(candidates[0].content);
          if (parts.reasoning) {
            yield createReasoningStreamEvent(parts.reasoning, { provider: 'makersuite' });
          }
          if (parts.content) yield parts.content;
        }
      }
      reportProviderUsage(options, {
        body: providerMeta,
        provider: 'makersuite',
        model: this.model,
        finishReason: providerMeta?.finishReason,
      });
    } finally {
      cleanup();
    }
  }

  /**
   * List available models
   */
  async listModels() {
    try {
      const url = `${this.baseUrl}/${this.apiVersion}/models?key=${this.apiKey}`;
      const prepared = prepareTransportRequest({
        config: this.transportConfig,
        provider: 'makersuite',
        url,
        headers: {},
      });
      const response = await fetch(prepared.url, { headers: prepared.headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();

      // Filter for models that support generateContent
      const models = data.models || [];
      return models
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.split('/').pop()); // Extract model ID from full name
    } catch (error) {
      console.warn('Failed to list Gemini models:', error);
      // Return common models as fallback
      return [
        'gemini-2.0-flash-exp',
        'gemini-1.5-pro',
        'gemini-1.5-flash',
        'gemini-1.5-pro-002',
        'gemini-1.5-flash-002',
      ];
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      // Try a simple request with minimal content
      const testMessages = [{ role: 'user', content: 'Hi' }];
      await this.chat(testMessages);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * 生成图片（Gemini 图像模型）
   */
  async generateImage(prompt, options = {}) {
    const { signal, requestId, options: payloadOptions } = splitRequestOptions(options);
    const { controller, cleanup } = createLinkedAbortController({ timeoutMs: this.timeout, signal });

    const toImageResults = (data) => {
      const images = [];
      const generated = Array.isArray(data?.generatedImages) ? data.generatedImages : [];
      generated.forEach((item) => {
        const b64 = item?.bytesBase64Encoded || item?.b64 || item?.b64_json;
        if (b64) {
          images.push({ dataUrl: `data:image/png;base64,${b64}`, index: images.length });
          return;
        }
        const url = String(item?.url || item?.fileUri || '').trim();
        if (url) images.push({ url, index: images.length });
      });
      const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
      candidates.forEach((candidate) => {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        parts.forEach((part) => {
          const inline = part?.inlineData || part?.inline_data;
          if (inline?.data) {
            const mime = inline?.mimeType || inline?.mime_type || 'image/png';
            images.push({ dataUrl: `data:${mime};base64,${inline.data}`, index: images.length });
            return;
          }
          const file = part?.fileData;
          if (file?.fileUri) {
            images.push({ url: String(file.fileUri || '').trim(), index: images.length });
          }
        });
      });
      const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
      predictions.forEach((prediction) => {
        const b64 = prediction?.bytesBase64Encoded || prediction?.b64 || prediction?.b64_json;
        if (b64) {
          images.push({ dataUrl: `data:image/png;base64,${b64}`, index: images.length });
          return;
        }
        const url = String(prediction?.fileUri || prediction?.url || '').trim();
        if (url) images.push({ url, index: images.length });
      });
      return images;
    };

    const isLikelyImageModel = (model) => {
      const name = String(model || '').toLowerCase();
      return name.includes('imagen') || name.includes('banana') || name.includes('image');
    };

    const isGeminiImagePreviewModel = (model) => {
      const name = String(model || '').toLowerCase();
      if (name.includes('banana')) return true;
      return name.startsWith('gemini-') && name.includes('image');
    };

    const buildGenerateImagesUrl = () => {
      const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:generateImages`;
      const keyParam = `key=${this.apiKey}`;
      return `${url}?${keyParam}`;
    };

    const buildGenerateImagesBody = (rawPrompt, { promptAsText = true } = {}) => {
      const text = String(rawPrompt ?? '');
      const body = promptAsText
        ? { prompt: { text } }
        : { prompt: text };
      const count = Number.isFinite(payloadOptions.n) ? Math.max(1, Math.trunc(payloadOptions.n)) : 0;
      if (count > 1) body.sampleCount = count;
      const aspectRatio = payloadOptions.aspectRatio || payloadOptions.aspect_ratio;
      if (aspectRatio) body.aspectRatio = String(aspectRatio);
      const negativePrompt = payloadOptions.negativePrompt || payloadOptions.negative_prompt;
      if (negativePrompt) body.negativePrompt = String(negativePrompt);
      return body;
    };

    const buildPredictUrl = () => {
      const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:predict`;
      const keyParam = `key=${this.apiKey}`;
      return `${url}?${keyParam}`;
    };

    const buildPredictBody = (rawPrompt) => {
      const isDeprecated = String(this.model || '').startsWith('imagegeneration');
      const count = Number.isFinite(payloadOptions.n) ? Math.max(1, Math.trunc(payloadOptions.n)) : 1;
      const aspectRatio = payloadOptions.aspectRatio || payloadOptions.aspect_ratio;
      const negativePrompt = payloadOptions.negativePrompt || payloadOptions.negative_prompt;
      const responseMimeType = payloadOptions.responseMimeType
        || payloadOptions.response_mime_type
        || payloadOptions.outputMimeType
        || payloadOptions.output_mime_type
        || 'image/jpeg';
      const compressionRaw = Number.isFinite(payloadOptions.outputCompression)
        ? payloadOptions.outputCompression
        : payloadOptions.output_compression;
      const compressionQuality = Number.isFinite(Number(compressionRaw))
        ? Math.min(100, Math.max(1, Math.trunc(Number(compressionRaw))))
        : 100;
      const parameters = {
        sampleCount: count,
        aspectRatio: String(aspectRatio || '1:1'),
        outputOptions: {
          mimeType: String(responseMimeType || 'image/jpeg'),
          compressionQuality,
        },
      };
      if (negativePrompt) parameters.negativePrompt = String(negativePrompt);
      if (!isDeprecated) {
        parameters.personGeneration = 'allow_all';
        parameters.safetySetting = 'block_low_and_above';
      }
      return {
        instances: [{ prompt: String(rawPrompt ?? '') }],
        parameters,
      };
    };

    const requestGenerateContent = async () => {
      const url = this.buildUrl(false);
      const referenceImages = Array.isArray(payloadOptions.referenceImages) ? payloadOptions.referenceImages : [];
      const parts = [{ type: 'text', text: String(prompt ?? '') }];
      referenceImages.forEach((src) => {
        const url = String(src || '').trim();
        if (!url) return;
        parts.push({ type: 'image_url', image_url: { url } });
      });
      const content = referenceImages.length ? parts : String(prompt ?? '');
      const messages = [{ role: 'user', content }];
      const body = this.buildRequestBody(messages, payloadOptions, { requestParams: false });
      body.generationConfig = { ...(body.generationConfig || {}) };
      const responseModalities = payloadOptions.responseModalities || payloadOptions.response_modalities;
      body.generationConfig.responseModalities = Array.isArray(responseModalities) && responseModalities.length
        ? responseModalities
        : ['IMAGE'];
      if (!isGeminiImagePreviewModel(this.model)) {
        const responseMimeType = payloadOptions.responseMimeType || payloadOptions.response_mime_type;
        if (responseMimeType) body.generationConfig.responseMimeType = responseMimeType;
        if (!body.generationConfig.responseMimeType) body.generationConfig.responseMimeType = 'image/png';
      }
      if (Number.isFinite(payloadOptions.n)) {
        const count = Math.max(1, Math.trunc(payloadOptions.n));
        body.generationConfig.candidateCount = count;
      }

      const res = await this.request({
        url,
        method: 'POST',
        headers: this.getHeaders(),
        signal: controller.signal,
        body: JSON.stringify(body),
        requestId,
      });
      if (!res.ok) {
        const detail = extractErrorDetail(res.body);
        const error = new Error(`Gemini API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
        error.status = res.status;
        error.response = res.body;
        throw error;
      }

      const data = JSON.parse(res.body || '{}');
      const images = toImageResults(data);
      if (!images.length) {
        throw new Error('未返回可用图片');
      }
      return images;
    };

    const requestPredict = async () => {
      const url = buildPredictUrl();
      const body = buildPredictBody(prompt);
      const res = await this.request({
        url,
        method: 'POST',
        headers: this.getHeaders(),
        signal: controller.signal,
        body: JSON.stringify(body),
        requestId,
      });
      if (!res.ok) {
        const detail = extractErrorDetail(res.body);
        const error = new Error(`Gemini Image API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
        error.status = res.status;
        error.response = res.body;
        throw error;
      }
      const data = JSON.parse(res.body || '{}');
      const images = toImageResults(data);
      if (!images.length) {
        throw new Error('未返回可用图片');
      }
      return images;
    };

    const requestGenerateImages = async () => {
      const url = buildGenerateImagesUrl();
      const doRequest = async (body) => {
        const res = await this.request({
          url,
          method: 'POST',
          headers: this.getHeaders(),
          signal: controller.signal,
          body: JSON.stringify(body),
          requestId,
        });
        if (!res.ok) {
          const detail = extractErrorDetail(res.body);
          const error = new Error(`Gemini Image API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
          error.status = res.status;
          error.response = res.body;
          throw error;
        }
        return JSON.parse(res.body || '{}');
      };

      try {
        const data = await doRequest(buildGenerateImagesBody(prompt, { promptAsText: true }));
        const images = toImageResults(data);
        if (!images.length) throw new Error('未返回可用图片');
        return images;
      } catch (err) {
        const data = await doRequest(buildGenerateImagesBody(prompt, { promptAsText: false }));
        const images = toImageResults(data);
        if (!images.length) throw new Error('未返回可用图片');
        return images;
      }
    };

    const shouldFallbackToGenerateImages = (err) => {
      const status = Number(err?.status || 0);
      if (status === 400 || status === 404 || status === 405) return true;
      const msg = String(err?.response || err?.message || '').toLowerCase();
      return msg.includes('generatecontent') || msg.includes('responsemodalities') || msg.includes('modality');
    };

    const shouldFallbackToGenerateContent = (err) => {
      const status = Number(err?.status || 0);
      if (status === 404 || status === 405) return true;
      const msg = String(err?.response || err?.message || '').toLowerCase();
      return msg.includes('not found') || msg.includes('method not allowed');
    };

    try {
      const forcePredict = Boolean(payloadOptions.forcePredict || payloadOptions.force_predict);
      const forceGenerateImages = Boolean(payloadOptions.forceGenerateImages || payloadOptions.force_generate_images);
      const useGeminiPreview = isGeminiImagePreviewModel(this.model);
      if (useGeminiPreview) {
        try {
          return await requestGenerateContent();
        } catch (err) {
          if (shouldFallbackToGenerateImages(err)) {
            try {
              return await requestPredict();
            } catch (_predictErr) {
              return await requestGenerateImages();
            }
          }
          throw err;
        }
      }
      if (forcePredict || isLikelyImageModel(this.model)) {
        try {
          return await requestPredict();
        } catch (err) {
          if (!shouldFallbackToGenerateImages(err)) throw err;
          return await requestGenerateImages();
        }
      }
      try {
        return await requestGenerateContent();
      } catch (err) {
        if (!shouldFallbackToGenerateImages(err)) throw err;
        return await requestGenerateImages();
      }
    } finally {
      cleanup();
    }
  }
}
