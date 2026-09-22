import { t } from '../../i18n/index.js';

export const CUSTOM_REALTIME_PROTOCOL = 'openai_realtime';
const forbiddenHeader = /^(?:host|connection|upgrade|content-length|transfer-encoding|proxy-.*|sec-websocket-.*)$/i;
export const validCustomRealtimeHeader = name => /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) && !forbiddenHeader.test(name);

export const normalizeCustomRealtimeEndpoint = value => {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error(t('请填写有效的实时服务地址')); }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) || url.username || url.password || url.hash || url.href.length > 4096) {
    throw new Error(t('实时服务请使用 WSS 或 HTTPS 地址；本机服务可使用 WS 或 HTTP'));
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) url.pathname = '/v1/realtime';
  else if (path.endsWith('/v1')) url.pathname = `${path}/realtime`;
  return url.href;
};

export const parseCustomRealtimeHeaders = value => {
  let headers;
  try { headers = typeof value === 'string' ? JSON.parse(value.trim() || '{}') : value || {}; }
  catch { throw new Error(t('附加请求头需要填写 JSON 对象')); }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 32) throw new Error(t('附加请求头需要填写 JSON 对象'));
  const result = {};
  for (const [name, val] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!validCustomRealtimeHeader(name) || Object.hasOwn(result, key) || typeof val !== 'string' || val.length > 4096 || /[\u0000-\u001f\u007f]/.test(val)) {
      throw new Error(t('附加请求头格式无效，或包含不可覆盖的连接字段'));
    }
    Object.defineProperty(result, key, { value: val, enumerable: true, writable: true, configurable: true });
  }
  if (JSON.stringify(result).length > 16384) throw new Error(t('附加请求头过长'));
  return result;
};

export const validateCustomRealtimeProfile = profile => {
  if (profile.customProtocol !== CUSTOM_REALTIME_PROTOCOL) throw new Error(t('请选择受支持的实时兼容协议'));
  normalizeCustomRealtimeEndpoint(profile.endpoint);
  if (!['bearer', 'header', 'none'].includes(profile.authMode)) throw new Error(t('请选择鉴权方式'));
  if (profile.authMode === 'header' && !validCustomRealtimeHeader(profile.authHeader || '')) throw new Error(t('请填写有效的鉴权请求头名称'));
  for (const key of ['model', 'voice', 'transcriptionModel']) {
    if (!String(profile[key] || '').trim() || String(profile[key]).length > 200 || /[\u0000-\u001f\u007f]/.test(profile[key])) throw new Error(t('请填写有效的模型、声音和转写模型 ID'));
  }
  return profile;
};

export const customRealtimeHeaders = (profile, credentials = {}) => {
  const headers = parseCustomRealtimeHeaders(credentials.extraHeaders);
  if (profile.authMode !== 'none') {
    const key = String(credentials.apiKey || '').trim();
    if (!key || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error(t('请填写 API Key / Access Token'));
    const name = profile.authMode === 'header' ? String(profile.authHeader || '').toLowerCase() : 'authorization';
    if (!validCustomRealtimeHeader(name)) throw new Error(t('请填写有效的鉴权请求头名称'));
    if (Object.hasOwn(headers, name)) throw new Error(t('附加请求头与鉴权设置重复，请只保留一处'));
    return { ...headers, [name]: profile.authMode === 'bearer' ? `Bearer ${key}` : key };
  }
  return headers;
};

export const customRealtimeTransportFields = (profile, credentials) => {
  validateCustomRealtimeProfile(profile);
  customRealtimeHeaders(profile, credentials);
  return { endpoint: normalizeCustomRealtimeEndpoint(profile.endpoint), customProtocol: profile.customProtocol,
    authMode: profile.authMode, authHeader: profile.authHeader,
    credentials: { apiKey: credentials?.apiKey || '', extraHeaders: parseCustomRealtimeHeaders(credentials?.extraHeaders) } };
};
