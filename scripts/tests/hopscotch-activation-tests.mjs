import assert from 'node:assert/strict';
import { normalizeHopscotchBoard, validateHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
import { editHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-editor-utils.js';
import { resolveHopscotchActivation, getActiveHopscotchFused } from '../../src/scripts/ui/chat/hopscotch-activation-utils.js';
import { createCreativeTurnOrchestrator } from '../../src/scripts/ui/chat/creative-turn-orchestrator.js';
import { createHopscotchBoardStore } from '../../src/scripts/storage/hopscotch-board-store.js';
import { createHopscotchTurnRuntime, createHopscotchExecutors } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { renderHopscotchCourt } from '../../src/scripts/ui/chat/hopscotch-court-view.js';

const input = { rows: [
  { id: 'first', houses: [{ id: 'source', kind: 'custom_prompt', config: { prompt: 'context', output: { mode: 'context', injectIntoBody: true } } }] },
  { id: 'second', houses: [{ id: 'dependent', kind: 'custom_prompt', config: { prompt: '{{house:source}}' } }, { id: 'independent', kind: 'custom_prompt', config: { prompt: 'independent' } }] },
  { id: 'body-row', houses: [{ id: 'body', kind: 'body', fused: ['variable', 'image_prompt'] }] },
  { id: 'last', houses: [{ id: 'image', kind: 'image_generation' }] },
] };
const original = normalizeHopscotchBoard(input);
assert(original.rows.every(row => row.houses.every(house => house.enabled)), 'old boards default to enabled');
let result = editHopscotchBoard(original, { type: 'toggle', id: 'source', enabled: false }); assert(result.ok);
result = editHopscotchBoard(result.board, { type: 'toggle', id: 'body', member: 'image_prompt', enabled: false }); assert(result.ok);
const disabled = result.board;
assert.deepEqual(disabled.rows.map(row => row.houses.map(h => h.id)), original.rows.map(row => row.houses.map(h => h.id)));
assert.deepEqual(disabled.rows[0].houses[0].config, original.rows[0].houses[0].config);
assert.deepEqual(disabled.rows[2].houses[0].fused, ['variable', 'image_prompt']);
assert.equal(editHopscotchBoard(disabled, { type: 'toggle', id: 'body', enabled: false }).ok, false);
assert(validateHopscotchBoard({ rows: [{ houses: [{ kind: 'body', enabled: false }] }] }).errors.some(error => error.code === 'body_required'));
const activation = resolveHopscotchActivation(disabled, { variables: { activity: { enabled: false, reason: 'no_variables' } } });
assert.equal(activation.houses.source.reason, 'disabled');
assert.equal(activation.houses.dependent.reason, 'dependency_disabled');
assert.equal(activation.houses.image.reason, 'image_prompt_disabled');
assert.equal(activation.fused.variable.reason, 'no_variables');
assert.deepEqual(getActiveHopscotchFused(disabled, activation), []);
const html = renderHopscotchCourt(disabled, { activation, editable: true });
assert.match(html, /data-hop-part="variable" data-hop-enabled="false"/);
assert.equal((html.match(/data-hop-house=/g) || []).length, 5, 'paused nodes keep their location and identity');
const calls = [];
const run = createCreativeTurnOrchestrator({ board: disabled, activation, executors: {
  custom_prompt: { run: async ({ house }) => { calls.push(house.id); return { status: 'succeeded', artifact: { text: house.id } }; } },
  body: { run: async () => { calls.push('body'); return { status: 'succeeded' }; } },
  image_generation: { run: async () => { throw new Error('disabled image executed'); } },
} });
const output = await run.runTurn();
assert.deepEqual(calls, ['independent', 'body']); assert.equal(output.status, 'succeeded');
assert.equal(output.houses.source.reason, 'disabled'); assert.equal(output.houses.dependent.status, 'skipped');
assert.equal(output.houses.image.startedAt, 0); assert.equal(output.artifacts.source, undefined);

const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
const store = createHopscotchBoardStore({ storage }); await store.setGlobalBoard(disabled);
const reopened = createHopscotchBoardStore({ storage });
assert.deepEqual(reopened.getGlobalBoard().rows, disabled.rows, 'round-trip retains node and fused preferences');
const enabled = editHopscotchBoard(disabled, { type: 'toggle', id: 'source', enabled: true });
assert(enabled.ok); assert.equal(resolveHopscotchActivation(enabled.board).houses.dependent.enabled, true);

const onlyBody = { rows: [{ houses: [{ id: 'body', kind: 'body', fused: ['variable', 'memory_table'], fusedEnabled: { variable: true } }] }] };
await store.setGlobalBoard(onlyBody);
let memoryEnabled = true;
const runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: true }),
  resolveWritingSettings: () => ({ memory: { storageMode: 'table', placeEnabled: memoryEnabled }, variables: { activity: { enabled: true, available: true, runtimeEnabled: true } } }),
  createExecutors: info => createHopscotchExecutors(info),
});
const plan = runtime.resolveExecutionPlan('rp:test');
await store.setGlobalBoard(editHopscotchBoard(onlyBody, { type: 'toggle', id: 'body', member: 'variable', enabled: false }).board);
memoryEnabled = false;
const turn = runtime.prepareTurn({ sessionId: 'rp:test', rpUiMode: true, executionPlan: plan });
assert.deepEqual(turn.fused, ['variable', 'memory_table'], 'the in-flight request uses the same frozen plan as preview/context');
assert.equal(turn.memoryInline, true, 'shared feature changes also apply to the following turn');
await turn.waitForBodyStart(); turn.resolveBody({ status: 'succeeded' }); await turn.turnPromise;
assert.deepEqual(runtime.resolveExecutionPlan('rp:test').fused, [], 'later turns use the saved pause');
console.log('ok - persistent pause, fused members, dependency skip, original geometry and per-turn snapshot');
