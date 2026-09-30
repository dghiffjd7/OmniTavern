import assert from 'node:assert/strict';
import test from 'node:test';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { buildMaidModelPlannerMessages, buildMaidModelReActMessages, createMaidModelBackedPlanner, createMaidModelBackedReActPlanner } from '../../src/scripts/agent/maid-model-planner.js';
import { createMaidAppDiscoveryPlan, shouldRecoverMaidAppDiscovery } from '../../src/scripts/agent/maid-app-discovery-recovery.js';

// Sanitized control decisions captured in interface-fixes/D02-deepseek and C05-deepseek.
// Replay the real JSON/FC normalizers and agent; there is no model or network request.
const capturedUnsupported = { ok: false, reason: 'unsupported_intent', message: '“奇幻大陆”可能是世界书、角色卡或聊天室，名称不明确，无法直接删除。' };
const capturedClarify = { action: 'clarify', message: '主人，「小雪」我记下了，但「那个猫娘」我这边没有对应的联系人记录，不敢乱猜。请告诉我猫娘在联系人列表里的具体名字，或者确认一下是不是叫别的称呼，我再帮您建群。', reason: '成员指代不明确，猜错会建错群' };
// D06-deepseek in comparison-recheck: replay only its public control response.
const capturedMergeUnsupported = { ok: false, reason: 'unsupported_intent', message: '没有可用的世界书合并工具，且“奇幻大陆的副本”指向不明确。' };
// completion-deepseek-readonly/C02 and N05: exact initial decisions, before
// the chat responder incorrectly claimed that registered APP tools were absent.
const colloquialRefusals = [
  ['帮我弄个好玩的群', '「好玩的群」还缺少主题、成员和群名等关键信息，我无法直接建群。请告诉我群的主题（比如角色扮演、吐槽、学习小组）、想拉哪些联系人，以及群名，我再帮你创建。', 'group.create'],
  ['帮她换个 avatar 风格要 anime 一点 然后 wallpaper 也换', '还没确定要给谁换头像、换哪张壁纸，也没有可用的图片素材，暂时没法直接执行。', 'contact.avatar.set'],
  ['把路娜拉进周末出游群', '我暂时没有把联系人加入群聊的执行工具，只能打开建群/成员编修界面由您手动操作。', 'group.members.update'],
  ['壁纸太丑了换一个', '当前没有可用的壁纸生成或更换工具，无法直接替换壁纸。', 'session.wallpaper.set'],
];
const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const logger = { warn() {}, debug() {} };
const features = listAppFeatures();
const emit = (options, decision) => {
  options.onProviderToolCallDelta({ output: [{ type: 'function_call', id: 'replay-control', call_id: 'replay-control', name: 'maid_planner_control', arguments: JSON.stringify(decision) }] }, { provider: config.provider, model: config.model });
};

const replay = async ({ input, initial = capturedUnsupported, native = false, control = capturedClarify, denySearch = false, missingSearch = false, failSearch = false, abort = false } = {}) => {
  const executed = [], decisions = [], calls = [];
  const permissionEvaluator = { evaluateTool: tool => ({ decision: denySearch && tool.name === 'app.search_feature' ? 'deny' : 'allow', checks: [] }) };
  const registry = createAgentToolRegistry({ permissionEvaluator, logger });
  const navigation = createAppNavigationAgentTools().filter(tool => !missingSearch || tool.name !== 'app.search_feature');
  if (failSearch) navigation.find(tool => tool.name === 'app.search_feature').execute = async () => ({ ok: false, reason: 'catalog_unavailable' });
  for (const tool of navigation) registry.register(tool);
  const registered = new Set(navigation.map(tool => tool.name));
  for (const feature of features) for (const name of feature.tools || []) {
    if (registered.has(name) || missingSearch && name === 'app.search_feature') continue;
    registered.add(name);
    registry.register({ name, riskLevel: feature.riskLevel, schema: { type: 'object', properties: {} }, execute: async () => { throw new Error(`Unexpected business operation: ${name}`); } });
  }
  const execute = registry.executeTool.bind(registry);
  registry.executeTool = async (name, args, context) => {
    const trace = { name, args };
    executed.push(trace);
    trace.output = await execute(name, args, context);
    return trace.output;
  };
  const routing = createMaidCapabilityRoutingRuntime({ features, toolRegistry: registry, permissionEvaluator, logger });
  const client = { async chat(messages, options) {
    calls.push({ messages, native: Boolean(options.tools?.length) });
    if (native && options.tools?.length) { emit(options, control); return ''; }
    return JSON.stringify(initial);
  } };
  const deps = { features, resolveRuntimeConfig: async () => ({ config, client }), getProviderFcExperimentStatus: () => ({ enabled: native }), logger };
  const observe = planner => async (...args) => { const result = await planner(...args); decisions.push(result); return result; };
  const agent = createMaidAssistantAgent({
    toolRegistry: registry, capabilityRoutingRuntime: routing,
    planner: observe(createMaidModelBackedPlanner(deps)), reactPlanner: observe(createMaidModelBackedReActPlanner(deps)),
    getCapabilityRoutingConfigOverride: () => ({ mode: 'bounded' }),
    chatResponder: async (_input, _context, { plan }) => ({ ok: true, message: plan.message }),
    maxReactSteps: 3, logger,
  });
  const controller = new AbortController();
  if (abort) controller.abort();
  const result = await agent.runPrompt(input, { uiMode: 'chat', signal: controller.signal });
  return { result, executed, decisions, calls };
};

test('captured initial JSON unsupported gets one public discovery before claiming inability', async () => {
  const replayed = await replay({ input: '把奇幻大陆删了' });
  assert.deepEqual(replayed.executed.map(tool => tool.name), ['app.search_feature']);
  assert.equal(replayed.executed[0].args.query, '删除');
  assert.ok(replayed.executed[0].output.result.features.some(feature => feature.id === 'worldbook.delete_many'), 'real public search finds deletion domains without guessing the target');
  assert.equal(replayed.decisions[0].reason, 'unsupported_intent');
  assert.equal(replayed.result.plan.source, 'maid_discovery_recovery');
  assert.equal(replayed.result.plan.metadata.discoveryRecovery.maxRecoveries, 1);
  assert.ok(replayed.calls.length <= 2, 'one recovery must not loop on repeated unsupported');
});

test('captured colloquial APP requests discover real tools before claiming they are unavailable', async () => {
  for (const [input, message, featureId] of colloquialRefusals) {
    const replayed = await replay({ input, initial: { ok: false, reason: 'unsupported_intent', message } });
    assert.deepEqual(replayed.executed.map(tool => tool.name), ['app.search_feature'], input);
    assert.ok(replayed.executed[0].output.result.features.some(feature => feature.id === featureId), input);
    assert.ok(replayed.calls.length <= 2, 'missing details allow one catalog lookup, never a guessed write');
  }
});

test('colloquial discovery keeps ordinary chat, refusal and no-lookup boundaries', () => {
  for (const input of ['这个群挺好玩，陪我聊聊', '帮我弄个猫咪群像画', '帮我弄杯咖啡', '帮她换头像，但先别换了', '帮我弄个群，但不要查', '帮她换头像这件事是什么意思', '把路娜拉进群，但不要加了', '壁纸太丑了但不用换', '头像换了以后为什么变模糊', '这壁纸以前换过了，陪我聊聊']) {
    assert.equal(shouldRecoverMaidAppDiscovery({ input, decision: capturedUnsupported }), false, input);
  }
});

test('captured native clarify gets public discovery without silently creating a group', async () => {
  const replayed = await replay({ input: '建个群里面有小雪和那个猫娘', native: true });
  assert.equal(replayed.decisions[0].providerFcControl, 'clarify');
  assert.deepEqual(replayed.executed.map(tool => tool.name), ['app.search_feature']);
  assert.ok(replayed.executed[0].output.result.features.some(feature => feature.id === 'group.create'), 'real capability lookup must produce useful group documentation');
  assert.ok(replayed.calls[1].messages.some(message => String(message.content).includes('APP performed one bounded public capability lookup')));
  assert.ok(replayed.calls.length <= 2, 'repeated clarify must stop after the single discovery');
});

test('captured merge refusal recovers once through actual public catalog without guessing a private target', async () => {
  const replayed = await replay({ input: '把奇幻大陆的副本合并回去', initial: capturedMergeUnsupported });
  assert.deepEqual(replayed.executed.map(tool => tool.name), ['app.search_feature']);
  assert.equal(replayed.executed[0].args.query, '合并');
  const found = replayed.executed[0].output.result.features;
  for (const id of ['worldbook.compare', 'session.compare']) {
    assert.ok(found.some(feature => feature.id === id && feature.writes === false), `actual catalog must expose read-only comparison help: ${id}`);
  }
  assert.equal(replayed.result.plan.source, 'maid_discovery_recovery');
  assert.equal(replayed.result.plan.metadata.discoveryRecovery.maxRecoveries, 1);
  assert.ok(replayed.calls.length <= 2, 'a second unsupported decision must stop, not trigger another search');
});

test('explicit merge commands normalize only the operation, in Chinese and English', () => {
  for (const input of [
    '把春日设定的副本合并回去', '请将旧副本并回原本', '帮我合并这两本世界书',
    '请把世界书 A 和 B 合并', 'merge the copy back into the original',
    'Please merge these two worldbooks', 'Could you merge the copies?',
  ]) {
    assert.equal(shouldRecoverMaidAppDiscovery({ input, decision: capturedMergeUnsupported }), true, input);
    assert.equal(createMaidAppDiscoveryPlan({ input, decision: capturedMergeUnsupported }).args.query, '合并', input);
  }
});

test('merge recovery preserves negation, discussion, no-lookup and existing-evidence boundaries', async () => {
  for (const input of [
    '那个副本挺好看的，陪我聊聊', '世界书合并是什么意思', '如何把世界书副本合并回去',
    '我不想合并世界书', '别合并世界书', '不要merge the worldbooks',
    'Do not merge the copy', "Don't merge the worldbooks", '把副本合并回去，但不需要查',
    '把世界书副本合并回去，但不要查询',
    '把副本合并回去，不合并了', '把副本并回原本，先不并回了',
  ]) {
    assert.equal(shouldRecoverMaidAppDiscovery({ input, decision: capturedMergeUnsupported }), false, input);
  }
  const input = '把旧世界书的副本合并回去';
  for (const context of [{ maidDiscoveryRecovery: {} }, { maidReactSteps: [{ toolName: 'worldbook.list', status: 'succeeded' }] }, { runContinuation: { successfulSteps: [] } }, { operationIntentPolicy: { mode: 'no_tool' } }]) {
    assert.equal(shouldRecoverMaidAppDiscovery({ input, decision: capturedMergeUnsupported, context }), false);
  }
  for (const options of [
    { denySearch: true }, { missingSearch: true }, { abort: true },
    { initial: { ok: false, reason: 'permission_denied', message: '用户已拒绝许可。' } },
  ]) {
    assert.deepEqual((await replay({ input, initial: capturedMergeUnsupported, ...options })).executed, []);
  }
});

test('initial planner does not contradict registered confirmation-protected destructive tools', () => {
  const messages = buildMaidModelPlannerMessages({ input: '删除旧的世界书', features, featureIndex: features });
  assert.ok(!messages[0].content.includes('不要删除、覆盖或修改高风险数据'), 'initial blanket prohibition contradicts the registered confirmation protocol');
  assert.match(messages[0].content, /APP 确认弹窗/);
});

test('both planner stages explain actual cross-card target choices without treating evidence as permission', () => {
  for (const build of [buildMaidModelPlannerMessages, buildMaidModelReActMessages]) {
    const prompt = build({ input: '补充人物设定', features, featureIndex: features })[0].content;
    assert.match(prompt, /targetSelectionEvidence/);
    assert.match(prompt, /bindingState/);
    assert.match(prompt, /use_current_binding/);
    assert.match(prompt, /create_and_bind/);
    assert.match(prompt, /use_observed_worldbook/);
    assert.match(prompt, /unknown is not unbound/);
    assert.match(prompt, /user already named the target book or owner card/);
    assert.match(prompt, /never grant write permission/);
  }
});

test('empty low-confidence candidates do not promote the first registered write features', async () => {
  let messages;
  const planner = createMaidModelBackedPlanner({ features, resolveRuntimeConfig: async () => ({ config, client: { async chat(value) { messages = value; return JSON.stringify(capturedUnsupported); } } }), logger });
  await planner('把旧东西处理一下', { capabilitySnapshot: { id: 'empty-recall', useCandidates: false, candidateFeatures: [], promptFeatures: features } });
  const details = messages.at(-1).content.match(/<app_features>([\s\S]*?)<\/app_features>/)?.[1] || '';
  assert.ok(!/writes: true/.test(details), 'registration order is not a relevance ranking');
  assert.match(details, /app\.capabilities\.search/);
});

test('no discovery for chat, knowledge questions, explicit no-lookup, cancellation or permission refusal', async () => {
  for (const input of ['今天心情不错，陪我聊聊', '猫娘是什么，解释一下', '建个群，但不要查询联系人', '不需要查，直接告诉我如何建群', '取消删除世界书', '不想删了，先保留', '不要调用工具，解释群聊是什么']) {
    const replayed = await replay({ input });
    assert.deepEqual(replayed.executed, [], input);
  }
  assert.deepEqual((await replay({ input: '把旧世界书删了', initial: { ok: false, reason: 'permission_denied', message: '用户已拒绝许可。' } })).executed, []);
  assert.deepEqual((await replay({ input: '把旧世界书删了', denySearch: true })).executed, []);
  assert.deepEqual((await replay({ input: '把旧世界书删了', missingSearch: true })).executed, []);
  assert.deepEqual((await replay({ input: '建个群', native: true, control: { action: 'unsupported', message: '用户拒绝许可。', reason: 'permission_denied' } })).executed, []);
  assert.deepEqual((await replay({ input: '把旧世界书删了', abort: true })).executed, []);
});

test('failed public lookup is attempted once and existing task evidence prevents another recovery', async () => {
  const replayed = await replay({ input: '把旧世界书删了', failSearch: true });
  assert.deepEqual(replayed.executed.map(tool => tool.name), ['app.search_feature']);
  assert.ok(replayed.calls.length <= 2);
  for (const context of [{ maidDiscoveryRecovery: {} }, { maidReactSteps: [{ toolName: 'worldbook.list', status: 'succeeded' }] }, { runContinuation: { successfulSteps: [] } }]) {
    assert.equal(shouldRecoverMaidAppDiscovery({ input: '把旧世界书删了', decision: capturedUnsupported, context }), false);
  }
});
