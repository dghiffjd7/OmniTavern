import assert from 'node:assert/strict';

import { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAgentConfigurationService } from '../../src/scripts/agent/agent-configuration-service.js';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';
import { createAgentConfigAgentTools } from '../../src/scripts/agent/tools/agent-config-tools.js';
import { searchMaidCapabilityConcepts } from '../../src/scripts/agent/maid-capability-concept-retriever.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

// 真实的 Agent 设定存储与服务（存储放内存），女仆工具经真实注册表执行。
const setup = ({ place = 'chat', flowBoard = null } = {}) => {
  const memory = new Map();
  const store = createAgentConfigStore({
    storage: { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) },
    logger: { warn() {}, debug() {} },
  });
  let context = place === 'writing'
    ? { place: 'writing', sessionId: 'rp:card', scopeId: 'person' }
    : { place: 'chat', sessionId: 'contact_1', scopeId: 'person' };
  const profiles = [{ id: 'p_ds', name: 'Deepseek', model: 'v4-flash' }, { id: 'p_main', name: '主档', model: 'main' }];
  const actions = createAgentConfigurationService({
    store, getContext: () => context, getMessages: () => [], getRaw: async () => '', getProfiles: () => profiles,
    runtime: { list: () => [] }, buildFormatPreview: async () => ({}),
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(createAgentConfigAgentTools({
    getActions: () => actions,
    getContext: () => context,
    listPresets: () => [{ id: 'op_polish', name: '润色预设' }],
    ...(flowBoard ? { getFlowBoard: flowBoard } : {}),
  }));
  const requests = [];
  const run = (name, args, { allow = true, onConfirm = null, signal = null } = {}) => registry.executeTool(name, args, {
    sessionId: context.sessionId,
    signal,
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: (request) => {
      requests.push(request);
      return onConfirm ? onConfirm(request) : { decision: allow ? 'allow' : 'deny' };
    },
  });
  return { store, actions, run, requests, setContext: next => { context = next; }, getContext: () => context };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a reply Agent created by the maid polishes every reply with the chosen model', async () => {
  const { run, requests, store, getContext } = setup();
  const result = await run('agent.upsert', {
    agents: [{ create: 'reply_agent', title: '正文润色', prompt: '润色正文，保留剧情。', model: { mode: 'profile', profile: 'Deepseek' } }],
  });
  assert.equal(result.result.succeededCount, 1, JSON.stringify(result.result));
  const request = requests.at(-1);
  assert.equal(request.kind, 'agent.upsert');
  assert.match(request.message, /每条回复后再调用一次模型/, 'auto reply Agents warn about the extra model call');
  assert.match(request.details.items[0].meta, /新建：开启 · 自动 · 模型：Deepseek · 改写原文/);
  const created = store.list(getContext()).find(item => item.config.kind === 'text_edit' && item.config.title === '正文润色');
  assert.ok(created, 'saved in the current chat');
  assert.equal(created.source, 'local');
  assert.equal(created.config.enabled, true);
  assert.equal(created.config.invocationMode, 'auto');
  assert.equal(created.config.modelProfileId, 'p_ds');
  assert.equal(created.config.target.mode, 'rendered');
  assert.equal(created.config.prompt, '润色正文，保留剧情。');
});

test('invalid requests fail before the confirmation and nothing is written', async () => {
  const { run, requests, store, getContext } = setup();
  const noModel = await run('agent.upsert', { agents: [{ create: 'input_agent', title: '草稿助手', prompt: '给建议' }] });
  assert.equal(noModel.result.failedCount, 1);
  assert.equal(noModel.result.results[0].reason, 'invalid_configuration');
  assert.match(noModel.result.results[0].message, /选择模型/);
  const badProfile = await run('agent.upsert', { agents: [{ create: 'reply_agent', model: { mode: 'profile', profile: '不存在' } }] });
  assert.equal(badProfile.result.results[0].reason, 'model_profile_not_found');
  assert.ok(badProfile.result.results[0].candidates.some(item => item.name === 'Deepseek'), 'lists the profiles to choose from');
  const both = await run('agent.upsert', { agents: [{ create: 'reply_agent', id: 'x' }] });
  assert.equal(both.result.results[0].reason, 'id_or_create_required');
  assert.equal(requests.length, 0, 'no confirmation for requests that cannot be saved');
  assert.equal(store.list(getContext()).filter(item => item.config.kind !== 'input_suggestion' && /^(text-edit|input-agent):(?!recap)/.test(item.config.id)).length, 0);
});

test('cancelling the confirmation writes nothing', async () => {
  const { run, store, getContext } = setup();
  const result = await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '取消测试' }] }, { allow: false });
  assert.notEqual(result.result?.succeededCount, 1);
  assert.equal(store.list(getContext()).some(item => item.config.title === '取消测试'), false);
});

test('built-in format repair and text suggestion only change switch, invocation and model', async () => {
  const { run, store, getContext } = setup();
  const rejected = await run('agent.upsert', { agents: [{ id: 'text_completion', enabled: true, prompt: '改提示词' }] });
  assert.equal(rejected.result.results[0].reason, 'field_not_editable');
  assert.deepEqual(rejected.result.results[0].fields, ['prompt']);
  const enabled = await run('agent.upsert', { agents: [{ id: 'text_completion', enabled: true, model: { mode: 'profile', profile: 'p_ds' } }] });
  assert.equal(enabled.result.succeededCount, 1, JSON.stringify(enabled.result));
  const saved = store.read('text_completion', getContext()).config;
  assert.equal(saved.enabled, true);
  assert.equal(saved.modelProfileId, 'p_ds');
  const repair = await run('agent.upsert', { agents: [{ id: 'reply_check', enabled: true, model: { mode: 'profile', profile: '主档' } }] });
  assert.equal(repair.result.succeededCount, 1, JSON.stringify(repair.result));
  assert.equal(store.read('reply_check', getContext()).config.modelProfileId, 'p_main');
  const again = await run('agent.upsert', { agents: [{ id: 'reply_check', enabled: true, model: { mode: 'profile', profile: '主档' } }] });
  assert.equal(again.result.results[0].status, 'skipped', 'no change is reported as skipped');
});

test('switching format repair on keeps its repair profiles and the automatic choice', async () => {
  const { run, store, getContext } = setup();
  const library = {
    version: 1, automaticId: 'strict', deletedIds: [],
    items: [
      { id: 'default', name: '默认方案', config: { prompt: '默认修复', formatGuide: '' } },
      { id: 'strict', name: '严格方案', config: { prompt: '严格修复', formatGuide: '<状态栏>…</状态栏>' } },
    ],
  };
  const seeded = store.read('reply_check', getContext(), 'local');
  await store.save({ id: 'reply_check', context: getContext(), scope: 'local', revision: seeded.revision,
    config: { ...seeded.config, enabled: false, modelMode: 'profile', modelProfileId: 'p_ds', repairProfiles: library } });
  const before = store.read('reply_check', getContext(), 'local').config.repairProfiles;
  const result = await run('agent.upsert', { agents: [{ id: 'reply_check', enabled: true }] });
  assert.equal(result.result.succeededCount, 1, JSON.stringify(result.result));
  const after = store.read('reply_check', getContext(), 'local').config;
  assert.equal(after.enabled, true);
  assert.deepEqual(after.repairProfiles.items.map(item => [item.id, item.name, item.config.prompt]), before.items.map(item => [item.id, item.name, item.config.prompt]));
  assert.equal(after.repairProfiles.automaticId, 'strict');
});

test('updates find Agents by title, use the preset source and global scope', async () => {
  const { run, store, getContext } = setup();
  await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '正文润色' }] });
  const updated = await run('agent.upsert', { agents: [{ id: '正文润色', preset: '润色预设', invocation: 'manual', outputMode: 'note' }] });
  assert.equal(updated.result.succeededCount, 1, JSON.stringify(updated.result));
  const config = store.list(getContext()).find(item => item.config.title === '正文润色').config;
  assert.equal(config.promptSource, 'preset');
  assert.equal(config.presetId, 'op_polish');
  assert.equal(config.invocationMode, 'manual');
  assert.equal(config.outputMode, 'note');
  const shared = await run('agent.upsert', { scope: 'global', agents: [{ create: 'reply_agent', title: '全局润色' }] });
  assert.equal(shared.result.succeededCount, 1);
  assert.equal(store.list(getContext(), 'global').some(item => item.config.title === '全局润色'), true);
  assert.equal(store.list({ ...getContext(), sessionId: 'contact_2' }).some(item => item.config.title === '全局润色'), true, 'shared with other chats');
  assert.equal(store.list({ ...getContext(), sessionId: 'contact_2' }).some(item => item.config.title === '正文润色'), false, 'local Agents stay in their chat');
});

test('a change made elsewhere during the confirmation is not overwritten', async () => {
  const { run, actions, store, getContext } = setup();
  await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '正文润色' }] });
  const id = store.list(getContext()).find(item => item.config.title === '正文润色').config.id;
  const result = await run('agent.upsert', { agents: [{ id, prompt: '女仆改的' }] }, {
    onConfirm: async () => {
      const record = actions.getAgentConfiguration({ id, scope: 'local', context: getContext() });
      await actions.saveAgentConfiguration({ id, scope: 'local', context: getContext(), revision: record.revision, config: { ...record.config, prompt: '用户改的' } });
      return { decision: 'allow' };
    },
  });
  assert.equal(result.result.results[0].reason, 'target_changed_during_confirmation');
  assert.equal(store.read(id, getContext()).config.prompt, '用户改的');
});

test('switching chats during the confirmation stops the write', async () => {
  const { run, store, setContext, getContext } = setup();
  const original = getContext();
  const result = await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '切换测试' }] }, {
    onConfirm: () => { setContext({ ...original, sessionId: 'contact_2' }); return { decision: 'allow' }; },
  });
  assert.equal(result.result.results[0].reason, 'context_changed_during_confirmation');
  assert.equal(store.list(original).some(item => item.config.title === '切换测试'), false);
});

test('agent.list shows Agents, models and the steward tasks', async () => {
  const { run } = setup();
  await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '正文润色', model: { mode: 'profile', profile: 'Deepseek' } }] });
  const listed = await run('agent.list', {});
  assert.equal(listed.result.ok, true);
  assert.equal(listed.result.place, 'chat');
  const polish = listed.result.agents.find(agent => agent.title === '正文润色');
  assert.equal(polish.type, 'reply_agent');
  assert.deepEqual(polish.model, { mode: 'profile', profileId: 'p_ds', profileName: 'Deepseek' });
  assert.equal(polish.invocation, 'auto');
  const steward = listed.result.agents.find(agent => agent.type === 'steward');
  assert.ok(steward.tasks.some(task => task.id === 'translate_message'));
  assert.ok(listed.result.modelProfiles.some(profile => profile.name === 'Deepseek'));
  const one = await run('agent.list', { agent: '正文润色' });
  assert.equal(one.result.agent.prompt, '润色正文，保留事实、人物语气和原意。', 'a single Agent shows the full prompt');
});

test('with a custom flow board in creative writing, an auto Agent off the board is reported as not running', async () => {
  let board = { custom: true, agentIds: ['text-edit:recap'] };
  const { run, requests } = setup({ place: 'writing', flowBoard: () => board });
  const result = await run('agent.upsert', {
    agents: [{ create: 'reply_agent', title: '正文润色', model: { mode: 'profile', profile: 'Deepseek' } }],
  });
  const item = result.result.results[0];
  assert.equal(item.status, 'succeeded', JSON.stringify(result.result));
  assert.equal(item.onFlowBoard, false);
  assert.match(item.note, /自定义流程板/);
  assert.match(requests.at(-1).message, /放进流程板才会/);
  assert.doesNotMatch(requests.at(-1).message, /每条回复后再调用一次模型/, 'no extra-call warning when it will not run');
  const listed = await run('agent.list', {});
  assert.equal(listed.result.flowBoard, 'custom');
  assert.equal(listed.result.agents.find(agent => agent.title === '正文润色').onFlowBoard, false);

  board = { custom: true, agentIds: [item.id] };
  assert.equal((await run('agent.list', {})).result.agents.find(agent => agent.title === '正文润色').onFlowBoard, true);
  const placed = await run('agent.upsert', { agents: [{ id: '正文润色', invocation: 'both' }] });
  assert.equal(placed.result.results[0].onFlowBoard, true);
  assert.equal(placed.result.results[0].note, undefined);
  assert.match(requests.at(-1).message, /每条回复后再调用一次模型/);

  board = { custom: false, agentIds: [] };
  const derived = await run('agent.list', {});
  assert.equal(derived.result.flowBoard, 'derived');
  assert.equal(derived.result.agents.find(agent => agent.title === '正文润色').onFlowBoard, undefined, 'the derived board runs every auto Agent');
});

test('agent.delete_many removes user-made Agents and protects the built-ins', async () => {
  const { run, requests, store, getContext } = setup();
  await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '正文润色' }] });
  const result = await run('agent.delete_many', { targets: ['正文润色', 'reply_check', '没有这个'] });
  assert.equal(result.result.succeededCount, 1, JSON.stringify(result.result));
  const statuses = Object.fromEntries(result.result.results.map(item => [item.title || item.label, item.status]));
  assert.equal(statuses['正文润色'], 'succeeded');
  assert.equal(result.result.results.find(item => item.id === 'reply_check').status, 'protected');
  assert.equal(result.result.results.find(item => item.label === '没有这个').status, 'missing');
  assert.equal(requests.at(-1).danger, true, 'deleting uses the dangerous confirmation');
  assert.equal(store.list(getContext()).some(item => item.config.title === '正文润色'), false);
});

test('steward.configure turns the steward on with a model, adjusts tasks and custom tasks', async () => {
  const { run, requests, store, getContext } = setup();
  const noModel = await run('steward.configure', { enabled: true });
  assert.equal(noModel.result.ok, false);
  assert.equal(noModel.result.reason, 'invalid_request');
  assert.match(noModel.result.errors[0].message, /选择模型/);
  const configured = await run('steward.configure', {
    enabled: true,
    model: { profile: 'Deepseek' },
    tasks: [
      { id: 'archive_overview', enabled: true },
      { id: 'translate_message', model: { mode: 'profile', profile: '主档' }, targetLanguage: 'ja' },
    ],
    customTasks: [{ name: '总结', prompt: '用三句话总结这段内容。', input: 'recent', output: 'bubble' }],
  });
  assert.equal(configured.result.ok, true, JSON.stringify(configured.result));
  assert.equal(requests.at(-1).kind, 'steward.configure');
  assert.ok(requests.at(-1).details.items.length >= 4, 'every change is listed in the confirmation');
  const metas = Object.fromEntries(requests.at(-1).details.items.map(item => [item.label, item.meta]));
  assert.equal(metas['存档概述'], '关闭 ⇒ 开启', 'task changes show before and after');
  assert.equal(metas['消息翻译'], '模型：共用模型 ⇒ 主档 · 翻译成：跟随界面语言 ⇒ 日本語');
  const config = store.read('archive_naming', getContext()).config;
  assert.equal(config.enabled, true);
  assert.equal(config.modelProfileId, 'p_ds');
  assert.equal(config.tasks.archive_overview.enabled, true);
  assert.equal(config.tasks.translate_message.modelProfileId, 'p_main');
  assert.equal(config.tasks.translate_message.targetLanguage, 'ja');
  assert.equal(config.customTasks.length, 1);
  assert.equal(config.customTasks[0].output, 'bubble');
  const removed = await run('steward.configure', { customTasks: [{ id: '总结', remove: true }], tasks: [{ id: 'translate_message', model: { mode: 'shared' } }] });
  assert.equal(removed.result.ok, true, JSON.stringify(removed.result));
  const after = store.read('archive_naming', getContext()).config;
  assert.equal(after.customTasks.length, 0);
  assert.equal(after.tasks.translate_message.modelProfileId, '');
  const unchanged = await run('steward.configure', { enabled: true });
  assert.equal(unchanged.result.skipped, true);
});

test('creative writing keeps its own Agents', async () => {
  const { run, store, getContext } = setup({ place: 'writing' });
  const result = await run('agent.upsert', { agents: [{ create: 'reply_agent', title: '写作润色' }] });
  assert.equal(result.result.succeededCount, 1);
  assert.match(result.result.scopeLabel, /角色卡/);
  assert.equal(store.list({ ...getContext(), place: 'chat', sessionId: 'contact_1' }).some(item => item.config.title === '写作润色'), false);
});

test('the maid finds the Agent tools for workflow requests but keeps one-off polishing separate', () => {
  const features = listAppFeatures();
  const top = (query) => searchMaidCapabilityConcepts(query, { features, limit: 3 }).map(item => item.id);
  assert.ok(top('我想做一个正文润色，每次正文生成结束后额外调用一个模型来进行编修').includes('agent.upsert'));
  assert.ok(top('帮我做一个正文润色').includes('agent.upsert'));
  assert.ok(top('开启格式修复，用 Deepseek').includes('agent.upsert'));
  assert.ok(top('删掉正文润色这个 agent').includes('agent.delete_many'));
  assert.ok(top('小管家用 Deepseek 模型').includes('steward.configure'));
  assert.ok(top('我有哪些 agent').includes('agent.list'));
  assert.deepEqual(top('润色这条回复'), ['chat.message.optimize'], 'polishing one reply stays a one-off edit');
  assert.deepEqual(top('不要开启小管家'), []);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
  }
}
if (failed) process.exitCode = 1;
