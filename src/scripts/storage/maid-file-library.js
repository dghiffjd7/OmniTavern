// 女仆文件库：用户附件、从压缩包取出的文件和女仆产出的文件。
// 原文件按 SHA-256 存在数据目录（Rust maid_file_*，同内容只存一份），索引存 KV；APP 重启后可继续处理。
// 内存只缓存最近用过的原文件。空间控制：总量超出上限先清最久没用的，闲置超过期限的启动时清掉。
// 不接存储（测试或存储不可用）时退化为纯内存：缓存放不下就丢弃最早的文件。

export const MAID_FILE_LIBRARY_KV_NAME = 'maid_file_library_v1';
export const MAID_FILE_LIBRARY_LIMITS = Object.freeze({
  maxTotalBytes: 300 * 1024 * 1024,
  maxIdleMs: 30 * 24 * 60 * 60 * 1000,
  cacheBytes: 80 * 1024 * 1024,
});
export const MAID_FILE_ORIGINS = Object.freeze(['upload', 'archive', 'maid']);
const RECENT_FILE_MAX_AGE_MS = 30 * 60 * 1000;

const trim = value => String(value ?? '').trim();
const isHash = value => /^[0-9a-f]{64}$/.test(trim(value));
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const toStoredEntry = (meta) => ({
  id: meta.id,
  hash: meta.hash,
  name: meta.name,
  mime: meta.mime,
  size: meta.size,
  inspection: meta.inspection ?? null,
  origin: meta.origin,
  parentId: meta.parentId || '',
  entryPath: meta.entryPath || '',
  registeredAt: meta.registeredAt,
  lastUsedAt: meta.lastUsedAt,
  submittedContext: meta.submittedContext || null,
  imports: Array.isArray(meta.imports) ? meta.imports : [],
});

export const createMaidFileLibrary = ({
  loadKv = null,
  saveKv = null,
  blobs = null,
  now = () => Date.now(),
  limits = {},
  logger = null,
} = {}) => {
  const { maxTotalBytes, maxIdleMs, cacheBytes } = { ...MAID_FILE_LIBRARY_LIMITS, ...limits };
  const persistent = Boolean(blobs && typeof saveKv === 'function');
  const entries = new Map();
  // 原文件缓存按哈希（没有哈希时按 ID）；Map 的插入顺序即最近使用顺序
  const cache = new Map();
  let cachedBytes = 0;
  let queue = Promise.resolve();

  const enqueue = task => {
    queue = queue.then(task).catch(error => logger?.warn?.('[maid-file-library]', error));
    return queue;
  };
  const cacheKey = meta => (isHash(meta.hash) ? meta.hash : `id:${meta.id}`);
  const referenced = key => Array.from(entries.values()).some(meta => cacheKey(meta) === key);

  const dropCache = (key) => {
    const bytes = cache.get(key);
    if (!bytes) return;
    cachedBytes -= bytes.byteLength;
    cache.delete(key);
  };
  const removeEntry = (id) => {
    const meta = entries.get(id);
    if (!meta) return false;
    entries.delete(id);
    const key = cacheKey(meta);
    if (!referenced(key)) {
      dropCache(key);
      if (persistent && meta.persisted) enqueue(() => blobs.delete([meta.hash]));
    }
    return true;
  };
  const putCache = (key, bytes) => {
    dropCache(key);
    cache.set(key, bytes);
    cachedBytes += bytes.byteLength;
    for (const oldKey of Array.from(cache.keys())) {
      if (cachedBytes <= cacheBytes) break;
      if (oldKey === key) continue;
      const owners = Array.from(entries.values()).filter(meta => cacheKey(meta) === oldKey);
      // 还在排队存盘的文件此时缓存是唯一一份，不能挤掉
      if (owners.some(meta => meta.pending)) continue;
      dropCache(oldKey);
      // 没存盘的文件（纯内存模式或无法计算哈希）缓存就是唯一一份：挤掉即整份作废
      for (const meta of owners) if (!meta.persisted) entries.delete(meta.id);
    }
  };
  const getCached = (meta) => {
    const key = cacheKey(meta);
    const bytes = cache.get(key);
    if (!bytes) return null;
    cache.delete(key);
    cache.set(key, bytes);
    return bytes;
  };

  const saveIndex = () => (persistent
    ? enqueue(() => saveKv(MAID_FILE_LIBRARY_KV_NAME, {
      version: 1,
      updatedAt: now(),
      entries: Array.from(entries.values()).filter(meta => meta.persisted).map(toStoredEntry),
    }))
    : queue);

  const totalStoredBytes = () => {
    const sizes = new Map();
    for (const meta of entries.values()) if (meta.persisted) sizes.set(meta.hash, meta.size);
    return Array.from(sizes.values()).reduce((sum, size) => sum + (Number(size) || 0), 0);
  };
  // 超出总量：从最久没用的开始清（正在加入的文件除外）
  const enforceQuota = (keepId = '') => {
    let total = totalStoredBytes();
    const byIdle = Array.from(entries.values())
      .filter(meta => meta.persisted && meta.id !== keepId)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const meta of byIdle) {
      if (total <= maxTotalBytes) break;
      removeEntry(meta.id);
      total = totalStoredBytes();
    }
  };
  const touch = (meta) => {
    meta.lastUsedAt = now();
  };

  const library = {
    persistent,
    // 同步登记：原文件先进缓存，随后在后台存盘、套用配额、写索引
    register(id, entry = {}) {
      const key = trim(id);
      if (!key || !(entry.bytes instanceof Uint8Array)) return;
      removeEntry(key);
      const at = now();
      const meta = {
        id: key,
        hash: trim(entry.hash),
        name: trim(entry.name),
        mime: trim(entry.mime),
        size: entry.bytes.byteLength,
        inspection: entry.inspection ?? null,
        origin: MAID_FILE_ORIGINS.includes(entry.origin) ? entry.origin : 'upload',
        parentId: trim(entry.parentId),
        entryPath: trim(entry.entryPath),
        registeredAt: at,
        lastUsedAt: at,
        submittedContext: null,
        imports: [],
        persisted: false,
        pending: persistent && isHash(entry.hash),
      };
      entries.set(key, meta);
      putCache(cacheKey(meta), entry.bytes);
      if (meta.pending) {
        const bytes = entry.bytes;
        enqueue(async () => {
          try {
            await blobs.put(meta.hash, bytes);
            if (entries.get(key) !== meta) return;
            meta.persisted = true;
            enforceQuota(key);
          } finally {
            meta.pending = false;
          }
        });
        saveIndex();
      }
    },
    // 元数据加上缓存里的原文件；不在缓存时 bytes 为 null，需先 ensureLoaded
    get(id) {
      const meta = entries.get(trim(id));
      if (!meta) return null;
      return { ...meta, bytes: getCached(meta) };
    },
    async ensureLoaded(id) {
      const meta = entries.get(trim(id));
      if (!meta) return null;
      touch(meta);
      if (!getCached(meta) && persistent && meta.persisted) {
        try {
          const bytes = await blobs.get(meta.hash);
          if (bytes instanceof Uint8Array && entries.get(meta.id) === meta) putCache(cacheKey(meta), bytes);
        } catch (error) {
          logger?.warn?.('[maid-file-library] load failed', error);
          if (/not_found/.test(String(error?.message || error))) {
            removeEntry(meta.id);
            saveIndex();
            return null;
          }
        }
      }
      saveIndex();
      return library.get(meta.id);
    },
    release: id => removeEntry(trim(id)) && (saveIndex(), true),
    remove(id) {
      const removed = removeEntry(trim(id));
      if (removed) saveIndex();
      return removed;
    },
    // 从附件条移除或关闭丢弃、从未发送的文件：模型没见过，直接删掉
    discardUnsubmitted(id) {
      const meta = entries.get(trim(id));
      if (!meta || meta.submittedContext) return false;
      return library.remove(meta.id);
    },
    // 只记第一次发送时的上下文：追问期间用户切卡，不会悄悄改成新目标
    markSubmitted(id, context = {}) {
      const meta = entries.get(trim(id));
      if (!meta) return;
      touch(meta);
      if (!meta.submittedContext) {
        meta.submittedContext = { roleCardId: trim(context.roleCardId), sessionId: trim(context.sessionId) };
      }
      saveIndex();
    },
    recordImport(id, record) {
      const meta = entries.get(trim(id));
      if (!meta) return;
      touch(meta);
      meta.imports.push({ ...record, at: now() });
      saveIndex();
    },
    // 最近发送过、还没导入的文件（供追问后的下一轮继续使用）；没发送过的模型没见过，不算
    listRecent({ excludeIds = [], maxAgeMs = RECENT_FILE_MAX_AGE_MS } = {}) {
      const excluded = new Set(excludeIds.map(trim));
      return Array.from(entries.values())
        .filter(meta => meta.submittedContext && !excluded.has(meta.id) && !meta.imports.length
          && now() - meta.registeredAt <= maxAgeMs)
        .map(meta => ({ id: meta.id, name: meta.name, hash: meta.hash, file: meta.inspection }));
    },
    list() {
      return Array.from(entries.values())
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .map(meta => ({ ...toStoredEntry(meta), cached: cache.has(cacheKey(meta)) }));
    },
    usage() {
      return { count: entries.size, bytes: totalStoredBytes(), limitBytes: maxTotalBytes };
    },
    clear() {
      for (const id of Array.from(entries.keys())) removeEntry(id);
      saveIndex();
    },
    // 启动时：读索引，与实际文件对账（缺文件的条目删掉、没人引用的文件删掉），再清闲置与超额
    async hydrate() {
      if (!persistent || typeof loadKv !== 'function') return library.usage();
      let raw = null;
      try { raw = await loadKv(MAID_FILE_LIBRARY_KV_NAME); } catch (error) { logger?.warn?.('[maid-file-library] index load failed', error); }
      const stored = Array.isArray(raw?.entries) ? raw.entries : [];
      let onDisk = [];
      try { onDisk = await blobs.list(); } catch (error) { logger?.warn?.('[maid-file-library] blob list failed', error); return library.usage(); }
      const diskHashes = new Set((Array.isArray(onDisk) ? onDisk : []).map(item => trim(item?.hash)));
      const at = now();
      for (const item of stored) {
        const id = trim(item?.id);
        if (!id || entries.has(id) || !isHash(item?.hash) || !diskHashes.has(item.hash)) continue;
        if (at - (Number(item.lastUsedAt) || 0) > maxIdleMs) continue;
        entries.set(id, {
          ...clone(toStoredEntry(item)),
          origin: MAID_FILE_ORIGINS.includes(item.origin) ? item.origin : 'upload',
          persisted: true,
        });
      }
      const live = new Set(Array.from(entries.values()).map(meta => meta.hash));
      const orphans = Array.from(diskHashes).filter(hash => isHash(hash) && !live.has(hash));
      if (orphans.length) enqueue(() => blobs.delete(orphans));
      enforceQuota();
      await saveIndex();
      return library.usage();
    },
    // 等后台存盘与索引写完（测试与退出前用）；任务里可能再排新任务，等到队列不再变化
    async whenIdle() {
      let current;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    },
  };
  return library;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};
const base64ToBytes = text => Uint8Array.from(atob(String(text || '')), char => char.charCodeAt(0));

// Rust maid_file_* 命令的适配：字节以 base64 传输（与 save_attachment_bytes 一致）
export const createMaidFileBlobStore = ({ invoke }) => ({
  put: (hash, bytes) => invoke('maid_file_put', { hash, base64: bytesToBase64(bytes) }),
  get: async hash => base64ToBytes(await invoke('maid_file_get', { hash })),
  delete: hashes => invoke('maid_file_delete', { hashes }),
  list: () => invoke('maid_file_list'),
});
