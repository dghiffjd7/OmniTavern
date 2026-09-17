import { buildChatFormatGuardianModelPrompt, extractChatFormatEventDrafts, resolveChatFormatGuardianFormatProfile, CHAT_FORMAT_GUARDIAN_TARGETS } from '../ui/chat/chat-format-guardian-utils.js';
import { selectChatFormatReminderTextForProfile } from '../ui/chat/after-receive-dispatch-utils.js';
import { createFormatPatchRevisionToken } from '../ui/chat/format-patch-transaction-utils.js';
import { createFormatRepairSelection } from './format-repair-selection.js';

// Shared by the real request and AC preview. Callers own model capture and
// source identity; this assembles only the frozen profile and actual target.
export const buildFormatRepairRequest = async ({ config, repairTarget, range = null, message, baseOptions = {}, signal,
  baseRevision = createFormatPatchRevisionToken() } = {}) => {
  const source = repairTarget?.sourceText;
  const selection = createFormatRepairSelection(source, { range, checkType: config.repairCheckType });
  if (!repairTarget?.ok || !selection.ok) throw new Error(selection.message || '无法取得完整原文');
  const modelOptions = { ...baseOptions.modelReview, agentConfig: config, customFormatGuide: config.formatGuide };
  const options = { ...baseOptions, baseRevision, sourceSnapshot: source, sourceMessageId: message.id, repairTarget };
  const parserReport = extractChatFormatEventDrafts(selection.text, { ...options, customFormatGuide: config.formatGuide });
  const formatProfile = resolveChatFormatGuardianFormatProfile({
    target: config.repairCheckType === 'tableEdit' ? CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit
      : selection.fragment ? CHAT_FORMAT_GUARDIAN_TARGETS.creativeText : modelOptions.formatTarget,
    uiMode: modelOptions.uiMode, surface: modelOptions.surface, isGroupChat: modelOptions.isGroupChat,
    assistantText: selection.text, parserResult: parserReport,
    enabledFormats: config.repairCheckType === 'tableEdit' ? { tableEdit: true } : modelOptions.enabledFormats,
  });
  const referenceContext = await modelOptions.resolveReferenceContext?.({ targetMessageId: message.id, signal }) || modelOptions.referenceContext;
  if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
  const prompt = buildChatFormatGuardianModelPrompt({ assistantText: selection.text,
    agentConfig: config, referenceContext, customFormatGuide: config.formatGuide,
    formatReminderText: selectChatFormatReminderTextForProfile(modelOptions, formatProfile),
    enabledFormats: formatProfile.enabledFormats, parserReport, userName: modelOptions.userName,
    sessionLabel: modelOptions.sessionLabel, surface: modelOptions.surface, formatTarget: formatProfile.target,
    baseRevision, repairTarget, repairSelection: selection,
  });
  return { ...prompt, baseRevision, selection, source, formatProfile, modelOptions, options };
};
