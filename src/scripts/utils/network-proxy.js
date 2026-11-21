// 网络代理设置（通用设置 → 网络）：设置存档的规整，以及同步给原生层（src-tauri/src/network_proxy.rs）。
export const NETWORK_PROXY_MODES = Object.freeze(['system', 'direct', 'custom']);
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

export const normalizeNetworkProxyMode = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  return NETWORK_PROXY_MODES.includes(raw) ? raw : 'system';
};

// 没写协议的当作 http://（代理工具里抄来的常是 127.0.0.1:7890）；不合法时返回空字符串。
export const normalizeNetworkProxyUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const address = raw.includes('://') ? raw : `http://${raw}`;
  try {
    const parsed = new URL(address);
    return PROXY_PROTOCOLS.has(parsed.protocol) && parsed.hostname ? address : '';
  } catch {
    return '';
  }
};

// 自定义地址没填或不合法时，先跟随系统代理。
export const resolveNetworkProxy = (settings = {}) => {
  const mode = normalizeNetworkProxyMode(settings?.networkProxyMode);
  if (mode !== 'custom') return { mode, url: null };
  const url = normalizeNetworkProxyUrl(settings?.networkProxyUrl);
  return url ? { mode, url } : { mode: 'system', url: null };
};

export const syncNetworkProxy = (invoke, settings) => invoke('set_network_proxy', resolveNetworkProxy(settings));
