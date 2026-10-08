import { logger } from '../utils/logger.js';
import { safeInvoke } from '../utils/tauri.js';
import { resolveLegacyStateTie } from './legacy-state-tie-utils.js';
import { makeScopedKey, normalizeScopeId } from './store-scope.js';

const BASE_STORE_KEY = 'rp_session_v1';
const LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT = 160_000;
const LOCAL_MIGRATION_YIELD_EVERY = 12;
const KV_LOAD_RETRY_DELAYS = [40, 120];
const LEGACY_TIE_BACKUP_SUFFIX = '__legacy_tie_backup_v1';

const getTauriInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return g?.__TAURI__?.core?.invoke
    || g?.__TAURI__?.invoke
    || g?.__TAURI_INVOKE__
    || g?.__TAURI_INTERNALS__?.invoke;
};

const serializeState = state => {
  try {
    return JSON.stringify(state);
  } catch {
    return '';
  }
};

const isPlainRecord = value => Boolean(
  value
  && typeof value === 'object'
  && !Array.isArray(value)
);

const hasRpStateShape = value => Boolean(
  isPlainRecord(value)
  && !value._tooLarge
  && (
    Object.prototype.hasOwnProperty.call(value, 'greetings')
    || Object.prototype.hasOwnProperty.call(value, 'activeGreetingId')
    || Object.prototype.hasOwnProperty.call(value, 'syncEvents')
  )
);

const readLocalStateUnbounded = key => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const stableSortObject = value => {
  if (Array.isArray(value)) return value.map(stableSortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stableSortObject(value[key]);
    return acc;
  }, {});
};

const canonicalJson = value => JSON.stringify(stableSortObject(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const loadKvWithRetry = async key => {
  let lastError = null;
  for (let attempt = 0; attempt <= KV_LOAD_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await safeInvoke('load_kv', { name: key });
    } catch (err) {
      lastError = err;
      if (attempt < KV_LOAD_RETRY_DELAYS.length) await wait(KV_LOAD_RETRY_DELAYS[attempt]);
    }
  }
  throw lastError || new Error('rp session load_kv failed');
};

const scheduleIdle = runner => {
  if (typeof runner !== 'function') return;
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    if (typeof g?.requestIdleCallback === 'function') {
      g.requestIdleCallback(() => runner(), { timeout: 1_500 });
      return;
    }
  } catch {}
  setTimeout(() => runner(), 600);
};

const normalizeGreeting = (item, idx = 0) => {
  const raw = item && typeof item === 'object' ? item : {};
  const id = String(raw.id || '').trim() || `greeting_${idx + 1}`;
  const content = String(raw.content || raw.text || '').trim();
  const title = String(raw.title || raw.name || '').trim();
  return { id, content, title };
};

const normalizeState = (input = {}) => {
  const raw = input && typeof input === 'object' ? input : {};
  const greetingsRaw = Array.isArray(raw.greetings) ? raw.greetings : [];
  const greetings = greetingsRaw.map(normalizeGreeting).filter(g => g.content);
  const activeGreetingId = String(raw.activeGreetingId || '').trim();
  const syncEvents = Array.isArray(raw.syncEvents) ? raw.syncEvents : [];
  return {
    greetings,
    activeGreetingId,
    syncEvents,
    updatedAt: Number(raw.updatedAt || 0) || 0,
  };
};

const isRpStateEmpty = state => (
  !Array.isArray(state?.greetings) || state.greetings.length === 0
) && (
  !Array.isArray(state?.syncEvents) || state.syncEvents.length === 0
) && !String(state?.activeGreetingId || '').trim();

const resolveRpLegacyTieOnDisk = async ({ key, localState, kvState }) => {
  const decision = resolveLegacyStateTie({
    local: localState,
    kv: kvState,
    isEmpty: isRpStateEmpty,
  });
  if (decision.action === 'keep_blocked') {
    return { resolved: false, state: localState, adopted: '', backedUp: false };
  }
  if (decision.action === 'adopt_kv') {
    return { resolved: true, state: kvState, adopted: 'kv', backedUp: false };
  }
  if (decision.backupRequired) {
    await safeInvoke('save_kv', {
      name: `${key}${LEGACY_TIE_BACKUP_SUFFIX}`,
      data: {
        local: localState,
        kv: kvState,
        resolvedAt: Date.now(),
      },
    });
  }
  await safeInvoke('save_kv', { name: key, data: localState });
  return {
    resolved: true,
    state: localState,
    adopted: 'local',
    backedUp: decision.backupRequired,
  };
};

const listLocalRpKeys = () => {
  const storage = globalThis?.localStorage;
  const length = Number(storage?.length || 0);
  if (!storage || !Number.isFinite(length) || length <= 0 || typeof storage.key !== 'function') return [];
  const keys = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(storage.key(index) || '');
    if (key === BASE_STORE_KEY || key.startsWith(`${BASE_STORE_KEY}__`)) keys.push(key);
  }
  return keys;
};

export const migrateRpSessionLocalMirrors = async () => {
  const result = {
    scanned: 0,
    removed: 0,
    backfilled: 0,
    retained: 0,
  };
  if (typeof getTauriInvoker() !== 'function') return result;

  const storage = globalThis?.localStorage;
  const keys = listLocalRpKeys();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    result.scanned += 1;
    const localState = readLocalStateUnbounded(key);
    if (!hasRpStateShape(localState)) {
      result.retained += 1;
      continue;
    }

    let kv = null;
    try {
      kv = await safeInvoke('load_kv', { name: key });
    } catch (err) {
      logger.debug('rp session local migration read skipped', { key, error: err });
      result.retained += 1;
      continue;
    }

    if (hasRpStateShape(kv)) {
      const normalizedKv = normalizeState(kv);
      const normalizedLocal = normalizeState(localState);
      if (canonicalJson(normalizedKv) !== canonicalJson(normalizedLocal)) {
        try {
          const resolution = await resolveRpLegacyTieOnDisk({
            key,
            localState: normalizedLocal,
            kvState: normalizedKv,
          });
          if (!resolution.resolved) {
            logger.warn('rp session local/KV conflict retained for recovery', { key });
            result.retained += 1;
            continue;
          }
          logger.info('rp session legacy tie resolved during local migration', {
            key,
            adopted: resolution.adopted,
            backedUp: resolution.backedUp,
          });
        } catch (err) {
          logger.warn('rp session legacy tie migration failed; mirror retained', { key, error: err });
          result.retained += 1;
          continue;
        }
      }
    } else if (isPlainRecord(kv) && !Object.keys(kv).length) {
      try {
        await safeInvoke('save_kv', { name: key, data: normalizeState(localState) });
        result.backfilled += 1;
      } catch (err) {
        logger.debug('rp session local migration backfill skipped', { key, error: err });
        result.retained += 1;
        continue;
      }
    } else {
      result.retained += 1;
      continue;
    }

    try {
      storage?.removeItem?.(key);
      result.removed += 1;
    } catch {
      result.retained += 1;
    }

    if ((index + 1) % LOCAL_MIGRATION_YIELD_EVERY === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return result;
};

let localRpMigrationScheduled = false;
const scheduleRpSessionLocalMigration = () => {
  if (localRpMigrationScheduled || typeof getTauriInvoker() !== 'function') return;
  localRpMigrationScheduled = true;
  scheduleIdle(async () => {
    try {
      const result = await migrateRpSessionLocalMirrors();
      if (result.scanned) logger.info('rp session local migration complete', result);
    } catch (err) {
      logger.warn('rp session local migration failed', err);
    }
  });
};

export class RpSessionStore {
  constructor({ scopeId = '' } = {}) {
    this.scopeId = normalizeScopeId(scopeId);
    this.storeKey = makeScopedKey(BASE_STORE_KEY, this.scopeId);
    this._scopeToken = 0;
    this.persistenceBlocked = typeof getTauriInvoker() === 'function';
    this.state = normalizeState(this._load());
    this.ready = this._hydrateFromDisk();
    scheduleRpSessionLocalMigration();
  }

  _load() {
    try {
      const raw = localStorage.getItem(this.storeKey);
      if (typeof raw === 'string' && raw.length > LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT) {
        logger.warn('rp session store local bootstrap skipped: oversized localStorage snapshot', {
          key: this.storeKey,
          size: raw.length,
          limit: LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT,
        });
        return {};
      }
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  async _hydrateFromDisk() {
    const token = this._scopeToken;
    const storeKey = this.storeKey;
    const scopeId = this.scopeId;
    const expectsKv = typeof getTauriInvoker() === 'function';
    if (!expectsKv) {
      this.persistenceBlocked = false;
      return;
    }
    const localState = readLocalStateUnbounded(storeKey);
    try {
      const kv = await loadKvWithRetry(storeKey);
      if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
      if (hasRpStateShape(kv)) {
        const normalizedKv = normalizeState(kv);
        const normalizedLocal = hasRpStateShape(localState) ? normalizeState(localState) : null;
        const statesMatch = normalizedLocal
          && canonicalJson(normalizedLocal) === canonicalJson(normalizedKv);
        if (normalizedLocal && normalizedLocal.updatedAt === normalizedKv.updatedAt && !statesMatch) {
          this.state = normalizedLocal;
          try {
            const resolution = await resolveRpLegacyTieOnDisk({
              key: storeKey,
              localState: normalizedLocal,
              kvState: normalizedKv,
            });
            if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
            if (!resolution.resolved) {
              this.persistenceBlocked = true;
              logger.warn('rp session local/KV timestamps tie with different content; writes blocked', { key: storeKey });
            } else {
              this.state = resolution.state;
              this.persistenceBlocked = false;
              try { localStorage.removeItem(storeKey); } catch {}
              logger.info('rp session legacy tie resolved', {
                key: storeKey,
                adopted: resolution.adopted,
                backedUp: resolution.backedUp,
              });
            }
          } catch (err) {
            if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
            this.persistenceBlocked = true;
            logger.warn('rp session legacy tie recovery failed; mirror retained and writes blocked', {
              key: storeKey,
              error: err,
            });
          }
        } else if (normalizedLocal && normalizedLocal.updatedAt > normalizedKv.updatedAt) {
          try {
            await safeInvoke('save_kv', { name: storeKey, data: normalizedLocal });
            this.state = normalizedLocal;
            this.persistenceBlocked = false;
            try { localStorage.removeItem(storeKey); } catch {}
          } catch (err) {
            this.state = normalizedLocal;
            this.persistenceBlocked = true;
            logger.warn('rp session newer local recovery could not reach KV; mirror retained and writes blocked', {
              key: storeKey,
              error: err,
            });
          }
        } else {
          this.state = normalizedKv;
          this.persistenceBlocked = false;
          try { localStorage.removeItem(storeKey); } catch {}
        }
      } else if (isPlainRecord(kv) && !Object.keys(kv).length) {
        if (hasRpStateShape(localState)) {
          const normalizedLocal = normalizeState(localState);
          this.state = normalizedLocal;
          try {
            await safeInvoke('save_kv', { name: storeKey, data: normalizedLocal });
            this.persistenceBlocked = false;
            try { localStorage.removeItem(storeKey); } catch {}
          } catch (err) {
            this.persistenceBlocked = true;
            logger.warn('rp session local recovery could not reach KV; mirror retained and writes blocked', {
              key: storeKey,
              error: err,
            });
          }
        } else {
          this.state = normalizeState({});
          this.persistenceBlocked = false;
          try { localStorage.removeItem(storeKey); } catch {}
        }
      } else {
        this.persistenceBlocked = true;
        logger.warn('rp session KV payload is uncertain; writes blocked', { key: storeKey });
      }
    } catch (err) {
      if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
      this.persistenceBlocked = true;
      logger.warn('rp session KV read failed; writes blocked', { key: storeKey, error: err });
    }
  }

  assertWritable() {
    if (!this.persistenceBlocked) return;
    const error = new Error('角色扮演会话暂时无法读取，已阻止写入以保护现有数据。请重新载入 APP 后重试。');
    error.code = 'rp_session_store_read_unavailable';
    throw error;
  }

  _persist() {
    this.assertWritable();
    const payload = normalizeState(this.state);
    payload.updatedAt = Date.now();
    this.state = payload;
    const storeKey = this.storeKey;
    const serialized = serializeState(payload);
    const expectsKv = typeof getTauriInvoker() === 'function';

    if (!expectsKv) {
      try {
        localStorage.setItem(storeKey, serialized);
      } catch {}
      return Promise.resolve(false);
    }

    const persistPromise = safeInvoke('save_kv', { name: storeKey, data: payload })
      .then(() => {
        try { localStorage.removeItem(storeKey); } catch {}
        return true;
      })
      .catch((err) => {
        try { localStorage.setItem(storeKey, serialized); } catch {}
        logger.debug('rp session store save_kv failed; retained local fallback', err);
        return false;
      });
    this._lastPersistPromise = persistPromise;
    return persistPromise;
  }

  async setScope(scopeId = '') {
    const nextScope = normalizeScopeId(scopeId);
    if (nextScope === this.scopeId) return this.ready;
    this._scopeToken += 1;
    this.scopeId = nextScope;
    this.storeKey = makeScopedKey(BASE_STORE_KEY, this.scopeId);
    this.persistenceBlocked = typeof getTauriInvoker() === 'function';
    this.state = normalizeState(this._load());
    this.ready = this._hydrateFromDisk();
    return this.ready;
  }

  // 等待最近一次写入落盘（导入时写入非当前角色卡的作用域后使用）
  whenPersisted() {
    return this._lastPersistPromise || Promise.resolve();
  }

  getGreetings() {
    return Array.isArray(this.state.greetings) ? [...this.state.greetings] : [];
  }

  setGreetings(list = [], { activeId = '' } = {}) {
    this.assertWritable();
    const greetings = Array.isArray(list) ? list.map(normalizeGreeting).filter(g => g.content) : [];
    this.state.greetings = greetings;
    const nextActive = String(activeId || this.state.activeGreetingId || '').trim();
    this.state.activeGreetingId = greetings.some(g => g.id === nextActive) ? nextActive : (greetings[0]?.id || '');
    this._persist();
    return this.state.activeGreetingId;
  }

  getActiveGreetingId() {
    return String(this.state.activeGreetingId || '').trim();
  }

  setActiveGreeting(id) {
    const next = String(id || '').trim();
    if (!next) return '';
    const list = this.getGreetings();
    if (!list.some(g => g.id === next)) return '';
    this.assertWritable();
    this.state.activeGreetingId = next;
    this._persist();
    return next;
  }

  async flush() {
    this.assertWritable();
    return this._persist();
  }

  getActiveGreeting() {
    const list = this.getGreetings();
    const id = this.getActiveGreetingId();
    return list.find(g => g.id === id) || list[0] || null;
  }
}
