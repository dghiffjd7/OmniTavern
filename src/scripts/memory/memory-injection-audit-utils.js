import { estimateTokens } from './memory-prompt-utils.js';

const toNonNegativeInt = (value, fallback = 0) => {
  const next = Math.trunc(Number(value));
  return Number.isFinite(next) ? Math.max(0, next) : Math.max(0, Math.trunc(Number(fallback)) || 0);
};

const toOptionalNonNegativeInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const next = Math.trunc(Number(value));
  return Number.isFinite(next) && next >= 0 ? next : null;
};

const stringifyPromptContent = (content) => {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return String(part.text || '');
        if (part.type === 'image_url') return '[图片]';
        if (part.type === 'input_audio') return '[语音]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
};

export const estimatePromptContentTokens = (content, tokenMode = 'rough') =>
  estimateTokens(stringifyPromptContent(content), tokenMode);

// 工具定义与工具调用参数也是输入：供应方 usage 含这两部分，只算正文会少估，并把 token 校准系数顶高
const estimateToolCallsTokens = (toolCalls, tokenMode) => (
  Array.isArray(toolCalls) && toolCalls.length
    ? estimateTokens(JSON.stringify(toolCalls.map(call => call?.function || call)), tokenMode)
    : 0
);

export const estimatePromptMessagesTokens = (messages = [], tokenMode = 'rough') => (
  (Array.isArray(messages) ? messages : []).reduce((total, message) => (
    total + estimatePromptContentTokens(message?.content, tokenMode)
      + estimateToolCallsTokens(message?.tool_calls, tokenMode)
  ), 0)
);

export const estimatePromptToolsTokens = (tools = [], tokenMode = 'rough') => (
  Array.isArray(tools) && tools.length ? estimateTokens(JSON.stringify(tools), tokenMode) : 0
);

// 图片/语音等非文本 part 在估算里只折成占位符，真实 usage 却含附件 token；
// token 校准取样前用这个判断排除此类请求，避免比值被附件系统性推高。
export const promptMessagesContainNonTextContent = (messages = []) => (
  (Array.isArray(messages) ? messages : []).some(message => (
    Array.isArray(message?.content)
    && message.content.some(part => part && typeof part === 'object' && part.type !== 'text')
  ))
);

export const buildInjectionAuditSegment = ({
  id = '',
  label = '',
  text = '',
  texts = null,
  usedTokens = null,
  quotaTokens = null,
  rowCount = 0,
  messageCount = 0,
  trimmedCount = 0,
  overflowed = false,
  detail = '',
  tokenMode = 'rough',
} = {}) => {
  const content = Array.isArray(texts)
    ? texts.map(item => stringifyPromptContent(item)).filter(Boolean).join('\n')
    : stringifyPromptContent(text);
  const measuredTokens = toOptionalNonNegativeInt(usedTokens);
  return {
    id: String(id || '').trim(),
    label: String(label || id || '未命名分段').trim(),
    usedTokens: measuredTokens ?? estimateTokens(content, tokenMode),
    quotaTokens: toOptionalNonNegativeInt(quotaTokens),
    rowCount: toNonNegativeInt(rowCount),
    messageCount: toNonNegativeInt(messageCount),
    trimmedCount: toNonNegativeInt(trimmedCount),
    overflowed: overflowed === true,
    detail: String(detail || '').trim(),
  };
};

export const buildMemoryPlanAudit = ({
  localTableText = '',
  localRowCount = 0,
  localTrimmedCount = 0,
  localSegments = null,
  crossScopeSegments = [],
  recallQuotaTokens = null,
  dataPromptText = '',
  guidePromptText = '',
  tokenMode = 'rough',
} = {}) => {
  const segments = [];
  const localSegmentLabels = {
    state: '常驻状态',
    mid: '中景摘要',
    far: '远景大纲',
  };
  const hasLocalSegments = localSegments && typeof localSegments === 'object';
  if (hasLocalSegments) {
    Object.entries(localSegmentLabels).forEach(([segmentId, label]) => {
      const source = localSegments?.[segmentId] || {};
      const normalized = buildInjectionAuditSegment({
        id: `memory_${segmentId}`,
        label,
        usedTokens: source?.usedTokens,
        quotaTokens: source?.quotaTokens,
        rowCount: Array.isArray(source?.items) ? source.items.length : source?.rowCount,
        trimmedCount: Array.isArray(source?.truncated) ? source.truncated.length : source?.trimmedCount,
        overflowed: source?.overflowed === true,
        tokenMode,
      });
      if (normalized.usedTokens > 0 || normalized.rowCount > 0 || normalized.trimmedCount > 0) {
        segments.push(normalized);
      }
    });
  } else {
    const local = buildInjectionAuditSegment({
      id: 'memory_local',
      label: '本会话记忆表格',
      text: localTableText,
      rowCount: localRowCount,
      trimmedCount: localTrimmedCount,
      overflowed: localTrimmedCount > 0,
      tokenMode,
    });
    if (local.usedTokens > 0 || local.rowCount > 0 || local.trimmedCount > 0) segments.push(local);
  }

  let recallQuotaAttached = false;
  (Array.isArray(crossScopeSegments) ? crossScopeSegments : []).forEach((segment, index) => {
    const normalized = buildInjectionAuditSegment({
      id: segment?.id || `memory_cross_scope_${index + 1}`,
      label: segment?.label || '跨会话记忆',
      text: segment?.text || '',
      usedTokens: segment?.usedTokens,
      quotaTokens: recallQuotaAttached ? null : recallQuotaTokens,
      rowCount: segment?.rowCount,
      trimmedCount: segment?.trimmedCount,
      overflowed: segment?.overflowed,
      detail: segment?.detail,
      tokenMode,
    });
    if (normalized.usedTokens > 0 || normalized.rowCount > 0 || normalized.trimmedCount > 0) {
      segments.push(normalized);
      recallQuotaAttached = true;
    }
  });

  const dataTokens = estimatePromptContentTokens(dataPromptText, tokenMode);
  const memoryDataParts = segments.reduce((sum, segment) => sum + segment.usedTokens, 0);
  const wrapperTokens = Math.max(0, dataTokens - memoryDataParts);
  if (wrapperTokens > 0) {
    segments.push(buildInjectionAuditSegment({
      id: 'memory_wrapper',
      label: '记忆注入外壳',
      usedTokens: wrapperTokens,
      tokenMode,
    }));
  }

  const guide = buildInjectionAuditSegment({
    id: 'memory_guide',
    label: '记忆写表指引',
    text: guidePromptText,
    tokenMode,
  });
  if (guide.usedTokens > 0) segments.push(guide);

  return {
    version: 1,
    segments,
    usedTokens: segments.reduce((sum, segment) => sum + segment.usedTokens, 0),
  };
};

export const buildRequestInjectionAudit = ({
  memoryPlan = null,
  extraSegments = [],
  history = [],
  worldDebug = null,
  messages = [],
  tools = [],
  budget = null,
  mode = 'token',
  tokenMode = 'rough',
} = {}) => {
  const memorySegments = Array.isArray(memoryPlan?.audit?.segments)
    ? memoryPlan.audit.segments.map(segment => ({ ...segment }))
    : [];
  const historyList = Array.isArray(history) ? history : [];
  const historyTokens = estimatePromptMessagesTokens(historyList, tokenMode);
  const historyChars = historyList.reduce(
    (sum, message) => sum + stringifyPromptContent(message?.content).length,
    0,
  );
  const worldUsed = toNonNegativeInt(worldDebug?.usedTokens);
  const worldTrimmed = Array.isArray(worldDebug?.trimmedEntries)
    ? worldDebug.trimmedEntries.length
    : 0;
  const normalizedExtraSegments = (Array.isArray(extraSegments) ? extraSegments : [])
    .map((segment, index) => buildInjectionAuditSegment({
      id: segment?.id || `extra_${index + 1}`,
      label: segment?.label || '其他注入',
      text: segment?.text || '',
      texts: segment?.texts,
      usedTokens: segment?.usedTokens,
      quotaTokens: segment?.quotaTokens,
      rowCount: segment?.rowCount,
      messageCount: segment?.messageCount,
      trimmedCount: segment?.trimmedCount,
      overflowed: segment?.overflowed,
      detail: segment?.detail,
      tokenMode,
    }))
    .filter(segment => (
      segment.usedTokens > 0
      || segment.rowCount > 0
      || segment.messageCount > 0
      || segment.trimmedCount > 0
    ));
  const segments = [
    ...memorySegments,
    ...normalizedExtraSegments,
    buildInjectionAuditSegment({
      id: 'history',
      label: '原始前文',
      usedTokens: historyTokens,
      quotaTokens: budget?.allocations?.recent,
      messageCount: historyList.length,
      detail: `${historyChars} 字符`,
      tokenMode,
    }),
    buildInjectionAuditSegment({
      id: 'world',
      label: '世界书',
      usedTokens: worldUsed,
      rowCount: Array.isArray(worldDebug?.mergedEntries) ? worldDebug.mergedEntries.length : 0,
      trimmedCount: worldTrimmed,
      overflowed: worldDebug?.overflowed === true,
      quotaTokens: worldDebug?.budgetTokens,
      tokenMode,
    }),
  ].filter(segment => (
    segment.usedTokens > 0
    || segment.rowCount > 0
    || segment.messageCount > 0
    || segment.trimmedCount > 0
  ));

  const totalEstimateTokens = estimatePromptMessagesTokens(messages, tokenMode) + estimatePromptToolsTokens(tools, tokenMode);
  const knownTokens = segments.reduce((sum, segment) => sum + segment.usedTokens, 0);
  const otherTokens = Math.max(0, totalEstimateTokens - knownTokens);
  if (otherTokens > 0) {
    segments.push(buildInjectionAuditSegment({
      id: 'fixed',
      label: '人设、格式与其他提示词',
      usedTokens: otherTokens,
      quotaTokens: budget?.fixedReserveTokens,
      tokenMode,
    }));
  }

  const normalizedBudget = toOptionalNonNegativeInt(budget?.inputBudgetTokens ?? budget?.totalTokens);
  return {
    version: 1,
    mode: String(mode || 'token').trim().toLowerCase() === 'rows' ? 'rows' : 'token',
    tokenMode,
    inputBudgetTokens: normalizedBudget,
    outputReserveTokens: toOptionalNonNegativeInt(budget?.outputReserveTokens),
    safetyReserveTokens: toOptionalNonNegativeInt(budget?.safetyReserveTokens),
    totalEstimateTokens,
    usedTokens: segments.reduce((sum, segment) => sum + segment.usedTokens, 0),
    segments,
    overQuotaSegments: Array.isArray(budget?.overQuotaSegments)
      ? budget.overQuotaSegments.map(key => String(key || '').trim()).filter(Boolean)
      : [],
    overflowed: normalizedBudget !== null && totalEstimateTokens > normalizedBudget,
  };
};

const OVER_QUOTA_SEGMENT_LABELS = {
  state: '常驻状态',
  recent: '原始前文',
  mid: '中景摘要',
  far: '远景大纲',
  recall: '按需召回',
};

// 护栏 3：state 永不被裁，超配额说明状态类表格没做覆盖式更新（在逐轮追加），
// 只报数字不点名的话用户不知道该去改模板。
export const buildOverQuotaWarnings = (audit = null) => {
  const keys = Array.isArray(audit?.overQuotaSegments) ? audit.overQuotaSegments : [];
  return keys.map((key) => {
    if (key === 'state') {
      return '常驻状态超出配额：状态类表格可能在逐轮追加而非覆盖式更新，建议检查模板与写表指引';
    }
    const label = OVER_QUOTA_SEGMENT_LABELS[key] || key;
    return `${label}超出配额`;
  });
};

export const formatInjectionAuditText = (audit = null) => {
  if (!audit || typeof audit !== 'object') return '暂无注入审计记录';
  const total = toNonNegativeInt(audit.totalEstimateTokens ?? audit.usedTokens);
  const budget = toOptionalNonNegativeInt(audit.inputBudgetTokens);
  const lines = [
    `注入总量：约 ${total} token${budget === null ? '' : ` / 预算 ${budget}`}`,
  ];
  const calibration = audit?.calibration;
  if (calibration && Number(calibration.samples) > 0) {
    lines.push(
      `校准：×${Number(calibration.coefficient || 1).toFixed(3)}`
      + `（${toNonNegativeInt(calibration.samples)} 次，${String(calibration.provider || '')}/${String(calibration.model || '')}）`,
    );
  } else {
    const fallbackCoefficient = Number(calibration?.coefficient);
    lines.push(
      Number.isFinite(fallbackCoefficient) && fallbackCoefficient > 0 && fallbackCoefficient !== 1
        ? `校准：尚无真实 usage 样本，使用保守默认系数 ×${fallbackCoefficient.toFixed(2)}`
        : '校准：尚无真实 usage 样本，当前使用保守本地估算',
    );
  }
  (Array.isArray(audit.segments) ? audit.segments : []).forEach((segment) => {
    const extras = [];
    if (toNonNegativeInt(segment?.messageCount) > 0) extras.push(`${toNonNegativeInt(segment.messageCount)} 条消息`);
    if (toNonNegativeInt(segment?.rowCount) > 0) extras.push(`${toNonNegativeInt(segment.rowCount)} 行`);
    if (toNonNegativeInt(segment?.trimmedCount) > 0) extras.push(`裁掉 ${toNonNegativeInt(segment.trimmedCount)}`);
    if (segment?.detail) extras.push(String(segment.detail));
    const quota = toOptionalNonNegativeInt(segment?.quotaTokens);
    lines.push(
      `- ${String(segment?.label || segment?.id || '未命名分段')}：约 ${toNonNegativeInt(segment?.usedTokens)} token`
      + `${quota === null ? '' : ` / 配额 ${quota}`}`
      + `${extras.length ? `（${extras.join('，')}）` : ''}`,
    );
  });
  const coverage = audit?.coverageLine;
  if (coverage && typeof coverage === 'object') {
    const rate = Number.isFinite(Number(coverage.coverageRate))
      ? Math.round(Number(coverage.coverageRate) * 100)
      : null;
    const holes = Array.isArray(coverage.holes) ? coverage.holes : [];
    lines.push(
      `- 摘要覆盖：${rate === null ? '未知' : `${rate}%`}`
      + `${holes.length ? `；空洞 ${holes.map(item => `${item.from}-${item.to}`).join('、')}` : '；无空洞'}`,
    );
    if (toNonNegativeInt(coverage.protectedMessageCount) > 0) {
      lines.push(`- 已强制保留 ${toNonNegativeInt(coverage.protectedMessageCount)} 条未被摘要覆盖的原文消息`);
    }
  }
  buildOverQuotaWarnings(audit).forEach(warning => lines.push(`- 警告：${warning}`));
  if (audit.overflowed === true) lines.push('- 警告：本次估算已超过输入预算');
  return lines.join('\n');
};
