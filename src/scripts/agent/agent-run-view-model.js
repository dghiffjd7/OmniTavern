const RUNNING_STATUSES = new Set(['queued', 'running', 'waiting_permission']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled']);
// 用户主动停止、复核候选在重启后过期（review_expired）的 run 不计入失败统计/徽章；其余 cancelled（如异常遗留）仍按失败呈现
const USER_CANCELLED_REASONS = new Set(['user_cancelled', 'user_cancelled_pending_workflow', 'review_expired']);
const isUserCancelledRun = (run = {}) => (
  String(run?.status ?? '').trim() === 'cancelled'
  && (
    USER_CANCELLED_REASONS.has(String(run?.cancelReason ?? '').trim())
    || String(run?.metadata?.failureCode ?? '').trim() === 'user_aborted'
  )
);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const toFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeLimit = (value, fallback = 50, max = 500) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, numeric);
};

const normalizeRuns = (runs = []) => {
  if (Array.isArray(runs)) return runs.filter(Boolean);
  if (isPlainObject(runs)) return Object.values(runs).filter(Boolean);
  return [];
};

const normalizeEvents = (events = []) => (
  Array.isArray(events) ? events.filter(Boolean) : []
);

const countBy = (items = [], readKey = item => item) => {
  const counts = {};
  items.forEach((item) => {
    const key = trim(readKey(item), 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
};

const formatTime = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '-';
  try {
    return new Date(numeric).toISOString();
  } catch {
    return String(numeric);
  }
};

const computeDurationMs = (run = {}) => {
  const started = toFiniteNumber(run.createdAt || run.startedAt, 0);
  if (!started) return 0;
  const ended = toFiniteNumber(run.finishedAt || run.updatedAt, 0);
  return ended > started ? ended - started : 0;
};

const readFailureAt = summary => toFiniteNumber(summary.updatedAt || summary.finishedAt || summary.createdAt, 0);

const countUnreadFailures = (summaries = [], seenAt = 0) => {
  const threshold = toFiniteNumber(seenAt, 0);
  return summaries.filter(summary => summary.isFailure && readFailureAt(summary) > threshold).length;
};

const newestFailureAt = (summaries = []) => summaries
  .filter(summary => summary.isFailure)
  .reduce((max, summary) => Math.max(max, readFailureAt(summary)), 0);

const summarizeStep = (step = {}) => ({
  id: trim(step.id || step.stepId),
  type: trim(step.type || step.kind, 'task'),
  status: trim(step.status, 'running'),
  summary: trim(step.summary),
  startedAt: toFiniteNumber(step.startedAt || step.createdAt, 0),
  updatedAt: toFiniteNumber(step.updatedAt, 0),
  finishedAt: toFiniteNumber(step.finishedAt, 0),
  errorMessage: trim(step.errorMessage || step.error),
});

const normalizeDecisionActions = (actions = []) => (
  Array.isArray(actions) ? actions : []
).map(action => ({
  id: trim(action?.id),
  label: trim(action?.label || action?.id),
  enabled: action?.enabled !== false,
})).filter(action => action.id && action.label);

const normalizeLineList = (value = [], limit = 40) => (
  Array.isArray(value) ? value : []
).map(line => String(line ?? '')).slice(0, Math.max(1, Number(limit) || 40));

const normalizeChatFormatModelReviewDetail = (detail = null) => {
  if (!isPlainObject(detail)) return null;
  const correctedTextRaw = String(detail.correctedText ?? '');
  const rawTextRaw = String(detail.rawText ?? '');
  const linePatches = (Array.isArray(detail.linePatches) ? detail.linePatches : [])
    .map(patch => ({
      startLine: toFiniteNumber(patch?.startLine, 0),
      endLine: toFiniteNumber(patch?.endLine, 0),
      reason: trim(patch?.reason),
      originalLines: Array.isArray(patch?.originalLines)
        ? normalizeLineList(patch.originalLines, 20)
        : null,
      replacementLines: normalizeLineList(patch?.replacementLines, 40),
      replacementLineCount: toFiniteNumber(patch?.replacementLineCount, 0),
      replacementLinesTruncated: patch?.replacementLinesTruncated === true,
      originalMatches: patch?.originalMatches === true
        ? true
        : (patch?.originalMatches === false ? false : null),
    }))
    .filter(patch => patch.startLine > 0 && patch.endLine >= patch.startLine)
    .slice(0, 8);
  const issues = (Array.isArray(detail.issues) ? detail.issues : [])
    .map(issue => ({
      severity: trim(issue?.severity, 'warning'),
      type: trim(issue?.type, 'other'),
      message: trim(issue?.message),
      evidence: trim(issue?.evidence),
    }))
    .filter(issue => issue.message)
    .slice(0, 8);
  const normalized = {
    status: trim(detail.status),
    canRepair: detail.canRepair === true,
    repairSummary: trim(detail.repairSummary),
    rawPreview: trim(detail.rawPreview),
    rawText: rawTextRaw.trim() ? rawTextRaw : '',
    rawTextTruncated: detail.rawTextTruncated === true,
    issueCount: toFiniteNumber(detail.issueCount, issues.length),
    patchCount: toFiniteNumber(detail.patchCount, linePatches.length),
    correctedText: correctedTextRaw.trim() ? correctedTextRaw : '',
    correctedTextTruncated: detail.correctedTextTruncated === true,
    linePatches,
    issues,
  };
  if (
    !normalized.status &&
    !normalized.repairSummary &&
    !normalized.rawPreview &&
    !normalized.rawText &&
    !normalized.correctedText &&
    !normalized.linePatches.length &&
    !normalized.issues.length
  ) {
    return null;
  }
  return normalized;
};

const normalizeChatFormatAutoRepair = (autoRepair = null) => {
  if (!isPlainObject(autoRepair)) return null;
  const normalized = {
    autoApplyRepair: autoRepair.autoApplyRepair === true,
    attempted: autoRepair.attempted === true,
    didAnything: autoRepair.didAnything === true,
    reason: trim(autoRepair.reason),
    errorMessage: trim(autoRepair.errorMessage),
    eventCount: toFiniteNumber(autoRepair.eventCount, 0),
    mutatedMoments: autoRepair.mutatedMoments === true,
  };
  if (
    !normalized.autoApplyRepair &&
    !normalized.attempted &&
    !normalized.reason &&
    !normalized.errorMessage &&
    !normalized.eventCount
  ) {
    return null;
  }
  return normalized;
};

const buildChatFormatReview = (run = {}) => {
  const kind = trim(run.kind || run.type);
  const source = trim(run.source);
  if (kind !== 'chat_format_guardian' && source !== 'chat-format-guardian') return null;
  const metadata = isPlainObject(run.metadata) ? run.metadata : {};
  const repair = isPlainObject(metadata.repairCandidate) && metadata.repairCandidate.available === true
    ? {
      available: true,
      kind: trim(metadata.repairCandidate.kind),
      title: trim(metadata.repairCandidate.title, '格式修复'),
      summary: trim(metadata.repairCandidate.summary),
    }
    : null;
  return {
    protocolParseFailure: metadata.protocolParseFailure === true,
    sourceTextKind: trim(metadata.sourceTextKind),
    hasRawOriginal: metadata.hasRawOriginal === true,
    issueCount: toFiniteNumber(metadata.issueCount, 0),
    eventCount: toFiniteNumber(metadata.eventCount, 0),
    errors: (Array.isArray(metadata.errors) ? metadata.errors : []).map(item => trim(item)).filter(Boolean).slice(0, 4),
    warnings: (Array.isArray(metadata.warnings) ? metadata.warnings : []).map(item => trim(item)).filter(Boolean).slice(0, 4),
    repairCandidate: repair,
    modelReviewDetail: normalizeChatFormatModelReviewDetail(metadata.modelReviewDetail),
    autoRepair: normalizeChatFormatAutoRepair(metadata.autoRepair),
    actionLabels: normalizeDecisionActions(metadata.decisionActions)
      .filter(action => action.enabled)
      .map(action => action.label)
      .slice(0, 5),
  };
};

const buildChatBodyQualityReview = (run = {}) => {
  const kind = trim(run.kind || run.type);
  const source = trim(run.source);
  if (kind !== 'chat_body_quality_guardian' && source !== 'chat-body-quality-guardian') return null;
  const metadata = isPlainObject(run.metadata) ? run.metadata : {};
  const patch = isPlainObject(metadata.patchCandidate) && metadata.patchCandidate.available === true
    ? {
      available: true,
      id: trim(metadata.patchCandidate.id),
      title: trim(metadata.patchCandidate.title, '正文优化候选'),
      summary: trim(metadata.patchCandidate.summary),
      risk: trim(metadata.patchCandidate.risk, 'low'),
      preview: trim(metadata.patchCandidate.preview),
    }
    : null;
  return {
    type: 'body_quality',
    sourceTextKind: trim(metadata.sourceTextKind),
    hasRawOriginal: metadata.hasRawOriginal === true,
    issueCount: toFiniteNumber(metadata.issueCount, 0),
    issues: (Array.isArray(metadata.issues) ? metadata.issues : [])
      .map(issue => ({
        id: trim(issue?.id),
        severity: trim(issue?.severity, 'warning'),
        title: trim(issue?.title, '正文质量问题'),
        summary: trim(issue?.summary),
        risk: trim(issue?.risk, 'medium'),
      }))
      .filter(issue => issue.id || issue.title || issue.summary)
      .slice(0, 5),
    patchCandidate: patch,
    actionLabels: normalizeDecisionActions(metadata.decisionActions)
      .filter(action => action.enabled)
      .map(action => action.label)
      .slice(0, 5),
  };
};

const buildAgentReview = run => buildChatFormatReview(run) || buildChatBodyQualityReview(run);

export const buildAgentRunSummary = (run = {}, {
  events = [],
} = {}) => {
  const steps = Array.isArray(run.steps) ? run.steps.map(summarizeStep) : [];
  const status = trim(run.status, 'unknown');
  const runId = trim(run.id || run.runId);
  const reviewDecision = trim(run.metadata?.reviewDecision);
  const runEvents = normalizeEvents(events).filter(event => trim(event.runId) === runId);
  const lastStep = steps.slice().sort((a, b) => (
    toFiniteNumber(b.updatedAt || b.finishedAt || b.startedAt, 0) -
    toFiniteNumber(a.updatedAt || a.finishedAt || a.startedAt, 0)
  ))[0] || null;
  return {
    id: runId,
    kind: trim(run.kind || run.type, 'task'),
    title: trim(run.title),
    sessionId: trim(run.sessionId),
    source: trim(run.source, 'agent-task-runtime'),
    surface: trim(run.surface || run.metadata?.surface),
    trigger: trim(run.trigger),
    status,
    summary: trim(run.summary),
    errorMessage: trim(run.errorMessage || run.error),
    cancelReason: trim(run.cancelReason),
    reviewDecision,
    reviewedAt: toFiniteNumber(run.metadata?.reviewedAt, 0),
    reviewReason: trim(run.metadata?.reviewReason),
    outcome: trim(run.metadata?.outcome),
    createdAt: toFiniteNumber(run.createdAt || run.startedAt, 0),
    updatedAt: toFiniteNumber(run.updatedAt, 0),
    finishedAt: toFiniteNumber(run.finishedAt, 0),
    durationMs: computeDurationMs(run),
    isActive: RUNNING_STATUSES.has(status),
    isFailure: FAILURE_STATUSES.has(status)
      && !['rejected', 'user_rejected'].includes(reviewDecision)
      && !isUserCancelledRun(run),
    stepCount: steps.length,
    toolCallCount: Array.isArray(run.toolCalls) ? run.toolCalls.length : 0,
    eventCount: runEvents.length,
    stepStatusCounts: countBy(steps, step => step.status),
    lastStep,
    review: buildAgentReview(run),
    goal: trim(run.metadata?.goal),
    continuable: run.metadata?.continuable === true,
    failureCode: trim(run.metadata?.failureCode),
    usage: isPlainObject(run.usage) ? run.usage : null,
    // 女仆每个动作的结果（检索 → 执行 → 自动验证）；有才带
    ...(Array.isArray(run.metadata?.outcomes) && run.metadata.outcomes.length ? { outcomes: run.metadata.outcomes } : {}),
  };
};

const matchesStatusFilter = (summary = {}, status = '') => {
  const statusFilter = trim(status);
  if (statusFilter === 'active') return summary.isActive;
  if (statusFilter === 'failure') return summary.isFailure;
  return statusFilter ? summary.status === statusFilter : true;
};

const matchesScopeFilter = (summary = {}, {
  sessionId = '',
  kind = '',
  source = '',
  surface = '',
  query = '',
} = {}) => {
  const sid = trim(sessionId);
  const kindFilter = trim(kind);
  const sourceFilter = trim(source);
  const surfaceFilter = trim(surface);
  const q = trim(query).toLowerCase();
  if (sid && summary.sessionId !== sid) return false;
  if (kindFilter && summary.kind !== kindFilter) return false;
  if (sourceFilter && summary.source !== sourceFilter) return false;
  if (surfaceFilter && summary.surface !== surfaceFilter) return false;
  if (!q) return true;
  return [
    summary.id,
    summary.kind,
    summary.title,
    summary.sessionId,
    summary.source,
    summary.surface,
    summary.trigger,
    summary.status,
    summary.summary,
    summary.errorMessage,
    summary.lastStep?.type,
    summary.lastStep?.summary,
  ].some(value => trim(value).toLowerCase().includes(q));
};

export const buildAgentRunListView = (runs = [], {
  events = [],
  limit = 50,
  sessionId = '',
  status = '',
  kind = '',
  source = '',
  surface = '',
  query = '',
  failureSeenAt = 0,
} = {}) => {
  const allSummaries = normalizeRuns(runs).map(run => buildAgentRunSummary(run, { events }));
  const scoped = allSummaries
    .filter(summary => matchesScopeFilter(summary, { sessionId, kind, source, surface, query }));
  const filtered = scoped
    .filter(summary => matchesStatusFilter(summary, status))
    .sort((a, b) => (
      toFiniteNumber(b.updatedAt || b.finishedAt || b.createdAt, 0) -
      toFiniteNumber(a.updatedAt || a.finishedAt || a.createdAt, 0)
    ));
  const count = normalizeLimit(limit, 50, 500);
  const visible = filtered.slice(0, count);
  return {
    meta: {
      total: allSummaries.length,
      filtered: filtered.length,
      visible: visible.length,
      active: allSummaries.filter(summary => summary.isActive).length,
      failures: allSummaries.filter(summary => summary.isFailure).length,
      unreadFailures: countUnreadFailures(allSummaries, failureSeenAt),
      newestFailureAt: newestFailureAt(allSummaries),
      scoped: scoped.length,
      scopedActive: scoped.filter(summary => summary.isActive).length,
      scopedFailures: scoped.filter(summary => summary.isFailure).length,
      scopedUnreadFailures: countUnreadFailures(scoped, failureSeenAt),
      scopedNewestFailureAt: newestFailureAt(scoped),
      statusCounts: countBy(allSummaries, summary => summary.status),
      scopedStatusCounts: countBy(scoped, summary => summary.status),
      kindCounts: countBy(allSummaries, summary => summary.kind),
    },
    filters: {
      sessionId: trim(sessionId),
      status: trim(status),
      kind: trim(kind),
      source: trim(source),
      surface: trim(surface),
      query: trim(query),
      failureSeenAt: toFiniteNumber(failureSeenAt, 0),
      limit: count,
    },
    runs: visible,
  };
};

export const buildAgentRunCacheStats = ({
  runs = [],
  events = [],
  maxRuns = 0,
  maxEvents = 0,
} = {}) => {
  const runList = normalizeRuns(runs);
  const eventList = normalizeEvents(events);
  const updatedTimes = runList
    .map(run => toFiniteNumber(run.updatedAt || run.finishedAt || run.createdAt, 0))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return {
    runCount: runList.length,
    eventCount: eventList.length,
    maxRuns: Math.max(0, Math.trunc(Number(maxRuns)) || 0),
    maxEvents: Math.max(0, Math.trunc(Number(maxEvents)) || 0),
    activeRuns: runList.filter(run => RUNNING_STATUSES.has(trim(run.status))).length,
    failedRuns: runList.filter(run => (
      FAILURE_STATUSES.has(trim(run.status)) &&
      !['rejected', 'user_rejected'].includes(trim(run.metadata?.reviewDecision)) &&
      !isUserCancelledRun(run)
    )).length,
    oldestUpdatedAt: updatedTimes[0] || 0,
    newestUpdatedAt: updatedTimes[updatedTimes.length - 1] || 0,
  };
};

// Phase B 只读用量画像：按任务类型(kind)聚合 AgentRun.usage，只呈现真实计量，不做任何自动决策。
// recorded 与 unknown 分别计数；token/latency 只对 recorded 的 run 求和求均，unknown 不参与，绝不估算。
export const buildAgentUsageProfile = (runs = []) => {
  const list = normalizeRuns(runs);
  const byKind = {};
  const overall = { runCount: 0, recordedCount: 0, unknownCount: 0, degradedCount: 0, abortedCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMsSum: 0, modelCalls: 0, toolCalls: 0 };
  list.forEach((run) => {
    const usage = isPlainObject(run.usage) ? run.usage : {};
    const kind = trim(run.kind, 'task');
    if (!byKind[kind]) {
      byKind[kind] = { kind, runCount: 0, recordedCount: 0, unknownCount: 0, degradedCount: 0, abortedCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMsSum: 0, modelCalls: 0, toolCalls: 0 };
    }
    const bucket = byKind[kind];
    const recorded = trim(usage.status) === 'recorded';
    const bump = (target) => {
      target.runCount += 1;
      if (recorded) {
        target.recordedCount += 1;
        target.promptTokens += toFiniteNumber(usage.promptTokens, 0);
        target.completionTokens += toFiniteNumber(usage.completionTokens, 0);
        target.totalTokens += toFiniteNumber(usage.totalTokens, 0);
      } else {
        target.unknownCount += 1;
      }
      if (Number.isFinite(Number(usage.latencyMs))) target.latencyMsSum += toFiniteNumber(usage.latencyMs, 0);
      target.modelCalls += toFiniteNumber(usage.modelCallCount, 0);
      target.toolCalls += toFiniteNumber(usage.toolCallCount, 0);
      if (usage.degraded === true) target.degradedCount += 1;
      if (usage.aborted === true) target.abortedCount += 1;
    };
    bump(bucket);
    bump(overall);
  });
  const finalize = (b) => ({
    ...b,
    avgLatencyMs: b.runCount ? Math.round(b.latencyMsSum / b.runCount) : null,
    avgTotalTokens: b.recordedCount ? Math.round(b.totalTokens / b.recordedCount) : null,
  });
  return {
    overall: finalize(overall),
    byKind: Object.values(byKind).map(finalize).sort((a, b) => b.runCount - a.runCount),
  };
};

export const buildAgentRunDiagnosticsMeta = (view = {}) => {
  const meta = view?.meta || {};
  return `runs=${Number(meta.visible || 0)}/${Number(meta.filtered || 0)} · total=${Number(meta.total || 0)} · active=${Number(meta.active || 0)} · failures=${Number(meta.failures || 0)}`;
};

export const formatAgentRunDiagnostics = (view = {}) => {
  const runs = Array.isArray(view?.runs) ? view.runs : [];
  if (!runs.length) return 'No agent runs';
  const filters = view?.filters || {};
  const header = [
    buildAgentRunDiagnosticsMeta(view),
    `filters: sessionId=${trim(filters.sessionId, '-')} · status=${trim(filters.status, '-')} · kind=${trim(filters.kind, '-')} · source=${trim(filters.source, '-')} · surface=${trim(filters.surface, '-')} · query=${trim(filters.query, '-')}`,
  ];
  const blocks = runs.map((run, index) => {
    const title = run.title ? ` · ${run.title}` : '';
    const error = run.errorMessage ? `\nerror: ${run.errorMessage}` : '';
    const cancel = run.cancelReason ? `\ncancelReason: ${run.cancelReason}` : '';
    const lastStep = run.lastStep
      ? `${run.lastStep.type} [${run.lastStep.status}]${run.lastStep.summary ? ` · ${run.lastStep.summary}` : ''}`
      : '-';
    return [
      `#${index + 1} [${run.status.toUpperCase()}] ${run.kind}${title}`,
      `runId: ${run.id || '-'}`,
      `sessionId: ${run.sessionId || '-'}`,
      `source: ${run.source || '-'}`,
      `surface: ${run.surface || '-'}`,
      `trigger: ${run.trigger || '-'}`,
      `createdAt: ${formatTime(run.createdAt)}`,
      `updatedAt: ${formatTime(run.updatedAt)}`,
      `finishedAt: ${formatTime(run.finishedAt)}`,
      `durationMs: ${run.durationMs || 0}`,
      `steps: ${run.stepCount} · tools: ${run.toolCallCount} · events: ${run.eventCount}`,
      `lastStep: ${lastStep}`,
      `summary: ${run.summary || '-'}`,
      `${error}${cancel}`.trim(),
    ].filter(Boolean).join('\n');
  });
  return [...header, '', ...blocks].join('\n\n');
};
