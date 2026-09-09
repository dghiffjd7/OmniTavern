/**
 * Google Gemini API Provider
 * Supports both Google AI Studio (Makersuite) and Vertex AI
 */

import { finalizeTextRequestBody, getRequestParamReport } from '../request-params.js';
import { handleSSE } from '../stream.js';
import { createLinkedAbortController, splitRequestOptions } from '../abort.js';
import { createReasoningStreamEvent, extractGeminiStreamParts } from '../native-reasoning.js';
import { prepareTransportRequest } from '../transport.js';
import { reportProviderWebSources } from '../web-search-runtime.js';
import { attachSafeProviderErrorMetadata } from '../provider-error-metadata.js';
import {
  getGeminiFinishReason,
  mergeGeminiProviderMeta,
  reportProviderUsage,
} from '../provider-usage.js';

const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

export class GeminiProvider {
  constructor(config) {
    this.transportConfig = config || {};
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-2.0-flash-exp';
    this.timeout = config.timeout || 60000;

    // Determine API type from baseUrl or explicit config
    // Google AI Studio: https://generativelanguage.googleapis.com
    // Vertex AI: https://{region}-aiplatform.googleapis.com
    const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
    this.isVertexAI = baseUrl.includes('aiplatform.googleapis.com');

    if (this.isVertexAI) {
      // Vertex AI configuration
      this.baseUrl = baseUrl;
      this.region = config.vertexaiRegion || 'us-central1';
      this.projectId = config.vertexaiProjectId;
    } else {
      // Google AI Studio configuration
      this.baseUrl = baseUrl;
      this.apiVersion = config.apiVersion || 'v1beta';
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

    if (this.isVertexAI) {
      // Vertex AI URL format
      if (this.projectId) {
        const baseHost = this.region === 'global'
          ? 'https://aiplatform.googleapis.com'
          : `https://${this.region}-aiplatform.googleapis.com`;
        const url = `${baseHost}/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.model}:${endpoint}`;
        return stream ? `${url}?alt=sse` : url;
      } else {
        // Vertex AI without project ID (may not work without proper setup)
        const url = `${this.baseUrl}/v1/publishers/google/models/${this.model}:${endpoint}`;
        return stream ? `${url}?alt=sse` : url;
      }
    } else {
      // Google AI Studio URL format
      const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:${endpoint}`;
      const keyParam = `key=${this.apiKey}`;
      return stream ? `${url}?${keyParam}&alt=sse` : `${url}?${keyParam}`;
    }
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    // Vertex AI uses Authorization header, AI Studio uses API key in URL
    if (this.isVertexAI) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
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
    const { signal, onProviderToolCallDelta, options: payloadOptions } = splitRequestOptions(options);
    const { controller, cleanup } = createLinkedAbortController({ timeoutMs: this.timeout, signal });

    try {
      const url = this.buildUrl(false);
      const body = this.buildRequestBody(messages, options);
      const prepared = prepareTransportRequest({
        config: this.transportConfig,
        provider: 'gemini',
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
        const error = new Error(`Gemini API Error: ${response.status} ${response.statusText}`);
        error.status = response.status;
        error.response = errorText;
        throw attachSafeProviderErrorMetadata(error, errorText);
      }

      const data = await response.json();
      try {
        onProviderToolCallDelta?.(data, { provider: 'gemini', model: this.model });
      } catch {}
      reportProviderWebSources(options, data, { provider: 'gemini' });
      reportProviderUsage(options, {
        body: data,
        provider: 'gemini',
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
        onProviderToolCallDelta?.(data, { provider: 'gemini', model: this.model });
      } catch {}
    };

    try {
      const url = this.buildUrl(true);
      const body = this.buildRequestBody(messages, options);
      const prepared = prepareTransportRequest({
        config: this.transportConfig,
        provider: 'gemini',
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
        const error = new Error(`Gemini API Error: ${response.status} ${response.statusText}`);
        error.status = response.status;
        error.response = errorText;
        throw attachSafeProviderErrorMetadata(error, errorText);
      }

      // Handle SSE stream
      let providerMeta = null;
      for await (const data of handleSSE(response)) {
        touch();
        providerMeta = mergeGeminiProviderMeta(providerMeta, data);
        notifyProviderToolCallDelta(data);
        reportProviderWebSources(options, data, { provider: 'gemini' });
        const candidates = data?.candidates;
        if (candidates && candidates.length > 0) {
          const parts = extractGeminiStreamParts(candidates[0].content);
          if (parts.reasoning) {
            yield createReasoningStreamEvent(parts.reasoning, { provider: 'gemini' });
          }
          if (parts.content) yield parts.content;
        }
      }
      reportProviderUsage(options, {
        body: providerMeta,
        provider: 'gemini',
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
      let url;
      const headers = {};

      if (this.isVertexAI) {
        // Vertex AI models endpoint
        if (this.projectId) {
          const baseHost = this.region === 'global'
            ? 'https://aiplatform.googleapis.com'
            : `https://${this.region}-aiplatform.googleapis.com`;
          url = `${baseHost}/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models`;
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        } else {
          // Return common Gemini models if project ID is not set
          return [
            'gemini-2.0-flash-exp',
            'gemini-1.5-pro',
            'gemini-1.5-flash',
          ];
        }
      } else {
        // Google AI Studio models endpoint
        url = `${this.baseUrl}/${this.apiVersion}/models?key=${this.apiKey}`;
      }
      const prepared = prepareTransportRequest({
        config: this.transportConfig,
        provider: 'gemini',
        url,
        headers,
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
}
