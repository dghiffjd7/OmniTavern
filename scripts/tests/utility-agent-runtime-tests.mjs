import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';
import { createUtilityAgentRuntime, parseScorePreview, splitScorePreviewText } from '../../src/scripts/agent/utility-agent-runtime.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const setup = async request => {
  // Use the production archive methods and in-memory persistence; no disk or model calls.
  const chat = Object.create(ChatStore.prototype);
  chat.scopeId = 'person'; chat.currentId = 'room'; chat._useV2 = false; chat._persist = () => {};
  chat.state = { sessions: { room: { messages: [{ id: 'm', role: 'assistant', content: '一起去海边散步。' }], archives: [], summaries: [] } } };
  const context = () => ({ place: 'chat', scopeId: chat.scopeId, sessionId: 'room', archiveId: chat.state.sessions.room.currentArchiveId || '' });
  const configs = createAgentConfigStore({ storage: null, saveKv: async () => true });
  for (const id of ['archive_naming', 'reply_scoring']) assert.equal((await configs.save({ id, context: context(), scope: 'local', config: { enabled: true, modelMode: 'profile', modelProfileId: 'selected' } })).ok, true);
  const runtime = createUtilityAgentRuntime({ chatStore: chat, configStore: configs, getContext: context,
    captureModel: async config => { assert.equal(config.modelProfileId, 'selected'); return { model: 'test-model' }; }, request });
  return { chat, configs, context, runtime };
};

test('new unnamed archives are named asynchronously; explicit names and late manual edits are preserved', async () => {
  let resolveRequest, calls = 0;
  const h = await setup(({ request }) => { calls++; request.params.onProviderUsage({ promptTokens: 20, completionTokens: 5, totalTokens: 25 }); return new Promise(resolve => { resolveRequest = resolve; }); });
  const first = h.chat.archiveCurrentMessages('room', '', true);
  assert(first); await tick(); assert.equal(calls, 1);
  h.chat.renameArchive(first, '手动命名', 'room');
  resolveRequest('{"title":"海边漫步"}'); await tick();
  assert.equal(h.chat.getArchives('room').find(a => a.id === first).name, '手动命名');
  h.chat.archiveCurrentMessages('room', '保留这个标题', true); await tick(); assert.equal(calls, 1);
  const second = h.chat.startNewChat('room', ''); await tick();
  assert.equal(h.chat.getMessages('room').length, 0, 'background naming never holds up new chat');
  resolveRequest('{"title":"海边漫步"}'); await tick();
  assert.equal(h.chat.getArchives('room').find(a => a.id === second).name, '海边漫步');
  assert.equal(h.runtime.list('archive_naming').at(-1).usage.totalTokens, 25);
  h.runtime.dispose();
});

test('disabling the model cancels stale archive writes', async () => {
  let resolveRequest;
  const h = await setup(() => new Promise(resolve => { resolveRequest = resolve; }));
  const id = h.chat.archiveCurrentMessages('room', '', true); await tick();
  const original = h.chat.getArchives('room').find(a => a.id === id).name;
  const record = h.configs.read('archive_naming', h.context());
  await h.configs.save({ ...record, config: { ...record.config, enabled: false } });
  h.runtime.reconcile(); resolveRequest('{"title":"不能覆盖"}'); await tick();
  assert.equal(h.chat.getArchives('room').find(a => a.id === id).name, original);
  h.runtime.dispose();
});

test('manual score previews keep original messages and require one bounded result per paragraph', async () => {
  const h = await setup(async ({ request }) => {
    assert.equal(request.messages.length, 2);
    return JSON.stringify({ scores: [{ id: 'p2', score: .8, reason: '重复' }, { id: 'p1', score: .1, reason: '清楚' }] });
  });
  const original = JSON.stringify(h.chat.state);
  const result = await h.runtime.run({ id: 'reply_scoring', context: h.context(), text: '第一段。\n\n第二段。' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(h.runtime.list('reply_scoring')[0].scores.map(row => row.id), ['p1', 'p2']);
  assert.equal(JSON.stringify(h.chat.state), original, 'scoring never edits or replaces the message');
  const segments = splitScorePreviewText('第一段。\n第二段。');
  for (const scores of [[{ id: 'p1', score: .1 }], [{ id: 'p1', score: .1 }, { id: 'p1', score: .3 }], [{ id: 'p1', score: 2 }, { id: 'p2', score: .3 }]])
    assert.throws(() => parseScorePreview(JSON.stringify({ scores }), segments));
  assert.throws(() => splitScorePreviewText('x'.repeat(12001)));
  assert.throws(() => splitScorePreviewText(Array(41).fill('一段').join('\n')));
  h.runtime.dispose();
});

test('a scope reload with the same archive identifiers cannot receive an old naming result', async () => {
  let resolveRequest;
  const h = await setup(() => new Promise(resolve => { resolveRequest = resolve; }));
  const id = h.chat.archiveCurrentMessages('room', '', true); await tick();
  const original = h.chat.getArchives('room').find(a => a.id === id).name;
  h.chat.state = structuredClone(h.chat.state);
  h.runtime.reconcile(); resolveRequest('{"title":"旧作用域的结果"}'); await tick();
  assert.equal(h.chat.getArchives('room').find(a => a.id === id).name, original);
  assert.equal(h.runtime.list('archive_naming')[0].status, 'cancelled');
  h.runtime.dispose();
});
