import { appSettings } from '../storage/app-settings.js';

export const getChatTimeMode = (settings = appSettings.get()) => settings?.chatAiTimeEnabled === true ? 'ai' : 'local';

export const normalizeChatProtocolTime = value => {
  const text = String(value ?? '').trim().replaceAll('：', ':');
  const match = text.match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match || Number(match[1]) >= 24) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}${match[3] ? `:${match[3]}` : ''}`;
};

export const formatLocalChatTime = (at = Date.now()) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Called once for a NEW protocol message. Existing records have their own
// frozen policy, so toggling the setting cannot rewrite history.
export const initializeProtocolMessageTime = (message, {
  timeMode = getChatTimeMode(), modelTime = '', now = Date.now(), deferDelivery = false,
} = {}) => {
  if (!message || message.meta?.chatTime) return message;
  const model = normalizeChatProtocolTime(modelTime);
  const source = timeMode === 'ai' && model ? 'ai' : 'local';
  message.time = source === 'ai' ? model : formatLocalChatTime(now);
  message.meta = {
    ...(message.meta || {}),
    chatTime: {
      source,
      receivedAt: now,
      ...(model ? { modelTime: model } : {}),
      ...(source === 'local' && deferDelivery ? { pendingDelivery: true } : { deliveredAt: now }),
    },
  };
  return message;
};

// Business timestamps are intentionally untouched: sorting, unread cursors
// and memory coverage keep their original commit chronology.
export const resolveProtocolDeliveryTimePatch = (message, now = Date.now()) => {
  const state = message?.meta?.chatTime;
  if (state?.source !== 'local' || state.pendingDelivery !== true) return null;
  return {
    time: formatLocalChatTime(now),
    meta: { ...(message.meta || {}), chatTime: { ...state, pendingDelivery: false, deliveredAt: now } },
  };
};

export const preserveMessageDisplayTime = (next, previous) => {
  if (!next || !previous) return next;
  next.time = previous.time ?? next.time;
  if (previous.meta?.chatTime) {
    next.meta = { ...(next.meta || {}), chatTime: { ...previous.meta.chatTime, pendingDelivery: false } };
  }
  return next;
};

// Format repair can replace a whole turn. Match bubbles within each recipient
// and speaker in their original order, before the replacement reaches the UI.
export const createRepairMessageTimeRestorer = (records = []) => {
  const queues = new Map();
  const restored = new WeakSet();
  const keyFor = (message, sessionId) => JSON.stringify([sessionId, message?.role, message?.name || '']);
  for (const { message, sessionId } of records) {
    if (!message) continue;
    const key = keyFor(message, sessionId);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(message);
  }
  return (message, sessionId) => {
    if (!message || restored.has(message)) return message;
    restored.add(message);
    const previous = queues.get(keyFor(message, sessionId))?.shift();
    return previous ? preserveMessageDisplayTime(message, previous) : message;
  };
};
