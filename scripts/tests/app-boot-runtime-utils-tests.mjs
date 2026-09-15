import assert from 'node:assert/strict';

import {
  RUNTIME_NOISE_STORAGE_KEYS,
  buildAppBootTraceEvent,
  clearRuntimeNoiseStorage,
  createRuntimeIssueReporter,
  finishAppBootTrace,
  getRuntimeErrorMessage,
  isIgnorableRuntimeNoise,
  registerGlobalRuntimeIssueHandlers,
  registerHydratedUiRestoreListener,
  registerUiLifecycleDiagnostics,
  runAppBootRestoreFlow,
  shouldDetachRpSessionFromChatMode,
  startAppBootTrace,
} from '../../src/scripts/ui/app-boot-runtime-utils.js';

const createDocumentLike = () => {
  const body = {
    children: [],
    appendChild(el) {
      this.children.push(el);
      return el;
    },
  };
  return {
    body,
    createElement(tagName) {
      return {
        tagName: String(tagName || '').toUpperCase(),
        id: '',
        style: { cssText: '' },
        textContent: '',
        removed: false,
        remove() {
          this.removed = true;
        },
      };
    },
    getElementById(id) {
      return body.children.find(child => child.id === id) || null;
    },
  };
};

{
  assert.deepEqual(buildAppBootTraceEvent({
    phase: ' init ',
    status: ' started ',
    summary: ' booting ',
    details: {
      keptFalse: false,
      keptZero: 0,
      dropped: undefined,
    },
  }), {
    category: 'app',
    source: 'app-boot',
    phase: 'boot.init',
    status: 'started',
    summary: 'booting',
    details: {
      keptFalse: false,
      keptZero: 0,
    },
  });
  assert.equal(buildAppBootTraceEvent({ phase: 'boot.ready' }).phase, 'boot.ready');
  console.log('ok - buildAppBootTraceEvent normalizes app boot trace schema');
}

{
  const calls = [];
  const traceTimeline = {
    start(event) {
      calls.push(['start', event]);
      return { eventId: 'trace-boot', ...event };
    },
    finish(eventId, patch) {
      calls.push(['finish', eventId, patch]);
      return { eventId, ...patch };
    },
  };
  const started = startAppBootTrace({
    traceTimeline,
    details: { runtimeReady: false },
  });
  const finished = finishAppBootTrace({
    traceTimeline,
    eventId: started.eventId,
    status: 'success',
    details: { runtimeReady: true },
  });
  assert.equal(started.eventId, 'trace-boot');
  assert.equal(finished.status, 'success');
  assert.deepEqual(calls, [
    ['start', {
      category: 'app',
      source: 'app-boot',
      phase: 'boot.init',
      status: 'started',
      summary: 'app boot started',
      details: { runtimeReady: false },
    }],
    ['finish', 'trace-boot', {
      category: 'app',
      source: 'app-boot',
      phase: 'boot.init',
      status: 'success',
      summary: 'app boot completed',
      details: { runtimeReady: true },
    }],
  ]);
  assert.equal(startAppBootTrace({ traceTimeline: {} }), null);
  assert.equal(finishAppBootTrace({ traceTimeline, eventId: '' }), null);
  assert.equal(startAppBootTrace({
    traceTimeline: {
      start() {
        throw new Error('trace failed');
      },
    },
  }), null);
  console.log('ok - app boot trace helpers safely start and finish debug timeline events');
}

{
  const removed = [];
  const storage = {
    removeItem(key) {
      removed.push(key);
    },
  };
  assert.equal(getRuntimeErrorMessage(new Error('boom')), 'boom');
  assert.equal(getRuntimeErrorMessage(null), 'unknown error');
  assert.equal(isIgnorableRuntimeNoise('ResizeObserver loop limit exceeded'), true);
  assert.equal(isIgnorableRuntimeNoise('ResizeObserver loop completed with undelivered notifications'), true);
  assert.equal(isIgnorableRuntimeNoise('real error'), false);
  assert.equal(clearRuntimeNoiseStorage({ storage }), true);
  assert.deepEqual(removed, RUNTIME_NOISE_STORAGE_KEYS);
  assert.equal(clearRuntimeNoiseStorage({ storage: { removeItem() { throw new Error('fail'); } } }), false);
  console.log('ok - runtime issue helpers normalize messages noise and cleanup storage keys');
}

{
  const documentLike = createDocumentLike();
  const errors = [];
  let now = 1000;
  const cleared = [];
  const timeouts = [];
  const windowLike = { __chatappRuntimeBannerTimer: 'old-timer' };
  const reporter = createRuntimeIssueReporter({
    logger: { error: (...args) => errors.push(args) },
    documentLike,
    windowLike,
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      timeouts.push({ fn, delay });
      return `timer-${timeouts.length}`;
    },
    clearTimeoutFn: timer => cleared.push(timer),
  });

  reporter.reportFatalError(new Error('boot failed'), 'App init failed');
  const overlay = documentLike.getElementById('chatapp-fatal-error-overlay');
  assert.equal(overlay.textContent, 'App init failed: boot failed');

  reporter.reportGlobalRuntimeIssue('runtime failed', 'Runtime error');
  const banner = documentLike.getElementById('chatapp-runtime-error-banner');
  assert.equal(banner.textContent, 'Runtime error: runtime failed');
  assert.deepEqual(cleared, ['old-timer']);
  assert.equal(windowLike.__chatappRuntimeBannerTimer, 'timer-1');
  assert.equal(timeouts[0].delay, 6000);

  now = 2000;
  reporter.reportGlobalRuntimeIssue('runtime failed', 'Runtime error');
  assert.deepEqual(cleared, ['old-timer']);
  assert.equal(errors.length, 3);
  assert.equal(overlay.textContent, 'App init failed: boot failed');
  console.log('ok - createRuntimeIssueReporter preserves explicit boot failure and deduplicates runtime notices');
}

{
  const documentLike = createDocumentLike();
  const listeners = new Map();
  const reports = [];
  const windowLike = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    toastr: { error: (...args) => reports.push(args) },
  };
  const reporter = createRuntimeIssueReporter({ documentLike, windowLike });
  registerGlobalRuntimeIssueHandlers({ windowLike, reportGlobalRuntimeIssue: reporter.reportGlobalRuntimeIssue });
  listeners.get('error')({ message: 'Uncaught Error: K3 元件缺失：fixture' });
  listeners.get('unhandledrejection')({ reason: new Error('preset startup callback failed') });
  assert.equal(documentLike.getElementById('chatapp-fatal-error-overlay'), null);
  assert.deepEqual(reports, [
    ['Uncaught Error: K3 元件缺失：fixture', 'Runtime error'],
    ['preset startup callback failed', 'Unhandled rejection'],
  ]);
  console.log('ok - global script errors during startup remain notifications instead of blocking a successful boot');
}

{
  const toastrCalls = [];
  const reporter = createRuntimeIssueReporter({
    logger: { error: () => {} },
    documentLike: createDocumentLike(),
    windowLike: { toastr: { error: (...args) => toastrCalls.push(args) } },
  });
  reporter.reportGlobalRuntimeIssue('toast failed', 'Runtime error');
  assert.deepEqual(toastrCalls, [['toast failed', 'Runtime error']]);
  console.log('ok - createRuntimeIssueReporter prefers toastr when available');
}

{
  const listeners = new Map();
  const reports = [];
  registerGlobalRuntimeIssueHandlers({
    windowLike: {
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
    },
    isIgnorableRuntimeNoise: value => value === 'ignore-me',
    reportGlobalRuntimeIssue: (...args) => reports.push(args),
  });
  listeners.get('error')({
    message: 'boom',
    error: { message: 'boom' },
  });
  listeners.get('error')({ message: 'ignore-me' });
  listeners.get('unhandledrejection')({ reason: { message: 'reject' } });
  listeners.get('unhandledrejection')({ reason: 'ignore-me' });
  assert.deepEqual(reports, [
    [{ message: 'boom' }, 'Runtime error'],
    [{ message: 'reject' }, 'Unhandled rejection'],
  ]);
  console.log('ok - registerGlobalRuntimeIssueHandlers wires error and rejection reporting');
}

{
  assert.equal(shouldDetachRpSessionFromChatMode({
    uiMode: 'chat',
    sessionId: 'rp:persona_a',
  }), true);
  assert.equal(shouldDetachRpSessionFromChatMode({
    uiMode: 'rp',
    sessionId: 'rp:persona_a',
  }), false);
  assert.equal(shouldDetachRpSessionFromChatMode({
    uiMode: 'chat',
    sessionId: 'contact:a',
  }), false);
  assert.equal(shouldDetachRpSessionFromChatMode({
    uiMode: 'chat',
    sessionId: '',
  }), false);
  console.log('ok - chat mode identifies only persisted RP current sessions as stale');
}

{
  let uiMode = 'chat';
  let currentSession = 'rp:stale';
  const calls = [];
  await runAppBootRestoreFlow({
    restoreUiState: async () => calls.push('restore'),
    getActivePage: () => 'chat',
    hasPage: page => page === 'chat',
    isPageActive: () => true,
    getUiMode: () => uiMode,
    getCurrentSessionId: () => currentSession,
    detachChatModeRpSession: async details => {
      calls.push(['detach', details]);
      currentSession = '';
    },
    isChatRoomVisible: () => false,
    applyMvuSchemaDefaults: (sessionId, payload) => calls.push(['mvu', sessionId, payload]),
    updateWorldIndicator: () => calls.push('world'),
    refreshChatAndContacts: () => calls.push('refresh'),
    applyUiModeUI: () => calls.push('applyUiModeUI'),
    getInitialUiMode: () => 'chat',
    setUiMode: value => {
      uiMode = value;
      calls.push(['setUiMode', value]);
    },
    setUiStateArmed: value => calls.push(['uiStateArmed', value]),
    saveUiState: () => calls.push('saveUiState'),
    uiLog: (event, payload) => calls.push([event, payload]),
  });

  assert.equal(currentSession, '');
  assert.deepEqual(calls, [
    ['setUiMode', 'chat'],
    'restore',
    ['detach', { uiMode: 'chat', sessionId: 'rp:stale' }],
    ['boot: after restore', { activePage: 'chat', sessionId: '', inChatRoom: false }],
    ['mvu', '', { reason: 'boot' }],
    'world',
    'refresh',
    'applyUiModeUI',
    ['uiStateArmed', true],
    'saveUiState',
  ]);
  console.log('ok - boot restore detaches a persisted RP current before chat mode becomes interactive');
}

{
  let activePage = '';
  let uiMode = 'rp';
  const calls = [];
  await runAppBootRestoreFlow({
    restoreUiState: async () => calls.push('restore'),
    getActivePage: () => activePage,
    setActivePage: value => {
      activePage = value;
      calls.push(['setActivePage', value]);
    },
    hasPage: page => page === 'chat' || page === 'contacts',
    isPageActive: () => false,
    switchPage: page => calls.push(['switchPage', page]),
    uiLog: (event, payload) => calls.push([event, payload]),
    getCurrentSessionId: () => 's1',
    isChatRoomVisible: () => true,
    applyMvuSchemaDefaults: (sessionId, payload) => calls.push(['mvu', sessionId, payload]),
    updateWorldIndicator: () => calls.push('world'),
    refreshChatAndContacts: () => calls.push('refresh'),
    applyUiModeUI: () => calls.push('applyUiModeUI'),
    getInitialUiMode: () => 'rp',
    setUiMode: value => {
      uiMode = value;
      calls.push(['setUiMode', value]);
    },
    persistUiMode: () => calls.push('persistUiMode'),
    setUiStateArmed: value => calls.push(['uiStateArmed', value]),
    saveUiState: () => calls.push('saveUiState'),
  });
  assert.equal(uiMode, 'rp');
  assert.deepEqual(calls, [
    ['setUiMode', 'rp'],
    'restore',
    ['setActivePage', 'chat'],
    ['switchPage', 'chat'],
    ['boot: after restore', { activePage: 'chat', sessionId: 's1', inChatRoom: true }],
    ['mvu', 's1', { reason: 'boot' }],
    'world',
    'refresh',
    'applyUiModeUI',
    ['uiStateArmed', true],
    'saveUiState',
  ]);
  console.log('ok - runAppBootRestoreFlow restores page shell without forcing rp mode back to chat');
}

{
  const listeners = new Map();
  registerHydratedUiRestoreListener({
    windowLike: {
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
    },
    onHydrated: async (store) => {
      listeners.set('seen', store);
    },
  });
  await listeners.get('store-hydrated')({ detail: { store: 'chat-store' } });
  assert.equal(listeners.get('seen'), 'chat-store');
  console.log('ok - registerHydratedUiRestoreListener forwards hydrated store names');
}

{
  const windowListeners = new Map();
  const documentListeners = new Map();
  const logs = [];
  registerUiLifecycleDiagnostics({
    windowLike: {
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
    },
    documentLike: {
      visibilityState: 'hidden',
      addEventListener(type, handler) {
        documentListeners.set(type, handler);
      },
    },
    uiLog: (event, payload) => logs.push([event, payload]),
    isIgnorableRuntimeNoise: value => value === 'ignore-me',
  });
  windowListeners.get('pageshow')({ persisted: true });
  windowListeners.get('pagehide')({ persisted: false });
  documentListeners.get('visibilitychange')();
  windowListeners.get('beforeunload')();
  windowListeners.get('unload')();
  windowListeners.get('error')({
    message: 'boom',
    filename: 'app.js',
    lineno: 10,
    colno: 20,
    error: { message: 'boom', stack: 'stack-trace' },
  });
  windowListeners.get('error')({
    message: 'ignore-me',
    error: { message: 'ignore-me', stack: 'ignored' },
  });
  windowListeners.get('unhandledrejection')({ reason: { message: 'reject', stack: 'reject-stack' } });
  assert.deepEqual(logs, [
    ['pageshow', { persisted: true }],
    ['pagehide', { persisted: false }],
    ['visibilitychange', { state: 'hidden' }],
    ['beforeunload', undefined],
    ['unload', undefined],
    ['window.error', { msg: 'boom', file: 'app.js', line: 10, col: 20, stack: 'stack-trace' }],
    ['unhandledrejection', { reason: 'reject', stack: 'reject-stack' }],
  ]);
  console.log('ok - registerUiLifecycleDiagnostics wires lifecycle and error diagnostics through uiLog');
}
