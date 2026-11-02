// MCP 服务配置（Agent 能力注册计划 Phase E，参考 Noa core/mcp.js）：只支持 Streamable HTTP 地址，
// https 或本机 http；地址里不放凭证、查询参数或锚点，令牌加密后单独保存（tokenCipher）。
// 每次修改 revision +1：工具目录与进行中的调用以 revision 核对，配置一改就要重新发现。
// endpointRevision 只在地址或令牌改变时 +1：「始终允许」绑定它，改名、停用再启用不会让授权失效。

export const MCP_SERVERS_KEY = 'mcp_servers_v1';
export const MCP_SERVER_LIMIT = 10;

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });

/** 校验地址：https，或本机（localhost／127.x／[::1]）的 http；不允许账号密码、查询参数与锚点。 */
export const normalizeMcpEndpoint = (raw) => {
  const text = trim(raw);
  if (!text || text.length > 2000) throw fail('mcp_config', 'MCP 地址无效');
  let url;
  try { url = new URL(text); } catch { throw fail('mcp_config', 'MCP 地址无效'); }
  const host = url.hostname;
  const local = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.hash || url.search) {
    throw fail('mcp_config', 'MCP 只支持没有查询参数的 HTTPS 地址或本机 HTTP 地址；令牌请填在令牌栏');
  }
  return url.href;
};

const makeId = () => globalThis.crypto?.randomUUID?.() || `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeServer = (raw) => {
  if (!isPlainObject(raw)) return null;
  const id = trim(raw.id);
  const name = trim(raw.name).slice(0, 80);
  let url = '';
  try { url = normalizeMcpEndpoint(raw.url); } catch { return null; }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !name) return null;
  return {
    id, name, url,
    enabled: raw.enabled === true,
    revision: Math.max(1, Math.trunc(Number(raw.revision)) || 1),
    endpointRevision: Math.max(1, Math.trunc(Number(raw.endpointRevision)) || 1),
    tokenCipher: typeof raw.tokenCipher === 'string' ? raw.tokenCipher.slice(0, 16000) : '',
  };
};

/** 对外的服务记录（不含密文）。 */
const publicServer = ({ tokenCipher, ...server }) => ({ ...server, hasToken: Boolean(tokenCipher) });

export class McpServerStore {
  constructor({ loadKv = null, saveKv = null, encryptSecret = null } = {}) {
    this.loadKv = loadKv;
    this.saveKv = saveKv;
    this.encryptSecret = encryptSecret;
    this.servers = [];
    this.loaded = false;
    this.listeners = new Set();
    this.chain = Promise.resolve();
  }

  async load() {
    let raw = null;
    try { raw = await this.loadKv?.(MCP_SERVERS_KEY); } catch {}
    this.servers = (Array.isArray(raw?.servers) ? raw.servers : []).map(normalizeServer).filter(Boolean).slice(0, MCP_SERVER_LIMIT);
    this.loaded = true;
    return this.list();
  }

  list() { return this.servers.map(publicServer); }
  get(id) { const server = this.servers.find(item => item.id === trim(id)); return server ? publicServer(server) : null; }
  /** 连接用的完整记录（含令牌密文），只给 MCP 管理器使用。 */
  getConnection(id) { const server = this.servers.find(item => item.id === trim(id)); return server ? { ...server } : null; }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(id) { this.listeners.forEach((listener) => { try { listener(id); } catch {} }); }

  serial(work) {
    const job = this.chain.then(work);
    this.chain = job.catch(() => {});
    return job;
  }

  async persist(next) {
    await this.saveKv?.(MCP_SERVERS_KEY, { version: 1, servers: next });
    this.servers = next;
  }

  /** 新增或修改：patch 可含 name、url、enabled、token（空字符串＝清除令牌）；expectedRevision 不符时拒绝。地址改了令牌一并清除。 */
  save(patch = {}, { expectedRevision } = {}) {
    return this.serial(async () => {
      if (!isPlainObject(patch)) throw fail('mcp_config', 'MCP 配置无效');
      const prior = patch.id ? this.servers.find(item => item.id === trim(patch.id)) : null;
      if (patch.id && !prior) throw fail('mcp_not_found', '找不到 MCP 服务');
      if (expectedRevision !== undefined && prior?.revision !== expectedRevision) throw fail('mcp_config_changed', 'MCP 配置已改变，请刷新后重试');
      if (!prior && this.servers.length >= MCP_SERVER_LIMIT) throw fail('mcp_config', `最多配置 ${MCP_SERVER_LIMIT} 个 MCP 服务`);
      const name = trim(patch.name ?? prior?.name);
      if (!name || name.length > 80) throw fail('mcp_config', 'MCP 名称需要 1–80 个字');
      const url = normalizeMcpEndpoint(patch.url ?? prior?.url);
      const item = {
        id: prior?.id || makeId(),
        name,
        url,
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : (prior?.enabled ?? false),
        revision: (prior?.revision || 0) + 1,
        tokenCipher: prior && prior.url === url ? prior.tokenCipher : '',
      };
      if (patch.token !== undefined) {
        const token = String(patch.token ?? '');
        if (token.length > 4096 || /[\r\n\0]/.test(token)) throw fail('mcp_config', 'MCP 令牌格式无效');
        if (!token) item.tokenCipher = '';
        else {
          if (typeof this.encryptSecret !== 'function') throw fail('mcp_credentials', '凭证加密不可用，未保存令牌');
          item.tokenCipher = await this.encryptSecret(token);
        }
      }
      const endpointChanged = !prior || prior.url !== url || patch.token !== undefined;
      item.endpointRevision = endpointChanged ? (prior?.endpointRevision || 0) + 1 : prior.endpointRevision;
      await this.persist(prior ? this.servers.map(server => (server.id === item.id ? item : server)) : [...this.servers, item]);
      this.notify(item.id);
      return publicServer(item);
    });
  }

  remove(id) {
    return this.serial(async () => {
      const target = trim(id);
      if (!this.servers.some(item => item.id === target)) throw fail('mcp_not_found', '找不到 MCP 服务');
      await this.persist(this.servers.filter(item => item.id !== target));
      this.notify(target);
      return { removed: target };
    });
  }
}
