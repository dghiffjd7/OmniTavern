import {
  normalizeLifecycleTraceDetails,
  normalizeLifecycleTraceText,
} from './chat/lifecycle-trace-utils.js';

export const shouldDetachRpSessionFromChatMode = ({
  uiMode = 'chat',
  sessionId = '',
} = {}) => (
  String(uiMode || '').trim().toLowerCase() !== 'rp'
  && String(sessionId || '').trim().startsWith('rp:')
);

export const runAppBootRestoreFlow = async ({
  restoreUiState = null,
  getActivePage = null,
  setActivePage = null,
  hasPage = null,
  isPageActive = null,
  switchPage = null,
  uiLog = null,
  getUiMode = null,
  getCurrentSessionId = null,
  detachChatModeRpSession = null,
  isChatRoomVisible = null,
  applyMvuSchemaDefaults = null,
  updateWorldIndicator = null,
  refreshChatAndContacts = null,
  applyUiModeUI = null,
  getInitialUiMode = null,
  setUiMode = null,
  persistUiMode = null,
  setUiStateArmed = null,
  saveUiState = null,
} = {}) => {
  const initialUiMode = String(getInitialUiMode?.() || '').trim().toLowerCase() === 'rp' ? 'rp' : 'chat';
  try {
    setUiMode?.(initialUiMode);
  } catch {}
  try {
    await restoreUiState?.();
  } catch {}
  const restoredUiMode = String(getUiMode?.() || initialUiMode).trim().toLowerCase() === 'rp'
    ? 'rp'
    : 'chat';
  const restoredSessionId = String(getCurrentSessionId?.() || '').trim();
  if (shouldDetachRpSessionFromChatMode({
    uiMode: restoredUiMode,
    sessionId: restoredSessionId,
  })) {
    try {
      await detachChatModeRpSession?.({
        uiMode: restoredUiMode,
        sessionId: restoredSessionId,
      });
    } catch {}
  }
  let activePage = String(getActivePage?.() || '').trim();
  if (!activePage) {
    activePage = 'chat';
    setActivePage?.(activePage);
  }
  if (!hasPage?.(activePage)) {
    activePage = 'chat';
    setActivePage?.(activePage);
  }
  if (!isPageActive?.(activePage)) switchPage?.(activePage || 'chat');
  uiLog?.('boot: after restore', {
    activePage,
    sessionId: String(getCurrentSessionId?.() || '').trim(),
    inChatRoom: Boolean(isChatRoomVisible?.()),
  });
  applyMvuSchemaDefaults?.(getCurrentSessionId?.(), { reason: 'boot' });
  updateWorldIndicator?.();
  refreshChatAndContacts?.();
  applyUiModeUI?.();
  setUiStateArmed?.(true);
  try {
    saveUiState?.();
  } catch {}
};

const normalizeAppBootTracePhase = (phase = '') => {
  const normalized = normalizeLifecycleTraceText(phase, 'init');
  return normalized.startsWith('boot.') ? normalized : `boot.${normalized}`;
};

export const buildAppBootTraceEvent = ({
  phase = 'init',
  status = 'info',
  summary = '',
  details,
} = {}) => {
  const event = {
    category: 'app',
    source: 'app-boot',
    phase: normalizeAppBootTracePhase(phase),
    status: normalizeLifecycleTraceText(status, 'info'),
    summary: normalizeLifecycleTraceText(summary, ''),
  };
  if (details !== undefined) event.details = normalizeLifecycleTraceDetails(details);
  return event;
};

export const startAppBootTrace = ({
  traceTimeline = null,
  phase = 'init',
  summary = 'app boot started',
  details,
} = {}) => {
  try {
    if (typeof traceTimeline?.start !== 'function') return null;
    return traceTimeline.start(buildAppBootTraceEvent({
      phase,
      status: 'started',
      summary,
      details,
    }));
  } catch {}
  return null;
};

export const finishAppBootTrace = ({
  traceTimeline = null,
  eventId = '',
  phase = 'init',
  status = 'success',
  summary = 'app boot completed',
  details,
} = {}) => {
  try {
    if (!eventId || typeof traceTimeline?.finish !== 'function') return null;
    return traceTimeline.finish(eventId, buildAppBootTraceEvent({
      phase,
      status,
      summary,
      details,
    }));
  } catch {}
  return null;
};

export const RUNTIME_NOISE_STORAGE_KEYS = [
  'chatapp_renderer_lifecycle_v1',
  'chatapp_rich_script_guard_v1',
];

const getDefaultLocalStorage = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

export const getRuntimeErrorMessage = (err) => {
  if (err?.message) return String(err.message);
  return String(err || 'unknown error');
};

export const isIgnorableRuntimeNoise = (value = '') => {
  const msg = String(value || '');
  if (!msg) return false;
  return /resizeobserver loop (limit exceeded|completed with (?:undelivered|delivered) notifications)/i.test(msg);
};

export const clearRuntimeNoiseStorage = ({
  storage = getDefaultLocalStorage(),
  keys = RUNTIME_NOISE_STORAGE_KEYS,
} = {}) => {
  try {
    (keys || []).forEach(key => storage?.removeItem?.(key));
    return true;
  } catch {
    return false;
  }
};

export const createRuntimeIssueReporter = ({
  logger = null,
  documentLike = typeof document !== 'undefined' ? document : null,
  windowLike = typeof window !== 'undefined' ? window : null,
  nowFn = () => Date.now(),
  setTimeoutFn = typeof setTimeout === 'function' ? setTimeout : null,
  clearTimeoutFn = typeof clearTimeout === 'function' ? clearTimeout : null,
} = {}) => {
  let lastRuntimeNoticeKey = '';
  let lastRuntimeNoticeAt = 0;

  const reportFatalError = (err, label = 'App init failed') => {
    try {
      const msg = getRuntimeErrorMessage(err);
      logger?.error?.(label, msg, err);
      let overlay = documentLike?.getElementById?.('chatapp-fatal-error-overlay');
      if (!overlay) {
        overlay = documentLike?.createElement?.('div');
        if (!overlay) return;
        overlay.id = 'chatapp-fatal-error-overlay';
        overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 40000;
        background: rgba(0,0,0,0.86);
        color: #f8fafc;
        padding: 20px;
        font-family: monospace;
        font-size: 12px;
        overflow: auto;
      `;
        documentLike?.body?.appendChild?.(overlay);
      }
      overlay.textContent = `${label}: ${msg}`;
    } catch {}
  };

  const reportRuntimeToast = (err, label = 'Runtime error') => {
    try {
      const msg = getRuntimeErrorMessage(err);
      logger?.error?.(label, msg, err);
      const noticeKey = `${label}::${msg}`;
      const now = Number(nowFn?.() || 0);
      if (noticeKey === lastRuntimeNoticeKey && (now - lastRuntimeNoticeAt) < 4000) return;
      lastRuntimeNoticeKey = noticeKey;
      lastRuntimeNoticeAt = now;
      if (windowLike?.toastr?.error) {
        windowLike.toastr.error(msg, label);
        return;
      }
      let banner = documentLike?.getElementById?.('chatapp-runtime-error-banner');
      if (!banner) {
        banner = documentLike?.createElement?.('div');
        if (!banner) return;
        banner.id = 'chatapp-runtime-error-banner';
        banner.style.cssText = `
        position: fixed;
        left: 12px;
        right: 12px;
        bottom: 18px;
        z-index: 39999;
        border-radius: 12px;
        padding: 10px 12px;
        background: rgba(15,23,42,0.94);
        color: #f8fafc;
        border: 1px solid rgba(248,250,252,0.14);
        box-shadow: 0 12px 30px rgba(15,23,42,0.28);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      `;
        documentLike?.body?.appendChild?.(banner);
      }
      banner.textContent = `${label}: ${msg}`;
      clearTimeoutFn?.(windowLike?.__chatappRuntimeBannerTimer);
      if (windowLike) {
        windowLike.__chatappRuntimeBannerTimer = setTimeoutFn?.(() => {
          try { banner?.remove?.(); } catch {}
        }, 6000);
      }
    } catch {}
  };

  const reportGlobalRuntimeIssue = (err, label = 'Runtime error') => {
    // Preset/Worker callbacks can fail while initApp is still progressing.
    // Their timing does not make the boot fatal. The awaited boot flow reports
    // an actual initialization failure explicitly through reportFatalError.
    reportRuntimeToast(err, label);
  };

  return {
    reportFatalError,
    reportGlobalRuntimeIssue,
    reportRuntimeToast,
  };
};

export const registerHydratedUiRestoreListener = ({
  windowLike = null,
  onHydrated = null,
} = {}) => {
  windowLike?.addEventListener?.('store-hydrated', async (event) => {
    try {
      await onHydrated?.(event?.detail?.store, event);
    } catch {}
  });
};

export const registerUiLifecycleDiagnostics = ({
  windowLike = null,
  documentLike = null,
  uiLog = null,
  isIgnorableRuntimeNoise = null,
} = {}) => {
  const shouldIgnore = typeof isIgnorableRuntimeNoise === 'function'
    ? isIgnorableRuntimeNoise
    : (() => false);
  try {
    windowLike?.addEventListener?.('pageshow', event => uiLog?.('pageshow', { persisted: Boolean(event?.persisted) }));
    windowLike?.addEventListener?.('pagehide', event => uiLog?.('pagehide', { persisted: Boolean(event?.persisted) }));
    documentLike?.addEventListener?.('visibilitychange', () => uiLog?.('visibilitychange', { state: documentLike?.visibilityState }));
    windowLike?.addEventListener?.('beforeunload', () => uiLog?.('beforeunload'));
    windowLike?.addEventListener?.('unload', () => uiLog?.('unload'));
    windowLike?.addEventListener?.('error', event => {
      const error = event?.error;
      const msg = String(event?.message || error?.message || error || '');
      if (shouldIgnore(msg)) return;
      uiLog?.('window.error', {
        msg,
        file: event?.filename,
        line: event?.lineno,
        col: event?.colno,
        stack: error?.stack || '',
      });
    });
    windowLike?.addEventListener?.('unhandledrejection', event => {
      const msg = String(event?.reason?.message || event?.reason || '');
      if (shouldIgnore(msg)) return;
      uiLog?.('unhandledrejection', {
        reason: msg,
        stack: event?.reason?.stack || '',
      });
    });
  } catch {}
};

export const registerGlobalRuntimeIssueHandlers = ({
  windowLike = null,
  isIgnorableRuntimeNoise: shouldIgnoreInput = null,
  reportGlobalRuntimeIssue = null,
} = {}) => {
  const shouldIgnore = typeof shouldIgnoreInput === 'function'
    ? shouldIgnoreInput
    : (() => false);
  try {
    windowLike?.addEventListener?.('error', (event) => {
      if (!event) return;
      const msg = String(event?.message || event?.error?.message || event?.error || '');
      if (shouldIgnore(msg)) return;
      reportGlobalRuntimeIssue?.(event.error || event.message || 'unknown error', 'Runtime error');
    });
    windowLike?.addEventListener?.('unhandledrejection', (event) => {
      if (!event) return;
      const msg = String(event?.reason?.message || event?.reason || '');
      if (shouldIgnore(msg)) return;
      reportGlobalRuntimeIssue?.(event.reason || 'unhandled rejection', 'Unhandled rejection');
    });
  } catch {}
};
