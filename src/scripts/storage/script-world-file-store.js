import { safeInvoke } from '../utils/tauri.js';

// 脚本经酒馆接口 /api/worldinfo/edit 整本写入世界书时交来的原始文件（酒馆格式），以及文件顶层的 extensions。
// 只给酒馆接口读回用：APP 那本书写入之后没被改过，worldinfo/get 就原样交还脚本写的内容。
// 存在独立的 KV、不放进世界书资料本身，所以不会进提示词，也不会跟着世界书导出或体验包带出去
// （全量资料备份会整个资料夹打包，会包含这些 KV）。
// 索引 KV：{ version: 1, records: { [世界书名称]: { key, createdAt, fingerprint, fileChars, extensionsChars, savedAt } } }
// 每本一个 KV（key）：{ name, extensions, file }；file 为 null 表示原始内容没存（超过上限或被挤掉）
export const SCRIPT_WORLD_FILE_INDEX_KEY = 'script_world_files_v1';
const RECORD_KEY_PREFIX = 'script_world_file_v1__';
const VERSION = 1;
// 字数按 JSON 字串长度算：单本原始内容超过 fileChars 不存；全部合计超过 totalChars 时先挤掉最早存的原始内容
export const SCRIPT_WORLD_FILE_LIMITS = Object.freeze({ fileChars: 1_500_000, totalChars: 4_000_000 });

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clonePlain = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
const jsonChars = value => (value == null ? 0 : JSON.stringify(value).length);
const count = value => Math.max(0, Math.trunc(Number(value) || 0));

const sha256 = async (text) => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};
// APP 世界书条目的指纹：写入时记下，读回时比对，不同就表示 APP 或用户之后改过这本书
export const fingerprintWorldEntries = async entries => 'sha256:' + await sha256(JSON.stringify(Array.isArray(entries) ? entries : []));

const normalizeIndex = (value) => {
  const records = {};
  Object.entries(isPlainObject(value?.records) ? value.records : {}).forEach(([name, raw]) => {
    const key = String(raw?.key || '');
    if (!name || !key.startsWith(RECORD_KEY_PREFIX)) return;
    records[name] = {
      key,
      createdAt: count(raw.createdAt),
      fingerprint: String(raw.fingerprint || ''),
      fileChars: count(raw.fileChars),
      extensionsChars: count(raw.extensionsChars),
      savedAt: count(raw.savedAt),
    };
  });
  return { version: VERSION, records };
};

export const createScriptWorldFileStore = ({
  loadKv = name => safeInvoke('load_kv', { name }),
  saveKv = (name, data) => safeInvoke('save_kv', { name, data, compact: true }),
  limits = SCRIPT_WORLD_FILE_LIMITS,
  now = () => Date.now(),
} = {}) => {
  let index = null;
  let loading = null;
  const bodies = new Map();
  let queue = Promise.resolve();
  // 依序写入，后写的不会被先写但较慢的盖掉
  const serial = task => (queue = queue.catch(() => {}).then(task));

  const ready = () => {
    if (index) return Promise.resolve(index);
    loading ||= Promise.resolve()
      .then(() => loadKv(SCRIPT_WORLD_FILE_INDEX_KEY))
      .catch(() => null)
      .then((raw) => {
        index ||= normalizeIndex(isPlainObject(raw) && !raw._tooLarge ? raw : {});
        return index;
      });
    return loading;
  };
  const loadBody = async (name) => {
    const meta = index.records[name];
    if (!meta) return null;
    if (bodies.has(name)) return bodies.get(name);
    const raw = await Promise.resolve().then(() => loadKv(meta.key)).catch(() => null);
    const body = isPlainObject(raw) && raw.name === name
      ? { extensions: isPlainObject(raw.extensions) ? raw.extensions : null, file: isPlainObject(raw.file) ? raw.file : null }
      : { extensions: null, file: null };
    bodies.set(name, body);
    return body;
  };
  const saveBody = async (name, body) => {
    bodies.set(name, body);
    await saveKv(index.records[name].key, { name, ...body });
  };
  const saveIndex = () => saveKv(SCRIPT_WORLD_FILE_INDEX_KEY, clonePlain(index));
  const recordKey = async name => RECORD_KEY_PREFIX + (await sha256(name)).slice(0, 24);

  return {
    async names() {
      return Object.keys((await ready()).records);
    },
    // 只看索引，不载入内容：{ createdAt, fingerprint } | null
    async info(name) {
      const meta = (await ready()).records[name];
      return meta ? { createdAt: meta.createdAt, fingerprint: meta.fingerprint } : null;
    },
    // { createdAt, fingerprint, extensions, file } | null
    async get(name) {
      await ready();
      const meta = index.records[name];
      if (!meta) return null;
      const body = await loadBody(name);
      return { createdAt: meta.createdAt, fingerprint: meta.fingerprint, extensions: body.extensions, file: body.file };
    },
    // 记下脚本写入的原始文件；回 { storedFile }：原始内容超过上限时只记 extensions
    put(name, { createdAt = 0, fingerprint = '', extensions = null, file = null } = {}) {
      return serial(async () => {
        await ready();
        const ext = isPlainObject(extensions) && jsonChars(extensions) <= limits.fileChars ? clonePlain(extensions) : null;
        let body = isPlainObject(file) && jsonChars(file) <= limits.fileChars ? clonePlain(file) : null;
        const extensionsChars = jsonChars(ext);
        let fileChars = jsonChars(body);
        // 合计超过上限：从最早存的开始挤掉别本的原始内容（extensions 留着），还不够就这本也不存
        const others = Object.entries(index.records).filter(([other]) => other !== name);
        let total = others.reduce((sum, [, meta]) => sum + meta.fileChars + meta.extensionsChars, 0) + extensionsChars + fileChars;
        const oldest = others.filter(([, meta]) => meta.fileChars > 0).sort((a, b) => a[1].savedAt - b[1].savedAt);
        for (const [other, meta] of oldest) {
          if (total <= limits.totalChars) break;
          const otherBody = await loadBody(other);
          total -= meta.fileChars;
          meta.fileChars = 0;
          await saveBody(other, { ...otherBody, file: null });
        }
        if (total > limits.totalChars) {
          body = null;
          fileChars = 0;
        }
        index.records[name] = {
          key: index.records[name]?.key || await recordKey(name),
          createdAt: count(createdAt),
          fingerprint: String(fingerprint || ''),
          fileChars,
          extensionsChars,
          savedAt: now(),
        };
        await saveBody(name, { extensions: ext, file: body });
        await saveIndex();
        return { storedFile: Boolean(body) };
      });
    },
    // 世界书删掉或换成别本（建立时间不同）时清掉；KV 没有删除命令，写成空物件
    remove(name) {
      return serial(async () => {
        await ready();
        const meta = index.records[name];
        if (!meta) return false;
        delete index.records[name];
        bodies.delete(name);
        await saveKv(meta.key, {});
        await saveIndex();
        return true;
      });
    },
  };
};

// 酒馆接口读回用：按 APP 世界书现况判断存下的内容还算不算数
// getCreatedAt(name) => 世界书的建立时间（数字），书不存在时回 null
export const createScriptWorldFiles = ({ store, getCreatedAt, fingerprint = fingerprintWorldEntries }) => {
  // getCreatedAt：书在时回建立时间，确定不存在回 null，世界书索引读不到（空的）时回 undefined＝不确定
  const bookState = async (name, record) => {
    const createdAt = await getCreatedAt(name);
    if (createdAt === undefined) return 'unknown';
    return createdAt !== null && count(createdAt) === record.createdAt ? 'same' : 'changed';
  };
  const sameBook = async (name, record) => (await bookState(name, record)) === 'same';
  return {
    // 各书存下的顶层 extensions；顺便清掉已删除或换成别本的书的记录
    async extensionsFor(names = []) {
      const wanted = new Set(names);
      const output = {};
      try {
        for (const name of await store.names()) {
          const info = await store.info(name);
          const state = info ? await bookState(name, info) : 'changed';
          // 索引读不到时不清理：世界书 store 读取失败时不能把所有记录当成书已删除
          if (state === 'unknown') continue;
          if (state === 'changed') {
            await store.remove(name);
            continue;
          }
          if (!wanted.has(name)) continue;
          const record = await store.get(name);
          if (record?.extensions) output[name] = clonePlain(record.extensions);
        }
      } catch {}
      return output;
    },
    // 脚本写入之后 APP 没改过这本书（同一本、条目指纹相同）才回原始文件，否则回 null 改用转换后的格式
    async fileFor(name, world) {
      try {
        const record = await store.get(name);
        if (!record?.file || !await sameBook(name, record)) return null;
        if (await fingerprint(world?.entries) !== record.fingerprint) return null;
        return clonePlain(record.file);
      } catch {
        return null;
      }
    },
    // 写入成功后记下：savedEntries 是 APP 实际存下的条目（转换后），file 是脚本交来的原始文件
    async remember({ name, file, savedEntries }) {
      try {
        const createdAt = await getCreatedAt(name);
        if (createdAt === null || createdAt === undefined) return { storedFile: false };
        return await store.put(name, {
          createdAt,
          fingerprint: await fingerprint(savedEntries),
          extensions: isPlainObject(file?.extensions) ? file.extensions : null,
          file,
        });
      } catch {
        return { storedFile: false };
      }
    },
  };
};

let sharedStore = null;
export const getScriptWorldFileStore = () => {
  sharedStore ||= createScriptWorldFileStore();
  return sharedStore;
};
