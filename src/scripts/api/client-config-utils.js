import { hasVertexCredentialForMode } from './vertexai-config-utils.js';

// 本地／免 Key 的生图渠道：有 URL 即可（与配置面板「可不填 API Key」一致）。
const KEYLESS_IMAGE_PROVIDERS = new Set(['comfyui', 'comfy', 'automatic1111', 'a1111', 'pollinations']);

export const canInitClient = (cfg) => {
  const config = cfg || {};
  const hasKey = typeof config.apiKey === 'string' && config.apiKey.trim().length > 0;
  if (config.provider === 'vertexai') {
    return hasVertexCredentialForMode(config);
  }
  if (KEYLESS_IMAGE_PROVIDERS.has(String(config.provider || '').trim().toLowerCase())) {
    return hasKey || Boolean(String(config.baseUrl || '').trim());
  }
  return hasKey;
};

// 后台请求参数：预设在前、调用方覆盖在后。调用方只给驼峰 maxTokens 时去掉预设的 max_tokens／max_completion_tokens——
// OpenAI 类接口按 max_completion_tokens > max_tokens > maxTokens 取值，否则房子、变量判断等定的上限会被预设上限盖掉。
export const mergeBackgroundGenerationOptions = (presetOptions, overrides) => {
  const caller = overrides || {};
  const merged = { ...(presetOptions || {}), ...caller };
  const own = key => Object.prototype.hasOwnProperty.call(caller, key);
  if (Number.isFinite(caller.maxTokens) && !own('max_tokens') && !own('max_completion_tokens')) {
    delete merged.max_tokens;
    delete merged.max_completion_tokens;
  }
  return merged;
};
