import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMaidHistoryPanel, groupMaidHistoryEntries } = await import('../../src/scripts/ui/maid-history-panel.js');
const { MaidConversationStore, MAID_CONTEXT_MAX_TURNS } = await import('../../src/scripts/storage/maid-conversation-store.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  async dispatch(type) { await Promise.all((this.listeners.get(type) || []).map(handler => handler({ preventDefault() {}, stopPropagation() {} }))); }
}
const doc = { head: new FakeElement('head'), createElement: tag => new FakeElement(tag), getElementById: () => null };
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const dice = id => ({ id, type: 'random', createdAt: 1, data: { mode: 'dice', sides: 6, rolls: [2, 5], total: 7 } });
const DAY = 86400000;
const now = Date.now();

{
  // 通话的字幕与任务结果合成一项（项内按先后）；文字回合各自一项；新的在前
  const turns = [
    { id: 't1', at: now - DAY, input: '昨天的问题', message: '昨天的回答' },
    { id: 'c1', at: now - 5000, responseType: 'realtime', input: '帮我掷骰子', context: { realtimeCallId: 'call-1', realtimeRole: 'user' } },
    { id: 'r1', at: now - 4000, message: '掷出了 7', cards: [dice('card-1')], context: { voiceCallId: 'call-1', voiceRequestText: '掷两个骰子' } },
    { id: 'c2', at: now - 3000, responseType: 'realtime', message: '是 7 点哦', context: { realtimeCallId: 'call-1', realtimeRole: 'assistant' } },
    { id: 't2', at: now - 1000, input: '你好', message: '主人好', status: 'failed' },
  ];
  const entries = groupMaidHistoryEntries(turns);
  assert.deepEqual(entries.map(entry => [entry.key, entry.turns.map(turn => turn.id)]), [
    ['turn:t2', ['t2']], ['call:call-1', ['c1', 'r1', 'c2']], ['turn:t1', ['t1']],
  ]);
  console.log('ok - history groups a call into one entry and lists newest first');
}

{
  // 当前回合加上被挤出的归档回合；同一回合以当前的为准
  let kv = null;
  const store = new MaidConversationStore({ storage: null, loadKv: async () => kv, saveKv: async (key, value) => { if (key === 'maid_conversation_store_v1') kv = JSON.parse(JSON.stringify(value)); } });
  await store.load();
  for (let index = 0; index < MAID_CONTEXT_MAX_TURNS + 3; index += 1) {
    await store.appendTurn({ id: `turn-${index}`, at: now - (MAID_CONTEXT_MAX_TURNS + 3 - index) * 1000, input: `问题 ${index}`, message: `回答 ${index}`, status: 'succeeded', cards: index === 0 ? [dice('old-card')] : [] });
  }
  assert.equal(store.exportState().turns.length, MAID_CONTEXT_MAX_TURNS, 'the live context keeps its cap');
  const history = store.listHistoryTurns();
  assert.equal(history.length, MAID_CONTEXT_MAX_TURNS + 3, 'evicted turns stay in the history');
  assert.equal(history[0].id, 'turn-0');
  assert.equal(history[0].cards[0].id, 'old-card', 'archived turns keep their cards');
  assert.equal(new Set(history.map(turn => turn.id)).size, history.length, 'no duplicates');
  history[0].input = 'changed';
  assert.equal(store.listHistoryTurns()[0].input, '问题 0', 'the list is a copy');
  console.log('ok - history lists live and archived turns once each');
}

{
  // 界面：按天分组、用户文字不翻译、回复走 Markdown、卡片照原样、失败标注、搜索、分页、「再来一次」追加在同一项下
  const turns = [
    { id: 'old', at: now - DAY, input: '昨天的问题', message: '昨天的回答', status: 'succeeded' },
    { id: 'dice', at: now - 2000, input: '掷两个骰子', message: '**7** 点', status: 'succeeded', cards: [dice('card-1')] },
    { id: 'fail', at: now - 1000, input: '打开设置', message: '没打开', status: 'failed' },
    ...Array.from({ length: 40 }, (_, index) => ({ id: `bulk-${index}`, at: now - 2 * DAY - index * 1000, input: `旧问题 ${index}`, message: '旧回答', status: 'succeeded' })),
  ];
  const actions = [];
  const panel = createMaidHistoryPanel({
    store: { listHistoryTurns: () => turns.map(turn => structuredClone(turn)) },
    documentRef: doc,
    onCardAction: async (payload) => { actions.push(payload); return { card: dice('card-2') }; },
  });
  const root = new FakeElement('section');
  panel.mount(root);
  assert.deepEqual(byClass(root, 'mh-day').slice(0, 2).map(node => node.textContent), ['今天', '昨天']);
  const entries = byClass(root, 'mh-entry');
  assert.equal(entries.length, 30, 'the first page shows 30 entries');
  assert.equal(byClass(root, 'mh-count')[0].textContent, '43 项');
  const [failed, rolled] = entries;
  assert.equal(byClass(failed, 'mh-tag')[0].textContent, '未完成');
  const user = byClass(rolled, 'mh-user')[0];
  assert.deepEqual([user.textContent, Object.hasOwn(user.dataset, 'i18nSkip')], ['掷两个骰子', true]);
  assert.match(byClass(rolled, 'mh-reply')[0].innerHTML, /<strong>7<\/strong>/);
  assert.equal(byClass(rolled, 'mrcard').length, 1, 'cards show in the history');

  await byClass(rolled, 'mrcard-action')[0].dispatch('click');
  assert.deepEqual(actions.map(item => item.card.id), ['card-1']);
  const rerolled = byClass(root, 'mh-entry')[1];
  assert.deepEqual(byClass(rerolled, 'mrcard').map(card => card.dataset.cardId), ['card-1', 'card-2'], 'the new card follows the old one');
  assert.deepEqual(turns[1].cards.map(card => card.id), ['card-1'], 'the saved history is not changed');

  await byClass(root, 'mh-more')[0].dispatch('click');
  assert.equal(byClass(root, 'mh-entry').length, 43);
  assert.equal(byClass(root, 'mh-more').length, 0);

  const search = walk(root).find(node => node.tagName === 'INPUT');
  search.value = '骰子';
  await search.dispatch('input');
  assert.equal(byClass(root, 'mh-entry').length, 1);
  search.value = '不存在的词';
  await search.dispatch('input');
  assert.equal(byClass(root, 'mh-empty')[0].textContent, '没有找到相关的记录');
  console.log('ok - history panel shows days, replies, cards, search and paging, and rerolls without editing history');
}

console.log('maid-history-panel-tests passed');
