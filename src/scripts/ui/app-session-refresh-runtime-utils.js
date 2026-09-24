export const rerenderCurrentSessionHistory = async ({
  getCurrentSessionId = () => '',
  getHistoryRevision = null,
  ensureRecentMessagesLoaded = async () => [],
  cancelInitialHistoryFill = () => {},
  clearMessages = () => {},
  decorateMessagesForDisplay = (messages) => messages,
  preloadHistory = () => {},
  setRenderState = () => {},
  refreshChatAndContacts = () => {},
  pageSize = 90,
} = {}) => {
  try {
    const sessionId = getCurrentSessionId();
    const historyRevision = typeof getHistoryRevision === 'function'
      ? getHistoryRevision(sessionId)
      : null;
    const messages = await ensureRecentMessagesLoaded(sessionId);
    if (String(getCurrentSessionId() || '') !== String(sessionId || '')) return false;
    if (
      typeof getHistoryRevision === 'function'
      && getHistoryRevision(sessionId) !== historyRevision
    ) return false;
    cancelInitialHistoryFill(sessionId);
    clearMessages();
    const limit = Math.max(0, Number(pageSize) || 0);
    const start = Math.max(0, (messages || []).length - limit);
    preloadHistory(decorateMessagesForDisplay((messages || []).slice(start), { sessionId }));
    setRenderState(sessionId, { start });
    refreshChatAndContacts();
    return true;
  } catch {
    return false;
  }
};

/* 合并整页重建：同一轮里连续的触发（例如切预设时 preset-changed 与 regex-changed 先后到达）只重建一次；
   重建进行中又有触发时，结束后再补跑一次，保证最后一次触发之后的状态一定被渲染。
   所有调用方拿到的 promise 都在“补跑”结束后才完成。 */
export const createCoalescedRerender = (run, {
  schedule = fn => setTimeout(fn, 0),
} = {}) => {
  let pending = null;
  let dirty = false;
  return () => {
    if (pending) {
      dirty = true;
      return pending;
    }
    dirty = true;
    pending = new Promise(resolve => {
      schedule(async () => {
        let result = false;
        try {
          while (dirty) {
            dirty = false;
            result = await run();
          }
        } catch {
          result = false;
        } finally {
          pending = null;
          resolve(result);
        }
      });
    });
    return pending;
  };
};

export const applyMemoryTablePushEvent = ({
  detail = null,
  getCurrentSessionId = () => '',
  getAssistantAvatarForSession = () => '',
  formatNowTime = () => '',
  addMessage = () => {},
  appendMessage = (message) => message,
  autoMarkReadIfActive = () => {},
  refreshChatAndContacts = () => {},
} = {}) => {
  const sessionId = String(detail?.sessionId || '').trim();
  const content = String(detail?.content || '').trim();
  if (!sessionId || !content) return null;
  const message = {
    role: 'assistant',
    type: 'text',
    name: '助手',
    avatar: getAssistantAvatarForSession(sessionId),
    time: formatNowTime(),
    content,
    meta: { renderRich: true, kind: 'memory-table-push' },
  };
  if (String(getCurrentSessionId() || '') === sessionId) {
    addMessage(message);
  }
  const saved = appendMessage(message, sessionId);
  autoMarkReadIfActive(sessionId, saved?.id || message?.id || '');
  refreshChatAndContacts();
  return saved || message;
};
