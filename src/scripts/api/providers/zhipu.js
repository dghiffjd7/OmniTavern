/**
 * Zhipu BigModel provider.
 * The official API is compatible with OpenAI Chat Completions.
 */

import { CustomProvider } from './custom.js';

export const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const ZHIPU_DEFAULT_MODEL = 'glm-5.2';

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

const isZhipuChatModel = model => /^glm-/iu.test(trim(model));

export class ZhipuProvider extends CustomProvider {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'zhipu',
      baseUrl: config.baseUrl || ZHIPU_BASE_URL,
      model: config.model || ZHIPU_DEFAULT_MODEL,
      errorLabel: 'Zhipu BigModel API',
    });
  }

  normalizeOptions(options = {}) {
    const normalized = super.normalizeOptions(options);
    delete normalized.maxTokens;
    return normalized;
  }

  async *streamChatUnguarded(messages, options = {}) {
    const hasTools = Array.isArray(options?.tools) && options.tools.length > 0;
    yield* super.streamChatUnguarded(messages, hasTools
      ? { ...options, tool_stream: true }
      : options);
  }

  async listModels() {
    const data = await this.requestJson({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: this.getHeaders(),
    });
    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    const available = list
      .map(item => item?.id || item?.name || item)
      .filter(isZhipuChatModel);
    return uniqueStrings([...available, this.model || ZHIPU_DEFAULT_MODEL]);
  }
}
