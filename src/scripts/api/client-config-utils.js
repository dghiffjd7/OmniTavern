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
