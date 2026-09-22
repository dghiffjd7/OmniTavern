import { annotateMaidResearchResult } from '../maid-source-grounding.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const truncate = (value = '', max = 4000) => {
  const text = trim(value);
  const limit = Math.max(200, Math.trunc(Number(max || 0)) || 4000);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
};

const normalizeProviderName = (value = '', fallback = 'duckduckgo') => {
  const raw = trim(value, fallback).toLowerCase().replace(/[\s-]+/g, '_');
  if (['ddg', 'duckduckgo', 'duckduckgo_instant'].includes(raw)) return 'duckduckgo';
  if (['brave', 'brave_search'].includes(raw)) return 'brave';
  if (['tavily'].includes(raw)) return 'tavily';
  if (['serpapi', 'serp_api'].includes(raw)) return 'serpapi';
  return fallback;
};

const stripHtml = (html = '', max = 6000) => {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
};

const extractTitle = (html = '') => {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return trim(stripHtml(match?.[1] || '', 300));
};

const requestWithFetch = async ({ url, method = 'GET', headers = {}, body = null, timeoutMs = 12000 } = {}, {
  signal = null,
} = {}) => {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  const onAbort = () => controller?.abort();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller?.signal,
    });
    const outHeaders = {};
    response.headers?.forEach?.((value, key) => {
      outHeaders[key] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers: outHeaders,
      body: await response.text(),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener?.('abort', onAbort);
  }
};

const createAbortError = () => {
  try {
    return new DOMException('Web request aborted', 'AbortError');
  } catch {
    const error = new Error('Web request aborted');
    error.name = 'AbortError';
    return error;
  }
};

const createWebRequestId = () => `web-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const createScopedHttpRequest = (request, abortHttpRequest, context = {}) => async (payload = {}) => {
  const signal = context?.signal || null;
  if (signal?.aborted) throw createAbortError();
  const requestId = createWebRequestId();
  const task = Promise.resolve(request({ ...payload, requestId }, { signal }));
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      try {
        Promise.resolve(abortHttpRequest?.(requestId)).catch(() => {});
      } catch {}
      settle(reject, createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(value => settle(resolve, value), error => settle(reject, error));
  });
};

const readHttpText = async (request, payload = {}) => {
  const response = await request(payload);
  const status = Number(response?.status || 0) || 0;
  if (response?.ok === false || (status && (status < 200 || status >= 300))) {
    throw new Error(`HTTP ${status || 'request failed'}`);
  }
  return String(response?.body || '');
};

const parseJsonBody = (body = '') => {
  try {
    return JSON.parse(String(body || ''));
  } catch (error) {
    const err = new Error(error?.message || 'invalid json response');
    err.code = 'invalid_json_response';
    throw err;
  }
};

const parseDuckDuckGoTopics = (topics = [], out = []) => {
  (Array.isArray(topics) ? topics : []).forEach((topic) => {
    if (Array.isArray(topic?.Topics)) {
      parseDuckDuckGoTopics(topic.Topics, out);
      return;
    }
    const title = trim(topic?.Text || topic?.Result || '');
    const url = trim(topic?.FirstURL || topic?.FirstUrl || '');
    if (!title || !url) return;
    out.push({
      title: title.split(' - ')[0] || title,
      snippet: title,
      url,
      source: 'duckduckgo',
    });
  });
  return out;
};

const normalizeSearchResults = (data = {}, limit = 5) => {
  const max = Math.max(1, Math.min(10, Math.trunc(Number(limit || 0)) || 5));
  const results = [];
  if (trim(data?.AbstractText) && trim(data?.AbstractURL)) {
    results.push({
      title: trim(data?.Heading, 'Instant Answer'),
      snippet: trim(data.AbstractText),
      url: trim(data.AbstractURL),
      source: trim(data?.AbstractSource, 'duckduckgo'),
    });
  }
  (Array.isArray(data?.Results) ? data.Results : []).forEach((item) => {
    const title = trim(item?.Text || item?.Result || '');
    const url = trim(item?.FirstURL || item?.FirstUrl || '');
    if (title && url) {
      results.push({
        title: title.split(' - ')[0] || title,
        snippet: title,
        url,
        source: 'duckduckgo',
      });
    }
  });
  parseDuckDuckGoTopics(data?.RelatedTopics, results);
  const seen = new Set();
  return results
    .filter((item) => {
      const key = trim(item.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
};

const normalizeGenericResults = (items = [], {
  limit = 5,
  provider = '',
  map = item => item,
} = {}) => {
  const max = Math.max(1, Math.min(10, Math.trunc(Number(limit || 0)) || 5));
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map(map)
    .map(item => ({
      title: truncate(item?.title || item?.name || item?.url || '', 220),
      snippet: truncate(item?.snippet || item?.description || item?.content || '', 900),
      url: trim(item?.url || item?.link),
      source: trim(item?.source || provider),
    }))
    .filter((item) => {
      const key = trim(item.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
};

const getSearchConfigValue = (config = {}, keys = [], fallback = '') => {
  for (const key of keys) {
    const value = trim(config?.[key]);
    if (value) return value;
  }
  return fallback;
};

const resolveSearchConfig = ({
  args = {},
  baseConfig = {},
  searchProvider = 'duckduckgo',
  apiKey = '',
} = {}) => {
  const provider = normalizeProviderName(
    baseConfig.webSearchProvider ||
    baseConfig.provider ||
    searchProvider,
    'duckduckgo',
  );
  const key = getSearchConfigValue(baseConfig, [
    `${provider}ApiKey`,
    `${provider}SearchApiKey`,
    provider === 'brave' ? 'braveSearchApiKey' : '',
    provider === 'tavily' ? 'tavilyApiKey' : '',
    provider === 'serpapi' ? 'serpApiKey' : '',
    'apiKey',
  ].filter(Boolean), apiKey);
  return {
    provider,
    apiKey: key,
    locale: trim(args.locale || baseConfig.webSearchLocale || baseConfig.locale, 'zh-tw'),
    endpoint: trim(baseConfig.webSearchEndpoint || baseConfig.endpoint),
  };
};

const requireApiKey = (provider, apiKey) => {
  if (trim(apiKey)) return null;
  return {
    ok: false,
    provider,
    reason: 'missing_api_key',
    message: `${provider} 搜索需要先配置 API key。`,
    results: [],
  };
};

// DDG HTML 版全文搜索（服务端渲染，免 key）：Instant Answer 空结果时的回落。
// 链接是 /l/?uddg=<编码URL> 重定向格式，需解码。
const decodeDuckDuckGoRedirect = (href = '') => {
  const raw = trim(href);
  const match = raw.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return '';
    }
  }
  return /^https?:\/\//i.test(raw) ? raw : '';
};

const parseDuckDuckGoHtmlResults = (html = '', limit = 5) => {
  const out = [];
  const source = String(html || '');
  const pattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
  let match = pattern.exec(source);
  while (match && out.length < Math.max(1, Math.min(10, limit))) {
    const url = decodeDuckDuckGoRedirect(match[1]);
    const title = trim(stripHtml(match[2] || '', 220));
    const snippet = trim(stripHtml(match[3] || '', 500));
    if (url && title && !out.some(item => item.url === url)) {
      out.push({ title, snippet: snippet || title, url, source: 'duckduckgo_html' });
    }
    match = pattern.exec(source);
  }
  return out;
};

const decodeXmlText = (value = '') => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    try {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    } catch {
      return '';
    }
  })
  .replace(/&#(\d+);/g, (_, digits) => {
    try {
      return String.fromCodePoint(Number.parseInt(digits, 10));
    } catch {
      return '';
    }
  })
  .replace(/&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&gt;/gi, '>')
  .replace(/&lt;/gi, '<')
  .replace(/&amp;/gi, '&');

const readXmlTag = (source = '', tag = '') => {
  const match = String(source || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXmlText(match?.[1] || '');
};

const parseBingRssResults = (xml = '', limit = 5) => {
  const out = [];
  const source = String(xml || '');
  const pattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  const max = Math.max(1, Math.min(10, Math.trunc(Number(limit || 0)) || 5));
  let match = pattern.exec(source);
  while (match && out.length < max) {
    const item = match[1] || '';
    const url = trim(readXmlTag(item, 'link'));
    const title = trim(stripHtml(readXmlTag(item, 'title'), 220))
      .replace(/\s+([.,!?;:，。！？；：])/g, '$1');
    const snippet = trim(stripHtml(readXmlTag(item, 'description'), 900))
      .replace(/\s+([.,!?;:，。！？；：])/g, '$1');
    if (/^https?:\/\//i.test(url) && title && !out.some(result => result.url === url)) {
      out.push({
        title,
        snippet: snippet || title,
        url,
        source: 'bing_rss',
      });
    }
    match = pattern.exec(source);
  }
  return out;
};

const performDuckDuckGoHtmlSearch = async (request, { query = '', limit = 5 } = {}) => {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: null,
    timeoutMs: 15000,
  });
  return parseDuckDuckGoHtmlResults(body, limit);
};

const performBingRssSearch = async (request, { query = '', limit = 5 } = {}) => {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: {
      accept: 'application/rss+xml,application/xml,text/xml',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: null,
    timeoutMs: 15000,
  });
  return parseBingRssResults(body, limit);
};

const performDuckDuckGoSearch = async (request, { query = '', limit = 5, locale = 'zh-tw' } = {}) => {
  const attemptedProviders = [];
  const providerOutcomes = [];
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  url.searchParams.set('kl', locale);
  attemptedProviders.push('duckduckgo_instant');
  try {
    const body = await readHttpText(request, {
      url: url.toString(),
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      body: null,
      timeoutMs: 12000,
    });
    const results = normalizeSearchResults(parseJsonBody(body), limit);
    if (results.length) {
      return {
        provider: 'duckduckgo',
        attemptedProviders,
        providerOutcomes,
        results,
      };
    }
    providerOutcomes.push('duckduckgo_instant:no_results');
  } catch (error) {
    providerOutcomes.push(`duckduckgo_instant:${trim(error?.message, 'failed')}`);
  }
  // Instant Answer 是知识卡 API，实体/长尾查询常为空；回落 HTML 版全文搜索。
  attemptedProviders.push('duckduckgo_html');
  try {
    const results = await performDuckDuckGoHtmlSearch(request, { query, limit });
    if (results.length) {
      return {
        provider: 'duckduckgo_html',
        attemptedProviders,
        providerOutcomes,
        results,
      };
    }
    providerOutcomes.push('duckduckgo_html:no_results');
  } catch (error) {
    providerOutcomes.push(`duckduckgo_html:${trim(error?.message, 'failed')}`);
  }
  // DDG HTML 可能返回 202 bot challenge；Bing RSS 是免 key 的结构化全文搜索回落。
  attemptedProviders.push('bing_rss');
  try {
    const results = await performBingRssSearch(request, { query, limit });
    if (results.length) {
      return {
        provider: 'bing_rss',
        attemptedProviders,
        providerOutcomes,
        results,
      };
    }
    providerOutcomes.push('bing_rss:no_results');
  } catch (error) {
    providerOutcomes.push(`bing_rss:${trim(error?.message, 'failed')}`);
  }
  return {
    provider: 'duckduckgo',
    attemptedProviders,
    providerOutcomes,
    results: [],
  };
};

// Bing 图片搜索（免 key，服务端渲染）：解析 iusc 元素 m 属性里的 JSON（murl=原图）。
const decodeHtmlEntities = (value = '') => String(value || '')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#39;/g, "'");

const parseBingImageResults = (html = '', limit = 6) => {
  const out = [];
  const source = String(html || '');
  const pattern = /class="iusc"[^>]*\bm="([^"]+)"/g;
  const max = Math.max(1, Math.min(12, Math.trunc(Number(limit || 0)) || 6));
  let match = pattern.exec(source);
  while (match && out.length < max) {
    try {
      const meta = JSON.parse(decodeHtmlEntities(match[1]));
      const imageUrl = trim(meta?.murl);
      if (/^https?:\/\//i.test(imageUrl) && !out.some(item => item.imageUrl === imageUrl)) {
        out.push({
          title: truncate(meta?.t || '', 160),
          imageUrl,
          thumbnailUrl: trim(meta?.turl),
          width: 0,
          height: 0,
          sourceUrl: trim(meta?.purl),
        });
      }
    } catch {}
    match = pattern.exec(source);
  }
  return out;
};

// —— 专用图库 API（稳定服务，非爬虫；多源图搜网关 2026-07-07）——

// booru 标签化：优先显式 tags。容忍模型常见给法——逗号/中文逗号/顿号分隔、tag 内空格，
// 逐个 tag 下划线化后按 booru 约定用空格连接（2026-07-17：逗号原样透传曾让 safebooru 全部空结果）。
const normalizeBooruTag = value => trim(value).toLowerCase().replace(/\s+/g, '_');

const toBooruTags = (query = '', tags = '') => {
  const explicit = trim(tags);
  const parts = explicit
    ? explicit.split(/[,，、]+/)
    // query 回退：自然词组按词拆成独立 tag（整句转单 tag 必然无结果）
    : trim(query).split(/\s+/);
  return parts
    .map(normalizeBooruTag)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
};

// Safebooru（Gelbooru 系 API，全站 SFW，免 key）。
// 多个具体 tag AND 极易交集为空（2026-07-17 实测 ojou-sama+blonde+twintails=0 而 ojou-sama 单独有图）：
// 无结果时按 全量 → 前2个 → 第1个 逐级放宽重试。
const performSafebooruImageSearch = async (request, { query = '', tags = '', limit = 6 } = {}) => {
  const allTags = toBooruTags(query, tags).split(' ').filter(Boolean);
  const candidates = [];
  [allTags, allTags.slice(0, 2), allTags.slice(0, 1)].forEach((list) => {
    const text = list.join(' ');
    if (text && !candidates.includes(text)) candidates.push(text);
  });
  let completedAttempts = 0;
  let lastError = null;
  for (const tagText of candidates) {
    const url = new URL('https://safebooru.org/index.php');
    url.searchParams.set('page', 'dapi');
    url.searchParams.set('s', 'post');
    url.searchParams.set('q', 'index');
    url.searchParams.set('json', '1');
    url.searchParams.set('limit', String(Math.min(20, limit * 2)));
    url.searchParams.set('tags', `${tagText} sort:score:desc`);
    try {
      const body = await readHttpText(request, {
        url: url.toString(),
        method: 'GET',
        headers: { accept: 'application/json' },
        body: null,
        timeoutMs: 20000,
      });
      const posts = parseJsonBody(body || '[]');
      completedAttempts += 1;
      const images = (Array.isArray(posts) ? posts : [])
        .filter(post => post?.image && post?.directory)
        .slice(0, limit)
        .map(post => ({
          title: truncate(String(post.tags || '').split(' ').slice(0, 6).join(' '), 160),
          imageUrl: `https://safebooru.org/images/${post.directory}/${post.image}`,
          thumbnailUrl: `https://safebooru.org/thumbnails/${post.directory}/thumbnail_${String(post.image).replace(/\.[a-z0-9]+$/i, '.jpg')}`,
          width: Number(post.width) || 0,
          height: Number(post.height) || 0,
          sourceUrl: `https://safebooru.org/index.php?page=post&s=view&id=${post.id}`,
        }));
      if (images.length > 0) return { ok: true, images, provider: 'safebooru', usedTags: tagText };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    images: [],
    provider: 'safebooru',
    reason: completedAttempts > 0
      ? '无结果（已含降级重试）'
      : `请求失败（已含降级重试）：${trim(lastError?.message, 'unknown')}`,
  };
};

// Danbooru（匿名限 2 标签：主标签 + order:score）
const performDanbooruImageSearch = async (request, { query = '', tags = '', limit = 6 } = {}) => {
  const mainTag = toBooruTags(query, tags).split(' ')[0] || '';
  if (!mainTag) return { ok: false, images: [], provider: 'danbooru', reason: '缺少有效标签' };
  const url = new URL('https://danbooru.donmai.us/posts.json');
  url.searchParams.set('tags', `${mainTag} order:score`);
  url.searchParams.set('limit', String(Math.min(20, limit * 2)));
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    body: null,
    timeoutMs: 20000,
  });
  const posts = parseJsonBody(body || '[]');
  const images = (Array.isArray(posts) ? posts : [])
    .filter(post => /^https?:\/\//.test(String(post?.large_file_url || post?.file_url || '')))
    .slice(0, limit)
    .map(post => ({
      title: truncate(String(post.tag_string_character || post.tag_string || '').split(' ').slice(0, 5).join(' '), 160),
      imageUrl: String(post.large_file_url || post.file_url),
      thumbnailUrl: String(post.preview_file_url || ''),
      width: Number(post.image_width) || 0,
      height: Number(post.image_height) || 0,
      sourceUrl: `https://danbooru.donmai.us/posts/${post.id}`,
    }));
  return { ok: images.length > 0, images, provider: 'danbooru' };
};

// Wallhaven（壁纸站官方 API，免 key，45 次/分钟）
const performWallhavenImageSearch = async (request, { query = '', limit = 6, animeOnly = true } = {}) => {
  const url = new URL('https://wallhaven.cc/api/v1/search');
  url.searchParams.set('q', trim(query));
  url.searchParams.set('categories', animeOnly ? '010' : '111');
  url.searchParams.set('purity', '100');
  url.searchParams.set('sorting', 'relevance');
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    body: null,
    timeoutMs: 20000,
  });
  const parsed = parseJsonBody(body || '{}');
  const images = (Array.isArray(parsed?.data) ? parsed.data : [])
    .filter(item => /^https?:\/\//.test(String(item?.path || '')))
    .slice(0, limit)
    .map(item => ({
      title: truncate(`wallpaper ${item.resolution || ''}`.trim(), 160),
      imageUrl: String(item.path),
      thumbnailUrl: String(item.thumbs?.small || item.thumbs?.original || ''),
      width: Number(item.dimension_x) || 0,
      height: Number(item.dimension_y) || 0,
      sourceUrl: String(item.url || ''),
    }));
  return { ok: images.length > 0, images, provider: 'wallhaven' };
};

// Openverse（开放版权图片聚合，免 key 匿名可用，429 时明确报错）——写实/通用照片
const performOpenverseImageSearch = async (request, { query = '', limit = 6 } = {}) => {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.searchParams.set('q', trim(query));
  url.searchParams.set('page_size', String(Math.min(20, limit)));
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    body: null,
    timeoutMs: 20000,
  });
  const parsed = parseJsonBody(body || '{}');
  const images = (Array.isArray(parsed?.results) ? parsed.results : [])
    .filter(item => /^https?:\/\//.test(String(item?.url || '')))
    .slice(0, limit)
    .map(item => ({
      title: truncate(String(item.title || ''), 160),
      imageUrl: String(item.url),
      thumbnailUrl: String(item.thumbnail || ''),
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      sourceUrl: String(item.foreign_landing_url || ''),
    }));
  return { ok: images.length > 0, images, provider: 'openverse' };
};

const performBingImageSearch = async (request, { query = '', limit = 6 } = {}) => {
  const url = new URL('https://www.bing.com/images/search');
  url.searchParams.set('q', query);
  url.searchParams.set('form', 'HDRSC2');
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
    body: null,
    timeoutMs: 20000,
  });
  const images = parseBingImageResults(body, limit);
  // 高频请求会触发 Bing 限流降级，且存在两种形态：整页非搜索页，或页面正常但索引层
  // 返回完全无关的结果（title 回显查询词但图是随机内容）。用结果级相关性判定：
  // 所有结果 title 均不含查询任一词（≥2 字符）才判降级，避免把无关图当结果用。
  const tokens = trim(query).toLowerCase().split(/\s+/).filter(word => word.length >= 2);
  const anyRelevant = images.some((img) => {
    const title = String(img?.title || '').toLowerCase();
    return tokens.some(word => title.includes(word));
  });
  const degraded = images.length > 0 && tokens.length > 0 && !anyRelevant;
  return {
    ok: images.length > 0 && !degraded,
    images: degraded ? [] : images,
    provider: 'bing_images',
    ...(degraded ? {
      degraded: true,
      message: '图片搜索服务疑似限流降级（返回了与查询无关的页面），请稍后再试或换用其他方式获取图片。',
    } : {}),
  };
};

// DDG 图片搜索（免 key）：先取 vqd token，再调 i.js 拿图片 JSON。
const extractDuckDuckGoVqd = (html = '') => {
  const source = String(html || '');
  const match = source.match(/vqd=["']?([\d-]+)["']?/) || source.match(/vqd=([\d-]+)&/);
  return trim(match?.[1] || '');
};

const performDuckDuckGoImageSearch = async (request, { query = '', limit = 6 } = {}) => {
  const tokenUrl = new URL('https://duckduckgo.com/');
  tokenUrl.searchParams.set('q', query);
  tokenUrl.searchParams.set('iax', 'images');
  tokenUrl.searchParams.set('ia', 'images');
  const tokenHtml = await readHttpText(request, {
    url: tokenUrl.toString(),
    method: 'GET',
    headers: {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: null,
    timeoutMs: 15000,
  });
  const vqd = extractDuckDuckGoVqd(tokenHtml);
  if (!vqd) {
    return { ok: false, reason: 'image_search_token_missing', message: '图片搜索初始化失败（vqd token 未获取）。', images: [] };
  }
  const searchUrl = new URL('https://duckduckgo.com/i.js');
  searchUrl.searchParams.set('l', 'us-en');
  searchUrl.searchParams.set('o', 'json');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('vqd', vqd);
  const body = await readHttpText(request, {
    url: searchUrl.toString(),
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      referer: 'https://duckduckgo.com/',
    },
    body: null,
    timeoutMs: 15000,
  });
  const data = parseJsonBody(body);
  const max = Math.max(1, Math.min(12, Math.trunc(Number(limit || 0)) || 6));
  const images = (Array.isArray(data?.results) ? data.results : [])
    .map(item => ({
      title: truncate(item?.title || '', 160),
      imageUrl: trim(item?.image),
      thumbnailUrl: trim(item?.thumbnail),
      width: Number(item?.width || 0) || 0,
      height: Number(item?.height || 0) || 0,
      sourceUrl: trim(item?.url),
    }))
    .filter(item => /^https?:\/\//i.test(item.imageUrl))
    .slice(0, max);
  return { ok: images.length > 0, images, provider: 'duckduckgo_images' };
};

const performBraveSearch = async (request, { query = '', limit = 5, locale = 'zh-tw', apiKey = '' } = {}) => {
  const missing = requireApiKey('brave', apiKey);
  if (missing) return missing;
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.max(1, Math.min(10, limit))));
  if (locale) url.searchParams.set('search_lang', locale.split('-')[0] || locale);
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: {
      accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    body: null,
    timeoutMs: 12000,
  });
  const data = parseJsonBody(body);
  return normalizeGenericResults(data?.web?.results || [], {
    limit,
    provider: 'brave',
    map: item => ({
      title: item?.title,
      snippet: item?.description,
      url: item?.url,
      source: 'brave',
    }),
  });
};

const performTavilySearch = async (request, { query = '', limit = 5, apiKey = '' } = {}) => {
  const missing = requireApiKey('tavily', apiKey);
  if (missing) return missing;
  const body = await readHttpText(request, {
    url: 'https://api.tavily.com/search',
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: Math.max(1, Math.min(10, limit)),
      include_answer: false,
    }),
    timeoutMs: 15000,
  });
  const data = parseJsonBody(body);
  return normalizeGenericResults(data?.results || [], {
    limit,
    provider: 'tavily',
    map: item => ({
      title: item?.title,
      snippet: item?.content,
      url: item?.url,
      source: 'tavily',
    }),
  });
};

const performSerpApiSearch = async (request, { query = '', limit = 5, apiKey = '', locale = 'zh-tw' } = {}) => {
  const missing = requireApiKey('serpapi', apiKey);
  if (missing) return missing;
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', String(Math.max(1, Math.min(10, limit))));
  if (locale) url.searchParams.set('hl', locale.split('-')[0] || locale);
  const body = await readHttpText(request, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    body: null,
    timeoutMs: 12000,
  });
  const data = parseJsonBody(body);
  return normalizeGenericResults(data?.organic_results || [], {
    limit,
    provider: 'serpapi',
    map: item => ({
      title: item?.title,
      snippet: item?.snippet,
      url: item?.link,
      source: item?.source || 'serpapi',
    }),
  });
};

const performSearch = async (request, {
  provider = 'duckduckgo',
  query = '',
  limit = 5,
  locale = 'zh-tw',
  apiKey = '',
} = {}) => {
  if (provider === 'brave') return performBraveSearch(request, { query, limit, locale, apiKey });
  if (provider === 'tavily') return performTavilySearch(request, { query, limit, apiKey });
  if (provider === 'serpapi') return performSerpApiSearch(request, { query, limit, locale, apiKey });
  return performDuckDuckGoSearch(request, { query, limit, locale });
};

const normalizeSearchOutput = ({ query = '', provider = '', results = [] } = {}) => {
  if (results?.ok === false) {
    return {
      ...results,
      query,
      provider: trim(results.provider, provider),
    };
  }
  const listResults = Array.isArray(results)
    ? results
    : (Array.isArray(results?.results) ? results.results : []);
  const effectiveProvider = trim(results?.provider, provider);
  const output = {
    ok: listResults.length > 0,
    query,
    provider: effectiveProvider,
    results: clone(listResults),
    sources: listResults.map(item => ({
      title: trim(item.title || item.url),
      url: trim(item.url),
      source: trim(item.source, effectiveProvider),
    })),
    message: listResults.length ? '' : '没有找到可用的网页搜索结果。',
  };
  if (effectiveProvider !== provider) output.requestedProvider = provider;
  if (Array.isArray(results?.attemptedProviders)) {
    output.attemptedProviders = clone(results.attemptedProviders);
  }
  if (Array.isArray(results?.providerOutcomes) && results.providerOutcomes.length) {
    output.providerOutcomes = clone(results.providerOutcomes);
  }
  return output;
};

const fetchReadableUrl = async (request, {
  url = '',
  maxTextLength = 5000,
} = {}) => {
  const target = trim(url);
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, url: target, reason: 'unsupported_url', message: '只支持 http/https 网页。' };
  }
  const body = await readHttpText(request, {
    url: target,
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'user-agent': 'Mozilla/5.0 OmniTavern-Maid-Assistant/0.7.3-diagnose-1',
    },
    body: null,
    timeoutMs: 12000,
  });
  const max = Math.max(500, Math.min(12000, Math.trunc(Number(maxTextLength || 0)) || 5000));
  return {
    ok: true,
    url: target,
    title: extractTitle(body),
    text: stripHtml(body, max),
  };
};

export const createWebSearchAgentTools = ({
  httpRequest = requestWithFetch,
  abortHttpRequest = null,
  getSearchConfig = null,
  searchProvider = 'duckduckgo',
  apiKey = '',
} = {}) => {
  const request = typeof httpRequest === 'function' ? httpRequest : requestWithFetch;
  const readConfig = async () => {
    try {
      return typeof getSearchConfig === 'function' ? (await getSearchConfig() || {}) : {};
    } catch {
      return {};
    }
  };
  return [
    {
      name: 'web.search',
      title: 'Search the web',
      description: 'Search public web information when the user asks for current or external facts. Do not use it for private APP data.',
      source: 'maid-web',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: true,
        cost: 'variable',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 240 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
          locale: { type: 'string', maxLength: 20 },
        },
      },
      execute: async (args = {}, context = {}) => {
        const scopedRequest = createScopedHttpRequest(request, abortHttpRequest, context);
        const query = trim(args.query);
        const limit = Math.max(1, Math.min(10, Math.trunc(Number(args.limit || 0)) || 5));
        const config = resolveSearchConfig({
          args,
          baseConfig: await readConfig(),
          searchProvider,
          apiKey,
        });
        try {
          const results = await performSearch(scopedRequest, {
            ...config,
            query,
            limit,
          });
          return normalizeSearchOutput({
            query,
            provider: config.provider,
            results,
          });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          return {
            ok: false,
            query,
            provider: config.provider,
            reason: error?.code || 'search_request_failed',
            message: error?.message || '搜索请求失败。',
            results: [],
          };
        }
      },
      summarizeResult: result => result?.ok === false
        ? `web search failed: ${trim(result?.reason || result?.message, 'no_results')}`
        : `web search results=${Number(result?.results?.length || 0)} query=${trim(result?.query, '-')}`,
    },
    {
      name: 'web.search_images',
      title: 'Search web images',
      description: 'Search public web images (e.g. avatars, wallpapers) and return image URLs. Follow with media.fetch_image to download one.',
      source: 'maid-web',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: true,
        cost: 'variable',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 240 },
          limit: { type: 'integer', minimum: 1, maximum: 12 },
          purpose: { type: 'string', enum: ['avatar', 'wallpaper', 'any'] },
          style: { type: 'string', enum: ['anime', 'photo', 'any'] },
          tags: {
            type: 'string',
            maxLength: 240,
            description: 'Booru tags for anime sources: space-separated, underscores inside a tag, e.g. "blonde_hair twintails 1girl". Do NOT use commas.',
          },
        },
      },
      execute: async (args = {}, context = {}) => {
        const scopedRequest = createScopedHttpRequest(request, abortHttpRequest, context);
        let query = trim(args.query);
        const tags = trim(args.tags);
        if (!query && !tags) {
          return {
            ok: false,
            query: '',
            provider: '',
            attemptedProviders: [],
            providerOutcomes: [],
            reason: 'image_search_query_missing',
            message: '图片搜索需要 query 或 tags 至少一项。',
            images: [],
          };
        }
        // 仅给 tags：booru 直接用 tags；通用图源（wallhaven/openverse/bing/ddg）用 tags 还原自然词组当 query
        if (!query) {
          query = tags
            .split(/[,，、\s]+/)
            .map(part => trim(part).replace(/_/g, ' ').toLowerCase())
            .filter(Boolean)
            .join(' ');
        }
        const limit = Math.max(1, Math.min(12, Math.trunc(Number(args.limit || 0)) || 6));
        const purpose = trim(args.purpose, 'any');
        const style = trim(args.style, 'any');
        // 多源网关：专用图库 API（稳定服务）优先，通用爬虫（Bing/DDG）回落。
        const providers = [];
        const preferAnime = style !== 'photo';
        if (purpose === 'wallpaper') {
          providers.push(['wallhaven', () => performWallhavenImageSearch(scopedRequest, { query, limit, animeOnly: preferAnime })]);
          if (preferAnime) providers.push(['safebooru', () => performSafebooruImageSearch(scopedRequest, { query, tags, limit })]);
          if (style === 'photo') providers.push(['openverse', () => performOpenverseImageSearch(scopedRequest, { query, limit })]);
        } else if (style === 'photo') {
          providers.push(['openverse', () => performOpenverseImageSearch(scopedRequest, { query, limit })]);
        } else {
          providers.push(['safebooru', () => performSafebooruImageSearch(scopedRequest, { query, tags, limit })]);
          providers.push(['danbooru', () => performDanbooruImageSearch(scopedRequest, { query, tags, limit })]);
          if (style === 'any') providers.push(['openverse', () => performOpenverseImageSearch(scopedRequest, { query, limit })]);
        }
        providers.push(['bing_images', () => performBingImageSearch(scopedRequest, { query, limit })]);
        providers.push(['duckduckgo_images', () => performDuckDuckGoImageSearch(scopedRequest, { query, limit })]);

        const attempted = [];
        const outcomes = [];
        let lastError = null;
        for (const [name, run] of providers) {
          attempted.push(name);
          try {
            const result = await run();
            if (result?.ok && (result.images || []).length > 0) {
              return {
                ok: true,
                query,
                provider: result.provider || name,
                attemptedProviders: attempted,
                images: result.images,
              };
            }
            outcomes.push(`${name}:${trim(result?.reason || result?.message, '无结果')}`);
            if (result?.degraded) lastError = new Error(result.message || 'provider degraded');
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            outcomes.push(`${name}:${trim(error?.message, 'error')}`);
            lastError = error;
          }
        }
        // 按源逐个汇报（勿把个别源的 403 汇总成"全部 403"）；提示标签格式便于模型自我修正
        return {
          ok: false,
          query,
          provider: attempted.join('+'),
          attemptedProviders: attempted,
          providerOutcomes: outcomes,
          reason: lastError?.code || 'image_search_no_results',
          message: `各图源均未返回图片（${outcomes.join('；')}）。动漫图建议改用英文 booru 标签重试：空格分隔、词内下划线，如 tags="blonde_hair twintails 1girl"。`,
          images: [],
        };
      },
      summarizeResult: result => result?.ok === false
        ? `image search failed: ${trim(result?.reason || result?.message, 'no_results')}`
        : `image search results=${Number(result?.images?.length || 0)} query=${trim(result?.query, '-')}`,
    },
    {
      name: 'web.fetch_url',
      title: 'Fetch web page',
      description: 'Fetch and extract readable text from a public URL returned by search or provided by the user.',
      source: 'maid-web',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: true,
        cost: 'variable',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', minLength: 8, maxLength: 1000 },
          maxTextLength: { type: 'integer', minimum: 500, maximum: 12000 },
        },
      },
      execute: async (args = {}, context = {}) => {
        const scopedRequest = createScopedHttpRequest(request, abortHttpRequest, context);
        const maxTextLength = Math.max(500, Math.min(12000, Math.trunc(Number(args.maxTextLength || 0)) || 5000));
        return fetchReadableUrl(scopedRequest, {
          url: args.url,
          maxTextLength,
        });
      },
      summarizeResult: result => result?.ok === false
        ? `web fetch failed: ${trim(result?.reason, 'failed')}`
        : `web fetch ${trim(result?.title || result?.url, 'page')}`,
    },
    {
      name: 'web.research',
      title: 'Search and read web sources',
      description: 'Search public web information and fetch readable text from top results in one controlled tool call. Use it for current public facts that need citations.',
      source: 'maid-web',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: true,
        cost: 'variable',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 240 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
          fetchTop: { type: 'integer', minimum: 0, maximum: 5 },
          locale: { type: 'string', maxLength: 20 },
          maxTextLength: { type: 'integer', minimum: 500, maximum: 12000 },
          target: {
            type: 'string',
            maxLength: 160,
            description: 'Named work/person/topic whose identity must be checked before the sources can support canon facts.',
          },
          targetAliases: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 120 },
            description: 'Known alternate titles/names used to match sources to target.',
          },
        },
      },
      execute: async (args = {}, context = {}) => {
        const scopedRequest = createScopedHttpRequest(request, abortHttpRequest, context);
        const query = trim(args.query);
        const limit = Math.max(1, Math.min(10, Math.trunc(Number(args.limit || 0)) || 5));
        const hasFetchTop = Object.prototype.hasOwnProperty.call(args, 'fetchTop');
        const rawFetchTop = hasFetchTop ? Number(args.fetchTop) : NaN;
        const fetchTop = hasFetchTop && Number.isFinite(rawFetchTop)
          ? Math.max(0, Math.min(5, Math.trunc(rawFetchTop)))
          : 2;
        const maxTextLength = Math.max(500, Math.min(12000, Math.trunc(Number(args.maxTextLength || 0)) || 4000));
        const config = resolveSearchConfig({
          args,
          baseConfig: await readConfig(),
          searchProvider,
          apiKey,
        });
        const search = await (async () => {
          try {
            const results = await performSearch(scopedRequest, {
              ...config,
              query,
              limit,
            });
            return normalizeSearchOutput({ query, provider: config.provider, results });
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            return {
              ok: false,
              query,
              provider: config.provider,
              reason: error?.code || 'search_request_failed',
              message: error?.message || '搜索请求失败。',
              results: [],
            };
          }
        })();
        const documents = [];
        if (search.ok && fetchTop > 0) {
          for (const result of search.results.slice(0, fetchTop)) {
            try {
              const document = await fetchReadableUrl(scopedRequest, {
                url: result.url,
                maxTextLength,
              });
              documents.push({
                ok: document.ok,
                title: trim(document.title || result.title),
                url: result.url,
                source: trim(result.source, config.provider),
                text: trim(document.text),
                reason: trim(document.reason),
              });
            } catch (error) {
              if (error?.name === 'AbortError') throw error;
              documents.push({
                ok: false,
                title: trim(result.title),
                url: result.url,
                source: trim(result.source, config.provider),
                reason: error?.message || 'fetch_failed',
                text: '',
              });
            }
          }
        }
        return annotateMaidResearchResult({
          ...search,
          documents,
          sources: search.sources || search.results?.map(item => ({
            title: trim(item.title || item.url),
            url: trim(item.url),
            source: trim(item.source, config.provider),
          })) || [],
        }, args);
      },
      summarizeResult: result => result?.ok === false
        ? `web research failed: ${trim(result?.reason || result?.message, 'no_results')}`
        : `web research results=${Number(result?.results?.length || 0)} documents=${Number(result?.documents?.length || 0)} query=${trim(result?.query, '-')}`,
    },
  ];
};

export const registerWebSearchAgentTools = (registry, deps = {}) => {
  const tools = createWebSearchAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
