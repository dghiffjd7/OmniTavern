// 「工具与手势」设置页（自定义工具、动作与手势计划）：列出用户工具，新增／编辑（名称、图标、动作与参数、
// 直接执行、快捷键），删除前在卡内确认。工具箱齿轮与通用设定都打开这一页，两边同一份设置。
import { t } from '../../i18n/index.js';
import {
  TOOL_ACTION_GROUPS, USER_TOOL_ICON_NAMES, TOOL_GESTURE_OPTIONS, TOOL_SCRIPT_CAPABILITIES, userToolIconMarkup, normalizeToolParams, describeUserTool, describeToolTarget,
  defaultToolName, defaultToolParams, toolGestureKey, isToolGestureCompatible, toolGestureLabel,
} from './user-tool-actions.js';
import { USER_TOOL_LIMIT, toolShortcutFromEvent, isReservedToolShortcut } from '../../storage/user-tool-store.js';
import { buildUserToolPack, parseUserToolPack, planUserToolImport } from './user-tool-pack.js';

const STYLE_ID = 'user-tool-settings-style';
// 新脚本的范例：注解逐行翻译（整段太长不能当一个翻译键）
const scriptTemplate = () => [
  `// ${t('ctx.message：这条消息（声明「读消息与选区」才有）；ctx.selection：选中的文字；ctx.recent：最近几条')}`,
  `// ${t('api.tool：getInput／setInput／insertInput／send／generate（调用模型）／fetch（联网）／notify')}`,
  `// ${t('回传 { input, send, replace, copy, notify }，由 APP 按声明的能力帮你套用')}`,
  "const text = ctx.message ? ctx.message.content : '';",
  `return { notify: ${JSON.stringify(t('这条消息的字数：'))} + text.length };`,
].join('\n');
const SCRIPT_HELP = [
  'ctx：trigger（触发方式）、tool、message（id、role、content、raw）、selection、recent（最近几条 role、content）。没声明「读消息与选区」时 message、selection、recent 都是空的。',
  'api.tool：getInput()、setInput(text)、insertInput(text)、send(text?) 需要「写输入框／发送」；generate({ prompt, system }) 用当前聊天的模型回一段文字、fetch(url, { method, headers, body }) 走 APP 的网络请求，都需要「调用模型／联网」；notify(text) 随时可用。',
  '回传物件：input 放进输入框、send: true 接着发送、replace 改这条消息（需要「改这条消息」）、copy 复制、notify 显示通知；回传字串等于通知。抛出错误会显示为执行失败。',
];
const trim = value => String(value ?? '').trim();

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
const ICONS = Object.freeze({
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  keyboard: svg('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>'),
  bolt: svg('<path d="m13 2-8 12h7l-1 8 8-12h-7Z"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  warn: svg('<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  hand: svg('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v8.5a6.5 6.5 0 0 1-12.2 3.2L3.5 15a1.6 1.6 0 0 1 2.7-1.7L8 15.5"/>'),
});

// 空白时的示例：点一下就把表单填好
const TEMPLATES = Object.freeze([
  { name: '删掉最后回复', icon: 'trash', action: { source: 'builtin', id: 'reply.delete', params: {} }, direct: true, label: '一键删除最后一条 AI 回复' },
  { name: '重新生成', icon: 'regenerate', action: { source: 'builtin', id: 'reply.regenerate', params: {} }, label: '重新生成最后一条回复' },
  { name: '继续', icon: 'phrase', action: { source: 'builtin', id: 'text.phrase', params: { text: '继续', mode: 'replace', send: true } }, label: '快捷短语「继续」并直接发送' },
  { name: 'AI 绘图', icon: 'image', action: { source: 'builtin', id: 'open.panel', params: { panel: 'image' } }, label: '打开 AI 绘图' },
]);

const STYLE = `
.uts-overlay { position: fixed; inset: 0; z-index: 22600; display: none; align-items: center; justify-content: center; padding: 12px; background: rgba(15, 23, 42, 0.34); }
.uts-overlay.is-open { display: flex; }
.uts-overlay [hidden] { display: none !important; }
.uts-panel { width: min(720px, 100%); height: min(840px, calc(var(--app-visual-height, 100dvh) - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 22px; background: linear-gradient(var(--app-surface-card, #fff), var(--app-surface-card, #fff)), var(--app-surface-page, #fff); color: var(--app-text-primary, #0f172a); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22); }
.uts-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px 14px; border-bottom: 1px solid var(--app-border-subtle, #eef2f7); }
.uts-head-icon { width: 42px; height: 42px; flex: 0 0 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; background: linear-gradient(140deg, color-mix(in srgb, var(--app-accent-primary, #2563eb) 22%, transparent), color-mix(in srgb, var(--app-accent-primary, #2563eb) 6%, transparent)); color: var(--app-accent-primary, #2563eb); }
.uts-head-icon svg { width: 21px; height: 21px; }
.uts-head-copy { flex: 1; min-width: 0; }
.uts-title { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: .01em; }
.uts-subtitle { margin: 3px 0 0; font-size: 12.5px; color: var(--app-text-secondary, #64748b); }
.uts-add { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px 0 11px; border: 0; border-radius: 999px; background: var(--app-accent-primary, #2563eb); color: var(--app-text-inverse, #fff); font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; transition: background var(--app-dur-quick, 160ms) ease, transform var(--app-dur-quick, 160ms) ease; }
.uts-add:hover:not(:disabled) { background: var(--app-accent-strong, #1d4ed8); }
.uts-add:active:not(:disabled) { transform: scale(.97); }
.uts-add:disabled { opacity: .45; cursor: not-allowed; }
.uts-add svg { width: 16px; height: 16px; }
.uts-close { width: 36px; height: 36px; flex: 0 0 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 50%; background: transparent; color: var(--app-text-secondary, #475569); cursor: pointer; }
.uts-close:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.uts-close svg { width: 18px; height: 18px; }
.uts-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 18px 24px; display: grid; gap: 12px; align-content: start; }
.uts-body > * { min-width: 0; }
.uts-note { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 16%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 6%, transparent); font-size: 12.5px; line-height: 1.6; color: var(--app-text-secondary, #475569); }
.uts-note svg { width: 18px; height: 18px; flex: 0 0 18px; margin-top: 1px; color: var(--app-accent-primary, #2563eb); }
.uts-note p { margin: 0; }
.uts-list { display: grid; gap: 10px; }
.uts-tool { border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 18px; background: var(--app-surface-card, #fff); overflow: hidden; transition: box-shadow var(--app-dur-quick, 160ms) ease; }
.uts-tool:hover { box-shadow: 0 6px 18px rgba(15, 23, 42, .06); }
.uts-tool.is-broken { border-color: color-mix(in srgb, var(--app-warning-text, #b45309) 35%, var(--app-border-default, #e2e8f0)); }
.uts-tool-main { display: flex; align-items: center; gap: 12px; padding: 13px 14px; }
.uts-tile { width: 42px; height: 42px; flex: 0 0 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 13px; background: linear-gradient(140deg, color-mix(in srgb, var(--app-accent-primary, #2563eb) 18%, transparent), color-mix(in srgb, var(--app-accent-primary, #2563eb) 5%, transparent)); color: var(--app-accent-primary, #2563eb); }
.uts-tile svg { width: 21px; height: 21px; }
.uts-tool.is-broken .uts-tile { background: color-mix(in srgb, var(--app-warning-text, #b45309) 12%, transparent); color: var(--app-warning-text, #b45309); }
.uts-tool-copy { flex: 1; min-width: 0; display: grid; gap: 4px; }
.uts-tool-name { font-size: 15px; font-weight: 800; overflow-wrap: anywhere; }
.uts-tool-desc { font-size: 12.5px; line-height: 1.5; color: var(--app-text-secondary, #64748b); overflow-wrap: anywhere; }
.uts-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.uts-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 0 8px; border-radius: 7px; background: var(--app-surface-subtle, #f1f5f9); color: var(--app-text-secondary, #475569); font-size: 11.5px; font-weight: 700; }
.uts-chip svg { width: 13px; height: 13px; }
.uts-chip.is-key { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.uts-chip.is-direct { background: color-mix(in srgb, var(--app-danger-text, #dc2626) 9%, transparent); color: var(--app-danger-text, #dc2626); }
.uts-chip.is-warn { background: color-mix(in srgb, var(--app-warning-text, #b45309) 12%, transparent); color: var(--app-warning-text, #b45309); }
.uts-tool-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.uts-icon-btn { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 11px; background: transparent; color: var(--app-text-secondary, #64748b); cursor: pointer; }
.uts-icon-btn:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.uts-icon-btn.is-danger:hover { color: var(--app-danger-text, #dc2626); }
.uts-icon-btn svg { width: 17px; height: 17px; }
.uts-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--app-border-subtle, #eef2f7); background: color-mix(in srgb, var(--app-danger-text, #dc2626) 5%, transparent); }
.uts-confirm span { flex: 1 1 200px; font-size: 12.5px; font-weight: 700; color: var(--app-danger-text, #dc2626); }
.uts-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 0 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 999px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; transition: border-color var(--app-dur-quick, 160ms) ease, color var(--app-dur-quick, 160ms) ease, background var(--app-dur-quick, 160ms) ease; }
.uts-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 42%, transparent); color: var(--app-accent-primary, #2563eb); }
.uts-btn:disabled { opacity: .5; cursor: not-allowed; }
.uts-btn svg { width: 15px; height: 15px; }
.uts-btn.is-ghost { border-color: transparent; background: transparent; color: var(--app-text-secondary, #64748b); }
.uts-btn.is-primary { border-color: var(--app-accent-primary, #2563eb); background: var(--app-accent-primary, #2563eb); color: var(--app-text-inverse, #fff); }
.uts-btn.is-primary:hover:not(:disabled) { border-color: var(--app-accent-strong, #1d4ed8); background: var(--app-accent-strong, #1d4ed8); color: var(--app-text-inverse, #fff); }
.uts-btn.is-danger-solid { border-color: var(--app-danger-text, #dc2626); background: var(--app-danger-text, #dc2626); color: var(--app-text-on-accent, #fff); }
.uts-empty { display: grid; justify-items: center; gap: 8px; padding: 32px 18px 26px; border: 1px dashed var(--app-border-default, #cbd5e1); border-radius: 18px; text-align: center; }
.uts-empty-icon { width: 56px; height: 56px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 4px; border-radius: 50%; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); }
.uts-empty-icon svg { width: 26px; height: 26px; }
.uts-empty-title { margin: 0; font-size: 15px; font-weight: 800; }
.uts-empty-text { margin: 0 0 4px; max-width: 380px; font-size: 12.5px; line-height: 1.6; color: var(--app-text-secondary, #64748b); }
.uts-templates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: 100%; max-width: 460px; margin: 6px 0 4px; }
.uts-template { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 14px; background: var(--app-surface-card, #fff); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color var(--app-dur-quick, 160ms) ease, transform var(--app-dur-quick, 160ms) ease; }
.uts-template:hover { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 40%, transparent); transform: translateY(-1px); }
.uts-template .uts-tile { width: 34px; height: 34px; flex-basis: 34px; border-radius: 11px; }
.uts-template .uts-tile svg { width: 18px; height: 18px; }
.uts-template span { font-size: 12.5px; font-weight: 700; line-height: 1.4; }
.uts-form { display: grid; gap: 18px; padding: 18px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 18px; background: var(--app-surface-card, #fff); }
.uts-form-title { margin: 0; font-size: 16px; font-weight: 800; overflow-wrap: anywhere; }
.uts-section { display: grid; gap: 8px; }
.uts-label { font-size: 12.5px; font-weight: 800; }
.uts-hint { font-size: 12px; line-height: 1.5; color: var(--app-text-muted, #94a3b8); }
.uts-input, .uts-textarea, .uts-select { width: 100%; box-sizing: border-box; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 12px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-size: 14px; transition: border-color var(--app-dur-quick, 160ms) ease, box-shadow var(--app-dur-quick, 160ms) ease; }
.uts-input, .uts-select { min-height: 40px; padding: 0 12px; }
.uts-textarea { min-height: 84px; padding: 10px 12px; resize: vertical; line-height: 1.5; }
.uts-input:focus, .uts-textarea:focus, .uts-select:focus { outline: none; border-color: var(--app-accent-primary, #2563eb); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent-primary, #2563eb) 18%, transparent); }
.uts-icons { display: flex; flex-wrap: wrap; gap: 6px; }
.uts-icon-choice { width: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 11px; background: var(--app-surface-card, #fff); color: var(--app-text-secondary, #64748b); cursor: pointer; transition: border-color var(--app-dur-quick, 160ms) ease, color var(--app-dur-quick, 160ms) ease, background var(--app-dur-quick, 160ms) ease; }
.uts-icon-choice svg { width: 18px; height: 18px; }
.uts-icon-choice:hover { color: var(--app-accent-primary, #2563eb); }
.uts-icon-choice.is-selected { border-color: var(--app-accent-primary, #2563eb); background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); }
.uts-actions-box { display: grid; gap: 12px; max-height: 320px; overflow: auto; padding: 4px 2px; }
.uts-group-title { margin: 0 0 4px; font-size: 11.5px; font-weight: 800; letter-spacing: .04em; color: var(--app-text-muted, #94a3b8); }
.uts-action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.uts-action { display: flex; align-items: flex-start; gap: 10px; padding: 10px 11px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 13px; background: var(--app-surface-card, #fff); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color var(--app-dur-quick, 160ms) ease, background var(--app-dur-quick, 160ms) ease; }
.uts-action:hover { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 36%, transparent); }
.uts-action.is-selected { border-color: var(--app-accent-primary, #2563eb); background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 8%, transparent); box-shadow: inset 0 0 0 1px var(--app-accent-primary, #2563eb); }
.uts-action > svg { width: 18px; height: 18px; flex: 0 0 18px; margin-top: 1px; color: var(--app-accent-primary, #2563eb); }
.uts-action-copy { display: grid; gap: 2px; min-width: 0; }
.uts-action-title { font-size: 13px; font-weight: 800; overflow-wrap: anywhere; }
.uts-action-desc { font-size: 11.5px; line-height: 1.45; color: var(--app-text-secondary, #64748b); }
.uts-params { display: grid; gap: 12px; padding: 14px; border-radius: 14px; background: var(--app-surface-subtle, #f1f5f9); }
.uts-param { display: grid; gap: 6px; }
.uts-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; cursor: pointer; user-select: none; }
.uts-check input { width: 16px; height: 16px; accent-color: var(--app-accent-primary, #2563eb); }
.uts-toggle-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; background: color-mix(in srgb, var(--app-danger-text, #dc2626) 6%, transparent); }
.uts-toggle-copy { flex: 1; min-width: 0; display: grid; gap: 2px; }
.uts-toggle-copy strong { font-size: 13.5px; }
.uts-toggle-copy span { font-size: 12px; color: var(--app-text-secondary, #64748b); }
.uts-switch { position: relative; flex: 0 0 auto; width: 44px; height: 26px; cursor: pointer; }
.uts-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.uts-switch-track { position: absolute; inset: 0; border-radius: 999px; background: var(--app-border-strong, #cbd5e1); transition: background var(--app-dur-quick, 160ms) ease; }
.uts-switch-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--app-text-on-accent, #fff); box-shadow: 0 1px 3px var(--app-shadow-color, rgba(15, 23, 42, .25)); transition: transform 180ms var(--app-ease-out, ease); }
.uts-switch input:checked + .uts-switch-track { background: var(--app-accent-primary, #2563eb); }
.uts-switch input:checked + .uts-switch-track::after { transform: translateX(18px); }
.uts-switch input:focus-visible + .uts-switch-track { outline: 2px solid var(--app-accent-primary, #2563eb); outline-offset: 2px; }
.uts-shortcut-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.uts-key { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px; border: 1px dashed var(--app-border-strong, #cbd5e1); border-radius: 12px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; font-weight: 700; cursor: pointer; }
.uts-key svg { width: 17px; height: 17px; color: var(--app-text-muted, #94a3b8); }
.uts-key.is-recording { border-style: solid; border-color: var(--app-accent-primary, #2563eb); color: var(--app-accent-primary, #2563eb); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent-primary, #2563eb) 16%, transparent); animation: uts-pulse 1.2s ease-in-out infinite; }
.uts-key.is-empty { color: var(--app-text-muted, #94a3b8); font-family: inherit; font-weight: 600; }
.uts-code { width: 100%; min-height: 220px; box-sizing: border-box; padding: 12px 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 12px; background: var(--app-surface-subtle, #f8fafc); color: var(--app-text-primary, #0f172a); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.6; tab-size: 2; resize: vertical; white-space: pre; overflow: auto; }
.uts-code:focus { outline: none; border-color: var(--app-accent-primary, #2563eb); box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent-primary, #2563eb) 18%, transparent); }
.uts-caps { display: grid; gap: 6px; }
.uts-cap { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 12px; background: var(--app-surface-card, #fff); cursor: pointer; }
.uts-cap input { width: 16px; height: 16px; margin-top: 2px; flex: 0 0 auto; accent-color: var(--app-accent-primary, #2563eb); }
.uts-cap-copy { display: grid; gap: 2px; min-width: 0; }
.uts-cap-copy strong { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.uts-cap-copy span { font-size: 11.5px; line-height: 1.5; color: var(--app-text-secondary, #64748b); }
.uts-cap.is-risky strong::after { content: attr(data-risk); padding: 0 6px; border-radius: 6px; background: color-mix(in srgb, var(--app-warning-text, #b45309) 14%, transparent); color: var(--app-warning-text, #b45309); font-size: 10.5px; font-weight: 800; line-height: 18px; }
.uts-help { border-radius: 12px; background: var(--app-surface-subtle, #f1f5f9); }
.uts-help summary { padding: 9px 12px; font-size: 12.5px; font-weight: 800; color: var(--app-text-secondary, #475569); cursor: pointer; }
.uts-help ul { margin: 0; padding: 0 14px 12px 30px; display: grid; gap: 6px; font-size: 12px; line-height: 1.6; color: var(--app-text-secondary, #64748b); }
.uts-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.uts-toolbar .uts-spacer { flex: 1; }
.uts-flash { padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--app-success-text, #059669) 10%, transparent); color: var(--app-success-text, #059669); font-size: 12.5px; font-weight: 700; }
.uts-flash.is-error { background: color-mix(in srgb, var(--app-danger-text, #dc2626) 8%, transparent); color: var(--app-danger-text, #dc2626); }
.uts-pack-list { display: grid; gap: 8px; }
.uts-pack-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: start; gap: 10px; padding: 11px 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 14px; background: var(--app-surface-card, #fff); }
.uts-pack-row.is-off { opacity: .55; }
.uts-pack-row > input { width: 16px; height: 16px; margin-top: 12px; accent-color: var(--app-accent-primary, #2563eb); }
.uts-pack-row .uts-tile { width: 36px; height: 36px; flex-basis: 36px; border-radius: 11px; }
.uts-pack-row .uts-tile svg { width: 18px; height: 18px; }
.uts-pack-copy { display: grid; gap: 4px; min-width: 0; }
.uts-pack-name { font-size: 14px; font-weight: 800; overflow-wrap: anywhere; }
.uts-pack-note { font-size: 12px; line-height: 1.5; color: var(--app-text-secondary, #64748b); }
.uts-pack-note.is-warn { color: var(--app-warning-text, #b45309); font-weight: 700; }
.uts-pack-row .uts-select { min-height: 34px; font-size: 13px; }
.uts-gestures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.uts-gesture { display: grid; gap: 2px; padding: 9px 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 12px; background: var(--app-surface-card, #fff); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color var(--app-dur-quick, 160ms) ease, background var(--app-dur-quick, 160ms) ease; }
.uts-gesture strong { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.uts-gesture strong svg { width: 15px; height: 15px; color: var(--app-text-muted, #94a3b8); }
.uts-gesture small { font-size: 11.5px; color: var(--app-text-muted, #94a3b8); }
.uts-gesture:hover:not(:disabled) { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 36%, transparent); }
.uts-gesture[aria-pressed="true"] { border-color: var(--app-accent-primary, #2563eb); background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 8%, transparent); box-shadow: inset 0 0 0 1px var(--app-accent-primary, #2563eb); }
.uts-gesture[aria-pressed="true"] strong svg { color: var(--app-accent-primary, #2563eb); }
.uts-gesture[aria-pressed="true"] small.is-move { color: var(--app-warning-text, #b45309); font-weight: 700; }
.uts-gesture:disabled { opacity: .45; cursor: not-allowed; }
.uts-key-error { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; font-weight: 700; color: var(--app-warning-text, #b45309); }
.uts-form-error { padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--app-danger-text, #dc2626) 8%, transparent); color: var(--app-danger-text, #dc2626); font-size: 12.5px; font-weight: 700; line-height: 1.5; }
.uts-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.uts-form-actions .uts-btn { min-height: 38px; padding: 0 18px; font-size: 13px; }
@keyframes uts-pulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent-primary, #2563eb) 16%, transparent); } 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--app-accent-primary, #2563eb) 6%, transparent); } }
body[data-reduced-motion='on'] .uts-overlay *, body[data-reduced-motion='on'] .uts-overlay *::after { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) { .uts-overlay *, .uts-overlay *::after { animation: none !important; transition: none !important; } }
@media (max-width: 640px) {
  .uts-overlay { padding: var(--app-visual-offset-top, 0px) 0 0; align-items: flex-start; }
  .uts-panel { width: 100%; height: var(--app-visual-height, 100dvh); border: 0; border-radius: 0; }
  .uts-head { position: relative; padding: calc(14px + env(safe-area-inset-top, 0px)) 14px 12px; }
  /* 系统深色时状态栏图标是白色：在状态栏后垫一层遮罩（同聊天页） */
  .uts-head::before { content: ''; position: absolute; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); background: linear-gradient(180deg, var(--app-statusbar-scrim, transparent) 50%, transparent); pointer-events: none; }
  .uts-body { padding: 14px 14px calc(22px + env(safe-area-inset-bottom, 0px)); }
  .uts-add { width: 38px; min-height: 38px; padding: 0; justify-content: center; }
  .uts-add span { display: none; }
  .uts-action-grid, .uts-templates { grid-template-columns: minmax(0, 1fr); }
  .uts-gesture { padding: 10px 12px; }
  .uts-form { padding: 16px 14px; }
}
`;

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  documentRef.head.appendChild(style);
};

/**
 * store：UserToolStore；listActions() → 可选动作（内建＋Agent，含 group）；getAction(source, id) → 动作或 null；
 * shortcutTaken(shortcut) → 被 APP 自己占用时的说明（例如打开工具箱的快捷键），没有则 ''。
 */
export const createUserToolSettingsPanel = ({
  documentRef = globalThis.document,
  store = null,
  listActions = () => [],
  getAction = () => null,
  shortcutTaken = () => '',
  confirmScriptCapabilities = async () => true,
  exportPack = async () => ({ cancelled: true }),
  pickPackText = async () => null,
} = {}) => {
  let overlay = null, body = null, subtitle = null, addButton = null;
  let view = 'list', confirmDelete = '', draft = null, formError = '', saving = false;
  let flash = null, exportDraft = null, importPlan = null;
  let recording = false, detachRecorder = null, revealAction = false;
  const win = documentRef?.defaultView || globalThis;

  const h = (tag, className = '', text = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const raw = (tag, className, text) => { const el = h(tag, className, text); el.dataset.i18nSkip = ''; return el; };
  const button = (label, { icon = '', className = 'uts-btn', onClick = null, disabled = false, key = '' } = {}) => {
    const el = h('button', className);
    el.type = 'button';
    if (icon) el.innerHTML = icon;
    if (label) el.appendChild(h('span', '', label));
    el.disabled = disabled;
    if (key) el.dataset.key = key;
    if (onClick) el.addEventListener('click', onClick);
    return el;
  };
  const isOpen = () => Boolean(overlay?.classList.contains('is-open'));
  const tools = () => { try { return store?.listTools?.() || []; } catch { return []; } };
  const shortcutOf = id => store?.listBindings?.({ toolId: id })?.find(binding => binding.kind === 'shortcut')?.shortcut || null;
  const gesturesOf = id => (store?.listBindings?.({ toolId: id }) || []).filter(binding => binding.kind === 'gesture').map(binding => binding.gesture);

  const stopRecording = () => {
    recording = false;
    detachRecorder?.();
    detachRecorder = null;
  };

  // ---------- 列表 ----------
  const renderTool = (tool) => {
    const action = getAction(tool.action.source, tool.action.id);
    const card = h('article', `uts-tool${action ? '' : ' is-broken'}`);
    card.dataset.toolId = tool.id;
    const main = h('div', 'uts-tool-main');
    const tile = h('span', 'uts-tile');
    tile.innerHTML = userToolIconMarkup(tool.icon || action?.icon);
    main.appendChild(tile);
    const copy = h('div', 'uts-tool-copy');
    copy.appendChild(raw('span', 'uts-tool-name', tool.name));
    // 说明和名称一样时（例如「复制这条」），改说它作用在哪条消息
    const summary = describeUserTool(tool, action);
    const target = summary === tool.name ? describeToolTarget(action) : '';
    const desc = summary !== tool.name ? summary : target ? t('作用于：{target}', { target: t(target) }) : '';
    if (desc) copy.appendChild(raw('span', 'uts-tool-desc', desc));
    const chips = h('div', 'uts-chips');
    const shortcut = shortcutOf(tool.id);
    if (shortcut) {
      const chip = raw('span', 'uts-chip is-key');
      chip.innerHTML = ICONS.keyboard;
      chip.appendChild(h('span', '', shortcut.label));
      chips.appendChild(chip);
    }
    gesturesOf(tool.id).forEach((gesture) => {
      const chip = h('span', 'uts-chip');
      chip.innerHTML = ICONS.hand;
      chip.appendChild(h('span', '', t(toolGestureLabel(gesture))));
      chips.appendChild(chip);
    });
    if (action?.directable && tool.direct) chips.appendChild(h('span', 'uts-chip is-direct', t('直接执行')));
    if (!action) {
      const chip = h('span', 'uts-chip is-warn');
      chip.innerHTML = ICONS.warn;
      chip.appendChild(h('span', '', tool.action.source === 'agent' ? t('Agent 已不存在') : t('动作不可用')));
      chips.appendChild(chip);
    }
    if (chips.children.length) copy.appendChild(chips);
    main.appendChild(copy);
    const actions = h('div', 'uts-tool-actions');
    const edit = button('', { icon: ICONS.edit, className: 'uts-icon-btn', onClick: () => openEditor(tool) });
    edit.setAttribute('aria-label', t('编辑「{name}」', { name: tool.name }));
    const remove = button('', { icon: ICONS.trash, className: 'uts-icon-btn is-danger', onClick: () => { confirmDelete = tool.id; render(); } });
    remove.setAttribute('aria-label', t('删除「{name}」', { name: tool.name }));
    actions.appendChild(edit);
    actions.appendChild(remove);
    main.appendChild(actions);
    card.appendChild(main);
    if (confirmDelete === tool.id) {
      const confirm = h('div', 'uts-confirm');
      confirm.appendChild(h('span', '', t('删除「{name}」？它的快捷键与手势也会一起移除。', { name: tool.name })));
      confirm.appendChild(button(t('取消'), { className: 'uts-btn is-ghost', onClick: () => { confirmDelete = ''; render(); } }));
      confirm.appendChild(button(t('删除'), { icon: ICONS.trash, className: 'uts-btn is-danger-solid', onClick: async () => {
        confirmDelete = '';
        try { await store.removeTool(tool.id); } catch {}
        render();
      } }));
      card.appendChild(confirm);
    }
    return card;
  };

  // ---------- 导入导出 ----------
  const ownerName = binding => (binding ? (store.getTool(binding.toolId)?.name || '') : '');
  const openExport = () => {
    exportDraft = { selected: new Set(tools().map(tool => tool.id)), includeBindings: true };
    view = 'export';
    flash = null;
    render();
  };
  const openImport = async () => {
    flash = null;
    const text = await pickPackText();
    if (text === null || text === undefined) return;
    const parsed = parseUserToolPack(text);
    if (!parsed.ok) { flash = { error: true, text: t(parsed.error) }; render(); return; }
    const agentActions = listActions().filter(action => action.source === 'agent');
    importPlan = {
      pack: parsed.pack,
      ...planUserToolImport({
        pack: parsed.pack,
        resolveAction: getAction,
        listAgentActions: () => agentActions,
        findShortcut: shortcut => (store.findShortcut(shortcut) ? { toolName: ownerName(store.findShortcut(shortcut)) } : null),
        findGesture: (position, gesture) => (store.findGesture(position, gesture) ? { toolName: ownerName(store.findGesture(position, gesture)) } : null),
        existingNames: tools().map(tool => tool.name),
      }),
    };
    view = 'import';
    render();
  };
  const packRequirement = (item) => {
    const list = item.tool.action.source === 'agent' ? importPlan.pack.requires?.agents : importPlan.pack.requires?.plugins;
    return (Array.isArray(list) ? list : []).find(entry => entry?.id === item.tool.action.id) || null;
  };

  const renderExport = () => {
    const wrap = h('div', 'uts-form');
    wrap.appendChild(h('h3', 'uts-form-title', t('导出工具包')));
    wrap.appendChild(h('span', 'uts-hint', t('不包含密钥与聊天内容；用到的 Agent、插件只记名称，导入时可以重新对应。')));
    const list = h('div', 'uts-pack-list');
    tools().forEach((tool) => {
      const action = getAction(tool.action.source, tool.action.id);
      const row = h('label', `uts-pack-row${exportDraft.selected.has(tool.id) ? '' : ' is-off'}`);
      const box = h('input');
      box.type = 'checkbox';
      box.checked = exportDraft.selected.has(tool.id);
      box.dataset.exportTool = tool.id;
      box.addEventListener('change', () => { if (box.checked) exportDraft.selected.add(tool.id); else exportDraft.selected.delete(tool.id); render(); });
      row.appendChild(box);
      const tile = h('span', 'uts-tile');
      tile.innerHTML = userToolIconMarkup(tool.icon || action?.icon);
      row.appendChild(tile);
      const copy = h('span', 'uts-pack-copy');
      copy.appendChild(raw('span', 'uts-pack-name', tool.name));
      copy.appendChild(raw('span', 'uts-pack-note', describeUserTool(tool, action)));
      row.appendChild(copy);
      list.appendChild(row);
    });
    wrap.appendChild(list);
    const bindingRow = h('label', 'uts-check');
    const bindingBox = h('input');
    bindingBox.type = 'checkbox';
    bindingBox.checked = exportDraft.includeBindings;
    bindingBox.dataset.field = 'includeBindings';
    bindingBox.addEventListener('change', () => { exportDraft.includeBindings = bindingBox.checked; });
    bindingRow.appendChild(bindingBox);
    bindingRow.appendChild(h('span', '', t('包含快捷键与手势')));
    wrap.appendChild(bindingRow);
    const actions = h('div', 'uts-form-actions');
    actions.appendChild(button(t('取消'), { className: 'uts-btn is-ghost', onClick: () => { view = 'list'; render(); } }));
    const count = exportDraft.selected.size;
    actions.appendChild(button(t('导出（{count} 个）', { count }), { icon: ICONS.download, className: 'uts-btn is-primary', key: 'do-export', disabled: !count, onClick: async () => {
      const selected = tools().filter(tool => exportDraft.selected.has(tool.id));
      const pack = buildUserToolPack({ tools: selected, bindings: store.listBindings(), includeBindings: exportDraft.includeBindings, describeAction: getAction });
      const stamp = new Date().toISOString().slice(0, 10);
      try {
        const result = await exportPack(pack, `omnitavern-tools-${stamp}.json`);
        if (result?.cancelled) return;
        view = 'list';
        flash = { text: t('已导出 {count} 个工具', { count: selected.length }) };
      } catch (error) {
        flash = { error: true, text: t(trim(error?.message) || '导出失败') };
      }
      render();
    } }));
    wrap.appendChild(actions);
    return wrap;
  };

  const renderImport = () => {
    const wrap = h('div', 'uts-form');
    wrap.appendChild(h('h3', 'uts-form-title', t('导入工具包')));
    wrap.appendChild(h('span', 'uts-hint', t('导入的是新工具，不会覆盖现有的；按键或手势已被占用的就不绑定。')));
    const list = h('div', 'uts-pack-list');
    importPlan.items.forEach((item) => {
      const action = item.status === 'needs_agent' ? (item.agentChoice ? getAction('agent', item.agentChoice) : null) : getAction(item.tool.action.source, item.tool.action.id);
      const row = h('div', `uts-pack-row${item.include ? '' : ' is-off'}`);
      row.dataset.importKey = item.key;
      const box = h('input');
      box.type = 'checkbox';
      box.checked = item.include;
      box.disabled = item.status === 'unknown_action';
      box.dataset.importTool = item.key;
      box.addEventListener('change', () => { item.include = box.checked; render(); });
      row.appendChild(box);
      const tile = h('span', 'uts-tile');
      tile.innerHTML = userToolIconMarkup(item.tool.icon || action?.icon);
      row.appendChild(tile);
      const copy = h('span', 'uts-pack-copy');
      copy.appendChild(raw('span', 'uts-pack-name', item.tool.name));
      if (action) copy.appendChild(raw('span', 'uts-pack-note', describeUserTool(item.tool, action)));
      const requirement = packRequirement(item);
      if (item.status === 'needs_agent') {
        copy.appendChild(raw('span', 'uts-pack-note is-warn', t('需要 Agent「{name}」，请选对应的：', { name: requirement?.title || item.tool.action.id })));
        const select = h('select', 'uts-select');
        select.dataset.agentFor = item.key;
        const skip = h('option', '', t('跳过这个工具'));
        skip.value = '';
        select.appendChild(skip);
        item.agentOptions.forEach((option) => {
          const node = raw('option', '', option.title);
          node.value = option.id;
          select.appendChild(node);
        });
        select.value = item.agentChoice;
        select.addEventListener('change', () => { item.agentChoice = select.value; item.include = Boolean(select.value); render(); });
        copy.appendChild(select);
      } else if (item.status === 'missing_plugin') {
        copy.appendChild(raw('span', 'uts-pack-note is-warn', t('需要插件「{name}」，装好后才能用', { name: requirement?.pluginName || requirement?.title || item.tool.action.id })));
      } else if (item.status === 'needs_approval') {
        const caps = TOOL_SCRIPT_CAPABILITIES.filter(cap => item.tool.script?.capabilities?.includes(cap.id)).map(cap => t(cap.title));
        copy.appendChild(h('span', 'uts-pack-note is-warn', t('脚本：导入后打开这个工具保存一次，确认它要用的能力（{caps}）', { caps: caps.join('、') || t('不需要额外能力') })));
      } else if (item.status === 'unknown_action') {
        copy.appendChild(h('span', 'uts-pack-note is-warn', t('这个版本没有这个动作，无法导入')));
      }
      if (item.bindings.length) {
        const chips = h('span', 'uts-chips');
        item.bindings.forEach((binding) => {
          const label = binding.kind === 'shortcut' ? binding.shortcut.label : t(toolGestureLabel(binding.gesture));
          const chip = raw('span', `uts-chip${binding.conflict ? ' is-warn' : ''}`, binding.conflict ? t('{label}（已被「{name}」使用，不绑定）', { label, name: binding.conflict }) : label);
          chips.appendChild(chip);
        });
        copy.appendChild(chips);
      }
      row.appendChild(copy);
      list.appendChild(row);
    });
    wrap.appendChild(list);
    const chosen = importPlan.items.filter(item => item.include && (item.status !== 'needs_agent' || item.agentChoice));
    const room = USER_TOOL_LIMIT - tools().length;
    if (chosen.length > room) wrap.appendChild(h('span', 'uts-key-error', t('最多再加 {count} 个工具，请少选一些', { count: Math.max(0, room) })));
    const errorBox = raw('div', 'uts-form-error', formError);
    errorBox.hidden = !formError;
    wrap.appendChild(errorBox);
    const actions = h('div', 'uts-form-actions');
    actions.appendChild(button(t('取消'), { className: 'uts-btn is-ghost', onClick: () => { view = 'list'; importPlan = null; formError = ''; render(); } }));
    actions.appendChild(button(t('导入（{count} 个）', { count: chosen.length }), { icon: ICONS.upload, className: 'uts-btn is-primary', key: 'do-import', disabled: !chosen.length || chosen.length > room, onClick: async () => {
      if (saving) return;
      saving = true;
      let done = 0;
      const failed = [];
      for (const item of chosen) {
        try {
          const actionRef = item.status === 'needs_agent' ? { source: 'agent', id: item.agentChoice, params: item.tool.action.params } : item.tool.action;
          const saved = await store.saveTool({
            name: item.tool.name,
            icon: item.tool.icon,
            action: actionRef,
            direct: item.tool.direct,
            // 脚本的能力要在这台设备上重新确认才会执行
            ...(item.tool.script ? { script: { ...item.tool.script, approved: [] } } : {}),
          });
          for (const binding of item.bindings) {
            if (binding.conflict) continue;
            if (binding.kind === 'shortcut') await store.setShortcut(saved.id, binding.shortcut).catch(() => {});
            else await store.setGesture(saved.id, binding.gesture).catch(() => {});
          }
          done += 1;
        } catch (error) {
          failed.push(`${item.tool.name}：${t(trim(error?.message) || '导入失败')}`);
        }
      }
      saving = false;
      importPlan = null;
      view = 'list';
      formError = '';
      flash = failed.length ? { error: true, text: `${t('已导入 {count} 个工具', { count: done })}；${failed.join('；')}` } : { text: t('已导入 {count} 个工具', { count: done }) };
      render();
    } }));
    wrap.appendChild(actions);
    return wrap;
  };

  const renderToolbar = (list) => {
    const bar = h('div', 'uts-toolbar');
    bar.appendChild(button(t('导入工具包'), { icon: ICONS.upload, className: 'uts-btn', key: 'import', onClick: () => { void openImport(); } }));
    bar.appendChild(button(t('导出'), { icon: ICONS.download, className: 'uts-btn', key: 'export', disabled: !list.length, onClick: openExport }));
    return bar;
  };

  const renderList = () => {
    const list = tools();
    if (flash) body.appendChild(raw('div', `uts-flash${flash.error ? ' is-error' : ''}`, flash.text));
    const note = h('div', 'uts-note');
    note.innerHTML = ICONS.info;
    note.appendChild(h('p', '', t('工具会出现在聊天输入区的工具箱里（可在工具箱齿轮隐藏或排序），也可以设快捷键或手势。工具全局生效，不随预设或角色卡变化。')));
    body.appendChild(note);
    body.appendChild(renderToolbar(list));
    if (!list.length) {
      const empty = h('div', 'uts-empty');
      const icon = h('span', 'uts-empty-icon');
      icon.innerHTML = ICONS.bolt;
      empty.appendChild(icon);
      empty.appendChild(h('h3', 'uts-empty-title', t('还没有工具')));
      empty.appendChild(h('p', 'uts-empty-text', t('把常用操作做成一键工具：重新生成、删除最后回复、快捷短语、打开功能……从示例开始，或自己新建。')));
      const templates = h('div', 'uts-templates');
      TEMPLATES.forEach((template) => {
        const choice = h('button', 'uts-template');
        choice.type = 'button';
        const tile = h('span', 'uts-tile');
        tile.innerHTML = userToolIconMarkup(template.icon);
        choice.appendChild(tile);
        choice.appendChild(h('span', '', t(template.label)));
        choice.addEventListener('click', () => openEditor(null, { name: t(template.name), icon: template.icon, action: template.action, direct: template.direct === true }));
        templates.appendChild(choice);
      });
      empty.appendChild(templates);
      empty.appendChild(button(t('新建工具'), { icon: ICONS.plus, className: 'uts-btn is-primary', onClick: () => openEditor() }));
      body.appendChild(empty);
      return;
    }
    const wrap = h('div', 'uts-list');
    list.forEach(tool => wrap.appendChild(renderTool(tool)));
    body.appendChild(wrap);
  };

  // ---------- 编辑 ----------
  const openEditor = (tool = null, preset = null) => {
    const source = tool || preset || {};
    const shortcut = tool ? shortcutOf(tool.id) : null;
    draft = {
      id: tool?.id || '',
      revision: tool?.revision,
      name: source.name || '',
      icon: source.icon || '',
      iconTouched: Boolean(tool?.icon),
      nameTouched: Boolean(tool),
      autoName: '',
      action: source.action ? { source: source.action.source, id: source.action.id, params: { ...(source.action.params || {}) } } : null,
      direct: source.direct === true,
      shortcut,
      shortcutChanged: false,
      shortcutReplace: false,
      shortcutError: '',
      shortcutConflict: '',
      gestures: new Set((tool ? gesturesOf(tool.id) : []).map(gesture => toolGestureKey(gesture.position, gesture.gesture))),
      gesturesChanged: false,
      script: source.script ? { code: String(source.script.code || ''), capabilities: [...(source.script.capabilities || [])], approved: [...(source.script.approved || [])] } : null,
    };
    view = 'form';
    formError = '';
    confirmDelete = '';
    revealAction = true;
    render();
  };
  const closeEditor = () => {
    stopRecording();
    view = 'list';
    draft = null;
    formError = '';
    render();
  };

  // 名称没手动改过（或还是上次自动带入的）就跟着动作与参数走
  const followName = (action) => {
    if (draft.nameTouched && trim(draft.name) !== trim(draft.autoName)) return;
    draft.name = defaultToolName(action, draft.action?.params || {});
    draft.autoName = draft.name;
  };
  const chooseAction = (action) => {
    if (!draft.iconTouched) draft.icon = action.icon || 'bolt';
    const sameAction = draft.action?.source === action.source && draft.action?.id === action.id;
    draft.action = { source: action.source, id: action.id, params: sameAction ? draft.action.params : defaultToolParams(action) };
    if (!action.directable) draft.direct = false;
    if (action.source === 'script' && !draft.script) draft.script = { code: scriptTemplate(), capabilities: ['read'], approved: [] };
    // 换了动作：去掉和新动作对不上的位置手势
    TOOL_GESTURE_OPTIONS.forEach((option) => {
      const key = toolGestureKey(option.position, option.gesture);
      if (draft.gestures.has(key) && !isToolGestureCompatible(option, action)) { draft.gestures.delete(key); draft.gesturesChanged = true; }
    });
    followName(action);
    render();
  };

  const startRecording = () => {
    recording = true;
    draft.shortcutError = '';
    draft.shortcutConflict = '';
    const onKey = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Tab') { stopRecording(); render(); return; }
      event.preventDefault();
      event.stopImmediatePropagation?.();
      if (event.key === 'Escape') { stopRecording(); render(); return; }
      if (event.repeat || ['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) return;
      const shortcut = toolShortcutFromEvent(event);
      if (!shortcut) { draft.shortcutError = t('请按住 Ctrl、Alt 或 ⌘，再按另一个键。'); render(); return; }
      if (isReservedToolShortcut(shortcut)) { draft.shortcutError = t('{key} 是常用的编辑按键，换一个吧。', { key: shortcut.label }); render(); return; }
      const appUse = shortcutTaken(shortcut);
      if (appUse) { draft.shortcutError = t('{key} 已用于{use}。', { key: shortcut.label, use: t(appUse) }); render(); return; }
      const owner = store?.findShortcut?.(shortcut);
      draft.shortcut = shortcut;
      draft.shortcutChanged = true;
      draft.shortcutReplace = false;
      draft.shortcutConflict = owner && owner.toolId !== draft.id ? (store.getTool(owner.toolId)?.name || '') : '';
      stopRecording();
      render();
    };
    // window 捕获阶段：早于工具箱与工具快捷键的 document 监听，录制时不会误触发
    win.addEventListener('keydown', onKey, true);
    detachRecorder = () => win.removeEventListener('keydown', onKey, true);
    render();
  };

  const renderParams = (action) => {
    if (!action.params?.length) return null;
    const box = h('div', 'uts-params');
    action.params.forEach((param) => {
      const value = draft.action.params[param.key];
      if (param.type === 'boolean') {
        const label = h('label', 'uts-check');
        const input = h('input');
        input.type = 'checkbox';
        input.checked = typeof value === 'boolean' ? value : param.default === true;
        input.dataset.param = param.key;
        input.addEventListener('change', () => { draft.action.params[param.key] = input.checked; });
        label.appendChild(input);
        label.appendChild(h('span', '', t(param.label)));
        box.appendChild(label);
        return;
      }
      const wrap = h('label', 'uts-param');
      wrap.appendChild(h('span', 'uts-label', t(param.label)));
      let control;
      if (param.type === 'select') {
        control = h('select', 'uts-select');
        param.options.forEach(([optionValue, optionLabel]) => {
          const option = h('option', '', t(optionLabel));
          option.value = optionValue;
          control.appendChild(option);
        });
        control.value = param.options.some(([optionValue]) => optionValue === value) ? value : param.default;
        control.addEventListener('change', () => {
          draft.action.params[param.key] = control.value;
          const before = draft.name;
          followName(action);
          if (draft.name !== before) render();
        });
        draft.action.params[param.key] = control.value;
      } else {
        control = h('textarea', 'uts-textarea');
        control.maxLength = param.maxLength || 2000;
        control.value = String(value ?? '');
        control.dataset.i18nSkip = '';
        control.addEventListener('input', () => { draft.action.params[param.key] = control.value; });
      }
      control.dataset.param = param.key;
      wrap.appendChild(control);
      box.appendChild(wrap);
    });
    return box;
  };

  const renderScript = () => {
    const section = h('div', 'uts-section');
    section.appendChild(h('span', 'uts-label', t('脚本')));
    const code = h('textarea', 'uts-code');
    code.value = draft.script.code;
    code.spellcheck = false;
    code.dataset.field = 'code';
    code.dataset.i18nSkip = '';
    code.setAttribute('aria-label', t('脚本'));
    code.addEventListener('input', () => { draft.script.code = code.value; });
    // Tab 输入缩排，不跳走焦点
    code.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.shiftKey) return;
      event.preventDefault();
      const start = code.selectionStart;
      code.value = `${code.value.slice(0, start)}  ${code.value.slice(code.selectionEnd)}`;
      code.selectionStart = code.selectionEnd = start + 2;
      draft.script.code = code.value;
    });
    section.appendChild(code);
    const help = h('details', 'uts-help');
    help.appendChild(h('summary', '', t('怎么写')));
    const list = h('ul');
    SCRIPT_HELP.forEach(line => list.appendChild(h('li', '', t(line))));
    help.appendChild(list);
    section.appendChild(help);
    section.appendChild(h('span', 'uts-label', t('脚本可以做的事')));
    const caps = h('div', 'uts-caps');
    TOOL_SCRIPT_CAPABILITIES.forEach((capability) => {
      const label = h('label', `uts-cap${capability.risky ? ' is-risky' : ''}`);
      const input = h('input');
      input.type = 'checkbox';
      input.checked = draft.script.capabilities.includes(capability.id);
      input.dataset.capability = capability.id;
      input.addEventListener('change', () => {
        const set = new Set(draft.script.capabilities);
        if (input.checked) set.add(capability.id); else set.delete(capability.id);
        draft.script.capabilities = TOOL_SCRIPT_CAPABILITIES.map(item => item.id).filter(id => set.has(id));
      });
      label.appendChild(input);
      const copy = h('span', 'uts-cap-copy');
      const title = h('strong', '', t(capability.title));
      if (capability.risky) title.dataset.risk = t('有费用');
      copy.appendChild(title);
      copy.appendChild(h('span', '', t(capability.description)));
      label.appendChild(copy);
      caps.appendChild(label);
    });
    section.appendChild(caps);
    section.appendChild(h('span', 'uts-hint', t('脚本只拿得到勾选的能力；保存时会请你确认。')));
    return section;
  };

  const renderForm = () => {
    const form = h('div', 'uts-form');
    form.appendChild(draft.id ? raw('h3', 'uts-form-title', t('编辑「{name}」', { name: draft.name })) : h('h3', 'uts-form-title', t('新建工具')));

    // 动作
    const actionSection = h('div', 'uts-section');
    actionSection.appendChild(h('span', 'uts-label', t('要做什么')));
    const box = h('div', 'uts-actions-box');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', t('要做什么'));
    const actions = listActions();
    TOOL_ACTION_GROUPS.forEach((group) => {
      const items = actions.filter(action => action.group === group.id);
      if (!items.length) return;
      const section = h('div');
      section.appendChild(h('p', 'uts-group-title', t(group.title)));
      const grid = h('div', 'uts-action-grid');
      items.forEach((action) => {
        const selected = draft.action?.source === action.source && draft.action?.id === action.id;
        const choice = h('button', `uts-action${selected ? ' is-selected' : ''}`);
        choice.type = 'button';
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', selected ? 'true' : 'false');
        choice.dataset.action = `${action.source}:${action.id}`;
        choice.innerHTML = userToolIconMarkup(action.icon);
        const copy = h('span', 'uts-action-copy');
        copy.appendChild(action.source === 'agent' ? raw('span', 'uts-action-title', action.title) : h('span', 'uts-action-title', t(action.title)));
        copy.appendChild(h('span', 'uts-action-desc', t(action.description)));
        choice.appendChild(copy);
        choice.addEventListener('click', () => chooseAction(action));
        grid.appendChild(choice);
      });
      section.appendChild(grid);
      box.appendChild(section);
    });
    actionSection.appendChild(box);
    const action = draft.action ? getAction(draft.action.source, draft.action.id) : null;
    if (action && describeToolTarget(action)) actionSection.appendChild(h('span', 'uts-hint', t('作用于：{target}', { target: t(describeToolTarget(action)) })));
    if (draft.action && !action) actionSection.appendChild(h('span', 'uts-key-error', t('原来的动作已经不在了，请重新选择。')));
    form.appendChild(actionSection);
    if (action) {
      const params = renderParams(action);
      if (params) form.appendChild(params);
    }
    if (action?.source === 'script' && draft.script) form.appendChild(renderScript());
    if (action?.directable) {
      const row = h('div', 'uts-toggle-row');
      const copy = h('div', 'uts-toggle-copy');
      copy.appendChild(h('strong', '', t('直接执行')));
      copy.appendChild(h('span', '', action.effect === 'destructive' ? t('执行时不再弹出确认；删除后通知里可以撤销。') : t('改这条消息时不经审阅直接写入，通知里可以撤销。')));
      row.appendChild(copy);
      const toggle = h('label', 'uts-switch');
      const input = h('input');
      input.type = 'checkbox';
      input.checked = draft.direct;
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', t('直接执行'));
      input.dataset.field = 'direct';
      input.addEventListener('change', () => { draft.direct = input.checked; });
      toggle.appendChild(input);
      toggle.appendChild(h('span', 'uts-switch-track'));
      row.appendChild(toggle);
      form.appendChild(row);
    }

    // 名称与图标
    const nameSection = h('label', 'uts-section');
    nameSection.appendChild(h('span', 'uts-label', t('名称')));
    const name = h('input', 'uts-input');
    name.type = 'text';
    name.maxLength = 40;
    name.value = draft.name;
    name.placeholder = t('例如：删掉最后回复');
    name.dataset.field = 'name';
    name.dataset.i18nSkip = '';
    name.addEventListener('input', () => { draft.name = name.value; draft.nameTouched = true; });
    nameSection.appendChild(name);
    form.appendChild(nameSection);
    const iconSection = h('div', 'uts-section');
    iconSection.appendChild(h('span', 'uts-label', t('图标')));
    const icons = h('div', 'uts-icons');
    icons.setAttribute('role', 'radiogroup');
    icons.setAttribute('aria-label', t('图标'));
    const currentIcon = draft.icon || action?.icon || 'bolt';
    USER_TOOL_ICON_NAMES.forEach((iconName) => {
      const choice = h('button', `uts-icon-choice${iconName === currentIcon ? ' is-selected' : ''}`);
      choice.type = 'button';
      choice.innerHTML = userToolIconMarkup(iconName);
      choice.dataset.icon = iconName;
      choice.setAttribute('role', 'radio');
      choice.setAttribute('aria-checked', iconName === currentIcon ? 'true' : 'false');
      choice.setAttribute('aria-label', iconName);
      choice.addEventListener('click', () => { draft.icon = iconName; draft.iconTouched = true; render(); });
      icons.appendChild(choice);
    });
    iconSection.appendChild(icons);
    form.appendChild(iconSection);

    // 快捷键
    const keySection = h('div', 'uts-section');
    keySection.appendChild(h('span', 'uts-label', t('快捷键（可选）')));
    const keyRow = h('div', 'uts-shortcut-row');
    const keyButton = h('button', `uts-key${recording ? ' is-recording' : draft.shortcut ? '' : ' is-empty'}`);
    keyButton.type = 'button';
    keyButton.dataset.key = 'shortcut';
    keyButton.innerHTML = ICONS.keyboard;
    keyButton.appendChild(recording ? h('span', '', t('请按下组合键…')) : draft.shortcut ? raw('span', '', draft.shortcut.label) : h('span', '', t('点这里录制')));
    keyButton.addEventListener('click', () => { if (recording) { stopRecording(); render(); } else startRecording(); });
    keyRow.appendChild(keyButton);
    if (draft.shortcut && !recording) keyRow.appendChild(button(t('清除'), { className: 'uts-btn is-ghost', key: 'clear-shortcut', onClick: () => { draft.shortcut = null; draft.shortcutChanged = true; draft.shortcutConflict = ''; render(); } }));
    keySection.appendChild(keyRow);
    keySection.appendChild(h('span', 'uts-hint', recording ? t('需要 Ctrl、Alt 或 ⌘ 加另一个键；Esc 取消。只在 APP 内有效。') : t('只在 APP 内有效，需要 Ctrl、Alt 或 ⌘ 加另一个键。')));
    if (draft.shortcutError) keySection.appendChild(h('span', 'uts-key-error', draft.shortcutError));
    if (draft.shortcutConflict) {
      const conflict = h('div', 'uts-key-error');
      conflict.appendChild(raw('span', '', t('{key} 已被「{name}」使用。', { key: draft.shortcut?.label || '', name: draft.shortcutConflict })));
      const take = h('label', 'uts-check');
      const input = h('input');
      input.type = 'checkbox';
      input.checked = draft.shortcutReplace;
      input.dataset.field = 'shortcutReplace';
      input.addEventListener('change', () => { draft.shortcutReplace = input.checked; });
      take.appendChild(input);
      take.appendChild(h('span', '', t('改绑到这个工具')));
      conflict.appendChild(take);
      keySection.appendChild(conflict);
    }
    form.appendChild(keySection);

    // 位置手势
    const gestureSection = h('div', 'uts-section');
    gestureSection.appendChild(h('span', 'uts-label', t('手势（可选）')));
    const gestures = h('div', 'uts-gestures');
    TOOL_GESTURE_OPTIONS.forEach((option) => {
      const key = toolGestureKey(option.position, option.gesture);
      const selected = draft.gestures.has(key);
      const owner = store?.findGesture?.(option.position, option.gesture);
      const ownerName = owner && owner.toolId !== draft.id ? (store.getTool(owner.toolId)?.name || '') : '';
      const compatible = isToolGestureCompatible(option, action);
      const chip = h('button', 'uts-gesture');
      chip.type = 'button';
      chip.dataset.gesture = key;
      chip.disabled = !compatible;
      chip.setAttribute('aria-pressed', selected ? 'true' : 'false');
      const title = h('strong');
      title.innerHTML = ICONS.hand;
      title.appendChild(h('span', '', t(option.label)));
      chip.appendChild(title);
      if (!compatible) chip.appendChild(h('small', '', t('这个动作不能用在这里')));
      else if (ownerName) {
        const note = selected ? t('会从「{name}」改绑过来', { name: ownerName }) : t('「{name}」在用', { name: ownerName });
        const small = raw('small', selected ? 'is-move' : '', note);
        chip.appendChild(small);
      }
      chip.addEventListener('click', () => {
        if (draft.gestures.has(key)) draft.gestures.delete(key); else draft.gestures.add(key);
        draft.gesturesChanged = true;
        render();
      });
      gestures.appendChild(chip);
    });
    gestureSection.appendChild(gestures);
    gestureSection.appendChild(h('span', 'uts-hint', t('气泡长按仍是消息菜单。发送键绑了双击后，单击发送会稍等约 0.3 秒；生成中发送键仍是停止。')));
    form.appendChild(gestureSection);

    const errorBox = raw('div', 'uts-form-error', formError);
    errorBox.hidden = !formError;
    errorBox.setAttribute('role', 'alert');
    form.appendChild(errorBox);

    const submit = async () => {
      if (saving) return;
      stopRecording();
      if (!draft.action || !action) { formError = t('请选择工具要执行的动作'); render(); return; }
      const params = normalizeToolParams(action, draft.action.params);
      if (!params.ok) { formError = t(params.error); render(); return; }
      if (draft.shortcutConflict && !draft.shortcutReplace) { formError = t('快捷键和别的工具重复：勾选「改绑到这个工具」，或换一个组合。'); render(); return; }
      let script;
      if (action.source === 'script') {
        if (!trim(draft.script?.code)) { formError = t('脚本是空的'); render(); return; }
        const capabilities = draft.script.capabilities;
        const unchanged = capabilities.length === draft.script.approved.length && capabilities.every(item => draft.script.approved.includes(item));
        // 能力有变动（或第一次保存）：请用户确认脚本可以做的事
        if (!unchanged && !await confirmScriptCapabilities({ name: draft.name, capabilities })) return;
        script = { code: draft.script.code, capabilities, approved: [...capabilities] };
      }
      saving = true;
      try {
        const saved = await store.saveTool({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name,
          icon: draft.icon || action.icon || 'bolt',
          action: { source: draft.action.source, id: draft.action.id, params: params.params },
          direct: action.directable ? draft.direct : false,
          ...(script ? { script } : {}),
        }, draft.id ? { expectedRevision: draft.revision } : {});
        if (draft.shortcutChanged) await store.setShortcut(saved.id, draft.shortcut, { replace: draft.shortcutReplace });
        if (draft.gesturesChanged) {
          const before = new Set(gesturesOf(saved.id).map(gesture => toolGestureKey(gesture.position, gesture.gesture)));
          for (const option of TOOL_GESTURE_OPTIONS) {
            const key = toolGestureKey(option.position, option.gesture);
            const wanted = draft.gestures.has(key) && isToolGestureCompatible(option, action);
            if (wanted && !before.has(key)) await store.setGesture(saved.id, option, { replace: true });
            if (!wanted && before.has(key)) await store.setGesture(saved.id, option, { enabled: false });
          }
        }
        saving = false;
        view = 'list';
        draft = null;
        formError = '';
        render();
      } catch (error) {
        saving = false;
        formError = t(trim(error?.message) || '保存失败');
        render();
      }
    };
    const actionsRow = h('div', 'uts-form-actions');
    actionsRow.appendChild(button(t('取消'), { className: 'uts-btn is-ghost', onClick: closeEditor }));
    actionsRow.appendChild(button(t('保存'), { className: 'uts-btn is-primary', key: 'save', onClick: () => { void submit(); } }));
    form.appendChild(actionsRow);
    return form;
  };

  const render = () => {
    if (!body) return;
    const list = tools();
    subtitle.textContent = list.length ? t('{count} 个工具（最多 {limit} 个）', { count: list.length, limit: USER_TOOL_LIMIT }) : t('一键执行常用操作');
    addButton.hidden = view !== 'list' || !list.length;
    addButton.disabled = list.length >= USER_TOOL_LIMIT;
    const scrollTop = body.scrollTop;
    const actionsScroll = body.querySelector?.('.uts-actions-box')?.scrollTop || 0;
    body.replaceChildren();
    if (view === 'form' && draft) body.appendChild(renderForm());
    else if (view === 'export' && exportDraft) body.appendChild(renderExport());
    else if (view === 'import' && importPlan) body.appendChild(renderImport());
    else renderList();
    body.scrollTop = scrollTop;
    // 重画时动作框保持原位；刚打开编辑时露出已选的动作
    const box = body.querySelector?.('.uts-actions-box');
    if (box) box.scrollTop = actionsScroll;
    if (revealAction && box) box.querySelector?.('.uts-action.is-selected')?.scrollIntoView?.({ block: 'nearest' });
    revealAction = false;
  };

  const hide = () => {
    if (!overlay) return;
    stopRecording();
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    view = 'list';
    draft = null;
    confirmDelete = '';
    flash = null;
    importPlan = null;
  };

  const ensure = () => {
    if (overlay) return;
    injectStyle(documentRef);
    overlay = h('div', 'uts-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    const panel = h('div', 'uts-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'uts-head');
    const icon = h('span', 'uts-head-icon');
    icon.innerHTML = ICONS.bolt;
    const copy = h('div', 'uts-head-copy');
    copy.appendChild(h('h2', 'uts-title', t('工具与手势')));
    subtitle = raw('p', 'uts-subtitle');
    copy.appendChild(subtitle);
    addButton = button(t('新建'), { icon: ICONS.plus, className: 'uts-add', onClick: () => openEditor() });
    addButton.setAttribute('aria-label', t('新建工具'));
    const close = h('button', 'uts-close');
    close.type = 'button';
    close.innerHTML = ICONS.close;
    close.setAttribute('aria-label', t('关闭'));
    close.addEventListener('click', () => hide());
    head.appendChild(icon);
    head.appendChild(copy);
    head.appendChild(addButton);
    head.appendChild(close);
    body = h('div', 'uts-body');
    panel.appendChild(head);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) hide(); });
    documentRef.body.appendChild(overlay);
    store?.subscribe?.(() => { if (isOpen() && view === 'list') render(); });
  };

  return {
    /** show({ toolId }) 直接打开某个工具的编辑；show({ create: true }) 打开新建。 */
    show: ({ toolId = '', create = false } = {}) => {
      ensure();
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      view = 'list';
      draft = null;
      const tool = toolId ? store?.getTool?.(toolId) : null;
      if (tool) openEditor(tool);
      else if (create) openEditor();
      else render();
    },
    hide,
    refresh: () => { if (isOpen()) render(); },
    isOpen,
    isRecording: () => recording,
    closeTopLayer: () => {
      if (!isOpen()) return false;
      if (recording) { stopRecording(); render(); return true; }
      if (view === 'form') { closeEditor(); return true; }
      if (view === 'export' || view === 'import') { view = 'list'; importPlan = null; render(); return true; }
      if (confirmDelete) { confirmDelete = ''; render(); return true; }
      hide();
      return true;
    },
    get overlay() { return overlay; },
  };
};
