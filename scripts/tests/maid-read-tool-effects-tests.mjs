import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { listAppFeatures, findAppFeature } from '../../src/scripts/agent/app-feature-catalog.js';
import { createAppGuidedActionRuntime } from '../../src/scripts/ui/app-guided-action-runtime-utils.js';
import { fingerprintMaidToolCall } from '../../src/scripts/agent/maid-run-continuation.js';

const logger = { debug() {}, warn() {} };
const replay = async ({ featureId, toolName, forceGuide = false, continuation = null }) => {
  const calls = [], guides = [], completedGuides = [];
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow' }) } });
  for (const name of ['session.list', 'worldbook.list', 'group.create']) {
    registry.register({ name, capabilities: { read: true, write: name === 'group.create' },
      schema: { type: 'object', additionalProperties: true },
      execute: async args => {
        calls.push({ name, args });
        return { ok: true, sessionId: 'group:existing',
          sessions: [{ id: 'group:existing', name: 'Existing' }], worldbooks: [{ id: 'Atlas', name: 'Atlas' }] };
      },
    });
  }
  const routing = createMaidCapabilityRoutingRuntime({ features: listAppFeatures(), toolRegistry: registry, logger });
  // Preserve the captured feature/tool pair instead of letting recall correct it.
  routing.setConfig({ mode: 'shadow' });
  const guidedActionRuntime = createAppGuidedActionRuntime({
    getFeature: id => ({ ...findAppFeature(id), firstRunGuide: `test:${id}` }),
    guideStore: { isCompleted: () => false, markCompleted: id => { completedGuides.push(id); } },
    showGuide: async guide => { guides.push(guide.featureId); },
  });
  const agent = createMaidAssistantAgent({ toolRegistry: registry, capabilityRoutingRuntime: routing, guidedActionRuntime,
    planner: async () => ({ ok: true, toolName, featureId, args: {}, forceGuide }),
    reactPlanner: async () => ({ ok: true, action: 'final', message: 'Observed.' }), logger,
  });
  const result = await agent.runPrompt('Please create a group after checking the existing contacts.', { runContinuation: continuation });
  return { calls, guides, completedGuides, result };
};

for (const [toolName, featureId] of [['session.list', 'session.create'], ['worldbook.list', 'worldbook.bind_persona']]) {
  test(`${toolName} borrowed by ${featureId} neither verifies a write nor starts its automatic tutorial`, async () => {
    const { calls, guides, completedGuides, result } = await replay({ toolName, featureId });
    assert.deepEqual(calls.map(call => call.name), [toolName], 'a read must not inherit a write verification');
    assert.deepEqual(guides, [], 'a read must not teach creating or binding');
    assert.deepEqual(completedGuides, [], 'reading does not complete a write tutorial');
    assert.equal(result.steps.some(step => step.metadata?.verificationFor), false);
  });
}

test('a real write still gets one readback and its normal first-run tutorial', async () => {
  const { calls, guides, result } = await replay({ toolName: 'group.create', featureId: 'group.create' });
  assert.deepEqual(calls.map(call => call.name), ['group.create', 'session.list']);
  assert.deepEqual(guides, ['group.create']);
  assert.equal(result.steps[1].metadata.verificationFor, 'group.create');
});

test('a read feature can retain its own tutorial without a write verification', async () => {
  const { calls, guides } = await replay({ toolName: 'session.list', featureId: 'session.list' });
  assert.deepEqual(calls.map(call => call.name), ['session.list']);
  assert.deepEqual(guides, ['session.list']);
});

test('forceGuide cannot mark a write tutorial complete after an auxiliary read', async () => {
  const { calls, guides, completedGuides } = await replay({ toolName: 'session.list', featureId: 'session.create', forceGuide: true });
  assert.deepEqual(calls.map(call => call.name), ['session.list']);
  assert.deepEqual(guides, []);
  assert.deepEqual(completedGuides, []);
});

const continuationFor = toolName => ({
  version: 'maid-run-continuation-v1', sourceRunId: 'previous-run', goal: 'Create a group after reading contacts',
  successfulSteps: [{ toolName, argsDigest: fingerprintMaidToolCall(toolName, {}),
    result: { ok: true, sessionId: 'group:existing' },
    resourceRefs: [{ kind: 'session', id: 'group:existing', name: 'Existing' }], verification: 'readback' }],
  remainingTodos: [],
});

test('a resumed read is not mistaken for a prior write needing verification', async () => {
  const { result, calls, guides } = await replay({ toolName: 'session.list', featureId: 'session.create', continuation: continuationFor('session.list') });
  assert.deepEqual(calls.map(call => call.name), ['session.list']);
  assert.equal(result.steps.some(step => step.metadata?.verificationFor), false);
  assert.deepEqual(guides, []);
});

test('a resumed successful write is still verified instead of replayed', async () => {
  const { result, calls, guides } = await replay({ toolName: 'group.create', featureId: 'group.create', continuation: continuationFor('group.create') });
  assert.deepEqual(calls.map(call => call.name), ['session.list']);
  assert.equal(result.steps[0].metadata.verificationFor, 'group.create');
  assert.deepEqual(guides, []);
});
