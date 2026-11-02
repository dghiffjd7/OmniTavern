import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMcpServerPanel, describeMcpServerState, describeMcpError, splitMcpEndpoint } = await import('../../src/scripts/ui/mcp-server-panel.js');
const { McpServerStore } = await import('../../src/scripts/storage/mcp-server-store.js');
const { createMcpManager } = await import('../../src/scripts/agent/mcp/mcp-manager.js');
const { mcpOperationId } = await import('../../src/scripts/agent/tools/mcp-tools.js');
const { createMiniMcpServer } = await import('./fixtures/mini-mcp-server.mjs');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    const owner = this;
    this.classList = {
      add: (...names) => { owner.className = [...new Set([...owner.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { owner.className = owner.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => owner.className.split(' ').includes(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  dispatch(type, extra = {}) { (this.listeners.get(type) || []).forEach(handler => handler({ target: this, ...extra })); }
  focus() {}
}
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const text = node => walk(node).map(item => item.textContent).join('');
const buttonLabeled = (root, label) => walk(root).find(node => node.tagName === 'BUTTON' && text(node) === label);
const field = (root, name) => walk(root).find(node => node.dataset.field === name);
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const doc = { head: new FakeElement('head'), body: new FakeElement('body'), createElement: tag => new FakeElement(tag), getElementById: () => null };

{
  // 状态说明
  assert.deepEqual(describeMcpServerState({ enabled: false }, { status: 'connected' }).tone, 'off');
  assert.equal(describeMcpServerState({ enabled: true }, {}, { busy: true }).label, '连接中…');
  const ok = describeMcpServerState({ enabled: true }, { status: 'connected', checkedAt: new Date(2026, 9, 30, 9, 5).getTime() }, { toolCount: 2 });
  assert.deepEqual([ok.tone, ok.detail], ['ok', '2 个工具 · 检查于 09:05']);
  assert.equal(describeMcpServerState({ enabled: true }, { status: 'failed', lastErrorCode: 'mcp_auth' }).detail, '服务拒绝了授权：请检查令牌');
  assert.equal(describeMcpServerState({ enabled: true }, { status: 'unknown' }).tone, 'idle');
  assert.equal(describeMcpError('mcp_remote_error', 'MCP 服务报错：rate limited'), '服务报错：rate limited');
  assert.equal(describeMcpError('', ''), '连接失败');
  assert.deepEqual(splitMcpEndpoint('http://127.0.0.1:3917/mcp'), { origin: 'http://127.0.0.1:3917', path: '/mcp' });
  assert.deepEqual(splitMcpEndpoint('https://x.example.com/'), { origin: 'https://x.example.com', path: '' });
  console.log('ok - MCP server states and errors read plainly');
}

const setup = async ({ token = '' } = {}) => {
  let saved = null;
  const store = new McpServerStore({ loadKv: async () => saved, saveKv: async (key, value) => { saved = JSON.parse(JSON.stringify(value)); }, encryptSecret: async value => `enc(${value})` });
  await store.load();
  const server = createMiniMcpServer({ token });
  const refreshes = [];
  const manager = createMcpManager({ store, httpRequest: async request => server.handle(request), decryptSecret: async cipher => cipher.replace(/^enc\((.*)\)$/, '$1') });
  const refresh = manager.refresh;
  manager.refresh = (id, options) => { refreshes.push(id); return refresh(id, options); };
  const allowed = new Set();
  const panel = createMcpServerPanel({ documentRef: doc, store, manager, isToolAllowed: op => allowed.has(op), revokeTool: op => allowed.delete(op) });
  return { store, manager, panel, allowed, refreshes };
};

{
  // 空白 → 添加 → 保存后自动连接并展开工具
  const { store, manager, panel, allowed, refreshes } = await setup({ token: 'secret' });
  panel.show();
  const overlay = panel.overlay;
  assert.equal(byClass(overlay, 'mcp-empty-title')[0].textContent, '还没有 MCP 服务');
  assert.equal(byClass(overlay, 'mcp-subtitle')[0].textContent, '把外部工具接给女仆用');
  buttonLabeled(byClass(overlay, 'mcp-empty')[0], '添加服务').dispatch('click');
  assert.equal(byClass(overlay, 'mcp-form-title')[0].textContent, '添加 MCP 服务');
  assert.equal(byClass(overlay, 'mcp-add')[0].hidden, true, 'the header add button hides while the form is open');
  assert.equal(field(overlay, 'enabled').checked, true, 'new services start enabled');

  // 地址不合格：错误留在表单里
  field(overlay, 'name').value = '本机';
  field(overlay, 'url').value = 'http://example.com/mcp';
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  const error = byClass(overlay, 'mcp-form-error')[0];
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /HTTPS/);

  field(overlay, 'url').value = 'http://127.0.0.1:3917/mcp';
  field(overlay, 'token').value = 'secret';
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  const [config] = store.list();
  assert.deepEqual([config.name, config.hasToken, config.enabled], ['本机', true, true]);
  assert.deepEqual(refreshes, [config.id], 'saving an enabled service connects once');
  const card = byClass(overlay, 'mcp-server')[0];
  assert.equal(card.dataset.tone, 'ok');
  assert.match(text(byClass(card, 'mcp-status')[0]), /^已连接2 个工具 · 检查于 \d\d:\d\d$/);
  assert.deepEqual(byClass(card, 'mcp-tool-name').map(node => node.textContent), ['echo', 'add']);
  assert.equal(byClass(card, 'mcp-tool-title')[0].textContent, '回声');
  assert.deepEqual(byClass(card, 'mcp-chip').map(text), ['令牌已保存', '对方标示只读']);
  assert.equal(byClass(overlay, 'mcp-subtitle')[0].textContent, '已启用 1 个 · 共 1 个（最多 10 个）');

  // 始终允许：显示并可撤销
  const echo = manager.listCatalog(config.id).find(tool => tool.name === 'echo');
  const op = mcpOperationId({ serverId: config.id, endpointRevision: config.endpointRevision, toolName: 'echo', schemaHash: echo.schemaHash });
  allowed.add(op);
  panel.refresh();
  const trusted = byClass(overlay, 'mcp-tool-trust').map(text);
  assert.deepEqual(trusted, ['始终允许撤销', '每次调用前询问']);
  byClass(overlay, 'mcp-link')[0].dispatch('click');
  assert.equal(allowed.has(op), false);
  assert.deepEqual(byClass(overlay, 'mcp-tool-trust').map(text), ['每次调用前询问', '每次调用前询问']);

  // 收起工具列表
  buttonLabeled(overlay, '工具 2').dispatch('click');
  assert.equal(byClass(overlay, 'mcp-tool').length, 0);

  // 连不上时不显示空的工具列表（展开状态还在也一样）
  buttonLabeled(overlay, '工具 2').dispatch('click');
  await store.save({ id: config.id, token: 'wrong' });
  buttonLabeled(overlay, '测试连接').dispatch('click');
  await flush();
  assert.equal(byClass(overlay, 'mcp-server')[0].dataset.tone, 'error');
  assert.equal(byClass(overlay, 'mcp-tools').length, 0, 'a failed service does not show an empty tool list');
  console.log('ok - adding a service saves it, connects once and lists its tools with their trust state');
}

{
  // 编辑：带版本核对；改地址时提示令牌会清除；可勾选清除令牌
  const { store, panel } = await setup();
  const config = await store.save({ name: '远端', url: 'https://mcp.example.com/mcp', enabled: false, token: 'abc' });
  panel.show();
  const overlay = panel.overlay;
  const card = byClass(overlay, 'mcp-server')[0];
  assert.equal(card.dataset.tone, 'off');
  assert.equal(buttonLabeled(card, '测试连接').disabled, true, 'a disabled service cannot be tested');
  buttonLabeled(card, '编辑').dispatch('click');
  assert.equal(byClass(overlay, 'mcp-form-title')[0].textContent, '编辑「远端」');
  assert.equal(field(overlay, 'token').placeholder, '已保存，留空保持不变');
  const warn = byClass(overlay, 'mcp-warn')[0];
  assert.equal(warn.hidden, true);
  field(overlay, 'url').value = 'https://other.example.com/mcp';
  field(overlay, 'url').dispatch('input');
  assert.equal(warn.hidden, false);
  field(overlay, 'url').value = 'https://mcp.example.com/mcp';
  field(overlay, 'url').dispatch('input');
  assert.equal(warn.hidden, true);
  field(overlay, 'name').value = '远端（改名）';
  field(overlay, 'clearToken').checked = true;
  // 期间被别处改过：拒绝保存
  await store.save({ id: config.id, name: '被别处改了' });
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.match(byClass(overlay, 'mcp-form-error')[0].textContent, /已改变/);
  assert.equal(panel.closeTopLayer(), true, 'Back closes the form first');
  assert.equal(byClass(overlay, 'mcp-form').length, 0);
  buttonLabeled(byClass(overlay, 'mcp-server')[0], '编辑').dispatch('click');
  field(overlay, 'clearToken').checked = true;
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.deepEqual([store.list()[0].hasToken, store.list()[0].name], [false, '被别处改了']);
  console.log('ok - editing checks the revision, warns about the token and can clear it');
}

{
  // 开关、删除确认、打开时自动连一次、连不上的显示原因
  const { store, panel, refreshes } = await setup({ token: 'right' });
  const good = await store.save({ name: 'A', url: 'http://127.0.0.1:1/mcp', enabled: true, token: 'right' });
  const bad = await store.save({ name: 'B', url: 'http://127.0.0.1:2/mcp', enabled: true, token: 'wrong' });
  await store.save({ name: 'C', url: 'http://127.0.0.1:3/mcp', enabled: false });
  panel.show();
  assert.deepEqual(refreshes.sort(), [good.id, bad.id].sort(), 'opening connects enabled services that were never checked');
  await flush();
  const overlay = panel.overlay;
  assert.deepEqual(byClass(overlay, 'mcp-server').map(card => card.dataset.tone), ['ok', 'error', 'off']);
  assert.equal(byClass(overlay, 'mcp-alert')[0].textContent, '服务拒绝了授权：请检查令牌');
  assert.equal(byClass(overlay, 'mcp-tool').length, 0, 'automatic checks do not expand tool lists');

  const switchOf = card => walk(card).find(node => node.attributes.role === 'switch');
  const first = byClass(overlay, 'mcp-server')[0];
  switchOf(first).checked = false;
  switchOf(first).dispatch('change');
  await flush();
  assert.equal(store.get(good.id).enabled, false);
  assert.equal(byClass(overlay, 'mcp-server')[0].dataset.tone, 'off');

  buttonLabeled(byClass(overlay, 'mcp-server')[1], '删除').dispatch('click');
  assert.match(byClass(overlay, 'mcp-confirm')[0].textContent, /删除「B」/);
  assert.equal(panel.closeTopLayer(), true, 'Back cancels the delete confirmation first');
  assert.equal(byClass(overlay, 'mcp-confirm').length, 0);
  buttonLabeled(byClass(overlay, 'mcp-server')[1], '删除').dispatch('click');
  buttonLabeled(byClass(overlay, 'mcp-server')[1], '删除').dispatch('click');
  await flush();
  assert.deepEqual(store.list().map(server => server.name), ['A', 'C']);
  assert.equal(panel.closeTopLayer(), true);
  assert.equal(panel.isOpen(), false);
  assert.equal(panel.closeTopLayer(), false);
  console.log('ok - services can be toggled and deleted with confirmation, and failures say why');
}

console.log('mcp-server-panel-tests passed');
