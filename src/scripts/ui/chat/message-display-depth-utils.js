/* 显示用消息深度：0 = 会话里最新一条对话消息（只数 user / assistant），与正则 min/max depth 对应。
   深度必须按整个会话计算，而不是按这一次要装饰的那批消息计算：往上翻加载更早的片段、
   进房分批补齐历史、单独重绘某条旧消息时，传进来的都只是一小段，按批计算会从 0 数起，
   让“只作用于最近 N 条”的正则错误地命中旧消息。 */

const isConversationMessage = message => Boolean(message && (message.role === 'user' || message.role === 'assistant'));
const messageIdOf = message => String(message?.id ?? '').trim();

const buildDepthIndex = (messages) => {
  const depthById = new Map();
  let depth = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isConversationMessage(message)) continue;
    const id = messageIdOf(message);
    if (id && !depthById.has(id)) depthById.set(id, depth);
    depth += 1;
  }
  return depthById;
};

// 按批内位置计算（原有算法）：用于不在会话消息列表里的消息
export const resolveBatchRelativeDepths = (list = []) => {
  const positions = [];
  list.forEach((message, index) => {
    if (isConversationMessage(message)) positions.push(index);
  });
  const depths = new Array(list.length).fill(undefined);
  positions.forEach((index, order) => {
    depths[index] = positions.length - 1 - order;
  });
  return depths;
};

export const createMessageDisplayDepthResolver = ({
  getSessionMessages = () => [],
  getSessionRevision = () => undefined,
} = {}) => {
  // 数组引用/长度覆盖追加、删除与存档切换；结构版本覆盖原地角色或 ID 修改。
  // 无版本号的可变数据源按 ID、角色和顺序核对快照，不缓存正文或深拷贝消息。
  const cache = new WeakMap();

  const readIndex = (messages, revision, { rebuild = false } = {}) => {
    const lastId = messageIdOf(messages[messages.length - 1]);
    const hit = cache.get(messages);
    if (!rebuild && hit && hit.length === messages.length && hit.lastId === lastId) {
      const unchanged = revision !== undefined
        ? hit.revision === revision
        : hit.structure?.every(([id, conversation], index) => (
          id === messageIdOf(messages[index]) && conversation === isConversationMessage(messages[index])
        ));
      if (unchanged) return hit.depthById;
    }
    const depthById = buildDepthIndex(messages);
    const structure = revision === undefined
      ? messages.map(message => [messageIdOf(message), isConversationMessage(message)])
      : null;
    cache.set(messages, { length: messages.length, lastId, revision, structure, depthById });
    return depthById;
  };

  // 返回与 list 等长的深度数组；非对话消息为 undefined
  const resolveDepths = (sessionId = '', list = []) => {
    const batch = Array.isArray(list) ? list : [];
    const fallback = resolveBatchRelativeDepths(batch);
    const sid = String(sessionId || '').trim();
    const messages = sid ? getSessionMessages(sid) : null;
    if (!Array.isArray(messages) || !messages.length) return fallback;
    const revision = getSessionRevision(sid);
    let depthById = readIndex(messages, revision);
    const missing = batch.some(message => isConversationMessage(message)
      && messageIdOf(message)
      && !depthById.has(messageIdOf(message)));
    if (missing) depthById = readIndex(messages, revision, { rebuild: true });
    return batch.map((message, index) => {
      if (!isConversationMessage(message)) return undefined;
      const id = messageIdOf(message);
      return id && depthById.has(id) ? depthById.get(id) : fallback[index];
    });
  };

  return { resolveDepths };
};
