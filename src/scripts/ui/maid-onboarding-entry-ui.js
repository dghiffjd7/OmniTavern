import { applyMaidGuideExpression } from './maid-guide-expression-utils.js';

const STYLE_ID = 'maid-onboarding-entry-ui-style';

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.maid-onboarding-hint,
.maid-onboarding-toast,
.maid-onboarding-welcome {
  box-sizing: border-box;
  border: 1px solid var(--app-border-subtle, rgba(148,163,184,.24));
  background: var(--app-surface-card, #fff);
  color: var(--app-text-primary, #111827);
  box-shadow: 0 22px 54px -25px rgba(15,23,42,.46);
}
.maid-onboarding-hint,
.maid-onboarding-toast { position: fixed; z-index: 25020; }
.maid-onboarding-hint {
  right: max(18px, env(safe-area-inset-right, 0px));
  bottom: calc(86px + env(safe-area-inset-bottom, 0px));
  width: min(344px, calc(100vw - 28px));
  display: grid;
  grid-template-columns: 50px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 10px;
  padding: 10px 8px 10px 10px;
  border-radius: 20px;
  animation: maid-onboarding-entry-in 360ms cubic-bezier(.22,1,.36,1) both;
}
.maid-onboarding-hint[data-placement] { right: auto; bottom: auto; }
.maid-onboarding-hint[data-placement]::after {
  content: '';
  position: absolute;
  left: var(--maid-hint-arrow-left, 50%);
  width: 12px;
  height: 12px;
  border: inherit;
  border-width: 0 1px 1px 0;
  background: inherit;
  transform: translateX(-50%) rotate(45deg);
}
.maid-onboarding-hint[data-placement='above']::after { bottom: -7px; }
.maid-onboarding-hint[data-placement='below']::after { top: -7px; transform: translateX(-50%) rotate(225deg); }
.maid-onboarding-hint-avatar,
.maid-onboarding-toast-icon {
  display: block;
  flex: 0 0 auto;
  overflow: hidden;
  background-color: var(--app-surface-subtle, #f8fafc);
}
.maid-onboarding-hint-avatar {
  width: 50px;
  height: 50px;
  border: 2px solid color-mix(in srgb, var(--app-accent-secondary, #db2777) 24%, transparent);
  border-radius: 15px;
}
.maid-onboarding-hint-copy { min-width: 0; }
.maid-onboarding-hint-title { font-size: 12.5px; font-weight: 850; line-height: 1.35; }
.maid-onboarding-hint-sub { margin-top: 2px; color: var(--app-text-secondary, #64748b); font-size: 10.5px; line-height: 1.4; }
.maid-onboarding-hint-gesture {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 9%, transparent);
  color: var(--app-accent-primary, #2563eb);
  font-size: 9.5px;
  font-weight: 800;
  animation: maid-onboarding-hold-pulse 980ms ease-out 2;
}
.maid-onboarding-hint-gesture svg { width: 12px; height: 12px; }
.maid-onboarding-hint-close,
.maid-onboarding-toast-action,
.maid-onboarding-toast-close,
.maid-onboarding-welcome-close,
.maid-onboarding-welcome-task,
.maid-onboarding-welcome-all {
  border: 0;
  cursor: pointer;
  font: inherit;
  touch-action: manipulation;
}
.maid-onboarding-hint-close,
.maid-onboarding-toast-close,
.maid-onboarding-welcome-close {
  width: 40px;
  height: 40px;
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  background: transparent;
  color: var(--app-text-muted, #64748b);
  font-size: 18px;
}
.maid-onboarding-welcome {
  position: absolute;
  z-index: 6;
  left: 50%;
  right: auto;
  width: min(420px, calc(100vw - 24px));
  max-height: min(var(--maid-welcome-max-height, 480px), 68dvh);
  margin-inline: 0;
  translate: -50% 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  border-radius: 24px;
  contain: layout paint;
  transform-origin: top center;
  animation: maid-onboarding-welcome-in 340ms cubic-bezier(.22,1,.36,1) both;
}
.maid-command-input[data-welcome-side='bottom'] .maid-onboarding-welcome { top: calc(100% + 10px); transform-origin: top center; }
.maid-command-input[data-welcome-side='top'] .maid-onboarding-welcome { bottom: calc(100% + 10px); transform-origin: bottom center; }
.maid-command-input.has-result .maid-onboarding-welcome {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
.maid-onboarding-welcome-head {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 10px;
  padding: 13px 11px 12px 13px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border-subtle, rgba(148,163,184,.22)) 72%, transparent);
  background: color-mix(in srgb, var(--app-surface-card, #fff) 97%, var(--app-accent-secondary, #db2777));
}
.maid-onboarding-welcome-avatar-wrap {
  position: relative;
  width: 52px;
  height: 52px;
}
.maid-onboarding-welcome-avatar {
  width: 52px;
  height: 52px;
  display: block;
  overflow: hidden;
  border: 2px solid color-mix(in srgb, var(--app-accent-secondary, #db2777) 26%, transparent);
  border-radius: 16px;
  background-color: var(--app-surface-subtle, #f8fafc);
  box-shadow: 0 10px 24px -16px color-mix(in srgb, var(--app-accent-secondary, #db2777) 60%, transparent);
}
.maid-onboarding-welcome-avatar-status {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 11px;
  height: 11px;
  box-sizing: border-box;
  border: 2px solid var(--app-surface-card, #fff);
  border-radius: 50%;
  background: var(--app-success-text, #047857);
}
.maid-onboarding-welcome-copy { min-width: 0; }
.maid-onboarding-welcome-kicker {
  color: var(--app-accent-primary, #2563eb);
  font-size: 9.5px;
  font-weight: 850;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.maid-onboarding-welcome-title { margin-top: 2px; font-size: 13.5px; font-weight: 900; line-height: 1.3; }
.maid-onboarding-welcome-sub { margin-top: 3px; color: var(--app-text-secondary, #64748b); font-size: 10.5px; line-height: 1.45; }
.maid-onboarding-welcome-section { padding: 12px 14px 8px; }
.maid-onboarding-welcome-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 7px;
}
.maid-onboarding-welcome-section-title { color: var(--app-text-secondary, #475569); font-size: 11.5px; font-weight: 850; }
.maid-onboarding-welcome-progress {
  color: var(--app-accent-primary, #2563eb);
  font-size: 10.5px;
  font-weight: 850;
  font-variant-numeric: tabular-nums;
}
.maid-onboarding-welcome-progress-track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, var(--app-surface-subtle, #f8fafc));
}
.maid-onboarding-welcome-progress-bar {
  width: var(--maid-welcome-progress, 0%);
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--app-accent-primary, #2563eb) 58%, var(--app-surface-card, #fff)), var(--app-accent-primary, #2563eb), var(--app-accent-secondary, #db2777));
  transform-origin: left center;
  animation: maid-onboarding-progress-in 420ms 90ms cubic-bezier(.22,1,.36,1) backwards;
}
.maid-onboarding-welcome-list { display: grid; gap: 8px; margin-top: 10px; }
.maid-onboarding-welcome-task {
  width: 100%;
  min-height: 68px;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--app-border-subtle, rgba(148,163,184,.22)) 80%, transparent);
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
  color: var(--app-text-primary, #111827);
  box-shadow: 0 3px 10px -9px rgba(15,23,42,.32);
  text-align: left;
  transition: transform 180ms cubic-bezier(.22,1,.36,1), border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
  animation: maid-onboarding-task-in 300ms calc(var(--maid-task-index, 0) * 45ms) cubic-bezier(.22,1,.36,1) backwards;
}
.maid-onboarding-welcome-task:disabled { cursor: default; }
.maid-onboarding-welcome-task-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 9%, var(--app-surface-card, #fff));
  color: var(--app-accent-primary, #2563eb);
}
.maid-onboarding-welcome-task-icon svg { width: 17px; height: 17px; }
.maid-onboarding-welcome-task-main { min-width: 0; display: grid; gap: 4px; }
.maid-onboarding-welcome-task-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.maid-onboarding-welcome-task-title { display: block; overflow: hidden; font-size: 12.5px; font-weight: 850; text-overflow: ellipsis; white-space: nowrap; }
.maid-onboarding-welcome-task-reward {
  max-width: 112px;
  overflow: hidden;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted, #64748b) 8%, var(--app-surface-subtle, #f8fafc));
  color: var(--app-text-muted, #64748b);
  font-size: 9.5px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.maid-onboarding-welcome-task-description { display: block; overflow: hidden; color: var(--app-text-muted, #64748b); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.maid-onboarding-welcome-task-action {
  min-width: 66px;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  box-sizing: border-box;
  padding: 0 11px;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--app-accent-primary, #2563eb), var(--app-accent-secondary, #7c3aed));
  color: var(--app-text-inverse, #fff);
  box-shadow: 0 10px 18px -13px color-mix(in srgb, var(--app-accent-primary, #2563eb) 74%, transparent);
  font-size: 10.5px;
  font-weight: 850;
  white-space: nowrap;
}
.maid-onboarding-welcome-task-action svg { width: 14px; height: 14px; }
.maid-onboarding-welcome-task.is-done {
  border-color: color-mix(in srgb, var(--app-success-text, #047857) 22%, var(--app-border-subtle, rgba(148,163,184,.22)));
  background: color-mix(in srgb, var(--app-success-text, #047857) 5%, var(--app-surface-card, #fff));
}
.maid-onboarding-welcome-task.is-done .maid-onboarding-welcome-task-icon { background: color-mix(in srgb, var(--app-success-text, #047857) 12%, var(--app-surface-card, #fff)); color: var(--app-success-text, #047857); }
.maid-onboarding-welcome-task.is-done .maid-onboarding-welcome-task-reward { background: color-mix(in srgb, var(--app-warning-text, #b45309) 11%, var(--app-surface-card, #fff)); color: var(--app-warning-text, #b45309); }
.maid-onboarding-welcome-task.is-done .maid-onboarding-welcome-task-action { border: 1px solid color-mix(in srgb, var(--app-success-text, #047857) 20%, var(--app-border-subtle)); background: color-mix(in srgb, var(--app-success-text, #047857) 8%, var(--app-surface-card, #fff)); color: var(--app-success-text, #047857); box-shadow: none; }
.maid-onboarding-welcome-task.is-locked .maid-onboarding-welcome-task-action { background: color-mix(in srgb, var(--app-warning-text, #b45309) 11%, var(--app-surface-card, #fff)); color: var(--app-warning-text, #b45309); box-shadow: none; }
.maid-onboarding-welcome-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
  padding: 4px 14px 12px;
  color: var(--app-text-muted, #64748b);
  font-size: 9.5px;
}
.maid-onboarding-welcome-all {
  min-height: 40px;
  flex: 0 0 auto;
  padding: 0 11px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 9%, var(--app-surface-card, #fff));
  color: var(--app-accent-primary, #2563eb);
  font-size: 10px;
  font-weight: 850;
}
.maid-onboarding-toast {
  left: 50%;
  bottom: calc(22px + env(safe-area-inset-bottom, 0px));
  width: min(420px, calc(100vw - 28px));
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 10px 11px 12px;
  border-radius: 18px;
  transform: translateX(-50%);
  animation: maid-onboarding-toast-in 320ms cubic-bezier(.22,1,.36,1) both;
}
.maid-onboarding-toast-icon { width: 46px; height: 46px; border-radius: 14px; }
.maid-onboarding-toast-copy { min-width: 0; flex: 1; }
.maid-onboarding-toast-title { font-size: 13px; font-weight: 850; }
.maid-onboarding-toast-sub { margin-top: 2px; color: var(--app-text-secondary, #64748b); font-size: 11px; }
.maid-onboarding-toast-action {
  min-height: 40px;
  padding: 0 13px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-success-text, #047857) 10%, var(--app-surface-card));
  color: var(--app-success-text, #047857);
  font-size: 11.5px;
  font-weight: 850;
}
@media (hover:hover) and (pointer:fine) {
  .maid-onboarding-welcome-task:not(:disabled):hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 28%, var(--app-border-subtle)); box-shadow: 0 12px 24px -20px color-mix(in srgb, var(--app-accent-primary, #2563eb) 56%, transparent); }
  .maid-onboarding-hint-close:hover,
  .maid-onboarding-toast-close:hover,
  .maid-onboarding-welcome-close:hover { background: var(--app-surface-subtle, #f8fafc); color: var(--app-text-primary, #111827); }
}
.maid-onboarding-welcome-task:not(:disabled):active { transform: scale(.985); }
@keyframes maid-onboarding-entry-in {
  from { opacity: 0; transform: translate3d(0, 12px, 0) scale(.97); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes maid-onboarding-welcome-in {
  from { opacity: 0; transform: translate3d(0, 12px, 0) scale(.97); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes maid-onboarding-task-in {
  from { opacity: 0; transform: translate3d(0, 7px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes maid-onboarding-progress-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes maid-onboarding-hold-pulse {
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); }
}
@keyframes maid-onboarding-toast-in {
  from { opacity: 0; transform: translate3d(-50%, 14px, 0) scale(.97); }
  to { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1); }
}
@media (max-width: 520px) {
  .maid-onboarding-hint { width: min(340px, calc(100vw - 24px)); grid-template-columns: 46px minmax(0, 1fr) 40px; }
  .maid-onboarding-hint-avatar { width: 46px; height: 46px; }
  .maid-onboarding-welcome-head { grid-template-columns: 50px minmax(0, 1fr) 40px; padding-left: 11px; }
  .maid-onboarding-welcome-avatar-wrap,
  .maid-onboarding-welcome-avatar { width: 48px; height: 48px; border-radius: 15px; }
  .maid-onboarding-welcome-section { padding-right: 10px; padding-left: 10px; }
  .maid-onboarding-welcome-task { min-height: 64px; gap: 8px; padding: 8px; }
  .maid-onboarding-welcome-task-action { min-width: 62px; padding: 0 9px; }
  .maid-onboarding-welcome-foot { padding-right: 10px; padding-left: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  .maid-onboarding-hint,
  .maid-onboarding-toast,
  .maid-onboarding-welcome,
  .maid-onboarding-welcome-task,
  .maid-onboarding-welcome-progress-bar,
  .maid-onboarding-hint-gesture { animation: none !important; transition: none !important; }
}
body[data-reduced-motion='on'] .maid-onboarding-hint,
body[data-reduced-motion='on'] .maid-onboarding-toast,
body[data-reduced-motion='on'] .maid-onboarding-welcome,
body[data-reduced-motion='on'] .maid-onboarding-welcome-task,
body[data-reduced-motion='on'] .maid-onboarding-welcome-progress-bar,
body[data-reduced-motion='on'] .maid-onboarding-hint-gesture { animation: none !important; transition: none !important; }
`;
  documentRef.head.appendChild(style);
};

const iconSvg = body => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = Object.freeze({
  hand: iconSvg('<path d="M7 11V5a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v8c0 5-3 8-8 8h-1c-3 0-5-2-6-4l-2-4a2 2 0 0 1 3-2l2 2"/>'),
  plug: iconSvg('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v3a6 6 0 0 1-12 0V8Z"/>'),
  userPlus: iconSvg('<path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>'),
  message: iconSvg('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>'),
  sparkles: iconSvg('<path d="m12 3-1.3 3.7L7 8l3.7 1.3L12 13l1.3-3.7L17 8l-3.7-1.3Z"/><path d="m5 14-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8Z"/><path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L22 17l-2.2-.8Z"/>'),
  checkCircle: iconSvg('<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>'),
});

const create = (documentRef, tag, className = '', text = '') => {
  const element = documentRef?.createElement?.(tag);
  if (!element) return null;
  element.className = className;
  if (text) element.textContent = text;
  return element;
};

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), Math.max(min, max));
// 小球移动的过渡是 0.22 秒（qq-legacy.css .mode-switch），停稳后再对齐气泡
const HINT_ANCHOR_SETTLE_MS = 260;

export const createMaidOnboardingEntryUi = ({
  documentRef = globalThis?.document || null,
  windowRef = globalThis?.window || null,
  setTimeoutFn = globalThis?.setTimeout || null,
  clearTimeoutFn = globalThis?.clearTimeout || null,
} = {}) => {
  let hintEl = null;
  let hintAnchorEl = null;
  let welcomeEl = null;
  let welcomeAnchorEl = null;
  let toastEl = null;
  let toastTimer = null;
  let positionTimer = null;
  let positionBound = false;
  let anchorObserver = null;
  let anchorSettleTimer = null;

  const getViewport = () => ({
    width: Number(windowRef?.visualViewport?.width || windowRef?.innerWidth || documentRef?.documentElement?.clientWidth || 0) || 0,
    height: Number(windowRef?.visualViewport?.height || windowRef?.innerHeight || documentRef?.documentElement?.clientHeight || 0) || 0,
  });

  const positionHint = () => {
    if (!hintEl || !hintAnchorEl?.getBoundingClientRect) return;
    const viewport = getViewport();
    if (!viewport.width || !viewport.height) return;
    const anchor = hintAnchorEl.getBoundingClientRect();
    const hintRect = hintEl.getBoundingClientRect?.() || {};
    const width = Math.min(Number(hintRect.width || 344) || 344, viewport.width - 24);
    const height = Math.max(72, Number(hintRect.height || 84) || 84);
    const anchorCenter = Number(anchor.left || 0) + Number(anchor.width || 0) / 2;
    const aboveTop = Number(anchor.top || 0) - height - 12;
    const placement = aboveTop >= 12 ? 'above' : 'below';
    const left = clamp(anchorCenter - width / 2, 12, viewport.width - width - 12);
    const top = placement === 'above'
      ? aboveTop
      : clamp(Number(anchor.bottom ?? (Number(anchor.top || 0) + Number(anchor.height || 0))) + 12, 12, viewport.height - height - 12);
    hintEl.style.left = `${Math.round(left)}px`;
    hintEl.style.top = `${Math.round(top)}px`;
    hintEl.style.width = `${Math.round(width)}px`;
    hintEl.style.setProperty?.('--maid-hint-arrow-left', `${clamp(anchorCenter - left, 18, width - 18)}px`);
    hintEl.dataset.placement = placement;
  };

  const positionWelcome = () => {
    if (!welcomeEl || !welcomeAnchorEl?.getBoundingClientRect) return;
    const viewport = getViewport();
    if (!viewport.height) return;
    const anchor = welcomeAnchorEl.getBoundingClientRect();
    const topSpace = Math.max(0, Number(anchor.top || 0) - 12);
    const bottom = Number(anchor.bottom ?? (Number(anchor.top || 0) + Number(anchor.height || 0))) || 0;
    const bottomSpace = Math.max(0, viewport.height - bottom - 12);
    const desired = Math.min(360, viewport.height * .56);
    const side = bottomSpace >= desired || bottomSpace >= topSpace ? 'bottom' : 'top';
    welcomeAnchorEl.dataset.welcomeSide = side;
    const available = Math.max(124, (side === 'bottom' ? bottomSpace : topSpace) - 8);
    welcomeEl.style.setProperty?.('--maid-welcome-max-height', `${Math.floor(available)}px`);
  };

  const refreshPosition = () => {
    positionHint();
    positionWelcome();
  };

  const onViewportChange = () => {
    if (positionTimer != null) clearTimeoutFn?.(positionTimer);
    positionTimer = setTimeoutFn?.(() => {
      positionTimer = null;
      refreshPosition();
    }, 40) ?? null;
  };

  const syncPositionBinding = () => {
    const shouldBind = Boolean(hintEl || welcomeEl);
    if (shouldBind === positionBound) return;
    positionBound = shouldBind;
    const method = shouldBind ? 'addEventListener' : 'removeEventListener';
    windowRef?.[method]?.('resize', onViewportChange);
    windowRef?.visualViewport?.[method]?.('resize', onViewportChange);
  };

  // 首次开 APP 时气泡出现得比小球就位早：小球先在画面中央，之后才移到底部（top/left 带 0.22 秒过渡），
  // 拖动后也会换位置。气泡显示期间跟着小球的 style/class 变化，等它停稳再对齐。
  const unwatchHintAnchor = () => {
    anchorObserver?.disconnect?.();
    anchorObserver = null;
    if (anchorSettleTimer != null) clearTimeoutFn?.(anchorSettleTimer);
    anchorSettleTimer = null;
  };

  const watchHintAnchor = () => {
    unwatchHintAnchor();
    const Observer = windowRef?.MutationObserver;
    if (!hintAnchorEl || typeof Observer !== 'function') return;
    anchorObserver = new Observer(() => {
      if (anchorSettleTimer != null) clearTimeoutFn?.(anchorSettleTimer);
      anchorSettleTimer = setTimeoutFn?.(() => {
        anchorSettleTimer = null;
        positionHint();
      }, HINT_ANCHOR_SETTLE_MS) ?? null;
    });
    anchorObserver.observe(hintAnchorEl, { attributes: true, attributeFilter: ['style', 'class'] });
  };

  const hideHint = () => {
    unwatchHintAnchor();
    hintEl?.remove?.();
    hintEl = null;
    hintAnchorEl = null;
    syncPositionBinding();
  };

  const hideWelcome = () => {
    const anchor = welcomeAnchorEl;
    welcomeEl?.remove?.();
    welcomeEl = null;
    welcomeAnchorEl = null;
    anchor?.classList?.remove?.('has-onboarding-welcome');
    if (anchor?.dataset) delete anchor.dataset.welcomeSide;
    syncPositionBinding();
  };

  const hideToast = () => {
    if (toastTimer != null) clearTimeoutFn?.(toastTimer);
    toastTimer = null;
    toastEl?.remove?.();
    toastEl = null;
  };

  const showHint = ({ anchorEl = null, onDismiss = null } = {}) => {
    if (!documentRef?.body || hintEl) return false;
    injectStyle(documentRef);
    hintAnchorEl = anchorEl;
    hintEl = create(documentRef, 'aside', 'maid-onboarding-hint');
    hintEl.setAttribute?.('role', 'status');
    const avatar = create(documentRef, 'span', 'maid-onboarding-hint-avatar');
    applyMaidGuideExpression(avatar, 'welcome');
    avatar.setAttribute?.('aria-hidden', 'true');
    const copy = create(documentRef, 'div', 'maid-onboarding-hint-copy');
    const gesture = create(documentRef, 'span', 'maid-onboarding-hint-gesture');
    gesture.innerHTML = `${ICONS.hand}<span>长按约 0.6 秒</span>`;
    copy.append(
      create(documentRef, 'div', 'maid-onboarding-hint-title', '第一次见面？长按小球叫我出来'),
      create(documentRef, 'div', 'maid-onboarding-hint-sub', '我准备了四堂新手课，主人可以慢慢挑。'),
      gesture,
    );
    const close = create(documentRef, 'button', 'maid-onboarding-hint-close', '×');
    close.type = 'button';
    close.setAttribute?.('aria-label', '不再提示女仆新手引导');
    close.addEventListener?.('click', () => {
      hideHint();
      onDismiss?.();
    });
    hintEl.append(avatar, copy, close);
    documentRef.body.appendChild(hintEl);
    syncPositionBinding();
    refreshPosition();
    watchHintAnchor();
    return true;
  };

  const showWelcome = ({
    anchorEl = null,
    tasks = [],
    onStartTask = null,
    onDismiss = null,
    onOpenTasks = null,
  } = {}) => {
    if (!anchorEl?.appendChild || welcomeEl) return false;
    injectStyle(documentRef);
    welcomeAnchorEl = anchorEl;
    welcomeEl = create(documentRef, 'aside', 'maid-onboarding-welcome');
    welcomeEl.setAttribute?.('role', 'region');
    welcomeEl.setAttribute?.('aria-label', '女仆新手任务');

    const head = create(documentRef, 'div', 'maid-onboarding-welcome-head');
    const avatarWrap = create(documentRef, 'div', 'maid-onboarding-welcome-avatar-wrap');
    const avatar = create(documentRef, 'span', 'maid-onboarding-welcome-avatar');
    applyMaidGuideExpression(avatar, 'welcome');
    avatar.setAttribute?.('aria-hidden', 'true');
    const avatarStatus = create(documentRef, 'span', 'maid-onboarding-welcome-avatar-status');
    avatarStatus.setAttribute?.('aria-hidden', 'true');
    avatarWrap.append(avatar, avatarStatus);
    const copy = create(documentRef, 'div', 'maid-onboarding-welcome-copy');
    copy.append(
      create(documentRef, 'div', 'maid-onboarding-welcome-kicker', 'Maid · Online'),
      create(documentRef, 'div', 'maid-onboarding-welcome-title', '主人好呀，我是你的贴身女仆'),
      create(documentRef, 'div', 'maid-onboarding-welcome-sub', '我备好了四堂新手小课，选一堂就手把手陪主人完成。'),
    );
    const close = create(documentRef, 'button', 'maid-onboarding-welcome-close', '×');
    close.type = 'button';
    close.setAttribute?.('aria-label', '关闭新手任务');
    close.addEventListener?.('click', () => {
      hideWelcome();
      onDismiss?.();
    });
    head.append(avatarWrap, copy, close);

    const taskList = Array.isArray(tasks) ? tasks : [];
    const completed = taskList.filter(task => task?.done).length;
    const section = create(documentRef, 'div', 'maid-onboarding-welcome-section');
    section.setAttribute?.('aria-label', '四项新手任务');
    const sectionHead = create(documentRef, 'div', 'maid-onboarding-welcome-section-head');
    sectionHead.append(
      create(documentRef, 'div', 'maid-onboarding-welcome-section-title', '新手上路 · 上手指引'),
      create(documentRef, 'div', 'maid-onboarding-welcome-progress', `${completed}/${taskList.length}`),
    );
    const progressTrack = create(documentRef, 'div', 'maid-onboarding-welcome-progress-track');
    const progressBar = create(documentRef, 'div', 'maid-onboarding-welcome-progress-bar');
    progressBar.style?.setProperty?.('--maid-welcome-progress', taskList.length ? `${(completed / taskList.length) * 100}%` : '0%');
    progressTrack.appendChild(progressBar);
    const list = create(documentRef, 'div', 'maid-onboarding-welcome-list');
    taskList.forEach((task, index) => {
      const button = create(documentRef, 'button', `maid-onboarding-welcome-task${task?.done ? ' is-done' : ''}${task?.locked ? ' is-locked' : ''}`);
      button.type = 'button';
      button.style?.setProperty?.('--maid-task-index', String(Math.min(index, 6)));
      const icon = create(documentRef, 'span', 'maid-onboarding-welcome-task-icon');
      const iconName = task?.icon === 'user-plus' ? 'userPlus' : String(task?.icon || 'sparkles');
      icon.innerHTML = ICONS[iconName] || ICONS.sparkles;
      const main = create(documentRef, 'span', 'maid-onboarding-welcome-task-main');
      const heading = create(documentRef, 'span', 'maid-onboarding-welcome-task-heading');
      heading.appendChild(create(documentRef, 'span', 'maid-onboarding-welcome-task-title', String(task?.label || task?.flowId || '新手任务')));
      if (String(task?.reward || '').trim()) {
        heading.appendChild(create(
          documentRef,
          'span',
          'maid-onboarding-welcome-task-reward',
          `${task?.done ? '成就·' : ''}${String(task.reward).trim()}`,
        ));
      }
      main.append(
        heading,
        create(documentRef, 'span', 'maid-onboarding-welcome-task-description', String(task?.description || '')),
      );
      const actionLabel = task?.done ? '完成' : (task?.actionLabel || '开始');
      const action = create(documentRef, 'span', 'maid-onboarding-welcome-task-action');
      if (task?.done) action.innerHTML = `${ICONS.checkCircle}<span>${actionLabel}</span>`;
      else action.textContent = actionLabel;
      button.append(icon, main, action);
      button.disabled = Boolean(task?.done);
      button.setAttribute?.('aria-label', task?.done ? `${task?.label || '新手任务'}，已完成` : `${actionLabel}：${task?.label || '新手任务'}`);
      if (!task?.done) {
        button.addEventListener?.('click', (event) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          hideWelcome();
          onStartTask?.(task);
        });
      }
      list.appendChild(button);
    });
    section.append(sectionHead, progressTrack, list);

    const foot = create(documentRef, 'div', 'maid-onboarding-welcome-foot');
    foot.appendChild(create(documentRef, 'span', '', '以后可在「女仆设定 → 任务」中重温'));
    const all = create(documentRef, 'button', 'maid-onboarding-welcome-all', '打开任务页');
    all.type = 'button';
    all.addEventListener?.('click', () => {
      hideWelcome();
      onOpenTasks?.();
    });
    foot.appendChild(all);
    welcomeEl.append(head, section, foot);
    anchorEl.classList?.add?.('has-onboarding-welcome');
    anchorEl.appendChild(welcomeEl);
    syncPositionBinding();
    refreshPosition();
    return true;
  };

  const showCompletion = ({ title = '新手任务完成', reward = '', onViewTasks = null, duration = 6500 } = {}) => {
    if (!documentRef?.body) return false;
    injectStyle(documentRef);
    hideToast();
    toastEl = create(documentRef, 'aside', 'maid-onboarding-toast');
    toastEl.setAttribute?.('role', 'status');
    const icon = create(documentRef, 'span', 'maid-onboarding-toast-icon');
    applyMaidGuideExpression(icon, 'success');
    icon.setAttribute?.('aria-hidden', 'true');
    const copy = create(documentRef, 'div', 'maid-onboarding-toast-copy');
    copy.append(
      create(documentRef, 'div', 'maid-onboarding-toast-title', title),
      create(documentRef, 'div', 'maid-onboarding-toast-sub', reward ? `获得成就「${reward}」` : '进度已保存'),
    );
    const view = create(documentRef, 'button', 'maid-onboarding-toast-action', '查看清单');
    view.type = 'button';
    view.addEventListener?.('click', () => {
      hideToast();
      onViewTasks?.();
    });
    const close = create(documentRef, 'button', 'maid-onboarding-toast-close', '×');
    close.type = 'button';
    close.setAttribute?.('aria-label', '关闭完成提示');
    close.addEventListener?.('click', hideToast);
    toastEl.append(icon, copy, view, close);
    documentRef.body.appendChild(toastEl);
    if (Number(duration) > 0) toastTimer = setTimeoutFn?.(hideToast, Number(duration)) ?? null;
    return true;
  };

  return {
    destroy() {
      hideHint();
      hideWelcome();
      hideToast();
      if (positionTimer != null) clearTimeoutFn?.(positionTimer);
      positionTimer = null;
    },
    hideHint,
    hideToast,
    hideWelcome,
    refreshPosition,
    showCompletion,
    showHint,
    showWelcome,
    getElements: () => ({ hintEl, welcomeEl, toastEl }),
  };
};
