import { resolveInputTokenBudget } from '../../memory/input-token-budget-utils.js';
import {
  estimateTokens,
  normalizeTokenMode,
  resolveTokenEstimateCoefficient,
} from '../../memory/memory-prompt-utils.js';

const clampNonNegativeInt = (value, fallback = 0) => {
  const next = Math.trunc(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, next);
};

export const dropTrailingPendingUserEcho = (history = [], pendingUserText = '') => {
  const list = Array.isArray(history) ? [...history] : [];
  const last = list[list.length - 1];
  if (
    pendingUserText &&
    last?.role === 'user' &&
    String(last.content || '').trim() === String(pendingUserText).trim()
  ) {
    list.pop();
  }
  return list;
};

export const applyChatHistoryLimit = (history = [], limit = 0) => {
  const list = Array.isArray(history) ? [...history] : [];
  const nextLimit = clampNonNegativeInt(limit, 0);
  if (nextLimit > 0 && list.length > nextLimit) {
    list.splice(0, list.length - nextLimit);
  }
  return list;
};

const estimateHistoryMessageTokens = (message, tokenMode = 'rough') => {
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part?.type === 'text') return sum + estimateTokens(String(part.text || ''), tokenMode);
      if (part?.type === 'image_url') return sum + 1;
      if (part?.type === 'input_audio') return sum + 1;
      return sum;
    }, 0);
  }
  return estimateTokens(String(content ?? ''), tokenMode);
};

const truncateTextToTokenBudget = (value, budgetTokens, tokenMode = 'rough') => {
  const text = String(value ?? '');
  const budget = clampNonNegativeInt(budgetTokens, 0);
  if (!text || budget <= 0) return '';
  if (estimateTokens(text, tokenMode) <= budget) return text;
  const suffix = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid)}${suffix}`;
    if (estimateTokens(candidate, tokenMode) <= budget) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low)}${suffix}` : '';
};

export const limitHistoryByTokenBudget = (
  history = [],
  {
    maxContext = 0,
    maxOut = 0,
    reserveTokens = 512,
    inputBudgetTokens = null,
    capPerMessageTokens = null,
    tokenMode = 'rough',
    protectedMessageIndexes = [],
    getMessagePrefix = null,
  } = {},
) => {
  const protectedIndexes = new Set(
    (Array.isArray(protectedMessageIndexes) ? protectedMessageIndexes : [])
      .map(value => Math.trunc(Number(value)))
      .filter(value => Number.isFinite(value) && value >= 0),
  );
  const entries = (Array.isArray(history) ? history : []).map((item, originalIndex) => ({
    originalIndex,
    protected: protectedIndexes.has(originalIndex),
    message: item && typeof item === 'object' ? { ...item } : item,
  }));
  const budget = resolveInputTokenBudget({
    maxContextTokens: maxContext,
    maxOutputTokens: maxOut,
    safetyReserveTokens: reserveTokens,
    userBudgetTokens: inputBudgetTokens,
  });
  const quota = budget.inputBudgetTokens;
  const explicitPerMessage = Math.trunc(Number(capPerMessageTokens));
  const perMessageLimit = Number.isFinite(explicitPerMessage) && explicitPerMessage > 0
    ? (quota === null ? explicitPerMessage : Math.min(explicitPerMessage, quota))
    : quota;
  let truncatedMessageCount = 0;
  const prefixTokens = (message, previous = null) => typeof getMessagePrefix === 'function'
    ? estimateTokens(getMessagePrefix(message, previous), tokenMode)
    : 0;

  // 每条 token 估算只做一次并缓存在 entry 上，淘汰时维护差量和；
  // 数千楼×千字的会话若每删一条就全量重算会拖到秒级。
  let totalTokens = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const message = entry.message;
    const textLimit = perMessageLimit === null ? null : Math.max(0, perMessageLimit - prefixTokens(message));
    if (
      perMessageLimit !== null
      && !entry.protected
      && message
      && typeof message.content === 'string'
      && estimateHistoryMessageTokens(message, tokenMode) > textLimit
    ) {
      message.content = truncateTextToTokenBudget(message.content, textLimit, tokenMode);
      truncatedMessageCount += 1;
    }
    entry.prefixTokens = prefixTokens(entry.message, entries[index - 1]?.message);
    entry.tokens = estimateHistoryMessageTokens(entry.message, tokenMode) + entry.prefixTokens;
    totalTokens += entry.tokens;
  }
  let droppedMessageCount = 0;
  if (quota !== null) {
    let scanIndex = 0;
    while (entries.length > 1 && totalTokens > quota) {
      while (scanIndex < entries.length && entries[scanIndex].protected) scanIndex += 1;
      if (scanIndex >= entries.length) break;
      totalTokens -= entries[scanIndex].tokens;
      entries.splice(scanIndex, 1);
      const next = entries[scanIndex];
      if (next && getMessagePrefix) {
        const nextPrefixTokens = prefixTokens(next.message, entries[scanIndex - 1]?.message);
        const delta = nextPrefixTokens - next.prefixTokens;
        next.prefixTokens = nextPrefixTokens;
        next.tokens += delta;
        totalTokens += delta;
      }
      droppedMessageCount += 1;
    }
    if (
      entries.length === 1
      && totalTokens > quota
      && !entries[0].protected
      && typeof entries[0].message?.content === 'string'
    ) {
      const textBudget = Math.max(0, quota - prefixTokens(entries[0].message));
      entries[0].message.content = truncateTextToTokenBudget(entries[0].message.content, textBudget, tokenMode);
      truncatedMessageCount += 1;
      entries[0].tokens = estimateHistoryMessageTokens(entries[0].message, tokenMode) + prefixTokens(entries[0].message);
      totalTokens = entries[0].tokens;
    }
  }

  return {
    messages: entries.map(entry => entry.message),
    stats: {
      ...budget,
      usedTokens: totalTokens,
      originalMessageCount: Array.isArray(history) ? history.length : 0,
      keptMessageCount: entries.length,
      droppedMessageCount,
      truncatedMessageCount,
      protectedMessageCount: entries.filter(entry => entry.protected).length,
      keptOriginalIndexes: entries.map(entry => entry.originalIndex),
      overflowed: quota !== null && totalTokens > quota,
      tokenMode: normalizeTokenMode(tokenMode),
      tokenEstimateCoefficient: resolveTokenEstimateCoefficient(tokenMode),
    },
  };
};

// 轮次口径必须与写表盖章端 countUserTurnsForMemoryTimeline 一致：
// AI 代发的用户消息（meta.generatedByAssistant）不推进轮号，只归属当前轮，
// 否则含代发消息的会话里覆盖保护会整体错位。
const isTrackedTurnUserMessage = (message) => {
  if (!message || message.role !== 'user') return false;
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  return meta.generatedByAssistant !== true;
};

export const mapHistoryMessagesToTurns = (history = [], { lastTurn = 0 } = {}) => {
  const list = Array.isArray(history) ? history : [];
  const userCount = list.filter(isTrackedTurnUserMessage).length;
  const normalizedLastTurn = Math.max(userCount, Math.trunc(Number(lastTurn)) || userCount);
  let currentTurn = Math.max(0, normalizedLastTurn - userCount);
  return list.map((message, index) => {
    if (isTrackedTurnUserMessage(message)) currentTurn += 1;
    return {
      index,
      turn: currentTurn > 0 ? currentTurn : null,
      role: String(message?.role || ''),
    };
  });
};

export const resolveCoverageProtectedHistoryIndexes = ({
  history = [],
  holes = [],
  lastTurn = 0,
} = {}) => {
  const ranges = (Array.isArray(holes) ? holes : [])
    .map((hole) => {
      const from = Math.trunc(Number(hole?.from));
      const to = Math.trunc(Number(hole?.to));
      if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
      return { from: Math.min(from, to), to: Math.max(from, to) };
    })
    .filter(Boolean);
  if (!ranges.length) return [];
  return mapHistoryMessagesToTurns(history, { lastTurn })
    .filter(item => item.turn !== null && ranges.some(range => item.turn >= range.from && item.turn <= range.to))
    .map(item => item.index);
};

export const applyHistoryTokenBudget = (history = [], options = {}) =>
  limitHistoryByTokenBudget(history, options).messages;

// 兼容旧调用名；实现已经改为 token 量纲。
export const applyHistoryCharBudget = applyHistoryTokenBudget;

export const limitCreativeAssistantHistory = (history = [], creativeLimit = 0) => {
  const list = Array.isArray(history) ? [...history] : [];
  const nextLimit = clampNonNegativeInt(creativeLimit, 0);
  if (nextLimit <= 0) return list;

  const creativeAssistantIdx = [];
  list.forEach((message, idx) => {
    if (message?.__creative && message?.role === 'assistant') creativeAssistantIdx.push(idx);
  });
  if (creativeAssistantIdx.length <= nextLimit) return list;

  const firstAssistantToKeep = creativeAssistantIdx[creativeAssistantIdx.length - nextLimit];
  let keepStart = firstAssistantToKeep;
  for (let i = firstAssistantToKeep - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user') {
      keepStart = i;
      break;
    }
  }
  return list.slice(keepStart);
};

export const injectReasoningIntoHistory = (
  history = [],
  {
    enabled = false,
    prefix = '',
    suffix = '',
    separator = '',
    maxAdditions = 1,
    applyMacros = value => String(value ?? ''),
  } = {},
) => {
  const list = (Array.isArray(history) ? history : []).map(item => (
    item && typeof item === 'object' ? { ...item } : item
  ));
  if (!enabled || (!prefix && !suffix && !separator)) return list;

  const limit = clampNonNegativeInt(maxAdditions, 1);
  if (limit <= 0) return list;

  const resolvedPrefix = applyMacros(prefix);
  const resolvedSuffix = applyMacros(suffix);
  const resolvedSeparator = applyMacros(separator);
  let added = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (added >= limit) break;
    const message = list[i];
    if (!message || message.role !== 'assistant') continue;
    const reasoning = String(message.__reasoning || '').trim();
    if (!reasoning) continue;
    const block = `${resolvedPrefix}${reasoning}${resolvedSuffix}${resolvedSeparator}`;
    message.content = `${block}${message.content || ''}`;
    added += 1;
  }
  return list;
};

export const stripTransientHistoryFields = (history = []) => (
  (Array.isArray(history) ? history : []).map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (!('__creative' in message) && !('__reasoning' in message)) return message;
    const { __creative, __reasoning, ...rest } = message;
    return rest;
  })
);

export const finalizeLlmHistory = (
  history = [],
  {
    pendingUserText = '',
    chatHistoryLimit = 0,
    openaiPreset = null,
    rpUiMode = false,
    creativeHistoryLimit = 0,
    historyTokenBudget = null,
    deferHistoryTokenBudget = false,
    onHistoryBudgetApplied = null,
    reasoning = null,
  } = {},
) => {
  let next = dropTrailingPendingUserEcho(history, pendingUserText);
  next = applyChatHistoryLimit(next, chatHistoryLimit);
  if (!deferHistoryTokenBudget) {
    const limited = limitHistoryByTokenBudget(next, {
      maxContext: openaiPreset?.openai_max_context,
      maxOut: openaiPreset?.openai_max_tokens,
      inputBudgetTokens: historyTokenBudget,
    });
    next = limited.messages;
    if (typeof onHistoryBudgetApplied === 'function') onHistoryBudgetApplied(limited.stats);
  }
  if (rpUiMode) {
    next = limitCreativeAssistantHistory(next, creativeHistoryLimit);
  }
  next = injectReasoningIntoHistory(next, {
    enabled: reasoning?.enabled === true,
    prefix: reasoning?.prefix ?? '',
    suffix: reasoning?.suffix ?? '',
    separator: reasoning?.separator ?? '',
    maxAdditions: reasoning?.maxAdditions ?? 1,
    applyMacros: reasoning?.applyMacros || (value => String(value ?? '')),
  });
  return stripTransientHistoryFields(next);
};
