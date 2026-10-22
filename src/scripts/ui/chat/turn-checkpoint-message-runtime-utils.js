export const buildSwipeMemoryStateKey = (sessionId, msgId, index) => {
  const sid = String(sessionId || '').trim();
  const mid = String(msgId || '').trim();
  const idx = Math.trunc(Number(index));
  if (!sid || !mid || !Number.isFinite(idx) || idx < 0) return '';
  return `${sid}:${mid}:${idx}`;
};

export const createSwipeMemoryStateTracker = () => {
  let activeSwipeMemoryStateKey = '';
  return {
    markActive(sessionId, msgId, index) {
      activeSwipeMemoryStateKey = buildSwipeMemoryStateKey(sessionId, msgId, index);
      return activeSwipeMemoryStateKey;
    },
    canPersistOutgoing(sessionId, msgId, index, branch) {
      const key = buildSwipeMemoryStateKey(sessionId, msgId, index);
      if (!key) return false;
      if (activeSwipeMemoryStateKey === key) return true;
      return !branch?.memoryTableSnapshot;
    },
    getActiveKey() {
      return activeSwipeMemoryStateKey;
    },
  };
};

export const normalizeCheckpointSwipeState = (
  message,
  {
    clonePlainObject = value => value,
    cloneMemoryUpdateEntry = value => value,
  } = {},
) => {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  let swipes = Array.isArray(meta.swipes) && meta.swipes.length
    ? meta.swipes.map(branch => (branch && typeof branch === 'object' ? clonePlainObject(branch) || {} : {}))
    : [{
        content: String(message?.content ?? ''),
        raw: typeof message?.raw === 'string' ? message.raw : String(message?.content ?? ''),
      }];
  if (!swipes.length) {
    swipes = [{
      content: String(message?.content ?? ''),
      raw: typeof message?.raw === 'string' ? message.raw : String(message?.content ?? ''),
    }];
  }
  if (meta.memoryTableSnapshot && !swipes[0]?.memoryTableSnapshot) {
    swipes[0].memoryTableSnapshot = clonePlainObject(meta.memoryTableSnapshot);
  }
  if (meta.memoryUpdateEntry && swipes[0]?.memoryUpdateEntry === undefined) {
    swipes[0].memoryUpdateEntry = cloneMemoryUpdateEntry(meta.memoryUpdateEntry);
  }
  // C 计划 M1：变量快照 meta→swipes[0] 回填（与记忆平行）。
  if (meta.variableSnapshot && !swipes[0]?.variableSnapshot) {
    swipes[0].variableSnapshot = clonePlainObject(meta.variableSnapshot);
  }
  const rawActive = Math.trunc(Number(meta.activeSwipe));
  const activeSwipeIndex = Number.isFinite(rawActive)
    ? Math.min(Math.max(0, rawActive), Math.max(0, swipes.length - 1))
    : 0;
  return {
    meta: clonePlainObject(meta) || {},
    swipes,
    activeSwipeIndex,
  };
};

// 检查点里的写表记录不带请求提示词和原始输出（见 turn-checkpoint-store.js），还原时以消息自带的写表记录为准。
export const withMessageMemoryUpdateEntry = (branch, messageBranch) => {
  const base = branch && typeof branch === 'object' ? branch : {};
  const entry = messageBranch?.memoryUpdateEntry;
  return entry ? { ...base, memoryUpdateEntry: entry } : base;
};

export const findPreviousUserMessageIdForAssistant = (messages, assistantMessageId) => {
  const aid = String(assistantMessageId || '').trim();
  if (!aid) return '';
  const list = Array.isArray(messages) ? messages : [];
  const idx = list.findIndex(message => String(message?.id || '') === aid);
  if (idx === -1) return '';
  for (let i = idx - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!item || item.role !== 'user') continue;
    if (item?.meta?.generatedByAssistant === true) continue;
    return String(item.id || '').trim();
  }
  return '';
};

export const resolveTurnIndexForAssistant = (messages, assistantMessageId, userMessageId = '') => {
  const aid = String(assistantMessageId || '').trim();
  if (!aid) return 0;
  const list = Array.isArray(messages) ? messages : [];
  let targetUserId = String(userMessageId || '').trim();
  if (!targetUserId) targetUserId = findPreviousUserMessageIdForAssistant(list, aid);
  if (!targetUserId) return 0;
  let count = 0;
  for (const item of list) {
    if (!item || item.role !== 'user' || item?.meta?.generatedByAssistant === true) continue;
    count += 1;
    if (String(item.id || '') === targetUserId) return count;
  }
  return count;
};

export const resolveAssistantFloorForCheckpoint = (
  messages,
  assistantMessageId,
  isTrackedAssistantMessage = message => Boolean(message),
) => {
  const aid = String(assistantMessageId || '').trim();
  if (!aid) return 0;
  const list = Array.isArray(messages) ? messages : [];
  let count = 0;
  for (const item of list) {
    if (!isTrackedAssistantMessage(item)) continue;
    count += 1;
    if (String(item?.id || '') === aid) return count;
  }
  return count;
};

export const findTailTrackedAssistantMessage = (
  messages,
  isTrackedAssistantMessage = message => Boolean(message),
) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isTrackedAssistantMessage(list[i])) return list[i];
  }
  return null;
};

export const buildTurnCheckpointHydrationThreadKey = (sessionId, archiveId = '') => {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  return `${sid}::${String(archiveId || '').trim()}`;
};
