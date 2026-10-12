import assert from 'node:assert/strict';

import {
  createAssistantStreamRuntime,
  isStreamCtrlConnected,
} from '../../src/scripts/ui/chat/assistant-stream-runtime.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const createCtrl = ({ connected = true } = {}) => {
  const updates = [];
  return {
    updates,
    update(value) {
      updates.push(value);
    },
    isConnected() {
      return connected;
    },
  };
};

test('isStreamCtrlConnected respects controller hooks and handles failures', () => {
  assert.equal(isStreamCtrlConnected(null), false);
  assert.equal(isStreamCtrlConnected({}), true);
  assert.equal(isStreamCtrlConnected({ isConnected: () => true }), true);
  assert.equal(isStreamCtrlConnected({ isConnected: () => false }), false);
  assert.equal(
    isStreamCtrlConnected({
      isConnected: () => {
        throw new Error('boom');
      },
    }),
    false,
  );
});

test('assistant stream runtime reuses shared controller and updates active generation cache', () => {
  let streamCtrl = null;
  const sharedCtrl = createCtrl();
  const activeGeneration = {
    id: 7,
    sessionId: 'session-a',
    streamCtrl: sharedCtrl,
    streamMeta: { existing: true },
  };
  const runtime = createAssistantStreamRuntime({
    generationId: 7,
    sessionId: 'session-a',
    getStreamCtrl: () => streamCtrl,
    setStreamCtrl: (nextCtrl) => {
      streamCtrl = nextCtrl;
      return streamCtrl;
    },
    getActiveGeneration: () => activeGeneration,
    isGenerationInterrupted: () => false,
    isSessionActive: () => true,
    createAssistantStreamCtrl: () => createCtrl(),
    hideTyping: () => {
      throw new Error('should not recreate controller');
    },
    fastForwardDelivery: () => {
      throw new Error('should not recreate controller');
    },
  });

  const payload = { content: '预览', raw: 'preview-raw' };
  runtime.updateActiveGenerationStreamCache('预览', { next: true }, payload);

  assert.equal(activeGeneration.streamText, '预览');
  assert.notEqual(activeGeneration.streamPayload, payload);
  assert.deepEqual(activeGeneration.streamPayload, payload);
  assert.deepEqual(activeGeneration.streamMeta, { existing: true, next: true });
  assert.equal(runtime.ensureAssistantStreamCtrl({ avatar: 'assistant.png' }), sharedCtrl);
  assert.equal(streamCtrl, sharedCtrl);
});

test('assistant stream runtime creates controllers, pushes payloads, and supports reattach', () => {
  let streamCtrl = null;
  const created = [];
  const lifecycle = [];
  const activeGeneration = {
    id: 9,
    sessionId: 'session-b',
    streamCtrl: null,
    streamMeta: null,
    streamPayload: null,
    streamText: '',
  };
  const runtime = createAssistantStreamRuntime({
    generationId: 9,
    sessionId: 'session-b',
    getStreamCtrl: () => streamCtrl,
    setStreamCtrl: (nextCtrl) => {
      streamCtrl = nextCtrl;
      return streamCtrl;
    },
    getActiveGeneration: () => activeGeneration,
    isGenerationInterrupted: () => false,
    isSessionActive: () => true,
    createAssistantStreamCtrl: (meta) => {
      const ctrl = createCtrl();
      ctrl.meta = meta;
      created.push(ctrl);
      return ctrl;
    },
    hideTyping: () => lifecycle.push('hide'),
    fastForwardDelivery: (sid) => lifecycle.push(`fast:${sid}`),
  });

  const firstCtrl = runtime.pushAssistantStreamText(
    {
      content: '第一段',
      raw: 'first-raw',
    },
    { avatar: 'assistant.png' },
  );

  assert.equal(created.length, 1);
  assert.equal(firstCtrl, created[0]);
  assert.deepEqual(firstCtrl.updates, [{ content: '第一段', raw: 'first-raw' }]);
  assert.deepEqual(lifecycle, ['hide', 'fast:session-b']);
  assert.equal(activeGeneration.streamCtrl, firstCtrl);
  assert.deepEqual(activeGeneration.streamMeta, { avatar: 'assistant.png' });

  runtime.bindActiveGenerationReattach();
  streamCtrl = null;
  activeGeneration.streamCtrl = null;
  const reattached = activeGeneration.reattachStream();

  assert.equal(reattached, true);
  assert.equal(created.length, 2);
  assert.deepEqual(created[1].updates, [{ content: '第一段', raw: 'first-raw' }]);
});

test('assistant stream runtime reads the generation id assigned after creation', () => {
  // app.js 在分配 generationId 之前就创建 runtime：按创建时的 0 比对会永远对不上当前生成，
  // 终止时 generation 上既没有 streamCtrl 也没有 streamText，已输出的部分回复不会保存。
  let generationId = 0;
  let streamCtrl = null;
  const activeGeneration = { id: 27, sessionId: 'rp:session', streamCtrl: null, streamMeta: null, streamPayload: null, streamText: '' };
  const runtime = createAssistantStreamRuntime({
    generationId,
    getGenerationId: () => generationId,
    sessionId: 'rp:session',
    getStreamCtrl: () => streamCtrl,
    setStreamCtrl: (nextCtrl) => {
      streamCtrl = nextCtrl;
      return streamCtrl;
    },
    getActiveGeneration: () => activeGeneration,
    isGenerationInterrupted: id => id !== activeGeneration.id,
    isSessionActive: () => true,
    createAssistantStreamCtrl: () => createCtrl(),
  });
  generationId = 27;
  runtime.bindActiveGenerationReattach();
  const ctrl = runtime.pushAssistantStreamText('已输出的正文');

  assert.ok(ctrl);
  assert.equal(activeGeneration.streamCtrl, ctrl);
  assert.equal(activeGeneration.streamText, '已输出的正文');
  assert.equal(typeof activeGeneration.reattachStream, 'function');
});

test('app send flow passes a live generation id getter to the stream runtime', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const call = source.slice(source.indexOf('} = createAssistantStreamRuntime({'), source.indexOf('} = createAssistantStreamRuntime({') + 200);
  assert.match(call, /getGenerationId: \(\) => generationId,/);
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
