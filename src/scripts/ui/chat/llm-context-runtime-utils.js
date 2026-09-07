import {
  buildLlmContextPayload,
  resolveMemoryTablePlace,
} from './llm-context-builder-utils.js';
import { buildLlmHistoryForSession } from './llm-history-builder-utils.js';

export const createLlmHistoryBuilder = ({
  sessionId = '',
  getMessages = null,
  getSettings = null,
  getOpenAIPreset = null,
  getReasoningPreset = null,
  excludeMessageIds = [],
  isRpMode = false,
  isGroupChat = false,
  rpUiMode = false,
  getCompactedSummary = null,
  getSummaries = null,
  isAttachmentExpired = null,
  resolvePlainText = null,
  resolveStickerKeyword = null,
  buildStickerToken = null,
  applyMacros = null,
} = {}) => {
  const sid = String(sessionId || '').trim();
  return (pendingUserText = '') => buildLlmHistoryForSession({
    messages: getMessages?.(sid) || [],
    pendingUserText,
    excludeMessageIds,
    isRpMode,
    isGroupChat,
    rpUiMode,
    creativeSummaryGetters: {
      getCompactedSummary: () => getCompactedSummary?.(sid) || '',
      getSummaries: () => getSummaries?.(sid) || [],
    },
    isAttachmentExpired,
    resolvePlainText,
    resolveStickerKeyword,
    buildStickerToken,
    settings: getSettings?.() || {},
    openaiPreset: getOpenAIPreset?.() || {},
    reasoningPreset: getReasoningPreset?.() || {},
    applyMacros: typeof applyMacros === 'function'
      ? applyMacros
      : (value => String(value ?? '')),
  });
};

export const createLlmContextBuilder = ({
  promptUserName = '',
  activeUser = null,
  characterName = '',
  activePersona = null,
  sessionId = '',
  isGroupChat = false,
  getSessionSettings = null,
  getDisableSummary = null,
  getFormatProfileEnabled = null,
  skipInputRegex = false,
  continueTarget = null,
  rpUiMode = false,
  getUiMode = null,
  sharedVariables = false,
  isRpMode = false,
  getRpBridgeSessionId = null,
  getLastChatBridgeSessionId = null,
  getMemoryStorageMode = null,
  isMemoryAutoExtractInline = null,
  getAutoImagePromptModelHint = null,
  attachmentParts = [],
  getOpenAIPreset = null,
  getSettings = null,
  getMemoryTotalTurns = null,
  getReplyPromptHint = null,
  getStagePromptBlocks = null,
  getInjectedPromptBlocks = null,
  getHopscotchFused = null,
  skipTemplate = false,
  skipScripts = false,
  groupMembers = [],
  getContactName = null,
  buildHistory = null,
} = {}) => {
  const sid = String(sessionId || '').trim();
  return (pendingUserText = '') => {
    const resolvedUiMode = getUiMode?.() || 'chat';
    const memoryPlace = resolveMemoryTablePlace(resolvedUiMode);
    const openaiPreset = getOpenAIPreset?.() || {};
    const settings = getSettings?.() || {};
    const payload = buildLlmContextPayload({
      promptUserName,
      activeUser,
      characterName,
      activePersona,
      sessionId: sid,
      isGroupChat,
      sessionSettings: getSessionSettings?.(sid) || {},
      disableSummary: getDisableSummary?.() === true,
      skipInputRegex,
      continueTarget,
      rpUiMode,
      uiMode: resolvedUiMode,
      sharedVariables,
      isRpMode,
      rpBridgeSessionId: String(getRpBridgeSessionId?.() || '').trim(),
      lastChatBridgeSessionId: String(getLastChatBridgeSessionId?.() || '').trim(),
      memoryStorageMode: getMemoryStorageMode?.(memoryPlace) || '',
      memoryAutoExtract: isMemoryAutoExtractInline?.(memoryPlace) === true,
      autoImagePromptModelHint: getAutoImagePromptModelHint?.() || '',
      openaiPreset,
      settings,
      attachmentParts,
      replyPromptHint: getReplyPromptHint?.() || '',
      stagePromptBlocks: getStagePromptBlocks?.() || [],
      injectedPromptBlocks: getInjectedPromptBlocks?.() || [],
      skipTemplate,
      skipScripts,
      groupMembers,
      getContactName,
      buildHistory,
      pendingUserText,
    });
    const maxContextTokens = Math.trunc(Number(openaiPreset?.openai_max_context));
    const maxOutputTokens = Math.trunc(Number(openaiPreset?.openai_max_tokens));
    payload.meta = {
      ...(payload.meta || {}),
      ...(getHopscotchFused?.() ? { hopscotchFused: getHopscotchFused() } : {}),
      formatProfileEnabled: getFormatProfileEnabled?.() === true,
      inputBudgetContext: {
        maxContextTokens: Number.isFinite(maxContextTokens) && maxContextTokens > 0
          ? maxContextTokens
          : null,
        maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
          ? maxOutputTokens
          : 0,
      },
    };
    const totalTurns = Math.trunc(Number(getMemoryTotalTurns?.(sid)));
    if (Number.isFinite(totalTurns) && totalTurns > 0) {
      payload.meta.memoryTotalTurns = totalTurns;
    }
    return payload;
  };
};
