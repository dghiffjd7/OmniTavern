import { resolveLocale, translateFromCatalog } from './locale-utils.js';
import { setPromptLocale } from './prompt-locale.js';

const TRANSLATABLE_ATTRIBUTES = Object.freeze(['aria-label', 'placeholder', 'title', 'data-help']);
const SHARED_SKIP_SELECTORS = [
  'script',
  'style',
  'code',
  'pre',
  '[contenteditable="true"]',
  '[data-i18n-skip]',
  '#current-chat-title',
  '#chat-scroll .QQ_chat_msgdiv',
  '#chat-scroll .message-bubble',
  '#chat-scroll .message-content',
  '#chat-scroll .rich-fragment',
  '#prompt-preview-panel .prompt-document-scroll',
  '.prompt-preview-copy-source',
  '#preset-preview-body',
  '.chat-item-preview',
  '.group-name-label',
  '.user-nickname',
  '.moment-content',
  '.moment-username',
  '.moment-text',
  '.moment-detail-text',
  '.memory-table-cell-value',
  '.memory-table-cell-tag',
];
const SKIP_SELECTOR = ['textarea', ...SHARED_SKIP_SELECTORS].join(',');
const ATTRIBUTE_SKIP_SELECTOR = SHARED_SKIP_SELECTORS.join(',');

let runtimeState = {
  preference: 'zh-CN',
  requestedLocale: 'zh-CN',
  locale: 'zh-CN',
  catalog: Object.freeze({}),
  loadError: '',
};
let templateEntries = [];
let domObserver = null;

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compileTemplateEntry = ([source, translated]) => {
  if (!/\{[a-zA-Z0-9_.-]+\}/.test(source)) return null;
  const names = [];
  let cursor = 0;
  let pattern = '';
  const literals = [];
  const matcher = /\{([a-zA-Z0-9_.-]+)\}/g;
  let match;
  while ((match = matcher.exec(source))) {
    literals.push(source.slice(cursor, match.index));
    pattern += escapeRegExp(source.slice(cursor, match.index));
    pattern += match[1] === 'count' ? '(-?[\\d,.\\s\\u00A0\\u202F]+?)' : '(.+?)';
    names.push(match[1]);
    cursor = match.index + match[0].length;
  }
  literals.push(source.slice(cursor));
  pattern += escapeRegExp(source.slice(cursor));
  const literalLength = source.replace(/\{[a-zA-Z0-9_.-]+\}/g, '').length;
  // probe：最长字面段（按查表侧同样的空白归一化）。不含该段的文本必然不匹配，
  // 用廉价 includes 预筛，避免上千条模板正则对每个未命中文本节点全量 exec。
  const probe = literals
    .map(part => part.replace(/\s+/g, ' '))
    .reduce((best, part) => (part.length > best.length ? part : best), '');
  return { source, translated, names, literalLength, probe, regex: new RegExp(`^${pattern}$`) };
};

const rebuildTemplateEntries = () => {
  templateEntries = Object.entries(runtimeState.catalog || {})
    .map(compileTemplateEntry)
    .filter(Boolean)
    .sort((left, right) => right.literalLength - left.literalLength);
};

const loadCatalog = async (locale, fetchFn) => {
  if (locale === 'zh-CN') return {};
  if (typeof fetchFn !== 'function') throw new Error(`i18n fetch unavailable for ${locale}`);
  const url = new URL(`./locales/${locale}.json`, import.meta.url);
  const response = await fetchFn(url);
  if (!response?.ok) throw new Error(`i18n catalog load failed: ${locale} (${response?.status || 0})`);
  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`i18n catalog is invalid: ${locale}`);
  }
  return parsed;
};

export const initializeI18n = async ({
  preference = 'system',
  systemLocale = '',
  fetchFn = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  documentLike = typeof document !== 'undefined' ? document : null,
} = {}) => {
  const requestedLocale = resolveLocale({ preference, systemLocale });
  let locale = requestedLocale;
  let catalog = {};
  let loadError = '';
  try {
    catalog = await loadCatalog(requestedLocale, fetchFn);
  } catch (error) {
    locale = 'zh-CN';
    catalog = {};
    loadError = String(error?.message || error || 'catalog load failed');
    console.error('[i18n]', loadError);
  }
  runtimeState = {
    preference,
    requestedLocale,
    locale,
    catalog: Object.freeze({ ...catalog }),
    loadError,
  };
  setPromptLocale(locale);
  rebuildTemplateEntries();
  applyDocumentLocale(documentLike);
  return getI18nState();
};

export const getI18nState = () => ({ ...runtimeState, catalog: runtimeState.catalog });
export const getCurrentLocale = () => runtimeState.locale;
// 「标签：内容」里的冒号：中文界面用全角，其他语言用半角加空格
export const localeColon = () => (String(runtimeState.locale).startsWith('zh') ? '：' : ': ');

export const formatNumber = (value, options = {}) => {
  try {
    return new Intl.NumberFormat(runtimeState.locale, options).format(value);
  } catch {
    return String(value ?? '');
  }
};

export const formatDateTime = (value, options = {}) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? '');
  try {
    return new Intl.DateTimeFormat(runtimeState.locale, options).format(date);
  } catch {
    return String(value ?? '');
  }
};

export const t = (source, params = {}, options = {}) => translateFromCatalog({
  source,
  params: params && typeof params === 'object' ? params : {},
  context: String(options?.context || ''),
  catalog: runtimeState.catalog,
  locale: runtimeState.locale,
});

const translateTemplateValue = (source = '') => {
  for (const entry of templateEntries) {
    if (entry.probe && !source.includes(entry.probe)) continue;
    const match = entry.regex.exec(source);
    if (!match) continue;
    const params = {};
    entry.names.forEach((name, index) => { params[name] = translateUiText(match[index + 1]); });
    return translateFromCatalog({
      source: entry.source,
      params,
      catalog: runtimeState.catalog,
      locale: runtimeState.locale,
    });
  }
  return source;
};

export const translateUiText = (value = '') => {
  const raw = String(value ?? '');
  if (!raw || runtimeState.locale === 'zh-CN') return raw;
  const leading = raw.match(/^\s*/)?.[0] || '';
  const trailing = raw.match(/\s*$/)?.[0] || '';
  const coreEnd = Math.max(leading.length, raw.length - trailing.length);
  const core = raw.slice(leading.length, coreEnd);
  if (!core) return raw;
  const lookupCore = core.replace(/\s+/g, ' ');
  const exact = t(lookupCore);
  if (exact !== lookupCore) return `${leading}${exact}${trailing}`;
  // 归一化未命中时按原文再查一次：目录里少数 key 含换行/全角空格，归一化会错过它们
  const rawExact = t(core);
  if (rawExact !== core) return `${leading}${rawExact}${trailing}`;
  const translated = translateTemplateValue(lookupCore);
  return translated === lookupCore ? raw : `${leading}${translated}${trailing}`;
};

const shouldSkipElement = (element, selector = SKIP_SELECTOR) => {
  try {
    return Boolean(element?.closest?.(selector));
  } catch {
    return false;
  }
};

const localizeTextNode = (node) => {
  if (!node || shouldSkipElement(node.parentElement)) return;
  const translated = translateUiText(node.nodeValue);
  if (translated !== node.nodeValue) node.nodeValue = translated;
};

const localizeElementAttributes = (element) => {
  if (!element || shouldSkipElement(element, ATTRIBUTE_SKIP_SELECTOR)) return;
  TRANSLATABLE_ATTRIBUTES.forEach(name => {
    if (!element.hasAttribute?.(name)) return;
    const current = element.getAttribute(name);
    const translated = translateUiText(current);
    if (translated !== current) element.setAttribute(name, translated);
  });
};

export const localizeDomSubtree = (root, { documentLike = typeof document !== 'undefined' ? document : null } = {}) => {
  if (!root || !documentLike || runtimeState.locale === 'zh-CN') return root;
  if (root.nodeType === 3) {
    localizeTextNode(root);
    return root;
  }
  if (root.nodeType === 1) localizeElementAttributes(root);
  const walker = documentLike.createTreeWalker?.(
    root,
    globalThis.NodeFilter?.SHOW_ELEMENT | globalThis.NodeFilter?.SHOW_TEXT || 5,
  );
  if (!walker) return root;
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === 3) localizeTextNode(node);
    else if (node.nodeType === 1) localizeElementAttributes(node);
    node = walker.nextNode();
  }
  return root;
};

export const applyDocumentLocale = (documentLike = typeof document !== 'undefined' ? document : null) => {
  if (!documentLike) return runtimeState.locale;
  if (documentLike.documentElement) {
    documentLike.documentElement.lang = runtimeState.locale;
    documentLike.documentElement.dir = 'ltr';
  }
  if (documentLike.body?.dataset) documentLike.body.dataset.locale = runtimeState.locale;
  return runtimeState.locale;
};

export const startDomLocalization = ({
  documentLike = typeof document !== 'undefined' ? document : null,
  MutationObserverClass = typeof MutationObserver !== 'undefined' ? MutationObserver : null,
} = {}) => {
  stopDomLocalization();
  if (!documentLike?.body || runtimeState.locale === 'zh-CN') return null;
  localizeDomSubtree(documentLike.body, { documentLike });
  if (typeof MutationObserverClass !== 'function') return null;
  domObserver = new MutationObserverClass(records => {
    records.forEach(record => {
      if (record.type === 'characterData') localizeTextNode(record.target);
      if (record.type === 'attributes') localizeElementAttributes(record.target);
      record.addedNodes?.forEach?.(node => localizeDomSubtree(node, { documentLike }));
    });
  });
  domObserver.observe(documentLike.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
  });
  return domObserver;
};

export const stopDomLocalization = () => {
  try { domObserver?.disconnect?.(); } catch {}
  domObserver = null;
};

if (typeof window !== 'undefined') {
  window.appI18n = {
    t,
    formatNumber,
    formatDateTime,
    getState: getI18nState,
    initialize: initializeI18n,
    localizeDomSubtree,
    startDomLocalization,
  };
}
