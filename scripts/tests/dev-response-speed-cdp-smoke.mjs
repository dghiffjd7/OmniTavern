// Windows WebView smoke: run the real bridge with isolated state and a local
// provider fixture. Never submit a model request or write a chat/config record.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

if (!process.argv.includes('--no-reload')) {
  await evaluateInApp('(() => { setTimeout(() => location.reload(), 50); return true; })()');
}
let ready = false;
for (let attempt = 0; attempt < 80; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 500));
  ready = await evaluateInApp('Boolean(window.__chatappBootDiag?.runtimeReady && window.appBridge?.debugUiRegistry?.stores?.chatStore)');
  if (ready) break;
}
assert.equal(ready, true, 'Wait for the native app and chat store to finish booting');

const result = await evaluateInApp(`(async () => {
  const live = window.appBridge;
  if (live.isGenerating) throw new Error('A live generation is running');
  const { buildPromptOverviewView } = await import('/scripts/ui/chat/prompt-preview-view-utils.js');
  const store = live.debugUiRegistry.stores.chatStore;
  const before = JSON.stringify(store.getMessages(store.getCurrent()));
  const originalRequest = live.lastRequest;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const results = [];
  for (const mode of ['incremental', 'burst', 'non_stream']) {
    const config = { provider: 'custom', model: 'local-speed-fixture', stream: mode !== 'non_stream', maxTokens: 8000 };
    let providerCalls = 0;
    const report = options => options.onProviderUsage?.({ provider: config.provider, model: config.model,
      completionTokens: 4337, finishReason: 'stop' });
    const client = {
      async *streamChat(_messages, options) {
        providerCalls++;
        await wait(160);
        if (mode === 'incremental') {
          yield 'first ';
          await wait(160);
          yield 'second ';
          await wait(160);
          yield 'last';
        } else yield 'first second last';
        report(options);
      },
      async chat(_messages, options) {
        providerCalls++;
        await wait(160);
        report(options);
        return 'first second last';
      },
    };
    // The public facade owns methods bound to the live instance. Start from the
    // class prototype and copy only data so the fixture cannot call that facade.
    const prototype = Object.getPrototypeOf(live);
    const data = Object.fromEntries(Object.entries(live).filter(([, value]) => typeof value !== 'function'));
    const isolated = Object.assign(Object.create(prototype), data, {
      initialized: true, isGenerating: false, previewBuildPromise: null,
      isConfigured: () => true, worldBootstrapCompleted: true,
      ensureWorldsForContext: async () => {}, getRegexContext: () => ({}),
      activeSessionId: 'rp:tps-smoke', scopeId: 'tps-smoke', activeGenerationToken: 0,
      config: { get: () => config }, client, chatStore: null,
      scriptRuntime: null, pluginRuntime: null, debugUiRegistry: { actions: {} },
      lastRequest: null, lastGenerationUsage: null, lastMemoryPlan: null,
      lastWorldInjectionDebug: null, lastDeepSeekFormatDebug: null, lastPhoneFormatTransportPlan: null,
      lastPromptSegmentDebug: null, lastGlobalSemanticPromptAudit: null,
      lastPromptCacheDebugBySession: new Map(), webSearchToolRuntime: null,
      presets: { getResolvedActive: () => null },
      resolveRequestRuntimeConfig: async () => ({ config, client }),
      getRequestPresetContext: () => ({ uiMode: 'rp', sessionId: 'rp:tps-smoke' }),
      getTokenCalibration: () => ({ coefficient: 1, samples: 0 }),
      getGenerationOptions: () => ({}), buildProviderRequestDirectives: () => ({}),
      buildMemoryPromptPlan: async () => null,
      buildMessages: () => [{ role: 'user', content: 'local fixture' }],
      isVariableRuntimeEnabled: () => false,
      emitPromptCacheDebug: () => null,
      saveToHistory: () => { throw new Error('Unexpected chat write'); },
    });
    if (isolated.generate !== prototype.generate) throw new Error('Fixture escaped isolated bridge');
    const generated = await isolated.generate('local fixture', {
      session: { id: 'rp:tps-smoke' },
      meta: { uiMode: 'rp', skipInputRegex: true, skipScripts: true },
    }, { saveHistory: false });
    let text = '';
    if (config.stream) { for await (const chunk of generated) text += chunk; }
    else text = generated;
    const d = isolated.lastRequest.responseDiagnostics;
    const view = buildPromptOverviewView(isolated.lastRequest);
    const root = document.createElement('div');
    root.innerHTML = view.html;
    const call = d.providerCalls[0];
    results.push({ mode, text, providerCalls, outputSpeedStatus: d.outputSpeedStatus,
      tokensPerSecond: d.tokensPerSecond, streamDeltaCount: d.streamDeltaCount,
      streamObservedDurationMs: d.streamObservedDurationMs,
      completionTokens: d.completionTokens, latencyMs: d.latencyMs,
      firstTokenLatencyMs: d.firstTokenLatencyMs,
      callStatus: call.outputSpeedStatus, callSpeed: call.tokensPerSecond,
      usageStatus: isolated.lastGenerationUsage.outputSpeedStatus,
      usageSpeed: isolated.lastGenerationUsage.tokensPerSecond,
      burstExplanation: root.textContent.includes('未观察到持续分段输出，无法测量'),
      nonStreamExplanation: root.textContent.includes('非流式回复无法测量输出速度'),
      speedUnavailable: view.plain.includes('output speed: —'),
    });
  }
  return { ready: !!window.__chatappBootDiag?.runtimeReady, results,
    liveRequestUnchanged: live.lastRequest === originalRequest,
    chatUnchanged: JSON.stringify(store.getMessages(store.getCurrent())) === before };
})()`, { timeoutMs: 30_000 });

assert.equal(result.ready, true);
assert.equal(result.liveRequestUnchanged, true);
assert.equal(result.chatUnchanged, true);
for (const row of result.results) {
  assert.equal(row.text, 'first second last');
  assert.equal(row.providerCalls, 1);
  assert.equal(row.completionTokens, 4337);
  assert.equal(row.callStatus, row.outputSpeedStatus);
  assert.equal(row.usageStatus, row.outputSpeedStatus);
  assert.equal(row.usageSpeed, row.tokensPerSecond);
  if (row.mode === 'incremental') {
    assert.equal(row.outputSpeedStatus, 'measured');
    assert.equal(row.streamDeltaCount, 3);
    assert.ok(row.streamObservedDurationMs >= 300);
    assert.ok(row.tokensPerSecond > 0);
    assert.ok(row.callSpeed > 0);
  } else {
    assert.equal(row.tokensPerSecond, null);
    assert.equal(row.callSpeed, null);
    assert.equal(row.speedUnavailable, true);
    if (row.mode === 'burst') {
      assert.equal(row.outputSpeedStatus, 'insufficient_samples');
      assert.equal(row.streamDeltaCount, 1);
      assert.equal(row.burstExplanation, true);
    } else {
      assert.equal(row.outputSpeedStatus, 'non_stream');
      assert.equal(row.firstTokenLatencyMs, null);
      assert.equal(row.nonStreamExplanation, true);
    }
  }
}
console.log(JSON.stringify(result, null, 2));
