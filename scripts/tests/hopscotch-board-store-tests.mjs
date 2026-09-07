import assert from 'node:assert/strict';

import {
  HOPSCOTCH_SESSION_SETTING_KEY,
  createHopscotchBoardStore,
  normalizeHopscotchBoardStoreState,
} from '../../src/scripts/storage/hopscotch-board-store.js';

const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), map: m }; };
const validBoard = { rows: [{ id: 'r1', houses: [{ id: 'body', kind: 'body', fused: ['memory_table'] }] }, { id: 'r2', houses: [{ id: 'rev', kind: 'format_review' }] }] };
const badBoard = { rows: [{ id: 'r1', houses: [{ id: 'x', kind: 'custom_prompt', label: 'x' }] }] };
const sessionSettingsHarness = () => { const map = new Map(); return { map, get: sid => map.get(sid) || null, set: (sid, v) => { map.set(sid, v); return true; } }; };

{
  const s = normalizeHopscotchBoardStoreState({ board: badBoard, updatedAt: 5 });
  assert.equal(s.board, null);
  assert.deepEqual(s.invalidBoard, badBoard, '校验失败保留原始数据');
  assert.equal(s.updatedAt, 5);
  console.log('ok - invalid stored board is preserved, not silently dropped');
}

{
  const kv = new Map();
  const storage = memoryStorage();
  const store = createHopscotchBoardStore({ storage, loadKv: k => kv.get(k) || null, saveKv: (k, v) => { kv.set(k, v); }, scopeId: 'p1', now: () => 100 });
  assert.equal(store.getGlobalBoard(), null);
  const res = await store.setGlobalBoard(validBoard);
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'kv');
  assert.equal(store.getGlobalBoard().source, 'user');
  assert.ok(kv.has(store.key), 'kv 主通道写入');
  assert.ok(storage.map.has(store.key), 'localStorage 镜像');
  const bad = await store.setGlobalBoard(badBoard);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_board');
  assert.ok(bad.errors.length);
  assert.equal(store.getGlobalBoard().rows.length, 2, '无效板不覆盖有效板');
  await store.setGlobalBoard(null);
  assert.equal(store.getGlobalBoard(), null);
  console.log('ok - global board save/validate/clear across kv + localStorage');
}

{
  // scope 隔离：同 sessionId 不同 scope 键不同
  const a = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p1' });
  const b = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p2' });
  assert.notEqual(a.key, b.key);
  // kv 读取失败：不回写空默认，保持本地状态
  const storage = memoryStorage();
  storage.setItem(a.key, JSON.stringify({ board: validBoard, updatedAt: 9 }));
  const store = createHopscotchBoardStore({ storage, scopeId: 'p1', loadKv: async () => { throw new Error('kv down'); }, logger: { debug() {}, warn() {} } });
  await store.hydrate();
  assert.equal(store.isHydrated(), false);
  assert.equal(store.getGlobalBoard()?.rows?.length, 2, 'kv 异常仍保留本地有效板');
  // kv 较新则采用 kv
  const kvNewer = createHopscotchBoardStore({ storage, scopeId: 'p1', loadKv: async () => ({ board: { ...validBoard, name: 'kv' }, updatedAt: 99 }) });
  await kvNewer.hydrate();
  assert.equal(kvNewer.getGlobalBoard().name, 'kv');
  // kv 保存失败不能报成功
  const failing = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p1', saveKv: async () => { throw new Error('quota'); }, logger: { warn() {} } });
  const r = await failing.setGlobalBoard(validBoard);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'kv_save_failed');
  assert.equal(r.localOk, false);
  console.log('ok - scope isolation, kv hydrate failure tolerance, kv save failure surfaced');
}

{
  const h = sessionSettingsHarness();
  h.set('rp:a', { bubbleColor: '#fff' });
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p1', getSessionSettings: h.get, setSessionSettings: h.set, now: () => 7 });
  assert.equal(store.getSessionOverride('rp:a'), null);
  assert.equal(store.setSessionOverride('rp:a', badBoard).ok, false);
  assert.equal(store.setSessionOverride('rp:a', validBoard).ok, true);
  assert.equal(h.get('rp:a').bubbleColor, '#fff', '不破坏既有会话设置');
  assert.equal(h.get('rp:a')[HOPSCOTCH_SESSION_SETTING_KEY].source, 'user');
  assert.equal(store.getSessionOverride('rp:a').rows.length, 2);
  assert.equal(store.getSessionOverride('rp:b'), null, 'B 会话不受影响');
  // 优先级：session > global > derived
  const derived = { rows: [{ id: 'r', houses: [{ id: 'body', kind: 'body' }] }], source: 'builtin-default' };
  assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a', derivedBoard: derived }).source, 'session');
  assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:b', derivedBoard: derived }).source, 'derived');
  await store.setGlobalBoard(validBoard);
  assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:b', derivedBoard: derived }).source, 'global');
  assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a', derivedBoard: derived }).source, 'session', '会话覆盖优先于全局');
  store.setSessionOverride('rp:a', null);
  assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a', derivedBoard: derived }).source, 'global', '清除覆盖后回到全局');
  assert.equal(h.get('rp:a').bubbleColor, '#fff');
  const noSession = createHopscotchBoardStore({ storage: memoryStorage() });
  assert.equal(noSession.setSessionOverride('rp:a', validBoard).ok, false);
  assert.equal(noSession.resolveEffectiveBoard({ sessionId: 'rp:a', derivedBoard: null }).board, null);
  console.log('ok - session override precedence and isolation');
}

{
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p1' });
  assert.equal((await store.importState({ board: badBoard })).reason, 'invalid_board');
  assert.equal((await store.importState({})).reason, 'empty');
  assert.equal((await store.importState({ board: validBoard, updatedAt: 3 })).ok, true);
  assert.equal(store.exportState().board.rows.length, 2);
  console.log('ok - import/export round trip and rejection');
}

{
  const storage = memoryStorage();
  let fail = false;
  const store = createHopscotchBoardStore({
    storage, saveKv: async () => { if (fail) throw new Error('disk full'); },
    logger: { warn() {} },
  });
  await store.setGlobalBoard(validBoard);
  const before = store.getGlobalBoard();
  const cached = storage.getItem(store.key);
  fail = true;
  assert.equal((await store.setGlobalBoard({ ...validBoard, name: 'unsaved' })).ok, false);
  assert.deepEqual(store.getGlobalBoard(), before, '主通道失败不能让未保存板成为有效配置');
  assert.equal(storage.getItem(store.key), cached, '失败保存不能污染重启镜像');
  console.log('ok - failed save preserves last committed board and mirror');
}

console.log('hopscotch-board-store tests passed');
