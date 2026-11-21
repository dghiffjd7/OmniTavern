import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// 酒馆后端接口模拟第 3 步：脚本单独调用 /api/backends/chat-completions/generate。
// 模型客户端、确认窗、KV 都用替身；脚本片段为测试合成。

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value ?? '')); }
  removeItem(key) { this.map.delete(String(key)); }
}
globalThis.localStorage = globalThis.localStorage || new MemoryStorage();
globalThis.window = globalThis.window || { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => (delay === 1000 ? 0 : realSetTimeout(fn, delay, ...args));
const { buildScriptRuntimeWorkerSourceForTests, ScriptRuntime } = await import('../../src/scripts/plugins/script-runtime.js');
const { appSettings } = await import('../../src/scripts/storage/app-settings.js');
const { createTavernApiRouter } = await import('../../src/scripts/plugins/tavern-api-router.js');
const {
  createTavernGenerateHandler, buildTavernGenerateOptions, buildScriptModelConsentDialog, TAVERN_GENERATE_PATH,
} = await import('../../src/scripts/plugins/tavern-api-generate.js');
const {
  createScriptModelConsentStore, fingerprintScriptCode, getScriptModelConsentStore, SCRIPT_MODEL_CONSENT_STORE_KEY,
} = await import('../../src/scripts/storage/script-model-consent-store.js');
const { makePresetRequestBody } = await import('../../src/scripts/plugins/preset-request-transport.js');
const { createScriptModelCallRunTracker, SCRIPT_GENERATION_RUN_KIND } = await import('../../src/scripts/plugins/script-model-call-run.js');
const { normalizeAgentUsage } = await import('../../src/scripts/agent/agent-events.js');
globalThis.setTimeout = realSetTimeout;

const tick = (ms = 0) => new Promise(resolve => realSetTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const abortableWait = signal => new Promise((_, reject) => {
  const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (signal?.aborted) fail();
  else signal?.addEventListener('abort', fail, { once: true });
});

const makeClient = ({ chat = null, stream = null, models = ['main-model', 'alt-model'], label = 'main' } = {}) => {
  const calls = { chat: [], stream: [], listModels: 0 };
  return {
    label,
    calls,
    listModels: async () => {
      calls.listModels += 1;
      if (models instanceof Error) throw models;
      return models;
    },
    chat: async (messages, options) => {
      calls.chat.push({ messages, options });
      return chat ? chat(messages, options) : 'reply text';
    },
    async *streamChat(messages, options) {
      calls.stream.push({ messages, options });
      if (stream) { yield* stream(messages, options); return; }
      yield 'he';
      yield 'llo';
    },
  };
};

const makeKv = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  const saves = [];
  return {
    data,
    saves,
    loadKv: async name => (data.has(name) ? structuredClone(data.get(name)) : {}),
    saveKv: async (name, value) => { saves.push(structuredClone(value)); data.set(name, structuredClone(value)); },
  };
};

const SCRIPTS = {
  dream: { id: 'dream', name: '异步世界', content: 'code v1', scope: 'character', scopeId: 'char-1', sourceName: 'Milla' },
  izumi: { id: 'izumi', name: '悬浮窗', content: 'izumi code', scope: 'preset', scopeId: 'preset-1', sourceName: 'Izumi' },
  global: { id: 'global', name: '全局工具', content: 'global code', scope: 'global', scopeId: 'global', sourceName: '' },
};

const makeHandler = ({
  client = makeClient(), scripts = SCRIPTS, answers = ['approve'], confirm = null, kv = makeKv(), now = () => 1_700_000_000_000,
  connection = {}, createClient = null, runTracker = null,
} = {}) => {
  const dialogs = [];
  const posts = [];
  const logs = [];
  const created = [];
  const handler = createTavernGenerateHandler({
    resolveConnection: async () => ({
      config: { provider: 'custom', model: 'main-model', apiKey: 'sk-secret', baseUrl: 'https://key.example/v1' },
      client,
      createClient: createClient || ((model) => {
        created.push(model);
        return makeClient({ label: model });
      }),
      cacheKey: 'profile-1',
      profileName: '测试连线',
      ...connection,
    }),
    findScript: ({ scriptId }) => (scripts[scriptId] ? { ...scripts[scriptId] } : null),
    consentStore: createScriptModelConsentStore({ loadKv: kv.loadKv, saveKv: kv.saveKv }),
    confirm: confirm || (async (options) => {
      dialogs.push(options);
      return answers.length ? answers.shift() : 'approve';
    }),
    runTracker,
    postStream: message => posts.push(message),
    log: entry => logs.push(entry),
    now,
  });
  return { handler, dialogs, posts, logs, created, kv, client };
};

let requestSeq = 0;
const ask = (handler, { body = {}, scriptId = 'dream', access = {}, requestId = `r${++requestSeq}` } = {}) => handler.handle({
  path: TAVERN_GENERATE_PATH,
  scriptId,
  scriptName: SCRIPTS[scriptId]?.name || '',
  requestId,
  body: { messages: [{ role: 'user', content: 'hi' }], ...body },
}, { allowNetwork: true, sessionId: 's1', ...access });

const waitForEnd = async (posts, requestId) => {
  for (let i = 0; i < 100; i += 1) {
    if (posts.some(msg => msg.id === requestId && msg.event === 'end')) return;
    await tick(1);
  }
  throw new Error('stream did not end');
};
const sseEvents = (posts, requestId) => posts
  .filter(msg => msg.id === requestId && msg.event === 'data')
  .map(msg => msg.data)
  .join('')
  .split('\n\n')
  .filter(Boolean)
  .map(block => block.replace(/^data: /, ''))
  .map(text => (text === '[DONE]' ? text : JSON.parse(text)));

test('同意流程：第一次弹窗，同意后记住、不再弹；重开 APP 不再问；代码改了再问', async () => {
  const kv = makeKv();
  const first = makeHandler({ kv });
  const result = await ask(first.handler);
  assert.equal(result.status, 200);
  assert.equal(first.dialogs.length, 1);
  const dialog = first.dialogs[0];
  assert.equal(dialog.title, '脚本要单独调用模型');
  assert.match(dialog.message, /「异步世界」（来自角色卡「Milla」）要用当前会话的连线「测试连线」调用模型 main-model/);
  assert.match(dialog.message, /每次调用都会产生费用/);
  assert.match(dialog.message, /同意后，这个脚本之后调用模型不再询问；脚本代码更新后会再询问一次/);
  assert.deepEqual(dialog.actions, [{ id: 'deny', label: '拒绝' }, { id: 'approve', label: '同意', primary: true }]);

  await ask(first.handler);
  assert.equal(first.dialogs.length, 1, 'approved scripts are not asked again');
  assert.equal(first.client.calls.chat.length, 2);

  // 持久化：KV 里一笔，带代码指纹
  const saved = kv.data.get(SCRIPT_MODEL_CONSENT_STORE_KEY);
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.grants), ['dream']);
  assert.equal(saved.grants.dream.fingerprint, await fingerprintScriptCode('code v1'));
  assert.equal(saved.grants.dream.scope, 'character');
  assert.equal(saved.grants.dream.sourceName, 'Milla');

  // 重开 APP（新的处理器、同一份 KV）
  const reopened = makeHandler({ kv });
  assert.equal((await ask(reopened.handler)).status, 200);
  assert.equal(reopened.dialogs.length, 0);

  // 代码改了：再问一次
  const edited = makeHandler({ kv, scripts: { ...SCRIPTS, dream: { ...SCRIPTS.dream, content: 'code v2' } } });
  assert.equal((await ask(edited.handler)).status, 200);
  assert.equal(edited.dialogs.length, 1);
});

test('同意记录可列出与撤销；撤销后再调用会再问', async () => {
  const kv = makeKv();
  const store = createScriptModelConsentStore({ loadKv: kv.loadKv, saveKv: kv.saveKv, now: () => 5 });
  await store.grant({ scriptId: 'a', scriptName: 'A', scope: 'preset', scopeId: 'p', sourceName: 'P', fingerprint: 'sha256:x' });
  assert.deepEqual(await store.list(), [
    { scriptId: 'a', scriptName: 'A', scope: 'preset', scopeId: 'p', sourceName: 'P', fingerprint: 'sha256:x', grantedAt: 5 },
  ]);
  assert.equal(await store.isGranted('a', 'sha256:x'), true);
  assert.equal(await store.isGranted('a', 'sha256:y'), false);
  assert.equal(await store.revoke('a'), true);
  assert.equal(await store.revoke('a'), false);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(kv.data.get(SCRIPT_MODEL_CONSENT_STORE_KEY).grants, {});
});

test('拒绝：回 403＋中文说明，不发请求；这次运行同一脚本不再弹窗；重开 APP 再问', async () => {
  const kv = makeKv();
  const { handler, dialogs, client } = makeHandler({ kv, answers: ['deny'] });
  const denied = await ask(handler);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /用户没有同意这个脚本单独调用模型/);
  assert.match(denied.body.error.message, /重开 APP 后，脚本再次调用时会重新询问/);
  const again = await ask(handler);
  assert.equal(again.status, 403);
  assert.equal(dialogs.length, 1, 'no second dialog in the same run');
  assert.equal(client.calls.chat.length, 0);
  assert.equal(kv.saves.length, 0);

  const reopened = makeHandler({ kv, answers: ['approve'] });
  assert.equal((await ask(reopened.handler)).status, 200);
  assert.equal(reopened.dialogs.length, 1);
});

test('并发：同一脚本同时多个请求只弹一次；不同脚本的确认窗依序出现', async () => {
  const gate = deferred();
  const opened = [];
  const { handler, client } = makeHandler({
    confirm: async (options) => {
      opened.push(options.message);
      await gate.promise;
      return 'approve';
    },
  });
  const pending = [ask(handler), ask(handler), ask(handler, { scriptId: 'izumi' })];
  await tick(5);
  assert.equal(opened.length, 1, 'the second script waits for the first dialog');
  gate.resolve();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(item => item.status), [200, 200, 200]);
  assert.equal(opened.length, 2);
  assert.match(opened[0], /异步世界/);
  assert.match(opened[1], /悬浮窗.*来自预设「Izumi」/);
  assert.equal(client.calls.chat.length, 3);
});

test('权限与脚本：没有「访问网络」回 403；认不出脚本回 403；缺 messages 回 400；都不弹窗、不发请求', async () => {
  const { handler, dialogs, client } = makeHandler();
  const noNetwork = await ask(handler, { access: { allowNetwork: false } });
  assert.equal(noNetwork.status, 403);
  assert.match(noNetwork.body.error.message, /允许脚本访问网络/);
  const unknown = await ask(handler, { scriptId: 'missing' });
  assert.equal(unknown.status, 403);
  assert.match(unknown.body.error.message, /认不出是哪个脚本/);
  const empty = await handler.handle({ scriptId: 'dream', body: { messages: [] } }, { allowNetwork: true, sessionId: 's1' });
  assert.equal(empty.status, 400);
  assert.equal(dialogs.length, 0);
  assert.equal(client.calls.chat.length + client.calls.listModels, 0);
});

test('模型选择：清单里有就照用；没有或没指定用连线的模型并留记录；清单在一段时间内缓存', async () => {
  let clock = 1_000_000;
  const { handler, client, created, logs } = makeHandler({ now: () => clock });

  const picked = await ask(handler, { body: { model: 'alt-model' } });
  assert.equal(picked.body.model, 'alt-model');
  assert.deepEqual(created, ['alt-model']);
  assert.equal(client.calls.chat.length, 0, 'the alternate model is sent through its own client');

  const missing = await ask(handler, { body: { model: 'gone-model' } });
  assert.equal(missing.body.model, 'main-model');
  const note = logs.find(entry => entry.type === 'warn' && /gone-model/.test(entry.message));
  assert.match(note.message, /脚本「异步世界」指定的模型 gone-model 不在当前会话连线的模型清单里，这次改用连线的模型 main-model/);
  await ask(handler, { body: { model: 'gone-model' } });
  assert.equal(logs.filter(entry => /gone-model/.test(entry.message)).length, 1, 'the same substitution is noted once per run');

  const unspecified = await ask(handler);
  assert.equal(unspecified.body.model, 'main-model');
  assert.ok(logs.some(entry => /没有指定模型，用当前会话连线的模型 main-model/.test(entry.message)));

  assert.equal(client.calls.listModels, 1, 'model list is cached');
  clock += 5 * 60 * 1000 + 1;
  await ask(handler, { body: { model: 'alt-model' } });
  assert.equal(client.calls.listModels, 2, 'cache expires');

  // 读不到清单：无法确认，改用连线的模型
  const failing = makeHandler({ client: makeClient({ models: new Error('401 https://secret.example') }) });
  const fallback = await ask(failing.handler, { body: { model: 'alt-model' } });
  assert.equal(fallback.body.model, 'main-model');
  assert.ok(failing.logs.some(entry => /读不到当前会话连线的模型清单/.test(entry.message)));
  assert.doesNotMatch(JSON.stringify(failing.logs), /secret\.example/);
});

test('请求体里的 Key、地址、反代、自订网址都不用；只取生成参数', async () => {
  const { handler, client } = makeHandler();
  const result = await ask(handler, { body: {
    model: 'main-model',
    temperature: 0.3, max_tokens: 100, top_p: 0.8, stop: ['END'],
    reverse_proxy: 'https://proxy.example', proxy_password: 'pw', custom_url: 'https://custom.example',
    api_key_openai: 'sk-body', chat_completion_source: 'openai', secret_id: 'x', seed: 7,
  } });
  assert.equal(result.status, 200);
  const [call] = client.calls.chat;
  assert.deepEqual(call.messages, [{ role: 'user', content: 'hi' }]);
  const plain = Object.fromEntries(Object.entries(call.options).filter(([, value]) => typeof value !== 'function' && !(value instanceof AbortSignal)));
  assert.deepEqual(plain, { temperature: 0.3, max_tokens: 100, top_p: 0.8, stop: ['END'] });
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(call.options), /proxy|custom\.example|sk-body|pw/);

  // 各家参数名
  assert.deepEqual(buildTavernGenerateOptions({ max_tokens: 50, stop: 'X' }, { provider: 'anthropic' }), { maxTokens: 50, stop_sequences: ['X'] });
  assert.deepEqual(buildTavernGenerateOptions({ max_completion_tokens: 60, stop: ['X'] }, { provider: 'gemini' }), { maxTokens: 60 });
  const tool = { type: 'function', function: { name: 'roll', description: 'd', parameters: { type: 'object', properties: {} } } };
  assert.deepEqual(buildTavernGenerateOptions({ tools: [tool], tool_choice: 'auto' }, { provider: 'deepseek' }), { tools: [tool], tool_choice: 'auto' });
  const gemini = buildTavernGenerateOptions({ tools: [tool], tool_choice: 'required' }, { provider: 'makersuite' });
  assert.deepEqual(gemini.tools, [{ functionDeclarations: [tool.function] }]);
  assert.equal(gemini.toolConfig.functionCallingConfig.mode, 'ANY');
  const claude = buildTavernGenerateOptions({ tools: [tool], tool_choice: { type: 'function', function: { name: 'roll' } } }, { provider: 'anthropic' });
  assert.deepEqual(claude.tools, [{ name: 'roll', description: 'd', input_schema: { type: 'object', properties: {} } }]);
  assert.deepEqual(claude.tool_choice, { type: 'tool', name: 'roll' });
});

test('非流式：回 OpenAI chat.completion 形状，带用量与工具调用', async () => {
  const usage = { provider: 'custom', model: 'main-model', finishReason: 'stop', promptTokens: 12, completionTokens: 5, totalTokens: 17 };
  const { handler, logs } = makeHandler({ client: makeClient({ chat: (_messages, options) => {
    options.onProviderUsage(usage);
    return 'hello';
  } }) });
  const result = await ask(handler);
  assert.equal(result.status, 200);
  const { id, created, ...rest } = result.body;
  assert.match(id, /^chatcmpl-/);
  assert.equal(created, 1_700_000_000);
  assert.deepEqual(rest, {
    object: 'chat.completion',
    model: 'main-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  });
  // 用量记进调试执行日志
  assert.ok(logs.some(entry => entry.type === 'info' && entry.message === '脚本「异步世界」单独调用模型 main-model：输入 12 tokens，输出 5 tokens'));

  const toolCall = { id: 'call_1', type: 'function', function: { name: 'roll', arguments: '{"n":2}' } };
  const tools = makeHandler({ client: makeClient({ chat: (_messages, options) => {
    options.onProviderToolCallDelta({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] },
      { provider: 'custom', model: 'main-model' });
    return '';
  } }) });
  const called = await ask(tools.handler, { body: { tools: [{ type: 'function', function: { name: 'roll', parameters: {} } }] } });
  assert.deepEqual(called.body.choices[0].message.tool_calls, [toolCall]);
  assert.equal(called.body.choices[0].finish_reason, 'tool_calls');
  assert.equal(called.body.usage, undefined, 'usage is left out when the connection does not report it');
  assert.ok(tools.logs.some(entry => /连线没有回报用量/.test(entry.message)));
});

test('流式：先回 { stream: true }，分块是酒馆（OpenAI）格式的 data: 行，最后 [DONE]', async () => {
  const { handler, posts, logs } = makeHandler({ client: makeClient({ stream: async function* (_messages, options) {
    yield { __chatappStream: true, kind: 'reasoning', text: 'think' };
    yield 'Hel';
    yield 'lo';
    options.onProviderUsage({ finishReason: 'length', promptTokens: 3, completionTokens: 2 });
  } }) });
  const result = await ask(handler, { body: { stream: true }, requestId: 'stream-1' });
  assert.deepEqual(result, { status: 200, stream: true });
  await waitForEnd(posts, 'stream-1');
  const events = sseEvents(posts, 'stream-1');
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1);
  assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk' && chunk.model === 'main-model'));
  assert.deepEqual(chunks.map(chunk => chunk.choices[0]?.delta ?? null), [
    { role: 'assistant', reasoning_content: 'think' },
    { content: 'Hel' },
    { content: 'lo' },
    {},
    null,
  ]);
  assert.equal(chunks[3].choices[0].finish_reason, 'length');
  assert.deepEqual(chunks[4].usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.ok(logs.some(entry => /输入 3 tokens，输出 2 tokens/.test(entry.message)));
});

test('流式工具调用：tool_calls 以 delta 送出，结束原因是 tool_calls', async () => {
  const { handler, posts } = makeHandler({ client: makeClient({ stream: async function* (_messages, options) {
    const meta = { provider: 'custom', model: 'main-model' };
    options.onProviderToolCallDelta({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'roll', arguments: '' } }] } }] }, meta);
    options.onProviderToolCallDelta({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"n":1}' } }] } }] }, meta);
    yield '';
  } }) });
  await ask(handler, { body: { stream: true, tools: [{ type: 'function', function: { name: 'roll', parameters: {} } }] }, requestId: 'tools-1' });
  await waitForEnd(posts, 'tools-1');
  const chunks = sseEvents(posts, 'tools-1').filter(item => item !== '[DONE]');
  assert.deepEqual(chunks[0].choices[0].delta, {
    role: 'assistant', tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'roll', arguments: '' } }],
  });
  assert.deepEqual(chunks[1].choices[0].delta, { tool_calls: [{ index: 0, function: { arguments: '{"n":1}' } }] });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('错误：照酒馆回 { error: { message } }，只说 HTTP 状态，不带上游原文', async () => {
  const leak = Object.assign(new Error('OpenAI API Error: 401 - invalid key sk-123 at https://secret.example/v1'), { status: 401 });
  const { handler, logs } = makeHandler({ client: makeClient({ chat: () => { throw leak; } }) });
  const result = await ask(handler);
  assert.equal(result.status, 502);
  assert.equal(result.body.error.message, '模型请求没有成功（上游回应 HTTP 401）：请到 APP 的 API 设置确认当前会话的连线能正常使用。');
  assert.doesNotMatch(JSON.stringify({ result, logs }), /sk-123|secret\.example/);

  // 流式：第一段输出前失败回 JSON；之后失败在流里送错误并结束（没有 [DONE]）
  const early = makeHandler({ client: makeClient({ stream: async function* () { throw leak; } }) });
  const earlyResult = await ask(early.handler, { body: { stream: true }, requestId: 'early-1' });
  assert.equal(earlyResult.status, 502);
  assert.equal(early.posts.length, 0);
  const late = makeHandler({ client: makeClient({ stream: async function* () { yield 'part'; throw new Error('socket closed https://secret.example'); } }) });
  assert.equal((await ask(late.handler, { body: { stream: true }, requestId: 'late-1' })).stream, true);
  await waitForEnd(late.posts, 'late-1');
  const events = sseEvents(late.posts, 'late-1');
  assert.deepEqual(events.at(-1), { error: { message: '模型请求没有成功：请到 APP 的 API 设置确认当前会话的连线能正常使用。' } });
  assert.ok(!events.includes('[DONE]'));
  assert.doesNotMatch(JSON.stringify(late.posts), /secret\.example/);
});

test('取消：中止上游请求（非流式、流式、等同意时）', async () => {
  let seenSignal = null;
  const { handler } = makeHandler({ client: makeClient({ chat: (_messages, options) => {
    seenSignal = options.signal;
    return abortableWait(options.signal);
  } }) });
  const pending = ask(handler, { requestId: 'cancel-1' });
  await tick(5);
  assert.equal(handler.cancel('cancel-1'), true);
  const result = await pending;
  assert.equal(seenSignal.aborted, true);
  assert.equal(result.status, 499);
  assert.equal(handler.cancel('cancel-1'), false, 'finished requests are forgotten');

  let streamSignal = null;
  const streaming = makeHandler({ client: makeClient({ stream: async function* (_messages, options) {
    streamSignal = options.signal;
    yield 'first';
    await abortableWait(options.signal);
  } }) });
  assert.equal((await ask(streaming.handler, { body: { stream: true }, requestId: 'cancel-2' })).stream, true);
  streaming.handler.cancel('cancel-2');
  await waitForEnd(streaming.posts, 'cancel-2');
  assert.equal(streamSignal.aborted, true);
  assert.ok(!sseEvents(streaming.posts, 'cancel-2').includes('[DONE]'));

  // 等用户同意时取消：同意后也不发请求
  const gate = deferred();
  const waiting = makeHandler({ confirm: async () => { await gate.promise; return 'approve'; } });
  const asked = ask(waiting.handler, { requestId: 'cancel-3' });
  await tick(5);
  waiting.handler.cancel('cancel-3');
  gate.resolve();
  assert.equal((await asked).status, 499);
  assert.equal(waiting.client.calls.chat.length, 0);
});

test('路由：生成接口交 generate；没有接上时照旧回 501', async () => {
  const seen = [];
  const router = createTavernApiRouter({ generate: async (request, access) => { seen.push([request.requestId, access.sessionId]); return { status: 200, body: { ok: true } }; } });
  const result = await router.handle({ path: TAVERN_GENERATE_PATH, requestId: 'x', body: {} }, { allowNetwork: true, sessionId: 's9' });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.deepEqual(seen, [['x', 's9']]);
  const gaps = [];
  const bare = createTavernApiRouter({ recordGap: gap => gaps.push(gap) });
  assert.equal((await bare.handle({ path: TAVERN_GENERATE_PATH, body: {} }, {})).status, 501);
  assert.equal(gaps.length, 1);
});

// 照 tavern-api-router-tests 在 vm 里跑整个 Worker；tavern.request／tavern.cancel 交给真的路由与处理器
const ORIGIN = 'http://tauri.localhost';
const createWorker = ({ handler, rpcDelay = 0 } = {}) => {
  const rpcCalls = [];
  const router = createTavernApiRouter({ generate: (request, access) => handler.handle(request, access) });
  const sandbox = {
    console, structuredClone, setTimeout, clearTimeout, queueMicrotask, Date, Math, JSON, RegExp, Error, Promise,
    Map, WeakMap, Set, Array, Object, String, Number, Boolean, URL, AbortController, Response, ReadableStream,
    TextEncoder, TextDecoder, DOMException, encodeURIComponent, decodeURIComponent,
    location: { origin: ORIGIN, href: `blob:${ORIGIN}/worker` },
    importScripts: () => { throw new Error('blocked in test'); },
    postMessage: (msg) => {
      if (msg?.type !== 'rpc') return;
      rpcCalls.push(msg);
      const access = { allowNetwork: true, allowReadMessages: true, sessionId: 's1' };
      const result = msg.method === 'tavern.request'
        ? router.handle(structuredClone(msg.params), access)
        : msg.method === 'tavern.cancel' ? handler.cancel(msg.params.requestId)
          : (msg.method === 'chat.getMessages' || msg.method === 'regex.getCharacter') ? [] : true;
      Promise.resolve(result).then(async (value) => {
        if (rpcDelay) await tick(rpcDelay);
        sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: value } });
      });
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildScriptRuntimeWorkerSourceForTests(), sandbox, { filename: 'script-runtime-worker.js' });
  const sync = scripts => sandbox.self.onmessage({
    data: { type: 'sync', settings: { allowNetwork: true }, context: { sessionId: 's1' }, scripts: scripts.map(item => ({ enabled: true, ...item })) },
  });
  return { sandbox, sync, rpcCalls, deliver: msg => sandbox.self.onmessage({ data: msg }) };
};
const CALLER = `
  self.generate = async (body, init = {}) => {
    const response = await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body), ...init });
    return response;
  };
  self.readAll = async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  };
`;

test('Worker：非流式回 JSON；流式回 text/event-stream，分块比 RPC 结果先到也读得到', async () => {
  let worker;
  const posts = [];
  const live = createTavernGenerateHandler({
    resolveConnection: async () => ({ config: { provider: 'custom', model: 'main-model' }, client: makeClient(), createClient: () => makeClient(), cacheKey: 'k', profileName: 'p' }),
    findScript: ({ scriptId }) => (scriptId === 'caller' ? { id: 'caller', name: '调用者', content: CALLER, scope: 'global' } : null),
    consentStore: createScriptModelConsentStore({ loadKv: async () => ({}), saveKv: async () => {} }),
    confirm: async () => 'approve',
    postStream: (msg) => { posts.push(msg); worker.deliver(msg); },
  });
  worker = createWorker({ handler: live, rpcDelay: 20 });
  await worker.sync([{ id: 'caller', name: '调用者', content: CALLER }]);

  const plain = await worker.sandbox.generate({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get('content-type'), /application\/json/);
  const json = await plain.json();
  assert.equal(json.choices[0].message.content, 'reply text');

  const streamed = await worker.sandbox.generate({ messages: [{ role: 'user', content: 'x' }], stream: true });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  assert.ok(posts.some(msg => msg.event === 'end'), 'the whole stream arrived before the RPC result in this test');
  const text = await worker.sandbox.readAll(streamed);
  assert.match(text, /"delta":\{"role":"assistant","content":"he"\}/);
  assert.match(text, /"delta":\{"content":"llo"\}/);
  assert.match(text, /data: \[DONE\]\n\n$/);
  const call = worker.rpcCalls.find(msg => msg.method === 'tavern.request' && msg.params.body.stream === true);
  assert.equal(call.params.scriptId, 'caller');
  assert.match(call.params.requestId, /^tv_/);
});

test('Worker：脚本中止 → 读流抛 AbortError，经 tavern.cancel 中止上游', async () => {
  let worker;
  let upstreamSignal = null;
  const live = createTavernGenerateHandler({
    resolveConnection: async () => ({
      config: { provider: 'custom', model: 'main-model' },
      client: makeClient({ stream: async function* (_messages, options) {
        upstreamSignal = options.signal;
        yield 'first';
        await abortableWait(options.signal);
      } }),
      createClient: () => makeClient(), cacheKey: 'k', profileName: 'p',
    }),
    findScript: ({ scriptId }) => (scriptId === 'caller' ? { id: 'caller', name: '调用者', content: CALLER, scope: 'global' } : null),
    consentStore: createScriptModelConsentStore({ loadKv: async () => ({}), saveKv: async () => {} }),
    confirm: async () => 'approve',
    postStream: msg => worker.deliver(msg),
  });
  worker = createWorker({ handler: live });
  await worker.sync([{ id: 'caller', name: '调用者', content: CALLER }]);
  const controller = new AbortController();
  const response = await worker.sandbox.generate({ messages: [{ role: 'user', content: 'x' }], stream: true }, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /first/);
  controller.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await tick(5);
  assert.ok(worker.rpcCalls.some(msg => msg.method === 'tavern.cancel'));
  assert.equal(upstreamSignal.aborted, true);
});

const makeRuntime = ({ client = makeClient(), preset = null } = {}) => {
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  const resolveCalls = [];
  const storedPreset = preset || {
    name: 'Imported', temperature: 0.4, openai_max_tokens: 300, reverse_proxy: 'https://proxy.example', proxy_password: 'pw',
    custom_url: 'https://custom.example', api_key_custom: 'sk-preset', custom_include_headers: 'Authorization: x',
    prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [],
  };
  runtime.chatStore = {
    getCurrent: () => 's1', getDraft: () => '', listVariables: () => ({}), listGlobalVariables: () => ({}), getMessages: () => [],
  };
  runtime.contactsStore = { getContact: () => ({ id: 's1', name: 'Milla' }) };
  runtime.store = {
    state: { global: { scripts: [{ id: 'g1', name: '全局工具', content: 'global code' }] }, character: {}, preset: {} },
    getScripts: scope => (scope === 'global' ? [{ id: 'g1', name: '全局工具', content: 'global code' }] : []),
    getScopeVariables: () => ({}),
  };
  runtime.bridge = {
    isSharedVariableSession: () => false,
    worldStore: { list: () => [] },
    getConfig: () => ({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-secret', baseUrl: 'https://key.example/v1' }),
    getConfigProfileById: id => (id === 'p1' ? { id: 'p1', name: '主连线' } : null),
    normalizeOutgoingProviderMessages: messages => messages,
    resolveRequestRuntimeConfig: async (context) => {
      resolveCalls.push(context);
      return { config: { provider: 'custom', model: 'main-model', apiKey: 'sk-secret', baseUrl: 'https://key.example/v1' }, client, profileId: 'p1' };
    },
  };
  runtime.presets = {
    getActive: type => (type === 'openai' ? storedPreset : {}),
    getActiveId: type => (type === 'openai' ? 'preset-a' : ''),
    state: { presets: { openai: { 'preset-a': storedPreset } } },
  };
  runtime.getEffectivePersona = () => ({ id: 'character-1', name: 'Milla' });
  runtime.getActiveUserProfile = () => ({ id: 'user-1', name: 'Bob' });
  return { runtime, resolveCalls, storedPreset };
};

test('ScriptRuntime：tavern.request 生成用会话连线档发出、请求体的连线资料不用；tavern.cancel 中止上游', async () => {
  const original = appSettings.get();
  // 共用的同意记录（Node 里没有 KV，只留在记忆体）：先同意这个脚本
  await getScriptModelConsentStore().grant({ scriptId: 'g1', scope: 'global', fingerprint: await fingerprintScriptCode('global code') }).catch(() => {});
  let streamSignal = null;
  const client = makeClient({ stream: async function* (_messages, options) {
    streamSignal = options.signal;
    yield 'part';
    await abortableWait(options.signal);
  } });
  const { runtime, resolveCalls } = makeRuntime({ client });
  const posts = [];
  runtime.worker = { postMessage: msg => posts.push(msg) };
  try {
    appSettings.update({ scriptAllowNetwork: true });
    const result = await runtime.processRpc('tavern.request', {
      path: TAVERN_GENERATE_PATH, scriptId: 'g1', requestId: 'rt-1', sessionId: 's1',
      body: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, reverse_proxy: 'https://proxy.example', proxy_password: 'pw' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'reply text');
    assert.deepEqual(resolveCalls, [{ sessionId: 's1', uiMode: 'chat' }]);
    assert.equal(client.calls.chat[0].options.temperature, 0.2);
    assert.doesNotMatch(JSON.stringify(client.calls.chat[0].options), /proxy|pw/);
    assert.equal(client.calls.chat[0].options.requestContext.sessionId, 's1');

    const streamed = await runtime.processRpc('tavern.request', {
      path: TAVERN_GENERATE_PATH, scriptId: 'g1', requestId: 'rt-2', sessionId: 's1',
      body: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.deepEqual(streamed, { status: 200, stream: true });
    assert.equal(await runtime.processRpc('tavern.cancel', { requestId: 'rt-2' }), true);
    await waitForEnd(posts, 'rt-2');
    assert.equal(streamSignal.aborted, true);
    const streamPosts = posts.filter(msg => msg.id === 'rt-2');
    assert.ok(streamPosts.length >= 2 && streamPosts.every(msg => msg.type === 'tavern_stream'), JSON.stringify(posts.map(msg => msg.type)));

    appSettings.update({ scriptAllowNetwork: false });
    const denied = await runtime.processRpc('tavern.request', {
      path: TAVERN_GENERATE_PATH, scriptId: 'g1', requestId: 'rt-3', sessionId: 's1', body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(denied.status, 403);
  } finally {
    appSettings.update(original);
    await getScriptModelConsentStore().revoke('g1').catch(() => {});
  }
});

test('chatCompletionSettings：滤掉 Key、连线地址、代理栏位，其他参数照旧；预设本身与主生成用的资料不变', async () => {
  const { runtime, storedPreset } = makeRuntime();
  const before = structuredClone(storedPreset);
  const context = runtime.buildContext('s1');
  const settings = context.chatCompletionSettings;
  assert.equal(settings.temperature, 0.4);
  assert.equal(settings.openai_max_tokens, 300);
  assert.deepEqual(settings.prompts, [{ identifier: 'main', content: 'x' }]);
  assert.equal(settings.chat_completion_source, 'openai');
  assert.equal(settings.openai_model, 'gpt-x');
  for (const key of ['reverse_proxy', 'proxy_password', 'custom_url', 'api_key_custom', 'custom_include_headers']) {
    assert.equal(Object.hasOwn(settings, key), false, `${key} must not reach scripts`);
  }
  // 预设 store 里的原物件没被改动（主生成读预设 store 与连线档，不读这份）
  assert.deepEqual(storedPreset, before);
  // 主生成的预设请求体来自连线档与生成选项
  const body = makePresetRequestBody([{ role: 'user', content: 'x' }], { temperature: 0.4 }, { provider: 'custom', model: 'main-model' }, true);
  assert.deepEqual(body, { messages: [{ role: 'user', content: 'x' }], model: 'main-model', stream: true, chat_completion_source: 'custom', temperature: 0.4 });

  // Worker 里脚本读到的也是过滤后的
  const sandbox = {
    console, structuredClone, setTimeout, clearTimeout, queueMicrotask, Date, Math, JSON, RegExp, Error, Promise,
    Map, WeakMap, Set, Array, Object, String, Number, Boolean, URL, AbortController, Response, ReadableStream,
    TextEncoder, TextDecoder, encodeURIComponent, decodeURIComponent,
    location: { origin: ORIGIN, href: `blob:${ORIGIN}/worker` },
    importScripts: () => { throw new Error('blocked in test'); },
    postMessage: (msg) => {
      if (msg?.type !== 'rpc') return;
      Promise.resolve().then(() => sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: msg.method === 'chat.getMessages' ? [] : true } }));
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildScriptRuntimeWorkerSourceForTests(), sandbox, { filename: 'script-runtime-worker.js' });
  await sandbox.self.onmessage({ data: { type: 'sync', settings: {}, context, scripts: [{
    id: 'reader', name: 'reader', enabled: true,
    content: 'self.seen = JSON.stringify(SillyTavern.getContext().chatCompletionSettings);',
  }] } });
  const seen = JSON.parse(sandbox.seen);
  assert.equal(seen.temperature, 0.4);
  assert.doesNotMatch(sandbox.seen, /proxy\.example|"pw"|custom\.example|sk-preset|Authorization/);
});

test('确认窗文字：全局与预设来源', () => {
  assert.match(buildScriptModelConsentDialog({ scriptName: 'A', scope: 'global', profileName: 'P', model: 'm' }).message, /「A」（来自全局脚本）/);
  assert.match(buildScriptModelConsentDialog({ scriptName: 'B', scope: 'preset', sourceName: 'Dream', profileName: 'P', model: 'm' }).message, /「B」（来自预设「Dream」）/);
});

test('确认窗没作出选择就关了（例如被别的确认窗取代）：不记拒绝，回 403＋说明，下次调用再问', async () => {
  const { handler, dialogs, client } = makeHandler({ answers: [null, 'approve'] });
  const dismissed = await ask(handler);
  assert.equal(dismissed.status, 403);
  assert.equal(dismissed.body.error.message, '费用确认窗在用户作出选择前就关闭了（可能被别的确认窗取代），这次没有调用模型。脚本下次调用时会再询问。');
  assert.equal(client.calls.chat.length, 0);
  const next = await ask(handler);
  assert.equal(next.status, 200);
  assert.equal(dialogs.length, 2, 'asked again on the next call');
});

// 执行流：替身 agentTaskRuntime＋泳道，记录器用真的
const makeTracking = ({ laneSessionId = '', clock = { value: 1000 } } = {}) => {
  const runs = [];
  const agentTaskRuntime = {
    startRun: (run) => {
      const saved = { ...run, id: `run-${runs.length + 1}`, finished: null };
      runs.push(saved);
      return saved;
    },
    finishRun: (id, patch) => {
      const run = runs.find(item => item.id === id);
      run.finished = patch;
      return run;
    },
  };
  const laneTasks = [];
  const laneEvents = [];
  let idleChecks = 0;
  const lane = {
    getState: () => (laneSessionId ? { visible: true, run: { sessionId: laneSessionId }, tasks: laneTasks } : { visible: false }),
    appendTask: (task) => { laneTasks.push(task); return { ...task }; },
    finishTask: (id, status, patch) => laneEvents.push(['finish', id, status, patch?.summary || '']),
    failTask: (id, error) => laneEvents.push(['fail', id, String(error || '')]),
  };
  const tracker = createScriptModelCallRunTracker({
    agentTaskRuntime,
    getLaneRuntime: () => lane,
    completeLaneIfIdle: () => { idleChecks += 1; },
    now: () => clock.value,
  });
  return { tracker, runs, laneTasks, laneEvents, idleChecks: () => idleChecks, clock };
};

test('执行流：成功的调用建一笔运行记录（kind、会话、来源脚本、模型），结束时带状态与用量', async () => {
  const tracking = makeTracking();
  const usage = { provider: 'custom', model: 'main-model', finishReason: 'stop', promptTokens: 40, completionTokens: 9, totalTokens: 49 };
  const { handler } = makeHandler({
    runTracker: tracking.tracker,
    client: makeClient({ chat: (_messages, options) => { tracking.clock.value += 250; options.onProviderUsage(usage); return 'ok'; } }),
  });
  assert.equal((await ask(handler, { body: { model: 'gone-model' } })).status, 200);
  assert.equal(tracking.runs.length, 1);
  const [run] = tracking.runs;
  assert.equal(run.kind, SCRIPT_GENERATION_RUN_KIND);
  assert.equal(run.kind, 'script_generation');
  assert.equal(run.title, '脚本调用模型 · 异步世界');
  assert.equal(run.sessionId, 's1');
  assert.equal(run.surface, 'chat');
  assert.equal(run.trigger, 'script.tavern_api');
  assert.equal(run.source, 'tavern-api-generate');
  assert.deepEqual(run.metadata, {
    scriptId: 'dream', scriptName: '异步世界', scriptScope: 'character', scriptSource: 'Milla',
    model: 'main-model', requestedModel: 'gone-model', modelNote: 'unavailable', stream: false,
  });
  assert.equal(run.finished.status, 'succeeded');
  assert.equal(run.finished.summary, 'script model call succeeded');
  const recorded = normalizeAgentUsage(run.finished.usage);
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.model, 'main-model');
  assert.equal(recorded.provider, 'custom');
  assert.equal(recorded.promptTokens, 40);
  assert.equal(recorded.completionTokens, 9);
  assert.equal(recorded.totalTokens, 49);
  assert.equal(recorded.latencyMs, 250);
  assert.equal(recorded.modelCallCount, 1);
  assert.equal(recorded.finishReason, 'stop');

  // 照用脚本指定的模型时不写 requestedModel
  await ask(handler, { body: { model: 'alt-model' } });
  assert.equal(tracking.runs[1].metadata.model, 'alt-model');
  assert.equal(Object.hasOwn(tracking.runs[1].metadata, 'requestedModel'), false);
});

test('执行流：等同意时不建记录；拒绝、关掉确认窗、等待中被取消照实际结果记；这次运行已拒绝的不再记', async () => {
  const tracking = makeTracking();
  const gate = deferred();
  const answers = [];
  const { handler } = makeHandler({
    runTracker: tracking.tracker,
    confirm: async () => { await gate.promise; return answers.shift(); },
  });
  answers.push('deny');
  const pending = ask(handler);
  await tick(5);
  assert.equal(tracking.runs.length, 0, 'no run while waiting for consent');
  gate.resolve();
  assert.equal((await pending).status, 403);
  assert.equal(tracking.runs.length, 1);
  assert.equal(tracking.runs[0].finished.status, 'cancelled');
  assert.equal(tracking.runs[0].finished.cancelReason, 'consent_denied');
  assert.equal(Object.hasOwn(tracking.runs[0].finished, 'usage'), false, 'nothing was sent');
  await ask(handler);
  assert.equal(tracking.runs.length, 1, 'remembered denials are not recorded again');

  answers.push(null);
  await ask(handler, { scriptId: 'izumi' });
  assert.equal(tracking.runs[1].finished.cancelReason, 'consent_dismissed');

  // 等同意时被取消：同意后也不发出，记成取消
  const tracking2 = makeTracking();
  const gate2 = deferred();
  const waiting = makeHandler({ runTracker: tracking2.tracker, confirm: async () => { await gate2.promise; return 'approve'; } });
  const asked = ask(waiting.handler, { requestId: 'wait-cancel' });
  await tick(5);
  waiting.handler.cancel('wait-cancel');
  gate2.resolve();
  assert.equal((await asked).status, 499);
  assert.equal(tracking2.runs.length, 1);
  assert.equal(tracking2.runs[0].finished.cancelReason, 'script_aborted');
});

test('执行流：失败只记清理过的说明；脚本中止记成取消；流式成功带用量', async () => {
  const tracking = makeTracking();
  const leak = Object.assign(new Error('500 at https://secret.example key sk-1'), { status: 500 });
  const failing = makeHandler({ runTracker: tracking.tracker, client: makeClient({ chat: () => { throw leak; } }) });
  await ask(failing.handler);
  assert.equal(tracking.runs[0].finished.status, 'failed');
  assert.equal(tracking.runs[0].finished.errorMessage, '模型请求没有成功（上游回应 HTTP 500）：请到 APP 的 API 设置确认当前会话的连线能正常使用。');
  assert.doesNotMatch(JSON.stringify(tracking.runs), /secret\.example|sk-1/);

  const aborting = makeHandler({ runTracker: tracking.tracker, client: makeClient({ chat: (_m, options) => abortableWait(options.signal) }) });
  const pending = ask(aborting.handler, { requestId: 'abort-run' });
  await tick(5);
  aborting.handler.cancel('abort-run');
  await pending;
  assert.equal(tracking.runs[1].finished.status, 'cancelled');
  assert.equal(tracking.runs[1].finished.cancelReason, 'script_aborted');
  assert.equal(normalizeAgentUsage(tracking.runs[1].finished.usage).aborted, true);

  const streaming = makeHandler({ runTracker: tracking.tracker, client: makeClient({ stream: async function* (_m, options) {
    yield 'x';
    options.onProviderUsage({ promptTokens: 2, completionTokens: 1 });
  } }) });
  await ask(streaming.handler, { body: { stream: true }, requestId: 'stream-run' });
  await waitForEnd(streaming.posts, 'stream-run');
  assert.equal(tracking.runs[2].metadata.stream, true);
  assert.equal(tracking.runs[2].finished.status, 'succeeded');
  assert.equal(normalizeAgentUsage(tracking.runs[2].finished.usage).totalTokens, 3);
});

test('执行流：创意写作泳道正显示这个会话时，在模型栏加任务并在结束时收尾', async () => {
  const tracking = makeTracking({ laneSessionId: 'rp:s1' });
  const ok = makeHandler({ runTracker: tracking.tracker });
  await ask(ok.handler, { access: { sessionId: 'rp:s1' } });
  assert.equal(tracking.runs[0].surface, 'writing');
  assert.equal(tracking.laneTasks.length, 1);
  const [task] = tracking.laneTasks;
  assert.equal(task.laneId, 'model');
  assert.equal(task.label, '脚本调用模型');
  assert.equal(task.brief, '异步世界');
  assert.equal(task.summary, '脚本调用模型中');
  assert.equal(task.status, 'running');
  assert.deepEqual(tracking.laneEvents, [['finish', task.id, 'succeeded', '脚本调用模型完成']]);
  assert.equal(tracking.idleChecks(), 1);

  const failing = makeHandler({ runTracker: tracking.tracker, client: makeClient({ chat: () => { throw Object.assign(new Error('x'), { status: 429 }); } }) });
  await ask(failing.handler, { access: { sessionId: 'rp:s1' } });
  assert.equal(tracking.laneEvents[1][0], 'fail');
  assert.match(tracking.laneEvents[1][2], /HTTP 429/);

  // 别的会话、或没有发出请求（拒绝）的不加泳道任务
  await ask(ok.handler, { access: { sessionId: 'rp:other' } });
  const denied = makeHandler({ runTracker: tracking.tracker, answers: ['deny'] });
  await ask(denied.handler, { scriptId: 'izumi', access: { sessionId: 'rp:s1' } });
  assert.equal(tracking.laneTasks.length, 2);
  assert.equal(tracking.runs.length, 4);
});

test('ScriptRuntime：执行流记录器由 setContext 注入，生成时接上', async () => {
  const original = appSettings.get();
  await getScriptModelConsentStore().grant({ scriptId: 'g1', scope: 'global', fingerprint: await fingerprintScriptCode('global code') }).catch(() => {});
  const tracking = makeTracking();
  const { runtime } = makeRuntime();
  runtime.setContext({ modelCallRunTracker: tracking.tracker });
  try {
    appSettings.update({ scriptAllowNetwork: true });
    const result = await runtime.processRpc('tavern.request', {
      path: TAVERN_GENERATE_PATH, scriptId: 'g1', requestId: 'rt-run', sessionId: 's1', body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(result.status, 200);
    assert.equal(tracking.runs.length, 1);
    assert.equal(tracking.runs[0].metadata.scriptName, '全局工具');
    assert.equal(tracking.runs[0].metadata.scriptScope, 'global');
    assert.equal(tracking.runs[0].finished.status, 'succeeded');
  } finally {
    appSettings.update(original);
    await getScriptModelConsentStore().revoke('g1').catch(() => {});
  }
});

// 11/20 真机：Dream 的异步结算带 tool_choice: required，会话关了思考；没套用会话的思考设定时，
// DeepSeek 默认思考而回 400（Thinking mode does not support this tool_choice）。思考设定照主生成的规则。
test('script calls follow the session reasoning setting like the main generation', async () => {
  const { buildTavernGenerateOptions: build } = await import('../../src/scripts/plugins/tavern-api-generate.js');
  const { resolveEffectiveReasoningSetting } = await import('../../src/scripts/api/model-capabilities.js');
  const body = { max_tokens: 100, temperature: 1, tool_choice: 'required', reasoning_effort: 'low',
    tools: [{ type: 'function', function: { name: 'sync', parameters: { type: 'object', properties: {} } } }] };
  const deepseek = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
  const off = build(body, deepseek, { requestReasoning: false });
  assert.deepEqual(off.thinking, { type: 'disabled' }, '会话关了思考：明确关闭，tool_choice 才会被接受');
  assert.equal(off.tool_choice, 'required');
  const on = build(body, deepseek, { requestReasoning: true, reasoningEffort: 'high' });
  assert.deepEqual(on.thinking, { type: 'enabled' });
  assert.equal(on.reasoning_effort, 'low', '开着思考时强度用脚本请求里的');
  assert.equal(on.temperature, undefined, '开着思考时拿掉连线不接受的采样参数');
  const openai = { provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1' };
  assert.equal(build({ ...body, reasoning_effort: undefined }, openai, { requestReasoning: true, reasoningEffort: 'high' }).reasoning_effort, 'high', '脚本没给强度时用会话的');
  const none = build(body, deepseek, null);
  assert.equal(none.thinking, undefined, '对话预设关着：同主生成不送思考参数');

  const preset = { request_reasoning: true, reasoning_effort: 'medium' };
  assert.deepEqual(resolveEffectiveReasoningSetting({ preset }), { requestReasoning: true, reasoningEffort: 'medium' });
  assert.deepEqual(resolveEffectiveReasoningSetting({ sessionReasoning: { request_reasoning: false, reasoning_effort: 'high' }, modeReasoning: { request_reasoning: true }, preset }),
    { requestReasoning: false, reasoningEffort: 'high' }, '会话覆盖优先于模式与预设');
  assert.deepEqual(resolveEffectiveReasoningSetting({ modeReasoning: { request_reasoning: true, reasoning_effort: 'low' }, preset: { request_reasoning: false } }),
    { requestReasoning: true, reasoningEffort: 'low' });
});

// 11/20 真机：用跳房子流程板时泳道按房子分栏（请求、上下文、正文生成…），没有「模型」栏，
// appendTask 遇到不存在的栏位回 null，任务没加上。改成有「模型」栏用它，否则加在「正文生成」栏。
test('执行流：泳道按流程板分栏时，脚本调用模型的任务加在「正文生成」栏；两者都没有就不加', () => {
  const makeLane = (laneIds) => {
    const tasks = [];
    return {
      tasks,
      lane: {
        getState: () => ({ visible: true, run: { sessionId: 'rp:s1' }, lanes: laneIds.map(id => ({ id })), tasks }),
        appendTask: (task) => { tasks.push(task); return { ...task }; },
        finishTask: () => {},
        failTask: () => {},
      },
    };
  };
  const startWith = (laneIds) => {
    const { tasks, lane } = makeLane(laneIds);
    const tracker = createScriptModelCallRunTracker({ agentTaskRuntime: { startRun: run => ({ ...run, id: 'run-1' }), finishRun: () => {} }, getLaneRuntime: () => lane });
    tracker.start({ sessionId: 'rp:s1', scriptId: 'dream', scriptName: '异步世界', model: 'm' });
    return tasks.map(task => task.laneId);
  };
  assert.deepEqual(startWith(['request', 'context', 'model', 'body']), ['model']);
  assert.deepEqual(startWith(['request', 'context', 'body', 'house_1']), ['body']);
  assert.deepEqual(startWith(['request', 'context']), []);
});
