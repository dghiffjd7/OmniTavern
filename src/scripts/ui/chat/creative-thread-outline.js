// 当前存档的轻量索引（条号、角色、轮次、预览原料），刻度导航与楼层编号共用。
// 只读：画面只加载了最近几块时，从存档读取完整消息建索引，不改动聊天记录。

const AI_SOURCE_LIMIT = 1600;
const USER_SOURCE_LIMIT = 200;

const isConversationMessage = message => (
  (message?.role === 'user' || message?.role === 'assistant')
  && message?.meta?.transient !== true
  && String(message?.type || 'text') !== 'divider'
);

// 索引条目只留预览要用的前段文字，不常驻整条消息。
export const buildCreativeScrubberIndex = (messages = []) => {
  const entries = [];
  let turn = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isConversationMessage(message)) continue;
    const isUser = message.role === 'user';
    if (isUser && message?.meta?.generatedByAssistant !== true) turn += 1;
    entries.push({
      id: String(message.id || ''),
      role: isUser ? 'user' : 'ai',
      turn,
      ts: Number(message.timestamp) || 0,
      source: isUser
        ? String(message.rawInput ?? message.raw ?? message.content ?? '').slice(0, USER_SOURCE_LIMIT)
        : String(message.content ?? message.raw ?? '').slice(0, AI_SOURCE_LIMIT),
    });
  }
  const indexById = new Map(entries.map((entry, k) => [entry.id, k + 1]));
  // usersBefore[k]：第 k 条（从 0 起）之前有几条用户消息，楼层编号的起点
  const usersBefore = new Array(entries.length);
  let users = 0;
  entries.forEach((entry, k) => {
    usersBefore[k] = users;
    if (entry.role === 'user') users += 1;
  });
  return { entries, indexById, usersBefore };
};

export const createCreativeThreadOutline = ({
  chatStore = null,
  getArchiveId = () => '',
  logger = null,
} = {}) => {
  const cache = new Map(); // sid -> { key, outline }
  const building = new Map(); // sid -> { key, promise }

  const loadedKey = (sid) => {
    const loaded = chatStore?.getMessages?.(sid) || [];
    const older = chatStore?.hasOlderMessages?.(sid) ? 'older' : 'all';
    return `${getArchiveId(sid) || ''}|${older}|${loaded.length}|${loaded[0]?.id || ''}|${loaded[loaded.length - 1]?.id || ''}`;
  };

  const ensure = async (sessionId) => {
    const sid = String(sessionId || '').trim();
    if (!sid || !chatStore) return null;
    const key = loadedKey(sid);
    const cached = cache.get(sid);
    if (cached?.key === key) return cached.outline;
    const pending = building.get(sid);
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      let messages = chatStore.getMessages?.(sid) || [];
      if (chatStore.hasOlderMessages?.(sid) && typeof chatStore.exportThreadMessages === 'function') {
        const exported = await chatStore.exportThreadMessages(sid, getArchiveId(sid) || '');
        if (Array.isArray(exported) && exported.length >= messages.length) messages = exported;
      }
      const outline = buildCreativeScrubberIndex(messages);
      cache.set(sid, { key, outline });
      return outline;
    })().catch((err) => {
      logger?.debug?.('creative thread outline failed', err);
      return cache.get(sid)?.outline || null;
    }).finally(() => {
      if (building.get(sid)?.key === key) building.delete(sid);
    });
    building.set(sid, { key, promise });
    return promise;
  };

  const peek = sid => cache.get(String(sid || '').trim())?.outline || null;

  // 已加载范围之前有几条用户消息；索引还没建好或对不上时返回 null。
  const usersBefore = (sessionId, messageId) => {
    const outline = peek(sessionId);
    const index = outline?.indexById.get(String(messageId || ''));
    return index ? outline.usersBefore[index - 1] : null;
  };

  return { ensure, peek, usersBefore, loadedKey };
};
