import {
  buildAfterSendHookFinishTraceEvent,
  buildAfterSendHookStartTraceEvent,
  emitHookLifecycleTrace,
} from './hook-lifecycle-trace-utils.js';
import {
  protectUnclosedAutoImagePromptTags,
  restoreProtectedAutoImagePromptTags,
} from './auto-image-prompt-utils.js';

const normalizeMessages = (messages = []) => (Array.isArray(messages) ? messages : []);

const hasAutoImagePromptTag = value => /<\s*image_prompt\b/i.test(String(value || ''));

const countPendingImageTokens = value => (
  String(value || '').match(/\[img-图片生成中(?: \d+)?\]/g) || []
).length;

const logWritingAutoImageFinalizeDebug = (logger, stage = '', payload = {}) => {
  try {
    logger?.debug?.(`[writing-auto-image] finalize-${stage} ${JSON.stringify(payload)}`);
  } catch {}
};

const dispatchAfterSendToRuntime = ({
  runtime = null,
  runtimeLabel = '',
  messages = [],
  sessionId = '',
  logger = null,
  recordTraceEvent = null,
} = {}) => {
  if (!runtime || typeof runtime.dispatchEvent !== 'function') return;
  normalizeMessages(messages).forEach((message) => {
    const messageId = String(message?.id || '').trim();
    emitHookLifecycleTrace(recordTraceEvent, buildAfterSendHookStartTraceEvent({
      runtimeLabel,
      sessionId,
      message,
    }));
    runtime.dispatchEvent('message.after_send', { message, sessionId }).catch((err) => {
      emitHookLifecycleTrace(recordTraceEvent, buildAfterSendHookFinishTraceEvent({
        runtimeLabel,
        sessionId,
        messageId,
        status: 'error',
        errorMessage: err?.message,
      }));
      logger?.warn?.(`${runtimeLabel} message.after_send failed`, err);
    });
    emitHookLifecycleTrace(recordTraceEvent, buildAfterSendHookFinishTraceEvent({
      runtimeLabel,
      sessionId,
      messageId,
      status: 'queued',
    }));
  });
};

export const markMessagesAsSending = ({
  messages = [],
  sessionId = '',
  chatStore = null,
  ui = null,
} = {}) => normalizeMessages(messages).map((message) => {
  const nextPatch = { status: 'sending' };
  if (message?.meta?.pendingGroupId) {
    nextPatch.meta = {
      ...(message.meta || {}),
      pendingGroupStatus: 'sending',
    };
  }
  const fallback = {
    ...(message && typeof message === 'object' ? message : {}),
    status: 'sending',
    ...(nextPatch.meta ? { meta: nextPatch.meta } : {}),
  };
  const messageId = message?.id;
  if (!messageId) return fallback;

  const updated =
    chatStore && typeof chatStore.updateMessage === 'function'
      ? (chatStore.updateMessage(messageId, nextPatch, sessionId) || fallback)
      : fallback;
  if (ui && typeof ui.updateMessage === 'function') {
    ui.updateMessage(messageId, updated || fallback);
  }
  if (chatStore && typeof chatStore.findMessage === 'function') {
    return chatStore.findMessage(messageId, sessionId) || updated || fallback;
  }
  return updated || fallback;
});

export const dispatchAfterSendEvents = ({
  messages = [],
  sessionId = '',
  scriptRuntime = null,
  pluginRuntime = null,
  skipScripts = false,
  logger = null,
  recordTraceEvent = null,
} = {}) => {
  const nextMessages = normalizeMessages(messages);
  if (!skipScripts) {
    dispatchAfterSendToRuntime({
      runtime: scriptRuntime,
      runtimeLabel: 'script',
      messages: nextMessages,
      sessionId,
      logger,
      recordTraceEvent,
    });
  }
  dispatchAfterSendToRuntime({
    runtime: pluginRuntime,
    runtimeLabel: 'plugin',
    messages: nextMessages,
    sessionId,
    logger,
    recordTraceEvent,
  });
};

export const runAssistantGenerationRequest = async (
  {
    text = '',
    sessionId = '',
  } = {},
  {
    consumePromptInjections = null,
    buildContext = null,
    appBridge = null,
    beforeBuildContext = null,
  } = {},
) => {
  // 酒馆在组提示词前派发生成开始事件并等脚本处理完；脚本这时注入的内容要赶上这一轮
  if (typeof beforeBuildContext === 'function') await beforeBuildContext();
  const context = buildContext(text);
  if (typeof consumePromptInjections === 'function') {
    consumePromptInjections(sessionId);
  }
  return appBridge.generate(text, context);
};

export const createCreativeAssistantStreamProcessor = ({
  StreamProcessor = null,
  fps = 18,
  isRpMode = false,
  isMemoryAutoExtractInline = null,
  stripTableEditBlocks = null,
  normalizeCreativeLineBreaks = null,
  extractStreamingReasoningFromContent = null,
  applyOutputStoredRegexSafe = null,
  applyOutputDisplayRegexSafe = null,
  appBridge = null,
  getAppBridge = null,
} = {}) => {
  const resolveAppBridge = () => (
    typeof getAppBridge === 'function' ? getAppBridge() : appBridge
  );
  return new StreamProcessor({
    fps,
    normalizeText: normalizeCreativeLineBreaks,
    stripRaw: source => ((!isRpMode && isMemoryAutoExtractInline()) ? stripTableEditBlocks(source) : source),
    extractReasoning: (source, { final = false } = {}) =>
      extractStreamingReasoningFromContent(source, { depth: 0, final }),
    applyStored: source => applyOutputStoredRegexSafe(source, {
      appBridge: resolveAppBridge(),
      depth: 0,
      normalizeText: normalizeCreativeLineBreaks,
    }),
    applyDisplay: source => applyOutputDisplayRegexSafe(source, {
      appBridge: resolveAppBridge(),
      depth: 0,
      normalizeText: normalizeCreativeLineBreaks,
    }),
    protectRegexSource: protectUnclosedAutoImagePromptTags,
    restoreRegexOutput: restoreProtectedAutoImagePromptTags,
  });
};

export const prepareBufferedAssistantResponse = async (
  {
    rawText = '',
    protocolEnabled = false,
    summaryEnabled = false,
    memoryOptions = {},
  } = {},
  {
    onBeforeRawSave = null,
    setLastRawResponse = null,
    handleMemoryEditsFromRaw = null,
    extractSummaryBlock = null,
  } = {},
) => {
  const raw = String(rawText ?? '');
  if (typeof onBeforeRawSave === 'function') {
    onBeforeRawSave(raw);
  }
  if (typeof setLastRawResponse === 'function') {
    setLastRawResponse(raw);
  }

  let stripped = raw;
  if (!protocolEnabled && typeof handleMemoryEditsFromRaw === 'function') {
    const memoryParsed = await handleMemoryEditsFromRaw(raw, memoryOptions || {});
    stripped = memoryParsed.text;
  }

  let protocolSummary = '';
  const shouldExtractSummary = typeof summaryEnabled === 'function'
    ? Boolean(summaryEnabled())
    : Boolean(summaryEnabled);
  if (shouldExtractSummary && typeof extractSummaryBlock === 'function') {
    const parsedSummary = extractSummaryBlock(raw);
    stripped = parsedSummary.text;
    protocolSummary = parsedSummary.summary;
  }

  return {
    rawText: raw,
    stripped,
    protocolSummary,
  };
};

const collectProtocolCheckpointSessionIds = (protocolState = null, sessionId = '') => {
  const ids = new Set();
  if (protocolState?.handled === false) return [];
  const hasHandledProtocolOutput = Boolean(
    protocolState?.didAnything ||
      protocolState?.mutatedMoments ||
      protocolState?.handled,
  );
  if (protocolState && !hasHandledProtocolOutput) return [];
  const fallback = String(sessionId || '').trim();
  if (fallback) ids.add(fallback);
  const summarySessionIds = protocolState?.summarySessionIds;
  if (summarySessionIds && typeof summarySessionIds[Symbol.iterator] === 'function') {
    for (const value of summarySessionIds) {
      const id = String(value || '').trim();
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
};

export const syncProtocolResponseTurnCheckpoints = async ({
  protocolState = null,
  sessionId = '',
  findTailTrackedAssistantMessage = null,
  isTurnCheckpointSessionEnabled = null,
  syncTurnCheckpointForMessage = null,
  logger = null,
  warnMessage = 'sync turn checkpoint after protocol response failed',
} = {}) => {
  if (typeof findTailTrackedAssistantMessage !== 'function' || typeof syncTurnCheckpointForMessage !== 'function') {
    return { checkpointTargetMessageId: '', syncedSessionIds: [], failedSessionIds: [] };
  }
  const currentSessionId = String(sessionId || '').trim();
  const syncedSessionIds = [];
  const failedSessionIds = [];
  let checkpointTargetMessageId = '';
  for (const sid of collectProtocolCheckpointSessionIds(protocolState, currentSessionId)) {
    try {
      if (typeof isTurnCheckpointSessionEnabled === 'function' && !isTurnCheckpointSessionEnabled(sid)) continue;
      const tailMessage = findTailTrackedAssistantMessage(sid);
      const messageId = String(tailMessage?.id || '').trim();
      if (!messageId) continue;
      await syncTurnCheckpointForMessage(sid, tailMessage, { captureCurrentActiveState: true });
      syncedSessionIds.push(sid);
      if (sid === currentSessionId && !checkpointTargetMessageId) checkpointTargetMessageId = messageId;
    } catch (err) {
      failedSessionIds.push(sid);
      logger?.warn?.(warnMessage, err);
    }
  }
  return { checkpointTargetMessageId, syncedSessionIds, failedSessionIds };
};

export const consumeLegacyAssistantStream = async (
  stream = [],
  {
    streamCtrl = null,
    nativeReasoningState = null,
    streamMeta = {},
    initialFull = '',
  } = {},
  {
    normalizeChunk = chunk => chunk,
    isInterrupted = () => false,
    appendReasoningChunk = null,
    buildStreamText = raw => raw,
    resolveReasoningState = null,
    pushAssistantStreamText = null,
  } = {},
) => {
  let full = String(initialFull ?? '');
  let nextStreamCtrl = streamCtrl;
  let interrupted = false;
  const resolveInterrupted = () => Boolean(typeof isInterrupted === 'function' && isInterrupted());

  for await (const chunk of (stream || [])) {
    if (resolveInterrupted()) {
      interrupted = true;
      break;
    }
    const normalizedChunk = typeof normalizeChunk === 'function'
      ? normalizeChunk(chunk)
      : chunk;
    if (normalizedChunk.reasoning && typeof appendReasoningChunk === 'function') {
      appendReasoningChunk(nativeReasoningState, normalizedChunk, { depth: 0 });
    }
    if (!normalizedChunk.content && !normalizedChunk.reasoning) continue;
    full += normalizedChunk.content;
    const streamText = typeof buildStreamText === 'function'
      ? buildStreamText(full, normalizedChunk)
      : full;
    const reasoningState = typeof resolveReasoningState === 'function'
      ? (resolveReasoningState(null, nativeReasoningState, { finalize: false }) || {})
      : {};
    const streamPayload = reasoningState.reasoning
      ? {
          content: streamText,
          raw: streamText,
          rawOriginal: full,
          reasoning: reasoningState.reasoning,
          reasoningDisplay: reasoningState.reasoningDisplay,
          meta: {
            reasoningHidden: reasoningState.reasoningHidden,
            reasoningLabel: reasoningState.reasoningLabel,
            reasoningSource: reasoningState.reasoningSource,
          },
        }
      : streamText;
    if (typeof pushAssistantStreamText === 'function') {
      nextStreamCtrl = pushAssistantStreamText(streamPayload, {
        ...streamMeta,
        reasoning: reasoningState.reasoning,
        reasoningDisplay: reasoningState.reasoningDisplay,
        reasoningHidden: reasoningState.reasoningHidden,
        reasoningLabel: reasoningState.reasoningLabel,
        reasoningSource: reasoningState.reasoningSource,
      });
    }
  }

  return {
    full,
    streamCtrl: nextStreamCtrl,
    nativeReasoningState,
    interrupted,
  };
};

export const consumeCreativeAssistantStream = async (
  stream = [],
  {
    streamCtrl = null,
    nativeReasoningState = null,
    streamMeta = {},
    creativeStreamProcessor = null,
    initialFull = '',
  } = {},
  {
    normalizeChunk = chunk => chunk,
    isInterrupted = () => false,
    appendReasoningChunk = null,
    resolveReasoningState = null,
    pushAssistantStreamText = null,
  } = {},
) => {
  let full = String(initialFull ?? '');
  let nextStreamCtrl = streamCtrl;
  let interrupted = false;
  let pendingReasoningChunk = null;
  const resolveInterrupted = () => Boolean(typeof isInterrupted === 'function' && isInterrupted());
  const resolvePreviewNow = () => {
    const injectedNow = Number(creativeStreamProcessor?.now?.());
    if (Number.isFinite(injectedNow)) return injectedNow;
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      const perfNow = Number(performance.now());
      if (Number.isFinite(perfNow)) return perfNow;
    }
    return Date.now();
  };
  const resolveReasoningPreviewIntervalMs = () => {
    const maxWaitMs = Number(creativeStreamProcessor?.maxWaitMs);
    if (Number.isFinite(maxWaitMs) && maxWaitMs > 0) return maxWaitMs;
    const frameMs = Number(creativeStreamProcessor?.frameMs);
    if (Number.isFinite(frameMs) && frameMs > 0) return Math.max(frameMs, 120);
    return 220;
  };
  let lastReasoningPreviewAt = Number.NEGATIVE_INFINITY;
  const shouldPushReasoningPreview = () => {
    const now = resolvePreviewNow();
    if ((now - lastReasoningPreviewAt) < resolveReasoningPreviewIntervalMs()) return false;
    lastReasoningPreviewAt = now;
    return true;
  };
  const queueReasoningChunk = (chunk = {}) => {
    const reasoning = String(chunk?.reasoning || '');
    if (!reasoning) return;
    pendingReasoningChunk = {
      content: '',
      reasoning: `${pendingReasoningChunk?.reasoning || ''}${reasoning}`,
      reasoningHidden: Boolean(pendingReasoningChunk?.reasoningHidden || chunk?.reasoningHidden === true),
      reasoningLabel: pendingReasoningChunk?.reasoningLabel || chunk?.reasoningLabel || '',
      provider: pendingReasoningChunk?.provider || chunk?.provider || '',
    };
  };
  const flushReasoningChunk = () => {
    if (!pendingReasoningChunk) return;
    if (typeof appendReasoningChunk === 'function') {
      appendReasoningChunk(nativeReasoningState, pendingReasoningChunk, { depth: 0 });
    }
    pendingReasoningChunk = null;
  };

  let streamError = '';
  try {
  for await (const chunk of (stream || [])) {
    if (resolveInterrupted()) {
      interrupted = true;
      break;
    }
    const normalizedChunk = typeof normalizeChunk === 'function'
      ? normalizeChunk(chunk)
      : chunk;
    const hasContentDelta = Boolean(normalizedChunk.content);
    const hasReasoningDelta = Boolean(normalizedChunk.reasoning);
    if (hasReasoningDelta) {
      queueReasoningChunk(normalizedChunk);
    }
    if (hasContentDelta) {
      full += normalizedChunk.content;
    }
    const preview = hasContentDelta
      ? creativeStreamProcessor?.append?.(normalizedChunk.content)
      : (creativeStreamProcessor?.lastSnapshot || null);
    if (!preview && !hasReasoningDelta) continue;
    if (hasReasoningDelta && !hasContentDelta && !shouldPushReasoningPreview()) continue;
    flushReasoningChunk();
    const currentPreview = preview || {
      display: '',
      stored: '',
      contentSource: '',
      raw: full,
      reasoning: '',
      reasoningDisplay: '',
    };
    const reasoningState = typeof resolveReasoningState === 'function'
      ? (resolveReasoningState(currentPreview, nativeReasoningState, { finalize: false }) || {})
      : {};
    const previewMeta = {
      renderRich: true,
      ...(reasoningState.reasoning
        ? {
            reasoning: reasoningState.reasoning,
            reasoningDisplay: reasoningState.reasoningDisplay,
            reasoningHidden: reasoningState.reasoningHidden,
            reasoningLabel: reasoningState.reasoningLabel,
            reasoningSource: reasoningState.reasoningSource,
          }
        : {}),
    };
    if (typeof pushAssistantStreamText === 'function') {
      nextStreamCtrl = pushAssistantStreamText(
        {
          content: currentPreview.display,
          raw: currentPreview.stored,
          rawSource: currentPreview.contentSource,
          rawOriginal: currentPreview.raw,
          reasoning: reasoningState.reasoning,
          reasoningDisplay: reasoningState.reasoningDisplay,
          meta: previewMeta,
        },
        {
          ...streamMeta,
          raw: currentPreview.stored,
          rawSource: currentPreview.contentSource,
          rawOriginal: currentPreview.raw,
          reasoning: reasoningState.reasoning,
          reasoningDisplay: reasoningState.reasoningDisplay,
          reasoningHidden: reasoningState.reasoningHidden,
          reasoningLabel: reasoningState.reasoningLabel,
          reasoningSource: reasoningState.reasoningSource,
        },
      );
    }
  }
  } catch (error) {
    // 用户中止照常上抛；尚无任何正文的失败也照常上抛（行为不变）。
    // 已经流出正文后网络/超时中断时保留 partial，让上层以部分内容收尾而不是整段丢弃。
    if (error?.name === 'AbortError' || !full.trim()) throw error;
    streamError = String(error?.message || error).slice(0, 300);
  }
  flushReasoningChunk();

  return {
    full,
    streamCtrl: nextStreamCtrl,
    nativeReasoningState,
    interrupted,
    streamError,
  };
};

export const commitAssistantReceiveEffects = ({
  parsed = null,
  sessionId = '',
  continueTarget = null,
  swipeTarget = null,
  commitContinuationMessage = null,
  appendMessage = null,
  chatStore = null,
  autoMarkReadIfActive = null,
  emitPluginAfterReceive = null,
  isTurnCheckpointSessionEnabled = null,
  syncTurnCheckpointForMessage = null,
  checkpointWarnMessage = 'sync turn checkpoint after assistant save failed',
  logger = null,
} = {}) => {
  const saved = continueTarget && typeof commitContinuationMessage === 'function'
    ? commitContinuationMessage(parsed)
    : (
        typeof appendMessage === 'function'
          ? appendMessage(parsed, sessionId)
          : chatStore?.appendMessage?.(parsed, sessionId)
      );
  const checkpointTargetMessageId = String(
    swipeTarget?.msgId || saved?.id || parsed?.id || continueTarget?.messageId || '',
  ).trim();

  if (typeof autoMarkReadIfActive === 'function') {
    autoMarkReadIfActive(sessionId, saved?.id || parsed?.id || '');
  }
  if (typeof emitPluginAfterReceive === 'function' && swipeTarget?.suppressAfterReceive !== true) {
    emitPluginAfterReceive(saved, sessionId);
  }
  if (
    typeof isTurnCheckpointSessionEnabled === 'function'
    && isTurnCheckpointSessionEnabled(sessionId)
    && !swipeTarget
    && typeof syncTurnCheckpointForMessage === 'function'
  ) {
    const syncResult = syncTurnCheckpointForMessage(sessionId, saved || parsed, {
      captureCurrentActiveState: true,
    });
    if (syncResult && typeof syncResult.catch === 'function') {
      syncResult.catch(err => {
        logger?.warn?.(checkpointWarnMessage, err);
      });
    }
  }

  return {
    saved,
    checkpointTargetMessageId,
  };
};

export const finalizeLegacyStreamAssistantResponse = async (
  {
    rawText = '',
    streamCtrl = null,
    streamMeta = {},
    nativeReasoningState = null,
    sessionId = '',
    memoryOptions = {},
    avatar = '',
    formatTime = null,
  } = {},
  {
    setLastRawResponse = null,
    handleMemoryEditsFromRaw = null,
    summaryEnabled = false,
    extractSummaryBlock = null,
    addSummary = null,
    appBridge = null,
    buildChatModeAssistantMessageParts = null,
    buildChatModeAssistantMessage = null,
    applyChatModeAssistantRegex = null,
    resolveReasoningState = null,
    parseSpecialMessage = null,
    updateActiveGenerationStreamCache = null,
    isStreamCtrlConnected = null,
    isSessionActive = null,
    ensureAssistantStreamCtrl = null,
    addMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const raw = String(rawText ?? '');
  let nextStreamCtrl = streamCtrl;

  if (typeof setLastRawResponse === 'function') {
    setLastRawResponse(raw);
  }

  let stripped = raw;
  if (typeof handleMemoryEditsFromRaw === 'function') {
    const memoryParsed = await handleMemoryEditsFromRaw(raw, memoryOptions || {});
    stripped = memoryParsed.text;
  }

  const shouldExtractSummary = typeof summaryEnabled === 'function'
    ? Boolean(summaryEnabled())
    : Boolean(summaryEnabled);
  if (shouldExtractSummary && typeof extractSummaryBlock === 'function') {
    const parsedSummary = extractSummaryBlock(raw);
    stripped = parsedSummary.text;
    if (parsedSummary.summary && typeof addSummary === 'function') {
      try {
        addSummary(parsedSummary.summary, sessionId);
      } catch {}
    }
  }

  // Keep chat-mode parsing delegated so regex/output parity stays owned by the builder module.
  const chatModeParts = typeof buildChatModeAssistantMessageParts === 'function'
    ? buildChatModeAssistantMessageParts({
        text: stripped,
        nativeReasoningState,
        applyChatModeAssistantRegex,
        resolveReasoningState,
      })
    : { display: stripped };
  const { display } = chatModeParts;
  const parsed = typeof buildChatModeAssistantMessage === 'function'
    ? buildChatModeAssistantMessage({
        parts: chatModeParts,
        rawOriginal: raw,
        id: nextStreamCtrl?.id,
        includeId: true,
        avatar,
        formatTime,
        parseSpecialMessage,
        usage: appBridge?.consumeLastGenerationUsage?.() ?? null,
        sources: appBridge?.consumeLastGenerationSources?.() ?? null,
      })
    : {
        role: 'assistant',
        content: display,
        rawOriginal: raw,
      };

  if (typeof updateActiveGenerationStreamCache === 'function') {
    updateActiveGenerationStreamCache(display, streamMeta);
  }

  const isConnected = ctrl => Boolean(
    typeof isStreamCtrlConnected === 'function' && isStreamCtrlConnected(ctrl),
  );
  const isActive = () => Boolean(
    typeof isSessionActive === 'function' && isSessionActive(sessionId),
  );

  if (isConnected(nextStreamCtrl)) {
    nextStreamCtrl.update(display);
  } else if (isActive()) {
    nextStreamCtrl = typeof ensureAssistantStreamCtrl === 'function'
      ? ensureAssistantStreamCtrl(streamMeta)
      : nextStreamCtrl;
    if (nextStreamCtrl) nextStreamCtrl.update(display);
  }

  if (isConnected(nextStreamCtrl)) {
    nextStreamCtrl.finish(parsed);
  } else if (isActive() && typeof addMessage === 'function') {
    addMessage(parsed);
  }

  commitAssistantReceiveEffects({
    parsed,
    sessionId,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
  });

  if (typeof refreshChatAndContacts === 'function') {
    refreshChatAndContacts();
  }

  return {
    parsed,
    streamCtrl: nextStreamCtrl,
    chatModeParts,
    display,
    stripped,
  };
};

export const finalizeCreativeStreamAssistantResponse = async (
  {
    rawText = '',
    streamCtrl = null,
    streamMeta = {},
    nativeReasoningState = null,
    sessionId = '',
    memoryOptions = {},
    avatar = '',
    formatTime = null,
    isRpMode = false,
    isGroupChat = false,
    suppressAssistantDom = false,
    continueTarget = null,
    swipeTarget = null,
  } = {},
  {
    isSessionActive = null,
    hideTyping = null,
    setLastRawResponse = null,
    handleMemoryEditsFromRaw = null,
    summaryEnabled = false,
    extractSummaryBlock = null,
    addSummary = null,
    requestSummaryCompaction = null,
    buildCreativeAssistantMessageParts = null,
    buildCreativeAssistantMessage = null,
    normalizeCreativeLineBreaks = null,
    extractReasoningFromContent = null,
    resolveReasoningState = null,
    applyOutputRegexPairSafe = null,
    appBridge = null,
    preserveAutoImagePromptPlaceholders = false,
    autoImagePromptPlaceholderOptions = {},
    pushAssistantStreamText = null,
    captureAssistantMemoryState = null,
    attachAssistantMemoryStateToMeta = null,
    isStreamCtrlConnected = null,
    ensureAssistantStreamCtrl = null,
    addMessage = null,
    commitContinuationMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    isTurnCheckpointSessionEnabled = null,
    syncTurnCheckpointForMessage = null,
    checkpointWarnMessage = 'sync turn checkpoint after assistant save failed',
    logger = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const raw = String(rawText ?? '');
  let nextStreamCtrl = streamCtrl;
  const isActive = () => Boolean(
    typeof isSessionActive === 'function' && isSessionActive(sessionId),
  );
  const isConnected = ctrl => Boolean(
    typeof isStreamCtrlConnected === 'function' && isStreamCtrlConnected(ctrl),
  );

  if (isActive() && typeof hideTyping === 'function') {
    hideTyping();
  }
  if (typeof setLastRawResponse === 'function') {
    setLastRawResponse(raw);
  }

  let stripped = raw;
  if (typeof handleMemoryEditsFromRaw === 'function') {
    const memoryParsed = await handleMemoryEditsFromRaw(raw, memoryOptions || {});
    stripped = memoryParsed.text;
  }

  let summary = '';
  const shouldExtractSummary = typeof summaryEnabled === 'function'
    ? Boolean(summaryEnabled())
    : Boolean(summaryEnabled);
  if (shouldExtractSummary && typeof extractSummaryBlock === 'function') {
    const parsedSummary = extractSummaryBlock(raw);
    stripped = parsedSummary.text;
    summary = parsedSummary.summary;
    if (summary) {
      if (typeof addSummary === 'function') {
        try {
          addSummary(summary, sessionId);
        } catch {}
      }
      if (typeof requestSummaryCompaction === 'function') {
        try {
          requestSummaryCompaction(sessionId);
        } catch {}
      }
    }
  }

  const effectivePreserveAutoImagePromptPlaceholders = Boolean(preserveAutoImagePromptPlaceholders);
  const creativeParts = typeof buildCreativeAssistantMessageParts === 'function'
    ? buildCreativeAssistantMessageParts({
        text: stripped,
        nativeReasoningState,
        normalizeCreativeLineBreaks,
        extractReasoningFromContent,
        resolveReasoningState,
        applyOutputRegexPairSafe,
        appBridge,
        preserveAutoImagePromptPlaceholders: effectivePreserveAutoImagePromptPlaceholders,
        autoImagePromptPlaceholderOptions,
      })
    : {
        finalSource: stripped,
        stored: stripped,
        display: stripped,
        resolvedReasoning: {},
      };
  const { finalSource, stored, display, resolvedReasoning = {} } = creativeParts;
  if (
    hasAutoImagePromptTag(raw) ||
    hasAutoImagePromptTag(stripped) ||
    countPendingImageTokens(finalSource) ||
    countPendingImageTokens(display)
  ) {
    logWritingAutoImageFinalizeDebug(logger, 'stream-parts', {
      sessionId,
      preserveAutoImagePromptPlaceholders: Boolean(preserveAutoImagePromptPlaceholders),
      effectivePreserveAutoImagePromptPlaceholders,
      rawLength: raw.length,
      strippedLength: String(stripped || '').length,
      rawHasTag: hasAutoImagePromptTag(raw),
      strippedHasTag: hasAutoImagePromptTag(stripped),
      finalSourceLength: String(finalSource || '').length,
      finalSourcePendingCount: countPendingImageTokens(finalSource),
      displayPendingCount: countPendingImageTokens(display),
      metaPlaceholderCount: Array.isArray(creativeParts?.autoImagePromptPlaceholders) ? creativeParts.autoImagePromptPlaceholders.length : 0,
      metaHasRawContent: Boolean(creativeParts?.autoImagePromptRawContent),
    });
  }
  const finalStreamMeta = {
    ...streamMeta,
    raw: stored,
    rawSource: finalSource,
    rawOriginal: raw,
    reasoning: resolvedReasoning.reasoning,
    reasoningDisplay: resolvedReasoning.reasoningDisplay,
    reasoningHidden: resolvedReasoning.reasoningHidden,
    reasoningLabel: resolvedReasoning.reasoningLabel,
    reasoningSource: resolvedReasoning.reasoningSource,
  };
  const finalStreamPayload = {
    content: display,
    raw: stored,
    rawSource: finalSource,
    rawOriginal: raw,
    reasoning: resolvedReasoning.reasoning,
    reasoningDisplay: resolvedReasoning.reasoningDisplay,
    meta: {
      renderRich: true,
      ...(resolvedReasoning.reasoning
        ? {
            reasoning: resolvedReasoning.reasoning,
            reasoningDisplay: resolvedReasoning.reasoningDisplay,
            reasoningHidden: resolvedReasoning.reasoningHidden,
            reasoningLabel: resolvedReasoning.reasoningLabel,
            reasoningSource: resolvedReasoning.reasoningSource,
          }
        : {}),
    },
  };
  if (typeof pushAssistantStreamText === 'function') {
    nextStreamCtrl = pushAssistantStreamText(finalStreamPayload, finalStreamMeta);
  }

  const parsed = typeof buildCreativeAssistantMessage === 'function'
    ? await buildCreativeAssistantMessage({
        parts: creativeParts,
        rawOriginal: raw,
        sessionId,
        id: nextStreamCtrl?.id,
        includeId: true,
        avatar,
        formatTime,
        summary,
        isRpMode,
        isGroupChat,
        captureAssistantMemoryState,
        attachAssistantMemoryStateToMeta,
        usage: appBridge?.consumeLastGenerationUsage?.() ?? null,
        sources: appBridge?.consumeLastGenerationSources?.() ?? null,
      })
    : {
        role: 'assistant',
        type: 'text',
        content: display,
        rawOriginal: raw,
      };

  if (!isConnected(nextStreamCtrl) && isActive()) {
    nextStreamCtrl = typeof ensureAssistantStreamCtrl === 'function'
      ? ensureAssistantStreamCtrl(streamMeta)
      : nextStreamCtrl;
  }
  if (isConnected(nextStreamCtrl)) {
    nextStreamCtrl.finish(parsed);
  } else if (
    isActive()
    && !suppressAssistantDom
    && !continueTarget
    && typeof addMessage === 'function'
  ) {
    addMessage(parsed);
  }

  const result = commitAssistantReceiveEffects({
    parsed,
    sessionId,
    continueTarget,
    swipeTarget,
    commitContinuationMessage,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
    isTurnCheckpointSessionEnabled,
    syncTurnCheckpointForMessage,
    checkpointWarnMessage,
    logger,
  });

  if (typeof refreshChatAndContacts === 'function') {
    refreshChatAndContacts();
  }

  return {
    parsed,
    streamCtrl: nextStreamCtrl,
    creativeParts,
    finalStreamPayload,
    finalStreamMeta,
    display,
    stripped,
    summary,
    checkpointTargetMessageId: result.checkpointTargetMessageId,
  };
};

export const finalizeBufferedCreativeAssistantResponse = async (
  {
    rawText = '',
    stripped = '',
    summary = '',
    sessionId = '',
    avatar = '',
    formatTime = null,
    isRpMode = false,
    isGroupChat = false,
    suppressAssistantDom = false,
    continueTarget = null,
    swipeTarget = null,
  } = {},
  {
    addSummary = null,
    requestSummaryCompaction = null,
    buildCreativeAssistantMessage = null,
    normalizeCreativeLineBreaks = null,
    extractReasoningFromContent = null,
    applyOutputRegexPairSafe = null,
    appBridge = null,
    preserveAutoImagePromptPlaceholders = false,
    autoImagePromptPlaceholderOptions = {},
    captureAssistantMemoryState = null,
    attachAssistantMemoryStateToMeta = null,
    isSessionActive = null,
    addMessage = null,
    commitContinuationMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    isTurnCheckpointSessionEnabled = null,
    syncTurnCheckpointForMessage = null,
    checkpointWarnMessage = 'sync turn checkpoint after buffered assistant save failed',
    logger = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const resolvedSummary = String(summary || '');
  if (resolvedSummary) {
    if (typeof addSummary === 'function') {
      try {
        addSummary(resolvedSummary, sessionId);
      } catch {}
    }
    if (typeof requestSummaryCompaction === 'function') {
      try {
        requestSummaryCompaction(sessionId);
      } catch {}
    }
  }

  const parsed = typeof buildCreativeAssistantMessage === 'function'
    ? await buildCreativeAssistantMessage({
        rawOriginal: rawText,
        text: stripped,
        sessionId,
        avatar,
        formatTime,
        summary: resolvedSummary,
        isRpMode,
        isGroupChat,
        normalizeCreativeLineBreaks,
        extractReasoningFromContent,
        applyOutputRegexPairSafe,
        appBridge,
        preserveAutoImagePromptPlaceholders: Boolean(preserveAutoImagePromptPlaceholders),
        autoImagePromptPlaceholderOptions,
        captureAssistantMemoryState,
        attachAssistantMemoryStateToMeta,
        usage: appBridge?.consumeLastGenerationUsage?.() ?? null,
        sources: appBridge?.consumeLastGenerationSources?.() ?? null,
      })
    : {
        role: 'assistant',
        type: 'text',
        content: stripped,
        rawOriginal: rawText,
      };
  if (
    hasAutoImagePromptTag(rawText) ||
    hasAutoImagePromptTag(stripped) ||
    countPendingImageTokens(parsed?.rawSource) ||
    countPendingImageTokens(parsed?.content)
  ) {
    logWritingAutoImageFinalizeDebug(logger, 'buffered-parsed', {
      sessionId,
      preserveAutoImagePromptPlaceholders: Boolean(preserveAutoImagePromptPlaceholders),
      effectivePreserveAutoImagePromptPlaceholders: Boolean(preserveAutoImagePromptPlaceholders),
      rawLength: String(rawText || '').length,
      strippedLength: String(stripped || '').length,
      rawHasTag: hasAutoImagePromptTag(rawText),
      strippedHasTag: hasAutoImagePromptTag(stripped),
      rawSourcePendingCount: countPendingImageTokens(parsed?.rawSource),
      contentPendingCount: countPendingImageTokens(parsed?.content),
      metaPlaceholderCount: Array.isArray(parsed?.meta?.autoImagePromptPlaceholders) ? parsed.meta.autoImagePromptPlaceholders.length : 0,
      metaHasRawContent: Boolean(parsed?.meta?.autoImagePromptRawContent),
    });
  }

  if (
    typeof isSessionActive === 'function'
    && isSessionActive(sessionId)
    && !suppressAssistantDom
    && !continueTarget
    && typeof addMessage === 'function'
  ) {
    addMessage(parsed);
  }

  const result = commitAssistantReceiveEffects({
    parsed,
    sessionId,
    continueTarget,
    swipeTarget,
    commitContinuationMessage,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
    isTurnCheckpointSessionEnabled,
    syncTurnCheckpointForMessage,
    checkpointWarnMessage,
    logger,
  });

  if (typeof refreshChatAndContacts === 'function') {
    refreshChatAndContacts();
  }

  return {
    parsed,
    checkpointTargetMessageId: result.checkpointTargetMessageId,
    summary: resolvedSummary,
  };
};

export const finalizeBufferedLegacyAssistantResponse = (
  {
    rawText = '',
    stripped = '',
    summary = '',
    sessionId = '',
    avatar = '',
    formatTime = null,
  } = {},
  {
    addSummary = null,
    requestSummaryCompaction = null,
    appBridge = null,
    buildChatModeAssistantMessage = null,
    applyChatModeAssistantRegex = null,
    parseSpecialMessage = null,
    isSessionActive = null,
    addMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const resolvedSummary = String(summary || '');
  if (resolvedSummary) {
    if (typeof addSummary === 'function') {
      try {
        addSummary(resolvedSummary, sessionId);
      } catch {}
    }
    if (typeof requestSummaryCompaction === 'function') {
      try {
        requestSummaryCompaction(sessionId);
      } catch {}
    }
  }

  // Keep chat-mode parsing delegated so regex/output parity stays owned by the builder module.
  const parsed = typeof buildChatModeAssistantMessage === 'function'
    ? buildChatModeAssistantMessage({
        text: stripped,
        rawOriginal: rawText,
        avatar,
        formatTime,
        applyChatModeAssistantRegex,
        parseSpecialMessage,
        usage: appBridge?.consumeLastGenerationUsage?.() ?? null,
        sources: appBridge?.consumeLastGenerationSources?.() ?? null,
      })
    : {
        role: 'assistant',
        content: stripped,
        rawOriginal: rawText,
      };

  if (
    typeof isSessionActive === 'function'
    && isSessionActive(sessionId)
    && typeof addMessage === 'function'
  ) {
    addMessage(parsed);
  }

  commitAssistantReceiveEffects({
    parsed,
    sessionId,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
  });

  if (typeof refreshChatAndContacts === 'function') {
    refreshChatAndContacts();
  }

  return {
    parsed,
    summary: resolvedSummary,
  };
};

export const runCreativeStreamAssistantResponseFlow = async (
  {
    stream = [],
    streamCtrl = null,
    streamMeta = {},
    nativeReasoningState = null,
    creativeStreamProcessor = null,
    sessionId = '',
    memoryOptions = {},
    avatar = '',
    formatTime = null,
    isRpMode = false,
    isGroupChat = false,
    suppressAssistantDom = false,
    continueTarget = null,
    swipeTarget = null,
  } = {},
  {
    normalizeChunk = chunk => chunk,
    isInterrupted = () => false,
    appendReasoningChunk = null,
    resolveReasoningState = null,
    pushAssistantStreamText = null,
    isSessionActive = null,
    hideTyping = null,
    setLastRawResponse = null,
    handleMemoryEditsFromRaw = null,
    summaryEnabled = false,
    extractSummaryBlock = null,
    addSummary = null,
    requestSummaryCompaction = null,
    buildCreativeAssistantMessageParts = null,
    buildCreativeAssistantMessage = null,
    normalizeCreativeLineBreaks = null,
    extractReasoningFromContent = null,
    applyOutputRegexPairSafe = null,
    appBridge = null,
    preserveAutoImagePromptPlaceholders = false,
    autoImagePromptPlaceholderOptions = {},
    captureAssistantMemoryState = null,
    attachAssistantMemoryStateToMeta = null,
    isStreamCtrlConnected = null,
    ensureAssistantStreamCtrl = null,
    addMessage = null,
    commitContinuationMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    isTurnCheckpointSessionEnabled = null,
    syncTurnCheckpointForMessage = null,
    checkpointWarnMessage = 'sync turn checkpoint after assistant save failed',
    logger = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const streamState = await consumeCreativeAssistantStream(stream, {
    streamCtrl,
    nativeReasoningState,
    streamMeta,
    creativeStreamProcessor,
  }, {
    normalizeChunk,
    isInterrupted,
    appendReasoningChunk,
    resolveReasoningState,
    pushAssistantStreamText,
  });
  const postStreamInterrupted = Boolean(typeof isInterrupted === 'function' && isInterrupted());
  if (postStreamInterrupted) {
    return {
      ...streamState,
      interrupted: true,
      loopInterrupted: streamState.interrupted,
      finalizeState: null,
    };
  }

  const finalizeState = await finalizeCreativeStreamAssistantResponse({
    rawText: streamState.full,
    streamCtrl: streamState.streamCtrl,
    streamMeta,
    nativeReasoningState,
    sessionId,
    memoryOptions,
    avatar,
    formatTime,
    isRpMode,
    isGroupChat,
    suppressAssistantDom,
    continueTarget,
    swipeTarget,
  }, {
    isSessionActive,
    hideTyping,
    setLastRawResponse,
    handleMemoryEditsFromRaw,
    summaryEnabled,
    extractSummaryBlock,
    addSummary,
    requestSummaryCompaction,
    buildCreativeAssistantMessageParts,
    buildCreativeAssistantMessage,
    normalizeCreativeLineBreaks,
    extractReasoningFromContent,
    resolveReasoningState,
    applyOutputRegexPairSafe,
    appBridge,
    preserveAutoImagePromptPlaceholders,
    autoImagePromptPlaceholderOptions,
    pushAssistantStreamText,
    captureAssistantMemoryState,
    attachAssistantMemoryStateToMeta,
    isStreamCtrlConnected,
    ensureAssistantStreamCtrl,
    addMessage,
    commitContinuationMessage,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
    isTurnCheckpointSessionEnabled,
    syncTurnCheckpointForMessage,
    checkpointWarnMessage,
    logger,
    refreshChatAndContacts,
  });

  return {
    ...streamState,
    interrupted: false,
    loopInterrupted: streamState.interrupted,
    streamCtrl: finalizeState.streamCtrl,
    finalizeState,
    checkpointTargetMessageId: finalizeState.checkpointTargetMessageId,
  };
};

export const runLegacyStreamAssistantResponseFlow = async (
  {
    stream = [],
    streamCtrl = null,
    streamMeta = {},
    nativeReasoningState = null,
    sessionId = '',
    memoryOptions = {},
    avatar = '',
    formatTime = null,
  } = {},
  {
    normalizeChunk = chunk => chunk,
    isInterrupted = () => false,
    appendReasoningChunk = null,
    buildStreamText = raw => raw,
    resolveReasoningState = null,
    pushAssistantStreamText = null,
    setLastRawResponse = null,
    handleMemoryEditsFromRaw = null,
    summaryEnabled = false,
    extractSummaryBlock = null,
    addSummary = null,
    appBridge = null,
    buildChatModeAssistantMessageParts = null,
    buildChatModeAssistantMessage = null,
    applyChatModeAssistantRegex = null,
    parseSpecialMessage = null,
    updateActiveGenerationStreamCache = null,
    isStreamCtrlConnected = null,
    isSessionActive = null,
    ensureAssistantStreamCtrl = null,
    addMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const streamState = await consumeLegacyAssistantStream(stream, {
    streamCtrl,
    nativeReasoningState,
    streamMeta,
  }, {
    normalizeChunk,
    isInterrupted,
    appendReasoningChunk,
    buildStreamText,
    resolveReasoningState,
    pushAssistantStreamText,
  });
  const postStreamInterrupted = Boolean(typeof isInterrupted === 'function' && isInterrupted());
  if (postStreamInterrupted) {
    return {
      ...streamState,
      interrupted: true,
      loopInterrupted: streamState.interrupted,
      finalizeState: null,
    };
  }

  const finalizeState = await finalizeLegacyStreamAssistantResponse({
    rawText: streamState.full,
    streamCtrl: streamState.streamCtrl,
    streamMeta,
    nativeReasoningState,
    sessionId,
    memoryOptions,
    avatar,
    formatTime,
  }, {
    setLastRawResponse,
    handleMemoryEditsFromRaw,
    summaryEnabled,
    extractSummaryBlock,
    addSummary,
    appBridge,
    buildChatModeAssistantMessageParts,
    buildChatModeAssistantMessage,
    applyChatModeAssistantRegex,
    resolveReasoningState,
    parseSpecialMessage,
    updateActiveGenerationStreamCache,
    isStreamCtrlConnected,
    isSessionActive,
    ensureAssistantStreamCtrl,
    addMessage,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
    refreshChatAndContacts,
  });

  return {
    ...streamState,
    interrupted: false,
    loopInterrupted: streamState.interrupted,
    streamCtrl: finalizeState.streamCtrl,
    finalizeState,
  };
};

export const runBufferedAssistantResponseFlow = async (
  {
    rawText = '',
    protocolEnabled = false,
    creativeMode = false,
    sessionId = '',
    memoryOptions = {},
    avatar = '',
    formatTime = null,
    isRpMode = false,
    isGroupChat = false,
    suppressAssistantDom = false,
    continueTarget = null,
    swipeTarget = null,
  } = {},
  {
    summaryEnabled = false,
    onBeforeRawSave = null,
    setLastRawResponse = null,
    handleMemoryEditsFromRaw = null,
    extractSummaryBlock = null,
    runProtocolBufferedResponse = null,
    addSummary = null,
    requestSummaryCompaction = null,
    buildCreativeAssistantMessage = null,
    normalizeCreativeLineBreaks = null,
    extractReasoningFromContent = null,
    applyOutputRegexPairSafe = null,
    appBridge = null,
    preserveAutoImagePromptPlaceholders = false,
    autoImagePromptPlaceholderOptions = {},
    captureAssistantMemoryState = null,
    attachAssistantMemoryStateToMeta = null,
    isSessionActive = null,
    addMessage = null,
    commitContinuationMessage = null,
    appendMessage = null,
    autoMarkReadIfActive = null,
    emitPluginAfterReceive = null,
    isTurnCheckpointSessionEnabled = null,
    syncTurnCheckpointForMessage = null,
    creativeCheckpointWarnMessage = 'sync turn checkpoint after buffered assistant save failed',
    logger = null,
    buildChatModeAssistantMessage = null,
    applyChatModeAssistantRegex = null,
    parseSpecialMessage = null,
    refreshChatAndContacts = null,
  } = {},
) => {
  const {
    stripped,
    protocolSummary,
  } = await prepareBufferedAssistantResponse({
    rawText,
    protocolEnabled,
    summaryEnabled,
    memoryOptions,
  }, {
    onBeforeRawSave,
    setLastRawResponse,
    handleMemoryEditsFromRaw,
    extractSummaryBlock,
  });

  if (creativeMode) {
    const finalizeState = await finalizeBufferedCreativeAssistantResponse({
      rawText,
      stripped,
      summary: protocolSummary,
      sessionId,
      avatar,
      formatTime,
      isRpMode,
      isGroupChat,
      suppressAssistantDom,
      continueTarget,
      swipeTarget,
    }, {
      addSummary,
      requestSummaryCompaction,
      buildCreativeAssistantMessage,
      normalizeCreativeLineBreaks,
      extractReasoningFromContent,
      applyOutputRegexPairSafe,
      appBridge,
      preserveAutoImagePromptPlaceholders,
      autoImagePromptPlaceholderOptions,
      captureAssistantMemoryState,
      attachAssistantMemoryStateToMeta,
      isSessionActive,
      addMessage,
      commitContinuationMessage,
      appendMessage,
      autoMarkReadIfActive,
      emitPluginAfterReceive,
      isTurnCheckpointSessionEnabled,
      syncTurnCheckpointForMessage,
      checkpointWarnMessage: creativeCheckpointWarnMessage,
      logger,
      refreshChatAndContacts,
    });
    return {
      branch: 'creative',
      rawText,
      stripped,
      protocolSummary,
      checkpointTargetMessageId: finalizeState.checkpointTargetMessageId,
      finalizeState,
    };
  }

  if (protocolEnabled) {
    const summarySessionIds = new Set([sessionId]);
    const protocolState = typeof runProtocolBufferedResponse === 'function'
      ? await runProtocolBufferedResponse({
          rawText,
          protocolSummary,
          summarySessionIds,
          memoryOptions,
        })
      : null;
    return {
      branch: 'protocol',
      rawText,
      stripped,
      protocolSummary,
      summarySessionIds,
      protocolState,
    };
  }

  const finalizeState = finalizeBufferedLegacyAssistantResponse({
    rawText,
    stripped,
    summary: protocolSummary,
    sessionId,
    avatar,
    formatTime,
  }, {
    addSummary,
    requestSummaryCompaction,
    appBridge,
    buildChatModeAssistantMessage,
    applyChatModeAssistantRegex,
    parseSpecialMessage,
    isSessionActive,
    addMessage,
    appendMessage,
    autoMarkReadIfActive,
    emitPluginAfterReceive,
    refreshChatAndContacts,
  });
  return {
    branch: 'legacy',
    rawText,
    stripped,
    protocolSummary,
    finalizeState,
  };
};
