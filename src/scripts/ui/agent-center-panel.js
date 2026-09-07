import { buildAgentCenterView } from './agent-center-view-model.js';
import { rankModelCandidates } from '../utils/model-candidates.js';
import { findAgentCenterResource } from './agent-center-resource-contract.js';
import { WRITE_PREVIEW_PROVIDER_MODEL_CONTEXT_TOOLS } from '../agent/provider-tool-request-schema.js';
import { PROVIDER_TOOL_PERMISSION_ACTIONS } from '../agent/provider-tool-permission-actions.js';
import { appSettings } from '../storage/app-settings.js';
import { getCurrentLocale, t, translateUiText } from '../i18n/index.js';
import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { appChoice, appConfirm, appPromptText } from './app-confirm.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { captureAgentEditorDrafts, restoreAgentEditorDrafts } from './agent-editor-draft-utils.js';
import { mountAgentRequestPreview } from './chat/agent-request-preview.js';
import { bindCustomSelectButton, closeCustomSelectMenu } from './custom-select.js';
import { buildDebugTextFilename } from './debug-panel-utils.js';
import { exportDebugTextFile } from './debug-panel-export-utils.js';
import { exportDebugTextFlow } from './debug-panel-runtime-utils.js';
import {
    applyPresetBlockHunk,
    presetBlockContentChanged,
} from './preset-preview-utils.js';
import { buildLineDiff } from '../utils/line-diff-utils.js';
import {
    applyMemoryStorageMode,
    deriveMemoryStorageMode,
} from './memory-storage-mode-utils.js';
import {
    GLOBAL_SEMANTIC_PROMPT_ANCHORS,
    GLOBAL_SEMANTIC_PROMPT_BLOCK_TOKEN_LIMIT,
    GLOBAL_SEMANTIC_PROMPT_SCOPE_TOKEN_LIMIT,
    detectGlobalSemanticPromptGuard,
    estimateGlobalSemanticPromptTokens,
    normalizeGlobalSemanticPromptLibrary,
    validateGlobalSemanticPromptBlock,
} from '../agent/global-semantic-prompt-library.js';

const STYLE_ID = 'agent-center-panel-style';
const MAXIMIZED_STORAGE_KEY = 'agent-center-panel-maximized';

const iconSvg = (body) => `
    <svg class="agent-center-icon" viewBox="0 0 24 24" aria-hidden="true">
        ${body}
    </svg>
`;

const ICONS = Object.freeze({
    agent: iconSvg('<path d="M12 8V4"/><rect x="5" y="8" width="14" height="10" rx="4"/><path d="M9 18v2"/><path d="M15 18v2"/><path d="M9 13h.01"/><path d="M15 13h.01"/>'),
    activity: iconSvg('<path d="M4 12h4l2-6 4 12 2-6h4"/>'),
    close: iconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    export: iconSvg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
    pending: iconSvg('<path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/>'),
    prompts: iconSvg('<path d="M4 5h16"/><path d="M4 9h10"/><path d="M4 15h16"/><path d="M4 19h12"/>'),
    diagnostics: iconSvg('<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 16 4-4 3 3 5-7"/><path d="M17 8h2v2"/>'),
    chevron: iconSvg('<path d="m9 18 6-6-6-6"/>'),
    refresh: iconSvg('<path d="M3 12a9 9 0 0 1 15.5-6.2"/><path d="M18 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M6 21v-5h5"/>'),
    resources: iconSvg('<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/><path d="M7 5v14"/>'),
    safety: iconSvg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/>'),
});

const maximizeSvg = `<svg class="agent-center-maximize-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <g class="agent-center-maximize-expand">
        <path class="agent-center-maximize-icon-depth" d="M9 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25V9M15 4.5h2.75a1.75 1.75 0 0 1 1.75 1.75V9M4.5 15v2.75a1.75 1.75 0 0 0 1.75 1.75H9M19.5 15v2.75a1.75 1.75 0 0 1-1.75 1.75H15"/>
        <path class="agent-center-maximize-icon-main" d="M9 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25V9M15 4.5h2.75a1.75 1.75 0 0 1 1.75 1.75V9M4.5 15v2.75a1.75 1.75 0 0 0 1.75 1.75H9M19.5 15v2.75a1.75 1.75 0 0 1-1.75 1.75H15"/>
        <path class="agent-center-maximize-icon-accent" d="m8.2 8.2-2.8-2.8m10.4 2.8 2.8-2.8M8.2 15.8l-2.8 2.8m10.4-2.8 2.8 2.8"/>
    </g>
    <g class="agent-center-maximize-restore">
        <path class="agent-center-maximize-icon-depth" d="M9.25 6.25h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-1M14.75 8.75h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5Z"/>
        <path class="agent-center-maximize-icon-main" d="M9.25 6.25h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-1M14.75 8.75h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5Z"/>
        <path class="agent-center-maximize-icon-accent" d="M9.25 11.75h4v4"/>
    </g>
</svg>`;

const diffAcceptSvg = `<svg class="agent-center-global-diff-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path class="agent-center-global-diff-icon-depth" d="m3.9 10.15 4.1 4.05 8.1-8.35"/>
    <path class="agent-center-global-diff-icon-mark" d="m3.9 10.15 4.1 4.05 8.1-8.35"/>
</svg>`;
const diffRejectSvg = `<svg class="agent-center-global-diff-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path class="agent-center-global-diff-icon-depth" d="m5 5 10 10m0-10L5 15"/>
    <path class="agent-center-global-diff-icon-mark" d="m5 5 10 10m0-10L5 15"/>
</svg>`;

const tabIcon = (id = '') => ({
    pending: ICONS.pending,
    agents: ICONS.agent,
    prompts: ICONS.prompts,
    global_prompts: ICONS.prompts,
    diagnostics: ICONS.diagnostics,
    resources: ICONS.resources,
    activity: ICONS.activity,
    safety: ICONS.safety,
}[trim(id)] || ICONS.agent);

const PANEL_CSS = `
@keyframes agent-center-overlay-in {
    from { opacity: 0; }
    to { opacity: 1; }
}
@keyframes agent-center-panel-in {
    from { opacity: 0; transform: translate3d(0, 30px, 0) scale(0.96); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes agent-center-panel-mobile-in {
    from { opacity: 0; transform: translate3d(0, 24px, 0) scale(0.985); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes agent-center-card-in {
    from { opacity: 0; transform: translate3d(0, 16px, 0) scale(0.97); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes agent-center-floating-in {
    from { opacity: 0; transform: translate3d(76px, 0, 0) scale(0.975); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes agent-center-floating-mobile-in {
    from { opacity: 0; transform: translate3d(0, 28px, 0) scale(0.985); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
.agent-center-overlay {
    position: fixed;
    inset: 0;
    z-index: 22000;
    display: none;
    align-items: flex-start;
    justify-content: flex-end;
    box-sizing: border-box;
    padding: max(4vh, env(safe-area-inset-top, 0px)) max(2.4vw, env(safe-area-inset-right, 0px)) max(4vh, env(safe-area-inset-bottom, 0px)) max(2.4vw, env(safe-area-inset-left, 0px));
    background: rgba(15, 23, 42, 0.28);
    opacity: 0;
}
.agent-center-overlay.is-above-maid-guide {
    z-index: 40100;
}
.agent-center-overlay[style*="flex"] {
    opacity: 1;
    animation: agent-center-overlay-in 180ms ease-out backwards;
}
.agent-center-panel {
    box-sizing: border-box;
    width: clamp(700px, 72vw, 1180px);
    max-width: calc(100vw - max(4.8vw, 20px));
    height: calc(var(--app-visual-height, 100dvh) - 8vh);
    max-height: calc(100vh - 8vh);
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, var(--app-surface-card) 95%, transparent);
    color: var(--app-text-primary);
    border: 1px solid color-mix(in srgb, var(--app-border-default) 62%, rgba(255, 255, 255, 0.72));
    border-radius: 24px;
    box-shadow: 0 44px 120px -28px rgba(30, 41, 59, 0.50), 0 0 0 1px rgba(15, 23, 42, 0.04);
    overflow: hidden;
    isolation: isolate;
    text-rendering: optimizeLegibility;
}
@media (min-width: 681px) {
    .agent-center-overlay.is-maximized {
        justify-content: flex-start;
        padding: calc(var(--app-visual-offset-top, 0px) + env(safe-area-inset-top, 0px)) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    }
    .agent-center-overlay.is-maximized .agent-center-panel {
        width: 100%;
        max-width: none;
        height: calc(var(--app-visual-height, 100dvh) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
        max-height: calc(var(--app-visual-height, 100dvh) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
        border-radius: 0;
    }
}
.agent-center-overlay[style*="flex"] .agent-center-panel {
    animation: agent-center-panel-in 440ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
}
.agent-center-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 20px 0;
    background: transparent;
    flex-shrink: 0;
}
.agent-center-title {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
}
.agent-center-title-mark {
    width: 40px;
    height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border: 1px solid rgba(255, 255, 255, 0.30);
    border-radius: 14px;
    background: linear-gradient(145deg, #6366f1 0%, #3b82f6 56%, #22d3ee 100%);
    color: #fff;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-weight: 800;
    font-size: 17px;
    line-height: 1;
    box-shadow: 0 10px 26px -6px rgba(59, 130, 246, 0.65), inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}
.agent-center-title strong {
    display: block;
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.2;
}
.agent-center-meta {
    margin-top: 3px;
    display: flex;
    align-items: center;
    min-width: 0;
    font-size: 10.5px;
    color: var(--app-text-secondary);
    white-space: nowrap;
    overflow: hidden;
}
.agent-center-meta-item {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
}
.agent-center-meta-item b {
    margin-left: 2px;
    color: color-mix(in srgb, var(--app-text-primary) 72%, var(--app-text-secondary));
    font-weight: 700;
}
.agent-center-meta-separator {
    margin: 0 6px;
    color: color-mix(in srgb, var(--app-text-secondary) 42%, transparent);
}
.agent-center-meta-dot {
    width: 4px;
    height: 4px;
    margin-right: 4px;
    border-radius: 999px;
    background: #94a3b8;
}
.agent-center-meta-dot.is-active { background: #38bdf8; }
.agent-center-meta-dot.is-danger { background: #fb7185; }
.agent-center-meta-dot.is-agent { background: #818cf8; }
.agent-center-meta-dot.is-prompt { background: #a78bfa; }
.agent-center-meta-dot.is-diagnostic { background: #fbbf24; }
.agent-center-meta-dot.is-resource { background: #34d399; }
.agent-center-meta-dot.is-tool { background: #22d3ee; }
.agent-center-meta-item.is-danger b { color: var(--app-danger-text, #f43f5e); }
.agent-center-meta-item.is-on b { color: var(--app-success-text, #059669); }
.agent-center-meta-tail {
    overflow: hidden;
    text-overflow: ellipsis;
}
.agent-center-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
}
.agent-center-button {
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--app-text-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    cursor: pointer;
    transition: background 180ms ease, color 180ms ease, transform 120ms ease;
}
.agent-center-button .agent-center-icon {
    width: 15px;
    height: 15px;
}
.agent-center-maximize-button {
    width: 36px;
    color: color-mix(in srgb, var(--app-text-secondary) 82%, var(--app-accent-primary));
}
.agent-center-maximize-icon {
    display: block;
    width: 20px;
    height: 20px;
    overflow: visible;
    filter: drop-shadow(0 0 2px rgba(var(--app-accent-rgb, 25, 154, 255), 0.22));
}
.agent-center-maximize-icon-depth,
.agent-center-maximize-icon-main,
.agent-center-maximize-icon-accent {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.agent-center-maximize-icon-depth { stroke: currentColor; stroke-width: 4; opacity: 0.12; }
.agent-center-maximize-icon-main { stroke: currentColor; stroke-width: 1.65; }
.agent-center-maximize-icon-accent { stroke: var(--app-accent-primary); stroke-width: 1.15; opacity: 0.82; }
.agent-center-maximize-expand,
.agent-center-maximize-restore {
    transform-box: fill-box;
    transform-origin: center;
    transition: opacity 180ms ease, transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
.agent-center-maximize-restore { opacity: 0; transform: scale(0.72) rotate(-8deg); }
.agent-center-maximize-button.is-on .agent-center-maximize-expand { opacity: 0; transform: scale(0.72) rotate(8deg); }
.agent-center-maximize-button.is-on .agent-center-maximize-restore { opacity: 1; transform: scale(1) rotate(0deg); }
.agent-center-maximize-button:hover,
.agent-center-maximize-button.is-on {
    color: var(--app-accent-primary);
    background: color-mix(in srgb, var(--app-accent-primary) 10%, transparent);
}
.agent-center-button:hover {
    border-color: transparent;
    background: var(--app-surface-subtle);
    color: var(--app-text-primary);
    box-shadow: none;
}
.agent-center-button[data-action="close"]:hover {
    background: var(--app-danger-soft, rgba(244, 63, 94, 0.09));
    color: var(--app-danger-text, #f43f5e);
}
.agent-center-button:active {
    transform: scale(0.90);
}
.agent-center-card-action:hover,
.agent-center-switch:hover,
.agent-center-filter:hover,
.agent-center-tab:hover,
.agent-center-model-manage:hover {
    border-color: rgba(59,130,246,0.28);
    box-shadow: 0 1px 0 rgba(15,23,42,0.06);
}
.agent-center-card-action:active,
.agent-center-switch:active,
.agent-center-filter:active,
.agent-center-tab:active,
.agent-center-model-manage:active {
    transform: translateY(1px);
}
.agent-center-button:focus-visible,
.agent-center-card-action:focus-visible,
.agent-center-switch:focus-visible,
.agent-center-filter:focus-visible,
.agent-center-tab:focus-visible,
.agent-center-model-manage:focus-visible {
    outline: 2px solid rgba(59,130,246,0.42);
    outline-offset: 2px;
}
.agent-center-content.is-global-prompts {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
}
.agent-center-global-workspace {
    position: relative;
    isolation: isolate;
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: color-mix(in srgb, var(--app-surface-subtle) 42%, transparent);
}
.agent-center-global-editor {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}
.agent-center-global-editor-scroll {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px 24px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--app-text-secondary) 22%, transparent) transparent;
}
.agent-center-global-editor-scroll::-webkit-scrollbar,
.agent-center-global-preview-scroll::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}
.agent-center-global-editor-scroll::-webkit-scrollbar-thumb,
.agent-center-global-preview-scroll::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-text-secondary) 20%, transparent);
    background-clip: padding-box;
}
.agent-center-global-overview {
    position: relative;
    overflow: hidden;
    background:
        radial-gradient(circle at 100% 0, rgba(99, 102, 241, 0.12), transparent 34%),
        color-mix(in srgb, var(--app-surface-card) 97%, var(--app-surface-subtle));
}
.agent-center-global-overview::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: linear-gradient(180deg, #6366f1, #38bdf8);
    opacity: 0.72;
}
.agent-center-global-eyebrow {
    margin-bottom: 4px;
    color: color-mix(in srgb, #6366f1 78%, var(--app-text-primary));
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 0.08em;
}
.agent-center-global-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}
.agent-center-global-toolbar-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.agent-center-global-select,
.agent-center-global-input,
.agent-center-global-textarea {
    box-sizing: border-box;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font: inherit;
}
.agent-center-global-select,
.agent-center-global-input {
    min-height: 38px;
    padding: 7px 10px;
}
.agent-center-global-input { width: 100%; }
.agent-center-global-textarea {
    width: 100%;
    min-height: 150px;
    padding: 11px 12px;
    resize: vertical;
    line-height: 1.55;
}
.agent-center-global-card {
    display: grid;
    gap: 10px;
}
.agent-center-global-card.is-dragging { opacity: 0.5; }
.agent-center-global-card.is-drag-over {
    box-shadow: 0 0 0 2px color-mix(in srgb, #3b82f6 55%, transparent);
}
.agent-center-global-card-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
}
.agent-center-global-drag {
    color: var(--app-text-secondary);
    cursor: grab;
    user-select: none;
    font-size: 18px;
    letter-spacing: -3px;
}
.agent-center-global-drag:active { cursor: grabbing; }
.agent-center-global-fields {
    display: grid;
    grid-template-columns: minmax(150px, 0.75fr) minmax(190px, 1fr) minmax(145px, 0.65fr);
    gap: 8px;
}
.agent-center-global-field {
    display: grid;
    gap: 6px;
    min-width: 0;
}
.agent-center-global-field-label {
    color: var(--app-text-secondary);
    font-size: 11.5px;
    font-weight: 700;
}
.agent-center-global-readonly {
    min-height: 38px;
    display: flex;
    align-items: center;
    padding: 7px 10px;
    border: 1px dashed color-mix(in srgb, var(--app-border-default) 88%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--app-surface-subtle) 72%, transparent);
    color: var(--app-text-secondary);
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.agent-center-global-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 38px;
    box-sizing: border-box;
    padding: 6px 10px;
    border: 1px solid var(--app-border-default);
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-surface-subtle) 72%, transparent);
    color: var(--app-text-primary);
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
}
.agent-center-global-toggle:hover {
    border-color: color-mix(in srgb, var(--app-accent-primary) 38%, var(--app-border-default));
}
.agent-center-global-toggle.is-enabled {
    border-color: color-mix(in srgb, var(--app-accent-primary) 34%, var(--app-border-default));
    background: color-mix(in srgb, var(--app-accent-primary) 10%, var(--app-surface-card));
    color: color-mix(in srgb, var(--app-accent-primary) 78%, var(--app-text-primary));
}
.agent-center-global-toggle input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--app-accent-primary);
    cursor: pointer;
}
.agent-center-global-summary-card {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    cursor: pointer;
}
.agent-center-global-summary-card:hover {
    border-color: color-mix(in srgb, var(--app-accent-primary) 28%, var(--app-border-default));
    box-shadow: 0 12px 30px -24px rgba(var(--app-accent-rgb, 25, 154, 255), 0.72);
}
.agent-center-global-summary-card:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--app-accent-primary) 58%, transparent);
    outline-offset: 2px;
}
.agent-center-global-summary-card.is-modified {
    border-color: color-mix(in srgb, var(--app-warning, #f59e0b) 55%, var(--app-border-default));
}
.agent-center-global-summary-copy {
    min-width: 0;
    display: grid;
    gap: 5px;
}
.agent-center-global-summary-title {
    overflow: hidden;
    color: var(--app-text-primary);
    font-size: 14px;
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.agent-center-global-summary-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--app-text-secondary);
    font-size: 11.5px;
    flex-wrap: wrap;
}
.agent-center-global-summary-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}
.agent-center-global-open-icon {
    display: inline-flex;
    color: var(--app-text-secondary);
    transition: transform 160ms ease, color 160ms ease;
}
.agent-center-global-summary-card:hover .agent-center-global-open-icon {
    color: var(--app-accent-primary);
    transform: translateX(2px);
}
.agent-center-global-block-page {
    display: grid;
    gap: 12px;
}
.agent-center-global-block-topbar {
    position: sticky;
    top: -16px;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: -16px -20px 2px;
    padding: 13px 20px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border-default) 78%, transparent);
    background: color-mix(in srgb, var(--app-surface-card) 94%, transparent);
    backdrop-filter: blur(14px);
}
.agent-center-global-block-back {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 34px;
    padding: 6px 9px;
    border: 1px solid var(--app-border-default);
    border-radius: 10px;
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
}
.agent-center-global-block-back .agent-center-icon {
    width: 14px;
    height: 14px;
    transform: rotate(180deg);
}
.agent-center-global-block-heading {
    min-width: 0;
    flex: 1 1 auto;
}
.agent-center-global-block-heading strong,
.agent-center-global-block-heading span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.agent-center-global-block-heading strong { font-size: 14px; }
.agent-center-global-block-heading span {
    margin-top: 2px;
    color: var(--app-text-secondary);
    font-size: 11px;
}
.agent-center-global-block-form {
    display: grid;
    gap: 12px;
}
.agent-center-global-block-form .agent-center-global-textarea {
    min-height: max(330px, calc(var(--app-visual-height, 100dvh) - 450px));
    resize: vertical;
    font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.agent-center-global-block-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}
.agent-center-global-draft-state {
    color: var(--app-text-secondary);
    font-size: 11.5px;
}
.agent-center-global-draft-state.is-modified {
    color: var(--app-warning-text, #b45309);
    font-weight: 700;
}
.agent-center-global-ta-diffwrap { position: relative; }
.agent-center-global-ta-diffwrap > .agent-center-global-textarea {
    position: relative;
    z-index: 1;
    background: transparent;
}
.agent-center-global-ta-difflayer {
    position: absolute;
    inset: 1px;
    z-index: 0;
    overflow: hidden;
    border-radius: 11px;
    background: var(--app-surface-card);
    pointer-events: none;
}
.agent-center-global-ta-mirror {
    position: absolute;
    inset: 0 auto auto 0;
    box-sizing: border-box;
    padding: 11px 12px;
    color: transparent;
    font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: break-word;
    white-space: pre-wrap;
}
.agent-center-global-ta-line { min-height: 1.55em; }
.agent-center-global-ta-add {
    background: rgba(var(--app-diff-add-rgb, var(--app-success-rgb, 46, 160, 67)), 0.15);
    box-shadow: inset 2px 0 0 rgba(var(--app-diff-add-rgb, var(--app-success-rgb, 46, 160, 67)), 0.6);
}
.agent-center-global-ta-delmark {
    height: 0;
    border-top: 2px solid rgba(var(--app-diff-del-rgb, var(--app-danger-rgb, 248, 81, 73)), 0.7);
}
.agent-center-global-preview-focus {
    display: grid;
    gap: 10px;
}
.agent-center-global-preview-editable {
    min-height: 260px;
    padding: 13px 14px;
    border: 1px solid color-mix(in srgb, var(--app-accent-primary) 24%, var(--app-border-default));
    border-radius: 14px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
}
.agent-center-global-preview-editable[contenteditable] {
    cursor: text;
    caret-color: var(--app-accent-primary);
    user-select: text;
    -webkit-user-select: text;
}
.agent-center-global-preview-editable[contenteditable]:focus {
    outline: 1.5px dashed color-mix(in srgb, var(--app-accent-primary) 62%, transparent);
    outline-offset: 2px;
}
.agent-center-global-preview-editable.is-modified { cursor: text; }
.agent-center-global-diff-ins {
    text-decoration: none;
    background: rgba(var(--app-diff-add-rgb, var(--app-success-rgb, 46, 160, 67)), 0.16);
    box-shadow: inset 2px 0 0 rgba(var(--app-diff-add-rgb, var(--app-success-rgb, 46, 160, 67)), 0.65);
}
.agent-center-global-diff-del {
    text-decoration: line-through;
    background: rgba(var(--app-diff-del-rgb, var(--app-danger-rgb, 248, 81, 73)), 0.14);
    box-shadow: inset 2px 0 0 rgba(var(--app-diff-del-rgb, var(--app-danger-rgb, 248, 81, 73)), 0.6);
    opacity: 0.82;
}
.agent-center-global-diff-actions {
    display: inline-flex;
    gap: 3px;
    margin-left: 5px;
    vertical-align: middle;
    user-select: none;
}
.agent-center-global-diff-accept,
.agent-center-global-diff-reject {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    min-width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    cursor: pointer;
    opacity: 0.84;
    transition: transform 120ms ease, opacity 150ms ease;
}
.agent-center-global-diff-accept { color: var(--app-success-text, #15803d); }
.agent-center-global-diff-reject { color: var(--app-danger-text, #b91c1c); }
.agent-center-global-diff-accept:hover,
.agent-center-global-diff-reject:hover { opacity: 1; transform: translateY(-1px); }
.agent-center-global-diff-icon {
    display: block;
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.agent-center-global-diff-icon-depth { stroke-width: 4.4; opacity: 0.13; }
.agent-center-global-diff-icon-mark { stroke-width: 2.25; }
::highlight(agent-global-preview-selection) {
    background: rgba(var(--app-accent-rgb, 25, 154, 255), 0.32);
}
.agent-center-global-warning {
    padding: 9px 11px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--app-danger-soft, #fee2e2) 82%, transparent);
    color: var(--app-danger-text, #be123c);
    font-size: 12px;
}
.agent-center-global-preview {
    display: grid;
    gap: 10px;
}
.agent-center-global-preview-summary {
    padding: 12px 13px;
    border: 1px solid color-mix(in srgb, #6366f1 22%, var(--app-border-default));
    border-radius: 14px;
    background: color-mix(in srgb, #6366f1 6%, var(--app-surface-card));
}
.agent-center-global-preview-block {
    padding: 12px 13px;
    border: 1px solid color-mix(in srgb, #8b5cf6 25%, var(--app-border-default));
    border-radius: 14px;
    background: color-mix(in srgb, #8b5cf6 5%, var(--app-surface-card));
    box-shadow: 0 6px 20px -18px rgba(76, 29, 149, 0.58);
}
.agent-center-global-preview-block pre {
    margin: 7px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.agent-center-global-preview-pane {
    position: relative;
    z-index: 3;
    flex: 0 0 0%;
    width: 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-left: 1px solid var(--app-border-default);
    background: var(--app-surface-subtle);
    opacity: 0;
    transform: translateX(28px);
    pointer-events: none;
    transition:
        flex-basis 300ms cubic-bezier(0.22, 0.61, 0.36, 1),
        transform 300ms cubic-bezier(0.22, 0.61, 0.36, 1),
        opacity 180ms ease;
}
.agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-pane {
    flex-basis: 46%;
    width: auto;
    opacity: 1;
    transform: translateX(0);
    pointer-events: auto;
}
.agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}
.agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-field:last-child {
    grid-column: 1 / -1;
}
.agent-center-global-workspace[data-global-prompt-preview-state="full"] .agent-center-global-preview-pane {
    position: absolute;
    inset: 0;
    width: auto;
    opacity: 1;
    transform: translateX(0);
    pointer-events: auto;
}
.agent-center-global-workspace[data-global-prompt-preview-state="full"] .agent-center-global-editor {
    visibility: hidden;
}
.agent-center-global-preview-head {
    flex: 0 0 auto;
    display: grid;
    gap: 9px;
    padding: 12px 14px 11px 26px;
    border-bottom: 1px solid var(--app-border-default);
    background: color-mix(in srgb, var(--app-surface-card) 96%, var(--app-surface-subtle));
}
.agent-center-global-preview-head-row {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
}
.agent-center-global-preview-heading {
    min-width: 0;
    flex: 1 1 auto;
}
.agent-center-global-preview-title {
    font-size: 13.5px;
    font-weight: 800;
}
.agent-center-global-preview-subtitle {
    margin-top: 2px;
    color: var(--app-text-secondary);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.agent-center-global-preview-actions {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
}
.agent-center-global-preview-icon,
.agent-center-global-preview-back {
    border: 1px solid var(--app-border-default);
    border-radius: 9px;
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    cursor: pointer;
}
.agent-center-global-preview-icon {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.agent-center-global-preview-icon .agent-center-icon,
.agent-center-global-preview-back .agent-center-icon {
    width: 14px;
    height: 14px;
}
.agent-center-global-preview-back {
    display: none;
    align-items: center;
    gap: 4px;
    min-height: 30px;
    padding: 5px 8px;
    font-size: 12px;
    white-space: nowrap;
}
.agent-center-global-preview-back .agent-center-icon {
    transform: rotate(180deg);
}
.agent-center-global-workspace[data-global-prompt-preview-state="full"] .agent-center-global-preview-back {
    display: inline-flex;
}
.agent-center-global-preview-icon:hover,
.agent-center-global-preview-back:hover {
    border-color: color-mix(in srgb, var(--app-accent-primary) 36%, var(--app-border-default));
    color: var(--app-text-primary);
}
.agent-center-global-preview-context {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
}
.agent-center-global-preview-context > span {
    color: var(--app-text-secondary);
    font-size: 11.5px;
    font-weight: 700;
}
.agent-center-global-preview-context .agent-center-global-select {
    width: 100%;
    min-height: 34px;
    padding-top: 5px;
    padding-bottom: 5px;
}
.agent-center-global-preview-scroll {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 14px 16px 24px 26px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--app-text-secondary) 22%, transparent) transparent;
}
.agent-center-global-preview-state {
    min-height: 210px;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--app-text-secondary);
    text-align: center;
    font-size: 12.5px;
    line-height: 1.55;
}
.agent-center-global-preview-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid color-mix(in srgb, var(--app-accent-primary) 18%, transparent);
    border-top-color: var(--app-accent-primary);
    border-radius: 50%;
}
.agent-center-global-preview-handle {
    --agent-global-handle-nudge: 0px;
    appearance: none;
    -webkit-appearance: none;
    position: absolute;
    z-index: 7;
    top: 50%;
    display: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 112px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    opacity: var(--pull-handle-rest-opacity, 0.58);
    transform: translate(var(--agent-global-handle-nudge), -50%);
    cursor: pointer;
    overflow: visible;
    transition: opacity 150ms ease, transform 150ms ease;
}
.agent-center-global-preview-handle::before {
    content: '';
    position: absolute;
    inset: -6px -10px;
}
.agent-center-global-preview-handle::after {
    content: '';
    width: 3px;
    height: var(--pull-handle-anchor-height, 76px);
    border-radius: 999px;
    background: linear-gradient(
        to bottom,
        transparent,
        var(--pull-handle-anchor-color, var(--app-accent-primary)) 48%,
        var(--pull-handle-anchor-color, var(--app-accent-primary)) 52%,
        transparent
    );
    opacity: var(--pull-handle-anchor-rest-opacity, 0.72);
    filter: var(--pull-handle-rest-filter, none);
    transition: width 150ms ease, opacity 150ms ease, filter 150ms ease;
}
.agent-center-global-preview-handle:hover,
.agent-center-global-preview-handle:focus-visible {
    opacity: 1;
    outline: none;
}
.agent-center-global-preview-handle:hover::after,
.agent-center-global-preview-handle:focus-visible::after {
    width: 4px;
    opacity: 1;
    filter: var(--pull-handle-hover-filter, none);
}
.agent-center-global-preview-edge {
    right: 0;
}
.agent-center-global-workspace[data-global-prompt-preview-state="closed"] .agent-center-global-preview-edge {
    display: flex;
}
.agent-center-global-preview-expand,
.agent-center-global-preview-collapse {
    left: 54%;
    height: 56px;
}
.agent-center-global-preview-expand { top: calc(50% - 34px); transform: translate(-100%, -50%); }
.agent-center-global-preview-collapse { top: calc(50% + 34px); }
.agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-expand,
.agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-collapse {
    display: flex;
}
.agent-center-global-preview-return {
    left: 0;
}
.agent-center-global-workspace[data-global-prompt-preview-state="full"] .agent-center-global-preview-return {
    display: flex;
}
@media (max-width: 899px) {
    .agent-center-global-preview-pane {
        position: absolute;
        inset: 0;
        width: auto;
        flex-basis: auto;
        visibility: hidden;
        opacity: 1;
        transform: translateX(100%);
        transition: transform 300ms cubic-bezier(0.22, 0.61, 0.36, 1), visibility 0s linear 300ms;
    }
    .agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-pane,
    .agent-center-global-workspace[data-global-prompt-preview-state="full"] .agent-center-global-preview-pane {
        position: absolute;
        inset: 0;
        visibility: visible;
        transform: translateX(0);
        transition-delay: 0s;
    }
    .agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-editor,
    .agent-center-global-workspace[data-global-prompt-preview-state="full"] .agent-center-global-editor {
        visibility: hidden;
    }
    .agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-expand,
    .agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-collapse {
        display: none;
    }
    .agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-return {
        display: flex;
    }
    .agent-center-global-workspace[data-global-prompt-preview-state="split"] .agent-center-global-preview-back {
        display: inline-flex;
    }
}
@media (max-width: 760px) {
    .agent-center-global-fields { grid-template-columns: 1fr; }
    .agent-center-global-card-head { grid-template-columns: auto minmax(0, 1fr); }
    .agent-center-global-card-head .agent-center-global-toggle { grid-column: 1 / -1; }
    .agent-center-global-summary-card { grid-template-columns: auto minmax(0, 1fr); }
    .agent-center-global-summary-actions {
        grid-column: 2;
        justify-content: flex-end;
        flex-wrap: wrap;
    }
    .agent-center-global-summary-actions .agent-center-global-toggle { margin-right: auto; }
    .agent-center-global-block-topbar {
        top: -12px;
        margin: -12px -12px 2px;
        padding: 11px 12px;
    }
    .agent-center-global-toolbar { align-items: flex-start; }
    .agent-center-global-toolbar-group { width: 100%; }
    .agent-center-global-toolbar-group .agent-center-card-action { flex: 1 1 auto; }
    .agent-center-global-editor-scroll { padding: 12px 12px max(18px, env(safe-area-inset-bottom, 0px)); }
    .agent-center-global-preview-head { padding: 10px 10px 10px 22px; }
    .agent-center-global-preview-scroll { padding: 12px 12px max(18px, env(safe-area-inset-bottom, 0px)) 22px; }
}
.agent-center-tabs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 12px 20px 0;
    padding: 12px 0 14px;
    border-top: 1px solid color-mix(in srgb, var(--app-border-default) 72%, transparent);
    flex-shrink: 0;
}
.agent-center-tab-divider {
    width: 1px;
    height: 20px;
    margin: 0 2px;
    background: color-mix(in srgb, var(--app-border-default) 84%, transparent);
}
.agent-center-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--app-text-secondary);
    min-height: 32px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 200ms ease, border-color 200ms ease, color 200ms ease, transform 120ms ease, box-shadow 200ms ease;
}
.agent-center-tab.is-active {
    border-color: rgba(99, 102, 241, 0.23);
    background: rgba(99, 102, 241, 0.09);
    color: #4f46e5;
    box-shadow: 0 5px 16px -5px rgba(99, 102, 241, 0.44);
    font-weight: 650;
}
.agent-center-tab.is-active .agent-center-icon {
    stroke-width: 2.4;
}
.agent-center-icon {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: 0 0 auto;
}
.agent-center-content {
    min-height: 0;
    flex: 1;
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 16px 20px 20px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--app-text-secondary) 22%, transparent) transparent;
}
.agent-center-content::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}
.agent-center-content::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-text-secondary) 20%, transparent);
    background-clip: padding-box;
}
.agent-center-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.agent-center-filter-row {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
}
.agent-center-filter {
    min-height: 30px;
    border: 1px solid var(--app-border-default);
    border-radius: 999px;
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    padding: 5px 9px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
}
.agent-center-filter.is-active {
    border-color: rgba(59,130,246,0.26);
    background: rgba(59,130,246,0.10);
    color: #1d4ed8;
}
.agent-center-filter.is-danger.is-active {
    border-color: rgba(244,63,94,0.26);
    background: rgba(244,63,94,0.10);
    color: #be123c;
}
.agent-center-card {
    border: 1px solid var(--app-border-default);
    border-radius: 16px;
    background: color-mix(in srgb, var(--app-surface-card) 97%, var(--app-surface-subtle));
    padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
    transition: border-color 240ms ease, background 240ms ease, box-shadow 240ms ease, transform 220ms ease;
}
.agent-center-card.is-failure {
    border-color: rgba(244,63,94,0.24);
    background: rgba(244,63,94,0.07);
}
.agent-center-card.is-notice {
    border-color: rgba(59,130,246,0.20);
    background: rgba(59,130,246,0.07);
}
.agent-center-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
}
.agent-center-card-title {
    font-size: 14.5px;
    font-weight: 750;
    letter-spacing: -0.012em;
    line-height: 1.4;
    word-break: break-word;
}
.agent-center-card-sub {
    margin-top: 6px;
    font-size: 12.5px;
    line-height: 1.58;
    color: var(--app-text-secondary);
    word-break: break-word;
}
.agent-center-card-error {
    color: #be123c;
}
.agent-center-review-detail {
    margin-top: 8px;
    border: 1px solid rgba(148,163,184,0.22);
    border-radius: 8px;
    background: var(--app-surface-card);
    overflow: hidden;
}
.agent-center-review-detail summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    list-style: none;
    color: var(--app-text-primary);
    font-size: 12px;
    font-weight: 700;
}
.agent-center-review-detail summary::-webkit-details-marker {
    display: none;
}
.agent-center-review-detail summary::after {
    content: '展开';
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 600;
}
.agent-center-review-detail[open] summary::after {
    content: '收起';
}
.agent-center-review-detail-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 10px 10px;
}
.agent-center-review-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--app-text-secondary);
}
.agent-center-review-code {
    margin: 4px 0 0;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid rgba(148,163,184,0.20);
    border-radius: 8px;
    background: rgba(15,23,42,0.04);
    color: var(--app-text-primary);
    padding: 8px;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}
.agent-center-review-code.is-delete {
    border-color: rgba(244,63,94,0.22);
    background: rgba(244,63,94,0.08);
}
.agent-center-review-code.is-add {
    border-color: rgba(34,197,94,0.22);
    background: rgba(34,197,94,0.08);
}
.agent-center-review-expandable {
    border: 1px solid rgba(148,163,184,0.20);
    border-radius: 8px;
    background: rgba(15,23,42,0.03);
    overflow: hidden;
}
.agent-center-review-expandable summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 8px;
    cursor: pointer;
    list-style: none;
}
.agent-center-review-expandable summary::-webkit-details-marker {
    display: none;
}
.agent-center-review-expandable-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--app-text-secondary);
}
.agent-center-review-expandable-hint {
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 600;
}
.agent-center-review-expandable-preview {
    grid-column: 1 / -1;
    color: var(--app-text-primary);
    opacity: 0.82;
    font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.agent-center-review-expandable[open] .agent-center-review-expandable-hint {
    color: #2563eb;
}
.agent-center-review-expandable .agent-center-review-code {
    margin: 0 8px 8px;
}
.agent-center-review-patch {
    border: 1px solid rgba(148,163,184,0.18);
    border-radius: 8px;
    padding: 8px;
    background: rgba(148,163,184,0.06);
}
.agent-center-rule-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
}
.agent-center-rule-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 7px 8px;
    border: 1px solid rgba(148,163,184,0.18);
    border-radius: 8px;
    background: var(--app-surface-card);
}
.agent-center-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}
.agent-center-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
}
.agent-center-agent-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}
.agent-center-agent-list.is-entering .agent-center-agent-card {
    animation: agent-center-card-in 430ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
    animation-delay: calc(var(--agent-card-index, 0) * 48ms);
}
.agent-center-agent-card {
    position: relative;
    min-height: 198px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 9px;
    overflow: hidden;
    background: color-mix(in srgb, var(--app-surface-card) 98%, var(--app-surface-subtle));
    transition: border-color 300ms ease, box-shadow 300ms ease, transform 300ms ease;
}
.agent-center-agent-card::before {
    content: '';
    position: absolute;
    z-index: 0;
    top: -58px;
    right: -48px;
    width: 144px;
    height: 144px;
    border-radius: 999px;
    background: var(--agent-card-accent-soft, rgba(59, 130, 246, 0.10));
    filter: blur(24px);
    opacity: 0.70;
    pointer-events: none;
    transition: opacity 300ms ease;
}
.agent-center-agent-card > * {
    position: relative;
    z-index: 1;
}
.agent-center-agent-card.is-agent-on {
    border-color: var(--agent-card-accent-border, rgba(34,197,94,0.24));
}
.agent-center-agent-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 20px 46px -16px rgba(15, 23, 42, 0.24);
}
.agent-center-agent-card:hover::before {
    opacity: 1;
}
.agent-center-agent-card:active {
    transform: translateY(-1px) scale(0.982);
}
.agent-center-agent-card[data-agent-accent="image"],
.agent-center-floating-card[data-agent-accent="image"] {
    --agent-card-accent-soft: rgba(14,165,233,0.12);
    --agent-card-accent-border: rgba(14,165,233,0.28);
}
.agent-center-agent-card[data-agent-accent="memory"],
.agent-center-floating-card[data-agent-accent="memory"] {
    --agent-card-accent-soft: rgba(34,197,94,0.12);
    --agent-card-accent-border: rgba(34,197,94,0.28);
}
.agent-center-agent-card[data-agent-accent="lineage"],
.agent-center-agent-card[data-agent-accent="lane"],
.agent-center-floating-card[data-agent-accent="lineage"],
.agent-center-floating-card[data-agent-accent="lane"] {
    --agent-card-accent-soft: rgba(99,102,241,0.12);
    --agent-card-accent-border: rgba(99,102,241,0.26);
}
.agent-center-agent-card[data-agent-accent="moment"],
.agent-center-agent-card[data-agent-accent="group"],
.agent-center-floating-card[data-agent-accent="moment"],
.agent-center-floating-card[data-agent-accent="group"] {
    --agent-card-accent-soft: rgba(244,114,182,0.11);
    --agent-card-accent-border: rgba(244,114,182,0.25);
}
.agent-center-agent-card[data-agent-accent="summary"],
.agent-center-agent-card[data-agent-accent="dialogue"],
.agent-center-agent-card[data-agent-accent="phone"],
.agent-center-floating-card[data-agent-accent="summary"],
.agent-center-floating-card[data-agent-accent="dialogue"],
.agent-center-floating-card[data-agent-accent="phone"] {
    --agent-card-accent-soft: rgba(245,158,11,0.11);
    --agent-card-accent-border: rgba(245,158,11,0.25);
}
.agent-center-floating-layer {
    position: fixed;
    inset: 0;
    z-index: 22030;
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
    padding: 7.5vh 3.6vw 6.5vh;
    background: rgba(15, 23, 42, 0.18);
}
.agent-center-floating-card {
    position: relative;
    width: clamp(600px, 47vw, 860px);
    max-width: calc(100vw - 7.2vw);
    height: 100%;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--agent-card-accent-border, var(--app-border-default)) 76%, rgba(255, 255, 255, 0.72));
    border-radius: 22px;
    background: color-mix(in srgb, var(--app-surface-card) 98%, var(--app-surface-subtle));
    box-shadow: 0 48px 110px -24px rgba(30, 41, 59, 0.55), 0 0 0 1px rgba(15, 23, 42, 0.04);
}
.agent-center-floating-card.is-entering {
    animation: agent-center-floating-in 430ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
}
.agent-center-floating-card::before {
    content: '';
    position: absolute;
    z-index: 0;
    inset: 0 0 auto;
    height: 116px;
    background: linear-gradient(to bottom, var(--agent-card-accent-soft, rgba(99, 102, 241, 0.10)), transparent);
    pointer-events: none;
}
.agent-center-floating-inner {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    overflow: hidden;
}
.agent-center-floating-face {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 14px 16px 18px;
    background: transparent;
    scrollbar-width: thin;
    transition: opacity 240ms ease, transform 240ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s linear 0s;
}
.agent-center-floating-face-back {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translateX(44px);
    transition: opacity 240ms ease, transform 240ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s linear 240ms;
}
.agent-center-floating-card.is-flipped .agent-center-floating-face-front {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translateX(-44px);
    transition: opacity 240ms ease, transform 240ms cubic-bezier(0.32, 0.72, 0.24, 1), visibility 0s linear 240ms;
}
.agent-center-floating-card.is-flipped .agent-center-floating-face-back {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateX(0);
    transition-delay: 0s;
}
.agent-center-floating-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
}
.agent-center-icon-button {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--app-text-secondary);
    cursor: pointer;
    transition: background 180ms ease, color 180ms ease, transform 120ms ease;
}
.agent-center-icon-button:hover {
    background: var(--app-surface-subtle);
    color: var(--app-text-primary);
}
.agent-center-icon-button:active {
    transform: scale(0.90);
}
.agent-center-icon-button[data-agent-float-close]:hover {
    background: var(--app-danger-soft, rgba(244, 63, 94, 0.09));
    color: var(--app-danger-text, #f43f5e);
}
.agent-center-icon-button[data-agent-float-flip] .agent-center-icon {
    transition: transform 240ms cubic-bezier(0.32, 0.72, 0.24, 1);
}
.agent-center-floating-card.is-flipped .agent-center-icon-button[data-agent-float-flip] .agent-center-icon {
    transform: rotate(180deg);
}
.agent-center-agent-badge {
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border: 1px solid var(--agent-card-accent-border, rgba(59,130,246,0.24));
    border-radius: 14px;
    background: var(--agent-card-accent-soft, rgba(59,130,246,0.10));
    color: var(--app-text-primary);
    box-shadow: 0 8px 20px -9px var(--agent-card-accent-border, rgba(59, 130, 246, 0.38));
    font-size: 17px;
    font-weight: 750;
    transition: transform 300ms ease;
}
.agent-center-agent-card:hover .agent-center-agent-badge {
    transform: scale(1.05) rotate(-3deg);
}
.agent-center-agent-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}
.agent-center-agent-title-main {
    min-width: 0;
    display: flex;
    gap: 12px;
    align-items: center;
}
.agent-center-agent-card-description {
    flex: 1;
    min-height: 38px;
}
.agent-center-agent-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--app-border-default) 68%, transparent);
    color: var(--app-text-secondary);
    font-size: 11.5px;
}
.agent-center-agent-card-footer span:last-child {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: color-mix(in srgb, var(--agent-card-accent-border, #6366f1) 78%, var(--app-text-primary));
    font-size: 11px;
    font-weight: 700;
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 260ms ease, transform 260ms ease;
}
.agent-center-agent-card:hover .agent-center-agent-card-footer span:last-child,
.agent-center-agent-card:focus-visible .agent-center-agent-card-footer span:last-child {
    opacity: 1;
    transform: translateX(0);
}
.agent-center-agent-card-footer .agent-center-icon {
    width: 12px;
    height: 12px;
}
.agent-center-agent-face-back .agent-center-card-title {
    font-size: 13px;
}
.agent-center-agent-section {
    display: grid;
    gap: 8px;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--app-border-default) 88%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--app-surface-card) 94%, transparent);
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
}
.agent-center-agent-section-title {
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 700;
}
.agent-center-agent-mini-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.agent-center-agent-mini-item {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(148,163,184,0.20);
    border-radius: 10px;
    padding: 4px 7px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font-size: 12px;
    font-weight: 600;
}
.agent-center-agent-editor {
    display: grid;
    gap: 8px;
}
.agent-center-agent-editor-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}
.agent-center-agent-field-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
.agent-center-agent-editor-note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--app-text-secondary);
    font-size: 12px;
    line-height: 1.5;
}
.agent-center-agent-editor-note button {
    flex: 0 0 auto;
}
.agent-center-agent-field {
    display: grid;
    gap: 4px;
}
.agent-center-agent-field.is-wide {
    grid-column: 1 / -1;
}
.agent-center-agent-field label,
.agent-center-agent-check {
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 700;
}
.agent-center-agent-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
}
.agent-center-agent-input,
.agent-center-agent-textarea {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
}
.agent-center-agent-input {
    min-height: 30px;
    padding: 5px 7px;
}
.agent-center-agent-textarea {
    min-height: 92px;
    resize: vertical;
    padding: 8px;
    line-height: 1.55;
}
.agent-center-agent-textarea.is-compact {
    min-height: 70px;
}
.agent-center-agent-prompt-preview {
    min-height: 86px;
    padding: 8px;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: color-mix(in srgb, var(--app-surface-card) 88%, transparent);
    color: var(--app-text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
}
.agent-center-agent-input:focus,
.agent-center-agent-textarea:focus {
    outline: 2px solid rgba(59,130,246,0.22);
    border-color: rgba(59,130,246,0.38);
}
.agent-center-agent-settings {
    display: grid;
    gap: 6px;
}
.agent-center-memory-mode-setting {
    display: grid;
    gap: 7px;
    padding: 10px;
    border: 1px solid rgba(148,163,184,0.16);
    border-radius: 12px;
    background: color-mix(in srgb, var(--app-surface-card) 96%, var(--app-surface-subtle));
}
.agent-center-memory-mode-control {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 3px;
    padding: 3px;
    border-radius: 11px;
    background: var(--app-surface-subtle);
}
.agent-center-memory-mode-button {
    min-width: 0;
    min-height: 30px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--app-text-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: background 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
.agent-center-memory-mode-button[aria-pressed="true"] {
    background: var(--app-surface-card);
    color: var(--app-accent-primary);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.10);
}
.agent-center-setting-row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 7px 8px;
    border: 1px solid rgba(148,163,184,0.16);
    border-radius: 12px;
    background: color-mix(in srgb, var(--app-surface-card) 96%, var(--app-surface-subtle));
}
.agent-center-setting-row.is-model {
    grid-template-columns: 104px minmax(0, 1fr);
}
.agent-center-setting-row.is-status {
    grid-template-columns: minmax(72px, max-content) minmax(88px, 1fr) auto;
}
.agent-center-setting-row.is-status .agent-center-setting-value {
    overflow: visible;
    line-height: 1.35;
    white-space: normal;
}
.agent-center-setting-row.is-status .agent-center-switch {
    height: 22px;
    min-height: 22px;
    padding-block: 0;
}
.agent-center-setting-row.is-model > :not(.agent-center-setting-label) {
    grid-column: 2;
}
.agent-center-setting-label {
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 600;
}
.agent-center-setting-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--app-text-primary);
    font-size: 12px;
    font-weight: 700;
}
.agent-center-model-override-row {
    margin-top: 6px;
    display: flex;
    gap: 6px;
    align-items: center;
}
.agent-center-model-override-row .agent-center-card-action {
    flex: 0 0 auto;
}
.agent-center-model-menu[hidden] {
    display: none;
}
.agent-center-model-menu {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-card);
    padding: 4px;
}
.agent-center-model-menu-item {
    border: none;
    background: transparent;
    color: var(--app-text-primary);
    text-align: left;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
}
.agent-center-model-menu-item:hover {
    background: var(--app-surface-subtle);
}
.agent-center-model-menu-item.is-loading {
    color: var(--app-text-secondary);
    cursor: default;
}
.agent-center-model-override {
    flex: 1;
    min-width: 0;
    width: 100%;
    min-height: 30px;
    padding: 5px 9px;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font-size: 12px;
    box-sizing: border-box;
}
.agent-center-model-override::placeholder {
    color: var(--app-text-secondary);
}
.agent-center-model-select {
    width: 100%;
    min-width: 0;
    min-height: 32px;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-subtle);
    color: var(--app-text-primary);
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 600;
    outline: none;
    cursor: pointer;
}
.agent-center-model-select:focus {
    border-color: rgba(59,130,246,0.40);
    box-shadow: 0 0 0 2px rgba(59,130,246,0.12);
}
.agent-center-model-select:disabled {
    cursor: not-allowed;
    opacity: 0.58;
}
.agent-center-model-control {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    align-items: center;
}
.agent-center-model-control .world-app-select-btn {
    min-height: 32px;
    padding: 6px 8px;
    border-radius: 12px;
    background: var(--app-surface-subtle);
    font-size: 12px;
    font-weight: 600;
}
.agent-center-model-manage {
    min-height: 32px;
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-subtle);
    color: var(--app-text-primary);
    padding: 6px 9px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}
.agent-center-model-manage:disabled {
    cursor: not-allowed;
    opacity: 0.58;
}
.agent-center-switch {
    width: 44px;
    min-width: 44px;
    height: 40px;
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border: 0;
    border-radius: 999px;
    background: transparent;
    padding: 9px 3px;
    cursor: pointer;
    box-shadow: none;
    transition: opacity 120ms ease;
}
.agent-center-switch-track {
    position: relative;
    width: 38px;
    height: 22px;
    display: block;
    border: 1px solid color-mix(in srgb, var(--app-border-default) 86%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-text-tertiary, var(--app-text-secondary)) 20%, var(--app-surface-subtle));
    transition: background 180ms ease, border-color 180ms ease;
}
.agent-center-switch-thumb {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--app-surface-card);
    box-shadow: 0 1px 4px rgba(15, 23, 42, 0.22);
    transition: transform 180ms cubic-bezier(0.32, 0.72, 0.24, 1);
}
.agent-center-switch[aria-checked="true"] .agent-center-switch-track {
    border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 78%, transparent);
    background: var(--app-accent-primary, #2563eb);
}
.agent-center-switch[aria-checked="true"] .agent-center-switch-thumb {
    transform: translateX(16px);
}
.agent-center-switch:hover {
    box-shadow: none;
}
.agent-center-switch:hover .agent-center-switch-track {
    border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 48%, var(--app-border-default));
}
.agent-center-switch:active {
    transform: none;
}
.agent-center-switch:active .agent-center-switch-thumb {
    transform: scale(0.88);
}
.agent-center-switch[aria-checked="true"]:active .agent-center-switch-thumb {
    transform: translateX(16px) scale(0.88);
}
.agent-center-switch[aria-busy="true"] {
    opacity: 0.68;
}
.agent-center-switch:disabled {
    cursor: not-allowed;
    opacity: 0.58;
}
.agent-center-memory-mode-badge {
    flex: 0 0 auto;
}
.agent-center-card-action {
    border: 1px solid var(--app-border-default);
    border-radius: 10px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 90ms ease, box-shadow 120ms ease;
}
.agent-center-card-action.is-primary {
    border-color: rgba(14,165,233,0.34);
    background: rgba(14,165,233,0.14);
    color: #0369a1;
}
.agent-center-card-action.is-danger {
    border-color: rgba(244,63,94,0.24);
    background: rgba(244,63,94,0.08);
    color: #be123c;
}
.agent-center-chip {
    display: inline-flex;
    align-items: center;
    min-height: 23px;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.22);
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
}
.agent-center-resource-list {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
}
.agent-center-resource-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    align-items: center;
}
.agent-center-resource-card:hover {
    border-color: rgba(59,130,246,0.22);
    box-shadow: 0 6px 18px rgba(15,23,42,0.08);
    transform: translateY(-1px);
}
.agent-center-resource-card .agent-center-card-head {
    align-items: center;
}
.agent-center-resource-group {
    margin-bottom: 2px;
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 700;
}
.agent-center-resource-main {
    min-width: 0;
}
.agent-center-resource-main .agent-center-card-sub {
    margin-top: 2px;
}
.agent-center-resource-shortcuts {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.agent-center-resource-shortcut {
    min-height: 28px;
    border: 1px solid rgba(148,163,184,0.22);
    border-radius: 8px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    padding: 5px 8px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 90ms ease, box-shadow 120ms ease;
}
.agent-center-resource-shortcut:hover {
    border-color: rgba(59,130,246,0.28);
    background: rgba(59,130,246,0.08);
}
.agent-center-resource-shortcut:active {
    transform: translateY(1px);
}
.agent-center-resource-actions {
    margin-top: 0;
    justify-content: flex-end;
}
.agent-center-chip.is-risk-high,
.agent-center-chip.is-risk-medium {
    border-color: rgba(245,158,11,0.24);
    background: rgba(245,158,11,0.10);
    color: #b45309;
}
.agent-center-chip.is-status-failed,
.agent-center-chip.is-status-denied,
.agent-center-chip.is-status-expired {
    border-color: rgba(244,63,94,0.22);
    background: rgba(244,63,94,0.10);
    color: #be123c;
}
.agent-center-chip.is-status-running,
.agent-center-chip.is-status-pending {
    border-color: rgba(59,130,246,0.22);
    background: rgba(59,130,246,0.10);
    color: #1d4ed8;
}
.agent-center-chip.is-usage {
    border-color: rgba(16,185,129,0.24);
    background: rgba(16,185,129,0.10);
    color: #047857;
}
.agent-center-chip.is-danger {
    border-color: rgba(244,63,94,0.22);
    background: rgba(244,63,94,0.10);
    color: #be123c;
}
.agent-center-chip.is-muted {
    opacity: 0.72;
}
.agent-center-usage-summary {
    margin: 4px 0 10px;
    padding: 10px 12px;
    border: 1px solid rgba(148,163,184,0.20);
    border-radius: 12px;
    background: var(--app-surface-card);
}
.agent-center-usage-summary-title {
    margin-bottom: 4px;
    font-size: 12px;
    font-weight: 700;
    color: var(--app-text-secondary);
}
.agent-center-empty {
    padding: 28px 12px;
    color: var(--app-text-secondary);
    text-align: center;
    font-size: 13px;
}
.agent-center-error {
    margin-bottom: 10px;
    padding: 10px 12px;
    border: 1px solid rgba(244,63,94,0.22);
    border-radius: 8px;
    background: rgba(244,63,94,0.08);
    color: #be123c;
    font-size: 12px;
    line-height: 1.5;
}
@media (max-width: 680px) {
    .agent-center-overlay {
        align-items: flex-end;
        justify-content: center;
        padding: max(8px, env(safe-area-inset-top, 0px)) max(8px, env(safe-area-inset-right, 0px)) max(8px, env(safe-area-inset-bottom, 0px)) max(8px, env(safe-area-inset-left, 0px));
    }
    .agent-center-panel {
        width: 100%;
        max-width: none;
        height: min(92dvh, calc(var(--app-visual-height, 100dvh) - max(16px, env(safe-area-inset-top, 0px)) - max(8px, env(safe-area-inset-bottom, 0px))));
        max-height: none;
        border-radius: 22px 22px 14px 14px;
        box-shadow: 0 -18px 54px -16px rgba(15, 23, 42, 0.36);
    }
    .agent-center-maximize-button { display: none; }
    .agent-center-overlay[style*="flex"] .agent-center-panel {
        animation-name: agent-center-panel-mobile-in;
    }
    .agent-center-header {
        padding: 13px 12px 0;
    }
    .agent-center-title-mark {
        width: 36px;
        height: 36px;
        border-radius: 12px;
        font-size: 15px;
    }
    .agent-center-tabs {
        flex-wrap: nowrap;
        gap: 5px;
        margin: 10px 12px 0;
        padding: 10px 0 11px;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }
    .agent-center-tabs::-webkit-scrollbar {
        display: none;
    }
    .agent-center-tab,
    .agent-center-tab-divider {
        flex: 0 0 auto;
    }
    .agent-center-tab {
        min-height: 32px;
        padding: 6px 11px;
    }
    .agent-center-content {
        padding: 12px;
    }
    .agent-center-agent-list {
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
    }
    .agent-center-agent-card {
        min-height: 188px;
    }
    .agent-center-floating-layer {
        align-items: flex-end;
        justify-content: center;
        padding: max(10px, env(safe-area-inset-top, 0px)) max(8px, env(safe-area-inset-right, 0px)) max(8px, env(safe-area-inset-bottom, 0px)) max(8px, env(safe-area-inset-left, 0px));
    }
    .agent-center-floating-card {
        width: 100%;
        max-width: none;
        height: min(88dvh, calc(var(--app-visual-height, 100dvh) - max(20px, env(safe-area-inset-top, 0px)) - max(8px, env(safe-area-inset-bottom, 0px))));
        border-radius: 22px 22px 12px 12px;
    }
    .agent-center-floating-card.is-entering {
        animation-name: agent-center-floating-mobile-in;
    }
    .agent-center-floating-face {
        padding: 13px 12px max(16px, env(safe-area-inset-bottom, 0px));
    }
    .agent-center-setting-row {
        grid-template-columns: 64px minmax(0, 1fr);
    }
    .agent-center-setting-row.is-model {
        grid-template-columns: 64px minmax(0, 1fr);
    }
    .agent-center-setting-row.is-status {
        grid-template-columns: minmax(56px, max-content) minmax(72px, 1fr) auto;
    }
    .agent-center-setting-row > .agent-center-card-action {
        grid-column: 1 / -1;
        width: 100%;
    }
    .agent-center-agent-field-grid {
        grid-template-columns: minmax(0, 1fr);
    }
    .agent-center-resource-list {
        grid-template-columns: minmax(0, 1fr);
    }
    .agent-center-resource-card {
        grid-template-columns: minmax(0, 1fr);
    }
    .agent-center-resource-actions {
        justify-content: flex-start;
    }
}
@media (max-width: 430px) {
    .agent-center-actions {
        gap: 0;
    }
    .agent-center-title {
        gap: 9px;
    }
    .agent-center-title strong {
        font-size: 16px;
    }
    .agent-center-meta {
        max-width: calc(100vw - 190px);
    }
    .agent-center-agent-badge {
        width: 40px;
        height: 40px;
        border-radius: 13px;
    }
    .agent-center-floating-face .agent-center-agent-title-main {
        gap: 9px;
    }
}
body[data-theme-mode='dark'] .agent-center-title-mark {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.22);
    background: linear-gradient(145deg, #6366f1 0%, #3b82f6 56%, #22d3ee 100%);
}
body[data-theme-mode='dark'] .agent-center-card,
body[data-theme-mode='dark'] .agent-center-agent-card.is-agent-on {
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
}
body[data-theme-mode='dark'] .agent-center-panel,
body[data-theme-mode='dark'] .agent-center-floating-card {
    border-color: color-mix(in srgb, var(--app-border-default) 86%, rgba(255, 255, 255, 0.10));
}
body[data-theme-mode='dark'] .agent-center-tab.is-active {
    color: #8ecbff;
    border-color: rgba(121, 192, 255, 0.32);
    background: rgba(121, 192, 255, 0.13);
    box-shadow: 0 5px 16px -5px rgba(121, 192, 255, 0.36);
}
@media (hover: none) {
    .agent-center-agent-card:hover {
        transform: none;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
    }
    .agent-center-agent-card:hover .agent-center-agent-badge {
        transform: none;
    }
    .agent-center-agent-card .agent-center-agent-card-footer span:last-child {
        opacity: 1;
        transform: none;
    }
}
@media (prefers-reduced-motion: reduce) {
    .agent-center-overlay,
    .agent-center-panel,
    .agent-center-button,
    .agent-center-card,
    .agent-center-agent-card::before,
    .agent-center-agent-badge,
    .agent-center-floating-card,
    .agent-center-floating-face,
    .agent-center-icon-button,
    .agent-center-icon-button .agent-center-icon,
    .agent-center-card-action,
    .agent-center-memory-mode-button,
    .agent-center-resource-shortcut,
    .agent-center-switch,
    .agent-center-filter,
    .agent-center-tab,
    .agent-center-model-manage,
    .agent-center-global-preview-pane,
    .agent-center-global-preview-handle,
    .agent-center-maximize-expand,
    .agent-center-maximize-restore,
    .agent-center-global-preview-spinner {
        animation: none !important;
        transition: none !important;
    }
    .agent-center-panel,
    .agent-center-card,
    .agent-center-agent-badge,
    .agent-center-floating-card,
    .agent-center-icon-button,
    .agent-center-icon-button .agent-center-icon {
        transform: none !important;
    }
}
body[data-reduced-motion='on'] .agent-center-overlay,
body[data-reduced-motion='on'] .agent-center-panel,
body[data-reduced-motion='on'] .agent-center-button,
body[data-reduced-motion='on'] .agent-center-card,
body[data-reduced-motion='on'] .agent-center-agent-card::before,
body[data-reduced-motion='on'] .agent-center-agent-badge,
body[data-reduced-motion='on'] .agent-center-floating-card,
body[data-reduced-motion='on'] .agent-center-floating-face,
body[data-reduced-motion='on'] .agent-center-icon-button,
body[data-reduced-motion='on'] .agent-center-icon-button .agent-center-icon,
body[data-reduced-motion='on'] .agent-center-card-action,
body[data-reduced-motion='on'] .agent-center-memory-mode-button,
body[data-reduced-motion='on'] .agent-center-resource-shortcut,
body[data-reduced-motion='on'] .agent-center-switch,
body[data-reduced-motion='on'] .agent-center-filter,
body[data-reduced-motion='on'] .agent-center-tab,
body[data-reduced-motion='on'] .agent-center-model-manage,
body[data-reduced-motion='on'] .agent-center-global-preview-pane,
body[data-reduced-motion='on'] .agent-center-global-preview-handle,
body[data-reduced-motion='on'] .agent-center-maximize-expand,
body[data-reduced-motion='on'] .agent-center-maximize-restore,
body[data-reduced-motion='on'] .agent-center-global-preview-spinner {
    animation: none !important;
    transition: none !important;
}
body[data-reduced-motion='on'] .agent-center-panel,
body[data-reduced-motion='on'] .agent-center-card,
body[data-reduced-motion='on'] .agent-center-agent-badge,
body[data-reduced-motion='on'] .agent-center-floating-card,
body[data-reduced-motion='on'] .agent-center-icon-button,
body[data-reduced-motion='on'] .agent-center-icon-button .agent-center-icon {
    transform: none !important;
}
`;

const trim = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
}[ch]));

const list = value => (Array.isArray(value) ? value : [value])
    .map(item => trim(item))
    .filter(Boolean);

const formatMeta = (items = []) => items.filter(Boolean).join(' · ');

const formatToggleTargetLabel = (action = 'enable', title = '') => {
    const verb = getCurrentLocale() === 'en'
        ? translateUiText(action === 'enable' ? '开启功能' : '关闭功能')
        : translateUiText(action === 'enable' ? '开启' : '关闭');
    const target = translateUiText(title);
    return /^[A-Za-z]/.test(verb) ? `${verb} ${target}` : `${verb}${target}`;
};

const statusChipClass = value => `agent-center-chip is-status-${trim(value, 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;

const riskChipClass = value => `agent-center-chip is-risk-${trim(value, 'low').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;

const normalizeActivityStatus = (value = '') => {
    const status = trim(value).toLowerCase();
    return ['active', 'failure', 'queued', 'running', 'waiting_permission', 'succeeded', 'failed', 'cancelled'].includes(status)
        ? status
        : '';
};

const normalizeSurface = (value = '') => trim(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

const activityStatusLabel = (status = '') => ({
    active: '运行中',
    failure: '失败',
    queued: '排队',
    running: '运行中',
    waiting_permission: '待确认',
    succeeded: '完成',
    failed: '失败',
    cancelled: '已取消',
}[normalizeActivityStatus(status)] || '全部');

const activityCardClass = runOrStatus => {
    const status = trim(typeof runOrStatus === 'string' ? runOrStatus : runOrStatus?.status).toLowerCase();
    const decision = trim(typeof runOrStatus === 'string' ? '' : runOrStatus?.reviewDecision || runOrStatus?.metadata?.reviewDecision);
    if (status === 'cancelled' && ['rejected', 'user_rejected'].includes(decision)) return 'agent-center-card';
    return ['failed', 'cancelled'].includes(status) ? 'agent-center-card is-failure' : 'agent-center-card';
};

const renderChips = (chips = []) => {
    const html = chips.filter(Boolean).map((chip) => {
        const label = trim(chip.label);
        if (!label) return '';
        return `<span class="${escapeHtml(chip.className || 'agent-center-chip')}" data-i18n-skip>${escapeHtml(translateUiText(label))}</span>`;
    }).filter(Boolean).join('');
    return html ? `<div class="agent-center-chip-row">${html}</div>` : '';
};

const renderEmpty = message => `<div class="agent-center-empty" data-i18n-skip>${escapeHtml(translateUiText(message))}</div>`;

// Phase B 只读用量：token/延迟的紧凑格式化，仅呈现真实计量，无估算。
const formatTokenCount = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '-';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.trunc(n));
};

const formatLatencyMs = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '-';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.trunc(n)}ms`;
};

// 单个 run 的 usage chip：recorded 显示 token/延迟；unknown 只在有本地事实时显示延迟，不伪造 token。
const buildRunUsageChips = (usage = null) => {
    if (!usage || typeof usage !== 'object') return [];
    const chips = [];
    if (usage.status === 'recorded' && Number.isFinite(Number(usage.totalTokens))) {
        chips.push({ label: `Token ${formatTokenCount(usage.totalTokens)}`, className: 'agent-center-chip is-usage' });
    } else if (usage.status !== 'recorded') {
        chips.push({ label: 'Token 未计量', className: 'agent-center-chip is-muted' });
    }
    if (Number.isFinite(Number(usage.latencyMs)) && Number(usage.latencyMs) > 0) {
        chips.push({ label: `模型 ${formatLatencyMs(usage.latencyMs)}`, className: 'agent-center-chip' });
    }
    if (usage.degraded === true) chips.push({ label: '降级', className: 'agent-center-chip is-danger' });
    return chips;
};

// 活动页顶部的只读用量画像摘要（overall + 主要任务类型），不含任何自动决策。
const renderUsageProfileSummary = (profile = null) => {
    const overall = profile?.overall;
    if (!overall || !Number(overall.runCount)) return '';
    const parts = [
        `运行 ${Number(overall.runCount)}`,
        `已计量 ${Number(overall.recordedCount)}`,
        overall.unknownCount ? `未计量 ${Number(overall.unknownCount)}` : '',
        overall.recordedCount ? `Token 合计 ${formatTokenCount(overall.totalTokens)}` : '',
        overall.avgTotalTokens != null ? `均 ${formatTokenCount(overall.avgTotalTokens)}/次` : '',
        overall.avgLatencyMs != null ? `均延迟 ${formatLatencyMs(overall.avgLatencyMs)}` : '',
        overall.degradedCount ? `降级 ${Number(overall.degradedCount)}` : '',
    ].filter(Boolean).map(part => translateUiText(part));
    const topKinds = (Array.isArray(profile.byKind) ? profile.byKind : [])
        .filter(k => Number(k.runCount) > 0)
        .slice(0, 3)
        .map(k => `${translateUiText(displayAgentKind(k.kind))} ${Number(k.runCount)}${k.recordedCount ? ` (Token ${formatTokenCount(k.totalTokens)})` : ''}`);
    return `
        <div class="agent-center-usage-summary">
            <div class="agent-center-usage-summary-title">用量画像（当前活动列表 · 只读）</div>
            <div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(formatMeta(parts))}</div>
            ${topKinds.length ? `<div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(topKinds.join(' · '))}</div>` : ''}
        </div>`;
};

const renderNotice = ({
    title = '',
    message = '',
    actionLabel = '',
    actionAttr = '',
} = {}) => `
    <article class="agent-center-card is-notice">
        ${title ? `<div class="agent-center-card-title" data-i18n-skip>${escapeHtml(translateUiText(title))}</div>` : ''}
        ${message ? `<div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(translateUiText(message))}</div>` : ''}
        ${actionLabel && actionAttr ? `
            <div class="agent-center-card-actions">
                <button type="button" class="agent-center-card-action" ${actionAttr} data-i18n-skip>${escapeHtml(translateUiText(actionLabel))}</button>
            </div>
        ` : ''}
    </article>
`;

const renderReviewCodeBlock = (label = '', text = '', className = '') => {
    const body = String(text ?? '');
    if (!body.trim()) return '';
    return `
        <div>
            <div class="agent-center-review-label">${escapeHtml(label)}</div>
            <pre class="agent-center-review-code${className ? ` ${escapeHtml(className)}` : ''}">${escapeHtml(body)}</pre>
        </div>
    `;
};

const renderExpandableReviewCodeBlock = ({
    label = '',
    preview = '',
    text = '',
    truncated = false,
} = {}) => {
    const body = String(text || preview || '');
    if (!body.trim()) return '';
    const previewText = trim(preview || body.replace(/\s+/g, ' ').slice(0, 180));
    return `
        <details class="agent-center-review-expandable">
            <summary>
                <span class="agent-center-review-expandable-title">${escapeHtml(label)}${truncated ? '（已截断保存）' : ''}</span>
                <span class="agent-center-review-expandable-hint">点击查看完整</span>
                ${previewText ? `<span class="agent-center-review-expandable-preview">${escapeHtml(previewText)}</span>` : ''}
            </summary>
            <pre class="agent-center-review-code">${escapeHtml(body)}</pre>
        </details>
    `;
};

const formatPatchLineRange = (patch = {}) => {
    const start = Number(patch.startLine || 0);
    const end = Number(patch.endLine || 0);
    if (!start || !end) return '';
    return start === end ? `第 ${start} 行` : `第 ${start}-${end} 行`;
};

const renderChatFormatModelReviewDetail = (detail = null) => {
    if (!detail) return '';
    const meta = formatMeta([
        detail.status ? `状态：${detail.status}` : '',
        detail.canRepair ? '可修复' : '',
        Number(detail.patchCount || 0) ? `${Number(detail.patchCount || 0)} 个 patch` : '',
    ]);
    const issueText = (detail.issues || []).length
        ? `模型判断：${(detail.issues || []).map(issue => formatMeta([issue.type, issue.message])).filter(Boolean).join('；')}`
        : '';
    const patchHtml = (detail.linePatches || []).map((patch) => {
        const originalText = Array.isArray(patch.originalLines) ? patch.originalLines.map(line => `- ${line}`).join('\n') : '';
        const replacementText = Array.isArray(patch.replacementLines) ? patch.replacementLines.map(line => `+ ${line}`).join('\n') : '';
        const patchMeta = formatMeta([
            formatPatchLineRange(patch),
            patch.reason,
            patch.originalMatches === false ? '原文校验未通过' : '',
            patch.replacementLinesTruncated ? '替换行已截断' : '',
        ]);
        return `
            <div class="agent-center-review-patch">
                ${patchMeta ? `<div class="agent-center-card-sub">${escapeHtml(patchMeta)}</div>` : ''}
                ${renderReviewCodeBlock('原文', originalText, 'is-delete')}
                ${renderReviewCodeBlock('建议', replacementText || (Number(patch.replacementLineCount || 0) === 0 ? '+ （删除这些行）' : ''), 'is-add')}
            </div>
        `;
    }).join('');
    const correctedLabel = detail.correctedTextTruncated ? '修复后文本（已截断）' : '修复后文本';
    const correctedHtml = renderReviewCodeBlock(correctedLabel, detail.correctedText || '');
    const rawPreviewHtml = (detail.rawText || detail.rawPreview)
        ? renderExpandableReviewCodeBlock({
            label: '模型原始返回预览',
            preview: detail.rawPreview,
            text: detail.rawText || detail.rawPreview,
            truncated: detail.rawTextTruncated,
        })
        : '';
    if (!meta && !issueText && !patchHtml && !correctedHtml && !rawPreviewHtml && !detail.repairSummary) return '';
    return `
        <details class="agent-center-review-detail">
            <summary>
                <span>模型修复返回</span>
                ${meta ? `<span class="agent-center-card-sub">${escapeHtml(meta)}</span>` : ''}
            </summary>
            <div class="agent-center-review-detail-body">
                ${detail.repairSummary ? `<div class="agent-center-card-sub">${escapeHtml(detail.repairSummary)}</div>` : ''}
                ${issueText ? `<div class="agent-center-card-sub">${escapeHtml(issueText)}</div>` : ''}
                ${patchHtml}
                ${correctedHtml}
                ${rawPreviewHtml}
            </div>
        </details>
    `;
};

const renderChatFormatAutoRepair = (autoRepair = null) => {
    if (!autoRepair) return '';
    const parts = [
        autoRepair.autoApplyRepair ? '自动应用开启' : '',
        autoRepair.attempted ? '已尝试' : '未尝试',
        autoRepair.didAnything ? '已写入聊天' : '未写入聊天',
        Number(autoRepair.eventCount || 0) ? `${Number(autoRepair.eventCount || 0)} 个事件` : '',
        autoRepair.reason,
        autoRepair.errorMessage,
    ].filter(Boolean);
    if (!parts.length) return '';
    const className = autoRepair.attempted && !autoRepair.didAnything
        ? 'agent-center-card-sub agent-center-card-error'
        : 'agent-center-card-sub';
    return `<div class="${className}">自动应用：${escapeHtml(parts.join(' · '))}</div>`;
};

const renderChatFormatReview = (review = null) => {
    if (!review) return '';
    if (review.type === 'body_quality') {
        const issueText = formatMeta([
            `发现 ${Number(review.issueCount || (review.issues || []).length || 0)} 个问题`,
            review.hasRawOriginal ? '检查原始回复' : '',
        ]);
        const issuesText = (review.issues || []).length
            ? `问题：${(review.issues || []).map(issue => formatMeta([issue.title, issue.summary])).filter(Boolean).join('；')}`
            : '';
        const patchText = review.patchCandidate?.available
            ? `优化候选：${formatMeta([review.patchCandidate.title, review.patchCandidate.summary, review.patchCandidate.risk])}`
            : '';
        const actionText = (review.actionLabels || []).length
            ? `可在消息旁处理：${review.actionLabels.join('、')}`
            : '';
        return [
            issueText ? `<div class="agent-center-card-sub">正文检查：${escapeHtml(issueText)}</div>` : '',
            issuesText ? `<div class="agent-center-card-sub">${escapeHtml(issuesText)}</div>` : '',
            patchText ? `<div class="agent-center-card-sub">${escapeHtml(patchText)}</div>` : '',
            actionText ? `<div class="agent-center-card-sub">${escapeHtml(actionText)}</div>` : '',
        ].filter(Boolean).join('');
    }
    const issueText = formatMeta([
        `发现 ${Number((review.errors || []).length) + Number((review.warnings || []).length)} 条提醒`,
        review.hasRawOriginal ? '检查原始回复' : '',
    ]);
    const errorText = (review.errors || []).length ? `需要处理：${(review.errors || []).join('；')}` : '';
    const warningText = (review.warnings || []).length ? `提醒：${(review.warnings || []).join('；')}` : '';
    const repairText = review.repairCandidate?.available
        ? `修复候选：${formatMeta([review.repairCandidate.title, review.repairCandidate.summary])}`
        : '';
    const actionText = (review.actionLabels || []).length
        ? `可在消息旁处理：${review.actionLabels.join('、')}`
        : '';
    return [
        issueText ? `<div class="agent-center-card-sub">格式检查：${escapeHtml(issueText)}</div>` : '',
        errorText ? `<div class="agent-center-card-sub agent-center-card-error">${escapeHtml(errorText)}</div>` : '',
        warningText ? `<div class="agent-center-card-sub">${escapeHtml(warningText)}</div>` : '',
        repairText ? `<div class="agent-center-card-sub">${escapeHtml(repairText)}</div>` : '',
        renderChatFormatAutoRepair(review.autoRepair),
        actionText ? `<div class="agent-center-card-sub">${escapeHtml(actionText)}</div>` : '',
        renderChatFormatModelReviewDetail(review.modelReviewDetail),
    ].filter(Boolean).join('');
};

const providerToolActionLabel = action => ({
    [PROVIDER_TOOL_PERMISSION_ACTIONS.allowOnce]: '执行一次',
    [PROVIDER_TOOL_PERMISSION_ACTIONS.deny]: '打回',
    [PROVIDER_TOOL_PERMISSION_ACTIONS.rememberAllow]: '记住执行',
}[action] || '处理');

const continuationCommitStrategyLabel = strategy => ({
    preview_only: '只预览',
    append_to_previous_bubble: '接到上一气泡',
}[trim(strategy)] || '只预览');

const normalizeContinuationCommitStrategy = strategy => (
    trim(strategy) === 'append_to_previous_bubble' ? 'append_to_previous_bubble' : 'preview_only'
);

const TOOL_LABELS = Object.freeze({
    'contact_profile.list': '读取联系人列表',
    'contact_profile.get': '读取联系人画像',
    'chat.emit_private': '私聊候选',
    'chat.emit_group': '群聊候选',
    'chat.emit_moment_comment': '动态评论候选',
    'chat.emit_moment_post': '动态发布候选',
    'memory.preview_actions': '记忆变更预览',
    'variable.preview_commands': '变量变更预览',
    'worldbook.preview_actions': '世界书变更预览',
});

const STATUS_LABELS = Object.freeze({
    pending: '待确认',
    allowed: '已允许',
    denied: '已拒绝',
    idle: '未执行',
    ready: '已就绪',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    skipped: '已略过',
    blocked: '已阻止',
    expired: '已过期',
    committed: '已提交',
    undone: '已撤销',
    waiting_permission: '待确认',
});

const RISK_LABELS = Object.freeze({
    low: '低风险',
    medium: '中风险',
    high: '高风险',
});

const PERMISSION_LABELS = Object.freeze({
    storage: '读取本地资料',
    'storage:read': '读取本地资料',
    'storage:write': '写入本地资料',
    'chat:emit_candidate': '聊天候选',
    'contact:read': '读取联系人',
    'memory:read': '读取记忆',
    'memory:write': '写入记忆',
    'variables:read': '读取变量',
    'variables:write': '写入变量',
    'worldbook:read': '读取世界书',
    'worldbook:write': '写入世界书',
});

const AGENT_KIND_LABELS = Object.freeze({
    maid_assistant: '女仆任务',
    chat_format_guardian: '聊天格式检查',
    chat_body_quality_guardian: '正文检查',
    memory_update: '记忆更新',
    image_generation: '图片生成',
    image_director_generation: '生图整理',
    moment_summary: '动态整理',
    lineage_layout: '血缘图排版',
    creative_execution_lane: '执行泳道',
    summary_compaction: '摘要压缩',
    moment_comment: '动态评论',
    moment_publish: '动态发布',
    phone_format: '手机格式',
    chat_guide: '聊天提示',
    group_chat: '群聊提示',
});

const AGENT_FEATURE_LABELS = Object.freeze({
    reply_check: '检查回复格式',
    write_preview: '预览记忆和变量变更',
    text_completion: '文本补全',
});

const displayToolName = toolName => TOOL_LABELS[trim(toolName)] || trim(toolName, 'Agent 工具');
const displayStatusLabel = status => STATUS_LABELS[trim(status).toLowerCase()] || trim(status, '未知');
const isUserRejectedReview = value => trim(value) === 'user_rejected' || trim(value) === 'rejected';
const displayCommitStatusLabel = commit => (
    isUserRejectedReview(commit?.reviewDecision) && trim(commit?.status) === 'skipped'
        ? '已打回'
        : displayStatusLabel(commit?.status)
);
const displayRunStatusLabel = run => {
    const decision = trim(run?.reviewDecision || run?.metadata?.reviewDecision);
    if (run?.status === 'cancelled' && (decision === 'rejected' || decision === 'user_rejected')) return '已打回';
    if (run?.status === 'succeeded' && (decision === 'executed' || decision === 'user_executed')) return '已执行';
    return displayStatusLabel(run?.status);
};
const displayRiskLabel = risk => RISK_LABELS[trim(risk).toLowerCase()] || trim(risk, '风险未知');
const displayPermissionLabel = permission => PERMISSION_LABELS[trim(permission)] || trim(permission);
const displayAgentKind = kind => AGENT_KIND_LABELS[trim(kind)] || trim(kind);
const displayAgentFeature = id => AGENT_FEATURE_LABELS[trim(id)] || trim(id, 'Agent');
const displayCardCategory = category => ({
    creative: '创作执行',
    memory: '记忆与摘要',
    social: '动态执行',
    assistant: '辅助执行',
    safety: '写入安全',
    prompt_module: '提示词/协议',
    diagnostic: '诊断视图',
}[trim(category)] || trim(category, 'Agent'));

const AGENT_CARD_GLYPHS = Object.freeze({
    image_director: '✦',
    memory_table_agent: '▦',
    lineage_agent: '⌘',
    execution_lane_agent: '≋',
    summary_agent: 'Σ',
    moment_agent: '◉',
    dialogue_agent: '◌',
    group_agent: '◎',
    phone_format_agent: '▯',
    reply_check: '✓',
    write_preview: '⌁',
    variable: 'Δ',
    text_completion: '…',
    prompt_manager: '¶',
    memory_manager: '◇',
});

const displayAgentCardGlyph = card => (
    AGENT_CARD_GLYPHS[trim(card?.id)] || trim(card?.title, 'A').slice(0, 1).toUpperCase()
);

const FEATURE_AGENT_CARD_IDS = new Set([
    'reply_check',
    'write_preview',
    'text_completion',
    'prompt_manager',
    'memory_manager',
]);

const AGENT_CARD_INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, [contenteditable="true"], [role="switch"]';

const MEMORY_STORAGE_MODE_LABELS = Object.freeze({
    off: '关闭',
    summary: '摘要',
    table: '表格',
});

const isFeatureAgentCard = agent => (
    trim(agent?.toggleKind) === 'feature' ||
    trim(agent?.cardType) === 'feature' ||
    FEATURE_AGENT_CARD_IDS.has(trim(agent?.id))
);

const PROMPT_POSITION_OPTIONS = Object.freeze([
    { value: 0, label: 'IN_PROMPT' },
    { value: 1, label: 'IN_CHAT' },
    { value: 4, label: '最新输入前' },
    { value: 5, label: '最新输入后' },
    { value: 2, label: 'BEFORE_PROMPT' },
    { value: -1, label: 'NONE' },
]);

const PROMPT_ROLE_OPTIONS = Object.freeze([
    { value: 0, label: 'SYSTEM' },
    { value: 1, label: 'USER' },
    { value: 2, label: 'ASSISTANT' },
]);

const PROMPT_REFS_WITH_PLACEMENT = new Set([
    'dialogue',
    'group',
    'moment',
    'moment-comment',
    'moment-publish-comment',
    'auto-image-prompt',
    'summary',
]);

const MEMORY_POSITION_OPTIONS = Object.freeze([
    { value: '', label: '跟随通用设置' },
    { value: 'template', label: '模板默认' },
    { value: 'before_latest_user', label: '最新输入前' },
    { value: 'after_latest_user', label: '最新输入后' },
    { value: 'history_depth', label: '历史深度' },
    { value: 'before_chat', label: '聊天前' },
    { value: 'history_before', label: '历史前' },
    { value: 'history_after', label: '历史后' },
    { value: 'system_end', label: '系统末尾' },
    { value: 'system_end+before_chat', label: '系统末尾 + 聊天前' },
]);

const REPLY_CHECK_PREVIEW_TARGET_OPTIONS = Object.freeze([
    { value: 'auto', label: '跟随当前场景' },
    { value: 'private_chat', label: '私聊格式' },
    { value: 'group_chat', label: '群聊格式' },
    { value: 'moment_comment', label: '动态评论' },
    { value: 'moment_post', label: '动态发布' },
    { value: 'image_prompt', label: '生图标签' },
    { value: 'memory_table_edit', label: '记忆表格' },
    { value: 'creative_text', label: '创意写作' },
]);

const permissionDecisionChipClass = decision => ({
    allow: statusChipClass('running'),
    deny: statusChipClass('denied'),
    ask: statusChipClass('pending'),
}[trim(decision)] || 'agent-center-chip');

const renderPermissionRuleSummary = (summary = {}) => {
    const total = Number(summary.total || 0);
    const visibleRules = Array.isArray(summary.visibleRules) ? summary.visibleRules : [];
    const overflow = Number(summary.overflow || 0);
    const decisionCounts = summary.decisionCounts || {};
    return `
        <div class="agent-center-card-sub">${escapeHtml(total ? `${total} 条。用于减少同类请求的重复确认。` : '0 条。工具请求仍会逐次确认。')}</div>
        <div class="agent-center-card-sub">优先顺序：${escapeHtml(summary.orderText || '全局 > 角色卡 > 当前会话 > Agent > 插件 > 默认')}</div>
        <div class="agent-center-card-sub">${escapeHtml(summary.tieBreakText || '同层先看优先级，仍相同则以后添加的规则生效。')}</div>
        ${Number(summary.conflictCount || 0) > 0 ? `<div class="agent-center-card-sub agent-center-card-error">检测到 ${Number(summary.conflictCount || 0)} 组同范围不同决定，最终按上方顺序处理。</div>` : ''}
        ${renderChips([
            { label: `允许 ${Number(decisionCounts.allow || 0)}` },
            { label: `拒绝 ${Number(decisionCounts.deny || 0)}` },
            { label: `每次确认 ${Number(decisionCounts.ask || 0)}` },
        ])}
        ${visibleRules.length ? `<div class="agent-center-rule-list">${visibleRules.map(rule => `
            <div class="agent-center-rule-row">
                <div>
                    <div class="agent-center-card-title">${escapeHtml(displayToolName(rule.toolName))}</div>
                    <div class="agent-center-card-sub">${escapeHtml(formatMeta([
                        rule.layerLabel,
                        displayPermissionLabel(rule.permission),
                        rule.source && rule.source !== '*' ? `来源：${rule.source}` : '',
                        rule.sessionId && rule.sessionId !== '*' ? `会话：${rule.sessionId}` : '',
                    ]))}</div>
                </div>
                <span class="${escapeHtml(permissionDecisionChipClass(rule.decision))}">${escapeHtml(rule.decisionLabel || rule.decision)}</span>
            </div>
        `).join('')}${overflow ? `<div class="agent-center-card-sub">还有 ${overflow} 条未显示。</div>` : ''}</div>` : ''}
    `;
};

const capabilityLabels = (capabilities = {}) => [
    capabilities.read ? '可读取' : '',
    capabilities.write ? '会写入' : '只读',
    capabilities.network === 'opt_in' ? '可联网（按次授权）' : (capabilities.network ? '会联网' : '本地执行'),
    capabilities.undo && capabilities.undo !== 'none' ? '可撤销' : '无撤销',
    capabilities.modelContext === 'allowlist' ? 'AI 可请求' : 'AI 默认看不到',
    capabilities.confirmation === 'allow_once' ? '每次确认' : '',
].filter(Boolean);

const displayRunSummary = (run = {}) => {
    const review = run?.review || null;
    if (review?.type === 'body_quality') {
        const issueCount = Number(review.issueCount || (review.issues || []).length || 0);
        return issueCount > 0 ? `发现 ${issueCount} 个正文问题` : '正文检查完成';
    }
    if (review) {
        const noticeCount = Number((review.errors || []).length) + Number((review.warnings || []).length);
        return noticeCount > 0 ? `发现 ${noticeCount} 条格式提醒` : '格式检查完成';
    }
    return trim(run.summary || run.lastStep?.summary || run.errorMessage, '-');
};

const formatExportLine = (items = []) => items.filter(Boolean).join(' · ');

const openDefaultAgentResourceTarget = async (target = {}) => {
    const registry = globalThis.window?.appBridge?.debugUiRegistry || {};
    const panels = registry.panels || {};
    const panelName = trim(target?.panel);
    if (!panelName) return false;
    const panel = panels[panelName];
    if (!panel) return false;
    if (panelName === 'presetPanel') {
        // 'chatprompts' 已不在预设面板 SECTIONS 中，落到首页；聊天格式相关默认进「系统提示词」页
        await Promise.resolve(panel.show?.({
            section: target.section && target.section !== 'chatprompts' ? target.section : 'sysprompt',
            focus: target.focus || '',
            promptId: target.promptId || '',
        }));
        return true;
    }
    if (panelName === 'configPanel') {
        panel.show?.({ tab: target.tab || 'chat' });
        return true;
    }
    if (panelName === 'worldPanel') {
        await Promise.resolve(panel.show?.({ scope: target.scope || 'session' }));
        return true;
    }
    await Promise.resolve(panel.show?.(target.options || {}));
    return true;
};

export const formatAgentCenterExportText = (view = {}) => {
    const meta = view?.meta || {};
    const lines = [
        'Agent Center 导出',
        '',
        formatExportLine([
            `待确认 ${Number(meta.pending || 0)}`,
            `运行中 ${Number(meta.activeRuns || 0)}`,
            `未读失败 ${Number(meta.unreadFailedRuns || 0)}`,
            `Agent ${Number(meta.enabledAgents || 0)}/${Number(meta.agents || 0)}`,
            `提示词 ${Number(meta.enabledPromptModules || 0)}/${Number(meta.promptModules || 0)}`,
            `诊断 ${Number(meta.diagnosticViews || 0)}`,
            `资源 ${Number(meta.resources || 0)}`,
            `工具 ${Number(meta.tools || 0)}`,
        ]),
        '',
        '[待确认]',
    ];
    const pending = Array.isArray(view?.pending) ? view.pending : [];
    if (!pending.length) lines.push('无');
    pending.forEach((item, index) => {
        lines.push(formatExportLine([
            `#${index + 1}`,
            displayToolName(item.toolName),
            displayStatusLabel(item.status),
            item.sessionId ? `范围：${item.sessionId}` : '',
            item.resumeStatus ? `执行：${displayStatusLabel(item.resumeStatus)}` : '',
        ]));
    });

    lines.push('', '[活动]');
    const runs = Array.isArray(view?.activity?.runs) ? view.activity.runs : [];
    if (!runs.length) lines.push('无');
    runs.forEach((run, index) => {
        lines.push(formatExportLine([
            `#${index + 1}`,
            run.title || displayAgentKind(run.kind),
            displayStatusLabel(run.status),
            run.sessionId ? `范围：${run.sessionId}` : '',
            displayRunSummary(run),
        ]));
    });

    lines.push('', '[Agent]');
    const agents = Array.isArray(view?.agents) ? view.agents : [];
    if (!agents.length) lines.push('无');
    agents.forEach(agent => {
        lines.push(formatExportLine([
            agent.title || displayAgentFeature(agent.id),
            agent.enabled ? '已开启' : '已关闭',
            agent.implemented ? '可使用' : '规划中',
            agent.triggerLabel ? `触发：${agent.triggerLabel}` : '',
            agent.modelLabel ? `模型：${agent.modelLabel}` : '',
        ]));
    });

    lines.push('', '[提示词]');
    const promptModules = Array.isArray(view?.promptModules) ? view.promptModules : [];
    if (!promptModules.length) lines.push('无');
    promptModules.forEach(item => {
        lines.push(formatExportLine([
            item.title || displayAgentFeature(item.id),
            item.enabled ? '已开启' : '已关闭',
            item.promptRefs?.length ? `提示词 ${item.promptRefs.length}` : '',
            item.summary,
        ]));
    });

    lines.push('', '[诊断]');
    const diagnosticViews = Array.isArray(view?.diagnosticViews) ? view.diagnosticViews : [];
    if (!diagnosticViews.length) lines.push('无');
    diagnosticViews.forEach(item => {
        lines.push(formatExportLine([
            item.title || item.id,
            item.implemented ? '可使用' : '规划中',
            item.summary,
        ]));
    });

    lines.push('', '[资源]');
    const resources = Array.isArray(view?.resources) ? view.resources : [];
    if (!resources.length) lines.push('无');
    resources.forEach(resource => {
        lines.push(formatExportLine([
            resource.title || resource.id,
            resource.group ? `分组：${resource.group}` : '',
            resource.status ? `状态：${resource.status}` : '',
            resource.summary,
        ]));
    });

    const safety = view?.safety || {};
    const gate = safety.sessionGate || {};
    const ruleSummary = safety.permissionRuleSummary || {};
    lines.push('', '[安全]');
    lines.push(formatExportLine([
        gate.enabled ? '当前会话工具：已开启' : '当前会话工具：已关闭',
        gate.networkAllowed ? '允许联网继续' : '不会联网继续',
        gate.realRunnerAllowed ? '允许真实继续生成' : '不会自动继续生成',
    ]));
    lines.push(`工具白名单：${list(gate.allowedTools).map(displayToolName).join('、') || '无'}`);
    lines.push(`权限规则：${Number(ruleSummary.total || 0)} 条`);
    lines.push(`规则优先顺序：${trim(ruleSummary.orderText, '全局 > 角色卡 > 当前会话 > Agent > 插件 > 默认')}`);
    if (Number(ruleSummary.conflictCount || 0) > 0) {
        lines.push(`规则冲突：${Number(ruleSummary.conflictCount || 0)} 组`);
    }
    return lines.join('\n').trim();
};

export class AgentCenterPanel {
    constructor({
        getActions = () => globalThis.window?.appBridge?.debugUiRegistry?.actions || {},
        confirm = appConfirm,
        choice = appChoice,
        promptText = appPromptText,
        openConfig = (options = {}) => globalThis.window?.appBridge?.debugUiRegistry?.panels?.configPanel?.show?.(options),
        openResourceTarget = openDefaultAgentResourceTarget,
        notifySuccess = (message) => globalThis.window?.toastr?.success?.(message),
        notifyError = (message) => globalThis.window?.toastr?.error?.(message),
        exportTextFile = (text, filename, successLabel) => exportDebugTextFile({
            text,
            filename,
            successLabel,
            onSuccess: (message) => globalThis.window?.toastr?.success?.(message),
        }),
        getFailureSeenAt = () => 0,
        markFailureSeen = () => {},
        getHopscotchPanel = () => null,
    } = {}) {
        this.getActions = getActions;
        this.confirm = confirm;
        this.choice = choice;
        this.promptText = promptText;
        this.openConfig = openConfig;
        this.openResourceTarget = openResourceTarget;
        this.notifySuccess = notifySuccess;
        this.notifyError = notifyError;
        this.exportTextFile = exportTextFile;
        this.getFailureSeenAt = getFailureSeenAt;
        this.markFailureSeen = markFailureSeen;
        this.getHopscotchPanel = getHopscotchPanel;
        this.agentLibraryOpen = false;
        this.sharedAgentConfig = null;
        this.overlayElement = null;
        this.panelElement = null;
        this.contentElement = null;
        this.metaElement = null;
        this.tabsElement = null;
        this.activeTab = 'agents';
        this.activityStatus = '';
        this.activityKind = '';
        this.surface = '';
        this.view = buildAgentCenterView();
        this.lastError = '';
        this.boundConfigProfileChanged = null;
        this.boundMemoryStorageModeChanged = null;
        this.boundAgentFeatureSettingsChanged = null;
        this.floatingAgentId = '';
        this.floatingAgentFlipped = false;
        this.floatingAgentEntryPending = false;
        this.cardEntryAnimationUntil = 0;
        this.cardEntryAnimationTimer = null;
        this.replyCheckPreviewTarget = 'auto';
        this.refreshToken = 0;
        this.refreshQueued = false;
        this.refreshInFlight = null;
        this.agentFeatureMutationDepth = 0;
        this.globalPromptPreviewContext = 'private_fc';
        this.globalPromptPreview = null;
        this.globalPromptPreviewLoading = false;
        this.globalPromptPreviewState = 'closed';
        this.globalPromptPreviewRequestId = 0;
        this.globalPromptDragId = '';
        this.globalPromptPage = 'list';
        this.globalPromptEditingId = '';
        this.globalPromptBases = new Map();
        this.globalPromptDrafts = new Map();
        this.globalPromptMutationPending = false;
        this.globalPromptLivePreviewTimer = null;
        this.globalPromptScrollSource = '';
        this.globalPromptScrollReleaseTimer = null;
        this.maximized = false;
    }

    ensureStyle() {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = PANEL_CSS;
        document.head.appendChild(style);
    }

    ensureDom() {
        if (this.overlayElement || typeof document === 'undefined') return;
        this.ensureStyle();
        const overlay = document.createElement('div');
        overlay.className = 'agent-center-overlay';
        overlay.dataset.agentCenterOverlay = 'true';
        overlay.dataset.maidGuideBack = 'agent-center';
        overlay.innerHTML = `
            <section class="agent-center-panel" role="dialog" aria-modal="true" aria-labelledby="agent-center-title">
                <header class="agent-center-header">
                    <div class="agent-center-title">
                        <span class="agent-center-title-mark" aria-hidden="true">A</span>
                        <div style="min-width:0;">
                            <strong id="agent-center-title">Agent Center</strong>
                            <div class="agent-center-meta"></div>
                        </div>
                    </div>
                    <div class="agent-center-actions">
                        <button type="button" class="agent-center-button agent-center-maximize-button" data-action="maximize" title="放大占满" aria-label="放大 Agent Center" aria-pressed="false">${maximizeSvg}</button>
                        <button type="button" class="agent-center-button" data-action="export" title="导出" aria-label="导出">${ICONS.export}</button>
                        <button type="button" class="agent-center-button" data-action="close" data-maid-guide-target="agent-center-close" data-maid-guide-back="agent-center" title="关闭" aria-label="关闭">${ICONS.close}</button>
                    </div>
                </header>
                <nav class="agent-center-tabs" aria-label="Agent Center tabs"></nav>
                <main class="agent-center-content"></main>
            </section>
        `;
        bindBackdropActivation(overlay, {
            onActivate: () => this.hide(),
        });
        overlay.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
        overlay.querySelector('[data-action="export"]')?.addEventListener('click', () => this.handleExport());
        overlay.querySelector('[data-action="maximize"]')?.addEventListener('click', () => this.toggleMaximized());
        this.overlayElement = overlay;
        this.panelElement = overlay.querySelector('.agent-center-panel');
        this.contentElement = overlay.querySelector('.agent-center-content');
        this.metaElement = overlay.querySelector('.agent-center-meta');
        this.tabsElement = overlay.querySelector('.agent-center-tabs');
        document.body.appendChild(overlay);
        try {
            this.setMaximized(globalThis.localStorage?.getItem?.(MAXIMIZED_STORAGE_KEY) === '1', { persist: false });
        } catch {
            this.setMaximized(false, { persist: false });
        }
        this.boundConfigProfileChanged = (event) => this.handleConfigProfileChanged(event);
        globalThis.window?.addEventListener?.('config-profile-changed', this.boundConfigProfileChanged);
        this.boundMemoryStorageModeChanged = () => {
            if (this.isVisible()) this.refresh();
        };
        globalThis.window?.addEventListener?.('memory-storage-mode-changed', this.boundMemoryStorageModeChanged);
        this.boundAgentFeatureSettingsChanged = (event) => this.handleAgentFeatureSettingsChanged(event);
        globalThis.window?.addEventListener?.('agent-feature-settings-changed', this.boundAgentFeatureSettingsChanged);
    }

    setMaximized(value, { persist = true } = {}) {
        const on = value === true;
        this.maximized = on;
        this.overlayElement?.classList?.toggle?.('is-maximized', on);
        const button = this.overlayElement?.querySelector?.('[data-action="maximize"]');
        button?.classList?.toggle?.('is-on', on);
        button?.setAttribute?.('aria-pressed', on ? 'true' : 'false');
        button?.setAttribute?.('aria-label', on ? '还原 Agent Center' : '放大 Agent Center');
        if (button) button.title = on ? '还原面板' : '放大占满';
        if (persist) {
            try { globalThis.localStorage?.setItem?.(MAXIMIZED_STORAGE_KEY, on ? '1' : '0'); } catch {}
        }
        return on;
    }

    toggleMaximized(options = {}) {
        return this.setMaximized(!this.maximized, options);
    }

    async callAction(name, args = undefined, fallback = null) {
        const actions = this.getActions?.() || {};
        const fn = actions?.[name];
        if (typeof fn !== 'function') return fallback;
        try {
            return await Promise.resolve(args === undefined ? fn() : fn(args));
        } catch (err) {
            this.lastError = trim(err?.message || err, `${name} failed`);
            return fallback;
        }
    }

    async callAgentFeatureMutation(name, args = undefined, fallback = null) {
        this.agentFeatureMutationDepth += 1;
        try {
            return await this.callAction(name, args, fallback);
        } finally {
            this.agentFeatureMutationDepth = Math.max(0, this.agentFeatureMutationDepth - 1);
        }
    }

    async handleExport() {
        const text = formatAgentCenterExportText(this.view);
        const ok = await exportDebugTextFlow({
            text,
            filenamePrefix: 'agent-center',
            successLabel: 'Agent Center 已导出',
            emptyMessage: '暂无 Agent 记录可导出',
            exportFailureToast: 'Agent Center 导出失败',
            exportFailurePrefix: 'Agent Center 导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: this.exportTextFile,
            onWarning: (message) => globalThis.window?.toastr?.warning?.(message),
            onLogWarn: (message) => {
                this.lastError = message;
            },
            onError: (message) => {
                this.lastError = message;
                globalThis.window?.toastr?.error?.(message);
            },
        });
        return ok;
    }

    async collectView(options = {}) {
        this.lastError = '';
        const opts = options && typeof options === 'object' ? options : {};
        const hasSurface = Object.prototype.hasOwnProperty.call(opts, 'surface');
        const hasActivityStatus = Object.prototype.hasOwnProperty.call(opts, 'activityStatus') ||
            Object.prototype.hasOwnProperty.call(opts, 'status');
        const activityStatus = normalizeActivityStatus(hasActivityStatus
            ? (opts.activityStatus || opts.status || '')
            : this.activityStatus);
        const surface = normalizeSurface(hasSurface ? opts.surface : this.surface);
        const failureSeenAt = Number(this.getFailureSeenAt?.({ surface }) || 0) || 0;
        const activityKind = String(this.activityKind || '').trim();
        const agentRunView = await this.callAction('listAgentRunView', {
            limit: 50,
            failureSeenAt,
            ...(activityStatus ? { status: activityStatus } : {}),
            ...(activityKind ? { kind: activityKind } : {}),
            ...(surface ? { surface } : {}),
        }, null);
        const [
            pendingPermissions,
            contactProfilePendingUpdates,
            tools,
            permissionRules,
            sessionGate,
            experimentStatus,
            continuationCommitPolicy,
            agentModelProfiles,
            resourceStatus,
            agentCenterSettings,
            agentProfileView,
            memoryMode,
            memoryAgentPromptConfig,
        ] = await Promise.all([
            this.callAction('listProviderToolPendingPermissions', { limit: 100 }, []),
            this.callAction('listContactProfilePendingUpdates', undefined, []),
            this.callAction('listAgentTools', undefined, []),
            this.callAction('listAgentPermissionRules', undefined, []),
            this.callAction('getProviderToolSessionGate', undefined, null),
            this.callAction('getProviderToolExperimentStatus', undefined, null),
            this.callAction('getProviderContinuationCommitPolicy', undefined, null),
            this.callAction('listAgentModelProfiles', undefined, []),
            this.callAction('listAgentResourceStatus', undefined, {}),
            this.callAction('getAgentCenterSettings', undefined, null),
            this.callAction('getAgentCenterProfileView', undefined, null),
            this.callAction('getMemoryStorageMode', undefined, 'table'),
            this.callAction('getMemoryAgentPromptConfig', undefined, null),
        ]);
        const agentFeatureSettings = await this.callAction('getAgentFeatureSettings', undefined, null);
        const view = buildAgentCenterView({
            pendingPermissions,
            contactProfilePendingUpdates,
            agentRunView,
            tools,
            agentFeatureSettings,
            agentModelProfiles,
            permissionRules,
            sessionGate,
            experimentStatus,
            continuationCommitPolicy,
            resourceStatus,
            agentCenterSettings,
            agentProfileView,
            memoryMode,
        });
        view.memoryAgentPromptConfig = memoryAgentPromptConfig;
        return view;
    }

    show(options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        const tab = Object.prototype.hasOwnProperty.call(opts, 'tab') ? opts.tab : (this.getHopscotchPanel() ? 'agents' : this.activeTab);
        const agentId = trim(opts.agentId || opts.cardId);
        this.ensureDom();
        const wasVisible = this.isVisible();
        if (!wasVisible || opts.library === true) this.agentLibraryOpen = opts.library === true;
        this.activeTab = trim(tab, 'agents');
        this.activityStatus = normalizeActivityStatus(opts.activityStatus || opts.status || '');
        this.surface = normalizeSurface(opts.surface || '');
        if (agentId) {
            this.floatingAgentId = agentId;
            this.floatingAgentFlipped = opts.configure === true;
            this.floatingAgentEntryPending = true;
        }
        if (!wasVisible) {
            clearTimeout(this.cardEntryAnimationTimer);
            this.cardEntryAnimationTimer = null;
            this.cardEntryAnimationUntil = Number.POSITIVE_INFINITY;
        }
        this.overlayElement?.classList?.toggle?.('is-above-maid-guide', opts.aboveGuide === true);
        if (this.overlayElement) this.overlayElement.style.display = 'flex';
        this.refresh();
    }

    hide({ force = false } = {}) {
        if (!force && !this.requestAgentCardClose(() => { this.closeFloatingAgentCard({ force: true }); this.hide(); })) return false;
        const boardPanel = this.getHopscotchPanel();
        if (!force && boardPanel?.requestClose(() => this.hide({ force: true })) === false) return false;
        boardPanel?.close();
        closeCustomSelectMenu();
        clearTimeout(this.globalPromptLivePreviewTimer);
        this.globalPromptLivePreviewTimer = null;
        clearTimeout(this.globalPromptScrollReleaseTimer);
        this.globalPromptScrollReleaseTimer = null;
        this.globalPromptScrollSource = '';
        try { globalThis.CSS?.highlights?.delete?.('agent-global-preview-selection'); } catch {}
        this.floatingAgentId = '';
        this.floatingAgentFlipped = false;
        this.floatingAgentEntryPending = false;
        this.globalPromptPreviewState = 'closed';
        this.globalPromptPreviewLoading = false;
        this.globalPromptPreviewRequestId += 1;
        this.overlayElement?.classList?.remove?.('is-above-maid-guide');
        if (this.overlayElement) this.overlayElement.style.display = 'none';
        return true;
    }

    closeTopLayer() {
        if (this.floatingAgentId) {
            this.closeFloatingAgentCard();
            return true;
        }
        return this.hide();
    }

    destroy() {
        this.getHopscotchPanel()?.close();
        const target = globalThis.window;
        target?.removeEventListener?.('config-profile-changed', this.boundConfigProfileChanged);
        target?.removeEventListener?.('memory-storage-mode-changed', this.boundMemoryStorageModeChanged);
        target?.removeEventListener?.('agent-feature-settings-changed', this.boundAgentFeatureSettingsChanged);
        this.boundConfigProfileChanged = null;
        this.boundMemoryStorageModeChanged = null;
        this.boundAgentFeatureSettingsChanged = null;
        clearTimeout(this.cardEntryAnimationTimer);
        this.cardEntryAnimationTimer = null;
        clearTimeout(this.globalPromptLivePreviewTimer);
        this.globalPromptLivePreviewTimer = null;
        clearTimeout(this.globalPromptScrollReleaseTimer);
        this.globalPromptScrollReleaseTimer = null;
        this.globalPromptScrollSource = '';
        try { globalThis.CSS?.highlights?.delete?.('agent-global-preview-selection'); } catch {}
        this.refreshToken += 1;
        this.globalPromptPreviewRequestId += 1;
        this.refreshQueued = false;
        this.overlayElement?.remove?.();
        this.overlayElement = null;
        this.panelElement = null;
        this.contentElement = null;
        this.metaElement = null;
        this.tabsElement = null;
    }

    isVisible() {
        return Boolean(this.overlayElement && this.overlayElement.style.display !== 'none');
    }

    handleConfigProfileChanged(event = null) {
        const tab = trim(event?.detail?.tab || 'chat');
        if (tab && tab !== 'chat') return null;
        if (this.activeTab !== 'agents' || !this.isVisible()) return null;
        return this.refresh();
    }

    handleAgentFeatureSettingsChanged() {
        if (!this.isVisible()) return null;
        if (this.agentFeatureMutationDepth > 0) return null;
        return this.refresh();
    }

    refresh() {
        this.ensureDom();
        this.refreshToken += 1;
        this.refreshQueued = true;
        if (this.refreshInFlight) return this.refreshInFlight;

        const run = async () => {
            let rendered = false;
            while (this.refreshQueued) {
                this.refreshQueued = false;
                const token = this.refreshToken;
                const view = await this.collectView();
                if (token !== this.refreshToken) continue;
                this.view = view;
                if (this.activeTab === 'activity' && normalizeActivityStatus(this.activityStatus) === 'failure') {
                    this.markCurrentFailuresSeen();
                }
                this.render();
                rendered = true;
            }
            return rendered;
        };
        let tracked = null;
        tracked = run().finally(() => {
            if (this.refreshInFlight === tracked) this.refreshInFlight = null;
        });
        this.refreshInFlight = tracked;
        return tracked;
    }

    setActiveTab(tab = 'pending', { resetActivityStatus = false } = {}) {
        const next = trim(tab, 'pending');
        if (!this.view.tabs.some(item => item.id === next)) return;
        this.activeTab = next;
        if (next !== 'global_prompts') this.globalPromptPreviewState = 'closed';
        this.floatingAgentId = '';
        this.floatingAgentFlipped = false;
        this.floatingAgentEntryPending = false;
        if (resetActivityStatus) this.activityStatus = '';
        this.render();
    }

    setActivityStatus(status = '') {
        this.activeTab = 'activity';
        this.floatingAgentId = '';
        this.floatingAgentFlipped = false;
        this.floatingAgentEntryPending = false;
        this.activityStatus = normalizeActivityStatus(status);
        this.refresh();
    }

    setActivityKind(kind = '') {
        this.activeTab = 'activity';
        this.activityKind = String(kind || '').trim();
        this.refresh();
    }

    markCurrentFailuresSeen() {
        const newestFailureAt = Number(this.view?.meta?.newestFailureAt || this.view?.activity?.meta?.scopedNewestFailureAt || this.view?.activity?.meta?.newestFailureAt || 0) || 0;
        this.markFailureSeen?.({
            surface: this.surface,
            at: Math.max(Date.now(), newestFailureAt),
        });
        if (this.view?.meta) this.view.meta.unreadFailedRuns = 0;
        if (this.view?.activity?.meta) {
            this.view.activity.meta.unreadFailures = 0;
            this.view.activity.meta.scopedUnreadFailures = 0;
        }
    }

    renderTabs() {
        if (!this.tabsElement) return;
        this.tabsElement.innerHTML = this.view.tabs.map((tab) => `
            ${tab.id === 'activity' ? '<span class="agent-center-tab-divider" aria-hidden="true"></span>' : ''}
            <button
                type="button"
                class="agent-center-tab${tab.id === this.activeTab ? ' is-active' : ''}"
                data-tab="${escapeHtml(tab.id)}"
            >${tabIcon(tab.id)}<span>${escapeHtml(tab.label)}${tab.count ? ` ${Number(tab.count)}` : ''}</span></button>
        `).join('');
        this.tabsElement.querySelectorAll('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => this.setActiveTab(button.dataset.tab, {
                resetActivityStatus: button.dataset.tab === 'activity',
            }));
        });
    }

    renderMeta() {
        if (!this.metaElement) return;
        const meta = this.view.meta || {};
        const items = [
            { label: '待确认', value: Number(meta.pending || 0), tone: 'muted' },
            { label: '活动中', value: Number(meta.activeRuns || 0), tone: 'active' },
            { label: '失败', value: Number(meta.failedRuns || 0), tone: 'danger' },
            { label: 'Agent', value: `${Number(meta.enabledAgents || 0)}/${Number(meta.agents || 0)}`, tone: 'agent' },
            { label: '提示词', value: `${Number(meta.enabledPromptModules || 0)}/${Number(meta.promptModules || 0)}`, tone: 'prompt' },
            { label: '诊断', value: Number(meta.diagnosticViews || 0), tone: 'diagnostic' },
            { label: '资源', value: Number(meta.resources || 0), tone: 'resource' },
            { label: '工具', value: Number(meta.tools || 0), tone: 'tool' },
            this.surface ? { label: '范围', value: this.surface, tone: 'muted', tail: true } : null,
            { label: '当前会话', value: meta.sessionGateEnabled ? '已开启' : '未开启', tone: meta.sessionGateEnabled ? 'on' : 'muted', tail: true },
        ].filter(Boolean);
        this.metaElement.innerHTML = items.map((item, index) => `
            ${index ? '<span class="agent-center-meta-separator" aria-hidden="true">·</span>' : ''}
            <span class="agent-center-meta-item is-${escapeHtml(item.tone)}${item.tail ? ' agent-center-meta-tail' : ''}">
                <i class="agent-center-meta-dot is-${escapeHtml(item.tone)}" aria-hidden="true"></i>
                ${escapeHtml(item.label)} <b>${escapeHtml(item.value)}</b>
            </span>
        `).join('');
    }

    getAgentModelSelectValue(agent = {}) {
        const mode = trim(agent.modelMode, 'follow_current');
        if (mode === 'none') return 'none';
        if (mode === 'profile' && trim(agent.modelProfileId)) return `profile:${trim(agent.modelProfileId)}`;
        return 'follow_current';
    }

    renderAgentModelSelect(agent = {}) {
        const selectedValue = this.getAgentModelSelectValue(agent);
        const profiles = Array.isArray(this.view.agentModelProfiles) ? this.view.agentModelProfiles : [];
        const options = [
            { value: 'follow_current', label: '跟随当前聊天模型' },
            { value: 'none', label: '不调用模型' },
            ...profiles.map(profile => ({
                value: `profile:${trim(profile.id)}`,
                label: trim(profile.label || [
                    profile.name,
                    [profile.provider, profile.model].map(trim).filter(Boolean).join(' / '),
                ].filter(Boolean).join(' · '), profile.id),
            })).filter(option => option.value !== 'profile:'),
        ];
        if (agent.modelMode === 'profile' && selectedValue !== 'profile:' &&
            !options.some(option => option.value === selectedValue)) {
            options.push({
                value: selectedValue,
                label: agent.modelLabel || `指定模型：${trim(agent.modelProfileId)}`,
            });
        }
        const disabled = !agent.implemented || !agent.supportsModel;
        return `
            <div class="agent-center-model-control">
                <select
                    class="agent-center-model-select"
                    data-agent-feature-model-select="${escapeHtml(agent.id)}"
                    aria-label="${escapeHtml(`${agent.title || displayAgentFeature(agent.id)}模型`)}"
                    style="display:none;"
                    ${disabled ? 'disabled' : ''}
                >
                    ${options.map(option => `
                        <option value="${escapeHtml(option.value)}"${option.value === selectedValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
                <button
                    type="button"
                    class="world-app-select-btn agent-center-model-select-btn"
                    data-agent-feature-model-button="${escapeHtml(agent.id)}"
                    ${disabled ? 'disabled' : ''}
                >
                    <span class="pp-custom-select-label" data-custom-select-label>${escapeHtml(agent.modelLabel || '不调用模型')}</span>
                    <span class="world-app-select-btn-chevron">▾</span>
                </button>
                <button
                    type="button"
                    class="agent-center-model-manage"
                    data-agent-feature-model-manage="${escapeHtml(agent.id)}"
                    ${agent.supportsModel && agent.implemented ? '' : 'disabled'}
                >管理</button>
            </div>
            ${agent.modelMode === 'profile' && trim(agent.modelProfileId) ? (() => {
                const profile = profiles.find(item => item.id === trim(agent.modelProfileId));
                const shownModel = agent.modelOverride || trim(profile?.model || '');
                return `
                <span class="agent-center-setting-label agent-center-model-override-label">模型覆盖</span>
                <div class="agent-center-model-override-row">
                    <input
                        type="text"
                        class="agent-center-model-override"
                        data-agent-feature-model-override="${escapeHtml(agent.id)}"
                        data-profile-model="${escapeHtml(trim(profile?.model || ''))}"
                        value="${escapeHtml(shownModel)}"
                        placeholder="模型（默认该配置保存的模型，可改）"
                        aria-label="模型"
                        ${disabled ? 'disabled' : ''}
                    />
                    <button type="button" class="agent-center-card-action" data-agent-model-pick="${escapeHtml(agent.id)}" ${disabled ? 'disabled' : ''}>▾</button>
                </div>
                <div class="agent-center-model-menu" data-agent-model-menu="${escapeHtml(agent.id)}" hidden></div>
            `; })() : ''}
        `;
    }

    getAgentCards() {
        return this.view.agentCards || this.view.agents || [];
    }

    getPromptModuleCards() {
        return this.view.promptModules || [];
    }

    getDiagnosticCards() {
        return this.view.diagnosticViews || [];
    }

    getAllCenterCards() {
        return [
            ...this.getAgentCards(),
            ...this.getPromptModuleCards(),
            ...this.getDiagnosticCards(),
        ];
    }

    getAgentCardById(agentId = '') {
        const id = trim(agentId);
        return (this.getAllCenterCards() || []).find(item => item.id === id) || null;
    }

    renderAgentRuntimeState(agent = {}) {
        const state = agent.runtimeState || null;
        if (!state) return '';
        return `
            <div class="agent-center-agent-section">
                <div class="agent-center-agent-section-title">最近运行</div>
                <div class="agent-center-card-sub">${escapeHtml(formatMeta([
                    displayAgentKind(state.kind),
                    displayStatusLabel(state.status),
                    state.summary,
                ]))}</div>
            </div>
        `;
    }

    getAgentProfile(profileType = 'sysprompt') {
        const view = this.view.agentProfileView || {};
        const key = trim(profileType, 'sysprompt');
        return view?.[key]?.profile || null;
    }

    getAgentPromptConfig(agent = {}, ref = {}) {
        const profileType = trim(ref.profileType, 'sysprompt');
        const profile = this.getAgentProfile(profileType);
        const agentProfile = profile?.agents?.[trim(ref.agentId || agent.id)] || null;
        const prompt = agentProfile?.prompts?.[trim(ref.id)] || null;
        return prompt && typeof prompt === 'object' ? prompt : null;
    }

    renderSelectOptions(options = [], selectedValue = '') {
        const selected = String(selectedValue ?? '');
        return options.map(option => `
            <option value="${escapeHtml(option.value)}"${String(option.value) === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>
        `).join('');
    }

    renderAgentPromptEditor(agent = {}, ref = {}) {
        const prompt = this.getAgentPromptConfig(agent, ref) || {};
        const profileType = trim(ref.profileType, 'sysprompt');
        const profileView = this.view.agentProfileView?.[profileType] || {};
        const presetId = trim(profileView.presetId);
        const promptId = trim(ref.id);
        const hasPlacement = PROMPT_REFS_WITH_PLACEMENT.has(promptId) || prompt.position !== undefined;
        const positionValue = prompt.position !== undefined ? prompt.position : (promptId === 'summary' ? 1 : 0);
        const depthValue = prompt.depth !== undefined ? prompt.depth : (promptId === 'summary' ? 1 : 0);
        const roleValue = prompt.role !== undefined ? prompt.role : 0;
        return `
            <div
                class="agent-center-agent-editor"
                data-agent-prompt-editor="${escapeHtml(promptId)}"
                data-agent-id="${escapeHtml(agent.id)}"
                data-agent-prompt-profile-type="${escapeHtml(profileType)}"
                data-agent-prompt-preset-id="${escapeHtml(presetId)}"
            >
                <div class="agent-center-agent-editor-row">
                    <label class="agent-center-agent-check">
                        <input type="checkbox" data-agent-prompt-enabled ${prompt.enabled !== false ? 'checked' : ''}>
                        <span>${escapeHtml(ref.label || promptId)}</span>
                    </label>
                    <button type="button" class="agent-center-card-action is-primary" data-agent-prompt-save="${escapeHtml(promptId)}">保存</button>
                </div>
                ${hasPlacement ? `
                    <div class="agent-center-agent-field-grid">
                        <div class="agent-center-agent-field">
                            <label>注入位置</label>
                            <select class="agent-center-agent-input" data-agent-prompt-position>
                                ${this.renderSelectOptions(PROMPT_POSITION_OPTIONS, positionValue)}
                            </select>
                        </div>
                        <div class="agent-center-agent-field">
                            <label>深度</label>
                            <input class="agent-center-agent-input" type="number" min="0" inputmode="numeric" data-agent-prompt-depth value="${escapeHtml(depthValue)}">
                        </div>
                        <div class="agent-center-agent-field">
                            <label>角色</label>
                            <select class="agent-center-agent-input" data-agent-prompt-role>
                                ${this.renderSelectOptions(PROMPT_ROLE_OPTIONS, roleValue)}
                            </select>
                        </div>
                    </div>
                ` : ''}
                ${trim(agent.id) === 'phone_format_agent' ? `
                    <div class="agent-center-agent-editor-note">
                        <span>注入位置在「预设 → 系统提示词 → 文本协议聊天格式位置」调整；仅传统文本模式生效，FC/JSON 请求不包含此内容。</span>
                        <button type="button" class="agent-center-card-action" data-agent-prompt-open-position>去调整</button>
                    </div>
                ` : ''}
                <textarea class="agent-center-agent-textarea" data-agent-prompt-rules>${escapeHtml(prompt.rules || '')}</textarea>
            </div>
        `;
    }

    renderAgentPromptRefs(agent = {}) {
        const refs = Array.isArray(agent.promptRefs) ? agent.promptRefs : [];
        if (!refs.length) return '';
        return `
            <div class="agent-center-agent-section">
                <div class="agent-center-agent-section-title">提示词</div>
                ${refs.map(ref => this.renderAgentPromptEditor(agent, ref)).join('')}
            </div>
        `;
    }

    getMemoryAgentSettings() {
        const profile = this.getAgentProfile('openai');
        const agent = profile?.agents?.memory_table_agent || null;
        return agent?.settings && typeof agent.settings === 'object' ? agent.settings : {};
    }

    getMemoryAgentPromptConfig() {
        const cfg = this.view?.memoryAgentPromptConfig && typeof this.view.memoryAgentPromptConfig === 'object'
            ? this.view.memoryAgentPromptConfig
            : {};
        return {
            templateId: trim(cfg.templateId),
            templateName: trim(cfg.templateName, '默认记忆模板'),
            template: typeof cfg.template === 'string' ? cfg.template : '{{tableData}}',
            wrapper: typeof cfg.wrapper === 'string' ? cfg.wrapper : '<memories>\n{{tableData}}\n</memories>',
            position: trim(cfg.position, 'before_latest_user'),
        };
    }

    renderMemoryAgentEditor(agent = {}) {
        if (agent.id !== 'memory_table_agent') return '';
        const profileView = this.view?.agentProfileView?.openai || {};
        const settings = this.getMemoryAgentSettings();
        const prompt = this.getMemoryAgentPromptConfig();
        const memoryMode = deriveMemoryStorageMode(appSettings.get());
        return `
            <div
                class="agent-center-agent-section agent-center-agent-editor"
                data-memory-agent-editor="memory_table_agent"
                data-memory-agent-preset-id="${escapeHtml(profileView.presetId || '')}"
                data-memory-agent-template-id="${escapeHtml(prompt.templateId || '')}"
            >
                <div class="agent-center-agent-section-title has-help" data-help="模板使用 {{tableData}} 插入表格内容">记忆提示词与注入</div>
                <div class="agent-center-card-sub">${escapeHtml(prompt.templateName)}</div>
                <div class="agent-center-memory-mode-setting">
                    <span class="agent-center-setting-label">记忆存储模式</span>
                    <div class="agent-center-memory-mode-control" role="group" aria-label="记忆存储模式">
                        ${[
                            ['off', '关闭'],
                            ['summary', '摘要'],
                            ['table', '表格'],
                        ].map(([value, label]) => `
                            <button
                                type="button"
                                class="agent-center-memory-mode-button"
                                data-memory-storage-mode="${value}"
                                aria-pressed="${memoryMode === value}"
                            >${label}</button>
                        `).join('')}
                    </div>
                </div>
                <div class="agent-center-agent-field-grid">
                    <div class="agent-center-agent-field">
                        <label>记忆数据提示词位置</label>
                        <select class="agent-center-agent-input" data-memory-data-position>
                            ${this.renderSelectOptions(MEMORY_POSITION_OPTIONS, settings.dataPosition || '')}
                        </select>
                    </div>
                    <div class="agent-center-agent-field">
                        <label>数据深度</label>
                        <input class="agent-center-agent-input" type="number" min="0" inputmode="numeric" data-memory-data-depth value="${escapeHtml(settings.dataDepth ?? 0)}">
                    </div>
                    <div class="agent-center-agent-field">
                        <label>写表指导提示词位置</label>
                        <select class="agent-center-agent-input" data-memory-guide-position>
                            ${this.renderSelectOptions(MEMORY_POSITION_OPTIONS, settings.guidePosition || '')}
                        </select>
                    </div>
                    <div class="agent-center-agent-field">
                        <label>指导深度</label>
                        <input class="agent-center-agent-input" type="number" min="0" inputmode="numeric" data-memory-guide-depth value="${escapeHtml(settings.guideDepth ?? 0)}">
                    </div>
                    <div class="agent-center-agent-field">
                        <label>表格内容模板位置</label>
                        <select class="agent-center-agent-input" data-memory-prompt-position>
                            ${this.renderSelectOptions(MEMORY_POSITION_OPTIONS, prompt.position || 'before_latest_user')}
                        </select>
                    </div>
                    <div class="agent-center-agent-field is-wide">
                        <label>表格内容模板</label>
                        <textarea class="agent-center-agent-textarea is-compact" data-memory-prompt-template>${escapeHtml(prompt.template || '')}</textarea>
                    </div>
                    <div class="agent-center-agent-field is-wide">
                        <label>包裹模板</label>
                        <textarea class="agent-center-agent-textarea is-compact" data-memory-prompt-wrapper>${escapeHtml(prompt.wrapper || '')}</textarea>
                    </div>
                </div>
                <div class="agent-center-card-actions">
                    <button type="button" class="agent-center-card-action is-primary" data-memory-agent-save="memory_table_agent">保存记忆设置</button>
                </div>
            </div>
        `;
    }

    renderReplyCheckPromptInfo(agent = {}) {
        if (agent.id !== 'reply_check') return '';
        const promptText = getLocalizedPromptText('format_repair.fixed_preview');
        return `
            <div class="agent-center-agent-section agent-center-agent-editor">
                <div class="agent-center-agent-section-title">检查提示词</div>
                <div class="agent-center-agent-field">
                    <label>预览格式目标</label>
                    <select class="agent-center-agent-input" data-reply-check-preview-target>
                        ${this.renderSelectOptions(REPLY_CHECK_PREVIEW_TARGET_OPTIONS, this.replyCheckPreviewTarget || 'auto')}
                    </select>
                </div>
                <div class="agent-center-agent-prompt-preview">${escapeHtml(promptText)}</div>
            </div>
        `;
    }

    renderAgentSettingRefs(agent = {}) {
        const refs = list(agent.settingRefs);
        if (!refs.length) return '';
        return `
            <div class="agent-center-agent-section">
                <div class="agent-center-agent-section-title">可设定项目</div>
                <div class="agent-center-agent-mini-list">
                    ${refs.map(label => `<span class="agent-center-agent-mini-item">${escapeHtml(label)}</span>`).join('')}
                </div>
            </div>
        `;
    }

    renderAgentResourceRefs(agent = {}) {
        const refs = list(agent.resourceRefs);
        if (!refs.length) return '';
        const resources = this.view.resources || [];
        return `
            <div class="agent-center-agent-section">
                <div class="agent-center-agent-section-title">关联资源</div>
                <div class="agent-center-card-actions" style="margin-top:0;">
                    ${refs.map(resourceId => {
                        const resource = resources.find(item => item.id === resourceId) || { id: resourceId, title: resourceId };
                        return `<button type="button" class="agent-center-card-action" data-agent-resource-open="${escapeHtml(resource.id)}">${escapeHtml(resource.title || resource.id)}</button>`;
                    }).join('')}
                </div>
            </div>
        `;
    }

    renderAgentPromptPreviewAction(agent = {}) {
        if (!agent?.implemented) return '';
        return `
            <div class="agent-center-agent-section">
                <div class="agent-center-agent-section-title has-help" data-help="根据该 Agent 的当前触发场景构建完整提示词和请求参数；只预览，不发送。">完整请求预览</div>
                <div class="agent-center-card-actions" style="margin-top:0;">
                    <button type="button" class="agent-center-card-action is-primary" data-agent-prompt-preview="${escapeHtml(agent.id || '')}">预览提示词</button>
                </div>
            </div>
        `;
    }

    renderAgentFeatureSettings(agent = {}) {
        if (!isFeatureAgentCard(agent)) return '';
        return `
            <div class="agent-center-agent-settings">
                ${agent.supportsTriggerMode ? `
                    <div class="agent-center-setting-row">
                        <span class="agent-center-setting-label">触发</span>
                        <span class="agent-center-setting-value">${escapeHtml(agent.triggerLabel || '自动触发')}</span>
                        <button type="button" class="agent-center-card-action" data-agent-feature-trigger="${escapeHtml(agent.id)}" ${agent.implemented ? '' : 'disabled'}>设置</button>
                    </div>
                ` : ''}
                <div class="agent-center-setting-row is-model">
                    <span class="agent-center-setting-label">模型</span>
                    ${agent.supportsModel
                        ? this.renderAgentModelSelect(agent)
                        : `<span class="agent-center-setting-value">${escapeHtml(agent.modelLabel || '不直接调用模型')}</span>`}
                </div>
            </div>
        `;
    }

    renderAgentEnabledSetting(agent = {}) {
        if (!agent.implemented || agent.id === 'memory_table_agent' || trim(agent.cardGroup || agent.category) === 'diagnostic') return '';
        const action = agent.enabled === true ? 'disable' : 'enable';
        const title = agent.title || displayAgentFeature(agent.id);
        return `
            <div class="agent-center-setting-row is-status">
                <span class="agent-center-setting-label">状态</span>
                <span class="agent-center-setting-value">${agent.enabled ? '已开启' : '已关闭'}</span>
                <button
                    type="button"
                    class="agent-center-switch${agent.enabled ? ' is-on' : ''}"
                    role="switch"
                    aria-checked="${agent.enabled === true}"
                    aria-label="${escapeHtml(formatToggleTargetLabel(action, title))}"
                    ${isFeatureAgentCard(agent) ? `data-agent-feature-action="${action}" data-agent-feature-id="${escapeHtml(agent.id)}"` : `data-agent-card-action="${action}" data-agent-card-id="${escapeHtml(agent.id)}"`}
                ><span class="agent-center-switch-track" aria-hidden="true"><span class="agent-center-switch-thumb"></span></span></button>
            </div>
        `;
    }

    renderAgentFront(agent = {}) {
        const title = agent.title || displayAgentFeature(agent.id);
        const isDiagnosticView = trim(agent.cardGroup || agent.category) === 'diagnostic';
        const isMemoryModeCard = trim(agent.id) === 'memory_table_agent';
        const memoryMode = isMemoryModeCard ? deriveMemoryStorageMode(appSettings.get()) : '';
        const memoryModeLabel = MEMORY_STORAGE_MODE_LABELS[memoryMode] || MEMORY_STORAGE_MODE_LABELS.table;
        const action = agent.enabled === true ? 'disable' : 'enable';
        const switchLabel = formatToggleTargetLabel(action, title);
        const quickSwitch = !isDiagnosticView && !isMemoryModeCard && agent.implemented
            ? `
                <button
                    type="button"
                    class="agent-center-switch${agent.enabled ? ' is-on' : ''}"
                    role="switch"
                    aria-checked="${agent.enabled === true}"
                    aria-label="${escapeHtml(switchLabel)}"
                    title="${escapeHtml(switchLabel)}"
                    data-agent-card-interactive
                    ${isFeatureAgentCard(agent)
                        ? `data-agent-feature-action="${action}" data-agent-feature-id="${escapeHtml(agent.id)}"`
                        : `data-agent-card-action="${action}" data-agent-card-id="${escapeHtml(agent.id)}"`}
                ><span class="agent-center-switch-track" aria-hidden="true"><span class="agent-center-switch-thumb"></span></span></button>
            `
            : '';
        const titleAccessory = isDiagnosticView
            ? `<span class="${escapeHtml(statusChipClass('succeeded'))}">诊断视图</span>`
            : isMemoryModeCard
                ? `<span class="${escapeHtml(statusChipClass(memoryMode === 'off' ? 'denied' : memoryMode === 'summary' ? 'pending' : 'running'))} agent-center-memory-mode-badge" data-memory-mode-badge="${escapeHtml(memoryMode)}">记忆：${escapeHtml(memoryModeLabel)}</span>`
                : quickSwitch || (!agent.implemented
                    ? `<span class="${escapeHtml(statusChipClass('pending'))}">规划中</span>`
                    : '');
        const promptCount = Array.isArray(agent.promptRefs) ? agent.promptRefs.length : 0;
        const runtimeState = agent.runtimeState || null;
        return `
            <div class="agent-center-agent-title-row">
                <div class="agent-center-agent-title-main">
                    <span class="agent-center-agent-badge" data-i18n-skip>${escapeHtml(displayAgentCardGlyph(agent))}</span>
                    <div>
                        <div class="agent-center-card-title">${escapeHtml(title)}</div>
                        <div class="agent-center-card-sub">${escapeHtml(agent.summary || '')}</div>
                    </div>
                </div>
                ${titleAccessory}
            </div>
            ${renderChips([
                { label: agent.implemented ? '可使用' : '规划中', className: statusChipClass(agent.implemented ? 'succeeded' : 'pending') },
                isDiagnosticView || isMemoryModeCard ? null : { label: agent.enabled ? '已开启' : '已关闭', className: statusChipClass(agent.enabled ? 'running' : 'denied') },
                promptCount ? { label: `提示词 ${promptCount}` } : null,
                runtimeState ? { label: displayStatusLabel(runtimeState.status), className: statusChipClass(runtimeState.status) } : null,
            ])}
            <div class="agent-center-card-sub agent-center-agent-card-description">${escapeHtml((Array.isArray(agent.detail) ? agent.detail[0] : '') || agent.summary || '')}</div>
            <div class="agent-center-agent-card-footer">
                <span>${escapeHtml(displayCardCategory(agent.category) || 'Agent')}</span>
                <span>${escapeHtml(translateUiText('详情'))} ${ICONS.chevron}</span>
            </div>
        `;
    }

    renderAgentBack(agent = {}) {
        const detail = Array.isArray(agent.detail) ? agent.detail : [];
        return `
            <div class="agent-center-agent-title-row">
                <div>
                    <div class="agent-center-card-title">${escapeHtml(agent.detailTitle || agent.title || displayAgentFeature(agent.id))}</div>
                    <div class="agent-center-card-sub">${escapeHtml(agent.category ? `分类：${displayCardCategory(agent.category)}` : '卡片详情')}</div>
                </div>
                <button type="button" class="agent-center-card-action" data-agent-float-flip>返回</button>
            </div>
            ${detail.length ? `
                <div class="agent-center-agent-section">
                    <div class="agent-center-agent-section-title">说明</div>
                    ${detail.map(line => `<div class="agent-center-card-sub">${escapeHtml(line)}</div>`).join('')}
                </div>
            ` : ''}
            ${this.renderAgentFeatureSettings(agent)}
            ${this.renderAgentSettingRefs(agent)}
            ${this.renderMemoryAgentEditor(agent)}
            ${this.renderAgentPromptRefs(agent)}
            ${this.renderAgentResourceRefs(agent)}
            ${this.renderAgentRuntimeState(agent)}
        `;
    }

    renderFloatingAgentFront(agent = {}, { toolbarExtra = '' } = {}) {
        const detail = Array.isArray(agent.detail) ? agent.detail : [];
        const isDiagnosticView = trim(agent.cardGroup || agent.category) === 'diagnostic';
        const promptCount = Array.isArray(agent.promptRefs) ? agent.promptRefs.length : 0;
        const runtimeState = agent.runtimeState || null;
        return `
            <div class="agent-center-agent-title-row">
                <div class="agent-center-agent-title-main">
                    <span class="agent-center-agent-badge" data-i18n-skip>${escapeHtml(displayAgentCardGlyph(agent))}</span>
                    <div>
                        <div class="agent-center-card-title">${escapeHtml(agent.title || displayAgentFeature(agent.id))}</div>
                        <div class="agent-center-card-sub">${escapeHtml(agent.summary || '')}</div>
                    </div>
                </div>
                <div class="agent-center-floating-toolbar">
                    ${toolbarExtra}
                    <button type="button" class="agent-center-icon-button" data-agent-float-flip title="切换到配置" aria-label="切换到配置" aria-pressed="false">${ICONS.refresh}</button>
                    <button type="button" class="agent-center-icon-button" data-agent-float-close data-maid-guide-target="agent-center-detail-close" data-maid-guide-back="agent-center-detail" title="关闭" aria-label="关闭">${ICONS.close}</button>
                </div>
            </div>
            ${renderChips([
                agent.contextual ? null : { label: displayCardCategory(agent.category), className: statusChipClass('pending') },
                agent.contextual ? null : { label: agent.implemented ? '可使用' : '规划中', className: statusChipClass(agent.implemented ? 'succeeded' : 'pending') },
                isDiagnosticView ? { label: '诊断视图' } : { label: agent.workflowState ? (agent.workflowState.enabled ? t('已启用') : t('已停用')) : agent.statusLabel || (agent.enabled ? '已开启' : '已关闭'), className: statusChipClass((agent.workflowState?.enabled ?? agent.enabled) ? 'running' : agent.workflowState ? 'idle' : 'denied') },
                promptCount ? { label: `提示词 ${promptCount}` } : null,
                runtimeState ? { label: displayStatusLabel(runtimeState.status), className: statusChipClass(runtimeState.status) } : null,
            ])}
            ${agent.contextual ? '' : `<div class="agent-center-agent-section">
                <div class="agent-center-agent-section-title">说明</div>
                ${(detail.length ? detail : [agent.summary]).filter(Boolean).map(line => `<div class="agent-center-card-sub">${escapeHtml(line)}</div>`).join('')}
            </div>`}
            ${this.renderAgentSettingRefs(agent)}
            ${this.renderAgentRuntimeState(agent)}
        `;
    }

    renderFloatingAgentBack(agent = {}, { configuration = this.renderAgentConfiguration(agent), subtitle = t('配置 · 修改后即时生效'), toolbarExtra = '' } = {}) {
        return `
            <div class="agent-center-agent-title-row">
                <div class="agent-center-agent-title-main">
                    <span class="agent-center-agent-badge">${escapeHtml(displayAgentCardGlyph(agent))}</span>
                    <div>
                        <div class="agent-center-card-title">${escapeHtml(agent.title || displayAgentFeature(agent.id))}</div>
                        <div class="agent-center-card-sub">${escapeHtml(subtitle)}</div>
                    </div>
                </div>
                <div class="agent-center-floating-toolbar">
                    ${toolbarExtra}
                    <button type="button" class="agent-center-icon-button" data-agent-float-flip title="切换到详情" aria-label="切换到详情" aria-pressed="true">${ICONS.refresh}</button>
                    <button type="button" class="agent-center-icon-button" data-agent-float-close data-maid-guide-target="agent-center-detail-close" data-maid-guide-back="agent-center-detail" title="关闭" aria-label="关闭">${ICONS.close}</button>
                </div>
            </div>
            ${configuration}
        `;
    }

    renderAgentConfiguration(agent = {}, { preview = true } = {}) {
        return `
            ${this.renderAgentEnabledSetting(agent)}
            ${this.renderAgentFeatureSettings(agent)}
            ${preview ? this.renderAgentPromptPreviewAction(agent) : ''}
            ${this.renderReplyCheckPromptInfo(agent)}
            ${this.renderMemoryAgentEditor(agent)}
            ${this.renderAgentPromptRefs(agent)}
            ${this.renderAgentResourceRefs(agent)}
            ${(!isFeatureAgentCard(agent) && agent.id !== 'memory_table_agent' && !(Array.isArray(agent.promptRefs) && agent.promptRefs.length) && !(Array.isArray(agent.resourceRefs) && agent.resourceRefs.length))
                ? '<div class="agent-center-card-sub">这个卡片当前没有可编辑设置。</div>'
                : ''}
        `;
    }

    mountHopscotchAgentCard(host, { agentId = '', card, frontExtra = '', toolbarExtra = '', content, configure = false, readOnly = false, onClose, fusedConfigs = [], onOpenFused = null, buildPromptPreview = null, workflowState = null } = {}) {
        if (!host) return null;
        const entry = { host, agentId, card, frontExtra, toolbarExtra, content, readOnly, onClose, fusedConfigs, onOpenFused, buildPromptPreview, workflowState, preview: null, flipped: configure, entering: true };
        this.sharedAgentConfig = entry;
        this.refreshSharedAgentConfig();
        return {
            hasDraft: () => captureAgentEditorDrafts(host).editors.length > 0,
            setReadOnly: () => {
                entry.readOnly = true;
                entry.preview?.close();
                host.querySelector('[data-hop-agent-config]')?.setAttribute('disabled', '');
                host.querySelectorAll('[data-action="remove"], [data-action="toggle-enabled"], [data-action="variable-settings"], [data-action="variable-preview-tools"], [data-request-action]').forEach(button => { button.disabled = true; });
            },
            closePreview: () => entry.preview?.close() || false,
            dispose: () => { entry.preview?.dispose(); if (this.sharedAgentConfig === entry) this.sharedAgentConfig = null; },
        };
    }

    refreshSharedAgentConfig() {
        const entry = this.sharedAgentConfig;
        if (!entry || !entry.host.isConnected) return;
        const linkedAgent = entry.agentId && this.getAgentCardById(entry.agentId);
        if (!linkedAgent && !entry.card) return;
        const agent = { ...(linkedAgent || entry.card), workflowState: entry.workflowState };
        const snapshot = captureAgentEditorDrafts(entry.host);
        const previewState = entry.preview?.snapshot();
        entry.preview?.dispose(); entry.preview = null;
        const focusedField = entry.content?.contains(entry.host.ownerDocument.activeElement) ? entry.host.ownerDocument.activeElement : null;
        const scrollPositions = [...entry.host.querySelectorAll('.agent-center-floating-face')].map(face => face.scrollTop);
        // 编排表单保留原节点；AC 后台刷新不得重建房子的未提交输入。
        entry.content?.remove();
        const fusedLinks = entry.fusedConfigs.length ? `<div class="agent-center-card-actions">${entry.fusedConfigs.map(config => `<button type="button" class="agent-center-card-action" data-hop-fused-open="${escapeHtml(config.id)}">${escapeHtml(config.label)}</button>`).join('')}</div>` : '';
        const configuration = linkedAgent
            ? `<p class="agent-center-card-sub">${escapeHtml(t('共享设置会影响使用此 Agent 的其他会话。'))}</p>${this.renderAgentConfiguration(agent)}`
            : agent.id === 'body' ? this.renderAgentPromptPreviewAction(agent) + fusedLinks : '';
        entry.host.innerHTML = this.renderFloatingAgentCard({
            agent, flipped: entry.flipped, entering: entry.entering,
            toolbarExtra: entry.readOnly ? '' : entry.toolbarExtra,
            frontExtra: entry.frontExtra + fusedLinks,
            configuration: `<fieldset data-hop-agent-config class="hop-card-fields" ${entry.readOnly ? 'disabled' : ''}>${configuration}</fieldset><p class="hop-error" role="alert">${escapeHtml(this.lastError)}</p>`,
            subtitle: entry.readOnly ? t('本轮') : agent.contextual ? t('当前角色') : linkedAgent ? t('配置 · 修改后即时生效') : entry.fusedConfigs.length ? t('配置') : t('修改仅对下一轮生效，未保存不改变设置。'),
        });
        entry.entering = false;
        if (entry.content) entry.host.querySelector('.agent-center-floating-face-back').append(entry.content);
        if (entry.buildPromptPreview && !entry.readOnly) entry.preview = mountAgentRequestPreview({ host: entry.host, buildRequest: entry.buildPromptPreview, savedState: previewState });
        this.bindAgentCardEvents(entry.host, {
            onFlip: () => {
                entry.flipped = !entry.flipped;
                this.updateFloatingAgentFace(entry.host.querySelector('.agent-center-floating-card'), entry.flipped);
            },
            onClose: entry.onClose,
            onPromptPreview: id => entry.preview && id === 'body' ? entry.preview.open() : this.handleAgentPromptPreview(id),
        });
        entry.host.querySelectorAll('[data-hop-fused-open]').forEach(button => {
            button.onclick = () => { void entry.onOpenFused?.(button.dataset.hopFusedOpen); };
        });
        restoreAgentEditorDrafts(entry.host, snapshot);
        entry.host.querySelectorAll('.agent-center-floating-face').forEach((face, index) => { face.scrollTop = scrollPositions[index] || 0; });
        focusedField?.focus({ preventScroll: true });
    }

    renderFloatingAgentCard({ agent = this.getAgentCardById(this.floatingAgentId), flipped = this.floatingAgentFlipped, entering = this.floatingAgentEntryPending, frontExtra = '', toolbarExtra = '', configuration, subtitle } = {}) {
        if (!agent) return '';
        return `
            <div class="agent-center-floating-layer" data-agent-float-layer>
                <section
                    class="agent-center-floating-card${entering ? ' is-entering' : ''}${flipped ? ' is-flipped' : ''}"
                    data-agent-accent="${escapeHtml(agent.accent || '')}"
                    role="dialog"
                    aria-modal="true"
                    aria-label="${escapeHtml(agent.title || displayAgentFeature(agent.id))}"
                >
                    <div class="agent-center-floating-inner">
                        <div class="agent-center-floating-face agent-center-floating-face-front" ${flipped ? 'inert aria-hidden="true"' : 'aria-hidden="false"'}>
                            ${this.renderFloatingAgentFront(agent, { toolbarExtra })}
                            ${frontExtra}
                        </div>
                        <div class="agent-center-floating-face agent-center-floating-face-back" ${flipped ? 'aria-hidden="false"' : 'inert aria-hidden="true"'}>
                            ${this.renderFloatingAgentBack(agent, { configuration, subtitle, toolbarExtra })}
                        </div>
                    </div>
                </section>
            </div>
        `;
    }

    renderCardList(cards = [], emptyMessage = '还没有可用卡片。') {
        const agents = Array.isArray(cards) ? cards : [];
        if (!agents.length) return renderEmpty(emptyMessage);
        if (this.getHopscotchPanel()) {
            return `<div class="hop-agent-shelf">${agents.map(agent => `
                <button type="button" class="agent-center-card agent-center-agent-card hop-cell hop-agent-tile" data-agent-accent="${escapeHtml(agent.accent || '')}" data-agent-card-open="${escapeHtml(agent.id)}" data-maid-guide-target="agent-center-card">
                    <span class="hop-title">${escapeHtml(agent.title || displayAgentFeature(agent.id))}</span>
                    <span class="hop-cell-status">${escapeHtml(translateUiText(trim(agent.cardGroup || agent.category) === 'diagnostic' ? '诊断视图' : !agent.implemented ? '规划中' : agent.enabled ? '已开启' : '已关闭'))}</span>
                </button>`).join('')}</div>`;
        }
        const animate = this.cardEntryAnimationUntil === Number.POSITIVE_INFINITY;
        if (animate) {
            this.cardEntryAnimationUntil = Date.now() + 650;
        }
        return `<div class="agent-center-agent-list${animate ? ' is-entering' : ''}">${agents.map((agent, index) => `
            <article
                class="agent-center-card agent-center-agent-card${agent.enabled ? ' is-agent-on' : ''}"
                data-agent-accent="${escapeHtml(agent.accent || '')}"
                data-agent-card-open="${escapeHtml(agent.id)}"
                data-maid-guide-target="agent-center-card"
                style="--agent-card-index:${index};"
                role="button"
                tabindex="0"
            >
                ${this.renderAgentFront(agent)}
            </article>
        `).join('')}</div>`;
    }

    renderAgents() {
        const cards = this.renderCardList(this.getAgentCards(), '还没有可启用的 Agent');
        if (!this.getHopscotchPanel()) return cards;
        return `<div data-agent-hopscotch-host></div><details class="hop-agent-library" data-agent-library${this.agentLibraryOpen ? ' open' : ''}><summary>${escapeHtml(t('全部 Agent'))}</summary>${cards}</details>`;
    }

    renderPromptModules() {
        return this.renderCardList(this.getPromptModuleCards(), '还没有可管理的提示词/协议模块。');
    }

    renderDiagnostics() {
        return this.renderCardList(this.getDiagnosticCards(), '还没有诊断视图。');
    }

    renderPending() {
        const items = this.view.pending || [];
        if (!items.length) {
            return renderEmpty('没有待确认请求。AI 请求工具、画像保存或变更提交前，会出现在这里。');
        }
        return `<div class="agent-center-list">${items.map(item => {
            const isProfileUpdate = item.kind === 'contact_profile_update';
            const isToolPermission = item.kind === 'tool_permission';
            const writePreview = item.writePreview || null;
            const writePreviewCommit = writePreview?.commit || null;
            const impactText = isProfileUpdate
                ? `保存会写入联系人「${item.contactId || item.sessionId || '-'}」画像，并影响后续动态弱触发、提示词上下文和 Agent 画像读取；忽略只清除本次候选，不删除旧画像。`
                : '';
            const toolImpactText = isToolPermission
                ? (writePreview
                    ? '执行一次只生成变更预览和撤销记录；不会写入记忆、变量、世界书或聊天正文。真正提交还需要再次确认。'
                    : '执行一次只处理这个工具请求；不会重放聊天、不会自动继续生成、不会直接写聊天正文。')
                : '';
            const chatEmitPreview = item.chatEmitPreview || null;
            const chatEmitCommitPreview = item.chatEmitCommitPreview || null;
            const chatEmitCommit = item.chatEmitCommit || null;
            const chatEmitMeta = chatEmitPreview
                ? formatMeta([
                    chatEmitPreview.kind,
                    chatEmitPreview.target ? `目标：${chatEmitPreview.target}` : '',
                    chatEmitPreview.speaker ? `说话人：${chatEmitPreview.speaker}` : '',
                    chatEmitPreview.time ? `时间：${chatEmitPreview.time}` : '',
                ])
                : '';
            const isPending = item.status === 'pending';
            return `
            <article class="agent-center-card">
                <div class="agent-center-card-head">
                    <div>
                        <div class="agent-center-card-title">${escapeHtml(displayToolName(item.toolName))}</div>
                        <div class="agent-center-card-sub">${escapeHtml(formatMeta([item.sessionId ? `范围：${item.sessionId}` : '']))}</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass(item.status))}">${escapeHtml(displayStatusLabel(item.status))}</span>
                </div>
                ${renderChips([
                    { label: displayRiskLabel(item.riskLevel), className: riskChipClass(item.riskLevel) },
                    ...item.permissions.map(permission => ({ label: displayPermissionLabel(permission) })),
                    item.expiresAt ? { label: `过期时间 ${new Date(item.expiresAt).toLocaleTimeString()}` } : null,
                ])}
                ${isProfileUpdate ? `
                    <div class="agent-center-card-sub">${escapeHtml(formatMeta([item.reason ? `原因：${item.reason}` : '', item.profileSummary]))}</div>
                    <div class="agent-center-card-sub">${escapeHtml(impactText)}</div>
                    <div class="agent-center-card-actions">
                        <button type="button" class="agent-center-card-action is-primary" data-profile-action="approve" data-pending-id="${escapeHtml(item.id)}">保存画像</button>
                        <button type="button" class="agent-center-card-action is-danger" data-profile-action="deny" data-pending-id="${escapeHtml(item.id)}">忽略</button>
                    </div>
                ` : ''}
                ${isToolPermission ? `
                    <div class="agent-center-card-sub">${escapeHtml(toolImpactText)}</div>
                    ${writePreview ? `
                        <div class="agent-center-card-sub">写入预览：${escapeHtml(formatMeta([
                            writePreview.kind,
                            writePreview.target ? `${writePreview.targetLabel}：${writePreview.target}` : '',
                            writePreview.requestSummary,
                        ]))}</div>
                        ${writePreview.previewReady ? `
                            <div class="agent-center-card-sub">预览结果：${escapeHtml(writePreview.resultSummary || '无变更')}</div>
                            ${writePreview.rollbackReady ? `<div class="agent-center-card-sub">撤销记录：已准备好；当前仍未写入。</div>` : ''}
                            ${writePreview.entries?.length ? `
                                <div class="agent-center-card-sub">变更摘要：${escapeHtml(writePreview.entries.join('；'))}${writePreview.entryOverflow ? escapeHtml(`；另有 ${writePreview.entryOverflow} 项`) : ''}</div>
                            ` : ''}
                        ` : `
                            <div class="agent-center-card-sub">预览尚未执行；执行一次后只会生成可检查的变更摘要，不会提交。</div>
                        `}
                    ` : ''}
                    ${chatEmitPreview ? `
                        <div class="agent-center-card-sub">候选预览：${escapeHtml(chatEmitMeta || chatEmitPreview.kind || '聊天事件候选')}</div>
                        <div class="agent-center-card-sub">${escapeHtml(chatEmitPreview.contentPreview || '-')}</div>
                    ` : ''}
                    ${chatEmitCommitPreview ? `
                        <div class="agent-center-card-sub">后续提交预览：${escapeHtml(chatEmitCommitPreview.effect || '-')}</div>
                        <div class="agent-center-card-sub">撤销边界：${escapeHtml(chatEmitCommitPreview.undoSummary || '-')}</div>
                    ` : ''}
                    ${renderChips([
                        writePreview ? { label: writePreview.previewReady ? '预览已生成' : '等待预览' } : null,
                        writePreviewCommit ? { label: `提交：${displayCommitStatusLabel(writePreviewCommit)}` } : null,
                        writePreviewCommit ? { label: `撤销：${displayStatusLabel(writePreviewCommit.undoStatus)}` } : null,
                        chatEmitCommit ? { label: `提交：${displayCommitStatusLabel(chatEmitCommit)}` } : null,
                        chatEmitCommit ? { label: `撤销：${displayStatusLabel(chatEmitCommit.undoStatus)}` } : null,
                    ])}
                    ${writePreviewCommit?.resultSummary ? `
                        <div class="agent-center-card-sub">提交结果：${escapeHtml(writePreviewCommit.resultSummary)}</div>
                    ` : ''}
                    ${writePreviewCommit?.message ? `
                        <div class="agent-center-card-sub">提交说明：${escapeHtml(writePreviewCommit.message)}</div>
                    ` : ''}
                    ${writePreviewCommit?.undoMessage ? `
                        <div class="agent-center-card-sub">撤销说明：${escapeHtml(writePreviewCommit.undoMessage)}</div>
                    ` : ''}
                    ${writePreviewCommit?.errorMessage ? `
                        <div class="agent-center-card-sub agent-center-card-error">提交错误：${escapeHtml(writePreviewCommit.errorMessage)}</div>
                    ` : ''}
                    ${writePreviewCommit?.undoErrorMessage ? `
                        <div class="agent-center-card-sub agent-center-card-error">撤销错误：${escapeHtml(writePreviewCommit.undoErrorMessage)}</div>
                    ` : ''}
                    ${chatEmitCommit?.resultSummary ? `
                        <div class="agent-center-card-sub">提交结果：${escapeHtml(chatEmitCommit.resultSummary)}</div>
                    ` : ''}
                    ${chatEmitCommit?.message ? `
                        <div class="agent-center-card-sub">提交说明：${escapeHtml(chatEmitCommit.message)}</div>
                    ` : ''}
                    ${chatEmitCommit?.undoMessage ? `
                        <div class="agent-center-card-sub">撤销说明：${escapeHtml(chatEmitCommit.undoMessage)}</div>
                    ` : ''}
                    ${chatEmitCommit?.errorMessage ? `
                        <div class="agent-center-card-sub agent-center-card-error">提交错误：${escapeHtml(chatEmitCommit.errorMessage)}</div>
                    ` : ''}
                    ${chatEmitCommit?.undoErrorMessage ? `
                        <div class="agent-center-card-sub agent-center-card-error">撤销错误：${escapeHtml(chatEmitCommit.undoErrorMessage)}</div>
                    ` : ''}
                    ${isPending ? `
                        <div class="agent-center-card-actions">
                            <button type="button" class="agent-center-card-action is-primary" data-provider-permission-action="${PROVIDER_TOOL_PERMISSION_ACTIONS.allowOnce}" data-pending-id="${escapeHtml(item.id)}">执行一次</button>
                            <button type="button" class="agent-center-card-action is-danger" data-provider-permission-action="${PROVIDER_TOOL_PERMISSION_ACTIONS.deny}" data-pending-id="${escapeHtml(item.id)}">打回</button>
                            <button type="button" class="agent-center-card-action" data-provider-permission-action="${PROVIDER_TOOL_PERMISSION_ACTIONS.rememberAllow}" data-pending-id="${escapeHtml(item.id)}">记住执行</button>
                        </div>
                    ` : ''}
                    ${chatEmitCommit?.canCommit || chatEmitCommit?.canUndo ? `
                        <div class="agent-center-card-actions">
                            ${chatEmitCommit?.canCommit ? `<button type="button" class="agent-center-card-action is-primary" data-chat-emit-commit-action="commit" data-pending-id="${escapeHtml(item.id)}">执行</button>` : ''}
                            ${chatEmitCommit?.canCommit ? `<button type="button" class="agent-center-card-action is-danger" data-chat-emit-commit-action="reject" data-pending-id="${escapeHtml(item.id)}">打回</button>` : ''}
                            ${chatEmitCommit?.canUndo ? `<button type="button" class="agent-center-card-action is-danger" data-chat-emit-commit-action="undo" data-pending-id="${escapeHtml(item.id)}">撤销提交</button>` : ''}
                        </div>
                    ` : ''}
                    ${writePreviewCommit?.canCommit || writePreviewCommit?.canUndo ? `
                        <div class="agent-center-card-actions">
                            ${writePreviewCommit?.canCommit ? `<button type="button" class="agent-center-card-action is-primary" data-write-preview-commit-action="commit" data-pending-id="${escapeHtml(item.id)}">执行</button>` : ''}
                            ${writePreviewCommit?.canCommit ? `<button type="button" class="agent-center-card-action is-danger" data-write-preview-commit-action="reject" data-pending-id="${escapeHtml(item.id)}">打回</button>` : ''}
                            ${writePreviewCommit?.canUndo ? `<button type="button" class="agent-center-card-action is-danger" data-write-preview-commit-action="undo" data-pending-id="${escapeHtml(item.id)}">撤销变更</button>` : ''}
                        </div>
                    ` : ''}
                ` : ''}
            </article>
        `; }).join('')}</div>`;
    }

    async handleProfilePendingAction(action = '', pendingId = '') {
        const normalizedAction = trim(action);
        const id = trim(pendingId);
        if (!id) return;
        const item = (this.view.pending || []).find(entry => entry.id === id);
        const contactId = item?.contactId || item?.sessionId || '';
        const approving = normalizedAction === 'approve';
        const ok = await this.confirm({
            title: approving ? '保存联系人画像' : '忽略联系人画像',
            message: approving
                ? `确定保存联系人「${contactId || '-'}」的画像候选吗？\n\n保存后会影响后续动态弱触发、提示词上下文和 Agent 画像读取。`
                : `确定忽略联系人「${contactId || '-'}」的画像候选吗？\n\n忽略只清除本次候选，不删除已有画像。`,
            danger: !approving,
            confirmText: approving ? '保存画像' : '忽略',
        });
        if (!ok) return;
        const actionName = approving ? 'approveContactProfilePendingUpdate' : 'denyContactProfilePendingUpdate';
        await this.callAction(actionName, { id }, null);
        await this.refresh();
    }

    async handleProviderPermissionAction(action = '', pendingId = '') {
        const normalizedAction = trim(action);
        const id = trim(pendingId);
        if (!id) return;
        const item = (this.view.pending || []).find(entry => entry.id === id);
        const toolName = item?.toolName || 'tool';
        const writePreview = item?.writePreview || null;
        const label = providerToolActionLabel(normalizedAction);
        const toolLabel = displayToolName(toolName);
        const remembering = normalizedAction === PROVIDER_TOOL_PERMISSION_ACTIONS.rememberAllow;
        const denying = normalizedAction === PROVIDER_TOOL_PERMISSION_ACTIONS.deny;
        const ok = await this.confirm({
            title: `${label} Agent 工具`,
            message: denying
                ? `确定打回「${toolLabel}」这次请求吗？\n\n打回后不会执行工具，也不会继续生成。`
                : remembering
                    ? (writePreview
                        ? `确定记住执行「${toolLabel}」吗？\n\n影响范围：当前会话。后续同类预览请求可复用这条权限；执行只生成变更预览，不会写入记忆、变量、世界书或聊天正文。`
                        : `确定记住执行「${toolLabel}」吗？\n\n影响范围：当前会话。后续同类请求可复用这条权限；执行仍不会重放聊天或直接写聊天正文。`)
                    : (writePreview
                        ? `确定执行「${toolLabel}」一次吗？\n\n只会生成变更预览；不会写入记忆、变量、世界书或聊天正文。真正提交还需要再次确认。`
                        : `确定执行「${toolLabel}」一次吗？\n\n只会执行这一个工具请求；不会重放聊天、不会自动继续生成、不会直接写聊天正文。`),
            confirmText: label,
            danger: denying,
        });
        if (!ok) return;
        const actions = this.getActions?.() || {};
        const resolver = actions.resolveProviderToolPendingPermission;
        if (typeof resolver !== 'function') {
            this.lastError = '当前环境没有 Agent 工具权限处理动作';
            this.render();
            return;
        }
        try {
            await Promise.resolve(resolver({
                id,
                action: normalizedAction,
                reason: 'agent center pending action',
            }));
            await this.refresh();
        } catch (err) {
            this.lastError = trim(err?.message || err, 'resolveProviderToolPendingPermission failed');
            this.render();
        }
    }

    async handleChatEmitCommitAction(action = '', pendingId = '') {
        const normalizedAction = trim(action);
        const id = trim(pendingId);
        if (!id || !['commit', 'undo', 'reject'].includes(normalizedAction)) return;
        const item = (this.view.pending || []).find(entry => entry.id === id);
        const committing = normalizedAction === 'commit';
        const rejecting = normalizedAction === 'reject';
        const toolLabel = displayToolName(item?.toolName || 'chat.emit');
        const ok = await this.confirm({
            title: committing ? '执行聊天候选' : (rejecting ? '打回聊天候选' : '撤销聊天候选'),
            message: rejecting
                ? `确定打回「${toolLabel}」吗？\n\n打回后不会写入聊天或动态，这条候选会离开待确认。`
                : committing
                ? `确定提交「${toolLabel}」吗？\n\n这一步会写入聊天或动态；提交后可在这里撤销。`
                : `确定撤销「${toolLabel}」刚才提交的内容吗？\n\n撤销会删除本次新增聊天消息，或回滚动态变更。`,
            confirmText: committing ? '执行' : (rejecting ? '打回' : '撤销提交'),
            danger: !committing,
        });
        if (!ok) return;
        const actionName = committing
            ? 'commitChatEmitPendingPermission'
            : (rejecting ? 'rejectChatEmitPendingCommit' : 'undoChatEmitPendingCommit');
        const result = await this.callAction(actionName, {
            id,
            confirmed: true,
            reason: 'agent center chat emit commit action',
        }, null);
        if (!result) {
            this.lastError = committing
                ? '当前环境没有聊天候选提交动作'
                : rejecting
                    ? '当前环境没有聊天候选打回动作'
                : '当前环境没有聊天候选撤销动作';
        } else if (result.ok === false && (result.message || result.reason)) {
            this.lastError = result.message || result.reason;
        }
        await this.refresh();
    }

    async handleWritePreviewCommitAction(action = '', pendingId = '') {
        const normalizedAction = trim(action);
        const id = trim(pendingId);
        if (!id || !['commit', 'undo', 'reject'].includes(normalizedAction)) return;
        const item = (this.view.pending || []).find(entry => entry.id === id);
        const committing = normalizedAction === 'commit';
        const rejecting = normalizedAction === 'reject';
        const toolLabel = displayToolName(item?.toolName || '写入预览');
        const ok = await this.confirm({
            title: committing ? '执行写入预览' : (rejecting ? '打回写入预览' : '撤销写入变更'),
            message: rejecting
                ? `确定打回「${toolLabel}」吗？\n\n打回后不会写入记忆、变量或世界书，这条候选会离开待确认。`
                : committing
                ? `确定提交「${toolLabel}」吗？\n\n这一步会写入记忆、变量或世界书；提交后可在这里撤销。`
                : `确定撤销「${toolLabel}」刚才提交的变更吗？\n\n撤销只会回滚本次提交保存的变更。`,
            confirmText: committing ? '执行' : (rejecting ? '打回' : '撤销变更'),
            danger: !committing,
        });
        if (!ok) return;
        const actionName = committing
            ? 'commitAgentWritePreviewPendingPermission'
            : (rejecting ? 'rejectAgentWritePreviewPendingCommit' : 'undoAgentWritePreviewPendingCommit');
        const result = await this.callAction(actionName, {
            id,
            confirmed: true,
            reason: 'agent center write preview commit action',
        }, null);
        if (!result) {
            this.lastError = committing
                ? '当前环境没有写入预览提交动作'
                : rejecting
                    ? '当前环境没有写入预览打回动作'
                : '当前环境没有写入预览撤销动作';
        } else if (result.ok === false && (result.message || result.reason)) {
            this.lastError = result.message || result.reason;
        }
        await this.refresh();
    }

    async handleSessionGateAction(action = '') {
        const normalizedAction = trim(action);
        if (!['enable', 'disable'].includes(normalizedAction)) return;
        const enabling = normalizedAction === 'enable';
        const ok = await this.confirm({
            title: enabling ? '开启当前会话 Agent 工具' : '关闭当前会话 Agent 工具',
            message: enabling
                ? '影响范围：当前会话。开启后，AI 可以请求已允许的工具；每次执行前仍会让你确认。'
                : '影响范围：当前会话。关闭后，AI 后续请求工具不会执行；已有活动记录不会删除。',
            confirmText: enabling ? '开启' : '关闭',
            danger: !enabling,
        });
        if (!ok) return;
        const actions = this.getActions?.() || {};
        if (typeof actions.setProviderToolSessionGate !== 'function') {
            this.lastError = '当前环境不能切换会话 Agent 工具';
            this.render();
            return;
        }
        try {
            await Promise.resolve(actions.setProviderToolSessionGate({
                enabled: enabling,
                networkAllowed: false,
                realRunnerAllowed: false,
                source: 'agent_center',
                reason: enabling
                    ? 'enabled from Agent Center safety tab'
                    : 'disabled from Agent Center safety tab',
            }));
            await this.refresh();
        } catch (err) {
            this.lastError = trim(err?.message || err, '切换会话 Agent 工具失败');
            this.render();
        }
    }

    async handleWritePreviewModelContextAction(action = '') {
        const normalizedAction = trim(action);
        if (!['enable', 'disable'].includes(normalizedAction)) return;
        const enabling = normalizedAction === 'enable';
        const gate = this.view?.safety?.sessionGate || {};
        const writePreviewTools = Array.from(WRITE_PREVIEW_PROVIDER_MODEL_CONTEXT_TOOLS);
        const currentTools = list(gate.allowedTools);
        const nextTools = Array.from(new Set(enabling
            ? currentTools.concat(writePreviewTools)
            : currentTools.filter(tool => !writePreviewTools.includes(tool))));
        const ok = await this.confirm({
            title: enabling ? '加入写入预览工具' : '移除写入预览工具',
            message: enabling
                ? '影响范围：当前会话。AI 可以请求记忆、变量、世界书的变更预览；真正提交仍需要你再次确认。'
                : '影响范围：当前会话。AI 后续不会再看到记忆、变量、世界书预览工具；已有待确认请求不会删除。',
            confirmText: enabling ? '加入预览工具' : '移除预览工具',
            danger: !enabling,
        });
        if (!ok) return;
        const actions = this.getActions?.() || {};
        if (typeof actions.setProviderToolSessionGate !== 'function') {
            this.lastError = '当前环境不能调整预览工具';
            this.render();
            return;
        }
        try {
            await Promise.resolve(actions.setProviderToolSessionGate({
                enabled: gate.enabled === true,
                allowedTools: nextTools,
                networkAllowed: false,
                realRunnerAllowed: false,
                source: 'agent_center',
                reason: enabling
                    ? 'write preview tools added from Agent Center safety tab'
                    : 'write preview tools removed from Agent Center safety tab',
            }));
            await this.refresh();
        } catch (err) {
            this.lastError = trim(err?.message || err, '调整预览工具失败');
            this.render();
        }
    }

    handleAgentCardFlip(agentId = '') {
        this.openFloatingAgentCard(agentId);
    }

    openFloatingAgentCard(agentId = '') {
        const id = trim(agentId);
        if (!id || !this.getAgentCardById(id)) return;
        const mountedCard = this.contentElement?.querySelector?.('.agent-center-floating-card');
        this.floatingAgentEntryPending = !mountedCard || this.floatingAgentId !== id;
        this.floatingAgentId = id;
        this.floatingAgentFlipped = false;
        this.render();
    }

    requestAgentCardClose(continuation) {
        if (!this.getHopscotchPanel() || !this.floatingAgentId || !captureAgentEditorDrafts(this.contentElement).editors.length) return true;
        const id = this.floatingAgentId;
        void this.confirm({ title: t('未保存的修改'), message: t('共享设置尚未保存，关闭将丢弃这些修改。'), confirmText: t('丢弃并关闭'), danger: true }).then(accepted => {
            if (accepted && this.floatingAgentId === id && this.isVisible()) continuation();
        });
        return false;
    }

    closeFloatingAgentCard({ force = false } = {}) {
        if (!force && !this.requestAgentCardClose(() => this.closeFloatingAgentCard({ force: true }))) return false;
        this.floatingAgentId = '';
        this.floatingAgentFlipped = false;
        this.floatingAgentEntryPending = false;
        this.render();
        return true;
    }

    toggleFloatingAgentCard() {
        if (!this.floatingAgentId) return;
        this.floatingAgentFlipped = !this.floatingAgentFlipped;
        const card = this.contentElement?.querySelector?.('.agent-center-floating-card');
        if (card) {
            this.updateFloatingAgentFace(card, this.floatingAgentFlipped);
            return;
        }
        this.render();
    }

    updateFloatingAgentFace(card, flipped) {
        const hadFocus = card.contains?.(card.ownerDocument?.activeElement);
        card.classList?.toggle?.('is-flipped', flipped);
        for (const [selector, hidden] of [['.agent-center-floating-face-front', flipped], ['.agent-center-floating-face-back', !flipped]]) {
            const face = card.querySelector?.(selector);
            if (face) { face.inert = hidden; face.setAttribute('aria-hidden', String(hidden)); }
        }
        card.querySelectorAll?.('[data-agent-float-flip]')?.forEach?.((button) => {
            const nextLabel = flipped ? '切换到详情' : '切换到配置';
            button.setAttribute?.('aria-label', nextLabel);
            button.setAttribute?.('title', nextLabel);
            button.setAttribute?.('aria-pressed', String(flipped));
        });
        if (hadFocus) card.querySelector?.(`${flipped ? '.agent-center-floating-face-back' : '.agent-center-floating-face-front'} [data-agent-float-flip]`)?.focus?.({ preventScroll: true });
    }

    setAgentQuickToggleVisual(button = null, enabled = false, agentTitle = 'Agent') {
        if (!button) return;
        const nextAction = enabled ? 'disable' : 'enable';
        const nextLabel = formatToggleTargetLabel(enabled ? 'disable' : 'enable', trim(agentTitle, 'Agent'));
        button.setAttribute?.('aria-checked', String(enabled));
        button.setAttribute?.('aria-label', nextLabel);
        button.setAttribute?.('title', nextLabel);
        button.classList?.toggle?.('is-on', enabled);
        if (button.dataset && 'agentFeatureId' in button.dataset) {
            button.dataset.agentFeatureAction = nextAction;
        }
        if (button.dataset && 'agentCardId' in button.dataset) {
            button.dataset.agentCardAction = nextAction;
        }
    }

    setAgentQuickTogglePending(button = null, pending = false) {
        if (!button) return;
        if (pending) {
            button.dataset.agentTogglePending = 'true';
            button.setAttribute?.('aria-busy', 'true');
            return;
        }
        delete button.dataset.agentTogglePending;
        button.removeAttribute?.('aria-busy');
    }

    async handleAgentCardToggle(action = '', cardId = '', button = null) {
        const id = trim(cardId);
        const normalizedAction = trim(action);
        const enabling = normalizedAction === 'enable';
        if (!id || !['enable', 'disable'].includes(normalizedAction)) return false;
        const agent = this.getAgentCardById(id);
        if (!agent?.implemented || id === 'memory_table_agent') return false;
        if (button?.dataset?.agentTogglePending === 'true') return false;
        const originalEnabled = agent.enabled === true;
        this.setAgentQuickTogglePending(button, true);
        this.setAgentQuickToggleVisual(button, enabling, agent.title);
        try {
            const result = await this.callAction('setAgentCardEnabled', {
                id,
                enabled: enabling,
                reason: 'agent center card toggle',
            }, null);
            if (result === null || result === false || result?.ok === false) {
                this.setAgentQuickToggleVisual(button, originalEnabled, agent.title);
                const reason = trim(result?.message || result?.reason || this.lastError, '当前环境不能切换这个卡片');
                this.lastError = reason;
                this.notifyError?.(`${agent.title || 'Agent'}切换失败：${reason}`);
                this.render();
                return false;
            }
            this.notifySuccess?.(`${agent.title || 'Agent'}已${enabling ? '开启' : '关闭'}`);
            await this.refresh();
            return true;
        } finally {
            this.setAgentQuickTogglePending(button, false);
        }
    }

    async handleAgentPromptSave(promptId = '', button = null) {
        const id = trim(promptId);
        const editor = button?.closest?.('[data-agent-prompt-editor]');
        if (!id || !editor) return;
        const agentId = trim(editor.dataset.agentId);
        const profileType = trim(editor.dataset.agentPromptProfileType, 'sysprompt');
        const presetId = trim(editor.dataset.agentPromptPresetId);
        const config = {
            enabled: editor.querySelector('[data-agent-prompt-enabled]')?.checked !== false,
            rules: editor.querySelector('[data-agent-prompt-rules]')?.value ?? '',
        };
        const positionEl = editor.querySelector('[data-agent-prompt-position]');
        const depthEl = editor.querySelector('[data-agent-prompt-depth]');
        const roleEl = editor.querySelector('[data-agent-prompt-role]');
        if (positionEl) config.position = Math.trunc(Number(positionEl.value));
        if (depthEl) config.depth = Math.max(0, Math.trunc(Number(depthEl.value) || 0));
        if (roleEl) config.role = Math.trunc(Number(roleEl.value));
        const result = await this.callAction('setAgentPromptConfig', {
            profileType,
            presetId,
            agentId,
            promptId: id,
            config,
        }, null);
        if (!result) {
            this.lastError = '当前环境不能保存提示词';
            this.render();
            return;
        }
        await this.refresh();
    }

    async handleMemoryAgentSave(button = null) {
        const editor = button?.closest?.('[data-memory-agent-editor]');
        if (!editor) return;
        const config = {
            dataPosition: editor.querySelector('[data-memory-data-position]')?.value || '',
            dataDepth: Math.max(0, Math.trunc(Number(editor.querySelector('[data-memory-data-depth]')?.value) || 0)),
            guidePosition: editor.querySelector('[data-memory-guide-position]')?.value || '',
            guideDepth: Math.max(0, Math.trunc(Number(editor.querySelector('[data-memory-guide-depth]')?.value) || 0)),
        };
        const result = await this.callAction('setMemoryAgentSettings', {
            presetId: trim(editor.dataset.memoryAgentPresetId),
            config,
        }, null);
        if (!result) {
            this.lastError = '当前环境不能保存记忆表格 Agent 设置';
            this.render();
            return;
        }
        const promptResult = await this.callAction('setMemoryAgentPromptConfig', {
            templateId: trim(editor.dataset.memoryAgentTemplateId),
            config: {
                template: editor.querySelector('[data-memory-prompt-template]')?.value ?? '',
                wrapper: editor.querySelector('[data-memory-prompt-wrapper]')?.value ?? '',
                position: editor.querySelector('[data-memory-prompt-position]')?.value || 'before_latest_user',
            },
        }, true);
        if (!promptResult) {
            this.lastError = '当前环境不能保存记忆提示词模板';
            this.render();
            return;
        }
        await this.refresh();
    }

    handleMemoryStorageMode(mode = 'table') {
        return applyMemoryStorageMode({
            mode,
            appSettings,
            dispatchEvent: event => globalThis.window?.dispatchEvent?.(event),
        });
    }

    handleReplyCheckPreviewTargetChange(value = 'auto') {
        const normalized = trim(value, 'auto');
        const allowed = new Set(REPLY_CHECK_PREVIEW_TARGET_OPTIONS.map(option => option.value));
        this.replyCheckPreviewTarget = allowed.has(normalized) ? normalized : 'auto';
    }

    async handleAgentPromptPreview(agentId = '') {
        const id = trim(agentId);
        const payload = {
            source: 'agent_center',
            agentId: id,
        };
        if (id === 'reply_check') payload.formatTarget = this.replyCheckPreviewTarget || 'auto';
        const result = await this.callAction('showPromptPreview', payload, null);
        if (result === false || result === null) {
            this.lastError = '暂时无法构建本次 Prompt 预览。';
            this.render();
        }
    }

    async handleAgentFeatureToggle(action = '', featureId = '', button = null) {
        const id = trim(featureId);
        const normalizedAction = trim(action);
        const enabling = normalizedAction === 'enable';
        if (!id || !['enable', 'disable'].includes(normalizedAction)) return false;
        const agent = this.getAgentCardById(id);
        if (!agent?.implemented) return false;
        if (button?.dataset?.agentTogglePending === 'true') return false;
        const originalEnabled = agent.enabled === true;
        this.setAgentQuickTogglePending(button, true);
        try {
            if (id === 'write_preview') {
                const ok = await this.confirm({
                    title: enabling ? `开启${agent.title}` : `关闭${agent.title}`,
                    message: enabling
                        ? `开启后：${agent.summary || agent.title}\n\n影响范围：当前会话。预览工具会加入可请求范围；真正提交仍需要再次确认。`
                        : `关闭后：${agent.summary || agent.title}\n\n已有活动记录不会删除。`,
                    confirmText: enabling ? '开启' : '关闭',
                    danger: !enabling,
                });
                if (!ok) return false;
            }
            this.setAgentQuickToggleVisual(button, enabling, agent.title);
            const result = await this.callAgentFeatureMutation('setAgentFeatureEnabled', {
                id,
                enabled: enabling,
                reason: 'agent center feature toggle',
            }, null);
            if (result === null || result === false || result?.ok === false) {
                this.setAgentQuickToggleVisual(button, originalEnabled, agent.title);
                const reason = trim(result?.message || result?.reason || this.lastError, '当前环境不能切换 Agent');
                this.lastError = reason;
                this.notifyError?.(`${agent.title || 'Agent'}切换失败：${reason}`);
                await this.refresh();
                return false;
            }
            this.notifySuccess?.(`${agent.title || 'Agent'}已${enabling ? '开启' : '关闭'}`);
            await this.refresh();
            if (enabling && id === 'reply_check' && trim(agent.modelMode, 'none') === 'none') {
                const selected = await this.choice({
                    title: '配置检查模型',
                    message: '默认只做本地格式检测。选择模型后，发现格式问题时可让 AI 再复核一次。',
                    defaultActionId: 'select_model',
                    actions: [
                        { id: 'select_model', label: '现在选择模型', primary: true },
                        { id: 'manage_api', label: '管理 API 配置' },
                        { id: 'keep_local', label: '暂时只本地检测' },
                    ],
                });
                if (selected === 'select_model') {
                    this.openAgentModelSelect(id);
                } else if (selected === 'manage_api') {
                    this.handleAgentFeatureModelManage(id);
                }
            }
            return true;
        } finally {
            this.setAgentQuickTogglePending(button, false);
        }
    }

    async handleAgentFeatureDetail(featureId = '') {
        const id = trim(featureId);
        const agent = this.getAgentCardById(id);
        if (!agent) return;
        await this.confirm({
            title: agent.detailTitle || agent.title || displayAgentFeature(id),
            message: [
                agent.summary,
                ...(Array.isArray(agent.detail) ? agent.detail : []),
                isFeatureAgentCard(agent) && agent.supportsTriggerMode ? `触发：${agent.triggerLabel || '自动触发'}` : '',
                isFeatureAgentCard(agent) && agent.supportsModel ? `模型：${agent.modelLabel || '不调用模型'}` : '',
                trim(agent.cardGroup || agent.category) === 'diagnostic' ? '类型：诊断视图' : (agent.enabled ? '状态：已开启' : '状态：默认关闭'),
            ].filter(Boolean).join('\n\n'),
            confirmText: '知道了',
        });
    }

    async handleAgentFeatureModel(featureId = '') {
        const id = trim(featureId);
        const agent = this.getAgentCardById(id);
        if (!agent?.supportsModel || !agent?.implemented) return;
        await this.handleAgentFeatureModelSelect(id, this.getAgentModelSelectValue(agent));
    }

    async handleAgentFeatureModelSelect(featureId = '', selectedValue = '', selectElement = null) {
        const id = trim(featureId);
        const agent = this.getAgentCardById(id);
        if (!agent?.supportsModel || !agent?.implemented) return;
        const selected = trim(selectedValue, 'follow_current');
        const previousValue = this.getAgentModelSelectValue(agent);
        const modelMode = selected.startsWith('profile:') ? 'profile' : selected;
        const modelProfileId = selected.startsWith('profile:')
            ? selected.slice('profile:'.length)
            : '';
        const result = await this.callAgentFeatureMutation('setAgentFeatureModel', {
            id,
            modelMode,
            modelProfileId,
            // 切换连线档时清除模型覆盖（旧覆盖针对旧档的模型名）
            modelOverride: '',
        }, null);
        if (!result) {
            this.lastError = '当前环境不能更新 Agent 模型';
            if (selectElement) selectElement.value = previousValue;
            await this.refresh();
            return;
        }
        await this.refresh();
    }

    handleAgentFeatureModelManage(featureId = '') {
        const id = trim(featureId);
        const agent = this.getAgentCardById(id);
        if (!agent?.supportsModel || !agent?.implemented || typeof this.openConfig !== 'function') return;
        closeCustomSelectMenu();
        if (this.getHopscotchPanel()) {
            this.openConfig({ tab: 'chat', onHide: () => this.refresh() });
            return;
        }
        this.hide();
        this.openConfig({
            tab: 'chat',
            onHide: async () => {
                this.show({ tab: 'agents' });
            },
        });
    }

    openAgentModelSelect(featureId = '') {
        const id = trim(featureId);
        if (!id || !this.contentElement || !this.getAgentCardById(id)) return false;
        const sharedRoot = this.sharedAgentConfig?.agentId === id && this.sharedAgentConfig.host.isConnected ? this.sharedAgentConfig.host : null;
        if (!sharedRoot && (this.floatingAgentId !== id || this.floatingAgentFlipped !== true)) {
            const mountedCard = this.contentElement.querySelector?.('.agent-center-floating-card');
            this.floatingAgentEntryPending = !mountedCard || this.floatingAgentId !== id;
            this.floatingAgentId = id;
            this.floatingAgentFlipped = true;
            this.render();
        }
        const button = Array.from((sharedRoot || this.contentElement).querySelectorAll('[data-agent-feature-model-button]'))
            .find(item => item?.dataset?.agentFeatureModelButton === id);
        if (!button || button.disabled || typeof button.click !== 'function') return false;
        button.focus?.();
        button.click();
        return true;
    }

    async handleAgentFeatureTriggerMode(featureId = '') {
        const id = trim(featureId);
        const agent = this.getAgentCardById(id);
        if (!agent?.supportsTriggerMode || !agent?.implemented) return;
        const selected = await this.choice({
            title: `${agent.title || displayAgentFeature(id)}触发方式`,
            message: [
                '选择这个 Agent 在 AI 回复后的工作方式。',
                '自动触发只在解析失败且没有聊天输出时直接尝试修复；手动检查的修复候选仍由你确认。',
            ].join('\n\n'),
            defaultActionId: agent.triggerMode || 'auto',
            actions: [
                { id: 'auto', label: '自动触发', primary: agent.triggerMode !== 'manual' },
                { id: 'manual', label: '手动触发', primary: agent.triggerMode === 'manual' },
            ],
        });
        if (!selected) return;
        const result = await this.callAgentFeatureMutation('setAgentFeatureTriggerMode', {
            id,
            triggerMode: selected,
        }, null);
        if (!result) {
            this.lastError = '当前环境不能更新 Agent 触发方式';
            await this.refresh();
            return;
        }
        await this.refresh();
    }

    async handleContinuationPolicyAction(strategy = '') {
        const normalizedStrategy = normalizeContinuationCommitStrategy(strategy);
        const actions = this.getActions?.() || {};
        if (typeof actions.setProviderContinuationCommitPolicy !== 'function') {
            this.lastError = '当前环境没有 Provider continuation 策略设置动作';
            this.render();
            return;
        }
        try {
            await Promise.resolve(actions.setProviderContinuationCommitPolicy({
                defaultStrategy: normalizedStrategy,
            }));
            await this.refresh();
        } catch (err) {
            this.lastError = trim(err?.message || err, 'setProviderContinuationCommitPolicy failed');
            this.render();
        }
    }

    handleFailureReadAction() {
        this.markCurrentFailuresSeen();
        this.render();
    }

    async handleAgentRunReviewAction(action = '', runId = '') {
        const normalizedAction = trim(action);
        const id = trim(runId);
        if (!id || !['apply', 'reject'].includes(normalizedAction)) return;
        if (normalizedAction === 'apply') {
            const result = await this.callAction('applyAgentFormatRepairRun', { runId: id }, null);
            if (!result || result.ok === false) {
                this.lastError = result?.message || result?.reason || '当前格式修复候选已经不可用';
            } else if (result.applied === true) {
                this.notifySuccess?.('格式修复已应用');
            }
            await this.refresh();
            return;
        }
        const run = (this.view.activity?.runs || []).find(item => item.id === id);
        const ok = await this.confirm({
            title: '打回 Agent 待确认',
            message: `确定打回「${run?.title || run?.kind || id}」吗？\n\n打回后不会执行候选动作，这条记录会离开待确认。`,
            confirmText: '打回',
            danger: true,
        });
        if (!ok) return;
        const result = await this.callAction('resolveAgentRunReview', {
            runId: id,
            decision: 'reject',
            reason: 'agent center review rejected',
            summary: '已打回',
        }, null);
        if (!result || result.ok === false) {
            this.lastError = result?.message || result?.reason || '当前环境没有 Agent 待确认处理动作';
        }
        await this.refresh();
    }

    renderActivity() {
        const activity = this.view.activity || {};
        const runs = activity.runs || [];
        const meta = activity.meta || {};
        const formatCandidateQuery = (this.getActions?.() || {}).hasAgentFormatRepairCandidate;
        const hasFormatRepairCandidate = runId => {
            if (typeof formatCandidateQuery !== 'function') return false;
            try {
                return formatCandidateQuery({ runId: trim(runId) }) === true;
            } catch {
                return false;
            }
        };
        const statusCounts = this.surface ? (meta.scopedStatusCounts || meta.statusCounts || {}) : (meta.statusCounts || {});
        const activeStatus = normalizeActivityStatus(this.activityStatus);
        const filters = [
            { status: '', label: `全部 ${Number(this.surface ? (meta.scoped ?? meta.filtered ?? 0) : (meta.total || 0))}` },
            { status: 'active', label: `运行中 ${Number(this.surface ? (meta.scopedActive ?? meta.active ?? 0) : (meta.active || 0))}` },
            { status: 'waiting_permission', label: `待确认 ${Number(statusCounts.waiting_permission || 0)}` },
            { status: 'failure', label: `失败 ${Number(this.surface ? (meta.scopedFailures ?? meta.failures ?? 0) : (meta.failures || 0))}`, tone: 'danger' },
            { status: 'succeeded', label: `完成 ${Number(statusCounts.succeeded || 0)}` },
        ];
        const maidRunCount = Number(meta.kindCounts?.maid_assistant || 0);
        const activeKind = String(this.activityKind || '').trim();
        const filterHtml = `<div class="agent-center-filter-row" aria-label="Agent activity filters">${filters.map(filter => `
            <button
                type="button"
                class="agent-center-filter${activeStatus === filter.status ? ' is-active' : ''}${filter.tone === 'danger' ? ' is-danger' : ''}"
                data-activity-status="${escapeHtml(filter.status)}"
            >${escapeHtml(translateUiText(filter.label))}</button>
        `).join('')}${maidRunCount ? `
            <button
                type="button"
                class="agent-center-filter${activeKind === 'maid_assistant' ? ' is-active' : ''}"
                data-activity-kind="${activeKind === 'maid_assistant' ? '' : 'maid_assistant'}"
            >${escapeHtml(translateUiText(`女仆 ${maidRunCount}`))}</button>
        ` : ''}</div>`;
        const intro = activeStatus === 'failure'
            ? renderNotice({
                title: '失败记录',
                message: '查看后会从顶部提醒移除，不会删除活动记录。',
                actionLabel: '从顶部提醒移除',
                actionAttr: 'data-failure-read-action="mark"',
            })
            : '';
        const usageSummary = renderUsageProfileSummary(activity.usageProfile);
        if (!runs.length) {
            return `${filterHtml}${usageSummary}${intro}${renderEmpty(activeStatus ? `没有${activityStatusLabel(activeStatus)} Agent 活动` : '还没有 Agent 活动记录。AI 检查、候选和后台任务会显示在这里。')}`;
        }
        return `${filterHtml}${usageSummary}${intro}<div class="agent-center-list">${runs.map(run => {
            const failureDetail = trim(run.errorMessage || run.cancelReason || run.lastStep?.errorMessage);
            return `
            <article class="${escapeHtml(activityCardClass(run))}">
                <div class="agent-center-card-head">
                    <div>
                        <div class="agent-center-card-title" data-i18n-skip>${escapeHtml(translateUiText(run.title || run.kind || run.id))}</div>
                        <div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(formatMeta([
                            translateUiText(displayAgentKind(run.kind)),
                            run.sessionId ? translateUiText(`范围：${run.sessionId}`) : '',
                        ]))}</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass(run.status))}">${escapeHtml(displayRunStatusLabel(run))}</span>
                </div>
                <div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(translateUiText(displayRunSummary(run)))}</div>
                ${run.goal && run.goal !== run.title ? `<div class="agent-center-card-sub">${escapeHtml(translateUiText('目标：'))}<span data-i18n-skip>${escapeHtml(run.goal)}</span></div>` : ''}
                ${failureDetail ? `<div class="agent-center-card-sub agent-center-card-error">${escapeHtml(translateUiText('错误：'))}<span data-i18n-skip>${escapeHtml(failureDetail)}</span></div>` : ''}
                ${renderChips([
                    { label: `步骤 ${Number(run.stepCount || 0)}` },
                    { label: `工具 ${Number(run.toolCallCount || 0)}` },
                    ...buildRunUsageChips(run.usage),
                    run.continuable ? { label: '可继续' } : null,
                    run.failureCode ? { label: `原因：${run.failureCode}` } : null,
                    run.lastStep ? { label: `最近：${displayAgentKind(run.lastStep.type)}` } : null,
                ])}
                ${renderChatFormatReview(run.review)}
                ${run.status === 'waiting_permission' ? `
                    <div class="agent-center-card-actions">
                        ${run.review?.protocolParseFailure === true &&
                          run.review?.modelReviewDetail?.canRepair === true &&
                          hasFormatRepairCandidate(run.id)
                          ? `<button type="button" class="agent-center-card-action" data-agent-run-review-action="apply" data-run-id="${escapeHtml(run.id)}">应用修复</button>`
                          : ''}
                        <button type="button" class="agent-center-card-action is-danger" data-agent-run-review-action="reject" data-run-id="${escapeHtml(run.id)}">打回</button>
                    </div>
                ` : ''}
            </article>
        `; }).join('')}</div>`;
    }

    renderResources() {
        const resources = this.view.resources || [];
        if (!resources.length) return renderEmpty('还没有可管理资源入口。');
        return `<div class="agent-center-resource-list">${resources.map(resource => {
            const shortcuts = Array.isArray(resource.shortcuts) ? resource.shortcuts.filter(item => item?.label && item?.promptId) : [];
            return `
            <article class="agent-center-card agent-center-resource-card">
                <div class="agent-center-resource-main">
                    <div class="agent-center-card-head">
                        <div>
                            <div class="agent-center-resource-group" data-i18n-skip>${escapeHtml(translateUiText(resource.group || '资源'))}</div>
                            <div class="agent-center-card-title" data-i18n-skip>${escapeHtml(translateUiText(resource.title || resource.id))}</div>
                        </div>
                        <span class="${escapeHtml(statusChipClass(Number(resource.count || 0) > 0 ? 'pending' : 'succeeded'))}" data-i18n-skip>${escapeHtml(translateUiText(resource.status || '就绪'))}</span>
                    </div>
                    ${resource.summary ? `<div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(translateUiText(resource.summary))}</div>` : ''}
                </div>
                <div class="agent-center-card-actions agent-center-resource-actions">
                    <button type="button" class="agent-center-card-action is-primary" data-resource-open="${escapeHtml(resource.id)}" data-i18n-skip>${escapeHtml(translateUiText(resource.actionLabel || '打开'))}</button>
                    ${Number(resource.count || 0) > 0 ? `<button type="button" class="agent-center-card-action" data-resource-pending="${escapeHtml(resource.id)}">待处理</button>` : ''}
                </div>
                ${shortcuts.length ? `<div class="agent-center-resource-shortcuts">${shortcuts.map(shortcut => `
                    <button
                        type="button"
                        class="agent-center-resource-shortcut"
                        data-resource-open="${escapeHtml(resource.id)}"
                        data-resource-prompt-id="${escapeHtml(shortcut.promptId)}"
                    data-i18n-skip>${escapeHtml(translateUiText(shortcut.label))}</button>
                `).join('')}</div>` : ''}
            </article>
        `; }).join('')}</div>`;
    }

    async handleResourceOpen(resourceId = '', options = {}) {
        const resource = findAgentCenterResource(this.view.resources || [], resourceId);
        if (!resource) return;
        const opts = options && typeof options === 'object' ? options : {};
        const target = {
            ...(resource.target || {}),
            ...(opts.target || {}),
        };
        if (opts.promptId) target.promptId = opts.promptId;
        if (opts.focus) target.focus = opts.focus;
        const ok = await Promise.resolve(this.openResourceTarget?.(target, resource));
        if (ok) return;
        this.lastError = `无法打开「${resource.title || resource.id}」主界面`;
        this.render();
    }

    handleResourcePending(resourceId = '') {
        const resource = findAgentCenterResource(this.view.resources || [], resourceId);
        if (!resource) return;
        this.setActiveTab('pending');
    }

    renderTools() {
        const tools = this.view.tools || [];
        if (!tools.length) return renderEmpty('还没有注册 Agent 工具');
        return `<div class="agent-center-list">${tools.map(tool => `
            <article class="agent-center-card">
                <div class="agent-center-card-title">${escapeHtml(displayToolName(tool.name || tool.title))}</div>
                <div class="agent-center-card-sub">${escapeHtml(tool.description || tool.title || '')}</div>
                ${renderChips([
                    { label: displayRiskLabel(tool.riskLevel), className: riskChipClass(tool.riskLevel) },
                    ...tool.permissions.map(permission => ({ label: displayPermissionLabel(permission) })),
                ])}
                ${renderChips(capabilityLabels(tool.capabilities).map(label => ({ label })))}
            </article>
        `).join('')}</div>`;
    }

    syncGlobalPromptBases(library = null) {
        const normalized = normalizeGlobalSemanticPromptLibrary(
            library || this.view.globalPromptLibrary,
        );
        const ids = new Set(normalized.blocks.map(block => block.id));
        normalized.blocks.forEach((block) => {
            const previousBase = this.globalPromptBases.get(block.id);
            const draft = this.globalPromptDrafts.get(block.id);
            this.globalPromptBases.set(block.id, { ...block });
            if (draft && previousBase && !this.isGlobalPromptDraftModified(block.id, previousBase)) {
                this.globalPromptDrafts.set(block.id, { ...block });
            }
        });
        Array.from(this.globalPromptBases.keys()).forEach((id) => {
            if (ids.has(id)) return;
            this.globalPromptBases.delete(id);
            this.globalPromptDrafts.delete(id);
            if (this.globalPromptEditingId === id) {
                this.globalPromptEditingId = '';
                this.globalPromptPage = 'list';
            }
        });
        return normalized;
    }

    getGlobalPromptBase(id = '') {
        const key = trim(id);
        if (!key) return null;
        const cached = this.globalPromptBases.get(key);
        if (cached) return cached;
        const block = normalizeGlobalSemanticPromptLibrary(this.view.globalPromptLibrary).blocks
            .find(item => item.id === key);
        if (!block) return null;
        const base = { ...block };
        this.globalPromptBases.set(key, base);
        return base;
    }

    ensureGlobalPromptDraft(id = '') {
        const key = trim(id);
        if (!key) return null;
        if (!this.globalPromptDrafts.has(key)) {
            const base = this.getGlobalPromptBase(key);
            if (!base) return null;
            this.globalPromptDrafts.set(key, { ...base });
        }
        return this.globalPromptDrafts.get(key);
    }

    isGlobalPromptDraftModified(id = '', baseOverride = null) {
        const key = trim(id);
        const draft = this.globalPromptDrafts.get(key);
        const base = baseOverride || this.globalPromptBases.get(key);
        if (!draft || !base) return false;
        return String(draft.name || '') !== String(base.name || '')
            || draft.enabled !== base.enabled
            || String(draft.scope || 'chat') !== String(base.scope || 'chat')
            || String(draft.anchor || 'semantic_header') !== String(base.anchor || 'semantic_header')
            || presetBlockContentChanged(base.content, draft.content);
    }

    isGlobalPromptDraftContentModified(id = '') {
        const key = trim(id);
        const draft = this.globalPromptDrafts.get(key);
        const base = this.globalPromptBases.get(key);
        return Boolean(draft && base && presetBlockContentChanged(base.content, draft.content));
    }

    updateGlobalPromptDraft(id = '', patch = {}) {
        const draft = this.ensureGlobalPromptDraft(id);
        if (!draft || !patch || typeof patch !== 'object') return null;
        Object.assign(draft, patch);
        return draft;
    }

    openGlobalPromptBlockEditor(id = '') {
        const key = trim(id);
        if (!this.ensureGlobalPromptDraft(key)) return false;
        this.globalPromptEditingId = key;
        this.globalPromptPage = 'block';
        this.render();
        return true;
    }

    showGlobalPromptList() {
        this.globalPromptPage = 'list';
        this.globalPromptEditingId = '';
        try { globalThis.CSS?.highlights?.delete?.('agent-global-preview-selection'); } catch {}
        this.render();
    }

    renderGlobalPromptDiffHtml(baseText = '', draftText = '', blockId = '') {
        const { rows } = buildLineDiff(baseText, draftText, { collapseContext: false });
        const isChanged = row => row?.type === 'del' || row?.type === 'add';
        let html = '';
        let hunk = -1;
        rows.forEach((row, index) => {
            const newline = index < rows.length - 1 ? '\n' : '';
            if (!isChanged(row)) {
                html += `${escapeHtml(row.text)}${newline}`;
                return;
            }
            if (!isChanged(rows[index - 1])) hunk += 1;
            const body = row.type === 'del'
                ? `<del class="agent-center-global-diff-del">${escapeHtml(row.text)}</del>`
                : `<ins class="agent-center-global-diff-ins">${escapeHtml(row.text)}</ins>`;
            const actions = !isChanged(rows[index + 1])
                ? `<span class="agent-center-global-diff-actions" contenteditable="false">`
                    + `<button type="button" class="agent-center-global-diff-accept" data-global-prompt-accept-hunk="${hunk}" data-global-prompt-hunk-block="${escapeHtml(blockId)}" aria-label="接受此处修改并保存" title="接受此处修改并保存">${diffAcceptSvg}</button>`
                    + `<button type="button" class="agent-center-global-diff-reject" data-global-prompt-reject-hunk="${hunk}" data-global-prompt-hunk-block="${escapeHtml(blockId)}" aria-label="回滚此处修改" title="回滚此处修改">${diffRejectSvg}</button>`
                    + '</span>'
                : '';
            html += `${body}${actions}${newline}`;
        });
        return html;
    }

    renderFocusedGlobalPromptPreview(preview = null) {
        const id = trim(this.globalPromptEditingId);
        const base = this.getGlobalPromptBase(id);
        const draft = this.ensureGlobalPromptDraft(id);
        if (!base || !draft) return '';
        const library = normalizeGlobalSemanticPromptLibrary(this.view.globalPromptLibrary);
        const previewLibrary = {
            ...library,
            blocks: library.blocks.map(block => block.id === id ? { ...block, ...draft } : block),
        };
        const validation = validateGlobalSemanticPromptBlock(draft, {
            library: previewLibrary,
            ignoreBlockId: id,
        });
        const guard = detectGlobalSemanticPromptGuard(draft.content);
        const audit = preview?.audit && typeof preview.audit === 'object' ? preview.audit : {};
        const skipped = Array.isArray(audit.skipped) ? audit.skipped : [];
        const skippedItem = skipped.find(item => item?.id === id) || null;
        const previewScope = this.globalPromptPreviewContext === 'maid' ? 'maid' : 'chat';
        let stateMessage = '';
        if (!draft.enabled) stateMessage = '目前为停用草稿；可编辑预览，但不会注入请求。';
        else if (draft.scope !== previewScope) stateMessage = `适用范围为「${this.globalPromptScopeLabel(draft.scope)}」，与当前预览语境不一致。`;
        else if (guard.blocked) stateMessage = guard.message;
        else if (!validation.ok) stateMessage = validation.message;
        else if (skippedItem) stateMessage = skippedItem.message || skippedItem.reason;
        else stateMessage = `将在「${this.globalPromptAnchorLabel(draft.anchor)}」注入为 system 消息。`;
        const contentModified = this.isGlobalPromptDraftContentModified(id);
        const routeLabels = {
            provider_fc: '示例私聊 · 原生 FC',
            json_terminal: '示例私聊 · JSON 终态',
            legacy_text: '示例私聊 · 传统文本',
            maid_planner: '女仆 · 主规划请求',
        };
        const fallbackRoute = this.globalPromptPreviewContext === 'maid'
            ? 'maid_planner'
            : this.globalPromptPreviewContext === 'private_text'
                ? 'legacy_text'
                : 'provider_fc';
        const route = trim(preview?.route || preview?.request?.phoneReplyTransport?.effectiveMode, fallbackRoute);
        const body = contentModified
            ? `<div class="agent-center-global-preview-editable is-modified" data-global-prompt-preview-editor="${escapeHtml(id)}" spellcheck="false">${this.renderGlobalPromptDiffHtml(base.content, draft.content, id)}</div>`
            : `<div class="agent-center-global-preview-editable" data-global-prompt-preview-editor="${escapeHtml(id)}" contenteditable="plaintext-only" spellcheck="false">${escapeHtml(draft.content)}</div>`;
        return `<div class="agent-center-global-preview-focus">
            <div class="agent-center-global-preview-summary">
                <div class="agent-center-card-head">
                    <div>
                        <div class="agent-center-card-title">${escapeHtml(routeLabels[route] || preview?.label || '语义快照')}</div>
                        <div class="agent-center-card-sub">${this.globalPromptPreviewLoading ? '正在更新语境状态…' : '左右两侧均可编辑；修改会先保留为草稿。'}</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass(contentModified ? 'pending' : 'running'))}">≈ ${validation.estimatedTokens} tok</span>
                </div>
            </div>
            <div class="agent-center-global-preview-block">
                <div class="agent-center-card-head">
                    <div>
                        <strong>${escapeHtml(draft.name || '未命名提示词')}</strong>
                        <div class="agent-center-card-sub">${escapeHtml(stateMessage)}</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass(draft.enabled ? 'running' : 'pending'))}">${escapeHtml(this.globalPromptAnchorLabel(draft.anchor))}</span>
                </div>
                ${body}
            </div>
            ${contentModified ? '<div class="agent-center-card-sub">绿色为新增、红色为删除；每一处可用 ✔ 保存或 × 回滚。点击正文可直接编辑。</div>' : ''}
        </div>`;
    }

    renderGlobalPromptPreview() {
        if (this.globalPromptPage === 'block' && this.globalPromptEditingId) {
            return this.renderFocusedGlobalPromptPreview(this.globalPromptPreview);
        }
        if (this.globalPromptPreviewLoading) {
            return `<div class="agent-center-global-preview-state" role="status">
                <span class="agent-center-global-preview-spinner" aria-hidden="true"></span>
                <span>正在构建零请求预览…</span>
            </div>`;
        }
        const preview = this.globalPromptPreview;
        if (!preview) {
            return `<div class="agent-center-global-preview-state">
                <strong>尚未构建预览</strong>
                <span>从右侧提环打开时会自动构建；修改提示词后可点上方刷新。</span>
            </div>`;
        }
        if (preview.ok === false) {
            return `<div class="agent-center-global-preview-state">
                <strong>暂时无法预览</strong>
                <span>${escapeHtml(preview.message || preview.reason || '请确认当前有可用会话。')}</span>
            </div>`;
        }
        const audit = preview.audit && typeof preview.audit === 'object' ? preview.audit : {};
        const injected = Array.isArray(audit.injected) ? audit.injected : [];
        const skipped = Array.isArray(audit.skipped) ? audit.skipped : [];
        const previewScope = this.globalPromptPreviewContext === 'maid' ? 'maid' : 'chat';
        const previewScopeLabel = previewScope === 'maid' ? '女仆' : '聊天模式';
        const disabledDraftCount = normalizeGlobalSemanticPromptLibrary(this.view.globalPromptLibrary).blocks
            .filter(block => block.scope === previewScope && !block.enabled)
            .length;
        const emptyHint = disabledDraftCount > 0
            ? `当前有 ${disabledDraftCount} 个${previewScopeLabel}草稿尚未启用；勾选「启用此提示词」后会自动保存，再刷新预览。`
            : `这里只显示已启用、适用范围为「${previewScopeLabel}」且通过格式与预算护栏的提示词。`;
        const routeLabels = {
            provider_fc: '示例私聊 · 原生 FC',
            json_terminal: '示例私聊 · JSON 终态',
            legacy_text: '示例私聊 · 传统文本',
            maid_planner: '女仆 · 主规划请求',
        };
        const route = trim(preview.route || preview.request?.phoneReplyTransport?.effectiveMode);
        return `<div class="agent-center-global-preview">
            <div class="agent-center-global-preview-summary">
                <div class="agent-center-card-head">
                    <div>
                        <div class="agent-center-card-title">${escapeHtml(routeLabels[route] || preview.label || route || '语义快照')}</div>
                        <div class="agent-center-card-sub">仅组装本地语义快照，不会发送模型请求。</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass(injected.length ? 'running' : 'pending'))}">≈ ${Number(audit.usedTokens || 0)} tok</span>
                </div>
            </div>
            ${injected.length ? injected.map(block => `
                <div class="agent-center-global-preview-block">
                    <div class="agent-center-card-head">
                        <strong>${escapeHtml(block.name || block.id || '全局提示词')}</strong>
                        <span class="${escapeHtml(statusChipClass('pending'))}">${escapeHtml(this.globalPromptAnchorLabel(block.anchor))}</span>
                    </div>
                    <pre>${escapeHtml(block.content || block.renderedContent || '')}</pre>
                </div>
            `).join('') : `<div class="agent-center-global-preview-state">
                <strong>这个语境没有可注入的全局提示词</strong>
                <span>${escapeHtml(emptyHint)}</span>
            </div>`}
            ${skipped.length ? `<div class="agent-center-global-warning">未注入：${escapeHtml(skipped.map(item => `${item.name || item.id}（${item.message || item.reason}）`).join('；'))}</div>` : ''}
        </div>`;
    }

    globalPromptAnchorLabel(anchor = '') {
        return ({
            semantic_header: '语义层头部',
            after_character: '角色信息之后',
            before_history: '历史之前',
            before_latest_user: '最新用户消息之前',
        })[trim(anchor)] || '语义层头部';
    }

    globalPromptScopeLabel(scope = '') {
        return trim(scope) === 'maid' ? '女仆' : '聊天模式';
    }

    renderGlobalPromptRoot(library, enabledTokens = {}) {
        const draftLibrary = normalizeGlobalSemanticPromptLibrary({
            ...library,
            blocks: library.blocks.map(block => ({
                ...block,
                ...(this.ensureGlobalPromptDraft(block.id) || {}),
            })),
        });
        const cards = library.blocks.map((block, index) => {
            const draft = this.ensureGlobalPromptDraft(block.id) || block;
            const modified = this.isGlobalPromptDraftModified(block.id);
            const validation = validateGlobalSemanticPromptBlock(draft, {
                library: draftLibrary,
                ignoreBlockId: block.id,
            });
            const guard = detectGlobalSemanticPromptGuard(draft.content);
            const excerpt = String(draft.content || '').replace(/\s+/g, ' ').trim();
            const warning = guard.blocked
                ? guard.message
                : ['block_budget_exceeded', 'scope_budget_exceeded'].includes(validation.code)
                    ? validation.message
                    : '';
            return `<article
                class="agent-center-card agent-center-global-card agent-center-global-summary-card${modified ? ' is-modified' : ''}"
                data-global-prompt-card="${escapeHtml(block.id)}"
                data-global-prompt-open="${escapeHtml(block.id)}"
                draggable="true"
                role="button"
                tabindex="0"
                aria-label="编辑${escapeHtml(draft.name || '未命名提示词')}"
            >
                <span class="agent-center-global-drag" title="拖拽排序" aria-label="拖拽排序">⠿</span>
                <div class="agent-center-global-summary-copy">
                    <div class="agent-center-global-summary-title">${escapeHtml(draft.name || '未命名提示词')}</div>
                    <div class="agent-center-global-summary-meta">
                        <span>${escapeHtml(this.globalPromptScopeLabel(draft.scope))}</span>
                        <span>·</span>
                        <span>${escapeHtml(this.globalPromptAnchorLabel(draft.anchor))}</span>
                        <span>·</span>
                        <span>≈ ${validation.estimatedTokens} tok</span>
                        ${modified ? '<span>· 未保存修改</span>' : ''}
                    </div>
                    <div class="agent-center-card-sub">${escapeHtml(excerpt || '尚未填写提示词正文')}</div>
                    ${warning ? `<div class="agent-center-global-warning">${escapeHtml(warning)}；内容会保留为停用草稿。</div>` : ''}
                </div>
                <div class="agent-center-global-summary-actions">
                    <label class="agent-center-global-toggle${draft.enabled ? ' is-enabled' : ''}" title="${draft.enabled ? '停用并保留为草稿' : '启用此提示词'}">
                        <input type="checkbox" data-global-prompt-summary-enabled aria-label="${draft.enabled ? '停用此提示词' : '启用此提示词'}"${draft.enabled ? ' checked' : ''}>
                        <span>${draft.enabled ? '已启用' : '启用此提示词'}</span>
                    </label>
                    ${modified ? `
                        <button type="button" class="agent-center-global-diff-accept" data-global-prompt-accept-draft="${escapeHtml(block.id)}" aria-label="接受全部修改并保存" title="接受全部修改并保存">${diffAcceptSvg}</button>
                        <button type="button" class="agent-center-global-diff-reject" data-global-prompt-reject-draft="${escapeHtml(block.id)}" aria-label="舍弃全部修改" title="舍弃全部修改">${diffRejectSvg}</button>
                    ` : ''}
                    <button type="button" class="agent-center-card-action" data-global-prompt-move="up"${index === 0 ? ' disabled' : ''}>上移</button>
                    <button type="button" class="agent-center-card-action" data-global-prompt-move="down"${index === library.blocks.length - 1 ? ' disabled' : ''}>下移</button>
                    <span class="agent-center-global-open-icon" aria-hidden="true">${ICONS.chevron}</span>
                </div>
            </article>`;
        }).join('');
        return `<div class="agent-center-list">
            <article class="agent-center-card agent-center-global-overview">
                <div class="agent-center-global-toolbar">
                    <div>
                        <div class="agent-center-global-eyebrow">GLOBAL PROMPTS</div>
                        <div class="agent-center-card-title">全局语义提示词库</div>
                        <div class="agent-center-card-sub">每个区块进入二级页编辑；预览与草稿实时联动，只有保存或按 ✔ 才会写入。</div>
                    </div>
                    <div class="agent-center-global-toolbar-group">
                        <button type="button" class="agent-center-card-action" data-global-prompt-import>导入</button>
                        <button type="button" class="agent-center-card-action" data-global-prompt-export>导出</button>
                        <button type="button" class="agent-center-card-action is-primary" data-global-prompt-add>新增块</button>
                    </div>
                </div>
                ${renderChips([
                    { label: `单块上限 ${GLOBAL_SEMANTIC_PROMPT_BLOCK_TOKEN_LIMIT.toLocaleString('zh-CN')} tok` },
                    { label: `聊天 ${Number(enabledTokens.chat || 0)}/${GLOBAL_SEMANTIC_PROMPT_SCOPE_TOKEN_LIMIT} tok` },
                    { label: `女仆 ${Number(enabledTokens.maid || 0)}/${GLOBAL_SEMANTIC_PROMPT_SCOPE_TOKEN_LIMIT} tok` },
                    { label: 'system-only' },
                ])}
            </article>
            ${cards || renderEmpty('还没有全局提示词。新增后会进入区块编辑页。')}
        </div>`;
    }

    renderGlobalPromptBlockEditor(library) {
        const id = trim(this.globalPromptEditingId);
        const base = this.getGlobalPromptBase(id);
        const draft = this.ensureGlobalPromptDraft(id);
        if (!base || !draft) {
            this.globalPromptPage = 'list';
            this.globalPromptEditingId = '';
            return this.renderGlobalPromptRoot(library);
        }
        const draftLibrary = normalizeGlobalSemanticPromptLibrary({
            ...library,
            blocks: library.blocks.map(block => block.id === id ? { ...block, ...draft } : block),
        });
        const validation = validateGlobalSemanticPromptBlock(draft, {
            library: draftLibrary,
            ignoreBlockId: id,
        });
        const guard = detectGlobalSemanticPromptGuard(draft.content);
        const warning = guard.blocked
            ? guard.message
            : ['block_budget_exceeded', 'scope_budget_exceeded'].includes(validation.code)
                ? validation.message
                : '';
        const modified = this.isGlobalPromptDraftModified(id);
        const contentModified = this.isGlobalPromptDraftContentModified(id);
        return `<div class="agent-center-global-block-page" data-global-prompt-card="${escapeHtml(id)}">
            <header class="agent-center-global-block-topbar">
                <button type="button" class="agent-center-global-block-back" data-global-prompt-back>${ICONS.chevron}<span>区块列表</span></button>
                <div class="agent-center-global-block-heading">
                    <strong>${escapeHtml(draft.name || '未命名提示词')}</strong>
                    <span>${modified ? '修改保留在草稿中' : '已与保存版本同步'}</span>
                </div>
                ${modified ? `
                    <button type="button" class="agent-center-global-diff-accept" data-global-prompt-accept-draft="${escapeHtml(id)}" aria-label="接受全部修改并保存" title="接受全部修改并保存">${diffAcceptSvg}</button>
                    <button type="button" class="agent-center-global-diff-reject" data-global-prompt-reject-draft="${escapeHtml(id)}" aria-label="舍弃全部修改" title="舍弃全部修改">${diffRejectSvg}</button>
                ` : ''}
            </header>
            <article class="agent-center-card agent-center-global-block-form">
                <div class="agent-center-global-card-head">
                    <input class="agent-center-global-input" data-global-prompt-field="name" value="${escapeHtml(draft.name)}" aria-label="提示词名称">
                    <span></span>
                    <label class="agent-center-global-toggle${draft.enabled ? ' is-enabled' : ''}" title="${draft.enabled ? '停用并保留为草稿' : '启用此提示词'}">
                        <input type="checkbox" data-global-prompt-field="enabled" aria-label="${draft.enabled ? '停用此提示词' : '启用此提示词'}"${draft.enabled ? ' checked' : ''}>
                        <span>${draft.enabled ? '已启用' : '启用此提示词'}</span>
                    </label>
                </div>
                <div class="agent-center-global-fields">
                    <label class="agent-center-global-field">
                        <span class="agent-center-global-field-label">适用范围</span>
                        <select class="agent-center-global-select" data-global-prompt-field="scope">
                            <option value="chat"${draft.scope === 'chat' ? ' selected' : ''}>聊天模式</option>
                            <option value="maid"${draft.scope === 'maid' ? ' selected' : ''}>女仆</option>
                        </select>
                    </label>
                    <label class="agent-center-global-field">
                        <span class="agent-center-global-field-label">注入位置</span>
                        <select class="agent-center-global-select" data-global-prompt-field="anchor">
                            ${Object.values(GLOBAL_SEMANTIC_PROMPT_ANCHORS).map(anchor => `
                                <option value="${escapeHtml(anchor)}"${draft.anchor === anchor ? ' selected' : ''}>${escapeHtml(this.globalPromptAnchorLabel(anchor))}</option>
                            `).join('')}
                        </select>
                    </label>
                    <div class="agent-center-global-field">
                        <span class="agent-center-global-field-label">消息角色</span>
                        <div class="agent-center-global-readonly">system</div>
                    </div>
                </div>
                <label class="agent-center-global-field">
                    <span class="agent-center-global-field-label">提示词正文</span>
                    <div class="agent-center-global-ta-diffwrap">
                        <div class="agent-center-global-ta-difflayer" aria-hidden="true"><div class="agent-center-global-ta-mirror" data-global-prompt-editor-diff></div></div>
                        <textarea class="agent-center-global-textarea" data-global-prompt-field="content" data-global-prompt-editor-content spellcheck="false" placeholder="补充跨会话通用的语义信息；可用 {{user}}、{{char}} 与时间宏。">${escapeHtml(draft.content)}</textarea>
                    </div>
                </label>
                ${warning ? `<div class="agent-center-global-warning">${escapeHtml(warning)}；保存时会保持停用，不会触发路线降级。</div>` : ''}
                <div class="agent-center-global-block-actions">
                    <span class="agent-center-global-draft-state${modified ? ' is-modified' : ''}" data-global-prompt-draft-state>
                        ${modified ? `有未保存修改${contentModified ? '，右侧可逐处 ✔ / ×' : ''}` : `已保存 · 约 ${validation.estimatedTokens} tok`}
                    </span>
                    <div class="agent-center-card-actions">
                        <button type="button" class="agent-center-card-action" data-global-prompt-reject-draft="${escapeHtml(id)}"${modified ? '' : ' disabled'}>取消修改</button>
                        <button type="button" class="agent-center-card-action is-primary" data-global-prompt-accept-draft="${escapeHtml(id)}"${modified ? '' : ' disabled'}>保存修改</button>
                        <button type="button" class="agent-center-card-action is-danger" data-global-prompt-delete="${escapeHtml(id)}">删除</button>
                    </div>
                </div>
            </article>
        </div>`;
    }

    renderGlobalPromptLibrary() {
        const library = this.syncGlobalPromptBases(this.view.globalPromptLibrary);
        const previewState = ['split', 'full'].includes(this.globalPromptPreviewState)
            ? this.globalPromptPreviewState
            : 'closed';
        const enabledTokens = { chat: 0, maid: 0 };
        library.blocks.forEach((block) => {
            const draft = this.ensureGlobalPromptDraft(block.id) || block;
            if (!draft.enabled) return;
            enabledTokens[draft.scope] = Number(enabledTokens[draft.scope] || 0)
                + estimateGlobalSemanticPromptTokens(draft.content);
        });
        const editorBody = this.globalPromptPage === 'block' && this.globalPromptEditingId
            ? this.renderGlobalPromptBlockEditor(library)
            : this.renderGlobalPromptRoot(library, enabledTokens);
        const focusedPreview = this.globalPromptPage === 'block' && this.globalPromptEditingId;
        return `<div class="agent-center-global-workspace" data-global-prompt-preview-state="${previewState}">
            <section class="agent-center-global-editor" aria-label="全局提示词编辑">
                <div class="agent-center-global-editor-scroll">
                    ${editorBody}
                </div>
                <button
                    type="button"
                    class="agent-center-global-preview-handle agent-center-global-preview-edge"
                    data-global-prompt-preview-open
                    aria-label="展开零请求预览"
                    title="点击展开零请求预览"
                ></button>
            </section>
            <aside
                class="agent-center-global-preview-pane"
                data-global-prompt-preview-pane
                aria-label="全局提示词零请求预览"
                aria-hidden="${previewState === 'closed' ? 'true' : 'false'}"
            >
                <header class="agent-center-global-preview-head">
                    <div class="agent-center-global-preview-head-row">
                        <button type="button" class="agent-center-global-preview-back" data-global-prompt-preview-return>
                            ${ICONS.chevron}<span>返回编辑</span>
                        </button>
                        <div class="agent-center-global-preview-heading">
                            <div class="agent-center-global-preview-title">${focusedPreview ? '区块预览' : '零请求预览'}</div>
                            <div class="agent-center-global-preview-subtitle">${focusedPreview ? '左右均可编辑，并与草稿实时联动' : '只组装语义快照，不消耗模型额度'}</div>
                        </div>
                        <div class="agent-center-global-preview-actions">
                            <button type="button" class="agent-center-global-preview-icon" data-global-prompt-preview title="重新构建" aria-label="重新构建预览">${ICONS.refresh}</button>
                            <button type="button" class="agent-center-global-preview-icon" data-global-prompt-preview-close title="关闭预览" aria-label="关闭预览">${ICONS.close}</button>
                        </div>
                    </div>
                    <label class="agent-center-global-preview-context">
                        <span>预览语境</span>
                        <select class="agent-center-global-select" data-global-prompt-preview-context>
                            <option value="private_fc"${this.globalPromptPreviewContext === 'private_fc' ? ' selected' : ''}>示例私聊 FC</option>
                            <option value="private_text"${this.globalPromptPreviewContext === 'private_text' ? ' selected' : ''}>示例私聊文本</option>
                            <option value="maid"${this.globalPromptPreviewContext === 'maid' ? ' selected' : ''}>女仆</option>
                        </select>
                    </label>
                </header>
                <div class="agent-center-global-preview-scroll" data-global-prompt-preview-body>
                    ${this.renderGlobalPromptPreview()}
                </div>
            </aside>
            <button type="button" class="agent-center-global-preview-handle agent-center-global-preview-expand" data-global-prompt-preview-expand aria-label="展开为覆盖预览" title="点击展开为覆盖预览"></button>
            <button type="button" class="agent-center-global-preview-handle agent-center-global-preview-collapse" data-global-prompt-preview-collapse aria-label="收起预览" title="点击收起预览"></button>
            <button type="button" class="agent-center-global-preview-handle agent-center-global-preview-return" data-global-prompt-preview-return aria-label="返回编辑" title="点击返回编辑"></button>
        </div>`;
    }

    readGlobalPromptCard(card = null) {
        if (!card) return null;
        const read = name => card.querySelector(`[data-global-prompt-field="${name}"]`);
        return {
            id: trim(card.dataset.globalPromptCard),
            name: String(read('name')?.value || ''),
            enabled: read('enabled')?.checked === true,
            scope: String(read('scope')?.value || 'chat'),
            anchor: String(read('anchor')?.value || 'semantic_header'),
            content: String(read('content')?.value || ''),
        };
    }

    async handleGlobalPromptSave(card = null) {
        const block = this.readGlobalPromptCard(card);
        if (!block?.id) return;
        const result = await this.callAction('upsertGlobalSemanticPromptBlock', { block }, null);
        if (!result?.ok) {
            this.notifyError(result?.message || '全局提示词保存失败');
            return;
        }
        if (result.forcedDisabled) {
            globalThis.window?.toastr?.warning?.(result.validation?.message || '这个块已保存为停用草稿');
        } else {
            this.notifySuccess('全局提示词已保存');
        }
        this.resetGlobalPromptPreview();
        await this.refresh();
    }

    applyGlobalPromptMutationResult(result = null, fallbackBlock = null) {
        if (!result?.ok) return null;
        let library = result.library
            ? normalizeGlobalSemanticPromptLibrary(result.library)
            : normalizeGlobalSemanticPromptLibrary(this.view.globalPromptLibrary);
        const fallback = fallbackBlock && typeof fallbackBlock === 'object' ? fallbackBlock : null;
        let saved = result.block ? { ...result.block } : null;
        if (!saved && fallback?.id) {
            saved = library.blocks.find(block => block.id === fallback.id) || { ...fallback };
        }
        if (saved && !library.blocks.some(block => block.id === saved.id)) {
            library = normalizeGlobalSemanticPromptLibrary({
                ...library,
                blocks: [...library.blocks, saved],
            });
        }
        this.view = {
            ...this.view,
            globalPromptLibrary: library,
        };
        if (saved?.id) this.globalPromptBases.set(saved.id, { ...saved });
        return saved;
    }

    async saveGlobalPromptDraft(id = '') {
        const key = trim(id);
        const draft = this.ensureGlobalPromptDraft(key);
        if (!draft || this.globalPromptMutationPending) return false;
        this.globalPromptMutationPending = true;
        try {
            const result = await this.callAction('upsertGlobalSemanticPromptBlock', {
                block: { ...draft, id: key },
            }, null);
            if (!result?.ok) {
                this.notifyError(result?.message || '全局提示词保存失败');
                return false;
            }
            const saved = this.applyGlobalPromptMutationResult(result, draft) || { ...draft };
            this.globalPromptBases.set(key, { ...saved });
            this.globalPromptDrafts.set(key, { ...saved });
            if (result.forcedDisabled) {
                globalThis.window?.toastr?.warning?.(result.validation?.message || '这个块已保存为停用草稿');
            } else {
                this.notifySuccess('全局提示词已保存');
            }
            this.resetGlobalPromptPreview();
            this.render();
            return true;
        } finally {
            this.globalPromptMutationPending = false;
        }
    }

    rejectGlobalPromptDraft(id = '') {
        if (this.globalPromptMutationPending) return false;
        const key = trim(id);
        const base = this.getGlobalPromptBase(key);
        if (!base) return false;
        this.globalPromptDrafts.set(key, { ...base });
        this.updateGlobalPromptPreviewPane();
        this.render();
        return true;
    }

    async acceptGlobalPromptHunk(id = '', hunkIndex = -1) {
        const key = trim(id);
        const index = Number(hunkIndex);
        const base = this.getGlobalPromptBase(key);
        const draft = this.ensureGlobalPromptDraft(key);
        if (!base || !draft || !Number.isFinite(index) || index < 0 || this.globalPromptMutationPending) return false;
        const content = applyPresetBlockHunk(base.content, draft.content, index, 'accept');
        this.globalPromptMutationPending = true;
        try {
            const result = await this.callAction('upsertGlobalSemanticPromptBlock', {
                block: { ...base, id: key, content },
            }, null);
            if (!result?.ok) {
                this.notifyError(result?.message || '这处修改保存失败');
                return false;
            }
            const saved = this.applyGlobalPromptMutationResult(result, { ...base, content }) || { ...base, content };
            this.globalPromptBases.set(key, { ...saved });
            this.globalPromptDrafts.set(key, {
                ...draft,
                enabled: saved.enabled,
            });
            this.notifySuccess('已接受该处修改并保存');
            this.render();
            return true;
        } finally {
            this.globalPromptMutationPending = false;
        }
    }

    rejectGlobalPromptHunk(id = '', hunkIndex = -1) {
        if (this.globalPromptMutationPending) return false;
        const key = trim(id);
        const index = Number(hunkIndex);
        const base = this.getGlobalPromptBase(key);
        const draft = this.ensureGlobalPromptDraft(key);
        if (!base || !draft || !Number.isFinite(index) || index < 0) return false;
        draft.content = applyPresetBlockHunk(base.content, draft.content, index, 'reject');
        this.render();
        return true;
    }

    async handleGlobalPromptEnabledChange(id = '', enabled = false) {
        const key = trim(id);
        const base = this.getGlobalPromptBase(key);
        const draft = this.ensureGlobalPromptDraft(key);
        if (!base || !draft || this.globalPromptMutationPending) return false;
        const requested = enabled === true;
        draft.enabled = requested;
        this.globalPromptMutationPending = true;
        try {
            const result = await this.callAction('upsertGlobalSemanticPromptBlock', {
                block: { ...base, id: key, enabled: requested },
            }, null);
            if (!result?.ok) {
                draft.enabled = base.enabled;
                this.notifyError(result?.message || '启用状态保存失败');
                this.render();
                return false;
            }
            const saved = this.applyGlobalPromptMutationResult(result, { ...base, enabled: requested })
                || { ...base, enabled: requested };
            this.globalPromptBases.set(key, { ...saved });
            draft.enabled = saved.enabled;
            if (result.forcedDisabled) {
                globalThis.window?.toastr?.warning?.(result.validation?.message || '请先补齐有效内容再启用');
            }
            this.resetGlobalPromptPreview();
            this.render();
            return saved.enabled === requested;
        } finally {
            this.globalPromptMutationPending = false;
        }
    }

    async handleGlobalPromptAdd() {
        const name = await this.promptText({
            title: '新增区块',
            placeholder: '区块名称',
            confirmText: '创建',
        });
        if (name === null) return false;
        const finalName = trim(name, '未命名区块');
        const result = await this.callAction('upsertGlobalSemanticPromptBlock', {
            block: {
                name: finalName,
                enabled: false,
                scope: 'chat',
                anchor: 'semantic_header',
                content: '',
            },
        }, null);
        if (!result?.ok) {
            this.notifyError('无法新增全局提示词');
            return false;
        }
        const created = this.applyGlobalPromptMutationResult(result, result.block);
        if (!created?.id) {
            this.notifyError('新增区块缺少识别码');
            return false;
        }
        this.globalPromptBases.set(created.id, { ...created });
        this.globalPromptDrafts.set(created.id, { ...created });
        this.globalPromptEditingId = created.id;
        this.globalPromptPage = 'block';
        this.resetGlobalPromptPreview();
        await this.refresh();
        return true;
    }

    async handleGlobalPromptDelete(card = null) {
        const requestedId = typeof card === 'string'
            ? trim(card)
            : trim(card?.dataset?.globalPromptCard || card?.dataset?.globalPromptDelete);
        const block = this.ensureGlobalPromptDraft(requestedId) || this.getGlobalPromptBase(requestedId) || this.readGlobalPromptCard(card);
        if (!block?.id) return false;
        const confirmed = await this.confirm({
            title: '删除全局提示词',
            message: `确定删除「${block.name || '未命名提示词'}」吗？`,
            confirmText: '删除',
            danger: true,
        });
        if (!confirmed) return false;
        const result = await this.callAction('removeGlobalSemanticPromptBlock', { id: block.id }, null);
        if (!result?.ok) {
            this.notifyError('删除失败');
            return false;
        }
        if (result.library) {
            this.view = {
                ...this.view,
                globalPromptLibrary: normalizeGlobalSemanticPromptLibrary(result.library),
            };
        }
        this.globalPromptBases.delete(block.id);
        this.globalPromptDrafts.delete(block.id);
        if (this.globalPromptEditingId === block.id) {
            this.globalPromptEditingId = '';
            this.globalPromptPage = 'list';
        }
        this.resetGlobalPromptPreview();
        await this.refresh();
        return true;
    }

    async reorderGlobalPromptCards(sourceId = '', targetId = '', placeAfter = false) {
        const ids = normalizeGlobalSemanticPromptLibrary(this.view.globalPromptLibrary).blocks.map(block => block.id);
        const source = trim(sourceId);
        const target = trim(targetId);
        if (!source || !target || source === target) return;
        const next = ids.filter(id => id !== source);
        let index = next.indexOf(target);
        if (index < 0) return;
        if (placeAfter) index += 1;
        next.splice(index, 0, source);
        const result = await this.callAction('reorderGlobalSemanticPromptBlocks', { ids: next }, null);
        if (!result?.ok) this.notifyError('排序保存失败');
        else {
            this.resetGlobalPromptPreview();
            await this.refresh();
        }
    }

    async handleGlobalPromptMove(card = null, direction = '') {
        const id = trim(card?.dataset?.globalPromptCard);
        const ids = normalizeGlobalSemanticPromptLibrary(this.view.globalPromptLibrary).blocks.map(block => block.id);
        const index = ids.indexOf(id);
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
        [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
        const result = await this.callAction('reorderGlobalSemanticPromptBlocks', { ids }, null);
        if (!result?.ok) this.notifyError('排序保存失败');
        else {
            this.resetGlobalPromptPreview();
            await this.refresh();
        }
    }

    async handleGlobalPromptExport() {
        const payload = await this.callAction('exportGlobalSemanticPromptLibrary', undefined, null);
        if (!payload) {
            this.notifyError('全局提示词导出失败');
            return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ok = await this.exportTextFile(
            `${JSON.stringify(payload, null, 2)}\n`,
            `global-semantic-prompts-${stamp}.json`,
            '全局提示词已导出',
        );
        if (ok === false) this.notifyError('全局提示词导出失败');
    }

    async handleGlobalPromptImport() {
        if (typeof document === 'undefined') return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            let payload = null;
            try {
                payload = JSON.parse(await file.text());
            } catch {
                this.notifyError('JSON 文件无法读取');
                return;
            }
            const confirmed = await this.confirm({
                title: '导入全局提示词库',
                message: '导入会替换当前全局提示词库；超出预算或含回复格式的块会保留为停用草稿。',
                confirmText: '导入',
                danger: true,
            });
            if (!confirmed) return;
            const result = await this.callAction('importGlobalSemanticPromptLibrary', { payload }, null);
            if (!result?.ok) {
                this.notifyError(result?.message || '全局提示词导入失败');
                return;
            }
            const warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
            if (warningCount) {
                globalThis.window?.toastr?.warning?.(`已导入；${warningCount} 个块因护栏保持停用`);
            } else {
                this.notifySuccess('全局提示词已导入');
            }
            this.globalPromptPage = 'list';
            this.globalPromptEditingId = '';
            this.globalPromptBases.clear();
            this.globalPromptDrafts.clear();
            if (result.library) {
                this.view = {
                    ...this.view,
                    globalPromptLibrary: normalizeGlobalSemanticPromptLibrary(result.library),
                };
            }
            this.resetGlobalPromptPreview();
            await this.refresh();
        }, { once: true });
        input.click();
    }

    resetGlobalPromptPreview({ close = false } = {}) {
        this.globalPromptPreviewRequestId += 1;
        this.globalPromptPreviewLoading = false;
        this.globalPromptPreview = null;
        if (close) this.globalPromptPreviewState = 'closed';
    }

    isGlobalPromptPreviewPhoneLayout() {
        try {
            return globalThis.window?.matchMedia?.('(max-width: 899px)')?.matches === true;
        } catch {
            return false;
        }
    }

    setGlobalPromptPreviewState(state = 'closed') {
        const next = ['split', 'full'].includes(state) ? state : 'closed';
        this.globalPromptPreviewState = next;
        const workspace = this.contentElement?.querySelector?.('.agent-center-global-workspace');
        if (!workspace) {
            this.render();
            return;
        }
        workspace.dataset.globalPromptPreviewState = next;
        workspace.querySelector?.('[data-global-prompt-preview-pane]')
            ?.setAttribute?.('aria-hidden', next === 'closed' ? 'true' : 'false');
    }

    openGlobalPromptPreview() {
        this.setGlobalPromptPreviewState(this.isGlobalPromptPreviewPhoneLayout() ? 'full' : 'split');
        if (!this.globalPromptPreview && !this.globalPromptPreviewLoading) {
            return this.handleGlobalPromptPreview();
        }
        return null;
    }

    closeGlobalPromptPreview() {
        this.setGlobalPromptPreviewState('closed');
    }

    returnFromGlobalPromptPreview() {
        this.setGlobalPromptPreviewState(this.isGlobalPromptPreviewPhoneLayout() ? 'closed' : 'split');
    }

    scheduleGlobalPromptLivePreview() {
        clearTimeout(this.globalPromptLivePreviewTimer);
        this.globalPromptLivePreviewTimer = setTimeout(() => {
            this.globalPromptLivePreviewTimer = null;
            if (this.globalPromptPage !== 'block' || !this.globalPromptEditingId) return;
            this.updateGlobalPromptPreviewPane();
        }, 140);
    }

    updateGlobalPromptDraftUi() {
        const id = trim(this.globalPromptEditingId);
        if (!id || !this.contentElement) return;
        const modified = this.isGlobalPromptDraftModified(id);
        const contentModified = this.isGlobalPromptDraftContentModified(id);
        const state = this.contentElement.querySelector?.('[data-global-prompt-draft-state]');
        if (state) {
            state.classList?.toggle?.('is-modified', modified);
            state.textContent = modified
                ? `有未保存修改${contentModified ? '，右侧可逐处 ✔ / ×' : ''}`
                : `已保存 · 约 ${estimateGlobalSemanticPromptTokens(this.ensureGlobalPromptDraft(id)?.content || '')} tok`;
        }
        this.contentElement.querySelectorAll?.(`[data-global-prompt-accept-draft="${id}"], [data-global-prompt-reject-draft="${id}"]`)
            ?.forEach?.(button => { button.disabled = !modified; });
        const draft = this.ensureGlobalPromptDraft(id);
        const heading = this.contentElement.querySelector?.('.agent-center-global-block-heading strong');
        const sub = this.contentElement.querySelector?.('.agent-center-global-block-heading span');
        if (heading && draft) heading.textContent = draft.name || '未命名提示词';
        if (sub) sub.textContent = modified ? '修改保留在草稿中' : '已与保存版本同步';
    }

    updateGlobalPromptTextareaDiffLayer(textarea = null) {
        const editor = textarea || this.contentElement?.querySelector?.('[data-global-prompt-editor-content]');
        const mirror = this.contentElement?.querySelector?.('[data-global-prompt-editor-diff]');
        const base = this.getGlobalPromptBase(this.globalPromptEditingId);
        if (!editor || !mirror || !base) return false;
        const value = String(editor.value ?? '');
        if (!presetBlockContentChanged(base.content, value)) {
            mirror.innerHTML = '';
            mirror.style.transform = '';
            return true;
        }
        const { rows } = buildLineDiff(base.content, value, { collapseContext: false });
        mirror.innerHTML = rows.map((row) => {
            if (row.type === 'del') return '<div class="agent-center-global-ta-delmark"></div>';
            return `<div class="agent-center-global-ta-line${row.type === 'add' ? ' agent-center-global-ta-add' : ''}">${escapeHtml(row.text) || '&#8203;'}</div>`;
        }).join('');
        if (Number(editor.clientWidth) > 0) mirror.style.width = `${editor.clientWidth}px`;
        mirror.style.transform = `translate(${-Number(editor.scrollLeft || 0)}px, ${-Number(editor.scrollTop || 0)}px)`;
        return true;
    }

    setGlobalPromptScrollSource(source = '') {
        clearTimeout(this.globalPromptScrollReleaseTimer);
        this.globalPromptScrollSource = source;
        this.globalPromptScrollReleaseTimer = setTimeout(() => {
            this.globalPromptScrollSource = '';
            this.globalPromptScrollReleaseTimer = null;
        }, 140);
    }

    syncGlobalPromptPreviewToEditorScroll(textarea = null) {
        const editor = textarea || this.contentElement?.querySelector?.('[data-global-prompt-editor-content]');
        const preview = this.contentElement?.querySelector?.('[data-global-prompt-preview-body]');
        if (!editor || !preview || this.globalPromptPreviewState === 'closed') return false;
        if (this.globalPromptScrollSource === 'preview') return false;
        const editorRange = Math.max(0, Number(editor.scrollHeight || 0) - Number(editor.clientHeight || 0));
        const previewRange = Math.max(0, Number(preview.scrollHeight || 0) - Number(preview.clientHeight || 0));
        if (!editorRange || !previewRange) return false;
        this.setGlobalPromptScrollSource('editor');
        preview.scrollTop = previewRange * Math.max(0, Math.min(1, Number(editor.scrollTop || 0) / editorRange));
        return true;
    }

    syncGlobalPromptEditorToPreviewScroll(preview = null) {
        const pane = preview || this.contentElement?.querySelector?.('[data-global-prompt-preview-body]');
        const editor = this.contentElement?.querySelector?.('[data-global-prompt-editor-content]');
        if (!editor || !pane || this.globalPromptPage !== 'block') return false;
        if (this.globalPromptScrollSource === 'editor') return false;
        const previewRange = Math.max(0, Number(pane.scrollHeight || 0) - Number(pane.clientHeight || 0));
        const editorRange = Math.max(0, Number(editor.scrollHeight || 0) - Number(editor.clientHeight || 0));
        if (!previewRange || !editorRange) return false;
        this.setGlobalPromptScrollSource('preview');
        editor.scrollTop = editorRange * Math.max(0, Math.min(1, Number(pane.scrollTop || 0) / previewRange));
        this.updateGlobalPromptTextareaDiffLayer(editor);
        return true;
    }

    locateGlobalPromptTextOffset(element = null, offset = 0) {
        if (!element || typeof document === 'undefined') return null;
        const target = Math.max(0, Number(offset) || 0);
        const walker = document.createTreeWalker(element, globalThis.NodeFilter?.SHOW_TEXT || 4);
        let consumed = 0;
        let node = walker.nextNode();
        while (node) {
            const length = String(node.textContent || '').length;
            if (target <= consumed + length) return [node, target - consumed];
            consumed += length;
            node = walker.nextNode();
        }
        return null;
    }

    syncGlobalPromptSelectionToPreview(textarea = null) {
        const registry = globalThis.CSS?.highlights;
        const HighlightCtor = globalThis.Highlight;
        if (!registry || !HighlightCtor) return false;
        const clear = () => registry.delete('agent-global-preview-selection');
        const editor = textarea || this.contentElement?.querySelector?.('[data-global-prompt-editor-content]');
        const preview = this.contentElement?.querySelector?.('[data-global-prompt-preview-editor]');
        if (!editor || !preview || preview.textContent !== editor.value) {
            clear();
            return false;
        }
        const start = Number(editor.selectionStart || 0);
        const end = Number(editor.selectionEnd || 0);
        if (end <= start) {
            clear();
            return false;
        }
        const from = this.locateGlobalPromptTextOffset(preview, start);
        const to = this.locateGlobalPromptTextOffset(preview, end);
        if (!from || !to || typeof document === 'undefined') {
            clear();
            return false;
        }
        try {
            const range = document.createRange();
            range.setStart(from[0], from[1]);
            range.setEnd(to[0], to[1]);
            registry.set('agent-global-preview-selection', new HighlightCtor(range));
            return true;
        } catch {
            clear();
            return false;
        }
    }

    enterGlobalPromptPreviewEdit(element = null) {
        const id = trim(element?.getAttribute?.('data-global-prompt-preview-editor'));
        const draft = this.ensureGlobalPromptDraft(id);
        if (!element || !draft) return false;
        element.classList?.add?.('is-editing');
        element.textContent = String(draft.content || '');
        element.setAttribute?.('contenteditable', 'plaintext-only');
        element.setAttribute?.('spellcheck', 'false');
        element.focus?.();
        return true;
    }

    handleGlobalPromptPreviewEdited(element = null) {
        const id = trim(element?.getAttribute?.('data-global-prompt-preview-editor'));
        const draft = this.ensureGlobalPromptDraft(id);
        if (!draft || !element) return false;
        draft.content = String(element.textContent ?? '');
        const textarea = this.contentElement?.querySelector?.('[data-global-prompt-editor-content]');
        if (textarea && textarea.value !== draft.content) textarea.value = draft.content;
        this.updateGlobalPromptTextareaDiffLayer(textarea);
        this.updateGlobalPromptDraftUi();
        return true;
    }

    bindGlobalPromptPreviewEvents(body = null) {
        const preview = body || this.contentElement?.querySelector?.('[data-global-prompt-preview-body]');
        if (!preview || preview.dataset.globalPromptEventsBound === 'true') return;
        preview.dataset.globalPromptEventsBound = 'true';
        preview.addEventListener('input', (event) => {
            const editor = event.target?.closest?.('[data-global-prompt-preview-editor]');
            if (editor) this.handleGlobalPromptPreviewEdited(editor);
        });
        preview.addEventListener('focusout', (event) => {
            const editor = event.target?.closest?.('[data-global-prompt-preview-editor]');
            if (!editor) return;
            editor.classList?.remove?.('is-editing');
            if (this.isGlobalPromptDraftContentModified(editor.getAttribute?.('data-global-prompt-preview-editor'))) {
                this.updateGlobalPromptPreviewPane();
            }
        });
        preview.addEventListener('click', (event) => {
            const accept = event.target?.closest?.('[data-global-prompt-accept-hunk]');
            if (accept) {
                event.preventDefault();
                void this.acceptGlobalPromptHunk(
                    accept.dataset.globalPromptHunkBlock || '',
                    Number(accept.dataset.globalPromptAcceptHunk),
                );
                return;
            }
            const reject = event.target?.closest?.('[data-global-prompt-reject-hunk]');
            if (reject) {
                event.preventDefault();
                this.rejectGlobalPromptHunk(
                    reject.dataset.globalPromptHunkBlock || '',
                    Number(reject.dataset.globalPromptRejectHunk),
                );
                return;
            }
            const editor = event.target?.closest?.('[data-global-prompt-preview-editor].is-modified');
            if (editor && !editor.classList?.contains?.('is-editing')) this.enterGlobalPromptPreviewEdit(editor);
        });
        let scrollTimer = null;
        preview.addEventListener('scroll', () => {
            if (this.globalPromptScrollSource === 'editor' || scrollTimer) return;
            scrollTimer = setTimeout(() => {
                scrollTimer = null;
                this.syncGlobalPromptEditorToPreviewScroll(preview);
            }, 70);
        }, { passive: true });
        ['wheel', 'touchstart', 'pointerdown'].forEach((type) => {
            preview.addEventListener(type, () => {
                if (this.globalPromptScrollSource === 'editor') this.globalPromptScrollSource = '';
            }, { passive: true });
        });
    }

    updateGlobalPromptPreviewPane() {
        const body = this.contentElement?.querySelector?.('[data-global-prompt-preview-body]');
        if (!body) {
            this.render();
            return;
        }
        const range = Math.max(0, Number(body.scrollHeight || 0) - Number(body.clientHeight || 0));
        const ratio = range ? Number(body.scrollTop || 0) / range : 0;
        body.innerHTML = this.renderGlobalPromptPreview();
        this.bindGlobalPromptPreviewEvents(body);
        const restore = () => {
            const nextRange = Math.max(0, Number(body.scrollHeight || 0) - Number(body.clientHeight || 0));
            if (nextRange) body.scrollTop = ratio * nextRange;
        };
        if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(restore);
        else restore();
    }

    async handleGlobalPromptPreview() {
        const select = this.contentElement?.querySelector?.('[data-global-prompt-preview-context]');
        this.globalPromptPreviewContext = trim(select?.value, 'private_fc');
        if (this.globalPromptPreviewState === 'closed') {
            this.setGlobalPromptPreviewState(this.isGlobalPromptPreviewPhoneLayout() ? 'full' : 'split');
        }
        const requestId = ++this.globalPromptPreviewRequestId;
        this.globalPromptPreviewLoading = true;
        this.updateGlobalPromptPreviewPane();
        const result = await this.callAction('previewGlobalSemanticPromptLibrary', {
            context: this.globalPromptPreviewContext,
        }, null);
        if (requestId !== this.globalPromptPreviewRequestId) return null;
        this.globalPromptPreviewLoading = false;
        if (!result) {
            this.notifyError('全局提示词预览失败');
            this.globalPromptPreview = {
                ok: false,
                message: '请确认当前有可用会话后重试。',
            };
            this.updateGlobalPromptPreviewPane();
            return null;
        }
        this.globalPromptPreview = result;
        this.updateGlobalPromptPreviewPane();
        return result;
    }

    bindGlobalPromptLibraryEvents() {
        const root = this.contentElement;
        if (!root) return;
        root.querySelector('[data-global-prompt-add]')?.addEventListener('click', () => this.handleGlobalPromptAdd());
        root.querySelector('[data-global-prompt-export]')?.addEventListener('click', () => this.handleGlobalPromptExport());
        root.querySelector('[data-global-prompt-import]')?.addEventListener('click', () => this.handleGlobalPromptImport());
        root.querySelector('[data-global-prompt-preview]')?.addEventListener('click', () => this.handleGlobalPromptPreview());
        root.querySelectorAll('[data-global-prompt-preview-open]').forEach(button => {
            button.addEventListener('click', () => this.openGlobalPromptPreview());
        });
        root.querySelectorAll('[data-global-prompt-preview-expand]').forEach(button => {
            button.addEventListener('click', () => this.setGlobalPromptPreviewState('full'));
        });
        root.querySelectorAll('[data-global-prompt-preview-collapse], [data-global-prompt-preview-close]').forEach(button => {
            button.addEventListener('click', () => this.closeGlobalPromptPreview());
        });
        root.querySelectorAll('[data-global-prompt-preview-return]').forEach(button => {
            button.addEventListener('click', () => this.returnFromGlobalPromptPreview());
        });
        root.querySelector('[data-global-prompt-preview-context]')?.addEventListener('change', (event) => {
            this.globalPromptPreviewContext = trim(event.target?.value, 'private_fc');
            if (this.globalPromptPreviewState !== 'closed') this.handleGlobalPromptPreview();
        });
        root.querySelector('[data-global-prompt-back]')?.addEventListener('click', () => this.showGlobalPromptList());
        root.querySelectorAll('[data-global-prompt-accept-draft]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void this.saveGlobalPromptDraft(button.dataset.globalPromptAcceptDraft || this.globalPromptEditingId);
            });
        });
        root.querySelectorAll('[data-global-prompt-reject-draft]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                this.rejectGlobalPromptDraft(button.dataset.globalPromptRejectDraft || this.globalPromptEditingId);
            });
        });
        root.querySelectorAll('[data-global-prompt-delete]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void this.handleGlobalPromptDelete(button.dataset.globalPromptDelete || button.closest?.('[data-global-prompt-card]'));
            });
        });
        root.querySelectorAll('[data-global-prompt-open]').forEach((card) => {
            const open = () => this.openGlobalPromptBlockEditor(card.dataset.globalPromptOpen || '');
            card.addEventListener('click', (event) => {
                if (event.target?.closest?.('button, input, label, select, textarea, a')) return;
                open();
            });
            card.addEventListener('keydown', (event) => {
                if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                open();
            });
        });
        root.querySelectorAll('[data-global-prompt-card]').forEach((card) => {
            const id = trim(card.dataset.globalPromptCard);
            card.querySelector('[data-global-prompt-summary-enabled]')?.addEventListener('change', (event) => {
                event.stopPropagation();
                void this.handleGlobalPromptEnabledChange(id, event.target?.checked === true);
            });
            card.querySelector('[data-global-prompt-field="enabled"]')?.addEventListener('change', (event) => {
                void this.handleGlobalPromptEnabledChange(id, event.target?.checked === true);
            });
            card.querySelectorAll('[data-global-prompt-move]').forEach(button => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    void this.handleGlobalPromptMove(card, button.dataset.globalPromptMove);
                });
            });
            card.querySelectorAll('[data-global-prompt-field]:not([data-global-prompt-field="enabled"])').forEach((field) => {
                const update = () => {
                    const name = trim(field.dataset.globalPromptField);
                    if (!name) return;
                    this.updateGlobalPromptDraft(id, { [name]: String(field.value ?? '') });
                    if (name === 'content') this.updateGlobalPromptTextareaDiffLayer(field);
                    this.updateGlobalPromptDraftUi();
                    this.scheduleGlobalPromptLivePreview();
                };
                field.addEventListener(field.matches?.('select') ? 'change' : 'input', update);
            });
            if (card.getAttribute?.('draggable') === 'true') {
                card.addEventListener('dragstart', (event) => {
                    this.globalPromptDragId = trim(card.dataset.globalPromptCard);
                    card.classList.add('is-dragging');
                    try { event.dataTransfer.effectAllowed = 'move'; } catch {}
                });
                card.addEventListener('dragend', () => {
                    this.globalPromptDragId = '';
                    root.querySelectorAll('[data-global-prompt-card]').forEach(item => item.classList.remove('is-dragging', 'is-drag-over'));
                });
                card.addEventListener('dragover', (event) => {
                    if (!this.globalPromptDragId || this.globalPromptDragId === card.dataset.globalPromptCard) return;
                    event.preventDefault();
                    card.classList.add('is-drag-over');
                });
                card.addEventListener('dragleave', () => card.classList.remove('is-drag-over'));
                card.addEventListener('drop', (event) => {
                    event.preventDefault();
                    card.classList.remove('is-drag-over');
                    const rect = card.getBoundingClientRect();
                    const placeAfter = event.clientY > rect.top + (rect.height / 2);
                    void this.reorderGlobalPromptCards(
                        this.globalPromptDragId,
                        card.dataset.globalPromptCard,
                        placeAfter,
                    );
                });
            }
        });
        const textarea = root.querySelector('[data-global-prompt-editor-content]');
        if (textarea) {
            this.updateGlobalPromptTextareaDiffLayer(textarea);
            let scrollTimer = null;
            textarea.addEventListener('scroll', () => {
                this.updateGlobalPromptTextareaDiffLayer(textarea);
                if (this.globalPromptScrollSource === 'preview' || scrollTimer) return;
                scrollTimer = setTimeout(() => {
                    scrollTimer = null;
                    this.syncGlobalPromptPreviewToEditorScroll(textarea);
                }, 70);
            }, { passive: true });
            const syncSelection = () => this.syncGlobalPromptSelectionToPreview(textarea);
            ['click', 'keyup', 'mouseup', 'select'].forEach(type => textarea.addEventListener(type, syncSelection));
            ['wheel', 'touchstart', 'pointerdown'].forEach(type => {
                textarea.addEventListener(type, () => {
                    if (this.globalPromptScrollSource === 'preview') this.globalPromptScrollSource = '';
                }, { passive: true });
            });
        }
        this.bindGlobalPromptPreviewEvents();
    }

    renderSafety() {
        const safety = this.view.safety || {};
        const gate = safety.sessionGate || {};
        const provider = safety.providerTools || {};
        const policy = safety.continuationCommitPolicy || {};
        const gateEnabled = gate.enabled === true;
        const writePreview = gate.writePreviewTools || {};
        const writePreviewEnabled = writePreview.enabled === true;
        const defaultStrategy = normalizeContinuationCommitStrategy(policy.defaultStrategy);
        return `<div class="agent-center-list">
            <article class="agent-center-card">
                <div class="agent-center-card-head">
                    <div>
                        <div class="agent-center-card-title">当前会话 Agent 工具</div>
                        <div class="agent-center-card-sub">${escapeHtml(gateEnabled ? 'AI 可以请求已允许的工具，执行前仍会让你确认。' : 'AI 现在不会执行工具请求。')}</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass(gateEnabled ? 'running' : 'denied'))}">${escapeHtml(gateEnabled ? '已开启' : '已关闭')}</span>
                </div>
                <div class="agent-center-card-sub">开启后仍不会自动继续生成，也不会直接写聊天正文。</div>
                ${renderChips([
                    { label: gate.networkAllowed ? '允许联网继续' : '不会联网继续' },
                    { label: gate.realRunnerAllowed ? '允许真实继续生成' : '不会自动继续生成' },
                    { label: gate.writesChat ? '可写聊天' : '不会自动写聊天' },
                    ...list(gate.allowedTools).map(tool => ({ label: displayToolName(tool) })),
                ])}
                <div class="agent-center-card-sub">记忆/变量/世界书预览：${escapeHtml(writePreviewEnabled ? 'AI 可以请求预览' : 'AI 现在看不到这些预览工具')}。提交仍需要你手动确认。</div>
                ${renderChips([
                    { label: writePreviewEnabled ? '预览工具已加入' : '预览工具未加入', className: statusChipClass(writePreviewEnabled ? 'running' : 'denied') },
                    ...list(writePreview.activeTools).map(tool => ({ label: displayToolName(tool) })),
                ])}
                <div class="agent-center-card-actions">
                    <button
                        type="button"
                        class="agent-center-card-action${gateEnabled ? '' : ' is-primary'}"
                        data-session-gate-action="${escapeHtml(gateEnabled ? 'disable' : 'enable')}"
                    >${escapeHtml(gateEnabled ? '关闭当前会话 Agent 工具' : '开启当前会话 Agent 工具')}</button>
                    <button
                        type="button"
                        class="agent-center-card-action${writePreviewEnabled ? '' : ' is-primary'}"
                        data-write-preview-model-context-action="${escapeHtml(writePreviewEnabled ? 'disable' : 'enable')}"
                    >${escapeHtml(writePreviewEnabled ? '移除预览工具' : '加入预览工具')}</button>
                </div>
            </article>
            ${provider.enabled ? `
                <article class="agent-center-card">
                    <div class="agent-center-card-title">调试入口</div>
                    <div class="agent-center-card-sub">调试入口已开启，只影响开发检查。</div>
                    ${renderChips(list(provider.allowedTools).map(tool => ({ label: displayToolName(tool) })))}
                </article>
            ` : ''}
            <article class="agent-center-card">
                <div class="agent-center-card-head">
                    <div>
                        <div class="agent-center-card-title">继续生成后的处理方式</div>
                        <div class="agent-center-card-sub">工具执行后如需继续生成，仍会先让你确认。</div>
                    </div>
                    <span class="${escapeHtml(statusChipClass('pending'))}">${escapeHtml(continuationCommitStrategyLabel(defaultStrategy))}</span>
                </div>
                <div class="agent-center-card-actions">
                    ${['preview_only', 'append_to_previous_bubble'].map(strategy => `
                        <button
                            type="button"
                            class="agent-center-card-action${defaultStrategy === strategy ? ' is-primary' : ''}"
                            data-continuation-policy-strategy="${escapeHtml(strategy)}"
                        >${escapeHtml(continuationCommitStrategyLabel(strategy))}</button>
                    `).join('')}
                </div>
            </article>
            <article class="agent-center-card">
                <div class="agent-center-card-title">已记住的允许规则</div>
                ${renderPermissionRuleSummary(safety.permissionRuleSummary)}
            </article>
        </div>`;
    }

    bindAgentCardEvents(root = this.contentElement, { onFlip = () => this.toggleFloatingAgentCard(), onClose = () => this.closeFloatingAgentCard(), onPromptPreview = id => this.handleAgentPromptPreview(id) } = {}) {
        if (!root) return;
        root.querySelectorAll('[data-agent-card-open]').forEach((card) => {
            const open = () => this.openFloatingAgentCard(card.dataset.agentCardOpen || '');
            card.addEventListener('click', (event) => {
                const interactive = event.target?.closest?.(AGENT_CARD_INTERACTIVE_SELECTOR);
                if (interactive && interactive !== card) return;
                open();
            });
            card.addEventListener('keydown', (event) => {
                if (event.target !== card) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open();
            });
        });
        root.querySelectorAll('[data-agent-card-action]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                this.handleAgentCardToggle(
                button.dataset.agentCardAction || '',
                button.dataset.agentCardId || '',
                button,
                );
            });
        });
        root.querySelectorAll('[data-agent-resource-open]').forEach((button) => {
            button.addEventListener('click', () => this.handleResourceOpen(button.dataset.agentResourceOpen || ''));
        });
        root.querySelectorAll('[data-agent-prompt-save]').forEach((button) => {
            button.addEventListener('click', () => this.handleAgentPromptSave(
                button.dataset.agentPromptSave || '',
                button,
            ));
        });
        root.querySelectorAll('[data-agent-prompt-open-position]').forEach((button) => {
            button.addEventListener('click', () => {
                void openDefaultAgentResourceTarget({ panel: 'presetPanel', section: 'sysprompt' });
            });
        });
        root.querySelectorAll('[data-memory-agent-save]').forEach((button) => {
            button.addEventListener('click', () => this.handleMemoryAgentSave(button));
        });
        root.querySelectorAll('[data-memory-storage-mode]').forEach((button) => {
            button.addEventListener('click', () => this.handleMemoryStorageMode(button.dataset.memoryStorageMode || 'table'));
        });
        root.querySelectorAll('[data-agent-prompt-preview]').forEach((button) => {
            button.addEventListener('click', () => onPromptPreview(button.dataset.agentPromptPreview || ''));
        });
        root.querySelectorAll('[data-reply-check-preview-target]').forEach((select) => {
            select.addEventListener('change', () => this.handleReplyCheckPreviewTargetChange(select.value || 'auto'));
        });
        root.querySelectorAll('[data-agent-feature-action]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                this.handleAgentFeatureToggle(
                button.dataset.agentFeatureAction || '',
                button.dataset.agentFeatureId || '',
                button,
                );
            });
        });
        root.querySelectorAll('[data-agent-feature-model-override]').forEach((input) => {
            input.addEventListener('change', async () => {
                const id = input.dataset.agentFeatureModelOverride || '';
                const agent = this.getAgentCardById(id);
                if (!agent) return;
                const chosen = input.value.trim();
                const profileModel = (input.dataset.profileModel || '').trim();
                await this.callAgentFeatureMutation('setAgentFeatureModel', {
                    id,
                    modelMode: 'profile',
                    modelProfileId: agent.modelProfileId,
                    // 与配置保存的模型相同 = 维持原样（存空覆盖）
                    modelOverride: chosen && chosen !== profileModel ? chosen : '',
                }, null);
                await this.refresh();
            });
            input.addEventListener('click', event => event.stopPropagation());
        });
        root.querySelectorAll('[data-agent-model-pick]').forEach((btn) => {
            btn.addEventListener('click', async (event) => {
                event.stopPropagation();
                const id = btn.dataset.agentModelPick || '';
                const agent = this.getAgentCardById(id);
                const menu = root?.querySelector?.(`[data-agent-model-menu="${id}"]`);
                const input = root?.querySelector?.(`[data-agent-feature-model-override="${id}"]`);
                if (!agent?.modelProfileId || !menu || !input) return;
                if (!menu.hidden) { menu.hidden = true; menu.innerHTML = ''; return; }
                menu.hidden = false;
                menu.innerHTML = '<div class="agent-center-model-menu-item is-loading">加载模型列表…</div>';
                const models = await this.callAction('listProfileModels', agent.modelProfileId, []);
                if (menu.hidden) return;
                const renderOptions = () => {
                    if (menu.hidden) return;
                    const ranked = rankModelCandidates(models || [], input.value || '');
                    menu.innerHTML = ranked.length
                        ? ranked.map(m => `<button type="button" class="agent-center-model-menu-item" data-model-option="${escapeHtml(String(m))}">${escapeHtml(String(m))}</button>`).join('')
                        : '<div class="agent-center-model-menu-item is-loading">该渠道未返回模型列表，可手动输入</div>';
                    menu.querySelectorAll('[data-model-option]').forEach((option) => {
                        option.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            input.value = option.dataset.modelOption || '';
                            menu.hidden = true;
                            menu.innerHTML = '';
                            input.dispatchEvent(new Event('change', { bubbles: false }));
                        });
                    });
                };
                input.addEventListener('input', renderOptions);
                renderOptions();
            });
        });
        root.querySelectorAll('[data-agent-feature-model-select]').forEach((select) => {
            const id = select.dataset.agentFeatureModelSelect || '';
            const button = Array.from(root.querySelectorAll('[data-agent-feature-model-button]'))
                .find(item => item?.dataset?.agentFeatureModelButton === id);
            bindCustomSelectButton({
                buttonEl: button,
                selectEl: select,
                fallback: '不调用模型',
            });
            select.addEventListener('change', () => this.handleAgentFeatureModelSelect(
                select.dataset.agentFeatureModelSelect || '',
                select.value || '',
                select,
            ));
        });
        root.querySelectorAll('[data-agent-feature-model-manage]').forEach((button) => {
            button.addEventListener('click', () => this.handleAgentFeatureModelManage(button.dataset.agentFeatureModelManage || ''));
        });
        root.querySelectorAll('[data-agent-feature-trigger]').forEach((button) => {
            button.addEventListener('click', () => this.handleAgentFeatureTriggerMode(button.dataset.agentFeatureTrigger || ''));
        });
        root.querySelectorAll('[data-agent-float-flip]').forEach((button) => {
            button.addEventListener('click', onFlip);
        });
        root.querySelectorAll('[data-agent-float-close]').forEach((button) => {
            button.addEventListener('click', onClose);
        });
        root.querySelector('[data-agent-float-layer]')?.addEventListener('click', (event) => {
            if (event.target?.dataset?.agentFloatLayer !== undefined) onClose();
        });
    }

    render() {
        this.renderMeta();
        this.renderTabs();
        if (!this.contentElement) return;
        const editorDrafts = captureAgentEditorDrafts(this.contentElement);
        const globalPromptsActive = this.activeTab === 'global_prompts';
        this.contentElement.classList?.toggle?.('is-global-prompts', globalPromptsActive);
        const error = this.lastError
            ? `<div class="agent-center-error">${escapeHtml(this.lastError)}</div>`
            : '';
        const body = this.activeTab === 'pending'
            ? this.renderPending()
            : this.activeTab === 'agents'
                ? this.renderAgents()
                : this.activeTab === 'prompts'
                    ? this.renderPromptModules()
                    : this.activeTab === 'global_prompts'
                        ? this.renderGlobalPromptLibrary()
                    : this.activeTab === 'diagnostics'
                        ? this.renderDiagnostics()
                        : this.activeTab === 'resources'
                            ? this.renderResources()
                            : this.activeTab === 'activity'
                                ? this.renderActivity()
                                : this.renderSafety();
        this.contentElement.innerHTML = `${error}${body}${this.renderFloatingAgentCard()}`;
        const library = this.contentElement.querySelector('[data-agent-library]');
        library?.addEventListener('toggle', () => { if (library.isConnected) this.agentLibraryOpen = library.open; });
        const boardPanel = this.getHopscotchPanel();
        if (this.activeTab === 'agents' && this.isVisible()) {
            boardPanel?.mount(this.contentElement.querySelector('[data-agent-hopscotch-host]'));
        } else {
            boardPanel?.suspend();
        }
        this.floatingAgentEntryPending = false;
        const enteringList = this.contentElement.querySelector('.agent-center-agent-list.is-entering');
        if (enteringList) {
            clearTimeout(this.cardEntryAnimationTimer);
            this.cardEntryAnimationTimer = setTimeout(() => {
                enteringList.classList?.remove?.('is-entering');
                this.cardEntryAnimationUntil = 0;
                this.cardEntryAnimationTimer = null;
            }, Math.max(0, this.cardEntryAnimationUntil - Date.now()));
        }
        if (this.activeTab === 'pending') {
            this.contentElement.querySelectorAll('[data-profile-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleProfilePendingAction(
                    button.dataset.profileAction || '',
                    button.dataset.pendingId || '',
                ));
            });
            this.contentElement.querySelectorAll('[data-provider-permission-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleProviderPermissionAction(
                    button.dataset.providerPermissionAction || '',
                    button.dataset.pendingId || '',
                ));
            });
            this.contentElement.querySelectorAll('[data-chat-emit-commit-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleChatEmitCommitAction(
                    button.dataset.chatEmitCommitAction || '',
                    button.dataset.pendingId || '',
                ));
            });
            this.contentElement.querySelectorAll('[data-write-preview-commit-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleWritePreviewCommitAction(
                    button.dataset.writePreviewCommitAction || '',
                    button.dataset.pendingId || '',
                ));
            });
        }
        if (this.activeTab === 'activity') {
            this.contentElement.querySelectorAll('[data-activity-status]').forEach((button) => {
                button.addEventListener('click', () => this.setActivityStatus(button.dataset.activityStatus || ''));
            });
            this.contentElement.querySelectorAll('[data-activity-kind]').forEach((button) => {
                button.addEventListener('click', () => this.setActivityKind(button.dataset.activityKind || ''));
            });
            this.contentElement.querySelectorAll('[data-failure-read-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleFailureReadAction());
            });
            this.contentElement.querySelectorAll('[data-agent-run-review-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleAgentRunReviewAction(
                    button.dataset.agentRunReviewAction || '',
                    button.dataset.runId || '',
                ));
            });
        }
        if (this.activeTab === 'resources') {
            this.contentElement.querySelectorAll('[data-resource-open]').forEach((button) => {
                button.addEventListener('click', () => this.handleResourceOpen(button.dataset.resourceOpen || '', {
                    promptId: button.dataset.resourcePromptId || '',
                }));
            });
            this.contentElement.querySelectorAll('[data-resource-pending]').forEach((button) => {
                button.addEventListener('click', () => this.handleResourcePending(button.dataset.resourcePending || ''));
            });
        }
        if (this.activeTab === 'global_prompts') {
            this.bindGlobalPromptLibraryEvents();
        }
        if (['agents', 'prompts', 'diagnostics'].includes(this.activeTab)) {
            this.bindAgentCardEvents();
            restoreAgentEditorDrafts(this.contentElement, editorDrafts);
        }
        this.refreshSharedAgentConfig();
        if (this.activeTab === 'safety') {
            this.contentElement.querySelectorAll('[data-session-gate-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleSessionGateAction(button.dataset.sessionGateAction || ''));
            });
            this.contentElement.querySelectorAll('[data-write-preview-model-context-action]').forEach((button) => {
                button.addEventListener('click', () => this.handleWritePreviewModelContextAction(
                    button.dataset.writePreviewModelContextAction || '',
                ));
            });
            this.contentElement.querySelectorAll('[data-continuation-policy-strategy]').forEach((button) => {
                button.addEventListener('click', () => this.handleContinuationPolicyAction(button.dataset.continuationPolicyStrategy || ''));
            });
        }
    }
}
