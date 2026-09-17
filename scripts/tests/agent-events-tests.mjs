import assert from 'node:assert/strict';

import {
  AGENT_EVENT_TYPES,
  buildAgentTraceEvent,
  normalizeAgentUsage,
  normalizeAgentEvent,
  normalizeAgentRun,
  normalizeAgentStatus,
  normalizeAgentStep,
} from '../../src/scripts/agent/agent-events.js';

{
  const usage = normalizeAgentUsage({
    provider: 'makersuite',
    model: 'gemini-3.7-flash',
    promptTokens: 20,
    completionTokens: 5,
    totalTokens: 25,
    latencyMs: 1600,
    firstTokenLatencyMs: 400,
    firstMeaningfulDeltaLatencyMs: 400,
    outputDurationMs: 1200,
    tokensPerSecond: 4.2,
    systemFingerprint: '',
    modelVersion: 'gemini-3.7-flash-20260801',
    responseId: 'response-1',
    responseModel: 'gemini-3.7-flash-20260801',
    routedProvider: 'google',
    providerCalls: [{
      callIndex: 1,
      mode: 'provider_fc',
      outcome: 'succeeded',
      provider: 'makersuite',
      model: 'gemini-3.7-flash',
      promptTokens: 20,
      completionTokens: 5,
      totalTokens: 25,
      latencyMs: 1600,
      firstMeaningfulDeltaLatencyMs: 400,
      tokensPerSecond: 4.2,
      responseId: 'response-1',
    }],
  });
  assert.equal(usage.firstTokenLatencyMs, 400);
  assert.equal(usage.firstMeaningfulDeltaLatencyMs, 400);
  assert.equal(usage.outputDurationMs, 1200);
  assert.equal(usage.tokensPerSecond, 4.2);
  assert.equal(usage.modelVersion, 'gemini-3.7-flash-20260801');
  assert.equal(usage.responseId, 'response-1');
  assert.equal(usage.providerCalls.length, 1);
  assert.equal(usage.providerCalls[0].mode, 'provider_fc');
  assert.equal(usage.providerCalls[0].tokensPerSecond, 4.2);
  const unavailable = normalizeAgentUsage({
    completionTokens: 4337, outputSpeedStatus: 'insufficient_samples',
    streamDeltaCount: 1, streamObservedDurationMs: 0, tokensPerSecond: null,
    providerCalls: [{ stream: true, streamDeltaCount: 1, streamObservedDurationMs: 0,
      outputSpeedStatus: 'insufficient_samples', tokensPerSecond: null }],
  });
  assert.equal(unavailable.outputSpeedStatus, 'insufficient_samples');
  assert.equal(unavailable.streamDeltaCount, 1);
  assert.equal(unavailable.streamObservedDurationMs, 0);
  assert.equal(unavailable.tokensPerSecond, undefined);
  assert.equal(unavailable.providerCalls[0].tokensPerSecond, null);
  assert.equal(unavailable.providerCalls[0].outputSpeedStatus, 'insufficient_samples');
  console.log('ok - normalizeAgentUsage preserves response telemetry and separate provider calls');
}

{
  const legacyUsage = normalizeAgentUsage({
    provider: 'openai',
    model: 'legacy-telemetry-model',
    firstTokenLatencyMs: 275,
  });
  assert.equal(legacyUsage.firstTokenLatencyMs, 275);
  assert.equal(legacyUsage.firstMeaningfulDeltaLatencyMs, 275);
  console.log('ok - normalizeAgentUsage maps legacy-only first token latency to the canonical metric');
}

{
  assert.equal(normalizeAgentStatus(' success ', 'queued'), 'queued');
  assert.equal(normalizeAgentStatus(' succeeded ', 'queued'), 'succeeded');
  assert.equal(normalizeAgentStatus('failed', 'queued'), 'failed');
  assert.equal(normalizeAgentStatus('', 'running'), 'running');
  console.log('ok - normalizeAgentStatus accepts only stable agent statuses');
}

{
  const step = normalizeAgentStep({
    id: ' step-1 ',
    type: ' memory.update ',
    status: ' succeeded ',
    startedAt: 100,
    finishedAt: 125,
    input: { sessionId: 's1' },
  }, {
    runId: 'run-1',
    now: () => 999,
  });
  assert.deepEqual(step, {
    id: 'step-1',
    runId: 'run-1',
    type: 'memory.update',
    title: '',
    status: 'succeeded',
    summary: '',
    input: { sessionId: 's1' },
    output: null,
    metadata: {},
    errorMessage: '',
    startedAt: 100,
    updatedAt: 125,
    finishedAt: 125,
  });
  console.log('ok - normalizeAgentStep preserves step timing and serializable input');
}

{
  const run = normalizeAgentRun({
    id: ' run-1 ',
    kind: ' memory_update ',
    sessionId: ' s1 ',
    status: ' running ',
    createdAt: 1000,
    metadata: { checkpointMessageId: 'm1' },
    steps: [
      { id: 'step-1', type: 'memory.update', status: 'running', startedAt: 1001 },
    ],
  }, {
    now: () => 2000,
  });
  assert.equal(run.id, 'run-1');
  assert.equal(run.version, 2);
  assert.equal(run.kind, 'memory_update');
  assert.equal(run.sessionId, 's1');
  assert.equal(run.status, 'running');
  assert.equal(run.exportable, true);
  assert.deepEqual(run.metadata, { checkpointMessageId: 'm1' });
  assert.equal(run.steps[0].runId, 'run-1');
  assert.equal(run.steps[0].status, 'running');
  // 未提供 usage：默认 unknown 且 token 字段为 null（绝不估算）
  assert.equal(run.usage.status, 'unknown');
  assert.equal(run.usage.promptTokens, null);
  assert.equal(run.usage.completionTokens, null);
  assert.equal(run.usage.totalTokens, null);
  assert.equal(run.usage.modelCallCount, 0);
  assert.equal(run.usage.toolCallCount, 0);
  assert.equal(run.usage.degraded, false);
  assert.equal(run.usage.aborted, false);
  console.log('ok - normalizeAgentRun builds exportable run records with normalized nested steps');
}

{
  // provider 返回 token → status recorded，total 缺失时由 prompt+completion 推导
  const run = normalizeAgentRun({
    id: 'run-usage',
    kind: 'maid_assistant',
    status: 'succeeded',
    usage: {
      provider: 'deepseek', model: 'deepseek-v4-pro',
      promptTokens: 1200, completionTokens: 300,
      latencyMs: 4200, modelCallCount: 2, toolCallCount: 3, finishReason: 'stop',
    },
  }, { now: () => 5000 });
  assert.equal(run.usage.status, 'recorded');
  assert.equal(run.usage.provider, 'deepseek');
  assert.equal(run.usage.model, 'deepseek-v4-pro');
  assert.equal(run.usage.promptTokens, 1200);
  assert.equal(run.usage.completionTokens, 300);
  assert.equal(run.usage.totalTokens, 1500);
  assert.equal(run.usage.latencyMs, 4200);
  assert.equal(run.usage.modelCallCount, 2);
  assert.equal(run.usage.toolCallCount, 3);
  assert.equal(run.usage.finishReason, 'stop');
  console.log('ok - normalizeAgentRun records real provider usage and derives missing total');
}

{
  // 显式 unknown + 中止/降级：本地事实字段仍保留，token 保持 null
  const run = normalizeAgentRun({
    id: 'run-aborted',
    kind: 'maid_assistant',
    status: 'cancelled',
    usage: { status: 'unknown', provider: 'anthropic', latencyMs: 900, toolCallCount: 1, aborted: true, degraded: true },
  }, { now: () => 6000 });
  assert.equal(run.usage.status, 'unknown');
  assert.equal(run.usage.promptTokens, null);
  assert.equal(run.usage.totalTokens, null);
  assert.equal(run.usage.provider, 'anthropic');
  assert.equal(run.usage.latencyMs, 900);
  assert.equal(run.usage.toolCallCount, 1);
  assert.equal(run.usage.aborted, true);
  assert.equal(run.usage.degraded, true);
  console.log('ok - normalizeAgentRun keeps local facts when provider usage is unknown');
}

{
  const event = normalizeAgentEvent({
    id: ' event-1 ',
    type: AGENT_EVENT_TYPES.runStarted,
    runId: ' run-1 ',
    stepId: ' step-1 ',
    sessionId: ' s1 ',
    source: ' memory-update-runtime ',
    status: ' running ',
    summary: ' started ',
    details: { kind: 'memory_update' },
    createdAt: 3000,
  }, {
    now: () => 9999,
  });
  assert.deepEqual(event, {
    id: 'event-1',
    type: 'agent.run.started',
    runId: 'run-1',
    stepId: 'step-1',
    toolCallId: '',
    sessionId: 's1',
    source: 'memory-update-runtime',
    status: 'running',
    summary: 'started',
    details: { kind: 'memory_update' },
    createdAt: 3000,
  });
  assert.deepEqual(buildAgentTraceEvent(event), {
    category: 'agent',
    phase: 'run.started',
    sessionId: 's1',
    source: 'memory-update-runtime',
    status: 'running',
    startedAt: 3000,
    summary: 'started',
    details: {
      runId: 'run-1',
      stepId: 'step-1',
      toolCallId: '',
      kind: 'memory_update',
    },
  });
  console.log('ok - normalizeAgentEvent and buildAgentTraceEvent expose debug trace friendly events');
}
