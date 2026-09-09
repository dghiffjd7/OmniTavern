(() => {
  let applied = false;
  let currentId = '';
  let layoutScheduled = false;
  let pendingSource = 'bridge';
  let pendingForce = false;
  let lastSentHeight = 0;
  let lastSentMode = 'document';
  let lastSentLock = false;
  let resizeSeq = 0;
  let pressTimer = null;
  let pressActive = false;
  let touchActive = false;
  let touchStartPoint = null;
  const moveThreshold = 12;
  let forceNextResize = false;
  let viewportLogged = false;
  let lockLogged = false;
  let bridgeEventsBound = false;
  let runtimeDiagnosticsInstalled = false;
  let resizeObserver = null;
  let mutationObserver = null;
  let fallbackResizeTimer = 0;
  let stableViewportHeight = 0;
  let nestedSrcdocCompatInstalled = false;
  const managedScriptMeta = new WeakMap();
  const managedBlobUrls = new Set();
  const nestedSrcdocBlobUrls = new Set();
  const externalizedBlobMeta = new Map();
  const remoteScriptTextCache = new Map();
  const loadingOverlaySignalRe = /(^|[^a-z])(loading|loader|preload|preloader|spinner|splash|progress|resource)([^a-z]|$)/i;
  const FONT_AWESOME_LOCAL_CSS_PATH = '/vendor/fontawesome/6.0.0-beta3/css/all.min.css';
  const fontAwesomeCdnCssRe = /^https?:\/\/(?:(?:cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/6\.0\.0-beta3\/css\/all(?:\.min)?\.css)|(?:(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/@fortawesome\/fontawesome-free@6\.0\.0-beta3\/css\/all(?:\.min)?\.css))(?:[?#].*)?$/i;

  const normalizeSource = (source) => {
    const raw = String(source || '').trim().toLowerCase();
    if (raw === 'observer' || raw === 'fallback') return raw;
    return 'bridge';
  };

  const sendDebug = (level, message) => {
    try {
      parent.postMessage({
        type: 'chatapp:iframe-debug',
        id: currentId,
        level: String(level || 'info'),
        message: String(message || ''),
      }, '*');
    } catch {}
  };

  const sendHostError = (message) => {
    try {
      parent.postMessage({
        type: 'chatapp:iframe-host-error',
        id: currentId,
        message: String(message || 'host-error'),
      }, '*');
    } catch {}
  };

  const sendIframeError = (message) => {
    try {
      parent.postMessage({
        type: 'chatapp:iframe-error',
        id: currentId,
        message: String(message || 'iframe-error'),
      }, '*');
    } catch {}
  };

  const readStableViewportHeight = () => {
    try {
      const docEl = document.documentElement;
      if (!docEl) return 0;
      const style = getComputedStyle(docEl);
      const raw = String(style.getPropertyValue('--viewport-height') || '').trim();
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  };

  const applyStableViewportVars = (height = 0) => {
    try {
      const docEl = document.documentElement;
      if (!docEl) return 0;
      const next = Number(height || stableViewportHeight || readStableViewportHeight() || 0);
      if (!Number.isFinite(next) || next <= 0) return 0;
      stableViewportHeight = next;
      docEl.style.setProperty('--viewport-height', `${next}px`);
      // Many SillyTavern front-end cards use the mobile-browser --vh trick.
      // Keep it tied to the parent app viewport instead of the iframe height,
      // otherwise the parent and child continuously resize each other.
      docEl.style.setProperty('--vh', `${next * 0.01}px`);
      Array.from(docEl.style || []).forEach((name) => {
        try {
          const prop = String(name || '');
          const value = String(docEl.style.getPropertyValue(prop) || '');
          if (!/\b-?\d+(?:\.\d+)?vh\b/i.test(value)) return;
          const converted = value.replace(/(-?\d+(?:\.\d+)?)vh\b/gi, (_match, num) => {
            const n = Number.parseFloat(num);
            return Number.isFinite(n) ? `${next * (n / 100)}px` : _match;
          });
          if (converted !== value) docEl.style.setProperty(prop, converted);
        } catch {}
      });
      return next;
    } catch {
      return 0;
    }
  };

  const getBlobDebugName = (descriptor = {}) => {
    try {
      const label = String(descriptor?.label || 'inline-script')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
      return label || 'inline-script';
    } catch {
      return 'inline-script';
    }
  };

  const buildBlobDebugExcerpt = (code, line, col) => {
    try {
      const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
      const idx = Math.max(0, Number(line || 1) - 1);
      const pick = (i) => {
        if (i < 0 || i >= lines.length) return '';
        return compactText(lines[i], 220);
      };
      const target = pick(idx);
      const prev = pick(idx - 1);
      const next = pick(idx + 1);
      return [
        prev ? ('prev=' + prev) : '',
        target ? ('line=' + target) : '',
        next ? ('next=' + next) : '',
        col ? ('col=' + Number(col || 0)) : '',
      ].filter(Boolean).join(' ');
    } catch {
      return '';
    }
  };

  const rememberBlobMeta = (url, descriptor, code) => {
    try {
      const key = String(url || '').trim();
      if (!key) return;
      externalizedBlobMeta.set(key, {
        label: String(descriptor?.label || ''),
        kind: String(descriptor?.kind || ''),
        type: String(descriptor?.type || ''),
        module: descriptor?.isModule ? 1 : 0,
        babel: descriptor?.isBabel ? 1 : 0,
        code: String(code || ''),
      });
    } catch {}
  };

  const postInputText = (text, options = {}) => {
    try {
      const proxy = document.getElementById('send_textarea');
      if (proxy instanceof HTMLTextAreaElement) {
        const mode = String(options?.mode || 'replace').trim().toLowerCase();
        const nextText = String(text ?? '');
        if (mode === 'append') {
          const current = String(proxy.value || '');
          const separator = typeof options?.separator === 'string' ? options.separator : '\n';
          proxy.value = current && nextText ? `${current}${separator}${nextText}` : (current || nextText);
        } else {
          proxy.value = nextText;
        }
      }
    } catch {}
    try {
      parent.postMessage({
        type: 'chatapp:set-input-text',
        id: currentId,
        text: String(text ?? ''),
        options: options && typeof options === 'object' ? options : {},
      }, '*');
      return true;
    } catch (err) {
      sendDebug('warn', 'set-input-text-failed err=' + String(err?.message || err || 'post-failed'));
      return false;
    }
  };

  const ensureCompatInputHelpers = () => {
    if (!window.ChatAppRichCompat || typeof window.ChatAppRichCompat !== 'object') {
      window.ChatAppRichCompat = {};
    }
    if (typeof window.ChatAppRichCompat.setInputText !== 'function') {
      window.ChatAppRichCompat.setInputText = (text, options = {}) => postInputText(text, options);
    }
    if (typeof window.setInputText !== 'function') {
      window.setInputText = (text, options = {}) => postInputText(text, options);
    }
    if (typeof window.appendInputText !== 'function') {
      window.appendInputText = (text, options = {}) => postInputText(text, { ...(options || {}), mode: 'append' });
    }
  };

  const ensureCompatInputDomProxies = () => {
    try {
      if (!document.body) return;
      let textarea = document.getElementById('send_textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        textarea = document.createElement('textarea');
        textarea.id = 'send_textarea';
        textarea.setAttribute('aria-hidden', 'true');
        textarea.setAttribute('data-chatapp-layout-ignore', '1');
        textarea.tabIndex = -1;
        textarea.style.cssText = [
          'position:fixed',
          'left:-9999px',
          'top:-9999px',
          'width:1px',
          'height:1px',
          'opacity:0',
          'pointer-events:none',
        ].join(';');
        document.body.appendChild(textarea);
      }
      let sendButton = document.getElementById('send_but');
      if (!(sendButton instanceof HTMLButtonElement)) {
        sendButton = document.createElement('button');
        sendButton.id = 'send_but';
        sendButton.type = 'button';
        sendButton.setAttribute('aria-hidden', 'true');
        sendButton.setAttribute('data-chatapp-layout-ignore', '1');
        sendButton.tabIndex = -1;
        sendButton.style.cssText = [
          'position:fixed',
          'left:-9999px',
          'top:-9999px',
          'width:1px',
          'height:1px',
          'opacity:0',
          'pointer-events:none',
        ].join(';');
        document.body.appendChild(sendButton);
      }
      if (!textarea.dataset.chatappCompatBound) {
        const syncInput = (mode = 'replace') => {
          postInputText(String(textarea.value || ''), { mode, focus: false });
        };
        textarea.addEventListener('input', () => syncInput('replace'));
        textarea.addEventListener('change', () => syncInput('replace'));
        sendButton.addEventListener('click', () => {
          syncInput('replace');
          try {
            parent.postMessage({ type: 'chatapp:trigger-send', id: currentId }, '*');
          } catch {}
        });
        textarea.dataset.chatappCompatBound = '1';
      }
    } catch {}
  };

  const getParentBridge = () => {
    try {
      if (parent?.appBridge && typeof parent.appBridge === 'object') return parent.appBridge;
    } catch {}
    try {
      if (top?.appBridge && typeof top.appBridge === 'object') return top.appBridge;
    } catch {}
    return null;
  };

  const exposeGlobalCompatFunction = (name, fn) => {
    const key = String(name || '').trim();
    if (!key || typeof fn !== 'function') return;
    try {
      if (typeof window[key] !== 'function') window[key] = fn;
    } catch {}
    try {
      window.eval('var ' + key + ' = window["' + key + '"];');
    } catch {}
  };

  const normalizeLorebookEntry = (entry = {}, index = 0) => {
    const source = entry && typeof entry === 'object' ? entry : {};
    const uid = source.uid ?? source.id ?? `entry-${index}`;
    const disable = typeof source.disable === 'boolean'
      ? source.disable
      : (typeof source.enabled === 'boolean' ? !source.enabled : false);
    return {
      ...source,
      uid,
      id: source.id ?? String(uid),
      comment: source.comment ?? source.title ?? String(uid),
      order: Number.isFinite(Number(source.order ?? source.priority ?? source.insertion_order))
        ? Number(source.order ?? source.priority ?? source.insertion_order)
        : 100,
      enabled: !disable,
      disable,
    };
  };

  const getStoredLorebookSnapshot = async (name) => {
    const bridge = getParentBridge();
    const target = String(name || '').trim();
    if (!bridge || !target) return null;
    try {
      if (typeof bridge.getWorldInfoSnapshot === 'function') {
        const snapshot = await bridge.getWorldInfoSnapshot(target);
        if (snapshot && typeof snapshot === 'object') return snapshot;
      }
    } catch {}
    try {
      if (typeof bridge.getWorldInfo === 'function') {
        const data = await bridge.getWorldInfo(target);
        return {
          worldbookId: target,
          exists: data !== null && data !== undefined,
          revision: null,
          generation: null,
          data,
        };
      }
    } catch {}
    return null;
  };

  const getStoredLorebook = async (name) => {
    const snapshot = await getStoredLorebookSnapshot(name);
    return snapshot?.data ?? null;
  };

  const saveStoredLorebook = async (name, data, snapshot = null) => {
    const bridge = getParentBridge();
    const target = String(name || '').trim();
    if (!bridge || !target) return false;
    if (typeof bridge.saveWorldInfo !== 'function') return false;
    const hasRevision = snapshot?.revision !== null && snapshot?.revision !== undefined;
    const hasGeneration = snapshot?.generation !== null && snapshot?.generation !== undefined;
    const expectedRevision = Number(snapshot?.revision);
    const expectedGeneration = Number(snapshot?.generation);
    if (
      !hasRevision ||
      !hasGeneration ||
      !Number.isFinite(expectedRevision) ||
      !Number.isFinite(expectedGeneration) ||
      typeof snapshot?.exists !== 'boolean'
    ) {
      const error = new Error('无法取得世界书版本快照，已取消写入。');
      error.code = 'worldbook_snapshot_unavailable';
      throw error;
    }
    const result = await bridge.saveWorldInfo(target, data, {
      expectedRevision,
      expectedGeneration,
      expectedExists: snapshot.exists,
      conflictMode: 'return',
    });
    if (result?.conflict || result?.ok === false) {
      const error = new Error('世界书已被其他操作修改，请重新读取后重试。');
      error.code = String(result?.reason || 'worldbook_revision_conflict');
      error.details = result;
      throw error;
    }
    return true;
  };

  const listLorebookNames = async () => {
    const bridge = getParentBridge();
    const names = new Set();
    if (!bridge) return [];
    const add = (value) => {
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      const text = String(value || '').trim();
      if (text) names.add(text);
    };
    try {
      if (bridge.worldStore?.ready) await bridge.worldStore.ready;
    } catch {}
    try { add(bridge.worldStore?.list?.()); } catch {}
    try { add(bridge.getWorldIdsForSession?.(bridge.activeSessionId)); } catch {}
    try { add(bridge.currentWorldIds); } catch {}
    try { add(bridge.getWorldForSession?.(bridge.activeSessionId)); } catch {}
    try { add(bridge.currentWorldId); } catch {}
    return Array.from(names);
  };

  const readCurrentLorebookNames = () => {
    const bridge = getParentBridge();
    const names = [];
    const add = (value) => {
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      const text = String(value || '').trim();
      if (text && !names.includes(text)) names.push(text);
    };
    try { add(bridge?.getWorldIdsForSession?.(bridge.activeSessionId)); } catch {}
    try { add(bridge?.currentWorldIds); } catch {}
    try { add(bridge?.getWorldForSession?.(bridge.activeSessionId)); } catch {}
    try { add(bridge?.currentWorldId); } catch {}
    return names;
  };

  const filterLorebookEntries = (entries, options = {}) => {
    const list = (Array.isArray(entries) ? entries : []).map((entry, index) => normalizeLorebookEntry(entry, index));
    const filter = options?.filter && typeof options.filter === 'object' ? options.filter : null;
    if (!filter) return list;
    return list.filter((entry) => Object.entries(filter).every(([key, value]) => {
      if (value == null || value === '') return true;
      if (key === 'enabled') return Boolean(entry.enabled) === Boolean(value);
      if (key === 'disabled' || key === 'disable') return Boolean(entry.disable) === Boolean(value);
      const actual = entry[key];
      if (Array.isArray(value)) return value.some((item) => String(item) === String(actual));
      return String(actual) === String(value);
    }));
  };

  // 保留原生 DOM 查询语义：卡片常用 `if (getElementById(...))` 判断可选功能。
  // 酒馆宿主节点兼容必须像 send_textarea/send_but 一样显式创建，不能让任意缺失 ID 变成 truthy。
  const ensureSillyTavernApiCompat = () => {
    exposeGlobalCompatFunction('getLorebooks', async () => {
      try {
        if (typeof parent?.getLorebooks === 'function') return await parent.getLorebooks();
      } catch {}
      return await listLorebookNames();
    });

    exposeGlobalCompatFunction('getLorebookEntries', async (name, options = {}) => {
      try {
        if (typeof parent?.getLorebookEntries === 'function') return await parent.getLorebookEntries(name, options);
      } catch {}
      const data = await getStoredLorebook(name);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      return filterLorebookEntries(entries, options);
    });

    exposeGlobalCompatFunction('setLorebookEntries', async (name, entries = []) => {
      let parentSetter = null;
      try { parentSetter = typeof parent?.setLorebookEntries === 'function' ? parent.setLorebookEntries : null; } catch {}
      if (parentSetter) return await parentSetter.call(parent, name, entries);
      const target = String(name || '').trim();
      if (!target) return false;
      const snapshot = await getStoredLorebookSnapshot(target);
      const current = snapshot?.data ?? null;
      const existingEntries = Array.isArray(current?.entries) ? current.entries : [];
      const nextEntries = existingEntries.map((entry, index) => normalizeLorebookEntry(entry, index));
      const keyFor = (entry, index) => {
        const normalized = normalizeLorebookEntry(entry, index);
        return String(normalized.uid ?? normalized.id ?? normalized.comment ?? index);
      };
      const byKey = new Map(nextEntries.map((entry, index) => [keyFor(entry, index), index]));
      (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
        const normalized = normalizeLorebookEntry(entry, index);
        const key = keyFor(normalized, index);
        if (byKey.has(key)) {
          const prevIndex = byKey.get(key);
          nextEntries[prevIndex] = normalizeLorebookEntry({ ...nextEntries[prevIndex], ...normalized }, prevIndex);
        } else {
          byKey.set(key, nextEntries.length);
          nextEntries.push(normalized);
        }
      });
      const payload = {
        ...(current && typeof current === 'object' ? current : {}),
        name: current?.name || target,
        entries: nextEntries,
      };
      await saveStoredLorebook(target, payload, snapshot);
      return true;
    });

    exposeGlobalCompatFunction('getCharWorldbookNames', (characterName) => {
      const names = readCurrentLorebookNames();
      const fallback = String(characterName || '').trim();
      return {
        primary: names[0] || fallback || '',
        additional: names.length > 1 ? names.slice(1) : [],
      };
    });

    exposeGlobalCompatFunction('triggerSlash', async (command) => {
      const text = String(command || '');
      try {
        if (typeof parent?.triggerSlash === 'function') return await parent.triggerSlash(text);
      } catch {}
      const setInput = text.match(/^\/setinput\s+([\s\S]*)$/i);
      if (setInput) return postInputText(setInput[1] || '', { mode: 'replace', focus: true });
      return false;
    });
  };

  const isIgnorableNoise = (value) => /resizeobserver loop (limit exceeded|completed with (?:undelivered|delivered) notifications)/i.test(String(value || ''));

  const formatConsoleArg = (value) => {
    try {
      if (value instanceof Error) return value.stack || value.message || String(value);
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
      return JSON.stringify(value);
    } catch {
      try { return String(value); } catch { return '[unserializable]'; }
    }
  };

  const ensureRuntimeDiagnostics = () => {
    if (runtimeDiagnosticsInstalled) return;
    runtimeDiagnosticsInstalled = true;
    installManagedDocumentWriteCompat();
    installNestedSrcdocCompat();

    const c = window.console || {};
    const levels = ['error', 'warn', 'info', 'log', 'debug'];
    let sent = 0;
    const maxLogs = 80;
    levels.forEach((level) => {
      const orig = typeof c[level] === 'function' ? c[level].bind(c) : null;
      c[level] = (...args) => {
        try { orig?.(...args); } catch {}
        try {
          if (sent >= maxLogs) return;
          const text = (Array.isArray(args) ? args : []).map((a) => formatConsoleArg(a)).join(' ');
          if (!text || isIgnorableNoise(text)) return;
          sent += 1;
          sendDebug(level === 'log' || level === 'debug' ? 'info' : level, 'console-' + level + ' ' + text);
        } catch {}
      };
    });
    window.console = c;
    window.__CHATAPP_registerRuntimeBlobMeta = (url, descriptor = {}, code = '') => {
      rememberBlobMeta(url, descriptor, code);
      return url;
    };

    window.addEventListener('error', (ev) => {
      try {
        const target = ev?.target;
        if (target && target !== window) {
          const tag = String(target.tagName || '').toLowerCase();
          const attrSrc = String(target.getAttribute?.('src') || target.getAttribute?.('href') || '').trim();
          const src = String(target.currentSrc || target.src || target.href || '').trim();
          if (tag === 'img' && !attrSrc) return;
          if (src) {
            sendIframeError('resource-load-failed tag=' + tag + ' url=' + src);
            // 取证：资源加载失败也持久化（缺陷 #6c：CDN 依赖加载状态排查）。
            try {
              const key = '__chatapp_iframe_script_errors';
              const list = JSON.parse(localStorage.getItem(key) || '[]');
              list.push({ at: Date.now(), message: 'resource-load-failed tag=' + tag, file: compactText(src, 160), line: 0, col: 0 });
              while (list.length > 10) list.shift();
              localStorage.setItem(key, JSON.stringify(list));
            } catch {}
          }
          return;
        }
        const message = String(ev?.message || ev?.error?.message || 'iframe error');
        if (isIgnorableNoise(message)) return;
        const lineno = Number(ev?.lineno || 0);
        const colno = Number(ev?.colno || 0);
        const file = String(ev?.filename || '');
        try {
          const metaHit = Boolean(file && externalizedBlobMeta.has(file));
          if (metaHit) {
            const meta = externalizedBlobMeta.get(file) || {};
            const excerpt = buildBlobDebugExcerpt(meta.code || '', lineno, colno);
            const parts = [
              'blob-script-error',
              meta.label ? ('label=' + compactText(meta.label, 120)) : '',
              meta.kind ? ('kind=' + compactText(meta.kind, 40)) : '',
              meta.type ? ('type=' + compactText(meta.type, 40)) : '',
              meta.module ? 'module=1' : '',
              meta.babel ? 'babel=1' : '',
              excerpt,
            ].filter(Boolean).join(' ');
            sendDebug('warn', parts);
          }
          // 脚本错误现场持久化（同源 localStorage，跨 reload）：静态降级后仍可事后取证。
          try {
            const record = {
              at: Date.now(),
              message: compactText(message, 240),
              file: compactText(file, 160),
              line: lineno,
              col: colno,
              stack: compactText(String(ev?.error?.stack || ''), 900),
              metaHit: metaHit ? 1 : 0,
              metaKeys: Array.from(externalizedBlobMeta.keys()).slice(-4).map((k) => compactText(k, 90)),
              excerpt: metaHit ? buildBlobDebugExcerpt((externalizedBlobMeta.get(file) || {}).code || '', lineno, colno).slice(0, 900) : '',
              label: metaHit ? compactText((externalizedBlobMeta.get(file) || {}).label || '', 120) : '',
            };
            const key = '__chatapp_iframe_script_errors';
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            list.push(record);
            while (list.length > 10) list.shift();
            localStorage.setItem(key, JSON.stringify(list));
          } catch {}
        } catch {}
        const extra = [
          file ? ('file=' + file) : '',
          lineno ? ('line=' + lineno) : '',
          colno ? ('col=' + colno) : '',
        ].filter(Boolean).join(' ');
        sendIframeError(extra ? (message + ' ' + extra) : message);
      } catch {}
    }, true);

    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const reason = ev?.reason;
        const msg = reason?.message ? String(reason.message) : String(reason || 'unhandledrejection');
        if (isIgnorableNoise(msg)) return;
        sendIframeError('unhandledrejection ' + msg);
      } catch {}
    });

    document.addEventListener('securitypolicyviolation', (ev) => {
      try {
        const directive = compactText(ev?.violatedDirective || ev?.effectiveDirective || '', 120);
        const blocked = compactText(ev?.blockedURI || '', 220);
        const sample = compactText(ev?.sample || '', 180);
        const disposition = compactText(ev?.disposition || '', 40);
        const parts = [
          'csp-violation',
          directive ? ('directive=' + directive) : '',
          blocked ? ('blocked=' + blocked) : '',
          sample ? ('sample=' + sample) : '',
          disposition ? ('disposition=' + disposition) : '',
        ].filter(Boolean);
        sendIframeError(parts.join(' '));
      } catch {}
    });

    document.addEventListener('click', (ev) => {
      try {
        const anchor = typeof ev?.target?.closest === 'function' ? ev.target.closest('a[href]') : null;
        const href = String(anchor?.getAttribute?.('href') || '').trim();
        if (!/^javascript:/i.test(href)) return;
        sendIframeError('javascript-url-click href=' + compactText(href, 220));
      } catch {}
    }, true);
  };

  const isAllowedResourceUrl = (url, { allowRemoteHttp = false } = {}) => {
    const value = String(url || '').trim();
    if (!value) return false;
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
    if (!isAbsolute) return true;
    if (/^(data:|blob:|asset:|tauri:|file:)/i.test(value)) return true;
    return Boolean(allowRemoteHttp) && /^https?:/i.test(value);
  };

  const rewriteVendorResourceUrl = (url) => {
    const value = String(url || '').trim();
    if (!value) return value;
    if (fontAwesomeCdnCssRe.test(value)) return FONT_AWESOME_LOCAL_CSS_PATH;
    return value;
  };

  const syncElementAttributes = (target, source) => {
    if (!target) return;
    Array.from(target.attributes || []).forEach((attr) => {
      target.removeAttribute(attr.name);
    });
    if (!source) return;
    Array.from(source.attributes || []).forEach((attr) => {
      try {
        target.setAttribute(attr.name, attr.value);
      } catch {}
    });
  };

  const clearManagedHeadNodes = () => {
    document.head.querySelectorAll('[data-chatapp-head-node]').forEach((node) => node.remove());
  };

  const compactText = (value, maxLen = 120) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.slice(0, Math.max(0, maxLen - 1)) + '…';
  };

  const createScriptStats = () => ({
    nextIndex: 0,
    total: 0,
    head: 0,
    body: 0,
    external: 0,
    inline: 0,
    externalized: 0,
    module: 0,
    babel: 0,
    blocked: 0,
    loaded: 0,
    failed: 0,
  });

  const createInlineBehaviorStats = () => ({
    total: 0,
    eventAttrs: 0,
    javascriptUrls: 0,
    neutralizedUrls: 0,
    bound: 0,
    failed: 0,
  });

  const describeScriptNode = (node, position, index) => {
    const src = String(node?.getAttribute?.('src') || '').trim();
    const type = String(node?.getAttribute?.('type') || '').trim().toLowerCase();
    const asyncAttr = node?.hasAttribute?.('async') ? 1 : 0;
    const deferAttr = node?.hasAttribute?.('defer') ? 1 : 0;
    const kind = src ? 'external' : 'inline';
    const isModule = type === 'module';
    const isBabel = /babel|jsx|tsx/.test(type);
    const preview = src
      ? 'src=' + compactText(src, 220)
      : 'preview=' + compactText(node?.textContent || '', 140);
    const flags = [
      'script#' + index,
      'pos=' + position,
      'kind=' + kind,
      type ? ('type=' + type) : '',
      asyncAttr ? 'async=1' : '',
      deferAttr ? 'defer=1' : '',
      isModule ? 'module=1' : '',
      isBabel ? 'babel=1' : '',
      preview,
    ].filter(Boolean);
    return {
      src,
      type,
      kind,
      isModule,
      isBabel,
      position,
      index,
      label: flags.join(' '),
    };
  };

  const noteScriptStats = (stats, descriptor) => {
    if (!stats || !descriptor) return;
    stats.total += 1;
    if (descriptor.position === 'head') stats.head += 1;
    else stats.body += 1;
    if (descriptor.kind === 'external') stats.external += 1;
    else stats.inline += 1;
    if (descriptor.isModule) stats.module += 1;
    if (descriptor.isBabel) stats.babel += 1;
  };

  const formatScriptStats = (stats) => {
    if (!stats) return 'scripts total=0';
    return [
      'scripts',
      'total=' + Number(stats.total || 0),
      'head=' + Number(stats.head || 0),
      'body=' + Number(stats.body || 0),
      'external=' + Number(stats.external || 0),
      'inline=' + Number(stats.inline || 0),
      'externalized=' + Number(stats.externalized || 0),
      'module=' + Number(stats.module || 0),
      'babel=' + Number(stats.babel || 0),
      'blocked=' + Number(stats.blocked || 0),
      'loaded=' + Number(stats.loaded || 0),
      'failed=' + Number(stats.failed || 0),
    ].join(' ');
  };

  const formatInlineBehaviorStats = (stats) => {
    if (!stats) return 'inline-behaviors total=0';
    return [
      'inline-behaviors',
      'total=' + Number(stats.total || 0),
      'eventAttrs=' + Number(stats.eventAttrs || 0),
      'javascriptUrls=' + Number(stats.javascriptUrls || 0),
      'neutralizedUrls=' + Number(stats.neutralizedUrls || 0),
      'bound=' + Number(stats.bound || 0),
      'failed=' + Number(stats.failed || 0),
    ].join(' ');
  };

  const isExecutableScriptType = (type) => {
    const raw = String(type || '').trim().toLowerCase();
    if (!raw) return true;
    if (raw === 'module') return true;
    return /^(?:text|application)\/(?:javascript|ecmascript|babel|jsx|tsx|typescript)$/.test(raw);
  };

  const rememberBlobUrl = (url, bucket = managedBlobUrls) => {
    const value = String(url || '').trim();
    if (!value) return '';
    try { bucket.add(value); } catch {}
    return value;
  };

  const releaseBlobUrls = (bucket) => {
    try {
      Array.from(bucket || []).forEach((url) => {
        try { URL.revokeObjectURL(url); } catch {}
        try { externalizedBlobMeta.delete(String(url || '')); } catch {}
      });
      bucket?.clear?.();
    } catch {}
  };

  const toBlobScriptUrl = (code, descriptor, bucket = managedBlobUrls) => {
    try {
      const mime = descriptor?.isModule ? 'text/javascript' : 'text/javascript';
      const source = String(code || '');
      const debugName = `chatapp-${getBlobDebugName(descriptor)}.js`;
      const trailer = `\n//# sourceURL=${debugName}`;
      const blobUrl = rememberBlobUrl(URL.createObjectURL(new Blob([source + trailer], { type: mime })), bucket);
      rememberBlobMeta(blobUrl, descriptor, source);
      // 错误事件的 filename 是 sourceURL 名而非 blob URL：双键注册保证 excerpt 可命中。
      rememberBlobMeta(debugName, descriptor, source);
      return blobUrl;
    } catch {
      return '';
    }
  };

  const shouldPreferFetchedRemoteScript = (url, descriptor = {}) => {
    try {
      if (descriptor?.isModule) return false;
      const parsed = new URL(String(url || ''), window.location.href);
      if (!/^https?:$/i.test(parsed.protocol)) return false;
      const host = String(parsed.hostname || '').trim().toLowerCase();
      if (!host) return false;
      return host === 'drive.baibai.cv';
    } catch {
      return false;
    }
  };

  const uniqueUrls = (urls) => {
    const seen = new Set();
    return (Array.isArray(urls) ? urls : [])
      .map((url) => String(url || '').trim())
      .filter((url) => {
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
  };

  const getKnownRuntimeScriptFallbackUrls = (url) => {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) return [];
    try {
      const parsed = new URL(rawUrl, window.location.href);
      if (!/^https?:$/i.test(parsed.protocol)) return [rawUrl];
      const host = String(parsed.hostname || '').toLowerCase();
      const knownCdn = /(?:^|\.)unpkg\.com$|(?:^|\.)jsdelivr\.net$|(?:^|\.)testingcf\.jsdelivr\.net$/i.test(host);
      if (!knownCdn) return [rawUrl];
      const pathname = decodeURIComponent(String(parsed.pathname || ''));
      const reactMatch = pathname.match(/\/(?:npm\/)?(react(?:-dom)?)@?([^/]*)\/umd\/(react(?:-dom)?\.(?:development|production\.min)\.js)$/i);
      if (reactMatch) {
        const pkg = String(reactMatch[1] || '').toLowerCase();
        const version = String(reactMatch[2] || '18').replace(/^@/, '') || '18';
        const file = String(reactMatch[3] || '');
        return uniqueUrls([
          rawUrl,
          `https://testingcf.jsdelivr.net/npm/${pkg}@${version}/umd/${file}`,
          `https://cdn.jsdelivr.net/npm/${pkg}@${version}/umd/${file}`,
          `https://unpkg.com/${pkg}@${version}/umd/${file}`,
        ]);
      }
      const babelMatch = pathname.match(/\/(?:npm\/)?@babel\/standalone(?:@([^/]+))?\/(babel(?:\.min)?\.js)$/i);
      if (babelMatch) {
        const version = String(babelMatch[1] || '').trim();
        const suffix = version ? `@${version}` : '';
        const file = String(babelMatch[2] || 'babel.min.js');
        return uniqueUrls([
          rawUrl,
          `https://testingcf.jsdelivr.net/npm/@babel/standalone${suffix}/${file}`,
          `https://cdn.jsdelivr.net/npm/@babel/standalone${suffix}/${file}`,
          `https://unpkg.com/@babel/standalone${suffix}/${file}`,
        ]);
      }
    } catch {}
    return [rawUrl];
  };

  const fetchRemoteScriptText = async (url) => {
    const key = String(url || '').trim();
    if (!key) throw new Error('empty-remote-script-url');
    if (remoteScriptTextCache.has(key)) return remoteScriptTextCache.get(key);
    const task = (async () => {
      const response = await fetch(key, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'default',
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      const contentType = String(response.headers.get('content-type') || '').trim().toLowerCase();
      const text = await response.text();
      const trimmed = String(text || '').trim();
      if (!trimmed) throw new Error('empty-remote-script-body');
      if (/text\/html|application\/json/.test(contentType)) {
        throw new Error(`unexpected-content-type:${contentType}`);
      }
      if (/^<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
        throw new Error('unexpected-html-body');
      }
      return text;
    })();
    remoteScriptTextCache.set(key, task);
    try {
      return await task;
    } catch (err) {
      remoteScriptTextCache.delete(key);
      throw err;
    }
  };

  const resolveRemoteScriptSrc = async (url, descriptor, bucket = managedBlobUrls) => {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) return { src: '', proxied: false };
    if (!shouldPreferFetchedRemoteScript(rawUrl, descriptor)) {
      return { src: rawUrl, proxied: false };
    }
    try {
      const source = await fetchRemoteScriptText(rawUrl);
      const blobUrl = toBlobScriptUrl(source, {
        ...descriptor,
        kind: 'external-fetched',
        type: 'text/javascript',
        isModule: false,
      }, bucket);
      if (!blobUrl) throw new Error('blob-url-create-failed');
      return { src: blobUrl, proxied: true };
    } catch (err) {
      return {
        src: rawUrl,
        proxied: false,
        error: err instanceof Error ? err : new Error(String(err || 'remote-script-proxy-failed')),
      };
    }
  };

  const normalizeExecutableScriptSource = (code) => {
    try {
      const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
      const normalized = [];
      let previousNonEmpty = '';
      let hasOpenTemplateLiteral = false;
      // Only guard true ASI hazards like a new-line IIFE / array / template literal.
      // Do not treat leading "." as risky: that breaks合法的链式调用（.then/.finally/.classList...）。
      const riskyStartRe = /^[([`]/;
      // Preserve valid continuations such as `value +\n(expr ? a : b)`.
      const safePrevEndRe = /(?:[;{[(,:?=><!&|/^~]|(?:\+\+|--|[+\-*%]))\s*$/;
      const keywordPrevRe = /\b(?:return|throw|case|delete|typeof|void|new|in|instanceof|await|yield)\s*$/;
      // 行尾注释会挡住真实的行尾符号（如 `foo(), // state` 实际以逗号结尾）：
      // 判断前粗剥 `//` 之后的内容。字符串内 '//'（如 URL）被误剥只会让判断偏向
      // “safe 不插分号”——与“原代码本可运行”的事实一致，方向安全。
      const stripLineComment = (line) => {
        const idx = String(line || '').indexOf('//');
        return idx >= 0 ? String(line || '').slice(0, idx) : String(line || '');
      };
      const countUnescapedBackticks = (line) => {
        const value = String(line || '');
        let count = 0;
        for (let index = 0; index < value.length; index += 1) {
          if (value[index] !== '`') continue;
          let slashCount = 0;
          for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
            slashCount += 1;
          }
          if (slashCount % 2 === 0) count += 1;
        }
        return count;
      };
      lines.forEach((line) => {
        const trimmed = String(line || '').trim();
        const closesOpenTemplateLiteral = hasOpenTemplateLiteral && trimmed.startsWith('`');
        if (trimmed && riskyStartRe.test(trimmed) && previousNonEmpty && !closesOpenTemplateLiteral) {
          const prev = stripLineComment(previousNonEmpty).replace(/\s+$/, '');
          if (prev && !safePrevEndRe.test(prev) && !keywordPrevRe.test(prev)) {
            normalized.push(';');
          }
        }
        normalized.push(line);
        if (countUnescapedBackticks(line) % 2 === 1) {
          hasOpenTemplateLiteral = !hasOpenTemplateLiteral;
        }
        if (trimmed) previousNonEmpty = line;
      });
      return normalized.join('\n');
    } catch {
      return String(code || '');
    }
  };

  const parseCsvAttr = (value) => String(value || '')
    .split(/[,\s]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const buildBabelBootstrapCode = (code, descriptor, node) => {
    try {
      const source = normalizeExecutableScriptSource(code);
      const attrPresets = parseCsvAttr(node?.getAttribute?.('data-presets'));
      const attrPlugins = parseCsvAttr(node?.getAttribute?.('data-plugins'));
      const rawType = String(descriptor?.type || '').trim().toLowerCase();
      const parserPlugins = rawType.includes('tsx')
        ? ['jsx', 'typescript', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait']
        : rawType.includes('typescript')
          ? ['typescript', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait']
          : ['jsx', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait'];
      const defaultPresets = rawType.includes('tsx')
        ? ['typescript', 'react']
        : rawType.includes('typescript')
          ? ['typescript']
          : ['react'];
      const presets = attrPresets.length ? attrPresets : defaultPresets;
      const plugins = attrPlugins;
      const label = String(descriptor?.label || 'babel-script');
      const needsReactRuntime = /\bReact\b|React\.createElement\s*\(|<\s*[A-Z][\w.:]*(?:\s|\/?>)|<\s*[a-z][\w:-]*[^>]*\/>/i.test(source);
      const needsReactDomRuntime = /\bReactDOM\b|createRoot\s*\(/i.test(source);
      return [
        '(() => {',
        `  const __chatappBabelSource = ${JSON.stringify(source)};`,
        `  const __chatappBabelPresets = ${JSON.stringify(presets)};`,
        `  const __chatappBabelPlugins = ${JSON.stringify(plugins)};`,
        `  const __chatappBabelParserPlugins = ${JSON.stringify(parserPlugins)};`,
        `  const __chatappBabelLabel = ${JSON.stringify(label)};`,
        `  const __chatappBabelNeedsReact = ${needsReactRuntime ? 'true' : 'false'};`,
        `  const __chatappBabelNeedsReactDOM = ${needsReactDomRuntime ? 'true' : 'false'};`,
        '  const resolveNamedEntry = (table, entry) => {',
        '    if (typeof entry !== "string") return entry;',
        '    const key = String(entry || "").trim();',
        '    if (!key) return entry;',
        '    try {',
        '      if (table && typeof table === "object" && Object.prototype.hasOwnProperty.call(table, key) && table[key]) return table[key];',
        '    } catch {}',
        '    return entry;',
        '  };',
        '  const resolvePresetEntries = () => __chatappBabelPresets.map((entry) => resolveNamedEntry(window.Babel && window.Babel.availablePresets, entry));',
        '  const resolvePluginEntries = () => __chatappBabelPlugins.map((entry) => resolveNamedEntry(window.Babel && window.Babel.availablePlugins, entry));',
        '  const buildExcerpt = (line, column) => {',
        '    try {',
        '      const rows = String(__chatappBabelSource || "").replace(/\\r\\n?/g, "\\n").split("\\n");',
        '      const idx = Math.max(0, Number(line || 1) - 1);',
        '      const pick = (offset) => {',
        '        const value = rows[idx + offset];',
        '        return typeof value === "string" ? value : "";',
        '      };',
        '      const prev = pick(-1).trim();',
        '      const target = pick(0).trim();',
        '      const next = pick(1).trim();',
        '      return [',
        '        line ? ("loc=" + Number(line || 0) + ":" + Number(column || 0)) : "",',
        '        prev ? ("prev=" + prev) : "",',
        '        target ? ("line=" + target) : "",',
        '        next ? ("next=" + next) : "",',
        '      ].filter(Boolean).join(" ");',
        '    } catch {',
        '      return "";',
        '    }',
        '  };',
        '  const runCompiled = (compiledCode) => {',
        '    const js = String(compiledCode || "").trim();',
        '    if (!js) throw new Error("empty-babel-output");',
        '    console.debug("[iframe] babel-transform-ok", __chatappBabelLabel, "compiledLen=" + js.length);',
        '    const blobUrl = URL.createObjectURL(new Blob([js + "\\n//# sourceURL=chatapp-babel-compiled-" + (__chatappBabelLabel || "inline") + ".js"], { type: "text/javascript" }));',
        '    try {',
        '      if (typeof window.__CHATAPP_registerRuntimeBlobMeta === "function") {',
        '        window.__CHATAPP_registerRuntimeBlobMeta(blobUrl, { label: __chatappBabelLabel + ":compiled", kind: "babel-compiled", type: "text/javascript", isBabel: true }, js);',
        '      }',
        '    } catch {}',
        '    const script = document.createElement("script");',
        '    script.async = false;',
        '    script.src = blobUrl;',
        '    script.addEventListener("load", () => {',
        '      console.debug("[iframe] babel-compiled-load-ok", __chatappBabelLabel);',
        '      try { URL.revokeObjectURL(blobUrl); } catch {}',
        '    }, { once: true });',
        '    script.addEventListener("error", () => {',
        '      try { URL.revokeObjectURL(blobUrl); } catch {}',
        '      console.error("[iframe] babel-compiled-load-failed", __chatappBabelLabel);',
        '    }, { once: true });',
        '    console.debug("[iframe] babel-compiled-append", __chatappBabelLabel);',
        '    (document.body || document.documentElement || document.head).appendChild(script);',
        '  };',
        '  const isReactRuntimeReady = () => (!__chatappBabelNeedsReact || Boolean(window.React)) && (!__chatappBabelNeedsReactDOM || Boolean(window.ReactDOM));',
        '  let reactRuntimeWaitAttached = false;',
        '  const waitForReactRuntime = () => {',
        '    if (isReactRuntimeReady()) return true;',
        '    const ready = window.__CHATAPP_REACT_READY__;',
        '    if (!reactRuntimeWaitAttached && ready && typeof ready.then === "function") {',
        '      reactRuntimeWaitAttached = true;',
        '      ready.then(() => setTimeout(tick, 0), () => setTimeout(tick, 0));',
        '    }',
        '    return false;',
        '  };',
        '  const tryCompile = () => {',
        '    if (!window.Babel || typeof window.Babel.transform !== "function") return false;',
        '    if (!waitForReactRuntime()) return false;',
        '    const resolvedPresets = resolvePresetEntries();',
        '    const resolvedPlugins = resolvePluginEntries();',
        '    const result = window.Babel.transform(__chatappBabelSource, {',
        '      presets: resolvedPresets,',
        '      plugins: resolvedPlugins,',
        '      parserOpts: { plugins: __chatappBabelParserPlugins },',
        '      sourceType: "script",',
        '      filename: __chatappBabelLabel || "chatapp-babel-inline.jsx",',
        '    });',
        '    runCompiled(result?.code || "");',
        '    return true;',
        '  };',
        '  let retries = 120;',
        '  const tick = () => {',
        '    try {',
        '      if (tryCompile()) return;',
        '    } catch (err) {',
        '      const excerpt = buildExcerpt(err?.loc?.line, err?.loc?.column);',
        '      console.error("[iframe] babel-transform-failed", __chatappBabelLabel, "presets=" + JSON.stringify(__chatappBabelPresets), "plugins=" + JSON.stringify(__chatappBabelPlugins), "parser=" + JSON.stringify(__chatappBabelParserPlugins), excerpt, err);',
        '      return;',
        '    }',
        '    if (retries-- <= 0) {',
        '      console.error("[iframe] babel-runtime-timeout", __chatappBabelLabel);',
        '      return;',
        '    }',
        '    setTimeout(tick, 50);',
        '  };',
        '  tick();',
        '})();',
      ].join('\n');
    } catch {
      return String(code || '');
    }
  };

  const createManagedWriteMeta = (script, parent, descriptor) => ({
    script,
    parent,
    descriptor,
    container: null,
    insertedNodes: [],
    buffer: '',
    buffering: false,
  });

  const clearManagedWriteNodes = (meta) => {
    if (!meta || !meta.container) return;
    try { meta.container.innerHTML = ''; } catch {}
    meta.insertedNodes = [];
  };

  const ensureManagedWriteContainer = (meta) => {
    if (!meta) return null;
    const existing = meta.container;
    if (existing && existing.isConnected) return existing;
    const hostParent = document.body || document.documentElement;
    if (!hostParent) return null;
    const container = document.createElement('div');
    container.style.display = 'contents';
    container.setAttribute('data-chatapp-write-container', '1');
    const scriptParent = meta.script?.parentNode;
    if (scriptParent === document.body && meta.script?.nextSibling) {
      document.body.insertBefore(container, meta.script.nextSibling);
    } else if (scriptParent === document.body) {
      document.body.appendChild(container);
    } else {
      hostParent.appendChild(container);
    }
    meta.container = container;
    return container;
  };

  let inlineBehaviorSeq = 0;
  const nextInlineBehaviorId = () => {
    inlineBehaviorSeq += 1;
    return 'bind-' + String(inlineBehaviorSeq);
  };

  const registerInlineBehavior = (bindings, stats, el, kind, payload = {}) => {
    if (!bindings || !Array.isArray(bindings) || !el) return;
    const bindId = String(el.getAttribute('data-chatapp-bind-id') || nextInlineBehaviorId());
    try {
      el.setAttribute('data-chatapp-bind-id', bindId);
    } catch {}
    const entry = { bindId, kind, ...payload };
    bindings.push(entry);
    if (stats) {
      stats.total += 1;
      if (kind === 'event') stats.eventAttrs += 1;
      if (kind === 'javascript-url') stats.javascriptUrls += 1;
      if (kind === 'javascript-url-neutralized') stats.neutralizedUrls += 1;
    }
  };

  const bindDeferredInlineBehaviors = (bindings, stats) => {
    if (!Array.isArray(bindings) || !bindings.length) return;
    bindings.forEach((binding) => {
      try {
        const bindId = String(binding?.bindId || '').trim();
        if (!bindId) return;
        const el = document.querySelector(`[data-chatapp-bind-id="${bindId}"]`);
        if (!el) return;
        if (binding.kind === 'event') {
          const eventName = String(binding.eventName || '').trim().toLowerCase();
          const code = String(binding.code || '');
          if (!eventName || !code) return;
          const runner = new Function('event', 'element', code);
          el.addEventListener(eventName, function onInlineBehavior(event) {
            const result = runner.call(this, event, this);
            if (result === false) {
              try { event.preventDefault(); } catch {}
              try { event.stopPropagation(); } catch {}
            }
          }, true);
          if (stats) stats.bound += 1;
          sendDebug('info', `inline-handler-bound bind=${bindId} event=${eventName}`);
          return;
        }
        if (binding.kind === 'javascript-url') {
          const code = String(binding.code || '').trim();
          if (!code) return;
          const runner = new Function('event', 'element', code);
          el.addEventListener('click', function onJavascriptUrl(event) {
            try { event.preventDefault(); } catch {}
            const result = runner.call(this, event, this);
            if (result === false) {
              try { event.stopPropagation(); } catch {}
            }
          }, true);
          if (stats) stats.bound += 1;
          sendDebug('info', `javascript-url-bound bind=${bindId}`);
          return;
        }
        if (binding.kind === 'javascript-url-neutralized') {
          el.addEventListener('click', function onJavascriptVoid(event) {
            try { event.preventDefault(); } catch {}
          }, true);
          if (stats) stats.bound += 1;
          sendDebug('info', `javascript-url-neutralized bind=${bindId}`);
        }
      } catch (err) {
        if (stats) stats.failed += 1;
        sendIframeError('inline-behavior-bind-failed err=' + String(err?.message || err || 'unknown'));
      }
    });
  };

  const dispatchSyntheticReadyEvents = () => {
    try {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    } catch {}
    try {
      window.dispatchEvent(new Event('load'));
    } catch {}
  };

  const installManagedDocumentWriteCompat = () => {
    if (document.__chatappManagedWriteInstalled) return;
    document.__chatappManagedWriteInstalled = true;
    const nativeOpen = typeof document.open === 'function' ? document.open.bind(document) : null;
    const nativeClose = typeof document.close === 'function' ? document.close.bind(document) : null;
    const nativeWrite = typeof document.write === 'function' ? document.write.bind(document) : null;
    const nativeWriteln = typeof document.writeln === 'function' ? document.writeln.bind(document) : null;

    const resolveManagedWriteMeta = () => {
      try {
        const currentScript = document.currentScript;
        if (currentScript && managedScriptMeta.has(currentScript)) {
          return managedScriptMeta.get(currentScript);
        }
      } catch {}
      return null;
    };

    const flushManagedWriteBuffer = (meta) => {
      if (!meta) return false;
      const html = String(meta.buffer || '');
      meta.buffer = '';
      if (!html) return true;
      try {
        const parser = new DOMParser();
        const parsed = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
        const nodes = Array.from(parsed.body?.childNodes || []);
        const container = ensureManagedWriteContainer(meta);
        if (!container) return false;
        const scriptTasks = [];
        const scriptStats = createScriptStats();
        const inlineBehaviorBindings = [];
        const inlineBehaviorStats = createInlineBehaviorStats();
        nodes.forEach((node) => {
          const inserted = appendManagedNode(node, container, {
            allowScripts: true,
            inHead: false,
            scriptTasks,
            scriptStats,
            inlineBehaviorBindings,
            inlineBehaviorStats,
          });
          if (inserted) meta.insertedNodes.push(inserted);
        });
        bindDeferredInlineBehaviors(inlineBehaviorBindings, inlineBehaviorStats);
        if (scriptStats.total > 0) {
          sendDebug('info', 'write-flush ' + formatScriptStats(scriptStats));
        }
        if (inlineBehaviorStats.total > 0) {
          sendDebug('info', 'write-flush ' + formatInlineBehaviorStats(inlineBehaviorStats));
        }
        Promise.allSettled(Array.isArray(scriptTasks) ? scriptTasks : []).finally(() => {
          if (scriptStats.total > 0) {
            sendDebug('info', 'write-script-settled ' + formatScriptStats(scriptStats));
            dispatchSyntheticReadyEvents();
          }
          forceNextResize = true;
          requestLayout('observer', true);
        });
        forceNextResize = true;
        requestLayout('observer', true);
        return true;
      } catch (err) {
        sendIframeError('document-write-flush-failed err=' + String(err?.message || err || 'unknown'));
        return false;
      }
    };

    document.open = (...args) => {
      const meta = resolveManagedWriteMeta();
      if (!meta) return nativeOpen ? nativeOpen(...args) : document;
      meta.buffering = true;
      meta.buffer = '';
      clearManagedWriteNodes(meta);
      sendDebug('info', 'document-open-managed');
      return document;
    };
    document.close = (...args) => {
      const meta = resolveManagedWriteMeta();
      if (!meta) return nativeClose ? nativeClose(...args) : undefined;
      meta.buffering = false;
      flushManagedWriteBuffer(meta);
      sendDebug('info', 'document-close-managed');
      return undefined;
    };
    document.write = (...args) => {
      const meta = resolveManagedWriteMeta();
      const html = args.map((part) => String(part ?? '')).join('');
      if (!meta) return nativeWrite ? nativeWrite(...args) : undefined;
      if (meta.buffering) {
        meta.buffer += html;
      } else {
        meta.buffer = html;
        flushManagedWriteBuffer(meta);
      }
      sendDebug('info', `document-write-managed len=${Number(html.length || 0)}`);
      return undefined;
    };
    document.writeln = (...args) => {
      const parts = Array.isArray(args) ? args.slice() : [];
      parts.push('\n');
      const meta = resolveManagedWriteMeta();
      if (!meta) return nativeWriteln ? nativeWriteln(...parts) : undefined;
      return document.write(...parts);
    };
  };

  const rewriteNestedSrcdocHtml = (html) => {
    const raw = String(html || '');
    if (!raw) return raw;
    try {
      const parser = new DOMParser();
      const parsed = parser.parseFromString(raw, 'text/html');
      let rewritten = 0;
      Array.from(parsed.querySelectorAll('script')).forEach((scriptNode) => {
        const src = String(scriptNode.getAttribute('src') || '').trim();
        if (src) return;
        const type = String(scriptNode.getAttribute('type') || '').trim().toLowerCase();
        if (!isExecutableScriptType(type)) return;
        const code = String(scriptNode.textContent || '');
        if (!code.trim()) return;
        const blobUrl = toBlobScriptUrl(code, {
          isModule: type === 'module',
          type,
        }, nestedSrcdocBlobUrls);
        if (!blobUrl) return;
        scriptNode.textContent = '';
        scriptNode.setAttribute('src', blobUrl);
        rewritten += 1;
      });
      if (rewritten > 0) {
        sendDebug('info', `srcdoc-inline-externalized count=${rewritten}`);
      }
      return parsed.documentElement?.outerHTML || raw;
    } catch (err) {
      sendIframeError('srcdoc-rewrite-failed err=' + String(err?.message || err || 'unknown'));
      return raw;
    }
  };

  const installNestedSrcdocCompat = () => {
    if (nestedSrcdocCompatInstalled) return;
    nestedSrcdocCompatInstalled = true;
    try {
      const proto = HTMLIFrameElement?.prototype;
      if (!proto) return;
      const srcdocDesc = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
      if (srcdocDesc && typeof srcdocDesc.set === 'function') {
        Object.defineProperty(proto, 'srcdoc', {
          configurable: true,
          enumerable: srcdocDesc.enumerable,
          get: srcdocDesc.get ? function getSrcdoc() {
            return srcdocDesc.get.call(this);
          } : undefined,
          set(value) {
            const next = rewriteNestedSrcdocHtml(value);
            return srcdocDesc.set.call(this, next);
          },
        });
      }
      const nativeSetAttribute = proto.setAttribute;
      if (typeof nativeSetAttribute === 'function' && !proto.__chatappSrcdocSetAttributePatched) {
        proto.setAttribute = function patchedSetAttribute(name, value) {
          if (String(name || '').toLowerCase() === 'srcdoc') {
            return nativeSetAttribute.call(this, name, rewriteNestedSrcdocHtml(value));
          }
          return nativeSetAttribute.call(this, name, value);
        };
        proto.__chatappSrcdocSetAttributePatched = true;
      }
    } catch (err) {
      sendIframeError('srcdoc-compat-install-failed err=' + String(err?.message || err || 'unknown'));
    }
  };

  const appendScriptNode = (node, target, scriptTasks, scriptStats) => {
    try {
      const position = target === document.head ? 'head' : 'body';
      const index = Number((scriptStats?.nextIndex || 0) + 1);
      if (scriptStats) scriptStats.nextIndex = index;
      const descriptor = describeScriptNode(node, position, index);
      noteScriptStats(scriptStats, descriptor);
      sendDebug('info', 'script-plan ' + descriptor.label);

      const script = document.createElement('script');
      Array.from(node.attributes || []).forEach((attr) => {
        if (attr.name === 'src') return;
        try { script.setAttribute(attr.name, attr.value); } catch {}
      });
      if (!descriptor.src && isExecutableScriptType(descriptor.type)) {
        script.type = descriptor.isModule ? 'module' : 'text/javascript';
      }
      managedScriptMeta.set(script, createManagedWriteMeta(script, target, descriptor));
      if (descriptor.src) {
        if (script.type !== 'module') script.async = false;
        scriptTasks.push(new Promise((resolve) => {
          let finalized = false;
          let candidateIndex = 0;
          let activeCandidate = '';
          const candidates = getKnownRuntimeScriptFallbackUrls(descriptor.src);
          const finalize = (ok) => {
            if (finalized) return;
            finalized = true;
            resolve(ok);
          };
          const loadNextCandidate = async () => {
            if (finalized) return;
            const candidate = String(candidates[candidateIndex++] || '').trim();
            if (!candidate) {
              if (scriptStats) scriptStats.blocked += 1;
              sendDebug('warn', 'script-src-blocked ' + descriptor.label);
              finalize(false);
              return;
            }
            activeCandidate = candidate;
            if (!isAllowedResourceUrl(candidate, { allowRemoteHttp: true })) {
              sendDebug('warn', 'script-src-blocked ' + descriptor.label + ' candidate=' + compactText(candidate, 220));
              loadNextCandidate();
              return;
            }
            try {
              const resolved = await resolveRemoteScriptSrc(candidate, descriptor);
              if (finalized) return;
              if (resolved?.proxied) {
                if (scriptStats) scriptStats.externalized += 1;
                script.dataset.chatappRemoteProxy = '1';
                sendDebug('info', 'script-remote-proxied ' + descriptor.label + ' src=' + compactText(candidate, 220));
              } else if (resolved?.error) {
                sendDebug('warn', 'script-remote-proxy-failed ' + descriptor.label + ' err=' + compactText(resolved.error?.message || resolved.error || 'unknown', 220));
              } else {
                try { delete script.dataset.chatappRemoteProxy; } catch {}
              }
              script.async = false;
              script.src = String(resolved?.src || candidate || '');
              const fallbackNote = candidate === descriptor.src ? '' : ' fallback=' + compactText(candidate, 220);
              sendDebug('info', 'script-load-start ' + descriptor.label + fallbackNote + (resolved?.proxied ? ' proxied=1' : ''));
            } catch (err) {
              sendDebug('warn', 'script-load-prepare-failed ' + descriptor.label + ' err=' + compactText(err?.message || err || 'unknown', 220));
              if (candidateIndex < candidates.length) {
                loadNextCandidate();
                return;
              }
              script.async = false;
              script.src = candidate;
              sendDebug('info', 'script-load-start ' + descriptor.label);
            }
          };
          script.addEventListener('load', () => {
            if (scriptStats) scriptStats.loaded += 1;
            sendDebug('info', 'script-load-ok ' + descriptor.label + (script.dataset.chatappRemoteProxy === '1' ? ' proxied=1' : ''));
            finalize(true);
          });
          script.addEventListener('error', () => {
            if (candidateIndex < candidates.length) {
              sendDebug('warn', 'script-load-failed-try-next ' + descriptor.label + ' src=' + compactText(activeCandidate, 220));
              loadNextCandidate();
              return;
            }
            if (scriptStats) scriptStats.failed += 1;
            sendIframeError('resource-load-failed tag=script ' + descriptor.label);
            finalize(false);
          });
          loadNextCandidate();
        }));
      } else {
        const rawCode = String(node.textContent || '');
        const code = descriptor.isBabel
          ? buildBabelBootstrapCode(rawCode, descriptor, node)
          : normalizeExecutableScriptSource(rawCode);
        const executable = isExecutableScriptType(descriptor.type);
        if (executable && code) {
          const blobUrl = toBlobScriptUrl(code, descriptor);
          if (blobUrl) {
            if (scriptStats) scriptStats.externalized += 1;
            if (script.type !== 'module') script.async = false;
            script.src = blobUrl;
            sendDebug('info', 'script-inline-externalized ' + descriptor.label);
            scriptTasks.push(new Promise((resolve) => {
              const finalize = (ok) => {
                try { URL.revokeObjectURL(blobUrl); } catch {}
                resolve(ok);
              };
              script.addEventListener('load', () => {
                if (scriptStats) scriptStats.loaded += 1;
                sendDebug('info', 'script-load-ok ' + descriptor.label + ' externalized=1');
                finalize(true);
              }, { once: true });
              script.addEventListener('error', () => {
                if (scriptStats) scriptStats.failed += 1;
                sendIframeError('resource-load-failed tag=script ' + descriptor.label + ' externalized=1');
                finalize(false);
              }, { once: true });
            }));
          } else {
            script.textContent = code;
            sendDebug('warn', 'script-inline-externalize-failed ' + descriptor.label);
            sendDebug('info', 'script-inline-append ' + descriptor.label);
          }
        } else {
          script.textContent = code;
          sendDebug('info', 'script-inline-append ' + descriptor.label);
        }
      }
      if (target === document.head) {
        script.setAttribute('data-chatapp-head-node', '1');
      }
      target.appendChild(script);
      return script;
    } catch (err) {
      sendIframeError('script-clone-failed ' + String(err?.message || err || 'unknown'));
      return null;
    }
  };

  const appendManagedNode = (
    node,
    target,
    {
      allowScripts = false,
      inHead = false,
      scriptTasks = [],
      scriptStats = null,
      inlineBehaviorBindings = null,
      inlineBehaviorStats = null,
    } = {},
  ) => {
    if (!node || !target) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = document.createTextNode(node.textContent || '');
      target.appendChild(textNode);
      return textNode;
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      const commentNode = document.createComment(node.textContent || '');
      target.appendChild(commentNode);
      return commentNode;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'script') {
      if (allowScripts) return appendScriptNode(node, target, scriptTasks, scriptStats);
      return null;
    }
    if (tag === 'link') {
      const rel = String(node.getAttribute('rel') || '').trim().toLowerCase();
      const rawHref = String(node.getAttribute('href') || '').trim();
      const href = rewriteVendorResourceUrl(rawHref);
      if (rel !== 'stylesheet' || !href || !isAllowedResourceUrl(href, { allowRemoteHttp: allowScripts })) {
        if (rel === 'stylesheet' && rawHref) {
          sendDebug('warn', 'stylesheet-blocked href=' + compactText(rawHref, 220));
        }
        return null;
      }
      const link = document.createElement('link');
      Array.from(node.attributes || []).forEach((attr) => {
        try { link.setAttribute(attr.name, attr.value); } catch {}
      });
      if (href !== rawHref) {
        try {
          link.setAttribute('href', href);
          link.removeAttribute('integrity');
          link.removeAttribute('crossorigin');
          link.setAttribute('data-chatapp-vendor-rewrite', 'fontawesome');
          sendDebug('info', 'stylesheet-rewrite href=' + compactText(rawHref, 220));
        } catch {}
      }
      if (inHead) link.setAttribute('data-chatapp-head-node', '1');
      link.addEventListener('load', () => {
        sendDebug('info', 'stylesheet-load-ok href=' + compactText(href, 220));
      }, { once: true });
      link.addEventListener('error', () => {
        sendIframeError('resource-load-failed tag=link url=' + compactText(href, 220));
      }, { once: true });
      target.appendChild(link);
      return link;
    }
    if (inHead && !/^(meta|base|title|style|template)$/i.test(tag)) {
      return null;
    }

    const el = document.createElement(node.tagName);
    Array.from(node.attributes || []).forEach((attr) => {
      const attrName = String(attr.name || '');
      const attrValue = String(attr.value || '');
      if (allowScripts && /^on[a-z]+$/i.test(attrName)) {
        registerInlineBehavior(
          inlineBehaviorBindings,
          inlineBehaviorStats,
          el,
          'event',
          { eventName: attrName.slice(2), code: attrValue },
        );
        return;
      }
      if (allowScripts && /^(?:href|xlink:href)$/i.test(attrName) && /^javascript:/i.test(attrValue.trim())) {
        const code = attrValue.replace(/^javascript:/i, '').trim();
        registerInlineBehavior(
          inlineBehaviorBindings,
          inlineBehaviorStats,
          el,
          code && !/^void\s*\(?\s*0\s*\)?;?$/i.test(code) ? 'javascript-url' : 'javascript-url-neutralized',
          { code },
        );
        try { el.setAttribute(attrName, attrValue); } catch {}
        return;
      }
      if (allowScripts && tag === 'iframe' && attrName.toLowerCase() === 'srcdoc') {
        try { el.setAttribute(attrName, rewriteNestedSrcdocHtml(attrValue)); } catch {}
        return;
      }
      try { el.setAttribute(attrName, attrValue); } catch {}
    });
    if (inHead) el.setAttribute('data-chatapp-head-node', '1');
    target.appendChild(el);
    if (tag === 'template' && node.content && el.content) {
      // 模板数据保存在 content 中，普通 childNodes 为空。整段复制惰性内容，
      // 保留嵌套模板，避免将其中的脚本交给宿主提前执行。
      el.content.appendChild(node.content.cloneNode(true));
      return el;
    }
    Array.from(node.childNodes || []).forEach((child) => {
      // 单个子节点重建失败不能殃及后续兄弟（否则同父级一整段 UI 连锁丢失）。
      try {
        appendManagedNode(child, el, {
          allowScripts,
          inHead: false,
          scriptTasks,
          scriptStats,
          inlineBehaviorBindings,
          inlineBehaviorStats,
        });
      } catch (err) {
        const childTag = String(child?.tagName || child?.nodeName || 'unknown');
        sendDebug('warn', 'managed-node-append-failed tag=' + childTag + ' err=' + compactText(String(err?.message || err || ''), 160));
      }
    });
    return el;
  };

  const installLayoutObservers = () => {
    try { resizeObserver?.disconnect(); } catch {}
    try { mutationObserver?.disconnect(); } catch {}
    if (fallbackResizeTimer) {
      clearInterval(fallbackResizeTimer);
      fallbackResizeTimer = 0;
    }
    resizeObserver = null;
    mutationObserver = null;

    try {
      resizeObserver = new ResizeObserver(() => {
        if (lastSentLock && lastSentMode === 'viewport') return;
        requestLayout('observer');
      });
      resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
    } catch {
      fallbackResizeTimer = window.setInterval(() => {
        if (lastSentLock && lastSentMode === 'viewport') return;
        requestLayout('fallback');
      }, 500);
    }

    try {
      mutationObserver = new MutationObserver(() => {
        if (lastSentLock && lastSentMode === 'viewport') return;
        requestLayout('observer');
      });
      if (document.body) {
        mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      }
    } catch {}
  };

  const getPoint = (ev) => {
    try {
      if (ev && ev.touches && ev.touches.length) {
        const t = ev.touches[0];
        return { x: t.clientX || 0, y: t.clientY || 0 };
      }
      if (ev && ev.changedTouches && ev.changedTouches.length) {
        const t = ev.changedTouches[0];
        return { x: t.clientX || 0, y: t.clientY || 0 };
      }
      const x = (ev && typeof ev.clientX === 'number') ? ev.clientX : 0;
      const y = (ev && typeof ev.clientY === 'number') ? ev.clientY : 0;
      return { x, y };
    } catch {
      return { x: 0, y: 0 };
    }
  };

  const sendPress = (phase, ev) => {
    try {
      const p = getPoint(ev);
      parent.postMessage({ type: 'chatapp:iframe-press', id: currentId, phase, x: p.x, y: p.y }, '*');
    } catch {}
  };

  const clearPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (pressActive) { sendPress('cancel', { clientX: 0, clientY: 0 }); pressActive = false; }
  };

  const startPress = (ev) => {
    clearPress();
    pressActive = true;
    sendPress('down', ev);
    pressTimer = setTimeout(() => {
      sendPress('longpress', ev);
    }, 520);
  };

  const readMetaPolicy = () => {
    try {
      const metaHeight = document.querySelector('meta[name="chatapp-height"]');
      const metaResize = document.querySelector('meta[name="chatapp-resize"]');
      const rawHeight = String(metaHeight?.getAttribute('content') || '').trim();
      const parsedHeight = Number(rawHeight);
      const height = Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 0;
      const resize = String(metaResize?.getAttribute('content') || '').trim().toLowerCase();
      let mode = '';
      if (resize.includes('viewport')) mode = 'viewport';
      else if (resize.includes('document')) mode = 'document';
      const lock = resize === 'none' || resize === 'lock' || resize === 'locked';
      return { height, mode, lock };
    } catch {
      return { height: 0, mode: '', lock: false };
    }
  };

  const detectViewportMode = () => {
    try {
      const body = document.body;
      const docEl = document.documentElement;
      if (!body || !docEl) return false;
      const bodyStyle = getComputedStyle(body);
      const docStyle = getComputedStyle(docEl);
      const overflowHidden = /hidden|clip/i.test(String(bodyStyle.overflowY || '')) ||
        /hidden|clip/i.test(String(docStyle.overflowY || ''));
      const fixedBody = String(bodyStyle.position || '').toLowerCase() === 'fixed';
      const vhDecl = String(body.style.height || '') + ';' + String(body.style.minHeight || '') + ';' +
        String(docEl.style.height || '') + ';' + String(docEl.style.minHeight || '');
      const hasVhDecl = /\b\d+(?:\.\d+)?vh\b/i.test(vhDecl);
      const viewportH = Math.max(window.innerHeight || 0, docEl.clientHeight || 0);
      const bodyH = Math.max(body.scrollHeight || 0, body.offsetHeight || 0, body.clientHeight || 0);
      const docH = Math.max(docEl.scrollHeight || 0, docEl.offsetHeight || 0, docEl.clientHeight || 0);
      const dominantHeight = Math.max(bodyH, docH);
      const closeToViewport = viewportH > 0 &&
        Math.abs(bodyH - viewportH) <= 28 &&
        Math.abs(docH - viewportH) <= 28;
      const viewportSized = viewportH > 0 && dominantHeight >= (viewportH * 0.72);
      if (closeToViewport) return true;
      if (overflowHidden && fixedBody && viewportSized) return true;
      if (overflowHidden && hasVhDecl && viewportSized) return true;
      return false;
    } catch {
      return false;
    }
  };

  const measureDocumentHeight = () => {
    try {
      const body = document.body;
      const docEl = document.documentElement;
      if (!body) return 0;
      const kids = Array.from(body.children || []);
      if (!kids.length) {
        const rect = body.getBoundingClientRect();
        return rect ? rect.height : 0;
      }
      const shouldIgnore = (el) => {
        try {
          if (!(el instanceof HTMLElement)) return true;
          if (String(el.dataset?.chatappLayoutIgnore || '') === '1') return true;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return true;
          const position = String(style.position || '').trim().toLowerCase();
          if (position === 'fixed' || position === 'absolute') {
            const left = parseFloat(style.left || '0') || 0;
            const top = parseFloat(style.top || '0') || 0;
            const width = parseFloat(style.width || '0') || 0;
            const height = parseFloat(style.height || '0') || 0;
            const offscreenProxy = left <= -9000 || top <= -9000;
            if (offscreenProxy && width <= 2 && height <= 2) return true;
          }
          return false;
        } catch {
          return false;
        }
      };
      const isInFlow = (el) => {
        try {
          const position = String(getComputedStyle(el).position || '').trim().toLowerCase();
          return position !== 'fixed' && position !== 'absolute';
        } catch {
          return true;
        }
      };
      const hasLoadingOverlaySignal = (el) => {
        try {
          const marker = [
            el.id,
            el.className,
            el.getAttribute?.('role'),
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('data-state'),
            el.getAttribute?.('data-loading'),
          ].join(' ');
          return loadingOverlaySignalRe.test(String(marker || ''));
        } catch {
          return false;
        }
      };
      const isLikelyLoadingOverlay = (el) => {
        try {
          if (!(el instanceof HTMLElement)) return false;
          if (!hasLoadingOverlaySignal(el)) return false;
          const style = getComputedStyle(el);
          const position = String(style.position || '').trim().toLowerCase();
          if (position !== 'fixed' && position !== 'absolute') return false;
          const rect = el.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
          const viewportH = Math.max(window.innerHeight || 0, docEl?.clientHeight || 0);
          const viewportW = Math.max(window.innerWidth || 0, docEl?.clientWidth || 0);
          const coversHeight = viewportH > 0 ? rect.height >= (viewportH * 0.7) : rect.height >= 360;
          const coversWidth = viewportW > 0 ? rect.width >= (viewportW * 0.7) : true;
          return coversHeight && coversWidth;
        } catch {
          return false;
        }
      };
      const getLoadingOverlayFallbackHeight = () => {
        try {
          const stable = Math.max(stableViewportHeight || 0, readStableViewportHeight() || 0);
          const previous = Number(lastSentHeight || 0);
          if (stable > 0) {
            const lower = Math.max(120, stable * 0.5);
            const upper = Math.max(360, stable * 1.25);
            if (previous >= lower && previous <= upper) return previous;
            return stable;
          }
          if (previous >= 120 && previous <= 1000) return previous;
          return 480;
        } catch {
          return 480;
        }
      };
      const visibleKids = kids.filter((el) => !shouldIgnore(el));
      const measuredKids = visibleKids.filter((el) => isInFlow(el));
      // Full-screen loaders track the iframe viewport; measuring them creates height feedback.
      const overlayFilteredKids = visibleKids.filter((el) => !isLikelyLoadingOverlay(el));
      const hasLoadingOverlayOnly = !measuredKids.length && overlayFilteredKids.length < visibleKids.length;
      const targets = measuredKids.length ? measuredKids : overlayFilteredKids;
      if (!targets.length && hasLoadingOverlayOnly) {
        return getLoadingOverlayFallbackHeight();
      }
      if (!targets.length) {
        const rect = body.getBoundingClientRect();
        return rect ? rect.height : 0;
      }
      let minTop = null;
      let maxBottom = null;
      targets.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.height <= 0) return;
        if (minTop === null || rect.top < minTop) minTop = rect.top;
        if (maxBottom === null || rect.bottom > maxBottom) maxBottom = rect.bottom;
      });
      if (minTop === null || maxBottom === null) {
        const rect = body.getBoundingClientRect();
        return rect ? rect.height : 0;
      }
      const style = getComputedStyle(body);
      const padTop = parseFloat(style.paddingTop || '0') || 0;
      const padBottom = parseFloat(style.paddingBottom || '0') || 0;
      return Math.max(0, maxBottom - minTop) + padTop + padBottom;
    } catch {
      return 0;
    }
  };

  const measureViewportHeight = () => {
    try {
      const body = document.body;
      const docEl = document.documentElement;
      const viewport = Math.max(window.innerHeight || 0, docEl?.clientHeight || 0);
      const bodyRect = body?.getBoundingClientRect?.();
      const bodyH = bodyRect ? bodyRect.height : 0;
      const docH = Math.max(docEl?.clientHeight || 0, docEl?.offsetHeight || 0);
      return Math.max(viewport, bodyH, docH);
    } catch {
      return 0;
    }
  };

  const postHeight = ({ source = 'bridge', force = false } = {}) => {
    try {
      applyStableViewportVars();
      const meta = readMetaPolicy();
      // Auto-detecting viewport mode inside chat iframes creates a feedback loop:
      // once the outer iframe grows, innerHeight grows with it and the next resize
      // message asks for an even taller iframe. Only honor explicit meta policy.
      const mode = meta.mode || 'document';
      const lock = Boolean(meta.lock);
      const measured = meta.height > 0
        ? meta.height
        : (mode === 'viewport' ? measureViewportHeight() : measureDocumentHeight());
      const raw = lock && lastSentHeight > 0 && meta.height <= 0 ? lastSentHeight : measured;
      const nextHeight = Math.ceil(Math.max(120, raw || 0));

      if (mode === 'viewport' && !viewportLogged) {
        viewportLogged = true;
        sendDebug('info', 'height-mode=viewport');
      }
      if (lock !== lockLogged) {
        lockLogged = lock;
        sendDebug('info', 'height-lock=' + (lock ? '1' : '0'));
      }

      if (!force && !forceNextResize && nextHeight === lastSentHeight && mode === lastSentMode && lock === lastSentLock) {
        return;
      }
      forceNextResize = false;
      resizeSeq += 1;
      lastSentHeight = nextHeight;
      lastSentMode = mode;
      lastSentLock = lock;
      parent.postMessage({
        type: 'chatapp:iframe-resize',
        id: currentId,
        height: nextHeight,
        seq: resizeSeq,
        source: normalizeSource(source),
        mode,
        lock,
        ts: Date.now(),
      }, '*');
    } catch {}
  };

  const fitToWidth = () => {
    try {
      const docEl = document.documentElement;
      const body = document.body;
      if (!docEl || !body) return;
      body.style.transform = '';
      body.style.width = '';
      docEl.style.overflowX = 'hidden';

      const clientW = Math.max(1, docEl.clientWidth || 1);
      const scrollW = Math.max(body.scrollWidth || 0, docEl.scrollWidth || 0);
      if (scrollW <= clientW + 2) return;
      let scale = clientW / scrollW;
      if (scale > 0.98) return;
      const minScale = 0.55;
      scale = Math.max(minScale, Math.min(1, scale));
      body.style.transformOrigin = 'top left';
      body.style.transform = 'scale(' + scale + ')';
      body.style.width = (100 / scale) + '%';
      docEl.style.overflowX = 'hidden';
    } catch {}
  };

  const requestLayout = (source = 'bridge', force = false) => {
    pendingSource = normalizeSource(source);
    if (force) pendingForce = true;
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(() => {
      layoutScheduled = false;
      const sourceToSend = pendingSource;
      const forceToSend = pendingForce;
      pendingSource = 'bridge';
      pendingForce = false;
      fitToWidth();
      postHeight({ source: sourceToSend, force: forceToSend });
    });
  };

  const triggerBurstLayout = (source = 'observer') => {
    forceNextResize = true;
    [0, 60, 180, 360].forEach((ms) => {
      setTimeout(() => { requestLayout(source, true); }, ms);
    });
  };

  const installFrameElementHeightCompat = () => {
    try {
      const frame = window.frameElement;
      const style = frame?.style;
      if (!frame || !style || style.__chatappFrameElementHeightCompat === '1') return;
      const nativeSetProperty = typeof style.setProperty === 'function'
        ? style.setProperty.bind(style)
        : null;
      const nativeGetPropertyValue = typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue.bind(style)
        : null;
      const nativeRemoveProperty = typeof style.removeProperty === 'function'
        ? style.removeProperty.bind(style)
        : null;
      const shouldAllowNativeHeightWrite = () => frame?.dataset?.chatappHeightWrite === '1';
      const requestCompatLayout = () => {
        forceNextResize = true;
        requestLayout('observer', true);
      };
      try {
        Object.defineProperty(style, 'height', {
          configurable: true,
          enumerable: true,
          get() {
            try { return nativeGetPropertyValue ? nativeGetPropertyValue('height') : ''; } catch { return ''; }
          },
          set(value) {
            if (shouldAllowNativeHeightWrite()) {
              if (nativeSetProperty) nativeSetProperty('height', String(value || ''));
              return;
            }
            requestCompatLayout();
          },
        });
      } catch {
        return;
      }
      if (nativeSetProperty) {
        try {
          style.setProperty = function patchedSetProperty(name, value, priority) {
            if (String(name || '').trim().toLowerCase() === 'height' && !shouldAllowNativeHeightWrite()) {
              requestCompatLayout();
              return undefined;
            }
            return nativeSetProperty(name, value, priority);
          };
        } catch {}
      }
      if (nativeRemoveProperty) {
        try {
          style.removeProperty = function patchedRemoveProperty(name) {
            if (String(name || '').trim().toLowerCase() === 'height' && !shouldAllowNativeHeightWrite()) {
              requestCompatLayout();
              return '';
            }
            return nativeRemoveProperty(name);
          };
        } catch {}
      }
      try { style.__chatappFrameElementHeightCompat = '1'; } catch {}
      sendDebug('info', 'frameElement-height-compat-installed');
    } catch {}
  };

  const bindBridgeEvents = () => {
    if (bridgeEventsBound) return;
    bridgeEventsBound = true;
    document.addEventListener('pointerdown', (ev) => {
      if (touchActive) return;
      startPress(ev);
    }, { passive: true });
    ['pointerup','pointercancel','pointerleave','pointerout'].forEach((t) => {
      document.addEventListener(t, (ev) => {
        if (!pressActive) return;
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        sendPress('up', ev);
        pressActive = false;
      }, { passive: true });
    });
    document.addEventListener('touchstart', (ev) => {
      touchActive = true;
      touchStartPoint = getPoint(ev);
      startPress(ev);
    }, { passive: true });
    document.addEventListener('touchmove', (ev) => {
      if (!pressActive || !touchStartPoint) return;
      const p = getPoint(ev);
      const dx = p.x - touchStartPoint.x;
      const dy = p.y - touchStartPoint.y;
      if (dx * dx + dy * dy > moveThreshold * moveThreshold) {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        sendPress('cancel', ev);
        pressActive = false;
      }
    }, { passive: true });
    document.addEventListener('touchend', (ev) => {
      if (!pressActive) {
        touchActive = false;
        touchStartPoint = null;
        return;
      }
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      sendPress('up', ev);
      pressActive = false;
      touchStartPoint = null;
      setTimeout(() => { touchActive = false; }, 120);
    }, { passive: true });
    document.addEventListener('touchcancel', (ev) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      sendPress('cancel', ev);
      pressActive = false;
      touchStartPoint = null;
      setTimeout(() => { touchActive = false; }, 120);
    }, { passive: true });
    document.addEventListener('contextmenu', (ev) => {
      try { ev.preventDefault(); } catch {}
      sendPress('longpress', ev);
    }, { passive: false });
    document.addEventListener('selectstart', (ev) => {
      try { ev.preventDefault(); } catch {}
    }, { passive: false });
    document.addEventListener('toggle', (ev) => {
      if (ev && ev.target && ev.target.tagName === 'DETAILS') {
        forceNextResize = true;
        triggerBurstLayout('observer');
      }
    }, true);
    document.addEventListener('transitionend', (ev) => {
      const target = ev?.target;
      if (!target || typeof target.closest !== 'function') return;
      const details = target.closest('details');
      if (!details || details.open !== true) return;
      forceNextResize = true;
      triggerBurstLayout('observer');
    }, true);
    document.addEventListener('animationend', (ev) => {
      const target = ev?.target;
      if (!target || typeof target.closest !== 'function') return;
      const details = target.closest('details');
      if (!details || details.open !== true) return;
      forceNextResize = true;
      triggerBurstLayout('observer');
    }, true);
    window.addEventListener('resize', () => {
      forceNextResize = true;
      requestLayout('observer', true);
    });
    window.addEventListener('load', () => {
      forceNextResize = true;
      requestLayout('observer', true);
    });
  };

  const applyDoc = (doc, id, options = {}) => {
    if (applied) return;
    applied = true;
    currentId = String(id || '');
    const allowScripts = Boolean(options.allowScripts);
    const scriptTasks = [];
    const scriptStats = createScriptStats();
    const inlineBehaviorBindings = [];
    const inlineBehaviorStats = createInlineBehaviorStats();
    ensureCompatInputHelpers();
    ensureSillyTavernApiCompat();
    ensureRuntimeDiagnostics();
    installFrameElementHeightCompat();
    try {
      releaseBlobUrls(nestedSrcdocBlobUrls);
      const parser = new DOMParser();
      const parsed = parser.parseFromString(String(doc || ''), 'text/html');
      if (parsed.documentElement) {
        syncElementAttributes(document.documentElement, parsed.documentElement);
      }
      syncElementAttributes(document.body, parsed.body);
      document.body.innerHTML = '';
      clearManagedHeadNodes();
      ensureCompatInputDomProxies();

      Array.from(parsed.head?.childNodes || []).forEach((node) => {
        appendManagedNode(node, document.head, {
          allowScripts,
          inHead: true,
          scriptTasks,
          scriptStats,
          inlineBehaviorBindings,
          inlineBehaviorStats,
        });
      });
      Array.from(parsed.body?.childNodes || []).forEach((node) => {
        appendManagedNode(node, document.body, {
          allowScripts,
          inHead: false,
          scriptTasks,
          scriptStats,
          inlineBehaviorBindings,
          inlineBehaviorStats,
        });
      });
      applyStableViewportVars();

      sendDebug('info', `host-apply allowScripts=${allowScripts ? 1 : 0} headNodes=${Number(parsed.head?.childNodes?.length || 0)} bodyNodes=${Number(parsed.body?.childNodes?.length || 0)} docLength=${Number(String(doc || '').length || 0)}`);
      sendDebug('info', formatScriptStats(scriptStats));
      if (allowScripts) {
        bindDeferredInlineBehaviors(inlineBehaviorBindings, inlineBehaviorStats);
        sendDebug('info', formatInlineBehaviorStats(inlineBehaviorStats));
      }
    } catch (err) {
      sendHostError(String(err?.message || err || 'host parse failed'));
      return;
    }
    try {
      parent.postMessage({ type: 'chatapp:iframe-host-ready', id }, '*');
    } catch {}
    bindBridgeEvents();
    installLayoutObservers();
    requestLayout('bridge', true);
    [50, 150, 300, 600].forEach((ms) => {
      setTimeout(() => { requestLayout('observer', true); }, ms);
    });
    try {
      parent.postMessage({ type: 'chatapp:iframe-ready', id }, '*');
    } catch {}
    Promise.allSettled(Array.isArray(scriptTasks) ? scriptTasks : []).finally(() => {
      sendDebug('info', 'script-settled ' + formatScriptStats(scriptStats));
      const shouldDispatchSyntheticReady = Number(scriptStats?.babel || 0) <= 0;
      sendDebug('info', `synthetic-ready-dispatch enabled=${shouldDispatchSyntheticReady ? 1 : 0} ` + formatScriptStats(scriptStats));
      if (shouldDispatchSyntheticReady) {
        dispatchSyntheticReadyEvents();
      }
      forceNextResize = true;
      requestLayout('observer', true);
    });
  };

  window.addEventListener('message', (e) => {
    const data = e?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'chatapp:iframe-load') {
      sendDebug('info', `host-message type=iframe-load allowScripts=${data.allowScripts ? 1 : 0} docLength=${Number(String(data.doc || '').length || 0)}`);
      applyDoc(data.doc, data.id, { allowScripts: data.allowScripts });
      return;
    }
    if (data.type === 'chatapp:updateViewportHeight' && typeof data.height === 'number') {
      applyStableViewportVars(data.height);
      forceNextResize = true;
      requestLayout('observer', true);
      return;
    }
    if (data.type === 'chatapp:ping') {
      try {
        parent.postMessage({ type: 'chatapp:pong', id: currentId }, '*');
      } catch {}
    }
  });
})();
