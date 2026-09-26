import {
  DEFAULT_REACTION_EMOJIS,
  SELF_REACTION_ACTOR,
  countReactionActors,
  hasReactionActor,
  normalizeReactionEntries,
} from './message-interaction-utils.js';
import {
  REACTION_EMOJI_CATEGORIES,
  filterReactionEmojiCatalog,
  findReactionEmoji,
  getTwemojiAssetPath,
} from './reaction-emoji-catalog.js';
import { resolveFrequentReactionEmojis } from './reaction-preference-utils.js';
import { CUSTOM_REACTION_LIMIT, customReactionAssets, customReactionImageSource, isCustomReaction } from './custom-reaction-assets.js';
import { appConfirm } from '../app-confirm.js';
import { t } from '../../i18n/index.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const createSvgNode = (documentLike, tagName) => (
  documentLike.createElementNS?.(SVG_NAMESPACE, tagName) || documentLike.createElement(tagName)
);

const createReactionMoreIcon = (documentLike) => {
  const svg = createSvgNode(documentLike, 'svg');
  Object.entries({
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
    'aria-hidden': 'true',
  }).forEach(([name, value]) => svg.setAttribute?.(name, value));
  ['M14.4 5.2A7.5 7.5 0 1 0 18.8 9.6', 'M8.4 10h.01', 'M12.6 10h.01', 'M8.5 14c1.5 1.4 3.5 1.4 5 0', 'M18 3v6', 'M15 6h6']
    .forEach((pathData) => {
      const path = createSvgNode(documentLike, 'path');
      path.setAttribute?.('d', pathData);
      svg.appendChild?.(path);
    });
  return svg;
};

export const createReactionEmojiVisual = (emojiValue, {
  documentLike = document,
  className = '',
  fallbackName = '',
} = {}) => {
  const emoji = String(emojiValue || '').trim();
  const custom = isCustomReaction(emoji);
  const asset = custom ? customReactionAssets.find(emoji) : null;
  const wrap = documentLike.createElement('span');
  wrap.className = `chat-reaction-emoji-visual${className ? ` ${className}` : ''}`;
  wrap.setAttribute?.('aria-hidden', 'true');

  const image = documentLike.createElement('img');
  image.className = 'chat-reaction-emoji-image';
  const source = custom ? customReactionImageSource(asset) : getTwemojiAssetPath(emoji);
  if (source) image.src = source;
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';

  const fallback = documentLike.createElement('span');
  fallback.className = 'chat-reaction-emoji-fallback';
  fallback.textContent = custom ? asset?.name || fallbackName || t('自定义反应') : emoji;
  if (custom) wrap.classList?.add?.('is-custom');
  if (!source) wrap.classList?.add?.('is-fallback');
  image.addEventListener?.('error', () => wrap.classList?.add?.('is-fallback'));

  wrap.appendChild?.(image);
  wrap.appendChild?.(fallback);
  return wrap;
};

export const buildReactionSummaryElement = (
  message,
  {
    documentLike = document,
    isThreadingEnabled = false,
    onToggleReaction = null,
    translateText = value => String(value ?? ''),
  } = {},
) => {
  if (!isThreadingEnabled) return null;
  const reactions = normalizeReactionEntries(message?.meta?.reactions);
  if (!reactions.length) return null;
  const wrap = documentLike.createElement('div');
  wrap.className = 'chat-reaction-summary';
  reactions.forEach((entry) => {
    const chip = documentLike.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-reaction-chip';
    if (hasReactionActor(entry, SELF_REACTION_ACTOR)) chip.classList?.add?.('is-self');
    const emoji = createReactionEmojiVisual(entry.emoji, {
      documentLike,
      className: 'chat-reaction-chip-emoji',
      fallbackName: entry.name,
    });
    const count = documentLike.createElement('span');
    count.className = 'chat-reaction-chip-count';
    count.textContent = String(countReactionActors(entry));
    chip.appendChild?.(emoji);
    chip.appendChild?.(count);
    chip.setAttribute?.('aria-label', translateText(`${entry.name || entry.emoji} ${countReactionActors(entry)}个反应`));
    chip.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      onToggleReaction?.(entry.emoji);
    });
    wrap.appendChild?.(chip);
  });
  return wrap;
};

export const createReactionTriggerButton = (
  message,
  {
    documentLike = document,
    isThreadingEnabled = false,
    onShowPicker = null,
    translateText = value => String(value ?? ''),
  } = {},
) => {
  if (!isThreadingEnabled) return null;
  const reactionBtn = documentLike.createElement('button');
  reactionBtn.type = 'button';
  reactionBtn.className = 'chat-reaction-trigger';
  reactionBtn.setAttribute?.('aria-label', translateText('添加反应'));
  reactionBtn.appendChild?.(createReactionMoreIcon(documentLike));
  reactionBtn.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    onShowPicker?.(reactionBtn, message);
  });
  return reactionBtn;
};

export const createReactionQuickBar = (
  message,
  {
    documentLike = document,
    isThreadingEnabled = false,
    emojis = [],
    onToggleReaction = null,
    onShowPicker = null,
    translateText = value => String(value ?? ''),
  } = {},
) => {
  if (!isThreadingEnabled) return null;
  const values = Array.from(new Set((Array.isArray(emojis) ? emojis : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)))
    .slice(0, 3);
  if (!values.length) return null;
  const currentReactions = normalizeReactionEntries(message?.meta?.reactions);
  const bar = documentLike.createElement('div');
  bar.className = 'chat-reaction-quick-bar';
  bar.setAttribute?.('role', 'toolbar');
  bar.setAttribute?.('aria-label', translateText('快捷表情反应'));

  values.forEach((emojiValue) => {
    const button = documentLike.createElement('button');
    button.type = 'button';
    button.className = 'chat-reaction-quick-button';
    button.dataset.emoji = emojiValue;
    if (currentReactions.some(entry => (
      entry.emoji === emojiValue && hasReactionActor(entry, SELF_REACTION_ACTOR)
    ))) {
      button.classList?.add?.('is-active');
    }
    button.setAttribute?.('aria-label', translateText(`使用${customReactionAssets.find(emojiValue)?.name || emojiValue}回应`));
    button.appendChild?.(createReactionEmojiVisual(emojiValue, { documentLike }));
    button.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      onToggleReaction?.(emojiValue);
    });
    bar.appendChild?.(button);
  });

  const moreButton = documentLike.createElement('button');
  moreButton.type = 'button';
  moreButton.className = 'chat-reaction-quick-button chat-reaction-more';
  moreButton.setAttribute?.('aria-label', translateText('选择更多表情反应'));
  moreButton.appendChild?.(createReactionMoreIcon(documentLike));
  moreButton.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    onShowPicker?.(moreButton, message);
  });
  bar.appendChild?.(moreButton);
  return bar;
};

const isReactionTouchTargetInteractive = (target) => Boolean(target?.closest?.(
  'a, button, input, textarea, select, summary, audio, video, canvas, iframe, [contenteditable="true"]',
));

export const syncReactionQuickBarPlacement = ({
  bubbleStack = null,
  scrollBoundary = null,
  barHeight = 30,
  bridgeGap = 8,
} = {}) => {
  if (!bubbleStack?.getBoundingClientRect || !scrollBoundary?.getBoundingClientRect) return 'above';
  let stackRect;
  let boundaryRect;
  try {
    stackRect = bubbleStack.getBoundingClientRect();
    boundaryRect = scrollBoundary.getBoundingClientRect();
  } catch {
    return 'above';
  }
  const stackTop = Number(stackRect?.top);
  const boundaryTop = Math.max(0, Number(boundaryRect?.top) || 0);
  const requiredHeadroom = Math.max(0, Number(barHeight) || 0) + Math.max(0, Number(bridgeGap) || 0);
  const placeBelow = Number.isFinite(stackTop) && stackTop - boundaryTop < requiredHeadroom;
  bubbleStack.classList?.toggle?.('is-reaction-bar-below', placeBelow);
  return placeBelow ? 'below' : 'above';
};

export const createReactionQuickBarTouchRuntime = ({
  documentLike = document,
} = {}) => {
  let activeStack = null;
  const boundBubbles = new WeakSet();
  const close = () => {
    activeStack?.classList?.remove?.('is-reaction-bar-open');
    activeStack = null;
  };
  const onOutsidePointerDown = (event) => {
    if (!activeStack || activeStack.contains?.(event?.target)) return;
    close();
  };
  documentLike.addEventListener?.('pointerdown', onOutsidePointerDown, { passive: true });
  return {
    bind({ bubbleStack = null, bubble = null, quickBar = null, scrollBoundary = null } = {}) {
      if (!bubbleStack || !bubble || !quickBar) return false;
      if (boundBubbles.has(bubble)) return true;
      boundBubbles.add(bubble);
      const syncPlacement = () => syncReactionQuickBarPlacement({ bubbleStack, scrollBoundary });
      let touchStart = null;
      bubbleStack.addEventListener?.('pointerenter', syncPlacement, { passive: true });
      bubble.addEventListener?.('pointerdown', (event) => {
        syncPlacement();
        if (event?.pointerType === 'mouse' || isReactionTouchTargetInteractive(event?.target)) {
          touchStart = null;
          return;
        }
        touchStart = {
          pointerId: event?.pointerId,
          x: Number(event?.clientX) || 0,
          y: Number(event?.clientY) || 0,
          moved: false,
          startedAt: Number.isFinite(Number(event?.timeStamp))
            ? Number(event.timeStamp)
            : Date.now(),
        };
      }, { passive: true });
      bubble.addEventListener?.('pointermove', (event) => {
        if (!touchStart || (touchStart.pointerId != null && event?.pointerId !== touchStart.pointerId)) return;
        const dx = (Number(event?.clientX) || 0) - touchStart.x;
        const dy = (Number(event?.clientY) || 0) - touchStart.y;
        if (dx * dx + dy * dy > 10 * 10) touchStart.moved = true;
      }, { passive: true });
      bubble.addEventListener?.('pointerup', (event) => {
        const tap = touchStart;
        touchStart = null;
        if (!tap || tap.moved || event?.pointerType === 'mouse' || event?.defaultPrevented) return;
        if (tap.pointerId != null && event?.pointerId !== tap.pointerId) return;
        const endedAt = Number.isFinite(Number(event?.timeStamp))
          ? Number(event.timeStamp)
          : Date.now();
        if (endedAt - tap.startedAt > 450) return;
        if (isReactionTouchTargetInteractive(event?.target)) return;
        try {
          if (String(documentLike.getSelection?.()?.toString?.() || '').trim()) return;
        } catch {}
        if (activeStack === bubbleStack) {
          close();
          return;
        }
        close();
        activeStack = bubbleStack;
        activeStack.classList?.add?.('is-reaction-bar-open');
      }, { passive: true });
      bubble.addEventListener?.('pointercancel', () => {
        touchStart = null;
      }, { passive: true });
      return true;
    },
    close,
    destroy() {
      close();
      documentLike.removeEventListener?.('pointerdown', onOutsidePointerDown);
    },
  };
};

export const createReactionPicker = ({
  documentLike = document,
  onOutsidePress = null,
} = {}) => {
  const picker = documentLike.createElement('div');
  picker.id = 'msg-reaction-picker';
  picker.className = 'chat-reaction-picker';
  picker.setAttribute?.('role', 'dialog');
  picker.setAttribute?.('aria-label', '选择表情反应');
  picker.style.cssText = 'position:fixed;display:none;z-index:20010;';
  documentLike.body?.appendChild?.(picker);
  documentLike.addEventListener?.(
    'pointerdown',
    (event) => {
      if (picker.style.display === 'none') return;
      if (picker.contains?.(event.target)) return;
      onOutsidePress?.();
    },
    { passive: true },
  );
  picker.addEventListener?.('keydown', (event) => {
    if (event?.key !== 'Escape') return;
    event.preventDefault?.();
    onOutsidePress?.();
  });
  return picker;
};

export const hideReactionPicker = (picker) => {
  if (!picker) return;
  picker.style.display = 'none';
  picker.style.visibility = '';
  picker.innerHTML = '';
  if (picker.dataset) {
    delete picker.dataset.activeCategory;
    delete picker.dataset.mobile;
  }
};

const resolvePickerCategories = (usage = {}) => {
  const customItems = customReactionAssets.list().map(asset => ({ emoji: asset.emoji, label: asset.name, keywords: asset.name, categoryId: 'custom', categoryLabel: t('自定义') }));
  const frequentEmojis = resolveFrequentReactionEmojis({
    usage,
    defaults: DEFAULT_REACTION_EMOJIS,
    limit: 18,
  });
  const frequentItems = frequentEmojis.filter(emoji => !isCustomReaction(emoji) || customReactionAssets.find(emoji)).map(emoji => findReactionEmoji(emoji) || customItems.find(item => item.emoji === emoji) || {
    emoji,
    label: emoji,
    keywords: emoji,
    categoryId: 'frequent',
    categoryLabel: '常用',
  });
  return [
    { id: 'frequent', label: '常用', icon: '🕘', emojis: frequentItems },
    { id: 'custom', label: t('自定义'), icon: '🖼️', emojis: customItems },
    ...REACTION_EMOJI_CATEGORIES,
  ];
};

const buildPickerOption = ({
  item,
  currentReactions,
  documentLike,
  hidePicker,
  onToggleReaction,
  onRemove = null,
}) => {
  const emojiValue = String(item?.emoji || '').trim();
  const button = documentLike.createElement('button');
  button.type = 'button';
  button.className = 'chat-reaction-option chat-reaction-picker-option';
  button.dataset.emoji = emojiValue;
  if (currentReactions.some(entry => (
    entry.emoji === emojiValue && hasReactionActor(entry, SELF_REACTION_ACTOR)
  ))) {
    button.classList?.add?.('is-active');
  }
  button.setAttribute?.('aria-label', onRemove ? t('移除反应：{name}', { name: item?.label }) : `使用${item?.label || emojiValue}回应`);
  button.setAttribute?.('title', item?.label || emojiValue);
  button.appendChild?.(createReactionEmojiVisual(emojiValue, { documentLike }));
  button.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    if (onRemove) { void onRemove(emojiValue); return; }
    hidePicker?.();
    onToggleReaction?.(emojiValue);
  });
  return button;
};

export const showReactionPicker = ({
  picker = null,
  contextMenuEl = null,
  anchor = null,
  message = null,
  isThreadingEnabled = false,
  usage = {},
  onToggleReaction = null,
  hidePicker = null,
  windowLike = window,
  documentLike = document,
} = {}) => {
  if (!picker || !anchor || !isThreadingEnabled) return false;
  if (contextMenuEl) contextMenuEl.style.display = 'none';
  picker.innerHTML = '';
  const currentReactions = normalizeReactionEntries(message?.meta?.reactions);
  let categories = resolvePickerCategories(usage);
  const state = { activeCategory: 'frequent', query: '', managing: false };

  const header = documentLike.createElement('div');
  header.className = 'chat-reaction-picker-header';
  const title = documentLike.createElement('strong');
  title.textContent = '添加表情反应';
  const closeButton = documentLike.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'chat-reaction-picker-close';
  closeButton.textContent = '×';
  closeButton.setAttribute?.('aria-label', '关闭表情选择器');
  closeButton.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    hidePicker?.();
  });
  header.appendChild?.(title);
  header.appendChild?.(closeButton);

  const search = documentLike.createElement('input');
  search.type = 'search';
  search.className = 'chat-reaction-picker-search';
  search.placeholder = '搜索表情';
  search.setAttribute?.('aria-label', '搜索表情');

  const tabs = documentLike.createElement('div');
  tabs.className = 'chat-reaction-picker-tabs';
  tabs.setAttribute?.('role', 'tablist');
  tabs.setAttribute?.('aria-label', '表情分类');

  const content = documentLike.createElement('div');
  content.className = 'chat-reaction-picker-content';
  content.setAttribute?.('role', 'tabpanel');

  const tabButtons = new Map();
  const tools = documentLike.createElement('div');
  tools.className = 'chat-reaction-custom-tools';
  const upload = documentLike.createElement('button');
  upload.type = 'button'; upload.className = 'chat-reaction-custom-add'; upload.textContent = t('添加图片');
  const manage = documentLike.createElement('button');
  manage.type = 'button'; manage.className = 'chat-reaction-custom-manage'; manage.textContent = t('管理');
  const fileInput = documentLike.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/png,image/webp,image/jpeg'; fileInput.multiple = true; fileInput.hidden = true;
  const status = documentLike.createElement('small');
  status.setAttribute?.('role', 'status'); status.setAttribute?.('aria-live', 'polite');
  const remove = async emoji => {
    if (!await appConfirm({ title: t('移除自定义反应'), message: t('已有消息会保留反应名称。'), confirmText: t('移除'), cancelText: t('取消') })) return;
    let errorMessage = '';
    try { await customReactionAssets.remove(emoji); } catch (error) { errorMessage = error.message; }
    categories = resolvePickerCategories(usage); render();
    if (errorMessage) status.textContent = t(errorMessage);
  };
  const render = () => {
    manage.textContent = state.managing ? t('完成') : t('管理');
    manage.setAttribute?.('aria-pressed', state.managing ? 'true' : 'false');
    status.textContent = state.managing ? t('点击图片可移除反应') : t('静态图片 · 最多 60 个');
    picker.dataset.activeCategory = state.activeCategory;
    if (state.managing) picker.dataset.managing = '1'; else delete picker.dataset.managing;
    tabButtons.forEach((button, categoryId) => {
      const active = !state.query && categoryId === state.activeCategory;
      button.classList?.toggle?.('is-active', active);
      button.setAttribute?.('aria-selected', active ? 'true' : 'false');
    });
    content.innerHTML = '';
    const items = state.query
      ? [...filterReactionEmojiCatalog(state.query), ...categories.find(category => category.id === 'custom').emojis.filter(item => item.label.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()))]
      : (categories.find(category => category.id === state.activeCategory)?.emojis || []);
    if (!items.length) {
      const empty = documentLike.createElement('div');
      empty.className = 'chat-reaction-picker-empty';
      empty.textContent = !state.query && state.activeCategory === 'custom' ? t('还没有自定义反应，可点“添加图片”上传 PNG、WebP 或 JPEG') : t('没有找到表情');
      content.appendChild?.(empty);
      return;
    }
    items.forEach(item => content.appendChild?.(buildPickerOption({
      item,
      currentReactions,
      documentLike,
      hidePicker,
      onToggleReaction,
      onRemove: state.managing && isCustomReaction(item.emoji) ? remove : null,
    })));
  };

  categories.forEach((category) => {
    const tab = documentLike.createElement('button');
    tab.type = 'button';
    tab.className = 'chat-reaction-picker-tab';
    tab.dataset.category = category.id;
    tab.setAttribute?.('role', 'tab');
    tab.setAttribute?.('aria-label', category.label);
    tab.setAttribute?.('title', category.label);
    tab.appendChild?.(createReactionEmojiVisual(category.icon, { documentLike }));
    tab.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      state.activeCategory = category.id;
      state.query = '';
      search.value = '';
      render();
    });
    tabButtons.set(category.id, tab);
    tabs.appendChild?.(tab);
  });
  search.addEventListener?.('input', () => {
    state.query = String(search.value || '').trim();
    render();
  });

  upload.addEventListener?.('click', () => fileInput.click?.());
  manage.addEventListener?.('click', () => { state.managing = !state.managing; state.activeCategory = 'custom'; state.query = ''; search.value = ''; render(); });
  fileInput.addEventListener?.('change', async () => {
    upload.disabled = manage.disabled = true;
    const files = Array.from(fileInput.files || []);
    // One bad file does not stop the rest; only a full library ends the batch early.
    let added = 0, failed = 0, errorMessage = '';
    for (const file of files) {
      try { await customReactionAssets.addFile(file); added++; }
      catch (error) {
        failed++; errorMessage ||= error.message;
        if (customReactionAssets.list().length >= CUSTOM_REACTION_LIMIT) { failed += files.length - added - failed; errorMessage = error.message; break; }
      }
    }
    fileInput.value = ''; upload.disabled = manage.disabled = false;
    categories = resolvePickerCategories(usage); state.activeCategory = 'custom'; state.managing = false; state.query = ''; search.value = ''; render();
    status.textContent = !failed ? t('已添加 {count} 个反应', { count: added })
      : files.length === 1 ? t(errorMessage) : t('已添加 {count} 个反应；{failed} 个未添加：{reason}', { count: added, failed, reason: t(errorMessage) });
  });
  tools.appendChild?.(upload); tools.appendChild?.(manage); tools.appendChild?.(fileInput); tools.appendChild?.(status);

  picker.appendChild?.(header);
  picker.appendChild?.(search);
  picker.appendChild?.(tabs);
  picker.appendChild?.(content);
  picker.appendChild?.(tools);
  render();

  picker.style.display = 'block';
  picker.style.visibility = 'hidden';
  const rect = anchor.getBoundingClientRect();
  const pickerW = picker.offsetWidth || 356;
  const pickerH = picker.offsetHeight || 390;
  const padding = 8;
  const isMobile = Number(windowLike.innerWidth || 0) <= 600;
  if (isMobile) {
    picker.dataset.mobile = '1';
    picker.style.left = `${padding}px`;
    picker.style.right = `${padding}px`;
    picker.style.top = 'auto';
    picker.style.bottom = 'calc(8px + env(safe-area-inset-bottom, 0px))';
  } else {
    delete picker.dataset.mobile;
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';
    let left = rect.left + rect.width / 2 - pickerW / 2;
    let top = rect.top - pickerH - 10;
    left = Math.max(padding, Math.min(left, windowLike.innerWidth - pickerW - padding));
    if (top < padding) top = Math.min(windowLike.innerHeight - pickerH - padding, rect.bottom + 10);
    picker.style.left = `${left}px`;
    picker.style.top = `${Math.max(padding, top)}px`;
  }
  picker.style.visibility = 'visible';
  return true;
};
