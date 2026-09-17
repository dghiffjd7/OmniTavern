const INLINE_GENERATED_IMAGE_TOKEN_RE = /\[(?:img|img-error)-[^\]\n]+\]/i;

const hasInlineGeneratedImageToken = value => INLINE_GENERATED_IMAGE_TOKEN_RE.test(String(value || ''));

const buildGeneratedImageToken = (asset = {}) => {
  const output = asset?.output && typeof asset.output === 'object' ? asset.output : {};
  const ref = String(output.path || output.url || output.dataUrl || '').trim();
  return ref ? `[img-${ref}]` : '';
};

const compactMatchKeys = values => values
  .map(value => String(value ?? '').trim())
  .filter(Boolean);

const buildInlineGeneratedImageMatchKeys = (value = {}) => {
  const output = value?.output && typeof value.output === 'object' ? value.output : {};
  return compactMatchKeys([
    value?.token,
    value?.generatedImageToken,
    value?.inlineImageRef,
    value?.ref,
    value?.src,
    value?.currentSrc,
    value?.id,
    output.path,
    output.url,
    output.dataUrl,
    buildGeneratedImageToken(value),
    value?.ref ? `[img-${value.ref}]` : '',
    value?.inlineImageRef ? `[img-${value.inlineImageRef}]` : '',
  ]);
};

export const resolveInlineGeneratedImageAsset = (message, inlineGeneratedImage = null) => {
  if (!inlineGeneratedImage) return null;
  const assets = Array.isArray(message?.meta?.generatedInlineImages)
    ? message.meta.generatedInlineImages
    : [];
  if (!assets.length) return null;
  const targetKeys = new Set(buildInlineGeneratedImageMatchKeys(inlineGeneratedImage));
  if (!targetKeys.size) return null;
  return assets.find((asset) => {
    const assetKeys = buildInlineGeneratedImageMatchKeys(asset);
    return assetKeys.some(key => targetKeys.has(key));
  }) || null;
};

const compactStringValues = values => values
  .map(value => (typeof value === 'string' ? value : ''))
  .filter(value => value.trim());

export const buildContextMenuActions = (message, {
  hasCode = false,
  hasRpMessageActions = false,
  isThreadingEnabled = false,
  inlineGeneratedImage = null,
  canCheckFormat = false,
} = {}) => {
  const actions = [];
  const inlineGeneratedAsset = resolveInlineGeneratedImageAsset(message, inlineGeneratedImage);
  if (isThreadingEnabled) {
    actions.push({ key: 'reply', label: '回复', group: 'main' });
  }
  const canViewSource = hasCode || (
    hasRpMessageActions !== true &&
    message?.role === 'assistant' &&
    message?.meta?.renderRich === true
  );
  if (canViewSource) {
    actions.push({ key: 'view-code', label: hasCode ? '查看代码' : '查看源码', group: 'main' });
  }
  const canDownload = ['image', 'document', 'sticker'].includes(String(message?.type || ''));
  if (canDownload) {
    actions.push({ key: 'download', label: '下载', group: 'main' });
  }
  if (message?.meta?.generatedMedia?.status === 'running') {
    actions.push({ key: 'cancel-media-generation', label: '取消生成', group: 'danger', tone: 'danger' });
    return actions;
  }
  if (
    message?.status !== 'pending' &&
    message?.status !== 'sending' &&
    ['text', 'image', 'sticker'].includes(String(message?.type || 'text'))
  ) {
    const hasGeneratedImagePrompt = Boolean(String(message?.meta?.generatedMedia?.prompt || '').trim());
    const hasInlineGeneratedImagePrompt = Boolean(String(inlineGeneratedAsset?.prompt || '').trim());
    actions.push({
      key: 'generate-image',
      label: hasGeneratedImagePrompt || hasInlineGeneratedImagePrompt
        ? '重新生成图片'
        : '以此生成图片',
      group: 'main',
    });
  }
  if (message?.role === 'assistant') {
    // 朗读入口改为菜单顶部的复合行（朗读 + 最近声音 chips + ⋯），不再占动作清单
    if (canCheckFormat === true) {
      actions.push({ key: 'check-format', label: '检查格式', group: 'main' });
    }
    if (hasRpMessageActions !== true) {
      actions.push({ key: 'copy-text', label: '复制', group: 'main' });
      actions.push({ key: 'regenerate', label: '重新生成', group: 'main' });
    }
    actions.push({ key: 'delete', label: '删除', group: 'danger', tone: 'danger' });
  } else if (message?.role === 'user') {
    if (message?.status === 'pending') {
      actions.push({ key: 'send-to-here', label: '发送到这里', group: 'main' });
    }
    if (hasRpMessageActions !== true) {
      actions.push({ key: 'copy-text', label: '复制', group: 'main' });
    }
    if (message?.status !== 'pending' && message?.status !== 'sending' && !message?.meta?.generatedByAssistant) {
      actions.push({ key: 'regenerate', label: '重新生成', group: 'main' });
    }
    if (
      hasRpMessageActions !== true &&
      message?.status !== 'pending' &&
      message?.status !== 'sending'
    ) {
      actions.push({ key: 'edit', label: '编辑', group: 'main' });
    }
    actions.push({ key: 'delete', label: '删除', group: 'danger', tone: 'danger' });
  }
  return actions;
};

export const resolveActiveSwipeIndex = (message) => {
  const swipes = Array.isArray(message?.meta?.swipes) ? message.meta.swipes : [];
  const raw = Math.trunc(Number(message?.meta?.activeSwipe));
  if (!swipes.length) return 0;
  return Number.isFinite(raw)
    ? Math.min(Math.max(0, raw), swipes.length - 1)
    : Math.max(0, swipes.length - 1);
};

export const canDeleteCurrentSwipe = (message) => {
  if (message?.role !== 'assistant') return false;
  const swipes = Array.isArray(message?.meta?.swipes) ? message.meta.swipes : [];
  if (swipes.length <= 1) return false;
  if (message?.meta?.swipeRegenerating === true || message?.meta?.activeSwipeDraft?.active === true) return false;
  const active = resolveActiveSwipeIndex(message);
  return swipes[active]?.draft !== true;
};

export const resolveViewCodeText = (message) => {
  const swipes = Array.isArray(message?.meta?.swipes) ? message.meta.swipes : [];
  const branch = swipes.length
    ? swipes[resolveActiveSwipeIndex(message)]
    : null;
  const branchRawSource = typeof branch?.rawSource === 'string' ? branch.rawSource : '';
  const messageRawSource = typeof message?.rawSource === 'string' ? message.rawSource : '';
  const branchHasInlineImage = hasInlineGeneratedImageToken(branchRawSource);
  const messageHasInlineImage = hasInlineGeneratedImageToken(messageRawSource);
  const shouldPreferCurrentSource =
    message?.meta?.renderRich === true ||
    branchHasInlineImage ||
    messageHasInlineImage;
  const richCurrentSources = messageHasInlineImage && !branchHasInlineImage
    ? [messageRawSource, branchRawSource]
    : [branchRawSource, messageRawSource];
  const ordered = shouldPreferCurrentSource
    ? compactStringValues([
      ...richCurrentSources,
      branch?.rawOriginal,
      branch?.raw,
      message?.raw_source,
      message?.source,
      message?.rawOriginal,
      message?.raw,
      message?.content,
    ])
    : compactStringValues([
      branch?.rawOriginal,
      branchRawSource,
      branch?.raw,
      message?.rawOriginal,
      messageRawSource,
      message?.raw_source,
      message?.source,
      message?.raw,
      message?.content,
    ]);
  return String(ordered[0] || '');
};

export const positionContextMenu = (menu, { x = 0, y = 0, windowLike, padding = 8, offsetY = 6 } = {}) => {
  if (!menu || !windowLike) return;
  menu.style.visibility = 'hidden';
  menu.style.display = 'block';
  const menuW = menu.offsetWidth || 160;
  const menuH = menu.offsetHeight || 120;
  let left = x;
  let top = y + offsetY;
  left = Math.max(padding, Math.min(left, windowLike.innerWidth - menuW - padding));
  top = Math.max(padding, Math.min(top, windowLike.innerHeight - menuH - padding));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = 'visible';
};
