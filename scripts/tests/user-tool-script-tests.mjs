import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { buildLinePatches, createToolResultEffects, createScriptToolExecutor, scriptCapabilityPermissions, pluginCapabilities, isScriptApproved } = await import('../../src/scripts/ui/tools/user-tool-script.js');
const { applyValidatedFormatLinePatches } = await import('../../src/scripts/ui/chat/format-patch-transaction-utils.js');
const { UserToolStore } = await import('../../src/scripts/storage/user-tool-store.js');

{
  // 逐行补丁：套回去要正好得到新文字；空原文或太大时改用简单确认
  for (const [original, candidate] of [['a\nb\nc', 'a\nB\nc'], ['a\nb\nc', 'x\na\nb\nc'], ['a\nb\nc', 'a\nb\nc\nd'], ['a\nb\nc', 'a\nc'], ['1\n2\n3\n4\n5', '1\nX\n3\nY\n5'], ['a\r\nb', 'a\r\nc']]) {
    const built = buildLinePatches(original, candidate);
    assert.equal(built.ok, true, JSON.stringify([original, candidate]));
    assert.equal(applyValidatedFormatLinePatches(original, built.linePatches).candidateText, candidate);
  }
  assert.equal(buildLinePatches('', 'x').ok, false);
  // 50 行里隔行改＝25 处，超过 20 处上限
  assert.equal(buildLinePatches(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 50 }, (_, i) => (i % 2 ? `x${i}` : `l${i}`)).join('\n')).ok, false, 'more than 20 hunks falls back');
  console.log('ok - line patches rebuild the candidate exactly or fall back');
}

{
  assert.deepEqual(scriptCapabilityPermissions(['read', 'input', 'edit', 'model']), ['chat.read', 'input.write', 'model.call', 'network']);
  assert.deepEqual(pluginCapabilities(['chat.read', 'chat.write', 'network']), ['read', 'edit']);
  assert.equal(isScriptApproved({ capabilities: ['read'], approved: ['read'] }), true);
  assert.equal(isScriptApproved({ capabilities: ['read', 'model'], approved: ['read'] }), false);
  console.log('ok - script capabilities map to plugin permissions and need approval');
}

const makeEffects = (overrides = {}) => {
  const log = [];
  const holder = {};
  const effects = createToolResultEffects({
    getRaw: async message => message.raw,
    review: async ({ originalText, linePatches }) => { log.push(['review', originalText, linePatches.length]); return overrides.review ?? { confirmed: true, changed: true, candidateText: 'reviewed text' }; },
    confirmText: async ({ text }) => { log.push(['confirm', text]); return overrides.confirm ?? true; },
    commitEdit: async (message, text, original) => { log.push(['commit', text, original]); return true; },
    insertInput: text => log.push(['input', text]),
    sendInput: () => log.push(['send']),
    copyText: async text => { log.push(['copy', text]); return true; },
    notify: text => log.push(['notify', text]),
    offerUndo: async ({ label, undo }) => { log.push(['undo-offer', label]); holder.undo = undo; },
    isGenerating: () => overrides.generating === true,
  });
  return { effects, log, holder };
};
const message = { id: 'a1', role: 'assistant', raw: 'line one\nline two' };

{
  // 能力不够就整个不做；够就照结果套用
  const { effects, log } = makeEffects();
  assert.equal((await effects({ result: { input: 'x' }, capabilities: [] })).message, '要写输入框或发送，但没有声明「写输入框／发送」');
  assert.equal((await effects({ result: { replace: 'x' }, message, capabilities: ['input'] })).message, '要改这条消息，但没有声明「改这条消息」');
  assert.deepEqual(log, []);
  assert.equal((await effects({ result: { input: 'hi', send: true, copy: 'c', notify: ' done ' }, capabilities: ['input'] })).status, 'succeeded');
  assert.deepEqual(log, [['input', 'hi'], ['send'], ['copy', 'c'], ['notify', 'done']]);
  assert.equal((await effects({ result: 'plain string', capabilities: [] })).status, 'succeeded');
  assert.deepEqual(log.at(-1), ['notify', 'plain string'], 'a string result is a notification');
  assert.deepEqual(await effects({ result: { status: 'failed', message: 'nope' } }), { status: 'failed', message: 'nope' });
  console.log('ok - results apply only with the declared capabilities');
}

{
  // 改消息：审阅（红绿）→ 写回审阅后的文字；直接执行 → 写回并提供撤销；补丁做不出来时用简单确认
  const reviewed = makeEffects();
  await reviewed.effects({ result: { replace: 'line one\nline 2' }, message, capabilities: ['edit'], tool: { name: 'T' } });
  assert.deepEqual(reviewed.log, [['review', 'line one\nline two', 1], ['commit', 'reviewed text', 'line one\nline two']]);
  const declined = makeEffects({ review: { confirmed: false } });
  assert.equal((await declined.effects({ result: { replace: 'line one\nline 2' }, message, capabilities: ['edit'] })).status, 'cancelled');
  assert.equal(declined.log.some(entry => entry[0] === 'commit'), false);
  const direct = makeEffects();
  await direct.effects({ result: { replace: 'new' }, message, capabilities: ['edit'], direct: true });
  assert.deepEqual(direct.log, [['commit', 'new', 'line one\nline two'], ['undo-offer', '已修改这条消息']]);
  await direct.holder.undo();
  assert.deepEqual(direct.log.at(-1), ['commit', 'line one\nline two', 'new'], 'undo writes the original back');
  const plain = makeEffects();
  await plain.effects({ result: { replace: 'x' }, message: { id: 'a2', role: 'assistant', raw: '' }, capabilities: ['edit'] });
  assert.deepEqual(plain.log.map(entry => entry[0]), ['confirm', 'commit'], 'an empty original falls back to a simple confirm');
  const same = makeEffects();
  assert.equal((await same.effects({ result: { replace: 'line one\nline two' }, message, capabilities: ['edit'] })).message, '内容没有变化');
  const busy = makeEffects({ generating: true });
  assert.equal((await busy.effects({ result: { replace: 'x' }, message, capabilities: ['edit'] })).status, 'unavailable');
  console.log('ok - message edits go through review, or write directly with undo');
}

{
  // 执行器：没确认的脚本不跑；跑的时候权限＝声明的能力；插件动作走插件权限
  const calls = [];
  const runtime = {
    runEphemeral: async (options) => { calls.push(['script', options.permissions, options.ctx.marker]); return { status: 'succeeded', result: { notify: 'hi' } }; },
    runAction: async (pluginId, actionId, ctx) => { calls.push(['plugin', pluginId, actionId, ctx.message]); return { input: 'from plugin' }; },
  };
  const applied = [];
  const run = createScriptToolExecutor({
    pluginRuntime: runtime,
    buildContext: async ({ capabilities }) => ({ marker: capabilities.join('+') }),
    applyEffects: async (payload) => { applied.push([payload.result, payload.capabilities, payload.direct]); return { status: 'succeeded' }; },
    getPluginPermissions: () => ['chat.read', 'input.write'],
  });
  const script = { source: 'script', id: 'inline' };
  const unapproved = await run(script, { tool: { id: 't1', name: 'T', script: { code: 'return 1', capabilities: ['model'], approved: [] } } });
  assert.equal(unapproved.status, 'unavailable');
  assert.deepEqual(calls, []);
  await run(script, { tool: { id: 't1', name: 'T', direct: true, script: { code: 'return 1', capabilities: ['read', 'model'], approved: ['read', 'model'] } } });
  assert.deepEqual(calls[0], ['script', ['chat.read', 'model.call', 'network'], 'read+model']);
  assert.deepEqual(applied[0], [{ notify: 'hi' }, ['read', 'model'], true]);
  await run({ source: 'plugin', id: 'my.plugin:shout' }, { tool: { id: 't2', name: 'P' }, message: { id: 'a1', role: 'assistant', content: 'secret' }, trigger: 'gesture' });
  assert.deepEqual(calls[1], ['plugin', 'my.plugin', 'shout', { id: 'a1', role: 'assistant' }], 'plugins get the message identity, not its text');
  assert.deepEqual(applied[1], [{ input: 'from plugin' }, ['read', 'input'], false]);
  assert.equal((await createScriptToolExecutor({})(script, { tool: { script: {} } })).status, 'unavailable');
  console.log('ok - scripts run only once approved and plugins act with their own permissions');
}

{
  // 存储：脚本只在 script 来源保留；能力清单过滤未知值
  let saved = null;
  const store = new UserToolStore({ loadKv: async () => saved, saveKv: async (key, value) => { saved = JSON.parse(JSON.stringify(value)); } });
  await store.load();
  const tool = await store.saveTool({ name: 'S', action: { source: 'script', id: 'inline', params: {} }, script: { code: 'return 1', capabilities: ['read', 'evil'], approved: ['read'] } });
  assert.deepEqual(tool.script, { code: 'return 1', capabilities: ['read'], approved: ['read'] });
  const plain = await store.saveTool({ name: 'B', action: { source: 'builtin', id: 'reply.regenerate', params: {} }, script: { code: 'x' } });
  assert.equal('script' in plain, false);
  const plugin = await store.saveTool({ name: 'P', action: { source: 'plugin', id: 'my.plugin:shout', params: {} } });
  assert.equal(plugin.action.source, 'plugin');
  console.log('ok - the store keeps scripts only for script tools');
}

console.log('user-tool-script-tests passed');
