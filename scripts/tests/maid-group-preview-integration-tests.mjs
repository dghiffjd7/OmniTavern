import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createGroupChatAgentTools } from '../../src/scripts/agent/tools/group-chat-agent-tools.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';

const original = '建个群叫远足小队，成员阿凯和Luna；先给我看清单，先别创建。';
const correction = '好，但是名字改成周末公会';
const plan = (name = '远足小队', preview = true) => ({ ok: true, action: 'tool', featureId: 'group.create',
  toolName: 'group.create', args: { name, members: ['friend:a', 'friend:b'], preview, open: false } });
const harness = async () => {
  const current = { roleCardId: 'test-card', sessionId: 'existing-chat', uiMode: 'chat' };
  const contacts = new Map([['friend:a', { id: 'friend:a', name: '阿凯' }], ['friend:b', { id: 'friend:b', name: 'Luna' }]]);
  const writes = [], approvals = [], plannerCalls = [], reactCalls = [], opened = [];
  const contactsStore = { scopeId: 'test-card', _scopeToken: 0, ready: Promise.resolve(),
    listContacts: () => [...contacts.values()], getContact: id => contacts.get(id),
    upsertContact: record => { writes.push(structuredClone(record)); contacts.set(record.id, record); } };
  const chatStore = { scopeId: 'test-card', _scopeToken: 0, ready: Promise.resolve(), appendMessage() {}, switchSession: id => opened.push(id) };
  const getCurrentContext = () => ({ ...current, contactsScopeId: contactsStore.scopeId, chatScopeId: chatStore.scopeId,
    contactsScopeToken: contactsStore._scopeToken, chatScopeToken: chatStore._scopeToken });
  const registry = createAgentToolRegistry({ logger: { warn() {} } });
  let next = plan(), groupId = 0, submission = 0;
  registry.registerMany(createGroupChatAgentTools({ contactsStore, chatStore,
    getCurrentContext: () => ({ ...current, scopeId: 'test-card' }),
    createGroupId: () => `group:${++groupId}`, refreshChatAndContacts: async () => {},
  }));
  const store = new AgentRunStore(); await store.ready;
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const agent = createMaidAssistantAgent({ toolRegistry: registry, agentTaskRuntime: runtime, getCurrentContext,
    planner: async (input, context) => { plannerCalls.push({ input, context }); return structuredClone(next); },
    reactPlanner: async (input, context) => { reactCalls.push({ input, context }); return { ok: true, action: 'final', message: '模型原始回复' }; },
    logger: { debug() {}, warn() {} },
  });
  const submit = (input, extra = {}) => agent.runPrompt(input, { ...current, source: 'maid_text',
    submissionId: `submission-${++submission}`, requestToolConfirmation: request => { approvals.push(request); return true; }, ...extra });
  const runs = () => store.listRuns({ kind: 'maid_assistant', limit: 100 });
  return { submit, runs, store, writes, approvals, plannerCalls, reactCalls, opened, current, contactsStore,
    setPlan: value => { next = value; } };
};

test('explicit group preview persists a real waiting workflow without approval or writes', async () => {
  const h = await harness(); const preview = await h.submit(original);
  assert.equal(preview.status, 'awaiting_confirmation');
  assert.equal(preview.pendingWorkflow?.state, 'pending');
  assert.match(preview.message, /远足小队/); assert.match(preview.message, /阿凯/); assert.match(preview.message, /Luna/);
  assert.equal(h.runs()[0].status, 'waiting_permission');
  assert.equal(h.runs()[0].metadata.pendingWorkflow.state, 'pending');
  assert.equal(h.approvals.length, 0); assert.equal(h.writes.length, 0);
});

test('revision invalidates the old preview, stays preview-only, then exact confirmation reaches APP approval', async () => {
  const h = await harness(); await h.submit(original); const firstId = h.runs()[0].id;
  // Simulate a model forgetting preview=true. The application must keep the revised task read-only.
  h.setPlan(plan('周末公会', false)); const revised = await h.submit(correction);
  assert.equal(revised.status, 'awaiting_confirmation');
  assert.equal(h.runs().find(run => run.id === firstId).metadata.pendingWorkflow.state, 'superseded');
  assert(h.plannerCalls.at(-1).input.includes(original)); assert(h.plannerCalls.at(-1).input.includes(correction));
  assert.match(revised.message, /周末公会/); assert.equal(h.writes.length, 0); assert.equal(h.approvals.length, 0);
  assert.equal(revised.steps.find(step => step.toolName === 'group.create').args.preview, true);
  const plannerCount = h.plannerCalls.length;
  await h.submit('确认，按周末公会这个名字建。');
  assert.equal(h.plannerCalls.length, plannerCount, 'confirmation consumes frozen args without replanning');
  assert.equal(h.approvals.length, 1); assert.equal(h.approvals[0].details.groupName, '周末公会');
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].name, '周末公会');
  assert.deepEqual(h.writes[0].members, ['friend:a', 'friend:b']);
});

test('bare cancellation closes the actual pending run and performs no planner or tool action', async () => {
  const h = await harness(); await h.submit(original); const id = h.runs()[0].id, calls = h.plannerCalls.length;
  const cancelled = await h.submit('不要');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(h.plannerCalls.length, calls);
  const pending = h.runs().find(run => run.id === id);
  assert.equal(pending.status, 'cancelled'); assert.equal(pending.metadata.pendingWorkflow.state, 'cancelled');
  assert.equal(h.writes.length, 0); assert.equal(h.approvals.length, 0);
});

test('ordinary creation still uses one APP approval and creates without a text preview', async () => {
  const h = await harness(); h.setPlan(plan('普通群', false));
  const result = await h.submit('创建普通群，成员阿凯和Luna');
  assert.equal(result.status, 'succeeded'); assert.equal(result.pendingWorkflow, undefined);
  assert.equal(h.approvals.length, 1); assert.equal(h.writes.length, 1);
});

test('an old preview cannot authorize creation after the actual current session changes', async () => {
  const h = await harness(); await h.submit(original);
  h.current.sessionId = 'different-chat';
  h.setPlan({ ok: true, action: 'final', source: 'maid_provider_fc', message: '请重新说明要创建的群' });
  await h.submit('确认，按远足小队这个名字建。');
  assert.equal(h.writes.length, 0); assert.equal(h.approvals.length, 0);
});

test('the request to open the group survives preview and a short confirmation', async () => {
  const h = await harness();
  await h.submit(original + '确认创建完成后打开给我看。');
  assert.equal(h.opened.length, 0);
  await h.submit('确认');
  assert.equal(h.writes.length, 1); assert.deepEqual(h.opened, [h.writes[0].id]);
});

test('preview-only cannot execute an unrelated write selected by the planner', async () => {
  const h = await harness();
  h.setPlan({ ok: true, action: 'tool', toolName: 'group.update_members', featureId: 'group.members.update',
    args: { group: 'existing-group', addMembers: ['friend:a'] } });
  const result = await h.submit(original);
  assert.equal(result.reason, 'group_preview_write_blocked');
  assert.equal(h.approvals.length, 0); assert.equal(h.writes.length, 0);
});

test('expired group preview closes its waiting run and cannot create', async () => {
  const h = await harness(); await h.submit(original); const pending = h.runs()[0];
  h.store.updateRun(pending.id, { metadata: { ...pending.metadata, pendingWorkflow: {
    ...pending.metadata.pendingWorkflow, createdAt: Date.now() - 1800001, expiresAt: Date.now() - 1,
  } } });
  h.setPlan({ ok: true, action: 'final', source: 'maid_provider_fc', message: '请重新预览' });
  await h.submit('确认');
  assert.equal(h.runs().find(run => run.id === pending.id).status, 'cancelled');
  assert.equal(h.writes.length, 0); assert.equal(h.approvals.length, 0);
});

test('captured native preview respects the explicit bare negative 不打开', async () => {
  const h = await harness();
  const result = await h.submit('先给我看建群清单：群名远足小队，成员阿凯和Luna，先不创建，也不打开群聊。');
  assert.equal(result.pendingWorkflow.open, false);
  assert.equal(result.steps.find(step => step.toolName === 'group.create').args.open, false);
  assert.equal(h.opened.length, 0);
});
