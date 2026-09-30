import assert from 'node:assert/strict';

import {
  AGENT_PERMISSION_DECISIONS,
  createAgentPermissionEvaluator,
} from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);
const executeWithTargetApproval = async (tool, args) => {
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
  });
  registry.register(tool);
  const output = await registry.executeTool(tool.name, args, { requestToolConfirmation: () => ({ decision: 'allow' }) });
  return output.result;
};

const createProfileStore = (prefix = 'profile') => {
  const items = new Map();
  let activeId = '';
  let seq = 0;
  return {
    getAll: () => Array.from(items.values()),
    get: id => items.get(id) || null,
    async create(data = {}) {
      seq += 1;
      const item = {
        id: `${prefix}-${seq}`,
        name: data.name,
        description: data.description || '',
        avatar: data.avatar || '',
        source: data.source || null,
        created: seq,
        updated: seq,
      };
      items.set(item.id, item);
      return item;
    },
    async setActive(id) {
      if (!items.has(id)) return false;
      activeId = id;
      return true;
    },
    async delete(id) {
      if (items.size <= 1 || !items.has(id)) return false;
      items.delete(id);
      if (activeId === id) activeId = items.keys().next().value || '';
      return true;
    },
    getActiveId: () => activeId,
    getActive: () => items.get(activeId) || null,
    items,
  };
};

{
  const personaStore = createProfileStore('persona');
  const userStore = createProfileStore('user');
  const switched = [];
  const tools = createAppContentAgentTools({
    personaStore,
    userStore,
    switchPersona: async id => switched.push(['persona', id]),
    switchUserProfile: async id => switched.push(['user', id]),
  });

  const persona = await getTool(tools, 'persona.create').execute({ name: 'Role A', description: 'desc', setActive: true });
  assert.equal(persona.ok, true);
  assert.equal(persona.created, true);
  assert.equal(persona.profile.name, 'Role A');
  assert.equal(personaStore.get(persona.personaId).source.type, 'character_card');

  const user = await getTool(tools, 'user.create').execute({ name: 'User A', setActive: true });
  assert.equal(user.ok, true);
  assert.equal(user.created, true);
  assert.equal(user.profile.name, 'User A');
  assert.deepEqual(switched, [['persona', persona.personaId], ['user', user.userId]]);
  console.log('ok - app content tools create persona and user profiles');
}

{
  const personaStore = createProfileStore('persona');
  const userStore = createProfileStore('user');
  const persona = await personaStore.create({ name: 'Role A' });
  const user = await userStore.create({ name: 'User A' });
  const switched = [];
  const tools = createAppContentAgentTools({
    personaStore,
    userStore,
    switchPersona: async id => {
      switched.push(['persona', id]);
      return id === persona.id;
    },
    switchUserProfile: async id => {
      switched.push(['user', id]);
      return id === user.id;
    },
  });

  const personaResult = await getTool(tools, 'persona.switch').execute({ target: 'Role A' });
  assert.equal(personaResult.ok, true);
  assert.equal(personaResult.switched, true);
  assert.equal(personaResult.personaId, persona.id);

  const userResult = await getTool(tools, 'user.switch').execute({ name: 'User A' });
  assert.equal(userResult.ok, true);
  assert.equal(userResult.switched, true);
  assert.equal(userResult.userId, user.id);
  assert.deepEqual(switched, [['persona', persona.id], ['user', user.id]]);
  console.log('ok - app content tools switch persona and user profiles');
}

{
  const personaStore = createProfileStore('persona');
  const original = await personaStore.create({ name: '原角色' });
  const requested = await personaStore.create({ name: '女仆目标' });
  await personaStore.setActive(original.id);
  const switched = [];
  const tools = createAppContentAgentTools({
    personaStore,
    switchPersona: async id => {
      switched.push(id);
      return personaStore.setActive(id);
    },
    canSwitchPersona: ({ personaId }) => (
      personaId === requested.id
        ? { ok: false, reason: 'user_persona_switch_lease_active', retryAfterMs: 1800 }
        : { ok: true }
    ),
  });

  const result = await getTool(tools, 'persona.switch').execute({ target: requested.id });
  assert.equal(result.ok, false);
  assert.equal(result.switched, false);
  assert.equal(result.reason, 'user_persona_switch_lease_active');
  assert.equal(result.retryAfterMs, 1800);
  assert.deepEqual(switched, []);
  assert.equal(personaStore.getActiveId(), original.id);
  console.log('ok - persona.switch respects a recent manual persona interaction lease');
}

{
  const personaStore = createProfileStore('persona');
  const keep = await personaStore.create({ name: '保留角色', avatar: 'data:image/png;base64,KEEP' });
  const deleteA = await personaStore.create({ name: '测试角色 A', avatar: 'data:image/png;base64,A' });
  const deleteB = await personaStore.create({ name: '测试角色 B', avatar: 'data:image/png;base64,B' });
  await personaStore.setActive(keep.id);
  const deleteCalls = [];
  let notifyCount = 0;
  let confirmation = null;
  const tools = createAppContentAgentTools({
    personaStore,
    deletePersona: async (personaId, options) => {
      deleteCalls.push({ personaId, options });
      const deleted = await personaStore.delete(personaId);
      return deleted
        ? { ok: true, deleted: true, personaId }
        : { ok: false, deleted: false, reason: 'delete_failed', personaId };
    },
    notifyPersonaChanged: async () => {
      notifyCount += 1;
    },
    now: () => 4000,
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const result = await registry.executeTool('persona.delete_many', {
    personas: [keep.id, deleteA.id, deleteB.id, deleteB.id, '不存在角色'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => {
      confirmation = request;
      personaStore.items.delete(deleteB.id);
      return true;
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.succeededCount, 1);
  assert.equal(result.result.skippedCount, 4);
  assert.equal(result.result.failedCount, 0);
  assert.equal(result.result.results.find(item => item.personaId === keep.id).reason, 'last_persona_protected');
  assert.equal(result.result.results.find(item => item.personaId === deleteB.id && item.status === 'skipped').reason, 'already_absent');
  assert.equal(personaStore.get(deleteA.id), null);
  assert.ok(personaStore.get(keep.id));
  assert.equal(notifyCount, 1);
  assert.deepEqual(deleteCalls, [{
    personaId: deleteA.id,
    options: {
      deleteWorld: false,
      deleteRegex: false,
      deleteScripts: false,
      cleanupBindings: false,
      notify: false,
    },
  }]);
  assert.equal(confirmation.kind, 'persona.delete_many');
  assert.equal(confirmation.allowAlways, false);
  assert.equal(confirmation.details.items.find(item => item.id === keep.id).status, 'protected');
  assert.match(confirmation.details.items.find(item => item.id === deleteA.id).avatar, /^data:image/);
  assert.equal(JSON.stringify(result.result).includes('data:image'), false);
  assert.deepEqual(result.result.audit.items, [{ id: deleteA.id, name: '测试角色 A' }]);
  console.log('ok - persona.delete_many protects one persona, rechecks TOCTOU, and preserves bound resources');
}

{
  const personaStore = createProfileStore('persona');
  const keep = await personaStore.create({ name: '保留角色' });
  const edited = await personaStore.create({ name: '确认期编辑' });
  const recreated = await personaStore.create({ name: '确认期重建' });
  await personaStore.setActive(keep.id);
  const deleteCalls = [];
  const tools = createAppContentAgentTools({
    personaStore,
    deletePersona: async personaId => {
      deleteCalls.push(personaId);
      const deleted = await personaStore.delete(personaId);
      return { ok: deleted, deleted, personaId };
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const result = await registry.executeTool('persona.delete_many', {
    personas: [edited.id, recreated.id],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: () => {
      personaStore.items.set(edited.id, {
        ...edited,
        description: '用户在确认期间写入的新内容',
        updated: edited.updated + 1,
      });
      personaStore.items.set(recreated.id, {
        ...recreated,
        name: '同 ID 新实例',
        created: recreated.created + 100,
        updated: recreated.updated + 100,
      });
      return true;
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.succeededCount, 0);
  assert.equal(result.result.skippedCount, 2);
  assert.equal(result.result.results.find(item => item.personaId === edited.id).reason, 'persona_changed_during_confirmation');
  assert.equal(result.result.results.find(item => item.personaId === recreated.id).reason, 'persona_recreated_during_confirmation');
  assert.deepEqual(deleteCalls, []);
  assert.equal(personaStore.get(edited.id).description, '用户在确认期间写入的新内容');
  assert.equal(personaStore.get(recreated.id).name, '同 ID 新实例');
  console.log('ok - persona.delete_many rejects edited and same-id recreated confirmation targets');
}

{
  const builtinId = '手机-格式';
  const saved = new Map([
    [builtinId, { name: builtinId, entries: [] }],
    ['绑定世界书', { name: '绑定世界书', entries: [] }],
    ['确认期消失', { name: '确认期消失', entries: [] }],
  ]);
  const personaStore = createProfileStore('persona');
  await personaStore.create({
    name: '绑定角色',
    source: { worldbookId: '绑定世界书' },
  });
  const deleted = [];
  let confirmation = null;
  const tools = createAppContentAgentTools({
    personaStore,
    listWorlds: async () => Array.from(saved.keys()),
    getWorldInfo: async id => saved.get(id) || null,
    getWorldSessionMap: () => ({
      'chat-a': ['绑定世界书'],
      'chat-b': ['其他世界书', '绑定世界书'],
    }),
    getGlobalWorldId: async () => '绑定世界书',
    deleteWorldInfo: async id => {
      deleted.push(id);
      saved.delete(id);
    },
    now: () => 5000,
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const result = await registry.executeTool('worldbook.delete_many', {
    worldbooks: [builtinId, '绑定世界书', '确认期消失', '绑定世界书', '不存在世界书'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => {
      confirmation = request;
      saved.delete('确认期消失');
      return true;
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.succeededCount, 1);
  assert.equal(result.result.skippedCount, 4);
  assert.equal(result.result.failedCount, 0);
  assert.deepEqual(deleted, ['绑定世界书']);
  assert.ok(saved.has(builtinId));
  assert.equal(confirmation.kind, 'worldbook.delete_many');
  assert.equal(confirmation.allowAlways, false);
  const builtinItem = confirmation.details.items.find(item => item.id === builtinId);
  assert.equal(builtinItem.status, 'protected');
  assert.equal(builtinItem.reason, 'builtin_worldbook_protected');
  const boundItem = confirmation.details.items.find(item => item.id === '绑定世界书' && item.status === 'planned');
  assert.equal(boundItem.meta, '绑定中 ×4');
  assert.equal(boundItem.showAvatar, false);
  assert.equal(result.result.results.find(item => item.worldbookId === '确认期消失').reason, 'already_absent');
  assert.deepEqual(result.result.audit.items, [{ id: '绑定世界书', name: '绑定世界书' }]);
  console.log('ok - worldbook.delete_many protects builtin data, reports binding impact, and rechecks TOCTOU');
}

{
  const saved = new Map([
    ['旧缺失语义世界书', { name: '旧缺失语义世界书', entries: [] }],
  ]);
  const deleted = [];
  const tools = createAppContentAgentTools({
    listWorlds: async () => Array.from(saved.keys()),
    getWorldInfo: async id => saved.get(id) || {},
    worldInfoExists: async id => saved.has(id),
    deleteWorldInfo: async id => {
      deleted.push(id);
      saved.delete(id);
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const result = await registry.executeTool('worldbook.delete_many', {
    worldbooks: ['旧缺失语义世界书'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: () => true,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.ok, true);
  assert.equal(result.result.succeededCount, 1);
  assert.deepEqual(deleted, ['旧缺失语义世界书']);
  console.log('ok - worldbook.delete_many verifies absence through explicit exists without changing legacy get semantics');
}

{
  let exists = true;
  let deleteCalls = 0;
  const tools = createAppContentAgentTools({
    listWorlds: async () => ['确认期原生消失'],
    getWorldInfo: async () => ({}),
    worldInfoExists: async () => exists,
    deleteWorldInfo: async () => {
      deleteCalls += 1;
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const result = await registry.executeTool('worldbook.delete_many', {
    worldbooks: ['确认期原生消失'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: () => {
      exists = false;
      return true;
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.succeededCount, 0);
  assert.equal(result.result.skippedCount, 1);
  assert.equal(result.result.results[0].reason, 'already_absent');
  assert.equal(deleteCalls, 0, '确认期间已消失的目标不得重复执行删除');
  console.log('ok - worldbook.delete_many uses explicit exists for the pre-execution TOCTOU check');
}

{
  const saved = new Map();
  const binds = [];
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => saved.get(id) || {},
    worldInfoExists: async id => saved.has(id),
    listWorlds: async () => Array.from(saved.keys()),
    generateWithSubAgent: async () => ({
      ok: true,
      text: '由测试生成的世界书正文。',
      delegated: true,
      modelUsed: 'test-model',
      subAgentName: 'test-sub-agent',
    }),
    bindWorldToSession: async (...args) => binds.push(args),
  });

  const created = await getTool(tools, 'worldbook.create').execute({
    name: '不存在但旧接口返回空对象',
    mode: 'create_new',
    entries: [{ title: '新条目', content: '必须使用原始名称。' }],
  });
  assert.equal(created.ok, true);
  assert.equal(created.worldbookId, '不存在但旧接口返回空对象');
  assert.equal(created.previousWorldbookId, '');
  assert.equal(saved.has('不存在但旧接口返回空对象 (2)'), false);

  const generated = await getTool(tools, 'worldbook.generate_entries').execute({
    name: '首次生成世界书',
    entries: [{ title: '生成条目', outline: '首次创建，不是追加', length: 80 }],
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.created, true);
  assert.equal(generated.appended, false);

  const read = await getTool(tools, 'worldbook.read').execute({ name: '确实不存在' });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'worldbook_not_found');

  const updated = await getTool(tools, 'worldbook.update_entries').execute({
    name: '确实不存在',
    updates: [{ entryTitle: 'A', content: 'B' }],
  });
  assert.equal(updated.ok, false);
  assert.equal(updated.reason, 'worldbook_not_found');

  const deleted = await getTool(tools, 'worldbook.delete_entries').execute({
    name: '确实不存在',
    dedupeByTitle: true,
  });
  assert.equal(deleted.ok, false);
  assert.equal(deleted.reason, 'worldbook_not_found');

  const bound = await getTool(tools, 'worldbook.bind_session').execute({
    sessionId: 'chat-a',
    worldbookId: '确实不存在',
  });
  assert.equal(bound.ok, false);
  assert.equal(bound.reason, 'worldbook_not_found');
  assert.equal(binds.length, 0);
  console.log('ok - all worldbook tools use explicit exists when legacy reads return empty objects');
}

{
  const personaStore = createProfileStore('persona');
  const persona = await personaStore.create({ name: 'Role A' });
  await personaStore.setActive(persona.id);
  const saved = new Map();
  const bound = [];
  const boundSessions = [];
  let worldBodyReads = 0;
  const sessionWorldIds = new Map([['chat-a', ['Role A World']]]);
  const tools = createAppContentAgentTools({
    personaStore,
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => {
      worldBodyReads += 1;
      return saved.get(id) || null;
    },
    getWorldInfoMetadata: id => saved.has(id)
      ? { name: id, entriesCount: saved.get(id)?.entries?.length ?? null, refs: [] }
      : null,
    listWorlds: async () => Array.from(saved.keys()),
    waitForWorldStoreReady: async () => true,
    getWorldIdsForSession: async sessionId => sessionWorldIds.get(sessionId) || [],
    getGlobalWorldId: async () => 'Global World',
    assignWorldToPersona: async (personaId, worldId, options) => bound.push({ personaId, worldId, options }),
    getRpSessionId: personaId => `rp:${personaId}`,
    bindWorldToSession: async (sessionId, worldIds, options) => {
      const list = Array.isArray(worldIds) ? worldIds : [worldIds].filter(Boolean);
      sessionWorldIds.set(sessionId, list);
      boundSessions.push({ sessionId, worldIds: list, options });
    },
    now: () => 1000,
  });

  const result = await getTool(tools, 'worldbook.create').execute({
    name: 'Role A World',
    personaName: 'Role A',
    bindToPersona: true,
    entries: [
      { title: '温柔大姐姐', content: '超级温柔，和用户是姐弟关系。', keys: ['姐姐'] },
      { title: '傲娇青梅竹马', content: '傲娇大小姐青梅竹马。' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.entryCount, 2);
  assert.equal(saved.get('Role A World').entries[0].comment, '温柔大姐姐');
  assert.equal(saved.get('Role A World').entries[0].constant, true);
  assert.deepEqual(bound, [{ personaId: persona.id, worldId: 'Role A World', options: { enabled: true } }]);

  // This fixture only records assignment requests; its card remains unbound.
  // Appending to the explicitly named shared book needs a real target approval.
  const appended = await executeWithTargetApproval(getTool(tools, 'worldbook.create'), {
    name: 'Role A World',
    entries: [{ title: '新增条目', content: '不会覆盖旧内容。' }],
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.created, false);
  assert.equal(appended.previousEntryCount, 2);
  assert.equal(appended.addedEntryCount, 1);
  assert.equal(appended.entryCount, 3);
  assert.deepEqual(saved.get('Role A World').entries.map(entry => entry.comment), ['温柔大姐姐', '傲娇青梅竹马', '新增条目']);

  const inferred = await getTool(tools, 'worldbook.create').execute({
    entries: [{ title: '当前角色条目', content: '缺省世界书名。' }],
  });
  assert.equal(inferred.ok, true);
  assert.equal(inferred.worldbookId, 'Role A 世界书');
  assert.equal(saved.get('Role A 世界书').entries[0].comment, '当前角色条目');
  assert.deepEqual(bound.at(-1), { personaId: persona.id, worldId: 'Role A 世界书', options: { enabled: true } });

  saved.set('Global World', { name: 'Global World', entries: [] });
  const bodyReadsBeforeList = worldBodyReads;
  const listResult = await getTool(tools, 'worldbook.list').execute({ sessionId: 'chat-a' });
  assert.equal(listResult.ok, true);
  assert.equal(worldBodyReads, bodyReadsBeforeList, 'worldbook.list must use metadata without loading bodies');
  assert.ok(listResult.worldbooks.some(item => item.id === 'Role A World' && item.boundToCurrentSession === true));
  assert.ok(listResult.worldbooks.some(item => item.id === 'Global World' && item.global === true));

  const bindResult = await getTool(tools, 'worldbook.bind_session').execute({
    sessionId: 'chat-b',
    worldbookId: 'Role A World',
  });
  assert.equal(bindResult.ok, true);
  assert.equal(bindResult.bound, true);
  assert.deepEqual(sessionWorldIds.get('chat-b'), ['Role A World']);
  assert.deepEqual(boundSessions.at(-1), { sessionId: 'chat-b', worldIds: ['Role A World'], options: { silent: false } });

  saved.set('Writing Aggregate', { name: 'Writing Aggregate', entries: [] });
  const bindRpResult = await getTool(tools, 'worldbook.bind_rp_session').execute({
    personaName: 'Role A',
    worldbookId: 'Writing Aggregate',
  });
  assert.equal(bindRpResult.ok, true);
  assert.equal(bindRpResult.bound, true);
  assert.equal(bindRpResult.scope, 'rp_only');
  assert.equal(bindRpResult.rpSessionId, `rp:${persona.id}`);
  assert.deepEqual(sessionWorldIds.get(`rp:${persona.id}`), ['Writing Aggregate']);
  assert.deepEqual(sessionWorldIds.get('chat-b'), ['Role A World'], '创作汇总世界书不得写入角色卡私聊绑定');
  assert.deepEqual(boundSessions.at(-1), {
    sessionId: `rp:${persona.id}`,
    worldIds: ['Writing Aggregate'],
    options: { silent: false },
  });

  const readResult = await getTool(tools, 'worldbook.read').execute({ name: 'Role A World' });
  assert.equal(readResult.ok, true);
  assert.equal(readResult.name, 'Role A World');
  assert.equal(readResult.entries.length, 3);
  assert.equal(readResult.entries[0].title, '温柔大姐姐');
  assert.deepEqual(readResult.entries[0].keys, ['姐姐']);
  assert.equal(readResult.entries[0].content, undefined);
  assert.equal(readResult.entries[0].contentPreview, undefined);
  assert.ok(readResult.entries[0].contentLength > 0);
  assert.equal(readResult.contentMode, 'summary');

  const contentRead = await getTool(tools, 'worldbook.read').execute({ name: 'Role A World', entryTitle: '温柔大姐姐' });
  assert.equal(contentRead.ok, true);
  assert.equal(contentRead.contentMode, 'content');
  assert.equal(contentRead.entries.length, 1);
  assert.match(contentRead.entries[0].content, /超级温柔/);

  const updated = await executeWithTargetApproval(getTool(tools, 'worldbook.update_entries'), {
    name: 'Role A World',
    updates: [{
      entryTitle: '温柔大姐姐',
      content: '扩展后的温柔大姐姐设定，仍然和用户是姐弟关系。',
      keys: ['姐姐', '大姐姐'],
    }],
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.updatedEntryCount, 1);
  assert.equal(updated.entryCount, 3);
  assert.deepEqual(saved.get('Role A World').entries.map(entry => entry.comment), ['温柔大姐姐', '傲娇青梅竹马', '新增条目']);
  assert.match(saved.get('Role A World').entries[0].content, /扩展后的温柔大姐姐/);
  assert.deepEqual(saved.get('Role A World').entries[0].key, ['姐姐', '大姐姐']);
  assert.equal(saved.get('Role A World').entries[1].content, '傲娇大小姐青梅竹马。');

  saved.set('Duplicate World', {
    name: 'Duplicate World',
    entries: [
      { id: 'a-1', comment: 'A', content: 'old A' },
      { id: 'a-2', comment: 'A', content: 'latest A' },
      { id: 'b-1', comment: 'B', content: 'old B' },
      { id: 'b-2', comment: 'B', content: 'latest B' },
    ],
  });
  const deduped = await executeWithTargetApproval(getTool(tools, 'worldbook.delete_entries'), {
    name: 'Duplicate World',
    dedupeByTitle: true,
    duplicateTitles: ['A', 'B'],
    keep: 'last',
  });
  assert.equal(deduped.ok, true);
  assert.equal(deduped.deletedEntryCount, 2);
  assert.equal(deduped.entryCount, 2);
  assert.deepEqual(saved.get('Duplicate World').entries.map(entry => entry.id), ['a-2', 'b-2']);

  saved.set('Ambiguous Delete World', {
    name: 'Ambiguous Delete World',
    entries: [
      { id: 'draft-a', comment: '临时草稿', content: '草稿-A' },
      { id: 'draft-b', comment: '临时草稿', content: '草稿-B' },
      { id: 'keeper', comment: '永久条目', content: '必须保留' },
    ],
  });
  const ambiguousDelete = await getTool(tools, 'worldbook.delete_entries').execute({
    name: 'Ambiguous Delete World',
    entries: ['临时草稿'],
    dedupeByTitle: true,
    keep: 'first',
  }, {
    toolSafety: {
      decision: 'allow',
      request: { kind: 'worldbook.delete_entries' },
    },
  });
  assert.equal(ambiguousDelete.ok, false);
  assert.equal(ambiguousDelete.reason, 'ambiguous_delete_mode');
  assert.deepEqual(
    saved.get('Ambiguous Delete World').entries.map(entry => entry.id),
    ['draft-a', 'draft-b', 'keeper'],
    '显式删除 selector 与 dedupe 混用时必须 fail closed，不能把保留项并入删除计划',
  );

  const currentRead = await getTool(tools, 'worldbook.read').execute({ sessionId: 'chat-a', maxEntries: 1 });
  assert.equal(currentRead.ok, true);
  assert.equal(currentRead.id, 'Role A World');
  assert.equal(currentRead.entries.length, 1);
  assert.equal(currentRead.truncated, true);
  console.log('ok - app content tools create bind list and read worldbooks');
}

{
  const sessionWorldIds = new Map([
    ['chat-a', ['Batch World']],
    ['chat-b', ['Existing World']],
  ]);
  const bindCalls = [];
  const tools = createAppContentAgentTools({
    contactsStore: {
      getContact: () => null,
      listContacts: () => [],
    },
    chatStore: {
      listSessions: () => ['chat-a', 'chat-b', 'chat-c', 'chat-broken', 'chat-unverified', 'chat-preview'],
    },
    getWorldInfo: async id => id === 'Batch World' ? { name: id, entries: [] } : null,
    getWorldIdsForSession: async sessionId => sessionWorldIds.get(sessionId) || [],
    getCurrentWorldIds: async () => ['Active Session World'],
    bindWorldToSession: async (sessionId, worldIds) => {
      bindCalls.push(sessionId);
      if (sessionId === 'chat-broken') throw new Error('storage unavailable');
      if (sessionId !== 'chat-unverified') sessionWorldIds.set(sessionId, [...worldIds]);
    },
  });
  const batchTool = getTool(tools, 'worldbook.bind_sessions');
  assert.ok(batchTool, 'batch worldbook binding tool should be registered');

  const preview = await batchTool.execute({
    worldbookId: 'Batch World',
    sessions: ['chat-preview'],
    preview: true,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  assert.equal(preview.plannedCount, 1);
  assert.equal(preview.results[0].status, 'planned');
  assert.equal(bindCalls.length, 0, 'preview must not mutate session bindings');

  const result = await batchTool.execute({
    worldbookId: 'Batch World',
    sessions: ['chat-a', 'chat-b', 'chat-c', 'chat-c', 'chat-broken', 'chat-unverified', 'chat-missing'],
  });
  assert.equal(result.ok, false, 'partial failures must not be reported as full success');
  assert.equal(result.partial, true);
  assert.equal(result.requestedCount, 7);
  assert.equal(result.succeededCount, 2);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.failedCount, 3);
  assert.deepEqual(sessionWorldIds.get('chat-a'), ['Batch World'], 'already-bound sessions stay unchanged');
  assert.deepEqual(sessionWorldIds.get('chat-b'), ['Existing World', 'Batch World']);
  assert.deepEqual(sessionWorldIds.get('chat-c'), ['Batch World']);
  assert.equal(result.results.find(item => item.target === 'chat-a').reason, 'already_bound');
  assert.equal(result.results.filter(item => item.target === 'chat-c').at(-1).reason, 'duplicate_target');
  assert.equal(result.results.find(item => item.target === 'chat-broken').reason, 'bind_failed');
  assert.equal(result.results.find(item => item.target === 'chat-unverified').reason, 'verification_failed');
  assert.equal(result.results.find(item => item.target === 'chat-missing').reason, 'session_not_found');
  assert.deepEqual(result.retry.args.sessions, ['chat-broken', 'chat-unverified', 'chat-missing']);
  assert.equal(result.compensation.kind, 'restore_previous_worldbook_bindings');
  assert.deepEqual(
    result.compensation.sessions.map(item => item.sessionId),
    ['chat-b', 'chat-c', 'chat-unverified'],
    'every attempted mutation should retain its previous bindings for manual compensation',
  );
  console.log('ok - worldbook.bind_sessions previews and reports idempotent partial batch results');
}

{
  const sessionWorldIds = new Map();
  const bindCalls = [];
  const confirmations = [];
  const tools = createAppContentAgentTools({
    getWorldInfo: async id => id === 'Batch World' ? { name: id, entries: [] } : null,
    getWorldIdsForSession: async sessionId => sessionWorldIds.get(sessionId) || [],
    bindWorldToSession: async (sessionId, worldIds) => {
      bindCalls.push(sessionId);
      sessionWorldIds.set(sessionId, [...worldIds]);
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const denied = await registry.executeTool('worldbook.bind_sessions', {
    worldbookId: 'Batch World',
    sessions: ['chat-a', 'chat-b'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => {
      confirmations.push(request);
      return false;
    },
  });
  assert.equal(denied.status, 'skipped');
  assert.equal(denied.result.reason, 'batch_binding_cancelled');
  assert.equal(bindCalls.length, 0);

  const allowed = await registry.executeTool('worldbook.bind_sessions', {
    worldbookId: 'Batch World',
    sessions: ['chat-a', 'chat-b'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => {
      confirmations.push(request);
      return true;
    },
  });
  assert.equal(allowed.status, 'succeeded');
  assert.equal(allowed.result.ok, true);
  assert.equal(allowed.result.verifiedCount, 2);
  assert.equal(confirmations.length, 2, 'one confirmation should cover each batch invocation');
  assert.equal(confirmations[1].kind, 'worldbook.bind_sessions');
  assert.match(confirmations[1].message, /2 个聊天室/);
  assert.deepEqual(bindCalls, ['chat-a', 'chat-b']);
  console.log('ok - worldbook.bind_sessions requires one registry confirmation for the whole batch');
}

{
  const worldbooks = new Map([
    ['Concurrent A', { name: 'Concurrent A', entries: [] }],
    ['Concurrent B', { name: 'Concurrent B', entries: [] }],
  ]);
  const sessionWorldIds = new Map([['chat-a', ['base']]]);
  let snapshotReadCount = 0;
  let releaseSnapshotReads;
  const snapshotReadsReleased = new Promise(resolve => { releaseSnapshotReads = resolve; });
  const readBindingSnapshot = async sessionId => {
    const worldbookIds = [...(sessionWorldIds.get(sessionId) || [])];
    snapshotReadCount += 1;
    if (snapshotReadCount === 2) releaseSnapshotReads();
    if (snapshotReadCount <= 2) await snapshotReadsReleased;
    return { sessionId, scopeId: 'persona-a', worldbookIds };
  };
  const tools = createAppContentAgentTools({
    chatStore: {
      scopeId: 'persona-a',
      state: { sessions: { 'chat-a': { messages: [] } } },
      listSessions: () => ['chat-a'],
    },
    getWorldInfo: async id => worldbooks.get(id) || null,
    getWorldInfoSnapshot: async id => ({
      worldbookId: id,
      exists: worldbooks.has(id),
      data: worldbooks.get(id) || null,
      revision: 1,
      generation: 1,
    }),
    getWorldIdsForSession: async sessionId => (await readBindingSnapshot(sessionId)).worldbookIds,
    getWorldSessionBindingSnapshot: readBindingSnapshot,
    updateWorldSessionBinding: (sessionId, options = {}) => {
      const current = [...(sessionWorldIds.get(sessionId) || [])];
      const next = Array.from(new Set([...current, options.worldbookId]));
      sessionWorldIds.set(sessionId, next);
      return {
        ok: true,
        changed: !current.includes(options.worldbookId),
        added: !current.includes(options.worldbookId),
        previousWorldbookIds: current,
        worldbookIds: next,
      };
    },
    bindWorldToSession: async (sessionId, worldbookIds) => {
      sessionWorldIds.set(sessionId, [...worldbookIds]);
    },
  });
  const bindTool = getTool(tools, 'worldbook.bind_session');
  const [first, second] = await Promise.all([
    bindTool.execute({ sessionId: 'chat-a', worldbookId: 'Concurrent A' }),
    bindTool.execute({ sessionId: 'chat-a', worldbookId: 'Concurrent B' }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sessionWorldIds.get('chat-a').length, 3);
  assert.ok(sessionWorldIds.get('chat-a').includes('base'));
  assert.ok(sessionWorldIds.get('chat-a').includes('Concurrent A'));
  assert.ok(sessionWorldIds.get('chat-a').includes('Concurrent B'));
  console.log('ok - concurrent worldbook append bindings preserve both writes');
}

{
  let currentSessionId = 'chat-a';
  const sessionWorldIds = new Map();
  const tools = createAppContentAgentTools({
    chatStore: {
      scopeId: 'persona-a',
      state: {
        sessions: {
          'chat-a': { messages: [] },
          'chat-b': { messages: [] },
        },
      },
      getCurrent: () => currentSessionId,
      listSessions: () => ['chat-a', 'chat-b'],
    },
    waitForWorldStoreReady: async () => { currentSessionId = 'chat-b'; },
    getWorldInfo: async id => ({ name: id, entries: [] }),
    getWorldInfoSnapshot: async id => ({
      worldbookId: id,
      exists: true,
      data: { name: id, entries: [] },
      revision: 1,
      generation: 1,
    }),
    getWorldSessionBindingSnapshot: sessionId => ({
      sessionId,
      scopeId: 'persona-a',
      worldbookIds: sessionWorldIds.get(sessionId) || [],
    }),
    updateWorldSessionBinding: (sessionId, options = {}) => {
      sessionWorldIds.set(sessionId, [options.worldbookId]);
      return {
        ok: true,
        changed: true,
        added: true,
        previousWorldbookIds: [],
        worldbookIds: [options.worldbookId],
      };
    },
    bindWorldToSession: async (sessionId, worldbookIds) => sessionWorldIds.set(sessionId, [...worldbookIds]),
  });
  const result = await getTool(tools, 'worldbook.bind_session').execute({ worldbookId: 'Pinned World' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'chat-a');
  assert.deepEqual(sessionWorldIds.get('chat-a'), ['Pinned World']);
  assert.equal(sessionWorldIds.has('chat-b'), false);
  console.log('ok - worldbook.bind_session pins the active chat before awaiting world storage');
}

{
  const personaStore = createProfileStore('persona');
  const personaA = await personaStore.create({ name: 'Role A' });
  const personaB = await personaStore.create({ name: 'Role B' });
  await personaStore.setActive(personaA.id);
  const sessionWorldIds = new Map();
  let updateCalls = 0;
  const tools = createAppContentAgentTools({
    personaStore,
    waitForWorldStoreReady: async () => { await personaStore.setActive(personaB.id); },
    getWorldInfo: async id => ({ name: id, entries: [] }),
    getWorldInfoSnapshot: async id => ({
      worldbookId: id,
      exists: true,
      data: { name: id, entries: [] },
      revision: 1,
      generation: 1,
    }),
    getRpSessionId: personaId => `rp:${personaId}`,
    getWorldSessionBindingSnapshot: sessionId => ({
      sessionId,
      scopeId: personaStore.getActive().id,
      worldbookIds: sessionWorldIds.get(sessionId) || [],
    }),
    updateWorldSessionBinding: (sessionId, options = {}) => {
      updateCalls += 1;
      sessionWorldIds.set(sessionId, [options.worldbookId]);
      return {
        ok: true,
        changed: true,
        added: true,
        previousWorldbookIds: [],
        worldbookIds: [options.worldbookId],
      };
    },
    bindWorldToSession: async (sessionId, worldbookIds) => sessionWorldIds.set(sessionId, [...worldbookIds]),
  });
  const result = await getTool(tools, 'worldbook.bind_rp_session').execute({ worldbookId: 'RP World' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target_scope_changed');
  assert.equal(updateCalls, 0);
  assert.equal(sessionWorldIds.has(`rp:${personaA.id}`), false);
  assert.equal(sessionWorldIds.has(`rp:${personaB.id}`), false);
  console.log('ok - worldbook.bind_rp_session rejects an active persona scope switch before commit');
}

{
  let generation = 1;
  let updateCalls = 0;
  const tools = createAppContentAgentTools({
    chatStore: {
      scopeId: 'persona-a',
      state: { sessions: { 'chat-a': { messages: [] } } },
      listSessions: () => ['chat-a'],
    },
    getWorldInfo: async id => ({ name: id, entries: [] }),
    getWorldInfoSnapshot: async id => ({
      worldbookId: id,
      exists: true,
      data: { name: id, entries: [] },
      revision: generation,
      generation,
    }),
    getWorldSessionBindingSnapshot: sessionId => {
      generation = 2;
      return { sessionId, scopeId: 'persona-a', worldbookIds: [] };
    },
    updateWorldSessionBinding: () => {
      updateCalls += 1;
      return { ok: true, changed: true, worldbookIds: ['ABA World'] };
    },
    getWorldIdsForSession: async () => {
      generation = 2;
      return [];
    },
    bindWorldToSession: async () => { updateCalls += 1; },
  });
  const result = await getTool(tools, 'worldbook.bind_session').execute({
    sessionId: 'chat-a',
    worldbookId: 'ABA World',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'worldbook_recreated_during_operation');
  assert.equal(updateCalls, 0);
  console.log('ok - worldbook binding rejects a deleted and recreated worldbook generation');
}

{
  const contacts = new Map([
    ['chat-a', { id: 'chat-a', name: '同名会话', addedAt: 100 }],
  ]);
  const sessionWorldIds = new Map();
  const bindCalls = [];
  const tools = createAppContentAgentTools({
    contactsStore: {
      scopeId: 'persona-a',
      getContact: id => contacts.get(id) || null,
      listContacts: () => Array.from(contacts.values()),
    },
    chatStore: {
      scopeId: 'persona-a',
      state: { sessions: { 'chat-a': { messages: [] }, 'chat-b': { messages: [] } } },
      listSessions: () => ['chat-a', 'chat-b'],
    },
    getWorldInfo: async id => ({ name: id, entries: [] }),
    getWorldInfoSnapshot: async id => ({
      worldbookId: id,
      exists: true,
      data: { name: id, entries: [] },
      revision: 1,
      generation: 1,
    }),
    getWorldSessionBindingSnapshot: sessionId => ({
      sessionId,
      scopeId: 'persona-a',
      worldbookIds: sessionWorldIds.get(sessionId) || [],
    }),
    updateWorldSessionBinding: (sessionId, options = {}) => {
      bindCalls.push(sessionId);
      sessionWorldIds.set(sessionId, [options.worldbookId]);
      return { ok: true, changed: true, worldbookIds: [options.worldbookId] };
    },
    getWorldIdsForSession: async sessionId => sessionWorldIds.get(sessionId) || [],
    bindWorldToSession: async (sessionId, worldbookIds) => {
      bindCalls.push(sessionId);
      sessionWorldIds.set(sessionId, [...worldbookIds]);
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const result = await registry.executeTool('worldbook.bind_sessions', {
    worldbookId: 'Pinned Batch World',
    sessions: ['同名会话'],
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: () => {
      contacts.delete('chat-a');
      contacts.set('chat-b', { id: 'chat-b', name: '同名会话', addedAt: 200 });
      return true;
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.results[0].reason, 'session_target_changed');
  assert.deepEqual(bindCalls, []);
  assert.equal(sessionWorldIds.has('chat-b'), false);
  console.log('ok - confirmed batch worldbook binding never re-resolves a recreated same-name session');
}

{
  const saved = new Map([
    ['Existing World', { name: 'Existing World', entries: [{ id: 'old', comment: '旧条目', content: '保留' }] }],
  ]);
  const confirmations = [];
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => saved.get(id) || null,
    listWorlds: async () => Array.from(saved.keys()),
    confirmDestructiveWrite: async request => {
      confirmations.push(request);
      return false;
    },
    now: () => 2000,
  });
  const result = await getTool(tools, 'worldbook.create').execute({
    name: 'Existing World',
    mode: 'replace',
    entries: [{ title: '新条目', content: '另存' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.fallbackCreated, true);
  assert.equal(result.overwritten, false);
  assert.equal(result.worldbookId, 'Existing World (2)');
  assert.equal(saved.get('Existing World').entries[0].comment, '旧条目');
  assert.equal(saved.get('Existing World (2)').entries[0].comment, '新条目');
  assert.equal(confirmations[0].kind, 'worldbook.replace');
  console.log('ok - app content tools create a new worldbook when replace is not confirmed');
}

{
  const saved = new Map([
    ['Existing World', { name: 'Existing World', entries: [{ id: 'old', comment: '旧条目', content: '会被确认覆盖' }] }],
  ]);
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => saved.get(id) || null,
    listWorlds: async () => Array.from(saved.keys()),
    confirmDestructiveWrite: async () => true,
    now: () => 3000,
  });
  const result = await getTool(tools, 'worldbook.create').execute({
    name: 'Existing World',
    mode: 'replace',
    entries: [{ title: '确认后的新条目', content: '覆盖' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.overwritten, true);
  assert.equal(result.fallbackCreated, false);
  assert.equal(result.worldbookId, 'Existing World');
  assert.deepEqual(saved.get('Existing World').entries.map(entry => entry.comment), ['确认后的新条目']);
  console.log('ok - app content tools replace existing worldbook only after confirmation');
}

{
  const saved = new Map([
    ['Registry World', { name: 'Registry World', entries: [{ id: 'old', comment: '旧条目', content: '保留' }] }],
  ]);
  let confirmations = 0;
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => saved.get(id) || null,
    listWorlds: async () => Array.from(saved.keys()),
    confirmDestructiveWrite: async () => {
      throw new Error('tool-local confirmation should not run after registry safety fallback');
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const result = await registry.executeTool('worldbook.create', {
    name: 'Registry World',
    mode: 'replace',
    entries: [{ title: '新条目', content: '另存' }],
  }, {
    requestToolConfirmation: request => {
      confirmations += 1;
      assert.equal(request.kind, 'worldbook.replace');
      return false;
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.fallbackCreated, true);
  assert.equal(result.result.worldbookId, 'Registry World (2)');
  assert.equal(saved.get('Registry World').entries[0].comment, '旧条目');
  assert.equal(saved.get('Registry World (2)').entries[0].comment, '新条目');
  assert.equal(confirmations, 1);
  console.log('ok - app content tools use registry safety fallback for worldbook replace');
}

{
  const saved = new Map([
    ['Registry Delete World', {
      name: 'Registry Delete World',
      entries: [
        { id: 'keep', comment: '重复条目', content: '保留' },
        { id: 'delete', comment: '重复条目', content: '删除' },
      ],
    }],
  ]);
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => saved.get(id) || null,
    listWorlds: async () => Array.from(saved.keys()),
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const confirmations = [];
  const emptyTarget = await registry.executeTool('worldbook.delete_entries', {}, {
    requestToolConfirmation: request => {
      confirmations.push(request);
      return true;
    },
  });
  assert.equal(emptyTarget.status, 'succeeded');
  assert.equal(emptyTarget.result.ok, false);
  assert.equal(emptyTarget.result.reason, 'missing_worldbook_id');
  assert.equal(confirmations.length, 0, '空参数删除不得回退到当前或全局世界书');

  const missingMode = await registry.executeTool('worldbook.delete_entries', {
    name: 'Registry Delete World',
  }, {
    requestToolConfirmation: request => {
      confirmations.push(request);
      return true;
    },
  });
  assert.equal(missingMode.status, 'succeeded');
  assert.equal(missingMode.result.ok, false);
  assert.equal(missingMode.result.reason, 'missing_delete_mode');
  assert.equal(confirmations.length, 0, '未指定条目或去重模式时必须在确认窗前拒绝');

  const ambiguous = await registry.executeTool('worldbook.delete_entries', {
    name: 'Registry Delete World',
    entries: ['重复条目'],
    dedupeByTitle: true,
    keep: 'first',
  }, {
    requestToolConfirmation: request => {
      confirmations.push(request);
      return true;
    },
  });
  assert.equal(ambiguous.status, 'succeeded');
  assert.equal(ambiguous.result.ok, false);
  assert.equal(ambiguous.result.reason, 'ambiguous_delete_mode');
  assert.equal(confirmations.length, 0, '歧义参数必须在确认窗前拒绝，不能让一次确认掩盖错误删除计划');
  assert.deepEqual(saved.get('Registry Delete World').entries.map(entry => entry.id), ['keep', 'delete']);

  const result = await registry.executeTool('worldbook.delete_entries', {
    name: 'Registry Delete World',
    dedupeByTitle: true,
    keep: 'first',
  }, {
    requestToolConfirmation: request => {
      confirmations.push(request);
      return true;
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.deletedEntryCount, 1);
  assert.deepEqual(saved.get('Registry Delete World').entries.map(entry => entry.id), ['keep']);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].kind, 'worldbook.delete_entries');
  console.log('ok - app content tools require registry safety confirmation before deleting worldbook entries');
}

{
  const contacts = new Map([
    ['sister', { id: 'sister', name: '温柔大姐姐', avatar: 'a' }],
  ]);
  const messages = new Map();
  const opened = [];
  const active = [];
  const refreshed = [];
  const current = { id: 'default' };
  const tools = createAppContentAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      getCurrent: () => current.id,
      switchSession: id => {
        current.id = id;
      },
      appendMessage: (message, sessionId) => {
        const list = messages.get(sessionId) || [];
        list.push(message);
        messages.set(sessionId, list);
      },
    },
    enterChatRoom: async (id, title) => opened.push([id, title]),
    refreshChatAndContacts: options => refreshed.push(options),
    setActiveSession: id => active.push(id),
    getActiveUserName: () => '测试用户',
    getActiveUserAvatar: () => 'u',
    now: () => 1000,
  });

  const result = await getTool(tools, 'chat.send_message').execute({ sessionId: '温柔大姐姐', content: '晚上好' });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.sessionId, 'sister');
  assert.equal(messages.get('sister')[0].role, 'user');
  assert.equal(messages.get('sister')[0].content, '晚上好');
  assert.equal(messages.get('sister')[0].name, '测试用户');
  assert.deepEqual(opened, [['sister', '温柔大姐姐']]);
  assert.deepEqual(active, ['sister']);
  assert.deepEqual(refreshed, [{ immediate: true }]);

  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const aliasResult = await registry.executeTool('chat.send_message', {
    sessionName: '温柔大姐姐',
    message: '妈妈',
  });
  assert.equal(aliasResult.status, 'succeeded');
  assert.equal(aliasResult.result.ok, true);
  assert.equal(aliasResult.result.sent, true);
  assert.equal(aliasResult.result.sessionId, 'sister');
  assert.equal(aliasResult.result.requestTriggered, false);
  assert.equal(messages.get('sister')[1].role, 'user');
  assert.equal(messages.get('sister')[1].content, '妈妈');
  assert.deepEqual(opened.at(-1), ['sister', '温柔大姐姐']);
  console.log('ok - app content tools send chat messages and accept model argument aliases');
}

{
  const contacts = new Map([
    ['elf', { id: 'elf', name: '精灵女王', avatar: 'e' }],
  ]);
  const messages = new Map();
  const opened = [];
  const active = [];
  const sendCalls = [];
  const current = { id: 'default' };
  const chatStore = {
    getCurrent: () => current.id,
    switchSession: id => {
      current.id = id;
    },
    appendMessage: (message, sessionId) => {
      const list = messages.get(sessionId) || [];
      list.push(message);
      messages.set(sessionId, list);
    },
  };
  const tools = createAppContentAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore,
    enterChatRoom: async (id, title) => opened.push([id, title]),
    setActiveSession: id => active.push(id),
    sendChatMessage: async (content, options) => {
      sendCalls.push({ content, options });
      chatStore.appendMessage({ role: 'user', content, source: 'pipeline' }, options.sessionId);
      return true;
    },
  });

  const sendTool = getTool(tools, 'chat.send_message');
  assert.equal(sendTool.timeoutMs, 180000);
  assert.equal(sendTool.timeoutErrorCode, 'generation_failed');
  assert.equal(sendTool.capabilities.network, true);
  assert.equal(sendTool.capabilities.cost, 'variable');
  const result = await sendTool.execute({
    sessionName: '精灵女王',
    message: '妈妈',
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.requestTriggered, true);
  assert.equal(result.sessionId, 'elf');
  assert.deepEqual(sendCalls, [{ content: '妈妈', options: { sessionId: 'elf', source: 'maid', open: true, waitForReply: true } }]);
  assert.deepEqual(messages.get('elf'), [{ role: 'user', content: '妈妈', source: 'pipeline' }]);
  assert.deepEqual(opened, [['elf', '精灵女王']]);
  assert.deepEqual(active, ['elf']);
  console.log('ok - app content tools can route user sends through the reply-triggering send pipeline');
}

{
  const contacts = new Map([['elf', { id: 'elf', name: '精灵女王' }]]);
  const makeTools = sendChatMessage => createAppContentAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: { getCurrent: () => 'elf', switchSession: () => {}, appendMessage: () => {} },
    enterChatRoom: async () => {},
    setActiveSession: () => {},
    sendChatMessage,
  });

  const delivered = await getTool(makeTools(async () => ({
    ok: true,
    sent: true,
    requested: true,
    requestTriggered: true,
    completionOutcome: 'assistant_delivered',
    assistantMessageIds: ['assistant-1', 'assistant-2'],
    assistantMessageRefs: [
      { sessionId: 'elf', messageId: 'assistant-1' },
      { sessionId: 'other-room', messageId: 'assistant-2' },
    ],
  })), 'chat.send_message').execute({
    sessionId: 'elf',
    content: '你好',
  });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.completionOutcome, 'assistant_delivered');
  assert.deepEqual(delivered.assistantMessageIds, ['assistant-1', 'assistant-2']);
  assert.deepEqual(delivered.assistantMessageRefs, [
    { sessionId: 'elf', messageId: 'assistant-1' },
    { sessionId: 'other-room', messageId: 'assistant-2' },
  ]);

  const rejected = await getTool(makeTools(async () => ({
    ok: false,
    sent: true,
    requested: true,
    requestTriggered: true,
    completionOutcome: 'protocol_rejected',
    failureCode: 'protocol_rejected',
    reason: 'protocol_rejected',
    message: '模型回复没有通过聊天协议验收，未提交回复副作用。',
  })), 'chat.send_message').execute({
    sessionId: 'elf',
    content: '你好',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.sent, true, '用户消息已入库与 assistant 终态失败必须分开表达');
  assert.equal(rejected.completionOutcome, 'protocol_rejected');
  assert.equal(rejected.failureCode, 'protocol_rejected');

  const blocked = await getTool(makeTools(async () => ({
    ok: false,
    sent: false,
    requested: false,
    requestTriggered: false,
    completionOutcome: 'blocked_by_config',
    failureCode: 'blocked_by_config',
    reason: 'api-not-configured',
  })), 'chat.send_message').execute({
    sessionId: 'elf',
    content: '你好',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.completionOutcome, 'blocked_by_config');
  assert.equal(blocked.failureCode, 'blocked_by_config');
  console.log('ok - chat send tool preserves assistant delivery, protocol rejection, and config-blocked outcomes');
}

{
  // 用户点停止生成时，send 管线返回的中止标记要透传给女仆观察结果
  const contacts = new Map([['elf', { id: 'elf', name: '精灵女王' }]]);
  const controller = new AbortController();
  let receivedSignal = null;
  const tools = createAppContentAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: { getCurrent: () => 'elf', switchSession: () => {}, appendMessage: () => {} },
    enterChatRoom: async () => {},
    setActiveSession: () => {},
    sendChatMessage: async (_content, options) => {
      receivedSignal = options.signal;
      return {
        ok: false,
        sent: false,
        cancelled: true,
        reason: 'user_aborted',
        message: '用户在生成过程中点击了停止，本次发送/回复被用户中止。',
      };
    },
  });
  const tool = getTool(tools, 'chat.send_message');
  const result = await tool.execute({
    sessionName: '精灵女王',
    message: '你好',
  }, {
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'user_aborted');
  assert.equal(result.failureCode, 'user_aborted');
  assert.equal(result.cancelled, true);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(tool.summarizeResult(result), 'send message cancelled: user_aborted');
  assert.ok(String(result.message).includes('中止'));
  console.log('ok - app content tools propagate abort signals and stable user-aborted results');
}

{
  // 请求已触发后才中止（sent=true）也必须报告为取消，不得误报成功发送
  const contacts = new Map([['elf', { id: 'elf', name: '精灵女王' }]]);
  const tools = createAppContentAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: { getCurrent: () => 'elf', switchSession: () => {}, appendMessage: () => {} },
    enterChatRoom: async () => {},
    setActiveSession: () => {},
    sendChatMessage: async () => ({
      ok: false,
      sent: true,
      requested: true,
      requestTriggered: true,
      cancelled: true,
      completionOutcome: 'request_triggered',
      failureCode: 'user_aborted',
      reason: 'user_aborted',
      message: '用户已中止本次发送或回复生成。',
      assistantMessageIds: [],
      sessionId: 'elf',
    }),
  });
  const tool = getTool(tools, 'chat.send_message');
  const result = await tool.execute({ sessionName: '精灵女王', message: '你好' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true, '触发后中止的 cancelled 标志必须透传');
  assert.equal(result.failureCode, 'user_aborted');
  assert.equal(
    tool.summarizeResult(result),
    'send message cancelled: user_aborted',
    '触发后中止不得被 summarize 误报为 "sent message"',
  );
  console.log('ok - post-trigger aborts surface as cancellation instead of a sent message');
}

{
  const generated = [];
  const contacts = new Map([['elf', { id: 'elf', name: '精灵女王' }]]);
  const tools = createAppContentAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: { getCurrent: () => 'elf' },
    generateChatImage: async payload => {
      generated.push(payload);
      return true;
    },
  });
  const tool = getTool(tools, 'chat.generate_image');
  assert.ok(tool.schema.properties.referenceImages);
  const maidAttachments = [
    { id: 'ref-a', name: 'first.png', kind: 'image', llmUrl: 'data:image/png;base64,QUFB' },
    { id: 'ref-b', name: 'second.png', kind: 'image', llmUrl: 'data:image/png;base64,QkJC' },
  ];
  const result = await tool.execute({
    sessionId: 'elf',
    prompt: '参考构图生成新图',
    referenceImages: [2, 'ref-a', 2],
  }, { maidAttachments });
  assert.equal(result.ok, true);
  assert.equal(result.referenceImageCount, 2);
  assert.deepEqual(generated, [{
    prompt: '参考构图生成新图',
    sessionId: 'elf',
    negativePrompt: '',
    referenceImages: ['data:image/png;base64,QkJC', 'data:image/png;base64,QUFB'],
  }]);

  const missing = await tool.execute({
    sessionId: 'elf',
    prompt: '不要静默退化成文生图',
    referenceImages: ['missing-ref'],
  }, { maidAttachments });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'reference_image_not_found');
  assert.deepEqual(missing.missingReferenceImages, ['missing-ref']);
  assert.equal(generated.length, 1);
  console.log('ok - chat.generate_image resolves referenced maid attachments and rejects missing references');
}

{
  // 模型渠道档：列出 + 模糊匹配切换 + 歧义/不存在/已活跃分支
  const switched = [];
  const profiles = [
    { id: 'p-bp', name: 'byteplus', provider: 'custom', model: 'dola-seedream-5-0-pro' },
    { id: 'p-nai', name: 'NAI', provider: 'novelai', model: 'nai-diffusion-4-5-full' },
    { id: 'p-oai', name: 'oai', provider: 'openai', model: 'gpt-image-2' },
  ];
  const tools = createAppContentAgentTools({
    listModelProfiles: async ({ scope } = {}) => (scope === 'image' ? { activeId: 'p-bp', profiles } : null),
    switchModelProfile: async ({ scope, profileId } = {}) => {
      switched.push({ scope, profileId });
      return { ok: true };
    },
  });

  const listed = await getTool(tools, 'config.list_profiles').execute({ scope: 'image' });
  assert.equal(listed.ok, true);
  assert.equal(listed.activeProfileId, 'p-bp');
  assert.equal(listed.profiles.find(p => p.active)?.name, 'byteplus');

  const badScope = await getTool(tools, 'config.list_profiles').execute({ scope: 'chat' });
  assert.equal(badScope.ok, false);
  assert.equal(badScope.reason, 'unsupported_scope');

  // 大小写不敏感的名称匹配
  const byName = await getTool(tools, 'config.switch_profile').execute({ scope: 'image', profileName: 'nai' });
  assert.equal(byName.ok, true);
  assert.equal(byName.switched, true);
  assert.equal(byName.from.name, 'byteplus');
  assert.equal(byName.to.name, 'NAI');
  assert.deepEqual(switched, [{ scope: 'image', profileId: 'p-nai' }]);

  // 模型名包含匹配
  const byModel = await getTool(tools, 'config.switch_profile').execute({ scope: 'image', profileName: 'gpt-image' });
  assert.equal(byModel.to.name, 'oai');

  // 歧义：'i' 同时命中多个
  const ambiguous = await getTool(tools, 'config.switch_profile').execute({ scope: 'image', profileName: 'a' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'profile_ambiguous');
  assert.ok(ambiguous.candidates.length > 1);

  // 不存在
  const missing = await getTool(tools, 'config.switch_profile').execute({ scope: 'image', profileName: 'midjourney' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'profile_not_found');
  assert.deepEqual(missing.available, ['byteplus', 'NAI', 'oai']);

  // 已是活跃档
  const already = await getTool(tools, 'config.switch_profile').execute({ scope: 'image', profileId: 'p-bp' });
  assert.equal(already.ok, true);
  assert.equal(already.switched, false);
  assert.equal(already.alreadyActive, true);
  console.log('ok - app content tools list and switch model profiles with fuzzy matching');
}

{
  // v4f obs-03-026：取消覆盖创建安全副本时，工具摘要必须点名副本与原书状态
  const tools = createAppContentAgentTools({});
  const create = getTool(tools, 'worldbook.create');
  const copySummary = create.summarizeResult({
    ok: true,
    fallbackCreated: true,
    worldbookId: '冻结观察写入-0728 (3)',
    previousWorldbookId: '冻结观察写入-0728',
    entryCount: 2,
  });
  assert.match(copySummary, /safety copy/);
  assert.match(copySummary, /冻结观察写入-0728 \(3\)/);
  assert.match(copySummary, /untouched/);
  const normalSummary = create.summarizeResult({ ok: true, worldbookId: 'A', entryCount: 3 });
  assert.equal(normalSummary.includes('safety copy'), false);
  console.log('ok - worldbook.create summary surfaces cancel-replace safety copies explicitly');
}

{
  const saved = new Map();
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, data),
    getWorldInfo: async id => saved.get(id) || null,
  });
  const grounding = {
    policy: {
      strictNoInvent: true,
      allowCreativeExtension: false,
      requiresLayering: true,
    },
    targetCheckPerformed: true,
    allowedCanonRefs: ['https://example.com/canon'],
    sources: [{ url: 'https://example.com/canon', targetRelevant: true }],
  };
  const rejected = await getTool(tools, 'worldbook.create').execute({
    name: 'Grounded World',
    entries: [{ title: '未标层', content: '不可写入' }],
  }, {
    maidSourceGrounding: grounding,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'source_layer_required');
  assert.equal(saved.has('Grounded World'), false);

  const accepted = await getTool(tools, 'worldbook.create').execute({
    name: 'Grounded World',
    entries: [{
      title: '正典人物',
      content: '有来源的原作事实。',
      sourceLayer: 'canon',
      sourceRefs: ['https://example.com/canon'],
      sourceNotes: '目标作品资料页',
    }, {
      title: '用户背景',
      content: '用户明确指定的原创背景。',
      sourceLayer: 'user_original',
      sourceRefs: ['user_request'],
    }],
  }, {
    maidSourceGrounding: grounding,
  });
  assert.equal(accepted.ok, true);
  assert.equal(saved.get('Grounded World').entries[0].sourceLayer, 'canon');
  assert.deepEqual(saved.get('Grounded World').entries[0].sourceRefs, ['https://example.com/canon']);
  assert.equal(saved.get('Grounded World').entries[0].provenance.layer, 'canon');
  assert.equal(saved.get('Grounded World').entries[1].sourceLayer, 'user_original');

  const read = await getTool(tools, 'worldbook.read').execute({
    name: 'Grounded World',
    includeContent: true,
  });
  assert.equal(read.entries[0].sourceLayer, 'canon');
  assert.deepEqual(read.entries[0].sourceRefs, ['https://example.com/canon']);
  console.log('ok - worldbook writes enforce strict source layers and preserve provenance for readback');
}

{
  const clone = value => JSON.parse(JSON.stringify(value));
  const saved = new Map([[
    'Concurrent World',
    {
      name: 'Concurrent World',
      entries: [
        { id: 'entry-a', comment: 'A', content: 'initial-A' },
        { id: 'entry-b', comment: 'B', content: 'initial-B' },
      ],
    },
  ]]);
  const tools = createAppContentAgentTools({
    getWorldInfo: async id => clone(saved.get(id) || null),
    saveWorldInfo: async (id, data) => saved.set(id, clone(data)),
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const output = await registry.executeTool('worldbook.update_entries', {
    worldbookId: 'Concurrent World',
    updates: [{ entryId: 'entry-a', content: 'maid-A' }],
  }, {
    requestToolConfirmation: request => {
      assert.equal(request.details.worldbookId, 'Concurrent World');
      const userWrite = clone(saved.get('Concurrent World'));
      userWrite.entries[1].content = 'user-B-during-confirmation';
      saved.set('Concurrent World', userWrite);
      return { decision: 'allow' };
    },
  });

  assert.equal(output.status, 'succeeded');
  assert.equal(output.result.worldbookId, 'Concurrent World');
  assert.deepEqual(
    saved.get('Concurrent World').entries.map(entry => entry.content),
    ['maid-A', 'user-B-during-confirmation'],
    '执行阶段应重新读取确认期间的用户改动，再只修改指定条目',
  );
  console.log('ok - worldbook update re-reads after confirmation and preserves intervening user edits');
}

{
  const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
  const records = new Map([
    ['Pinned A', { name: 'Pinned A', entries: [{ id: 'a', comment: 'A', content: 'initial-A' }] }],
    ['Pinned B', { name: 'Pinned B', entries: [{ id: 'a', comment: 'A', content: 'initial-B' }] }],
  ]);
  const versions = new Map([
    ['Pinned A', { revision: 1, generation: 1 }],
    ['Pinned B', { revision: 1, generation: 1 }],
  ]);
  const snapshot = async id => {
    const data = clone(records.get(id) || null);
    const version = versions.get(id) || { revision: 0, generation: 0 };
    return { worldbookId: id, exists: Boolean(data), data, ...version };
  };
  const save = async (id, data, options = {}) => {
    const current = await snapshot(id);
    if ((options.expectedRevision ?? current.revision) !== current.revision
      || (options.expectedGeneration ?? current.generation) !== current.generation
      || (typeof options.expectedExists === 'boolean' && options.expectedExists !== current.exists)) {
      return { ok: false, reason: 'worldbook_revision_conflict', latestSnapshot: current };
    }
    const next = {
      revision: current.revision + 1,
      generation: current.exists ? current.generation : current.generation + 1,
    };
    records.set(id, clone(data));
    versions.set(id, next);
    return { ok: true, ...next };
  };
  let boundWorldbookId = 'Pinned A';
  const tools = createAppContentAgentTools({
    getWorldInfo: async id => clone(records.get(id) || null),
    getWorldInfoSnapshot: snapshot,
    saveWorldInfo: save,
    worldInfoExists: async id => records.has(id),
    getWorldIdsForSession: async () => [boundWorldbookId],
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const output = await registry.executeTool('worldbook.update_entries', {
    sessionId: 'session-1',
    updates: [{ entryId: 'a', content: 'maid-pinned' }],
  }, {
    requestToolConfirmation: request => {
      assert.equal(request.details.worldbookId, 'Pinned A');
      boundWorldbookId = 'Pinned B';
      return { decision: 'allow' };
    },
  });

  assert.equal(output.result.worldbookId, 'Pinned A');
  assert.equal(records.get('Pinned A').entries[0].content, 'maid-pinned');
  assert.equal(records.get('Pinned B').entries[0].content, 'initial-B');
  console.log('ok - worldbook update pins the confirmed target across a session binding switch');
}

{
  const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
  let data = {
    name: 'CAS World',
    entries: [
      { id: 'a', comment: 'A', content: 'initial-A' },
      { id: 'b', comment: 'B', content: 'initial-B' },
    ],
  };
  let revision = 1;
  let injected = false;
  const getSnapshot = async () => ({
    worldbookId: 'CAS World',
    exists: true,
    data: clone(data),
    revision,
    generation: 1,
  });
  const tools = createAppContentAgentTools({
    getWorldInfo: async () => clone(data),
    getWorldInfoSnapshot: getSnapshot,
    saveWorldInfo: async (_id, next, options = {}) => {
      if (!injected) {
        injected = true;
        data.entries[1].content = 'user-B-after-maid-read';
        revision += 1;
      }
      if (options.expectedRevision !== revision) {
        return { ok: false, reason: 'worldbook_revision_conflict', latestSnapshot: await getSnapshot() };
      }
      data = clone(next);
      revision += 1;
      return { ok: true, revision, generation: 1 };
    },
  });

  const result = await getTool(tools, 'worldbook.update_entries').execute({
    worldbookId: 'CAS World',
    updates: [{ entryId: 'a', content: 'maid-A' }],
  }, {
    toolSafety: { decision: 'allow', request: { kind: 'worldbook.update_entries', details: { worldbookId: 'CAS World' } } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(data.entries.map(entry => entry.content), ['maid-A', 'user-B-after-maid-read']);
  console.log('ok - worldbook CAS retries preserve non-overlapping writes in the final read/save window');
}

{
  const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
  let data = { name: 'ABA World', entries: [{ id: 'a', comment: 'A', content: 'original' }] };
  let revision = 1;
  let generation = 1;
  let deleteCalls = 0;
  const snapshot = async id => ({
    worldbookId: id,
    exists: Boolean(data),
    data: clone(data),
    revision,
    generation,
  });
  const tools = createAppContentAgentTools({
    listWorlds: async () => (data ? ['ABA World'] : []),
    getWorldInfo: async () => clone(data),
    getWorldInfoSnapshot: snapshot,
    worldInfoExists: async () => Boolean(data),
    deleteWorldInfo: async (_id, options = {}) => {
      deleteCalls += 1;
      if (options.expectedRevision !== revision || options.expectedGeneration !== generation) {
        return { ok: false, reason: 'worldbook_revision_conflict', latestSnapshot: await snapshot('ABA World') };
      }
      data = null;
      revision += 1;
      return { ok: true };
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);

  const output = await registry.executeTool('worldbook.delete_many', {
    worldbooks: ['ABA World'],
  }, {
    requestToolConfirmation: () => {
      data = { name: 'ABA World', entries: [{ id: 'a', comment: 'A', content: 'recreated' }] };
      revision += 2;
      generation += 1;
      return { decision: 'allow' };
    },
  });
  assert.equal(output.result.succeededCount, 0);
  assert.equal(output.result.results[0].reason, 'worldbook_changed_since_confirmation');
  assert.equal(data.entries[0].content, 'recreated');
  assert.equal(deleteCalls, 0, 'the commit boundary rejects a recreated target before invoking deletion');
  console.log('ok - worldbook delete confirmation expires after delete/recreate ABA');
}

{
  // Gemini 按缺字段 schema 生成的 {} 不得写成 entry-N 空壳条目
  const saved = new Map([['卡书', { name: '卡书', entries: [{ id: 'e1', comment: '林念初', content: '青梅竹马。' }] }]]);
  const tools = createAppContentAgentTools({
    saveWorldInfo: async (id, data) => saved.set(id, JSON.parse(JSON.stringify(data))),
    getWorldInfo: async id => saved.get(id) || null,
    worldInfoExists: async id => saved.has(id),
    listWorlds: async () => Array.from(saved.keys()),
  });
  const create = getTool(tools, 'worldbook.create');
  const before = JSON.stringify(saved.get('卡书'));

  const empty = await create.execute({ name: '卡书', entries: [{}] });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'incomplete_entries');
  assert.deepEqual(empty.incompleteEntries, [{ index: 0, missing: ['title', 'content'] }]);
  assert.match(empty.message, /title/);
  assert.match(create.summarizeResult(empty), /create worldbook failed: incomplete_entries/);
  const titleOnly = await create.execute({ name: '卡书', entries: [{ title: '沈听雨' }] });
  assert.deepEqual(titleOnly.incompleteEntries, [{ index: 0, missing: ['content'] }]);
  assert.equal(JSON.stringify(saved.get('卡书')), before, 'incomplete entries must not be written');
  const replacePreflight = await create.safety.preflight({ name: '卡书', mode: 'replace', entries: [{}] });
  assert.equal(replacePreflight.destructive, false, 'incomplete entries must not ask to overwrite');

  const added = await create.execute({ name: '卡书', entries: [{ title: '沈听雨', content: '傲娇活泼的青梅竹马。' }] });
  assert.equal(added.ok, true);
  assert.deepEqual(added.addedEntries, [{ id: '沈听雨', title: '沈听雨', contentLength: 10 }]);

  const update = getTool(tools, 'worldbook.update_entries');
  const emptyUpdate = await update.execute({ name: '卡书', createMissing: true, updates: [{}] });
  assert.equal(emptyUpdate.ok, false);
  assert.equal(emptyUpdate.reason, 'invalid_updates');
  assert.equal(emptyUpdate.skippedUpdates[0].reason, 'empty_update');
  const missingContent = await update.execute({ name: '卡书', createMissing: true, updates: [{ title: '新人物' }] });
  assert.equal(missingContent.reason, 'invalid_updates');
  assert.deepEqual(missingContent.skippedUpdates[0], { index: 0, reason: 'incomplete_entry', missing: ['content'] });
  const updatePreflight = await update.safety.preflight({ name: '卡书', createMissing: true, updates: [{ title: '新人物' }] });
  assert.equal(updatePreflight.destructive, false, 'updates that cannot apply must not ask for confirmation');
  assert.equal(saved.get('卡书').entries.length, 2, 'only the complete entry was added');
  console.log('ok - worldbook create/update reject empty or incomplete entries instead of writing entry-N shells');
}

{
  // 未指定世界书时：会话绑定 → 当前角色卡的世界书 → 全局；并标出当前卡的那本
  const saved = new Map([
    ['卡书', { name: '卡书', entries: [] }],
    ['青梅竹马', { name: '青梅竹马', entries: [] }],
    ['全局书', { name: '全局书', entries: [] }],
  ]);
  const personas = new Map([
    ['persona_card', { id: 'persona_card', name: '苏晓彤', source: { worldbookId: '卡书', worldbookEnabled: false } }],
    ['persona_bare', { id: 'persona_bare', name: '测试', source: null }],
  ]);
  let activeId = 'persona_card';
  const bound = [];
  const tools = createAppContentAgentTools({
    personaStore: { getAll: () => [...personas.values()], get: id => personas.get(id) || null, getActive: () => personas.get(activeId) },
    chatStore: { getCurrent: () => `rp:${activeId}` },
    saveWorldInfo: async (id, data) => saved.set(id, JSON.parse(JSON.stringify(data))),
    getWorldInfo: async id => saved.get(id) || null,
    worldInfoExists: async id => saved.has(id),
    listWorlds: async () => Array.from(saved.keys()),
    getWorldIdsForSession: async () => [],
    getGlobalWorldId: async () => '全局书',
    assignWorldToPersona: async (...args) => bound.push(args),
  });

  const read = await getTool(tools, 'worldbook.read').execute({ query: '林念初' });
  assert.equal(read.id, '卡书');
  assert.equal(read.resolvedFrom, 'current_card');
  assert.equal(read.currentCard, true);
  assert.equal(read.ownerHint, undefined);
  const created = await getTool(tools, 'worldbook.create').execute({ entries: [{ title: '沈听雨', content: '傲娇青梅竹马。' }] });
  assert.equal(created.worldbookId, '卡书', 'unnamed create writes into the card worldbook');
  assert.deepEqual(bound, [], 'an already-bound card worldbook is not re-bound (keeps the user toggle)');
  const list = await getTool(tools, 'worldbook.list').execute({});
  assert.deepEqual(list.currentCard, { personaId: 'persona_card', personaName: '苏晓彤', worldbookId: '卡书' });
  assert.deepEqual(list.worldbooks.filter(item => item.currentCard).map(item => item.id), ['卡书']);

  activeId = 'persona_bare';
  const otherCard = await getTool(tools, 'worldbook.read').execute({ name: '卡书' });
  assert.deepEqual(otherCard.ownerCards, ['苏晓彤']);
  assert.match(otherCard.ownerHint, /不是当前角色卡的世界书/);
  const fallback = await getTool(tools, 'worldbook.read').execute({});
  assert.equal(fallback.id, '全局书');
  assert.equal(fallback.resolvedFrom, 'global_fallback');
  assert.equal(fallback.currentCard, false);
  assert.match(fallback.targetHint, /不传 name 调用 worldbook.create/);
  const bareList = await getTool(tools, 'worldbook.list').execute({});
  assert.equal(bareList.currentCard.worldbookId, '');
  assert.match(bareList.currentCardHint, /新建并绑定/);
  const cardCreated = await getTool(tools, 'worldbook.create').execute({ entries: [{ title: '沈听雨', content: '傲娇青梅竹马。' }] });
  assert.equal(cardCreated.worldbookId, '测试 世界书');
  assert.deepEqual(bound.at(-1).slice(0, 2), ['persona_bare', '测试 世界书']);
  assert.match(cardCreated.notice, /为角色卡「测试」新建并绑定了世界书「测试 世界书」/);
  assert.equal(created.notice, undefined, 'appending to an existing card worldbook needs no notice');
  assert.equal(getTool(tools, 'worldbook.create').summarizeResult(cardCreated), 'created new worldbook 测试 世界书 (1 entries); bound it to the character card');
  console.log('ok - worldbook tools resolve and mark the current character card worldbook');
}

// Small in-memory store with the same revision/generation write contract as the bridge.
const createWorldbookSafetyHarness = (worlds, dependencies = {}) => {
  const copy = value => JSON.parse(JSON.stringify(value));
  const records = new Map(worlds.map(world => [world.name, copy(world)]));
  const versions = new Map(worlds.map(world => [world.name, { revision: 1, generation: 1 }]));
  const replace = (id, data, { recreated = false } = {}) => {
    const previous = versions.get(id) || { revision: 0, generation: 0 };
    records.set(id, copy(data));
    versions.set(id, {
      revision: previous.revision + 1,
      generation: previous.generation + (recreated || !previous.generation ? 1 : 0),
    });
  };
  const snapshot = async id => ({
    worldbookId: id,
    exists: records.has(id),
    data: copy(records.get(id) || null),
    ...(versions.get(id) || { revision: 0, generation: 0 }),
  });
  const tools = createAppContentAgentTools({
    getWorldInfo: async id => copy(records.get(id) || null),
    getWorldInfoSnapshot: snapshot,
    worldInfoExists: async id => records.has(id),
    listWorlds: async () => [...records.keys()],
    saveWorldInfo: async (id, data, expected) => {
      const current = await snapshot(id);
      if (current.revision !== expected.expectedRevision || current.generation !== expected.expectedGeneration
        || current.exists !== expected.expectedExists) {
        return { ok: false, reason: 'worldbook_revision_conflict', latestSnapshot: current };
      }
      replace(id, data);
      return { ok: true };
    },
    ...dependencies,
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  return { records, replace, registry, tools };
};

{
  const harness = createWorldbookSafetyHarness([{ name: 'Selectors', entries: [
    { id: 'b', title: 'B', content: 'keep-B', key: ['a'] },
    { id: 'a', title: 'A', content: 'old-A' },
  ] }]);
  const output = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Selectors',
    updates: [
      { entryId: 'a', title: 'B', content: 'new-A' },
      { entryId: 'missing', title: 'B', content: 'must-not-write' },
    ],
  }, { requestToolConfirmation: () => true });
  assert.equal(output.result.ok, true);
  assert.equal(output.result.partial, true);
  assert.equal(output.result.skippedUpdates[0].reason, 'entry_not_found');
  assert.deepEqual(harness.records.get('Selectors').entries.map(entry => entry.content), ['keep-B', 'new-A']);
  const legacy = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Selectors', updates: [{ title: 'B', content: 'legacy-title-selector' }],
  }, { requestToolConfirmation: () => true });
  assert.equal(legacy.result.ok, true, 'title remains a legacy selector when no explicit selector is given');
  assert.equal(harness.records.get('Selectors').entries[0].content, 'legacy-title-selector');
  console.log('ok - explicit entry ids cannot be displaced by a rename, keyword or missing-id fallback');
}

{
  const personaStore = createProfileStore('collision');
  const active = await personaStore.create({ name: 'Active', source: { worldbookId: 'Active World' } });
  const target = await personaStore.create({ name: 'Twin' });
  const owner = await personaStore.create({ name: 'Other', source: { worldbookId: 'Twin 世界书' } });
  await personaStore.setActive(active.id);
  const harness = createWorldbookSafetyHarness([
    { name: 'Active World', entries: [{ id: 'active', content: 'keep-active' }] },
    { name: 'Twin 世界书', entries: [{ id: 'other', content: 'keep-other' }] },
  ], {
    personaStore,
    chatStore: { getCurrent: () => `rp:${active.id}` },
    assignWorldToPersona: (id, worldbookId, options) => {
      const persona = personaStore.get(id);
      persona.source = { ...persona.source, worldbookId, worldbookEnabled: options.enabled };
      return true;
    },
  });
  const output = await harness.registry.executeTool('worldbook.create', {
    sessionId: `rp:${target.id}`, entries: [{ title: 'New', content: 'own-book' }],
  }, { requestToolConfirmation: request => {
    assert.equal(request.allowAlways, false);
    assert.equal(request.details.worldbookTargets[0].bindPersonaId, target.id);
    return true;
  } });
  assert.equal(output.result.ok, true);
  assert.equal(output.result.worldbookId, 'Twin 世界书 (2)');
  assert.equal(personaStore.get(target.id).source.worldbookId, 'Twin 世界书 (2)');
  assert.equal(personaStore.get(active.id).source.worldbookId, 'Active World');
  assert.equal(personaStore.get(owner.id).source.worldbookId, 'Twin 世界书');
  assert.equal(harness.records.get('Twin 世界书').entries[0].content, 'keep-other');
  assert.equal(harness.records.get('Active World').entries[0].content, 'keep-active');
  console.log('ok - unnamed create gives an unbound target card a unique book without appending another card book');
}

{
  for (const change of ['selected-entry', 'same-name-recreation', 'unrelated-entry']) {
    const harness = createWorldbookSafetyHarness([{ name: 'Frozen', entries: [
      { id: 'a', title: 'A', content: 'old-A' },
      { id: 'b', title: 'B', content: 'old-B' },
    ] }]);
    const output = await harness.registry.executeTool('worldbook.update_entries', {
      name: 'Frozen', updates: [{ entryId: 'a', content: 'maid-A' }],
    }, {
      requestToolConfirmation: () => {
        const data = structuredClone(harness.records.get('Frozen'));
        if (change === 'selected-entry') data.entries[0].content = 'user-A';
        if (change === 'unrelated-entry') data.entries[1].content = 'user-B';
        harness.replace('Frozen', data, { recreated: change === 'same-name-recreation' });
        return true;
      },
    });
    if (change === 'unrelated-entry') {
      assert.equal(output.result.ok, true);
      assert.deepEqual(harness.records.get('Frozen').entries.map(entry => entry.content), ['maid-A', 'user-B']);
    } else {
      assert.equal(output.result.reason, 'worldbook_changed_since_confirmation', change);
      assert.equal(harness.records.get('Frozen').entries[0].content, change === 'selected-entry' ? 'user-A' : 'old-A');
    }
  }
  console.log('ok - confirmed updates freeze selected entries and book generation while preserving unrelated edits');
}

{
  for (const confirm of [true, false]) {
    const personaStore = createProfileStore('binding');
    const persona = await personaStore.create({ name: 'Role', source: { worldbookId: 'Original', worldbookEnabled: true } });
    await personaStore.setActive(persona.id);
    let bindingCalls = 0;
    const harness = createWorldbookSafetyHarness([
      { name: 'Original', entries: [{ id: 'old', content: 'old-content' }] },
      { name: 'User Choice', entries: [] },
    ], { personaStore, assignWorldToPersona: () => { bindingCalls += 1; return true; } });
    const output = await harness.registry.executeTool('worldbook.create', {
      mode: 'replace', entries: [{ title: 'New', content: 'saved-content' }],
    }, {
      requestToolConfirmation: () => {
        persona.source = { worldbookId: confirm ? 'User Choice' : 'Original', worldbookEnabled: false };
        return confirm;
      },
    });
    assert.equal(output.result.worldbookSaved, false);
    assert.equal(output.result.reason, confirm ? 'worldbook_target_changed' : 'persona_binding_changed');
    assert.equal(harness.records.get('Original').entries[0].content, 'old-content');
    assert.equal(harness.records.has('Original (2)'), false);
    assert.deepEqual(persona.source, { worldbookId: confirm ? 'User Choice' : 'Original', worldbookEnabled: false });
    assert.equal(bindingCalls, 0);
  }
  const personaStore = createProfileStore('save-failure');
  const persona = await personaStore.create({ name: 'Unbound' });
  await personaStore.setActive(persona.id);
  const harness = createWorldbookSafetyHarness([], { personaStore, assignWorldToPersona: () => false });
  const failedBinding = await harness.registry.executeTool('worldbook.create', {
    entries: [{ title: 'Saved', content: 'keep-this-on-binding-failure' }],
  });
  assert.equal(failedBinding.result.reason, 'persona_binding_save_failed');
  assert.equal(failedBinding.result.worldbookSaved, true);
  assert.equal(harness.records.get('Unbound 世界书').entries.length, 1);
  console.log('ok - create preserves binding/toggle changes during confirmation and reports saved content on binding failure');
}

{
  const harness = createWorldbookSafetyHarness([{ name: 'Blocks', entries: [
    { id: 'multi', title: 'Multi', content: 'stale-flat', promptMode: 'blocks', promptBlocks: [
      { id: 'first', title: 'First', enabled: true, content: 'first-body', role: 'system' },
      { id: 'second', title: 'Second', enabled: true, content: 'second-body', conditions: [{ op: 'eq', value: 1 }] },
    ] },
    { id: 'plain', title: 'Plain', content: 'plain-old' },
  ] }]);
  const read = await harness.registry.executeTool('worldbook.read', { name: 'Blocks', entryId: 'multi', includeContent: true });
  const entry = read.result.entries[0];
  assert.equal(entry.contentSource, 'promptBlocks');
  assert.equal(entry.requiresPromptBlockId, true);
  assert.deepEqual(entry.promptBlocks.map(block => [block.id, block.content]), [['first', 'first-body'], ['second', 'second-body']]);
  let confirmations = 0;
  const rejected = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Blocks', updates: [{ entryId: 'multi', newTitle: 'Must not rename', content: 'ambiguous' }],
  }, { requestToolConfirmation: () => { confirmations += 1; return true; } });
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.skippedUpdates[0].reason, 'prompt_block_required');
  assert.equal(confirmations, 0, 'an ambiguous block edit must not ask for overwrite permission');
  const absentBlock = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Blocks', createMissing: true,
    updates: [{ entryId: 'absent', title: 'New', content: 'body', promptBlockId: 'second' }],
  });
  assert.equal(absentBlock.result.skippedUpdates[0].reason, 'prompt_block_not_found');
  assert.equal(harness.records.get('Blocks').entries.length, 2, 'an explicit block target must not become a flat new entry');
  const mixed = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Blocks', updates: [
      { entryId: 'multi', content: 'ambiguous' },
      { entryId: 'plain', content: 'plain-new' },
    ],
  }, { requestToolConfirmation: () => true });
  assert.equal(mixed.result.partial, true);
  assert.equal(mixed.result.skippedUpdates[0].reason, 'prompt_block_required');
  assert.equal(harness.records.get('Blocks').entries[0].title, 'Multi');
  assert.equal(harness.records.get('Blocks').entries[1].content, 'plain-new');
  const updated = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Blocks', updates: [{ entryId: 'multi', promptBlockId: entry.promptBlocks[1].id, content: 'second-new' }],
  }, { requestToolConfirmation: () => true });
  assert.equal(updated.result.ok, true);
  const stored = harness.records.get('Blocks').entries[0];
  assert.equal(stored.promptBlocks[0].content, 'first-body');
  assert.equal(stored.promptBlocks[1].content, 'second-new');
  assert.deepEqual(stored.promptBlocks[1].conditions, [{ op: 'eq', value: 1 }]);
  assert.equal(stored.content, 'first-body', 'flat text mirrors the first block, not the combined body');
  const cleared = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Blocks', updates: [{ entryId: 'plain', content: '' }],
  }, { requestToolConfirmation: () => true });
  assert.equal(cleared.result.ok, true);
  const renamed = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Blocks', updates: [{ entryId: 'plain', newTitle: 'Empty body', keys: ['empty'] }],
  }, { requestToolConfirmation: () => true });
  assert.equal(renamed.result.ok, true);
  assert.equal(harness.records.get('Blocks').entries[1].content, '', 'metadata changes must not refill a deliberately cleared body');
  console.log('ok - registry read exposes block ids and only explicitly selected prompt blocks are written');
}

// Query regression: locate content that only exists in a later prompt block.
{
  const harness = createWorldbookSafetyHarness([{ name: 'Block Query', entries: [{
    id: 'multi', title: 'Scene', content: 'first-body', promptMode: 'blocks', promptBlocks: [
      { id: 'first', content: 'first-body', enabled: true },
      { id: 'second', content: 'second-only-needle', enabled: false },
    ],
  }] }]);
  const read = await harness.registry.executeTool('worldbook.read', {
    name: 'Block Query', query: 'second-only-needle', includeContent: true,
  });
  assert.equal(read.result.entries.length, 1);
  assert.equal(read.result.entries[0].id, 'multi');
  const block = read.result.entries[0].promptBlocks.find(item => item.content === 'second-only-needle');
  assert.equal(block.id, 'second');
  const updated = await harness.registry.executeTool('worldbook.update_entries', {
    name: 'Block Query', updates: [{ query: 'second-only-needle', promptBlockId: block.id, content: 'second-updated' }],
  }, { requestToolConfirmation: () => true });
  assert.equal(updated.result.ok, true);
  const stored = harness.records.get('Block Query').entries[0];
  assert.equal(stored.promptBlocks[0].content, 'first-body');
  assert.equal(stored.promptBlocks[1].content, 'second-updated');
  assert.equal(stored.promptBlocks[1].enabled, false);
  assert.equal(stored.content, 'first-body');
  console.log('ok - query finds a later prompt block and edits only its explicitly selected id');
}

// Target regression: an explicit missing card must never fall back to the active card.
{
  const active = { id: 'active', name: 'Active', created: 1, source: { worldbookId: 'Active World' } };
  const target = { id: 'target', name: 'Target', created: 2, source: { worldbookId: 'Target World' } };
  const personas = new Map([[active.id, active], [target.id, target]]);
  let writes = 0;
  const harness = createWorldbookSafetyHarness([
    { name: 'Active World', entries: [{ id: 'a', content: 'keep-active' }] },
    { name: 'Target World', entries: [{ id: 't', content: 'keep-target' }] },
  ], {
    personaStore: { get: id => personas.get(id), getAll: () => [...personas.values()], getActive: () => active },
    chatStore: { getCurrent: () => 'rp:active' },
    saveWorldInfo: () => { writes += 1; return { ok: true }; },
  });
  for (const args of [{ sessionId: 'rp:missing' }, { personaId: 'missing' }, { personaName: 'Missing Name' }]) {
    const output = await harness.registry.executeTool('worldbook.create', {
      ...args, entries: [{ title: 'New', content: 'must-not-write' }],
    });
    assert.equal(output.result.reason, 'persona_not_found');
    assert.equal(output.result.worldbookSaved, false);
    assert.equal(writes, 0, 'an invalid explicit card must not write a generic or active-card book');
  }
  for (const confirm of [true, false]) {
    personas.set(target.id, target);
    const output = await harness.registry.executeTool('worldbook.create', {
      sessionId: 'rp:target', mode: 'replace', entries: [{ title: 'New', content: 'must-not-write' }],
    }, { requestToolConfirmation: () => { personas.delete(target.id); return confirm; } });
    assert.equal(output.result.reason, confirm ? 'worldbook_target_changed' : 'worldbook_target_confirmation_cancelled');
    assert.equal(output.result.worldbookSaved, false);
    assert.equal(writes, 0, 'a deleted frozen card must not write its book or a fallback copy');
  }
  assert.equal(harness.records.get('Active World').entries[0].content, 'keep-active');
  assert.equal(harness.records.get('Target World').entries[0].content, 'keep-target');
  const ordinary = await harness.registry.executeTool('worldbook.create', {
    sessionId: 'chat:ordinary', entries: [{ title: 'Normal', content: 'ordinary-session' }],
  });
  assert.equal(ordinary.result.ok, true);
  assert.equal(ordinary.result.worldbookId, 'Active World');
  assert.equal(writes, 1, 'a non-RP session still uses the active card');
  console.log('ok - missing or deleted create persona targets fail without writing another card worldbook');
}
