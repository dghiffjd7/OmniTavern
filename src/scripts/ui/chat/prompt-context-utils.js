import { getBridgeConfig } from '../config-runtime-utils.js';
import { getPresetStore } from '../preset-store-runtime-utils.js';

export const buildPresetContext = ({
  sessionId = '',
  uiMode = 'chat',
} = {}) => ({
  sessionId: String(sessionId || '').trim(),
  uiMode: String(uiMode || '').trim() || 'chat',
});

export const resolveResolvedPreset = (appBridge, presetType, context = {}) => {
  try {
    return getPresetStore(appBridge)?.getResolvedActive?.(String(presetType || '').trim(), context)?.preset || {};
  } catch {
    return {};
  }
};

export const resolveEnabledPreset = (appBridge, presetType, context = {}) => {
  const type = String(presetType || '').trim();
  if (!type) return {};
  try {
    const enabled = getPresetStore(appBridge)?.getSelectionState?.()?.enabled || {};
    if (!enabled?.[type]) return {};
  } catch {
    return {};
  }
  return resolveResolvedPreset(appBridge, type, context);
};

export const resolveOpenAIPresetFormatReminderState = (openaiResolved = {}, activeOpenAIPreset = null) => {
  const presetId = String(openaiResolved?.presetId || '').trim();
  const presetName = String(activeOpenAIPreset?.name || '').trim();
  const hasPreset = Boolean(presetId || presetName || activeOpenAIPreset);
  const isDefaultPreset = typeof openaiResolved?.isBuiltinDefault === 'boolean'
    ? openaiResolved.isBuiltinDefault
    : (
        presetId.toLowerCase() === 'default'
        || presetName.toLowerCase() === 'default'
      );
  return {
    presetId,
    presetName,
    hasPreset,
    isDefaultPreset,
  };
};

export const buildPendingUserTextWithScenarioReminder = ({
  rawText = '',
  replyHint = '',
  scenarioReminder = '',
  suppressPendingUserTurn = false,
  appendScenarioReminder = false,
} = {}) => {
  if (suppressPendingUserTurn) return '';
  const pendingUserTextRaw = String(rawText ?? '').trim();
  const pendingUserHint = String(replyHint ?? '').trim();
  const baseText = !pendingUserTextRaw
    ? (pendingUserHint ? `（${pendingUserHint}）` : '')
    : (pendingUserHint ? `${pendingUserTextRaw}（${pendingUserHint}）` : pendingUserTextRaw);
  const scenario = appendScenarioReminder ? String(scenarioReminder || '').trim() : '';
  const scenarioText = scenario ? `（${scenario}）` : '';
  return [baseText, scenarioText].filter(Boolean).join('\n\n');
};

const PROMPT_POST_PROCESSING_MODES = new Set(['none', 'merge', 'semi', 'strict', 'single']);
const PROMPT_EMPTY_TEXT_PLACEHOLDER = "Let's get started.";

export const normalizePromptPostProcessingMode = (mode = '') => {
  const raw = String(mode || '').trim().toLowerCase();
  return PROMPT_POST_PROCESSING_MODES.has(raw) ? raw : 'none';
};

const normalizePromptMessageRole = (role) => {
  const raw = String(role || '').trim().toLowerCase();
  return raw === 'user' || raw === 'assistant' || raw === 'system' ? raw : 'user';
};

const contentHasPromptText = (content) => {
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (part?.type === 'text') return String(part.text || '').trim().length > 0;
      return Boolean(part);
    });
  }
  return String(content ?? '').trim().length > 0;
};

const mergePromptMessageContent = (left, right) => {
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (!leftIsArray && !rightIsArray) {
    return [String(left ?? ''), String(right ?? '')]
      .filter(part => part.length > 0)
      .join('\n\n');
  }

  const toParts = (content) => {
    if (Array.isArray(content)) return content.filter(Boolean).map(part => ({ ...part }));
    const text = String(content ?? '');
    return text ? [{ type: 'text', text }] : [];
  };
  const parts = [...toParts(left)];
  for (const part of toParts(right)) {
    const last = parts[parts.length - 1];
    if (last?.type === 'text' && part?.type === 'text') {
      last.text = [last.text, part.text].filter(Boolean).join('\n\n');
    } else {
      parts.push(part);
    }
  }
  return parts;
};

// 传输锚点占位消息（整条内容只有 chat-semantic:* 标记）：
// merge 模式下保持独立且不阻断两侧同角色合并，保证 FC/JSON 剥离该层后的
// 结构与「该层不存在」时完全一致（阶段 O 逐字节隔离不变量）。
const TRANSPORT_ANCHOR_ONLY_PATTERN = /^(?:\s*\uE000chat-semantic:[^\uE001]*\uE001\s*)+$/;
const isTransportAnchorOnlyContent = content => (
  typeof content === 'string' && content.length > 0 && TRANSPORT_ANCHOR_ONLY_PATTERN.test(content)
);

const mergeAdjacentPromptMessages = (messages = [], { preserveTransportAnchors = false } = {}) => {
  const merged = [];
  let lastMergeable = null;
  for (const item of Array.isArray(messages) ? messages : []) {
    const { name, tool_calls, tool_call_id, ...rest } = item || {};
    const message = {
      ...rest,
      role: normalizePromptMessageRole(item?.role),
      content: item?.content ?? '',
    };
    if (preserveTransportAnchors && isTransportAnchorOnlyContent(message.content)) {
      merged.push(message);
      continue;
    }
    const prev = preserveTransportAnchors ? lastMergeable : merged[merged.length - 1];
    if (prev && prev.role === message.role && message.role !== 'tool') {
      prev.content = mergePromptMessageContent(prev.content, message.content);
    } else {
      merged.push(message);
      lastMergeable = message;
    }
  }
  return merged;
};

const ensurePromptMessagesNotEmpty = (messages = []) =>
  messages.length ? messages : [{ role: 'user', content: PROMPT_EMPTY_TEXT_PLACEHOLDER }];

export const applyMergePromptPostProcessing = (messages = [], { preserveTransportAnchors = false } = {}) =>
  ensurePromptMessagesNotEmpty(mergeAdjacentPromptMessages(messages, { preserveTransportAnchors }));

export const applySemiStrictPromptPostProcessing = (messages = []) => {
  const list = applyMergePromptPostProcessing(messages);
  for (let i = 0; i < list.length; i += 1) {
    if (i > 0 && list[i]?.role === 'system') {
      list[i] = { ...list[i], role: 'user' };
    }
  }
  return applyMergePromptPostProcessing(list);
};

export const applyStrictPromptPostProcessing = (messages = []) => {
  const list = applyMergePromptPostProcessing(messages);

  for (let i = 0; i < list.length; i += 1) {
    if (i > 0 && list[i]?.role === 'system') {
      list[i] = { ...list[i], role: 'user' };
    }
  }

  if (list[0]?.role === 'system') {
    if (list.length === 1 || list[1]?.role !== 'user') {
      list.splice(1, 0, { role: 'user', content: PROMPT_EMPTY_TEXT_PLACEHOLDER });
    }
  } else if (list[0]?.role !== 'user') {
    list.unshift({ role: 'user', content: PROMPT_EMPTY_TEXT_PLACEHOLDER });
  }

  const merged = mergeAdjacentPromptMessages(list);
  return merged.map(message => (
    contentHasPromptText(message.content) ? message : { ...message, content: PROMPT_EMPTY_TEXT_PLACEHOLDER }
  ));
};

export const applySingleUserPromptPostProcessing = (messages = []) =>
  ensurePromptMessagesNotEmpty(mergeAdjacentPromptMessages(
    (Array.isArray(messages) ? messages : []).map(item => ({
      ...(item || {}),
      role: 'user',
    })),
  ));

export const applyPromptPostProcessing = (messages = [], mode = 'none') => {
  switch (normalizePromptPostProcessingMode(mode)) {
    case 'merge':
      // merge 保留角色语义，锚点占位须独立保留（semi/strict/single 会统一角色，占位并入邻居仍可精确还原）
      return applyMergePromptPostProcessing(messages, { preserveTransportAnchors: true });
    case 'semi':
      return applySemiStrictPromptPostProcessing(messages);
    case 'strict':
      return applyStrictPromptPostProcessing(messages);
    case 'single':
      return applySingleUserPromptPostProcessing(messages);
    case 'none':
    default:
      return Array.isArray(messages) ? messages : [];
  }
};

export const createPresetRuntime = ({
  appBridge = null,
  getSessionId = null,
  getUiMode = null,
  isDeepSeekRequest = null,
} = {}) => {
  const getPresetContext = () =>
    buildPresetContext({
      sessionId: getSessionId?.(),
      uiMode: getUiMode?.(),
    });

  const getPresetByType = (type) => resolveResolvedPreset(appBridge, type, getPresetContext());
  const getOpenAIPreset = () => getPresetByType('openai');
  const getReasoningPreset = () => getPresetByType('reasoning');

  const canUseDeepSeekPrefixCompletion = () => {
    const config = getBridgeConfig(appBridge);
    if (String(config?.provider || '').trim().toLowerCase() === 'custom') return false;
    return typeof isDeepSeekRequest === 'function'
      ? isDeepSeekRequest({
          provider: config?.provider,
          model: config?.model,
          baseUrl: config?.baseUrl,
        }) === true
      : false;
  };

  const canUseDeepSeekContinuePrefill = () =>
    canUseDeepSeekPrefixCompletion() && getOpenAIPreset()?.continue_prefill === true;

  return {
    getPresetContext,
    getOpenAIPreset,
    getReasoningPreset,
    canUseDeepSeekPrefixCompletion,
    canUseDeepSeekContinuePrefill,
  };
};

export const buildReplyPromptHint = (contexts = []) => {
  const list = Array.isArray(contexts) ? contexts.filter(Boolean) : [];
  if (!list.length) return '';
  const toReplyHintLine = (item) =>
    `${item.userMessage || '[消息]'}（回复了${item.replyTo?.author || '消息'}：${item.replyTo?.content || '...'}）`;
  if (list.length === 1) {
    return toReplyHintLine(list[0]);
  }
  return list.map((item, index) => `${index + 1}. ${toReplyHintLine(item)}`).join('；');
};
