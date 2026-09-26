/**
 * Preset panel
 * - Fixed preset manager at the top
 * - Root page lists preset categories as navigation items
 * - Tapping a category pushes into a dedicated detail page
 */

import {
    PRESET_APP_SCOPES,
    PresetStore,
    isPresetEligibleForMode,
    normalizePresetAppScope,
} from '../storage/preset-store.js';
import { appSettings } from '../storage/app-settings.js';
import { t, translateUiText } from '../i18n/index.js';
import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { buildReasoningRequestOptions, getReasoningCapability, getReasoningSamplerPolicy, normalizeReasoningEffort } from '../api/model-capabilities.js';
import { resolveChatStructuredThinkingPreference } from '../agent/provider-fc-transport.js';
import { formatChatStructuredThinkingDisclosure } from './chat/chat-structured-profile-status.js';
import { LLMClient } from '../api/client.js';
import { getPresetParamExclusions } from '../api/request-params.js';
import { canInitClient } from '../api/client-config-utils.js';
import { logger } from '../utils/logger.js';
import { buildBuiltinPhoneFormatReminder } from '../utils/builtin-phone-format-contract.js';
import {
    PHONE_FORMAT_PROMPT_MAX_DEPTH,
    normalizePhoneFormatPromptDepth,
    normalizePhoneFormatPromptPosition,
} from '../utils/phone-format-prompt-placement.js';
import { pickSavePath as pickNativeSavePath } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';
import { appConfirm, appChoice, appPromptText } from './app-confirm.js';
import { buildScriptAuthorizationMessage } from './script-authorization-utils.js';
import { createDragGhost } from './drag-ghost-utils.js';
import {
    buildReasoningEffortComboboxOptions,
    filterReasoningEffortOptions,
    getReasoningEffortOptionLabel,
    resolveReasoningEffortInput,
} from './reasoning-effort-combobox-utils.js';
import { estimateTokens } from '../memory/memory-prompt-utils.js';
import { buildLineDiff } from '../utils/line-diff-utils.js';
import { annotateLineDiffWords, renderWordDiffHtml } from '../utils/word-diff-utils.js';
import {
    applyPresetBlockHunk,
    buildPresetPreviewBlockMap,
    createLatestPreviewBuildQueue,
    isSamePresetData,
    presetBlockContentChanged,
} from './preset-preview-utils.js';
import {
    REGEX_CUSTOM_PROMPT_PRESET_TYPE,
    detachRegexPresetBind,
    resolveImportedRegexPresetBindTarget,
} from './regex-preset-binding-utils.js';
import {
    getActiveConfigProfile,
    getActiveConfigProfileId,
    getBridgeConfig,
    syncChatRuntimeConfigToBridge,
} from './config-runtime-utils.js';
import {
    listRegexLocalSets,
    removeRegexLocalSet,
    upsertRegexLocalSet,
    waitForRegexStoreReady,
} from './regex-store-runtime-utils.js';
import {
    getRegexImportSetName,
    getRegexRuleSignature,
    normalizeRegexScript,
    prepareVersionIsolatedPresetRegexSets,
} from '../utils/regex-transfer.js';
import { getPresetStore } from './preset-store-runtime-utils.js';
import { waitForScriptStoreReady } from './script-runtime-utils.js';
import {
    applyInjectChipTap,
    buildInjectCardDefs,
    buildPresetInjectChipStates,
    buildPreviewInjectFlags,
    describeInjectFeatureBlocker,
    describeMemoryChipBlocker,
    getInjectItem,
    isInjectFeatureEnabled,
    MEMORY_POSITION_OPTIONS,
    PROMPT_POSITION_OPTIONS,
    PROMPT_ROLE_OPTIONS,
    readInjectItemConfig,
    resolveSelectValueWithFallback,
    withCurrentSelectOption,
} from './preset-prompt-inject-utils.js';
/* Section definitions — order matters for rendering */
const SECTIONS = [
    { id: 'custom',       storeType: 'openai',    label: '自定义提示词区块', primary: true },
    { id: 'openai',       storeType: 'openai',    label: '生成参数',        primary: true },
    { id: 'taskprompts',  storeType: 'sysprompt',  label: '任务提示词' },
    { id: 'sysprompt',    storeType: 'sysprompt',  label: '系统提示词' },
    { id: 'context',      storeType: 'context',    label: '上下文模板' },
    { id: 'instruct',     storeType: 'instruct',   label: 'Instruct 模板' },
    { id: 'reasoning',    storeType: 'reasoning',  label: '推理格式' },
];

const EXT_PROMPT_TYPES = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
    SYSTEM_DEPTH_1: 3,
    BEFORE_LATEST_USER: 4,
    AFTER_LATEST_USER: 5,
};

const EXT_PROMPT_ROLES = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

const PHONE_FORMAT_POSITION_OPTIONS = Object.freeze([
    { v: 'after_persona', t: '人设之后' },
    { v: 'system_end', t: '系统提示末尾' },
    { v: 'history_before', t: '历史之前（默认）' },
    { v: 'history_depth', t: '历史深度' },
]);

const OPENAI_KNOWN_BLOCKS = {
    main: { label: 'Main Prompt', marker: false },
    nsfw: { label: 'Auxiliary Prompt', marker: false },
    dialogueExamples: { label: 'Chat Examples', marker: true },
    jailbreak: { label: 'Post-History Instructions', marker: false },
    chatHistory: { label: 'Chat History', marker: true },
    worldInfoAfter: { label: 'World Info (after)', marker: true },
    worldInfoBefore: { label: 'World Info (before)', marker: true },
    enhanceDefinitions: { label: 'Enhance Definitions', marker: false },
    charDescription: { label: 'Char Description', marker: true },
    charPersonality: { label: 'Char Personality', marker: true },
    scenario: { label: 'Scenario', marker: true },
    personaDescription: { label: 'Persona Description', marker: true },
};

const roleIdToName = (role) => {
    const r = String(role || '').toLowerCase();
    if (r === 'system' || r === 'user' || r === 'assistant') return r;
    return 'system';
};

const roleNameToId = (name) => {
    const r = String(name || '').toLowerCase();
    if (r === 'user') return EXT_PROMPT_ROLES.USER;
    if (r === 'assistant') return EXT_PROMPT_ROLES.ASSISTANT;
    return EXT_PROMPT_ROLES.SYSTEM;
};

const deepClone = (v) => {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
};

const getNum = (val, fallback) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
};

const getInt = (val, fallback) => {
    const n = Number(val);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const setValue = (el, val) => { if (el) el.value = (val ?? '').toString(); };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
}[ch]));

const REASONING_EFFORT_LABELS = Object.freeze({
    auto: '自动',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
});

/* ── icons ── */
const chevronRightSvg = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;fill:none;"><polyline points="9 6 15 12 9 18"/></svg>`;
const chevronLeftSvg = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;fill:none;"><polyline points="15 6 9 12 15 18"/></svg>`;
const presetMaximizeSvg = `<svg class="pp-maximize-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <g class="pp-maximize-expand">
        <path class="pp-maximize-icon-depth" d="M9 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25V9M15 4.5h2.75a1.75 1.75 0 0 1 1.75 1.75V9M4.5 15v2.75a1.75 1.75 0 0 0 1.75 1.75H9M19.5 15v2.75a1.75 1.75 0 0 1-1.75 1.75H15"/>
        <path class="pp-maximize-icon-main" d="M9 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25V9M15 4.5h2.75a1.75 1.75 0 0 1 1.75 1.75V9M4.5 15v2.75a1.75 1.75 0 0 0 1.75 1.75H9M19.5 15v2.75a1.75 1.75 0 0 1-1.75 1.75H15"/>
        <path class="pp-maximize-icon-accent" d="m8.2 8.2-2.8-2.8m10.4 2.8 2.8-2.8M8.2 15.8l-2.8 2.8m10.4-2.8 2.8 2.8"/>
    </g>
    <g class="pp-maximize-restore">
        <path class="pp-maximize-icon-depth" d="M9.25 6.25h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-1M14.75 8.75h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5Z"/>
        <path class="pp-maximize-icon-main" d="M9.25 6.25h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-1M14.75 8.75h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5Z"/>
        <path class="pp-maximize-icon-accent" d="M9.25 11.75h4v4"/>
    </g>
</svg>`;
const diffAcceptSvg = `<svg class="pp-diff-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path class="pp-diff-icon-depth" d="m3.9 10.15 4.1 4.05 8.1-8.35"/>
    <path class="pp-diff-icon-mark" d="m3.9 10.15 4.1 4.05 8.1-8.35"/>
</svg>`;
const diffRejectSvg = `<svg class="pp-diff-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path class="pp-diff-icon-depth" d="m5 5 10 10m0-10L5 15"/>
    <path class="pp-diff-icon-mark" d="m5 5 10 10m0-10L5 15"/>
</svg>`;
const panelIconSvg = (body) => `<svg class="pp-nav-item-icon-svg" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const SECTION_ICONS = Object.freeze({
    openai: panelIconSvg('<path d="M4 7h16"/><path d="M7 12h10"/><path d="M10 17h4"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="12" cy="17" r="2"/>'),
    custom: panelIconSvg('<path d="M8 7 4 12l4 5"/><path d="m16 7 4 5-4 5"/><path d="m14 4-4 16"/>'),
    sysprompt: panelIconSvg('<path d="M5 4h14v16H5z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>'),
    chatprompts: panelIconSvg('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8"/><path d="M8 13h5"/>'),
    context: panelIconSvg('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><path d="M8 6v12"/>'),
    instruct: panelIconSvg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
    reasoning: panelIconSvg('<path d="M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3Z"/><path d="M9 20h6"/><path d="M10 16h4"/>'),
});

/* ── CSS ── */
const PANEL_CSS = `
#preset-panel *,
#preset-panel *::before,
#preset-panel *::after { box-sizing: border-box; }

#preset-panel {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    color: var(--app-text-primary);
    --pp-panel-margin: 10px;
    --pp-footer-height: 58px;
}

/* 电脑版：面板不再全出血铺满，居中封顶（left/right 固定 + max-width + margin:auto 即居中） */
@media (min-width: 900px) and (pointer: fine) {
    #preset-panel {
        max-width: 860px;
        margin: 0 auto;
    }
}

/* ── header ── */
.pp-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--app-border-default);
    background: color-mix(in srgb, var(--app-surface-card) 90%, var(--app-surface-subtle));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}
.pp-header-title {
    font-weight: 800;
    color: var(--app-text-primary);
    font-size: 16px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.pp-header-sub { color: var(--app-text-muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.pp-header-actions button {
    border: 1px solid var(--app-border-default); background: var(--app-surface-card); padding: 6px 10px;
    border-radius: 10px; cursor: pointer; font-size: 12px; color: var(--app-text-secondary);
    transition: transform 120ms ease, border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
}
.pp-header-actions button:hover,
.pp-manager-btn:hover,
.pp-binding-btn:hover,
.pp-footer button:hover,
.pp-back-btn:hover,
.pp-nav-item:hover {
    border-color: rgba(var(--app-accent-rgb),0.30);
    box-shadow: 0 6px 16px rgba(15,23,42,0.07);
}
.pp-header-actions button:active,
.pp-manager-btn:active,
.pp-binding-btn:active,
.pp-footer button:active {
    transform: translateY(1px);
    box-shadow: none;
}
.pp-header-actions button:focus-visible,
.pp-manager-btn:focus-visible,
.pp-binding-btn:focus-visible,
.pp-footer button:focus-visible,
.pp-back-btn:focus-visible,
.pp-nav-item:focus-visible,
.pp-input:focus-visible,
.pp-textarea:focus-visible,
.pp-switch input:focus-visible + .pp-switch-track {
    outline: 2px solid rgba(var(--app-accent-rgb),0.34);
    outline-offset: 2px;
}
.pp-close {
    border: none !important; background: transparent !important;
    font-size: 22px !important; color: var(--app-text-primary) !important; padding: 4px 6px !important;
}

/* ── body shell ── */
.pp-shell {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--app-surface-card);
}

.pp-manager {
    padding: 12px 16px 14px;
    border-bottom: 1px solid var(--app-border-default);
    background: color-mix(in srgb, var(--app-surface-card) 92%, var(--app-surface-subtle));
    flex-shrink: 0;
}
.pp-manager-card {
    border: 1px solid rgba(var(--app-accent-rgb),0.18);
    border-radius: 16px;
    background: var(--app-surface-card);
    box-shadow: 0 8px 24px rgba(15,23,42,0.07);
    padding: 12px;
}
.pp-manager-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
}
.pp-manager-title { font-size: 14px; font-weight: 800; color: var(--app-text-primary); }
.pp-manager-sub {
    margin-top: 4px;
    font-size: 12px;
    color: var(--app-text-muted);
    line-height: 1.45;
}
.pp-manager-context {
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 12px;
    background: var(--app-surface-subtle);
    border: 1px solid rgba(var(--app-accent-rgb),0.12);
    font-size: 12px;
    color: var(--app-text-secondary);
    line-height: 1.5;
}
.pp-manager-context strong {
    color: var(--app-text-primary);
}
.pp-enabled-chip {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 999px;
    background: var(--app-surface-subtle);
    border: 1px solid rgba(var(--app-accent-rgb),0.12);
}
.pp-enabled-chip.pp-readonly {
    background: var(--app-surface-subtle, rgba(248,250,252,0.98));
    border-color: rgba(148,163,184,0.28);
}
.pp-enabled-text {
    font-size: 12px;
    font-weight: 700;
    color: var(--app-accent-strong);
}
.pp-enabled-chip.pp-readonly .pp-enabled-text {
    color: var(--app-text-muted);
}
.pp-switch {
    position: relative;
    display: inline-flex;
    width: 42px;
    height: 24px;
    flex-shrink: 0;
}
.pp-switch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    margin: 0;
    cursor: pointer;
}
.pp-switch input:disabled {
    cursor: default;
}
.pp-switch-track {
    width: 100%;
    height: 100%;
    border-radius: 999px;
    background: var(--app-border-strong);
    transition: background 180ms ease;
    position: relative;
}
.pp-switch-track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--app-surface-card);
    box-shadow: 0 1px 2px rgba(15,23,42,0.18);
    transition: transform 180ms ease;
}
.pp-switch input:checked + .pp-switch-track {
    background: var(--app-accent-primary);
}
.pp-switch input:checked + .pp-switch-track::after {
    transform: translateX(18px);
}
.pp-switch input:disabled + .pp-switch-track {
    opacity: 0.72;
}
.pp-enabled-chip.pp-readonly .pp-switch-track {
    background: #d1d5db;
}
.pp-enabled-chip.pp-readonly .pp-switch input:checked + .pp-switch-track {
    background: var(--app-border-strong);
}
.pp-enabled-chip.pp-readonly .pp-switch-track::after {
    background: var(--app-surface-subtle);
    box-shadow: 0 1px 2px rgba(var(--app-tint-slate-rgb),0.22);
}
.pp-manager-select-row {
    display: flex;
    align-items: stretch;
    gap: 10px;
    flex-wrap: wrap;
}
.pp-manager-select-wrap {
    flex: 1 1 220px;
    min-width: 0;
}
.pp-manager-label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--app-text-secondary);
}
.pp-manager-select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    min-height: 42px;
    padding: 10px 12px;
    border: 1px solid var(--app-border-strong);
    border-radius: 12px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font-size: 14px;
}
.pp-manager-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
}
.pp-manager-btn {
    appearance: none;
    -webkit-appearance: none;
    min-height: 36px;
    padding: 8px 12px;
    border: 1px solid var(--app-border-default);
    border-radius: 10px;
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 120ms ease, border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
}
.pp-manager-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.pp-manager-btn.pp-danger {
    border-color: var(--app-danger-border, #fecaca);
    background: var(--app-danger-soft, #fff5f5);
    color: var(--app-danger-text, #b91c1c);
}

/* ── nav pages ── */
.pp-nav-shell {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    position: relative;
}
.pp-pages {
    position: relative;
    width: 100%;
    height: 100%;
    display: block;
}
.pp-page {
    position: absolute;
    inset: 0;
    width: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 120ms ease, transform 120ms ease;
    transform: translateY(4px);
}
.pp-pages[data-view="root"] .pp-page[data-panel-page="root"],
.pp-pages[data-view="detail"] .pp-page[data-panel-page="detail"],
.pp-pages[data-view="bindings"] .pp-page[data-panel-page="bindings"],
.pp-pages[data-view="block"] .pp-page[data-panel-page="block"] {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateY(0);
}

/* 区块拖拽中：原卡变虚线占位（悬浮幽灵由 drag-ghost-utils 跟随指针） */
.pp-block.pp-block-dragging {
    opacity: 0.4;
    border-style: dashed;
    border-color: var(--app-accent-primary);
    background: color-mix(in srgb, var(--app-accent-primary) 6%, var(--app-surface-card));
}

/* 二级（detail/bindings）与三级（block）页：隐藏上方「预设方案」区，给编辑内容让出最大空间 */
#preset-panel[data-view="detail"] .pp-manager,
#preset-panel[data-view="bindings"] .pp-manager,
#preset-panel[data-view="block"] .pp-manager {
    display: none;
}

/* 区块搜索：范围切换（全部/标题/正文）与命中样式 */
.pp-search-scope {
    display: inline-flex;
    border: 1px solid var(--app-border-default);
    border-radius: 10px;
    overflow: hidden;
}
.pp-search-scope button {
    padding: 6px 10px;
    border: none;
    background: var(--app-surface-subtle);
    color: var(--app-text-secondary);
    font-size: 12px;
    cursor: pointer;
}
.pp-search-scope button + button {
    border-left: 1px solid var(--app-border-default);
}
.pp-search-scope button.is-active {
    background: var(--app-accent-soft, rgba(var(--app-accent-rgb), 0.14));
    color: var(--app-accent-strong, var(--app-accent-primary));
    font-weight: 700;
}
/* 注入选择条：连体分段胶囊（记忆表格/私聊/群聊/聊天记录/图片/动态发布） */
.pp-inject-bar {
    display: inline-flex;
    align-items: stretch;
    max-width: 100%;
    margin: 0 0 8px;
    border: 1px solid var(--app-border-default);
    border-radius: 999px;
    background: var(--app-surface-subtle);
    overflow-x: auto;
    scrollbar-width: none;
}
.pp-inject-bar::-webkit-scrollbar { display: none; }
.pp-inject-chip {
    appearance: none;
    border: none;
    background: transparent;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--app-text-muted);
    cursor: pointer;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: background 0.18s ease, color 0.18s ease;
}
.pp-inject-chip + .pp-inject-chip {
    border-left: 1px solid var(--app-border-default);
}
.pp-inject-chip .pp-inject-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0;
    transition: opacity 0.18s ease;
}
.pp-inject-chip.is-on {
    background: var(--app-accent-soft, rgba(var(--app-accent-rgb), 0.12));
    color: var(--app-accent-strong, var(--app-accent-primary));
    font-weight: 600;
}
.pp-inject-chip.is-on .pp-inject-dot { opacity: 1; }
.pp-inject-chip.is-scope-locked {
    opacity: 0.45;
    cursor: not-allowed;
    filter: grayscale(0.4);
}
.pp-inject-chip.is-previewing {
    background: rgba(var(--app-accent-rgb), 0.22);
}
.pp-inject-chip.is-warn .pp-inject-warn {
    color: var(--app-warning-strong, rgba(var(--app-warning-rgb), 0.95));
    font-weight: 700;
    padding: 0 4px;
    margin: -2px -4px -2px -2px;
    cursor: pointer;
}
/* 动态发布焦点预览：其他 chip 隐藏（紧跟隐藏项的分隔线一并去掉） */
.pp-inject-chip.is-hidden { display: none; }
.pp-inject-chip.is-hidden + .pp-inject-chip { border-left: none; }
/* 系统注入卡：由 chip 启用、锚定在组装位置附近，不参与保存/拖拽 */
.pp-block.pp-inject-block {
    background: rgba(var(--app-accent-rgb), 0.04);
    border: 1px dashed rgba(var(--app-accent-rgb), 0.35);
}
.pp-block.pp-inject-block .pp-block-header { cursor: pointer; }

.pp-block-title mark,
.pp-block-hit mark {
    background: var(--app-accent-soft, rgba(var(--app-accent-rgb), 0.18));
    color: var(--app-accent-strong, var(--app-accent-primary));
    border-radius: 3px;
    padding: 0 1px;
    font-weight: 700;
}
.pp-block-hit {
    padding: 6px 12px 10px;
    font-size: 12px;
    color: var(--app-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
/* 搜索过滤中隐藏拖拽柄：过滤视图下重排易误跨隐藏区块 */
#openai-blocks[data-filtering="1"] .pp-block-drag {
    display: none;
}

/* 未保存更改指示（footer 左侧 chip + 保存钮注意态） */
.pp-unsaved-chip[hidden] { display: none; }
.pp-unsaved-chip {
    margin-right: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--app-warning-text, #b45309);
}
.pp-unsaved-chip::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: rgba(var(--app-warning-rgb, 245, 158, 11), 0.9);
}
.pp-btn-save.pp-save-attention {
    box-shadow: 0 0 0 2px rgba(var(--app-warning-rgb, 245, 158, 11), 0.35);
}

/* 三级页上下滑切换：拉扯提示胶囊（.pp-page 本身 absolute，已是定位上下文；
   切勿再写 position:relative 覆盖——会让页面脱离 inset:0 而高度塌陷） */
.pp-swipe-hint {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--app-border-default);
    background: var(--app-surface-card);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.14);
    font-size: 12px;
    color: var(--app-text-secondary);
    max-width: 78%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    pointer-events: none;
}
.pp-swipe-hint-prev { top: 56px; }
.pp-swipe-hint-next { bottom: 10px; }
.pp-swipe-hint.is-armed {
    color: var(--app-accent-strong, var(--app-accent-primary));
    border-color: var(--app-accent-primary);
}
#preset-block-editor { will-change: transform; }

/* ── 分栏请求预览 ── */
.pp-main {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    position: relative;
}
.pp-main > .pp-shell { flex: 1 1 auto; min-width: 0; }
.pp-preview-pane {
    position: relative;
    flex: 0 0 0%;
    width: 0;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--app-border-default);
    background: var(--app-surface-subtle);
    transition: flex-basis 300ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
#preset-panel[data-preview="split"] .pp-preview-pane { flex-basis: 46%; }
#preset-panel[data-preview="full"] .pp-preview-pane {
    position: absolute;
    inset: 0;
    z-index: 5;
    flex-basis: auto;
    width: auto;
}
#preset-panel[data-preview="full"] .pp-shell { visibility: hidden; }
.pp-preview-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px 10px 26px;
    border-bottom: 1px solid var(--app-border-default);
    background: var(--app-surface-card);
}
.pp-preview-title { font-weight: 800; font-size: 13px; color: var(--app-text-primary); white-space: nowrap; }
.pp-preview-est { margin-left: 8px; font-weight: 400; font-size: 11px; color: var(--app-text-muted); }
.pp-preview-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.pp-preview-toggle {
    padding: 5px 9px;
    border: 1px solid var(--app-border-default);
    border-radius: 8px;
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    font-size: 12px;
    cursor: pointer;
}
.pp-preview-toggle.is-on {
    background: var(--app-accent-soft, rgba(25, 154, 255, 0.14));
    color: var(--app-accent-strong, var(--app-accent-primary));
    border-color: var(--app-accent-primary);
}
.pp-preview-scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 12px 14px 24px 26px; }
.pp-preview-msg {
    margin-bottom: 12px;
    border: 1px solid var(--app-border-subtle);
    border-radius: 12px;
    background: var(--app-surface-card);
    overflow: hidden;
}
.pp-preview-msg-role {
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 700;
    color: var(--app-text-muted);
    border-bottom: 1px dashed var(--app-border-subtle);
}
.pp-preview-msg-text {
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--app-text-secondary);
}
/* 区块段落无常驻高亮（视觉减负）：联动定位时缓慢闪烁两下后恢复；可编辑段 hover 有极淡提示 */
.pp-prev-block { border-radius: 4px; }
.pp-prev-block[contenteditable]:hover { background: rgba(var(--app-accent-rgb, 25, 154, 255), 0.05); }
.pp-prev-block.pp-prev-flash { animation: pp-prev-flash 1.05s ease-in-out 2; }
@keyframes pp-prev-flash {
    0%, 100% { background: transparent; box-shadow: none; }
    50% {
        background: rgba(var(--app-accent-rgb, 25, 154, 255), 0.18);
        box-shadow: inset 2px 0 0 rgba(var(--app-accent-rgb, 25, 154, 255), 0.6);
    }
}
body[data-reduced-motion='on'] .pp-prev-block.pp-prev-flash {
    animation: none;
    background: rgba(var(--app-accent-rgb, 25, 154, 255), 0.14);
}
/* 预览内可直接编辑（写回草稿）：聚焦时描边提示 */
.pp-prev-block[contenteditable] {
    cursor: text;
    caret-color: var(--app-accent-primary);
    user-select: text;
    -webkit-user-select: text;
}
.pp-prev-block[contenteditable]:focus {
    outline: 1.5px dashed rgba(var(--app-accent-rgb, 25, 154, 255), 0.6);
    outline-offset: 1px;
}
/* 模糊锚定段（宏改写块）：仅参与滚动联动，不可编辑、样式更淡 */
.pp-prev-block.pp-prev-anchor { box-shadow: inset 2px 0 0 rgba(var(--app-accent-rgb, 25, 154, 255), 0.22); background: transparent; }
/* 宏 token：原样显示时的可求值小段（悬停/点按出气泡） */
.pp-macro {
    background: rgba(var(--app-accent-rgb, 25, 154, 255), 0.10);
    border-bottom: 1px dashed rgba(var(--app-accent-rgb, 25, 154, 255), 0.55);
    border-radius: 3px;
    cursor: help;
}
.pp-macro-tip {
    position: fixed;
    z-index: 21500;
    max-width: min(340px, 80vw);
    padding: 8px 10px;
    border: 1px solid var(--app-border-default);
    border-radius: 10px;
    background: var(--app-surface-card);
    color: var(--app-text-primary);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.22);
    pointer-events: none;
}
.pp-macro-tip[data-kind="effect"], .pp-macro-tip[data-kind="script"] { color: var(--app-text-secondary); }
/* diff 色 token：默认挂靠语义状态色（随主题走），可用 --app-diff-*-rgb 定向覆盖 */
#preset-panel {
    --pp-diff-add-rgb: var(--app-diff-add-rgb, var(--app-success-rgb, 46, 160, 67));
    --pp-diff-del-rgb: var(--app-diff-del-rgb, var(--app-danger-rgb, 248, 81, 73));
}
.pp-diff-ins {
    text-decoration: none;
    background: rgba(var(--pp-diff-add-rgb), 0.16);
    box-shadow: inset 2px 0 0 rgba(var(--pp-diff-add-rgb), 0.65);
}
.pp-diff-del {
    text-decoration: line-through;
    background: rgba(var(--pp-diff-del-rgb), 0.14);
    box-shadow: inset 2px 0 0 rgba(var(--pp-diff-del-rgb), 0.6);
    opacity: 0.82;
}
.pp-prev-block.is-modified { cursor: text; }
/* 每处修改旁的快捷操作（无确认；勾=接受该块并保存，叉=舍弃该块草稿） */
.pp-diff-actions { display: inline-flex; gap: 4px; margin: 0 4px; vertical-align: middle; user-select: none; }
.pp-diff-accept, .pp-diff-reject {
    --pp-diff-action-rgb: var(--pp-diff-add-rgb);
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; min-width: 24px; height: 24px; padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    cursor: pointer;
    line-height: 1; position: relative; overflow: visible;
    opacity: 0.84;
    transition: transform 120ms ease, opacity 150ms ease;
}
.pp-diff-accept { color: var(--app-success-text, #15803d); }
.pp-diff-reject {
    --pp-diff-action-rgb: var(--pp-diff-del-rgb);
    color: var(--app-danger-text, #b91c1c);
}
.pp-diff-icon {
    display: block; width: 19px; height: 19px;
    fill: none; stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 1px 2px rgba(var(--pp-diff-action-rgb), 0.22));
    transition: transform 120ms ease;
}
.pp-diff-icon-depth { stroke-width: 4.4; opacity: 0.13; }
.pp-diff-icon-mark { stroke-width: 2.25; }
.pp-diff-accept:hover, .pp-diff-reject:hover {
    transform: translateY(-1px);
    opacity: 1;
}
.pp-diff-accept:hover .pp-diff-icon, .pp-diff-reject:hover .pp-diff-icon { transform: scale(1.06); }
.pp-diff-accept:active, .pp-diff-reject:active { transform: translateY(0) scale(0.94); box-shadow: none; }
.pp-diff-accept:focus-visible, .pp-diff-reject:focus-visible {
    outline: none;
    opacity: 1;
}
.pp-diff-accept:focus-visible .pp-diff-icon, .pp-diff-reject:focus-visible .pp-diff-icon {
    filter: drop-shadow(0 0 3px rgba(var(--app-accent-rgb), 0.48));
}
/* 预览内 hunk 级操作：更小、紧跟修改行尾 */
.pp-preview-msg .pp-diff-actions { margin: 0 0 0 6px; vertical-align: baseline; }
.pp-preview-msg .pp-diff-accept, .pp-preview-msg .pp-diff-reject {
    width: 20px; min-width: 20px; height: 20px;
}
.pp-preview-msg .pp-diff-icon { width: 16px; height: 16px; }
/* 三级页左侧红绿镜像层：textarea 背后按逻辑行铺底色（新增绿、删除处红线） */
.pp-ta-diffwrap { position: relative; }
#preset-panel .pp-ta-diffwrap > .pp-textarea { position: relative; z-index: 1; background: transparent; }
.pp-ta-difflayer {
    position: absolute;
    inset: 1px;
    border-radius: 10px;
    overflow: hidden;
    background: var(--app-surface-card);
    pointer-events: none;
    z-index: 0;
}
.pp-ta-mirror {
    position: absolute;
    top: 0;
    left: 0;
    box-sizing: border-box;
    padding: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    color: transparent;
}
.pp-ta-line { min-height: 1.45em; }
.pp-ta-add {
    background: rgba(var(--pp-diff-add-rgb), 0.15);
    box-shadow: inset 2px 0 0 rgba(var(--pp-diff-add-rgb), 0.6);
}
.pp-ta-delmark { height: 0; border-top: 2px solid rgba(var(--pp-diff-del-rgb), 0.7); }
/* 逐词：改写配对的行整行浅底，具体改动的字词深底 */
.pp-ta-add.is-partial { background: rgba(var(--pp-diff-add-rgb), 0.06); }
.pp-ta-line .wd-ins { text-decoration: none; color: transparent; border-radius: 3px; background: rgba(var(--pp-diff-add-rgb), 0.3); }
.pp-diff-ins.is-partial { background: rgba(var(--pp-diff-add-rgb), 0.06); }
.pp-diff-del.is-partial { background: rgba(var(--pp-diff-del-rgb), 0.05); text-decoration: none; opacity: 1; }
.pp-diff-ins .wd-ins, .pp-diff-del .wd-del { color: inherit; text-decoration: none; border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.pp-diff-ins .wd-ins { background: rgba(var(--pp-diff-add-rgb), 0.26); }
.pp-diff-del .wd-del { background: rgba(var(--pp-diff-del-rgb), 0.24); text-decoration: line-through; }
/* 二级卡片上的快捷操作：仅已修改的卡显示 */
.pp-block .pp-block-quick { display: none; gap: 4px; margin-right: 2px; }
.pp-block.is-modified .pp-block-quick { display: inline-flex; }
.pp-block.is-modified { border-color: rgba(var(--app-warning-rgb, 245, 158, 11), 0.55); }
/* 左侧 textarea 选区 → 预览同步高亮 */
::highlight(pp-preview-sel) { background: rgba(var(--app-accent-rgb, 25, 154, 255), 0.32); }
/* 面板放大占满 */
#preset-panel[data-maximized="1"] {
    top: calc(var(--app-visual-offset-top, 0px) + env(safe-area-inset-top, 0px)) !important;
    left: env(safe-area-inset-left, 0px) !important;
    right: env(safe-area-inset-right, 0px) !important;
    bottom: auto !important;
    height: calc(var(--app-visual-height, 100dvh) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) !important;
    max-height: calc(var(--app-visual-height, 100dvh) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) !important;
    border-radius: 0 !important;
    max-width: none !important;
    margin: 0 !important;
}
#preset-maximize {
    width: 36px;
    height: 30px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in srgb, var(--app-text-secondary) 82%, var(--app-accent-primary));
    border-color: color-mix(in srgb, var(--app-border-default) 78%, var(--app-accent-primary));
    background: color-mix(in srgb, var(--app-surface-card) 94%, var(--app-accent-primary));
}
.pp-maximize-icon {
    display: block;
    width: 20px;
    height: 20px;
    overflow: visible;
    filter: drop-shadow(0 0 2px rgba(var(--app-accent-rgb, 25, 154, 255), 0.22));
}
.pp-maximize-icon-depth,
.pp-maximize-icon-main,
.pp-maximize-icon-accent {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.pp-maximize-icon-depth { stroke: currentColor; stroke-width: 4; opacity: 0.12; }
.pp-maximize-icon-main { stroke: currentColor; stroke-width: 1.65; }
.pp-maximize-icon-accent { stroke: var(--app-accent-primary); stroke-width: 1.15; opacity: 0.82; }
.pp-maximize-expand,
.pp-maximize-restore {
    transform-box: fill-box;
    transform-origin: center;
    transition: opacity 180ms ease, transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
.pp-maximize-restore { opacity: 0; transform: scale(0.72) rotate(-8deg); }
#preset-maximize.is-on .pp-maximize-expand { opacity: 0; transform: scale(0.72) rotate(8deg); }
#preset-maximize.is-on .pp-maximize-restore { opacity: 1; transform: scale(1) rotate(0deg); }
#preset-maximize:hover,
#preset-maximize.is-on {
    color: var(--app-accent-strong, var(--app-accent-primary)) !important;
    border-color: rgba(var(--app-accent-rgb, 25, 154, 255), 0.42);
    background: var(--app-accent-soft, rgba(var(--app-accent-rgb, 25, 154, 255), 0.12));
}
#preset-maximize.is-on .pp-maximize-icon {
    filter: drop-shadow(0 0 3px rgba(var(--app-accent-rgb, 25, 154, 255), 0.38));
}
/* 底部统一批量条（Cursor 式接受全部/全部取消） */
.pp-btn-acceptall, .pp-btn-rejectall {
    padding: 8px 12px; border-radius: 10px; border: 1px solid; cursor: pointer; font-size: 13px;
}
.pp-btn-acceptall {
    border-color: rgba(var(--pp-diff-add-rgb), 0.55);
    background: rgba(var(--pp-diff-add-rgb), 0.12);
    color: var(--app-success-text, #15803d);
}
.pp-btn-rejectall {
    border-color: rgba(var(--pp-diff-del-rgb), 0.5);
    background: rgba(var(--pp-diff-del-rgb), 0.08);
    color: var(--app-danger-text, #b91c1c);
}
.pp-prev-history-chip {
    margin: 10px 0;
    padding: 9px 12px;
    border: 1px dashed var(--app-border-default);
    border-radius: 10px;
    text-align: center;
    color: var(--app-text-muted);
    font-size: 12px;
}
.pp-preview-loading { padding: 30px 12px; text-align: center; color: var(--app-text-muted); font-size: 12px; }
/* 请求预览边缘锚条：按钮本体透明，触控区在视觉之外扩展。 */
.pp-preview-edge,
.pp-pane-handle,
.pp-editor-handle {
    --pp-handle-x: 0%;
    --pp-handle-nudge: 0px;
    --pp-edge-marker-height: var(--pull-handle-anchor-height);
    appearance: none; -webkit-appearance: none;
    position: absolute; top: 50%;
    transform: translate(calc(var(--pp-handle-x) + var(--pp-handle-nudge)), -50%);
    display: none; align-items: center; justify-content: center;
    width: 24px; padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    opacity: var(--pull-handle-rest-opacity);
    cursor: grab;
    transition: opacity 150ms ease, transform 150ms ease;
    touch-action: none; overflow: visible; isolation: isolate;
}
.pp-preview-edge::before,
.pp-pane-handle::before,
.pp-editor-handle::before {
    content: ''; position: absolute; inset: -6px -10px; z-index: 0;
}
.pp-preview-edge::after,
.pp-pane-handle::after,
.pp-editor-handle::after {
    content: '';
    position: absolute;
    left: 50%; top: 50%;
    width: 3px; height: var(--pp-edge-marker-height);
    border-radius: 999px;
    background: linear-gradient(
        to bottom,
        transparent,
        var(--pull-handle-anchor-color) 48%,
        var(--pull-handle-anchor-color) 52%,
        transparent
    );
    opacity: var(--pull-handle-anchor-rest-opacity);
    filter: var(--pull-handle-rest-filter);
    transform: translate(-50%, -50%);
    transition: width 150ms ease, opacity 150ms ease, filter 150ms ease;
    pointer-events: none;
}
.pp-preview-edge:hover,
.pp-pane-handle:hover,
.pp-editor-handle:hover {
    --pp-handle-nudge: var(--pp-handle-nudge-hover, 0px);
    opacity: 1;
}
.pp-preview-edge.is-opaque,
.pp-pane-handle.is-opaque,
.pp-editor-handle.is-opaque {
    opacity: 1;
}
.pp-preview-edge:hover::after,
.pp-pane-handle:hover::after,
.pp-editor-handle:hover::after,
.pp-preview-edge:focus-visible::after,
.pp-pane-handle:focus-visible::after,
.pp-editor-handle:focus-visible::after {
    width: 4px;
    opacity: 1;
    filter: var(--pull-handle-hover-filter);
}
.pp-preview-edge:focus-visible,
.pp-pane-handle:focus-visible,
.pp-editor-handle:focus-visible {
    outline: none;
    --pp-handle-nudge: var(--pp-handle-nudge-hover, 0px);
    opacity: 1;
}
.pp-preview-edge:active,
.pp-pane-handle:active,
.pp-editor-handle:active {
    cursor: grabbing;
}

/* 锚条按拉动方向轻微位移；所在侧与文案继续表达操作方向。 */
.pp-preview-edge,
.pp-pane-handle-expand { --pp-handle-nudge-hover: -2px; }
.pp-pane-handle-collapse,
.pp-editor-handle { --pp-handle-nudge-hover: 2px; }
.pp-preview-edge,
.pp-editor-handle { height: 112px; }
.pp-preview-edge {
    right: 0; z-index: 4; display: flex;
}
#preset-panel[data-preview="split"] .pp-preview-edge,
#preset-panel[data-preview="full"] .pp-preview-edge { display: none; }
/* 分栏提环分居分隔线两侧：左向环在编辑侧，右向环在预览侧。 */
.pp-pane-handle { left: 54%; z-index: 7; height: 56px; --pp-edge-marker-height: 52px; }
#preset-panel[data-preview="split"] .pp-pane-handle { display: flex; }
#preset-panel[data-preview-motion="opening-split"] .pp-pane-handle-collapse {
    opacity: 0;
    pointer-events: none;
}
.pp-pane-handle-expand { --pp-handle-x: -100%; top: calc(50% - 34px); }
.pp-pane-handle-collapse { --pp-handle-x: 0%; top: calc(50% + 34px); }
.pp-editor-handle { left: 0; z-index: 7; }
#preset-panel[data-preview="full"] .pp-editor-handle { display: flex; }
/* 开合过程中只保留贴边移动的主提环；抵达后再交接给目标状态提环。 */
#preset-panel[data-preview-motion="opening-split"] .pp-pane-handle-expand,
#preset-panel[data-preview-motion="expanding-full"] .pp-pane-handle-expand,
#preset-panel[data-preview-motion="returning-split"] .pp-editor-handle,
#preset-panel[data-preview-motion="closing-split"] .pp-pane-handle-collapse,
#preset-panel[data-preview-motion="opening-full"] .pp-preview-edge,
#preset-panel[data-preview-motion="closing-full"] .pp-editor-handle {
    pointer-events: none;
}
#preset-panel[data-preview-motion="expanding-full"] .pp-pane-handle-expand,
#preset-panel[data-preview-motion="closing-split"] .pp-pane-handle-collapse,
#preset-panel[data-preview-motion="opening-full"] .pp-preview-edge,
#preset-panel[data-preview-motion="closing-full"] .pp-editor-handle {
    display: flex;
}
#preset-panel[data-preview-motion="returning-split"] .pp-pane-handle-expand,
#preset-panel[data-preview-motion="expanding-full"] .pp-editor-handle,
#preset-panel[data-preview-motion="opening-full"] .pp-editor-handle,
#preset-panel[data-preview-motion="closing-split"] .pp-preview-edge,
#preset-panel[data-preview-motion="closing-full"] .pp-preview-edge {
    opacity: 0;
    pointer-events: none;
}
body[data-reduced-motion='on'] .pp-preview-edge,
body[data-reduced-motion='on'] .pp-pane-handle,
body[data-reduced-motion='on'] .pp-editor-handle,
body[data-reduced-motion='on'] .pp-diff-accept,
body[data-reduced-motion='on'] .pp-diff-reject,
body[data-reduced-motion='on'] .pp-diff-icon,
body[data-reduced-motion='on'] .pp-maximize-expand,
body[data-reduced-motion='on'] .pp-maximize-restore { animation: none; transition: none; }
body[data-reduced-motion='on'] .pp-preview-edge,
body[data-reduced-motion='on'] .pp-pane-handle,
body[data-reduced-motion='on'] .pp-editor-handle { --pp-handle-nudge: 0px !important; }
body[data-reduced-motion='on'] .pp-preview-edge::after,
body[data-reduced-motion='on'] .pp-pane-handle::after,
body[data-reduced-motion='on'] .pp-editor-handle::after { transition: none !important; }
.pp-block-linked {
    outline: 2px solid rgba(var(--app-accent-rgb, 25, 154, 255), 0.55);
    outline-offset: -2px;
}
.pp-page-scroll {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px 16px;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: pan-y;
}
.pp-detail-topbar {
    padding: 10px 16px 0;
    flex-shrink: 0;
}
.pp-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: transparent;
    color: var(--app-text-link);
    font-size: 14px;
    font-weight: 700;
    padding: 6px 2px;
    cursor: pointer;
}
.pp-back-btn svg { width: 16px; height: 16px; }
.pp-detail-heading {
    margin-top: 8px;
    margin-bottom: 2px;
    font-size: 18px;
    font-weight: 800;
    color: var(--app-text-primary);
    line-height: 1.2;
}
.pp-detail-subheading {
    font-size: 12px;
    color: var(--app-text-muted);
    line-height: 1.45;
}

/* ── root list ── */
.pp-nav-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.pp-nav-item {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    border: 1px solid var(--app-border-default);
    border-radius: 14px;
    background: var(--app-surface-card);
    padding: 14px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    text-align: left;
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(15,23,42,0.045);
    transition: transform 120ms ease, border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
}
.pp-nav-item:active {
    transform: scale(0.995);
}
.pp-nav-item-left {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 10px;
    align-items: center;
}
.pp-nav-item-icon {
    grid-row: 1 / span 2;
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(var(--app-accent-rgb),0.16);
    border-radius: 11px;
    background: rgba(var(--app-accent-rgb),0.09);
    color: var(--app-accent-strong);
    flex-shrink: 0;
}
.pp-nav-item-icon-svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.pp-nav-item-title {
    font-size: 15px;
    font-weight: 800;
    color: var(--app-text-primary);
    line-height: 1.35;
}
.pp-nav-item-sub {
    grid-column: 2;
    font-size: 12px;
    color: var(--app-text-muted);
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.pp-nav-item.pp-disabled .pp-nav-item-title,
.pp-nav-item.pp-disabled .pp-nav-item-sub {
    color: var(--app-text-muted);
}
.pp-nav-item.pp-disabled .pp-nav-item-icon {
    color: var(--app-text-muted);
    border-color: var(--app-border-default);
    background: var(--app-surface-hover);
}
.pp-nav-item-arrow {
    width: 30px;
    height: 30px;
    border-radius: 10px;
    background: var(--app-surface-subtle);
    color: var(--app-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

/* ── binding page ── */
.pp-binding-stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.pp-binding-card {
    border: 1px solid var(--app-border-default);
    border-radius: 14px;
    background: var(--app-surface-card);
    box-shadow: 0 4px 18px rgba(15,23,42,0.04);
    padding: 12px;
}
.pp-binding-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}
.pp-binding-card-title {
    font-size: 14px;
    font-weight: 800;
    color: var(--app-text-primary);
    line-height: 1.35;
}
.pp-binding-card-sub {
    margin-top: 4px;
    font-size: 12px;
    color: var(--app-text-muted);
    line-height: 1.5;
}
.pp-binding-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--app-accent-soft, #eff6ff);
    color: var(--app-accent-strong);
    font-size: 11px;
    font-weight: 800;
    white-space: nowrap;
}
.pp-binding-actions {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}
.pp-binding-btn {
    appearance: none;
    -webkit-appearance: none;
    min-height: 34px;
    padding: 8px 12px;
    border-radius: 10px;
    border: 1px solid var(--app-border-default);
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
.pp-binding-btn.is-primary {
    background: var(--app-accent-soft, #eff6ff);
    border-color: rgba(var(--app-accent-rgb), 0.35);
    color: var(--app-accent-strong);
}
.pp-binding-btn.is-muted {
    background: var(--app-surface-subtle);
    color: var(--app-text-muted);
}
.pp-binding-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.pp-binding-list {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.pp-binding-item {
    border: 1px solid var(--app-border-default);
    border-radius: 12px;
    background: var(--app-surface-subtle);
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}
.pp-binding-item-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.pp-binding-item-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--app-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.pp-binding-item-sub {
    font-size: 12px;
    color: var(--app-text-muted);
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.pp-binding-empty {
    padding: 12px;
    border: 1px dashed var(--app-border-strong);
    border-radius: 14px;
    background: var(--app-surface-subtle);
    font-size: 12px;
    color: var(--app-text-muted);
    line-height: 1.5;
}

/* ── preset scope ── */
.pp-scope-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
    align-items: center;
    gap: 12px 18px;
    margin-bottom: 12px;
    padding: 14px 16px;
    border: 1px solid rgba(var(--app-accent-rgb), 0.18);
    border-radius: 14px;
    background: color-mix(in srgb, var(--app-surface-card) 94%, var(--app-accent-primary) 6%);
    box-shadow: 0 4px 16px rgba(15,23,42,0.045);
    overflow: visible;
}
.pp-scope-card-copy {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 11px;
}
.pp-scope-card-icon {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(var(--app-accent-rgb), 0.18);
    border-radius: 12px;
    background: rgba(var(--app-accent-rgb), 0.10);
    color: var(--app-accent-strong);
}
.pp-scope-card-icon svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.pp-scope-card-text { min-width: 0; }
.pp-scope-card-title {
    display: inline-block;
    margin: 0;
    color: var(--app-text-primary);
    font-size: 14px;
    font-weight: 800;
    line-height: 1.35;
}
.pp-scope-card-sub {
    margin-top: 3px;
    color: var(--app-text-muted);
    font-size: 12px;
    line-height: 1.45;
}
.pp-scope-card-control {
    min-width: 0;
    width: 100%;
}
.pp-scope-card-control .pp-input {
    min-height: 42px;
    background: var(--app-surface-card);
}
.pp-scope-card-note {
    grid-column: 1 / -1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--app-surface-subtle);
    color: var(--app-text-muted);
    font-size: 12px;
    line-height: 1.5;
}
.pp-scope-card-note-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--app-accent-primary);
    opacity: 0.72;
}

/* ── form helpers ── */
.pp-field-label { font-weight: 700; color: var(--app-text-primary); margin-bottom: 6px; font-size: 13px; }
.pp-api-param-excluded {
    display: inline-block; margin: 3px 0 0 6px; padding: 2px 6px; border-radius: 5px;
    font-size: 10px; font-weight: 500; line-height: 1.6; color: var(--app-text-muted);
    background: var(--app-surface-subtle); vertical-align: middle; cursor: help;
}
.pp-textarea {
    width: 100%; min-height: 140px; resize: vertical;
    border: 1px solid var(--app-border-default); border-radius: 11px; padding: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 12px; line-height: 1.45;
    background: var(--app-surface-card); color: var(--app-text-primary); box-sizing: border-box;
}
.pp-input {
    width: 100%; padding: 10px; border: 1px solid var(--app-border-default);
    border-radius: 11px; font-size: 14px; background: var(--app-surface-card); color: var(--app-text-primary);
    transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
}
.pp-input:focus,
.pp-textarea:focus {
    border-color: rgba(var(--app-accent-rgb),0.42);
    box-shadow: 0 0 0 3px rgba(var(--app-accent-rgb),0.10);
    outline: none;
}
.pp-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.pp-row > div { flex: 1; min-width: 140px; }
.pp-flags { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
.pp-flags label {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--app-text-secondary); cursor: pointer;
}
.pp-flags input[type="checkbox"] { width: 16px; height: 16px; }
.pp-reasoning-card {
    margin-top: 12px;
    border: 1px solid rgba(var(--app-accent-rgb),0.18);
    border-radius: 14px;
    background: color-mix(in srgb, var(--app-surface-card) 90%, rgba(var(--app-accent-rgb),0.10));
    padding: 12px;
}
.pp-reasoning-effort-combobox {
    position: relative;
    width: 100%;
}
.pp-reasoning-effort-input {
    padding-right: 40px;
}
.pp-reasoning-effort-toggle {
    position: absolute;
    top: 1px;
    right: 1px;
    bottom: 1px;
    width: 38px;
    border: 0;
    border-left: 1px solid transparent;
    border-radius: 0 10px 10px 0;
    background: transparent;
    color: var(--app-text-muted);
    cursor: pointer;
}
.pp-reasoning-effort-toggle:hover,
.pp-reasoning-effort-toggle:focus-visible {
    background: var(--app-surface-hover);
    color: var(--app-text-primary);
    outline: none;
}
.pp-reasoning-effort-toggle:disabled {
    cursor: default;
    opacity: 0.5;
}
.world-app-select-menu.is-reasoning-effort-menu {
    max-height: min(52vh, 320px);
}
.pp-reasoning-effort-option-copy {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 3px;
}
.pp-reasoning-effort-option-main {
    font-weight: 700;
}
.pp-reasoning-effort-option-sub,
.pp-reasoning-effort-menu-message {
    color: var(--app-text-muted);
    font-size: 11px;
    line-height: 1.4;
}
.world-app-select-item.is-reasoning-effort-create .pp-reasoning-effort-option-main {
    color: var(--app-accent-strong);
}
.pp-reasoning-effort-menu-message {
    padding: 10px;
}

/* ── openai blocks ── */
.pp-block {
    border: 1px solid var(--app-border-default); border-radius: 14px;
    background: var(--app-surface-card); overflow: hidden;
    box-shadow: 0 4px 16px rgba(15,23,42,0.045);
    transition: transform 120ms ease, border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
}
.pp-block:hover {
    border-color: rgba(var(--app-accent-rgb),0.24);
    box-shadow: 0 8px 22px rgba(15,23,42,0.08);
}
.pp-block.is-jump-target {
    border-color: rgba(var(--app-accent-rgb),0.38);
    background: rgba(var(--app-accent-rgb),0.05);
    box-shadow: 0 0 0 3px rgba(var(--app-accent-rgb),0.12);
}
.pp-block-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 11px 12px; background: color-mix(in srgb, var(--app-surface-card) 90%, var(--app-surface-subtle));
    cursor: pointer; user-select: none;
}
.pp-block-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.pp-block-toggle {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: var(--app-surface-subtle);
    color: var(--app-text-muted);
    font-size: 14px;
    user-select: none;
    flex-shrink: 0;
}
.pp-block-drag { font-size: 16px; color: var(--app-text-muted); cursor: grab; user-select: none; }
.pp-block-main { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.pp-block-title { font-weight: 800; color: var(--app-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-block-sub { color: var(--app-text-muted); font-size: 12px; }
.pp-block-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}
.pp-meta-chip {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
}
.pp-meta-chip.is-scope {
    background: rgba(var(--app-accent-rgb),0.10);
    border-color: rgba(var(--app-accent-rgb),0.16);
    color: var(--app-accent-strong);
}
.pp-meta-chip.is-placement {
    background: rgba(148,163,184,0.12);
    border-color: rgba(148,163,184,0.2);
    color: var(--app-text-secondary);
}
.pp-meta-chip.is-dynamic {
    background: rgba(var(--app-warning-rgb),0.12);
    border-color: rgba(var(--app-warning-rgb),0.2);
    color: #b45309;
}
.pp-meta-chip.is-replace {
    background: rgba(var(--app-danger-rgb),0.10);
    border-color: rgba(var(--app-danger-rgb),0.18);
    color: #be123c;
}
.pp-block-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.pp-block-body { padding: 12px; display: none; flex-direction: column; gap: 10px; }
.pp-block.pp-block-disabled { opacity: 0.66; background: var(--app-surface-hover); }
.pp-block.pp-block-disabled .pp-block-header { background: var(--app-border-default); }

/* ── status ── */
.pp-status {
    display: none; padding: 10px 16px;
    font-size: 13px;
    flex-shrink: 0;
}

/* ── footer ── */
.pp-footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 10px;
    padding: 12px 16px; border-top: 1px solid var(--app-border-default);
    flex-shrink: 0;
}

/* ── header fixed ── */
.pp-header { flex-shrink: 0; }
.pp-footer button {
    padding: 10px 18px; border-radius: 10px; cursor: pointer; font-size: 14px;
    transition: transform 120ms ease, border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
}
.pp-btn-cancel { border: 1px solid var(--app-border-default); background: var(--app-surface-subtle); color: var(--app-text-secondary); }
.pp-btn-save { border: none; background: var(--app-accent-primary); color: var(--app-text-inverse); font-weight: 700; }
.pp-btn-save:active { background: var(--app-accent-strong); }

@media (max-width: 520px), (max-height: 720px) {
    #preset-panel {
        --pp-panel-margin: 6px;
        --pp-footer-height: 50px;
        top: calc(var(--app-visual-offset-top, 0px) + var(--pp-panel-margin) + env(safe-area-inset-top, 0px)) !important;
        left: calc(var(--pp-panel-margin) + env(safe-area-inset-left, 0px)) !important;
        right: calc(var(--pp-panel-margin) + env(safe-area-inset-right, 0px)) !important;
        height: calc(var(--app-visual-height, 100dvh) - var(--pp-panel-margin) - var(--pp-panel-margin) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) !important;
        max-height: calc(var(--app-visual-height, 100dvh) - var(--pp-panel-margin) - var(--pp-panel-margin) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) !important;
        border-radius: 10px !important;
    }
    .pp-header {
        padding: 8px 10px;
        min-height: 44px;
        gap: 8px;
    }
    .pp-header-title {
        font-size: 15px;
    }
    .pp-header-sub {
        display: none;
    }
    .pp-header-actions {
        gap: 4px;
    }
    .pp-header-actions button {
        min-height: 32px;
        padding: 4px 7px;
        border-radius: 8px;
    }
    .pp-close {
        font-size: 20px !important;
        padding: 2px 4px !important;
    }
    .pp-manager {
        padding: 8px 10px;
    }
    .pp-manager-card {
        padding: 9px 10px;
        border-radius: 12px;
        box-shadow: none;
    }
    .pp-manager-head {
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }
    .pp-manager-title {
        font-size: 13px;
    }
    .pp-manager-sub,
    .pp-manager-context {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .pp-manager-sub {
        margin-top: 2px;
        line-height: 1.3;
    }
    .pp-manager-context {
        margin-top: 4px;
        padding: 0;
        border: 0 !important;
        background: transparent !important;
        line-height: 1.35;
    }
    body[data-theme-mode='dark'] #preset-panel .pp-manager-context {
        border: 0 !important;
        background: transparent !important;
    }
    .pp-enabled-chip {
        gap: 6px;
        padding: 4px 8px;
    }
    .pp-enabled-text {
        font-size: 11px;
    }
    .pp-switch {
        width: 38px;
        height: 22px;
    }
    .pp-switch-track::after {
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
    }
    .pp-switch input:checked + .pp-switch-track::after {
        transform: translateX(16px);
    }
    .pp-manager-select-row {
        gap: 6px;
    }
    .pp-manager-select-wrap {
        flex-basis: 100%;
    }
    .pp-manager-label {
        display: none;
    }
    .pp-manager-select {
        min-height: 38px;
        padding: 8px 10px;
        border-radius: 10px;
        font-size: 13px;
    }
    .pp-manager-actions {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-top: 6px;
    }
    .pp-manager-btn {
        min-height: 32px;
        padding: 6px 4px;
        border-radius: 8px;
        font-size: 11px;
    }
    .pp-detail-topbar {
        padding: 8px 10px 0;
    }
    .pp-back-btn {
        padding: 3px 0;
        font-size: 13px;
    }
    .pp-detail-heading {
        margin-top: 4px;
        font-size: 16px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .pp-detail-subheading {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .pp-nav-list {
        gap: 8px;
    }
    .pp-nav-item {
        min-height: 52px;
        padding: 10px 12px;
        border-radius: 12px;
    }
    .pp-nav-item-left {
        gap: 3px 8px;
    }
    .pp-nav-item-icon {
        width: 30px;
        height: 30px;
        border-radius: 10px;
    }
    .pp-nav-item-title {
        font-size: 14px;
    }
    .pp-nav-item-arrow {
        width: 26px;
        height: 26px;
        border-radius: 8px;
    }
    .pp-page-scroll {
        padding: 8px 10px max(12px, env(safe-area-inset-bottom, 0px));
    }
    .pp-scope-card {
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        padding: 12px;
        border-radius: 12px;
    }
    .pp-scope-card-control .pp-input {
        min-height: 38px;
    }
    .pp-scope-card-note {
        grid-column: 1;
    }
    .pp-block-header {
        padding: 8px 10px;
    }
    .pp-block-body {
        padding: 8px 10px;
        gap: 8px;
    }
    .pp-row {
        gap: 8px;
        margin-top: 8px;
    }
    .pp-row > div {
        min-width: 128px;
    }
    .pp-input {
        padding: 8px;
        font-size: 13px;
    }
    .pp-textarea {
        min-height: 118px;
        padding: 8px;
    }
    .pp-footer {
        min-height: var(--pp-footer-height);
        padding: 6px 10px calc(6px + env(safe-area-inset-bottom, 0px));
        gap: 8px;
        justify-content: stretch;
    }
    .pp-footer button {
        flex: 1 1 0;
        min-height: 36px;
        padding: 7px 14px;
        border-radius: 9px;
    }
}

@media (max-width: 380px) {
    .pp-manager-actions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

body[data-theme-mode='dark'] #preset-panel .pp-nav-item-icon {
    color: var(--app-accent-primary);
    border-color: rgba(var(--app-accent-rgb), 0.24);
    background: rgba(var(--app-accent-rgb), 0.10);
}

body[data-theme-mode='dark'] #preset-panel .pp-manager-card,
body[data-theme-mode='dark'] #preset-panel .pp-block,
body[data-theme-mode='dark'] #preset-panel .pp-binding-card {
    box-shadow: 0 8px 24px rgba(0,0,0,0.24);
}

:where(body[data-theme-mode='dark'] #preset-panel) :is(.pp-preview-edge, .pp-pane-handle, .pp-editor-handle) {
    opacity: var(--pull-handle-rest-opacity);
}

:where(body[data-theme-mode='dark'] #preset-panel) :is(.pp-preview-edge, .pp-pane-handle, .pp-editor-handle).is-opaque {
    opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
    #preset-panel .pp-preview-edge,
    #preset-panel .pp-pane-handle,
    #preset-panel .pp-editor-handle,
    #preset-panel .pp-preview-edge::after,
    #preset-panel .pp-pane-handle::after,
    #preset-panel .pp-editor-handle::after,
    #preset-panel .pp-diff-accept,
    #preset-panel .pp-diff-reject,
    #preset-panel .pp-diff-icon,
    #preset-panel .pp-maximize-expand,
    #preset-panel .pp-maximize-restore {
        animation: none !important;
        transition: none !important;
    }
    #preset-panel :is(.pp-preview-edge, .pp-pane-handle, .pp-editor-handle) {
        --pp-handle-nudge: 0px !important;
    }
    #preset-panel .pp-page,
    #preset-panel .pp-header-actions button,
    #preset-panel .pp-manager-btn,
    #preset-panel .pp-binding-btn,
    #preset-panel .pp-footer button,
    #preset-panel .pp-nav-item,
    #preset-panel .pp-block,
    #preset-panel .pp-input,
    #preset-panel .pp-textarea {
        transition: none !important;
        transform: none !important;
    }
}

`;

export class PresetPanel {
    constructor({ store = null } = {}) {
        const bridge = typeof window !== 'undefined' ? window.appBridge : null;
        this.store = store || getPresetStore(bridge) || new PresetStore();
        this.previewDiscoveryGuide = null;
        this.element = null;
        this.overlayElement = null;
        this.statusEl = null;
        this.managerEl = null;
        this.pagesEl = null;
        this.rootListEl = null;
        this.detailTitleEl = null;
        this.detailSubtitleEl = null;
        this.detailEditorEl = null;
        this.detailScrollEl = null;
        this.bindingTitleEl = null;
        this.bindingSubtitleEl = null;
        this.bindingEditorEl = null;
        this.bindingScrollEl = null;
        this.currentSectionId = null;
        this.currentPage = 'root';
        this.bindingStoreType = '';
        this.bindingPresetId = '';
        this.pendingOpenOptions = null;
        this.drafts = new Map();
        this.openaiBlockDrafts = new Map();
        this.openaiBlockDraftsScope = '';
        this.openaiBlockBase = new Map();
        this.openaiDeletedBlockIds = new Set();
        this._presetMutationTail = Promise.resolve();
        this._presetMutationPending = 0;
        this._presetMutationBusy = false;
        this.customSelectMenuEl = null;
        this.customSelectMenuCleanup = null;
        this.customSelectMenuAnchor = null;
        this.injectBarEl = null;
        this.openaiBlocksListEl = null;
        this.previewScenario = '';
        this.injectAdded = new Set();
        this.injectStateScope = null;
        this.currentInjectEditor = '';
        this.runtimeContext = {
            chatStore: null,
            contactsStore: null,
            personaStore: null,
            configPanel: null,
            getUiMode: null,
            getTokenCalibration: null,
            promptInject: null,
        };
    }

    setRuntimeContext(context = {}) {
        this.runtimeContext.chatStore = context.chatStore || this.runtimeContext.chatStore || null;
        this.runtimeContext.contactsStore = context.contactsStore || this.runtimeContext.contactsStore || null;
        this.runtimeContext.personaStore = context.personaStore || this.runtimeContext.personaStore || null;
        this.runtimeContext.configPanel = context.configPanel || this.runtimeContext.configPanel || null;
        this.runtimeContext.showScenePromptPreview = typeof context.showScenePromptPreview === 'function'
            ? context.showScenePromptPreview
            : this.runtimeContext.showScenePromptPreview;
        this.runtimeContext.buildScenePromptPreviewRequest = typeof context.buildScenePromptPreviewRequest === 'function'
            ? context.buildScenePromptPreviewRequest
            : this.runtimeContext.buildScenePromptPreviewRequest;
        this.runtimeContext.evalScenePreviewMacro = typeof context.evalScenePreviewMacro === 'function'
            ? context.evalScenePreviewMacro
            : this.runtimeContext.evalScenePreviewMacro;
        this.runtimeContext.getUiMode = typeof context.getUiMode === 'function'
            ? context.getUiMode
            : this.runtimeContext.getUiMode;
        this.runtimeContext.getTokenCalibration = typeof context.getTokenCalibration === 'function'
            ? context.getTokenCalibration
            : this.runtimeContext.getTokenCalibration;
        this.runtimeContext.promptInject = context.promptInject && typeof context.promptInject === 'object'
            ? context.promptInject
            : this.runtimeContext.promptInject;
    }

    getCurrentPresetContext() {
        const sessionId = String(this.runtimeContext.chatStore?.getCurrent?.() || '').trim();
        const uiMode = typeof this.runtimeContext.getUiMode === 'function'
            ? this.runtimeContext.getUiMode()
            : (sessionId.startsWith('rp:') ? 'rp' : 'chat');
        return {
            sessionId,
            uiMode: String(uiMode || '').trim().toLowerCase() === 'rp' ? 'rp' : 'chat',
        };
    }

    getTypeLabel(type) {
        const hit = SECTIONS.find(t => t.id === type);
        return hit?.label || String(type || '');
    }

    getBoundProfileForPreset(preset) {
        const bridge = window.appBridge;
        const draft = this.runtimeContext.configPanel?.getDraftConfig?.({ tab: 'chat' }) || null;
        if (!bridge) return draft;
        const activeId = getActiveConfigProfileId(bridge);
        const profile = getActiveConfigProfile(bridge) || getBridgeConfig(bridge) || null;
        if (!draft) return profile;
        return {
            ...(profile || {}),
            ...draft,
            id: profile?.id || activeId || '',
            name: profile?.name || '当前聊天配置草稿',
        };
    }

    getReasoningCapabilityForPreset(preset) {
        const profile = this.getBoundProfileForPreset(preset) || {};
        const requestReasoning = preset?.request_reasoning === true;
        return {
            provider: String(profile?.provider || '').trim(),
            model: String(profile?.model || '').trim(),
            baseUrl: String(profile?.baseUrl || '').trim(),
            capability: getReasoningCapability({
                provider: profile?.provider,
                model: profile?.model,
                baseUrl: profile?.baseUrl,
            }),
            samplerPolicy: getReasoningSamplerPolicy({
                provider: profile?.provider,
                model: profile?.model,
                baseUrl: profile?.baseUrl,
                requestReasoning,
            }),
        };
    }

    getResolvedPresetInfo(storeType, context = null) {
        return this.store.getResolvedActive(storeType, context || this.getCurrentPresetContext());
    }

    getPresetNameById(storeType, presetId = '') {
        const sid = String(presetId || '').trim();
        if (!sid) return '';
        const list = this.store.list(storeType);
        const hit = list.find((item) => String(item.id || '') === sid);
        return String(hit?.name || sid);
    }

    getBindingSourceLabel(source, mode = 'chat') {
        if (source === 'session') return t('会话绑定');
        if (source === 'mode') {
            if (mode === 'rp') return t('创意写作默认');
            if (mode === 'moments') return t('动态任务默认');
            return t('聊天对话默认');
        }
        return t('全局默认');
    }

    describeResolvedPreset(storeType, context = null) {
        const resolved = this.getResolvedPresetInfo(storeType, context);
        const name = String(resolved?.preset?.name || this.getPresetNameById(storeType, resolved?.presetId) || '').trim();
        if (!name) return '';
        return `${name} · ${this.getBindingSourceLabel(resolved?.source, resolved?.mode)}`;
    }

    buildPresetBindingSessionEntries() {
        const chatStore = this.runtimeContext.chatStore;
        const contactsStore = this.runtimeContext.contactsStore;
        const personaStore = this.runtimeContext.personaStore;
        const sessionIds = Array.isArray(chatStore?.listSessions?.()) ? chatStore.listSessions() : [];
        return sessionIds.map((sid) => {
            const sessionId = String(sid || '').trim();
            if (!sessionId) return null;
            const isRp = sessionId.startsWith('rp:');
            const contact = contactsStore?.getContact?.(sessionId) || null;
            const personaId = isRp ? sessionId.slice(3) : '';
            const persona = personaId ? personaStore?.get?.(personaId) : null;
            const name = (() => {
                if (isRp) {
                    return String(persona?.name || persona?.title || personaId || sessionId).trim() || sessionId;
                }
                return String(contact?.name || sessionId).trim() || sessionId;
            })();
            const meta = (() => {
                if (isRp) return '创意写作';
                if (contact?.isGroup) return '群聊';
                return '聊天室';
            })();
            return {
                id: sessionId,
                name,
                meta,
                group: isRp ? 'rp' : 'chat',
            };
        }).filter(Boolean);
    }

    ensureCustomSelectMenu() {
        if (this.customSelectMenuEl) return this.customSelectMenuEl;
        const menu = document.createElement('div');
        menu.className = 'world-app-select-menu';
        menu.style.display = 'none';
        menu.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(menu);
        this.customSelectMenuEl = menu;
        return menu;
    }

    closeCustomSelectMenu() {
        if (typeof this.customSelectMenuCleanup === 'function') {
            try { this.customSelectMenuCleanup(); } catch {}
        }
        this.customSelectMenuCleanup = null;
        this.customSelectMenuAnchor = null;
        if (this.customSelectMenuEl) {
            this.customSelectMenuEl.style.display = 'none';
            this.customSelectMenuEl.style.visibility = '';
            this.customSelectMenuEl.style.width = '';
            this.customSelectMenuEl.style.minWidth = '';
            this.customSelectMenuEl.style.maxWidth = '';
            this.customSelectMenuEl.innerHTML = '';
            this.customSelectMenuEl.className = 'world-app-select-menu';
            this.customSelectMenuEl.removeAttribute('id');
            this.customSelectMenuEl.removeAttribute('role');
        }
    }

    openCustomSelectMenu({ anchorEl, options = [], currentValue = '', onSelect = null } = {}) {
        if (!anchorEl) return;
        const isSameAnchorOpen =
            this.customSelectMenuAnchor === anchorEl &&
            this.customSelectMenuEl &&
            this.customSelectMenuEl.style.display !== 'none';
        if (isSameAnchorOpen) {
            this.closeCustomSelectMenu();
            return;
        }
        const menu = this.ensureCustomSelectMenu();
        const current = String(currentValue ?? '').trim();
        const opts = Array.isArray(options) ? options : [];
        menu.innerHTML = opts.map((opt) => {
            const value = String(opt?.value ?? '');
            const label = escapeHtml(String(opt?.label ?? value));
            const selected = value === current;
            return `
                <button type="button" class="world-app-select-item ${selected ? 'is-selected' : ''}" data-value="${value.replace(/"/g, '&quot;')}">
                    <span class="world-app-select-item-label">${label}</span>
                    <span class="world-app-select-item-check">${selected ? '✓' : ''}</span>
                </button>
            `;
        }).join('');

        menu.querySelectorAll('.world-app-select-item').forEach((item) => {
            item.addEventListener('click', () => {
                const value = String(item.dataset.value ?? '');
                if (typeof onSelect === 'function') onSelect(value);
                this.closeCustomSelectMenu();
            });
        });

        menu.style.display = 'block';
        menu.style.visibility = 'hidden';
        menu.style.minWidth = `${Math.max(170, Math.round(anchorEl.getBoundingClientRect().width))}px`;
        menu.style.left = '0px';
        menu.style.top = '0px';

        const anchorRect = anchorEl.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const gap = 6;
        let left = anchorRect.left;
        let top = anchorRect.bottom + gap;
        if (left + menuRect.width > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - menuRect.width - 8);
        }
        if (top + menuRect.height > window.innerHeight - 8) {
            top = Math.max(8, anchorRect.top - menuRect.height - gap);
        }
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        menu.style.visibility = 'visible';

        const onDocClick = (ev) => {
            const target = ev?.target;
            if (!target) return;
            if (menu.contains(target) || anchorEl.contains(target)) return;
            this.closeCustomSelectMenu();
        };
        const onResize = () => this.closeCustomSelectMenu();
        const onScroll = (ev) => {
            const target = ev?.target;
            if (target && (menu.contains(target) || anchorEl.contains(target))) return;
            this.closeCustomSelectMenu();
        };
        document.addEventListener('mousedown', onDocClick, true);
        document.addEventListener('touchstart', onDocClick, true);
        window.addEventListener('resize', onResize);
        window.addEventListener('scroll', onScroll, true);
        this.customSelectMenuCleanup = () => {
            document.removeEventListener('mousedown', onDocClick, true);
            document.removeEventListener('touchstart', onDocClick, true);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('scroll', onScroll, true);
        };
        this.customSelectMenuAnchor = anchorEl;
    }

    refreshCustomSelect(selectOrId, root = null) {
        const scope = root || this.element || document;
        const select = typeof selectOrId === 'string'
            ? scope.querySelector(`#${selectOrId}`)
            : selectOrId;
        if (!select) return;
        const button = scope.querySelector(`[data-select-id="${select.id}"]`);
        if (!button) return;
        const labelEl = button.querySelector('.pp-custom-select-label');
        const current = Array.from(select.options || []).find((opt) => opt.value === select.value) || select.options?.[select.selectedIndex] || null;
        if (labelEl) {
            labelEl.textContent = current?.textContent?.trim() || button.dataset.placeholder || '请选择';
        }
    }

    bindCustomSelect(selectId, root = null) {
        const scope = root || this.element || document;
        const select = scope.querySelector(`#${selectId}`);
        const button = scope.querySelector(`[data-select-id="${selectId}"]`);
        if (!select || !button || button.dataset.bound === 'true') return;

        button.dataset.bound = 'true';
        button.addEventListener('click', () => {
            if (button.disabled) return;
            const options = Array.from(select.options || []).map((opt) => ({
                value: opt.value,
                label: opt.textContent || opt.value,
            }));
            this.openCustomSelectMenu({
                anchorEl: button,
                options,
                currentValue: select.value,
                onSelect: (value) => {
                    if (select.value !== value) {
                        select.value = value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        this.refreshCustomSelect(select, scope);
                    }
                },
            });
        });

        select.addEventListener('change', () => this.refreshCustomSelect(select, scope));
        this.refreshCustomSelect(select, scope);
    }

    bindReasoningEffortCombobox({ selectEl, inputEl, toggleEl, options = [], allowCustom = false } = {}) {
        if (!selectEl || !inputEl || !toggleEl || inputEl.dataset.bound === 'true') return;

        const anchorEl = inputEl.closest('.pp-reasoning-effort-combobox') || inputEl;
        const listboxId = `${selectEl.id || 'gen-reasoning-effort'}-listbox`;
        let availableOptions = buildReasoningEffortComboboxOptions(options, selectEl.value);
        let suppressFocusOpen = false;

        inputEl.dataset.bound = 'true';
        inputEl.setAttribute('role', 'combobox');
        inputEl.setAttribute('aria-autocomplete', 'list');
        inputEl.setAttribute('aria-controls', listboxId);
        inputEl.setAttribute('aria-expanded', 'false');
        inputEl.autocomplete = 'off';
        inputEl.spellcheck = false;
        toggleEl.setAttribute('aria-label', '展开推理强度选项');

        const syncInputFromSelect = () => {
            inputEl.value = getReasoningEffortOptionLabel(
                availableOptions,
                selectEl.value,
                selectEl.value,
            );
        };

        const ensureOption = (value, { custom = false } = {}) => {
            const normalizedValue = String(value || '').trim().toLowerCase();
            if (!normalizedValue) return null;
            let option = availableOptions.find((item) => item.value === normalizedValue) || null;
            if (!option && custom) {
                option = {
                    value: normalizedValue,
                    label: `${normalizedValue}（自定义 · 未验证）`,
                    custom: true,
                };
                availableOptions = [...availableOptions, option];
            }
            if (!option) return null;
            let nativeOption = Array.from(selectEl.options || []).find((item) => item.value === normalizedValue) || null;
            if (!nativeOption) {
                nativeOption = document.createElement('option');
                nativeOption.value = normalizedValue;
                selectEl.appendChild(nativeOption);
            }
            nativeOption.textContent = option.label;
            return option;
        };

        availableOptions.forEach((option) => ensureOption(option.value, { custom: option.custom === true }));

        const focusInputWithoutOpening = () => {
            suppressFocusOpen = true;
            inputEl.focus({ preventScroll: true });
            queueMicrotask(() => { suppressFocusOpen = false; });
        };

        const closeMenu = ({ restore = false, focusInput = false } = {}) => {
            if (restore) syncInputFromSelect();
            this.closeCustomSelectMenu();
            if (focusInput) focusInputWithoutOpening();
        };

        const positionMenu = (menu) => {
            if (!menu || menu.style.display === 'none') return;
            const anchorRect = anchorEl.getBoundingClientRect();
            const viewportGap = 8;
            const gap = 6;
            const width = Math.max(170, Math.min(
                Math.round(anchorRect.width),
                Math.max(170, window.innerWidth - viewportGap * 2),
            ));
            menu.style.width = `${width}px`;
            menu.style.minWidth = `${width}px`;
            menu.style.maxWidth = `calc(100vw - ${viewportGap * 2}px)`;
            menu.style.left = '0px';
            menu.style.top = '0px';
            const menuRect = menu.getBoundingClientRect();
            let left = anchorRect.left;
            let top = anchorRect.bottom + gap;
            if (left + menuRect.width > window.innerWidth - viewportGap) {
                left = Math.max(viewportGap, window.innerWidth - menuRect.width - viewportGap);
            }
            if (top + menuRect.height > window.innerHeight - viewportGap) {
                top = Math.max(viewportGap, anchorRect.top - menuRect.height - gap);
            }
            menu.style.left = `${Math.round(left)}px`;
            menu.style.top = `${Math.round(top)}px`;
        };

        const chooseValue = (value, { custom = false, focusInput = true } = {}) => {
            const option = ensureOption(value, { custom });
            if (!option) return false;
            const changed = selectEl.value !== option.value;
            selectEl.value = option.value;
            syncInputFromSelect();
            if (changed) selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            closeMenu({ focusInput });
            return true;
        };

        const renderMenu = (menu, query = '') => {
            menu.innerHTML = '';
            const filteredOptions = filterReasoningEffortOptions(availableOptions, query);
            const resolvedInput = resolveReasoningEffortInput(availableOptions, query);

            const appendOption = (option, { create = false } = {}) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `world-app-select-item${option.value === selectEl.value && !create ? ' is-selected' : ''}${create ? ' is-reasoning-effort-create' : ''}`;
                button.dataset.value = option.value;
                button.setAttribute('role', 'option');
                button.setAttribute('aria-selected', option.value === selectEl.value && !create ? 'true' : 'false');

                const copy = document.createElement('span');
                copy.className = 'pp-reasoning-effort-option-copy';
                const main = document.createElement('span');
                main.className = 'pp-reasoning-effort-option-main';
                main.textContent = create
                    ? `新增：${option.value}`
                    : (option.custom ? option.value : option.label);
                const sub = document.createElement('span');
                sub.className = 'pp-reasoning-effort-option-sub';
                sub.textContent = create || option.custom
                    ? '自定义 · 未验证'
                    : option.value;
                copy.appendChild(main);
                copy.appendChild(sub);
                button.appendChild(copy);

                const check = document.createElement('span');
                check.className = 'world-app-select-item-check';
                check.textContent = option.value === selectEl.value && !create ? '✓' : '';
                button.appendChild(check);

                button.addEventListener('mousedown', (event) => event.preventDefault());
                button.addEventListener('click', () => chooseValue(option.value, { custom: create || option.custom === true }));
                button.addEventListener('keydown', (event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        closeMenu({ restore: true, focusInput: true });
                        return;
                    }
                    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                    event.preventDefault();
                    const buttons = Array.from(menu.querySelectorAll('.world-app-select-item'));
                    const index = buttons.indexOf(button);
                    const nextIndex = event.key === 'ArrowDown'
                        ? Math.min(buttons.length - 1, index + 1)
                        : Math.max(0, index - 1);
                    buttons[nextIndex]?.focus();
                });
                menu.appendChild(button);
            };

            filteredOptions.forEach((option) => appendOption(option));
            if (allowCustom && resolvedInput.type === 'create') {
                appendOption({ value: resolvedInput.value }, { create: true });
            }

            if (!menu.childElementCount) {
                const message = document.createElement('div');
                message.className = 'pp-reasoning-effort-menu-message';
                if (resolvedInput.type === 'invalid') {
                    message.textContent = resolvedInput.message;
                } else if (!allowCustom && String(query || '').trim()) {
                    message.textContent = '当前模型只支持列表中的推理强度。';
                } else {
                    message.textContent = '没有匹配的推理强度。';
                }
                menu.appendChild(message);
            }
            positionMenu(menu);
        };

        const openMenu = (query = '') => {
            if (inputEl.disabled || toggleEl.disabled) return;
            const currentMenu = this.customSelectMenuEl;
            const isOpen = this.customSelectMenuAnchor === anchorEl
                && currentMenu
                && currentMenu.style.display !== 'none';
            if (isOpen) {
                renderMenu(currentMenu, query);
                return;
            }

            this.closeCustomSelectMenu();
            const menu = this.ensureCustomSelectMenu();
            menu.className = 'world-app-select-menu is-reasoning-effort-menu';
            menu.id = listboxId;
            menu.setAttribute('role', 'listbox');
            menu.style.display = 'block';
            menu.style.visibility = 'hidden';
            this.customSelectMenuAnchor = anchorEl;
            renderMenu(menu, query);
            menu.style.visibility = 'visible';
            inputEl.setAttribute('aria-expanded', 'true');

            const onDocClick = (event) => {
                const target = event?.target;
                if (!target || menu.contains(target) || anchorEl.contains(target)) return;
                this.closeCustomSelectMenu();
            };
            const onResize = () => this.closeCustomSelectMenu();
            const onScroll = (event) => {
                const target = event?.target;
                if (target && (menu.contains(target) || anchorEl.contains(target))) return;
                this.closeCustomSelectMenu();
            };
            document.addEventListener('mousedown', onDocClick, true);
            document.addEventListener('touchstart', onDocClick, true);
            window.addEventListener('resize', onResize);
            window.addEventListener('scroll', onScroll, true);
            this.customSelectMenuCleanup = () => {
                document.removeEventListener('mousedown', onDocClick, true);
                document.removeEventListener('touchstart', onDocClick, true);
                window.removeEventListener('resize', onResize);
                window.removeEventListener('scroll', onScroll, true);
                inputEl.setAttribute('aria-expanded', 'false');
            };
        };

        const commitInput = ({ focusInput = false } = {}) => {
            const resolved = resolveReasoningEffortInput(availableOptions, inputEl.value);
            if (resolved.type === 'existing') return chooseValue(resolved.value, { focusInput });
            if (allowCustom && resolved.type === 'create') {
                return chooseValue(resolved.value, { custom: true, focusInput });
            }
            syncInputFromSelect();
            return false;
        };

        inputEl.addEventListener('focus', () => {
            if (suppressFocusOpen) return;
            inputEl.select();
            requestAnimationFrame(() => {
                if (document.activeElement === inputEl && !suppressFocusOpen) openMenu('');
            });
        });
        inputEl.addEventListener('input', () => openMenu(inputEl.value));
        inputEl.addEventListener('change', () => commitInput());
        inputEl.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu({ restore: true });
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                commitInput({ focusInput: true });
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                openMenu(this.customSelectMenuAnchor === anchorEl ? inputEl.value : '');
                this.customSelectMenuEl?.querySelector('.world-app-select-item')?.focus();
            }
        });
        toggleEl.addEventListener('click', () => {
            if (toggleEl.disabled) return;
            const isOpen = this.customSelectMenuAnchor === anchorEl
                && this.customSelectMenuEl
                && this.customSelectMenuEl.style.display !== 'none';
            if (isOpen) {
                if (!commitInput({ focusInput: true })) closeMenu({ restore: true });
                return;
            }
            inputEl.focus({ preventScroll: true });
            inputEl.select();
            openMenu('');
        });
        selectEl.addEventListener('change', syncInputFromSelect);
        syncInputFromSelect();
    }

    wrapSelectWithCustomUI(select, placeholder = '请选择') {
        if (!select || !select.id) return select;
        select.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.style.width = '100%';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'world-app-select-btn';
        button.dataset.selectId = select.id;
        button.innerHTML = `
            <span class="pp-custom-select-label">${placeholder}</span>
            <span class="world-app-select-btn-chevron">▾</span>
        `;
        wrap.appendChild(select);
        wrap.appendChild(button);
        return wrap;
    }

    async applyBoundConfigIfAny(context = null, { onlyIfBoundOverride = false } = {}) {
        const resolved = context
            ? this.store.getResolvedActive('openai', context)
            : this.store.getResolvedActive('openai', {});
        if (onlyIfBoundOverride && resolved?.source === 'global') return;
        const preset = resolved?.preset || {};
        const sessionId = String(context?.sessionId || '').trim();
        const sessionProfileId = sessionId ? this.store.getSessionProfileId('openai', sessionId) : null;
        const rawModeForProfile = String(context?.uiMode || '').trim().toLowerCase();
        const modeForProfile = rawModeForProfile === 'moments'
            ? 'moments'
            : (sessionId?.startsWith('rp:') ? 'rp' : (rawModeForProfile === 'rp' ? 'rp' : 'chat'));
        const modeProfileId = this.store.getModeProfileId?.('openai', modeForProfile) || null;
        const boundId = sessionProfileId || modeProfileId;
        if (!boundId) return;
        const bridge = window.appBridge;
        if (!bridge?.setActiveConfigProfile) return;
        const currentId = bridge.getActiveConfigProfileId?.();
        if (currentId && currentId === boundId) return;
        try {
            const runtime = await bridge.setActiveConfigProfile(boundId);
            const cfg = runtime || bridge.getConfig?.() || {};
            if (bridge) {
                syncChatRuntimeConfigToBridge({
                    bridge,
                    runtime: cfg,
                    canInitClient,
                    createClient: config => new LLMClient(config),
                });
            }
            window.dispatchEvent(new CustomEvent('preset-bound-config-applied', { detail: { profileId: boundId } }));
        } catch (err) {
            logger.warn('应用预设绑定的 API 配置失败', err);
        }
    }

    async applyBoundConfigForCurrentContext(options = {}) {
        return this.applyBoundConfigIfAny(this.getCurrentPresetContext(), options);
    }

    async show(options = {}) {
        await this.store.ready;
        if (!this.element) this.createUI();
        const opts = options && typeof options === 'object' ? options : {};
        this.pendingOpenOptions = opts;
        const requestedSection = String(opts.section || opts.sectionId || '').trim();
        const section = requestedSection ? this.getSectionById(requestedSection) : null;
        this.currentSectionId = section ? section.id : null;
        this.currentPage = section ? 'detail' : 'root';
        this.bindingStoreType = '';
        this.bindingPresetId = '';
        this.renderAllSections();
        this.setPageView(this.currentPage);
        // 预览不跨开合残留：每次打开都从收起状态开始（一级页无预览）
        this.closePreview({ animate: false });
        // 区块草稿跨开合缓存：重新打开时恢复未保存计数提示
        this.updateUnsavedIndicator();
        if (section && this.detailScrollEl) this.detailScrollEl.scrollTop = 0;
        this.element.style.display = 'flex';
        this.overlayElement.style.display = 'block';
        this.syncPreviewDiscoveryGuide();
        if (opts.focusParam) {
            const ids = { temperature: 'gen-temperature', top_p: 'gen-top-p', top_k: 'gen-top-k', max_output_tokens: 'gen-max-tokens',
                max_context: 'gen-max-context-num', presence_penalty: 'gen-presence', frequency_penalty: 'gen-frequency', reasoning: 'gen-request-reasoning' };
            const target = this.element.querySelector('#' + (ids[opts.focusParam] || 'gen-temperature'));
            target?.scrollIntoView?.({ block: 'center' });
            target?.focus?.({ preventScroll: true });
        }
    }

    /* 取消 = 确认后回滚未保存编辑；×/遮罩关闭 = 缓存编辑（发送始终用已保存内容，保存才更新） */
    async onCancel() {
        if (this.isPresetMutationBusy()) {
            this.showStatus('正在保存上一处修改，请稍候', 'info');
            return false;
        }
        this.captureCurrentDetailDraft();
        const n = this.countUnsavedChanges();
        if (n > 0) {
            const ok = await appConfirm({
                title: '放弃未保存的更改',
                message: `有 ${n} 处未保存的更改，取消将全部回滚。确定放弃吗？`,
                danger: true,
            });
            if (!ok) return;
            this.openaiBlockDrafts?.clear?.();
            this.openaiDeletedBlockIds?.clear?.();
            this.drafts.clear();
            // 注入编辑器未提交改动：清 dirty 即回滚（存储从未被写过），重开编辑器还原输入现场
            this.injectEditorDirty = false;
            if (this.currentPage === 'block' && this.currentInjectEditor) {
                this.openInjectBlockEditor(this.currentInjectEditor);
            }
            this.renderAllSections();
            this.updateUnsavedIndicator();
            window.toastr?.info?.('已放弃未保存的更改');
        }
        this.hide();
    }

    /* 会清掉区块草稿的操作（切换/新建预设、导入）前确认 */
    async confirmDiscardBlockDrafts(actionLabel = '此操作', { all = false } = {}) {
        const n = all ? this.countUnsavedChanges() : this.countUnsavedOpenAIChanges();
        if (n <= 0) return true;
        return appConfirm({
            title: '未保存的更改',
            message: `${actionLabel}会丢弃 ${n} 处未保存修改。确定继续吗？`,
            danger: true,
        });
    }

    hide() {
        this.captureCurrentDetailDraft();
        this.closeCustomSelectMenu();
        this.previewDiscoveryGuide?.hide?.();
        if (this.element) this.element.style.display = 'none';
        if (this.overlayElement) this.overlayElement.style.display = 'none';
        const onHide = this.pendingOpenOptions?.onHide;
        if (this.pendingOpenOptions) delete this.pendingOpenOptions.onHide;
        onHide?.();
    }

    setPreviewDiscoveryGuide(guide = null) {
        this.previewDiscoveryGuide?.hide?.();
        this.previewDiscoveryGuide = guide || null;
        this.syncPreviewDiscoveryGuide();
    }

    syncPreviewDiscoveryGuide() {
        const guide = this.previewDiscoveryGuide;
        if (!guide) return false;
        const panelVisible = Boolean(this.element && this.element.style?.display !== 'none');
        if (!panelVisible || this.currentPage !== 'detail' || (this.previewState || 'closed') !== 'closed') {
            guide.hide?.();
            return false;
        }
        const target = this.element?.querySelector?.('.pp-page[data-panel-page="detail"] .pp-preview-edge') || null;
        return guide.show?.(target) === true;
    }

    /* ════════════════════════════════════════
       UI scaffold
       ════════════════════════════════════════ */
    createUI() {
        /* overlay */
        this.overlayElement = document.createElement('div');
        this.overlayElement.id = 'preset-overlay';
        this.overlayElement.style.cssText = `display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index: 20000;`;
        this.overlayElement.onclick = () => this.hide();

        /* panel */
        this.element = document.createElement('div');
        this.element.id = 'preset-panel';
        this.element.style.cssText = `
            display:none; position:fixed;
            top: calc(var(--app-visual-offset-top, 0px) + 10px + env(safe-area-inset-top, 0px));
            bottom: auto;
            left: calc(10px + env(safe-area-inset-left, 0px));
            right: calc(10px + env(safe-area-inset-right, 0px));
            height: calc(var(--app-visual-height, 100dvh) - 20px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-height: calc(var(--app-visual-height, 100dvh) - 20px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            box-sizing: border-box;
            background:var(--app-surface-card); border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,0.25);
            z-index: 21000; flex-direction: column; overflow: hidden;
        `;
        this.element.onclick = (e) => e.stopPropagation();

        /* single innerHTML write — avoids innerHTML += serialization issues */
        this.element.innerHTML = `
            <style>${PANEL_CSS}</style>
            <div class="pp-header">
                <div style="min-width:0;">
                    <div class="pp-header-title has-help" data-help="选择/编辑提示词与生成参数">预设（Preset）</div>
                </div>
                <div class="pp-header-actions">
                    <button type="button" id="preset-maximize" aria-label="放大预设面板" aria-pressed="false" title="放大占满">${presetMaximizeSvg}</button>
                    <button id="preset-import">导入</button>
                    <button id="preset-export">导出</button>
                    <button class="pp-close" id="preset-close">&times;</button>
                </div>
            </div>
            <div class="pp-main">
            <div class="pp-shell">
                <div class="pp-manager" id="preset-manager"></div>
                <div class="pp-nav-shell">
                    <div class="pp-pages" id="preset-pages" data-view="root">
                        <section class="pp-page" data-panel-page="root">
                            <div class="pp-page-scroll">
                                <div class="pp-nav-list" id="preset-root-list"></div>
                            </div>
                        </section>
                        <section class="pp-page" data-panel-page="detail">
                            <div class="pp-detail-topbar">
                                <button type="button" class="pp-back-btn" id="preset-back">
                                    ${chevronLeftSvg}
                                    <span>返回</span>
                                </button>
                                <div class="pp-detail-heading" id="preset-detail-title"></div>
                                <div class="pp-detail-subheading" id="preset-detail-subtitle"></div>
                            </div>
                            <button type="button" class="pp-preview-edge" data-pp-preview-open aria-label="展开请求预览" title="点击或向左拉，展开请求预览"></button>
                            <div class="pp-page-scroll" id="preset-detail-scroll">
                                <div class="pp-section-editor" id="preset-detail-editor"></div>
                            </div>
                        </section>
                        <section class="pp-page" data-panel-page="bindings">
                            <div class="pp-detail-topbar">
                                <button type="button" class="pp-back-btn" id="preset-binding-back">
                                    ${chevronLeftSvg}
                                    <span>返回</span>
                                </button>
                                <div class="pp-detail-heading" id="preset-binding-title"></div>
                                <div class="pp-detail-subheading" id="preset-binding-subtitle"></div>
                            </div>
                            <div class="pp-page-scroll" id="preset-binding-scroll">
                                <div class="pp-section-editor" id="preset-binding-editor"></div>
                            </div>
                        </section>
                        <section class="pp-page" data-panel-page="block">
                            <div class="pp-detail-topbar">
                                <button type="button" class="pp-back-btn" id="preset-block-back">
                                    ${chevronLeftSvg}
                                    <span>返回</span>
                                </button>
                                <div class="pp-detail-heading" id="preset-block-title"></div>
                                <div class="pp-detail-subheading" id="preset-block-subtitle"></div>
                            </div>
                            <div class="pp-swipe-hint pp-swipe-hint-prev" aria-hidden="true"><span>↑</span><span class="pp-swipe-hint-label"></span></div>
                            <button type="button" class="pp-preview-edge" data-pp-preview-open aria-label="展开请求预览" title="点击或向左拉，展开请求预览"></button>
                            <div class="pp-page-scroll" id="preset-block-scroll">
                                <div class="pp-section-editor" id="preset-block-editor"></div>
                            </div>
                            <div class="pp-swipe-hint pp-swipe-hint-next" aria-hidden="true"><span>↓</span><span class="pp-swipe-hint-label"></span></div>
                        </section>
                    </div>
                </div>
            </div>
            <aside class="pp-preview-pane" id="preset-preview-pane">
                <div class="pp-preview-head">
                    <div class="pp-preview-title">请求预览<span class="pp-preview-est" id="preset-preview-est"></span></div>
                    <div class="pp-preview-actions">
                        <button type="button" id="preset-preview-toggle-macroeval" class="pp-preview-toggle has-help" data-help="默认区块原样显示（宏语法可见、左右逐字联动，悬停/点按宏可看求值）。开启后区块整体求值，展示实际送模型的效果。聊天格式/聊天记录等注入改由自定义提示词页顶部的注入选择条控制。" data-help-mode="press">宏求值</button>
                        <button type="button" id="preset-preview-refresh" class="pp-preview-toggle" aria-label="重新构建">↻</button>
                        <button type="button" id="preset-preview-close" class="pp-preview-toggle" aria-label="关闭预览">×</button>
                    </div>
                </div>
                <div class="pp-preview-scroll" id="preset-preview-scroll">
                    <div class="pp-preview-body" id="preset-preview-body"></div>
                </div>
            </aside>
            <button type="button" class="pp-pane-handle pp-pane-handle-expand" id="preset-preview-expand" aria-label="拉出全屏预览" title="点击或向左拉，拉满预览"></button>
            <button type="button" class="pp-pane-handle pp-pane-handle-collapse" id="preset-preview-collapse" aria-label="收起预览" title="点击或向右拉，收起预览"></button>
            <button type="button" class="pp-editor-handle" id="preset-editor-return" aria-label="返回编辑" title="点击或向右拉，返回编辑"></button>
            </div>
            <div class="pp-status" id="preset-status"></div>
            <div class="pp-footer">
                <span class="pp-unsaved-chip" id="preset-unsaved-chip" hidden></span>
                <button type="button" class="pp-btn-acceptall" id="preset-accept-all" hidden>✔ 接受全部</button>
                <button type="button" class="pp-btn-rejectall" id="preset-reject-all" hidden>× 全部取消</button>
                <button class="pp-btn-cancel" id="preset-cancel">取消</button>
                <button class="pp-btn-save" id="preset-save">保存</button>
            </div>
        `;

        document.body.appendChild(this.overlayElement);
        document.body.appendChild(this.element);

        this.statusEl = this.element.querySelector('#preset-status');
        this.managerEl = this.element.querySelector('#preset-manager');
        this.pagesEl = this.element.querySelector('#preset-pages');
        this.rootListEl = this.element.querySelector('#preset-root-list');
        this.detailTitleEl = this.element.querySelector('#preset-detail-title');
        this.detailSubtitleEl = this.element.querySelector('#preset-detail-subtitle');
        this.detailEditorEl = this.element.querySelector('#preset-detail-editor');
        this.detailScrollEl = this.element.querySelector('#preset-detail-scroll');
        this.bindingTitleEl = this.element.querySelector('#preset-binding-title');
        this.bindingSubtitleEl = this.element.querySelector('#preset-binding-subtitle');
        this.bindingEditorEl = this.element.querySelector('#preset-binding-editor');
        this.bindingScrollEl = this.element.querySelector('#preset-binding-scroll');
        this.blockTitleEl = this.element.querySelector('#preset-block-title');
        this.blockSubtitleEl = this.element.querySelector('#preset-block-subtitle');
        this.blockEditorEl = this.element.querySelector('#preset-block-editor');
        this.element.querySelector('#preset-close').onclick = () => this.hide();
        this.element.querySelector('#preset-cancel').onclick = () => this.onCancel();
        this.element.querySelector('#preset-accept-all').onclick = () => this.acceptAllBlockDrafts();
        this.element.querySelector('#preset-reject-all').onclick = () => this.rejectAllBlockDrafts();
        const maxBtn = this.element.querySelector('#preset-maximize');
        if (maxBtn) {
            const applyMax = (on) => {
                this.element.dataset.maximized = on ? '1' : '0';
                maxBtn.classList.toggle('is-on', on);
                maxBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
                maxBtn.setAttribute('aria-label', on ? '还原预设面板' : '放大预设面板');
                maxBtn.title = on ? '还原面板' : '放大占满';
                try { localStorage.setItem('preset-panel-maximized', on ? '1' : '0'); } catch {}
            };
            maxBtn.onclick = () => applyMax(this.element.dataset.maximized !== '1');
            try { if (localStorage.getItem('preset-panel-maximized') === '1') applyMax(true); } catch {}
        }
        this.element.querySelector('#preset-save').onclick = () => this.onSave();
        this.element.querySelector('#preset-back').onclick = () => this.showRootPage();
        this.element.querySelector('#preset-binding-back').onclick = () => this.showDetailPage();
        this.element.querySelector('#preset-block-back').onclick = () => this.showDetailPage();
        this.setupBlockSwipeNav();
        this.setupPreviewPane();

        /* hidden file input for import */
        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json,application/json';
        importInput.style.display = 'none';
        importInput.id = 'preset-import-file';
        this.element.appendChild(importInput);

        this.element.querySelector('#preset-import').onclick = () => {
            importInput.value = '';
            importInput.click();
        };
        importInput.onchange = async () => {
            const file = importInput.files?.[0];
            if (file) {
                await this.enqueuePresetMutation(
                    () => this.importFromFile(file),
                    { rejectIfBusy: true },
                );
            }
        };
        this.element.querySelector('#preset-export').onclick = () => this.exportCurrent();

        const refreshForChatConfig = (event) => {
            if (event?.detail?.tab && event.detail.tab !== 'chat') return;
            if (this.element?.style.display === 'none') return;
            this.captureCurrentDetailDraft();
            this.renderAllSections();
        };
        window.addEventListener('config-profile-changed', refreshForChatConfig);
        window.addEventListener('config-draft-changed', refreshForChatConfig);
    }

    /* ════════════════════════════════════════
       Render shell pages
       ════════════════════════════════════════ */
    renderAllSections() {
        if (!this.element) return;
        this.renderManager();
        this.renderMainList();
        // 区块编辑页绑定的卡片会在重建后失效，回退到所属 section 的 detail 页
        if (this.currentPage === 'block') this.currentPage = 'detail';
        if (this.currentSectionId) {
            const sec = this.getSectionById(this.currentSectionId);
            if (sec) {
                this.renderDetailSection(sec);
                if (this.currentPage === 'bindings') this.renderBindingSection(sec);
                else this.clearBindingSection();
            }
            else this.currentSectionId = null;
        }
        if (!this.currentSectionId) {
            this.clearDetailSection();
            this.clearBindingSection();
        }
        this.setPageView(this.currentPage);
        if (this.isPresetMutationBusy()) this.setPresetMutationBusy(true);
    }

    getSectionById(id) {
        return SECTIONS.find((sec) => sec.id === id) || null;
    }

    getDefaultContextSection() {
        return this.getSectionById('openai') || SECTIONS[0] || null;
    }

    getCurrentContextSection() {
        return this.getSectionById(this.currentSectionId) || this.getDefaultContextSection();
    }

    getStoreTypeSectionsLabel(storeType) {
        return SECTIONS
            .filter((sec) => sec.storeType === storeType)
            .map((sec) => translateUiText(sec.label))
            .join(' / ');
    }

    getActivePresetSnapshot(storeType) {
        const presetId = this.store.getActiveId(storeType);
        const key = this.getDraftKey(storeType, presetId);
        if (key && this.drafts.has(key)) return deepClone(this.drafts.get(key));
        return this.store.getActive(storeType) || {};
    }

    isEnabledToggleReadonly(storeType) {
        return storeType === 'instruct' || storeType === 'reasoning';
    }

    getSectionBadge(sec) {
        const p = this.getActivePresetSnapshot(sec.storeType) || {};
        if (sec.id === 'openai') {
            const temperature = p.temperature ?? 1;
            const tp = p.top_p ?? 0.98;
            const effort = normalizeReasoningEffort(
                p.reasoning_effort,
                'high',
                { allowCustom: true },
            );
            const effortLabel = translateUiText(REASONING_EFFORT_LABELS[effort] || `${effort}（自定义）`);
            const reasoning = p.request_reasoning === true
                ? ` · ${t('推理 {effort}', { effort: effortLabel })}`
                : '';
            return `temp ${temperature} · top_p ${tp}${reasoning}`;
        }
        if (sec.id === 'custom') {
            const prompts = Array.isArray(p.prompts) ? p.prompts : [];
            return t('{count} 区块', { count: prompts.length });
        }
        if (sec.id === 'taskprompts') {
            return t('动态评论 · 格式检查（独立组装，只读）');
        }
        const name = p?.name || this.store.getActive(sec.storeType)?.name;
        return name || '';
    }

    renderManager() {
        if (!this.managerEl) return;
        const sec = this.getCurrentContextSection();
        if (!sec) return;
        const storeType = sec.storeType;
        const presets = this.store.list(storeType);
        const activeId = this.store.getActiveId(storeType);
        const enabledReadonly = this.isEnabledToggleReadonly(storeType);
        const effectiveText = this.describeResolvedPreset(storeType);

        this.managerEl.innerHTML = `
            <div class="pp-manager-card">
                <div class="pp-manager-head">
                    <div style="min-width:0;">
                        <div class="pp-manager-title">预设方案</div>
                        <div class="pp-manager-sub">${t('当前分类：{categories}', {
                            categories: this.getStoreTypeSectionsLabel(storeType) || translateUiText(sec.label),
                        })}</div>
                        <div class="pp-manager-context"><strong>当前会话实际使用：</strong>${escapeHtml(effectiveText || '未启用')}</div>
                    </div>
                    <div class="pp-enabled-chip ${enabledReadonly ? 'pp-readonly' : ''}">
                        <span class="pp-enabled-text">启用</span>
                        <label class="pp-switch">
                            <input type="checkbox" id="preset-manager-enabled">
                            <span class="pp-switch-track"></span>
                        </label>
                    </div>
                </div>
                <div class="pp-manager-select-row">
                    <div class="pp-manager-select-wrap">
                        <label class="pp-manager-label" for="preset-manager-select">当前预设</label>
                        <select class="pp-manager-select" id="preset-manager-select" style="display:none;"></select>
                        <button type="button" class="world-app-select-btn" data-select-id="preset-manager-select">
                            <span class="pp-custom-select-label" data-i18n-skip>${t('请选择')}</span>
                            <span class="world-app-select-btn-chevron">▾</span>
                        </button>
                    </div>
                </div>
                <div class="pp-manager-actions">
                    <button type="button" class="pp-manager-btn" id="preset-manager-new">新建</button>
                    <button type="button" class="pp-manager-btn" id="preset-manager-rename">重命名</button>
                    <button type="button" class="pp-manager-btn" id="preset-manager-bindings">使用位置</button>
                    <button type="button" class="pp-manager-btn pp-danger" id="preset-manager-delete">删除</button>
                </div>
            </div>
        `;

        const select = this.managerEl.querySelector('#preset-manager-select');
        const enabledCb = this.managerEl.querySelector('#preset-manager-enabled');
        const renameBtn = this.managerEl.querySelector('#preset-manager-rename');
        const bindingsBtn = this.managerEl.querySelector('#preset-manager-bindings');
        const deleteBtn = this.managerEl.querySelector('#preset-manager-delete');

        presets.forEach((preset) => {
            const opt = document.createElement('option');
            opt.value = preset.id;
            opt.textContent = preset.name || preset.id;
            select.appendChild(opt);
        });
        select.disabled = presets.length === 0;
        if (activeId) select.value = activeId;
        enabledCb.checked = this.store.getEnabled(storeType);
        enabledCb.disabled = enabledReadonly;
        renameBtn.disabled = !activeId;
        bindingsBtn.disabled = !activeId;
        deleteBtn.disabled = !activeId;

        select.onchange = async () => {
            if (this.isPresetMutationBusy()) {
                this.showStatus('正在保存上一处修改，请稍候', 'info');
                this.renderManager();
                return;
            }
            await this.enqueuePresetMutation(async () => {
                // 切换 openai 预设会清区块草稿：先确认（拒绝则复位选择）
                if (storeType === 'openai' && select.value !== this.store.getActiveId('openai')) {
                    const ok = await this.confirmDiscardBlockDrafts('切换预设');
                    if (!ok) { this.renderManager(); return; }
                    this.discardOpenAIDrafts({ presetId: this.store.getActiveId('openai') });
                } else {
                    this.captureCurrentDetailDraft();
                }
                await this.store.setActive(storeType, select.value);
                this.renderAllSections();
                window.dispatchEvent(new CustomEvent('preset-changed'));
            });
        };
        this.bindCustomSelect('preset-manager-select', this.managerEl);

        if (!enabledReadonly) {
            enabledCb.onchange = async () => {
                if (this.isPresetMutationBusy()) {
                    this.showStatus('正在保存上一处修改，请稍候', 'info');
                    this.renderManager();
                    return;
                }
                await this.enqueuePresetMutation(async () => {
                    await this.store.setEnabled(storeType, !!enabledCb.checked);
                    this.renderAllSections();
                    this.showStatus('已更新启用状态', 'success');
                    window.dispatchEvent(new CustomEvent('preset-changed'));
                });
            };
        }

        this.managerEl.querySelector('#preset-manager-new').onclick = () => this.enqueuePresetMutation(
            () => this.onNewForStoreType(storeType),
            { rejectIfBusy: true },
        );
        renameBtn.onclick = () => this.enqueuePresetMutation(
            () => this.onRenameForStoreType(storeType),
            { rejectIfBusy: true },
        );
        bindingsBtn.onclick = () => this.openBindingsPage(storeType, activeId);
        deleteBtn.onclick = () => this.enqueuePresetMutation(
            () => this.onDeleteForStoreType(storeType),
            { rejectIfBusy: true },
        );
    }

    renderMainList() {
        if (!this.rootListEl) return;
        this.rootListEl.innerHTML = '';
        for (const sec of SECTIONS) {
            this.rootListEl.appendChild(this.buildSectionListItem(sec));
        }
    }

    buildSectionListItem(sec) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `pp-nav-item ${this.store.getEnabled(sec.storeType) ? '' : 'pp-disabled'}`.trim();
        item.innerHTML = `
            <div class="pp-nav-item-left">
                <span class="pp-nav-item-icon">${SECTION_ICONS[sec.id] || SECTION_ICONS.custom}</span>
                <div class="pp-nav-item-title">${sec.label}</div>
                <div class="pp-nav-item-sub">${escapeHtml(this.getSectionBadge(sec) || '进入后编辑该分类内容')}</div>
            </div>
            <span class="pp-nav-item-arrow">${chevronRightSvg}</span>
        `;
        item.addEventListener('click', () => this.openSection(sec.id));
        return item;
    }

    openSection(sectionId) {
        const sec = this.getSectionById(sectionId);
        if (!sec) return;
        this.captureCurrentDetailDraft();
        this.currentSectionId = sec.id;
        this.currentPage = 'detail';
        // 重建收敛：进入 section 只构建该 detail 编辑器（manager/首页列表未变，不整体重建）
        this.renderDetailSection(sec);
        this.setPageView('detail');
        if (this.detailScrollEl) this.detailScrollEl.scrollTop = 0;
    }

    openBindingsPage(storeType, presetId = '') {
        const st = String(storeType || '').trim();
        const section = SECTIONS.find((item) => item.storeType === st) || this.getCurrentContextSection();
        if (!section) return;
        const nextPresetId = String(presetId || this.store.getActiveId(st) || '').trim();
        this.captureCurrentDetailDraft();
        this.currentSectionId = section.id;
        this.currentPage = 'bindings';
        this.bindingStoreType = st;
        this.bindingPresetId = nextPresetId;
        this.renderAllSections();
        this.setPageView('bindings');
        if (this.bindingScrollEl) this.bindingScrollEl.scrollTop = 0;
    }

    showRootPage({ capture = true } = {}) {
        if (capture) this.captureCurrentDetailDraft();
        // 一级页没有预览：返回时随手收起
        this.closePreview();
        this.currentSectionId = null;
        this.currentPage = 'root';
        this.bindingStoreType = '';
        this.bindingPresetId = '';
        // 重建收敛：返回首页只刷新导航列表（小标题/计数可能随编辑变化），manager 与 detail 不重建
        this.renderMainList();
        this.setPageView('root');
    }

    showDetailPage({ capture = true } = {}) {
        if (capture) this.captureCurrentDetailDraft();
        if (!this.currentSectionId) {
            this.showRootPage({ capture: false });
            return;
        }
        this.currentPage = 'detail';
        // 重建收敛：从三级区块页/绑定页返回时 detail 编辑器还在 DOM 中（区块编辑已 write-through 同步），
        // 不重建——同时保住列表滚动位置。
        this.setPageView('detail');
    }

    setPageView(view) {
        if (!this.pagesEl) return;
        const next = ['bindings', 'detail', 'block'].includes(view) ? view : 'root';
        this.pagesEl.dataset.view = next;
        if (this.element) this.element.dataset.view = next;
        this.syncPreviewDiscoveryGuide();
    }

    renderDetailSection(sec) {
        if (!this.detailEditorEl || !this.detailTitleEl || !this.detailSubtitleEl) return;
        this.detailTitleEl.textContent = sec.label;
        this.detailSubtitleEl.textContent = this.getSectionBadge(sec) || '编辑该分类中的具体内容';
        this.detailEditorEl.innerHTML = '';
        this.renderSectionEditor(sec, this.detailEditorEl);
    }

    clearDetailSection() {
        if (this.detailTitleEl) this.detailTitleEl.textContent = '';
        if (this.detailSubtitleEl) this.detailSubtitleEl.textContent = '';
        if (this.detailEditorEl) this.detailEditorEl.innerHTML = '';
    }

    renderBindingSection(sec) {
        if (!this.bindingEditorEl || !this.bindingTitleEl || !this.bindingSubtitleEl) return;
        const storeType = this.bindingStoreType || sec.storeType;
        const fallbackPresetId = String(this.store.getActiveId(storeType) || '').trim();
        const requestedPresetId = String(this.bindingPresetId || fallbackPresetId || '').trim();
        const preset = requestedPresetId
            ? (this.store.list(storeType).find((item) => String(item.id || '') === requestedPresetId) || null)
            : null;
        const presetId = String(preset?.id || fallbackPresetId || '').trim();
        this.bindingPresetId = presetId;
        this.bindingTitleEl.dataset.i18nSkip = '';
        this.bindingSubtitleEl.dataset.i18nSkip = '';
        this.bindingTitleEl.textContent = `${translateUiText(this.getStoreTypeSectionsLabel(storeType) || this.getTypeLabel(sec.id))} · ${translateUiText('使用位置')}`;
        this.bindingSubtitleEl.textContent = translateUiText(preset?.name
            ? `查看「${preset.name}」的既有绑定；新的聊天绑定请在会话配置中建立。`
            : '查看当前预设的既有绑定；新的聊天绑定请在会话配置中建立。');
        this.bindingEditorEl.innerHTML = '';
        this.renderBindingEditor({
            storeType,
            presetId,
            presetName: String(preset?.name || presetId || '').trim(),
        }, this.bindingEditorEl);
    }

    clearBindingSection() {
        if (this.bindingTitleEl) this.bindingTitleEl.textContent = '';
        if (this.bindingSubtitleEl) this.bindingSubtitleEl.textContent = '';
        if (this.bindingEditorEl) this.bindingEditorEl.innerHTML = '';
    }

    captureCurrentDetailDraft() {
        if (!this.currentSectionId || !this.detailEditorEl || !this.detailEditorEl.children.length) return;
        const sec = this.getSectionById(this.currentSectionId);
        if (!sec) return;
        try {
            const storeType = sec.storeType;
            const presetId = this.store.getActiveId(storeType);
            const key = this.getDraftKey(storeType, presetId);
            if (!key) return;
            const base = this.drafts.has(key)
                ? this.drafts.get(key)
                : deepClone(this.store.getActive(storeType) || {});
            const next = this.collectSectionData(sec.id, this.detailEditorEl, base);
            // 与已保存基线一致的草稿直接丢弃：避免「未保存更改」误报，也减少无谓写盘
            const baseline = this.store.getActive(storeType) || {};
            if (isSamePresetData(next, baseline)) this.drafts.delete(key);
            else this.drafts.set(key, next);
        } catch (err) {
            logger.debug('capture detail draft failed', sec.id, err);
        }
    }

    /* ════════════════════════════════════════
       Section editors
       ════════════════════════════════════════ */
    renderSectionEditor(sec, root) {
        const storeType = sec.storeType;
        const presetId = this.store.getActiveId(storeType);
        const key = this.getDraftKey(storeType, presetId);
        const p = (key && this.drafts.has(key)) ? this.drafts.get(key) : (this.store.getActive(storeType) || {});

        if (sec.id !== 'taskprompts') {
            const scopeCard = document.createElement('div');
            scopeCard.className = 'pp-scope-card';
            scopeCard.innerHTML = `
                <div class="pp-scope-card-copy">
                    <span class="pp-scope-card-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="M5 6h4M15 6h4M7 6v12h4M17 6v6h-6M11 12v6h6"/><circle cx="7" cy="6" r="2"/><circle cx="17" cy="6" r="2"/><circle cx="11" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>
                    </span>
                    <div class="pp-scope-card-text">
                        <label for="preset-app-scope" class="pp-scope-card-title has-help" data-help="适用范围只决定这个预设可在哪些界面被选择，不会自动绑定到聊天。">适用范围</label>
                        <div class="pp-scope-card-sub">决定这个预设可以出现在哪些使用场景。</div>
                    </div>
                </div>
                <div class="pp-scope-card-control">
                    <select id="preset-app-scope" class="pp-input" aria-describedby="preset-app-scope-note">
                        <option value="creative">创意写作</option>
                        <option value="chat">聊天模式</option>
                        <option value="all">全部</option>
                    </select>
                </div>
                <div class="pp-scope-card-note" id="preset-app-scope-note">
                    <span class="pp-scope-card-note-dot" aria-hidden="true"></span>
                    <span>聊天预设请从会话配置中选择；“全部”也不会自动成为聊天默认。</span>
                </div>
            `;
            const scopeSelect = scopeCard.querySelector('#preset-app-scope');
            scopeSelect.value = normalizePresetAppScope(
                p.app_scope,
                PRESET_APP_SCOPES.creative,
            );
            if (sec.storeType === 'openai') {
                // 适用范围切换即时联动聊天注入 chip/卡与预览可用态（未保存也先反映）
                scopeSelect.addEventListener('change', () => {
                    this.refreshInjectUi();
                    this.invalidateOrRebuildPreview();
                });
            }
            root.appendChild(scopeCard);
        }

        switch (sec.id) {
            case 'openai': root.appendChild(this.renderOpenAIParamsEditor(p)); break;
            case 'custom': root.appendChild(this.renderOpenAIBlocksEditor(p)); break;
            case 'sysprompt': root.appendChild(this.renderSyspromptEditor(p)); break;
            case 'taskprompts': root.appendChild(this.renderTaskPromptsViewer()); break;
            case 'chatprompts': root.appendChild(this.renderChatPromptsEditor(p)); break;
            case 'context': root.appendChild(this.renderContextEditor(p)); break;
            case 'instruct': root.appendChild(this.renderInstructEditor(p)); break;
            case 'reasoning': root.appendChild(this.renderReasoningEditor(p)); break;
        }
    }

    async commitBindingChange(task, message = '已更新使用位置') {
        return this.enqueuePresetMutation(async () => {
            try {
                await task();
                this.renderAllSections();
                this.showStatus(message, 'success');
                window.dispatchEvent(new CustomEvent('preset-changed'));
                return true;
            } catch (err) {
                logger.warn('更新预设使用位置失败', err);
                this.showStatus(err?.message || '更新使用位置失败', 'error');
                return false;
            }
        }, { rejectIfBusy: true });
    }

    renderBindingEditor({ storeType, presetId, presetName }, root) {
        const wrap = document.createElement('div');
        wrap.className = 'pp-binding-stack';
        const preset = this.store.list(storeType).find(item => String(item.id || '') === String(presetId || '')) || {};

        const currentContext = this.getCurrentPresetContext();
        const currentSessionId = String(currentContext?.sessionId || '').trim();
        const currentSessionResolved = currentSessionId
            ? this.store.getResolvedActive(storeType, currentContext)
            : null;
        const modeBindings = this.store.getBindings(storeType);
        const sessionEntries = this.buildPresetBindingSessionEntries();

        const makeCard = ({ title, subtitle, chip = '', actions = [] } = {}) => {
            const card = document.createElement('div');
            card.className = 'pp-binding-card';

            const head = document.createElement('div');
            head.className = 'pp-binding-card-head';

            const main = document.createElement('div');
            const titleEl = document.createElement('div');
            titleEl.className = 'pp-binding-card-title';
            titleEl.dataset.i18nSkip = '';
            titleEl.textContent = translateUiText(title || '');
            main.appendChild(titleEl);

            if (subtitle) {
                const subEl = document.createElement('div');
                subEl.className = 'pp-binding-card-sub';
                subEl.dataset.i18nSkip = '';
                subEl.textContent = translateUiText(subtitle);
                main.appendChild(subEl);
            }
            head.appendChild(main);

            if (chip) {
                const chipEl = document.createElement('div');
                chipEl.className = 'pp-binding-chip';
                chipEl.dataset.i18nSkip = '';
                chipEl.textContent = translateUiText(chip);
                head.appendChild(chipEl);
            }

            card.appendChild(head);

            if (actions.length) {
                const actionsWrap = document.createElement('div');
                actionsWrap.className = 'pp-binding-actions';
                actions.forEach((cfg) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = `pp-binding-btn ${cfg.tone ? `is-${cfg.tone}` : ''}`.trim();
                    btn.dataset.i18nSkip = '';
                    btn.textContent = translateUiText(cfg.label || '');
                    btn.disabled = cfg.disabled === true;
                    if (typeof cfg.onClick === 'function') {
                        btn.addEventListener('click', cfg.onClick);
                    }
                    actionsWrap.appendChild(btn);
                });
                card.appendChild(actionsWrap);
            }

            return card;
        };

        wrap.appendChild(makeCard({
            title: '创意写作默认',
            subtitle: '顶部“当前预设”只决定创意写作的默认；聊天没有绑定时使用 APP 内建默认。',
            chip: presetName || '当前预设',
        }));

        if (currentSessionId) {
            const currentSessionEntry = sessionEntries.find((item) => item.id === currentSessionId) || null;
            const currentBoundId = this.store.getSessionBindingId(storeType, currentSessionId);
            const currentIsBound = currentBoundId === presetId;
            const currentLabel = currentSessionEntry?.name || currentSessionId;
            const resolvedName = String(currentSessionResolved?.preset?.name || this.getPresetNameById(storeType, currentSessionResolved?.presetId) || '').trim();
            const resolvedSource = this.getBindingSourceLabel(currentSessionResolved?.source, currentSessionResolved?.mode);
            wrap.appendChild(makeCard({
                title: `当前会话：${currentLabel}`,
                subtitle: currentIsBound
                    ? '当前预设已绑定到这个会话。'
                    : `当前使用：${resolvedName || '未设置'}（${resolvedSource}）`,
                chip: currentSessionEntry?.meta || '当前',
                actions: currentIsBound
                    ? [{
                        label: '取消当前会话绑定',
                        tone: 'muted',
                        onClick: () => this.commitBindingChange(
                            () => this.store.clearSessionBinding(storeType, currentSessionId),
                        ),
                    }]
                    : [],
            }));
        }

        const buildModeCard = (mode, label) => {
            const boundId = String(modeBindings?.modes?.[mode] || '').trim();
            const isCurrent = boundId === presetId;
            const boundName = boundId ? this.getPresetNameById(storeType, boundId) : '';
            const bindingOrigin = String(modeBindings?.modeBindingOrigins?.[mode] || '').trim();
            const legacy = bindingOrigin === 'legacy_migrated_mode_binding';
            const creativeMode = mode === 'rp';
            const eligible = isPresetEligibleForMode(preset || {}, mode);
            return makeCard({
                title: `${label}默认`,
                subtitle: isCurrent
                    ? (legacy
                        ? '沿用升级前的旧设置；可以清除，清除后不会再次自动建立。'
                        : '当前预设已设为这个界面的默认预设。')
                    : (boundName
                        ? `当前默认：${boundName}`
                        : (creativeMode ? '未单独设置时使用创意写作默认。' : '未绑定时使用 APP 内建默认。')),
                chip: legacy ? '沿用旧设置' : label,
                actions: isCurrent
                    ? [{
                        label: '取消默认绑定',
                        tone: 'muted',
                        onClick: () => this.commitBindingChange(
                            () => this.store.clearModeBinding(storeType, mode),
                        ),
                    }]
                    : (creativeMode && eligible ? [{
                        label: `设为${label}默认`,
                        tone: 'primary',
                        onClick: () => this.commitBindingChange(
                            () => this.store.setModeBinding(storeType, mode, presetId),
                        ),
                    }] : []),
            });
        };

        wrap.appendChild(buildModeCard('chat', '聊天对话'));
        wrap.appendChild(buildModeCard('rp', '创意写作'));
        wrap.appendChild(buildModeCard('moments', '动态任务'));

        const renderSessionSummary = (group, title) => {
            const items = sessionEntries.filter((item) => item.group === group);
            const boundItems = items.filter((item) => this.store.getSessionBindingId(storeType, item.id) === presetId);
            const card = document.createElement('div');
            card.className = 'pp-binding-card';
            const head = document.createElement('div');
            head.className = 'pp-binding-card-head';
            const sessionSummary = boundItems.length
                ? translateUiText(`已绑定 ${boundItems.length} 个会话：${boundItems.map((i) => i.name).join('、')}`)
                : translateUiText('暂无会话绑定此预设');
            head.dataset.i18nSkip = '';
            head.innerHTML = `
                <div>
                    <div class="pp-binding-card-title">${escapeHtml(translateUiText(title))}</div>
                    <div class="pp-binding-card-sub">${escapeHtml(sessionSummary)}</div>
                </div>
            `;
            card.appendChild(head);
            return card;
        };

        wrap.appendChild(renderSessionSummary('chat', '聊天对话会话'));
        wrap.appendChild(renderSessionSummary('rp', '创意写作会话'));

        const openConfigHint = document.createElement('div');
        openConfigHint.style.cssText = 'text-align:center; margin-top:12px;';
        const openConfigBtn = document.createElement('button');
        openConfigBtn.type = 'button';
        openConfigBtn.className = 'pp-binding-btn is-primary';
        openConfigBtn.style.cssText = 'padding:8px 20px;';
        openConfigBtn.textContent = '打开会话配置管理';
        openConfigBtn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('open-session-config'));
        });
        openConfigHint.appendChild(openConfigBtn);
        wrap.appendChild(openConfigHint);

        root.appendChild(wrap);
    }

    /* ── helpers ── */
    renderTextarea(label, id, value, placeholder = '', help = '') {
        const block = document.createElement('div');
        block.style.marginTop = '10px';
        const helpAttr = help ? ` class="pp-field-label has-help" data-help="${help}"` : ' class="pp-field-label"';
        block.innerHTML = `
            <div${helpAttr}>${label}</div>
            <textarea id="${id}" spellcheck="false" class="pp-textarea" placeholder="${placeholder}"></textarea>
        `;
        setValue(block.querySelector(`#${id}`), value || '');
        return block;
    }

    renderInputRow(fields) {
        const row = document.createElement('div');
        row.className = 'pp-row';
        fields.forEach(f => {
            const cell = document.createElement('div');
            const label = document.createElement('div');
            label.className = 'pp-field-label';
            label.textContent = f.label;
            cell.appendChild(label);
            cell.appendChild(f.el);
            row.appendChild(cell);
        });
        return row;
    }

    /* ── System prompt ── */
    renderSyspromptEditor(p) {
        const wrap = document.createElement('div');
        wrap.appendChild(this.renderTextarea('内容', 'sysprompt-content', p.content || '', 'Write {{char}}...'));
        wrap.appendChild(this.renderTextarea('Post-History Instructions（可选）', 'sysprompt-post', p.post_history || '', '（可留空）'));
        wrap.appendChild(this.renderPhoneFormatPlacementEditor(p));
        return wrap;
    }

    renderPhoneFormatPlacementEditor(p) {
        const section = document.createElement('div');
        section.className = 'pp-block';
        // pp-block 本体无内边距（常规卡内容在自带 padding 的 header/body 里）；本卡直排内容需自带
        section.style.cssText = 'margin-top:12px; padding:12px 14px;';

        const title = document.createElement('div');
        title.className = 'pp-block-title';
        title.textContent = '文本协议聊天格式位置';
        section.appendChild(title);

        const note = document.createElement('div');
        note.className = 'pp-block-sub';
        note.style.margin = '4px 0 10px';
        note.textContent = '四个格式块可分别调整；仅传统文本模式生效，FC/JSON 请求不包含这些内容。';
        section.appendChild(note);

        const configs = [
            ['phone-format-intro', '手机格式开头', 'phone_format_intro_position', 'phone_format_intro_depth'],
            ['phone-format-chat', 'QQ聊天格式', 'phone_format_chat_position', 'phone_format_chat_depth'],
            ['phone-format-moment', 'QQ空间格式', 'phone_format_moment_position', 'phone_format_moment_depth'],
            ['phone-format-footer', '手机格式结尾', 'phone_format_footer_position', 'phone_format_footer_depth'],
        ];
        configs.forEach(([idPrefix, label, positionKey, depthKey]) => {
            const select = document.createElement('select');
            select.id = `${idPrefix}-position`;
            select.className = 'pp-input';
            select.innerHTML = PHONE_FORMAT_POSITION_OPTIONS
                .map(option => `<option value="${option.v}">${option.t}</option>`)
                .join('');
            select.value = normalizePhoneFormatPromptPosition(p[positionKey]);
            const selectWrap = this.wrapSelectWithCustomUI(select, '注入位置');

            const depth = document.createElement('input');
            depth.id = `${idPrefix}-depth`;
            depth.type = 'number';
            depth.inputMode = 'numeric';
            depth.min = '0';
            depth.max = String(PHONE_FORMAT_PROMPT_MAX_DEPTH);
            depth.className = 'pp-input';
            depth.value = String(normalizePhoneFormatPromptDepth(p[depthKey]));

            const row = this.renderInputRow([
                { label, el: selectWrap },
                { label: '历史深度', el: depth },
            ]);
            const depthCell = row.children?.[1] || null;
            const syncDepthVisibility = () => {
                const usesDepth = select.value === 'history_depth';
                depth.disabled = !usesDepth;
                if (depthCell) depthCell.hidden = !usesDepth;
            };
            select.addEventListener('change', syncDepthVisibility);
            syncDepthVisibility();
            section.appendChild(row);
            this.bindCustomSelect(select.id, row);
        });

        return section;
    }

    /* ── Chat prompts ── */
    renderChatPromptsEditor(p) {
        const wrap = document.createElement('div');
        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
        const focusOptions = this.pendingOpenOptions || {};
        const focusPromptId = String(focusOptions.promptId || '').trim();
        let focusTarget = null;

        const makePromptBlock = (cfg) => {
            const card = document.createElement('div');
            card.className = 'pp-block';
            card.dataset.collapsed = 'true';
            card.dataset.promptId = cfg.idPrefix;

            const isEnabled = p[cfg.enabledKey] !== false;
            if (!isEnabled) card.classList.add('pp-block-disabled');

            const header = document.createElement('div');
            header.className = 'pp-block-header';
            const left = document.createElement('div');
            left.className = 'pp-block-left';
            const toggle = document.createElement('div');
            toggle.className = 'pp-block-toggle';
            toggle.innerHTML = '&#9656;';
            left.appendChild(toggle);

            const main = document.createElement('div');
            main.className = 'pp-block-main';
            const title = document.createElement('div');
            title.className = 'pp-block-title';
            title.textContent = cfg.title;
            main.appendChild(title);

            const metaChips = Array.isArray(cfg.metaChips) ? cfg.metaChips.filter(Boolean) : [];
            if (metaChips.length) {
                const meta = document.createElement('div');
                meta.className = 'pp-block-meta';
                metaChips.forEach((chip) => {
                    const el = document.createElement('span');
                    const tone = String(chip?.tone || 'placement').trim();
                    el.className = `pp-meta-chip is-${tone}`;
                    el.textContent = String(chip?.label || '').trim();
                    if (!el.textContent) return;
                    meta.appendChild(el);
                });
                if (meta.childElementCount) {
                    main.appendChild(meta);
                }
            } else if (cfg.subtitle) {
                const subtitle = document.createElement('div');
                subtitle.className = 'pp-block-sub';
                subtitle.textContent = cfg.subtitle;
                main.appendChild(subtitle);
            }

            left.appendChild(main);
            header.appendChild(left);

            const right = document.createElement('div');
            right.className = 'pp-block-right';
            const enabledWrap = document.createElement('label');
            enabledWrap.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary); cursor:pointer;';
            enabledWrap.innerHTML = `<input id="${cfg.idPrefix}-enabled" type="checkbox" style="width:16px; height:16px;">启用`;
            const enabledInput = enabledWrap.querySelector('input');
            enabledInput.checked = isEnabled;
            enabledWrap.addEventListener('click', (e) => e.stopPropagation());
            enabledInput.addEventListener('change', () => {
                card.classList.toggle('pp-block-disabled', !enabledInput.checked);
            });
            right.appendChild(enabledWrap);
            header.appendChild(right);
            card.appendChild(header);

            const body = document.createElement('div');
            body.className = 'pp-block-body';

            const pos = document.createElement('select');
            pos.id = `${cfg.idPrefix}-position`;
            pos.className = 'pp-input';
            const opts = Array.isArray(cfg.positionOptions) && cfg.positionOptions.length
                ? cfg.positionOptions
                : [
                    { v: EXT_PROMPT_TYPES.IN_PROMPT, t: 'IN_PROMPT（main 末尾）' },
                    { v: EXT_PROMPT_TYPES.IN_CHAT, t: 'IN_CHAT（按 depth/role）' },
                    { v: EXT_PROMPT_TYPES.BEFORE_LATEST_USER, t: '最新输入前' },
                    { v: EXT_PROMPT_TYPES.AFTER_LATEST_USER, t: '最新输入后' },
                    { v: EXT_PROMPT_TYPES.BEFORE_PROMPT, t: 'BEFORE_PROMPT（main 开头）' },
                    { v: EXT_PROMPT_TYPES.NONE, t: 'NONE（不注入）' },
                ];
            pos.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join('');
            const fallbackPos = cfg.defaultPosition
                ?? (opts.some(o => o.v === EXT_PROMPT_TYPES.IN_PROMPT) ? EXT_PROMPT_TYPES.IN_PROMPT : opts[0]?.v);
            pos.value = cfg.placementMode === 'phone_format'
                ? normalizePhoneFormatPromptPosition(p[cfg.positionKey] ?? fallbackPos)
                : String(p[cfg.positionKey] ?? fallbackPos);
            const posWrap = this.wrapSelectWithCustomUI(pos, '注入位置');

            const depth = document.createElement('input');
            depth.id = `${cfg.idPrefix}-depth`;
            depth.type = 'number'; depth.inputMode = 'numeric'; depth.min = '0';
            if (cfg.placementMode === 'phone_format') depth.max = String(PHONE_FORMAT_PROMPT_MAX_DEPTH);
            depth.className = 'pp-input';
            depth.value = String(p[cfg.depthKey] ?? cfg.defaultDepth);

            const role = document.createElement('select');
            role.id = `${cfg.idPrefix}-role`;
            role.className = 'pp-input';
            role.innerHTML = `
                <option value="${EXT_PROMPT_ROLES.SYSTEM}">SYSTEM</option>
                <option value="${EXT_PROMPT_ROLES.USER}">USER</option>
                <option value="${EXT_PROMPT_ROLES.ASSISTANT}">ASSISTANT</option>
            `;
            role.value = String(p[cfg.roleKey] ?? EXT_PROMPT_ROLES.SYSTEM);
            const roleWrap = this.wrapSelectWithCustomUI(role, '角色');

            if (cfg.placementMode === 'phone_format') {
                const row = this.renderInputRow([
                    { label: '注入位置', el: posWrap },
                    { label: '历史深度', el: depth },
                ]);
                const depthCell = row.children?.[1] || null;
                const syncDepthVisibility = () => {
                    const usesDepth = pos.value === 'history_depth';
                    depth.disabled = !usesDepth;
                    if (depthCell) depthCell.hidden = !usesDepth;
                };
                pos.addEventListener('change', syncDepthVisibility);
                syncDepthVisibility();
                body.appendChild(row);
                this.bindCustomSelect(pos.id, row);
                const note = document.createElement('div');
                note.className = 'pp-block-sub';
                note.textContent = '仅传统文本模式生效；FC/JSON 请求不包含此内容。';
                body.appendChild(note);
            } else if (cfg.showPlacementControls !== false && cfg.showDepthRole !== false) {
                const row = this.renderInputRow([
                    { label: '注入位置', el: posWrap },
                    { label: '深度（IN_CHAT）', el: depth },
                    { label: '角色（IN_CHAT）', el: roleWrap },
                ]);
                body.appendChild(row);
                this.bindCustomSelect(pos.id, row);
                this.bindCustomSelect(role.id, row);
            } else if (cfg.showPlacementControls !== false) {
                depth.disabled = true;
                const row = this.renderInputRow([
                    { label: '注入位置', el: posWrap },
                    { label: '深度（固定）', el: depth },
                    { label: '角色（固定）', el: roleWrap },
                ]);
                body.appendChild(row);
                this.bindCustomSelect(pos.id, row);
                this.bindCustomSelect(role.id, row);
            }

            body.appendChild(this.renderTextarea('规则内容', `${cfg.idPrefix}-rules`, p[cfg.rulesKey] || '', cfg.placeholder));
            card.appendChild(body);

            const setCollapsed = (collapsed) => {
                card.dataset.collapsed = collapsed ? 'true' : 'false';
                const toggle = header.querySelector('.pp-block-toggle');
                if (toggle) toggle.innerHTML = collapsed ? '&#9656;' : '&#9662;';
                body.style.display = collapsed ? 'none' : 'block';
            };
            header.addEventListener('click', () => setCollapsed(card.dataset.collapsed !== 'true'));
            const shouldFocus = focusPromptId === cfg.idPrefix;
            setCollapsed(!shouldFocus);
            if (shouldFocus) focusTarget = card;

            return card;
        };

        const fixedDepthOpts = [
            { v: EXT_PROMPT_TYPES.IN_CHAT, t: 'IN_CHAT / SYSTEM D1' },
            { v: EXT_PROMPT_TYPES.NONE, t: 'NONE（不注入）' },
        ];

        const phoneFormatPlacementChip = (positionKey, depthKey) => {
            const position = normalizePhoneFormatPromptPosition(p?.[positionKey]);
            const label = position === 'history_depth'
                ? `SYSTEM 深度${normalizePhoneFormatPromptDepth(p?.[depthKey])}`
                : ({
                    after_persona: 'SYSTEM 角色后',
                    system_end: 'SYSTEM 系统区末',
                    history_before: 'SYSTEM 历史前',
                }[position] || 'SYSTEM 历史前');
            return { label, tone: 'placement' };
        };

        list.appendChild(makePromptBlock({
            idPrefix: 'phone-format-intro', title: '手机格式开头',
            enabledKey: 'phone_format_intro_enabled',
            positionKey: 'phone_format_intro_position', depthKey: 'phone_format_intro_depth',
            rulesKey: 'phone_format_intro_rules',
            placeholder: '手机格式开头',
            placementMode: 'phone_format', positionOptions: PHONE_FORMAT_POSITION_OPTIONS, defaultPosition: 'history_before', defaultDepth: 1,
            metaChips: [
                phoneFormatPlacementChip('phone_format_intro_position', 'phone_format_intro_depth'),
                { label: '顺序 1/4', tone: 'placement' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'phone-format-chat', title: 'QQ聊天格式',
            enabledKey: 'phone_format_chat_enabled',
            positionKey: 'phone_format_chat_position', depthKey: 'phone_format_chat_depth',
            rulesKey: 'phone_format_chat_rules',
            placeholder: 'QQ聊天格式说明',
            placementMode: 'phone_format', positionOptions: PHONE_FORMAT_POSITION_OPTIONS, defaultPosition: 'history_before', defaultDepth: 1,
            metaChips: [
                phoneFormatPlacementChip('phone_format_chat_position', 'phone_format_chat_depth'),
                { label: '表情包自动填充', tone: 'dynamic' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'phone-format-moment', title: 'QQ空间格式',
            enabledKey: 'phone_format_moment_enabled',
            positionKey: 'phone_format_moment_position', depthKey: 'phone_format_moment_depth',
            rulesKey: 'phone_format_moment_rules',
            placeholder: 'QQ空间格式说明',
            placementMode: 'phone_format', positionOptions: PHONE_FORMAT_POSITION_OPTIONS, defaultPosition: 'history_before', defaultDepth: 1,
            metaChips: [
                phoneFormatPlacementChip('phone_format_moment_position', 'phone_format_moment_depth'),
                { label: '动态格式', tone: 'dynamic' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'phone-format-footer', title: '手机格式结尾',
            enabledKey: 'phone_format_footer_enabled',
            positionKey: 'phone_format_footer_position', depthKey: 'phone_format_footer_depth',
            rulesKey: 'phone_format_footer_rules',
            placeholder: '手机格式结尾',
            placementMode: 'phone_format', positionOptions: PHONE_FORMAT_POSITION_OPTIONS, defaultPosition: 'history_before', defaultDepth: 1,
            metaChips: [
                phoneFormatPlacementChip('phone_format_footer_position', 'phone_format_footer_depth'),
                { label: '顺序 4/4', tone: 'placement' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'dialogue', title: '私聊提示词',
            enabledKey: 'dialogue_enabled', positionKey: 'dialogue_position',
            depthKey: 'dialogue_depth', roleKey: 'dialogue_role',
            rulesKey: 'dialogue_rules', defaultDepth: 1, placeholder: '私聊协议提示词',
            metaChips: [
                { label: '私聊', tone: 'scope' },
                { label: '位置可调', tone: 'placement' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'moment', title: '动态发布决策提示词',
            enabledKey: 'moment_create_enabled', positionKey: 'moment_create_position',
            depthKey: 'moment_create_depth', roleKey: 'moment_create_role',
            rulesKey: 'moment_create_rules', defaultDepth: 0, placeholder: '动态发布决策提示词',
            metaChips: [
                { label: '动态发布', tone: 'scope' },
                { label: '条件发送', tone: 'dynamic' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'moment-comment', title: '动态评论回复提示词',
            enabledKey: 'moment_comment_enabled', positionKey: 'moment_comment_position',
            depthKey: 'moment_comment_depth', roleKey: 'moment_comment_role',
            rulesKey: 'moment_comment_rules', defaultDepth: 0, placeholder: '动态评论回复规则',
            metaChips: [
                { label: '动态评论', tone: 'scope' },
                { label: '位置可调', tone: 'placement' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'moment-publish-comment', title: '发布后评论提示词',
            enabledKey: 'moment_publish_comment_enabled', positionKey: 'moment_publish_comment_position',
            depthKey: 'moment_publish_comment_depth', roleKey: 'moment_publish_comment_role',
            rulesKey: 'moment_publish_comment_rules', defaultDepth: 0, placeholder: '用户发布动态后的评论规则',
            metaChips: [
                { label: '发布后评论', tone: 'scope' },
                { label: '位置可调', tone: 'placement' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'auto-image-prompt', title: '自动标签生图提示词',
            enabledKey: 'auto_image_prompt_enabled', positionKey: 'auto_image_prompt_position',
            depthKey: 'auto_image_prompt_depth', roleKey: 'auto_image_prompt_role',
            rulesKey: 'auto_image_prompt_rules', defaultDepth: 0, placeholder: '自动标签生图提示词',
            metaChips: [
                { label: '生图', tone: 'scope' },
                { label: '通用设定', tone: 'dynamic' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'group', title: '群聊提示词',
            enabledKey: 'group_enabled', positionKey: 'group_position',
            depthKey: 'group_depth', roleKey: 'group_role',
            rulesKey: 'group_rules', defaultDepth: 1, placeholder: '群聊协议提示词',
            metaChips: [
                { label: '群聊', tone: 'scope' },
                { label: '位置可调', tone: 'placement' },
            ],
        }));
        list.appendChild(makePromptBlock({
            idPrefix: 'summary', title: '摘要提示词',
            enabledKey: 'summary_enabled', positionKey: 'summary_position',
            depthKey: 'summary_depth', roleKey: 'summary_role',
            rulesKey: 'summary_rules', defaultDepth: 1, placeholder: '摘要格式提示词',
            positionOptions: fixedDepthOpts, showDepthRole: false,
            metaChips: [
                { label: '摘要', tone: 'scope' },
                { label: '记忆模式替代', tone: 'replace' },
            ],
        }));

        // Default preset format reminder block (runtime-generated; legacy ds_format_* kept for import compatibility).
        {
            const card = document.createElement('div');
            card.className = 'pp-block';
            card.dataset.collapsed = 'true';
            card.dataset.promptId = 'ds-format';

            const header = document.createElement('div');
            header.className = 'pp-block-header';
            const left = document.createElement('div');
            left.className = 'pp-block-left';
            const toggle = document.createElement('div');
            toggle.className = 'pp-block-toggle';
            toggle.innerHTML = '&#9656;';
            left.appendChild(toggle);
            const main = document.createElement('div');
            main.className = 'pp-block-main';
            const title = document.createElement('div');
            title.className = 'pp-block-title';
            title.textContent = 'Default 格式提醒（自动）';
            main.appendChild(title);
            const meta = document.createElement('div');
            meta.className = 'pp-block-meta';
            [
                { label: 'Default', tone: 'scope' },
                { label: '自动生成', tone: 'dynamic' },
            ].forEach(chip => {
                const el = document.createElement('span');
                el.className = `pp-meta-chip is-${chip.tone}`;
                el.textContent = chip.label;
                meta.appendChild(el);
            });
            main.appendChild(meta);
            left.appendChild(main);
            header.appendChild(left);
            card.appendChild(header);

            const body = document.createElement('div');
            body.className = 'pp-block-body';
            const enabledInput = document.createElement('input');
            enabledInput.type = 'hidden';
            enabledInput.id = 'ds-format-enabled';
            enabledInput.checked = true;
            const rulesInput = document.createElement('textarea');
            rulesInput.id = 'ds-format-rules';
            rulesInput.style.display = 'none';
            rulesInput.value = p.ds_format_rules || '';
            body.appendChild(enabledInput);
            body.appendChild(rulesInput);
            const info = document.createElement('div');
            info.className = 'pp-help';
            info.style.cssText = 'margin-bottom:10px; color:var(--app-text-secondary); font-size:12px; line-height:1.6;';
            info.textContent = '运行时按当前场景生成格式提醒。';
            body.appendChild(info);
            const preview = document.createElement('pre');
            preview.className = 'pp-code-preview';
            preview.style.cssText = 'margin:0; padding:12px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-hover); color:var(--app-text-primary); white-space:pre-wrap; font-size:12px; line-height:1.5;';
            preview.textContent = [
                getLocalizedPromptText('transport.scenario_private').split('{name}').join('XX'),
                '',
                buildBuiltinPhoneFormatReminder({
                    surface: 'private_chat',
                    userName: '我',
                    targetName: 'XX',
                    includeTableEdit: true,
                }),
            ].join('\n');
            body.appendChild(preview);
            card.appendChild(body);

            const setCollapsed = (collapsed) => {
                card.dataset.collapsed = collapsed ? 'true' : 'false';
                const t = header.querySelector('.pp-block-toggle');
                if (t) t.innerHTML = collapsed ? '&#9656;' : '&#9662;';
                body.style.display = collapsed ? 'none' : 'block';
            };
            header.addEventListener('click', () => setCollapsed(card.dataset.collapsed !== 'true'));
            const shouldFocus = focusPromptId === 'ds-format';
            setCollapsed(!shouldFocus);
            if (shouldFocus) focusTarget = card;
            list.appendChild(card);
        }

        wrap.appendChild(list);
        if (focusTarget) {
            const focusBlock = () => {
                const reduceMotion = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
                focusTarget.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
                focusTarget.classList.add('is-jump-target');
                globalThis.window?.setTimeout?.(() => {
                    focusTarget.classList.remove('is-jump-target');
                }, 1400);
                focusTarget.querySelector?.('.pp-block-body textarea:not([style*="display: none"]), .pp-block-body select, .pp-block-body input')?.focus?.({ preventScroll: true });
            };
            if (globalThis.window?.requestAnimationFrame) {
                globalThis.window.requestAnimationFrame(focusBlock);
            } else {
                focusBlock();
            }
        }
        return wrap;
    }

    /* ── Context ── */
    renderContextEditor(p) {
        const wrap = document.createElement('div');

        wrap.appendChild(this.renderTextarea('Story String', 'context-story', p.story_string || '', '{{#if description}}{{description}}{{/if}} ...', 'ST 的 story_string 模板，支持 {{#if}} 与变量'));

        const pos = document.createElement('select');
        pos.id = 'context-position'; pos.className = 'pp-input';
        pos.innerHTML = `
	            <option value="${EXT_PROMPT_TYPES.IN_PROMPT}">IN_PROMPT（main 末尾）</option>
	            <option value="${EXT_PROMPT_TYPES.IN_CHAT}">IN_CHAT（按 depth/role）</option>
	            <option value="${EXT_PROMPT_TYPES.BEFORE_LATEST_USER}">最新输入前</option>
	            <option value="${EXT_PROMPT_TYPES.AFTER_LATEST_USER}">最新输入后</option>
	            <option value="${EXT_PROMPT_TYPES.BEFORE_PROMPT}">BEFORE_PROMPT（main 开头）</option>
	            <option value="${EXT_PROMPT_TYPES.NONE}">NONE（不注入）</option>
        `;
        pos.value = String(p.story_string_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
        const posWrap = this.wrapSelectWithCustomUI(pos, '注入位置');

        const depth = document.createElement('input');
        depth.id = 'context-depth'; depth.type = 'number'; depth.inputMode = 'numeric'; depth.min = '0';
        depth.className = 'pp-input'; depth.value = String(p.story_string_depth ?? 1);

        const role = document.createElement('select');
        role.id = 'context-role'; role.className = 'pp-input';
        role.innerHTML = `
            <option value="${EXT_PROMPT_ROLES.SYSTEM}">SYSTEM</option>
            <option value="${EXT_PROMPT_ROLES.USER}">USER</option>
            <option value="${EXT_PROMPT_ROLES.ASSISTANT}">ASSISTANT</option>
        `;
        role.value = String(p.story_string_role ?? EXT_PROMPT_ROLES.SYSTEM);
        const roleWrap = this.wrapSelectWithCustomUI(role, '角色');

        const ctxRow = this.renderInputRow([
            { label: '注入位置', el: posWrap },
            { label: '深度（IN_CHAT）', el: depth },
            { label: '角色（IN_CHAT）', el: roleWrap },
        ]);
        wrap.appendChild(ctxRow);
        this.bindCustomSelect('context-position', ctxRow);
        this.bindCustomSelect('context-role', ctxRow);

        const exSep = document.createElement('input');
        exSep.id = 'context-example-sep'; exSep.type = 'text'; exSep.className = 'pp-input';
        exSep.value = p.example_separator ?? '';
        const chatStart = document.createElement('input');
        chatStart.id = 'context-chat-start'; chatStart.type = 'text'; chatStart.className = 'pp-input';
        chatStart.value = p.chat_start ?? '';
        wrap.appendChild(this.renderInputRow([
            { label: 'Example Separator', el: exSep },
            { label: 'Chat Start', el: chatStart },
        ]));

        const flags = document.createElement('div');
        flags.className = 'pp-flags';
        flags.innerHTML = `
            <label><input id="context-names-stop" type="checkbox">Names as stop strings</label>
            <label><input id="context-use-stop" type="checkbox">Use stop strings</label>
            <label><input id="context-trim" type="checkbox">Trim sentences</label>
            <label><input id="context-single" type="checkbox">Single line</label>
        `;
        flags.querySelector('#context-names-stop').checked = Boolean(p.names_as_stop_strings);
        flags.querySelector('#context-use-stop').checked = Boolean(p.use_stop_strings);
        flags.querySelector('#context-trim').checked = Boolean(p.trim_sentences);
        flags.querySelector('#context-single').checked = Boolean(p.single_line);
        wrap.appendChild(flags);

        return wrap;
    }

    /* ── Instruct ── */
    renderInstructEditor(p) {
        const wrap = document.createElement('div');
        const desc = document.createElement('div');
        desc.style.cssText = 'color:var(--app-text-muted); font-size:12px; margin-bottom:4px;';
        desc.textContent = '序列 / 包裹 / 宏（目前仅保存，暂未用于构建）';
        wrap.appendChild(desc);

        const make = (id, val) => { const el = document.createElement('input'); el.id = id; el.type = 'text'; el.className = 'pp-input'; el.value = val ?? ''; return el; };
        wrap.appendChild(this.renderInputRow([
            { label: 'Input sequence', el: make('ins-input-seq', p.input_sequence) },
            { label: 'Output sequence', el: make('ins-output-seq', p.output_sequence) },
        ]));
        wrap.appendChild(this.renderInputRow([
            { label: 'System sequence', el: make('ins-system-seq', p.system_sequence) },
            { label: 'Stop sequence', el: make('ins-stop-seq', p.stop_sequence) },
        ]));

        const flags = document.createElement('div');
        flags.className = 'pp-flags';
        flags.innerHTML = `
            <label><input id="ins-wrap" type="checkbox">Wrap</label>
            <label><input id="ins-macro" type="checkbox">Macro</label>
            <label><input id="ins-skip-examples" type="checkbox">Skip examples</label>
        `;
        flags.querySelector('#ins-wrap').checked = Boolean(p.wrap);
        flags.querySelector('#ins-macro').checked = Boolean(p.macro);
        flags.querySelector('#ins-skip-examples').checked = Boolean(p.skip_examples);
        wrap.appendChild(flags);

        return wrap;
    }

    /* ── Reasoning ── */
    renderReasoningEditor(p) {
        const wrap = document.createElement('div');
        const settings = appSettings.get();

        const flags = document.createElement('div');
        flags.className = 'pp-flags';
        flags.innerHTML = `
            <label><input id="reasoning-auto-parse" type="checkbox">自动解析推理</label>
            <label><input id="reasoning-auto-expand" type="checkbox">自动展开</label>
            <label><input id="reasoning-show-hidden" type="checkbox">显示隐藏推理</label>
            <label><input id="reasoning-add-prompts" type="checkbox">写回提示词</label>
        `;
        flags.querySelector('#reasoning-auto-parse').checked = settings.reasoningAutoParse === true;
        flags.querySelector('#reasoning-auto-expand').checked = settings.reasoningAutoExpand === true;
        flags.querySelector('#reasoning-show-hidden').checked = settings.reasoningShowHidden === true;
        flags.querySelector('#reasoning-add-prompts').checked = settings.reasoningAddToPrompts === true;

        const bindSetting = (el, key) => {
            if (!el) return;
            el.addEventListener('change', () => {
                appSettings.update({ [key]: el.checked === true });
                window.dispatchEvent(new CustomEvent('reasoning-settings-changed'));
            });
        };
        bindSetting(flags.querySelector('#reasoning-auto-parse'), 'reasoningAutoParse');
        bindSetting(flags.querySelector('#reasoning-auto-expand'), 'reasoningAutoExpand');
        bindSetting(flags.querySelector('#reasoning-show-hidden'), 'reasoningShowHidden');
        bindSetting(flags.querySelector('#reasoning-add-prompts'), 'reasoningAddToPrompts');
        wrap.appendChild(flags);

        const maxAdditions = document.createElement('input');
        maxAdditions.id = 'reasoning-max-additions';
        maxAdditions.type = 'number'; maxAdditions.min = '0'; maxAdditions.step = '1';
        maxAdditions.className = 'pp-input';
        maxAdditions.value = String(Number.isFinite(Number(settings.reasoningMaxAdditions)) ? settings.reasoningMaxAdditions : 1);
        maxAdditions.addEventListener('input', () => {
            const n = Math.trunc(Number(maxAdditions.value));
            const safe = Number.isFinite(n) ? Math.max(0, n) : 1;
            maxAdditions.value = String(safe);
            appSettings.update({ reasoningMaxAdditions: safe });
            window.dispatchEvent(new CustomEvent('reasoning-settings-changed'));
        });
        wrap.appendChild(this.renderInputRow([{ label: '写回上限（max additions）', el: maxAdditions }]));

        const makeCodeArea = (id, value, label) => {
            const box = document.createElement('div');
            box.style.marginTop = '10px';
            const lbl = document.createElement('div');
            lbl.className = 'pp-field-label'; lbl.textContent = label;
            const ta = document.createElement('textarea');
            ta.id = id; ta.spellcheck = false; ta.className = 'pp-textarea';
            ta.style.minHeight = '80px'; ta.value = value || '';
            box.appendChild(lbl); box.appendChild(ta);
            return box;
        };

        wrap.appendChild(makeCodeArea('reasoning-prefix', p.prefix || '', '推理前缀（prefix）'));
        wrap.appendChild(makeCodeArea('reasoning-suffix', p.suffix || '', '推理后缀（suffix）'));
        wrap.appendChild(makeCodeArea('reasoning-separator', p.separator || '', '推理分隔（separator）'));

        return wrap;
    }

    /* ── OpenAI Params ── */
    renderOpenAIParamsEditor(p) {
        const wrap = document.createElement('div');
        const apiProfile = this.getBoundProfileForPreset(p) || {};
        const markExclusion = (label, field) => {
            const paths = getPresetParamExclusions(field, apiProfile);
            if (!label || !paths.length) return;
            const badge = document.createElement('span');
            badge.className = 'pp-api-param-excluded has-help';
            badge.tabIndex = 0;
            badge.dataset.paramField = field;
            badge.dataset.help = t('当前 API：{name}；排除字段：{paths}。可在 API 配置的请求参数中调整。', { name: apiProfile.name || apiProfile.provider || 'API', paths: paths.join(', ') });
            badge.textContent = t('当前 API 已排除');
            label.appendChild(badge);
        };

        const maxContext = document.createElement('input');
        maxContext.id = 'gen-max-context'; maxContext.type = 'range';
        maxContext.min = '256'; maxContext.max = '200000'; maxContext.step = '256';
        maxContext.style.width = '100%';
        maxContext.value = String(p.openai_max_context ?? 131072);

        const maxContextNum = document.createElement('input');
        maxContextNum.id = 'gen-max-context-num'; maxContextNum.type = 'number'; maxContextNum.step = '1';
        maxContextNum.className = 'pp-input';
        maxContextNum.value = String(p.openai_max_context ?? 131072);

        const syncMaxContext = (val) => {
            const n = Number(val);
            if (!Number.isFinite(n)) return;
            const clamped = Math.max(0, Math.min(200000, Math.trunc(n)));
            maxContext.value = String(clamped);
            maxContextNum.value = String(clamped);
        };
        maxContext.addEventListener('input', () => syncMaxContext(maxContext.value));
        maxContextNum.addEventListener('input', () => syncMaxContext(maxContextNum.value));

        const make = (id, val, step) => {
            const el = document.createElement('input');
            el.id = id; el.type = 'number'; el.step = step || '0.01';
            el.className = 'pp-input'; el.value = String(val);
            return el;
        };

        const temperature = make('gen-temperature', p.temperature ?? 1);
        const topP = make('gen-top-p', p.top_p ?? 0.98);
        const topK = make('gen-top-k', p.top_k ?? 64, '1');
        const maxTokens = make('gen-max-tokens', p.openai_max_tokens ?? 8192, '1');
        const presence = make('gen-presence', p.presence_penalty ?? 0);
        const frequency = make('gen-frequency', p.frequency_penalty ?? 0);

        const ctxBlock = document.createElement('div');
        ctxBlock.style.marginTop = '4px';
        ctxBlock.innerHTML = `
            <div class="pp-field-label has-help" data-help="用于限制可用上下文窗口。">最大上下文长度（max_context）</div>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <div style="flex:2; min-width:200px;" id="gen-max-context-range-wrap"></div>
                <div style="flex:1; min-width:140px;" id="gen-max-context-num-wrap"></div>
            </div>
        `;
        ctxBlock.querySelector('#gen-max-context-range-wrap').appendChild(maxContext);
        ctxBlock.querySelector('#gen-max-context-num-wrap').appendChild(maxContextNum);
        wrap.appendChild(ctxBlock);

        wrap.appendChild(this.renderInputRow([
            { label: 'temperature', el: temperature },
            { label: 'top_p', el: topP },
            { label: 'top_k', el: topK },
        ]));
        wrap.appendChild(this.renderInputRow([
            { label: 'max_output_tokens', el: maxTokens },
            { label: 'presence_penalty', el: presence },
            { label: 'frequency_penalty', el: frequency },
        ]));

        const { provider, model, baseUrl, capability, samplerPolicy } = this.getReasoningCapabilityForPreset(p);
        const normalizedReasoningEffort = normalizeReasoningEffort(
            p.reasoning_effort,
            'high',
            { allowCustom: true },
        );
        const capabilityLabel = provider && model
            ? `${provider} / ${model}`
            : (provider || model || '未绑定可识别模型');

        if (capability.supported && capability.requestControl) {
            const reasoningCard = document.createElement('div');
            reasoningCard.className = 'pp-reasoning-card';
            const title = document.createElement('div');
            title.className = 'pp-field-label';
            title.textContent = '推理请求';
            markExclusion(title, 'reasoning');
            reasoningCard.appendChild(title);

            const meta = document.createElement('div');
            meta.style.cssText = 'color:var(--app-text-muted); font-size:12px; margin-top:4px; line-height:1.5;';
            meta.textContent = `当前模型：${capabilityLabel}`;
            reasoningCard.appendChild(meta);

            const requestLabel = document.createElement('label');
            requestLabel.style.cssText = 'display:flex; gap:10px; align-items:flex-start; margin-top:10px; cursor:pointer;';
            const requestReasoning = document.createElement('input');
            requestReasoning.id = 'gen-request-reasoning';
            requestReasoning.type = 'checkbox';
            requestReasoning.checked = p.request_reasoning === true;
            requestReasoning.style.marginTop = '2px';
            requestLabel.appendChild(requestReasoning);

            const requestTextWrap = document.createElement('div');
            requestTextWrap.style.flex = '1';
            const requestText = document.createElement('div');
            requestText.style.cssText = 'font-weight:700; color:var(--app-text-primary);';
            requestText.textContent = '请求推理';
            requestText.className = 'has-help';
            requestText.setAttribute('data-help', '按当前模型的接口显式附加推理参数；关闭则不额外请求。');
            requestText.setAttribute('data-help-mode', 'press');
            requestTextWrap.appendChild(requestText);
            requestLabel.appendChild(requestTextWrap);
            reasoningCard.appendChild(requestLabel);

            let reasoningEffort = null;
            let reasoningEffortInput = null;
            let reasoningEffortToggle = null;
            const effortWrap = document.createElement('div');
            effortWrap.style.marginTop = '10px';
            if (capability.effortControl) {
                const effortSelectWrap = document.createElement('div');
                effortSelectWrap.style.width = '100%';
                const effortOptions = buildReasoningEffortComboboxOptions(
                    capability.effortOptions,
                    normalizedReasoningEffort,
                );
                reasoningEffort = document.createElement('select');
                reasoningEffort.id = 'gen-reasoning-effort';
                reasoningEffort.style.display = 'none';
                effortOptions.forEach((item) => {
                    const opt = document.createElement('option');
                    opt.value = item.value;
                    opt.textContent = item.label;
                    reasoningEffort.appendChild(opt);
                });
                reasoningEffort.value = effortOptions.some((item) => item.value === normalizedReasoningEffort)
                    ? normalizedReasoningEffort
                    : (effortOptions[0]?.value || 'high');

                const effortCombobox = document.createElement('div');
                effortCombobox.className = 'pp-reasoning-effort-combobox';
                reasoningEffortInput = document.createElement('input');
                reasoningEffortInput.id = 'gen-reasoning-effort-input';
                reasoningEffortInput.type = 'text';
                reasoningEffortInput.className = 'pp-input pp-reasoning-effort-input';
                reasoningEffortInput.placeholder = '输入中文标签或 API 英文值';
                reasoningEffortToggle = document.createElement('button');
                reasoningEffortToggle.type = 'button';
                reasoningEffortToggle.className = 'pp-reasoning-effort-toggle';
                reasoningEffortToggle.innerHTML = '<span aria-hidden="true">▾</span>';
                effortCombobox.appendChild(reasoningEffortInput);
                effortCombobox.appendChild(reasoningEffortToggle);
                effortSelectWrap.appendChild(reasoningEffort);
                effortSelectWrap.appendChild(effortCombobox);
                effortWrap.appendChild(this.renderInputRow([
                    { label: '推理强度', el: effortSelectWrap },
                ]));
                this.bindReasoningEffortCombobox({
                    selectEl: reasoningEffort,
                    inputEl: reasoningEffortInput,
                    toggleEl: reasoningEffortToggle,
                    options: effortOptions,
                    allowCustom: capability.allowCustomEffort === true,
                });
            }
            reasoningCard.appendChild(effortWrap);

            const reasoningHint = document.createElement('div');
            reasoningHint.style.cssText = 'color:var(--app-text-muted); font-size:12px; margin-top:10px; line-height:1.5;';
            reasoningCard.appendChild(reasoningHint);

            const samplingControls = {
                temperature,
                top_p: topP,
                top_k: topK,
            };

            const syncReasoningUi = () => {
                const effortDisabled = requestReasoning.checked !== true;
                if (reasoningEffort) reasoningEffort.disabled = effortDisabled;
                if (reasoningEffortInput) reasoningEffortInput.disabled = effortDisabled;
                if (reasoningEffortToggle) reasoningEffortToggle.disabled = effortDisabled;
                const activeSamplerPolicy = getReasoningSamplerPolicy({
                    provider,
                    model,
                    baseUrl,
                    requestReasoning: requestReasoning.checked === true,
                });
                Object.entries(samplingControls).forEach(([field, el]) => {
                    if (!el) return;
                    el.disabled = activeSamplerPolicy.disabledFields.includes(field);
                });
                const disabledFieldLabels = [];
                if (activeSamplerPolicy.disabledFields.includes('temperature')) disabledFieldLabels.push('temperature');
                if (activeSamplerPolicy.disabledFields.includes('top_p')) disabledFieldLabels.push('top_p');
                if (activeSamplerPolicy.disabledFields.includes('top_k')) disabledFieldLabels.push('top_k');
                const disabledText = disabledFieldLabels.length
                    ? ` 已自动停用：${disabledFieldLabels.join(' / ')}。`
                    : '';
                const reasoningOptions = buildReasoningRequestOptions({
                    provider,
                    model,
                    baseUrl,
                    requestReasoning: requestReasoning.checked === true,
                    reasoningEffort: reasoningEffort?.value || normalizedReasoningEffort,
                    maxOutputTokens: Number(maxTokens.value) || undefined,
                });
                const routePreference = resolveChatStructuredThinkingPreference({
                    config: { provider, model, baseUrl },
                    thinkingEnabled: requestReasoning.checked === true,
                    reasoningOptions,
                    preference: appSettings.get().chatStructuredThinkingPreference,
                });
                const routeHint = formatChatStructuredThinkingDisclosure(routePreference);
                reasoningHint.textContent = `${capability.hint || ''}${disabledText}${routeHint ? ` ${routeHint}` : ''}`.trim();
            };
            requestReasoning.addEventListener('change', () => {
                if (
                    requestReasoning.checked === true &&
                    reasoningEffort &&
                    reasoningEffort.value === 'auto' &&
                    capability.effortOptions.some((item) => item.value === 'high')
                ) {
                    reasoningEffort.value = 'high';
                    reasoningEffort.dispatchEvent(new Event('change', { bubbles: true }));
                }
                syncReasoningUi();
            });
            Object.entries(samplingControls).forEach(([field, el]) => {
                if (!el) return;
                if (samplerPolicy.disabledFields.includes(field)) {
                    el.disabled = true;
                }
            });
            syncReasoningUi();
            wrap.appendChild(reasoningCard);
        }

        const viewHint = document.createElement('div');
        viewHint.style.cssText = 'color:var(--app-text-muted); font-size:12px; margin:10px 0 4px;';
        viewHint.textContent = '默认回复视角。聊天界面与创意写作界面分开保存；不额外增加聊天区按钮。';
        wrap.appendChild(viewHint);

        const makeTargetSelect = (id, value, fallback) => {
            const el = document.createElement('select');
            el.id = id;
            el.className = 'pp-input';
            el.innerHTML = `
                <option value="character">角色（{{char}}）</option>
                <option value="user">用户（{{user}}）</option>
            `;
            const next = String(value || '').trim().toLowerCase();
            el.value = next === 'user' ? 'user' : (String(fallback || '').trim().toLowerCase() === 'user' ? 'user' : 'character');
            return el;
        };

        const chatTarget = makeTargetSelect('gen-response-target-chat', p.response_target_chat, 'character');
        const chatTargetWrap = this.wrapSelectWithCustomUI(chatTarget, '回复视角');
        const rpTarget = makeTargetSelect('gen-response-target-rp', p.response_target_rp, 'user');
        const rpTargetWrap = this.wrapSelectWithCustomUI(rpTarget, '回复视角');
        const targetRow = this.renderInputRow([
            { label: '聊天界面回复视角', el: chatTargetWrap },
            { label: '创意写作界面回复视角', el: rpTargetWrap },
        ]);
        wrap.appendChild(targetRow);
        this.bindCustomSelect('gen-response-target-chat', targetRow);
        this.bindCustomSelect('gen-response-target-rp', targetRow);

        for (const [id, field] of [['gen-temperature', 'temperature'], ['gen-top-p', 'top_p'], ['gen-top-k', 'top_k'],
            ['gen-max-tokens', 'max_output_tokens'], ['gen-presence', 'presence_penalty'], ['gen-frequency', 'frequency_penalty']]) {
            markExclusion(wrap.querySelector('#' + id)?.parentElement?.querySelector('.pp-field-label'), field);
        }

        return wrap;
    }

    /* ── OpenAI Blocks (custom) ── */
    renderOpenAIBlocksEditor(p) {
        const wrap = document.createElement('div');

        const savedPreset = this.store.getActive('openai') || {};
        const savedPrompts = Array.isArray(savedPreset.prompts) ? savedPreset.prompts : [];
        const savedPromptById = new Map();
        savedPrompts.forEach(pr => { if (pr?.identifier) savedPromptById.set(pr.identifier, pr); });

        const pickPromptOrderBlock = () => {
            const arr = Array.isArray(p.prompt_order) ? p.prompt_order : [];
            const byId = (id) => arr.find(b => b && typeof b === 'object' && String(b.character_id) === String(id));
            return byId(100001) || byId(100000) || arr[0] || null;
        };
        const prompts = Array.isArray(p.prompts) ? p.prompts : [];
        const promptById = new Map();
        prompts.forEach(pr => { if (pr?.identifier) promptById.set(pr.identifier, pr); });
        // 懒渲染数据载体：列表只建轻量卡（重型预设百余区块秒开），编辑草稿进 Map，
        // 保存时由 collectSectionData 合并。草稿跨面板开合缓存（关掉界面不丢；发送始终用已保存内容），
        // 仅在切换预设（防跨预设污染）、点保存（已入库）或点取消（回滚）时清空。
        const draftScope = `openai:${this.store.getActiveId('openai') || ''}`;
        if (this.openaiBlockDraftsScope !== draftScope || !(this.openaiBlockDrafts instanceof Map)) {
            this.openaiBlockDrafts = new Map();
            this.openaiDeletedBlockIds = new Set();
            this.openaiBlockDraftsScope = draftScope;
        }
        this.openaiBlockBase = savedPromptById;
        const orderBlock = pickPromptOrderBlock();
        const order = Array.isArray(orderBlock?.order) ? orderBlock.order : [];

        const blocks = order.length
            ? order.map(o => ({ identifier: o.identifier, enabled: o.enabled !== false }))
            : prompts.filter(pr => pr?.identifier).map(pr => ({ identifier: pr.identifier, enabled: true }));

        const headRow = document.createElement('div');
        headRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; flex-wrap:wrap;';
        headRow.innerHTML = `
            <div style="color:var(--app-text-muted); font-size:12px;">点击区块进入编辑；按住 ☰ 拖动排序</div>
            <button type="button" id="openai-add-block" style="padding:6px 10px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-card); cursor:pointer; font-size:12px;">+ 新增区块</button>
        `;
        wrap.appendChild(headRow);

        // 注入选择条：聊天场景系统注入（记忆表格/私聊/群聊/聊天记录/图片/动态发布）
        // 的启用与预览开关；开关本体在 agent-center settings / 通用设定，点亮即写入并同步预览
        const injectBar = document.createElement('div');
        injectBar.className = 'pp-inject-bar';
        injectBar.id = 'pp-inject-bar';
        this.injectBarEl = injectBar;
        wrap.appendChild(injectBar);

        // 搜索/过滤：可查标题与提示词正文；范围切换（全部/标题/正文）代替命中排序——
        // 区块顺序即注入顺序（数据），过滤保持原序不重排；搜索中隐藏拖拽柄防误排。
        const searchRow = document.createElement('div');
        searchRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:8px; flex-wrap:wrap;';
        searchRow.innerHTML = `
            <input type="search" id="openai-block-search" class="pp-input" placeholder="搜索区块标题 / 提示词正文…" style="flex:1; min-width:180px;">
            <div class="pp-search-scope" role="group" aria-label="搜索范围">
                <button type="button" data-scope="all" class="is-active">全部</button>
                <button type="button" data-scope="title">标题</button>
                <button type="button" data-scope="content">正文</button>
            </div>
        `;
        wrap.appendChild(searchRow);

        const list = document.createElement('div');
        list.id = 'openai-blocks';
        list.style.cssText = 'display:flex; flex-direction:column; gap:10px;';

        // 按住 ☰ 拖动排序（Pointer Events 鼠标/触摸通用）：克隆悬浮幽灵跟随指针，
        // 原卡变虚线占位实时挪动（落点一目了然）；边缘自动滚动；拖后抑制一次点击。
        const dragState = { suppressClick: false };
        const beginBlockDrag = (e, card) => {
            if (this.isPresetMutationBusy()) return;
            e.preventDefault();
            e.stopPropagation();
            const initialOrder = Array.from(list.querySelectorAll('.openai-block'))
                .map(el => el.dataset.identifier || '')
                .join('\u0000');
            const pid = e.pointerId;
            const scroller = list.closest('.pp-page-scroll') || list;
            const ghost = createDragGhost(card, e);
            card.classList.add('pp-block-dragging');
            const onMove = (ev) => {
                if (ev.pointerId !== pid) return;
                dragState.suppressClick = true;
                ghost?.move(ev);
                const y = ev.clientY;
                const sr = scroller.getBoundingClientRect();
                if (y < sr.top + 40) scroller.scrollTop -= 9;
                else if (y > sr.bottom - 40) scroller.scrollTop += 9;
                let before = null;
                for (const el of list.querySelectorAll('.openai-block')) {
                    if (el === card) continue;
                    const cr = el.getBoundingClientRect();
                    if (y < cr.top + cr.height / 2) { before = el; break; }
                }
                if (before) {
                    if (card.nextElementSibling !== before) list.insertBefore(card, before);
                } else if (list.lastElementChild !== card) {
                    list.appendChild(card);
                }
            };
            const onUp = (ev) => {
                if (ev.pointerId !== pid) return;
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                const finish = () => card.classList.remove('pp-block-dragging');
                if (ghost) ghost.settle(card.getBoundingClientRect(), finish);
                else finish();
                const nextOrder = Array.from(list.querySelectorAll('.openai-block'))
                    .map(el => el.dataset.identifier || '')
                    .join('\u0000');
                if (nextOrder !== initialOrder) {
                    this.captureCurrentDetailDraft();
                    this.updateUnsavedIndicator();
                }
                setTimeout(() => { dragState.suppressClick = false; }, 0);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        };

        const makeBlockEl = ({ identifier, enabled }) => {
            const pr = promptById.get(identifier);
            const blockDraft = this.openaiBlockDrafts.get(identifier);
            const known = OPENAI_KNOWN_BLOCKS[identifier];
            const isMarker = Boolean(pr?.marker) || Boolean(known?.marker);
            const canEdit = !isMarker && (typeof pr?.content === 'string' || !pr);
            const title = blockDraft?.name || pr?.name || known?.label || identifier;
            const roleName = roleIdToName(blockDraft?.role || pr?.role || 'system');

            const card = document.createElement('div');
            card.className = `pp-block openai-block ${enabled === false ? 'pp-block-disabled' : ''}`;
            card.dataset.identifier = identifier;
            card.dataset.marker = isMarker ? 'true' : 'false';

            const header = document.createElement('div');
            header.className = 'pp-block-header';
            header.innerHTML = `
                <div class="pp-block-left">
                    <div class="pp-block-drag" aria-label="按住拖动排序">&#9776;</div>
                    <div style="min-width:0;">
                        <div class="pp-block-title" data-i18n-skip>${escapeHtml(translateUiText(title))}</div>
                        <div class="pp-block-sub" data-i18n-skip>${escapeHtml(translateUiText(isMarker ? 'marker（自动填充）' : `role: ${roleName}`))}</div>
                    </div>
                </div>
            `;

            const right = document.createElement('div');
            right.className = 'pp-block-right';
            const enabledWrap = document.createElement('label');
            enabledWrap.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary); cursor:pointer;';
            enabledWrap.innerHTML = `<input type="checkbox" class="block-enabled" style="width:16px; height:16px;">启用`;
            const enabledInput = enabledWrap.querySelector('input');
            enabledInput.checked = enabled !== false;
            enabledInput.addEventListener('click', (e) => e.stopPropagation());
            enabledInput.addEventListener('change', () => {
                card.classList.toggle('pp-block-disabled', !enabledInput.checked);
                this.captureCurrentDetailDraft();
                this.updateUnsavedIndicator();
            });
            // 已修改卡的快捷接受/舍弃操作（.is-modified 时显示）
            const quick = document.createElement('span');
            quick.className = 'pp-block-quick';
            quick.innerHTML = `
                <button type="button" class="pp-diff-accept" aria-label="接受此区块修改并保存" title="接受此区块修改并保存">${diffAcceptSvg}</button>
                <button type="button" class="pp-diff-reject" aria-label="舍弃此区块草稿" title="舍弃此区块草稿">${diffRejectSvg}</button>
            `;
            quick.querySelector('.pp-diff-accept').addEventListener('click', (e) => { e.stopPropagation(); this.acceptBlockDraft(identifier); });
            quick.querySelector('.pp-diff-reject').addEventListener('click', (e) => { e.stopPropagation(); this.rejectBlockDraft(identifier); });
            right.appendChild(quick);
            right.appendChild(enabledWrap);

            if (canEdit) {
                const del = document.createElement('button');
                del.type = 'button'; del.className = 'block-delete';
                del.textContent = '删除';
                del.style.cssText = 'padding:6px 10px; border:1px solid var(--app-danger-border, var(--app-danger-border, #fecaca)); border-radius:10px; background:var(--app-danger-soft, var(--app-danger-soft, #fee2e2)); color:var(--app-danger-text, var(--app-danger-text, #b91c1c)); cursor:pointer; font-size:12px;';
                del.onclick = async (e) => {
                    e.stopPropagation();
                    const blockName = card.querySelector('.pp-block-title')?.textContent?.trim() || identifier;
                    const ok = await appConfirm({ title: '删除区块', message: `删除区块「${blockName}」？`, danger: true });
                    if (ok) {
                        this.openaiDeletedBlockIds.add(identifier);
                        this.openaiBlockDrafts.delete(identifier);
                        card.remove();
                        this.captureCurrentDetailDraft();
                        this.updateUnsavedIndicator();
                    }
                };
                right.appendChild(del);
            }

            header.appendChild(right);
            card.appendChild(header);

            // 懒渲染：列表只有轻量头部卡，名称/role/正文等重内容进入编辑页时才按需构建（数据在 openaiBlockDrafts）

            // 点击卡片（非控件区）进入区块编辑页
            header.addEventListener('click', (e) => {
                if (dragState.suppressClick) return;
                if (e.target && (e.target.closest?.('.block-delete') || e.target.closest?.('label') || e.target.closest?.('.pp-block-drag'))) return;
                this.openOpenAIBlockEditor(card);
            });

            // 按住 ☰ 拖动排序（Pointer Events，鼠标/触摸通用；保存按 DOM 顺序）
            const handle = header.querySelector('.pp-block-drag');
            if (handle) {
                handle.style.touchAction = 'none';
                handle.style.cursor = 'grab';
                handle.addEventListener('pointerdown', (e) => beginBlockDrag(e, card));
            }

            return card;
        };

        blocks.forEach(b => { if (b?.identifier) list.appendChild(makeBlockEl(b)); });
        wrap.appendChild(list);
        this.openaiBlocksListEl = list;
        this.refreshInjectUi();

        const emptyHint = document.createElement('div');
        emptyHint.style.cssText = 'display:none; padding:14px; text-align:center; color:var(--app-text-muted); font-size:12px;';
        emptyHint.textContent = '没有匹配的区块';
        wrap.appendChild(emptyHint);

        const resolveBlockText = (identifier) => {
            const d = this.openaiBlockDrafts.get(identifier);
            const base = promptById.get(identifier);
            const known = OPENAI_KNOWN_BLOCKS[identifier];
            return {
                title: String(d?.name ?? base?.name ?? known?.label ?? identifier),
                content: String(d?.content ?? base?.content ?? ''),
            };
        };
        let filterScope = 'all';
        const searchInput = searchRow.querySelector('#openai-block-search');
        // 关键字高亮：转义后把命中片段包 <mark>
        const highlightMatches = (text, q) => {
            const lower = text.toLowerCase();
            let out = '';
            let pos = 0;
            let idx;
            while (q && (idx = lower.indexOf(q, pos)) >= 0) {
                out += `${escapeHtml(text.slice(pos, idx))}<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`;
                pos = idx + q.length;
            }
            out += escapeHtml(text.slice(pos));
            return out;
        };
        const applyFilter = () => {
            const q = String(searchInput.value || '').trim().toLowerCase();
            const filtering = q.length > 0;
            list.dataset.filtering = filtering ? '1' : '0';
            let hits = 0;
            list.querySelectorAll('.openai-block').forEach((card) => {
                card.querySelector('.pp-block-hit')?.remove();
                const identifier = card.dataset.identifier || '';
                const { title, content } = resolveBlockText(identifier);
                const titleEl = card.querySelector('.pp-block-title');
                if (!filtering) {
                    card.style.display = '';
                    if (titleEl && titleEl.querySelector('mark')) titleEl.textContent = title;
                    return;
                }
                const titleHit = (filterScope !== 'content')
                    && (title.toLowerCase().includes(q) || identifier.toLowerCase().includes(q));
                const contentIdx = (filterScope !== 'title') ? content.toLowerCase().indexOf(q) : -1;
                const hit = titleHit || contentIdx >= 0;
                card.style.display = hit ? '' : 'none';
                if (titleEl) {
                    if (hit && titleHit && title.toLowerCase().includes(q)) titleEl.innerHTML = highlightMatches(title, q);
                    else if (titleEl.querySelector('mark')) titleEl.textContent = title;
                }
                if (!hit) return;
                hits += 1;
                if (contentIdx >= 0) {
                    const start = Math.max(0, contentIdx - 24);
                    const end = Math.min(content.length, contentIdx + q.length + 24);
                    const snippet = `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`.replace(/\s+/g, ' ');
                    const hitEl = document.createElement('div');
                    hitEl.className = 'pp-block-hit';
                    hitEl.innerHTML = `正文：${highlightMatches(snippet, q)}`;
                    card.appendChild(hitEl);
                }
            });
            emptyHint.style.display = filtering && hits === 0 ? 'block' : 'none';
        };
        let filterTimer = null;
        searchInput.addEventListener('input', () => {
            if (filterTimer) clearTimeout(filterTimer);
            filterTimer = setTimeout(applyFilter, 150);
        });
        searchRow.querySelectorAll('.pp-search-scope button').forEach((btn) => {
            btn.onclick = () => {
                filterScope = btn.dataset.scope || 'all';
                searchRow.querySelectorAll('.pp-search-scope button').forEach(b => b.classList.toggle('is-active', b === btn));
                applyFilter();
            };
        });

        headRow.querySelector('#openai-add-block').onclick = async () => {
            // 应用内弹窗：只填名称即可创建；identifier 自动生成（用户无需理解），role 默认 system、内容留空
            const name = await appPromptText({
                title: '新增区块',
                placeholder: '区块名称',
                confirmText: '创建',
            });
            if (name === null) return;
            const finalName = String(name).trim() || '未命名区块';
            let identifier = `custom_${Date.now()}`;
            while (list.querySelector(`.openai-block[data-identifier="${CSS.escape(identifier)}"]`)) {
                identifier = `custom_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
            }
            promptById.set(identifier, { identifier, name: finalName, role: 'system', system_prompt: true, marker: false, content: '' });
            this.openaiDeletedBlockIds.delete(identifier);
            // 新区块必须进草稿 Map，保存合并才不会丢
            this.openaiBlockDrafts.set(identifier, { name: finalName, role: 'system', system_prompt: true, content: '' });
            const card = makeBlockEl({ identifier, enabled: true });
            // 插到列表最上方（注入顺序最前），并直接进入区块编辑页方便继续填写
            list.insertBefore(card, list.firstChild);
            this.captureCurrentDetailDraft();
            this.updateUnsavedIndicator();
            const scroller = list.closest('.pp-page-scroll');
            if (scroller) scroller.scrollTop = 0;
            this.openOpenAIBlockEditor(card);
        };

        return wrap;
    }

    /* 区块独立编辑页：点击列表中的区块进入；对卡内隐藏表单 write-through，保存/草稿链路不变 */
    openOpenAIBlockEditor(card) {
        if (!card || !this.blockEditorEl) return;
        this.currentInjectEditor = '';
        this.injectEditorCommit = null;
        this.injectEditorDirty = false;
        this.currentBlockCard = card;
        const identifier = card.dataset.identifier || '';
        const isMarker = card.dataset.marker === 'true';
        const cardTitleEl = card.querySelector('.pp-block-title');
        const cardSubEl = card.querySelector('.pp-block-sub');
        if (this.blockTitleEl) {
            this.blockTitleEl.dataset.i18nSkip = '';
            this.blockTitleEl.textContent = translateUiText(cardTitleEl?.textContent || identifier);
        }
        if (this.blockSubtitleEl) {
            const cards = this.getBlockCards();
            const pos = cards.indexOf(card);
            this.blockSubtitleEl.textContent = pos >= 0 ? `${pos + 1} / ${cards.length} · ${identifier}` : identifier;
        }
        const host = this.blockEditorEl;
        host.innerHTML = '';
        const mkLabel = (text) => {
            const d = document.createElement('div');
            d.className = 'pp-field-label';
            d.textContent = text;
            return d;
        };
        if (isMarker) {
            const p = document.createElement('div');
            p.style.cssText = 'color:var(--app-text-muted); font-size:13px; line-height:1.7; padding:4px 2px;';
            p.textContent = '该区块为 marker：构建 prompt 时由系统自动填充内容（如世界书、聊天记录等），没有可编辑的正文。可在列表中启用/停用，或按住 ☰ 拖动调整插入顺序。';
            host.appendChild(p);
        } else {
            // 懒渲染：编辑草稿存 openaiBlockDrafts（首次进入时按需从预设数据播种），保存时统一合并
            const draft = this.ensureBlockDraft(identifier);

            const metaRow = document.createElement('div');
            metaRow.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;';
            const nameCell = document.createElement('div');
            nameCell.style.cssText = 'flex:2; min-width:200px;';
            nameCell.appendChild(mkLabel('名称'));
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'pp-input';
            nameInput.placeholder = '区块名称';
            nameInput.value = draft.name || '';
            nameInput.addEventListener('input', () => {
                draft.name = nameInput.value;
                this.scheduleUnsavedIndicatorUpdate();
                const next = nameInput.value || identifier;
                if (cardTitleEl) cardTitleEl.textContent = next;
                if (this.blockTitleEl) this.blockTitleEl.textContent = next;
            });
            nameCell.appendChild(nameInput);
            const roleCell = document.createElement('div');
            roleCell.style.cssText = 'flex:1; min-width:140px;';
            roleCell.appendChild(mkLabel('role'));
            const roleSel = document.createElement('select');
            roleSel.className = 'pp-input';
            roleSel.innerHTML = '<option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option>';
            roleSel.value = draft.role || 'system';
            roleSel.addEventListener('change', () => {
                draft.role = roleSel.value;
                this.scheduleUnsavedIndicatorUpdate();
                if (cardSubEl) cardSubEl.textContent = `role: ${roleSel.value}`;
            });
            roleCell.appendChild(roleSel);
            metaRow.appendChild(nameCell);
            metaRow.appendChild(roleCell);
            host.appendChild(metaRow);

            const sysWrap = document.createElement('label');
            sysWrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:13px; color:var(--app-text-secondary); cursor:pointer; margin-bottom:10px;';
            const sysChk = document.createElement('input');
            sysChk.type = 'checkbox';
            sysChk.style.cssText = 'width:16px; height:16px;';
            sysChk.checked = Boolean(draft.system_prompt);
            sysChk.addEventListener('change', () => { draft.system_prompt = sysChk.checked; this.scheduleUnsavedIndicatorUpdate(); });
            sysWrap.appendChild(sysChk);
            sysWrap.appendChild(document.createTextNode('system_prompt'));
            host.appendChild(sysWrap);

            host.appendChild(mkLabel('提示词正文'));
            const ta = document.createElement('textarea');
            ta.className = 'pp-textarea';
            ta.spellcheck = false;
            ta.style.cssText = 'width:100%; min-height: max(320px, calc(var(--app-visual-height, 100vh) - 420px)); resize: vertical;';
            ta.value = draft.content || '';
            ta.addEventListener('input', () => {
                draft.content = ta.value;
                this.scheduleUnsavedIndicatorUpdate();
                this.schedulePreviewLiveUpdate(identifier);
            });
            // 光标位置 / 正文滚动 / 选区 → 预览联动
            const caretSync = () => {
                this.syncPreviewToCaret(identifier, ta);
                this.syncSelectionToPreview(identifier, ta);
            };
            ta.addEventListener('click', caretSync);
            ta.addEventListener('keyup', caretSync);
            ta.addEventListener('mouseup', () => this.syncSelectionToPreview(identifier, ta));
            ta.addEventListener('select', () => this.syncSelectionToPreview(identifier, ta));
            // 红绿高亮镜像层：textarea 背后按逻辑行镜像草稿，新增行绿底、删除处红线（无按钮，仅提示）
            const taWrap = document.createElement('div');
            taWrap.className = 'pp-ta-diffwrap';
            const taLayer = document.createElement('div');
            taLayer.className = 'pp-ta-difflayer';
            taLayer.setAttribute('aria-hidden', 'true');
            const taMirror = document.createElement('div');
            taMirror.className = 'pp-ta-mirror';
            taLayer.appendChild(taMirror);
            taWrap.appendChild(taLayer);
            taWrap.appendChild(ta);
            const syncLayerScroll = () => { taMirror.style.transform = `translateY(${-ta.scrollTop}px)`; };
            const updateTaDiffLayer = () => {
                if (!ta.isConnected) return;
                const baseC = String(this.openaiBlockBase?.get?.(identifier)?.content ?? '');
                if (String(ta.value ?? '') === baseC) { taMirror.innerHTML = ''; return; }
                const rows = annotateLineDiffWords(buildLineDiff(baseC, ta.value, { collapseContext: false }).rows);
                let html = '';
                for (const r of rows) {
                    if (r.type === 'del') { html += '<div class="pp-ta-delmark"></div>'; continue; }
                    // 改写配对的行：透明文字与编辑框逐字对齐，只给改动的字词铺深底
                    const lineHtml = r.type === 'add' && r.words
                        ? renderWordDiffHtml(r.words, { side: 'new', escape: escapeHtml })
                        : escapeHtml(r.text);
                    html += `<div class="pp-ta-line${r.type === 'add' ? ' pp-ta-add' : ''}${r.words ? ' is-partial' : ''}">${lineHtml}</div>`;
                }
                taMirror.style.width = `${ta.clientWidth}px`;
                taMirror.innerHTML = html;
                syncLayerScroll();
            };
            this._updateTaDiffLayer = updateTaDiffLayer;
            let taScrollTimer = null;
            ta.addEventListener('scroll', () => {
                syncLayerScroll();
                if (this._taAutoScroll) { this._taAutoScroll = false; return; } // 程序滚动回声
                if (taScrollTimer) return;
                taScrollTimer = setTimeout(() => {
                    taScrollTimer = null;
                    this.syncPreviewToEditorScroll(identifier, ta);
                }, 90);
            }, { passive: true });
            host.appendChild(taWrap);
            updateTaDiffLayer();
        }
        this.currentPage = 'block';
        this.setPageView('block');
        // 预览开着时定位到该区块段落：从第一行开始对齐
        // （勿用 caret——textarea 赋值后光标默认在末尾，会先对到区块底部）
        if (this.previewState && this.previewState !== 'closed') {
            const taEl = this.blockEditorEl?.querySelector('textarea');
            if (!this.scrollPreviewToBlockLine(identifier, 0, taEl?.value ?? '')) {
                this.scrollPreviewToBlockRatio(identifier, 0);
            }
        }
    }

    getBlockCards() {
        return Array.from(this.element?.querySelectorAll('#openai-blocks .openai-block') || []);
    }

    /* ════════════════════════════════════════
       任务提示词只读预览（一级列表「任务提示词」）
       动态评论/发布后评论走独立任务组装（触发时关闭手机格式、压掉聊天注入）；
       格式检查完全不经 buildMessages。均不参与自定义区块与注入选择条。
       ════════════════════════════════════════ */
    renderTaskPromptsViewer() {
        const wrap = document.createElement('div');
        const intro = document.createElement('div');
        intro.style.cssText = 'color:var(--app-text-muted); font-size:12px; line-height:1.7; margin-bottom:12px;';
        intro.textContent = '以下提示词只在对应任务触发时独立组装，不参与自定义提示词区块与注入选择条；动态类内容可在 Agent Center 的动态 Agent 卡编辑。';
        wrap.appendChild(intro);
        const { sysp } = this.getInjectSyspromptResolved();
        const posLabel = (position, depth, role) => {
            const pos = Math.trunc(Number(position)) || 0;
            const opt = PROMPT_POSITION_OPTIONS.find(o => o.value === pos);
            const roleText = ['SYSTEM', 'USER', 'ASSISTANT'][Math.trunc(Number(role)) || 0] || 'SYSTEM';
            const depthText = pos === 1 ? ` D${Math.max(0, Math.trunc(Number(depth)) || 0)}` : '';
            return `${opt?.label || pos}${depthText} · ${roleText}`;
        };
        const mkCard = ({ title, chips = [], body = '', foot = '' }) => {
            const card = document.createElement('div');
            card.className = 'pp-block';
            card.dataset.collapsed = 'true';
            const header = document.createElement('div');
            header.className = 'pp-block-header';
            header.style.cursor = 'pointer';
            header.innerHTML = `
                <div class="pp-block-left">
                    <div class="pp-block-toggle">&#9656;</div>
                    <div style="min-width:0;">
                        <div class="pp-block-title">${escapeHtml(title)}</div>
                    </div>
                </div>
                <div class="pp-block-right">${chips.map(c => `<span class="pp-meta-chip is-${escapeHtml(c.tone)}">${escapeHtml(c.label)}</span>`).join('')}</div>
            `;
            const bodyEl = document.createElement('div');
            bodyEl.className = 'pp-block-body';
            bodyEl.style.display = 'none';
            const pre = document.createElement('pre');
            pre.className = 'pp-code-preview';
            pre.style.cssText = 'margin:0; padding:12px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-hover); color:var(--app-text-primary); white-space:pre-wrap; font-size:12px; line-height:1.6;';
            pre.textContent = body || '（空）';
            bodyEl.appendChild(pre);
            if (foot) {
                const f = document.createElement('div');
                f.style.cssText = 'color:var(--app-text-muted); font-size:12px; line-height:1.6; margin-top:8px;';
                f.textContent = foot;
                bodyEl.appendChild(f);
            }
            card.appendChild(header);
            card.appendChild(bodyEl);
            header.addEventListener('click', () => {
                const collapsed = card.dataset.collapsed !== 'true';
                card.dataset.collapsed = collapsed ? 'true' : 'false';
                header.querySelector('.pp-block-toggle').innerHTML = collapsed ? '&#9656;' : '&#9662;';
                bodyEl.style.display = collapsed ? 'none' : 'block';
            });
            return card;
        };
        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
        list.appendChild(mkCard({
            title: '动态评论回复提示词',
            chips: [
                { label: sysp?.moment_comment_enabled ? '启用' : '已停用', tone: sysp?.moment_comment_enabled ? 'dynamic' : 'replace' },
                { label: posLabel(sysp?.moment_comment_position, sysp?.moment_comment_depth, sysp?.moment_comment_role), tone: 'placement' },
            ],
            body: typeof sysp?.moment_comment_rules === 'string' ? sysp.moment_comment_rules : '',
            foot: '触发：用户在动态下评论 / 楼中楼回复。任务组装时关闭手机格式并压掉私聊/群聊等聊天注入，仅注入本规则与动态任务数据块。',
        }));
        list.appendChild(mkCard({
            title: '发布后评论提示词',
            chips: [
                { label: sysp?.moment_publish_comment_enabled ? '启用' : '已停用', tone: sysp?.moment_publish_comment_enabled ? 'dynamic' : 'replace' },
                { label: posLabel(sysp?.moment_publish_comment_position, sysp?.moment_publish_comment_depth, sysp?.moment_publish_comment_role), tone: 'placement' },
            ],
            body: typeof sysp?.moment_publish_comment_rules === 'string' ? sysp.moment_publish_comment_rules : '',
            foot: '触发：用户发布动态后的自动评论任务。组装方式同上。',
        }));
        list.appendChild(mkCard({
            title: '格式检查提示词（固定）',
            chips: [{ label: '独立管线', tone: 'scope' }],
            body: getLocalizedPromptText('format_repair.fixed_preview'),
            foot: '格式检查不经过预设组装：自建 system+user 两条消息、要求 JSON 输出；与自定义提示词区块和注入选择条无关。',
        }));
        wrap.appendChild(list);
        return wrap;
    }

    /* ════════════════════════════════════════
       注入选择条（chip 条）与系统注入卡
       开关本体：sysprompt 类走 agent-center settings（resolve 时覆盖预设键），
       记忆表格走通用设定（memoryTableEnabledChat），聊天记录仅预览态。
       ════════════════════════════════════════ */
    getInjectActions() {
        return window.appBridge?.debugUiRegistry?.actions || {};
    }

    /* 聊天场景下实际生效的 sysprompt 预设（agent-center 覆盖后） */
    getInjectSyspromptResolved() {
        const context = { ...this.getCurrentPresetContext(), uiMode: 'chat' };
        const resolved = this.store?.getResolvedActive?.('sysprompt', context) || null;
        const presetId = String(resolved?.presetId || '').trim();
        const preset = resolved?.preset && typeof resolved.preset === 'object' ? resolved.preset : {};
        const actions = this.getInjectActions();
        let sysp = preset;
        try {
            sysp = actions.resolveAgentSyspromptPresetSync?.({ presetId, preset }) || preset;
        } catch { sysp = preset; }
        return { presetId, preset, sysp };
    }

    /* 聊天场景下实际生效的 openai 预设（记忆位置覆盖后），供记忆卡副标题/编辑页用 */
    getInjectOpenAIResolved() {
        const context = { ...this.getCurrentPresetContext(), uiMode: 'chat' };
        const resolved = this.store?.getResolvedActive?.('openai', context) || null;
        const presetId = String(resolved?.presetId || '').trim();
        const preset = resolved?.preset && typeof resolved.preset === 'object' ? resolved.preset : {};
        const actions = this.getInjectActions();
        let openp = preset;
        try {
            openp = actions.resolveAgentOpenAIPresetSync?.({ presetId, preset }) || preset;
        } catch { openp = preset; }
        return { presetId, preset, openp };
    }

    getInjectSettingsState() {
        return this.runtimeContext.promptInject?.getSettingsState?.() || {};
    }

    /* 适用范围门控（M 分域）：仅创意写作的 openai 预设永远不会被聊天解析到，
       聊天注入 chip/卡/预览对它只是虚构场景——门控为纯展示层，不动存储的展示态 */
    getInjectScopeEligibility() {
        const domScope = this.detailEditorEl?.querySelector?.('#preset-app-scope')?.value;
        const storedScope = this.getActivePresetSnapshot('openai')?.app_scope;
        const scope = normalizePresetAppScope(domScope || storedScope, PRESET_APP_SCOPES.creative);
        return { scope, chatCapable: scope !== PRESET_APP_SCOPES.creative };
    }

    getInjectEffectiveDisplayState() {
        this.ensureInjectStateLoaded();
        const { chatCapable } = this.getInjectScopeEligibility();
        if (!chatCapable) return { chatCapable, added: [], previewScenario: '' };
        return {
            chatCapable,
            added: Array.from(this.injectAdded || []),
            previewScenario: this.previewScenario,
        };
    }

    isCurrentSessionGroup() {
        const sessionId = String(this.runtimeContext.chatStore?.getCurrent?.() || '').trim();
        if (sessionId.startsWith('group:')) return true;
        return Boolean(this.runtimeContext.contactsStore?.getContact?.(sessionId)?.isGroup);
    }

    /* 展示态持久化：按 openai 预设分别记「加入了哪些项 + 预览场景」（纯 UI 状态，不入预设数据） */
    ensureInjectStateLoaded() {
        const presetId = String(this.store?.getActiveId?.('openai') || '').trim();
        if (this.injectStateScope === presetId) return;
        this.injectStateScope = presetId;
        let entry = null;
        try {
            const map = JSON.parse(localStorage.getItem('preset_inject_added_v1') || '{}');
            entry = map && typeof map === 'object' ? map[presetId] : null;
        } catch { entry = null; }
        const items = Array.isArray(entry?.items) ? entry.items : [];
        this.injectAdded = new Set(items.filter(id => ['memory', 'image', 'moment'].includes(id)));
        this.previewScenario = entry?.scenario === 'private' || entry?.scenario === 'group' ? entry.scenario : '';
    }

    saveInjectState() {
        const presetId = String(this.injectStateScope || '').trim();
        if (!presetId) return;
        try {
            const map = JSON.parse(localStorage.getItem('preset_inject_added_v1') || '{}');
            const next = map && typeof map === 'object' ? map : {};
            next[presetId] = { items: Array.from(this.injectAdded || []), scenario: this.previewScenario || '' };
            localStorage.setItem('preset_inject_added_v1', JSON.stringify(next));
        } catch {}
    }

    buildInjectChipStatesNow(sysp = null) {
        const effective = this.getInjectEffectiveDisplayState();
        const resolved = sysp || this.getInjectSyspromptResolved().sysp;
        return buildPresetInjectChipStates({
            sysp: resolved,
            settingsState: this.getInjectSettingsState(),
            added: effective.added,
            previewScenario: effective.previewScenario,
        });
    }

    /* 重绘 chip 条 + 系统注入卡（列表内就地更新，不整体重建二级页）。
       注意：二级页构建期间元素尚未挂载，不能用 isConnected 门控 */
    refreshInjectUi() {
        const bar = this.injectBarEl;
        if (bar) {
            const { sysp } = this.getInjectSyspromptResolved();
            const { chatCapable } = this.getInjectScopeEligibility();
            const scopeLockTitle = '该预设适用范围为「仅创意写作」，不会用于聊天模式；改为「聊天模式」或「全部」后即可预览聊天注入';
            const states = this.buildInjectChipStatesNow(sysp);
            bar.innerHTML = states.map(s => `
                <button type="button"
                    class="pp-inject-chip${s.on ? ' is-on' : ''}${s.warnText ? ' is-warn' : ''}${s.hidden ? ' is-hidden' : ''}${chatCapable ? '' : ' is-scope-locked'}"
                    data-inject-chip="${escapeHtml(s.id)}"
                    aria-pressed="${s.on ? 'true' : 'false'}"
                    ${chatCapable ? '' : 'aria-disabled="true"'}
                    title="${escapeHtml(chatCapable ? (s.warnText || '') : scopeLockTitle)}">
                    <span class="pp-inject-dot"></span><span>${escapeHtml(s.label)}</span>${chatCapable && s.warnText ? `<span class="pp-inject-warn" data-inject-enable="${escapeHtml(s.id)}" title="${escapeHtml(s.warnText)}（点击开启）">!</span>` : ''}
                </button>
            `).join('');
            if (!bar.dataset.bound) {
                bar.dataset.bound = '1';
                bar.addEventListener('click', (e) => {
                    // 仅创意写作预设：chip 全部失效，点击给一句可行动提示
                    if (!this.getInjectScopeEligibility().chatCapable) {
                        this.showStatus('该预设仅用于创意写作；把上方适用范围改为「聊天模式」或「全部」后即可预览聊天注入', 'info');
                        return;
                    }
                    // ! 角标 = 启用入口；chip 本体 = 加入/移除（关闭优先，不被启用弹窗挡住）
                    const warn = e.target?.closest?.('[data-inject-enable]');
                    if (warn) {
                        e.stopPropagation();
                        this.showInjectFeatureDialog(warn.dataset.injectEnable || '');
                        return;
                    }
                    const btn = e.target?.closest?.('[data-inject-chip]');
                    if (btn) this.onInjectChipTap(btn.dataset.injectChip || '');
                });
            }
            this.renderInjectCards(sysp);
        }
    }

    renderInjectCards(sysp = null) {
        const list = this.openaiBlocksListEl;
        if (!list) return;
        list.querySelectorAll('.pp-inject-block').forEach(el => el.remove());
        const effective = this.getInjectEffectiveDisplayState();
        const resolved = sysp || this.getInjectSyspromptResolved().sysp;
        const { openp } = this.getInjectOpenAIResolved();
        const defs = buildInjectCardDefs({
            sysp: resolved,
            settingsState: this.getInjectSettingsState(),
            added: effective.added,
            previewScenario: effective.previewScenario,
            memoryPlacement: {
                guidePosition: openp?.memory_guide_position,
                guideDepth: openp?.memory_guide_depth,
                dataPosition: openp?.memory_data_position,
                dataDepth: openp?.memory_data_depth,
            },
        });
        if (!defs.length) return;
        const mainCard = list.querySelector('.openai-block[data-identifier="main"]');
        const historyCard = list.querySelector('.openai-block[data-identifier="chatHistory"]');
        const insertAfter = (node, ref) => {
            if (ref && ref.parentNode === list) list.insertBefore(node, ref.nextSibling);
            else list.insertBefore(node, list.firstChild);
        };
        const cursors = { after_main: mainCard, history: historyCard || mainCard };
        defs.forEach((def) => {
            const el = this.makeInjectCardEl(def);
            if (def.anchor === 'before_main' && mainCard) {
                list.insertBefore(el, mainCard);
                return;
            }
            if (def.anchor === 'after_main' || !cursors.history) {
                insertAfter(el, cursors.after_main);
                cursors.after_main = el;
                return;
            }
            insertAfter(el, cursors.history);
            cursors.history = el;
        });
    }

    makeInjectCardEl(def) {
        const card = document.createElement('div');
        card.className = 'pp-block pp-inject-block';
        card.dataset.inject = def.cardId;
        card.innerHTML = `
            <div class="pp-block-header">
                <div class="pp-block-left">
                    <div style="min-width:0;">
                        <div class="pp-block-title">${escapeHtml(def.title)}</div>
                        <div class="pp-block-sub">系统注入 · ${escapeHtml(def.sub)}</div>
                    </div>
                </div>
                <div class="pp-block-right"><span class="pp-meta-chip ${def.featureOff ? 'is-replace' : 'is-dynamic'}"${def.featureOff ? ` data-inject-enable="${escapeHtml(def.itemId)}" title="功能未启用（点击开启）" style="cursor:pointer;"` : ''}>${def.featureOff ? '未启用' : '注入'}</span></div>
            </div>
        `;
        card.querySelector('.pp-block-header').addEventListener('click', (e) => {
            const warn = e.target?.closest?.('[data-inject-enable]');
            if (warn) {
                e.stopPropagation();
                this.showInjectFeatureDialog(warn.dataset.injectEnable || '');
                return;
            }
            this.openInjectBlockEditor(def.cardId);
        });
        return card;
    }

    /* chip 点击：只动展示态（加入/移除、预览场景择一）；加入项功能未启用时点击弹启用界面 */
    async onInjectChipTap(itemId) {
        const item = getInjectItem(itemId);
        if (!item) return;
        if (!this.getInjectScopeEligibility().chatCapable) return;
        this.ensureInjectStateLoaded();
        const { sysp } = this.getInjectSyspromptResolved();
        const chipStates = this.buildInjectChipStatesNow(sysp);
        const result = applyInjectChipTap({ itemId, chipStates, previewScenario: this.previewScenario });
        if (result.action === 'add') {
            this.injectAdded.add(itemId);
            if (!isInjectFeatureEnabled(itemId, { sysp, settingsState: this.getInjectSettingsState() })) {
                this.showStatus('该功能未启用（仅预览展示）：点 ! 角标可开启', 'info');
            }
        } else if (result.action === 'remove') {
            this.injectAdded.delete(itemId);
        } else if (result.action === 'set-scenario' || result.action === 'remove-scenario') {
            this.previewScenario = result.nextScenario;
        } else {
            return;
        }
        this.saveInjectState();
        this.refreshInjectUi();
        this.invalidateOrRebuildPreview();
    }

    /* 加入项功能未启用时的启用界面：说明原因，能直接开的给「启用」，需去通用设定的只说明 */
    async showInjectFeatureDialog(itemId, confirmFn = appConfirm) {
        const item = getInjectItem(itemId);
        if (!item) return;
        const { presetId, preset, sysp } = this.getInjectSyspromptResolved();
        const settingsState = this.getInjectSettingsState();
        const blocker = describeInjectFeatureBlocker(itemId, { sysp, settingsState });
        if (!blocker) return;
        const labels = {
            memory: '记忆表格', dialogue: '私聊格式', group: '群聊格式', image: '自动生图', moment: '动态发布决策',
        };
        // 记忆功能被通用设定级关闭（记忆总开关/摘要模式）：无法在此直接开，只说明
        if (itemId === 'memory') {
            const generalBlocker = describeMemoryChipBlocker(settingsState);
            if (generalBlocker) {
                await confirmFn({ title: '记忆表格未启用', message: generalBlocker, confirmText: '知道了' });
                return;
            }
        }
        const ok = await confirmFn({
            title: `${labels[itemId] || item.label}未启用`,
            message: `${blocker}。现在启用该功能？`,
            confirmText: '启用',
        });
        if (!ok) return;
        try {
            let enabled = true;
            if (itemId === 'memory') {
                this.runtimeContext.promptInject?.setMemoryTableChatEnabled?.(true);
            } else if (itemId === 'image') {
                if (settingsState.autoImagePromptEnabled !== true) {
                    this.runtimeContext.promptInject?.setAutoImagePromptEnabled?.(true);
                }
                if (sysp?.auto_image_prompt_enabled === false) {
                    enabled = await this.setInjectSyspromptEnabled(item, true, { presetId, preset });
                }
            } else {
                enabled = await this.setInjectSyspromptEnabled(item, true, { presetId, preset });
            }
            if (enabled) this.showStatus('已启用', 'success');
        } catch (err) {
            logger.warn('注入功能启用失败', err);
            this.showStatus('启用失败', 'error');
        }
        this.refreshInjectUi();
        this.invalidateOrRebuildPreview();
    }

    async setInjectSyspromptEnabled(item, enabled, { presetId = '', preset = {} } = {}) {
        const actions = this.getInjectActions();
        if (typeof actions.setAgentPromptConfig !== 'function') {
            this.showStatus('注入开关不可用：缺少 agent-center 通道', 'error');
            return false;
        }
        try {
            if (enabled) {
                // 卡片总开关关着会压掉 prompt 级启用：点亮 chip 时顺带恢复卡片
                const settings = actions.getAgentCenterSettings?.() || {};
                if (settings?.cards?.[item.agentId]?.enabled === false) {
                    await actions.setAgentCardEnabled?.({ id: item.agentId, enabled: true });
                }
            }
            await actions.setAgentPromptConfig({
                profileType: 'sysprompt',
                presetId,
                preset,
                agentId: item.agentId,
                promptId: item.promptId,
                config: { enabled: enabled === true },
            });
            return true;
        } catch (err) {
            logger.warn('注入开关写入失败', err);
            this.showStatus('注入开关写入失败', 'error');
            return false;
        }
    }

    invalidateOrRebuildPreview() {
        const panelVisible = this.element && this.element.style.display !== 'none';
        if (panelVisible && this.previewState && this.previewState !== 'closed') {
            this.rebuildPreviewSkeleton();
        } else {
            this.previewBuildQueue?.invalidate?.();
            this.previewSkeleton = null;
        }
    }

    /* 系统注入卡编辑页：保存即写入 agent-center / 记忆模板（不走预设草稿） */
    openInjectBlockEditor(cardId) {
        const host = this.blockEditorEl;
        if (!host) return;
        this.currentBlockCard = null;
        this.currentInjectEditor = String(cardId || '');
        this.injectEditorCommit = null;
        this.injectEditorDirty = false;
        this.updateUnsavedIndicator();
        host.innerHTML = '';
        // 注入编辑器无内部保存按钮：任何输入变化置 dirty，参与未保存计数并由全局保存提交
        const markInjectDirty = () => {
            if (!this.currentInjectEditor || this.injectEditorDirty) return;
            this.injectEditorDirty = true;
            this.updateUnsavedIndicator();
        };
        host.oninput = markInjectDirty;
        host.onchange = markInjectDirty;
        const mkLabel = (text) => {
            const d = document.createElement('div');
            d.className = 'pp-field-label';
            d.textContent = text;
            return d;
        };
        const mkSelect = (options, value) => {
            const sel = document.createElement('select');
            sel.className = 'pp-input';
            sel.innerHTML = options.map(o => `<option value="${escapeHtml(String(o.value))}">${escapeHtml(o.label)}</option>`).join('');
            sel.value = String(value ?? '');
            return sel;
        };
        const mkNumber = (value) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0';
            input.inputMode = 'numeric';
            input.className = 'pp-input';
            input.value = String(Math.max(0, Math.trunc(Number(value)) || 0));
            return input;
        };
        const mkRow = (cells) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;';
            cells.forEach(([labelText, el]) => {
                const cell = document.createElement('div');
                cell.style.cssText = 'flex:1; min-width:140px;';
                cell.appendChild(mkLabel(labelText));
                cell.appendChild(el);
                row.appendChild(cell);
            });
            return row;
        };
        // 单一保存入口：注入编辑器不再有内部保存按钮，改动由右下角全局「保存」统一提交
        const registerSave = (onSave) => {
            this.injectEditorCommit = onSave;
        };
        const note = (text) => {
            const p = document.createElement('div');
            p.style.cssText = 'color:var(--app-text-muted); font-size:12px; line-height:1.7; margin-bottom:10px;';
            p.textContent = text;
            return p;
        };

        if (cardId === 'memory_guide' || cardId === 'memory_data') {
            this.renderMemoryInjectEditor(host, cardId, { mkLabel, mkSelect, mkNumber, mkRow, registerSave, note });
        } else {
            const item = getInjectItem(cardId);
            if (!item || item.kind !== 'sysprompt') return;
            const { presetId, preset, sysp } = this.getInjectSyspromptResolved();
            const cfg = readInjectItemConfig(sysp, cardId) || {};
            if (this.blockTitleEl) {
                this.blockTitleEl.textContent = translateUiText({
                    dialogue: '私聊格式提示词',
                    group: '群聊格式提示词',
                    image: '自动生图提示词',
                    moment: '动态发布决策提示词',
                }[cardId] || item.label);
            }
            if (this.blockSubtitleEl) this.blockSubtitleEl.textContent = '系统注入 · 随右下角保存生效';
            host.appendChild(note('该提示词按位置/深度锚定注入，不参与区块拖拽排序；与 Agent Center 内对应编辑器为同一份数据。'));
            const posSel = mkSelect(PROMPT_POSITION_OPTIONS, cfg.position ?? 0);
            const depthInput = mkNumber(cfg.depth ?? 0);
            const roleSel = mkSelect(PROMPT_ROLE_OPTIONS, cfg.role ?? 0);
            host.appendChild(mkRow([['注入位置', posSel], ['深度', depthInput], ['角色', roleSel]]));
            host.appendChild(mkLabel('规则内容'));
            const ta = document.createElement('textarea');
            ta.className = 'pp-textarea';
            ta.spellcheck = false;
            ta.style.cssText = 'width:100%; min-height: max(260px, calc(var(--app-visual-height, 100vh) - 480px)); resize: vertical;';
            ta.value = cfg.rules || '';
            host.appendChild(ta);
            registerSave(async () => {
                const actions = this.getInjectActions();
                await actions.setAgentPromptConfig?.({
                    profileType: 'sysprompt',
                    presetId,
                    preset,
                    agentId: item.agentId,
                    promptId: item.promptId,
                    config: {
                        rules: String(ta.value ?? ''),
                        position: Math.trunc(Number(resolveSelectValueWithFallback(posSel.value, cfg.position ?? 0))),
                        depth: Math.max(0, Math.trunc(Number(depthInput.value)) || 0),
                        role: Math.trunc(Number(roleSel.value)) || 0,
                    },
                });
            });
        }
        this.currentPage = 'block';
        this.setPageView('block');
    }

    /* 记忆表格注入编辑：指导（位置/深度）与表格记忆（位置/深度 + 内容/包裹模板） */
    renderMemoryInjectEditor(host, cardId, helpers) {
        const { mkSelect, mkNumber, mkRow, registerSave, note, mkLabel } = helpers;
        const isGuide = cardId === 'memory_guide';
        if (this.blockTitleEl) this.blockTitleEl.textContent = translateUiText(isGuide ? '记忆表格 · 写表指导' : '记忆表格 · 表格记忆');
        if (this.blockSubtitleEl) this.blockSubtitleEl.textContent = '系统注入 · 随右下角保存生效';
        const actions = this.getInjectActions();
        const { presetId, preset } = this.getInjectOpenAIResolved();
        const settings = actions.getAgentCenterSettings?.() || {};
        const agentSettings = settings?.profiles?.[`openai:${presetId}`]?.agents?.memory_table_agent?.settings || {};
        const { openp } = this.getInjectOpenAIResolved();
        const current = {
            dataPosition: String(agentSettings.dataPosition ?? openp?.memory_data_position ?? ''),
            dataDepth: Math.max(0, Math.trunc(Number(agentSettings.dataDepth ?? openp?.memory_data_depth)) || 0),
            guidePosition: String(agentSettings.guidePosition ?? openp?.memory_guide_position ?? ''),
            guideDepth: Math.max(0, Math.trunc(Number(agentSettings.guideDepth ?? openp?.memory_guide_depth)) || 0),
        };
        host.appendChild(note(isGuide
            ? '写表指导提示词由记忆模板生成（指导模型如何更新表格），此处调整它的注入位置与深度。'
            : '表格记忆为当前会话的记忆表数据，按模板渲染后注入。模板使用 {{tableData}} 插入表格内容。'));
        const currentPosition = isGuide ? current.guidePosition : current.dataPosition;
        const posSel = mkSelect(withCurrentSelectOption(MEMORY_POSITION_OPTIONS, currentPosition), currentPosition);
        const depthInput = mkNumber(isGuide ? current.guideDepth : current.dataDepth);
        host.appendChild(mkRow([[isGuide ? '指导位置' : '数据位置', posSel], ['深度', depthInput]]));

        let templateTa = null;
        let wrapperTa = null;
        let templatePosSel = null;
        let promptCfg = null;
        const finishSave = async () => {
            const config = {
                dataPosition: current.dataPosition,
                dataDepth: current.dataDepth,
                guidePosition: current.guidePosition,
                guideDepth: current.guideDepth,
            };
            if (isGuide) {
                config.guidePosition = String(posSel.value ?? '');
                config.guideDepth = Math.max(0, Math.trunc(Number(depthInput.value)) || 0);
            } else {
                config.dataPosition = String(posSel.value ?? '');
                config.dataDepth = Math.max(0, Math.trunc(Number(depthInput.value)) || 0);
            }
            await actions.setMemoryAgentSettings?.({ presetId, preset, config });
            if (!isGuide && templateTa && promptCfg) {
                await actions.setMemoryAgentPromptConfig?.({
                    templateId: promptCfg.templateId,
                    config: {
                        template: String(templateTa.value ?? ''),
                        wrapper: String(wrapperTa?.value ?? ''),
                        position: resolveSelectValueWithFallback(
                            templatePosSel?.value,
                            promptCfg.position ?? 'before_latest_user',
                        ),
                    },
                });
            }
        };
        if (isGuide) {
            registerSave(finishSave);
            return;
        }
        // 表格记忆：异步加载模板注入配置（SQLite），加载完成再补模板编辑区
        const loading = note('正在加载记忆模板…');
        host.appendChild(loading);
        Promise.resolve(actions.getMemoryAgentPromptConfig?.()).then((cfg) => {
            if (!host.isConnected || this.currentInjectEditor !== cardId) return;
            loading.remove();
            promptCfg = cfg && typeof cfg === 'object' ? cfg : null;
            if (!promptCfg) {
                host.appendChild(note('记忆模板不可用：仅可调整注入位置。'));
                registerSave(finishSave);
                return;
            }
            host.appendChild(note(`模板：${promptCfg.templateName || '默认记忆模板'}`));
            templatePosSel = mkSelect(
                withCurrentSelectOption(MEMORY_POSITION_OPTIONS.filter(o => o.value !== ''), promptCfg.position || 'before_latest_user'),
                promptCfg.position || 'before_latest_user',
            );
            host.appendChild(mkRow([['表格内容模板位置', templatePosSel]]));
            host.appendChild(mkLabel('表格内容模板'));
            templateTa = document.createElement('textarea');
            templateTa.className = 'pp-textarea';
            templateTa.spellcheck = false;
            templateTa.style.cssText = 'width:100%; min-height:120px; resize:vertical; margin-bottom:10px;';
            templateTa.value = promptCfg.template || '';
            host.appendChild(templateTa);
            host.appendChild(mkLabel('包裹模板'));
            wrapperTa = document.createElement('textarea');
            wrapperTa.className = 'pp-textarea';
            wrapperTa.spellcheck = false;
            wrapperTa.style.cssText = 'width:100%; min-height:120px; resize:vertical;';
            wrapperTa.value = promptCfg.wrapper || '';
            host.appendChild(wrapperTa);
            registerSave(finishSave);
        }).catch(() => {
            if (!host.isConnected) return;
            loading.textContent = '记忆模板加载失败：仅可调整注入位置。';
            registerSave(finishSave);
        });
    }

    /* 三级页上下滑/滚轮切换到相邻区块（编辑内容已 write-through 进草稿 Map，切换零丢失） */
    switchBlockBy(delta) {
        if (this.currentInjectEditor) return false; // 系统注入卡编辑页不参与相邻区块切换
        const cards = this.getBlockCards();
        if (!cards.length) return false;
        let idx = cards.indexOf(this.currentBlockCard);
        if (idx < 0) idx = 0;
        const next = cards[idx + delta];
        if (!next) return false;
        const host = this.blockEditorEl;
        const scroll = this.element?.querySelector('#preset-block-scroll');
        const reduced = document.body?.dataset?.reducedMotion === 'on'
            || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        const doOpen = () => {
            this.openOpenAIBlockEditor(next);
            if (scroll) scroll.scrollTop = 0;
            if (!reduced && host?.animate) {
                host.animate([
                    { transform: `translateY(${delta > 0 ? 34 : -34}px)`, opacity: 0.2 },
                    { transform: 'translateY(0)', opacity: 1 },
                ], { duration: 190, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' });
            }
        };
        if (!reduced && host?.animate) {
            host.style.transform = '';
            const out = host.animate([
                { transform: 'translateY(0)', opacity: 1 },
                { transform: `translateY(${delta > 0 ? -34 : 34}px)`, opacity: 0.15 },
            ], { duration: 130, easing: 'ease-in' });
            out.onfinish = doOpen;
            out.oncancel = doOpen;
        } else {
            doOpen();
        }
        return true;
    }

    /* 上下滑切换：滚动到边缘后继续拉产生带阻尼的位移（拉扯感防误触），过阈松手切换；桌面滚轮同理 */
    setupBlockSwipeNav() {
        const section = this.element?.querySelector('.pp-page[data-panel-page="block"]');
        const scroll = this.element?.querySelector('#preset-block-scroll');
        if (!section || !scroll) return;
        const prevHint = section.querySelector('.pp-swipe-hint-prev');
        const nextHint = section.querySelector('.pp-swipe-hint-next');
        const PULL_MAX = 120;
        const TRIGGER = 78;
        const reduced = () => document.body?.dataset?.reducedMotion === 'on'
            || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        const setHintLabels = () => {
            const cards = this.getBlockCards();
            const idx = cards.indexOf(this.currentBlockCard);
            const titleOf = c => c?.querySelector('.pp-block-title')?.textContent?.trim() || '';
            const prev = idx > 0 ? titleOf(cards[idx - 1]) : '';
            const next = idx >= 0 && idx < cards.length - 1 ? titleOf(cards[idx + 1]) : '';
            const pl = prevHint?.querySelector('.pp-swipe-hint-label');
            const nl = nextHint?.querySelector('.pp-swipe-hint-label');
            if (pl) pl.textContent = prev ? `上一区块 · ${prev}` : '';
            if (nl) nl.textContent = next ? `下一区块 · ${next}` : '';
            return { prev: Boolean(prev), next: Boolean(next) };
        };
        const renderPull = (pull) => {
            const host = this.blockEditorEl;
            if (host) host.style.transform = pull ? `translateY(${pull}px)` : '';
            const prevP = Math.max(0, Math.min(1, pull / TRIGGER));
            const nextP = Math.max(0, Math.min(1, -pull / TRIGGER));
            if (prevHint) {
                prevHint.style.opacity = String(prevP);
                prevHint.classList.toggle('is-armed', prevP >= 1);
            }
            if (nextHint) {
                nextHint.style.opacity = String(nextP);
                nextHint.classList.toggle('is-armed', nextP >= 1);
            }
        };
        const springBack = () => {
            const host = this.blockEditorEl;
            if (host) {
                if (!reduced()) {
                    host.style.transition = 'transform 240ms cubic-bezier(0.22, 1.2, 0.36, 1)';
                    setTimeout(() => { if (host) host.style.transition = ''; }, 260);
                }
            }
            renderPull(0);
        };
        // 事件目标链上是否还有可滚动余量（textarea/滚动容器优先消费滚动）
        const canScrollFurther = (target, wantsUp) => {
            let el = target instanceof Element ? target : null;
            while (el && el !== section) {
                if (el.scrollHeight - el.clientHeight > 1) {
                    if (wantsUp && el.scrollTop > 0) return true;
                    if (!wantsUp && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
                }
                el = el.parentElement;
            }
            return false;
        };
        let startY = null;
        let pull = 0;
        let touching = false;
        let hintAvail = { prev: false, next: false };
        scroll.addEventListener('touchstart', (e) => {
            if (this.currentPage !== 'block') return;
            startY = e.touches?.[0]?.clientY ?? null;
            pull = 0;
            touching = true;
            hintAvail = setHintLabels();
        }, { passive: true });
        scroll.addEventListener('touchmove', (e) => {
            if (!touching || startY === null) return;
            const y = e.touches?.[0]?.clientY ?? startY;
            const dy = y - startY;
            if (!pull) {
                if (Math.abs(dy) < 10) return;
                if (canScrollFurther(e.target, dy > 0)) { startY = y; return; }
            }
            pull = Math.max(-PULL_MAX, Math.min(PULL_MAX, dy * 0.38));
            if ((pull > 0 && !hintAvail.prev) || (pull < 0 && !hintAvail.next)) pull *= 0.4;
            renderPull(pull);
            e.preventDefault();
        }, { passive: false });
        const endTouch = () => {
            if (!touching) return;
            touching = false;
            if (pull >= TRIGGER && hintAvail.prev) { renderPull(0); this.switchBlockBy(-1); }
            else if (pull <= -TRIGGER && hintAvail.next) { renderPull(0); this.switchBlockBy(1); }
            else springBack();
            pull = 0;
            startY = null;
        };
        scroll.addEventListener('touchend', endTouch);
        scroll.addEventListener('touchcancel', endTouch);
        // 桌面滚轮：到边缘后继续滚累积，同样的拉扯指示
        let wheelAccum = 0;
        let wheelTimer = null;
        scroll.addEventListener('wheel', (e) => {
            if (this.currentPage !== 'block') return;
            if (canScrollFurther(e.target, e.deltaY < 0)) {
                if (wheelAccum) { wheelAccum = 0; springBack(); }
                return;
            }
            if (!wheelAccum) hintAvail = setHintLabels();
            if ((e.deltaY < 0 && !hintAvail.prev) || (e.deltaY > 0 && !hintAvail.next)) return;
            wheelAccum += e.deltaY;
            const pullV = Math.max(-PULL_MAX, Math.min(PULL_MAX, -wheelAccum * 0.18));
            renderPull(pullV);
            if (wheelTimer) clearTimeout(wheelTimer);
            if (pullV >= TRIGGER) { wheelAccum = 0; renderPull(0); this.switchBlockBy(-1); return; }
            if (pullV <= -TRIGGER) { wheelAccum = 0; renderPull(0); this.switchBlockBy(1); return; }
            wheelTimer = setTimeout(() => { wheelAccum = 0; springBack(); }, 420);
        }, { passive: true });
    }

    /* 区块草稿播种：首次触碰（编辑页/预览内编辑）时从已保存基线复制一份 */
    ensureBlockDraft(identifier) {
        if (!identifier) return null;
        if (!(this.openaiBlockDrafts instanceof Map)) this.openaiBlockDrafts = new Map();
        if (!this.openaiBlockDrafts.has(identifier)) {
            const base = this.openaiBlockBase?.get?.(identifier) || null;
            const known = OPENAI_KNOWN_BLOCKS[identifier];
            this.openaiBlockDrafts.set(identifier, {
                name: String(base?.name || known?.label || identifier),
                role: roleIdToName(base?.role || 'system'),
                system_prompt: (typeof base?.system_prompt === 'boolean') ? base.system_prompt : true,
                content: String(base?.content ?? ''),
            });
        }
        return this.openaiBlockDrafts.get(identifier);
    }

    /* 草稿与基线的逐字段比对（未保存计数、diff 徽标、预览 diff 共用同一判定） */
    isBlockDraftModified(identifier) {
        const d = this.openaiBlockDrafts?.get?.(identifier);
        if (!d) return false;
        const b = this.openaiBlockBase?.get?.(identifier) || null;
        if (!b) return true;
        const baseRole = roleIdToName(b.role || 'system');
        const baseSys = typeof b.system_prompt === 'boolean' ? b.system_prompt : true;
        const baseName = b.name || identifier;
        return String(d.name ?? '') !== String(baseName)
            || d.role !== baseRole
            || Boolean(d.system_prompt) !== baseSys
            || presetBlockContentChanged(b.content, d.content);
    }

    isBlockDraftContentModified(identifier) {
        const draft = this.openaiBlockDrafts?.get?.(identifier);
        if (!draft) return false;
        const base = this.openaiBlockBase?.get?.(identifier);
        if (!base) return true;
        return presetBlockContentChanged(base.content, draft.content);
    }

    modifiedBlockDraftIds() {
        const ids = [];
        this.openaiBlockDrafts?.forEach?.((d, id) => { if (this.isBlockDraftModified(id)) ids.push(id); });
        return ids;
    }

    /* 未保存更改指示：区块草稿 Map 与基线逐项比对 + 其它分区草稿数（capture 已丢弃与基线一致的草稿） */
    countUnsavedBlockChanges() {
        return this.modifiedBlockDraftIds().length;
    }

    countUnsavedChanges() {
        const blockCount = this.countUnsavedBlockChanges();
        const currentOpenAIKey = this.getDraftKey('openai', this.store.getActiveId('openai'));
        let sectionCount = 0;
        for (const key of this.drafts?.keys?.() || []) {
            if (key !== currentOpenAIKey) sectionCount += 1;
        }
        if (currentOpenAIKey && this.drafts?.has?.(currentOpenAIKey) && blockCount === 0) {
            sectionCount += 1;
        }
        // 注入编辑器的未提交改动（系统注入不走草稿链路，用 dirty 标记参与计数）
        const injectCount = this.injectEditorDirty ? 1 : 0;
        return blockCount + sectionCount + injectCount;
    }

    countUnsavedOpenAIChanges() {
        const blockCount = this.countUnsavedBlockChanges();
        const currentOpenAIKey = this.getDraftKey('openai', this.store.getActiveId('openai'));
        const structuralCount = currentOpenAIKey && this.drafts?.has?.(currentOpenAIKey) && blockCount === 0 ? 1 : 0;
        return blockCount + structuralCount;
    }

    discardOpenAIDrafts({ presetId = '', all = false } = {}) {
        if (all) {
            for (const key of Array.from(this.drafts?.keys?.() || [])) {
                if (String(key).startsWith('openai:')) this.drafts.delete(key);
            }
        } else {
            const key = this.getDraftKey('openai', presetId || this.store.getActiveId('openai'));
            if (key) this.drafts.delete(key);
        }
        this.openaiBlockDrafts?.clear?.();
        this.openaiDeletedBlockIds?.clear?.();
        this.openaiBlockDraftsScope = '';
    }

    restoreOpenAIDraftSnapshotBlock(identifier, savedBlock = null) {
        const key = this.getDraftKey('openai', this.store.getActiveId('openai'));
        if (!key || !this.drafts?.has?.(key)) return;
        const snapshot = deepClone(this.drafts.get(key) || {});
        const prompts = Array.isArray(snapshot.prompts) ? snapshot.prompts : [];
        const index = prompts.findIndex(item => item?.identifier === identifier);
        if (savedBlock) {
            if (index >= 0) prompts[index] = deepClone(savedBlock);
            else prompts.push(deepClone(savedBlock));
        } else if (index >= 0) {
            prompts.splice(index, 1);
        }
        snapshot.prompts = prompts;
        if (!savedBlock && Array.isArray(snapshot.prompt_order)) {
            snapshot.prompt_order.forEach((block) => {
                if (Array.isArray(block?.order)) {
                    block.order = block.order.filter(item => item?.identifier !== identifier);
                }
            });
        }
        const baseline = this.store.getActive('openai') || {};
        if (isSamePresetData(snapshot, baseline)) this.drafts.delete(key);
        else this.drafts.set(key, snapshot);
    }

    dropCurrentOpenAIDraftSnapshotIfSaved() {
        const key = this.getDraftKey('openai', this.store.getActiveId('openai'));
        if (!key || !this.drafts?.has?.(key)) return;
        if (JSON.stringify(this.drafts.get(key)) === JSON.stringify(this.store.getActive('openai') || {})) {
            this.drafts.delete(key);
        }
    }

    isPresetMutationBusy() {
        return this._presetMutationBusy === true;
    }

    setPresetMutationBusy(busy) {
        this._presetMutationBusy = busy === true;
        const controls = this.element?.querySelectorAll?.(
            '#preset-save, #preset-cancel, #preset-import, #preset-accept-all, #preset-reject-all, '
            + '#preset-manager-select, [data-select-id="preset-manager-select"], #preset-manager-enabled, '
            + '#preset-manager-new, #preset-manager-rename, #preset-manager-bindings, #preset-manager-delete, '
            + '#preset-detail-editor input, #preset-detail-editor textarea, #preset-detail-editor select, #preset-detail-editor button, '
            + '#preset-block-editor input, #preset-block-editor textarea, #preset-block-editor select, #preset-block-editor button, '
            + '.pp-binding-btn, .pp-diff-accept, .pp-diff-reject',
        ) || [];
        controls.forEach((control) => {
            if (this._presetMutationBusy) {
                if (!Object.prototype.hasOwnProperty.call(control.dataset, 'ppMutationWasDisabled')) {
                    control.dataset.ppMutationWasDisabled = control.disabled ? '1' : '0';
                }
                control.disabled = true;
            } else if (Object.prototype.hasOwnProperty.call(control.dataset, 'ppMutationWasDisabled')) {
                control.disabled = control.dataset.ppMutationWasDisabled === '1';
                delete control.dataset.ppMutationWasDisabled;
            }
        });
    }

    enqueuePresetMutation(task, { rejectIfBusy = false } = {}) {
        if (typeof task !== 'function') return Promise.resolve(false);
        if (rejectIfBusy && this.isPresetMutationBusy()) {
            this.showStatus('正在保存上一处修改，请稍候', 'info');
            return Promise.resolve(false);
        }
        const previous = this._presetMutationTail || Promise.resolve();
        this._presetMutationPending = (Number(this._presetMutationPending) || 0) + 1;
        this.setPresetMutationBusy(true);
        const run = previous.catch(() => {}).then(() => task());
        const settled = run.finally(() => {
            this._presetMutationPending = Math.max(0, (Number(this._presetMutationPending) || 1) - 1);
            if (this._presetMutationPending === 0) this.setPresetMutationBusy(false);
        });
        this._presetMutationTail = settled.catch(() => {});
        return run;
    }

    /* ✔ 接受：把指定区块草稿立即合并入当前预设并入库（快捷、无确认） */
    async acceptBlockDraft(identifier) {
        if (!identifier || !this.isBlockDraftModified(identifier)) return false;
        return this.enqueuePresetMutation(
            () => this.applyBlockDraftsToStore([identifier]),
            { rejectIfBusy: true },
        );
    }

    async acceptAllBlockDrafts() {
        const ids = this.modifiedBlockDraftIds();
        if (!ids.length) return false;
        return this.enqueuePresetMutation(
            () => this.applyBlockDraftsToStore(ids),
            { rejectIfBusy: true },
        );
    }

    async applyBlockDraftsToStore(ids) {
        await this.store.ready;
        const activeId = this.store.getActiveId('openai');
        if (!activeId || !Array.isArray(ids) || !ids.length) return;
        try {
            const data = deepClone(this.store.getActive('openai') || {});
            if (!Array.isArray(data.prompts)) data.prompts = [];
            const byId = new Map(data.prompts.map(pr => [pr?.identifier, pr]).filter(([k]) => k));
            const newOnes = [];
            const merged = new Map();
            for (const ident of ids) {
                const draft = this.openaiBlockDrafts?.get?.(ident);
                if (!draft) continue;
                const existing = byId.get(ident) || null;
                const next = {
                    ...(existing || {}), identifier: ident,
                    name: draft.name || existing?.name || ident,
                    role: roleIdToName(draft.role || existing?.role || 'system'),
                    system_prompt: typeof draft.system_prompt === 'boolean' ? draft.system_prompt : (existing?.system_prompt ?? true),
                    marker: false,
                    content: String(draft.content ?? existing?.content ?? ''),
                };
                if (existing) Object.assign(existing, next);
                else { data.prompts.push(next); newOnes.push(ident); }
                merged.set(ident, next);
            }
            // 新区块补 prompt_order（与「新增区块插到顶部」一致）
            if (newOnes.length) {
                if (!Array.isArray(data.prompt_order) || !data.prompt_order.length) {
                    data.prompt_order = [{ character_id: 100001, order: [] }];
                }
                const ob = data.prompt_order.find(b => String(b?.character_id) === '100001') || data.prompt_order[0];
                if (ob && Array.isArray(ob.order)) {
                    for (const ident of newOnes) {
                        if (!ob.order.some(o => o?.identifier === ident)) ob.order.unshift({ identifier: ident, enabled: true });
                    }
                }
            }
            const name = String(data?.name || '').trim() || activeId;
            await this.store.upsert('openai', { id: activeId, name, data });
            // 就地更新基线与卡片（不整体重建，保住编辑位置/滚动）
            merged.forEach((next, ident) => {
                this.openaiBlockBase?.set?.(ident, deepClone(next));
                this.restoreOpenAIDraftSnapshotBlock(ident, next);
                this.openaiBlockDrafts?.delete?.(ident);
                const card = this.getBlockCards().find(c => c.dataset.identifier === ident);
                if (card) {
                    const t = card.querySelector('.pp-block-title'); if (t) t.textContent = next.name || ident;
                    const s = card.querySelector('.pp-block-sub'); if (s) s.textContent = `role: ${next.role || 'system'}`;
                }
            });
            this.dropCurrentOpenAIDraftSnapshotIfSaved();
            window.dispatchEvent(new CustomEvent('preset-changed'));
            this.updateUnsavedIndicator();
            this.showStatus(ids.length > 1 ? `已接受 ${merged.size} 处修改并保存` : '已接受修改并保存', 'success');
            // 骨架重建由 preset-changed 监听统一处理（上面已 dispatch）
        } catch (err) {
            logger.error('接受区块修改失败', err);
            this.showStatus(err.message || '保存失败', 'error');
        }
    }

    /* ✔ hunk 级接受：只把该处修改并入基线并入库，其它修改保持草稿态 */
    async acceptBlockHunk(identifier, hunkIdx) {
        if (!identifier || !Number.isFinite(hunkIdx)) return false;
        return this.enqueuePresetMutation(async () => {
            const draft = this.openaiBlockDrafts?.get?.(identifier);
            if (!draft) return false;
            const base = String(this.openaiBlockBase?.get?.(identifier)?.content ?? '');
            const newBase = this.applyBlockHunk(base, String(draft.content ?? ''), hunkIdx, 'accept');
            const saved = await this.applyBlockContentToStore(identifier, newBase);
            if (saved) this.showStatus('已接受该处修改并保存', 'success');
            return saved;
        }, { rejectIfBusy: true });
    }

    /* × hunk 级回滚：只回滚该处修改（草稿里恢复基线行），其它修改保留 */
    rejectBlockHunk(identifier, hunkIdx) {
        if (this.isPresetMutationBusy()) {
            this.showStatus('正在保存上一处修改，请稍候', 'info');
            return false;
        }
        const draft = this.openaiBlockDrafts?.get?.(identifier);
        if (!draft || !Number.isFinite(hunkIdx)) return;
        const base = String(this.openaiBlockBase?.get?.(identifier)?.content ?? '');
        draft.content = this.applyBlockHunk(base, String(draft.content ?? ''), hunkIdx, 'reject');
        if (this.currentPage === 'block' && this.currentBlockCard?.dataset?.identifier === identifier) {
            const ta = this.blockEditorEl?.querySelector('textarea');
            if (ta && ta.value !== draft.content) ta.value = draft.content;
        }
        this.updateUnsavedIndicator();
        this.refreshPreviewMessageFor(identifier);
    }

    /* 单区块内容写库（hunk 接受用）：只动 content，name/role 等其它字段留在草稿等整体保存 */
    async applyBlockContentToStore(identifier, content) {
        await this.store.ready;
        const activeId = this.store.getActiveId('openai');
        if (!activeId || !identifier) return false;
        try {
            const data = deepClone(this.store.getActive('openai') || {});
            if (!Array.isArray(data.prompts)) data.prompts = [];
            let pr = data.prompts.find(x => x?.identifier === identifier);
            if (!pr) {
                const draft = this.openaiBlockDrafts?.get?.(identifier);
                pr = {
                    identifier,
                    name: draft?.name || identifier,
                    role: roleIdToName(draft?.role || 'system'),
                    system_prompt: typeof draft?.system_prompt === 'boolean' ? draft.system_prompt : true,
                    marker: false,
                    content: '',
                };
                data.prompts.push(pr);
                if (!Array.isArray(data.prompt_order) || !data.prompt_order.length) {
                    data.prompt_order = [{ character_id: 100001, order: [] }];
                }
                const ob = data.prompt_order.find(b => String(b?.character_id) === '100001') || data.prompt_order[0];
                if (ob && Array.isArray(ob.order) && !ob.order.some(o => o?.identifier === identifier)) {
                    ob.order.unshift({ identifier, enabled: true });
                }
            }
            pr.content = String(content ?? '');
            const name = String(data?.name || '').trim() || activeId;
            await this.store.upsert('openai', { id: activeId, name, data });
            const savedBlock = deepClone(pr);
            this.openaiBlockBase?.set?.(identifier, savedBlock);
            this.restoreOpenAIDraftSnapshotBlock(identifier, savedBlock);
            this.dropCurrentOpenAIDraftSnapshotIfSaved();
            window.dispatchEvent(new CustomEvent('preset-changed')); // 骨架重建由监听统一处理
            this.updateUnsavedIndicator();
            return true;
        } catch (err) {
            logger.error('接受该处修改失败', err);
            this.showStatus(err.message || '保存失败', 'error');
            return false;
        }
    }

    /* × 舍弃：丢掉指定区块草稿，界面回基线（快捷、无确认） */
    rejectBlockDraft(identifier) {
        if (this.isPresetMutationBusy()) {
            this.showStatus('正在保存上一处修改，请稍候', 'info');
            return false;
        }
        if (!identifier || !this.openaiBlockDrafts?.has?.(identifier)) return;
        this.openaiBlockDrafts.delete(identifier);
        const base = this.openaiBlockBase?.get?.(identifier);
        const card = this.getBlockCards().find(c => c.dataset.identifier === identifier);
        this.restoreOpenAIDraftSnapshotBlock(identifier, base || null);
        if (card) {
            if (!base) {
                card.remove();
                if (this.currentPage === 'block' && this.currentBlockCard === card) this.showDetailPage();
                this.updateUnsavedIndicator();
                if (this.previewState !== 'closed') this.refreshPreviewMessageFor(identifier);
                return;
            }
            const t = card.querySelector('.pp-block-title'); if (t) t.textContent = base?.name || identifier;
            const s = card.querySelector('.pp-block-sub'); if (s) s.textContent = `role: ${roleIdToName(base?.role || 'system')}`;
            if (this.currentPage === 'block' && this.currentBlockCard === card) this.openOpenAIBlockEditor(card);
        }
        this.updateUnsavedIndicator();
        if (this.previewState !== 'closed') this.refreshPreviewMessageFor(identifier);
    }

    /* 全部取消 = 批量舍弃 → 需确认（与「舍弃草稿要确认」的约定一致；单处 × 快捷免确认） */
    async rejectAllBlockDrafts() {
        if (this.isPresetMutationBusy()) {
            this.showStatus('正在保存上一处修改，请稍候', 'info');
            return false;
        }
        const ids = this.modifiedBlockDraftIds();
        if (!ids.length) return;
        const ok = await appConfirm({
            title: '全部取消',
            message: `将舍弃 ${ids.length} 处未保存的区块修改，确定？`,
            danger: true,
        });
        if (!ok) return;
        ids.forEach(id => this.rejectBlockDraft(id));
        window.toastr?.info?.('已舍弃全部未保存修改');
    }

    /* 预览 diff 段点击 → 切换为直接编辑（blur 后回 diff 视图） */
    enterPreviewBlockEdit(span) {
        const id = span?.getAttribute?.('data-pp-prev-block') || '';
        const draft = this.openaiBlockDrafts?.get?.(id);
        if (!draft) return;
        span.classList.add('is-editing');
        span.textContent = String(draft.content ?? '');
        span.setAttribute('contenteditable', 'plaintext-only');
        span.setAttribute('spellcheck', 'false');
        try { span.focus(); } catch {}
        const onBlur = () => {
            span.removeEventListener('blur', onBlur);
            span.classList.remove('is-editing');
            this.refreshPreviewMessageFor(id);
        };
        span.addEventListener('blur', onBlur);
    }

    /* 左侧选区 → 预览同步高亮（CSS Custom Highlight；span 为纯文本态且内容一致时才可映射） */
    syncSelectionToPreview(identifier, textarea) {
        const registry = (typeof CSS !== 'undefined' && CSS.highlights) ? CSS.highlights : null;
        const HighlightCtor = typeof Highlight !== 'undefined' ? Highlight : null;
        if (!registry || !HighlightCtor) return;
        const clear = () => registry.delete('pp-preview-sel');
        if (this.previewState === 'closed' || !textarea || !identifier) { clear(); return; }
        const s = textarea.selectionStart ?? 0;
        const e = textarea.selectionEnd ?? 0;
        let span = null;
        try { span = this.previewBodyEl?.querySelector(`[data-pp-prev-block="${CSS.escape(identifier)}"]`); } catch {}
        if (!span || e <= s || span.textContent !== textarea.value) { clear(); return; }
        const from = this.locateTextOffsetInSpan(span, s);
        const to = this.locateTextOffsetInSpan(span, e);
        if (!from || !to) { clear(); return; }
        try {
            const range = document.createRange();
            range.setStart(from[0], from[1]);
            range.setEnd(to[0], to[1]);
            registry.set('pp-preview-sel', new HighlightCtor(range));
        } catch { clear(); }
    }

    /* 二级卡片「已修改」徽标 + 快捷 ✔/× 显隐 */
    updateBlockCardModifiedBadges() {
        const modified = new Set(this.modifiedBlockDraftIds());
        this.element?.querySelectorAll('#openai-blocks .openai-block').forEach((card) => {
            card.classList.toggle('is-modified', modified.has(card.dataset.identifier || ''));
        });
    }

    updateUnsavedIndicator() {
        const el = this.element?.querySelector('#preset-unsaved-chip');
        if (!el) return;
        const blockN = this.countUnsavedBlockChanges();
        const n = this.countUnsavedChanges();
        el.hidden = n <= 0;
        if (n > 0) el.textContent = `${n} 处更改尚未保存`;
        this.element?.querySelector('.pp-btn-save')?.classList.toggle('pp-save-attention', n > 0);
        // 批量条：只针对区块草稿（分区草稿走整体「保存」）
        const acceptAll = this.element?.querySelector('#preset-accept-all');
        const rejectAll = this.element?.querySelector('#preset-reject-all');
        if (acceptAll) { acceptAll.hidden = blockN <= 0; acceptAll.textContent = `✔ 接受全部(${blockN})`; }
        if (rejectAll) rejectAll.hidden = blockN <= 0;
        this.updateBlockCardModifiedBadges();
        this._updateTaDiffLayer?.(); // 三级页左侧红绿镜像层随草稿变化刷新
    }

    scheduleUnsavedIndicatorUpdate() {
        if (this._unsavedTimer) clearTimeout(this._unsavedTimer);
        this._unsavedTimer = setTimeout(() => this.updateUnsavedIndicator(), 300);
    }

    /* ════════════════════════════════════════
       分栏请求预览（草稿实时）：
       骨架用 previewOnly 管线构建一次（注入用已保存状态），自定义区块段落用未保存草稿实时替换；
       左右强联动：编辑光标→预览滚动定位，预览滚动→编辑器切块/列表跟随。
       状态机：closed →（桌面）split → full；手机直接 closed→full（对称把手收回）。
       ════════════════════════════════════════ */
    isPreviewPhoneLayout() {
        try { return window.matchMedia?.('(max-width: 899px)')?.matches === true; } catch { return false; }
    }

    setPreviewState(state, { animate = true } = {}) {
        const prev = this.previewState || 'closed';
        if (prev === state) return;
        this.previewState = state;
        if (state !== 'closed') this.previewDiscoveryGuide?.hide?.();
        const el = this.element;
        if (!el) return;
        const apply = (s) => {
            if (s === 'closed') el.removeAttribute('data-preview');
            else el.dataset.preview = s;
        };
        const pane = this.previewPaneEl;
        const shell = el.querySelector('.pp-shell');
        try { this._previewMotionCleanup?.(); } catch {}
        this._previewMotionCleanup = null;
        try { this._previewAnims?.forEach(a => a.cancel()); } catch {}
        this._previewAnims = [];
        const reduced = document.body?.dataset?.reducedMotion === 'on'
            || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (!animate || reduced || typeof pane?.animate !== 'function') { apply(state); return; }
        /* PPT slide 编排：closed↔split 靠宽度过渡推开/收拢 + 内容滑入滑出；
           涉及 full 的先切/后切布局，pane 整体 transform 滑盖，编辑器在下层轻推（视差）。 */
        const run = (target, keyframes, opts) => {
            const anim = target.animate(keyframes, opts);
            this._previewAnims.push(anim);
            return anim;
        };
        const easeOut = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
        const easeIn = 'cubic-bezier(0.5, 0, 0.75, 0.4)';
        const paneContent = [pane.querySelector('.pp-preview-head'), pane.querySelector('.pp-preview-scroll')].filter(Boolean);
        const startPreviewMotion = (name, { settle = null } = {}) => {
            let active = true;
            el.dataset.previewMotion = name;
            const cleanup = () => {
                if (!active) return;
                active = false;
                try { settle?.(); } catch {}
                if (el.dataset.previewMotion === name) delete el.dataset.previewMotion;
                if (this._previewMotionCleanup === cleanup) this._previewMotionCleanup = null;
            };
            this._previewMotionCleanup = cleanup;
            return {
                cleanup,
                isActive: () => active && el.dataset.previewMotion === name,
            };
        };
        const pullHandleRestOpacity = (() => {
            const value = Number.parseFloat(
                window.getComputedStyle?.(el)?.getPropertyValue('--pull-handle-rest-opacity') || '',
            );
            return Number.isFinite(value) ? value : 0.62;
        })();
        const fadeHandleHandoff = ({ incoming, outgoing = null, incomingOpacity = 1, motion, heldAnimations = [] }) => {
            const held = heldAnimations.filter(Boolean);
            const release = (animations = []) => {
                [...animations, ...held].forEach((animation) => {
                    if (!animation) return;
                    animation.onfinish = null;
                    animation.oncancel = null;
                    try { animation.cancel(); } catch {}
                });
            };
            if (!motion?.isActive()) { release(); return; }
            if (!incoming) {
                motion.cleanup();
                release();
                return;
            }
            const fadeIn = run(incoming, [
                { opacity: 0 },
                { opacity: incomingOpacity },
            ], { duration: 180, easing: easeOut, fill: 'both' });
            const outgoingOpacity = outgoing?.classList.contains('is-opaque') ? 1 : pullHandleRestOpacity;
            const fadeOut = outgoing
                ? run(outgoing, [
                    { opacity: outgoingOpacity },
                    { opacity: 0 },
                ], { duration: 180, easing: easeOut, fill: 'both' })
                : null;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                motion.cleanup();
                release([fadeIn, fadeOut]);
            };
            fadeIn.onfinish = finish;
            fadeIn.oncancel = () => {
                if (!done && motion.isActive()) {
                    done = true;
                    motion.cleanup();
                }
            };
        };
        const visiblePreviewEdge = () => {
            const pageView = el.querySelector('#preset-pages')?.dataset.view;
            const pageHandle = pageView
                ? el.querySelector(`.pp-page[data-panel-page="${pageView}"] .pp-preview-edge`)
                : null;
            return pageHandle
                || Array.from(el.querySelectorAll('.pp-preview-edge')).find(handle => handle.getClientRects().length > 0)
                || el.querySelector('.pp-preview-edge');
        };
        if (prev === 'closed' && state === 'split') {
            // 推入：第一个提环从原右缘紧贴分隔线随面板移动；落位后第二个提环才淡入。
            const previewMotion = 'opening-split';
            const motion = startPreviewMotion('opening-split');
            const expandHandle = el.querySelector('#preset-preview-expand');
            const collapseHandle = el.querySelector('#preset-preview-collapse');
            collapseHandle?.classList.remove('is-opaque');
            this.revealPreviewHandleTemporarily?.(expandHandle);
            apply('split');
            paneContent.forEach(t => run(t, [
                { transform: 'translateX(56px)', opacity: 0.25 },
                { transform: 'translateX(0)', opacity: 1 },
            ], { duration: 320, easing: easeOut }));
            let leadHandleAnimation = null;
            const revealSecondHandle = () => {
                if (el.dataset.previewMotion !== previewMotion || !motion.isActive()) return;
                fadeHandleHandoff({
                    incoming: collapseHandle,
                    incomingOpacity: pullHandleRestOpacity,
                    motion,
                    heldAnimations: [leadHandleAnimation],
                });
            };
            leadHandleAnimation = expandHandle
                ? run(expandHandle, [
                    { left: '100%', top: '50%' },
                    { left: '54%', top: 'calc(50% - 34px)' },
                ], { duration: 300, easing: easeOut, fill: 'both' })
                : null;
            if (leadHandleAnimation) {
                leadHandleAnimation.onfinish = revealSecondHandle;
                leadHandleAnimation.oncancel = () => {
                    if (motion.isActive()) motion.cleanup();
                };
            } else {
                revealSecondHandle();
            }
        } else if (prev === 'split' && state === 'closed') {
            // 收拢：右向提环随预览边界回到右缘，再交接给编辑页的左向提环。
            const motion = startPreviewMotion('closing-split');
            const collapseHandle = el.querySelector('#preset-preview-collapse');
            const edgeHandle = visiblePreviewEdge();
            edgeHandle?.classList.remove('is-opaque');
            const anims = paneContent.map(t => run(t, [
                { transform: 'translateX(0)', opacity: 1 },
                { transform: 'translateX(40px)', opacity: 0 },
            ], { duration: 200, easing: easeIn, fill: 'forwards' }));
            apply('closed');
            setTimeout(() => anims.forEach(a => { try { a.cancel(); } catch {} }), 340);
            let leadHandleAnimation = null;
            const finish = () => {
                if (!motion.isActive()) return;
                this.revealPreviewHandleTemporarily?.(edgeHandle);
                fadeHandleHandoff({
                    incoming: edgeHandle,
                    outgoing: collapseHandle,
                    motion,
                    heldAnimations: [leadHandleAnimation],
                });
            };
            leadHandleAnimation = collapseHandle
                ? run(collapseHandle, [
                    { left: '54%', top: 'calc(50% + 34px)' },
                    { left: '100%', top: '50%' },
                ], { duration: 300, easing: easeOut, fill: 'both' })
                : null;
            if (leadHandleAnimation) {
                leadHandleAnimation.onfinish = finish;
                leadHandleAnimation.oncancel = () => {
                    if (motion.isActive()) motion.cleanup();
                };
            } else {
                finish();
            }
        } else if (state === 'full') {
            // split/closed → full：当前提环随预览左边界到位，再交接给全屏返回提环。
            const fromSplit = prev === 'split';
            const motion = fromSplit
                ? startPreviewMotion('expanding-full')
                : startPreviewMotion('opening-full');
            const fromX = prev === 'split' ? '54%' : '100%';
            const leadHandle = fromSplit
                ? el.querySelector('#preset-preview-expand')
                : visiblePreviewEdge();
            const editorHandle = el.querySelector('#preset-editor-return');
            editorHandle?.classList.remove('is-opaque');
            if (shell) shell.style.visibility = 'visible';
            apply('full');
            // 手机的主提环位于 shell 内；此路径不做父层视差，避免提环偏离 pane 边界。
            if (shell && fromSplit) run(shell, [
                { transform: 'translateX(0)', opacity: 1 },
                { transform: 'translateX(-48px)', opacity: 0.8 },
            ], { duration: 340, easing: easeOut });
            const slide = run(pane, [
                { transform: `translateX(${fromX})` },
                { transform: 'translateX(0)' },
            ], { duration: 340, easing: easeOut });
            const leadHandleAnimation = leadHandle
                ? run(leadHandle, fromSplit ? [
                    { left: '54%', top: 'calc(50% - 34px)' },
                    { left: '0%', top: '50%' },
                ] : [
                    { right: '0%', top: '50%' },
                    { right: '100%', top: '50%' },
                ], { duration: 340, easing: easeOut, fill: 'both' })
                : null;
            let slideDone = false;
            let handleDone = !leadHandleAnimation;
            let handedOff = false;
            const settle = () => { if (shell) shell.style.visibility = ''; };
            const finish = () => {
                if (handedOff || !slideDone || !handleDone || !motion.isActive()) return;
                handedOff = true;
                this.revealPreviewHandleTemporarily?.(editorHandle);
                fadeHandleHandoff({
                    incoming: editorHandle,
                    outgoing: leadHandle,
                    motion,
                    heldAnimations: [leadHandleAnimation],
                });
            };
            slide.onfinish = () => {
                slideDone = true;
                settle();
                finish();
            };
            slide.oncancel = () => {
                settle();
                if (motion.isActive()) motion.cleanup();
            };
            if (leadHandleAnimation) {
                leadHandleAnimation.onfinish = () => {
                    handleDone = true;
                    finish();
                };
                leadHandleAnimation.oncancel = () => {
                    if (motion.isActive()) motion.cleanup();
                };
            } else {
                finish();
            }
        } else if (prev === 'full') {
            // full → split/closed：返回提环随左边界移走，落定后交接给目标状态提环。
            const toSplit = state === 'split';
            const motion = toSplit
                ? startPreviewMotion('returning-split', { settle: () => apply('split') })
                : startPreviewMotion('closing-full', { settle: () => apply('closed') });
            const editorHandle = el.querySelector('#preset-editor-return');
            const collapseHandle = el.querySelector('#preset-preview-collapse');
            const expandHandle = el.querySelector('#preset-preview-expand');
            const edgeHandle = visiblePreviewEdge();
            if (toSplit) expandHandle?.classList.remove('is-opaque');
            else edgeHandle?.classList.remove('is-opaque');
            if (shell) shell.style.visibility = 'visible';
            const toX = state === 'split' ? '54%' : '100%';
            if (shell) run(shell, [
                { transform: 'translateX(-48px)', opacity: 0.8 },
                { transform: 'translateX(0)', opacity: 1 },
            ], { duration: 300, easing: easeOut });
            const slide = run(pane, [
                { transform: 'translateX(0)' },
                { transform: `translateX(${toX})` },
            ], { duration: 300, easing: easeIn, fill: 'forwards' });
            const leadHandleAnimation = editorHandle
                ? run(editorHandle, toSplit ? [
                    { left: '0%', top: '50%' },
                    { left: '54%', top: 'calc(50% + 34px)' },
                ] : [
                    { left: '0%', top: '50%' },
                    { left: '100%', top: '50%' },
                ], { duration: 300, easing: easeIn, fill: 'both' })
                : null;
            let slideDone = false;
            let handleDone = !leadHandleAnimation;
            const finish = () => {
                if (!slideDone || !handleDone || !motion.isActive()) return;
                if (shell) shell.style.visibility = '';
                slide.onfinish = null;
                slide.oncancel = null;
                try { slide.cancel(); } catch {}
                apply(state);
                if (toSplit) {
                    this.revealPreviewHandleTemporarily?.(collapseHandle);
                    fadeHandleHandoff({
                        incoming: expandHandle,
                        incomingOpacity: pullHandleRestOpacity,
                        motion,
                        heldAnimations: [leadHandleAnimation],
                    });
                } else {
                    this.revealPreviewHandleTemporarily?.(edgeHandle);
                    fadeHandleHandoff({
                        incoming: edgeHandle,
                        outgoing: editorHandle,
                        motion,
                        heldAnimations: [leadHandleAnimation],
                    });
                }
            };
            slide.onfinish = () => {
                slideDone = true;
                finish();
            };
            slide.oncancel = () => {
                if (shell) shell.style.visibility = '';
                if (motion.isActive()) motion.cleanup();
            };
            if (leadHandleAnimation) {
                leadHandleAnimation.onfinish = () => {
                    handleDone = true;
                    finish();
                };
                leadHandleAnimation.oncancel = () => {
                    if (motion.isActive()) motion.cleanup();
                };
            } else {
                finish();
            }
        } else {
            apply(state);
        }
    }

    setupPreviewPane() {
        const pane = this.element?.querySelector('#preset-preview-pane');
        if (!pane) return;
        this.previewPaneEl = pane;
        this.previewScrollEl = pane.querySelector('#preset-preview-scroll');
        this.previewBodyEl = pane.querySelector('#preset-preview-body');
        this.previewEstEl = pane.querySelector('#preset-preview-est');
        this.previewState = 'closed';
        // 默认「区块原样」：宏语法可见、100% 逐字映射；关闭后整体求值展示最终效果
        this.previewRawBlocks = true;
        this.previewSkeleton = null;
        this.previewBlockMap = new Map();
        this.previewBuildQueue = createLatestPreviewBuildQueue({
            build: options => this.runtimeContext?.buildScenePromptPreviewRequest?.(options),
            onStart: () => {
                if (this.previewBodyEl) this.previewBodyEl.innerHTML = '<div class="pp-preview-loading">正在构建预览…</div>';
            },
            onResult: (request) => {
                this.previewSkeleton = request;
                this.mapBlocksToPreview();
                this.renderPreviewBody();
                this.positionPreviewToCurrentBlock();
            },
            onFailure: (error) => {
                if (error) logger.warn('构建预设预览失败', error);
                if (this.previewBodyEl) {
                    this.previewBodyEl.innerHTML = '<div class="pp-preview-loading">构建失败：请确认当前有可用会话。</div>';
                }
            },
        });
        const bindDrag = (el, onLeft, onRight) => {
            if (!el) return;
            el.addEventListener('pointerdown', (e) => {
                const startX = e.clientX;
                const pid = e.pointerId;
                let fired = false;
                const onMove = (ev) => {
                    if (ev.pointerId !== pid || fired) return;
                    const dx = ev.clientX - startX;
                    if (dx <= -36 && onLeft) { fired = true; onLeft(); }
                    else if (dx >= 36 && onRight) { fired = true; onRight(); }
                };
                const onUp = (ev) => {
                    if (ev.pointerId !== pid) return;
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onUp);
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('pointercancel', onUp);
            });
        };
        // 提环平时半透明；最后一次进入、点击或聚焦后亮起 3 秒，再自动淡回。
        const handleOpacityTimers = new WeakMap();
        const revealHandleTemporarily = (handle) => {
            if (!handle) return;
            const previousTimer = handleOpacityTimers.get(handle);
            if (previousTimer) clearTimeout(previousTimer);
            handle.classList.add('is-opaque');
            const timer = setTimeout(() => {
                handle.classList.remove('is-opaque');
                handleOpacityTimers.delete(handle);
            }, 3000);
            handleOpacityTimers.set(handle, timer);
        };
        this.revealPreviewHandleTemporarily = revealHandleTemporarily;
        this.element.querySelectorAll('.pp-preview-edge, .pp-pane-handle, .pp-editor-handle').forEach((handle) => {
            handle.addEventListener('pointerenter', () => revealHandleTemporarily(handle));
            handle.addEventListener('pointerdown', () => revealHandleTemporarily(handle));
            handle.addEventListener('click', () => revealHandleTemporarily(handle));
            handle.addEventListener('focus', () => revealHandleTemporarily(handle));
        });
        // 编辑页右缘把手：点击/左拉展开
        this.element.querySelectorAll('.pp-preview-edge').forEach((edge) => {
            edge.addEventListener('click', () => this.openPreview());
            bindDrag(edge, () => this.openPreview(), null);
        });
        // 分栏线两侧提环：编辑侧左拉→全屏，预览侧右拉→收合（两者拖拽语义一致）
        const paneHandle = this.element.querySelector('#preset-preview-expand');
        if (paneHandle) {
            paneHandle.addEventListener('click', () => this.setPreviewState('full'));
            bindDrag(paneHandle, () => this.setPreviewState('full'), () => this.closePreview());
        }
        const paneCollapse = this.element.querySelector('#preset-preview-collapse');
        if (paneCollapse) {
            paneCollapse.addEventListener('click', () => this.closePreview());
            bindDrag(paneCollapse, () => this.setPreviewState('full'), () => this.closePreview());
        }
        // 全屏时左缘「编辑」把手：桌面回分栏、手机收回编辑器
        const editorReturn = this.element.querySelector('#preset-editor-return');
        if (editorReturn) {
            const back = () => this.setPreviewState(this.isPreviewPhoneLayout() ? 'closed' : 'split');
            editorReturn.addEventListener('click', back);
            bindDrag(editorReturn, null, back);
        }
        pane.querySelector('#preset-preview-close')?.addEventListener('click', () => this.closePreview());
        pane.querySelector('#preset-preview-refresh')?.addEventListener('click', () => this.rebuildPreviewSkeleton());
        const macroBtn = pane.querySelector('#preset-preview-toggle-macroeval');
        macroBtn?.addEventListener('click', () => {
            this.previewRawBlocks = !this.previewRawBlocks;
            macroBtn.classList.toggle('is-on', !this.previewRawBlocks);
            this.rebuildPreviewSkeleton();
        });
        // 宏 token 悬停（桌面）/点按（手机）求值气泡
        const tip = document.createElement('div');
        tip.className = 'pp-macro-tip';
        tip.hidden = true;
        this.element.appendChild(tip);
        this.macroTipEl = tip;
        const showTip = (target) => {
            const evalFn = this.runtimeContext?.evalScenePreviewMacro;
            if (typeof evalFn !== 'function' || !target) return;
            const res = evalFn(target.textContent || '', { previewUiMode: this.getPreviewUiMode() }) || {};
            if (!res.text) { tip.hidden = true; return; }
            tip.textContent = res.text;
            tip.dataset.kind = res.kind || '';
            tip.hidden = false;
            tip.style.left = '0px';
            tip.style.top = '0px';
            const r = target.getBoundingClientRect();
            const tw = tip.offsetWidth;
            const th = tip.offsetHeight;
            const left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
            const top = r.top - th - 6 >= 8 ? r.top - th - 6 : r.bottom + 6;
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        };
        const hideTip = () => { tip.hidden = true; };
        this.hideMacroTip = hideTip;
        this.previewBodyEl?.addEventListener('mouseover', (e) => {
            if (!window.matchMedia?.('(pointer: fine)')?.matches) return;
            const mk = e.target?.closest?.('.pp-macro');
            if (mk) showTip(mk);
        });
        this.previewBodyEl?.addEventListener('mouseout', (e) => {
            if (e.target?.closest?.('.pp-macro')) hideTip();
        });
        this.showMacroTip = showTip;
        /* 回声抑制：程序发起的滚动（联动跟随）不得再触发反向联动。
           程序滚动前打标记（目标位置+时限），滚动事件先消化标记；用户 wheel/触摸接管立即清标。 */
        // 预设变更（切换/保存/新建/导入/启停）→ 骨架失效：预览开着就重建，关着标记下次展开重建
        window.addEventListener('preset-changed', () => {
            if (this._previewInvalidateTimer) clearTimeout(this._previewInvalidateTimer);
            this._previewInvalidateTimer = setTimeout(() => {
                if (!this.element) return;
                const panelVisible = this.element.style.display !== 'none';
                if (panelVisible && this.previewState && this.previewState !== 'closed') this.rebuildPreviewSkeleton();
                else {
                    this.previewBuildQueue?.invalidate?.();
                    this.previewSkeleton = null;
                }
            }, 200);
        });
        let scrollTimer = null;
        this.previewScrollEl?.addEventListener('scroll', () => {
            this.hideMacroTip?.();
            const auto = this._paneAutoScroll;
            if (auto) {
                // 只按超时/用户接管解除：抵达目标附近后 smooth 仍有拖尾帧，提早清标会漏回声
                if (Date.now() > auto.until) this._paneAutoScroll = null;
                return;
            }
            if (scrollTimer) return;
            scrollTimer = setTimeout(() => { scrollTimer = null; this.onPreviewScroll(); }, 90);
        }, { passive: true });
        ['wheel', 'touchstart', 'pointerdown'].forEach((evt) => {
            this.previewScrollEl?.addEventListener(evt, () => { this._paneAutoScroll = null; }, { passive: true });
        });
        // 二级列表滚动 → 预览跟随（反向联动的对称边）
        let listScrollTimer = null;
        this.detailScrollEl?.addEventListener('scroll', () => {
            if (Date.now() < (this._listAutoScrollUntil || 0)) return;
            if (listScrollTimer) return;
            listScrollTimer = setTimeout(() => { listScrollTimer = null; this.onEditorListScroll(); }, 90);
        }, { passive: true });
        ['wheel', 'touchstart', 'pointerdown'].forEach((evt) => {
            this.detailScrollEl?.addEventListener(evt, () => { this._listAutoScrollUntil = 0; }, { passive: true });
        });
        // 预览内直接编辑区块段落（contenteditable）→ 写回草稿
        this.previewBodyEl?.addEventListener('input', (e) => {
            const span = e.target?.closest?.('[data-pp-prev-block]');
            if (span) this.onPreviewBlockEdited(span);
        });
        // 普通段落在预览内编辑后失焦 → 若已偏离基线，转为 diff 视图（编辑态 blur 由 enterPreviewBlockEdit 自收口）
        this.previewBodyEl?.addEventListener('focusout', (e) => {
            const span = e.target?.closest?.('[data-pp-prev-block]');
            if (!span || span.classList.contains('is-editing')) return;
            const id = span.getAttribute('data-pp-prev-block') || '';
            if (id && this.isBlockDraftModified(id)) this.refreshPreviewMessageFor(id);
        });
        // 每处修改（hunk）旁 ✔/×（快捷、无确认）；点击 diff 正文切换为直接编辑；点按宏 token 看求值（手机主通道）
        this.previewBodyEl?.addEventListener('click', (e) => {
            const acc = e.target?.closest?.('[data-pp-accept-hunk]');
            if (acc) {
                e.preventDefault();
                this.acceptBlockHunk(acc.getAttribute('data-pp-block') || '', Number(acc.getAttribute('data-pp-accept-hunk')));
                return;
            }
            const rej = e.target?.closest?.('[data-pp-reject-hunk]');
            if (rej) {
                e.preventDefault();
                this.rejectBlockHunk(rej.getAttribute('data-pp-block') || '', Number(rej.getAttribute('data-pp-reject-hunk')));
                return;
            }
            const mk = e.target?.closest?.('.pp-macro');
            if (mk) { this.macroTipEl?.hidden === false ? this.hideMacroTip?.() : this.showMacroTip?.(mk); return; }
            this.hideMacroTip?.();
            const mod = e.target?.closest?.('.pp-prev-block.is-modified');
            if (mod && !mod.classList.contains('is-editing')) this.enterPreviewBlockEdit(mod);
        });
    }

    openPreview() {
        if (!this.previewPaneEl) return;
        this._lastFlashBlockId = ''; // 重新展开时首次定位允许闪一次
        this.setPreviewState(this.isPreviewPhoneLayout() ? 'full' : 'split');
        this.previewDiscoveryGuide?.complete?.();
        if (!this.previewSkeleton) this.rebuildPreviewSkeleton();
        else {
            this.renderPreviewBody();
            this.positionPreviewToCurrentBlock();
        }
    }

    closePreview({ animate = true } = {}) {
        this.setPreviewState('closed', { animate });
        this.syncPreviewDiscoveryGuide();
    }

    /* 预览组装场景由注入选择条驱动：选了私聊/群聊或加入了聊天类项 → chat，否则创意写作；
       仅创意写作预设按分域固定走创意写作预览 */
    getPreviewUiMode() {
        const effective = this.getInjectEffectiveDisplayState();
        return buildPreviewInjectFlags({
            added: effective.added,
            previewScenario: effective.previewScenario,
        }).previewUiMode;
    }

    rebuildPreviewSkeleton() {
        const buildFn = this.runtimeContext?.buildScenePromptPreviewRequest;
        if (typeof buildFn !== 'function' || !this.previewBodyEl) return;
        const effective = this.getInjectEffectiveDisplayState();
        const flags = buildPreviewInjectFlags({
            added: effective.added,
            previewScenario: effective.previewScenario,
        });
        return this.previewBuildQueue?.request?.({
            ...flags,
            // 预设面板从通用设定打开、无会话历史语境：聊天记录固定折叠为占位
            includeHistory: false,
            rawBlocks: this.previewRawBlocks !== false,
        });
    }

    /* 三级页展开/重建预览后定位到正在编辑的区块（延迟等分栏宽度过渡结束，几何才准）；从第一行对齐 */
    positionPreviewToCurrentBlock() {
        if (this._previewPosTimer) clearTimeout(this._previewPosTimer);
        this._previewPosTimer = setTimeout(() => {
            if (this.previewState === 'closed' || this.currentPage !== 'block') return;
            const id = this.currentBlockCard?.dataset?.identifier || '';
            if (!id) return;
            const taEl = this.blockEditorEl?.querySelector('textarea');
            if (!this.scrollPreviewToBlockLine(id, 0, taEl?.value ?? '')) {
                this.scrollPreviewToBlockRatio(id, 0);
            }
        }, 380);
    }

    previewMessageText(message) {
        const c = message?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(part => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('');
        return String(c ?? '');
    }

    /* 用「已保存基线」内容在骨架消息里定位各区块的段落。
       整段命中 → exact（可编辑/草稿替换/diff）；含宏被改写的块退而求其次：
       取宏切分后最长的字面片段做模糊锚定（仅参与滚动联动，不做内容替换）。 */
    mapBlocksToPreview() {
        const messages = Array.isArray(this.previewSkeleton?.messages) ? this.previewSkeleton.messages : [];
        const texts = messages.map(m => this.previewMessageText(m));
        const blocks = this.getBlockCards().map(card => ({
            id: card.dataset.identifier || '',
            marker: card.dataset.marker === 'true',
            enabled: card.querySelector('.block-enabled')?.checked !== false,
            content: String(this.openaiBlockBase?.get?.(card.dataset.identifier || '')?.content ?? ''),
        }));
        this.previewBlockMap = buildPresetPreviewBlockMap({ messageTexts: texts, blocks });
    }

    /* 原样区块正文渲染：宏 token（{{...}} / <% %>）包成可悬停/点按求值的小段 */
    renderRawBlockContentHtml(text) {
        const s = String(text ?? '');
        const re = /\{\{[^{}]*\}\}|<%[\s\S]*?%>/g;
        let html = '';
        let pos = 0;
        let m;
        while ((m = re.exec(s))) {
            html += escapeHtml(s.slice(pos, m.index));
            html += `<span class="pp-macro">${escapeHtml(m[0])}</span>`;
            pos = m.index + m[0].length;
        }
        html += escapeHtml(s.slice(pos));
        return html;
    }

    /* 区块 diff（红删绿增，行级；复用格式修复的 line-diff-utils）。
       连续变更行为一个 hunk，hunk 末行右侧紧跟小型 SVG 操作（hunk 级接受/回滚）。 */
    renderBlockDiffHtml(baseText, draftText, blockIdAttr = '') {
        const rows = annotateLineDiffWords(buildLineDiff(baseText, draftText, { collapseContext: false }).rows);
        const isChanged = r => r?.type === 'del' || r?.type === 'add';
        let html = '';
        let hunk = -1;
        for (let i = 0; i < rows.length; i += 1) {
            const r = rows[i];
            const nl = i < rows.length - 1 ? '\n' : '';
            if (!isChanged(r)) { html += `${escapeHtml(r.text)}${nl}`; continue; }
            if (!isChanged(rows[i - 1])) hunk += 1;
            // 改写配对的行只在行内标出具体改动的字词，文字内容不变
            const words = r.words ? renderWordDiffHtml(r.words, { side: r.type === 'del' ? 'old' : 'new', escape: escapeHtml }) : '';
            const body = r.type === 'del'
                ? `<del class="pp-diff-del${words ? ' is-partial' : ''}">${words || escapeHtml(r.text)}</del>`
                : `<ins class="pp-diff-ins${words ? ' is-partial' : ''}">${words || escapeHtml(r.text)}</ins>`;
            // hunk 末行：换行前插紧跟的小型接受/回滚操作
            const actions = !isChanged(rows[i + 1])
                ? `<span class="pp-diff-actions" contenteditable="false">`
                    + `<button type="button" class="pp-diff-accept" data-pp-accept-hunk="${hunk}" data-pp-block="${blockIdAttr}" aria-label="接受此处修改并保存" title="接受此处修改并保存">${diffAcceptSvg}</button>`
                    + `<button type="button" class="pp-diff-reject" data-pp-reject-hunk="${hunk}" data-pp-block="${blockIdAttr}" aria-label="回滚此处修改" title="回滚此处修改">${diffRejectSvg}</button>`
                    + `</span>`
                : '';
            html += `${body}${actions}${nl}`;
        }
        return html;
    }

    /* hunk 级结果计算：accept=基线只应用第 k 个 hunk；reject=草稿只回滚第 k 个 hunk */
    applyBlockHunk(baseText, draftText, hunkIdx, mode) {
        return applyPresetBlockHunk(baseText, draftText, hunkIdx, mode);
    }

    renderPreviewMessageHtml(index) {
        const messages = Array.isArray(this.previewSkeleton?.messages) ? this.previewSkeleton.messages : [];
        const message = messages[index];
        if (!message) return '';
        const text = this.previewMessageText(message);
        const spans = [];
        this.previewBlockMap.forEach((loc, id) => { if (loc.msg === index) spans.push({ id, ...loc }); });
        spans.sort((a, b) => a.start - b.start);
        let html = '';
        let pos = 0;
        for (const span of spans) {
            html += escapeHtml(text.slice(pos, span.start));
            const idAttr = escapeHtml(span.id);
            const baseSlice = text.slice(span.start, span.start + span.len);
            const baseFullRaw = this.openaiBlockBase?.get?.(span.id)?.content;
            const baseFull = typeof baseFullRaw === 'string' && baseFullRaw === baseSlice ? baseFullRaw : baseSlice;
            if (span.exact === false) {
                // 模糊锚定：只做滚动联动，内容按骨架原样展示
                html += `<span class="pp-prev-block pp-prev-anchor" data-pp-prev-block="${idAttr}">${escapeHtml(baseSlice)}</span>`;
            } else if (this.isBlockDraftContentModified(span.id)) {
                // 有未保存修改：红删绿增 diff，每处 hunk 末行紧跟小 ✔/×（点击正文可切换为直接编辑）
                const draft = this.openaiBlockDrafts.get(span.id);
                html += `<span class="pp-prev-block is-modified" data-pp-prev-block="${idAttr}">${this.renderBlockDiffHtml(baseFull, String(draft?.content ?? ''), idAttr)}</span>`;
            } else {
                const draft = this.openaiBlockDrafts?.get?.(span.id);
                const liveContent = draft ? String(draft.content ?? '') : baseFull;
                html += `<span class="pp-prev-block" data-pp-prev-block="${idAttr}" contenteditable="plaintext-only" spellcheck="false">${this.renderRawBlockContentHtml(liveContent)}</span>`;
            }
            pos = span.start + span.len;
        }
        html += escapeHtml(text.slice(pos));
        return `
            <div class="pp-preview-msg" data-pp-prev-msg="${index}">
                <div class="pp-preview-msg-role">${escapeHtml(String(message.role || ''))} #${index}</div>
                <div class="pp-preview-msg-text">${html}</div>
            </div>
        `;
    }

    /* 重渲染某区块所在的预览消息卡（编辑防抖、blur 收编辑态、接受/舍弃后共用） */
    refreshPreviewMessageFor(identifier) {
        const loc = this.previewBlockMap?.get?.(identifier);
        if (!loc || !this.previewBodyEl) return;
        const cardEl = this.previewBodyEl.querySelector(`[data-pp-prev-msg="${loc.msg}"]`);
        if (!cardEl) return;
        const template = document.createElement('template');
        template.innerHTML = this.renderPreviewMessageHtml(loc.msg).trim();
        const next = template.content.firstElementChild;
        if (next) cardEl.replaceWith(next);
        this.updatePreviewEstimate();
    }

    renderPreviewBody() {
        if (!this.previewBodyEl || !this.previewSkeleton) return;
        const messages = Array.isArray(this.previewSkeleton.messages) ? this.previewSkeleton.messages : [];
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
        }
        let html = '';
        for (let i = 0; i < messages.length; i += 1) {
            if (i === lastUserIdx) {
                html += '<div class="pp-prev-history-chip">聊天记录占位：实际发送时在此展开当前会话记录</div>';
            }
            html += this.renderPreviewMessageHtml(i);
        }
        this.previewBodyEl.innerHTML = html;
        this.updatePreviewEstimate();
    }

    updatePreviewEstimate() {
        if (!this.previewEstEl || !this.previewSkeleton) return;
        try {
            const joined = Array.from(this.previewBodyEl?.querySelectorAll('.pp-preview-msg-text') || [])
                .map(el => el.textContent || '')
                .join('\n');
            const calibration = this.runtimeContext?.getTokenCalibration?.() || {};
            const coefficient = Number(calibration?.coefficient);
            const mode = {
                mode: 'rough',
                coefficient: Number.isFinite(coefficient) && coefficient > 0 ? coefficient : 1,
            };
            const samples = Math.max(0, Math.trunc(Number(calibration?.samples)) || 0);
            const label = samples > 0
                ? `本地校准估算 ×${mode.coefficient.toFixed(3)} · ${samples} 次`
                : '本地估算 · 待校准';
            this.previewEstEl.textContent = `~${estimateTokens(joined, mode)} tokens（${label}）`;
        } catch {
            this.previewEstEl.textContent = '';
        }
    }

    /* 联动定位提示：单个区块缓慢闪烁两下后恢复（无常驻高亮）。
       同一区块内滚动不重复闪，换区块才闪。 */
    flashPreviewBlock(identifier) {
        if (!identifier || !this.previewBodyEl) return;
        if (identifier === this._lastFlashBlockId) return;
        this._lastFlashBlockId = identifier;
        this.previewBodyEl.querySelectorAll('.pp-prev-flash').forEach(el => el.classList.remove('pp-prev-flash'));
        let span = null;
        try { span = this.previewBodyEl.querySelector(`[data-pp-prev-block="${CSS.escape(identifier)}"]`); } catch {}
        if (!span) return;
        void span.offsetWidth; // 重启动画
        span.classList.add('pp-prev-flash');
        const clear = () => span.classList.remove('pp-prev-flash');
        span.addEventListener('animationend', clear, { once: true });
        if (this._prevFlashTimer) clearTimeout(this._prevFlashTimer);
        this._prevFlashTimer = setTimeout(clear, 2500); // reduced-motion / 动画被打断的兜底
    }

    /* 区块内容编辑 → 只重渲染受影响的消息卡（草稿实时替换/diff 实时刷新） */
    schedulePreviewLiveUpdate(identifier) {
        if (this.previewState === 'closed' || !this.previewSkeleton) return;
        if (this._previewLiveTimer) clearTimeout(this._previewLiveTimer);
        this._previewLiveTimer = setTimeout(() => {
            // 预览内正在编辑时不重渲染（会打断光标）
            if (this.previewBodyEl?.querySelector('.pp-prev-block.is-editing:focus')) return;
            this.refreshPreviewMessageFor(identifier);
        }, 350);
    }

    /* 预览滚动到某区块段落内的相对位置（0=段首，1=段尾）；编辑光标/正文滚动/列表滚动共用 */
    scrollPreviewToBlockRatio(identifier, ratio = 0) {
        if (this.previewState === 'closed' || !this.previewScrollEl || !identifier) return;
        if (Date.now() - (this._previewScrollGuard || 0) < 450) return;
        let span = null;
        try { span = this.previewBodyEl?.querySelector(`[data-pp-prev-block="${CSS.escape(identifier)}"]`); } catch {}
        if (!span) return;
        const pane = this.previewScrollEl;
        const r = Math.min(1, Math.max(0, Number(ratio) || 0));
        const paneRect = pane.getBoundingClientRect();
        const spanRect = span.getBoundingClientRect();
        const target = pane.scrollTop + (spanRect.top - paneRect.top) + r * spanRect.height - pane.clientHeight * 0.33;
        this._editorScrollGuard = Date.now();
        const dest = Math.min(Math.max(0, target), Math.max(0, pane.scrollHeight - pane.clientHeight));
        if (Math.abs(dest - pane.scrollTop) >= 2) {
            // 程序滚动标记：预览 scroll 事件吞掉回声，抵达目标或超时/用户接管后解除
            this._paneAutoScroll = { target: dest, until: Date.now() + 1600 };
            const reduced = document.body?.dataset?.reducedMotion === 'on'
                || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
            pane.scrollTo({ top: dest, behavior: reduced ? 'auto' : 'smooth' });
        }
        this.flashPreviewBlock(identifier);
    }

    /* span 内文本节点游标：把字符偏移定位到 [textNode, innerOffset]（选区/行锚定共用） */
    locateTextOffsetInSpan(span, offset) {
        if (!span) return null;
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let node = walker.nextNode();
        while (node) {
            const len = node.textContent.length;
            if (offset <= acc + len) return [node, offset - acc];
            acc += len;
            node = walker.nextNode();
        }
        return null;
    }

    taLineHeightPx(textarea) {
        try {
            const cs = getComputedStyle(textarea);
            const lh = parseFloat(cs.lineHeight);
            if (Number.isFinite(lh) && lh > 0) return lh;
            const fs = parseFloat(cs.fontSize);
            return Number.isFinite(fs) ? fs * 1.45 : 0;
        } catch { return 0; }
    }

    /* 行锚定：预览滚到区块段内第 line 逻辑行（VS Code diff 式精确联动）。
       要求段落为逐字态（span 文本 === 编辑器文本）；否则返回 false 由调用方回退比例法。 */
    scrollPreviewToBlockLine(identifier, lineIdx, taValue) {
        if (this.previewState === 'closed' || !this.previewScrollEl || !identifier) return false;
        if (Date.now() - (this._previewScrollGuard || 0) < 450) return true; // guard 期内视为已处理
        let span = null;
        try { span = this.previewBodyEl?.querySelector(`[data-pp-prev-block="${CSS.escape(identifier)}"]`); } catch {}
        if (!span) return false;
        const spanText = span.textContent || '';
        if (String(taValue ?? '') !== spanText) return false;
        const lines = spanText.split('\n');
        const li = Math.max(0, Math.min(lines.length - 1, Number(lineIdx) || 0));
        let off = 0;
        for (let i = 0; i < li; i += 1) off += lines[i].length + 1;
        const found = this.locateTextOffsetInSpan(span, off);
        if (!found) return false;
        let lineTop = 0;
        try {
            const range = document.createRange();
            range.setStart(found[0], found[1]);
            range.collapse(true);
            const rect = range.getBoundingClientRect();
            if (!rect || (rect.top === 0 && rect.bottom === 0)) return false;
            lineTop = rect.top;
        } catch { return false; }
        const pane = this.previewScrollEl;
        const paneRect = pane.getBoundingClientRect();
        const target = pane.scrollTop + (lineTop - paneRect.top) - pane.clientHeight * 0.33;
        this._editorScrollGuard = Date.now();
        const dest = Math.min(Math.max(0, target), Math.max(0, pane.scrollHeight - pane.clientHeight));
        if (Math.abs(dest - pane.scrollTop) >= 2) {
            // 程序滚动标记：预览 scroll 事件吞掉回声，抵达目标或超时/用户接管后解除
            this._paneAutoScroll = { target: dest, until: Date.now() + 1600 };
            const reduced = document.body?.dataset?.reducedMotion === 'on'
                || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
            pane.scrollTo({ top: dest, behavior: reduced ? 'auto' : 'smooth' });
        }
        this.flashPreviewBlock(identifier);
        return true;
    }

    /* 编辑光标 → 预览定位：行锚定优先，非逐字态回退比例法 */
    syncPreviewToCaret(identifier, textarea) {
        const val = textarea?.value ?? '';
        const caret = textarea?.selectionStart || 0;
        const line = val ? val.slice(0, caret).split('\n').length - 1 : 0;
        if (this.scrollPreviewToBlockLine(identifier, line, val)) return;
        this.scrollPreviewToBlockRatio(identifier, val.length ? caret / val.length : 0);
    }

    /* 三级正文滚动 → 预览跟随：行锚定优先（取编辑器视口 1/3 处的行，与反向基准对称），回退比例法 */
    syncPreviewToEditorScroll(identifier, textarea) {
        if (!textarea) return;
        const lh = this.taLineHeightPx(textarea);
        if (lh > 0) {
            const line = Math.floor((textarea.scrollTop + textarea.clientHeight * 0.33) / lh);
            if (this.scrollPreviewToBlockLine(identifier, line, textarea.value)) return;
        }
        const denom = Math.max(1, textarea.scrollHeight - textarea.clientHeight);
        this.scrollPreviewToBlockRatio(identifier, textarea.scrollTop / denom);
    }

    /* 预览滚动 → 编辑器行跟随：取预览基准线落点的字符偏移换算行号，textarea 滚到对应行 */
    syncEditorToPreviewLine(identifier) {
        const ta = this.blockEditorEl?.querySelector('textarea');
        if (!ta || !this.previewScrollEl) return;
        let span = null;
        try { span = this.previewBodyEl?.querySelector(`[data-pp-prev-block="${CSS.escape(identifier)}"]`); } catch {}
        if (!span || span.textContent !== ta.value) return;
        const pane = this.previewScrollEl;
        const paneRect = pane.getBoundingClientRect();
        const spanRect = span.getBoundingClientRect();
        const y = Math.max(spanRect.top + 1, Math.min(spanRect.bottom - 1, paneRect.top + pane.clientHeight * 0.33));
        const x = Math.max(spanRect.left + 1, Math.min(spanRect.right - 1, (paneRect.left + paneRect.right) / 2));
        let range = null;
        try { range = document.caretRangeFromPoint?.(x, y) || null; } catch {}
        if (!range || !span.contains(range.startContainer)) return;
        let off = 0;
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && node !== range.startContainer) { off += node.textContent.length; node = walker.nextNode(); }
        if (node !== range.startContainer) return;
        off += range.startOffset;
        const line = ta.value.slice(0, off).split('\n').length - 1;
        const lh = this.taLineHeightPx(ta);
        if (!(lh > 0)) return;
        const top = Math.max(0, line * lh - ta.clientHeight * 0.33);
        if (Math.abs(top - ta.scrollTop) > 1) {
            this._taAutoScroll = true; // 编辑器 scroll 监听吞掉这次程序滚动，防回声
            ta.scrollTo({ top, behavior: 'auto' });
        }
    }

    /* 二级列表滚动 → 预览跟随：对齐左侧视口正中的已映射卡（单块定位+闪烁提示） */
    onEditorListScroll() {
        if (this.previewState === 'closed' || this.currentPage !== 'detail' || this.currentSectionId !== 'custom') return;
        if (Date.now() - (this._previewScrollGuard || 0) < 450) return;
        const scroller = this.detailScrollEl;
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const centerY = rect.top + scroller.clientHeight * 0.5;
        let id = '';
        let fallback = '';
        for (const card of this.getBlockCards()) {
            const r = card.getBoundingClientRect();
            if (r.top > centerY) break;
            const cid = card.dataset.identifier || '';
            if (!cid || !this.previewBlockMap?.has?.(cid)) continue;
            fallback = cid; // 中线上方最近的已映射卡（中线卡未映射时兜底）
            if (r.bottom >= centerY) id = cid; // 正压中线
        }
        const pick = id || fallback;
        if (pick) this.scrollPreviewToBlockRatio(pick, 0);
    }

    /* 预览内直接编辑区块段落 → 写回草稿并同步左侧编辑器 */
    onPreviewBlockEdited(span) {
        const id = span?.getAttribute?.('data-pp-prev-block') || '';
        const draft = this.ensureBlockDraft(id);
        if (!draft) return;
        draft.content = String(span.textContent ?? '');
        this.scheduleUnsavedIndicatorUpdate();
        if (this.currentPage === 'block' && this.currentBlockCard?.dataset?.identifier === id) {
            const ta = this.blockEditorEl?.querySelector('textarea');
            if (ta && ta.value !== draft.content && document.activeElement !== ta) ta.value = draft.content;
        }
        // 只防抖刷新估算，不重渲染（避免打断预览内的输入光标）
        if (this._previewEstTimer) clearTimeout(this._previewEstTimer);
        this._previewEstTimer = setTimeout(() => this.updatePreviewEstimate(), 500);
    }

    /* 预览滚动 → 编辑器跟随（三级：切到对应区块；二级：列表滚到对应卡并短暂高亮） */
    onPreviewScroll() {
        if (this.previewState === 'closed' || !this.previewScrollEl) return;
        if (Date.now() - (this._editorScrollGuard || 0) < 450) return;
        const pane = this.previewScrollEl;
        const paneRect = pane.getBoundingClientRect();
        const lineY = paneRect.top + pane.clientHeight * 0.33;
        let currentId = '';
        for (const span of this.previewBodyEl?.querySelectorAll('[data-pp-prev-block]') || []) {
            const r = span.getBoundingClientRect();
            if (r.top <= lineY && r.bottom >= paneRect.top) currentId = span.getAttribute('data-pp-prev-block') || currentId;
            if (r.top > lineY) break;
        }
        if (!currentId) return;
        const card = this.getBlockCards().find(c => c.dataset.identifier === currentId);
        if (!card) return;
        this._previewScrollGuard = Date.now();
        if (this.currentPage === 'block') {
            if (card !== this.currentBlockCard) this.openOpenAIBlockEditor(card);
            this.syncEditorToPreviewLine(currentId);
        } else if (this.currentPage === 'detail') {
            this._listAutoScrollUntil = Date.now() + 1000; // 列表 scroll 监听吞掉这次程序滚动
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            card.classList.add('pp-block-linked');
            if (this._linkFlashTimer) clearTimeout(this._linkFlashTimer);
            this._linkFlashTimer = setTimeout(() => card.classList.remove('pp-block-linked'), 900);
        }
    }

    /* ════════════════════════════════════════
       Data collection & Save
       ════════════════════════════════════════ */
    getDraftKey(storeType, presetId) {
        const st = String(storeType || '').trim();
        const id = String(presetId || '').trim();
        if (!st || !id) return null;
        return `${st}:${id}`;
    }

    captureDraftsFromDOM() {
        if (!this.element) return;
        this.captureCurrentDetailDraft();
    }

    collectSectionData(sectionId, root, base) {
        const current = deepClone(base || {});
        const appScope = root.querySelector('#preset-app-scope')?.value;
        if (appScope) {
            current.app_scope = normalizePresetAppScope(appScope, PRESET_APP_SCOPES.creative);
        }

        if (sectionId === 'sysprompt') {
            current.content = root.querySelector('#sysprompt-content')?.value ?? '';
            current.post_history = root.querySelector('#sysprompt-post')?.value ?? '';
            // 位置卡未渲染时保留原字段，避免被静默重置为默认值
            if (!root.querySelector('#phone-format-intro-position')) return current;
            current.phone_format_intro_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-intro-position')?.value);
            current.phone_format_intro_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-intro-depth')?.value);
            current.phone_format_chat_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-chat-position')?.value);
            current.phone_format_chat_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-chat-depth')?.value);
            current.phone_format_moment_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-moment-position')?.value);
            current.phone_format_moment_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-moment-depth')?.value);
            current.phone_format_footer_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-footer-position')?.value);
            current.phone_format_footer_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-footer-depth')?.value);
            return current;
        }

        if (sectionId === 'chatprompts') {
            if (!root.querySelector('#phone-format-intro-rules') && !root.querySelector('#dialogue-rules')) {
                return current;
            }
            current.phone_format_intro_enabled = Boolean(root.querySelector('#phone-format-intro-enabled')?.checked);
            current.phone_format_intro_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-intro-position')?.value);
            current.phone_format_intro_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-intro-depth')?.value);
            current.phone_format_intro_rules = root.querySelector('#phone-format-intro-rules')?.value ?? '';
            current.phone_format_chat_enabled = Boolean(root.querySelector('#phone-format-chat-enabled')?.checked);
            current.phone_format_chat_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-chat-position')?.value);
            current.phone_format_chat_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-chat-depth')?.value);
            current.phone_format_chat_rules = root.querySelector('#phone-format-chat-rules')?.value ?? '';
            current.phone_format_moment_enabled = Boolean(root.querySelector('#phone-format-moment-enabled')?.checked);
            current.phone_format_moment_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-moment-position')?.value);
            current.phone_format_moment_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-moment-depth')?.value);
            current.phone_format_moment_rules = root.querySelector('#phone-format-moment-rules')?.value ?? '';
            current.phone_format_footer_enabled = Boolean(root.querySelector('#phone-format-footer-enabled')?.checked);
            current.phone_format_footer_position = normalizePhoneFormatPromptPosition(root.querySelector('#phone-format-footer-position')?.value);
            current.phone_format_footer_depth = normalizePhoneFormatPromptDepth(root.querySelector('#phone-format-footer-depth')?.value);
            current.phone_format_footer_rules = root.querySelector('#phone-format-footer-rules')?.value ?? '';
            current.dialogue_enabled = Boolean(root.querySelector('#dialogue-enabled')?.checked);
            current.dialogue_position = getInt(root.querySelector('#dialogue-position')?.value, current.dialogue_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
            current.dialogue_depth = getInt(root.querySelector('#dialogue-depth')?.value, current.dialogue_depth ?? 1);
            current.dialogue_role = getInt(root.querySelector('#dialogue-role')?.value, current.dialogue_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.dialogue_rules = root.querySelector('#dialogue-rules')?.value ?? '';
            current.moment_create_enabled = Boolean(root.querySelector('#moment-enabled')?.checked);
            current.moment_create_position = getInt(root.querySelector('#moment-position')?.value, current.moment_create_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
            current.moment_create_depth = getInt(root.querySelector('#moment-depth')?.value, current.moment_create_depth ?? 1);
            current.moment_create_role = getInt(root.querySelector('#moment-role')?.value, current.moment_create_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.moment_create_rules = root.querySelector('#moment-rules')?.value ?? '';
            current.moment_comment_enabled = Boolean(root.querySelector('#moment-comment-enabled')?.checked);
            current.moment_comment_position = getInt(root.querySelector('#moment-comment-position')?.value, current.moment_comment_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
            current.moment_comment_depth = getInt(root.querySelector('#moment-comment-depth')?.value, current.moment_comment_depth ?? 0);
            current.moment_comment_role = getInt(root.querySelector('#moment-comment-role')?.value, current.moment_comment_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.moment_comment_rules = root.querySelector('#moment-comment-rules')?.value ?? '';
            current.moment_publish_comment_enabled = Boolean(root.querySelector('#moment-publish-comment-enabled')?.checked);
            current.moment_publish_comment_position = getInt(root.querySelector('#moment-publish-comment-position')?.value, current.moment_publish_comment_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
            current.moment_publish_comment_depth = getInt(root.querySelector('#moment-publish-comment-depth')?.value, current.moment_publish_comment_depth ?? 0);
            current.moment_publish_comment_role = getInt(root.querySelector('#moment-publish-comment-role')?.value, current.moment_publish_comment_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.moment_publish_comment_rules = root.querySelector('#moment-publish-comment-rules')?.value ?? '';
            current.auto_image_prompt_enabled = Boolean(root.querySelector('#auto-image-prompt-enabled')?.checked);
            current.auto_image_prompt_position = getInt(root.querySelector('#auto-image-prompt-position')?.value, current.auto_image_prompt_position ?? EXT_PROMPT_TYPES.IN_CHAT);
            current.auto_image_prompt_depth = getInt(root.querySelector('#auto-image-prompt-depth')?.value, current.auto_image_prompt_depth ?? 0);
            current.auto_image_prompt_role = getInt(root.querySelector('#auto-image-prompt-role')?.value, current.auto_image_prompt_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.auto_image_prompt_rules = root.querySelector('#auto-image-prompt-rules')?.value ?? '';
            current.group_enabled = Boolean(root.querySelector('#group-enabled')?.checked);
            current.group_position = getInt(root.querySelector('#group-position')?.value, current.group_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
            current.group_depth = getInt(root.querySelector('#group-depth')?.value, current.group_depth ?? 1);
            current.group_role = getInt(root.querySelector('#group-role')?.value, current.group_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.group_rules = root.querySelector('#group-rules')?.value ?? '';
            current.summary_enabled = Boolean(root.querySelector('#summary-enabled')?.checked);
            current.summary_position = getInt(root.querySelector('#summary-position')?.value, current.summary_position ?? EXT_PROMPT_TYPES.IN_CHAT);
            current.summary_rules = root.querySelector('#summary-rules')?.value ?? '';
            current.ds_format_enabled = Boolean(root.querySelector('#ds-format-enabled')?.checked);
            current.ds_format_rules = root.querySelector('#ds-format-rules')?.value ?? '';
            return current;
        }

        if (sectionId === 'context') {
            current.story_string = root.querySelector('#context-story')?.value ?? '';
            current.story_string_position = getInt(root.querySelector('#context-position')?.value, current.story_string_position ?? EXT_PROMPT_TYPES.IN_PROMPT);
            current.story_string_depth = getInt(root.querySelector('#context-depth')?.value, current.story_string_depth ?? 1);
            current.story_string_role = getInt(root.querySelector('#context-role')?.value, current.story_string_role ?? EXT_PROMPT_ROLES.SYSTEM);
            current.example_separator = root.querySelector('#context-example-sep')?.value ?? '';
            current.chat_start = root.querySelector('#context-chat-start')?.value ?? '';
            current.names_as_stop_strings = Boolean(root.querySelector('#context-names-stop')?.checked);
            current.use_stop_strings = Boolean(root.querySelector('#context-use-stop')?.checked);
            current.trim_sentences = Boolean(root.querySelector('#context-trim')?.checked);
            current.single_line = Boolean(root.querySelector('#context-single')?.checked);
            return current;
        }

        if (sectionId === 'instruct') {
            current.input_sequence = root.querySelector('#ins-input-seq')?.value ?? '';
            current.output_sequence = root.querySelector('#ins-output-seq')?.value ?? '';
            current.system_sequence = root.querySelector('#ins-system-seq')?.value ?? '';
            current.stop_sequence = root.querySelector('#ins-stop-seq')?.value ?? '';
            current.wrap = Boolean(root.querySelector('#ins-wrap')?.checked);
            current.macro = Boolean(root.querySelector('#ins-macro')?.checked);
            current.skip_examples = Boolean(root.querySelector('#ins-skip-examples')?.checked);
            return current;
        }

        if (sectionId === 'reasoning') {
            current.prefix = root.querySelector('#reasoning-prefix')?.value ?? '';
            current.suffix = root.querySelector('#reasoning-suffix')?.value ?? '';
            current.separator = root.querySelector('#reasoning-separator')?.value ?? '';
            return current;
        }

        if (sectionId === 'openai') {
            current.temperature = getNum(root.querySelector('#gen-temperature')?.value, current.temperature ?? 1);
            current.top_p = getNum(root.querySelector('#gen-top-p')?.value, current.top_p ?? 0.98);
            current.top_k = getInt(root.querySelector('#gen-top-k')?.value, current.top_k ?? 64);
            current.openai_max_context = getInt(root.querySelector('#gen-max-context-num')?.value ?? root.querySelector('#gen-max-context')?.value, current.openai_max_context ?? 131072);
            current.openai_max_tokens = getInt(root.querySelector('#gen-max-tokens')?.value, current.openai_max_tokens ?? 8192);
            current.presence_penalty = getNum(root.querySelector('#gen-presence')?.value, current.presence_penalty ?? 0);
            current.frequency_penalty = getNum(root.querySelector('#gen-frequency')?.value, current.frequency_penalty ?? 0);
            if (root.querySelector('#gen-request-reasoning')) {
                current.request_reasoning = Boolean(root.querySelector('#gen-request-reasoning')?.checked);
            }
            if (root.querySelector('#gen-reasoning-effort')) {
                current.reasoning_effort = normalizeReasoningEffort(
                    root.querySelector('#gen-reasoning-effort')?.value,
                    current.reasoning_effort ?? 'high',
                    { allowCustom: true },
                );
            } else {
                current.reasoning_effort = normalizeReasoningEffort(
                    current.reasoning_effort,
                    'high',
                    { allowCustom: true },
                );
            }
            current.response_target_chat = root.querySelector('#gen-response-target-chat')?.value === 'user' ? 'user' : 'character';
            current.response_target_rp = root.querySelector('#gen-response-target-rp')?.value === 'character' ? 'character' : 'user';
            const memoryDataPositionEl = root.querySelector('#gen-memory-data-position');
            const memoryDataDepthEl = root.querySelector('#gen-memory-data-depth');
            const memoryGuidePositionEl = root.querySelector('#gen-memory-guide-position');
            const memoryGuideDepthEl = root.querySelector('#gen-memory-guide-depth');
            if (memoryDataPositionEl) current.memory_data_position = String(memoryDataPositionEl.value || '').trim().toLowerCase();
            if (memoryDataDepthEl) current.memory_data_depth = getInt(memoryDataDepthEl.value, current.memory_data_depth ?? 0);
            if (memoryGuidePositionEl) current.memory_guide_position = String(memoryGuidePositionEl.value || '').trim().toLowerCase();
            if (memoryGuideDepthEl) current.memory_guide_depth = getInt(memoryGuideDepthEl.value, current.memory_guide_depth ?? 0);
            delete current.boundProfileId;
            return current;
        }

        if (sectionId === 'custom') {
            const prompts = Array.isArray(current.prompts) ? current.prompts : [];
            const promptById = new Map();
            prompts.forEach(pr => { if (pr?.identifier) promptById.set(pr.identifier, pr); });

            // 懒渲染后区块编辑草稿在 openaiBlockDrafts（列表卡不再携带隐藏表单），此处合并
            const blockDrafts = this.openaiBlockDrafts instanceof Map ? this.openaiBlockDrafts : new Map();
            blockDrafts.forEach((draft, ident) => {
                if (!ident) return;
                const existing = promptById.get(ident) || { identifier: ident };
                promptById.set(ident, {
                    ...existing, identifier: ident,
                    name: (draft.name || existing.name || ident),
                    role: roleIdToName(draft.role || existing.role || 'system'),
                    system_prompt: typeof draft.system_prompt === 'boolean' ? draft.system_prompt : (existing.system_prompt ?? true),
                    marker: false, content: String(draft.content ?? existing.content ?? ''),
                });
            });
            this.openaiDeletedBlockIds?.forEach?.(ident => promptById.delete(ident));

            const blockEls = Array.from(root.querySelectorAll('.openai-block'));
            const order = blockEls.map((el) => {
                const identifier = el.dataset.identifier || '';
                const enabled = el.querySelector('.block-enabled')?.checked !== false;
                return identifier ? { identifier, enabled } : null;
            }).filter(Boolean);

            order.forEach(({ identifier }) => {
                if (!identifier || promptById.has(identifier)) return;
                const known = OPENAI_KNOWN_BLOCKS[identifier];
                if (known?.marker) promptById.set(identifier, { identifier, name: known.label, system_prompt: true, marker: true });
            });

            current.prompts = Array.from(promptById.values());
            if (!Array.isArray(current.prompt_order)) current.prompt_order = [];
            current.prompt_order = [{ character_id: 100001, order }];
            delete current.boundProfileId;
            return current;
        }

        return current;
    }

    /* ════════════════════════════════════════
       Save / New / Rename / Delete
       ════════════════════════════════════════ */
    async onSave() {
        return this.enqueuePresetMutation(async () => {
            await this.store.ready;
            try {
                this.showStatus('保存中…', 'info');
                // 注入编辑器改动不走草稿链路：有未提交编辑时随全局保存一并提交
                // （编辑器 DOM 在切回二级页后仍存在，提交函数读取的是当前输入值）
                if (typeof this.injectEditorCommit === 'function' && this.injectEditorDirty) {
                    await this.injectEditorCommit();
                    this.injectEditorDirty = false;
                    this.refreshInjectUi();
                    this.invalidateOrRebuildPreview();
                }
                this.captureDraftsFromDOM();

                const toSave = [];
                for (const [key, data] of this.drafts.entries()) {
                    const [storeType, presetId] = String(key).split(':');
                    if (!storeType || !presetId) continue;
                    const name = String(data?.name || '').trim() || presetId || '未命名';
                    toSave.push({ storeType, presetId, name, data: { ...(data || {}), name } });
                }

                for (const st of ['sysprompt', 'context', 'instruct', 'openai', 'reasoning']) {
                    const activeId = this.store.getActiveId(st);
                    if (!activeId) continue;
                    const key = this.getDraftKey(st, activeId);
                    if (key && this.drafts.has(key)) continue;
                    const data = deepClone(this.store.getActive(st) || {});
                    const name = String(data?.name || '').trim() || activeId || '未命名';
                    toSave.push({ storeType: st, presetId: activeId, name, data: { ...(data || {}), name } });
                }

                await this.store.upsertMany(toSave);

                this.drafts.clear();
                this.openaiBlockDrafts?.clear?.();
                this.openaiDeletedBlockIds?.clear?.();
                this.showStatus('保存成功', 'success');
                this.renderAllSections();
                this.updateUnsavedIndicator();
                window.dispatchEvent(new CustomEvent('preset-changed'));
            } catch (err) {
                logger.error('保存预设失败', err);
                this.showStatus(err.message || '保存失败', 'error');
                return false;
            }
            return true;
        });
    }

    async onNewForStoreType(storeType) {
        await this.store.ready;
        const name = prompt('新建预设名称', '新预设');
        if (!name) return;
        if (storeType === 'openai' && !(await this.confirmDiscardBlockDrafts('新建并切换预设'))) return;
        let base = null;
        if (storeType === 'openai') {
            base = this.store.getActive('openai') || {};
            this.discardOpenAIDrafts({ presetId: this.store.getActiveId('openai') });
        } else {
            this.captureDraftsFromDOM();
            base = this.getActivePresetSnapshot(storeType) || {};
        }
        const data = { ...deepClone(base), name };
        const id = await this.store.upsert(storeType, { name, data, appScope: 'creative' });
        await this.store.setActive(storeType, id);
        for (const k of Array.from(this.drafts.keys())) {
            if (String(k).startsWith(`${storeType}:`)) this.drafts.delete(k);
        }
        this.renderAllSections();
        this.showStatus('已新建', 'success');
        window.dispatchEvent(new CustomEvent('preset-changed'));
    }

    async onRenameForStoreType(storeType) {
        await this.store.ready;
        const id = this.store.getActiveId(storeType);
        const current = this.getActivePresetSnapshot(storeType);
        if (!id || !current) return;
        this.captureDraftsFromDOM();
        const name = prompt('重命名预设', current.name || id);
        if (!name) return;
        await this.store.upsert(storeType, { id, name, data: { ...current, name } });
        const key = this.getDraftKey(storeType, id);
        if (key && this.drafts.has(key)) {
            const d = this.drafts.get(key) || {};
            d.name = name;
            this.drafts.set(key, d);
        }
        this.renderAllSections();
        this.showStatus('已重命名', 'success');
        window.dispatchEvent(new CustomEvent('preset-changed'));
    }

    async onDeleteForStoreType(storeType) {
        await this.store.ready;
        const id = this.store.getActiveId(storeType);
        if (!id) return;
        const ok = await appConfirm({ title: '删除预设', message: '删除该预设？此操作不可恢复。', danger: true });
        if (!ok) return;
        this.captureDraftsFromDOM();
        const cleanupWarnings = [];

        try {
            await waitForRegexStoreReady(window.appBridge);
            const sets = listRegexLocalSets(window.appBridge);
            const bound = sets
                .map(set => ({
                    set,
                    detached: detachRegexPresetBind(set?.bind, {
                        presetType: storeType,
                        presetId: id,
                    }),
                }))
                .filter(item => item.detached.matched);
            if (bound.length) {
                const sharedCount = bound.filter(item => item.detached.remainingIds.length > 0).length;
                const delRegex = await appConfirm({
                    title: '删除正则', danger: true,
                    message: `检测到该预设绑定了 ${bound.length} 组正则。是否一并删除？${sharedCount ? `\n其中 ${sharedCount} 组仍绑定其他预设，只会解除当前预设的绑定。` : ''}`,
                    confirmText: '一并删除', cancelText: '仅删除预设',
                });
                if (delRegex) {
                    for (const { set, detached } of bound) {
                        const sid = String(set?.id || '').trim();
                        if (!sid) continue;
                        if (detached.bind) {
                            await upsertRegexLocalSet(window.appBridge, { ...set, bind: detached.bind });
                        } else {
                            await removeRegexLocalSet(window.appBridge, sid);
                        }
                    }
                    window.dispatchEvent(new CustomEvent('regex-changed'));
                }
            }
        } catch (error) {
            logger.warn('delete preset regex cleanup failed', error);
            cleanupWarnings.push('正则');
        }

        try {
            const scriptStore = await waitForScriptStoreReady(window.appBridge);
            const scripts = scriptStore?.getScripts?.('preset', id) || [];
            if (Array.isArray(scripts) && scripts.length) {
                const delScripts = await appConfirm({
                    title: '删除脚本', danger: true,
                    message: `检测到该预设绑定了 ${scripts.length} 条脚本。是否一并删除？`,
                    confirmText: '一并删除', cancelText: '仅删除预设',
                });
                if (delScripts) {
                    if (typeof scriptStore.removeScope === 'function') {
                        await scriptStore.removeScope('preset', id);
                    } else {
                        await scriptStore.setScripts('preset', id, []);
                    }
                }
            } else if (typeof scriptStore?.removeScope === 'function') {
                await scriptStore.removeScope('preset', id);
            }
        } catch (error) {
            logger.warn('delete preset script cleanup failed', error);
            cleanupWarnings.push('脚本');
        }

        await this.store.remove(storeType, id);
        const key = this.getDraftKey(storeType, id);
        if (key) this.drafts.delete(key);
        this.renderAllSections();
        this.showStatus(
            cleanupWarnings.length
                ? `预设已删除，但${cleanupWarnings.join('、')}清理失败，请重试或手动检查`
                : '已删除',
            cleanupWarnings.length ? 'error' : 'success',
        );
        window.dispatchEvent(new CustomEvent('preset-changed'));
    }

    showStatus(message, type = 'info') {
        const el = this.statusEl;
        if (!el) return;
        const colors = {
            success: { bg: 'rgba(var(--app-success-rgb), 0.16)', fg: 'var(--app-success-text, #166534)' },
            error: { bg: 'var(--app-danger-soft, #fee2e2)', fg: 'var(--app-danger-text, #991b1b)' },
            info: { bg: 'var(--app-accent-soft, #dbeafe)', fg: 'var(--app-accent-strong)' },
        };
        const c = colors[type] || colors.info;
        el.style.display = 'block';
        el.style.background = c.bg;
        el.style.color = c.fg;
        el.textContent = message;
        setTimeout(() => { el.style.display = 'none'; }, 3500);
    }

    /* ════════════════════════════════════════
       Import / Export (preserved from original)
       ════════════════════════════════════════ */
    detectPresetType(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.presets && obj.active && obj.enabled) return 'store';
        if (typeof obj.story_string === 'string') return 'context';
        if (typeof obj.content === 'string' && ('post_history' in obj)) return 'sysprompt';
        if (typeof obj.input_sequence === 'string' || typeof obj.output_sequence === 'string') return 'instruct';
        if (typeof obj.prefix === 'string' && typeof obj.suffix === 'string' && typeof obj.separator === 'string') return 'reasoning';
        if ('temperature' in obj || 'top_p' in obj || 'temp_openai' in obj || 'top_p_openai' in obj ||
            'openai_max_context' in obj || 'openai_max_tokens' in obj || 'prompts' in obj || 'prompt_order' in obj) return 'openai';
        return null;
    }

    convertStRegexScriptsToRules(regexes = []) {
        const scripts = Array.isArray(regexes) ? regexes : [];
        return scripts
            .map((script) => normalizeRegexScript(script))
            .filter((rule) => String(rule?.findRegex || '').trim());
    }

    extractPresetRegexScripts(obj) {
        const ext = obj?.extensions && typeof obj.extensions === 'object' ? obj.extensions : {};
        const list = [];
        const push = (val) => {
            if (!Array.isArray(val)) return;
            val.forEach((item) => {
                if (item && typeof item === 'object') list.push(item);
            });
        };
        push(ext.regex_scripts);
        push(ext.regexScripts);
        push(ext.regex);
        push(ext.regexes);
        return list;
    }

    extractPresetScripts(obj) {
        const out = [];
        const seen = new Set();
        const push = (val) => {
            if (!Array.isArray(val)) return;
            val.forEach((item) => {
                if (!item || typeof item !== 'object') return;
                const id = String(item?.id || '').trim();
                const name = String(item?.name || '').trim();
                const content = String(item?.content || '');
                const sig = id || `${name}\u0000${content}`;
                if (!sig || seen.has(sig)) return;
                seen.add(sig);
                out.push(deepClone(item));
            });
        };
        push(obj?.boundScripts);
        push(obj?.bound_scripts);
        const candidates = [
            obj?.tavern_helper,
            obj?.tavernHelper,
            obj?.tavern_helper_scripts,
            obj?.tavernHelperScripts,
            obj?.extensions?.tavern_helper,
            obj?.extensions?.tavernHelper,
            obj?.extensions?.tavern_helper_scripts,
            obj?.extensions?.tavernHelperScripts,
        ];
        candidates.forEach((raw) => {
            if (!raw || typeof raw !== 'object') return;
            const th = Array.isArray(raw) ? Object.fromEntries(raw) : raw;
            push(th?.scripts);
        });
        return out;
    }

    getRuleSignature(r) {
        return getRegexRuleSignature(r);
    }

    extractStRegexBindingSets(obj) {
        const out = [];
        const seenScriptIds = new Set();
        const seenRuleSigs = new Set();
        const appendRules = (rules = [], name = 'RegexBinding') => {
            const unique = [];
            (Array.isArray(rules) ? rules : []).forEach((rule) => {
                const sig = this.getRuleSignature(rule);
                if (!sig || seenRuleSigs.has(sig)) return;
                seenRuleSigs.add(sig);
                unique.push(rule);
            });
            if (unique.length) {
                out.push({
                    name: getRegexImportSetName(name, unique, '导入正则'),
                    enabled: true,
                    rules: unique,
                });
            }
        };
        const tryAddRegexes = (container) => {
            const binding = container?.RegexBinding || container?.regexBinding;
            const regexes = Array.isArray(binding?.regexes) ? binding.regexes : binding?.rules;
            if (!Array.isArray(regexes) || !regexes.length) return;
            const filtered = regexes.filter(r => {
                const id = String(r?.id || '');
                if (!id) return true;
                if (seenScriptIds.has(id)) return false;
                seenScriptIds.add(id);
                return true;
            });
            if (!filtered.length) return;
            appendRules(this.convertStRegexScriptsToRules(filtered), 'RegexBinding');
        };
        const tryAddExtensionRegexes = (container) => {
            const regexes = this.extractPresetRegexScripts(container);
            if (!regexes.length) return;
            appendRules(this.convertStRegexScriptsToRules(regexes), 'Regex Scripts');
        };
        const tryParseJsonString = (s) => {
            const raw = String(s || '').trim();
            if (!raw || !/regexbinding/i.test(raw) || !(raw.startsWith('{') || raw.startsWith('['))) return null;
            try { return JSON.parse(raw); } catch { return null; }
        };
        tryAddExtensionRegexes(obj);
        tryAddRegexes(obj);
        const walk = (node, depth = 0) => {
            if (!node || depth > 18) return;
            if (typeof node === 'string') {
                const parsed = tryParseJsonString(node);
                if (parsed && typeof parsed === 'object') {
                    tryAddExtensionRegexes(parsed);
                    tryAddRegexes(parsed);
                    walk(parsed, depth + 1);
                }
                return;
            }
            if (Array.isArray(node)) { node.forEach(v => walk(v, depth + 1)); return; }
            if (typeof node === 'object') {
                tryAddExtensionRegexes(node);
                tryAddRegexes(node);
                for (const v of Object.values(node)) walk(v, depth + 1);
            }
        };
        walk(obj, 0);
        return out;
    }

    async exportCurrent() {
        try {
            await this.store.ready;
            this.captureDraftsFromDOM();
            const type = 'openai';
            const presetId = this.store.getActiveId(type);
            const draftKey = this.getDraftKey(type, presetId);
            const draft = draftKey ? this.drafts.get(draftKey) : null;
            const preset = draft || this.store.getActive(type) || {};
            const rawName = String(preset.name || type).trim() || type;
            const payload = { ...(preset || {}) };

            try {
                await waitForRegexStoreReady(window.appBridge);
                const sets = listRegexLocalSets(window.appBridge);
                const bindId = this.store.getActiveId(type);
                if (type && bindId) {
                    const bound = sets
                        .filter(s => s?.bind?.type === 'preset' && s.bind.presetType === type && s.bind.presetId === bindId)
                        .map(s => ({ name: s.name, enabled: s.enabled !== false, rules: s.rules || [] }));
                    if (bound.length) {
                        payload.boundRegexSets = bound;
                        payload.extensions = payload.extensions && typeof payload.extensions === 'object'
                            ? deepClone(payload.extensions)
                            : {};
                        const flatRegexScripts = [];
                        const seenRegexSigs = new Set();
                        bound.forEach((set) => {
                            (Array.isArray(set?.rules) ? set.rules : []).forEach((rule) => {
                                const sig = this.getRuleSignature(rule);
                                if (!sig || seenRegexSigs.has(sig)) return;
                                seenRegexSigs.add(sig);
                                flatRegexScripts.push(deepClone(rule));
                            });
                        });
                        if (flatRegexScripts.length) {
                            payload.extensions.regex_scripts = flatRegexScripts;
                            const sp = payload.extensions.SPreset && typeof payload.extensions.SPreset === 'object'
                                ? deepClone(payload.extensions.SPreset)
                                : {};
                            sp.RegexBinding = { regexes: deepClone(flatRegexScripts) };
                            payload.extensions.SPreset = sp;
                        }
                    }
                }
            } catch {}

            try {
                const scriptStore = await waitForScriptStoreReady(window.appBridge);
                const bindId = this.store.getActiveId(type);
                const boundScripts = bindId && scriptStore?.getScripts
                    ? (scriptStore.getScripts('preset', bindId) || [])
                    : [];
                if (Array.isArray(boundScripts) && boundScripts.length) {
                    payload.boundScripts = deepClone(boundScripts);
                    payload.extensions = payload.extensions && typeof payload.extensions === 'object'
                        ? deepClone(payload.extensions)
                        : {};
                    const rawHelper = payload.extensions.tavern_helper;
                    const helper = Array.isArray(rawHelper)
                        ? Object.fromEntries(rawHelper)
                        : (rawHelper && typeof rawHelper === 'object' ? deepClone(rawHelper) : {});
                    helper.scripts = deepClone(boundScripts);
                    if (!helper.variables || typeof helper.variables !== 'object') helper.variables = {};
                    payload.extensions.tavern_helper = helper;
                }
            } catch {}

            const filename = `preset-${rawName}.json`;
            const ok = await this.downloadJson(filename, payload);
            if (!ok) return;
            this.showStatus('已导出当前预设', 'success');
            window.toastr?.success?.('已导出预设');
        } catch (err) {
            logger.warn('预设导出失败', err);
            this.showStatus('预设导出失败', 'error');
            window.toastr?.error?.('导出失败');
        }
    }

    async importFromFile(file) {
        await this.store.ready;
        let text = '';
        try { text = await file.text(); } catch { this.showStatus('读取文件失败', 'error'); return; }
        let json = null;
        try { json = JSON.parse(text); } catch { this.showStatus('JSON 格式错误', 'error'); return; }
        this.captureCurrentDetailDraft();

        const detected = this.detectPresetType(json);
        if (detected === 'store') {
            const replace = await appConfirm({
                title: '导入预设',
                message: '检测到「整套预设设定档」。确定要导入并覆盖当前设置吗？（取消=合并导入）',
                confirmText: '覆盖导入', cancelText: '合并导入',
            });
            if (!(await this.confirmDiscardBlockDrafts('导入整套预设', { all: true }))) return;
            this.drafts.clear();
            this.discardOpenAIDrafts({ all: true });
            await this.store.importState(json, { mode: replace ? 'replace' : 'merge' });
            this.renderAllSections();
            this.showStatus('已导入预设设定档', 'success');
            window.dispatchEvent(new CustomEvent('preset-changed'));
            return;
        }

        const detectedType = (detected && detected !== 'store') ? detected : null;
        let importType = detectedType || 'openai';

        if (detectedType && detectedType !== 'openai') {
            const ok = await appConfirm({
                title: '导入类型',
                message: `检测到预设格式为「${this.getTypeLabel(detectedType)}」。要导入到该类型吗？`,
                confirmText: `导入到「${this.getTypeLabel(detectedType)}」`, cancelText: '导入到生成参数',
            });
            importType = ok ? detectedType : 'openai';
        }

        if (importType === 'openai') {
            if (!(await this.confirmDiscardBlockDrafts('导入并切换生成参数预设'))) return;
            this.discardOpenAIDrafts({ presetId: this.store.getActiveId('openai') });
        }

        const fileBaseName = String(file?.name || '').replace(/\.[^/.]+$/, '').trim();
        const name = fileBaseName || String(json?.name || '').trim() || '导入预设';

        let boundSets = json?.boundRegexSets || json?.bound_regex_sets || null;
        let boundScripts = this.extractPresetScripts(json);
        const data = { ...json, name };
        delete data.boundRegexSets;
        delete data.bound_regex_sets;
        delete data.boundScripts;
        delete data.bound_scripts;

        if (!Array.isArray(boundSets) || !boundSets.length) {
            const stSets = this.extractStRegexBindingSets(json);
            if (stSets.length) boundSets = stSets;
        }

        const presetId = await this.store.upsert(importType, {
            name,
            data,
            appScope: 'creative',
            makeActive: true,
        });

        if (Array.isArray(boundSets) && boundSets.length) {
            try {
                const ok = await appConfirm({
                    title: '导入正则',
                    message: `检测到预设包含绑定的正规表达式（${boundSets.length} 组）。是否一并导入并绑定？`,
                    confirmText: '一并导入', cancelText: '仅导入预设',
                });
                if (ok) {
                    await waitForRegexStoreReady(window.appBridge);
                    const bindTarget = resolveImportedRegexPresetBindTarget({
                        importType,
                        presetId,
                        presetStore: this.store,
                    });
                    const regexPresetId = String(bindTarget?.presetId || '').trim();
                    if (!regexPresetId || !bindTarget?.bind) {
                        window.toastr?.info?.('已跳过绑定正则导入');
                    } else {
                        const regexPresetName = String(
                            this.store.list(REGEX_CUSTOM_PROMPT_PRESET_TYPE).find(item => String(item.id || '') === regexPresetId)?.name ||
                            regexPresetId,
                        ).trim() || regexPresetId;
                        const bind = bindTarget.bind;
                        const isolatedSets = prepareVersionIsolatedPresetRegexSets(boundSets);
                        for (const s of isolatedSets) {
                            const setName = String(s?.name || '正则').trim() || '正则';
                            await upsertRegexLocalSet(window.appBridge, {
                                name: `${setName} (${regexPresetName})`, enabled: s?.enabled !== false,
                                bind, rules: s.rules,
                            });
                        }
                        window.dispatchEvent(new CustomEvent('regex-changed'));
                    }
                }
            } catch (err) { logger.warn('导入绑定正则失败', err); }
        }

        if (Array.isArray(boundScripts) && boundScripts.length) {
            try {
                const ok = await appConfirm({
                    title: '导入脚本',
                    message: `检测到预设包含绑定脚本（${boundScripts.length} 条）。是否一并导入并绑定？`,
                    confirmText: '一并导入', cancelText: '仅导入预设',
                });
                if (ok) {
                    const scriptStore = await waitForScriptStoreReady(window.appBridge);
                    const result = await scriptStore?.importTavernHelperScripts?.({
                        scripts: boundScripts,
                        scope: 'preset',
                        scopeId: presetId,
                        source: 'preset',
                    });
                    if (result?.count) {
                        const settings = appSettings.get();
                        const ids = Array.isArray(result.ids) ? result.ids : [];
                        const runnableIds = Array.isArray(result.runnableIds) ? result.runnableIds : ids;
                        const compatibility = result.compatibility && typeof result.compatibility === 'object'
                            ? result.compatibility
                            : null;
                        const authorizationMessage = buildScriptAuthorizationMessage({
                            leadText: `已导入 ${result.count} 条绑定脚本。`,
                            settings,
                            compatibility,
                        });
                        if (runnableIds.length) {
                            const choice = await appChoice({
                                title: '脚本授权',
                                message: authorizationMessage,
                                actions: [
                                    { id: 'allow', label: '允许并启用', primary: true },
                                    { id: 'later', label: '稍后处理' },
                                ],
                                defaultActionId: 'allow',
                            });
                            if (choice === 'allow') {
                                if (settings.scriptEnabled !== true) appSettings.update({ scriptEnabled: true });
                                await Promise.all(runnableIds.map((id) => scriptStore.toggleScript('preset', presetId, id, true)));
                            } else {
                                window.toastr?.info?.('脚本已导入到该预设，尚未启用');
                            }
                        } else {
                            await appChoice({
                                title: '脚本兼容性提示',
                                message: authorizationMessage,
                                actions: [{ id: 'ok', label: '知道了', primary: true }],
                                defaultActionId: 'ok',
                            });
                        }
                        const blockedCount = Math.max(0, Number(compatibility?.blockedCount) || 0);
                        if (blockedCount > 0) {
                            window.toastr?.warning?.(`${blockedCount} 条外部扩展加载器已保留并保持禁用`);
                        }
                    }
                }
            } catch (err) { logger.warn('导入绑定脚本失败', err); }
        }

        this.renderAllSections();
        this.showStatus('已导入为创意写作预设；如需用于聊天模式，可在会话配置中选择。', 'success');
        window.toastr?.success?.('已导入为创意写作预设；如需用于聊天模式，可在会话配置中选择。');
        window.dispatchEvent(new CustomEvent('preset-changed'));
    }

    /* ── File helpers ── */
    hasTauriRuntime() {
        const g = typeof globalThis !== 'undefined' ? globalThis : window;
        return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || g?.__TAURI_INVOKE__);
    }

    isAndroid() {
        try { return /android/i.test(navigator.userAgent || ''); } catch { return false; }
    }

    async pickSavePath(defaultName) {
        return pickNativeSavePath({
            defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
    }

    buildJsonDataUrl(payload) {
        const json = JSON.stringify(payload, null, 2);
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return `data:application/json;base64,${btoa(binary)}`;
    }

    async downloadJson(filename, dataObj) {
        const data = JSON.stringify(dataObj, null, 2);
        if (!this.hasTauriRuntime()) {
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
            return true;
        }
        const pick = await this.pickSavePath(filename);
        if (pick.cancelled) return false;
        const dataUrl = this.buildJsonDataUrl(dataObj);
        if (pick.fallback) {
            await safeInvoke('export_attachment', { dataUrl, fileName: filename });
        } else {
            await safeInvoke('export_attachment', { dataUrl, fileName: filename, path: pick.path });
        }
        return true;
    }
}
