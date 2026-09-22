import {
  collectImageFilesFromDropEvent,
  collectImageFilesFromPasteEvent,
  eventHasImageFiles,
} from './image-attachment-input-utils.js';

import { renderMaidMarkdownHtml } from './maid-markdown-utils.js';
import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { bindMaidVoiceButton } from './maid-voice-button.js';
import { t } from '../i18n/index.js';

const STYLE_ID = 'maid-command-input-runtime-style';
const FIELD_MIN_HEIGHT = 32;
const FIELD_MAX_HEIGHT = 76;
const DEFAULT_MAX_IMAGE_ATTACHMENTS = 4;
const RESULT_VISIBLE_ITEM_LIMIT = 3;

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const containsNode = (container, target) => {
  if (!container || !target) return false;
  if (container === target) return true;
  if (typeof container.contains === 'function') return container.contains(target);
  let node = target;
  while (node) {
    if (node === container) return true;
    node = node.parentNode || node.host || null;
  }
  return false;
};

const isClassedNode = (node, className = '') => Boolean(
  node &&
  typeof node === 'object' &&
  node.classList &&
  typeof node.classList.contains === 'function' &&
  node.classList.contains(className)
);

const isAppModalPointerTarget = (target, path = null) => {
  const nodes = Array.isArray(path) && path.length ? path : [target];
  return nodes.some(node => {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.closest === 'function' && node.closest('.app-confirm-overlay, .app-confirm-modal, .maid-guide-step-bubble, .maid-spotlight-root')) {
      return true;
    }
    return isClassedNode(node, 'app-confirm-overlay') ||
      isClassedNode(node, 'app-confirm-modal') ||
      isClassedNode(node, 'maid-guide-step-bubble') ||
      isClassedNode(node, 'maid-spotlight-root');
  });
};

const iconSvg = body => `
  <svg class="maid-command-input-icon" viewBox="0 0 24 24" aria-hidden="true">
    ${body}
  </svg>
`;

const ICONS = Object.freeze({
  attach: iconSvg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  settings: iconSvg('<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.03.03a2.05 2.05 0 0 1-2.9 2.9l-.03-.03A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .54V20a2 2 0 0 1-4 0v-.06a1.7 1.7 0 0 0-1-.54 1.7 1.7 0 0 0-1.88.34l-.03.03a2.05 2.05 0 0 1-2.9-2.9l.03-.03A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.54-1H4a2 2 0 0 1 0-4h.06a1.7 1.7 0 0 0 .54-1 1.7 1.7 0 0 0-.34-1.88l-.03-.03a2.05 2.05 0 0 1 2.9-2.9l.03.03A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.54V4a2 2 0 0 1 4 0v.06a1.7 1.7 0 0 0 1 .54 1.7 1.7 0 0 0 1.88-.34l.03-.03a2.05 2.05 0 0 1 2.9 2.9l-.03.03A1.7 1.7 0 0 0 19.4 9c.2.35.38.68.54 1H20a2 2 0 0 1 0 4h-.06a1.7 1.7 0 0 0-.54 1Z"/>'),
  send: iconSvg('<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>'),
  stop: iconSvg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
  selection: iconSvg('<circle cx="12" cy="12" r="7"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>'),
});

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.maid-command-input {
  position: fixed;
  z-index: 26090;
  width: min(376px, calc(100vw - 24px));
  min-height: 44px;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 6px 7px 6px 9px;
  box-sizing: border-box;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.30));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 94%, var(--app-surface-subtle, #f8fafc));
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.20);
  color: var(--app-text-primary, #111827);
  opacity: 0;
  transform: scale(0.86);
  transform-origin: center;
  pointer-events: none;
  transition: opacity 150ms ease, transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.maid-command-input.is-dragover {
  border-color: rgba(37, 99, 235, 0.42);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.20), 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.maid-command-input-drag {
  flex: 0 0 auto;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 20px;
  margin: 0 2px 0 0;
  border-radius: 10px;
  cursor: grab;
  touch-action: none;
}
.maid-command-input-drag:hover {
  background: var(--app-surface-subtle, rgba(148, 163, 184, 0.12));
}
.maid-command-input-drag span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--app-text-muted, rgba(100, 116, 139, 0.55));
  opacity: 0.7;
}
.maid-command-input-drag:active {
  cursor: grabbing;
}
.maid-command-input.is-open {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}
.maid-command-input.is-open.is-submitting {
  opacity: 0.92;
}
.maid-command-input.has-result {
  z-index: 26095;
}
.maid-command-input-field {
  min-width: 0;
  min-height: 32px;
  max-height: 76px;
  flex: 1 1 auto;
  padding: 5px 0;
  box-sizing: border-box;
  border: 0;
  outline: 0;
  resize: none;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  box-shadow: none;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  overflow: hidden;
  scrollbar-width: thin;
}
.maid-command-input-field::placeholder {
  color: var(--app-text-muted, rgba(100, 116, 139, 0.78));
}
.maid-command-input-attachments {
  flex: 1 0 100%;
  display: none;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  padding: 1px 0 2px;
  scrollbar-width: none;
}
.maid-command-input.has-attachments {
  border-radius: 18px;
}
.maid-command-input.has-attachments .maid-command-input-attachments {
  display: flex;
}
.maid-command-input-attachments::-webkit-scrollbar {
  display: none;
}
.maid-command-input-attachment {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.30);
  background: var(--app-surface-subtle, #f8fafc);
}
.maid-command-input-attachment img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.maid-command-input-attachment-remove {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 999px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.78);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.maid-command-input-selection {
  position: relative;
}
.maid-command-input-selection.is-active {
  border-color: rgba(37, 99, 235, 0.45);
  background: rgba(37, 99, 235, 0.14);
  color: #1d4ed8;
}
.maid-command-input-selection-count {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: #2563eb;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: none;
  align-items: center;
  justify-content: center;
}
.maid-command-input-selection.has-items .maid-command-input-selection-count {
  display: inline-flex;
}
.maid-command-input-selection,
.maid-command-input-attach,
.maid-command-input-settings,
.maid-command-input-submit {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  color: var(--app-text-secondary, #475569);
  transition: background 120ms ease, color 120ms ease, transform 90ms ease;
  touch-action: manipulation;
}
.maid-command-input-attach {
  background: var(--app-surface-subtle, #f8fafc);
}
.maid-command-input-settings {
  background: var(--app-surface-subtle, #f8fafc);
}
.maid-command-input-submit {
  background: #2563eb;
  color: #fff;
}
.maid-command-input-selection:hover,
.maid-command-input-attach:hover,
.maid-command-input-settings:hover {
  background: rgba(37, 99, 235, 0.10);
  color: #2563eb;
}
.maid-command-input-submit:hover {
  background: #1d4ed8;
}
.maid-command-input.is-submitting .maid-command-input-submit {
  background: #dc2626;
}
.maid-command-input.is-submitting .maid-command-input-submit:hover {
  background: #b91c1c;
}
.maid-command-input-selection:active,
.maid-command-input-attach:active,
.maid-command-input-settings:active,
.maid-command-input-submit:active {
  transform: translateY(1px);
}
.maid-command-input-selection:focus-visible,
.maid-command-input-attach:focus-visible,
.maid-command-input-settings:focus-visible,
.maid-command-input-submit:focus-visible {
  outline: 2px solid rgba(37, 99, 235, 0.32);
  outline-offset: 2px;
}
.maid-command-input:focus-within {
  border-color: rgba(37, 99, 235, 0.38);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.20), 0 0 0 2px rgba(37, 99, 235, 0.10);
}
.maid-command-input-icon {
  width: 16px;
  height: 16px;
  display: block;
  pointer-events: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.maid-command-input-attach:disabled,
.maid-command-input-settings:disabled,
.maid-command-input-submit:disabled {
  opacity: 0.55;
  cursor: default;
}
.maid-command-input-result {
  position: absolute;
  width: 100%;
  max-height: min(42vh, calc(58px * ${RESULT_VISIBLE_ITEM_LIMIT} + 14px));
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 1px 2px;
  box-sizing: border-box;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--app-text-primary, #111827);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: none;
  scrollbar-width: thin;
}
.maid-command-input-result::before {
  display: none;
}
.maid-command-input-result-item {
  flex: 0 0 auto;
  max-width: 100%;
  min-height: 38px;
  padding: 9px 11px;
  box-sizing: border-box;
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 16px 16px 16px 6px;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 94%, rgba(37, 99, 235, 0.08));
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
}
.maid-command-input-result-item[data-tone="thinking"] {
  color: var(--app-text-secondary, #475569);
}
.maid-command-input-result-item[data-tone="error"] {
  border-color: rgba(239, 68, 68, 0.30);
  background: color-mix(in srgb, var(--app-surface-card, #fff) 90%, rgba(239, 68, 68, 0.12));
}
.mci-result-message > :first-child {
  margin-top: 0;
}
.mci-result-message > :last-child {
  margin-bottom: 0;
}
.mci-result-message p {
  margin: 0 0 6px;
}
.mci-result-message ul,
.mci-result-message ol {
  margin: 3px 0 6px;
  padding-left: 20px;
}
.mci-result-message blockquote {
  margin: 4px 0 7px;
  padding-left: 9px;
  border-left: 3px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 38%, transparent);
  color: var(--app-text-secondary, #475569);
}
.mci-result-message code {
  padding: 1px 4px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--app-text-primary, #111827) 8%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.mci-result-message a {
  color: var(--app-accent-primary, #2563eb);
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.mci-result-message h1,
.mci-result-message h2,
.mci-result-message h3,
.mci-result-message h4,
.mci-result-message h5,
.mci-result-message h6 {
  margin: 4px 0 6px;
  font-size: 1em;
  line-height: 1.35;
}
.mci-result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.mci-result-action {
  min-height: 40px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 22%, var(--app-border-default));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 8%, var(--app-surface-card));
  color: var(--app-accent-primary, #2563eb);
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
  touch-action: manipulation;
}
/* 女仆执行流结构化卡：在白色结果流内原位呈现 计/行/成/败 铭牌与状态 */
.maid-command-input-result-item.is-trace {
  padding: 8px 11px;
}
.mci-trace-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.mci-trace-glyph {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(var(--app-accent-rgb, 59, 130, 246), 0.10);
  color: var(--app-text-primary, #111827);
  font-family: Georgia, 'Songti SC', 'Noto Serif SC', serif;
  font-size: 11px;
  font-weight: 700;
}
.maid-command-input-result-item.is-trace[data-tone="success"] .mci-trace-glyph { background: rgba(var(--app-success-rgb, 34, 197, 94), 0.12); }
.maid-command-input-result-item.is-trace[data-tone="danger"] .mci-trace-glyph { background: rgba(var(--app-danger-rgb, 239, 68, 68), 0.12); }
.maid-command-input-result-item.is-trace[data-tone="warning"] .mci-trace-glyph { background: rgba(var(--app-warning-rgb, 245, 158, 11), 0.14); }
.mci-trace-label {
  flex: 0 0 auto;
  font-family: ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--app-text-muted, rgba(100, 116, 139, 0.8));
}
.mci-trace-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
}
.mci-trace-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--app-text-secondary, #475569);
}
.mci-trace-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-text-muted, rgba(100, 116, 139, 0.8));
}
/* 执行中/等待中：状态点换成小转圈 */
.mci-trace-status.is-live::before {
  width: 9px;
  height: 9px;
  background: transparent;
  border: 1.5px solid rgba(var(--app-accent-rgb, 59, 130, 246), 0.25);
  border-top-color: rgb(var(--app-accent-rgb, 59, 130, 246));
  animation: mciTraceSpin 0.8s linear infinite;
  box-shadow: none;
}
.maid-command-input-result-item.is-trace[data-tone="warning"] .mci-trace-status.is-live::before {
  border-color: rgba(var(--app-warning-rgb, 245, 158, 11), 0.30);
  border-top-color: rgb(var(--app-warning-rgb, 245, 158, 11));
}
@keyframes mciTraceSpin {
  to { transform: rotate(360deg); }
}
/* 新卡一张一张推出（进场用 backwards 配合逐卡 delay） */
.maid-command-input-result-item.is-entering {
  animation: mciCardIn 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
}
@keyframes mciCardIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.maid-command-input-result-item.is-trace[data-tone="accent"] .mci-trace-status::before {
  background: rgb(var(--app-accent-rgb, 59, 130, 246));
  animation: mciTracePulse 1.4s ease-in-out infinite;
}
.maid-command-input-result-item.is-trace[data-tone="success"] .mci-trace-status::before { background: rgb(var(--app-success-rgb, 34, 197, 94)); }
.maid-command-input-result-item.is-trace[data-tone="danger"] .mci-trace-status::before { background: rgb(var(--app-danger-rgb, 239, 68, 68)); }
.maid-command-input-result-item.is-trace[data-tone="warning"] .mci-trace-status::before {
  background: rgb(var(--app-warning-rgb, 245, 158, 11));
  animation: mciTracePulse 1.1s ease-in-out infinite;
}
@keyframes mciTracePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--app-accent-rgb, 59, 130, 246), 0.30); }
  50% { box-shadow: 0 0 0 4px rgba(var(--app-accent-rgb, 59, 130, 246), 0.10); }
}
/* 过程叙述单行状态：转圈 + 文本原位替换（"我已取得结果，正在整理给你"这类不再各占气泡）。
   刻意做小、做淡、宽度收敛为内容宽——一眼与真正的结果气泡区分开 */
.maid-command-input-result-item.mci-live-row {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  width: fit-content;
  max-width: 100%;
  min-height: 0;
  padding: 4px 10px 4px 8px;
  color: var(--app-text-muted, rgba(100, 116, 139, 0.85));
  background: color-mix(in srgb, var(--app-surface-card, #fff) 55%, transparent);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--app-border-default, rgba(148, 163, 184, 0.30)) 65%, transparent);
  border-radius: 999px;
  box-shadow: none;
  opacity: 0.88;
}
.mci-live-spinner {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border: 1.5px solid rgba(var(--app-accent-rgb, 59, 130, 246), 0.22);
  border-top-color: rgba(var(--app-accent-rgb, 59, 130, 246), 0.85);
  border-radius: 50%;
  animation: mciTraceSpin 0.8s linear infinite;
}
.mci-live-text {
  min-width: 0;
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
}
.mci-trace-sub {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--app-text-secondary, #475569);
  word-break: break-word;
}
.mci-trace-sub.is-error { color: rgb(var(--app-danger-rgb, 239, 68, 68)); }
.maid-command-input-result-item.is-trace[data-tone="danger"] {
  border-color: rgba(var(--app-danger-rgb, 239, 68, 68), 0.35);
}
.maid-command-input[data-bubble-side="top"] .maid-command-input-result {
  left: 0;
  bottom: calc(100% + 8px);
}
.maid-command-input[data-bubble-side="bottom"] .maid-command-input-result {
  left: 0;
  top: calc(100% + 8px);
}
@media (max-width: 760px) {
  .maid-command-input[data-bubble-side] .maid-command-input-result {
    left: 0;
    right: 0;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .maid-command-input {
    transition: none;
  }
  .maid-command-input-result-item.is-entering,
  .mci-trace-status.is-live::before,
  .mci-live-spinner {
    animation: none !important;
  }
  .mci-trace-status.is-live::before {
    background: rgb(var(--app-accent-rgb, 59, 130, 246));
    border: 0;
    width: 6px;
    height: 6px;
  }
}
`;
  documentRef.head.appendChild(style);
};

export const createMaidCommandInputRuntime = ({
  documentRef = globalThis?.document || null,
  modeSwitchEl = null,
  getViewportSize = () => ({ w: 0, h: 0 }),
  onSubmit = async () => ({}),
  onVoiceTextSubmit = null,
  onCancelActive = null,
  onSettings = null,
  onAttachFiles = null,
  onToggleSelection = null,
  onOpenStateChange = null,
  getVoiceState = () => ({}),
  onVoiceAction = null,
  onChooseVoiceMode = null,
  onCloseVoiceInput = null,
  maxImageAttachments = DEFAULT_MAX_IMAGE_ATTACHMENTS,
  setTimeoutFn = globalThis?.setTimeout || null,
  clearTimeoutFn = globalThis?.clearTimeout || null,
  // 指令条盖住悬浮球时的拖拽通道：非交互区按下即转发给球的拖拽运行时（运行中也可拖）
  getBallDragRuntime = null,
} = {}) => {
  let rootEl = null;
  let inputEl = null;
  let dragHandleEl = null;
  let attachBtn = null;
  let fileInputEl = null;
  let attachmentsEl = null;
  let settingsBtn = null;
  let selectionBtn = null;
  let submitBtn = null;
  let voiceButton = null;
  let resultEl = null;
  let closeTimer = null;
  let isOpen = false;
  let isSubmitting = false;
  let outsidePointerHandler = null;
  let imageAttachments = [];
  let resultMessages = [];
  let resultSeq = 0;
  let resultEnterPaceUntil = 0; // 跨渲染的逐卡推出节拍（相邻新卡 ≥150ms，积压封顶 1.2s）
  let liveStatus = null; // 过程叙述（thinking）单行状态：转圈+可替换文本，不各占气泡
  let restoreResultOnNextOpen = false;
  let submissionSeq = 0;
  let activeSubmission = null;
  let activeAbortController = null;
  let activeRunId = '';
  let cancelPending = false;
  const queuedSubmissions = [];

  const notifyOpenStateChange = () => {
    try {
      onOpenStateChange?.({ open: isOpen, submitting: isSubmitting, rootEl });
    } catch {}
  };

  const createAttachmentId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `maid_img_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  };

  const normalizeIncomingAttachments = (result = null) => {
    const raw = Array.isArray(result)
      ? result
      : Array.isArray(result?.attachments)
        ? result.attachments
        : [];
    return raw
      .filter(item => item && typeof item === 'object' && trim(item.url || item.llmUrl))
      .map(item => ({
        ...item,
        id: trim(item.id) || createAttachmentId(),
        kind: trim(item.kind, 'image'),
      }));
  };

  const getMaxImages = () => Math.max(1, Math.trunc(Number(maxImageAttachments || 0)) || DEFAULT_MAX_IMAGE_ATTACHMENTS);

  const renderAttachments = () => {
    voiceButton?.sync();
    if (!attachmentsEl || !rootEl) return;
    attachmentsEl.innerHTML = '';
    rootEl.classList.toggle('has-attachments', imageAttachments.length > 0);
    if (!imageAttachments.length) {
      position();
      return;
    }
    imageAttachments.forEach((attachment) => {
      const item = documentRef.createElement?.('div');
      if (!item) return;
      item.className = 'maid-command-input-attachment';
      item.dataset.attachmentId = attachment.id || '';
      const img = documentRef.createElement?.('img');
      if (img) {
        img.src = attachment.url || attachment.llmUrl || '';
        img.alt = attachment.name || 'image';
        item.appendChild(img);
      }
      const remove = documentRef.createElement?.('button');
      if (remove) {
        remove.type = 'button';
        remove.className = 'maid-command-input-attachment-remove';
        remove.dataset.attachmentId = attachment.id || '';
        remove.textContent = 'x';
        item.appendChild(remove);
      }
      attachmentsEl.appendChild(item);
    });
    position();
  };

  const appendAttachments = (attachments = []) => {
    const max = getMaxImages();
    const next = imageAttachments.slice();
    for (const attachment of attachments) {
      if (!attachment || next.length >= max) break;
      next.push({
        ...attachment,
        id: trim(attachment.id) || createAttachmentId(),
        kind: trim(attachment.kind, 'image'),
      });
    }
    imageAttachments = next;
    renderAttachments();
    return imageAttachments.length;
  };

  const addFiles = async (files = [], { source = 'picker' } = {}) => {
    const list = Array.from(files || []);
    if (!list.length || typeof onAttachFiles !== 'function') return [];
    const remaining = getMaxImages() - imageAttachments.length;
    if (remaining <= 0) return [];
    const result = await onAttachFiles(list.slice(0, remaining), { source });
    const attachments = normalizeIncomingAttachments(result);
    appendAttachments(attachments);
    return attachments;
  };

  const removeAttachment = (id = '') => {
    const target = trim(id);
    if (!target) return;
    imageAttachments = imageAttachments.filter(item => trim(item.id) !== target);
    renderAttachments();
  };

  const clearAttachments = () => {
    if (!imageAttachments.length) return;
    imageAttachments = [];
    renderAttachments();
  };

  const clearCloseTimer = () => {
    if (closeTimer == null) return;
    clearTimeoutFn?.(closeTimer);
    closeTimer = null;
  };

  const shouldStickResultToBottom = () => {
    if (!resultEl) return true;
    const scrollHeight = Number(resultEl.scrollHeight || 0) || 0;
    const clientHeight = Number(resultEl.clientHeight || 0) || 0;
    const scrollTop = Number(resultEl.scrollTop || 0) || 0;
    if (!scrollHeight || !clientHeight) return true;
    return scrollHeight - scrollTop - clientHeight <= 28;
  };

  const scrollResultToBottom = () => {
    if (!resultEl) return;
    try {
      if (typeof resultEl.scrollTo === 'function') {
        resultEl.scrollTo({ top: Number(resultEl.scrollHeight || 0) || 0, behavior: 'smooth' });
        return;
      }
    } catch {}
    try {
      resultEl.scrollTop = Number(resultEl.scrollHeight || 0) || 0;
    } catch {}
  };

  const renderResultMessages = ({ forceBottom = false } = {}) => {
    if (!rootEl || !documentRef) return;
    if (!resultMessages.length && !liveStatus) {
      resultEl?.remove?.();
      resultEl = null;
      rootEl.classList.remove('has-result');
      return;
    }
    const keepBottom = forceBottom || shouldStickResultToBottom();
    const previousScrollTop = Number(resultEl?.scrollTop || 0) || 0;
    if (!resultEl) {
      resultEl = documentRef.createElement?.('div');
      resultEl.className = 'maid-command-input-result';
      resultEl.setAttribute?.('role', 'status');
      resultEl.setAttribute?.('aria-live', 'polite');
      rootEl.appendChild(resultEl);
    }
    rootEl.classList.add('has-result');
    const buildResultItemContent = (bubble, item) => {
      bubble.innerHTML = '';
      if (item.kind === 'trace') {
        bubble.className = `maid-command-input-result-item is-trace${bubble.classList?.contains?.('is-entering') ? ' is-entering' : ''}`;
        bubble.dataset.tone = item.tone || 'muted';
        const head = documentRef.createElement?.('div');
        head.className = 'mci-trace-head';
        const glyph = documentRef.createElement?.('span');
        glyph.className = 'mci-trace-glyph';
        glyph.textContent = item.glyph || '行';
        const label = documentRef.createElement?.('span');
        label.className = 'mci-trace-label';
        label.textContent = item.label || '';
        const title = documentRef.createElement?.('span');
        title.className = 'mci-trace-title';
        title.textContent = item.title || '';
        head.appendChild(glyph);
        head.appendChild(label);
        head.appendChild(title);
        if (item.statusLabel) {
          const status = documentRef.createElement?.('span');
          const live = item.tone === 'accent' || item.tone === 'warning';
          status.className = `mci-trace-status${live ? ' is-live' : ''}`;
          status.textContent = item.statusLabel;
          head.appendChild(status);
        }
        bubble.appendChild(head);
        const subText = trim(item.error) || trim(item.sub);
        if (subText) {
          const sub = documentRef.createElement?.('div');
          sub.className = `mci-trace-sub${item.error ? ' is-error' : ''}`;
          sub.textContent = subText;
          bubble.appendChild(sub);
        }
      } else {
        bubble.className = `maid-command-input-result-item${bubble.classList?.contains?.('is-entering') ? ' is-entering' : ''}`;
        bubble.dataset.tone = item.tone;
        const message = documentRef.createElement?.('div');
        message.className = 'mci-result-message';
        message.innerHTML = renderMaidMarkdownHtml(item.message);
        bubble.appendChild(message);
        const actions = Array.isArray(item.actions) ? item.actions : [];
        if (actions.length) {
          const actionRow = documentRef.createElement?.('div');
          actionRow.className = 'mci-result-actions';
          actions.forEach((action) => {
            const button = documentRef.createElement?.('button');
            button.type = 'button';
            button.className = 'mci-result-action';
            button.textContent = trim(action?.label, '继续');
            button.addEventListener?.('click', (event) => {
              event.preventDefault?.();
              event.stopPropagation?.();
              action?.onClick?.();
            });
            actionRow.appendChild(button);
          });
          bubble.appendChild(actionRow);
        }
      }
    };
    // 键控 reconcile：既有卡原位补丁（状态原地翻转、不重播进场），新卡逐张推出（stagger 进场）
    const existingNodes = new Map();
    Array.from(resultEl.children || []).forEach((node) => {
      const key = node?.dataset?.key;
      if (key) existingNodes.set(key, node);
      else if (!node?.dataset?.mciLive) node.remove?.();
    });
    // 单次渲染取一次时钟：同批新卡的节拍必须相对同一基准（逐节点取时会因毫秒推进产生 149ms 类漂移）
    const renderNowTs = Date.now();
    resultMessages.forEach((item, index) => {
      const key = trim(item.id, `idx_${index}`);
      let node = existingNodes.get(key) || null;
      if (node) {
        existingNodes.delete(key);
        buildResultItemContent(node, item);
        return; // 追加式列表：既有节点位置不变
      }
      node = documentRef.createElement?.('div');
      if (!node) return;
      node.dataset.key = key;
      node.classList?.add?.('is-entering');
      // 跨渲染节拍：同批与快速连发的事件都一张一张推出
      const delayMs = Math.min(1200, Math.max(0, resultEnterPaceUntil - renderNowTs));
      resultEnterPaceUntil = Math.max(renderNowTs, resultEnterPaceUntil) + 150;
      if (node.style) node.style.animationDelay = `${delayMs}ms`;
      node.addEventListener?.('animationend', () => {
        node.classList?.remove?.('is-entering');
        if (node.style) node.style.animationDelay = '';
      }, { once: true });
      buildResultItemContent(node, item);
      resultEl.appendChild(node);
    });
    existingNodes.forEach(node => node.remove?.());
    // live 状态行：常驻底部单行（转圈+文本原位替换），随每次渲染挪到最末
    let liveEl = Array.from(resultEl.children || []).find(node => node?.dataset?.mciLive) || null;
    if (liveStatus) {
      if (!liveEl) {
        liveEl = documentRef.createElement?.('div');
        if (liveEl) {
          liveEl.dataset.mciLive = '1';
          liveEl.className = 'maid-command-input-result-item mci-live-row';
          const spinner = documentRef.createElement?.('span');
          spinner.className = 'mci-live-spinner';
          const text = documentRef.createElement?.('span');
          text.className = 'mci-live-text';
          liveEl.appendChild(spinner);
          liveEl.appendChild(text);
        }
      }
      if (liveEl) {
        const textEl = (liveEl.children || []).find?.(child => String(child?.className || '').includes('mci-live-text'))
          || liveEl.querySelector?.('.mci-live-text');
        if (textEl) textEl.textContent = liveStatus.message;
        resultEl.appendChild(liveEl);
      }
    } else if (liveEl) {
      liveEl.remove?.();
    }
    const latest = resultMessages[resultMessages.length - 1] || {};
    resultEl.dataset.tone = latest.tone || 'info';
    resultEl.dataset.count = String(resultMessages.length);
    if (keepBottom) scrollResultToBottom();
    else resultEl.scrollTop = previousScrollTop;
  };

  const clearResult = () => {
    resultMessages = [];
    liveStatus = null;
    restoreResultOnNextOpen = false;
    renderResultMessages();
  };

  const getNonDuplicateDoneSummary = (summary = '') => {
    const text = trim(summary);
    if (!text) return '';
    for (let index = resultMessages.length - 1; index >= 0; index -= 1) {
      const item = resultMessages[index];
      if (item.kind === 'trace' || !trim(item.message)) continue;
      return trim(item.message) === text ? '' : text;
    }
    return text;
  };

  const clearMatchingDoneSummary = (message = '') => {
    const text = trim(message);
    if (!text) return;
    for (let index = resultMessages.length - 1; index >= 0; index -= 1) {
      const item = resultMessages[index];
      if (item.kind !== 'trace' || !String(item.id || '').startsWith('done:')) continue;
      if (trim(item.sub) === text) item.sub = '';
      break;
    }
  };

  const setResult = (message = '', tone = 'info', options = {}) => {
    const text = trim(message);
    if (!text) {
      clearResult();
      return;
    }
    if (options?.replace) {
      resultMessages = [];
      liveStatus = null;
    }
    const normalizedTone = trim(tone, 'info');
    // 写死的过程提示（progress）不各占气泡：收进底部单行 live 状态（转圈 + 文本原位替换）。
    // 模型生成的女仆话语（thinking）保持正常气泡。
    if (normalizedTone === 'progress') {
      liveStatus = { message: text };
      renderResultMessages({ forceBottom: options?.forceBottom !== false });
      return;
    }
    if (normalizedTone === 'success' || normalizedTone === 'error') clearMatchingDoneSummary(text);
    const latest = resultMessages[resultMessages.length - 1];
    if (!latest || latest.message !== text || latest.tone !== normalizedTone) {
      resultSeq += 1;
      resultMessages.push({
        id: `text_${resultSeq}`,
        message: text,
        tone: normalizedTone,
        actions: Array.isArray(options?.actions) ? options.actions : [],
      });
    }
    renderResultMessages({ forceBottom: options?.forceBottom !== false });
  };

  /* 女仆执行流投影：结构化 trace 卡按 id 原位更新、按时间与叙述气泡交错追加。
     返回 true 表示指令条已承载女仆流（执行流面板据此不再自开，避免双流）。 */
  const upsertResultItem = (id, payload = {}) => {
    const index = resultMessages.findIndex(item => item.id === id);
    if (index >= 0) resultMessages[index] = { ...resultMessages[index], ...payload, id };
    else resultMessages.push({ ...payload, id });
  };

  const applyTraceView = (view = null) => {
    if (!view || !trim(view.runId)) return false;
    if (activeSubmission && view.terminal !== true) activeRunId = trim(view.runId);
    if (!rootEl || !isOpen) return false; // 从未打开或已经关闭 → 交回执行流面板兜底
    const runId = trim(view.runId);
    upsertResultItem(`plan:${runId}`, {
      kind: 'trace',
      glyph: '计',
      label: 'PLAN',
      title: trim(view.title, '女仆任务'),
      tone: 'accent',
      statusLabel: '',
    });
    (Array.isArray(view.steps) ? view.steps : []).forEach((step) => {
      upsertResultItem(`step:${runId}:${step.id}`, {
        kind: 'trace',
        glyph: step.glyph || '行',
        label: `TOOL·${String(step.seq || 0).padStart(2, '0')}`,
        title: trim(step.title),
        sub: step.toolName && step.toolName !== step.title ? step.toolName : '',
        error: trim(step.error),
        tone: step.tone || 'muted',
        statusLabel: trim(step.statusLabel),
      });
    });
    if (view.terminal) {
      liveStatus = null; // run 终态：过程叙述行退场，终态卡接棒
      upsertResultItem(`done:${runId}`, {
        kind: 'trace',
        glyph: view.status === 'succeeded' ? '成' : view.status === 'cancelled' ? '止' : '败',
        label: view.status === 'succeeded' ? 'DONE' : String(view.status || '').toUpperCase(),
        title: trim(view.statusLabel),
        sub: getNonDuplicateDoneSummary(view.doneSummary),
        error: trim(view.failureCode),
        tone: view.tone || 'muted',
        statusLabel: '',
      });
    }
    renderResultMessages({ forceBottom: view.terminal !== true });
    return true;
  };

  const updateSubmitButton = () => {
    if (!submitBtn) return;
    if (voiceButton) { voiceButton.sync(); return; }
    submitBtn.type = isSubmitting ? 'button' : 'submit';
    submitBtn.innerHTML = isSubmitting ? ICONS.stop : ICONS.send;
    submitBtn.disabled = cancelPending;
    submitBtn.setAttribute?.('aria-label', isSubmitting ? '停止女仆任务' : '发送给女仆');
    submitBtn.title = isSubmitting ? '停止当前女仆任务' : '';
  };

  const setSubmitting = (next) => {
    isSubmitting = next === true;
    if (!isSubmitting && liveStatus) {
      liveStatus = null; // 提交结束：过程叙述行退场（终态由 success/error 气泡与终态卡呈现）
      renderResultMessages({ forceBottom: false });
    }
    rootEl?.classList.toggle('is-submitting', isSubmitting);
    rootEl?.setAttribute?.('aria-busy', isSubmitting ? 'true' : 'false');
    if (inputEl) inputEl.placeholder = isSubmitting ? '继续输入，发送后排队...' : '问女仆...';
    updateSubmitButton();
  };

  const publicSubmission = entry => (entry ? {
    id: entry.id,
    text: entry.text,
    attachmentCount: entry.attachments.length,
  } : null);

  const removeResultItem = (id = '') => {
    const target = trim(id);
    const next = resultMessages.filter(item => trim(item.id) !== target);
    if (next.length === resultMessages.length) return false;
    resultMessages = next;
    renderResultMessages({ forceBottom: false });
    return true;
  };

  const cancelQueued = (id = '') => {
    const target = trim(id);
    const index = queuedSubmissions.findIndex(item => item.id === target);
    if (index < 0) return false;
    const [entry] = queuedSubmissions.splice(index, 1);
    removeResultItem(`queue:${entry.id}`);
    const result = {
      ok: false,
      cancelled: true,
      queued: true,
      reason: 'queued_submission_cancelled',
      message: '已取消排队任务。',
    };
    entry.resolve(result);
    setResult(`已取消排队：${entry.text.slice(0, 48)}`, 'info');
    return true;
  };

  const cancelAllQueued = () => {
    const entries = queuedSubmissions.splice(0);
    entries.forEach((entry) => {
      removeResultItem(`queue:${entry.id}`);
      entry.resolve({
        ok: false,
        cancelled: true,
        queued: true,
        reason: 'queued_submission_cancelled',
        message: '已取消排队任务。',
      });
    });
    if (entries.length) setResult(`已取消 ${entries.length} 项排队任务。`, 'info');
    return entries.length;
  };

  const cancelActive = async ({ runId = '' } = {}) => {
    if (cancelPending) return false;
    const requestedRunId = trim(runId);
    if (!activeSubmission || !activeAbortController || activeAbortController.signal.aborted) {
      if (requestedRunId) setResult('该任务不是由指令条启动的当前任务，无法从这里停止。', 'info');
      return false;
    }
    if (requestedRunId && activeRunId && requestedRunId !== activeRunId) {
      setResult('该任务不是当前正在执行的指令，无法从这里停止。', 'info');
      return false;
    }
    const submission = activeSubmission;
    cancelPending = true;
    updateSubmitButton();
    try {
      let decision = 'all_stop';
      if (queuedSubmissions.length && typeof onCancelActive === 'function') {
        decision = await onCancelActive({
          active: publicSubmission(submission),
          queued: queuedSubmissions.map(publicSubmission),
          queuedCount: queuedSubmissions.length,
        });
      }
      if (decision !== 'all_stop' && decision !== true) return false;
      // 「全部停止」包含确认期间从队列提升为 active 的下一项；
      // 重取现场，不再因原 controller 自然结束而整体提前返回。
      const cancelledQueuedCount = cancelAllQueued();
      const currentController = activeAbortController;
      if (!currentController || currentController.signal.aborted) return cancelledQueuedCount > 0;
      const error = new Error('Maid task stopped by user');
      error.name = 'AbortError';
      currentController.abort(error);
      return true;
    } finally {
      cancelPending = false;
      updateSubmitButton();
    }
  };

  const showQueuedSubmission = (entry) => {
    upsertResultItem(`queue:${entry.id}`, {
      kind: 'queue',
      message: `等待执行：${entry.text.slice(0, 80)}${entry.text.length > 80 ? '…' : ''}`,
      tone: 'thinking',
      actions: [{
        label: '取消排队',
        onClick: () => cancelQueued(entry.id),
      }],
    });
    renderResultMessages({ forceBottom: true });
  };

  const processSubmissionQueue = async () => {
    if (isSubmitting || activeSubmission || !queuedSubmissions.length) return;
    setSubmitting(true);
    try {
      while (queuedSubmissions.length) {
        const entry = queuedSubmissions.shift();
        activeSubmission = entry;
        const submissionAbortController = new AbortController();
        activeAbortController = submissionAbortController;
        removeResultItem(`queue:${entry.id}`);
        setResult(entry.wasQueued ? '女仆正在处理下一项排队任务...' : '女仆正在回复...', 'progress');
        let result = null;
        try {
          entry.controls?.onStatus?.(t('正在处理'), 'progress');
          result = await onSubmit(entry.text, {
            ...entry.controls,
            submissionId: entry.id,
            setStatus: (message = '', tone = 'thinking') => {
              setResult(message, tone);
              entry.controls?.onStatus?.(message, tone);
            },
            attachments: entry.attachments,
            signal: submissionAbortController.signal,
          });
          const ok = result?.ok !== false;
          const cancelled = result?.status === 'cancelled' || result?.cancelled === true;
          setResult(
            result?.message || result?.summary || (ok ? '已完成。' : '执行失败。'),
            cancelled ? 'info' : (ok ? 'success' : 'error'),
            { actions: result?.actions },
          );
          entry.resolve(result || { ok });
        } catch (error) {
          const cancelled = error?.name === 'AbortError' || submissionAbortController.signal.aborted;
          setResult(cancelled ? '任务已终止。' : (error?.message || '女仆执行失败。'), cancelled ? 'info' : 'error');
          entry.resolve(cancelled
            ? { ok: false, status: 'cancelled', cancelled: true, reason: 'user_aborted', message: '任务已终止。' }
            : { ok: false, error });
        } finally {
          if (activeAbortController === submissionAbortController) activeAbortController = null;
          activeSubmission = null;
          activeRunId = '';
        }
      }
    } finally {
      setSubmitting(false);
      if (!isOpen && (resultMessages.length > 0 || Boolean(liveStatus))) restoreResultOnNextOpen = true;
    }
  };

  const unbindOutsidePointer = () => {
    if (!outsidePointerHandler) return;
    documentRef?.removeEventListener?.('pointerdown', outsidePointerHandler, true);
    outsidePointerHandler = null;
  };

  const bindOutsidePointer = () => {
    if (outsidePointerHandler || !documentRef?.addEventListener) return;
    outsidePointerHandler = (event) => {
      if (!isOpen) return;
      const path = typeof event?.composedPath === 'function' ? event.composedPath() : null;
      const target = path?.[0] || event?.target || null;
      if ((Array.isArray(path) && (path.includes(rootEl) || path.includes(modeSwitchEl)))
        || containsNode(rootEl, target)
        || containsNode(modeSwitchEl, target)) {
        return;
      }
      if (isAppModalPointerTarget(target, path)) return;
      close();
    };
    documentRef.addEventListener('pointerdown', outsidePointerHandler, true);
  };

  const resizeInput = () => {
    voiceButton?.sync();
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    const scrollHeight = Math.max(FIELD_MIN_HEIGHT, Number(inputEl.scrollHeight || 0) || FIELD_MIN_HEIGHT);
    const nextHeight = Math.min(FIELD_MAX_HEIGHT, scrollHeight);
    inputEl.style.height = `${Math.round(nextHeight)}px`;
    inputEl.style.overflowY = scrollHeight > FIELD_MAX_HEIGHT + 1 ? 'auto' : 'hidden';
    rootEl?.classList.toggle('is-multiline', nextHeight > FIELD_MIN_HEIGHT + 2);
    position();
  };

  const position = () => {
    if (!rootEl) return;
    const viewport = getViewportSize?.() || {};
    const w = Number(viewport.w || globalThis?.innerWidth || 0) || 0;
    const h = Number(viewport.h || globalThis?.innerHeight || 0) || 0;
    const rect = modeSwitchEl?.getBoundingClientRect?.() || {
      left: Math.max(12, w / 2 - 13),
      top: Math.max(12, h / 2 - 13),
      width: 26,
      height: 26,
    };
    const width = Math.min(376, Math.max(220, w - 24 || 376));
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const rootRect = rootEl.getBoundingClientRect?.() || {};
    const rootHeight = Math.max(44, Number(rootRect.height || 0) || (rootEl.classList.contains('is-multiline') ? 88 : 44));
    const left = w ? clamp(x - width / 2, 12, Math.max(12, w - width - 12)) : x - width / 2;
    const top = h ? clamp(y - rootHeight / 2, 12, Math.max(12, h - rootHeight - 12)) : y - rootHeight / 2;
    rootEl.style.width = `${Math.round(width)}px`;
    rootEl.style.left = `${Math.round(left)}px`;
    rootEl.style.top = `${Math.round(top)}px`;
    const bottomSpace = h ? h - (top + rootHeight) - 12 : 0;
    const topSpace = h ? top - 12 : 0;
    const side = bottomSpace >= 96 || bottomSpace >= topSpace ? 'bottom' : 'top';
    rootEl.dataset.bubbleSide = side;
  };

  const ensure = () => {
    if (rootEl || !documentRef?.body) return rootEl;
    injectStyle(documentRef);
    rootEl = documentRef.createElement?.('form');
    rootEl.className = 'maid-command-input';
    rootEl.setAttribute('role', 'search');
    rootEl.setAttribute('aria-label', '女仆助手输入');
    fileInputEl = documentRef.createElement?.('input');
    if (fileInputEl) {
      fileInputEl.type = 'file';
      fileInputEl.accept = 'image/*';
      fileInputEl.multiple = true;
      fileInputEl.style.display = 'none';
    }
    attachmentsEl = documentRef.createElement?.('div');
    if (attachmentsEl) {
      attachmentsEl.className = 'maid-command-input-attachments';
      attachmentsEl.setAttribute?.('aria-live', 'polite');
    }
    attachBtn = documentRef.createElement?.('button');
    attachBtn.className = 'maid-command-input-attach';
    attachBtn.type = 'button';
    attachBtn.innerHTML = ICONS.attach;
    attachBtn.setAttribute('aria-label', '附加图片');
    inputEl = documentRef.createElement?.('textarea');
    inputEl.className = 'maid-command-input-field';
    inputEl.dataset.maidGuideTarget = 'maid-command-input';
    inputEl.placeholder = '问女仆...';
    inputEl.autocomplete = 'off';
    inputEl.rows = 1;
    settingsBtn = documentRef.createElement?.('button');
    settingsBtn.className = 'maid-command-input-settings';
    settingsBtn.dataset.maidGuideTarget = 'maid-command-settings';
    settingsBtn.type = 'button';
    settingsBtn.innerHTML = ICONS.settings;
    settingsBtn.setAttribute('aria-label', '女仆设置');
    selectionBtn = documentRef.createElement?.('button');
    selectionBtn.className = 'maid-command-input-selection';
    selectionBtn.type = 'button';
    selectionBtn.innerHTML = `${ICONS.selection}<span class="maid-command-input-selection-count"></span>`;
    selectionBtn.setAttribute('aria-label', '圈选内容给女仆');
    selectionBtn.title = '圈选内容给女仆';
    submitBtn = documentRef.createElement?.('button');
    submitBtn.className = 'maid-command-input-submit';
    submitBtn.type = 'submit';
    submitBtn.innerHTML = ICONS.send;
    submitBtn.setAttribute('aria-label', '发送给女仆');
    voiceButton = bindMaidVoiceButton({ button: submitBtn,
      getState: () => ({ ...getVoiceState(), available: typeof onVoiceAction === 'function', submitting: isSubmitting,
        hasDraft: Boolean(trim(inputEl?.value) || imageAttachments.length), cancelPending }),
      onAction: onVoiceAction, onChooseMode: onChooseVoiceMode,
    });
    dragHandleEl = documentRef.createElement?.('div');
    if (dragHandleEl) {
      dragHandleEl.className = 'maid-command-input-drag';
      dragHandleEl.setAttribute('aria-hidden', 'true');
      dragHandleEl.title = '拖动女仆';
      dragHandleEl.innerHTML = '<span></span><span></span><span></span>';
    }
    if (dragHandleEl) rootEl.appendChild(dragHandleEl);
    if (fileInputEl) rootEl.appendChild(fileInputEl);
    if (attachmentsEl) rootEl.appendChild(attachmentsEl);
    rootEl.appendChild(attachBtn);
    rootEl.appendChild(selectionBtn);
    rootEl.appendChild(inputEl);
    rootEl.appendChild(settingsBtn);
    rootEl.appendChild(submitBtn);
    // 指令条以球心定位、整体盖住悬浮球：非交互区/拖柄按下即转发球拖拽；
    // 输入、附件、设置、发送等控件保持各自交互。
    rootEl.addEventListener?.('pointerdown', (event) => {
      const target = event?.target || null;
      const interactive = typeof target?.closest === 'function'
        ? target.closest('textarea:not(:disabled), button:not(:disabled), input, a, .maid-command-input-result, .maid-onboarding-welcome')
        : null;
      if (interactive) return;
      const ballDrag = typeof getBallDragRuntime === 'function' ? getBallDragRuntime() : null;
      if (!ballDrag?.startDrag) return;
      ballDrag.startDrag(event, { suppressLongPress: true, suppressClick: true });
    });
    rootEl.addEventListener?.('submit', (event) => {
      event.preventDefault?.();
      void submit();
    });
    submitBtn.addEventListener?.('click', (event) => {
      if (!isSubmitting) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      void cancelActive();
    });
    inputEl.addEventListener?.('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        close();
        return;
      }
      if (event.key === 'Enter' && event.shiftKey !== true && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault?.();
        void submit();
      }
    });
    inputEl.addEventListener?.('input', resizeInput);
    inputEl.addEventListener?.('paste', (event) => {
      const files = collectImageFilesFromPasteEvent(event);
      if (!files.length) return;
      event.preventDefault?.();
      void addFiles(files, { source: 'clipboard-image' });
    });
    rootEl.addEventListener?.('dragover', (event) => {
      if (!eventHasImageFiles(event)) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      rootEl.classList.add('is-dragover');
    });
    rootEl.addEventListener?.('dragleave', (event) => {
      const related = event?.relatedTarget || null;
      if (related && containsNode(rootEl, related)) return;
      rootEl.classList.remove('is-dragover');
    });
    rootEl.addEventListener?.('drop', (event) => {
      const files = collectImageFilesFromDropEvent(event);
      if (!files.length) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      rootEl.classList.remove('is-dragover');
      void addFiles(files, { source: 'drop-image' });
    });
    attachmentsEl?.addEventListener?.('click', (event) => {
      const target = event?.target || null;
      const btn = typeof target?.closest === 'function'
        ? target.closest('.maid-command-input-attachment-remove')
        : target?.className === 'maid-command-input-attachment-remove'
          ? target
          : null;
      if (!btn) return;
      event.preventDefault?.();
      removeAttachment(btn.dataset?.attachmentId || '');
    });
    attachBtn.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      try {
        fileInputEl?.click?.();
      } catch {}
    });
    fileInputEl?.addEventListener?.('change', () => {
      const files = Array.from(fileInputEl.files || []);
      if (files.length) void addFiles(files, { source: 'picker-image' });
      try {
        fileInputEl.value = '';
      } catch {}
    });
    selectionBtn.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      try { onToggleSelection?.(); } catch {}
    });
    settingsBtn.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      void onSettings?.({ source: 'command_input' });
    });
    documentRef.body.appendChild(rootEl);
    return rootEl;
  };

  const open = ({ initialText, autoFocus = true } = {}) => {
    const el = ensure();
    if (!el) return false;
    clearCloseTimer();
    const wasOpen = isOpen;
    const shouldRestoreResult = restoreResultOnNextOpen && (resultMessages.length > 0 || Boolean(liveStatus));
    isOpen = true;
    if (!isSubmitting) setSubmitting(false);
    if (!shouldRestoreResult && !isSubmitting) clearResult();
    restoreResultOnNextOpen = false;
    if (!isSubmitting && inputEl && initialText != null) inputEl.value = trim(initialText);
    resizeInput();
    position();
    renderResultMessages({ forceBottom: true });
    el.classList.add('is-open');
    modeSwitchEl?.classList.add?.('is-maid-input-open');
    bindOutsidePointer();
    if (!wasOpen) notifyOpenStateChange();
    if (autoFocus !== false) {
      setTimeoutFn?.(() => {
        try {
          inputEl?.focus?.();
        } catch {}
      }, 0);
    }
    return true;
  };

  const close = ({ preserve = Boolean(getVoiceState?.().call) && getVoiceState().call !== 'idle' } = {}) => {
    voiceButton?.cancelGesture();
    void onCloseVoiceInput?.();
    clearCloseTimer();
    const wasOpen = isOpen;
    const shouldPreserveResult = (preserve || isSubmitting) && (resultMessages.length > 0 || Boolean(liveStatus));
    isOpen = false;
    if (!isSubmitting) setSubmitting(false);
    rootEl?.classList.remove('is-open');
    rootEl?.classList.remove('is-dragover');
    modeSwitchEl?.classList.remove?.('is-maid-input-open');
    if (shouldPreserveResult) {
      restoreResultOnNextOpen = true;
    } else if (!preserve) {
      clearResult();
      clearAttachments();
    }
    unbindOutsidePointer();
    inputEl?.blur?.();
    if (wasOpen) notifyOpenStateChange();
    return true;
  };

  const enqueueSubmission = (text, attachments, { preserveDraft = false, ...controls } = {}) => {
    if (!text && !attachments.length) return false;
    clearCloseTimer();
    restoreResultOnNextOpen = false;
    const wasQueued = isSubmitting || Boolean(activeSubmission);
    if (!wasQueued) clearResult();
    submissionSeq += 1;
    let resolveSubmission = null;
    const completion = new Promise(resolve => {
      resolveSubmission = resolve;
    });
    const entry = {
      id: controls.id || `maid_submission_${submissionSeq}`,
      controls,
      text: text || getLocalizedPromptText('maid.image_only_input', '请看这张图片。'),
      attachments,
      wasQueued,
      resolve: resolveSubmission,
    };
    queuedSubmissions.push(entry);
    if (inputEl && !preserveDraft) {
      inputEl.value = '';
      clearAttachments();
      resizeInput();
    }
    if (wasQueued) showQueuedSubmission(entry);
    else void processSubmissionQueue();
    return completion;
  };
  const submit = () => {
    const text = trim(inputEl?.value), attachments = imageAttachments.slice();
    if (!text && !attachments.length) return false;
    if (getVoiceState?.().call && getVoiceState().call !== 'idle' && onVoiceTextSubmit) {
      return onVoiceTextSubmit(text || getLocalizedPromptText('maid.image_only_input', '请看这张图片。'), attachments);
    }
    return enqueueSubmission(text, attachments);
  };

  const setSelectionState = ({ active = false, count = 0 } = {}) => {
    if (!selectionBtn) return;
    selectionBtn.classList.toggle('is-active', Boolean(active));
    selectionBtn.classList.toggle('has-items', Number(count) > 0);
    const countEl = selectionBtn.querySelector?.('.maid-command-input-selection-count');
    if (countEl) countEl.textContent = String(count || '');
  };

  return {
    syncVoiceState: () => voiceButton?.sync(),
    setSelectionState,
    open,
    close,
    submit,
    collapse: () => close({ preserve: true }),
    submitVoiceTask: (text, options = {}) => {
      if (options.showInput !== false) open({ autoFocus: false });
      else ensure();
      return enqueueSubmission(trim(text), options.attachments || [], { preserveDraft: true, ...options });
    },
    cancelSubmission: id => {
      if (cancelQueued(id)) return true;
      if (activeSubmission?.id !== id || !activeAbortController || activeAbortController.signal.aborted) return false;
      activeAbortController.abort(new DOMException('Maid task stopped by user', 'AbortError'));
      return true;
    },
    position,
    setStatus: (message = '', tone = 'info') => setResult(message, tone),
    applyTraceView,
    addFiles,
    clearAttachments,
    getAttachments: () => imageAttachments.slice(),
    getResultMessages: () => resultMessages.map(item => ({ ...item })),
    getLiveStatus: () => (liveStatus ? { ...liveStatus } : null),
    getQueue: () => queuedSubmissions.map(publicSubmission),
    getActiveSubmission: () => publicSubmission(activeSubmission),
    cancelQueued,
    cancelActive,
    isOpen: () => isOpen,
    isSubmitting: () => isSubmitting,
    getElements: () => ({ rootEl, inputEl, attachBtn, fileInputEl, attachmentsEl, settingsBtn, submitBtn, resultEl }),
  };
};
