// 女仆历史按轮管理（ROADMAP 29-③）：不给女仆看（提示词历史、整理进记忆、语义抽取都跳过）、删除或重新回答最近一轮
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { MaidConversationStore } = await import('../../src/scripts/storage/maid-conversation-store.js');
const { createMaidHistoryRoundActions, describeMaidRoundWrites } = await import('../../src/scripts/ui/maid-history-round-actions.js');
const { createMaidHistoryPanel, groupMaidHistoryEntries } = await import('../../src/scripts/ui/maid-history-panel.js');

const makeStore = async () => {
  let saved = null;
  const store = new MaidConversationStore({ storage: null, loadKv: async () => saved, saveKv: async (_key, value) => { saved = JSON.parse(JSON.stringify(value)); } });
  await store.load();
  return { store, reload: async () => { const again = new MaidConversationStore({ storage: null, loadKv: async () => saved, saveKv: async () => {} }); await again.load(); return again; } };
};
const now = Date.now();

test('a hidden round stays in the record but leaves the prompt history, compaction and extraction', async () => {
  const { store, reload } = await makeStore();
  await store.appendTurn({ id: 'keep', at: now - 3000, input: '保留的问题', message: '保留的回答', status: 'succeeded' });
  await store.appendTurn({ id: 'junk', at: now - 2000, input: '乱码问题', message: '�乱码�回答', status: 'succeeded' });
  assert.equal(await store.setTurnsHidden(['junk'], true), 1);
  assert.equal(await store.setTurnsHidden(['junk'], true), 0, 'already hidden');
  const text = store.getContextSnapshot().historyText;
  assert.match(text, /保留的回答/);
  assert.doesNotMatch(text, /乱码/);
  assert.equal(store.listHistoryTurns().find(turn => turn.id === 'junk').hiddenFromMaid, true, 'still listed for the user');
  assert.equal((await reload()).listHistoryTurns().find(turn => turn.id === 'junk').hiddenFromMaid, true, 'survives a reload');
  // 整理进记忆与语义抽取：隐藏的回合不进来源
  const row = store.compactHistoryToMemory({ force: true });
  assert.ok(!row || !row.sourceTurnIds.includes('junk'), 'not compacted into memory');
  assert.equal(store.resolveExtractionBatchTurns({ sourceTurnIds: ['keep', 'junk'] }).map(turn => turn.id).includes('junk'), false, 'not extracted');
  assert.equal(await store.setTurnsHidden(['junk'], false), 1);
  assert.match(store.getContextSnapshot().historyText, /乱码问题/, 'visible again after unhiding');
});

test('only the latest round can be deleted; regenerate asks the same words again; nothing while the maid is replying', async () => {
  const { store } = await makeStore();
  await store.appendTurn({ id: 'old', at: now - 3000, input: '旧问题', message: '旧回答', status: 'succeeded' });
  await store.appendTurn({ id: 'last', at: now - 1000, input: '把条目改短', message: '改好了', status: 'succeeded',
    resultBasis: { tools: [{ name: 'worldbook.update_entries', status: 'succeeded' }, { name: 'worldbook.read', status: 'succeeded' }] } });
  let busy = false;
  const asked = [];
  const actions = createMaidHistoryRoundActions({ store, isBusy: () => busy, regenerate: async input => asked.push(input) });
  const entries = groupMaidHistoryEntries(store.listHistoryTurns());
  const latest = entries.find(entry => entry.key === 'turn:last');
  const older = entries.find(entry => entry.key === 'turn:old');
  assert.deepEqual(actions.actionsFor(older).map(action => action.id), ['hide'], 'older rounds can only be hidden');
  const latestActions = actions.actionsFor(latest);
  assert.deepEqual(latestActions.map(action => action.id), ['hide', 'regenerate', 'delete']);
  assert.match(latestActions.find(action => action.id === 'delete').warning, /这一轮改过：/, 'lists what this round changed (writes only)');
  assert.equal(describeMaidRoundWrites(latest.turns).length, 1, 'the read is not listed');
  assert.equal(await store.deleteLatestTurn('old'), null, 'a middle round cannot be deleted');
  busy = true;
  assert.equal(actions.actionsFor(latest).find(action => action.id === 'delete').disabled, true);
  assert.equal(await actions.run(latest, 'regenerate'), false, 'refused while replying');
  busy = false;
  assert.equal(await actions.run(latest, 'regenerate'), true);
  assert.deepEqual(asked, ['把条目改短']);
  assert.deepEqual(store.listHistoryTurns().map(turn => turn.id), ['old']);
  assert.equal(await actions.run(groupMaidHistoryEntries(store.listHistoryTurns())[0], 'delete'), true, 'now the old one is the latest');
  assert.deepEqual(store.listHistoryTurns(), []);
});

test('history panel: hidden rounds are marked, delete needs a second click and refreshes the list', async () => {
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.value = ''; this.disabled = false; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.classList = { add: () => {}, remove: () => {} }; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
    async click() { await Promise.all((this.listeners.get('click') || []).map(handler => handler({ preventDefault() {}, stopPropagation() {} }))); }
  }
  const doc = { head: new El('head'), createElement: tag => new El(tag), getElementById: () => null };
  const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
  const { store } = await makeStore();
  await store.appendTurn({ id: 'a', at: now - 3000, input: '第一句', message: '第一答', status: 'succeeded' });
  await store.appendTurn({ id: 'b', at: now - 1000, input: '第二句', message: '第二答', status: 'succeeded' });
  const roundActions = createMaidHistoryRoundActions({ store, regenerate: async () => {} });
  const panel = createMaidHistoryPanel({ store, documentRef: doc, roundActions });
  const root = new El('div');
  panel.mount(root);
  const entries = () => walk(root).filter(node => node.tagName === 'ARTICLE');
  const button = (key, id) => walk(entries().find(node => node.dataset.key === key)).find(node => node.dataset?.roundAction === id);
  await button('turn:a', 'hide').click();
  assert.equal(entries().find(node => node.dataset.key === 'turn:a').className.includes('is-hidden'), true);
  assert.ok(walk(entries().find(node => node.dataset.key === 'turn:a')).some(node => node.textContent === '女仆看不到'));
  const del = button('turn:b', 'delete');
  await del.click();
  assert.equal(del.textContent, '再点一次删除', 'first click only arms');
  assert.equal(entries().length, 2);
  await del.click();
  assert.deepEqual(entries().map(node => node.dataset.key), ['turn:a'], 'deleted and refreshed');
});
