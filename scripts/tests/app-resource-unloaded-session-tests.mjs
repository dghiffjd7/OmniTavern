import assert from 'node:assert/strict';

// 分片存储下，没打开过的会话还没载入消息；女仆读这个会话的消息数或聊天内容时，要拿到磁盘上真实的数据
const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: key => memoryStorage.get(String(key)) ?? null,
  setItem: (key, value) => { memoryStorage.set(String(key), String(value)); },
  removeItem: key => { memoryStorage.delete(String(key)); },
};
globalThis.document = { body: { dataset: {} } };
globalThis.window = globalThis;
globalThis.setTimeout = () => 0;

const disk = { index: null, parts: new Map() };
const partKey = args => `${args.sessionDir}/${args.threadDir}/${args.partId}`;
globalThis.__TAURI__ = {
  core: {
    invoke: async (cmd, args = {}) => {
      switch (cmd) {
        case 'load_kv': return null;
        case 'save_kv': return true;
        case 'chat_store_v2_read_index': return disk.index;
        case 'chat_store_v2_write_index':
          disk.index = JSON.parse(JSON.stringify(args.data ?? null));
          return true;
        case 'chat_store_v2_write_part':
          disk.parts.set(partKey(args), JSON.parse(JSON.stringify(args.data ?? [])));
          return true;
        case 'chat_store_v2_read_part': return disk.parts.get(partKey(args)) || [];
        default: return null;
      }
    },
  },
};

const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');
const { createAppResourceReader } = await import('../../src/scripts/agent/app-resource-reader.js');

const scopeId = 'unloaded-session';
const sid = '雷姆';
const seed = new ChatStore({ scopeId });
await seed.fullyReady;
for (let i = 0; i < 40; i += 1) {
  seed.appendMessage({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }, sid);
}
await seed._v2._queue;

const store = new ChatStore({ scopeId });
await store.fullyReady;
assert.equal(store.getMessages(sid).length, 0, '前提：这个会话还没打开，消息没载入');

const contacts = [{ id: sid, name: '雷姆', description: '女仆' }, { id: '新联系人', name: '新联系人' }];
const readResource = createAppResourceReader({
  chatStore: store,
  contactsStore: {
    listContacts: () => contacts,
    getContact: id => contacts.find(contact => contact.id === id) || null,
  },
});

{
  assert.equal(store.getMessageTotal(sid), 40);
  const result = await readResource({ resource: 'session', sessionId: sid });
  assert.equal(result.ok, true);
  assert.equal(result.sessions[0].messageCount, 40, '消息数要算上还没载入的分片');
  console.log('ok - session messageCount counts messages that are not loaded yet');
}

{
  const before = Object.hasOwn(store.state.sessions, '新联系人');
  assert.equal(store.getMessageTotal('新联系人'), 0);
  const result = await readResource({ resource: 'session', sessionId: '新联系人' });
  assert.equal(result.sessions[0].messageCount, 0);
  assert.equal(Object.hasOwn(store.state.sessions, '新联系人'), before, '只读联系人不得建出聊天会话');
  console.log('ok - counting a contact without a chat creates no session');
}

{
  const result = await readResource({ resource: 'chat', sessionId: sid, limit: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages.map(message => message.content), ['消息35', '消息36', '消息37', '消息38', '消息39']);
  console.log('ok - chat reader loads recent messages of a session that was never opened');
}

{
  const result = await readResource({ resource: 'chat', sessionId: '不存在的会话' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, []);
  assert.equal(Object.hasOwn(store.state.sessions, '不存在的会话'), false, '读不存在的会话不得建出会话');
  console.log('ok - reading an unknown chat does not create a session');
}
