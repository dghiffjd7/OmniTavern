import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolveObjectURL } from 'node:buffer';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

// 用 vm 跑真正的插件 Worker 启动脚本：worker 里的 self／postMessage／addEventListener 对应到这里
class FakeWorker {
  constructor(url) {
    this.onmessage = null;
    this.onerror = null;
    this.workerListeners = [];
    this.terminated = false;
    const blob = resolveObjectURL(url);
    const sandbox = {
      console, Promise, JSON, Math, Date, Error, Map, Set, Array, Object, String, Number, Boolean, Symbol, RegExp, Function,
      setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
      postMessage: (data) => { if (!this.terminated) setTimeout(() => this.onmessage?.({ data: JSON.parse(JSON.stringify(data)) }), 0); },
      addEventListener: (type, fn) => { if (type === 'message') this.workerListeners.push(fn); },
    };
    sandbox.self = sandbox;
    this.ready = blob.text().then((code) => { vm.createContext(sandbox); vm.runInContext(code, sandbox); });
  }
  postMessage(data) {
    const copy = JSON.parse(JSON.stringify(data));
    this.ready.then(() => setTimeout(() => { if (!this.terminated) this.workerListeners.forEach(fn => fn({ data: copy })); }, 0));
  }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;

const { PluginRuntime } = await import('../../src/scripts/plugins/plugin-runtime.js');
const { ALLOWED_PERMISSIONS } = await import('../../src/scripts/plugins/plugin-permissions.js');

const makeStore = (records) => ({
  ready: Promise.resolve(),
  list: () => records.map(record => ({ id: record.id, enabled: true })),
  get: id => records.find(record => record.id === id) || null,
  isBlocked: () => false,
  isPowerApproved: () => true,
  isPermissionsApproved: () => true,
  setEnabled: async () => {},
  resetFailures: async () => {},
  recordFailure: async () => ({}),
});

const plugin = {
  id: 'shout-plugin',
  manifest: {
    id: 'shout-plugin', name: '大声', version: '1.0.0', apiVersion: '1', main: 'index.js', mode: 'safe',
    permissions: ['chat.read', 'input.write'],
    actions: [{ id: 'shout', title: '大声说', description: '把这条变大写放进输入框', target: 'assistant' }, { id: 'bad id!', title: 'x' }],
  },
  code: `module.exports = async (api) => {
    api.events.on('tool.action.shout', async ({ ctx }) => {
      await api.tool.setInput(String(ctx.message.content).toUpperCase());
      return { status: 'succeeded', message: '已放进输入框' };
    });
    api.events.on('tool.action.model', async () => { await api.tool.generate('hi'); return { status: 'succeeded' }; });
  };`,
};

{
  assert.equal(ALLOWED_PERMISSIONS.has('input.write'), true);
  assert.equal(ALLOWED_PERMISSIONS.has('model.call'), true);
  const calls = [];
  const runtime = new PluginRuntime(makeStore([plugin]));
  runtime.setToolBridge({
    'tool.input.set': async (params, meta) => { calls.push(['set', params.text, meta.pluginId]); return true; },
    'tool.model.generate': async () => 'never',
    'tool.notify': async (params) => { calls.push(['notify', params.text]); return true; },
    'tool.input.get': async () => 'draft',
  });
  await runtime.init();
  assert.equal(runtime.isRunning('shout-plugin'), true);
  assert.deepEqual(runtime.listActions(), [{ pluginId: 'shout-plugin', pluginName: '大声', id: 'shout', title: '大声说', description: '把这条变大写放进输入框', target: 'assistant' }], 'malformed action ids are skipped');
  const ok = await runtime.runAction('shout-plugin', 'shout', { message: { content: 'hello' } });
  assert.deepEqual(ok, { status: 'succeeded', message: '已放进输入框' });
  assert.deepEqual(calls, [['set', 'HELLO', 'shout-plugin']]);
  assert.equal((await runtime.runAction('shout-plugin', 'missing', {})).message, '插件没有处理这个动作');
  const denied = await runtime.runAction('shout-plugin', 'model', {});
  assert.deepEqual([denied.status, denied.message], ['failed', '权限不足: model.call'], 'errors inside the handler are reported');
  assert.equal((await runtime.runAction('ghost', 'shout', {})).message, '插件没有在运行');
  await runtime.disablePlugin('shout-plugin');
  console.log('ok - plugins declare actions in the manifest and run them through tool.* with their permissions');
}

{
  // 工具脚本：一次性 Worker，权限＝声明的能力；结果、抛错、语法错误都回报
  const calls = [];
  const runtime = new PluginRuntime(makeStore([]));
  runtime.setToolBridge({
    'tool.notify': async (params) => { calls.push(['notify', params.text]); return true; },
    'tool.input.insert': async (params) => { calls.push(['insert', params.text]); return true; },
    'tool.model.generate': async (params) => `reply to ${params.prompt}`,
  });
  const ok = await runtime.runEphemeral({
    id: 'tool-script:t1', permissions: ['input.write', 'model.call'],
    code: `const reply = await api.tool.generate({ prompt: ctx.text });
await api.tool.insertInput(reply);
await api.tool.notify('done');
return { input: reply };`,
    ctx: { text: 'ping' },
  });
  assert.deepEqual(ok, { status: 'succeeded', result: { input: 'reply to ping' } });
  assert.deepEqual(calls, [['insert', 'reply to ping'], ['notify', 'done']]);
  const denied = await runtime.runEphemeral({ id: 'tool-script:t2', permissions: [], code: `await api.tool.generate('x');`, ctx: {} });
  assert.deepEqual([denied.status, /model\.call/.test(denied.message)], ['failed', true], 'undeclared capabilities are refused');
  const thrown = await runtime.runEphemeral({ id: 'tool-script:t3', permissions: [], code: `throw new Error('boom');`, ctx: {} });
  assert.deepEqual(thrown, { status: 'failed', message: 'boom' });
  const syntax = await runtime.runEphemeral({ id: 'tool-script:t4', permissions: [], code: `return (`, ctx: {} });
  assert.equal(syntax.status, 'failed');
  const plain = await runtime.runEphemeral({ id: 'tool-script:t5', permissions: [], code: `return 'hello ' + ctx.name;`, ctx: { name: 'A' } });
  assert.deepEqual(plain, { status: 'succeeded', result: 'hello A' });
  assert.equal(runtime.instances.size, 0, 'ephemeral workers are not kept');
  console.log('ok - tool scripts run once in their own worker with only the declared capabilities');
}

console.log('plugin-tool-actions-tests passed');
