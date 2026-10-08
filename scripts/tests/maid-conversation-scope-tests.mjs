import assert from 'node:assert/strict';
import test from 'node:test';
import { MaidConversationStore } from '../../src/scripts/storage/maid-conversation-store.js';
import { selectMaidContextScope } from '../../src/scripts/storage/maid-context-scope.js';
import { buildMaidModelPlannerMessages, buildMaidModelReActMessages } from '../../src/scripts/agent/maid-model-planner.js';
import { buildMaidChatResponderMessages } from '../../src/scripts/agent/maid-chat-responder.js';

const makeStore = async () => {
  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {},
    compactionTurnThreshold: 1000, compactionHistoryTokenThreshold: 100000 });
  await store.load();
  await store.appendTurn({ input: '先给知夏生成预览', message: '知夏的预览图好了', context: { roleCardId: 'other-card', uiMode: 'chat' },
    resultBasis: { artifacts: [{ attachmentId: 'other-card-image', target: 'zhixia', subject: '知夏', purpose: 'avatar' }] } });
  await store.appendTurn({ input: '给莉莉丝生个头像', message: '莉莉丝头像已设置', context: { roleCardId: 'current-card', uiMode: 'chat' },
    resultBasis: { artifacts: [{ attachmentId: 'current-card-image', target: 'lilith', subject: '莉莉丝', purpose: 'avatar' }] } });
  return store;
};

for (const method of ['getContextSnapshot', 'getContextSnapshotAsync']) {
  test(`${method} excludes another card's image references from planning context`, async () => {
    const store = await makeStore();
    const snapshot = await store[method]({ input: '太成熟了，要萌一点的', context: { roleCardId: 'current-card', uiMode: 'chat' } });
    assert.match(snapshot.historyText, /current-card-image/);
    assert.doesNotMatch(snapshot.historyText + snapshot.memoryText, /other-card-image|知夏/);
    assert.equal(store.exportState().turns.length, 2, 'filter context without deleting visible history');
  });
}

test('explicit standing instructions enter working context before memory compaction', async () => {
  const store = await makeStore();
  await store.appendTurn({ input: '记住，我每次建角色都要三个开场白', message: '接下来按这个要求创建。', context: { roleCardId: 'current-card', uiMode: 'chat' } });
  const snapshot = await store.getContextSnapshotAsync({ query: '建个角色叫夜羽，冷酷刺客', context: { roleCardId: 'current-card' } });
  assert.match(snapshot.memoryText, /用户偏好指示[\s\S]*每次建角色都要三个开场白/);
  assert.equal(store.exportState().extractionBatches.length, 0, 'no unnecessary extraction call');
});

test('global compaction preserves the retained recent history of a quieter card', async () => {
  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {} });
  await store.load();
  await store.appendTurn({ id: 'own-image-turn', input: 'Generate an avatar for Lilith', message: 'Avatar set',
    context: { roleCardId: 'quiet-card' }, resultBasis: { artifacts: [
      { attachmentId: 'lilith-first-image', target: 'lilith', subject: 'Lilith', purpose: 'avatar' },
    ] } });
  for (let i = 0; i < 13; i += 1) await store.appendTurn({ id: `foreign-${i}`, input: `Other task ${i}`,
    message: `Other result ${i}`, context: { roleCardId: 'busy-card' } });
  assert.equal(store.exportState().turns.find(t => t.id === 'own-image-turn').compacted, true,
    'exercise real automatic global compaction before building the card context');
  const before = store.exportState();
  for (const method of ['getContextSnapshot', 'getContextSnapshotAsync']) {
    const snapshot = await store[method]({ input: 'Make it cuter', context: { roleCardId: 'quiet-card' } });
    assert.match(snapshot.historyText, /lilith-first-image/);
    assert.doesNotMatch(snapshot.historyText, /Other task|Other result/);
    assert.deepEqual(snapshot.selectedTurnIds, ['own-image-turn']);
  }
  assert.deepEqual(store.exportState(), before, 'context projection must not undo storage compaction');
  assert.doesNotMatch(store.getContextSnapshot().historyText, /lilith-first-image/,
    'legacy unscoped callers retain their compaction behavior');
  assert.ok(store.getLegacyArchive().compactedTurns.some(t => t.id === 'own-image-turn'));
  await store.clearHistory();
  assert.equal(store.getContextSnapshot({ context: { roleCardId: 'quiet-card' } }).historyText, '',
    'cleared history must not be reintroduced from the recovery archive');
});

test('scoped compacted history still obeys the requested recent-turn and token budgets', async () => {
  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {} });
  await store.load();
  for (let i = 0; i < 15; i += 1) await store.appendTurn({ id: `own-${i}`, input: `Task ${i}`,
    message: `Result ${i}`, context: { roleCardId: 'own-card' } });
  for (let i = 0; i < 13; i += 1) await store.appendTurn({ id: `other-${i}`, input: `Other ${i}`,
    message: 'Done', context: { roleCardId: 'other-card' } });
  const snapshot = await store.getContextSnapshotAsync({ context: { roleCardId: 'own-card' }, maxTurns: 2,
    maxTotalTokens: 300, maxHistoryTokens: 300 });
  assert.deepEqual(snapshot.selectedTurnIds, ['own-13', 'own-14']);
  assert.ok(snapshot.tokenCount <= 300);
});

test('card filtering keeps user preferences but excludes foreign or unowned task facts', () => {
  const scoped = selectMaidContextScope({ context: { roleCardId: 'current-card' },
    turns: [{ id: 'own', context: { roleCardId: 'current-card' } }],
    archivedTurns: [{ id: 'foreign', context: { roleCardId: 'other-card' } }],
    memoryRows: [{ id: 'own-row', sourceTurnIds: ['own'] }, { id: 'mixed-row', sourceTurnIds: ['own', 'foreign'] }],
  });
  const memories = [
    { id: 'preference', kind: 'preference', sourceTurnIds: ['foreign'] },
    { id: 'own-image', kind: 'resource_state', sourceTurnIds: ['own'] },
    { id: 'foreign-image', kind: 'resource_state', sourceTurnIds: ['foreign'] },
    { id: 'unowned', kind: 'task_state' },
  ];
  assert.deepEqual(scoped.memoryRows.map(m => m.id), ['own-row']);
  assert.deepEqual(scoped.filterMemories(memories).map(m => m.id), ['preference', 'own-image']);
  assert.deepEqual(selectMaidContextScope().filterMemories(memories), memories);
});

test('actual planner prompts distinguish optional style from preference conflict and preserve standing requirements', () => {
  for (const build of [buildMaidModelPlannerMessages, buildMaidModelReActMessages]) {
    const prompt = build({ input: '给她换个头像' })[0].content;
    assert.match(prompt, /Missing optional style/);
    assert.match(prompt, /Before paid generation/);
    assert.match(prompt, /Carry requirements such as counts and format into actual tool arguments/);
  }
  const chat = buildMaidChatResponderMessages({ input: '忘掉我说过的偏好' })[0].content;
  assert.match(chat, /corresponding successful APP operation/);
});
