import { safeInvoke } from '../utils/tauri.js';

export const CAPABILITY_RETRIEVAL_STORE_KEY = 'capability_retrieval_store_v2';
export const CAPABILITY_RETRIEVAL_STORE_VERSION = 2;
export const CAPABILITY_RETRIEVAL_COUNTER_VERSION = 1;
// 开发期旧口径 key，load 时顺手清除（旧聚合不迁入 v2，见 PROGRESS 2026-07-10）。
const LEGACY_STORE_KEYS = ['capability_retrieval_store_v1'];

const DEFAULT_MAX_SNAPSHOTS = 500;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_DELAY_MS = 1500;
const MAX_AGGREGATES = 160;
const MAX_COUNTER_DAILY_BUCKETS = 45;

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const getTauriInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return g?.__TAURI__?.core?.invoke
    || g?.__TAURI__?.invoke
    || g?.__TAURI_INVOKE__
    || g?.__TAURI_INTERNALS__?.invoke;
};
const hasStoreStateShape = value => Boolean(
  isPlainObject(value)
  && !value._tooLarge
  && (
    Object.prototype.hasOwnProperty.call(value, 'version')
    || Object.prototype.hasOwnProperty.call(value, 'snapshots')
    || Object.prototype.hasOwnProperty.call(value, 'aggregates')
    || Object.prototype.hasOwnProperty.call(value, 'monotonicCounters')
  )
);

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clone = (value, fallback = null) => {
  if (value === undefined) return fallback;
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const normalizeReasonCodes = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item).slice(0, 60))
  .filter(Boolean)
  .slice(0, 6);

const normalizeCandidateRef = (raw = {}, index = 0) => {
  const src = isPlainObject(raw) ? raw : {};
  const id = trim(src.id).slice(0, 120);
  if (!id) return null;
  return {
    id,
    version: trim(src.version, '1').slice(0, 40),
    kind: trim(src.kind, 'tool').slice(0, 40),
    rank: Math.max(1, Math.trunc(finite(src.rank, index + 1))),
    score: Math.max(0, Math.round(finite(src.score, 0) * 100) / 100),
    reasonCodes: normalizeReasonCodes(src.reasonCodes || src.reasons),
  };
};

const normalizeCohort = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  return {
    provider: trim(src.provider).slice(0, 60),
    model: trim(src.model).slice(0, 120),
    profileId: trim(src.profileId).slice(0, 80),
    uiMode: trim(src.uiMode).slice(0, 40),
    activePage: trim(src.activePage).slice(0, 60),
    language: trim(src.language).slice(0, 20),
    taskDomain: trim(src.taskDomain).slice(0, 60),
    riskLevel: trim(src.riskLevel).slice(0, 20),
    maidContextVersion: trim(src.maidContextVersion, 'unknown').slice(0, 80),
  };
};

const OUTCOME_VALUES = new Set(['verified', 'verification_failed', 'succeeded', 'failed', 'denied', 'cancelled']);

export const normalizeCapabilityRetrievalSnapshot = (raw = {}, {
  now = Date.now,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const createdAt = Math.max(0, finite(src.createdAt, now?.() || Date.now()));
  const candidates = (Array.isArray(src.candidates) ? src.candidates : [])
    .map(normalizeCandidateRef)
    .filter(Boolean)
    .slice(0, 16);
  return {
    id: trim(src.id).slice(0, 160),
    requestId: trim(src.requestId).slice(0, 160),
    phase: trim(src.phase, 'planner').slice(0, 40),
    mode: trim(src.mode, 'shadow').slice(0, 40),
    effectiveMode: trim(src.effectiveMode, 'shadow').slice(0, 40),
    retrieverVersion: trim(src.retrieverVersion, 'unknown').slice(0, 80),
    createdAt,
    latencyMs: Math.max(0, Math.round(finite(src.latencyMs, 0))),
    candidates,
    candidateCount: Math.max(0, Math.trunc(finite(src.candidateCount, candidates.length))),
    selectedCapabilityId: trim(src.selectedCapabilityId).slice(0, 120),
    selectedToolName: trim(src.selectedToolName).slice(0, 120),
    selectedRank: Math.max(0, Math.trunc(finite(src.selectedRank, 0))),
    reciprocalRank: Math.max(0, Math.min(1, finite(src.reciprocalRank, 0))),
    candidateHit: src.candidateHit === true,
    candidateViolation: src.candidateViolation === true,
    metricEligible: src.metricEligible !== false,
    validSelection: src.validSelection === true,
    policyExcluded: src.policyExcluded === true,
    estimatedFullSchemaTokens: Math.max(0, Math.trunc(finite(src.estimatedFullSchemaTokens, 0))),
    estimatedCandidateSchemaTokens: Math.max(0, Math.trunc(finite(src.estimatedCandidateSchemaTokens, 0))),
    correction: isPlainObject(src.correction) ? {
      originalId: trim(src.correction.originalId).slice(0, 120),
      resolvedId: trim(src.correction.resolvedId).slice(0, 120),
      rule: trim(src.correction.rule).slice(0, 60),
      confidence: Math.max(0, Math.min(1, finite(src.correction.confidence, 0))),
    } : null,
    missAttribution: isPlainObject(src.missAttribution) && src.missAttribution.attributed !== false ? {
      attributed: true,
      code: trim(src.missAttribution.code, 'manually_attributed').slice(0, 80),
      attributedAt: Math.max(0, finite(src.missAttribution.attributedAt, 0)),
    } : null,
    // 选中的能力最后做成了没有（见 maid-run-outcomes.js）：命中候选不等于做成
    outcome: isPlainObject(src.outcome) && OUTCOME_VALUES.has(trim(src.outcome.outcome)) ? {
      outcome: trim(src.outcome.outcome),
      verification: ['verified', 'failed'].includes(trim(src.outcome.verification)) ? trim(src.outcome.verification) : 'none',
      toolName: trim(src.outcome.toolName).slice(0, 120),
      recordedAt: Math.max(0, finite(src.outcome.recordedAt, 0)),
    } : null,
    cohort: normalizeCohort(src.cohort),
  };
};

const buildAggregateKey = (snapshot = {}) => [
  trim(snapshot.retrieverVersion, 'unknown'),
  trim(snapshot.mode, 'shadow'),
  trim(snapshot.effectiveMode, 'shadow'),
  trim(snapshot.cohort?.provider, '-'),
  trim(snapshot.cohort?.model, '-'),
  trim(snapshot.cohort?.uiMode, '-'),
  trim(snapshot.cohort?.language, '-'),
  trim(snapshot.cohort?.taskDomain, '-'),
  trim(snapshot.cohort?.riskLevel, '-'),
  trim(snapshot.cohort?.maidContextVersion, 'unknown'),
].join('|').slice(0, 420);

const normalizeAggregate = (raw = {}, key = '') => {
  const src = isPlainObject(raw) ? raw : {};
  return {
    key: trim(src.key || key).slice(0, 420),
    retrieverVersion: trim(src.retrieverVersion, 'unknown').slice(0, 80),
    mode: trim(src.mode, 'shadow').slice(0, 40),
    effectiveMode: trim(src.effectiveMode, 'shadow').slice(0, 40),
    cohort: normalizeCohort(src.cohort),
    decisionCount: Math.max(0, Math.trunc(finite(src.decisionCount, 0))),
    candidateCountTotal: Math.max(0, Math.trunc(finite(src.candidateCountTotal, 0))),
    validSelectionCount: Math.max(0, Math.trunc(finite(src.validSelectionCount, 0))),
    hitCount: Math.max(0, Math.trunc(finite(src.hitCount, 0))),
    missCount: Math.max(0, Math.trunc(finite(src.missCount, 0))),
    reciprocalRankTotal: Math.max(0, finite(src.reciprocalRankTotal, 0)),
    candidateViolationCount: Math.max(0, Math.trunc(finite(src.candidateViolationCount, 0))),
    correctionCount: Math.max(0, Math.trunc(finite(src.correctionCount, 0))),
    policyExcludedCount: Math.max(0, Math.trunc(finite(src.policyExcludedCount, 0))),
    schemaTokenSampleCount: Math.max(0, Math.trunc(finite(src.schemaTokenSampleCount, 0))),
    estimatedFullSchemaTokensTotal: Math.max(0, Math.trunc(finite(src.estimatedFullSchemaTokensTotal, 0))),
    estimatedCandidateSchemaTokensTotal: Math.max(0, Math.trunc(finite(src.estimatedCandidateSchemaTokensTotal, 0))),
    runCount: Math.max(0, Math.trunc(finite(src.runCount, 0))),
    runCoveredCount: Math.max(0, Math.trunc(finite(src.runCoveredCount, 0))),
    updatedAt: Math.max(0, finite(src.updatedAt, 0)),
  };
};

const capSnapshots = (snapshots = [], maxSnapshots = DEFAULT_MAX_SNAPSHOTS) => {
  const limit = Math.max(1, Math.trunc(finite(maxSnapshots, DEFAULT_MAX_SNAPSHOTS)));
  const sorted = (Array.isArray(snapshots) ? snapshots : [])
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length <= limit) return sorted;
  const misses = sorted.filter(item => item.validSelection && !item.policyExcluded && !item.candidateHit);
  if (misses.length >= limit) return misses.slice(-limit);
  const missIds = new Set(misses.map(item => item.id));
  const recentOthers = sorted
    .filter(item => !missIds.has(item.id))
    .slice(-(limit - misses.length));
  return [...misses, ...recentOthers].sort((a, b) => a.createdAt - b.createdAt);
};

const toUtcDay = value => {
  const timestamp = Math.max(0, finite(value, 0));
  try {
    return new Date(timestamp).toISOString().slice(0, 10);
  } catch {
    return '1970-01-01';
  }
};

const normalizeCounterFields = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const missCount = Math.max(0, Math.trunc(finite(src.missCount, 0)));
  const attributedMissCount = Math.min(
    missCount,
    Math.max(0, Math.trunc(finite(src.attributedMissCount, 0))),
  );
  const unexplainedFallback = Math.max(0, missCount - attributedMissCount);
  const unexplainedMissCount = Math.min(
    unexplainedFallback,
    Math.max(0, Math.trunc(finite(src.unexplainedMissCount, unexplainedFallback))),
  );
  return {
    decisionCount: Math.max(0, Math.trunc(finite(src.decisionCount, 0))),
    validSelectionCount: Math.max(0, Math.trunc(finite(src.validSelectionCount, 0))),
    hitCount: Math.max(0, Math.trunc(finite(src.hitCount, 0))),
    missCount,
    policyExcludedCount: Math.max(0, Math.trunc(finite(src.policyExcludedCount, 0))),
    runCount: Math.max(0, Math.trunc(finite(src.runCount, 0))),
    runCoveredCount: Math.max(0, Math.trunc(finite(src.runCoveredCount, 0))),
    attributedMissCount,
    unexplainedMissCount,
  };
};

const normalizeDailyBuckets = raw => Object.fromEntries(
  Object.entries(isPlainObject(raw) ? raw : {})
    .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-MAX_COUNTER_DAILY_BUCKETS)
    .map(([day, value]) => [day, {
      day,
      ...normalizeCounterFields(value),
    }]),
);

const buildMonotonicPoolKey = (raw = {}) => [
  trim(raw.retrieverVersion, 'unknown'),
  trim(raw.cohort?.maidContextVersion || raw.maidContextVersion, 'unknown'),
  trim(raw.mode, 'shadow'),
].join('|').slice(0, 240);

const normalizeMonotonicPool = (raw = {}, key = '') => {
  const src = isPlainObject(raw) ? raw : {};
  return {
    key: trim(src.key || key).slice(0, 240),
    retrieverVersion: trim(src.retrieverVersion, 'unknown').slice(0, 80),
    maidContextVersion: trim(src.maidContextVersion, 'unknown').slice(0, 80),
    mode: trim(src.mode, 'shadow').slice(0, 40),
    firstSeenAt: Math.max(0, finite(src.firstSeenAt, 0)),
    lastSeenAt: Math.max(0, finite(src.lastSeenAt, 0)),
    ...normalizeCounterFields(src),
    dailyBuckets: normalizeDailyBuckets(src.dailyBuckets),
  };
};

const normalizeMonotonicCounters = (raw = {}, { now = Date.now } = {}) => {
  const currentTime = Math.max(0, finite(now?.(), Date.now()));
  const src = isPlainObject(raw) && Number(raw.version || 0) === CAPABILITY_RETRIEVAL_COUNTER_VERSION
    ? raw
    : {};
  return {
    version: CAPABILITY_RETRIEVAL_COUNTER_VERSION,
    startedAt: Math.max(0, finite(src.startedAt, currentTime)),
    pools: Object.fromEntries(
      Object.entries(isPlainObject(src.pools) ? src.pools : {})
        .map(([key, value]) => [key, normalizeMonotonicPool(value, key)]),
    ),
  };
};

const ensureMonotonicPool = (measurement, raw = {}, timestamp = 0) => {
  const key = buildMonotonicPoolKey(raw);
  const pool = normalizeMonotonicPool(measurement.pools[key], key);
  pool.retrieverVersion = trim(raw.retrieverVersion, pool.retrieverVersion);
  pool.maidContextVersion = trim(
    raw.cohort?.maidContextVersion || raw.maidContextVersion,
    pool.maidContextVersion,
  );
  pool.mode = trim(raw.mode, pool.mode);
  const seenAt = Math.max(0, finite(timestamp, 0));
  pool.firstSeenAt = pool.firstSeenAt > 0
    ? Math.min(pool.firstSeenAt, seenAt || pool.firstSeenAt)
    : seenAt;
  pool.lastSeenAt = Math.max(pool.lastSeenAt, seenAt);
  measurement.pools[key] = pool;
  return pool;
};

const ensureDailyBucket = (pool, timestamp = 0) => {
  const day = toUtcDay(timestamp);
  const bucket = {
    day,
    ...normalizeCounterFields(pool.dailyBuckets?.[day]),
  };
  pool.dailyBuckets = {
    ...(pool.dailyBuckets || {}),
    [day]: bucket,
  };
  pool.dailyBuckets = normalizeDailyBuckets(pool.dailyBuckets);
  return pool.dailyBuckets[day] || bucket;
};

const incrementDecisionCounters = (pool, snapshot) => {
  const bucket = ensureDailyBucket(pool, snapshot.createdAt);
  pool.decisionCount += 1;
  bucket.decisionCount += 1;
  if (snapshot.policyExcluded) {
    pool.policyExcludedCount += 1;
    bucket.policyExcludedCount += 1;
    return;
  }
  if (!snapshot.validSelection) return;
  pool.validSelectionCount += 1;
  bucket.validSelectionCount += 1;
  if (snapshot.candidateHit) {
    pool.hitCount += 1;
    bucket.hitCount += 1;
    return;
  }
  pool.missCount += 1;
  bucket.missCount += 1;
  if (snapshot.missAttribution) {
    pool.attributedMissCount += 1;
    bucket.attributedMissCount += 1;
  } else {
    pool.unexplainedMissCount += 1;
    bucket.unexplainedMissCount += 1;
  }
};

export const normalizeCapabilityRetrievalStoreState = (raw = {}, {
  now = Date.now,
  maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
  ttlMs = DEFAULT_TTL_MS,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const currentTime = Math.max(0, finite(now?.(), Date.now()));
  const cutoff = currentTime - Math.max(60_000, finite(ttlMs, DEFAULT_TTL_MS));
  const snapshots = (Array.isArray(src.snapshots) ? src.snapshots : [])
    .map(item => normalizeCapabilityRetrievalSnapshot(item, { now }))
    .filter(item => item.id && item.createdAt >= cutoff);
  const cappedSnapshots = capSnapshots(snapshots, maxSnapshots);
  const aggregateSource = Number(src.version || 0) === CAPABILITY_RETRIEVAL_STORE_VERSION
    ? src.aggregates
    : {};
  const aggregates = Object.fromEntries(
    Object.entries(isPlainObject(aggregateSource) ? aggregateSource : {})
      .map(([key, value]) => [key, normalizeAggregate(value, key)])
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_AGGREGATES),
  );
  return {
    version: CAPABILITY_RETRIEVAL_STORE_VERSION,
    updatedAt: Math.max(0, finite(src.updatedAt, currentTime)),
    snapshots: cappedSnapshots,
    aggregates,
    monotonicCounters: normalizeMonotonicCounters(src.monotonicCounters, { now }),
  };
};

const readLocalJson = (storage, key) => {
  try {
    const raw = storage?.getItem?.(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeLocalJson = (storage, key, value) => {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return Boolean(storage);
  } catch {
    return false;
  }
};

const defaultLoadKv = name => safeInvoke('load_kv', { name });
const defaultSaveKv = (name, data) => safeInvoke('save_kv', { name, data });

export class CapabilityRetrievalStore {
  constructor({
    storage = globalThis?.localStorage || null,
    loadKv = defaultLoadKv,
    saveKv = defaultSaveKv,
    now = Date.now,
    maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
    ttlMs = DEFAULT_TTL_MS,
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
    setTimeoutFn = globalThis?.setTimeout?.bind(globalThis) || null,
    clearTimeoutFn = globalThis?.clearTimeout?.bind(globalThis) || null,
  } = {}) {
    this.storage = storage;
    this.loadKv = typeof loadKv === 'function' ? loadKv : null;
    this.saveKv = typeof saveKv === 'function' ? saveKv : null;
    this.now = typeof now === 'function' ? now : Date.now;
    this.maxSnapshots = Math.max(1, Math.trunc(finite(maxSnapshots, DEFAULT_MAX_SNAPSHOTS)));
    this.ttlMs = Math.max(60_000, finite(ttlMs, DEFAULT_TTL_MS));
    this.flushDelayMs = Math.max(0, finite(flushDelayMs, DEFAULT_FLUSH_DELAY_MS));
    this.setTimeoutFn = typeof setTimeoutFn === 'function' ? setTimeoutFn : null;
    this.clearTimeoutFn = typeof clearTimeoutFn === 'function' ? clearTimeoutFn : null;
    this.state = normalizeCapabilityRetrievalStoreState({}, {
      now: this.now,
      maxSnapshots: this.maxSnapshots,
      ttlMs: this.ttlMs,
    });
    this.loaded = false;
    this.persistenceBlocked = false;
    this.writeChain = Promise.resolve();
    this.flushTimer = null;
  }

  async load() {
    for (const legacyKey of LEGACY_STORE_KEYS) {
      try {
        this.storage?.removeItem?.(legacyKey);
      } catch {}
    }
    const expectsKv = typeof getTauriInvoker() === 'function';
    const localRaw = readLocalJson(this.storage, CAPABILITY_RETRIEVAL_STORE_KEY);
    let raw = null;
    let kvMissing = false;
    let kvReadUncertain = false;
    let localSelectedOverKv = false;
    try {
      const kv = await this.loadKv?.(CAPABILITY_RETRIEVAL_STORE_KEY);
      if (hasStoreStateShape(kv)) {
        const localIsNewer = hasStoreStateShape(localRaw)
          && Number(localRaw.updatedAt || 0) > Number(kv.updatedAt || 0);
        localSelectedOverKv = localIsNewer;
        raw = localIsNewer ? localRaw : kv;
      } else if (isPlainObject(kv) && !Object.keys(kv).length) {
        kvMissing = true;
      } else if (expectsKv) {
        kvReadUncertain = true;
      }
    } catch {
      kvReadUncertain = expectsKv;
    }
    if (!raw) raw = localRaw;
    this.persistenceBlocked = kvReadUncertain;
    const needsCounterInitialization = Number(raw?.monotonicCounters?.version || 0)
      !== CAPABILITY_RETRIEVAL_COUNTER_VERSION;
    this.state = normalizeCapabilityRetrievalStoreState(raw || {}, {
      now: this.now,
      maxSnapshots: this.maxSnapshots,
      ttlMs: this.ttlMs,
    });
    this.loaded = true;
    if (expectsKv && !kvReadUncertain) {
      const shouldBackfillLocal = hasStoreStateShape(localRaw) && (
        kvMissing
        || localSelectedOverKv
      );
      if (shouldBackfillLocal) {
        try {
          await this.saveKv?.(CAPABILITY_RETRIEVAL_STORE_KEY, this.exportState());
          this.storage?.removeItem?.(CAPABILITY_RETRIEVAL_STORE_KEY);
        } catch {}
      } else if (hasStoreStateShape(raw)) {
        try { this.storage?.removeItem?.(CAPABILITY_RETRIEVAL_STORE_KEY); } catch {}
      }
    }
    if (needsCounterInitialization) this.scheduleFlush();
    return this.exportState();
  }

  ensureLoaded() {
    if (this.loaded) return;
    this.state = normalizeCapabilityRetrievalStoreState(
      readLocalJson(this.storage, CAPABILITY_RETRIEVAL_STORE_KEY) || {},
      { now: this.now, maxSnapshots: this.maxSnapshots, ttlMs: this.ttlMs },
    );
    this.loaded = true;
  }

  scheduleFlush() {
    if (!this.setTimeoutFn) return;
    if (this.flushTimer && this.clearTimeoutFn) this.clearTimeoutFn(this.flushTimer);
    this.flushTimer = this.setTimeoutFn(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  recordDecision(raw = {}) {
    this.ensureLoaded();
    const snapshot = normalizeCapabilityRetrievalSnapshot(raw, { now: this.now });
    if (!snapshot.id) return null;
    const existingIndex = this.state.snapshots.findIndex(item => item.id === snapshot.id);
    const isNewSnapshot = existingIndex < 0;
    // 同一快照再次记录（选择结果回填）时保留已挂上的执行结果
    if (existingIndex >= 0) this.state.snapshots[existingIndex] = { ...snapshot, outcome: snapshot.outcome || this.state.snapshots[existingIndex].outcome || null };
    else this.state.snapshots.push(snapshot);
    const currentTime = this.now();
    const cutoff = currentTime - this.ttlMs;
    this.state.snapshots = capSnapshots(
      this.state.snapshots.filter(item => Number(item?.createdAt || 0) >= cutoff),
      this.maxSnapshots,
    );
    this.state.updatedAt = currentTime;

    if (!snapshot.metricEligible) {
      this.scheduleFlush();
      return clone(snapshot);
    }

    const key = buildAggregateKey(snapshot);
    const aggregate = normalizeAggregate(this.state.aggregates[key], key);
    aggregate.retrieverVersion = snapshot.retrieverVersion;
    aggregate.mode = snapshot.mode;
    aggregate.effectiveMode = snapshot.effectiveMode;
    aggregate.cohort = snapshot.cohort;
    aggregate.decisionCount += 1;
    aggregate.candidateCountTotal += snapshot.candidateCount;
    if (snapshot.candidateViolation) aggregate.candidateViolationCount += 1;
    if (snapshot.correction) aggregate.correctionCount += 1;
    if (snapshot.estimatedFullSchemaTokens > 0 || snapshot.estimatedCandidateSchemaTokens > 0) {
      aggregate.schemaTokenSampleCount += 1;
      aggregate.estimatedFullSchemaTokensTotal += snapshot.estimatedFullSchemaTokens;
      aggregate.estimatedCandidateSchemaTokensTotal += snapshot.estimatedCandidateSchemaTokens;
    }
    if (snapshot.policyExcluded) {
      aggregate.policyExcludedCount += 1;
    } else if (snapshot.validSelection) {
      aggregate.validSelectionCount += 1;
      aggregate.reciprocalRankTotal += snapshot.reciprocalRank;
      if (snapshot.candidateHit) aggregate.hitCount += 1;
      else aggregate.missCount += 1;
    }
    aggregate.updatedAt = this.now();
    this.state.aggregates[key] = aggregate;
    if (isNewSnapshot) {
      const pool = ensureMonotonicPool(
        this.state.monotonicCounters,
        snapshot,
        snapshot.createdAt || currentTime,
      );
      incrementDecisionCounters(pool, snapshot);
    }
    this.scheduleFlush();
    return clone(snapshot);
  }

  recordRequestSummary(raw = {}) {
    this.ensureLoaded();
    const src = isPlainObject(raw) ? raw : {};
    const key = trim(src.aggregateKey) || buildAggregateKey({
      retrieverVersion: src.retrieverVersion,
      mode: src.mode,
      effectiveMode: src.effectiveMode,
      cohort: src.cohort,
    });
    const aggregate = normalizeAggregate(this.state.aggregates[key], key);
    aggregate.retrieverVersion = trim(src.retrieverVersion, aggregate.retrieverVersion);
    aggregate.mode = trim(src.mode, aggregate.mode);
    aggregate.effectiveMode = trim(src.effectiveMode, aggregate.effectiveMode);
    aggregate.cohort = normalizeCohort(src.cohort || aggregate.cohort);
    aggregate.runCount += 1;
    if (src.allValidSelectionsCovered === true) aggregate.runCoveredCount += 1;
    aggregate.updatedAt = this.now();
    this.state.aggregates[key] = aggregate;
    const currentTime = this.now();
    const pool = ensureMonotonicPool(
      this.state.monotonicCounters,
      {
        retrieverVersion: aggregate.retrieverVersion,
        mode: aggregate.mode,
        cohort: aggregate.cohort,
      },
      currentTime,
    );
    const bucket = ensureDailyBucket(pool, currentTime);
    pool.runCount += 1;
    bucket.runCount += 1;
    if (src.allValidSelectionsCovered === true) {
      pool.runCoveredCount += 1;
      bucket.runCoveredCount += 1;
    }
    this.state.updatedAt = this.now();
    this.scheduleFlush();
    return clone(aggregate);
  }

  recordMissAttribution(snapshotId = '', raw = {}) {
    this.ensureLoaded();
    const id = trim(snapshotId);
    if (!id) return null;
    const snapshot = this.state.snapshots.find(item => item.id === id);
    if (
      !snapshot
      || !snapshot.metricEligible
      || snapshot.policyExcluded
      || !snapshot.validSelection
      || snapshot.candidateHit
    ) {
      return null;
    }
    if (snapshot.missAttribution) return clone(snapshot);

    snapshot.missAttribution = {
      attributed: true,
      code: trim(raw?.code, 'manually_attributed').slice(0, 80),
      attributedAt: Math.max(0, finite(raw?.attributedAt, this.now())),
    };
    const pool = ensureMonotonicPool(
      this.state.monotonicCounters,
      snapshot,
      snapshot.createdAt || this.now(),
    );
    const bucket = ensureDailyBucket(pool, snapshot.createdAt || this.now());
    if (pool.unexplainedMissCount > 0) {
      pool.unexplainedMissCount -= 1;
      pool.attributedMissCount += 1;
    }
    if (bucket.unexplainedMissCount > 0) {
      bucket.unexplainedMissCount -= 1;
      bucket.attributedMissCount += 1;
    }
    pool.lastSeenAt = Math.max(pool.lastSeenAt, snapshot.missAttribution.attributedAt);
    this.state.updatedAt = this.now();
    this.scheduleFlush();
    return clone(snapshot);
  }

  // 把执行结果挂回选中它的那次检索快照；快照已被淘汰就略过
  recordOutcome(snapshotId = '', raw = {}) {
    this.ensureLoaded();
    const snapshot = this.state.snapshots.find(item => item.id === trim(snapshotId));
    const outcome = trim(raw?.outcome);
    if (!snapshot || !OUTCOME_VALUES.has(outcome)) return null;
    snapshot.outcome = {
      outcome,
      verification: ['verified', 'failed'].includes(trim(raw?.verification)) ? trim(raw.verification) : 'none',
      toolName: trim(raw?.toolName).slice(0, 120),
      recordedAt: this.now(),
    };
    this.state.updatedAt = this.now();
    this.scheduleFlush();
    return clone(snapshot);
  }

  listSnapshots({ requestId = '', limit = 0 } = {}) {
    this.ensureLoaded();
    const rid = trim(requestId);
    const count = Math.max(0, Math.trunc(finite(limit, 0)));
    const list = this.state.snapshots
      .filter(item => !rid || item.requestId === rid)
      .sort((a, b) => b.createdAt - a.createdAt);
    return (count > 0 ? list.slice(0, count) : list).map(item => clone(item));
  }

  getStats() {
    this.ensureLoaded();
    const aggregates = Object.values(this.state.aggregates).map(item => clone(item));
    const monotonicPools = Object.values(this.state.monotonicCounters?.pools || {})
      .map(item => clone(item))
      .sort((a, b) => Number(b?.lastSeenAt || 0) - Number(a?.lastSeenAt || 0));
    return {
      snapshotCount: this.state.snapshots.length,
      aggregateCount: aggregates.length,
      aggregates,
      counterVersion: this.state.monotonicCounters?.version || CAPABILITY_RETRIEVAL_COUNTER_VERSION,
      counterStartedAt: Number(this.state.monotonicCounters?.startedAt || 0),
      monotonicPools,
    };
  }

  getMonotonicStats({ rollingDays = 14 } = {}) {
    this.ensureLoaded();
    const days = Math.max(1, Math.min(MAX_COUNTER_DAILY_BUCKETS, Math.trunc(finite(rollingDays, 14))));
    const cutoff = toUtcDay(this.now() - ((days - 1) * 24 * 60 * 60 * 1000));
    const pools = Object.values(this.state.monotonicCounters?.pools || {}).map((item) => {
      const pool = clone(item, {});
      const rolling = normalizeCounterFields({});
      Object.entries(pool.dailyBuckets || {}).forEach(([day, bucket]) => {
        if (day < cutoff) return;
        const normalized = normalizeCounterFields(bucket);
        Object.keys(rolling).forEach((key) => {
          rolling[key] += normalized[key];
        });
      });
      return {
        ...pool,
        rollingDays: days,
        rolling,
      };
    });
    return {
      version: this.state.monotonicCounters?.version || CAPABILITY_RETRIEVAL_COUNTER_VERSION,
      startedAt: Number(this.state.monotonicCounters?.startedAt || 0),
      rollingDays: days,
      pools,
    };
  }

  exportState() {
    this.ensureLoaded();
    return clone(this.state, {
      version: CAPABILITY_RETRIEVAL_STORE_VERSION,
      updatedAt: this.now(),
      snapshots: [],
      aggregates: {},
      monotonicCounters: normalizeMonotonicCounters({}, { now: this.now }),
    });
  }

  async persist() {
    this.ensureLoaded();
    this.state = normalizeCapabilityRetrievalStoreState({
      ...this.state,
      updatedAt: this.now(),
    }, {
      now: this.now,
      maxSnapshots: this.maxSnapshots,
      ttlMs: this.ttlMs,
    });
    const payload = this.exportState();
    const expectsKv = typeof getTauriInvoker() === 'function';
    if (this.persistenceBlocked) {
      writeLocalJson(this.storage, CAPABILITY_RETRIEVAL_STORE_KEY, payload);
      return false;
    }
    if (expectsKv) {
      try {
        await this.saveKv?.(CAPABILITY_RETRIEVAL_STORE_KEY, payload);
        try { this.storage?.removeItem?.(CAPABILITY_RETRIEVAL_STORE_KEY); } catch {}
        return true;
      } catch {
        writeLocalJson(this.storage, CAPABILITY_RETRIEVAL_STORE_KEY, payload);
        return false;
      }
    }
    writeLocalJson(this.storage, CAPABILITY_RETRIEVAL_STORE_KEY, payload);
    try {
      await this.saveKv?.(CAPABILITY_RETRIEVAL_STORE_KEY, payload);
      return true;
    } catch {
      return false;
    }
  }

  flush() {
    if (this.flushTimer && this.clearTimeoutFn) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeChain = this.writeChain.then(() => this.persist()).catch(() => false);
    return this.writeChain;
  }

  clear() {
    this.state = normalizeCapabilityRetrievalStoreState({}, {
      now: this.now,
      maxSnapshots: this.maxSnapshots,
      ttlMs: this.ttlMs,
    });
    this.loaded = true;
    this.scheduleFlush();
  }
}
