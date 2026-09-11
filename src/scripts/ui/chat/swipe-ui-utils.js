import { splitDanglingBlockTail } from './update-variable-block-utils.js';
import { createRpMessageIconMarkup } from './rp-message-actions-ui-utils.js';

export const SWIPE_REASONING_KEYS = ['reasoning', 'reasoningDisplay', 'reasoningSource', 'reasoningHidden', 'reasoningLabel'];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

export const branchHasReasoningState = (branch = {}) => (
  branch && typeof branch === 'object' && SWIPE_REASONING_KEYS.some(key => hasOwn(branch, key))
);

export const applySwipeReasoningStateToMeta = (meta = {}, branch = {}, activeIndex = 0) => {
  const nextMeta = meta && typeof meta === 'object' ? { ...meta } : {};
  if (branchHasReasoningState(branch)) {
    for (const key of SWIPE_REASONING_KEYS) {
      if (hasOwn(branch, key)) nextMeta[key] = branch[key];
      else delete nextMeta[key];
    }
    return nextMeta;
  }
  if (Number(activeIndex) > 0) {
    for (const key of SWIPE_REASONING_KEYS) delete nextMeta[key];
  }
  return nextMeta;
};

const cloneSwipeSources = sources => (Array.isArray(sources)
  ? sources
      .filter(source => source && typeof source === 'object')
      .map(source => ({ ...source }))
  : []);

export const applySwipeSourcesStateToMeta = (meta = {}, branch = {}, activeIndex = 0) => {
  const nextMeta = meta && typeof meta === 'object' ? { ...meta } : {};
  if (hasOwn(branch, 'sources')) {
    const sources = cloneSwipeSources(branch.sources);
    if (sources.length) nextMeta.sources = sources;
    else delete nextMeta.sources;
    return nextMeta;
  }
  if (Number(activeIndex) > 0) delete nextMeta.sources;
  return nextMeta;
};

const buildSwipeBranchFromMessage = (message = {}) => {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  const branch = { content: message?.content, raw: message?.raw };
  if (message?.rawSource !== undefined) branch.rawSource = message.rawSource;
  if (message?.rawOriginal !== undefined) branch.rawOriginal = message.rawOriginal;
  for (const key of SWIPE_REASONING_KEYS) {
    if (hasOwn(meta, key)) branch[key] = meta[key];
  }
  const sources = cloneSwipeSources(meta.sources);
  if (sources.length) branch.sources = sources;
  return branch;
};

export const ensureSwipeMeta = (message) => {
  if (!message || typeof message !== 'object') return null;
  if (!message.meta || typeof message.meta !== 'object') message.meta = {};
  if (!Array.isArray(message.meta.swipes)) {
    message.meta.swipes = [buildSwipeBranchFromMessage(message)];
    message.meta.activeSwipe = 0;
  } else {
    const rawActive = Math.trunc(Number(message.meta.activeSwipe));
    const active = Number.isFinite(rawActive)
      ? Math.min(Math.max(0, rawActive), Math.max(0, message.meta.swipes.length - 1))
      : 0;
    const activeBranch = message.meta.swipes[active];
    const sources = cloneSwipeSources(message.meta.sources);
    if (activeBranch && typeof activeBranch === 'object' && sources.length && !hasOwn(activeBranch, 'sources')) {
      activeBranch.sources = sources;
    }
  }
  return message.meta;
};

const INLINE_GENERATED_IMAGE_TOKEN_RE = /\[(?:img|img-error)-[^\]\n]+\]/i;

const hasInlineGeneratedImageToken = value => INLINE_GENERATED_IMAGE_TOKEN_RE.test(String(value || ''));

const stripTableEditBlocksLocal = value => {
  let out = String(value ?? '');
  const startRe = /<tableEdit\b[^>]*>/i;
  const endRe = /<\/tableEdit\s*>/i;
  for (let i = 0; i < 20; i += 1) {
    const start = out.match(startRe);
    if (!start) break;
    const startIdx = start.index ?? -1;
    if (startIdx < 0) break;
    const afterStart = out.slice(startIdx + start[0].length);
    const end = afterStart.match(endRe);
    const nextStart = afterStart.match(startRe);
    // 未闭合或闭合属于后面另一个块：只吞块语法前缀，散文归还正文
    if (!end || (nextStart && (nextStart.index ?? 0) < (end.index ?? 0))) {
      const { rest } = splitDanglingBlockTail(afterStart);
      out = out.slice(0, startIdx) + rest;
      continue;
    }
    const endIdx = startIdx + start[0].length + (end.index ?? 0);
    out = out.slice(0, startIdx) + out.slice(endIdx + end[0].length);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
};

const pickInlineGeneratedImageSource = message => [
  message?.content,
  message?.raw,
  message?.rawSource,
  message?.raw_source,
].map(stripTableEditBlocksLocal).find(hasInlineGeneratedImageToken) || '';

export const resolveSwipeIndicatorState = (message) => {
  const swipes = Array.isArray(message?.meta?.swipes) ? message.meta.swipes : null;
  const total = swipes?.length ? swipes.length : 1;
  const rawActive = Math.trunc(Number(message?.meta?.activeSwipe));
  const active = swipes
    ? (Number.isFinite(rawActive) ? Math.min(Math.max(0, rawActive), total - 1) : 0)
    : 0;
  const generating = Boolean(message?.meta?.swipeRegenerating) || Boolean(message?.meta?.activeSwipeDraft?.active);
  const nextLabel = generating ? '生成中' : (active >= total - 1 ? '生成新回复' : '下一条回复');
  return {
    swipes,
    total,
    active,
    generating,
    nextLabel,
  };
};

export const createSwipeIndicatorElement = (documentLike, message) => {
  const { total, active, generating, nextLabel } = resolveSwipeIndicatorState(message);
  const swipeWrap = documentLike.createElement('div');
  swipeWrap.className = 'rp-swipe-indicator';
  swipeWrap.dataset.msgId = message?.id || '';

  const prevBtn = documentLike.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'rp-swipe-prev';
  prevBtn.innerHTML = createRpMessageIconMarkup('chevron-left', { size: 14 });
  prevBtn.disabled = generating || active <= 0;
  prevBtn.setAttribute('aria-label', '上一条回复');
  prevBtn.title = '上一条回复';

  const counter = documentLike.createElement('span');
  counter.className = 'rp-swipe-counter';
  counter.textContent = `${active + 1}/${total}`;

  const nextBtn = documentLike.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'rp-swipe-next';
  nextBtn.innerHTML = createRpMessageIconMarkup('chevron-right', { size: 14 });
  nextBtn.disabled = generating;
  nextBtn.setAttribute('aria-label', nextLabel);
  nextBtn.title = nextLabel;

  swipeWrap.appendChild(prevBtn);
  swipeWrap.appendChild(counter);
  swipeWrap.appendChild(nextBtn);
  return swipeWrap;
};

export const syncSwipeIndicatorElement = (indicator, index, total, { generating = false } = {}) => {
  if (!indicator) return;
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeIndex = Math.min(Math.max(0, Number(index) || 0), safeTotal - 1);
  const counter = indicator.querySelector?.('.rp-swipe-counter');
  if (counter) counter.textContent = `${safeIndex + 1}/${safeTotal}`;
  const prevBtn = indicator.querySelector?.('.rp-swipe-prev');
  if (prevBtn) {
    prevBtn.disabled = generating || safeIndex <= 0;
    prevBtn.setAttribute('aria-label', '上一条回复');
    prevBtn.title = '上一条回复';
  }
  const nextBtn = indicator.querySelector?.('.rp-swipe-next');
  if (nextBtn) {
    nextBtn.disabled = generating;
    const label = generating ? '生成中' : (safeIndex >= safeTotal - 1 ? '生成新回复' : '下一条回复');
    nextBtn.setAttribute('aria-label', label);
    nextBtn.title = label;
  }
};

export const resolveActiveSwipeMessageCore = (message, {
  activeSwipeGenerationMsgId = '',
} = {}) => {
  if (!message || typeof message !== 'object') return message;
  // 独立图片任务在同条消息上更新状态和地址。记忆检查点可能补入旧文本 swipes，
  // 这些快照不代表图片版本；读取它们会把失败提示覆盖回重试状态，甚至当成 img src。
  if (message.meta?.generatedMedia?.kind === 'image') return message;
  let meta = message.meta && typeof message.meta === 'object' ? message.meta : null;
  let swipes = Array.isArray(meta?.swipes) && meta.swipes.length ? meta.swipes : null;
  if (!swipes) return message;
  if (swipes.some(branch => branch?.draft)) {
    const keepDraft =
      meta?.swipeRegenerating === true &&
      activeSwipeGenerationMsgId &&
      activeSwipeGenerationMsgId === String(message?.id || '');
    if (!keepDraft) {
      const cleanedSwipes = swipes.filter(branch => !branch?.draft);
      swipes = cleanedSwipes.length
        ? cleanedSwipes
        : [{ content: message.content ?? '', raw: message.raw }];
      const rawIndex = Math.trunc(Number(meta.activeSwipe));
      const activeIndex = Number.isFinite(rawIndex)
        ? Math.min(Math.max(0, rawIndex), swipes.length - 1)
        : Math.max(0, swipes.length - 1);
      meta = {
        ...meta,
        swipes,
        activeSwipe: activeIndex,
      };
      delete meta.swipeRegenerating;
      delete meta.activeSwipeDraft;
    }
  }
  const rawIndex = Math.trunc(Number(meta.activeSwipe));
  const active = Number.isFinite(rawIndex)
    ? Math.min(Math.max(0, rawIndex), swipes.length - 1)
    : 0;
  const branch = swipes[active] || {};
  const activeSwipeDraft = branch?.draft
    ? { active: true, label: String(branch?.label || '生成新回复中...') }
    : null;
  let nextMeta = { ...(meta || {}) };
  if (meta.activeSwipe !== active) nextMeta.activeSwipe = active;
  if (activeSwipeDraft) nextMeta.activeSwipeDraft = activeSwipeDraft;
  else delete nextMeta.activeSwipeDraft;
  nextMeta = applySwipeReasoningStateToMeta(nextMeta, branch, active);
  nextMeta = applySwipeSourcesStateToMeta(nextMeta, branch, active);
  let content = branch.content ?? message.content ?? '';
  let raw = branch.raw !== undefined
    ? branch.raw
    : (branch.content !== undefined ? branch.content : message.raw);
  let rawSource = branch.rawSource !== undefined ? branch.rawSource : message.rawSource;
  const generatedImages = Array.isArray(nextMeta.generatedInlineImages) ? nextMeta.generatedInlineImages : [];
  const branchHasGeneratedImage =
    hasInlineGeneratedImageToken(branch.content) ||
    hasInlineGeneratedImageToken(branch.raw) ||
    hasInlineGeneratedImageToken(branch.rawSource);
  const generatedSource = generatedImages.length && swipes.length === 1 && !branchHasGeneratedImage
    ? pickInlineGeneratedImageSource(message)
    : '';
  if (generatedSource) {
    const messageContent = stripTableEditBlocksLocal(message.content);
    const messageRaw = stripTableEditBlocksLocal(message.raw);
    const messageRawSource = stripTableEditBlocksLocal(message.rawSource);
    content = hasInlineGeneratedImageToken(messageContent) ? messageContent : generatedSource;
    raw = hasInlineGeneratedImageToken(messageRaw) ? messageRaw : content;
    rawSource = hasInlineGeneratedImageToken(messageRawSource) ? messageRawSource : content;
    nextMeta.swipes = [{ ...branch, content, raw, rawSource }];
    nextMeta.activeSwipe = 0;
  }
  const next = {
    ...message,
    content,
    meta: nextMeta,
  };
  if (raw !== undefined) next.raw = raw;
  if (rawSource !== undefined) next.rawSource = rawSource;
  if (branch.rawOriginal !== undefined) next.rawOriginal = branch.rawOriginal;
  else if (active > 0) delete next.rawOriginal;
  return next;
};

export const renderSwipeDraftPlaceholderCore = (target, {
  documentLike,
  label = '生成新回复中...',
} = {}) => {
  if (!target) return false;
  target.classList.add('rp-swipe-draft-placeholder');
  const dots = documentLike.createElement('span');
  dots.className = 'rp-static-dots';
  dots.setAttribute?.('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) {
    const dot = documentLike.createElement('span');
    dot.className = 'rp-static-dot';
    dots.appendChild(dot);
  }
  const text = documentLike.createElement('span');
  text.textContent = String(label || '生成新回复中...');
  target.appendChild(dots);
  target.appendChild(text);
  return true;
};
