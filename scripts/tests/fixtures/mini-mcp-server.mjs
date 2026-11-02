// 测试用的最小 MCP Streamable HTTP 服务：initialize／notifications/initialized／tools/list（分页）／tools/call。
// handle() 供单元测试直接调用；listen() 在本机起一个 HTTP 服务，供 dev 实测（只监听 127.0.0.1）。
import http from 'node:http';

export const createMiniMcpServer = ({
  tools = [
    { name: 'echo', title: '回声', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  ],
  token = '',
  sse = false,
  pageSize = 0,
} = {}) => {
  const sessions = new Set();
  const calls = [];
  let sessionSeq = 0;
  const reply = (status, payload, extraHeaders = {}) => {
    if (payload === null) return { status, headers: extraHeaders, body: '' };
    const json = JSON.stringify(payload);
    return sse
      ? { status, headers: { 'Content-Type': 'text/event-stream', ...extraHeaders }, body: `event: message\ndata: ${json}\n\n` }
      : { status, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: json };
  };
  const handle = ({ method = 'POST', headers = {}, body = '' } = {}) => {
    const get = name => headers[Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())];
    if (token && get('authorization') !== `Bearer ${token}`) return { status: 401, headers: {}, body: '' };
    if (method !== 'POST') return { status: 405, headers: {}, body: '' };
    const message = JSON.parse(body || '{}');
    calls.push({ method: message.method, session: get('mcp-session-id') || '', protocol: get('mcp-protocol-version') || '' });
    if (message.method === 'initialize') {
      const id = `s${++sessionSeq}`;
      sessions.add(id);
      return reply(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mini-mcp', version: '0.1' } } }, { 'Mcp-Session-Id': id });
    }
    if (!sessions.has(get('mcp-session-id'))) return { status: 404, headers: {}, body: '' };
    if (message.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
    if (message.method === 'tools/list') {
      const start = Number(message.params?.cursor || 0);
      const size = pageSize || tools.length;
      const page = tools.slice(start, start + size);
      return reply(200, { jsonrpc: '2.0', id: message.id, result: { tools: page, ...(start + size < tools.length ? { nextCursor: String(start + size) } : {}) } });
    }
    if (message.method === 'tools/call') {
      const { name, arguments: args = {} } = message.params || {};
      if (name === 'echo') return reply(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
      if (name === 'add') return reply(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] } });
      return reply(200, { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] } });
    }
    return reply(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  };
  return {
    handle,
    calls,
    expireSessions: () => sessions.clear(),
    listen: (port = 0) => new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const out = handle({ method: req.method, headers: req.headers, body });
          res.writeHead(out.status, out.headers);
          res.end(out.body);
        });
      });
      server.listen(port, '127.0.0.1', () => resolve(server));
    }),
  };
};

// 直接执行：node mini-mcp-server.mjs [port] [token]，供 dev 实测
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.argv[2] || 3917);
  createMiniMcpServer({ token: process.argv[3] || '' }).listen(port).then(() => console.log(`mini MCP listening on http://127.0.0.1:${port}/mcp`));
}
