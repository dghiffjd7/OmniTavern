import { translateUiText } from '../../i18n/index.js';

export const SELF_REACTION_ACTOR = '__self__';
export const DEFAULT_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const clampPreview = (value, maxLength = 120) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!Number.isFinite(Number(maxLength)) || Number(maxLength) <= 0 || text.length <= Number(maxLength)) return text;
  return `${text.slice(0, Math.max(0, Number(maxLength) - 1)).trimEnd()}…`;
};

const cleanPreviewText = (value) =>
  String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeReactionActorId = (value) => {
  const actor = String(value || '').trim();
  return actor || SELF_REACTION_ACTOR;
};

const normalizeEmojiValue = (value) => {
  const text = String(value || '').trim();
  if (text.startsWith('custom:')) return /^custom:[a-f0-9]{64}$/.test(text) ? text : '';
  return clampPreview(text, 16);
};

export const getMessagePreviewText = (message, { maxLength = 120, fallback = '...' } = {}) => {
  const msg = message && typeof message === 'object' ? message : {};
  const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : null;
  // 预览渲染进 .chat-item-preview 等 DOM 翻译器跳过容器，类型标记必须在 JS 侧翻译。
  if (meta?.attachmentsOnly) return translateUiText('[附件]');
  if (msg.role === 'assistant' && meta?.summary) {
    const summary = cleanPreviewText(meta.summary);
    if (summary) return clampPreview(summary, maxLength);
  }
  switch (String(msg.type || 'text')) {
    case 'image':
      return translateUiText('[图片]');
    case 'audio':
      return translateUiText('[语音]');
    case 'music':
      return clampPreview(`${translateUiText('[音乐]')} ${String(msg.content || '').trim()}`.trim(), maxLength);
    case 'transfer':
      return clampPreview(`${translateUiText('[转账]')} ${String(msg.content || '').trim()}`.trim(), maxLength);
    case 'sticker':
      return translateUiText('[表情]');
    case 'document':
      return clampPreview(`${translateUiText('[文件]')} ${String(msg.content || '').trim()}`.trim(), maxLength);
    default: {
      const raw = typeof msg.raw === 'string' && msg.raw.trim() ? msg.raw : msg.content;
      const cleaned = cleanPreviewText(raw);
      return clampPreview(cleaned || fallback, maxLength);
    }
  }
};

export const normalizeReplyTarget = (input, { maxLength = 120 } = {}) => {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id || '').trim();
  const author = String(input.author || input.name || '').trim();
  const hasPreviewSource =
    String(input.content || '').trim().length > 0
    || String(input.raw || '').trim().length > 0
    || (input.meta && typeof input.meta === 'object' && String(input.meta.summary || '').trim().length > 0);
  const content = getMessagePreviewText(
    {
      type: input.type || 'text',
      role: input.role || '',
      content: input.content || '',
      raw: input.raw || '',
      meta: input.meta && typeof input.meta === 'object' ? input.meta : undefined,
    },
    { maxLength, fallback: hasPreviewSource ? '...' : '' },
  );
  if (!id && !author && !content) return null;
  return {
    id,
    role: String(input.role || '').trim(),
    type: String(input.type || 'text').trim() || 'text',
    author,
    avatar: String(input.avatar || '').trim(),
    content,
    sessionId: String(input.sessionId || '').trim(),
  };
};

export const buildReplyTargetSnapshot = (message, { author = '', avatar = '', sessionId = '', maxLength = 120 } = {}) => {
  if (!message || typeof message !== 'object') return null;
  return normalizeReplyTarget(
    {
      id: message.id,
      role: message.role,
      type: message.type || 'text',
      author: author || message.name || '',
      avatar: avatar || message.avatar || '',
      content: message.content || '',
      raw: message.raw || '',
      meta: message.meta,
      sessionId: sessionId || message.sessionId || '',
    },
    { maxLength },
  );
};

export const attachReplyTargetToMessage = (message, replyTarget) => {
  const msg = message && typeof message === 'object' ? message : null;
  const nextReply = normalizeReplyTarget(replyTarget);
  if (!msg || !nextReply) return msg;
  const meta = msg.meta && typeof msg.meta === 'object' ? { ...msg.meta } : {};
  meta.replyTo = nextReply;
  return { ...msg, meta };
};

export const buildOutgoingReplyContexts = (messages = []) => {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((message) => {
      const replyTo = normalizeReplyTarget(message?.meta?.replyTo);
      if (!replyTo) return null;
      return {
        userMessage: getMessagePreviewText(message, { maxLength: 80, fallback: '[消息]' }),
        replyTo,
      };
    })
    .filter(Boolean);
};

export const getRpFloorLabel = (floor) => (Number(floor) === 0 ? '#0 序章' : `# ${Number(floor)}`);

export const buildRpFloorAssignments = (messages = []) => {
  let currentFloor = -1;
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const msg = message && typeof message === 'object' ? message : null;
    if (!msg || msg.role === 'system') {
      return { floor: null, marker: false };
    }

    let marker = false;
    if (msg?.meta?.isGreeting) {
      currentFloor = 0;
      marker = true;
    } else if (msg.role === 'user') {
      currentFloor = Math.max(currentFloor, 0) + 1;
      marker = true;
    }

    if (currentFloor < 0) {
      return { floor: null, marker: false };
    }

    return {
      floor: currentFloor,
      marker,
    };
  });
};

export const normalizeReactionEntries = (input) => {
  const list = Array.isArray(input) ? input : [];
  const byEmoji = new Map();
  list.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const emoji = normalizeEmojiValue(entry.emoji);
    if (!emoji) return;
    const actors = Array.isArray(entry.actors)
      ? entry.actors.map(normalizeReactionActorId).filter(Boolean)
      : [];
    const uniqActors = [];
    actors.forEach((actor) => {
      if (!uniqActors.includes(actor)) uniqActors.push(actor);
    });
    if (!uniqActors.length) return;
    if (!byEmoji.has(emoji)) {
      byEmoji.set(emoji, { emoji, actors: uniqActors, ...(emoji.startsWith('custom:') ? { name: clampPreview(entry.name || '自定义反应', 40) } : {}) });
      return;
    }
    const current = byEmoji.get(emoji);
    uniqActors.forEach((actor) => {
      if (!current.actors.includes(actor)) current.actors.push(actor);
    });
  });
  return Array.from(byEmoji.values());
};

export const toggleReactionActor = (input, emoji, actorId = SELF_REACTION_ACTOR, { name = '' } = {}) => {
  const targetEmoji = normalizeEmojiValue(emoji);
  if (!targetEmoji) return normalizeReactionEntries(input);
  const actor = normalizeReactionActorId(actorId);
  const list = normalizeReactionEntries(input).map((entry) => ({ ...entry, actors: entry.actors.slice() }));
  const index = list.findIndex((entry) => entry.emoji === targetEmoji);
  if (index === -1) {
    list.push({ emoji: targetEmoji, actors: [actor], ...(targetEmoji.startsWith('custom:') ? { name: clampPreview(name || '自定义反应', 40) } : {}) });
    return list;
  }
  const nextActors = list[index].actors.filter((item) => item !== actor);
  if (nextActors.length) {
    list[index].actors = nextActors;
    return list;
  }
  list.splice(index, 1);
  return list;
};

export const countReactionActors = (entry) => {
  const actors = Array.isArray(entry?.actors) ? entry.actors : [];
  return actors.length;
};

export const hasReactionActor = (entry, actorId = SELF_REACTION_ACTOR) => {
  const actor = normalizeReactionActorId(actorId);
  return Array.isArray(entry?.actors) && entry.actors.includes(actor);
};
