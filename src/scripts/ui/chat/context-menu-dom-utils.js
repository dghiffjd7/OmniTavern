import { createReactionEmojiVisual } from './reaction-ui-utils.js';

const ACTION_ICON_MAP = {
  reply: '↩',
  'view-code': '<>',
  download: '↓',
  'cancel-media-generation': '×',
  'generate-image': '图',
  'repeat-image-generation': '⧉',
  'copy-text': '⧉',
  regenerate: '↻',
  'select-voice': '♫',
  'send-to-here': '➤',
  edit: '✎',
  delete: '⌫',
};

const DANGER_ACTIONS = new Set(['delete', 'cancel-media-generation']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CHECK_FORMAT_ICON_PATHS = Object.freeze([
  'M4 6h10',
  'M4 12h7',
  'M4 18h6',
  'm14 17 2 2 4-5',
]);
const SPEAK_ICON_PATHS = Object.freeze([
  'M11 5 6 9H3v6h3l5 4V5Z',
  'M15.5 8.5a5 5 0 0 1 0 7',
  'M18 6a8 8 0 0 1 0 12',
]);

const createStrokeIcon = (documentLike, paths = []) => {
  const createSvgNode = tagName => (
    documentLike.createElementNS?.(SVG_NAMESPACE, tagName) ||
    documentLike.createElement(tagName)
  );
  const svg = createSvgNode('svg');
  Object.entries({
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
    'aria-hidden': 'true',
  }).forEach(([name, value]) => svg.setAttribute?.(name, value));
  paths.forEach((pathData) => {
    const path = createSvgNode('path');
    path.setAttribute?.('d', pathData);
    svg.appendChild(path);
  });
  return svg;
};

export const createContextMenuReactionRow = ({
  documentLike,
  currentReactions = [],
  emojis = [],
  isSelfReaction,
  onToggle,
} = {}) => {
  const row = documentLike.createElement('div');
  row.className = 'chat-context-reaction-row';
  emojis.forEach((emoji) => {
    const btn = documentLike.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-reaction-option';
    if (currentReactions.some(entry => entry.emoji === emoji && isSelfReaction?.(entry))) {
      btn.classList.add?.('is-active');
    }
    if (btn.dataset) btn.dataset.emoji = emoji;
    btn.setAttribute?.('aria-label', `使用${emoji}回应`);
    btn.appendChild?.(createReactionEmojiVisual(emoji, { documentLike }));
    btn.onclick = (ev) => {
      ev.stopPropagation?.();
      onToggle?.(emoji);
    };
    row.appendChild(btn);
  });
  return row;
};

export const createContextMenuSpeakRow = ({
  documentLike,
  quickVoices = [],
  // 气泡操作条已有朗读按钮时不重复放「朗读」，只保留气泡上没有的 chips + 选择声音
  showSpeakButton = true,
  onSpeak = null,
  onMore = null,
} = {}) => {
  const row = documentLike.createElement('div');
  row.className = 'chat-context-speak-row';

  if (showSpeakButton) {
    const mainBtn = documentLike.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'chat-context-speak-main';
    if (mainBtn.dataset) mainBtn.dataset.actionKey = 'speak';
    mainBtn.setAttribute?.('aria-label', '朗读');
    const icon = documentLike.createElement('span');
    icon.className = 'chat-context-menu-action-icon';
    icon.setAttribute?.('aria-hidden', 'true');
    icon.appendChild(createStrokeIcon(documentLike, SPEAK_ICON_PATHS));
    const label = documentLike.createElement('span');
    label.className = 'chat-context-menu-action-label';
    label.textContent = '朗读';
    mainBtn.appendChild(icon);
    mainBtn.appendChild(label);
    mainBtn.onclick = (ev) => {
      ev.stopPropagation?.();
      onSpeak?.(null);
    };
    row.appendChild(mainBtn);
  }

  let chipCount = 0;
  (Array.isArray(quickVoices) ? quickVoices : []).forEach((voice) => {
    const voiceRef = String(voice?.voiceRef || voice?.id || '').trim();
    const voiceLabel = String(voice?.label || '').trim() || voiceRef;
    if (!voiceRef || !voiceLabel) return;
    const chip = documentLike.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-context-speak-chip';
    if (chip.dataset) chip.dataset.voiceRef = voiceRef;
    chip.title = `用「${voiceLabel}」朗读本条（仅本次）`;
    chip.setAttribute?.('aria-label', chip.title);
    chip.textContent = voiceLabel;
    chip.onclick = (ev) => {
      ev.stopPropagation?.();
      onSpeak?.(voiceRef);
    };
    row.appendChild(chip);
    chipCount += 1;
  });

  const moreBtn = documentLike.createElement('button');
  moreBtn.type = 'button';
  if (moreBtn.dataset) moreBtn.dataset.actionKey = 'select-voice';
  moreBtn.setAttribute?.('aria-label', '选择声音…');
  if (!showSpeakButton && !chipCount) {
    // 行内只剩选择入口时用带文字的完整按钮，避免孤零零一个 ⋯
    moreBtn.className = 'chat-context-speak-more is-labeled';
    moreBtn.textContent = '选择声音…';
  } else {
    moreBtn.className = 'chat-context-speak-more';
    moreBtn.title = '选择声音…';
    moreBtn.textContent = '⋯';
  }
  moreBtn.onclick = (ev) => {
    ev.stopPropagation?.();
    onMore?.();
  };
  row.appendChild(moreBtn);
  return row;
};

export const createContextMenuDivider = ({
  documentLike,
} = {}) => {
  const divider = documentLike.createElement('div');
  divider.className = 'chat-context-menu-section-divider';
  return divider;
};

export const createContextMenuActionButton = ({
  documentLike,
  action,
  onClick,
} = {}) => {
  const btn = documentLike.createElement('button');
  const key = String(action?.key || '');
  const isDanger = action?.tone === 'danger' || DANGER_ACTIONS.has(key);
  btn.type = 'button';
  btn.className = `chat-context-menu-action${isDanger ? ' is-danger' : ''}`;
  if (btn.dataset) btn.dataset.actionKey = key;
  btn.setAttribute?.('aria-label', action?.label || key);

  const icon = documentLike.createElement('span');
  icon.className = 'chat-context-menu-action-icon';
  icon.setAttribute?.('aria-hidden', 'true');
  if (action?.icon) {
    icon.textContent = String(action.icon);
  } else if (key === 'check-format') {
    icon.appendChild(createStrokeIcon(documentLike, CHECK_FORMAT_ICON_PATHS));
  } else if (key === 'speak') {
    icon.appendChild(createStrokeIcon(documentLike, SPEAK_ICON_PATHS));
  } else {
    icon.textContent = String(ACTION_ICON_MAP[key] || '');
  }

  const label = documentLike.createElement('span');
  label.className = 'chat-context-menu-action-label';
  label.textContent = action?.label || '';

  btn.appendChild(icon);
  btn.appendChild(label);
  btn.onclick = onClick;
  return btn;
};
