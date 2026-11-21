import assert from 'node:assert/strict';

import {
  AGENT_TOOL_SAFETY_ALLOW_STORAGE_KEY,
  buildAgentToolSafetyAllowKey,
  createAgentToolSafetyAllowStore,
} from '../../src/scripts/agent/agent-tool-safety-allow-store.js';

const createMemoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    dump: () => Object.fromEntries(data.entries()),
  };
};

{
  const request = {
    toolName: 'worldbook.create',
    kind: 'worldbook.replace',
    operationType: 'replace_existing',
  };
  assert.equal(
    buildAgentToolSafetyAllowKey(request),
    'worldbook.create|worldbook.replace|replace_existing',
  );
  assert.equal(buildAgentToolSafetyAllowKey({ toolName: 'a', operationType: 'b' }), 'a|b');
  assert.equal(buildAgentToolSafetyAllowKey({}), '');
  console.log('ok - agent tool safety allow keys are scoped by tool, kind, and operation');
}

{
  const storage = createMemoryStorage();
  const nowValues = [1000, 2000, 3000];
  const store = createAgentToolSafetyAllowStore({
    storage,
    now: () => nowValues.shift() || 4000,
  });
  const request = {
    toolName: 'worldbook.create',
    kind: 'worldbook.replace',
    operationType: 'replace_existing',
    title: 'Replace worldbook',
    source: 'maid-app-content',
    riskLevel: 'medium',
  };
  assert.equal(store.isAllowed(request), false);
  const rule = store.allowAlways(request);
  assert.equal(rule.key, 'worldbook.create|worldbook.replace|replace_existing');
  assert.equal(store.isAllowed(request), true);
  assert.equal(store.isAllowed({ ...request, kind: 'persona.avatar.replace' }), false);
  assert.deepEqual(store.list().map(entry => entry.key), [rule.key]);

  const reloaded = createAgentToolSafetyAllowStore({ storage });
  assert.equal(reloaded.isAllowed(request), true);
  console.log('ok - agent tool safety allow store persists always-allowed rules');
}

{
  const storage = createMemoryStorage({
    [AGENT_TOOL_SAFETY_ALLOW_STORAGE_KEY]: '{invalid',
  });
  const store = createAgentToolSafetyAllowStore({ storage, now: () => 5000 });
  assert.deepEqual(store.list(), []);
  const request = {
    toolName: 'session.set_wallpaper',
    kind: 'session.wallpaper.replace',
    operationType: 'replace_existing',
  };
  store.allowAlways(request);
  assert.equal(store.isAllowed(request), true);
  console.log('ok - agent tool safety allow store tolerates invalid persisted data');
}

{
  const store = createAgentToolSafetyAllowStore({ storage: null, now: () => 6000 });
  const request = {
    toolName: 'persona.set_avatar',
    kind: 'persona.avatar.replace',
    operationType: 'replace_existing',
  };
  store.allowAlways(request);
  assert.equal(store.isAllowed(request), true);
  store.clear();
  assert.equal(store.isAllowed(request), false);
  console.log('ok - agent tool safety allow store works without browser storage');
}

{
  const store = createAgentToolSafetyAllowStore({ storage: null, now: () => 7000 });
  const keep = {
    toolName: 'persona.set_avatar',
    kind: 'persona.avatar.replace',
    operationType: 'replace_existing',
  };
  const target = {
    toolName: 'worldbook.delete_entries',
    kind: 'worldbook.delete',
    operationType: 'write',
  };
  store.allowAlways(keep);
  const rule = store.allowAlways(target);
  assert.equal(store.revoke(rule.key), true);
  assert.equal(store.isAllowed(target), false);
  assert.equal(store.isAllowed(keep), true, '撤销单条规则不应影响其他规则');
  assert.equal(store.revoke(rule.key), false, '重复撤销应返回 false');
  assert.equal(store.revoke(''), false);
  console.log('ok - agent tool safety allow store revokes single rules');
}

{
  // localStorage 配额满时 kv 通道保证规则持久化与恢复。
  const kvMap = new Map();
  const quotaFullStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => {},
  };
  const store = createAgentToolSafetyAllowStore({
    storage: quotaFullStorage,
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async (key, data) => { kvMap.set(key, data); },
    now: () => 8000,
  });
  await store.hydrate();
  const request = { toolName: 'worldbook.delete_entries', kind: 'worldbook.delete', operationType: 'write' };
  store.allowAlways(request);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(kvMap.has('agent_tool_safety_allow_rules_v1'), '配额满时规则应写入 kv');

  const reloaded = createAgentToolSafetyAllowStore({
    storage: quotaFullStorage,
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async (key, data) => { kvMap.set(key, data); },
    now: () => 9000,
  });
  await reloaded.hydrate();
  assert.equal(reloaded.isAllowed(request), true, 'kv hydrate 应恢复规则');

  reloaded.clear();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(kvMap.get('agent_tool_safety_allow_rules_v1')?.rules, [], 'clear 应同步清空 kv');
  console.log('ok - allow store 配额满时经 kv 持久化、恢复与清空');
}

{
  // 「这个角色卡一律允许」：规则只在该角色卡生效；旧的全局规则照旧对所有角色卡生效（11/20 用户定）
  const storage = createMemoryStorage();
  const store = createAgentToolSafetyAllowStore({ storage, now: () => 10000 });
  const request = { toolName: 'persona.create', kind: 'persona.create', operationType: 'create_persona', title: '新建角色卡' };
  assert.equal(store.isAllowed(request, { roleCardId: 'card-a' }), false);
  const rule = store.allowForRoleCard(request, { roleCardId: 'card-a', roleCardName: '小雪' });
  assert.equal(rule.roleCardId, 'card-a');
  assert.equal(rule.roleCardName, '小雪');
  assert.notEqual(rule.key, buildAgentToolSafetyAllowKey(request), '角色卡规则的键要带上角色卡，才能各卡分开撤销');
  assert.equal(store.isAllowed(request, { roleCardId: 'card-a' }), true);
  assert.equal(store.isAllowed(request, { roleCardId: 'card-b' }), false, '别的角色卡不放行');
  assert.equal(store.isAllowed(request), false, '没有角色卡范围时，角色卡规则不放行（MCP 等全局查询）');
  assert.equal(store.isAllowed({ ...request, operationType: 'other' }, { roleCardId: 'card-a' }), false);
  assert.equal(store.allowForRoleCard(request, { roleCardId: '' }), null, '没有角色卡就不建规则');

  store.allowForRoleCard(request, { roleCardId: 'card-b', roleCardName: '莉莉丝' });
  assert.equal(store.list().length, 2);
  const reloaded = createAgentToolSafetyAllowStore({ storage });
  assert.equal(reloaded.isAllowed(request, { roleCardId: 'card-b' }), true, '角色卡规则会存档');
  assert.equal(reloaded.revoke(rule.key), true);
  assert.equal(reloaded.isAllowed(request, { roleCardId: 'card-a' }), false, '撤销只影响那张卡');
  assert.equal(reloaded.isAllowed(request, { roleCardId: 'card-b' }), true);

  const legacy = { toolName: 'worldbook.create', kind: 'worldbook.replace', operationType: 'replace_existing' };
  reloaded.allowAlways(legacy);
  assert.equal(reloaded.isAllowed(legacy, { roleCardId: 'card-z' }), true, '旧全局规则对任何角色卡都生效');
  assert.equal(reloaded.isAllowed(legacy), true);
  console.log('ok - allow store 角色卡范围规则各卡独立，旧全局规则照旧生效');
}
