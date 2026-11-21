import assert from 'node:assert/strict';

import { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createFlowBoardAgentTools } from '../../src/scripts/agent/tools/flow-board-tools.js';
import { createScopedHopscotchBoardStore } from '../../src/scripts/storage/hopscotch-board-store.js';
import { createHopscotchTurnRuntime } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { searchMaidCapabilityConcepts } from '../../src/scripts/agent/maid-capability-concept-retriever.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

// 真实的跳房子板存储与执行期（resolveBoard／resolveActivation），存储放内存；女仆工具经真实注册表执行。
const agent = (id, title, extra = {}) => ({
  id, title, kind: 'text_edit', enabled: true, invocationMode: 'auto', triggerMode: 'auto', modelMode: 'follow_current', ...extra,
});

const setup = ({ place = 'writing', agents = [agent('text-edit:polish', '正文润色')], hopscotchEnabled = false } = {}) => {
  const memory = new Map();
  const sessionSettings = new Map();
  const store = createScopedHopscotchBoardStore({
    storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) },
    getSessionSettings: sid => sessionSettings.get(sid) || {},
    setSessionSettings: (sid, value) => { sessionSettings.set(sid, value); return true; },
    logger: { debug() {}, warn() {} },
  });
  const settings = { creativeHopscotchEnabled: hopscotchEnabled, memoryAutoExtractModeWriting: '' };
  const runtime = createHopscotchTurnRuntime({
    boardStore: store,
    getSettings: () => settings,
    resolveWritingSettings: () => ({}),
    getTextAgents: () => agents,
  });
  let context = place === 'writing' ? { place: 'writing', sessionId: 'rp:card' } : { place: 'chat', sessionId: 'contact_1' };
  const saved = [];
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(createFlowBoardAgentTools({
    getRuntime: () => runtime,
    getBoardStore: () => store,
    getContext: () => context,
    listTextAgents: () => agents,
    isHopscotchEnabled: () => settings.creativeHopscotchEnabled === true,
    enableHopscotch: value => { settings.creativeHopscotchEnabled = value === true; },
    setMemoryAutoExtractMode: mode => { settings.memoryAutoExtractModeWriting = mode; },
    onSaved: () => saved.push(Date.now()),
  }));
  const requests = [];
  const run = (name, args, { allow = true, onConfirm = null } = {}) => registry.executeTool(name, args, {
    sessionId: context.sessionId,
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: async (request) => {
      requests.push(request);
      return onConfirm ? onConfirm(request) : { decision: allow ? 'allow' : 'deny' };
    },
  });
  const cardBoard = () => store.getPersonaBoard('rp:card');
  const layout = board => (board?.rows || []).map(row => row.houses.map(house => `${house.kind === 'text_edit' ? house.config.agentId : house.kind}${house.enabled === false ? '(off)' : ''}`).join('+'));
  return { store, runtime, settings, run, requests, saved, cardBoard, layout, agents, setContext: next => { context = next; } };
};

const customBoard = (...rows) => ({ rows: [{ id: 'r_body', houses: [{ id: 'body', kind: 'body' }] }, ...rows] });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('flow.read shows the board, where it comes from and the reply Agents left off a custom board', async () => {
  const { run, store } = setup();
  const derived = await run('flow.read', {});
  assert.equal(derived.result.ok, true);
  assert.equal(derived.result.custom, false);
  assert.match(derived.result.source, /跟随现有设置/);
  assert.deepEqual(derived.result.rows.map(row => row.houses.map(house => house.kind)), [['body'], ['text_edit']], 'the derived board runs every auto Agent');
  assert.equal(derived.result.notOnBoard.length, 0);

  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const custom = await run('flow.read', {});
  assert.equal(custom.result.custom, true);
  assert.match(custom.result.source, /当前角色卡/);
  assert.deepEqual(custom.result.notOnBoard.map(item => item.title), ['正文润色'], 'a custom board only runs the Agents placed on it');
  assert.ok(custom.result.addableKinds.some(item => item.kind === 'format_review'));
});

test('flow.update puts a reply Agent on the custom board after one confirmation', async () => {
  const { run, requests, store, cardBoard, layout, settings, saved } = setup();
  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const result = await run('flow.update', { operations: [{ op: 'add', agent: '正文润色' }] });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  const request = requests.at(-1);
  assert.equal(request.kind, 'flow.update');
  assert.match(request.message, /当前角色卡的创意写作的流程板（1 项）/);
  assert.match(request.message, /保存后会开启跳房子编排/);
  assert.equal(request.details.items[0].meta, '加入：正文润色 → 最后新的一行');
  assert.match(request.details.items.at(-1).meta, /第 2 行：正文润色/);
  assert.deepEqual(layout(cardBoard()), ['body', 'text-edit:polish']);
  assert.equal(settings.creativeHopscotchEnabled, true, 'saving turns the flow board on like the panel');
  assert.equal(saved.length, 1, 'the open panel is told to reload');
  const after = await run('flow.read', {});
  assert.equal(after.result.notOnBoard.length, 0);
  assert.equal(after.result.rows[1].houses[0].active, true);
});

test('an invalid layout fails before the confirmation and nothing is saved', async () => {
  const { run, requests, store, cardBoard, layout } = setup();
  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const before = layout(cardBoard());
  const sameRow = await run('flow.update', { operations: [{ op: 'add', agent: '正文润色', row: 1 }] });
  assert.equal(sameRow.result.ok, false);
  assert.equal(sameRow.result.reason, 'invalid_request');
  assert.ok(sameRow.result.errors.some(item => item.reason === 'builtin_before_body'), JSON.stringify(sameRow.result.errors));
  const missing = await run('flow.update', { operations: [{ op: 'add', agent: '不存在' }, { op: 'toggle', house: '没有这个', enabled: false }] });
  assert.deepEqual(missing.result.errors.map(item => item.reason), ['agent_not_found', 'not_found']);
  const outOfRange = await run('flow.update', { operations: [{ op: 'add', kind: 'format_review', row: 5 }] });
  assert.equal(outOfRange.result.errors[0].reason, 'row_out_of_range');
  assert.equal(requests.length, 0, 'no confirmation for a request that cannot be saved');
  assert.deepEqual(layout(cardBoard()), before);
});

test('move, toggle and remove change the board in order', async () => {
  const { run, store, cardBoard, layout } = setup({ agents: [agent('text-edit:polish', '正文润色'), agent('text-edit:check', '错字检查')] });
  await store.setPersonaBoard(customBoard(
    { id: 'r2', houses: [{ id: 'review', kind: 'format_review' }] },
    { id: 'r3', houses: [{ id: 'polish', kind: 'text_edit', label: '正文润色', config: { agentId: 'text-edit:polish' } }] },
  ), { sessionId: 'rp:card' });
  const result = await run('flow.update', { operations: [
    { op: 'move', house: '正文润色', row: 2 },
    { op: 'toggle', house: 'review', enabled: false },
    { op: 'add', agent: '错字检查', row: 3, newRow: true },
  ] });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.deepEqual(layout(cardBoard()), ['body', 'format_review(off)+text-edit:polish', 'text-edit:check']);
  const removed = await run('flow.update', { operations: [{ op: 'remove', house: 'text-edit:check' }] });
  assert.equal(removed.result.ok, true);
  assert.deepEqual(layout(cardBoard()), ['body', 'format_review(off)+text-edit:polish']);
});

test('an Agent that is off or manual-only is placed with a warning', async () => {
  const { run, requests, store } = setup({ agents: [agent('text-edit:manual', '手动润色', { invocationMode: 'manual', triggerMode: 'manual' })] });
  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const result = await run('flow.update', { operations: [{ op: 'add', agent: '手动润色' }] });
  assert.equal(result.result.ok, true);
  assert.match(requests.at(-1).message, /只能手动调用/);
  assert.equal(result.result.warnings.length, 1);
  assert.equal(result.result.inactive[0].label, '手动润色');
});

test('reset makes the card follow all cards; nothing to reset is skipped', async () => {
  const { run, requests, store, cardBoard } = setup();
  const nothing = await run('flow.update', { reset: true });
  assert.equal(nothing.result.skipped, true);
  assert.equal(requests.length, 0);
  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const reset = await run('flow.update', { reset: true });
  assert.equal(reset.result.ok, true, JSON.stringify(reset.result));
  assert.equal(requests.at(-1).danger, true);
  assert.equal(cardBoard(), null);
});

test('a board changed elsewhere during the confirmation is not overwritten', async () => {
  const { run, store, cardBoard, layout } = setup();
  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const result = await run('flow.update', { operations: [{ op: 'add', agent: '正文润色' }] }, {
    onConfirm: async () => {
      await store.setPersonaBoard(customBoard({ id: 'r2', houses: [{ id: 'review', kind: 'format_review' }] }), { sessionId: 'rp:card' });
      return { decision: 'allow' };
    },
  });
  assert.equal(result.result.reason, 'target_changed_during_confirmation');
  assert.deepEqual(layout(cardBoard()), ['body', 'format_review']);
});

test('cancelling writes nothing; the recap house cannot be removed; chat flows are read-only', async () => {
  const recap = agent('text-edit:recap', '前情提要');
  const { run, store, cardBoard, layout, setContext } = setup({ agents: [agent('text-edit:polish', '正文润色'), recap] });
  await store.setPersonaBoard(customBoard(), { sessionId: 'rp:card' });
  const cancelled = await run('flow.update', { operations: [{ op: 'add', agent: '正文润色' }] }, { allow: false });
  assert.equal(cancelled.result.ok, false);
  assert.equal(layout(cardBoard()).length, 1);
  const recapRemove = await run('flow.update', { operations: [{ op: 'remove', house: '前情提要' }] });
  assert.equal(recapRemove.result.errors[0].reason, 'recap_reattached');
  setContext({ place: 'chat', sessionId: 'contact_1' });
  const chat = await run('flow.update', { operations: [{ op: 'add', agent: '正文润色' }] });
  assert.equal(chat.result.reason, 'chat_flow_follows_settings');
  const read = await run('flow.read', {});
  assert.equal(read.result.editable, false);
});

test('the maid finds the flow tools for flow board requests', async () => {
  const features = listAppFeatures();
  const top = query => searchMaidCapabilityConcepts(query, { features, limit: 4 }).map(item => item.id);
  assert.ok(top('把正文润色放进流程板').includes('flow.update'));
  assert.ok(top('跳房子现在是怎么排的').includes('flow.read'));
  assert.ok(top('把格式复核从流程里移掉').includes('flow.update'));
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}
if (failed) process.exit(1);
