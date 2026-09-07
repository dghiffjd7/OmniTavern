import assert from 'node:assert/strict';
import { normalizeHopscotchBoard, validateHopscotchBoard, projectHopscotchVariableRules } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
import { applyHopscotchDrop, findHopscotchNode, listHopscotchDropTargets } from '../../src/scripts/ui/chat/hopscotch-drag-utils.js';
import { editHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-editor-utils.js';
import { resolveHopscotchActivation } from '../../src/scripts/ui/chat/hopscotch-activation-utils.js';
import { createHopscotchTurnRuntime } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createHopscotchBoardStore } from '../../src/scripts/storage/hopscotch-board-store.js';

const legacy = { version: 1, rows: [
  { id: 'a', houses: [{ id: 'prep', kind: 'custom_prompt', config: { prompt: 'prepare', output: { mode: 'context', injectIntoBody: true } } }] },
  { id: 'b', houses: [{ id: 'body', kind: 'body', fused: ['image_prompt', 'memory_table', 'variable'], fusedEnabled: { variable: false } }] },
  { id: 'c', houses: [{ id: 'image', kind: 'image_generation' }] },
] };
const original = structuredClone(legacy), board = normalizeHopscotchBoard(legacy);
assert.equal(board.version, 2); assert.deepEqual(legacy, original);
assert(validateHopscotchBoard(board).ok);
const member = findHopscotchNode(board, 'body__variable').node;
assert.equal(member.enabled, false);
const split = applyHopscotchDrop(board, member.id, { type: 'row', rowId: 'c', beforeId: 'image' });
assert(split.ok && split.changed); assert.deepEqual(findHopscotchNode(split.board, member.id).node, member);
assert.deepEqual(board, normalizeHopscotchBoard(original), 'drop creates an atomic draft');
const merged = applyHopscotchDrop(split.board, member.id, { type: 'fuse', hostId: 'body' });
assert(merged.ok); assert.deepEqual(findHopscotchNode(merged.board, member.id).node, member);
assert.equal(findHopscotchNode(merged.board, 'body').node.fusedEnabled.variable, false);
const reordered = applyHopscotchDrop(board, 'body', { type: 'gap', beforeRowId: 'a' });
assert.equal(reordered.ok, false, 'pre-body injection must remain before the body');
assert.equal(applyHopscotchDrop(board, 'body__image_prompt', { type: 'row', rowId: 'c' }).ok, false, 'prompt and image cannot race in the same row');
const imageSplit = applyHopscotchDrop(board, 'body__image_prompt', { type: 'gap', beforeRowId: 'c' });
assert(imageSplit.ok); assert.equal(findHopscotchNode(imageSplit.board, 'body__image_prompt').node.kind, 'image_prompt');
const movedGroup = applyHopscotchDrop(normalizeHopscotchBoard({ rows: [{ id: 'x', houses: [{ id: 'side', kind: 'custom_prompt', config: { prompt: 'side' } }] }, ...board.rows.slice(1)] }), 'body', { type: 'row', rowId: 'x' });
assert(movedGroup.ok); assert.equal(findHopscotchNode(movedGroup.board, 'body__memory_table').house.id, 'body');
assert.equal(applyHopscotchDrop(board, 'body', { type: 'gap', beforeRowId: 'b' }).changed, false, 'own previous gap is a no-op');
assert.equal(applyHopscotchDrop(board, 'body', { type: 'gap', beforeRowId: 'c' }).changed, false, 'own next gap is a no-op');
assert.equal(applyHopscotchDrop(board, 'prep', { type: 'fuse', hostId: 'body' }).ok, false, 'custom model tasks cannot masquerade as fused capabilities');
const configured = editHopscotchBoard(split.board, { type: 'update', id: member.id, patch: { config: { modelMode: 'profile', modelProfileId: 'own', modelOverride: 'chosen-model' } } }).board;
assert.equal(applyHopscotchDrop(configured, member.id, { type: 'fuse', hostId: 'body' }).ok, false);
assert.equal(findHopscotchNode(configured, member.id).node.config.modelOverride, 'chosen-model');
const capabilities = { variable: { reason: 'Requires an independent request' } };
assert.equal(editHopscotchBoard(split.board, { type: 'drop', id: member.id, target: { type: 'fuse', hostId: 'body' }, capabilities }).ok, false, 'editor uses the same capability checks as hover');
const full = normalizeHopscotchBoard({ rows: [{ id: 'r', houses: [{ id: 'body', kind: 'body' }, ...[1, 2, 3].map(n => ({ id: `c${n}`, kind: 'custom_prompt', config: { prompt: 'task' } }))] }, { id: 'other', houses: [{ id: 'c4', kind: 'custom_prompt', config: { prompt: 'four' } }] }] });
assert.equal(applyHopscotchDrop(full, 'c4', { type: 'row', rowId: 'r' }).ok, false, 'four-house capacity is enforced');
assert.equal(listHopscotchDropTargets(board, member.id).some(target => target.ok && target.changed), true);

const activity = { available: true, enabled: true, updateModes: ['model_rule'], rulePhases: ['before', 'after'] };
const projected = projectHopscotchVariableRules(board, activity);
assert(validateHopscotchBoard(projected).ok);
assert.equal(resolveHopscotchActivation(projected, { variables: { activity } }).fused.variable.enabled, false, 'native model rules are not executed as a body fusion');
assert(findHopscotchNode(projected, member.id), 'shared boards retain the inline variable identity for other roles');
assert.equal(findHopscotchNode(projected, 'body__rules_before').node.enabled, false);
assert.equal(findHopscotchNode(projected, 'body__rules_after').node.enabled, false, 'migration retains paused variable preference');
assert.deepEqual(projectHopscotchVariableRules(projected, activity), projected, 'projection is idempotent');
const removed = editHopscotchBoard(projected, { type: 'remove', id: 'body__rules_after' }).board;
assert.equal(findHopscotchNode(projectHopscotchVariableRules(removed, activity), 'body__rules_after'), null, 'deleted phase stays deleted after save/reload');
const activated = resolveHopscotchActivation(split.board, { variables: { activity: { available: false, enabled: false, reason: 'no_variables' } } });
assert.equal(activated.houses[member.id].enabled, false, 'empty-card split stays paused');
const shared = normalizeHopscotchBoard(board); shared.rows[1].houses[0].fusedEnabled.variable = true;
const nativeBoard = projectHopscotchVariableRules(shared, { ...activity, rulePhases: ['after'] });
assert.equal(resolveHopscotchActivation(nativeBoard, { variables: { activity } }).fused.variable.reason, 'independent_variable_rules');
assert.equal(resolveHopscotchActivation(nativeBoard, { variables: { activity: { ...activity, updateModes: ['inline'], rulePhases: [] } } }).fused.variable.enabled, true, 'global board still supports another role with inline updates');
assert(findHopscotchNode(projectHopscotchVariableRules(nativeBoard, activity), 'body__rules_before'), 'another role can add its before-send phase');
const collision = normalizeHopscotchBoard({ rows: [{ houses: [{ id: 'body', kind: 'body', fused: ['variable'] }, { id: 'body__variable', kind: 'custom_prompt', config: { prompt: 'already owns ID' } }] }] });
assert(validateHopscotchBoard(collision).ok); assert.equal(collision.rows[0].houses[0].fusedMembers.variable.id, 'body__variable_1');
const storage = new Map(), store = createHopscotchBoardStore({ storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
await store.setGlobalBoard(shared);
const runtime = createHopscotchTurnRuntime({ boardStore: store, resolveWritingSettings: sid => ({ variables: { activity: sid === 'actual-role' ? activity : { enabled: false } } }) });
assert(findHopscotchNode(runtime.resolveBoard('', { contextSessionId: 'actual-role' }).board, 'body__rules_before'), 'editing global defaults uses the current role for availability and phases');
console.log('ok - drag migration, identity/config/pause preservation, fusion legality, order, capacity, phases and immutable drops');
