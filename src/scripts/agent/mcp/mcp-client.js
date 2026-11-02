// MCP Streamable HTTP 客户端（参考 Noa core/mcp.js；协议版本 2025-06-18）。
// 只做 initialize、tools/list、tools/call：不支持 stdio、OAuth、sampling、roots、elicitation，也不处理服务端发起的请求。
// 请求经 APP 的原生 http_request 发出（避开 WebView 跨域）；远端名称、说明、schema 与结果都是不可信资料。

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_LIMITS = Object.freeze({
  tools: 100, pages: 10, schemaChars: 6000, descriptionChars: 1000,
  argumentChars: 16000, wireBytes: 2 * 1024 * 1024, resultChars: 8000, timeoutMs: 30000,
});

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const mcpError = (code, message) => Object.assign(new Error(message), { code });
const header = (headers = {}, name) => {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name);
  return key ? String(headers[key]) : '';
};

/** 从响应里取出对应 id 的 JSON-RPC 消息：普通 JSON 或 SSE（event-stream）都支持。 */
export const parseMcpResponse = (response = {}, id = null) => {
  const body = String(response.body ?? '');
  if (body.length > MCP_LIMITS.wireBytes) throw mcpError('mcp_limit', 'MCP 响应过大');
  const messages = [];
  const push = (value) => { (Array.isArray(value) ? value : [value]).forEach(item => { if (isPlainObject(item)) messages.push(item); }); };
  if (/text\/event-stream/i.test(header(response.headers, 'content-type'))) {
    body.replace(/\r\n?/g, '\n').split('\n\n').forEach((event) => {
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) return;
      try { push(JSON.parse(data)); } catch {}
    });
  } else if (body.trim()) {
    try { push(JSON.parse(body)); } catch { throw mcpError('mcp_protocol', 'MCP 响应不是有效的 JSON'); }
  }
  return messages.find(message => message.id === id && ('result' in message || 'error' in message)) || null;
};

const stable = value => (Array.isArray(value) ? value.map(stable)
  : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value);

/** 工具 schema 的指纹：名称与参数 schema 变了就要重新发现、重新确认。 */
export const hashMcpTool = async (tool = {}) => {
  const text = JSON.stringify(stable({ name: tool.name, inputSchema: tool.inputSchema }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const normalizeTool = (raw) => {
  if (!isPlainObject(raw)) return null;
  const name = trim(raw.name);
  if (!/^[a-zA-Z0-9_.\-/]{1,128}$/.test(name)) return null;
  const inputSchema = isPlainObject(raw.inputSchema) ? raw.inputSchema : { type: 'object', properties: {} };
  if (inputSchema.type !== 'object' || JSON.stringify(inputSchema).length > MCP_LIMITS.schemaChars) return null;
  return {
    name,
    title: trim(raw.title || raw.annotations?.title).slice(0, 120),
    description: trim(raw.description).slice(0, MCP_LIMITS.descriptionChars),
    inputSchema,
    // 远端自称的提示，只作参考，不放宽确认
    readOnlyHint: raw.annotations?.readOnlyHint === true,
  };
};

/** 工具结果转成有界的文字：文字内容拼接，其他类型只留类型说明。 */
export const normalizeMcpResult = (result = {}) => {
  const parts = (Array.isArray(result?.content) ? result.content : []).map((item) => {
    if (item?.type === 'text') return String(item.text ?? '');
    if (item?.type === 'resource') return `[resource ${trim(item.resource?.uri)}]${item.resource?.text ? `\n${String(item.resource.text)}` : ''}`;
    if (item?.type === 'resource_link') return `[resource ${trim(item.uri)}]`;
    return `[${trim(item?.type) || 'content'}]`;
  });
  if (isPlainObject(result?.structuredContent) && !parts.length) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n');
  return {
    isError: result?.isError === true,
    text: text.length > MCP_LIMITS.resultChars ? `${text.slice(0, MCP_LIMITS.resultChars)}…` : text,
    truncated: text.length > MCP_LIMITS.resultChars,
  };
};

/**
 * httpRequest({ url, method, headers, body, timeoutMs, signal }) → { status, ok, headers, body }。
 * 一次会话：先 initialize，之后的请求带 Mcp-Session-Id 与协议版本；会话过期（404）自动重新 initialize 一次。
 */
export const createMcpClient = ({ url, token = '', httpRequest, timeoutMs = MCP_LIMITS.timeoutMs, clientInfo = { name: 'OmniTavern', version: '1' } } = {}) => {
  let sessionId = '', protocolVersion = '', initialized = null, nextId = 1;

  const post = async (message, { signal = null, expectReply = true } = {}) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    let response;
    try {
      response = await httpRequest({ url, method: 'POST', headers, body: JSON.stringify(message), timeoutMs, signal });
    } catch (error) {
      if (signal?.aborted || /abort/i.test(String(error?.message || error))) throw mcpError('mcp_cancelled', 'MCP 请求已取消或超时；没有自动重试');
      throw mcpError('mcp_network', 'MCP 连接失败；没有自动重试，请检查地址与服务状态');
    }
    const session = header(response?.headers, 'mcp-session-id');
    if (session) sessionId = session;
    const status = Number(response?.status) || 0;
    if (status === 404 && sessionId && message.method !== 'initialize') throw mcpError('mcp_session_expired', 'MCP 会话已过期');
    if (status === 401 || status === 403) throw mcpError('mcp_auth', 'MCP 服务拒绝了授权，请检查令牌');
    if (!(status >= 200 && status < 300)) throw mcpError('mcp_http', `MCP 服务返回 ${status || '无响应'}`);
    if (!expectReply) return null;
    const reply = parseMcpResponse(response, message.id);
    if (!reply) throw mcpError('mcp_protocol', 'MCP 服务没有返回对应的结果');
    if (reply.error) throw mcpError('mcp_remote_error', `MCP 服务报错：${trim(reply.error.message).slice(0, 200) || reply.error.code}`);
    return reply.result;
  };

  const initialize = async ({ signal = null } = {}) => {
    sessionId = ''; protocolVersion = '';
    const result = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo } }, { signal });
    protocolVersion = trim(result?.protocolVersion) || MCP_PROTOCOL_VERSION;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal, expectReply: false });
    return { protocolVersion, serverInfo: isPlainObject(result?.serverInfo) ? { name: trim(result.serverInfo.name).slice(0, 120), version: trim(result.serverInfo.version).slice(0, 40) } : null };
  };

  const ensureSession = (options) => {
    if (!initialized) initialized = initialize(options).catch((error) => { initialized = null; throw error; });
    return initialized;
  };

  const request = async (method, params, { signal = null } = {}) => {
    await ensureSession({ signal });
    try {
      return await post({ jsonrpc: '2.0', id: nextId++, method, params }, { signal });
    } catch (error) {
      if (error?.code !== 'mcp_session_expired') throw error;
      initialized = null;
      await ensureSession({ signal });
      return post({ jsonrpc: '2.0', id: nextId++, method, params }, { signal });
    }
  };

  return {
    initialize: options => ensureSession(options),
    async listTools({ signal = null } = {}) {
      const tools = [];
      let cursor;
      for (let page = 0; page < MCP_LIMITS.pages; page += 1) {
        const result = await request('tools/list', cursor ? { cursor } : {}, { signal });
        (Array.isArray(result?.tools) ? result.tools : []).forEach((raw) => {
          const tool = normalizeTool(raw);
          if (tool && tools.length < MCP_LIMITS.tools && !tools.some(item => item.name === tool.name)) tools.push(tool);
        });
        cursor = trim(result?.nextCursor);
        if (!cursor || tools.length >= MCP_LIMITS.tools) break;
      }
      return tools;
    },
    async callTool(name, args = {}, { signal = null } = {}) {
      const text = JSON.stringify(isPlainObject(args) ? args : {});
      if (text.length > MCP_LIMITS.argumentChars) throw mcpError('mcp_limit', 'MCP 调用参数过长');
      return normalizeMcpResult(await request('tools/call', { name, arguments: JSON.parse(text) }, { signal }));
    },
  };
};
