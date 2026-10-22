import { logger } from '../utils/logger.js';
import { safeInvoke } from '../utils/tauri.js';
import { makeScopedKey, normalizeScopeId } from './store-scope.js';

const BASE_STORE_KEY = 'turn_checkpoint_v1';
// localStorage 镜像仅作启动缓存（kv 为权威）；镜像键会按会话累积，
// 真机曾把 5MB 配额占满导致所有纯 localStorage 写入静默失败，故压低单键上限。
const LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT = 64_000;
const MAX_BRANCH_TEXT_CHARS = 220_000;
const COMPACT_RECENT_TURNS = 30;
const ALLOWED_CHECKPOINT_STATES = new Set(['provisional', 'final']);
const ALLOWED_REPLY_STATES = new Set(['complete', 'partial_cancelled', 'failed', 'restored']);
const KV_LOAD_RETRY_DELAYS = [40, 120];
const LOCAL_MIGRATION_YIELD_EVERY = 12;

const getTauriInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return g?.__TAURI__?.core?.invoke
    || g?.__TAURI__?.invoke
    || g?.__TAURI_INVOKE__
    || g?.__TAURI_INTERNALS__?.invoke;
};

const isPlainRecord = value => Boolean(
  value
  && typeof value === 'object'
  && !Array.isArray(value)
);

const hasCheckpointStateShape = value => Boolean(
  isPlainRecord(value)
  && !value._tooLarge
  && (
    Object.prototype.hasOwnProperty.call(value, 'checkpoints')
    || Object.prototype.hasOwnProperty.call(value, 'pointer')
    || Object.prototype.hasOwnProperty.call(value, 'baselineSnapshotId')
    || Object.prototype.hasOwnProperty.call(value, 'version')
  )
);

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
  throw lastError || new Error('turn checkpoint load_kv failed');
};

// 检查点只给程序读，不带缩进写入（带缩进要多占约三成）。
const saveCheckpointKv = ({ name, data }) => safeInvoke('save_kv', { name, data, compact: true });
// 原生端拒绝写入超过 load_kv 上限的文件（写了也读不回来），保留上一版。
const isKvTooLargeError = err => String(err?.message || err || '').startsWith('kv_too_large');

// 超过 load_kv 上限的旧检查点（以前每轮都存整段请求提示词）：请原生端备份原文件后去掉请求提示词与原始输出，再重新读取。
// 同一会话另一处读取可能已先修好（这里拿到「已不超限」），所以一律重新读取；仍超限、或旧版原生端没有这个命令时，由调用方挡住写入。
const compactOversizedCheckpointKv = async (key, kv) => {
  try {
    const result = await safeInvoke('compact_oversized_turn_checkpoint', { name: key });
    if (result?.compacted) {
      logger.info('oversized turn checkpoint compacted', { key, before: result.before, after: result.after });
    }
    return await loadKvWithRetry(key);
  } catch (err) {
    logger.warn('oversized turn checkpoint compaction failed; writes stay blocked', { key, error: err });
    return kv;
  }
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

const readLocalJson = key => {
  try {
    const raw = globalThis?.localStorage?.getItem?.(key);
    if (!raw || typeof raw !== 'string') return null;
    if (raw.length > LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT) {
      logger.warn('turn checkpoint local bootstrap skipped: oversized snapshot', {
        key,
        size: raw.length,
        limit: LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT,
      });
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const readLocalJsonUnbounded = key => {
  try {
    const raw = globalThis?.localStorage?.getItem?.(key);
    if (!raw || typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const writeLocalJson = (key, value) => {
  try {
    const json = JSON.stringify(value);
    if (json.length > LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT) {
      try { globalThis?.localStorage?.removeItem?.(key); } catch {}
      return false;
    }
    globalThis?.localStorage?.setItem?.(key, json);
    return true;
  } catch {
    return false;
  }
};

const writeLocalRecoveryJson = (key, value) => {
  try {
    globalThis?.localStorage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
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

export const checkpointHashString = (value = '') => {
  const input = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const buildTurnCheckpointSessionSuffix = (sessionId = '') => {
  const raw = String(sessionId || '').trim();
  const label = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'session';
  return `${label}_${checkpointHashString(raw)}`;
};

export const buildTurnCheckpointStoreKey = (scopeId = '', sessionId = '') =>
  makeScopedKey(`${BASE_STORE_KEY}__${buildTurnCheckpointSessionSuffix(sessionId)}`, normalizeScopeId(scopeId));

const clampText = (value, max = MAX_BRANCH_TEXT_CHARS) => {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
};

const clone = value => {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value && typeof value === 'object' ? { ...value } : value;
  }
};

// 写表记录的请求提示词、原始输出只给「最近写表」窗口看，以消息自带的那份为准，检查点不存：
// 每轮都存会把会话检查点撑过 load_kv 的 30 MiB 上限，之后整份读不回来。
const omitMemoryEntryDisplayText = entry => {
  if (!isPlainRecord(entry)) return entry;
  delete entry.requestPrompt;
  delete entry.raw;
  return entry;
};

export const normalizeCheckpointPointer = (raw = {}, fallback = {}) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const swipeIndexRaw = Math.trunc(Number(src.tailSwipeIndex ?? src.swipeIndex ?? fallback.tailSwipeIndex ?? 0));
  return {
    version: 1,
    sessionId: String(src.sessionId || fallback.sessionId || '').trim(),
    tailAssistantMessageId: String(src.tailAssistantMessageId || src.assistantMessageId || fallback.tailAssistantMessageId || '').trim(),
    tailSwipeIndex: Number.isFinite(swipeIndexRaw) && swipeIndexRaw >= 0 ? swipeIndexRaw : 0,
    restoredAt: Number(src.restoredAt || src.updatedAt || fallback.restoredAt || Date.now()) || Date.now(),
    source: String(src.source || fallback.source || 'turn_checkpoint').trim() || 'turn_checkpoint',
  };
};

export const normalizeArchivePointer = (raw = {}, fallback = {}) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const swipeIndexRaw = Math.trunc(Number(src.tailSwipeIndex ?? src.swipeIndex ?? fallback.tailSwipeIndex ?? 0));
  return {
    version: 1,
    archiveId: String(src.archiveId || fallback.archiveId || '').trim(),
    sessionId: String(src.sessionId || fallback.sessionId || '').trim(),
    tailAssistantMessageId: String(src.tailAssistantMessageId || src.assistantMessageId || fallback.tailAssistantMessageId || '').trim(),
    tailSwipeIndex: Number.isFinite(swipeIndexRaw) && swipeIndexRaw >= 0 ? swipeIndexRaw : 0,
    memorySnapshotId: String(src.memorySnapshotId || fallback.memorySnapshotId || '').trim(),
    variableSnapshotId: String(src.variableSnapshotId || fallback.variableSnapshotId || '').trim(),
    restoredAt: Number(src.restoredAt || src.updatedAt || fallback.restoredAt || Date.now()) || Date.now(),
    source: String(src.source || fallback.source || 'archive_pointer').trim() || 'archive_pointer',
  };
};

export const normalizeCheckpointBranch = (raw = {}, fallback = {}) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const swipeIndexRaw = Math.trunc(Number(src.swipeIndex ?? fallback.swipeIndex ?? 0));
  const stateRaw = String(src.state || fallback.state || 'final').trim().toLowerCase();
  const replyStateRaw = String(src.replyState || fallback.replyState || 'complete').trim().toLowerCase();
  return {
    swipeIndex: Number.isFinite(swipeIndexRaw) && swipeIndexRaw >= 0 ? swipeIndexRaw : 0,
    state: ALLOWED_CHECKPOINT_STATES.has(stateRaw) ? stateRaw : 'final',
    replyState: ALLOWED_REPLY_STATES.has(replyStateRaw) ? replyStateRaw : 'complete',
    messageContent: clampText(src.messageContent ?? src.content ?? fallback.messageContent ?? ''),
    messageRaw: clampText(src.messageRaw ?? src.raw ?? fallback.messageRaw ?? ''),
    memorySnapshotId: String(src.memorySnapshotId || fallback.memorySnapshotId || '').trim(),
    memoryUpdateEntry: omitMemoryEntryDisplayText(clone(src.memoryUpdateEntry ?? fallback.memoryUpdateEntry ?? null)),
    // C 计划 M1：变量快照与记忆快照平行，指向 variable-snapshot-store；旧 branch 无此字段 → 空，向后兼容。
    variableSnapshotId: String(src.variableSnapshotId || fallback.variableSnapshotId || '').trim(),
    variableUpdateEntry: clone(src.variableUpdateEntry ?? fallback.variableUpdateEntry ?? null),
    createdAt: Number(src.createdAt || fallback.createdAt || Date.now()) || Date.now(),
    updatedAt: Number(src.updatedAt || fallback.updatedAt || Date.now()) || Date.now(),
  };
};

export const normalizeTurnCheckpoint = (raw = {}, fallback = {}) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const branchesRaw = Array.isArray(src.branches)
    ? src.branches
    : (Array.isArray(fallback.branches) ? fallback.branches : []);
  const branches = branchesRaw
    .map((branch, index) => normalizeCheckpointBranch(branch, { swipeIndex: index }))
    .sort((a, b) => a.swipeIndex - b.swipeIndex);
  const activeSwipeRaw = Math.trunc(Number(src.activeSwipeIndex ?? fallback.activeSwipeIndex ?? 0));
  const activeSwipeIndex = Number.isFinite(activeSwipeRaw) && activeSwipeRaw >= 0 ? activeSwipeRaw : 0;
  const stateRaw = String(src.state || fallback.state || 'final').trim().toLowerCase();
  return {
    version: 1,
    sessionId: String(src.sessionId || fallback.sessionId || '').trim(),
    assistantMessageId: String(src.assistantMessageId || fallback.assistantMessageId || '').trim(),
    userMessageId: String(src.userMessageId || fallback.userMessageId || '').trim(),
    turnIndex: Number.isFinite(Number(src.turnIndex)) ? Number(src.turnIndex) : (Number(fallback.turnIndex) || 0),
    aiFloor: Number.isFinite(Number(src.aiFloor)) ? Number(src.aiFloor) : (Number(fallback.aiFloor) || 0),
    createdAt: Number(src.createdAt || fallback.createdAt || Date.now()) || Date.now(),
    updatedAt: Number(src.updatedAt || fallback.updatedAt || Date.now()) || Date.now(),
    deletedAt: Number(src.deletedAt || fallback.deletedAt || 0) || 0,
    activeSwipeIndex,
    state: ALLOWED_CHECKPOINT_STATES.has(stateRaw) ? stateRaw : 'final',
    branches,
  };
};

const normalizeSessionState = (sessionId = '', input = {}) => {
  const raw = input && typeof input === 'object' ? input : {};
  const checkpointsRaw = raw.checkpoints && typeof raw.checkpoints === 'object' ? raw.checkpoints : {};
  const checkpoints = {};
  Object.entries(checkpointsRaw).forEach(([assistantMessageId, checkpoint]) => {
    const key = String(assistantMessageId || '').trim();
    if (!key) return;
    checkpoints[key] = normalizeTurnCheckpoint(checkpoint, { assistantMessageId: key, sessionId });
  });
  return {
    version: 1,
    sessionId: String(sessionId || raw.sessionId || '').trim(),
    updatedAt: Number(raw.updatedAt || Date.now()) || Date.now(),
    baselineSnapshotId: String(raw.baselineSnapshotId || '').trim(),
    baselineCapturedAt: Number(raw.baselineCapturedAt || 0) || 0,
    pointer: normalizeCheckpointPointer(raw.pointer || {}, { sessionId }),
    archivePointers: Object.entries(raw.archivePointers && typeof raw.archivePointers === 'object' ? raw.archivePointers : {})
      .reduce((acc, [archiveId, pointer]) => {
        const aid = String(archiveId || '').trim();
        if (!aid) return acc;
        acc[aid] = normalizeArchivePointer(pointer, { archiveId: aid, sessionId });
        return acc;
      }, {}),
    checkpoints,
  };
};

const listLocalCheckpointKeys = () => {
  const storage = globalThis?.localStorage;
  const length = Number(storage?.length || 0);
  if (!storage || !Number.isFinite(length) || length <= 0 || typeof storage.key !== 'function') return [];
  const prefix = `${BASE_STORE_KEY}__`;
  const keys = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(storage.key(index) || '');
    if (key.startsWith(prefix)) keys.push(key);
  }
  return keys;
};

export const migrateTurnCheckpointLocalMirrors = async () => {
  const result = {
    scanned: 0,
    removed: 0,
    backfilled: 0,
    retained: 0,
  };
  if (typeof getTauriInvoker() !== 'function') return result;

  const storage = globalThis?.localStorage;
  const keys = listLocalCheckpointKeys();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    result.scanned += 1;
    const localState = readLocalJsonUnbounded(key);
    if (!hasCheckpointStateShape(localState)) {
      result.retained += 1;
      continue;
    }

    let kv = null;
    try {
      kv = await loadKvWithRetry(key);
    } catch (err) {
      logger.debug('turn checkpoint local migration read skipped', { key, error: err });
      result.retained += 1;
      continue;
    }

    if (hasCheckpointStateShape(kv)) {
      if (canonicalJson(kv) !== canonicalJson(localState)) {
        logger.warn('turn checkpoint local/KV conflict retained for recovery', { key });
        result.retained += 1;
        continue;
      }
    } else if (isPlainRecord(kv) && !Object.keys(kv).length) {
      const sessionId = String(localState.sessionId || '').trim();
      try {
        await saveCheckpointKv({
          name: key,
          data: normalizeSessionState(sessionId, localState),
        });
        result.backfilled += 1;
      } catch (err) {
        logger.debug('turn checkpoint local migration backfill skipped', { key, error: err });
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
      await wait(0);
    }
  }
  return result;
};

let localCheckpointMigrationScheduled = false;
const scheduleTurnCheckpointLocalMigration = () => {
  if (localCheckpointMigrationScheduled || typeof getTauriInvoker() !== 'function') return;
  localCheckpointMigrationScheduled = true;
  scheduleIdle(async () => {
    try {
      const result = await migrateTurnCheckpointLocalMirrors();
      if (result.scanned) logger.info('turn checkpoint local migration complete', result);
    } catch (err) {
      logger.warn('turn checkpoint local migration failed', err);
    }
  });
};

const collectCheckpointSnapshotIdsByField = (state = {}, field = 'memorySnapshotId') => {
  const ids = new Set();
  const checkpoints = state?.checkpoints && typeof state.checkpoints === 'object' ? state.checkpoints : {};
  Object.values(checkpoints).forEach(checkpoint => {
    const branches = Array.isArray(checkpoint?.branches) ? checkpoint.branches : [];
    branches.forEach(branch => {
      const id = String(branch?.[field] || '').trim();
      if (id) ids.add(id);
    });
  });
  const archivePointers = state?.archivePointers && typeof state.archivePointers === 'object' ? state.archivePointers : {};
  Object.values(archivePointers).forEach(pointer => {
    const id = String(pointer?.[field] || '').trim();
    if (id) ids.add(id);
  });
  return Array.from(ids);
};

export const collectCheckpointSnapshotIds = (state = {}) =>
  collectCheckpointSnapshotIdsByField(state, 'memorySnapshotId');

// C 计划 M1：变量快照可达集，供 variable-snapshot-store prune 用（与记忆侧同构）。
export const collectCheckpointVariableSnapshotIds = (state = {}) =>
  collectCheckpointSnapshotIdsByField(state, 'variableSnapshotId');

export class TurnCheckpointStore {
  constructor({ scopeId = '' } = {}) {
    this.scopeId = normalizeScopeId(scopeId);
    this.cache = new Map();
    this.loaded = new Set();
    this.writeChains = new Map();
    this.persistenceBlocked = new Set();
    scheduleTurnCheckpointLocalMigration();
  }

  async setScope(scopeId = '') {
    const next = normalizeScopeId(scopeId);
    if (next === this.scopeId) return;
    this.scopeId = next;
    this.cache.clear();
    this.loaded.clear();
    this.writeChains.clear();
    this.persistenceBlocked.clear();
  }

  _getStoreKey(sessionId = '') {
    return buildTurnCheckpointStoreKey(this.scopeId, sessionId);
  }

  async _loadSession(sessionId = '') {
    const sid = String(sessionId || '').trim();
    if (!sid) return normalizeSessionState('', {});
    if (this.loaded.has(sid) && this.cache.has(sid)) return this.cache.get(sid);
    const key = this._getStoreKey(sid);
    const expectsKv = typeof getTauriInvoker() === 'function';
    let payload = null;
    let localPayload = expectsKv ? readLocalJsonUnbounded(key) : readLocalJson(key);

    if (expectsKv) {
      try {
        let kv = await loadKvWithRetry(key);
        if (kv?._tooLarge) kv = await compactOversizedCheckpointKv(key, kv);
        if (hasCheckpointStateShape(kv)) {
          const localIsNewer = hasCheckpointStateShape(localPayload)
            && Number(localPayload.updatedAt || 0) > Number(kv.updatedAt || 0);
          if (localIsNewer) {
            try {
              payload = normalizeSessionState(sid, localPayload);
              await saveCheckpointKv({ name: key, data: payload });
              try { globalThis?.localStorage?.removeItem?.(key); } catch {}
            } catch (err) {
              payload = localPayload;
              this.persistenceBlocked.add(sid);
              logger.warn('turn checkpoint newer local recovery could not reach KV; writes blocked', { key, error: err });
            }
          } else {
            payload = kv;
            const exactMirror = hasCheckpointStateShape(localPayload)
              && canonicalJson(localPayload) === canonicalJson(kv);
            const localNotNewer = hasCheckpointStateShape(localPayload)
              && Number(localPayload.updatedAt || 0) < Number(kv.updatedAt || 0);
            if (!localPayload || exactMirror || localNotNewer) {
              try { globalThis?.localStorage?.removeItem?.(key); } catch {}
            }
          }
        } else if (isPlainRecord(kv) && !Object.keys(kv).length) {
          if (hasCheckpointStateShape(localPayload)) {
            payload = normalizeSessionState(sid, localPayload);
            try {
              await saveCheckpointKv({ name: key, data: payload });
              try { globalThis?.localStorage?.removeItem?.(key); } catch {}
            } catch (err) {
              this.persistenceBlocked.add(sid);
              logger.warn('turn checkpoint local recovery could not reach KV; writes blocked', { key, error: err });
            }
          }
        } else {
          this.persistenceBlocked.add(sid);
          logger.warn('turn checkpoint KV payload is uncertain; writes blocked', { key });
        }
      } catch (err) {
        this.persistenceBlocked.add(sid);
        logger.warn('turn checkpoint KV read failed; writes blocked', { key, error: err });
      }
    }
    if (!payload) payload = localPayload;
    const state = normalizeSessionState(sid, payload || {});
    this.cache.set(sid, state);
    this.loaded.add(sid);
    return state;
  }

  _enqueueWrite(sessionId, task) {
    const sid = String(sessionId || '').trim();
    const prev = this.writeChains.get(sid) || Promise.resolve();
    const next = prev.then(task);
    this.writeChains.set(sid, next.catch(() => {}));
    return next;
  }

  isPersistenceBlocked(sessionId = '') {
    return this.persistenceBlocked.has(String(sessionId || '').trim());
  }

  _assertSessionWritable(sessionId = '') {
    const sid = String(sessionId || '').trim();
    if (!this.persistenceBlocked.has(sid)) return;
    const error = new Error('回合检查点暂时无法读取，已阻止写入以保护现有数据。请重新载入 APP 后重试。');
    error.code = 'turn_checkpoint_store_read_unavailable';
    throw error;
  }

  // 最近几轮之外只留编号：正文与变量记录检查点里没人读；写表记录只在消息没有自带时当还原备用，
  // 所以当前对话末尾与各存档末尾（还原目标）照留。否则多次重开、存档后检查点只增不减。
  _compactOldBranches(state, keepRecent = COMPACT_RECENT_TURNS) {
    const checkpoints = state?.checkpoints;
    if (!checkpoints || typeof checkpoints !== 'object') return;
    const entries = Object.entries(checkpoints);
    if (entries.length <= keepRecent) return;
    const restoreTargets = new Set(
      [state.pointer, ...Object.values(state.archivePointers || {})]
        .map(pointer => String(pointer?.tailAssistantMessageId || '').trim())
        .filter(Boolean),
    );
    const sorted = entries
      .map(([id, cp]) => ({
        id,
        order: Number(cp.aiFloor || cp.turnIndex || 0) || (Number(cp.createdAt || 0) / 1e10),
      }))
      .sort((a, b) => b.order - a.order);
    for (let i = keepRecent; i < sorted.length; i += 1) {
      const cp = checkpoints[sorted[i].id];
      if (!cp || !Array.isArray(cp.branches)) continue;
      const keepRecords = restoreTargets.has(sorted[i].id);
      for (const branch of cp.branches) {
        if (!branch) continue;
        if (branch.messageContent) branch.messageContent = '';
        if (branch.messageRaw) branch.messageRaw = '';
        if (keepRecords) continue;
        branch.memoryUpdateEntry = null;
        branch.variableUpdateEntry = null;
      }
    }
  }

  async _saveWithinLoadLimit(key, state) {
    try {
      await saveCheckpointKv({ name: key, data: state });
    } catch (err) {
      if (!isKvTooLargeError(err)) throw err;
      this._compactOldBranches(state, 0);
      await saveCheckpointKv({ name: key, data: state });
    }
  }

  async _persistSession(sessionId = '') {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    const state = await this._loadSession(sid);
    this._assertSessionWritable(sid);
    state.updatedAt = Date.now();
    this._compactOldBranches(state);
    const key = this._getStoreKey(sid);
    if (typeof getTauriInvoker() === 'function') {
      try {
        await this._saveWithinLoadLimit(key, state);
        try { globalThis?.localStorage?.removeItem?.(key); } catch {}
        return true;
      } catch (err) {
        writeLocalRecoveryJson(key, state);
        logger.debug('turn checkpoint store save_kv failed; retained local fallback', err);
        return false;
      }
    }
    return writeLocalJson(key, state);
  }

  async getSessionState(sessionId = '') {
    const state = await this._loadSession(sessionId);
    return clone(state);
  }

  async listCheckpoints(sessionId = '') {
    const state = await this._loadSession(sessionId);
    return Object.values(state.checkpoints || {}).map(item => clone(item));
  }

  async getCheckpoint(sessionId = '', assistantMessageId = '') {
    const sid = String(sessionId || '').trim();
    const aid = String(assistantMessageId || '').trim();
    if (!sid || !aid) return null;
    const state = await this._loadSession(sid);
    const item = state.checkpoints?.[aid];
    return item ? clone(item) : null;
  }

  async upsertCheckpoint(sessionId = '', checkpoint = {}) {
    const sid = String(sessionId || checkpoint?.sessionId || '').trim();
    if (!sid) return null;
    const normalized = normalizeTurnCheckpoint(checkpoint, { sessionId: sid });
    const aid = String(normalized.assistantMessageId || '').trim();
    if (!aid) return null;
    await this._loadSession(sid);
    return this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      const existing = state.checkpoints?.[aid] || { sessionId: sid, assistantMessageId: aid };
      const merged = normalizeTurnCheckpoint(
        {
          ...existing,
          ...normalized,
          branches: Array.isArray(normalized.branches) && normalized.branches.length
            ? normalized.branches
            : existing.branches,
        },
        existing,
      );
      state.checkpoints[aid] = merged;
      await this._persistSession(sid);
      return clone(merged);
    });
  }

  async patchCheckpoint(sessionId = '', assistantMessageId = '', updater = null) {
    const sid = String(sessionId || '').trim();
    const aid = String(assistantMessageId || '').trim();
    if (!sid || !aid || typeof updater !== 'function') return null;
    await this._loadSession(sid);
    return this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      const existing = state.checkpoints?.[aid] || { sessionId: sid, assistantMessageId: aid };
      const draft = clone(existing) || { sessionId: sid, assistantMessageId: aid };
      const nextRaw = await updater(draft);
      if (!nextRaw) return clone(existing);
      const normalized = normalizeTurnCheckpoint(nextRaw, existing);
      state.checkpoints[aid] = normalized;
      await this._persistSession(sid);
      return clone(normalized);
    });
  }

  async removeCheckpoint(sessionId = '', assistantMessageId = '') {
    const sid = String(sessionId || '').trim();
    const aid = String(assistantMessageId || '').trim();
    if (!sid || !aid) return false;
    await this._loadSession(sid);
    return this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      if (!state.checkpoints?.[aid]) return false;
      delete state.checkpoints[aid];
      if (state.pointer?.tailAssistantMessageId === aid) {
        state.pointer = normalizeCheckpointPointer({}, { sessionId: sid });
      }
      await this._persistSession(sid);
      return true;
    });
  }

  async markCheckpointDeleted(sessionId = '', assistantMessageId = '', deletedAt = Date.now()) {
    return this.patchCheckpoint(sessionId, assistantMessageId, (draft) => ({
      ...draft,
      deletedAt: Number(deletedAt || Date.now()) || Date.now(),
      updatedAt: Date.now(),
    }));
  }

  async getPointer(sessionId = '') {
    const state = await this._loadSession(sessionId);
    return clone(state.pointer);
  }

  async getBaselineSnapshotId(sessionId = '') {
    const state = await this._loadSession(sessionId);
    return String(state?.baselineSnapshotId || '').trim();
  }

  async setBaselineSnapshotId(sessionId = '', snapshotId = '') {
    const sid = String(sessionId || '').trim();
    const id = String(snapshotId || '').trim();
    if (!sid) return '';
    await this._loadSession(sid);
    await this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      state.baselineSnapshotId = id;
      state.baselineCapturedAt = id ? Date.now() : 0;
      await this._persistSession(sid);
    });
    return id;
  }

  async setPointer(sessionId = '', pointer = {}) {
    const sid = String(sessionId || pointer?.sessionId || '').trim();
    if (!sid) return null;
    await this._loadSession(sid);
    return this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      state.pointer = normalizeCheckpointPointer(pointer, { sessionId: sid });
      await this._persistSession(sid);
      return clone(state.pointer);
    });
  }

  async clearPointer(sessionId = '') {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    return this.setPointer(sid, { sessionId: sid, tailAssistantMessageId: '', tailSwipeIndex: 0, restoredAt: Date.now() });
  }

  async getArchivePointer(sessionId = '', archiveId = '') {
    const sid = String(sessionId || '').trim();
    const aid = String(archiveId || '').trim();
    if (!sid || !aid) return null;
    const state = await this._loadSession(sid);
    return clone(state?.archivePointers?.[aid] || null);
  }

  async setArchivePointer(sessionId = '', archiveId = '', pointer = {}) {
    const sid = String(sessionId || pointer?.sessionId || '').trim();
    const aid = String(archiveId || pointer?.archiveId || '').trim();
    if (!sid || !aid) return null;
    await this._loadSession(sid);
    return this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      if (!state.archivePointers || typeof state.archivePointers !== 'object') state.archivePointers = {};
      state.archivePointers[aid] = normalizeArchivePointer(pointer, { sessionId: sid, archiveId: aid });
      await this._persistSession(sid);
      return clone(state.archivePointers[aid]);
    });
  }

  async removeArchivePointer(sessionId = '', archiveId = '') {
    const sid = String(sessionId || '').trim();
    const aid = String(archiveId || '').trim();
    if (!sid || !aid) return false;
    await this._loadSession(sid);
    return this._enqueueWrite(sid, async () => {
      const state = await this._loadSession(sid);
      if (!state.archivePointers?.[aid]) return false;
      delete state.archivePointers[aid];
      await this._persistSession(sid);
      return true;
    });
  }

  async clearSession(sessionId = '') {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    await this._loadSession(sid);
    this._assertSessionWritable(sid);
    const key = this._getStoreKey(sid);
    if (typeof getTauriInvoker() === 'function') {
      try {
        await saveCheckpointKv({ name: key, data: normalizeSessionState(sid, {}) });
      } catch (err) {
        logger.debug('turn checkpoint store clear save_kv failed; existing state retained', err);
        return false;
      }
    }
    try {
      globalThis?.localStorage?.removeItem?.(key);
    } catch {}
    this.cache.delete(sid);
    this.loaded.delete(sid);
    this.writeChains.delete(sid);
    this.persistenceBlocked.delete(sid);
    if (typeof getTauriInvoker() !== 'function') {
      return true;
    }
    return true;
  }

  async renameSession(oldSessionId = '', newSessionId = '') {
    const from = String(oldSessionId || '').trim();
    const to = String(newSessionId || '').trim();
    if (!from || !to || from === to) return false;
    const state = await this._loadSession(from);
    await this._loadSession(to);
    this._assertSessionWritable(from);
    this._assertSessionWritable(to);
    const checkpointsRaw = state?.checkpoints && typeof state.checkpoints === 'object' ? state.checkpoints : {};
    const checkpoints = {};
    Object.entries(checkpointsRaw).forEach(([assistantMessageId, checkpoint]) => {
      const aid = String(assistantMessageId || '').trim();
      if (!aid) return;
      checkpoints[aid] = normalizeTurnCheckpoint(
        { ...(checkpoint || {}), sessionId: to, assistantMessageId: aid },
        { sessionId: to, assistantMessageId: aid },
      );
    });
    const nextState = normalizeSessionState(to, {
      ...state,
      sessionId: to,
      pointer: normalizeCheckpointPointer(state?.pointer || {}, { sessionId: to }),
      archivePointers: Object.entries(state?.archivePointers && typeof state.archivePointers === 'object' ? state.archivePointers : {})
        .reduce((acc, [archiveId, pointer]) => {
          const aid = String(archiveId || '').trim();
          if (!aid) return acc;
          acc[aid] = normalizeArchivePointer(
            { ...(pointer || {}), archiveId: aid, sessionId: to },
            { archiveId: aid, sessionId: to },
          );
          return acc;
        }, {}),
      checkpoints,
    });
    const nextKey = this._getStoreKey(to);
    const fromKey = this._getStoreKey(from);
    if (typeof getTauriInvoker() === 'function') {
      try {
        await saveCheckpointKv({ name: nextKey, data: nextState });
      } catch (err) {
        writeLocalRecoveryJson(nextKey, nextState);
        logger.debug('turn checkpoint store rename destination save failed; source retained', err);
        return false;
      }
      try {
        await saveCheckpointKv({ name: fromKey, data: normalizeSessionState(from, {}) });
      } catch (err) {
        try { globalThis?.localStorage?.removeItem?.(nextKey); } catch {}
        this.cache.set(to, nextState);
        this.loaded.add(to);
        logger.debug('turn checkpoint store rename source clear failed; both states retained', err);
        return false;
      }
      try {
        globalThis?.localStorage?.removeItem?.(nextKey);
        globalThis?.localStorage?.removeItem?.(fromKey);
      } catch {}
    } else {
      if (!writeLocalJson(nextKey, nextState)) return false;
      try { globalThis?.localStorage?.removeItem?.(fromKey); } catch {}
    }
    this.cache.set(to, nextState);
    this.loaded.add(to);
    this.cache.delete(from);
    this.loaded.delete(from);
    this.writeChains.delete(from);
    this.persistenceBlocked.delete(from);
    return true;
  }
}
