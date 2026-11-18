import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as swipeRuntime from '../../src/scripts/ui/chat/swipe-runtime-utils.js';
import { createActiveGenerationRecord } from '../../src/scripts/ui/chat/generation-state-utils.js';
import { runSendFinallyFlow } from '../../src/scripts/ui/chat/send-flow-utils.js';

// Exercise the real ChatUI registration seam used by both the arrow and guardian retry.
const source = readFileSync(new URL('../../src/scripts/ui/chat/chat-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  onSwipeRegen(handler)');
const end = source.indexOf('  onSwipeChange(handler)', start);
assert.ok(start >= 0 && end > start);
const makeUi = () => new Function('createSwipeRegenerationHandler',
  `return ({ ${source.slice(start, end)} });`)(swipeRuntime.createSwipeRegenerationHandler);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Reproduce the captured order: both swipes enter async preparation; B overwrites A,
// B hits the bridge lock, then A abandons the unstarted stream as "interrupted".
// The provider double preserves the bridge's lazy async-generator lock semantics.
{
  const ui = makeUi();
  const preparation = deferred();
  const requestBuilt = deferred();
  const requestStarted = deferred();
  let activeGeneration = null;
  let sequence = 0;
  let entered = 0;
  let consumed = 0;
  const bridge = {
    isGenerating: false,
    async generate() {
      if (this.isGenerating) throw new Error('正在生成中，请稍候...');
      this.isGenerating = true;
      requestStarted.resolve();
      await requestBuilt.promise;
      return (async function* () {
        try {
          consumed += 1;
          yield '测试回复';
        } finally {
          bridge.isGenerating = false;
        }
      })();
    },
  };
  ui.onSwipeRegen(async () => {
    entered += 1;
    await preparation.promise;
    const record = createActiveGenerationRecord({ id: ++sequence, sessionId: 'test' });
    activeGeneration = record;
    let sendSucceeded = false;
    try {
      const stream = await bridge.generate();
      if (activeGeneration?.id !== record.id) return false;
      for await (const _chunk of stream) { /* consume as the send pipeline does */ }
      sendSucceeded = true;
      return true;
    } finally {
      runSendFinallyFlow({
        sendSucceeded,
        generationId: record.id,
        getActiveGeneration: () => activeGeneration,
        setActiveGeneration: value => { activeGeneration = value; },
      });
    }
  });
  const attempts = Promise.allSettled([
    ui._swipeRegenHandler({ msgId: 'reply' }),
    ui._swipeRegenHandler({ msgId: 'reply' }),
  ]);
  preparation.resolve();
  await requestStarted.promise;
  // Let the rejected duplicate finish before the first request finishes building.
  await new Promise(resolve => setImmediate(resolve));
  requestBuilt.resolve();
  const outcomes = await attempts;
  assert.equal(bridge.isGenerating, false,
    'overlapping swipe preparation must not leave subsequent requests stuck at 正在生成中，请稍候...');
  assert.equal(entered, 1, 'only one branch may snapshot/rollback/send at a time');
  assert.equal(consumed, 1);
  assert.equal(activeGeneration, null);
  assert.deepEqual(outcomes, [
    { status: 'fulfilled', value: true },
    { status: 'fulfilled', value: false },
  ]);
  assert.equal(await ui._swipeRegenHandler({ msgId: 'reply' }), true, 'next swipe works after completion');
}

for (const failure of ['throw', 'reject', 'early-return']) {
  const ui = makeUi();
  let calls = 0;
  ui.onSwipeRegen(() => {
    calls += 1;
    if (calls > 1) return 'recovered';
    if (failure === 'throw') throw new Error('preparation failed');
    if (failure === 'reject') return Promise.reject(new Error('rollback failed'));
    return false;
  });
  if (failure === 'early-return') assert.equal(await ui._swipeRegenHandler({}), false);
  else await assert.rejects(async () => ui._swipeRegenHandler({}), /failed/);
  assert.equal(await ui._swipeRegenHandler({}), 'recovered', `${failure} must release the guard`);
}

{
  const ui = makeUi();
  ui.onSwipeRegen(function (payload) {
    assert.equal(this, ui, 'preserve the registered callback receiver');
    return payload;
  });
  assert.equal(await ui._swipeRegenHandler('payload'), 'payload');
  ui.onSwipeRegen(null);
  assert.equal(ui._swipeRegenHandler, null, 'unregistering keeps the existing contract');
}
console.log('swipe-generation-concurrency-tests passed');
