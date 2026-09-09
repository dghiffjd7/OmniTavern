/**
 * OpenCode Go provider.
 *
 * The Go catalog mixes wire formats. Chat Completions keeps its known-family
 * filter; explicitly selected Responses profiles expose the returned catalog.
 */

import { CustomProvider } from './custom.js';
import { usesConfiguredResponses } from '../openai-api-format.js';

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_DEFAULT_MODEL = 'glm-5.3';

const CHAT_COMPLETIONS_MODEL_PATTERNS = Object.freeze([
  /^glm-/u,
  /^kimi-/u,
  /^deepseek-/u,
  /^mimo-/u,
  /^hy3(?:-|$)/u,
]);

const trim = value => String(value ?? '').trim();

const uniqueStrings = (items = []) => {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = trim(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

export const isOpenCodeGoChatCompletionsModel = (model = '') => {
  const normalized = trim(model).toLowerCase();
  return Boolean(normalized && CHAT_COMPLETIONS_MODEL_PATTERNS.some(pattern => pattern.test(normalized)));
};

export class OpenCodeProvider extends CustomProvider {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'opencode',
      baseUrl: config.baseUrl || OPENCODE_GO_BASE_URL,
      model: config.model || OPENCODE_GO_DEFAULT_MODEL,
      errorLabel: 'OpenCode Go API',
    });
  }

  async listModels() {
    try {
      const data = await this.requestJson({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.getHeaders(),
      });
      const catalogModels = Array.isArray(data?.data)
        ? data.data.map(item => item?.id || item?.name || item)
        : Array.isArray(data)
          ? data.map(item => item?.id || item?.name || item)
          : [];
      const compatibleModels = usesConfiguredResponses(this.transportConfig)
        ? catalogModels
        : catalogModels.filter(isOpenCodeGoChatCompletionsModel);
      return uniqueStrings([...compatibleModels, this.model || OPENCODE_GO_DEFAULT_MODEL]);
    } catch (error) {
      console.warn('Failed to list OpenCode Go models, preserving the current model:', error);
      return uniqueStrings([this.model || OPENCODE_GO_DEFAULT_MODEL]);
    }
  }
}
