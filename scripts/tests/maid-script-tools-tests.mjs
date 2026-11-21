import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ||= { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };

const { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } = await import('../../src/scripts/agent/agent-permissions.js');
const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { createScriptEditAgentTools, applyScriptEdits } = await import('../../src/scripts/agent/tools/script-edit-tools.js');
const { createPresetRegexScriptAgentTools } = await import('../../src/scripts/agent/tools/preset-regex-script-tools.js');
const { ScriptStore } = await import('../../src/scripts/storage/script-store.js');
const { analyzeScriptCompatibility } = await import('../../src/scripts/import/script-capability-preflight.js');
const { createMaidToolConfirmationRuntime } = await import('../../src/scripts/ui/maid-tool-confirmation-runtime.js');
const { createMaidCapabilityRoutingRuntime } = await import('../../src/scripts/agent/maid-capability-routing.js');
const { searchMaidCapabilityConcepts } = await import('../../src/scripts/agent/maid-capability-concept-retriever.js');
const { listAppFeatures, searchAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');

// 会被兼容性检查拦截的代码：访问宿主页面 DOM 又用酒馆扩展接口
const BLOCKED_CODE = 'window.parent.document.body.appendChild(panel);\nextension_settings.demo = true;\n';
const LONG_CODE = 'x'.repeat(45000);

// 真实的脚本存储（新建、修改都跑同一套正规化与兼容性检查），落盘在 node 下退回空的 localStorage
const setup = async ({ settings = {}, personaId = 'card1', presetId = 'p1' } = {}) => {
  const store = new ScriptStore();
  await store.ready;
  await store.setScripts('global', '', [
    { id: 'g1', name: '好感度面板', content: 'const hp = 1;\nconsole.log("hp");\nconsole.log("mp");\n', enabled: true, authorized: true },
    { id: 'g2', name: '状态栏', content: 'let x = 1;\nlet x2 = 1;\n', info: '显示状态', enabled: false },
    { id: 'g3', name: '同名脚本', content: 'a();', enabled: false },
    { id: 'g4', name: '长脚本', content: LONG_CODE, enabled: false },
    { id: 'g5', name: '外部扩展', content: BLOCKED_CODE, enabled: false },
  ]);
  await store.setScripts('character', 'card1', [
    { id: 'c1', name: '同名脚本', content: 'b();', enabled: false },
    { id: 'c2', name: '角色小剧场', content: 'stage();\nstage2();\n', enabled: false },
  ]);
  await store.setScripts('preset', 'p1', [{ id: 'p1s', name: '预设脚本', content: 'p();', enabled: false }]);
  const appSettings = { scriptEnabled: false, ...settings };
  const settingUpdates = [];
  const events = [];
  const tools = createScriptEditAgentTools({
    scriptStore: store,
    presetStore: { getActiveId: type => (type === 'openai' ? presetId : ''), listSummaries: () => [{ id: 'p1', name: '写作预设' }] },
    getCurrentPersonaId: () => personaId,
    getPersonaName: id => (id === 'card1' ? '苏晓彤' : ''),
    getScriptSettings: () => ({ ...appSettings }),
    updateScriptSettings: (patch) => { settingUpdates.push(patch); Object.assign(appSettings, patch); },
    onScriptsChanged: () => events.push('scripts-changed'),
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const requests = [];
  const run = (name, args, { allow = true, onConfirm = null, signal = null, runId = '', confirm = null } = {}) => registry.executeTool(name, args, {
    sessionId: 'sess_1',
    signal,
    runId,
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: async (request, options) => {
      requests.push(request);
      if (confirm) return confirm(request, options);
      return onConfirm ? onConfirm(request) : { decision: allow ? 'allow' : 'deny' };
    },
  });
  const script = (scope, scopeId, id) => store.getScripts(scope, scopeId).find(item => item.id === id);
  const byName = (scope, scopeId, name) => store.getScripts(scope, scopeId).find(item => item.name === name);
  return { store, appSettings, settingUpdates, events, run, requests, script, byName, tools };
};

test('script.read returns code from an offset with nextOffset; duplicate names return candidates', async () => {
  const env = await setup();
  const read = (await env.run('script.read', { script: 'g1' })).result;
  assert.equal(read.ok, true);
  assert.deepEqual([read.name, read.scope, read.scopeLabel, read.enabled, read.blocked], ['好感度面板', 'global', '全局', true, false]);
  assert.equal(read.content, env.script('global', '', 'g1').content);
  assert.equal(read.nextOffset, null);

  const first = (await env.run('script.read', { script: '长脚本' })).result;
  assert.deepEqual([first.length, first.content.length, first.nextOffset], [45000, 20000, 20000]);
  const last = (await env.run('script.read', { script: 'g4', offset: 40000 })).result;
  assert.deepEqual([last.content.length, last.nextOffset], [5000, null]);

  const ambiguous = (await env.run('script.read', { script: '同名脚本' })).result;
  assert.equal(ambiguous.reason, 'ambiguous_target');
  assert.deepEqual(ambiguous.candidates.map(item => item.scopeLabel).sort(), ['全局', '角色卡：苏晓彤']);
  const narrowed = (await env.run('script.read', { script: '同名脚本', scope: 'character' })).result;
  assert.equal(narrowed.id, 'c1');

  const blocked = (await env.run('script.read', { script: '外部扩展' })).result;
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.blockReason);
  assert.equal((await env.run('script.read', { script: '不存在' })).result.reason, 'not_found');
  assert.equal(env.requests.length, 0, 'reading never asks for confirmation');
});

test('script.upsert creates disabled scripts in the resolved scopes with one confirmation', async () => {
  const env = await setup();
  const output = await env.run('script.upsert', { items: [
    { name: '新脚本A', scope: 'global', content: 'console.log("a");' },
    { name: '卡脚本', scope: 'character', content: 'console.log("card");', info: '角色卡用' },
    { name: '预设新脚本', scope: 'preset', content: 'console.log("preset");' },
  ] });
  assert.equal(output.result.ok, true, JSON.stringify(output.result));
  assert.equal(output.result.succeededCount, 3);
  assert.equal(env.requests.length, 1);
  const request = env.requests[0];
  assert.deepEqual([request.toolName, request.kind, request.operationType, request.danger], ['script.upsert', 'script.upsert', 'write_scripts', false]);
  assert.match(request.message, /新建的脚本保持关闭，启用要另外确认/);
  const metas = request.details.items.map(item => item.meta);
  assert.match(metas[0], /^新建 · 全局 · 17 字（建立后保持关闭）$/);
  assert.match(metas[1], /角色卡：苏晓彤/);
  assert.match(metas[2], /预设：写作预设/);

  const card = env.byName('character', 'card1', '卡脚本');
  assert.deepEqual([card.enabled, card.authorized, card.source, card.info], [false, false, 'maid', '角色卡用']);
  assert.equal(env.byName('global', '', '新脚本A').enabled, false);
  assert.equal(env.byName('preset', 'p1', '预设新脚本').content, 'console.log("preset");');
  assert.ok(output.result.results.every(item => item.enabled === false && item.id));
  assert.deepEqual(env.events, ['scripts-changed'], 'one reload for the whole batch');
});

test('a name already used in that scope fails the item; missing card or preset fails before the confirmation', async () => {
  const env = await setup();
  const output = await env.run('script.upsert', { items: [
    { name: '状态栏', scope: 'global', content: 'dup();' },
    { name: '新的', scope: 'global', content: 'one();' },
    { name: ' 新 的 ', scope: 'global', content: 'two();' },
    { name: '状态栏', scope: 'character', content: 'other_scope();' },
  ] });
  assert.deepEqual(output.result.results.map(item => [item.status, item.reason || '']), [
    ['failed', 'name_exists'], ['succeeded', ''], ['failed', 'name_exists'], ['succeeded', ''],
  ]);
  assert.equal(env.store.getScripts('global', '').filter(item => item.name === '状态栏').length, 1);
  assert.ok(env.byName('character', 'card1', '状态栏'));

  const none = await setup({ personaId: '', presetId: '' });
  const missing = await none.run('script.upsert', { items: [
    { name: 'x', scope: 'character', content: 'x();' },
    { name: 'y', scope: 'preset', content: 'y();' },
    { name: 'z', content: 'z();' },
  ] });
  assert.deepEqual(missing.result.results.map(item => item.reason), ['no_current_character', 'no_active_preset', 'missing_scope']);
  assert.equal(none.requests.length, 0);
  assert.deepEqual(none.events, []);
});

test('edits replace exact fragments; a missing, repeated or overlapping find fails the whole item', async () => {
  assert.deepEqual(applyScriptEdits('abcabc', [{ find: 'abc', replace: 'x' }]), { error: 'find_not_unique', editIndex: 0 });
  assert.deepEqual(applyScriptEdits('abcdef', [{ find: 'abcd', replace: '' }, { find: 'cde', replace: '' }]), { error: 'edits_overlap', editIndex: 1 });
  assert.deepEqual(applyScriptEdits('abcdef', [{ find: 'ef', replace: 'EF' }, { find: 'ab', replace: 'AB' }]), { content: 'ABcdEF' });

  const env = await setup();
  const beforeG1 = env.script('global', '', 'g1').content;
  const beforeC2 = env.script('character', 'card1', 'c2').content;
  const output = await env.run('script.upsert', { items: [
    { script: 'g2', edits: [{ find: 'let x = 1;', replace: 'let x = 25;' }] },
    { script: 'g1', edits: [{ find: 'console.log', replace: 'console.info' }] },
    { script: '角色小剧场', edits: [{ find: 'stage();', replace: 'act();' }, { find: '不存在的片段', replace: 'x' }] },
  ] });
  assert.deepEqual(output.result.results.map(item => [item.status, item.reason || '']), [
    ['succeeded', ''], ['failed', 'find_not_unique'], ['failed', 'find_not_found'],
  ]);
  assert.equal(output.result.results[2].editIndex, 1);
  assert.equal(env.script('global', '', 'g2').content, 'let x = 25;\nlet x2 = 1;\n');
  assert.equal(env.script('global', '', 'g1').content, beforeG1);
  assert.equal(env.script('character', 'card1', 'c2').content, beforeC2, 'the first edit of a failed item is not written either');
  assert.match(env.requests[0].details.items[0].meta, /^修改 · 全局 · 代码 23 ⇒ 24 字（1 处替换）$/);

  const whole = await env.run('script.upsert', { items: [{ script: 'g2', name: '状态栏2', content: 'let y = 1;' }] });
  assert.equal(whole.result.succeededCount, 1);
  assert.match(env.requests.at(-1).details.items[0].meta, /名称 状态栏 ⇒ 状态栏2、代码 24 ⇒ 10 字$/);
  assert.deepEqual([env.script('global', '', 'g2').name, env.script('global', '', 'g2').content], ['状态栏2', 'let y = 1;']);

  const both = await env.run('script.upsert', { items: [{ script: 'g2', content: 'a', edits: [{ find: 'let', replace: 'const' }] }] });
  assert.equal(both.result.results[0].reason, 'content_and_edits');
});

test('an edit that changes nothing is skipped without a confirmation', async () => {
  const env = await setup();
  const output = await env.run('script.upsert', { items: [
    { script: 'g2', name: '状态栏', info: '显示状态' },
    { script: 'g2', content: 'again' },
  ] });
  assert.deepEqual(output.result.results.map(item => [item.status, item.reason]), [['skipped', 'no_change'], ['failed', 'duplicate_target']]);
  assert.equal(env.requests.length, 0);
  assert.deepEqual(env.events, []);
  assert.equal(env.script('global', '', 'g2').content, 'let x = 1;\nlet x2 = 1;\n');
});

test('editing the code of an enabled script is a dangerous card that says the new code runs after reload', async () => {
  const env = await setup({ settings: { scriptEnabled: true } });
  const output = await env.run('script.upsert', { items: [{ script: '好感度面板', content: 'console.log("new");' }] });
  assert.equal(output.result.ok, true, JSON.stringify(output.result));
  const request = env.requests.at(-1);
  assert.equal(request.danger, true);
  assert.match(request.message, /已启用的脚本，改动的代码在脚本重新载入后就会运行/);
  assert.match(request.message, /^将修改 1 个脚本。/, '只修改时不提新建');
  assert.match(request.message, /访问网络：禁用/);
  assert.match(request.details.items[0].meta, /已启用，新代码在脚本重新载入后就会运行/);
  assert.deepEqual([env.script('global', '', 'g1').enabled, env.script('global', '', 'g1').content], [true, 'console.log("new");']);

  const rename = await env.run('script.upsert', { items: [{ script: 'g1', name: '好感度面板2' }] });
  assert.equal(rename.result.succeededCount, 1);
  assert.equal(env.requests.at(-1).danger, false, 'renaming does not run new code');
});

test('compatibility blocks are called out: new scripts stay off and an enabled script is turned off', async () => {
  assert.equal(analyzeScriptCompatibility(BLOCKED_CODE).blocked, true);
  const env = await setup();
  const created = await env.run('script.upsert', { items: [{ name: '扩展式脚本', scope: 'global', content: BLOCKED_CODE }] });
  assert.match(env.requests.at(-1).details.items[0].meta, /新代码会被兼容性检查拦截，之后无法启用/);
  assert.equal(created.result.results[0].blocked, true);
  assert.equal(env.byName('global', '', '扩展式脚本').enabled, false);

  const updated = await env.run('script.upsert', { items: [{ script: 'g1', content: BLOCKED_CODE }] });
  const request = env.requests.at(-1);
  assert.match(request.details.items[0].meta, /新代码会被兼容性检查拦截，写入后这个脚本会被关掉/);
  assert.equal(request.danger, false, 'blocked code is turned off, so it will not run');
  assert.equal(updated.result.results[0].status, 'succeeded', JSON.stringify(updated.result));
  assert.equal(updated.result.results[0].disabledByCompatibility, true);
  assert.equal(env.script('global', '', 'g1').enabled, false);
});

test('cancelling writes nothing and does not reload scripts', async () => {
  const env = await setup();
  const output = await env.run('script.upsert', { items: [
    { name: '取消的脚本', scope: 'global', content: 'x();' },
    { script: 'g2', content: 'changed();' },
  ] }, { allow: false });
  assert.deepEqual([output.result.ok, output.result.skipped, output.result.reason], [false, true, 'script_upsert_cancelled']);
  assert.equal(env.byName('global', '', '取消的脚本'), undefined);
  assert.equal(env.script('global', '', 'g2').content, 'let x = 1;\nlet x2 = 1;\n');
  assert.deepEqual(env.events, []);
});

test('scripts changed or removed while the confirmation is open are not overwritten', async () => {
  const env = await setup();
  const changed = await env.run('script.upsert', { items: [{ script: 'g2', content: 'mine();' }] }, {
    onConfirm: async () => { await env.store.updateScript('global', '', 'g2', { content: 'theirs();' }); return { decision: 'allow' }; },
  });
  assert.equal(changed.result.results[0].reason, 'target_changed_during_confirmation');
  assert.equal(env.script('global', '', 'g2').content, 'theirs();');

  const toggled = await env.run('script.upsert', { items: [{ script: 'g2', info: '新说明' }] }, {
    onConfirm: async () => { await env.store.toggleScript('global', '', 'g2', true); return { decision: 'allow' }; },
  });
  assert.equal(toggled.result.results[0].reason, 'target_changed_during_confirmation', 'enabling it elsewhere counts as a change');

  const removed = await env.run('script.upsert', { items: [{ script: 'c2', content: 'gone();' }] }, {
    onConfirm: async () => { await env.store.deleteScript('character', 'card1', 'c2'); return { decision: 'allow' }; },
  });
  assert.equal(removed.result.results[0].reason, 'target_removed_during_confirmation');

  const raced = await env.run('script.upsert', { items: [{ name: '抢先', scope: 'global', content: 'x();' }] }, {
    onConfirm: async () => { await env.store.upsertScript('global', '', { name: '抢先', content: 'first();' }); return { decision: 'allow' }; },
  });
  assert.equal(raced.result.results[0].reason, 'name_exists');
  assert.equal(env.store.getScripts('global', '').filter(item => item.name === '抢先').length, 1);
  assert.deepEqual(env.events, [], 'nothing succeeded, so nothing reloads');
});

test('read-back catches a store that did not keep the write; an abort stops the rest of the batch', async () => {
  const env = await setup();
  env.store.updateScript = async () => true;
  const lost = await env.run('script.upsert', { items: [{ script: 'g2', content: 'lost();' }] });
  assert.equal(lost.result.results[0].reason, 'verification_failed');

  const aborting = await setup();
  const controller = new AbortController();
  const upsert = aborting.store.upsertScript.bind(aborting.store);
  aborting.store.upsertScript = async (...args) => { const id = await upsert(...args); controller.abort(); return id; };
  const output = await aborting.run('script.upsert', { items: [
    { name: '第一个', scope: 'global', content: 'one();' },
    { name: '第二个', scope: 'global', content: 'two();' },
  ] }, { signal: controller.signal });
  assert.deepEqual(output.result.results.map(item => item.status), ['succeeded', 'cancelled']);
  assert.equal(output.result.cancelled, true);
  assert.equal(aborting.byName('global', '', '第二个'), undefined);
  assert.deepEqual(aborting.events, ['scripts-changed'], 'the script that was written still reloads');
});

test('script.settings.update shows before ⇒ after; turning something on is dangerous and says what scripts can do', async () => {
  const env = await setup();
  const output = await env.run('script.settings.update', { scriptsEnabled: true, allowNetwork: true, allowModifyVariables: true });
  assert.equal(output.result.ok, true, JSON.stringify(output.result));
  const request = env.requests.at(-1);
  assert.deepEqual([request.kind, request.operationType, request.danger], ['script.settings.update', 'write_script_settings', true]);
  assert.match(request.message, /将修改 2 项脚本设定/);
  assert.match(request.message, /访问网络：允许/);
  assert.match(request.message, /全局脚本开关开启时，已启用的脚本会立即运行/);
  assert.deepEqual(request.details.items.map(item => [item.label, item.meta]), [['全局脚本开关', '关闭 ⇒ 开启'], ['访问网络', '禁用 ⇒ 允许']]);
  assert.deepEqual(env.settingUpdates, [{ scriptEnabled: true, scriptAllowNetwork: true }], 'only the changed keys are written, in one save');
  assert.deepEqual([output.result.scriptsRunGlobally, output.result.permissions.includes('访问网络：允许')], [true, true]);

  const off = await env.run('script.settings.update', { allowReadMessages: false });
  assert.equal(env.requests.at(-1).danger, false, 'turning permissions off is an ordinary write');
  assert.equal(env.requests.at(-1).details.items[0].meta, '允许 ⇒ 禁用');
  assert.equal(off.result.ok, true);
  assert.equal(env.appSettings.scriptAllowReadMessages, false);

  const before = env.requests.length;
  const same = await env.run('script.settings.update', { scriptsEnabled: true });
  assert.deepEqual([same.result.ok, same.result.skipped, same.result.reason], [true, true, 'no_change']);
  assert.equal(env.requests.length, before, 'no change, no confirmation');
  await assert.rejects(env.run('script.settings.update', { scriptEnabled: true }), /not allowed/);
});

test('script settings changed during the confirmation or cancelled are not written', async () => {
  const env = await setup();
  const raced = await env.run('script.settings.update', { allowNetwork: true }, {
    onConfirm: async () => { env.appSettings.scriptAllowNetwork = true; return { decision: 'allow' }; },
  });
  assert.equal(raced.result.reason, 'target_changed_during_confirmation');
  assert.deepEqual(env.settingUpdates, []);
  const cancelled = await env.run('script.settings.update', { scriptsEnabled: true }, { allow: false });
  assert.deepEqual([cancelled.result.ok, cancelled.result.reason], [false, 'script_settings_update_cancelled']);
  assert.equal(env.appSettings.scriptEnabled, false);
});

test('confirmations keep a fixed kind and operation type and offer the same remember choices as other writes', async () => {
  const env = await setup();
  await env.run('script.upsert', { items: [{ name: '甲', scope: 'global', content: 'a();' }] });
  await env.run('script.upsert', { items: [{ script: 'g1', content: 'b();' }] });
  await env.run('script.upsert', { items: [{ script: 'g2', name: '改名' }] });
  await env.run('script.settings.update', { allowNetwork: true });
  await env.run('script.settings.update', { allowNetwork: false });
  assert.deepEqual(env.requests.map(request => [request.toolName, request.kind, request.operationType]), [
    ['script.upsert', 'script.upsert', 'write_scripts'],
    ['script.upsert', 'script.upsert', 'write_scripts'],
    ['script.upsert', 'script.upsert', 'write_scripts'],
    ['script.settings.update', 'script.settings.update', 'write_script_settings'],
    ['script.settings.update', 'script.settings.update', 'write_script_settings'],
  ]);
  assert.ok(env.requests.every(request => request.allowRemember === undefined && request.allowScope === ''));

  // 经真实的确认运行时：给「这个任务／这个角色卡一律允许」，选了任务之后同一种写入不再询问
  const confirmations = createMaidToolConfirmationRuntime({ canShowInline: () => true });
  const live = await setup();
  const confirm = (request, options) => confirmations.request(request, { ...options, roleCardId: 'card1' });
  const pending = live.run('script.upsert', { items: [{ script: 'g1', content: 'c();' }] }, { runId: 'run-1', confirm });
  await new Promise(resolve => setTimeout(resolve, 0));
  const inline = confirmations.getInline('run-1');
  assert.deepEqual([inline.allowTask, inline.allowRoleCard, inline.confirmLabel], [true, true, '允许一次']);
  confirmations.resolve(inline.id, 'allow_task');
  assert.equal((await pending).result.succeededCount, 1);
  const again = await live.run('script.upsert', { items: [{ script: 'g1', content: 'd();' }] }, { runId: 'run-2', confirm });
  assert.equal(again.result.succeededCount, 1, 'remembered for this task');
  assert.equal(confirmations.getInline('run-2'), null);

  const settingsPending = live.run('script.settings.update', { allowNetwork: true }, { runId: 'run-3', confirm });
  await new Promise(resolve => setTimeout(resolve, 0));
  const settingsInline = confirmations.getInline('run-3');
  assert.deepEqual([settingsInline.allowTask, settingsInline.allowRoleCard], [true, true]);
  confirmations.resolve(settingsInline.id, 'allow_once');
  assert.equal((await settingsPending).result.ok, true);
});

test('with the app\'s ask-by-default permissions the script tools reach their own confirmation', async () => {
  const evaluator = createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.ask });
  for (const tool of createScriptEditAgentTools({})) {
    assert.notEqual(evaluator.evaluateTool(tool)?.decision, AGENT_PERMISSION_DECISIONS.ask, `${tool.name} would be stopped before its confirmation`);
  }
  const toggle = createPresetRegexScriptAgentTools({}).find(tool => tool.name === 'script.toggle_many');
  assert.doesNotMatch(toggle.description, /always allow/i);
});

test('the maid finds the script read, write and settings tools', () => {
  const features = listAppFeatures();
  const top = query => searchMaidCapabilityConcepts(query, { features, limit: 4 }).map(item => item.id);
  assert.ok(top('帮我写个脚本，每次回复后在控制台打印字数').includes('script.upsert'));
  assert.ok(top('把好感度面板脚本代码里的颜色改成红色').includes('script.upsert'));
  assert.ok(top('好感度面板脚本改个名字').includes('script.upsert'));
  assert.ok(top('看看好感度面板脚本的代码').includes('script.read'));
  assert.ok(top('把脚本联网权限打开').includes('script.settings.update'));
  assert.ok(top('打开全局脚本开关').includes('script.settings.update'));
  assert.ok(top('允许脚本修改变量').includes('script.settings.update'));
  assert.ok(top('关掉好感度面板脚本').includes('script.toggle_many'), 'turning one script off stays a toggle');
  assert.ok(top('把好感度面板脚本改成关闭').includes('script.toggle_many'));
  assert.ok(!top('把好感度面板脚本改成关闭').includes('script.upsert'));
  assert.equal(searchAppFeatures('写个脚本', { limit: 3 })[0]?.id, 'script.upsert');
  assert.equal(searchAppFeatures('脚本联网权限', { limit: 3 })[0]?.id, 'script.settings.update');

  // 女仆默认只给模型看有界候选：新工具要进得了候选
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) }, logger: { warn() {} } });
  new Set(features.flatMap(feature => feature.tools || [])).forEach(name => registry.register({ name, schema: { type: 'object', properties: {} }, riskLevel: 'low', execute: async () => ({ ok: true }) }));
  const runtime = createMaidCapabilityRoutingRuntime({
    features, toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  for (const [input, id] of [
    ['帮我写一个脚本，进聊天时显示今天日期', 'script.upsert'],
    ['把状态栏脚本里的 let x 改成 const x', 'script.upsert'],
    ['看看状态栏这个脚本的代码写了什么', 'script.read'],
    ['允许脚本访问网络', 'script.settings.update'],
    ['把脚本总开关关掉', 'script.settings.update'],
  ]) {
    const request = runtime.beginRequest({ input });
    const snapshot = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner', configOverride: { mode: 'bounded' } });
    assert.equal(snapshot.candidateIds.has(id), true, `${input} → 候选应包含 ${id}（实际：${[...snapshot.candidateIds].join(', ')}）`);
    runtime.finishRequest(request.id, { ok: true });
  }
});
