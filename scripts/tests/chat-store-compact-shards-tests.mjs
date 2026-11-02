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

const disk = { index: null, parts: new Map(), failIndexWrite: false };
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
          if (disk.failIndexWrite) throw new Error('disk full');
          disk.index = JSON.parse(JSON.stringify(args.data ?? null));
          return true;
        case 'chat_store_v2_write_part':
          disk.parts.set(partKey(args), JSON.parse(JSON.stringify(args.data ?? [])));
          return true;
        case 'chat_store_v2_read_part':
          return disk.parts.get(partKey(args)) || [];
        case 'chat_store_v2_delete_part':
          disk.parts.delete(partKey(args));
          return true;
        default:
          return null;
      }
    },
  },
};

const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');

const drainQueue = store => store._v2._queue;
const readAll = async (store, sid) => {
  const entry = store._v2.ensureSession(sid);
  const thread = store._v2.getThread(sid, '');
  const out = [];
  for (const part of thread.parts) out.push(...await store._v2.readPart(entry, thread, part.id, { hydrate: false }));
  return out;
};
// 400 条、3 个分片；删掉前两个分片的大部分消息，留下 20 + 20 + 80 条
const seedFragmented = async (scopeId, sid) => {
  disk.index = null;
  disk.parts.clear();
  const seed = new ChatStore({ scopeId });
  await seed.fullyReady;
  for (let i = 0; i < 400; i += 1) {
    seed.appendMessage({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }, sid);
  }
  await drainQueue(seed);
  seed._v2.enqueue(async () => {
    for (let i = 0; i < 300; i += 1) {
      if (i % 160 < 140) await seed._v2.deleteMessage(sid, '', `m-${i}`);
    }
  });
  await drainQueue(seed);
  assert.deepEqual(seed._v2.getThreadParts(sid, '').map(part => part.count), [20, 20, 80]);
  return (await readAll(seed, sid)).map(msg => msg.id);
};

// 没载入内存的线程：零碎分片合并成一个，消息与顺序不变，旧分片文件删掉
{
  const scopeId = 'compact-a';
  const sid = 'chat:compact-a';
  const before = await seedFragmented(scopeId, sid);
  const store = new ChatStore({ scopeId });
  await store.fullyReady;
  const oldPartIds = store._v2.getThreadParts(sid, '').map(part => part.id);
  const summary = await store.compactShards();
  assert.deepEqual([summary.compacted, summary.partsBefore, summary.partsAfter, summary.failed], [1, 3, 1, 0]);
  const after = new ChatStore({ scopeId });
  await after.fullyReady;
  assert.deepEqual((await readAll(after, sid)).map(msg => msg.id), before, '消息与顺序不变');
  assert.equal(after._v2.getThread(sid, '').total, 120);
  assert.deepEqual(after._v2.getThreadParts(sid, '').map(part => part.count), [120]);
  assert.equal(after._v2.getThread(sid, '').lastMessage?.id, 'm-399');
  assert.ok(oldPartIds.every(id => ![...disk.parts.keys()].some(key => key.endsWith(`/${id}`))), '旧分片文件已删除');
  const again = await after.compactShards();
  assert.deepEqual([again.compacted, again.countsFixed], [0, 0], '整理过的不再重写');
  console.log('ok - compactShards merges fragmented parts without changing messages');
}

// 已载入内存的线程：按最早载入的分片分界，载入更早消息时接得上；整理期间排队的编辑带着旧分片编号也不丢
{
  const scopeId = 'compact-b';
  const sid = 'chat:compact-b';
  const before = await seedFragmented(scopeId, sid);
  const store = new ChatStore({ scopeId });
  await store.fullyReady;
  await store.ensureRecentMessagesLoaded(sid);
  assert.equal(store.getMessages(sid).length, 100);
  const pending = store.compactShards();
  store.updateMessage('m-390', { content: '整理时改的' }, sid);
  const summary = await pending;
  await drainQueue(store);
  assert.deepEqual([summary.compacted, summary.partsBefore, summary.partsAfter], [1, 3, 2], '已载入与未载入的分片不跨界合并');
  assert.equal(store.hasOlderMessages(sid), true);
  await store.loadOlderMessages(sid);
  assert.deepEqual(store.getMessages(sid).map(msg => msg.id), before, '载入更早消息后与整理前一致');
  assert.equal(store.hasOlderMessages(sid), false);
  const onDisk = await readAll(store, sid);
  assert.equal(onDisk.find(msg => msg.id === 'm-390')?.content, '整理时改的', '带旧分片编号的编辑没有丢');
  store.deleteMessage('m-395', sid);
  await drainQueue(store);
  assert.equal((await readAll(store, sid)).some(msg => msg.id === 'm-395'), false, '整理后删除照常落盘');
  console.log('ok - compactShards keeps loaded threads consistent and queued edits land');
}

// 分片读不到（文件丢了但索引还有计数）或写索引失败：不动这条线程
{
  const scopeId = 'compact-c';
  const sid = 'chat:compact-c';
  await seedFragmented(scopeId, sid);
  const store = new ChatStore({ scopeId });
  await store.fullyReady;
  const parts = store._v2.getThreadParts(sid, '').map(part => part.id);
  const missingKey = [...disk.parts.keys()].find(key => key.endsWith(`/${parts[0]}`));
  const saved = disk.parts.get(missingKey);
  disk.parts.delete(missingKey);
  const skipped = await store.compactShards();
  assert.deepEqual([skipped.skipped, skipped.compacted], [1, 0]);
  assert.deepEqual(store._v2.getThreadParts(sid, '').map(part => part.id), parts, '索引不变');
  disk.parts.set(missingKey, saved);

  disk.failIndexWrite = true;
  const failed = await store.compactShards();
  disk.failIndexWrite = false;
  assert.deepEqual([failed.failed, failed.compacted], [1, 0]);
  assert.deepEqual(store._v2.getThreadParts(sid, '').map(part => part.id), parts, '写索引失败时回到旧分片');
  assert.ok(parts.every(id => [...disk.parts.keys()].some(key => key.endsWith(`/${id}`))), '旧分片文件都还在');
  assert.equal((await readAll(store, sid)).length, 120);
  console.log('ok - compactShards leaves a thread untouched when a part is unreadable or the index write fails');
}

console.log('chat-store-compact-shards-tests passed');
