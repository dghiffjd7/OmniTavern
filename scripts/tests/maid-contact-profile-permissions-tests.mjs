import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createMaidCommandSubmit } from '../../src/scripts/ui/maid-command-submit-runtime.js';
import { createContactProfileAgentTools, MAID_CONTACT_PROFILE_PERMISSION_RULES } from '../../src/scripts/agent/tools/contact-profile-tools.js';

const localState = new Map();
globalThis.localStorage = {
  getItem: key => localState.get(String(key)) ?? null,
  setItem: (key, value) => localState.set(String(key), String(value)),
  removeItem: key => localState.delete(String(key)),
};
globalThis.__TAURI_INVOKE__ = async command => (command === 'load_kv' ? null : true);
const { ContactProfileStore } = await import('../../src/scripts/storage/contact-profile-store.js');
const logger = { warn() {}, debug() {} };
const makeEvaluator = extra => createAgentPermissionEvaluator({ defaultDecision: 'ask', rules: [...MAID_CONTACT_PROFILE_PERMISSION_RULES, ...(extra || [])] });

test('APP installs only four exact maid-scoped storage defaults and explicit rules win', () => {
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /createAgentPermissionEvaluator\(\{\s*defaultDecision: 'ask',\s*rules: MAID_CONTACT_PROFILE_PERMISSION_RULES,/);
  assert.equal((app.match(/getAppContext: \(\) => \(\{ sessionId: chatStore\.getCurrent\(\), roleCardId: String\(personaStore\.getActive\?\.\(\)\?\.id \|\| ''\), agentId: 'maid-assistant'/g) || []).length, 3);
  assert.match(app, /const maidTurnContext = \{\s*sessionId: opts.sessionId \|\| chatStore.getCurrent\(\),\s*roleCardId: String\(personaStore.getActive\?\.\(\)\?\.id \|\| ''\),\s*agentId: 'maid-assistant'/);
  const evaluator = makeEvaluator();
  assert.equal(evaluator.getRules().length, 4);
  for (const tool of createContactProfileAgentTools()) {
    assert.deepEqual(tool.permissions, ['storage']);
    assert.equal(evaluator.evaluateTool(tool, { source: 'maid-assistant' }).decision, 'allow');
    assert.equal(evaluator.evaluateTool(tool, { source: 'provider-tool-experiment' }).decision, 'ask');
    assert.equal(evaluator.evaluateTool({ ...tool, permissions: ['storage', 'network'] }, { source: 'maid-assistant' }).decision, 'ask');
    for (const layer of ['default', 'agent', 'session', 'roleCard', 'global']) {
      const restricted = makeEvaluator([{ layer, toolName: tool.name, permission: 'storage', decision: 'deny' }]);
      assert.equal(restricted.evaluateTool(tool, { source: 'maid-assistant' }).decision, 'deny');
    }
  }
  assert.equal(evaluator.evaluateTool({ name: 'other.read', permissions: ['storage'] }, { source: 'maid-assistant' }).decision, 'ask');
  assert.equal(evaluator.evaluateTool({ name: 'contact_profile.delete', permissions: ['storage'] }, { source: 'maid-assistant' }).decision, 'ask');
});

const runProfileTask = async ({ decision = 'allow', denied = false, concurrentEdit = false, switchScope = false, key }) => {
  const store = new ContactProfileStore({ scopeId: `role-card-${key}` });
  await store.ready;
  const personaStore = { getActive: () => ({ id: `role-card-${key}` }) };
  const permissionEvaluator = makeEvaluator(denied ? [{ layer: 'roleCard', roleCardId: personaStore.getActive().id, toolName: 'contact_profile.upsert', permission: 'storage', decision: 'deny' }] : []);
  const registry = createAgentToolRegistry({ permissionEvaluator, logger });
  registry.registerMany(createContactProfileAgentTools({
    contactProfileStore: store,
    getMaidScopeContext: () => ({ roleCardId: personaStore.getActive().id, scopeId: `role-card-${key}` }),
  }));
  const events = [], confirmations = [];
  const runtime = createAgentTaskRuntime({ toolRegistry: registry, logger });
  runtime.onEvent(event => events.push(event));
  const routing = createMaidCapabilityRoutingRuntime({ features: listAppFeatures(), toolRegistry: registry, permissionEvaluator, logger });
  routing.setConfig({ mode: 'bounded' });
  const profile = { contactId: 'contact-known-id', displayName: '测试联系人', stable_traits: [{ label: '用户给定的爱好', sourceRefs: ['user_request'] }] };
  let phase = 0;
  const agent = createMaidAssistantAgent({
    toolRegistry: registry, agentTaskRuntime: runtime, capabilityRoutingRuntime: routing, logger,
    planner: async () => ({ ok: true, featureId: 'contact_profile.read', toolName: 'contact_profile.read', args: { contactId: profile.contactId }, title: '读取联系人档案' }),
    reactPlanner: async () => ++phase === 1
      ? { ok: true, action: 'tool', featureId: 'contact_profile.upsert', toolName: 'contact_profile.upsert', args: { profile }, title: '保存联系人档案' }
      : { ok: true, action: 'final', message: '操作结束。' },
  });
  const requestMaidToolConfirmation = async request => {
      confirmations.push(request);
      assert.equal(request.toolName, 'contact_profile.upsert');
      assert.equal(request.argsPreview.contactId, profile.contactId);
      assert.equal(request.argsPreview.scopeId, store.scopeId);
      if (concurrentEdit) store.upsertProfile({ ...profile, stable_traits: [{ label: '用户在确认期间的新修改' }] });
      if (switchScope) await store.setScope(`${store.scopeId}-other-card`);
      return { decision };
  };
  const submit = createMaidCommandSubmit({
    getVoiceRuntime: () => null, getOnboardingRuntime: () => null,
    matchMaidIntent: () => null, hasConfiguredMaidProfile: () => true,
    resolveMaidRuntimeConfig: async () => ({ configured: true }), logger,
    checkMaidVisionInput: async () => ({ ok: true }),
    maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({}) },
    buildAppFeatureSearchContextText: () => '',
    getAppContext: () => ({ sessionId: '', roleCardId: String(personaStore.getActive?.()?.id || ''), agentId: 'maid-assistant' }),
    maidAssistantAgent: agent, requestMaidToolConfirmation,
    recordMaidTurnFromResult: async () => {},
  });
  const result = await submit('保存联系人的人设资料和爱好', { context: { roleCardId: 'untrusted-other-card', agentId: 'untrusted-agent' } });
  await store.whenPersisted();
  return { store, result, confirmations, events, profile };
};

test('real maid runtime reads without a generic storage prompt and confirms each profile write', async () => {
  const allowed = await runProfileTask({ key: 'allow' });
  assert.equal(allowed.result.steps[0].toolName, 'contact_profile.read');
  assert.equal(allowed.result.steps[0].status, 'succeeded');
  assert.equal(allowed.confirmations.length, 1);
  assert.equal(allowed.store.getProfile(allowed.profile.contactId).stable_traits[0].label, '用户给定的爱好');
  const verify = allowed.result.steps.find(step => step.metadata?.verificationFor === 'contact_profile.upsert');
  assert.equal(verify?.toolName, 'contact_profile.read');
  assert.equal(verify?.status, 'succeeded');
  assert.ok(allowed.events.some(event => event.source === 'maid-assistant'));

  const refused = await runProfileTask({ key: 'refused', decision: 'deny' });
  assert.equal(refused.confirmations.length, 1);
  assert.equal(refused.store.getProfile(refused.profile.contactId), null);
});

test('explicit storage denial and concurrent edits still prevent maid profile writes', async () => {
  const denied = await runProfileTask({ key: 'denied', denied: true });
  assert.equal(denied.confirmations.length, 0, 'explicit permission denial must precede safety approval');
  assert.equal(denied.store.getProfile(denied.profile.contactId), null);
  assert.ok(denied.result.steps.some(step => step.status === 'failed'));

  const changed = await runProfileTask({ key: 'changed', concurrentEdit: true });
  assert.equal(changed.confirmations.length, 1);
  assert.equal(changed.store.getProfile(changed.profile.contactId).stable_traits[0].label, '用户在确认期间的新修改');
  assert.ok(changed.result.steps.some(step => step.output?.reason === 'profile_changed_during_operation'));

  const switched = await runProfileTask({ key: 'scope-changed', switchScope: true });
  assert.equal(switched.confirmations.length, 1);
  assert.equal(switched.store.getProfile(switched.profile.contactId), null);
  assert.ok(switched.result.steps.some(step => step.output?.reason === 'target_scope_changed'));
});
