import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';
import { createUtilityAgentRuntime, parseArchiveTitle, parseUtilityJson } from '../../src/scripts/agent/utility-agent-runtime.js';
import { isStewardTaskEnabled, isStewardTaskReady, listReadyStewardCustomTasks, normalizeStewardCustomTasks, normalizeStewardTasks, resolveStewardTaskModelConfig, resolveStewardTaskRequestConfig, resolveStewardTranslationLanguage } from '../../src/scripts/agent/steward-tasks.js';
import { buildCustomTaskPayload, buildImageTagsPayload, buildTranslationPayload, parseImageTags, parseStewardText } from '../../src/scripts/agent/steward-text-tasks.js';
import { buildStickerKeywordPayload, cleanStickerKeyword, dedupeStickerKeywords, parseStickerKeywords, selectStickersForKeywords, stickerImageSource } from '../../src/scripts/agent/steward-sticker-tasks.js';

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
  for (const id of ['archive_naming']) assert.equal((await configs.save({ id, context: context(), scope: 'local', config: { enabled: true, modelMode: 'profile', modelProfileId: 'selected' } })).ok, true);
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
  const result = await h.runtime.run({ id: 'archive_naming', context: h.context(), text: '一段。' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Agent 执行超时，请稍后重试');
  h.runtime.dispose();
  let rejectRequest;
  const s = await setup(({ signal }) => new Promise((_, reject) => { rejectRequest = reject; signal.addEventListener('abort', () => reject(Object.assign(new Error('目标或配置已变化，任务已停止'), { name: 'AbortError' }))); }));
  const pending = s.runtime.run({ id: 'archive_naming', context: s.context(), text: '一段。' }); await tick();
  const [job] = s.runtime.list('archive_naming');
  s.runtime.cancel(job.id);
  const stopped = await pending;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.reason, '已停止');
  assert.equal(s.runtime.list('archive_naming')[0].message, '已停止');
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

test('steward config: legacy archive naming configs keep naming on; tasks carry their own switch and model', () => {
  const configs = createAgentConfigStore({ storage: null, saveKv: async () => true });
  const legacy = configs.read('archive_naming', { place: 'chat', scopeId: 'p', sessionId: 's' }).config;
  assert.deepEqual(legacy.tasks, {
    archive_naming: { enabled: true, modelProfileId: '' },
    archive_overview: { enabled: false, modelProfileId: '' },
    translate_message: { enabled: true, modelProfileId: '', targetLanguage: '' },
    image_tags: { enabled: true, modelProfileId: '' },
    sticker_keywords: { enabled: true, modelProfileId: '' },
    custom_tasks: { enabled: true, modelProfileId: '' },
  });
  assert.deepEqual(legacy.customTasks, []);
  assert.equal(isStewardTaskEnabled({ ...legacy, enabled: false }, 'archive_naming'), false, 'the steward switch gates every task');
  assert.equal(isStewardTaskEnabled({ ...legacy, enabled: true }, 'archive_naming'), true);
  assert.equal(isStewardTaskEnabled({ ...legacy, enabled: true, tasks: { archive_naming: { enabled: false } } }, 'archive_naming'), false);
  assert.equal(isStewardTaskEnabled({ ...legacy, enabled: true }, 'unknown'), false);
  const shared = { modelMode: 'profile', modelProfileId: 'small', tasks: { archive_naming: { enabled: true, modelProfileId: '' } } };
  assert.equal(resolveStewardTaskModelConfig(shared, 'archive_naming').modelProfileId, 'small');
  const override = { ...shared, tasks: { archive_naming: { enabled: true, modelProfileId: 'vision' } } };
  assert.equal(resolveStewardTaskModelConfig(override, 'archive_naming').modelProfileId, 'vision');
  assert.equal(override.modelProfileId, 'small', 'the shared model is not modified');
});

test('a switched-off naming task leaves archives alone while trial runs still work', async () => {
  let calls = 0;
  const h = await setup(async () => { calls++; return '{"title":"试运行名称"}'; });
  const record = h.configs.read('archive_naming', h.context());
  await h.configs.save({ ...record, config: { ...record.config, tasks: { archive_naming: { enabled: false } } } });
  const id = h.chat.archiveCurrentMessages('room', '', true); await tick();
  assert.equal(calls, 0);
  assert.notEqual(h.chat.getArchives('room').find(a => a.id === id).name, '试运行名称');
  const trial = await h.runtime.run({ id: 'archive_naming', context: h.context(), text: '对话' });
  assert.equal(trial.status, 'succeeded');
  const run = h.runtime.list('archive_naming').at(-1);
  assert.equal(run.taskId, 'archive_naming');
  assert.equal(run.taskTitle, '存档命名');
  assert.equal(run.previewOnly, true);
  h.runtime.dispose();
});

test('a task model override is the one captured for the request', async () => {
  const chat = Object.create(ChatStore.prototype);
  chat.scopeId = 'person'; chat.currentId = 'room'; chat._useV2 = false; chat._persist = () => {};
  chat.state = { sessions: { room: { messages: [{ id: 'm', role: 'user', content: '去看海' }], archives: [], summaries: [] } } };
  const context = () => ({ place: 'chat', scopeId: 'person', sessionId: 'room' });
  const configs = createAgentConfigStore({ storage: null, saveKv: async () => true });
  await configs.save({ id: 'archive_naming', context: context(), scope: 'local', config: { enabled: true, modelMode: 'profile', modelProfileId: 'small', tasks: { archive_naming: { modelProfileId: 'naming-model' } } } });
  const captured = [];
  const runtime = createUtilityAgentRuntime({ chatStore: chat, configStore: configs, getContext: context,
    captureModel: async config => { captured.push(config.modelProfileId); return { model: 'm' }; }, request: async () => '{"title":"看海"}' });
  const id = chat.archiveCurrentMessages('room', '', true); await tick(); await tick();
  assert.deepEqual(captured, ['naming-model']);
  assert.equal(chat.getArchives('room').find(a => a.id === id).name, '看海');
  runtime.dispose();
});

test('steward text tasks: target language, output limits and readiness', () => {
  assert.equal(resolveStewardTranslationLanguage('', 'zh-TW').id, 'zh-TW', 'follows the interface language');
  assert.equal(resolveStewardTranslationLanguage('', 'en').prompt, 'English');
  assert.equal(resolveStewardTranslationLanguage('ja', 'en').id, 'ja', 'an explicit choice wins');
  assert.equal(resolveStewardTranslationLanguage('', 'pseudo').id, 'zh-CN');
  assert.equal(normalizeStewardTasks({ translate_message: { targetLanguage: 'xx' } }).translate_message.targetLanguage, '');
  const config = { enabled: true, modelMode: 'profile', modelProfileId: 'small', maxTokens: 128, tasks: normalizeStewardTasks({}) };
  assert.equal(resolveStewardTaskRequestConfig(config, 'archive_naming').maxTokens, 128, 'naming keeps its adjustable limit');
  assert.equal(resolveStewardTaskRequestConfig(config, 'translate_message').maxTokens, 4096);
  assert.equal(resolveStewardTaskRequestConfig(config, 'image_tags').maxTokens, 600);
  assert.equal(isStewardTaskReady(config, 'translate_message'), true);
  assert.equal(isStewardTaskReady({ ...config, modelProfileId: '' }, 'translate_message'), false, 'no shared model, no entry');
  assert.equal(isStewardTaskReady({ ...config, tasks: normalizeStewardTasks({ image_tags: { enabled: false } }) }, 'image_tags'), false);
  const translation = buildTranslationPayload({ text: 'Hello', language: resolveStewardTranslationLanguage('', 'zh-CN') });
  assert.match(translation.messages[0].content, /Simplified Chinese/);
  assert.equal(translation.messages[1].content, 'Hello');
  assert.equal(buildTranslationPayload({ text: 'x'.repeat(20000) }).messages[1].content.length, 12000);
  assert.match(buildImageTagsPayload({ text: '海边的女孩' }).messages[0].content, /comma/);
  assert.equal(parseStewardText('<think>hm</think>\n```\n你好\n```'), '你好');
  assert.throws(() => parseStewardText('<think>only thinking</think>'), /没有返回内容/);
  assert.equal(parseImageTags('1. 1girl\n- beach, (sunset:1.2)，smile,'), '1girl, beach, (sunset:1.2), smile');
});

test('manual steward tasks run once per target, need their switch, and stop when the target goes away', async () => {
  let resolveRequest, calls = 0;
  const h = await setup(() => { calls++; return new Promise(resolve => { resolveRequest = resolve; }); });
  const run = (extra = {}) => h.runtime.runTask({ taskId: 'translate_message', context: h.context(), targetKey: 'room:m',
    payload: buildTranslationPayload({ text: 'hi' }), parse: parseStewardText, ...extra });
  assert.equal(h.runtime.isTaskReady('translate_message', h.context()), true);
  const first = run(); await tick();
  await assert.rejects(run(), /正在处理/, 'the same message is not translated twice at once');
  resolveRequest('你好'); const done = await first;
  assert.equal(done.status, 'succeeded'); assert.equal(done.result, '你好'); assert.equal(calls, 1);
  assert.equal(h.runtime.list('archive_naming').at(-1).taskTitle, '消息翻译');
  let alive = true;
  const stale = run({ targetCurrent: () => alive }); await tick();
  alive = false; resolveRequest('不该写回'); const stopped = await stale;
  assert.equal(stopped.status, 'cancelled');
  await assert.rejects(h.runtime.runTask({ taskId: 'archive_naming', context: h.context(), payload: {}, parse: String }), /没有这个任务/);
  const record = h.configs.read('archive_naming', h.context());
  await h.configs.save({ ...record, config: { ...record.config, tasks: { translate_message: { enabled: false } } } });
  assert.equal(h.runtime.isTaskReady('translate_message', h.context()), false);
  await assert.rejects(run(), /开启小管家与这个任务/);
  h.runtime.dispose();
});

test('sticker keywords: which stickers, the image request, parsing and de-duplication', () => {
  const pack = { stickers: [
    { id: 'a', keyword: '开心', path: 'a.png' },
    { id: 'b', keyword: '', dataUrl: 'data:image/png;base64,AAA' },
    { id: 'c', keyword: '  ', frames: ['f1.png', 'f2.png'] },
    { id: '', keyword: '' },
  ] };
  assert.deepEqual(selectStickersForKeywords(pack).map(item => item.id), ['b', 'c'], 'only stickers without a keyword');
  assert.deepEqual(selectStickersForKeywords(pack, { all: true }).map(item => item.id), ['a', 'b', 'c']);
  assert.equal(stickerImageSource(pack.stickers[1]), 'data:image/png;base64,AAA');
  assert.equal(stickerImageSource(pack.stickers[2]), 'f1.png', 'animated stickers use their first frame');
  const payload = buildStickerKeywordPayload({ images: [{ url: 'data:a' }, { url: 'data:b' }], language: { prompt: 'Japanese' }, avoid: ['开心', '开心', ''] });
  assert.match(payload.messages[0].content, /2 sticker images/);
  assert.match(payload.messages[0].content, /Japanese/);
  assert.match(payload.messages[0].content, /existing keywords: 开心\./);
  assert.deepEqual(payload.messages[1].content.map(part => part.type), ['text', 'image_url', 'text', 'image_url']);
  assert.equal(payload.messages[1].content[3].image_url.url, 'data:b');
  assert.deepEqual(parseStickerKeywords('```json\n{"keywords":["委屈 [哭]","生气\\n跺脚"]}\n```', 2), ['委屈 哭', '生气 跺脚']);
  assert.throws(() => parseStickerKeywords('{"keywords":["一个"]}', 2), /数量不对/);
  assert.throws(() => parseStickerKeywords('{"keywords":["好", "[]"]}', 2), /空的关键词/);
  assert.equal([...cleanStickerKeyword('一'.repeat(40))].length, 24);
  assert.deepEqual(dedupeStickerKeywords(['开心', '开心', '晚安'], ['开心', 'Hello']), ['开心2', '开心3', '晚安']);
  assert.deepEqual(dedupeStickerKeywords(['hello'], ['Hello']), ['hello2'], 'matching ignores case like sticker lookup');
});

test('a model check can stop a steward task before the request is sent', async () => {
  let calls = 0;
  const h = await setup(async () => { calls++; return '{"keywords":["好"]}'; });
  const outcome = await h.runtime.runTask({ taskId: 'sticker_keywords', context: h.context(), payload: { messages: [] },
    parse: raw => parseStickerKeywords(raw, 1), checkModel: () => { throw new Error('模型不能看图'); } });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, '模型不能看图');
  assert.equal(calls, 0);
  const ok = await h.runtime.runTask({ taskId: 'sticker_keywords', context: h.context(), payload: { messages: [] }, parse: raw => parseStickerKeywords(raw, 1) });
  assert.deepEqual(ok.result, ['好']);
  assert.equal(h.runtime.list('archive_naming').at(-1).title, '好');
  h.runtime.dispose();
});

test('archive overview: written on save and when leaving with new messages, skipped otherwise', async () => {
  const replies = ['两人去海边散步', '散步后在灯塔下约好明天见'];
  const requests = [];
  const h = await setup(async ({ request }) => { requests.push(request.messages[1].content); return replies[requests.length - 1]; });
  // 默认关：小管家开着但概述任务没开时不写
  h.chat.state.sessions.room.messages.push({ id: 'u1', role: 'user', content: '去散步吧' });
  const quiet = h.chat.archiveCurrentMessages('room', '已命名', true); await tick();
  assert.equal(h.chat.getArchives('room').find(a => a.id === quiet).stewardOverview, undefined);
  assert.equal(requests.length, 0);
  const record = h.configs.read('archive_naming', h.context());
  await h.configs.save({ ...record, config: { ...record.config, tasks: { archive_naming: { enabled: false }, archive_overview: { enabled: true } } } });
  // 保存存档：按当下的对话写概述
  const id = h.chat.archiveCurrentMessages('room', '海边', true); await tick(); await tick();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /一起去海边散步/);
  const first = h.chat.getArchives('room').find(a => a.id === id).stewardOverview;
  assert.equal(first.text, '两人去海边散步');
  assert.equal(first.messageCount, 2);
  // 离开聊天室：当前聊天挂着这个存档、没有新消息 → 不重写
  h.chat.state.sessions.room.currentArchiveId = id;
  h.runtime.noteSessionLeft('room'); await tick();
  assert.equal(requests.length, 1);
  // 有新消息 → 更新
  h.chat.state.sessions.room.messages.push({ id: 'a2', role: 'assistant', content: '在灯塔下约好明天见。' });
  h.chat.state.sessions.room.archives.find(a => a.id === id).messageCount = 3;
  h.runtime.noteSessionLeft('room'); await tick(); await tick();
  assert.equal(requests.length, 2);
  assert.equal(h.chat.getArchives('room').find(a => a.id === id).stewardOverview.text, '散步后在灯塔下约好明天见');
  assert.equal(h.runtime.list('archive_naming').at(-1).taskTitle, '存档概述');
  // 没挂存档的当前聊天不写；导入的存档也不按当前聊天写
  h.chat.state.sessions.room.currentArchiveId = null;
  h.runtime.noteSessionLeft('room'); await tick();
  assert.equal(requests.length, 2);
  h.chat.state.sessions.room.archives.push({ id: 'imported', name: '导入', timestamp: 1, messageCount: 9 });
  h.chat._emitArchiveEvent({ type: 'created', sessionId: 'room', archiveId: 'imported', automaticName: false, imported: true }); await tick();
  assert.equal(requests.length, 2, 'an imported archive is not described from the current chat');
  h.runtime.dispose();
});

test('naming and overview run together on a new archive; the naming rename does not cancel the overview', async () => {
  const h = await setup(async ({ request }) => (/JSON/.test(request.messages[0].content) ? '{"title":"海边漫步"}' : '一起去海边散步'));
  const record = h.configs.read('archive_naming', h.context());
  await h.configs.save({ ...record, config: { ...record.config, tasks: { archive_overview: { enabled: true } } } });
  h.chat.state.sessions.room.messages.push({ id: 'u1', role: 'user', content: '走吧' });
  const id = h.chat.archiveCurrentMessages('room', '', true);
  for (let i = 0; i < 6; i += 1) await tick();
  const archive = h.chat.getArchives('room').find(a => a.id === id);
  assert.equal(archive.name, '海边漫步');
  assert.equal(archive.stewardOverview?.text, '一起去海边散步');
  assert.deepEqual(h.runtime.list('archive_naming').map(run => `${run.taskId}:${run.status}`), ['archive_naming:succeeded', 'archive_overview:succeeded']);
  h.chat.renameArchive(id, '手动改名', 'room');
  assert.equal(h.chat.getArchives('room').find(a => a.id === id).stewardOverview?.text, '一起去海边散步', 'a manual rename keeps the overview');
  h.runtime.dispose();
});

test('custom tasks: normalized, limited, and only ready ones with a prompt are offered', () => {
  const tasks = normalizeStewardCustomTasks([
    { id: 'ct_abcd1234', name: '润色', input: 'input', output: 'input', prompt: '改得更口语', recentCount: 99 },
    { id: 'bad id', name: '', input: 'nope', output: 'nope', prompt: '' },
    { id: 'ct_abcd1234', name: '重复', prompt: 'x', enabled: false },
    ...Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, prompt: 'p' })),
  ]);
  assert.equal(tasks.length, 12);
  assert.deepEqual(tasks[0], { id: 'ct_abcd1234', name: '润色', input: 'input', recentCount: 30, prompt: '改得更口语', output: 'input', enabled: true });
  assert.equal(tasks[1].id, 'ct_auto2');
  assert.equal(tasks[1].input, 'message');
  assert.equal(tasks[1].output, 'popup');
  assert.equal(tasks[1].name, '自定义任务');
  assert.notEqual(tasks[2].id, 'ct_abcd1234', 'duplicate ids are made unique');
  const config = { enabled: true, modelMode: 'profile', modelProfileId: 'm', tasks: normalizeStewardTasks({}), customTasks: tasks.slice(0, 3) };
  assert.deepEqual(listReadyStewardCustomTasks(config).map(task => task.name), ['润色'], 'needs a prompt and its own switch on');
  assert.deepEqual(listReadyStewardCustomTasks({ ...config, tasks: normalizeStewardTasks({ custom_tasks: { enabled: false } }) }), []);
  const payload = buildCustomTaskPayload({ prompt: '  改得更口语  ', text: 'x'.repeat(13000) });
  assert.match(payload.messages[0].content, /^改得更口语\n\nThe user message is the material/);
  assert.equal(payload.messages[1].content.length, 12000, 'keeps the latest part of long material');
});
