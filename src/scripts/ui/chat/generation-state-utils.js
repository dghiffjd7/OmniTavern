import {
  normalizeLifecycleTraceDetails,
  normalizeLifecycleTraceText,
} from './lifecycle-trace-utils.js';

const normalizeObject = (value) => (value && typeof value === 'object' ? value : null);
const noop = () => {};

const callSafely = (fn, ...args) => {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch {
    return undefined;
  }
};

const firstNonBlankText = (...values) => values
  .map(value => String(value ?? ''))
  .find(value => value.trim()) || '';

const getPartialReasoningText = (partial = null) => {
  const meta = normalizeObject(partial?.meta) || {};
  return firstNonBlankText(partial?.reasoningDisplay, partial?.reasoning, meta.reasoningDisplay, meta.reasoning);
};

const getPartialPersistableText = (partial = null) => firstNonBlankText(
  partial?.content,
  partial?.raw,
  partial?.rawSource,
  partial?.rawOriginal,
  getPartialReasoningText(partial),
);

const hasPartialContent = (partial = null) => Boolean(getPartialPersistableText(partial).trim());

const copyDefinedReasoningFields = (target, ...sources) => {
  const out = target && typeof target === 'object' ? target : {};
  ['reasoning', 'reasoningDisplay', 'reasoningSource', 'reasoningHidden', 'reasoningLabel', 'renderRich', 'streamMode']
    .forEach((key) => {
      for (const source of sources) {
        if (!source || typeof source !== 'object' || source[key] === undefined) continue;
        out[key] = source[key];
        break;
      }
    });
  return out;
};

export const buildGenerationCancelTraceEvent = ({
  sessionId = '',
  generationId,
  reason = 'user',
  status = 'info',
  hasPartial,
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, 'info');
  const details = {
    generationId,
    reason: normalizeLifecycleTraceText(reason, ''),
  };
  if (hasPartial !== undefined) details.hasPartial = Boolean(hasPartial);
  return {
    phase: 'generation.cancel',
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    status: normalizedStatus,
    summary: normalizedStatus === 'success'
      ? 'generation cancel completed'
      : (normalizedStatus === 'started' ? 'generation cancel requested' : 'generation cancel event'),
    details: normalizeLifecycleTraceDetails(details),
  };
};

export const createActiveGenerationRecord = ({
  id = 0,
  sessionId = '',
  userMsgId = null,
  partialCommitHandler = null,
  swipeTarget = null,
} = {}) => ({
  id,
  sessionId,
  userMsgId,
  streamCtrl: null,
  streamText: '',
  streamPayload: null,
  streamMeta: null,
  reattachStream: null,
  partialCommitHandler,
  swipeTarget,
  cancelled: false,
  cancelReason: '',
  startedAt: Date.now(),
});

// 生成记录超龄判定：Rust 层 240s 硬超时 + 缓冲；超过即视为流挂死残留的僵尸记录。
export const GENERATION_STALE_MS = 300_000;
export const isGenerationRecordStale = (generation = null, now = Date.now()) => {
  if (!generation || typeof generation !== 'object') return false;
  const startedAt = Number(generation.startedAt) || 0;
  if (!startedAt) return false;
  return now - startedAt > GENERATION_STALE_MS;
};

export const buildCancelledAssistantPartial = ({
  generation = null,
  assistantAvatar = '',
  fallbackTime = '',
} = {}) => {
  const currentGeneration = normalizeObject(generation);
  const payload = normalizeObject(currentGeneration?.streamPayload);
  const streamMeta = normalizeObject(currentGeneration?.streamMeta) || {};
  const payloadMeta = normalizeObject(payload?.meta) || {};
  const partialMeta = copyDefinedReasoningFields({ ...payloadMeta }, payload, streamMeta);
  const reasoningText = getPartialReasoningText({
    ...payload,
    meta: partialMeta,
  });
  const content = String(
    currentGeneration?.streamText
      || payload?.content
      || payload?.raw
      || payload?.rawSource
      || payload?.rawOriginal
      || '',
  );
  const rawText = String(
    payload?.rawOriginal
      || payload?.rawSource
      || payload?.raw
      || content
      || '',
  );
  if (!content.trim() && !rawText.trim() && !reasoningText.trim()) return null;

  return {
    role: 'assistant',
    type: 'text',
    id: streamMeta.id || currentGeneration?.streamCtrl?.id,
    name: streamMeta.name || '助手',
    avatar: streamMeta.avatar || assistantAvatar,
    time: streamMeta.time || fallbackTime,
    content: content || rawText,
    raw: typeof payload?.raw === 'string' ? payload.raw : rawText,
    rawOriginal: typeof payload?.rawOriginal === 'string' ? payload.rawOriginal : rawText,
    rawSource: typeof payload?.rawSource === 'string' ? payload.rawSource : rawText,
    meta: {
      ...partialMeta,
      partial: true,
      cancelled: true,
    },
  };
};

export const buildCancelledAssistantPartialMessage = ({
  partial = null,
  assistantAvatar = '',
  fallbackTime = '',
} = {}) => {
  const source = normalizeObject(partial);
  const raw = typeof source?.raw === 'string' ? source.raw : '';
  const rawSource = typeof source?.rawSource === 'string' ? source.rawSource : '';
  const rawOriginalSource = typeof source?.rawOriginal === 'string' ? source.rawOriginal : '';
  const reasoningText = getPartialReasoningText(source);
  const content = String(source?.content || raw || rawSource || rawOriginalSource || '');
  if (!content.trim() && !raw.trim() && !rawSource.trim() && !rawOriginalSource.trim() && !reasoningText.trim()) return null;
  const resolvedRaw = raw || rawSource || rawOriginalSource || content;
  const rawOriginal = typeof source?.rawOriginal === 'string'
    ? source.rawOriginal
    : resolvedRaw;
  return {
    role: 'assistant',
    type: 'text',
    id: String(source?.id || '').trim() || undefined,
    name: source?.name || '助手',
    avatar: source?.avatar || assistantAvatar,
    time: source?.time || fallbackTime,
    content,
    raw: resolvedRaw,
    rawOriginal,
    rawSource: rawSource || resolvedRaw,
    meta: {
      ...(normalizeObject(source?.meta) || {}),
      partial: true,
      cancelled: true,
    },
  };
};

export const commitCancelledGenerationPartial = ({
  generation = null,
  partial = null,
  reason = 'user',
  chatStore = null,
  logger = null,
  getAssistantAvatarForSession = () => '',
  formatNowTime = () => '',
  refreshChatAndContacts = () => {},
} = {}) => {
  if (reason !== 'user') {
    return {
      attempted: false,
      sessionId: '',
      messageId: '',
      hasContent: false,
      handledPartial: false,
      appended: false,
      skippedExisting: false,
    };
  }
  const currentGeneration = normalizeObject(generation);
  const sessionId = String(currentGeneration?.sessionId || '').trim();
  const content = getPartialPersistableText(partial).trim();
  const messageId = String(partial?.id || '').trim();
  let handledPartial = false;

  const partialCommitHandler =
    typeof currentGeneration?.partialCommitHandler === 'function'
      ? currentGeneration.partialCommitHandler
      : null;
  if (sessionId && content && partialCommitHandler) {
    try {
      handledPartial = partialCommitHandler(partial) === true;
    } catch (err) {
      logger?.warn?.('assistant partial commit failed', err);
    }
  }

  const swipeTarget = normalizeObject(currentGeneration?.swipeTarget);
  if (sessionId && content && typeof swipeTarget?.onPartial === 'function') {
    try {
      handledPartial = swipeTarget.onPartial(partial) === true;
    } catch (err) {
      logger?.warn?.('swipe partial commit failed', err);
    }
  }

  let appended = false;
  let skippedExisting = false;
  if (sessionId && content && !handledPartial) {
    const exists = messageId ? Boolean(chatStore?.findMessage?.(messageId, sessionId)) : false;
    if (exists) {
      skippedExisting = true;
    } else {
      const partialMessage = buildCancelledAssistantPartialMessage({
        partial,
        assistantAvatar: getAssistantAvatarForSession(sessionId),
        fallbackTime: formatNowTime(),
      });
      if (partialMessage) {
        chatStore?.appendMessage?.(partialMessage, sessionId);
        appended = true;
      }
      refreshChatAndContacts();
    }
  }

  return {
    attempted: true,
    sessionId,
    messageId,
    hasContent: Boolean(content),
    handledPartial,
    appended,
    skippedExisting,
  };
};

export const runActiveGenerationCancelFlow = ({
  generation = null,
  reason = 'user',
  recordTraceEvent = noop,
  abortMemoryUpdate = noop,
  cancelCurrentGeneration = noop,
  chatStore = null,
  logger = null,
  getAssistantAvatarForSession = () => '',
  formatNowTime = () => '',
  refreshChatAndContacts = noop,
  cancelDeliverySequence = noop,
  hideTyping = noop,
  setStreamingState = noop,
  setSendingState = noop,
} = {}) => {
  const currentGeneration = normalizeObject(generation);
  if (!currentGeneration || currentGeneration.cancelled) {
    return {
      cancelled: false,
      generation: currentGeneration,
      partial: null,
      commitResult: null,
      sessionId: '',
      hasPartial: false,
    };
  }

  callSafely(recordTraceEvent, buildGenerationCancelTraceEvent({
    sessionId: currentGeneration.sessionId,
    generationId: currentGeneration.id,
    reason,
    status: 'started',
  }));

  try {
    currentGeneration.cancelled = true;
    currentGeneration.cancelReason = String(reason || '').trim();
  } catch {}

  const sessionId = String(currentGeneration.sessionId || '').trim();
  if (sessionId) callSafely(abortMemoryUpdate, sessionId);
  callSafely(cancelCurrentGeneration, reason);
  callSafely(cancelDeliverySequence);

  let partial = null;
  try {
    partial = currentGeneration.streamCtrl?.cancel?.({ keepPartial: reason === 'user' }) || null;
  } catch {}

  if (!partial && reason === 'user') {
    partial = buildCancelledAssistantPartial({
      generation: currentGeneration,
      assistantAvatar: getAssistantAvatarForSession(currentGeneration.sessionId),
      fallbackTime: formatNowTime(),
    });
  }

  let commitResult = null;
  if (reason === 'user') {
    try {
      commitResult = commitCancelledGenerationPartial({
        generation: currentGeneration,
        partial,
        reason,
        chatStore,
        logger,
        getAssistantAvatarForSession,
        formatNowTime,
        refreshChatAndContacts,
      });
    } catch {}
  }

  callSafely(recordTraceEvent, buildGenerationCancelTraceEvent({
    sessionId: currentGeneration.sessionId,
    generationId: currentGeneration.id,
    reason,
    status: 'success',
    hasPartial: hasPartialContent(partial),
  }));

  callSafely(hideTyping);
  callSafely(setStreamingState, false);
  callSafely(setSendingState, false);

  return {
    cancelled: true,
    generation: currentGeneration,
    partial,
    commitResult,
    sessionId,
    hasPartial: hasPartialContent(partial),
  };
};
