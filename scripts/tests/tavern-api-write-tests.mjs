import test from 'node:test';
import assert from 'node:assert/strict';

// 酒馆后端接口模拟第 4 步：写入接口 /api/worldinfo/edit、/api/presets/save，以及世界书读写的往返保真
// （顶层 extensions、读回去掉 APP 栏位、脚本写入的原始文件原样读回）。
// 世界书与预设 store、KV、确认窗都用替身；世界书、预设与脚本名称都是为测试合成的。

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
const { ScriptRuntime } = await import('../../src/scripts/plugins/script-runtime.js');
const { appSettings } = await import('../../src/scripts/storage/app-settings.js');
const {
  createTavernApiRouter, fromTavernWorldEntries, describeTavernPresetSave, buildPresetSaveDialog, mergeTavernPresetSave,
  buildTavernApiGapReport, toTavernWorldFile,
} = await import('../../src/scripts/plugins/tavern-api-router.js');
const { createScriptWorldbookWriter } = await import('../../src/scripts/plugins/script-worldbook-write.js');
const { createTavernApiWorker } = await import('../../src/scripts/plugins/tavern-api-worker.js');
const { upsertCompatGapReport } = await import('../../src/scripts/storage/compat-gap-report-store.js');
const {
  createScriptWorldFileStore, SCRIPT_WORLD_FILE_INDEX_KEY,
} = await import('../../src/scripts/storage/script-world-file-store.js');
const { collectCustomBundleWorldbookRecords } = await import('../../src/scripts/ui/custom-bundle-worldbook-utils.js');
globalThis.setTimeout = realSetTimeout;

const tick = (ms = 0) => new Promise(resolve => realSetTimeout(resolve, ms));

// 世界书 store 替身：形状同 bridge 的 getWorldInfoSnapshot / saveWorldInfo；保存时照 bridge 补上
// createdAt（沿用原本的）与 updatedAt，存成 JSON（同原生档案），索引给建立时间
const createWorldBridge = (worlds = {}) => {
  const store = new Map(Object.entries(structuredClone(worlds)));
  const saves = [];
  let clock = 5000;
  return {
    saves,
    store,
    worldStore: {
      ready: Promise.resolve(),
      list: () => Array.from(store.keys()),
      load: id => store.get(id) || null,
      getMetadata: id => (store.has(id) ? { name: id, createdAt: Number(store.get(id).createdAt) || 0 } : null),
    },
    async getWorldInfoSnapshot(id) {
      return { worldbookId: id, exists: store.has(id), revision: 0, generation: 1, data: structuredClone(store.get(id) ?? null) };
    },
    async saveWorldInfo(id, data, options) {
      const payload = { ...data, createdAt: data.createdAt || store.get(id)?.createdAt || ++clock, updatedAt: ++clock };
      saves.push({ id, data: JSON.parse(JSON.stringify(payload)), options });
      store.set(id, JSON.parse(JSON.stringify(payload)));
      return { ok: true };
    },
    getGlobalWorldIds: () => [],
    setGlobalWorldIds: () => {},
    isSharedVariableSession: () => false,
  };
};

// ScriptRuntime 接上替身：tavern.request 走真的路由与真的写入路径，确认窗按 answers 依序回答
const createKv = () => {
  const kv = new Map();
  return {
    kv,
    loadKv: async name => (kv.has(name) ? JSON.parse(kv.get(name)) : {}),
    saveKv: async (name, data) => { kv.set(name, JSON.stringify(data)); },
  };
};
const createRuntime = ({
  worlds = {}, presets = {}, activeId = '', answers = [], confirm = null, kv = createKv(), limits = undefined,
} = {}) => {
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  const bridge = createWorldBridge(worlds);
  runtime.bridge = bridge;
  runtime.scriptWorldFileStore = createScriptWorldFileStore({ loadKv: kv.loadKv, saveKv: kv.saveKv, ...(limits ? { limits } : {}) });
  const dialogs = [];
  runtime.scriptWorldbookWriter = createScriptWorldbookWriter({
    bridge,
    confirm: confirm || (async (options) => {
      dialogs.push(options);
      return answers.length ? answers.shift() : true;
    }),
  });
  const state = { presets: { openai: structuredClone(presets) } };
  const upserts = [];
  runtime.presets = {
    state,
    getActiveId: type => (type === 'openai' ? activeId : ''),
    getActive: type => (type === 'openai' ? structuredClone(state.presets.openai[activeId] || null) : null),
    getResolvedActive: type => (type === 'openai'
      ? { presetId: activeId, preset: structuredClone(state.presets.openai[activeId] || null) }
      : { presetId: null, preset: null }),
    upsert: async (type, { id, name, data, makeActive }) => {
      upserts.push({ type, id, name, makeActive, data: structuredClone(data) });
      state.presets[type][id] = { ...structuredClone(data), name };
      return id;
    },
  };
  // settings/get 读当前会话的上下文：当前预设与交给脚本的设定（已滤掉连线资料）
  runtime.context = {
    ...runtime.context,
    sessionId: 's1',
    openaiPresetId: activeId,
    chatCompletionSettings: { temperature: state.presets.openai[activeId]?.temperature },
  };
  runtime.buildContext = () => ({ openaiPresetId: activeId });
  const request = (path, body, { scriptId = 'sc-1', scriptName = '同步脚本' } = {}) => runtime.processRpc('tavern.request', {
    path, body, scriptId, scriptName, sessionId: 's1',
  });
  return { runtime, bridge, dialogs, upserts, state, request, kv };
};

// 脚本拿到的回应：照 Worker 把 { status, body } 包成 Response
const asResponse = (result) => {
  const worker = createTavernApiWorker({ callRpc: async () => result });
  return worker.interceptFetch('/api/x', { method: 'POST', body: '{}' });
};

const withSettings = async (patch, run) => {
  const original = appSettings.get();
  try {
    appSettings.update(patch);
    return await run();
  } finally {
    appSettings.update(original);
  }
};

test('世界书文件转回 APP 条目：以 uid 为键的物件按 uid 排成数组，缺 uid 用键补上', () => {
  const entries = fromTavernWorldEntries({
    10: { uid: 10, comment: 'ten' },
    2: { comment: 'two, uid from key' },
    3: 'not an entry',
    note: { comment: 'non-numeric key keeps its own fields' },
  });
  assert.deepEqual(entries.map(entry => [entry.uid, entry.comment]), [
    [2, 'two, uid from key'], [10, 'ten'], [undefined, 'non-numeric key keeps its own fields'],
  ]);
  // 已是数组时照原样（只留物件），并且是副本
  const list = [{ uid: 1, comment: 'a' }, null, { comment: 'b' }];
  const converted = fromTavernWorldEntries(list);
  assert.deepEqual(converted, [{ uid: 1, comment: 'a' }, { comment: 'b' }]);
  converted[0].comment = 'changed';
  assert.equal(list[0].comment, 'a');
});

test('worldinfo/edit：读出 → 修改 → 写回，经脚本整本写世界书的同一条路，栏位对应、读回一致', async () => {
  const { request, bridge, dialogs } = createRuntime({
    worlds: {
      Atlas: {
        name: 'Atlas',
        createdAt: 1,
        entries: [{
          uid: 5, comment: 'harbor', content: 'old', key: ['port'], keysecondary: ['ship'], selectiveLogic: 2,
          position: 4, depth: 2, role: 1, order: 50, probability: 70, constant: true, disable: false,
        }],
      },
    },
  });
  const book = (await request('/api/worldinfo/get', { name: 'Atlas' })).body;
  assert.deepEqual(Object.keys(book.entries), ['5']);
  book.entries[5].content = 'new';
  // 脚本自己新增一条酒馆原始格式的条目
  book.entries[9] = { uid: 9, comment: 'gate', content: 'c9', key: ['gate'], keysecondary: [], position: 1, order: 10, disable: true, selective: true };

  const result = await request('/api/worldinfo/edit', { name: 'Atlas', data: book });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  const response = await asResponse(result);
  assert.equal(await response.text(), '{"ok":true}', 'scripts compare the ack text exactly');

  // 确认窗与 createOrReplaceWorldbook 相同：覆盖时危险样式，写明脚本、世界书、条数
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, '脚本要覆盖世界书');
  assert.equal(dialogs[0].danger, true);
  assert.match(dialogs[0].message, /同步脚本/);
  assert.match(dialogs[0].message, /2 条内容完整替换世界书「Atlas」（现有 1 条）/);

  // 存成 APP 格式（条目数组），经导入转换与同名覆盖检查
  assert.equal(bridge.saves.length, 1);
  assert.equal(bridge.saves[0].options.expectedExists, true);
  const saved = bridge.saves[0].data.entries;
  assert.deepEqual(saved.map(entry => [entry.uid, entry.comment, entry.content]), [[5, 'harbor', 'new'], [9, 'gate', 'c9']]);
  assert.deepEqual(saved[0].key, ['port']);
  assert.deepEqual(saved[0].keysecondary, ['ship']);
  assert.deepEqual([saved[0].position, saved[0].depth, saved[0].role, saved[0].order, saved[0].probability, saved[0].selectiveLogic], [4, 2, 1, 50, 70, 2]);
  assert.equal(saved[0].constant, true);
  assert.equal(saved[1].disable, true);
  assert.equal(saved[1].selective, false, 'disabled entries are stored non-selective, same as importing a file');
  assert.equal(saved[1].position, 1);

  // 读回：同样以 uid 为键，内容是刚写的
  const reread = (await request('/api/worldinfo/get', { name: 'Atlas' })).body;
  assert.deepEqual(Object.keys(reread.entries), ['5', '9']);
  assert.equal(reread.entries[5].content, 'new');
  assert.deepEqual(reread.entries[9].key, ['gate']);
});

test('worldinfo/edit：名单里没有的世界书照现有规则走「新建」确认；缺名称或条目回 400 纯文字', async () => {
  const { request, bridge, dialogs } = createRuntime();
  const created = await request('/api/worldinfo/edit', { name: 'Fresh', data: { entries: { 0: { uid: 0, comment: 'a', content: 'x', key: ['k'] } } } });
  assert.equal(created.status, 200);
  assert.equal(dialogs[0].title, '脚本要新建世界书');
  assert.match(dialogs[0].message, /新建世界书「Fresh」，共 1 条/);
  assert.equal(bridge.saves[0].options.expectedExists, false);

  for (const body of [{ data: { entries: {} } }, { name: 'Fresh', data: {} }, { name: 'Fresh', data: { entries: 'x' } }, { name: 'Fresh' }]) {
    const result = await request('/api/worldinfo/edit', body);
    assert.equal(result.status, 400);
    assert.equal(typeof result.body, 'string');
  }
  assert.equal(dialogs.length, 1);
  assert.equal(bridge.saves.length, 1);
});

test('worldinfo/edit：用户拒绝时不写入，回 403 纯文字说明；同一请求本次运行不再弹窗', async () => {
  const { request, bridge, dialogs } = createRuntime({ worlds: { Atlas: { name: 'Atlas', entries: [{ uid: 0, comment: 'keep' }] } }, answers: [false] });
  const body = { name: 'Atlas', data: { entries: { 0: { uid: 0, comment: 'overwrite' } } } };
  const denied = await request('/api/worldinfo/edit', body);
  assert.equal(denied.status, 403);
  assert.match(denied.body, /用户拒绝了这次写入，世界书「Atlas」保持原样/);
  const response = await asResponse(denied);
  assert.equal(response.status, 403);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.match(await response.text(), /保持原样/);
  const again = await request('/api/worldinfo/edit', body);
  assert.equal(again.status, 403);
  assert.equal(dialogs.length, 1);
  assert.equal(bridge.saves.length, 0);
  assert.equal(bridge.store.get('Atlas').entries[0].comment, 'keep');
});

const PRESET_P = Object.freeze({
  name: 'Preset P',
  temperature: 0.7,
  top_p: 0.9,
  openai_model: 'model-x',
  reverse_proxy: 'https://proxy.example/v1',
  proxy_password: 'pw-secret',
  custom_url: 'https://custom.example',
  api_key_custom: 'sk-secret',
  custom_include_headers: 'Authorization: secret',
  prompts: [
    { identifier: 'main', name: 'Main', content: 'main prompt', role: 'system' },
    { identifier: 'style', name: 'Style', content: 'style prompt', role: 'system' },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'style', enabled: true }] }],
});
const SECRET_KEYS = ['reverse_proxy', 'proxy_password', 'custom_url', 'api_key_custom', 'custom_include_headers'];

// 脚本常见的读法：settings/get 里按名称找出预设（名称必须唯一）
const readNamedPreset = (settings, name) => {
  const indices = settings.openai_setting_names.map((item, index) => (item === name ? index : -1)).filter(index => index >= 0);
  assert.equal(indices.length, 1, `preset ${name} must be listed exactly once`);
  return JSON.parse(settings.openai_settings[indices[0]]);
};

test('presets/save：按键合并，保留交给脚本前滤掉的 Key／地址／代理；请求里带的这类栏位不写入', async () => {
  const { request, dialogs, upserts, state } = createRuntime({ presets: { 'p-1': PRESET_P }, activeId: 'p-1' });
  const before = readNamedPreset((await request('/api/settings/get', {})).body, 'Preset P');
  for (const key of SECRET_KEYS) assert.equal(Object.hasOwn(before, key), false, `${key} is filtered before reaching scripts`);

  const next = structuredClone(before);
  next.temperature = 1.1;
  next.prompts[1].content = 'style prompt v2';
  // 脚本把连线栏位写进请求体（例如清空或改成自己的地址）：一律不写入
  next.reverse_proxy = '';
  next.proxy_password = '';
  next.custom_url = 'https://elsewhere.example';
  next.chat_completion_source = 'custom';
  const result = await request('/api/presets/save', { apiId: 'openai', name: 'Preset P', preset: next });
  assert.deepEqual(result, { status: 200, body: { name: 'Preset P' } });

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, 'p-1');
  assert.equal(upserts[0].name, 'Preset P');
  assert.equal(upserts[0].makeActive, false);
  const stored = state.presets.openai['p-1'];
  for (const key of SECRET_KEYS) assert.equal(stored[key], PRESET_P[key], `${key} keeps the user's value`);
  assert.equal(Object.hasOwn(stored, 'chat_completion_source'), false, 'connection fields belong to the API profile');
  assert.equal(stored.temperature, 1.1);
  assert.equal(stored.prompts[1].content, 'style prompt v2');
  assert.equal(stored.top_p, 0.9);

  // 确认窗：哪个脚本、哪个预设、改了什么，另说明保留的连线栏位
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, '脚本要修改对话预设');
  assert.equal(dialogs[0].danger, true);
  assert.match(dialogs[0].message, /「同步脚本」要保存对话预设「Preset P」，改动 2 项设定：temperature、prompts（1 条提示词）。/);
  assert.match(dialogs[0].message, /另有 4 项设定保留 APP 现有的值/);
  assert.doesNotMatch(dialogs[0].message, /secret|proxy\.example/);
});

test('presets/save：存完用 settings/get 读回，与写入的内容一致（当前预设与刚存过的其他预设都读得到）', async () => {
  const other = { name: 'Preset Q', temperature: 1, top_p: 1, reverse_proxy: 'https://q.example' };
  const { request } = createRuntime({ presets: { 'p-1': PRESET_P, 'p-2': other }, activeId: 'p-1' });

  // 当前预设：从 settings/get 读出、只改设定后写回，读回逐字相同
  const before = readNamedPreset((await request('/api/settings/get', {})).body, 'Preset P');
  const next = { ...structuredClone(before), temperature: 0.3, prompts: [...before.prompts, { identifier: 'extra', name: 'Extra', content: 'x', role: 'user' }] };
  assert.equal((await request('/api/presets/save', { apiId: 'openai', name: 'Preset P', preset: next })).status, 200);
  const afterCurrent = readNamedPreset((await request('/api/settings/get', {})).body, 'Preset P');
  assert.equal(JSON.stringify(afterCurrent), JSON.stringify(next));

  // 不是当前预设：存之前 settings/get 不列出，存过之后一并回传（不含连线资料）
  const listed = (await request('/api/settings/get', {})).body.openai_setting_names;
  assert.deepEqual(listed, ['Preset P']);
  assert.equal((await request('/api/presets/save', { apiId: 'openai', name: 'Preset Q', preset: { temperature: 0.5, top_p: 1 } })).status, 200);
  const settings = (await request('/api/settings/get', {})).body;
  assert.deepEqual(settings.openai_setting_names, ['Preset P', 'Preset Q']);
  assert.deepEqual(readNamedPreset(settings, 'Preset Q'), { name: 'Preset Q', temperature: 0.5, top_p: 1 });
  assert.doesNotMatch(JSON.stringify(settings), /q\.example|proxy\.example|pw-secret|sk-secret/);
});

test('presets/save：用户拒绝不写入、回 403 纯文字；内容没变不弹窗；找不到、名称重复、无权限、缺参数', async () => {
  const twin = { name: 'Twin', temperature: 1 };
  const { request, dialogs, upserts } = createRuntime({
    presets: { 'p-1': PRESET_P, 't-1': twin, 't-2': twin }, activeId: 'p-1', answers: [false],
  });
  const denied = await request('/api/presets/save', { apiId: 'openai', name: 'Preset P', preset: { temperature: 0.1 } });
  assert.equal(denied.status, 403);
  assert.match(denied.body, /用户拒绝了这次保存，对话预设「Preset P」保持原样/);
  assert.equal(dialogs.length, 1);
  assert.equal(upserts.length, 0);

  // 内容与现有相同：不必写入，也不弹窗
  const same = await request('/api/presets/save', { apiId: 'openai', name: 'Preset P', preset: { temperature: 0.7, reverse_proxy: '' } });
  assert.deepEqual(same, { status: 200, body: { name: 'Preset P' } });
  assert.equal(dialogs.length, 1);

  // 酒馆遇到新名称会新建文件；APP 的脚本预设写入只改已有的预设，回 404 说明
  const missing = await request('/api/presets/save', { apiId: 'openai', name: 'Brand New', preset: { temperature: 1 } });
  assert.equal(missing.status, 404);
  assert.match(missing.body, /没有名为「Brand New」的对话预设/);
  const duplicate = await request('/api/presets/save', { apiId: 'openai', name: 'Twin', preset: { temperature: 0.2 } });
  assert.equal(duplicate.status, 409);
  for (const body of [{ apiId: 'openai', preset: {} }, { apiId: 'openai', name: 'Preset P' }, { name: 'Preset P', preset: {} }]) {
    assert.equal((await request('/api/presets/save', body)).status, 400);
  }
  await withSettings({ scriptAllowModifyVariables: false }, async () => {
    const forbidden = await request('/api/presets/save', { apiId: 'openai', name: 'Preset P', preset: { temperature: 0.2 } });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body, /允许脚本修改变量/);
  });
  assert.equal(dialogs.length, 1);
  assert.equal(upserts.length, 0);
});

test('存预设与写世界书共用确认队列：一次只开一个确认框', async () => {
  let open = 0;
  let maxOpen = 0;
  const titles = [];
  const { request, upserts, bridge } = createRuntime({
    presets: { 'p-1': PRESET_P },
    activeId: 'p-1',
    confirm: async (options) => {
      titles.push(options.title);
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await tick(5);
      open -= 1;
      return true;
    },
  });
  await Promise.all([
    request('/api/worldinfo/edit', { name: 'Atlas', data: { entries: {} } }),
    request('/api/presets/save', { apiId: 'openai', name: 'Preset P', preset: { temperature: 0.2 } }),
  ]);
  assert.equal(maxOpen, 1);
  assert.deepEqual(titles.sort(), ['脚本要修改对话预设', '脚本要新建世界书'].sort());
  assert.equal(upserts.length, 1);
  assert.equal(bridge.saves.length, 1);
});

test('写入接口不再记兼容缺口；其他类预设（apiId 不是 openai）回 501 并记缺口', async () => {
  const gaps = [];
  const router = createTavernApiRouter({
    listWorldbooks: () => [],
    readWorldbook: () => null,
    getPresetSettings: () => ({}),
    writeWorldbook: async () => ({ denied: false }),
    findPreset: name => (name === 'P' ? { id: 'p', name: 'P', preset: { temperature: 1 } } : null),
    savePreset: async () => {},
    confirmWrite: async () => true,
    recordGap: gap => gaps.push(gap),
  });
  const access = { allowModifyVariables: true, sessionId: 's1' };
  const source = { scriptId: 'sc', scriptName: '脚本' };
  assert.equal((await router.handle({ path: '/api/worldinfo/edit', body: { name: 'W', data: { entries: {} } }, ...source }, access)).status, 200);
  assert.equal((await router.handle({ path: '/api/presets/save', body: { apiId: 'openai', name: 'P', preset: { temperature: 0 } }, ...source }, access)).status, 200);
  assert.equal(gaps.length, 0);

  const instruct = await router.handle({ path: '/api/presets/save', body: { apiId: 'instruct', name: 'P', preset: {} }, ...source }, access);
  assert.equal(instruct.status, 501);
  assert.match(instruct.body.error.message, /只能保存对话预设/);
  assert.deepEqual(gaps.map(gap => [gap.path, gap.scriptId, gap.scriptName]), [['/api/presets/save/instruct', 'sc', '脚本']]);
  // 缺口记录收得下这个路径（只收路径字元）
  const { state } = upsertCompatGapReport(null, buildTavernApiGapReport({ ...gaps[0], revision: 'r1' }), { now: 1 });
  assert.equal(state.reports[0].api, '/api/presets/save/instruct');
});

test('合并与确认窗文字：只列有变动的设定，最多 8 项，提示词另算条数', () => {
  const current = { name: 'N', a: 1, prompts: [{ identifier: 'x', content: '1' }, { identifier: 'y', content: '2' }], api_key_openai: 'k' };
  const incoming = { name: 'Other', a: 2, b: 3, prompts: [{ identifier: 'x', content: '1' }, { identifier: 'z', content: '3' }], api_key_openai: '' };
  const merged = mergeTavernPresetSave(current, incoming);
  assert.deepEqual(merged, { name: 'N', a: 2, prompts: incoming.prompts, api_key_openai: 'k', b: 3 });
  const summary = describeTavernPresetSave(current, incoming);
  assert.deepEqual(summary.changed, ['a', 'prompts', 'b']);
  assert.deepEqual(summary.kept.sort(), ['api_key_openai', 'name']);
  assert.equal(summary.promptChanges, 2, 'one prompt added and one removed');

  const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, index]));
  const dialog = buildPresetSaveDialog({ scriptName: 'S', presetName: 'N', ...describeTavernPresetSave({}, many) });
  assert.match(dialog.message, /改动 10 项设定：k0、k1、k2、k3、k4、k5、k6、k7、…。/);
  assert.doesNotMatch(dialog.message, /另有/);
});

// ---- 世界书读写往返保真 ----

// 脚本写的酒馆世界书文件：顶层带 extensions（脚本拿来认自己的书）与其他栏位，条目是完整的酒馆原始格式
const SENTINEL = 'raw-only-sentinel-7f3a';
const scriptBook = () => ({
  entries: {
    0: {
      uid: 0, key: ['harbor'], keysecondary: [], comment: 'Harbor', content: 'ships at dawn', constant: false, vectorized: false,
      selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: false,
      preventRecursion: false, delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, group: '',
      groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
      automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0, displayIndex: 0, extensions: { owner: 'sync' },
    },
  },
  extensions: { sync_ns: { kind: 'ledger', schema: 2, bookId: 'book-1', receipts: [{ opId: 'op-1' }], marker: SENTINEL } },
  originalData: { note: SENTINEL },
});
const editBook = (request, name, data) => request('/api/worldinfo/edit', { name, data });
const getBook = async (request, name) => (await request('/api/worldinfo/get', { name })).body;
const listBooks = async request => (await request('/api/worldinfo/list', {})).body;

test('往返保真：改既有条目、新增只带少数栏位的条目，读回都与写入的逐字相同；重开 APP 后仍成立', async () => {
  const { request, bridge, kv } = createRuntime();
  const first = scriptBook();
  assert.equal((await editBook(request, 'Ledger', first)).status, 200);
  assert.equal(JSON.stringify(await getBook(request, 'Ledger')), JSON.stringify(first));

  // 改既有条目（连同顶层 extensions）
  const second = structuredClone(first);
  second.entries[0].content = 'ships at dusk';
  second.entries[0].comment = 'Harbor (night)';
  second.extensions.sync_ns.receipts.push({ opId: 'op-2' });
  assert.equal((await editBook(request, 'Ledger', second)).status, 200);
  assert.equal(JSON.stringify(await getBook(request, 'Ledger')), JSON.stringify(second));

  // 新增只带少数栏位的条目：APP 存的是补齐栏位后的条目，读回仍是脚本写的样子
  const third = structuredClone(second);
  third.entries[7] = { uid: 7, key: ['gate'], content: 'the gate is shut' };
  assert.equal((await editBook(request, 'Ledger', third)).status, 200);
  const savedEntries = bridge.store.get('Ledger').entries;
  assert.ok(Object.keys(savedEntries[1]).length > 10, 'the app keeps its own normalized entry');
  assert.equal(savedEntries[1].comment, 'entry-1');
  assert.equal(JSON.stringify(await getBook(request, 'Ledger')), JSON.stringify(third));

  // 重开 APP：新的 store 从 KV 读回索引与原始文件
  const reopened = createRuntime({ kv, worlds: { Ledger: bridge.store.get('Ledger') } });
  assert.equal(JSON.stringify(await getBook(reopened.request, 'Ledger')), JSON.stringify(third));
});

test('顶层 extensions：list 与 get 都回存下的值，没有的回空物件；APP 改过这本书后仍保留', async () => {
  const { request, bridge } = createRuntime({ worlds: { Plain: { name: 'Plain', createdAt: 10, entries: [{ uid: 0, comment: 'p', content: 'p' }] } } });
  await editBook(request, 'Ledger', scriptBook());
  const list = await listBooks(request);
  assert.deepEqual(list.map(item => [item.file_id, item.extensions]), [
    ['Ledger', scriptBook().extensions],
    ['Plain', {}],
  ]);
  const plain = await getBook(request, 'Plain');
  assert.deepEqual(plain.extensions, {});

  // 用户在 APP 里改了这本书：原始内容作废，读回转换后的格式，extensions 仍在
  const world = bridge.store.get('Ledger');
  await bridge.saveWorldInfo('Ledger', { ...world, entries: [{ ...world.entries[0], content: 'edited in app' }] });
  const converted = await getBook(request, 'Ledger');
  assert.equal(converted.entries[0].content, 'edited in app');
  assert.deepEqual(converted.extensions, scriptBook().extensions);
  assert.equal(Object.hasOwn(converted, 'originalData'), false, 'the raw file is no longer used');
  assert.deepEqual((await listBooks(request)).find(item => item.file_id === 'Ledger').extensions, scriptBook().extensions);
});

test('APP 改过之后改回转换后的酒馆格式：去掉 APP 自己的栏位与别名；删掉重建的书不沿用旧记录', async () => {
  const { request, bridge, kv } = createRuntime();
  await editBook(request, 'Ledger', scriptBook());
  const world = bridge.store.get('Ledger');
  await bridge.saveWorldInfo('Ledger', { ...world, refs: [{ sourceId: 'Other' }], entries: [...world.entries, { comment: 'added in app', content: 'x', key: ['k'] }] });

  const converted = await getBook(request, 'Ledger');
  for (const field of ['createdAt', 'updatedAt', 'refs']) assert.equal(Object.hasOwn(converted, field), false, `${field} is app-only`);
  assert.deepEqual(Object.keys(converted.entries), ['0', '1']);
  for (const entry of Object.values(converted.entries)) {
    for (const alias of ['title', 'triggers', 'secondary', 'priority', 'id']) {
      assert.equal(Object.hasOwn(entry, alias), false, `${alias} is an app alias`);
    }
  }
  assert.equal(converted.entries[0].comment, 'Harbor');
  assert.equal(converted.entries[1].comment, 'added in app');

  // 删掉后再建同名的书：建立时间不同，旧的 extensions 与原始内容都不再算数，记录被清掉
  bridge.store.delete('Ledger');
  await bridge.saveWorldInfo('Ledger', { name: 'Ledger', entries: [{ uid: 0, comment: 'new book', content: 'n' }] });
  const recreated = await getBook(request, 'Ledger');
  assert.equal(recreated.entries[0].comment, 'new book');
  assert.deepEqual(recreated.extensions, {});
  assert.deepEqual(JSON.parse(kv.kv.get(SCRIPT_WORLD_FILE_INDEX_KEY)).records, {});
});

test('转换后的格式去掉 APP 栏位：别名与原栏位相同才去掉，APP 自己的功能栏位保留', () => {
  const file = toTavernWorldFile({
    name: 'W', createdAt: 1, updatedAt: 2, refs: [], localEntries: [],
    entries: [{
      id: '4', uid: 4, comment: 'c', title: 'c', key: ['a'], triggers: ['a'], keysecondary: ['b'], secondary: ['b'],
      order: 5, priority: 5, content: 'x', promptBlocks: [{ content: 'x' }],
    }, {
      id: 'custom-id', uid: 6, comment: 'c2', title: 'different title', key: ['a'], triggers: ['normal'], order: 1, priority: 1,
    }],
  });
  assert.deepEqual(Object.keys(file), ['name', 'entries']);
  assert.deepEqual(file.entries[4], { uid: 4, comment: 'c', key: ['a'], keysecondary: ['b'], order: 5, content: 'x', promptBlocks: [{ content: 'x' }] });
  assert.deepEqual(file.entries[6], { id: 'custom-id', uid: 6, comment: 'c2', title: 'different title', key: ['a'], triggers: ['normal'], order: 1 });
});

test('原始内容不进世界书资料：提示词与导出（世界书资料、体验包）都看不到，只在独立的 KV', async () => {
  const { request, bridge, kv } = createRuntime();
  await editBook(request, 'Ledger', scriptBook());
  // 世界书资料（组提示词、世界书导出、角色卡导出读的都是它）
  assert.doesNotMatch(JSON.stringify(bridge.store.get('Ledger')), new RegExp(SENTINEL));
  assert.equal(Object.hasOwn(bridge.store.get('Ledger'), 'extensions'), false);
  // 体验包收集世界书的方式
  const bundle = await collectCustomBundleWorldbookRecords({
    worldIds: ['Ledger'], getWorldInfo: async id => structuredClone(bridge.store.get(id)),
  });
  assert.ok(bundle.Ledger);
  assert.doesNotMatch(JSON.stringify(bundle), new RegExp(SENTINEL));
  // 只存在脚本原始文件的 KV
  const holders = Array.from(kv.kv.entries()).filter(([, value]) => value.includes(SENTINEL)).map(([key]) => key);
  assert.equal(holders.length, 1);
  assert.match(holders[0], /^script_world_file_v1__[0-9a-f]{24}$/);
});

test('超过上限时不存原始内容：单本太大只存 extensions；合计超过时先挤掉最早存的', async () => {
  const big = scriptBook();
  big.entries[0].content = 'x'.repeat(3000);
  const tooBig = createRuntime({ limits: { fileChars: 2000, totalChars: 10000 } });
  await editBook(tooBig.request, 'Ledger', big);
  const converted = await getBook(tooBig.request, 'Ledger');
  assert.equal(converted.entries[0].content, big.entries[0].content);
  assert.equal(Object.hasOwn(converted, 'originalData'), false, 'falls back to the converted format');
  assert.deepEqual(converted.extensions, big.extensions);

  // 合计上限：第二本存进来时挤掉第一本的原始内容，第一本的 extensions 留着
  const size = JSON.stringify(scriptBook()).length;
  const tight = createRuntime({ limits: { fileChars: size + 10, totalChars: size * 2 } });
  await editBook(tight.request, 'Older', scriptBook());
  await tick(2);
  await editBook(tight.request, 'Newer', scriptBook());
  assert.equal(JSON.stringify(await getBook(tight.request, 'Newer')), JSON.stringify(scriptBook()));
  const older = await getBook(tight.request, 'Older');
  assert.equal(Object.hasOwn(older, 'originalData'), false);
  assert.deepEqual(older.extensions, scriptBook().extensions);
});

test('脚本单独写入被拒绝或失败时不记原始内容；读到不存在的书照旧回 { entries: {} }', async () => {
  const { request, kv } = createRuntime({ answers: [false] });
  assert.equal((await editBook(request, 'Ledger', scriptBook())).status, 403);
  assert.equal(kv.kv.size, 0);
  assert.deepEqual(await getBook(request, 'Ledger'), { entries: {} });
});

// 世界书索引读不到（空的）时 getCreatedAt 回 undefined：不确定，不能把所有原始文件记录当成书已删除清掉
test('world file records survive an unreadable worldbook index and are cleared once the book is confirmed gone', async () => {
  const { createScriptWorldFiles } = await import('../../src/scripts/storage/script-world-file-store.js');
  const data = new Map();
  const store = createScriptWorldFileStore({ loadKv: async name => (data.has(name) ? JSON.parse(data.get(name)) : null), saveKv: async (name, value) => { data.set(name, JSON.stringify(value)); } });
  let createdAt = 100;
  const files = createScriptWorldFiles({ store, getCreatedAt: async () => createdAt });
  await files.remember({ name: '书A', file: { entries: {}, extensions: { tag: 'a' } }, savedEntries: [] });
  assert.deepEqual(await files.extensionsFor(['书A']), { 书A: { tag: 'a' } });
  createdAt = undefined;
  await files.extensionsFor(['书A']);
  assert.deepEqual(await store.names(), ['书A'], '索引不确定时不清理');
  createdAt = null;
  assert.deepEqual(await files.extensionsFor(['书A']), {});
  assert.deepEqual(await store.names(), [], '确定书已不存在才清掉');
});
