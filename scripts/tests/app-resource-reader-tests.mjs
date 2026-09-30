import assert from 'node:assert/strict';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';

import {
  createAppResourceReader,
  normalizeAppResourceName,
  sanitizeAppResourceValue,
} from '../../src/scripts/agent/app-resource-reader.js';

{
  const contacts = [
    { id: 'sid-alpha', name: '甲', description: '原始简介' },
    { id: 'sid-beta', name: 'sid-alpha', description: '显示名恰好等于另一真实ID' },
    { id: 'sid-display', name: 'missing-id', description: '显示名不是会话ID' },
  ];
  const readResource = createAppResourceReader({
    chatStore: {
      listSessions: () => contacts.map(contact => contact.id),
      getCurrent: () => 'sid-alpha',
      getMessages: id => [{ id: `${id}-message`, role: 'user', content: '已保存消息' }],
      getSessionSettings: () => ({}),
    },
    contactsStore: { getContact: id => contacts.find(contact => contact.id === id) },
  });
  const registry = createAgentToolRegistry();
  registry.registerMany(createAppNavigationAgentTools({ readResource }));
  assert.equal(registry.get('app.read_resource').schema.properties.sessionId.type, 'string');
  const call = async args => {
    const result = await registry.executeTool('app.read_resource', {
      resource: 'session', include: ['description'], ...args,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result.ok, true);
    return result.result;
  };
  const exact = await call({ sessionId: 'sid-alpha' });
  assert.deepEqual(exact.sessions.map(session => session.id), ['sid-alpha'],
    'schema-accepted sessionId must select only its real ID, not all records or a matching display name');
  assert.equal(exact.sessions[0].description, '原始简介');
  assert.equal(exact.sessions[0].messageCount, 1);
  const cases = [
    [{ sessionId: 'missing-id' }, []],
    [{ sessionId: 'missing-id', name: '甲', id: 'sid-alpha' }, []],
    [{ sessionId: 'sid-alpha', sessionName: 'missing-id', name: 'missing-id', id: 'sid-beta' }, ['sid-alpha']],
    [{ id: 'sid-beta' }, ['sid-beta']],
    [{ query: '甲' }, ['sid-alpha']],
    [{ name: 'missing-id', id: 'sid-alpha' }, ['sid-display']],
    [{}, ['sid-alpha', 'sid-beta', 'sid-display']],
  ];
  for (const [args, expectedIds] of cases) {
    assert.deepEqual((await call(args)).sessions.map(session => session.id), expectedIds, JSON.stringify(args));
  }
  console.log('ok - registered session resource honors explicit sessionId without name/list fallback and preserves legacy selectors');
}

const makeDeps = () => {
  const messagesBySession = {
    s1: [
      { id: 'm1', role: 'user', content: '你好', time: '20:00' },
      {
        id: 'm2',
        role: 'assistant',
        content: '界面显示回复',
        rawOriginal: '供应商完整回复',
        reasoning: '内部推理',
        displayText: '渲染后的回复',
        swipes: [{ content: '备用回复' }],
        time: '20:01',
      },
    ],
    s2: [{ id: 'm3', role: 'user', content: 'hi' }],
  };
  const chatStore = {
    getCurrent: () => 's1',
    getMessages: sid => messagesBySession[sid] || [],
    getSummaries: sid => [{ sessionId: sid, summary: '压缩摘要', apiKey: 'secret' }],
    getCompactedSummary: () => '长期摘要',
    getSessionSettings: sid => ({ sessionId: sid, temperature: 0.7, token: 'secret' }),
    listSessions: () => ['s1', 's2'],
    listVariables: sid => ({ mood: 'calm', sid }),
    listInitialVariables: () => ({ hp: 10 }),
    listVariableSchemas: () => ({ mood: { type: 'string' } }),
    listVariableRules: () => [{ path: 'mood', operation: 'set' }],
    listGlobalVariables: () => ({ app: 'phone' }),
    getStageSchema: () => ({ stage: 'opening' }),
  };
  const worlds = {
    w1: {
      name: '精灵世界书',
      entries: [
        {
          id: 'e1',
          comment: '精灵女王',
          key: ['精灵'],
          keysecondary: ['森林'],
          position: 4,
          order: 10,
          depth: 2,
          constant: true,
          content: '超级温柔特别会照顾人的大姐姐。',
        },
      ],
    },
    global: { name: '全局世界书', entries: [] },
  };
  const appBridge = {
    waitForWorldStoreReady: async () => true,
    getWorldIdsForSession: () => ['w1'],
    getCurrentWorldIds: async () => [{ id: 'w1' }],
    getCurrentWorldId: () => '',
    getGlobalWorldId: () => 'global',
    listWorlds: async () => ['w1', 'global'],
    getWorldInfo: async id => worlds[id],
    getWorldGlobalSettings: () => ({ scanDepth: 5, apiKey: 'secret' }),
    waitForRegexStoreReady: () => true,
    getRegexContext: ({ sessionId } = {}) => ({ sessionId }),
    getRegexStore: () => ({
      computeActiveRules: () => [
        {
          id: 'cleanup-think',
          scriptName: '清理思考块',
          findRegex: '/<think>[\\s\\S]*?<\\/think>/g',
          replaceString: '',
          placement: [2],
        },
        {
          id: 'status-format',
          scriptName: '状态块格式转换',
          findRegex: '/^<status>([\\s\\S]*?)<\\/status>$/g',
          replaceString: '状态块：$1',
          placement: [2],
        },
      ],
    }),
    getRegexSession: sid => ({ sessionId: sid, enabledSetIds: ['r1'] }),
    listRegexLocalSets: () => [
      { id: 'r1', name: '输出清理', scripts: [{ findRegex: '<think>.*?</think>', replaceString: '' }] },
      { id: 'r2', name: '显示增强', scripts: [] },
    ],
    getConfig: () => ({ provider: 'fallback', model: 'fallback-model', apiKey: 'secret' }),
    config: {
      getActiveProfileId: () => 'profile-1',
    },
  };
  return {
    appBridge,
    chatStore,
    contactsStore: {
      getContact: id => ({ id, name: id === 's1' ? '精灵女王' : '暗夜女王', isGroup: false }),
    },
    personaStore: {
      getActive: () => ({ id: 'p1', name: '精灵女王' }),
      getAll: () => [
        {
          id: 'p1',
          name: '精灵女王',
          avatar: `data:image/png;base64,${'A'.repeat(20_000)}`,
          description: '温柔而坚定的精灵女王',
          source: {
            worldbookId: 'w1',
            worldbookEnabled: true,
            systemPresetId: 'sysprompt-elf',
            regexSetId: 'r1',
            originalCardStored: true,
          },
          originalCard: { data: { character_book: { entries: [{ content: '不应进入轻量投影' }] } } },
        },
        {
          id: 'p2',
          name: '暗夜女王',
          avatar: `data:image/png;base64,${'B'.repeat(20_000)}`,
          description: '统治暗夜王国',
          source: { worldbookEnabled: false },
        },
      ],
    },
    userStore: {
      getActive: () => ({ id: 'u1', name: '测试用户' }),
      getAll: () => [
        {
          id: 'u1',
          name: '测试用户',
          avatar: `data:image/png;base64,${'C'.repeat(20_000)}`,
          description: '当前用户档案',
        },
        {
          id: 'u2',
          name: '备用用户',
          avatar: '',
          description: '备用档案',
        },
      ],
    },
    memoryTemplateStore: {
      getTemplates: async () => [{ id: 't1', name: '关系表', password: 'secret' }],
    },
    memoryTableStore: {
      scopeId: 'scope-p1',
      getMemories: async ({ template_id: templateId }) => [{ id: 'row1', template_id: templateId || 't1', data: { relation: '姐弟' } }],
    },
    presetStore: {
      getResolvedActive: (type, context) => ({ type, context, preset: { prompt: `${type} prompt` } }),
      getResolvedActiveId: type => ({ presetId: `${type}-active` }),
      getActiveId: type => `${type}-fallback`,
    },
    configPanel: {
      getDraftConfig: () => ({ provider: 'openai', model: 'gpt-test', baseUrl: 'https://example.test', apiKey: 'secret' }),
    },
    getUiMode: () => 'chat',
  };
};

{
  assert.equal(normalizeAppResourceName('messages'), 'chat');
  assert.equal(normalizeAppResourceName('world-info'), 'worldbook');
  assert.equal(normalizeAppResourceName('worldbook-template'), 'worldbook');
  assert.equal(normalizeAppResourceName('character-card'), 'persona');
  assert.deepEqual(sanitizeAppResourceValue({ token: 'secret', nested: { apiKey: 'secret', ok: true } }), {
    token: '[redacted]',
    nested: { apiKey: '[redacted]', ok: true },
  });
  console.log('ok - app resource helpers normalize aliases and redact secrets');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'chat', sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].rawOriginal, '供应商完整回复');
  assert.equal(result.messages[1].reasoning, '内部推理');
  assert.equal(result.messages[1].displayText, '渲染后的回复');
  assert.equal(result.summaries[0].apiKey, '[redacted]');
  assert.equal(result.settings.token, '[redacted]');
  console.log('ok - app resource reader returns chat display, raw reply, reasoning, summaries, and settings');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'chat', sessionName: '精灵女王' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 's1');
  assert.equal(result.sessionLookup.source, 'sessionName');
  assert.equal(result.sessionLookup.matched, true);
  assert.equal(result.messages[1].rawOriginal, '供应商完整回复');
  console.log('ok - app resource reader resolves chat resources by session name');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'worldbook', sessionName: '精灵女王' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 's1');
  assert.equal(result.worldbooks[0].id, 'w1');
  assert.equal(result.worldbooks[0].entries[0].title, '精灵女王');
  assert.equal(result.worldbooks[0].entries[0].position, 4);
  assert.equal(result.worldbooks[0].entries[0].content, undefined);
  assert.equal(result.worldbooks[0].entries[0].contentPreview, undefined);
  assert.ok(result.worldbooks[0].entries[0].contentLength > 0);
  assert.equal(result.contentMode, 'summary');
  assert.equal(result.globalSettings.apiKey, '[redacted]');
  assert.equal(result.aiGeneration.templateStorageKey, 'world_ai_template_v1');
  assert.match(result.aiGeneration.template, /dialogue_examples/);
  console.log('ok - app resource reader returns worldbook entry index, injection fields, and global settings');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({
    resource: 'worldbook',
    name: 'w1',
    query: '精灵女王',
    includeContent: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentMode, 'content');
  assert.equal(result.worldbooks[0].entries.length, 1);
  assert.match(result.worldbooks[0].entries[0].content, /超级温柔/);
  console.log('ok - app resource reader returns worldbook content only when explicitly requested');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'regex', id: 'r1' });
  assert.equal(result.ok, true);
  assert.equal(result.session.enabledSetIds[0], 'r1');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].name, '输出清理');
  assert.equal(result.contentMode, 'summary');
  assert.equal(JSON.stringify(result.sets).includes('findRegex'), false, '默认正则资源不得把原始规则正文注入模型上下文');
  assert.equal(result.formatEvidence.length, 1);
  assert.deepEqual(result.formatEvidence[0].markers, ['<status>...</status>']);
  assert.equal(JSON.stringify(result.formatEvidence).includes('replaceString'), false);
  assert.match(result.formatEvidenceHint, /不能把原始 replacement/);
  console.log('ok - app resource reader returns regex session and local sets');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'regex', id: 'r1', include: ['rules'] });
  assert.equal(result.contentMode, 'details');
  assert.equal(result.sets[0].scripts[0].findRegex, '<think>.*?</think>');
  assert.match(result.contentHint, /不可信数据/);
  console.log('ok - raw regex bodies require explicit debugging expansion');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'variables' });
  assert.equal(result.ok, true);
  assert.equal(result.variables.mood, 'calm');
  assert.equal(result.globalVariables.app, 'phone');
  assert.equal(result.stageSchema.stage, 'opening');
  console.log('ok - app resource reader returns variables, schemas, rules, and stage schema');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'memory', id: 't1' });
  assert.equal(result.ok, true);
  assert.equal(result.scopeId, 'scope-p1');
  assert.equal(result.templates[0].password, '[redacted]');
  assert.equal(result.rows[0].data.relation, '姐弟');
  console.log('ok - app resource reader returns memory templates and table rows');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'preset', scope: 'sysprompt' });
  assert.equal(result.ok, true);
  assert.equal(result.context.uiMode, 'chat');
  assert.equal(result.presets.sysprompt.activeId, 'sysprompt-active');
  assert.equal(result.presets.sysprompt.resolved.preset.prompt, 'sysprompt prompt');
  console.log('ok - app resource reader returns resolved preset prompt state');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'config' });
  assert.equal(result.ok, true);
  assert.equal(result.config.provider, 'openai');
  assert.equal(result.config.model, 'gpt-test');
  assert.equal(result.config.activeProfileId, 'profile-1');
  assert.equal(Object.hasOwn(result.config, 'apiKey'), false);
  console.log('ok - app resource reader returns active config without secrets');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'session', target: '精灵女王' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].name, '精灵女王');
  assert.equal(result.sessions[0].messageCount, 2);
  console.log('ok - app resource reader returns session list with contact and message summaries');
}

{
  const deps = makeDeps();
  deps.chatStore.listSessions = () => ['group:crew', 's1'];
  deps.chatStore.getMessages = () => [];
  deps.chatStore.getSessionSettings = () => ({});
  deps.contactsStore.getContact = id => {
    if (id === 'group:crew') {
      return {
        id,
        name: '草帽一伙',
        isGroup: true,
        members: ['路飞', '索隆', '娜美'],
      };
    }
    return { id, name: id, isGroup: false };
  };
  const readResource = createAppResourceReader(deps);
  const result = await readResource({
    resource: 'session',
    name: '草帽一伙',
    include: ['members'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.includedFields, ['members']);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].memberCount, 3);
  assert.deepEqual(result.sessions[0].members, [
    { id: '路飞', name: '路飞' },
    { id: '索隆', name: '索隆' },
    { id: '娜美', name: '娜美' },
  ]);
  console.log('ok - app resource reader returns exact compact group members only when requested');
}

{
  const deps = makeDeps();
  deps.chatStore.listSessions = () => ['路飞', 'group:crew'];
  deps.chatStore.getMessages = () => [];
  deps.chatStore.getSessionSettings = () => ({});
  deps.contactsStore.getContact = id => (
    id === 'group:crew'
      ? { id, name: '草帽一伙', isGroup: true, members: ['路飞'] }
      : { id, name: id, isGroup: false }
  );
  deps.appBridge.getWorldIdsForSession = id => (
    id === '路飞' ? [] : ['unexpected-direct-world']
  );
  deps.appBridge.getResolvedWorldState = id => ({
    sessionId: id,
    globalWorldId: '',
    roleWorldIds: ['海贼王'],
    sessionWorldIds: deps.appBridge.getWorldIdsForSession(id),
    worldIds: ['海贼王', ...deps.appBridge.getWorldIdsForSession(id)],
  });
  const readResource = createAppResourceReader(deps);
  const result = await readResource({
    resource: 'session',
    include: ['members', 'worldbooks'],
  });
  assert.deepEqual(result.includedFields, ['members', 'worldbooks']);
  assert.deepEqual(result.sessions[0].worldbooks, {
    directWorldIds: [],
    roleWorldIds: ['海贼王'],
    resolvedWorldIds: ['海贼王'],
    globalWorldId: '',
    globalWorldIds: [],
  });
  assert.deepEqual(result.sessions[1].worldbooks.directWorldIds, ['unexpected-direct-world']);
  assert.deepEqual(result.sessions[1].members, [{ id: '路飞', name: '路飞' }]);
  console.log('ok - session resource readback distinguishes inherited role worlds from direct bindings');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const personas = await readResource({ resource: 'persona', query: '暗夜女王' });
  const users = await readResource({ resource: 'user' });
  assert.equal(personas.ok, true);
  assert.equal(personas.items.length, 1);
  assert.equal(personas.items[0].id, 'p2');
  assert.deepEqual(personas.items[0], {
    id: 'p2',
    name: '暗夜女王',
    active: false,
  });
  assert.equal(personas.projection, 'compact');
  assert.match(personas.contentHint, /include/);
  assert.equal(users.activeId, 'u1');
  assert.equal(users.items.length, 2);
  assert.deepEqual(users.items[0], {
    id: 'u1',
    name: '测试用户',
    active: true,
  });
  assert.equal(JSON.stringify(users).includes('base64'), false);
  assert.equal(JSON.stringify(users).includes('当前用户档案'), false);
  console.log('ok - app resource reader returns compact personas and users by default');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const descriptions = await readResource({
    resource: 'persona',
    query: '精灵女王',
    include: ['description'],
  });
  const avatar = await readResource({
    resource: 'user',
    id: 'u1',
    include: ['avatar'],
  });
  const details = await readResource({
    resource: 'persona',
    name: '暗夜女王',
    include: ['details'],
  });

  assert.equal(descriptions.projection, 'selected');
  assert.equal(descriptions.items[0].description, '温柔而坚定的精灵女王');
  assert.equal(Object.hasOwn(descriptions.items[0], 'avatar'), false);
  assert.match(avatar.items[0].avatar, /^data:image\/png;base64,C+$/);
  assert.equal(Object.hasOwn(avatar.items[0], 'description'), false);
  assert.equal(details.projection, 'full');
  assert.equal(details.items.length, 1);
  assert.equal(details.items[0].description, '统治暗夜王国');
  assert.match(details.items[0].avatar, /^data:image\/png;base64,B+$/);
  assert.deepEqual(details.items[0].source, { worldbookEnabled: false });
  assert.equal(details.items[0].active, false);
  console.log('ok - app resource reader expands only explicitly included profile fields');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const personas = await readResource({
    resource: 'persona',
    id: 'p1',
    include: ['associations'],
  });

  assert.equal(personas.projection, 'selected');
  assert.deepEqual(personas.includedFields, ['associations']);
  assert.deepEqual(personas.items[0], {
    id: 'p1',
    name: '精灵女王',
    active: true,
    associations: {
      worldbookId: 'w1',
      worldbookEnabled: true,
      systemPresetId: 'sysprompt-elf',
      regexSetId: 'r1',
    },
  });
  assert.equal(Object.hasOwn(personas.items[0], 'source'), false);
  assert.equal(JSON.stringify(personas).includes('base64'), false);
  assert.equal(JSON.stringify(personas).includes('originalCardStored'), false);
  assert.equal(JSON.stringify(personas).includes('不应进入轻量投影'), false);

  const worldbook = await readResource({
    resource: 'worldbook',
    worldbookId: personas.items[0].associations.worldbookId,
  });
  assert.equal(worldbook.ok, true);
  assert.equal(worldbook.worldbooks[0].id, 'w1');
  assert.equal(worldbook.worldbooks[0].contentMode, 'summary');
  assert.equal(Object.hasOwn(worldbook.worldbooks[0].entries[0], 'content'), false);
  console.log('ok - persona associations expose only binding refs and can resolve a worldbook summary');
}

{
  const readResource = createAppResourceReader(makeDeps());
  const result = await readResource({ resource: 'unknown' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_resource');
  assert.ok(result.supportedResources.includes('worldbook'));
  console.log('ok - app resource reader reports unsupported resources');
}
