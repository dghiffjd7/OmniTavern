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

const { ChatStore, __chatStoreStorageInternals } = await import('../../src/scripts/storage/chat-store.js');
const { ContactsStore, __contactsStoreInternals } = await import('../../src/scripts/storage/contacts-store.js');

const makeSession = (timestamp = 1) => ({
  messages: [{ id: `m-${timestamp}`, role: 'user', content: 'x', timestamp }],
  draft: '',
  pending: [],
});

{
  const storage = __chatStoreStorageInternals;
  assert.equal(storage.isScopedDataMatch({ sessions: {} }, 'persona_1'), false);
  assert.equal(storage.isScopedDataMatch({ sessions: {} }, 'default'), true);
  assert.equal(storage.isScopedDataMatch({ sessions: {}, scopeId: 'persona_1' }, 'persona_1'), true);
  assert.equal(storage.isScopedDataMatch({ sessions: {}, scopeId: 'persona_2' }, 'persona_1'), false);
  assert.equal(storage.isForeignRpSessionForScope('rp:persona_2', 'persona_1'), true);
  assert.equal(storage.isForeignRpSessionForScope('rp:persona_1', 'persona_1'), false);
  assert.equal(storage.isForeignRpSessionForScope('room-a', 'persona_1'), false);
  assert.equal(storage.resolveCurrentId({
    currentId: 'rp:persona_2',
    sessions: {
      'rp:persona_2': makeSession(3),
      'rp:persona_1': makeSession(2),
      'room-a': makeSession(1),
    },
  }, 'persona_1'), 'rp:persona_1');
  console.log('ok - ChatStore internals reject foreign RP session ids for scoped current selection');
}

{
  const store = new ChatStore({ scopeId: 'persona_1' });
  store.state = {
    currentId: 'rp:persona_2',
    sessions: {
      'rp:persona_2': makeSession(3),
      'rp:persona_1': makeSession(2),
      'room-a': makeSession(1),
    },
  };
  store.currentId = 'rp:persona_2';

  assert.deepEqual(store.listSessions(), ['rp:persona_1', 'room-a']);
  assert.equal(store.hasSession('rp:persona_2'), false);
  assert.equal(store.hasSession('rp:persona_1'), true);
  assert.equal(store.setCurrent('rp:persona_2'), false);
  assert.equal(store.currentId, 'rp:persona_2');
  assert.equal(store.switchSession('rp:persona_2'), false);
  assert.equal(store.hasSession('room-a'), true);
  console.log('ok - ChatStore public session list and switch paths hide foreign RP ids');
}

{
  const store = new ChatStore({ scopeId: 'deleted_summary_reads' });
  store.state = { currentId: '', sessions: {} };
  store.currentId = '';

  assert.deepEqual(store.getSummaries('deleted-session'), []);
  assert.equal(store.getCompactedSummary('deleted-session'), null);
  assert.equal(store.getCompactedSummaryRaw('deleted-session'), '');
  assert.equal(store.hasSession('deleted-session'), false);
  assert.deepEqual(store.listSessions(), []);
  console.log('ok - summary reads do not recreate an absent session');
}

{
  const store = new ChatStore({ scopeId: 'persona_archive_name' });
  store.state = {
    currentId: 's-name',
    sessions: {
      's-name': makeSession(10),
      's-auto': makeSession(11),
    },
  };
  store.currentId = 's-name';

  const archiveId = store.startNewChat('s-name', '流');
  assert.equal(Boolean(archiveId), true);
  assert.equal(store.state.sessions['s-name'].archives[0].name, '流');
  assert.equal(store.renameArchive(archiveId, '重命名', 's-name'), true);
  assert.equal(store.state.sessions['s-name'].archives[0].name, '重命名');
  assert.equal(store.renameArchive(archiveId, '   ', 's-name'), false);

  const autoArchiveId = store.startNewChat('s-auto', '');
  assert.equal(Boolean(autoArchiveId), true);
  assert.match(store.state.sessions['s-auto'].archives[0].name, /^存档 \(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\)$/);
  console.log('ok - ChatStore startNewChat preserves typed archive names and auto-names blank archives');
}

{
  const sid = 'rp:persona_archive_edit';
  const store = new ChatStore({ scopeId: 'persona_archive_edit' });
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: {
        messages: [{ id: 'm-edit', role: 'assistant', content: 'edited', timestamp: 1700000000100 }],
        currentArchiveId: 'arc-a',
        archives: [
          { id: 'arc-a', name: 'A', timestamp: 1700000000000, messageCount: 2 },
          { id: 'arc-b', name: 'B', timestamp: 1700000000200, messageCount: 1 },
        ],
      },
    },
  };
  store.currentId = sid;
  store._useV2 = true;
  let cloneCalled = false;
  store._v2 = {
    getThreadTotal: (_sid, archiveId) => (archiveId === 'arc-a' ? 3 : 0),
    enqueue: () => {
      cloneCalled = true;
      return Promise.resolve();
    },
  };

  const archiveId = store.startNewChat(sid, '');
  assert.equal(archiveId, 'arc-a');
  assert.equal(cloneCalled, false);
  assert.deepEqual(store.state.sessions[sid].archives.map(item => item.id), ['arc-a', 'arc-b']);
  assert.equal(store.state.sessions[sid].archives[0].messageCount, 3);
  assert.equal(store.state.sessions[sid].currentArchiveId, null);
  assert.deepEqual(store.state.sessions[sid].messages, []);
  console.log('ok - ChatStore startNewChat updates attached archive instead of creating an empty archive');
}

{
  const sid = 'rp:persona_archive_recover';
  const store = new ChatStore({ scopeId: 'persona_archive_recover' });
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: {
        messages: [],
        archives: [
          { id: '1700000000000-a111', name: '保留命名', timestamp: 1700000000000, messageCount: 1 },
        ],
      },
    },
  };
  store._useV2 = true;
  store._v2.index = {
    sessions: {
      [sid]: {
        archives: {
          '1700000000000-a111': { total: 7, lastMessageAt: 1700000000700, parts: [{ id: 'part_0001' }] },
          '1700000100000-b222': { total: 3, lastMessageAt: 1700000100300, parts: [{ id: 'part_0001' }] },
        },
      },
    },
  };

  assert.equal(store._recoverV2ArchiveMetadata(), true);
  const archives = store.getArchives(sid);
  assert.deepEqual(archives.map(item => item.id), ['1700000100000-b222', '1700000000000-a111']);
  assert.equal(archives.find(item => item.id === '1700000000000-a111')?.name, '保留命名');
  assert.equal(archives.find(item => item.id === '1700000000000-a111')?.messageCount, 7);
  assert.match(
    archives.find(item => item.id === '1700000100000-b222')?.name || '',
    /^存档 \(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\)$/,
  );
  console.log('ok - ChatStore recovers missing archive metadata from v2 sidecar index');
}

{
  const sid = 'rp:persona_archive_persist';
  const store = new ChatStore({ scopeId: 'persona_archive_persist' });
  store.storeKey = 'chat_store_v1__persona_archive_persist_test';
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: {
        messages: [],
        archives: Array.from({ length: 10 }, (_, index) => ({
          id: `17000000${String(index).padStart(4, '0')}-arc`,
          name: `A${index}`,
          timestamp: 1700000000000 + index,
          messageCount: index,
          messages: [],
        })),
      },
    },
  };
  store._skipMessagePersist = true;

  await store.flush();
  const persisted = JSON.parse(memoryStorage.get(store.storeKey));
  assert.equal(persisted.sessions[sid].archives.length, 10);
  assert.deepEqual(
    persisted.sessions[sid].archives.map(item => item.name),
    ['A9', 'A8', 'A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0'],
  );
  console.log('ok - ChatStore persists archive metadata beyond the old six item cap');
}

{
  const sid = 'rp:persona_recent_race';
  const store = new ChatStore({ scopeId: 'persona_recent_race' });
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: { messages: [], currentArchiveId: null },
    },
  };
  store.currentId = sid;
  store._useV2 = true;
  const entry = {};
  const thread = { parts: [{ id: 'part_0001' }] };
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let readCount = 0;
  store._v2 = {
    ensureSession: () => entry,
    getThread: () => thread,
    readPart: async () => {
      readCount += 1;
      await readGate;
      return [{ id: 'greeting-1', role: 'assistant', content: '开场白' }];
    },
  };

  const firstLoad = store.ensureRecentMessagesLoaded(sid);
  const secondLoad = store.ensureRecentMessagesLoaded(sid);
  await Promise.resolve();
  assert.equal(readCount, 1);
  releaseRead();
  const [firstMessages, secondMessages] = await Promise.all([firstLoad, secondLoad]);
  assert.deepEqual(firstMessages.map(message => message.id), ['greeting-1']);
  assert.deepEqual(secondMessages.map(message => message.id), ['greeting-1']);
  assert.deepEqual(store.getMessages(sid).map(message => message.id), ['greeting-1']);
  console.log('ok - ChatStore coalesces concurrent recent-message loads for the same V2 thread');
}

{
  const sid = 'rp:persona_recent_reset_race';
  const store = new ChatStore({ scopeId: 'persona_recent_reset_race' });
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: { messages: [], currentArchiveId: null },
    },
  };
  store.currentId = sid;
  store._useV2 = true;
  const entry = {};
  const thread = { parts: [{ id: 'part_0001' }] };
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  store._v2 = {
    ensureSession: () => entry,
    getThread: () => thread,
    readPart: async () => {
      await readGate;
      return [{ id: 'old-message', role: 'assistant', content: '旧聊天' }];
    },
    enqueue: task => Promise.resolve().then(task),
    resetThread: async () => {},
  };

  const pending = store.ensureRecentMessagesLoaded(sid);
  await Promise.resolve();
  const beforeRevision = store.getHistoryRevision(sid);
  store.clear(sid);
  const afterRevision = store.getHistoryRevision(sid);
  assert.notEqual(afterRevision, beforeRevision);
  releaseRead();
  assert.deepEqual(await pending, []);
  assert.deepEqual(store.getMessages(sid), []);
  console.log('ok - ChatStore rejects a recent-message load invalidated by clearing the thread');
}

{
  const sid = 'rp:persona_pending_v2_append_reset';
  const store = new ChatStore({ scopeId: 'persona_pending_v2_append_reset' });
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: {
        messages: [],
        currentArchiveId: null,
        archives: [],
        detachedSummaries: [],
        compactedSummary: null,
      },
    },
  };
  store.currentId = sid;
  store._useV2 = true;
  store._persist = () => {};
  const currentThread = { total: 0 };
  const archiveThreads = new Map();
  let releaseAppend;
  const appendGate = new Promise(resolve => { releaseAppend = resolve; });
  let queue = Promise.resolve();
  store._v2 = {
    getThreadTotal: (_sessionId, archiveId = '') => (
      archiveId ? Number(archiveThreads.get(archiveId)?.total || 0) : currentThread.total
    ),
    enqueue: task => {
      queue = queue.then(task);
      return queue;
    },
    appendMessage: async () => {
      await appendGate;
      currentThread.total += 1;
      return { partId: 'part_0001', createdNewPart: true };
    },
    cloneCurrentToArchive: async (_sessionId, archiveId) => {
      archiveThreads.set(archiveId, { total: currentThread.total });
      currentThread.total = 0;
      return true;
    },
  };

  store.appendMessage({ role: 'assistant', content: '仍在排队写入的旧回复' }, sid);
  const archiveId = store.startNewChat(sid, '竞态存档');
  assert.ok(archiveId, '内存已有消息时不得因 V2 total 尚未更新而跳过归档');
  assert.deepEqual(store.getMessages(sid), []);
  releaseAppend();
  await queue;
  assert.equal(currentThread.total, 0);
  assert.equal(archiveThreads.get(archiveId)?.total, 1);
  console.log('ok - startNewChat archives pending V2 appends instead of letting them resurrect the cleared thread');
}

{
  const sid = 'rp:persona_older_overlap';
  const store = new ChatStore({ scopeId: 'persona_older_overlap' });
  store.state = {
    currentId: sid,
    sessions: {
      [sid]: {
        messages: [{ id: 'greeting-1', role: 'assistant', content: '当前开场白' }],
        currentArchiveId: null,
        _loadedThreadKey: `${sid}::current`,
      },
    },
  };
  store.currentId = sid;
  store._useV2 = true;
  const entry = {};
  const thread = { parts: [{ id: 'part_0001' }, { id: 'part_0002' }] };
  store._v2 = {
    ensureSession: () => entry,
    getThread: () => thread,
    readPart: async (_entry, _thread, partId) => (
      partId === 'part_0001'
        ? [{ id: 'greeting-1', role: 'assistant', content: '磁盘旧副本' }]
        : []
    ),
  };
  store._getThreadState(`${sid}::current`).loadedParts = ['part_0002'];

  const prepended = await store.loadOlderMessages(sid);
  assert.deepEqual(prepended, []);
  assert.equal(store.getMessages(sid).length, 1);
  assert.equal(store.getMessages(sid)[0].content, '当前开场白');
  console.log('ok - ChatStore does not prepend a V2 message id already present in the current thread');
}

{
  const contacts = __contactsStoreInternals;
  assert.equal(contacts.isScopedDataMatch({ contacts: {} }, 'persona_1'), false);
  assert.equal(contacts.isScopedDataMatch({ contacts: {} }, 'default'), true);
  assert.equal(contacts.isScopedDataMatch({ contacts: {}, scopeId: 'persona_1' }, 'persona_1'), true);
  assert.equal(contacts.isScopedDataMatch({ contacts: {}, scopeId: 'persona_2' }, 'persona_1'), false);
  assert.equal(contacts.isForeignRpContactForScope('rp:persona_2', 'persona_1'), true);
  assert.equal(contacts.isForeignRpContactForScope('rp:persona_1', 'persona_1'), false);

  const store = new ContactsStore({ scopeId: 'persona_1' });
  await store.ready;
  store.state = {
    contacts: {
      'rp:persona_2': { id: 'rp:persona_2', name: 'Foreign', addedAt: 3 },
      'rp:persona_1': { id: 'rp:persona_1', name: 'Own', addedAt: 2 },
      'room-a': { id: 'room-a', name: 'Room', addedAt: 1 },
    },
  };

  assert.deepEqual(store.listContacts().map(item => item.id), ['rp:persona_1', 'room-a']);
  assert.equal(store.getContact('rp:persona_2'), null);
  store.upsertContact({ id: 'rp:persona_2', name: 'Still foreign' });
  store.ensureFromSessions(['rp:persona_2', 'room-b']);
  assert.equal(store.state.contacts['rp:persona_2'].name, 'Foreign');
  assert.equal(Boolean(store.state.contacts['room-b']), true);
  console.log('ok - ContactsStore filters and refuses foreign RP contacts per scope');
}

{
  // 脚本 chatMetadata 的引用记在会话上：改名跟着搬并更新 sessionId；删除会话就没了
  const store = new ChatStore({ scopeId: 'persona_meta_ref' });
  store.state = { currentId: 'room-a', sessions: { 'room-a': makeSession(1) } };
  store.currentId = 'room-a';
  assert.equal(store.getScriptMetadataRef('room-a'), null);
  assert.equal(store.setScriptMetadataRef('room-a', { key: 'script_chat_metadata_v1__x', sessionId: 'room-a' }), true);
  assert.deepEqual(store.getScriptMetadataRef('room-a'), { key: 'script_chat_metadata_v1__x', sessionId: 'room-a' });
  store.rename('room-a', 'room-b');
  assert.deepEqual(store.getScriptMetadataRef('room-b'), { key: 'script_chat_metadata_v1__x', sessionId: 'room-b' });
  assert.equal(store.getScriptMetadataRef('room-a'), null);
  store.delete('room-b');
  assert.equal(store.getScriptMetadataRef('room-b'), null);
  console.log('ok - script chat metadata references move with renamed sessions and vanish with deleted ones');
}
