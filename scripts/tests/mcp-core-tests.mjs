import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMiniMcpServer } = await import('./fixtures/mini-mcp-server.mjs');
const { createMcpClient, parseMcpResponse, normalizeMcpResult, MCP_LIMITS } = await import('../../src/scripts/agent/mcp/mcp-client.js');
const { createMcpManager } = await import('../../src/scripts/agent/mcp/mcp-manager.js');
const { McpServerStore, normalizeMcpEndpoint, MCP_SERVER_LIMIT } = await import('../../src/scripts/storage/mcp-server-store.js');
const { createMcpAgentTools, mcpOperationId, pruneMcpAllowRules } = await import('../../src/scripts/agent/tools/mcp-tools.js');
const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');

const viaServer = server => async request => server.handle(request);

{
  // 地址校验：https 或本机 http；不放凭证、查询参数与锚点
  assert.equal(normalizeMcpEndpoint('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp');
  assert.equal(normalizeMcpEndpoint('http://127.0.0.1:3917/mcp'), 'http://127.0.0.1:3917/mcp');
  assert.equal(normalizeMcpEndpoint('http://localhost:8080/'), 'http://localhost:8080/');
  for (const bad of ['http://example.com/mcp', 'https://user:pw@x.com/', 'https://x.com/mcp?key=1', 'https://x.com/#a', 'ftp://x.com', '']) {
    assert.throws(() => normalizeMcpEndpoint(bad), /MCP/, bad);
  }
  console.log('ok - MCP endpoints accept https or local http only');
}

{
  // 响应解析：普通 JSON 与 SSE；结果转有界文字
  const json = parseMcpResponse({ headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":3,"result":{"ok":1}}' }, 3);
  assert.deepEqual(json.result, { ok: 1 });
  const sse = parseMcpResponse({ headers: { 'Content-Type': 'text/event-stream' }, body: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"x":2}}\n\n' }, 7);
  assert.deepEqual(sse.result, { x: 2 }, 'notifications in the stream are skipped');
  assert.throws(() => parseMcpResponse({ body: 'x'.repeat(MCP_LIMITS.wireBytes + 1) }, 1), /过大/);
  const long = normalizeMcpResult({ content: [{ type: 'text', text: 'a'.repeat(MCP_LIMITS.resultChars + 10) }, { type: 'image', data: 'xx' }] });
  assert.equal(long.truncated, true);
  assert.equal(normalizeMcpResult({ content: [{ type: 'text', text: 'hi' }, { type: 'image' }] }).text, 'hi\n[image]');
  console.log('ok - MCP replies parse from JSON and SSE and results are bounded');
}

for (const sse of [false, true]) {
  // 会话：initialize 后带会话 id 与协议版本；会话过期自动重新 initialize 一次
  const server = createMiniMcpServer({ sse, token: 'secret', pageSize: 1 });
  const client = createMcpClient({ url: 'http://127.0.0.1/mcp', token: 'secret', httpRequest: viaServer(server) });
  const tools = await client.listTools();
  assert.deepEqual(tools.map(tool => [tool.name, tool.readOnlyHint]), [['echo', true], ['add', false]], 'paged tool lists are collected');
  assert.deepEqual(server.calls.slice(0, 3).map(call => call.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(server.calls[2].session, 's1');
  assert.equal(server.calls[2].protocol, '2025-06-18');
  server.expireSessions();
  const result = await client.callTool('add', { a: 2, b: 3 });
  assert.deepEqual([result.text, result.isError], ['5', false]);
  assert.ok(server.calls.some(call => call.method === 'initialize' && call !== server.calls[0]), 'an expired session is re-initialized once');
  const wrongToken = createMcpClient({ url: 'http://127.0.0.1/mcp', token: 'nope', httpRequest: viaServer(server) });
  await assert.rejects(wrongToken.listTools(), error => error.code === 'mcp_auth');
  console.log(`ok - MCP client sessions work over ${sse ? 'SSE' : 'JSON'} and recover from session expiry`);
}

const makeStore = async () => {
  let saved = null;
  const store = new McpServerStore({ loadKv: async () => saved, saveKv: async (key, value) => { saved = JSON.parse(JSON.stringify(value)); }, encryptSecret: async text => `enc(${text})` });
  await store.load();
  return { store, saved: () => saved };
};

{
  // 服务配置：版本核对、地址改了清除令牌、数量上限、令牌只存密文
  const { store, saved } = await makeStore();
  const first = await store.save({ name: '本机测试', url: 'http://127.0.0.1:3917/mcp', enabled: true, token: 'secret' });
  assert.deepEqual([first.revision, first.endpointRevision, first.hasToken, first.enabled], [1, 1, true, true]);
  assert.equal(saved().servers[0].tokenCipher, 'enc(secret)');
  assert.equal(JSON.stringify(saved()).includes('"secret"'), false, 'the plain token is never stored');
  await assert.rejects(store.save({ id: first.id, name: 'x' }, { expectedRevision: 9 }), error => error.code === 'mcp_config_changed');
  const moved = await store.save({ id: first.id, url: 'https://other.example.com/mcp' }, { expectedRevision: 1 });
  assert.deepEqual([moved.revision, moved.endpointRevision, moved.hasToken], [2, 2, false], 'changing the address drops the token');
  const renamed = await store.save({ id: first.id, name: '改名' });
  assert.deepEqual([renamed.revision, renamed.endpointRevision], [3, 2], 'renaming keeps the endpoint revision');
  assert.equal(store.list()[0].id, first.id, 'editing keeps the list order');
  for (let index = 1; index < MCP_SERVER_LIMIT; index += 1) await store.save({ name: `s${index}`, url: `https://s${index}.example.com/` });
  await assert.rejects(store.save({ name: 'one too many', url: 'https://x.example.com/' }), /最多/);
  await store.remove(first.id);
  assert.equal(store.list().length, MCP_SERVER_LIMIT - 1);
  console.log('ok - MCP server configs keep revisions, encrypt tokens and enforce limits');
}

{
  // 管理器：检索、按 schemaHash 调用、配置改了旧目录失效
  const server = createMiniMcpServer({});
  const { store } = await makeStore();
  const config = await store.save({ name: '本机', url: 'http://127.0.0.1:3917/mcp', enabled: true });
  const manager = createMcpManager({ store, httpRequest: viaServer(server) });
  const page = await manager.search({ query: 'echo' });
  assert.deepEqual(page.tools.map(tool => [tool.serverName, tool.name]), [['本机', 'echo']]);
  const echo = page.tools[0];
  assert.match(echo.schemaHash, /^[a-f0-9]{64}$/);
  const result = await manager.call({ serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, arguments: { text: '你好' } });
  assert.deepEqual([result.text, result.isError, result.serverName], ['你好', false, '本机']);
  await assert.rejects(manager.call({ serverId: config.id, toolName: 'echo', schemaHash: 'f'.repeat(64), arguments: {} }), error => error.code === 'mcp_schema_changed');
  assert.equal(manager.getHealth(config.id).status, 'connected');
  await store.save({ id: config.id, enabled: false });
  await assert.rejects(manager.call({ serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash }), error => error.code === 'mcp_disabled');
  assert.equal(manager.getHealth(config.id).status, 'unknown', 'changing the config clears the cached state');
  // 连不上的服务单独列出，不影响其他服务
  const broken = await store.save({ name: '坏的', url: 'https://broken.example.com/mcp', enabled: true });
  const failing = createMcpManager({ store, httpRequest: async () => { throw new Error('connect refused'); } });
  const empty = await failing.search({});
  assert.deepEqual(empty.unavailable.map(item => [item.serverId, item.reason]), [[broken.id, 'mcp_network']]);
  assert.equal(failing.getHealth(broken.id).status, 'failed');
  console.log('ok - the MCP manager searches, calls by schema hash and invalidates on config changes');
}

{
  // 检索关键词：按空白分开、含服务名，对上越多越前面；一个都没对上就列出全部并标 noMatch
  // （手机实测：模型查「DeepWiki repository documentation structure」整句对不上，回 0 个就误以为没有工具）
  const { store } = await makeStore();
  await store.save({ name: '本机', url: 'http://127.0.0.1:3917/mcp', enabled: true });
  const manager = createMcpManager({ store, httpRequest: viaServer(createMiniMcpServer({})) });
  const names = page => page.tools.map(tool => tool.name);
  assert.deepEqual(names(await manager.search({ query: 'echo text back' })), ['echo'], 'several words match one tool');
  assert.deepEqual(names(await manager.search({ query: '本机 numbers' })), ['add', 'echo'], 'the server name counts and better matches come first');
  const none = await manager.search({ query: '查文档结构' });
  assert.deepEqual([names(none), none.total, none.noMatch], [['echo', 'add'], 2, true], 'no match lists every tool');
  assert.equal('noMatch' in await manager.search({ query: 'add' }), false);
  console.log('ok - MCP search splits keywords, ranks matches and never hides the catalog');
}

{
  // 工具：mcp.call 每次确认（可始终允许，规则绑定版本与 schema）；mcp.lookup 只能用已始终允许的工具
  const server = createMiniMcpServer({});
  const { store } = await makeStore();
  const config = await store.save({ name: '本机', url: 'http://127.0.0.1:3917/mcp', enabled: true });
  const manager = createMcpManager({ store, httpRequest: viaServer(server) });
  const allowed = new Set();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMcpAgentTools({ getManager: () => manager, getServer: id => store.get(id), isAllowed: op => allowed.has(op) }));
  const run = async (name, args, context) => (await registry.executeTool(name, args, context)).result;

  const found = await run('mcp.search', { query: '' }, {});
  assert.equal(found.tools.length, 2);
  const echo = found.tools.find(tool => tool.toolName === 'echo');
  assert.equal(echo.remoteSaysReadOnly, true);

  const requests = [];
  const denied = await registry.executeTool('mcp.call', { serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, argumentsJson: JSON.stringify({ text: 'hi' }) }, {
    requestToolConfirmation: async (request) => { requests.push(request); return { decision: 'deny' }; },
  });
  assert.notEqual(denied.status, 'succeeded');
  assert.equal(server.calls.filter(call => call.method === 'tools/call').length, 0, 'a denied call sends nothing');
  const op = mcpOperationId({ serverId: config.id, endpointRevision: config.endpointRevision, toolName: 'echo', schemaHash: echo.schemaHash });
  assert.deepEqual([requests[0].kind, requests[0].operationType, requests[0].allowAlways], ['mcp.call', op, true]);
  assert.match(requests[0].message, /服务地址：http:\/\/127\.0\.0\.1:3917\/mcp[\s\S]*"text": "hi"/);
  await assert.rejects(registry.executeTool('mcp.call', { serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, argumentsJson: '{oops' }, {
    requestToolConfirmation: async (request) => { requests.push(request); return { decision: 'allow' }; },
  }), error => error.code === 'mcp_arguments');
  assert.equal(requests.length, 1, 'malformed arguments fail before the confirmation is shown');
  const ok = await run('mcp.call', { serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, argumentsJson: JSON.stringify({ text: 'hi' }) }, { requestToolConfirmation: async () => ({ decision: 'allow' }) });
  assert.deepEqual([ok.ok, ok.text], [true, 'hi']);
  // 只读请求（「帮我看看…」）：只问 MCP 自己的确认（可始终允许），不先弹「本轮请求按只读理解」
  const readOnlyKinds = [];
  const readOnly = await run('mcp.call', { serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, argumentsJson: JSON.stringify({ text: '只读' }) }, {
    operationIntentPolicy: { mode: 'read_only', source: 'maid_user_request', reason: 'explicit_read_without_write' },
    requestToolConfirmation: async (request) => { readOnlyKinds.push(request.kind); return { decision: 'allow' }; },
  });
  assert.deepEqual([readOnly.ok, readOnly.text, readOnlyKinds], [true, '只读', ['mcp.call']]);

  // 自建 Agent：没有始终允许就看不到、也调不了
  assert.deepEqual((await run('mcp.lookup', {}, {})).tools, []);
  const blocked = await run('mcp.lookup', { serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, argumentsJson: '{"text":"x"}' }, {});
  assert.equal(blocked.reason, 'mcp_not_trusted');
  allowed.add(op);
  assert.deepEqual((await run('mcp.lookup', {}, {})).tools.map(tool => tool.toolName), ['echo']);
  const looked = await run('mcp.lookup', { serverId: config.id, toolName: 'echo', schemaHash: echo.schemaHash, argumentsJson: JSON.stringify({ text: '参考' }) }, {});
  assert.deepEqual([looked.ok, looked.text], [true, '参考']);
  // 改名、停用再启用不影响授权；换令牌（或地址）后旧规则不再适用
  await store.save({ id: config.id, name: '本机（改名）' });
  await store.save({ id: config.id, enabled: false });
  await store.save({ id: config.id, enabled: true });
  assert.deepEqual((await run('mcp.lookup', {}, {})).tools.map(tool => tool.toolName), ['echo'], 'renaming or toggling keeps the always-allow rule');
  await store.save({ id: config.id, token: 'rotated' });
  assert.deepEqual((await run('mcp.lookup', {}, {})).tools, [], 'a new token retires the old always-allow rule');
  console.log('ok - MCP calls are confirmed per call, and custom agents only reach always-allowed tools');
}

{
  // 失效规则清理：只动 MCP 的规则；服务删了全清，换地址只留当前地址版本
  const rules = [
    { key: 'a', kind: 'mcp.call', operationType: 'mcp:srv@1:echo#aaaa' },
    { key: 'b', kind: 'mcp.call', operationType: 'mcp:srv@2:echo#aaaa' },
    { key: 'c', kind: 'mcp.call', operationType: 'mcp:other@1:echo#aaaa' },
    { key: 'd', kind: 'worldbook.write', operationType: 'mcp:srv@1:x' },
  ];
  const allowStore = { list: () => rules.map(rule => ({ ...rule })), revoke: (key) => { const at = rules.findIndex(rule => rule.key === key); if (at < 0) return false; rules.splice(at, 1); return true; } };
  assert.equal(pruneMcpAllowRules({ allowStore, getServer: () => ({ endpointRevision: 2 }) }, 'srv'), 1);
  assert.deepEqual(rules.map(rule => rule.key), ['b', 'c', 'd']);
  assert.equal(pruneMcpAllowRules({ allowStore, getServer: () => null }, 'srv'), 1);
  assert.deepEqual(rules.map(rule => rule.key), ['c', 'd']);
  console.log('ok - stale MCP always-allow rules are pruned per server');
}

console.log('mcp-core-tests passed');
