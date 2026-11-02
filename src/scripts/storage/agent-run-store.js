import {
  cloneAgentValue,
  normalizeAgentEvent,
  normalizeAgentRun,
  normalizeAgentStep,
  normalizeAgentToolCall,
} from '../agent/agent-events.js';
import {
  buildAgentRunCacheStats,
  buildAgentRunListView,
} from '../agent/agent-run-view-model.js';
import { makeScopedKey, normalizeScopeId } from './store-scope.js';
import { safeInvoke } from '../utils/tauri.js';

export const AGENT_RUN_STORE_BASE_KEY = 'agent_run_store_v1';
export const AGENT_RUN_STORE_VERSION = 1;

const LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT = 500_000;
const DEFAULT_MAX_RUNS = 120;
const DEFAULT_MAX_EVENTS = 400;
const REVIEW_CANDIDATE_KINDS = new Set(['chat_format_guardian', 'chat_body_quality_guardian']);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const clone = value => cloneAgentValue(value, value && typeof value === 'object' ? {} : value);

const safeLog = (level, ...args) => {
  try {
    if (level === 'debug' && globalThis?.__CHATAPP_DEBUG_AGENT_STORE__ !== true) return;
    const fn = globalThis?.console?.[level];
    if (typeof fn === 'function') fn(...args);
  } catch {}
};

const readLocalJson = key => {
  try {
    const raw = globalThis?.localStorage?.getItem?.(key);
    if (!raw || typeof raw !== 'string') return null;
    if (raw.length > LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT) {
      safeLog('warn', 'agent run store local bootstrap skipped: oversized snapshot', {
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

export const buildAgentRunStoreKey = (scopeId = '') =>
  makeScopedKey(AGENT_RUN_STORE_BASE_KEY, normalizeScopeId(scopeId));

export const normalizeAgentRunStoreState = (raw = {}, {
  now = Date.now,
  maxRuns = DEFAULT_MAX_RUNS,
  maxEvents = DEFAULT_MAX_EVENTS,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const runsRaw = isPlainObject(src.runs) ? src.runs : {};
  const eventsRaw = Array.isArray(src.events) ? src.events : [];
  const runs = {};
  Object.values(runsRaw).forEach((run) => {
    const normalized = normalizeAgentRun(run, { now });
    if (normalized.id) runs[normalized.id] = normalized;
  });

  const sortedRunIds = Object.values(runs)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, Math.max(1, Number(maxRuns) || DEFAULT_MAX_RUNS))
    .map(run => run.id);
  const keptIds = new Set(sortedRunIds);
  Object.keys(runs).forEach((runId) => {
    if (!keptIds.has(runId)) delete runs[runId];
  });

  const events = eventsRaw
    .map(event => normalizeAgentEvent(event, { now }))
    .filter(event => !event.runId || keptIds.has(event.runId))
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(-Math.max(1, Number(maxEvents) || DEFAULT_MAX_EVENTS));

  return {
    version: AGENT_RUN_STORE_VERSION,
    updatedAt: Number(src.updatedAt || now?.() || Date.now()) || Date.now(),
    runs,
    events,
  };
};

export class AgentRunStore {
  constructor({
    scopeId = '',
    maxRuns = DEFAULT_MAX_RUNS,
    maxEvents = DEFAULT_MAX_EVENTS,
    now = Date.now,
  } = {}) {
    this.scopeId = normalizeScopeId(scopeId);
    this.maxRuns = Math.max(1, Number(maxRuns) || DEFAULT_MAX_RUNS);
    this.maxEvents = Math.max(1, Number(maxEvents) || DEFAULT_MAX_EVENTS);
    this.now = typeof now === 'function' ? now : Date.now;
    this.state = normalizeAgentRunStoreState({}, {
      now: this.now,
      maxRuns: this.maxRuns,
      maxEvents: this.maxEvents,
    });
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  get storeKey() {
    return buildAgentRunStoreKey(this.scopeId);
  }

  async setScope(scopeId = '') {
    const next = normalizeScopeId(scopeId);
    if (next === this.scopeId) return;
    this.scopeId = next;
    this.loaded = false;
    this.writeChain = Promise.resolve();
    await this.load();
  }

  async load() {
    const key = this.storeKey;
    let payload = null;
    try {
      const kv = await safeInvoke('load_kv', { name: key });
      if (kv && typeof kv === 'object' && !kv._tooLarge) payload = kv;
    } catch (err) {
      safeLog('debug', 'agent run store hydrate skipped (可能非 Tauri)', err);
    }
    if (!payload) payload = readLocalJson(key);
    this.state = normalizeAgentRunStoreState(payload || {}, {
      now: this.now,
      maxRuns: this.maxRuns,
      maxEvents: this.maxEvents,
    });
    // 僵尸 run 兜底：上一会话遗留的 running/waiting run（进程已死不可能再推进）标记为可继续的 interrupted，
    // 避免 Agent Center/状态芯片永久显示"运行中"。
    let staleFixed = 0;
    const bootAt = Number(this.now?.() || Date.now()) || Date.now();
    Object.values(this.state.runs || {}).forEach((run) => {
      if (!run || !['queued', 'running', 'waiting_permission'].includes(String(run.status || ''))) return;
      // 格式／正文复核留下的待确认修复候选：重启后只是过期，不算失败
      const expiredReview = run.status === 'waiting_permission' && REVIEW_CANDIDATE_KINDS.has(String(run.kind || ''));
      run.status = 'cancelled';
      run.cancelReason = run.cancelReason || (expiredReview ? 'review_expired' : 'app_restarted');
      run.finishedAt = run.finishedAt || bootAt;
      run.updatedAt = bootAt;
      run.metadata = { ...(run.metadata || {}), continuable: true, failureCode: run.metadata?.failureCode || 'app_restarted' };
      staleFixed += 1;
    });
    if (staleFixed > 0) {
      safeLog('debug', `agent run store: marked ${staleFixed} stale running run(s) as interrupted`);
      void this.persist();
    }
    this.loaded = true;
    return this.exportState({ includeNonExportable: true });
  }

  async persist() {
    this.state = normalizeAgentRunStoreState({
      ...this.state,
      updatedAt: this.now(),
    }, {
      now: this.now,
      maxRuns: this.maxRuns,
      maxEvents: this.maxEvents,
    });
    const payload = this.exportState({ includeNonExportable: true });
    const key = this.storeKey;
    writeLocalJson(key, payload);
    try {
      await safeInvoke('save_kv', { name: key, data: payload });
      return true;
    } catch (err) {
      safeLog('debug', 'agent run store save_kv skipped (可能非 Tauri)', err);
      return false;
    }
  }

  _schedulePersist() {
    // 防抖合并：每步 start/finish 都触发变更，逐次全量 persist 会长时间占用主线程（大库实测秒级）。
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._flushPersist();
    }, 600);
    return this.writeChain;
  }

  _flushPersist() {
    this.writeChain = this.writeChain
      .then(() => this.persist())
      .catch((err) => {
        safeLog('warn', 'agent run store persist failed', err);
        return false;
      });
    return this.writeChain;
  }

  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    return this._flushPersist();
  }

  _commit(mutator) {
    if (typeof mutator !== 'function') return null;
    const result = mutator(this.state);
    this.state.updatedAt = this.now();
    this.state = normalizeAgentRunStoreState(this.state, {
      now: this.now,
      maxRuns: this.maxRuns,
      maxEvents: this.maxEvents,
    });
    this._schedulePersist();
    return result;
  }

  upsertRun(run = {}) {
    const normalized = normalizeAgentRun(run, { now: this.now });
    return this._commit((state) => {
      const previous = state.runs[normalized.id] || null;
      const merged = previous
        ? normalizeAgentRun({
          ...previous,
          ...normalized,
          metadata: {
            ...(previous.metadata || {}),
            ...(normalized.metadata || {}),
          },
          steps: normalized.steps?.length ? normalized.steps : previous.steps,
          toolCalls: normalized.toolCalls?.length ? normalized.toolCalls : previous.toolCalls,
        }, { now: this.now })
        : normalized;
      state.runs[merged.id] = merged;
      return clone(merged);
    });
  }

  updateRun(runId = '', patch = {}) {
    const id = String(runId || '').trim();
    if (!id) return null;
    return this._commit((state) => {
      const previous = state.runs[id];
      if (!previous) return null;
      const next = normalizeAgentRun({
        ...previous,
        ...(isPlainObject(patch) ? patch : {}),
        id,
        metadata: {
          ...(previous.metadata || {}),
          ...(isPlainObject(patch?.metadata) ? patch.metadata : {}),
        },
        updatedAt: patch?.updatedAt ?? this.now(),
      }, { now: this.now });
      state.runs[id] = next;
      return clone(next);
    });
  }

  addStep(runId = '', step = {}) {
    const id = String(runId || '').trim();
    if (!id) return null;
    return this._commit((state) => {
      const run = state.runs[id];
      if (!run) return null;
      const normalized = normalizeAgentStep(step, { runId: id, now: this.now });
      const steps = Array.isArray(run.steps) ? run.steps.slice() : [];
      const index = steps.findIndex(item => item.id === normalized.id);
      if (index >= 0) steps[index] = normalized;
      else steps.push(normalized);
      state.runs[id] = normalizeAgentRun({
        ...run,
        steps,
        updatedAt: this.now(),
      }, { now: this.now });
      return clone(normalized);
    });
  }

  updateStep(runId = '', stepId = '', patch = {}) {
    const id = String(runId || '').trim();
    const sid = String(stepId || '').trim();
    if (!id || !sid) return null;
    return this._commit((state) => {
      const run = state.runs[id];
      if (!run) return null;
      const steps = Array.isArray(run.steps) ? run.steps.slice() : [];
      const index = steps.findIndex(item => item.id === sid);
      if (index < 0) return null;
      const next = normalizeAgentStep({
        ...steps[index],
        ...(isPlainObject(patch) ? patch : {}),
        id: sid,
        runId: id,
        metadata: {
          ...(steps[index].metadata || {}),
          ...(isPlainObject(patch?.metadata) ? patch.metadata : {}),
        },
        updatedAt: patch?.updatedAt ?? this.now(),
      }, { runId: id, now: this.now });
      steps[index] = next;
      state.runs[id] = normalizeAgentRun({
        ...run,
        steps,
        updatedAt: this.now(),
      }, { now: this.now });
      return clone(next);
    });
  }

  addToolCall(runId = '', toolCall = {}) {
    const id = String(runId || '').trim();
    if (!id) return null;
    return this._commit((state) => {
      const run = state.runs[id];
      if (!run) return null;
      const normalized = normalizeAgentToolCall(toolCall, { runId: id, now: this.now });
      const toolCalls = Array.isArray(run.toolCalls) ? run.toolCalls.slice() : [];
      const index = toolCalls.findIndex(item => item.id === normalized.id);
      if (index >= 0) toolCalls[index] = normalized;
      else toolCalls.push(normalized);
      state.runs[id] = normalizeAgentRun({
        ...run,
        toolCalls,
        updatedAt: this.now(),
      }, { now: this.now });
      return clone(normalized);
    });
  }

  recordEvent(event = {}) {
    const normalized = normalizeAgentEvent(event, { now: this.now });
    return this._commit((state) => {
      state.events.push(normalized);
      return clone(normalized);
    });
  }

  getRun(runId = '') {
    const id = String(runId || '').trim();
    if (!id) return null;
    const run = this.state.runs[id] || null;
    return run ? clone(run) : null;
  }

  listRuns({
    sessionId = '',
    status = '',
    kind = '',
    limit = 0,
    includeNonExportable = true,
  } = {}) {
    const sid = String(sessionId || '').trim();
    const statusFilter = String(status || '').trim();
    const kindFilter = String(kind || '').trim();
    const count = Math.max(0, Number(limit) || 0);
    const list = Object.values(this.state.runs || {})
      .filter((run) => {
        if (!includeNonExportable && run.exportable === false) return false;
        if (sid && run.sessionId !== sid) return false;
        if (statusFilter && run.status !== statusFilter) return false;
        if (kindFilter && run.kind !== kindFilter) return false;
        return true;
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    return (count > 0 ? list.slice(0, count) : list).map(clone);
  }

  listEvents({ runId = '', sessionId = '', limit = 0 } = {}) {
    const rid = String(runId || '').trim();
    const sid = String(sessionId || '').trim();
    const count = Math.max(0, Number(limit) || 0);
    const list = (this.state.events || []).filter((event) => {
      if (rid && event.runId !== rid) return false;
      if (sid && event.sessionId !== sid) return false;
      return true;
    });
    return (count > 0 ? list.slice(-count) : list).map(clone);
  }

  getStats() {
    return buildAgentRunCacheStats({
      runs: this.state.runs || {},
      events: this.state.events || [],
      maxRuns: this.maxRuns,
      maxEvents: this.maxEvents,
    });
  }

  buildListView(options = {}) {
    return buildAgentRunListView(Object.values(this.state.runs || {}), {
      ...(isPlainObject(options) ? options : {}),
      events: this.state.events || [],
    });
  }

  compact({
    maxRuns = this.maxRuns,
    maxEvents = this.maxEvents,
  } = {}) {
    const nextMaxRuns = Math.max(1, Math.trunc(Number(maxRuns)) || this.maxRuns);
    const nextMaxEvents = Math.max(1, Math.trunc(Number(maxEvents)) || this.maxEvents);
    this.state = normalizeAgentRunStoreState(this.state, {
      now: this.now,
      maxRuns: nextMaxRuns,
      maxEvents: nextMaxEvents,
    });
    this.state.updatedAt = this.now();
    this._schedulePersist();
    return this.getStats();
  }

  exportState({ includeNonExportable = false } = {}) {
    const runs = {};
    Object.values(this.state.runs || {}).forEach((run) => {
      if (!includeNonExportable && run.exportable === false) return;
      runs[run.id] = clone(run);
    });
    const keptIds = new Set(Object.keys(runs));
    return {
      version: AGENT_RUN_STORE_VERSION,
      updatedAt: Number(this.state.updatedAt || this.now()) || this.now(),
      runs,
      events: (this.state.events || [])
        .filter(event => !event.runId || keptIds.has(event.runId))
        .map(clone),
    };
  }

  clear() {
    return this._commit((state) => {
      state.runs = {};
      state.events = [];
      return true;
    });
  }

  // 删除指定的已结束 run（连同它的事件）；运行中、待确认的跳过。返回实际删掉的 id。
  removeRuns(runIds = []) {
    const ids = new Set((Array.isArray(runIds) ? runIds : [runIds]).map(id => String(id || '').trim()).filter(Boolean));
    if (!ids.size) return [];
    const removed = this._commit((state) => {
      const out = [];
      ids.forEach((id) => {
        const run = state.runs[id];
        if (!run || ['queued', 'running', 'waiting_permission'].includes(String(run.status || ''))) return;
        delete state.runs[id];
        out.push(id);
      });
      return out;
    });
    if (removed.length) this.flush();
    return removed;
  }
}
