import { captureRequestContext } from './request-context.js';

// https://opencode.ai/docs/go/#where-can-i-use-it
// Native HTTP replaces this product token with the compiled App version.
export const OPENCODE_USER_AGENT = 'OmniTavern';
const SALT_KEY = 'omnitavern.opencode-routing-salt.v1';
const fallbackIds = new WeakMap();
let routingSalt = '';

const randomId = () => {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
};

const getRoutingSalt = () => {
  if (routingSalt) return routingSalt;
  try {
    const saved = globalThis.localStorage?.getItem(SALT_KEY);
    if (/^[a-f0-9]{32}$/.test(saved || '')) routingSalt = saved;
  } catch {}
  if (!routingSalt) {
    routingSalt = randomId();
    try { globalThis.localStorage?.setItem(SALT_KEY, routingSalt); } catch {}
  }
  return routingSalt;
};

// A stable 128-bit routing fingerprint, not an authentication or security token.
// Salt separates installations; raw persona/session/archive identifiers stay local.
const fingerprint = value => {
  let a = 1779033703, b = 3144134277, c = 1013904242, d = 2773480762;
  for (let i = 0; i < value.length; i++) {
    const k = value.charCodeAt(i);
    a = b ^ Math.imul(a ^ k, 597399067);
    b = c ^ Math.imul(b ^ k, 2869860233);
    c = d ^ Math.imul(c ^ k, 951274213);
    d = a ^ Math.imul(d ^ k, 2716044179);
  }
  a = Math.imul(c ^ (a >>> 18), 597399067);
  b = Math.imul(d ^ (b >>> 22), 2869860233);
  c = Math.imul(a ^ (c >>> 17), 951274213);
  d = Math.imul(b ^ (d >>> 19), 2716044179);
  return [a ^ b ^ c ^ d, b ^ a, c ^ a, d ^ a]
    .map(part => (part >>> 0).toString(16).padStart(8, '0')).join('');
};

export const isOpenCodeRequest = ({ provider = '', baseUrl = '', url = '' } = {}) => {
  if (String(provider).trim().toLowerCase() === 'opencode') return true;
  try {
    const target = new URL(url || baseUrl);
    return target.protocol === 'https:' && target.hostname === 'opencode.ai';
  } catch { return false; }
};

export const buildOpenCodeRequestHeaders = ({ config = {}, provider, url, headers = {} } = {}) => {
  config = config && typeof config === 'object' ? config : {};
  if (!isOpenCodeRequest({ provider: provider || config.provider, baseUrl: config.baseUrl, url })) return headers;
  const context = config.requestContext;
  let sessionId;
  if (context?.sessionId) {
    sessionId = `ot_${fingerprint(JSON.stringify([getRoutingSalt(), context.scopeId || '', context.sessionId, context.archiveId || '']))}`;
  } else {
    // Catalog/connection checks have no conversation; reuse only within that client.
    if (!fallbackIds.has(config)) fallbackIds.set(config, `ot_${randomId()}`);
    sessionId = fallbackIds.get(config);
  }
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (['user-agent', 'x-opencode-session'].includes(key.toLowerCase())) delete out[key];
  }
  return { ...out, 'User-Agent': OPENCODE_USER_AGENT, 'x-opencode-session': sessionId };
};

// A per-request provider view keeps concurrent chats/retries from mutating a shared client.
export const bindOpenCodeRequestContext = (provider, context) => {
  const config = provider?.transportConfig;
  if (!provider || !config || !isOpenCodeRequest({ ...config, provider: provider.provider || config.provider, baseUrl: provider.baseUrl || config.baseUrl })) return provider;
  const captured = captureRequestContext(context || config.requestContext);
  if (!captured.sessionId) return provider;
  const bound = Object.create(provider);
  bound.transportConfig = { ...config, requestContext: captured };
  return bound;
};
