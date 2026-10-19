import assert from 'node:assert/strict';

import { createMaidFileLibrary, MAID_FILE_LIBRARY_KV_NAME } from '../../src/scripts/storage/maid-file-library.js';

const DAY = 24 * 60 * 60 * 1000;
const hashOf = ch => ch.repeat(64);

const createFakes = () => {
  const kv = new Map();
  const store = new Map();
  const calls = { put: 0, get: 0, delete: [] };
  let gate = null;
  return {
    kv,
    store,
    calls,
    holdPuts() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = null; release(); };
    },
    loadKv: async name => (kv.has(name) ? JSON.parse(JSON.stringify(kv.get(name))) : null),
    saveKv: async (name, data) => { kv.set(name, JSON.parse(JSON.stringify(data))); },
    blobs: {
      put: async (hash, bytes) => {
        if (gate) await gate;
        calls.put += 1;
        store.set(hash, bytes.slice());
      },
      get: async (hash) => {
        calls.get += 1;
        if (!store.has(hash)) throw new Error('maid_file_not_found');
        return store.get(hash).slice();
      },
      delete: async (hashes) => { calls.delete.push(...hashes); hashes.forEach(hash => store.delete(hash)); return hashes.length; },
      list: async () => Array.from(store.entries()).map(([hash, bytes]) => ({ hash, bytes: bytes.byteLength })),
    },
  };
};
const open = (fakes, options = {}) => createMaidFileLibrary({ loadKv: fakes.loadKv, saveKv: fakes.saveKv, blobs: fakes.blobs, ...options });
const bytesOf = (size, fill = 1) => new Uint8Array(size).fill(fill);

{
  // 重启后仍可继续：索引与原文件存盘，新实例读回元数据，原文件按需载入
  const fakes = createFakes();
  let clock = 1000;
  const first = open(fakes, { now: () => clock });
  first.register('wb', { bytes: bytesOf(5), hash: hashOf('a'), name: '星港.json', mime: 'application/json', inspection: { format: 'worldbook' } });
  first.markSubmitted('wb', { roleCardId: 'p1', sessionId: 's1' });
  await first.whenIdle();
  assert.equal(fakes.calls.put, 1);
  const index = fakes.kv.get(MAID_FILE_LIBRARY_KV_NAME);
  assert.equal(index.entries.length, 1);
  assert.equal('bytes' in index.entries[0], false, 'the index never carries file contents');

  clock += 60 * 1000;
  const second = open(fakes, { now: () => clock });
  assert.deepEqual(await second.hydrate(), { count: 1, bytes: 5, limitBytes: 300 * 1024 * 1024 });
  const meta = second.get('wb');
  assert.deepEqual([meta.name, meta.origin, meta.bytes, meta.submittedContext.roleCardId], ['星港.json', 'upload', null, 'p1']);
  assert.deepEqual(second.listRecent().map(item => item.id), ['wb'], 'a recent sent file is still offered after restart');
  const loaded = await second.ensureLoaded('wb');
  assert.deepEqual(Array.from(loaded.bytes), [1, 1, 1, 1, 1]);
  assert.equal((await second.ensureLoaded('wb')).bytes.byteLength, 5);
  assert.equal(fakes.calls.get, 1, 'loaded bytes stay cached');
  console.log('ok - maid file library keeps files and their context across restarts');
}

{
  // 启动对账：缺原文件的条目删掉、没人引用的原文件删掉、闲置超过 30 天的清掉
  const fakes = createFakes();
  const at = 100 * DAY;
  fakes.store.set(hashOf('a'), bytesOf(3));
  fakes.store.set(hashOf('c'), bytesOf(4));
  fakes.store.set(hashOf('d'), bytesOf(2));
  const entry = (id, hash, lastUsedAt) => ({ id, hash, name: `${id}.txt`, mime: 'text/plain', size: 1, origin: 'upload', registeredAt: lastUsedAt, lastUsedAt, imports: [] });
  await fakes.saveKv(MAID_FILE_LIBRARY_KV_NAME, {
    version: 1,
    entries: [entry('keep', hashOf('a'), at - DAY), entry('lost', hashOf('b'), at - DAY), entry('idle', hashOf('d'), at - 31 * DAY)],
  });
  const library = open(fakes, { now: () => at });
  await library.hydrate();
  await library.whenIdle();
  assert.deepEqual(library.list().map(item => item.id), ['keep']);
  assert.deepEqual(fakes.calls.delete.sort(), [hashOf('c'), hashOf('d')].sort());
  assert.deepEqual(fakes.kv.get(MAID_FILE_LIBRARY_KV_NAME).entries.map(item => item.id), ['keep']);
  console.log('ok - maid file library reconciles its index with stored files and expires idle ones');
}

{
  // 总量超出上限：先清最久没用的；同内容只存一份，最后一个引用删掉才删原文件
  const fakes = createFakes();
  let clock = 1;
  const library = open(fakes, { now: () => (clock += 1), limits: { maxTotalBytes: 10 } });
  library.register('old', { bytes: bytesOf(6), hash: hashOf('a'), name: 'old.txt' });
  library.register('twin', { bytes: bytesOf(6), hash: hashOf('a'), name: 'twin.txt' });
  await library.whenIdle();
  assert.equal(library.usage().bytes, 6, 'the same content is counted and stored once');
  library.remove('old');
  await library.whenIdle();
  assert.equal(fakes.store.has(hashOf('a')), true, 'a file still referenced elsewhere is kept');
  await library.ensureLoaded('twin');
  library.register('new', { bytes: bytesOf(6, 2), hash: hashOf('b'), name: 'new.txt' });
  await library.whenIdle();
  assert.deepEqual(library.list().map(item => item.id), ['new'], 'the least recently used file makes room');
  assert.equal(fakes.store.has(hashOf('a')), false);
  assert.equal(library.usage().bytes, 6);
  console.log('ok - maid file library enforces its space limit and deduplicates content');
}

{
  // 未发送就丢弃：连原文件一起删；内存缓存挤掉的已存盘文件可按需重新载入
  const fakes = createFakes();
  const library = open(fakes, { limits: { cacheBytes: 8 } });
  library.register('draft', { bytes: bytesOf(3), hash: hashOf('a'), name: 'draft.json' });
  await library.whenIdle();
  assert.equal(library.discardUnsubmitted('draft'), true);
  await library.whenIdle();
  assert.equal(fakes.store.has(hashOf('a')), false);

  library.register('one', { bytes: bytesOf(6), hash: hashOf('b'), name: 'one.bin' });
  library.register('two', { bytes: bytesOf(6, 3), hash: hashOf('c'), name: 'two.bin' });
  await library.whenIdle();
  library.register('three', { bytes: bytesOf(6, 4), hash: hashOf('d'), name: 'three.bin' });
  await library.whenIdle();
  assert.equal(library.get('one').bytes, null, 'an evicted original is no longer in memory');
  assert.deepEqual(Array.from((await library.ensureLoaded('one')).bytes), [1, 1, 1, 1, 1, 1], 'but it reloads from disk');
  console.log('ok - maid file library deletes discarded drafts and reloads evicted originals');
}

{
  // 还在排队存盘的文件不会被缓存挤掉（此时缓存是唯一一份）
  const fakes = createFakes();
  const release = fakes.holdPuts();
  const library = open(fakes, { limits: { cacheBytes: 8 } });
  library.register('a', { bytes: bytesOf(6), hash: hashOf('a'), name: 'a.bin' });
  library.register('b', { bytes: bytesOf(6, 2), hash: hashOf('b'), name: 'b.bin' });
  assert.equal(library.get('a').bytes.byteLength, 6);
  release();
  await library.whenIdle();
  assert.deepEqual([fakes.store.has(hashOf('a')), fakes.store.has(hashOf('b'))], [true, true]);
  console.log('ok - maid file library never evicts an original that is still being saved');
}

{
  // 不接存储时为纯内存：放不下即丢弃最早的文件（与原来的附件缓存一致）
  const library = createMaidFileLibrary({ limits: { cacheBytes: 10 } });
  library.register('a', { bytes: bytesOf(6) });
  library.register('b', { bytes: bytesOf(6) });
  assert.deepEqual([library.get('a'), Boolean(library.get('b')?.bytes)], [null, true]);
  assert.equal(library.persistent, false);
  console.log('ok - maid file library falls back to a memory-only cache without storage');
}
