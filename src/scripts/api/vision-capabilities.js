const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalize = value => trim(value).toLowerCase();

const VISION_MODEL_PATTERNS = [
  /gpt-4o/,
  /gpt-4\.1/,
  /gpt-4\.5/,
  /gpt-5/,
  /\bo[34](?:[-\w]|$)/,
  /gpt-4[-\w]*vision/,
  /gpt-4[-\w]*turbo/,
  /claude-3/,
  /claude-4/,
  /gemini/,
  /qwen.*(?:vl|vision)/,
  /(?:vl|vision)(?:[-\w]|$)/,
  /llava/,
  /pixtral/,
  /llama-3\.2.*vision/,
];

const TEXT_ONLY_MODEL_PATTERNS = [
  /gpt-3\.5/,
  /^gpt-4$/,
  /^gpt-4-\d{4}/,
  /deepseek/,
  /embedding/,
  /text-embedding/,
  /moderation/,
  /rerank/,
];

export const getVisionInputCapability = ({ provider = '', model = '', baseUrl = '' } = {}) => {
  const p = normalize(provider);
  const m = normalize(model);
  const base = normalize(baseUrl);
  const label = [provider, model].map(trim).filter(Boolean).join(' / ') || '当前配置';

  if (!m && !p) {
    return {
      supported: false,
      status: 'missing_config',
      reason: '请先为女仆绑定可用的 API 配置。',
      label,
    };
  }

  if (p === 'deepseek') {
    // https://api-docs.deepseek.com/guides/vision/
    let supported = false;
    try {
      const endpoint = new URL(base || 'https://api.deepseek.com/v1');
      supported = m === 'deepseek-flash'
        && endpoint.protocol === 'https:' && endpoint.hostname === 'api.deepseek.com'
        && !endpoint.port && !endpoint.username && !endpoint.password
        && !endpoint.search && !endpoint.hash
        && ['/', '/v1', '/beta'].includes(endpoint.pathname.replace(/\/+$/u, '') || '/');
    } catch {}
    return {
      supported,
      status: supported ? 'supported' : 'unsupported',
      reason: supported ? '' : `${label} 暂未识别为可接收图片的模型。`,
      label,
    };
  }

  if (p === 'gemini' || p === 'makersuite' || p === 'vertexai') {
    return {
      supported: true,
      status: 'supported',
      reason: '',
      label,
    };
  }

  if (p === 'anthropic') {
    const supported = /claude-(?:3|4)/.test(m);
    return {
      supported,
      status: supported ? 'supported' : 'unsupported',
      reason: supported ? '' : `${label} 暂未识别为可接收图片的 Claude 3/4 系列模型。`,
      label,
    };
  }

  if (VISION_MODEL_PATTERNS.some(pattern => pattern.test(m))) {
    return {
      supported: true,
      status: 'supported',
      reason: '',
      label,
    };
  }

  if (TEXT_ONLY_MODEL_PATTERNS.some(pattern => pattern.test(m))) {
    return {
      supported: false,
      status: 'unsupported',
      reason: `${label} 暂未识别为可接收图片的模型。`,
      label,
    };
  }

  if (p === 'custom' || p === 'openrouter' || base.includes('openrouter')) {
    return {
      supported: true,
      status: 'unknown',
      reason: `${label} 的图片输入能力无法静态确认，将按兼容接口尝试发送。`,
      label,
    };
  }

  return {
    supported: false,
    status: 'unsupported',
    reason: `${label} 暂未识别为可接收图片的模型。`,
    label,
  };
};
