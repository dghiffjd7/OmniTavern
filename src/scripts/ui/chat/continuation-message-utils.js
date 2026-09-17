import { preserveMessageDisplayTime } from '../../utils/chat-time-policy.js';

const normalizeObject = (value) => (value && typeof value === 'object' ? value : null);

const buildContinuationMeta = ({ existing = null, message = null, partial = false } = {}) => {
  const nextMeta = {
    ...((normalizeObject(existing?.meta)) || {}),
    ...((normalizeObject(message?.meta)) || {}),
  };
  if (partial) {
    nextMeta.partial = true;
    nextMeta.cancelled = true;
  } else {
    delete nextMeta.partial;
    delete nextMeta.cancelled;
  }
  return nextMeta;
};

const buildUpdatedSwipes = ({ existing = null, message = null, raw = '' } = {}) => {
  const existingSwipes = Array.isArray(existing?.meta?.swipes) ? existing.meta.swipes : null;
  if (!existingSwipes?.length) return null;

  const swipes = existingSwipes.map((entry) => ({ ...(entry || {}) }));
  const rawIndex = Math.trunc(Number(existing?.meta?.activeSwipe));
  const activeIndex = Number.isFinite(rawIndex)
    ? Math.min(Math.max(0, rawIndex), swipes.length - 1)
    : swipes.length - 1;
  if (swipes[activeIndex]) {
    swipes[activeIndex] = {
      ...swipes[activeIndex],
      content: String(message?.content || ''),
      raw,
    };
  }
  return { swipes, activeIndex };
};

export const buildContinuationMessageUpdate = ({
  existing = null,
  message = null,
  targetId = '',
  fallbackTime = '',
  partial = false,
} = {}) => {
  const current = normalizeObject(existing) || {};
  const nextMessage = normalizeObject(message) || {};
  const raw = typeof nextMessage.raw === 'string' ? nextMessage.raw : String(nextMessage.content || '');
  const nextMeta = buildContinuationMeta({ existing: current, message: nextMessage, partial });
  const swipeState = buildUpdatedSwipes({ existing: current, message: nextMessage, raw });
  if (swipeState) {
    nextMeta.swipes = swipeState.swipes;
    nextMeta.activeSwipe = swipeState.activeIndex;
  }

  const updated = {
    ...current,
    ...nextMessage,
    id: targetId,
    role: 'assistant',
    type: nextMessage.type || current.type || 'text',
    name: nextMessage.name || current.name || '助手',
    avatar: nextMessage.avatar || current.avatar,
    time: nextMessage.time || current.time || fallbackTime,
    content: String(nextMessage.content || ''),
    raw,
    rawOriginal:
      typeof nextMessage.rawOriginal === 'string'
        ? nextMessage.rawOriginal
        : (typeof current.rawOriginal === 'string' ? current.rawOriginal : raw),
    rawSource:
      typeof nextMessage.rawSource === 'string'
        ? nextMessage.rawSource
        : (typeof current.rawSource === 'string' ? current.rawSource : undefined),
    meta: nextMeta,
  };
  return current.meta?.chatTime ? preserveMessageDisplayTime(updated, current) : updated;
};

export const commitContinuationMessageToStore = ({
  message = null,
  partial = false,
  continueTarget = null,
  sessionId = '',
  chatStore = null,
  isSessionActive = () => false,
  updateUiMessage = () => {},
  formatNowTime = () => '',
} = {}) => {
  const targetId = String(continueTarget?.messageId || '').trim();
  if (!targetId || !message) return null;
  const existing = chatStore?.findMessage?.(targetId, sessionId) || continueTarget?.message || null;
  if (!existing) return null;

  const updatePayload = buildContinuationMessageUpdate({
    existing,
    message,
    targetId,
    fallbackTime: formatNowTime(),
    partial,
  });
  const saved = chatStore?.updateMessage?.(targetId, updatePayload, sessionId) || { ...existing, ...updatePayload };
  if (isSessionActive(sessionId)) updateUiMessage(targetId, saved);
  return saved;
};
