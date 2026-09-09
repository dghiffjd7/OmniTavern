// 跳房子板存储（计划 §9）：全局用户板走 kv 主通道 + localStorage 镜像；
// 会话覆盖存于该会话的 settings.hopscotchBoard（随会话作用域、删除与资料包一起流转）。
// 有效板优先级：会话覆盖 > 用户全局板 > 由设置推导的内建默认板（不落盘）。

import { normalizeHopscotchBoard, validateHopscotchBoard } from '../ui/chat/hopscotch-board-utils.js';
import { makeScopedKey, normalizeScopeId } from './store-scope.js';

export const HOPSCOTCH_BOARD_STORE_BASE_KEY = 'hopscotch_board_default_v1';
export const HOPSCOTCH_BOARD_STORE_VERSION = 1;
export const HOPSCOTCH_SESSION_SETTING_KEY = 'hopscotchBoard';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeNow = (now = Date.now) => {
  try {
    const value = typeof now === 'function' ? now() : Date.now();
    return Number.isFinite(Number(value)) ? Number(value) : Date.now();
  } catch {
    return Date.now();
  }
};
const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

export const normalizeHopscotchBoardStoreState = (raw = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const board = isPlainObject(src.board) ? normalizeHopscotchBoard(src.board) : null;
  return {
    version: HOPSCOTCH_BOARD_STORE_VERSION,
    updatedAt: Number(src.updatedAt || 0) || 0,
    board: board && validateHopscotchBoard(board).ok ? { ...board, source: 'user' } : null,
    // 损坏/校验失败的板不静默丢弃：保留原始数据供导入/诊断（§9）
    invalidBoard: board && !validateHopscotchBoard(board).ok ? clone(src.board) : null,
    createdAt: Number(src.createdAt || 0) || safeNow(now),
  };
};

export const createHopscotchBoardStore = ({
  storage = globalThis?.localStorage || null,
  loadKv = null,
  saveKv = null,
  scopeId = '',
  baseKey = HOPSCOTCH_BOARD_STORE_BASE_KEY,
  getSessionSettings = null,
  setSessionSettings = null,
  now = Date.now,
  logger = console,
} = {}) => {
  let key = makeScopedKey(baseKey, normalizeScopeId(scopeId));
  let state = null;
  let hydrated = false;

  const load = () => {
    if (state) return state;
    let raw = null;
    try {
      const text = storage?.getItem?.(key);
      raw = text ? JSON.parse(text) : null;
    } catch {}
    state = normalizeHopscotchBoardStoreState(raw || {}, { now });
    return state;
  };

  // kv 为主通道（localStorage 可能配额已满而静默失败）；kv 读取异常不等于没有数据，不据此回写空默认。
  const hydrate = async () => {
    const targetKey = key;
    load();
    if (typeof loadKv !== 'function') {
      hydrated = true;
      return state;
    }
    try {
      const kvRaw = await loadKv(key);
      if (targetKey !== key) return state;
      if (kvRaw && typeof kvRaw === 'object' && !kvRaw._tooLarge) {
        const kvState = normalizeHopscotchBoardStoreState(kvRaw, { now });
        if (Number(kvState.updatedAt || 0) >= Number(state.updatedAt || 0) || !state.board) {
          state = kvState;
        }
      }
      hydrated = true;
    } catch (err) {
      logger?.debug?.('hopscotch board kv hydrate skipped', err);
    }
    return state;
  };

  const save = async (next) => {
    const targetKey = key;
    const payload = JSON.stringify({ ...next, updatedAt: safeNow(now) });
    let localOk = false;
    if (typeof saveKv === 'function') {
      try {
        await saveKv(targetKey, JSON.parse(payload));
      } catch (err) {
        logger?.warn?.('hopscotch board kv save failed', err);
        // 主通道失败不能提示保存成功
        return { ok: false, reason: 'kv_save_failed', localOk };
      }
    }
    try {
      if (storage?.setItem) {
        storage.setItem(targetKey, payload);
        localOk = true;
      }
    } catch {}
    if (typeof saveKv === 'function' || localOk) {
      if (targetKey === key) state = JSON.parse(payload);
      return { ok: true, channel: typeof saveKv === 'function' ? 'kv' : 'local', localOk };
    }
    return { ok: localOk, reason: localOk ? '' : 'local_save_failed', localOk };
  };

  const getGlobalBoard = () => clone(load().board);
  const setGlobalBoard = async (board = null) => {
    load();
    if (board == null) {
      return save({ ...state, board: null, invalidBoard: null });
    }
    const validation = validateHopscotchBoard(board);
    if (!validation.ok) return { ok: false, reason: 'invalid_board', errors: validation.errors };
    return save({ ...state, board: { ...validation.board, source: 'user', updatedAt: safeNow(now) }, invalidBoard: null });
  };

  const getSessionOverride = (sessionId = '') => {
    const sid = String(sessionId || '').trim();
    if (!sid || typeof getSessionSettings !== 'function') return null;
    const settings = getSessionSettings(sid);
    const raw = isPlainObject(settings) ? settings[HOPSCOTCH_SESSION_SETTING_KEY] : null;
    if (!isPlainObject(raw)) return null;
    const normalized = normalizeHopscotchBoard(raw);
    return validateHopscotchBoard(normalized).ok ? { ...normalized, source: 'user' } : null;
  };
  const setSessionOverride = (sessionId = '', board = null) => {
    const sid = String(sessionId || '').trim();
    if (!sid || typeof getSessionSettings !== 'function' || typeof setSessionSettings !== 'function') {
      return { ok: false, reason: 'session_settings_unavailable' };
    }
    const current = getSessionSettings(sid);
    const next = { ...(isPlainObject(current) ? current : {}) };
    if (board == null) {
      delete next[HOPSCOTCH_SESSION_SETTING_KEY];
    } else {
      const validation = validateHopscotchBoard(board);
      if (!validation.ok) return { ok: false, reason: 'invalid_board', errors: validation.errors };
      next[HOPSCOTCH_SESSION_SETTING_KEY] = { ...validation.board, source: 'user', updatedAt: safeNow(now) };
    }
    const ok = setSessionSettings(sid, next) !== false;
    return { ok, reason: ok ? '' : 'session_settings_write_failed' };
  };

  // 返回 { board, source: 'session' | 'global' | 'derived' }；derived 由调用方传入（不落盘）
  const resolveEffectiveBoard = ({ sessionId = '', derivedBoard = null } = {}) => {
    const session = getSessionOverride(sessionId);
    if (session) return { board: session, source: 'session' };
    const global = getGlobalBoard();
    if (global) return { board: global, source: 'global' };
    return { board: derivedBoard ? normalizeHopscotchBoard(derivedBoard) : null, source: 'derived' };
  };

  return {
    get key() { return key; },
    setScope: async (nextScope) => {
      key = makeScopedKey(baseKey, normalizeScopeId(nextScope));
      state = null;
      hydrated = false;
      return hydrate();
    },
    hydrate,
    isHydrated: () => hydrated,
    getGlobalBoard,
    setGlobalBoard,
    getInvalidBoard: () => clone(load().invalidBoard),
    getSessionOverride,
    setSessionOverride,
    resolveEffectiveBoard,
    exportState: () => clone(load()),
    importState: async (raw = {}) => {
      const incoming = normalizeHopscotchBoardStoreState(raw, { now });
      if (!incoming.board) return { ok: false, reason: incoming.invalidBoard ? 'invalid_board' : 'empty' };
      load();
      return setGlobalBoard(incoming.board);
    },
  };
};

// 旧默认板本来就按角色卡分区，继续原键读取；真正的写作全局板使用独立键。
// 既有数据保持原作用范围：本会话 > 当前角色卡 > 写作全局 > 设置推导。
export const createScopedHopscotchBoardStore = (options = {}) => {
  const persona = createHopscotchBoardStore(options);
  const global = createHopscotchBoardStore({
    ...options, scopeId: '', baseKey: 'hopscotch_board_writing_global_v1',
    getSessionSettings: null, setSessionSettings: null,
  });
  return {
    get key() { return persona.key; },
    get globalKey() { return global.key; },
    setScope: scope => persona.setScope(scope),
    hydrate: async () => { await Promise.all([persona.hydrate(), global.hydrate()]); },
    isHydrated: () => persona.isHydrated() && global.isHydrated(),
    getGlobalBoard: global.getGlobalBoard,
    setGlobalBoard: global.setGlobalBoard,
    getPersonaBoard: persona.getGlobalBoard,
    setPersonaBoard: persona.setGlobalBoard,
    getSessionOverride: persona.getSessionOverride,
    setSessionOverride: persona.setSessionOverride,
    getInvalidBoard: () => persona.getInvalidBoard() || global.getInvalidBoard(),
    exportState: persona.exportState,
    importState: persona.importState,
    resolveEffectiveBoard: ({ sessionId = '', derivedBoard = null, scope = 'effective' } = {}) => {
      const session = scope === 'effective' || scope === 'session' ? persona.getSessionOverride(sessionId) : null;
      if (session) return { board: session, source: 'session' };
      const local = scope !== 'global' ? persona.getGlobalBoard() : null;
      if (local) return { board: local, source: 'persona' };
      const shared = global.getGlobalBoard();
      if (shared) return { board: shared, source: 'global' };
      return { board: derivedBoard ? normalizeHopscotchBoard(derivedBoard) : null, source: 'derived' };
    },
  };
};
