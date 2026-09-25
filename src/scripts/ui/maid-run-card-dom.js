/* 女仆运行卡 DOM：输入胶囊结果流与执行流面板共用。
   一次任务 = 一张卡；按行 id 原位更新，新行错峰进场；展开、折叠等界面状态留在卡内。
   颜色全部来自 --app-* token（含 *-rgb 派生），明暗主题与 reduced-motion 均成立。 */

import { t } from '../i18n/index.js';
import { appendMaidSkillRunDetails } from './maid-skill-ui.js';
import {
  buildMaidRunCardModel,
  formatMaidRunElapsed,
  isMaidRunCollapsedByDefault,
  resolveMaidRunVisibleRows,
} from './maid-run-card-model.js';

const STYLE_ID = 'maid-run-card-style';

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const MAID_RUN_ICONS = Object.freeze({
  queued: svg('<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="2"/>'),
  running: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="2.4"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  waiting: svg('<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></g>'),
  done: svg('<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  failed: svg('<path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
  cancelled: svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>'),
  skipped: svg('<path d="M6 12h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  check: svg('<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
  cross: svg('<path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  spark: svg('<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" fill="currentColor"/>'),
  mic: svg('<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></g>'),
  shield: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 2.7v5.6c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V5.7z"/><path d="M9 12l2.2 2.2L15.2 10"/></g>'),
  alert: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L21.5 20h-19z"/><path d="M12 10v4.2M12 17.2h.01"/></g>'),
});

export const MAID_RUN_CARD_STYLE = `
.mrc {
  --mrc-accent: rgb(var(--app-accent-rgb, 59, 130, 246));
  --mrc-success: rgb(var(--app-success-rgb, 46, 160, 67));
  --mrc-danger: rgb(var(--app-danger-rgb, 220, 38, 38));
  --mrc-warning: rgb(var(--app-warning-rgb, 217, 119, 6));
  --mrc-line: var(--app-border-subtle, rgba(15, 23, 42, 0.08));
  --mrc-mono: ui-monospace, 'SFMono-Regular', 'Cascadia Mono', Menlo, Consolas, monospace;
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.32));
  border-radius: 16px;
  background: var(--app-surface-card, #fff);
  color: var(--app-text-primary, #0f172a);
  box-shadow: var(--app-shadow-sm, 0 1px 4px rgba(15, 23, 42, 0.08));
  overflow: hidden;
  font-size: 13px;
  line-height: 1.5;
  white-space: normal;
  text-align: left;
}
.mrc[data-state='waiting'] { border-color: color-mix(in srgb, var(--mrc-warning) 42%, var(--app-border-default, transparent)); }
.mrc[data-state='failed'] { border-color: color-mix(in srgb, var(--mrc-danger) 36%, var(--app-border-default, transparent)); }
.mrc button { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
.mrc button:focus-visible { outline: 2px solid var(--mrc-accent); outline-offset: 2px; }
.mrc svg { display: block; width: 100%; height: 100%; }
.mrc-head { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 12px; min-width: 0; }
.mrc-mark { position: relative; flex: 0 0 auto; width: 26px; height: 26px; display: inline-grid; place-items: center; }
.mrc-ring { position: absolute; inset: 0; transform: rotate(-90deg); }
.mrc-ring .mrc-ring-track { stroke: var(--mrc-line); }
.mrc-ring .mrc-ring-arc { stroke: var(--mrc-accent); transition: stroke-dashoffset 0.5s ease-out; }
.mrc[data-state='waiting'] .mrc-ring .mrc-ring-arc { stroke: var(--mrc-warning); }
.mrc-ring-num { position: relative; font: 600 10.5px/1 var(--mrc-mono); font-variant-numeric: tabular-nums; }
.mrc-badge { width: 26px; height: 26px; border-radius: 50%; display: inline-grid; place-items: center; color: var(--app-text-on-accent, #fff); animation: mrcPop 0.3s cubic-bezier(0.23, 1, 0.32, 1) both; }
.mrc-badge > svg { width: 13px; height: 13px; }
.mrc-badge.is-ok { background: var(--mrc-success); }
.mrc-badge.is-bad { background: var(--mrc-danger); }
.mrc-badge.is-stop { background: var(--app-text-muted, #94a3b8); }
.mrc-badge.is-stop > svg { width: 10px; height: 10px; }
@keyframes mrcPop { from { transform: scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }
.mrc-heading { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mrc-title { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrc-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; font: 400 11.5px/1.35 var(--mrc-mono); color: var(--app-text-muted, #94a3b8); font-variant-numeric: tabular-nums; }
.mrc-meta .mrc-state { font-family: inherit; font-weight: 600; }
.mrc[data-state='running'] .mrc-state { color: var(--mrc-accent); }
.mrc[data-state='waiting'] .mrc-state { color: color-mix(in srgb, var(--mrc-warning) 78%, var(--app-text-primary, #000)); }
.mrc[data-state='failed'] .mrc-state { color: var(--mrc-danger); }
.mrc[data-state='done'] .mrc-state { color: var(--mrc-success); }
.mrc-meta .mrc-sep { opacity: 0.55; }
.mrc-source { display: inline-flex; align-items: center; gap: 3px; color: var(--app-text-secondary, #475569); }
.mrc-source > svg { width: 11px; height: 11px; }
.mrc-model { min-width: 0; max-width: 11em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--app-text-muted, #64748b); }
.mrc-icon-btn { flex: 0 0 auto; width: 30px; height: 30px; display: inline-grid; place-items: center; border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.32)); border-radius: 50%; background: var(--app-surface-card, #fff); color: var(--app-text-secondary, #475569); cursor: pointer; }
.mrc-icon-btn:hover { background: var(--app-surface-hover, #f1f5f9); }
.mrc-stop:hover { color: var(--mrc-danger); border-color: color-mix(in srgb, var(--mrc-danger) 40%, transparent); }
.mrc-stop > i { width: 9px; height: 9px; border-radius: 2px; background: currentColor; display: block; }
.mrc-toggle { border-color: transparent; background: transparent; }
.mrc-toggle > svg { width: 14px; height: 14px; transition: transform 0.18s ease-out; }
.mrc-toggle[aria-expanded='true'] > svg { transform: rotate(180deg); }
.mrc [hidden] { display: none !important; }
.mrc-rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--mrc-line); }
.mrc-row { border-bottom: 1px solid var(--mrc-line); }
.mrc-row:last-child { border-bottom: 0; }
.mrc-row.is-entering { animation: mrcRowIn 0.28s ease-out both; }
@keyframes mrcRowIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.mrc-row-main, .mrc-fold { width: 100%; min-height: 36px; display: flex; align-items: center; gap: 9px; padding: 7px 12px; border: 0; background: transparent; text-align: left; cursor: pointer; }
.mrc-row-main:hover, .mrc-fold:hover { background: var(--app-surface-hover, #f1f5f9); }
.mrc-fold { color: var(--app-text-muted, #94a3b8); font-size: 12px; }
.mrc-row-icon { flex: 0 0 auto; width: 16px; height: 16px; color: var(--app-text-muted, #94a3b8); }
.mrc-row-title { min-width: 0; flex: 0 1 auto; font-size: 12.5px; color: var(--app-text-secondary, #475569); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrc-chip { min-width: 0; max-width: 42%; flex: 0 1 auto; padding: 3px 6px; border: 1px solid var(--mrc-line); border-radius: 6px; background: var(--app-surface-subtle, #f8fafc); color: var(--app-text-secondary, #475569); font: 400 11px/1.2 var(--mrc-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrc-row-dur { margin-left: auto; flex: 0 0 auto; font: 400 11px/1 var(--mrc-mono); color: var(--app-text-muted, #94a3b8); font-variant-numeric: tabular-nums; }
.mrc-row-chev { flex: 0 0 auto; width: 12px; height: 12px; color: var(--app-text-muted, #94a3b8); opacity: 0; transition: opacity 0.15s, transform 0.18s ease-out; }
.mrc-row-main:hover .mrc-row-chev, .mrc-row-main:focus-visible .mrc-row-chev, .mrc-row-main[aria-expanded='true'] .mrc-row-chev { opacity: 1; }
.mrc-row-main[aria-expanded='true'] .mrc-row-chev { transform: rotate(180deg); }
.mrc-row[data-status='running'] .mrc-row-title,
.mrc-row[data-status='waiting'] .mrc-row-title,
.mrc-row[data-status='failed'] .mrc-row-title { color: var(--app-text-primary, #0f172a); font-weight: 600; }
.mrc-row[data-status='queued'] .mrc-row-title { color: var(--app-text-muted, #94a3b8); }
.mrc-row[data-status='running'] .mrc-row-icon { color: var(--mrc-accent); }
.mrc-row[data-status='running'] .mrc-row-icon > svg { animation: mrcSpin 1.1s linear infinite; }
.mrc-row[data-status='waiting'] .mrc-row-icon { color: var(--mrc-warning); }
.mrc-row[data-status='failed'] .mrc-row-icon { color: var(--mrc-danger); }
@keyframes mrcSpin { to { transform: rotate(360deg); } }
.mrc-row-error { padding: 0 12px 9px 37px; color: var(--mrc-danger); font-size: 12px; overflow-wrap: anywhere; }
.mrc-row-detail { padding: 0 12px 10px 37px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--app-text-secondary, #475569); }
.mrc-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 10px; margin: 0; }
.mrc-kv dt { color: var(--app-text-muted, #94a3b8); font-family: var(--mrc-mono); font-size: 11px; line-height: 1.6; }
.mrc-kv dd { margin: 0; overflow-wrap: anywhere; }
.mrc-result { color: var(--app-text-primary, #0f172a); }
.mrc-live { display: flex; align-items: center; gap: 9px; padding: 9px 12px 10px; border-top: 1px solid var(--mrc-line); }
.mrc-grid { flex: 0 0 auto; display: grid; grid-template-columns: repeat(3, 4px); gap: 1.5px; margin: 0 2px 0 3px; }
.mrc-grid > i { width: 4px; height: 4px; border-radius: 1px; background: var(--app-text-primary, #0f172a); opacity: 0.15; animation: mrcPixel 650ms ease-in-out infinite; }
@keyframes mrcPixel { 0%, 100% { opacity: 0.15; } 45% { opacity: 0.85; } }
.mrc-shimmer { flex: 1 1 auto; min-width: 0; font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: linear-gradient(90deg, var(--app-text-muted, #94a3b8) 35%, var(--app-text-primary, #0f172a) 50%, var(--app-text-muted, #94a3b8) 65%);
  background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: mrcShimmer 1.4s linear infinite; }
@keyframes mrcShimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.mrc-thought { border-top: 1px solid var(--mrc-line); }
.mrc-thought-toggle { width: 100%; display: flex; align-items: center; gap: 7px; min-height: 32px; padding: 6px 12px; border: 0; background: transparent; color: var(--app-text-muted, #94a3b8); font-size: 12px; cursor: pointer; text-align: left; }
.mrc-thought-toggle > svg { width: 11px; height: 11px; flex: 0 0 auto; }
.mrc-thought-toggle > .mrc-thought-chev { width: 11px; height: 11px; flex: 0 0 auto; margin-left: auto; transition: transform 0.18s ease-out; }
.mrc-thought-toggle[aria-expanded='true'] > .mrc-thought-chev { transform: rotate(180deg); }
.mrc-thought-list { list-style: none; margin: 0 12px 10px 18px; padding: 0 0 0 13px; border-left: 1px solid var(--mrc-line); display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--app-text-secondary, #475569); white-space: pre-wrap; overflow-wrap: anywhere; }
.mrc-approval { --mrc-tone: var(--mrc-warning); margin: 0 10px 10px; padding: 12px 12px 10px; border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--mrc-tone) 24%, transparent);
  background: color-mix(in srgb, var(--mrc-tone) 6%, var(--app-surface-card, #fff));
  display: flex; flex-direction: column; gap: 9px; animation: mrcApprovalIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.mrc-approval[data-tone='danger'] { --mrc-tone: var(--mrc-danger); }
@keyframes mrcApprovalIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.mrc-approval-head { display: flex; align-items: center; gap: 9px; min-width: 0; }
.mrc-approval-icon { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
  color: var(--mrc-tone); background: color-mix(in srgb, var(--mrc-tone) 14%, transparent); }
.mrc-approval-icon > svg { width: 14px; height: 14px; }
.mrc-approval-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 13.5px; font-weight: 650; color: var(--app-text-primary, #0f172a); overflow-wrap: anywhere; }
.mrc-approval-badge { flex: 0 0 auto; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--mrc-tone) 82%, var(--app-text-primary, #000)); background: color-mix(in srgb, var(--mrc-tone) 13%, transparent); }
.mrc-approval-message { margin: 0; padding-left: 35px; font-size: 12px; line-height: 1.55; color: var(--app-text-secondary, #475569); white-space: pre-wrap; overflow-wrap: anywhere; }
.mrc-approval-items { display: flex; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0 0 0 35px; list-style: none; }
.mrc-approval-items li { max-width: 100%; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--mrc-line); background: var(--app-surface-card, #fff); font-size: 11.5px; color: var(--app-text-secondary, #475569); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrc-approval-items.is-detailed { flex-direction: column; flex-wrap: nowrap; gap: 0; border: 1px solid var(--mrc-line); border-radius: 10px; background: var(--app-surface-card, #fff); margin-left: 35px; padding: 2px 0; overflow: hidden; }
.mrc-approval-items.is-detailed li { position: relative; display: flex; flex-direction: column; gap: 1px; border: 0; border-radius: 0; background: none; padding: 6px 10px 6px 22px; white-space: normal; }
.mrc-approval-items.is-detailed li + li { border-top: 1px solid var(--mrc-line); }
.mrc-approval-items.is-detailed li::before { content: ''; position: absolute; left: 10px; top: 12px; width: 5px; height: 5px; border-radius: 50%; background: var(--mrc-tone); }
.mrc-approval-items.is-detailed li.is-skipped { opacity: 0.6; }
.mrc-approval-items.is-detailed li.is-skipped::before { background: var(--app-text-muted, #94a3b8); }
.mrc-approval-item-label { color: var(--app-text-primary, #0f172a); font-weight: 500; overflow-wrap: anywhere; }
.mrc-approval-item-meta { font-size: 11px; color: var(--app-text-muted, #94a3b8); overflow-wrap: anywhere; }
.mrc-approval-hint { padding-left: 35px; font-size: 11.5px; color: var(--app-text-muted, #94a3b8); }
.mrc-approval-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; padding-top: 2px; }
.mrc-btn.is-link { margin-right: auto; padding: 0 4px; border-color: transparent; background: transparent; color: var(--app-text-muted, #94a3b8); font-weight: 500; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; }
.mrc-btn.is-link:hover { background: transparent; color: var(--app-text-secondary, #475569); text-decoration-color: currentColor; }
.mrc-approval[data-tone='danger'] .mrc-btn.is-primary { border-color: var(--mrc-danger); background: var(--mrc-danger); color: var(--app-text-inverse, #fff); }
.mrc-btn { min-height: 32px; padding: 0 13px; border-radius: 999px; border: 1px solid var(--app-border-strong, rgba(15, 23, 42, 0.16)); background: var(--app-surface-card, #fff); font-size: 12px; font-weight: 600; cursor: pointer; }
.mrc-btn:hover { background: var(--app-surface-hover, #f1f5f9); }
.mrc-btn.is-ghost { border-color: transparent; background: transparent; color: var(--app-text-secondary, #475569); }
.mrc-btn.is-primary { border-color: var(--app-text-primary, #0f172a); background: var(--app-text-primary, #0f172a); color: var(--app-surface-card, #fff); }
.mrc-btn.is-primary:hover { opacity: 0.9; }
.mrc.is-touch .mrc-row-main, .mrc.is-touch .mrc-fold { min-height: 44px; }
.mrc.is-touch .mrc-row-chev { opacity: 1; }
.mrc.is-touch .mrc-btn { min-height: 44px; padding: 0 16px; }
body[data-reduced-motion='on'] .mrc *, body[data-reduced-motion='on'] .mrc { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  .mrc, .mrc * { animation: none !important; transition: none !important; }
  .mrc-shimmer { color: var(--app-text-secondary, #475569); background: none; }
}
`;

export const injectMaidRunCardStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = MAID_RUN_CARD_STYLE;
  documentRef.head.appendChild(style);
};

const ringHtml = (done, total, label) => {
  const r = 11;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  return `<svg class="mrc-ring" viewBox="0 0 26 26" aria-hidden="true" focusable="false">`
    + `<circle class="mrc-ring-track" cx="13" cy="13" r="${r}" fill="none" stroke-width="2.2"/>`
    + `<circle class="mrc-ring-arc" cx="13" cy="13" r="${r}" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - ratio)).toFixed(2)}"/>`
    + `</svg><span class="mrc-ring-num">${escapeHtml(label)}</span>`;
};

const markHtml = (model) => {
  if (model.state === 'done') return `<span class="mrc-badge is-ok">${MAID_RUN_ICONS.check}</span>`;
  if (model.state === 'failed') return `<span class="mrc-badge is-bad">${MAID_RUN_ICONS.cross}</span>`;
  if (model.state === 'cancelled') return `<span class="mrc-badge is-stop">${MAID_RUN_ICONS.cancelled}</span>`;
  return ringHtml(model.doneCount, Math.max(1, model.total), model.total ? model.currentSeq : '');
};

const rowSignature = (row, expanded) => JSON.stringify([
  row.status, row.title, row.target, row.error, row.durationMs, row.result, row.args, expanded,
]);

const rowInnerHtml = (row, expanded) => {
  const dur = row.status === 'done' && row.durationMs ? formatMaidRunElapsed(row.durationMs) : '';
  let html = `<button type="button" class="mrc-row-main" data-mrc-action="row" data-mrc-row="${escapeHtml(row.id)}" aria-expanded="${expanded ? 'true' : 'false'}">`
    + `<span class="mrc-row-icon">${MAID_RUN_ICONS[row.status] || MAID_RUN_ICONS.running}</span>`
    + `<span class="mrc-row-title">${escapeHtml(row.title)}</span>`
    + (row.target ? `<span class="mrc-chip">${escapeHtml(row.target)}</span>` : '')
    + `<span class="mrc-row-dur">${escapeHtml(dur)}</span>`
    + `<span class="mrc-row-chev">${MAID_RUN_ICONS.chevron}</span>`
    + '</button>';
  if (row.status === 'failed' && row.error) html += `<div class="mrc-row-error">${escapeHtml(row.error)}</div>`;
  if (expanded) {
    const pairs = [
      ...(row.toolName ? [[t('工具'), row.toolName]] : []),
      ...row.args,
    ];
    html += '<div class="mrc-row-detail">';
    if (pairs.length) {
      html += `<dl class="mrc-kv">${pairs.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
    }
    if (row.result) html += `<div class="mrc-result">${escapeHtml(row.result)}</div>`;
    if (!pairs.length && !row.result) html += `<div>${escapeHtml(t('没有更多细节'))}</div>`;
    html += '</div>';
  }
  return html;
};

// 有附注（如“修改：旧 ⇒ 新”、影响范围）或不会执行的项目时逐行列出，否则用紧凑小标签
const SKIPPED_APPROVAL_STATUSES = new Set(['skipped', 'protected', 'missing', 'ambiguous', 'failed']);
const approvalItemsHtml = (items, shown) => {
  const detailed = shown.some(item => item.meta || SKIPPED_APPROVAL_STATUSES.has(item.status));
  const more = items.length > shown.length ? `<li>+${items.length - shown.length}</li>` : '';
  if (!detailed) return `<ul class="mrc-approval-items">${shown.map(item => `<li>${escapeHtml(item.label)}</li>`).join('')}${more}</ul>`;
  return `<ul class="mrc-approval-items is-detailed">${shown.map((item) => {
    const skipped = SKIPPED_APPROVAL_STATUSES.has(item.status);
    return `<li${skipped ? ' class="is-skipped"' : ''}><span class="mrc-approval-item-label">${escapeHtml(item.label)}</span>`
      + (skipped ? `<span class="mrc-approval-item-meta">${escapeHtml(t('不会执行'))}</span>` : (item.meta ? `<span class="mrc-approval-item-meta">${escapeHtml(item.meta)}</span>` : ''))
      + '</li>';
  }).join('')}${more}</ul>`;
};

const approvalHtml = (approval, { voice = false } = {}) => {
  const items = Array.isArray(approval.items) ? approval.items : [];
  const shown = items.slice(0, 6);
  const danger = approval.tone === 'danger';
  return '<div class="mrc-approval-head">'
    + `<span class="mrc-approval-icon" aria-hidden="true">${danger ? MAID_RUN_ICONS.alert : MAID_RUN_ICONS.shield}</span>`
    + `<p class="mrc-approval-title">${escapeHtml(approval.title)}</p>`
    + (approval.actionLabel ? `<span class="mrc-approval-badge">${escapeHtml(approval.actionLabel)}</span>` : '')
    + '</div>'
    + (approval.message ? `<p class="mrc-approval-message">${escapeHtml(approval.message)}</p>` : '')
    + (shown.length ? approvalItemsHtml(items, shown) : '')
    + (voice ? `<span class="mrc-approval-hint">${escapeHtml(t('也可以直接说“允许”'))}</span>` : '')
    + '<div class="mrc-approval-actions">'
    + (approval.allowAlways && !voice ? `<button type="button" class="mrc-btn is-link" data-mrc-action="allow_always">${escapeHtml(t('始终允许'))}</button>` : '')
    + `<button type="button" class="mrc-btn is-ghost" data-mrc-action="deny">${escapeHtml(approval.cancelLabel || t('取消'))}</button>`
    + `<button type="button" class="mrc-btn is-primary" data-mrc-action="allow_once">${escapeHtml(approval.confirmLabel || t('允许一次'))}</button>`
    + '</div>';
};

export const createMaidRunCardView = ({
  documentRef = globalThis?.document || null,
  onStop = null,
  onDecision = null,
  onLayoutChange = null,
  now = () => Date.now(),
  setIntervalFn = null,
  clearIntervalFn = null,
} = {}) => {
  if (!documentRef?.createElement) return null;
  injectMaidRunCardStyle(documentRef);
  const make = (tag, className = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    return el;
  };
  const el = make('article', 'mrc');
  const headEl = make('div', 'mrc-head');
  const bodyEl = make('div', 'mrc-body');
  const rowsEl = make('ul', 'mrc-rows');
  const approvalEl = make('div', 'mrc-approval');
  const liveEl = make('div', 'mrc-live');
  const thoughtEl = make('div', 'mrc-thought');
  const skillsEl = make('div', 'mrc-skills');
  el.appendChild(headEl);
  el.appendChild(bodyEl);
  // 固定顺序：步骤 → 确认 → 进行中 → 思路；只切换 hidden，避免重挂载丢焦点
  [rowsEl, approvalEl, liveEl, thoughtEl].forEach(section => bodyEl.appendChild(section));
  el.appendChild(skillsEl);
  approvalEl.setAttribute?.('role', 'group');
  liveEl.setAttribute?.('aria-live', 'polite');

  const rowNodes = new Map();
  let rowOrder = [];
  const ui = { expanded: new Set(), foldOpen: false, thoughtOpen: false, collapsed: null };
  let model = null;
  let extras = { thoughts: [], liveText: '', approval: null, voice: false, touch: false };
  let ticker = null;
  let headSignature = '';
  let liveSignature = '';
  let approvalSignature = '';
  let thoughtSignature = '';
  let skillSignature = '';

  const elapsedText = () => {
    if (!model?.startedAt) return '';
    const end = model.terminal ? (model.finishedAt || model.startedAt) : now();
    return formatMaidRunElapsed(end - model.startedAt);
  };

  const renderHead = () => {
    const collapsed = isCollapsed();
    const signature = JSON.stringify([model.state, model.title, model.doneCount, model.total, model.currentSeq, model.source, model.executionModel, collapsed, model.finishedAt]);
    if (signature !== headSignature) {
      headSignature = signature;
      const control = model.terminal
        ? `<button type="button" class="mrc-icon-btn mrc-toggle" data-mrc-action="toggle" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${escapeHtml(collapsed ? t('展开步骤') : t('收起步骤'))}">${MAID_RUN_ICONS.chevron}</button>`
        : `<button type="button" class="mrc-icon-btn mrc-stop" data-mrc-action="stop" aria-label="${escapeHtml(t('停止女仆任务'))}"><i></i></button>`;
      headEl.innerHTML = `<span class="mrc-mark" aria-hidden="true">${markHtml(model)}</span>`
        + '<div class="mrc-heading">'
        + `<span class="mrc-title">${escapeHtml(model.title)}</span>`
        + '<span class="mrc-meta">'
        + `<span class="mrc-state">${escapeHtml(model.stateLabel)}</span>`
        + (model.total ? `<span class="mrc-sep">·</span><span>${model.doneCount}/${model.total}</span>` : '')
        + `<span class="mrc-sep">·</span><span class="mrc-elapsed" data-mrc-elapsed>${escapeHtml(elapsedText())}</span>`
        + (model.source === 'maid_realtime' ? `<span class="mrc-sep">·</span><span class="mrc-source">${MAID_RUN_ICONS.mic}${escapeHtml(t('语音'))}</span>` : '')
        + (model.executionModel ? `<span class="mrc-sep">·</span><span class="mrc-model" title="${escapeHtml(t('执行模型'))}">${escapeHtml(model.executionModel)}</span>` : '')
        + '</span></div>'
        + control;
    }
  };

  const isCollapsed = () => (model?.terminal ? (ui.collapsed ?? isMaidRunCollapsedByDefault(model)) : false);

  const renderRows = (animate) => {
    const { foldedCount, rows } = resolveMaidRunVisibleRows(model, { foldOpen: ui.foldOpen });
    const desired = [];
    if (foldedCount > 0) desired.push({ key: '__fold__', fold: foldedCount });
    rows.forEach(row => desired.push({ key: row.id, row }));
    const order = desired.map(item => item.key);
    const sameOrder = order.length === rowOrder.length && order.every((key, index) => key === rowOrder[index]);
    const seen = new Set(order);
    rowNodes.forEach((_, key) => { if (!seen.has(key)) rowNodes.delete(key); });
    desired.forEach((item) => {
      let entry = rowNodes.get(item.key);
      const isNew = !entry;
      if (!entry) {
        entry = { li: make('li', item.fold ? 'mrc-row mrc-row-fold' : 'mrc-row'), signature: '' };
        if (animate && !item.fold) entry.li.classList?.add?.('is-entering');
        rowNodes.set(item.key, entry);
      }
      const expanded = item.row ? ui.expanded.has(item.row.id) : false;
      const signature = item.fold ? `fold:${item.fold}` : rowSignature(item.row, expanded);
      if (signature !== entry.signature || isNew) {
        entry.signature = signature;
        if (item.fold) {
          entry.li.innerHTML = `<button type="button" class="mrc-fold" data-mrc-action="fold"><span class="mrc-row-icon">${MAID_RUN_ICONS.done}</span>${escapeHtml(t('已完成 {count} 步 · 展开', { count: item.fold }))}</button>`;
        } else {
          entry.li.dataset.status = item.row.status;
          entry.li.dataset.rowId = item.row.id;
          entry.li.innerHTML = rowInnerHtml(item.row, expanded);
        }
      }
    });
    if (!sameOrder) {
      rowsEl.innerHTML = '';
      desired.forEach(item => rowsEl.appendChild(rowNodes.get(item.key).li));
      rowOrder = order;
    }
    rowsEl.hidden = desired.length === 0;
  };

  const renderExtras = () => {
    const approval = extras.approval && !model.terminal ? extras.approval : null;
    const approvalKey = approval ? JSON.stringify([approval.id, approval.title, approval.message, approval.items?.length, approval.tone, extras.voice]) : '';
    if (approvalKey !== approvalSignature) {
      approvalSignature = approvalKey;
      approvalEl.innerHTML = approval ? approvalHtml(approval, { voice: extras.voice }) : '';
      if (approval) {
        approvalEl.dataset.approvalId = approval.id;
        approvalEl.dataset.tone = approval.tone === 'danger' ? 'danger' : 'caution';
      }
    }
    const liveText = !model.terminal && !approval ? String(extras.liveText || '').trim() : '';
    if (liveText !== liveSignature) {
      liveSignature = liveText;
      liveEl.innerHTML = liveText
        ? `<span class="mrc-grid" aria-hidden="true">${[0, 90, 180, 90, 180, 270, 180, 270, 360].map(delay => `<i style="animation-delay:${delay}ms"></i>`).join('')}</span><span class="mrc-shimmer">${escapeHtml(liveText)}</span>`
        : '';
    }
    const thoughts = Array.isArray(extras.thoughts) ? extras.thoughts.filter(Boolean) : [];
    const thoughtKey = JSON.stringify([thoughts, ui.thoughtOpen]);
    if (thoughtKey !== thoughtSignature) {
      thoughtSignature = thoughtKey;
      thoughtEl.innerHTML = thoughts.length
        ? `<button type="button" class="mrc-thought-toggle" data-mrc-action="thought" aria-expanded="${ui.thoughtOpen ? 'true' : 'false'}">${MAID_RUN_ICONS.spark}<span>${escapeHtml(t('思路 · {count}', { count: thoughts.length }))}</span><span class="mrc-thought-chev">${MAID_RUN_ICONS.chevron}</span></button>`
          + (ui.thoughtOpen ? `<ol class="mrc-thought-list">${thoughts.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ol>` : '')
        : '';
    }
    approvalEl.hidden = !approval;
    liveEl.hidden = !liveText;
    thoughtEl.hidden = thoughts.length === 0;
  };

  const syncTicker = () => {
    const needTicker = Boolean(model && !model.terminal && model.startedAt && setIntervalFn);
    if (needTicker && ticker == null) {
      ticker = setIntervalFn(() => {
        const target = el.querySelector?.('[data-mrc-elapsed]');
        if (target) target.textContent = elapsedText();
      }, 1000);
    } else if (!needTicker && ticker != null) {
      clearIntervalFn?.(ticker);
      ticker = null;
    }
  };

  const render = ({ animate = true } = {}) => {
    if (!model) return;
    el.dataset.state = model.state;
    el.dataset.runId = model.runId;
    el.classList?.toggle?.('is-touch', extras.touch === true);
    el.setAttribute?.('aria-label', `${t('女仆任务')}：${model.title} · ${model.stateLabel}`);
    renderHead();
    const nextSkillSignature = JSON.stringify((model.maidSkills?.loaded || []).map(item => [item.id, item.revision, item.source]));
    if (nextSkillSignature !== skillSignature) {
      skillSignature = nextSkillSignature;
      while (skillsEl.firstChild) skillsEl.removeChild(skillsEl.firstChild);
      appendMaidSkillRunDetails(documentRef, skillsEl, { metadata: { maidSkills: model.maidSkills } });
    }
    skillsEl.hidden = !model.maidSkills?.loaded?.length;
    bodyEl.hidden = isCollapsed();
    renderRows(animate);
    renderExtras();
    syncTicker();
  };

  const update = (view, nextExtras = {}) => {
    const nextModel = buildMaidRunCardModel(view);
    if (!nextModel) return false;
    if (model && model.runId !== nextModel.runId) {
      ui.expanded.clear();
      ui.foldOpen = false;
      ui.thoughtOpen = false;
      ui.collapsed = null;
    }
    const becameTerminal = model && !model.terminal && nextModel.terminal;
    if (becameTerminal) ui.collapsed = null;
    model = nextModel;
    extras = { ...extras, ...nextExtras };
    render();
    return true;
  };

  const handleAction = (action, value = '') => {
    if (!model) return false;
    if (action === 'stop') {
      if (!model.terminal) void onStop?.({ runId: model.runId });
      return true;
    }
    if (action === 'toggle') {
      ui.collapsed = !isCollapsed();
      headSignature = '';
      render({ animate: false });
      onLayoutChange?.({ reason: 'toggle' });
      return true;
    }
    if (action === 'fold') {
      ui.foldOpen = true;
      render({ animate: false });
      onLayoutChange?.({ reason: 'fold' });
      return true;
    }
    if (action === 'thought') {
      ui.thoughtOpen = !ui.thoughtOpen;
      render({ animate: false });
      onLayoutChange?.({ reason: 'thought' });
      return true;
    }
    if (action === 'row') {
      const id = String(value || '');
      if (ui.expanded.has(id)) ui.expanded.delete(id);
      else ui.expanded.add(id);
      render({ animate: false });
      onLayoutChange?.({ reason: 'row', expanded: ui.expanded.has(id) });
      return true;
    }
    if (['deny', 'allow_once', 'allow_always'].includes(action)) {
      const approvalId = extras.approval?.id;
      if (!approvalId) return false;
      if (action === 'allow_always' && (extras.voice || !extras.approval.allowAlways)) return false;
      void onDecision?.({ id: approvalId, action, runId: model.runId });
      return true;
    }
    return false;
  };

  el.addEventListener?.('click', (event) => {
    const target = event?.target?.closest?.('[data-mrc-action]');
    if (!target || !el.contains?.(target)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    handleAction(target.getAttribute('data-mrc-action'), target.getAttribute('data-mrc-row') || '');
  });

  return {
    el,
    update,
    setExtras: (nextExtras = {}) => {
      extras = { ...extras, ...nextExtras };
      if (model) render({ animate: false });
    },
    handleAction,
    getModel: () => (model ? { ...model } : null),
    getUiState: () => ({ expanded: [...ui.expanded], foldOpen: ui.foldOpen, thoughtOpen: ui.thoughtOpen, collapsed: isCollapsed() }),
    destroy: () => {
      if (ticker != null) clearIntervalFn?.(ticker);
      ticker = null;
      el.remove?.();
    },
  };
};
