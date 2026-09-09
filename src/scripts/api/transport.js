import { buildOpenCodeRequestHeaders } from './opencode-request-headers.js';

const normalizeConnectionMode = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'reverse_proxy' ? 'reverse_proxy' : 'direct';
};

const joinUrlPath = (basePath = '/', originalPath = '/') => {
  const normalizeSegments = (value) =>
    String(value || '/')
      .trim()
      .split('/')
      .filter(Boolean);

  const baseSegments = normalizeSegments(basePath);
  const originalSegments = normalizeSegments(originalPath);

  if (!baseSegments.length && !originalSegments.length) return '/';
  if (!baseSegments.length) return `/${originalSegments.join('/')}`;
  if (!originalSegments.length) return `/${baseSegments.join('/')}`;

  let overlap = 0;
  const maxOverlap = Math.min(baseSegments.length, originalSegments.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const baseTail = baseSegments.slice(baseSegments.length - size).join('/');
    const originalHead = originalSegments.slice(0, size).join('/');
    if (baseTail === originalHead) {
      overlap = size;
      break;
    }
  }

  const merged = baseSegments.concat(originalSegments.slice(overlap));
  return `/${merged.join('/')}`.replace(/\/{2,}/g, '/');
};

const stripProviderAuth = ({ provider, url, headers = {} } = {}) => {
  const nextHeaders = { ...(headers || {}) };
  Object.keys(nextHeaders).forEach((key) => {
    const lower = String(key || '').trim().toLowerCase();
    if (lower === 'authorization') delete nextHeaders[key];
    if (lower === 'x-api-key') delete nextHeaders[key];
    if (lower === 'xi-api-key') delete nextHeaders[key];
  });

  const nextUrl = new URL(String(url || ''));
  const lowerProvider = String(provider || '').trim().toLowerCase();
  if (lowerProvider === 'makersuite' || lowerProvider === 'gemini') {
    nextUrl.searchParams.delete('key');
  }
  return { url: nextUrl.toString(), headers: nextHeaders };
};

export const prepareTransportRequest = ({
  config,
  provider,
  url,
  headers = {},
  allowProxy = true,
} = {}) => {
  const originalUrl = String(url || '').trim();
  const originalHeaders = { ...buildOpenCodeRequestHeaders({ config, provider, url: originalUrl, headers }) };
  if (!originalUrl) {
    return {
      url: originalUrl,
      headers: originalHeaders,
      connectionMode: 'direct',
    };
  }

  const mode = normalizeConnectionMode(config?.connectionMode);
  if (!allowProxy || mode !== 'reverse_proxy') {
    return {
      url: originalUrl,
      headers: originalHeaders,
      connectionMode: 'direct',
    };
  }

  const proxyBaseUrl = String(config?.proxyBaseUrl || '').trim();
  if (!proxyBaseUrl) {
    return {
      url: originalUrl,
      headers: originalHeaders,
      connectionMode: 'direct',
    };
  }

  let nextUrl = originalUrl;
  let nextHeaders = originalHeaders;

  if (config?.forwardProviderAuth === false) {
    const stripped = stripProviderAuth({ provider, url: nextUrl, headers: nextHeaders });
    nextUrl = stripped.url;
    nextHeaders = stripped.headers;
  }

  let original;
  let proxyBase;
  try {
    original = new URL(nextUrl);
    proxyBase = new URL(proxyBaseUrl);
  } catch {
    return {
      url: originalUrl,
      headers: originalHeaders,
      connectionMode: 'direct',
    };
  }
  const outgoing = new URL(proxyBase.toString());
  outgoing.pathname = joinUrlPath(proxyBase.pathname, original.pathname);

  const mergedSearch = new URLSearchParams(proxyBase.search);
  original.searchParams.forEach((value, key) => {
    mergedSearch.append(key, value);
  });
  const merged = mergedSearch.toString();
  outgoing.search = merged ? `?${merged}` : '';

  const proxyHeaderName = String(config?.proxyAuthHeaderName || '').trim();
  const proxyHeaderValue = String(config?.proxyAuthToken || '').trim();
  if (proxyHeaderName && proxyHeaderValue) {
    nextHeaders[proxyHeaderName] = proxyHeaderValue;
  }

  return {
    url: outgoing.toString(),
    headers: nextHeaders,
    connectionMode: 'reverse_proxy',
  };
};

export const normalizeConnectionModeValue = normalizeConnectionMode;
