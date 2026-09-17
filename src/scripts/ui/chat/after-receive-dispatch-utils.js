import {
  buildAfterReceiveHookFinishTraceEvent,
  buildAfterReceiveHookStartTraceEvent,
  emitHookLifecycleTrace,
} from './hook-lifecycle-trace-utils.js';
import { mergeAgentMessageParts } from '../../agent/agent-message-parts.js';
import {
  buildChatFormatGuardianModelPrompt,
  extractChatFormatEventDrafts,
  normalizeChatFormatGuardianModelReview,
  resolveChatFormatGuardianFormatProfile,
} from './chat-format-guardian-utils.js';
import {
  createFormatPatchRevisionToken,
  FORMAT_PATCH_MODEL_MAX_TOKENS,
} from './format-patch-transaction-utils.js';
import { validateFormatRepairFunctionPayloads } from './format-repair-side-effect-utils.js';
import {
  analyzeChatBodyQuality,
  CHAT_BODY_QUALITY_STATUSES,
} from './chat-body-quality-guardian-utils.js';
import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';

const CHAT_FORMAT_GUARDIAN_SOURCE = 'chat-format-guardian';
const CHAT_FORMAT_GUARDIAN_KIND = 'chat_format_guardian';
const CHAT_BODY_QUALITY_SOURCE = 'chat-body-quality-guardian';
const CHAT_BODY_QUALITY_KIND = 'chat_body_quality_guardian';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const getGuardianPromptLine = (key, replacements = {}) => {
  let text = getLocalizedPromptText(key);
  Object.entries(replacements).forEach(([name, value]) => {
    text = text.split(`{${name}}`).join(String(value ?? ''));
  });
  return text;
};

const list = value => (Array.isArray(value) ? value : []).filter(Boolean);
const normalizeStringList = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const toTimestamp = (now = Date.now) => {
  if (typeof now === 'function') {
    const numeric = Number(now());
    return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
  }
  const numeric = Number(now);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
};

const truncate = (value = '', maxLength = 80) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  const limit = Math.max(8, Math.trunc(Number(maxLength) || 80));
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
};

const truncateRawText = (value = '', maxLength = 6000) => {
  const text = String(value ?? '');
  const limit = Math.max(200, Math.trunc(Number(maxLength) || 6000));
  return {
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated: text.length > limit,
  };
};

const countBy = (items = [], keyFn = item => item) => {
  const counts = {};
  list(items).forEach((item) => {
    const key = trim(keyFn(item), 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
};

const getChatFormatGuardianStatus = (status = '') => {
  if (status === 'invalid' || status === 'invalid_output') return 'failed';
  if (status === 'needs_review') return 'waiting_permission';
  return 'succeeded';
};

// 「检查器自身故障」与「检查完成且发现格式问题」共用 invalid 状态，标题必须区分：
// 否则检查模型超时/请求失败/返回不可解析 JSON 时，卡片会显示「聊天格式错误」，
// 把责任错误地指向用户的聊天内容。这三个 issue type 只由故障路径产生
// （request_error/timeout 来自 failure builder，parse_error 来自 normalize 兜底）。
const CHAT_FORMAT_GUARDIAN_CHECK_FAILURE_ISSUE_TYPES = new Set(['request_error', 'timeout', 'parse_error']);

const isChatFormatGuardianCheckIncomplete = (review = null) => {
  if (!isPlainObject(review)) return false;
  if (!['invalid', 'invalid_output'].includes(trim(review.status))) return false;
  const issues = list(review.issues);
  return issues.length > 0
    && issues.every(issue => CHAT_FORMAT_GUARDIAN_CHECK_FAILURE_ISSUE_TYPES.has(trim(issue?.type)));
};

const getChatFormatGuardianTitle = (result = null) => {
  if (isChatFormatGuardianCheckIncomplete(result?.modelReview)) return '格式检查未完成';
  const status = trim(result?.status);
  if (status === 'invalid_output') return '格式检查未完成';
  if (status === 'needs_format_spec') return '缺少格式规范';
  if (status === 'cannot_repair') return '无法安全修复';
  if (status === 'invalid') return '聊天格式错误';
  if (status === 'needs_review') return '聊天格式待确认';
  return '聊天格式已验证';
};

const getChatBodyQualityStatus = (status = '') => {
  if (status === CHAT_BODY_QUALITY_STATUSES.invalid) return 'failed';
  if (status === CHAT_BODY_QUALITY_STATUSES.minorIssues ||
    status === CHAT_BODY_QUALITY_STATUSES.needsReview) {
    return 'waiting_permission';
  }
  return 'succeeded';
};

const getChatBodyQualityTitle = (status = '') => {
  if (status === CHAT_BODY_QUALITY_STATUSES.invalid) return '正文不可用';
  if (status === CHAT_BODY_QUALITY_STATUSES.minorIssues) return '正文可优化';
  if (status === CHAT_BODY_QUALITY_STATUSES.needsReview) return '正文待确认';
  return '正文已检查';
};

const sanitizeIdPart = (value = '', fallback = 'message') => {
  const text = trim(value, fallback)
    .replace(/[^a-zA-Z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || fallback;
};

const buildChatFormatGuardianRunId = ({
  result = null,
  message = {},
  sessionId = '',
} = {}) => {
  const sourceMessageId = trim(result?.sourceMessageId || message?.id || sessionId, 'message');
  return `run:chat-format-guardian:${sanitizeIdPart(sourceMessageId)}`;
};

const buildChatBodyQualityRunId = ({
  result = null,
  message = {},
  sessionId = '',
} = {}) => {
  const sourceMessageId = trim(result?.sourceMessageId || message?.id || sessionId, 'message');
  return `run:chat-body-quality:${sanitizeIdPart(sourceMessageId)}`;
};

const resolveChatFormatGuardianSurface = (events = []) => {
  const surfaces = Array.from(new Set(list(events).map(event => trim(event?.surface)).filter(Boolean)));
  if (surfaces.length === 1) return surfaces[0];
  if (surfaces.includes('moments') && !surfaces.includes('chat')) return 'moments';
  return 'chat';
};

const buildChatFormatGuardianInputSuggestion = ({ errors = [], warnings = [] } = {}) => {
  const issues = [...errors, ...warnings].map(item => trim(item)).filter(Boolean);
  const hints = [];
  if (issues.some(issue => issue.includes('time is missing'))) hints.push(getGuardianPromptLine('format_guardian.regenerate.hint_time'));
  if (issues.some(issue => issue.includes('target is unresolved'))) hints.push(getGuardianPromptLine('format_guardian.regenerate.hint_target'));
  if (issues.some(issue => issue.includes('speaker is unresolved'))) hints.push(getGuardianPromptLine('format_guardian.regenerate.hint_speaker'));
  if (issues.some(issue => issue.includes('content is required'))) hints.push(getGuardianPromptLine('format_guardian.regenerate.hint_content'));
  if (!hints.length && issues.length) hints.push(getGuardianPromptLine('format_guardian.regenerate.hint_structure'));
  const focus = hints.length
    ? getGuardianPromptLine('format_guardian.regenerate.focus', { hints: hints.join('; ') })
    : getGuardianPromptLine('format_guardian.regenerate.focus_default');
  return getGuardianPromptLine('format_guardian.regenerate.request', { focus });
};

const summarizeChatFormatRepairCandidate = (repairCandidate = null, { includeText = false } = {}) => {
  if (!repairCandidate?.available) return null;
  const summary = {
    available: true,
    kind: trim(repairCandidate.kind),
    title: trim(repairCandidate.title, '格式修复'),
    summary: trim(repairCandidate.summary),
    preview: truncate(repairCandidate.preview, 220),
    fallbackTime: trim(repairCandidate.fallbackTime),
    fixedWarnings: list(repairCandidate.fixedWarnings).map(item => trim(item)).filter(Boolean),
    eventCount: Math.max(0, Math.trunc(Number(repairCandidate.eventCount) || 0)),
    issueCount: Math.max(0, Math.trunc(Number(repairCandidate.issueCount) || 0)),
    protocolVersion: trim(repairCandidate.protocolVersion),
    baseRevision: trim(repairCandidate.baseRevision),
    sourceKind: trim(repairCandidate.sourceKind),
    sourceSessionId: trim(repairCandidate.sourceSessionId),
    targetSessionId: trim(repairCandidate.targetSessionId),
    turnId: trim(repairCandidate.turnId),
    sourceMessageIds: normalizeStringList(repairCandidate.sourceMessageIds),
    formatTarget: trim(repairCandidate.formatTarget),
    formatSourceIds: normalizeStringList(repairCandidate.formatSourceIds),
    reviewWarning: trim(repairCandidate.reviewWarning),
    linePatches: list(repairCandidate.linePatches).map(patch => ({
      startLine: Number(patch?.startLine || 0) || 0,
      endLine: Number(patch?.endLine || 0) || 0,
      originalLines: Array.isArray(patch?.originalLines)
        ? patch.originalLines.map(line => String(line ?? ''))
        : [],
      replacementLines: Array.isArray(patch?.replacementLines)
        ? patch.replacementLines.map(line => String(line ?? ''))
        : [],
      reason: trim(patch?.reason),
    })),
  };
  if (includeText) {
    summary.replacementText = String(repairCandidate.replacementText || '');
    summary.sourceSnapshot = String(repairCandidate.sourceSnapshot || '');
  }
  return summary;
};

const summarizeChatFormatModelReview = (modelReview = null, { includeText = false } = {}) => {
  if (!isPlainObject(modelReview)) return null;
  const summary = {
    status: trim(modelReview.status),
    canRepair: modelReview.canRepair === true,
    attemptCount: Math.max(0, Math.trunc(Number(modelReview.attemptCount) || 0)),
    repairSummary: trim(modelReview.repairSummary),
    rawPreview: truncate(modelReview.rawPreview, 180),
    issueCount: list(modelReview.issues).length,
    patchCount: list(modelReview.linePatches).length,
    linePatches: list(modelReview.linePatches)
      .map(patch => ({
        startLine: Number(patch?.startLine || 0) || 0,
        endLine: Number(patch?.endLine || 0) || 0,
        reason: trim(patch?.reason),
      }))
      .filter(patch => patch.startLine > 0 && patch.endLine >= patch.startLine)
      .slice(0, 8),
    issues: list(modelReview.issues)
      .map(issue => ({
        severity: trim(issue?.severity, 'warning'),
        type: trim(issue?.type, 'other'),
        message: trim(issue?.message),
        evidence: truncate(issue?.evidence, 96),
      }))
      .filter(issue => issue.message)
      .slice(0, 6),
    domainValidation: isPlainObject(modelReview.domainValidation)
      ? {
        applicable: modelReview.domainValidation.applicable === true,
        ok: modelReview.domainValidation.ok === true,
        status: trim(modelReview.domainValidation.status),
        parserStatus: trim(modelReview.domainValidation.parserReport?.status),
      }
      : null,
    functionPayloadValidation: isPlainObject(modelReview.functionPayloadValidation)
      ? {
        ok: modelReview.functionPayloadValidation.ok === true,
        beforeBlockCount: Math.max(
          0,
          Math.trunc(Number(modelReview.functionPayloadValidation.beforeBlockCount) || 0),
        ),
        afterBlockCount: Math.max(
          0,
          Math.trunc(Number(modelReview.functionPayloadValidation.afterBlockCount) || 0),
        ),
        violationCount: list(modelReview.functionPayloadValidation.violations).length,
      }
      : null,
    sourceTruncationSuspected: modelReview.sourceTruncationSuspected === true,
  };
  if (includeText) summary.candidateText = String(modelReview.candidateText || '');
  return summary;
};

const summarizeChatFormatAutoRepairResult = (autoRepairResult = null, {
  autoApplyRepair = false,
} = {}) => {
  const attempted = isPlainObject(autoRepairResult);
  if (!autoApplyRepair && !attempted) return null;
  const eventCount = Math.max(0, Math.trunc(Number(autoRepairResult?.eventCount) || 0));
  return {
    autoApplyRepair: autoApplyRepair === true,
    attempted,
    didAnything: autoRepairResult?.didAnything === true,
    reason: trim(autoRepairResult?.reason),
    errorMessage: trim(autoRepairResult?.errorMessage),
    eventCount,
    mutatedMoments: autoRepairResult?.mutatedMoments === true,
  };
};

const summarizeChatFormatModelReviewDetail = (modelReview = null, {
  maxTextLength = 6000,
  maxRawTextLength = 12000,
  maxPatchLines = 40,
} = {}) => {
  if (!isPlainObject(modelReview)) return null;
  const candidate = truncateRawText(modelReview.candidateText, maxTextLength);
  const rawText = truncateRawText(modelReview.rawText || modelReview.rawPreview, maxRawTextLength);
  const normalizedPatchLines = Math.max(4, Math.trunc(Number(maxPatchLines) || 40));
  const linePatches = list(modelReview.linePatches)
    .map((patch) => {
      const originalLines = Array.isArray(patch?.originalLines)
        ? patch.originalLines.map(line => String(line ?? '')).slice(0, 20)
        : null;
      const replacementSource = Array.isArray(patch?.replacementLines)
        ? patch.replacementLines
        : String(patch?.replacementText || '').split(/\r?\n/);
      const replacementLines = replacementSource
        .map(line => String(line ?? ''))
        .slice(0, normalizedPatchLines);
      return {
        startLine: Number(patch?.startLine || 0) || 0,
        endLine: Number(patch?.endLine || 0) || 0,
        reason: trim(patch?.reason),
        originalLines,
        replacementLines,
        replacementLineCount: Array.isArray(patch?.replacementLines)
          ? patch.replacementLines.length
          : replacementSource.length,
        replacementLinesTruncated: replacementSource.length > normalizedPatchLines,
        originalMatches: patch?.originalMatches === true
          ? true
          : (patch?.originalMatches === false ? false : null),
      };
    })
    .filter(patch => patch.startLine > 0 && patch.endLine >= patch.startLine)
    .slice(0, 8);
  const issues = list(modelReview.issues)
    .map(issue => ({
      severity: trim(issue?.severity, 'warning'),
      type: trim(issue?.type, 'other'),
      message: trim(issue?.message),
      evidence: truncate(issue?.evidence, 160),
    }))
    .filter(issue => issue.message)
    .slice(0, 8);
  const detail = {
    status: trim(modelReview.status),
    canRepair: modelReview.canRepair === true,
    attemptCount: Math.max(0, Math.trunc(Number(modelReview.attemptCount) || 0)),
    repairSummary: trim(modelReview.repairSummary),
    rawPreview: truncate(modelReview.rawPreview, 500),
    rawText: rawText.text,
    rawTextTruncated: modelReview.rawTextTruncated === true || rawText.truncated,
    issueCount: list(modelReview.issues).length,
    patchCount: list(modelReview.linePatches).length,
    candidateText: candidate.text,
    candidateTextTruncated: candidate.truncated,
    baseRevision: trim(modelReview.baseRevision),
    protocolVersion: trim(modelReview.protocolVersion),
    validationErrors: list(modelReview.validationErrors)
      .map(item => ({
        code: trim(item?.code),
        message: trim(item?.message),
        patchIndex: Number.isInteger(item?.patchIndex) ? item.patchIndex : null,
      }))
      .filter(item => item.code || item.message)
      .slice(0, 8),
    domainValidation: isPlainObject(modelReview.domainValidation)
      ? {
        applicable: modelReview.domainValidation.applicable === true,
        ok: modelReview.domainValidation.ok === true,
        status: trim(modelReview.domainValidation.status),
        parserReport: isPlainObject(modelReview.domainValidation.parserReport)
          ? {
            status: trim(modelReview.domainValidation.parserReport.status),
            summary: trim(modelReview.domainValidation.parserReport.summary),
            eventCount: Math.max(
              0,
              Math.trunc(Number(modelReview.domainValidation.parserReport.eventCount) || 0),
            ),
            errors: normalizeStringList(modelReview.domainValidation.parserReport.errors).slice(0, 8),
            warnings: normalizeStringList(modelReview.domainValidation.parserReport.warnings).slice(0, 8),
          }
          : null,
      }
      : null,
    functionPayloadValidation: isPlainObject(modelReview.functionPayloadValidation)
      ? {
        ok: modelReview.functionPayloadValidation.ok === true,
        beforeBlockCount: Math.max(
          0,
          Math.trunc(Number(modelReview.functionPayloadValidation.beforeBlockCount) || 0),
        ),
        afterBlockCount: Math.max(
          0,
          Math.trunc(Number(modelReview.functionPayloadValidation.afterBlockCount) || 0),
        ),
        violations: list(modelReview.functionPayloadValidation.violations)
          .map(item => ({
            code: trim(item?.code),
            identity: trim(item?.identity),
            kind: trim(item?.kind),
            message: trim(item?.message),
          }))
          .filter(item => item.code || item.message)
          .slice(0, 8),
      }
      : null,
    sourceTruncationSuspected: modelReview.sourceTruncationSuspected === true,
    linePatches,
    issues,
  };
  if (
    !detail.status &&
    !detail.repairSummary &&
    !detail.rawPreview &&
    !detail.rawText.trim() &&
    !detail.candidateText.trim() &&
    !detail.linePatches.length &&
    !detail.issues.length
  ) {
    return null;
  }
  return detail;
};

const buildChatFormatGuardianDecisionActions = ({
  result = null,
  errors = [],
  warnings = [],
  repairCandidate = null,
  includeRepairText = false,
} = {}) => {
  const status = trim(result?.status);
  if (!status || status === 'no_events' || status === 'ready') return [];
  const inputSuggestion = buildChatFormatGuardianInputSuggestion({ errors, warnings });
  const repairSummary = summarizeChatFormatRepairCandidate(repairCandidate, { includeText: includeRepairText });
  const actions = [];
  if (repairSummary?.available) {
    actions.push({
      id: 'apply_repair',
      label: '应用修复',
      enabled: true,
      description: repairSummary.summary || '应用格式修复候选。',
      repairCandidate: repairSummary,
    });
  }
  actions.push(
    {
      id: 'swipe_retry',
      label: '重试生成',
      enabled: true,
      description: '创意写作模式会创建新的右滑候选；其他模式走现有重新生成链路。',
    },
    {
      id: 'review_original',
      label: '查看原文',
      enabled: true,
      description: '查看这次 AI 回复的原始内容。',
    },
    {
      id: 'edit_user_input_suggestion',
      label: '修改输入建议',
      enabled: true,
      description: '把一段格式修正建议放入输入框，由用户决定是否发送。',
      suggestion: inputSuggestion,
    },
    {
      id: 'open_agent_center',
      label: 'Agent Center',
      enabled: true,
      description: '在 Agent Center 活动页查看这次格式检查记录。',
    },
  );
  if (!repairSummary?.available) {
    actions.push({
      id: 'apply_repair',
      label: '应用修复',
      enabled: false,
      description: '当前问题没有安全的自动修复候选。',
    });
  }
  return actions;
};

const resolveChatFormatGuardianRepairCandidate = ({ result = null, message = {} } = {}) => {
  if (!result || result.status === 'no_events' || result.status === 'ready') return null;
  const modelReview = isPlainObject(result?.modelReview) ? result.modelReview : null;
  const modelCandidateText = String(modelReview?.candidateText || '');
  if (modelReview?.canRepair === true && modelCandidateText) {
    const issues = list(modelReview.issues);
    return {
      available: true,
      kind: 'model_format_repair',
      title: '模型格式修复',
      summary: trim(modelReview.repairSummary, '应用模型给出的最小格式修复。'),
      preview: truncate(modelCandidateText, 220),
      replacementText: modelCandidateText,
      candidateText: modelCandidateText,
      baseRevision: trim(modelReview.baseRevision),
      protocolVersion: trim(modelReview.protocolVersion),
      linePatches: list(modelReview.linePatches),
      sourceSnapshot: typeof result?.sourceSnapshot === 'string' ? result.sourceSnapshot : '',
      sourceKind: trim(result?.repairTarget?.sourceKind),
      sourceSessionId: trim(result?.repairTarget?.sourceSessionId),
      targetSessionId: trim(result?.repairTarget?.targetSessionId),
      turnId: trim(result?.repairTarget?.turnId),
      sourceMessageIds: normalizeStringList(result?.repairTarget?.sourceMessageIds),
      formatTarget: trim(result?.formatProfile?.target),
      formatSourceIds: normalizeStringList(
        result?.formatProfile?.formatSpecSourceIds ||
        result?.formatProfile?.enabledFormatIds,
      ),
      reviewWarning: modelReview.sourceTruncationSuspected === true
        ? '正文疑似严重截断，可考虑重新生成'
        : '',
      fallbackTime: trim(result?.repairFallbackTime || message?.time),
      fixedWarnings: issues.map(issue => trim(issue?.message)).filter(Boolean).slice(0, 6),
      eventCount: list(result?.eventDrafts).length,
      issueCount: issues.length,
    };
  }
  return null;
};

const shouldEmitChatFormatGuardianPart = (result = {}, options = {}) => {
  if (!result || result.status === 'no_events') return false;
  if (result.status === 'ready' && options.showSucceededPreview !== true) return false;
  return true;
};

const shouldEmitChatBodyQualityPart = (result = {}, options = {}) => {
  if (!result) return false;
  if (result.status === CHAT_BODY_QUALITY_STATUSES.ready && options.showSucceededPreview !== true) return false;
  return true;
};

export const resolveChatFormatGuardianInputText = (message = {}) => {
  const candidates = [
    ['rawOriginal', message?.rawOriginal],
    ['rawSource', message?.rawSource],
    ['raw_source', message?.raw_source],
    ['raw', message?.raw],
    ['content', message?.content],
    ['text', message?.text],
  ];
  const rawOriginalText = String(message?.rawOriginal ?? '');
  for (const [source, value] of candidates) {
    if (typeof value !== 'string') continue;
    if (value.trim()) {
      return {
        text: value,
        source,
        hasRawOriginal: Boolean(rawOriginalText.trim()),
      };
    }
  }
  return {
    text: '',
    source: '',
    hasRawOriginal: Boolean(rawOriginalText.trim()),
  };
};

export const buildChatFormatGuardianMessagePart = ({
  result = null,
  message = {},
  sessionId = '',
  autoRepairResult = null,
  autoApplyRepair = false,
  showSucceededPreview = false,
  maxEvents = 5,
  maxIssues = 6,
  now = Date.now,
} = {}) => {
  if (!shouldEmitChatFormatGuardianPart(result, { showSucceededPreview })) return null;
  const events = list(result?.eventDrafts);
  const errors = list(result?.errors).map(item => trim(item)).filter(Boolean);
  const warnings = list(result?.warnings).map(item => trim(item)).filter(Boolean);
  const status = getChatFormatGuardianStatus(result?.status);
  const at = toTimestamp(now);
  const sourceMessageId = trim(result?.sourceMessageId || message?.id || sessionId, 'message');
  const runId = buildChatFormatGuardianRunId({ result, message, sessionId });
  const eventCount = events.length;
  const issueCount = errors.length + warnings.length;
  const repairCandidate = resolveChatFormatGuardianRepairCandidate({ result, message });
  const decisionActions = buildChatFormatGuardianDecisionActions({
    result,
    errors,
    warnings,
    repairCandidate,
    includeRepairText: true,
  });
  const summary = [
    `${eventCount} event draft${eventCount === 1 ? '' : 's'}`,
    `${errors.length} error${errors.length === 1 ? '' : 's'}`,
    `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
  ].join(' · ');
  return {
    id: `chat-format-guardian:${sourceMessageId}`,
    type: 'agent_status',
    runId,
    source: CHAT_FORMAT_GUARDIAN_SOURCE,
    kind: 'chat_format.validate',
    status,
    title: getChatFormatGuardianTitle(result),
    summary: result?.summary || summary,
    createdAt: at,
    updatedAt: at,
    errorMessage: status === 'failed' ? trim(errors[0]) : '',
    metadata: {
      sessionId: trim(sessionId),
      sourceMessageId,
      status: trim(result?.status),
      sourceTextKind: trim(result?.sourceTextKind),
      hasRawOriginal: result?.hasRawOriginal === true,
      modelReview: summarizeChatFormatModelReview(result?.modelReview, { includeText: false }),
      modelReviewDetail: summarizeChatFormatModelReviewDetail(result?.modelReview),
      autoRepair: summarizeChatFormatAutoRepairResult(autoRepairResult, { autoApplyRepair }),
      repairCandidate: summarizeChatFormatRepairCandidate(repairCandidate, { includeText: true }),
      eventCount,
      issueCount,
      countsByType: countBy(events, event => event?.type),
      commitReady: result?.status === 'ready',
      decisionActions,
      inputSuggestion: decisionActions.find(action => action.id === 'edit_user_input_suggestion')?.suggestion || '',
      errors: errors.slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 6))),
      warnings: warnings.slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 6))),
      events: events
        .slice(0, Math.max(0, Math.trunc(Number(maxEvents) || 5)))
        .map(event => ({
          type: trim(event?.type),
          surface: trim(event?.surface),
          targetId: trim(event?.targetId),
          targetName: trim(event?.targetName),
          speakerId: trim(event?.speakerId),
          speakerName: trim(event?.speakerName),
          time: trim(event?.time),
          contentPreview: truncate(event?.content, 96),
          commitReady: list(event?.warnings).length === 0,
          warnings: list(event?.warnings).map(item => trim(item)).filter(Boolean).slice(0, 4),
        })),
    },
  };
};

const summarizeChatBodyQualityPatchCandidate = (patchCandidate = null, { includeText = false } = {}) => {
  if (!patchCandidate?.available) return null;
  const summary = {
    available: true,
    id: trim(patchCandidate.id),
    title: trim(patchCandidate.title, '正文优化候选'),
    summary: trim(patchCandidate.summary),
    risk: trim(patchCandidate.risk, 'low'),
    confidence: Number(patchCandidate.confidence || 0) || 0,
    preview: truncate(patchCandidate.preview, 220),
    operations: Array.isArray(patchCandidate.operations)
      ? patchCandidate.operations.map(operation => ({
        type: trim(operation?.type),
        count: Number(operation?.count || 0) || 0,
      })).filter(operation => operation.type)
      : [],
  };
  if (includeText) summary.replacementText = String(patchCandidate.replacementText || '');
  return summary;
};

const summarizeChatBodyQualityIssues = (issues = [], maxIssues = 6) => (
  list(issues)
    .slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 6)))
    .map(issue => ({
      id: trim(issue?.id),
      severity: trim(issue?.severity, 'warning'),
      title: trim(issue?.title, '正文质量问题'),
      summary: trim(issue?.summary),
      risk: trim(issue?.risk, 'medium'),
      confidence: Number(issue?.confidence || 0) || 0,
      patchable: issue?.patchable === true,
    }))
);

const buildChatBodyQualityDecisionActions = (result = {}, { includePatchText = false } = {}) => {
  if (!result || result.status === CHAT_BODY_QUALITY_STATUSES.ready) return [];
  const patchCandidate = summarizeChatBodyQualityPatchCandidate(result?.patchCandidate, { includeText: includePatchText });
  const actions = [];
  if (
    result.status === CHAT_BODY_QUALITY_STATUSES.minorIssues &&
    patchCandidate?.available &&
    patchCandidate.risk === 'low'
  ) {
    actions.push({
      id: 'apply_body_patch',
      label: '应用优化',
      enabled: true,
      description: patchCandidate.summary || '应用低风险正文清理。',
      patchCandidate,
    });
  }
  actions.push(
    {
      id: 'review_original',
      label: '查看原文',
      enabled: true,
      description: '查看这次 AI 回复的原始内容。',
    },
    {
      id: 'open_agent_center',
      label: 'Agent Center',
      enabled: true,
      description: '在 Agent Center 活动页查看正文诊断摘要。',
    },
  );
  return actions;
};

export const buildChatBodyQualityMessagePart = ({
  result = null,
  message = {},
  sessionId = '',
  showSucceededPreview = false,
  maxIssues = 6,
  now = Date.now,
} = {}) => {
  if (!shouldEmitChatBodyQualityPart(result, { showSucceededPreview })) return null;
  const issues = summarizeChatBodyQualityIssues(result?.issues, maxIssues);
  const status = getChatBodyQualityStatus(result?.status);
  const at = toTimestamp(now);
  const sourceMessageId = trim(result?.sourceMessageId || message?.id || sessionId, 'message');
  const runId = buildChatBodyQualityRunId({ result, message, sessionId });
  const patchCandidate = summarizeChatBodyQualityPatchCandidate(result?.patchCandidate);
  const issueText = `${Number(result?.issueCount || issues.length || 0)} issue${Number(result?.issueCount || issues.length || 0) === 1 ? '' : 's'}`;
  return {
    id: `chat-body-quality:${sourceMessageId}`,
    type: 'agent_status',
    runId,
    source: CHAT_BODY_QUALITY_SOURCE,
    kind: 'chat_body_quality.review',
    status,
    title: getChatBodyQualityTitle(result?.status),
    summary: result?.summary || issueText,
    createdAt: at,
    updatedAt: at,
    errorMessage: status === 'failed' ? trim(issues[0]?.summary || issues[0]?.title) : '',
    metadata: {
      sessionId: trim(sessionId),
      surface: 'chat',
      sourceMessageId,
      status: trim(result?.status),
      sourceTextKind: trim(result?.sourceTextKind),
      hasRawOriginal: result?.hasRawOriginal === true,
      issueCount: Number(result?.issueCount || issues.length || 0) || 0,
      issues,
      patchCandidate,
      recommendedActions: Array.isArray(result?.recommendedActions)
        ? result.recommendedActions.map(action => ({
          id: trim(action?.id),
          label: trim(action?.label || action?.id),
          enabled: action?.enabled !== false,
          description: trim(action?.description),
        })).filter(action => action.id)
        : [],
      decisionActions: buildChatBodyQualityDecisionActions(result, { includePatchText: false }),
      textPreview: truncate(result?.textPreview, 160),
      displayPreview: truncate(result?.displayPreview, 160),
    },
  };
};

export const buildChatFormatGuardianAgentRun = ({
  result = null,
  part = null,
  message = {},
  sessionId = '',
  autoRepairResult = null,
  autoApplyRepair = false,
  showSucceededRun = true,
  maxEvents = 5,
  maxIssues = 6,
  now = Date.now,
} = {}) => {
  if (!result || result.status === 'no_events') return null;
  if (result.status === 'ready' && showSucceededRun !== true) return null;
  const events = list(result?.eventDrafts);
  const errors = list(result?.errors).map(item => trim(item)).filter(Boolean);
  const warnings = list(result?.warnings).map(item => trim(item)).filter(Boolean);
  const status = getChatFormatGuardianStatus(result?.status);
  const at = toTimestamp(now);
  const sourceMessageId = trim(result?.sourceMessageId || message?.id || sessionId, 'message');
  const runId = part?.runId || buildChatFormatGuardianRunId({ result, message, sessionId });
  const eventCount = events.length;
  const issueCount = errors.length + warnings.length;
  const summary = trim(result?.summary) || trim(part?.summary) || `${eventCount} event draft(s), ${errors.length} error(s), ${warnings.length} warning(s)`;
  const surface = resolveChatFormatGuardianSurface(events);
  const repairCandidate = resolveChatFormatGuardianRepairCandidate({ result, message });
  const decisionActions = buildChatFormatGuardianDecisionActions({
    result,
    errors,
    warnings,
    repairCandidate,
    includeRepairText: false,
  });
  const limitedEvents = events
    .slice(0, Math.max(0, Math.trunc(Number(maxEvents) || 5)))
    .map(event => ({
      type: trim(event?.type),
      surface: trim(event?.surface),
      targetId: trim(event?.targetId),
      targetName: trim(event?.targetName),
      speakerId: trim(event?.speakerId),
      speakerName: trim(event?.speakerName),
      time: trim(event?.time),
      contentPreview: truncate(event?.content, 96),
      warnings: list(event?.warnings).map(item => trim(item)).filter(Boolean).slice(0, 4),
    }));
  const metadata = {
    sessionId: trim(sessionId),
    sourceMessageId,
    sourceMessageRole: trim(message?.role),
    protocolParseFailure: message?.meta?.protocolParseFailure === true,
    rawStatus: trim(result?.status),
    sourceTextKind: trim(result?.sourceTextKind),
    hasRawOriginal: result?.hasRawOriginal === true,
    modelReview: summarizeChatFormatModelReview(result?.modelReview, { includeText: false }),
    modelReviewDetail: summarizeChatFormatModelReviewDetail(result?.modelReview),
    autoRepair: summarizeChatFormatAutoRepairResult(autoRepairResult, { autoApplyRepair }),
    repairCandidate: summarizeChatFormatRepairCandidate(repairCandidate, { includeText: false }),
    eventCount,
    issueCount,
    countsByType: countBy(events, event => event?.type),
    commitReady: result?.status === 'ready',
    decisionActions,
    inputSuggestion: decisionActions.find(action => action.id === 'edit_user_input_suggestion')?.suggestion || '',
    errors: errors.slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 6))),
    warnings: warnings.slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 6))),
    events: limitedEvents,
  };
  return {
    id: runId,
    kind: CHAT_FORMAT_GUARDIAN_KIND,
    title: getChatFormatGuardianTitle(result),
    sessionId: trim(sessionId),
    surface,
    trigger: 'after_receive',
    source: CHAT_FORMAT_GUARDIAN_SOURCE,
    status,
    summary,
    errorMessage: status === 'failed' ? trim(errors[0]) : '',
    exportable: true,
    metadata,
    steps: [{
      id: `${runId}:validate`,
      runId,
      type: 'chat_format.validate',
      title: getChatFormatGuardianTitle(result),
      status,
      summary,
      input: {
        sourceMessageId,
        messageRole: trim(message?.role),
        sourceTextKind: trim(result?.sourceTextKind),
        hasRawOriginal: result?.hasRawOriginal === true,
      },
      output: metadata,
      metadata: {
        eventCount,
        issueCount,
        commitReady: result?.status === 'ready',
      },
      errorMessage: status === 'failed' ? trim(errors[0]) : '',
      startedAt: at,
      updatedAt: at,
      finishedAt: status === 'waiting_permission' ? null : at,
    }],
    toolCalls: [],
    createdAt: at,
    updatedAt: at,
    finishedAt: status === 'waiting_permission' ? null : at,
  };
};

export const buildChatBodyQualityAgentRun = ({
  result = null,
  part = null,
  message = {},
  sessionId = '',
  showSucceededRun = false,
  maxIssues = 6,
  now = Date.now,
} = {}) => {
  if (!result) return null;
  if (result.status === CHAT_BODY_QUALITY_STATUSES.ready && showSucceededRun !== true) return null;
  const issues = summarizeChatBodyQualityIssues(result?.issues, maxIssues);
  const status = getChatBodyQualityStatus(result?.status);
  const at = toTimestamp(now);
  const sourceMessageId = trim(result?.sourceMessageId || message?.id || sessionId, 'message');
  const runId = part?.runId || buildChatBodyQualityRunId({ result, message, sessionId });
  const patchCandidate = summarizeChatBodyQualityPatchCandidate(result?.patchCandidate);
  const issueCount = Number(result?.issueCount || issues.length || 0) || 0;
  const summary = trim(result?.summary) || `${issueCount} body quality issue(s)`;
  const metadata = {
    sessionId: trim(sessionId),
    surface: 'chat',
    sourceMessageId,
    sourceMessageRole: trim(message?.role),
    rawStatus: trim(result?.status),
    sourceTextKind: trim(result?.sourceTextKind),
    hasRawOriginal: result?.hasRawOriginal === true,
    issueCount,
    issues,
    patchCandidate,
    recommendedActions: Array.isArray(result?.recommendedActions)
      ? result.recommendedActions.map(action => ({
        id: trim(action?.id),
        label: trim(action?.label || action?.id),
        enabled: action?.enabled !== false,
        description: trim(action?.description),
      })).filter(action => action.id)
      : [],
    decisionActions: buildChatBodyQualityDecisionActions(result),
    textPreview: truncate(result?.textPreview, 160),
    displayPreview: truncate(result?.displayPreview, 160),
  };
  return {
    id: runId,
    kind: CHAT_BODY_QUALITY_KIND,
    title: getChatBodyQualityTitle(result?.status),
    sessionId: trim(sessionId),
    surface: 'chat',
    trigger: 'after_receive',
    source: CHAT_BODY_QUALITY_SOURCE,
    status,
    summary,
    errorMessage: status === 'failed' ? trim(issues[0]?.summary || issues[0]?.title) : '',
    exportable: true,
    metadata,
    steps: [{
      id: `${runId}:review`,
      runId,
      type: 'chat_body_quality.review',
      title: getChatBodyQualityTitle(result?.status),
      status,
      summary,
      input: {
        sourceMessageId,
        messageRole: trim(message?.role),
        sourceTextKind: trim(result?.sourceTextKind),
        hasRawOriginal: result?.hasRawOriginal === true,
      },
      output: metadata,
      metadata: {
        issueCount,
        patchAvailable: patchCandidate?.available === true,
      },
      errorMessage: status === 'failed' ? trim(issues[0]?.summary || issues[0]?.title) : '',
      startedAt: at,
      updatedAt: at,
      finishedAt: status === 'waiting_permission' ? null : at,
    }],
    toolCalls: [],
    createdAt: at,
    updatedAt: at,
    finishedAt: status === 'waiting_permission' ? null : at,
  };
};

export const buildChatFormatGuardianPreviewMessage = (message = {}, part = null) => {
  if (!message || typeof message !== 'object' || !part) return null;
  const meta = isPlainObject(message.meta) ? { ...message.meta } : {};
  return {
    ...message,
    meta: {
      ...meta,
      agentMessageParts: mergeAgentMessageParts(meta.agentMessageParts, [part]),
    },
  };
};

const normalizeChatFormatGuardianModelOptions = (options = {}) => {
  const raw = options?.modelReview === true
    ? { enabled: true }
    : (isPlainObject(options?.modelReview) ? { ...options.modelReview } : null);
  if (!raw?.enabled) return null;
  if (typeof raw.backgroundChat !== 'function') return null;
  return raw;
};

const shouldRunChatFormatGuardianModelReview = (parserResult = null, modelOptions = null) => {
  if (!modelOptions) return false;
  if (modelOptions.force === true) return true;
  const status = trim(parserResult?.status);
  if (status === 'needs_review' || status === 'invalid') return true;
  if (status === 'no_events') return modelOptions.reviewNoEvents === true;
  return false;
};

const hasVisibleAssistantOutput = (message = {}) => [
  message?.content,
  message?.text,
  message?.display,
  message?.displayText,
].some(value => typeof value === 'string' && value.trim());

const isManualChatFormatGuardianCheck = (options = {}) => options?.manualTrigger === true;

const shouldRunChatFormatGuardianModelReviewForContext = ({
  parserResult = null,
  modelOptions = null,
  message = null,
  options = {},
} = {}) => {
  if (!shouldRunChatFormatGuardianModelReview(parserResult, modelOptions)) return false;
  if (modelOptions?.force === true) return true;
  if (isManualChatFormatGuardianCheck(options)) return true;
  return !hasVisibleAssistantOutput(message);
};

const buildChatFormatGuardianModelResult = ({
  review = null,
  parserResult = null,
  message = {},
  options = {},
  formatProfile = null,
} = {}) => {
  const issues = list(review?.issues);
  const errors = issues
    .filter(issue => trim(issue?.severity).toLowerCase() === 'error')
    .map(issue => trim(issue?.message))
    .filter(Boolean);
  const warnings = issues
    .filter(issue => trim(issue?.severity).toLowerCase() !== 'error')
    .map(issue => trim(issue?.message))
    .filter(Boolean);
  const reviewStatus = trim(review?.status);
  const status = reviewStatus === 'no_change'
    ? 'ready'
    : (reviewStatus === 'patch' && review?.canRepair === true
      ? 'needs_review'
      : (['needs_format_spec', 'cannot_repair', 'invalid_output'].includes(reviewStatus)
        ? reviewStatus
        : 'invalid_output'));
  return {
    ...(isPlainObject(parserResult) ? parserResult : {}),
    status,
    summary: status === 'ready'
      ? '模型格式检查通过'
      : status === 'needs_format_spec'
        ? '缺少足够的格式规范'
        : status === 'cannot_repair'
          ? '无法在不编造正文的前提下安全修复'
          : isChatFormatGuardianCheckIncomplete(review)
        ? '格式检查未完成'
        : (review?.canRepair ? '模型发现可修复格式问题' : '模型发现格式问题'),
    errors,
    warnings,
    sourceMessageId: trim(message?.id || options?.sourceMessageId),
    sourceTextKind: trim(parserResult?.sourceTextKind),
    hasRawOriginal: parserResult?.hasRawOriginal === true,
    repairFallbackTime: trim(options?.repairFallbackTime || parserResult?.repairFallbackTime || message?.time),
    baseRevision: trim(options?.baseRevision || review?.baseRevision),
    sourceSnapshot: typeof options?.sourceSnapshot === 'string'
      ? options.sourceSnapshot
      : '',
    repairTarget: isPlainObject(options?.repairTarget) ? { ...options.repairTarget } : null,
    formatProfile: isPlainObject(formatProfile) ? {
      target: trim(formatProfile.target),
      requestedTarget: trim(formatProfile.requestedTarget),
      enabledFormatIds: normalizeStringList(formatProfile.enabledFormatIds),
      formatSpecSourceIds: normalizeStringList(
        formatProfile.formatSpecSourceIds ||
        formatProfile.enabledFormatIds,
      ),
    } : null,
    modelReview: review,
  };
};

const buildChatFormatGuardianModelFailureResult = ({
  error = null,
  parserResult = null,
  message = {},
  options = {},
} = {}) => {
  const errorMessage = trim(error?.message || error, '格式修复请求失败');
  return {
    ...(isPlainObject(parserResult) ? parserResult : {}),
    status: 'invalid_output',
    summary: '格式修复请求失败',
    errors: [errorMessage],
    warnings: [],
    sourceMessageId: trim(message?.id || options?.sourceMessageId),
    sourceTextKind: trim(parserResult?.sourceTextKind),
    hasRawOriginal: parserResult?.hasRawOriginal === true,
    repairFallbackTime: trim(options?.repairFallbackTime || parserResult?.repairFallbackTime || message?.time),
    baseRevision: trim(options?.baseRevision),
    sourceSnapshot: typeof options?.sourceSnapshot === 'string'
      ? options.sourceSnapshot
      : '',
    repairTarget: isPlainObject(options?.repairTarget) ? { ...options.repairTarget } : null,
    modelReview: {
      ok: false,
      protocolVersion: 'format_patch.v1',
      status: 'invalid_output',
      baseRevision: trim(options?.baseRevision),
      issues: [{
        severity: 'error',
        type: error?.code === 'CHAT_FORMAT_GUARDIAN_TIMEOUT' ? 'timeout' : 'request_error',
        message: errorMessage,
        evidence: '',
      }],
      canRepair: false,
      repairSummary: errorMessage,
      candidateText: '',
      linePatches: [],
      validationErrors: [],
      rawPreview: '',
    },
  };
};

const runChatFormatGuardianBackgroundChatOnce = async (backgroundChat, messages = [], requestOptions = {}, {
  timeoutMs = 75000,
} = {}) => {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0 || typeof AbortController !== 'function') {
    return backgroundChat(messages, requestOptions || {});
  }
  const controller = new AbortController();
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try { controller.abort(); } catch {}
      const error = new Error(`格式修复请求超时（${Math.round(ms / 1000)} 秒）`);
      error.code = 'CHAT_FORMAT_GUARDIAN_TIMEOUT';
      reject(error);
    }, ms);
  });
  const nextOptions = {
    ...(requestOptions || {}),
    signal: requestOptions?.signal || controller.signal,
  };
  try {
    return await Promise.race([
      backgroundChat(messages, nextOptions),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      try { clearTimeout(timeoutId); } catch {}
    }
  }
};

export const runChatFormatGuardianBackgroundChat = async (backgroundChat, messages = [], requestOptions = {}, timing = {}) => {
  try {
    return await runChatFormatGuardianBackgroundChatOnce(backgroundChat, messages, requestOptions, timing);
  } catch (err) {
    // 部分模型不接受 temperature 等采样参数；剥掉后重试一次，避免修复链路对特定模型直接失败。
    const message = String(err?.message || '');
    const options = requestOptions || {};
    if (/temperature/i.test(message) && Object.prototype.hasOwnProperty.call(options, 'temperature')) {
      const { temperature: _temperature, ...rest } = options;
      return runChatFormatGuardianBackgroundChatOnce(backgroundChat, messages, rest, timing);
    }
    throw err;
  }
};

export const selectChatFormatReminderTextForProfile = (modelOptions = {}, profile = {}) => {
  const sections = Array.isArray(modelOptions?.formatReminderSections)
    ? modelOptions.formatReminderSections
    : [];
  const enabledIds = new Set(Array.isArray(profile?.enabledFormatIds) ? profile.enabledFormatIds : []);
  const target = trim(profile?.target);
  if (sections.length) {
    return sections
      .filter((section) => {
        const ids = normalizeStringList(section?.formatIds);
        const targets = normalizeStringList(section?.targets);
        if (ids.some(id => enabledIds.has(id))) return true;
        return target && targets.includes(target);
      })
      .map(section => trim(section?.content || section?.text))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 12000);
  }
  return enabledIds.size ? trim(modelOptions?.formatReminderText).slice(0, 12000) : '';
};

const isSocialFormatRepairTarget = ({
  options = {},
  modelOptions = {},
  formatProfile = {},
} = {}) => {
  const sourceKind = trim(options?.repairTarget?.sourceKind);
  if (sourceKind === 'social_turn_raw') return true;
  if (sourceKind === 'creative_raw_original') return false;
  const uiMode = trim(modelOptions?.uiMode || options?.uiMode).toLowerCase();
  const target = trim(formatProfile?.target || modelOptions?.formatTarget || options?.formatTarget).toLowerCase();
  if (uiMode === 'rp' || ['creative_text', 'forum'].includes(target)) return false;
  return true;
};

export const validateChatFormatGuardianRepairCandidate = ({
  review = null,
  inputText = '',
  options = {},
  modelOptions = {},
  formatProfile = {},
} = {}) => {
  if (trim(review?.status) !== 'patch' || review?.canRepair !== true) {
    return {
      applicable: false,
      ok: true,
      status: 'not_applicable',
      parserReport: null,
    };
  }
  if (!isSocialFormatRepairTarget({ options, modelOptions, formatProfile })) {
    return {
      applicable: false,
      ok: true,
      status: 'creative_writeback_allowed',
      parserReport: null,
    };
  }
  const candidateText = String(review?.candidateText ?? inputText ?? '');
  const parserReport = extractChatFormatEventDrafts(candidateText, {
    ...options,
    enabledFormats: formatProfile?.enabledFormats || modelOptions?.enabledFormats || options?.enabledFormats,
    customFormatGuide: modelOptions?.customFormatGuide || options?.customFormatGuide || '',
    sourceMessageId: trim(options?.sourceMessageId),
  });
  const ok = parserReport.status === 'ready';
  return {
    applicable: true,
    ok,
    status: ok ? 'ready' : 'format_recheck_failed',
    parserReport: {
      status: trim(parserReport.status),
      summary: trim(parserReport.summary),
      eventCount: list(parserReport.eventDrafts).length,
      errors: normalizeStringList(parserReport.errors).slice(0, 8),
      warnings: normalizeStringList(parserReport.warnings).slice(0, 8),
    },
  };
};

const serializeChatFormatGuardianRetryRaw = (raw) => {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw || {});
  return text.length > 12000
    ? `${text.slice(0, 12000)}\n${getGuardianPromptLine('format_guardian.retry.truncated')}`
    : text;
};

export const buildChatFormatGuardianRetryInstruction = ({
  raw = '',
  review = null,
  domainValidation = null,
} = {}) => {
  const validationErrors = list(review?.validationErrors)
    .map(item => ({
      code: trim(item?.code),
      message: trim(item?.message),
      patchIndex: Number.isInteger(item?.patchIndex) ? item.patchIndex : null,
    }));
  const parserReport = isPlainObject(domainValidation?.parserReport)
    ? domainValidation.parserReport
    : null;
  return [
    '# Retry Required',
    getGuardianPromptLine('format_guardian.retry.failed'),
    getGuardianPromptLine('format_guardian.retry.instruction'),
    `${getGuardianPromptLine('format_guardian.retry.previous')}\n${serializeChatFormatGuardianRetryRaw(raw) || getLocalizedPromptText('format_guardian.user.empty')}`,
    validationErrors.length
      ? `${getGuardianPromptLine('format_guardian.retry.patch_errors')}\n${JSON.stringify(validationErrors, null, 2)}`
      : '',
    parserReport
      ? `${getGuardianPromptLine('format_guardian.retry.recheck')}\n${JSON.stringify(parserReport, null, 2)}`
      : '',
    getGuardianPromptLine('format_guardian.retry.json_only'),
  ].filter(Boolean).join('\n\n');
};

const buildChatFormatGuardianDomainFailureReview = ({
  review = null,
  domainValidation = null,
  attemptCount = 2,
} = {}) => {
  const parserReport = domainValidation?.parserReport || {};
  const detail = [
    ...normalizeStringList(parserReport.errors),
    ...normalizeStringList(parserReport.warnings),
  ][0] || '修复后仍无法通过完整格式复查';
  return {
    ...(isPlainObject(review) ? review : {}),
    ok: true,
    status: 'cannot_repair',
    canRepair: false,
    repairSummary: `已重试 ${attemptCount} 次，但修复后仍无法安全分发；建议重新生成。`,
    candidateText: '',
    linePatches: [],
    issues: [{
      severity: 'error',
      type: 'parse_error',
      message: detail,
      evidence: '',
    }],
    domainValidation,
    attemptCount,
  };
};

export const validateChatFormatGuardianFunctionPayloads = ({
  review = null,
  inputText = '',
} = {}) => {
  if (trim(review?.status) !== 'patch' || review?.canRepair !== true) return review;
  const validation = validateFormatRepairFunctionPayloads({
    originalText: inputText,
    candidateText: String(review?.candidateText || ''),
  });
  if (validation.ok) {
    return {
      ...review,
      functionPayloadValidation: {
        ok: true,
        beforeBlockCount: validation.beforeBlocks.length,
        afterBlockCount: validation.afterBlocks.length,
        violations: [],
      },
    };
  }
  const validationErrors = validation.violations.map(item => ({
    code: item.code,
    message: item.message,
  }));
  return {
    ...review,
    ok: false,
    status: 'invalid_output',
    canRepair: false,
    repairSummary: '',
    candidateText: '',
    linePatches: [],
    validationErrors: [
      ...list(review?.validationErrors),
      ...validationErrors,
    ],
    issues: validation.violations.map(item => ({
      severity: 'error',
      type: 'other',
      message: item.message,
      evidence: item.identity,
    })),
    functionPayloadValidation: {
      ok: false,
      beforeBlockCount: validation.beforeBlocks.length,
      afterBlockCount: validation.afterBlocks.length,
      violations: validation.violations,
    },
  };
};

const emitChatFormatGuardianModelReviewResult = ({
  message = null,
  sessionId = '',
  result = null,
  part = null,
  autoRepairResult = null,
  options = {},
  modelOptions = null,
  onChatFormatGuardianPreview = null,
  onChatFormatGuardianRun = null,
  now = Date.now,
} = {}) => {
  const resolvedPart = part || buildChatFormatGuardianMessagePart({
    result,
    message,
    sessionId,
    autoRepairResult,
    autoApplyRepair: false,
    showSucceededPreview: modelOptions?.showSucceededPreview === true,
    maxEvents: options.maxEvents,
    maxIssues: options.maxIssues,
    now,
  });
  const patchedMessage = buildChatFormatGuardianPreviewMessage(message, resolvedPart);
  const agentRun = buildChatFormatGuardianAgentRun({
    result,
    part: resolvedPart,
    message,
    sessionId,
    autoRepairResult,
    autoApplyRepair: false,
    showSucceededRun: modelOptions?.recordSucceededRun === true,
    maxEvents: options.maxEvents,
    maxIssues: options.maxIssues,
    now,
  });
  if (patchedMessage && typeof onChatFormatGuardianPreview === 'function') {
    onChatFormatGuardianPreview({ message, patchedMessage, result, part: resolvedPart, agentRun, sessionId, autoRepairResult });
  }
  if (agentRun && typeof onChatFormatGuardianRun === 'function') {
    onChatFormatGuardianRun({ message, patchedMessage, result, part: resolvedPart, agentRun, sessionId, autoRepairResult });
  }
  return { part: resolvedPart, patchedMessage, agentRun };
};

const scheduleChatFormatGuardianModelReview = ({
  message = null,
  sessionId = '',
  parserResult = null,
  inputText = '',
  options = {},
  modelOptions = null,
  onChatFormatGuardianPreview = null,
  onChatFormatGuardianRun = null,
  onChatFormatGuardianModelReviewQueued = null,
  onChatFormatGuardianModelReviewCompleted = null,
  onChatFormatGuardianAutoRepair = null,
  logger = console,
  now = Date.now,
} = {}) => {
  if (!message || !shouldRunChatFormatGuardianModelReviewForContext({
    parserResult,
    modelOptions,
    message,
    options,
  })) return false;
  if (typeof onChatFormatGuardianModelReviewQueued === 'function') {
    try {
      onChatFormatGuardianModelReviewQueued({ message, sessionId, result: parserResult, inputText });
    } catch (err) {
      logger?.warn?.('chat format guardian queued notification failed', err);
    }
  }
  Promise.resolve().then(async () => {
    const formatProfile = resolveChatFormatGuardianFormatProfile({
      target: modelOptions.formatTarget || options.formatTarget,
      uiMode: modelOptions.uiMode || options.uiMode,
      surface: modelOptions.surface || options.surface || resolveChatFormatGuardianSurface(parserResult?.eventDrafts),
      isGroupChat: modelOptions.isGroupChat === true || options.isGroupChat === true,
      assistantText: inputText,
      parserResult,
      enabledFormats: modelOptions.enabledFormats,
    });
    const formatReminderText = selectChatFormatReminderTextForProfile(modelOptions, formatProfile);
    const customFormatGuide = modelOptions.customFormatGuide || options.customFormatGuide || '';
    const resolvedFormatProfile = {
      ...formatProfile,
      formatSpecSourceIds: [
        ...formatProfile.enabledFormatIds,
        ...(formatReminderText ? ['sceneFormatReminder'] : []),
        ...(customFormatGuide ? ['customFormatGuide'] : []),
      ],
    };
    const referenceSignal = modelOptions.requestOptions?.signal || modelOptions.signal || options.signal;
    const checkReferenceSignal = () => {
      if (referenceSignal?.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
    };
    checkReferenceSignal();
    const referenceContext = typeof modelOptions.resolveReferenceContext === 'function'
      ? await modelOptions.resolveReferenceContext({
        targetMessageId: options.repairTarget?.sourceMessageId || parserResult?.sourceMessageId || message.id,
        signal: referenceSignal,
      }) : modelOptions.referenceContext;
    checkReferenceSignal();
    const prompt = buildChatFormatGuardianModelPrompt({
      assistantText: inputText,
      agentConfig: modelOptions.agentConfig, referenceContext,
      formatReminderText,
      customFormatGuide,
      enabledFormats: formatProfile.enabledFormats,
      parserReport: parserResult,
      userName: modelOptions.userName || options.userName,
      sessionLabel: modelOptions.sessionLabel,
      surface: modelOptions.surface || resolveChatFormatGuardianSurface(parserResult?.eventDrafts),
      formatTarget: formatProfile.target,
      baseRevision: options.baseRevision,
      repairTarget: options.repairTarget,
    });
    const requestReview = async (messages) => {
      checkReferenceSignal();
      const raw = await runChatFormatGuardianBackgroundChat(
        modelOptions.backgroundChat,
        messages,
        { ...(modelOptions.requestOptions || {
          temperature: 0,
          maxTokens: FORMAT_PATCH_MODEL_MAX_TOKENS,
        }), ...(referenceSignal ? { signal: referenceSignal } : {}) },
        { timeoutMs: modelOptions.timeoutMs },
      );
      checkReferenceSignal();
      const normalizedReview = normalizeChatFormatGuardianModelReview(raw, {
        originalText: inputText,
        baseRevision: options.baseRevision,
      });
      const review = validateChatFormatGuardianFunctionPayloads({
        review: normalizedReview,
        inputText,
      });
      const domainValidation = validateChatFormatGuardianRepairCandidate({
        review,
        inputText,
        options,
        modelOptions,
        formatProfile: resolvedFormatProfile,
      });
      return { raw, review, domainValidation };
    };
    let attempt = await requestReview(prompt.messages);
    const shouldRetry = attempt.review?.status === 'invalid_output' ||
      (attempt.domainValidation?.applicable === true && attempt.domainValidation.ok !== true);
    if (shouldRetry) {
      const retryInstruction = buildChatFormatGuardianRetryInstruction(attempt);
      attempt = await requestReview([
        ...prompt.messages,
        { role: 'user', content: retryInstruction },
      ]);
      attempt.review.attemptCount = 2;
    } else {
      attempt.review.attemptCount = 1;
    }
    attempt.review.domainValidation = attempt.domainValidation;
    let review = attempt.review;
    if (
      attempt.domainValidation?.applicable === true &&
      attempt.domainValidation.ok !== true &&
      review?.status !== 'invalid_output'
    ) {
      review = buildChatFormatGuardianDomainFailureReview({
        review,
        domainValidation: attempt.domainValidation,
        attemptCount: review.attemptCount,
      });
    }
    const result = buildChatFormatGuardianModelResult({
      review,
      parserResult,
      message,
      options,
      formatProfile: resolvedFormatProfile,
    });
    let autoRepairResult = null;
    // format_patch.v1 的所有 Agent 提案都必须由用户“同意一次”；不再后台自动写回。
    emitChatFormatGuardianModelReviewResult({
      message,
      sessionId,
      result,
      autoRepairResult,
      options,
      modelOptions,
      onChatFormatGuardianPreview,
      onChatFormatGuardianRun,
      now,
    });
    try {
      onChatFormatGuardianModelReviewCompleted?.({
        message,
        sessionId,
        result,
        failed: result?.status === 'invalid_output' || result?.status === 'cannot_repair',
      });
    } catch (err) {
      logger?.warn?.('chat format guardian completion notification failed', err);
    }
  }).catch((err) => {
    logger?.warn?.('chat format guardian model review failed', err);
    const result = buildChatFormatGuardianModelFailureResult({
      error: err,
      parserResult,
      message,
      options,
    });
    emitChatFormatGuardianModelReviewResult({
      message,
      sessionId,
      result,
      options,
      modelOptions,
      onChatFormatGuardianPreview,
      onChatFormatGuardianRun,
      now,
    });
    try {
      onChatFormatGuardianModelReviewCompleted?.({
        message,
        sessionId,
        result,
        failed: true,
        error: err,
      });
    } catch (notifyError) {
      logger?.warn?.('chat format guardian completion notification failed', notifyError);
    }
  });
  return true;
};

export const runChatFormatGuardianPreview = ({
  message = null,
  sessionId = '',
  chatFormatGuardian = null,
  onChatFormatGuardianPreview = null,
  onChatFormatGuardianRun = null,
  onChatFormatGuardianModelReviewQueued = null,
  onChatFormatGuardianModelReviewCompleted = null,
  onChatFormatGuardianAutoRepair = null,
  logger = console,
  now = Date.now,
} = {}) => {
  if (!message || message.role !== 'assistant' || !chatFormatGuardian) return null;
  const options = chatFormatGuardian === true
    ? { enabled: true }
    : (isPlainObject(chatFormatGuardian) ? { ...chatFormatGuardian } : {});
  if (options.enabled === false) return null;
  const input = resolveChatFormatGuardianInputText(message);
  const text = input.text;
  if (!trim(options.baseRevision)) options.baseRevision = createFormatPatchRevisionToken();
  if (typeof options.sourceSnapshot !== 'string') options.sourceSnapshot = text;
  const modelOptions = normalizeChatFormatGuardianModelOptions(options);
  const manualCheck = isManualChatFormatGuardianCheck(options);
  const visibleOutput = hasVisibleAssistantOutput(message);
  const noEventsSeedResult = { status: 'no_events' };
  if (!text && !shouldRunChatFormatGuardianModelReviewForContext({
    parserResult: noEventsSeedResult,
    modelOptions,
    message,
    options,
  })) return null;
  try {
    const sourceMessageId = trim(message.id || options.sourceMessageId);
    const result = text
      ? {
        ...extractChatFormatEventDrafts(text, {
          ...options,
          sourceMessageId,
        }),
        sourceTextKind: input.source,
        hasRawOriginal: input.hasRawOriginal,
        repairFallbackTime: trim(options.repairFallbackTime || message?.time),
      }
      : {
        ok: false,
        status: 'no_events',
        sourceMessageId,
        protocolEvents: [],
        eventDrafts: [],
        errors: [],
        warnings: [],
        summary: 'empty assistant response',
        textPreview: '',
        sourceTextKind: input.source,
        hasRawOriginal: input.hasRawOriginal,
        repairFallbackTime: trim(options.repairFallbackTime || message?.time),
      };
    result.baseRevision = trim(options.baseRevision);
    result.sourceSnapshot = options.sourceSnapshot;
    result.repairTarget = isPlainObject(options.repairTarget) ? { ...options.repairTarget } : null;
    const suppressAutomaticDiagnostics = !manualCheck && modelOptions?.force !== true && visibleOutput;
    const suppressLocalAutomaticPreview = !manualCheck;
    if (suppressAutomaticDiagnostics) {
      return { result, part: null, patchedMessage: null, agentRun: null };
    }
    const part = suppressLocalAutomaticPreview
      ? null
      : buildChatFormatGuardianMessagePart({
        result,
        message,
        sessionId,
        showSucceededPreview: options.showSucceededPreview === true,
        maxEvents: options.maxEvents,
        maxIssues: options.maxIssues,
        now,
      });
    const patchedMessage = suppressLocalAutomaticPreview
      ? null
      : buildChatFormatGuardianPreviewMessage(message, part);
    const agentRun = suppressLocalAutomaticPreview
      ? null
      : buildChatFormatGuardianAgentRun({
        result,
        part,
        message,
        sessionId,
        showSucceededRun: options.recordSucceededRun !== false,
        maxEvents: options.maxEvents,
        maxIssues: options.maxIssues,
        now,
      });
    if (patchedMessage && typeof onChatFormatGuardianPreview === 'function') {
      onChatFormatGuardianPreview({ message, patchedMessage, result, part, agentRun, sessionId });
    }
    if (agentRun && typeof onChatFormatGuardianRun === 'function') {
      onChatFormatGuardianRun({ message, patchedMessage, result, part, agentRun, sessionId });
    }
    const modelReviewQueued = scheduleChatFormatGuardianModelReview({
      message,
      sessionId,
      parserResult: result,
      inputText: text,
      options,
      modelOptions,
      onChatFormatGuardianPreview,
      onChatFormatGuardianRun,
      onChatFormatGuardianModelReviewQueued,
      onChatFormatGuardianModelReviewCompleted,
      onChatFormatGuardianAutoRepair,
      logger,
      now,
    });
    return { result, part, patchedMessage, agentRun, modelReviewQueued };
  } catch (err) {
    logger?.warn?.('chat format guardian preview failed', err);
    return null;
  }
};

export const runChatBodyQualityPreview = ({
  message = null,
  sessionId = '',
  chatBodyQualityGuardian = null,
  formatReport = null,
  onChatBodyQualityPreview = null,
  onChatBodyQualityRun = null,
  logger = console,
  now = Date.now,
} = {}) => {
  if (!message || message.role !== 'assistant' || !chatBodyQualityGuardian) return null;
  const options = chatBodyQualityGuardian === true
    ? { enabled: true }
    : (isPlainObject(chatBodyQualityGuardian) ? { ...chatBodyQualityGuardian } : {});
  if (options.enabled === false) return null;
  try {
    const result = {
      ...analyzeChatBodyQuality({
        message,
        formatReport,
        maxIssues: options.maxIssues,
      }),
      sourceMessageId: trim(message.id || options.sourceMessageId),
      summary: '',
    };
    result.summary = `${Number(result.issueCount || 0)} body quality issue(s)`;
    const part = buildChatBodyQualityMessagePart({
      result,
      message,
      sessionId,
      showSucceededPreview: options.showSucceededPreview === true,
      maxIssues: options.maxIssues,
      now,
    });
    const patchedMessage = buildChatFormatGuardianPreviewMessage(message, part);
    const agentRun = buildChatBodyQualityAgentRun({
      result,
      part,
      message,
      sessionId,
      showSucceededRun: options.recordSucceededRun === true,
      maxIssues: options.maxIssues,
      now,
    });
    if (patchedMessage && typeof onChatBodyQualityPreview === 'function') {
      onChatBodyQualityPreview({ message, patchedMessage, result, part, agentRun, sessionId });
    }
    if (agentRun && typeof onChatBodyQualityRun === 'function') {
      onChatBodyQualityRun({ message, patchedMessage, result, part, agentRun, sessionId });
    }
    return { result, part, patchedMessage, agentRun };
  } catch (err) {
    logger?.warn?.('chat body quality preview failed', err);
    return null;
  }
};

export const resolveAfterReceiveSkipScripts = (
  skipScriptsOverride,
  defaultSkipScripts = false,
) => (
  typeof skipScriptsOverride === 'boolean'
    ? skipScriptsOverride
    : Boolean(defaultSkipScripts)
);

const catchAsync = (maybePromise, onError) => {
  if (!maybePromise || typeof maybePromise.catch !== 'function') return;
  maybePromise.catch(onError);
};

export const dispatchAfterReceiveEffects = ({
  message,
  sessionId = '',
  skipScripts,
  skipPlugins = false,
  defaultSkipScripts = false,
  scriptRuntime = null,
  pluginRuntime = null,
  logger = console,
  applyUpdateVariable,
  handleVariableRules,
  onVariablesSettled = null,
  useGlobalVariables = false,
  recordTraceEvent = null,
  chatFormatGuardian = null,
  onChatFormatGuardianPreview = null,
  onChatFormatGuardianRun = null,
  onChatFormatGuardianModelReviewQueued = null,
  onChatFormatGuardianAutoRepair = null,
  chatBodyQualityGuardian = null,
  onChatBodyQualityPreview = null,
  onChatBodyQualityRun = null,
} = {}) => {
  if (!message || message.role !== 'assistant') return false;
  const shouldSkipScripts = resolveAfterReceiveSkipScripts(skipScripts, defaultSkipScripts);
  const payload = { message, sessionId };
  const dispatchRuntimeHook = ({ runtime = null, runtimeLabel = '' } = {}) => {
    if (!runtime) return;
    const messageId = String(message?.id || '').trim();
    emitHookLifecycleTrace(recordTraceEvent, buildAfterReceiveHookStartTraceEvent({
      runtimeLabel,
      sessionId,
      message,
    }));
    const result = runtime.dispatchEvent('message.after_receive', payload);
    catchAsync(result, err => {
      emitHookLifecycleTrace(recordTraceEvent, buildAfterReceiveHookFinishTraceEvent({
        runtimeLabel,
        sessionId,
        messageId,
        status: 'error',
        errorMessage: err?.message,
      }));
      logger?.warn?.(`${runtimeLabel} message.after_receive failed`, err);
    });
    emitHookLifecycleTrace(recordTraceEvent, buildAfterReceiveHookFinishTraceEvent({
      runtimeLabel,
      sessionId,
      messageId,
      status: 'queued',
    }));
  };
  if (scriptRuntime && !shouldSkipScripts) {
    dispatchRuntimeHook({ runtime: scriptRuntime, runtimeLabel: 'script' });
  }
  if (pluginRuntime && skipPlugins !== true) {
    dispatchRuntimeHook({ runtime: pluginRuntime, runtimeLabel: 'plugin' });
  }
  const chatFormatResult = runChatFormatGuardianPreview({
    message,
    sessionId,
    chatFormatGuardian,
    onChatFormatGuardianPreview,
    onChatFormatGuardianRun,
    onChatFormatGuardianModelReviewQueued,
    onChatFormatGuardianAutoRepair,
    logger,
  });
  runChatBodyQualityPreview({
    message: chatFormatResult?.patchedMessage || message,
    sessionId,
    chatBodyQualityGuardian,
    formatReport: chatFormatResult?.result,
    onChatBodyQualityPreview,
    onChatBodyQualityRun,
    logger,
  });
  try {
    if (typeof applyUpdateVariable === 'function') applyUpdateVariable(message, sessionId);
    else logger?.warn?.('[update-variable] apply function unavailable');
  } catch (err) {
    logger?.warn?.('UpdateVariable parse failed', err);
  }
  // C 计划 M1：UpdateVariable 应用后变量已就位——把本楼层最终变量态快照挂到该消息 meta（严格楼层绑定）。
  if (typeof onVariablesSettled === 'function') {
    try { onVariablesSettled(message, sessionId); } catch (err) { logger?.warn?.('variable snapshot capture failed', err); }
  }
  if (typeof handleVariableRules === 'function') {
    catchAsync(
      handleVariableRules({ sessionId, message, useGlobalVariables }),
      err => logger?.warn?.('variable rules after_receive failed', err),
    );
  }
  return true;
};
