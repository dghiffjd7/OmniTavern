import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAppFeatureKnowledgeText,
  buildAppFeatureDoc,
  buildAppFeatureSearchContextText,
  findAppFeature,
  listAppFeatures,
  searchAppFeatures,
} from '../../src/scripts/agent/app-feature-catalog.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppSessionAgentTools } from '../../src/scripts/agent/tools/app-session-tools.js';
import { createGroupChatAgentTools } from '../../src/scripts/agent/tools/group-chat-agent-tools.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';
import { createMaidMediaAssetTools } from '../../src/scripts/agent/tools/media-asset-tools.js';
import { createAppUiCaptureTools } from '../../src/scripts/agent/tools/app-ui-capture-tools.js';
import { createWebSearchAgentTools } from '../../src/scripts/agent/tools/web-search-tools.js';
import { createMaidTodoTools } from '../../src/scripts/agent/tools/maid-todo-tools.js';
import { createMaidMemoryTools } from '../../src/scripts/agent/tools/maid-memory-tools.js';
import { createGuideStartFlowTools } from '../../src/scripts/agent/tools/guide-start-flow-tools.js';
import { createChatFormatRepairTools } from '../../src/scripts/agent/tools/chat-format-tools.js';
import { createMomentsAgentTools } from '../../src/scripts/agent/tools/moments-tools.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

const __dirname = dirname(fileURLToPath(import.meta.url));
const readRepoFile = relativePath => readFileSync(resolve(__dirname, '../..', relativePath), 'utf8');
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

{
  const results = searchAppFeatures('我想设置 API', { limit: 3 });
  assert.equal(results[0].id, 'config.api.open');
  assert.equal(results[0].panel, 'config');
  console.log('ok - app feature catalog matches API configuration wording');
}

{
  const feature = findAppFeature('会话配置');
  assert.equal(feature.id, 'session.config.open');
  const doc = buildAppFeatureDoc(feature.id);
  assert.match(doc.doc, /界面路径/);
  assert.match(doc.doc, /session\.open_config/);
  console.log('ok - app feature catalog resolves aliases and builds concise docs');
}

{
  const inspect = findAppFeature('app.visible_panel.read');
  const click = findAppFeature('app.ui.click');
  assert.deepEqual(inspect.tools, ['app.ui.inspect', 'app.read_visible_panel_summary']);
  assert.deepEqual(click.tools, ['ui.click_element']);
  assert.equal(click.directAction, 'ui.click_element');
  console.log('ok - inspect and click tools have unambiguous feature ownership');
}

{
  const results = searchAppFeatures('帮我联网搜索最新资讯', { limit: 3 });
  assert.equal(results[0].id, 'web.search');
  assert.deepEqual(results[0].tools, ['web.search', 'web.fetch_url', 'web.research', 'web.search_images']);
  const doc = buildAppFeatureDoc('web.search');
  assert.match(doc.doc, /web\.search/);
  assert.match(doc.doc, /web\.fetch_url/);
  assert.match(doc.doc, /web\.research/);
  console.log('ok - app feature catalog exposes web search feature');
}

{
  // Shadow miss 归因回归（2026-07-28）：这些说法此前全部落到 4 候选兜底集。
  const listHit = searchAppFeatures('帮我看看会话列表', { limit: 5 });
  assert.equal(listHit[0]?.id, 'session.list');
  assert.ok(listHit[0].tools.includes('session.list'));
  const pageHit = searchAppFeatures('你现在在哪个页面', { limit: 5 });
  assert.equal(pageHit[0]?.id, 'app.state.read');
  const todoHit = searchAppFeatures('帮我记个待办', { limit: 5 });
  assert.equal(todoHit[0]?.id, 'maid.todo');
  const todoEn = searchAppFeatures('加一条todo', { limit: 5 });
  assert.equal(todoEn[0]?.id, 'maid.todo');
  const todoMark = searchAppFeatures('把待办里前两项标记为完成', { limit: 5 });
  assert.equal(todoMark[0]?.id, 'maid.todo');
  const imageHit = searchAppFeatures('网上搜图给我看看', { limit: 5 });
  assert.equal(imageHit[0]?.id, 'web.search');
  assert.ok(imageHit[0].tools.includes('web.search_images'));
  const imageHit2 = searchAppFeatures('搜一张猫的图片', { limit: 5 });
  assert.equal(imageHit2[0]?.id, 'web.search');
  // 批次三归因回归：询问式资源读取与连线配置说法
  const presetQ = searchAppFeatures('当前用的是哪个预设？', { limit: 5 });
  assert.ok(presetQ.some(f => f.id === 'app.resource.read'), '预设询问应召回资源读取');
  const memoryQ = searchAppFeatures('看看当前会话的表格记忆里记了什么', { limit: 5 });
  assert.ok(memoryQ.some(f => f.id === 'app.resource.read'), '表格记忆询问应召回资源读取');
  const sessionCfgQ = searchAppFeatures('帮我看看当前聊天室的会话配置摘要', { limit: 5 });
  assert.ok(sessionCfgQ.some(f => f.id === 'app.resource.read'), '会话配置摘要询问应召回资源读取');
  const personaQ = searchAppFeatures('我现在有哪些角色卡？', { limit: 5 });
  assert.ok(personaQ.some(f => f.id === 'app.resource.read'), '角色卡询问应召回资源读取');
  assert.match(findAppFeature('app.resource.read').argsHint, /include:\["associations"\]/);
  const providerQ = searchAppFeatures('现在的连线配置用的哪个服务商和模型？', { limit: 5 });
  assert.ok(providerQ.some(f => f.id === 'config.model.switch'), '服务商/模型询问应召回渠道能力');
  // 批次四归因回归：资源名词级问法
  for (const q of ['当前会话有哪些变量？', '帮我看看上一条AI回复的完整原文', '当前会话绑定了哪些正则规则？', '我的用户名称列表有哪些？', '「测试花园」最近一条消息说了什么？']) {
    const r = searchAppFeatures(q, { limit: 8 });
    assert.ok(r.some(f => f.id === 'app.resource.read'), `资源问法应召回万能读取：${q}`);
  }
  console.log('ok - app feature catalog recalls session list / app state / todo write / image search / resource question phrasings');
}

{
  const generateImage = findAppFeature('media.generate_image');
  assert.deepEqual(generateImage.tools, ['media.generate_image']);
  assert.equal(generateImage.directAction, 'media.generate_image');
  assert.match(generateImage.argsHint, /subjectAliases/);
  assert.match(generateImage.argsHint, /不要传 width\/height/);
  const results = searchAppFeatures('把这张图设为角色头像', { limit: 3 });
  assert.equal(results[0].id, 'persona.avatar.set');
  const wallpaper = findAppFeature('设置聊天室壁纸');
  assert.equal(wallpaper.id, 'session.wallpaper.set');
  assert.ok(wallpaper.tools.includes('session.set_wallpaper'));
  assert.ok(wallpaper.tools.includes('media.generate_image'));
  assert.match(wallpaper.argsHint, /media\.generate_image/);
  const contactAvatar = findAppFeature('contact.avatar.set');
  assert.ok(contactAvatar.tools.includes('media.generate_image'));
  assert.match(contactAvatar.argsHint, /media\.generate_image/);
  const personaAvatar = findAppFeature('persona.avatar.set');
  assert.ok(personaAvatar.tools.includes('media.generate_image'));
  assert.match(personaAvatar.argsHint, /media\.generate_image/);
  assert.equal(searchAppFeatures('生成一张头像', { limit: 3 })[0].id, 'contact.avatar.set');
  assert.equal(searchAppFeatures('生成一张角色头像', { limit: 3 })[0].id, 'persona.avatar.set');
  assert.ok(
    searchAppFeatures('调用生图工具生成一张图片附件', { limit: 3 })
      .some(feature => feature.id === 'media.generate_image'),
  );
  console.log('ok - app feature catalog exposes direct image generation and target-specific image assets');
}

{
  const feature = findAppFeature('worldbook.bind_sessions');
  assert.deepEqual(feature.tools, ['worldbook.bind_sessions']);
  assert.match(feature.argsHint, /sessions\[\]/);
  assert.match(feature.argsHint, /preview/);
  assert.equal(searchAppFeatures('给这些房都绑上世界书', { limit: 3 })[0].id, 'worldbook.bind_sessions');
  console.log('ok - worldbook binding feature exposes the batch primitive');
}

{
  const createGroup = findAppFeature('group.create');
  const updateMembers = findAppFeature('group.members.update');
  const openGroupCreate = findAppFeature('group.create.open');
  assert.deepEqual(createGroup.tools, ['group.create']);
  assert.deepEqual(updateMembers.tools, ['group.update_members']);
  assert.deepEqual(openGroupCreate.tools, ['app.open_panel']);
  assert.equal(searchAppFeatures('创建一个叫侍奉部的群聊', { limit: 1 })[0].id, 'group.create');
  assert.equal(searchAppFeatures('给侍奉部群聊加上雪乃和结衣', { limit: 1 })[0].id, 'group.members.update');
  assert.equal(searchAppFeatures('打开建群界面', { limit: 1 })[0].id, 'group.create.open');
  console.log('ok - group chat catalog separates real group creation, member editing, and create-panel navigation');
}

{
  const sessionDelete = findAppFeature('session.delete_many');
  const personaDelete = findAppFeature('persona.delete_many');
  const worldbookDelete = findAppFeature('worldbook.delete_many');
  assert.deepEqual(sessionDelete.tools, ['session.delete_many']);
  assert.match(sessionDelete.argsHint, /当前会话是批量专属保护项/);
  assert.deepEqual(personaDelete.tools, ['persona.delete_many']);
  assert.match(personaDelete.argsHint, /不跨资源删除/);
  assert.deepEqual(worldbookDelete.tools, ['worldbook.delete_many']);
  assert.match(worldbookDelete.argsHint, /手机-格式/);
  assert.equal(searchAppFeatures('清理测试用的房间', { limit: 1 })[0].id, 'session.delete_many');
  assert.equal(searchAppFeatures('批量删除测试角色卡', { limit: 1 })[0].id, 'persona.delete_many');
  assert.equal(searchAppFeatures('删除这些测试世界书', { limit: 1 })[0].id, 'worldbook.delete_many');
  assert.equal(searchAppFeatures('删除世界书重复条目', { limit: 1 })[0].id, 'worldbook.delete_entries');
  console.log('ok - resource-specific batch deletion features expose protected domains and precise retrieval aliases');
}

{
  const memoryList = findAppFeature('maid.memory.list');
  const memoryArchive = findAppFeature('maid.memory.archive');
  assert.deepEqual(memoryList.tools, ['maid.memory.list']);
  assert.deepEqual(memoryArchive.tools, ['maid.memory.archive']);
  assert.equal(memoryArchive.confirmation, 'required');
  assert.match(memoryArchive.argsHint, /明确 memoryIds/);
  assert.equal(searchAppFeatures('你记得什么', { limit: 1 })[0].id, 'maid.memory.list');
  assert.equal(searchAppFeatures('归档女仆记忆', { limit: 1 })[0].id, 'maid.memory.archive');
  assert.equal(searchAppFeatures('打开记忆表格', { limit: 1 })[0].id, 'memory.open');
  console.log('ok - maid memory features distinguish semantic memory management from the chat memory table');
}

{
  const feature = findAppFeature('女仆新手任务');
  assert.equal(feature.id, 'maid.onboarding');
  assert.deepEqual(feature.tools, []);
  assert.equal(feature.maidModelContext, 'awareness_only');
  const knowledge = buildAppFeatureKnowledgeText([feature]);
  assert.match(knowledge, /内建新手任务/);
  assert.doesNotMatch(knowledge, /guide\.start_flow|setup-api|add-friend|first-chat|meet-maid/);
  console.log('ok - app feature catalog exposes only awareness of local built-in onboarding');
}

{
  const appJs = readRepoFile('src/scripts/ui/app.js');
  const start = appJs.indexOf('registerAppNavigationAgentTools(agentToolRegistry, {');
  const end = appJs.indexOf('registerAppSessionAgentTools(agentToolRegistry, {');
  assert.ok(start >= 0 && end > start, 'app navigation tool registration block not found');
  const registrationBlock = appJs.slice(start, end);
  const appPanelFeatures = listAppFeatures()
    .filter(feature => (feature.tools || []).includes('app.open_panel') && feature.panel);
  for (const feature of appPanelFeatures) {
    const panel = escapeRegex(feature.panel);
    const keyPattern = /^[A-Za-z_$][\w$]*$/.test(feature.panel)
      ? new RegExp(`(?:${panel}|['"]${panel}['"])\\s*:`)
      : new RegExp(`['"]${panel}['"]\\s*:`);
    assert.match(registrationBlock, keyPattern, `${feature.id} panel ${feature.panel} is not wired in app.js`);
  }
  console.log('ok - app feature catalog panel entries are wired in app.js');
}

{
  const knowledge = buildAppFeatureKnowledgeText([
    {
      id: 'worldbook.open',
      title: '打开世界书',
      summary: '打开当前会话世界书管理界面。',
      uiPath: ['聊天室右上角菜单', '世界书'],
      tools: ['app.open_panel'],
    },
  ]);
  assert.match(knowledge, /- id: worldbook\.open/);
  assert.match(knowledge, /title: 打开世界书/);
  assert.match(knowledge, /path: 聊天室右上角菜单 -> 世界书/);
  assert.match(knowledge, /tools: \[app\.open_panel\]/);

  const context = buildAppFeatureSearchContextText('世界书在哪里', { limit: 2 });
  assert.match(context, /检索：已执行/);
  assert.match(context, /命中：打开世界书/);
  assert.match(context, /worldbook\.open/);
  console.log('ok - app feature catalog builds maid knowledge and search context text');
}

{
  const openedPanels = [];
  const openedSessions = [];
  const openedConfigs = [];
  const activeSessions = [];
  const refreshed = [];
  const generatedChatImages = [];
  const switchedProfiles = [];
  const savedWorlds = new Map();
  const boundWorlds = [];
  const personas = new Map();
  const users = new Map();
  const sessionSettings = new Map();
  let personaSeq = 0;
  let userSeq = 0;
  let current = 'B';
  const contacts = new Map([
    ['B', { id: 'B', name: 'Beta', isGroup: false }],
  ]);
  const messages = new Map();
  const sessionWorldIds = new Map();
  const navTools = createAppNavigationAgentTools({
    clickUiElement: async ({ ref, label }) => ({ ok: true, clicked: label || ref, after: { panels: [] } }),
    actions: {
      'agent-center': options => openedPanels.push(['agent-center', options]),
      config: options => openedPanels.push(['config', options]),
      session: options => openedPanels.push(['session', options]),
      'session-config': options => openedPanels.push(['session-config', options]),
      'group-create': options => openedPanels.push(['group-create', options]),
      worldbook: options => openedPanels.push(['worldbook', options]),
      memory: options => openedPanels.push(['memory', options]),
      variables: options => openedPanels.push(['variables', options]),
      regex: options => openedPanels.push(['regex', options]),
    },
    getCurrentState: () => ({ activePage: 'chat', uiMode: 'chat', sessionId: current }),
    getVisiblePanelSummary: () => ({
      ok: true,
      activePage: 'chat',
      uiMode: 'chat',
      sessionId: current,
      panels: [{ id: 'chat', title: '聊天室', text: 'Beta 聊天室' }],
    }),
    readResource: args => ({
      ok: true,
      resource: args.resource,
      sessionId: args.sessionId || current,
    }),
    listRecentErrors: () => [],
  });
  const sessionTools = createAppSessionAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
      upsertContact: contact => {
        contacts.set(contact.id, { ...contact });
        return contacts.get(contact.id);
      },
    },
    chatStore: {
      getCurrent: () => current,
      switchSession: id => {
        current = id;
      },
      appendMessage: (message, id = current) => {
        const list = messages.get(id) || [];
        list.push({ ...message });
        messages.set(id, list);
      },
    },
    enterChatRoom: async id => {
      openedSessions.push(id);
      return { blocked: false };
    },
    refreshChatAndContacts: options => refreshed.push(options),
    setActiveSession: id => activeSessions.push(id),
    showSessionConfig: options => openedConfigs.push(options),
    renderSessionNameHtml: (id, contact) => contact?.name || id,
    now: () => 1000,
  });
  const contentTools = createAppContentAgentTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      create: async (data = {}) => {
        personaSeq += 1;
        const item = { id: `persona-${personaSeq}`, ...data };
        personas.set(item.id, item);
        return item;
      },
      setActive: async id => personas.has(id),
    },
    userStore: {
      getAll: () => Array.from(users.values()),
      get: id => users.get(id) || null,
      create: async (data = {}) => {
        userSeq += 1;
        const item = { id: `user-${userSeq}`, ...data };
        users.set(item.id, item);
        return item;
      },
      setActive: async id => users.has(id),
    },
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      getCurrent: () => current,
      switchSession: id => {
        current = id;
      },
      appendMessage: (message, id = current) => {
        const list = messages.get(id) || [];
        list.push({ ...message });
        messages.set(id, list);
      },
    },
    saveWorldInfo: async (id, data) => savedWorlds.set(id, data),
    getWorldInfo: async id => savedWorlds.get(id) || null,
    listWorlds: async () => Array.from(savedWorlds.keys()),
    waitForWorldStoreReady: async () => true,
    getWorldIdsForSession: async sessionId => sessionWorldIds.get(sessionId) || [],
    getGlobalWorldId: async () => '',
    assignWorldToPersona: async (personaId, worldId, options) => {
      boundWorlds.push({ personaId, worldId, options });
      const persona = personas.get(personaId);
      persona.source = { ...persona.source, worldbookId: worldId, worldbookEnabled: options.enabled };
      return true;
    },
    getRpSessionId: personaId => `rp:${personaId}`,
    bindWorldToSession: async (sessionId, worldIds, options) => {
      sessionWorldIds.set(sessionId, [...worldIds]);
      boundWorlds.push({ sessionId, worldIds, options });
    },
    enterChatRoom: async id => {
      openedSessions.push(id);
      return { blocked: false };
    },
    refreshChatAndContacts: options => refreshed.push(options),
    setActiveSession: id => activeSessions.push(id),
    generateChatImage: async ({ prompt, sessionId, negativePrompt = '', referenceImages = [] } = {}) => {
      generatedChatImages.push({ prompt, sessionId, negativePrompt, referenceImages });
      return true;
    },
    listModelProfiles: async ({ scope } = {}) => (scope === 'image'
      ? {
        activeId: 'img-bp',
        profiles: [
          { id: 'img-bp', name: 'byteplus', provider: 'custom', model: 'seedream' },
          { id: 'img-nai', name: 'NAI', provider: 'novelai', model: 'nai-diffusion' },
        ],
      }
      : { activeId: 'chat-1', profiles: [{ id: 'chat-1', name: '主档', provider: 'custom', model: 'm1' }] }),
    switchModelProfile: async ({ scope, profileId } = {}) => {
      switchedProfiles.push({ scope, profileId });
      return { ok: true };
    },
    renderSessionNameHtml: (id, contact) => contact?.name || id,
    getActiveUserName: () => 'CatalogUser',
    now: () => 1000,
  });
  const webTools = createWebSearchAgentTools({
    httpRequest: async () => ({
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Heading: 'Catalog Web',
        AbstractText: 'Catalog web result.',
        AbstractURL: 'https://example.com/catalog',
        AbstractSource: 'Example',
      }),
    }),
  });
  const mediaTools = createMaidMediaAssetTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => Array.from(personas.values())[0] || null,
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    userStore: {
      getAll: () => Array.from(users.values()),
      get: id => users.get(id) || null,
      getActive: () => Array.from(users.values())[0] || null,
      update: async (id, patch) => {
        const next = { ...users.get(id), ...patch };
        users.set(id, next);
        return next;
      },
    },
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
      upsertContact: contact => contacts.set(contact.id, { ...contacts.get(contact.id), ...contact }),
    },
    chatStore: {
      getSessionSettings: id => sessionSettings.get(id) || {},
      setSessionSettings: (id, next) => sessionSettings.set(id, next),
    },
    getCurrentSessionId: () => current,
    prepareImage: async ({ purpose }) => ({
      dataUrl: `data:image/webp;base64,${purpose}`,
      width: purpose === 'avatar' ? 256 : 1280,
      height: purpose === 'avatar' ? 256 : 720,
      mime: purpose === 'avatar' ? 'image/webp' : 'image/jpeg',
      bytes: 120,
      transformed: true,
    }),
    generateImageAttachment: async () => ({
      dataUrl: 'data:image/png;base64,R0VORVJBVEVE',
      width: 1024,
      height: 1024,
      mime: 'image/png',
      bytes: 9,
      generationContext: {
        provider: 'novelai',
        model: 'nai-diffusion-4-5-full',
        promptDialect: 'nai_tags',
        promptLanguage: 'en',
        width: 1024,
        height: 1024,
      },
    }),
    getImageGenerationContext: async () => ({
      provider: 'novelai',
      model: 'nai-diffusion-4-5-full',
      promptDialect: 'nai_tags',
      promptLanguage: 'en',
      width: 1024,
      height: 1024,
    }),
    saveWallpaper: async payload => ({ path: `wallpapers/${payload.sessionId}/wallpaper.jpg`, bytes: 120 }),
    refreshChatAndContacts: options => refreshed.push(options),
    applyChatSettings: () => {},
    now: () => 1000,
  });
  const captureTools = createAppUiCaptureTools({
    checkVisionSupport: async () => ({ ok: true }),
    captureRegion: async () => ({
      dataUrl: 'data:image/png;base64,Q0FQVFVSRQ==',
      mime: 'image/png',
      width: 120,
      height: 80,
      bytes: 7,
    }),
    now: () => 1000,
  });
  const todoRuns = new Map([['run-1', { id: 'run-1', metadata: { todos: [] } }]]);
  const todoTools = createMaidTodoTools({
    getRun: runId => todoRuns.get(runId) || null,
    updateRun: (runId, patch) => {
      const run = todoRuns.get(runId);
      if (run) run.metadata = { ...run.metadata, ...(patch?.metadata || {}) };
      return run;
    },
  });
  const maidSemanticMemories = new Map([[
    'catalog-memory',
    {
      id: 'catalog-memory',
      kind: 'important_event',
      key: 'event.catalog_probe',
      content: '目录测试长期记忆。',
      confidence: 'verified',
      status: 'active',
      updatedAt: 1000,
    },
  ]]);
  const maidMemoryStore = {
    listMemories: ({ kind = '', status = '', query = '', limit = 0 } = {}) => Array.from(maidSemanticMemories.values())
      .filter(memory => !kind || memory.kind === kind)
      .filter(memory => !status || memory.status === status)
      .filter(memory => !query || `${memory.key} ${memory.content}`.includes(query))
      .slice(0, limit || undefined),
    getMemory: id => maidSemanticMemories.get(id) || null,
    setMemoryStatus: async (id, status) => {
      const memory = maidSemanticMemories.get(id);
      if (!memory) return null;
      memory.status = status;
      return memory;
    },
  };
  const maidMemoryTools = createMaidMemoryTools({
    semanticMemoryStore: maidMemoryStore,
  });
  const startedGuideFlows = [];
  const guideTools = createGuideStartFlowTools({
    startFlow: flowId => startedGuideFlows.push(flowId),
  });
  const formatProfiles = new Map();
  const formatTools = createChatFormatRepairTools({
    repairMessageFormat: async args => ({ ok: true, applied: true, formatHint: args.formatHint }),
    optimizeMessage: async args => ({ ok: true, applied: true, instruction: args.instruction }),
    formatProfileStore: {
      get: sid => formatProfiles.get(sid) || null,
      set: (sid, profile) => {
        const saved = { sessionId: sid, guide: profile.guide, sources: profile.sources || [] };
        formatProfiles.set(sid, saved);
        return saved;
      },
    },
    resolveSessionId: ({ sessionId, sessionName }) => sessionId || sessionName || current,
  });
  const publishedMoments = [];
  const momentsTools = createMomentsAgentTools({
    publishMoment: async (payload) => {
      publishedMoments.push(payload);
      return { ok: true, momentId: 'catalog-moment', commentsRequested: payload.generateComments === true };
    },
  });
  const groupTools = createGroupChatAgentTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
      upsertContact: contact => {
        contacts.set(contact.id, { ...(contacts.get(contact.id) || {}), ...contact });
        return contacts.get(contact.id);
      },
    },
    chatStore: {
      getCurrent: () => current,
      switchSession: id => {
        current = id;
      },
      appendMessage: (message, id = current) => {
        const list = messages.get(id) || [];
        list.push({ ...message });
        messages.set(id, list);
      },
    },
    refreshChatAndContacts: options => refreshed.push(options),
    createGroupId: () => 'group:catalog',
    now: () => 1000,
  });
  const tools = [...navTools, ...sessionTools, ...groupTools, ...contentTools, ...mediaTools, ...captureTools, ...webTools, ...todoTools, ...maidMemoryTools, ...guideTools, ...formatTools, ...momentsTools];
  const maidAttachments = [{ id: 'catalog-image', kind: 'image', url: 'data:image/png;base64,AAAA', name: 'catalog.png' }];

  for (const feature of listAppFeatures()) {
    for (const toolName of feature.tools || []) {
      assert.ok(getTool(tools, toolName), `${feature.id} references missing tool ${toolName}`);
    }
  }

  const runFeature = async (feature) => {
    if (feature.id === 'app.ui.capture_region') {
      const context = {
        userSelection: [{
          regionId: 'catalog-region',
          semanticSummary: '目录测试选区',
          viewportRect: { left: 10, top: 10, width: 120, height: 80 },
        }],
        maidAttachments: [],
      };
      const result = await getTool(tools, 'ui.capture_region').execute({ regionId: 'catalog-region' }, context);
      assert.equal(result.ok, true);
      assert.equal(result.imageInjected, true);
      assert.equal(context.maidAttachments.length, 1);
      return;
    }
    if (feature.id === 'session.create') {
      const result = await getTool(tools, 'session.create').execute({ name: 'CatalogRoom', open: true });
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      return;
    }
    if (feature.id === 'session.delete_many') {
      const result = await getTool(tools, 'session.delete_many').execute({ sessions: ['Beta'], preview: true });
      assert.equal(result.ok, true);
      assert.equal(result.preview, true);
      return;
    }
    if (feature.id === 'session.open') {
      const result = await getTool(tools, 'session.open').execute({ sessionId: 'Beta' });
      assert.equal(result.ok, true);
      assert.equal(result.sessionId, 'B');
      return;
    }
    if (feature.id === 'session.config.open') {
      const result = await getTool(tools, 'session.open_config').execute({ sessionId: 'Beta' });
      assert.equal(result.ok, true);
      assert.equal(result.opened, true);
      return;
    }
    if (feature.id === 'group.create') {
      const result = await getTool(tools, 'group.create').execute({
        name: 'CatalogGroup',
        members: ['B', 'CatalogRoom'],
      }, {
        toolSafety: {
          decision: 'allow',
          request: { kind: 'group.create' },
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.equal(result.verified, true);
      return;
    }
    if (feature.id === 'group.members.update') {
      const result = await getTool(tools, 'group.update_members').execute({
        group: 'CatalogGroup',
        removeMembers: ['CatalogRoom'],
      }, {
        toolSafety: {
          decision: 'allow',
          request: { kind: 'group.update_members' },
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.verified, true);
      return;
    }
    if (feature.id === 'persona.create') {
      const result = await getTool(tools, 'persona.create').execute({ name: 'CatalogRole', setActive: true });
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      return;
    }
    if (feature.id === 'persona.delete_many') {
      const result = await getTool(tools, 'persona.delete_many').execute({ personas: ['CatalogRole'], preview: true });
      assert.equal(result.ok, true);
      assert.equal(result.preview, true);
      return;
    }
    if (feature.id === 'persona.switch') {
      const result = await getTool(tools, 'persona.switch').execute({ target: 'CatalogRole' });
      assert.equal(result.ok, true);
      assert.equal(result.switched, true);
      return;
    }
    if (feature.id === 'media.generate_image') {
      const result = await getTool(tools, 'media.generate_image').execute({
        prompt: '1girl, catalog_subject, solo, school_uniform',
        negativePrompt: 'lowres, blurry',
        subject: '目录测试人物',
        subjectAliases: ['catalog_subject'],
        target: 'Beta',
        purpose: 'avatar',
        appearance: 'black hair, blue eyes',
        outfit: 'school uniform',
        style: 'anime',
        targetAspectRatio: '1:1',
      }, {});
      assert.equal(result.ok, true);
      assert.match(result.attachmentId, /^generated-/);
      return;
    }
    if (feature.id === 'persona.avatar.set') {
      const result = await getTool(tools, 'persona.set_avatar').execute({ target: 'CatalogRole' }, { maidAttachments });
      assert.equal(result.ok, true);
      assert.match(personas.get('persona-1').avatar, /data:image\/webp/);
      return;
    }
    if (feature.id === 'user.create') {
      const result = await getTool(tools, 'user.create').execute({ name: 'CatalogUser', setActive: true });
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      return;
    }
    if (feature.id === 'user.switch') {
      const result = await getTool(tools, 'user.switch').execute({ target: 'CatalogUser' });
      assert.equal(result.ok, true);
      assert.equal(result.switched, true);
      return;
    }
    if (feature.id === 'user.avatar.set') {
      const result = await getTool(tools, 'user.set_avatar').execute({ target: 'CatalogUser' }, { maidAttachments });
      assert.equal(result.ok, true);
      assert.match(users.get('user-1').avatar, /data:image\/webp/);
      return;
    }
    if (feature.id === 'contact.avatar.set') {
      const result = await getTool(tools, 'contact.set_avatar').execute({ target: 'Beta' }, { maidAttachments });
      assert.equal(result.ok, true);
      assert.match(contacts.get('B').avatar, /data:image\/webp/);
      return;
    }
    if (feature.id === 'session.wallpaper.set') {
      const result = await getTool(tools, 'session.set_wallpaper').execute({ target: 'Beta' }, { maidAttachments });
      assert.equal(result.ok, true);
      assert.equal(sessionSettings.get('B').wallpaper.path, 'wallpapers/B/wallpaper.jpg');
      return;
    }
    if (feature.id === 'worldbook.create') {
      const result = await getTool(tools, 'worldbook.create').execute({
        name: 'CatalogWorld',
        personaName: 'CatalogRole',
        bindToPersona: true,
        entries: [{ title: 'CatalogEntry', content: 'Catalog content.' }],
      });
      assert.equal(result.ok, true);
      assert.equal(result.entryCount, 1);
      return;
    }
    if (feature.id === 'worldbook.update_entries') {
      const result = await getTool(tools, 'worldbook.update_entries').execute({
        name: 'CatalogWorld',
        updates: [{ entryTitle: 'CatalogEntry', content: 'Updated catalog content.' }],
      }, {
        toolSafety: {
          decision: 'allow',
          request: { kind: 'worldbook.update_entries' },
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.updatedEntryCount, 1);
      return;
    }
    if (feature.id === 'worldbook.delete_entries') {
      savedWorlds.set('CatalogDeleteWorld', {
        name: 'CatalogDeleteWorld',
        entries: [
          { id: 'old', comment: 'Duplicate', content: 'old' },
          { id: 'latest', comment: 'Duplicate', content: 'latest' },
        ],
      });
      const result = await getTool(tools, 'worldbook.delete_entries').execute({
        name: 'CatalogDeleteWorld',
        dedupeByTitle: true,
        duplicateTitles: ['Duplicate'],
        keep: 'last',
      }, {
        toolSafety: {
          decision: 'allow',
          request: { kind: 'worldbook.delete_entries' },
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.deletedEntryCount, 1);
      assert.deepEqual(savedWorlds.get('CatalogDeleteWorld').entries.map(entry => entry.id), ['latest']);
      return;
    }
    if (feature.id === 'worldbook.delete_many') {
      const result = await getTool(tools, 'worldbook.delete_many').execute({ worldbooks: ['CatalogWorld'], preview: true });
      assert.equal(result.ok, true);
      assert.equal(result.preview, true);
      return;
    }
    if (feature.id === 'worldbook.list') {
      const result = await getTool(tools, 'worldbook.list').execute({ sessionId: current });
      assert.equal(result.ok, true);
      assert.ok(result.worldbooks.some(item => item.id === 'CatalogWorld'));
      return;
    }
    if (feature.id === 'worldbook.bind_persona') {
      const result = await getTool(tools, 'worldbook.bind_persona').execute({ personaName: 'CatalogRole', worldbookId: 'CatalogWorld' });
      assert.equal(result.ok, true);
      assert.equal(result.scope, 'persona');
      assert.equal(result.personaId, 'persona-1');
      const listed = await getTool(tools, 'worldbook.list').execute({});
      assert(listed.worldbooks.find(book => book.id === 'CatalogWorld').personaBindings.some(binding => binding.personaId === result.personaId && binding.enabled));
      return;
    }
    if (feature.id === 'worldbook.bind_session') {
      const result = await getTool(tools, 'worldbook.bind_session').execute({ sessionId: current, worldbookId: 'CatalogWorld' });
      assert.equal(result.ok, true);
      assert.equal(result.bound, true);
      assert.deepEqual(boundWorlds.at(-1), { sessionId: current, worldIds: ['CatalogWorld'], options: { silent: false } });
      return;
    }
    if (feature.id === 'worldbook.bind_sessions') {
      const result = await getTool(tools, 'worldbook.bind_sessions').execute({
        sessions: [current, 'B'],
        worldbookId: 'CatalogWorld',
        preview: true,
      });
      assert.equal(result.ok, true);
      assert.equal(result.preview, true);
      assert.equal(result.requestedCount, 2);
      return;
    }
    if (feature.id === 'worldbook.bind_rp_session') {
      const result = await getTool(tools, 'worldbook.bind_rp_session').execute({
        personaName: 'CatalogRole',
        worldbookId: 'CatalogWorld',
      });
      assert.equal(result.ok, true);
      assert.equal(result.scope, 'rp_only');
      assert.equal(result.rpSessionId, 'rp:persona-1');
      assert.deepEqual(boundWorlds.at(-1), {
        sessionId: 'rp:persona-1',
        worldIds: ['CatalogWorld'],
        options: { silent: false },
      });
      return;
    }
    if (feature.id === 'worldbook.read') {
      const result = await getTool(tools, 'worldbook.read').execute({ name: 'CatalogWorld' });
      assert.equal(result.ok, true);
      assert.equal(result.entries[0].title, 'CatalogEntry');
      return;
    }
    if (feature.id === 'chat.send_message') {
      const result = await getTool(tools, 'chat.send_message').execute({ sessionId: 'Beta', content: 'hi' });
      assert.equal(result.ok, true);
      assert.equal(result.sent, true);
      return;
    }
    if (feature.id === 'moments.publish') {
      const result = await getTool(tools, 'moments.publish').execute({ content: '今天也被女仆照顾得很好 @大小姐', generateComments: false });
      assert.equal(result.ok, true);
      assert.equal(result.momentId, 'catalog-moment');
      assert.equal(result.commentsRequested, false);
      assert.equal(publishedMoments[0].content, '今天也被女仆照顾得很好 @大小姐');
      return;
    }
    if (feature.id === 'config.model.switch') {
      const listed = await getTool(tools, 'config.list_profiles').execute({ scope: 'image' });
      assert.equal(listed.ok, true);
      assert.equal(listed.profiles.length, 2);
      assert.equal(listed.profiles.find(p => p.active)?.name, 'byteplus');
      const switched = await getTool(tools, 'config.switch_profile').execute({ scope: 'image', profileName: 'NAI' });
      assert.equal(switched.ok, true);
      assert.equal(switched.switched, true);
      assert.equal(switched.to.name, 'NAI');
      assert.deepEqual(switchedProfiles[switchedProfiles.length - 1], { scope: 'image', profileId: 'img-nai' });
      return;
    }
    if (feature.id === 'chat.image.generate') {
      const result = await getTool(tools, 'chat.generate_image').execute({
        sessionId: 'Beta',
        prompt: 'a cute cat',
        referenceImages: ['1'],
      }, {
        maidAttachments: [{
          id: 'catalog-image',
          kind: 'image',
          name: 'catalog.png',
          url: 'data:image/png;base64,AAAA',
        }],
      });
      assert.equal(result.ok, true);
      assert.equal(result.generated, true);
      assert.equal(result.referenceImageCount, 1);
      assert.deepEqual(generatedChatImages[generatedChatImages.length - 1], {
        prompt: 'a cute cat',
        sessionId: 'B',
        negativePrompt: '',
        referenceImages: ['data:image/png;base64,AAAA'],
      });
      return;
    }
    if (feature.id === 'app.state.read') {
      const result = await getTool(tools, 'app.get_current_state').execute({});
      assert.equal(result.activePage, 'chat');
      return;
    }
    if (feature.id === 'app.visible_panel.read') {
      const result = await getTool(tools, 'app.ui.inspect').execute({});
      assert.equal(result.ok, true);
      assert.equal(result.panels[0].id, 'chat');
      return;
    }
    if (feature.id === 'app.resource.read') {
      const result = await getTool(tools, 'app.read_resource').execute({ resource: 'chat', sessionId: current });
      assert.equal(result.ok, true);
      assert.equal(result.resource, 'chat');
      return;
    }
    if (feature.id === 'web.search') {
      const result = await getTool(tools, 'web.search').execute({ query: 'Catalog Web', limit: 1 });
      assert.equal(result.ok, true);
      assert.equal(result.results[0].url, 'https://example.com/catalog');
      return;
    }
    if (feature.id === 'chat.format.repair') {
      const result = await getTool(tools, 'chat.repair_message_format').execute({ formatHint: '状态栏格式' });
      assert.equal(result.ok, true);
      assert.equal(result.applied, true);
      return;
    }
    if (feature.id === 'app.ui.click') {
      const clicked = await getTool(tools, 'ui.click_element').execute({ label: '设置' }, {});
      assert.equal(clicked.ok, true);
      assert.equal(clicked.clicked, '设置');
      return;
    }
    if (feature.id === 'chat.format.profile') {
      const saved = await getTool(tools, 'chat.save_format_profile').execute({ sessionId: 'B', guide: '状态块格式规范内容' });
      assert.equal(saved.ok, true);
      const read = await getTool(tools, 'chat.read_format_profile').execute({ sessionId: 'B' });
      assert.equal(read.hasProfile, true);
      return;
    }
    if (feature.id === 'chat.message.optimize') {
      const result = await getTool(tools, 'chat.optimize_message').execute({ instruction: '更简洁' });
      assert.equal(result.ok, true);
      assert.equal(result.applied, true);
      return;
    }
    if (feature.id === 'maid.todo') {
      const wrote = await getTool(tools, 'maid.todo.write').execute(
        { todos: [{ content: '创建聊天室', status: 'in_progress' }] },
        { runId: 'run-1' },
      );
      assert.equal(wrote.ok, true);
      const read = await getTool(tools, 'maid.todo.read').execute({}, { runId: 'run-1' });
      assert.equal(read.ok, true);
      assert.equal(read.todos[0].content, '创建聊天室');
      return;
    }
    if (feature.id === 'maid.memory.list') {
      const result = await getTool(tools, 'maid.memory.list').execute({});
      assert.equal(result.ok, true);
      assert.deepEqual(result.items.map(item => item.id), ['catalog-memory']);
      return;
    }
    if (feature.id === 'maid.memory.archive') {
      const result = await getTool(tools, 'maid.memory.archive').execute({
        memoryIds: ['catalog-memory'],
        preview: true,
      });
      assert.equal(result.ok, true);
      assert.equal(result.preview, true);
      assert.equal(result.plannedCount, 1);
      return;
    }
    if (feature.id === 'maid.onboarding') {
      assert.equal(feature.maidModelContext, 'awareness_only');
      assert.deepEqual(feature.tools, []);
      assert.deepEqual(startedGuideFlows, []);
      return;
    }
    if (feature.id === 'app.errors.read') {
      const result = await getTool(tools, 'app.read_recent_errors').execute({});
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.errors));
      return;
    }
    if (feature.id === 'app.capabilities.search') {
      const result = await getTool(tools, 'app.search_feature').execute({ query: '世界书' });
      assert.ok(result.features.length > 0);
      const doc = await getTool(tools, 'app.read_feature_doc').execute({ featureId: result.features[0].id });
      assert.equal(doc.ok, true);
      assert.ok(doc.feature.doc.length > 0);
      return;
    }
    const panel = feature.panel;
    const result = await getTool(tools, 'app.open_panel').execute({
      panel,
      ...(feature.id === 'config.api.open' ? { tab: 'chat' } : {}),
    });
    assert.equal(result.ok, true);
    assert.equal(result.opened, true);
    assert.equal(result.panel, panel);
  };

  for (const feature of listAppFeatures()) {
    await runFeature(feature);
  }

  assert.ok(openedPanels.some(([panel]) => panel === 'config'));
  assert.ok(openedPanels.some(([panel]) => panel === 'worldbook'));
  assert.ok(openedConfigs.some(item => item.sessionId === 'B'));
  assert.ok(openedSessions.includes('B'));
  assert.ok(openedSessions.includes('CatalogRoom'));
  assert.ok(activeSessions.includes('CatalogRoom'));
  assert.ok(personas.has('persona-1'));
  assert.ok(users.has('user-1'));
  assert.ok(savedWorlds.has('CatalogWorld'));
  assert.ok(boundWorlds.some(item => item.worldId === 'CatalogWorld'));
  assert.ok(messages.get('B')?.some(message => message.content === 'hi'));
  assert.ok(refreshed.length > 0);
  console.log('ok - app feature catalog entries map to executable maid tools');
}
