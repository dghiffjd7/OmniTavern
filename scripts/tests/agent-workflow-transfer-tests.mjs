import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const {
  AGENT_WORKFLOW_FORMAT,
  buildAgentWorkflowPackage,
  buildAgentWorkflowWrites,
  parseAgentWorkflowPackage,
  planAgentWorkflowImport,
} = await import('../../src/scripts/agent/agent-workflow-transfer.js');

const board = {
  version: 2, id: 'b1', name: '星港', source: 'user',
  rows: [
    { id: 'r1', houses: [{
      id: 'body', kind: 'body', label: '正文', fused: ['image_prompt'],
      fusedMembers: { image_prompt: { id: 'body__image_prompt', kind: 'image_prompt', label: '图片提示', config: { modelMode: 'profile', modelProfileId: 'profile-x', modelOverride: 'gemini-x' } } },
    }] },
    { id: 'r2', houses: [
      { id: 'h_custom', kind: 'custom_prompt', label: '旁白总结', config: { prompt: '总结 {{body}}', modelMode: 'profile', modelProfileId: 'profile-y', modelOverride: 'deepseek-y', promptSource: 'preset', presetId: 'preset-openai-1' } },
      { id: 'h_edit', kind: 'text_edit', label: '润色', config: { agentId: 'text-edit:abc' } },
    ] },
  ],
};
const agents = {
  'text-edit:abc': { title: '正文润色', enabled: true, modelMode: 'profile', modelProfileId: 'profile-z', modelOverride: 'claude-z', inputConsent: true, promptSource: 'preset', presetId: 'preset-openai-2', context: { worldbook: { enabled: true, ids: ['worldbook:星港设定', 'worldbook:不存在的书:entry1'] } } },
  'input-agent:in1': { title: '输入助手', enabled: false, modelMode: 'follow_current', inputConsent: true },
  reply_check: { title: '格式修复', enabled: true, modelMode: 'follow_current', repairProfiles: { version: 1, automaticId: 'default', items: [{ id: 'default', name: '默认', config: { modelMode: 'profile', modelProfileId: 'profile-r', modelOverride: 'm-r' } }] } },
};
const settings = {
  memoryEnabled: true, memoryUpdateApiMode: 'profile', memoryUpdateProfileId: 'profile-m',
  summaryCompactionPromptSource: 'preset', summaryCompactionPresetId: 'preset-openai-3',
  autoImagePromptWritingEnabled: true, webSearchApiKey: 'secret', realtimeVoiceSettings: { configRef: { profileId: 'p' } },
};
const presetBodies = {
  'preset-openai-1': { name: '旁白预设', temperature: 0.7 },
  'preset-openai-2': { name: '润色预设', temperature: 0.3 },
  'preset-openai-3': { name: '总结预设', temperature: 0.1 },
  'preset-openai-unused': { name: '没用到的', temperature: 1 },
};
const getPreset = (type, id) => (type === 'openai' && presetBodies[id] ? { id, ...presetBodies[id] } : null);

const exported = buildAgentWorkflowPackage({
  name: '星港工作流', scope: 'card', board, agents, settings, getPreset, appVersion: '0.7.6',
  promptProfiles: { sysprompt: { profileType: 'sysprompt', presetId: 'Neutral', agents: { summary_agent: { prompts: { summary: { rules: '总结规则' } } } } } },
  now: () => 1234,
});

{
  assert.equal(exported.ok, true);
  const pkg = exported.package;
  assert.deepEqual([pkg.format, pkg.version, pkg.name, pkg.source.scope, pkg.exportedAt], [AGENT_WORKFLOW_FORMAT, 1, '星港工作流', 'card', 1234]);
  const text = JSON.stringify(pkg);
  for (const secret of ['profile-x', 'profile-y', 'profile-z', 'profile-r', 'profile-m', 'secret', 'webSearchApiKey', 'realtimeVoiceSettings']) {
    assert.equal(text.includes(secret), false, `${secret} must not be exported`);
  }
  const custom = pkg.board.rows[1].houses[0].config;
  assert.deepEqual([custom.modelMode, custom.modelOverride, custom.presetId], ['follow_current', '', 'preset-openai-1']);
  assert.equal(pkg.board.rows[0].houses[0].fusedMembers.image_prompt.config.modelMode, 'follow_current', 'fused members drop their model too');
  assert.equal(pkg.agents['text-edit:abc'].inputConsent, false, 'privacy consent never travels');
  assert.equal(pkg.agents['reply_check'].repairProfiles.items[0].config.modelMode, 'follow_current');
  assert.deepEqual(pkg.modelHints.map(hint => [hint.type, hint.model]), [
    ['house', 'gemini-x'], ['house', 'deepseek-y'], ['agent', 'claude-z'], ['repair_profile', 'm-r'], ['setting', ''],
  ]);
  assert.equal(pkg.settings.memoryUpdateApiMode, 'chat', 'a memory model on its own profile falls back to following chat');
  assert.deepEqual(Object.keys(pkg.presets).sort(), ['preset-openai-1', 'preset-openai-2', 'preset-openai-3'], 'only referenced presets are bundled');
  assert.equal(pkg.presets['preset-openai-1'].data.id, undefined);
  assert.equal(pkg.presets['preset-openai-1'].name, '旁白预设');
  assert.equal(pkg.promptProfiles.sysprompt.agents.summary_agent.prompts.summary.rules, '总结规则');
  const withoutPresets = buildAgentWorkflowPackage({ board, agents, settings, getPreset, includePresets: false });
  assert.deepEqual(withoutPresets.package.presets, {});
  console.log('ok - workflow export strips API profiles, consent and secrets, and bundles referenced presets');
}

{
  const parsed = parseAgentWorkflowPackage(JSON.stringify(exported.package));
  assert.equal(parsed.ok, true);
  assert.equal(parseAgentWorkflowPackage('{broken').reason, 'invalid_json');
  assert.equal(parseAgentWorkflowPackage({ format: 'chatapp.custom-bundle.v1' }).reason, 'not_a_workflow');
  assert.equal(parseAgentWorkflowPackage({ ...exported.package, version: 2 }).reason, 'unsupported_version');
  assert.equal(parseAgentWorkflowPackage({ ...exported.package, board: { version: 2, rows: [] } }).reason, 'invalid_board');
  const tampered = parseAgentWorkflowPackage({
    ...exported.package,
    agents: { ...exported.package.agents, 'evil:1': { title: 'x' } },
    settings: { ...exported.package.settings, webSearchApiKey: 'x' },
    presets: { p: { type: 'sysprompt', name: 'x', data: {} } },
  });
  assert.equal(tampered.package.agents['evil:1'], undefined);
  assert.equal(tampered.package.settings.webSearchApiKey, undefined, 'only whitelisted settings are accepted on import');
  assert.deepEqual(tampered.package.presets, {});
  console.log('ok - workflow files are validated and filtered on import');
}

{
  const pkg = parseAgentWorkflowPackage(exported.package).package;
  const plan = planAgentWorkflowImport(pkg, {
    findPresetByName: (type, name) => (name === '润色预设' ? 'local-polish' : ''),
    hasWorldbook: name => name === '星港设定',
    currentSettings: { memoryEnabled: true, autoImagePromptWritingEnabled: false },
  });
  assert.deepEqual(plan.houses.map(house => house.label), ['正文', '正文 · 图片提示', '旁白总结', '润色']);
  assert.deepEqual(plan.agents.map(agent => [agent.id, agent.action]), [['text-edit:abc', 'create'], ['input-agent:in1', 'create'], ['reply_check', 'replace']]);
  assert.deepEqual(plan.presets.map(item => [item.name, item.action]), [['旁白预设', 'create'], ['润色预设', 'reuse'], ['总结预设', 'create']]);
  assert.deepEqual(plan.missingWorldbooks, ['不存在的书']);
  assert.equal(plan.settingsChanges.some(change => change.key === 'memoryEnabled'), false, 'unchanged settings are not listed');
  assert.ok(plan.settingsChanges.some(change => change.key === 'autoImagePromptWritingEnabled'));
  assert.equal(plan.modelHints.length, 5);
  console.log('ok - workflow import preview lists houses, agents, presets, missing worldbooks and setting changes');
}

{
  const pkg = parseAgentWorkflowPackage(exported.package).package;
  const writes = buildAgentWorkflowWrites(pkg, {
    presetIdMap: { 'preset-openai-1': 'local-narration', 'preset-openai-2': 'local-polish' },
    newAgentIds: { 'text-edit:abc': 'text-edit:new1', 'input-agent:in1': 'input-agent:new2' },
  });
  assert.equal(writes.board.rows[1].houses[1].config.agentId, 'text-edit:new1');
  assert.equal(writes.board.rows[1].houses[0].config.presetId, 'local-narration');
  assert.deepEqual(writes.agents.map(item => [item.sourceId, item.id, item.config.id]), [
    ['text-edit:abc', 'text-edit:new1', 'text-edit:new1'], ['input-agent:in1', 'input-agent:new2', 'input-agent:new2'], ['reply_check', 'reply_check', 'reply_check'],
  ]);
  assert.equal(writes.agents[0].config.presetId, 'local-polish');
  assert.deepEqual([writes.settingsPatch.summaryCompactionPresetId, writes.settingsPatch.summaryCompactionPromptSource], ['', 'prompt'], 'a preset that did not come along falls back to the prompt');
  assert.equal(writes.promptProfiles.sysprompt.presetId, 'Neutral');
  const bare = buildAgentWorkflowWrites(pkg, { includeSettings: false, includePromptProfiles: false });
  assert.deepEqual([bare.settingsPatch, bare.promptProfiles], [{}, {}]);
  assert.equal(bare.board.rows[1].houses[0].config.promptSource, 'prompt', 'without the preset the custom house uses its own prompt');
  console.log('ok - workflow import remaps agent ids, presets and settings into writes');
}
