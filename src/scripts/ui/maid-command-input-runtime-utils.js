import {
  collectImageFilesFromDropEvent,
  collectImageFilesFromPasteEvent,
  eventHasImageFiles,
} from './image-attachment-input-utils.js';

import { renderMaidMarkdownHtml } from './maid-markdown-utils.js';
import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { bindMaidVoiceButton } from './maid-voice-button.js';
import { t } from '../i18n/index.js';
import { maidSkillMessage } from './maid-skill-messages.js';
import { createMaidRunCardView, MAID_RUN_ICONS } from './maid-run-card-dom.js';

const STYLE_ID = 'maid-command-input-runtime-style';
const FIELD_MIN_HEIGHT = 32;
const FIELD_MAX_HEIGHT = 76;
const DEFAULT_MAX_IMAGE_ATTACHMENTS = 4;
const SHEET_MEDIA_QUERY = '(max-width: 760px) and (pointer: coarse)';
const SHEET_SNAPS = Object.freeze(['peek', 'half', 'full']);
const REPORT_TONES = new Set(['success', 'error', 'info']);

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
    if (typeof node.closest === 'function' && node.closest('.app-confirm-overlay, .app-confirm-modal, .maid-guide-step-bubble, .maid-spotlight-root, .maid-skill-dialog')) {
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
  border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.42);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.20), 0 0 0 3px rgba(var(--app-accent-rgb, 37, 99, 235), 0.12);
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
/* 提交中只淡化输入框：结果流是胶囊的子元素，整体降透明度会让运行卡透出底下的页面 */
.maid-command-input.is-open.is-submitting .maid-command-input-field {
  opacity: 0.72;
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
  border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.45);
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.14);
  color: var(--app-accent-strong, #1d4ed8);
}
.maid-command-input-selection-count {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--app-accent-primary, #2563eb);
  color: var(--app-text-on-accent, #fff);
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
  background: var(--app-accent-primary, #2563eb);
  color: var(--app-text-on-accent, #fff);
}
.maid-command-input-selection:hover,
.maid-command-input-attach:hover,
.maid-command-input-settings:hover {
  background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.10);
  color: var(--app-accent-primary, #2563eb);
}
.maid-command-input-submit:hover {
  background: var(--app-accent-strong, #1d4ed8);
}
.maid-command-input.is-submitting .maid-command-input-submit {
  background: rgb(var(--app-danger-rgb, 220, 38, 38));
}
.maid-command-input.is-submitting .maid-command-input-submit:hover {
  background: color-mix(in srgb, rgb(var(--app-danger-rgb, 220, 38, 38)) 86%, #000);
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
  outline: 2px solid rgba(var(--app-accent-rgb, 37, 99, 235), 0.32);
  outline-offset: 2px;
}
.maid-command-input:focus-within {
  border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.38);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.20), 0 0 0 2px rgba(var(--app-accent-rgb, 37, 99, 235), 0.10);
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
  max-height: min(60vh, 480px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px;
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
  overscroll-behavior: contain;
}
.maid-command-input-result-item {
  flex: 0 0 auto;
  max-width: 100%;
  min-height: 38px;
  padding: 9px 12px;
  box-sizing: border-box;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.30));
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
  box-shadow: var(--app-shadow-sm, 0 1px 4px rgba(15, 23, 42, 0.08));
}
.maid-command-input-result-item[data-tone="error"] {
  border-color: rgba(var(--app-danger-rgb, 220, 38, 38), 0.32);
}
/* 运行卡外壳：卡片自带边框与阴影 */
.maid-command-input-result-item.is-run {
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
/* 新项逐个推出（进场用 backwards 配合逐项 delay） */
.maid-command-input-result-item.is-entering {
  animation: mciCardIn 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
}
@keyframes mciCardIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
/* 女仆汇报：最终结果、提问与需要处理的提示，始终显示 */
.mci-report-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 11px;
  line-height: 1;
  color: var(--app-text-muted, rgba(100, 116, 139, 0.85));
  white-space: nowrap;
}
.mci-report-mark {
  width: 17px;
  height: 17px;
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(var(--app-accent-rgb, 59, 130, 246), 0.12);
  color: var(--app-text-primary, #111827);
  font-family: Georgia, 'Songti SC', 'Noto Serif SC', serif;
  font-size: 10.5px;
  font-weight: 700;
}
.maid-command-input-result-item[data-tone="error"] .mci-report-mark {
  background: rgba(var(--app-danger-rgb, 220, 38, 38), 0.14);
}
.maid-command-input-result-item.is-queue {
  color: var(--app-text-secondary, #475569);
  border-style: dashed;
  box-shadow: none;
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
/* 未落到运行卡里的思路（纯对话回复等）：默认折叠的一行 */
.maid-command-input-result-item.is-thought {
  min-height: 0;
  padding: 0;
  box-shadow: none;
  background: transparent;
  border-style: dashed;
}
.mci-thought-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--app-text-muted, rgba(100, 116, 139, 0.85));
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.mci-thought-toggle svg { width: 11px; height: 11px; flex: 0 0 auto; }
.mci-thought-list {
  margin: 0 12px 10px 18px;
  padding: 0 0 0 13px;
  border-left: 1px solid var(--app-border-subtle, rgba(15, 23, 42, 0.08));
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--app-text-secondary, #475569);
}
/* 过程提示单行：像素网格 + 光泽文字，原位替换 */
.maid-command-input-result-item.mci-live-row {
  display: flex;
  align-items: center;
  gap: 9px;
  align-self: flex-start;
  width: fit-content;
  max-width: 100%;
  min-height: 0;
  padding: 6px 12px 6px 9px;
  border-style: dashed;
  border-radius: 999px;
  box-shadow: none;
  background: color-mix(in srgb, var(--app-surface-card, #fff) 70%, transparent);
}
.mci-live-row .mrc-shimmer { font-size: 12px; }
/* 手机：底部抽屉（预览 / 半屏 / 全屏），输入胶囊固定在抽屉底部 */
.mci-sheet-handle { display: none; }
.maid-command-input[data-layout="sheet"] {
  left: 0 !important;
  right: 0;
  top: auto !important;
  bottom: var(--mci-keyboard-offset, 0px);
  width: auto !important;
  min-height: 56px;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
  border-width: 1px 0 0;
  border-radius: 0;
  box-shadow: none;
  transform: translateY(12px);
  transform-origin: bottom center;
}
.maid-command-input[data-layout="sheet"].is-open { transform: none; }
.maid-command-input[data-layout="sheet"].has-attachments { border-radius: 0; }
.maid-command-input[data-layout="sheet"] .maid-command-input-drag { display: none; }
.maid-command-input[data-layout="sheet"] .maid-command-input-result {
  left: 0;
  right: 0;
  top: auto;
  bottom: 100%;
  width: 100%;
  padding: 0 10px 10px;
  border-radius: 22px 22px 0 0;
  background: var(--app-surface-card, #fff);
  box-shadow: 0 -10px 30px rgba(15, 23, 42, 0.14);
  transition: max-height 0.26s cubic-bezier(0.23, 1, 0.32, 1);
}
.maid-command-input[data-layout="sheet"][data-snap="peek"] .maid-command-input-result { max-height: 176px; }
.maid-command-input[data-layout="sheet"][data-snap="half"] .maid-command-input-result { max-height: 52dvh; }
.maid-command-input[data-layout="sheet"][data-snap="full"] .maid-command-input-result {
  max-height: calc(100dvh - 88px - env(safe-area-inset-top, 0px) - var(--mci-keyboard-offset, 0px));
}
.maid-command-input[data-layout="sheet"] .mci-sheet-handle {
  position: sticky;
  top: 0;
  z-index: 1;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: calc(100% + 20px);
  height: 26px;
  margin: 0 -10px;
  padding: 0;
  border: 0;
  background: var(--app-surface-card, #fff);
  cursor: grab;
  touch-action: none;
}
.mci-sheet-handle > i {
  width: 38px;
  height: 5px;
  border-radius: 3px;
  background: var(--app-border-strong, rgba(15, 23, 42, 0.16));
}
.maid-command-input[data-layout="sheet"] .maid-command-input-result-item { box-shadow: none; }
.maid-command-input[data-layout="sheet"] .mrc { box-shadow: none; }
/* 预览档只看最新一项；运行卡只留头部与进行中一行 */
.maid-command-input[data-layout="sheet"][data-snap="peek"] .maid-command-input-result > [data-key]:not(:last-of-type) { display: none; }
.maid-command-input[data-layout="sheet"][data-snap="peek"] .mrc-rows,
.maid-command-input[data-layout="sheet"][data-snap="peek"] .mrc-thought { display: none; }
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
  .maid-command-input-result-item.is-entering {
    animation: none !important;
  }
  .maid-command-input[data-layout="sheet"] .maid-command-input-result {
    transition: none;
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
  prepareSubmission = null,
  mountSkills = null,
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
  // 手机布局判定与键盘避让；卡内确认的数据与回调
  matchMediaFn = null,
  windowLike = null,
  setIntervalFn = null,
  clearIntervalFn = null,
  getApproval = () => null,
  onApprovalDecision = null,
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
  let liveStatus = null; // 写死的过程提示（progress）：单行原位替换；有运行卡时并入卡内
  const runCards = new Map(); // runId → 运行卡视图
  const runThoughts = new Map(); // runId → 女仆过程叙述（思路，默认折叠）
  let pendingThoughts = []; // 当前提交尚未绑定 run 时的叙述
  let layout = 'float';
  let sheetSnap = 'half';
  let sheetSnapTouched = false;
  let sheetHandleEl = null;
  let keyboardListenerBound = false;
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

  const activeRunView = () => {
    const runId = trim(activeRunId);
    if (!runId) return null;
    return resultMessages.find(item => item.kind === 'run' && item.runId === runId) || null;
  };

  const latestRunState = () => {
    for (let index = resultMessages.length - 1; index >= 0; index -= 1) {
      const item = resultMessages[index];
      if (item.kind === 'run') return trim(item.view?.status, 'running');
    }
    return '';
  };

  // 手机抽屉：执行中默认预览，等你确认/失败/结束升到半屏；用户拖动或展开详情后以用户为准
  const resolveAutoSnap = () => {
    const status = latestRunState();
    if (['running', 'queued'].includes(status) && activeRunView()) return 'peek';
    return 'half';
  };

  const applySheetSnap = () => {
    if (!rootEl) return;
    if (layout !== 'sheet') {
      delete rootEl.dataset.snap;
      return;
    }
    if (!sheetSnapTouched) sheetSnap = resolveAutoSnap();
    rootEl.dataset.snap = sheetSnap;
    sheetHandleEl?.setAttribute?.('aria-label', t('调整女仆面板高度（{snap}）', {
      snap: { peek: t('预览'), half: t('半屏'), full: t('全屏') }[sheetSnap] || '',
    }));
  };

  const setSheetSnap = (snap, { touched = true } = {}) => {
    if (!SHEET_SNAPS.includes(snap)) return;
    sheetSnap = snap;
    if (touched) sheetSnapTouched = true;
    applySheetSnap();
  };

  const ensureSheetHandle = () => {
    if (sheetHandleEl || !documentRef?.createElement) return sheetHandleEl;
    sheetHandleEl = documentRef.createElement('button');
    sheetHandleEl.type = 'button';
    sheetHandleEl.className = 'mci-sheet-handle';
    sheetHandleEl.dataset.mciHandle = '1';
    sheetHandleEl.innerHTML = '<i></i>';
    let dragStartY = null;
    let dragged = false;
    sheetHandleEl.addEventListener?.('pointerdown', (event) => {
      dragStartY = Number(event?.clientY);
      dragged = false;
      try { sheetHandleEl.setPointerCapture?.(event.pointerId); } catch {}
    });
    sheetHandleEl.addEventListener?.('pointermove', (event) => {
      if (dragStartY == null || !Number.isFinite(dragStartY)) return;
      if (Math.abs(Number(event?.clientY) - dragStartY) > 8) dragged = true;
    });
    const endDrag = (event) => {
      if (dragStartY == null) return;
      const delta = Number(event?.clientY) - dragStartY;
      dragStartY = null;
      if (!dragged || !Number.isFinite(delta)) return;
      const index = SHEET_SNAPS.indexOf(sheetSnap);
      if (delta < -24) setSheetSnap(SHEET_SNAPS[Math.min(SHEET_SNAPS.length - 1, index + 1)]);
      else if (delta > 24) {
        if (index <= 0) close({ preserve: true });
        else setSheetSnap(SHEET_SNAPS[index - 1]);
      }
    };
    sheetHandleEl.addEventListener?.('pointerup', endDrag);
    sheetHandleEl.addEventListener?.('pointercancel', () => { dragStartY = null; });
    sheetHandleEl.addEventListener?.('click', (event) => {
      event?.preventDefault?.();
      if (dragged) {
        dragged = false;
        return;
      }
      const index = SHEET_SNAPS.indexOf(sheetSnap);
      setSheetSnap(SHEET_SNAPS[(index + 1) % SHEET_SNAPS.length]);
    });
    return sheetHandleEl;
  };

  const ensureRunCard = (runId) => {
    let card = runCards.get(runId);
    if (card) return card;
    card = createMaidRunCardView({
      documentRef,
      onStop: ({ runId: target } = {}) => cancelActive({ runId: target }),
      onDecision: payload => onApprovalDecision?.(payload),
      onLayoutChange: ({ reason, expanded } = {}) => {
        if (layout === 'sheet' && reason === 'row' && expanded) setSheetSnap('full');
      },
      setIntervalFn,
      clearIntervalFn,
    });
    if (card) runCards.set(runId, card);
    return card;
  };

  const renderResultMessages = ({ forceBottom = false } = {}) => {
    if (!rootEl || !documentRef) return;
    if (!resultMessages.length && !liveStatus) {
      resultEl?.remove?.();
      resultEl = null;
      rootEl.classList.remove('has-result');
      applySheetSnap();
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
    if (layout === 'sheet') {
      const handle = ensureSheetHandle();
      if (handle && handle.parentNode !== resultEl) resultEl.insertBefore?.(handle, resultEl.firstChild || null) || resultEl.appendChild(handle);
    } else if (sheetHandleEl?.parentNode) {
      sheetHandleEl.remove?.();
    }
    const liveRun = activeRunView();
    const buildResultItemContent = (bubble, item) => {
      const entering = bubble.classList?.contains?.('is-entering') ? ' is-entering' : '';
      if (item.kind === 'run') {
        bubble.className = `maid-command-input-result-item is-run${entering}`;
        const card = ensureRunCard(item.runId);
        if (!card) return;
        if (card.el.parentNode !== bubble) {
          bubble.innerHTML = '';
          bubble.appendChild(card.el);
        }
        card.update(item.view, {
          thoughts: runThoughts.get(item.runId) || [],
          liveText: liveRun === item && liveStatus ? liveStatus.message : '',
          approval: getApproval?.(item.runId) || null,
          voice: item.view?.source === 'maid_realtime',
          touch: layout === 'sheet',
        });
        return;
      }
      bubble.innerHTML = '';
      if (item.kind === 'thought') {
        bubble.className = `maid-command-input-result-item is-thought${entering}`;
        const toggle = documentRef.createElement?.('button');
        toggle.type = 'button';
        toggle.className = 'mci-thought-toggle';
        toggle.setAttribute?.('aria-expanded', item.open ? 'true' : 'false');
        toggle.innerHTML = `${MAID_RUN_ICONS.spark}<span></span>`;
        const label = toggle.querySelector?.('span');
        if (label) label.textContent = t('思路 · {count}', { count: item.lines.length });
        toggle.addEventListener?.('click', (event) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          item.open = !item.open;
          renderResultMessages({ forceBottom: false });
        });
        bubble.appendChild(toggle);
        if (item.open) {
          const list = documentRef.createElement?.('ol');
          list.className = 'mci-thought-list';
          item.lines.forEach((line) => {
            const li = documentRef.createElement?.('li');
            li.textContent = line;
            list.appendChild(li);
          });
          bubble.appendChild(list);
        }
        return;
      }
      const isReport = item.kind !== 'queue' && REPORT_TONES.has(item.tone);
      bubble.className = `maid-command-input-result-item${isReport ? ' is-report' : ''}${item.kind === 'queue' ? ' is-queue' : ''}${entering}`;
      bubble.dataset.tone = item.tone;
      if (isReport) {
        const head = documentRef.createElement?.('div');
        head.className = 'mci-report-head';
        const mark = documentRef.createElement?.('span');
        mark.className = 'mci-report-mark';
        mark.textContent = '侍';
        mark.setAttribute?.('aria-hidden', 'true');
        const name = documentRef.createElement?.('span');
        name.textContent = t('女仆');
        head.appendChild(mark);
        head.appendChild(name);
        bubble.appendChild(head);
      }
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
    };
    // 键控 reconcile：既有项原位补丁（状态原地翻转、不重播进场），新项逐个推出（stagger 进场）
    const existingNodes = new Map();
    Array.from(resultEl.children || []).forEach((node) => {
      const key = node?.dataset?.key;
      if (key) existingNodes.set(key, node);
      else if (!node?.dataset?.mciLive && !node?.dataset?.mciHandle) node.remove?.();
    });
    // 单次渲染取一次时钟：同批新项的节拍必须相对同一基准
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
      // 跨渲染节拍：同批与快速连发的事件都一个一个推出
      const delayMs = Math.min(1200, Math.max(0, resultEnterPaceUntil - renderNowTs));
      resultEnterPaceUntil = Math.max(renderNowTs, resultEnterPaceUntil) + 150;
      if (node.style) node.style.animationDelay = `${delayMs}ms`;
      node.addEventListener?.('animationend', (event) => {
        if (event?.target && event.target !== node) return;
        node.classList?.remove?.('is-entering');
        if (node.style) node.style.animationDelay = '';
      });
      buildResultItemContent(node, item);
      resultEl.appendChild(node);
    });
    existingNodes.forEach((node) => {
      const runId = trim(node?.dataset?.key).startsWith('run:') ? trim(node.dataset.key).slice(4) : '';
      if (runId) {
        runCards.get(runId)?.destroy?.();
        runCards.delete(runId);
      }
      node.remove?.();
    });
    // 过程提示行：有进行中的运行卡时并入卡内，否则常驻底部单行（文本原位替换）
    let liveEl = Array.from(resultEl.children || []).find(node => node?.dataset?.mciLive) || null;
    if (liveStatus && !liveRun) {
      if (!liveEl) {
        liveEl = documentRef.createElement?.('div');
        if (liveEl) {
          liveEl.dataset.mciLive = '1';
          liveEl.className = 'maid-command-input-result-item mci-live-row';
          liveEl.innerHTML = `<span class="mrc-grid" aria-hidden="true">${[0, 90, 180, 90, 180, 270, 180, 270, 360].map(delay => `<i style="animation-delay:${delay}ms"></i>`).join('')}</span><span class="mrc-shimmer mci-live-text"></span>`;
        }
      }
      if (liveEl) {
        const textEl = liveEl.querySelector?.('.mci-live-text') || null;
        if (textEl) textEl.textContent = liveStatus.message;
        liveEl.dataset.message = liveStatus.message;
        resultEl.appendChild(liveEl);
      }
    } else if (liveEl) {
      liveEl.remove?.();
    }
    const latest = resultMessages[resultMessages.length - 1] || {};
    resultEl.dataset.tone = latest.tone || 'info';
    resultEl.dataset.count = String(resultMessages.length);
    applySheetSnap();
    if (keepBottom) scrollResultToBottom();
    else resultEl.scrollTop = previousScrollTop;
  };

  const clearResult = () => {
    resultMessages = [];
    liveStatus = null;
    restoreResultOnNextOpen = false;
    runThoughts.clear();
    pendingThoughts = [];
    sheetSnapTouched = false;
    renderResultMessages();
  };

  // 女仆叙述里的“过程”（thinking）并入运行卡的思路；没有 run 时在提交结束后收成一行折叠
  const appendThought = (text) => {
    const runId = trim(activeRunId);
    if (runId && resultMessages.some(item => item.kind === 'run' && item.runId === runId)) {
      runThoughts.set(runId, [...(runThoughts.get(runId) || []), text]);
      return;
    }
    pendingThoughts.push(text);
  };

  const flushPendingThoughts = () => {
    if (!pendingThoughts.length) return;
    resultSeq += 1;
    resultMessages.push({ id: `thought_${resultSeq}`, kind: 'thought', lines: pendingThoughts.slice(), open: false });
    pendingThoughts = [];
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
    // 写死的过程提示（progress）不各占气泡：单行原位替换，有运行卡时进卡内。
    if (normalizedTone === 'progress') {
      liveStatus = { message: text };
      renderResultMessages({ forceBottom: options?.forceBottom !== false });
      return;
    }
    // 执行中的女仆叙述属于过程，默认折叠进“思路”
    if (normalizedTone === 'thinking' && activeSubmission) {
      appendThought(text);
      renderResultMessages({ forceBottom: options?.forceBottom !== false });
      return;
    }
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

  const upsertResultItem = (id, payload = {}) => {
    const index = resultMessages.findIndex(item => item.id === id);
    if (index >= 0) resultMessages[index] = { ...resultMessages[index], ...payload, id };
    else resultMessages.push({ ...payload, id });
  };

  /* 女仆执行流投影：一次任务一张运行卡，按 runId 原位更新、与汇报气泡按时间交错。
     返回 true 表示指令条已承载女仆流（执行流面板据此不再自开，避免双流）。 */
  const applyTraceView = (view = null) => {
    if (!view || !trim(view.runId)) return false;
    const runId = trim(view.runId);
    if (activeSubmission && view.terminal !== true) activeRunId = runId;
    if (!rootEl || !isOpen) return false; // 从未打开或已经关闭 → 交回执行流面板兜底
    if (activeSubmission && activeRunId === runId && pendingThoughts.length) {
      runThoughts.set(runId, [...(runThoughts.get(runId) || []), ...pendingThoughts]);
      pendingThoughts = [];
    }
    upsertResultItem(`run:${runId}`, { kind: 'run', runId, view });
    if (view.terminal) liveStatus = null; // run 终态：过程提示退场
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
          flushPendingThoughts();
          setResult(
            result?.message || result?.summary || (ok ? '已完成。' : '执行失败。'),
            cancelled ? 'info' : (ok ? 'success' : 'error'),
            { actions: result?.actions },
          );
          entry.resolve(result || { ok });
        } catch (error) {
          const cancelled = error?.name === 'AbortError' || submissionAbortController.signal.aborted;
          flushPendingThoughts();
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

  const resolveLayout = () => {
    try {
      return typeof matchMediaFn === 'function' && matchMediaFn(SHEET_MEDIA_QUERY)?.matches === true ? 'sheet' : 'float';
    } catch {
      return 'float';
    }
  };

  // 手机抽屉贴底：软键盘弹出且布局视口未随之缩小时，用 visualViewport 算出遮挡高度
  const syncKeyboardOffset = () => {
    if (!rootEl) return;
    const viewport = windowLike?.visualViewport;
    const innerHeight = Number(windowLike?.innerHeight || 0);
    const covered = viewport && innerHeight
      ? Math.max(0, Math.round(innerHeight - (Number(viewport.height || 0) + Number(viewport.offsetTop || 0))))
      : 0;
    rootEl.style?.setProperty?.('--mci-keyboard-offset', `${covered}px`);
  };

  const bindKeyboardListener = () => {
    if (keyboardListenerBound || !windowLike?.visualViewport?.addEventListener) return;
    keyboardListenerBound = true;
    windowLike.visualViewport.addEventListener('resize', syncKeyboardOffset);
    windowLike.visualViewport.addEventListener('scroll', syncKeyboardOffset);
  };

  const position = () => {
    if (!rootEl) return;
    const nextLayout = resolveLayout();
    if (nextLayout !== layout) {
      layout = nextLayout;
      rootEl.dataset.layout = layout;
      if (resultEl) renderResultMessages({ forceBottom: false }); // 运行卡的触控尺寸随布局切换
    }
    rootEl.dataset.layout = layout;
    if (layout === 'sheet') {
      rootEl.style.width = '';
      rootEl.style.left = '';
      rootEl.style.top = '';
      delete rootEl.dataset.bubbleSide;
      bindKeyboardListener();
      syncKeyboardOffset();
      applySheetSnap();
      return;
    }
    applySheetSnap();
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
    mountSkills?.(rootEl, settingsBtn);
    // 指令条以球心定位、整体盖住悬浮球：非交互区/拖柄按下即转发球拖拽；
    // 输入、附件、设置、发送等控件保持各自交互。
    rootEl.addEventListener?.('pointerdown', (event) => {
      const target = event?.target || null;
      const interactive = typeof target?.closest === 'function'
        ? target.closest('textarea:not(:disabled), button:not(:disabled), input, a, .maid-command-input-result, .maid-onboarding-welcome')
        : null;
      if (interactive || layout === 'sheet') return;
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

  const enqueuePreparedSubmission = (text, attachments, { preserveDraft = false, ...controls } = {}) => {
    if (!text && !attachments.length) return false;
    clearCloseTimer();
    restoreResultOnNextOpen = false;
    const wasQueued = isSubmitting || Boolean(activeSubmission);
    if (!wasQueued) clearResult();
    sheetSnapTouched = false;
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
    controls.onAccepted?.();
    const draftAttachments = controls.draftAttachments || attachments;
    if (inputEl && !preserveDraft && (!controls.skillsPrepared ||
      (trim(inputEl.value) === text || !trim(inputEl.value) && draftAttachments.length > 0) && imageAttachments.length === draftAttachments.length && imageAttachments.every((item, index) => item === draftAttachments[index] || (item.id || item.url || item.llmUrl) === (draftAttachments[index].id || draftAttachments[index].url || draftAttachments[index].llmUrl)))) {
      inputEl.value = '';
      clearAttachments();
      resizeInput();
    }
    if (wasQueued) showQueuedSubmission(entry);
    else void processSubmissionQueue();
    return completion;
  };
  let preparingSubmission = false;
  const enqueueSubmission = (text, attachments, controls = {}) => {
    if (!prepareSubmission || controls.skillsPrepared) return enqueuePreparedSubmission(text, attachments, controls);
    if (!text && !attachments.length) return false;
    if (preparingSubmission) return false;
    preparingSubmission = true;
    return Promise.resolve().then(() => prepareSubmission(text, attachments, controls)).then(prepared => {
      preparingSubmission = false;
      return enqueuePreparedSubmission(text, prepared.attachments || attachments, prepared);
    }, error => {
      preparingSubmission = false;
      const message = maidSkillMessage(error);
      setResult(message, 'error');
      return { ok: false, status: 'failed', reason: error?.code, message };
    });
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
    submitTask: (text, options = {}) => {
      open({ autoFocus: false });
      return enqueueSubmission(trim(text), options.attachments || [], { preserveDraft: true, ...options });
    },
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
    // 卡内确认：该 run 的运行卡正在输入胶囊里显示时才算可承载
    hasRunCard: runId => Boolean(isOpen && trim(runId) && resultMessages.some(item => item.kind === 'run' && item.runId === trim(runId))),
    refreshApprovals: () => {
      if (isOpen && resultMessages.some(item => item.kind === 'run')) renderResultMessages({ forceBottom: false });
    },
    getLayout: () => ({ layout, snap: layout === 'sheet' ? sheetSnap : '' }),
    setSheetSnap,
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
