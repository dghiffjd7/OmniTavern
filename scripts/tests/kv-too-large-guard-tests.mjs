import assert from 'node:assert/strict';

const makeLocalStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
};

const installGlobals = ({ invoke, localStorage = makeLocalStorage(), fetch } = {}) => {
  globalThis.localStorage = localStorage;
  globalThis.__TAURI_INTERNALS__ = { invoke };
  if (fetch) globalThis.fetch = fetch;
};

const makePresetDefaultsResponse = () => ({
  ok: true,
  json: async () => ({
    types: {
      sysprompt: { 'Neutral - Chat': { name: 'Neutral - Chat', prompts: [] } },
      context: { Default: { name: 'Default', prompts: [] } },
      instruct: { ChatML: { name: 'ChatML', prompts: [] } },
      openai: { Default: { name: 'Default' } },
      reasoning: { DeepSeek: { name: 'DeepSeek' } },
    },
  }),
});

{
  const calls = [];
  installGlobals({
    fetch: async () => makePresetDefaultsResponse(),
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') return { _tooLarge: true, size: 11 * 1024 * 1024 };
      if (cmd === 'save_kv') throw new Error('save_kv should not be called for too-large preset store during load');
      return null;
    },
  });

  const { PresetStore } = await import('../../src/scripts/storage/preset-store.js');
  const store = new PresetStore();
  await store.ready;

  assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
  assert.equal(store.getState().active.sysprompt, 'Neutral - Chat');
  console.log('ok - preset store does not overwrite disk when load_kv reports tooLarge');
}

{
  const calls = [];
  installGlobals({
    fetch: async () => makePresetDefaultsResponse(),
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') return {};
      if (cmd === 'save_kv') return true;
      return null;
    },
  });

  const { PresetStore } = await import('../../src/scripts/storage/preset-store.js');
  const store = new PresetStore();
  await store.ready;

  const saveNames = calls
    .filter(([cmd]) => cmd === 'save_kv')
    .map(([, args]) => args.name);
  assert.equal(saveNames.includes('prompt_preset_store_v1'), false);
  assert.equal(saveNames.includes('prompt_preset_store_v2_index'), true);
  assert.equal(saveNames.some(name => String(name).startsWith('prompt_preset_store_v2_item_sysprompt_')), true);
  console.log('ok - preset store persists sharded v2 records instead of legacy full snapshot');
}

{
  const calls = [];
  const itemKey = 'prompt_preset_store_v2_item_context_custom';
  const disk = {
    prompt_preset_store_v2_index: {
      version: 2,
      active: { context: 'ctx-custom' },
      enabled: { context: true },
      bindings: {},
      items: {
        context: {
          'ctx-custom': { key: itemKey, name: 'Custom Context' },
        },
      },
    },
    [itemKey]: {
      version: 2,
      type: 'context',
      id: 'ctx-custom',
      data: { name: 'Custom Context', prompts: [] },
    },
  };
  installGlobals({
    fetch: async () => makePresetDefaultsResponse(),
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') return disk[args.name] || {};
      if (cmd === 'save_kv') return true;
      return null;
    },
  });

  const { PresetStore } = await import('../../src/scripts/storage/preset-store.js');
  const store = new PresetStore();
  await store.ready;

  const legacyLoads = calls.filter(([cmd, args]) => cmd === 'load_kv' && args.name === 'prompt_preset_store_v1');
  assert.equal(legacyLoads.length, 0);
  assert.equal(store.getActive('context').name, 'Custom Context');
  console.log('ok - preset store loads sharded v2 index before legacy v1 store');
}

{
  const calls = [];
  installGlobals({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') return { _tooLarge: true, size: 11 * 1024 * 1024 };
      if (cmd === 'save_kv') throw new Error('save_kv should not be called for too-large regex store during load');
      return null;
    },
  });

  const { RegexStore } = await import('../../src/scripts/storage/regex-store.js');
  const store = new RegexStore();
  await store.ready;

  assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
  assert.deepEqual(store.getState().local.order, []);
  console.log('ok - regex store does not overwrite disk when load_kv reports tooLarge');
}

{
  const calls = [];
  const existing = {
    version: 1,
    global: { enabled: true, rules: [] },
    local: {
      order: ['kept-set'],
      sets: {
        'kept-set': {
          id: 'kept-set',
          name: '保留正则',
          enabled: true,
          rules: [],
        },
      },
    },
    session: {},
  };
  let loadAttempts = 0;
  installGlobals({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') {
        loadAttempts += 1;
        if (loadAttempts === 1) throw new TypeError('Failed to fetch');
        return existing;
      }
      if (cmd === 'save_kv') return true;
      return null;
    },
  });

  const { RegexStore } = await import('../../src/scripts/storage/regex-store.js');
  const store = new RegexStore();
  await store.ready;

  assert.equal(loadAttempts, 2);
  assert.equal(store.listLocalSets().length, 1);
  const saves = calls.filter(([cmd]) => cmd === 'save_kv');
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1].data.local.order[0], 'kept-set');
  console.log('ok - regex store retries a transient KV read before initializing or persisting defaults');
}

{
  // 磁盘上已是规范化后的内容（save_kv 落盘时键按字母排序）：启动不再整份写回；需要规范化时照常写回
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  const raw = {
    version: 1,
    global: { enabled: true, rules: [{ id: 'g1', scriptName: '全局', findRegex: '/a/g', replaceString: 'b' }] },
    local: { order: ['set-a'], sets: { 'set-a': { id: 'set-a', name: '组', enabled: true, rules: [{ id: 'r1', scriptName: '规则', findRegex: '/x/g', replaceString: 'y', markdownOnly: true }] } } },
    session: {},
  };
  let disk = raw, saves = [];
  installGlobals({
    invoke: async (cmd, args) => {
      if (cmd === 'load_kv') return JSON.parse(JSON.stringify(disk));
      if (cmd === 'save_kv') { saves.push(args.data); disk = sortKeys(JSON.parse(JSON.stringify(args.data))); return true; }
      return null;
    },
  });
  const { RegexStore } = await import('../../src/scripts/storage/regex-store.js');
  await new RegexStore().ready;
  assert.equal(saves.length, 1, '未规范化的旧数据照常写回一次');
  saves = [];
  const store = new RegexStore();
  await store.ready;
  assert.equal(saves.length, 0, '已规范化、只差键顺序时不重写');
  assert.equal(store.listLocalSets()[0].rules[0].findRegex, '/x/g');
  console.log('ok - regex store skips the startup rewrite when the stored data is already normalized');
}

{
  // 绑定组的 enabled 是按当前预设／世界书算出的显示值：同步只改内存，存盘一律存 manualEnabled，
  // 否则「载入重置 → 同步改回」每次启动都会把整个正则存储写三遍
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  const boundSet = (id, bind) => ({ id, name: id, bind, enabled: false, manualEnabled: true, rules: [{ id: id + '-r', scriptName: id, findRegex: '/a/g', replaceString: 'b' }], createdAt: 1, updatedAt: 1 });
  let disk = {
    version: 1,
    global: { enabled: true, rules: [] },
    local: { order: ['p1', 'w1'], sets: { p1: boundSet('p1', { type: 'preset', presetType: 'openai', presetId: 'other' }), w1: boundSet('w1', { type: 'world', worldId: 'other-world' }) } },
    session: {},
  };
  let saves = 0;
  installGlobals({
    invoke: async (cmd, args) => {
      if (cmd === 'load_kv') return JSON.parse(JSON.stringify(disk));
      if (cmd === 'save_kv') { saves += 1; disk = sortKeys(JSON.parse(JSON.stringify(args.data))); return true; }
      return null;
    },
  });
  const { RegexStore } = await import('../../src/scripts/storage/regex-store.js');
  const boot = async () => {
    const store = new RegexStore();
    await store.ready;
    await store.syncPresetBindings({ openai: 'active' });
    await store.syncWorldBindings(['active-world']);
    return store;
  };
  await boot();
  assert.equal(saves, 1, '旧数据（存着派生的 enabled=false）第一次启动规范化后写回一次');
  assert.equal(disk.local.sets.p1.enabled, true, '存盘的绑定组 enabled 跟 manualEnabled 一致');
  saves = 0;
  const store = await boot();
  assert.equal(saves, 0, '之后启动不再写盘');
  assert.equal(store.state.local.sets.p1.enabled, false, '内存里的显示值仍按当前预设更新');
  assert.equal(store.state.local.sets.w1.enabled, false);
  await store.setGlobal({ enabled: true, rules: [] });
  assert.equal(saves, 1);
  assert.equal(disk.local.sets.w1.enabled, true, '其他修改写盘时也存 manualEnabled');
  console.log('ok - regex binding syncs no longer rewrite the whole store on every startup');
}

{
  const calls = [];
  installGlobals({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') throw new TypeError('Failed to fetch');
      if (cmd === 'save_kv') throw new Error('save_kv must stay blocked after an unreadable startup');
      return null;
    },
  });

  const { RegexStore } = await import('../../src/scripts/storage/regex-store.js');
  const store = new RegexStore();
  await store.ready;

  assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
  await assert.rejects(
    store.setGlobal({ enabled: true, rules: [] }),
    /正则存储暂时无法读取/,
  );
  assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
  console.log('ok - regex store stays read-only when every startup KV read fails');
}
