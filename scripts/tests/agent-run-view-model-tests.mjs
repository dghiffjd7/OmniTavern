import assert from 'node:assert/strict';

import {
  buildAgentRunCacheStats,
  buildAgentRunDiagnosticsMeta,
  buildAgentRunListView,
  buildAgentRunSummary,
  buildAgentUsageProfile,
  formatAgentRunDiagnostics,
} from '../../src/scripts/agent/agent-run-view-model.js';

{
  // Phase B 只读用量画像：recorded 求和求均，unknown 只计数不参与 token 统计
  const profile = buildAgentUsageProfile([
    { id: 'r1', kind: 'maid_assistant', usage: { status: 'recorded', promptTokens: 1000, completionTokens: 200, totalTokens: 1200, latencyMs: 3000, modelCallCount: 2, toolCallCount: 2, degraded: false, aborted: false } },
    { id: 'r2', kind: 'maid_assistant', usage: { status: 'recorded', promptTokens: 500, completionTokens: 100, totalTokens: 600, latencyMs: 1000, modelCallCount: 1, toolCallCount: 1, degraded: true, aborted: false } },
    { id: 'r3', kind: 'maid_assistant', usage: { status: 'unknown', latencyMs: 800, modelCallCount: 1, toolCallCount: 1, aborted: true } },
    { id: 'r4', kind: 'memory_update', usage: { status: 'recorded', promptTokens: 300, completionTokens: 50, totalTokens: 350, latencyMs: 600, modelCallCount: 1, toolCallCount: 0 } },
  ]);
  assert.equal(profile.overall.runCount, 4);
  assert.equal(profile.overall.recordedCount, 3);
  assert.equal(profile.overall.unknownCount, 1);
  assert.equal(profile.overall.totalTokens, 2150); // 1200+600+350，unknown 的 r3 不计
  assert.equal(profile.overall.degradedCount, 1);
  assert.equal(profile.overall.abortedCount, 1);
  assert.equal(profile.overall.avgTotalTokens, Math.round(2150 / 3));
  const maid = profile.byKind.find(b => b.kind === 'maid_assistant');
  assert.equal(maid.runCount, 3);
  assert.equal(maid.recordedCount, 2);
  assert.equal(maid.unknownCount, 1);
  assert.equal(maid.totalTokens, 1800);
  assert.equal(maid.modelCalls, 4);
  assert.equal(maid.toolCalls, 4);
  assert.equal(maid.avgLatencyMs, Math.round((3000 + 1000 + 800) / 3));
  console.log('ok - buildAgentUsageProfile aggregates recorded usage per kind and excludes unknown tokens');
}

const runs = [
  {
    id: 'run-1',
    kind: 'memory_update',
    sessionId: 's1',
    source: 'memory',
    trigger: 'after_chat',
    status: 'succeeded',
    summary: 'memory done',
    createdAt: 1000,
    updatedAt: 1200,
    finishedAt: 1200,
    steps: [
      { id: 'step-1', type: 'memory.plan', status: 'succeeded', summary: 'planned', updatedAt: 1100 },
      { id: 'step-2', type: 'memory.apply', status: 'succeeded', summary: 'applied', updatedAt: 1200 },
    ],
  },
  {
    id: 'run-2',
    kind: 'image_director_generation',
    sessionId: 's2',
    source: 'image-director-agent',
    status: 'failed',
    summary: 'image failed',
    errorMessage: 'provider unavailable',
    createdAt: 1300,
    updatedAt: 1350,
    finishedAt: 1350,
    steps: [
      { id: 'step-3', type: 'image.generate', status: 'failed', summary: 'failed', errorMessage: 'provider unavailable', updatedAt: 1350 },
    ],
  },
  {
    id: 'run-3',
    kind: 'contact_profile_update',
    sessionId: 's1',
    source: 'contact-profiler-agent',
    status: 'running',
    summary: 'profile running',
    createdAt: 1400,
    updatedAt: 1420,
    steps: [],
  },
];

{
  const summary = buildAgentRunSummary(runs[0], {
    events: [
      { id: 'event-1', runId: 'run-1' },
      { id: 'event-2', runId: 'run-2' },
    ],
  });
  assert.equal(summary.id, 'run-1');
  assert.equal(summary.durationMs, 200);
  assert.equal(summary.stepCount, 2);
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.lastStep.type, 'memory.apply');
  assert.equal(summary.stepStatusCounts.succeeded, 2);
  console.log('ok - buildAgentRunSummary produces compact run state');
}

{
  const view = buildAgentRunListView(runs, {
    events: [{ id: 'event-3', runId: 'run-3' }],
    sessionId: 's1',
    limit: 10,
  });
  assert.equal(view.meta.total, 3);
  assert.equal(view.meta.filtered, 2);
  assert.equal(view.meta.visible, 2);
  assert.equal(view.meta.active, 1);
  assert.equal(view.meta.failures, 1);
  assert.equal(view.meta.unreadFailures, 1);
  assert.equal(view.meta.newestFailureAt, 1350);
  assert.equal(view.meta.scopedUnreadFailures, 0);
  assert.equal(view.meta.scopedNewestFailureAt, 0);
  assert.equal(view.filters.failureSeenAt, 0);
  assert.deepEqual(view.runs.map(run => run.id), ['run-3', 'run-1']);
  assert.equal(buildAgentRunDiagnosticsMeta(view), 'runs=2/2 · total=3 · active=1 · failures=1');
  const text = formatAgentRunDiagnostics(view);
  assert.equal(text.includes('[RUNNING] contact_profile_update'), true);
  assert.equal(text.includes('lastStep: memory.apply [succeeded] · applied'), true);
  console.log('ok - buildAgentRunListView filters sorts and formats diagnostics');
}

{
  const seenView = buildAgentRunListView(runs, {
    failureSeenAt: 1350,
    limit: 10,
  });
  assert.equal(seenView.meta.failures, 1);
  assert.equal(seenView.meta.unreadFailures, 0);
  assert.equal(seenView.meta.newestFailureAt, 1350);
  assert.equal(seenView.filters.failureSeenAt, 1350);
  console.log('ok - buildAgentRunListView separates historical failures from unread failures');
}

{
  const summary = buildAgentRunSummary({
    id: 'run-format',
    kind: 'chat_format_guardian',
    source: 'chat-format-guardian',
    status: 'waiting_permission',
    metadata: {
      protocolParseFailure: true,
      sourceTextKind: 'rawOriginal',
      hasRawOriginal: true,
      eventCount: 1,
      issueCount: 1,
      errors: [],
      warnings: ['time is missing'],
      repairCandidate: {
        available: true,
        kind: 'fill_missing_time',
        title: '补齐时间',
        summary: '补齐 1 条缺失时间',
        replacementText: 'should not be surfaced',
      },
      autoRepair: {
        autoApplyRepair: true,
        attempted: true,
        didAnything: false,
        reason: 'no_events',
        errorMessage: '',
        eventCount: 0,
      },
      modelReviewDetail: {
        status: 'needs_repair',
        canRepair: true,
        repairSummary: '补齐时间。',
        rawPreview: '{"status":"needs_repair"...',
        rawText: '{"status":"needs_repair","correctedText":"完整模型返回"}',
        correctedText: 'MiPhone_start\nmsg_start\n<{{user}}和好友乙的私聊>',
        correctedTextTruncated: false,
        linePatches: [{
          startLine: 2,
          endLine: 2,
          reason: '插入标签',
          originalLines: ['msg_start'],
          replacementLines: ['msg_start', '<{{user}}和好友乙的私聊>'],
          replacementText: 'should not be surfaced',
        }],
      },
      decisionActions: [
        { id: 'apply_repair', label: '应用修复', enabled: true, repairCandidate: { replacementText: 'hidden' } },
        { id: 'review_original', label: '查看原文', enabled: true },
      ],
    },
  });
  assert.equal(summary.review.sourceTextKind, 'rawOriginal');
  assert.equal(summary.review.protocolParseFailure, true);
  assert.equal(summary.review.hasRawOriginal, true);
  assert.deepEqual(summary.review.warnings, ['time is missing']);
  assert.equal(summary.review.repairCandidate.summary, '补齐 1 条缺失时间');
  assert.equal(summary.review.repairCandidate.replacementText, undefined);
  assert.equal(summary.review.autoRepair.autoApplyRepair, true);
  assert.equal(summary.review.autoRepair.attempted, true);
  assert.equal(summary.review.autoRepair.didAnything, false);
  assert.equal(summary.review.autoRepair.reason, 'no_events');
  assert.equal(summary.review.modelReviewDetail.correctedText.includes('MiPhone_start'), true);
  assert.equal(summary.review.modelReviewDetail.rawText.includes('完整模型返回'), true);
  assert.deepEqual(summary.review.modelReviewDetail.linePatches[0].replacementLines, ['msg_start', '<{{user}}和好友乙的私聊>']);
  assert.equal(summary.review.modelReviewDetail.linePatches[0].replacementText, undefined);
  assert.deepEqual(summary.review.actionLabels, ['应用修复', '查看原文']);
  console.log('ok - buildAgentRunSummary exposes safe chat format review metadata');
}

{
  const summary = buildAgentRunSummary({
    id: 'run-body',
    kind: 'chat_body_quality_guardian',
    source: 'chat-body-quality-guardian',
    status: 'waiting_permission',
    metadata: {
      sourceTextKind: 'rawOriginal',
      hasRawOriginal: true,
      issueCount: 1,
      issues: [{
        id: 'consecutive_duplicate_lines',
        severity: 'warning',
        title: '连续重复句段',
        summary: '发现 1 行连续重复正文。',
        risk: 'low',
      }],
      patchCandidate: {
        available: true,
        id: 'body_quality_deterministic_cleanup',
        title: '清理重复正文',
        summary: '移除 1 行连续重复',
        replacementText: 'should not be surfaced',
      },
      decisionActions: [
        { id: 'review_original', label: '查看原文', enabled: true },
        { id: 'open_agent_center', label: 'Agent Center', enabled: true },
      ],
    },
  });
  assert.equal(summary.review.type, 'body_quality');
  assert.equal(summary.review.sourceTextKind, 'rawOriginal');
  assert.equal(summary.review.issueCount, 1);
  assert.equal(summary.review.issues[0].title, '连续重复句段');
  assert.equal(summary.review.patchCandidate.summary, '移除 1 行连续重复');
  assert.equal(summary.review.patchCandidate.replacementText, undefined);
  assert.deepEqual(summary.review.actionLabels, ['查看原文', 'Agent Center']);
  console.log('ok - buildAgentRunSummary exposes safe chat body quality review metadata');
}

{
  const withCancelled = [
    ...runs,
    {
      id: 'run-4',
      kind: 'lineage_layout',
      sessionId: 's3',
      source: 'lineage-agent',
      status: 'cancelled',
      summary: 'cancelled by user',
      createdAt: 1500,
      updatedAt: 1510,
      finishedAt: 1510,
    },
  ];
  const activeView = buildAgentRunListView(withCancelled, { status: 'active', limit: 10 });
  assert.deepEqual(activeView.runs.map(run => run.id), ['run-3']);
  const failureView = buildAgentRunListView(withCancelled, { status: 'failure', limit: 10 });
  assert.deepEqual(failureView.runs.map(run => run.id), ['run-4', 'run-2']);
  assert.equal(failureView.filters.status, 'failure');
  console.log('ok - buildAgentRunListView supports user-facing active and failure status filters');
}

{
  const summary = buildAgentRunSummary({
    id: 'run-reviewed',
    kind: 'chat_format_guardian',
    status: 'cancelled',
    summary: '已打回',
    cancelReason: '用户打回',
    metadata: {
      reviewDecision: 'rejected',
      reviewedAt: 1600,
      reviewReason: '用户打回',
    },
    createdAt: 1500,
    updatedAt: 1600,
    finishedAt: 1600,
  });
  assert.equal(summary.isActive, false);
  assert.equal(summary.isFailure, false);
  assert.equal(summary.reviewDecision, 'rejected');
  assert.equal(summary.reviewedAt, 1600);
  assert.equal(summary.reviewReason, '用户打回');
  const view = buildAgentRunListView([{
    id: 'run-reviewed',
    kind: 'chat_format_guardian',
    status: 'cancelled',
    summary: '已打回',
    metadata: { reviewDecision: 'rejected' },
    createdAt: 1500,
    updatedAt: 1600,
    finishedAt: 1600,
  }], { status: 'failure' });
  assert.equal(view.meta.failures, 0);
  assert.equal(view.runs.length, 0);
  console.log('ok - buildAgentRunSummary exposes user review decisions for waiting runs');
}

{
  const surfaceRuns = [
    ...runs,
    {
      id: 'run-4',
      kind: 'moment_summary',
      sessionId: 'moments',
      source: 'moments-agent',
      surface: 'moments',
      status: 'running',
      summary: 'moments running',
      createdAt: 1500,
      updatedAt: 1510,
    },
  ];
  const view = buildAgentRunListView(surfaceRuns, { surface: 'moments', limit: 10 });
  assert.deepEqual(view.runs.map(run => run.id), ['run-4']);
  assert.equal(view.runs[0].surface, 'moments');
  assert.equal(view.filters.surface, 'moments');
  assert.equal(view.meta.scoped, 1);
  assert.equal(view.meta.scopedActive, 1);
  assert.equal(view.meta.active, 2);
  console.log('ok - buildAgentRunListView supports surface scoped activity');
}

{
  const stats = buildAgentRunCacheStats({
    runs,
    events: [{}, {}, {}],
    maxRuns: 200,
    maxEvents: 1000,
  });
  assert.deepEqual(stats, {
    runCount: 3,
    eventCount: 3,
    maxRuns: 200,
    maxEvents: 1000,
    activeRuns: 1,
    failedRuns: 1,
    oldestUpdatedAt: 1200,
    newestUpdatedAt: 1420,
  });
  assert.equal(formatAgentRunDiagnostics({ runs: [] }), 'No agent runs');
  console.log('ok - buildAgentRunCacheStats summarizes run cache pressure');
}

{
  // 用户主动停止（user_cancelled / user_aborted）不计入失败统计与失败徽章；
  // 无 cancelReason 的异常 cancelled 仍按失败呈现（既有语义不变）
  const userCancelled = buildAgentRunSummary({
    id: 'run-user-cancelled',
    kind: 'maid_assistant',
    status: 'cancelled',
    cancelReason: 'user_cancelled',
    metadata: { failureCode: 'user_aborted' },
    createdAt: 1700,
    updatedAt: 1710,
    finishedAt: 1710,
  });
  assert.equal(userCancelled.isFailure, false);
  const orphanCancelled = buildAgentRunSummary({
    id: 'run-orphan-cancelled',
    kind: 'maid_assistant',
    status: 'cancelled',
    createdAt: 1700,
    updatedAt: 1710,
    finishedAt: 1710,
  });
  assert.equal(orphanCancelled.isFailure, true);
  const view = buildAgentRunListView([
    {
      id: 'run-user-cancelled',
      kind: 'maid_assistant',
      status: 'cancelled',
      cancelReason: 'user_cancelled',
      createdAt: 1700,
      updatedAt: 1710,
      finishedAt: 1710,
    },
    {
      id: 'run-failed',
      kind: 'maid_assistant',
      status: 'failed',
      createdAt: 1700,
      updatedAt: 1711,
      finishedAt: 1711,
    },
  ], { status: 'failure' });
  assert.deepEqual(view.runs.map(run => run.id), ['run-failed']);
  assert.equal(view.meta.failures, 1);
  const expiredReview = buildAgentRunSummary({
    id: 'run-review-expired',
    kind: 'chat_format_guardian',
    status: 'cancelled',
    cancelReason: 'review_expired',
    createdAt: 1700,
    updatedAt: 1710,
    finishedAt: 1710,
  });
  assert.equal(expiredReview.isFailure, false, 'an expired repair candidate is not a failure');
  const issuesFound = buildAgentRunSummary({
    id: 'run-issues',
    kind: 'chat_format_guardian',
    status: 'succeeded',
    metadata: { outcome: 'issues_found' },
    createdAt: 1700,
    updatedAt: 1710,
    finishedAt: 1710,
  });
  assert.deepEqual([issuesFound.isFailure, issuesFound.outcome], [false, 'issues_found']);
  console.log('ok - user-initiated cancellations are excluded from failure stats while orphan cancels remain visible');
}
