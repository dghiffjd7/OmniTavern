// A profile's wire format is independent of model/tool capabilities.
export const normalizeOpenAIApiFormat = value => (
  String(value || '').trim().toLowerCase() === 'responses' ? 'responses' : 'chat_completions'
);

export const supportsOpenAIApiFormatSelection = provider => ['custom', 'opencode'].includes(
  String(provider || '').trim().toLowerCase(),
);

export const usesConfiguredResponses = config => (
  supportsOpenAIApiFormatSelection(config?.provider)
  && normalizeOpenAIApiFormat(config?.apiFormat) === 'responses'
);

// Accept an API root or an already completed endpoint; retain gateway path prefixes.
export const buildOpenAICompatibleEndpoint = (baseUrl, endpoint) => {
  const url = new URL(String(baseUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址需使用 HTTP 或 HTTPS');
  const root = url.pathname.replace(/\/+$/u, '').replace(/\/(?:chat\/completions|responses|models)$/u, '');
  url.pathname = `${root}/${endpoint}`;
  url.hash = '';
  return url.toString();
};

export const resolveOpenAIResponsesUrl = (config = {}) => {
  try {
    if (usesConfiguredResponses(config)) return buildOpenAICompatibleEndpoint(config.baseUrl, 'responses');
    const provider = String(config.provider || '').toLowerCase();
    const url = new URL(config.baseUrl || (provider === 'deepseek'
      ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'));
    if (provider === 'openai' && url.hostname.toLowerCase() === 'api.openai.com') {
      if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
      return buildOpenAICompatibleEndpoint(url.toString(), 'responses');
    }
    if (provider === 'deepseek' && url.hostname.toLowerCase() === 'api.deepseek.com') {
      return `${url.origin}/responses`;
    }
  } catch {}
  return '';
};
