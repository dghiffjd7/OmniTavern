// 计划确认卡（ROADMAP 29-⑨）：先看再给计划（规划中只放行只读工具、写入由工具层挡下）、计划卡、开始做后免确认
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { listAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');
const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { createAppNavigationAgentTools } = await import('../../src/scripts/agent/tools/app-navigation-tools.js');
const { createMaidCapabilityRoutingRuntime } = await import('../../src/scripts/agent/maid-capability-routing.js');
const { createMaidAssistantAgent } = await import('../../src/scripts/agent/maid-assistant-agent.js');
const { createMaidModelBackedPlanner, createMaidModelBackedReActPlanner } = await import('../../src/scripts/agent/maid-model-planner.js');
const { MAID_PROVIDER_FC_CONTROL_TOOL_NAME } = await import('../../src/scripts/agent/maid-provider-fc-planner.js');
const { buildMaidPlanCard, collectMaidResultCardsFromResult, isCatalogWriteTool, summarizeMaidPlanCard } = await import('../../src/scripts/agent/maid-result-cards.js');
const { renderMaidResultCard } = await import('../../src/scripts/ui/maid-result-card-dom.js');
const { MaidConversationStore } = await import('../../src/scripts/storage/maid-conversation-store.js');
const { isPreApprovedByPlan } = await import('../../src/scripts/ui/maid-command-submit-runtime.js');

const features = listAppFeatures();
const isWriteTool = name => isCatalogWriteTool(features, name);
const aWriteTool = 'worldbook.update_entries';
assert.equal(isWriteTool(aWriteTool), true);
assert.equal(isWriteTool('worldbook.read'), false, 'a read tool listed by a writing feature is still a read tool');

test('plan card: title, goal and steps required; only real write tools are kept; collected after tool cards; remembered in history', async () => {
  const card = buildMaidPlanCard({
    title: '整理雾港来信', goal: '把三个条目改短', steps: ['读取三个条目', '逐条改短', '读回核对'],
    changes: ['修改条目「灯塔邮局」「雾港」「雾灵」'], tools: [aWriteTool, 'worldbook.read_not_a_write', 'not a tool!'],
  }, { id: 'plan-1', createdAt: 3, isWriteTool });
  assert.equal(card.type, 'plan');
  assert.deepEqual(card.data.tools, [aWriteTool]);
  assert.equal(buildMaidPlanCard({ title: '没有步骤', goal: 'x', steps: [] }, { isWriteTool }), null, 'no steps, no card (the text stays)');
  assert.deepEqual(collectMaidResultCardsFromResult({ finalDecision: { planCard: card } }).map(item => item.id), ['plan-1']);
  assert.match(summarizeMaidPlanCard(card), /^「整理雾港来信」把三个条目改短 ｜ 步骤：1\. 读取三个条目；2\. 逐条改短；3\. 读回核对 ｜ 会改动：/);

  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {} });
  await store.load();
  await store.appendTurn({ input: '把雾港来信整理一下', message: '我先列了计划', status: 'responded', cards: [card] });
  assert.match(store.getContextSnapshot().historyText, /给用户的计划: 「整理雾港来信」把三个条目改短/);
});

test('plan card buttons: start and drop lock the card once sent, revise does not; read-only in history', async () => {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.innerHTML = '';
      this.disabled = false; this.dataset = {}; this.attributes = {}; this.listeners = new Map();
      const set = new Set();
      this.classList = { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
    async click() { await Promise.all((this.listeners.get('click') || []).map(handler => handler({ preventDefault() {}, stopPropagation() {} }))); await new Promise(r => setTimeout(r, 0)); }
  }
  const doc = { head: new El('head'), createElement: tag => new El(tag), getElementById: () => null };
  const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
  const card = buildMaidPlanCard({ title: 'T', goal: 'G', steps: ['a'], tools: [aWriteTool] }, { id: 'p', isWriteTool });
  const actions = [];
  const el = renderMaidResultCard(doc, card, { onAction: async (payload) => { actions.push(payload.action); return payload.action === 'revise' ? null : { answered: true }; } });
  const button = id => walk(el).find(node => node.dataset?.action === id);
  await button('revise').click();
  assert.equal(el.classList.contains('is-answered'), false, 'revise only hands the input bar to the user');
  assert.equal(button('start').disabled, false);
  await button('start').click();
  assert.equal(el.classList.contains('is-answered'), true);
  assert.equal(button('drop').disabled, true);
  await button('drop').click();
  assert.deepEqual(actions, ['revise', 'start'], 'no second action after start');
  const history = renderMaidResultCard(doc, card, { onAction: async () => ({ answered: true }), answerable: false });
  assert.equal(walk(history).some(node => node.tagName === 'BUTTON'), false);
});

test('after start, only the planned non-delete writes skip confirmation', () => {
  const plan = { tools: ['worldbook.update_entries'] };
  assert.equal(isPreApprovedByPlan(plan, { toolName: 'worldbook.update_entries', operationType: 'write' }), true);
  assert.equal(isPreApprovedByPlan(plan, { toolName: 'worldbook.create', operationType: 'write' }), false, 'not in the plan');
  assert.equal(isPreApprovedByPlan(plan, { toolName: 'worldbook.update_entries', operationType: 'delete' }), false, 'deletes still ask');
  assert.equal(isPreApprovedByPlan(plan, { toolName: 'worldbook.update_entries', escalation: 'read_only_write' }), false, 'read-only escalation still asks');
  assert.equal(isPreApprovedByPlan(null, { toolName: 'worldbook.update_entries' }), false);
});

test('planning mode refuses writes at the tool layer without asking, reads still run', async () => {
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) }, logger: { warn() {}, debug() {} } });
  let wrote = 0;
  registry.register({ name: 'demo.write', capabilities: { write: true }, safety: { declared: true }, schema: { type: 'object', properties: {} }, execute: async () => { wrote += 1; return { ok: true }; } });
  registry.register({ name: 'demo.read', schema: { type: 'object', properties: {} }, execute: async () => ({ ok: true, value: 1 }) });
  let asked = 0;
  const context = { operationIntentPolicy: { mode: 'planning', source: 'maid_plan_first' }, requestToolConfirmation: async () => { asked += 1; return 'allow'; } };
  await assert.rejects(registry.executeTool('demo.write', {}, context), error => error.code === 'agent_tool_planning_read_only');
  assert.equal(wrote, 0);
  assert.equal(asked, 0, 'no confirmation while planning');
  const read = await registry.executeTool('demo.read', {}, context);
  assert.equal(read?.ok ?? read?.result?.ok, true);
});

test('plan_first switches the run into planning: the next decision sees only read-only tools and hands in a plan card', async () => {
  const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
  const logger = { warn() {}, debug() {} };
  const permissionEvaluator = { evaluateTool: () => ({ decision: 'allow', checks: [] }) };
  const registry = createAgentToolRegistry({ permissionEvaluator, logger });
  const navigation = createAppNavigationAgentTools();
  for (const tool of navigation) registry.register(tool);
  const registered = new Set(navigation.map(tool => tool.name));
  for (const feature of features) for (const name of feature.tools || []) {
    if (registered.has(name)) continue;
    registered.add(name);
    registry.register({ name, riskLevel: feature.riskLevel, schema: { type: 'object', properties: {} }, execute: async () => { throw new Error(`Unexpected business operation: ${name}`); } });
  }
  const routing = createMaidCapabilityRoutingRuntime({ features, toolRegistry: registry, permissionEvaluator, logger });
  const offered = [];
  const replies = [
    { action: 'plan_first', message: '我先看一下现有的设置。' },
    { action: 'plan', message: '计划在这里，确认后我就开始。', plan: { title: '整理雾港来信', goal: '把几个条目统一改短', steps: ['读取现状', '逐项修改', '读回核对'], changes: ['修改几个条目'], tools: ['worldbook.update_entries'] } },
  ];
  const client = { async chat(_messages, options) {
    const tools = (options.tools || []).map(tool => tool.function || tool);
    const control = tools.find(tool => tool.name === MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
    offered.push({ names: tools.map(tool => tool.name).filter(name => name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME), actions: control?.parameters?.properties?.action?.enum || [], planDescription: control?.parameters?.properties?.plan?.description || '' });
    const decision = replies[Math.min(offered.length - 1, replies.length - 1)];
    options.onProviderToolCallDelta({ output: [{ type: 'function_call', id: `c${offered.length}`, call_id: `c${offered.length}`, name: MAID_PROVIDER_FC_CONTROL_TOOL_NAME, arguments: JSON.stringify(decision) }] }, { provider: config.provider, model: config.model });
    return '';
  } };
  const deps = { features, resolveRuntimeConfig: async () => ({ config, client }), getProviderFcExperimentStatus: () => ({ enabled: true }), logger };
  const seen = [];
  const reactPlanner = createMaidModelBackedReActPlanner(deps);
  const agent = createMaidAssistantAgent({
    toolRegistry: registry, capabilityRoutingRuntime: routing,
    planner: createMaidModelBackedPlanner(deps),
    reactPlanner: async (input, context) => { seen.push(context.operationIntentPolicy?.mode); return reactPlanner(input, context); },
    getCapabilityRoutingConfigOverride: () => ({ mode: 'bounded' }),
    chatResponder: async (_input, _context, { plan }) => ({ ok: true, message: plan.message }),
    maxReactSteps: 4, logger,
  });
  const result = await agent.runPrompt('把世界书《雾港来信》里的几个条目统一改短一点', { uiMode: 'chat' });
  assert.equal(offered.length, 2);
  assert.ok(offered[0].actions.includes('plan_first'), 'plan_first is offered at the start');
  assert.deepEqual(seen, ['planning'], 'the follow-up decision runs in planning mode');
  assert.equal(offered[1].actions.includes('plan_first'), false, 'no second plan_first while planning');
  assert.equal(offered[1].names.some(name => isWriteTool(name)), false, 'write tools are not offered while planning');
  assert.equal(result.finalDecision.providerFcControl, 'plan');
  assert.equal(result.message, '计划在这里，确认后我就开始。');
  assert.deepEqual(result.finalDecision.planCard.data.steps, ['读取现状', '逐项修改', '读回核对']);
  assert.deepEqual(result.finalDecision.planCard.data.tools, ['worldbook.update_entries'], 'internal write tool names survive');
  const listed = (offered[1].planDescription.match(/choose from: ([^)]*)/) || [])[1]?.split(', ') || [];
  assert.ok(listed.length > 0, 'while planning, the write tools to choose from are named in the plan description');
  assert.equal(listed.every(isWriteTool), true, `only real write tools are listed: ${listed.join(', ')}`);
  assert.deepEqual(collectMaidResultCardsFromResult(result).map(card => card.type), ['plan']);
});
