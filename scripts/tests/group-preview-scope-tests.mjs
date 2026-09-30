import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createGroupChatAgentTools } from '../../src/scripts/agent/tools/group-chat-agent-tools.js';

const initialContext = { roleCardId: 'card-a', sessionId: 'chat-a', uiMode: 'chat', scopeId: 'scope-a' };
const args = { name: 'Travel team', members: ['friend:a', 'friend:b'], open: false };
const harness = ({ shared = false, getContext = true } = {}) => {
  let current = { ...initialContext, ...(shared ? { scopeId: '' } : {}) };
  const writes = [], messages = [], opened = [];
  const contacts = new Map([['friend:a', { id: 'friend:a', name: 'A' }], ['friend:b', { id: 'friend:b', name: 'B' }]]);
  const contactsStore = { scopeId: current.scopeId, _scopeToken: 0, ready: Promise.resolve(),
    listContacts: () => [...contacts.values()], getContact: id => contacts.get(id),
    upsertContact: record => { writes.push(record); contacts.set(record.id, record); } };
  const chatStore = { scopeId: current.scopeId, _scopeToken: 0, ready: Promise.resolve(),
    appendMessage: (message, id) => messages.push({ message, id }), switchSession: id => opened.push(id) };
  const registry = createAgentToolRegistry({ logger: { warn() {} } });
  registry.registerMany(createGroupChatAgentTools({ contactsStore, chatStore,
    ...(getContext ? { getCurrentContext: () => ({ ...current }) } : {}),
    createGroupId: () => 'group:travel', refreshChatAndContacts: async () => {},
  }));
  const context = { source: 'maid-assistant', ...current, operationIntentPolicy: { mode: 'write_allowed' } };
  const switchScope = (next = {}) => {
    current = { ...current, ...next };
    for (const store of [contactsStore, chatStore]) { store.scopeId = current.scopeId; store._scopeToken++; store.ready = Promise.resolve(); }
  };
  return { registry, contacts, contactsStore, chatStore, context, writes, messages, opened, switchScope };
};

test('real group preview freezes member IDs, display names, open and actual scope without approving a write', async () => {
  const h = harness();
  let approvals = 0;
  const output = await h.registry.executeTool('group.create', { ...args, preview: true }, {
    ...h.context, requestToolConfirmation: () => { approvals++; return true; },
  });
  assert.equal(output.result.ok, true);
  assert.deepEqual(output.result.groupPreview, { version: 1, name: args.name,
    members: [{ id: 'friend:a', name: 'A' }, { id: 'friend:b', name: 'B' }], open: false,
    scope: { roleCardId: 'card-a', sessionId: 'chat-a', uiMode: 'chat', contactsScopeId: 'scope-a', chatScopeId: 'scope-a',
      contactsScopeToken: 0, chatScopeToken: 0 } });
  assert.equal(approvals, 0); assert.equal(h.writes.length, 0); assert.equal(h.messages.length, 0);
  const applied = await h.registry.executeTool('group.create', args, { ...h.context,
    requestToolConfirmation: request => { approvals++; assert.equal(request.details.groupName, args.name); return true; } });
  assert.equal(applied.result.created, true); assert.equal(approvals, 1);
  assert.deepEqual(h.writes[0].members, args.members);
});

test('maid preflight refuses missing trusted context and stale task scope, including shared contacts', async () => {
  for (const mode of ['missing-context', 'stale-role', 'shared-role', 'stale-session']) {
    const h = harness({ getContext: mode !== 'missing-context', shared: mode === 'shared-role' });
    if (mode === 'stale-role' || mode === 'shared-role') h.switchScope({ roleCardId: 'card-b' });
    if (mode === 'stale-session') h.switchScope({ sessionId: 'chat-b' });
    let approvals = 0;
    const output = await h.registry.executeTool('group.create', { ...args, preview: true }, {
      ...h.context, requestToolConfirmation: () => { approvals++; return true; },
    });
    assert.equal(output.result.ok, false, mode);
    assert.equal(output.result.groupPreview, undefined, mode);
    assert.equal(approvals, 0); assert.equal(h.writes.length, 0);
  }
});

test('a scope switch during real registry approval cannot write identical member IDs in another scope', async () => {
  const h = harness();
  const output = await h.registry.executeTool('group.create', args, { ...h.context,
    requestToolConfirmation: () => { h.switchScope({ roleCardId: 'card-b', scopeId: 'scope-b' }); return true; } });
  assert.equal(output.result.ok, false);
  assert.equal(output.result.reason, 'target_scope_changed');
  assert.equal(h.writes.length, 0); assert.equal(h.messages.length, 0);
});

test('switching away and back invalidates the captured scope epoch', async () => {
  const h = harness();
  const output = await h.registry.executeTool('group.create', args, { ...h.context,
    requestToolConfirmation: () => { h.switchScope({ roleCardId: 'card-b', scopeId: 'scope-b' }); h.switchScope(initialContext); return true; } });
  assert.equal(output.result.reason, 'target_scope_changed'); assert.equal(h.writes.length, 0);
});

test('scope changes while store hydration is pending fail before preview or approval', async () => {
  const h = harness(); let release;
  h.contactsStore.ready = new Promise(resolve => { release = resolve; });
  const outputPromise = h.registry.executeTool('group.create', { ...args, preview: true }, h.context);
  await new Promise(resolve => setImmediate(resolve));
  h.switchScope({ roleCardId: 'card-b', scopeId: 'scope-b' }); release();
  const output = await outputPromise;
  assert.equal(output.result.ok, false); assert.equal(output.result.reason, 'target_scope_changed');
  assert.equal(output.result.groupPreview, undefined); assert.equal(h.writes.length, 0);
});

test('the approved member display names stay bound until the synchronous write', async () => {
  const h = harness();
  const output = await h.registry.executeTool('group.create', args, { ...h.context,
    requestToolConfirmation: () => { h.contacts.set('friend:a', { id: 'friend:a', name: 'Different A' }); return true; } });
  assert.equal(output.result.reason, 'group_member_changed_during_confirmation');
  assert.equal(h.writes.length, 0);
});
