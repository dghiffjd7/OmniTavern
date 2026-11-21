import assert from 'node:assert/strict';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ||= { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };

const { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } = await import('../../src/scripts/agent/agent-permissions.js');
const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { createPresetEditAgentTools } = await import('../../src/scripts/agent/tools/preset-edit-tools.js');
const { PresetStore } = await import('../../src/scripts/storage/preset-store.js');
const { searchMaidCapabilityConcepts } = await import('../../src/scripts/agent/maid-capability-concept-retriever.js');
const { listAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');

// 真实的预设 store（upsert 会跑同一套正规化），只把落盘换成计数；女仆工具经真实注册表执行。
const openaiPreset = (name, extra = {}) => ({
  name, app_scope: 'all', temperature: 1, top_p: 0.98, openai_max_tokens: 8192,
  prompts: [
    { identifier: 'main', name: '主提示', role: 'system', system_prompt: true, marker: false, content: '你是写作助手。' },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'style', name: '文风', role: 'system', system_prompt: false, marker: false, content: '简洁。' },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'style', enabled: false }] }],
  ...extra,
});

const setup = ({ ignored = [] } = {}) => {
  const store = Object.create(PresetStore.prototype);
  store.ready = Promise.resolve();
  store.isLoaded = true;
  let writes = 0;
  store.persist = async () => { writes += 1; };
  store.state = {
    version: 1,
    presets: { openai: { p1: openaiPreset('写作预设'), p2: openaiPreset('备用预设') }, sysprompt: { s1: { name: '系统一', content: 'x' } }, context: {}, instruct: {}, reasoning: {} },
    active: { openai: 'p1', sysprompt: 's1' }, builtinActive: {}, enabled: { openai: true }, bindings: {},
  };
  const changed = [];
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(createPresetEditAgentTools({
    presetStore: store,
    scriptStore: { getScripts: (scope, id) => (scope === 'preset' && id === 'p1' ? [{ id: 's' }, { id: 't' }] : []) },
    regexStore: { listLocalSets: () => [{ id: 'r1', bind: { type: 'preset', presetType: 'openai', presetIds: ['p1'] } }] },
    getCurrentSessionId: () => 'rp:card',
    getUiMode: () => 'rp',
    onPresetsChanged: () => changed.push(1),
    getIgnoredParams: () => ignored,
  }));
  const requests = [];
  const run = (name, args, { allow = true, onConfirm = null } = {}) => registry.executeTool(name, args, {
    sessionId: 'rp:card',
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: async (request) => {
      requests.push(request);
      return onConfirm ? onConfirm(request) : { decision: allow ? 'allow' : 'deny' };
    },
  });
  const order = id => store.getPreset('openai', id).prompt_order[0].order.map(row => `${row.identifier}${row.enabled === false ? '(off)' : ''}`);
  return { store, run, requests, changed, order, writes: () => writes };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('preset.read shows the parameters, entries in order and one entry in full', async () => {
  const { run } = setup({ ignored: ['temperature'] });
  const read = await run('preset.read', {});
  assert.equal(read.result.ok, true);
  assert.equal(read.result.presetId, 'p1', 'defaults to the preset in use');
  assert.equal(read.result.params.temperature, 1);
  assert.equal(read.result.params.top_k, 64, 'missing values show the panel default');
  assert.deepEqual(read.result.ignoredByConnection, ['temperature']);
  assert.deepEqual(read.result.entries.map(entry => entry.identifier), ['main', 'chatHistory', 'style']);
  assert.equal(read.result.entries[1].marker, true);
  assert.equal(read.result.entries[2].enabled, false);
  const one = await run('preset.read', { preset: '备用预设', entry: '主提示' });
  assert.equal(one.result.entry.content, '你是写作助手。');
});

test('entries are edited, added and moved with one confirmation and read back', async () => {
  const { run, requests, store, order, changed } = setup();
  const result = await run('preset.prompt_entries.upsert', { entries: [
    { entry: '主提示', content: '你是细腻的写作助手。' },
    { create: true, name: '节奏', content: '每段不超过四句。', after: '文风' },
    { entry: 'style', enabled: true, before: 'chatHistory' },
  ] });
  assert.equal(result.result.succeededCount, 3, JSON.stringify(result.result));
  const request = requests.at(-1);
  assert.equal(request.kind, 'preset.prompt_entries.upsert');
  assert.match(request.message, /预设「写作预设」的 3 个条目/);
  assert.match(request.details.items[0].meta, /内容：系统 · 7 字 ⇒ 系统 · 10 字/);
  assert.match(request.details.items[1].meta, /新增/);
  const preset = store.getPreset('openai', 'p1');
  assert.equal(preset.prompts.find(item => item.identifier === 'main').content, '你是细腻的写作助手。');
  const created = preset.prompts.find(item => item.name === '节奏');
  assert.ok(created && created.marker === false);
  assert.deepEqual(order('p1'), ['main', 'style', 'chatHistory', created.identifier]);
  assert.equal(changed.length, 1);
});

test('a new entry without a position goes first, like the preset panel', async () => {
  const { run, order, store } = setup();
  await run('preset.prompt_entries.upsert', { entries: [{ create: true, name: '开头', content: '……' }] });
  const id = store.getPreset('openai', 'p1').prompts.find(item => item.name === '开头').identifier;
  assert.equal(order('p1')[0], id);
});

test('marker entries are protected; a failed item leaves no partial change', async () => {
  const { run, store, order } = setup();
  const result = await run('preset.prompt_entries.upsert', { entries: [
    { entry: 'chatHistory', content: '改不了' },
    { entry: '主提示', content: '不该写入', before: '不存在' },
    { create: true, name: '孤儿', content: '不该出现', after: '不存在' },
    { entry: 'style', before: 'style' },
  ] });
  const statuses = result.result.results.map(item => `${item.status}:${item.reason}`);
  assert.deepEqual(statuses, ['protected:marker_entry', 'failed:anchor_not_found', 'failed:anchor_not_found', 'failed:anchor_is_self']);
  const preset = store.getPreset('openai', 'p1');
  assert.equal(preset.prompts.find(item => item.identifier === 'main').content, '你是写作助手。');
  assert.equal(preset.prompts.some(item => item.name === '孤儿'), false);
  assert.deepEqual(order('p1'), ['main', 'chatHistory', 'style(off)']);
});

test('a preset changed during the confirmation is not overwritten; cancelling writes nothing', async () => {
  const { run, store, writes } = setup();
  const result = await run('preset.prompt_entries.upsert', { entries: [{ entry: '主提示', content: '新的' }] }, {
    onConfirm: async () => {
      const data = structuredClone(store.getPreset('openai', 'p1'));
      data.prompts[0].content = '别处改的';
      await store.upsert('openai', { id: 'p1', name: data.name, data, makeActive: false });
      return { decision: 'allow' };
    },
  });
  assert.equal(result.result.reason, 'target_changed_during_confirmation');
  assert.equal(store.getPreset('openai', 'p1').prompts[0].content, '别处改的');
  const before = writes();
  const cancelled = await run('preset.prompt_entries.upsert', { entries: [{ entry: '主提示', content: '取消' }] }, { allow: false });
  assert.equal(cancelled.result.ok, false);
  assert.equal(writes(), before);
});

test('generation parameters change with a before ⇒ after list and an ignored-by-connection note', async () => {
  const { run, requests, store } = setup({ ignored: ['temperature', 'top_k'] });
  const result = await run('preset.params.update', { params: { temperature: 0.7, openai_max_tokens: 4000, top_p: 0.98 } });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.deepEqual(result.result.changes.map(change => change.key), ['temperature', 'openai_max_tokens'], 'unchanged values are skipped');
  assert.deepEqual(result.result.ignoredByConnection, ['temperature']);
  assert.match(requests.at(-1).message, /当前连线会忽略：temperature/);
  assert.equal(requests.at(-1).details.items[0].meta, '1 ⇒ 0.7');
  const preset = store.getPreset('openai', 'p1');
  assert.equal(preset.temperature, 0.7);
  assert.equal(preset.openai_max_tokens, 4000);
  const same = await run('preset.params.update', { params: { temperature: 0.7 } });
  assert.equal(same.result.skipped, true);
  await assert.rejects(run('preset.params.update', { params: { temperature: 5 } }), /must be <= 2/, 'out-of-range values are rejected by the schema');
});

test('copy duplicates a preset without switching and says what was left behind; rename refuses a taken name', async () => {
  const { run, requests, store } = setup();
  const copy = await run('preset.copy', { preset: '写作预设', name: '写作预设 副本' });
  assert.equal(copy.result.ok, true, JSON.stringify(copy.result));
  assert.match(requests.at(-1).message, /2 个脚本、1 组正则不会一起复制/);
  const copied = store.getPreset('openai', copy.result.presetId);
  assert.equal(copied.name, '写作预设 副本');
  assert.equal(copied.prompts.length, 3);
  assert.equal(store.getActiveId('openai'), 'p1', 'the copy is not switched to');
  const taken = await run('preset.copy', { preset: 'p1', name: '备用预设' });
  assert.equal(taken.result.reason, 'name_taken');
  const renamed = await run('preset.rename', { preset: '备用预设', name: '旧版预设' });
  assert.equal(renamed.result.ok, true);
  assert.equal(store.getPreset('openai', 'p2').name, '旧版预设');
  const clash = await run('preset.rename', { preset: 'p2', name: '写作预设' });
  assert.equal(clash.result.reason, 'name_taken');
  const other = await run('preset.rename', { type: 'sysprompt', preset: '系统一', name: '系统主提示' });
  assert.equal(other.result.ok, true);
  assert.equal(store.getPreset('sysprompt', 's1').name, '系统主提示');
});

test('the maid finds the preset edit tools', async () => {
  const features = listAppFeatures();
  const top = query => searchMaidCapabilityConcepts(query, { features, limit: 4 }).map(item => item.id);
  assert.ok(top('把预设的主提示内容改一下').includes('preset.prompt_entries.upsert'));
  assert.ok(top('预设温度调到0.7').includes('preset.params.update'));
  assert.ok(top('复制这个预设').includes('preset.copy'));
  assert.ok(top('预设改名叫旧版').includes('preset.rename'));
  assert.ok(top('看看预设里有哪些条目和内容').includes('preset.read'));
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}
if (failed) process.exit(1);
