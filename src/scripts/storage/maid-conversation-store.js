import { safeInvoke } from '../utils/tauri.js';
import { estimateTokens } from '../memory/memory-prompt-utils.js';

export const MAID_CONVERSATION_STORE_KEY = 'maid_conversation_store_v1';
export const MAID_CONVERSATION_STORE_VERSION = 1;
export const MAID_CONVERSATION_LEGACY_ARCHIVE_KEY = 'maid_conversation_legacy_archive_v1';
export const MAID_CONVERSATION_LEGACY_ARCHIVE_VERSION = 2;
export const MAID_CONVERSATION_LEGACY_ARCHIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_INCREMENTAL_BYTES = 1024 * 1024;
export const MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_EVICTED_TURNS = 240;
export const MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_COMPACTED_TURNS = 240;
export const MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_EVICTED_MEMORY_ROWS = 120;
export const MAID_CONTEXT_VERSION = 'maid-context-v4-p1d';
export const MAID_CONTEXT_COMPACTION_TURN_THRESHOLD = 12;
export const MAID_CONTEXT_COMPACTION_HISTORY_TOKEN_THRESHOLD = 6000;
export const MAID_CONTEXT_COMPACTION_THRESHOLD_TOKENS = MAID_CONTEXT_COMPACTION_HISTORY_TOKEN_THRESHOLD;
export const MAID_CONTEXT_RECENT_TURN_LIMIT = 12;
export const MAID_CONTEXT_RECENT_TOKEN_LIMIT = 6000;
export const MAID_CONTEXT_MEMORY_ROW_LIMIT = 80;
export const MAID_CONTEXT_MEMORY_TOKEN_LIMIT = 6000;
export const MAID_CONTEXT_TOTAL_TOKEN_LIMIT = 12000;
export const MAID_CONTEXT_LATEST_MEMORY_ROWS = 4;
export const MAID_CONTEXT_RELEVANT_MEMORY_ROWS = 8;
export const MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT = 1200;
export const MAID_CONTEXT_WORKING_TOKEN_LIMIT = 2000;
export const MAID_CONTEXT_WORKING_ITEM_LIMIT = 10;
export const MAID_CONTEXT_SEMANTIC_SPARSE_THRESHOLD = 4;
export const MAID_CONTEXT_KEEP_RECENT_AFTER_COMPACT = 8;
export const MAID_CONTEXT_MAX_TURNS = 120;
export const MAID_CONTEXT_MAX_MEMORY_ROWS = 240;
export const MAID_CONTEXT_MAX_EXTRACTION_BATCHES = 60;
export const MAID_COMPACTION_PROTECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAID_EXTRACTION_MAX_AUTO_ATTEMPTS = 3;
export const MAID_EXTRACTION_RETRY_DELAYS_MS = Object.freeze([
  5 * 60 * 1000,
  30 * 60 * 1000,
]);

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

const loadKvDefault = async (key = '') => safeInvoke('load_kv', { name: key });

const saveKvDefault = async (key = '', value = {}) => safeInvoke('save_kv', { name: key, data: value });

const resolveAuthoritativeRaw = (localRaw = null, kvRaw = null) => {
  const local = isPlainObject(localRaw) ? localRaw : null;
  const kv = isPlainObject(kvRaw) && kvRaw._tooLarge !== true ? kvRaw : null;
  if (!local) return kv || {};
  if (!kv) return local;
  return Number(kv.updatedAt || 0) >= Number(local.updatedAt || 0) ? kv : local;
};

const truncate = (value = '', max = 1200) => {
  const text = trim(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
};

const normalizeBudget = (value, fallback, { min = 0 } = {}) => {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, numeric);
};

const truncateToTokenBudget = (value = '', maxTokens = 0) => {
  const text = trim(value);
  const budget = Math.max(0, Math.trunc(Number(maxTokens)) || 0);
  if (!text || budget <= 0) return '';
  if (estimateTokens(text, 'rough') <= budget) return text;
  const suffix = '…';
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}${suffix}`;
    if (estimateTokens(candidate, 'rough') <= budget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best || truncate(text, Math.max(1, Math.min(text.length, budget)));
};

const formatMaidHistoryTurn = (turn = {}) => [
  `- 时间: ${new Date(Number(turn.at || 0) || Date.now()).toISOString()}`,
  (turn.responseType === 'realtime' || turn.context?.voiceCallId) && !turn.input ? '' : `  用户: ${trim(turn.input, '-')}`,
  turn.context?.voiceRequestText ? `  语音任务: ${turn.context.voiceRequestText}` : '',
  turn.toolName ? `  工具: ${turn.toolName}` : '',
  turn.featureId ? `  功能: ${turn.featureId}` : '',
  turn.status ? `  状态: ${turn.status}` : '',
  turn.reactStoppedReason ? `  中断原因: ${turn.reactStoppedReason}` : '',
  turn.continuable ? '  可继续: 是' : '',
  turn.continueHint ? `  继续提示: ${turn.continueHint}` : '',
  turn.message ? `  结果: ${turn.message}` : '',
].filter(Boolean).join('\n');

const estimateMaidTurnsTokens = (turns = []) => estimateTokens(
  (Array.isArray(turns) ? turns : [])
    .map(turn => formatMaidHistoryTurn(turn))
    .filter(Boolean)
    .join('\n'),
  'rough',
);

const buildMaidHistoryContextPlan = ({
  turns = [],
  maxTurns = MAID_CONTEXT_RECENT_TURN_LIMIT,
  maxTokens = MAID_CONTEXT_RECENT_TOKEN_LIMIT,
} = {}) => {
  const turnLimit = Math.max(1, Math.trunc(Number(maxTurns)) || MAID_CONTEXT_RECENT_TURN_LIMIT);
  const tokenLimit = normalizeBudget(maxTokens, MAID_CONTEXT_RECENT_TOKEN_LIMIT);
  if (tokenLimit <= 0) {
    return { text: '', tokenCount: 0, selectedTurnIds: [], diagnostics: [] };
  }
  const available = (Array.isArray(turns) ? turns : [])
    .filter(turn => !turn?.compacted)
    .slice(-turnLimit);
  const selected = [];
  const diagnostics = [];
  let used = 0;
  for (let index = available.length - 1; index >= 0; index -= 1) {
    const turn = available[index];
    const text = formatMaidHistoryTurn(turn);
    const separatorCost = selected.length ? estimateTokens('\n', 'rough') : 0;
    const remaining = Math.max(0, tokenLimit - used - separatorCost);
    const cost = estimateTokens(text, 'rough');
    if (cost > remaining) {
      if (!selected.length && remaining > 0) {
        const projected = truncateToTokenBudget(text, remaining);
        if (projected) {
          selected.unshift({ id: trim(turn?.id), text: projected });
          used = estimateTokens(projected, 'rough');
          diagnostics.push({ id: trim(turn?.id), reason: 'history_token_limit' });
        }
      }
      break;
    }
    selected.unshift({ id: trim(turn?.id), text });
    used += separatorCost + cost;
  }
  const text = selected.map(item => item.text).join('\n');
  return {
    text,
    tokenCount: estimateTokens(text, 'rough'),
    selectedTurnIds: selected.map(item => item.id).filter(Boolean),
    diagnostics,
  };
};

const normalizeSearchText = (value = '') => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const buildMaidMemorySearchTerms = (query = '') => {
  const normalized = normalizeSearchText(query);
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

const scoreMaidMemoryRow = (row = {}, query = '') => {
  const terms = buildMaidMemorySearchTerms(query);
  if (!terms.length) return 0;
  const titleTags = normalizeSearchText([
    row?.title,
    ...(Array.isArray(row?.tags) ? row.tags : []),
  ].filter(Boolean).join(' '));
  const content = normalizeSearchText(row?.content);
  const full = `${titleTags} ${content}`.trim();
  const normalizedQuery = normalizeSearchText(query);
  let score = normalizedQuery && full.includes(normalizedQuery) ? 20 : 0;
  terms.forEach((term) => {
    if (titleTags.includes(term)) score += 4;
    else if (content.includes(term)) score += 1;
  });
  return score;
};

const formatMaidMemoryRowLine = (
  row = {},
  maxTokens = MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT,
  { sourcePrefix = '' } = {},
) => {
  const tokenLimit = Math.max(24, Math.trunc(Number(maxTokens)) || MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT);
  const title = trim(row?.title, '上下文记忆');
  const content = trim(row?.content, '-').replace(/\s*\r?\n\s*/g, ' / ');
  const tags = Array.isArray(row?.tags) && row.tags.length ? `；标签: ${row.tags.join(', ')}` : '';
  const source = trim(sourcePrefix);
  const linePrefix = source ? `- [${source}] 标题: ${title}；内容: ` : `- 标题: ${title}；内容: `;
  const fullLine = `${linePrefix}${content}${tags}`;
  if (estimateTokens(fullLine, 'rough') <= tokenLimit) {
    return { line: fullLine, truncated: false };
  }
  const fixedCost = estimateTokens(`${linePrefix}${tags}`, 'rough');
  const projectedContent = truncateToTokenBudget(content, Math.max(1, tokenLimit - fixedCost));
  const line = `${linePrefix}${projectedContent || '…'}${tags}`;
  return {
    line: estimateTokens(line, 'rough') <= tokenLimit
      ? line
      : truncateToTokenBudget(line, tokenLimit),
    truncated: true,
  };
};

const buildMaidMemoryContextPlan = ({
  rows = [],
  query = '',
  maxRows = MAID_CONTEXT_MEMORY_ROW_LIMIT,
  maxTokens = MAID_CONTEXT_MEMORY_TOKEN_LIMIT,
  maxPerRowTokens = MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT,
  includeLatest = true,
  latestLimit = MAID_CONTEXT_LATEST_MEMORY_ROWS,
  relevantLimit = MAID_CONTEXT_RELEVANT_MEMORY_ROWS,
  sourcePrefix = '',
} = {}) => {
  const source = Array.isArray(rows) ? rows : [];
  const tokenLimit = normalizeBudget(maxTokens, MAID_CONTEXT_MEMORY_TOKEN_LIMIT);
  if (!source.length || tokenLimit <= 0) {
    return { text: '', tokenCount: 0, selectedMemoryIds: [], diagnostics: [] };
  }
  const rowLimit = Math.min(
    Math.max(0, Math.trunc(Number(latestLimit)) || 0) +
      Math.max(0, Math.trunc(Number(relevantLimit)) || 0),
    Math.max(1, Math.trunc(Number(maxRows)) || MAID_CONTEXT_MEMORY_ROW_LIMIT),
  );
  const latestCount = includeLatest ? Math.max(0, Math.trunc(Number(latestLimit)) || 0) : 0;
  const latestStart = Math.max(0, source.length - latestCount);
  const candidates = source.map((row, index) => ({
    row,
    index,
    id: trim(row?.id, `memory-index-${index}`),
    latest: latestCount > 0 && index >= latestStart,
    relevance: scoreMaidMemoryRow(row, query),
  }));
  const latest = candidates.filter(item => item.latest);
  const relevant = candidates
    .filter(item => !item.latest && item.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || right.index - left.index)
    .slice(0, Math.max(0, Math.trunc(Number(relevantLimit)) || 0));
  const selectedById = new Map();
  [...latest, ...relevant].forEach(item => selectedById.set(item.id, item));
  const selection = Array.from(selectedById.values()).slice(-rowLimit);
  const packingOrder = [...selection].sort((left, right) => (
    Number(right.relevance > 0) - Number(left.relevance > 0) ||
    right.relevance - left.relevance ||
    Number(right.latest) - Number(left.latest) ||
    right.index - left.index
  ));
  const included = [];
  const diagnostics = [];
  let used = 0;
  for (const item of packingOrder) {
    const separatorCost = included.length ? estimateTokens('\n', 'rough') : 0;
    const remaining = Math.max(0, tokenLimit - used - separatorCost);
    if (remaining <= 0) {
      diagnostics.push({ id: item.id, reason: 'memory_token_budget' });
      continue;
    }
    const rowLimitTokens = Math.min(
      Math.max(24, Math.trunc(Number(maxPerRowTokens)) || MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT),
      remaining,
    );
    const formatted = formatMaidMemoryRowLine(item.row, rowLimitTokens, { sourcePrefix });
    const cost = estimateTokens(formatted.line, 'rough');
    if (!formatted.line || cost > remaining) {
      diagnostics.push({ id: item.id, reason: 'memory_token_budget' });
      continue;
    }
    included.push({ ...item, line: formatted.line });
    used += separatorCost + cost;
    if (formatted.truncated) {
      diagnostics.push({ id: item.id, reason: 'per_row_token_limit' });
    }
  }
  included.sort((left, right) => left.index - right.index);
  const text = included.map(item => item.line).join('\n');
  return {
    text,
    tokenCount: estimateTokens(text, 'rough'),
    selectedMemoryIds: included.map(item => item.id).filter(Boolean),
    diagnostics,
  };
};

const formatMaidWorkingItemLine = (item = {}, maxTokens = 320) => {
  const tokenLimit = Math.max(24, Math.trunc(Number(maxTokens)) || 320);
  const label = trim(item?.label, '待处理');
  const content = trim(item?.content, '-').replace(/\s*\r?\n\s*/g, ' / ');
  return truncateToTokenBudget(`- ${label}: ${content}`, tokenLimit);
};

const buildMaidWorkingContextPlan = ({
  turns = [],
  semanticTasks = [],
  maxItems = MAID_CONTEXT_WORKING_ITEM_LIMIT,
  maxTokens = MAID_CONTEXT_WORKING_TOKEN_LIMIT,
} = {}) => {
  const tokenLimit = normalizeBudget(maxTokens, MAID_CONTEXT_WORKING_TOKEN_LIMIT);
  if (tokenLimit <= 0) {
    return { text: '', tokenCount: 0, selectedTurnIds: [], selectedMemoryIds: [], diagnostics: [] };
  }
  const candidates = [];
  (Array.isArray(turns) ? turns : [])
    .filter(turn => !turn?.compacted && trim(turn?.compactionProtection))
    .slice(-MAID_CONTEXT_WORKING_ITEM_LIMIT)
    .forEach((turn) => {
      candidates.push({
        id: trim(turn?.id),
        type: 'turn',
        at: Number(turn?.at || 0) || 0,
        label: turn?.continuable === true ? '待继续任务' : '受保护工作项',
        content: [
          trim(turn?.input),
          trim(turn?.message),
          trim(turn?.continueHint),
        ].filter(Boolean).join('；'),
      });
    });
  (Array.isArray(semanticTasks) ? semanticTasks : [])
    .filter(memory => trim(memory?.status).toLowerCase() === 'active')
    .forEach((memory) => {
      candidates.push({
        id: trim(memory?.id),
        type: 'memory',
        at: Number(memory?.updatedAt || 0) || 0,
        label: `任务状态 ${trim(memory?.key, 'task.current')}`,
        content: trim(memory?.content),
      });
    });
  candidates.sort((left, right) => right.at - left.at);
  const selected = [];
  const diagnostics = [];
  let used = 0;
  for (const item of candidates.slice(0, Math.max(1, Math.trunc(Number(maxItems)) || MAID_CONTEXT_WORKING_ITEM_LIMIT))) {
    const separatorCost = selected.length ? estimateTokens('\n', 'rough') : 0;
    const remaining = Math.max(0, tokenLimit - used - separatorCost);
    if (remaining <= 0) {
      diagnostics.push({ id: item.id, reason: 'working_token_budget' });
      continue;
    }
    const line = formatMaidWorkingItemLine(item, Math.min(320, remaining));
    const cost = estimateTokens(line, 'rough');
    if (!line || cost > remaining) {
      diagnostics.push({ id: item.id, reason: 'working_token_budget' });
      continue;
    }
    selected.push({ ...item, line });
    used += separatorCost + cost;
  }
  const text = selected.map(item => item.line).join('\n');
  return {
    text,
    tokenCount: estimateTokens(text, 'rough'),
    selectedTurnIds: selected.filter(item => item.type === 'turn').map(item => item.id).filter(Boolean),
    selectedMemoryIds: selected.filter(item => item.type === 'memory').map(item => item.id).filter(Boolean),
    diagnostics,
  };
};

const formatMaidSemanticMemoryLine = (
  memory = {},
  maxTokens = MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT,
  { unverified = false } = {},
) => {
  const tokenLimit = Math.max(24, Math.trunc(Number(maxTokens)) || MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT);
  const content = trim(memory?.content, '-').replace(/\s*\r?\n\s*/g, ' / ');
  const tags = Array.isArray(memory?.tags) && memory.tags.length
    ? `；标签: ${memory.tags.join(', ')}`
    : '';
  const resource = memory?.resourceRef?.type && memory?.resourceRef?.id
    ? `；资源: ${memory.resourceRef.type}/${memory.resourceRef.id}`
    : '';
  const validation = unverified ? '；资源校验: 暂不可用，未验证' : '';
  const prefix = `- [${trim(memory?.kind, 'memory')}] key: ${trim(memory?.key, '-')}；内容: `;
  const suffix = `；置信度: ${trim(memory?.confidence, 'inferred')}${tags}${resource}${validation}`;
  const projectedContent = truncateToTokenBudget(
    content,
    Math.max(1, tokenLimit - estimateTokens(`${prefix}${suffix}`, 'rough')),
  );
  return truncateToTokenBudget(`${prefix}${projectedContent || '…'}${suffix}`, tokenLimit);
};

const buildMaidSemanticContextPlan = ({
  memories = [],
  matches = [],
  unverifiedIds = [],
  maxRows = MAID_CONTEXT_LATEST_MEMORY_ROWS + MAID_CONTEXT_RELEVANT_MEMORY_ROWS,
  maxTokens = MAID_CONTEXT_MEMORY_TOKEN_LIMIT,
  maxPerRowTokens = MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT,
} = {}) => {
  const tokenLimit = normalizeBudget(maxTokens, MAID_CONTEXT_MEMORY_TOKEN_LIMIT);
  if (tokenLimit <= 0) {
    return { text: '', tokenCount: 0, selectedMemoryIds: [], diagnostics: [] };
  }
  const byMatchId = new Map((Array.isArray(matches) ? matches : []).map(match => [trim(match?.id), match]));
  const unverified = new Set(Array.isArray(unverifiedIds) ? unverifiedIds : []);
  const source = (Array.isArray(memories) ? memories : [])
    .map((memory, index) => ({
      memory,
      id: trim(memory?.id, `semantic-index-${index}`),
      match: byMatchId.get(trim(memory?.id)) || {},
      index,
    }))
    .sort((left, right) => (
      Number(right.match?.score || 0) - Number(left.match?.score || 0) ||
      Number(right.memory?.updatedAt || 0) - Number(left.memory?.updatedAt || 0) ||
      left.index - right.index
    ))
    .slice(0, Math.max(1, Math.trunc(Number(maxRows)) || 12));
  const selected = [];
  const diagnostics = [];
  let used = 0;
  for (const item of source) {
    const separatorCost = selected.length ? estimateTokens('\n', 'rough') : 0;
    const remaining = Math.max(0, tokenLimit - used - separatorCost);
    if (remaining <= 0) {
      diagnostics.push({ id: item.id, reason: 'semantic_token_budget' });
      continue;
    }
    const line = formatMaidSemanticMemoryLine(
      item.memory,
      Math.min(
        Math.max(24, Math.trunc(Number(maxPerRowTokens)) || MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT),
        remaining,
      ),
      { unverified: unverified.has(item.id) },
    );
    const cost = estimateTokens(line, 'rough');
    if (!line || cost > remaining) {
      diagnostics.push({ id: item.id, reason: 'semantic_token_budget' });
      continue;
    }
    selected.push({ ...item, line });
    used += separatorCost + cost;
    if (unverified.has(item.id)) diagnostics.push({ id: item.id, reason: 'resource_unverified' });
  }
  const text = selected.map(item => item.line).join('\n');
  return {
    text,
    tokenCount: estimateTokens(text, 'rough'),
    selectedMemoryIds: selected.map(item => item.id).filter(Boolean),
    diagnostics,
  };
};

const normalizeId = (value = '', fallback = '') => {
  const text = trim(value);
  return text || fallback;
};

const normalizeStructuredMemorySignal = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const kind = trim(src.kind).toLowerCase();
  const content = truncate(src.content, 1200);
  if (!kind || !content) return null;
  return {
    kind,
    key: trim(src.key).toLowerCase(),
    content,
    tags: Array.isArray(src.tags) ? src.tags.map(tag => trim(tag)).filter(Boolean).slice(0, 12) : [],
    status: trim(src.status, 'active').toLowerCase(),
    confidence: trim(src.confidence, 'verified').toLowerCase(),
    sourceTurnIds: Array.isArray(src.sourceTurnIds)
      ? src.sourceTurnIds.map(id => trim(id)).filter(Boolean).slice(0, 20)
      : [],
    resourceRef: isPlainObject(src.resourceRef) ? clone(src.resourceRef) : null,
    keyOrigin: trim(src.keyOrigin, 'deterministic'),
  };
};

const normalizeTurn = (raw = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const currentAt = safeNow(now);
  const at = Number(src.at || currentAt) || currentAt;
  const id = normalizeId(src.id, `turn_${at}_${Math.random().toString(36).slice(2, 8)}`);
  const plan = isPlainObject(src.plan) ? src.plan : {};
  const output = isPlainObject(src.output) ? src.output : {};
  const rawProtection = trim(
    src.compactionProtection,
    src.continuable === true ? 'continuable' : '',
  );
  const protectionExpired = Boolean(
    rawProtection &&
    currentAt - at > MAID_COMPACTION_PROTECTION_TTL_MS
  );
  return {
    id,
    at,
    input: truncate(src.input, src.responseType === 'realtime' ? 12000 : 2000),
    status: trim(src.status || src.resultStatus),
    responseType: trim(src.responseType),
    message: truncate(src.message || src.response || src.reason, src.responseType === 'realtime' ? 12000 : 2400),
    toolName: trim(src.toolName || plan.toolName || output.toolName),
    featureId: trim(src.featureId || plan.featureId),
    title: trim(src.title || plan.title),
    continuable: src.continuable === true,
    continueHint: truncate(src.continueHint, 1200),
    reactStoppedReason: trim(src.reactStoppedReason),
    compacted: src.compacted === true,
    compactionProtection: protectionExpired ? '' : rawProtection,
    compactionProtectionReleasedAt: Number(
      src.compactionProtectionReleasedAt || (protectionExpired ? currentAt : 0),
    ) || 0,
    compactionProtectionReleaseReason: trim(
      src.compactionProtectionReleaseReason,
      protectionExpired ? 'expired' : '',
    ),
    structuredMemories: (Array.isArray(src.structuredMemories) ? src.structuredMemories : [])
      .map(normalizeStructuredMemorySignal)
      .filter(Boolean)
      .slice(0, 16),
    context: isPlainObject(src.context) ? clone(src.context) : {},
  };
};

const normalizeMemoryRow = (raw = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const at = Number(src.at || safeNow(now)) || safeNow(now);
  const id = normalizeId(src.id, `memory_${at}_${Math.random().toString(36).slice(2, 8)}`);
  const tags = Array.isArray(src.tags)
    ? src.tags.map(tag => trim(tag)).filter(Boolean).slice(0, 12)
    : [];
  const sourceTurnIds = Array.isArray(src.sourceTurnIds)
    ? src.sourceTurnIds.map(idValue => trim(idValue)).filter(Boolean).slice(0, 80)
    : [];
  const content = truncate(src.content, 8000);
  return {
    id,
    at,
    title: truncate(src.title, 160),
    content,
    tags,
    sourceTurnIds,
    tokenCount: Number(src.tokenCount || estimateTokens(content, 'rough')) || 0,
    kind: trim(src.kind, 'legacy_episode'),
  };
};

const normalizeExtractionUsageEntry = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const toNullableTokenCount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
  };
  const promptTokens = toNullableTokenCount(src.promptTokens);
  const completionTokens = toNullableTokenCount(src.completionTokens);
  const totalTokensRaw = toNullableTokenCount(src.totalTokens);
  const totalTokens = totalTokensRaw !== null
    ? totalTokensRaw
    : (promptTokens !== null || completionTokens !== null
      ? (promptTokens || 0) + (completionTokens || 0)
      : null);
  return {
    status: trim(src.status).toLowerCase() === 'recorded' || totalTokens !== null
      ? 'recorded'
      : 'unknown',
    provider: truncate(src.provider, 80),
    model: truncate(src.model, 120),
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs: toNullableTokenCount(src.latencyMs),
    modelCallCount: Math.max(1, Math.trunc(Number(src.modelCallCount)) || 0),
    degraded: src.degraded === true,
    source: truncate(src.source, 40),
  };
};

const appendExtractionUsage = (batch = {}, entries = []) => {
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter(isPlainObject)
    .map(normalizeExtractionUsageEntry);
  if (!normalized.length) return;
  const limit = MAID_EXTRACTION_MAX_AUTO_ATTEMPTS * 2;
  batch.modelUsage = [
    ...(Array.isArray(batch.modelUsage) ? batch.modelUsage : []),
    ...normalized,
  ].slice(-limit);
  if (normalized.some(entry => entry.source === 'maid_main_fallback' || entry.degraded)) {
    batch.fallbackUsed = true;
  }
};

const normalizeExtractionBatch = (raw = {}, { now = Date.now, fallbackId = '' } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const at = safeNow(now);
  const createdAt = Number(src.createdAt || at) || at;
  const rawStatus = trim(src.status, 'pending').toLowerCase();
  const attempts = Math.max(0, Math.trunc(Number(src.attempts)) || 0);
  const status = rawStatus === 'completed'
    ? 'completed'
    : (rawStatus === 'paused' || attempts >= MAID_EXTRACTION_MAX_AUTO_ATTEMPTS
      ? 'paused'
      : 'pending');
  const modelUsage = (Array.isArray(src.modelUsage) ? src.modelUsage : [])
    .filter(isPlainObject)
    .map(normalizeExtractionUsageEntry)
    .slice(-(MAID_EXTRACTION_MAX_AUTO_ATTEMPTS * 2));
  return {
    id: normalizeId(src.id, fallbackId || `maid_extract_${createdAt}`),
    sourceTurnIds: Array.isArray(src.sourceTurnIds)
      ? src.sourceTurnIds.map(id => trim(id)).filter(Boolean).slice(0, 80)
      : [],
    status,
    attempts,
    deterministicComplete: src.deterministicComplete === true,
    extractedCount: Math.max(0, Math.trunc(Number(src.extractedCount)) || 0),
    modelSource: truncate(src.modelSource, 40),
    model: truncate(src.model, 120),
    fallbackUsed: src.fallbackUsed === true ||
      modelUsage.some(entry => entry.source === 'maid_main_fallback' || entry.degraded),
    modelUsage,
    lastError: truncate(src.lastError, 500),
    nextRetryAt: status === 'pending' ? Math.max(0, Number(src.nextRetryAt) || 0) : 0,
    pauseReason: status === 'paused'
      ? trim(src.pauseReason, 'auto_retry_exhausted')
      : '',
    createdAt,
    updatedAt: Number(src.updatedAt || createdAt) || createdAt,
    completedAt: Number(src.completedAt || 0) || 0,
  };
};

// 裁切提取批次时先驱逐已完成的旧批，pending 批只有在单独超限时才丢最旧，避免静默丢失待重试的提取。
const trimExtractionBatches = (batches = [], limit = MAID_CONTEXT_MAX_EXTRACTION_BATCHES) => {
  const list = Array.isArray(batches) ? batches : [];
  if (list.length <= limit) return list;
  let excess = list.length - limit;
  const removable = new Set();
  for (const batch of list) {
    if (excess <= 0) break;
    if (batch?.status !== 'pending') {
      removable.add(batch);
      excess -= 1;
    }
  }
  const retained = list.filter(batch => !removable.has(batch));
  return retained.length > limit ? retained.slice(-limit) : retained;
};

export const normalizeMaidConversationState = (raw = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const updatedAt = Number(src.updatedAt || safeNow(now)) || safeNow(now);
  const turns = Array.isArray(src.turns)
    ? src.turns.map(turn => normalizeTurn(turn, { now })).filter(turn => trim(turn.input) || trim(turn.message))
    : [];
  const memoryRows = Array.isArray(src.memoryRows)
    ? src.memoryRows.map(row => normalizeMemoryRow(row, { now })).filter(row => trim(row.content))
    : [];
  const extractionBatches = Array.isArray(src.extractionBatches)
    ? src.extractionBatches
      .map((batch, index) => normalizeExtractionBatch(batch, {
        now,
        fallbackId: `maid_extract_imported_${index + 1}`,
      }))
      .filter(batch => batch.sourceTurnIds.length)
    : [];
  return {
    version: MAID_CONVERSATION_STORE_VERSION,
    updatedAt,
    threadId: trim(src.threadId, 'maid_default'),
    threadTitle: trim(src.threadTitle, '女仆对话'),
    totalInjectedTokens: Number(src.totalInjectedTokens || 0) || 0,
    pendingInjectedTokens: Number(src.pendingInjectedTokens || 0) || 0,
    compactionCount: Number(src.compactionCount || 0) || 0,
    lastCompactionAt: Number(src.lastCompactionAt || 0) || 0,
    turns: turns.slice(-MAID_CONTEXT_MAX_TURNS),
    memoryRows: memoryRows.slice(-MAID_CONTEXT_MAX_MEMORY_ROWS),
    extractionBatches: trimExtractionBatches(extractionBatches),
  };
};

export const formatMaidHistoryContextText = ({
  turns = [],
  maxTurns = MAID_CONTEXT_RECENT_TURN_LIMIT,
  maxTokens = MAID_CONTEXT_RECENT_TOKEN_LIMIT,
} = {}) => buildMaidHistoryContextPlan({ turns, maxTurns, maxTokens }).text;

// 排列对齐聊天室记忆表格的行格式：每条一行，`标签: 值；标签: 值`。
export const formatMaidMemoryTableText = ({
  rows = [],
  maxRows = MAID_CONTEXT_MEMORY_ROW_LIMIT,
  maxTokens = MAID_CONTEXT_MEMORY_TOKEN_LIMIT,
  maxPerRowTokens = MAID_CONTEXT_MEMORY_ROW_TOKEN_LIMIT,
  query = '',
} = {}) => buildMaidMemoryContextPlan({
  rows,
  maxRows,
  maxTokens,
  maxPerRowTokens,
  query,
}).text;

// 压缩摘要只保留可读结论：截断长结果，剥掉嵌入的 JSON/代码转储，避免污染记忆表格。
const summarizeTurnFieldForMemory = (value = '', maxLength = 240) => {
  let text = trim(value);
  if (!text) return '';
  text = text
    .replace(/```[\s\S]*?```/g, '（代码块已省略）')
    .replace(/\{[\s\S]{160,}\}/g, '（JSON 参数已省略）')
    .replace(/\s*\r?\n\s*/g, ' / ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

const buildMemoryRowFromTurns = (turns = [], {
  at = Date.now(),
  compactionIndex = 1,
} = {}) => {
  const selected = (Array.isArray(turns) ? turns : []).filter(turn => !turn?.compacted);
  if (!selected.length) return null;
  const content = selected.map((turn, index) => [
    `${index + 1}. 用户请求：${summarizeTurnFieldForMemory(turn.input, 160) || '-'}`,
    turn.toolName ? `   工具：${turn.toolName}` : '',
    turn.featureId ? `   功能：${turn.featureId}` : '',
    turn.status ? `   状态：${turn.status}` : '',
    turn.reactStoppedReason ? `   中断原因：${turn.reactStoppedReason}` : '',
    turn.continuable ? '   可继续：是' : '',
    turn.continueHint ? `   继续提示：${summarizeTurnFieldForMemory(turn.continueHint, 300)}` : '',
    turn.message ? `   结果：${summarizeTurnFieldForMemory(turn.message, 240)}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  return normalizeMemoryRow({
    id: `maid_memory_${at}_${compactionIndex}`,
    at,
    title: `女仆上下文摘要 ${compactionIndex}`,
    content,
    tags: ['女仆上下文', '自动压缩'],
    sourceTurnIds: selected.map(turn => turn.id),
    tokenCount: estimateTokens(content, 'rough'),
  });
};

const normalizeLegacyArchive = (raw = {}, { now = Date.now, baseline = null } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const at = safeNow(now);
  const baselineCaptured = src.baselineCaptured === true ||
    isPlainObject(src.baseline) ||
    isPlainObject(baseline);
  const sourceBaseline = isPlainObject(src.baseline)
    ? clone(src.baseline)
    : (
      src.baselineCaptured === true
        ? {}
        : (isPlainObject(baseline) ? clone(baseline) : {})
    );
  if (!Array.isArray(sourceBaseline.turns)) sourceBaseline.turns = [];
  if (!Array.isArray(sourceBaseline.memoryRows)) sourceBaseline.memoryRows = [];
  const baselineSummary = isPlainObject(src.baselineSummary)
    ? clone(src.baselineSummary)
    : {};
  return {
    version: MAID_CONVERSATION_LEGACY_ARCHIVE_VERSION,
    createdAt: Number(src.createdAt || at) || at,
    updatedAt: Number(src.updatedAt || at) || at,
    sourceStoreKey: MAID_CONVERSATION_STORE_KEY,
    sourceStoreVersion: Number(src.sourceStoreVersion || sourceBaseline.version || MAID_CONVERSATION_STORE_VERSION)
      || MAID_CONVERSATION_STORE_VERSION,
    threadId: trim(src.threadId || sourceBaseline.threadId, 'maid_default'),
    baselineCaptured,
    baselineStorage: trim(
      src.baselineStorage,
      isPlainObject(src.baseline) ? 'inline' : '',
    ),
    baselineOmitted: src.baselineOmitted === true,
    baselineSummary: {
      turnCount: Math.max(
        0,
        Number(baselineSummary.turnCount ?? sourceBaseline.turns.length) || 0,
      ),
      memoryRowCount: Math.max(
        0,
        Number(baselineSummary.memoryRowCount ?? sourceBaseline.memoryRows.length) || 0,
      ),
    },
    baseline: sourceBaseline,
    evictedTurns: Array.isArray(src.evictedTurns) ? clone(src.evictedTurns) : [],
    compactedTurns: Array.isArray(src.compactedTurns) ? clone(src.compactedTurns) : [],
    evictedMemoryRows: Array.isArray(src.evictedMemoryRows) ? clone(src.evictedMemoryRows) : [],
    retention: isPlainObject(src.retention) ? clone(src.retention) : {},
  };
};

const buildArchiveRecordKey = (value = {}, fallbackPrefix = 'record') => {
  const id = trim(value?.id);
  if (id) return id;
  try {
    return `${fallbackPrefix}:${JSON.stringify(value)}`;
  } catch {
    return `${fallbackPrefix}:${String(value)}`;
  }
};

const LEGACY_ARCHIVE_COLLECTION_LIMITS = Object.freeze({
  evictedTurns: MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_EVICTED_TURNS,
  compactedTurns: MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_COMPACTED_TURNS,
  evictedMemoryRows: MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_EVICTED_MEMORY_ROWS,
});

const getLegacyArchiveRecordTime = record => (
  Number(record?.at || record?.updatedAt || record?.createdAt || 0) || 0
);

const estimateLegacyArchiveIncrementalBytes = (archive = {}) => {
  try {
    return JSON.stringify({
      evictedTurns: archive.evictedTurns || [],
      compactedTurns: archive.compactedTurns || [],
      evictedMemoryRows: archive.evictedMemoryRows || [],
    }).length * 2;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const enforceLegacyArchiveRetention = (archive = {}, { now = Date.now } = {}) => {
  const at = safeNow(now);
  const cutoff = at - MAID_CONVERSATION_LEGACY_ARCHIVE_TTL_MS;
  const pruned = {
    expired: 0,
    count: 0,
    bytes: 0,
  };
  Object.entries(LEGACY_ARCHIVE_COLLECTION_LIMITS).forEach(([collection, limit]) => {
    const source = Array.isArray(archive[collection]) ? archive[collection] : [];
    const retained = source.filter((record) => {
      const recordAt = getLegacyArchiveRecordTime(record);
      const keep = !recordAt || recordAt >= cutoff;
      if (!keep) pruned.expired += 1;
      return keep;
    });
    if (retained.length > limit) {
      pruned.count += retained.length - limit;
      archive[collection] = retained.slice(-limit);
    } else {
      archive[collection] = retained;
    }
  });

  let incrementalBytes = estimateLegacyArchiveIncrementalBytes(archive);
  if (incrementalBytes > MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_INCREMENTAL_BYTES) {
    const candidates = Object.keys(LEGACY_ARCHIVE_COLLECTION_LIMITS)
      .flatMap(collection => archive[collection].map((record, index) => ({
        collection,
        index,
        record,
        at: getLegacyArchiveRecordTime(record),
        bytes: (() => {
          try {
            return JSON.stringify(record).length * 2;
          } catch {
            return 0;
          }
        })(),
      })))
      .sort((left, right) => (
        Number(left.at || 0) - Number(right.at || 0) ||
        left.collection.localeCompare(right.collection) ||
        left.index - right.index
      ));
    const removals = new Map(
      Object.keys(LEGACY_ARCHIVE_COLLECTION_LIMITS).map(collection => [collection, new Set()]),
    );
    for (const candidate of candidates) {
      if (incrementalBytes <= MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_INCREMENTAL_BYTES) break;
      removals.get(candidate.collection).add(candidate.record);
      incrementalBytes = Math.max(0, incrementalBytes - candidate.bytes - 2);
      pruned.bytes += 1;
    }
    removals.forEach((records, collection) => {
      if (!records.size) return;
      archive[collection] = archive[collection].filter(record => !records.has(record));
    });
    incrementalBytes = estimateLegacyArchiveIncrementalBytes(archive);
    while (
      incrementalBytes > MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_INCREMENTAL_BYTES &&
      Object.keys(LEGACY_ARCHIVE_COLLECTION_LIMITS).some(collection => archive[collection].length)
    ) {
      const oldestCollection = Object.keys(LEGACY_ARCHIVE_COLLECTION_LIMITS)
        .filter(collection => archive[collection].length)
        .sort((left, right) => (
          getLegacyArchiveRecordTime(archive[left][0]) -
          getLegacyArchiveRecordTime(archive[right][0])
        ))[0];
      archive[oldestCollection].shift();
      pruned.bytes += 1;
      incrementalBytes = estimateLegacyArchiveIncrementalBytes(archive);
    }
  }

  const changed = pruned.expired > 0 || pruned.count > 0 || pruned.bytes > 0;
  archive.retention = {
    ttlMs: MAID_CONVERSATION_LEGACY_ARCHIVE_TTL_MS,
    maxIncrementalBytes: MAID_CONVERSATION_LEGACY_ARCHIVE_MAX_INCREMENTAL_BYTES,
    maxRecords: clone(LEGACY_ARCHIVE_COLLECTION_LIMITS),
    incrementalBytes,
    lastPrunedAt: changed ? at : Number(archive.retention?.lastPrunedAt || 0) || 0,
    totalPruned: Math.max(0, Number(archive.retention?.totalPruned || 0) || 0) +
      pruned.expired +
      pruned.count +
      pruned.bytes,
  };
  return { changed, pruned, incrementalBytes };
};

const buildLegacyArchiveLocalPayload = (archive = {}, {
  includeBaseline = false,
  baselineStorage = includeBaseline ? 'local' : 'kv',
} = {}) => {
  const payload = clone(archive);
  payload.baselineCaptured = true;
  payload.baselineStorage = baselineStorage;
  payload.baselineOmitted = !includeBaseline;
  payload.baselineSummary = {
    turnCount: Math.max(
      0,
      Number(payload.baselineSummary?.turnCount ?? payload.baseline?.turns?.length) || 0,
    ),
    memoryRowCount: Math.max(
      0,
      Number(payload.baselineSummary?.memoryRowCount ?? payload.baseline?.memoryRows?.length) || 0,
    ),
  };
  if (!includeBaseline) delete payload.baseline;
  return payload;
};

export class MaidConversationStore {
  constructor({
    storage = globalThis?.localStorage || null,
    loadKv = loadKvDefault,
    saveKv = saveKvDefault,
    now = Date.now,
    compactionThresholdTokens = null,
    compactionTurnThreshold = MAID_CONTEXT_COMPACTION_TURN_THRESHOLD,
    compactionHistoryTokenThreshold = MAID_CONTEXT_COMPACTION_HISTORY_TOKEN_THRESHOLD,
    semanticMemoryStore = null,
    extractSemanticMemories = null,
    logger = console,
  } = {}) {
    this.storage = storage;
    this.loadKv = typeof loadKv === 'function' ? loadKv : null;
    this.saveKv = typeof saveKv === 'function' ? saveKv : null;
    this.now = typeof now === 'function' ? now : Date.now;
    this.compactionTurnThreshold = Math.max(
      1,
      Math.trunc(Number(compactionTurnThreshold)) || MAID_CONTEXT_COMPACTION_TURN_THRESHOLD,
    );
    this.compactionHistoryTokenThreshold = Math.max(
      1,
      Math.trunc(Number(compactionThresholdTokens ?? compactionHistoryTokenThreshold)) ||
        MAID_CONTEXT_COMPACTION_HISTORY_TOKEN_THRESHOLD,
    );
    this.compactionThresholdTokens = this.compactionHistoryTokenThreshold;
    this.semanticMemoryStore = semanticMemoryStore || null;
    this.extractSemanticMemories = typeof extractSemanticMemories === 'function'
      ? extractSemanticMemories
      : null;
    this.logger = logger || console;
    this.loaded = false;
    this.state = normalizeMaidConversationState({}, { now: this.now });
    this.legacyArchive = normalizeLegacyArchive({}, { now: this.now, baseline: {} });
    this.legacyArchiveLoaded = false;
    this.legacyArchiveDirty = false;
    this.persistChain = Promise.resolve();
    this.extractionPromise = null;
    this.lastExtractionPromise = null;
    this.extractionRerunRequested = false;
  }

  setSemanticMemoryRuntime({
    semanticMemoryStore = this.semanticMemoryStore,
    extractSemanticMemories = this.extractSemanticMemories,
  } = {}) {
    this.semanticMemoryStore = semanticMemoryStore || null;
    this.extractSemanticMemories = typeof extractSemanticMemories === 'function'
      ? extractSemanticMemories
      : null;
    return {
      semanticMemoryStore: this.semanticMemoryStore,
      extractSemanticMemories: this.extractSemanticMemories,
    };
  }

  async load() {
    const localRaw = readLocalJson(this.storage, MAID_CONVERSATION_STORE_KEY) || {};
    let kvRaw = null;
    try {
      kvRaw = await this.loadKv?.(MAID_CONVERSATION_STORE_KEY);
    } catch {}
    const authoritativeRaw = resolveAuthoritativeRaw(localRaw, kvRaw);
    await this.loadLegacyArchive(authoritativeRaw);
    this.state = normalizeMaidConversationState(authoritativeRaw, { now: this.now });
    this.loaded = true;
    return this.exportState();
  }

  ensureLoaded() {
    if (!this.loaded) {
      const localRaw = readLocalJson(this.storage, MAID_CONVERSATION_STORE_KEY) || {};
      this.ensureLegacyArchiveSync(localRaw);
      this.state = normalizeMaidConversationState(localRaw, {
        now: this.now,
      });
      this.loaded = true;
    }
  }

  ensureLegacyArchiveSync(authoritativeRaw = {}) {
    if (this.legacyArchiveLoaded) return this.legacyArchive;
    const stored = readLocalJson(this.storage, MAID_CONVERSATION_LEGACY_ARCHIVE_KEY);
    const hasCapturedBaseline = isPlainObject(stored?.baseline) || stored?.baselineCaptured === true;
    this.legacyArchive = hasCapturedBaseline
      ? normalizeLegacyArchive(stored, { now: this.now })
      : normalizeLegacyArchive({}, { now: this.now, baseline: authoritativeRaw });
    this.legacyArchiveLoaded = true;
    const retention = enforceLegacyArchiveRetention(this.legacyArchive, { now: this.now });
    this.legacyArchiveDirty = !hasCapturedBaseline || retention.changed;
    if (!hasCapturedBaseline) {
      writeLocalJson(
        this.storage,
        MAID_CONVERSATION_LEGACY_ARCHIVE_KEY,
        buildLegacyArchiveLocalPayload(this.legacyArchive, {
          includeBaseline: true,
          baselineStorage: 'local',
        }),
      );
    }
    return this.legacyArchive;
  }

  async loadLegacyArchive(authoritativeRaw = {}) {
    const localRaw = readLocalJson(this.storage, MAID_CONVERSATION_LEGACY_ARCHIVE_KEY);
    let kvRaw = null;
    try {
      kvRaw = await this.loadKv?.(MAID_CONVERSATION_LEGACY_ARCHIVE_KEY);
    } catch {}
    const validKvRaw = isPlainObject(kvRaw) && kvRaw._tooLarge !== true ? kvRaw : null;
    const authoritativeArchive = resolveAuthoritativeRaw(localRaw, validKvRaw);
    const storedBaseline = isPlainObject(validKvRaw?.baseline)
      ? validKvRaw.baseline
      : (isPlainObject(localRaw?.baseline) ? localRaw.baseline : null);
    const hasStoredBaseline = isPlainObject(storedBaseline);
    const baselineCaptured = hasStoredBaseline ||
      authoritativeArchive?.baselineCaptured === true ||
      localRaw?.baselineCaptured === true ||
      validKvRaw?.baselineCaptured === true;
    const mergedArchive = {
      ...(isPlainObject(authoritativeArchive) ? authoritativeArchive : {}),
      ...(hasStoredBaseline ? { baseline: storedBaseline } : {}),
      baselineCaptured,
      baselineStorage: hasStoredBaseline && isPlainObject(validKvRaw?.baseline)
        ? 'kv'
        : trim(authoritativeArchive?.baselineStorage),
      baselineOmitted: false,
    };
    this.legacyArchive = baselineCaptured
      ? normalizeLegacyArchive(mergedArchive, { now: this.now })
      : normalizeLegacyArchive({}, { now: this.now, baseline: authoritativeRaw });
    this.legacyArchiveLoaded = true;
    const retention = enforceLegacyArchiveRetention(this.legacyArchive, { now: this.now });
    const needsLocalBaselineCompaction = hasStoredBaseline &&
      isPlainObject(validKvRaw?.baseline) &&
      isPlainObject(localRaw?.baseline);
    const needsKvBaselineMigration = isPlainObject(localRaw?.baseline) &&
      !isPlainObject(validKvRaw?.baseline);
    const needsKvReconciliation = Boolean(validKvRaw) &&
      Number(localRaw?.updatedAt || 0) > Number(validKvRaw.updatedAt || 0);
    this.legacyArchiveDirty = !baselineCaptured ||
      retention.changed ||
      needsLocalBaselineCompaction ||
      needsKvBaselineMigration ||
      needsKvReconciliation ||
      Number(authoritativeArchive?.version || 0) < MAID_CONVERSATION_LEGACY_ARCHIVE_VERSION;
    if (this.legacyArchiveDirty) await this.writeLegacyArchive();
    return this.getLegacyArchive();
  }

  archiveEvictions({ turns = [], memoryRows = [] } = {}) {
    this.ensureLegacyArchiveSync(this.state);
    const baselineTurns = Array.isArray(this.legacyArchive?.baseline?.turns)
      ? this.legacyArchive.baseline.turns
      : [];
    const baselineRows = Array.isArray(this.legacyArchive?.baseline?.memoryRows)
      ? this.legacyArchive.baseline.memoryRows
      : [];
    const turnKeys = new Set([
      ...baselineTurns.map(item => buildArchiveRecordKey(item, 'turn')),
      ...this.legacyArchive.evictedTurns.map(item => buildArchiveRecordKey(item, 'turn')),
      ...this.legacyArchive.compactedTurns.map(item => buildArchiveRecordKey(item, 'turn')),
    ]);
    const rowKeys = new Set([
      ...baselineRows.map(item => buildArchiveRecordKey(item, 'memory')),
      ...this.legacyArchive.evictedMemoryRows.map(item => buildArchiveRecordKey(item, 'memory')),
    ]);
    let changed = false;
    (Array.isArray(turns) ? turns : []).forEach((turn) => {
      const key = buildArchiveRecordKey(turn, 'turn');
      if (turnKeys.has(key)) return;
      turnKeys.add(key);
      this.legacyArchive.evictedTurns.push(clone(turn));
      changed = true;
    });
    (Array.isArray(memoryRows) ? memoryRows : []).forEach((row) => {
      const key = buildArchiveRecordKey(row, 'memory');
      if (rowKeys.has(key)) return;
      rowKeys.add(key);
      this.legacyArchive.evictedMemoryRows.push(clone(row));
      changed = true;
    });
    if (changed) {
      this.legacyArchive.updatedAt = safeNow(this.now);
      this.legacyArchiveDirty = true;
      enforceLegacyArchiveRetention(this.legacyArchive, { now: this.now });
    }
    return changed;
  }

  archiveCompactedTurns(turns = []) {
    this.ensureLegacyArchiveSync(this.state);
    const existingKeys = new Set([
      ...(Array.isArray(this.legacyArchive?.baseline?.turns) ? this.legacyArchive.baseline.turns : [])
        .map(item => buildArchiveRecordKey(item, 'turn')),
      ...this.legacyArchive.compactedTurns.map(item => buildArchiveRecordKey(item, 'turn')),
      ...this.legacyArchive.evictedTurns.map(item => buildArchiveRecordKey(item, 'turn')),
    ]);
    let changed = false;
    (Array.isArray(turns) ? turns : []).forEach((turn) => {
      const key = buildArchiveRecordKey(turn, 'turn');
      if (existingKeys.has(key)) return;
      existingKeys.add(key);
      this.legacyArchive.compactedTurns.push(clone(turn));
      changed = true;
    });
    if (changed) {
      this.legacyArchive.updatedAt = safeNow(this.now);
      this.legacyArchiveDirty = true;
      enforceLegacyArchiveRetention(this.legacyArchive, { now: this.now });
    }
    return changed;
  }

  async writeLegacyArchive() {
    if (!this.legacyArchiveLoaded || !this.legacyArchiveDirty) return true;
    enforceLegacyArchiveRetention(this.legacyArchive, { now: this.now });
    this.legacyArchive.updatedAt = safeNow(this.now);
    let payload = this.getLegacyArchive();
    if (payload.baselineOmitted === true) {
      try {
        const storedKv = await this.loadKv?.(MAID_CONVERSATION_LEGACY_ARCHIVE_KEY);
        if (isPlainObject(storedKv?.baseline) && storedKv._tooLarge !== true) {
          payload = normalizeLegacyArchive({
            ...payload,
            baseline: storedKv.baseline,
            baselineCaptured: true,
            baselineStorage: 'kv',
            baselineOmitted: false,
          }, { now: this.now });
          this.legacyArchive = clone(payload);
        }
      } catch {}
    }
    let kvSaved = false;
    if (payload.baselineOmitted !== true) {
      const kvPayload = buildLegacyArchiveLocalPayload(payload, {
        includeBaseline: true,
        baselineStorage: 'kv',
      });
      try {
        await this.saveKv?.(MAID_CONVERSATION_LEGACY_ARCHIVE_KEY, kvPayload);
        kvSaved = Boolean(this.saveKv);
      } catch {}
    }
    const includeLocalBaseline = !kvSaved && payload.baselineOmitted !== true;
    const localPayload = buildLegacyArchiveLocalPayload(payload, {
      includeBaseline: includeLocalBaseline,
      baselineStorage: includeLocalBaseline ? 'local' : 'kv',
    });
    const localSaved = writeLocalJson(
      this.storage,
      MAID_CONVERSATION_LEGACY_ARCHIVE_KEY,
      localPayload,
    );
    if (kvSaved) {
      this.legacyArchive.baselineCaptured = true;
      this.legacyArchive.baselineStorage = 'kv';
      this.legacyArchive.baselineOmitted = false;
    }
    const fullySaved = kvSaved || (includeLocalBaseline && localSaved);
    if (fullySaved) this.legacyArchiveDirty = false;
    return kvSaved || localSaved;
  }

  async persistCurrentState() {
    this.ensureLoaded();
    if (this.legacyArchiveDirty) {
      const archiveSaved = await this.writeLegacyArchive();
      if (!archiveSaved) return false;
    }
    this.state.updatedAt = safeNow(this.now);
    const payload = this.exportState();
    let kvSaved = false;
    try {
      await this.saveKv?.(MAID_CONVERSATION_STORE_KEY, payload);
      kvSaved = Boolean(this.saveKv);
    } catch {}
    const localSaved = writeLocalJson(this.storage, MAID_CONVERSATION_STORE_KEY, payload);
    return kvSaved || localSaved;
  }

  write() {
    const operation = this.persistChain.then(() => this.persistCurrentState());
    this.persistChain = operation.catch(() => {});
    return operation;
  }

  getContextSnapshot(options = {}) {
    this.ensureLoaded();
    const totalTokenLimit = normalizeBudget(
      options.maxTotalTokens,
      MAID_CONTEXT_TOTAL_TOKEN_LIMIT,
    );
    const historyPlan = buildMaidHistoryContextPlan({
      turns: this.state.turns,
      maxTurns: options.maxTurns,
      maxTokens: Math.min(
        normalizeBudget(options.maxHistoryTokens, MAID_CONTEXT_RECENT_TOKEN_LIMIT),
        totalTokenLimit,
      ),
    });
    const separatorAllowance = historyPlan.text ? estimateTokens('\n', 'rough') : 0;
    const availableForMemory = Math.max(
      0,
      totalTokenLimit - historyPlan.tokenCount - separatorAllowance,
    );
    const memoryPlan = buildMaidMemoryContextPlan({
      rows: this.state.memoryRows,
      maxRows: options.maxMemoryRows,
      maxTokens: Math.min(
        normalizeBudget(options.maxMemoryTokens, MAID_CONTEXT_MEMORY_TOKEN_LIMIT),
        availableForMemory,
      ),
      maxPerRowTokens: options.maxMemoryRowTokens,
      query: options.query || options.input || '',
    });
    const historyText = historyPlan.text;
    const memoryText = memoryPlan.text;
    const tokenCount = estimateTokens([historyText, memoryText].filter(Boolean).join('\n'), 'rough');
    return {
      maidContextVersion: MAID_CONTEXT_VERSION,
      threadId: this.state.threadId,
      threadTitle: this.state.threadTitle,
      historyText,
      memoryText,
      tokenCount,
      historyTokenCount: historyPlan.tokenCount,
      memoryTokenCount: memoryPlan.tokenCount,
      selectedTurnIds: historyPlan.selectedTurnIds,
      selectedMemoryIds: memoryPlan.selectedMemoryIds,
      contextDiagnostics: {
        budgets: {
          history: Math.min(
            normalizeBudget(options.maxHistoryTokens, MAID_CONTEXT_RECENT_TOKEN_LIMIT),
            totalTokenLimit,
          ),
          memory: Math.min(
            normalizeBudget(options.maxMemoryTokens, MAID_CONTEXT_MEMORY_TOKEN_LIMIT),
            availableForMemory,
          ),
          total: totalTokenLimit,
        },
        history: historyPlan.diagnostics,
        memory: memoryPlan.diagnostics,
      },
      turnCount: this.state.turns.filter(turn => !turn.compacted).length,
      memoryCount: this.state.memoryRows.length,
      totalInjectedTokens: this.state.totalInjectedTokens,
      pendingInjectedTokens: this.state.pendingInjectedTokens,
      compactionThresholdTokens: this.compactionThresholdTokens,
      compactionTurnThreshold: this.compactionTurnThreshold,
      uncompressedHistoryTokenCount: estimateMaidTurnsTokens(
        this.state.turns.filter(turn => !turn.compacted),
      ),
      pendingExtractionCount: this.state.extractionBatches.filter(batch => batch.status === 'pending').length,
      pausedExtractionCount: this.state.extractionBatches.filter(batch => batch.status === 'paused').length,
    };
  }

  async getContextSnapshotAsync(options = {}) {
    this.ensureLoaded();
    const query = options.query || options.input || '';
    const totalTokenLimit = normalizeBudget(
      options.maxTotalTokens,
      MAID_CONTEXT_TOTAL_TOKEN_LIMIT,
    );
    const historyBudget = Math.min(
      normalizeBudget(options.maxHistoryTokens, MAID_CONTEXT_RECENT_TOKEN_LIMIT),
      totalTokenLimit,
    );
    const historyPlan = buildMaidHistoryContextPlan({
      turns: this.state.turns,
      maxTurns: options.maxTurns,
      maxTokens: historyBudget,
    });
    const historySeparatorCost = historyPlan.text ? estimateTokens('\n', 'rough') : 0;
    const availableAfterHistory = Math.max(
      0,
      totalTokenLimit - historyPlan.tokenCount - historySeparatorCost,
    );
    const memoryBudget = Math.min(
      normalizeBudget(options.maxMemoryTokens, MAID_CONTEXT_MEMORY_TOKEN_LIMIT),
      availableAfterHistory,
    );
    const semanticStore = this.semanticMemoryStore;
    const activeSemanticTasks = typeof semanticStore?.listMemories === 'function'
      ? semanticStore.listMemories({
        kind: 'task_state',
        status: 'active',
        limit: MAID_CONTEXT_WORKING_ITEM_LIMIT,
      })
      : [];
    const activeLongTerm = typeof semanticStore?.listMemories === 'function'
      ? semanticStore.listMemories({ status: 'active' })
        .filter(memory => memory.kind !== 'task_state')
      : [];
    const semanticRetrieval = typeof semanticStore?.retrieveMemories === 'function'
      ? semanticStore.retrieveMemories({
        query,
        kinds: ['preference', 'decision', 'resource_state', 'relationship', 'important_event'],
        latestLimit: MAID_CONTEXT_LATEST_MEMORY_ROWS,
        relevantLimit: MAID_CONTEXT_RELEVANT_MEMORY_ROWS,
        limit: MAID_CONTEXT_LATEST_MEMORY_ROWS + MAID_CONTEXT_RELEVANT_MEMORY_ROWS,
      })
      : { memories: [], matches: [], latestIds: [], relevantIds: [] };
    const validatedSemantic = typeof semanticStore?.validateResourcesForInjection === 'function'
      ? await semanticStore.validateResourcesForInjection(semanticRetrieval.memories, {
        validateResource: options.validateResource,
        cache: options.resourceValidationCache instanceof Map
          ? options.resourceValidationCache
          : new Map(),
      })
      : {
        memories: semanticRetrieval.memories,
        staleIds: [],
        unverifiedIds: [],
      };

    const sections = [];
    let remainingMemoryTokens = memoryBudget;
    const addSection = (label, buildPlan, sectionTokenLimit = remainingMemoryTokens) => {
      const separatorCost = sections.length ? estimateTokens('\n', 'rough') : 0;
      const header = `[${label}]`;
      const headerCost = estimateTokens(`${header}\n`, 'rough');
      const available = Math.max(
        0,
        Math.min(
          normalizeBudget(sectionTokenLimit, remainingMemoryTokens),
          remainingMemoryTokens - separatorCost,
        ),
      );
      const bodyBudget = Math.max(0, available - headerCost);
      const plan = buildPlan(bodyBudget);
      if (!plan?.text || bodyBudget <= 0) return plan;
      const text = `${header}\n${plan.text}`;
      const cost = estimateTokens(text, 'rough');
      if (cost > available) {
        // 整段被预算裁掉时不得再报告其选中项：否则未注入的记忆会污染 markMemoriesUsed 与 Run 统计。
        return {
          ...plan,
          text: '',
          tokenCount: 0,
          selectedMemoryIds: [],
          selectedTurnIds: [],
          diagnostics: [
            ...(Array.isArray(plan?.diagnostics) ? plan.diagnostics : []),
            { id: '', reason: 'section_token_budget', label },
          ],
        };
      }
      sections.push({ label, text, tokenCount: cost, plan });
      remainingMemoryTokens = Math.max(0, remainingMemoryTokens - separatorCost - cost);
      return plan;
    };

    const workingPlan = addSection(
      '工作记忆',
      maxTokens => buildMaidWorkingContextPlan({
        turns: this.state.turns,
        semanticTasks: activeSemanticTasks,
        maxItems: options.maxWorkingItems,
        maxTokens,
      }),
      Math.min(
        normalizeBudget(options.maxWorkingTokens, MAID_CONTEXT_WORKING_TOKEN_LIMIT),
        remainingMemoryTokens,
      ),
    ) || {
      text: '',
      tokenCount: 0,
      selectedTurnIds: [],
      selectedMemoryIds: [],
      diagnostics: [],
    };
    const semanticPlan = addSection(
      '长期记忆',
      maxTokens => buildMaidSemanticContextPlan({
        memories: validatedSemantic.memories,
        matches: semanticRetrieval.matches,
        unverifiedIds: validatedSemantic.unverifiedIds,
        maxRows: options.maxSemanticRows,
        maxTokens,
        maxPerRowTokens: options.maxMemoryRowTokens,
      }),
      remainingMemoryTokens,
    ) || {
      text: '',
      tokenCount: 0,
      selectedMemoryIds: [],
      diagnostics: [],
    };
    const shouldUseLegacyFallback = (
      activeLongTerm.length < MAID_CONTEXT_SEMANTIC_SPARSE_THRESHOLD &&
      Boolean(trim(query))
    );
    const legacyPlan = shouldUseLegacyFallback
      ? addSection(
        '旧轮次归档 · legacy',
        maxTokens => buildMaidMemoryContextPlan({
          rows: this.state.memoryRows,
          query,
          maxRows: options.maxLegacyRows || 4,
          maxTokens,
          maxPerRowTokens: options.maxMemoryRowTokens,
          includeLatest: false,
          latestLimit: 0,
          relevantLimit: options.maxLegacyRows || 4,
          sourcePrefix: 'legacy',
        }),
        remainingMemoryTokens,
      )
      : null;
    const safeLegacyPlan = legacyPlan || {
      text: '',
      tokenCount: 0,
      selectedMemoryIds: [],
      diagnostics: [],
    };
    const memoryText = sections.map(section => section.text).join('\n');
    const memoryTokenCount = estimateTokens(memoryText, 'rough');
    const historyText = historyPlan.text;
    const tokenCount = estimateTokens([historyText, memoryText].filter(Boolean).join('\n'), 'rough');
    const selectedSemanticMemoryIds = Array.from(new Set([
      ...(workingPlan.selectedMemoryIds || []),
      ...(semanticPlan.selectedMemoryIds || []),
    ]));
    if (selectedSemanticMemoryIds.length && typeof semanticStore?.markMemoriesUsed === 'function') {
      try {
        Promise.resolve(semanticStore.markMemoriesUsed(selectedSemanticMemoryIds)).catch((error) => {
          this.logger?.debug?.('maid semantic memory usage persistence skipped', error);
        });
      } catch (error) {
        this.logger?.debug?.('maid semantic memory usage persistence skipped', error);
      }
    }
    return {
      maidContextVersion: MAID_CONTEXT_VERSION,
      threadId: this.state.threadId,
      threadTitle: this.state.threadTitle,
      historyText,
      workingMemoryText: workingPlan.text || '',
      semanticMemoryText: semanticPlan.text || '',
      legacyMemoryText: safeLegacyPlan.text || '',
      memoryText,
      tokenCount,
      historyTokenCount: historyPlan.tokenCount,
      workingMemoryTokenCount: workingPlan.tokenCount || 0,
      semanticMemoryTokenCount: semanticPlan.tokenCount || 0,
      legacyMemoryTokenCount: safeLegacyPlan.tokenCount || 0,
      memoryTokenCount,
      selectedTurnIds: historyPlan.selectedTurnIds,
      selectedWorkingTurnIds: workingPlan.selectedTurnIds || [],
      selectedSemanticMemoryIds,
      selectedLegacyMemoryIds: safeLegacyPlan.selectedMemoryIds || [],
      selectedMemoryIds: [
        ...selectedSemanticMemoryIds,
        ...(safeLegacyPlan.selectedMemoryIds || []),
      ],
      contextDiagnostics: {
        budgets: {
          history: historyBudget,
          working: Math.min(
            normalizeBudget(options.maxWorkingTokens, MAID_CONTEXT_WORKING_TOKEN_LIMIT),
            memoryBudget,
          ),
          memory: memoryBudget,
          total: totalTokenLimit,
        },
        history: historyPlan.diagnostics,
        working: workingPlan.diagnostics || [],
        semantic: {
          diagnostics: semanticPlan.diagnostics || [],
          matches: semanticRetrieval.matches || [],
          staleIds: validatedSemantic.staleIds || [],
          unverifiedIds: validatedSemantic.unverifiedIds || [],
        },
        legacy: {
          enabled: shouldUseLegacyFallback,
          reason: shouldUseLegacyFallback ? 'semantic_sparse' : 'semantic_not_sparse',
          diagnostics: safeLegacyPlan.diagnostics || [],
        },
        memory: [
          ...(workingPlan.diagnostics || []),
          ...(semanticPlan.diagnostics || []),
          ...(safeLegacyPlan.diagnostics || []),
        ],
      },
      turnCount: this.state.turns.filter(turn => !turn.compacted).length,
      memoryCount: this.state.memoryRows.length,
      semanticMemoryCount: activeLongTerm.length + activeSemanticTasks.length,
      totalInjectedTokens: this.state.totalInjectedTokens,
      pendingInjectedTokens: this.state.pendingInjectedTokens,
      compactionThresholdTokens: this.compactionThresholdTokens,
      compactionTurnThreshold: this.compactionTurnThreshold,
      uncompressedHistoryTokenCount: estimateMaidTurnsTokens(
        this.state.turns.filter(turn => !turn.compacted),
      ),
      pendingExtractionCount: this.state.extractionBatches.filter(batch => batch.status === 'pending').length,
      pausedExtractionCount: this.state.extractionBatches.filter(batch => batch.status === 'paused').length,
    };
  }

  getHistoryContextText() {
    return trim(this.getContextSnapshot().historyText, '尚未记录女仆历史上下文。');
  }

  getMemoryTableText() {
    return trim(this.getContextSnapshot().memoryText, '尚未生成女仆记忆表格。');
  }

  // 面板展示版：多行缩进排版方便阅读；发送给模型的版本仍用紧凑单行（getMemoryTableText）。
  getMemoryTableDisplayText() {
    this.ensureLoaded();
    const rows = this.state.memoryRows.slice(-MAID_CONTEXT_MAX_MEMORY_ROWS);
    if (!rows.length) return '尚未生成女仆记忆表格。';
    return rows.map((row, index) => [
      `【${index + 1}】${trim(row.title, '上下文记忆')}`,
      ...trim(row.content, '-')
        .split(/\s*\r?\n\s*|\s+\/\s+/)
        .map(line => trim(line))
        .filter(Boolean)
        .map(line => `    ${line}`),
      row.tags?.length ? `    标签: ${row.tags.join(', ')}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');
  }

  async appendTurn(turn = {}, { requirePersisted = false } = {}) {
    this.ensureLoaded();
    const normalizedTurn = normalizeTurn({
      ...turn,
      id: turn.id || `turn_${safeNow(this.now)}_${this.state.turns.length + 1}`,
      at: turn.at || safeNow(this.now),
    }, { now: this.now });
    this.releaseSupersededCompactionProtections(normalizedTurn);
    this.state.turns.push(normalizedTurn);
    const evictedTurns = this.state.turns.length > MAID_CONTEXT_MAX_TURNS
      ? this.state.turns.slice(0, this.state.turns.length - MAID_CONTEXT_MAX_TURNS)
      : [];
    if (evictedTurns.length) this.archiveEvictions({ turns: evictedTurns });
    this.state.turns = this.state.turns.slice(-MAID_CONTEXT_MAX_TURNS);
    const compactedRow = this.shouldCompactHistory()
      ? this.compactHistoryToMemory()
      : null;
    const persisted = await this.write();
    if (compactedRow) this.schedulePendingExtractions();
    if (requirePersisted && !persisted) return null;
    return this.exportState();
  }

  // Voice transcript revisions belong to maid history, never to a role chat.
  async upsertRealtimeTranscript({ id, role, text, callId, meta = {}, previousText = null } = {}) {
    this.ensureLoaded();
    if (!id || !callId || !['user', 'assistant'].includes(role) || !trim(text)) return null;
    const old = this.state.turns.find(turn => turn.id === id);
    const field = role === 'user' ? 'input' : 'message';
    if (old && (old.context?.realtimeCallId !== callId || old.context?.realtimeRole !== role
      || old.compacted || (previousText !== null && old[field] !== previousText))) return { ignored: true };
    const turn = normalizeTurn({ ...old, id, [field]: text, status: 'succeeded', responseType: 'realtime',
      compactionProtection: 'realtime_transcript', context: { ...meta, realtimeCallId: callId, realtimeRole: role, uiMode: 'maid' },
    }, { now: this.now });
    if (old) { Object.assign(old, turn); if (!await this.write()) return null; }
    else if (!await this.appendTurn(turn, { requirePersisted: true })) return null;
    return { messageId: id };
  }

  async finalizeRealtimeConversation(callId) {
    this.ensureLoaded();
    let changed = false;
    this.state.turns.forEach(turn => {
      if (turn.context?.realtimeCallId !== callId || turn.compactionProtection !== 'realtime_transcript') return;
      turn.compactionProtection = ''; changed = true;
    });
    if (!changed) return;
    const compacted = this.shouldCompactHistory() ? this.compactHistoryToMemory() : null;
    await this.write();
    if (compacted) this.schedulePendingExtractions();
  }

  releaseSupersededCompactionProtections(nextTurn = {}) {
    const protectedTurns = this.state.turns.filter(turn => trim(turn?.compactionProtection) && turn.compactionProtection !== 'realtime_transcript');
    if (!protectedTurns.length) return 0;
    const input = trim(nextTurn?.input);
    const status = trim(nextTurn?.status).toLowerCase();
    const cancelled = /(?:^|[，,。；;！？!?\s])(?:取消|停止|不用继续|不要继续|别继续|放弃)(?:$|[，,。；;！？!?\s])/u.test(input);
    const continuing = /(?:^|[，,。；;！？!?\s])(?:继续|接着|承接|恢复|上一步|刚才|前一步)/u.test(input);
    const completed = continuing && ['succeeded', 'success', 'completed', 'responded'].includes(status);
    const reason = cancelled
      ? 'cancelled_by_next_turn'
      : (completed ? 'completed_by_next_turn' : 'superseded_by_next_turn');
    const releasedAt = Number(nextTurn?.at || safeNow(this.now)) || safeNow(this.now);
    protectedTurns.forEach((turn) => {
      turn.compactionProtection = '';
      turn.compactionProtectionReleasedAt = releasedAt;
      turn.compactionProtectionReleaseReason = reason;
    });
    return protectedTurns.length;
  }

  getUncompressedTurns() {
    this.ensureLoaded();
    return this.state.turns.filter(turn => !turn.compacted);
  }

  getUncompressedHistoryTokenCount() {
    return estimateMaidTurnsTokens(this.getUncompressedTurns());
  }

  shouldCompactHistory() {
    const activeTurns = this.getUncompressedTurns();
    return (
      activeTurns.length > this.compactionTurnThreshold ||
      estimateMaidTurnsTokens(activeTurns) > this.compactionHistoryTokenThreshold
    );
  }

  compactHistoryToMemory({ force = false } = {}) {
    this.ensureLoaded();
    const activeTurns = this.state.turns.filter(turn => !turn.compacted);
    if (!force && !this.shouldCompactHistory()) return null;
    const keepStart = Math.max(0, activeTurns.length - MAID_CONTEXT_KEEP_RECENT_AFTER_COMPACT);
    const compactableTurns = activeTurns
      .slice(0, keepStart)
      .filter(turn => !trim(turn?.compactionProtection));
    if (!compactableTurns.length) return null;
    const compactableIds = new Set(compactableTurns.map(turn => turn.id));
    const at = safeNow(this.now);
    const nextIndex = Number(this.state.compactionCount || 0) + 1;
    this.archiveCompactedTurns(compactableTurns);
    const row = buildMemoryRowFromTurns(
      compactableTurns,
      { at, compactionIndex: nextIndex },
    );
    if (!row) return null;
    row.kind = 'legacy_episode';
    this.state.turns = this.state.turns.map(turn => (
      compactableIds.has(turn.id) ? { ...turn, compacted: true } : turn
    ));
    this.state.memoryRows.push(row);
    const evictedMemoryRows = this.state.memoryRows.length > MAID_CONTEXT_MAX_MEMORY_ROWS
      ? this.state.memoryRows.slice(0, this.state.memoryRows.length - MAID_CONTEXT_MAX_MEMORY_ROWS)
      : [];
    if (evictedMemoryRows.length) this.archiveEvictions({ memoryRows: evictedMemoryRows });
    this.state.memoryRows = this.state.memoryRows.slice(-MAID_CONTEXT_MAX_MEMORY_ROWS);
    this.state.compactionCount = nextIndex;
    this.state.lastCompactionAt = at;
    this.state.pendingInjectedTokens = 0;
    this.state.extractionBatches.push(normalizeExtractionBatch({
      id: `maid_extract_${at}_${nextIndex}`,
      sourceTurnIds: compactableTurns.map(turn => turn.id),
      status: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    }, { now: this.now }));
    this.state.extractionBatches = trimExtractionBatches(this.state.extractionBatches);
    return row;
  }

  async recordContextInjection(tokenCount = 0) {
    this.ensureLoaded();
    const count = Math.max(0, Number(tokenCount) || 0);
    if (!count) return null;
    this.state.totalInjectedTokens += count;
    this.state.pendingInjectedTokens = 0;
    await this.write();
    return null;
  }

  resolveExtractionBatchTurns(batch = {}) {
    const ids = new Set(Array.isArray(batch?.sourceTurnIds) ? batch.sourceTurnIds : []);
    if (!ids.size) return [];
    const archive = this.getLegacyArchive();
    const candidates = [
      ...this.state.turns,
      ...(Array.isArray(archive?.compactedTurns) ? archive.compactedTurns : []),
      ...(Array.isArray(archive?.evictedTurns) ? archive.evictedTurns : []),
      ...(Array.isArray(archive?.baseline?.turns) ? archive.baseline.turns : []),
    ];
    const byId = new Map();
    candidates.forEach((turn) => {
      const id = trim(turn?.id);
      if (id && ids.has(id) && !byId.has(id)) byId.set(id, normalizeTurn(turn, { now: this.now }));
    });
    return batch.sourceTurnIds.map(id => byId.get(id)).filter(Boolean);
  }

  async upsertStructuredMemoriesForBatch(batch = {}, turns = []) {
    if (!this.semanticMemoryStore || typeof this.semanticMemoryStore.upsertMemory !== 'function') return 0;
    let count = 0;
    for (const turn of turns) {
      for (const signal of Array.isArray(turn?.structuredMemories) ? turn.structuredMemories : []) {
        const sourceTurnIds = Array.from(new Set([
          ...(Array.isArray(signal?.sourceTurnIds) ? signal.sourceTurnIds : []),
          turn.id,
        ].map(id => trim(id)).filter(Boolean)));
        if (signal?.kind === 'task_state' && signal?.status === 'resolved') {
          const existing = this.semanticMemoryStore
            .listMemories?.({ kind: 'task_state' })
            ?.find(memory => memory.key === signal.key);
          if (!existing) continue;
        }
        const result = await this.semanticMemoryStore.upsertMemory({
          ...clone(signal),
          scopeId: trim(this.semanticMemoryStore.scopeId, 'maid_default'),
          sourceTurnIds,
        });
        if (result?.ok) count += 1;
      }
    }
    return count;
  }

  async upsertExtractedMemoriesForBatch(batch = {}, extractionResult = {}) {
    if (!this.semanticMemoryStore || typeof this.semanticMemoryStore.upsertMemory !== 'function') return 0;
    const allowedSources = new Set(Array.isArray(batch?.sourceTurnIds) ? batch.sourceTurnIds : []);
    const candidateKeys = Array.isArray(extractionResult?.candidateKeys)
      ? extractionResult.candidateKeys
      : [];
    let count = 0;
    for (const rawMemory of Array.isArray(extractionResult?.memories)
      ? extractionResult.memories.slice(0, 12)
      : []) {
      const sourceTurnIds = (Array.isArray(rawMemory?.sourceTurnIds) ? rawMemory.sourceTurnIds : [])
        .map(id => trim(id))
        .filter(id => allowedSources.has(id));
      if (!sourceTurnIds.length) continue;
      const result = await this.semanticMemoryStore.upsertMemory({
        ...clone(rawMemory),
        scopeId: trim(this.semanticMemoryStore.scopeId, 'maid_default'),
        sourceTurnIds,
        keyOrigin: 'candidate',
      }, { candidateKeys });
      if (result?.ok) count += 1;
    }
    return count;
  }

  async processPendingExtractions() {
    this.ensureLoaded();
    if (!this.semanticMemoryStore) return [];
    const processed = [];
    const startedAt = safeNow(this.now);
    const pending = this.state.extractionBatches.filter(batch => (
      batch.status === 'pending' &&
      batch.attempts < MAID_EXTRACTION_MAX_AUTO_ATTEMPTS &&
      Number(batch.nextRetryAt || 0) <= startedAt
    ));
    for (const batch of pending) {
      const turns = this.resolveExtractionBatchTurns(batch);
      if (!turns.length) {
        batch.status = 'paused';
        batch.lastError = 'source_turns_unavailable';
        batch.pauseReason = 'source_turns_unavailable';
        batch.nextRetryAt = 0;
        batch.updatedAt = safeNow(this.now);
        await this.write();
        processed.push(clone(batch));
        continue;
      }
      try {
        if (!batch.deterministicComplete) {
          await this.upsertStructuredMemoriesForBatch(batch, turns);
          batch.deterministicComplete = true;
          batch.updatedAt = safeNow(this.now);
          await this.write();
        }
        if (typeof this.extractSemanticMemories !== 'function') {
          batch.lastError = 'extractor_unavailable';
          batch.nextRetryAt = safeNow(this.now) + MAID_EXTRACTION_RETRY_DELAYS_MS[0];
          batch.updatedAt = safeNow(this.now);
          await this.write();
          processed.push(clone(batch));
          continue;
        }
        batch.attempts += 1;
        batch.nextRetryAt = 0;
        batch.updatedAt = safeNow(this.now);
        const extractionResult = await this.extractSemanticMemories({
          turns: clone(turns),
          scopeId: trim(this.semanticMemoryStore.scopeId, 'maid_default'),
          batch: clone(batch),
        });
        appendExtractionUsage(batch, extractionResult?.usageEntries);
        const extractedCount = await this.upsertExtractedMemoriesForBatch(batch, extractionResult);
        batch.status = 'completed';
        batch.extractedCount = extractedCount;
        batch.modelSource = truncate(extractionResult?.modelSource, 40);
        batch.model = truncate(extractionResult?.model, 120);
        batch.fallbackUsed = batch.fallbackUsed || extractionResult?.fallbackUsed === true;
        batch.lastError = '';
        batch.nextRetryAt = 0;
        batch.pauseReason = '';
        batch.completedAt = safeNow(this.now);
        batch.updatedAt = batch.completedAt;
      } catch (error) {
        appendExtractionUsage(batch, error?.memoryExtractionUsage);
        batch.lastError = truncate(error?.message || String(error || 'memory extraction failed'), 500);
        if (batch.attempts >= MAID_EXTRACTION_MAX_AUTO_ATTEMPTS) {
          batch.status = 'paused';
          batch.pauseReason = 'auto_retry_exhausted';
          batch.nextRetryAt = 0;
        } else {
          const retryIndex = Math.min(
            Math.max(0, batch.attempts - 1),
            MAID_EXTRACTION_RETRY_DELAYS_MS.length - 1,
          );
          batch.status = 'pending';
          batch.pauseReason = '';
          batch.nextRetryAt = safeNow(this.now) + MAID_EXTRACTION_RETRY_DELAYS_MS[retryIndex];
        }
        batch.updatedAt = safeNow(this.now);
        this.logger?.warn?.(
          batch.status === 'paused'
            ? 'maid semantic memory batch paused after retry budget'
            : 'maid semantic memory batch remains pending',
          error,
        );
      }
      await this.write();
      processed.push(clone(batch));
    }
    return processed;
  }

  schedulePendingExtractions() {
    if (!this.semanticMemoryStore) return null;
    if (this.extractionPromise) {
      this.extractionRerunRequested = true;
      return this.extractionPromise;
    }
    const promise = Promise.resolve()
      .then(() => this.processPendingExtractions())
      .catch((error) => {
        this.logger?.warn?.('maid semantic memory background extraction failed', error);
        return [];
      });
    this.extractionPromise = promise;
    this.lastExtractionPromise = promise;
    promise.finally(() => {
      if (this.extractionPromise !== promise) return;
      this.extractionPromise = null;
      if (this.extractionRerunRequested) {
        this.extractionRerunRequested = false;
        this.schedulePendingExtractions();
      }
    });
    return promise;
  }

  async flushPendingExtractions() {
    if (!this.extractionPromise) {
      return this.lastExtractionPromise ? this.lastExtractionPromise : [];
    }
    let output = [];
    while (this.extractionPromise) {
      const pending = this.extractionPromise;
      output = await pending;
      if (this.extractionPromise === pending) break;
    }
    return output;
  }

  getLegacyArchive() {
    this.ensureLegacyArchiveSync(this.state);
    return clone(this.legacyArchive);
  }

  exportState() {
    this.ensureLoaded();
    return clone(this.state);
  }
}
