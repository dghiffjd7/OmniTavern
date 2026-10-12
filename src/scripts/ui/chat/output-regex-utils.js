const normalizeRegexResult = (value) => String(value ?? '');

const maybeNormalizeText = (value, normalizeText) => {
  if (typeof normalizeText !== 'function') return normalizeRegexResult(value);
  try {
    return normalizeRegexResult(normalizeText(value));
  } catch {
    return normalizeRegexResult(value);
  }
};

export const applyOutputStoredRegexSafe = (
  source,
  {
    appBridge = typeof window !== 'undefined' ? window.appBridge : null,
    depth = 0,
    isEdit = false,
    normalizeText,
    onError,
  } = {},
) => {
  const input = normalizeRegexResult(source);
  let output = input;
  if (typeof appBridge?.applyOutputStoredRegex === 'function') {
    try {
      output = appBridge.applyOutputStoredRegex(input, { isEdit, depth });
    } catch (err) {
      if (typeof onError === 'function') onError(err, 'stored');
      output = input;
    }
  }
  return maybeNormalizeText(output, normalizeText);
};

export const applyOutputDisplayRegexSafe = (
  source,
  {
    appBridge = typeof window !== 'undefined' ? window.appBridge : null,
    depth = 0,
    isEdit = false,
    normalizeText,
    onError,
  } = {},
) => {
  const input = normalizeRegexResult(source);
  let output = input;
  if (typeof appBridge?.applyOutputDisplayRegex === 'function') {
    try {
      output = appBridge.applyOutputDisplayRegex(input, { isEdit, depth });
    } catch (err) {
      if (typeof onError === 'function') onError(err, 'display');
      output = input;
    }
  }
  return maybeNormalizeText(output, normalizeText);
};

export const applyOutputRegexPairSafe = (
  source,
  {
    appBridge = typeof window !== 'undefined' ? window.appBridge : null,
    depth = 0,
    isEdit = false,
    normalizeText,
    onError,
  } = {},
) => {
  const stored = applyOutputStoredRegexSafe(source, {
    appBridge,
    depth,
    isEdit,
    normalizeText,
    onError,
  });
  const display = applyOutputDisplayRegexSafe(stored, {
    appBridge,
    depth,
    isEdit,
    normalizeText,
    onError,
  });
  return { stored, display };
};

// 发给 AI 的历史消息套用正则（含仅提示词与深度，深度 0 = 最后一条）；自定义提示词区块开或关的两条组装路径共用。
export const applyPromptHistoryRegex = (content, { role, depth, regex, context, placements } = {}) => {
  const text = normalizeRegexResult(content);
  if (typeof regex?.apply !== 'function') return text;
  const placement = role === 'user' ? placements?.USER_INPUT : placements?.AI_OUTPUT;
  return normalizeRegexResult(regex.apply(text, context, placement, {
    isMarkdown: false,
    isPrompt: true,
    isEdit: false,
    depth,
  }));
};
