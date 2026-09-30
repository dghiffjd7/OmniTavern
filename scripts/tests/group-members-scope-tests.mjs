import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createGroupChatAgentTools } from '../../src/scripts/agent/tools/group-chat-agent-tools.js';

test('group.update_members rejects an approval whose card and store scope changed despite identical IDs', async () => {
  const makeContacts = scope => new Map([
    ['friend:a', { id: 'friend:a', name: `${scope} A` }],
    ['friend:b', { id: 'friend:b', name: `${scope} B` }],
    ['friend:c', { id: 'friend:c', name: `${scope} C` }],
    ['group:party', { id: 'group:party', name: `${scope} party`, isGroup: true, members: ['friend:a', 'friend:b'] }],
  ]);
  const scopes = { 'scope-a': makeContacts('A'), 'scope-b': makeContacts('B') };
  let current = { roleCardId: 'card-a', sessionId: 'chat-a', uiMode: 'chat', scopeId: 'scope-a' };
  const writes = [], messages = [], approvals = [];
  const contactsStore = {
    scopeId: current.scopeId, _scopeToken: 0, ready: Promise.resolve(),
    listContacts() { return [...scopes[this.scopeId].values()]; },
    getContact(id) { return scopes[this.scopeId].get(id); },
    upsertContact(contact) { writes.push({ scopeId: this.scopeId, contact }); scopes[this.scopeId].set(contact.id, contact); },
  };
  const chatStore = { scopeId: current.scopeId, _scopeToken: 0, ready: Promise.resolve(),
    appendMessage(message, sessionId) { messages.push({ scopeId: this.scopeId, sessionId, message }); } };
  const registry = createAgentToolRegistry({ logger: { warn() {} } });
  registry.registerMany(createGroupChatAgentTools({ contactsStore, chatStore,
    getCurrentContext: () => ({ ...current }), refreshChatAndContacts: async () => {} }));
  const taskContext = { ...current, source: 'maid-assistant', operationIntentPolicy: { mode: 'write_allowed' } };
  const result = await registry.executeTool('group.update_members', {
    groupId: 'group:party', addMembers: ['friend:c'], open: false,
  }, { ...taskContext, requestToolConfirmation(request) {
    approvals.push(request);
    assert.equal(request.kind, 'group.update_members');
    assert.equal(request.details.groupName, 'A party');
    assert.equal(request.details.items[0].id, 'friend:c');
    // The two cards intentionally share object IDs and the same member baseline.
    // An approval captured on A must not change the corresponding objects on B.
    current = { roleCardId: 'card-b', sessionId: 'chat-b', uiMode: 'chat', scopeId: 'scope-b' };
    for (const store of [contactsStore, chatStore]) {
      store.scopeId = current.scopeId; store._scopeToken++; store.ready = Promise.resolve();
    }
    return true;
  } });
  assert.equal(approvals.length, 1);
  assert.equal(writes.length, 0, 'approval for card A must not write the same group ID in card B');
  assert.equal(messages.length, 0, 'a rejected scope must not append membership events to card B');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, 'target_scope_changed');
  for (const scope of Object.values(scopes)) assert.deepEqual(scope.get('group:party').members, ['friend:a', 'friend:b']);
});

const createAsyncBoundaryHarness = ({ hydration, switchDuringRefresh = false, switchDuringOpen = false } = {}) => {
  let current = { roleCardId: 'card-a', sessionId: 'chat-a', uiMode: 'chat', scopeId: 'scope-a' };
  const makeContacts = () => new Map([
    ['friend:a', { id: 'friend:a', name: 'A' }], ['friend:b', { id: 'friend:b', name: 'B' }],
    ['friend:c', { id: 'friend:c', name: 'C' }],
    ['group:party', { id: 'group:party', name: 'Party', isGroup: true, members: ['friend:a', 'friend:b'] }],
  ]);
  const scopes = { 'scope-a': makeContacts(), 'scope-b': makeContacts() };
  const reads = [], writes = [], messages = [], opened = [], approvals = [];
  const contactsStore = { scopeId: current.scopeId, _scopeToken: 0, ready: hydration || Promise.resolve(),
    listContacts() { reads.push(this.scopeId); return [...scopes[this.scopeId].values()]; },
    getContact(id) { reads.push(this.scopeId); return scopes[this.scopeId].get(id); },
    upsertContact(contact) { writes.push({ scopeId: this.scopeId, contact }); scopes[this.scopeId].set(contact.id, contact); } };
  const chatStore = { scopeId: current.scopeId, _scopeToken: 0, ready: Promise.resolve(),
    appendMessage(message, id) { messages.push({ scopeId: this.scopeId, id, message }); },
    switchSession(id) { opened.push({ scopeId: this.scopeId, id }); } };
  const switchToB = () => {
    current = { roleCardId: 'card-b', sessionId: 'chat-b', uiMode: 'chat', scopeId: 'scope-b' };
    for (const store of [contactsStore, chatStore]) {
      store.scopeId = current.scopeId; store._scopeToken++; store.ready = Promise.resolve();
    }
  };
  const registry = createAgentToolRegistry({ logger: { warn() {} } });
  registry.registerMany(createGroupChatAgentTools({ contactsStore, chatStore,
    getCurrentContext: () => ({ ...current }),
    refreshChatAndContacts: async () => { if (switchDuringRefresh) switchToB(); },
    enterChatRoom: async id => {
      opened.push({ id, entered: true, scopeId: current.scopeId });
      await Promise.resolve();
      if (switchDuringOpen) switchToB();
    },
  }));
  const context = { ...current, source: 'maid-assistant', operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => { approvals.push(request); return true; } };
  return { registry, context, switchToB, scopes, reads, writes, messages, opened, approvals };
};

test('group.update_members stops before reading or approving when scope changes during hydration', async () => {
  let release;
  const hydration = new Promise(resolve => { release = resolve; });
  const h = createAsyncBoundaryHarness({ hydration });
  const pending = h.registry.executeTool('group.update_members', {
    groupId: 'group:party', addMembers: ['friend:c'], open: false,
  }, h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.reads.length, 0, 'targets must wait for the captured stores to hydrate');
  assert.equal(h.approvals.length, 0);
  h.switchToB(); release();
  const output = await pending;
  assert.equal(output.result.reason, 'target_scope_changed');
  assert.equal(output.result.changed, false);
  assert.equal(h.approvals.length, 0); assert.equal(h.reads.length, 0);
  assert.equal(h.writes.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.opened.length, 0);
});

test('group.update_members reports the committed write but stops readback and opening after a refresh scope change', async () => {
  const h = createAsyncBoundaryHarness({ switchDuringRefresh: true });
  const output = await h.registry.executeTool('group.update_members', {
    groupId: 'group:party', addMembers: ['friend:c'], open: true,
  }, h.context);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].scopeId, 'scope-a');
  assert.equal(output.result.ok, false);
  assert.equal(output.result.changed, true, 'a completed write must not be reported as never applied');
  assert.equal(output.result.verified, false);
  assert.equal(output.result.reason, 'target_scope_changed');
  assert.equal(output.result.group, undefined, 'do not expose a readback from the new scope');
  assert.equal(h.reads.includes('scope-b'), false); assert.equal(h.opened.length, 0);
  assert(h.messages.length > 0 && h.messages.every(message => message.scopeId === 'scope-a'));
  assert.deepEqual(h.scopes['scope-a'].get('group:party').members, ['friend:a', 'friend:b', 'friend:c']);
  assert.deepEqual(h.scopes['scope-b'].get('group:party').members, ['friend:a', 'friend:b']);
});

test('group member failure receipt does not claim planned changes were written', async () => {
  const h = createAsyncBoundaryHarness();
  const output = await h.registry.executeTool('group.update_members', {
    groupId: 'group:party', addMembers: ['friend:c', 'friend:missing'], open: false,
  }, h.context);
  assert.equal(output.result.ok, false);
  assert.equal(output.result.reason, 'group_members_unresolved');
  assert.equal(h.approvals.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.scopes['scope-a'].get('group:party').members, ['friend:a', 'friend:b']);
  assert.equal(output.result.changed, false, 'an invalid proposed member set was never written');
  assert.match(output.summary, /group_members_unresolved/);
  assert.doesNotMatch(output.summary, /已写入/);
});

for (const operation of ['group.create', 'group.update_members']) {
  test(`${operation} freezes its receipt before open awaits a changed card`, async () => {
    const h = createAsyncBoundaryHarness({ switchDuringOpen: true });
    for (const contact of h.scopes['scope-b'].values()) contact.name = `B-only ${contact.name}`;
    const args = operation === 'group.create'
      ? { name: 'New party', members: ['friend:a', 'friend:b'], open: true }
      : { groupId: 'group:party', addMembers: ['friend:c'], open: true };
    const output = await h.registry.executeTool(operation, args, h.context);
    assert.equal(output.result.ok, true);
    assert.equal(output.result.verified, true, 'the receipt describes the write verified before navigation');
    assert.equal(h.approvals.length, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].scopeId, 'scope-a');
    assert(h.messages.length > 0 && h.messages.every(message => message.scopeId === 'scope-a'));
    assert.equal(h.reads.includes('scope-b'), false, 'return values must not read contacts from the card entered during navigation');
    assert.deepEqual(output.result.group.members.map(member => member.name), operation === 'group.create' ? ['A', 'B'] : ['A', 'B', 'C']);
    if (operation === 'group.update_members') assert.deepEqual(output.result.addedMembers.map(member => member.name), ['C']);
    assert.equal(JSON.stringify(output.result).includes('B-only'), false);
    assert.deepEqual(h.scopes['scope-b'].get('group:party').members, ['friend:a', 'friend:b']);
  });
}

test('group member receipt preserves the frozen reason and identity for a mixed add and absent removal', async () => {
  const h = createAsyncBoundaryHarness();
  h.scopes['scope-a'].set('friend:d', { id: 'friend:d', name: 'Original D' });
  h.context.requestToolConfirmation = request => {
    h.approvals.push(request);
    assert.deepEqual(request.details.items.map(item => item.id), ['friend:c']);
    h.scopes['scope-a'].get('friend:d').name = 'Later D';
    return true;
  };
  const output = await h.registry.executeTool('group.update_members', {
    groupId: 'group:party', addMembers: ['friend:c'], removeMembers: ['friend:d'], open: false,
  }, h.context);
  assert.equal(output.result.ok, true);
  assert.equal(output.result.changed, true);
  assert.deepEqual(output.result.addedMembers.map(member => member.id), ['friend:c']);
  assert.deepEqual(output.result.removedMembers, []);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.messages.length, 1, 'only the actual addition creates a membership event');
  assert.deepEqual(output.result.skippedMembers?.find(item => item.target === 'friend:d'), {
    target: 'friend:d', memberId: 'friend:d', name: 'Original D', status: 'skipped', reason: 'member_not_in_group',
  });
});

test('group member receipt explains an absent-only removal without approval or fabricated identity', async () => {
  const h = createAsyncBoundaryHarness();
  const output = await h.registry.executeTool('group.update_members', {
    groupId: 'group:party', removeMembers: ['C', 'friend:unknown'], open: false,
  }, h.context);
  assert.equal(output.result.ok, true);
  assert.equal(output.result.changed, false);
  assert.deepEqual(output.result.removedMembers, []);
  assert.equal(h.approvals.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(output.result.skippedMembers, [
    { target: 'C', memberId: 'friend:c', name: 'C', status: 'skipped', reason: 'member_not_in_group' },
    { target: 'friend:unknown', memberId: '', name: 'friend:unknown', status: 'skipped', reason: 'member_not_in_group' },
  ]);
  assert.deepEqual(h.scopes['scope-a'].get('group:party').members, ['friend:a', 'friend:b']);
});
