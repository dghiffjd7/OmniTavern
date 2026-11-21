import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// 酒馆后端接口模拟第 1～2 步：Worker 拦相对路径 /api/... → RPC → 主程式路由 → 酒馆同形状的 Response。
// 写入接口（第 4 步）见 tavern-api-write-tests。
// 脚本片段都是为测试合成的，只模仿「直接 fetch 酒馆接口」的写法。

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
const { createTavernApiRouter, buildTavernApiGapReport, stripTavernConnectionSecrets, toTavernWorldFile } = await import('../../src/scripts/plugins/tavern-api-router.js');
const { createTavernApiWorker } = await import('../../src/scripts/plugins/tavern-api-worker.js');
const { formatCompatGapReports, getCompatGapReportStore, upsertCompatGapReport } = await import('../../src/scripts/storage/compat-gap-report-store.js');
globalThis.setTimeout = realSetTimeout;

const ORIGIN = 'http://tauri.localhost';

const makeRouter = (overrides = {}) => {
  const gaps = [];
  const router = createTavernApiRouter({
    listModels: async () => ['model-a', 'model-b', 'model-a'],
    listWorldbooks: () => ['Zeta', 'Alpha'],
    readWorldbook: async name => (name === 'Alpha'
      ? { name: 'Alpha', entries: [{ uid: 3, comment: 'three', content: 'c3', key: ['k'] }, { id: 'no-uid', comment: 'free', content: 'c0' }] }
      : null),
    getChat: () => ({
      userName: 'Bob',
      characterName: 'Milla',
      messages: [
        { id: 'm1', role: 'user', raw: 'hello', timestamp: Date.UTC(2026, 10, 20) },
        { id: 'm2', role: 'assistant', rawSource: 'hi there', name: 'Milla', timestamp: Date.UTC(2026, 10, 20, 0, 1) },
      ],
    }),
    getPresetSettings: () => ({
      name: 'Preset A',
      inUse: { temperature: 0.5, openai_model: 'gpt-x', reverse_proxy: 'https://proxy.example', proxy_password: 'pw', custom_url: 'https://c.example', api_key_custom: 'sk' },
      saved: { temperature: 0.4, custom_include_headers: 'Authorization: x', prompts: [{ identifier: 'main' }] },
    }),
    recordGap: request => gaps.push(request),
    ...overrides,
  });
  return { router, gaps };
};
const fullAccess = { allowNetwork: true, allowReadMessages: true, sessionId: 's1' };

// 照 script-runtime-compat-worker-tests 的方式在 vm 里跑整个 Worker；tavern.request 交给真的路由
const createWorker = ({ access = fullAccess, router = makeRouter().router, fetchImpl = null } = {}) => {
  const rpcCalls = [];
  const messages = [];
  const sandbox = {
    console, structuredClone, setTimeout, clearTimeout, queueMicrotask, Date, Math, JSON, RegExp, Error, Promise,
    Map, WeakMap, Set, Array, Object, String, Number, Boolean, URL, AbortController, Response, ReadableStream,
    TextEncoder, TextDecoder, encodeURIComponent, decodeURIComponent,
    location: { origin: ORIGIN, href: `blob:${ORIGIN}/worker` },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    importScripts: () => { throw new Error('blocked in test'); },
    postMessage: (msg) => {
      messages.push(msg);
      if (msg?.type !== 'rpc') return;
      rpcCalls.push(msg);
      const result = msg.method === 'tavern.request'
        ? router.handle(structuredClone(msg.params), access)
        : (msg.method === 'chat.getMessages' || msg.method === 'regex.getCharacter') ? [] : true;
      Promise.resolve(result).then(
        value => sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: value } }),
        error => sandbox.self.onmessage({ data: { type: 'rpc_error', id: msg.id, error: String(error?.message || error) } }),
      );
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildScriptRuntimeWorkerSourceForTests(), sandbox, { filename: 'script-runtime-worker.js' });
  const sync = (scripts, { settings = { allowNetwork: false }, context = { sessionId: 's1' } } = {}) => sandbox.self.onmessage({
    data: { type: 'sync', settings, context, scripts: scripts.map(item => ({ enabled: true, ...item })) },
  });
  const tavernCalls = () => rpcCalls.filter(msg => msg.method === 'tavern.request');
  return { sandbox, sync, messages, tavernCalls };
};

// 脚本里常见的读法：fetch 后读 status 与 JSON
const READER = `
  self.callTavern = async (url, body, init = {}) => {
    const response = await fetch(url, { method: 'POST', headers: {}, body: JSON.stringify(body ?? {}), ...init });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, ok: response.ok, json, text };
  };
`;

test('相对路径 /api/... 被拦下，经 RPC 交路由，回酒馆同形状的 Response，并认出发请求的脚本', async () => {
  const worker = createWorker();
  await worker.sync([{ id: 'reader-1', name: '读取器', content: READER }]);
  const result = await worker.sandbox.callTavern('/api/worldinfo/list', {});
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, [
    { file_id: 'Alpha', name: 'Alpha', extensions: {} },
    { file_id: 'Zeta', name: 'Zeta', extensions: {} },
  ]);
  const [call] = worker.tavernCalls();
  assert.equal(call.params.path, '/api/worldinfo/list');
  assert.equal(call.params.scriptId, 'reader-1');
  assert.equal(call.params.scriptName, '读取器');
  assert.equal(call.params.sessionId, 's1');
});

test('指向本页同源的完整网址也算酒馆接口；外部网址照旧交网络权限', async () => {
  const external = [];
  const worker = createWorker({ fetchImpl: async (url) => { external.push(String(url)); return new Response('{"ext":true}'); } });
  await worker.sync([{ id: 'reader', name: 'reader', content: READER }]);
  const sameOrigin = await worker.sandbox.callTavern(new URL('/api/tokenizers/openai/count', ORIGIN).href, [{ role: 'user', content: 'hello' }]);
  assert.equal(sameOrigin.status, 200);
  assert.equal(typeof sameOrigin.json.token_count, 'number');

  // 没有网络权限：外部网址被挡，不进酒馆路由
  await assert.rejects(worker.sandbox.callTavern('https://example.com/api/worldinfo/list', {}), /脚本网络已禁用/);
  // 有网络权限：外部网址交原生 fetch
  await worker.sync([{ id: 'reader', name: 'reader', content: READER }], { settings: { allowNetwork: true } });
  const remote = await worker.sandbox.callTavern('https://example.com/api/worldinfo/list', {});
  assert.deepEqual(remote.json, { ext: true });
  assert.deepEqual(external, ['https://example.com/api/worldinfo/list']);
  assert.equal(worker.tavernCalls().length, 1, 'only the same-origin request reaches the tavern router');
});

test('主生成仍由预设请求拦截处理，不进酒馆路由', async () => {
  const worker = createWorker();
  // 预设脚本拦下生成请求后用写死的酒馆路径重发（编号丢了）
  await worker.sync([{
    id: 'rewriter',
    name: 'rewriter',
    content: `const original = self.fetch;
      self.fetch = (url, init) => original('/api/backends/chat-completions/generate', init);`,
  }], { context: { sessionId: 's1', openaiPresetId: 'p1' } });
  await worker.sandbox.self.onmessage({ data: {
    type: 'preset_request', event: 'start', id: 'job-1', sessionId: 's1', presetId: 'p1', preview: true, stream: false,
    body: { messages: [{ role: 'user', content: 'hello' }] },
  } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const prepared = worker.messages.find(msg => msg.type === 'preset_request' && msg.event === 'prepared');
  assert.equal(prepared?.body?.messages?.[0]?.content, 'hello');
  assert.equal(worker.tavernCalls().length, 0);
});

test('脚本单独打未知接口：回 501＋中文说明，并记进兼容缺口（生成接口见 tavern-api-generate-tests）', async () => {
  const { router, gaps } = makeRouter();
  const worker = createWorker({ router });
  await worker.sync([{ id: 'async-world', name: '异步世界', content: READER }]);
  const other = await worker.sandbox.callTavern('/api/characters/all', {});
  assert.equal(other.status, 501);
  assert.match(other.json.error.message, /\/api\/characters\/all/);
  const backup = await worker.sandbox.callTavern('/api/backups/create', {});
  assert.equal(backup.status, 501);
  assert.deepEqual(gaps.map(gap => [gap.path, gap.scriptId, gap.scriptName]), [
    ['/api/characters/all', 'async-world', '异步世界'],
    ['/api/backups/create', 'async-world', '异步世界'],
  ]);
});

test('/api/secrets/* 回 403 与中文说明，不记缺口', async () => {
  const { router, gaps } = makeRouter();
  for (const path of ['/api/secrets/find', '/api/secrets/read', '/api/secrets']) {
    const result = await router.handle({ path, body: { key: 'api_key_openai' } }, fullAccess);
    assert.equal(result.status, 403);
    assert.match(result.body.error.message, /APP 不把 API Key 交给脚本/);
  }
  assert.equal(gaps.length, 0);
});

test('权限不足：status 要「访问网络」，chats/get 要「读取聊天记录」', async () => {
  let listed = 0;
  const { router } = makeRouter({ listModels: async () => { listed += 1; return ['m']; } });
  const status = await router.handle({ path: '/api/backends/chat-completions/status', body: {} }, { ...fullAccess, allowNetwork: false });
  assert.equal(status.status, 403);
  assert.match(status.body.error.message, /允许脚本访问网络/);
  assert.equal(listed, 0);
  const chats = await router.handle({ path: '/api/chats/get', body: { file_name: 's1' } }, { ...fullAccess, allowReadMessages: false });
  assert.equal(chats.status, 403);
  assert.match(chats.body.error.message, /允许脚本读取聊天记录/);
  // 不需要权限的只读接口照常
  const worlds = await router.handle({ path: '/api/worldinfo/list', body: {} }, { sessionId: 's1' });
  assert.equal(worlds.status, 200);
});

test('chat-completions/status：成功回 OpenAI 模型清单，失败照酒馆回 { error: true, data: { data: [] } }', async () => {
  const { router } = makeRouter();
  const success = await router.handle({ path: '/api/backends/chat-completions/status', body: { chat_completion_source: 'custom', custom_url: 'https://ignored' } }, fullAccess);
  assert.deepEqual(success, { status: 200, body: { object: 'list', data: [{ id: 'model-a', object: 'model' }, { id: 'model-b', object: 'model' }] } });

  const { router: failing } = makeRouter({ listModels: async () => { throw new Error('401 https://secret.example?key=sk-123'); } });
  const failure = await failing.handle({ path: '/api/backends/chat-completions/status', body: {} }, fullAccess);
  assert.equal(failure.status, 200);
  assert.equal(failure.body.error, true);
  assert.deepEqual(failure.body.data, { data: [] });
  assert.doesNotMatch(JSON.stringify(failure.body), /sk-123|secret\.example/, 'provider errors may carry addresses or keys');
});

test('tokenizers/openai/count：本地估算，回 { token_count }', async () => {
  const { router } = makeRouter();
  const short = await router.handle({ path: '/api/tokenizers/openai/count', body: [{ role: 'user', content: 'hi' }] }, fullAccess);
  const long = await router.handle({ path: '/api/tokenizers/openai/count', body: [{ role: 'user', content: '很长的一段中文内容'.repeat(20) }] }, fullAccess);
  assert.equal(short.status, 200);
  assert.ok(Number.isInteger(short.body.token_count) && short.body.token_count > 0);
  assert.ok(long.body.token_count > short.body.token_count);
  const empty = await router.handle({ path: '/api/tokenizers/openai/count', body: null }, fullAccess);
  assert.equal(empty.status, 400);
});

test('worldinfo/get：酒馆世界书文件形状；找不到回 { entries: {} }；缺名称回 400', async () => {
  const { router } = makeRouter();
  const found = await router.handle({ path: '/api/worldinfo/get', body: { name: 'Alpha' } }, fullAccess);
  assert.equal(found.status, 200);
  assert.equal(found.body.name, 'Alpha');
  assert.deepEqual(Object.keys(found.body.entries).sort(), ['0', '3']);
  assert.equal(found.body.entries[3].comment, 'three');
  assert.equal(found.body.entries[0].uid, 0);
  assert.equal(found.body.entries[0].content, 'c0');
  const missing = await router.handle({ path: '/api/worldinfo/get', body: { name: 'Nope' } }, fullAccess);
  assert.deepEqual(missing.body, { entries: {} });
  const noName = await router.handle({ path: '/api/worldinfo/get', body: {} }, fullAccess);
  assert.equal(noName.status, 400);

  // 重复或缺少的 uid 补最小空号，不覆盖已有条目
  const file = toTavernWorldFile({ entries: [{ uid: 1, content: 'a' }, { uid: 1, content: 'b' }, { content: 'c' }] });
  assert.deepEqual(Object.entries(file.entries).map(([key, entry]) => [key, entry.uid, entry.content]), [
    ['0', 0, 'b'], ['1', 1, 'a'], ['2', 2, 'c'],
  ]);
});

test('chats/get：第一行表头带 chat_metadata，之后是酒馆格式消息；别的聊天文件回空数组', async () => {
  const { router } = makeRouter();
  const result = await router.handle({ path: '/api/chats/get', body: { avatar_url: 'Milla', file_name: 's1' }, chatMetadata: { note: 'kept' } }, fullAccess);
  assert.equal(result.status, 200);
  const [header, first, second] = result.body;
  assert.deepEqual(header, {
    user_name: 'Bob', character_name: 'Milla', create_date: new Date(Date.UTC(2026, 10, 20)).toISOString(), chat_metadata: { note: 'kept' },
  });
  assert.deepEqual(first, { name: 'Bob', is_user: true, is_system: false, send_date: new Date(Date.UTC(2026, 10, 20)).toISOString(), mes: 'hello', extra: {} });
  assert.equal(second.mes, 'hi there');
  assert.equal(second.is_user, false);
  assert.equal(result.body.length, 3);
  const other = await router.handle({ path: '/api/chats/get', body: { file_name: 'another-chat' } }, fullAccess);
  assert.deepEqual(other.body, []);
});

test('settings/get：只回 oai_settings 与当前预设，不含 Key、连线地址、代理', async () => {
  const { router } = makeRouter();
  const result = await router.handle({ path: '/api/settings/get', body: {} }, fullAccess);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['openai_setting_names', 'openai_settings', 'settings']);
  const settings = JSON.parse(result.body.settings);
  assert.deepEqual(Object.keys(settings), ['oai_settings']);
  assert.deepEqual(settings.oai_settings, { temperature: 0.5, openai_model: 'gpt-x' });
  assert.deepEqual(result.body.openai_setting_names, ['Preset A']);
  assert.deepEqual(JSON.parse(result.body.openai_settings[0]), { temperature: 0.4, prompts: [{ identifier: 'main' }] });
  assert.deepEqual(stripTavernConnectionSecrets({
    max_tokens: 1, openai_max_tokens: 2, vertexai_region: 'x', zai_endpoint: 'y', workers_ai_account_id: 'z', api_server: 'w', secret_id: 'v',
  }), { max_tokens: 1, openai_max_tokens: 2 });
});

test('Worker 端：请求体过大回 413、不是 JSON 回 400、已取消的请求抛 AbortError', async () => {
  const calls = [];
  const worker = createTavernApiWorker({
    callRpc: async (method, params) => { calls.push(params); return { status: 200, body: { ok: true } }; },
    bodyLimit: 10,
  });
  const big = await worker.interceptFetch('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(20) }) });
  assert.equal(big.status, 413);
  const bad = await worker.interceptFetch('/api/worldinfo/get', { method: 'POST', body: '{bad' });
  assert.equal(bad.status, 400);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(worker.interceptFetch('/api/worldinfo/list', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(worker.interceptFetch('https://example.com/api/x'), null);
  assert.equal(worker.interceptFetch('/not-api/x'), null);
  assert.equal(calls.length, 0);
});

test('经过别的脚本同步包装的 fetch，仍记到真正发请求的脚本', async () => {
  const { router, gaps } = makeRouter();
  const worker = createWorker({ router });
  await worker.sync([
    { id: 'hook', name: '包装', content: 'const original = self.fetch; self.fetch = (url, init) => original(url, init);' },
    { id: 'caller', name: '发请求的脚本', content: READER },
  ]);
  await worker.sandbox.callTavern('/api/characters/all', {});
  assert.deepEqual(gaps.map(gap => gap.scriptId), ['caller']);
});

test('兼容缺口记录：接口路径＋次数＋脚本名称，调试面板文字看得到', async () => {
  const report = buildTavernApiGapReport({ path: '/api/worldinfo/edit', scriptId: 'izumi', scriptName: '悬浮窗', revision: '12:abc' });
  let state = null;
  ({ state } = upsertCompatGapReport(state, report, { now: 1000 }));
  ({ state } = upsertCompatGapReport(state, report, { now: 2000 }));
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].api, '/api/worldinfo/edit');
  assert.equal(state.reports[0].confirmedCount, 2);
  assert.equal(state.reports[0].scriptName, '悬浮窗');
  const text = formatCompatGapReports(state.reports);
  assert.match(text, /api=\/api\/worldinfo\/edit script=悬浮窗/);
  assert.match(text, /confirmed=2/);

  // ScriptRuntime 把路由的缺口写进全局缺口 store
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  const store = getCompatGapReportStore();
  await store.clear();
  runtime.recordTavernApiGap({ path: '/api/presets/save', scriptId: 'p1', scriptName: '预设脚本' });
  runtime.recordTavernApiGap({ path: '/api/presets/save', scriptId: 'p1', scriptName: '预设脚本' });
  const reports = await store.getReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].api, '/api/presets/save');
  assert.equal(reports[0].scriptName, '预设脚本');
  assert.equal(reports[0].confirmedCount, 2);
  await store.clear();
});

test('ScriptRuntime 把 tavern.request 接到会话连线、世界书、聊天与预设', async () => {
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  const preset = {
    name: 'Preset A', temperature: 0.4, reverse_proxy: 'https://proxy.example', proxy_password: 'pw',
    prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [],
  };
  const resolveCalls = [];
  runtime.chatStore = {
    getCurrent: () => 's1',
    getDraft: () => '',
    listVariables: () => ({}),
    listGlobalVariables: () => ({}),
    getMessages: () => [{ id: 'm1', role: 'user', raw: 'hello', timestamp: 1 }],
  };
  runtime.contactsStore = { getContact: () => ({ id: 's1', name: 'Milla' }) };
  runtime.bridge = {
    isSharedVariableSession: () => false,
    currentWorldId: 'World',
    currentWorldIds: ['World'],
    worldStore: { list: () => ['World'], load: () => null },
    getWorldInfoSnapshot: async id => (id === 'World'
      ? { exists: true, data: { name: 'World', entries: [{ uid: 0, comment: 'E', content: 'lazy loaded' }] } }
      : { exists: false, data: null }),
    getConfig: () => ({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-secret', baseUrl: 'https://key.example/v1' }),
    resolveRequestRuntimeConfig: async (context) => {
      resolveCalls.push(context);
      return { client: { listModels: async () => ['gpt-x', 'gpt-y'] } };
    },
  };
  runtime.presets = {
    getActive: type => (type === 'openai' ? preset : {}),
    getActiveId: type => (type === 'openai' ? 'preset-a' : ''),
    state: { presets: { openai: { 'preset-a': preset } } },
  };
  runtime.getEffectivePersona = () => ({ id: 'character-1', name: 'Milla' });
  runtime.getActiveUserProfile = () => ({ id: 'user-1', name: 'Bob' });
  runtime.context = { ...runtime.context, ...runtime.buildContext('s1') };
  const original = appSettings.get();
  try {
    appSettings.update({ scriptAllowNetwork: true, scriptAllowReadMessages: true });
    const request = (path, body = {}) => runtime.processRpc('tavern.request', { path, body, sessionId: 's1' });

    const status = await request('/api/backends/chat-completions/status');
    assert.deepEqual(status.body.data.map(item => item.id), ['gpt-x', 'gpt-y']);
    assert.deepEqual(resolveCalls, [{ sessionId: 's1', uiMode: 'chat' }]);

    assert.deepEqual((await request('/api/worldinfo/list')).body, [{ file_id: 'World', name: 'World', extensions: {} }]);
    assert.equal((await request('/api/worldinfo/get', { name: 'World' })).body.entries[0].content, 'lazy loaded');

    const chat = await request('/api/chats/get', { file_name: 's1' });
    assert.equal(chat.body[0].user_name, 'Bob');
    assert.equal(chat.body[0].character_name, 'Milla');
    assert.equal(chat.body[1].mes, 'hello');

    const settings = await request('/api/settings/get');
    const oai = JSON.parse(settings.body.settings).oai_settings;
    assert.equal(oai.temperature, 0.4);
    assert.equal(oai.chat_completion_source, 'openai');
    assert.equal(oai.openai_model, 'gpt-x');
    assert.deepEqual(settings.body.openai_setting_names, ['Preset A']);
    assert.doesNotMatch(JSON.stringify(settings.body), /sk-secret|key\.example|proxy\.example|"pw"/);

    appSettings.update({ scriptAllowNetwork: false, scriptAllowReadMessages: false });
    assert.equal((await request('/api/backends/chat-completions/status')).status, 403);
    assert.equal((await request('/api/chats/get', { file_name: 's1' })).status, 403);
  } finally {
    appSettings.update(original);
  }
});
