const resolveHistoryRole = (message) => (
  message?.role === 'system' ? 'system' : message?.role === 'user' ? 'user' : 'assistant'
);

const listDuplicateMessageIds = (entries = []) => {
  const counts = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const messageId = String(entry?.messageId || '').trim();
    if (!messageId) return;
    counts.set(messageId, Number(counts.get(messageId) || 0) + 1);
  });
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([messageId, count]) => ({ messageId, count }));
};

export const buildHistoryRenderDiagnostics = (messages = [], { tailLimit = 12 } = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Number(tailLimit) || 12);
  const startIndex = Math.max(0, list.length - limit);
  const sourceTail = list.slice(startIndex);
  const tail = sourceTail.map((message, offset) => ({
    index: startIndex + offset,
    fromEnd: sourceTail.length - offset,
    messageId: String(message?.id || '').trim(),
    role: resolveHistoryRole(message),
    type: String(message?.type || 'text'),
    timestamp: Number(message?.timestamp || 0) || 0,
    contentLength: typeof message?.content === 'string' ? message.content.length : 0,
    rawLength: typeof message?.raw === 'string' ? message.raw.length : 0,
    rawSourceLength: typeof message?.rawSource === 'string' ? message.rawSource.length : 0,
    rawOriginalLength: typeof message?.rawOriginal === 'string' ? message.rawOriginal.length : 0,
    renderRich: message?.meta?.renderRich === true,
    status: String(message?.status || ''),
  }));
  const identicalByDisplay = new Map();
  sourceTail.forEach((message, offset) => {
    const content = typeof message?.content === 'string' ? message.content : '';
    if (!content) return;
    const key = `${resolveHistoryRole(message)}\u0000${String(message?.type || 'text')}\u0000${content}`;
    const group = identicalByDisplay.get(key) || [];
    group.push({
      messageId: String(message?.id || '').trim(),
      index: startIndex + offset,
    });
    identicalByDisplay.set(key, group);
  });
  let groupIndex = 0;
  const identicalDisplayGroups = [...identicalByDisplay.values()]
    .filter(group => group.length > 1)
    .map((group) => ({
      group: `display-duplicate-${groupIndex += 1}`,
      count: group.length,
      messageIds: group.map(entry => entry.messageId),
      indexes: group.map(entry => entry.index),
    }));
  return {
    capturesText: false,
    totalMessages: list.length,
    tailStartIndex: startIndex,
    tail,
    duplicateMessageIds: listDuplicateMessageIds(tail),
    identicalDisplayGroups,
  };
};

export const buildRenderedHistoryDiagnostics = (scrollEl, { tailLimit = 20 } = {}) => {
  const nodes = Array.from(scrollEl?.querySelectorAll?.('[data-msg-id][data-role]') || []);
  const entries = nodes.map(node => ({
    messageId: String(node?.dataset?.msgId || '').trim(),
  }));
  const limit = Math.max(1, Number(tailLimit) || 20);
  return {
    renderedMessages: entries.length,
    tailMessageIds: entries.slice(-limit).map(entry => entry.messageId),
    duplicateMessageIds: listDuplicateMessageIds(entries),
  };
};

const findInsertBeforeNode = (scrollEl, insertAfterMessageId = '') => {
  const targetId = String(insertAfterMessageId || '').trim();
  if (!scrollEl || !targetId) return null;
  const children = Array.from(scrollEl.children || []);
  const anchor = children.find(node => String(node?.dataset?.msgId || '') === targetId);
  return anchor?.nextSibling || null;
};

export const buildHistoryRenderMessage = (message, { lazyRichMount = false } = {}) => ({
  role: resolveHistoryRole(message),
  type: message?.type || 'text',
  content: message?.content,
  name: message?.name,
  avatar: message?.avatar,
  time: message?.time,
  timestamp: message?.timestamp,
  meta: message?.meta,
  badge: message?.badge,
  id: message?.id,
  status: message?.status,
  sessionId: message?.sessionId,
  __lazyRichMount: lazyRichMount,
});

export const addMessageCore = ({
  message,
  options = {},
  decorateMessage,
  ensureMessageId,
  syncOriginalMessageId,
  dispatchBeforeRender,
  dispatchAfterRender,
  isNearBottom,
  createRpFloorMarker,
  buildMessageElement,
  scrollEl,
  scrollToBottom,
  schedule,
} = {}) => {
  const original = message;
  const nextMessage = decorateMessage?.(message, { phase: 'add' }) || message;
  const renderedMessage = ensureMessageId?.(nextMessage) || nextMessage;
  syncOriginalMessageId?.(original, renderedMessage);
  dispatchBeforeRender?.(renderedMessage);

  const wasNearBottom = isNearBottom?.();
  const floorMarker = createRpFloorMarker?.(renderedMessage);
  const element = buildMessageElement?.(renderedMessage);
  if (element) {
    const referenceNode = findInsertBeforeNode(scrollEl, options.insertAfterMessageId || options.afterMessageId);
    const insertNode = (node) => {
      if (referenceNode && typeof scrollEl?.insertBefore === 'function') {
        scrollEl.insertBefore(node, referenceNode);
        return;
      }
      scrollEl?.appendChild?.(node);
    };
    if (floorMarker) insertNode(floorMarker);
    element.dataset.newMsg = '1';
    insertNode(element);
    if (renderedMessage?.meta?.floor != null) element.dataset.rpFloor = String(renderedMessage.meta.floor);
    const shouldScroll = options.autoScroll !== false && wasNearBottom;
    if (shouldScroll) scrollToBottom?.();
    schedule?.(() => {
      try {
        delete element.dataset.newMsg;
      } catch {}
    }, 300);
  }
  dispatchAfterRender?.(renderedMessage, element);
  return element?.querySelector?.('.QQ_chat_msgdiv') || element || null;
};

export const preloadHistoryCore = ({
  messages = [],
  keepScroll = false,
  scrollEl,
  documentLike,
  isRp = false,
  createRpFloorMarker,
  buildMessageElement,
  scrollToBottom,
  refreshScrollDateBadge,
  scheduleScrollBottomButtonRefresh,
  onRenderDiagnostics,
} = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const inputDiagnostics = buildHistoryRenderDiagnostics(list);
  if (!list.length || !scrollEl) {
    onRenderDiagnostics?.({
      input: inputDiagnostics,
      dom: buildRenderedHistoryDiagnostics(scrollEl),
      rendered: false,
    });
    return false;
  }
  const eagerTailCount = 8;
  const eagerStart = Math.max(0, list.length - eagerTailCount);
  const fragment = documentLike.createDocumentFragment();
  for (let idx = 0; idx < list.length; idx += 1) {
    const message = list[idx];
    if (isRp) {
      const floorMarker = createRpFloorMarker?.(message);
      if (floorMarker) fragment.appendChild(floorMarker);
    }
    const element = buildMessageElement?.(
      buildHistoryRenderMessage(message, {
        lazyRichMount: Boolean(message?.meta?.renderRich) && idx < eagerStart,
      }),
    );
    if (element) {
      if (isRp && message?.meta?.floor != null) element.dataset.rpFloor = String(message.meta.floor);
      fragment.appendChild(element);
    }
  }
  scrollEl.appendChild(fragment);
  if (!keepScroll) scrollToBottom?.();
  refreshScrollDateBadge?.();
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  onRenderDiagnostics?.({
    input: inputDiagnostics,
    dom: buildRenderedHistoryDiagnostics(scrollEl),
    rendered: true,
  });
  return true;
};

export const prependHistoryCore = ({
  messages = [],
  scrollEl,
  documentLike,
  isRp = false,
  buildMessageElement,
  refreshRpFloorMarkers,
  refreshScrollDateBadge,
  scheduleScrollBottomButtonRefresh,
} = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length || !scrollEl) return false;
  const beforeHeight = Number(scrollEl.scrollHeight) || 0;
  const beforeTop = Number(scrollEl.scrollTop) || 0;
  const fragment = documentLike.createDocumentFragment();
  for (const message of list) {
    const element = buildMessageElement?.(
      buildHistoryRenderMessage(message, {
        lazyRichMount: Boolean(message?.meta?.renderRich),
      }),
    );
    if (element) fragment.appendChild(element);
  }
  const first = scrollEl.firstChild;
  if (first) scrollEl.insertBefore(fragment, first);
  else scrollEl.appendChild(fragment);
  if (isRp) refreshRpFloorMarkers?.();
  const afterHeight = Number(scrollEl.scrollHeight) || 0;
  scrollEl.scrollTop = beforeTop + (afterHeight - beforeHeight);
  refreshScrollDateBadge?.();
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return true;
};

// 在指定节点前插入一批历史消息（折叠占位前后补内容用）。keepViewport：以 beforeNode 为锚保持画面不跳。
export const insertHistoryCore = ({
  messages = [],
  scrollEl,
  documentLike,
  beforeNode = null,
  keepViewport = false,
  isRp = false,
  buildMessageElement,
  refreshRpFloorMarkers,
  refreshScrollDateBadge,
  scheduleScrollBottomButtonRefresh,
} = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length || !scrollEl) return false;
  const anchor = beforeNode && beforeNode.parentNode === scrollEl ? beforeNode : null;
  const anchorTopBefore = keepViewport && anchor ? anchor.getBoundingClientRect().top : 0;
  const fragment = documentLike.createDocumentFragment();
  for (const message of list) {
    const element = buildMessageElement?.(
      buildHistoryRenderMessage(message, {
        lazyRichMount: Boolean(message?.meta?.renderRich),
      }),
    );
    if (element) fragment.appendChild(element);
  }
  if (anchor) scrollEl.insertBefore(fragment, anchor);
  else scrollEl.appendChild(fragment);
  if (isRp) refreshRpFloorMarkers?.();
  if (keepViewport && anchor) {
    const shift = anchor.getBoundingClientRect().top - anchorTopBefore;
    if (shift) scrollEl.scrollTop += shift;
  }
  refreshScrollDateBadge?.();
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return true;
};

export const refreshAvatarsCore = ({
  scrollEl,
  resolver,
} = {}) => {
  if (!scrollEl || typeof resolver !== 'function') return 0;
  let updated = 0;
  const list = scrollEl.querySelectorAll?.('.QQ_chat_mymsg, .QQ_chat_charmsg') || [];
  list.forEach((wrapper) => {
    const message = wrapper.__chatappMessage;
    const img = wrapper.querySelector?.('img.QQ_chat_head');
    if (!img) return;
    const src = resolver(message);
    if (src && img.src !== src) {
      img.src = src;
      updated += 1;
    }
  });
  return updated;
};

export const removeMessageCore = ({
  scrollEl,
  msgId,
  isRp = false,
  cleanupRichTextMounts,
  refreshRpFloorMarkers,
  refreshScrollDateBadge,
  scheduleScrollBottomButtonRefresh,
} = {}) => {
  const element = scrollEl?.querySelector?.(`[data-msg-id="${msgId}"]`);
  if (!element) return false;
  cleanupRichTextMounts?.(element);
  element.remove?.();
  if (isRp) refreshRpFloorMarkers?.();
  refreshScrollDateBadge?.();
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return true;
};

export const updateMessageCore = ({
  scrollEl,
  msgId,
  newMessage,
  resolveMessageSessionId,
  resolveActiveSwipeMessage,
  decorateMessage,
  tryPatchMessageElement,
  buildMessageElement,
  cleanupRichTextMounts,
  refreshScrollDateBadge,
  scheduleScrollBottomButtonRefresh,
} = {}) => {
  const existing = scrollEl?.querySelector?.(`[data-msg-id="${msgId}"]`);
  if (!existing) return null;
  const prev = existing.__chatappMessage && typeof existing.__chatappMessage === 'object'
    ? existing.__chatappMessage
    : {};
  const resolvedSessionId =
    String(newMessage?.sessionId || '').trim()
    || String(prev?.sessionId || '').trim()
    || resolveMessageSessionId?.(prev);
  const next = resolveActiveSwipeMessage?.(decorateMessage?.(
    { ...prev, ...(newMessage || {}), id: msgId, sessionId: resolvedSessionId },
    { phase: 'update', previous: prev },
  ));
  if (tryPatchMessageElement?.(existing, next)) {
    refreshScrollDateBadge?.();
    scheduleScrollBottomButtonRefresh?.({ immediate: true });
    return existing;
  }
  const newEl = buildMessageElement?.(next);
  if (!newEl) return null;
  cleanupRichTextMounts?.(existing);
  existing.replaceWith?.(newEl);
  refreshScrollDateBadge?.();
  scheduleScrollBottomButtonRefresh?.({ immediate: true });
  return newEl;
};
