import assert from 'node:assert/strict';
import test from 'node:test';

// plugin-store 经 logger 在载入时读 localStorage：先放一份记忆体版本，再动态载入。store 用真的（覆盖、备份、授权都走原逻辑）
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
globalThis.window ||= { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };

const { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } = await import('../../src/scripts/agent/agent-permissions.js');
const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { PluginStore } = await import('../../src/scripts/storage/plugin-store.js');
const { PluginUiManager } = await import('../../src/scripts/ui/plugin-ui-manager.js');
const { createPluginAgentTools } = await import('../../src/scripts/agent/tools/plugin-tools.js');
const { searchMaidCapabilityConcepts } = await import('../../src/scripts/agent/maid-capability-concept-retriever.js');
const { listAppFeatures, searchAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');

const manifestOf = (over = {}) => ({
  id: 'demo.plugin', name: '示范插件', version: '1.0.0', apiVersion: '1', main: 'index.js', permissions: ['chat.read'], description: '示范用插件', ...over,
});
const CODE = 'module.exports = async (api) => {};';

const freshStore = async (records = []) => {
  memory.clear();
  const store = new PluginStore();
  await store.ready;
  for (const { manifest, code = CODE, source = { type: 'zip', name: 'old.zip' } } of records) {
    await store.installPlugin({ manifest, code, source });
  }
  return store;
};

// runtime 替身：记下呼叫顺序；failing 里的插件启动后状态为 error
const makeRuntime = (log, { failing = new Set(), uiManager = null } = {}) => {
  const instances = new Map();
  return {
    instances,
    async enablePlugin(id) {
      log.push(`runtime.enable:${id}`);
      if (instances.has(id)) return;
      instances.set(id, failing.has(id) ? { status: 'error', error: 'init failed: boom' } : { status: 'running', error: null });
    },
    async disablePlugin(id) {
      log.push(`runtime.disable:${id}`);
      instances.delete(id);
      uiManager?.removePluginUi?.(id);
    },
    getStatus(id) {
      const instance = instances.get(id);
      return instance ? { status: instance.status, error: instance.error } : { status: 'stopped', error: null };
    },
  };
};

const spyStore = (store, log) => {
  for (const name of ['setPowerApproved', 'approvePermissions', 'setEnabled', 'installPlugin']) {
    const original = store[name].bind(store);
    store[name] = async (...args) => {
      log.push(`${name}:${typeof args[0] === 'object' ? args[0]?.manifest?.id : args.join(',')}`);
      return original(...args);
    };
  }
};

// 原生命令替身：read_plugin_zip 以字节内容当键查包；http_request 按网址回传字节
const zipKey = key => Array.from(Buffer.from(`zip:${key}`));
const makeInvoke = ({ packages = {}, http = {} } = {}) => {
  const calls = [];
  const invoke = async (cmd, args = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'read_plugin_zip') {
      const found = packages[Buffer.from(args.bytes).toString('utf8')];
      if (!found) throw new Error('manifest.json not found');
      return { manifestText: JSON.stringify(found.manifest), mainText: found.code ?? CODE };
    }
    if (cmd === 'http_request') {
      const hit = http[args.url];
      if (hit === 'hang') return new Promise(() => {});
      if (!hit) return { ok: false, status: 404, body: '', headers: {} };
      return { ok: true, status: 200, body: Buffer.from(`zip:${hit}`).toString('base64'), headers: {} };
    }
    if (cmd === 'http_abort_request') return null;
    throw new Error(`unexpected command ${cmd}`);
  };
  return { invoke, calls };
};
const githubFetch = async url => (url === 'https://api.github.com/repos/owner/repo'
  ? { ok: true, json: async () => ({ default_branch: 'dev' }) }
  : { ok: false, status: 404, json: async () => ({}) });

const setup = async ({ records = [], failing, packages = {}, http = {}, attachments = {}, runtime = true } = {}) => {
  const store = await freshStore(records);
  const log = [];
  spyStore(store, log);
  const uiManager = new PluginUiManager();
  const pluginRuntime = runtime ? makeRuntime(log, { failing, uiManager }) : null;
  const { invoke, calls } = makeInvoke({ packages, http });
  const imports = [];
  const attachmentRegistry = {
    ensureLoaded: async id => attachments[id] || null,
    recordImport: (id, record) => imports.push({ id, ...record }),
  };
  let changed = 0;
  const tools = createPluginAgentTools({
    pluginStore: store,
    pluginRuntime,
    getUiManager: () => uiManager,
    getAttachmentRegistry: () => attachmentRegistry,
    invoke,
    fetchImpl: githubFetch,
    onPluginsChanged: () => { changed += 1; },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const requests = [];
  const run = (name, args, { allow = true, onConfirm = null, signal } = {}) => registry.executeTool(name, args, {
    sessionId: 'contact_1',
    operationIntentPolicy: { mode: 'write_allowed' },
    signal,
    requestToolConfirmation: async (request) => {
      requests.push(request);
      return onConfirm ? onConfirm(request) : { decision: allow ? 'allow' : 'deny' };
    },
  });
  return { store, log, uiManager, pluginRuntime, calls, imports, run, requests, tools, changed: () => changed };
};

test('plugin.list reports plugins, risky permissions, runtime state and plugin UI', async () => {
  const ctx = await setup({
    records: [
      { manifest: manifestOf({ id: 'net.tool', name: '联网工具', mode: 'power', permissions: ['network', 'chat.read'] }), source: { type: 'zip', name: 'net.zip', url: 'https://example.com/net.zip' } },
      { manifest: manifestOf({ id: 'bad.one', name: '坏插件' }) },
    ],
  });
  await ctx.store.setPowerApproved('net.tool', true);
  await ctx.store.setEnabled('net.tool', true);
  await ctx.pluginRuntime.enablePlugin('net.tool');
  await ctx.store.recordFailure('bad.one', 'init timeout');
  await ctx.store.setBlocked('bad.one', true);
  ctx.uiManager.registerSidebar('net.tool', { id: 'panel', title: '联网面板' });
  ctx.uiManager.registerChatCard('net.tool', { id: 'status', position: 'before_input' });
  const listed = (await ctx.run('plugin.list', {})).result;
  assert.equal(listed.ok, true);
  assert.equal(listed.runtimeAvailable, true);
  const net = listed.plugins.find(item => item.id === 'net.tool');
  assert.equal(net.name, '联网工具');
  assert.equal(net.mode, 'power');
  assert.equal(net.powerApproved, true);
  assert.deepEqual(net.riskyPermissions, [{ permission: 'network', label: '网络访问' }]);
  assert.equal(net.permissionsApproved, false);
  assert.equal(net.enabled, true);
  assert.equal(net.runtime.status, 'running');
  assert.deepEqual(net.source, { type: 'zip', name: 'net.zip', url: 'https://example.com/net.zip' });
  const bad = listed.plugins.find(item => item.id === 'bad.one');
  assert.equal(bad.blocked, true);
  assert.equal(bad.disabledReason, '已手动拉黑');
  assert.equal(bad.failureCount, 1);
  assert.equal(bad.lastFailureReason, 'init timeout');
  assert.deepEqual(listed.ui.sidebars, [{ kind: 'sidebar', pluginId: 'net.tool', id: 'panel', title: '联网面板', pluginName: '联网工具' }]);
  assert.equal(listed.ui.cards[0].position, 'before_input');
  assert.equal(listed.ui.modal, null);

  const noRuntime = await setup({ runtime: false, records: [{ manifest: manifestOf() }] });
  const plain = (await noRuntime.run('plugin.list', {})).result;
  assert.equal(plain.runtimeAvailable, false);
  assert.match(plain.note, /不支持插件运行/);
  assert.equal(plain.plugins[0].runtime, undefined);
  const toggle = (await noRuntime.run('plugin.toggle_many', { plugins: ['demo.plugin'], enabled: true })).result;
  assert.equal(toggle.reason, 'plugin_runtime_unavailable');
  assert.equal(noRuntime.requests.length, 0);
});

test('enabling asks once for power mode and risky permissions, then grants, enables and starts in the panel order', async () => {
  const ctx = await setup({
    records: [{ manifest: manifestOf({ id: 'net.tool', name: '联网工具', mode: 'power', permissions: ['network', 'model.call', 'chat.read'] }) }],
  });
  ctx.log.length = 0;
  const result = (await ctx.run('plugin.toggle_many', { plugins: ['联网工具'], enabled: true })).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(ctx.requests.length, 1, 'one card covers both panel authorization dialogs');
  const request = ctx.requests[0];
  assert.equal(request.kind, 'plugin.enable');
  assert.equal(request.operationType, 'enable_plugins');
  assert.equal(request.danger, true);
  assert.match(request.message, /高权限/);
  assert.match(request.message, /network（网络访问）/);
  assert.match(request.message, /model\.call（调用模型（会产生费用））/);
  assert.match(request.details.items[0].meta, /高权限模式（将授权）/);
  assert.deepEqual(ctx.log, [
    'setPowerApproved:net.tool,true',
    'approvePermissions:net.tool',
    'setEnabled:net.tool,true',
    'runtime.enable:net.tool',
  ]);
  assert.equal(ctx.store.get('net.tool').enabled, true);
  assert.equal(ctx.store.isPowerApproved('net.tool'), true);
  assert.equal(ctx.store.isPermissionsApproved('net.tool'), true);
  assert.equal(result.results[0].runtimeStatus, 'running');
  assert.deepEqual(result.results[0].granted, ['power', 'network', 'model.call']);
  assert.equal(ctx.changed(), 1, 'the open plugin panel is refreshed');
});

test('a plugin that fails to start is rolled back to disabled and reported failed', async () => {
  const ctx = await setup({ records: [{ manifest: manifestOf() }], failing: new Set(['demo.plugin']) });
  ctx.log.length = 0;
  const result = (await ctx.run('plugin.toggle_many', { plugins: ['demo.plugin'], enabled: true })).result;
  assert.equal(result.ok, false);
  assert.equal(ctx.requests[0].danger, false, 'nothing new to authorize');
  const item = result.results[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.reason, 'plugin_start_failed');
  assert.equal(item.errorMessage, 'init failed: boom');
  assert.equal(item.rolledBack, true);
  assert.equal(ctx.store.get('demo.plugin').enabled, false);
  assert.deepEqual(ctx.log, ['setEnabled:demo.plugin,true', 'runtime.enable:demo.plugin', 'setEnabled:demo.plugin,false', 'runtime.disable:demo.plugin']);
});

test('blocked plugins are protected, same-state plugins skipped, and duplicate names are not guessed', async () => {
  const ctx = await setup({
    records: [
      { manifest: manifestOf({ id: 'a.one', name: '同名' }) },
      { manifest: manifestOf({ id: 'b.two', name: '同名' }) },
      { manifest: manifestOf({ id: 'c.blocked', name: '黑名单' }) },
      { manifest: manifestOf({ id: 'd.on', name: '已开' }) },
    ],
  });
  await ctx.store.setBlocked('c.blocked', true);
  await ctx.store.setEnabled('d.on', true);
  const result = (await ctx.run('plugin.toggle_many', { plugins: ['同名', '黑名单', '已开'], enabled: true })).result;
  assert.equal(ctx.requests.length, 0, 'nothing to enable, so no confirmation');
  const byTarget = Object.fromEntries(result.results.map(item => [item.target, item]));
  assert.equal(byTarget['同名'].status, 'ambiguous');
  assert.deepEqual(byTarget['同名'].candidates.map(item => item.id).sort(), ['a.one', 'b.two']);
  assert.equal(byTarget['黑名单'].status, 'protected');
  assert.equal(byTarget['黑名单'].reason, 'plugin_blocked');
  assert.equal(byTarget['已开'].reason, 'already_in_state');
  assert.equal(ctx.store.get('a.one').enabled, false);
  assert.equal(ctx.store.get('b.two').enabled, false);
});

test('disabling stops the plugin like the panel switch and removes the UI it added', async () => {
  const ctx = await setup({ records: [{ manifest: manifestOf() }] });
  await ctx.store.setEnabled('demo.plugin', true);
  await ctx.pluginRuntime.enablePlugin('demo.plugin');
  ctx.uiManager.registerSidebar('demo.plugin', { id: 'side', title: '侧边' });
  ctx.log.length = 0;
  const result = (await ctx.run('plugin.toggle_many', { plugins: ['示范插件'], enabled: false })).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  const request = ctx.requests[0];
  assert.equal(request.kind, 'plugin.disable');
  assert.equal(request.operationType, 'disable_plugins');
  assert.equal(request.danger, false);
  assert.deepEqual(ctx.log, ['setEnabled:demo.plugin,false', 'runtime.disable:demo.plugin']);
  assert.equal(ctx.store.get('demo.plugin').enabled, false);
  assert.equal(ctx.uiManager.listSidebars().length, 0);
});

test('toggling a plugin that was replaced while the confirmation was open writes nothing', async () => {
  const ctx = await setup({ records: [{ manifest: manifestOf({ permissions: ['chat.read'] }) }] });
  const result = (await ctx.run('plugin.toggle_many', { plugins: ['demo.plugin'], enabled: true }, {
    onConfirm: async () => {
      await ctx.store.installPlugin({ manifest: manifestOf({ version: '2.0.0', permissions: ['chat.read', 'network'], mode: 'power' }), code: 'changed();' });
      return { decision: 'allow' };
    },
  })).result;
  assert.equal(result.results[0].reason, 'target_changed_during_confirmation');
  assert.equal(ctx.store.get('demo.plugin').enabled, false);
  assert.equal(ctx.store.isPowerApproved('demo.plugin'), false);
});

test('installing from a GitHub link resolves the default branch, shows one card and keeps the plugin disabled', async () => {
  const manifest = manifestOf({ id: 'gh.plugin', name: '仓库插件', version: '1.2.0', permissions: ['chat.read', 'ui.inject'] });
  const ctx = await setup({
    packages: { 'zip:gh': { manifest, code: 'console.log("hi");' } },
    http: { 'https://codeload.github.com/owner/repo/zip/refs/heads/dev': 'gh' },
  });
  const result = (await ctx.run('plugin.install', { url: 'https://github.com/owner/repo' })).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  const request = ctx.requests[0];
  assert.equal(request.kind, 'plugin.install');
  assert.equal(request.operationType, 'install_plugin');
  assert.equal(request.danger, false);
  assert.match(request.title, /安装插件「仓库插件」/);
  assert.match(request.message, /保持关闭/);
  const items = Object.fromEntries(request.details.items.map(item => [item.id, item]));
  assert.equal(items.plugin.meta, 'ID gh.plugin');
  assert.equal(items.version.meta, '1.2.0');
  assert.equal(items.mode.meta, 'safe');
  assert.equal(items.permissions.meta, 'chat.read, ui.inject');
  assert.equal(items['risk:ui.inject'].meta, '注入 UI');
  assert.equal(items.source.meta, 'https://codeload.github.com/owner/repo/zip/refs/heads/dev');
  assert.match(items.size.meta, /^\d+ B$/);
  assert.equal(items.overwrite, undefined);
  const record = ctx.store.get('gh.plugin');
  assert.equal(record.enabled, false, 'newly installed plugins stay disabled');
  assert.equal(record.manifest.version, '1.2.0');
  assert.equal(record.code, 'console.log("hi");');
  assert.deepEqual(record.source, { type: 'zip', name: 'dev', url: 'https://codeload.github.com/owner/repo/zip/refs/heads/dev' });
  assert.equal(result.enabled, false);
  assert.equal(result.verified, true);
  assert.equal(ctx.changed(), 1);
});

test('installing from an attachment reads the ZIP from the file library and records the import', async () => {
  const ctx = await setup({
    packages: { 'zip:att': { manifest: manifestOf({ id: 'att.plugin', name: '附件插件' }) } },
    attachments: {
      file_1: { id: 'file_1', name: 'att-plugin.zip', bytes: new Uint8Array(Buffer.from('zip:att')), inspection: { format: 'archive' } },
      file_2: { id: 'file_2', name: 'notes.txt', bytes: new Uint8Array(Buffer.from('hello')), inspection: { format: 'text' } },
    },
  });
  const result = (await ctx.run('plugin.install', { attachmentId: 'file_1' })).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(ctx.requests[0].details.items.find(item => item.id === 'source').meta, '附件：att-plugin.zip');
  assert.ok(Array.isArray(ctx.calls.find(call => call.cmd === 'read_plugin_zip').args.bytes), 'bytes go to the native command as an array, like the panel');
  assert.deepEqual(ctx.store.get('att.plugin').source, { type: 'zip', name: 'att-plugin.zip' });
  assert.deepEqual(ctx.imports, [{ id: 'file_1', target: 'plugin:att.plugin' }]);

  const text = (await ctx.run('plugin.install', { attachmentId: 'file_2' })).result;
  assert.equal(text.reason, 'attachment_not_plugin_zip');
  const gone = (await ctx.run('plugin.install', { attachmentId: 'missing' })).result;
  assert.equal(gone.reason, 'attachment_not_found');
  const both = (await ctx.run('plugin.install', { attachmentId: 'file_1', url: 'https://example.com/a.zip' })).result;
  assert.equal(both.reason, 'attachment_or_url_required');
  assert.equal(ctx.requests.length, 1, 'failed preflights never reach a confirmation');
});

test('packages that fail to download or parse are reported before any confirmation', async () => {
  const ctx = await setup({
    packages: {
      'zip:st': { manifest: { display_name: 'ST Ext', js: 'index.js' } },
      'zip:bad': { manifest: manifestOf({ version: 'one', permissions: [] }) },
    },
    http: { 'https://example.com/st.zip': 'st', 'https://example.com/bad.zip': 'bad', 'https://example.com/empty.zip': 'none' },
  });
  const st = (await ctx.run('plugin.install', { url: 'https://example.com/st.zip' })).result;
  assert.equal(st.reason, 'plugin_package_invalid');
  assert.match(st.errorMessage, /SillyTavern/);
  const bad = (await ctx.run('plugin.install', { url: 'https://example.com/bad.zip' })).result;
  assert.equal(bad.reason, 'plugin_package_invalid');
  assert.match(bad.errorMessage, /manifest 校验失败：.*缺少 permissions.*version 非语义化版本/);
  const empty = (await ctx.run('plugin.install', { url: 'https://example.com/empty.zip' })).result;
  assert.match(empty.errorMessage, /manifest\.json not found/);
  const missing = (await ctx.run('plugin.install', { url: 'https://example.com/404.zip' })).result;
  assert.equal(missing.reason, 'plugin_download_failed');
  assert.match(missing.errorMessage, /下载失败 \(404\)/);
  const ftp = (await ctx.run('plugin.install', { url: 'ftp://example.com/a.zip' })).result;
  assert.equal(ftp.reason, 'invalid_url');
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.store.list().length, 0);
});

test('replacing an enabled, running plugin says the old version keeps running and keeps a backup', async () => {
  const ctx = await setup({
    records: [{ manifest: manifestOf({ version: '1.0.0', permissions: ['chat.read'] }) }],
    packages: { 'zip:v2': { manifest: manifestOf({ version: '2.0.0', permissions: ['chat.read', 'chat.write'] }), code: 'v2();' } },
    http: { 'https://example.com/v2.zip': 'v2' },
  });
  await ctx.store.setEnabled('demo.plugin', true);
  await ctx.pluginRuntime.enablePlugin('demo.plugin');
  const result = (await ctx.run('plugin.install', { url: 'https://example.com/v2.zip' })).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  const request = ctx.requests[0];
  assert.equal(request.danger, true);
  assert.match(request.title, /覆盖插件「示范插件」/);
  assert.match(request.message, /运行中的仍是旧版/);
  assert.match(request.message, /重新授权/, 'chat.write is new and needs approval before the next start');
  const overwrite = request.details.items.find(item => item.id === 'overwrite');
  assert.equal(overwrite.label, '覆盖：版本 1.0.0 ⇒ 2.0.0，旧版保留为备份');
  assert.equal(request.details.items.find(item => item.id === 'version').meta, '1.0.0 ⇒ 2.0.0');
  const record = ctx.store.get('demo.plugin');
  assert.equal(record.enabled, true, 'the store keeps the enabled state, like the panel');
  assert.equal(record.code, 'v2();');
  assert.equal(record.backups.length, 1);
  assert.equal(record.backups[0].version, '1.0.0');
  assert.equal(result.overwritten, true);
  assert.equal(result.previousVersion, '1.0.0');
  assert.equal(result.runningOldVersion, true);
  assert.equal(result.needsReapproval, true);
  assert.equal(result.backupCount, 1);
  assert.equal(ctx.log.filter(entry => entry.startsWith('runtime.')).length, 1, 'install does not restart the runtime');

  const same = (await ctx.run('plugin.install', { url: 'https://example.com/v2.zip' })).result;
  assert.equal(same.reason, 'already_installed');
  assert.equal(same.installed, false);
  assert.equal(ctx.requests.length, 1, 'an identical package needs no confirmation');
});

test('cancelling the install card writes nothing; a change during confirmation is caught', async () => {
  const ctx = await setup({
    records: [{ manifest: manifestOf({ version: '1.0.0' }) }],
    packages: { 'zip:new': { manifest: manifestOf({ id: 'new.plugin', name: '新插件' }) }, 'zip:v2': { manifest: manifestOf({ version: '2.0.0' }) } },
    http: { 'https://example.com/new.zip': 'new', 'https://example.com/v2.zip': 'v2' },
  });
  const denied = await ctx.run('plugin.install', { url: 'https://example.com/new.zip' }, { allow: false });
  assert.equal(denied.status, 'skipped');
  assert.equal(denied.result.reason, 'plugin_install_cancelled');
  assert.equal(denied.result.installed, false);
  assert.equal(ctx.store.has('new.plugin'), false);

  const raced = (await ctx.run('plugin.install', { url: 'https://example.com/new.zip' }, {
    onConfirm: async () => {
      await ctx.store.installPlugin({ manifest: manifestOf({ id: 'new.plugin', name: '新插件', version: '9.0.0' }), code: 'other();' });
      return { decision: 'allow' };
    },
  })).result;
  assert.equal(raced.reason, 'target_changed_during_confirmation');
  assert.equal(ctx.store.get('new.plugin').manifest.version, '9.0.0');

  const toggled = (await ctx.run('plugin.install', { url: 'https://example.com/v2.zip' }, {
    onConfirm: async () => { await ctx.store.setEnabled('demo.plugin', true); return { decision: 'allow' }; },
  })).result;
  assert.equal(toggled.reason, 'target_changed_during_confirmation', 'the card described a disabled plugin');
  assert.equal(ctx.store.get('demo.plugin').manifest.version, '1.0.0');
});

test('aborting during the download cancels the native request and never reaches a confirmation', async () => {
  const ctx = await setup({ http: { 'https://example.com/slow.zip': 'hang' } });
  const controller = new AbortController();
  const running = ctx.run('plugin.install', { url: 'https://example.com/slow.zip' }, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running, error => error?.name === 'AbortError');
  const request = ctx.calls.find(call => call.cmd === 'http_request');
  assert.ok(request.args.requestId, 'a cancellable native request carries a request id');
  assert.ok(ctx.calls.some(call => call.cmd === 'http_abort_request' && call.args.requestId === request.args.requestId));
  assert.ok(!ctx.calls.some(call => call.cmd === 'read_plugin_zip'));
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.store.list().length, 0);
});

test('plugin.ui.remove removes sidebars and cards and closes the dialog like the UI manager', async () => {
  const ctx = await setup({ records: [{ manifest: manifestOf() }] });
  const ui = ctx.uiManager;
  ui.registerSidebar('demo.plugin', { id: 'side', title: '侧边栏一' });
  ui.registerSidebar('demo.plugin', { id: 'keep', title: '保留' });
  ui.registerChatCard('demo.plugin', { id: 'card', position: 'after_input' });
  ui.modalPanel = { style: {} };
  ui.modalOverlay = { style: {} };
  ui.modalBody = { innerHTML: '' };
  Object.assign(ui, { activeModalKey: 'demo.plugin:dlg', activeModalPluginId: 'demo.plugin', activeModalId: 'dlg' });
  const result = (await ctx.run('plugin.ui.remove', { items: [
    { pluginId: 'demo.plugin', id: 'side', kind: 'sidebar' },
    { pluginId: 'demo.plugin', id: 'card', kind: 'card' },
    { pluginId: 'demo.plugin', id: 'dlg', kind: 'modal' },
    { pluginId: 'demo.plugin', id: 'ghost', kind: 'sidebar' },
  ] })).result;
  const request = ctx.requests[0];
  assert.equal(request.kind, 'plugin.ui.remove');
  assert.equal(request.operationType, 'remove_plugin_ui');
  assert.match(request.message, /只影响这次开着的 APP/);
  assert.equal(request.details.items[0].label, '侧边栏「侧边栏一」');
  assert.equal(request.details.items[0].meta, '示范插件（demo.plugin）');
  assert.equal(result.succeededCount, 3);
  assert.equal(result.results[3].status, 'missing');
  assert.equal(result.scope, 'current_app_session');
  assert.match(result.notice, /可能再加回来/);
  assert.deepEqual(ui.listSidebars().map(item => item.id), ['keep']);
  assert.equal(ui.listCards().length, 0);
  assert.equal(ui.getActiveModal(), null);
});

test('every confirmation keeps a fixed kind/operationType and offers the normal remember options', async () => {
  const ctx = await setup({
    records: [{ manifest: manifestOf() }],
    packages: { 'zip:x': { manifest: manifestOf({ id: 'x.plugin' }) } },
    http: { 'https://example.com/x.zip': 'x' },
  });
  await ctx.run('plugin.toggle_many', { plugins: ['demo.plugin'], enabled: true });
  await ctx.run('plugin.toggle_many', { plugins: ['demo.plugin'], enabled: false });
  await ctx.run('plugin.install', { url: 'https://example.com/x.zip' });
  ctx.uiManager.registerSidebar('demo.plugin', { id: 'side' });
  await ctx.run('plugin.ui.remove', { items: [{ pluginId: 'demo.plugin', id: 'side', kind: 'sidebar' }] });
  assert.deepEqual(ctx.requests.map(request => `${request.toolName}|${request.kind}|${request.operationType}`), [
    'plugin.toggle_many|plugin.enable|enable_plugins',
    'plugin.toggle_many|plugin.disable|disable_plugins',
    'plugin.install|plugin.install|install_plugin',
    'plugin.ui.remove|plugin.ui.remove|remove_plugin_ui',
  ]);
  for (const request of ctx.requests) {
    assert.notEqual(request.allowAlways, false, `${request.kind} must not opt out of remembered approvals`);
    assert.notEqual(request.allowRemember, false, `${request.kind} must not opt out of remembered approvals`);
  }
});

test('with the app\'s ask-by-default permissions the plugin tools reach their own confirmation', () => {
  const evaluator = createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.ask });
  for (const tool of createPluginAgentTools({})) {
    assert.notEqual(evaluator.evaluateTool(tool)?.decision, AGENT_PERMISSION_DECISIONS.ask, `${tool.name} would be stopped before its confirmation`);
  }
});

test('the maid finds the plugin tools', () => {
  const features = listAppFeatures();
  const top = query => searchMaidCapabilityConcepts(query, { features, limit: 4 }).map(item => item.id);
  assert.ok(top('装插件').includes('plugin.install'));
  assert.ok(top('这个插件链接帮我装 https://github.com/a/b').includes('plugin.install'));
  assert.ok(top('关掉插件').includes('plugin.toggle_many'));
  assert.ok(top('把翻译插件启用').includes('plugin.toggle_many'));
  assert.ok(top('插件的侧边栏').includes('plugin.ui.remove'));
  assert.ok(top('把插件弹窗关掉').includes('plugin.ui.remove'));
  assert.ok(top('装了哪些插件').includes('plugin.list'));
  assert.ok(!top('装了哪些插件').includes('plugin.install'), 'asking what is installed is a read');
  assert.ok(searchAppFeatures('装插件').some(item => item.id === 'plugin.install'));
  assert.ok(searchAppFeatures('删除', { limit: 8 }).some(item => item.id === 'worldbook.delete_many'), 'plugin entries do not crowd deletion discovery');
});
