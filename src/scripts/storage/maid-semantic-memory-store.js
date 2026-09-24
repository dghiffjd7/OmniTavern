import { safeInvoke } from '../utils/tauri.js';

export const MAID_SEMANTIC_MEMORY_STORE_VERSION = 1;
export const MAID_SEMANTIC_MEMORY_STORE_KEY = 'maid_semantic_memory_store_v1';
export const MAID_SEMANTIC_MEMORY_MAX_RECORDS = 1000;

export const MAID_SEMANTIC_MEMORY_KINDS = Object.freeze([
  'preference',
  'decision',
  'resource_state',
  'relationship',
  'task_state',
  'important_event',
]);

export const MAID_SEMANTIC_MEMORY_STATUSES = Object.freeze([
  'active',
  'resolved',
  'stale',
  'archived',
]);

export const MAID_SEMANTIC_MEMORY_CONFIDENCES = Object.freeze([
  'inferred',
  'verified',
  'explicit',
]);

const KIND_SET = new Set(MAID_SEMANTIC_MEMORY_KINDS);
const STATUS_SET = new Set(MAID_SEMANTIC_MEMORY_STATUSES);
const CONFIDENCE_SET = new Set(MAID_SEMANTIC_MEMORY_CONFIDENCES);
const RESOURCE_TYPE_SET = new Set([
  'worldbook',
  'session',
  'group',
  'persona',
  'user',
  'preset',
  'regex',
  'script',
  'variable',
  'moment',
  'api',
]);
const KEY_ROOTS_BY_KIND = Object.freeze({
  preference: new Set(['presentation', 'response', 'workflow', 'format', 'language', 'privacy', 'model', 'content']),
  decision: new Set(['presentation', 'workflow', 'format', 'resource', 'feature', 'model', 'content']),
  resource_state: new Set(['resource_state']),
  relationship: new Set(['relationship']),
  task_state: new Set(['task']),
  important_event: new Set(['event']),
});
const CONFIDENCE_RANK = Object.freeze({
  inferred: 1,
  verified: 2,
  explicit: 3,
});

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const safeNow = (now = Date.now) => {
  try {
    const value = typeof now === 'function' ? now() : Date.now();
    return Number.isFinite(Number(value)) ? Number(value) : Date.now();
  } catch {
    return Date.now();
  }
};

const truncate = (value = '', max = 8000) => {
  const text = trim(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

const uniqueStrings = (values = [], limit = 200) => Array.from(new Set(
  (Array.isArray(values) ? values : [])
    .map(item => trim(item))
    .filter(Boolean),
)).slice(0, limit);

const readLocalJson = (storage, key = '') => {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw || typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeLocalJson = (storage, key = '', value = {}) => {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const loadKvDefault = async key => safeInvoke('load_kv', { name: key });
const saveKvDefault = async (key, value) => safeInvoke('save_kv', { name: key, data: value });

const selectAuthoritativeState = (localRaw = null, kvRaw = null) => {
  const local = isPlainObject(localRaw) ? localRaw : null;
  const kv = isPlainObject(kvRaw) && kvRaw._tooLarge !== true ? kvRaw : null;
  if (!local) return kv || {};
  if (!kv) return local;
  return Number(kv.updatedAt || 0) >= Number(local.updatedAt || 0) ? kv : local;
};

const stableHash = (value = '') => {
  let hash = 2166136261;
  for (const ch of String(value ?? '').normalize('NFKC')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const normalizeResourceType = value => trim(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '');

const normalizeResourceRef = (raw = null) => {
  if (!isPlainObject(raw)) return null;
  const type = normalizeResourceType(raw.type);
  const id = trim(raw.id);
  if (!RESOURCE_TYPE_SET.has(type) || !id) return null;
  return { type, id };
};

export const buildMaidResourceStateKey = (resourceType = '', resourceId = '') => {
  const type = normalizeResourceType(resourceType);
  const id = trim(resourceId);
  if (!RESOURCE_TYPE_SET.has(type) || !id) return '';
  const slug = id
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'id';
  return `resource_state.${type}.${slug}_${stableHash(id)}`;
};

export const validateMaidSemanticMemoryKey = (rawKey = '', {
  kind = '',
  resourceRef = null,
  candidateKeys = null,
  keyOrigin = 'deterministic',
} = {}) => {
  const key = trim(rawKey).toLowerCase();
  const normalizedKind = trim(kind).toLowerCase();
  if (!KIND_SET.has(normalizedKind)) return { ok: false, reason: 'invalid_kind', key };
  if (
    !key ||
    key.length > 180 ||
    !/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){1,5}$/.test(key)
  ) {
    return { ok: false, reason: 'invalid_key_format', key };
  }
  const root = key.split('.')[0];
  if (!KEY_ROOTS_BY_KIND[normalizedKind]?.has(root)) {
    return { ok: false, reason: 'invalid_key_root', key };
  }
  if (keyOrigin === 'candidate') {
    const allowed = new Set(uniqueStrings(candidateKeys, 100).map(item => item.toLowerCase()));
    if (!allowed.has(key)) return { ok: false, reason: 'key_not_in_candidates', key };
  }
  if (normalizedKind === 'resource_state') {
    const normalizedResource = normalizeResourceRef(resourceRef);
    if (!normalizedResource) return { ok: false, reason: 'resource_ref_required', key };
    const expected = buildMaidResourceStateKey(normalizedResource.type, normalizedResource.id);
    if (key !== expected) return { ok: false, reason: 'resource_key_mismatch', key, expected };
  }
  return { ok: true, key };
};

const normalizeComparableText = value => trim(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .slice(0, 300);

const lcsSimilarity = (left = '', right = '') => {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = new Uint16Array(b.length + 1);
  const current = new Uint16Array(b.length + 1);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = a[aIndex - 1] === b[bIndex - 1]
        ? previous[bIndex - 1] + 1
        : Math.max(previous[bIndex], current[bIndex - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  return (2 * previous[b.length]) / (a.length + b.length);
};

const getKeyFamily = key => trim(key).toLowerCase().split('.')[0];

const getCrossKeyMergeFamily = (memory = {}) => {
  if (trim(memory?.kind).toLowerCase() !== 'preference') return '';
  const key = trim(memory?.key).toLowerCase();
  if (key === 'presentation.default' || key === 'workflow.confirmation') {
    return 'preference:presentation_visibility';
  }
  return '';
};

const getMemoryMergeFamily = (memory = {}) => (
  getCrossKeyMergeFamily(memory) ||
  `${trim(memory?.kind).toLowerCase()}:${getKeyFamily(memory?.key)}`
);

const isKnownCrossKeyPair = (left = {}, right = {}) => (
  trim(left?.key).toLowerCase() !== trim(right?.key).toLowerCase() &&
  Boolean(getCrossKeyMergeFamily(left)) &&
  getCrossKeyMergeFamily(left) === getCrossKeyMergeFamily(right)
);

export const areMaidSemanticMemoriesNearDuplicate = (left = {}, right = {}) => {
  if (
    trim(left?.scopeId) !== trim(right?.scopeId) ||
    trim(left?.kind) !== trim(right?.kind) ||
    getMemoryMergeFamily(left) !== getMemoryMergeFamily(right)
  ) return false;
  if (trim(left?.kind) === 'resource_state') {
    const leftRef = normalizeResourceRef(left?.resourceRef);
    const rightRef = normalizeResourceRef(right?.resourceRef);
    if (!leftRef || !rightRef || leftRef.type !== rightRef.type || leftRef.id !== rightRef.id) return false;
  }
  const leftText = normalizeComparableText(left?.content);
  const rightText = normalizeComparableText(right?.content);
  if (!leftText || !rightText) return false;
  const knownCrossKeyPair = isKnownCrossKeyPair(left, right);
  const hasContainment = (
    Math.min(leftText.length, rightText.length) >= 8 &&
    (leftText.includes(rightText) || rightText.includes(leftText))
  );
  if (
    trim(left?.confidence) === 'explicit' &&
    trim(right?.confidence) === 'explicit' &&
    leftText !== rightText &&
    !(knownCrossKeyPair && hasContainment)
  ) return false;
  if (knownCrossKeyPair && hasContainment) return true;
  return lcsSimilarity(leftText, rightText) >= 0.84;
};

export const normalizeMaidSemanticMemory = (raw = {}, {
  scopeId = 'maid_default',
  now = Date.now,
  fallbackId = '',
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const at = safeNow(now);
  const kind = KIND_SET.has(trim(src.kind).toLowerCase()) ? trim(src.kind).toLowerCase() : 'important_event';
  const status = STATUS_SET.has(trim(src.status).toLowerCase()) ? trim(src.status).toLowerCase() : 'active';
  const confidence = CONFIDENCE_SET.has(trim(src.confidence).toLowerCase())
    ? trim(src.confidence).toLowerCase()
    : 'inferred';
  const createdAt = Number(src.createdAt || at) || at;
  return {
    id: trim(src.id, fallbackId || `maid_semantic_${at}_${stableHash(`${kind}:${src.key}:${src.content}`)}`),
    scopeId: trim(src.scopeId, scopeId),
    kind,
    key: trim(src.key).toLowerCase(),
    content: truncate(src.content, 8000),
    tags: uniqueStrings(src.tags, 20),
    status,
    confidence,
    sourceTurnIds: uniqueStrings(src.sourceTurnIds, 200),
    resourceRef: normalizeResourceRef(src.resourceRef),
    createdAt,
    updatedAt: Number(src.updatedAt || createdAt) || createdAt,
    lastUsedAt: Number(src.lastUsedAt || 0) || 0,
  };
};

const normalizeStoreState = (raw = {}, { scopeId = 'maid_default', now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const resolvedScope = trim(scopeId, 'maid_default');
  return {
    version: MAID_SEMANTIC_MEMORY_STORE_VERSION,
    scopeId: resolvedScope,
    updatedAt: Number(src.updatedAt || safeNow(now)) || safeNow(now),
    memories: (Array.isArray(src.memories) ? src.memories : [])
      .map((memory, index) => normalizeMaidSemanticMemory(memory, {
        scopeId: resolvedScope,
        now,
        fallbackId: `maid_semantic_imported_${index + 1}`,
      }))
      .filter(memory => memory.scopeId === resolvedScope && memory.key && memory.content),
  };
};

const normalizeValidationResult = (raw) => {
  if (raw === true) return 'found';
  if (raw === false) return 'not_found';
  if (!isPlainObject(raw)) return 'unavailable';
  const status = trim(raw.status).toLowerCase();
  if (['found', 'exists', 'active'].includes(status)) return 'found';
  if (['not_found', 'missing', 'deleted'].includes(status)) return 'not_found';
  if (['unavailable', 'unknown', 'error', 'forbidden'].includes(status)) return 'unavailable';
  if (raw.exists === true || raw.ok === true) return 'found';
  if (raw.exists === false && ['not_found', 'missing'].includes(trim(raw.reason).toLowerCase())) return 'not_found';
  return 'unavailable';
};

const normalizeRetrievalText = value => trim(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const buildRetrievalTerms = (query = '') => {
  const normalized = normalizeRetrievalText(query);
  if (!normalized) return [];
  const terms = new Set();
  normalized.split(/\s+/).filter(Boolean).forEach((chunk) => {
    if (chunk.length >= 2) terms.add(chunk);
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(chunk)) {
      for (let size = 2; size <= Math.min(4, chunk.length); size += 1) {
        for (let index = 0; index + size <= chunk.length && terms.size < 80; index += 1) {
          terms.add(chunk.slice(index, index + size));
        }
      }
    }
  });
  return Array.from(terms);
};

const scoreMemoryForRetrieval = (memory = {}, query = '') => {
  const normalizedQuery = normalizeRetrievalText(query);
  if (!normalizedQuery) return { score: 0, reasons: [] };
  const terms = buildRetrievalTerms(query);
  const key = normalizeRetrievalText(memory?.key);
  const content = normalizeRetrievalText(memory?.content);
  const tags = normalizeRetrievalText(Array.isArray(memory?.tags) ? memory.tags.join(' ') : '');
  const resource = normalizeRetrievalText([
    memory?.resourceRef?.type,
    memory?.resourceRef?.id,
  ].filter(Boolean).join(' '));
  const full = `${key} ${tags} ${resource} ${content}`.trim();
  const reasons = new Set();
  let score = 0;
  if (full.includes(normalizedQuery)) {
    score += 40;
    reasons.add('phrase_match');
  }
  if (resource && (
    resource.includes(normalizedQuery) ||
    normalizedQuery.includes(resource) ||
    (memory?.resourceRef?.id && normalizedQuery.includes(normalizeRetrievalText(memory.resourceRef.id)))
  )) {
    score += 32;
    reasons.add('resource_match');
  }
  if (key && (key.includes(normalizedQuery) || normalizedQuery.includes(key))) {
    score += 24;
    reasons.add('key_match');
  }
  terms.forEach((term) => {
    if (resource.includes(term)) {
      score += 8;
      reasons.add('resource_match');
    }
    if (tags.includes(term)) {
      score += 6;
      reasons.add('tag_match');
    }
    if (key.includes(term)) {
      score += 5;
      reasons.add('key_match');
    }
    if (content.includes(term)) {
      score += 2;
      reasons.add('content_match');
    }
  });
  return { score, reasons: Array.from(reasons) };
};

export const getMaidSemanticMemoryStorageKey = (scopeId = 'maid_default') => (
  `${MAID_SEMANTIC_MEMORY_STORE_KEY}:${encodeURIComponent(trim(scopeId, 'maid_default'))}`
);

export class MaidSemanticMemoryStore {
  constructor({
    scopeId = 'maid_default',
    storage = globalThis?.localStorage || null,
    loadKv = loadKvDefault,
    saveKv = saveKvDefault,
    now = Date.now,
    onChanged = null,
  } = {}) {
    this.scopeId = trim(scopeId, 'maid_default');
    this.storage = storage;
    this.loadKv = typeof loadKv === 'function' ? loadKv : null;
    this.saveKv = typeof saveKv === 'function' ? saveKv : null;
    this.now = typeof now === 'function' ? now : Date.now;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.loaded = false;
    this.state = normalizeStoreState({}, { scopeId: this.scopeId, now: this.now });
    this.writeChain = Promise.resolve();
    this.idSequence = 0;
  }

  get storageKey() {
    return getMaidSemanticMemoryStorageKey(this.scopeId);
  }

  async load() {
    const key = this.storageKey;
    const localRaw = readLocalJson(this.storage, key);
    let kvRaw = null;
    try {
      kvRaw = await this.loadKv?.(key);
    } catch {}
    this.state = normalizeStoreState(selectAuthoritativeState(localRaw, kvRaw), {
      scopeId: this.scopeId,
      now: this.now,
    });
    this.loaded = true;
    return this.exportState();
  }

  ensureLoaded() {
    if (this.loaded) return;
    this.state = normalizeStoreState(readLocalJson(this.storage, this.storageKey) || {}, {
      scopeId: this.scopeId,
      now: this.now,
    });
    this.loaded = true;
  }

  queueWrite(task) {
    const run = this.writeChain.then(() => task());
    this.writeChain = run.catch(() => {});
    return run;
  }

  async write() {
    this.ensureLoaded();
    this.state.updatedAt = safeNow(this.now);
    const payload = this.exportState();
    let kvSaved = false;
    try {
      await this.saveKv?.(this.storageKey, payload);
      kvSaved = Boolean(this.saveKv);
    } catch {}
    const localSaved = writeLocalJson(this.storage, this.storageKey, payload);
    return kvSaved || localSaved;
  }

  emitChanged(detail = {}) {
    try {
      this.onChanged?.({
        scopeId: this.scopeId,
        ...clone(detail),
      });
    } catch {}
  }

  async setScope(scopeId = 'maid_default') {
    const next = trim(scopeId, 'maid_default');
    if (next === this.scopeId) return this.exportState();
    await this.writeChain.catch(() => {});
    this.scopeId = next;
    this.loaded = false;
    this.state = normalizeStoreState({}, { scopeId: next, now: this.now });
    return this.load();
  }

  listMemories({
    kind = '',
    status = '',
    statuses = null,
    query = '',
    limit = 0,
  } = {}) {
    this.ensureLoaded();
    const kindSet = new Set(
      (Array.isArray(kind) ? kind : [kind]).map(item => trim(item).toLowerCase()).filter(Boolean),
    );
    const statusSet = new Set(
      (Array.isArray(statuses) ? statuses : [status])
        .map(item => trim(item).toLowerCase())
        .filter(Boolean),
    );
    const needle = trim(query).toLowerCase();
    const list = this.state.memories
      .filter(memory => !kindSet.size || kindSet.has(memory.kind))
      .filter(memory => !statusSet.size || statusSet.has(memory.status))
      .filter(memory => !needle || [
        memory.key,
        memory.content,
        ...memory.tags,
      ].join(' ').toLowerCase().includes(needle))
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    const max = Math.max(0, Math.trunc(Number(limit)) || 0);
    return clone(max > 0 ? list.slice(0, max) : list);
  }

  retrieveMemories({
    query = '',
    kinds = null,
    latestLimit = 4,
    relevantLimit = 8,
    limit = 12,
  } = {}) {
    this.ensureLoaded();
    const kindSet = new Set(
      (Array.isArray(kinds) ? kinds : [kinds])
        .map(item => trim(item).toLowerCase())
        .filter(Boolean),
    );
    const active = this.state.memories
      .filter(memory => memory.scopeId === this.scopeId && memory.status === 'active')
      .filter(memory => !kindSet.size || kindSet.has(memory.kind))
      .sort((left, right) => (
        Number(right.updatedAt || 0) - Number(left.updatedAt || 0) ||
        String(left.id).localeCompare(String(right.id))
      ));
    const latestCount = Math.max(0, Math.min(12, Math.trunc(Number(latestLimit)) || 0));
    const relevantCount = Math.max(0, Math.min(12, Math.trunc(Number(relevantLimit)) || 0));
    const totalLimit = Math.max(1, Math.min(24, Math.trunc(Number(limit)) || 12));
    const latest = active.slice(0, latestCount);
    const scored = trim(query)
      ? active
        .map((memory, index) => ({
          memory,
          index,
          ...scoreMemoryForRetrieval(memory, query),
        }))
        .filter(item => item.score > 0)
        .sort((left, right) => (
          right.score - left.score ||
          Number(right.memory.updatedAt || 0) - Number(left.memory.updatedAt || 0) ||
          left.index - right.index
        ))
        .slice(0, relevantCount)
      : [];
    const selected = new Map();
    latest.forEach((memory, index) => {
      selected.set(memory.id, {
        memory,
        latest: true,
        score: 0,
        reasons: ['recent'],
        recencyRank: index + 1,
      });
    });
    scored.forEach((item) => {
      const existing = selected.get(item.memory.id);
      selected.set(item.memory.id, {
        memory: item.memory,
        latest: existing?.latest === true,
        score: item.score,
        reasons: Array.from(new Set([...(existing?.reasons || []), ...item.reasons])),
        recencyRank: existing?.recencyRank || item.index + 1,
      });
    });
    const packed = Array.from(selected.values())
      .sort((left, right) => (
        Number(right.score > 0) - Number(left.score > 0) ||
        right.score - left.score ||
        Number(right.latest) - Number(left.latest) ||
        Number(right.memory.updatedAt || 0) - Number(left.memory.updatedAt || 0)
      ))
      .slice(0, totalLimit);
    return {
      memories: clone(packed.map(item => item.memory)),
      matches: packed.map(item => ({
        id: item.memory.id,
        score: item.score,
        reasons: [...item.reasons],
        latest: item.latest,
        recencyRank: item.recencyRank,
      })),
      latestIds: latest.map(memory => memory.id),
      relevantIds: scored.map(item => item.memory.id),
    };
  }

  getMemory(id = '') {
    this.ensureLoaded();
    const target = trim(id);
    const memory = this.state.memories.find(item => item.id === target) || null;
    return clone(memory);
  }

  async upsertMemory(input = {}, { candidateKeys = null, shouldWrite = null } = {}) {
    return this.queueWrite(async () => {
      // 在串行队列真正执行时复验；提取任务可能在等待上一笔持久化时被用户清除。
      if (typeof shouldWrite === 'function' && !shouldWrite()) return { ok: false, reason: 'write_invalidated', memory: null };
      this.ensureLoaded();
      const requestedScope = trim(input?.scopeId, this.scopeId);
      if (requestedScope !== this.scopeId) {
        return { ok: false, reason: 'scope_mismatch', memory: null };
      }
      const kind = trim(input?.kind).toLowerCase();
      if (!KIND_SET.has(kind)) return { ok: false, reason: 'invalid_kind', memory: null };
      const resourceRef = normalizeResourceRef(input?.resourceRef);
      const rawKey = kind === 'resource_state' && !trim(input?.key)
        ? buildMaidResourceStateKey(resourceRef?.type, resourceRef?.id)
        : input?.key;
      const keyValidation = validateMaidSemanticMemoryKey(rawKey, {
        kind,
        resourceRef,
        candidateKeys,
        keyOrigin: trim(input?.keyOrigin, 'deterministic'),
      });
      if (!keyValidation.ok) {
        return { ok: false, reason: keyValidation.reason, memory: null, details: keyValidation };
      }
      const content = truncate(input?.content, 8000);
      if (!content) return { ok: false, reason: 'content_required', memory: null };
      const now = safeNow(this.now);
      const incoming = normalizeMaidSemanticMemory({
        ...input,
        scopeId: this.scopeId,
        kind,
        key: keyValidation.key,
        content,
        resourceRef,
        createdAt: input?.createdAt || now,
        updatedAt: now,
      }, {
        scopeId: this.scopeId,
        now: this.now,
        fallbackId: `maid_semantic_${now}_${++this.idSequence}`,
      });
      const existingIndex = this.state.memories.findIndex(memory => (
        memory.scopeId === this.scopeId &&
        memory.kind === incoming.kind &&
        memory.key === incoming.key
      ));
      if (existingIndex >= 0) {
        const existing = this.state.memories[existingIndex];
        const sourceTurnIds = uniqueStrings([...existing.sourceTurnIds, ...incoming.sourceTurnIds], 200);
        const tags = uniqueStrings([...existing.tags, ...incoming.tags], 20);
        const incomingRank = CONFIDENCE_RANK[incoming.confidence] || 0;
        const existingRank = CONFIDENCE_RANK[existing.confidence] || 0;
        const incomingIsWeaker = incomingRank < existingRank;
        const hasSameContent = normalizeComparableText(incoming.content) ===
          normalizeComparableText(existing.content);
        if (incomingIsWeaker && !hasSameContent) {
          const preserved = {
            ...existing,
            sourceTurnIds,
            tags,
            updatedAt: now,
          };
          this.state.memories[existingIndex] = preserved;
          await this.write();
          this.emitChanged({ action: 'ignored_weaker', id: preserved.id });
          return { ok: true, action: 'ignored_weaker', memory: clone(preserved) };
        }
        const updated = {
          ...existing,
          content: incoming.content,
          tags,
          status: incomingIsWeaker ? existing.status : incoming.status,
          confidence: incomingIsWeaker ? existing.confidence : incoming.confidence,
          sourceTurnIds,
          resourceRef: incoming.resourceRef || existing.resourceRef,
          updatedAt: now,
        };
        this.state.memories[existingIndex] = updated;
        await this.write();
        this.emitChanged({ action: 'updated', id: updated.id });
        return { ok: true, action: 'updated', memory: clone(updated) };
      }

      const duplicateIndex = this.state.memories.findIndex(memory => (
        memory.status === 'active' &&
        areMaidSemanticMemoriesNearDuplicate(memory, incoming)
      ));
      if (duplicateIndex >= 0) {
        const duplicate = this.state.memories[duplicateIndex];
        const incomingRank = CONFIDENCE_RANK[incoming.confidence] || 0;
        const duplicateRank = CONFIDENCE_RANK[duplicate.confidence] || 0;
        const incomingIsRicherCrossKey = (
          incomingRank === duplicateRank &&
          isKnownCrossKeyPair(duplicate, incoming) &&
          normalizeComparableText(incoming.content).length >
            normalizeComparableText(duplicate.content).length
        );
        const useIncomingContent = incomingRank > duplicateRank || incomingIsRicherCrossKey;
        const merged = {
          ...duplicate,
          key: incomingIsRicherCrossKey ? incoming.key : duplicate.key,
          content: useIncomingContent ? incoming.content : duplicate.content,
          confidence: incomingRank > duplicateRank ? incoming.confidence : duplicate.confidence,
          tags: uniqueStrings([...duplicate.tags, ...incoming.tags], 20),
          sourceTurnIds: uniqueStrings([...duplicate.sourceTurnIds, ...incoming.sourceTurnIds], 200),
          updatedAt: now,
        };
        this.state.memories[duplicateIndex] = merged;
        await this.write();
        this.emitChanged({
          action: 'merged_duplicate',
          id: merged.id,
          proposedKey: incoming.key,
          retainedKey: merged.key,
        });
        return { ok: true, action: 'merged_duplicate', memory: clone(merged) };
      }

      const requiredEvictions = Math.max(
        0,
        this.state.memories.length - MAID_SEMANTIC_MEMORY_MAX_RECORDS + 1,
      );
      const evictedMemories = requiredEvictions > 0
        ? this.state.memories
          .filter(memory => memory.status !== 'active')
          .sort((left, right) => {
            const priority = { stale: 0, archived: 1, resolved: 2 };
            return (
              (priority[left.status] ?? 3) - (priority[right.status] ?? 3) ||
              Number(left.updatedAt || 0) - Number(right.updatedAt || 0) ||
              String(left.id).localeCompare(String(right.id))
            );
          })
          .slice(0, requiredEvictions)
        : [];
      if (evictedMemories.length < requiredEvictions) {
        return { ok: false, reason: 'capacity_reached', memory: null };
      }
      if (evictedMemories.length) {
        const evictedIds = new Set(evictedMemories.map(memory => memory.id));
        this.state.memories = this.state.memories.filter(memory => !evictedIds.has(memory.id));
      }
      this.state.memories.push(incoming);
      await this.write();
      this.emitChanged({ action: 'created', id: incoming.id });
      return {
        ok: true,
        action: 'created',
        memory: clone(incoming),
        evictedMemories: clone(evictedMemories.map(memory => ({
          id: memory.id,
          status: memory.status,
        }))),
      };
    });
  }

  async deleteMemory(id = '') {
    return this.queueWrite(async () => {
      this.ensureLoaded();
      const target = trim(id);
      const index = this.state.memories.findIndex(memory => memory.id === target);
      if (index < 0) return false;
      this.state.memories.splice(index, 1);
      await this.write();
      this.emitChanged({ action: 'deleted', id: target });
      return true;
    });
  }

  // 用户在设置里手动改写的内容视为明确表述：之后模型抽取的较弱推断不会覆盖它
  async updateMemoryContent(id = '', content = '') {
    return this.queueWrite(async () => {
      this.ensureLoaded();
      const nextContent = truncate(content, 8000);
      if (!nextContent) return null;
      const memory = this.state.memories.find(item => item.id === trim(id));
      if (!memory) return null;
      memory.content = nextContent;
      memory.confidence = 'explicit';
      memory.updatedAt = safeNow(this.now);
      await this.write();
      this.emitChanged({ action: 'edited', id: memory.id });
      return clone(memory);
    });
  }

  async clearMemories() {
    return this.queueWrite(async () => {
      this.ensureLoaded();
      const removed = this.state.memories.length;
      if (!removed) return 0;
      this.state.memories = [];
      await this.write();
      this.emitChanged({ action: 'cleared', count: removed });
      return removed;
    });
  }

  async setMemoryStatus(id = '', status = 'active') {
    return this.queueWrite(async () => {
      this.ensureLoaded();
      const targetStatus = trim(status).toLowerCase();
      if (!STATUS_SET.has(targetStatus)) return null;
      const memory = this.state.memories.find(item => item.id === trim(id));
      if (!memory) return null;
      memory.status = targetStatus;
      memory.updatedAt = safeNow(this.now);
      await this.write();
      this.emitChanged({ action: 'status', id: memory.id, status: targetStatus });
      return clone(memory);
    });
  }

  async markMemoriesUsed(ids = []) {
    return this.queueWrite(async () => {
      this.ensureLoaded();
      const selected = new Set(uniqueStrings(ids, 100));
      if (!selected.size) return 0;
      const at = safeNow(this.now);
      let changed = 0;
      this.state.memories.forEach((memory) => {
        if (!selected.has(memory.id)) return;
        memory.lastUsedAt = at;
        changed += 1;
      });
      if (changed) await this.write();
      return changed;
    });
  }

  async validateResourcesForInjection(memories = [], {
    validateResource = null,
    cache = new Map(),
  } = {}) {
    this.ensureLoaded();
    const source = Array.isArray(memories) ? memories : [];
    const output = [];
    const staleIds = new Set();
    const unverifiedIds = new Set();
    for (const rawMemory of source) {
      const memory = normalizeMaidSemanticMemory(rawMemory, {
        scopeId: this.scopeId,
        now: this.now,
      });
      if (memory.scopeId !== this.scopeId || memory.status !== 'active') continue;
      if (memory.kind !== 'resource_state') {
        output.push(clone(memory));
        continue;
      }
      const resourceRef = normalizeResourceRef(memory.resourceRef);
      if (!resourceRef || typeof validateResource !== 'function') {
        unverifiedIds.add(memory.id);
        output.push(clone(memory));
        continue;
      }
      const cacheKey = `${resourceRef.type}:${resourceRef.id}`;
      let status = cache.get(cacheKey);
      if (!status) {
        try {
          status = normalizeValidationResult(await validateResource(clone(resourceRef), clone(memory)));
        } catch {
          status = 'unavailable';
        }
        cache.set(cacheKey, status);
      }
      if (status === 'not_found') {
        staleIds.add(memory.id);
        continue;
      }
      if (status === 'unavailable') unverifiedIds.add(memory.id);
      output.push(clone(memory));
    }
    if (staleIds.size) {
      await this.queueWrite(async () => {
        this.ensureLoaded();
        const at = safeNow(this.now);
        this.state.memories.forEach((memory) => {
          if (!staleIds.has(memory.id)) return;
          memory.status = 'stale';
          memory.updatedAt = at;
        });
        await this.write();
        this.emitChanged({ action: 'resources_stale', ids: Array.from(staleIds) });
      });
    }
    return {
      memories: output,
      staleIds: Array.from(staleIds),
      unverifiedIds: Array.from(unverifiedIds),
      cache,
    };
  }

  exportState() {
    this.ensureLoaded();
    return clone(this.state);
  }
}
