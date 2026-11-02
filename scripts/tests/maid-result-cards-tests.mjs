import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { normalizeMaidResultCard, collectMaidResultCards, maidRandomCardRerollArgs, MAID_RESULT_CARD_LIMIT } = await import('../../src/scripts/agent/maid-result-cards.js');
const { renderMaidResultCard } = await import('../../src/scripts/ui/maid-result-card-dom.js');
const { buildMaidRandomCard, rollMaidRandom, rerollMaidRandomCard } = await import('../../src/scripts/agent/tools/maid-capability-tools.js');
const { MaidSettingsStore } = await import('../../src/scripts/storage/maid-settings-store.js');
const { MaidConversationStore } = await import('../../src/scripts/storage/maid-conversation-store.js');
const { createMaidVoiceTaskRuntime } = await import('../../src/scripts/ui/maid-voice-task-runtime.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  async click() { await Promise.all((this.listeners.get('click') || []).map(handler => handler({ preventDefault() {}, stopPropagation() {} }))); }
}
const doc = { head: new FakeElement('head'), createElement: tag => new FakeElement(tag), getElementById: () => null };
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const sequence = (...values) => {
  let index = 0;
  return { getRandomValues: (buffer) => { buffer[0] = values[index++ % values.length]; return buffer; } };
};
const dice = (rolls, sides = 6) => ({ id: 'card-dice', type: 'random', createdAt: 1, data: { mode: 'dice', sides, rolls, total: 999 } });
const draw = (options, picked, mode = 'draw') => ({ id: 'card-draw', type: 'random', createdAt: 1, data: { mode, options, picked } });

{
  // 卡片只认固定种类与合规数据，渲染只用校验后的字段
  assert.deepEqual(normalizeMaidResultCard(dice([2, 5])), { id: 'card-dice', type: 'random', createdAt: 1, data: { mode: 'dice', sides: 6, rolls: [2, 5], total: 7 } }, 'the total is recomputed');
  assert.equal(normalizeMaidResultCard({ ...dice([2]), type: 'html' }), null, 'unknown card types are dropped');
  assert.equal(normalizeMaidResultCard(dice([7])), null, 'a roll above the die size is invalid');
  assert.equal(normalizeMaidResultCard(dice([1.5])), null);
  assert.equal(normalizeMaidResultCard(draw(['甲', '乙'], ['丙'])), null, 'picked items must be among the options');
  assert.equal(normalizeMaidResultCard(draw(['甲', '乙'], ['甲', '乙'], 'choose')), null, 'choose picks exactly one');
  assert.equal(normalizeMaidResultCard({ ...dice([1]), id: '' }), null);
  assert.deepEqual(normalizeMaidResultCard(draw(['甲\u0000', '乙'], ['甲 '])).data.options, ['甲', '乙'], 'control characters are stripped');

  const steps = [
    { status: 'succeeded', output: { card: dice([1]) } },
    { status: 'failed', output: { card: { ...dice([2]), id: 'failed-step' } } },
    { status: 'succeeded', output: { ok: true } },
    ...Array.from({ length: 5 }, (_, index) => ({ status: 'succeeded', output: { card: { ...dice([3]), id: `card-${index}` } } })),
  ];
  const cards = collectMaidResultCards(steps);
  assert.equal(cards.length, MAID_RESULT_CARD_LIMIT);
  assert.ok(!cards.some(card => card.id === 'failed-step'), 'only successful steps produce cards');
  assert.equal(cards.at(-1).id, 'card-4', 'the newest cards are kept');

  assert.deepEqual(maidRandomCardRerollArgs(dice([2, 5], 20)), { mode: 'dice', count: 2, sides: 20 });
  assert.deepEqual(maidRandomCardRerollArgs(draw(['甲', '乙', '丙'], ['乙', '甲'])), { mode: 'draw', options: ['甲', '乙', '丙'], pick: 2 });
  const built = buildMaidRandomCard(rollMaidRandom({ mode: 'dice', count: 2, sides: 6 }, { random: sequence(0, 5) }), { now: () => 42 });
  assert.deepEqual(normalizeMaidResultCard(built)?.data, { mode: 'dice', sides: 6, rolls: [1, 6], total: 7 }, 'the tool builds a card that passes validation');
  console.log('ok - result cards keep a fixed vocabulary and only validated data');
}

{
  // 渲染：六面骰画点数、其他面数写数字；抽签列出全部候选、抽中高亮并标先后；注明由 APP 生成
  const d6 = renderMaidResultCard(doc, dice([3, 6]), { animate: true });
  assert.ok(d6.className.includes('is-rolling'), 'a new card plays the roll animation');
  assert.equal(byClass(d6, 'mrcard-title')[0].textContent, '掷 2 个 6 面骰');
  assert.deepEqual(byClass(d6, 'mrcard-die').map(die => (die.innerHTML.match(/<circle/g) || []).length), [3, 6]);
  assert.equal(byClass(d6, 'mrcard-total')[0].children[0].textContent, '9');
  assert.equal(byClass(d6, 'mrcard-note')[0].textContent, '由 APP 随机生成');
  assert.equal(byClass(d6, 'mrcard-action').length, 0, 'no action button without a handler');

  const d20 = renderMaidResultCard(doc, dice([17], 20));
  assert.equal(byClass(d20, 'mrcard-die')[0].textContent, '17');
  assert.equal(byClass(d20, 'mrcard-total').length, 0, 'one die needs no total');
  assert.ok(!d20.className.includes('is-rolling'));

  const lots = renderMaidResultCard(doc, draw(['<img src=x onerror=alert(1)>', '乙', '丙'], ['丙', '<img src=x onerror=alert(1)>']));
  const options = byClass(lots, 'mrcard-option');
  assert.deepEqual(options.map(item => item.className.includes('is-picked')), [true, false, true]);
  assert.deepEqual(options.map(item => byClass(item, 'mrcard-order')[0]?.textContent || ''), ['2', '', '1']);
  assert.equal(options[0].children.at(-1).textContent, '<img src=x onerror=alert(1)>', 'option text is written as text');
  assert.ok(walk(lots).every(node => !node.innerHTML.includes('onerror')), 'card data never reaches innerHTML');
  assert.equal(renderMaidResultCard(doc, { type: 'random', id: 'x', data: { mode: 'dice', sides: 6, rolls: [9] } }), null);
  console.log('ok - result cards render dice, lots and choices from data only');
}

{
  // 「再来一次」：按钮在等待期间禁用；与工具同一检查，关闭后不再产生结果；新卡不改旧卡
  let release;
  const calls = [];
  const card = renderMaidResultCard(doc, dice([1]), { onAction: (payload) => { calls.push(payload); return new Promise((resolve) => { release = resolve; }); } });
  const button = byClass(card, 'mrcard-action')[0];
  const clicking = button.click();
  assert.equal(button.disabled, true, 'the button waits for the action');
  await button.click();
  assert.equal(calls.length, 1, 'double clicks while waiting do not reroll twice');
  release();
  await clicking;
  assert.equal(button.disabled, false);
  assert.deepEqual([calls[0].action, calls[0].card.id], ['reroll', 'card-dice']);

  const kv = new Map();
  const settings = new MaidSettingsStore({ storage: null, loadKv: async key => kv.get(key) ?? null, saveKv: async (key, value) => { kv.set(key, value); }, now: () => 500 });
  await settings.load();
  const off = await rerollMaidRandomCard(dice([1]), { settingsStore: settings });
  assert.deepEqual([off.ok, off.reason], [false, 'capability_disabled'], 'a reroll after the switch was turned off produces nothing');
  assert.match(off.message, /已关闭/);
  await settings.setBuiltinCapabilityEnabled('random', true);
  const original = dice([1, 1]);
  const again = await rerollMaidRandomCard(original, { settingsStore: settings, random: sequence(4, 2), now: () => 600 });
  assert.equal(again.ok, true);
  assert.notEqual(again.card.id, original.id, 'a reroll makes a new card');
  assert.deepEqual(again.card.data.rolls, [5, 3]);
  assert.deepEqual(original.data.rolls, [1, 1], 'the old card is unchanged');
  assert.equal(settings.getBuiltinCapability('random').lastUsedAt, 500);
  console.log('ok - rerolling checks the live switch, waits for the result and never edits the old card');
}

{
  // 卡片随对话保存，翻历史时仍在；没有卡片的回合不多出字段
  let saved = null;
  const store = new MaidConversationStore({ storage: null, loadKv: async () => saved, saveKv: async (key, value) => { saved = JSON.parse(JSON.stringify(value)); } });
  await store.load();
  await store.appendTurn({ id: 'with-card', input: '掷骰子', message: '掷出了 7', status: 'succeeded', cards: [dice([3, 4]), { type: 'random', id: 'bad', data: {} }] });
  await store.appendTurn({ id: 'plain', input: '你好', message: '你好', status: 'succeeded' });
  const reloaded = new MaidConversationStore({ storage: null, loadKv: async () => saved, saveKv: async () => {} });
  await reloaded.load();
  const [withCard, plain] = reloaded.exportState().turns;
  assert.deepEqual(withCard.cards.map(card => [card.id, card.data.total]), [['card-dice', 7]], 'invalid cards are not saved');
  assert.equal(Object.hasOwn(plain, 'cards'), false);
  assert.doesNotMatch(reloaded.getHistoryContextText(), /card-dice|mrcard/, 'cards stay out of the model history');
  console.log('ok - result cards are saved with the conversation and stay out of the model history');
}

{
  // 语音：任务结果带卡片，托盘从任务快照读取
  const voice = createMaidVoiceTaskRuntime({
    makeId: () => 'task-1',
    getCommandRuntime: () => ({ submitVoiceTask: async () => ({ ok: true, message: '掷出了 7', cards: [dice([3, 4])] }) }),
  });
  const target = { uiMode: 'maid', sessionId: 'maid', maidCallId: 'call-1' };
  const accepted = await voice.request({ target, args: { action: 'execute', request: '掷两个骰子' } });
  assert.equal(accepted.cards, undefined, 'no cards before the result');
  await new Promise(resolve => setTimeout(resolve, 0));
  const latest = voice.getState('call-1').latest;
  assert.deepEqual(latest.cards.map(card => card.data.total), [7]);
  console.log('ok - voice tasks carry their result cards to the call tray');
}

console.log('maid-result-cards-tests passed');
