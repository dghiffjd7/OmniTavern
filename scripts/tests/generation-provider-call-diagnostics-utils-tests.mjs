import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createGenerationProviderCallDiagnosticsTracker,
  isMeaningfulTextStreamDelta,
} from '../../src/scripts/ui/chat/generation-provider-call-diagnostics-utils.js';

assert.equal(isMeaningfulTextStreamDelta(''), false);
assert.equal(isMeaningfulTextStreamDelta('   \n\t'), false);
assert.equal(isMeaningfulTextStreamDelta({ type: 'reasoning', text: 'internal' }), false);
assert.equal(isMeaningfulTextStreamDelta(' first visible text '), true);
console.log('ok - text stream telemetry skips blank and non-text deltas');

let clock = 1_000;
const tracker = createGenerationProviderCallDiagnosticsTracker({ now: () => clock });

const fcCallId = tracker.start({
  mode: 'provider_fc',
  provider: 'openai',
  model: 'gpt-test',
  stream: true,
});
clock = 1_200;
assert.equal(tracker.observeMeaningfulDelta(fcCallId), true);
clock = 1_500;
assert.equal(tracker.observeMeaningfulDelta(fcCallId), false, 'later samples do not trigger UI snapshots');
clock = 1_600;
tracker.observeUsage(fcCallId, {
  provider: 'openai',
  model: 'gpt-test',
  promptTokens: 100,
  completionTokens: 10,
  totalTokens: 110,
  systemFingerprint: 'fp-call-1',
});
clock = 1_700;
tracker.finish(fcCallId, { outcome: 'fallback' });

const fallbackCallId = tracker.start({
  mode: 'legacy_text_fallback',
  provider: 'openai',
  model: 'gpt-test',
  stream: false,
});
clock = 2_000;
tracker.finish(fallbackCallId, {
  outcome: 'succeeded',
  usage: {
    provider: 'openai',
    model: 'gpt-test',
    promptTokens: 80,
    completionTokens: 6,
    totalTokens: 86,
    responseId: 'response-call-2',
  },
});

const calls = tracker.snapshot();
assert.equal(calls.length, 2);
assert.deepEqual(calls.map(call => call.callIndex), [1, 2]);
assert.equal(calls[0].mode, 'provider_fc');
assert.equal(calls[0].outcome, 'fallback');
assert.equal(calls[0].latencyMs, 700);
assert.equal(calls[0].firstMeaningfulDeltaLatencyMs, 200);
assert.equal(calls[0].outputDurationMs, 500);
assert.equal(calls[0].tokensPerSecond, 20);
assert.equal(calls[0].streamDeltaCount, 2);
assert.equal(calls[0].streamObservedDurationMs, 300);
assert.equal(calls[0].outputSpeedStatus, 'measured');
assert.equal(calls[0].systemFingerprint, 'fp-call-1');
assert.equal(calls[1].mode, 'legacy_text_fallback');
assert.equal(calls[1].latencyMs, 300);
assert.equal(calls[1].firstMeaningfulDeltaLatencyMs, null);
assert.equal(calls[1].tokensPerSecond, null);
assert.equal(calls[1].outputSpeedStatus, 'non_stream');
assert.equal(calls[1].responseId, 'response-call-2');

assert.equal(tracker.markFirstMeaningfulDelta(fcCallId, { at: 2_100 }), false, 'first delta is immutable');
assert.equal(tracker.finish(fcCallId, { outcome: 'failed', completedAt: 2_200 }), false, 'finished calls are immutable');
assert.equal(tracker.getActiveCallId(), '', 'no active call remains after the fallback completes');

clock = 3000;
const burstId = tracker.start({ stream: true });
clock = 86376 + 3000;
assert.equal(tracker.observeMeaningfulDelta(burstId), true);
clock += 18;
tracker.finish(burstId, { usage: { completionTokens: 4337 } });
const burst = tracker.snapshot().at(-1);
assert.equal(burst.tokensPerSecond, null);
assert.equal(burst.streamDeltaCount, 1);
assert.equal(burst.outputSpeedStatus, 'insufficient_samples');
assert.equal(tracker.observeMeaningfulDelta(burstId), false);

const cancelledId = tracker.start({ stream: true });
clock += 100;
tracker.observeMeaningfulDelta(cancelledId);
clock += 800;
tracker.observeMeaningfulDelta(cancelledId);
tracker.finish(cancelledId, { outcome: 'cancelled' });
const cancelled = tracker.snapshot().at(-1);
assert.equal(cancelled.tokensPerSecond, null);
assert.equal(cancelled.completionTokens, null, 'missing usage stays unknown');
assert.equal(cancelled.outputSpeedStatus, 'missing_usage');

// 回归：bridge.generate 的 catch 引用了只在 try 里声明的名字，任何生成错误都会变成
// 「activeProviderCallId is not defined」，盖住真正的错误（聊天模式走这条非流式路径）。
const bridgeSource = readFileSync(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
const generateStart = bridgeSource.indexOf('\n  async generate(');
const tryStart = bridgeSource.indexOf('\n    try {\n', generateStart);
const catchStart = bridgeSource.indexOf('\n    } catch (error) {\n', tryStart);
const finallyStart = bridgeSource.indexOf('\n    } finally {\n', catchStart);
assert.ok(generateStart >= 0 && tryStart > generateStart && catchStart > tryStart && finallyStart > catchStart,
  'locate generate try/catch/finally');
const tryScopedNames = [...bridgeSource.slice(tryStart, catchStart).matchAll(/^ {6}(?:const|let|var) ([A-Za-z_$][\w$]*)/gm)]
  .map(match => match[1]);
assert.ok(tryScopedNames.includes('activeProviderCallId'), 'try-scoped names are detected');
const generateCatchBody = bridgeSource.slice(catchStart, finallyStart);
const leakedIntoCatch = tryScopedNames.filter(name => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(generateCatchBody));
assert.deepEqual(leakedIntoCatch, [], 'generate catch must not reference names declared inside its try');
console.log('ok - bridge.generate catch only uses names in scope');

console.log('generation-provider-call-diagnostics-utils-tests passed');
