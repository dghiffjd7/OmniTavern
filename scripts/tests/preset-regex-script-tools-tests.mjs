import assert from 'node:assert/strict';

import { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import {
  compileRegexSource,
  createPresetRegexScriptAgentTools,
  resolveNamedTarget,
} from '../../src/scripts/agent/tools/preset-regex-script-tools.js';
import { searchMaidCapabilityConcepts } from '../../src/scripts/agent/maid-capability-concept-retriever.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

const clone = value => JSON.parse(JSON.stringify(value));

// ── 最小假存储：只实现工具用到的接口，行为与真实存储一致 ──
const createPresetStore = () => {
  const state = {
    presets: {
      openai: {
        builtin: { name: '内置默认', prompts: [], prompt_order: [] },
        p_main: {
          name: '主预设',
          prompts: [{ identifier: 'main', name: '主提示' }, { identifier: 'nsfw', name: '尺度说明' }, { identifier: 'jb', name: '越狱' }],
          prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'nsfw', enabled: true }, { identifier: 'jb', enabled: false }] }],
        },
        p_alt: { name: '备用预设', prompts: [], prompt_order: [] },
        p_dup1: { name: '同名', prompts: [], prompt_order: [] },
        p_dup2: { name: '同名', prompts: [], prompt_order: [] },
      },
      sysprompt: {}, context: {}, instruct: {}, reasoning: {},
    },
    active: { openai: 'p_main' },
    builtinActive: { openai: 'builtin' },
    sessions: {},
  };
  return {
    ready: Promise.resolve(),
    state,
    getState: () => clone(state),
    getEnabled: () => true,
    list: type => Object.entries(state.presets[type] || {}).map(([id, data]) => ({ id, ...clone(data) })),
    getActiveId: type => state.active[type] || null,
    getSessionBindingId: (type, sid) => state.sessions[`${type}:${sid}`] || null,
    getResolvedActiveId: (type, ctx = {}) => {
      const bound = state.sessions[`${type}:${ctx.sessionId}`];
      if (bound && state.presets[type][bound]) return { presetId: bound, source: 'session', mode: 'chat' };
      return { presetId: state.builtinActive[type] || null, source: 'builtin', mode: 'chat' };
    },
    setSessionBinding: async (type, sid, id) => { state.sessions[`${type}:${sid}`] = id; },
    setActive: async (type, id) => { state.active[type] = id; },
    upsert: async (type, { id, name, data }) => { state.presets[type][id] = { ...clone(data), name }; return id; },
    remove: async (type, id) => { delete state.presets[type][id]; },
  };
};

const createRegexStore = () => {
  const state = {
    global: { enabled: true, rules: [{ id: 'g1', scriptName: '去括号', findRegex: '/\\(.*?\\)/g', replaceString: '', placement: [2], disabled: false }] },
    sets: {
      s_card: { id: 's_card', name: '状态栏美化', manualEnabled: true, enabled: true, bind: { type: 'preset', presetType: 'openai', presetId: 'p_alt', presetIds: ['p_alt'] }, rules: [{ id: 'r1', scriptName: '状态栏', findRegex: '<status>', replaceString: '', placement: [2], disabled: false }] },
      s_shared: { id: 's_shared', name: '共享组', manualEnabled: true, enabled: true, bind: { type: 'preset', presetType: 'openai', presetId: 'p_alt', presetIds: ['p_alt', 'p_main'] }, rules: [] },
    },
    order: ['s_card', 's_shared'],
    session: {},
  };
  let seq = 0;
  const normalizeRules = rules => (rules || []).map(rule => ({ ...rule, id: rule.id || `re_new_${++seq}` }));
  return {
    ready: Promise.resolve(),
    state,
    getGlobal: () => clone(state.global),
    setGlobal: async next => { state.global = { enabled: next.enabled !== false, rules: normalizeRules(next.rules) }; },
    listLocalSets: () => state.order.map(id => clone(state.sets[id])),
    getLocalSet: id => (state.sets[id] ? clone(state.sets[id]) : null),
    upsertLocalSet: async ({ id, name, enabled, bind, rules }) => {
      const setId = id || `set_new_${++seq}`;
      state.sets[setId] = { ...(state.sets[setId] || {}), id: setId, name, bind: bind ?? null, manualEnabled: enabled !== false, enabled: enabled !== false, rules: normalizeRules(rules) };
      if (!state.order.includes(setId)) state.order.push(setId);
      return setId;
    },
    removeLocalSet: async id => { delete state.sets[id]; state.order = state.order.filter(item => item !== id); },
    getSession: sid => clone(state.session[sid] || { enabled: true, rules: [] }),
    setSession: async (sid, next) => { state.session[sid] = { enabled: next.enabled !== false, rules: normalizeRules(next.rules) }; },
  };
};

const createScriptStore = () => {
  const state = {
    global: [{ id: 'sc_ok', name: '好感度面板', enabled: false, authorized: false, content: 'console.log(1)', compatibility: { blocked: false } },
      { id: 'sc_block', name: '外部扩展', enabled: false, authorized: false, content: 'import x', compatibility: { blocked: true, reasons: ['需要安装外部扩展'] } }],
    character: { card1: [{ id: 'sc_card', name: '角色小剧场', enabled: true, authorized: true, content: '', compatibility: { blocked: false } }] },
    preset: {},
  };
  const bucket = (scope, id) => (scope === 'global' ? state.global : (state[scope][id] ||= []));
  return {
    ready: Promise.resolve(),
    state,
    listScopes: () => ({ character: Object.keys(state.character), preset: Object.keys(state.preset) }),
    getScripts: (scope, id) => clone(bucket(scope, id)),
    getActiveScripts: () => [],
    toggleScript: async (scope, id, scriptId, enabled) => {
      const item = bucket(scope, id).find(script => script.id === scriptId);
      if (!item) return false;
      if (enabled && item.compatibility?.blocked) return false;
      item.enabled = enabled;
      if (enabled) item.authorized = true;
      return true;
    },
    deleteScript: async (scope, id, scriptId) => {
      const list = bucket(scope, id);
      const index = list.findIndex(script => script.id === scriptId);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    },
    removeScope: async (scope, id) => { delete state[scope][id]; return true; },
  };
};

// 真实预设存储提供的轻量读取接口：摘要与单个预设副本；list() 会整份复制整类预设
const withLightweightPresetReads = (store) => ({
  ...store,
  list: () => { throw new Error('list() should not be needed'); },
  listSummaries: type => Object.entries(store.state.presets[type] || {}).map(([id, data]) => ({ id, name: data?.name, app_scope: data?.app_scope })),
  getPreset: (type, id) => (store.state.presets[type]?.[id] ? { id, ...clone(store.state.presets[type][id]) } : null),
  getSelectionState: () => ({ active: { ...store.state.active }, enabled: {}, builtinActive: { ...store.state.builtinActive } }),
  getState: () => { throw new Error('getState() should not be needed'); },
});

const setup = ({ scriptEnabled = false, lightweight = false } = {}) => {
  const presetStore = lightweight ? withLightweightPresetReads(createPresetStore()) : createPresetStore();
  const regexStore = createRegexStore();
  const scriptStore = createScriptStore();
  const events = [];
  const tools = createPresetRegexScriptAgentTools({
    presetStore, regexStore, scriptStore,
    getCurrentSessionId: () => 'sess_1',
    getUiMode: () => 'chat',
    getPersonaName: id => (id === 'card1' ? '苏晓彤' : ''),
    getScriptSettings: () => ({ scriptEnabled, scriptAllowNetwork: false }),
    onPresetsChanged: () => events.push('preset-changed'),
    onRegexChanged: () => events.push('regex-changed'),
    onScriptsChanged: () => events.push('scripts-changed'),
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const requests = [];
  const run = (name, args, { allow = true } = {}) => registry.executeTool(name, args, {
    sessionId: 'sess_1',
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => { requests.push(request); return allow ? { decision: 'allow' } : { decision: 'deny' }; },
  });
  return { presetStore, regexStore, scriptStore, events, run, requests };
};

{
  assert.deepEqual(resolveNamedTarget([{ id: 'a', name: '主预设' }], ' 主 预设 ').item.id, 'a', '名称忽略空白');
  assert.equal(resolveNamedTarget([{ id: 'a', name: 'X' }, { id: 'b', name: 'x' }], 'x').error, 'ambiguous_target', '重名不猜目标');
  assert.equal(compileRegexSource('/a(b/g').ok, false);
  assert.equal(compileRegexSource('/<status>(.*?)<\\/status>/gs').ok, true);
  assert.equal(compileRegexSource('').reason, 'empty_regex');
  console.log('ok - target resolution and regex compile check');
}

{
  const { run, presetStore, requests, events } = setup();
  const list = await run('preset.list', { type: 'openai', includeEntries: true });
  assert.equal(list.status, 'succeeded');
  const openai = list.result.presets.openai;
  assert.equal(openai.inUse.presetId, 'builtin');
  assert.equal(openai.presets.find(item => item.id === 'p_main').globalDefault, true);
  // 数量放在最前、每项只带为真的标记：清单被截断时仍能数清数量
  assert.equal(list.result.counts.openai, openai.presets.length);
  assert.equal(openai.count, openai.presets.length);
  assert.equal(Object.keys(list.result)[2], 'counts', 'counts come before the long lists');
  assert.equal(Object.hasOwn(openai.presets.find(item => item.id === 'p_alt'), 'inUse'), false, 'false flags are omitted');
  const allTypes = await run('preset.list', {});
  assert.deepEqual(Object.keys(allTypes.result.counts), ['openai', 'sysprompt', 'context', 'instruct', 'reasoning']);

  const switched = await run('preset.switch', { preset: '备用预设' });
  assert.equal(switched.result.ok, true);
  assert.equal(switched.result.scope, 'session', '默认只对当前会话生效');
  assert.equal(presetStore.state.sessions['openai:sess_1'], 'p_alt');
  assert.equal(presetStore.state.active.openai, 'p_main', '不动全局默认');
  assert.equal(requests[0].kind, 'preset.switch');
  assert.equal(requests[0].allowAlways, true);
  assert.ok(events.includes('preset-changed'));

  const again = await run('preset.switch', { preset: 'p_alt' });
  assert.equal(again.result.changed, false, '已是目标时不再确认');
  assert.equal(requests.length, 1);

  const ambiguous = await run('preset.switch', { preset: '同名' });
  assert.equal(ambiguous.result.reason, 'ambiguous_target');
  assert.equal(ambiguous.result.candidates.length, 2);

  const global = await run('preset.switch', { preset: '主预设', scope: 'global' });
  assert.equal(global.result.changed, false, '全局已是主预设');
  const denied = await run('preset.switch', { preset: '备用预设', scope: 'global' }, { allow: false });
  assert.equal(denied.status, 'skipped');
  assert.equal(presetStore.state.active.openai, 'p_main', '拒绝后不写入');
  console.log('ok - preset.list / preset.switch default to the current session and confirm once');
}

{
  const { run, presetStore, requests } = setup();
  const result = await run('preset.prompt_entries.toggle', { preset: '主预设', entries: ['尺度说明', 'jb', '不存在'], enabled: false });
  assert.equal(result.result.succeededCount, 1, '只有尺度说明需要改');
  const order = presetStore.state.presets.openai.p_main.prompt_order[0].order;
  assert.equal(order.find(item => item.identifier === 'nsfw').enabled, false);
  assert.equal(order.find(item => item.identifier === 'main').enabled, true, '未点名的条目不变');
  assert.deepEqual(result.result.results.map(item => item.status), ['succeeded', 'skipped', 'missing'], '已是目标状态的跳过，找不到的单独报告');
  assert.equal(requests[0].details.items.length, 3);
  console.log('ok - preset.prompt_entries.toggle patches only named entries and reads back');
}

{
  const { run, presetStore, regexStore, requests } = setup();
  const result = await run('preset.delete_many', { type: 'openai', presets: ['备用预设', '内置默认'], includeBound: true });
  assert.equal(requests[0].kind, 'preset.delete_many');
  assert.equal(requests[0].allowAlways, false);
  assert.equal(result.result.succeededCount, 1);
  assert.equal(result.result.results.find(item => item.presetId === 'builtin').reason, 'builtin_default_protected');
  assert.equal(presetStore.state.presets.openai.p_alt, undefined);
  assert.equal(regexStore.state.sets.s_card, undefined, '只绑定该预设的正则组一并删除');
  assert.deepEqual(regexStore.state.sets.s_shared.bind.presetIds, ['p_main'], '共享正则组只解除绑定');

  const keep = setup();
  await keep.run('preset.delete_many', { type: 'openai', presets: ['p_alt'] });
  assert.ok(keep.regexStore.state.sets.s_card, '默认保留绑定的正则');
  console.log('ok - preset.delete_many protects the built-in default and handles bound regex on request');
}

{
  const { run, regexStore, requests, events } = setup();
  const list = await run('regex.list', { includeRules: true });
  assert.equal(list.result.global.rules[0].id, 'g1', '全局正则也能读到');
  assert.equal(list.result.sets[0].bind, '绑定预设：备用预设');
  const containers = await run('regex.list', { includeRules: false });
  assert.equal(containers.result.sets[0].rules, undefined, 'includeRules:false 只列容器');
  assert.equal(containers.result.sets[0].ruleCount, regexStore.state.sets[containers.result.sets[0].id].rules.length);
  assert.equal(typeof containers.result.global.ruleCount, 'number');
  assert.ok(Array.isArray((await run('regex.list', {})).result.sets[0].rules), '不传 includeRules 时仍列规则摘要');
  const firstSet = list.result.sets[0];
  const one = await run('regex.list', { container: firstSet.name, includeRules: true });
  assert.deepEqual(one.result.sets.map(set => set.id), [firstSet.id], 'container 只读目标规则集');
  assert.equal(one.result.global, undefined);
  assert.equal((await run('regex.list', { container: 'global' })).result.sets, undefined);
  assert.equal((await run('regex.list', { container: '不存在的组' })).result.reason, 'container_not_found');
  // 规则很多时不带 includeRules 的列表自动只给规则数，读单个容器仍给规则
  const bigSet = Object.values(regexStore.state.sets)[0];
  for (let i = 0; i < 40; i += 1) bigSet.rules.push({ id: `bulk-${i}`, scriptName: `批量${i}`, findRegex: `x${i}`, replaceString: '', placement: [2] });
  const compact = await run('regex.list', {});
  assert.equal(compact.result.sets[0].rules, undefined);
  assert.ok(compact.result.sets.every(set => typeof set.ruleCount === 'number'));
  assert.match(compact.result.note, /container/);
  assert.ok((await run('regex.list', { container: bigSet.id })).result.sets[0].rules.length > 40);
  assert.ok(Array.isArray((await run('regex.list', { includeRules: true })).result.sets[0].rules), '明确要求规则时照常列出');

  const toggled = await run('regex.toggle', { targets: ['状态栏美化', 'g1'], enabled: false });
  assert.equal(toggled.result.succeededCount, 2);
  assert.equal(regexStore.state.sets.s_card.manualEnabled, false);
  assert.equal(regexStore.state.global.rules[0].disabled, true);
  assert.equal(requests[0].allowAlways, true);
  assert.ok(events.includes('regex-changed'));

  const invalid = await run('regex.upsert_rules', { rules: [{ scriptName: '坏正则', findRegex: '/a(b/' }] });
  assert.equal(invalid.result.failedCount, 1);
  assert.equal(invalid.result.results[0].reason, 'invalid_regex');
  assert.equal(regexStore.state.global.rules.length, 1, '编译失败不写入');

  const created = await run('regex.upsert_rules', { target: 'session', rules: [{ scriptName: '去星号', findRegex: '/\\*/g', replaceString: '' }] });
  assert.equal(created.result.succeededCount, 1);
  assert.deepEqual(regexStore.state.session.sess_1.rules[0].placement, [2], '新规则默认作用于 AI 输出');

  const updated = await run('regex.upsert_rules', { target: '状态栏美化', rules: [{ id: 'r1', replaceString: '[状态]' }] });
  assert.equal(updated.result.succeededCount, 1);
  const lastRequest = requests.at(-1);
  assert.equal(lastRequest.kind, 'regex.upsert_rules');
  assert.equal(lastRequest.allowAlways, false);
  assert.match(lastRequest.details.items[0].meta, /修改/);
  assert.equal(regexStore.state.sets.s_card.rules[0].replaceString, '[状态]');
  assert.equal(regexStore.state.sets.s_card.rules[0].findRegex, '<status>', '只改传入的字段');

  const newSet = await run('regex.upsert_rules', { newSetName: '新组', rules: [{ scriptName: 'a', findRegex: 'a' }] });
  assert.equal(newSet.result.succeededCount, 1);
  assert.ok(regexStore.listLocalSets().some(set => set.name === '新组' && set.bind === null));

  // preview:true 只列出将删的项目：不弹确认、不删除
  const requestsBeforePreview = requests.length;
  const previewed = await run('regex.delete_many', { targets: ['共享组', 'g1'], preview: true });
  assert.equal(previewed.result.preview, true);
  assert.equal(previewed.result.plannedCount, 2);
  assert.equal(requests.length, requestsBeforePreview, 'preview asks for no confirmation');
  assert.ok(regexStore.state.sets.s_shared, 'preview deletes nothing');
  const removed = await run('regex.delete_many', { targets: ['共享组', 'g1'] });
  assert.equal(removed.result.succeededCount, 2);
  assert.equal(regexStore.state.sets.s_shared, undefined);
  assert.equal(regexStore.state.global.rules.length, 0);
  console.log('ok - regex list/toggle/upsert/delete validate, confirm and read back');
}

{
  const { run, scriptStore, requests, events } = setup({ scriptEnabled: false });
  const list = await run('script.list', {});
  assert.equal(list.result.scriptsRunGlobally, false);
  assert.equal(list.result.scripts.find(item => item.id === 'sc_card').scopeLabel, '角色卡：苏晓彤');
  assert.equal(list.result.scripts[0].code, undefined, '默认不返回代码');

  const enabled = await run('script.toggle_many', { scripts: ['好感度面板', '外部扩展'], enabled: true });
  assert.equal(requests[0].kind, 'script.enable');
  assert.equal(requests[0].allowAlways, false, '启用脚本不提供始终允许');
  assert.match(requests[0].message, /访问网络：禁用/);
  assert.match(requests[0].message, /全局脚本开关目前关闭/);
  assert.equal(enabled.result.succeededCount, 1);
  assert.equal(enabled.result.results.find(item => item.id === 'sc_block').reason, 'blocked_by_compatibility');
  assert.equal(scriptStore.state.global[0].enabled, true);
  assert.equal(enabled.result.scriptsRunGlobally, false);
  assert.ok(events.includes('scripts-changed'));

  const disabled = await run('script.toggle_many', { scripts: ['角色小剧场'], enabled: false });
  assert.equal(requests.at(-1).kind, 'script.disable');
  assert.equal(requests.at(-1).allowAlways, true);
  assert.equal(disabled.result.succeededCount, 1);

  const deniedDelete = await run('script.delete_many', { scripts: ['sc_ok'] }, { allow: false });
  assert.equal(deniedDelete.status, 'skipped');
  assert.equal(scriptStore.state.global.length, 2, '拒绝删除时不写入');
  const deleted = await run('script.delete_many', { scripts: ['sc_ok'] });
  assert.equal(deleted.result.succeededCount, 1);
  assert.equal(scriptStore.state.global.some(item => item.id === 'sc_ok'), false);
  console.log('ok - script toggle asks every time to enable, blocks incompatible scripts and deletes with confirmation');
}

{
  const features = listAppFeatures();
  const ids = text => searchMaidCapabilityConcepts(text, { features }).map(item => item.id);
  assert.ok(ids('帮我把预设换成备用预设').includes('preset.switch'));
  assert.ok(ids('关掉预设里的越狱条目').includes('preset.prompt_entries.toggle'));
  assert.ok(ids('删除这几个预设').includes('preset.delete_many'));
  assert.ok(ids('把状态栏那组正则停用').includes('regex.toggle'));
  assert.ok(ids('帮我加一条正则，把星号去掉').includes('regex.upsert_rules'));
  assert.ok(ids('删掉没用的正则').includes('regex.delete_many'));
  assert.ok(ids('启用好感度面板脚本').includes('script.toggle_many'));
  assert.ok(ids('现在有哪些脚本').includes('script.list'));
  const score = (text, id) => searchMaidCapabilityConcepts(text, { features }).find(item => item.id === id)?.score || 0;
  assert.ok(!ids('打开正则面板').includes('regex.toggle'), '打开面板不算启停');
  assert.ok(score('打开脚本页面', 'script.toggle_many') < 100, '打开脚本页面不给启停意图的高分');
  assert.ok(score('启用好感度面板脚本', 'script.toggle_many') >= 100);
  console.log('ok - capability concepts route preset / regex / script requests');
}

{
  // 女仆默认只给模型看有界候选：新工具必须能进入前 8 名
  const { createMaidCapabilityRoutingRuntime } = await import('../../src/scripts/agent/maid-capability-routing.js');
  const features = listAppFeatures();
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) }, logger: { warn() {} } });
  new Set(features.flatMap(feature => feature.tools || [])).forEach(name => registry.register({ name, schema: { type: 'object', properties: {} }, riskLevel: 'low', execute: async () => ({ ok: true }) }));
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const cases = [
    ['帮我把这个聊天的预设换成「备用预设」', 'preset.switch'],
    ['把当前预设里的越狱条目关掉', 'preset.prompt_entries.toggle'],
    ['删除预设「旧预设A」和「旧预设B」', 'preset.delete_many'],
    ['把状态栏美化那组正则停用', 'regex.toggle'],
    ['帮我写一条正则，把回复里的星号去掉', 'regex.upsert_rules'],
    ['删掉全局正则里的去括号规则', 'regex.delete_many'],
    ['现在有哪些脚本开着', 'script.list'],
    ['帮我启用好感度面板这个脚本', 'script.toggle_many'],
    ['把角色小剧场脚本删除', 'script.delete_many'],
  ];
  for (const [input, id] of cases) {
    const request = runtime.beginRequest({ input });
    const snapshot = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner', configOverride: { mode: 'bounded' } });
    assert.equal(snapshot.candidateIds.has(id), true, `${input} → 候选应包含 ${id}（实际：${[...snapshot.candidateIds].join(', ')}）`);
    runtime.finishRequest(request.id, { ok: true });
  }
  console.log('ok - bounded candidate routing keeps the new preset / regex / script tools in the top-k');
}

{
  // 工具只读名称与单个预设时不复制整类预设：同样的调用在只有轻量接口时结果一致
  const plain = setup();
  const light = setup({ lightweight: true });
  const strip = value => JSON.parse(JSON.stringify(value));
  for (const [name, args] of [
    ['preset.list', { type: 'openai', includeEntries: true }],
    ['regex.list', { includeRules: false }],
  ]) {
    assert.deepEqual(strip((await light.run(name, args)).result), strip((await plain.run(name, args)).result), `${name} 结果一致`);
  }
  for (const env of [plain, light]) {
    assert.equal((await env.run('preset.switch', { type: 'openai', preset: '备用预设' })).result.ok, true);
    assert.equal((await env.run('preset.prompt_entries.toggle', { preset: '主预设', entries: ['越狱'], enabled: true })).result.ok, true);
    const guarded = await env.run('preset.delete_many', { type: 'openai', presets: ['内置默认'] });
    assert.notEqual(guarded.result?.ok, true, '内置默认受保护');
    assert.ok(env.presetStore.state.presets.openai.builtin);
  }
  assert.deepEqual(light.presetStore.state.presets.openai.p_main.prompt_order, plain.presetStore.state.presets.openai.p_main.prompt_order);
  console.log('ok - preset tools read summaries and single presets instead of copying every preset');
}
