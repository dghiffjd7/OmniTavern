import { DialogueStreamParser } from './dialogue-stream-parser.js';
import {
  FORMAT_PATCH_MAX_CHANGED_LINES,
  FORMAT_PATCH_MAX_PATCHES,
  FORMAT_PATCH_PROTOCOL_VERSION,
  countFormatPatchSourceLines,
  normalizeFormatPatchModelResult,
} from './format-patch-transaction-utils.js';
import {
  getBuiltinPhoneFormatGuardianSnippet,
  serializeBuiltinPhoneFormat,
  validateBuiltinPhoneFormat,
} from '../../utils/builtin-phone-format-contract.js';
import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';
import { getBuiltinAgentTask, resolveBuiltinAgentTask } from '../../agent/agent-builtin-defaults.js';

export const CHAT_FORMAT_EVENT_TYPES = Object.freeze({
  privateMessage: 'private_message',
  groupMessage: 'group_message',
  groupSystemEvent: 'group_system_event',
  momentComment: 'moment_comment',
  momentPost: 'moment_post',
});

const CHAT_SURFACE = 'chat';
const MOMENTS_SURFACE = 'moments';

export const CHAT_FORMAT_GUARDIAN_TARGETS = Object.freeze({
  auto: 'auto',
  privateChat: 'private_chat',
  groupChat: 'group_chat',
  momentComment: 'moment_comment',
  momentPost: 'moment_post',
  imagePrompt: 'image_prompt',
  memoryTableEdit: 'memory_table_edit',
  creativeText: 'creative_text',
  forum: 'forum',
});

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const getPromptLine = (key, replacements = {}) => {
  let text = getLocalizedPromptText(key);
  Object.entries(replacements).forEach(([name, value]) => {
    text = text.split(`{${name}}`).join(String(value ?? ''));
  });
  return text;
};

const list = value => (Array.isArray(value) ? value : [value]).filter(item => item !== null && item !== undefined);

const normalizeConfidence = (value, fallback = 0.75) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
};

const normalizeAttachments = value => (Array.isArray(value) ? value : []).filter(Boolean);

const normalizeStringList = value => list(value)
  .map(item => trim(item))
  .filter(Boolean);

const compactWhitespace = value => String(value ?? '').trim().replace(/\s+/g, ' ');

const truncatePreview = (value = '', maxLength = 240) => {
  const text = String(value ?? '').trim();
  const limit = Math.max(20, Math.trunc(Number(maxLength) || 240));
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
};

const splitLines = value => String(value ?? '').replace(/\r\n/g, '\n').split('\n');

const countLooseChatRows = (value = '') => splitLines(value)
  .map(line => trim(line))
  .filter(Boolean)
  .filter((line) => {
    if (/^(?:MiPhone_start|msg_start|msg_end|MiPhone_end)$/i.test(line)) return false;
    if (/^<[^>]+>$/.test(line)) return false;
    const parts = line.split('--');
    return parts.length >= 2 && trim(parts[0]) && trim(parts[1]);
  })
  .length;

const formatNumberedLines = (value = '') => {
  const lines = splitLines(value);
  const width = String(Math.max(1, lines.length)).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
};

const CHAT_FORMAT_PROMPT_LABEL_KEYS = Object.freeze({
  phoneShell: 'format_guardian.label.phoneShell',
  privateChat: 'format_guardian.label.privateChat',
  groupChat: 'format_guardian.label.groupChat',
  momentComment: 'format_guardian.label.momentComment',
  momentPost: 'format_guardian.label.momentPost',
  tableEdit: 'format_guardian.label.tableEdit',
  imagePrompt: 'format_guardian.label.imagePrompt',
  variableUpdate: 'format_guardian.label.variableUpdate',
});

export const normalizeChatFormatGuardianTarget = (value = '', fallback = CHAT_FORMAT_GUARDIAN_TARGETS.auto) => {
  const raw = trim(value || fallback, fallback).toLowerCase();
  const aliases = {
    private: CHAT_FORMAT_GUARDIAN_TARGETS.privateChat,
    private_message: CHAT_FORMAT_GUARDIAN_TARGETS.privateChat,
    dialogue: CHAT_FORMAT_GUARDIAN_TARGETS.privateChat,
    chat: CHAT_FORMAT_GUARDIAN_TARGETS.privateChat,
    group: CHAT_FORMAT_GUARDIAN_TARGETS.groupChat,
    group_message: CHAT_FORMAT_GUARDIAN_TARGETS.groupChat,
    moment: CHAT_FORMAT_GUARDIAN_TARGETS.momentPost,
    moments: CHAT_FORMAT_GUARDIAN_TARGETS.momentComment,
    moment_reply: CHAT_FORMAT_GUARDIAN_TARGETS.momentComment,
    image: CHAT_FORMAT_GUARDIAN_TARGETS.imagePrompt,
    image_tag: CHAT_FORMAT_GUARDIAN_TARGETS.imagePrompt,
    memory: CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit,
    table_edit: CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit,
    tableedit: CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit,
    creative: CHAT_FORMAT_GUARDIAN_TARGETS.creativeText,
    rp: CHAT_FORMAT_GUARDIAN_TARGETS.creativeText,
  };
  const normalized = aliases[raw] || raw;
  return Object.values(CHAT_FORMAT_GUARDIAN_TARGETS).includes(normalized)
    ? normalized
    : CHAT_FORMAT_GUARDIAN_TARGETS.auto;
};

const detectFormatTargetFromParserResult = (parserResult = null) => {
  const events = list(parserResult?.eventDrafts);
  if (events.some(event => trim(event?.type) === CHAT_FORMAT_EVENT_TYPES.groupMessage ||
    trim(event?.type) === CHAT_FORMAT_EVENT_TYPES.groupSystemEvent)) {
    return CHAT_FORMAT_GUARDIAN_TARGETS.groupChat;
  }
  if (events.some(event => trim(event?.type) === CHAT_FORMAT_EVENT_TYPES.privateMessage)) {
    return CHAT_FORMAT_GUARDIAN_TARGETS.privateChat;
  }
  if (events.some(event => trim(event?.type) === CHAT_FORMAT_EVENT_TYPES.momentPost)) {
    return CHAT_FORMAT_GUARDIAN_TARGETS.momentPost;
  }
  if (events.some(event => trim(event?.type) === CHAT_FORMAT_EVENT_TYPES.momentComment)) {
    return CHAT_FORMAT_GUARDIAN_TARGETS.momentComment;
  }
  return '';
};

const detectFunctionFormatIds = (text = '', parserResult = null) => {
  const raw = String(text ?? '');
  const reportText = [
    ...(Array.isArray(parserResult?.errors) ? parserResult.errors : []),
    ...(Array.isArray(parserResult?.warnings) ? parserResult.warnings : []),
    ...(Array.isArray(parserResult?.issues) ? parserResult.issues : []),
  ].map(item => (typeof item === 'string' ? item : JSON.stringify(item || {}))).join('\n');
  const combined = `${raw}\n${reportText}`;
  const ids = [];
  if (/<\s*\/?\s*image(?:_prompt)?\b/i.test(combined) || /\bimage_prompt\b/i.test(reportText)) {
    ids.push('imagePrompt');
  }
  if (/<\s*\/?\s*table(?:edit)?\b/i.test(combined) || /\btableEdit\b/i.test(reportText)) {
    ids.push('tableEdit');
  }
  if (
    /<\s*\/?\s*(?:update(?:variable)?|variableupdate)\b/i.test(combined) ||
    /\bUpdateVariable\b/i.test(reportText)
  ) {
    ids.push('variableUpdate');
  }
  return ids;
};

const selectFormatIdsForTarget = (target = '') => {
  switch (normalizeChatFormatGuardianTarget(target)) {
    case CHAT_FORMAT_GUARDIAN_TARGETS.privateChat:
      return ['phoneShell', 'privateChat'];
    case CHAT_FORMAT_GUARDIAN_TARGETS.groupChat:
      return ['phoneShell', 'groupChat'];
    case CHAT_FORMAT_GUARDIAN_TARGETS.momentComment:
      return ['momentComment'];
    case CHAT_FORMAT_GUARDIAN_TARGETS.momentPost:
      return ['phoneShell', 'momentPost'];
    case CHAT_FORMAT_GUARDIAN_TARGETS.imagePrompt:
      return ['imagePrompt'];
    case CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit:
      return ['tableEdit'];
    case CHAT_FORMAT_GUARDIAN_TARGETS.creativeText:
    case CHAT_FORMAT_GUARDIAN_TARGETS.forum:
      return [];
    default:
      return [];
  }
};

export const resolveChatFormatGuardianFormatProfile = ({
  target = CHAT_FORMAT_GUARDIAN_TARGETS.auto,
  uiMode = '',
  surface = '',
  isGroupChat = false,
  assistantText = '',
  parserResult = null,
  enabledFormats = {},
} = {}) => {
  const requested = normalizeChatFormatGuardianTarget(target);
  const detectedFromParser = detectFormatTargetFromParserResult(parserResult);
  const normalizedSurface = trim(surface).toLowerCase();
  const normalizedUiMode = trim(uiMode).toLowerCase();
  const requestedIsFunctionTarget = [
    CHAT_FORMAT_GUARDIAN_TARGETS.imagePrompt,
    CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit,
  ].includes(requested);
  const resolvedTarget = requested !== CHAT_FORMAT_GUARDIAN_TARGETS.auto
    ? requested
    : (
      detectedFromParser ||
      (normalizedUiMode === 'rp' || normalizedSurface === 'creative'
        ? CHAT_FORMAT_GUARDIAN_TARGETS.creativeText
        : (normalizedSurface === MOMENTS_SURFACE
          ? CHAT_FORMAT_GUARDIAN_TARGETS.momentComment
          : (isGroupChat ? CHAT_FORMAT_GUARDIAN_TARGETS.groupChat : CHAT_FORMAT_GUARDIAN_TARGETS.privateChat)))
    );
  const wantedIds = selectFormatIdsForTarget(resolvedTarget);
  if (!requestedIsFunctionTarget) {
    detectFunctionFormatIds(assistantText, parserResult).forEach((id) => {
      if (!wantedIds.includes(id)) wantedIds.push(id);
    });
  }
  const source = isPlainObject(enabledFormats) ? enabledFormats : {};
  const selectedFormats = {};
  wantedIds.forEach((id) => {
    if (source[id] === true) selectedFormats[id] = true;
  });
  return {
    target: resolvedTarget,
    requestedTarget: requested,
    enabledFormats: selectedFormats,
    enabledFormatIds: Object.keys(selectedFormats),
  };
};

const normalizeEnabledFormatEntries = (enabledFormats = {}) => {
  if (Array.isArray(enabledFormats)) {
    return enabledFormats
      .map(item => trim(item))
      .filter(Boolean)
      .map(id => ({
        id,
        label: CHAT_FORMAT_PROMPT_LABEL_KEYS[id] ? getPromptLine(CHAT_FORMAT_PROMPT_LABEL_KEYS[id]) : id,
        snippet: getBuiltinPhoneFormatGuardianSnippet(id),
      }));
  }
  const src = isPlainObject(enabledFormats) ? enabledFormats : {};
  return Object.keys(CHAT_FORMAT_PROMPT_LABEL_KEYS)
    .filter(id => src[id] === true)
    .map(id => ({
      id,
      label: getPromptLine(CHAT_FORMAT_PROMPT_LABEL_KEYS[id]),
      snippet: getBuiltinPhoneFormatGuardianSnippet(id),
    }));
};

const isChatFormatEnabled = (enabledFormats = {}, id = '') => {
  const key = trim(id);
  if (!key) return false;
  if (Array.isArray(enabledFormats)) return enabledFormats.map(item => trim(item)).includes(key);
  const src = isPlainObject(enabledFormats) ? enabledFormats : {};
  return src[key] === true;
};

const getPhoneShellMarkerIndex = (text = '', marker = '') => {
  const src = String(text ?? '');
  const escaped = String(marker || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<\\s*${escaped}\\s*>|\\b${escaped}\\b`, 'i');
  const match = re.exec(src);
  return match ? match.index : -1;
};

const collectPhoneShellWarnings = (text = '', eventDrafts = [], enabledFormats = {}) => {
  if (!isChatFormatEnabled(enabledFormats, 'phoneShell')) return [];
  if (!list(eventDrafts).length) return [];
  const markers = ['MiPhone_start', 'msg_start', 'msg_end', 'MiPhone_end'];
  const indices = markers.map(marker => [marker, getPhoneShellMarkerIndex(text, marker)]);
  const warnings = indices
    .filter(([, index]) => index < 0)
    .map(([marker]) => `phone shell marker is missing: ${marker}`);
  if (!warnings.length) {
    for (let index = 1; index < indices.length; index += 1) {
      if (indices[index][1] < indices[index - 1][1]) {
        warnings.push('phone shell marker order is invalid');
        break;
      }
    }
  }
  return warnings;
};

const resolveBuiltinContractSurface = (eventDrafts = []) => {
  const types = new Set(list(eventDrafts).map(event => trim(event?.type)));
  if (types.has(CHAT_FORMAT_EVENT_TYPES.groupMessage) || types.has(CHAT_FORMAT_EVENT_TYPES.groupSystemEvent)) {
    return CHAT_FORMAT_GUARDIAN_TARGETS.groupChat;
  }
  if (types.has(CHAT_FORMAT_EVENT_TYPES.privateMessage)) return CHAT_FORMAT_GUARDIAN_TARGETS.privateChat;
  if (types.has(CHAT_FORMAT_EVENT_TYPES.momentPost)) return CHAT_FORMAT_GUARDIAN_TARGETS.momentPost;
  if (types.has(CHAT_FORMAT_EVENT_TYPES.momentComment)) return CHAT_FORMAT_GUARDIAN_TARGETS.momentComment;
  return '';
};

const validateEnabledBuiltinContract = (text = '', eventDrafts = [], options = {}) => {
  if (trim(options?.customFormatGuide || options?.modelReview?.customFormatGuide)) return null;
  const surface = resolveBuiltinContractSurface(eventDrafts);
  const requiredFormatIds = selectFormatIdsForTarget(surface);
  if (!surface || !requiredFormatIds.every(id => isChatFormatEnabled(options.enabledFormats, id))) return null;
  return validateBuiltinPhoneFormat(text, { surface });
};

const serializeFormatEntries = (entries = []) => (
  entries
    .map((entry) => {
      const snippet = list(entry?.snippet).map(line => String(line ?? '')).join('\n').trim();
      return [`- ${entry.label || entry.id}`, snippet].filter(Boolean).join('\n');
    })
    .join('\n\n')
    .trim()
);

const buildPrivateChatTagName = ({ userName = '我', sessionLabel = '' } = {}) =>
  `${trim(userName, '我')}和${trim(sessionLabel, '联系人名')}的私聊`;

const buildPrivateDirectRepairExample = ({ userName = '我', sessionLabel = '', fallbackTime = '' } = {}) => {
  const time = trim(fallbackTime, '00:00');
  const contactName = getPromptLine('format_guardian.example.contact');
  return [
    getPromptLine('format_guardian.example.error_label'),
    getPromptLine('format_guardian.example.private_invalid'),
    '',
    getPromptLine('format_guardian.example.correct_label'),
    serializeBuiltinPhoneFormat('private_chat', {
      userName,
      targetName: trim(sessionLabel, contactName),
      messages: [{
        speaker: contactName,
        content: getPromptLine('format_guardian.example.private_content'),
        time,
      }],
    }),
  ].join('\n');
};

const buildDirectRepairExample = ({
  userName = '我',
  sessionLabel = '',
  fallbackTime = '',
  target = CHAT_FORMAT_GUARDIAN_TARGETS.privateChat,
} = {}) => {
  const normalizedTarget = normalizeChatFormatGuardianTarget(target, CHAT_FORMAT_GUARDIAN_TARGETS.privateChat);
  const time = trim(fallbackTime, '00:00');
  if (normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.groupChat) {
    const memberA = getPromptLine('format_guardian.example.member_a');
    const memberB = getPromptLine('format_guardian.example.member_b');
    return [
      getPromptLine('format_guardian.example.error_label'),
      getPromptLine('format_guardian.example.group_invalid'),
      '',
      getPromptLine('format_guardian.example.correct_label'),
      serializeBuiltinPhoneFormat('group_chat', {
        groupName: trim(sessionLabel, getPromptLine('format_guardian.example.group')),
        members: [memberA, memberB],
        messages: [{
          speaker: memberA,
          content: getPromptLine('format_guardian.example.group_content'),
          time,
        }],
      }),
    ].join('\n');
  }
  if (normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.momentComment) {
    return [
      getPromptLine('format_guardian.example.error_label'),
      getPromptLine('format_guardian.example.comment_invalid'),
      '',
      getPromptLine('format_guardian.example.correct_label'),
      serializeBuiltinPhoneFormat('moment_comment', {
        momentId: getPromptLine('format_guardian.example.moment_id'),
        comments: [{
          author: getPromptLine('format_guardian.example.commenter'),
          content: getPromptLine('format_guardian.example.comment_content'),
        }],
      }),
    ].join('\n');
  }
  if (normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.momentPost) {
    return [
      getPromptLine('format_guardian.example.error_label'),
      getPromptLine('format_guardian.example.post_content'),
      '',
      getPromptLine('format_guardian.example.correct_label'),
      serializeBuiltinPhoneFormat('moment_post', {
        posts: [{
          author: trim(userName, '我'),
          content: getPromptLine('format_guardian.example.post_content'),
          time,
          views: 0,
          likes: 0,
        }],
      }),
    ].join('\n');
  }
  if (normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.imagePrompt) {
    return [
      getPromptLine('format_guardian.example.error_label'),
      getPromptLine('format_guardian.example.image_invalid'),
      '',
      getPromptLine('format_guardian.example.correct_label'),
      '<image_prompt>',
      getPromptLine('format_guardian.example.image_content'),
      '</image_prompt>',
    ].join('\n');
  }
  if (normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.memoryTableEdit) {
    return [
      getPromptLine('format_guardian.example.error_label'),
      getPromptLine('format_guardian.example.memory_invalid'),
      '',
      getPromptLine('format_guardian.example.correct_label'),
      '<tableEdit>',
      getPromptLine('format_guardian.example.memory_content'),
      '</tableEdit>',
    ].join('\n');
  }
  if (normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.creativeText ||
      normalizedTarget === CHAT_FORMAT_GUARDIAN_TARGETS.forum) {
    return '';
  }
  return buildPrivateDirectRepairExample({ userName, sessionLabel, fallbackTime });
};

const compactParserReportForPrompt = (report = null, { maxEvents = 6, maxIssues = 8 } = {}) => {
  if (!isPlainObject(report)) return null;
  return {
    status: trim(report.status),
    summary: trim(report.summary),
    repairFallbackTime: trim(report.repairFallbackTime),
    errors: normalizeStringList(report.errors).slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 8))),
    warnings: normalizeStringList(report.warnings).slice(0, Math.max(0, Math.trunc(Number(maxIssues) || 8))),
    events: list(report.eventDrafts)
      .slice(0, Math.max(0, Math.trunc(Number(maxEvents) || 6)))
      .map(event => ({
        type: trim(event?.type),
        surface: trim(event?.surface),
        targetName: trim(event?.targetName),
        speakerName: trim(event?.speakerName),
        time: trim(event?.time),
        contentPreview: truncatePreview(event?.content, 80),
        warnings: normalizeStringList(event?.warnings).slice(0, 4),
      })),
  };
};

export const buildChatFormatGuardianModelPrompt = ({
  assistantText = '',
  formatReminderText = '',
  customFormatGuide = '', agentConfig = null, referenceContext = null,
  enabledFormats = {},
  parserReport = null,
  userName = '我',
  sessionLabel = '',
  surface = 'chat',
  formatTarget = CHAT_FORMAT_GUARDIAN_TARGETS.privateChat,
  baseRevision = 'format-run:unbound',
  repairTarget = null,
} = {}) => {
  const rawAssistantText = String(assistantText ?? '');
  const reminder = String(formatReminderText ?? '').trim();
  const customGuide = String(customFormatGuide ?? '').trim().slice(0, 6000);
  const formatEntries = normalizeEnabledFormatEntries(enabledFormats);
  const formatSummary = serializeFormatEntries(formatEntries);
  const compactReport = compactParserReportForPrompt(parserReport);
  const numberedAssistantText = rawAssistantText ? formatNumberedLines(rawAssistantText) : '';
  const looseChatRowCount = countLooseChatRows(rawAssistantText);
  const repairFallbackTime = trim(compactReport?.repairFallbackTime, '00:00');
  const privateTagName = buildPrivateChatTagName({ userName, sessionLabel });
  const normalizedTarget = normalizeChatFormatGuardianTarget(formatTarget, CHAT_FORMAT_GUARDIAN_TARGETS.privateChat);
  const hasPrivateFormat = formatEntries.some(entry => entry.id === 'privateChat');
  const hasChatFormat = formatEntries.some(entry => ['privateChat', 'groupChat', 'phoneShell'].includes(entry.id));
  const hasFunctionFormat = formatEntries.some(entry => ['imagePrompt', 'tableEdit', 'variableUpdate'].includes(entry.id));
  const revisionToken = trim(baseRevision, 'format-run:unbound');
  const directRepairExample = buildDirectRepairExample({
    userName,
    sessionLabel,
    fallbackTime: repairFallbackTime,
    target: normalizedTarget,
  });
  const noEventsHint = compactReport?.status === 'no_events'
    ? (looseChatRowCount > 0
      ? [
        getPromptLine('format_guardian.no_events.loose', { count: looseChatRowCount }),
        getPromptLine('format_guardian.no_events.repairable'),
        hasPrivateFormat
          ? getPromptLine('format_guardian.no_events.private', { tag: privateTagName })
          : getPromptLine('format_guardian.no_events.current'),
        getPromptLine('format_guardian.no_events.time', { time: repairFallbackTime }),
      ].join('\n')
      : (customGuide
        ? getPromptLine('format_guardian.no_events.custom')
        : getPromptLine('format_guardian.no_events.empty')))
    : '';
  const defaultTaskLines = getBuiltinAgentTask('reply_check').split('\n');
  const task = resolveBuiltinAgentTask(agentConfig, 'reply_check');
  const replacesTask = agentConfig?.taskPromptMode === 'replace';
  const protocol = getPromptLine('format_guardian.system.protocol', { version: FORMAT_PATCH_PROTOCOL_VERSION });
  // Preserve the existing default/legacy message shape. Explicit task edits
  // replace the business instructions, while patch and scene rules still apply.
  const system = [
    ...(replacesTask && task !== defaultTaskLines.join('\n')
      ? [task, protocol]
      : [defaultTaskLines[0], protocol, ...defaultTaskLines.slice(1)]),
    hasPrivateFormat ? getPromptLine('format_guardian.system.private') : '',
    hasChatFormat ? getPromptLine('format_guardian.system.loose_rows') : '',
    customGuide ? getPromptLine('format_guardian.system.custom') : '',
    getPromptLine('format_guardian.system.truncated'),
    getPromptLine('format_guardian.system.parser'),
    hasFunctionFormat ? getPromptLine('format_guardian.system.function_payload') : '',
    getPromptLine('format_guardian.system.json_only'),
    getPromptLine('format_guardian.system.json_quotes'),
    getPromptLine('format_guardian.system.no_full_text'),
    getPromptLine('format_guardian.system.patch_status'),
    getPromptLine('format_guardian.system.limits', {
      patches: FORMAT_PATCH_MAX_PATCHES,
      lines: FORMAT_PATCH_MAX_CHANGED_LINES,
    }),
    getPromptLine('format_guardian.system.patch_fields'),
    hasChatFormat ? getPromptLine('format_guardian.system.trailing_blocks') : '',
  ].filter(Boolean).join('\n');
  const targetSummary = repairTarget && typeof repairTarget === 'object'
    ? {
      sessionId: trim(repairTarget.sessionId || repairTarget.sourceSessionId),
      turnId: trim(repairTarget.turnId),
      sourceKind: trim(repairTarget.sourceKind),
      sourceMessageIds: normalizeStringList(repairTarget.sourceMessageIds),
    }
    : null;
  const user = [
    [
      '# Task',
      'Inspect and repair the assistant output format. Return only the patch-only JSON object defined below.',
    ].join('\n'),
    [
      '# Runtime Context',
      `userName: ${trim(userName, '我')}`,
      `sessionLabel: ${trim(sessionLabel, '') || 'N/A'}`,
      `surface: ${trim(surface, 'chat')}`,
      `formatTarget: ${normalizedTarget}`,
      `repairFallbackTime: ${repairFallbackTime}`,
      `protocolVersion: ${FORMAT_PATCH_PROTOCOL_VERSION}`,
      `baseRevision: ${revisionToken}`,
      `sourceLineCount: ${countFormatPatchSourceLines(rawAssistantText)}`,
    ].join('\n'),
    targetSummary ? `# Repair Target\n${JSON.stringify(targetSummary, null, 2)}` : '',
    formatSummary ? `# Required Format Examples\n${formatSummary}` : '',
    directRepairExample ? `# Correct Structure Example\n${directRepairExample}` : '',
    reminder ? `# Required Additional Format Rules\n${reminder}` : '',
    customGuide ? `${getPromptLine('format_guardian.user.custom_heading')}\n${customGuide}` : '',
    compactReport ? `# Local Parser Report\n${JSON.stringify(compactReport, null, 2)}` : '',
    noEventsHint,
    [
      getPromptLine('format_guardian.user.invalid_heading'),
      'The line numbers are for locating text only. Do not copy line numbers into replacementLines.',
      rawAssistantText.length ? numberedAssistantText : getPromptLine('format_guardian.user.empty'),
    ].join('\n'),
    getPromptLine('format_guardian.user.output_contract', {
      version: FORMAT_PATCH_PROTOCOL_VERSION,
      baseRevision: JSON.stringify(revisionToken),
    }),
  ].filter(Boolean).join('\n\n');
  return {
    messages: [
      { role: 'system', content: system },
      ...(!replacesTask && agentConfig?.prompt?.trim() ? [{ role: 'system', content: agentConfig.prompt }] : []),
      ...(agentConfig?.blocks || []).filter(b => b.enabled !== false && b.text?.trim()).map(b => ({ role: b.role === 'user' ? 'user' : 'system', content: b.text })),
      ...(referenceContext?.text ? [{ role: 'user', content: `Reference context (read only):\n${referenceContext.text}` }] : []),
      { role: 'user', content: user },
    ],
    sections: [
      { source: '格式检查协议', editFields: ['prompt'], origin: '任务要求可编辑；返回协议与场景约束由系统组装' },
      ...(!replacesTask && agentConfig?.prompt?.trim() ? [{ source: '任务要求', editField: 'prompt' }] : []),
      ...(agentConfig?.blocks || []).flatMap((b, index) => b.enabled !== false && b.text?.trim() ? [{ source: b.name || '自定义区块', editField: `blocks.${index}.text` }] : []),
      ...(referenceContext?.text ? [{ source: referenceContext.truncated ? '参考上下文 · 已截断' : '参考上下文' }] : []),
      { source: '格式要求与原始回复', editFields: customGuide ? ['formatGuide'] : [], origin: '原始回复与外部格式来源只读' },
    ],
    responseFormat: 'json_object',
    enabledFormatIds: formatEntries.map(entry => entry.id),
  };
};

export const extractJsonObjectText = (value = '') => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() || text;
  if (source.startsWith('{') && source.endsWith('}')) return source;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return start >= 0 && end > start ? source.slice(start, end + 1) : '';
};

export const normalizeChatFormatGuardianModelReview = (
  raw = '',
  {
    originalText = '',
    baseRevision = '',
  } = {},
) => normalizeFormatPatchModelResult(raw, {
  originalText,
  baseRevision,
});

const inferSurface = (type = '') => (
  type === CHAT_FORMAT_EVENT_TYPES.momentComment || type === CHAT_FORMAT_EVENT_TYPES.momentPost
    ? MOMENTS_SURFACE
    : CHAT_SURFACE
);

const normalizeChatFormatEventType = value => (
  Object.values(CHAT_FORMAT_EVENT_TYPES).includes(value)
    ? value
    : ''
);

export const normalizeChatFormatEventDraft = (event = {}) => {
  const src = isPlainObject(event) ? event : {};
  const type = normalizeChatFormatEventType(trim(src.type));
  const warnings = normalizeStringList(src.warnings);
  return {
    type,
    surface: trim(src.surface, inferSurface(type)),
    targetId: trim(src.targetId),
    targetName: trim(src.targetName),
    speakerId: trim(src.speakerId),
    speakerName: trim(src.speakerName),
    content: trim(src.content),
    time: trim(src.time),
    attachments: normalizeAttachments(src.attachments),
    sourceMessageId: trim(src.sourceMessageId),
    confidence: normalizeConfidence(src.confidence),
    warnings,
    metadata: isPlainObject(src.metadata) ? { ...src.metadata } : {},
  };
};

const isSystemSpeaker = (speaker = '', options = {}) => {
  if (typeof options.isSystemSpeaker === 'function') return options.isSystemSpeaker(speaker) === true;
  return ['系统', 'system', '系统消息'].includes(trim(speaker).toLowerCase()) ||
    trim(speaker).startsWith('系统');
};

const resolveTargetId = (name = '', resolver = null) => {
  if (typeof resolver !== 'function') return '';
  try {
    return trim(resolver(name));
  } catch {
    return '';
  }
};

const resolveSpeakerId = (name = '', resolver = null, targetId = '') => {
  if (typeof resolver !== 'function') return '';
  try {
    return trim(resolver(name, targetId));
  } catch {
    return '';
  }
};

const buildPrivateMessageDrafts = (event = {}, options = {}) => {
  const targetName = trim(event.otherName);
  const targetId = resolveTargetId(targetName, options.resolvePrivateTargetId);
  return list(event.messages).map(message => normalizeChatFormatEventDraft({
    type: CHAT_FORMAT_EVENT_TYPES.privateMessage,
    surface: CHAT_SURFACE,
    targetId,
    targetName,
    speakerId: resolveSpeakerId(message?.speaker, options.resolveSpeakerId, targetId),
    speakerName: trim(message?.speaker),
    content: message?.content,
    time: message?.time,
    sourceMessageId: options.sourceMessageId,
    confidence: targetName ? 0.86 : 0.62,
    metadata: {
      protocolType: 'private_chat',
      tagName: trim(event.tagName),
    },
  }));
};

const buildGroupMessageDrafts = (event = {}, options = {}) => {
  const targetName = trim(event.groupName);
  const targetId = resolveTargetId(targetName, options.resolveGroupTargetId);
  return list(event.messages).map((message) => {
    const speakerName = trim(message?.speaker);
    const system = isSystemSpeaker(speakerName, options);
    return normalizeChatFormatEventDraft({
      type: system ? CHAT_FORMAT_EVENT_TYPES.groupSystemEvent : CHAT_FORMAT_EVENT_TYPES.groupMessage,
      surface: CHAT_SURFACE,
      targetId,
      targetName,
      speakerId: system ? '' : resolveSpeakerId(speakerName, options.resolveSpeakerId, targetId),
      speakerName,
      content: message?.content,
      time: message?.time,
      sourceMessageId: options.sourceMessageId,
      confidence: targetName ? 0.88 : 0.62,
      metadata: {
        protocolType: 'group_chat',
        tagName: trim(event.tagName),
        members: normalizeStringList(event.members),
      },
    });
  });
};

const buildMomentPostDrafts = (event = {}, options = {}) => list(event.moments).map(moment => normalizeChatFormatEventDraft({
  type: CHAT_FORMAT_EVENT_TYPES.momentPost,
  surface: MOMENTS_SURFACE,
  targetId: trim(moment?.id),
  targetName: trim(moment?.author),
  speakerName: trim(moment?.author),
  content: moment?.content,
  time: moment?.time,
  sourceMessageId: options.sourceMessageId,
  confidence: trim(moment?.author) ? 0.82 : 0.66,
  metadata: {
    protocolType: 'moments',
    views: Number(moment?.views || 0) || 0,
    likes: Number(moment?.likes || 0) || 0,
    comments: Array.isArray(moment?.comments) ? moment.comments.slice() : [],
  },
}));

const buildMomentReplyDrafts = (event = {}, options = {}) => list(event.comments).map(comment => normalizeChatFormatEventDraft({
  type: CHAT_FORMAT_EVENT_TYPES.momentComment,
  surface: MOMENTS_SURFACE,
  targetId: trim(event.momentId),
  targetName: trim(comment?.replyToAuthor || comment?.replyTo),
  speakerName: trim(comment?.author),
  content: comment?.content,
  sourceMessageId: options.sourceMessageId,
  confidence: trim(event.momentId) ? 0.84 : 0.68,
  metadata: {
    protocolType: 'moment_reply',
    replyTo: trim(comment?.replyTo),
    replyToAuthor: trim(comment?.replyToAuthor),
  },
}));

export const buildChatFormatEventDraftsFromProtocolEvents = (protocolEvents = [], options = {}) => (
  list(protocolEvents).flatMap((event) => {
    if (event?.type === 'private_chat') return buildPrivateMessageDrafts(event, options);
    if (event?.type === 'group_chat') return buildGroupMessageDrafts(event, options);
    if (event?.type === 'moments') return buildMomentPostDrafts(event, options);
    if (event?.type === 'moment_reply') return buildMomentReplyDrafts(event, options);
    return [];
  })
);

export const validateChatFormatEventDraft = (event = {}) => {
  const draft = normalizeChatFormatEventDraft(event);
  const errors = [];
  const warnings = normalizeStringList(draft.warnings);
  if (!draft.type) errors.push('type is required');
  if (!draft.surface) errors.push('surface is required');
  if (draft.surface === CHAT_SURFACE &&
    (draft.type === CHAT_FORMAT_EVENT_TYPES.momentComment || draft.type === CHAT_FORMAT_EVENT_TYPES.momentPost)) {
    errors.push('moment events must use moments surface');
  }
  if (draft.surface === MOMENTS_SURFACE &&
    (draft.type === CHAT_FORMAT_EVENT_TYPES.privateMessage ||
      draft.type === CHAT_FORMAT_EVENT_TYPES.groupMessage ||
      draft.type === CHAT_FORMAT_EVENT_TYPES.groupSystemEvent)) {
    errors.push('chat events must use chat surface');
  }
  if (!draft.content) errors.push('content is required');
  if (!draft.targetId && !draft.targetName) warnings.push('target is unresolved');
  if (!draft.speakerId && !draft.speakerName && draft.type !== CHAT_FORMAT_EVENT_TYPES.groupSystemEvent) {
    warnings.push('speaker is unresolved');
  }
  if (!draft.time && draft.surface === CHAT_SURFACE) warnings.push('time is missing');
  if (draft.confidence < 0.7) warnings.push('low confidence');
  return {
    ok: errors.length === 0,
    commitReady: errors.length === 0 && warnings.length === 0,
    severity: errors.length ? 'error' : (warnings.length ? 'warning' : 'ok'),
    event: {
      ...draft,
      warnings,
    },
    errors,
    warnings,
  };
};

export const validateChatFormatEventDrafts = (events = []) => {
  const items = list(events).map(validateChatFormatEventDraft);
  const errors = items.flatMap(item => item.errors);
  const warnings = items.flatMap(item => item.warnings);
  return {
    ok: errors.length === 0,
    commitReady: items.length > 0 && items.every(item => item.commitReady),
    severity: errors.length ? 'error' : (warnings.length ? 'warning' : 'ok'),
    items,
    errors,
    warnings,
  };
};

export const extractChatFormatEventDrafts = (text = '', options = {}) => {
  const parser = new DialogueStreamParser({
    userName: trim(options.userName, '我'),
    resolveLooseGroupTag: options.resolveLooseGroupTag,
    resolveLoosePrivateTag: options.resolveLoosePrivateTag,
  });
  const protocolEvents = [
    ...parser.push(text),
    ...parser.flush(),
  ];
  const eventDrafts = buildChatFormatEventDraftsFromProtocolEvents(protocolEvents, options);
  const validation = validateChatFormatEventDrafts(eventDrafts);
  const shellWarnings = collectPhoneShellWarnings(text, validation.items.map(item => item.event), options.enabledFormats);
  const contractValidation = validateEnabledBuiltinContract(
    text,
    validation.items.map(item => item.event),
    options,
  );
  const contractWarnings = contractValidation?.valid === false
    ? contractValidation.issues.map(issue => `built-in contract violation: ${issue}`)
    : [];
  const errors = Array.from(new Set(validation.errors));
  const warnings = Array.from(new Set([...validation.warnings, ...shellWarnings, ...contractWarnings]));
  const status = !eventDrafts.length
    ? 'no_events'
    : (errors.length ? 'invalid' : (warnings.length ? 'needs_review' : 'ready'));
  return {
    ok: eventDrafts.length > 0 && !errors.length,
    status,
    sourceMessageId: trim(options.sourceMessageId),
    protocolEvents,
    eventDrafts: validation.items.map(item => item.event),
    contractValidation,
    errors,
    warnings,
    summary: eventDrafts.length
      ? `${eventDrafts.length} chat format event draft(s), ${errors.length} error(s), ${warnings.length} warning(s)`
      : 'no chat format events detected',
    textPreview: truncatePreview(compactWhitespace(text), 180),
  };
};
