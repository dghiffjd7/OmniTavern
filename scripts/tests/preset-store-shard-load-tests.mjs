import assert from 'node:assert/strict';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ||= { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };

const { PresetStore } = await import('../../src/scripts/storage/preset-store.js');

// 启动读取预设分片：并发读取但限制并发数，结果按索引顺序写入，读取失败/缺失仍跳过启动写回

const makeIndex = (ids) => ({
  version: 2,
  presetScopeSchemaVersion: 1,
  active: { openai: ids[0] },
  builtinActive: {},
  enabled: { openai: true },
  bindings: {},
  items: { openai: Object.fromEntries(ids.map(id => [id, { key: `item_${id}`, name: id }])) },
});

const makeStore = () => {
  const store = Object.create(PresetStore.prototype);
  store.persistedItemSignatures = new Map();
  return store;
};

{
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  let inFlight = 0;
  let peak = 0;
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      assert.equal(cmd, 'load_kv');
      if (args.name === 'prompt_preset_store_v2_index') return makeIndex(ids);
      const id = args.name.replace('item_', '');
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // 靠后的分片先返回，验证最终顺序不受完成顺序影响
      await new Promise(resolve => setTimeout(resolve, 40 - Number(id.slice(1))));
      inFlight -= 1;
      return { version: 2, type: 'openai', id, data: { name: id } };
    },
  };
  const store = makeStore();
  const { state, skipPersistOnLoad } = await store.loadShardedState();
  assert.deepEqual(Object.keys(state.presets.openai), ids, '预设顺序与索引一致');
  assert.equal(skipPersistOnLoad, false);
  assert.ok(peak > 1, '分片并发读取');
  assert.ok(peak <= 8, `并发数受限，实际 ${peak}`);
  assert.equal(store.persistedItemSignatures.size, ids.length);
  console.log('ok - preset shards load concurrently with bounded parallelism and keep index order');
}

{
  const ids = ['a', 'b', 'c', 'd'];
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (args.name === 'prompt_preset_store_v2_index') return makeIndex(ids);
      const id = args.name.replace('item_', '');
      if (id === 'b') throw new Error('disk error');
      if (id === 'c') return { _tooLarge: true, size: 99 };
      if (id === 'd') return {};
      return { version: 2, type: 'openai', id, data: { name: id } };
    },
  };
  const store = makeStore();
  const { state, skipPersistOnLoad } = await store.loadShardedState();
  assert.deepEqual(Object.keys(state.presets.openai), ['a']);
  assert.equal(skipPersistOnLoad, true, '有分片读取失败、过大或缺失时，启动不做写回清理');
  console.log('ok - failed, oversized or missing preset shards are skipped and block startup prune');
}

{
  const store = Object.create(PresetStore.prototype);
  const big = { name: '大预设', app_scope: 'creative', prompts: [{ content: 'x'.repeat(1000) }] };
  store.state = {
    presets: { openai: { big, all: { name: '通用', app_scope: 'all' } } },
    active: { openai: 'big' },
    enabled: { openai: true, sysprompt: false },
  };
  const selection = store.getSelectionState();
  assert.deepEqual(selection, { active: { openai: 'big' }, enabled: { openai: true, sysprompt: false }, builtinActive: {} });
  selection.enabled.openai = false;
  selection.active.openai = 'all';
  assert.equal(store.state.enabled.openai, true, '返回的是副本，改动不回写 state');
  assert.equal(store.state.active.openai, 'big');
  assert.deepEqual(store.listSummaries('openai'), [
    { id: 'big', name: '大预设', app_scope: 'creative' },
    { id: 'all', name: '通用', app_scope: 'all' },
  ], '摘要按存储顺序，只含 id/名称/适用范围');
  assert.throws(() => store.listSummaries('bogus'));
  const single = store.getPreset('openai', 'big');
  assert.deepEqual(single, { id: 'big', ...big }, '单个预设副本形状同 list() 条目');
  assert.notEqual(single.prompts, big.prompts, '返回副本');
  assert.deepEqual(single, store.list('openai').find(item => item.id === 'big'));
  assert.equal(store.getPreset('openai', 'missing'), null);
  store.state = null;
  assert.deepEqual(store.getSelectionState(), { active: {}, enabled: {}, builtinActive: {} });
  console.log('ok - preset selection state and summaries read without copying preset bodies');
}

{
  // 模拟 save_kv/load_kv 往返：Rust 侧 serde_json 落盘后对象键按字母排序
  const sortKeysDeep = v => Array.isArray(v)
    ? v.map(sortKeysDeep)
    : (v && typeof v === 'object')
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeysDeep(v[k])]))
      : v;
  const disk = new Map();
  const saves = [];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ types: { sysprompt: {}, context: {}, instruct: {}, reasoning: {}, openai: { Default: { name: 'Default' } } } }),
  });
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === 'load_kv') return disk.has(args.name) ? structuredClone(disk.get(args.name)) : {};
      if (cmd === 'save_kv') {
        saves.push(args.name);
        disk.set(args.name, sortKeysDeep(JSON.parse(JSON.stringify(args.data))));
        return true;
      }
      return null;
    },
  };
  const imported = {
    name: '导入预设',
    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'hi' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: false }] }],
  };
  const first = new PresetStore();
  await first.ready;
  await first.importState({
    presets: { openai: { imported } },
    active: { openai: 'imported' },
    enabled: { openai: true },
  }, { mode: 'merge' });
  const itemKeys = [...disk.keys()].filter(key => key.startsWith('prompt_preset_store_v2_item_'));
  assert.ok(itemKeys.some(key => key.includes('imported')), '导入的预设已落盘');
  saves.length = 0;
  const second = new PresetStore();
  await second.ready;
  assert.deepEqual(saves.filter(name => name.startsWith('prompt_preset_store_v2_item_')), [], '内容未变的预设在重启后不重写');
  const order = second.state.presets.openai.imported.prompt_order[0].order;
  assert.deepEqual(order.map(item => [item.identifier, item.enabled]), [['main', true], ['chatHistory', false]]);
  console.log('ok - presets survive a key-sorted disk round trip without startup rewrites');
}

{
  const store = Object.create(PresetStore.prototype);
  const stored = { name: '导入预设', app_scope: 'all' };
  store.state = { presets: { openai: { big: stored } }, active: { openai: 'big' }, enabled: { openai: true }, bindings: {}, builtinActive: {} };
  store.inUsePresets = new Map();
  store.revision = 3;
  store.persistShardedState = async () => {};
  const peeked = store.peekResolvedActive('openai', { uiMode: 'rp' });
  assert.equal(peeked.presetId, 'big');
  assert.equal(peeked.preset, stored, '窥视返回存储中的原对象，不复制');
  assert.equal(peeked.revision, 3);
  assert.notEqual(store.getResolvedActive('openai', { uiMode: 'rp' }).preset, stored, 'getResolvedActive 仍返回副本');
  await store.persist();
  assert.equal(store.peekResolvedActive('openai', { uiMode: 'rp' }).revision, 4, '持久化后 revision 递增');
  store.setInUsePreset('openai', { sessionId: 's1', uiMode: 'rp' }, 'big', { name: '工作副本' });
  const draft = store.peekResolvedActive('openai', { sessionId: 's1', uiMode: 'rp' });
  assert.equal(draft.preset.name, '工作副本');
  assert.equal(draft.revision, 5, '设置会话工作副本时 revision 递增');
  console.log('ok - peekResolvedActive returns stored preset without copying and exposes a revision');
}
