import {
  applySwipeReasoningStateToMeta,
  applySwipeSourcesStateToMeta,
  ensureSwipeMeta,
  resolveSwipeIndicatorState,
} from './swipe-ui-utils.js';

const fallbackEscapeSelector = (value) => String(value || '').replace(/["\\]/g, '\\$&');

export const createSwipeRegenerationHandler = (handler) => {
  if (typeof handler !== 'function') return handler;
  let running = false;
  return async function (...args) {
    // Snapshot/rollback await before the send flow owns activeGeneration. Reserve
    // the whole branch operation synchronously, including its final commit/restore.
    if (running) return false;
    running = true;
    try {
      return await handler.apply(this, args);
    } finally {
      running = false;
    }
  };
};

const resolveSelectorId = (msgId, escapeSelector) => {
  const raw = String(msgId || '').trim();
  if (!raw) return '';
  const escape = typeof escapeSelector === 'function'
    ? escapeSelector
    : (globalThis.CSS?.escape || fallbackEscapeSelector);
  return escape(raw);
};

const resolveSwipeWrapper = (scrollEl, msgId, escapeSelector) => {
  if (!scrollEl) return null;
  const safeId = resolveSelectorId(msgId, escapeSelector);
  if (!safeId) return null;
  return scrollEl.querySelector?.(`[data-msg-id="${safeId}"]`) || null;
};

export const normalizeAssistantSwipeStreamStateCore = (state = {}) => {
  if (state && typeof state === 'object' && !Array.isArray(state)) return { ...state };
  return { content: String(state ?? '') };
};

export const applySwipeCore = ({
  wrapper,
  message,
  newIndex,
  options = {},
  renderSwipeContent,
  syncSwipeIndicator,
  onSwipeChange,
} = {}) => {
  const swipes = message?.meta?.swipes;
  if (!wrapper || !message || !swipes || newIndex < 0 || newIndex >= swipes.length) return false;
  const emitChange = options?.emitChange !== false;
  const previousIndexRaw = Math.trunc(Number(message.meta.activeSwipe));
  const previousIndex = Number.isFinite(previousIndexRaw)
    ? Math.min(Math.max(0, previousIndexRaw), swipes.length - 1)
    : 0;
  message.meta.activeSwipe = newIndex;
  const branch = swipes[newIndex];
  message.content = branch.content;
  if (branch.raw !== undefined) message.raw = branch.raw;
  if (branch.rawSource !== undefined) message.rawSource = branch.rawSource;
  else if (branch.raw !== undefined) message.rawSource = branch.raw;
  if (branch.rawOriginal !== undefined) message.rawOriginal = branch.rawOriginal;
  else if (newIndex > 0) delete message.rawOriginal;
  message.meta = applySwipeReasoningStateToMeta(message.meta, branch, newIndex);
  message.meta = applySwipeSourcesStateToMeta(message.meta, branch, newIndex);
  const generating = Boolean(branch?.draft) || message.meta?.swipeRegenerating === true;
  const placeholder = branch?.draft ? String(branch?.label || '生成新回复中...') : '';

  renderSwipeContent?.(wrapper, message, String(branch.content ?? ''), { streaming: false, placeholder });
  syncSwipeIndicator?.(wrapper, newIndex, swipes.length, { generating });

  if (emitChange && typeof onSwipeChange === 'function') {
    onSwipeChange({ msgId: message.id, message, index: newIndex, previousIndex });
  }
  return true;
};

export const setSwipeRegeneratingCore = ({
  scrollEl,
  msgId,
  active,
  label = '生成中...',
  escapeSelector,
} = {}) => {
  const wrapper = resolveSwipeWrapper(scrollEl, msgId, escapeSelector);
  if (!wrapper) return false;
  wrapper.classList?.toggle?.('is-rp-regenerating', Boolean(active));
  wrapper.setAttribute?.('aria-busy', active ? 'true' : 'false');
  const bubble = wrapper.querySelector?.('.QQ_chat_msgdiv');
  if (bubble) {
    if (active) bubble.dataset.rpRegeneratingLabel = String(label || '生成中...');
    else delete bubble.dataset.rpRegeneratingLabel;
  }
  return true;
};

export const addSwipeBranchCore = ({
  scrollEl,
  msgId,
  content,
  raw,
  applySwipe,
  escapeSelector,
} = {}) => {
  const wrapper = resolveSwipeWrapper(scrollEl, msgId, escapeSelector);
  const message = wrapper?.__chatappMessage;
  if (!wrapper || !message) return false;
  ensureSwipeMeta(message);
  message.meta.swipes.push({ content, raw });
  const newIndex = message.meta.swipes.length - 1;
  return applySwipe?.({ wrapper, message, newIndex }) || false;
};

const resolveActiveSwipeIndex = (message) => {
  const swipes = Array.isArray(message?.meta?.swipes) ? message.meta.swipes : [];
  const raw = Math.trunc(Number(message?.meta?.activeSwipe));
  if (!swipes.length) return 0;
  return Number.isFinite(raw)
    ? Math.min(Math.max(0, raw), swipes.length - 1)
    : Math.max(0, swipes.length - 1);
};

export const deleteSwipeBranchCore = ({
  scrollEl,
  msgId,
  swipeIndex = null,
  applySwipe,
  escapeSelector,
} = {}) => {
  const wrapper = resolveSwipeWrapper(scrollEl, msgId, escapeSelector);
  const message = wrapper?.__chatappMessage;
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : null;
  const swipes = Array.isArray(meta?.swipes) ? meta.swipes : [];
  if (!wrapper || !message || swipes.length <= 1) {
    return { deleted: false, reason: 'missing-or-single-swipe', message: message || null };
  }
  if (meta.swipeRegenerating === true || meta.activeSwipeDraft?.active === true) {
    return { deleted: false, reason: 'generating', message };
  }

  const requested = swipeIndex === null || swipeIndex === undefined
    ? resolveActiveSwipeIndex(message)
    : Math.trunc(Number(swipeIndex));
  if (!Number.isFinite(requested) || requested < 0 || requested >= swipes.length) {
    return { deleted: false, reason: 'invalid-index', message };
  }
  if (swipes[requested]?.draft === true) {
    return { deleted: false, reason: 'draft', message };
  }

  const previousState = {
    content: message.content,
    raw: message.raw,
    rawSource: message.rawSource,
    rawOriginal: message.rawOriginal,
    meta: message.meta,
  };
  const nextSwipes = swipes.map(branch => (branch && typeof branch === 'object' ? { ...branch } : {}));
  const [deletedBranch] = nextSwipes.splice(requested, 1);
  const newIndex = Math.min(requested, nextSwipes.length - 1);
  message.meta = {
    ...meta,
    swipes: nextSwipes,
    activeSwipe: requested,
  };
  delete message.meta.swipeRegenerating;
  delete message.meta.activeSwipeDraft;
  wrapper.__chatappMessage = message;

  const applied = applySwipe?.({ wrapper, message, newIndex }) === true;
  if (!applied) {
    message.content = previousState.content;
    message.raw = previousState.raw;
    message.rawSource = previousState.rawSource;
    message.rawOriginal = previousState.rawOriginal;
    message.meta = previousState.meta;
    wrapper.__chatappMessage = message;
    return { deleted: false, reason: 'apply-failed', message };
  }

  return {
    deleted: true,
    reason: '',
    message,
    deletedIndex: requested,
    newIndex,
    deletedBranch,
  };
};

export const bindSwipeEventsCore = ({
  scrollEl,
  getSwipeHandlers,
} = {}) => {
  if (!scrollEl) return () => {};
  const handleClick = (event) => {
    const btn = event?.target?.closest?.('.rp-swipe-prev, .rp-swipe-next');
    if (!btn) return;
    event.stopPropagation?.();
    const indicator = btn.closest?.('.rp-swipe-indicator');
    if (!indicator) return;
    const busyWrapper = indicator.closest?.('.QQ_chat_charmsg.is-rp-regenerating');
    if (busyWrapper) return;
    const msgId = indicator.dataset?.msgId;
    if (!msgId) return;
    const handlers = typeof getSwipeHandlers === 'function' ? getSwipeHandlers(msgId) : null;
    const wrapper = handlers?.wrapper;
    const message = handlers?.message;
    if (!wrapper || !message) return;

    ensureSwipeMeta(message);
    const { total, active } = resolveSwipeIndicatorState(message);
    if (btn.classList?.contains?.('rp-swipe-prev')) {
      if (active <= 0) return;
      handlers.applySwipe?.({ wrapper, message, newIndex: active - 1 });
      return;
    }
    if (active >= total - 1) {
      handlers.onSwipeRegen?.({ msgId, message });
      return;
    }
    handlers.applySwipe?.({ wrapper, message, newIndex: active + 1 });
  };
  scrollEl.addEventListener?.('click', handleClick);
  return () => scrollEl.removeEventListener?.('click', handleClick);
};

export const createSwipeGenerationStreamCore = ({
  scrollEl,
  msgId,
  meta = {},
  setSwipeRegenerating,
  syncSwipeIndicator,
  renderSwipeContent,
  setStreamingState,
  isNearBottom,
  getStreamAutoFollow,
  setStreamAutoFollow,
  buildAssistantStreamMessage,
  applyReasoningUiState,
  scrollToBottom,
  scheduleFrame,
  cancelFrame,
  escapeSelector,
} = {}) => {
  const wrapper = resolveSwipeWrapper(scrollEl, msgId, escapeSelector);
  const message = wrapper?.__chatappMessage;
  if (!wrapper || !message) return null;
  const streamId = String(meta.id || `swipe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const total = Math.max(1, Number(meta.total) || 1);
  const index = Math.min(Math.max(0, Number(meta.index) || total - 1), total - 1);
  const label = String(meta.label || '生成新回复中...');
  const raf = typeof scheduleFrame === 'function'
    ? scheduleFrame
    : (cb => setTimeout(cb, 16));
  const caf = typeof cancelFrame === 'function'
    ? cancelFrame
    : (handle => clearTimeout(handle));
  let updateHandle = null;
  let pendingState = { content: '' };

  setSwipeRegenerating?.(msgId, true, label);
  syncSwipeIndicator?.(wrapper, index, total, { generating: true });
  renderSwipeContent?.(wrapper, message, '', { streaming: true, placeholder: label });
  setStreamingState?.(true);
  setStreamAutoFollow?.(Boolean(isNearBottom?.(24)));

  const flush = (state, { final = false, finalMessage = null } = {}) => {
    if (!wrapper.isConnected) return;
    const renderMessage = finalMessage
      ? { ...message, ...finalMessage, id: message.id }
      : buildAssistantStreamMessage?.(message, meta, message.id || streamId, normalizeAssistantSwipeStreamStateCore(state));
    applyReasoningUiState?.(renderMessage, wrapper.__chatappMessage || message);
    const text = String(renderMessage?.content ?? '');
    wrapper.__chatappMessage = renderMessage;
    renderSwipeContent?.(wrapper, renderMessage, text, { streaming: !final, placeholder: label });
    if (getStreamAutoFollow?.()) scrollToBottom?.();
  };

  return {
    id: streamId,
    isConnected: () => Boolean(wrapper?.isConnected),
    update: (payload) => {
      pendingState = normalizeAssistantSwipeStreamStateCore(payload);
      if (updateHandle != null) return;
      updateHandle = raf(() => {
        updateHandle = null;
        flush(pendingState, { final: false });
      });
    },
    finish: (finalMessage) => {
      setStreamingState?.(false);
      if (updateHandle != null) {
        caf(updateHandle);
        updateHandle = null;
      }
      pendingState = finalMessage ? normalizeAssistantSwipeStreamStateCore(finalMessage) : pendingState;
      flush(pendingState, { final: true, finalMessage });
    },
    cancel: (options = {}) => {
      const keepPartial = Boolean(options && options.keepPartial);
      if (updateHandle != null) {
        caf(updateHandle);
        updateHandle = null;
      }
      setStreamingState?.(false);
      const buffered = buildAssistantStreamMessage?.(
        message,
        meta,
        message.id || streamId,
        normalizeAssistantSwipeStreamStateCore(pendingState),
      );
      const displayText = String(buffered?.content ?? '');
      const rawText = String(
        (typeof buffered?.rawOriginal === 'string' && buffered.rawOriginal.trim() ? buffered.rawOriginal : '')
          || (typeof buffered?.rawSource === 'string' && buffered.rawSource.trim() ? buffered.rawSource : '')
          || (typeof buffered?.raw === 'string' && buffered.raw.trim() ? buffered.raw : '')
          || displayText,
      );
      const partialText = displayText.trim() ? displayText : rawText;
      const reasoningText = String(
        buffered?.reasoningDisplay
          || buffered?.reasoning
          || buffered?.meta?.reasoningDisplay
          || buffered?.meta?.reasoning
          || buffered?.meta?.reasoningSource
          || '',
      );
      if (keepPartial && (String(partialText || '').trim() || reasoningText.trim())) {
        flush(buffered, { final: false });
        return {
          ...(buffered || message),
          role: 'assistant',
          type: 'text',
          id: message.id || streamId,
          content: partialText,
          raw: typeof buffered?.raw === 'string' ? buffered.raw : rawText,
          rawOriginal: typeof buffered?.rawOriginal === 'string' ? buffered.rawOriginal : rawText,
          rawSource:
            typeof buffered?.rawSource === 'string'
              ? buffered.rawSource
              : (typeof buffered?.raw === 'string' ? buffered.raw : rawText),
          meta: {
            ...((buffered?.meta && typeof buffered.meta === 'object') ? buffered.meta : {}),
            partial: true,
            cancelled: true,
          },
        };
      }
      return null;
    },
  };
};

export const createSwipeUiRuntime = ({
  scheduleFrame,
  cancelFrame,
  escapeSelector,
} = {}) => ({
  bindSwipeEvents: params => bindSwipeEventsCore({ ...params, escapeSelector }),
  applySwipe: params => applySwipeCore(params),
  normalizeAssistantStreamState: state => normalizeAssistantSwipeStreamStateCore(state),
  setSwipeRegenerating: params => setSwipeRegeneratingCore({ ...params, escapeSelector }),
  addSwipeBranch: params => addSwipeBranchCore({ ...params, escapeSelector }),
  deleteSwipeBranch: params => deleteSwipeBranchCore({ ...params, escapeSelector }),
  startSwipeGenerationStream: params => createSwipeGenerationStreamCore({
    ...params,
    scheduleFrame,
    cancelFrame,
    escapeSelector,
  }),
});
