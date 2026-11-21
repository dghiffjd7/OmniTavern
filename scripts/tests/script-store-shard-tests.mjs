import assert from 'node:assert/strict';

// 脚本存档分片：旧版整包档 script_store_v1 超过 30MB 存不进去（Dream 1.65 导入后脚本消失），
// 改成全局／每张角色卡／每个预设各一个分片，索引记档名。用内存 KV 模拟 load_kv/save_kv。

const toasts = [];
globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ||= { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };
globalThis.window.toastr = { error: message => toasts.push(String(message)) };

const { ScriptStore } = await import('../../src/scripts/storage/script-store.js');

const LEGACY = 'script_store_v1';
const INDEX = 'script_store_v2_index';

const script = (id, name, extra = {}) => ({ id, name, content: `console.log(${JSON.stringify(name)});`, enabled: true, authorized: true, ...extra });

const legacyState = () => ({
  version: 2,
  global: { scripts: [script('g1', '全局脚本')], variables: { g: 1 } },
  character: { persona_a: { scripts: [script('c1', '角色脚本')], variables: {} } },
  preset: {
    'preset-openai-1': { scripts: [script('p1', '预设一')], variables: { tag: true } },
    'preset-openai-2': { scripts: [script('p2', '预设二'), script('p3', '预设三')], variables: {} },
  },
});

// 内存 KV：档案不存在回 {}；failLoad/failSave 里的档名模拟读写出错
const installKv = (initial = {}, { failLoad = new Set(), failSave = new Set() } = {}) => {
  const files = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const log = [];
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      log.push({ cmd, name: args?.name, compact: args?.compact });
      if (cmd === 'load_kv') {
        if (failLoad.has(args.name)) throw new Error('disk error');
        return files.has(args.name) ? JSON.parse(files.get(args.name)) : {};
      }
      if (cmd === 'save_kv') {
        if (failSave.has(args.name)) throw new Error('kv_too_large:99');
        files.set(args.name, JSON.stringify(args.data));
        return null;
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return { files, log, read: name => (files.has(name) ? JSON.parse(files.get(name)) : undefined) };
};

const saves = log => log.filter(entry => entry.cmd === 'save_kv').map(entry => entry.name);
const names = store => ({
  global: store.getScripts('global').map(s => s.name),
  character: store.listScopes().character,
  preset: store.listScopes().preset,
});

{
  const kv = installKv({ [LEGACY]: legacyState() });
  const store = new ScriptStore();
  await store.ready;
  const index = kv.read(INDEX);
  assert.equal(index.items.length, 4, 'global + 1 character + 2 presets');
  assert.deepEqual(index.items.map(item => `${item.scope}:${item.id}`), ['global:global', 'character:persona_a', 'preset:preset-openai-1', 'preset:preset-openai-2']);
  for (const item of index.items) {
    const payload = kv.read(item.key);
    assert.equal(payload.scope, item.scope);
    assert.equal(payload.id, item.id);
    assert.match(item.key, /^script_store_v2_item_(global|character|preset)_[a-z0-9]+_[A-Za-z0-9_-]+$/);
  }
  assert.ok(kv.log.filter(entry => entry.cmd === 'save_kv' && entry.name !== INDEX).every(entry => entry.compact === true), 'shards are written compact');
  assert.equal(saves(kv.log).includes(LEGACY), false, 'the old file is left as it was');
  assert.deepEqual(kv.read(LEGACY), legacyState());
  assert.deepEqual(kv.read(kv.read(INDEX).items[2].key).data.variables, { tag: true });
  assert.deepEqual(names(store), { global: ['全局脚本'], character: ['persona_a'], preset: ['preset-openai-1', 'preset-openai-2'] });
  console.log('ok - the old single file migrates into one shard per scope and stays untouched');

  kv.log.length = 0;
  const p2 = store.getScripts('preset', 'preset-openai-2');
  assert.equal(await store.toggleScript('preset', 'preset-openai-2', p2[0].id, false), true);
  const p2Key = kv.read(INDEX).items[3].key;
  assert.deepEqual(saves(kv.log), [p2Key, INDEX], 'only the changed preset shard and the index are written');
  console.log('ok - a change writes only its own shard');

  const again = installKv(Object.fromEntries([...kv.files.entries()].map(([k, v]) => [k, JSON.parse(v)])));
  const reloaded = new ScriptStore();
  await reloaded.ready;
  assert.equal(reloaded.getScripts('preset', 'preset-openai-2')[0].enabled, false);
  assert.deepEqual(names(reloaded), names(store));
  assert.deepEqual(saves(again.log), [], 'reading the shards back writes nothing');
  console.log('ok - a fresh start reads the shards back');
}

{
  const kv = installKv({ [LEGACY]: legacyState() });
  const store = new ScriptStore();
  await store.ready;
  const startup = kv.log.length;
  const fresh = new ScriptStore();
  await fresh.ready;
  assert.equal(saves(kv.log.slice(startup)).length, 0, 'loading from shards writes nothing');
  const removedKey = kv.read(INDEX).items.find(item => item.id === 'preset-openai-1').key;
  assert.equal(await fresh.removeScope('preset', 'preset-openai-1'), true);
  assert.equal(kv.read(removedKey), null, 'a removed scope clears its shard');
  assert.equal(kv.read(INDEX).items.some(item => item.key === removedKey), false);
  console.log('ok - removing a scope clears its shard; loading writes nothing');
}

{
  const kv = installKv({ [LEGACY]: legacyState() });
  await new ScriptStore().ready;
  const lostKey = kv.read(INDEX).items.find(item => item.id === 'preset-openai-1').key;
  const files = Object.fromEntries([...kv.files.entries()].map(([k, v]) => [k, JSON.parse(v)]));
  const next = installKv(files, { failLoad: new Set([lostKey]) });
  const store = new ScriptStore();
  await store.ready;
  assert.equal(store.listScopes().preset.includes('preset-openai-1'), false);
  await store.setScopeVariables('preset', 'preset-openai-2', { changed: true });
  assert.ok(next.read(INDEX).items.some(item => item.key === lostKey), 'an unreadable shard stays in the index');
  assert.notEqual(next.read(lostKey), null, 'and its file is not cleared');
  console.log('ok - a shard that cannot be read is kept, not treated as deleted');
}

{
  const kv = installKv({ [LEGACY]: legacyState() }, { failLoad: new Set([LEGACY]) });
  toasts.length = 0;
  const store = new ScriptStore();
  await store.ready;
  await store.upsertScript('global', '', script('new', '新脚本'));
  assert.deepEqual(saves(kv.log), [], 'nothing is written when the old file could not be read');
  assert.ok(toasts.some(message => /读不出来/.test(message)));
  const big = installKv({ [LEGACY]: { _tooLarge: true, size: 40000000 } });
  const blocked = new ScriptStore();
  await blocked.ready;
  await blocked.upsertScript('global', '', script('new', '新脚本'));
  assert.deepEqual(saves(big.log), []);
  console.log('ok - an unreadable or oversized old file blocks saving instead of overwriting it with nothing');
}

{
  const kv = installKv({ [LEGACY]: legacyState() });
  await new ScriptStore().ready;
  const files = Object.fromEntries([...kv.files.entries()].map(([k, v]) => [k, JSON.parse(v)]));
  const next = installKv(files, { failLoad: new Set([INDEX]) });
  const store = new ScriptStore();
  await store.ready;
  assert.deepEqual(names(store), { global: [], character: [], preset: [] }, 'the old file is not used as a fallback');
  await store.upsertScript('global', '', script('new', '新脚本'));
  assert.deepEqual(saves(next.log), []);
  console.log('ok - an unreadable index blocks saving and does not fall back to the old file');
}

{
  const firstShard = 'script_store_v2_item_preset';
  const kv = installKv({ [LEGACY]: legacyState() });
  const realInvoke = globalThis.__TAURI_INTERNALS__.invoke;
  globalThis.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === 'save_kv' && String(args.name).startsWith(firstShard)) throw new Error('kv_too_large:1');
    return realInvoke(cmd, args);
  };
  toasts.length = 0;
  await new ScriptStore().ready;
  assert.equal(kv.read(INDEX), undefined, 'no index when a shard failed during migration');
  assert.ok(toasts.some(message => /迁移没有完成/.test(message)));
  globalThis.__TAURI_INTERNALS__.invoke = realInvoke;
  const retry = new ScriptStore();
  await retry.ready;
  assert.equal(kv.read(INDEX).items.length, 4, 'the next start migrates from the old file again');
  console.log('ok - a failed migration leaves no index and is retried from the old file');
}

{
  const kv = installKv({ [LEGACY]: legacyState() });
  const store = new ScriptStore();
  await store.ready;
  const key = kv.read(INDEX).items.find(item => item.id === 'preset-openai-2').key;
  const realInvoke = globalThis.__TAURI_INTERNALS__.invoke;
  globalThis.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === 'save_kv' && args.name === key) throw new Error('kv_too_large:31984367');
    return realInvoke(cmd, args);
  };
  toasts.length = 0;
  const ok = await store.updateScript('preset', 'preset-openai-2', store.getScripts('preset', 'preset-openai-2')[0].id, { name: '改名' });
  assert.equal(ok, true);
  assert.equal(await store.persist(), false, 'a failed shard save is reported');
  assert.ok(toasts.some(message => /没能存档/.test(message) && /kv_too_large/.test(message)), 'the user is told instead of a silent debug log');
  console.log('ok - a failed shard save shows a notice');
}
