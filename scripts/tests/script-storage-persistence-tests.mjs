import assert from 'node:assert/strict';

const {
  createScriptStoragePersistence,
  SCRIPT_LOCAL_STORAGE_KV,
  SCRIPT_LOCAL_STORAGE_LIMIT,
  SCRIPT_CHAT_METADATA_LIMIT,
} = await import('../../src/scripts/plugins/script-storage-persistence.js');

const makeKv = (initial = {}) => {
  const kv = new Map(Object.entries(initial));
  const saves = [];
  return {
    kv,
    saves,
    loadKv: async name => (kv.has(name) ? JSON.parse(JSON.stringify(kv.get(name))) : {}),
    saveKv: async (name, data) => { saves.push(name); kv.set(name, JSON.parse(JSON.stringify(data))); },
  };
};
const makeChatStore = (scopeId = 'p1') => {
  const refs = new Map();
  return {
    scopeId,
    refs,
    getScriptMetadataRef: sid => refs.get(sid) || null,
    setScriptMetadataRef: (sid, ref) => { refs.set(sid, { ...ref }); return true; },
  };
};

{
  // 脚本 localStorage：从 KV 读回；写入合并后延迟保存；超过上限丢出 QuotaExceededError，不保存
  const store = makeKv({ [SCRIPT_LOCAL_STORAGE_KV]: { version: 1, items: { a: '1', bad: 3 } } });
  const timers = [];
  const storage = createScriptStoragePersistence({
    loadKv: store.loadKv, saveKv: store.saveKv, getChatStore: () => null,
    schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {},
  });
  assert.deepEqual(await storage.getLocalStorageSnapshot(), { a: '1' }, 'non-string values are dropped');
  await storage.applyLocalStorageWrite({ set: { b: '2', c: '3' }, remove: ['a'] });
  assert.deepEqual(await storage.getLocalStorageSnapshot(), { b: '2', c: '3' });
  assert.equal(store.saves.length, 0, 'writes are batched');
  await timers.at(-1)();
  assert.deepEqual(store.kv.get(SCRIPT_LOCAL_STORAGE_KV), { version: 1, items: { b: '2', c: '3' } });
  await storage.applyLocalStorageWrite({ clear: true, set: { d: '4' } });
  assert.deepEqual(await storage.getLocalStorageSnapshot(), { d: '4' }, 'clear runs before the new values');
  await assert.rejects(
    storage.applyLocalStorageWrite({ set: { big: 'x'.repeat(SCRIPT_LOCAL_STORAGE_LIMIT) } }),
    error => error.name === 'QuotaExceededError',
  );
  assert.deepEqual(await storage.getLocalStorageSnapshot(), { d: '4' }, 'a rejected write changes nothing');
  await storage.flushLocalStorage();
  assert.deepEqual(store.kv.get(SCRIPT_LOCAL_STORAGE_KV).items, { d: '4' });
  console.log('ok - script localStorage loads, batches writes and enforces its quota');
}

{
  // chatMetadata：没存过时是空的（键按人设范围区分）；第一次保存建立引用，读回同一份；不存 world_info
  const store = makeKv();
  const chatStore = makeChatStore('persona-a');
  let next = 0;
  const open = () => createScriptStoragePersistence({ loadKv: store.loadKv, saveKv: store.saveKv, getChatStore: () => chatStore, makeId: () => `id${++next}` });
  const storage = open();
  assert.deepEqual(await storage.loadChatMetadata('卡夫卡'), { key: 'unsaved:persona-a:卡夫卡', data: {} });
  const key = await storage.saveChatMetadata('卡夫卡', { engine: { day: 3 }, world_info: 'book' });
  assert.equal(key, 'script_chat_metadata_v1__id1');
  assert.deepEqual(chatStore.refs.get('卡夫卡'), { key, sessionId: '卡夫卡' });
  assert.deepEqual(store.kv.get(key).data, { engine: { day: 3 } }, 'world_info is never stored');
  assert.equal(await storage.saveChatMetadata('卡夫卡', { engine: { day: 4 } }), key, 'later saves reuse the reference');
  const reopened = open();
  assert.deepEqual(await reopened.loadChatMetadata('卡夫卡'), { key, data: { engine: { day: 4 } } });
  console.log('ok - chat metadata is saved per session behind a small reference');
}

{
  // 引用和会话对不上（例如别处复制来的）不读；改名后引用跟着改就读得到；太大不保存
  const store = makeKv({ script_chat_metadata_v1__old: { version: 1, sessionId: 'a', data: { secret: 1 } } });
  const chatStore = makeChatStore();
  chatStore.refs.set('b', { key: 'script_chat_metadata_v1__old', sessionId: 'a' });
  const storage = createScriptStoragePersistence({ loadKv: store.loadKv, saveKv: store.saveKv, getChatStore: () => chatStore });
  assert.deepEqual((await storage.loadChatMetadata('b')).data, {}, 'a copied reference is ignored');
  chatStore.refs.set('b', { key: 'script_chat_metadata_v1__old', sessionId: 'b' });
  assert.deepEqual((await storage.loadChatMetadata('b')).data, { secret: 1 }, 'a renamed session keeps its data');
  chatStore.refs.set('c', { key: 'other_kv', sessionId: 'c' });
  assert.deepEqual((await storage.loadChatMetadata('c')).data, {}, 'references outside the prefix are ignored');
  await assert.rejects(storage.saveChatMetadata('b', { blob: 'x'.repeat(SCRIPT_CHAT_METADATA_LIMIT) }), /过大/);
  await assert.rejects(storage.saveChatMetadata('b', ['not', 'object']), /物件/);
  await assert.rejects(storage.saveChatMetadata('', {}), /会话/);
  console.log('ok - chat metadata ignores foreign references, follows renames and rejects bad payloads');
}

console.log('script-storage-persistence-tests passed');
