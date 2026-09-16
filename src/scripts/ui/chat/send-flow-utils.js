import {
  createPendingUserMessage,
  getMessageSendText,
  restorePendingQueueToHistory,
  resolvePendingMessagesToSend,
} from './pending-message-utils.js';
import {
  dispatchAfterSendEvents,
  markMessagesAsSending,
} from './send-side-effect-utils.js';
import {
  normalizeLifecycleTraceDetails,
  normalizeLifecycleTraceText,
} from './lifecycle-trace-utils.js';

const normalizeStringIdList = (items = []) => Array.from(
  new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ),
);

export const collectMaidAssistantMessageRefs = ({
  sourceSessionId = '',
  assistantMessageIdsBefore = [],
  currentSessionMessages = [],
  trackedMessageRefs = [],
  findMessage = null,
} = {}) => {
  const sid = String(sourceSessionId || '').trim();
  const before = new Set(normalizeStringIdList(Array.from(assistantMessageIdsBefore || [])));
  const refs = [];
  const seen = new Set();
  const add = (sessionId, messageId) => {
    const targetSessionId = String(sessionId || '').trim();
    const id = String(messageId || '').trim();
    const key = JSON.stringify([targetSessionId, id]);
    if (!targetSessionId || !id || seen.has(key)) return;
    seen.add(key);
    refs.push({ sessionId: targetSessionId, messageId: id });
  };

  for (const item of (Array.isArray(trackedMessageRefs) ? trackedMessageRefs : [])) {
    const targetSessionId = String(item?.sessionId || item?.targetSessionId || '').trim();
    const messageId = String(item?.messageId || item?.id || '').trim();
    if (!targetSessionId || !messageId || typeof findMessage !== 'function') continue;
    let message = null;
    try {
      message = findMessage(messageId, targetSessionId) || null;
    } catch {}
    if (message?.role === 'assistant') add(targetSessionId, messageId);
  }

  for (const message of (Array.isArray(currentSessionMessages) ? currentSessionMessages : [])) {
    const messageId = String(message?.id || '').trim();
    if (message?.role !== 'assistant' || !messageId || before.has(messageId)) continue;
    add(sid, messageId);
  }
  return refs;
};

export const runAbortableSendFlow = async ({
  signal = null,
  runSend = null,
  abortGeneration = null,
} = {}) => {
  if (typeof runSend !== 'function') return false;
  let abortListenerArmed = true;
  const handleAbort = () => {
    if (!abortListenerArmed) return;
    try {
      abortGeneration?.(signal?.reason);
    } catch {}
  };
  const disarmAbort = () => {
    if (!abortListenerArmed) return false;
    abortListenerArmed = false;
    signal?.removeEventListener?.('abort', handleAbort);
    return true;
  };
  if (signal?.aborted) {
    handleAbort();
    disarmAbort();
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Chat send aborted');
    error.name = 'AbortError';
    throw error;
  }
  signal?.addEventListener?.('abort', handleAbort, { once: true });
  try {
    return await runSend({ disarmAbort });
  } finally {
    disarmAbort();
  }
};

export const createSendGenerationAbortGuard = ({
  getActiveGeneration = () => null,
  cancelGeneration = () => {},
} = {}) => {
  let ownedGenerationId = 0;
  let armed = true;
  return {
    bindGeneration(generationId = 0) {
      if (!armed) return false;
      const id = Number(generationId) || 0;
      if (!id) return false;
      ownedGenerationId = id;
      return true;
    },
    disarm() {
      armed = false;
      ownedGenerationId = 0;
    },
    abort(reason = null) {
      if (!armed || !ownedGenerationId) return false;
      const activeGeneration = getActiveGeneration?.() || null;
      if (Number(activeGeneration?.id || 0) !== ownedGenerationId) return false;
      cancelGeneration?.(reason, ownedGenerationId);
      return true;
    },
    getState() {
      return { armed, generationId: ownedGenerationId };
    },
  };
};

export const buildSendFlowTraceEvent = ({
  phase = '',
  sessionId = '',
  status = 'info',
  summary = '',
  details = {},
} = {}) => ({
  category: 'generation',
  source: 'send-flow',
  phase: normalizeLifecycleTraceText(phase, 'event'),
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: normalizeLifecycleTraceText(status, 'info'),
  summary: normalizeLifecycleTraceText(summary, ''),
  details: normalizeLifecycleTraceDetails(details),
});

export const buildSendStartTraceEvent = ({
  sessionId = '',
  generationId = 0,
  stream = false,
  protocolEnabled = false,
  rpUiMode = false,
  isGroupChat = false,
  hasAttachments = false,
  attachmentCount = 0,
  pendingCount = 0,
  suppressUserMessage = false,
  hasContinueTarget = false,
  hasSwipeTarget = false,
} = {}) => ({
  phase: 'send.start',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'started',
  summary: 'send flow started',
  details: {
    generationId,
    stream: Boolean(stream),
    protocolEnabled: Boolean(protocolEnabled),
    rpUiMode: Boolean(rpUiMode),
    isGroupChat: Boolean(isGroupChat),
    hasAttachments: Boolean(hasAttachments),
    attachmentCount: Number(attachmentCount || 0) || 0,
    pendingCount: Number(pendingCount || 0) || 0,
    suppressUserMessage: Boolean(suppressUserMessage),
    hasContinueTarget: Boolean(hasContinueTarget),
    hasSwipeTarget: Boolean(hasSwipeTarget),
  },
});

export const buildSendBlockedTraceEvent = ({
  sessionId = '',
  activeGenerationId = 0,
} = {}) => ({
  phase: 'send.blocked',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'skipped',
  summary: 'send skipped because generation is active',
  details: {
    activeGenerationId,
  },
});

export const buildSendPreflightBlockedTraceEvent = ({
  sessionId = '',
  reason = '',
} = {}) => ({
  phase: 'send.preflight.blocked',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'skipped',
  summary: 'send blocked before generation started',
  details: {
    reason: normalizeLifecycleTraceText(reason, ''),
  },
});

export const buildSendFinishTraceEvent = ({
  sessionId = '',
  generationId = 0,
  sendSucceeded = false,
  suppressErrorUI = false,
  sendErrorMessage = '',
} = {}) => ({
  phase: 'send.finish',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: sendSucceeded ? 'success' : (suppressErrorUI ? 'cancelled' : 'error'),
  summary: sendSucceeded ? 'send flow completed' : 'send flow stopped',
  details: {
    generationId,
    sendSucceeded,
    cancelled: suppressErrorUI || undefined,
    errorMessage: sendErrorMessage || undefined,
  },
});

export const buildRegenerateStartTraceEvent = ({
  sessionId = '',
  userIdx = -1,
  allowEmpty = false,
  regenMessageCount = 0,
} = {}) => ({
  phase: 'regenerate.start',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'started',
  summary: 'regenerate flow started',
  details: {
    userIdx,
    allowEmpty: Boolean(allowEmpty),
    regenMessageCount: Number(regenMessageCount || 0) || 0,
  },
});

export const buildRegenerateFinishTraceEvent = ({
  sessionId = '',
  status = 'success',
  userIdx = -1,
  allowEmpty = false,
  regenMessageCount = 0,
  resent = false,
  reason = '',
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, 'success');
  const skipped = normalizedStatus === 'skipped';
  return {
    phase: 'regenerate.finish',
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    status: normalizedStatus,
    summary: skipped
      ? 'regenerate flow skipped'
      : (normalizedStatus === 'success' ? 'regenerate flow completed' : 'regenerate resend failed'),
    details: skipped
      ? {
          userIdx,
          allowEmpty: Boolean(allowEmpty),
          reason: normalizeLifecycleTraceText(reason, ''),
        }
      : {
          userIdx,
          allowEmpty: Boolean(allowEmpty),
          regenMessageCount: Number(regenMessageCount || 0) || 0,
          resent: Boolean(resent),
        },
  };
};

export const resolveSendPreflightBlock = ({
  bridgeConfigured = true,
  online = true,
} = {}) => {
  if (!bridgeConfigured) {
    return {
      blocked: true,
      reason: 'api-not-configured',
      toastMessage: '请先配置 API 信息',
      toastTitle: '未配置',
      showConfigPanel: true,
    };
  }
  if (!online) {
    return {
      blocked: true,
      reason: 'offline',
      toastMessage: '离线状态，无法发送',
      toastTitle: '',
      showConfigPanel: false,
    };
  }
  return {
    blocked: false,
    reason: '',
    toastMessage: '',
    toastTitle: '',
    showConfigPanel: false,
  };
};

export const isChatSendTargetAvailable = ({
  sessionId = '',
  chatStore = null,
  contactsStore = null,
} = {}) => {
  const sid = String(sessionId || '').trim();
  if (!sid) return false;
  let checked = false;
  try {
    if (typeof chatStore?.hasSession === 'function') {
      checked = true;
      if (chatStore.hasSession(sid)) return true;
    } else if (typeof chatStore?.listSessions === 'function') {
      checked = true;
      const ids = chatStore.listSessions();
      if (Array.isArray(ids) && ids.some(id => String(id || '').trim() === sid)) return true;
    }
  } catch {}
  try {
    if (typeof contactsStore?.getContact === 'function') {
      checked = true;
      if (contactsStore.getContact(sid)) return true;
    }
  } catch {}
  return checked ? false : true;
};

export const resolveMaidChatSendCompletionResult = ({
  pipelineSucceeded = false,
  requestTriggered = false,
  protocolEnabled = false,
  protocolAccepted = null,
  repairFailed = false,
  blockedReason = '',
  cancelled = false,
  cancelReason = '',
  waitForReply = true,
  errorMessage = '',
  assistantMessageIds = [],
  assistantMessageRefs = [],
  sessionId = '',
} = {}) => {
  const blocked = String(blockedReason || '').trim();
  const normalizedCancelReason = String(cancelReason || '').trim();
  const refs = [];
  const seenRefs = new Set();
  for (const item of (Array.isArray(assistantMessageRefs) ? assistantMessageRefs : [])) {
    const refSessionId = String(item?.sessionId || item?.targetSessionId || '').trim();
    const messageId = String(item?.messageId || item?.id || '').trim();
    const key = JSON.stringify([refSessionId, messageId]);
    if (!refSessionId || !messageId || seenRefs.has(key)) continue;
    seenRefs.add(key);
    refs.push({ sessionId: refSessionId, messageId });
  }
  const ids = Array.from(new Set(
    [
      ...(Array.isArray(assistantMessageIds) ? assistantMessageIds : []),
      ...refs.map(item => item.messageId),
    ]
      .map(item => String(item || '').trim())
      .filter(Boolean),
  ));
  let completionOutcome = '';
  let failureCode = '';
  let reason = '';
  let message = '';
  let ok = false;

  if (blocked === 'api-not-configured') {
    completionOutcome = 'blocked_by_config';
    failureCode = 'blocked_by_config';
    reason = blocked;
    message = '聊天模型尚未配置，回复请求未开始。';
  } else if (blocked) {
    completionOutcome = 'request_rejected';
    failureCode = blocked;
    reason = blocked;
    message = blocked === 'offline' ? '当前离线，回复请求未开始。' : '回复请求未开始。';
  } else if (cancelled) {
    completionOutcome = requestTriggered ? 'request_triggered' : 'request_rejected';
    if (normalizedCancelReason === 'session_deleted') {
      failureCode = 'session_deleted';
      reason = 'session_deleted';
      message = '目标聊天室已删除，本次发送与回复生成已中止。';
    } else {
      failureCode = 'user_aborted';
      reason = 'user_aborted';
      message = '用户已中止本次发送或回复生成。';
    }
  } else if (waitForReply === false && requestTriggered) {
    ok = true;
    completionOutcome = 'request_triggered';
    message = '回复请求已触发；未等待角色回复终态。';
  } else if (repairFailed) {
    completionOutcome = 'repair_failed';
    failureCode = 'repair_failed';
    reason = 'repair_failed';
    message = '模型回复格式修复失败，未提交回复副作用。';
  } else if (protocolEnabled && protocolAccepted !== true) {
    completionOutcome = 'protocol_rejected';
    failureCode = 'protocol_rejected';
    reason = 'protocol_rejected';
    message = '模型回复没有通过聊天协议验收，未提交回复副作用。';
  } else if (pipelineSucceeded) {
    ok = true;
    completionOutcome = 'assistant_delivered';
    message = protocolEnabled
      ? '角色回复已通过协议验收并落库。'
      : '角色回复已生成并落库。';
  } else {
    completionOutcome = requestTriggered ? 'request_triggered' : 'request_rejected';
    failureCode = requestTriggered ? 'generation_failed' : 'request_rejected';
    reason = failureCode;
    message = String(errorMessage || '').trim() || (
      requestTriggered ? '回复请求已发出，但角色回复未完成。' : '回复请求未开始。'
    );
  }

  return {
    ok,
    sent: Boolean(requestTriggered || pipelineSucceeded),
    requested: Boolean(requestTriggered),
    requestTriggered: Boolean(requestTriggered),
    ...(cancelled ? { cancelled: true } : {}),
    completionOutcome,
    failureCode,
    reason,
    message,
    assistantMessageIds: ids,
    ...(refs.length ? { assistantMessageRefs: refs } : {}),
    sessionId: String(sessionId || '').trim(),
  };
};

export const buildSendUserMessage = ({
  text = '',
  userName = '',
  userAvatar = '',
  time = '',
  isStickerAllowed = () => false,
  parseStickerToken = () => '',
  applyInputStoredRegex = value => value,
  applyInputDisplayRegex = value => value,
} = {}) => {
  const stickerKey = isStickerAllowed() ? parseStickerToken(text) : '';
  if (stickerKey) {
    return {
      role: 'user',
      type: 'sticker',
      content: stickerKey,
      raw: text,
      rawInput: String(text ?? ''),
      name: userName,
      avatar: userAvatar,
      time,
    };
  }
  const storedUser = applyInputStoredRegex(text, { isEdit: false });
  const displayUser = applyInputDisplayRegex(storedUser, { isEdit: false, depth: 0 });
  return {
    role: 'user',
    type: 'text',
    content: displayUser,
    raw: storedUser,
    rawInput: String(text ?? ''),
    name: userName,
    avatar: userAvatar,
    time,
  };
};

export const normalizeHandleSendInvocation = (targetMessageId = null, options = {}) => {
  let nextTargetMessageId = targetMessageId;
  let nextOptions = options;

  if (nextTargetMessageId && typeof nextTargetMessageId === 'object') {
    if (typeof nextTargetMessageId.preventDefault === 'function') {
      nextTargetMessageId = null;
      nextOptions = {};
    } else {
      nextOptions = nextTargetMessageId;
      nextTargetMessageId = null;
    }
  }

  if (!nextOptions || typeof nextOptions !== 'object') nextOptions = {};
  return {
    targetMessageId: nextTargetMessageId,
    options: nextOptions,
  };
};

export const normalizeHandleSendOptions = (options = {}) => {
  const raw = options && typeof options === 'object' ? options : {};
  const overrideTextRaw = typeof raw.overrideText === 'string' ? raw.overrideText : '';
  const continueTarget = raw.continueTarget && typeof raw.continueTarget === 'object' ? raw.continueTarget : null;
  const excludeMessageIds = normalizeStringIdList([
    ...(Array.isArray(raw.excludeMessageIds) ? raw.excludeMessageIds : []),
    continueTarget?.messageId,
  ]);

  return {
    hasOverrideText: typeof raw.overrideText === 'string',
    overrideTextRaw,
    overrideText: overrideTextRaw.trim() ? overrideTextRaw : '',
    ignorePending: Boolean(raw.ignorePending),
    suppressUserMessage: Boolean(raw.suppressUserMessage),
    existingUserMessageId:
      typeof raw.existingUserMessageId === 'string' ? raw.existingUserMessageId : '',
    skipInputRegex: Boolean(raw.skipInputRegex),
    skipTemplate: Boolean(raw.skipTemplate),
    skipScripts: Boolean(raw.skipScripts),
    previewOnly: Boolean(raw.previewOnly),
    previewSessionId: raw.previewOnly ? String(raw.previewSessionId || '').trim() : '',
    // 请求预览的场景覆盖（仅 previewOnly 时使用）：'chat' | 'rp'
    previewUiMode: raw.previewUiMode === 'chat' || raw.previewUiMode === 'rp' ? raw.previewUiMode : '',
    // 请求预览的私聊/群聊场景覆盖（仅 previewOnly + chat 场景使用）：覆盖 isGroupChat 组装分支
    previewScenario: raw.previewScenario === 'private' || raw.previewScenario === 'group' ? raw.previewScenario : '',
    // 请求预览按注入选择条抑制未加入项（缺省 true 不影响其他预览入口）
    previewChatFormat: raw.previewChatFormat !== false,
    previewInjectMemory: raw.previewInjectMemory !== false,
    previewInjectImage: raw.previewInjectImage !== false,
    previewInjectMomentCreate: raw.previewInjectMomentCreate !== false,
    // 请求预览：不携带当前会话历史/摘要（预设预览默认以占位符展示 chat_history）
    previewSuppressHistory: Boolean(raw.previewSuppressHistory),
    // 请求预览：自定义区块正文不做宏求值（原样显示，预览可逐字映射）
    previewRawBlocks: Boolean(raw.previewRawBlocks),
    previewForceLegacyText: Boolean(raw.previewForceLegacyText),
    agentPromptDraft: raw.previewOnly && raw.agentPromptDraft && typeof raw.agentPromptDraft === 'object' ? raw.agentPromptDraft : null,
    suppressAssistantDom: Boolean(raw.suppressAssistantDom),
    assistantStreamFactory:
      typeof raw.createAssistantStream === 'function' ? raw.createAssistantStream : null,
    continueTarget,
    partialCommitHandler:
      typeof raw.partialCommitHandler === 'function' ? raw.partialCommitHandler : null,
    onGenerationStarted:
      typeof raw.onGenerationStarted === 'function' ? raw.onGenerationStarted : null,
    onAssistantDelivered:
      typeof raw.onAssistantDelivered === 'function' ? raw.onAssistantDelivered : null,
    abortSignal:
      raw.abortSignal && typeof raw.abortSignal === 'object' ? raw.abortSignal : null,
    swipeTarget: raw.swipeTarget && typeof raw.swipeTarget === 'object' ? raw.swipeTarget : null,
    excludeMessageIds,
    includeAttachments: raw.includeAttachments !== false,
  };
};

export const runPendingSendPreparationFlow = ({
  ignorePending = false,
  targetMessageId = null,
  allMessages = [],
  pendingQueue = [],
  overrideText = '',
  hasAttachments = false,
  continueTarget = null,
  sessionId = '',
  userAvatar = '',
  getInputText = () => '',
  getActiveUserProfile = () => null,
  isStickerAllowed = () => false,
  parseStickerToken = () => '',
  getReplyTargetForSession = () => null,
  clearReplyTargetForSession = () => {},
  formatNowTime = () => '',
  appendMessage = null,
  addMessageToUi = null,
  removePendingMessage = null,
  clearInput = () => {},
  buildStickerToken = value => String(value || ''),
  chatStore = null,
  ui = null,
  scriptRuntime = null,
  pluginRuntime = null,
  skipScripts = false,
  logger = null,
  recordTraceEvent = null,
  refreshChatAndContacts = () => {},
  updatePendingFloat = () => {},
  showError = () => {},
  showWarning = () => {},
} = {}) => {
  const pendingMessages = ignorePending
    ? []
    : (Array.isArray(allMessages) ? allMessages.filter(message => message?.status === 'pending') : []);
  const buildTextForPendingMessages = (messagesToSend = []) => {
    const list = Array.isArray(messagesToSend) ? messagesToSend : [];
    const imageGroupIds = new Set(
      list
        .filter(message => message?.type === 'image')
        .map(message => String(message?.meta?.pendingGroupId || '').trim())
        .filter(Boolean),
    );
    return list
      .filter((message) => {
        if (message?.type === 'image') return false;
        if (message?.meta?.attachmentsOnly) return false;
        const groupId = String(message?.meta?.pendingGroupId || '').trim();
        if (
          groupId &&
          imageGroupIds.has(groupId) &&
          String(message?.content || '').trim() === '[图片]'
        ) {
          return false;
        }
        return true;
      })
      .map(message => getMessageSendText(message, buildStickerToken))
      .filter(Boolean)
      .join('\n');
  };
  if (!ignorePending && !targetMessageId && Array.isArray(pendingQueue) && pendingQueue.length) {
    const restored = restorePendingQueueToHistory({
      pendingQueue,
      existingMessages: allMessages,
      sessionId,
      appendMessage,
      addMessageToUi,
      removePendingMessage,
    });
    if (restored.length) pendingMessages.push(...restored);
  }

  if (pendingMessages.length > 0) {
    let { messagesToSend, errorMessage } = resolvePendingMessagesToSend({
      pendingMessages,
      targetMessageId,
    });

    if (errorMessage) {
      showError(errorMessage);
      return {
        shouldContinue: false,
        text: '',
        pendingMessagesToConfirm: [],
        errorMessage,
      };
    }

    if (!targetMessageId) {
      const currentInput = String(getInputText() || '').trim();
      if (currentInput) {
        const activeUser = getActiveUserProfile();
        const stickerKey = isStickerAllowed() ? parseStickerToken(currentInput) : '';
        const replyTarget = getReplyTargetForSession(sessionId);
        const newPendingMsg = createPendingUserMessage({
          text: currentInput,
          stickerKey,
          avatar: userAvatar,
          userName: activeUser?.name,
          time: formatNowTime(),
          replyTarget,
        });
        const saved = appendMessage(newPendingMsg, sessionId);
        addMessageToUi(saved);
        messagesToSend.push(saved);
        clearInput();
        if (replyTarget) clearReplyTargetForSession(sessionId);
      }
    }

    const text = buildTextForPendingMessages(messagesToSend);
    let pendingMessagesToConfirm = messagesToSend;

    if (!text && !hasAttachments) {
      showWarning('没有可发送的消息');
      return {
        shouldContinue: false,
        text: '',
        pendingMessagesToConfirm,
        warningMessage: '没有可发送的消息',
      };
    }

    pendingMessagesToConfirm = markMessagesAsSending({
      messages: pendingMessagesToConfirm,
      sessionId,
      chatStore,
      ui,
    });
    dispatchAfterSendEvents({
      messages: pendingMessagesToConfirm,
      sessionId,
      scriptRuntime,
      pluginRuntime,
      skipScripts,
      logger,
      recordTraceEvent,
    });
    refreshChatAndContacts({ immediate: true });
    updatePendingFloat(sessionId);

    return {
      shouldContinue: true,
      text,
      pendingMessagesToConfirm,
      handledPending: true,
    };
  }

  const text = overrideText || getInputText();
  if (!text && !hasAttachments && !continueTarget) {
    return {
      shouldContinue: false,
      text: '',
      pendingMessagesToConfirm: [],
    };
  }

  return {
    shouldContinue: true,
    text,
    pendingMessagesToConfirm: [],
    handledPending: false,
  };
};

export const resolveRegenerateFromUserIndexPlan = ({
  messages = [],
  userIdx = -1,
  allowEmpty = false,
  isSyntheticUser = () => false,
} = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const index = Math.trunc(Number(userIdx));
  const prevUser = list[index] || null;
  const isSynthetic = message => {
    try {
      return Boolean(isSyntheticUser?.(message));
    } catch {
      return false;
    }
  };
  const emptyResult = {
    canRegenerate: false,
    prevUser: null,
    roundMessages: [],
    regenMessages: [],
    nextUserIdx: -1,
    warningMessage: '',
    reason: 'invalid-user',
  };
  if (!prevUser || prevUser.role !== 'user' || isSynthetic(prevUser)) return emptyResult;
  if (prevUser.status === 'pending' || prevUser.status === 'sending') {
    return {
      ...emptyResult,
      prevUser,
      warningMessage: '发送中的消息无法重生成',
      reason: 'user-message-sending',
    };
  }
  let nextUserIdx = -1;
  for (let i = index + 1; i < list.length; i += 1) {
    if (
      list[i]?.role === 'user' &&
      !isSynthetic(list[i]) &&
      list[i]?.status !== 'pending' &&
      list[i]?.status !== 'sending'
    ) {
      nextUserIdx = i;
      break;
    }
  }
  if (nextUserIdx !== -1) {
    return {
      ...emptyResult,
      prevUser,
      nextUserIdx,
      warningMessage: '只能重生成最新一轮回复',
      reason: 'not-latest-round',
    };
  }
  const roundMessages = list.slice(index + 1, nextUserIdx === -1 ? list.length : nextUserIdx);
  const regenMessages = roundMessages.filter(message => message?.role === 'assistant' || isSynthetic(message));
  if (!regenMessages.length && !allowEmpty) {
    return {
      ...emptyResult,
      prevUser,
      roundMessages,
      regenMessages,
      nextUserIdx,
      warningMessage: '未找到可重生成的 AI 回复',
      reason: 'missing-assistant-reply',
    };
  }
  return {
    canRegenerate: true,
    prevUser,
    roundMessages,
    regenMessages,
    nextUserIdx,
    warningMessage: '',
    reason: '',
  };
};

const isRegenerateRoundUser = (message, isSynthetic) => (
  message?.role === 'user' &&
  !isSynthetic(message) &&
  message?.status !== 'pending' &&
  message?.status !== 'sending'
);

const isRegenerateRoundTarget = (message, isSynthetic) => (
  message?.role === 'assistant' || isSynthetic(message)
);

const isCancelledPartialMessage = message => (
  message?.meta?.partial === true || message?.meta?.cancelled === true
);

const hasAdoptableRenderedMessageContent = (message, entry = null) => {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  const text = String(
    message?.content
      || message?.raw
      || message?.rawSource
      || message?.rawOriginal
      || meta.reasoningDisplay
      || meta.reasoning
      || meta.reasoningSource
      || '',
  );
  if (text.trim()) return true;
  if (Array.isArray(message?.attachments) && message.attachments.length > 0) return true;
  const wrapperText = String(entry?.wrapper?.innerText || entry?.wrapper?.textContent || '');
  return Boolean(wrapperText.trim());
};

export const adoptRenderedRegenerateRoundMessages = ({
  messages = [],
  userIdx = -1,
  renderedMessages = [],
  sessionId = '',
  chatStore = null,
  isSyntheticUser = () => false,
  logger = null,
} = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const index = Math.trunc(Number(userIdx));
  const prevUser = list[index] || null;
  const isSynthetic = message => {
    try {
      return Boolean(isSyntheticUser?.(message));
    } catch {
      return false;
    }
  };
  if (!prevUser || prevUser.role !== 'user' || isSynthetic(prevUser)) return [];

  const rendered = (Array.isArray(renderedMessages) ? renderedMessages : [])
    .map((entry) => {
      const message = entry?.message && typeof entry.message === 'object'
        ? entry.message
        : (entry && typeof entry === 'object' ? entry : null);
      return message ? { entry, message } : null;
    })
    .filter(Boolean);
  if (!rendered.length) return [];

  const anchorId = String(prevUser.id || '').trim();
  if (!anchorId) return [];
  const anchorIndex = rendered.findIndex(({ message }) => String(message?.id || '').trim() === anchorId);
  if (anchorIndex < 0) return [];

  const knownIds = new Set(
    list
      .map(message => String(message?.id || '').trim())
      .filter(Boolean),
  );
  const adopted = [];
  for (let i = anchorIndex + 1; i < rendered.length; i += 1) {
    const { entry, message } = rendered[i];
    if (!message || typeof message !== 'object') continue;
    if (isRegenerateRoundUser(message, isSynthetic)) break;
    if (!isRegenerateRoundTarget(message, isSynthetic)) continue;
    if (!isCancelledPartialMessage(message) && !hasAdoptableRenderedMessageContent(message, entry)) continue;

    const messageId = String(message.id || '').trim();
    if (!messageId || knownIds.has(messageId)) continue;

    try {
      const saved = chatStore?.appendMessage?.({ ...message, id: messageId }, sessionId) || null;
      if (saved) {
        knownIds.add(String(saved.id || messageId).trim());
        adopted.push({ entry, message, saved });
      }
    } catch (err) {
      logger?.warn?.('adopt rendered partial before regenerate failed', err);
    }
  }
  return adopted;
};

export const runRegenerateFromUserIndexFlow = async ({
  messages = [],
  userIdx = -1,
  allowEmpty = false,
  isSyntheticUser = () => false,
  sessionId = '',
  chatStore = null,
  ui = null,
  recordTraceEvent = () => {},
  abortMemoryUpdate = async () => {},
  removeTurnCheckpointsForMessages = async () => {},
  refreshChatAndContacts = () => {},
  getMemoryStorageMode = () => '',
  restoreMemoryForActiveThread = async () => {},
  restoreVariablesForActiveThread = async () => {},
  getMessageSendText = () => '',
  buildStickerToken = value => value,
  buildResendAttachmentParts = async () => [],
  handleSend = async () => false,
  warn = () => {},
  logger = null,
} = {}) => {
  const plan = resolveRegenerateFromUserIndexPlan({
    messages,
    userIdx,
    allowEmpty,
    isSyntheticUser,
  });
  if (!plan.canRegenerate) {
    if (plan.warningMessage) warn(plan.warningMessage);
    return {
      started: false,
      resent: false,
      plan,
      reason: plan.reason,
    };
  }

  const prevUser = plan.prevUser;
  const regenMessages = plan.regenMessages;
  recordTraceEvent(buildRegenerateStartTraceEvent({
    sessionId,
    userIdx,
    allowEmpty,
    regenMessageCount: regenMessages.length,
  }));

  if (regenMessages.length) {
    if (getMemoryStorageMode() === 'table') {
      try {
        await abortMemoryUpdate(sessionId, { source: 'regenerate_from_user_index' });
      } catch (err) {
        logger?.warn?.('abort memory update before regenerate failed', err);
      }
    }
    regenMessages.forEach(message => {
      chatStore?.deleteMessage?.(message.id, sessionId);
      ui?.removeMessage?.(message.id);
    });
    try {
      await removeTurnCheckpointsForMessages(sessionId, regenMessages, { prune: true });
    } catch (err) {
      logger?.warn?.('remove turn checkpoints for regenerated messages failed', err);
    }
    refreshChatAndContacts();
  }

  chatStore?.removeLastSummary?.(sessionId);
  if (getMemoryStorageMode() === 'table') {
    try {
      await restoreMemoryForActiveThread(sessionId, {
        refreshBaselineWhenNoTail: false,
        source: 'regenerate_from_user_index',
      });
    } catch (err) {
      logger?.warn?.('restore memory after regenerate failed', err);
    }
  }
  // C 计划 M1：变量严格楼层绑定、模式无关——删除待重生成楼层后回滚到新 tail 楼层变量快照。
  try {
    await restoreVariablesForActiveThread(sessionId);
  } catch (err) {
    logger?.warn?.('restore variables after regenerate failed', err);
  }

  let resendAttachmentParts = [];
  try {
    const built = await buildResendAttachmentParts({
      messages,
      userIdx,
      prevUser,
      plan,
    });
    resendAttachmentParts = Array.isArray(built) ? built.filter(Boolean) : [];
  } catch (err) {
    logger?.warn?.('build regenerate attachment parts failed', err);
  }
  const hasResendAttachments = resendAttachmentParts.length > 0;
  let resendText = getMessageSendText(prevUser, buildStickerToken);
  if (hasResendAttachments && prevUser?.type === 'image' && String(resendText || '').trim() === '[图片]') {
    resendText = '';
  }
  if (!String(resendText || '').trim() && !hasResendAttachments) {
    recordTraceEvent(buildRegenerateFinishTraceEvent({
      sessionId,
      status: 'skipped',
      userIdx,
      allowEmpty,
      reason: 'empty-user-message',
    }));
    warn('未找到对应的用户消息内容');
    return {
      started: true,
      resent: false,
      plan,
      reason: 'empty-user-message',
    };
  }

  const resent = await handleSend(null, {
    overrideText: resendText,
    ignorePending: true,
    suppressUserMessage: true,
    skipInputRegex: true,
    existingUserMessageId: prevUser?.id || '',
    includeAttachments: false,
    resendAttachmentParts,
  });
  recordTraceEvent(buildRegenerateFinishTraceEvent({
    sessionId,
    status: resent ? 'success' : 'error',
    userIdx,
    allowEmpty,
    regenMessageCount: regenMessages.length,
    resent: Boolean(resent),
  }));

  return {
    started: true,
    resent: Boolean(resent),
    plan,
    reason: resent ? '' : 'resend-failed',
  };
};

export const runSendCatchFlow = ({
  error = null,
  generationId = 0,
  suppressErrorUI = false,
  streamCtrl = null,
  isGenerationInterrupted = () => false,
  sessionId = '',
  isSessionActive = () => false,
  hideTyping = () => {},
  fastForwardDelivery = () => {},
  logger = null,
  showToastError = () => {},
} = {}) => {
  const sendErrorMessage = error?.message ? String(error.message) : String(error || '');
  const generationInterrupted = isGenerationInterrupted(generationId);
  const isCancelled = Boolean(error?.cancelled || generationInterrupted);
  if (!isCancelled) {
    streamCtrl?.cancel?.();
  }
  if (!generationInterrupted && isSessionActive(sessionId)) {
    hideTyping();
    fastForwardDelivery(sessionId);
  }

  const nextSuppressErrorUI = Boolean(suppressErrorUI || isCancelled);
  if (!nextSuppressErrorUI) {
    logger?.error?.('发送失败', error, { status: error?.status, response: error?.response });
    showToastError(error?.message || '发送失败，请检查网络或 API 设置', '错误');
  }

  return {
    sendErrorMessage,
    suppressErrorUI: nextSuppressErrorUI,
    generationInterrupted,
    cancelled: isCancelled,
  };
};

export const runSendFinallyFlow = ({
  sendSucceeded = false,
  pendingMessagesToConfirm = [],
  sessionId = '',
  isGroupChat = false,
  checkpointTargetMessageId = '',
  generationId = 0,
  sendTraceStarted = false,
  suppressErrorUI = false,
  sendErrorMessage = '',
  finalizePendingMessages = () => {},
  movePendingFromHistoryToQueue = () => {},
  refreshChatAndContacts = () => {},
  scriptRuntime = null,
  runMemoryUpdateAfterChat = () => null,
  buildMemoryContext = () => null,
  updatePendingFloat = () => {},
  getActiveGeneration = () => null,
  setActiveGeneration = () => {},
  setSendingState = () => {},
  recordTraceEvent = () => {},
} = {}) => {
  if (sendSucceeded) {
    if (Array.isArray(pendingMessagesToConfirm) && pendingMessagesToConfirm.length > 0) {
      finalizePendingMessages(sessionId, pendingMessagesToConfirm);
    }
    movePendingFromHistoryToQueue(sessionId);
    refreshChatAndContacts();
    scriptRuntime?.consumeOnce?.(sessionId);
    const memoryTask = runMemoryUpdateAfterChat(sessionId, isGroupChat, buildMemoryContext(), {
      checkpointMessageId: checkpointTargetMessageId,
    });
    memoryTask?.catch?.(() => {});
  } else if (!suppressErrorUI && Array.isArray(pendingMessagesToConfirm) && pendingMessagesToConfirm.length > 0) {
    finalizePendingMessages(sessionId, pendingMessagesToConfirm);
  }

  updatePendingFloat(sessionId);
  const activeBeforeSendingReset = getActiveGeneration();
  if (!activeBeforeSendingReset || activeBeforeSendingReset.id === generationId) {
    setSendingState(false);
  }
  const activeBeforeClear = getActiveGeneration();
  if (activeBeforeClear?.id === generationId) {
    setActiveGeneration(null);
  }

  if (sendTraceStarted) {
    recordTraceEvent(buildSendFinishTraceEvent({
      sessionId,
      generationId,
      sendSucceeded,
      suppressErrorUI,
      sendErrorMessage,
    }));
  }

  return sendSucceeded;
};

const isEnabledPromptRule = (enabled, rules) =>
  Boolean(enabled) && String(rules || '').trim().length > 0;

export const resolveSyspromptProtocolFlags = ({
  sysp = null,
  rpUiMode = false,
  isGroupChat = false,
  summaryEnabled = false,
} = {}) => {
  const dialogueEnabled = isEnabledPromptRule(sysp?.dialogue_enabled, sysp?.dialogue_rules);
  const groupEnabled = isEnabledPromptRule(sysp?.group_enabled, sysp?.group_rules);
  const momentCreateEnabled = isEnabledPromptRule(
    sysp?.moment_create_enabled,
    sysp?.moment_create_rules,
  );

  return {
    dialogueEnabled,
    groupEnabled,
    momentCreateEnabled,
    protocolEnabled:
      !rpUiMode && (momentCreateEnabled || (isGroupChat ? groupEnabled : dialogueEnabled)),
    disableSummaryForThis: !summaryEnabled,
  };
};
