import assert from 'node:assert/strict';

const memoryStorage = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
};
globalThis.localStorage = globalThis.localStorage || memoryStorage();
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { createAgentWorkflowTransferService, AGENT_WORKFLOW_UNDO_KV } = await import('../../src/scripts/ui/chat/agent-workflow-transfer-service.js');
const { createScopedHopscotchBoardStore } = await import('../../src/scripts/storage/hopscotch-board-store.js');
const { createAgentConfigStore, createTextAgentId, createInputAgentId } = await import('../../src/scripts/storage/agent-config-store.js');
const { mergeImportedAgentCenterSettings, pickAgentCenterProfilesForPresets, normalizeAgentCenterSettings } = await import('../../src/scripts/storage/agent-center-settings-store.js');
const { findPresetIdByName, resolveImportedPresetIdByName } = await import('../../src/scripts/ui/preset-import-dedupe-utils.js');

const clone = value => JSON.parse(JSON.stringify(value));

// 一台「设备」：真实的板子与 Agent 配置存储（内存），预设／AC 设定／app 设定用最小替身
const createDevice = ({ sessionId, place = 'writing', scopeId = '', presets = {}, resolved = {}, resolvedPresets = {}, settings = {}, acSettings = {} }) => {
  const kv = new Map();
  const sessionSettings = new Map();
  const loadKv = async name => (kv.has(name) ? clone(kv.get(name)) : null);
  const saveKv = async (name, data) => { kv.set(name, clone(data)); return true; };
  const boardStore = createScopedHopscotchBoardStore({
    storage: memoryStorage(), loadKv, saveKv, scopeId: '',
    getSessionSettings: sid => clone(sessionSettings.get(sid) || {}),
    setSessionSettings: (sid, value) => sessionSettings.set(sid, clone(value)),
  });
  const agentConfigStore = createAgentConfigStore({ storage: memoryStorage(), loadKv, saveKv, logger: { warn() {} } });
  const presetState = { presets: { openai: clone(presets), sysprompt: {} } };
  let seq = 0;
  const presetStore = {
    getState: () => clone(presetState),
    list: type => Object.entries(presetState.presets[type] || {}).map(([id, data]) => ({ id, ...data })),
    getPreset: (type, id) => (presetState.presets[type]?.[id] ? { id, ...clone(presetState.presets[type][id]) } : null),
    getResolvedActive: type => ({ presetId: resolved[type] || '', preset: resolvedPresets[type] || null }),
    upsert: async (type, { name, data }) => { const id = `imported-${type}-${(seq += 1)}`; presetState.presets[type][id] = { ...clone(data), name }; return id; },
  };
  let ac = normalizeAgentCenterSettings(acSettings);
  const agentCenterSettings = {
    getSettings: () => clone(ac),
    replace: async (next) => { ac = normalizeAgentCenterSettings(next); return clone(ac); },
    mergeImported: async (imported, options) => { ac = mergeImportedAgentCenterSettings(ac, imported, options); return clone(ac); },
  };
  let app = clone(settings);
  const appSettings = { get: () => clone(app), update: patch => { app = { ...app, ...clone(patch) }; return clone(app); } };
  const context = { place, sessionId, scopeId };
  const service = createAgentWorkflowTransferService({
    boardStore, getSessionSettings: sid => sessionSettings.get(sid) || {}, agentConfigStore, getAgentContext: () => ({ ...context }),
    presetStore, findPresetIdByName, resolveImportedPresetIdByName, pickAgentCenterProfilesForPresets, agentCenterSettings, appSettings,
    listWorldbookNames: async () => ['星港设定'],
    createAgentId: kind => (kind === 'input_agent' ? createInputAgentId() : createTextAgentId()),
    loadKv, saveKv, getAppVersion: () => '0.7.6', now: () => 42,
  });
  return { service, boardStore, agentConfigStore, presetState, agentCenterSettings, appSettings, context, kv, sessionSettings };
};

const sourceSession = 'rp:persona_source';
const source = createDevice({
  sessionId: sourceSession,
  presets: { 'preset-narr': { name: '旁白预设', temperature: 0.6 } },
  resolved: { sysprompt: 'sys-src', openai: 'oai-src' },
  settings: { memoryEnabled: true, autoImagePromptWritingEnabled: true, summaryCompactionRules: '源总结规则', webSearchApiKey: 'secret' },
  acSettings: { profiles: { 'sysprompt:sys-src': { profileType: 'sysprompt', presetId: 'sys-src', agents: { summary_agent: { prompts: { summary: { rules: '源总结' } } } } } } },
});
const polishId = createTextAgentId();
await source.agentConfigStore.save({ id: polishId, context: source.context, scope: 'local', config: { title: '正文润色', enabled: true, modelMode: 'profile', modelProfileId: 'profile-src', modelOverride: 'claude', prompt: '润色正文', target: { mode: 'rendered' } } });
await source.agentConfigStore.save({ id: 'archive_naming', context: source.context, scope: 'local', config: { title: '小管家', enabled: true, modelMode: 'follow_current', prompt: '源命名' } });
const sourceBoard = {
  version: 2, id: 'b', name: '源板', source: 'user',
  rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', label: '正文' }] },
    { id: 'r2', houses: [
      { id: 'h_narr', kind: 'custom_prompt', label: '旁白', config: { prompt: '写旁白 {{body}}', promptSource: 'preset', presetId: 'preset-narr', modelMode: 'profile', modelProfileId: 'profile-src' } },
      { id: 'h_polish', kind: 'text_edit', label: '润色', config: { agentId: polishId } },
    ] },
  ],
};

const exported = source.service.exportWorkflow({ target: 'persona', board: sourceBoard, name: '星港工作流' });
assert.equal(exported.ok, true);
assert.equal(JSON.stringify(exported.package).includes('profile-src'), false);
assert.equal(JSON.stringify(exported.package).includes('secret'), false);
assert.equal(exported.package.promptProfiles.sysprompt.agents.summary_agent.prompts.summary.rules, '源总结');
assert.deepEqual(['archive_naming', 'reply_check', 'text_completion'].map(id => id in exported.package.agents), [true, false, false], 'built-in agents still on their defaults stay out of the file');
console.log('ok - workflow service exports the board, its agents, prompt profiles and referenced presets');

{
  const targetSession = 'rp:persona_target';
  const target = createDevice({
    sessionId: targetSession,
    resolved: { sysprompt: 'sys-target', openai: 'oai-target' },
    settings: { memoryEnabled: false, autoImagePromptWritingEnabled: false, summaryCompactionRules: '本机规则' },
  });
  await target.agentConfigStore.save({ id: 'archive_naming', context: target.context, scope: 'local', config: { title: '本机小管家', enabled: true, modelMode: 'follow_current', prompt: '本机命名' } });
  const previousBoard = { version: 2, id: 'old', name: '本机板', source: 'user', rows: [{ id: 'r1', houses: [{ id: 'body', kind: 'body', label: '正文' }] }] };
  assert.equal(target.boardStore.setPersonaBoard(previousBoard, { sessionId: targetSession }).ok, true);

  const planned = await target.service.planImportFromText(JSON.stringify(exported.package));
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.plan.presets.map(item => item.action), ['create']);
  const applied = await target.service.applyImport(planned.package, { target: 'persona' });
  assert.equal(applied.ok, true, applied.message);

  const board = target.boardStore.getSessionOverride(targetSession);
  const [narr, polish] = board.rows[1].houses;
  assert.notEqual(polish.config.agentId, polishId, 'text agents get a new id');
  const importedAgent = target.agentConfigStore.read(polish.config.agentId, target.context, 'effective');
  assert.deepEqual([importedAgent.source, importedAgent.config.title, importedAgent.config.modelMode, importedAgent.config.inputConsent], ['local', '正文润色', 'follow_current', false]);
  assert.match(narr.config.presetId, /^imported-openai-/, 'the custom house points at the imported preset');
  assert.equal(narr.config.modelMode, 'follow_current');
  assert.equal(target.presetState.presets.openai[narr.config.presetId].name, '旁白预设');
  assert.equal(target.agentConfigStore.read('archive_naming', target.context, 'effective').config.prompt, '源命名');
  assert.equal(target.agentCenterSettings.getSettings().profiles['sysprompt:sys-target'].agents.summary_agent.prompts.summary.rules, '源总结', 'built-in prompts attach to the current preset');
  const settings = target.appSettings.get();
  assert.deepEqual([settings.memoryEnabled, settings.autoImagePromptWritingEnabled, settings.summaryCompactionRules, settings.creativeHopscotchEnabled], [true, true, '源总结规则', true]);
  assert.equal(settings.webSearchApiKey, undefined);
  assert.equal((await target.service.getLastImport()).name, '星港工作流');
  assert.ok(target.kv.get(AGENT_WORKFLOW_UNDO_KV));
  console.log('ok - workflow import writes the board, new agents, presets, prompt profiles and settings to the chosen card');

  const undone = await target.service.undoLastImport();
  assert.equal(undone.ok, true);
  assert.equal(target.boardStore.getSessionOverride(targetSession).name, '本机板');
  assert.equal(target.agentConfigStore.read(polish.config.agentId, target.context, 'effective').config, null, 'the imported agent is gone after undo');
  assert.equal(target.agentConfigStore.read('archive_naming', target.context, 'effective').config.prompt, '本机命名');
  for (const id of [polish.config.agentId, 'reply_check']) {
    assert.equal(target.agentConfigStore.readEntry({ id, context: target.context, scope: 'local' }), null, `${id} leaves no placeholder behind`);
  }
  assert.equal(target.agentCenterSettings.getSettings().profiles['sysprompt:sys-target'], undefined);
  assert.equal(target.agentCenterSettings.getSettings().migrations.importedAgentCenterSettingsAt, undefined);
  const restored = target.appSettings.get();
  assert.deepEqual([restored.memoryEnabled, restored.summaryCompactionRules], [false, '本机规则']);
  assert.equal(await target.service.getLastImport(), null);
  console.log('ok - undoing a workflow import restores the previous board, agents, prompt profiles and settings');
}

{
  // 中途失败：已写入的内容按备份还原
  const targetSession = 'rp:persona_fail';
  const target = createDevice({ sessionId: targetSession, resolved: { sysprompt: 's', openai: 'o' }, settings: { memoryEnabled: false } });
  const realSet = target.boardStore.setPersonaBoard;
  target.boardStore.setPersonaBoard = () => ({ ok: false, reason: 'kv_save_failed' });
  const planned = await target.service.planImportFromText(exported.package);
  const applied = await target.service.applyImport(planned.package, { target: 'persona' });
  target.boardStore.setPersonaBoard = realSet;
  assert.equal(applied.ok, false);
  const agents = target.agentConfigStore.list(target.context, 'effective').filter(item => item.config.kind === 'text_edit' && item.config.title === '正文润色');
  assert.equal(agents.length, 0, 'agents created before the failure are removed again');
  assert.equal(target.appSettings.get().memoryEnabled, false);
  console.log('ok - a failed workflow import is rolled back');
}

{
  const outside = createDevice({ sessionId: 'chat-session' });
  outside.context.place = 'chat';
  const applied = await outside.service.applyImport(exported.package, { target: 'persona' });
  assert.equal(applied.reason, 'not_in_writing');
  console.log('ok - workflows are imported only inside a creative writing room');
}

{
  // 聊天模式：没有板子；带 Agent、正文范围规则、卡片开关、聊天设定；预设条目引用改指本机当前预设
  const chatSession = 'contact-a';
  const chat = createDevice({
    sessionId: chatSession, place: 'chat', scopeId: 'persona_me',
    resolved: { sysprompt: 'sys-chat', openai: 'oai-chat' },
    settings: { memoryTableEnabledChat: false, memoryTableEnabledWriting: false, memorySummaryRowLimitChat: 30, webSearchApiKey: 'secret', creativeHopscotchEnabled: false },
    acSettings: {
      cards: { phone_format_agent: { enabled: false, updatedAt: 1 } },
      profiles: { 'sysprompt:sys-chat': { profileType: 'sysprompt', presetId: 'sys-chat', agents: { dialogue_agent: { prompts: { dialogue: { rules: '私聊规则' } } } } } },
    },
  });
  const chatAgentId = createTextAgentId();
  const promptRef = `prompt:openai:oai-chat:${encodeURIComponent('block:main')}`;
  const lostRef = `prompt:openai:oai-chat:${encodeURIComponent('block:only_here')}`;
  await chat.agentConfigStore.save({ id: chatAgentId, context: chat.context, scope: 'local', config: { title: '聊天润色', enabled: true, modelMode: 'follow_current', prompt: '润色', context: { prompts: { enabled: true, ids: [promptRef, lostRef] } } } });
  await chat.agentConfigStore.save({ id: 'body-selector', context: chat.context, scope: 'local', config: { target: { mode: 'tags', start: '<正文>', end: '</正文>' } } });
  const exportedChat = chat.service.exportWorkflow({ target: 'session', name: '聊天工作流' });
  assert.equal(exportedChat.ok, true);
  const chatPkg = exportedChat.package;
  assert.deepEqual([chatPkg.source.place, chatPkg.source.scope, chatPkg.board], ['chat', 'chat', null]);
  assert.ok(chatPkg.agents[chatAgentId], 'chat text agents travel without a board');
  assert.equal(chatPkg.bodyRule.start, '<正文>');
  assert.deepEqual(chatPkg.cards, { dialogue_agent: true, group_agent: true, phone_format_agent: false, moment_agent: true });
  assert.deepEqual([chatPkg.settings.memoryTableEnabledChat, chatPkg.settings.memorySummaryRowLimitChat], [false, 30]);
  for (const key of ['memoryTableEnabledWriting', 'webSearchApiKey', 'creativeHopscotchEnabled']) assert.equal(key in chatPkg.settings, false, `${key} is not a chat workflow setting`);
  assert.equal(chatPkg.promptProfiles.sysprompt.agents.dialogue_agent.prompts.dialogue.rules, '私聊规则');
  console.log('ok - chat workflow export carries agents, body rule, card toggles and chat settings without a board');

  const target = createDevice({
    sessionId: 'contact-b', place: 'chat', scopeId: 'persona_you',
    resolved: { sysprompt: 'sys-b', openai: 'oai-b' },
    resolvedPresets: { openai: { prompts: [{ identifier: 'main', content: 'x' }] } },
    settings: { memoryTableEnabledChat: true, creativeHopscotchEnabled: false },
  });
  const planned = await target.service.planImportFromText(JSON.stringify(chatPkg));
  assert.equal(planned.ok, true, planned.message);
  assert.deepEqual(planned.plan.houses, []);
  assert.deepEqual(planned.plan.cardChanges.map(item => [item.id, item.to]), [['phone_format_agent', false]]);
  assert.deepEqual(planned.plan.missingPromptEntries.map(item => item.entry), ['only_here'], 'entries missing from the local preset are listed');
  const applied = await target.service.applyImport(planned.package, { target: 'session' });
  assert.equal(applied.ok, true, applied.message);
  const imported = target.agentConfigStore.list(target.context, 'effective').find(item => item.config.title === '聊天润色');
  assert.ok(imported && imported.id !== chatAgentId && imported.source === 'local');
  assert.equal(imported.config.context.prompts.ids[0], `prompt:openai:oai-b:${encodeURIComponent('block:main')}`, 'prompt entries point at the local current preset');
  assert.equal(target.agentConfigStore.read('body-selector', target.context, 'effective').config.target.start, '<正文>');
  assert.equal(target.agentCenterSettings.getSettings().cards.phone_format_agent.enabled, false);
  assert.equal(target.agentCenterSettings.getSettings().profiles['sysprompt:sys-b'].agents.dialogue_agent.prompts.dialogue.rules, '私聊规则');
  assert.deepEqual([target.appSettings.get().memoryTableEnabledChat, target.appSettings.get().creativeHopscotchEnabled], [false, false], 'chat imports never switch on the writing board');
  assert.equal(target.boardStore.getSessionOverride('contact-b'), null);
  console.log('ok - chat workflow import writes the current chat, re-points prompt entries and applies card toggles');

  const undone = await target.service.undoLastImport();
  assert.equal(undone.ok, true);
  for (const id of [imported.id, 'body-selector', 'reply_check']) {
    assert.equal(target.agentConfigStore.readEntry({ id, context: target.context, scope: 'local' }), null, `${id} is gone after undo`);
  }
  assert.equal(target.agentCenterSettings.getSettings().cards.phone_format_agent, undefined);
  assert.equal(JSON.stringify(Object.keys(target.agentConfigStore.exportState().scopes)).includes('contact-b'), false, 'no empty scope is left behind');
  assert.equal(target.agentCenterSettings.getSettings().profiles['sysprompt:sys-b'], undefined);
  assert.equal(target.appSettings.get().memoryTableEnabledChat, true);
  console.log('ok - undoing a chat workflow import restores agents, body rule, card toggles and settings');

  const writingPlan = await target.service.planImportFromText(exported.package);
  assert.equal(writingPlan.reason, 'not_in_writing');
  const writingRoom = createDevice({ sessionId: 'rp:persona_z' });
  assert.equal((await writingRoom.service.planImportFromText(chatPkg)).reason, 'not_in_chat');
  console.log('ok - workflow files are imported only in the mode they were exported from');

  // 体验包：只带 Agent，导入到新联系人，不写撤销槽、不动设定与卡片开关
  const packed = chat.service.exportWorkflow({ target: 'session', context: chat.context, agentsOnly: true });
  assert.deepEqual([packed.package.settings, packed.package.cards, packed.package.promptProfiles], [{}, {}, {}]);
  const newContact = { place: 'chat', sessionId: 'contact-new', scopeId: 'persona_you' };
  const packApplied = await target.service.applyImport(packed.package, { target: 'session', context: newContact, includeSettings: false, includePromptProfiles: false, recordUndo: false });
  assert.equal(packApplied.ok, true, packApplied.message);
  assert.ok(target.agentConfigStore.list(newContact, 'effective').some(item => item.config.title === '聊天润色'));
  assert.equal(target.agentConfigStore.list(target.context, 'effective').some(item => item.config.title === '聊天润色'), false, 'the open chat is untouched');
  assert.equal(await target.service.getLastImport(), null);
  assert.equal(target.agentCenterSettings.getSettings().cards.phone_format_agent, undefined);
  console.log('ok - an experience pack imports the contact agents into the new contact only');
}
