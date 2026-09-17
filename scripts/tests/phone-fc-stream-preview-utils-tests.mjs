import assert from 'node:assert/strict';

import {
  createPhoneFcArgumentsPreviewDecoder,
  createPhoneFcProviderStreamRuntime,
  createPhoneFcToolPreviewCollector,
} from '../../src/scripts/ui/chat/phone-fc-stream-preview-utils.js';
import { createDisposableStructuredPreviewRuntime } from '../../src/scripts/ui/chat/structured-response-preview-runtime.js';
import { renderAssistantStreamStateCore } from '../../src/scripts/ui/chat/assistant-stream-ui-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('private preview decodes fragmented JSON strings without exposing its envelope', () => {
  const decoder = createPhoneFcArgumentsPreviewDecoder({ mode: 'private' });
  let state = decoder.push('{"messages":[{"content":"你\\n好，\\u4e');
  assert.equal(state.text, '你\n好，');
  state = decoder.push('16界"},{"content":"第二\\\"句","time":"21:08"}],"summary":"不可见"}');
  assert.equal(state.text, '你\n好，世界\n\n第二"句');
  assert.equal(state.fieldCount, 2);
  assert.equal(state.truncated, false);
  assert.doesNotMatch(state.text, /messages|content|summary|不可见|[{}]/u);
});

test('batch preview only exposes visible content from the first ordered item', () => {
  const decoder = createPhoneFcArgumentsPreviewDecoder({ mode: 'batch' });
  const state = decoder.push(JSON.stringify({
    items: [
      {
        kind: 'moment_post',
        posts: [{
          content: '第一条动态',
          comments: [{ author: '米娅', content: '第一条评论' }],
        }],
      },
      { kind: 'chat', messages: [{ content: '第二项不应预览' }] },
      { kind: 'table_edit', actions: [{ data: { content: '副作用不应预览' } }] },
    ],
  }));
  assert.equal(state.text, '第一条动态\n\n第一条评论');
  assert.equal(state.fieldCount, 2);
  assert.doesNotMatch(state.text, /第二项|副作用/u);
});

test('preview truncates visible text at its local display cap', () => {
  const decoder = createPhoneFcArgumentsPreviewDecoder({ mode: 'private', maxChars: 5 });
  const state = decoder.push('{"messages":[{"content":"123456789"}]}');
  assert.equal(state.text, '12345…');
  assert.equal(state.truncated, true);
});

test('tool collector follows one expected call across id-less argument deltas', () => {
  let tick = 100;
  const collector = createPhoneFcToolPreviewCollector({
    mode: 'private',
    toolName: 'emit_private_reply',
    now: () => tick,
  });
  assert.equal(collector.pushDeltas([{
    phase: 'start',
    toolCallId: 'call-1',
    index: 0,
    toolName: 'other_tool',
  }]).changed, false);
  tick = 125;
  collector.pushDeltas([{
    phase: 'start',
    toolCallId: 'call-2',
    index: 1,
    toolName: 'emit_private_reply',
  }]);
  tick = 140;
  const state = collector.pushDeltas([{
    phase: 'arguments_delta',
    index: 1,
    argumentsDelta: '{"messages":[{"content":"正在输入"',
  }]);
  assert.equal(state.text, '正在输入');
  assert.equal(state.changed, true);
  assert.deepEqual(collector.getDiagnostics(), {
    streamPreviewUsed: true,
    previewUpdateCount: 1,
    previewChars: 4,
    previewFieldCount: 1,
    previewTruncated: false,
    firstPreviewLatencyMs: 40,
  });
});

test('provider stream runtime reports the first expected tool argument delta exactly once', async () => {
  let tick = 1_000;
  const observed = [];
  const client = {
    async *streamChat(_messages, options) {
      options.onProviderToolCallDelta?.({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: { name: 'emit_private_reply', arguments: '' },
            }],
          },
        }],
      }, { provider: 'openai', model: 'test-model' });
      tick = 1_120;
      options.onProviderToolCallDelta?.({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"messages":[' } }] },
        }],
      }, { provider: 'openai', model: 'test-model' });
      tick = 1_180;
      options.onProviderToolCallDelta?.({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"content":"hi"}]}' } }] },
        }],
      }, { provider: 'openai', model: 'test-model' });
    },
  };
  const runtime = createPhoneFcProviderStreamRuntime({
    enabled: true,
    client,
    mode: 'private',
    toolName: 'emit_private_reply',
    onPreview: () => {},
    onFirstArgumentsDelta: event => observed.push(event),
    onArgumentsDelta: event => delivered.push(event),
    now: () => tick,
  });
  const accumulator = (await import('../../src/scripts/agent/provider-tool-call-delta-adapter.js'))
    .createProviderToolCallDeltaAccumulator({ provider: 'openai', model: 'test-model', now: () => tick });
  const delivered = [];
  await runtime.request([], {
    onProviderToolCallDelta: (data, meta) => {
      const next = accumulator.push(data, meta);
      runtime.pushDeltas(next.deltas);
    },
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].at, 1120);
  assert.equal(observed[0].toolName, 'emit_private_reply');
  assert.equal(delivered.length, 2, 'arguments are measured before preview fields become visible');
});

test('disposable preview forces cancellation to discard and leaves no recoverable partial cache', () => {
  let streamCtrl = null;
  let interrupted = false;
  const cancelOptions = [];
  const updates = [];
  const generation = {
    id: 9,
    sessionId: 'session-a',
    streamCtrl: null,
    streamText: '',
    streamPayload: null,
    streamMeta: null,
  };
  const baseCtrl = {
    id: 'preview-bubble',
    isConnected: () => true,
    update: payload => updates.push(payload),
    cancel: options => {
      cancelOptions.push(options);
      return { content: '绝不能返回给取消流程' };
    },
  };
  const runtime = createDisposableStructuredPreviewRuntime({
    generationId: 9,
    sessionId: 'session-a',
    getActiveGeneration: () => generation,
    isGenerationInterrupted: () => interrupted,
    ensureAssistantStreamCtrl: () => baseCtrl,
    getStreamCtrl: () => streamCtrl,
    setStreamCtrl: next => {
      streamCtrl = next;
      return next;
    },
    previewMeta: { avatar: 'maid.png', name: '米娅', time: '21:09' },
  });

  assert.equal(runtime.handle({ phase: 'update', text: '临时正文' }), true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].content, '临时正文');
  assert.equal(updates[0].meta.disposablePreview, true);
  assert.equal(generation.streamText, '');
  assert.equal(generation.streamPayload, null);
  assert.equal(generation.streamCtrl.cancel({ keepPartial: true }), null);
  assert.deepEqual(cancelOptions, [{ keepPartial: false }]);

  interrupted = true;
  assert.equal(runtime.handle({ phase: 'update', text: '中止后不得更新' }), false);
  assert.equal(updates.length, 1);
});

test('disposable preview removes its bubble before fallback and restores typing', () => {
  let streamCtrl = null;
  let fallbackPending = 0;
  let cancelCalls = 0;
  const generation = {
    id: 3,
    sessionId: 'session-b',
    streamCtrl: null,
    streamText: '',
    streamPayload: null,
    streamMeta: null,
  };
  const runtime = createDisposableStructuredPreviewRuntime({
    generationId: 3,
    sessionId: 'session-b',
    getActiveGeneration: () => generation,
    isGenerationInterrupted: () => false,
    ensureAssistantStreamCtrl: () => ({
      id: 'preview-bubble',
      isConnected: () => true,
      update() {},
      cancel(options) {
        assert.deepEqual(options, { keepPartial: false });
        cancelCalls += 1;
        return null;
      },
    }),
    getStreamCtrl: () => streamCtrl,
    setStreamCtrl: next => {
      streamCtrl = next;
      return next;
    },
    onFallbackPending: () => { fallbackPending += 1; },
  });
  runtime.handle({ phase: 'update', text: '会被丢弃' });
  assert.equal(runtime.handle({ phase: 'dispose', outcome: 'fallback' }), true);
  assert.equal(cancelCalls, 1);
  assert.equal(fallbackPending, 1);
  assert.equal(streamCtrl, null);
  assert.equal(generation.streamCtrl, null);
  assert.equal(runtime.getState().active, false);
});

test('hidden structured preview keeps streamed FC capture without mounting the duplicate bubble', () => {
  let streamCtrl = null;
  let ensureCalls = 0;
  let fallbackPending = 0;
  const generation = {
    id: 4,
    sessionId: 'session-hidden-preview',
    streamCtrl: null,
    streamText: '',
    streamPayload: null,
    streamMeta: null,
  };
  const runtime = createDisposableStructuredPreviewRuntime({
    generationId: 4,
    sessionId: 'session-hidden-preview',
    getActiveGeneration: () => generation,
    isGenerationInterrupted: () => false,
    ensureAssistantStreamCtrl: () => {
      ensureCalls += 1;
      return null;
    },
    getStreamCtrl: () => streamCtrl,
    setStreamCtrl: next => {
      streamCtrl = next;
      return next;
    },
    showPreviewBubble: false,
    onFallbackPending: () => { fallbackPending += 1; },
  });

  assert.equal(runtime.handle({ phase: 'update', text: '完整但不应先显示的正文' }), true);
  assert.equal(ensureCalls, 0);
  assert.equal(streamCtrl, null);
  assert.equal(generation.streamCtrl, null);
  assert.equal(runtime.getState().active, false);
  assert.equal(runtime.handle({ phase: 'dispose', outcome: 'fallback' }), true);
  assert.equal(fallbackPending, 1);
});

test('disposable preview renderer uses textContent and never executes sticker or rich rendering', () => {
  const target = { textContent: '', style: {} };
  let stickerCalls = 0;
  let richCalls = 0;
  const message = renderAssistantStreamStateCore({
    messageEl: target,
    wrapperEl: { dataset: {}, __chatappMessage: null },
    state: {
      content: '[bqb-危险预览]<b>仅文字</b>',
      meta: { disposablePreview: true, plainTextOnly: true },
    },
    prepareTextContainer: value => value,
    normalizeAssistantLineBreaks: value => value,
    renderTextWithStickers: () => {
      stickerCalls += 1;
      return true;
    },
    renderRichText: () => { richCalls += 1; },
  });
  assert.equal(target.textContent, '[bqb-危险预览]<b>仅文字</b>');
  assert.equal(target.style.whiteSpace, 'pre-wrap');
  assert.equal(stickerCalls, 0);
  assert.equal(richCalls, 0);
  assert.equal(message.meta.disposablePreview, true);
});

let failed = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    console.log(`ok - ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${entry.name}`);
    console.error(error);
  }
}

if (failed > 0) process.exit(1);
console.log('phone-fc-stream-preview-utils-tests passed');
