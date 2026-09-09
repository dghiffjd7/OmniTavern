import assert from 'node:assert/strict';
import { createHopscotchTurnRuntime, createHopscotchExecutors } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { normalizeHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
import { editHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-editor-utils.js';
import { createCreativeExecutionInitialState } from '../../src/scripts/ui/chat/creative-execution-lane-runtime-utils.js';
import { createHopscotchSidecarExecutors } from '../../src/scripts/ui/chat/hopscotch-sidecar-executors.js';

const nativeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
try {
  delete globalThis.structuredClone;
  const settings = { memory: { nested: { value: 1 } } };
  const derived = createHopscotchTurnRuntime({
    getSettings: () => ({ creativeHopscotchEnabled: false }),
    boardStore: { resolveEffectiveBoard: ({ derivedBoard }) => ({ board: derivedBoard, source: 'derived' }) },
    resolveWritingSettings: () => settings,
  });
  const plan = derived.resolveExecutionPlan('rp:legacy-empty');
  assert.equal(plan.custom, false);
  assert.equal(plan.source, 'derived');
  plan.memory.nested.value = 2;
  assert.equal(settings.memory.nested.value, 1);
  assert.equal(derived.prepareTurn({ sessionId: 'rp:legacy-empty', rpUiMode: true }), null);

  const board = normalizeHopscotchBoard({ rows: [
    { id: 'before', houses: [{ id: 'pre', kind: 'custom_prompt', config: { prompt: 'Prepare {{user_input}}', includeContext: 'recent', output: { mode: 'context', injectIntoBody: true } } }] },
    { id: 'middle', houses: [{ id: 'body', kind: 'body' }] },
    { id: 'after', houses: [{ id: 'post', kind: 'custom_prompt', config: { prompt: 'Review {{body}} with {{house:pre}}', output: { mode: 'note' } } }] },
  ] });
  const copied = editHopscotchBoard(board, { type: 'copy', id: 'pre' });
  assert.equal(copied.ok, true);
  copied.board.rows[0].houses[1].config.prompt = 'changed copy';
  assert.equal(board.rows[0].houses.length, 1);
  assert.equal(board.rows[0].houses[0].config.prompt, 'Prepare {{user_input}}');
  const laneState = createCreativeExecutionInitialState({ board });
  laneState.board.rows[0].houses[0].label = 'changed lane';
  assert.notEqual(board.rows[0].houses[0].label, 'changed lane');

  const requests = [], history = [{ role: 'user', content: 'old history' }];
  const runtime = createHopscotchTurnRuntime({
    getSettings: () => ({ creativeHopscotchEnabled: true }),
    boardStore: { resolveEffectiveBoard: () => ({ board, source: 'global' }) },
    createExecutors: info => createHopscotchExecutors({ ...info, custom: {
      getRecentMessages: () => history,
      getBodyText: () => 'new body',
      backgroundChat: async messages => { requests.push(messages); return 'auxiliary result'; },
    } }),
  });
  const turn = runtime.prepareTurn({ sessionId: 'rp:legacy-board', rpUiMode: true, text: 'test' });
  assert(turn);
  history[0].content = 'changed history';
  assert.equal((await turn.waitForBodyStart()).proceed, true);
  assert(requests[0].some(message => message.content.includes('old history')));
  assert(!requests[0].some(message => message.content.includes('changed history')));
  assert.equal(turn.getPromptBlocks().length, 1);
  turn.resolveBody({ status: 'succeeded', messageId: 'fixture-reply' });
  const result = await turn.turnPromise;
  assert.equal(result.status, 'succeeded');
  assert.equal(requests.length, 2);
  assert(requests[1].some(message => message.content.includes('auxiliary result')));
  assert.equal(runtime.isSessionBusy('rp:legacy-board'), false);

  const message = { id: 'reply', role: 'assistant', content: 'new body', meta: { activeSwipe: 0 } };
  const sidecars = createHopscotchSidecarExecutors({
    sessionId: 'rp:legacy-board', board, getTurnContext: () => ({ body: { messageId: message.id } }),
    getScope: () => 'fixture', hasSession: () => true, getMessage: () => message,
    ruleEngine: { getRules: () => [] }, imageSettings: { enabled: true },
    backgroundChat: async () => '<image_prompt>A quiet room</image_prompt>',
  });
  const image = await sidecars.image_prompt.run({ house: { kind: 'image_prompt', config: {} } });
  assert.equal(image.status, 'succeeded');
  assert.equal(image.artifact.kind, 'image_prompt');
  assert.equal(image.artifact.sourceMessageId, 'reply');
  assert.deepEqual(image.artifact.prompts, ['A quiet room']);
  assert.equal(typeof globalThis.structuredClone, 'undefined');
  console.log('ok - missing structuredClone: default send plan, board copy, lane snapshot, ordered execution, frozen history and sidecar completion');
} finally {
  if (nativeDescriptor) Object.defineProperty(globalThis, 'structuredClone', nativeDescriptor);
  else delete globalThis.structuredClone;
}
