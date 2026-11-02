import { logger } from '../utils/logger.js';
import { RISKY_PERMISSION_SET, POWER_REQUIRED_PERMISSIONS } from './plugin-permissions.js';

const INIT_TIMEOUT_MS = 10000;
const EVENT_TIMEOUT_MS = 4000;
const LOG_WINDOW_MS = 2000;
const LOG_MAX_PER_WINDOW = 80;

const needsPermissionApproval = (manifest) => {
  const perms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  return perms.some(p => RISKY_PERMISSION_SET.has(p));
};

const needsPowerMode = (manifest) => {
  const perms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  return perms.some(p => POWER_REQUIRED_PERMISSIONS.has(p));
};

const buildWorkerScript = () => `
const listeners = new Map();
const pendingRpcs = new Map();
const subscriptions = new Set();
let rpcSeq = 1;
let pluginMeta = {};
let listenerCount = 0;
const variableWatchers = new Map();
const legacyState = {
  chat: [],
  variables: {},
  globalVariables: {},
  extensionSettings: {},
};
const legacyEventCache = new Map();
const MAX_LISTENERS_TOTAL = 120;
const MAX_LISTENERS_PER_EVENT = 30;
const MAX_VARIABLE_WATCHERS = 30;
const MAX_TIMERS = 40;
const MIN_TIMER_DELAY_MS = 30;
const timerIds = new Set();

const hasPermission = (perm) => Array.isArray(pluginMeta?.permissions) && pluginMeta.permissions.includes(perm);
const denyNetwork = () => {
  throw new Error('权限不足: network');
};

const originalFetch = typeof fetch === 'function' ? fetch.bind(self) : null;
if (originalFetch) {
  self.fetch = (...args) => {
    if (!hasPermission('network')) return Promise.reject(new Error('权限不足: network'));
    return originalFetch(...args);
  };
}

const originalImportScripts = typeof importScripts === 'function' ? importScripts.bind(self) : null;
if (originalImportScripts) {
  self.importScripts = (...args) => {
    if (!hasPermission('network')) return denyNetwork();
    return originalImportScripts(...args);
  };
}

const OriginalWebSocket = self.WebSocket;
if (OriginalWebSocket) {
  self.WebSocket = function(...args) {
    if (!hasPermission('network')) return denyNetwork();
    return new OriginalWebSocket(...args);
  };
  self.WebSocket.prototype = OriginalWebSocket.prototype;
}

const OriginalXHR = self.XMLHttpRequest;
if (OriginalXHR) {
  self.XMLHttpRequest = function() {
    if (!hasPermission('network')) return denyNetwork();
    return new OriginalXHR();
  };
  self.XMLHttpRequest.prototype = OriginalXHR.prototype;
}

const clampDelay = (delay) => {
  const raw = Number(delay);
  if (!Number.isFinite(raw) || raw < 0) return MIN_TIMER_DELAY_MS;
  return Math.max(MIN_TIMER_DELAY_MS, raw);
};

const originalSetTimeout = typeof self.setTimeout === 'function' ? self.setTimeout.bind(self) : null;
const originalClearTimeout = typeof self.clearTimeout === 'function' ? self.clearTimeout.bind(self) : null;
if (originalSetTimeout && originalClearTimeout) {
  self.setTimeout = (handler, delay, ...args) => {
    if (timerIds.size >= MAX_TIMERS) throw new Error('定时器数量超出限制');
    if (typeof handler !== 'function') throw new Error('定时器回调必须是函数');
    let id;
    const wrapped = (...callArgs) => {
      timerIds.delete(id);
      return handler(...callArgs);
    };
    id = originalSetTimeout(wrapped, clampDelay(delay), ...args);
    timerIds.add(id);
    return id;
  };
  self.clearTimeout = (id) => {
    timerIds.delete(id);
    return originalClearTimeout(id);
  };
}

const originalSetInterval = typeof self.setInterval === 'function' ? self.setInterval.bind(self) : null;
const originalClearInterval = typeof self.clearInterval === 'function' ? self.clearInterval.bind(self) : null;
if (originalSetInterval && originalClearInterval) {
  self.setInterval = (handler, delay, ...args) => {
    if (timerIds.size >= MAX_TIMERS) throw new Error('定时器数量超出限制');
    if (typeof handler !== 'function') throw new Error('定时器回调必须是函数');
    const id = originalSetInterval(handler, clampDelay(delay), ...args);
    timerIds.add(id);
    return id;
  };
  self.clearInterval = (id) => {
    timerIds.delete(id);
    return originalClearInterval(id);
  };
}

const makeError = (err) => ({
  message: err && err.message ? String(err.message) : String(err || 'unknown error'),
  stack: err && err.stack ? String(err.stack) : '',
});

const send = (msg) => {
  postMessage(msg);
};

const makeLogSafe = (value) => {
  if (value === undefined) return '[undefined]';
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return '[Function]';
  if (t === 'symbol') return String(value);
  if (t !== 'object') return String(value);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable]';
    }
  }
};

const sendLog = (level, args) => {
  const list = Array.isArray(args) ? args.map(makeLogSafe) : [];
  send({ type: 'log', level, args: list });
};

const callRpc = (method, params) => new Promise((resolve, reject) => {
  if (pendingRpcs.size > 200) {
    reject(new Error('请求过多，请稍后重试'));
    return;
  }
  const id = rpcSeq++;
  pendingRpcs.set(id, { resolve, reject });
  send({ type: 'rpc', id, method, params });
});

const toPath = (path) => {
  if (Array.isArray(path)) return path.map(seg => String(seg)).filter(Boolean);
  const raw = String(path || '');
  if (!raw) return [];
  return raw.split('.').map(seg => seg.trim()).filter(Boolean);
};

const lodashGet = (obj, path, defaultValue) => {
  const parts = toPath(path);
  let cur = obj;
  for (const key of parts) {
    if (cur && typeof cur === 'object' && key in cur) {
      cur = cur[key];
    } else {
      return defaultValue;
    }
  }
  return cur === undefined ? defaultValue : cur;
};

const lodashSet = (obj, path, value) => {
  if (!obj || typeof obj !== 'object') return obj;
  const parts = toPath(path);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
};

const lodashMerge = (target, source) => {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;
  Object.entries(source).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      lodashMerge(target[key], value);
    } else {
      target[key] = value;
    }
  });
  return target;
};

const cloneValue = (value) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

const _ = {
  VERSION: '4.17.21',
  get: lodashGet,
  set: lodashSet,
  merge: lodashMerge,
  cloneDeep: cloneValue,
};
self._ = _;

const mapMessagePayload = (payload) => {
  const message = payload && payload.message ? payload.message : payload;
  const msgObj = message && typeof message === 'object' ? { ...message } : null;
  return {
    message: msgObj,
    messageId: msgObj?.id || '',
    role: msgObj?.role || '',
    content: msgObj?.content || '',
    sessionId: payload?.sessionId || null,
  };
};

const mapVariablePayload = (payload) => {
  const name = String(payload?.name || '');
  const scope = payload?.scope || 'chat';
  return {
    name,
    variableName: name,
    value: payload?.newValue,
    newValue: payload?.newValue,
    oldValue: payload?.oldValue,
    scope,
    sessionId: payload?.sessionId || null,
  };
};

const mapCommandPayload = (payload) => ({
  command: String(payload?.text || ''),
  text: String(payload?.text || ''),
  handled: Boolean(payload?.handled),
  sessionId: payload?.sessionId || null,
});

const legacyAliases = new Map([
  ['message_received', { source: 'message.after_receive', transform: mapMessagePayload }],
  ['message_sent', { source: 'message.after_send', transform: mapMessagePayload }],
  ['mag_before_message_update', { source: 'message.before_render', transform: mapMessagePayload }],
  ['mag_after_message_update', { source: 'message.after_render', transform: mapMessagePayload }],
  ['mag_variable_updated', { source: 'variable.changed', transform: mapVariablePayload }],
  ['mag_command_parsed', { source: 'command.parsed', transform: mapCommandPayload }],
  ['mag_variable_initialized', { source: null }],
  ['mag_variable_update_started', { source: null }],
  ['mag_variable_update_ended', { source: null }],
]);

const legacyForward = new Map();
legacyAliases.forEach((value, alias) => {
  if (!value?.source) return;
  if (!legacyForward.has(value.source)) legacyForward.set(value.source, []);
  legacyForward.get(value.source).push({ name: alias, transform: value.transform });
});

const ensureSubscription = (eventName) => {
  const name = String(eventName || '').trim();
  if (!name || subscriptions.has(name)) return;
  subscriptions.add(name);
  send({ type: 'event_subscribe', event: name });
};

const addListener = (eventName, callback) => {
  const name = String(eventName || '').trim();
  if (!name || typeof callback !== 'function') return;
  if (!listeners.has(name)) listeners.set(name, new Set());
  const bucket = listeners.get(name);
  if (bucket.has(callback)) return;
  if (listenerCount >= MAX_LISTENERS_TOTAL) throw new Error('事件监听数量超出限制');
  if (bucket.size >= MAX_LISTENERS_PER_EVENT) throw new Error('单事件监听数量超出限制');
  bucket.add(callback);
  listenerCount += 1;
  const alias = legacyAliases.get(name);
  if (alias && alias.source) ensureSubscription(alias.source);
  if (!alias) ensureSubscription(name);
};

const removeListener = (eventName, callback) => {
  const name = String(eventName || '').trim();
  if (!name || !listeners.has(name)) return;
  const bucket = listeners.get(name);
  if (callback) {
    if (bucket.delete(callback)) listenerCount = Math.max(0, listenerCount - 1);
  } else {
    listenerCount = Math.max(0, listenerCount - bucket.size);
    listeners.delete(name);
    return;
  }
  if (bucket.size === 0) listeners.delete(name);
};

const dispatchEvent = async (name, payload, options = {}) => {
  const list = listeners.get(name);
  if (!list || list.size === 0) return payload;
  const allowMutate = options.allowMutate !== false;
  let data = payload;
  for (const cb of Array.from(list)) {
    try {
      const res = await cb(data);
      if (allowMutate && res && typeof res === 'object') data = res;
    } catch (err) {
      send({ type: 'event_error', event: name, error: makeError(err) });
    }
  }
  return data;
};

const upsertChatMessage = (message) => {
  if (!message || typeof message !== 'object') return;
  const id = String(message.id || '');
  if (!id) return;
  const idx = legacyState.chat.findIndex(m => String(m?.id || '') === id);
  if (idx >= 0) legacyState.chat[idx] = { ...message };
  else legacyState.chat.push({ ...message });
};

const syncLegacyVariableChange = (payload) => {
  if (!payload || typeof payload !== 'object') return;
  const name = String(payload.name || '').trim();
  if (!name) return;
  const scope = payload.scope === 'global' ? 'global' : 'chat';
  const store = scope === 'global' ? legacyState.globalVariables : legacyState.variables;
  if (payload.newValue === undefined) delete store[name];
  else store[name] = payload.newValue;
};

const cacheLegacyInit = (data) => {
  const list = legacyEventCache.get('mag_variable_initialized') || [];
  const scope = data?.scope;
  const next = Array.isArray(list) ? list.filter(item => item?.scope !== scope) : [];
  next.push(data);
  legacyEventCache.set('mag_variable_initialized', next);
};

const emitLegacyEvent = async (name, data, cacheInit = false) => {
  if (cacheInit && name === 'mag_variable_initialized') cacheLegacyInit(data);
  await dispatchEvent(name, data, { allowMutate: false });
};

const refreshLegacySession = async () => {
  try {
    const vars = await callRpc('variables.getAll', {});
    if (vars && typeof vars === 'object') legacyState.variables = { ...vars };
  } catch {}
  try {
    const messages = await callRpc('chat.getMessages', { limit: 200, offset: 0 });
    if (Array.isArray(messages)) legacyState.chat = messages.slice();
  } catch {}
  emitLegacyEvent('mag_variable_initialized', { scope: 'chat', variables: cloneValue(legacyState.variables) }, true);
};

const dispatchIncomingEvent = async (name, payload) => {
  const evt = String(name || '').trim();
  const data = payload || {};
  if (evt === 'runtime.variables.resync') {
    await refreshLegacySession();
    return data;
  }
  if (evt === 'variable.changed') syncLegacyVariableChange(data);
  if (evt === 'message.after_send' || evt === 'message.after_receive') {
    if (data?.message) upsertChatMessage(data.message);
  }
  if (evt === 'session.changed') {
    await refreshLegacySession();
  }
  const result = await dispatchEvent(evt, data, { allowMutate: true });
  const aliases = legacyForward.get(evt) || [];
  for (const alias of aliases) {
    const mapped = alias.transform ? alias.transform(data) : data;
    await dispatchEvent(alias.name, mapped, { allowMutate: false });
  }
  return result;
};

const getVariables = (scope = 'chat') => {
  const store = String(scope || '').toLowerCase() === 'global' ? legacyState.globalVariables : legacyState.variables;
  return cloneValue(store);
};

const setVariables = (updates, scope = 'chat') => {
  const data = updates && typeof updates === 'object' ? updates : {};
  const scoped = String(scope || '').toLowerCase() === 'global' ? 'global' : 'chat';
  emitLegacyEvent('mag_variable_update_started', { scope: scoped, updates: cloneValue(data) });
  Object.entries(data).forEach(([name, value]) => {
    const key = String(name || '').trim();
    if (!key) return;
    if (scoped === 'global') legacyState.globalVariables[key] = value;
    else legacyState.variables[key] = value;
  });
  if (scoped === 'global') {
    callRpc('legacy.setGlobalVariables', { updates: data }).catch(() => {});
  } else {
    callRpc('variables.patch', { updates: data }).catch(() => {});
  }
  emitLegacyEvent('mag_variable_update_ended', { scope: scoped, variables: getVariables(scoped) });
  return getVariables(scoped);
};

const updateVariablesWith = (updates, scope = 'chat') => {
  if (typeof updates === 'function') {
    const current = getVariables(scope);
    const next = updates(current);
    return setVariables(next && typeof next === 'object' ? next : {}, scope);
  }
  return setVariables(updates, scope);
};

const getChatMessages = () => cloneValue(legacyState.chat);

const setChatMessage = (id, data) => {
  const msgId = String(id || '').trim();
  if (!msgId || !data || typeof data !== 'object') return null;
  const existing = legacyState.chat.find(m => String(m?.id || '') === msgId) || {};
  const next = { ...existing, ...data, id: msgId };
  upsertChatMessage(next);
  callRpc('chat.updateMessage', { id: msgId, data }).catch(() => {});
  return cloneValue(next);
};

const setChatMessages = (messages = []) => {
  if (!Array.isArray(messages)) return [];
  legacyState.chat = messages.map(m => (m && typeof m === 'object' ? { ...m } : m)).filter(Boolean);
  legacyState.chat.forEach(m => {
    if (!m || !m.id) return;
    callRpc('chat.updateMessage', { id: m.id, data: m }).catch(() => {});
  });
  return getChatMessages();
};

const eventOn = (event, callback) => {
  if (typeof callback !== 'function') return;
  const name = String(event || '').trim();
  if (!name) return;
  addListener(name, callback);
  const cached = legacyEventCache.get(name);
  if (cached && Array.isArray(cached)) {
    cached.forEach((data) => {
      Promise.resolve().then(() => callback(data));
    });
  }
};

const eventRemove = (event, callback) => {
  removeListener(event, callback);
};

const eventEmit = (event, data) => dispatchEvent(String(event || '').trim(), data || {}, { allowMutate: true });

const buildExtensionSettingsProxy = () => new Proxy(legacyState.extensionSettings, {
  set: (target, prop, value) => {
    const key = String(prop || '').trim();
    if (!key) return true;
    target[key] = value;
    callRpc('legacy.setExtensionSetting', { key, value }).catch(() => {});
    return true;
  },
  deleteProperty: (target, prop) => {
    const key = String(prop || '').trim();
    if (!key) return true;
    delete target[key];
    callRpc('legacy.setExtensionSettings', { data: target }).catch(() => {});
    return true;
  },
});

const buildSillyTavern = () => {
  const st = {};
  Object.defineProperty(st, 'chat', {
    get: () => legacyState.chat,
    set: (val) => {
      legacyState.chat = Array.isArray(val) ? val.slice() : [];
    },
  });
  Object.defineProperty(st, 'extensionSettings', {
    get: () => buildExtensionSettingsProxy(),
    set: (val) => {
      legacyState.extensionSettings = val && typeof val === 'object' ? { ...val } : {};
      callRpc('legacy.setExtensionSettings', { data: legacyState.extensionSettings }).catch(() => {});
    },
  });
  return st;
};

const api = {
  plugin: {},
  chat: {
    getMessages: (options) => callRpc('chat.getMessages', options || {}),
    getMessage: (id) => callRpc('chat.getMessage', { id }),
    updateMessage: (id, data) => callRpc('chat.updateMessage', { id, data }),
    sendMessage: (content, options) => callRpc('chat.sendMessage', { content, options }),
    getCurrentSession: () => callRpc('chat.getCurrentSession', {}),
  },
  storage: {
    get: (key) => callRpc('storage.get', { key }),
    set: (key, value) => callRpc('storage.set', { key, value }),
    remove: (key) => callRpc('storage.remove', { key }),
    keys: () => callRpc('storage.keys', {}),
  },
  variables: {
    get: (name) => callRpc('variables.get', { name }),
    getAll: () => callRpc('variables.getAll', {}),
    set: (name, value) => callRpc('variables.set', { name, value }),
    patch: (updates) => callRpc('variables.patch', { updates }),
    watch: (name, callback) => {
      const key = String(name || '').trim();
      if (!key || typeof callback !== 'function') return;
      if (!hasPermission('variables.read')) throw new Error('权限不足: variables.read');
      if (variableWatchers.size >= MAX_VARIABLE_WATCHERS) throw new Error('变量监听数量超出限制');
      const wrapped = (data) => {
        if (!data || typeof data !== 'object') return;
        if (String(data.name || '') !== key) return;
        callback(data.newValue, data.oldValue);
      };
      variableWatchers.set(callback, { name: key, wrapped });
      addListener('variable.changed', wrapped);
    },
    unwatch: (name, callback) => {
      const entry = variableWatchers.get(callback);
      if (!entry) return;
      removeListener('variable.changed', entry.wrapped);
      variableWatchers.delete(callback);
    },
  },
  worldbook: {
    getPrimary: () => callRpc('worldbook.getPrimary', {}),
    getEntries: (id) => callRpc('worldbook.getEntries', { id }),
    list: () => callRpc('worldbook.list', {}),
    getSettings: () => callRpc('worldbook.getSettings', {}),
    setEntries: (id, entries) => callRpc('worldbook.setEntries', { id, entries }),
    save: (id, data) => callRpc('worldbook.save', { id, data }),
  },
  ui: {
    registerSidebar: (config) => callRpc('ui.registerSidebar', { config }),
    unregisterSidebar: (id) => callRpc('ui.unregisterSidebar', { id }),
    registerChatCard: (config) => callRpc('ui.registerChatCard', { config }),
    unregisterChatCard: (id) => callRpc('ui.unregisterChatCard', { id }),
    openModal: (config) => callRpc('ui.openModal', { config }),
    closeModal: (id) => callRpc('ui.closeModal', { id }),
  },
  // 用户工具能力：宿主按权限逐项检查（input.write／model.call／network）
  tool: {
    getInput: () => callRpc('tool.input.get', {}),
    setInput: (text) => callRpc('tool.input.set', { text: String(text ?? '') }),
    insertInput: (text) => callRpc('tool.input.insert', { text: String(text ?? '') }),
    send: (text) => callRpc('tool.send', { text: text === undefined ? undefined : String(text) }),
    generate: (options) => callRpc('tool.model.generate', typeof options === 'string' ? { prompt: options } : (options || {})),
    fetch: (url, options) => callRpc('tool.http', { url: String(url || ''), options: options || {} }),
    notify: (text, level) => callRpc('tool.notify', { text: String(text ?? ''), level: String(level || 'info') }),
  },
  logger: {
    log: (...args) => sendLog('log', args),
    info: (...args) => sendLog('info', args),
    warn: (...args) => sendLog('warn', args),
    error: (...args) => sendLog('error', args),
    debug: (...args) => sendLog('debug', args),
  },
  events: {
    on: (event, callback) => addListener(event, callback),
    off: (event, callback) => removeListener(event, callback),
    once: (event, callback) => {
      if (typeof callback !== 'function') return;
      const wrapped = async (data) => {
        removeListener(event, wrapped);
        return callback(data);
      };
      addListener(event, wrapped);
    },
  },
};

const initPlugin = async (meta, code) => {
  pluginMeta = meta || {};
  api.plugin = {
    id: pluginMeta.id || '',
    name: pluginMeta.name || '',
    version: pluginMeta.version || '',
    mode: pluginMeta.mode || 'safe',
  };

  api.legacy = {
    SillyTavern: buildSillyTavern(),
    getVariables,
    setVariables,
    updateVariablesWith,
    getChatMessages,
    setChatMessage,
    setChatMessages,
    eventOn,
    eventEmit,
    eventRemove,
  };

  self.SillyTavern = api.legacy.SillyTavern;
  self.getVariables = getVariables;
  self.setVariables = setVariables;
  self.updateVariablesWith = updateVariablesWith;
  self.getChatMessages = getChatMessages;
  self.setChatMessage = setChatMessage;
  self.setChatMessages = setChatMessages;
  self.eventOn = eventOn;
  self.eventEmit = eventEmit;
  self.eventRemove = eventRemove;

  ensureSubscription('variable.changed');
  ensureSubscription('message.after_send');
  ensureSubscription('message.after_receive');
  ensureSubscription('session.changed');

  try {
    const vars = await callRpc('variables.getAll', {});
    if (vars && typeof vars === 'object') legacyState.variables = { ...vars };
  } catch {}
  try {
    const globals = await callRpc('legacy.getGlobalVariables', {});
    if (globals && typeof globals === 'object') legacyState.globalVariables = { ...globals };
  } catch {}
  try {
    const messages = await callRpc('chat.getMessages', { limit: 200, offset: 0 });
    if (Array.isArray(messages)) legacyState.chat = messages.slice();
  } catch {}
  try {
    const settings = await callRpc('legacy.getExtensionSettings', {});
    if (settings && typeof settings === 'object') legacyState.extensionSettings = { ...settings };
  } catch {}

  const module = { exports: {} };
  const exports = module.exports;
  let entry = null;
  try {
    const fn = new Function('module', 'exports', String(code || ''));
    fn(module, exports);
    entry = module.exports;
    if (entry && typeof entry === 'object' && typeof entry.default === 'function') {
      entry = entry.default;
    }
  } catch (err) {
    throw err;
  }
  if (typeof entry !== 'function') {
    throw new Error('插件入口必须导出一个函数');
  }
  await entry(api);

  emitLegacyEvent('mag_variable_initialized', { scope: 'chat', variables: cloneValue(legacyState.variables) }, true);
  emitLegacyEvent('mag_variable_initialized', { scope: 'global', variables: cloneValue(legacyState.globalVariables) }, true);
};

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'rpc_result' || msg.type === 'rpc_error') {
    const pending = pendingRpcs.get(msg.id);
    if (pending) {
      pendingRpcs.delete(msg.id);
      if (msg.type === 'rpc_error') {
        pending.reject(msg.error || new Error('rpc error'));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  if (msg.type === 'init') {
    try {
      await initPlugin(msg.plugin || {}, msg.code || '');
      send({ type: 'init_result', id: msg.id, ok: true });
    } catch (err) {
      send({ type: 'init_result', id: msg.id, ok: false, error: makeError(err) });
    }
    return;
  }

  if (msg.type === 'event') {
    try {
      const data = await dispatchIncomingEvent(String(msg.name || ''), msg.data || {});
      send({ type: 'event_result', id: msg.id, data });
    } catch (err) {
      send({ type: 'event_result', id: msg.id, data: msg.data, error: makeError(err) });
    }
  }
});
`;

const callWithTimeout = (promise, timeoutMs, onTimeout) => new Promise((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (typeof onTimeout === 'function') onTimeout();
    reject(new Error('操作超时'));
  }, timeoutMs);
  promise
    .then((res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    })
    .catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
});

class PluginInstance {
  constructor(record, store, runtime) {
    this.record = record;
    this.store = store;
    this.runtime = runtime;
    this.worker = null;
    this.pending = new Map();
    this.seq = 1;
    this.status = 'stopped';
    this.lastError = null;
    this.subscriptions = new Set();
    this.logWindowStart = 0;
    this.logCount = 0;
    this.logSuppressed = false;
  }

  hasPermission(perm) {
    const permissions = Array.isArray(this.record.manifest?.permissions) ? this.record.manifest.permissions : [];
    return permissions.includes(perm);
  }

  async start() {
    if (this.worker) return;
    if (typeof Worker === 'undefined') {
      throw new Error('Worker not supported');
    }
    const script = buildWorkerScript();
    const blob = new Blob([script], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    this.worker = worker;
    worker.onmessage = (e) => this.handleMessage(e.data || {});
    worker.onerror = (err) => {
      this.status = 'error';
      this.lastError = err?.message || 'worker error';
      this.terminateWorker('worker error');
      this.markFailure(this.lastError);
      logger.warn(`[plugin:${this.record.id}] worker error`, err);
    };
    try {
      await this.init();
    } catch (err) {
      this.status = 'error';
      this.lastError = err?.message || 'init failed';
      this.terminateWorker(this.lastError);
      await this.markFailure(this.lastError);
      throw err;
    }
  }

  async init() {
    this.status = 'starting';
    const payload = {
      type: 'init',
      plugin: {
        id: this.record.id,
        name: this.record.manifest?.name || this.record.id,
        version: this.record.manifest?.version || '',
        mode: this.record.manifest?.mode || 'safe',
        permissions: Array.isArray(this.record.manifest?.permissions) ? this.record.manifest.permissions : [],
      },
      code: this.record.code,
    };
    const result = await this.request(payload, INIT_TIMEOUT_MS, async () => {
      this.status = 'error';
      this.lastError = 'init timeout';
      this.terminateWorker(this.lastError);
      await this.markFailure(this.lastError);
    });
    if (!result?.ok) {
      this.status = 'error';
      this.lastError = result?.error?.message || 'init failed';
      await this.markFailure(this.lastError);
      throw new Error(this.lastError);
    }
    this.status = 'running';
    try {
      await this.store.resetFailures(this.record.id);
    } catch (err) {
      logger.warn(`[plugin:${this.record.id}] reset failure stats failed`, err);
    }
  }

  async stop() {
    this.terminateWorker('stopped');
    this.status = 'stopped';
  }

  async emit(eventName, data) {
    if (!this.worker || this.status !== 'running') return data;
    const payload = {
      type: 'event',
      name: eventName,
      data,
    };
    try {
      const res = await this.request(payload, EVENT_TIMEOUT_MS, async () => {
        this.status = 'error';
        this.lastError = 'event timeout';
        this.terminateWorker(this.lastError);
        await this.markFailure(this.lastError);
      });
      if (res?.error) {
        logger.warn(`[plugin:${this.record.id}] event error`, res.error);
      }
      return res?.data ?? data;
    } catch (err) {
      logger.warn(`[plugin:${this.record.id}] event timeout`, err);
      return data;
    }
  }

  async markFailure(reason) {
    const msg = String(reason || 'plugin error');
    try {
      const result = await this.store.recordFailure(this.record.id, msg);
      if (result?.blocked) {
        await this.store.setEnabled(this.record.id, false);
        if (this.runtime) {
          await this.runtime.disablePlugin(this.record.id);
        }
      }
    } catch (err) {
      logger.warn(`[plugin:${this.record.id}] record failure failed`, err);
    }
  }

  request(payload, timeoutMs, onTimeout) {
    if (this.pending.size > 80) {
      const error = new Error('请求过多，请稍后重试');
      this.markFailure(error.message);
      return Promise.reject(error);
    }
    const id = this.seq++;
    payload.id = id;
    return callWithTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker?.postMessage(payload);
      }),
      timeoutMs,
      () => {
        this.pending.delete(id);
        if (typeof onTimeout === 'function') onTimeout();
      },
    );
  }

  async handleMessage(msg) {
    if (msg.type === 'init_result' || msg.type === 'event_result') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
      return;
    }
    if (msg.type === 'rpc') {
      await this.handleRpc(msg);
      return;
    }
    if (msg.type === 'log') {
      this.handleLog(msg.level, msg.args);
      return;
    }
    if (msg.type === 'event_subscribe') {
      if (msg.event) this.subscriptions.add(String(msg.event));
      return;
    }
    if (msg.type === 'event_error') {
      logger.warn(`[plugin:${this.record.id}] event error`, msg.error);
      // 工具动作要把错误讯息回报给用户（事件结果本身只带回原样的资料）
      if (String(msg.event || '').startsWith('tool.action.')) this.lastToolActionError = String(msg.error?.message || '插件执行出错');
    }
  }

  terminateWorker(reason) {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.pending.size) {
      const error = new Error(String(reason || 'terminated'));
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    }
  }

  async handleRpc(msg) {
    const respond = (type, payload) => {
      if (!this.worker) return;
      this.worker.postMessage({ type, id: msg.id, ...payload });
    };
    const method = String(msg.method || '');
    const permissions = Array.isArray(this.record.manifest?.permissions) ? this.record.manifest.permissions : [];
    const hasPermission = (perm) => permissions.includes(perm);
    const bridge = this.runtime?.bridge || (typeof window !== 'undefined' ? window.appBridge : null);
    const chatStore = this.runtime?.chatStore || bridge?.chatStore || null;
    const contactsStore = this.runtime?.contactsStore || bridge?.contactsStore || null;
    const ui = this.runtime?.ui || bridge?.chatUI || null;
    const uiManager = this.runtime?.uiManager || bridge?.pluginUiManager || null;
    const sessionId = String(bridge?.activeSessionId || chatStore?.getCurrent?.() || '').trim();
    const variableRuntimeEnabled = bridge?.isVariableRuntimeEnabled?.(sessionId) !== false;
    const buildMessagePayload = (msg) => {
      if (!msg || typeof msg !== 'object') return null;
      return {
        id: String(msg.id || ''),
        role: String(msg.role || ''),
        content: String(msg.content || ''),
        timestamp: Number(msg.timestamp || 0) || 0,
        metadata: msg.meta && typeof msg.meta === 'object' ? { ...msg.meta } : {},
      };
    };
    const buildSessionPayload = (sid) => {
      const id = String(sid || '').trim();
      if (!id) return null;
      const contact = contactsStore?.getContact?.(id) || null;
      const name = contact?.name || id;
      const isGroup = Boolean(contact?.isGroup) || id.startsWith('group:');
      return { id, name, isGroup };
    };

    if (method.startsWith('storage.')) {
      if (!hasPermission('storage')) {
        respond('rpc_error', { error: { message: '权限不足' } });
        return;
      }
    }
    if (method.startsWith('chat.')) {
      const needsWrite = method === 'chat.updateMessage' || method === 'chat.sendMessage';
      const perm = needsWrite ? 'chat.write' : 'chat.read';
      if (!hasPermission(perm)) {
        respond('rpc_error', { error: { message: '权限不足' } });
        return;
      }
    }
    if (method.startsWith('variables.')) {
      const needsWrite = method === 'variables.set' || method === 'variables.patch';
      const perm = needsWrite ? 'variables.write' : 'variables.read';
      if (!hasPermission(perm)) {
        respond('rpc_error', { error: { message: '权限不足' } });
        return;
      }
    }
    if (method.startsWith('worldbook.')) {
      const needsWrite = method === 'worldbook.save' || method === 'worldbook.setEntries';
      const perm = needsWrite ? 'worldbook.write' : 'worldbook.read';
      if (!hasPermission(perm)) {
        respond('rpc_error', { error: { message: '权限不足' } });
        return;
      }
    }
    if (method.startsWith('ui.')) {
      if (!hasPermission('ui.inject')) {
        respond('rpc_error', { error: { message: '权限不足' } });
        return;
      }
    }
    if (method.startsWith('tool.')) {
      const perm = method === 'tool.input.get' ? 'chat.read'
        : (method === 'tool.input.set' || method === 'tool.input.insert' || method === 'tool.send') ? 'input.write'
          : method === 'tool.model.generate' ? 'model.call'
            : method === 'tool.http' ? 'network' : '';
      if (perm && !hasPermission(perm)) {
        respond('rpc_error', { error: { message: `权限不足: ${perm}` } });
        return;
      }
      const handler = this.runtime?.toolBridge?.[method];
      if (typeof handler !== 'function') {
        respond('rpc_error', { error: { message: '这个功能现在不能用' } });
        return;
      }
      try {
        respond('rpc_result', { result: await handler(msg.params || {}, { pluginId: this.record.id, name: this.record.manifest?.name || '' }) });
      } catch (err) {
        respond('rpc_error', { error: { message: String(err?.message || err) } });
      }
      return;
    }
    if (!variableRuntimeEnabled && method.startsWith('variables.')) {
      const result = method === 'variables.getAll' ? {} : (method === 'variables.get' ? undefined : false);
      respond('rpc_result', { result });
      return;
    }
    if (!variableRuntimeEnabled && (
      method === 'legacy.getGlobalVariables'
      || method === 'legacy.setGlobalVariables'
      || method === 'legacy.setGlobalVariable'
    )) {
      respond('rpc_result', { result: method === 'legacy.getGlobalVariables' ? {} : false });
      return;
    }
    try {
      if (method === 'storage.get') {
        const result = await this.store.storageGet(this.record.id, msg.params?.key);
        respond('rpc_result', { result });
        return;
      }
      if (method === 'storage.set') {
        await this.store.storageSet(this.record.id, msg.params?.key, msg.params?.value);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'storage.remove') {
        await this.store.storageRemove(this.record.id, msg.params?.key);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'storage.keys') {
        const result = await this.store.storageKeys(this.record.id);
        respond('rpc_result', { result });
        return;
      }
      if (method === 'chat.getMessages') {
        if (!chatStore || !sessionId) {
          respond('rpc_result', { result: [] });
          return;
        }
        const limitRaw = Number(msg.params?.limit);
        const offsetRaw = Number(msg.params?.offset);
        const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.trunc(limitRaw)) : 20;
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
        const list = chatStore.getMessages(sessionId) || [];
        const sliced = limit ? list.slice(offset, offset + limit) : list.slice(offset);
        respond('rpc_result', { result: sliced.map(buildMessagePayload).filter(Boolean) });
        return;
      }
      if (method === 'chat.getMessage') {
        if (!chatStore || !sessionId) {
          respond('rpc_result', { result: null });
          return;
        }
        const id = String(msg.params?.id || '').trim();
        if (!id) {
          respond('rpc_result', { result: null });
          return;
        }
        const found = chatStore.findMessage(id, sessionId);
        respond('rpc_result', { result: buildMessagePayload(found) });
        return;
      }
      if (method === 'chat.getCurrentSession') {
        respond('rpc_result', { result: buildSessionPayload(sessionId) });
        return;
      }
      if (method === 'chat.updateMessage') {
        if (!chatStore || !sessionId) {
          respond('rpc_error', { error: { message: 'chat store not ready' } });
          return;
        }
        const id = String(msg.params?.id || '').trim();
        const data = msg.params?.data && typeof msg.params.data === 'object' ? msg.params.data : null;
        if (!id || !data) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        const updated = chatStore.updateMessage(id, data, sessionId);
        if (updated && ui && typeof ui.updateMessage === 'function' && chatStore.getCurrent() === sessionId) {
          ui.updateMessage(id, updated);
        }
        respond('rpc_result', { result: buildMessagePayload(updated) });
        return;
      }
      if (method === 'chat.sendMessage') {
        const content = String(msg.params?.content || '');
        const options = msg.params?.options && typeof msg.params.options === 'object' ? msg.params.options : {};
        if (!bridge?.sendMessageFromPlugin) {
          respond('rpc_error', { error: { message: 'sendMessage not available' } });
          return;
        }
        const result = await bridge.sendMessageFromPlugin(content, options);
        respond('rpc_result', { result: buildMessagePayload(result) });
        return;
      }
      if (method === 'variables.get') {
        if (!chatStore || !sessionId) {
          respond('rpc_result', { result: null });
          return;
        }
        const name = String(msg.params?.name || '').trim();
        respond('rpc_result', { result: chatStore.getVariable(name, sessionId) });
        return;
      }
      if (method === 'variables.getAll') {
        if (!chatStore || !sessionId) {
          respond('rpc_result', { result: {} });
          return;
        }
        respond('rpc_result', { result: chatStore.listVariables(sessionId) || {} });
        return;
      }
      if (method === 'variables.set') {
        if (!chatStore || !sessionId) {
          respond('rpc_error', { error: { message: 'variables store not ready' } });
          return;
        }
        const name = String(msg.params?.name || '').trim();
        chatStore.setVariable(name, msg.params?.value, sessionId);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'variables.patch') {
        if (!chatStore || !sessionId) {
          respond('rpc_error', { error: { message: 'variables store not ready' } });
          return;
        }
        const updates = msg.params?.updates && typeof msg.params.updates === 'object' ? msg.params.updates : null;
        if (!updates) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        Object.entries(updates).forEach(([name, value]) => {
          const key = String(name || '').trim();
          if (!key) return;
          chatStore.setVariable(key, value, sessionId);
        });
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'worldbook.getPrimary') {
        const getWorldForSession = bridge?.getWorldForSession?.bind(bridge);
        const worldId = getWorldForSession ? getWorldForSession(sessionId) : bridge?.currentWorldId || null;
        if (!worldId || !bridge?.getWorldInfo) {
          respond('rpc_result', { result: null });
          return;
        }
        const data = await bridge.getWorldInfo(worldId);
        respond('rpc_result', { result: data });
        return;
      }
      if (method === 'worldbook.getEntries') {
        if (!bridge?.getWorldInfo) {
          respond('rpc_result', { result: [] });
          return;
        }
        const worldId = String(msg.params?.id || '').trim() || (bridge?.getWorldForSession?.(sessionId) || bridge?.currentWorldId || '');
        if (!worldId) {
          respond('rpc_result', { result: [] });
          return;
        }
        const data = await bridge.getWorldInfo(worldId);
        respond('rpc_result', { result: Array.isArray(data?.entries) ? data.entries : [] });
        return;
      }
      if (method === 'worldbook.list') {
        if (!bridge?.listWorlds) {
          respond('rpc_result', { result: [] });
          return;
        }
        const list = await bridge.listWorlds();
        respond('rpc_result', { result: Array.isArray(list) ? list : [] });
        return;
      }
      if (method === 'worldbook.getSettings') {
        const settings = bridge?.getWorldGlobalSettings?.() || {};
        respond('rpc_result', { result: settings });
        return;
      }
      if (method === 'worldbook.setEntries') {
        if (!bridge?.getWorldInfo || !bridge?.saveWorldInfo) {
          respond('rpc_error', { error: { message: 'worldbook not available' } });
          return;
        }
        const worldId = String(msg.params?.id || '').trim() || (bridge?.getWorldForSession?.(sessionId) || bridge?.currentWorldId || '');
        const entries = Array.isArray(msg.params?.entries) ? msg.params.entries : null;
        if (!worldId || !entries) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        const existing = await bridge.getWorldInfo(worldId);
        const payload = { ...(existing || { name: worldId, entries: [] }), entries };
        await bridge.saveWorldInfo(worldId, payload);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'worldbook.save') {
        if (!bridge?.saveWorldInfo) {
          respond('rpc_error', { error: { message: 'worldbook not available' } });
          return;
        }
        const worldId = String(msg.params?.id || '').trim();
        const data = msg.params?.data && typeof msg.params.data === 'object' ? msg.params.data : null;
        if (!worldId || !data) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        const snapshot = typeof bridge.getWorldInfoSnapshot === 'function'
          ? await bridge.getWorldInfoSnapshot(worldId)
          : null;
        await bridge.saveWorldInfo(worldId, data, snapshot ? {
          expectedRevision: snapshot.revision,
          expectedGeneration: snapshot.generation,
          expectedExists: snapshot.exists,
        } : undefined);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'ui.registerSidebar') {
        if (!uiManager?.registerSidebar) {
          respond('rpc_error', { error: { message: 'ui manager not available' } });
          return;
        }
        const ok = uiManager.registerSidebar(this.record.id, msg.params?.config || {});
        respond('rpc_result', { result: Boolean(ok) });
        return;
      }
      if (method === 'ui.unregisterSidebar') {
        if (!uiManager?.unregisterSidebar) {
          respond('rpc_error', { error: { message: 'ui manager not available' } });
          return;
        }
        const ok = uiManager.unregisterSidebar(this.record.id, msg.params?.id);
        respond('rpc_result', { result: Boolean(ok) });
        return;
      }
      if (method === 'ui.registerChatCard') {
        if (!uiManager?.registerChatCard) {
          respond('rpc_error', { error: { message: 'ui manager not available' } });
          return;
        }
        const ok = uiManager.registerChatCard(this.record.id, msg.params?.config || {});
        respond('rpc_result', { result: Boolean(ok) });
        return;
      }
      if (method === 'ui.unregisterChatCard') {
        if (!uiManager?.unregisterChatCard) {
          respond('rpc_error', { error: { message: 'ui manager not available' } });
          return;
        }
        const ok = uiManager.unregisterChatCard(this.record.id, msg.params?.id);
        respond('rpc_result', { result: Boolean(ok) });
        return;
      }
      if (method === 'ui.openModal') {
        if (!uiManager?.openModal) {
          respond('rpc_error', { error: { message: 'ui manager not available' } });
          return;
        }
        const ok = uiManager.openModal(this.record.id, msg.params?.config || {});
        respond('rpc_result', { result: Boolean(ok) });
        return;
      }
      if (method === 'ui.closeModal') {
        if (!uiManager?.closeModal) {
          respond('rpc_error', { error: { message: 'ui manager not available' } });
          return;
        }
        const ok = uiManager.closeModal(this.record.id, msg.params?.id);
        respond('rpc_result', { result: Boolean(ok) });
        return;
      }
      if (method === 'legacy.getGlobalVariables') {
        if (!chatStore) {
          respond('rpc_result', { result: {} });
          return;
        }
        if (!hasPermission('variables.read')) {
          respond('rpc_error', { error: { message: '权限不足' } });
          return;
        }
        const result = chatStore.listGlobalVariables?.() || {};
        respond('rpc_result', { result });
        return;
      }
      if (method === 'legacy.setGlobalVariables') {
        if (!chatStore) {
          respond('rpc_error', { error: { message: 'variables store not ready' } });
          return;
        }
        if (!hasPermission('variables.write')) {
          respond('rpc_error', { error: { message: '权限不足' } });
          return;
        }
        const updates = msg.params?.updates && typeof msg.params.updates === 'object' ? msg.params.updates : null;
        if (!updates) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        if (chatStore.patchGlobalVariables) {
          chatStore.patchGlobalVariables(updates);
        } else {
          Object.entries(updates).forEach(([name, value]) => {
            const key = String(name || '').trim();
            if (!key) return;
            chatStore.setGlobalVariable?.(key, value);
          });
        }
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'legacy.setGlobalVariable') {
        if (!chatStore) {
          respond('rpc_error', { error: { message: 'variables store not ready' } });
          return;
        }
        if (!hasPermission('variables.write')) {
          respond('rpc_error', { error: { message: 'permission denied' } });
          return;
        }
        const name = String(msg.params?.name || '').trim();
        if (!name) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        chatStore.setGlobalVariable?.(name, msg.params?.value);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'legacy.getExtensionSettings') {
        const result = (await this.store.storageGet(this.record.id, '__extension_settings__')) || {};
        respond('rpc_result', { result });
        return;
      }
      if (method === 'legacy.setExtensionSettings') {
        const data = msg.params?.data && typeof msg.params.data === 'object' ? msg.params.data : {};
        await this.store.storageSet(this.record.id, '__extension_settings__', data);
        respond('rpc_result', { result: true });
        return;
      }
      if (method === 'legacy.setExtensionSetting') {
        const key = String(msg.params?.key || '').trim();
        if (!key) {
          respond('rpc_error', { error: { message: 'invalid params' } });
          return;
        }
        const current = (await this.store.storageGet(this.record.id, '__extension_settings__')) || {};
        const next = { ...(current || {}), [key]: msg.params?.value };
        await this.store.storageSet(this.record.id, '__extension_settings__', next);
        respond('rpc_result', { result: true });
        return;
      }
      respond('rpc_error', { error: { message: 'unknown method' } });
    } catch (err) {
      respond('rpc_error', { error: { message: err?.message || String(err) } });
    }
  }

  handleLog(level, args) {
    const prefix = `[plugin:${this.record.id}]`;
    const now = Date.now();
    if (!this.logWindowStart || (now - this.logWindowStart) > LOG_WINDOW_MS) {
      this.logWindowStart = now;
      this.logCount = 0;
      this.logSuppressed = false;
    }
    this.logCount += 1;
    if (this.logCount > LOG_MAX_PER_WINDOW) {
      if (!this.logSuppressed) {
        this.logSuppressed = true;
        logger.warn(`${prefix} 日志过多，已暂时抑制输出`);
      }
      return;
    }
    const payload = Array.isArray(args)
      ? args.map(a => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
      : [];
    const message = [prefix, ...payload].join(' ');
    switch (String(level || 'log')) {
      case 'debug':
        logger.debug(message);
        break;
      case 'info':
        logger.info(message);
        break;
      case 'warn':
        logger.warn(message);
        break;
      case 'error':
        logger.error(message);
        break;
      default:
        logger.info(message);
    }
  }
}

export class PluginRuntime {
  constructor(store, options = {}) {
    this.store = store;
    this.bridge = options.bridge || null;
    this.chatStore = options.chatStore || null;
    this.contactsStore = options.contactsStore || null;
    this.ui = options.ui || null;
    this.uiManager = options.uiManager || null;
    this.instances = new Map();
    this.initialized = false;
  }

  /** 用户工具的宿主能力（tool.* RPC）：{ 'tool.input.get': fn(params, { pluginId }) , ... }。 */
  setToolBridge(bridge = null) {
    this.toolBridge = bridge && typeof bridge === 'object' ? bridge : null;
  }

  /** 运行中的插件在 manifest.actions 宣告的动作（供用户工具选用）。 */
  listActions() {
    const out = [];
    for (const [pluginId, instance] of this.instances.entries()) {
      if (instance.status !== 'running') continue;
      const actions = Array.isArray(instance.record.manifest?.actions) ? instance.record.manifest.actions : [];
      actions.slice(0, 20).forEach((action) => {
        const id = String(action?.id || '').trim();
        if (!/^[a-zA-Z0-9._-]{1,60}$/.test(id)) return;
        out.push({
          pluginId,
          pluginName: String(instance.record.manifest?.name || pluginId),
          id,
          title: String(action?.title || id).slice(0, 40),
          description: String(action?.description || '').slice(0, 200),
          target: ['assistant', 'user', 'any', 'none'].includes(action?.target) ? action.target : 'none',
        });
      });
    }
    return out;
  }

  /** 执行插件的动作：送 tool.action.<id> 事件，插件用 api.events.on 处理并回传结果物件。 */
  async runAction(pluginId, actionId, ctx = {}, { timeoutMs = 60000 } = {}) {
    const instance = this.instances.get(String(pluginId || '').trim());
    if (!instance || instance.status !== 'running') return { status: 'unavailable', message: '插件没有在运行' };
    instance.lastToolActionError = '';
    const res = await instance.request({ type: 'event', name: `tool.action.${actionId}`, data: { ctx } }, timeoutMs);
    if (res?.error) return { status: 'failed', message: String(res.error.message || '插件执行出错') };
    const data = res?.data;
    // 没有监听处理（或处理时出错）时，事件原样回来（只有 ctx）
    if (!data || typeof data !== 'object' || (Object.keys(data).length === 1 && 'ctx' in data)) {
      if (instance.lastToolActionError) return { status: 'failed', message: instance.lastToolActionError };
      return { status: 'unavailable', message: '插件没有处理这个动作' };
    }
    return data;
  }

  /**
   * 一次性跑一段工具脚本：独立的插件 Worker（权限＝工具声明并确认过的能力），跑完就结束。
   * code 是函数主体，拿到 ctx 与 api（api.tool.* 等），回传结果物件或字串。
   * 包装里自己接住错误：监听里抛出的错误会被 Worker 吞掉，只送出 event_error。
   */
  async runEphemeral({ id, name = '', permissions = [], code = '', ctx = {}, timeoutMs = 60000 } = {}) {
    const wrapped = `module.exports = async (api) => {
  api.events.on('tool.action.run', async (payload) => {
    const ctx = payload && payload.ctx ? payload.ctx : {};
    try {
      const result = await (async (ctx, api) => {\n${String(code || '')}\n})(ctx, api);
      return { status: 'succeeded', result: result === undefined ? null : result };
    } catch (err) {
      return { status: 'failed', message: String((err && err.message) || err) };
    }
  });
};`;
    const record = {
      id: String(id || 'tool-script'),
      manifest: { id: String(id || 'tool-script'), name: String(name || 'tool script'), mode: permissions.includes('network') ? 'power' : 'safe', permissions },
      code: wrapped,
    };
    const store = { resetFailures: async () => {}, recordFailure: async () => ({}), setEnabled: async () => {} };
    const instance = new PluginInstance(record, store, this);
    try {
      await instance.start();
      const res = await instance.request({ type: 'event', name: 'tool.action.run', data: { ctx } }, timeoutMs);
      if (res?.error) return { status: 'failed', message: String(res.error.message || '脚本执行出错') };
      return res?.data?.status ? res.data : { status: 'failed', message: '脚本没有执行完' };
    } catch (err) {
      return { status: 'failed', message: String(err?.message || err) };
    } finally {
      await instance.stop().catch(() => {});
    }
  }

  setContext({ bridge, chatStore, contactsStore, ui, uiManager } = {}) {
    if (bridge) this.bridge = bridge;
    if (chatStore) this.chatStore = chatStore;
    if (contactsStore) this.contactsStore = contactsStore;
    if (ui) this.ui = ui;
    if (uiManager) this.uiManager = uiManager;
  }

  async init() {
    await this.store.ready;
    await this.startEnabled();
    this.initialized = true;
  }

  isRunning(id) {
    const instance = this.instances.get(String(id || '').trim());
    return instance?.status === 'running';
  }

  getStatus(id) {
    const instance = this.instances.get(String(id || '').trim());
    if (!instance) return { status: 'stopped', error: null };
    return { status: instance.status, error: instance.lastError };
  }

  async startEnabled() {
    const list = this.store.list();
    for (const item of list) {
      if (item.enabled) {
        await this.enablePlugin(item.id);
      }
    }
  }

  async enablePlugin(id) {
    const key = String(id || '').trim();
    if (!key) return;
    if (this.instances.has(key)) return;
    const record = this.store.get(key);
    if (!record) return;
    if (this.store.isBlocked(key)) {
      logger.warn(`[plugin:${key}] plugin is blocked`);
      await this.store.setEnabled(key, false);
      return;
    }
    if (needsPowerMode(record.manifest) && String(record.manifest?.mode || '').toLowerCase() !== 'power') {
      logger.warn(`[plugin:${key}] permissions require power mode`);
      await this.store.setEnabled(key, false);
      return;
    }
    if (String(record.manifest?.mode || '').toLowerCase() === 'power' && !this.store.isPowerApproved(key)) {
      logger.warn(`[plugin:${key}] power plugin not authorized`);
      await this.store.setEnabled(key, false);
      return;
    }
    if (needsPermissionApproval(record.manifest) && !this.store.isPermissionsApproved(key)) {
      logger.warn(`[plugin:${key}] permissions not authorized`);
      await this.store.setEnabled(key, false);
      return;
    }
    const instance = new PluginInstance(record, this.store, this);
    this.instances.set(key, instance);
    try {
      await instance.start();
    } catch (err) {
      logger.warn(`[plugin:${key}] failed to start`, err);
      instance.status = 'error';
      instance.lastError = err?.message || 'start failed';
    }
  }

  async disablePlugin(id) {
    const key = String(id || '').trim();
    const instance = this.instances.get(key);
    if (instance) {
      await instance.stop();
    }
    this.instances.delete(key);
    if (this.uiManager?.removePluginUi) {
      this.uiManager.removePluginUi(key);
    }
  }

  async dispatchEvent(name, data) {
    let payload = data;
    for (const [id, instance] of this.instances.entries()) {
      if (instance.status !== 'running') continue;
      if (instance.subscriptions.size && !instance.subscriptions.has(name)) continue;
      const next = await instance.emit(name, payload);
      if (String(name || '').startsWith('prompt.') && !instance.hasPermission?.('prompt.modify')) {
        continue;
      }
      payload = next;
    }
    return payload;
  }

  async syncVariableContext(sessionId = '') {
    const payload = { sessionId: String(sessionId || '').trim() };
    for (const instance of this.instances.values()) {
      if (instance.status !== 'running') continue;
      await instance.emit('runtime.variables.resync', payload);
    }
    return true;
  }
}
