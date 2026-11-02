// 酒馆助手脚本的持久资料（主线程）：脚本的 localStorage 与 SillyTavern 的 chatMetadata。
// Worker 里各有一份同步读写的内存副本；这里只负责读出与保存。
// - localStorage：跟浏览器一样全局一份（不分会话），存一个 KV；写入批次合并后延迟保存。
// - chatMetadata：每个会话一份，各存一个 KV；会话上只记小引用 { key, sessionId }，
//   删除会话引用就跟着消失（同名新会话不会读到旧资料），改名时 chat store 会更新 sessionId。

export const SCRIPT_LOCAL_STORAGE_KV = 'script_local_storage_v1';
// 键与值的字符总数上限，约等于浏览器 localStorage 的 5MB
export const SCRIPT_LOCAL_STORAGE_LIMIT = 5000000;
export const SCRIPT_CHAT_METADATA_LIMIT = 1200000;
const CHAT_METADATA_KV_PREFIX = 'script_chat_metadata_v1__';

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const countChars = items => Object.entries(items).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
const quotaError = () => Object.assign(new Error('脚本 localStorage 已满'), { name: 'QuotaExceededError', code: 22 });
const defaultId = () => globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)
  || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * loadKv(name) / saveKv(name, data)：KV 读写；getChatStore() → 有 getScriptMetadataRef／setScriptMetadataRef／scopeId 的 chat store。
 */
export const createScriptStoragePersistence = ({
  loadKv,
  saveKv,
  getChatStore = () => null,
  makeId = defaultId,
  saveDelayMs = 400,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = timer => clearTimeout(timer),
} = {}) => {
  let items = null;
  let loading = null;
  let saveTimer = null;
  let dirty = false;
  const metadataByKey = new Map();

  const loadLocalStorage = () => {
    if (items) return Promise.resolve(items);
    loading ||= (async () => {
      let raw = null;
      try { raw = await loadKv(SCRIPT_LOCAL_STORAGE_KV); } catch {}
      const loaded = {};
      if (isPlainObject(raw?.items)) {
        for (const [key, value] of Object.entries(raw.items)) if (typeof value === 'string') loaded[key] = value;
      }
      items ||= loaded;
      return items;
    })();
    return loading;
  };

  const flushLocalStorage = async () => {
    if (saveTimer != null) cancel(saveTimer);
    saveTimer = null;
    if (!dirty || !items) return;
    dirty = false;
    await saveKv(SCRIPT_LOCAL_STORAGE_KV, { version: 1, items: { ...items } });
  };

  /** patch = { clear?, set?: { key: value }, remove?: [key] }，依序：清空 → 删除 → 写入。 */
  const applyLocalStorageWrite = async (patch = {}) => {
    const current = await loadLocalStorage();
    const next = patch.clear === true ? {} : { ...current };
    for (const key of Array.isArray(patch.remove) ? patch.remove : []) delete next[String(key)];
    if (isPlainObject(patch.set)) {
      for (const [key, value] of Object.entries(patch.set)) next[String(key)] = String(value ?? '');
    }
    if (countChars(next) > SCRIPT_LOCAL_STORAGE_LIMIT) throw quotaError();
    items = next;
    dirty = true;
    if (saveTimer != null) cancel(saveTimer);
    saveTimer = schedule(() => flushLocalStorage().catch(() => {}), saveDelayMs);
    return true;
  };

  const metadataRef = (sid) => {
    const ref = getChatStore()?.getScriptMetadataRef?.(sid);
    // 引用必须属于这个会话（复制来的不算），且只指向自己的 KV 前缀
    return ref && ref.sessionId === sid && trim(ref.key).startsWith(CHAT_METADATA_KV_PREFIX) ? ref : null;
  };
  const unsavedKey = sid => `unsaved:${trim(getChatStore()?.scopeId) || 'default'}:${sid}`;

  /** 回传 { key, data }：key 让 Worker 分辨是不是同一份资料（删掉重建的同名会话 key 不同）。 */
  const loadChatMetadata = async (sessionId) => {
    const sid = trim(sessionId);
    if (!sid) return { key: '', data: {} };
    const ref = metadataRef(sid);
    const key = ref ? ref.key : unsavedKey(sid);
    if (!metadataByKey.has(key)) {
      let data = {};
      if (ref) {
        try {
          const raw = await loadKv(ref.key);
          if (isPlainObject(raw?.data)) data = raw.data;
        } catch {}
      }
      if (!metadataByKey.has(key)) metadataByKey.set(key, data);
    }
    return { key, data: metadataByKey.get(key) };
  };

  /** 保存一个会话的 chatMetadata（world_info 是 APP 自己的绑定，不存）；回传资料的 key。 */
  const saveChatMetadata = async (sessionId, data) => {
    const sid = trim(sessionId);
    if (!sid) throw new Error('缺少会话');
    if (!isPlainObject(data)) throw new TypeError('chatMetadata 必须是物件');
    const clean = JSON.parse(JSON.stringify(data));
    delete clean.world_info;
    if (JSON.stringify(clean).length > SCRIPT_CHAT_METADATA_LIMIT) throw new Error('chatMetadata 过大');
    let ref = metadataRef(sid);
    if (!ref) {
      ref = { key: `${CHAT_METADATA_KV_PREFIX}${makeId()}`, sessionId: sid };
      getChatStore()?.setScriptMetadataRef?.(sid, ref);
    }
    await saveKv(ref.key, { version: 1, sessionId: sid, data: clean });
    metadataByKey.set(ref.key, clean);
    return ref.key;
  };

  return {
    loadLocalStorage,
    getLocalStorageSnapshot: async () => ({ ...(await loadLocalStorage()) }),
    applyLocalStorageWrite,
    flushLocalStorage,
    loadChatMetadata,
    saveChatMetadata,
  };
};
