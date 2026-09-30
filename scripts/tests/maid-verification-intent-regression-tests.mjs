import assert from 'node:assert/strict';
import test from 'node:test';
import { listAppFeatures, findAppFeature } from '../../src/scripts/agent/app-feature-catalog.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { createAppGuidedActionRuntime } from '../../src/scripts/ui/app-guided-action-runtime-utils.js';
import { createMaidCommandSubmit } from '../../src/scripts/ui/maid-command-submit-runtime.js';
import { matchMaidIntent } from '../../src/scripts/ui/maid-intent-presets.js';

const logger = { debug() {}, warn() {} };
const createHarness = () => {
  const calls = [], guides = [];
  let readDenied = false;
  const permissions = { evaluateTool: ({ name } = {}) => ({
    decision: readDenied && name === 'session.list' ? 'deny' : 'allow', checks: [],
  }) };
  const registry = createAgentToolRegistry({ permissionEvaluator: permissions, logger });
  for (const name of ['group.create', 'session.create', 'session.list', 'worldbook.generate_entries', 'worldbook.read']) {
    registry.register({ name, schema: { type: 'object', properties: {}, additionalProperties: true }, riskLevel: 'low',
      capabilities: { write: ['group.create', 'session.create', 'worldbook.generate_entries'].includes(name) },
      execute: async args => {
        calls.push({ name, args });
        if (name === 'group.create') return { ok: true, sessionId: 'group:test', name: '测试群', verified: true };
        if (name === 'worldbook.generate_entries') return { ok: true, worldbookId: '测试世界书', entryCount: 1 };
        return { ok: true, sessions: [{ id: 'group:test', name: '测试群' }], worldbookId: '测试世界书', entries: [{ title: '城市' }] };
      },
    });
  }
  const routing = createMaidCapabilityRoutingRuntime({ features: listAppFeatures(), toolRegistry: registry,
    permissionEvaluator: permissions, logger });
  routing.setConfig({ mode: 'bounded' });
  const guided = createAppGuidedActionRuntime({
    // A read feature can have its own tutorial; internal verification still must not display it.
    getFeature: id => ({ ...findAppFeature(id), firstRunGuide: `test:${id}` }),
    guideStore: { isCompleted: () => false, markCompleted() {} },
    showGuide: async guide => { guides.push(guide.featureId); },
  });
  return { calls, guides, registry, routing, guided, denyReads() { readDenied = true; } };
};

for (const scenario of [
  { input: '创建群聊测试群', featureId: 'group.create', toolName: 'group.create', args: { name: '测试群', memberIds: ['a', 'b'] }, readFeature: 'session.list', readTool: 'session.list' },
  { input: '生成世界书测试世界书', featureId: 'worldbook.create', toolName: 'worldbook.generate_entries', args: { name: '测试世界书', outline: '城市' }, readFeature: 'worldbook.read', readTool: 'worldbook.read' },
]) {
  test(`${scenario.toolName} verifies through its explicit read feature without a tutorial`, async () => {
    const harness = createHarness();
    const agent = createMaidAssistantAgent({
      toolRegistry: harness.registry, capabilityRoutingRuntime: harness.routing, guidedActionRuntime: harness.guided,
      planner: async () => ({ ok: true, ...scenario, title: '创建', response: '开始创建。' }),
      reactPlanner: async () => ({ ok: true, action: 'final', message: '已完成。' }), logger,
    });
    const result = await agent.runPrompt(scenario.input);
    assert.deepEqual(harness.calls.map(call => call.name), [scenario.toolName, scenario.readTool]);
    const verification = result.steps.find(step => step.metadata?.verificationFor === scenario.toolName);
    assert.equal(verification?.status, 'succeeded');
    assert.equal(verification.featureId, scenario.readFeature);
    assert.match(verification.candidateSnapshotId, /^cap-verify:/);
    assert.equal(verification.guided, false);
    assert.deepEqual(harness.guides, [scenario.featureId]);
  });
}

test('verification cannot acquire write capabilities and still honors read permission changes', () => {
  const harness = createHarness();
  const request = harness.routing.beginRequest({ input: '创建群聊测试群' });
  const snapshot = harness.routing.prepareDecision({ requestId: request.id, input: '创建群聊测试群' });
  const parentPlan = harness.routing.observeDecision(snapshot, { ok: true, featureId: 'group.create', toolName: 'group.create', args: {} });
  const readPlan = harness.routing.authorizeVerification({ parentPlan,
    verificationPlan: { ok: true, featureId: 'session.list', toolName: 'session.list', args: {} } });
  assert.equal(harness.routing.validatePlan(readPlan).ok, true);
  const writePlan = harness.routing.authorizeVerification({ parentPlan,
    verificationPlan: { ok: true, featureId: 'group.create', toolName: 'group.create', args: {} } });
  assert.equal(harness.routing.validatePlan(writePlan).ok, false, 'verification cannot expand its parent write scope');
  harness.denyReads();
  assert.equal(harness.routing.validatePlan(readPlan).ok, false, 'permission changes must invalidate a projected read');
});

test('401 log reaches the agent while an explicit API tutorial keeps the local onboarding path', async () => {
  const received = [], flows = [];
  let exchange = {};
  const submit = createMaidCommandSubmit({
    getVoiceRuntime: () => null,
    getOnboardingRuntime: () => ({ startFlow: id => flows.push(id) }),
    matchMaidIntent, hasConfiguredMaidProfile: () => true,
    resolveMaidRuntimeConfig: async () => ({ configured: true }), logger,
    checkMaidVisionInput: async () => ({ ok: true }),
    maidSettingsStore: { setLastExchange: value => { exchange = value; }, getLastExchange: () => exchange },
    buildAppFeatureSearchContextText: () => '', getAppContext: () => ({}),
    maidAssistantAgent: { runPrompt: async input => { received.push(input); return { ok: true, responseType: 'chat', message: '诊断响应' }; } },
    recordMaidTurnFromResult: async () => {},
  });
  const input = '怎么又报错了烦死了\nError: 401 Unauthorized {"error":{"message":"Invalid API key"}}';
  const answer = await submit(input);
  assert.equal(answer.responseType, 'chat');
  assert.deepEqual(received, [input]);
  assert.deepEqual(flows, []);
  const lesson = await submit('教我配置 API');
  assert.equal(lesson.responseType, 'local');
  assert.deepEqual(flows, ['setup-api']);
  assert.equal(received.length, 1);
});
