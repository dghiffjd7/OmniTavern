import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const {
  createScriptWorldbookWriter,
  toTavernWorldEntry,
} = await import('../../src/scripts/plugins/script-worldbook-write.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const createBridge = ({ worlds = {}, globals = [] } = {}) => {
  const store = new Map(Object.entries(worlds));
  const revisions = new Map();
  const saves = [];
  let globalIds = globals.slice();
  return {
    saves,
    worldStore: { list: () => Array.from(store.keys()) },
    async getWorldInfoSnapshot(id) {
      return {
        worldbookId: id,
        exists: store.has(id),
        revision: revisions.get(id) || 0,
        generation: 1,
        data: store.get(id) || null,
      };
    },
    async saveWorldInfo(id, data, options) {
      saves.push({ id, data, options });
      store.set(id, data);
      revisions.set(id, (revisions.get(id) || 0) + 1);
      return { ok: true };
    },
    getGlobalWorldIds: () => globalIds.slice(),
    setGlobalWorldIds(ids) { globalIds = ids.slice(); },
  };
};

const createConfirm = (answers = []) => {
  const calls = [];
  const confirm = async (options) => {
    calls.push(options);
    return answers.length ? answers.shift() : true;
  };
  return { calls, confirm };
};

test('helper-format entries become raw tavern entries the importer understands', () => {
  const entry = toTavernWorldEntry({
    uid: 7,
    name: 'Flow｜标准DM',
    enabled: false,
    strategy: {
      type: 'selective',
      keys: ['MODE_STANDARD_DM', /JX_\d+/i],
      keys_secondary: { logic: 'not_any', keys: ['B'] },
      scan_depth: 'same_as_global',
    },
    position: { type: 'at_depth', role: 'assistant', depth: 0, order: 900 },
    content: '正文',
    probability: 80,
    recursion: { prevent_incoming: true, prevent_outgoing: false, delay_until: null },
    effect: { sticky: 2, cooldown: null, delay: null },
    addMemo: true,
    group: 'g1',
  });
  assert.equal(entry.uid, 7);
  assert.equal(entry.comment, 'Flow｜标准DM');
  assert.equal(entry.disable, true);
  assert.equal(entry.constant, false);
  assert.equal(entry.selective, true);
  assert.deepEqual(entry.key, ['MODE_STANDARD_DM', '/JX_\\d+/i']);
  assert.deepEqual(entry.keysecondary, ['B']);
  assert.equal(entry.selectiveLogic, 2);
  assert.equal(entry.scanDepth, null);
  assert.equal(entry.position, 4);
  assert.equal(entry.role, 2);
  assert.equal(entry.depth, 0);
  assert.equal(entry.order, 900);
  assert.equal(entry.probability, 80);
  assert.equal(entry.excludeRecursion, true);
  assert.equal(entry.preventRecursion, false);
  assert.equal(entry.sticky, 2);
  assert.equal(entry.cooldown, null);
  assert.equal(entry.addMemo, true);
  assert.equal(entry.group, 'g1');
  assert.equal('strategy' in entry, false);
  const constant = toTavernWorldEntry({ name: 'C', strategy: { type: 'constant', keys: [] }, content: 'x' });
  assert.equal(constant.constant, true);
  assert.equal(constant.disable, false);
  // 已是酒馆原始格式的条目原样交给导入转换
  const raw = { uid: 3, comment: 'R', key: ['k'], position: 1, content: 'r' };
  assert.deepEqual(toTavernWorldEntry(raw), raw);
});

test('createWorldbook asks once, saves through the guarded import path and returns the new listing', async () => {
  const bridge = createBridge({ worlds: { Old: { name: 'Old', entries: [] } }, globals: ['Old'] });
  const { calls, confirm } = createConfirm([true]);
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  const result = await writer.write({
    mode: 'create',
    name: '剑仙133_统一世界书',
    entries: [{ name: 'A', strategy: { type: 'selective', keys: ['MODE_X'] }, content: 'a' }, { name: 'B', content: 'b' }],
    scriptId: 's1',
    scriptName: '剑仙187｜当前场景',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /剑仙187｜当前场景/);
  assert.match(calls[0].message, /剑仙133_统一世界书/);
  assert.match(calls[0].message, /2 条/);
  assert.equal(bridge.saves.length, 1);
  assert.equal(bridge.saves[0].id, '剑仙133_统一世界书');
  assert.equal(bridge.saves[0].options.expectedExists, false);
  assert.deepEqual(bridge.saves[0].data.entries.map(entry => entry.comment), ['A', 'B']);
  assert.deepEqual(bridge.saves[0].data.entries[0].key, ['MODE_X']);
  assert.deepEqual(result, { created: true, names: ['Old', '剑仙133_统一世界书'], globalNames: ['Old'] });
  // TavernHelper 的 createWorldbook 遇到同名世界书返回 false，不覆盖、不弹窗
  const again = await writer.write({ mode: 'create', name: '剑仙133_统一世界书', entries: [], scriptId: 's1', scriptName: 'x' });
  assert.equal(again.created, false);
  assert.equal(calls.length, 1);
  assert.equal(bridge.saves.length, 1);
});

test('replacing or importing over an existing worldbook needs a danger confirmation', async () => {
  const bridge = createBridge({ worlds: { Book: { name: 'Book', entries: [{ comment: 'x' }, { comment: 'y' }] } } });
  const { calls, confirm } = createConfirm([true, true]);
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  const replaced = await writer.write({ mode: 'replace', name: 'Book', entries: [{ name: 'only', content: '1' }], scriptId: 's', scriptName: 'S' });
  assert.equal(replaced.created, false);
  assert.equal(calls[0].danger, true);
  assert.match(calls[0].message, /现有 2 条/);
  assert.equal(bridge.saves[0].options.expectedExists, true);
  assert.deepEqual(bridge.saves[0].data.entries.map(entry => entry.comment), ['only']);
  const imported = await writer.write({
    mode: 'import',
    name: 'Book.json',
    content: JSON.stringify({ entries: { 0: { uid: 0, comment: 'raw', key: ['k'], content: 'c', position: 4, depth: 0 } } }),
    scriptId: 's',
    scriptName: 'S',
  });
  assert.equal(imported.created, false);
  assert.equal(calls.length, 2);
  assert.equal(bridge.saves[1].id, 'Book');
  assert.equal(bridge.saves[1].data.entries[0].comment, 'raw');
  await assert.rejects(
    writer.write({ mode: 'import', name: 'Bad', content: '{oops', scriptId: 's', scriptName: 'S' }),
    /不是有效的 JSON/,
  );
});

test('a refusal is remembered so retrying scripts do not reopen the dialog', async () => {
  const bridge = createBridge();
  const { calls, confirm } = createConfirm([false]);
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  const request = { mode: 'create', name: 'Book', entries: [], scriptId: 's', scriptName: 'S' };
  await assert.rejects(writer.write(request), /拒绝/);
  await assert.rejects(writer.write(request), /拒绝/);
  assert.equal(calls.length, 1);
  assert.equal(bridge.saves.length, 0);
});

test('identical requests in flight share one dialog and one save', async () => {
  const bridge = createBridge();
  let release;
  const calls = [];
  const confirm = options => {
    calls.push(options);
    return new Promise(resolve => { release = resolve; });
  };
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  const request = { mode: 'create', name: 'Book', entries: [{ name: 'a', content: 'a' }], scriptId: 's', scriptName: 'S' };
  const first = writer.write(request);
  const second = writer.write(request);
  await new Promise(resolve => setTimeout(resolve, 0));
  release(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(bridge.saves.length, 1);
  assert.equal(a.created, true);
  assert.equal(b.created, true);
});

test('dialogs from different requests are shown one after another', async () => {
  const bridge = createBridge();
  let open = 0;
  let maxOpen = 0;
  const confirm = async () => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise(resolve => setTimeout(resolve, 5));
    open -= 1;
    return true;
  };
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  await Promise.all([
    writer.write({ mode: 'create', name: 'A', entries: [], scriptId: 's', scriptName: 'S' }),
    writer.write({ mode: 'create', name: 'B', entries: [], scriptId: 's', scriptName: 'S' }),
  ]);
  assert.equal(maxOpen, 1);
  assert.equal(bridge.saves.length, 2);
});

test('global binding only appends, after confirmation, and never drops existing globals', async () => {
  const bridge = createBridge({ worlds: { Mine: {}, Other: {}, JX: {} }, globals: ['Mine', 'Other'] });
  const { calls, confirm } = createConfirm([true]);
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  // 脚本传来的名单不含 Other：酒馆会解绑，APP 只追加
  const result = await writer.bindGlobal({ names: ['Mine', 'JX'], scriptId: 's', scriptName: 'S' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /JX/);
  assert.doesNotMatch(calls[0].message, /Mine/);
  assert.deepEqual(bridge.getGlobalWorldIds(), ['Mine', 'Other', 'JX']);
  assert.deepEqual(result.globalNames, ['Mine', 'Other', 'JX']);
  // 没有新增时不弹窗
  await writer.bindGlobal({ names: ['JX'], scriptId: 's', scriptName: 'S' });
  assert.equal(calls.length, 1);
  await assert.rejects(writer.bindGlobal({ names: ['Missing'], scriptId: 's', scriptName: 'S' }), /不存在/);
  assert.equal(calls.length, 1);
});

test('a refused global binding leaves globals untouched', async () => {
  const bridge = createBridge({ worlds: { JX: {} }, globals: ['Mine'] });
  const { confirm } = createConfirm([false]);
  const writer = createScriptWorldbookWriter({ bridge, confirm });
  await assert.rejects(writer.bindGlobal({ names: ['Mine', 'JX'], scriptId: 's', scriptName: 'S' }), /拒绝/);
  assert.deepEqual(bridge.getGlobalWorldIds(), ['Mine']);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
