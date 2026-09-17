import { getChatTimeMode, initializeProtocolMessageTime } from '../../utils/chat-time-policy.js';

export const applyProtocolMomentEvent = (
  event,
  {
    addMoments = null,
    addMomentComments = null,
    abortOnMissingMomentId = false,
    normalizeComments = null,
  } = {},
) => {
  if (event?.type === 'moments') {
    if (typeof addMoments === 'function') {
      addMoments(event?.moments || []);
    }
    return { consumed: true, didAnything: true, mutatedMoments: true, targetSessionId: '' };
  }
  if (event?.type === 'moment_reply') {
    const momentId = String(event?.momentId || '').trim();
    if (!momentId) {
      return {
        consumed: true,
        didAnything: false,
        mutatedMoments: false,
        targetSessionId: '',
        abortFlow: Boolean(abortOnMissingMomentId),
      };
    }
    if (typeof addMomentComments === 'function') {
      const comments = typeof normalizeComments === 'function'
        ? normalizeComments(event?.comments || [])
        : (event?.comments || []);
      addMomentComments(momentId, comments);
    }
    return {
      consumed: true,
      didAnything: true,
      mutatedMoments: true,
      targetSessionId: '',
      abortFlow: false,
    };
  }
  return {
    consumed: false,
    didAnything: false,
    mutatedMoments: false,
    targetSessionId: '',
    abortFlow: false,
  };
};

export const appendProtocolGroupChatEventImmediate = async (
  event,
  {
    appendMessage = null,
    autoMarkReadIfActive = null,
    buildAssistantMessageFromText = null,
    buildSystemMessage = null,
    buildUserMessageFromAI = null,
    emitPluginAfterReceive = null,
    formatNowTime = null,
    timeMode = getChatTimeMode(),
    deferTimeDelivery = false,
    prepareMessage = null,
    isSessionActive = null,
    isSystemSpeaker = null,
    isUserSpeakerName = null,
    maybeApplyGroupSystemOps = null,
    normalizeChatMessage = null,
    onAddUiMessage = null,
    resolveGroupSpeakerAvatar = null,
    resolveGroupSpeakerContact = null,
    resolveTargetSessionId = null,
    shouldDropUserEcho = null,
  } = {},
) => {
  if (event?.type !== 'group_chat') {
    return { consumed: false, didAnything: false, mutatedMoments: false, targetSessionId: '' };
  }
  const targetSessionId = typeof resolveTargetSessionId === 'function'
    ? String(resolveTargetSessionId(event?.groupName) || '').trim()
    : '';
  if (!targetSessionId) {
    return { consumed: true, didAnything: false, mutatedMoments: false, targetSessionId: '' };
  }
  const fallbackTime = typeof formatNowTime === 'function' ? formatNowTime() : '';
  for (const item of (event?.messages || [])) {
    const normalized = typeof normalizeChatMessage === 'function'
      ? normalizeChatMessage(item)
      : item;
    const speaker = normalized?.speaker;
    const content = normalized?.content;
    if (typeof isSystemSpeaker === 'function' && isSystemSpeaker(speaker)) {
      const parsed = typeof buildSystemMessage === 'function'
        ? buildSystemMessage({ content, time: item?.time, fallbackTime })
        : null;
      if (!parsed) continue;
      initializeProtocolMessageTime(parsed, { timeMode, modelTime: item?.time, deferDelivery: deferTimeDelivery });
      prepareMessage?.(parsed, targetSessionId);
      if (typeof isSessionActive === 'function' && isSessionActive(targetSessionId) && typeof onAddUiMessage === 'function') {
        onAddUiMessage(parsed);
      }
      const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
      if (typeof emitPluginAfterReceive === 'function') {
        emitPluginAfterReceive(saved, targetSessionId);
      }
      if (typeof maybeApplyGroupSystemOps === 'function') {
        maybeApplyGroupSystemOps(parsed.content, targetSessionId);
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
          time: item?.time || fallbackTime,
          name: speaker || '成员',
          avatar: typeof resolveGroupSpeakerAvatar === 'function'
            ? resolveGroupSpeakerAvatar(speaker, targetSessionId, speakerContact)
            : '',
          speakerContactId: speakerContact?.id || '',
          showName: true,
          depth: 0,
        })
      : buildUserMessageFromAI(content, item?.time || fallbackTime);
    initializeProtocolMessageTime(parsed, { timeMode, modelTime: item?.time, deferDelivery: deferTimeDelivery });
    if (role === 'assistant' && normalized?.rawContent) {
      parsed.meta = {
        ...(parsed.meta || {}),
        autoImagePromptRawContent: String(normalized.rawContent || ''),
      };
    }
    prepareMessage?.(parsed, targetSessionId);
    if (typeof isSessionActive === 'function' && isSessionActive(targetSessionId) && typeof onAddUiMessage === 'function') {
      onAddUiMessage(parsed);
    }
    const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
    if (role === 'assistant' && typeof autoMarkReadIfActive === 'function') {
      autoMarkReadIfActive(targetSessionId, saved?.id || parsed?.id || '');
    }
    if (typeof emitPluginAfterReceive === 'function') {
      emitPluginAfterReceive(saved, targetSessionId);
    }
  }
  return { consumed: true, didAnything: true, mutatedMoments: false, targetSessionId };
};

export const appendProtocolPrivateChatEventImmediate = async (
  event,
  {
    appendMessage = null,
    autoMarkReadIfActive = null,
    buildAssistantMessageFromText = null,
    buildUserMessageFromAI = null,
    emitPluginAfterReceive = null,
    formatNowTime = null,
    timeMode = getChatTimeMode(),
    deferTimeDelivery = false,
    prepareMessage = null,
    isSessionActive = null,
    isUserSpeakerName = null,
    normalizeDialogueMessage = null,
    onAddUiMessage = null,
    resolveTargetSessionId = null,
    shouldDropUserEcho = null,
  } = {},
) => {
  if (event?.type !== 'private_chat') {
    return { consumed: false, didAnything: false, mutatedMoments: false, targetSessionId: '' };
  }
  const targetSessionId = typeof resolveTargetSessionId === 'function'
    ? String(resolveTargetSessionId(event?.otherName) || '').trim()
    : '';
  if (!targetSessionId) {
    return { consumed: true, didAnything: false, mutatedMoments: false, targetSessionId: '' };
  }
  const fallbackTime = typeof formatNowTime === 'function' ? formatNowTime() : '';
  for (const item of (event?.messages || [])) {
    const normalized = typeof normalizeDialogueMessage === 'function'
      ? normalizeDialogueMessage(item)
      : item;
    const speaker = normalized?.speaker;
    const content = normalized?.content;
    const time = normalized?.time;
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
    if (!isMe && normalized?.rawContent) {
      parsed.meta = {
        ...(parsed.meta || {}),
        autoImagePromptRawContent: String(normalized.rawContent || ''),
      };
    }
    prepareMessage?.(parsed, targetSessionId);
    if (typeof isSessionActive === 'function' && isSessionActive(targetSessionId) && typeof onAddUiMessage === 'function') {
      onAddUiMessage(parsed);
    }
    const saved = typeof appendMessage === 'function' ? appendMessage(parsed, targetSessionId) : parsed;
    if (!isMe && typeof autoMarkReadIfActive === 'function') {
      autoMarkReadIfActive(targetSessionId, saved?.id || parsed?.id || '');
    }
    if (typeof emitPluginAfterReceive === 'function') {
      emitPluginAfterReceive(saved, targetSessionId);
    }
  }
  return { consumed: true, didAnything: true, mutatedMoments: false, targetSessionId };
};
