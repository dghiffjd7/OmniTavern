// MCP 服务管理（Agent 能力注册计划 Phase E）：Agent Center 资源页「MCP 服务」。
// 新增、编辑、删除服务（名称、地址、令牌），启用开关，测试连接与工具列表；每个工具显示「始终允许」状态并可撤销。
// 远端的名称与说明一律当纯文字显示（textContent），不当指令或 HTML。
import { t } from '../i18n/index.js';
import { mcpOperationId } from '../agent/tools/mcp-tools.js';
import { MCP_SERVER_LIMIT } from '../storage/mcp-server-store.js';

const STYLE_ID = 'mcp-server-panel-style';
const trim = value => String(value ?? '').trim();

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
const ICONS = Object.freeze({
  plug: svg('<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l3 3M14.5 8.5l2 2"/>'),
  shield: svg('<path d="M12 3 5 6v5c0 4.4 3 8.1 7 9 4-.9 7-4.6 7-9V6Z"/><path d="m9 12 2 2 4-4"/>'),
  check: svg('<path d="m5 12 5 5L20 7"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
});

const STYLE = `
.mcp-overlay { position: fixed; inset: 0; z-index: 22600; display: none; align-items: center; justify-content: center; padding: 12px; background: rgba(15, 23, 42, 0.34); }
.mcp-overlay.is-open { display: flex; }
.mcp-overlay [hidden] { display: none !important; }
.mcp-panel { width: min(720px, 100%); height: min(820px, calc(var(--app-visual-height, 100dvh) - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 22px; background: linear-gradient(var(--app-surface-card, #fff), var(--app-surface-card, #fff)), var(--app-surface-page, #fff); color: var(--app-text-primary, #0f172a); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22); }
.mcp-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px 14px; border-bottom: 1px solid var(--app-border-subtle, #eef2f7); }
.mcp-head-icon { width: 42px; height: 42px; flex: 0 0 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; background: linear-gradient(140deg, color-mix(in srgb, var(--app-accent-primary, #2563eb) 22%, transparent), color-mix(in srgb, var(--app-accent-primary, #2563eb) 6%, transparent)); color: var(--app-accent-primary, #2563eb); }
.mcp-head-icon svg { width: 21px; height: 21px; }
.mcp-head-copy { flex: 1; min-width: 0; }
.mcp-title { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: .01em; }
.mcp-subtitle { margin: 3px 0 0; font-size: 12.5px; color: var(--app-text-secondary, #64748b); }
.mcp-add { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px 0 11px; border: 0; border-radius: 999px; background: var(--app-accent-primary, #2563eb); color: var(--app-text-inverse, #fff); font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; transition: background var(--app-dur-quick, 160ms) ease, transform var(--app-dur-quick, 160ms) ease; }
.mcp-add:hover:not(:disabled) { background: var(--app-accent-strong, #1d4ed8); }
.mcp-add:active:not(:disabled) { transform: scale(.97); }
.mcp-add:disabled { opacity: .45; cursor: not-allowed; }
.mcp-add svg { width: 16px; height: 16px; }
.mcp-close { width: 36px; height: 36px; flex: 0 0 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 50%; background: transparent; color: var(--app-text-secondary, #475569); cursor: pointer; }
.mcp-close:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mcp-close svg { width: 18px; height: 18px; }
.mcp-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 18px 24px; display: grid; gap: 12px; align-content: start; }
.mcp-body > * { min-width: 0; }
.mcp-note { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 16%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 6%, transparent); font-size: 12.5px; line-height: 1.6; color: var(--app-text-secondary, #475569); }
.mcp-note svg { width: 18px; height: 18px; flex: 0 0 18px; margin-top: 1px; color: var(--app-accent-primary, #2563eb); }
.mcp-note p { margin: 0; }
.mcp-server { --mcp-tone: var(--app-accent-primary, #2563eb); border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 18px; background: var(--app-surface-card, #fff); overflow: hidden; transition: box-shadow var(--app-dur-quick, 160ms) ease, border-color var(--app-dur-quick, 160ms) ease; }
.mcp-server:hover { box-shadow: 0 6px 18px rgba(15, 23, 42, .06); }
.mcp-server[data-tone='ok'] { --mcp-tone: var(--app-success-text, #059669); }
.mcp-server[data-tone='error'] { --mcp-tone: var(--app-danger-text, #dc2626); border-color: color-mix(in srgb, var(--app-danger-text, #dc2626) 28%, var(--app-border-default, #e2e8f0)); }
.mcp-server[data-tone='off'] { --mcp-tone: var(--app-text-muted, #94a3b8); }
.mcp-server-main { display: flex; align-items: flex-start; gap: 12px; padding: 14px 14px 12px; }
.mcp-orb { position: relative; width: 42px; height: 42px; flex: 0 0 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 13px; background: linear-gradient(140deg, color-mix(in srgb, var(--mcp-tone) 20%, transparent), color-mix(in srgb, var(--mcp-tone) 6%, transparent)); color: var(--mcp-tone); }
.mcp-orb svg { width: 20px; height: 20px; }
.mcp-orb::after { content: ''; position: absolute; right: -2px; bottom: -2px; width: 11px; height: 11px; border: 2px solid var(--app-surface-card, #fff); border-radius: 50%; background: var(--mcp-tone); }
.mcp-server[data-tone='idle'] .mcp-orb::after { background: var(--app-text-muted, #94a3b8); }
.mcp-server[data-tone='busy'] .mcp-orb::after { animation: mcp-pulse 1.1s ease-in-out infinite; }
.mcp-server-copy { flex: 1; min-width: 0; display: grid; gap: 4px; }
.mcp-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mcp-name { font-size: 15px; font-weight: 800; overflow-wrap: anywhere; }
.mcp-server[data-tone='off'] .mcp-name { color: var(--app-text-secondary, #64748b); }
.mcp-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 20px; padding: 0 7px; border-radius: 6px; background: var(--app-surface-subtle, #f1f5f9); color: var(--app-text-secondary, #64748b); font-size: 11px; font-weight: 700; }
.mcp-chip svg { width: 12px; height: 12px; }
.mcp-url { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--app-text-muted, #94a3b8); overflow-wrap: anywhere; }
.mcp-url b { font-weight: 700; color: var(--app-text-secondary, #64748b); }
.mcp-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: var(--app-text-secondary, #64748b); }
.mcp-status-label { font-weight: 800; color: var(--mcp-tone); }
.mcp-server[data-tone='idle'] .mcp-status-label { color: var(--app-text-secondary, #64748b); }
.mcp-alert { margin: 0 14px 12px; padding: 9px 12px; border-radius: 12px; background: color-mix(in srgb, var(--app-danger-text, #dc2626) 8%, transparent); color: var(--app-danger-text, #dc2626); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.mcp-switch { position: relative; flex: 0 0 auto; width: 44px; height: 26px; margin-top: 2px; cursor: pointer; }
.mcp-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.mcp-switch-track { position: absolute; inset: 0; border-radius: 999px; background: var(--app-border-strong, #cbd5e1); transition: background var(--app-dur-quick, 160ms) ease; }
.mcp-switch-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--app-text-on-accent, #fff); box-shadow: 0 1px 3px var(--app-shadow-color, rgba(15, 23, 42, .25)); transition: transform 180ms var(--app-ease-out, ease); }
.mcp-switch input:checked + .mcp-switch-track { background: var(--app-accent-primary, #2563eb); }
.mcp-switch input:checked + .mcp-switch-track::after { transform: translateX(18px); }
.mcp-switch input:focus-visible + .mcp-switch-track { outline: 2px solid var(--app-accent-primary, #2563eb); outline-offset: 2px; }
.mcp-switch input:disabled { cursor: wait; }
.mcp-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 9px 12px; border-top: 1px solid var(--app-border-subtle, #eef2f7); background: color-mix(in srgb, var(--app-surface-subtle, #f1f5f9) 55%, transparent); }
.mcp-spacer { flex: 1; }
.mcp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 999px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; transition: border-color var(--app-dur-quick, 160ms) ease, color var(--app-dur-quick, 160ms) ease, background var(--app-dur-quick, 160ms) ease; }
.mcp-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 42%, transparent); color: var(--app-accent-primary, #2563eb); }
.mcp-btn:disabled { opacity: .5; cursor: not-allowed; }
.mcp-btn svg { width: 15px; height: 15px; transition: transform 180ms ease; }
.mcp-btn.is-open svg { transform: rotate(180deg); }
.mcp-btn.is-ghost { border-color: transparent; background: transparent; color: var(--app-text-secondary, #64748b); }
.mcp-btn.is-danger { color: var(--app-danger-text, #dc2626); }
.mcp-btn.is-danger:hover:not(:disabled) { border-color: color-mix(in srgb, var(--app-danger-text, #dc2626) 40%, transparent); color: var(--app-danger-text, #dc2626); }
.mcp-btn.is-danger-solid { border-color: var(--app-danger-text, #dc2626); background: var(--app-danger-text, #dc2626); color: var(--app-text-on-accent, #fff); }
.mcp-btn.is-danger-solid:hover:not(:disabled) { color: var(--app-text-on-accent, #fff); filter: brightness(1.06); }
.mcp-btn.is-primary { border-color: var(--app-accent-primary, #2563eb); background: var(--app-accent-primary, #2563eb); color: var(--app-text-inverse, #fff); }
.mcp-btn.is-primary:hover:not(:disabled) { border-color: var(--app-accent-strong, #1d4ed8); background: var(--app-accent-strong, #1d4ed8); color: var(--app-text-inverse, #fff); }
.mcp-spin svg { animation: mcp-spin .9s linear infinite; }
.mcp-confirm { flex: 1 1 200px; min-width: 0; font-size: 12.5px; font-weight: 700; line-height: 1.5; color: var(--app-danger-text, #dc2626); }
.mcp-tools { display: grid; gap: 8px; padding: 12px 14px 14px; border-top: 1px solid var(--app-border-subtle, #eef2f7); }
.mcp-tools-empty { margin: 0; font-size: 12.5px; color: var(--app-text-muted, #94a3b8); }
.mcp-tool { display: grid; gap: 6px; padding: 10px 12px; border-radius: 12px; background: var(--app-surface-subtle, #f1f5f9); }
.mcp-tool-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mcp-tool-name { padding: 1px 7px; border: 1px solid var(--app-border-subtle, #e2e8f0); border-radius: 6px; background: var(--app-surface-card, #fff); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-weight: 700; overflow-wrap: anywhere; }
.mcp-tool .mcp-chip { background: var(--app-surface-card, #fff); }
.mcp-tool-title { font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
.mcp-tool-desc { margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12.5px; line-height: 1.55; color: var(--app-text-secondary, #64748b); overflow-wrap: anywhere; }
.mcp-tool-trust { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--app-text-muted, #94a3b8); }
.mcp-trust-on { display: inline-flex; align-items: center; gap: 4px; color: var(--app-success-text, #059669); font-weight: 800; }
.mcp-trust-on svg { width: 14px; height: 14px; }
.mcp-link { padding: 0; border: 0; background: transparent; color: var(--app-accent-primary, #2563eb); font: inherit; font-size: 12px; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.mcp-empty { display: grid; justify-items: center; gap: 8px; padding: 40px 20px; border: 1px dashed var(--app-border-default, #cbd5e1); border-radius: 18px; text-align: center; }
.mcp-empty-icon { width: 56px; height: 56px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 4px; border-radius: 50%; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); }
.mcp-empty-icon svg { width: 26px; height: 26px; }
.mcp-empty-title { margin: 0; font-size: 15px; font-weight: 800; }
.mcp-empty-text { margin: 0 0 6px; max-width: 360px; font-size: 12.5px; line-height: 1.6; color: var(--app-text-secondary, #64748b); }
.mcp-form { display: grid; gap: 16px; padding: 18px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 18px; background: var(--app-surface-card, #fff); }
.mcp-form-title { margin: 0; font-size: 16px; font-weight: 800; overflow-wrap: anywhere; }
.mcp-form-caption { margin: 4px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--app-text-secondary, #64748b); }
.mcp-field { display: grid; gap: 6px; }
.mcp-field-label { font-size: 12.5px; font-weight: 800; }
.mcp-input { width: 100%; min-height: 40px; box-sizing: border-box; padding: 0 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 12px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-size: 14px; transition: border-color var(--app-dur-quick, 160ms) ease, box-shadow var(--app-dur-quick, 160ms) ease; }
.mcp-input:focus { outline: none; border-color: var(--app-accent-primary, #2563eb); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent-primary, #2563eb) 18%, transparent); }
.mcp-input.is-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.mcp-hint { font-size: 12px; line-height: 1.5; color: var(--app-text-muted, #94a3b8); }
.mcp-warn { font-size: 12px; font-weight: 700; line-height: 1.5; color: var(--app-warning-text, #b45309); }
.mcp-token { position: relative; }
.mcp-token .mcp-input { padding-right: 44px; }
.mcp-eye { position: absolute; top: 50%; right: 4px; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; transform: translateY(-50%); border: 0; border-radius: 10px; background: transparent; color: var(--app-text-muted, #94a3b8); cursor: pointer; }
.mcp-eye:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mcp-eye svg { width: 17px; height: 17px; }
.mcp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--app-text-secondary, #475569); cursor: pointer; user-select: none; }
.mcp-check input { width: 15px; height: 15px; accent-color: var(--app-accent-primary, #2563eb); }
.mcp-toggle-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; background: var(--app-surface-subtle, #f1f5f9); }
.mcp-toggle-copy { flex: 1; min-width: 0; display: grid; gap: 2px; }
.mcp-toggle-copy strong { font-size: 13.5px; }
.mcp-toggle-copy span { font-size: 12px; color: var(--app-text-muted, #94a3b8); }
.mcp-form-error { padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--app-danger-text, #dc2626) 8%, transparent); color: var(--app-danger-text, #dc2626); font-size: 12.5px; font-weight: 700; line-height: 1.5; }
.mcp-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.mcp-form-actions .mcp-btn { min-height: 38px; padding: 0 18px; font-size: 13px; }
@keyframes mcp-spin { to { transform: rotate(360deg); } }
@keyframes mcp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
body[data-reduced-motion='on'] .mcp-overlay *, body[data-reduced-motion='on'] .mcp-overlay *::after { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) { .mcp-overlay *, .mcp-overlay *::after { animation: none !important; transition: none !important; } }
@media (max-width: 640px) {
  .mcp-overlay { padding: var(--app-visual-offset-top, 0px) 0 0; align-items: flex-start; }
  .mcp-panel { width: 100%; height: var(--app-visual-height, 100dvh); border: 0; border-radius: 0; }
  .mcp-head { position: relative; padding: calc(14px + env(safe-area-inset-top, 0px)) 14px 12px; }
  /* 系统深色时状态栏图标是白色：在状态栏后垫一层遮罩（同聊天页） */
  .mcp-head::before { content: ''; position: absolute; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); background: linear-gradient(180deg, var(--app-statusbar-scrim, transparent) 50%, transparent); pointer-events: none; }
  .mcp-add { width: 38px; min-height: 38px; padding: 0; justify-content: center; }
  .mcp-add span { display: none; }
  .mcp-body { padding: 14px 14px calc(22px + env(safe-area-inset-bottom, 0px)); }
  .mcp-btn { min-height: 36px; }
  .mcp-form { padding: 16px 14px; }
}
`;

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  documentRef.head.appendChild(style);
};

const pad = value => String(value).padStart(2, '0');
const clock = (ms) => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };

/** 连接错误码 → 给用户看的说明（原始讯息只在没有对应说明时显示）。 */
export const describeMcpError = (code = '', message = '') => {
  const known = {
    mcp_network: '连不上这个地址：请确认服务在运行、地址正确',
    mcp_auth: '服务拒绝了授权：请检查令牌',
    mcp_http: '服务返回了错误状态：请确认地址指向 MCP 端点',
    mcp_protocol: '对方的回应不像 MCP 服务：请确认地址指向 MCP 端点',
    mcp_cancelled: '连接超时或已取消',
    mcp_limit: '回应太大，已停止读取',
    mcp_config_changed: '配置刚被改过，请再测一次',
  }[trim(code)];
  if (known) return t(known);
  if (trim(code) === 'mcp_remote_error') return t('服务报错：{detail}', { detail: trim(message).replace(/^MCP 服务报错：/, '') });
  return trim(message) ? t(trim(message)) : t('连接失败');
};

/** 一个服务的状态：tone（off｜busy｜ok｜error｜idle）、标签与说明。 */
export const describeMcpServerState = (server = {}, health = {}, { busy = false, toolCount = 0 } = {}) => {
  if (!server.enabled) return { tone: 'off', label: t('已停用'), detail: t('停用时女仆找不到它的工具') };
  if (busy) return { tone: 'busy', label: t('连接中…'), detail: '' };
  if (health.status === 'connected') {
    const parts = [t('{count} 个工具', { count: toolCount })];
    if (Number(health.checkedAt) > 0) parts.push(t('检查于 {time}', { time: clock(Number(health.checkedAt)) }));
    return { tone: 'ok', label: t('已连接'), detail: parts.join(' · ') };
  }
  if (health.status === 'failed') return { tone: 'error', label: t('连接失败'), detail: describeMcpError(health.lastErrorCode, health.lastError) };
  return { tone: 'idle', label: t('还没连接'), detail: t('点「测试连接」看看它有哪些工具') };
};

/** 地址拆成「主机」与「路径」两段显示。 */
export const splitMcpEndpoint = (url = '') => {
  try {
    const parsed = new URL(url);
    return { origin: `${parsed.protocol}//${parsed.host}`, path: parsed.pathname === '/' ? '' : parsed.pathname };
  } catch {
    return { origin: trim(url), path: '' };
  }
};

/**
 * store：McpServerStore；manager：createMcpManager 的结果。
 * isToolAllowed(operationType) / revokeTool(operationType)：「始终允许」规则的查询与撤销（键与确认请求相同）。
 */
export const createMcpServerPanel = ({
  documentRef = globalThis.document,
  store = null,
  manager = null,
  isToolAllowed = () => false,
  revokeTool = () => false,
} = {}) => {
  let overlay = null, body = null, subtitle = null, addButton = null;
  let view = 'list', editing = null, formError = '', saving = false, confirmDelete = '';
  const busy = new Set();
  const expanded = new Set();

  const h = (tag, className = '', text = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const raw = (tag, className, text) => { const el = h(tag, className, text); el.dataset.i18nSkip = ''; return el; };
  const button = (label, { icon = '', className = 'mcp-btn', onClick = null, disabled = false } = {}) => {
    const el = h('button', className);
    el.type = 'button';
    if (icon) el.innerHTML = icon;
    el.appendChild(h('span', '', label));
    el.disabled = disabled;
    if (onClick) el.addEventListener('click', onClick);
    return el;
  };
  const isOpen = () => Boolean(overlay?.classList.contains('is-open'));
  const servers = () => { try { return store?.list?.() || []; } catch { return []; } };
  const catalog = id => { try { return manager?.listCatalog?.(id) || []; } catch { return []; } };
  const healthOf = id => { try { return manager?.getHealth?.(id) || {}; } catch { return {}; } };

  const testConnection = async (id, { expand = false } = {}) => {
    if (!manager || busy.has(id)) return;
    busy.add(id);
    render();
    try {
      await manager.refresh(id);
      if (expand) expanded.add(id);
    } catch {} finally {
      busy.delete(id);
      if (isOpen()) render();
    }
  };

  const setEnabled = async (server, enabled, input) => {
    input.disabled = true;
    try {
      await store.save({ id: server.id, enabled }, { expectedRevision: server.revision });
    } catch {}
    if (enabled) void testConnection(server.id);
    else render();
  };

  const removeServer = async (server) => {
    confirmDelete = '';
    expanded.delete(server.id);
    try { await store.remove(server.id); } catch {}
    render();
  };

  const openForm = (server = null) => {
    view = 'form';
    editing = server;
    formError = '';
    confirmDelete = '';
    render();
  };
  const closeForm = () => {
    view = 'list';
    editing = null;
    formError = '';
    render();
  };

  const renderTool = (server, tool) => {
    const row = h('div', 'mcp-tool');
    const head = h('div', 'mcp-tool-head');
    head.appendChild(raw('code', 'mcp-tool-name', tool.name));
    if (trim(tool.title) && trim(tool.title) !== tool.name) head.appendChild(raw('span', 'mcp-tool-title', trim(tool.title)));
    if (tool.readOnlyHint) head.appendChild(h('span', 'mcp-chip', t('对方标示只读')));
    row.appendChild(head);
    if (trim(tool.description)) row.appendChild(raw('p', 'mcp-tool-desc', trim(tool.description)));
    const trust = h('div', 'mcp-tool-trust');
    const op = mcpOperationId({ serverId: server.id, endpointRevision: server.endpointRevision, toolName: tool.name, schemaHash: tool.schemaHash });
    if (isToolAllowed(op)) {
      const on = h('span', 'mcp-trust-on');
      on.innerHTML = ICONS.check;
      on.appendChild(h('span', '', t('始终允许')));
      trust.appendChild(on);
      const revoke = h('button', 'mcp-link', t('撤销'));
      revoke.type = 'button';
      revoke.setAttribute('aria-label', t('撤销「{tool}」的始终允许', { tool: tool.name }));
      revoke.addEventListener('click', () => { revokeTool(op); render(); });
      trust.appendChild(revoke);
    } else {
      trust.appendChild(h('span', '', t('每次调用前询问')));
    }
    row.appendChild(trust);
    return row;
  };

  const renderServer = (server) => {
    const tools = catalog(server.id);
    const health = healthOf(server.id);
    const state = describeMcpServerState(server, health, { busy: busy.has(server.id), toolCount: tools.length });
    const card = h('article', 'mcp-server');
    card.dataset.tone = state.tone;
    card.dataset.serverId = server.id;

    const main = h('div', 'mcp-server-main');
    const orb = h('span', 'mcp-orb');
    orb.innerHTML = ICONS.plug;
    main.appendChild(orb);
    const copy = h('div', 'mcp-server-copy');
    const nameRow = h('div', 'mcp-name-row');
    nameRow.appendChild(raw('span', 'mcp-name', server.name));
    if (server.hasToken) {
      const chip = h('span', 'mcp-chip');
      chip.innerHTML = ICONS.key;
      chip.appendChild(h('span', '', t('令牌已保存')));
      nameRow.appendChild(chip);
    }
    copy.appendChild(nameRow);
    const { origin, path } = splitMcpEndpoint(server.url);
    const url = raw('div', 'mcp-url');
    url.appendChild(h('b', '', origin));
    if (path) url.appendChild(h('span', '', path));
    copy.appendChild(url);
    const status = h('div', 'mcp-status');
    status.appendChild(h('span', 'mcp-status-label', state.label));
    if (state.detail && state.tone !== 'error') status.appendChild(h('span', 'mcp-status-detail', state.detail));
    copy.appendChild(status);
    main.appendChild(copy);
    const toggle = h('label', 'mcp-switch');
    const input = h('input');
    input.type = 'checkbox';
    input.checked = server.enabled;
    input.disabled = busy.has(server.id);
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', t('启用「{name}」', { name: server.name }));
    input.addEventListener('change', () => { void setEnabled(server, input.checked, input); });
    toggle.appendChild(input);
    toggle.appendChild(h('span', 'mcp-switch-track'));
    main.appendChild(toggle);
    card.appendChild(main);
    if (state.tone === 'error') card.appendChild(raw('div', 'mcp-alert', state.detail));

    const actions = h('div', 'mcp-actions');
    if (confirmDelete === server.id) {
      actions.appendChild(h('span', 'mcp-confirm', t('删除「{name}」？它的「始终允许」也会一并撤销。', { name: server.name })));
      actions.appendChild(button(t('取消'), { className: 'mcp-btn is-ghost', onClick: () => { confirmDelete = ''; render(); } }));
      actions.appendChild(button(t('删除'), { icon: ICONS.trash, className: 'mcp-btn is-danger-solid', onClick: () => { void removeServer(server); } }));
    } else {
      const test = button(t('测试连接'), {
        icon: ICONS.refresh,
        className: `mcp-btn${busy.has(server.id) ? ' mcp-spin' : ''}`,
        disabled: !server.enabled || busy.has(server.id),
        onClick: () => { void testConnection(server.id, { expand: true }); },
      });
      actions.appendChild(test);
      if (tools.length) {
        const open = expanded.has(server.id);
        const toggleTools = button(t('工具 {count}', { count: tools.length }), {
          icon: ICONS.chevron,
          className: `mcp-btn is-ghost${open ? ' is-open' : ''}`,
          onClick: () => { if (expanded.has(server.id)) expanded.delete(server.id); else expanded.add(server.id); render(); },
        });
        toggleTools.setAttribute('aria-expanded', open ? 'true' : 'false');
        actions.appendChild(toggleTools);
      }
      actions.appendChild(h('span', 'mcp-spacer'));
      actions.appendChild(button(t('编辑'), { icon: ICONS.edit, className: 'mcp-btn is-ghost', onClick: () => openForm(server) }));
      actions.appendChild(button(t('删除'), { icon: ICONS.trash, className: 'mcp-btn is-ghost is-danger', onClick: () => { confirmDelete = server.id; render(); } }));
    }
    card.appendChild(actions);

    if (expanded.has(server.id) && state.tone === 'ok') {
      const list = h('div', 'mcp-tools');
      if (tools.length) tools.forEach(tool => list.appendChild(renderTool(server, tool)));
      else list.appendChild(h('p', 'mcp-tools-empty', t('这个服务没有提供工具')));
      card.appendChild(list);
    }
    return card;
  };

  const renderForm = () => {
    const form = h('div', 'mcp-form');
    const head = h('div');
    head.appendChild(editing ? raw('h3', 'mcp-form-title', t('编辑「{name}」', { name: editing.name })) : h('h3', 'mcp-form-title', t('添加 MCP 服务')));
    head.appendChild(h('p', 'mcp-form-caption', t('填写服务的 Streamable HTTP 地址。保存后会自动连接一次，列出它的工具。')));
    form.appendChild(head);

    const field = (label, control, hint = '') => {
      const wrap = h('label', 'mcp-field');
      wrap.appendChild(h('span', 'mcp-field-label', label));
      wrap.appendChild(control);
      if (hint) wrap.appendChild(h('span', 'mcp-hint', hint));
      return wrap;
    };
    const name = h('input', 'mcp-input');
    name.type = 'text';
    name.maxLength = 80;
    name.value = editing?.name || '';
    name.placeholder = t('例如：我的笔记库');
    name.dataset.field = 'name';
    form.appendChild(field(t('名称'), name));

    const url = h('input', 'mcp-input is-mono');
    url.type = 'url';
    url.value = editing?.url || '';
    url.placeholder = 'https://example.com/mcp';
    url.spellcheck = false;
    url.setAttribute('autocomplete', 'off');
    url.dataset.field = 'url';
    form.appendChild(field(t('MCP 地址'), url, t('支持 HTTPS，或本机的 http://127.0.0.1、http://localhost；不要把令牌写进地址。')));

    const tokenWrap = h('div', 'mcp-field');
    tokenWrap.appendChild(h('span', 'mcp-field-label', t('访问令牌（可选）')));
    const tokenBox = h('div', 'mcp-token');
    const token = h('input', 'mcp-input is-mono');
    token.type = 'password';
    token.spellcheck = false;
    token.setAttribute('autocomplete', 'new-password');
    token.placeholder = editing?.hasToken ? t('已保存，留空保持不变') : t('没有就留空');
    token.dataset.field = 'token';
    const eye = h('button', 'mcp-eye');
    eye.type = 'button';
    eye.innerHTML = ICONS.eye;
    eye.setAttribute('aria-label', t('显示令牌'));
    eye.addEventListener('click', () => {
      const show = token.type === 'password';
      token.type = show ? 'text' : 'password';
      eye.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
      eye.setAttribute('aria-label', show ? t('隐藏令牌') : t('显示令牌'));
    });
    tokenBox.appendChild(token);
    tokenBox.appendChild(eye);
    tokenWrap.appendChild(tokenBox);
    tokenWrap.appendChild(h('span', 'mcp-hint', t('以 Bearer 方式发送，加密后只存在这台设备上。')));
    let clearToken = null;
    if (editing?.hasToken) {
      const check = h('label', 'mcp-check');
      clearToken = h('input');
      clearToken.type = 'checkbox';
      clearToken.dataset.field = 'clearToken';
      check.appendChild(clearToken);
      check.appendChild(h('span', '', t('清除已保存的令牌')));
      tokenWrap.appendChild(check);
    }
    const urlWarn = h('span', 'mcp-warn', t('改了地址，已保存的令牌会被清除；需要的话请重新填写。'));
    urlWarn.hidden = true;
    if (editing?.hasToken) {
      tokenWrap.appendChild(urlWarn);
      url.addEventListener('input', () => { urlWarn.hidden = trim(url.value) === editing.url; });
    }
    form.appendChild(tokenWrap);

    const toggleRow = h('div', 'mcp-toggle-row');
    const toggleCopy = h('div', 'mcp-toggle-copy');
    toggleCopy.appendChild(h('strong', '', t('启用')));
    toggleCopy.appendChild(h('span', '', t('启用后女仆可以找到并调用它的工具（每次都会先问你）')));
    toggleRow.appendChild(toggleCopy);
    const toggle = h('label', 'mcp-switch');
    const enabled = h('input');
    enabled.type = 'checkbox';
    enabled.checked = editing ? editing.enabled : true;
    enabled.setAttribute('role', 'switch');
    enabled.setAttribute('aria-label', t('启用'));
    enabled.dataset.field = 'enabled';
    toggle.appendChild(enabled);
    toggle.appendChild(h('span', 'mcp-switch-track'));
    toggleRow.appendChild(toggle);
    form.appendChild(toggleRow);

    const errorBox = raw('div', 'mcp-form-error', formError);
    errorBox.hidden = !formError;
    errorBox.setAttribute('role', 'alert');
    form.appendChild(errorBox);

    const submit = async () => {
      if (saving) return;
      const patch = { name: name.value, url: url.value, enabled: enabled.checked };
      if (editing) patch.id = editing.id;
      if (token.value) patch.token = token.value;
      else if (clearToken?.checked) patch.token = '';
      saving = true;
      save.disabled = true;
      try {
        const saved = await store.save(patch, editing ? { expectedRevision: editing.revision } : {});
        saving = false;
        view = 'list';
        editing = null;
        formError = '';
        render();
        if (saved.enabled) void testConnection(saved.id, { expand: true });
      } catch (error) {
        saving = false;
        save.disabled = false;
        formError = t(trim(error?.message) || '保存失败');
        errorBox.textContent = formError;
        errorBox.hidden = false;
      }
    };
    const actions = h('div', 'mcp-form-actions');
    actions.appendChild(button(t('取消'), { className: 'mcp-btn is-ghost', onClick: closeForm }));
    const save = button(t('保存'), { className: 'mcp-btn is-primary', onClick: () => { void submit(); } });
    save.dataset.action = 'save';
    actions.appendChild(save);
    form.appendChild(actions);
    form.addEventListener('keydown', (event) => {
      if (event?.key === 'Enter' && event.target?.tagName === 'INPUT' && event.target.type !== 'checkbox') {
        event.preventDefault?.();
        void submit();
      }
    });
    return { form, focus: name };
  };

  const render = () => {
    if (!body) return;
    const list = servers();
    const enabledCount = list.filter(server => server.enabled).length;
    subtitle.textContent = list.length
      ? t('已启用 {enabled} 个 · 共 {count} 个（最多 {limit} 个）', { enabled: enabledCount, count: list.length, limit: MCP_SERVER_LIMIT })
      : t('把外部工具接给女仆用');
    addButton.disabled = list.length >= MCP_SERVER_LIMIT;
    addButton.hidden = view === 'form' || !list.length; // 表单打开或空白时（中间有「添加服务」）不重复显示
    body.replaceChildren();
    if (view === 'form') {
      const { form, focus } = renderForm();
      body.appendChild(form);
      try { focus.focus?.({ preventScroll: true }); } catch {}
      return;
    }
    const note = h('div', 'mcp-note');
    note.innerHTML = ICONS.shield;
    note.appendChild(h('p', '', t('女仆每次调用外部工具前都会先问你，参数会发给对方服务，结果只当参考资料。对单个工具选「始终允许」后，勾选了「查询外部服务」的自建文字 Agent 也能用它查资料。')));
    body.appendChild(note);
    if (!list.length) {
      const empty = h('div', 'mcp-empty');
      const icon = h('span', 'mcp-empty-icon');
      icon.innerHTML = ICONS.plug;
      empty.appendChild(icon);
      empty.appendChild(h('h3', 'mcp-empty-title', t('还没有 MCP 服务')));
      empty.appendChild(h('p', 'mcp-empty-text', t('加入一个支持 Streamable HTTP 的 MCP 服务地址，女仆就能使用它提供的工具。')));
      empty.appendChild(button(t('添加服务'), { icon: ICONS.plus, className: 'mcp-btn is-primary', onClick: () => openForm() }));
      body.appendChild(empty);
      return;
    }
    list.forEach(server => body.appendChild(renderServer(server)));
  };

  const hide = () => {
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    view = 'list';
    editing = null;
    confirmDelete = '';
  };

  const ensure = () => {
    if (overlay) return;
    injectStyle(documentRef);
    overlay = h('div', 'mcp-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    const panel = h('div', 'mcp-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'mcp-head');
    const icon = h('span', 'mcp-head-icon');
    icon.innerHTML = ICONS.plug;
    const copy = h('div', 'mcp-head-copy');
    copy.appendChild(h('h2', 'mcp-title', t('MCP 服务')));
    subtitle = raw('p', 'mcp-subtitle');
    copy.appendChild(subtitle);
    addButton = button(t('添加'), { icon: ICONS.plus, className: 'mcp-add', onClick: () => openForm() });
    addButton.setAttribute('aria-label', t('添加服务')); // 窄屏只显示「+」
    const close = h('button', 'mcp-close');
    close.type = 'button';
    close.innerHTML = ICONS.close;
    close.setAttribute('aria-label', t('关闭'));
    close.addEventListener('click', () => hide());
    head.appendChild(icon);
    head.appendChild(copy);
    head.appendChild(addButton);
    head.appendChild(close);
    body = h('div', 'mcp-body');
    panel.appendChild(head);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) hide(); });
    documentRef.body.appendChild(overlay);
    store?.subscribe?.(() => { if (isOpen() && view === 'list') render(); });
  };

  return {
    show: () => {
      ensure();
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      render();
      // 打开时把还没连过的已启用服务各连一次，状态直接显示在卡上
      servers().filter(server => server.enabled && healthOf(server.id).status === 'unknown').forEach(server => { void testConnection(server.id); });
    },
    hide,
    refresh: render,
    isOpen,
    closeTopLayer: () => {
      if (!isOpen()) return false;
      if (view === 'form') { closeForm(); return true; }
      if (confirmDelete) { confirmDelete = ''; render(); return true; }
      hide();
      return true;
    },
    get overlay() { return overlay; },
  };
};
