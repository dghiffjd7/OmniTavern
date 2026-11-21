import { safeInvoke } from '../utils/tauri.js';

export const COMPAT_GAP_REPORT_STORE_KEY = 'compat_gap_reports_v1';
export const COMPAT_GAP_REPORT_LIMIT = 100;
const COMPAT_GAP_REPORT_VERSION = 1;
const COMPAT_API_RE = /^(?:\$\(\)|\$|_\(\)|_)\.[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
// 脚本打到 APP 还没有的酒馆后端接口（/api/...）
const TAVERN_API_PATH_RE = /^\/api\/[A-Za-z0-9_\-./]{1,120}$/;

const clone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
};

const toTimestamp = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
};

const trimToken = (value, maxLength = 96) => String(value || '').trim().slice(0, maxLength);

export const sanitizeCompatGapApi = (value) => {
  const api = trimToken(value, 128);
  return COMPAT_API_RE.test(api) || TAVERN_API_PATH_RE.test(api) ? api : '';
};

export const fingerprintCompatGapValue = (value) => {
  const text = String(value || '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${text.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const emptyState = () => ({
  version: COMPAT_GAP_REPORT_VERSION,
  updatedAt: 0,
  reports: [],
});

const normalizeReport = (value = {}) => {
  const input = value && typeof value === 'object' ? value : {};
  const scopeFingerprint = trimToken(input.scopeFingerprint, 80);
  const revisionFingerprint = trimToken(input.revisionFingerprint, 80);
  const api = sanitizeCompatGapApi(input.api);
  if (!scopeFingerprint || !revisionFingerprint || !api) return null;
  const status = input.status === 'confirmed' ? 'confirmed' : 'candidate';
  const firstSeenAt = toTimestamp(input.firstSeenAt);
  const lastSeenAt = Math.max(firstSeenAt, toTimestamp(input.lastSeenAt, firstSeenAt));
  return {
    id: trimToken(input.id, 96) || `gap-${fingerprintCompatGapValue(`${scopeFingerprint}|${revisionFingerprint}|${api}`)}`,
    scopeFingerprint,
    revisionFingerprint,
    api,
    status,
    phase: trimToken(input.phase, 32) || (status === 'confirmed' ? 'runtime' : 'shim_access'),
    errorCategory: trimToken(input.errorCategory, 48),
    errorFingerprint: trimToken(input.errorFingerprint, 80),
    appVersion: trimToken(input.appVersion, 48),
    scriptName: trimToken(input.scriptName, 80),
    firstSeenAt,
    lastSeenAt,
    candidateCount: Math.max(0, Math.trunc(Number(input.candidateCount) || 0)),
    confirmedCount: Math.max(0, Math.trunc(Number(input.confirmedCount) || 0)),
  };
};

export const normalizeCompatGapReportState = (value, { limit = COMPAT_GAP_REPORT_LIMIT } = {}) => {
  const input = value && typeof value === 'object' ? value : {};
  const max = Math.max(1, Math.trunc(Number(limit) || COMPAT_GAP_REPORT_LIMIT));
  const deduped = new Map();
  (Array.isArray(input.reports) ? input.reports : []).forEach((raw) => {
    const report = normalizeReport(raw);
    if (!report) return;
    const key = `${report.scopeFingerprint}|${report.revisionFingerprint}|${report.api}`;
    const previous = deduped.get(key);
    if (!previous || report.lastSeenAt >= previous.lastSeenAt) deduped.set(key, report);
  });
  const reports = Array.from(deduped.values())
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
    .slice(-max);
  return {
    version: COMPAT_GAP_REPORT_VERSION,
    updatedAt: toTimestamp(input.updatedAt),
    reports,
  };
};

export const upsertCompatGapReport = (
  state,
  input = {},
  { now = Date.now(), limit = COMPAT_GAP_REPORT_LIMIT } = {},
) => {
  const timestamp = toTimestamp(now, Date.now());
  const next = normalizeCompatGapReportState(state, { limit });
  const incoming = normalizeReport({
    ...input,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  });
  if (!incoming) return { state: next, report: null };
  const key = `${incoming.scopeFingerprint}|${incoming.revisionFingerprint}|${incoming.api}`;
  const index = next.reports.findIndex(report => (
    `${report.scopeFingerprint}|${report.revisionFingerprint}|${report.api}` === key
  ));
  const confirmed = incoming.status === 'confirmed';
  const previous = index >= 0 ? next.reports[index] : null;
  const report = {
    ...(previous || incoming),
    status: previous?.status === 'confirmed' || confirmed ? 'confirmed' : 'candidate',
    phase: confirmed ? (incoming.phase || 'runtime') : (previous?.phase || incoming.phase || 'shim_access'),
    errorCategory: confirmed ? incoming.errorCategory : (previous?.errorCategory || incoming.errorCategory),
    errorFingerprint: confirmed ? incoming.errorFingerprint : (previous?.errorFingerprint || incoming.errorFingerprint),
    appVersion: incoming.appVersion || previous?.appVersion || '',
    scriptName: incoming.scriptName || previous?.scriptName || '',
    firstSeenAt: previous ? Math.min(previous.firstSeenAt, timestamp) : timestamp,
    lastSeenAt: timestamp,
    candidateCount: (previous?.candidateCount || 0) + (confirmed ? 0 : 1),
    confirmedCount: (previous?.confirmedCount || 0) + (confirmed ? 1 : 0),
  };
  if (index >= 0) next.reports[index] = report;
  else next.reports.push(report);
  const bounded = normalizeCompatGapReportState({
    ...next,
    updatedAt: timestamp,
    reports: next.reports,
  }, { limit });
  const stored = bounded.reports.find(item => item.id === report.id) || report;
  return { state: bounded, report: clone(stored) };
};

const formatTimestamp = (value) => {
  const timestamp = toTimestamp(value);
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return '-';
  }
};

export const formatCompatGapReports = (reports = []) => {
  const list = (Array.isArray(reports) ? reports : [])
    .map(normalizeReport)
    .filter(Boolean)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  if (!list.length) return '暂无兼容缺口记录';
  return list.map((report, index) => [
    `${index + 1}. [${report.status === 'confirmed' ? 'CONFIRMED' : 'CANDIDATE'}] api=${report.api}${
      report.scriptName || report.phase === 'tavern_api' ? ` script=${report.scriptName || '-'}` : ''}`,
    `   scope=${report.scopeFingerprint} revision=${report.revisionFingerprint}`,
    `   phase=${report.phase || '-'} category=${report.errorCategory || '-'} error=${report.errorFingerprint || '-'}`,
    `   candidate=${report.candidateCount} confirmed=${report.confirmedCount} app=${report.appVersion || '-'}`,
    `   first=${formatTimestamp(report.firstSeenAt)} last=${formatTimestamp(report.lastSeenAt)}`,
  ].join('\n')).join('\n\n');
};

const readLocalState = (storage, key, limit) => {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return emptyState();
    return normalizeCompatGapReportState(JSON.parse(raw), { limit });
  } catch {
    return emptyState();
  }
};

const writeLocalState = (storage, key, state) => {
  try {
    storage?.setItem?.(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

const defaultGetAppVersion = async () => {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '';
  }
};

export class CompatGapReportStore {
  constructor({
    key = COMPAT_GAP_REPORT_STORE_KEY,
    limit = COMPAT_GAP_REPORT_LIMIT,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    loadKv = name => safeInvoke('load_kv', { name }),
    saveKv = (name, data) => safeInvoke('save_kv', { name, data }),
    getAppVersion = defaultGetAppVersion,
    now = () => Date.now(),
    persistDebounceMs = 3000,
  } = {}) {
    this.key = key;
    this.limit = Math.max(1, Math.trunc(Number(limit) || COMPAT_GAP_REPORT_LIMIT));
    this.storage = storage;
    this.loadKv = loadKv;
    this.saveKv = saveKv;
    this.getAppVersion = getAppVersion;
    this.now = now;
    this.persistDebounceMs = Math.max(0, Math.trunc(Number(persistDebounceMs) || 0));
    this.state = readLocalState(this.storage, this.key, this.limit);
    this.appVersion = '';
    this.writeQueue = Promise.resolve();
    this.kvFlushTimer = null;
    this.kvDirty = false;
    this.ready = this.load();
  }

  async flushKvNow() {
    if (this.kvFlushTimer) {
      clearTimeout(this.kvFlushTimer);
      this.kvFlushTimer = null;
    }
    this.kvDirty = false;
    await this.saveKv?.(this.key, clone(this.state));
  }

  // 计数/lastSeenAt 级更新只标脏延迟合并写 KV；localStorage 每次都同步写、
  // load() 按 updatedAt 取新，所以 KV 滞后不会丢数据。
  scheduleKvFlush() {
    this.kvDirty = true;
    if (this.kvFlushTimer || !this.persistDebounceMs) {
      if (!this.persistDebounceMs) {
        const run = async () => {
          try {
            await this.flushKvNow();
          } catch {}
        };
        this.writeQueue = this.writeQueue.then(run, run);
      }
      return;
    }
    this.kvFlushTimer = setTimeout(() => {
      this.kvFlushTimer = null;
      if (!this.kvDirty) return;
      const run = async () => {
        try {
          await this.flushKvNow();
        } catch {}
      };
      this.writeQueue = this.writeQueue.then(run, run);
    }, this.persistDebounceMs);
    if (typeof this.kvFlushTimer?.unref === 'function') this.kvFlushTimer.unref();
  }

  async load() {
    const localState = this.state;
    const [diskResult, versionResult] = await Promise.allSettled([
      this.loadKv?.(this.key),
      this.getAppVersion?.(),
    ]);
    const diskState = diskResult.status === 'fulfilled' && diskResult.value && typeof diskResult.value === 'object'
      ? normalizeCompatGapReportState(diskResult.value, { limit: this.limit })
      : emptyState();
    this.state = diskState.updatedAt >= localState.updatedAt ? diskState : localState;
    this.appVersion = versionResult.status === 'fulfilled' ? trimToken(versionResult.value, 48) : '';
    return this.state;
  }

  record(input = {}) {
    const run = async () => {
      await this.ready;
      const beforeReports = this.state.reports;
      const result = upsertCompatGapReport(this.state, {
        ...input,
        appVersion: input.appVersion || this.appVersion,
      }, {
        now: this.now(),
        limit: this.limit,
      });
      if (!result.report) return null;
      const before = beforeReports.find(report => report.id === result.report.id) || null;
      const material = !before
        || before.status !== result.report.status
        || before.errorCategory !== result.report.errorCategory
        || before.errorFingerprint !== result.report.errorFingerprint
        || before.appVersion !== result.report.appVersion;
      this.state = result.state;
      writeLocalState(this.storage, this.key, this.state);
      if (material) {
        try {
          await this.flushKvNow();
        } catch {}
      } else {
        this.scheduleKvFlush();
      }
      return result.report;
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  async getReports() {
    await this.ready;
    await this.writeQueue;
    return clone(this.state.reports).sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  async clear() {
    const run = async () => {
      await this.ready;
      this.state = { ...emptyState(), updatedAt: toTimestamp(this.now(), Date.now()) };
      writeLocalState(this.storage, this.key, this.state);
      try {
        await this.flushKvNow();
      } catch {}
      return true;
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }
}

let compatGapReportStore = null;

export const getCompatGapReportStore = () => {
  if (!compatGapReportStore) compatGapReportStore = new CompatGapReportStore();
  return compatGapReportStore;
};

