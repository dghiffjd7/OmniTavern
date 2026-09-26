import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';
import { createUtilityAgentRuntime, parseArchiveTitle, parseScorePreview, parseUtilityJson, splitScorePreviewText } from '../../src/scripts/agent/utility-agent-runtime.js';

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
  assert.throws(() => splitScorePreviewText(Array(41).fill('一段').join('\n\n')));
  // Many dialogue lines no longer hit the segment cap: blank-line paragraphs first, then grouped lines.
  const dialogue = Array.from({ length: 90 }, (_, index) => `「第${index}句」`);
  assert.equal(splitScorePreviewText(dialogue.join('\n')).length, 30);
  assert.equal(splitScorePreviewText(dialogue.join('\n')).map(row => row.text).join('\n'), dialogue.join('\n'));
  assert.equal(splitScorePreviewText([dialogue.slice(0, 45).join('\n'), dialogue.slice(45).join('\n')].join('\n\n')).length, 2);
  assert.equal(splitScorePreviewText('一\n二\n\n三').length, 3);
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

test('model replies with a preamble or fence still parse; names are one clean line', () => {
  assert.deepEqual(parseUtilityJson('好的，结果如下：\n```json\n{"title":"海边"}\n```'), { title: '海边' });
  assert.deepEqual(parseUtilityJson('<think>先想想 {x}</think>结果：{"title":"雨夜"} 希望有帮助'), { title: '雨夜' });
  assert.equal(parseUtilityJson('没有 JSON'), null);
  assert.equal(parseArchiveTitle(JSON.stringify({ title: '  雨夜\t的\u200b港口\u0007 ' })), '雨夜 的港口');
  assert.throws(() => parseArchiveTitle('{"title":"第一行\n第二行"}'));
  assert.throws(() => parseArchiveTitle('{"title":"\u200b\u200b"}'));
  assert.throws(() => parseArchiveTitle(JSON.stringify({ title: '长'.repeat(49) })));
});

test('V2 thread totals refreshing messageCount do not cancel naming', async () => {
  let resolveRequest;
  const h = await setup(() => new Promise(resolve => { resolveRequest = resolve; }));
  const id = h.chat.archiveCurrentMessages('room', '', true); await tick();
  // getArchives() rewrites messageCount from the V2 thread total while the copy is still persisting.
  h.chat.getArchives('room').find(a => a.id === id).messageCount = 99;
  resolveRequest('{"title":"海边漫步"}'); await tick();
  assert.equal(h.chat.getArchives('room').find(a => a.id === id).name, '海边漫步');
  h.runtime.dispose();
});

test('timeouts are failures; a user stop keeps its own status', async () => {
  const timeout = () => Promise.reject(Object.assign(new Error('Agent 执行超时，请稍后重试'), { name: 'AbortError' }));
  const h = await setup(timeout);
  const result = await h.runtime.run({ id: 'reply_scoring', context: h.context(), text: '一段。' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Agent 执行超时，请稍后重试');
  h.runtime.dispose();
  let rejectRequest;
  const s = await setup(({ signal }) => new Promise((_, reject) => { rejectRequest = reject; signal.addEventListener('abort', () => reject(Object.assign(new Error('目标或配置已变化，任务已停止'), { name: 'AbortError' }))); }));
  const pending = s.runtime.run({ id: 'reply_scoring', context: s.context(), text: '一段。' }); await tick();
  const [job] = s.runtime.list('reply_scoring');
  s.runtime.cancel(job.id);
  const stopped = await pending;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.reason, '已停止');
  assert.equal(s.runtime.list('reply_scoring')[0].message, '已停止');
  void rejectRequest;
  s.runtime.dispose();
});

test('trial runs use the configuration in effect, not the scope shown in the editor', async () => {
  const h = await setup(async () => '{"title":"不会运行"}');
  const record = h.configs.read('archive_naming', h.context());
  await h.configs.save({ ...record, scope: 'local', config: { ...record.config, enabled: false } });
  await h.configs.save({ id: 'archive_naming', context: h.context(), scope: 'global', config: { enabled: true, modelMode: 'profile', modelProfileId: 'selected' } });
  await assert.rejects(h.runtime.run({ id: 'archive_naming', context: h.context(), scope: 'global', text: '对话' }), /请先启用/);
  h.runtime.dispose();
});
