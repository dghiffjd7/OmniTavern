import assert from 'node:assert/strict';
import test from 'node:test';
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
let interceptLoad = null;
globalThis.__TAURI_INVOKE__ = async (command, args) => command === 'load_kv' ? await interceptLoad?.(args) ?? null : true;
const { ContactProfileStore } = await import('../../src/scripts/storage/contact-profile-store.js');
const logger = { warn() {}, debug() {} };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const fixture = async (key, { shared = false, denyB = true } = {}) => {
  const cardA = `scope-${key}-A`, cardB = `scope-${key}-B`;
  let activeCard = cardA;
  const scopeFor = card => shared ? '' : card;
  const store = new ContactProfileStore({ scopeId: scopeFor(cardA) });
  await store.ready;
  const permissionEvaluator = createAgentPermissionEvaluator({ defaultDecision: 'ask', rules: [
    ...MAID_CONTACT_PROFILE_PERMISSION_RULES,
    ...(denyB ? [{ layer: 'roleCard', roleCardId: cardB, toolName: 'contact_profile.*', permission: 'storage', decision: 'deny' }] : []),
  ] });
  const registry = createAgentToolRegistry({ permissionEvaluator, logger });
  const tools = createContactProfileAgentTools({ contactProfileStore: store,
    getMaidScopeContext: () => ({ roleCardId: activeCard, scopeId: scopeFor(activeCard) }) });
  registry.registerMany(tools);
  const switchCard = async card => { activeCard = card; await store.setScope(scopeFor(card)); };
  const context = card => ({ source: 'maid-assistant', roleCardId: card, agentId: 'maid-assistant' });
  return { store, registry, tools, permissionEvaluator, cardA, cardB, switchCard, context,
    currentCard: () => activeCard, scopeFor };
};

test('real maid submit rejects a planner result after the active card changes', async () => {
  const f = await fixture('planner');
  const entered = deferred(), resume = deferred();
  const runtime = createAgentTaskRuntime({ toolRegistry: f.registry, logger });
  const routing = createMaidCapabilityRoutingRuntime({ features: listAppFeatures(), toolRegistry: f.registry, permissionEvaluator: f.permissionEvaluator, logger });
  routing.setConfig({ mode: 'bounded' });
  const agent = createMaidAssistantAgent({ toolRegistry: f.registry, agentTaskRuntime: runtime, capabilityRoutingRuntime: routing, logger,
    planner: async () => {
      entered.resolve();
      await resume.promise;
      return { ok: true, featureId: 'contact_profile.list', toolName: 'contact_profile.list', args: {}, title: '读取联系人画像' };
    },
    reactPlanner: async () => ({ ok: true, action: 'final', message: '操作结束。' }),
  });
  const submit = createMaidCommandSubmit({
    getVoiceRuntime: () => null, getOnboardingRuntime: () => null, matchMaidIntent: () => null,
    resolveMaidRuntimeConfig: async () => ({ configured: true }), logger,
    checkMaidVisionInput: async () => ({ ok: true }),
    maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({}) },
    buildAppFeatureSearchContextText: () => '',
    getAppContext: () => ({ sessionId: '', roleCardId: f.currentCard(), agentId: 'maid-assistant' }),
    maidAssistantAgent: agent, requestMaidToolConfirmation: () => assert.fail('stale task must not ask to authorize another card'),
    recordMaidTurnFromResult: async () => {},
  });
  const pending = submit('读取联系人的画像');
  await entered.promise;
  await f.switchCard(f.cardB);
  f.store.upsertProfile({ contactId: 'same-contact', displayName: 'B-private-sentinel' });
  resume.resolve();
  const result = await pending;
  assert.equal(result.steps[0].status, 'failed', 'B card deny must not be bypassed by the stale A identity');
  assert.equal(JSON.stringify(result).includes('B-private-sentinel'), false, 'no B profile may reach the old task');
});

const actions = [
  ['contact_profile.read', { contactId: 'same-contact' }],
  ['contact_profile.get', { contactId: 'same-contact' }],
  ['contact_profile.list', {}],
  ['contact_profile.upsert', { profile: { contactId: 'same-contact', displayName: 'must-not-write' } }],
];

for (const shared of [false, true]) test(`all four tools reject stale or missing maid identity (shared=${shared})`, async () => {
  const f = await fixture(`all-${shared}`, { shared, denyB: false });
  await f.switchCard(f.cardB);
  f.store.upsertProfile({ contactId: 'same-contact', displayName: 'B-private-sentinel' });
  const before = f.store.listProfiles();
  for (const [name, args] of actions) {
    for (const [identity, reason] of [
      [f.context(f.cardA), 'target_scope_changed'],
      [{ source: 'maid-assistant', agentId: 'maid-assistant' }, 'maid_identity_required'],
    ]) {
      const output = await f.registry.executeTool(name, args, { ...identity,
        requestToolConfirmation: () => assert.fail('invalid scope must fail before confirmation') });
      assert.equal(output.result.ok, false, name);
      assert.equal(output.result.reason, reason, name);
      assert.equal(JSON.stringify(output).includes('B-private-sentinel'), false, name);
    }
  }
  assert.deepEqual(f.store.listProfiles(), before);
  const current = await f.registry.executeTool('contact_profile.read', { contactId: 'same-contact' }, f.context(f.cardB));
  assert.equal(current.result.profile.displayName, 'B-private-sentinel', 'the current card remains usable');
});

test('maid scope must come from trusted APP mapping while other agents keep their contract', async () => {
  const f = await fixture('unmapped');
  const tools = createContactProfileAgentTools({ contactProfileStore: f.store });
  const read = tools.find(tool => tool.name === 'contact_profile.read');
  const denied = await read.execute({ contactId: 'same-contact' }, f.context(f.cardA));
  assert.equal(denied.reason, 'contact_profile_scope_unavailable');
  f.store.upsertProfile({ contactId: 'same-contact', displayName: 'existing-agent-profile' });
  const existing = await read.execute({ contactId: 'same-contact' }, { source: 'contact-profiler' });
  assert.equal(existing.profile.displayName, 'existing-agent-profile');
});

for (const switchDuringLoad of [false, true]) test(`read waits for actual setScope loading and rechecks identity (switch=${switchDuringLoad})`, async () => {
  const f = await fixture(`ready-${switchDuringLoad}`, { denyB: false });
  await f.switchCard(f.cardB);
  f.store.upsertProfile({ contactId: 'same-contact', displayName: 'B-loaded-sentinel' });
  await f.switchCard(f.cardA);
  const entered = deferred(), resume = deferred();
  interceptLoad = async ({ name }) => {
    if (name.endsWith(`__${f.cardB}`)) { entered.resolve(); await resume.promise; }
    return null;
  };
  try {
    const switching = f.switchCard(f.cardB);
    await entered.promise;
    let settled = false;
    const reading = f.registry.executeTool('contact_profile.read', { contactId: 'same-contact' }, f.context(f.cardB))
      .then(result => { settled = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, 'do not read reset/empty state before loading completes');
    if (switchDuringLoad) await f.switchCard(f.cardA);
    resume.resolve();
    await switching;
    const result = await reading;
    if (switchDuringLoad) {
      assert.equal(result.result.reason, 'target_scope_changed');
      assert.equal(JSON.stringify(result).includes('B-loaded-sentinel'), false);
    } else assert.equal(result.result.profile.displayName, 'B-loaded-sentinel');
  } finally { resume.resolve(); interceptLoad = null; }
});

test('upsert rechecks the confirmed card in shared mode as well as store CAS', async () => {
  const f = await fixture('confirm-shared', { shared: true, denyB: false });
  const before = f.store.getProfile('same-contact');
  const result = await f.registry.executeTool('contact_profile.upsert', { profile: { contactId: 'same-contact', displayName: 'must-not-write' } }, {
    ...f.context(f.cardA), requestToolConfirmation: async () => {
      await f.switchCard(f.cardB);
      return { decision: 'allow' };
    },
  });
  assert.equal(result.result.reason, 'target_scope_changed');
  assert.deepEqual(f.store.getProfile('same-contact'), before);
});
