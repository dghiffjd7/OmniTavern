import { appSettings } from '../storage/app-settings.js';
import { appConfirm } from './app-confirm.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { getCharacterCardDisplayName } from '../utils/character-card-display.js';
import { bindCustomSelectButton, closeCustomSelectMenu, createCustomSelectWrapper } from './custom-select.js';
import { restartScriptWorker } from './script-runtime-utils.js';
import { analyzeScriptCompatibility } from '../import/script-capability-preflight.js';
import { analyzeTavernFeatures, buildTavernFeatureImportLine } from '../import/tavern-feature-report.js';
import { getCompatGapReportStore } from '../storage/compat-gap-report-store.js';
import { t } from '../i18n/index.js';
import {
  getScriptRuntimeGapReports,
  renderScriptCompatDetailHtml,
  renderScriptCompatToggleHtml,
} from './script-compat-report-view.js';

const SCRIPT_PANEL_STYLE_ID = 'script-panel-polish-style';

const scriptIconSvg = (body) => `
  <svg class="script-panel-icon" viewBox="0 0 24 24" aria-hidden="true">
    ${body}
  </svg>
`;

const SCRIPT_ICONS = Object.freeze({
  close: scriptIconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  code: scriptIconSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>'),
  edit: scriptIconSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>'),
  plus: scriptIconSvg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  trash: scriptIconSvg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>'),
  upload: scriptIconSvg('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-4"/><path d="M3 15v4a2 2 0 0 0 2 2"/>'),
});

const ensureScriptPanelStyles = () => {
  if (typeof document === 'undefined' || document.getElementById(SCRIPT_PANEL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SCRIPT_PANEL_STYLE_ID;
  style.textContent = `
    #script-panel,
    .script-editor-panel {
      font-family: "Inter", "Noto Sans SC", ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    #script-panel.script-panel-shell {
      border: 1px solid var(--app-border-default);
      box-shadow: 0 24px 80px -16px rgba(15, 23, 42, 0.25), 0 4px 16px -4px rgba(15, 23, 42, 0.08) !important;
    }
    #script-panel .script-panel-header {
      background: var(--app-surface-card) !important;
      border-bottom-color: var(--app-border-subtle) !important;
    }
    #script-panel .script-panel-toolbar {
      padding: 12px 16px !important;
      background: color-mix(in srgb, var(--app-surface-subtle) 58%, transparent);
      border-bottom-color: var(--app-border-subtle) !important;
    }
    #script-panel .script-panel-tabs {
      display: inline-grid !important;
      grid-template-columns: repeat(3, minmax(64px, 1fr));
      gap: 2px !important;
      padding: 3px;
      border: 1px solid var(--app-border-default);
      border-radius: 12px;
      background: var(--app-surface-subtle);
    }
    #script-panel .script-tab {
      min-height: 32px;
      padding: 7px 12px !important;
      border-radius: 9px !important;
      color: var(--app-text-secondary) !important;
      font-size: 12.5px !important;
      font-weight: 650;
      transition: color 160ms ease, background 180ms ease, box-shadow 180ms ease, transform 120ms ease;
    }
    #script-panel .script-tab.is-active {
      background: var(--app-surface-card) !important;
      color: var(--app-text-primary) !important;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.10);
    }
    #script-panel .script-tab:active,
    #script-panel .script-panel-btn:active,
    .script-editor-panel .script-editor-button:active {
      transform: scale(0.96);
    }
    #script-panel .script-panel-master-toggle {
      font-size: 12px !important;
      font-weight: 600;
    }
    #script-panel input[type='checkbox'] {
      accent-color: #14b8a6;
      cursor: pointer;
    }
    #script-panel .script-panel-scopebar {
      padding: 10px 16px !important;
      background: var(--app-surface-card);
      border-bottom-color: var(--app-border-subtle) !important;
    }
    #script-panel .script-panel-btn,
    .script-editor-panel .script-editor-button {
      display: inline-flex;
      min-height: 34px;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border-radius: 10px !important;
      font-size: 12px !important;
      font-weight: 650;
      transition: transform 120ms ease, border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
    }
    #script-panel .script-panel-btn:hover,
    .script-editor-panel .script-editor-button:hover {
      border-color: var(--app-border-strong, var(--app-border-default)) !important;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
    }
    #script-panel .script-panel-btn--primary {
      background: var(--app-text-primary) !important;
      color: var(--app-text-inverse) !important;
      box-shadow: 0 5px 12px rgba(15, 23, 42, 0.15);
    }
    #script-panel .script-panel-content {
      padding: 14px 16px 16px !important;
      background: color-mix(in srgb, var(--app-surface-subtle) 62%, transparent);
    }
    #script-panel #script-list {
      gap: 10px !important;
    }
    #script-panel .script-panel-card {
      display: flex !important;
      min-width: 0;
      align-items: center !important;
      gap: 12px !important;
      padding: 13px 16px !important;
      border: 1px solid var(--app-border-default) !important;
      border-radius: 16px !important;
      background: var(--app-surface-card) !important;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.04);
      transition: border-color 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
    }
    #script-panel .script-panel-card.is-entering {
      animation: script-panel-card-in 220ms ease backwards;
    }
    #script-panel .script-panel-card:hover {
      border-color: var(--app-border-strong, var(--app-border-default)) !important;
      box-shadow: 0 8px 24px -12px rgba(15, 23, 42, 0.20);
    }
    #script-panel.is-master-off .script-panel-card {
      opacity: 0.55;
    }
    #script-panel .script-panel-card-icon {
      display: inline-flex;
      width: 36px;
      height: 36px;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(20, 184, 166, 0.12);
      border-radius: 12px;
      background: rgba(20, 184, 166, 0.08);
      color: #0d9488;
    }
    #script-panel .script-panel-card-title {
      font-size: 13.5px;
      font-weight: 650 !important;
    }
    #script-panel .script-panel-card-meta {
      display: inline-flex;
      width: fit-content;
      margin-top: 5px !important;
      padding: 2px 7px;
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.07);
      color: #6366f1 !important;
      font-size: 10.5px !important;
      font-weight: 650;
    }
    #script-panel .script-panel-card-actions {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 8px;
    }
    #script-panel .script-panel-card-action {
      display: inline-flex;
      min-height: 32px;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 6px 10px !important;
      border-radius: 9px !important;
      font-size: 11.5px !important;
      font-weight: 650;
      transition: transform 120ms ease, border-color 160ms ease, background 160ms ease;
    }
    #script-panel .script-panel-card-action:active {
      transform: scale(0.94);
    }
    #script-panel .script-panel-empty {
      display: grid;
      min-height: 220px;
      place-items: center;
      border: 2px dashed var(--app-border-default);
      border-radius: 16px;
      background: color-mix(in srgb, var(--app-surface-card) 75%, transparent);
      font-size: 13px !important;
      font-weight: 600;
    }
    #script-panel .script-panel-compat-toggle {
      display: inline-flex;
      max-width: 100%;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      margin-top: 7px;
      padding: 3px 8px 3px 9px;
      border: 1px solid var(--app-border-default);
      border-radius: 999px;
      background: var(--app-surface-subtle);
      color: var(--app-text-secondary);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.5;
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease;
    }
    #script-panel .script-panel-compat-toggle:hover {
      border-color: var(--app-border-strong, var(--app-border-default));
    }
    #script-panel .script-panel-compat-toggle:focus-visible {
      outline: 2px solid rgba(var(--app-accent-rgb), 0.45);
      outline-offset: 2px;
    }
    #script-panel .script-compat-chevron {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.4;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: transform 180ms ease;
    }
    #script-panel .script-panel-compat-toggle[aria-expanded='true'] .script-compat-chevron {
      transform: rotate(180deg);
    }
    #script-panel :is(.script-compat-count, .script-compat-badge) {
      display: inline-flex;
      align-items: center;
      padding: 0 6px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 650;
      white-space: nowrap;
    }
    #script-panel :is(.script-compat-count, .script-compat-badge).is-supported {
      background: rgba(var(--app-success-rgb), 0.12);
      color: var(--app-success-text);
    }
    #script-panel :is(.script-compat-count, .script-compat-badge).is-partial {
      background: rgba(var(--app-warning-rgb), 0.14);
      color: var(--app-warning-text);
    }
    #script-panel :is(.script-compat-count, .script-compat-badge).is-unsupported,
    #script-panel .script-compat-count.is-gap {
      background: rgba(var(--app-danger-rgb), 0.12);
      color: var(--app-danger-text-strong, var(--app-danger-text));
    }
    #script-panel.script-panel-shell .script-panel-card.is-compat-open {
      align-items: flex-start !important;
    }
    #script-panel .script-panel-compat-detail {
      display: grid;
      gap: 12px;
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid var(--app-border-subtle);
      border-radius: 12px;
      background: var(--app-surface-subtle);
    }
    #script-panel .script-panel-compat-detail[hidden] {
      display: none;
    }
    #script-panel .script-compat-section-title {
      color: var(--app-text-primary);
      font-size: 12px;
      font-weight: 700;
    }
    #script-panel :is(.script-compat-hint, .script-compat-empty) {
      margin-top: 3px;
      color: var(--app-text-muted);
      font-size: 11px;
      line-height: 1.5;
    }
    #script-panel .script-compat-list {
      display: grid;
      gap: 8px;
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }
    #script-panel .script-compat-row {
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid var(--app-border-subtle);
      border-radius: 10px;
      background: var(--app-surface-card);
    }
    #script-panel .script-compat-row-head {
      display: flex;
      min-width: 0;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    #script-panel .script-compat-label {
      min-width: 0;
      overflow-wrap: anywhere;
      color: var(--app-text-primary);
      font-size: 12px;
      font-weight: 600;
    }
    #script-panel .script-compat-label.is-code {
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11.5px;
    }
    #script-panel .script-compat-category {
      color: var(--app-text-muted);
      font-size: 10.5px;
    }
    #script-panel .script-compat-impact {
      margin-top: 4px;
      color: var(--app-text-secondary);
      font-size: 11.5px;
      line-height: 1.55;
    }
    #script-panel .script-compat-matches {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      margin-top: 5px;
      color: var(--app-text-muted);
      font-size: 10.5px;
    }
    #script-panel .script-compat-matches code {
      max-width: 100%;
      overflow-wrap: anywhere;
      padding: 1px 5px;
      border-radius: 6px;
      background: var(--app-surface-subtle);
      color: var(--app-text-secondary);
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 10.5px;
    }
    .script-panel-icon {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .script-editor-overlay {
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      animation: script-editor-overlay-in 180ms ease forwards;
    }
    .script-editor-panel {
      width: min(94vw, 680px) !important;
      max-height: 88vh !important;
      border: 1px solid var(--app-border-default);
      border-radius: 16px !important;
      box-shadow: 0 24px 80px -16px rgba(15, 23, 42, 0.28), 0 4px 16px -4px rgba(15, 23, 42, 0.10) !important;
      animation: script-editor-panel-in 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .script-editor-panel .script-editor-header,
    .script-editor-panel .script-editor-footer {
      flex: 0 0 auto;
      background: var(--app-surface-card) !important;
      border-color: var(--app-border-subtle) !important;
    }
    .script-editor-panel .script-editor-title {
      font-size: 15px;
      font-weight: 750 !important;
    }
    .script-editor-panel .script-editor-content {
      min-height: 0;
      gap: 16px !important;
      padding: 16px 20px !important;
    }
    .script-editor-panel .script-editor-field-label {
      margin-bottom: 6px;
      color: var(--app-text-secondary);
      font-size: 13px;
      font-weight: 650 !important;
    }
    .script-editor-panel :is(input, textarea) {
      box-sizing: border-box;
      border-color: var(--app-border-default) !important;
      background: var(--app-surface-card);
      color: var(--app-text-primary);
      outline: none;
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }
    .script-editor-panel :is(input, textarea):focus {
      border-color: rgba(99, 102, 241, 0.58) !important;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.11);
    }
    .script-editor-panel .script-editor-code-shell {
      display: flex;
      height: 240px;
      overflow: hidden;
      border: 1px solid var(--app-border-default);
      border-radius: 12px;
      background: var(--app-surface-card);
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }
    .script-editor-panel .script-editor-code-shell:focus-within {
      border-color: rgba(99, 102, 241, 0.58);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.11);
    }
    .script-editor-panel #script-editor-gutter {
      min-width: 42px;
      overflow: hidden;
      padding: 11px 9px;
      border-right: 1px solid var(--app-border-subtle);
      background: var(--app-surface-subtle);
      color: var(--app-text-muted);
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 20px;
      text-align: right;
      user-select: none;
      white-space: pre;
    }
    .script-editor-panel #script-editor-gutter-lines {
      display: block;
      will-change: transform;
    }
    .script-editor-panel #script-editor-content {
      min-width: 0;
      height: 100%;
      flex: 1;
      resize: none;
      padding: 10px 12px !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace !important;
      font-size: 12px !important;
      line-height: 20px;
      tab-size: 2;
    }
    @keyframes script-panel-card-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes script-editor-overlay-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes script-editor-panel-in {
      from { opacity: 0; transform: translateY(16px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (max-width: 680px) {
      #script-panel .script-panel-toolbar,
      #script-panel .script-panel-scopebar {
        align-items: stretch !important;
        padding: 10px !important;
      }
      #script-panel .script-panel-tabs {
        width: 100%;
      }
      #script-panel .script-panel-master-toggle {
        min-height: 36px;
        margin-left: 0 !important;
      }
      #script-panel .script-panel-scopebar-actions {
        width: 100%;
        margin-left: 0 !important;
      }
      #script-panel .script-panel-scopebar-actions .script-panel-btn {
        min-height: 40px;
        flex: 1;
      }
      #script-panel .script-panel-content {
        padding: 10px !important;
      }
      #script-panel .script-panel-card {
        display: grid !important;
        grid-template-columns: 20px 36px minmax(0, 1fr);
        padding: 12px !important;
      }
      #script-panel .script-panel-card-actions {
        grid-column: 2 / -1;
        width: 100%;
      }
      #script-panel .script-panel-card-action {
        min-height: 38px;
        flex: 1;
      }
      .script-editor-overlay {
        align-items: flex-end !important;
        padding: 8px !important;
        padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
      }
      .script-editor-panel {
        width: 100% !important;
        max-height: calc(var(--app-visual-height, 100dvh) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 16px) !important;
        border-radius: 16px !important;
      }
      .script-editor-panel .script-editor-content {
        padding: 14px !important;
      }
      .script-editor-panel .script-editor-code-shell {
        height: min(34dvh, 240px);
      }
      .script-editor-panel .script-editor-button {
        min-height: 42px;
      }
    }
    body[data-reduced-motion='on'] #script-panel *,
    body[data-reduced-motion='on'] .script-editor-overlay,
    body[data-reduced-motion='on'] .script-editor-panel {
      animation: none !important;
      transition: none !important;
    }
    @media (prefers-reduced-motion: reduce) {
      #script-panel *,
      .script-editor-overlay,
      .script-editor-panel {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
};

const SOURCE_LABELS = {
  user: '手动创建',
  card: '角色卡导入',
  preset: '预设导入',
  import: '导入',
};

const normalizeScope = (scope) => (scope === 'preset' || scope === 'character') ? scope : 'global';

const createOption = (value, label) => {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
};

const openScriptEditor = ({ script, title = '编辑脚本' } = {}) => new Promise((resolve) => {
  ensureScriptPanelStyles();
  const overlay = document.createElement('div');
  overlay.className = 'app-themed-overlay script-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:22000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const panel = document.createElement('div');
  panel.className = 'app-themed-panel script-editor-panel';
  panel.style.cssText = 'width:min(92vw,520px);max-height:86vh;background:var(--app-surface-card);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(15,23,42,0.2);';
  panel.innerHTML = `
    <div class="script-editor-header" style="padding:14px 20px;border-bottom:1px solid rgba(0,0,0,0.06);background:var(--app-surface-subtle);display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div class="script-editor-title" style="font-weight:800;color:var(--app-text-primary);">${title}</div>
      <button id="script-editor-close" class="script-editor-button" type="button" aria-label="关闭脚本编辑器" style="border:none;background:var(--app-surface-subtle);width:32px;height:32px;padding:0;border-radius:9px;cursor:pointer;">${SCRIPT_ICONS.close}</button>
    </div>
    <div class="script-editor-content" style="padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px;">
      <div>
        <div class="script-editor-field-label" style="font-weight:700;color:var(--app-text-primary);margin-bottom:6px;">脚本名称</div>
        <input id="script-editor-name" style="width:100%;padding:10px;border:1px solid var(--app-border-default);border-radius:10px;font-size:14px;">
      </div>
      <div>
        <div class="script-editor-field-label" style="font-weight:700;color:var(--app-text-primary);margin-bottom:6px;">脚本内容</div>
        <div class="script-editor-code-shell">
          <div id="script-editor-gutter" aria-hidden="true"><span id="script-editor-gutter-lines">1</span></div>
          <textarea id="script-editor-content" rows="8" spellcheck="false" style="width:100%;padding:10px;border:1px solid var(--app-border-default);border-radius:10px;font-size:13px;font-family:monospace;"></textarea>
        </div>
      </div>
      <div>
        <div class="script-editor-field-label" style="font-weight:700;color:var(--app-text-primary);margin-bottom:6px;">作者备注</div>
        <textarea id="script-editor-info" rows="3" style="width:100%;padding:10px;border:1px solid var(--app-border-default);border-radius:10px;font-size:13px;"></textarea>
      </div>
    </div>
    <div class="script-editor-footer" style="padding:12px 20px;border-top:1px solid rgba(0,0,0,0.06);display:flex;justify-content:flex-end;gap:10px;">
      <button id="script-editor-cancel" class="script-editor-button" type="button" style="padding:8px 16px;border-radius:10px;border:1px solid var(--app-border-default);background:var(--app-surface-card);">取消</button>
      <button id="script-editor-save" class="script-editor-button" type="button" style="padding:8px 18px;border-radius:10px;border:none;background:var(--app-text-primary);color:var(--app-text-inverse);">保存</button>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = (result) => {
    unbindBackdropActivation();
    overlay.remove();
    resolve(result);
  };
  panel.querySelector('#script-editor-close')?.addEventListener('click', () => close(null));
  panel.querySelector('#script-editor-cancel')?.addEventListener('click', () => close(null));
  const unbindBackdropActivation = bindBackdropActivation(overlay, {
    onActivate: () => close(null),
  });

  const nameInput = panel.querySelector('#script-editor-name');
  const contentInput = panel.querySelector('#script-editor-content');
  const infoInput = panel.querySelector('#script-editor-info');
  if (nameInput) nameInput.value = String(script?.name || '');
  if (contentInput) contentInput.value = String(script?.content || '');
  if (infoInput) infoInput.value = String(script?.info || '');

  const gutter = panel.querySelector('#script-editor-gutter-lines');
  const updateGutter = () => {
    if (!gutter || !contentInput) return;
    const lineCount = Math.max(1, String(contentInput.value || '').split('\n').length);
    gutter.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
  };
  updateGutter();
  contentInput?.addEventListener('input', updateGutter);
  contentInput?.addEventListener('scroll', () => {
    if (gutter) gutter.style.transform = `translateY(-${contentInput.scrollTop}px)`;
  });

  panel.querySelector('#script-editor-save')?.addEventListener('click', () => {
    const result = {
      name: String(nameInput?.value || '').trim(),
      content: String(contentInput?.value || ''),
      info: String(infoInput?.value || ''),
    };
    close(result);
  });
});

export class ScriptPanel {
  constructor({ store, personaStore, presetStore, appBridge = null, compatGapStore = null } = {}) {
    this.store = store || null;
    this.personaStore = personaStore || null;
    this.presetStore = presetStore || null;
    this.appBridge = appBridge || null;
    this.overlay = null;
    this.panel = null;
    this.body = null;
    this.tab = 'global';
    this.personaSelect = null;
    this.presetSelect = null;
    this.personaScopeId = '';
    this.presetScopeId = '';
    this.scriptList = null;
    this.statusEl = null;
    this.importInput = null;
    // 兼容报告：执行时缺口记录与已展开明细的脚本
    this.compatGapStore = compatGapStore || null;
    this.compatExpanded = new Set();
  }

  async show() {
    if (!this.store) return;
    await this.store.ready;
    if (!this.panel) this.createUI();
    await this.refresh();
    this.overlay.style.display = 'block';
    this.panel.style.display = 'flex';
  }

  hide() {
    closeCustomSelectMenu();
    if (this.panel) this.panel.style.display = 'none';
    if (this.overlay) this.overlay.style.display = 'none';
  }

  createUI() {
    ensureScriptPanelStyles();
    this.overlay = document.createElement('div');
    this.overlay.className = 'app-themed-overlay script-panel-overlay';
    this.overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:20000;';
    this.overlay.addEventListener('click', () => this.hide());

    this.panel = document.createElement('div');
    this.panel.id = 'script-panel';
    this.panel.className = 'app-themed-panel script-panel-shell';
    this.panel.style.cssText = `
      display:none; position:fixed;
      inset: 6vh 6vw;
      background:var(--app-surface-card); border-radius:16px; box-shadow:0 18px 50px rgba(15,23,42,0.2);
      z-index:20001; overflow:hidden; flex-direction:column;
    `;
    this.panel.addEventListener('click', (e) => e.stopPropagation());

    this.panel.innerHTML = `
      <div class="script-panel-header" style="padding:14px 16px; border-bottom:1px solid rgba(0,0,0,0.06); background:var(--app-surface-subtle); display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div>
          <div class="has-help" data-help="管理全局 / 角色 / 预设脚本（默认关闭）" style="font-weight:800;color:var(--app-text-primary);">脚本管理</div>
        </div>
        <button id="script-panel-close" class="script-panel-btn" type="button" aria-label="关闭脚本管理" style="border:none;background:rgba(15,23,42,0.08);width:32px;height:32px;padding:0;border-radius:10px;cursor:pointer;">${SCRIPT_ICONS.close}</button>
      </div>
      <div class="script-panel-toolbar" style="padding:10px 16px;border-bottom:1px solid rgba(0,0,0,0.06);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div class="script-panel-tabs" style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="script-tab" data-tab="global" style="border:none;background:transparent;padding:8px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:var(--app-text-secondary);">全局</button>
          <button class="script-tab" data-tab="character" style="border:none;background:transparent;padding:8px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:var(--app-text-secondary);">角色</button>
          <button class="script-tab" data-tab="preset" style="border:none;background:transparent;padding:8px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:var(--app-text-secondary);">预设</button>
        </div>
        <label class="script-panel-master-toggle" style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--app-text-secondary);">
          <input type="checkbox" id="script-global-toggle" style="width:18px;height:18px;">
          <span>脚本总开关</span>
        </label>
      </div>
      <div class="script-panel-scopebar" style="padding:10px 16px;border-bottom:1px solid rgba(0,0,0,0.06);display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <div id="script-scope-selects" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
        <div class="script-panel-scopebar-actions" style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button id="script-import-btn" class="script-panel-btn" type="button" style="padding:8px 12px;border-radius:10px;border:1px solid var(--app-border-default);background:var(--app-surface-card);font-size:13px;cursor:pointer;">${SCRIPT_ICONS.upload}<span>导入脚本</span></button>
          <button id="script-add-btn" class="script-panel-btn script-panel-btn--primary" type="button" style="padding:8px 12px;border-radius:10px;border:none;background:var(--app-text-primary);color:var(--app-text-inverse);font-size:13px;cursor:pointer;">${SCRIPT_ICONS.plus}<span>新增脚本</span></button>
        </div>
      </div>
      <div class="script-panel-content" style="padding:12px 16px;overflow:auto;flex:1;min-height:0;">
        <div id="script-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        <div id="script-status" style="display:none;margin-top:10px;padding:10px;border-radius:10px;font-size:12px;"></div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.panel);

    this.body = this.panel.querySelector('#script-scope-selects');
    this.scriptList = this.panel.querySelector('#script-list');
    this.statusEl = this.panel.querySelector('#script-status');
    this.importInput = document.createElement('input');
    this.importInput.type = 'file';
    this.importInput.accept = 'application/json,.json';
    this.importInput.style.display = 'none';
    this.panel.appendChild(this.importInput);

    this.panel.querySelector('#script-panel-close')?.addEventListener('click', () => this.hide());
    this.panel.querySelectorAll('.script-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tab = normalizeScope(btn.dataset.tab);
        this.refresh();
      });
    });
    this.panel.querySelector('#script-import-btn')?.addEventListener('click', () => {
      this.importInput?.click();
    });
    this.panel.querySelector('#script-add-btn')?.addEventListener('click', () => this.handleAdd());
    this.panel.querySelector('#script-global-toggle')?.addEventListener('change', (e) => {
      const checked = Boolean(e.target?.checked);
      appSettings.update({ scriptEnabled: checked });
      this.refresh();
    });
    this.importInput?.addEventListener('change', (e) => this.handleImport(e));
    window.addEventListener('scripts-changed', () => {
      if (this.panel?.style.display === 'flex') this.refresh();
    });
  }

  getScopeId() {
    if (this.tab === 'character') {
      return String(
        this.personaSelect?.value ||
        this.personaScopeId ||
        this.personaStore?.getActive?.()?.id ||
        ''
      );
    }
    if (this.tab === 'preset') {
      return String(this.presetSelect?.value || this.presetScopeId || this.getActiveOpenAIPresetId());
    }
    return 'global';
  }

  getActiveOpenAIPresetId() {
    const state = this.presetStore?.getState?.() || {};
    return String(state?.active?.openai || '');
  }

  buildScopeSelectors() {
    if (!this.body) return;
    this.body.innerHTML = '';
    if (this.tab === 'character') {
      const select = document.createElement('select');
      select.style.cssText = 'min-width:160px;padding:6px 10px;border:1px solid var(--app-border-default);border-radius:10px;font-size:12px;';
      const list = Array.isArray(this.personaStore?.getAll?.()) ? this.personaStore.getAll() : [];
      list.forEach(p => {
        select.appendChild(createOption(p.id, getCharacterCardDisplayName(p, p.id)));
      });
      const activePersonaId = String(this.personaStore?.getActive?.()?.id || '');
      const preferredPersonaId = String(this.personaScopeId || activePersonaId || list[0]?.id || '');
      if (preferredPersonaId) select.value = preferredPersonaId;
      if (!select.value && list[0]?.id) select.value = String(list[0].id);
      this.personaScopeId = String(select.value || '');
      select.addEventListener('change', () => {
        this.personaScopeId = String(select.value || '');
        this.refresh();
      });
      const wrap = createCustomSelectWrapper(select, {
        placeholder: '选择角色卡',
        wrapperStyle: 'min-width:200px;',
        buttonStyle: 'margin-top:0;',
      });
      this.body.appendChild(wrap);
      bindCustomSelectButton({
        buttonEl: wrap?.querySelector?.('.world-app-select-btn'),
        selectEl: select,
        fallback: '选择角色卡',
      });
      this.personaSelect = select;
      return;
    }
    if (this.tab === 'preset') {
      const select = document.createElement('select');
      select.style.cssText = 'min-width:160px;padding:6px 10px;border:1px solid var(--app-border-default);border-radius:10px;font-size:12px;';
      const openaiPresets = this.presetStore?.getState?.()?.presets?.openai || {};
      const options = Object.entries(openaiPresets).map(([id, preset]) => ({
        id,
        label: String(preset?.name || id),
      }));
      options.forEach(({ id, label }) => {
        select.appendChild(createOption(id, label));
      });
      const activePresetId = this.getActiveOpenAIPresetId();
      const preferredPresetId = String(this.presetScopeId || activePresetId || options[0]?.id || '');
      if (preferredPresetId) select.value = preferredPresetId;
      if (!select.value && options[0]?.id) select.value = options[0].id;
      this.presetScopeId = String(select.value || '');
      select.addEventListener('change', () => {
        this.presetScopeId = String(select.value || '');
        this.refresh();
      });
      const wrap = createCustomSelectWrapper(select, {
        placeholder: '选择生成参数预设',
        wrapperStyle: 'min-width:240px;',
        buttonStyle: 'margin-top:0;',
      });
      this.body.appendChild(wrap);
      bindCustomSelectButton({
        buttonEl: wrap?.querySelector?.('.world-app-select-btn'),
        selectEl: select,
        fallback: '选择生成参数预设',
      });
      this.presetSelect = select;
      return;
    }
    this.personaSelect = null;
    this.presetSelect = null;
  }

  async refresh() {
    if (!this.panel || !this.store) return;
    closeCustomSelectMenu();
    const settings = appSettings.get();
    const toggle = this.panel.querySelector('#script-global-toggle');
    if (toggle) toggle.checked = settings.scriptEnabled === true;
    this.panel.classList.toggle('is-master-off', settings.scriptEnabled !== true);
    this.panel.querySelectorAll('.script-tab').forEach(btn => {
      const active = normalizeScope(btn.dataset.tab) === this.tab;
      btn.classList.toggle('is-active', active);
    });
    this.buildScopeSelectors();
    const scopeId = this.getScopeId();
    const scripts = this.store.getScripts(this.tab, scopeId);
    this.renderList(scripts, scopeId);
    // 执行时缺口要等记录读好；读到后补进各脚本卡片（期间换了分页或范围就不补）
    const tab = this.tab;
    const gapReports = await this.loadCompatGapReports();
    if (tab !== this.tab || scopeId !== this.getScopeId()) return;
    const current = this.store.getScripts(this.tab, scopeId);
    if ((current || []).some(script => getScriptRuntimeGapReports(gapReports, script?.id).length)) {
      this.renderList(current, scopeId, gapReports);
    }
  }

  async loadCompatGapReports() {
    try {
      const store = this.compatGapStore || getCompatGapReportStore();
      const reports = await store.getReports();
      return Array.isArray(reports) ? reports : [];
    } catch {
      return [];
    }
  }

  // 卡片上的兼容摘要（按代码推测＋执行时实际打到）；没有用到酒馆功能也没有缺口时不显示
  appendCompatReport(card, container, script, gapReports = []) {
    const report = script.schemaOnly === true ? null : analyzeTavernFeatures(script);
    const gaps = getScriptRuntimeGapReports(gapReports, script.id);
    const toggleHtml = renderScriptCompatToggleHtml({ report, gaps });
    if (!toggleHtml) return;
    const expanded = this.compatExpanded.has(script.id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'script-panel-compat-toggle';
    toggle.innerHTML = toggleHtml;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.title = t('查看这个脚本用到的酒馆功能与支持情况');
    const detail = document.createElement('div');
    detail.className = 'script-panel-compat-detail';
    detail.hidden = !expanded;
    if (expanded) detail.innerHTML = renderScriptCompatDetailHtml({ report, gaps });
    card.classList.toggle('is-compat-open', expanded);
    toggle.addEventListener('click', () => {
      const open = detail.hidden;
      if (open && !detail.innerHTML) detail.innerHTML = renderScriptCompatDetailHtml({ report, gaps });
      detail.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      card.classList.toggle('is-compat-open', open);
      if (open) this.compatExpanded.add(script.id);
      else this.compatExpanded.delete(script.id);
    });
    container.appendChild(toggle);
    container.appendChild(detail);
  }

  showStatus(message, type = 'info') {
    if (!this.statusEl) return;
    const text = String(message || '').trim();
    if (!text) {
      this.statusEl.style.display = 'none';
      this.statusEl.textContent = '';
      return;
    }
    let background = 'rgba(15,23,42,0.08)';
    let color = 'var(--app-text-secondary)';
    if (type === 'error') {
      background = 'rgba(254,226,226,0.9)';
      color = '#b91c1c';
    } else if (type === 'warning') {
      background = 'rgba(254,243,199,0.9)';
      color = '#92400e';
    } else if (type === 'success') {
      background = 'rgba(220,252,231,0.9)';
      color = '#166534';
    }
    this.statusEl.style.display = 'block';
    this.statusEl.style.background = background;
    this.statusEl.style.color = color;
    this.statusEl.textContent = text;
  }

  extractScripts(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.scripts)) return payload.scripts;
    if (payload.tavern_helper && Array.isArray(payload.tavern_helper.scripts)) return payload.tavern_helper.scripts;
    if (payload.extensions?.tavern_helper?.scripts) return payload.extensions.tavern_helper.scripts;
    if (payload.type === 'script' || payload.type === 'folder' || payload.content) return [payload];
    return [];
  }

  async handleImport(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    event.target.value = '';
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      this.showStatus('脚本文件读取失败', 'error');
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.showStatus('脚本文件解析失败（JSON 结构不正确）', 'error');
      return;
    }
    const scripts = this.extractScripts(parsed);
    if (!scripts.length) {
      this.showStatus('未在文件中找到脚本内容', 'error');
      return;
    }
    const scopeId = this.getScopeId();
    const result = await this.store.importTavernHelperScripts({
      scripts,
      scope: this.tab,
      scopeId,
      source: 'import',
    });
    const count = Math.max(0, Number(result?.count) || 0);
    const ids = Array.isArray(result?.ids) ? result.ids : [];
    if (!count) {
      this.showStatus('没有可导入的脚本', 'error');
      return;
    }
    const runnableIds = Array.isArray(result?.runnableIds) ? result.runnableIds : ids;
    const blockedCount = Math.max(0, Number(result?.compatibility?.blockedCount) || 0);
    if (blockedCount > 0) {
      this.showStatus(`已导入 ${count} 个脚本；${blockedCount} 个需要作为 SillyTavern 外部扩展安装，已保持禁用`, 'warning');
    } else {
      this.showStatus(`已导入 ${count} 个脚本`, 'success');
    }
    if (runnableIds.length) {
      const tavernLine = buildTavernFeatureImportLine(result?.tavernFeatures);
      const ok = await appConfirm({
        title: '导入脚本',
        message: (blockedCount > 0
          ? `其中 ${runnableIds.length} 个脚本可运行，是否立即启用？`
          : `已导入 ${count} 个脚本，是否立即启用？`) + (tavernLine ? `\n${tavernLine}` : ''),
      });
      if (ok) {
        for (const id of runnableIds) {
          await this.store.toggleScript(this.tab, scopeId, id, true);
        }
      }
    }
    if (!runnableIds.length && blockedCount > 0) {
      window.toastr?.warning?.('检测到外部扩展加载器；已保留在脚本列表，但不会启用');
    }
    this.refresh();
  }

  renderList(scripts, scopeId, gapReports = []) {
    if (!this.scriptList) return;
    const shouldAnimateCards = this.scriptList.dataset.motionInitialized !== 'true';
    this.scriptList.innerHTML = '';
    this.scriptList.dataset.motionInitialized = 'true';
    if (!Array.isArray(scripts) || scripts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'script-panel-empty';
      empty.textContent = '暂无脚本';
      empty.style.cssText = 'padding:16px;text-align:center;color:var(--app-text-muted);font-size:12px;';
      this.scriptList.appendChild(empty);
      return;
    }
    scripts.forEach(script => {
      const compatibility = analyzeScriptCompatibility(script);
      const blocked = compatibility.blocked === true;
      const card = document.createElement('div');
      card.className = 'script-panel-card';
      if (blocked) card.classList.add('is-compatibility-blocked');
      if (shouldAnimateCards) card.classList.add('is-entering');
      card.style.cssText = 'border:1px solid var(--app-border-default);border-radius:12px;padding:12px;display:flex;gap:10px;align-items:center;justify-content:space-between;';
      if (shouldAnimateCards) card.style.animationDelay = `${Math.min(this.scriptList.children.length * 24, 120)}ms`;
      const left = document.createElement('div');
      left.className = 'script-panel-card-copy';
      left.style.cssText = 'min-width:0;flex:1;';
      const title = document.createElement('div');
      title.className = 'script-panel-card-title';
      title.textContent = script.name || '未命名脚本';
      title.style.cssText = 'font-weight:700;color:var(--app-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      const meta = document.createElement('div');
      meta.className = 'script-panel-card-meta';
      const sourceLabel = SOURCE_LABELS[script.source] || script.source || '脚本';
      meta.textContent = blocked
        ? `${sourceLabel} · 外部扩展 · 已阻止`
        : `${sourceLabel}${script.authorized ? '' : ' · 未授权'}`;
      if (compatibility.message) meta.title = compatibility.message;
      meta.style.cssText = 'font-size:12px;color:var(--app-text-muted);margin-top:4px;';
      left.appendChild(title);
      left.appendChild(meta);
      if (!blocked) this.appendCompatReport(card, left, script, gapReports);
      const icon = document.createElement('span');
      icon.className = 'script-panel-card-icon';
      icon.innerHTML = SCRIPT_ICONS.code;
      const actions = document.createElement('div');
      actions.className = 'script-panel-card-actions';
      actions.style.cssText = 'display:flex;gap:8px;align-items:center;';
      const toggle = document.createElement('input');
      toggle.className = 'script-panel-card-toggle';
      toggle.type = 'checkbox';
      toggle.checked = blocked ? false : Boolean(script.enabled);
      toggle.disabled = blocked;
      if (blocked) toggle.title = compatibility.message;
      toggle.style.cssText = 'width:18px;height:18px;';
      toggle.addEventListener('change', async () => {
        if (toggle.checked && !script.authorized) {
          const ok = await appConfirm({
            title: '启用脚本',
            message: '该脚本可能访问聊天内容或修改变量。确认启用吗？',
          });
          if (!ok) {
            toggle.checked = false;
            return;
          }
        }
        const changed = await this.store.toggleScript(this.tab, scopeId, script.id, toggle.checked);
        if (!changed && toggle.checked) {
          toggle.checked = false;
          this.showStatus(compatibility.message || '该脚本无法在当前沙箱中启用', 'warning');
          return;
        }
        try {
          restartScriptWorker(this.appBridge, '脚本已重新加载');
        } catch {}
        this.refresh();
      });
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'script-panel-card-action';
      editBtn.innerHTML = `${SCRIPT_ICONS.edit}<span>编辑</span>`;
      editBtn.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid var(--app-border-default);background:var(--app-surface-card);font-size:12px;cursor:pointer;';
      editBtn.addEventListener('click', () => this.handleEdit(script, scopeId));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'script-panel-card-action script-panel-card-action--danger';
      delBtn.innerHTML = `${SCRIPT_ICONS.trash}<span>删除</span>`;
      delBtn.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid #fecaca;background:var(--app-surface-card);color:#b91c1c;font-size:12px;cursor:pointer;';
      delBtn.addEventListener('click', () => this.handleDelete(script, scopeId));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(toggle);
      card.appendChild(icon);
      card.appendChild(left);
      card.appendChild(actions);
      this.scriptList.appendChild(card);
    });
  }

  async handleAdd() {
    const scopeId = this.getScopeId();
    const result = await openScriptEditor({ script: {}, title: '创建脚本' });
    if (!result) return;
    await this.store.upsertScript(this.tab, scopeId, {
      name: result.name || '未命名脚本',
      content: result.content || '',
      info: result.info || '',
      enabled: false,
      authorized: true,
    }, { source: 'user', authorized: true });
    this.refresh();
  }

  async handleEdit(script, scopeId) {
    const result = await openScriptEditor({ script, title: '编辑脚本' });
    if (!result) return;
    await this.store.updateScript(this.tab, scopeId, script.id, {
      name: result.name || script.name,
      content: result.content || '',
      info: result.info || '',
    });
    this.refresh();
  }

  async handleDelete(script, scopeId) {
    const ok = await appConfirm({
      title: '删除脚本',
      message: `确定删除脚本「${script.name || '未命名'}」吗？`,
      danger: true,
    });
    if (!ok) return;
    await this.store.deleteScript(this.tab, scopeId, script.id);
    this.refresh();
  }
}
