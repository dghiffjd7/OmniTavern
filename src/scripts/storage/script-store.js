import { hasTauriInvoke, safeInvoke } from '../utils/tauri.js';
import { logger } from '../utils/logger.js';
import { t } from '../i18n/index.js';
import { shouldRestoreLegacyExecutableScript } from '../import/mvu-script-classification.js';
import {
  analyzeScriptCompatibility,
  resolveScriptCompatibility,
} from '../import/script-capability-preflight.js';
import { analyzeImportedScripts } from '../import/tavern-feature-report.js';

// 旧版把所有脚本存成一个 KV 档，脚本一多就超过 load_kv/save_kv 的 30MB 上限、存不进去。
// 现在全局、每张角色卡、每个预设各存一个分片，索引记下分片档名；旧档只在没有索引时读一次并迁移，不删除。
const LEGACY_STORE_KEY = 'script_store_v1';
const INDEX_KEY = 'script_store_v2_index';
const ITEM_PREFIX = 'script_store_v2_item';
const STORE_VERSION = 2;
const SHARD_LOAD_CONCURRENCY = 8;
const SAVE_FAILURE_NOTICE_MS = 30000;

const genId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const clone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
};

const readLocalJson = (key) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const writeLocalJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const loadKv = async (name) => {
  try {
    const data = await safeInvoke('load_kv', { name });
    if (data && typeof data === 'object') return data;
  } catch (err) {
    logger.debug('script store load_kv skipped (maybe not tauri)', err);
  }
  return null;
};

const hashKey = (value) => {
  let h = 2166136261;
  const raw = String(value || '');
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

const sanitizeKeySegment = (value, max = 40) => {
  let out = '';
  for (const ch of String(value || '').trim()) {
    out += /^[a-zA-Z0-9_-]$/.test(ch) ? ch : '_';
    if (out.length >= max) break;
  }
  return out.replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'item';
};

const makeItemKey = (scope, id) => `${ITEM_PREFIX}_${scope}_${hashKey(`${scope}:${id}`)}_${sanitizeKeySegment(id)}`;

// 只记签名（长度＋两种杂凑），不在内存里再存一份整包 JSON
const signatureOf = (text) => {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = (Math.imul(b, 33) + code) | 0;
  }
  return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
};

const listBuckets = (state) => [
  { scope: 'global', id: 'global', bucket: state.global },
  ...Object.entries(state.character || {}).map(([id, bucket]) => ({ scope: 'character', id, bucket })),
  ...Object.entries(state.preset || {}).map(([id, bucket]) => ({ scope: 'preset', id, bucket })),
];

const makeItemPayload = (scope, id, bucket) => ({
  version: 1,
  scope,
  id,
  data: { scripts: bucket?.scripts || [], variables: bucket?.variables || {} },
});

const readIndexItems = (raw) => {
  if (!raw || typeof raw !== 'object' || raw._tooLarge || !Array.isArray(raw.items)) return null;
  return raw.items
    .map(item => ({ scope: String(item?.scope || ''), id: String(item?.id || ''), key: String(item?.key || '') }))
    .filter(item => ['global', 'character', 'preset'].includes(item.scope) && item.id && item.key);
};

const readItemPayload = (payload, { scope, id }) => {
  if (!payload || typeof payload !== 'object' || payload._tooLarge) return null;
  if (payload.scope !== scope || payload.id !== id) return null;
  return payload.data && typeof payload.data === 'object' ? payload.data : null;
};

// 同一句提示 30 秒内只跳一次（脚本每次改动都会存档，失败时不要连跳）
const lastSaveFailureNotices = new Map();
const reportSaveFailure = (message, details) => {
  logger.warn('[script-store] save failed', details);
  const now = Date.now();
  if (now - (lastSaveFailureNotices.get(message) || 0) < SAVE_FAILURE_NOTICE_MS) return;
  lastSaveFailureNotices.set(message, now);
  try { globalThis.window?.toastr?.error?.(message); } catch {}
};

// 酒馆助手在脚本配置里声明的按钮：运行时据此绘制，导出预设时原样带回
const normalizeScriptButton = (raw) => {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.buttons)) return null;
  const buttons = raw.buttons
    .map(item => ({ name: String(item?.name || '').trim(), visible: item?.visible !== false }))
    .filter(item => item.name);
  return { enabled: raw.enabled !== false, buttons };
};

const normalizeScript = (raw = {}, overrides = {}) => {
  const base = raw && typeof raw === 'object' ? raw : {};
  const schemaOnly = base.schemaOnly === true;
  const content = String(base.content || '');
  const compatibility = analyzeScriptCompatibility(content);
  const button = normalizeScriptButton(base.button);
  return {
    id: String(base.id || overrides.id || genId('script')),
    name: String(base.name || overrides.name || '未命名脚本').trim() || '未命名脚本',
    content,
    info: String(base.info || ''),
    enabled: base.enabled === true && compatibility.blocked !== true,
    authorized: base.authorized === true && compatibility.blocked !== true,
    schemaOnly,
    schemaOnlyReason: schemaOnly ? String(base.schemaOnlyReason || '') : '',
    data: base.data && typeof base.data === 'object' ? base.data : {},
    createdAt: Number.isFinite(Number(base.createdAt)) ? Number(base.createdAt) : Date.now(),
    updatedAt: Date.now(),
    source: String(base.source || overrides.source || 'user'),
    compatibility,
    ...(button ? { button } : {}),
  };
};

const flattenScriptTrees = (list = []) => {
  const out = [];
  const stack = Array.isArray(list) ? [...list] : [];
  while (stack.length) {
    const item = stack.shift();
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || 'script');
    if (type === 'folder' && Array.isArray(item.scripts)) {
      stack.push(...item.scripts);
      continue;
    }
    out.push(item);
  }
  return out;
};

// 早先导入时没保留按钮声明；预设里还留着原始脚本，按 ID 补回（只读，不写回存储）
export const fillDeclaredScriptButtons = (scripts = [], originals = []) => {
  const declared = new Map();
  flattenScriptTrees(originals).forEach((item) => {
    const id = String(item?.id || '').trim();
    const button = normalizeScriptButton(item?.button);
    if (id && button) declared.set(id, button);
  });
  if (!declared.size) return scripts;
  return scripts.map(script => (script?.button || !declared.has(String(script?.id || ''))
    ? script
    : { ...script, button: declared.get(String(script.id)) }));
};

const makeDefaultState = () => ({
  version: STORE_VERSION,
  global: {
    scripts: [],
    variables: {},
  },
  character: {},
  preset: {},
});

const ensureScopeBucket = (state, scope, scopeId) => {
  if (scope === 'global') return state.global;
  const bucket = scope === 'character' ? state.character : state.preset;
  const key = String(scopeId || '').trim() || 'default';
  if (!bucket[key]) {
    bucket[key] = { scripts: [], variables: {} };
  }
  return bucket[key];
};

const getScopeBucket = (state, scope, scopeId) => {
  if (scope === 'global') return state.global;
  const buckets = scope === 'character' ? state.character : state.preset;
  const key = String(scopeId || '').trim() || 'default';
  return buckets?.[key] || null;
};

const removeEmptyScopeBucket = (state, scope, scopeId) => {
  if (scope === 'global') return false;
  const buckets = scope === 'character' ? state.character : state.preset;
  const key = String(scopeId || '').trim() || 'default';
  const bucket = buckets?.[key];
  if (!bucket) return false;
  const hasScripts = Array.isArray(bucket.scripts) && bucket.scripts.length > 0;
  const hasVariables = bucket.variables && typeof bucket.variables === 'object' && Object.keys(bucket.variables).length > 0;
  if (hasScripts || hasVariables) return false;
  delete buckets[key];
  return true;
};

const emitChanged = (detail) => {
  try {
    window.dispatchEvent(new CustomEvent('scripts-changed', { detail }));
  } catch {}
};

export class ScriptStore {
  constructor() {
    this.state = makeDefaultState();
    this.itemSignatures = new Map();
    this.indexedKeys = new Set();
    this.unloadedItems = new Map();
    this.persistChain = Promise.resolve();
    this.persistBlocked = '';
    this.ready = this.load();
  }

  // 有索引就读分片；读不到的分片留在索引里（不当作已删除），之后存档也不清掉它的档
  // 回传 null：还没迁移（索引档不存在）；{ error }：索引读不出来，不能退回旧档（旧档是迁移前的资料）
  async loadSharded() {
    const raw = await loadKv(INDEX_KEY);
    if (raw === null && hasTauriInvoke()) return { error: 'index_unreadable' };
    if (!raw || !Object.keys(raw).length) return null;
    const items = readIndexItems(raw);
    if (!items) return { error: raw._tooLarge ? 'index_too_large' : 'index_invalid' };
    const loaded = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const at = cursor++;
        loaded[at] = await loadKv(items[at].key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SHARD_LOAD_CONCURRENCY, items.length) }, worker));
    const data = { version: STORE_VERSION, character: {}, preset: {} };
    items.forEach((item, at) => {
      const bucket = readItemPayload(loaded[at], item);
      if (!bucket) {
        this.unloadedItems.set(item.key, item);
        logger.warn('[script-store] shard missing or unreadable; kept in index', { ...item, tooLarge: Boolean(loaded[at]?._tooLarge) });
        return;
      }
      if (item.scope === 'global') data.global = bucket;
      else data[item.scope][item.id] = bucket;
    });
    this.indexedKeys = new Set(items.map(item => item.key));
    return { data };
  }

  // 存档读不出来时不迁移、不存档，免得用空资料或旧资料盖掉
  blockPersist(reason) {
    this.persistBlocked = reason;
    this.state = makeDefaultState();
    reportSaveFailure(t('脚本存档读不出来；为免覆盖，这次脚本的改动不会存档'), { reason });
  }

  async load() {
    const sharded = await this.loadSharded();
    if (sharded?.error) return this.blockPersist(sharded.error);
    let data = sharded?.data || null;
    const fromShards = Boolean(data);
    if (!data) {
      const kv = await loadKv(LEGACY_STORE_KEY);
      // load_kv 档案不存在回 {}，读取出错回 null
      if (kv?._tooLarge) return this.blockPersist('legacy_too_large');
      if (kv === null && hasTauriInvoke()) return this.blockPersist('legacy_unreadable');
      data = kv && typeof kv === 'object' && Object.keys(kv).length ? kv : readLocalJson(LEGACY_STORE_KEY);
    }
    if (!data || typeof data !== 'object') data = {};
    const next = makeDefaultState();
    if (data.global && typeof data.global === 'object') {
      next.global.scripts = Array.isArray(data.global.scripts) ? data.global.scripts.map(s => normalizeScript(s)) : [];
      next.global.variables = data.global.variables && typeof data.global.variables === 'object' ? data.global.variables : {};
    }
    const normalizeBuckets = (target, source) => {
      if (!source || typeof source !== 'object') return;
      Object.entries(source).forEach(([id, bucket]) => {
        const scoped = bucket && typeof bucket === 'object' ? bucket : {};
        target[id] = {
          scripts: Array.isArray(scoped.scripts) ? scoped.scripts.map(s => normalizeScript(s)) : [],
          variables: scoped.variables && typeof scoped.variables === 'object' ? scoped.variables : {},
        };
      });
    };
    normalizeBuckets(next.character, data.character);
    normalizeBuckets(next.preset, data.preset);
    const storedVersion = Math.max(1, Number(data.version) || 1);
    let restoredLegacyScripts = 0;
    if (storedVersion < STORE_VERSION) {
      const restoreBucket = (bucket) => {
        (bucket?.scripts || []).forEach((script) => {
          if (!shouldRestoreLegacyExecutableScript(script)) return;
          script.schemaOnly = false;
          script.schemaOnlyReason = '';
          restoredLegacyScripts += 1;
        });
      };
      restoreBucket(next.global);
      Object.values(next.character || {}).forEach(restoreBucket);
      Object.values(next.preset || {}).forEach(restoreBucket);
    }
    next.version = STORE_VERSION;
    this.state = next;
    if (restoredLegacyScripts > 0) {
      logger.info(`[script-store] restored ${restoredLegacyScripts} executable card scripts from legacy schemaOnly flags`);
    }
    if (fromShards) {
      // 读入时会整理脚本栏位；以整理后的内容为已存基准，没改动就不重写分片
      listBuckets(this.state).forEach(({ scope, id, bucket }) => {
        const key = makeItemKey(scope, id);
        if (this.indexedKeys.has(key)) this.itemSignatures.set(key, signatureOf(JSON.stringify(makeItemPayload(scope, id, bucket))));
      });
      return;
    }
    await this.persist({ notifyScriptsChanged: false, migration: true });
  }

  persist(options = {}) {
    const run = this.persistChain.then(() => this.persistNow(options));
    this.persistChain = run.catch(() => {});
    return run;
  }

  async persistNow({ notifyScriptsChanged = true, migration = false } = {}) {
    try {
      if (this.persistBlocked) {
        reportSaveFailure(t('脚本存档读不出来；为免覆盖，这次脚本的改动不会存档'), { reason: this.persistBlocked });
        return false;
      }
      if (!hasTauriInvoke()) return writeLocalJson(LEGACY_STORE_KEY, clone(this.state));
      const failures = [];
      const indexItems = [];
      for (const { scope, id, bucket } of listBuckets(this.state)) {
        const key = makeItemKey(scope, id);
        indexItems.push({ scope, id, key });
        const payload = makeItemPayload(scope, id, bucket);
        const signature = signatureOf(JSON.stringify(payload));
        if (this.itemSignatures.get(key) === signature) continue;
        try {
          await safeInvoke('save_kv', { name: key, data: payload, compact: true });
          this.itemSignatures.set(key, signature);
        } catch (err) {
          failures.push({ scope, id, error: String(err?.message || err) });
        }
      }
      // 迁移时有分片没写成就不写索引，下次开机仍从旧档读
      if (migration && failures.length) {
        reportSaveFailure(t('脚本存档迁移没有完成，下次打开 APP 会再试：{reason}', { reason: failures[0].error }), failures);
        return false;
      }
      const keys = new Set(indexItems.map(item => item.key));
      this.unloadedItems.forEach((item, key) => { if (!keys.has(key)) { indexItems.push(item); keys.add(key); } });
      try {
        await safeInvoke('save_kv', { name: INDEX_KEY, data: { version: 1, storeVersion: STORE_VERSION, items: indexItems, savedAt: Date.now() } });
      } catch (err) {
        failures.push({ scope: 'index', id: INDEX_KEY, error: String(err?.message || err) });
        reportSaveFailure(t('脚本没能存档，重开 APP 后这次的改动会不见：{reason}', { reason: failures[0].error }), failures);
        return false;
      }
      for (const key of this.indexedKeys) {
        if (keys.has(key)) continue;
        try {
          await safeInvoke('save_kv', { name: key, data: null });
          this.itemSignatures.delete(key);
        } catch (err) {
          logger.debug('[script-store] stale shard cleanup failed', { key, err });
        }
      }
      this.indexedKeys = keys;
      if (failures.length) {
        reportSaveFailure(t('脚本没能存档，重开 APP 后这次的改动会不见：{reason}', { reason: failures[0].error }), failures);
        return false;
      }
      return true;
    } finally {
      if (notifyScriptsChanged) emitChanged({});
    }
  }

  getScripts(scope = 'global', scopeId = '') {
    const bucket = getScopeBucket(this.state, scope, scopeId);
    return Array.isArray(bucket?.scripts) ? bucket.scripts.map(s => clone(s)) : [];
  }

  getScopeVariables(scope = 'global', scopeId = '') {
    const bucket = getScopeBucket(this.state, scope, scopeId);
    return bucket?.variables && typeof bucket.variables === 'object' ? clone(bucket.variables) : {};
  }

  listScopes() {
    return {
      character: Object.keys(this.state.character || {}),
      preset: Object.keys(this.state.preset || {}),
    };
  }

  async setScripts(scope = 'global', scopeId = '', scripts = []) {
    const bucket = ensureScopeBucket(this.state, scope, scopeId);
    bucket.scripts = Array.isArray(scripts) ? scripts.map(s => normalizeScript(s)) : [];
    removeEmptyScopeBucket(this.state, scope, scopeId);
    await this.persist();
    return true;
  }

  async setScopeVariables(scope = 'global', scopeId = '', variables = {}) {
    const bucket = ensureScopeBucket(this.state, scope, scopeId);
    bucket.variables = variables && typeof variables === 'object' && !Array.isArray(variables)
      ? clone(variables)
      : {};
    removeEmptyScopeBucket(this.state, scope, scopeId);
    await this.persist({ notifyScriptsChanged: false });
    return true;
  }

  async removeScope(scope = 'global', scopeId = '') {
    if (scope === 'global') return false;
    const buckets = scope === 'character' ? this.state.character : this.state.preset;
    const key = String(scopeId || '').trim() || 'default';
    if (!buckets?.[key]) return false;
    delete buckets[key];
    await this.persist();
    return true;
  }

  async upsertScript(scope = 'global', scopeId = '', script = {}, { source = 'user', authorized = true } = {}) {
    const bucket = ensureScopeBucket(this.state, scope, scopeId);
    const normalized = normalizeScript({ ...script, source, authorized });
    const idx = bucket.scripts.findIndex(s => s.id === normalized.id);
    if (idx >= 0) bucket.scripts[idx] = normalized;
    else bucket.scripts.push(normalized);
    await this.persist();
    return normalized.id;
  }

  async toggleScript(scope = 'global', scopeId = '', scriptId = '', enabled = false) {
    const bucket = getScopeBucket(this.state, scope, scopeId);
    if (!bucket) return false;
    const item = bucket.scripts.find(s => s.id === scriptId);
    if (!item) return false;
    item.compatibility = resolveScriptCompatibility(item);
    if (enabled && item.compatibility.blocked === true) {
      item.enabled = false;
      item.authorized = false;
      item.updatedAt = Date.now();
      await this.persist();
      return false;
    }
    item.enabled = Boolean(enabled);
    if (item.enabled) item.authorized = true;
    item.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async updateScript(scope = 'global', scopeId = '', scriptId = '', patch = {}) {
    const bucket = getScopeBucket(this.state, scope, scopeId);
    if (!bucket) return false;
    const idx = bucket.scripts.findIndex(s => s.id === scriptId);
    if (idx === -1) return false;
    const next = normalizeScript({ ...bucket.scripts[idx], ...patch });
    bucket.scripts[idx] = next;
    await this.persist();
    return true;
  }

  async updateScriptData(scope = 'global', scopeId = '', scriptId = '', data = {}) {
    const bucket = getScopeBucket(this.state, scope, scopeId);
    if (!bucket) return false;
    const item = bucket.scripts.find(s => s.id === scriptId);
    if (!item) return false;
    item.data = data && typeof data === 'object' ? data : {};
    item.updatedAt = Date.now();
    await this.persist({ notifyScriptsChanged: false });
    return true;
  }

  async deleteScript(scope = 'global', scopeId = '', scriptId = '') {
    const bucket = getScopeBucket(this.state, scope, scopeId);
    if (!bucket) return false;
    const prev = bucket.scripts.length;
    bucket.scripts = bucket.scripts.filter(s => s.id !== scriptId);
    if (bucket.scripts.length === prev) return false;
    removeEmptyScopeBucket(this.state, scope, scopeId);
    await this.persist();
    return true;
  }

  getActiveScripts({ personaId = '', presetId = '' } = {}) {
    const out = [];
    const push = (scope, scopeId, list) => {
      (list || []).forEach(s => {
        if (!s || s.enabled !== true || s.authorized !== true) return;
        const compatibility = resolveScriptCompatibility(s);
        if (compatibility.blocked === true) return;
        out.push({ ...clone(s), compatibility, scope, scopeId });
      });
    };
    push('global', 'global', this.state.global?.scripts || []);
    if (personaId) {
      const bucket = this.state.character?.[personaId];
      if (bucket?.scripts) push('character', personaId, bucket.scripts);
    }
    if (presetId) {
      const bucket = this.state.preset?.[presetId];
      if (bucket?.scripts) push('preset', presetId, bucket.scripts);
    }
    return out;
  }

  async importTavernHelperScripts({ scripts = [], scope = 'character', scopeId = '', source = 'card' } = {}) {
    const bucket = ensureScopeBucket(this.state, scope, scopeId);
    const incoming = flattenScriptTrees(scripts).map((item) => {
      const normalized = normalizeScript(item, { source });
      normalized.enabled = false;
      normalized.authorized = false;
      return normalized;
    });
    if (!incoming.length) {
      return {
        count: 0,
        ids: [],
        runnableIds: [],
        blockedIds: [],
        compatibility: { runnableCount: 0, blockedCount: 0, blocked: [] },
        tavernFeatures: analyzeImportedScripts([]),
      };
    }
    const existingIds = new Set(bucket.scripts.map(s => s.id));
    incoming.forEach(s => {
      if (existingIds.has(s.id)) {
        s.id = genId('script');
      }
      bucket.scripts.push(s);
    });
    await this.persist();
    const blocked = incoming.filter(script => script.compatibility?.blocked === true);
    const runnable = incoming.filter(script => script.compatibility?.blocked !== true);
    return {
      count: incoming.length,
      ids: incoming.map(s => s.id),
      runnableIds: runnable.map(s => s.id),
      blockedIds: blocked.map(s => s.id),
      compatibility: {
        runnableCount: runnable.length,
        blockedCount: blocked.length,
        blocked: blocked.map(script => ({
          id: script.id,
          name: script.name,
          level: script.compatibility.level,
          reasons: [...script.compatibility.reasons],
          fingerprint: script.compatibility.fingerprint,
          message: script.compatibility.message,
        })),
      },
      // 导入兼容报告：可运行脚本用到的酒馆功能与支持情况（导入完成提示用）
      tavernFeatures: analyzeImportedScripts(runnable),
    };
  }
}
