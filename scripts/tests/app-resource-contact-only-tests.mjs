import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppResourceReader } from '../../src/scripts/agent/app-resource-reader.js';

const xiaoxueId = 'native_group_members_1790743464159_xiaoxue';
const makeReader = () => {
  const contacts = [
    { id: xiaoxueId, name: '小雪', description: '温柔学姐，黑色长发，喜欢读书。' },
    { id: 'existing', name: '已有聊天', description: '已有简介' },
    { id: 'hidden', name: '被会话列表隐藏', description: '不能通过合并重现' },
    { id: 'rp:active', name: '当前卡RP' },
  ];
  const state = { sessions: {
    existing: { messages: [{ id: 'm1' }], settings: { temperature: 0.7 } },
    hidden: { messages: [{ id: 'private' }], settings: {} },
    'orphan-deleted': { messages: [], settings: {} },
    'rp:active': { messages: [], settings: {} },
    'rp:other': { messages: [{ id: 'foreign' }], settings: {} },
  } };
  const calls = [];
  const deps = {
    contactsStore: {
      scopeId: 'active',
      // Like the production store: deleted contacts and foreign RP IDs are absent.
      listContacts: () => contacts,
      getContact: id => contacts.find(contact => contact.id === id) || null,
    },
    chatStore: {
      scopeId: 'active', state,
      listSessions: () => ['existing', 'orphan-deleted', 'rp:active'],
      getCurrent: () => 'existing',
      hasSession: id => id !== 'rp:other' && Object.hasOwn(state.sessions, id),
      getMessages: id => { calls.push(['getMessages', id]); assert.ok(state.sessions[id], 'reading a contact must not lazily create a session'); return state.sessions[id].messages; },
      getSessionSettings: id => { calls.push(['getSessionSettings', id]); assert.ok(state.sessions[id], 'reading a contact must not lazily create settings'); return state.sessions[id].settings; },
    },
  };
  const registry = createAgentToolRegistry();
  registry.registerMany(createAppNavigationAgentTools({ readResource: createAppResourceReader(deps) }));
  return { state, calls, read: async args => {
    const output = await registry.executeTool('app.read_resource', { resource: 'session', include: ['description'], ...args });
    assert.equal(output.status, 'succeeded');
    assert.equal(output.result.ok, true);
    return output.result;
  } };
};

test('real registry session reader returns a native contact without creating its first chat', async () => {
  const { read, state, calls } = makeReader();
  const before = JSON.stringify(state);
  const output = await read({ sessionId: xiaoxueId });
  assert.equal(output.sessions.length, 1);
  assert.equal(output.sessions[0].id, xiaoxueId);
  assert.equal(output.sessions[0].description, '温柔学姐，黑色长发，喜欢读书。');
  assert.equal(output.sessions[0].descriptionTruncated, false);
  assert.equal(output.sessions[0].messageCount, 0);
  assert.equal(output.sessions[0].settings, null);
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(state), before);
});

test('session/contact union keeps visible order, deduplicates and does not revive hidden, deleted or foreign RP records', async () => {
  const { read, state, calls } = makeReader();
  const before = JSON.stringify(state);
  const output = await read({});
  assert.deepEqual(output.sessions.map(row => row.id), ['existing', 'rp:active', xiaoxueId]);
  assert.equal(output.count, 3);
  assert.equal(output.sessions[0].messageCount, 1);
  for (const sessionId of ['hidden', 'orphan-deleted', 'rp:other', 'missing']) {
    assert.deepEqual((await read({ sessionId, name: '小雪' })).sessions, [], sessionId);
  }
  assert.deepEqual((await read({ name: '小雪' })).sessions.map(row => row.id), [xiaoxueId]);
  assert.ok(calls.every(([, id]) => ['existing', 'rp:active'].includes(id)));
  assert.equal(JSON.stringify(state), before);
});
