import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';

const IMAGE_PROMPT_TAG = 'image_prompt';

const htmlDecodeLite = (value = '') => String(value ?? '')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")
  .replace(/&amp;/gi, '&');

const normalizePromptText = (value = '') => String(value ?? '')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const IMAGE_PROMPT_OPEN_RE = /<\s*image_prompt(?:\s[^>]*)?\s*>/gi;
const IMAGE_PROMPT_CLOSE_RE = /<\s*\/\s*image_prompt\s*>/gi;
const ESCAPED_IMAGE_PROMPT_OPEN_RE = /&lt;\s*image_prompt(?:\s[^&]*?)?&gt;/gi;
const ESCAPED_IMAGE_PROMPT_CLOSE_RE = /&lt;\s*\/\s*image_prompt\s*&gt;/gi;
const PROTECTED_IMAGE_PROMPT_OPEN_PREFIX = '\uE000chatapp-image-prompt-open-';
const PROTECTED_IMAGE_PROMPT_OPEN_SUFFIX = '\uE001';

const isEmptyPromptToken = (value = '') => {
  const raw = String(value || '').trim().toLowerCase();
  return !raw || raw === 'none' || raw === 'null' || raw === 'n/a' || raw === '无' || raw === '不需要';
};

const stripMarkdownCodeBlocks = (value = '') => String(value ?? '')
  .replace(/```[\s\S]*?```/g, '')
  .replace(/~~~[\s\S]*?~~~/g, '');

const stripReasoningLikeBlocks = (value = '') => String(value ?? '')
  .replace(/<\s*(?:think|thinking|reasoning)(?:\s[^>]*)?\s*>[\s\S]*?<\s*\/\s*(?:think|thinking|reasoning)\s*>/gi, '');

// 整篇回复被同一个代码块从头包到尾（如预设把回复伪装成终端输出）时，这层只是外壳，里面的标签照常识别。
const findWholeReplyFenceRange = (value = '') => {
  const text = String(value ?? '');
  const start = text.search(/\S/);
  const fence = start < 0 ? '' : text.slice(start, start + 3);
  if (fence !== '```' && fence !== '~~~') return null;
  const end = text.trimEnd().length;
  return text.indexOf(fence, start + 3) === end - 3 && end - 3 > start + 3 ? { start, end } : null;
};

const unwrapWholeReplyFence = (value = '') => {
  const text = String(value ?? '');
  const range = findWholeReplyFenceRange(text);
  return range ? text.slice(0, range.start) + text.slice(range.start + 3, range.end - 3) + text.slice(range.end) : text;
};

const collectIgnoredAutoImagePromptRanges = (source = '') => {
  const text = String(source ?? '');
  const wrapper = findWholeReplyFenceRange(text);
  const ranges = [];
  const collect = (re) => {
    re.lastIndex = 0;
    let match = null;
    while ((match = re.exec(text))) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  };
  collect(/```[\s\S]*?```/g);
  collect(/~~~[\s\S]*?~~~/g);
  collect(/<\s*(?:think|thinking|reasoning)(?:\s[^>]*)?\s*>[\s\S]*?<\s*\/\s*(?:think|thinking|reasoning)\s*>/gi);
  return ranges
    .filter(range => !wrapper || range.start !== wrapper.start || range.end !== wrapper.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
};

const rangeIntersects = (start = 0, end = 0, ranges = []) =>
  ranges.some(range => start < range.end && end > range.start);

const replaceClosedImagePromptBlocks = (source = '', replacer = () => '', {
  openRe = IMAGE_PROMPT_OPEN_RE,
  closeRe = IMAGE_PROMPT_CLOSE_RE,
  ignoredRanges = [],
} = {}) => {
  const text = String(source ?? '');
  if (!text) return text;
  const openScanner = new RegExp(openRe.source, openRe.flags);
  const closeScanner = new RegExp(closeRe.source, closeRe.flags);
  let out = '';
  let cursor = 0;
  let tagIndex = 0;
  let open = null;
  while ((open = openScanner.exec(text))) {
    const openStart = open.index;
    const openEnd = open.index + open[0].length;
    const nextOpenScanner = new RegExp(openRe.source, openRe.flags);
    nextOpenScanner.lastIndex = openEnd;
    closeScanner.lastIndex = openEnd;
    const close = closeScanner.exec(text);
    const nextOpen = nextOpenScanner.exec(text);
    if (!close || (nextOpen && nextOpen.index < close.index)) {
      openScanner.lastIndex = openEnd;
      continue;
    }
    const closeStart = close.index;
    const closeEnd = close.index + close[0].length;
    if (rangeIntersects(openStart, closeEnd, ignoredRanges)) {
      openScanner.lastIndex = closeEnd;
      continue;
    }
    out += text.slice(cursor, openStart);
    out += String(replacer(text.slice(openStart, closeEnd), text.slice(openEnd, closeStart), tagIndex) ?? '');
    tagIndex += 1;
    cursor = closeEnd;
    openScanner.lastIndex = closeEnd;
  }
  return cursor > 0 ? `${out}${text.slice(cursor)}` : text;
};

const stripDelimitedPlainBlocks = (value = '', start = '', end = '') => {
  const source = String(value ?? '');
  if (!source || !start || !end) return source;
  const re = new RegExp(`(?:<\\s*)?${start}(?:\\s*>|\\b)[\\s\\S]*?(?:<\\s*)?${end}(?:\\s*>|\\b)`, 'gi');
  return source.replace(re, '');
};

export const stripMomentBlocksForAutoImagePrompt = (text = '') => {
  const source = htmlDecodeLite(text);
  if (!source) return source;
  return stripDelimitedPlainBlocks(
    stripDelimitedPlainBlocks(source, 'moment_reply_start', 'moment_reply_end'),
    'moment_start',
    'moment_end',
  );
};

export const AUTO_IMAGE_PROMPT_TAG = IMAGE_PROMPT_TAG;

export const protectUnclosedAutoImagePromptTags = (text = '') => {
  const source = String(text ?? '');
  if (!source || !/<\s*image_prompt\b/i.test(source)) {
    return { text: source, replacements: [] };
  }
  const replacements = [];
  const protectedText = source.replace(IMAGE_PROMPT_OPEN_RE, (full, offset) => {
    const openEnd = offset + full.length;
    const closeRe = new RegExp(IMAGE_PROMPT_CLOSE_RE.source, IMAGE_PROMPT_CLOSE_RE.flags);
    closeRe.lastIndex = openEnd;
    const close = closeRe.exec(source);
    const nextOpenRe = new RegExp(IMAGE_PROMPT_OPEN_RE.source, IMAGE_PROMPT_OPEN_RE.flags);
    nextOpenRe.lastIndex = openEnd;
    const nextOpen = nextOpenRe.exec(source);
    if (close && (!nextOpen || close.index < nextOpen.index)) return full;
    const token = `${PROTECTED_IMAGE_PROMPT_OPEN_PREFIX}${replacements.length}${PROTECTED_IMAGE_PROMPT_OPEN_SUFFIX}`;
    replacements.push({ token, value: full });
    return token;
  });
  return { text: protectedText, replacements };
};

export const restoreProtectedAutoImagePromptTags = (text = '', protection = null) => {
  const replacements = Array.isArray(protection)
    ? protection
    : (Array.isArray(protection?.replacements) ? protection.replacements : []);
  if (!replacements.length) return String(text ?? '');
  let out = String(text ?? '');
  replacements.forEach(({ token, value }) => {
    if (!token) return;
    out = out.split(token).join(String(value || ''));
  });
  return out;
};

export const DEFAULT_AUTO_IMAGE_PROMPT_RULES = [
  '<generate_img_rule>',
  '自动生图标签规则，用于生成{{image_prompt_surface}}。',
  '当前图片模型：{{image_prompt_model}}',
  '提示词风格：{{image_prompt_style}}',
  '{{image_prompt_decision_mode}}',
  '【AI决策规则】',
  '- 若本轮需要新生成图片，输出 <image_prompt>...</image_prompt>',
  '- 若只是通过文本描述图片，输出 [img-内容]',
  '- 积极：用户明确要照片/自拍/图片时，优先视为新生成图片，使用 <image_prompt>',
  '- 标准：明确图片需求或强视觉场景才使用 <image_prompt>',
  '- 保守：只有用户明确要求图片生成时才使用 <image_prompt>',
  '请严格按以下XML格式输出：',
  '<image_prompt>这里写完整生图提示词</image_prompt>',
  '注意事项：',
  '- 所有信息需与当前剧情进展严格连贯。',
  '- 格式务必正确。',
  '- [img-内容] 是一般图片格式，<image_prompt> 是文生图格式，二者禁止在同一条内容中混用或嵌套。',
  '- 标签内只写生图提示词，不写解释、编号或 Markdown',
  '若本轮不需要图片，完全不要输出 <image_prompt> 标签。',
  '</generate_img_rule>',
].join('\n');

export const wrapAutoImagePromptInstruction = (value = '') => {
  const body = String(value || '').trim();
  if (!body) return '';
  if (/^<\s*generate_img_rule(?:\s[^>]*)?\s*>[\s\S]*<\s*\/\s*generate_img_rule\s*>$/i.test(body)) {
    return body;
  }
  return `<generate_img_rule>\n${body}\n</generate_img_rule>`;
};

export const normalizeAutoImagePromptStyle = (value = '') => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'nai' || raw === 'tags' || raw === 'tag') return 'nai_tags';
  if (raw === 'natural' || raw === 'prose') return 'natural';
  return 'auto';
};

export const describeAutoImagePromptStyle = (value = '') => {
  const style = normalizeAutoImagePromptStyle(value);
  if (style === 'nai_tags') return getLocalizedPromptText('auto_image.style.nai');
  if (style === 'natural') return getLocalizedPromptText('auto_image.style.natural');
  return getLocalizedPromptText('auto_image.style.auto');
};

export const describeAutoImagePromptDecisionMode = (value = '') => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'aggressive') {
    return getLocalizedPromptText('auto_image.decision.aggressive');
  }
  if (mode === 'standard') {
    return getLocalizedPromptText('auto_image.decision.standard');
  }
  return getLocalizedPromptText('auto_image.decision.conservative');
};

export const buildImagePromptModelHintFromConfig = (config = {}) => {
  const provider = String(config?.provider || '').trim();
  const model = String(config?.model || '').trim();
  return [provider, model].filter(Boolean).join(' / ');
};

export const normalizeAutoImagePromptTextKey = (value = '') =>
  String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

export const isAutoImagePromptAssistantRoundMessage = (message = {}) => {
  if (!message || message.role !== 'assistant') return false;
  if (message?.meta?.kind === 'memory-table-push') return false;
  const generated = message?.meta?.generatedMedia && typeof message.meta.generatedMedia === 'object'
    ? message.meta.generatedMedia
    : null;
  if (!generated) return true;
  const sourceId = String(generated.sourceMessageId || '').trim();
  const messageId = String(message.id || '').trim();
  return generated.source === 'auto_image_prompt' && sourceId && sourceId === messageId;
};

export const getAutoImagePromptAssistantOrdinal = (messages = [], messageId = '') => {
  const targetId = String(messageId || '').trim();
  if (!targetId) return 0;
  let ordinal = 0;
  for (const item of Array.isArray(messages) ? messages : []) {
    if (isAutoImagePromptAssistantRoundMessage(item)) ordinal += 1;
    if (String(item?.id || '') === targetId) return ordinal;
  }
  return ordinal;
};

export const collectAutoImagePromptGenerationHistory = (messages = []) => {
  let ordinal = 0;
  const ordinalById = new Map();
  const history = [];
  for (const item of Array.isArray(messages) ? messages : []) {
    const itemId = String(item?.id || '').trim();
    const isRound = isAutoImagePromptAssistantRoundMessage(item);
    if (isRound) {
      ordinal += 1;
      if (itemId) ordinalById.set(itemId, ordinal);
    }
    const generated = item?.meta?.generatedMedia && typeof item.meta.generatedMedia === 'object'
      ? item.meta.generatedMedia
      : null;
    if (!generated || generated.source !== 'auto_image_prompt') continue;
    const sourceId = String(generated.sourceMessageId || '').trim();
    const prompt = String(generated.prompt || '').trim();
    history.push({
      ordinal: (sourceId && ordinalById.get(sourceId)) || ordinal,
      prompt,
      key: normalizeAutoImagePromptTextKey(prompt),
    });
  }
  return history;
};

export const shouldAllowAutoImagePromptByRateLimit = ({
  messages = [],
  messageId = '',
  prompt = '',
  settings = {},
  nextAssistantTurn = false,
  checkRepeated = true,
} = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const currentOrdinal = nextAssistantTurn
    ? list.reduce((count, item) => count + (isAutoImagePromptAssistantRoundMessage(item) ? 1 : 0), 0) + 1
    : getAutoImagePromptAssistantOrdinal(list, messageId);
  const promptKey = normalizeAutoImagePromptTextKey(prompt);
  const history = collectAutoImagePromptGenerationHistory(list);
  if (checkRepeated && settings.autoImagePromptSkipRepeated !== false && promptKey && history.some(item => item.key === promptKey)) {
    return { ok: false, reason: 'repeated-prompt' };
  }
  const cooldown = Math.max(0, Math.trunc(Number(settings.autoImagePromptCooldownRounds) || 0));
  if (cooldown > 0 && history.length) {
    const last = history[history.length - 1];
    if (last && currentOrdinal > 0 && currentOrdinal - last.ordinal <= cooldown) {
      return { ok: false, reason: `cooldown-${cooldown}` };
    }
  }
  const windowRounds = Math.max(0, Math.trunc(Number(settings.autoImagePromptWindowRounds) || 0));
  const windowMax = Math.max(0, Math.trunc(Number(settings.autoImagePromptWindowMax) || 0));
  if (windowRounds > 0 && windowMax > 0 && currentOrdinal > 0) {
    const count = history.filter(item => currentOrdinal - item.ordinal < windowRounds).length;
    if (count >= windowMax) {
      return { ok: false, reason: `window-limit-${windowMax}-per-${windowRounds}` };
    }
  }
  return { ok: true, reason: '' };
};

export const buildAutoImagePromptInstruction = ({
  uiMode = 'chat',
  isGroupChat = false,
  modelHint = '',
  style = 'auto',
  decisionMode = 'conservative',
  template = '',
} = {}) => {
  const mode = String(uiMode || '').trim().toLowerCase();
  const surface = mode === 'rp'
    ? getLocalizedPromptText('auto_image.surface.creative')
    : (isGroupChat
      ? getLocalizedPromptText('auto_image.surface.group')
      : getLocalizedPromptText('auto_image.surface.private'));
  const targetModel = String(modelHint || '').trim()
    || getLocalizedPromptText('auto_image.model.unspecified');
  const source = String(template || '').trim()
    || getLocalizedPromptText('auto_image_prompt_rules', DEFAULT_AUTO_IMAGE_PROMPT_RULES);
  const rendered = source
    .replace(/\{\{\s*image_prompt_surface\s*\}\}/gi, surface)
    .replace(/\{\{\s*image_prompt_model\s*\}\}/gi, targetModel)
    .replace(/\{\{\s*image_prompt_style\s*\}\}/gi, describeAutoImagePromptStyle(style))
    .replace(/\{\{\s*image_prompt_decision_mode\s*\}\}/gi, describeAutoImagePromptDecisionMode(decisionMode))
    .replace(/\{\{\s*image_prompt_position_rule\s*\}\}/gi, '')
    .replace(/\{\{\s*image_prompt_tag\s*\}\}/gi, IMAGE_PROMPT_TAG)
    .trim();
  return wrapAutoImagePromptInstruction(rendered);
};

const normalizeAutoImagePromptLimit = (max, fallback) => {
  const raw = Math.trunc(Number(max));
  if (Number.isFinite(raw)) return raw <= 0 ? Number.POSITIVE_INFINITY : raw;
  return fallback <= 0 ? Number.POSITIVE_INFINITY : fallback;
};

export const extractAutoImagePrompts = (text = '', { max = 1, maxLength = 2000, dedupe = true, stripMomentBlocks = false } = {}) => {
  const decoded = stripMomentBlocks ? stripMomentBlocksForAutoImagePrompt(text) : htmlDecodeLite(text);
  const source = stripReasoningLikeBlocks(stripMarkdownCodeBlocks(unwrapWholeReplyFence(decoded)));
  const limit = normalizeAutoImagePromptLimit(max, 1);
  const lengthLimit = Math.max(80, Math.trunc(Number(maxLength)) || 2000);
  const prompts = [];
  const seen = new Set();
  replaceClosedImagePromptBlocks(source, (full, body) => {
    const normalized = normalizePromptText(body).slice(0, lengthLimit).trim();
    const key = normalized.toLowerCase();
    if (isEmptyPromptToken(normalized) || (dedupe && seen.has(key)) || prompts.length >= limit) return full;
    if (dedupe) seen.add(key);
    prompts.push(normalized);
    return full;
  });
  return prompts;
};

export const buildAutoImagePromptPendingToken = (index = 0) =>
  `[img-图片生成中${index > 0 ? ` ${index + 1}` : ''}]`;

export const prepareAutoImagePromptPlaceholders = (text = '', {
  max = 10,
  maxLength = 2000,
  overflowTokenBuilder = null,
} = {}) => {
  const source = String(text ?? '');
  const limit = normalizeAutoImagePromptLimit(max, 10);
  const lengthLimit = Math.max(80, Math.trunc(Number(maxLength)) || 2000);
  const prompts = [];
  const ignoredRanges = collectIgnoredAutoImagePromptRanges(source);
  const nextText = replaceClosedImagePromptBlocks(source, (full, body, tagIndex) => {
    const index = tagIndex;
    const prompt = normalizePromptText(body).slice(0, lengthLimit).trim();
    if (isEmptyPromptToken(prompt)) return '';
    if (prompts.length >= limit) {
      if (typeof overflowTokenBuilder === 'function') {
        return String(overflowTokenBuilder({ prompt, index, tag: full, max: limit }) || '');
      }
      return '';
    }
    const pendingToken = buildAutoImagePromptPendingToken(index);
    prompts.push({ prompt, pendingToken, tag: full, index });
    return pendingToken;
  }, {
    ignoredRanges,
  });
  return {
    text: nextText.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n'),
    prompts,
  };
};

export const stripAutoImagePromptTags = (text = '') => {
  const source = String(text ?? '');
  if (!source) return source;
  const stripped = replaceClosedImagePromptBlocks(
    replaceClosedImagePromptBlocks(source, () => '', {
      openRe: ESCAPED_IMAGE_PROMPT_OPEN_RE,
      closeRe: ESCAPED_IMAGE_PROMPT_CLOSE_RE,
    }),
    () => '',
  );
  return stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
};
