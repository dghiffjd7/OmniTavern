import assert from 'node:assert/strict';

const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: key => memoryStorage.get(String(key)) ?? null,
  setItem: (key, value) => {
    memoryStorage.set(String(key), String(value));
  },
  removeItem: key => {
    memoryStorage.delete(String(key));
  },
};
globalThis.document = { body: { dataset: {} } };
globalThis.window = globalThis;
globalThis.setTimeout = () => 0;

const disk = { index: null, parts: new Map() };
const partKey = args => `${args.sessionDir}/${args.threadDir}/${args.partId}`;
globalThis.__TAURI__ = {
  core: {
    invoke: async (cmd, args = {}) => {
      switch (cmd) {
        case 'load_kv':
          return null;
        case 'save_kv':
          return true;
        case 'chat_store_v2_read_index':
          return disk.index;
        case 'chat_store_v2_write_index':
          disk.index = JSON.parse(JSON.stringify(args.data ?? null));
          return true;
        case 'chat_store_v2_write_part':
          disk.parts.set(partKey(args), JSON.parse(JSON.stringify(args.data ?? [])));
          return true;
        case 'chat_store_v2_read_part':
          return disk.parts.get(partKey(args)) || [];
        default:
          return null;
      }
    },
  },
};

const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');

const drainQueue = store => store._v2._queue;
const readAllIds = async (store, sid) => {
  const entry = store._v2.ensureSession(sid);
  const thread = store._v2.getThread(sid, '');
  const ids = [];
  for (const part of thread.parts) {
    const list = await store._v2.readPart(entry, thread, part.id, { hydrate: false });
    ids.push(...list.map(msg => msg.id));
  }
  return ids;
};
const reopen = async (scopeId, sid) => {
  const store = new ChatStore({ scopeId });
  await store.fullyReady;
  await store.ensureRecentMessagesLoaded(sid);
  return store;
};

// 长对话只载入最近分片时，在较早的消息后插入（例如给旧回复补生图）不得删掉没载入的历史
{
  const scopeId = 'insert-after-long';
  const sid = 'chat:insert-after-long';
  const seed = new ChatStore({ scopeId });
  await seed.fullyReady;
  for (let i = 0; i < 400; i += 1) {
    seed.appendMessage({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }, sid);
  }
  await drainQueue(seed);
  assert.ok(seed._v2.getThreadParts(sid, '').length >= 3, '需要超过载入窗口的分片数');

  const store = await reopen(scopeId, sid);
  assert.ok(store.getMessages(sid).length < 400 && store.hasOlderMessages(sid), '只载入了最近的分片');
  store.insertMessageAfter('m-390', { id: 'img-1', role: 'assistant', content: '生图中', meta: { generatedMedia: { sourceMessageId: 'm-390' } } }, sid);
  store.insertMessageAfter('m-390', { id: 'img-2', role: 'assistant', content: '生图中', meta: { generatedMedia: { sourceMessageId: 'm-390' } } }, sid);
  await drainQueue(store);
  const memoryIds = store.getMessages(sid).map(msg => msg.id);
  assert.deepEqual(memoryIds.slice(memoryIds.indexOf('m-390'), memoryIds.indexOf('m-390') + 4), ['m-390', 'img-1', 'img-2', 'm-391']);

  const after = await reopen(scopeId, sid);
  const ids = await readAllIds(after, sid);
  assert.equal(ids.length, 402, '没载入的较早历史仍在磁盘上');
  assert.equal(ids[0], 'm-0');
  assert.deepEqual(ids.slice(ids.indexOf('m-390'), ids.indexOf('m-390') + 4), ['m-390', 'img-1', 'img-2', 'm-391'], '磁盘顺序与内存一致');
  assert.equal(after._v2.getThread(sid, '').total, 402);
  assert.equal(after._v2.getThreadParts(sid, '').reduce((n, part) => n + part.count, 0), 402, '分片计数同步');
  console.log('ok - insertMessageAfter keeps unloaded history and inserts in memory order on disk');
}

// 插在最后一条后面：照常追加，最后一条摘要更新
{
  const scopeId = 'insert-after-tail';
  const sid = 'chat:insert-after-tail';
  const store = new ChatStore({ scopeId });
  await store.fullyReady;
  for (let i = 0; i < 3; i += 1) store.appendMessage({ id: `t-${i}`, role: 'user', content: `尾${i}` }, sid);
  await drainQueue(store);
  store.insertMessageAfter('t-2', { id: 'img-tail', role: 'assistant', content: '生图中', meta: { generatedMedia: { sourceMessageId: 't-2' } } }, sid);
  await drainQueue(store);
  assert.deepEqual(await readAllIds(store, sid), ['t-0', 't-1', 't-2', 'img-tail']);
  assert.equal(store._v2.getThread(sid, '').lastMessage?.id, 'img-tail');
  console.log('ok - insertMessageAfter on the last message appends and updates the last-message snapshot');
}

console.log('chat-store-insert-after-tests passed');
