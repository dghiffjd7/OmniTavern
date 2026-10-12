import assert from 'node:assert/strict';

const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: key => memoryStorage.get(String(key)) ?? null,
  setItem: (key, value) => {
    memoryStorage.set(String(key), String(value));
  },
  removeItem: key => {
    memoryStorage.delete(String(key));
  },
};
globalThis.document = { body: { dataset: {} } };
globalThis.window = globalThis;
globalThis.setTimeout = () => 0;

const disk = { index: null, parts: new Map(), rawReplies: new Map() };
const partKey = args => `${args.sessionDir}/${args.threadDir}/${args.partId}`;
globalThis.__TAURI__ = {
  core: {
    invoke: async (cmd, args = {}) => {
      switch (cmd) {
        case 'load_kv':
          return null;
        case 'save_kv':
          return true;
        case 'chat_store_v2_read_index':
          return disk.index;
        case 'chat_store_v2_write_index':
          disk.index = JSON.parse(JSON.stringify(args.data ?? null));
          return true;
        case 'chat_store_v2_write_part':
          disk.parts.set(partKey(args), JSON.parse(JSON.stringify(args.data ?? [])));
          return true;
        case 'chat_store_v2_read_part':
          return disk.parts.get(partKey(args)) || [];
        case 'save_raw_reply':
          disk.rawReplies.set(`${args.sessionId}/${args.messageId}`, args.text);
          return true;
        default:
          return null;
      }
    },
  },
};

const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');

{
  const store = new ChatStore({ scopeId: 'import-archive' });
  await store.fullyReady;
  assert.equal(store._useV2, true, '测试环境必须启用 v2 存储');

  const sid = 'rp:import-card';
  store.appendMessage({ id: 'cur-1', role: 'user', content: '当前聊天' }, sid);
  store.appendMessage({ id: 'cur-2', role: 'assistant', content: '当前回复' }, sid);
  await store._v2._queue;
  store.setSummaries(['当前摘要'], sid);
  const currentBefore = store.getMessages(sid).map(message => message.id);
  const events = [];
  store.subscribeArchives(event => events.push(event));

  const snapshot = { templateId: 'tpl', rows: [] };
  const archiveId = await store.importMessagesAsArchive(sid, {
    name: '导入：雨夜',
    memoryTableSnapshot: snapshot,
    messages: [
      { role: 'user', type: 'text', name: '我', content: '你好', raw: '你好', timestamp: 1000, time: '10:00' },
      { role: 'assistant', type: 'text', name: '苏晓彤', content: '正文', raw: '正文', rawSource: '正文', rawOriginal: '<content>正文</content>', meta: { renderRich: true } },
    ],
  });
  assert.ok(archiveId, '返回新存档 id');

  const archive = store.getArchives(sid).find(item => item.id === archiveId);
  assert.equal(archive.name, '导入：雨夜');
  assert.equal(archive.messageCount, 2);
  assert.deepEqual(archive.summaries, [], '摘要为空，不沿用当前聊天的摘要');
  assert.equal(archive.compactedSummary, null);
  assert.equal(archive.memoryTableSnapshot, snapshot, '记忆表格快照为调用方给的空表');

  assert.deepEqual(store.getMessages(sid).map(message => message.id), currentBefore, '当前聊天不受影响');
  assert.equal(store.getCurrentArchiveId(sid), null, '不切换当前聊天');
  assert.deepEqual(events.map(event => [event.type, event.archiveId, event.automaticName]), [['created', archiveId, false]],
    '发出 created 事件，且不触发自动命名');

  const stored = await store.exportThreadMessages(sid, archiveId);
  assert.equal(stored.length, 2);
  assert.ok(stored.every(message => message.id && message.timestamp > 0), '补齐 id 与时间');
  assert.notEqual(stored[0].id, stored[1].id);
  assert.equal(stored[0].timestamp, 1000, '已有的时间保留');
  assert.equal(stored[1].rawOriginal, undefined, '原文不随分片保存');
  assert.deepEqual(stored[1].rawOriginalRef, { sessionId: sid, messageId: stored[1].id });
  assert.equal(disk.rawReplies.get(`${sid}/${stored[1].id}`), '<content>正文</content>', 'AI 原文照 appendMessage 的方式另存');
  assert.equal(disk.rawReplies.size, 1, '用户消息不另存原文');

  assert.equal(await store.importMessagesAsArchive(sid, { messages: [] }), null, '没有消息时不建存档');
  assert.equal(await store.importMessagesAsArchive('rp:missing', { messages: [{ role: 'user', content: 'x' }] }), null, '会话不存在时不建存档');
  const unnamed = await store.importMessagesAsArchive(sid, { messages: [{ role: 'user', content: 'x' }] });
  assert.match(store.getArchives(sid).find(item => item.id === unnamed).name, /^存档 \(/, '没给名字时用默认名');
  console.log('ok - importMessagesAsArchive stores a new archive without touching the current chat');
}
