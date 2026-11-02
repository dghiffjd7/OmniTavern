import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  commitAssistantReceiveEffects,
  consumeCreativeAssistantStream,
  consumeLegacyAssistantStream,
  createCreativeAssistantStreamProcessor,
  dispatchAfterSendEvents,
  finalizeBufferedCreativeAssistantResponse,
  finalizeBufferedLegacyAssistantResponse,
  finalizeCreativeStreamAssistantResponse,
  finalizeLegacyStreamAssistantResponse,
  markMessagesAsSending,
  prepareBufferedAssistantResponse,
  runAssistantGenerationRequest,
  runBufferedAssistantResponseFlow,
  runCreativeStreamAssistantResponseFlow,
  runLegacyStreamAssistantResponseFlow,
  syncProtocolResponseTurnCheckpoints,
} from '../../src/scripts/ui/chat/send-side-effect-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('markMessagesAsSending updates store and ui, then returns the latest stored messages', () => {
  const storeMessages = new Map([
    ['m1', { id: 'm1', status: 'pending', content: 'before-1' }],
    ['m2', { id: 'm2', status: 'pending', content: 'before-2' }],
  ]);
  const uiUpdates = [];
  const chatStore = {
    updateMessage(id, patch) {
      const current = storeMessages.get(id);
      const next = { ...current, ...patch, content: `${current.content}-updated` };
      storeMessages.set(id, next);
      return next;
    },
    findMessage(id) {
      return storeMessages.get(id);
    },
  };
  const ui = {
    updateMessage(id, message) {
      uiUpdates.push({ id, message });
    },
  };

  const result = markMessagesAsSending({
    messages: [{ id: 'm1', content: 'local-1' }, { id: 'm2', content: 'local-2' }],
    sessionId: 'session-a',
    chatStore,
    ui,
  });

  assert.deepEqual(result, [
    { id: 'm1', status: 'sending', content: 'before-1-updated' },
    { id: 'm2', status: 'sending', content: 'before-2-updated' },
  ]);
  assert.deepEqual(uiUpdates, [
    { id: 'm1', message: { id: 'm1', status: 'sending', content: 'before-1-updated' } },
    { id: 'm2', message: { id: 'm2', status: 'sending', content: 'before-2-updated' } },
  ]);
});

test('markMessagesAsSending falls back safely when store helpers are missing', () => {
  const result = markMessagesAsSending({
    messages: [{ id: 'm1', content: 'hello' }, { content: 'no-id' }],
  });

  assert.deepEqual(result, [
    { id: 'm1', content: 'hello', status: 'sending' },
    { content: 'no-id', status: 'sending' },
  ]);
});

test('dispatchAfterSendEvents respects skipScripts and still dispatches plugin events', async () => {
  const scriptCalls = [];
  const pluginCalls = [];
  const trace = [];

  dispatchAfterSendEvents({
    messages: [{ id: 'm1' }, { id: 'm2' }],
    sessionId: 'session-a',
    scriptRuntime: {
      dispatchEvent(event, payload) {
        scriptCalls.push({ event, payload });
        return Promise.resolve();
      },
    },
    pluginRuntime: {
      dispatchEvent(event, payload) {
        pluginCalls.push({ event, payload });
        return Promise.resolve();
      },
    },
    skipScripts: true,
    recordTraceEvent: event => trace.push(event),
  });

  await Promise.resolve();

  assert.deepEqual(scriptCalls, []);
  assert.deepEqual(pluginCalls, [
    { event: 'message.after_send', payload: { message: { id: 'm1' }, sessionId: 'session-a' } },
    { event: 'message.after_send', payload: { message: { id: 'm2' }, sessionId: 'session-a' } },
  ]);
  assert.deepEqual(
    trace.map(event => [event.runtimeLabel, event.phase, event.status, event.messageId]),
    [
      ['plugin', 'after_send.start', 'started', 'm1'],
      ['plugin', 'after_send.finish', 'queued', 'm1'],
      ['plugin', 'after_send.start', 'started', 'm2'],
      ['plugin', 'after_send.finish', 'queued', 'm2'],
    ],
  );
});

test('dispatchAfterSendEvents logs rejected runtime dispatches without aborting sibling events', async () => {
  const warnings = [];
  const pluginCalls = [];

  dispatchAfterSendEvents({
    messages: [{ id: 'm1' }],
    sessionId: 'session-b',
    scriptRuntime: {
      dispatchEvent() {
        return Promise.reject(new Error('script failed'));
      },
    },
    pluginRuntime: {
      dispatchEvent(event, payload) {
        pluginCalls.push({ event, payload });
        return Promise.resolve();
      },
    },
    logger: {
      warn(...args) {
        warnings.push(args);
      },
    },
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'script message.after_send failed');
  assert.equal(warnings[0][1]?.message, 'script failed');
  assert.deepEqual(pluginCalls, [
    { event: 'message.after_send', payload: { message: { id: 'm1' }, sessionId: 'session-b' } },
  ]);
});

test('runAssistantGenerationRequest lets scripts finish generation-start hooks before the context is built', async () => {
  const calls = [];
  let release;
  const result = runAssistantGenerationRequest(
    { text: 'hi', sessionId: 's' },
    {
      beforeBuildContext: () => new Promise((resolve) => {
        calls.push(['before']);
        release = () => { calls.push(['before-done']); resolve(); };
      }),
      buildContext: (text) => { calls.push(['context', text]); return {}; },
      appBridge: { generate: () => { calls.push(['generate']); return 'ok'; } },
    },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['before']]);
  release();
  assert.equal(await result, 'ok');
  assert.deepEqual(calls, [['before'], ['before-done'], ['context', 'hi'], ['generate']]);
});

test('creative sends and previews dispatch script generation-start hooks before building the prompt', async () => {
  const source = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(source, /const dispatchScriptGenerationStart = \(\) => \(rpUiMode && !skipScripts\s*\? scriptRuntime\?\.dispatchGenerationStart\?\.\(\{\s*sessionId,\s*type: swipeTarget \? 'swipe' : \(continueTarget \? 'continue' : 'normal'\),\s*dryRun: Boolean\(previewOnly\),\s*input: swipeTarget \|\| continueTarget \? '' : String\(text \|\| ''\),\s*\}\)\s*: null\);/);
  const calls = source.match(/runAssistantGenerationRequest\(\{[\s\S]*?\}, \{[\s\S]*?beforeBuildContext: dispatchScriptGenerationStart,/g) || [];
  assert.equal(calls.length, 2, 'both the real send and the preview pass the hook');
});

test('runAssistantGenerationRequest preserves prompt, context, then bound bridge generate order', async () => {
  const calls = [];
  const context = { messages: [{ role: 'user', content: 'hello' }] };
  const appBridge = {
    marker: 'bridge-instance',
    generate(text, nextContext) {
      calls.push(['generate', this.marker, text, nextContext]);
      return Promise.resolve('generated-stream');
    },
  };

  const result = await runAssistantGenerationRequest(
    {
      text: 'hello',
      sessionId: 'session-a',
    },
    {
      consumePromptInjections: sessionId => calls.push(['inject', sessionId]),
      buildContext: text => {
        calls.push(['context', text]);
        return context;
      },
      appBridge,
    },
  );

	  assert.equal(result, 'generated-stream');
	  assert.deepEqual(calls, [
	    ['context', 'hello'],
	    ['inject', 'session-a'],
	    ['generate', 'bridge-instance', 'hello', context],
	  ]);
});

test('runAssistantGenerationRequest propagates generation errors after prompt and context build', async () => {
  const calls = [];
  const error = new Error('generate failed');

  await assert.rejects(
    () => runAssistantGenerationRequest(
      {
        text: 'hello',
        sessionId: 'session-b',
      },
      {
        consumePromptInjections: sessionId => calls.push(['inject', sessionId]),
        buildContext: text => {
          calls.push(['context', text]);
          return { prompt: text };
        },
        appBridge: {
          generate(text, context) {
            calls.push(['generate', text, context]);
            throw error;
          },
        },
      },
    ),
    error,
  );

	  assert.deepEqual(calls, [
	    ['context', 'hello'],
	    ['inject', 'session-b'],
	    ['generate', 'hello', { prompt: 'hello' }],
	  ]);
});

test('createCreativeAssistantStreamProcessor preserves creative callback wiring', () => {
  const calls = [];
  const bridgeA = { id: 'bridge-a' };
  const bridgeB = { id: 'bridge-b' };
  let currentBridge = bridgeA;
  class FakeStreamProcessor {
    constructor(options) {
      this.options = options;
    }
  }
  const normalizeCreativeLineBreaks = value => `normalized:${value}`;
  const processor = createCreativeAssistantStreamProcessor({
    StreamProcessor: FakeStreamProcessor,
    isRpMode: false,
    isMemoryAutoExtractInline: () => {
      calls.push(['memory-enabled']);
      return true;
    },
    stripTableEditBlocks: source => {
      calls.push(['strip', source]);
      return `stripped:${source}`;
    },
    normalizeCreativeLineBreaks,
    extractStreamingReasoningFromContent: (source, options) => {
      calls.push(['reasoning', source, options]);
      return { content: `reasoning:${source}`, options };
    },
    applyOutputStoredRegexSafe: (source, options) => {
      calls.push(['stored', source, options.appBridge.id, options.depth, options.normalizeText]);
      return `stored:${source}`;
    },
    applyOutputDisplayRegexSafe: (source, options) => {
      calls.push(['display', source, options.appBridge.id, options.depth, options.normalizeText]);
      return `display:${source}`;
    },
    getAppBridge: () => currentBridge,
  });

  assert.equal(processor.options.fps, 18);
  assert.equal(processor.options.normalizeText, normalizeCreativeLineBreaks);
  assert.equal(processor.options.stripRaw('raw'), 'stripped:raw');
  assert.deepEqual(processor.options.extractReasoning('think', { final: true }), {
    content: 'reasoning:think',
    options: { depth: 0, final: true },
  });
  currentBridge = bridgeB;
  assert.equal(processor.options.applyStored('raw-stored'), 'stored:raw-stored');
  assert.equal(processor.options.applyDisplay('raw-display'), 'display:raw-display');
  assert.deepEqual(calls, [
    ['memory-enabled'],
    ['strip', 'raw'],
    ['reasoning', 'think', { depth: 0, final: true }],
    ['stored', 'raw-stored', 'bridge-b', 0, normalizeCreativeLineBreaks],
    ['display', 'raw-display', 'bridge-b', 0, normalizeCreativeLineBreaks],
  ]);
});

test('createCreativeAssistantStreamProcessor keeps raw text in rp mode even when memory extraction is enabled', () => {
  class FakeStreamProcessor {
    constructor(options) {
      this.options = options;
    }
  }
  const processor = createCreativeAssistantStreamProcessor({
    StreamProcessor: FakeStreamProcessor,
    isRpMode: true,
    isMemoryAutoExtractInline: () => true,
    stripTableEditBlocks: source => `stripped:${source}`,
  });

  assert.equal(processor.options.stripRaw('raw'), 'raw');
});

test('prepareBufferedAssistantResponse saves raw then applies memory and summary in legacy order', async () => {
  const calls = [];

  const result = await prepareBufferedAssistantResponse(
    {
      rawText: 'raw<summary>总结</summary>',
      protocolEnabled: false,
      summaryEnabled: () => {
        calls.push(['summary-enabled']);
        return true;
      },
      memoryOptions: { sessionId: 's1', isGroup: false },
    },
    {
      onBeforeRawSave: raw => calls.push(['before-raw', raw]),
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async (raw, options) => {
        calls.push(['memory', raw, options]);
        return { text: 'memory-stripped' };
      },
      extractSummaryBlock: raw => {
        calls.push(['summary', raw]);
        return { text: 'summary-stripped', summary: '总结' };
      },
    },
  );

  assert.deepEqual(result, {
    rawText: 'raw<summary>总结</summary>',
    stripped: 'summary-stripped',
    protocolSummary: '总结',
  });
  assert.deepEqual(calls, [
    ['before-raw', 'raw<summary>总结</summary>'],
    ['raw', 'raw<summary>总结</summary>'],
    ['memory', 'raw<summary>总结</summary>', { sessionId: 's1', isGroup: false }],
    ['summary-enabled'],
    ['summary', 'raw<summary>总结</summary>'],
  ]);
});

test('prepareBufferedAssistantResponse skips memory for protocol responses but keeps summary parsing', async () => {
  const calls = [];

  const result = await prepareBufferedAssistantResponse(
    {
      rawText: 'protocol-raw',
      protocolEnabled: true,
      summaryEnabled: true,
    },
    {
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async () => calls.push(['unexpected-memory']),
      extractSummaryBlock: raw => {
        calls.push(['summary', raw]);
        return { text: 'protocol-text', summary: '协议总结' };
      },
    },
  );

  assert.deepEqual(result, {
    rawText: 'protocol-raw',
    stripped: 'protocol-text',
    protocolSummary: '协议总结',
  });
  assert.deepEqual(calls, [
    ['raw', 'protocol-raw'],
    ['summary', 'protocol-raw'],
  ]);
});

test('prepareBufferedAssistantResponse propagates memory errors after raw save', async () => {
  const calls = [];
  const error = new Error('memory failed');

  await assert.rejects(
    () => prepareBufferedAssistantResponse(
      {
        rawText: 'raw',
        protocolEnabled: false,
        summaryEnabled: true,
      },
      {
        setLastRawResponse: raw => calls.push(['raw', raw]),
        handleMemoryEditsFromRaw: async () => {
          calls.push(['memory']);
          throw error;
        },
        extractSummaryBlock: () => calls.push(['unexpected-summary']),
      },
    ),
    error,
  );

  assert.deepEqual(calls, [
    ['raw', 'raw'],
    ['memory'],
  ]);
});

test('consumeLegacyAssistantStream accumulates content and pushes preview payloads with reasoning meta', async () => {
  const calls = [];
  async function* stream() {
    yield { content: 'A' };
    yield { reasoning: 'think', content: '' };
    yield { content: 'B' };
    yield { content: '', reasoning: '' };
  }
  const nativeReasoningState = { chunks: [] };

  const result = await consumeLegacyAssistantStream(
    stream(),
    {
      streamCtrl: 'initial-ctrl',
      nativeReasoningState,
      streamMeta: { avatar: 'avatar.png', typing: true },
    },
    {
      normalizeChunk: chunk => {
        calls.push(['normalize', chunk.content || chunk.reasoning || 'empty']);
        return chunk;
      },
      isInterrupted: () => false,
      appendReasoningChunk: (state, chunk, options) => {
        state.chunks.push(chunk.reasoning);
        calls.push(['reasoning', chunk.reasoning, options]);
      },
      buildStreamText: raw => {
        calls.push(['strip', raw]);
        return `strip:${raw}`;
      },
      resolveReasoningState: (preview, state, options) => {
        calls.push(['resolve', preview, [...state.chunks], options]);
        return state.chunks.length
          ? {
              reasoning: state.chunks.join('|'),
              reasoningDisplay: `display:${state.chunks.join('|')}`,
              reasoningHidden: true,
              reasoningLabel: 'label',
              reasoningSource: 'native',
            }
          : {};
      },
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload, meta]);
        return `ctrl-${calls.filter(call => call[0] === 'push').length}`;
      },
    },
  );

  assert.equal(result.full, 'AB');
  assert.equal(result.streamCtrl, 'ctrl-3');
  assert.equal(result.nativeReasoningState, nativeReasoningState);
  assert.equal(result.interrupted, false);
  assert.deepEqual(calls, [
    ['normalize', 'A'],
    ['strip', 'A'],
    ['resolve', null, [], { finalize: false }],
    ['push', 'strip:A', {
      avatar: 'avatar.png',
      typing: true,
      reasoning: undefined,
      reasoningDisplay: undefined,
      reasoningHidden: undefined,
      reasoningLabel: undefined,
      reasoningSource: undefined,
    }],
    ['normalize', 'think'],
    ['reasoning', 'think', { depth: 0 }],
    ['strip', 'A'],
    ['resolve', null, ['think'], { finalize: false }],
    ['push', {
      content: 'strip:A',
      raw: 'strip:A',
      rawOriginal: 'A',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      meta: {
        reasoningHidden: true,
        reasoningLabel: 'label',
        reasoningSource: 'native',
      },
    }, {
      avatar: 'avatar.png',
      typing: true,
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      reasoningHidden: true,
      reasoningLabel: 'label',
      reasoningSource: 'native',
    }],
    ['normalize', 'B'],
    ['strip', 'AB'],
    ['resolve', null, ['think'], { finalize: false }],
    ['push', {
      content: 'strip:AB',
      raw: 'strip:AB',
      rawOriginal: 'AB',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      meta: {
        reasoningHidden: true,
        reasoningLabel: 'label',
        reasoningSource: 'native',
      },
    }, {
      avatar: 'avatar.png',
      typing: true,
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      reasoningHidden: true,
      reasoningLabel: 'label',
      reasoningSource: 'native',
    }],
    ['normalize', 'empty'],
  ]);
});

test('consumeLegacyAssistantStream stops before handling an interrupted chunk and preserves current controller', async () => {
  const calls = [];
  async function* stream() {
    yield { content: 'A' };
    yield { content: 'B' };
  }
  let checks = 0;

  const result = await consumeLegacyAssistantStream(
    stream(),
    {
      streamCtrl: 'initial',
      nativeReasoningState: {},
    },
    {
      isInterrupted: () => {
        checks += 1;
        return checks >= 2;
      },
      normalizeChunk: chunk => {
        calls.push(['normalize', chunk.content]);
        return chunk;
      },
      buildStreamText: raw => raw,
      resolveReasoningState: () => ({}),
      pushAssistantStreamText: payload => {
        calls.push(['push', payload]);
        return 'ctrl-a';
      },
    },
  );

  assert.equal(result.full, 'A');
  assert.equal(result.streamCtrl, 'ctrl-a');
  assert.equal(result.interrupted, true);
  assert.deepEqual(calls, [
    ['normalize', 'A'],
    ['push', 'A'],
  ]);
});

test('consumeCreativeAssistantStream pushes rich previews and preserves last snapshot behavior', async () => {
  const calls = [];
  async function* stream() {
    yield { content: 'A' };
    yield { reasoning: 'think', content: '' };
    yield { content: 'B' };
    yield { content: '', reasoning: '' };
  }
  const nativeReasoningState = { chunks: [] };
  const creativeStreamProcessor = {
    lastSnapshot: null,
    append(text) {
      calls.push(['append', text]);
      const raw = text === 'B' ? 'AB' : text;
      this.lastSnapshot = {
        display: `display:${raw}`,
        stored: `stored:${raw}`,
        contentSource: `source:${raw}`,
        raw,
      };
      return this.lastSnapshot;
    },
  };

  const result = await consumeCreativeAssistantStream(
    stream(),
    {
      streamCtrl: 'initial',
      nativeReasoningState,
      streamMeta: { avatar: 'avatar.png', renderRich: true, streamMode: 'creative' },
      creativeStreamProcessor,
    },
    {
      normalizeChunk: chunk => {
        calls.push(['normalize', chunk.content || chunk.reasoning || 'empty']);
        return chunk;
      },
      isInterrupted: () => false,
      appendReasoningChunk: (state, chunk, options) => {
        state.chunks.push(chunk.reasoning);
        calls.push(['reasoning', chunk.reasoning, options]);
      },
      resolveReasoningState: (preview, state, options) => {
        calls.push(['resolve', preview.raw, [...state.chunks], options]);
        return state.chunks.length
          ? {
              reasoning: state.chunks.join('|'),
              reasoningDisplay: `display:${state.chunks.join('|')}`,
              reasoningHidden: true,
              reasoningLabel: 'label',
              reasoningSource: 'native',
            }
          : {};
      },
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload, meta]);
        return `creative-${calls.filter(call => call[0] === 'push').length}`;
      },
    },
  );

  assert.equal(result.full, 'AB');
  assert.equal(result.streamCtrl, 'creative-4');
  assert.equal(result.nativeReasoningState, nativeReasoningState);
  assert.equal(result.interrupted, false);
  assert.deepEqual(calls, [
    ['normalize', 'A'],
    ['append', 'A'],
    ['resolve', 'A', [], { finalize: false }],
    ['push', {
      content: 'display:A',
      raw: 'stored:A',
      rawSource: 'source:A',
      rawOriginal: 'A',
      reasoning: undefined,
      reasoningDisplay: undefined,
      meta: { renderRich: true },
    }, {
      avatar: 'avatar.png',
      renderRich: true,
      streamMode: 'creative',
      raw: 'stored:A',
      rawSource: 'source:A',
      rawOriginal: 'A',
      reasoning: undefined,
      reasoningDisplay: undefined,
      reasoningHidden: undefined,
      reasoningLabel: undefined,
      reasoningSource: undefined,
    }],
    ['normalize', 'think'],
    ['reasoning', 'think', { depth: 0 }],
    ['resolve', 'A', ['think'], { finalize: false }],
    ['push', {
      content: 'display:A',
      raw: 'stored:A',
      rawSource: 'source:A',
      rawOriginal: 'A',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      meta: {
        renderRich: true,
        reasoning: 'think',
        reasoningDisplay: 'display:think',
        reasoningHidden: true,
        reasoningLabel: 'label',
        reasoningSource: 'native',
      },
    }, {
      avatar: 'avatar.png',
      renderRich: true,
      streamMode: 'creative',
      raw: 'stored:A',
      rawSource: 'source:A',
      rawOriginal: 'A',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      reasoningHidden: true,
      reasoningLabel: 'label',
      reasoningSource: 'native',
    }],
    ['normalize', 'B'],
    ['append', 'B'],
    ['resolve', 'AB', ['think'], { finalize: false }],
    ['push', {
      content: 'display:AB',
      raw: 'stored:AB',
      rawSource: 'source:AB',
      rawOriginal: 'AB',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      meta: {
        renderRich: true,
        reasoning: 'think',
        reasoningDisplay: 'display:think',
        reasoningHidden: true,
        reasoningLabel: 'label',
        reasoningSource: 'native',
      },
    }, {
      avatar: 'avatar.png',
      renderRich: true,
      streamMode: 'creative',
      raw: 'stored:AB',
      rawSource: 'source:AB',
      rawOriginal: 'AB',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      reasoningHidden: true,
      reasoningLabel: 'label',
      reasoningSource: 'native',
    }],
    ['normalize', 'empty'],
    ['resolve', 'AB', ['think'], { finalize: false }],
    ['push', {
      content: 'display:AB',
      raw: 'stored:AB',
      rawSource: 'source:AB',
      rawOriginal: 'AB',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      meta: {
        renderRich: true,
        reasoning: 'think',
        reasoningDisplay: 'display:think',
        reasoningHidden: true,
        reasoningLabel: 'label',
        reasoningSource: 'native',
      },
    }, {
      avatar: 'avatar.png',
      renderRich: true,
      streamMode: 'creative',
      raw: 'stored:AB',
      rawSource: 'source:AB',
      rawOriginal: 'AB',
      reasoning: 'think',
      reasoningDisplay: 'display:think',
      reasoningHidden: true,
      reasoningLabel: 'label',
      reasoningSource: 'native',
    }],
  ]);
});

test('consumeCreativeAssistantStream uses an empty fallback preview for reasoning before content', async () => {
  const calls = [];
  async function* stream() {
    yield { reasoning: 'first-thought', content: '' };
  }
  const nativeReasoningState = { chunks: [] };

  const result = await consumeCreativeAssistantStream(
    stream(),
    {
      nativeReasoningState,
      creativeStreamProcessor: { lastSnapshot: null },
    },
    {
      appendReasoningChunk: (state, chunk) => {
        state.chunks.push(chunk.reasoning);
      },
      resolveReasoningState: (preview, state) => {
        calls.push(['resolve', preview, [...state.chunks]]);
        return {
          reasoning: state.chunks.join('|'),
          reasoningDisplay: `display:${state.chunks.join('|')}`,
        };
      },
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload, meta]);
        return 'ctrl';
      },
    },
  );

  assert.equal(result.full, '');
  assert.equal(result.streamCtrl, 'ctrl');
  assert.deepEqual(calls, [
    ['resolve', {
      display: '',
      stored: '',
      contentSource: '',
      raw: '',
      reasoning: '',
      reasoningDisplay: '',
    }, ['first-thought']],
    ['push', {
      content: '',
      raw: '',
      rawSource: '',
      rawOriginal: '',
      reasoning: 'first-thought',
      reasoningDisplay: 'display:first-thought',
      meta: {
        renderRich: true,
        reasoning: 'first-thought',
        reasoningDisplay: 'display:first-thought',
        reasoningHidden: undefined,
        reasoningLabel: undefined,
        reasoningSource: undefined,
      },
    }, {
      raw: '',
      rawSource: '',
      rawOriginal: '',
      reasoning: 'first-thought',
      reasoningDisplay: 'display:first-thought',
      reasoningHidden: undefined,
      reasoningLabel: undefined,
      reasoningSource: undefined,
    }],
  ]);
});

test('consumeCreativeAssistantStream throttles reasoning-only creative previews', async () => {
  const pushed = [];
  const reasoningChunks = [];
  let now = 0;
  async function* stream() {
    yield { content: 'A' };
    now = 10;
    yield { reasoning: 'r1', content: '' };
    now = 50;
    yield { reasoning: 'r2', content: '' };
    now = 240;
    yield { reasoning: 'r3', content: '' };
  }
  const nativeReasoningState = { chunks: [] };
  const creativeStreamProcessor = {
    lastSnapshot: null,
    maxWaitMs: 180,
    now: () => now,
    append(text) {
      this.lastSnapshot = {
        display: text,
        stored: text,
        contentSource: text,
        raw: text,
      };
      return this.lastSnapshot;
    },
  };

  const result = await consumeCreativeAssistantStream(
    stream(),
    {
      nativeReasoningState,
      creativeStreamProcessor,
    },
    {
      appendReasoningChunk: (state, chunk) => {
        state.chunks.push(chunk.reasoning);
        reasoningChunks.push(chunk.reasoning);
      },
      resolveReasoningState: (_preview, state) => {
        if (!state.chunks.length) return {};
        return {
          reasoning: state.chunks.join(''),
          reasoningDisplay: state.chunks.join(''),
        };
      },
      pushAssistantStreamText: payload => {
        pushed.push({
          content: payload.content,
          reasoning: payload.reasoning,
        });
        return `ctrl-${pushed.length}`;
      },
    },
  );

  assert.equal(result.full, 'A');
  assert.equal(result.streamCtrl, 'ctrl-3');
  assert.deepEqual(reasoningChunks, ['r1', 'r2r3']);
  assert.deepEqual(pushed, [
    { content: 'A', reasoning: undefined },
    { content: 'A', reasoning: 'r1' },
    { content: 'A', reasoning: 'r1r2r3' },
  ]);
});

test('consumeCreativeAssistantStream stops before handling an interrupted chunk', async () => {
  const calls = [];
  async function* stream() {
    yield { content: 'A' };
    yield { content: 'B' };
  }
  let checks = 0;
  const creativeStreamProcessor = {
    append(text) {
      calls.push(['append', text]);
      return {
        display: text,
        stored: text,
        contentSource: text,
        raw: text,
      };
    },
  };

  const result = await consumeCreativeAssistantStream(
    stream(),
    {
      streamCtrl: 'initial',
      nativeReasoningState: {},
      creativeStreamProcessor,
    },
    {
      isInterrupted: () => {
        checks += 1;
        return checks >= 2;
      },
      pushAssistantStreamText: payload => {
        calls.push(['push', payload.content]);
        return 'ctrl-a';
      },
    },
  );

  assert.equal(result.full, 'A');
  assert.equal(result.streamCtrl, 'ctrl-a');
  assert.equal(result.interrupted, true);
  assert.deepEqual(calls, [
    ['append', 'A'],
    ['push', 'A'],
  ]);
});

test('runCreativeStreamAssistantResponseFlow preserves post-stream interruption before raw save and finalize', async () => {
  const calls = [];
  async function* stream() {
    yield { content: 'A' };
  }
  let checks = 0;
  const creativeStreamProcessor = {
    append(text) {
      calls.push(['append', text]);
      return {
        display: `display:${text}`,
        stored: `stored:${text}`,
        contentSource: `source:${text}`,
        raw: text,
      };
    },
  };

  const result = await runCreativeStreamAssistantResponseFlow(
    {
      stream: stream(),
      streamCtrl: 'initial',
      nativeReasoningState: {},
      streamMeta: { renderRich: true },
      creativeStreamProcessor,
      sessionId: 'session-a',
    },
    {
      isInterrupted: () => {
        checks += 1;
        return checks >= 2;
      },
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload.content, meta.raw]);
        return 'ctrl-a';
      },
      setLastRawResponse: () => calls.push(['unexpected-raw']),
      handleMemoryEditsFromRaw: async () => calls.push(['unexpected-memory']),
      buildCreativeAssistantMessageParts: () => calls.push(['unexpected-parts']),
    },
  );

  assert.equal(result.full, 'A');
  assert.equal(result.streamCtrl, 'ctrl-a');
  assert.equal(result.interrupted, true);
  assert.equal(result.loopInterrupted, false);
  assert.equal(result.finalizeState, null);
  assert.deepEqual(calls, [
    ['append', 'A'],
    ['push', 'display:A', 'stored:A'],
  ]);
});

test('runCreativeStreamAssistantResponseFlow forwards creative auto-image preserve option to finalize', async () => {
  async function* stream() {
    yield { content: 'plain creative text' };
  }
  const preserveValues = [];

  const result = await runCreativeStreamAssistantResponseFlow(
    {
      stream: stream(),
      streamMeta: { renderRich: true },
      sessionId: 'session-preserve',
    },
    {
      preserveAutoImagePromptPlaceholders: true,
      buildCreativeAssistantMessageParts: options => {
        preserveValues.push(options.preserveAutoImagePromptPlaceholders);
        return {
          finalSource: options.text,
          stored: options.text,
          display: options.text,
          resolvedReasoning: {},
        };
      },
      buildCreativeAssistantMessage: async options => ({
        id: 'parsed-preserve',
        role: 'assistant',
        content: options.parts.display,
      }),
      appendMessage: message => message,
    },
  );

  assert.deepEqual(preserveValues, [true]);
  assert.equal(result.finalizeState?.creativeParts?.display, 'plain creative text');
});

test('runLegacyStreamAssistantResponseFlow consumes stream then finalizes legacy response in order', async () => {
  const calls = [];
  async function* stream() {
    yield { content: 'A' };
  }
  const ctrl = {
    id: 'ctrl-legacy',
    update(display) {
      calls.push(['update', display]);
    },
    finish(message) {
      calls.push(['finish', message.id, message.content]);
    },
  };

  const result = await runLegacyStreamAssistantResponseFlow(
    {
      stream: stream(),
      streamCtrl: null,
      nativeReasoningState: { native: true },
      streamMeta: { typing: true },
      sessionId: 'session-b',
      memoryOptions: { sessionId: 'session-b', isGroup: false },
      avatar: 'assistant.png',
      formatTime: () => '12:30',
    },
    {
      isInterrupted: () => false,
      buildStreamText: raw => {
        calls.push(['build-stream-text', raw]);
        return `preview:${raw}`;
      },
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload, meta]);
        return ctrl;
      },
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async (raw, options) => {
        calls.push(['memory', raw, options]);
        return { text: 'memory-text' };
      },
      summaryEnabled: false,
      buildChatModeAssistantMessageParts: options => {
        calls.push(['parts', options.text, options.nativeReasoningState]);
        return { display: 'display-text' };
      },
      buildChatModeAssistantMessage: options => {
        calls.push(['message', options.rawOriginal, options.id, options.avatar, options.formatTime()]);
        return { id: 'parsed-legacy', content: options.parts.display };
      },
      updateActiveGenerationStreamCache: (display, meta) => calls.push(['cache', display, meta]),
      isStreamCtrlConnected: nextCtrl => {
        calls.push(['connected', nextCtrl?.id || null]);
        return nextCtrl === ctrl;
      },
      isSessionActive: () => {
        calls.push(['unexpected-active']);
        return true;
      },
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return { ...message, id: 'saved-legacy' };
      },
      autoMarkReadIfActive: (sessionId, messageId) => calls.push(['mark-read', sessionId, messageId]),
      emitPluginAfterReceive: (message, sessionId) => calls.push(['after-receive', message?.id, sessionId]),
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.full, 'A');
  assert.equal(result.streamCtrl, ctrl);
  assert.equal(result.interrupted, false);
  assert.equal(result.loopInterrupted, false);
  assert.equal(result.finalizeState?.parsed?.id, 'parsed-legacy');
  assert.deepEqual(calls, [
    ['build-stream-text', 'A'],
    ['push', 'preview:A', {
      typing: true,
      reasoning: undefined,
      reasoningDisplay: undefined,
      reasoningHidden: undefined,
      reasoningLabel: undefined,
      reasoningSource: undefined,
    }],
    ['raw', 'A'],
    ['memory', 'A', { sessionId: 'session-b', isGroup: false }],
    ['parts', 'memory-text', { native: true }],
    ['message', 'A', 'ctrl-legacy', 'assistant.png', '12:30'],
    ['cache', 'display-text', { typing: true }],
    ['connected', 'ctrl-legacy'],
    ['update', 'display-text'],
    ['connected', 'ctrl-legacy'],
    ['finish', 'parsed-legacy', 'display-text'],
    ['append', 'parsed-legacy', 'session-b'],
    ['mark-read', 'session-b', 'saved-legacy'],
    ['after-receive', 'saved-legacy', 'session-b'],
    ['refresh'],
  ]);
});

test('runBufferedAssistantResponseFlow routes protocol responses after raw save and summary parsing', async () => {
  const calls = [];

  const result = await runBufferedAssistantResponseFlow(
    {
      rawText: 'raw<summary>sum</summary>',
      protocolEnabled: true,
      creativeMode: false,
      sessionId: 'session-protocol',
      memoryOptions: { sessionId: 'session-protocol', isGroup: true },
    },
    {
      summaryEnabled: true,
      onBeforeRawSave: raw => calls.push(['before-raw', raw]),
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async () => calls.push(['unexpected-memory']),
      extractSummaryBlock: raw => {
        calls.push(['summary', raw]);
        return { text: 'protocol-text', summary: 'sum' };
      },
      runProtocolBufferedResponse: async input => {
        calls.push([
          'protocol',
          input.rawText,
          input.protocolSummary,
          [...input.summarySessionIds],
          input.memoryOptions,
        ]);
        return { handled: true };
      },
    },
  );

  assert.equal(result.branch, 'protocol');
  assert.equal(result.stripped, 'protocol-text');
  assert.equal(result.protocolSummary, 'sum');
  assert.deepEqual(result.protocolState, { handled: true });
  assert.deepEqual(calls, [
    ['before-raw', 'raw<summary>sum</summary>'],
    ['raw', 'raw<summary>sum</summary>'],
    ['summary', 'raw<summary>sum</summary>'],
    ['protocol', 'raw<summary>sum</summary>', 'sum', ['session-protocol'], {
      sessionId: 'session-protocol',
      isGroup: true,
    }],
  ]);
});

test('runBufferedAssistantResponseFlow routes creative responses and bubbles checkpoint target', async () => {
  const calls = [];

  const result = await runBufferedAssistantResponseFlow(
    {
      rawText: 'raw',
      protocolEnabled: false,
      creativeMode: true,
      sessionId: 'session-creative',
      memoryOptions: { sessionId: 'session-creative', isGroup: false },
      avatar: 'assistant.png',
      formatTime: () => '12:40',
      isRpMode: true,
      isGroupChat: false,
    },
    {
      summaryEnabled: false,
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async (raw, options) => {
        calls.push(['memory', raw, options]);
        return { text: 'memory-text' };
      },
      buildCreativeAssistantMessage: async options => {
        calls.push(['build', options.rawOriginal, options.text, options.sessionId, options.avatar, options.formatTime()]);
        return { id: 'parsed-creative', content: options.text };
      },
      isSessionActive: sessionId => {
        calls.push(['active', sessionId]);
        return true;
      },
      addMessage: message => calls.push(['add-message', message.id, message.content]),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return { ...message, id: 'saved-creative' };
      },
      autoMarkReadIfActive: (sessionId, messageId) => calls.push(['mark-read', sessionId, messageId]),
      emitPluginAfterReceive: (message, sessionId) => calls.push(['after-receive', message?.id, sessionId]),
      isTurnCheckpointSessionEnabled: sessionId => {
        calls.push(['checkpoint-enabled', sessionId]);
        return true;
      },
      syncTurnCheckpointForMessage: (sessionId, message, options) => {
        calls.push(['checkpoint', sessionId, message?.id, options]);
        return Promise.resolve();
      },
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.branch, 'creative');
  assert.equal(result.stripped, 'memory-text');
  assert.equal(result.checkpointTargetMessageId, 'saved-creative');
  assert.deepEqual(calls, [
    ['raw', 'raw'],
    ['memory', 'raw', { sessionId: 'session-creative', isGroup: false }],
    ['build', 'raw', 'memory-text', 'session-creative', 'assistant.png', '12:40'],
    ['active', 'session-creative'],
    ['add-message', 'parsed-creative', 'memory-text'],
    ['append', 'parsed-creative', 'session-creative'],
    ['mark-read', 'session-creative', 'saved-creative'],
    ['after-receive', 'saved-creative', 'session-creative'],
    ['checkpoint-enabled', 'session-creative'],
    ['checkpoint', 'session-creative', 'saved-creative', { captureCurrentActiveState: true }],
    ['refresh'],
  ]);
});

test('finalizeBufferedCreativeAssistantResponse preserves summary, DOM, commit, and checkpoint order', async () => {
  const calls = [];
  const normalizeCreativeLineBreaks = value => `normalized:${value}`;
  const extractReasoningFromContent = value => ({ content: value });
  const applyOutputRegexPairSafe = value => ({ stored: value, display: value });
  const appBridge = { bridge: true };
  const captureAssistantMemoryState = async () => ({ rows: [] });
  const attachAssistantMemoryStateToMeta = meta => meta;

  const result = await finalizeBufferedCreativeAssistantResponse(
    {
      rawText: 'raw',
      stripped: 'stripped-text',
      summary: 'sum',
      sessionId: 'session-a',
      avatar: 'assistant.png',
      formatTime: () => '12:00',
      isRpMode: true,
      isGroupChat: false,
    },
    {
      addSummary: (summary, sessionId) => {
        calls.push(['add-summary', summary, sessionId]);
        throw new Error('summary store failed');
      },
      requestSummaryCompaction: sessionId => {
        calls.push(['compact', sessionId]);
        throw new Error('compact failed');
      },
      buildCreativeAssistantMessage: async options => {
        calls.push([
          'build',
          options.rawOriginal,
          options.text,
          options.sessionId,
          options.avatar,
          options.formatTime(),
          options.summary,
          options.isRpMode,
          options.isGroupChat,
          options.normalizeCreativeLineBreaks('x'),
          options.extractReasoningFromContent('x'),
          options.applyOutputRegexPairSafe('x'),
          options.appBridge,
          options.captureAssistantMemoryState,
          options.attachAssistantMemoryStateToMeta,
        ]);
        return { id: 'parsed-buffered-creative', content: options.text };
      },
      normalizeCreativeLineBreaks,
      extractReasoningFromContent,
      applyOutputRegexPairSafe,
      appBridge,
      captureAssistantMemoryState,
      attachAssistantMemoryStateToMeta,
      isSessionActive: sessionId => {
        calls.push(['active', sessionId]);
        return true;
      },
      addMessage: message => calls.push(['add-message', message.id, message.content]),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return { ...message, id: 'saved-buffered-creative' };
      },
      autoMarkReadIfActive: (sessionId, messageId) => calls.push(['mark-read', sessionId, messageId]),
      emitPluginAfterReceive: (message, sessionId) => calls.push(['after-receive', message?.id, sessionId]),
      isTurnCheckpointSessionEnabled: sessionId => {
        calls.push(['checkpoint-enabled', sessionId]);
        return true;
      },
      syncTurnCheckpointForMessage: (sessionId, message, options) => {
        calls.push(['checkpoint', sessionId, message?.id, options]);
        return Promise.resolve();
      },
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.checkpointTargetMessageId, 'saved-buffered-creative');
  assert.equal(result.summary, 'sum');
  assert.deepEqual(calls, [
    ['add-summary', 'sum', 'session-a'],
    ['compact', 'session-a'],
    ['build', 'raw', 'stripped-text', 'session-a', 'assistant.png', '12:00', 'sum', true, false, 'normalized:x', {
      content: 'x',
    }, {
      stored: 'x',
      display: 'x',
    }, appBridge, captureAssistantMemoryState, attachAssistantMemoryStateToMeta],
    ['active', 'session-a'],
    ['add-message', 'parsed-buffered-creative', 'stripped-text'],
    ['append', 'parsed-buffered-creative', 'session-a'],
    ['mark-read', 'session-a', 'saved-buffered-creative'],
    ['after-receive', 'saved-buffered-creative', 'session-a'],
    ['checkpoint-enabled', 'session-a'],
    ['checkpoint', 'session-a', 'saved-buffered-creative', { captureCurrentActiveState: true }],
    ['refresh'],
  ]);
});

test('finalizeBufferedLegacyAssistantResponse preserves chat-mode build, DOM, and commit order', () => {
  const calls = [];
  const applyChatModeAssistantRegex = value => ({ applied: value });
  const parseSpecialMessage = value => ({ content: value, type: 'text' });

  const result = finalizeBufferedLegacyAssistantResponse(
    {
      rawText: 'raw',
      stripped: 'stripped-text',
      summary: 'sum',
      sessionId: 'session-b',
      avatar: 'assistant.png',
      formatTime: () => '12:01',
    },
    {
      addSummary: (summary, sessionId) => {
        calls.push(['add-summary', summary, sessionId]);
        throw new Error('summary store failed');
      },
      requestSummaryCompaction: sessionId => {
        calls.push(['compact', sessionId]);
        throw new Error('compact failed');
      },
      buildChatModeAssistantMessage: options => {
        calls.push([
          'build',
          options.text,
          options.rawOriginal,
          options.avatar,
          options.formatTime(),
          options.applyChatModeAssistantRegex('x'),
          options.parseSpecialMessage('display'),
        ]);
        return { id: 'parsed-buffered-legacy', content: options.text };
      },
      applyChatModeAssistantRegex,
      parseSpecialMessage,
      isSessionActive: sessionId => {
        calls.push(['active', sessionId]);
        return true;
      },
      addMessage: message => calls.push(['add-message', message.id, message.content]),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return { ...message, id: 'saved-buffered-legacy' };
      },
      autoMarkReadIfActive: (sessionId, messageId) => calls.push(['mark-read', sessionId, messageId]),
      emitPluginAfterReceive: (message, sessionId) => calls.push(['after-receive', message?.id, sessionId]),
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.summary, 'sum');
  assert.deepEqual(calls, [
    ['add-summary', 'sum', 'session-b'],
    ['compact', 'session-b'],
    ['build', 'stripped-text', 'raw', 'assistant.png', '12:01', { applied: 'x' }, {
      content: 'display',
      type: 'text',
    }],
    ['active', 'session-b'],
    ['add-message', 'parsed-buffered-legacy', 'stripped-text'],
    ['append', 'parsed-buffered-legacy', 'session-b'],
    ['mark-read', 'session-b', 'saved-buffered-legacy'],
    ['after-receive', 'saved-buffered-legacy', 'session-b'],
    ['refresh'],
  ]);
});

test('finalizeCreativeStreamAssistantResponse preserves creative final payload, commit, and checkpoint order', async () => {
  const calls = [];
  const nativeReasoningState = { native: true };
  const streamMeta = { avatar: 'avatar.png', renderRich: true, streamMode: 'creative' };
  const finalCtrl = {
    id: 'stream-final',
    finish(message) {
      calls.push(['finish', message.id, message.content]);
    },
  };
  const creativeParts = {
    finalSource: 'final-source',
    stored: 'stored-text',
    display: 'display-text',
    resolvedReasoning: {
      reasoning: 'think',
      reasoningDisplay: 'think-display',
      reasoningHidden: true,
      reasoningLabel: 'reason',
      reasoningSource: 'native',
    },
  };
  const normalizeCreativeLineBreaks = value => `normalized:${value}`;
  const extractReasoningFromContent = value => ({ content: value });
  const resolveReasoningState = value => ({ resolved: value });
  const applyOutputRegexPairSafe = value => ({ stored: value, display: value });
  const appBridge = { bridge: true };
  const captureAssistantMemoryState = async () => ({ rows: [] });
  const attachAssistantMemoryStateToMeta = meta => meta;

  const result = await finalizeCreativeStreamAssistantResponse(
    {
      rawText: 'raw<summary>sum</summary>',
      streamCtrl: { id: 'preview-ctrl' },
      streamMeta,
      nativeReasoningState,
      sessionId: 'session-a',
      memoryOptions: { sessionId: 'session-a', isGroup: false },
      avatar: 'assistant.png',
      formatTime: () => '12:00',
      isRpMode: true,
      isGroupChat: false,
    },
    {
      isSessionActive: sessionId => {
        calls.push(['active', sessionId]);
        return true;
      },
      hideTyping: () => calls.push(['hide-typing']),
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async (raw, options) => {
        calls.push(['memory', raw, options]);
        return { text: 'memory-stripped' };
      },
      summaryEnabled: () => {
        calls.push(['summary-enabled']);
        return true;
      },
      extractSummaryBlock: raw => {
        calls.push(['summary', raw]);
        return { text: 'summary-stripped', summary: 'sum' };
      },
      addSummary: (summary, sessionId) => {
        calls.push(['add-summary', summary, sessionId]);
        throw new Error('summary store failed');
      },
      requestSummaryCompaction: sessionId => {
        calls.push(['compact', sessionId]);
        throw new Error('compact failed');
      },
      buildCreativeAssistantMessageParts: options => {
        calls.push([
          'parts',
          options.text,
          options.nativeReasoningState,
          options.normalizeCreativeLineBreaks('x'),
          options.extractReasoningFromContent('x'),
          options.resolveReasoningState('x'),
          options.applyOutputRegexPairSafe('x'),
          options.appBridge,
        ]);
        return creativeParts;
      },
      buildCreativeAssistantMessage: async options => {
        calls.push([
          'message',
          options.parts.display,
          options.rawOriginal,
          options.sessionId,
          options.id,
          options.includeId,
          options.avatar,
          options.summary,
          options.isRpMode,
          options.isGroupChat,
          options.captureAssistantMemoryState,
          options.attachAssistantMemoryStateToMeta,
        ]);
        return { id: 'parsed-creative', content: options.parts.display };
      },
      normalizeCreativeLineBreaks,
      extractReasoningFromContent,
      resolveReasoningState,
      applyOutputRegexPairSafe,
      appBridge,
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload, meta]);
        return finalCtrl;
      },
      captureAssistantMemoryState,
      attachAssistantMemoryStateToMeta,
      isStreamCtrlConnected: ctrl => {
        calls.push(['connected', ctrl?.id || null]);
        return ctrl === finalCtrl;
      },
      ensureAssistantStreamCtrl: () => calls.push(['unexpected-ensure']),
      addMessage: () => calls.push(['unexpected-add-message']),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return { ...message, id: 'saved-creative' };
      },
      autoMarkReadIfActive: (sessionId, messageId) => calls.push(['mark-read', sessionId, messageId]),
      emitPluginAfterReceive: (message, sessionId) => calls.push(['after-receive', message?.id, sessionId]),
      isTurnCheckpointSessionEnabled: sessionId => {
        calls.push(['checkpoint-enabled', sessionId]);
        return true;
      },
      syncTurnCheckpointForMessage: (sessionId, message, options) => {
        calls.push(['checkpoint', sessionId, message?.id, options]);
        return Promise.resolve();
      },
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.streamCtrl, finalCtrl);
  assert.equal(result.summary, 'sum');
  assert.equal(result.checkpointTargetMessageId, 'saved-creative');
  assert.deepEqual(result.finalStreamPayload, {
    content: 'display-text',
    raw: 'stored-text',
    rawSource: 'final-source',
    rawOriginal: 'raw<summary>sum</summary>',
    reasoning: 'think',
    reasoningDisplay: 'think-display',
    meta: {
      renderRich: true,
      reasoning: 'think',
      reasoningDisplay: 'think-display',
      reasoningHidden: true,
      reasoningLabel: 'reason',
      reasoningSource: 'native',
    },
  });
  assert.deepEqual(result.finalStreamMeta, {
    avatar: 'avatar.png',
    renderRich: true,
    streamMode: 'creative',
    raw: 'stored-text',
    rawSource: 'final-source',
    rawOriginal: 'raw<summary>sum</summary>',
    reasoning: 'think',
    reasoningDisplay: 'think-display',
    reasoningHidden: true,
    reasoningLabel: 'reason',
    reasoningSource: 'native',
  });
  assert.deepEqual(calls, [
    ['active', 'session-a'],
    ['hide-typing'],
    ['raw', 'raw<summary>sum</summary>'],
    ['memory', 'raw<summary>sum</summary>', { sessionId: 'session-a', isGroup: false }],
    ['summary-enabled'],
    ['summary', 'raw<summary>sum</summary>'],
    ['add-summary', 'sum', 'session-a'],
    ['compact', 'session-a'],
    ['parts', 'summary-stripped', nativeReasoningState, 'normalized:x', { content: 'x' }, { resolved: 'x' }, {
      stored: 'x',
      display: 'x',
    }, appBridge],
    ['push', result.finalStreamPayload, result.finalStreamMeta],
    ['message', 'display-text', 'raw<summary>sum</summary>', 'session-a', 'stream-final', true, 'assistant.png', 'sum', true, false, captureAssistantMemoryState, attachAssistantMemoryStateToMeta],
    ['connected', 'stream-final'],
    ['connected', 'stream-final'],
    ['finish', 'parsed-creative', 'display-text'],
    ['append', 'parsed-creative', 'session-a'],
    ['mark-read', 'session-a', 'saved-creative'],
    ['after-receive', 'saved-creative', 'session-a'],
    ['checkpoint-enabled', 'session-a'],
    ['checkpoint', 'session-a', 'saved-creative', { captureCurrentActiveState: true }],
    ['refresh'],
  ]);
});

test('finalizeCreativeStreamAssistantResponse falls back to DOM add when final stream is unavailable', async () => {
  const calls = [];
  const streamMeta = { renderRich: true };

  const result = await finalizeCreativeStreamAssistantResponse(
    {
      rawText: 'raw',
      streamCtrl: null,
      streamMeta,
      sessionId: 'session-b',
    },
    {
      isSessionActive: sessionId => {
        calls.push(['active', sessionId]);
        return true;
      },
      hideTyping: () => calls.push(['hide-typing']),
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async raw => {
        calls.push(['memory', raw]);
        return { text: 'memory-text' };
      },
      summaryEnabled: false,
      buildCreativeAssistantMessageParts: options => {
        calls.push(['parts', options.text]);
        return {
          finalSource: 'source',
          stored: 'stored',
          display: 'display',
          resolvedReasoning: {},
        };
      },
      pushAssistantStreamText: (payload, meta) => {
        calls.push(['push', payload.content, meta.raw]);
        return null;
      },
      buildCreativeAssistantMessage: async options => {
        calls.push(['message', options.id, options.includeId]);
        return { id: 'parsed-fallback', content: options.parts.display };
      },
      isStreamCtrlConnected: ctrl => {
        calls.push(['connected', ctrl?.id || null]);
        return false;
      },
      ensureAssistantStreamCtrl: meta => {
        calls.push(['ensure', meta]);
        return null;
      },
      addMessage: message => calls.push(['add-message', message.id, message.content]),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return message;
      },
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.streamCtrl, null);
  assert.equal(result.summary, '');
  assert.deepEqual(calls, [
    ['active', 'session-b'],
    ['hide-typing'],
    ['raw', 'raw'],
    ['memory', 'raw'],
    ['parts', 'memory-text'],
    ['push', 'display', 'stored'],
    ['message', undefined, true],
    ['connected', null],
    ['active', 'session-b'],
    ['ensure', streamMeta],
    ['connected', null],
    ['active', 'session-b'],
    ['add-message', 'parsed-fallback', 'display'],
    ['append', 'parsed-fallback', 'session-b'],
    ['refresh'],
  ]);
});

test('finalizeLegacyStreamAssistantResponse preserves legacy save, summary, stream, and commit order', async () => {
  const calls = [];
  const nativeReasoningState = { native: true };
  const streamMeta = { avatar: 'avatar.png', typing: true };
  const streamCtrl = {
    id: 'ctrl-1',
    update(display) {
      calls.push(['stream-update', display]);
    },
    finish(message) {
      calls.push(['stream-finish', message.id, message.content]);
    },
  };
  const applyChatModeAssistantRegex = value => ({ applied: value });
  const resolveReasoningState = value => ({ resolved: value });

  const result = await finalizeLegacyStreamAssistantResponse(
    {
      rawText: 'raw<summary>sum</summary>',
      streamCtrl,
      streamMeta,
      nativeReasoningState,
      sessionId: 'session-a',
      memoryOptions: { sessionId: 'session-a', isGroup: false },
      avatar: 'assistant.png',
      formatTime: () => '12:00',
    },
    {
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async (raw, options) => {
        calls.push(['memory', raw, options]);
        return { text: 'memory-stripped' };
      },
      summaryEnabled: () => {
        calls.push(['summary-enabled']);
        return true;
      },
      extractSummaryBlock: raw => {
        calls.push(['summary', raw]);
        return { text: 'summary-stripped', summary: 'sum' };
      },
      addSummary: (summary, sessionId) => {
        calls.push(['add-summary', summary, sessionId]);
        throw new Error('summary store failed');
      },
      buildChatModeAssistantMessageParts: options => {
        calls.push([
          'parts',
          options.text,
          options.nativeReasoningState,
          options.applyChatModeAssistantRegex('x'),
          options.resolveReasoningState('reasoning'),
        ]);
        return { display: 'display-text', stored: 'stored-text' };
      },
      buildChatModeAssistantMessage: options => {
        calls.push([
          'message',
          options.parts.display,
          options.rawOriginal,
          options.id,
          options.includeId,
          options.avatar,
          options.formatTime(),
          options.parseSpecialMessage('display-text'),
        ]);
        return { id: 'parsed-1', content: options.parts.display };
      },
      parseSpecialMessage: value => ({ content: value, type: 'text' }),
      applyChatModeAssistantRegex,
      resolveReasoningState,
      updateActiveGenerationStreamCache: (display, meta) => calls.push(['cache', display, meta]),
      isStreamCtrlConnected: ctrl => {
        calls.push(['connected', ctrl?.id || null]);
        return ctrl === streamCtrl;
      },
      isSessionActive: sessionId => {
        calls.push(['unexpected-active', sessionId]);
        return true;
      },
      ensureAssistantStreamCtrl: () => calls.push(['unexpected-ensure']),
      addMessage: () => calls.push(['unexpected-add-message']),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return { ...message, id: 'saved-1' };
      },
      autoMarkReadIfActive: (sessionId, messageId) => calls.push(['mark-read', sessionId, messageId]),
      emitPluginAfterReceive: (message, sessionId) => calls.push(['after-receive', message?.id, sessionId]),
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.streamCtrl, streamCtrl);
  assert.equal(result.display, 'display-text');
  assert.equal(result.stripped, 'summary-stripped');
  assert.deepEqual(calls, [
    ['raw', 'raw<summary>sum</summary>'],
    ['memory', 'raw<summary>sum</summary>', { sessionId: 'session-a', isGroup: false }],
    ['summary-enabled'],
    ['summary', 'raw<summary>sum</summary>'],
    ['add-summary', 'sum', 'session-a'],
    ['parts', 'summary-stripped', nativeReasoningState, { applied: 'x' }, { resolved: 'reasoning' }],
    ['message', 'display-text', 'raw<summary>sum</summary>', 'ctrl-1', true, 'assistant.png', '12:00', {
      content: 'display-text',
      type: 'text',
    }],
    ['cache', 'display-text', streamMeta],
    ['connected', 'ctrl-1'],
    ['stream-update', 'display-text'],
    ['connected', 'ctrl-1'],
    ['stream-finish', 'parsed-1', 'display-text'],
    ['append', 'parsed-1', 'session-a'],
    ['mark-read', 'session-a', 'saved-1'],
    ['after-receive', 'saved-1', 'session-a'],
    ['refresh'],
  ]);
});

test('finalizeLegacyStreamAssistantResponse falls back to DOM add when the stream controller is unavailable', async () => {
  const calls = [];
  const streamMeta = { typing: true };

  const result = await finalizeLegacyStreamAssistantResponse(
    {
      rawText: 'raw',
      streamCtrl: null,
      streamMeta,
      sessionId: 'session-b',
    },
    {
      setLastRawResponse: raw => calls.push(['raw', raw]),
      handleMemoryEditsFromRaw: async raw => {
        calls.push(['memory', raw]);
        return { text: 'memory-text' };
      },
      summaryEnabled: false,
      buildChatModeAssistantMessageParts: options => {
        calls.push(['parts', options.text]);
        return { display: 'display-text' };
      },
      buildChatModeAssistantMessage: options => {
        calls.push(['message', options.id, options.includeId]);
        return { id: 'parsed-2', content: options.parts.display };
      },
      updateActiveGenerationStreamCache: (display, meta) => calls.push(['cache', display, meta]),
      isStreamCtrlConnected: ctrl => {
        calls.push(['connected', ctrl?.id || null]);
        return false;
      },
      isSessionActive: sessionId => {
        calls.push(['active', sessionId]);
        return true;
      },
      ensureAssistantStreamCtrl: meta => {
        calls.push(['ensure', meta]);
        return null;
      },
      addMessage: message => calls.push(['add-message', message.id, message.content]),
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        return message;
      },
      refreshChatAndContacts: () => calls.push(['refresh']),
    },
  );

  assert.equal(result.streamCtrl, null);
  assert.deepEqual(calls, [
    ['raw', 'raw'],
    ['memory', 'raw'],
    ['parts', 'memory-text'],
    ['message', undefined, true],
    ['cache', 'display-text', streamMeta],
    ['connected', null],
    ['active', 'session-b'],
    ['ensure', streamMeta],
    ['connected', null],
    ['active', 'session-b'],
    ['add-message', 'parsed-2', 'display-text'],
    ['append', 'parsed-2', 'session-b'],
    ['refresh'],
  ]);
});

test('commitAssistantReceiveEffects appends, marks read, dispatches after_receive, then syncs checkpoint', async () => {
  const calls = [];
  const warnings = [];
  const error = new Error('checkpoint failed');

  const result = commitAssistantReceiveEffects({
    parsed: { id: 'parsed-1', role: 'assistant' },
    sessionId: 'session-a',
    appendMessage(message, sessionId) {
      calls.push(['append', message.id, sessionId]);
      return { ...message, id: 'saved-1' };
    },
    autoMarkReadIfActive(sessionId, messageId) {
      calls.push(['markRead', sessionId, messageId]);
    },
    emitPluginAfterReceive(message, sessionId) {
      calls.push(['afterReceive', message?.id, sessionId]);
    },
    isTurnCheckpointSessionEnabled(sessionId) {
      calls.push(['checkpointEnabled', sessionId]);
      return true;
    },
    syncTurnCheckpointForMessage(sessionId, message, options) {
      calls.push(['checkpoint', sessionId, message?.id, options]);
      return Promise.reject(error);
    },
    checkpointWarnMessage: 'checkpoint warn',
    logger: {
      warn(...args) {
        warnings.push(args);
      },
    },
  });

  assert.deepEqual(result, {
    saved: { id: 'saved-1', role: 'assistant' },
    checkpointTargetMessageId: 'saved-1',
  });
  assert.deepEqual(calls, [
    ['append', 'parsed-1', 'session-a'],
    ['markRead', 'session-a', 'saved-1'],
    ['afterReceive', 'saved-1', 'session-a'],
    ['checkpointEnabled', 'session-a'],
    ['checkpoint', 'session-a', 'saved-1', { captureCurrentActiveState: true }],
  ]);

  await Promise.resolve();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'checkpoint warn');
  assert.equal(warnings[0][1], error);
});

test('commitAssistantReceiveEffects commits continuations and skips checkpoint for swipe targets', () => {
  const calls = [];

  const result = commitAssistantReceiveEffects({
    parsed: { id: 'parsed-2', role: 'assistant' },
    sessionId: 'session-b',
    continueTarget: { messageId: 'continue-1' },
    swipeTarget: { msgId: 'swipe-1' },
    commitContinuationMessage(message) {
      calls.push(['commitContinuation', message.id]);
      return { ...message, id: 'continued-1' };
    },
    appendMessage() {
      calls.push(['append']);
      return { id: 'unexpected' };
    },
    autoMarkReadIfActive(sessionId, messageId) {
      calls.push(['markRead', sessionId, messageId]);
    },
    emitPluginAfterReceive(message, sessionId) {
      calls.push(['afterReceive', message?.id, sessionId]);
    },
    isTurnCheckpointSessionEnabled() {
      calls.push(['checkpointEnabled']);
      return true;
    },
    syncTurnCheckpointForMessage() {
      calls.push(['checkpoint']);
    },
  });

  assert.deepEqual(result, {
    saved: { id: 'continued-1', role: 'assistant' },
    checkpointTargetMessageId: 'swipe-1',
  });
  assert.deepEqual(calls, [
    ['commitContinuation', 'parsed-2'],
    ['markRead', 'session-b', 'continued-1'],
    ['afterReceive', 'continued-1', 'session-b'],
    ['checkpointEnabled'],
  ]);
});

test('commitAssistantReceiveEffects can suppress after_receive for transient swipe targets', () => {
  const calls = [];

  const result = commitAssistantReceiveEffects({
    parsed: { id: 'parsed-swipe', role: 'assistant' },
    sessionId: 'session-swipe',
    swipeTarget: { msgId: 'swipe-final', suppressAfterReceive: true },
    appendMessage(message, sessionId) {
      calls.push(['append', message.id, sessionId]);
      return { ...message, id: 'temp-swipe' };
    },
    autoMarkReadIfActive(sessionId, messageId) {
      calls.push(['markRead', sessionId, messageId]);
    },
    emitPluginAfterReceive(message, sessionId) {
      calls.push(['afterReceive', message?.id, sessionId]);
    },
  });

  assert.deepEqual(result, {
    saved: { id: 'temp-swipe', role: 'assistant' },
    checkpointTargetMessageId: 'swipe-final',
  });
  assert.deepEqual(calls, [
    ['append', 'parsed-swipe', 'session-swipe'],
    ['markRead', 'session-swipe', 'temp-swipe'],
  ]);
});

test('commitAssistantReceiveEffects supports legacy append/read/receive without checkpoint wiring', () => {
  const calls = [];

  const result = commitAssistantReceiveEffects({
    parsed: { id: 'parsed-legacy' },
    sessionId: 'session-legacy',
    appendMessage(message, sessionId) {
      calls.push(['append', message.id, sessionId]);
      return { ...message, id: 'saved-legacy' };
    },
    autoMarkReadIfActive(sessionId, messageId) {
      calls.push(['markRead', sessionId, messageId]);
    },
    emitPluginAfterReceive(message, sessionId) {
      calls.push(['afterReceive', message?.id, sessionId]);
    },
  });

  assert.deepEqual(result, {
    saved: { id: 'saved-legacy' },
    checkpointTargetMessageId: 'saved-legacy',
  });
  assert.deepEqual(calls, [
    ['append', 'parsed-legacy', 'session-legacy'],
    ['markRead', 'session-legacy', 'saved-legacy'],
    ['afterReceive', 'saved-legacy', 'session-legacy'],
  ]);
});

test('syncProtocolResponseTurnCheckpoints syncs enabled protocol session tails', async () => {
  const calls = [];

  const result = await syncProtocolResponseTurnCheckpoints({
    protocolState: { didAnything: true, summarySessionIds: new Set(['group:1', 'group:2']) },
    sessionId: 'group:1',
    isTurnCheckpointSessionEnabled: sessionId => sessionId !== 'group:2',
    findTailTrackedAssistantMessage: sessionId => ({ id: `${sessionId}:tail`, role: 'assistant' }),
    syncTurnCheckpointForMessage: async (sessionId, message, options) => {
      calls.push([sessionId, message.id, options]);
    },
  });

  assert.equal(result.checkpointTargetMessageId, 'group:1:tail');
  assert.deepEqual(result.syncedSessionIds, ['group:1']);
  assert.deepEqual(result.failedSessionIds, []);
  assert.deepEqual(calls, [
    ['group:1', 'group:1:tail', { captureCurrentActiveState: true }],
  ]);
});

test('syncProtocolResponseTurnCheckpoints skips invalid protocol output without refreshing old tails', async () => {
  const calls = [];

  const result = await syncProtocolResponseTurnCheckpoints({
    protocolState: { didAnything: false, mutatedMoments: false, summarySessionIds: new Set(['chat:1']) },
    sessionId: 'chat:1',
    isTurnCheckpointSessionEnabled: () => true,
    findTailTrackedAssistantMessage: sessionId => ({ id: `${sessionId}:old-tail`, role: 'assistant' }),
    syncTurnCheckpointForMessage: async (...args) => {
      calls.push(args);
    },
  });

  assert.deepEqual(result, {
    checkpointTargetMessageId: '',
    syncedSessionIds: [],
    failedSessionIds: [],
  });
  assert.deepEqual(calls, []);
});

test('syncProtocolResponseTurnCheckpoints ignores rolled-back moment mutations from a rejected response', async () => {
  const calls = [];

  const result = await syncProtocolResponseTurnCheckpoints({
    protocolState: {
      handled: false,
      didAnything: false,
      mutatedMoments: true,
      summarySessionIds: new Set(['chat:rejected']),
    },
    sessionId: 'chat:rejected',
    isTurnCheckpointSessionEnabled: () => true,
    findTailTrackedAssistantMessage: sessionId => ({ id: `${sessionId}:old-tail`, role: 'assistant' }),
    syncTurnCheckpointForMessage: async (...args) => {
      calls.push(args);
    },
  });

  assert.deepEqual(result, {
    checkpointTargetMessageId: '',
    syncedSessionIds: [],
    failedSessionIds: [],
  });
  assert.deepEqual(calls, []);
});

test('consumeCreativeAssistantStream keeps partial content when the stream errors mid-way', async () => {
  async function* stream() {
    yield { content: '第一段正文' };
    yield { content: '第二段' };
    throw new Error('native http_stream_request failed: error decoding response body');
  }
  const result = await consumeCreativeAssistantStream(
    stream(),
    { streamCtrl: null, nativeReasoningState: { chunks: [] }, streamMeta: {}, creativeStreamProcessor: null },
    { normalizeChunk: chunk => chunk, isInterrupted: () => false },
  );
  assert.equal(result.full, '第一段正文第二段');
  assert.match(result.streamError, /error decoding response body/);
  assert.equal(result.interrupted, false);
});

test('consumeCreativeAssistantStream rethrows when no content arrived before the error', async () => {
  async function* stream() {
    throw new Error('connect failed');
  }
  await assert.rejects(
    () => consumeCreativeAssistantStream(
      stream(),
      { streamCtrl: null, nativeReasoningState: { chunks: [] }, streamMeta: {}, creativeStreamProcessor: null },
      { normalizeChunk: chunk => chunk, isInterrupted: () => false },
    ),
    /connect failed/,
  );
});

test('consumeCreativeAssistantStream rethrows AbortError even with partial content', async () => {
  async function* stream() {
    yield { content: '一些正文' };
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
  await assert.rejects(
    () => consumeCreativeAssistantStream(
      stream(),
      { streamCtrl: null, nativeReasoningState: { chunks: [] }, streamMeta: {}, creativeStreamProcessor: null },
      { normalizeChunk: chunk => chunk, isInterrupted: () => false },
    ),
    { name: 'AbortError' },
  );
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
