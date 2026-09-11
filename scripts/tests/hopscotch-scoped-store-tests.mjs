import assert from 'node:assert/strict';
import { createHopscotchBoardStore, createScopedHopscotchBoardStore, HOPSCOTCH_FOLLOW_GLOBAL_SETTING_KEY } from '../../src/scripts/storage/hopscotch-board-store.js';
const values = new Map(), sessions = new Map();
const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
const board = name => ({ name, rows: [{ id: 'body-row', houses: [{ id: 'body', kind: 'body' }] }] });
const options = { storage, scopeId: 'role-a', getSessionSettings: sid => sessions.get(sid) || {}, setSessionSettings: (sid, value) => { sessions.set(sid, value); return true; } };
const legacy = createHopscotchBoardStore(options);
await legacy.setGlobalBoard(board('原角色卡编排'));
const store = createScopedHopscotchBoardStore(options);
await store.hydrate();
assert.equal(store.getGlobalBoard(), null, '旧板不扩散为全局');
assert.equal(store.getPersonaBoard().name, '原角色卡编排');
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a' }).source, 'persona');
await store.setGlobalBoard(board('全局编排'));
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a' }).source, 'persona');
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a', scope: 'global' }).board.name, '全局编排');
store.setSessionOverride('rp:a', board('会话编排'));
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a' }).source, 'persona');
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a', scope: 'persona' }).source, 'persona');
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a', scope: 'persona' }).board.name, '会话编排', '合并后的角色卡视图显示原先实际生效的覆盖');
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:b' }).source, 'persona');
store.setSessionOverride('rp:a', null);
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a' }).source, 'persona');
await store.setPersonaBoard(null);
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:a' }).source, 'global');
await store.setPersonaBoard(board('角色 A'));
await store.setScope('role-b');
assert.equal(store.getPersonaBoard(), null);
assert.equal(store.resolveEffectiveBoard({ sessionId: 'rp:b' }).board.name, '全局编排');
await store.setPersonaBoard(board('角色 B'));
await store.setScope('role-a');
assert.equal(store.getPersonaBoard().name, '角色 A');
await store.setPersonaBoard(null); await store.setGlobalBoard(null);
assert.equal(store.resolveEffectiveBoard({ derivedBoard: board('自动') }).source, 'derived');
console.log('ok - workflow scopes: legacy precedence maps to character, global defaults and role switching');

{
  const data = new Map(), roleSessions = new Map();
  let failSessionSave = false;
  const opts = {
    // 联系人共用分区时，角色的创作会话 ID 仍各自独立。
    scopeId: '', storage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) },
    getSessionSettings: id => roleSessions.get(id) || {},
    setSessionSettings: (id, value) => { if (failSessionSave) return false; roleSessions.set(id, value); return true; },
  };
  const current = createScopedHopscotchBoardStore(opts);
  await current.setGlobalBoard(board('所有角色卡默认'));
  await current.setPersonaBoard(board('旧角色卡编排'));
  current.setSessionOverride('rp:a', board('旧当前创作编排'));
  const before = JSON.stringify([...roleSessions]);
  assert.equal(current.getPersonaBoard('rp:a').name, '旧当前创作编排');
  assert.equal(current.resolveEffectiveBoard({ sessionId: 'rp:a', scope: 'persona' }).board.name, '旧当前创作编排');
  assert.equal(current.resolveEffectiveBoard({ sessionId: 'rp:a', scope: 'global' }).board.name, '所有角色卡默认');
  assert.equal(JSON.stringify([...roleSessions]), before, '仅查看范围不迁移或写入用户数据');

  assert((await current.setPersonaBoard(board('角色 A 新流程'), { sessionId: 'rp:a' })).ok);
  assert.equal(current.resolveEffectiveBoard({ sessionId: 'rp:a' }).board.name, '角色 A 新流程');
  assert.equal(current.getPersonaBoard('rp:b').name, '旧角色卡编排', '同分区的另一张卡保持原流程');
  assert((await current.setPersonaBoard(null, { sessionId: 'rp:a' })).ok);
  assert.equal(current.getPersonaBoard('rp:a'), null);
  assert.equal(current.resolveEffectiveBoard({ sessionId: 'rp:a' }).source, 'global');
  assert.equal(current.getPersonaBoard('rp:b').name, '旧角色卡编排', '跟随默认只影响目标角色');
  assert.equal(roleSessions.get('rp:a')[HOPSCOTCH_FOLLOW_GLOBAL_SETTING_KEY], true);
  await current.setGlobalBoard(board('更新后的所有角色卡默认'));
  const reloaded = createScopedHopscotchBoardStore(opts);
  assert.equal(reloaded.resolveEffectiveBoard({ sessionId: 'rp:a' }).board.name, '更新后的所有角色卡默认', '重开后继续继承全局，旧角色键不再反弹');
  assert.equal(reloaded.resolveEffectiveBoard({ sessionId: 'rp:b' }).board.name, '旧角色卡编排');

  failSessionSave = true;
  const failure = await reloaded.setPersonaBoard(board('未保存的修改'), { sessionId: 'rp:a' });
  assert.equal(failure.ok, false);
  assert.equal(reloaded.resolveEffectiveBoard({ sessionId: 'rp:a' }).board.name, '更新后的所有角色卡默认');
  failSessionSave = false;
  await reloaded.setPersonaBoard(board('角色 A 独立编排'), { sessionId: 'rp:a' });
  assert.equal(reloaded.resolveEffectiveBoard({ sessionId: 'rp:a' }).board.name, '角色 A 独立编排');
  await reloaded.setGlobalBoard(null);
  await reloaded.setPersonaBoard(null, { sessionId: 'rp:a' });
  assert.equal(reloaded.resolveEffectiveBoard({ sessionId: 'rp:a', derivedBoard: board('设置推导') }).source, 'derived');
  console.log('ok - two-scope save/reset, shared storage isolation, persisted inheritance and failed-save recovery');
}
