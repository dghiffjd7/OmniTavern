import assert from 'node:assert/strict';

import {
  buildCompletedResponseDiagnostics,
  buildFirstTokenResponseDiagnostics,
  mergeResponseDiagnosticsIntoUsage,
} from '../../src/scripts/ui/chat/request-response-diagnostics-utils.js';

{
  const first = buildFirstTokenResponseDiagnostics(null, {
    requestStartedAt: 1_000,
    firstTokenAt: 1_640,
    stream: true,
  });
  assert.deepEqual(first, {
    stream: true,
    firstTokenAt: 1640,
    firstTokenLatencyMs: 640,
    firstMeaningfulDeltaAt: 1640,
    firstMeaningfulDeltaLatencyMs: 640,
  });
  const repeated = buildFirstTokenResponseDiagnostics(first, {
    requestStartedAt: 1_000,
    firstTokenAt: 2_000,
    stream: true,
  });
  assert.deepEqual(repeated, first, '首字只允许记录一次');
  console.log('ok - response diagnostics records the first provider token once');
}

{
  const completed = buildCompletedResponseDiagnostics({
    stream: true,
    firstTokenAt: 1_700,
    firstTokenLatencyMs: 700,
    streamDeltaCount: 5,
    lastMeaningfulDeltaAt: 4_000,
  }, {
    requestStartedAt: 1_000,
    completedAt: 4_100,
    usage: {
      promptTokens: 1200,
      completionTokens: 120,
      totalTokens: 1320,
      finishReason: 'stop',
      systemFingerprint: 'fp_alpha',
      modelVersion: 'model-version-alpha',
      responseId: 'response-alpha',
      responseModel: 'actual-model-alpha',
      routedProvider: 'provider-alpha',
    },
  });
  assert.equal(completed.latencyMs, 3100);
  assert.equal(completed.outputDurationMs, 2400);
  assert.equal(completed.tokensPerSecond, 50);
  assert.equal(completed.outputSpeedStatus, 'measured');
  assert.equal(completed.streamObservedDurationMs, 2300);
  assert.equal(completed.systemFingerprint, 'fp_alpha');
  assert.equal(completed.modelVersion, 'model-version-alpha');
  assert.equal(completed.responseId, 'response-alpha');
  assert.equal(completed.responseModel, 'actual-model-alpha');
  assert.equal(completed.routedProvider, 'provider-alpha');
  assert.equal(completed.firstMeaningfulDeltaLatencyMs, 700);
  assert.equal(completed.promptTokens, 1200);
  assert.equal(completed.completionTokens, 120);
  console.log('ok - completed response diagnostics derives TPS from real usage after TTFT');
}

{
  const completed = buildCompletedResponseDiagnostics(null, {
    requestStartedAt: 1_000,
    completedAt: 2_000,
    usage: { completionTokens: null },
  });
  assert.equal(completed.firstTokenLatencyMs, null);
  assert.equal(completed.tokensPerSecond, null);
  assert.equal(completed.completionTokens, null);
  assert.equal(completed.systemFingerprint, '');
  assert.equal(completed.modelVersion, '');
  assert.equal(completed.responseId, '');
  console.log('ok - response diagnostics does not fabricate TTFT, TPS or fingerprint');
}

// Real persisted Union Alpha measurements: long wait followed by a short flush.
for (const [latency, firstLatency, tokens] of [[86394, 86376, 4337], [71871, 71819, 7118]]) {
  const completed = buildCompletedResponseDiagnostics({
    stream: true, firstTokenAt: 1000 + firstLatency, firstTokenLatencyMs: firstLatency,
  }, { requestStartedAt: 1000, completedAt: 1000 + latency, usage: { completionTokens: tokens } });
  assert.equal(completed.tokensPerSecond, null);
  assert.equal(completed.outputSpeedStatus, 'insufficient_samples');
  assert.equal(completed.latencyMs, latency);
  assert.equal(completed.completionTokens, tokens);
}

for (const [count, lastAt] of [[1, 2000], [30, 2018]]) {
  const completed = buildCompletedResponseDiagnostics({
    stream: true, firstTokenAt: 2000, firstTokenLatencyMs: 1000,
    streamDeltaCount: count, lastMeaningfulDeltaAt: lastAt,
  }, { requestStartedAt: 1000, completedAt: 8000, usage: { completionTokens: 4000 } });
  assert.equal(completed.tokensPerSecond, null, 'waiting for usage after a burst is not incremental output');
  assert.equal(completed.outputSpeedStatus, 'insufficient_samples');
}

{
  const completed = buildCompletedResponseDiagnostics({ firstTokenLatencyMs: 200 }, {
    requestStartedAt: 1000, completedAt: 3000, stream: false, usage: { completionTokens: 100 },
  });
  assert.equal(completed.tokensPerSecond, null, 'non-streaming must not reuse a stale first-token time');
  assert.equal(completed.outputSpeedStatus, 'non_stream');
  const usage = mergeResponseDiagnosticsIntoUsage({ tokensPerSecond: 240944.4 }, completed);
  assert.equal(usage.tokensPerSecond, null, 'unavailable speed clears earlier provisional metrics');
  assert.equal(usage.outputSpeedStatus, 'non_stream');
}
console.log('ok - burst delivery, delayed usage and non-streaming never fabricate streaming TPS');
