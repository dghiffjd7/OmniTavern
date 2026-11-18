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
  // 地图卡：只存地点名与方式（不存网址）；渲染地点、或起点 → 终点与出行方式；按钮是「打开」
  const place = { id: 'card-map', type: 'map', createdAt: 1, data: { provider: 'google', mode: 'search', query: ' 台北\u0000101 ', url: 'https://evil.example' } };
  assert.deepEqual(normalizeMaidResultCard(place).data, { provider: 'google', mode: 'search', query: '台北 101' }, 'stored urls are dropped');
  assert.equal(normalizeMaidResultCard({ ...place, data: { ...place.data, provider: 'apple' } }), null);
  assert.equal(normalizeMaidResultCard({ ...place, data: { provider: 'amap', mode: 'route', destination: '' } }), null, 'a route needs a destination');
  const route = { id: 'card-route', type: 'map', createdAt: 1, data: { provider: 'amap', mode: 'route', destination: '故宫', origin: '', travelMode: 'fly' } };
  assert.deepEqual(normalizeMaidResultCard(route).data, { provider: 'amap', mode: 'route', destination: '故宫', origin: '', travelMode: '' });

  const actions = [];
  const placeEl = renderMaidResultCard(doc, place, { animate: true, onAction: async payload => actions.push(payload) });
  assert.ok(!placeEl.className.includes('is-rolling'), 'only random cards animate');
  assert.deepEqual([byClass(placeEl, 'mrcard-title')[0].textContent, byClass(placeEl, 'mrcard-place')[0].textContent], ['地点', '台北 101']);
  assert.equal(byClass(placeEl, 'mrcard-note')[0].textContent, '点开后在Google 地图查看');
  const open = byClass(placeEl, 'mrcard-action')[0];
  assert.deepEqual([open.dataset.action, open.children.at(-1).textContent], ['open', '在Google 地图打开']);
  await open.click();
  assert.deepEqual([actions[0].action, actions[0].card.id], ['open', 'card-map']);

  const routeEl = renderMaidResultCard(doc, { ...route, data: { ...route.data, travelMode: 'walking' } });
  assert.equal(byClass(routeEl, 'mrcard-title')[0].textContent, '路线');
  assert.deepEqual(byClass(routeEl, 'mrcard-stop').map(stop => [stop.textContent, stop.className]), [['我的位置', 'mrcard-stop is-here'], ['故宫', 'mrcard-stop is-end']]);
  assert.equal(byClass(routeEl, 'mrcard-mode')[0].children[0].textContent, '步行');
  assert.equal(byClass(routeEl, 'mrcard-note')[0].textContent, '高德只能搜索地点，到高德里再点「路线」');
  console.log('ok - map cards keep place names only and render a place or a route with an open button');
}

{
  // 天气卡：数字只收合理范围；渲染当前天气、逐日预报与来源；没有动作按钮；超过 3 小时标「可能已过时」
  const weather = (patch = {}) => ({ id: 'card-weather', type: 'weather', createdAt: 1, data: {
    place: { name: '台北', region: '台湾', country: '台湾' }, timezone: 'Asia/Taipei', localTime: '2026-11-02T20:00', fetchedAt: Date.now(),
    current: { temperature: 23, feelsLike: 25, humidity: 81, wind: 12, code: 2, isDay: true },
    daily: [{ date: '2026-11-02', code: 2, max: 26, min: 20, rain: 40 }, { date: '2026-11-03', code: 61, max: 24, min: 20, rain: 85 }, { date: '2026-11-04', code: 3, max: 24, min: 19, rain: null }],
    ...patch,
  } });
  assert.ok(normalizeMaidResultCard(weather()));
  assert.equal(normalizeMaidResultCard(weather({ current: { temperature: 999, code: 2 } })), null);
  assert.equal(normalizeMaidResultCard(weather({ daily: [{ date: 'tomorrow', code: 2, max: 1, min: 0, rain: 0 }] })), null);
  assert.equal(normalizeMaidResultCard(weather({ daily: [{ date: '2026-11-02', code: 2, max: 1, min: 0, rain: 140 }] })), null);
  const el = renderMaidResultCard(doc, weather(), { onAction: async () => {} });
  assert.deepEqual([byClass(el, 'mrcard-title')[0].textContent, byClass(el, 'mrcard-sub')[0].textContent], ['台北 · 台湾', '当地 20:00']);
  assert.equal(byClass(el, 'mrcard-temp')[0].textContent, '23°');
  assert.equal(byClass(el, 'mrcard-meta')[0].textContent, '体感 25° · 湿度 81% · 风 12 km/h');
  assert.deepEqual(byClass(el, 'mrcard-day-label').map(label => label.textContent), ['今天', '明天', '11/4']);
  assert.deepEqual(byClass(el, 'mrcard-day-rain').map(rain => rain.children[0]?.textContent || ''), ['40%', '85%', ''], 'an unknown rain chance is left blank');
  assert.equal(byClass(el, 'mrcard-action').length, 0, 'weather cards have no action button');
  assert.match(byClass(el, 'mrcard-note')[0].textContent, /^来源 Open-Meteo · 获取于 \d{2}:\d{2}$/);
  const city = renderMaidResultCard(doc, weather({ place: { name: '高雄市', region: '高雄市', country: '台湾' } }));
  assert.equal(byClass(city, 'mrcard-title')[0].textContent, '高雄市 · 台湾', 'a region with the same name as the city shows the country instead');
  const old = renderMaidResultCard(doc, weather({ fetchedAt: Date.now() - 4 * 60 * 60 * 1000 }));
  assert.match(byClass(old, 'mrcard-note')[0].textContent, /可能已过时$/);
  console.log('ok - weather cards validate their numbers and render now, days and the source');
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

{
  // 选项提问卡（ROADMAP 29-①）：来自收尾反问附的 choices，APP 校验裁剪；不合规的题目丢掉，一题不剩就不出卡
  const { buildMaidChoiceCard, collectMaidResultCardsFromResult, formatMaidChoiceAnswer, summarizeMaidChoiceCard } = await import('../../src/scripts/agent/maid-result-cards.js');
  const card = buildMaidChoiceCard([
    { question: '要改哪一本世界书？', options: [{ label: '雾港来信', description: '角色世界书' }, { label: '全局设定' }, { label: '雾港来信' }], recommended: 0 },
    { question: '只有一个选项', options: [{ label: '唯一' }] },
    { question: '改哪些条目？', options: ['灯塔邮局', '雾港', '雾灵', '余温信', '蒸汽电车'], multiSelect: true, recommended: 9 },
  ], { id: 'choice-1', createdAt: 5 });
  assert.equal(card.type, 'choice');
  assert.deepEqual(card.data.questions.map(q => [q.question, q.options.map(o => o.label), q.recommended, q.multiSelect]), [
    ['要改哪一本世界书？', ['雾港来信', '全局设定'], 0, false],
    ['改哪些条目？', ['灯塔邮局', '雾港', '雾灵', '余温信'], null, true],
  ], 'duplicates dropped, a one-option question dropped, at most four options, out-of-range recommendation cleared');
  assert.equal(buildMaidChoiceCard([{ question: '只有一个', options: ['A'] }]), null, 'no valid question, no card (the text question stays)');
  assert.equal(normalizeMaidResultCard({ ...card, data: { questions: [] } }), null);

  // 一次结果的全部卡片：工具卡在前、选项卡在最后
  const all = collectMaidResultCardsFromResult({ steps: [{ status: 'succeeded', output: { card: dice([2, 5]) } }], finalDecision: { choiceCard: card } });
  assert.deepEqual(all.map(item => item.id), ['card-dice', 'choice-1']);
  assert.deepEqual(collectMaidResultCardsFromResult({ steps: [] }), []);

  // 回答：一题就是选中的项；几题每行「题目：回答」；有没答的题不送
  const single = buildMaidChoiceCard([{ question: '用哪个？', options: ['甲', '乙', '丙'] }], { id: 'c2' });
  assert.equal(formatMaidChoiceAnswer(single, [[1]]), '乙');
  assert.equal(formatMaidChoiceAnswer(card, [[0], [2, 0]]), '要改哪一本世界书？：雾港来信\n改哪些条目？：灯塔邮局、雾灵');
  assert.equal(formatMaidChoiceAnswer(card, [[0], []]), '');
  assert.equal(summarizeMaidChoiceCard(card), '要改哪一本世界书？（雾港来信／全局设定）；改哪些条目？（灯塔邮局／雾港／雾灵／余温信，可多选）');

  // 女仆下一轮的历史里记着给过的选项
  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {} });
  await store.load();
  await store.appendTurn({ input: '帮我改世界书', message: '要改哪一本？', status: 'responded', cards: [card] });
  assert.match(store.getContextSnapshot().historyText, /给用户的选项: 要改哪一本世界书？（雾港来信／全局设定）/);
  console.log('ok - choice cards are validated, collected after tool cards, answered and remembered in history');
}

{
  // 选项提问卡的界面：一题单选点了就送；几题都选好才能点「发送」；送不出去就解锁；历史里只显示
  const { buildMaidChoiceCard } = await import('../../src/scripts/agent/maid-result-cards.js');
  class ClassyElement extends FakeElement {
    constructor(tag) {
      super(tag);
      const set = new Set();
      this.classList = { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
    }
  }
  const cdoc = { head: new ClassyElement('head'), createElement: tag => new ClassyElement(tag), getElementById: () => null };
  const choices = el => walk(el).filter(node => node.className === 'mrcard-choice');
  const single = buildMaidChoiceCard([{ question: '用哪个？', options: ['甲', '乙'] }], { id: 's1' });
  const calls = [];
  const singleEl = renderMaidResultCard(cdoc, single, { onAction: async (payload) => { calls.push(payload); return { answered: true }; } });
  assert.equal(walk(singleEl).some(node => node.className.includes('mrcard-send')), false, 'one single-choice question needs no send button');
  await choices(singleEl)[1].click();
  assert.deepEqual(calls.map(call => [call.action, call.card.id, call.picks]), [['answer', 's1', [[1]]]]);
  assert.equal(singleEl.classList.contains('is-answered'), true);
  assert.equal(choices(singleEl).every(button => button.disabled), true, 'locked once answered');
  await choices(singleEl)[0].click();
  assert.equal(calls.length, 1, 'no second answer');

  const multi = buildMaidChoiceCard([
    { question: '哪本？', options: ['A', 'B'] },
    { question: '哪些条目？', options: ['x', 'y', 'z'], multiSelect: true },
  ], { id: 'm1' });
  const sent = [];
  let accept = false;
  const multiEl = renderMaidResultCard(cdoc, multi, { onAction: async (payload) => { sent.push(payload.picks); return accept ? { answered: true } : null; } });
  const send = walk(multiEl).find(node => node.className.includes('mrcard-send'));
  const [a, , x, , z] = choices(multiEl);
  assert.equal(send.disabled, true);
  await a.click();
  await x.click();
  await z.click();
  assert.equal(send.disabled, false, 'every question answered');
  await send.click();
  assert.deepEqual(sent, [[[0], [0, 2]]]);
  assert.equal(multiEl.classList.contains('is-answered'), false, 'not sent: unlocked to try again');
  assert.equal(choices(multiEl).every(button => !button.disabled), true);
  accept = true;
  await send.click();
  assert.equal(multiEl.classList.contains('is-answered'), true);

  // 历史里：只显示题目与选项，没有按钮
  const readOnly = renderMaidResultCard(cdoc, single, { onAction: async () => ({ answered: true }), answerable: false });
  assert.equal(walk(readOnly).filter(node => node.tagName === 'BUTTON').length, 0);
  assert.deepEqual(walk(readOnly).filter(node => node.className === 'mrcard-choice').map(node => node.tagName), ['DIV', 'DIV']);
  console.log('ok - choice card answers on tap, waits for every question, unlocks on failure and is read-only in history');
}
