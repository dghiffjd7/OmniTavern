import { finalizeLlmHistory } from './llm-history-utils.js';
import { buildLlmHistoryCandidates } from './llm-history-candidate-utils.js';
import { buildLlmHistoryFinalizeOptions } from './llm-history-config-utils.js';
import { HISTORY_TIMESTAMP_FIELD, resolveHistoryTimestamp } from './history-time-context-utils.js';
import {
  buildLlmHistoryEntry,
  loadLlmCreativeSummarySource,
  resolveLlmCreativeHistorySummary,
} from './llm-history-entry-utils.js';

export const buildLlmHistoryForSession = ({
  applyMacros,
  buildStickerToken,
  creativeSummaryGetters,
  excludeMessageIds,
  isAttachmentExpired,
  isGroupChat,
  isRpMode,
  messages,
  openaiPreset,
  pendingUserText,
  reasoningPreset,
  resolvePlainText,
  resolveStickerKeyword,
  rpUiMode,
  settings,
} = {}) => {
  const creativeSummarySource = loadLlmCreativeSummarySource(creativeSummaryGetters);
  const candidates = buildLlmHistoryCandidates(messages || [], {
    excludeMessageIds,
    isRpMode,
    rpUiMode,
    isGroupChat,
  });
  const history = candidates
    .map(({ message, depth }) => {
      const entry = buildLlmHistoryEntry(message, {
        isGroupChat,
        isRpMode,
        rpUiMode,
        depth,
        creativeSummary: resolveLlmCreativeHistorySummary({
          directSummary: message?.meta?.summary,
          compactedSummary: creativeSummarySource.compactedSummary,
          summaries: creativeSummarySource.summaries,
        }),
        resolvePlainText,
        resolveStickerKeyword,
        buildStickerToken,
      });
      const timestamp = resolveHistoryTimestamp(message);
      if (entry && timestamp && !isRpMode && !rpUiMode && !message?.meta?.renderRich) {
        return { ...entry, [HISTORY_TIMESTAMP_FIELD]: timestamp };
      }
      return entry;
    })
    .filter(Boolean);
  return finalizeLlmHistory(history, buildLlmHistoryFinalizeOptions({
    pendingUserText,
    settings,
    openaiPreset,
    rpUiMode,
    reasoningPreset,
    applyMacros,
  }));
};
