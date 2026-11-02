// MCP 管理：按服务缓存工具目录（带 schemaHash）、连接状态，提供有界的检索与调用。
// 调用前复核：服务仍启用、配置版本没变、工具与 schemaHash 和发现时一致；有副作用的调用不自动重试。

import { createMcpClient, hashMcpTool, mcpError } from './mcp-client.js';

const trim = value => String(value ?? '').trim();
export const MCP_SEARCH_PAGE = 10;

export const createMcpManager = ({ store, httpRequest, decryptSecret = async () => '', now = Date.now } = {}) => {
  const catalogs = new Map(); // serverId → { revision, tools, fetchedAt }
  const health = new Map(); // serverId → { status, lastError, lastErrorCode, checkedAt, serverInfo, protocolVersion }
  const clients = new Map(); // serverId → { revision, client }

  const invalidate = (id) => { catalogs.delete(id); clients.delete(id); health.delete(id); };
  store?.subscribe?.(id => invalidate(id));

  const enabledServer = (serverId) => {
    const server = store?.getConnection?.(serverId);
    if (!server || !server.enabled) throw mcpError('mcp_disabled', 'MCP 服务不存在或没有启用');
    return server;
  };

  const clientFor = async (server) => {
    const cached = clients.get(server.id);
    if (cached?.revision === server.revision) return cached.client;
    const token = server.tokenCipher ? await decryptSecret(server.tokenCipher) : '';
    const client = createMcpClient({ url: server.url, token, httpRequest });
    clients.set(server.id, { revision: server.revision, client });
    return client;
  };

  /** 连接并重新取工具目录；失败记进连接状态，错误往上抛（信息已脱敏）。 */
  const refresh = async (serverId, { signal = null } = {}) => {
    const server = enabledServer(serverId);
    try {
      const client = await clientFor(server);
      const session = await client.initialize({ signal });
      const tools = await client.listTools({ signal });
      for (const tool of tools) tool.schemaHash = await hashMcpTool(tool);
      if (store.getConnection(serverId)?.revision !== server.revision) throw mcpError('mcp_config_changed', 'MCP 配置已改变，请重新连接');
      catalogs.set(serverId, { revision: server.revision, tools, fetchedAt: now() });
      health.set(serverId, { status: 'connected', lastError: '', lastErrorCode: '', checkedAt: now(), serverInfo: session?.serverInfo || null, protocolVersion: session?.protocolVersion || '' });
      return { tools: tools.map(tool => ({ ...tool })), serverInfo: session?.serverInfo || null };
    } catch (error) {
      clients.delete(serverId);
      health.set(serverId, { status: 'failed', lastError: String(error?.message || error).slice(0, 200), lastErrorCode: trim(error?.code), checkedAt: now(), serverInfo: null, protocolVersion: '' });
      throw error;
    }
  };

  const ensureCatalog = async (serverId, options) => {
    const server = enabledServer(serverId);
    const cached = catalogs.get(serverId);
    if (cached && cached.revision === server.revision) return cached;
    await refresh(serverId, options);
    return catalogs.get(serverId);
  };

  /**
   * 在启用的服务里找工具：关键词按空白分开，服务名、工具名、标题、说明含任一个就算，含得越多越前面；
   * 一个都没对上时列出全部并标 noMatch（模型换个说法或语言就查不到，会误以为没有工具）。一次最多一页，连不上的服务单独列出。
   */
  const search = async ({ query = '', serverId = '', offset = 0, limit = MCP_SEARCH_PAGE } = {}, options = {}) => {
    const servers = (store?.list?.() || []).filter(server => server.enabled && (!serverId || server.id === serverId));
    const terms = trim(query).toLowerCase().split(/\s+/).filter(Boolean);
    const all = [];
    const unavailable = [];
    for (const server of servers) {
      try {
        const catalog = await ensureCatalog(server.id, options);
        catalog.tools.forEach((tool) => {
          const text = `${server.name}\n${tool.name}\n${tool.title}\n${tool.description}`.toLowerCase();
          all.push({ score: terms.filter(term => text.includes(term)).length, tool: { serverId: server.id, serverName: server.name, ...tool } });
        });
      } catch (error) {
        unavailable.push({ serverId: server.id, serverName: server.name, reason: trim(error?.code) || 'mcp_error' });
      }
    }
    const matched = all.filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const noMatch = terms.length > 0 && !matched.length && all.length > 0;
    const found = (terms.length && !noMatch ? matched : all).map(item => item.tool);
    const start = Math.max(0, Math.trunc(Number(offset)) || 0);
    const size = Math.min(MCP_SEARCH_PAGE, Math.max(1, Math.trunc(Number(limit)) || MCP_SEARCH_PAGE));
    return {
      tools: found.slice(start, start + size),
      total: found.length,
      ...(start + size < found.length ? { nextOffset: start + size } : {}),
      ...(noMatch ? { noMatch: true } : {}),
      ...(unavailable.length ? { unavailable } : {}),
    };
  };

  /** 调用前再核对一次服务与 schemaHash；不自动重试。 */
  const call = async ({ serverId = '', toolName = '', schemaHash = '', arguments: args = {} } = {}, { signal = null } = {}) => {
    const server = enabledServer(serverId);
    const catalog = await ensureCatalog(serverId, { signal });
    const tool = catalog.tools.find(item => item.name === trim(toolName));
    if (!tool || tool.schemaHash !== trim(schemaHash)) throw mcpError('mcp_schema_changed', 'MCP 工具或参数格式已改变，请重新查找后再调用');
    if (store.getConnection(serverId)?.revision !== server.revision) throw mcpError('mcp_config_changed', 'MCP 配置已改变，请重新查找后再调用');
    const client = await clientFor(server);
    const result = await client.callTool(tool.name, args, { signal });
    return { serverId, serverName: server.name, toolName: tool.name, ...result };
  };

  const describeTool = (serverId, toolName) => catalogs.get(trim(serverId))?.tools.find(item => item.name === trim(toolName)) || null;

  return {
    refresh,
    search,
    call,
    describeTool,
    listCatalog: serverId => (catalogs.get(trim(serverId))?.tools || []).map(tool => ({ ...tool })),
    getHealth: serverId => ({ status: 'unknown', lastError: '', lastErrorCode: '', checkedAt: 0, serverInfo: null, protocolVersion: '', ...(health.get(trim(serverId)) || {}) }),
    invalidate,
  };
};
