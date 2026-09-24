import { appSettings } from '../storage/app-settings.js';
import { logger } from '../utils/logger.js';
import { emitDebugLog } from '../utils/debug-log.js';
import { serializeForInlineScript } from '../utils/inline-script.js';
import { buildMacroEngineRuntimeSource } from '../utils/macro-engine.js';
import { createSillyTavernMacroApi } from '../utils/macro-compat-api.js';
import { createPresetRequestWorker } from './preset-request-worker.js';
import { toScriptPreset, fromScriptPreset, mergeScriptPresetChanges, createPresetScriptApi } from './preset-script-api.js';
import { runScriptGeneration } from './script-generation.js';
import { patchScriptUiChildren } from './script-ui-dom.js';
import {
  PresetRequestTransport, isCreativePresetRequest, makePresetRequestBody,
  applyPresetRequestBody, createPresetGenerationClient,
} from './preset-request-transport.js';
import {
  analyzeScriptCompatibility,
  buildScriptRuntimeErrorDiagnostic,
  hasTopLevelAwait,
  resolveScriptCompatibility,
} from '../import/script-capability-preflight.js';

const SCRIPT_MAX_BYTES = 2 * 1024 * 1024;
const SCRIPT_TOTAL_BYTES = 8 * 1024 * 1024;
const SCRIPT_PAYLOAD_LIMIT = 1200000;
const ST_PROMPT_ORDER_DUMMY_ID = 100001;

const getScriptDiagnosticRevision = (value) => {
  const content = String(value || '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
};

const buildWorkerScript = () => `
const scripts = new Map();
let currentContext = { sessionId: '', personaId: '', presetId: '', presetIds: [], worldId: '', worldIds: [] };
let pendingScriptSync = Promise.resolve();
let currentSettings = { allowReadMessages: true, allowModifyVariables: true, allowNetwork: false };
${buildMacroEngineRuntimeSource()}
${createSillyTavernMacroApi.toString()}
${createPresetRequestWorker.toString()}
${toScriptPreset.toString()}
${createPresetScriptApi.toString()}
const DISPATCH_RESULT_LIMIT = ${SCRIPT_PAYLOAD_LIMIT};
let seq = 0;
const pending = new Map();
const importCache = new Map();
const IMPORT_CACHE_LIMIT = 32;
const listenedEvents = new Set();
const ST_PROMPT_ORDER_DUMMY_ID = ${ST_PROMPT_ORDER_DUMMY_ID};
let compatUiNodeSeq = 0;
const compatUiNodes = new Map();
const compatUiIdIndex = new Map();
const compatUiExactAttributeIndex = new Map();
let compatUiMeasureSelectors = false;
let compatUiSelectorQueryCount = 0;
let compatUiSelectorVisitedNodeCount = 0;
let compatUiSelectorIndexHitCount = 0;
let compatUiFlushTimer = 0;
let compatUiLastSignature = '';
let compatUiNativeStateRevision = 0;
const compatUiLayoutInterest = new Set();
let compatUiLayoutInterestTimer = 0;
const COMPAT_UI_MAX_HTML = 400000;
const COMPAT_UI_MAX_ROOTS = 80;
const compatUiLayouts = new Map();
const DEFAULT_COMPAT_VIEWPORT = {
  innerWidth: 1024,
  innerHeight: 768,
  outerWidth: 1024,
  outerHeight: 768,
  devicePixelRatio: 1,
  screenWidth: 1024,
  screenHeight: 768,
  screenAvailWidth: 1024,
  screenAvailHeight: 768,
  visualViewport: {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
  },
};
let compatViewport = { ...DEFAULT_COMPAT_VIEWPORT, visualViewport: { ...DEFAULT_COMPAT_VIEWPORT.visualViewport } };

const compatNow = () => {
  try { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
  catch { return Date.now(); }
};

const requestCompatUiLayout = (nodeId) => {
  const id = String(nodeId || '').trim();
  if (!id || compatUiLayoutInterest.has(id)) return;
  compatUiLayoutInterest.add(id);
  if (compatUiLayoutInterestTimer) return;
  compatUiLayoutInterestTimer = setTimeout(() => {
    compatUiLayoutInterestTimer = 0;
    try { postMessage({ type: 'ui_layout_interest', nodeIds: Array.from(compatUiLayoutInterest) }); } catch {}
  }, 0);
};

const notifyListener = (eventName) => {
  const name = String(eventName || '').trim();
  if (!name || listenedEvents.has(name)) return;
  listenedEvents.add(name);
  try { postMessage({ type: 'listener_add', event: name }); } catch {}
};

const clone = (v) => {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
};

const estimateSize = (value) => {
  try { return JSON.stringify(value).length; } catch { return DISPATCH_RESULT_LIMIT + 1; }
};

const callRpc = (method, params = {}) => {
  const id = \`\${Date.now()}-\${++seq}\`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, at: Date.now() });
    postMessage({ type: 'rpc', id, method, params });
  });
};

const stringifyConsoleArg = (arg) => {
  if (arg instanceof Error) return \`\${arg.name}: \${arg.message}\`;
  if (typeof arg === 'string') return arg;
  if (arg == null) return String(arg);
  try { return JSON.stringify(arg); } catch { return String(arg); }
};

const isDevOrigin = () => {
  try {
    const origin = String(self.location?.origin || self.location?.href || '');
    return origin.includes('127.0.0.1') || origin.includes('localhost');
  } catch {
    return false;
  }
};

const installWorkerConsoleBridge = () => {
  if (self.__CHATAPP_WORKER_CONSOLE_BRIDGE__) return;
  self.__CHATAPP_WORKER_CONSOLE_BRIDGE__ = true;
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const shouldSuppressInfo = (args) => {
    if (currentSettings.debugExecutionLogs === true || currentSettings.mirrorConsole === true) return false;
    const text = args.map(stringifyConsoleArg).join(' ');
    return /^\\[(ReasoningRegexStyler|TagFixer|UAF)\\]/i.test(text);
  };
  let count = 0;
  const limit = 120;
  const mirror = (level, args) => {
    if (currentSettings.mirrorConsole === false) return;
    if (currentSettings.mirrorConsole !== true && !isDevOrigin()) return;
    if (count >= limit) return;
    count += 1;
    const text = args.map(stringifyConsoleArg).join(' ').slice(0, 1600);
    if (!text) return;
    callRpc('log', { level, args: ['[worker-console]', text] }).catch(() => {});
  };
  console.log = (...args) => {
    if (!shouldSuppressInfo(args)) original.log(...args);
  };
  console.info = (...args) => {
    if (!shouldSuppressInfo(args)) original.info(...args);
  };
  console.warn = (...args) => {
    original.warn(...args);
    mirror('warn', args);
  };
  console.error = (...args) => {
    original.error(...args);
    mirror('error', args);
  };
};

installWorkerConsoleBridge();

const legacyListenerMap = new WeakMap();
const wrapLegacyHandler = (cb) => {
  if (legacyListenerMap.has(cb)) return legacyListenerMap.get(cb);
  const wrapped = (payload) => {
    try {
      if (payload && typeof payload === 'object' && Array.isArray(payload.args)) {
        return cb(...payload.args);
      }
      return cb(payload);
    } catch (err) {
      console.error(err);
    }
  };
  legacyListenerMap.set(cb, wrapped);
  return wrapped;
};

const eventOn = (event, cb) => {
  const on = self.__chatappScriptOn;
  if (!on || typeof cb !== 'function') return;
  on(event, wrapLegacyHandler(cb));
  notifyListener(event);
};

const eventRemoveListener = (event, cb) => {
  const off = self.__chatappScriptOff;
  if (!off) return;
  if (!cb) return off(event);
  const wrapped = legacyListenerMap.get(cb) || cb;
  off(event, wrapped);
};

self.eventOn = eventOn;
self.eventRemoveListener = eventRemoveListener;
self.tavern_events = self.tavern_events || { on: eventOn, off: eventRemoveListener, eventOn, eventRemoveListener };

const buildModuleNamespace = (moduleExports, diff) => {
  const hasDiff = diff && Object.keys(diff).length > 0;
  let result = null;
  if (moduleExports !== undefined && moduleExports !== null) {
    if (typeof moduleExports === 'object' || typeof moduleExports === 'function') {
      result = moduleExports;
    } else {
      result = { default: moduleExports };
    }
  } else if (hasDiff) {
    result = diff;
  } else {
    result = {};
  }
  if (typeof result === 'function') {
    if (!('default' in result)) result.default = result;
    if (hasDiff) {
      Object.entries(diff).forEach(([key, value]) => {
        if (!(key in result)) result[key] = value;
      });
    }
    return result;
  }
  if (result && typeof result === 'object') {
    if (!('default' in result)) {
      result.default = (moduleExports !== undefined && moduleExports !== null) ? moduleExports : result;
    }
    if (hasDiff) {
      Object.entries(diff).forEach(([key, value]) => {
        if (!(key in result)) result[key] = value;
      });
    }
    return result;
  }
  return { default: result };
};

const getOrigin = () => {
  try {
    const origin = self.location && self.location.origin;
    if (!origin || origin === 'null') return '';
    return origin;
  } catch {
    return '';
  }
};

const resolveLibUrl = (path) => {
  if (!path) return '';
  const raw = String(path);
  if (/^[a-z]+:\\/\\//i.test(raw) || raw.startsWith('blob:') || raw.startsWith('tauri:') || raw.startsWith('app:')) {
    return raw;
  }
  const origin = getOrigin();
  if (!origin) return raw;
  if (raw.startsWith('/')) return origin + raw;
  return origin + '/' + raw.replace(/^\\.?\\//, '');
};

const isRemoteUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  return /^https?:\\/\\//i.test(raw) || raw.startsWith('//');
};

const nativeFetch = typeof self.fetch === 'function' ? self.fetch.bind(self) : null;
const NativeXMLHttpRequest = typeof self.XMLHttpRequest === 'function' ? self.XMLHttpRequest : null;
const NativeWebSocket = typeof self.WebSocket === 'function' ? self.WebSocket : null;
const nativeImportScripts = typeof self.importScripts === 'function' ? self.importScripts.bind(self) : null;
const deniedFetchUrls = new Set();
const warnNetworkDenied = (kind, url = '') => {
  const key = String(kind || '') + ':' + String(url || '');
  if (deniedFetchUrls.has(key)) return;
  deniedFetchUrls.add(key);
  callRpc('log', { level: 'warn', args: ['脚本网络已禁用，阻止加载', kind, String(url || '')] }).catch(() => {});
};
const guardedFetch = (...args) => {
  const internal = presetRequestWorker.interceptFetch(...args);
  if (internal) return internal;
  const input = args[0];
  const url = String(input?.url || input || '').trim();
  if (currentSettings.allowNetwork !== true) {
    warnNetworkDenied('fetch', url);
    return Promise.reject(new TypeError('脚本网络已禁用'));
  }
  if (!nativeFetch) return Promise.reject(new TypeError('fetch is unavailable'));
  return nativeFetch(...args);
};
const presetRequestWorker = createPresetRequestWorker({
  send: value => postMessage(value),
  getFetch: () => self.fetch,
  getBaseFetch: () => guardedFetch,
  getContext: () => currentContext,
  waitUntilReady: () => pendingScriptSync,
  dispatch: (event, payload) => dispatchEvent(event, payload, true),
});
let compatFetchInstalled = false;

const wrapNativeNetworkObject = (target, guardedConstructor) => new Proxy(target, {
  get(obj, prop) {
    if (prop === 'constructor') return guardedConstructor;
    const value = Reflect.get(obj, prop, obj);
    return typeof value === 'function' ? value.bind(obj) : value;
  },
  set(obj, prop, value) {
    return Reflect.set(obj, prop, value, obj);
  },
  getPrototypeOf() {
    return guardedConstructor.prototype;
  },
});

const GuardedXMLHttpRequest = function XMLHttpRequest() {
  if (currentSettings.allowNetwork !== true) {
    warnNetworkDenied('XMLHttpRequest');
    throw new TypeError('脚本网络已禁用');
  }
  if (!NativeXMLHttpRequest) throw new TypeError('XMLHttpRequest is unavailable');
  return wrapNativeNetworkObject(new NativeXMLHttpRequest(), GuardedXMLHttpRequest);
};

const GuardedWebSocket = function WebSocket(url, protocols) {
  if (currentSettings.allowNetwork !== true) {
    warnNetworkDenied('WebSocket', url);
    throw new TypeError('脚本网络已禁用');
  }
  if (!NativeWebSocket) throw new TypeError('WebSocket is unavailable');
  const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
  return wrapNativeNetworkObject(socket, GuardedWebSocket);
};
['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((key) => {
  if (NativeWebSocket && key in NativeWebSocket) GuardedWebSocket[key] = NativeWebSocket[key];
});

const guardedImportScripts = (...urls) => {
  // 与 runImport 的禁网语义一致：只拦远程 URL；blob:/app: 等本地导入不受网络开关影响。
  if (currentSettings.allowNetwork !== true) {
    const remote = urls.find(url => isRemoteUrl(url));
    if (remote !== undefined) {
      warnNetworkDenied('importScripts', remote);
      throw new TypeError('脚本网络已禁用');
    }
  }
  if (!nativeImportScripts) throw new TypeError('importScripts is unavailable');
  return nativeImportScripts(...urls);
};

const resolveImportUrl = (value, baseUrl) => {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (/^[a-z]+:\\/\\//i.test(raw) || raw.startsWith('blob:') || raw.startsWith('tauri:') || raw.startsWith('app:')) {
    return raw;
  }
  if (raw.startsWith('//')) {
    const proto = baseUrl && /^https?:\\/\\//i.test(baseUrl) ? baseUrl.split(':')[0] : 'https';
    return proto + ':' + raw;
  }
  try {
    if (baseUrl) return new URL(raw, baseUrl).toString();
  } catch {}
  const origin = getOrigin();
  if (!origin) return raw;
  if (raw.startsWith('/')) return origin + raw;
  return origin + '/' + raw.replace(/^\\.?\\//, '');
};

const loadScriptText = (url, baseUrl) => {
  const resolved = resolveImportUrl(url, baseUrl);
  if (!NativeXMLHttpRequest) throw new TypeError('XMLHttpRequest is unavailable');
  const xhr = new NativeXMLHttpRequest();
  xhr.open('GET', resolved, false);
  xhr.send(null);
  if (xhr.status >= 200 && xhr.status < 300) return String(xhr.responseText || '');
  throw new Error('HTTP ' + xhr.status);
};

const safeImportScript = (url, baseUrl) => {
  const resolved = resolveImportUrl(url, baseUrl);
  if (!resolved || !nativeImportScripts) return false;
  try {
    nativeImportScripts(resolved);
    return true;
  } catch {
    return false;
  }
};

const safeEvalScript = (url, baseUrl) => {
  const resolved = resolveImportUrl(url, baseUrl);
  if (!resolved) return false;
  try {
    const text = loadScriptText(resolved);
    const runner = new Function(text);
    runner();
    return true;
  } catch {
    return false;
  }
};

const loadLibrary = (urls, baseUrl) => {
  if (!Array.isArray(urls)) return false;
  for (const url of urls) {
    if (!url) continue;
    if (safeImportScript(url, baseUrl)) return true;
    if (safeEvalScript(url, baseUrl)) return true;
  }
  return false;
};

const makeCompatLodash = () => ({
  clamp: (value, lower, upper) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return lower ?? 0;
    if (Number.isFinite(lower) && num < lower) return lower;
    if (Number.isFinite(upper) && num > upper) return upper;
    return num;
  },
  max: (list) => {
    if (!Array.isArray(list) || !list.length) return undefined;
    return list.reduce((acc, cur) => (acc === undefined || cur > acc ? cur : acc), undefined);
  },
});

const runCompatCallback = (fn, ...args) => {
  try {
    const result = typeof fn === 'function' ? fn(...args) : undefined;
    if (result && typeof result.catch === 'function') result.catch(err => console.error(err));
    return result;
  } catch (err) {
    console.error(err);
    return undefined;
  }
};

const makeCompatDollar = () => {
  const normalizeNodes = (selector) => {
    if (selector == null) return [];
    if (selector === self || selector === self.window || selector === self.document) return [selector];
    if (Array.isArray(selector)) return selector.filter(Boolean);
    if (selector && typeof selector === 'object' && typeof selector.length === 'number' && typeof selector !== 'function') {
      return Array.from(selector).filter(Boolean);
    }
    if (selector && typeof selector === 'object') return [selector];
    const text = String(selector || '').trim();
    if (!text) return [];
    if (text.startsWith('<')) return parseCompatHtml(text);
    return Array.from(self.document?.querySelectorAll?.(text) || []);
  };
  const normalizeInsertItems = (items = []) => items.flatMap((item) => {
    if (item && typeof item === 'object') return [item];
    const text = String(item ?? '');
    if (!text) return [];
    return text.trim().startsWith('<') ? parseCompatHtml(text) : [makeCompatTextNode(text)];
  });
  const makeCollection = (selector) => {
    const nodes = normalizeNodes(selector);
    const api = {
      length: nodes.length,
      get: (index) => {
        if (index == null) return nodes.slice();
        const idx = Number(index);
        return Number.isFinite(idx) ? nodes[idx] : undefined;
      },
      eq: (index) => makeCollection(nodes[Math.trunc(Number(index) || 0)]),
      each: (cb) => {
        if (typeof cb === 'function') {
          for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (runCompatCallback(() => cb.call(node, index, node)) === false) break;
          }
        }
        return api;
      },
      not: (selector) => {
        if (typeof selector === 'function') {
          return makeCollection(nodes.filter((node, index) => !runCompatCallback(() => selector.call(node, index, node))));
        }
        if (typeof selector === 'string' && selector.trim()) {
          const groups = splitSelectorGroups(selector);
          return makeCollection(nodes.filter(node => node?.nodeType === 1 && !groups.some(group => node.matches?.(group))));
        }
        const excluded = new Set(normalizeNodes(selector));
        return makeCollection(nodes.filter(node => !excluded.has(node)));
      },
      ready: (cb) => {
        if (typeof cb === 'function') runCompatCallback(cb);
        return api;
      },
      on: (event, handler) => {
        nodes.forEach(node => node?.addEventListener?.(event, handler));
        return api;
      },
      off: (event, handler) => {
        nodes.forEach(node => node?.removeEventListener?.(event, handler));
        return api;
      },
      trigger: (event) => {
        nodes.forEach(node => node?.dispatchEvent?.(event));
        return api;
      },
      html: (value) => {
        if (value === undefined) return String(nodes[0]?.innerHTML ?? '');
        nodes.forEach(node => {
          if (node && typeof node === 'object') node.innerHTML = String(value ?? '');
        });
        return api;
      },
      text: (value) => {
        if (value === undefined) return String(nodes[0]?.textContent ?? '');
        nodes.forEach(node => {
          if (node && typeof node === 'object') node.textContent = String(value ?? '');
        });
        return api;
      },
      val: (value) => {
        if (value === undefined) return nodes[0]?.value ?? '';
        nodes.forEach(node => {
          if (node && typeof node === 'object') node.value = value;
        });
        return api;
      },
      attr: (name, value) => {
        if (value === undefined) return nodes[0]?.getAttribute?.(name);
        nodes.forEach(node => node?.setAttribute?.(name, value));
        return api;
      },
      removeAttr: (name) => {
        const names = typeof name === 'string' ? (name.match(/[^\\x20\\t\\r\\n\\f]+/g) || []) : [];
        nodes.forEach(node => {
          if (node?.nodeType !== 1) return;
          names.forEach(key => node.removeAttribute?.(key));
        });
        return api;
      },
      prop: (name, value) => {
        if (value === undefined) return nodes[0]?.[name];
        nodes.forEach(node => {
          if (node && typeof node === 'object') node[name] = value;
        });
        return api;
      },
      css: (name, value) => {
        if (typeof name === 'string' && value === undefined) return nodes[0]?.style?.[name];
        nodes.forEach(node => {
          if (!node?.style) return;
          if (name && typeof name === 'object') Object.assign(node.style, name);
          else if (name) node.style[name] = String(value ?? '');
        });
        return api;
      },
      append: (...items) => {
        nodes.forEach(node => normalizeInsertItems(items).forEach(item => node?.appendChild?.(item)));
        return api;
      },
      prepend: (...items) => {
        nodes.forEach(node => {
          if (!node?.insertBefore) return;
          const ref = node.firstChild || null;
          normalizeInsertItems(items).forEach(item => node.insertBefore(item, ref));
        });
        return api;
      },
      empty: () => {
        nodes.forEach(node => {
          if (node && typeof node === 'object') {
            node.children = [];
            node.innerHTML = '';
            node.textContent = '';
          }
        });
        return api;
      },
      remove: () => {
        nodes.forEach(node => node?.remove?.());
        return api;
      },
      addClass: (...names) => {
        nodes.forEach(node => node?.classList?.add?.(...names));
        return api;
      },
      removeClass: (...names) => {
        nodes.forEach(node => node?.classList?.remove?.(...names));
        return api;
      },
      toggleClass: (name) => {
        nodes.forEach(node => node?.classList?.toggle?.(name));
        return api;
      },
      find: (selector) => makeCollection(nodes[0]?.querySelector?.(selector)),
      closest: (selector) => makeCollection(nodes[0]?.closest?.(selector)),
      parent: () => makeCollection(nodes[0]?.parentNode || makeCompatElement('div')),
      children: () => makeCollection(nodes[0]?.children || []),
      scrollTop: (value) => {
        if (value === undefined) return Number(nodes[0]?.scrollTop || 0);
        nodes.forEach(node => {
          if (node && typeof node === 'object') node.scrollTop = Number(value) || 0;
        });
        return api;
      },
      scrollLeft: (value) => {
        if (value === undefined) return Number(nodes[0]?.scrollLeft || 0);
        nodes.forEach(node => {
          if (node && typeof node === 'object') node.scrollLeft = Number(value) || 0;
        });
        return api;
      },
      hide: () => api.css('display', 'none'),
      show: () => api.css('display', ''),
    };
    nodes.forEach((node, index) => { api[index] = node; });
    return api;
  };
  const fn = (selector) => {
    if (typeof selector === 'function') {
      runCompatCallback(selector);
      return makeCollection(self.document || makeCompatElement('document'));
    }
    return makeCollection(selector);
  };
  fn.ready = (cb) => { if (typeof cb === 'function') runCompatCallback(cb); };
  return fn;
};

const compatLocalStorageState = new Map();

const makeCompatLocalStorage = () => ({
  get length() {
    return compatLocalStorageState.size;
  },
  key(index) {
    const idx = Math.trunc(Number(index) || 0);
    return Array.from(compatLocalStorageState.keys())[idx] || null;
  },
  getItem(key) {
    const name = String(key || '');
    return compatLocalStorageState.has(name) ? compatLocalStorageState.get(name) : null;
  },
  setItem(key, value) {
    compatLocalStorageState.set(String(key || ''), String(value ?? ''));
  },
  removeItem(key) {
    compatLocalStorageState.delete(String(key || ''));
  },
  clear() {
    compatLocalStorageState.clear();
  },
});

const makeCompatToastr = () => {
  const notify = (level) => (...args) => {
    const text = args.map(item => String(item?.message || item || '')).filter(Boolean).join(' ');
    if (!text) return;
    callRpc('toast', { level, message: text, sessionId: currentContext.sessionId }).catch(() => {});
  };
  return {
    info: notify('info'),
    success: notify('info'),
    warning: notify('warn'),
    warn: notify('warn'),
    error: notify('warn'),
    clear: () => {},
    remove: () => {},
  };
};

const makeCompatEvent = (type, options = {}) => {
  const event = {
    type: String(type || ''),
    bubbles: options?.bubbles !== false,
    cancelable: options?.cancelable === true,
    defaultPrevented: false,
    target: null,
    currentTarget: null,
    detail: options?.detail,
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    },
    stopPropagation() {
      this.__stopped = true;
    },
    stopImmediatePropagation() {
      this.__stopped = true;
      this.__immediateStopped = true;
    },
  };
  if (options && typeof options === 'object') {
    Object.entries(options).forEach(([key, value]) => {
      if (!(key in event)) event[key] = value;
    });
  }
  return event;
};

const installCompatEventTarget = (target) => {
  if (!target || typeof target !== 'object') return target;
  if (target.__chatappEventTarget) return target;
  Object.defineProperty(target, '__chatappEventTarget', { value: true, configurable: true });
  Object.defineProperty(target, '__chatappListeners', { value: new Map(), configurable: true });
  target.addEventListener = function addEventListener(type, handler) {
    const name = String(type || '').trim();
    if (!name || typeof handler !== 'function') return;
    const list = target.__chatappListeners.get(name) || [];
    if (!list.includes(handler)) list.push(handler);
    target.__chatappListeners.set(name, list);
  };
  target.removeEventListener = function removeEventListener(type, handler) {
    const name = String(type || '').trim();
    if (!name || !target.__chatappListeners.has(name)) return;
    if (!handler) {
      target.__chatappListeners.delete(name);
      return;
    }
    target.__chatappListeners.set(name, (target.__chatappListeners.get(name) || []).filter(item => item !== handler));
  };
  target.dispatchEvent = function dispatchEvent(event) {
    const evt = typeof event === 'string' ? makeCompatEvent(event) : (event || makeCompatEvent(''));
    if (!evt.type) return true;
    try {
      if (!evt.target) evt.target = target;
    } catch {}
    let node = target;
    while (node && typeof node === 'object') {
      try {
        evt.currentTarget = node;
      } catch {}
      const list = (node.__chatappListeners?.get?.(evt.type) || []).slice();
      list.forEach((handler) => {
        if (evt.__immediateStopped) return;
        runCompatCallback(handler, evt);
      });
      const prop = 'on' + evt.type;
      if (!evt.__immediateStopped && typeof node[prop] === 'function') runCompatCallback(node[prop], evt);
      if (evt.__stopped || evt.bubbles === false) break;
      node = node.parentNode || null;
    }
    return !evt.defaultPrevented;
  };
  return target;
};

const finiteCompatNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const defineCompatValue = (target, key, value) => {
  if (!target || typeof target !== 'object') return;
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  } catch {
    try { target[key] = value; } catch {}
  }
};

const normalizeCompatViewport = (viewport = {}) => {
  const source = viewport && typeof viewport === 'object' ? viewport : {};
  const base = compatViewport || DEFAULT_COMPAT_VIEWPORT;
  const screenSource = source.screen && typeof source.screen === 'object' ? source.screen : source;
  const visualSource = source.visualViewport && typeof source.visualViewport === 'object' ? source.visualViewport : source;
  const innerWidth = Math.max(1, finiteCompatNumber(source.innerWidth, base.innerWidth));
  const innerHeight = Math.max(1, finiteCompatNumber(source.innerHeight, base.innerHeight));
  return {
    innerWidth,
    innerHeight,
    outerWidth: Math.max(1, finiteCompatNumber(source.outerWidth, innerWidth)),
    outerHeight: Math.max(1, finiteCompatNumber(source.outerHeight, innerHeight)),
    devicePixelRatio: Math.max(0.1, finiteCompatNumber(source.devicePixelRatio, base.devicePixelRatio || 1)),
    screenWidth: Math.max(1, finiteCompatNumber(screenSource.width ?? screenSource.screenWidth, innerWidth)),
    screenHeight: Math.max(1, finiteCompatNumber(screenSource.height ?? screenSource.screenHeight, innerHeight)),
    screenAvailWidth: Math.max(1, finiteCompatNumber(screenSource.availWidth ?? screenSource.screenAvailWidth, innerWidth)),
    screenAvailHeight: Math.max(1, finiteCompatNumber(screenSource.availHeight ?? screenSource.screenAvailHeight, innerHeight)),
    visualViewport: {
      width: Math.max(1, finiteCompatNumber(visualSource.width, innerWidth)),
      height: Math.max(1, finiteCompatNumber(visualSource.height, innerHeight)),
      offsetLeft: finiteCompatNumber(visualSource.offsetLeft, 0),
      offsetTop: finiteCompatNumber(visualSource.offsetTop, 0),
      pageLeft: finiteCompatNumber(visualSource.pageLeft, 0),
      pageTop: finiteCompatNumber(visualSource.pageTop, 0),
      scale: Math.max(0.1, finiteCompatNumber(visualSource.scale, 1)),
    },
  };
};

const applyCompatViewportSnapshot = (viewport = {}, options = {}) => {
  const previous = JSON.stringify(compatViewport);
  compatViewport = normalizeCompatViewport(viewport);
  currentSettings.viewport = { ...compatViewport, visualViewport: { ...compatViewport.visualViewport } };
  const targets = Array.from(new Set([self, self.window, self.parent, self.top].filter(Boolean)));
  targets.forEach((target) => {
    defineCompatValue(target, 'innerWidth', compatViewport.innerWidth);
    defineCompatValue(target, 'innerHeight', compatViewport.innerHeight);
    defineCompatValue(target, 'outerWidth', compatViewport.outerWidth);
    defineCompatValue(target, 'outerHeight', compatViewport.outerHeight);
    defineCompatValue(target, 'devicePixelRatio', compatViewport.devicePixelRatio);
    const screen = target.screen && typeof target.screen === 'object' ? target.screen : {};
    defineCompatValue(screen, 'width', compatViewport.screenWidth);
    defineCompatValue(screen, 'height', compatViewport.screenHeight);
    defineCompatValue(screen, 'availWidth', compatViewport.screenAvailWidth);
    defineCompatValue(screen, 'availHeight', compatViewport.screenAvailHeight);
    defineCompatValue(target, 'screen', screen);
    const visualViewport = target.visualViewport && typeof target.visualViewport === 'object' ? target.visualViewport : {};
    installCompatEventTarget(visualViewport);
    Object.entries(compatViewport.visualViewport).forEach(([key, value]) => defineCompatValue(visualViewport, key, value));
    defineCompatValue(target, 'visualViewport', visualViewport);
  });
  const changed = previous !== JSON.stringify(compatViewport);
  if (changed && options.dispatchResize === true) {
    try { (self.window || self).dispatchEvent?.(makeCompatEvent('resize', { bubbles: false, cancelable: false })); } catch {}
    try { self.visualViewport?.dispatchEvent?.(makeCompatEvent('resize', { bubbles: false, cancelable: false })); } catch {}
  }
  return changed;
};

const splitClassNames = (values = []) => values
  .flatMap(value => String(value || '').split(/\\s+/))
  .map(value => value.trim())
  .filter(Boolean);

const syncClassAttribute = (element, set) => {
  element.className = Array.from(set).join(' ');
  if (element.attributes) element.attributes.class = element.className;
  scheduleCompatUiFlush();
};

const makeCompatDomTokenList = (element) => ({
  add: (...names) => {
    const set = new Set(splitClassNames([element.className]));
    splitClassNames(names).forEach(name => set.add(name));
    syncClassAttribute(element, set);
  },
  remove: (...names) => {
    const set = new Set(splitClassNames([element.className]));
    splitClassNames(names).forEach(name => set.delete(name));
    syncClassAttribute(element, set);
  },
  toggle: (name, force) => {
    const key = String(name || '').trim();
    if (!key) return false;
    const set = new Set(splitClassNames([element.className]));
    const shouldAdd = force === undefined ? !set.has(key) : force === true;
    if (shouldAdd) set.add(key);
    else set.delete(key);
    syncClassAttribute(element, set);
    return shouldAdd;
  },
  contains: (name) => {
    const key = String(name || '').trim();
    return Boolean(key && splitClassNames([element.className]).includes(key));
  },
});

const normalizeStylePropertyName = (name) => String(name || '').trim();

const stylePropertyToCssName = (name) => {
  const raw = normalizeStylePropertyName(name);
  if (!raw || raw.startsWith('--')) return raw;
  return raw.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
};

const makeCompatStyle = (onChange = null) => {
  const values = new Map();
  const notifyChange = () => {
    if (typeof onChange === 'function') onChange();
    else scheduleCompatUiFlush();
  };
  const setValue = (name, value, priority = '') => {
    const prop = stylePropertyToCssName(name);
    if (!prop) return;
    const text = String(value ?? '');
    if (!prop.startsWith('--') && /(?:-?Infinity|NaN)/i.test(text)) return;
    const suffix = String(priority || '').trim();
    values.set(prop, suffix ? text + ' !' + suffix : text);
    notifyChange();
  };
  const getValue = (name) => {
    const prop = stylePropertyToCssName(name);
    if (!prop) return '';
    return values.has(prop) ? String(values.get(prop)) : '';
  };
  const removeValue = (name) => {
    const prop = stylePropertyToCssName(name);
    const prev = getValue(prop);
    if (prop) values.delete(prop);
    notifyChange();
    return prev;
  };
  const target = {};
  Object.defineProperties(target, {
    setProperty: {
      value(name, value, priority) {
        setValue(name, value, priority);
      },
    },
    getPropertyValue: {
      value(name) {
        return getValue(name);
      },
    },
    removeProperty: {
      value(name) {
        return removeValue(name);
      },
    },
    cssText: {
      enumerable: true,
      configurable: true,
      get() {
        return Array.from(values.entries()).map(([name, value]) => name + ': ' + value + ';').join(' ');
      },
      set(text) {
        values.clear();
        String(text ?? '').split(';').forEach((part) => {
          const idx = part.indexOf(':');
          if (idx <= 0) return;
          setValue(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
        });
        notifyChange();
      },
    },
  });
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'symbol') return obj[prop];
      return getValue(prop);
    },
    set(obj, prop, value) {
      if (prop === 'cssText') {
        Reflect.set(obj, prop, value);
        return true;
      }
      if (prop in obj) return true;
      setValue(prop, value);
      return true;
    },
    deleteProperty(obj, prop) {
      if (prop in obj) return true;
      removeValue(prop);
      return true;
    },
    has(obj, prop) {
      if (prop in obj) return true;
      return typeof prop !== 'symbol' && getValue(prop) !== '';
    },
    ownKeys(obj) {
      const keys = new Set(Reflect.ownKeys(obj));
      values.forEach((_value, key) => keys.add(key));
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(obj, prop) {
      if (prop in obj) return Object.getOwnPropertyDescriptor(obj, prop);
      if (typeof prop === 'symbol' || !values.has(stylePropertyToCssName(prop))) return undefined;
      return {
        enumerable: true,
        configurable: true,
        writable: true,
        value: getValue(prop),
      };
    },
  });
};

class CompatObserver {
  constructor(callback) {
    this.callback = typeof callback === 'function' ? callback : null;
  }

  observe() {}

  disconnect() {}

  unobserve() {}

  takeRecords() {
    return [];
  }
}

const getCompatElementChildren = (node) => Array.isArray(node?.children) ? node.children : [];

const walkCompatTree = (root, includeRoot = false) => {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    out.push(node);
    if (compatUiMeasureSelectors) compatUiSelectorVisitedNodeCount += 1;
    getCompatElementChildren(node).forEach(visit);
  };
  if (includeRoot) visit(root);
  else getCompatElementChildren(root).forEach(visit);
  return out;
};

const splitSelectorGroups = (selector = '') => {
  const groups = [];
  let cur = '';
  let quote = '';
  let bracketDepth = 0;
  String(selector || '').split('').forEach((char) => {
    if (quote) {
      cur += char;
      if (char === quote) quote = '';
      return;
    }
    if (char === '"' || char === "'") {
      quote = char;
      cur += char;
      return;
    }
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === ',' && bracketDepth === 0) {
      if (cur.trim()) groups.push(cur.trim());
      cur = '';
      return;
    }
    cur += char;
  });
  if (cur.trim()) groups.push(cur.trim());
  return groups;
};

const splitSelectorTokens = (selector = '') => {
  const tokens = [];
  let cur = '';
  let quote = '';
  let bracketDepth = 0;
  String(selector || '').trim().split('').forEach((char) => {
    if (quote) {
      cur += char;
      if (char === quote) quote = '';
      return;
    }
    if (char === '"' || char === "'") {
      quote = char;
      cur += char;
      return;
    }
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (/\\s/.test(char) && bracketDepth === 0) {
      if (cur.trim()) tokens.push(cur.trim());
      cur = '';
      return;
    }
    cur += char;
  });
  if (cur.trim()) tokens.push(cur.trim());
  return tokens;
};

const cssUnescape = (value = '') => String(value || '').replace(/\\\\/g, '');

const getCompatAttribute = (node, name) => {
  if (!node || typeof node !== 'object') return null;
  const key = String(name || '').trim();
  if (!key) return null;
  if (key === 'id') return node.id ? String(node.id) : null;
  if (key === 'class') return node.className ? String(node.className) : '';
  if (key === 'style') return node.style?.cssText ? String(node.style.cssText) : '';
  if (key.startsWith('data-')) {
    const dsKey = key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (node.dataset && Object.prototype.hasOwnProperty.call(node.dataset, dsKey)) return String(node.dataset[dsKey]);
  }
  if (node.attributes && Object.prototype.hasOwnProperty.call(node.attributes, key)) return String(node.attributes[key]);
  if (Object.prototype.hasOwnProperty.call(node, key)) return String(node[key]);
  return null;
};

const getCompatAttributeIndexKey = (tagName, name, value) => (
  String(tagName || '').toLowerCase() + '\u0000' + String(name || '') + '\u0000' + String(value ?? '')
);

const addCompatIndexEntry = (index, key, node) => {
  if (!key || !node) return;
  const bucket = index.get(key) || new Set();
  bucket.add(node);
  index.set(key, bucket);
};

const removeCompatIndexEntry = (index, key, node) => {
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(node);
  if (!bucket.size) index.delete(key);
};

const listCompatIndexAttributes = (node) => {
  const attrs = new Map();
  Object.entries(node?.attributes || {}).forEach(([name, value]) => attrs.set(String(name), String(value ?? '')));
  if (node?.id) attrs.set('id', String(node.id));
  if (node?.className) attrs.set('class', String(node.className));
  if (node?.dataset && typeof node.dataset === 'object') {
    Object.entries(node.dataset).forEach(([key, value]) => {
      attrs.set('data-' + String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase()), String(value ?? ''));
    });
  }
  return attrs;
};

const indexCompatUiNode = (node) => {
  if (!node || node.nodeType !== 1) return;
  const id = String(node.id || '').trim();
  if (id) addCompatIndexEntry(compatUiIdIndex, id, node);
  const tag = String(node.tagName || '').toLowerCase();
  listCompatIndexAttributes(node).forEach((value, name) => {
    addCompatIndexEntry(compatUiExactAttributeIndex, getCompatAttributeIndexKey(tag, name, value), node);
  });
};

const unindexCompatUiNode = (node) => {
  if (!node || node.nodeType !== 1) return;
  const id = String(node.id || '').trim();
  if (id) removeCompatIndexEntry(compatUiIdIndex, id, node);
  const tag = String(node.tagName || '').toLowerCase();
  listCompatIndexAttributes(node).forEach((value, name) => {
    removeCompatIndexEntry(compatUiExactAttributeIndex, getCompatAttributeIndexKey(tag, name, value), node);
  });
};

const isCompatNodeWithinRoot = (node, root) => {
  let cursor = node?.parentNode || null;
  while (cursor) {
    if (cursor === root) return true;
    cursor = cursor.parentNode || null;
  }
  return false;
};

const isCompatNodeConnected = (node) => {
  const documentElement = self.document?.documentElement;
  return Boolean(documentElement && (node === documentElement || isCompatNodeWithinRoot(node, documentElement)));
};

const registerCompatUiSubtree = (node) => {
  if (!node || !isCompatNodeConnected(node)) return;
  const stack = [node];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    const nodeId = String(item.__chatappNodeId || '').trim();
    if (nodeId) compatUiNodes.set(nodeId, item);
    indexCompatUiNode(item);
    const children = Array.isArray(item.childNodes) ? item.childNodes : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
};

const unregisterCompatUiSubtree = (node) => {
  const stack = [node];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    const nodeId = String(item.__chatappNodeId || '').trim();
    if (nodeId) {
      compatUiNodes.delete(nodeId);
      compatUiLayouts.delete(nodeId);
      compatUiLayoutInterest.delete(nodeId);
    }
    unindexCompatUiNode(item);
    const children = Array.isArray(item.childNodes) ? item.childNodes : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
};

const getCompatIndexedSelectorCandidates = (root, selector = '') => {
  const text = String(selector || '').trim();
  if (!text || /[\\s>,+~]/.test(text)) return null;
  const buckets = [];
  const withoutAttributes = text.replace(/\\[(?:[^\\]"']|"[^"]*"|'[^']*')*\\]/g, '');
  const idMatch = withoutAttributes.match(/#([^\\.\\[#:\\s]+)/);
  if (idMatch) buckets.push(compatUiIdIndex.get(cssUnescape(idMatch[1])) || new Set());
  const tagMatch = text.match(/^[a-zA-Z][\\w-]*/);
  const tag = String(tagMatch?.[0] || '').toLowerCase();
  const exactAttrs = Array.from(text.matchAll(/\\[([^\\]=~\\^\\$\\*\\|\\s]+)\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\]]+))\\]/g));
  exactAttrs.forEach((match) => {
    if (!tag) return;
    const value = String(match[2] ?? match[3] ?? match[4]?.trim() ?? '');
    buckets.push(compatUiExactAttributeIndex.get(getCompatAttributeIndexKey(tag, match[1], value)) || new Set());
  });
  if (!buckets.length) return null;
  compatUiSelectorIndexHitCount += 1;
  const smallest = buckets.reduce((best, bucket) => bucket.size < best.size ? bucket : best, buckets[0]);
  return Array.from(smallest).filter(node => (
    buckets.every(bucket => bucket.has(node))
    && isCompatNodeWithinRoot(node, root)
    && matchesCompatSimpleSelector(node, text)
  ));
};

const matchesCompatSimpleSelector = (node, selector = '') => {
  if (!node || typeof node !== 'object') return false;
  let text = String(selector || '').trim();
  if (!text) return false;
  text = text.replace(/:scope/g, '').trim();
  if (!text || text === '*') return true;
  // Parse attributes before IDs/classes: quoted attribute values may contain
  // dots or hashes. Unsupported operators must never turn into "match all".
  const attrMatches = Array.from(text.matchAll(/\\[([^\\]=~\\^\\$\\*\\|\\s]+)(?:\\s*([~\\|\\^\\$\\*]?=)\\s*(?:"([^"]*)"|'([^']*)'|([^\\]]+)))?\\]/g));
  for (const match of attrMatches) {
    text = text.replace(match[0], '');
    const actual = getCompatAttribute(node, match[1]);
    if (actual == null) return false;
    const operator = match[2];
    const expected = match[3] ?? match[4] ?? match[5]?.trim() ?? '';
    const value = String(actual);
    if (operator === '=' && value !== expected) return false;
    if (operator === '*=' && (!expected || !value.includes(expected))) return false;
    if (operator === '^=' && (!expected || !value.startsWith(expected))) return false;
    if (operator === '$=' && (!expected || !value.endsWith(expected))) return false;
    if (operator === '~=' && (!expected || !value.split(/\\s+/).includes(expected))) return false;
    if (operator === '|=' && value !== expected && !value.startsWith(expected + '-')) return false;
  }
  if (text.includes('[') || text.includes(']')) return false;
  const tagMatch = text.match(/^[a-zA-Z][\\w-]*/);
  if (tagMatch && String(node.tagName || '').toLowerCase() !== tagMatch[0].toLowerCase()) return false;
  const idMatches = Array.from(text.matchAll(/#([^\\.\\[#:\\s]+)/g));
  if (idMatches.some(match => String(node.id || '') !== cssUnescape(match[1]))) return false;
  const classMatches = Array.from(text.matchAll(/\\.([^\\.\\[#:\\s]+)/g));
  if (classMatches.some(match => !node.classList?.contains?.(cssUnescape(match[1])))) return false;
  return true;
};

const queryCompatSelectorAll = (root, selector = '') => {
  if (compatUiMeasureSelectors) compatUiSelectorQueryCount += 1;
  const found = [];
  splitSelectorGroups(selector).forEach((group) => {
    const indexed = getCompatIndexedSelectorCandidates(root, group);
    if (indexed) {
      indexed.forEach(node => { if (!found.includes(node)) found.push(node); });
      return;
    }
    const directMatch = group.match(/^:scope\\s*>\\s*(.+)$/);
    if (directMatch) {
      getCompatElementChildren(root).forEach((child) => {
        if (matchesCompatSimpleSelector(child, directMatch[1]) && !found.includes(child)) found.push(child);
      });
      return;
    }
    const childParts = group.split(/\\s*>\\s*/).map(part => part.trim()).filter(Boolean);
    if (childParts.length > 1) {
      let scope = [root];
      childParts.forEach((part, index) => {
        const next = [];
        scope.forEach((node) => {
          const candidates = index === 0 ? walkCompatTree(node, false) : getCompatElementChildren(node);
          candidates.forEach((child) => {
            if (matchesCompatSimpleSelector(child, part)) next.push(child);
          });
        });
        scope = next;
      });
      scope.forEach(node => { if (!found.includes(node)) found.push(node); });
      return;
    }
    let scope = [root];
    splitSelectorTokens(group).forEach((token) => {
      const next = [];
      scope.forEach((node) => {
        walkCompatTree(node, false).forEach((child) => {
          if (matchesCompatSimpleSelector(child, token)) next.push(child);
        });
      });
      scope = next;
    });
    scope.forEach(node => { if (!found.includes(node)) found.push(node); });
  });
  return found;
};

const COMPAT_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const escapeCompatHtml = (value = '') => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const decodeCompatHtml = (value = '') => String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_match, entity) => {
  if (entity === 'amp') return '&';
  if (entity === 'lt') return '<';
  if (entity === 'gt') return '>';
  if (entity === 'quot') return '"';
  if (entity === '#39') return "'";
  return _match;
});

const COMPAT_UI_BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link']);
const COMPAT_UI_STYLE_TAGS = new Set(['style']);
const COMPAT_UI_LISTENER_EVENTS = new Set([
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'mousemove',
  'pointerdown',
  'pointerup',
  'pointermove',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'dragstart',
  'drag',
  'dragend',
  'dragenter',
  'dragover',
  'dragleave',
  'drop',
  'keydown',
  'keyup',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'change',
  'submit',
]);

const getCompatTagName = (node) => String(node?.tagName || '').toLowerCase();

const getCompatVirtualMarker = (node) => {
  const value = node?.getAttribute?.('data-chatapp-virtual');
  return value == null ? '' : String(value);
};

const isCompatInternalNode = (node) => Boolean(getCompatVirtualMarker(node));

const hasCompatBlockedVirtualAncestor = (node) => {
  let cursor = node;
  while (cursor && typeof cursor === 'object') {
    const marker = getCompatVirtualMarker(cursor);
    if (marker && marker !== 'prompt-manager') return true;
    cursor = cursor.parentNode || null;
  }
  return false;
};

const hasCompatUiListener = (node) => {
  if (!node || typeof node !== 'object') return false;
  if (node.__chatappListeners) {
    for (const type of COMPAT_UI_LISTENER_EVENTS) {
      if ((node.__chatappListeners.get?.(type) || []).length) return true;
    }
  }
  for (const type of COMPAT_UI_LISTENER_EVENTS) {
    if (typeof node['on' + type] === 'function') return true;
  }
  return false;
};

const datasetKeyToAttrName = (key = '') => String(key || '').replace(/[A-Z]/g, char => '-' + char.toLowerCase());

const shouldSkipCompatUiAttribute = (name, value) => {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return true;
  if (key === 'style') return true;
  if (key.startsWith('on')) return true;
  if ((key === 'href' || key === 'src' || key.endsWith(':href')) && /^\\s*javascript:/i.test(String(value || ''))) return true;
  return false;
};

const collectCompatUiAttributes = (node) => {
  const attrs = {};
  Object.entries(node?.attributes || {}).forEach(([name, value]) => {
    attrs[String(name)] = String(value ?? '');
  });
  if (node?.id) attrs.id = String(node.id);
  if (node?.className) attrs.class = String(node.className);
  if (node?.dataset && typeof node.dataset === 'object') {
    Object.entries(node.dataset).forEach(([key, value]) => {
      attrs['data-' + datasetKeyToAttrName(key)] = String(value ?? '');
    });
  }
  ['type', 'name', 'title', 'placeholder', 'role', 'href', 'src', 'alt'].forEach((key) => {
    if (node?.[key] !== undefined && node?.[key] !== null && node?.[key] !== '') attrs[key] = String(node[key]);
  });
  const tag = getCompatTagName(node);
  if ((tag === 'input' || tag === 'select' || tag === 'option') && node.value != null && node.value !== '') {
    attrs.value = String(node.value);
  }
  if (tag === 'input' || tag === 'option') {
    if (node.checked === true) attrs.checked = 'checked';
    else delete attrs.checked;
  }
  if (node?.__chatappNodeId) attrs['data-chatapp-virtual-node-id'] = String(node.__chatappNodeId);
  if (hasCompatUiListener(node)) attrs['data-chatapp-has-ui-listener'] = '1';
  return attrs;
};

const serializeCompatUiAttributeText = (node) => Object.entries(collectCompatUiAttributes(node))
  .filter(([name, value]) => !shouldSkipCompatUiAttribute(name, value))
  .map(([name, value]) => ' ' + name + '="' + escapeCompatHtml(value) + '"')
  .join('');

const serializeCompatUiNode = (node, depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 80) return '';
  if (node.nodeType === 3) return escapeCompatHtml(node.textContent);
  if (node.nodeType !== 1) {
    const nodes = Array.isArray(node.childNodes) ? node.childNodes : [];
    return nodes.map(child => serializeCompatUiNode(child, depth + 1)).join('');
  }
  if (isCompatInternalNode(node)) return '';
  const tag = getCompatTagName(node);
  if (!tag || COMPAT_UI_BLOCKED_TAGS.has(tag) || COMPAT_UI_STYLE_TAGS.has(tag)) return '';
  const attrText = serializeCompatUiAttributeText(node);
  const styleText = node.style?.cssText ? ' style="' + escapeCompatHtml(node.style.cssText) + '"' : '';
  if (COMPAT_VOID_TAGS.has(tag)) return '<' + tag + attrText + styleText + '>';
  if (tag === 'textarea') return '<' + tag + attrText + styleText + '>' + escapeCompatHtml(node.value ?? '') + '</' + tag + '>';
  const childList = Array.isArray(node.childNodes) ? node.childNodes : [];
  const children = childList.length
    ? childList.map(child => serializeCompatUiNode(child, depth + 1)).join('')
    : escapeCompatHtml(node.textContent || '');
  return '<' + tag + attrText + styleText + '>' + children + '</' + tag + '>';
};

const collectCompatUiStyles = () => {
  const doc = self.document;
  const roots = [];
  if (doc?.head) roots.push(doc.head);
  if (doc?.body) roots.push(doc.body);
  if (doc?.documentElement) roots.push(doc.documentElement);
  const styles = [];
  roots.forEach((root) => {
    walkCompatTree(root, true).forEach((node) => {
      if (!node || node.nodeType !== 1 || hasCompatBlockedVirtualAncestor(node)) return;
      if (getCompatTagName(node) !== 'style') return;
      const css = String(node.textContent || '').trim();
      if (css && !styles.includes(css)) styles.push(css);
    });
  });
  return styles;
};

const buildCompatUiPayload = () => {
  const doc = self.document;
  if (!doc?.body) return { styles: [], roots: [] };
  const styles = collectCompatUiStyles();
  const roots = [];
  let total = styles.join('\\n').length;
  const bodyNodes = Array.isArray(doc.body.childNodes) ? doc.body.childNodes : [];
  const pushRoot = (node) => {
    if (roots.length >= COMPAT_UI_MAX_ROOTS) return;
    if (!node) return;
    const marker = getCompatVirtualMarker(node);
    if (marker) {
      if (marker === 'prompt-manager') {
        (Array.isArray(node.childNodes) ? node.childNodes : []).forEach(pushRoot);
      }
      return;
    }
    const tag = getCompatTagName(node);
    if (tag && (COMPAT_UI_STYLE_TAGS.has(tag) || COMPAT_UI_BLOCKED_TAGS.has(tag))) return;
    const html = serializeCompatUiNode(node);
    if (!html) return;
    if (total + html.length > COMPAT_UI_MAX_HTML) return;
    total += html.length;
    roots.push(html);
  };
  for (const node of bodyNodes) {
    if (roots.length >= COMPAT_UI_MAX_ROOTS) break;
    pushRoot(node);
  }
  const documentElementNodes = Array.isArray(doc.documentElement?.childNodes) ? doc.documentElement.childNodes : [];
  for (const node of documentElementNodes) {
    if (roots.length >= COMPAT_UI_MAX_ROOTS) break;
    if (node === doc.head || node === doc.body) continue;
    pushRoot(node);
  }
  return { styles, roots };
};

const rebuildCompatUiNodeRegistry = () => {
  const next = new Map();
  const seen = new Set();
  const stack = [self.document?.documentElement, self.document?.head, self.document?.body].filter(Boolean);
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const nodeId = String(node.__chatappNodeId || '').trim();
    if (nodeId) next.set(nodeId, node);
    const children = Array.isArray(node.childNodes) ? node.childNodes : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  compatUiNodes.clear();
  compatUiIdIndex.clear();
  compatUiExactAttributeIndex.clear();
  next.forEach((node, nodeId) => {
    compatUiNodes.set(nodeId, node);
    indexCompatUiNode(node);
  });
  Array.from(compatUiLayouts.keys()).forEach((nodeId) => {
    if (!next.has(nodeId)) compatUiLayouts.delete(nodeId);
  });
  Array.from(compatUiLayoutInterest).forEach((nodeId) => {
    if (!next.has(nodeId)) compatUiLayoutInterest.delete(nodeId);
  });
};

const parseCompatPx = (value) => {
  const match = String(value || '').trim().match(/^(-?\\d+(?:\\.\\d+)?)px$/i);
  return match ? Number(match[1]) || 0 : 0;
};

const normalizeCompatRect = (rect = {}) => {
  const left = Number(rect.left ?? rect.x ?? 0) || 0;
  const top = Number(rect.top ?? rect.y ?? 0) || 0;
  const width = Math.max(0, Number(rect.width ?? ((Number(rect.right) || 0) - left) ?? 0) || 0);
  const height = Math.max(0, Number(rect.height ?? ((Number(rect.bottom) || 0) - top) ?? 0) || 0);
  const right = Number(rect.right ?? (left + width)) || left + width;
  const bottom = Number(rect.bottom ?? (top + height)) || top + height;
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right,
    bottom,
    toJSON() {
      return { x: left, y: top, left, top, width, height, right, bottom };
    },
  };
};

const getCompatStyleRectFallback = (element) => {
  const style = element?.style;
  const left = parseCompatPx(style?.getPropertyValue?.('left') || style?.left);
  const top = parseCompatPx(style?.getPropertyValue?.('top') || style?.top);
  const width = parseCompatPx(style?.getPropertyValue?.('width') || style?.width) || Number(element?.clientWidth || element?.scrollWidth || 0) || 0;
  const height = parseCompatPx(style?.getPropertyValue?.('height') || style?.height) || Number(element?.clientHeight || element?.scrollHeight || 0) || 0;
  return normalizeCompatRect({ left, top, width, height });
};

const getCompatElementRect = (element) => {
  const nodeId = String(element?.__chatappNodeId || '');
  if (nodeId) requestCompatUiLayout(nodeId);
  if (nodeId && compatUiLayouts.has(nodeId)) return normalizeCompatRect(compatUiLayouts.get(nodeId));
  return getCompatStyleRectFallback(element);
};

const updateCompatUiLayouts = (items = [], viewport = null) => {
  if (viewport && typeof viewport === 'object') applyCompatViewportSnapshot(viewport);
  if (!Array.isArray(items)) return;
  items.forEach((item) => {
    const nodeId = String(item?.nodeId || '').trim();
    if (!nodeId) return;
    const rect = normalizeCompatRect(item);
    compatUiLayouts.set(nodeId, rect);
    const node = compatUiNodes.get(nodeId);
    if (node && typeof node === 'object') {
      node.clientWidth = Number(item.clientWidth ?? rect.width) || rect.width;
      node.clientHeight = Number(item.clientHeight ?? rect.height) || rect.height;
      node.scrollWidth = Number(item.scrollWidth ?? node.clientWidth) || node.clientWidth;
      node.scrollHeight = Number(item.scrollHeight ?? node.clientHeight) || node.clientHeight;
    }
  });
};

function flushCompatUi() {
  compatUiFlushTimer = 0;
  const startedAt = compatNow();
  rebuildCompatUiNodeRegistry();
  const payload = buildCompatUiPayload();
  const signature = JSON.stringify(payload);
  if (signature === compatUiLastSignature) return;
  compatUiLastSignature = signature;
  try {
    postMessage({
      type: 'ui_update',
      payload,
      nativeStateRevision: compatUiNativeStateRevision,
      perf: {
        workerBuildMs: Math.max(0, compatNow() - startedAt),
        registeredNodeCount: compatUiNodes.size,
        rootCount: payload.roots.length,
        htmlLength: payload.roots.reduce((sum, item) => sum + String(item || '').length, 0),
      },
    });
  } catch {}
}

function flushCompatUiNow() {
  if (compatUiFlushTimer) {
    clearTimeout(compatUiFlushTimer);
    compatUiFlushTimer = 0;
  }
  flushCompatUi();
}

function scheduleCompatUiFlush() {
  if (compatUiFlushTimer) return;
  compatUiFlushTimer = setTimeout(flushCompatUi, 0);
}

function resetCompatDocumentForSync() {
  if (compatUiFlushTimer) {
    clearTimeout(compatUiFlushTimer);
    compatUiFlushTimer = 0;
  }
  compatUiLastSignature = '';
  compatUiNativeStateRevision = 0;
  if (compatUiLayoutInterestTimer) {
    clearTimeout(compatUiLayoutInterestTimer);
    compatUiLayoutInterestTimer = 0;
  }
  compatUiLayoutInterest.clear();
  compatUiNodes.clear();
  compatUiIdIndex.clear();
  compatUiExactAttributeIndex.clear();
  compatUiLayouts.clear();
  compatUiNodeSeq = 0;
  self.document = makeCompatDocument();
  rebuildCompatUiNodeRegistry();
}

function handleCompatUiEvent(msg = {}) {
  const startedAt = compatNow();
  const data = msg.event && typeof msg.event === 'object' ? msg.event : {};
  const node = compatUiNodes.get(String(msg.nodeId || ''));
  let target = node;
  const targetType = String(msg.targetType || '').toLowerCase();
  if (!target && targetType === 'document') target = self.document;
  if (!target && targetType === 'window') target = self.window || self;
  if (!target || typeof target.dispatchEvent !== 'function') return;
  if (node && 'value' in data) node.value = String(data.value ?? '');
  if (node && 'checked' in data) node.checked = data.checked === true;
  if (node && 'open' in data) {
    node.open = data.open === true;
    if (node.open) node.setAttribute?.('open', '');
    else node.removeAttribute?.('open');
  }
  const eventType = msg.eventType || data.type || '';
  compatUiNativeStateRevision = Math.max(
    compatUiNativeStateRevision,
    Number(msg.nativeStateRevision || 0) || 0,
  );
  const measureSelectors = Number.isFinite(Number(msg.traceStartedAt));
  if (measureSelectors) {
    compatUiSelectorQueryCount = 0;
    compatUiSelectorVisitedNodeCount = 0;
    compatUiSelectorIndexHitCount = 0;
    compatUiMeasureSelectors = true;
  }
  const dispatchStartedAt = compatNow();
  target.dispatchEvent(makeCompatEvent(eventType, {
    ...data,
    bubbles: data.bubbles !== false,
    cancelable: data.cancelable === true,
  }));
  const workerDispatchMs = Math.max(0, compatNow() - dispatchStartedAt);
  compatUiMeasureSelectors = false;
  if (['click', 'dblclick', 'input', 'change', 'toggle', 'submit', 'keydown', 'keyup'].includes(String(eventType))) {
    flushCompatUiNow();
  } else {
    scheduleCompatUiFlush();
  }
  if (Number.isFinite(Number(msg.traceStartedAt))) {
    try {
      postMessage({
        type: 'ui_event_perf',
        eventType: String(eventType || ''),
        traceStartedAt: Number(msg.traceStartedAt),
        workerDispatchMs,
        workerTotalMs: Math.max(0, compatNow() - startedAt),
        selectorQueries: compatUiSelectorQueryCount,
        selectorVisitedNodes: compatUiSelectorVisitedNodeCount,
        selectorIndexHits: compatUiSelectorIndexHitCount,
      });
    } catch {}
  }
}

const makeCompatTextNode = (text = '') => {
  let value = String(text ?? '');
  const node = {
    nodeType: 3,
    nodeName: '#text',
    parentNode: null,
    parentElement: null,
    remove() {
      if (node.parentNode?.removeChild) node.parentNode.removeChild(node);
    },
  };
  Object.defineProperties(node, {
    textContent: {
      enumerable: true,
      configurable: true,
      get() {
        return value;
      },
      set(next) {
        value = String(next ?? '');
        scheduleCompatUiFlush();
      },
    },
    nodeValue: {
      enumerable: true,
      configurable: true,
      get() {
        return value;
      },
      set(next) {
        value = String(next ?? '');
        scheduleCompatUiFlush();
      },
    },
    data: {
      enumerable: true,
      configurable: true,
      get() {
        return value;
      },
      set(next) {
        value = String(next ?? '');
      },
    },
  });
  return node;
};

const collectCompatText = (node) => {
  if (!node || typeof node !== 'object') return '';
  if (node.nodeType === 3) return String(node.textContent ?? '');
  const nodes = Array.isArray(node.childNodes) ? node.childNodes : [];
  if (nodes.length) return nodes.map(collectCompatText).join('');
  return String(node.__chatappTextContent || '');
};

const serializeCompatNode = (node) => {
  if (!node || typeof node !== 'object') return '';
  if (node.nodeType === 3) return escapeCompatHtml(node.textContent);
  if (typeof node.__chatappSerialize === 'function') return node.__chatappSerialize();
  return escapeCompatHtml(node.textContent);
};

const parseCompatAttributes = (element, attrText = '') => {
  String(attrText || '').replace(/([^\\s=\\/<>]+)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+)))?/g, (_match, name, doubleQuoted, singleQuoted, bare) => {
    const key = String(name || '').trim();
    if (!key || key === '/') return '';
    const raw = doubleQuoted ?? singleQuoted ?? bare ?? '';
    element.setAttribute(key, decodeCompatHtml(raw));
    return '';
  });
};

const parseCompatHtml = (html = '') => {
  const roots = [];
  const root = {
    appendChild(node) {
      roots.push(node);
      node.parentNode = null;
      node.parentElement = null;
    },
  };
  const stack = [root];
  const appendText = (text) => {
    const value = decodeCompatHtml(text);
    if (!value) return;
    const parent = stack[stack.length - 1] || root;
    const node = makeCompatTextNode(value);
    parent.appendChild(node);
    if (String(parent.tagName || '').toLowerCase() === 'textarea') {
      parent.value = String(parent.value || '') + value;
    }
  };
  const tokens = String(html ?? '').match(/<[^>]*>|[^<]+/g) || [];
  tokens.forEach((token) => {
    if (!token) return;
    if (!token.startsWith('<')) {
      appendText(token);
      return;
    }
    if (/^<!--/.test(token) || /^<!doctype/i.test(token)) return;
    const closeMatch = token.match(/^<\\/\\s*([a-zA-Z][\\w:-]*)/);
    if (closeMatch) {
      const tag = closeMatch[1].toLowerCase();
      while (stack.length > 1) {
        const node = stack.pop();
        if (String(node.tagName || '').toLowerCase() === tag) break;
      }
      return;
    }
    const openMatch = token.match(/^<\\s*([a-zA-Z][\\w:-]*)([^>]*)>/);
    if (!openMatch) {
      appendText(token);
      return;
    }
    const tag = openMatch[1].toLowerCase();
    const node = makeCompatElement(tag);
    parseCompatAttributes(node, openMatch[2] || '');
    (stack[stack.length - 1] || root).appendChild(node);
    if (!COMPAT_VOID_TAGS.has(tag) && !/\\/\\s*>$/.test(token)) stack.push(node);
  });
  return roots;
};

const makeCompatElement = (tagName = 'div') => {
  const attrs = {};
  const childNodes = [];
  let textContentValue = '';
  let innerHTMLValue = '';
  let idValue = '';
  let classNameValue = '';
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    nodeType: 1,
    attributes: attrs,
    style: makeCompatStyle(() => scheduleCompatUiFlush()),
    dataset: {},
    children: [],
    childNodes,
    parentNode: null,
    parentElement: null,
    value: '',
    checked: false,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    appendChild(child) {
      if (child && typeof child === 'object') {
        if (child.parentNode?.removeChild) child.parentNode.removeChild(child);
        child.parentNode = element;
        child.parentElement = child.nodeType === 1 ? element : null;
        if (element.ownerDocument && !child.ownerDocument) child.ownerDocument = element.ownerDocument;
        childNodes.push(child);
        if (child.nodeType !== 3 && !element.children.includes(child)) element.children.push(child);
        registerCompatUiSubtree(child);
        scheduleCompatUiFlush();
      }
      return child;
    },
    insertBefore(child, before = null) {
      if (!child || typeof child !== 'object') return child;
      if (child.parentNode?.removeChild) child.parentNode.removeChild(child);
      child.parentNode = element;
      child.parentElement = child.nodeType === 1 ? element : null;
      if (element.ownerDocument && !child.ownerDocument) child.ownerDocument = element.ownerDocument;
      const nodeIdx = before ? childNodes.indexOf(before) : -1;
      if (nodeIdx >= 0) childNodes.splice(nodeIdx, 0, child);
      else childNodes.push(child);
      if (child.nodeType !== 3) {
        const elementIdx = before ? element.children.indexOf(before) : -1;
        if (elementIdx >= 0) element.children.splice(elementIdx, 0, child);
        else if (!element.children.includes(child)) element.children.push(child);
      }
      registerCompatUiSubtree(child);
      scheduleCompatUiFlush();
      return child;
    },
    removeChild(child) {
      unregisterCompatUiSubtree(child);
      const nodeIdx = childNodes.indexOf(child);
      if (nodeIdx >= 0) childNodes.splice(nodeIdx, 1);
      element.children = element.children.filter(item => item !== child);
      if (child && typeof child === 'object') {
        child.parentNode = null;
        child.parentElement = null;
      }
      scheduleCompatUiFlush();
      return child;
    },
    remove() {
      if (element.parentNode?.removeChild) element.parentNode.removeChild(element);
    },
    replaceChildren(...items) {
      childNodes.slice().forEach(child => element.removeChild(child));
      items.forEach(item => element.appendChild(item && typeof item === 'object' ? item : makeCompatTextNode(item)));
      textContentValue = collectCompatText(element);
      innerHTMLValue = '';
      scheduleCompatUiFlush();
    },
    setAttribute(name, value) {
      const key = String(name || '').trim();
      if (!key) return;
      const indexed = compatUiNodes.get(String(element.__chatappNodeId || '')) === element;
      if (indexed) unindexCompatUiNode(element);
      const text = String(value ?? '');
      attrs[key] = text;
      if (key === 'id') element.id = text;
      else if (key === 'class') element.className = text;
      else if (key === 'style') element.style.cssText = text;
      else if (key === 'value') element.value = text;
      else if (key === 'checked') element.checked = text !== 'false';
      else if (key.startsWith('data-')) {
        const dsKey = key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        element.dataset[dsKey] = text;
      } else {
        element[key] = text;
      }
      if (indexed) indexCompatUiNode(element);
      scheduleCompatUiFlush();
    },
    getAttribute(name) {
      return getCompatAttribute(element, name);
    },
    removeAttribute(name) {
      const key = String(name || '').trim();
      if (!key) return;
      const indexed = compatUiNodes.get(String(element.__chatappNodeId || '')) === element;
      if (indexed) unindexCompatUiNode(element);
      delete attrs[key];
      if (key === 'id') element.id = '';
      else if (key === 'class') element.className = '';
      else if (key === 'style') element.style.cssText = '';
      else if (key.startsWith('data-')) {
        const dsKey = key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        delete element.dataset[dsKey];
      } else {
        delete element[key];
      }
      if (indexed) indexCompatUiNode(element);
      scheduleCompatUiFlush();
    },
    hasAttribute(name) {
      return getCompatAttribute(element, name) != null;
    },
    matches(selector) {
      return matchesCompatSimpleSelector(element, selector);
    },
    contains(node) {
      if (node === element) return true;
      return walkCompatTree(element, false).includes(node);
    },
    querySelector(selector = '') {
      return queryCompatSelectorAll(element, selector)[0] || null;
    },
    querySelectorAll(selector = '') {
      return queryCompatSelectorAll(element, selector);
    },
    closest(selector = '') {
      let node = element;
      while (node) {
        if (matchesCompatSimpleSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    insertAdjacentElement(position, node) {
      const pos = String(position || '').toLowerCase();
      if (pos === 'beforebegin' && element.parentNode?.insertBefore) return element.parentNode.insertBefore(node, element);
      if (pos === 'afterbegin') return element.insertBefore(node, element.firstChild || null);
      if (pos === 'afterend' && element.parentNode?.insertBefore) {
        const siblings = element.parentNode.childNodes || element.parentNode.children || [];
        const idx = siblings.indexOf(element);
        return element.parentNode.insertBefore(node, siblings[idx + 1] || null);
      }
      return element.appendChild(node);
    },
    insertAdjacentHTML(position, html) {
      const nodes = parseCompatHtml(html);
      const pos = String(position || '').toLowerCase();
      if (pos === 'beforebegin' && element.parentNode?.insertBefore) {
        nodes.forEach(node => element.parentNode.insertBefore(node, element));
        return;
      }
      if (pos === 'afterend' && element.parentNode?.insertBefore) {
        const ref = element.nextSibling || null;
        nodes.forEach(node => element.parentNode.insertBefore(node, ref));
        return;
      }
      if (pos === 'afterbegin') {
        const ref = element.firstChild || null;
        nodes.forEach(node => element.insertBefore(node, ref));
        return;
      }
      nodes.forEach(node => element.appendChild(node));
    },
    focus: () => {},
    blur: () => {},
    click() {
      element.dispatchEvent(makeCompatEvent('click', { bubbles: true, cancelable: true }));
    },
    getBoundingClientRect() {
      return getCompatElementRect(element);
    },
    getClientRects() {
      const rect = getCompatElementRect(element);
      const list = [rect];
      list.item = (index) => list[index] || null;
      return list;
    },
  };
  element.classList = makeCompatDomTokenList(element);
  Object.defineProperties(element, {
    id: {
      enumerable: true,
      configurable: true,
      get() {
        return idValue;
      },
      set(value) {
        const indexed = compatUiNodes.get(String(element.__chatappNodeId || '')) === element;
        if (indexed) unindexCompatUiNode(element);
        idValue = String(value ?? '');
        if (idValue) attrs.id = idValue;
        else delete attrs.id;
        if (indexed) indexCompatUiNode(element);
        scheduleCompatUiFlush();
      },
    },
    className: {
      enumerable: true,
      configurable: true,
      get() {
        return classNameValue;
      },
      set(value) {
        const indexed = compatUiNodes.get(String(element.__chatappNodeId || '')) === element;
        if (indexed) unindexCompatUiNode(element);
        classNameValue = String(value ?? '');
        if (classNameValue) attrs.class = classNameValue;
        else delete attrs.class;
        if (indexed) indexCompatUiNode(element);
        scheduleCompatUiFlush();
      },
    },
    textContent: {
      enumerable: true,
      configurable: true,
      get() {
        return childNodes.length ? collectCompatText(element) : textContentValue;
      },
      set(value) {
        textContentValue = String(value ?? '');
        innerHTMLValue = escapeCompatHtml(textContentValue);
        childNodes.slice().forEach(child => element.removeChild(child));
        scheduleCompatUiFlush();
      },
    },
    innerText: {
      enumerable: true,
      configurable: true,
      get() {
        return element.textContent;
      },
      set(value) {
        element.textContent = value;
      },
    },
    innerHTML: {
      enumerable: true,
      configurable: true,
      get() {
        return childNodes.length ? childNodes.map(serializeCompatNode).join('') : innerHTMLValue;
      },
      set(value) {
        innerHTMLValue = String(value ?? '');
        childNodes.slice().forEach(child => element.removeChild(child));
        parseCompatHtml(innerHTMLValue).forEach(node => element.appendChild(node));
        textContentValue = collectCompatText(element);
        scheduleCompatUiFlush();
      },
    },
    outerHTML: {
      enumerable: true,
      configurable: true,
      get() {
        return element.__chatappSerialize();
      },
    },
    firstChild: {
      enumerable: true,
      configurable: true,
      get() {
        return childNodes[0] || null;
      },
    },
    lastChild: {
      enumerable: true,
      configurable: true,
      get() {
        return childNodes[childNodes.length - 1] || null;
      },
    },
    firstElementChild: {
      enumerable: true,
      configurable: true,
      get() {
        return element.children[0] || null;
      },
    },
    lastElementChild: {
      enumerable: true,
      configurable: true,
      get() {
        return element.children[element.children.length - 1] || null;
      },
    },
    nextSibling: {
      enumerable: true,
      configurable: true,
      get() {
        const siblings = element.parentNode?.childNodes || [];
        const idx = siblings.indexOf(element);
        return idx >= 0 ? siblings[idx + 1] || null : null;
      },
    },
    previousSibling: {
      enumerable: true,
      configurable: true,
      get() {
        const siblings = element.parentNode?.childNodes || [];
        const idx = siblings.indexOf(element);
        return idx > 0 ? siblings[idx - 1] || null : null;
      },
    },
    nextElementSibling: {
      enumerable: true,
      configurable: true,
      get() {
        const siblings = element.parentNode?.children || [];
        const idx = siblings.indexOf(element);
        return idx >= 0 ? siblings[idx + 1] || null : null;
      },
    },
    previousElementSibling: {
      enumerable: true,
      configurable: true,
      get() {
        const siblings = element.parentNode?.children || [];
        const idx = siblings.indexOf(element);
        return idx > 0 ? siblings[idx - 1] || null : null;
      },
    },
    offsetLeft: {
      enumerable: true,
      configurable: true,
      get() {
        return getCompatElementRect(element).left;
      },
    },
    offsetTop: {
      enumerable: true,
      configurable: true,
      get() {
        return getCompatElementRect(element).top;
      },
    },
    offsetWidth: {
      enumerable: true,
      configurable: true,
      get() {
        return getCompatElementRect(element).width;
      },
    },
    offsetHeight: {
      enumerable: true,
      configurable: true,
      get() {
        return getCompatElementRect(element).height;
      },
    },
  });
  element.__chatappSerialize = () => {
    const tag = String(element.tagName || 'div').toLowerCase();
    const attrText = Object.entries(attrs)
      .filter(([name]) => name && name !== 'style')
      .map(([name, value]) => ' ' + name + '="' + escapeCompatHtml(value) + '"')
      .join('');
    const styleText = element.style?.cssText ? ' style="' + escapeCompatHtml(element.style.cssText) + '"' : '';
    if (COMPAT_VOID_TAGS.has(tag)) return '<' + tag + attrText + styleText + '>';
    return '<' + tag + attrText + styleText + '>' + element.innerHTML + '</' + tag + '>';
  };
  installCompatEventTarget(element);
  const nodeId = String(++compatUiNodeSeq);
  Object.defineProperty(element, '__chatappNodeId', { value: nodeId, configurable: true });
  return element;
};

const makeCompatDocument = () => {
  const body = makeCompatElement('body');
  const head = makeCompatElement('head');
  const documentElement = makeCompatElement('html');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  const document = {
    nodeType: 9,
    readyState: 'complete',
    body,
    head,
    documentElement,
    createElement(tagName = 'div') {
      const node = makeCompatElement(tagName);
      node.ownerDocument = document;
      return node;
    },
    createElementNS(namespaceURI, qualifiedName) {
      const node = document.createElement(qualifiedName);
      node.namespaceURI = namespaceURI == null ? null : String(namespaceURI);
      node.localName = String(qualifiedName).split(':').at(-1);
      return node;
    },
    createTextNode(text = '') {
      const node = makeCompatTextNode(text);
      node.ownerDocument = document;
      return node;
    },
    createDocumentFragment() {
      const node = makeCompatElement('fragment');
      node.nodeType = 11;
      node.ownerDocument = document;
      return node;
    },
    getElementById(id = '') {
      const key = String(id || '').trim();
      if (!key) return null;
      if (compatUiMeasureSelectors) compatUiSelectorQueryCount += 1;
      const indexed = compatUiIdIndex.get(key);
      if (indexed) {
        if (compatUiMeasureSelectors) compatUiSelectorIndexHitCount += 1;
        const match = Array.from(indexed).find(node => (
          node === documentElement || isCompatNodeWithinRoot(node, documentElement)
        ));
        if (match) return match;
      }
      return walkCompatTree(documentElement, true).find(node => String(node.id || '') === key) || null;
    },
    querySelector(selector = '') {
      return queryCompatSelectorAll(documentElement, selector)[0] || null;
    },
    querySelectorAll(selector = '') {
      return queryCompatSelectorAll(documentElement, selector);
    },
  };
  documentElement.parentNode = document;
  body.ownerDocument = document;
  head.ownerDocument = document;
  documentElement.ownerDocument = document;
  return document;
};

const defaultErrorCatched = (fn) => (...args) => {
  try {
    return typeof fn === 'function' ? fn(...args) : undefined;
  } catch (err) {
    console.error(err);
    return undefined;
  }
};

const deniedPermissionWarnings = new Set();
const warnCompatPermissionDenied = (permission) => {
  const name = String(permission || '未知权限');
  if (deniedPermissionWarnings.has(name)) return;
  deniedPermissionWarnings.add(name);
  callRpc('log', { level: 'warn', args: ['脚本权限已禁用', name] }).catch(() => {});
};

const normalizeCompatVariableScope = (option = { type: 'message' }) => {
  const raw = option && typeof option === 'object'
    ? String(option.type || option.scope || option.name || '').trim().toLowerCase()
    : String(option || '').trim().toLowerCase();
  if (raw === 'global' || raw === 'world') return 'global';
  if (raw === 'preset') return 'preset';
  if (raw === 'character' || raw === 'char') return 'character';
  return 'chat';
};

const getCompatVariableContextKey = (scope) => {
  if (scope === 'global') return 'globalVariables';
  if (scope === 'preset') return 'presetVariables';
  if (scope === 'character') return 'characterVariables';
  return 'localVariables';
};

const getCompatBaseVariables = (option = { type: 'message' }) => {
  const scope = normalizeCompatVariableScope(option);
  const globalVars = currentContext.globalVariables && typeof currentContext.globalVariables === 'object'
    ? currentContext.globalVariables
    : {};
  const localVars = currentContext.localVariables && typeof currentContext.localVariables === 'object'
    ? currentContext.localVariables
    : currentContext.variables && typeof currentContext.variables === 'object'
      ? currentContext.variables
      : {};
  if (scope === 'global') return globalVars;
  if (scope === 'preset') {
    return currentContext.presetVariables && typeof currentContext.presetVariables === 'object'
      ? currentContext.presetVariables
      : {};
  }
  if (scope === 'character') {
    return currentContext.characterVariables && typeof currentContext.characterVariables === 'object'
      ? currentContext.characterVariables
      : {};
  }
  return localVars;
};

const buildCompatVariablesSnapshot = () => {
  const globalVars = currentContext.globalVariables && typeof currentContext.globalVariables === 'object'
    ? currentContext.globalVariables
    : {};
  const localVars = currentContext.localVariables && typeof currentContext.localVariables === 'object'
    ? currentContext.localVariables
    : currentContext.variables && typeof currentContext.variables === 'object'
      ? currentContext.variables
      : {};
  const baseVars = currentContext.variables && typeof currentContext.variables === 'object' ? currentContext.variables : localVars;
  return {
    stat_data: clone(baseVars),
    variables: clone(baseVars),
    status_current_variables: clone(baseVars),
    global_variables: clone(globalVars),
    local_variables: clone(localVars),
    preset_variables: clone(getCompatBaseVariables({ type: 'preset' })),
    character_variables: clone(getCompatBaseVariables({ type: 'character' })),
  };
};

const getVariables = (option = { type: 'message' }) => clone(getCompatBaseVariables(option));
const getAllVariables = () => buildCompatVariablesSnapshot();

const setCompatVariables = (updates = {}, option = { type: 'message' }) => {
  if (currentSettings.allowModifyVariables !== true) {
    warnCompatPermissionDenied('修改变量');
    return getVariables(option);
  }
  const scope = normalizeCompatVariableScope(option);
  const payload = updates && typeof updates === 'object' ? updates : {};
  const targetKey = getCompatVariableContextKey(scope);
  const current = currentContext[targetKey] && typeof currentContext[targetKey] === 'object' ? currentContext[targetKey] : {};
  const next = { ...current, ...payload };
  currentContext[targetKey] = next;
  if (scope === 'chat') currentContext.variables = next;
  callRpc('variables.patch', {
    patch: payload,
    options: { scope: scope === 'chat' ? 'local' : scope },
    sessionId: currentContext.sessionId,
  }).catch(() => {});
  return getVariables(option);
};

const updateVariablesWith = (updates, option = { type: 'message' }) => {
  if (typeof updates === 'function') {
    const current = getVariables(option);
    const next = updates(current);
    return setCompatVariables(next && typeof next === 'object' ? next : {}, option);
  }
  return setCompatVariables(updates, option);
};

const splitVariablePath = (path = '') => String(path || '').split('.').map(part => part.trim()).filter(Boolean);

const deleteCompatValueAtPath = (obj, path = '') => {
  const parts = Array.isArray(path) ? path : splitVariablePath(path);
  if (!obj || typeof obj !== 'object' || !parts.length) return false;
  let cursor = obj;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor?.[parts[index]];
    if (!cursor || typeof cursor !== 'object') return false;
  }
  const last = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cursor, last)) return false;
  delete cursor[last];
  return true;
};

const deleteVariable = (path, option = { type: 'message' }) => {
  if (currentSettings.allowModifyVariables !== true) {
    warnCompatPermissionDenied('修改变量');
    return false;
  }
  const scope = normalizeCompatVariableScope(option);
  const targetKey = getCompatVariableContextKey(scope);
  const current = currentContext[targetKey] && typeof currentContext[targetKey] === 'object' ? clone(currentContext[targetKey]) : {};
  const changed = deleteCompatValueAtPath(current, path);
  currentContext[targetKey] = current;
  if (scope === 'chat') currentContext.variables = current;
  if (changed) {
    callRpc('variables.delete', {
      key: String(path || ''),
      options: { scope: scope === 'chat' ? 'local' : scope },
      sessionId: currentContext.sessionId,
    }).catch(() => {});
  }
  return changed;
};

const replaceVariables = (text = '') => String(text ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, key) => {
  const name = String(key || '').trim();
  const local = getVariables();
  const globalVars = getVariables({ type: 'global' });
  const value = local[name] ?? globalVars[name];
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
});

const EVENT_TYPES = {
  APP_READY: 'app.ready',
  CHAT_CHANGED: 'chat.changed',
  CHARACTER_SELECTED: 'character.selected',
  GENERATION_ENDED: 'message.after_receive',
  MESSAGE_RECEIVED: 'message.after_receive',
  MESSAGE_SENT: 'message.after_send',
  MESSAGE_SWIPED: 'message.swiped',
  CHARACTER_MESSAGE_RENDERED: 'message.after_render',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  OAI_PRESET_CHANGED_AFTER: 'preset.changed',
};

Object.assign(self.tavern_events, EVENT_TYPES);

const normalizeTavernMessage = (message = {}, index = 0) => {
  const rawId = Number(message?.message_id);
  const messageId = Number.isFinite(rawId) ? Math.trunc(rawId) : Math.max(0, Math.trunc(Number(index) || 0));
  const role = String(message?.role || '').trim().toLowerCase();
  const text = String(
    message?.message ??
    message?.mes ??
    message?.rawSource ??
    message?.raw ??
    message?.rawOriginal ??
    message?.content ??
    ''
  );
  return {
    id: String(message?.id || ''),
    message_id: messageId,
    role,
    name: String(message?.name || ''),
    message: text,
    mes: text,
    is_user: role === 'user',
    is_system: role === 'system',
    data: message?.data && typeof message.data === 'object' ? clone(message.data) : {},
  };
};

const getTavernChatSnapshot = () => {
  if (currentSettings.allowReadMessages !== true) {
    warnCompatPermissionDenied('读取消息');
    return [];
  }
  const list = Array.isArray(currentContext.chat) ? currentContext.chat : [];
  return list.map((message, index) => normalizeTavernMessage(message, index));
};

const getLastMessageId = () => {
  const list = getTavernChatSnapshot();
  if (!list.length) return -1;
  return list.reduce((max, message) => Math.max(max, Number(message.message_id) || 0), -1);
};

const getChatMessages = (selector, options = {}) => {
  const role = String(options?.role || '').trim().toLowerCase();
  const all = getTavernChatSnapshot();
  const list = role ? all.filter(message => message.role === role) : all;
  if (selector === undefined || selector === null || selector === '') return clone(list);
  if (Array.isArray(selector)) {
    const ids = new Set(selector.map(value => Math.trunc(Number(value))).filter(Number.isFinite));
    return clone(list.filter(message => ids.has(message.message_id)));
  }
  const normalizedSelector = typeof selector === 'string'
    ? selector.replace(/\\{\\{\\s*lastMessageId\\s*\\}\\}/gi, String(getLastMessageId()))
    : selector;
  if (typeof normalizedSelector === 'string' && /^\\s*-?\\d+\\s*-\\s*-?\\d+\\s*$/.test(normalizedSelector)) {
    const parts = normalizedSelector.split('-', 2).map(value => Math.trunc(Number(value)));
    if (parts.every(Number.isFinite)) {
      const min = Math.min(parts[0], parts[1]);
      const max = Math.max(parts[0], parts[1]);
      return clone(list.filter(message => message.message_id >= min && message.message_id <= max));
    }
  }
  const id = Math.trunc(Number(normalizedSelector));
  if (!Number.isFinite(id)) return [];
  if (id < 0) {
    const item = list[list.length + id];
    return item ? clone([item]) : [];
  }
  return clone(list.filter(message => message.message_id === id));
};

const setChatMessages = async (messages = [], options = {}) => {
  if (currentSettings.allowReadMessages !== true) {
    warnCompatPermissionDenied('读取/修改消息');
    return [];
  }
  const patches = Array.isArray(messages) ? messages : [];
  if (!patches.length) return [];
  const current = getTavernChatSnapshot();
  patches.forEach((patch) => {
    if (!patch || typeof patch !== 'object') return;
    const rawId = Number(patch.message_id);
    const item = Number.isFinite(rawId)
      ? current.find(message => message.message_id === Math.trunc(rawId))
      : current.find(message => message.id && message.id === String(patch.id || ''));
    if (!item) return;
    if (patch.message !== undefined || patch.mes !== undefined) {
      const text = String(patch.message ?? patch.mes ?? '');
      item.message = text;
      item.mes = text;
    }
    if (patch.role !== undefined) item.role = String(patch.role || '');
    if (patch.name !== undefined) item.name = String(patch.name || '');
    if (patch.data && typeof patch.data === 'object') item.data = clone(patch.data);
  });
  currentContext.chat = current;
  ensureSillyTavern().chat = clone(current);
  const result = await callRpc('chat.setMessages', {
    messages: patches,
    options,
    sessionId: currentContext.sessionId,
  });
  return Array.isArray(result) ? result.map(normalizeTavernMessage) : clone(current);
};

const getTavernRegexes = (options = {}) => {
  const scope = String(options?.scope || 'character').trim().toLowerCase();
  if (scope !== 'character') return [];
  return clone(Array.isArray(currentContext.characterRegexes) ? currentContext.characterRegexes : []);
};

const replaceTavernRegexes = async (regexes = [], options = {}) => {
  const scope = String(options?.scope || 'character').trim().toLowerCase();
  if (scope !== 'character' || !Array.isArray(regexes)) return false;
  currentContext.characterRegexes = clone(regexes);
  return await callRpc('regex.replaceCharacter', {
    regexes,
    scope,
    sessionId: currentContext.sessionId,
  });
};

const scriptButtonHandlers = new Map();

const matchesScriptButton = (matcher, name) => {
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(name);
  }
  return String(matcher || '') === name;
};

const ensureScriptButtonRoot = () => {
  const doc = self.document;
  if (!doc?.body || typeof doc.createElement !== 'function') return null;
  let root = doc.getElementById?.('chatapp-script-buttons');
  if (root) return root;
  root = doc.createElement('div');
  root.id = 'chatapp-script-buttons';
  root.setAttribute('id', root.id);
  root.setAttribute('aria-label', '角色卡脚本操作');
  root.style.position = 'fixed';
  root.style.right = '16px';
  root.style.bottom = '84px';
  root.style.zIndex = '2147483000';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.gap = '6px';
  root.style.alignItems = 'flex-end';
  root.style.pointerEvents = 'auto';
  doc.body.appendChild(root);
  return root;
};

const makeScriptButtonApi = (record = {}) => {
  const scriptId = String(record.id || '');
  const groupId = 'chatapp-script-buttons-' + scriptId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const eventOnButton = (matcher, callback) => {
    if ((!matcher && matcher !== '') || typeof callback !== 'function') return false;
    const handlers = scriptButtonHandlers.get(scriptId) || [];
    handlers.push({ matcher, callback });
    scriptButtonHandlers.set(scriptId, handlers);
    return true;
  };
  const replaceScriptButtons = (_targetScriptId, buttons = []) => {
    const root = ensureScriptButtonRoot();
    if (!root) return false;
    let group = self.document.getElementById?.(groupId);
    if (!group) {
      group = self.document.createElement('div');
      group.id = groupId;
      group.setAttribute('id', groupId);
      group.style.display = 'flex';
      group.style.flexWrap = 'wrap';
      group.style.justifyContent = 'flex-end';
      group.style.gap = '6px';
      group.style.maxWidth = 'min(520px, 82vw)';
      root.appendChild(group);
    }
    group.replaceChildren?.();
    (Array.isArray(buttons) ? buttons : []).forEach((descriptor) => {
      if (!descriptor || descriptor.visible === false) return;
      const name = String(descriptor.name || '').trim();
      if (!name) return;
      const button = self.document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.setAttribute('type', 'button');
      button.setAttribute('title', name);
      button.style.border = '1px solid rgba(128, 128, 128, 0.35)';
      button.style.borderRadius = '10px';
      button.style.padding = '7px 10px';
      button.style.background = 'rgba(28, 28, 32, 0.92)';
      button.style.color = '#fff';
      button.style.fontSize = '12px';
      button.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.22)';
      button.style.cursor = 'pointer';
      button.addEventListener('click', () => {
        const handlers = scriptButtonHandlers.get(scriptId) || [];
        handlers.forEach((entry) => {
          if (matchesScriptButton(entry.matcher, name)) runCompatCallback(entry.callback);
        });
      });
      group.appendChild(button);
    });
    return true;
  };
  return {
    getScriptId: () => scriptId,
    eventOnButton,
    replaceScriptButtons,
  };
};

const eventSource = {
  on: eventOn,
  off: eventRemoveListener,
  makeFirst: eventOn,
  removeListener: eventRemoveListener,
  once: (event, cb) => {
    if (typeof cb !== 'function') return;
    const wrapped = (...args) => {
      eventRemoveListener(event, wrapped);
      return cb(...args);
    };
    eventOn(event, wrapped);
  },
};

const normalizeStringList = (value) => (
  Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
);

const getWorldbookNamesFromContext = () => {
  const names = normalizeStringList(currentContext.worldbookNames);
  const worldIds = normalizeStringList(currentContext.worldIds);
  const worldId = String(currentContext.worldId || '').trim();
  return Array.from(new Set(names.concat(worldIds, worldId ? [worldId] : []).filter(Boolean)));
};

const getActiveWorldbookIds = () => {
  const worldIds = normalizeStringList(currentContext.worldIds);
  const worldId = String(currentContext.worldId || '').trim();
  return Array.from(new Set((worldId ? [worldId] : []).concat(worldIds).filter(Boolean)));
};

const getGlobalWorldbookNames = () => getWorldbookNamesFromContext();

const getCharWorldbookNames = () => {
  const active = getActiveWorldbookIds();
  return {
    primary: active[0] || '',
    additional: active.slice(1),
  };
};

const getChatWorldbookName = () => getActiveWorldbookIds()[0] || '';

const normalizeWorldbookEntry = (entry = {}, index = 0) => ({
  ...entry,
  uid: entry.uid ?? entry.id ?? entry.key ?? index,
  id: entry.id ?? entry.uid ?? \`entry-\${index}\`,
  name: entry.name || entry.comment || entry.title || entry.id || \`Entry \${index + 1}\`,
  comment: entry.comment || entry.name || entry.title || '',
  title: entry.title || entry.comment || entry.name || '',
  content: String(entry.content || ''),
  enabled: entry.enabled !== false && entry.disable !== true,
});

const getWorldbook = async (name) => {
  const world = String(name || '').trim();
  if (!world) return [];
  const entries = await callRpc('world.getBook', { world, sessionId: currentContext.sessionId });
  return Array.isArray(entries) ? entries.map(normalizeWorldbookEntry) : [];
};

const getCurrentCharacterName = () => (
  String(currentContext.personaName || currentContext.characterName || currentContext.name2 || '').trim()
);

const buildCompatCharacters = () => {
  const name = getCurrentCharacterName();
  return [{
    id: currentContext.personaId || 'current',
    name,
    avatar: currentContext.personaAvatar || name,
    data: {
      name,
      extensions: currentContext.characterExtensions && typeof currentContext.characterExtensions === 'object'
        ? currentContext.characterExtensions
        : {},
    },
  }];
};

const getRawPreset = () => {
  const preset = currentContext.activePreset && typeof currentContext.activePreset === 'object'
    ? currentContext.activePreset
    : {};
  const prompts = Array.isArray(preset.prompts)
    ? preset.prompts
    : normalizeStringList([]).concat(Array.isArray(currentContext.presetPrompts) ? currentContext.presetPrompts : []);
  return {
    ...preset,
    name: preset.name || currentContext.presetName || '',
    prompts,
    prompts_unused: Array.isArray(preset.prompts_unused) ? preset.prompts_unused : [],
  };
};

const presetScriptApi = createPresetScriptApi({
  getContext: () => currentContext, callRpc, clone,
  updateContext: context => { currentContext = { ...currentContext, ...context }; ensureSillyTavern(); scheduleCompatUiFlush(); },
});
const getPreset = presetScriptApi.getPreset;

const getPromptIdentifier = (prompt = {}, fallback = '') => {
  const candidates = [prompt.identifier, prompt.id, prompt.prompt_id, prompt.promptId, prompt.name, prompt.title, fallback];
  for (const item of candidates) {
    const value = String(item || '').trim();
    if (value) return value;
  }
  return '';
};

const findPromptOrderItem = (preset, identifier = '') => {
  const id = String(identifier || '').trim();
  if (!id) return null;
  const blocks = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
  for (const block of blocks) {
    const order = Array.isArray(block?.order) ? block.order : [];
    const hit = order.find(item => String(item?.identifier || item?.id || item?.name || '').trim() === id);
    if (hit) return hit;
  }
  return null;
};

const isPresetPromptEnabled = (preset, prompt = {}, fallback = '') => {
  const identifier = getPromptIdentifier(prompt, fallback);
  const orderItem = findPromptOrderItem(preset, identifier);
  if (orderItem && typeof orderItem === 'object' && 'enabled' in orderItem) return orderItem.enabled !== false;
  return prompt?.enabled !== false;
};

const setLocalPresetPromptEnabled = (identifier = '', enabled = true) => {
  const id = String(identifier || '').trim();
  const preset = getPreset();
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  const prompt = prompts.find((item, index) => {
    const promptId = getPromptIdentifier(item, 'custom_' + index);
    return promptId === id || String(item?.name || '').trim() === id;
  });
  if (!prompt) return false;
  const promptId = getPromptIdentifier(prompt, id);
  prompt.enabled = enabled !== false;
  let blocks = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
  if (!blocks.length) {
    blocks = [{ character_id: ST_PROMPT_ORDER_DUMMY_ID, order: prompts.map((item, index) => ({ identifier: getPromptIdentifier(item, 'custom_' + index), enabled: item?.enabled !== false })) }];
  }
  let targetBlock = blocks.find(block => String(block?.character_id) === String(ST_PROMPT_ORDER_DUMMY_ID)) || blocks[0];
  if (!targetBlock) {
    targetBlock = { character_id: ST_PROMPT_ORDER_DUMMY_ID, order: [] };
    blocks.push(targetBlock);
  }
  targetBlock.order = Array.isArray(targetBlock.order) ? targetBlock.order : [];
  let orderItem = targetBlock.order.find(item => String(item?.identifier || item?.id || item?.name || '').trim() === promptId);
  if (!orderItem) {
    orderItem = { identifier: promptId, enabled: enabled !== false };
    targetBlock.order.push(orderItem);
  } else {
    orderItem.identifier = promptId;
    orderItem.enabled = enabled !== false;
  }
  preset.prompt_order = blocks;
  currentContext.activePreset = preset;
  currentContext.presetPrompts = prompts;
  return true;
};

const syncVirtualPromptManager = () => {
  const doc = self.document;
  if (!doc?.body || typeof doc.createElement !== 'function') return;
  let list = doc.getElementById?.('completion_prompt_manager_list');
  if (!list) {
    list = doc.createElement('ul');
    list.id = 'completion_prompt_manager_list';
    list.setAttribute('id', 'completion_prompt_manager_list');
    list.setAttribute('data-chatapp-virtual', 'prompt-manager');
    doc.body.appendChild(list);
  }
  if (list.getAttribute?.('data-chatapp-virtual') !== 'prompt-manager') return;
  list.replaceChildren?.();
  const preset = getPreset();
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  prompts.forEach((prompt, index) => {
    const identifier = getPromptIdentifier(prompt, 'custom_' + index);
    if (!identifier) return;
    const enabled = isPresetPromptEnabled(preset, prompt, 'custom_' + index);
    const li = doc.createElement('li');
    li.setAttribute('data-pm-identifier', identifier);
    li.setAttribute('data-chatapp-virtual', 'prompt-row');
    if (!enabled) li.classList.add('completion_prompt_manager_prompt_disabled');
    const name = doc.createElement('span');
    name.setAttribute('data-pm-name', String(prompt?.name || identifier));
    name.textContent = String(prompt?.name || identifier);
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'prompt-manager-toggle-action toggle';
    toggle.setAttribute('class', toggle.className);
    toggle.setAttribute('data-action', 'toggle');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', 'toggle prompt');
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.checked = enabled;
    toggle.addEventListener('click', () => {
      const nextEnabled = li.classList.contains('completion_prompt_manager_prompt_disabled');
      li.classList.toggle('completion_prompt_manager_prompt_disabled', !nextEnabled);
      toggle.checked = nextEnabled;
      toggle.setAttribute('aria-checked', String(nextEnabled));
      setLocalPresetPromptEnabled(identifier, nextEnabled);
      callRpc('preset.setPromptEnabled', {
        presetType: 'openai',
        identifier,
        enabled: nextEnabled,
        sessionId: currentContext.sessionId,
      }).catch(() => {});
    });
    li.appendChild(name);
    li.appendChild(toggle);
    list.appendChild(li);
  });
};

const syncVirtualPresetRegexManager = () => {
  const doc = self.document;
  if (!doc?.body || typeof doc.createElement !== 'function') return;
  let list = doc.getElementById?.('saved_preset_scripts');
  if (!list) {
    list = doc.createElement('div');
    list.id = 'saved_preset_scripts';
    list.setAttribute('id', 'saved_preset_scripts');
    list.setAttribute('data-chatapp-virtual', 'preset-regex-manager');
    doc.body.appendChild(list);
  }
  if (list.getAttribute?.('data-chatapp-virtual') !== 'preset-regex-manager') return;
  list.replaceChildren?.();
  const regexes = Array.isArray(currentContext.presetRegexes) ? currentContext.presetRegexes : [];
  regexes.forEach((rule) => {
    const nameText = String(rule?.script_name || rule?.scriptName || rule?.name || '').trim();
    if (!nameText) return;
    const row = doc.createElement('div');
    row.className = 'regex-script-label';
    row.setAttribute('class', row.className);
    row.setAttribute('data-chatapp-virtual', 'preset-regex-row');
    row.setAttribute('data-regex-id', String(rule?.id || ''));
    if (rule?.enabled === false || rule?.disabled === true) row.classList.add('disabled');
    const name = doc.createElement('span');
    name.className = 'regex_script_name';
    name.setAttribute('class', name.className);
    name.textContent = nameText;
    row.appendChild(name);
    list.appendChild(row);
  });
};

const isPresetPlaceholderPrompt = (prompt = {}) => {
  const id = String(prompt.identifier || prompt.id || prompt.name || '').toLowerCase();
  return Boolean(prompt.placeholder || prompt.isPlaceholder || id.includes('placeholder'));
};

const isPresetSystemPrompt = (prompt = {}) => {
  const role = String(prompt.role || prompt.type || prompt.position || '').toLowerCase();
  return prompt.system === true || prompt.isSystem === true || role === 'system' || role === '0';
};

const buildCompatChatCompletionSettings = () => ({
  function_calling: false,
  ...(currentContext.chatCompletionSettings && typeof currentContext.chatCompletionSettings === 'object'
    ? currentContext.chatCompletionSettings
    : {}),
  prompts: getRawPreset().prompts,
});

const saveCompatChatCompletionSettings = (settings) => {
  if (currentSettings.allowModifyVariables !== true) {
    warnCompatPermissionDenied('修改变量');
    return Promise.resolve(false);
  }
  const source = settings && typeof settings === 'object'
    ? settings
    : buildCompatChatCompletionSettings();
  const snapshot = clone(source);
  const preset = getRawPreset();
  currentContext.chatCompletionSettings = snapshot;
  currentContext.activePreset = {
    ...preset,
    ...snapshot,
    id: preset.id || currentContext.openaiPresetId || '',
    name: preset.name || currentContext.presetName || '',
  };
  currentContext.presetPrompts = Array.isArray(snapshot.prompts)
    ? snapshot.prompts
    : preset.prompts;
  return callRpc('preset.saveChatCompletionSettings', {
    presetId: currentContext.openaiPresetId || preset.id || '',
    settings: snapshot,
    sessionId: currentContext.sessionId,
  }).catch((error) => {
    console.warn('[preset] saveSettingsDebounced failed', String(error?.message || error));
    return false;
  });
};

const buildCompatStContext = () => ({
  characterId: 0,
  characters: buildCompatCharacters(),
  name2: getCurrentCharacterName(),
  eventSource,
  eventTypes: EVENT_TYPES,
  event_types: EVENT_TYPES,
  extensionSettings: currentContext.extensionSettings && typeof currentContext.extensionSettings === 'object'
    ? currentContext.extensionSettings
    : {},
  chatCompletionSettings: buildCompatChatCompletionSettings(),
  world_names: getWorldbookNamesFromContext(),
  selected_world_info: getActiveWorldbookIds(),
  chat_metadata: {
    ...(currentContext.chat_metadata && typeof currentContext.chat_metadata === 'object' ? currentContext.chat_metadata : {}),
    world_info: getChatWorldbookName(),
  },
});

const legacyMacros = new Map();
let macroCompatApi = null;

const setMacroCompatVariable = (scope, key, value) => {
  const normalizedScope = scope === 'global' ? 'global' : 'chat';
  const targetKey = getCompatVariableContextKey(normalizedScope);
  const current = currentContext[targetKey] && typeof currentContext[targetKey] === 'object'
    ? currentContext[targetKey]
    : {};
  const next = { ...current, [key]: value };
  currentContext[targetKey] = next;
  if (normalizedScope === 'chat') currentContext.variables = next;
  callRpc('variables.set', {
    key,
    value,
    options: { scope: normalizedScope === 'chat' ? 'local' : 'global' },
    sessionId: currentContext.sessionId,
  }).catch(() => {});
  return true;
};

const getMacroCompatApi = () => {
  if (macroCompatApi) return macroCompatApi;
  macroCompatApi = createSillyTavernMacroApi({
    MacroEngineClass: MacroEngine,
    getRuntimeContext: () => currentContext,
    getMessages: () => getTavernChatSnapshot(),
    getVariables: scope => getCompatBaseVariables({ type: scope === 'global' ? 'global' : 'message' }),
    setVariable: setMacroCompatVariable,
    canReadMessages: () => currentSettings.allowReadMessages === true,
    canWriteVariables: () => currentSettings.allowModifyVariables === true,
    onWriteDenied: () => warnCompatPermissionDenied('修改变量'),
    getRegisteredMacros: () => legacyMacros,
  });
  return macroCompatApi;
};

const getContext = () => {
  const compatContext = buildCompatStContext();
  const chatCompletionSettings = compatContext.chatCompletionSettings;
  const chat = ensureSillyTavern().chat || [];
  const macros = getMacroCompatApi();
  return {
    ...currentContext,
    ...compatContext,
    chat,
    messages: chat,
    currentMessageId: currentContext.currentMessageId || '',
    ...buildCompatVariablesSnapshot(),
    powerUserSettings: self.powerUserSettings || {},
    setExtensionPrompt,
    saveSettingsDebounced: () => saveCompatChatCompletionSettings(chatCompletionSettings),
    substituteParams: macros.substituteParams,
    substituteParamsExtended: macros.substituteParamsExtended,
  };
};

// 酒馆脚本的 prompt 注入桥（缺陷 #1）：setExtensionPrompt / injectPrompts 转发到主线程注入表。
// position 数字为 ST extension_prompt_types：-1 NONE / 0 IN_PROMPT / 1 IN_CHAT / 2 BEFORE_PROMPT。
const normalizeCompatPromptPosition = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '-1' || raw === 'none') return 'none';
  if (raw === '0' || raw === 'in_prompt') return 'system_end';
  if (raw === '1') return 'in_chat';
  if (raw === '2') return 'before_prompt';
  return raw;
};

const setExtensionPrompt = (key, value, position, depth, _scan, role) => {
  const entryKey = String(key || '').trim();
  if (!entryKey) return Promise.resolve(false);
  return callRpc('prompt.setExtensionPrompt', {
    key: entryKey,
    value: String(value ?? ''),
    position: normalizeCompatPromptPosition(position),
    depth: Math.max(0, Math.trunc(Number(depth)) || 0),
    role: String(role || 'system'),
  }).catch(() => false);
};

const injectPrompts = (injects = []) => {
  const list = (Array.isArray(injects) ? injects : [injects])
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      id: String(item.id || '').trim(),
      content: String(item.content ?? item.prompt ?? ''),
      position: normalizeCompatPromptPosition(item.position),
      depth: Math.max(0, Math.trunc(Number(item.depth)) || 0),
      role: String(item.role || 'system'),
    }))
    .filter(item => item.id);
  if (!list.length) return Promise.resolve(false);
  return callRpc('prompt.injectPrompts', { injects: list }).catch(() => false);
};

const uninjectPrompts = (ids = []) => {
  const list = (Array.isArray(ids) ? ids : [ids]).map(id => String(id || '').trim()).filter(Boolean);
  if (!list.length) return Promise.resolve(false);
  return callRpc('prompt.uninjectPrompts', { ids: list }).catch(() => false);
};

const generateRaw = (config = {}) => callRpc('generation.generateRaw', {
  config: config && typeof config === 'object' ? clone(config) : {},
  sessionId: currentContext.sessionId,
});

const buildSillyTavern = () => {
  const st = {};
  const macros = getMacroCompatApi();
  st.chat = [];
  st.characters = buildCompatCharacters();
  st.characterId = 0;
  st.extensionSettings = buildCompatStContext().extensionSettings;
  st.chatCompletionSettings = buildCompatChatCompletionSettings();
  st.eventSource = eventSource;
  st.eventTypes = EVENT_TYPES;
  st.event_types = EVENT_TYPES;
  st.getContext = getContext;
  st.substituteParams = macros.substituteParams;
  st.substituteParamsExtended = macros.substituteParamsExtended;
  st.ToolManager = {
    isToolCallingSupported: () => false,
    parseToolCalls: () => {},
  };
  st.getRequestHeaders = () => ({});
  st.setExtensionPrompt = setExtensionPrompt;
  st.generateRaw = generateRaw;
  st.getChatCompletionModel = () => '';
  st.getCurrentChatId = () => String(currentContext.sessionId || '');
  st.saveChat = () => Promise.resolve(true);
  // 消息块渲染由 app 消息链自管（编辑走 setChatMessages RPC）；留 no-op 防
  // R寶提醒｜消息整理等脚本的编辑路径在成员缺失时 TypeError 中断整个 handler。
  st.updateMessageBlock = () => {};
  st.saveSettingsDebounced = () => saveCompatChatCompletionSettings(st.chatCompletionSettings);
  st.registerMacro = (name, fn) => {
    const key = String(name || '').trim();
    if (!key || typeof fn !== 'function') return;
    legacyMacros.set(key, fn);
  };
  st.unregisterMacro = (name) => {
    const key = String(name || '').trim();
    if (!key) return;
    legacyMacros.delete(key);
  };
  st.registerFunctionTool = () => {};
  st.unregisterFunctionTool = () => {};
  st.POPUP_TYPE = { TEXT: 'text', INPUT: 'input', CONFIRM: 'confirm' };
  st.POPUP_RESULT = { AFFIRMATIVE: 1, CANCELLED: 0, NEGATIVE: -1, CUSTOM1: 2 };
  st.callGenericPopup = async (content, type, _defaultValue, options = {}) => {
    const result = await callRpc('ui.confirm', {
      content: String(content || ''),
      type,
      options,
      sessionId: currentContext.sessionId,
    });
    return result === true ? st.POPUP_RESULT.AFFIRMATIVE : st.POPUP_RESULT.CANCELLED;
  };
  st.reloadCurrentChat = () => callRpc('chat.reloadCurrent', { sessionId: currentContext.sessionId });
  return st;
};

const ensureSillyTavern = () => {
  if (!self.SillyTavern) self.SillyTavern = buildSillyTavern();
  const macros = getMacroCompatApi();
  self.SillyTavern.characters = buildCompatCharacters();
  self.SillyTavern.characterId = 0;
  self.SillyTavern.extensionSettings = buildCompatStContext().extensionSettings;
  self.SillyTavern.chatCompletionSettings = buildCompatChatCompletionSettings();
  self.SillyTavern.eventSource = eventSource;
  self.SillyTavern.eventTypes = EVENT_TYPES;
  self.SillyTavern.event_types = EVENT_TYPES;
  self.SillyTavern.getContext = getContext;
  self.SillyTavern.substituteParams = macros.substituteParams;
  self.SillyTavern.substituteParamsExtended = macros.substituteParamsExtended;
  self.SillyTavern.generateRaw = generateRaw;
  self.SillyTavern.saveSettingsDebounced = () => saveCompatChatCompletionSettings(self.SillyTavern.chatCompletionSettings);
  self.SillyTavern.reloadCurrentChat = self.SillyTavern.reloadCurrentChat || (() => callRpc('chat.reloadCurrent', { sessionId: currentContext.sessionId }));
  return self.SillyTavern;
};

const refreshSillyTavernChat = async () => {
  if (currentSettings.allowReadMessages !== true) {
    currentContext.chat = [];
    ensureSillyTavern().chat = [];
    warnCompatPermissionDenied('读取消息');
    return;
  }
  try {
    const list = await callRpc('chat.getMessages', { sessionId: currentContext.sessionId });
    if (Array.isArray(list)) {
      const normalized = list.map(normalizeTavernMessage);
      currentContext.chat = normalized;
      ensureSillyTavern().chat = clone(normalized);
    }
  } catch {}
};

const refreshTavernRegexes = async () => {
  try {
    const list = await callRpc('regex.getCharacter', { sessionId: currentContext.sessionId });
    currentContext.characterRegexes = Array.isArray(list) ? clone(list) : [];
  } catch {
    currentContext.characterRegexes = [];
  }
};

const ensureCompatGlobals = () => {
  const allowNetwork = currentSettings.allowNetwork === true;
  if (!self.window) self.window = self;
  if (!self.parent) self.parent = self;
  if (!self.top) self.top = self;
  installCompatEventTarget(self);
  installCompatEventTarget(self.window);
  installCompatEventTarget(self.parent);
  installCompatEventTarget(self.top);
  applyCompatViewportSnapshot(currentSettings.viewport || compatViewport);
  if (!self.localStorage) self.localStorage = makeCompatLocalStorage();
  if (!self.document) self.document = makeCompatDocument();
  installCompatEventTarget(self.document);
  self.document.defaultView = self.window || self;
  if (!self.navigator) self.navigator = { userAgent: 'ChatApp ScriptRuntime' };
  if (!self.location) self.location = { href: '', origin: '' };
  if (!compatFetchInstalled) { self.fetch = guardedFetch; compatFetchInstalled = true; }
  self.XMLHttpRequest = GuardedXMLHttpRequest;
  self.WebSocket = GuardedWebSocket;
  self.importScripts = guardedImportScripts;
  if (!self.toastr) self.toastr = makeCompatToastr();
  self.window.toastr = self.window.toastr || self.toastr;
  self.parent.toastr = self.parent.toastr || self.toastr;
  self.top.toastr = self.top.toastr || self.toastr;
  if (typeof self.Event !== 'function') self.Event = function Event(type, options) { return makeCompatEvent(type, options); };
  if (typeof self.MouseEvent !== 'function') self.MouseEvent = function MouseEvent(type, options) { return makeCompatEvent(type, options); };
  if (typeof self.getComputedStyle !== 'function') self.getComputedStyle = (node) => node?.style || makeCompatStyle();
  if (typeof self.requestAnimationFrame !== 'function') {
    self.requestAnimationFrame = (cb) => setTimeout(() => {
      if (typeof cb === 'function') cb(Date.now());
    }, 16);
  }
  if (typeof self.cancelAnimationFrame !== 'function') self.cancelAnimationFrame = (id) => clearTimeout(id);
  if (typeof self.MutationObserver !== 'function') self.MutationObserver = CompatObserver;
  if (typeof self.ResizeObserver !== 'function') self.ResizeObserver = CompatObserver;
  if (typeof self.IntersectionObserver !== 'function') self.IntersectionObserver = CompatObserver;
  if (!self._) {
    const lodashUrls = [resolveLibUrl('lib/lodash.min.js')];
    if (allowNetwork) lodashUrls.push('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js');
    loadLibrary(lodashUrls);
  }
  if (!self._) self._ = makeCompatLodash();
  if (!self.z) {
    const zodUrls = [resolveLibUrl('lib/zod.min.js')];
    if (allowNetwork) zodUrls.push('https://cdn.jsdelivr.net/npm/zod@3.22.4/lib/index.umd.min.js');
    loadLibrary(zodUrls);
  }
  if (!self.z) {
    const candidate = self.Zod || self.zod;
    if (candidate && candidate.z) self.z = candidate.z;
    else if (candidate) self.z = candidate;
  }
  if (self.z) {
    const ZodType = self.z.ZodType || self.Zod?.ZodType;
    if (ZodType && typeof ZodType.prototype?.prefault !== 'function') {
      ZodType.prototype.prefault = function prefault(value) {
        if (typeof this.default === 'function') return this.default(value);
        return this;
      };
    }
    if (!self.z.z) self.z.z = self.z;
    if (!self.z.ZodObject && self.Zod?.ZodObject) self.z.ZodObject = self.Zod.ZodObject;
    if (typeof self.z.looseObject !== 'function') {
      self.z.looseObject = (shape) => {
        const resolved = typeof shape === 'function' ? shape() : shape;
        const obj = self.z.object(resolved || {});
        const optional = typeof obj.partial === 'function' ? obj.partial() : obj;
        if (typeof optional.passthrough === 'function') return optional.passthrough();
        if (typeof optional.nonstrict === 'function') return optional.nonstrict();
        return optional;
      };
    }
  }
  if (!self.$) self.$ = makeCompatDollar();
  ensureSillyTavern();
  if (typeof self.getVariables !== 'function') self.getVariables = getVariables;
  if (typeof self.getAllVariables !== 'function') self.getAllVariables = getAllVariables;
  if (typeof self.setVariables !== 'function') self.setVariables = setCompatVariables;
  if (typeof self.updateVariablesWith !== 'function') self.updateVariablesWith = updateVariablesWith;
  if (typeof self.insertOrAssignVariables !== 'function') self.insertOrAssignVariables = setCompatVariables;
  if (typeof self.deleteVariable !== 'function') self.deleteVariable = deleteVariable;
  if (typeof self.replaceVariables !== 'function') self.replaceVariables = replaceVariables;
  if (typeof self.waitGlobalInitialized !== 'function') self.waitGlobalInitialized = () => Promise.resolve(true);
  if (typeof self.errorCatched !== 'function') self.errorCatched = defaultErrorCatched;
  if (typeof self.getContext !== 'function') self.getContext = getContext;
  if (typeof self.getLastMessageId !== 'function') self.getLastMessageId = getLastMessageId;
  if (typeof self.getChatMessages !== 'function') self.getChatMessages = getChatMessages;
  if (typeof self.setChatMessages !== 'function') self.setChatMessages = setChatMessages;
  if (typeof self.getTavernRegexes !== 'function') self.getTavernRegexes = getTavernRegexes;
  if (typeof self.replaceTavernRegexes !== 'function') self.replaceTavernRegexes = replaceTavernRegexes;
  const macros = getMacroCompatApi();
  if (typeof self.substituteParams !== 'function') self.substituteParams = macros.substituteParams;
  if (typeof self.substituteParamsExtended !== 'function') self.substituteParamsExtended = macros.substituteParamsExtended;
  if (typeof self.substitudeMacros !== 'function') self.substitudeMacros = macros.substitudeMacros;
  if (typeof self.alert !== 'function') {
    self.alert = (message) => callRpc('ui.alert', { message: String(message || ''), sessionId: currentContext.sessionId });
  }
  if (typeof self.getCurrentCharacterName !== 'function') self.getCurrentCharacterName = getCurrentCharacterName;
  if (typeof self.getGlobalWorldbookNames !== 'function') self.getGlobalWorldbookNames = getGlobalWorldbookNames;
  if (typeof self.getCharWorldbookNames !== 'function') self.getCharWorldbookNames = getCharWorldbookNames;
  if (typeof self.getChatWorldbookName !== 'function') self.getChatWorldbookName = getChatWorldbookName;
  if (typeof self.getWorldbook !== 'function') self.getWorldbook = getWorldbook;
  if (typeof self.getPreset !== 'function') self.getPreset = getPreset;
  Object.assign(self, presetScriptApi);
  if (typeof self.generate !== 'function') self.generate = config => callRpc('generation.generate', { config: clone(config || {}), sessionId: currentContext.sessionId });
  self.builtin ||= {};
  self.builtin.reloadAndRenderChatWithoutEvents = () => callRpc('chat.reloadCurrent', { sessionId: currentContext.sessionId });
  self.builtin.copyText = text => callRpc('ui.copyText', { text: String(text || '') });
  if (typeof self.generateRaw !== 'function') self.generateRaw = generateRaw;
  if (typeof self.isPresetPlaceholderPrompt !== 'function') self.isPresetPlaceholderPrompt = isPresetPlaceholderPrompt;
  if (typeof self.isPresetSystemPrompt !== 'function') self.isPresetSystemPrompt = isPresetSystemPrompt;
  self.eventSource = self.eventSource || eventSource;
  self.eventTypes = self.eventTypes || EVENT_TYPES;
  self.event_types = self.event_types || EVENT_TYPES;
  self.Context = getContext();
  self.powerUserSettings = self.powerUserSettings || {};
  if (!self.TavernHelper || typeof self.TavernHelper !== 'object') self.TavernHelper = {};
  const helper = self.TavernHelper;
  if (typeof helper.getTavernHelperVersion !== 'function') helper.getTavernHelperVersion = async () => '0.0.0';
  if (typeof helper.substituteParams !== 'function') helper.substituteParams = macros.substituteParams;
  if (typeof helper.substituteParamsExtended !== 'function') helper.substituteParamsExtended = macros.substituteParamsExtended;
  if (typeof helper.substitudeMacros !== 'function') helper.substitudeMacros = macros.substitudeMacros;
  helper.getVariables = helper.getVariables || getVariables;
  helper.getAllVariables = helper.getAllVariables || getAllVariables;
  helper.setVariables = helper.setVariables || setCompatVariables;
  helper.updateVariablesWith = helper.updateVariablesWith || updateVariablesWith;
  helper.insertOrAssignVariables = helper.insertOrAssignVariables || setCompatVariables;
  helper.deleteVariable = helper.deleteVariable || deleteVariable;
  helper.replaceVariables = helper.replaceVariables || replaceVariables;
  helper.getContext = helper.getContext || getContext;
  helper.getLastMessageId = helper.getLastMessageId || getLastMessageId;
  helper.getChatMessages = helper.getChatMessages || getChatMessages;
  helper.setChatMessages = helper.setChatMessages || setChatMessages;
  helper.getTavernRegexes = helper.getTavernRegexes || getTavernRegexes;
  helper.replaceTavernRegexes = helper.replaceTavernRegexes || replaceTavernRegexes;
  helper.getWorldbook = helper.getWorldbook || getWorldbook;
  helper.getGlobalWorldbookNames = helper.getGlobalWorldbookNames || getGlobalWorldbookNames;
  helper.getCharWorldbookNames = helper.getCharWorldbookNames || getCharWorldbookNames;
  helper.getChatWorldbookName = helper.getChatWorldbookName || getChatWorldbookName;
  helper.getPreset = helper.getPreset || getPreset;
  helper.generateRaw = helper.generateRaw || generateRaw;
  helper.injectPrompts = helper.injectPrompts || injectPrompts;
  helper.uninjectPrompts = helper.uninjectPrompts || uninjectPrompts;
  helper.setExtensionPrompt = helper.setExtensionPrompt || setExtensionPrompt;
  syncVirtualPromptManager();
  syncVirtualPresetRegexManager();
};

let lastSchemaDebug = null;
const resolveSchemaDefaults = (schema) => {
  if (!schema) return null;
  let value = schema;
  if (typeof value === 'function') {
    try {
      value = value();
    } catch {
      return null;
    }
  }
  const pickStat = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.stat_data && typeof obj.stat_data === 'object') return obj.stat_data;
    if (obj.statData && typeof obj.statData === 'object') return obj.statData;
    if (obj.variables && typeof obj.variables === 'object') return obj.variables;
    return obj;
  };
  let parsedData = null;
  if (value && typeof value.safeParse === 'function') {
    try {
      let parsed = value.safeParse({ stat_data: {} });
      if (!parsed?.success) parsed = value.safeParse({ statData: {} });
      if (!parsed?.success) parsed = value.safeParse({});
      if (parsed?.success) {
        const data = pickStat(parsed.data);
        if (data && typeof data === 'object') parsedData = data;
      }
    } catch {}
  }
  const getTypeName = (node) =>
    node?._def?.typeName || node?._def?.type || node?.constructor?.name || '';
  const getShape = (node) => {
    if (!node) return null;
    if (typeof node.shape === 'function') return node.shape();
    if (node.shape && typeof node.shape === 'object') return node.shape;
    if (typeof node._def?.shape === 'function') return node._def.shape();
    if (node._def?.shape && typeof node._def.shape === 'object') return node._def.shape;
    return null;
  };
  const tryDefault = (node) => {
    if (!node) return undefined;
    try {
      if (typeof node._def?.defaultValue === 'function') {
        const raw = node._def.defaultValue();
        return typeof raw === 'function' ? raw() : raw;
      }
    } catch {}
    try {
      if (typeof node.parse === 'function') return node.parse(undefined);
    } catch {}
    return undefined;
  };
  const buildDefaults = (node) => {
    if (!node) return undefined;
    const typeName = getTypeName(node);
    if (typeName === 'ZodDefault') {
      const val = tryDefault(node);
      return val !== undefined ? val : undefined;
    }
    if (typeName === 'ZodEffects') {
      const inner = node._def?.schema || node._def?.innerType;
      let base = buildDefaults(inner);
      if (base === undefined) base = tryDefault(node);
      const effect = node._def?.effect;
      if (effect?.type === 'transform' && typeof effect.transform === 'function') {
        try {
          return effect.transform(base, { addIssue: () => {}, path: [] });
        } catch {}
      }
      return base;
    }
    if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
      const inner = node._def?.innerType;
      const base = buildDefaults(inner);
      if (base !== undefined) return base;
      return tryDefault(node);
    }
    if (typeName === 'ZodObject') {
      const shape = getShape(node);
      if (!shape || typeof shape !== 'object') return tryDefault(node);
      const out = {};
      Object.entries(shape).forEach(([key, child]) => {
        const val = buildDefaults(child);
        if (val !== undefined) out[key] = val;
      });
      return out;
    }
    if (typeName === 'ZodRecord') {
      const rec = tryDefault(node);
      if (rec !== undefined) return rec;
      return {};
    }
    if (typeName === 'ZodArray') {
      const arr = tryDefault(node);
      if (arr !== undefined) return arr;
      return [];
    }
    return tryDefault(node);
  };
  const mergeDeep = (base, override) => {
    const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
    if (!override || typeof override !== 'object') return out;
    Object.entries(override).forEach(([key, val]) => {
      if (Array.isArray(val)) {
        out[key] = val.slice();
      } else if (val && typeof val === 'object' && out[key] && typeof out[key] === 'object') {
        out[key] = mergeDeep(out[key], val);
      } else {
        out[key] = val;
      }
    });
    return out;
  };
  const fallback = buildDefaults(value);
  const fallbackPicked = pickStat(fallback);
  if (parsedData && typeof parsedData === 'object') {
    if (fallbackPicked && typeof fallbackPicked === 'object') {
      const merged = mergeDeep(fallbackPicked, parsedData);
      lastSchemaDebug = {
        mode: 'merge',
        parsedKeys: Object.keys(parsedData),
        fallbackKeys: Object.keys(fallbackPicked),
        mergedKeys: Object.keys(merged),
      };
      return merged;
    }
    if (Object.keys(parsedData).length) {
      lastSchemaDebug = { mode: 'parsed', parsedKeys: Object.keys(parsedData) };
      return parsedData;
    }
  }
  if (fallbackPicked && typeof fallbackPicked === 'object') {
    lastSchemaDebug = { mode: 'fallback', fallbackKeys: Object.keys(fallbackPicked) };
    return fallbackPicked;
  }
  const direct = pickStat(value);
  if (direct && typeof direct === 'object') {
    lastSchemaDebug = { mode: 'direct', directKeys: Object.keys(direct) };
    return direct;
  }
  lastSchemaDebug = { mode: 'none' };
  return null;
};

const registerVariableSchema = (schema, options = {}) => {
  try {
    ensureCompatGlobals();
    if (currentSettings.allowModifyVariables !== true) {
      warnCompatPermissionDenied('修改变量');
      return false;
    }
    const defaults = resolveSchemaDefaults(schema);
    if (!defaults || typeof defaults !== 'object') {
      callRpc('log', { level: 'warn', args: ['[MVU] registerVariableSchema: no defaults', JSON.stringify(lastSchemaDebug || {})] }).catch(() => {});
      return false;
    }
    const keys = Object.keys(defaults);
    const sampleKeys = keys.slice(0, 6).join(',');
    const msg = '[MVU] registerVariableSchema defaults=' + keys.length +
      ' keys=' + sampleKeys + (keys.length > 6 ? ',…' : '');
    callRpc('log', {
      level: 'info',
      args: [msg, JSON.stringify(lastSchemaDebug || {})],
    }).catch(() => {});
    callRpc('variables.registerSchema', { defaults, options }).catch(() => {});
    return true;
  } catch (err) {
    callRpc('log', { level: 'warn', args: ['registerVariableSchema failed', String(err?.message || err)] }).catch(() => {});
    return false;
  }
};

if (!self.registerVariableSchema) self.registerVariableSchema = registerVariableSchema;

const runImport = (url, baseUrl) => {
  ensureCompatGlobals();
  const key = resolveImportUrl(String(url || '').trim(), baseUrl);
  if (!key) return {};
  if (isRemoteUrl(key) && !currentSettings.allowNetwork) {
    callRpc('log', { level: 'warn', args: ['脚本网络已禁用，阻止加载', key] }).catch(() => {});
    return {};
  }
  if (importCache.has(key)) return importCache.get(key);
  const before = new Set(Object.keys(self));
  const prevModule = self.module;
  const prevExports = self.exports;
  const module = { exports: {} };
  self.module = module;
  self.exports = module.exports;
  let importError = null;
  try {
    importScripts(key);
  } catch (err) {
    importError = err;
  } finally {
    if (prevModule === undefined) delete self.module;
    else self.module = prevModule;
    if (prevExports === undefined) delete self.exports;
    else self.exports = prevExports;
  }
  if (importError) {
    let esmToken = null;
    let processed = '';
    try {
      const text = loadScriptText(key);
      processed = preprocess(text);
      esmToken = findEsmToken(processed);
      const runner = new Function('module', 'exports', '__import', processed);
      const localImport = (nextUrl) => runImport(nextUrl, key);
      runner(module, module.exports, localImport);
      importError = null;
    } catch (err) {
      if (esmToken) {
        const start = Math.max(0, esmToken.index - 80);
        const end = Math.min(processed.length, esmToken.index + 200);
        callRpc('log', {
          level: 'warn',
          args: ['[preprocess] unresolved', esmToken.type, key, processed.slice(start, end)],
        }).catch(() => {});
      }
      callRpc('log', { level: 'warn', args: ['脚本 import 失败', key, String(err?.message || err)] }).catch(() => {});
    }
  }
  const diff = {};
  Object.keys(self).forEach((keyName) => {
    if (!before.has(keyName)) diff[keyName] = self[keyName];
  });
  const result = buildModuleNamespace(module.exports, diff);
  importCache.set(key, result);
  if (importCache.size > IMPORT_CACHE_LIMIT) {
    const first = importCache.keys().next().value;
    if (first) importCache.delete(first);
  }
  return result;
};

const normalizeNamedImport = (raw) => {
  return String(raw || '')
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const m = trimmed.match(/^([\\w$]+)\\s+as\\s+([\\w$]+)$/);
      return m ? \`\${m[1]}: \${m[2]}\` : trimmed;
    })
    .filter(Boolean)
    .join(', ');
};

const parseNamedExports = (raw) => {
  return String(raw || '')
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const m = trimmed.match(/^([\\w$]+)\\s+as\\s+([\\w$]+)$/);
      return m ? { local: m[1], exported: m[2] } : { local: trimmed, exported: trimmed };
    })
    .filter(Boolean);
};

const isWordChar = (ch) => !!ch && /[A-Za-z0-9_$]/.test(ch);

const readQuotedString = (text, start) => {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  let i = start + 1;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\\\') {
      i += 1;
      continue;
    }
    if (ch === quote) {
      return { value: text.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
};

const looseTransformImports = (code) => {
  const text = String(code || '');
  let out = '';
  let i = 0;
  const len = text.length;
  let state = 'code';
  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === "'" || ch === '"' || ch === '\`') {
        state = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        state = 'line';
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += ch + next;
        i += 2;
        continue;
      }
      if (
        ch === 'i' &&
        text.startsWith('import', i) &&
        !isWordChar(text[i - 1])
      ) {
        const importStart = i;
        let cursor = i + 6;
        if (text[cursor] === '.') {
          out += text[i];
          i += 1;
          continue;
        }
        while (cursor < len && /\\s/.test(text[cursor])) cursor += 1;
        if (text[cursor] === '(') {
          out += text[i];
          i += 1;
          continue;
        }
        if (text[cursor] === '"' || text[cursor] === "'") {
          const parsed = readQuotedString(text, cursor);
          if (parsed) {
            out += '__import(' + JSON.stringify(parsed.value) + ');';
            i = parsed.end;
            while (i < len && /\\s/.test(text[i])) i += 1;
            if (text[i] === ';') i += 1;
            continue;
          }
        }
        let braceDepth = 0;
        let scan = cursor;
        let fromIndex = -1;
        while (scan < len) {
          const c = text[scan];
          if (c === "'" || c === '"') {
            const quoted = readQuotedString(text, scan);
            if (quoted) {
              scan = quoted.end;
              continue;
            }
          }
          if (c === '{') braceDepth += 1;
          else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
          if (
            braceDepth === 0 &&
            text.startsWith('from', scan) &&
            !isWordChar(text[scan - 1]) &&
            !isWordChar(text[scan + 4])
          ) {
            fromIndex = scan;
            break;
          }
          scan += 1;
        }
        if (fromIndex !== -1) {
          const clause = text.slice(cursor, fromIndex).trim();
          let specStart = fromIndex + 4;
          while (specStart < len && /\\s/.test(text[specStart])) specStart += 1;
          const spec = readQuotedString(text, specStart);
          if (spec) {
            let replacement = '';
            if (clause.startsWith('{') && clause.endsWith('}')) {
              const converted = normalizeNamedImport(clause.slice(1, -1));
              replacement = 'const { ' + converted + ' } = __import(' + JSON.stringify(spec.value) + ');';
            } else if (clause.startsWith('*')) {
              const m = clause.match(/^\\*\\s*as\\s+([\\w$]+)/);
              if (m) replacement = 'const ' + m[1] + ' = __import(' + JSON.stringify(spec.value) + ');';
            } else if (clause.includes(',')) {
              const [left, rightRaw] = clause.split(',', 2);
              const defaultName = left.trim();
              const right = (rightRaw || '').trim();
              if (right.startsWith('{') && right.endsWith('}')) {
                const converted = normalizeNamedImport(right.slice(1, -1));
                replacement = 'const { default: ' + defaultName + (converted ? ', ' + converted : '') + ' } = __import(' + JSON.stringify(spec.value) + ');';
              } else if (right.startsWith('*')) {
                const m = right.match(/^\\*\\s*as\\s+([\\w$]+)/);
                if (m) {
                  replacement = 'const { default: ' + defaultName + ' } = __import(' + JSON.stringify(spec.value) + ');\\nconst ' + m[1] + ' = __import(' + JSON.stringify(spec.value) + ');';
                }
              }
            } else if (/^[\\w$]+$/.test(clause)) {
              replacement = 'const { default: ' + clause + ' } = __import(' + JSON.stringify(spec.value) + ');';
            }
            if (replacement) {
              out += replacement;
              i = spec.end;
              while (i < len && /\\s/.test(text[i])) i += 1;
              if (text[i] === ';') i += 1;
              continue;
            }
          }
        }
        out += text[importStart];
        i = importStart + 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      out += ch;
      i += 1;
      if (ch === '\\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      out += ch;
      i += 1;
      if (ch === '*' && next === '/') {
        out += next;
        i += 1;
        state = 'code';
      }
      continue;
    }
    if (state === "'" || state === '"') {
      out += ch;
      i += 1;
      if (ch === '\\\\') {
        out += text[i] || '';
        i += 1;
        continue;
      }
      if (ch === state) state = 'code';
      continue;
    }
    if (state === '\`') {
      out += ch;
      i += 1;
      if (ch === '\\\\') {
        out += text[i] || '';
        i += 1;
        continue;
      }
      if (ch === '\`') state = 'code';
      continue;
    }
  }
  return out;
};

const findEsmToken = (code) => {
  if (!code) return null;
  const importIndex = String(code).search(/(^|[^\\w$])import\\s*(?:['"]|\\{|\\*|[\\w$]+\\s+from)/m);
  if (importIndex !== -1) return { type: 'import', index: importIndex };
  const exportIndex = String(code).search(/(^|[^\\w$])export\\s+/m);
  if (exportIndex !== -1) return { type: 'export', index: exportIndex };
  return null;
};

const preprocess = (code) => {
  if (!code) return '';
  let out = String(code);
  const exportNames = [];
  const exportAssignments = [];
  let exportSeq = 0;
  // export * from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*export\\s*\\*\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, url) => \`\${prefix}Object.assign(exports, __import(\${JSON.stringify(url)}));\`,
  );
  // export { a as b } from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*export\\s*\\{([^}]+)\\}\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, named, url) => {
      const entries = parseNamedExports(named);
      const modName = \`__mod\${++exportSeq}\`;
      const lines = [\`\${prefix}const \${modName} = __import(\${JSON.stringify(url)});\`];
      entries.forEach(({ local, exported }) => {
        lines.push(\`exports.\${exported} = \${modName}.\${local};\`);
      });
      return lines.join('\\n');
    },
  );
  // export { a as b, c }
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*export\\s*\\{([^}]+)\\}\\s*;?/g,
    (_m, prefix, named) => {
      const entries = parseNamedExports(named);
      entries.forEach(({ local, exported }) => {
        exportAssignments.push(\`exports.\${exported} = \${local};\`);
      });
      return prefix;
    },
  );
  // export const/let/var/function/class name
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*export\\s*(const|let|var|function|class)\\s+([\\w$]+)/g,
    (_m, prefix, type, name) => {
      exportNames.push(name);
      return \`\${prefix}\${type} \${name}\`;
    },
  );
  // import * from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*import(?!\\s*\\.)\\s*\\*\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, url) => \`\${prefix}__import(\${JSON.stringify(url)});\`,
  );
  // import * as name from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*import(?!\\s*\\.)\\s*\\*\\s*as\\s*([\\w$]+)\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, name, url) => \`\${prefix}const \${name} = __import(\${JSON.stringify(url)});\`,
  );
  // import name, { a as b } from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*import(?!\\s*\\.)\\s*([\\w$]+)\\s*,\\s*\\{([^}]+)\\}\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, name, named, url) => {
      const converted = normalizeNamedImport(named);
      return \`\${prefix}const { default: \${name}\${converted ? \`, \${converted}\` : ''} } = __import(\${JSON.stringify(url)});\`;
    },
  );
  // import { a as b } from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*import(?!\\s*\\.)\\s*\\{([^}]+)\\}\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, named, url) => {
      const converted = normalizeNamedImport(named);
      return \`\${prefix}const { \${converted} } = __import(\${JSON.stringify(url)});\`;
    },
  );
  // import name from 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*import(?!\\s*\\.)\\s*([\\w$]+)\\s*from\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, name, url) => \`\${prefix}const { default: \${name} } = __import(\${JSON.stringify(url)});\`,
  );
  // import 'url'
  out = out.replace(
    /(^|[\\r\\n;\\)\\}\\]])\\s*import(?!\\s*\\.)\\s*['"]([^'"]+)['"]\\s*;?/g,
    (_m, prefix, url) => \`\${prefix}__import(\${JSON.stringify(url)});\`,
  );
  if (findEsmToken(out)) {
    out = looseTransformImports(out);
  }
  out = out.replace(/\\bexport\\s+default\\s+/g, 'exports.default = ');
  if (exportNames.length || exportAssignments.length) {
    const lines = [];
    exportNames.forEach(name => lines.push(\`exports.\${name} = \${name};\`));
    exportAssignments.forEach(line => lines.push(line));
    out += \`\\n\${lines.join('\\n')}\\n\`;
  }
  return out;
};

const scheduleDataFlush = (() => {
  const timers = new Map();
  return (scriptId) => {
    if (!scriptId) return;
    const prev = timers.get(scriptId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      timers.delete(scriptId);
      const entry = scripts.get(scriptId);
      if (entry) {
        callRpc('script.updateData', {
          scriptId,
          data: clone(entry.script?.data || {}),
          scope: entry.record?.scope || '',
          scopeId: entry.record?.scopeId || '',
        }).catch(() => {});
      }
    }, 200);
    timers.set(scriptId, timer);
  };
})();

const makeDataProxy = (scriptId, data) => {
  const base = data && typeof data === 'object' ? data : {};
  return new Proxy(base, {
    set(target, prop, value) {
      target[prop] = value;
      scheduleDataFlush(scriptId);
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      scheduleDataFlush(scriptId);
      return true;
    },
  });
};

const normalizeRole = (role) => {
  const r = String(role || '').trim().toLowerCase();
  if (!r) return '';
  if (r === 'user' || r === 'assistant' || r === 'system') return r;
  if (r === 'any') return '';
  return r;
};

const messageContentToText = (msg) => {
  if (!msg || typeof msg !== 'object') return '';
  const content = msg.content;
  if (Array.isArray(content)) {
    return content
      .map(part => (part?.type === 'text' ? String(part.text || '') : ''))
      .filter(Boolean)
      .join('\\n');
  }
  return String((typeof msg.raw === 'string' && msg.raw) ? msg.raw : (content ?? ''));
};

const makeApi = (scriptId) => {
  const call = (method, params) => callRpc(method, { ...params, sessionId: currentContext.sessionId, scriptId });
  const resolveChatMessages = async () => {
    const list = await call('chat.getMessages', {});
    return Array.isArray(list) ? list : [];
  };
  return {
    getvar: (key, options = {}) => call('variables.get', { key, options }),
    setvar: (key, value, options = {}) => call('variables.set', { key, value, options }),
    incvar: (key, delta = 1, options = {}) => call('variables.inc', { key, delta, options }),
    decvar: (key, delta = 1, options = {}) => call('variables.dec', { key, delta, options }),
    getChatMessage: async (idx, role) => {
      const list = await resolveChatMessages();
      const roleFilter = normalizeRole(role);
      const filtered = roleFilter ? list.filter(m => String(m?.role || '').trim().toLowerCase() === roleFilter) : list;
      if (!filtered.length) return '';
      let index = Number(idx);
      if (!Number.isFinite(index)) return '';
      index = Math.trunc(index);
      if (index < 0) index = filtered.length + index;
      if (index < 0 || index >= filtered.length) return '';
      return messageContentToText(filtered[index]);
    },
    getChatMessages: async (...args) => {
      const list = await resolveChatMessages();
      if (!list.length) return [];
      let start = null;
      let end = null;
      let role = '';
      if (args.length === 1) {
        start = null;
        end = Number(args[0]);
      } else if (args.length === 2) {
        if (typeof args[1] === 'string') {
          end = Number(args[0]);
          role = String(args[1] || '');
        } else {
          start = Number(args[0]);
          end = Number(args[1]);
        }
      } else if (args.length >= 3) {
        start = Number(args[0]);
        end = Number(args[1]);
        role = String(args[2] || '');
      }
      const roleFilter = normalizeRole(role);
      const filtered = roleFilter ? list.filter(m => String(m?.role || '').trim().toLowerCase() === roleFilter) : list;
      if (!filtered.length) return [];
      if (start === null) {
        const count = Number(end);
        if (!Number.isFinite(count)) return [];
        const n = Math.max(0, Math.trunc(count));
        const slice = n === 0 ? [] : filtered.slice(-n);
        return slice.map(messageContentToText);
      }
      const s = Math.max(0, Math.trunc(Number(start) || 0));
      const eRaw = Number(end);
      const e = Number.isFinite(eRaw) ? Math.max(s, Math.trunc(eRaw)) : filtered.length;
      return filtered.slice(s, e).map(messageContentToText);
    },
    getwi: (world, title, data) => call('world.getEntry', { world, title, data }),
    getWorldbook: (world) => call('world.getBook', { world }),
    getWorldbookNames: () => getWorldbookNamesFromContext(),
    getGlobalWorldbookNames,
    getCharWorldbookNames,
    getChatWorldbookName,
    activewi: (world, title, force) => call('world.activate', { world, title, force }),
    getchar: (name) => call('context.getCharacter', { name }),
    getpreset: (name) => call('context.getPreset', { name }),
    getContext: () => call('context.getContext', {}),
    getcontext: () => call('context.getContext', {}),
    log: (...args) => call('log', { level: 'log', args }),
    warn: (...args) => call('log', { level: 'warn', args }),
    error: (...args) => call('log', { level: 'error', args }),
    toast: (message, level = 'info') => call('toast', { message, level }),
  };
};

const compileScript = (record) => {
  ensureCompatGlobals();
  const handlers = new Map();
  const on = (event, fn) => {
    const name = String(event || '').trim();
    if (!name || typeof fn !== 'function') return;
    const list = handlers.get(name) || [];
    list.push(fn);
    handlers.set(name, list);
    notifyListener(name);
  };
  const off = (event, fn) => {
    const name = String(event || '').trim();
    if (!name || !handlers.has(name)) return;
    if (!fn) {
      handlers.delete(name);
      return;
    }
    const list = handlers.get(name) || [];
    handlers.set(name, list.filter(item => item !== fn));
  };
  const legacyHandlerMap = new WeakMap();
  const eventOn = (event, cb) => {
    const name = String(event || '').trim();
    if (!name || typeof cb !== 'function') return;
    const wrapped = (payload) => {
      if (payload && typeof payload === 'object' && Array.isArray(payload.args)) {
        return cb(...payload.args);
      }
      return cb(payload);
    };
    legacyHandlerMap.set(cb, wrapped);
    on(name, wrapped);
    notifyListener(name);
    return { stop: () => off(name, wrapped) };
  };
  const eventRemoveListener = (event, cb) => {
    const name = String(event || '').trim();
    if (!name) return;
    if (!cb) return off(name);
    const wrapped = legacyHandlerMap.get(cb) || cb;
    off(name, wrapped);
  };
  const api = makeApi(record.id);
  const buttonApi = makeScriptButtonApi(record);
  const script = {
    id: record.id,
    name: record.name,
    info: record.info || '',
    scope: record.scope || '',
    scopeId: record.scopeId || '',
    data: makeDataProxy(record.id, clone(record.data || {})),
  };
  const buttonNames = new Set();
  const scriptButtons = [];
  const scoped = {
    ...presetScriptApi,
    getScriptId: buttonApi.getScriptId,
    eventOn,
    eventMakeFirst: (name, callback) => {
      const subscription = eventOn(name, callback);
      const list = handlers.get(name);
      if (list?.length > 1) list.unshift(list.pop());
      return subscription;
    },
    getButtonEvent: name => {
      const event = 'script_button:' + record.id + ':' + name;
      if (!buttonNames.has(name)) {
        buttonNames.add(name);
        buttonApi.eventOnButton(name, () => {
          for (const callback of [...(handlers.get(event) || [])]) runCompatCallback(() => callback({ args: [] }));
        });
      }
      return event;
    },
    appendInexistentScriptButtons: buttons => {
      for (const button of buttons || []) if (!scriptButtons.some(item => item.name === button.name)) scriptButtons.push(clone(button));
      return buttonApi.replaceScriptButtons(record.id, scriptButtons);
    },
    getVariables: option => String(option?.type || option?.scope || '').toLowerCase() === 'script'
      ? clone(script.data) : getVariables(option),
    replaceVariables: (value, option = {}) => {
      if (typeof value === 'string') return replaceVariables(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('变量必须是对象');
      if (currentSettings.allowModifyVariables !== true) throw new Error('脚本权限已禁用：修改变量');
      if (option.type === 'script' || option.scope === 'script') {
        script.data = makeDataProxy(record.id, clone(value));
        return callRpc('script.updateData', { scriptId: record.id, data: clone(script.data), scope: record.scope, scopeId: record.scopeId });
      }
      const scope = normalizeCompatVariableScope(option);
      const targetKey = getCompatVariableContextKey(scope);
      currentContext[targetKey] = clone(value);
      if (scope === 'chat') currentContext.variables = clone(value);
      return callRpc('variables.replace', { value: clone(value), scope, sessionId: currentContext.sessionId });
    },
    generate: config => callRpc('generation.generate', { config: clone(config || {}), sessionId: currentContext.sessionId, scriptId: record.id }),
    stopGenerationById: generationId => callRpc('generation.stop', { generationId, scriptId: record.id, sessionId: currentContext.sessionId }),
  };
  const scopedGlobal = new Proxy(self, { get: (target, key) => Object.hasOwn(scoped, key) ? scoped[key] : target[key] });
  let defaultHandler = null;
  // schemaOnly 脚本不执行代码，仅保留记录（Schema 已在导入时静态解析）
  if (record.schemaOnly === true) {
    callRpc('log', { level: 'info', args: ['[MVU] 跳过 schemaOnly 脚本执行', record.name] }).catch(() => {});
    return { record, handlers, defaultHandler, api, script };
  }
  try {
    const module = { exports: {} };
    const exports = module.exports;
    const code = preprocess(record.content || '');
    const runner = new Function(
      'api',
      'script',
      'on',
      'off',
      'eventOn',
      'eventRemoveListener',
      'module',
      'exports',
      '__import',
      'getScriptId',
      'replaceScriptButtons',
      'eventOnButton',
      'getTavernRegexes',
      'replaceTavernRegexes',
      '__scriptGlobals',
      'with (__scriptGlobals) { return (function () {\\n' + code + '\\n}).call(this); }',
    );
    const __import = (url) => runImport(url, getOrigin());
    self.__chatappScriptOn = on;
    self.__chatappScriptOff = off;
    runner(
      api,
      script,
      on,
      off,
      eventOn,
      eventRemoveListener,
      module,
      exports,
      __import,
      buttonApi.getScriptId,
      buttonApi.replaceScriptButtons,
      buttonApi.eventOnButton,
      getTavernRegexes,
      replaceTavernRegexes,
      { ...scoped, globalThis: scopedGlobal },
    );
    if (typeof module.exports === 'function') defaultHandler = module.exports;
    else if (module.exports && typeof module.exports.default === 'function') defaultHandler = module.exports.default;
    else if (exports && typeof exports.default === 'function') defaultHandler = exports.default;
  } catch (err) {
    const error = String(err?.message || err);
    callRpc('log', {
      level: 'error',
      args: ['脚本加载失败', record.name, error],
      scriptError: {
        phase: 'load',
        scriptId: record.id,
        scriptName: record.name,
        error,
        compatibility: record.compatibility || null,
      },
    }).catch(() => {});
  }
  return { record, handlers, defaultHandler, api, script };
};

const runHandlers = async (entry, eventName, payload, allowMutate) => {
  let data = payload;
  const base = data && typeof data === 'object' ? { ...data } : { value: data };
  const handlerPayload = { ...base, event: eventName };
  Object.defineProperties(handlerPayload, {
    context: { value: currentContext, enumerable: false, configurable: true },
    api: { value: entry.api, enumerable: false, configurable: true },
    script: { value: entry.script, enumerable: false, configurable: true },
  });
  const list = entry.handlers.get(eventName) || entry.handlers.get('*') || [];
  if (!list.length && entry.defaultHandler) list.push(entry.defaultHandler);
  for (const fn of list) {
    try {
      const res = await fn(handlerPayload);
      if (allowMutate && res && typeof res === 'object') {
        data = res;
      }
    } catch (err) {
      const error = String(err?.message || err);
      callRpc('log', {
        level: 'warn',
        args: ['脚本执行失败', entry.record?.name || '', error],
        scriptError: {
          phase: 'execute',
          scriptId: entry.record?.id || '',
          scriptName: entry.record?.name || '',
          error,
          compatibility: entry.record?.compatibility || null,
        },
      }).catch(() => {});
    }
  }
  return data;
};

const syncCompatVariablesFromEvent = (eventName, payload = {}) => {
  const evt = String(eventName || '').trim();
  const data = payload && typeof payload === 'object' ? payload : {};
  if (evt === 'variable.changed') {
    const name = String(data.name || '').trim();
    if (!name) return;
    const scope = normalizeCompatVariableScope(data.scope || 'chat');
    const targetKey = getCompatVariableContextKey(scope);
    const current = currentContext[targetKey] && typeof currentContext[targetKey] === 'object' ? currentContext[targetKey] : {};
    if (data.newValue === undefined) {
      delete current[name];
    } else {
      current[name] = data.newValue;
    }
    currentContext[targetKey] = current;
    if (scope === 'chat') currentContext.variables = current;
    ensureCompatGlobals();
    return;
  }
  if (evt === 'mag_variable_initialized' || evt === 'mag_variable_update_ended' || evt === 'mag_variable_update_ended_for_zod') {
    const variables = data.variables && typeof data.variables === 'object'
      ? data.variables
      : Array.isArray(data.args) && data.args[0] && typeof data.args[0] === 'object'
        ? data.args[0]
        : null;
    if (!variables) return;
    const scope = normalizeCompatVariableScope(data.scope || 'chat');
    const targetKey = getCompatVariableContextKey(scope);
    currentContext[targetKey] = clone(variables);
    if (scope === 'chat') {
      currentContext.localVariables = clone(variables);
      currentContext.variables = clone(variables);
    }
    ensureCompatGlobals();
  }
};

const dispatchEvent = async (eventName, payload, allowMutate = true) => {
  let data = payload;
  syncCompatVariablesFromEvent(eventName, payload);
  await refreshSillyTavernChat();
  for (const entry of scripts.values()) {
    if (!entry?.record?.enabled) continue;
    data = await runHandlers(entry, eventName, data, allowMutate);
  }
  return data;
};

self.onmessage = async (e) => {
  const msg = e?.data || {};
  if (presetRequestWorker.handle(msg)) return;
  if (msg.type === 'rpc_result' || msg.type === 'rpc_error') {
    const pendingItem = pending.get(msg.id);
    if (!pendingItem) return;
    pending.delete(msg.id);
    if (msg.type === 'rpc_error') pendingItem.reject(msg.error);
    else pendingItem.resolve(msg.result);
    return;
  }
  if (msg.type === 'ui_event') {
    handleCompatUiEvent(msg);
    return;
  }
  if (msg.type === 'ui_layout') {
    updateCompatUiLayouts(msg.items || [], msg.viewport || null);
    return;
  }
  if (msg.type === 'ui_viewport') {
    const changed = applyCompatViewportSnapshot(msg.viewport || {}, { dispatchResize: msg.eventType !== 'init' });
    if (changed) scheduleCompatUiFlush();
    return;
  }
  if (msg.type === 'sync') {
    // Requests arriving during async chat/regex refresh must wait until the
    // scripts have installed their middleware. Serialize overlapping reloads.
    pendingScriptSync = pendingScriptSync.catch(() => {}).then(async () => {
      const list = Array.isArray(msg.scripts) ? msg.scripts : [];
      self.fetch = guardedFetch;
      scripts.clear();
      listenedEvents.clear();
      scriptButtonHandlers.clear();
      resetCompatDocumentForSync();
      postMessage({ type: 'ui_reset' });
      if (msg.settings && typeof msg.settings === 'object') {
        currentSettings = { ...currentSettings, ...msg.settings };
      }
      if (msg.context && typeof msg.context === 'object') {
        currentContext = { ...currentContext, ...msg.context };
      }
      ensureCompatGlobals();
      await refreshSillyTavernChat();
      await refreshTavernRegexes();
      list.forEach(item => {
        const record = { ...item };
        record.enabled = item.enabled === true;
        scripts.set(record.id, compileScript(record));
      });
      postMessage({ type: 'sync_done' });
      scheduleCompatUiFlush();
    });
    await pendingScriptSync;
    return;
  }
  if (msg.type === 'context') {
    if (msg.context && typeof msg.context === 'object') {
      currentContext = { ...currentContext, ...msg.context };
    }
    if (msg.settings && typeof msg.settings === 'object') {
      currentSettings = { ...currentSettings, ...msg.settings };
    }
    ensureCompatGlobals();
    scheduleCompatUiFlush();
    return;
  }
  if (msg.type === 'dispatch') {
    const evt = String(msg.event || '').trim();
    if (!evt) {
      postMessage({ type: 'dispatch_result', id: msg.id, result: msg.payload });
      return;
    }
    const allowMutate = msg.allowMutate !== false;
    try {
      const result = await dispatchEvent(evt, msg.payload, allowMutate);
      if (estimateSize(result) > DISPATCH_RESULT_LIMIT) {
        throw new Error('脚本结果过大');
      }
      postMessage({ type: 'dispatch_result', id: msg.id, result });
    } catch (err) {
      postMessage({ type: 'dispatch_error', id: msg.id, error: String(err?.message || err || 'unknown error') });
    }
  }
};
`;

export const buildScriptRuntimeWorkerSourceForTests = buildWorkerScript;

const clonePlain = (value) => {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
};

const normalizeScriptWorldEntry = (entry = {}, index = 0) => {
  const id = String(entry.id ?? entry.uid ?? `entry-${index}`);
  const name = String(entry.name || entry.comment || entry.title || id || `Entry ${index + 1}`);
  return {
    ...clonePlain(entry),
    uid: entry.uid ?? id,
    id,
    name,
    comment: entry.comment || name,
    title: entry.title || entry.comment || name,
    content: String(entry.content || ''),
    enabled: entry.enabled !== false && entry.disable !== true,
  };
};

const toTavernRegex = (rule = {}, setId = '') => ({
  ...clonePlain(rule),
  id: String(rule.id || ''),
  script_name: String(rule.scriptName || rule.script_name || rule.name || ''),
  find_regex: String(rule.findRegex || rule.find_regex || ''),
  replace_string: String(rule.replaceString ?? rule.replace_string ?? ''),
  enabled: rule.disabled !== true && rule.enabled !== false,
  __chatappSetId: String(setId || ''),
});

const toPath = (key) => String(key || '').split('.').map(p => p.trim()).filter(Boolean);

const getByPath = (obj, path) => {
  let cur = obj;
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
};

const setByPath = (obj, path, value) => {
  if (!obj || typeof obj !== 'object') return obj;
  let cur = obj;
  path.forEach((part, idx) => {
    if (idx === path.length - 1) {
      cur[part] = value;
      return;
    }
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  });
  return obj;
};

const deleteByPath = (obj, path) => {
  if (!obj || typeof obj !== 'object' || !Array.isArray(path) || !path.length) return false;
  let cur = obj;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    cur = cur?.[path[idx]];
    if (!cur || typeof cur !== 'object') return false;
  }
  const last = path[path.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cur, last)) return false;
  delete cur[last];
  return true;
};

const getPromptKey = (prompt = {}, fallback = '') => {
  const candidates = [prompt.identifier, prompt.id, prompt.prompt_id, prompt.promptId, prompt.name, prompt.title, fallback];
  for (const item of candidates) {
    const value = String(item || '').trim();
    if (value) return value;
  }
  return '';
};

const findPromptOrderBlock = (preset = {}) => {
  const blocks = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
  return blocks.find(block => String(block?.character_id) === String(ST_PROMPT_ORDER_DUMMY_ID)) || blocks[0] || null;
};

const ensurePromptOrderBlock = (preset = {}) => {
  preset.prompt_order = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
  let block = findPromptOrderBlock(preset);
  if (!block) {
    block = { character_id: ST_PROMPT_ORDER_DUMMY_ID, order: [] };
    preset.prompt_order.push(block);
  }
  block.character_id = block.character_id ?? ST_PROMPT_ORDER_DUMMY_ID;
  block.order = Array.isArray(block.order) ? block.order : [];
  return block;
};

const findPresetPrompt = (preset = {}, identifier = '') => {
  const key = String(identifier || '').trim();
  if (!key) return null;
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  return prompts.find((prompt, index) => {
    const promptKey = getPromptKey(prompt, `custom_${index}`);
    return promptKey === key || String(prompt?.name || '').trim() === key || String(prompt?.title || '').trim() === key;
  }) || null;
};

const estimatePayloadSize = (value) => {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
};

const normalizeScriptCustomApiBaseUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(?:chat\/completions|models)$/i, '').replace(/\/+$/, '');
  if (!/\/v1$/i.test(path)) path = `${path}/v1`;
  url.pathname = path.replace(/^\/?/, '/');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
};

const normalizeScriptGenerationRole = (value) => {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'human') return 'user';
  if (role === 'bot' || role === 'char' || role === 'character') return 'assistant';
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'developer' || role === 'tool') {
    return role;
  }
  return 'user';
};

const toScriptGenerationMessage = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const content = entry.content ?? entry.message ?? entry.mes;
  if (content === undefined || content === null) return null;
  return {
    role: normalizeScriptGenerationRole(entry.role),
    content: String(content),
  };
};

const isEsmLikeScript = (content, compatibility = null) => {
  const text = String(content || '');
  if (!text) return false;
  // 只认语句起点的模块语法：脚本内嵌 HTML/字符串里的 `id="btn-import"`、`bam-btn-export`
  // 一类字面量不能把普通 worker 脚本改判进 iframe（iframe API 面更窄，误判会静默丢功能）。
  if (/(^|[;{}()\n])\s*import\s*(?:['"]|\{|\*|[\w$]+\s+from\s)/.test(text)) return true;
  if (/(^|[;{}()\n])\s*export\s*(?:default\s|const\s|let\s|var\s|function[\s(*]|class\s|async\s|\{|\*)/.test(text)) return true;
  if (typeof compatibility?.signals?.topLevelAwait === 'boolean') {
    return compatibility.signals.topLevelAwait;
  }
  return hasTopLevelAwait(text);
};

export const isEsmLikeScriptForTests = isEsmLikeScript;

class ScriptIframeRuntime {
  constructor(owner) {
    this.owner = owner;
    this.iframes = new Map();
    this.windowMap = new Map();
    this.context = {};
    this.settings = {};
    this.settingsSignature = '';
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    this.iframes.forEach(entry => {
      entry.iframe.remove();
    });
    this.iframes.clear();
    this.windowMap.clear();
  }

  buildIframeHtml(record, context, settings) {
    const baseHref = settings?.esmIframeBase || 'https://testingcf.jsdelivr.net/';
    const allowNetwork = settings?.allowNetwork === true;
    const csp = allowNetwork
      ? "default-src 'none'; script-src 'unsafe-inline' blob: https:; connect-src https:; img-src data: https:;"
      : "default-src 'none'; script-src 'unsafe-inline' blob:;";
    const vueUrl = settings?.esmIframeVueUrl || 'https://cdn.jsdelivr.net/npm/vue@3.5.22/dist/vue.global.prod.js';
    const vueEsmUrl = settings?.esmIframeVueEsmUrl || 'https://testingcf.jsdelivr.net/npm/vue@3.5.22/+esm';
    const lodashUrl = settings?.esmIframeLodashUrl || 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js';
    const jqueryUrl = settings?.esmIframeJqueryUrl || 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js';
    const toastrUrl = settings?.esmIframeToastrUrl || 'https://cdn.jsdelivr.net/npm/toastr@2.1.4/build/toastr.min.js';
    const zodUrl = settings?.esmIframeZodUrl || 'https://cdn.jsdelivr.net/npm/zod@3.22.4/lib/index.umd.min.js';
    const yamlUrl = settings?.esmIframeYamlUrl || 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js';
    const scriptId = String(record.id || '');
    const scriptName = String(record.name || '');
    const scriptInfo = String(record.info || '');
    const scriptScope = String(record.scope || '');
    const scriptScopeId = String(record.scopeId || '');
    const scriptData = record.data && typeof record.data === 'object' ? record.data : {};
    const content = String(record.content || '');
    const contextJson = serializeForInlineScript(context || {});
    const dataJson = serializeForInlineScript(scriptData);
    const nameJson = serializeForInlineScript(scriptName);
    const infoJson = serializeForInlineScript(scriptInfo);
    const scopeJson = serializeForInlineScript(scriptScope);
    const scopeIdJson = serializeForInlineScript(scriptScopeId);
    const scriptIdJson = serializeForInlineScript(scriptId);
    const contentJson = serializeForInlineScript(content);
    const baseJson = serializeForInlineScript(baseHref);
    const cspJson = serializeForInlineScript(csp);
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content=${cspJson} />
  <base href=${baseJson} />
</head>
<body>
${allowNetwork ? `
<script src="${lodashUrl}"></script>
<script src="${jqueryUrl}"></script>
<script src="${toastrUrl}"></script>
<script src="${zodUrl}"></script>
<script src="${yamlUrl}"></script>
<script src="${vueUrl}"></script>
<script>window.vue=window.Vue||window.vue;window.Vue=window.Vue||window.vue;var Vue=window.Vue;var vue=window.vue;</script>` : ''}
<script>
  const scriptId = ${scriptIdJson};
  const scriptName = ${nameJson};
  const scriptInfo = ${infoJson};
  const scriptScope = ${scopeJson};
  const scriptScopeId = ${scopeIdJson};
  const scriptVariableData = ${dataJson};
  let currentContext = ${contextJson};
  let currentSettings = {
    allowReadMessages: ${settings?.allowReadMessages !== false ? 'true' : 'false'},
    allowModifyVariables: ${settings?.allowModifyVariables !== false ? 'true' : 'false'},
  };
  ${buildMacroEngineRuntimeSource()}
  ${createSillyTavernMacroApi.toString()}
  const pending = new Map();
  let seq = 0;
  const handlers = new Map();
  let defaultHandler = null;
  function cloneCompat(value) {
    try { return structuredClone(value); } catch {
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    }
  }
  function normalizeCompatVariableScope(option) {
    const raw = option && typeof option === 'object'
      ? String(option.type || option.scope || option.name || '').trim().toLowerCase()
      : String(option || '').trim().toLowerCase();
    if (raw === 'global' || raw === 'world') return 'global';
    if (raw === 'preset') return 'preset';
    if (raw === 'character' || raw === 'char') return 'character';
    if (raw === 'script') return 'script';
    return 'chat';
  }
  function getCompatVariableContextKey(scope) {
    if (scope === 'global') return 'globalVariables';
    if (scope === 'preset') return 'presetVariables';
    if (scope === 'character') return 'characterVariables';
    return 'localVariables';
  }
  function getCompatBaseVariables(option) {
    const scope = normalizeCompatVariableScope(option);
    if (scope === 'script') return scriptVariableData;
    const globals = currentContext.globalVariables && typeof currentContext.globalVariables === 'object'
      ? currentContext.globalVariables
      : {};
    const locals = currentContext.localVariables && typeof currentContext.localVariables === 'object'
      ? currentContext.localVariables
      : currentContext.variables && typeof currentContext.variables === 'object'
        ? currentContext.variables
        : {};
    if (scope === 'global') return globals;
    if (scope === 'preset') {
      return currentContext.presetVariables && typeof currentContext.presetVariables === 'object'
        ? currentContext.presetVariables
        : {};
    }
    if (scope === 'character') {
      return currentContext.characterVariables && typeof currentContext.characterVariables === 'object'
        ? currentContext.characterVariables
        : {};
    }
    return locals;
  }
  function buildCompatVariablesSnapshot() {
    const globals = currentContext.globalVariables && typeof currentContext.globalVariables === 'object'
      ? currentContext.globalVariables
      : {};
    const locals = currentContext.localVariables && typeof currentContext.localVariables === 'object'
      ? currentContext.localVariables
      : currentContext.variables && typeof currentContext.variables === 'object'
        ? currentContext.variables
        : {};
    const base = currentContext.variables && typeof currentContext.variables === 'object' ? currentContext.variables : locals;
    return {
      stat_data: cloneCompat(base),
      variables: cloneCompat(base),
      status_current_variables: cloneCompat(base),
      global_variables: cloneCompat(globals),
      local_variables: cloneCompat(locals),
      preset_variables: cloneCompat(getCompatBaseVariables({ type: 'preset' })),
      character_variables: cloneCompat(getCompatBaseVariables({ type: 'character' })),
      script_variables: cloneCompat(scriptVariableData),
    };
  }
  function getVariables(option) {
    return cloneCompat(getCompatBaseVariables(option));
  }
  function getAllVariables() {
    return buildCompatVariablesSnapshot();
  }
  function setVariables(updates, option) {
    if (currentSettings.allowModifyVariables !== true) {
      callParent('log', { level: 'warn', args: ['脚本权限已禁用', '修改变量'] }).catch(() => {});
      return getVariables(option);
    }
    const scope = normalizeCompatVariableScope(option);
    const payload = updates && typeof updates === 'object' ? updates : {};
    const current = getCompatBaseVariables(option);
    const next = Object.assign({}, current, payload);
    if (scope === 'script') {
      Object.keys(scriptVariableData).forEach(key => delete scriptVariableData[key]);
      Object.assign(scriptVariableData, next);
      callParent('script.updateData', { scriptId, data: cloneCompat(scriptVariableData), scope: scriptScope, scopeId: scriptScopeId });
      return cloneCompat(scriptVariableData);
    }
    const targetKey = getCompatVariableContextKey(scope);
    currentContext[targetKey] = next;
    if (scope === 'chat') currentContext.variables = next;
    callParent('variables.patch', {
      patch: payload,
      options: { scope: scope === 'chat' ? 'local' : scope },
      sessionId: currentContext.sessionId,
      scriptId,
    }).catch(() => {});
    return cloneCompat(next);
  }
  function updateVariablesWith(updates, option) {
    if (typeof updates === 'function') {
      const next = updates(getVariables(option));
      return setVariables(next && typeof next === 'object' ? next : {}, option);
    }
    return setVariables(updates, option);
  }
  function deleteVariable(path, option) {
    if (currentSettings.allowModifyVariables !== true) {
      callParent('log', { level: 'warn', args: ['脚本权限已禁用', '修改变量'] }).catch(() => {});
      return false;
    }
    const scope = normalizeCompatVariableScope(option);
    const parts = String(path || '').split('.').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return false;
    const current = cloneCompat(getCompatBaseVariables(option)) || {};
    let cursor = current;
    for (let index = 0; index < parts.length - 1; index += 1) {
      cursor = cursor && typeof cursor === 'object' ? cursor[parts[index]] : null;
      if (!cursor || typeof cursor !== 'object') return false;
    }
    const last = parts[parts.length - 1];
    if (!Object.prototype.hasOwnProperty.call(cursor, last)) return false;
    delete cursor[last];
    if (scope === 'script') {
      Object.keys(scriptVariableData).forEach(key => delete scriptVariableData[key]);
      Object.assign(scriptVariableData, current);
      callParent('script.updateData', { scriptId, data: cloneCompat(scriptVariableData), scope: scriptScope, scopeId: scriptScopeId });
    } else {
      const targetKey = getCompatVariableContextKey(scope);
      currentContext[targetKey] = current;
      if (scope === 'chat') currentContext.variables = current;
      callParent('variables.delete', {
        key: String(path || ''),
        options: { scope: scope === 'chat' ? 'local' : scope },
        sessionId: currentContext.sessionId,
        scriptId,
      }).catch(() => {});
    }
    return true;
  }
  const legacyMacros = new Map();
  let macroCompatApi = null;
  function getMacroCompatApi() {
    if (macroCompatApi) return macroCompatApi;
    macroCompatApi = createSillyTavernMacroApi({
      MacroEngineClass: MacroEngine,
      getRuntimeContext: () => currentContext,
      getMessages: () => Array.isArray(window.SillyTavern?.chat) ? window.SillyTavern.chat : [],
      getVariables: scope => getCompatBaseVariables({ type: scope === 'global' ? 'global' : 'message' }),
      setVariable: (scope, key, value) => {
        setVariables({ [key]: value }, { type: scope === 'global' ? 'global' : 'message' });
        return true;
      },
      canReadMessages: () => currentSettings.allowReadMessages === true,
      canWriteVariables: () => currentSettings.allowModifyVariables === true,
      onWriteDenied: () => callParent('log', { level: 'warn', args: ['脚本权限已禁用', '修改变量'] }).catch(() => {}),
      getRegisteredMacros: () => legacyMacros,
    });
    return macroCompatApi;
  }
  function getContext() {
    const macros = getMacroCompatApi();
    return Object.assign({}, currentContext, buildCompatVariablesSnapshot(), {
      powerUserSettings: window.powerUserSettings || {},
      substituteParams: macros.substituteParams,
      substituteParamsExtended: macros.substituteParamsExtended,
    });
  }
  window.powerUserSettings = window.powerUserSettings || {};
  window.getVariables = window.getVariables || getVariables;
  window.getAllVariables = window.getAllVariables || getAllVariables;
  window.setVariables = window.setVariables || setVariables;
  window.updateVariablesWith = window.updateVariablesWith || updateVariablesWith;
  window.insertOrAssignVariables = window.insertOrAssignVariables || setVariables;
  window.deleteVariable = window.deleteVariable || deleteVariable;
  window.getContext = window.getContext || getContext;
  const macroApi = getMacroCompatApi();
  window.substituteParams = window.substituteParams || macroApi.substituteParams;
  window.substituteParamsExtended = window.substituteParamsExtended || macroApi.substituteParamsExtended;
  window.substitudeMacros = window.substitudeMacros || macroApi.substitudeMacros;
  try {
    Object.defineProperty(window, 'Context', {
      configurable: true,
      enumerable: true,
      get: () => window.getContext(),
    });
  } catch {
    window.Context = window.getContext();
  }
  var getVariables = window.getVariables;
  var getAllVariables = window.getAllVariables;
  var setVariables = window.setVariables;
  var updateVariablesWith = window.updateVariablesWith;
  var insertOrAssignVariables = window.insertOrAssignVariables;
  var deleteVariable = window.deleteVariable;
  var getContext = window.getContext;
  var substituteParams = window.substituteParams;
  var substituteParamsExtended = window.substituteParamsExtended;
  var substitudeMacros = window.substitudeMacros;
  var Context = window.Context;
  var powerUserSettings = window.powerUserSettings;
  function bridgeCompatGlobalsToHost(host) {
    try {
      if (!host || host === window) return;
      if (!host.powerUserSettings || typeof host.powerUserSettings !== 'object') host.powerUserSettings = window.powerUserSettings;
      if (typeof host.getContext !== 'function') host.getContext = () => window.getContext();
      if (typeof host.getVariables !== 'function') host.getVariables = (...args) => window.getVariables(...args);
      if (typeof host.getAllVariables !== 'function') host.getAllVariables = (...args) => window.getAllVariables(...args);
      if (typeof host.setVariables !== 'function') host.setVariables = (...args) => window.setVariables(...args);
      if (typeof host.updateVariablesWith !== 'function') host.updateVariablesWith = (...args) => window.updateVariablesWith(...args);
      if (typeof host.insertOrAssignVariables !== 'function') host.insertOrAssignVariables = (...args) => window.insertOrAssignVariables(...args);
      if (typeof host.deleteVariable !== 'function') host.deleteVariable = (...args) => window.deleteVariable(...args);
      if (typeof host.substituteParams !== 'function') host.substituteParams = (...args) => window.substituteParams(...args);
      if (typeof host.substituteParamsExtended !== 'function') host.substituteParamsExtended = (...args) => window.substituteParamsExtended(...args);
      if (typeof host.substitudeMacros !== 'function') host.substitudeMacros = (...args) => window.substitudeMacros(...args);
      try {
        Object.defineProperty(host, 'Context', {
          configurable: true,
          enumerable: true,
          get: () => host.getContext(),
        });
      } catch {
        host.Context = host.getContext();
      }
    } catch {}
  }
  bridgeCompatGlobalsToHost(window.parent);
  bridgeCompatGlobalsToHost(window.top);
  function callParent(method, params) {
    const id = String(Date.now()) + '-' + (++seq);
    const payload = { type: 'script-iframe-rpc', id, scriptId, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage(payload, '*');
    });
  }
  window.addEventListener('message', (event) => {
    const msg = event && event.data ? event.data : {};
    if (msg.type === 'script-iframe-rpc-result' && msg.id) {
      const item = pending.get(msg.id);
      if (item) {
        pending.delete(msg.id);
        item.resolve(msg.result);
      }
      return;
    }
    if (msg.type === 'script-iframe-rpc-error' && msg.id) {
      const item = pending.get(msg.id);
      if (item) {
        pending.delete(msg.id);
        item.reject(msg.error);
      }
      return;
    }
    if (msg.type === 'script-iframe-context' && msg.context) {
      currentContext = Object.assign({}, currentContext, msg.context);
      if (msg.settings && typeof msg.settings === 'object') {
        currentSettings = Object.assign({}, currentSettings, msg.settings);
      }
      try { Context = window.Context; } catch {}
      return;
    }
    if (msg.type === 'script-iframe-dispatch') {
      dispatchEvent(msg.event || '', msg.payload || {}, msg.allowMutate !== false)
        .then(result => {
          parent.postMessage({ type: 'script-iframe-dispatch-result', id: msg.id, scriptId, result }, '*');
        })
        .catch(err => {
          parent.postMessage({ type: 'script-iframe-dispatch-error', id: msg.id, scriptId, error: String(err && err.message || err) }, '*');
        });
    }
  });
  function ensureArray(map, key) {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  }
  const listenedEvents = new Set();
  function notifyListener(name) {
    const eventName = String(name || '').trim();
    if (!eventName || listenedEvents.has(eventName)) return;
    listenedEvents.add(eventName);
    parent.postMessage({ type: 'script-iframe-listener', event: eventName, scriptId }, '*');
  }
  function on(event, fn) {
    const name = String(event || '').trim();
    if (!name || typeof fn !== 'function') return;
    ensureArray(handlers, name).push(fn);
    notifyListener(name);
  }
  function off(event, fn) {
    const name = String(event || '').trim();
    if (!name) return;
    if (!handlers.has(name)) return;
    if (!fn) { handlers.delete(name); return; }
    handlers.set(name, handlers.get(name).filter(item => item !== fn));
  }
  window.on = on;
  window.off = off;
  window.eventOn = on;
  window.eventRemoveListener = off;
  window.eventEmit = (event, payload) => dispatchEvent(event, payload, true);
  var eventOn = on;
  var eventRemoveListener = off;
  var eventEmit = window.eventEmit;
  var on = window.on;
  var off = window.off;
  window.tavern_events = window.tavern_events || { on, off, eventOn: on, eventRemoveListener: off };
  function bridgeEventGlobalsToHost(host) {
    try {
      if (!host || host === window) return;
      if (typeof host.eventOn !== 'function') host.eventOn = on;
      if (typeof host.eventRemoveListener !== 'function') host.eventRemoveListener = off;
      if (!host.tavern_events || typeof host.tavern_events !== 'object') {
        host.tavern_events = window.tavern_events;
      }
    } catch {}
  }
  bridgeEventGlobalsToHost(window.parent);
  bridgeEventGlobalsToHost(window.top);
  function makeDataProxy(data) {
    const base = data && typeof data === 'object' ? data : {};
    return new Proxy(base, {
      set(target, prop, value) {
        target[prop] = value;
        callParent('script.updateData', { scriptId, data: base, scope: scriptScope, scopeId: scriptScopeId });
        return true;
      },
      deleteProperty(target, prop) {
        delete target[prop];
        callParent('script.updateData', { scriptId, data: base, scope: scriptScope, scopeId: scriptScopeId });
        return true;
      },
    });
  }
  function normalizeRole(role) {
    const r = String(role || '').trim().toLowerCase();
    if (!r) return '';
    if (r === 'user' || r === 'assistant' || r === 'system') return r;
    if (r === 'any') return '';
    return r;
  }
  function messageContentToText(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const content = msg.content;
    if (Array.isArray(content)) {
      return content.map(part => part && part.type === 'text' ? String(part.text || '') : '').filter(Boolean).join('\\n');
    }
    return String(msg.raw || content || '');
  }
  function makeApi() {
    const call = (method, params) => callParent(method, Object.assign({}, params || {}, { sessionId: currentContext.sessionId, scriptId }));
    const resolveChatMessages = async () => {
      const list = await call('chat.getMessages', {});
      return Array.isArray(list) ? list : [];
    };
    return {
      getvar: (key, options = {}) => call('variables.get', { key, options }),
      setvar: (key, value, options = {}) => call('variables.set', { key, value, options }),
      incvar: (key, delta = 1, options = {}) => call('variables.inc', { key, delta, options }),
      decvar: (key, delta = 1, options = {}) => call('variables.dec', { key, delta, options }),
      getChatMessage: async (idx, role) => {
        const list = await resolveChatMessages();
        const roleFilter = normalizeRole(role);
        const filtered = roleFilter ? list.filter(m => String(m && m.role || '').trim().toLowerCase() === roleFilter) : list;
        if (!filtered.length) return '';
        let index = Number(idx);
        if (!Number.isFinite(index)) return '';
        index = Math.trunc(index);
        if (index < 0) index = filtered.length + index;
        if (index < 0 || index >= filtered.length) return '';
        return messageContentToText(filtered[index]);
      },
      getChatMessages: async (...args) => {
        const list = await resolveChatMessages();
        if (!list.length) return [];
        let start = null;
        let end = null;
        let role = '';
        if (args.length === 1) {
          start = null;
          end = Number(args[0]);
        } else if (args.length === 2) {
          if (typeof args[1] === 'string') {
            end = Number(args[0]);
            role = String(args[1] || '');
          } else {
            start = Number(args[0]);
            end = Number(args[1]);
          }
        } else if (args.length >= 3) {
          start = Number(args[0]);
          end = Number(args[1]);
          role = String(args[2] || '');
        }
        const roleFilter = normalizeRole(role);
        const filtered = roleFilter ? list.filter(m => String(m && m.role || '').trim().toLowerCase() === roleFilter) : list;
        if (!filtered.length) return [];
        if (start === null) {
          const count = Number(end);
          if (!Number.isFinite(count)) return [];
          const n = Math.max(0, Math.trunc(count));
          const slice = n === 0 ? [] : filtered.slice(-n);
          return slice.map(messageContentToText);
        }
        const s = Math.max(0, Math.trunc(Number(start) || 0));
        const eRaw = Number(end);
        const e = Number.isFinite(eRaw) ? Math.max(s, Math.trunc(eRaw)) : filtered.length;
        return filtered.slice(s, e).map(messageContentToText);
      },
      getwi: (world, title, data) => call('world.getEntry', { world, title, data }),
      activewi: (world, title, force) => call('world.activate', { world, title, force }),
      getchar: (name) => call('context.getCharacter', { name }),
      getpreset: (name) => call('context.getPreset', { name }),
      getContext: () => call('context.getContext', {}),
      getcontext: () => call('context.getContext', {}),
      log: (...args) => call('log', { level: 'log', args }),
      warn: (...args) => call('log', { level: 'warn', args }),
      error: (...args) => call('log', { level: 'error', args }),
      toast: (message, level = 'info') => call('toast', { message, level }),
    };
  }
  function buildSillyTavern() {
    const st = {};
    st.chat = [];
    st.characters = [];
    st.characterId = 0;
    st.extensionSettings = {};
    st.chatCompletionSettings = { function_calling: false };
    st.ToolManager = { isToolCallingSupported: () => false, parseToolCalls: () => {} };
    st.getRequestHeaders = () => ({});
    st.getChatCompletionModel = () => '';
    st.getCurrentChatId = () => String(currentContext.sessionId || '');
    st.getContext = getContext;
    st.substituteParams = macroApi.substituteParams;
    st.substituteParamsExtended = macroApi.substituteParamsExtended;
    st.saveChat = () => Promise.resolve(true);
    st.updateMessageBlock = () => {};
    st.saveSettingsDebounced = () => {};
    st.registerMacro = (name, fn) => {
      const key = String(name || '').trim();
      if (key && typeof fn === 'function') legacyMacros.set(key, fn);
    };
    st.unregisterMacro = name => legacyMacros.delete(String(name || '').trim());
    st.registerFunctionTool = () => {};
    st.unregisterFunctionTool = () => {};
    st.POPUP_TYPE = { TEXT: 'text', INPUT: 'input', CONFIRM: 'confirm' };
    st.POPUP_RESULT = { AFFIRMATIVE: 1, CANCELLED: 0, NEGATIVE: -1, CUSTOM1: 2 };
    st.callGenericPopup = async () => null;
    return st;
  }
  window.SillyTavern = buildSillyTavern();
  window.TavernHelper = window.TavernHelper || {
    getTavernHelperVersion: async () => '0.0.0',
  };
  window.TavernHelper.getVariables = window.TavernHelper.getVariables || getVariables;
  window.TavernHelper.getAllVariables = window.TavernHelper.getAllVariables || getAllVariables;
  window.TavernHelper.setVariables = window.TavernHelper.setVariables || setVariables;
  window.TavernHelper.updateVariablesWith = window.TavernHelper.updateVariablesWith || updateVariablesWith;
  window.TavernHelper.insertOrAssignVariables = window.TavernHelper.insertOrAssignVariables || setVariables;
  window.TavernHelper.deleteVariable = window.TavernHelper.deleteVariable || deleteVariable;
  window.TavernHelper.substituteParams = window.TavernHelper.substituteParams || macroApi.substituteParams;
  window.TavernHelper.substituteParamsExtended = window.TavernHelper.substituteParamsExtended || macroApi.substituteParamsExtended;
  window.TavernHelper.substitudeMacros = window.TavernHelper.substitudeMacros || macroApi.substitudeMacros;
  var SillyTavern = window.SillyTavern;
  var TavernHelper = window.TavernHelper;
  if (!window._ && window.lodash) window._ = window.lodash;
  window._ = window._ || { clamp: (v, l, u) => {
    const num = Number(v);
    if (!Number.isFinite(num)) return l || 0;
    if (Number.isFinite(l) && num < l) return l;
    if (Number.isFinite(u) && num > u) return u;
    return num;
  }, max: (arr) => Array.isArray(arr) ? arr.reduce((a, b) => a === undefined || b > a ? b : a, undefined) : undefined };
  var _ = window._;
  if (!window.YAML && window.jsyaml) window.YAML = window.jsyaml;
  if (!window.YAML && window.jsyaml && window.jsyaml.default) window.YAML = window.jsyaml.default;
  if (!window.z) {
    const candidate = window.Zod || window.zod;
    if (candidate && candidate.z) window.z = candidate.z;
    else if (candidate) window.z = candidate;
  }
  if (window.z && !window.z.z) window.z.z = window.z;
  window.$ = window.$ || function(handler) { if (typeof handler === 'function') { try { handler(); } catch {} } return { on: () => {}, ready: (cb) => { if (cb) cb(); } }; };
  var $ = window.$;
  window.toastr = window.toastr || {
    info: (msg, title) => callParent('toast', { message: String(msg || title || ''), level: 'info' }),
    warning: (msg, title) => callParent('toast', { message: String(msg || title || ''), level: 'warning' }),
    warn: (msg, title) => callParent('toast', { message: String(msg || title || ''), level: 'warning' }),
    error: (msg, title) => callParent('toast', { message: String(msg || title || ''), level: 'error' }),
  };
  var toastr = window.toastr;
  const apiRef = makeApi();
  var api = apiRef;
  const scriptRef = { id: scriptId, name: scriptName, info: scriptInfo, scope: scriptScope, scopeId: scriptScopeId, data: makeDataProxy(scriptVariableData) };
  var script = scriptRef;
  window.__chatappScript = scriptRef;
  window.__chatappApi = apiRef;
  window.api = apiRef;
  window.script = scriptRef;
  async function refreshSillyTavernChat() {
    if (currentSettings.allowReadMessages !== true) {
      window.SillyTavern.chat = [];
      callParent('log', { level: 'warn', args: ['脚本权限已禁用', '读取消息'] }).catch(() => {});
      return;
    }
    try {
      const list = await callParent('chat.getMessages', { sessionId: currentContext.sessionId });
      if (Array.isArray(list)) {
        window.SillyTavern.chat = list;
      }
    } catch {}
  }
  async function dispatchEvent(eventName, payload, allowMutate) {
    await refreshSillyTavernChat();
    const base = payload && typeof payload === 'object' ? Object.assign({}, payload) : { value: payload };
    let data = payload;
    const handlerPayload = Object.assign({}, base, { event: eventName });
    Object.defineProperties(handlerPayload, {
      context: { value: currentContext, enumerable: false, configurable: true },
      api: { value: api, enumerable: false, configurable: true },
      script: { value: script, enumerable: false, configurable: true },
    });
    const list = handlers.get(eventName) || handlers.get('*') || [];
    const all = list.slice();
    if (!all.length && typeof defaultHandler === 'function') all.push(defaultHandler);
    for (const fn of all) {
      const res = await fn(handlerPayload);
      if (allowMutate && res && typeof res === 'object') data = res;
    }
    return data;
  }
  window.__chatappSetDefault = (fn) => { defaultHandler = fn; };
</script>
<script type="module">
  try {
    const allowNetwork = ${allowNetwork ? 'true' : 'false'};
    if (!window.Vue && allowNetwork) {
      try {
        const mod = await import(${serializeForInlineScript(vueEsmUrl)});
        const resolved = mod?.default && mod.default.createApp ? mod.default : mod;
        if (resolved) {
          window.Vue = resolved;
          window.vue = resolved;
        }
      } catch (err) {
        parent.postMessage({ type: 'script-iframe-error', scriptId: ${scriptIdJson}, error: 'vue load failed: ' + String(err && err.message || err) }, '*');
      }
    }
    const blob = new Blob([${contentJson}], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const mod = await import(url);
    if (mod && typeof mod.default === 'function') {
      window.__chatappSetDefault(mod.default);
    }
  } catch (err) {
    parent.postMessage({ type: 'script-iframe-error', scriptId: ${scriptIdJson}, error: String(err && err.message || err) }, '*');
  }
</script>
</body>
</html>`;
  }

  getSettingsSignature(settings = {}) {
    const pick = (value) => (value == null ? '' : String(value));
    return JSON.stringify({
      allowNetwork: settings?.allowNetwork === true,
      base: pick(settings?.esmIframeBase),
      vue: pick(settings?.esmIframeVueUrl),
      lodash: pick(settings?.esmIframeLodashUrl),
      jquery: pick(settings?.esmIframeJqueryUrl),
      toastr: pick(settings?.esmIframeToastrUrl),
      zod: pick(settings?.esmIframeZodUrl),
      yaml: pick(settings?.esmIframeYamlUrl),
    });
  }

  syncScripts(list = [], context = {}, settings = {}) {
    this.context = context || {};
    this.settings = settings || {};
    this.settingsSignature = this.getSettingsSignature(this.settings);
    const seen = new Set();
    list.forEach((record) => {
      const id = String(record?.id || '').trim();
      if (!id) return;
      seen.add(id);
      const existing = this.iframes.get(id);
      if (
        existing &&
        existing.record?.content === record.content &&
        existing.record?.enabled === record.enabled &&
        existing.settingsSignature === this.settingsSignature
      ) {
        existing.record = record;
        return;
      }
      if (existing) {
        existing.iframe.remove();
        this.windowMap.delete(existing.iframe.contentWindow);
      }
      if (!record.enabled) {
        this.iframes.delete(id);
        return;
      }
      // schemaOnly 脚本不创建 iframe（Schema 已在导入时静态解析）
      if (record.schemaOnly === true) {
        this.iframes.delete(id);
        return;
      }
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.srcdoc = this.buildIframeHtml(record, this.context, this.settings);
      document.body.appendChild(iframe);
      const entry = { iframe, record, settingsSignature: this.settingsSignature };
      this.iframes.set(id, entry);
      if (iframe.contentWindow) this.windowMap.set(iframe.contentWindow, id);
    });
    this.iframes.forEach((entry, id) => {
      if (!seen.has(id)) {
        entry.iframe.remove();
        this.windowMap.delete(entry.iframe.contentWindow);
        this.iframes.delete(id);
      }
    });
  }

  syncContext(context = {}, settings = {}) {
    this.context = context || this.context;
    this.settings = settings || this.settings;
    this.iframes.forEach((entry) => {
      entry.iframe.contentWindow?.postMessage({ type: 'script-iframe-context', context: this.context, settings: this.settings }, '*');
    });
  }

  async dispatchEvent(event, payload, allowMutate = true) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.iframes.forEach((entry) => {
      entry.iframe.contentWindow?.postMessage({ type: 'script-iframe-dispatch', id, event, payload, allowMutate }, '*');
    });
    return payload;
  }

  async onMessage(e) {
    const msg = e?.data || {};
    if (!msg || typeof msg !== 'object') return;
    const sourceScriptId = String(this.windowMap.get(e?.source) || '').trim();
    const claimedScriptId = String(msg.scriptId || '').trim();
    if (!sourceScriptId || !claimedScriptId || claimedScriptId !== sourceScriptId) return;
    if (msg.type === 'script-iframe-listener') {
      this.owner.recordListener?.(msg.event);
      return;
    }
    if (msg.type === 'script-iframe-rpc') {
      try {
        const result = await this.owner.processRpc(msg.method, msg.params || {});
        e.source?.postMessage({ type: 'script-iframe-rpc-result', id: msg.id, result }, '*');
      } catch (err) {
        e.source?.postMessage({ type: 'script-iframe-rpc-error', id: msg.id, error: String(err?.message || err) }, '*');
      }
      return;
    }
    if (msg.type === 'script-iframe-error') {
      const record = this.iframes.get(sourceScriptId)?.record || {};
      this.owner.reportScriptRuntimeError?.({
        phase: 'load',
        scriptId: sourceScriptId,
        scriptName: record.name || '',
        error: String(msg.error || 'script iframe error'),
        compatibility: resolveScriptCompatibility(record),
      });
    }
  }
}

export class ScriptRuntime {
  constructor(store) {
    this.store = store;
    this.worker = null;
    this.iframeRuntime = new ScriptIframeRuntime(this);
    this.pending = new Map();
    this.presetRequestTransport = new PresetRequestTransport({
      post: value => this.worker?.postMessage(value),
      onTimeout: () => this.restartWorker('预设请求处理超时，脚本运行器已重启'),
    });
    this.variableScopeWriteQueues = new Map();
    this.presetSettingsWriteQueues = new Map();
    this.scriptGenerations = new Map();
    this.seq = 0;
    this.oneTimeScripts = new Map();
    this.listenerEvents = new Set();
    this.uiRoot = null;
    this.uiShadow = null;
    this.uiEventHandler = null;
    this.uiGlobalEventHandler = null;
    this.uiViewportHandler = null;
    this.uiCaptureActive = false;
    this.uiCaptureKinds = { pointer: false, mouse: false, touch: false, drag: false };
    this.uiGlobalEventsSeen = new WeakSet();
    this.uiDraggingActive = false;
    this.uiClickGuardActive = false;
    this.uiClickGuardTimer = 0;
    this.uiPointerStart = null;
    this.pendingWorkerUiPayload = null;
    this.pendingWorkerUiPerf = null;
    this.pendingWorkerUiNativeStateRevision = 0;
    this.uiRenderTimer = 0;
    this.uiLayoutTimer = 0;
    this.uiViewportTimer = 0;
    this.uiLayoutInterestIds = new Set();
    this.uiLayoutPendingIds = new Set();
    this.uiHasRendered = false;
    this.uiNativeStateRevision = 0;
    this.uiNativeStatePending = new Map();
    this.uiComposingNodeIds = new Set();
    this.uiPerformanceSamples = [];
    // worker 预热期（脚本编译中）：dispatch 超时放宽，避免大脚本冷启动触发超时重启风暴。
    this.workerWarmingUp = false;
    // 酒馆脚本 prompt 注入表：sessionId -> Map(entryKey -> block)；脚本每次 sync 全量重跑，表随 sync 清空。
    this.scriptPromptInjections = new Map();
    this.scriptDiagnosticSignatures = new Map();
    this.scriptDiagnosticRevisions = new Map();
    this.context = {
      sessionId: '',
      personaId: '',
      presetId: '',
      presetIds: [],
      worldId: '',
      worldIds: [],
    };
    this.bridge = null;
    this.chatStore = null;
    this.contactsStore = null;
    this.getEffectivePersona = null;
    this.getActiveUserProfile = null;
    this.presets = null;
    this.ready = this.init();
    window.addEventListener('scripts-changed', () => {
      this.syncScripts().catch(() => {});
    });
    window.addEventListener('app-settings-changed', (event) => {
      const key = String(event?.detail?.key || '');
      if (!key || !key.startsWith('script')) return;
      this.syncScripts().catch(() => {});
    });
  }

  ensureUiRoot() {
    if (typeof document === 'undefined' || !document.body) return null;
    if (this.uiRoot?.isConnected && this.uiShadow) return this.uiShadow;
    const root = document.getElementById('chatapp-script-virtual-ui-root') || document.createElement('div');
    root.id = 'chatapp-script-virtual-ui-root';
    root.setAttribute('data-chatapp-script-ui-root', 'true');
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.zIndex = '2147483000';
    root.style.pointerEvents = 'none';
    root.style.width = '100vw';
    root.style.height = '100vh';
    root.style.overflow = 'visible';
    if (!root.parentNode) document.body.appendChild(root);
    this.uiRoot = root;
    this.uiShadow = root.shadowRoot || root.attachShadow?.({ mode: 'open' }) || root;
    if (!this.uiEventHandler) this.uiEventHandler = (event) => this.handleUiEvent(event);
    if (!this.uiShadow.__chatappScriptUiEvents) {
      [
        'click',
        'dblclick',
        'mousedown',
        'mouseup',
        'mousemove',
        'pointerdown',
        'pointerup',
        'pointercancel',
        'pointermove',
        'touchstart',
        'touchmove',
        'touchend',
        'touchcancel',
        'dragstart',
        'drag',
        'dragend',
        'dragenter',
        'dragover',
        'dragleave',
        'drop',
        'keydown',
        'keyup',
        'input',
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'change',
        'toggle',
        'submit',
      ].forEach(type => {
        this.uiShadow.addEventListener?.(type, this.uiEventHandler, true);
      });
      this.uiShadow.__chatappScriptUiEvents = true;
    }
    this.installGlobalUiEventHandlers();
    this.installViewportSyncHandlers();
    return this.uiShadow;
  }

  installGlobalUiEventHandlers() {
    if (this.uiGlobalEventHandler || typeof document === 'undefined') return;
    this.uiGlobalEventHandler = (event) => this.handleGlobalUiEvent(event);
    [
      'mousemove',
      'mouseup',
      'pointermove',
      'pointerup',
      'pointercancel',
      'touchmove',
      'touchend',
      'touchcancel',
      'drag',
      'dragover',
      'dragend',
      'drop',
    ].forEach(type => {
      document.addEventListener?.(type, this.uiGlobalEventHandler, true);
      window.addEventListener?.(type, this.uiGlobalEventHandler, true);
    });
    window.addEventListener?.('blur', () => {
      this.cancelUiPointerSequence();
    }, true);
  }

  installViewportSyncHandlers() {
    if (this.uiViewportHandler || typeof window === 'undefined') return;
    this.uiViewportHandler = (event) => this.scheduleWorkerViewportSync(event?.type || 'resize');
    window.addEventListener?.('resize', this.uiViewportHandler, true);
    window.addEventListener?.('orientationchange', this.uiViewportHandler, true);
    window.visualViewport?.addEventListener?.('resize', this.uiViewportHandler, true);
    window.visualViewport?.addEventListener?.('scroll', this.uiViewportHandler, true);
    this.postWorkerViewport('init');
  }

  clearWorkerUi() {
    if (this.uiRenderTimer) {
      try {
        cancelAnimationFrame(this.uiRenderTimer);
      } catch {}
      try {
        clearTimeout(this.uiRenderTimer);
      } catch {}
      this.uiRenderTimer = 0;
    }
    if (this.uiLayoutTimer) {
      try {
        cancelAnimationFrame(this.uiLayoutTimer);
      } catch {}
      try {
        clearTimeout(this.uiLayoutTimer);
      } catch {}
      this.uiLayoutTimer = 0;
    }
    if (this.uiViewportTimer) {
      try {
        cancelAnimationFrame(this.uiViewportTimer);
      } catch {}
      try {
        clearTimeout(this.uiViewportTimer);
      } catch {}
      this.uiViewportTimer = 0;
    }
    this.uiCaptureActive = false;
    this.uiCaptureKinds = { pointer: false, mouse: false, touch: false, drag: false };
    this.uiGlobalEventsSeen = new WeakSet();
    this.uiDraggingActive = false;
    this.uiClickGuardActive = false;
    this.uiPointerStart = null;
    this.pendingWorkerUiPayload = null;
    this.pendingWorkerUiPerf = null;
    this.pendingWorkerUiNativeStateRevision = 0;
    this.uiLayoutInterestIds.clear();
    this.uiLayoutPendingIds.clear();
    this.uiHasRendered = false;
    this.uiNativeStateRevision = 0;
    this.uiNativeStatePending.clear();
    this.uiComposingNodeIds.clear();
    if (this.uiClickGuardTimer) {
      clearTimeout(this.uiClickGuardTimer);
      this.uiClickGuardTimer = 0;
    }
    try {
      this.uiShadow?.replaceChildren?.();
    } catch {}
    try {
      this.uiRoot?.remove?.();
    } catch {}
    this.uiRoot = null;
    this.uiShadow = null;
  }

  getUiPerformanceNow() {
    try {
      return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    } catch {
      return Date.now();
    }
  }

  recordUiPerformanceSample(sample = {}) {
    const type = String(sample.type || '').trim();
    if (!type) return;
    const entry = {
      ...sample,
      type,
      durationMs: Math.max(0, Number(sample.durationMs || 0) || 0),
      at: Date.now(),
    };
    this.uiPerformanceSamples.push(entry);
    if (this.uiPerformanceSamples.length > 60) {
      this.uiPerformanceSamples.splice(0, this.uiPerformanceSamples.length - 60);
    }
  }

  getUiPerformanceSnapshot() {
    const samples = this.uiPerformanceSamples.map(item => ({ ...item }));
    const latest = {};
    const summary = {};
    samples.forEach((sample) => {
      latest[sample.type] = sample;
      const bucket = summary[sample.type] || { count: 0, totalMs: 0, maxMs: 0 };
      bucket.count += 1;
      bucket.totalMs += sample.durationMs;
      bucket.maxMs = Math.max(bucket.maxMs, sample.durationMs);
      summary[sample.type] = bucket;
    });
    Object.values(summary).forEach((bucket) => {
      bucket.averageMs = bucket.count ? bucket.totalMs / bucket.count : 0;
      delete bucket.totalMs;
    });
    return { samples, latest, summary };
  }

  collectWorkerUiLayout({ full = false, nodeIds = [] } = {}) {
    const shadow = this.uiShadow;
    if (!shadow?.querySelectorAll) return [];
    const requestedIds = new Set([
      ...this.uiLayoutInterestIds,
      ...this.uiLayoutPendingIds,
      ...Array.from(nodeIds || []),
    ].map(item => String(item || '').trim()).filter(Boolean));
    return Array.from(shadow.querySelectorAll('[data-chatapp-virtual-node-id]')).slice(0, 1500).map((node) => {
      const nodeId = String(node.getAttribute('data-chatapp-virtual-node-id') || '');
      if (!nodeId || (!full && !requestedIds.has(nodeId))) return null;
      const rect = node.getBoundingClientRect();
      return {
        nodeId,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        clientWidth: node.clientWidth || rect.width,
        clientHeight: node.clientHeight || rect.height,
        scrollWidth: node.scrollWidth || node.clientWidth || rect.width,
        scrollHeight: node.scrollHeight || node.clientHeight || rect.height,
      };
    }).filter(Boolean);
  }

  getViewportSnapshot() {
    if (typeof window === 'undefined') {
      return {
        innerWidth: 1024,
        innerHeight: 768,
        outerWidth: 1024,
        outerHeight: 768,
        devicePixelRatio: 1,
        screen: { width: 1024, height: 768, availWidth: 1024, availHeight: 768 },
        visualViewport: { width: 1024, height: 768, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 },
      };
    }
    const docElement = typeof document !== 'undefined' ? document.documentElement : null;
    const fallbackWidth = Number(docElement?.clientWidth || 1024) || 1024;
    const fallbackHeight = Number(docElement?.clientHeight || 768) || 768;
    const visualViewport = window.visualViewport;
    return {
      innerWidth: Number(window.innerWidth || fallbackWidth) || fallbackWidth,
      innerHeight: Number(window.innerHeight || fallbackHeight) || fallbackHeight,
      outerWidth: Number(window.outerWidth || window.innerWidth || fallbackWidth) || fallbackWidth,
      outerHeight: Number(window.outerHeight || window.innerHeight || fallbackHeight) || fallbackHeight,
      devicePixelRatio: Number(window.devicePixelRatio || 1) || 1,
      screen: {
        width: Number(window.screen?.width || fallbackWidth) || fallbackWidth,
        height: Number(window.screen?.height || fallbackHeight) || fallbackHeight,
        availWidth: Number(window.screen?.availWidth || window.screen?.width || fallbackWidth) || fallbackWidth,
        availHeight: Number(window.screen?.availHeight || window.screen?.height || fallbackHeight) || fallbackHeight,
      },
      visualViewport: {
        width: Number(visualViewport?.width || window.innerWidth || fallbackWidth) || fallbackWidth,
        height: Number(visualViewport?.height || window.innerHeight || fallbackHeight) || fallbackHeight,
        offsetLeft: Number(visualViewport?.offsetLeft || 0) || 0,
        offsetTop: Number(visualViewport?.offsetTop || 0) || 0,
        pageLeft: Number(visualViewport?.pageLeft || 0) || 0,
        pageTop: Number(visualViewport?.pageTop || 0) || 0,
        scale: Number(visualViewport?.scale || 1) || 1,
      },
    };
  }

  postWorkerUiLayout({ full = false, nodeIds = [] } = {}) {
    if (!this.worker) return;
    const startedAt = this.getUiPerformanceNow();
    const items = this.collectWorkerUiLayout({ full, nodeIds });
    this.worker.postMessage({ type: 'ui_layout', items, viewport: this.getViewportSnapshot() });
    this.uiLayoutPendingIds.clear();
    this.recordUiPerformanceSample({
      type: 'layout',
      durationMs: this.getUiPerformanceNow() - startedAt,
      nodeCount: items.length,
      full: full === true,
    });
  }

  scheduleWorkerUiLayoutSync({ nodeIds = [] } = {}) {
    Array.from(nodeIds || []).forEach((nodeId) => {
      const id = String(nodeId || '').trim();
      if (id) this.uiLayoutPendingIds.add(id);
    });
    if (this.uiLayoutTimer) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    this.uiLayoutTimer = schedule(() => {
      this.uiLayoutTimer = 0;
      this.postWorkerUiLayout();
    });
  }

  postWorkerViewport(eventType = 'resize') {
    if (!this.worker) return;
    this.worker.postMessage({
      type: 'ui_viewport',
      eventType,
      viewport: this.getViewportSnapshot(),
    });
  }

  scheduleWorkerViewportSync(eventType = 'resize') {
    if (this.uiViewportTimer) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    this.uiViewportTimer = schedule(() => {
      this.uiViewportTimer = 0;
      this.postWorkerViewport(eventType);
      this.postWorkerUiLayout();
    });
  }

  getUiEventPoint(event) {
    const touch = event?.changedTouches?.[0] || event?.touches?.[0] || event?.targetTouches?.[0] || null;
    if (touch) return { x: Number(touch.clientX || 0) || 0, y: Number(touch.clientY || 0) || 0 };
    if (typeof event?.clientX === 'number' || typeof event?.clientY === 'number') {
      return { x: Number(event.clientX || 0) || 0, y: Number(event.clientY || 0) || 0 };
    }
    return null;
  }

  getUiCaptureKind(eventType = '') {
    const type = String(eventType || '').toLowerCase();
    if (type.startsWith('pointer')) return 'pointer';
    if (type.startsWith('mouse')) return 'mouse';
    if (type.startsWith('touch')) return 'touch';
    if (type.startsWith('drag') || type === 'drop') return 'drag';
    return '';
  }

  refreshUiCaptureActive() {
    this.uiCaptureActive = Object.values(this.uiCaptureKinds || {}).some(Boolean);
    return this.uiCaptureActive;
  }

  beginUiPointerSequence(event) {
    const wasActive = this.uiCaptureActive;
    const kind = this.getUiCaptureKind(event?.type);
    if (kind) this.uiCaptureKinds[kind] = true;
    this.refreshUiCaptureActive();
    if (!wasActive) this.uiDraggingActive = false;
    this.uiClickGuardActive = true;
    if (!this.uiPointerStart || !wasActive) this.uiPointerStart = this.getUiEventPoint(event);
    if (this.uiClickGuardTimer) {
      clearTimeout(this.uiClickGuardTimer);
      this.uiClickGuardTimer = 0;
    }
  }

  updateUiPointerSequence(event) {
    if (!this.uiCaptureActive || this.uiDraggingActive) return;
    const point = this.getUiEventPoint(event);
    const start = this.uiPointerStart;
    if (!point || !start) return;
    if (Math.abs(point.x - start.x) < 4 && Math.abs(point.y - start.y) < 4) return;
    this.uiDraggingActive = true;
    this.uiClickGuardActive = false;
    this.flushDeferredWorkerUi();
  }

  endUiPointerSequence(event = {}) {
    const type = String(event?.type || '').toLowerCase();
    const kind = this.getUiCaptureKind(type);
    if (type === 'pointercancel') {
      this.uiCaptureKinds.pointer = false;
      this.uiCaptureKinds.mouse = false;
    } else if (type === 'touchcancel') {
      this.uiCaptureKinds.touch = false;
      this.uiCaptureKinds.pointer = false;
    } else if (type === 'dragend' || type === 'drop') {
      Object.keys(this.uiCaptureKinds).forEach(key => { this.uiCaptureKinds[key] = false; });
    } else if (kind) {
      this.uiCaptureKinds[kind] = false;
    }
    if (this.refreshUiCaptureActive()) return false;
    if (this.uiDraggingActive) {
      this.uiDraggingActive = false;
      this.uiClickGuardActive = false;
      this.uiPointerStart = null;
      this.flushDeferredWorkerUi();
      return true;
    }
    this.uiClickGuardActive = true;
    if (this.uiClickGuardTimer) clearTimeout(this.uiClickGuardTimer);
    this.uiClickGuardTimer = setTimeout(() => {
      this.uiClickGuardTimer = 0;
      this.uiClickGuardActive = false;
      this.uiPointerStart = null;
      this.flushDeferredWorkerUi();
    }, 180);
    return true;
  }

  cancelUiPointerSequence() {
    const activeKinds = { ...(this.uiCaptureKinds || {}) };
    const terminalEvents = [];
    if (activeKinds.pointer) terminalEvents.push('pointercancel');
    if (activeKinds.mouse) terminalEvents.push('mouseup');
    if (activeKinds.touch) terminalEvents.push('touchcancel');
    if (activeKinds.drag) terminalEvents.push('dragend');
    terminalEvents.forEach((eventType) => {
      this.worker?.postMessage({
        type: 'ui_event',
        targetType: 'document',
        eventType,
        event: { type: eventType, bubbles: true, cancelable: false, buttons: 0 },
      });
    });
    Object.keys(this.uiCaptureKinds).forEach(key => { this.uiCaptureKinds[key] = false; });
    this.uiCaptureActive = false;
    this.uiDraggingActive = false;
    this.uiClickGuardActive = false;
    this.uiPointerStart = null;
    if (this.uiClickGuardTimer) {
      clearTimeout(this.uiClickGuardTimer);
      this.uiClickGuardTimer = 0;
    }
    this.flushDeferredWorkerUi();
  }

  releaseUiClickGuardForClick() {
    if (!this.uiClickGuardActive) return;
    this.uiClickGuardActive = false;
    this.uiPointerStart = null;
    if (this.uiClickGuardTimer) {
      clearTimeout(this.uiClickGuardTimer);
      this.uiClickGuardTimer = 0;
    }
    this.flushDeferredWorkerUi();
  }

  shouldDeferWorkerUiRender() {
    return this.uiClickGuardActive && !this.uiDraggingActive;
  }

  schedulePendingWorkerUiRender() {
    if (this.uiRenderTimer || !this.pendingWorkerUiPayload || this.shouldDeferWorkerUiRender()) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    this.uiRenderTimer = schedule(() => {
      this.uiRenderTimer = 0;
      if (!this.pendingWorkerUiPayload || this.shouldDeferWorkerUiRender()) return;
      const payload = this.pendingWorkerUiPayload;
      const perf = this.pendingWorkerUiPerf;
      const nativeStateRevision = this.pendingWorkerUiNativeStateRevision;
      this.pendingWorkerUiPayload = null;
      this.pendingWorkerUiPerf = null;
      this.pendingWorkerUiNativeStateRevision = 0;
      this.renderWorkerUi(payload, perf, nativeStateRevision);
    });
  }

  queueWorkerUiRender(payload = {}, perf = null, nativeStateRevision = 0) {
    this.pendingWorkerUiPayload = payload || {};
    this.pendingWorkerUiPerf = perf && typeof perf === 'object' ? { ...perf } : null;
    this.pendingWorkerUiNativeStateRevision = Number(nativeStateRevision || 0) || 0;
    this.schedulePendingWorkerUiRender();
  }

  flushDeferredWorkerUi() {
    if (!this.pendingWorkerUiPayload) return;
    this.schedulePendingWorkerUiRender();
  }

  getWorkerUiBaseCss() {
    return `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  width: 100vw;
  height: 100vh;
  overflow: visible;
}
.chatapp-script-ui-surface {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  width: 100vw;
  height: 100vh;
  overflow: visible;
  color-scheme: light dark;
}
.chatapp-script-ui-surface > [data-chatapp-virtual-node-id] {
  pointer-events: auto;
}
.chatapp-script-ui-surface *,
.chatapp-script-ui-surface *::before,
.chatapp-script-ui-surface *::after {
  box-sizing: border-box;
}
`.trim();
  }

  applyPendingNativeUiState(surface, workerStateRevision = 0) {
    if (!surface?.querySelectorAll || !this.uiNativeStatePending.size) return;
    const nodes = new Map(Array.from(surface.querySelectorAll('[data-chatapp-virtual-node-id]')).map(node => [
      String(node.getAttribute?.('data-chatapp-virtual-node-id') || ''),
      node,
    ]));
    Array.from(this.uiNativeStatePending.entries()).forEach(([nodeId, state]) => {
      if (Number(workerStateRevision || 0) >= Number(state?.revision || 0)) {
        this.uiNativeStatePending.delete(nodeId);
        return;
      }
      const node = nodes.get(nodeId);
      if (!node) return;
      if ('open' in (state || {}) && 'open' in node) node.open = state.open === true;
      if ('value' in (state || {}) && 'value' in node && node.type !== 'file') node.value = state.value;
      if ('checked' in (state || {}) && 'checked' in node) node.checked = state.checked === true;
    });
  }

  renderWorkerUi(payload = {}, workerPerf = null, workerStateRevision = 0) {
    const startedAt = this.getUiPerformanceNow();
    const styles = Array.isArray(payload.styles)
      ? payload.styles.map(item => String(item || '')).filter(Boolean)
      : [];
    const roots = Array.isArray(payload.roots)
      ? payload.roots.map(item => String(item || '')).filter(Boolean)
      : [];
    if (!styles.length && !roots.length) {
      this.clearWorkerUi();
      this.recordUiPerformanceSample({
        type: 'render',
        durationMs: this.getUiPerformanceNow() - startedAt,
        nodeCount: 0,
        htmlLength: 0,
        workerBuildMs: Number(workerPerf?.workerBuildMs || 0) || 0,
      });
      return;
    }
    const shadow = this.ensureUiRoot();
    if (!shadow) return;
    try {
      const next = document.createDocumentFragment();
      const baseStyle = document.createElement('style');
      baseStyle.textContent = this.getWorkerUiBaseCss();
      next.appendChild(baseStyle);
      styles.forEach((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        next.appendChild(style);
      });
      const surface = document.createElement('div');
      surface.className = 'chatapp-script-ui-surface';
      surface.innerHTML = roots.join('');
      this.applyPendingNativeUiState(surface, workerStateRevision);
      next.appendChild(surface);
      patchScriptUiChildren(shadow, next, { composing: this.uiComposingNodeIds });
      const renderedSurface = shadow.querySelector('.chatapp-script-ui-surface');
      const firstLayout = !this.uiHasRendered;
      this.uiHasRendered = true;
      this.recordUiPerformanceSample({
        type: 'render',
        durationMs: this.getUiPerformanceNow() - startedAt,
        renderedNodeCount: renderedSurface.querySelectorAll('[data-chatapp-virtual-node-id]').length,
        registeredNodeCount: Number(workerPerf?.registeredNodeCount || 0) || 0,
        htmlLength: Number(workerPerf?.htmlLength || 0) || roots.reduce((sum, item) => sum + item.length, 0),
        rootCount: roots.length,
        workerBuildMs: Number(workerPerf?.workerBuildMs || 0) || 0,
      });
      this.postWorkerUiLayout({ full: firstLayout });
      this.scheduleWorkerUiLayoutSync();
    } catch (err) {
      logger.warn('script runtime ui render failed', err);
    }
  }

  collectUiTouchList(list) {
    if (!list || typeof list.length !== 'number') return [];
    return Array.from(list).slice(0, 8).map(touch => ({
      identifier: Number(touch.identifier || 0) || 0,
      clientX: Number(touch.clientX || 0) || 0,
      clientY: Number(touch.clientY || 0) || 0,
      screenX: Number(touch.screenX || 0) || 0,
      screenY: Number(touch.screenY || 0) || 0,
      pageX: Number(touch.pageX || 0) || 0,
      pageY: Number(touch.pageY || 0) || 0,
    }));
  }

  collectUiEventPayload(event, target) {
    const payload = {
      type: event.type,
      bubbles: true,
      cancelable: event.cancelable === true,
      detail: event.detail,
      altKey: event.altKey === true,
      ctrlKey: event.ctrlKey === true,
      metaKey: event.metaKey === true,
      shiftKey: event.shiftKey === true,
    };
    [
      'key',
      'code',
      'button',
      'buttons',
      'clientX',
      'clientY',
      'screenX',
      'screenY',
      'pageX',
      'pageY',
      'offsetX',
      'offsetY',
      'pointerId',
      'pointerType',
      'isPrimary',
      'data',
      'inputType',
      'isComposing',
    ].forEach((key) => {
      if (event[key] !== undefined) payload[key] = event[key];
    });
    if (event.touches) payload.touches = this.collectUiTouchList(event.touches);
    if (event.changedTouches) payload.changedTouches = this.collectUiTouchList(event.changedTouches);
    if (event.targetTouches) payload.targetTouches = this.collectUiTouchList(event.targetTouches);
    if (target && 'value' in target) payload.value = target.value;
    if (target && 'checked' in target) payload.checked = target.checked === true;
    if (target && 'open' in target) payload.open = target.open === true;
    return payload;
  }

  collectUiLayoutPathNodeIds(target) {
    const nodeIds = [];
    let node = target;
    while (node && node !== this.uiShadow) {
      const nodeId = String(node.getAttribute?.('data-chatapp-virtual-node-id') || '').trim();
      if (nodeId && !nodeIds.includes(nodeId)) nodeIds.push(nodeId);
      node = node.parentElement || null;
    }
    return nodeIds;
  }

  handleUiEvent(event) {
    const rawTarget = event.composedPath?.()[0] || event.target;
    const target = rawTarget?.closest?.('[data-chatapp-virtual-node-id]');
    if (!target) return;
    const nodeId = String(target.getAttribute('data-chatapp-virtual-node-id') || '');
    if (!nodeId) return;
    event.stopPropagation?.();
    if (event.type === 'submit') event.preventDefault?.();
    const startsSequence = ['mousedown', 'pointerdown', 'touchstart', 'dragstart'].includes(event.type);
    const needsImmediateLayout = startsSequence && !this.uiCaptureActive;
    const layoutNodeIds = startsSequence ? this.collectUiLayoutPathNodeIds(target) : [];
    if (startsSequence) this.beginUiPointerSequence(event);
    if (['mousemove', 'pointermove', 'touchmove', 'drag'].includes(event.type)) this.updateUiPointerSequence(event);
    if (['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'dragend', 'drop'].includes(event.type)) this.endUiPointerSequence(event);
    if (['click', 'dblclick'].includes(event.type)) this.releaseUiClickGuardForClick();
    if (needsImmediateLayout) this.postWorkerUiLayout({ nodeIds: layoutNodeIds });
    else this.scheduleWorkerUiLayoutSync({ nodeIds: layoutNodeIds });
    const eventPayload = this.collectUiEventPayload(event, target);
    if (event.type === 'compositionstart') this.uiComposingNodeIds.add(nodeId);
    if (event.type === 'compositionend') this.uiComposingNodeIds.delete(nodeId);
    const traceStartedAt = ['click', 'dblclick', 'input', 'change', 'toggle', 'submit', 'keydown', 'keyup'].includes(event.type)
      ? this.getUiPerformanceNow()
      : null;
    let nativeStateRevision = 0;
    if (event.type === 'toggle' && 'open' in eventPayload) {
      nativeStateRevision = ++this.uiNativeStateRevision;
      this.uiNativeStatePending.set(nodeId, {
        revision: nativeStateRevision,
        open: eventPayload.open === true,
      });
    } else if (['input', 'change', 'compositionstart', 'compositionend'].includes(event.type) && 'value' in eventPayload) {
      nativeStateRevision = ++this.uiNativeStateRevision;
      this.uiNativeStatePending.set(nodeId, {
        revision: nativeStateRevision,
        value: eventPayload.value,
        ...('checked' in eventPayload ? { checked: eventPayload.checked } : {}),
      });
    }
    this.worker?.postMessage({
      type: 'ui_event',
      nodeId,
      eventType: event.type,
      event: eventPayload,
      nativeStateRevision,
      ...(traceStartedAt == null ? {} : { traceStartedAt }),
    });
  }

  handleGlobalUiEvent(event) {
    if (!this.uiCaptureActive) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.includes(this.uiRoot) || path.includes(this.uiShadow)) return;
    if (event && typeof event === 'object') {
      if (this.uiGlobalEventsSeen.has(event)) return;
      this.uiGlobalEventsSeen.add(event);
    }
    if (['mousemove', 'pointermove', 'touchmove', 'drag'].includes(event.type)) this.updateUiPointerSequence(event);
    this.scheduleWorkerUiLayoutSync();
    this.worker?.postMessage({
      type: 'ui_event',
      targetType: 'document',
      eventType: event.type,
      event: this.collectUiEventPayload(event, null),
    });
    if (['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'dragend', 'drop'].includes(event.type)) {
      this.endUiPointerSequence(event);
    }
  }

  recordListener(eventName) {
    const name = String(eventName || '').trim();
    if (!name) return;
    this.listenerEvents.add(name);
  }

  hasListener(eventName) {
    const name = String(eventName || '').trim();
    if (!name) return false;
    return this.listenerEvents.has(name);
  }

  async init() {
    await this.store?.ready;
    await this.syncScripts();
  }

  setContext({ bridge, chatStore, contactsStore, getEffectivePersona, getActiveUserProfile, presets } = {}) {
    this.bridge = bridge || this.bridge;
    this.chatStore = chatStore || this.chatStore;
    this.contactsStore = contactsStore || this.contactsStore;
    this.getEffectivePersona = typeof getEffectivePersona === 'function' ? getEffectivePersona : this.getEffectivePersona;
    this.getActiveUserProfile = typeof getActiveUserProfile === 'function' ? getActiveUserProfile : this.getActiveUserProfile;
    this.presets = presets || this.presets;
  }

  startWorker() {
    try {
      const blob = new Blob([buildWorkerScript()], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      this.workerWarmingUp = true;
      URL.revokeObjectURL(url);
      this.worker.onmessage = (e) => this.handleWorkerMessage(e?.data || {});
      this.worker.onerror = (err) => {
        logger.warn('script runtime worker error', err);
        emitDebugLog({
          message: `脚本运行器异常：${err?.message || 'unknown error'}`,
          type: 'warn',
          source: 'script',
        });
      };
    } catch (err) {
      logger.warn('script runtime worker init failed', err);
      this.worker = null;
    }
  }

  restartWorker(reason = '') {
    const msg = String(reason || '脚本运行器已重启');
    this.presetRequestTransport.reset(new Error(msg));
    for (const generation of this.scriptGenerations.values()) generation.controller.abort();
    this.scriptGenerations.clear();
    try {
      this.worker?.terminate?.();
    } catch {}
    this.worker = null;
    this.clearWorkerUi();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(msg));
    }
    this.pending.clear();
    emitDebugLog({ message: msg, type: 'warn', source: 'script' });
    this.startWorker();
    this.syncScripts().catch(() => {});
  }

  getSessionSettings(sessionId) {
    if (!this.chatStore?.getSessionSettings) return {};
    return this.chatStore.getSessionSettings(sessionId) || {};
  }

  async prepareCreativeRequest({ messages, options, config, presetContext, context = {},
    purpose = 'reply', presetSnapshot = null, preview = false, client }) {
    if (!isCreativePresetRequest({ presetContext, context, purpose })
      || !this.isEnabled(presetContext.sessionId) || !this.worker
      || this.presets?.state?.enabled?.openai === false) return null;
    const resolved = presetSnapshot || this.presets?.getResolvedActive?.('openai', presetContext);
    const presetId = String(resolved?.presetId || '');
    const preset = resolved?.preset || {};
    const once = this.oneTimeScripts.get(presetContext.sessionId);
    const authorized = (this.store?.getScripts?.('preset', presetId) || []).some(script =>
      (script.enabled === true && script.authorized === true) || once?.has(script.id));
    const spreset = authorized ? preset.extensions?.SPreset : null;
    const session = await this.presetRequestTransport.prepare({
      body: makePresetRequestBody(messages, options, config, Boolean(config.stream)),
      stream: Boolean(config.stream), preview, sessionId: presetContext.sessionId, presetId,
      preset: { prompts: preset.prompts || [], prompt_order: preset.prompt_order || [] },
      spreset: spreset ? clonePlain(spreset) : null,
      provider: { provider: config.provider, model: config.model },
    }, { signal: options.signal });
    if (session.bypass) return { messages, options, client, session };
    const prepared = applyPresetRequestBody(session.body, options, config);
    return { ...prepared, session,
      client: preview ? client : createPresetGenerationClient({ client, session, config }) };
  }

  isEnabled(sessionId) {
    const settings = appSettings.get();
    if (settings.scriptEnabled !== true) {
      if (sessionId && this.oneTimeScripts.get(sessionId)?.size) return true;
      return false;
    }
    if (sessionId) {
      const session = this.getSessionSettings(sessionId);
      if (typeof session.scriptEnabled === 'boolean') return session.scriptEnabled;
    }
    return true;
  }

  isVariableRuntimeEnabled(sessionId) {
    const sid = String(sessionId || this.context.sessionId || this.chatStore?.getCurrent?.() || '').trim();
    return this.bridge?.isVariableRuntimeEnabled?.(sid) !== false;
  }

  allowOnce(sessionId, scriptIds = []) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const list = Array.isArray(scriptIds) ? scriptIds : [scriptIds];
    if (!list.length) return;
    const set = this.oneTimeScripts.get(sid) || new Set();
    list.forEach(id => {
      const key = String(id || '').trim();
      if (key) set.add(key);
    });
    this.oneTimeScripts.set(sid, set);
    this.syncScripts({ sessionId: sid }).catch(() => {});
  }

  consumeOnce(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    if (!this.oneTimeScripts.has(sid)) return;
    this.oneTimeScripts.delete(sid);
    this.syncScripts({ sessionId: sid }).catch(() => {});
  }

  buildContext(sessionId) {
    const sid = String(sessionId || this.chatStore?.getCurrent?.() || this.context.sessionId || '').trim();
    const variableRuntimeEnabled = this.isVariableRuntimeEnabled(sid);
    const uiMode = sid.startsWith('rp:') ? 'rp' : 'chat';
    let personaId = '';
    let personaName = '';
    if (sid && this.getEffectivePersona) {
      const persona = this.getEffectivePersona(sid);
      personaId = String(persona?.id || '').trim();
      personaName = String(persona?.name || '').trim();
    }
    let presetId = '';
    const presetIds = [];
    const pushPresetId = (value) => {
      const id = String(value || '').trim();
      if (!id || presetIds.includes(id)) return;
      presetIds.push(id);
    };
    let resolvedOpenAI = null;
    if (this.presets?.getResolvedActiveId) {
      const presetContext = { sessionId: sid, uiMode };
      resolvedOpenAI = this.presets.getResolvedActiveId('openai', presetContext);
      const resolvedSysPrompt = this.presets.getResolvedActiveId('sysprompt', presetContext);
      const resolvedContext = this.presets.getResolvedActiveId('context', presetContext);
      const resolvedInstruct = this.presets.getResolvedActiveId('instruct', presetContext);
      const resolvedReasoning = this.presets.getResolvedActiveId('reasoning', presetContext);
      presetId = String(resolvedSysPrompt?.presetId || resolvedOpenAI?.presetId || '').trim();
      pushPresetId(resolvedOpenAI?.presetId);
      pushPresetId(resolvedSysPrompt?.presetId);
      pushPresetId(resolvedContext?.presetId);
      pushPresetId(resolvedInstruct?.presetId);
      pushPresetId(resolvedReasoning?.presetId);
    } else if (this.presets?.getState) {
      const state = this.presets.getState();
      presetId = String(state?.active?.sysprompt || state?.active?.openai || '').trim();
      pushPresetId(state?.active?.openai);
      pushPresetId(state?.active?.sysprompt);
      pushPresetId(state?.active?.context);
      pushPresetId(state?.active?.instruct);
      pushPresetId(state?.active?.reasoning);
    }
    if (!presetId && presetIds.length) presetId = presetIds[0];
    const resolvedOpenAiState = this.presets?.getResolvedActive
      ? this.presets.getResolvedActive('openai', { sessionId: sid, uiMode })
      : null;
    const resolvedWorldState = this.bridge?.getResolvedWorldState?.(sid, {
      uiMode,
    }) || null;
    const worldIds = Array.isArray(resolvedWorldState?.worldIds) && resolvedWorldState.worldIds.length
      ? resolvedWorldState.worldIds.slice()
      : (Array.isArray(this.bridge?.currentWorldIds) ? this.bridge.currentWorldIds.slice() : []);
    const worldId = String(this.bridge?.currentWorldId || worldIds[0] || '');
    const worldbookNames = Array.from(new Set([
      ...(Array.isArray(this.bridge?.worldStore?.list?.()) ? this.bridge.worldStore.list() : []),
      ...(Array.isArray(worldIds) ? worldIds : []),
      ...(worldId ? [worldId] : []),
    ].map(item => String(item || '').trim()).filter(Boolean)));
    const activeOpenAiPreset = resolvedOpenAiState?.preset || this.presets?.getActive?.('openai') || {};
    const activeOpenAiPresetId = String(resolvedOpenAiState?.presetId || resolvedOpenAI?.presetId || this.presets?.getActiveId?.('openai') || '').trim();
    const chatCompletionSettings = clonePlain(activeOpenAiPreset) || {};
    const presetView = preset => ({
      id: activeOpenAiPresetId,
      name: String(preset?.name || ''),
      ...Object.fromEntries(['temperature', 'top_p', 'top_k', 'max_tokens', 'openai_max_tokens',
        'frequency_penalty', 'presence_penalty', 'seed', 'stream_openai']
        .filter(key => preset?.[key] !== undefined).map(key => [key, preset[key]])),
      prompts: Array.isArray(preset?.prompts) ? clonePlain(preset.prompts) : [],
      prompt_order: Array.isArray(preset?.prompt_order)
        ? clonePlain(preset.prompt_order)
        : [],
      prompts_unused: Array.isArray(preset?.prompts_unused)
        ? clonePlain(preset.prompts_unused)
        : [],
    });
    const activePreset = presetView(activeOpenAiPreset);
    const inUseRegexes = this.presets?.getInUsePresetRegexOverrides?.('openai', { sessionId: sid, uiMode });
    const savedPresetRegexes = this.getPresetTavernRegexes(activeOpenAiPresetId);
    const localVariables = variableRuntimeEnabled && sid && this.chatStore?.listVariables
      ? (this.chatStore.listVariables(sid) || {})
      : {};
    const globalVariables = variableRuntimeEnabled
      ? (this.chatStore?.listGlobalVariables?.() || {})
      : {};
    const characterVariables = variableRuntimeEnabled && personaId && this.store?.getScopeVariables
      ? this.store.getScopeVariables('character', personaId)
      : {};
    const presetVariables = variableRuntimeEnabled && activeOpenAiPresetId && this.store?.getScopeVariables
      ? this.store.getScopeVariables('preset', activeOpenAiPresetId)
      : {};
    const sharedVariables = this.bridge?.isSharedVariableSession?.(sid) === true;
    const variables = sharedVariables ? globalVariables : localVariables;
    const contact = this.contactsStore?.getContact?.(sid) || null;
    const activeUser = this.getActiveUserProfile?.() || null;
    const userName = String(activeUser?.name || '').trim() || 'User';
    const characterName = String((uiMode === 'rp' ? personaName : contact?.name) || personaName || '').trim() || 'Assistant';
    const model = String(activeOpenAiPreset?.model || '').trim();
    const input = String(this.chatStore?.getDraft?.(sid) || '');
    return {
      sessionId: sid,
      uiMode,
      personaId,
      personaName,
      userName,
      characterName,
      model,
      input,
      presetId,
      presetIds,
      openaiPresetId: activeOpenAiPresetId,
      worldId,
      worldIds,
      worldbookNames,
      activePreset,
      savedPreset: inUseRegexes
        ? presetView(this.presets?.state?.presets?.openai?.[activeOpenAiPresetId] || activeOpenAiPreset) : null,
      savedPresetRegexes,
      chatCompletionSettings,
      presetPrompts: activePreset.prompts,
      presetRegexes: inUseRegexes ? this.getPresetTavernRegexes(activeOpenAiPresetId, sid) : savedPresetRegexes,
      presetName: activePreset.name,
      presetNames: Object.values(this.presets?.state?.presets?.openai || {}).map(preset => String(preset.name || '')).filter(Boolean),
      variables: clonePlain(variables) || {},
      localVariables: clonePlain(localVariables) || {},
      globalVariables: clonePlain(globalVariables) || {},
      characterVariables: clonePlain(characterVariables) || {},
      presetVariables: clonePlain(presetVariables) || {},
      sharedVariables,
      variableRuntimeEnabled,
    };
  }

  findScriptScope(scriptId) {
    const id = String(scriptId || '').trim();
    if (!id) return { scope: 'global', scopeId: 'global' };
    const globalScripts = this.store?.state?.global?.scripts || [];
    if (globalScripts.some(s => s.id === id)) return { scope: 'global', scopeId: 'global' };
    const charBuckets = this.store?.state?.character || {};
    for (const [scopeId, bucket] of Object.entries(charBuckets)) {
      if (bucket?.scripts?.some?.(s => s.id === id)) return { scope: 'character', scopeId };
    }
    const presetBuckets = this.store?.state?.preset || {};
    for (const [scopeId, bucket] of Object.entries(presetBuckets)) {
      if (bucket?.scripts?.some?.(s => s.id === id)) return { scope: 'preset', scopeId };
    }
    return { scope: 'global', scopeId: 'global' };
  }

  getCharacterRegexSets(sessionId = '') {
    const sid = String(sessionId || this.context.sessionId || this.chatStore?.getCurrent?.() || '').trim();
    const regexStore = this.bridge?.getRegexStore?.() || this.bridge?.regex || null;
    if (!regexStore) return [];
    const persona = sid && this.getEffectivePersona ? this.getEffectivePersona(sid) : null;
    const sourceSetId = String(persona?.source?.regexSetId || '').trim();
    if (sourceSetId) {
      const sourceSet = regexStore.getLocalSet?.(sourceSetId);
      if (sourceSet) return [sourceSet];
    }
    const context = this.buildContext(sid);
    const worldIds = new Set((context.worldIds || []).map(id => String(id || '').trim()).filter(Boolean));
    return (regexStore.listLocalSets?.() || []).filter((set) => {
      if (!set || set.bind?.type !== 'world') return false;
      return worldIds.has(String(set.bind.worldId || '').trim());
    });
  }

  getCharacterTavernRegexes(sessionId = '') {
    return this.getCharacterRegexSets(sessionId).flatMap((set) => (
      (Array.isArray(set?.rules) ? set.rules : []).map(rule => toTavernRegex(rule, set.id))
    ));
  }

  getPresetTavernRegexes(presetId = '', sessionId = '') {
    const id = String(presetId || '').trim();
    const regexStore = this.bridge?.getRegexStore?.() || this.bridge?.regex || null;
    if (!id || !regexStore) return [];
    const overrides = sessionId ? this.presets?.getInUsePresetRegexOverrides?.('openai', {
      sessionId, uiMode: sessionId.startsWith('rp:') ? 'rp' : 'chat',
    }) || [] : [];
    const isBoundToPreset = (set) => {
      const bind = set?.bind;
      if (!bind || bind.type !== 'preset' || String(bind.presetType || '').trim() !== 'openai') return false;
      const ids = [
        ...(Array.isArray(bind.presetIds) ? bind.presetIds : []),
        bind.presetId,
      ].map((value) => String(value || '').trim()).filter(Boolean);
      return ids.includes(id);
    };
    // 每次脚本事件都会重建上下文：先筛出绑定该预设的规则集再复制，避免整库深拷贝
    return (regexStore.listLocalSets?.(isBoundToPreset) || []).filter(isBoundToPreset).flatMap((set) => (
      (Array.isArray(set?.rules) ? set.rules : []).map(rule => {
        const override = overrides.find(item => item.__chatappSetId === set.id && item.id === rule.id);
        return toTavernRegex(override ? { ...rule, disabled: override.enabled === false } : rule, set.id);
      })
    ));
  }

  // 酒馆脚本注入表操作：写入当前 context 会话；content 为空即删除该条。
  upsertScriptPromptInjection(entryKey, block = {}) {
    const sid = String(this.context.sessionId || '').trim();
    if (!sid || !entryKey) return;
    const table = this.scriptPromptInjections.get(sid) || new Map();
    const content = String(block?.content ?? '').trim();
    if (!content) {
      table.delete(entryKey);
    } else {
      table.set(entryKey, {
        content,
        role: String(block?.role || 'system'),
        position: String(block?.position ?? ''),
        depth: Math.max(0, Math.trunc(Number(block?.depth)) || 0),
        source: 'script_prompt_injection',
      });
    }
    this.scriptPromptInjections.set(sid, table);
  }

  getScriptPromptInjections(sessionId) {
    const sid = String(sessionId || this.context.sessionId || '').trim();
    if (!sid || !this.isEnabled(sid)) return [];
    const table = this.scriptPromptInjections.get(sid);
    return table ? Array.from(table.values()) : [];
  }

  rememberScriptDiagnosticSignature(scriptId, signature) {
    const normalizedScriptId = String(scriptId || 'unknown-script').trim() || 'unknown-script';
    this.scriptDiagnosticSignatures ||= new Map();
    let signatures = this.scriptDiagnosticSignatures.get(normalizedScriptId);
    if (!signatures) {
      signatures = new Set();
      this.scriptDiagnosticSignatures.set(normalizedScriptId, signatures);
    }
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  }

  syncScriptDiagnosticRevision(record = {}) {
    const scriptId = String(record?.id || record?.scriptId || 'unknown-script').trim() || 'unknown-script';
    const revision = getScriptDiagnosticRevision(record?.content);
    this.scriptDiagnosticRevisions ||= new Map();
    const previousRevision = this.scriptDiagnosticRevisions.get(scriptId);
    if (previousRevision !== undefined && previousRevision !== revision) {
      this.scriptDiagnosticSignatures?.delete(scriptId);
    }
    this.scriptDiagnosticRevisions.set(scriptId, revision);
    return scriptId;
  }

  finishScriptDiagnosticSync(activeScriptIds = new Set()) {
    const active = activeScriptIds instanceof Set ? activeScriptIds : new Set(activeScriptIds || []);
    this.scriptDiagnosticSignatures ||= new Map();
    this.scriptDiagnosticRevisions ||= new Map();
    this.scriptDiagnosticSignatures.forEach((_signatures, scriptId) => {
      if (!active.has(scriptId)) this.scriptDiagnosticSignatures.delete(scriptId);
    });
    this.scriptDiagnosticRevisions.forEach((_revision, scriptId) => {
      if (!active.has(scriptId)) this.scriptDiagnosticRevisions.delete(scriptId);
    });
  }

  reportScriptRuntimeError(payload = {}) {
    const compatibility = payload.compatibility && typeof payload.compatibility === 'object'
      ? payload.compatibility
      : analyzeScriptCompatibility(payload.content || '');
    const diagnostic = buildScriptRuntimeErrorDiagnostic({
      scriptId: payload.scriptId,
      phase: payload.phase,
      error: payload.error,
      compatibility,
    });
    const scriptId = String(payload.scriptId || 'unknown-script').trim() || 'unknown-script';
    if (!this.rememberScriptDiagnosticSignature(scriptId, diagnostic.signature)) return false;
    const name = String(payload.scriptName || payload.scriptId || '未命名脚本');
    const error = String(payload.error || 'unknown error');
    const message = `[兼容性 ${diagnostic.signature}] ${name}：${error}${diagnostic.identifier ? `（缺失 API：${diagnostic.identifier}）` : ''}`;
    logger.warn(message);
    emitDebugLog({ message, type: 'warn', source: 'script' });
    return true;
  }

  reportBlockedScript(record, compatibility) {
    const scriptId = String(record?.id || 'unknown-script').trim() || 'unknown-script';
    const signature = `${scriptId}:preflight:blocked:${compatibility.fingerprint}`;
    if (!this.rememberScriptDiagnosticSignature(scriptId, signature)) return false;
    const name = String(record?.name || record?.id || '未命名脚本');
    const message = `[兼容性 ${signature}] ${name}：${compatibility.message}`;
    logger.warn(message);
    emitDebugLog({ message, type: 'warn', source: 'script' });
    return true;
  }

  async syncScripts(contextOverride) {
    const context = contextOverride
      ? { ...this.buildContext(contextOverride.sessionId), ...contextOverride }
      : this.buildContext();
    this.context = { ...this.context, ...context };
    this.listenerEvents.clear();
    // 脚本集变化（sync）后全量重跑，旧注入随之作废；脚本重跑时会重新注册。
    if (this.context.sessionId) this.scriptPromptInjections.delete(String(this.context.sessionId).trim());
    const settings = appSettings.get();
    const runtimeSettings = {
      allowReadMessages: settings.scriptAllowReadMessages !== false,
      allowModifyVariables: settings.scriptAllowModifyVariables !== false,
      allowNetwork: settings.scriptAllowNetwork === true,
      debugExecutionLogs: settings.debugExecutionLogs === true,
      viewport: this.getViewportSnapshot(),
    };
    if (!this.isEnabled(this.context.sessionId)) {
      if (this.worker) {
        this.worker.postMessage({
          type: 'sync',
          scripts: [],
          context: this.context,
          settings: runtimeSettings,
        });
      }
      if (this.iframeRuntime) {
        this.iframeRuntime.syncScripts([], this.context, runtimeSettings);
      }
      this.clearWorkerUi();
      this.finishScriptDiagnosticSync(new Set());
      return;
    }
    const scripts = [];
    const oneTime = this.oneTimeScripts.get(this.context.sessionId) || null;
    const seen = new Set();
    const diagnosticScriptIds = new Set();
    const push = (scope, scopeId) => {
      if (!this.store?.getScripts) return;
      const list = this.store.getScripts(scope, scopeId);
      list.forEach((s) => {
        if (!s || typeof s !== 'object') return;
        const id = String(s.id || '').trim();
        if (!id || seen.has(id)) return;
        const isActive = s.enabled === true && s.authorized === true;
        const allowOnce = oneTime && oneTime.has(id);
        if (!isActive && !allowOnce) return;
        seen.add(id);
        diagnosticScriptIds.add(this.syncScriptDiagnosticRevision(s));
        const compatibility = resolveScriptCompatibility(s);
        if (compatibility.blocked === true) {
          this.reportBlockedScript(s, compatibility);
          return;
        }
        const next = { ...s, compatibility, scope, scopeId };
        if (allowOnce) {
          next.enabled = true;
          next.authorized = true;
        }
        scripts.push(next);
      });
    };
    push('global', 'global');
    if (this.context.personaId) push('character', this.context.personaId);
    const activePresetIds = Array.isArray(this.context.presetIds)
      ? this.context.presetIds.map(id => String(id || '').trim()).filter(Boolean)
      : [];
    if (!activePresetIds.length && this.context.presetId) activePresetIds.push(String(this.context.presetId || '').trim());
    activePresetIds.forEach((id) => push('preset', id));
    this.finishScriptDiagnosticSync(diagnosticScriptIds);
    let totalSize = 0;
    const filtered = [];
    const skipped = [];
    for (const script of scripts) {
      const content = String(script?.content || '');
      const size = content.length;
      if (size > SCRIPT_MAX_BYTES) {
        skipped.push(`${script?.name || script?.id || '未命名'}（过大）`);
        continue;
      }
      if (totalSize + size > SCRIPT_TOTAL_BYTES) {
        skipped.push(`${script?.name || script?.id || '未命名'}（超出总量）`);
        continue;
      }
      totalSize += size;
      filtered.push(script);
    }
    if (skipped.length) {
      const msg = `脚本加载被限制：${skipped.join('、')}`;
      logger.warn(msg);
      emitDebugLog({ message: msg, type: 'warn', source: 'script' });
    }
    const workerScripts = [];
    const iframeScripts = [];
    filtered.forEach((script) => {
      const content = String(script?.content || '');
      if (isEsmLikeScript(content, script.compatibility)) iframeScripts.push(script);
      else workerScripts.push(script);
    });
    if (workerScripts.length && !this.worker) {
      this.startWorker();
    }
    if (this.worker) {
      this.worker.postMessage({
        type: 'sync',
        scripts: workerScripts,
        context: this.context,
        settings: runtimeSettings,
      });
    } else if (!workerScripts.length) {
      this.clearWorkerUi();
    }
    if (this.iframeRuntime) {
      this.iframeRuntime.syncScripts(iframeScripts, this.context, runtimeSettings);
    }
  }

  async syncContext(contextOverride) {
    const context = contextOverride
      ? { ...this.buildContext(contextOverride.sessionId), ...contextOverride }
      : this.buildContext();
    const next = { ...this.context, ...context };
    // Variable/prompt snapshots change during a generation. Recompiling the
    // scripts here destroys open panels, subscriptions and pending diagnostics.
    const scopeKey = value => JSON.stringify([value.sessionId, value.personaId, value.presetId,
      value.openaiPresetId, value.presetIds || []]);
    const scopeChanged = scopeKey(next) !== scopeKey(this.context);
    const presetChanged = JSON.stringify(next.activePreset) !== JSON.stringify(this.context.activePreset);
    if (this.context.sessionId && (next.sessionId !== this.context.sessionId
      || next.openaiPresetId !== this.context.openaiPresetId)) {
      this.presets?.clearInUsePreset?.('openai', this.context.sessionId);
    }
    this.context = next;
    const settings = appSettings.get();
    const runtimeSettings = {
      allowReadMessages: settings.scriptAllowReadMessages !== false,
      allowModifyVariables: settings.scriptAllowModifyVariables !== false,
      allowNetwork: settings.scriptAllowNetwork === true,
      debugExecutionLogs: settings.debugExecutionLogs === true,
      viewport: this.getViewportSnapshot(),
    };
    if (this.worker) {
      this.worker.postMessage({
        type: 'context',
        context: this.context,
        settings: runtimeSettings,
      });
    }
    if (this.iframeRuntime) {
      this.iframeRuntime.syncContext(this.context, runtimeSettings);
    }
    if (scopeChanged) {
      await this.syncScripts(this.context);
    } else if (presetChanged && this.worker && this.hasListener('preset.changed')) {
      await this.callWorker('dispatch', { event: 'preset.changed', payload: { args: [next.presetName] }, allowMutate: false });
    }
  }

  async dispatchEvent(event, payload = {}, options = {}) {
    const sessionId = String(
      options?.sessionId
      || payload?.sessionId
      || this.context.sessionId
      || this.chatStore?.getCurrent?.()
      || '',
    ).trim();
    if (!this.isEnabled(sessionId)) return payload;
    if (options?.skip === true || payload?.skipScripts === true || payload?.meta?.skipScripts === true) {
      return payload;
    }
    if (event === 'variable.changed' && !this.hasListener(event) && !this.hasListener('*')) {
      return payload;
    }
    const payloadSize = estimatePayloadSize({ event, payload });
    if (payloadSize > SCRIPT_PAYLOAD_LIMIT) {
      const msg = '脚本执行负载过大，已跳过';
      logger.warn(msg, { size: payloadSize });
      emitDebugLog({ message: msg, type: 'warn', source: 'script' });
      return payload;
    }
    await this.syncContext({ sessionId });
    const allowMutate = options.allowMutate !== false;
    let result = payload;
    if (this.worker) {
      result = await this.callWorker('dispatch', {
        event,
        payload,
        allowMutate,
      }, options.timeoutMs || 3000);
    }
    if (this.iframeRuntime) {
      this.iframeRuntime.dispatchEvent(event, result, allowMutate).catch(() => {});
    }
    return result;
  }

  callWorker(type, payload, timeoutMs = 3000) {
    if (!this.worker) return Promise.resolve(payload?.payload);
    const id = `${Date.now()}-${++this.seq}`;
    // 预热期（大脚本编译中）放宽超时，编译完成（sync_done）后恢复常规值。
    const effectiveTimeoutMs = this.workerWarmingUp ? Math.max(timeoutMs, 15000) : timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`script runtime timeout (${payload?.event || type}, ${effectiveTimeoutMs}ms)`);
        reject(err);
        this.restartWorker(`脚本执行超时（${payload?.event || type}），运行器已重启`);
      }, effectiveTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type, id, ...payload });
    });
  }

  handleWorkerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.presetRequestTransport.handle(msg)) return;
    if (msg.type === 'sync_done') {
      this.workerWarmingUp = false;
      return;
    }
    if (msg.type === 'listener_add') {
      this.recordListener(msg.event);
      return;
    }
    if (msg.type === 'ui_reset') {
      this.clearWorkerUi();
      return;
    }
    if (msg.type === 'ui_layout_interest') {
      const nodeIds = Array.isArray(msg.nodeIds) ? msg.nodeIds : [];
      nodeIds.forEach((nodeId) => {
        const id = String(nodeId || '').trim();
        if (id) this.uiLayoutInterestIds.add(id);
      });
      this.scheduleWorkerUiLayoutSync({ nodeIds });
      return;
    }
    if (msg.type === 'ui_update') {
      this.queueWorkerUiRender(msg.payload || {}, msg.perf || null, msg.nativeStateRevision || 0);
      return;
    }
    if (msg.type === 'ui_event_perf') {
      const traceStartedAt = Number(msg.traceStartedAt);
      if (!Number.isFinite(traceStartedAt)) return;
      this.recordUiPerformanceSample({
        type: 'event',
        durationMs: Math.max(0, this.getUiPerformanceNow() - traceStartedAt),
        eventType: String(msg.eventType || ''),
        workerDispatchMs: Math.max(0, Number(msg.workerDispatchMs || 0) || 0),
        workerTotalMs: Math.max(0, Number(msg.workerTotalMs || 0) || 0),
        selectorQueries: Math.max(0, Math.trunc(Number(msg.selectorQueries || 0)) || 0),
        selectorVisitedNodes: Math.max(0, Math.trunc(Number(msg.selectorVisitedNodes || 0)) || 0),
        selectorIndexHits: Math.max(0, Math.trunc(Number(msg.selectorIndexHits || 0)) || 0),
      });
      return;
    }
    if (msg.type === 'dispatch_result') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      pending.resolve(msg.result);
      return;
    }
    if (msg.type === 'dispatch_error') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      const errText = String(msg.error || 'script dispatch error');
      pending.reject(new Error(errText));
      // 只有结果过大才需要重启防护；普通派发错误已 reject，重启只会殃及其他 pending dispatch。
      if (errText.includes('脚本结果过大')) {
        this.restartWorker(`脚本派发失败（${errText}），运行器已重启`);
      } else {
        emitDebugLog({ message: `脚本派发失败：${errText}`, type: 'warn', source: 'script' });
      }
      return;
    }
    if (msg.type === 'rpc') {
      this.handleRpc(msg).catch((err) => {
        this.worker?.postMessage({ type: 'rpc_error', id: msg.id, error: String(err?.message || err) });
      });
      return;
    }
  }

  async handleRpc(msg) {
    const { id, method, params } = msg;
    const startedAt = this.getUiPerformanceNow();
    try {
      const result = await this.processRpc(method, params || {});
      this.worker?.postMessage({ type: 'rpc_result', id, result });
    } finally {
      this.recordUiPerformanceSample({
        type: 'rpc',
        durationMs: this.getUiPerformanceNow() - startedAt,
        method: String(method || ''),
      });
    }
  }

  async processRpc(method, params) {
    const settings = appSettings.get();
    const allowReadMessages = settings.scriptAllowReadMessages !== false;
    const allowModifyVariables = settings.scriptAllowModifyVariables !== false;
    const allowNetwork = settings.scriptAllowNetwork === true;
    const sessionId = String(params.sessionId || this.context.sessionId || this.chatStore?.getCurrent?.() || '').trim();
    const variableRuntimeEnabled = this.isVariableRuntimeEnabled(sessionId);
    const denyScriptPermission = (name) => {
      const error = new Error(`脚本权限已禁用：${name}`);
      error.name = 'ScriptPermissionError';
      throw error;
    };
    if (!variableRuntimeEnabled && method.startsWith('variables.')) {
      if (method === 'variables.get' || method === 'variables.inc' || method === 'variables.dec') {
        return undefined;
      }
      if (method === 'variables.getAll') return {};
      return false;
    }
    const normalizeRpcVariableScope = (value) => {
      const raw = String(value || 'local').trim().toLowerCase();
      if (raw === 'global' || raw === 'world') return 'global';
      if (raw === 'preset') return 'preset';
      if (raw === 'character' || raw === 'char') return 'character';
      return 'local';
    };
    const resolveStoredVariableScopeId = (scope) => {
      const explicit = String(params.options?.scopeId || params.scopeId || '').trim();
      if (explicit) return explicit;
      const matchesCurrent = !sessionId || String(this.context.sessionId || '') === sessionId;
      const context = matchesCurrent ? this.context : this.buildContext(sessionId);
      if (scope === 'preset') {
        return String(context.openaiPresetId || context.activePreset?.id || '').trim();
      }
      if (scope === 'character') return String(context.personaId || '').trim();
      return '';
    };
    const readStoredScopeVariables = (scope) => {
      const scopeId = resolveStoredVariableScopeId(scope);
      if (!scopeId || !this.store?.getScopeVariables) return { scopeId, variables: {} };
      return {
        scopeId,
        variables: this.store.getScopeVariables(scope, scopeId) || {},
      };
    };
    const writeStoredScopeVariables = async (scope, scopeId, variables) => {
      if (!scopeId || !this.store?.setScopeVariables) return false;
      const saved = await this.store.setScopeVariables(scope, scopeId, variables);
      const contextKey = scope === 'preset' ? 'presetVariables' : 'characterVariables';
      const currentScopeId = scope === 'preset'
        ? String(this.context.openaiPresetId || this.context.activePreset?.id || '').trim()
        : String(this.context.personaId || '').trim();
      if (scopeId === currentScopeId) this.context[contextKey] = clonePlain(variables) || {};
      return saved !== false;
    };
    const mutateStoredScopeVariables = async (scope, mutator) => {
      const scopeId = resolveStoredVariableScopeId(scope);
      if (!scopeId || !this.store?.getScopeVariables || !this.store?.setScopeVariables) return false;
      if (!this.variableScopeWriteQueues) this.variableScopeWriteQueues = new Map();
      const queueKey = `${scope}:${scopeId}`;
      const previous = this.variableScopeWriteQueues.get(queueKey) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const current = this.store.getScopeVariables(scope, scopeId) || {};
        const next = clonePlain(current) || {};
        const changed = mutator(next);
        if (changed === false) return false;
        return writeStoredScopeVariables(scope, scopeId, next);
      });
      this.variableScopeWriteQueues.set(queueKey, task);
      try {
        return await task;
      } finally {
        if (this.variableScopeWriteQueues.get(queueKey) === task) {
          this.variableScopeWriteQueues.delete(queueKey);
        }
      }
    };
    if (method === 'variables.get') {
      const key = String(params.key || '').trim();
      const scope = normalizeRpcVariableScope(params.options?.scope || params.scope);
      if (!key) return undefined;
      const path = toPath(key);
      if (!path.length) return undefined;
      if (scope === 'global') {
        const base = this.chatStore?.getGlobalVariable?.(path[0]);
        return path.length === 1 ? base : getByPath(base, path.slice(1));
      }
      if (scope === 'preset' || scope === 'character') {
        const { variables } = readStoredScopeVariables(scope);
        return getByPath(variables, path);
      }
      const base = this.chatStore?.getVariable?.(path[0], sessionId);
      return path.length === 1 ? base : getByPath(base, path.slice(1));
    }
    if (method === 'variables.set') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const key = String(params.key || '').trim();
      const scope = normalizeRpcVariableScope(params.options?.scope || params.scope);
      if (!key) return false;
      const path = toPath(key);
      if (!path.length) return false;
      if (scope === 'global') {
        if (path.length === 1) return this.chatStore?.setGlobalVariable?.(path[0], params.value);
        const base = this.chatStore?.getGlobalVariable?.(path[0]) || {};
        const next = setByPath({ ...(base && typeof base === 'object' ? base : {}) }, path.slice(1), params.value);
        return this.chatStore?.setGlobalVariable?.(path[0], next);
      }
      if (scope === 'preset' || scope === 'character') {
        return mutateStoredScopeVariables(scope, (next) => {
          setByPath(next, path, params.value);
          return true;
        });
      }
      if (path.length === 1) return this.chatStore?.setVariable?.(path[0], params.value, sessionId);
      const base = this.chatStore?.getVariable?.(path[0], sessionId) || {};
      const next = setByPath({ ...(base && typeof base === 'object' ? base : {}) }, path.slice(1), params.value);
      return this.chatStore?.setVariable?.(path[0], next, sessionId);
    }
    if (method === 'variables.delete') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const key = String(params.key || '').trim();
      const scope = normalizeRpcVariableScope(params.options?.scope || params.scope);
      if (!key) return false;
      const path = toPath(key);
      if (!path.length) return false;
      if (scope === 'global') {
        if (path.length === 1) return this.chatStore?.deleteGlobalVariable?.(path[0]) ?? false;
        const base = this.chatStore?.getGlobalVariable?.(path[0]) || {};
        if (!base || typeof base !== 'object') return false;
        const next = clonePlain(base) || {};
        const changed = deleteByPath(next, path.slice(1));
        if (!changed) return false;
        return this.chatStore?.setGlobalVariable?.(path[0], next) ?? false;
      }
      if (scope === 'preset' || scope === 'character') {
        return mutateStoredScopeVariables(scope, next => deleteByPath(next, path));
      }
      if (path.length === 1) return this.chatStore?.deleteVariable?.(path[0], sessionId) ?? false;
      const base = this.chatStore?.getVariable?.(path[0], sessionId) || {};
      if (!base || typeof base !== 'object') return false;
      const next = clonePlain(base) || {};
      const changed = deleteByPath(next, path.slice(1));
      if (!changed) return false;
      return this.chatStore?.setVariable?.(path[0], next, sessionId) ?? false;
    }
    if (method === 'variables.patch') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const scope = normalizeRpcVariableScope(params.options?.scope || params.scope);
      const patch = params.patch && typeof params.patch === 'object' ? params.patch : {};
      if (scope === 'preset' || scope === 'character') {
        return mutateStoredScopeVariables(scope, (next) => {
          let changed = false;
          Object.entries(patch).forEach(([key, value]) => {
            const path = toPath(key);
            if (!path.length) return;
            if (value === undefined) {
              changed = deleteByPath(next, path) || changed;
            } else {
              setByPath(next, path, value);
              changed = true;
            }
          });
          return changed;
        });
      }
      const results = await Promise.all(Object.entries(patch).map(([key, value]) => (
        value === undefined
          ? this.processRpc('variables.delete', { key, options: { scope }, sessionId })
          : this.processRpc('variables.set', { key, value, options: { scope }, sessionId })
      )));
      return results.some(Boolean);
    }
    if (method === 'variables.replace') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const value = params.value;
      if (!value || typeof value !== 'object' || Array.isArray(value) || estimatePayloadSize(value) > SCRIPT_PAYLOAD_LIMIT) {
        throw new Error('变量内容无效或过大');
      }
      const scope = normalizeRpcVariableScope(params.scope);
      if (scope === 'preset' || scope === 'character') return mutateStoredScopeVariables(scope, next => {
        for (const key of Object.keys(next)) delete next[key];
        Object.assign(next, clonePlain(value)); return true;
      });
      const current = scope === 'global' ? this.chatStore?.listGlobalVariables?.() : this.chatStore?.listVariables?.(sessionId);
      for (const key of Object.keys(current || {})) if (!Object.hasOwn(value, key)) {
        await this.processRpc('variables.delete', { key, scope, sessionId });
      }
      for (const [key, item] of Object.entries(value)) {
        await this.processRpc('variables.set', { key, value: item, scope, sessionId });
      }
      return true;
    }
    if (method === 'variables.inc' || method === 'variables.dec') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const key = String(params.key || '').trim();
      const delta = Number(params.delta || 1) || 0;
      const sign = method === 'variables.dec' ? -1 : 1;
      const current = await this.processRpc('variables.get', { key, options: params.options, scope: params.scope, sessionId });
      const next = (Number(current) || 0) + sign * delta;
      await this.processRpc('variables.set', { key, value: next, options: params.options, scope: params.scope, sessionId });
      return next;
    }
    if (method === 'variables.registerSchema') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const rawDefaults = params.defaults && typeof params.defaults === 'object' ? params.defaults : null;
      if (!rawDefaults) return false;
      const scope = String(params.options?.scope || params.scope || params.options?.type || '').toLowerCase();
      const useGlobal = scope === 'global';
      const defaults =
        rawDefaults.stat_data && typeof rawDefaults.stat_data === 'object'
          ? rawDefaults.stat_data
          : rawDefaults.statData && typeof rawDefaults.statData === 'object'
            ? rawDefaults.statData
            : rawDefaults;
      if (!defaults || typeof defaults !== 'object') return false;
      const isPlainObject = (val) => val && typeof val === 'object' && !Array.isArray(val);
      const mergeDeep = (base, override) => {
        const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
        if (!override || typeof override !== 'object') return out;
        Object.entries(override).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            out[key] = value.slice();
          } else if (isPlainObject(value) && isPlainObject(out[key])) {
            out[key] = mergeDeep(out[key], value);
          } else {
            out[key] = value;
          }
        });
        return out;
      };
      const deepEqual = (a, b) => {
        if (Object.is(a, b)) return true;
        if (typeof a !== typeof b) return false;
        if (Array.isArray(a)) {
          if (!Array.isArray(b) || a.length !== b.length) return false;
          return a.every((v, i) => deepEqual(v, b[i]));
        }
        if (isPlainObject(a)) {
          if (!isPlainObject(b)) return false;
          const keysA = Object.keys(a);
          const keysB = Object.keys(b);
          if (keysA.length !== keysB.length) return false;
          return keysA.every(k => deepEqual(a[k], b[k]));
        }
        return false;
      };
      const inferSchema = (name, value) => {
        let type = typeof value;
        if (Array.isArray(value)) type = 'array';
        else if (value === null) type = 'string';
        else if (type !== 'number' && type !== 'boolean' && type !== 'string' && type !== 'object') type = 'string';
        return {
          type,
          default: value,
          ui: { display: 'hidden', label: String(name || '') },
        };
      };
      const listVars = useGlobal
        ? (this.chatStore?.listGlobalVariables?.() || {})
        : (this.chatStore?.listVariables?.(sessionId) || {});
      const setVar = useGlobal
        ? (key, value) => this.chatStore?.setGlobalVariable?.(key, value)
        : (key, value) => this.chatStore?.setVariable?.(key, value, sessionId);
      Object.entries(defaults).forEach(([key, value]) => {
        const name = String(key || '').trim();
        if (!name) return;
        const existing = listVars[name];
        let next = value;
        if (isPlainObject(value) && isPlainObject(existing)) {
          next = mergeDeep(value, existing);
        } else if (existing !== undefined) {
          next = existing;
        }
        if (!deepEqual(existing, next)) {
          setVar(name, next);
          if (!useGlobal && this.chatStore?.getInitialVariable?.(name, sessionId) === undefined) {
            this.chatStore?.setInitialVariable?.(name, next, sessionId);
          }
        }
        if (!useGlobal && this.chatStore?.getVariableSchema?.(name, sessionId) == null) {
          this.chatStore?.setVariableSchema?.(name, inferSchema(name, next), sessionId);
        }
      });
      emitDebugLog({
        message: `[MVU] registerSchema applied=${Object.keys(defaults).length} scope=${useGlobal ? 'global' : 'session'} session=${sessionId || 'unknown'}`,
        type: 'info',
        source: 'script',
      });
      return true;
    }
    if (method === 'chat.getMessages') {
      if (!allowReadMessages) denyScriptPermission('读取消息');
      const list = Array.isArray(this.chatStore?.getMessages?.(sessionId))
        ? this.chatStore.getMessages(sessionId)
        : [];
      return list.map(m => ({ ...m }));
    }
    if (method === 'chat.setMessages') {
      if (!allowReadMessages) denyScriptPermission('读取/修改消息');
      if (!this.chatStore || !sessionId) return [];
      const list = Array.isArray(this.chatStore.getMessages?.(sessionId))
        ? this.chatStore.getMessages(sessionId)
        : [];
      const patches = Array.isArray(params.messages) ? params.messages : [];
      const updated = [];
      patches.forEach((patch) => {
        if (!patch || typeof patch !== 'object') return;
        const numericId = Number(patch.message_id);
        const existing = Number.isFinite(numericId)
          ? list[Math.trunc(numericId)]
          : list.find(message => String(message?.id || '') === String(patch.id || ''));
        const id = String(existing?.id || '').trim();
        if (!id) return;
        const data = {};
        if (patch.message !== undefined || patch.mes !== undefined) {
          const text = String(patch.message ?? patch.mes ?? '');
          data.raw = text;
          data.rawSource = text;
        }
        if (patch.role !== undefined) data.role = String(patch.role || existing.role || '');
        if (patch.name !== undefined) data.name = String(patch.name || '');
        if (patch.data && typeof patch.data === 'object') {
          data.meta = { ...(existing?.meta || {}), ...clonePlain(patch.data) };
        }
        if (!Object.keys(data).length) return;
        const next = this.chatStore.updateMessage(id, data, sessionId);
        if (!next) return;
        updated.push(next);
        const ui = this.bridge?.chatUI || null;
        if (ui && typeof ui.updateMessage === 'function' && this.chatStore.getCurrent?.() === sessionId) {
          ui.updateMessage(id, next);
        }
      });
      return updated;
    }
    if (method === 'chat.updateMessage') {
      if (!allowReadMessages) denyScriptPermission('读取/修改消息');
      if (!this.chatStore || !sessionId) return null;
      const id = String(params.id || '').trim();
      const data = params.data && typeof params.data === 'object' ? params.data : null;
      if (!id || !data) return null;
      const updated = this.chatStore.updateMessage(id, data, sessionId);
      const ui = this.bridge?.chatUI || null;
      if (updated && ui && typeof ui.updateMessage === 'function' && this.chatStore.getCurrent?.() === sessionId) {
        ui.updateMessage(id, updated);
      }
      return updated || null;
    }
    if (method === 'chat.reloadCurrent') {
      if (!allowReadMessages) denyScriptPermission('读取消息');
      if (!sessionId) return false;
      const list = Array.isArray(this.chatStore?.getMessages?.(sessionId))
        ? this.chatStore.getMessages(sessionId)
        : [];
      const ui = this.bridge?.chatUI || null;
      if (ui && typeof ui.preloadHistory === 'function' && this.chatStore?.getCurrent?.() === sessionId) {
        ui.preloadHistory(list, { keepScroll: true });
      }
      return true;
    }
    if (method === 'generation.stop') {
      const id = String(params.generationId || '');
      const job = this.scriptGenerations.get(id);
      if (!job || job.scriptId !== String(params.scriptId || '')) return false;
      job.controller.abort(); return true;
    }
    if (method === 'generation.generate') {
      if (!allowNetwork) denyScriptPermission('访问网络');
      const config = params.config && typeof params.config === 'object' ? params.config : {};
      if (estimatePayloadSize(config) > SCRIPT_PAYLOAD_LIMIT) throw new Error('生成请求过大');
      const id = String(config.generation_id || `script_${Date.now()}_${++this.seq}`);
      if (this.scriptGenerations.has(id)) throw new Error('生成 ID 已在使用');
      const controller = new AbortController();
      this.scriptGenerations.set(id, { controller, scriptId: String(params.scriptId || ''), sessionId });
      try { return await runScriptGeneration(this, config, sessionId, controller.signal, settings); }
      finally { this.scriptGenerations.delete(id); }
    }
    if (method === 'generation.generateRaw') {
      if (!allowNetwork) denyScriptPermission('访问网络');
      const config = params.config && typeof params.config === 'object' && !Array.isArray(params.config)
        ? params.config
        : {};
      if (estimatePayloadSize(config) > SCRIPT_PAYLOAD_LIMIT) {
        throw new Error('生成请求过大，拒绝发送');
      }
      if (config.image || (Array.isArray(config.images) && config.images.length)) {
        throw new Error('当前 generateRaw 兼容暂不支持图片输入');
      }
      const orderedPrompts = Array.isArray(config.ordered_prompts) ? config.ordered_prompts : [];
      const messages = [];
      orderedPrompts.forEach((entry) => {
        const direct = toScriptGenerationMessage(entry);
        if (direct) {
          messages.push(direct);
          return;
        }
        const builtin = String(entry || '').trim().toLowerCase();
        if (builtin === 'user_input') {
          const content = String(config.user_input || '').trim();
          if (content) messages.push({ role: 'user', content });
          return;
        }
        if (builtin !== 'chat_history') return;
        if (!allowReadMessages) denyScriptPermission('读取消息');
        const history = Array.isArray(this.chatStore?.getMessages?.(sessionId))
          ? this.chatStore.getMessages(sessionId)
          : [];
        const limit = Number.isFinite(Number(config.max_chat_history))
          ? Math.max(0, Math.trunc(Number(config.max_chat_history)))
          : history.length;
        const selectedHistory = limit > 0 ? history.slice(-limit) : [];
        selectedHistory.forEach((message) => {
          const normalized = toScriptGenerationMessage({
            role: message?.role,
            content: message?.rawSource ?? message?.raw ?? message?.message ?? message?.mes ?? message?.content,
          });
          if (normalized) messages.push(normalized);
        });
      });
      if (!messages.length) {
        const userInput = String(config.user_input || '').trim();
        if (userInput) messages.push({ role: 'user', content: userInput });
      }
      if (!messages.length) throw new Error('generateRaw 的 ordered_prompts 不能为空');
      if (estimatePayloadSize(messages) > SCRIPT_PAYLOAD_LIMIT) {
        throw new Error('生成消息过大，拒绝发送');
      }

      const customApi = config.custom_api && typeof config.custom_api === 'object' && !Array.isArray(config.custom_api)
        ? config.custom_api
        : null;
      let runtimeConfigOverride = null;
      const generationOptions = {};
      if (customApi) {
        const source = String(customApi.source || 'openai').trim().toLowerCase();
        if (source !== 'openai' && source !== 'custom') {
          throw new Error(`当前 generateRaw 不支持 custom_api.source=${source || 'unknown'}`);
        }
        const baseUrl = normalizeScriptCustomApiBaseUrl(customApi.apiurl || customApi.baseUrl || customApi.base_url);
        if (!baseUrl) throw new Error('generateRaw 的自定义 API 地址无效');
        const model = String(customApi.model || '').trim();
        runtimeConfigOverride = {
          provider: 'custom',
          baseUrl,
          apiKey: String(customApi.key || customApi.apiKey || ''),
          excludedGenerationParams: [],
          connectionMode: 'direct',
          proxyBaseUrl: '',
          proxyAuthHeaderName: '',
          proxyAuthToken: '',
          ...(model ? { model } : {}),
        };
        [
          'temperature',
          'frequency_penalty',
          'presence_penalty',
          'top_p',
          'top_k',
          'max_tokens',
          'seed',
          'n',
        ].forEach((key) => {
          const value = customApi[key];
          if (value === 'unset') {
            generationOptions[key] = undefined;
          } else if (typeof value === 'number' && Number.isFinite(value)) {
            generationOptions[key] = value;
          }
        });
      }
      if (!this.bridge?.backgroundChat) throw new Error('后台生成服务尚未就绪');
      return this.bridge.backgroundChat(messages, {
        presetContext: {
          sessionId,
          uiMode: sessionId.startsWith('rp:') ? 'rp' : 'chat',
        },
        ...(runtimeConfigOverride ? { runtimeConfigOverride } : {}),
        ...generationOptions,
      });
    }
    if (method === 'regex.getCharacter') {
      return this.getCharacterTavernRegexes(sessionId);
    }
    if (method === 'regex.replaceCharacter') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const regexStore = this.bridge?.getRegexStore?.() || this.bridge?.regex || null;
      if (!regexStore) return false;
      const incoming = Array.isArray(params.regexes) ? params.regexes : [];
      const sets = this.getCharacterRegexSets(sessionId);
      let changed = false;
      for (const set of sets) {
        const setId = String(set?.id || '').trim();
        if (!setId) continue;
        const candidates = incoming.filter((rule) => {
          const targetSetId = String(rule?.__chatappSetId || '').trim();
          return !targetSetId || targetSetId === setId;
        });
        if (!candidates.length) continue;
        const byId = new Map(candidates.map(rule => [String(rule?.id || '').trim(), rule]));
        const byName = new Map(candidates.map(rule => [String(rule?.script_name || rule?.scriptName || '').trim(), rule]));
        let setChanged = false;
        const rules = (Array.isArray(set.rules) ? set.rules : []).map((rule) => {
          const patch = byId.get(String(rule?.id || '').trim()) || byName.get(String(rule?.scriptName || '').trim());
          if (!patch) return rule;
          const disabled = patch.enabled === false;
          if (rule.disabled === disabled) return rule;
          setChanged = true;
          changed = true;
          return { ...rule, disabled };
        });
        if (setChanged) {
          await regexStore.upsertLocalSet?.({
            id: setId,
            name: set.name,
            enabled: set.manualEnabled !== false && set.enabled !== false,
            bind: set.bind,
            rules,
          });
        }
      }
      if (changed) {
        try { window.dispatchEvent(new CustomEvent('regex-changed', { detail: { sessionId } })); } catch {}
      }
      return changed;
    }
    if (method === 'ui.copyText') {
      await navigator.clipboard.writeText(String(params.text || ''));
      return true;
    }
    if (method === 'ui.confirm') {
      const content = String(params.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return typeof window?.confirm === 'function' ? window.confirm(content) : false;
    }
    if (method === 'ui.alert') {
      const message = String(params.message || '');
      if (typeof window?.alert === 'function') window.alert(message);
      else window?.toastr?.info?.(message);
      return true;
    }
    if (method === 'world.getEntry') {
      const worldId = String(params.world || this.context.worldId || '').trim();
      const title = params.title;
      const world = worldId ? this.bridge?.worldStore?.load?.(worldId) : null;
      const entries = Array.isArray(world?.entries) ? world.entries : [];
      if (!entries.length) return '';
      const find = () => {
        if (title == null || title === '') return null;
        if (title instanceof RegExp) {
          return entries.find(e => title.test(String(e?.comment || e?.title || e?.id || ''))) || null;
        }
        const raw = String(title || '').trim();
        if (!raw) return null;
        const byId = entries.find(e => String(e?.id || '').trim() === raw);
        if (byId) return byId;
        return entries.find(e => String(e?.comment || e?.title || '').trim() === raw) || null;
      };
      const entry = find();
      return String(entry?.content || '');
    }
    if (method === 'world.list') {
      const names = Array.from(new Set([
        ...(Array.isArray(this.bridge?.worldStore?.list?.()) ? this.bridge.worldStore.list() : []),
        ...(Array.isArray(this.context.worldbookNames) ? this.context.worldbookNames : []),
        ...(Array.isArray(this.context.worldIds) ? this.context.worldIds : []),
        ...(this.context.worldId ? [this.context.worldId] : []),
      ].map(item => String(item || '').trim()).filter(Boolean)));
      return names;
    }
    if (method === 'world.getBook') {
      const worldId = String(params.world || this.context.worldId || '').trim();
      if (!worldId) return [];
      const world = this.bridge?.worldStore?.load?.(worldId);
      const entries = Array.isArray(world?.entries) ? world.entries : [];
      return entries.map((entry, index) => normalizeScriptWorldEntry(entry, index));
    }
    if (method === 'world.activate') {
      const worldId = String(params.world || this.context.worldId || '').trim();
      const title = params.title;
      const force = params.force === true;
      if (!worldId) return false;
      const usesGuardedRead = typeof this.bridge?.getWorldInfo === 'function';
      const loaded = usesGuardedRead
        ? await this.bridge.getWorldInfo(worldId)
        : this.bridge?.worldStore?.load?.(worldId);
      const world = loaded ? (usesGuardedRead ? loaded : clonePlain(loaded)) : null;
      const entries = Array.isArray(world?.entries) ? world.entries : [];
      const entry = entries.find(e => String(e?.comment || e?.title || e?.id || '') === String(title || '').trim());
      if (!entry) return false;
      entry.disable = false;
      if (force) entry.constant = true;
      if (typeof this.bridge?.saveWorldInfo === 'function') {
        await this.bridge.saveWorldInfo(worldId, { ...world, entries });
      } else {
        await this.bridge?.worldStore?.save?.(worldId, { ...world, entries });
      }
      return true;
    }
    if (method === 'context.getCharacter') {
      if (this.bridge?.contextBuilder) {
        const ctx = this.bridge.contextBuilder('');
        if (ctx?.character) return ctx.character;
      }
      const name = String(params.name || this.context.personaName || '');
      return { name, description: '' };
    }
    if (method === 'context.getPreset') {
      const name = String(params.name || '');
      if (!name || name === 'in_use' || name === 'current') {
        const uiMode = sessionId.startsWith('rp:') ? 'rp' : 'chat';
        const resolvedOpenAi = this.presets?.getResolvedActive?.('openai', { sessionId, uiMode }) || null;
        const activeOpenAiPreset = resolvedOpenAi?.preset || this.presets?.getActive?.('openai') || {};
        return {
          id: String(resolvedOpenAi?.presetId || this.presets?.getActiveId?.('openai') || ''),
          name: String(activeOpenAiPreset?.name || this.context.presetName || ''),
          prompts: Array.isArray(activeOpenAiPreset?.prompts)
            ? clonePlain(activeOpenAiPreset.prompts)
            : clonePlain(this.context.presetPrompts || []),
          prompt_order: Array.isArray(activeOpenAiPreset?.prompt_order)
            ? clonePlain(activeOpenAiPreset.prompt_order)
            : [],
          prompts_unused: Array.isArray(activeOpenAiPreset?.prompts_unused)
            ? clonePlain(activeOpenAiPreset.prompts_unused)
            : [],
        };
      }
      if (!name && this.presets?.getActive) {
        const active = this.presets.getActive('sysprompt') || {};
        return { name: String(active?.name || '') };
      }
      return { name };
    }
    if (method === 'preset.getSnapshot' || method === 'preset.update') {
      const uiMode = sessionId.startsWith('rp:') ? 'rp' : 'chat';
      const name = String(params.name || 'in_use');
      const active = this.presets?.getResolvedActive?.('openai', { sessionId, uiMode });
      const stored = this.presets?.state?.presets?.openai || {};
      const matches = Object.entries(stored).filter(([id, preset]) => id === name || preset.name === name);
      const id = name === 'in_use' ? active?.presetId : matches.length === 1 ? matches[0][0] : '';
      if (!id || !stored[id]) throw new Error('预设不存在或名称重复：' + name);
      const read = () => {
        const current = name === 'in_use' ? this.presets.getResolvedActive('openai', { sessionId, uiMode })?.preset : stored[id];
        return toScriptPreset({ ...current, id }, this.getPresetTavernRegexes(id, name === 'in_use' ? sessionId : ''));
      };
      if (method === 'preset.getSnapshot') return { presetId: id, preset: read() };
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      if (String(params.presetId || '') !== id) throw new Error('预设已切换，请重新应用设置');
      if (estimatePayloadSize(params) > SCRIPT_PAYLOAD_LIMIT) throw new Error('预设修改内容过大');
      const previous = this.presetSettingsWriteQueues.get(id) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        if (name === 'in_use' && this.presets.getResolvedActive('openai', { sessionId, uiMode })?.presetId !== id) {
          throw new Error('预设已切换，请重新应用设置');
        }
        const current = read();
        const merged = mergeScriptPresetChanges(params.before, params.edited, current);
        const data = fromScriptPreset(stored[id], merged);
        const changedRules = merged.extensions?.regex_scripts || merged.regexes || [];
        const changes = changedRules.filter(rule => current.regexes.some(old => old.id === rule.id && old.enabled !== rule.enabled));
        if (name === 'in_use') {
          const savedRules = this.getPresetTavernRegexes(id);
          const overrides = changedRules.filter(rule => savedRules.some(saved => saved.id === rule.id
            && saved.__chatappSetId === rule.__chatappSetId && saved.enabled !== rule.enabled));
          this.presets.setInUsePreset('openai', { sessionId, uiMode }, id, data, overrides);
        } else if (JSON.stringify(data) !== JSON.stringify(stored[id])) {
          await this.presets.upsert('openai', { id, name: stored[id].name, data, makeActive: false });
        }
        const regexStore = this.bridge?.getRegexStore?.() || this.bridge?.regex;
        for (const set of name === 'in_use' ? [] : regexStore?.listLocalSets?.() || []) {
          const patches = changes.filter(rule => rule.__chatappSetId === set.id);
          if (!patches.length) continue;
          await regexStore.upsertLocalSet({ id: set.id, name: set.name,
            enabled: set.manualEnabled !== false && set.enabled !== false, bind: set.bind,
            rules: set.rules.map(rule => {
              const patch = patches.find(item => item.id === rule.id);
              return patch ? { ...rule, disabled: patch.enabled === false } : rule;
            }),
          });
        }
        const context = this.buildContext(sessionId);
        if (this.context.sessionId === sessionId) this.context = { ...this.context, ...context };
        try { window.dispatchEvent(new CustomEvent('preset-changed')); } catch {}
        return { preset: read(), context };
      });
      this.presetSettingsWriteQueues.set(id, task);
      try { return await task; }
      finally { if (this.presetSettingsWriteQueues.get(id) === task) this.presetSettingsWriteQueues.delete(id); }
    }
    if (method === 'preset.saveChatCompletionSettings') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const incoming = params.settings;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return false;
      if (estimatePayloadSize(incoming) > SCRIPT_PAYLOAD_LIMIT) {
        throw new Error('预设设置过大，拒绝保存');
      }
      const uiMode = sessionId.startsWith('rp:') ? 'rp' : 'chat';
      const resolved = this.presets?.getResolvedActive?.('openai', { sessionId, uiMode }) || null;
      const activePresetId = String(
        resolved?.presetId ||
        this.context.openaiPresetId ||
        this.presets?.getActiveId?.('openai') ||
        ''
      ).trim();
      const requestedPresetId = String(params.presetId || '').trim();
      if (!activePresetId || (requestedPresetId && requestedPresetId !== activePresetId) || !this.presets?.upsert) {
        return false;
      }
      const snapshot = clonePlain(incoming);
      const blockedKeys = new Set([
        '__proto__', 'prototype', 'constructor', 'id', 'name',
        'key', 'apikey', 'authorization', 'accesstoken', 'secrettoken',
      ]);
      if (!this.presetSettingsWriteQueues) this.presetSettingsWriteQueues = new Map();
      const previous = this.presetSettingsWriteQueues.get(activePresetId) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const latestResolved = this.presets?.getResolvedActive?.('openai', { sessionId, uiMode }) || null;
        const latestPresetId = String(
          latestResolved?.presetId ||
          this.presets?.getActiveId?.('openai') ||
          ''
        ).trim();
        if (latestPresetId !== activePresetId) return false;
        const currentPreset = clonePlain(latestResolved?.preset || this.presets?.getActive?.('openai') || null);
        if (!currentPreset || typeof currentPreset !== 'object' || Array.isArray(currentPreset)) return false;
        const nextPreset = clonePlain(currentPreset) || {};
        Object.entries(snapshot).forEach(([key, value]) => {
          const normalizedKey = String(key || '').replace(/[_\-\s]/g, '').toLowerCase();
          if (blockedKeys.has(key) || blockedKeys.has(normalizedKey)) return;
          if (key === 'function_calling' && !Object.hasOwn(currentPreset, key)) return;
          if ((key === 'prompts' || key === 'prompt_order' || key === 'prompts_unused') && !Array.isArray(value)) return;
          nextPreset[key] = clonePlain(value);
        });
        nextPreset.name = String(currentPreset.name || activePresetId);
        await this.presets.upsert('openai', {
          id: activePresetId,
          name: nextPreset.name,
          data: nextPreset,
          makeActive: false,
        });
        this.context = { ...this.context, ...this.buildContext(sessionId) };
        return true;
      });
      this.presetSettingsWriteQueues.set(activePresetId, task);
      try {
        return await task;
      } finally {
        if (this.presetSettingsWriteQueues.get(activePresetId) === task) {
          this.presetSettingsWriteQueues.delete(activePresetId);
        }
      }
    }
    if (method === 'preset.setPromptEnabled') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const presetType = String(params.presetType || 'openai').trim() || 'openai';
      if (presetType !== 'openai') return false;
      const identifier = String(params.identifier || params.id || params.name || '').trim();
      if (!identifier || !this.presets?.upsert) return false;
      const uiMode = sessionId.startsWith('rp:') ? 'rp' : 'chat';
      const resolved = this.presets?.getResolvedActive?.('openai', { sessionId, uiMode }) || null;
      const presetId = String(
        params.presetId ||
        resolved?.presetId ||
        this.context.openaiPresetId ||
        this.presets?.getActiveId?.('openai') ||
        ''
      ).trim();
      const preset = clonePlain(resolved?.preset || this.presets?.getActive?.('openai') || null);
      if (!presetId || !preset || typeof preset !== 'object') return false;
      const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
      const prompt = findPresetPrompt(preset, identifier);
      if (!prompt) return false;
      const promptId = getPromptKey(prompt, identifier);
      prompt.identifier = prompt.identifier || promptId;
      prompt.enabled = params.enabled !== false;
      const block = ensurePromptOrderBlock(preset);
      if (!block.order.length && prompts.length) {
        block.order = prompts.map((item, index) => ({
          identifier: getPromptKey(item, `custom_${index}`),
          enabled: item?.enabled !== false,
        })).filter(item => item.identifier);
      }
      let orderItem = block.order.find(item => String(item?.identifier || item?.id || item?.name || '').trim() === promptId);
      if (!orderItem) {
        orderItem = { identifier: promptId, enabled: params.enabled !== false };
        block.order.push(orderItem);
      } else {
        orderItem.identifier = promptId;
        orderItem.enabled = params.enabled !== false;
      }
      await this.presets.upsert('openai', {
        id: presetId,
        name: String(preset.name || presetId),
        data: preset,
        makeActive: false,
      });
      this.context = { ...this.context, ...this.buildContext(sessionId) };
      emitDebugLog({
        message: `脚本已${params.enabled === false ? '关闭' : '开启'}预设条目：${prompt.name || promptId}`,
        type: 'info',
        source: 'script',
      });
      return true;
    }
    if (method === 'context.getContext') {
      const localVariables = variableRuntimeEnabled && sessionId && this.chatStore?.listVariables
        ? (this.chatStore.listVariables(sessionId) || {})
        : {};
      const globalVariables = variableRuntimeEnabled
        ? (this.chatStore?.listGlobalVariables?.() || {})
        : {};
      const sharedVariables = this.bridge?.isSharedVariableSession?.(sessionId) === true;
      const variables = sharedVariables ? globalVariables : localVariables;
      const chat = allowReadMessages && Array.isArray(this.chatStore?.getMessages?.(sessionId))
        ? this.chatStore.getMessages(sessionId).map(m => ({ ...m }))
        : [];
      return {
        ...this.context,
        sessionId,
        chat,
        messages: chat,
        variables: clonePlain(variables) || {},
        stat_data: clonePlain(variables) || {},
        status_current_variables: clonePlain(variables) || {},
        local_variables: clonePlain(localVariables) || {},
        global_variables: clonePlain(globalVariables) || {},
        localVariables: clonePlain(localVariables) || {},
        globalVariables: clonePlain(globalVariables) || {},
        characterVariables: variableRuntimeEnabled ? (clonePlain(this.context.characterVariables) || {}) : {},
        presetVariables: variableRuntimeEnabled ? (clonePlain(this.context.presetVariables) || {}) : {},
        sharedVariables,
        variableRuntimeEnabled,
        powerUserSettings: {},
      };
    }
    if (method === 'script.updateData') {
      if (!allowModifyVariables) denyScriptPermission('修改变量');
      const scriptId = String(params.scriptId || '').trim();
      const data = params.data && typeof params.data === 'object' ? params.data : {};
      if (!scriptId) return false;
      let scope = String(params.scope || '').trim();
      let scopeId = String(params.scopeId || '').trim();
      if (!scope || !scopeId) {
        const { scope: foundScope, scopeId: foundScopeId } = this.findScriptScope(scriptId);
        scope = scope || foundScope;
        scopeId = scopeId || foundScopeId;
      }
      await this.store?.updateScriptData?.(scope || 'global', scopeId || 'global', scriptId, data);
      return true;
    }
    if (method === 'prompt.setExtensionPrompt') {
      const key = String(params?.key || '').trim();
      if (!key) return false;
      this.upsertScriptPromptInjection(`ext:${key}`, {
        content: String(params?.value ?? ''),
        position: params?.position,
        depth: params?.depth,
        role: params?.role,
      });
      return true;
    }
    if (method === 'prompt.injectPrompts') {
      const injects = Array.isArray(params?.injects) ? params.injects : [];
      injects.forEach((item) => {
        const id = String(item?.id || '').trim();
        if (!id) return;
        this.upsertScriptPromptInjection(`inject:${id}`, {
          content: String(item?.content ?? ''),
          position: item?.position,
          depth: item?.depth,
          role: item?.role,
        });
      });
      return true;
    }
    if (method === 'prompt.uninjectPrompts') {
      const ids = Array.isArray(params?.ids) ? params.ids : [];
      const sid = String(this.context.sessionId || '').trim();
      const table = this.scriptPromptInjections.get(sid);
      if (table) ids.forEach(id => table.delete(`inject:${String(id || '').trim()}`));
      return true;
    }
    if (method === 'log') {
      if (params.scriptError && typeof params.scriptError === 'object') {
        this.reportScriptRuntimeError(params.scriptError);
        return true;
      }
      const level = params.level || 'log';
      const args = Array.isArray(params.args) ? params.args : [params.args];
      logger[level]?.('[script]', ...args);
      const type = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
      const text = args
        .map(item => {
          if (typeof item === 'string') return item;
          try {
            return JSON.stringify(item);
          } catch {
            return String(item);
          }
        })
        .filter(Boolean)
        .join(' ');
      if (text) {
        emitDebugLog({ message: text, type, source: 'script' });
      }
      return true;
    }
    if (method === 'toast') {
      const message = String(params.message || '');
      const level = String(params.level || 'info');
      if (window?.toastr?.[level]) window.toastr[level](message);
      else window?.toastr?.info?.(message);
      return true;
    }
    return null;
  }
}
