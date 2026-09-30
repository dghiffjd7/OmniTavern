import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppSessionAgentTools } from '../../src/scripts/agent/tools/app-session-tools.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { buildMaidModelPlannerMessages, buildMaidModelReActMessages } from '../../src/scripts/agent/maid-model-planner.js';

const captured = JSON.parse(readFileSync(new URL('./fixtures/maid-session-create-collision.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const features = listAppFeatures().filter(feature => ['session.create', 'session.list', 'contact_profile.upsert'].includes(feature.id));

const makeHarness = (existing = captured.existingContact) => {
  const contacts = new Map([[existing.id, copy(existing)]]);
  const effects = [];
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: 'allow' }),
    logger: { warn() {} },
  });
  registry.registerMany(createAppSessionAgentTools({
    contactsStore: {
      getContact: id => contacts.get(id) || null,
      listContacts: () => [...contacts.values()],
      upsertContact: contact => { effects.push('contact'); contacts.set(contact.id, copy(contact)); },
    },
    chatStore: {
      getCurrent: () => 'current-room',
      appendMessage: () => effects.push('message'),
      switchSession: () => effects.push('navigate'),
    },
    refreshChatAndContacts: () => effects.push('refresh'),
    enterChatRoom: () => { effects.push('enter'); },
    now: () => 1000,
  }));
  return { registry, contacts, effects };
};

test('captured create collision preserves the existing persona in the actual registry-to-ReAct observation', async () => {
  const h = makeHarness();
  const before = copy([...h.contacts.values()]);
  const output = await h.registry.executeTool('session.create', captured.createArgs);
  const listed = await h.registry.executeTool('session.list', {});
  assert.equal(output.result.created, false);
  assert.equal(output.result.existing, true);
  assert.equal(output.result.sessionId, captured.originalResult.sessionId);
  assert.deepEqual(h.effects, [], 'reusing the existing contact performs no contact, history or navigation writes');
  assert.deepEqual([...h.contacts.values()], before);
  const steps = [
    { index: 1, toolName: 'session.create', status: 'succeeded', args: captured.createArgs, output },
    { index: 2, toolName: 'session.list', status: 'succeeded', args: {}, output: listed },
  ];
  const messages = buildMaidModelReActMessages({ input: captured.input, features, steps });
  const marker = '最近步骤观察（可能按预算省略；truncated 等字段为工具原始状态，不表示正文已全部呈现）：\n';
  const observations = JSON.parse(messages[1].content.split(marker).at(-1));
  const observed = observations[0].output.result;
  assert.equal(observed.created, false);
  assert.equal(observed.existing, true);
  assert.equal(observed.contact.id, captured.existingContact.id);
  assert.equal(observed.contact.description, captured.existingContact.description,
    'the new-role request must not be the only persona description visible after a real name collision');
  assert.equal(JSON.stringify(observations).includes(captured.blockedRequest.args.profile.stable_traits[0].label), false,
    'requested new traits are not observations about the existing contact');
});

test('initial and ReAct planners share a conditional collision contract, without treating a returned ID as update permission', () => {
  // This checks the instruction contract, not whether a model will obey it.
  const initial = buildMaidModelPlannerMessages({ input: captured.input, features });
  const react = buildMaidModelReActMessages({ input: captured.input, features, steps: [] });
  const rule = initial[0].content.split('\n').find(line => line.startsWith('When a request to create a new private contact'));
  assert.ok(rule, 'new-contact name collisions need an explicit continuation contract');
  assert.ok(react[0].content.split('\n').includes(rule), 'both planner routes must receive the same rule');
  for (const boundary of ['created:false', 'existing:true', 'description', 'contact_profile.read', 'rename', 'separate', 'modify', 'APP approval']) {
    assert.ok(rule.includes(boundary), `missing collision boundary: ${boundary}`);
  }
});

test('collision observations preserve missing descriptions honestly and leave ordinary creation unchanged', async () => {
  const existing = { id: 'existing-id', name: 'Existing', isGroup: false };
  const h = makeHarness(existing);
  const reuse = await h.registry.executeTool('session.create', { name: existing.name, open: false });
  assert.equal(reuse.result.contact.description, '', 'a missing description is not invented from the user request');
  assert.deepEqual(h.effects, []);
  const create = await h.registry.executeTool('session.create', { name: 'New character', open: false });
  assert.equal(create.result.created, true);
  assert.equal(create.result.sessionId, 'New character');
  assert.deepEqual(h.effects, ['contact', 'message', 'refresh']);
  assert.deepEqual(h.contacts.get(existing.id), existing);
});

test('existing-chat reuse does not require a new-character collision choice', () => {
  // Captured N01: the user corrected group to private chat, without requesting
  // another character or new traits. The shared B05 rule must not force a rename.
  for (const build of [buildMaidModelPlannerMessages, buildMaidModelReActMessages]) {
    const messages = build({ input: '那个……就是，帮我建个，嗯，群吧，不对，私聊，跟小雪的', features, steps: [] });
    const rule = messages[0].content.split('\n').find(line => line.startsWith('When a request to create a new private contact'));
    assert.match(rule, /only wants to open or use a private chat/);
    assert.match(rule, /do not ask for a rename/);
    assert.match(rule, /new traits/);
  }
});
