// 插件包的取得与解析（不涉及界面）：网址正规化、GitHub 链接解析与预设分支、下载、ZIP 解析成 { manifest, code }。
// 插件面板与女仆的 plugin.install 共用；确认窗、提示与状态文字留在各自的调用处。
import { validateManifest } from '../storage/plugin-store.js';
import { safeInvoke } from '../utils/tauri.js';
import { invokeNativeHttpRequest } from '../api/abort.js';

export const SILLY_TAVERN_EXTENSION_MESSAGE = '检测到 SillyTavern/酒馆扩展格式（display_name/js/css）。当前插件系统不能直接运行酒馆扩展；需要先做兼容适配或转换为 OmniTavern 插件清单。';

export const isSillyTavernExtensionManifest = (manifest) => {
  const raw = manifest && typeof manifest === 'object' ? manifest : {};
  const hasSillyTavernEntry =
    typeof raw.display_name === 'string' ||
    typeof raw.js === 'string' ||
    typeof raw.css === 'string';
  const hasChatAppEntry =
    typeof raw.id === 'string' ||
    typeof raw.name === 'string' ||
    typeof raw.apiVersion === 'string' ||
    typeof raw.main === 'string' ||
    Array.isArray(raw.permissions);
  return hasSillyTavernEntry && !hasChatAppEntry;
};

const base64ToByteArray = (base64 = '') => {
  const raw = atob(String(base64 || ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return Array.from(bytes);
};

const isInvokeUnavailableError = (err) => /tauri invoke not available|command not found|unknown command/i.test(String(err?.message || err || ''));

const defaultFetch = (...args) => fetch(...args);

export const normalizeInstallUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === 'github.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 4 && parts[2] === 'blob') {
        const user = parts[0];
        const repo = parts[1];
        const rest = parts.slice(3).join('/');
        if (user && repo && rest) {
          return `https://raw.githubusercontent.com/${user}/${repo}/${rest}`;
        }
      }
    }
  } catch {
    return rawUrl;
  }
  return rawUrl;
};

export const parseGithubRepoUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = String(parts[1] || '').replace(/\.git$/i, '');
    if (!owner || !repo) return null;
    const kind = parts[2] || '';
    if (kind === 'tree' && parts[3]) {
      return { owner, repo, branch: parts.slice(3).join('/') };
    }
    if (kind === 'releases' && parts[3] === 'tag' && parts[4]) {
      return { owner, repo, tag: parts.slice(4).join('/') };
    }
    if (kind === 'releases' && parts[3] === 'latest') {
      return { owner, repo, latest: true };
    }
    if (kind === 'archive') {
      return { owner, repo, archive: true, url: rawUrl };
    }
    return { owner, repo };
  } catch {
    return null;
  }
};

export const buildGithubZipUrl = (owner, repo, refType, ref) => {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const safeRef = encodeURIComponent(ref);
  if (refType === 'tags') {
    return `https://codeload.github.com/${safeOwner}/${safeRepo}/zip/refs/tags/${safeRef}`;
  }
  return `https://codeload.github.com/${safeOwner}/${safeRepo}/zip/refs/heads/${safeRef}`;
};

// GitHub 仓库／分支／标签／最新发布链接转成 ZIP 直链；查不到预设分支时用 main（下载 404/403 再试 master）
export const resolveInstallUrl = async (rawUrl, { fetchImpl = defaultFetch, signal = null } = {}) => {
  // 中止时不吞成「查不到」：直接往外抛，避免改用猜测的 main 分支继续下载
  const fetchApi = api => (signal ? fetchImpl(api, { signal }) : fetchImpl(api));
  const normalized = normalizeInstallUrl(rawUrl);
  const github = parseGithubRepoUrl(normalized);
  if (!github) return normalized;
  if (github.archive && github.url) return github.url;
  if (github.tag) {
    return buildGithubZipUrl(github.owner, github.repo, 'tags', github.tag);
  }
  if (github.branch) {
    return buildGithubZipUrl(github.owner, github.repo, 'heads', github.branch);
  }
  if (github.latest) {
    try {
      const api = `https://api.github.com/repos/${github.owner}/${github.repo}/releases/latest`;
      const res = await fetchApi(api);
      if (res.ok) {
        const data = await res.json();
        const tag = String(data?.tag_name || '').trim();
        if (tag) return buildGithubZipUrl(github.owner, github.repo, 'tags', tag);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  try {
    const api = `https://api.github.com/repos/${github.owner}/${github.repo}`;
    const res = await fetchApi(api);
    if (res.ok) {
      const data = await res.json();
      const branch = String(data?.default_branch || '').trim();
      if (branch) return buildGithubZipUrl(github.owner, github.repo, 'heads', branch);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return buildGithubZipUrl(github.owner, github.repo, 'heads', 'main');
};

export const shouldRetryGithubMain = (url, status) => {
  if (status !== 404 && status !== 403) return false;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('github.com')) return false;
    if (!parsed.pathname.includes('/zip/refs/heads/main')) return false;
    return true;
  } catch {
    return false;
  }
};

export const replaceGithubBranch = (url, branch) => {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/zip\/refs\/heads\/[^/]+/i, `/zip/refs/heads/${branch}`);
    return parsed.toString();
  } catch {
    return url;
  }
};

export const resolveDownloadedFileName = (url, headers = {}) => {
  try {
    const map = headers && typeof headers === 'object' ? headers : {};
    const disposition = String(map['content-disposition'] || map['Content-Disposition'] || '').trim();
    const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    if (encoded) return decodeURIComponent(encoded).replace(/[\\/]+/g, '_');
    const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1];
    if (quoted) return quoted.replace(/[\\/]+/g, '_');
    const plain = disposition.match(/filename\s*=\s*([^;]+)/i)?.[1];
    if (plain) return plain.trim().replace(/[\\/]+/g, '_');
  } catch {}
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) return last;
  } catch {}
  return 'plugin.zip';
};

// 先走原生 http_request（不受 CORS 限制），原生不可用或失败时改用浏览器 fetch；中止时不再改走 fetch
export const downloadPluginUrl = async (url, { invoke = safeInvoke, fetchImpl = defaultFetch, signal = null } = {}) => {
  const requestUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(requestUrl)) throw new Error('仅支持 http/https 链接');
  let nativeError = null;
  try {
    const response = await invokeNativeHttpRequest({
      invoker: invoke,
      signal,
      args: {
        url: requestUrl,
        method: 'GET',
        headers: {
          Accept: 'application/zip, application/octet-stream, */*',
        },
        body: null,
        timeoutMs: 120000,
        responseBase64: true,
      },
    });
    const status = Number(response?.status || 0) || 0;
    const ok = Boolean(response?.ok) || (status >= 200 && status < 300);
    const body = String(response?.body || '');
    return {
      ok,
      status,
      bytes: ok ? base64ToByteArray(body) : [],
      name: resolveDownloadedFileName(requestUrl, response?.headers),
      url: requestUrl,
      source: 'native',
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    nativeError = err;
    if (!isInvokeUnavailableError(err)) {
      console.warn('native plugin download failed, trying browser fetch:', err);
    }
  }

  try {
    const res = await fetchImpl(requestUrl, signal ? { credentials: 'omit', signal } : { credentials: 'omit' });
    const buffer = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0);
    return {
      ok: res.ok,
      status: Number(res.status || 0) || 0,
      bytes: res.ok ? Array.from(new Uint8Array(buffer)) : [],
      name: resolveDownloadedFileName(requestUrl, Object.fromEntries(res.headers.entries())),
      url: requestUrl,
      source: 'fetch',
    };
  } catch (err) {
    if (nativeError && !isInvokeUnavailableError(nativeError) && !signal?.aborted) {
      throw new Error(`下载失败：native ${nativeError?.message || nativeError}; fetch ${err?.message || err}`);
    }
    throw err;
  }
};

// 下载插件 ZIP；GitHub 预设分支猜成 main 却不存在（404/403）时改试 master。回传 { bytes, name, url }，url 为实际下载的地址
export const downloadPluginPackage = async (url, { invoke, fetchImpl, signal = null, onRetry = null } = {}) => {
  const options = { invoke, fetchImpl, signal };
  const download = await downloadPluginUrl(url, options);
  if (download.ok) {
    return { bytes: download.bytes, name: download.name || url.split('/').pop() || 'plugin.zip', url };
  }
  if (!shouldRetryGithubMain(url, download.status)) throw new Error(`下载失败 (${download.status})`);
  const fallback = replaceGithubBranch(url, 'master');
  onRetry?.(fallback);
  const retry = await downloadPluginUrl(fallback, options);
  if (!retry.ok) throw new Error(`下载失败 (${retry.status})`);
  return { bytes: retry.bytes, name: retry.name || fallback.split('/').pop() || 'plugin.zip', url: fallback };
};

// ZIP 字节 → 已校验的 { manifest, code }；格式不对时抛出可直接给用户看的错误
export const readPluginZip = async (bytes, { invoke = safeInvoke } = {}) => {
  const result = await invoke('read_plugin_zip', { bytes: Array.isArray(bytes) ? bytes : Array.from(bytes || []) });
  const manifestText = String(result?.manifestText || '');
  const mainText = String(result?.mainText || '');
  if (!manifestText || !mainText) {
    throw new Error('ZIP 解析失败');
  }
  const manifest = JSON.parse(manifestText);
  if (isSillyTavernExtensionManifest(manifest)) {
    throw new Error(SILLY_TAVERN_EXTENSION_MESSAGE);
  }
  const { manifest: normalized, ok, errors } = validateManifest(manifest);
  if (!ok) {
    throw new Error(`manifest 校验失败：${errors.join('；')}`);
  }
  return { manifest: normalized, code: mainText };
};
