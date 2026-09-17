import { getChatTimeMode, initializeProtocolMessageTime } from '../../utils/chat-time-policy.js';

export const buildProtocolGroupChatBatch = async (
  event,
  {
    buildAssistantMessageFromText = null,
    buildSystemMessage = null,
    buildUserMessageFromAI = null,
    formatNowTime = null,
    timeMode = getChatTimeMode(),
    deferTimeDelivery = false,
    isSystemSpeaker = null,
    isUserSpeakerName = null,
    normalizeChatMessage = null,
    resolveGroupSpeakerAvatar = null,
    resolveGroupSpeakerContact = null,
    resolveTargetSessionId = null,
    shouldDropUserEcho = null,
  } = {},
) => {
  const targetSessionId = typeof resolveTargetSessionId === 'function'
    ? String(resolveTargetSessionId(event?.groupName) || '').trim()
    : '';
  if (!targetSessionId) {
    return { targetSessionId: '', items: [], uniqueAssistantSpeakerCount: 0 };
  }
  const fallbackTime = typeof formatNowTime === 'function' ? formatNowTime() : '';
  const items = [];
  for (const rawItem of (event?.messages || [])) {
    const item = typeof normalizeChatMessage === 'function'
      ? normalizeChatMessage(rawItem)
      : rawItem;
    const speaker = item?.speaker;
    const content = item?.content;
    if (typeof isSystemSpeaker === 'function' && isSystemSpeaker(speaker)) {
      const parsed = typeof buildSystemMessage === 'function'
        ? buildSystemMessage({ content, time: rawItem?.time, fallbackTime })
        : null;
      if (parsed) {
        initializeProtocolMessageTime(parsed, { timeMode, modelTime: rawItem?.time, deferDelivery: deferTimeDelivery });
        items.push({ parsed, role: 'system', isSystem: true, isMe: false });
      }
      continue;
    }
    const isMe = typeof isUserSpeakerName === 'function' ? isUserSpeakerName(speaker) : false;
    if (isMe && typeof shouldDropUserEcho === 'function' && shouldDropUserEcho(content, speaker)) {
      continue;
    }
    const role = isMe ? 'user' : 'assistant';
    const speakerContact = isMe
      ? null
      : (typeof resolveGroupSpeakerContact === 'function'
        ? resolveGroupSpeakerContact(speaker, targetSessionId)
        : null);
    const parsed = role === 'assistant'
      ? await buildAssistantMessageFromText(content, {
          sessionId: targetSessionId,
          time: rawItem?.time || fallbackTime,
          name: speaker || '成员',
          avatar: typeof resolveGroupSpeakerAvatar === 'function'
            ? resolveGroupSpeakerAvatar(speaker, targetSessionId, speakerContact)
            : '',
          speakerContactId: speakerContact?.id || '',
          showName: true,
          depth: 0,
        })
      : buildUserMessageFromAI(content, rawItem?.time || fallbackTime);
    initializeProtocolMessageTime(parsed, { timeMode, modelTime: rawItem?.time, deferDelivery: deferTimeDelivery });
    if (role === 'assistant' && item?.rawContent) {
      parsed.meta = {
        ...(parsed.meta || {}),
        autoImagePromptRawContent: String(item.rawContent || ''),
      };
    }
    items.push({ parsed, role, isSystem: false, isMe });
  }
  const uniqueAssistantSpeakerCount = new Set(
    items.filter(item => item.role === 'assistant').map(item => item?.parsed?.name || ''),
  ).size;
  return { targetSessionId, items, uniqueAssistantSpeakerCount };
};

export const buildProtocolPrivateChatBatch = async (
  event,
  {
    buildAssistantMessageFromText = null,
    buildUserMessageFromAI = null,
    formatNowTime = null,
    timeMode = getChatTimeMode(),
    deferTimeDelivery = false,
    isUserSpeakerName = null,
    normalizeDialogueMessage = null,
    resolveTargetSessionId = null,
    shouldDropUserEcho = null,
  } = {},
) => {
  const targetSessionId = typeof resolveTargetSessionId === 'function'
    ? String(resolveTargetSessionId(event?.otherName) || '').trim()
    : '';
  if (!targetSessionId) {
    return { targetSessionId: '', items: [] };
  }
  const fallbackTime = typeof formatNowTime === 'function' ? formatNowTime() : '';
  const items = [];
  for (const rawItem of (event?.messages || [])) {
    const item = typeof normalizeDialogueMessage === 'function'
      ? normalizeDialogueMessage(rawItem)
      : rawItem;
    const speaker = item?.speaker;
    const content = item?.content;
    const time = item?.time;
    if (!content) continue;
    if (typeof shouldDropUserEcho === 'function' && shouldDropUserEcho(content, speaker)) continue;
    const isMe = typeof isUserSpeakerName === 'function' ? isUserSpeakerName(speaker) : false;
    const parsed = isMe
      ? buildUserMessageFromAI(content, time || fallbackTime)
      : await buildAssistantMessageFromText(content, {
          sessionId: targetSessionId,
          time: time || fallbackTime,
          depth: 0,
        });
    initializeProtocolMessageTime(parsed, { timeMode, modelTime: time, deferDelivery: deferTimeDelivery });
    if (!isMe && item?.rawContent) {
      parsed.meta = {
        ...(parsed.meta || {}),
        autoImagePromptRawContent: String(item.rawContent || ''),
      };
    }
    items.push({ parsed, isMe });
  }
  return { targetSessionId, items };
};

export const dispatchProtocolGroupChatBatch = async (
  batch,
  {
    appendMessage = null,
    autoMarkReadIfActive = null,
    bumpReadCount = null,
    emitPluginAfterReceive = null,
    enqueueMessages = null,
    isActive = false,
    animEnabled = false,
    backgroundQueue = false,
    maybeApplyGroupSystemOps = null,
    onAddUiMessage = null,
    onQueueCreated = null,
    queueAvatarUrl = '',
    queueTypingOptions = {},
  } = {},
) => {
  const list = Array.isArray(batch?.items) ? batch.items : [];
  const targetSessionId = String(batch?.targetSessionId || '').trim();
  if (!targetSessionId) return;
  const shouldQueue =
    animEnabled && list.length > 1 && typeof enqueueMessages === 'function' && (isActive || backgroundQueue);
  if (shouldQueue) {
    const queueItems = list.map(({ parsed, isSystem, role }) => ({
      message: parsed,
      delivery: {
        kind: 'group',
        targetSessionId,
        isSystem: Boolean(isSystem),
        role: role || '',
      },
      callback: () => {
        const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
        if (isSystem) {
          if (typeof emitPluginAfterReceive === 'function') emitPluginAfterReceive(saved, targetSessionId);
          if (typeof maybeApplyGroupSystemOps === 'function') maybeApplyGroupSystemOps(parsed.content, targetSessionId);
        } else {
          if (role === 'assistant' && typeof autoMarkReadIfActive === 'function') {
            autoMarkReadIfActive(targetSessionId, saved?.id || parsed?.id || '');
          }
          if (typeof emitPluginAfterReceive === 'function') emitPluginAfterReceive(saved, targetSessionId);
        }
      },
    }));
    const queue = enqueueMessages(queueItems, {
      avatarUrl: queueAvatarUrl,
      typingOptions: queueTypingOptions,
      targetSessionId,
      active: Boolean(isActive),
      background: !isActive,
    });
    if (typeof onQueueCreated === 'function') onQueueCreated(queue);
    await queue?.promise;
  } else {
    for (const { parsed, isSystem, role } of list) {
      if (isActive && typeof onAddUiMessage === 'function') {
        onAddUiMessage(parsed, { autoScroll: animEnabled });
      }
      const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
      if (isSystem) {
        if (typeof emitPluginAfterReceive === 'function') emitPluginAfterReceive(saved, targetSessionId);
        if (typeof maybeApplyGroupSystemOps === 'function') maybeApplyGroupSystemOps(parsed.content, targetSessionId);
      } else {
        if (role === 'assistant' && typeof autoMarkReadIfActive === 'function') {
          autoMarkReadIfActive(targetSessionId, saved?.id || parsed?.id || '');
        }
        if (typeof emitPluginAfterReceive === 'function') emitPluginAfterReceive(saved, targetSessionId);
      }
    }
  }
  if (isActive && typeof bumpReadCount === 'function' && Number(batch?.uniqueAssistantSpeakerCount) > 0) {
    bumpReadCount(batch.uniqueAssistantSpeakerCount);
  }
};

export const dispatchProtocolPrivateChatBatch = async (
  batch,
  {
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    enqueueMessages = null,
    isActive = false,
    animEnabled = false,
    backgroundQueue = false,
    onAddUiMessage = null,
    onQueueCreated = null,
    queueAvatarUrl = '',
    queueTypingOptions = {},
  } = {},
) => {
  const list = Array.isArray(batch?.items) ? batch.items : [];
  const targetSessionId = String(batch?.targetSessionId || '').trim();
  if (!targetSessionId) return;
  const shouldQueue =
    animEnabled && list.length > 1 && typeof enqueueMessages === 'function' && (isActive || backgroundQueue);
  if (shouldQueue) {
    const queueItems = list.map(({ parsed, isMe }) => ({
      message: parsed,
      delivery: {
        kind: 'private',
        targetSessionId,
        isMe: Boolean(isMe),
      },
      callback: () => {
        const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
        if (!isMe && typeof autoMarkReadIfActive === 'function') {
          autoMarkReadIfActive(targetSessionId, saved?.id || parsed?.id || '');
        }
        if (typeof emitPluginAfterReceive === 'function') emitPluginAfterReceive(saved, targetSessionId);
      },
    }));
    const queue = enqueueMessages(queueItems, {
      avatarUrl: queueAvatarUrl,
      typingOptions: queueTypingOptions,
      targetSessionId,
      active: Boolean(isActive),
      background: !isActive,
    });
    if (typeof onQueueCreated === 'function') onQueueCreated(queue);
    await queue?.promise;
  } else {
    for (const { parsed, isMe } of list) {
      if (isActive && typeof onAddUiMessage === 'function') {
        onAddUiMessage(parsed, { autoScroll: animEnabled });
      }
      const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
      if (!isMe && typeof autoMarkReadIfActive === 'function') {
        autoMarkReadIfActive(targetSessionId, saved?.id || parsed?.id || '');
      }
      if (typeof emitPluginAfterReceive === 'function') emitPluginAfterReceive(saved, targetSessionId);
    }
  }
};
