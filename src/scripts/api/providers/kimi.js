/**
 * Kimi (Moonshot AI) provider.
 * The official API is compatible with OpenAI Chat Completions.
 */

import { CustomProvider } from './custom.js';

export const KIMI_GLOBAL_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_CHINA_BASE_URL = 'https://api.moonshot.cn/v1';
export const KIMI_BASE_URL = KIMI_GLOBAL_BASE_URL;
export const KIMI_DEFAULT_MODEL = 'kimi-k2.6';

const trim = value => String(value ?? '').trim();

const uniqueStrings = (items = []) => {
  const seen = new Set();
  return items.reduce((out, item) => {
    const value = trim(item);
    if (!value || seen.has(value)) return out;
    seen.add(value);
    out.push(value);
    return out;
  }, []);
};

const FIXED_SAMPLING_FIELDS = [
  'temperature',
  'top_p',
  'n',
  'presence_penalty',
  'frequency_penalty',
];

export class KimiProvider extends CustomProvider {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'kimi',
      baseUrl: config.baseUrl || KIMI_BASE_URL,
      model: config.model || KIMI_DEFAULT_MODEL,
      errorLabel: 'Kimi API',
    });
  }

  normalizeOptions(options = {}) {
    const normalized = super.normalizeOptions(options);
    delete normalized.maxTokens;
    if (/^kimi-/iu.test(trim(this.model))) {
      FIXED_SAMPLING_FIELDS.forEach(field => { delete normalized[field]; });
    }
    return normalized;
  }

  async listModels() {
    const data = await this.requestJson({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: this.getHeaders(),
    });
    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    const available = list.map(item => item?.id || item?.name || item);
    return uniqueStrings([...available, this.model || KIMI_DEFAULT_MODEL]);
  }
}
