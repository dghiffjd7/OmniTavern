/**
 * 世界书编辑弹窗（参考 SillyTavern World Info 设计）
 * - 双栏：左侧条目列表，右侧条目编辑
 * - 支持新增/复制/删除条目与保存
 * - 保存时保留 ST 字段，并兼容旧字段命名
 */

import { LLMClient } from '../api/client.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { appChoice, appConfirm } from './app-confirm.js';
import {
    createAdHocWebSearchToggleRuntime,
    describeAdHocModel,
    renderAdHocWebSources,
    runAdHocWebSearchChat,
} from './chat/ad-hoc-web-search-runtime.js';
import { canInitClient as canUseApiConfig } from '../api/client-config-utils.js';
import { ConfigManager } from '../storage/config.js';
import { logger } from '../utils/logger.js';
import { pickSavePath as pickNativeSavePath } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';
import { translateUiText } from '../i18n/index.js';
import {
    DEFAULT_WORLD_AI_TEMPLATE as WORLD_AI_TEMPLATE,
    buildWorldAiContinueMessages,
    buildWorldAiMessages,
    readWorldAiGenerationSettings,
    saveWorldAiTemplate as saveSharedWorldAiTemplate,
} from '../utils/world-ai-generation.js';
import {
    genNodeId,
    genEdgeId,
    sanitizeNodeId,
    normalizeNodeType,
    normalizeLogicValue,
    normalizeRightTypeValue,
    parseTypedValue,
    stringifyTypedValue,
    buildNodeDefineSpec,
    getNodePortSpec,
    normalizeGraphNodeData,
    normalizeGraphNode,
    normalizeGraphEdge,
    isConditionLogicNode,
    autoLayoutNodeGraph,
    buildNodeGraphFromWhen,
    normalizeNodeGraph,
    buildWhenFromNodeGraph,
    normalizePromptClause,
    isConditionTreeGroup,
    createDefaultPromptClause,
    isTrivialConditionTree,
    normalizeConditionTree,
    getPrimaryClauseFromConditionTree,
    visitConditionTree,
    buildVariableContext,
    combineConditionLogicState,
    explainConditionTree,
    normalizeWorldPromptMode,
} from '../variables/world-condition-core.js';
import {
    createVariableModalImpl,
    renderVariableModalDraftImpl,
    openVariableModalImpl,
    submitVariableModalImpl,
    closeVariableModalImpl,
} from './world-editor/world-variable-modal.js';
import {
    getSessionVariableRecordsImpl,
    setVariableBrowserScopeImpl,
    rememberRecentVariableImpl,
    deleteVariableBrowserDraftImpl,
    formatVariableBrowserValueImpl,
    buildVariableBrowserDraftImpl,
    createVariableBrowserModalImpl,
    renderVariableBrowserDetailImpl,
    renderVariableBrowserImpl,
    saveVariableBrowserDraftImpl,
    openVariableBrowserImpl,
    closeVariableBrowserImpl,
} from './world-editor/world-variable-picker.js';
import {
    buildWorldEntryTransferPlan,
    collectBoundWorldRegexSets,
    ensureUniqueWorldbookIdCore,
    resolveRefEntriesForDisplayCore,
    resolveWorldEditorBridgeContext,
    saveWorldInfoWithName,
} from './world-editor/world-editor-bridge-utils.js';
import {
    formatWorldbookConflictPath,
    mergeWorldbookChanges,
} from './world-editor/worldbook-merge-utils.js';
import {
    getCompactPageItems,
    paginateWorldEntries,
} from './world-editor/world-editor-pagination-utils.js';
import { isWorldMotionReduced, setWorldDisclosureState } from './world-management-motion-utils.js';
import {
    ensureWorldVariableInStore,
    getWorldVariableOptions,
    resolveWorldVariableSessionContext,
} from './world-editor/world-variable-session-utils.js';
import {
    getConditionSummaryOperatorImpl,
    getConditionSummaryValueTextImpl,
    getConditionRuntimeContextImpl,
    formatConditionRuntimeValueImpl,
    getConditionExplanationReasonImpl,
    getConditionGroupExplanationReasonImpl,
    getEntryActivationExplanationImpl,
    renderEntryActivationOverviewImpl,
    renderBlockSettingsPanelImpl,
    collectBlockConditionOverviewImpl,
    renderConditionOverviewNodeImpl,
    renderBlockConditionOverviewImpl,
} from './world-editor/world-block-overview.js';
import { mountNodeEditorCoreImpl } from './world-editor/world-node-editor-core.js';

const DEFAULT_DEPTH = 4;
const DEFAULT_WEIGHT = 100;

const SELECTIVE_LOGIC_OPTIONS = [
    { value: 0, label: 'AND 任一（匹配任一关键词）' },
    { value: 1, label: 'NOT 全部（不匹配全部关键词）' },
    { value: 2, label: 'NOT 任一（不匹配任一关键词）' },
    { value: 3, label: 'AND 全部（匹配全部关键词）' },
];

const POSITION_OPTIONS = [
    { value: 0, label: 'World Info (↑Char)' },
    { value: 1, label: 'World Info (↓Char)' },
    { value: 2, label: '↑AT（作者备注前）' },
    { value: 3, label: '↓AT（作者备注后）' },
    { value: 4, label: '@Depth（按深度插入）' },
    { value: 5, label: '↑EM（例子前）' },
    { value: 6, label: '↓EM（例子后）' },
];

const ROLE_OPTIONS = [
    { value: 0, label: 'system' },
    { value: 1, label: 'user' },
    { value: 2, label: 'assistant' },
];

const DEPTH_ANCHOR_OPTIONS = [
    { value: '', label: '默认（D0 在最新输入后）' },
    { value: 'before_latest_user', label: 'D0 最新输入前' },
    { value: 'after_latest_user', label: 'D0 最新输入后' },
];

const TRIGGER_STRATEGY_OPTIONS = [
    { value: 'blue', label: '🔵 蓝灯（常驻触发）' },
    { value: 'green', label: '🟢 绿灯（关键词触发）' },
];

const BLOCK_OP_OPTIONS = [
    { value: '==', label: '等于 (==)' },
    { value: '!=', label: '不等于 (!=)' },
    { value: '>', label: '大于 (>)' },
    { value: '>=', label: '大于等于 (>=)' },
    { value: '<', label: '小于 (<)' },
    { value: '<=', label: '小于等于 (<=)' },
    { value: 'contains', label: '包含 (contains)' },
    { value: 'not_contains', label: '不包含 (not_contains)' },
    { value: 'is_empty', label: '为空 (is_empty)' },
    { value: 'not_empty', label: '非空 (not_empty)' },
    { value: 'regex', label: '正则匹配 (regex)' },
];

const BLOCK_RIGHT_TYPE_OPTIONS = [
    { value: 'number', label: '数字' },
    { value: 'string', label: '文本' },
    { value: 'boolean', label: '布尔' },
    { value: 'variable', label: '变量' },
];

const NODE_LOGIC_OPTIONS = [
    { value: 'and', label: 'AND' },
    { value: 'or', label: 'OR' },
    { value: 'not', label: 'NOT' },
];

const NODE_GRAPH_VERSION = 1;
const NODE_CANVAS_MIN_WIDTH = 760;
const NODE_CANVAS_MIN_HEIGHT = 320;
const NODE_CANVAS_PADDING_X = 220;
const NODE_CANVAS_PADDING_Y = 160;

const BLOCK_EXPAND_ICON_SVG = `
<svg class="world-corner-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"></path>
    <path d="M9 9L3 3M15 9l6-6M9 15l-6 6M15 15l6 6"></path>
</svg>
`.trim();

const BLOCK_FLIP_ICON_SVG = `
<svg class="world-corner-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h11"></path>
    <path d="M12.5 4.5L15 7l-2.5 2.5"></path>
    <path d="M20 17H9"></path>
    <path d="M11.5 14.5L9 17l2.5 2.5"></path>
    <path d="M17 4a8 8 0 0 1 3 6"></path>
    <path d="M7 20a8 8 0 0 1-3-6"></path>
</svg>
`.trim();

const BLOCK_MODE_NODE_ICON_SVG = `
<svg class="world-mini-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6" cy="6" r="2.2"></circle>
    <circle cx="18" cy="12" r="2.2"></circle>
    <circle cx="6" cy="18" r="2.2"></circle>
    <path d="M8.2 7.2l7.6 3.6"></path>
    <path d="M8.2 16.8l7.6-3.6"></path>
</svg>
`.trim();

const WORLD_AI_INPUT_KEY = 'world_ai_input_v1';
const WORLD_VAR_BROWSER_RECENT_KEY = 'world_var_browser_recent_v1';
const WORLD_VAR_GUIDE_KEY = 'world_var_guide_v1_seen';

const deepClone = (obj) => {
    try {
        return structuredClone(obj);
    } catch {
        return JSON.parse(JSON.stringify(obj || {}));
    }
};

const ENTRY_SAVE_ORIGIN = Symbol('world-editor-entry-save-origin');
const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));

const getEntrySaveOrigin = (entry, index) => {
    const inherited = entry?.[ENTRY_SAVE_ORIGIN];
    if (inherited && typeof inherited === 'object') return inherited;
    return Object.freeze({
        promptBlocks: hasOwn(entry, 'promptBlocks'),
        promptMode: hasOwn(entry, 'promptMode'),
        nodeGraph: hasOwn(entry, 'nodeGraph'),
        when: hasOwn(entry, 'when'),
        scope: hasOwn(entry, 'scope'),
        latestUserAnchor: hasOwn(entry, 'latestUserAnchor') || hasOwn(entry, 'promptAnchor'),
        selectiveExplicit: hasOwn(entry, 'selectiveExplicit'),
        syntheticPromptBlockTitle: String(entry?.comment ?? entry?.title ?? '').trim() || `内容 ${index + 1}`,
    });
};

const attachEntrySaveOrigin = (entry, origin) => {
    Object.defineProperty(entry, ENTRY_SAVE_ORIGIN, {
        value: origin,
        configurable: true,
    });
    return entry;
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const hasTauriRuntime = () => {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || g?.__TAURI_INVOKE__);
};

const isAndroid = () => {
    try {
        return /android/i.test(navigator.userAgent || '');
    } catch {
        return false;
    }
};

const buildJsonDataUrl = (payload) => {
    const json = JSON.stringify(payload, null, 2);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:application/json;base64,${btoa(binary)}`;
};

const toNumber = (val, def) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : def;
};

const genBlockId = () => `blk_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 7)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const buildVariableCreationDraft = (raw = {}) => {
    const draft = raw && typeof raw === 'object' ? { ...raw } : {};
    const type = ['number', 'string', 'boolean'].includes(String(draft.type || '').trim().toLowerCase())
        ? String(draft.type).trim().toLowerCase()
        : 'number';
    const opRaw = String(draft.op || '>').trim();
    const knownOps = new Set(BLOCK_OP_OPTIONS.map(opt => String(opt.value)));
    const op = knownOps.has(opRaw) ? opRaw : '>';
    const rightType = normalizeRightTypeValue(draft.rightType || 'number');
    return {
        name: String(draft.name || '').trim(),
        type,
        defaultValueText: stringifyTypedValue(
            draft.defaultValue ?? (type === 'number' ? 0 : (type === 'boolean' ? false : '')),
            type,
        ),
        op,
        rightType,
        rightValueText: stringifyTypedValue(
            draft.rightValue ?? (rightType === 'number' ? 10 : (rightType === 'boolean' ? false : '')),
            rightType,
        ),
    };
};

const normalizePromptBlock = (raw = {}, index = 0, fallbackContent = '') => {
    const block = raw && typeof raw === 'object' ? { ...raw } : {};
    const whenRaw = block.when && typeof block.when === 'object' ? block.when : null;
    const hasMeaningfulWhen = !isTrivialConditionTree(whenRaw);
    let normalizedGraph = null;
    let normalizedWhen = null;
    if (hasMeaningfulWhen) {
        const normalizedWhenTree = normalizeConditionTree(whenRaw, createDefaultPromptClause());
        const primaryClause = getPrimaryClauseFromConditionTree(normalizedWhenTree, createDefaultPromptClause());
        normalizedGraph = normalizeNodeGraph(
            block.nodeGraph,
            normalizedWhenTree,
            primaryClause,
        );
        normalizedWhen = normalizeConditionTree(
            buildWhenFromNodeGraph(normalizedGraph, primaryClause),
            primaryClause,
        );
    }
    return {
        id: String(block.id || '').trim() || genBlockId(),
        title: String(block.title || `内容 ${index + 1}`).trim(),
        enabled: block.enabled !== false,
        content: String(block.content ?? (index === 0 ? fallbackContent : '')).trim(),
        role: Number.isFinite(Number(block.role)) ? Number(block.role) : 0,
        priority: Number.isFinite(Number(block.priority)) ? Number(block.priority) : 100,
        nodeGraph: normalizedGraph,
        when: normalizedWhen,
    };
};

const normalizeArray = (val) => {
    if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
    if (typeof val === 'string') {
        return val.split(/[,，\n\r]/).map(s => s.trim()).filter(Boolean);
    }
    return [];
};

const stripCodeFence = (text) => {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const withoutStart = raw.replace(/^```(?:yaml)?\s*/i, '');
    return withoutStart.replace(/```\s*$/i, '').trim();
};

const loadWorldAiInput = () => {
    try {
        return String(localStorage.getItem(WORLD_AI_INPUT_KEY) || '');
    } catch {
        return '';
    }
};

const saveWorldAiInput = (value) => {
    try {
        localStorage.setItem(WORLD_AI_INPUT_KEY, String(value || ''));
    } catch {}
};

const loadWorldAiTemplate = () => {
    return readWorldAiGenerationSettings().template;
};

const saveWorldAiTemplate = (value) => {
    saveSharedWorldAiTemplate(value);
};

const loadRecentVariableNames = () => {
    try {
        const raw = JSON.parse(localStorage.getItem(WORLD_VAR_BROWSER_RECENT_KEY) || '[]');
        return Array.isArray(raw)
            ? raw.map(item => String(item || '').trim()).filter(Boolean).slice(0, 24)
            : [];
    } catch {
        return [];
    }
};

const saveRecentVariableNames = (names = []) => {
    try {
        const list = Array.isArray(names)
            ? names.map(item => String(item || '').trim()).filter(Boolean).slice(0, 24)
            : [];
        localStorage.setItem(WORLD_VAR_BROWSER_RECENT_KEY, JSON.stringify(list));
    } catch {}
};

const AI_TRACE_WATCH_MS = 12000;
const AI_TRACE_VALUE_LIMIT = 84;

const hashTraceText = (value) => {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
};

const summarizeTraceText = (value) => {
    const text = String(value ?? '');
    const compact = text.replace(/\s+/g, ' ').trim();
    const preview = compact.slice(0, 64);
    return `len=${text.length},hash=${hashTraceText(text)},head=${JSON.stringify(preview)}`;
};

const formatTraceValue = (value, maxLen = AI_TRACE_VALUE_LIMIT) => {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') {
        const compact = value.replace(/\s+/g, ' ').trim();
        const text = compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
        return JSON.stringify(text);
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => formatTraceValue(item, Math.max(16, Math.floor(maxLen / 2)))).join(',')}]`;
    }
    try {
        const json = JSON.stringify(value);
        if (!json) return '{}';
        return json.length > maxLen ? `${json.slice(0, maxLen)}...` : json;
    } catch {
        return String(value);
    }
};

const normalizeEntry = (entry = {}, index = 0, options = {}) => {
    const saveOrigin = getEntrySaveOrigin(entry, index);
    const e = { ...entry };
    const isCharacterCardWorld = options?.characterCardWorld === true;

    e.id = e.id ?? (Number.isInteger(e.uid) ? String(e.uid) : `entry-${index}`);
    if (e.uid == null && /^\d+$/.test(e.id)) {
        e.uid = Number(e.id);
    }

    const comment = e.comment ?? e.title ?? '';
    e.comment = comment;
    e.title = comment;

    const key = normalizeArray(e.key ?? e.triggers);
    const keysecondary = normalizeArray(e.keysecondary ?? e.secondary);
    e.key = key;
    e.triggers = key;
    e.keysecondary = keysecondary;
    e.secondary = keysecondary;
    e.scope = [];

    const order = toNumber(e.order ?? e.priority, 100);
    e.order = order;
    e.priority = order;

    e.depth = toNumber(e.depth, DEFAULT_DEPTH);
    e.position = toNumber(e.position, 0);
    e.role = toNumber(e.role, 0);
    const anchor = String(e.latestUserAnchor || e.promptAnchor || '').trim().toLowerCase();
    e.latestUserAnchor = anchor === 'before_latest_user' || anchor === 'after_latest_user' ? anchor : '';

    e.disable = Boolean(e.disable);
    e.constant = Boolean(e.constant);
    e.selectiveExplicit = e.selectiveExplicit === true;
    e.selective = Boolean(e.selective);
    // 蓝灯=常驻；绿灯=关键词触发。副关键词逻辑应独立控制，不能在保存时自动改写。
    // 兼容修复：旧版本编辑器会把角色卡世界书的所有绿灯条目强制写成 selective=true。
    // 对未显式开启过该逻辑的角色卡世界书条目，这里回退为普通关键词触发。
    if (e.constant) {
        e.selective = false;
        e.selectiveExplicit = false;
    } else if (isCharacterCardWorld && !e.selectiveExplicit) {
        e.selective = false;
    }
    e.selectiveLogic = toNumber(e.selectiveLogic, 0);

    // 概率：旧格式可能是 0-1 的 ratio
    const rawProb = e.probability;
    const probPercent = typeof rawProb === 'number'
        ? (rawProb <= 1 ? Math.round(rawProb * 100) : Math.round(rawProb))
        : 100;
    e.probability = probPercent;
    e.useProbability = e.useProbability !== false;

    e.ignoreBudget = Boolean(e.ignoreBudget);
    e.excludeRecursion = Boolean(e.excludeRecursion);
    e.preventRecursion = Boolean(e.preventRecursion);
    e.vectorized = Boolean(e.vectorized);
    e.addMemo = Boolean(e.addMemo);

    e.matchPersonaDescription = Boolean(e.matchPersonaDescription);
    e.matchCharacterDescription = Boolean(e.matchCharacterDescription);
    e.matchCharacterPersonality = Boolean(e.matchCharacterPersonality);
    e.matchCharacterDepthPrompt = Boolean(e.matchCharacterDepthPrompt);
    e.matchScenario = Boolean(e.matchScenario);
    e.matchCreatorNotes = Boolean(e.matchCreatorNotes);

    e.group = e.group ?? '';
    e.groupOverride = Boolean(e.groupOverride);
    e.groupWeight = toNumber(e.groupWeight, DEFAULT_WEIGHT);

    e.scanDepth = e.scanDepth ?? null;
    e.caseSensitive = e.caseSensitive ?? null;
    e.matchWholeWords = e.matchWholeWords ?? null;
    e.useGroupScoring = e.useGroupScoring ?? null;

    e.automationId = e.automationId ?? '';
    e.sticky = e.sticky ?? null;
    e.cooldown = e.cooldown ?? null;
    e.delay = e.delay ?? null;
    e.delayUntilRecursion = toNumber(e.delayUntilRecursion, 0);

    e.content = e.content ?? '';
    const promptBlocksRaw = Array.isArray(e.promptBlocks) ? e.promptBlocks : [];
    e.promptBlocks = promptBlocksRaw.length
        ? promptBlocksRaw.map((block, idx) => normalizePromptBlock(block, idx, e.content))
        : [normalizePromptBlock({ content: e.content, title: e.comment || `内容 ${index + 1}` }, 0, e.content)];
    e.promptMode = normalizeWorldPromptMode(e.promptMode, { fallback: 'hybrid' });
    const entryWhenRaw = e.when && typeof e.when === 'object' ? e.when : null;
    if (!isTrivialConditionTree(entryWhenRaw)) {
        const normalizedWhenTree = normalizeConditionTree(entryWhenRaw, createDefaultPromptClause());
        const primaryClause = getPrimaryClauseFromConditionTree(normalizedWhenTree, createDefaultPromptClause());
        e.nodeGraph = normalizeNodeGraph(e.nodeGraph, normalizedWhenTree, primaryClause);
        e.when = normalizeConditionTree(
            buildWhenFromNodeGraph(e.nodeGraph, primaryClause),
            primaryClause,
        );
    } else {
        e.nodeGraph = null;
        e.when = null;
    }
    const firstContent = String(e.promptBlocks?.[0]?.content || '').trim();
    if (firstContent) e.content = firstContent;
    return attachEntrySaveOrigin(e, saveOrigin);
};

const compactNormalizedEntryForSave = (entry, index = 0) => {
    const origin = getEntrySaveOrigin(entry, index);
    const blocks = Array.isArray(entry.promptBlocks) ? entry.promptBlocks : [];
    const onlyBlock = blocks.length === 1 ? blocks[0] : null;
    const isSyntheticPromptBlock = !origin.promptBlocks
        && onlyBlock
        && String(onlyBlock.title || '').trim() === origin.syntheticPromptBlockTitle
        && onlyBlock.enabled === true
        && String(onlyBlock.content ?? '').trim() === String(entry.content ?? '').trim()
        && Number(onlyBlock.role) === 0
        && Number(onlyBlock.priority) === 100
        && onlyBlock.nodeGraph == null
        && isTrivialConditionTree(onlyBlock.when);
    if (isSyntheticPromptBlock) delete entry.promptBlocks;
    if (!origin.promptMode && entry.promptMode === 'hybrid') delete entry.promptMode;
    if (!origin.nodeGraph && entry.nodeGraph == null) delete entry.nodeGraph;
    if (!origin.when && entry.when == null) delete entry.when;
    if (!origin.scope && Array.isArray(entry.scope) && entry.scope.length === 0) delete entry.scope;
    if (!origin.latestUserAnchor && !String(entry.latestUserAnchor || '').trim()) delete entry.latestUserAnchor;
    if (!origin.selectiveExplicit && entry.selectiveExplicit === false) delete entry.selectiveExplicit;
    return entry;
};

const createDefaultEntry = (index = 0) => normalizeEntry({ constant: true, selective: false }, index);

const positionLabel = (pos = 0, role = 0, depth = DEFAULT_DEPTH) => {
    switch (Number(pos)) {
        case 0: return '↑Char';
        case 1: return '↓Char';
        case 2: return '↑AT';
        case 3: return '↓AT';
        case 4: return `@D${depth}/${ROLE_OPTIONS.find(r => r.value === role)?.label || 'system'}`;
        case 5: return '↑EM';
        case 6: return '↓EM';
        default: return String(pos);
    }
};

export class WorldEditorModal {
    constructor({ onSaved } = {}) {
        this.overlay = null;
        this.modal = null;
        this.entriesListEl = null;
        this.editorEl = null;
        this.nameInputEl = null;
        this.saveBtn = null;
        this.addBtn = null;
        this.worldName = '';
        this.originalName = '';
        this.data = { name: '', entries: [] };
        this.baseWorldData = null;
        this.baseRevision = null;
        this.baseGeneration = null;
        this.refBaseEntries = null;
        this.currentIndex = 0;
        this.onSaved = onSaved;
        this.aiOverlay = null;
        this.aiModal = null;
        this.aiInputEl = null;
        this.aiTemplateEl = null;
        this.aiStatusEl = null;
        this.aiGenerateBtn = null;
        this.aiContinueBtn = null;
        this.aiCloseBtn = null;
        this.aiWebSearchToggleEl = null;
        this.aiWebSourcesEl = null;
        this.aiWebSearchToggleRuntime = null;
        this.aiBusy = false;
        this.aiRequestId = 0;
        this.aiPendingEntryId = '';
        this.aiTargetEntryId = '';
        this.aiTargetBlockId = '';
        this.aiTraceSeq = 0;
        this.aiTraceWatchUntil = 0;
        this.aiLastWriteMeta = null;
        this.chatConfigManager = new ConfigManager();
        this.batchMode = false;
        this.selectedEntries = new Set();
        this.batchToggleBtn = null;
        this.batchBarEl = null;
        this.batchCountEl = null;
        this.batchSelectAllBtn = null;
        this.batchClearBtn = null;
        this.batchCreateBtn = null;
        this.batchCreateAllBtn = null;
        this.manageBtn = null;
        this.manageOverlay = null;
        this.manageModal = null;
        this.manageCountEl = null;
        this.manageSelectAllBtn = null;
        this.manageClearBtn = null;
        this.manageCreateSelectedBtn = null;
        this.manageDeleteBtn = null;
        this.manageMoveUpBtn = null;
        this.manageMoveDownBtn = null;
        this.manageMoveTopBtn = null;
        this.manageMoveBottomBtn = null;
        this.manageListEl = null;
        this.chatNameOverlay = null;
        this.chatNameModal = null;
        this.chatNameInputEl = null;
        this.chatNameResolve = null;
        this.chatNameKeyHandler = null;
        this.editorRenderRevision = 0;
        this.variableOverlay = null;
        this.variableModal = null;
        this.variableNameInputEl = null;
        this.variableDefaultInputEl = null;
        this.variableRightInputEl = null;
        this.variableTypeBtn = null;
        this.variableOpBtn = null;
        this.variableRightTypeBtn = null;
        this.variableResolve = null;
        this.variableKeyHandler = null;
        this.variableModalDraft = buildVariableCreationDraft();
        this.variableBrowserOverlay = null;
        this.variableBrowserModal = null;
        this.variableBrowserSearchEl = null;
        this.variableBrowserListEl = null;
        this.variableBrowserEmptyEl = null;
        this.variableBrowserScopeEl = null;
        this.variableBrowserNameEl = null;
        this.variableBrowserSourceEl = null;
        this.variableBrowserTypeBtn = null;
        this.variableBrowserCurrentEl = null;
        this.variableBrowserDefaultEl = null;
        this.variableBrowserInitialEl = null;
        this.variableBrowserDeleteBtn = null;
        this.variableBrowserResolve = null;
        this.variableBrowserKeyHandler = null;
        this.variableBrowserState = {
            search: '',
            selectedId: '',
            scope: 'current',
            recentIds: loadRecentVariableNames(),
            draft: null,
        };
        this.refMode = false;
        this.refLocalEntries = null;
        this.refSyncTimer = null;
        this.refSyncDelay = 900;
        this.refSyncInFlight = false;
        this.refSyncPending = false;
        this.entrySearchTerm = '';
        this.entrySearchTimer = null;
        this.entryCommentRenderTimer = null;
        this.entrySearchCache = new WeakMap();
        this.entryPageSize = 4;
        this.entryPageIndex = 0;
        this.entrySearchEl = null;
        this.entryPageSizeEl = null;
        this.entryPagePrevBtn = null;
        this.entryPageNextBtn = null;
        this.entryPageIndicatorEl = null;
        this.entryDotsEl = null;
        this.entryPageTransitionTimer = null;
        this.entryPageTransitionTargetEl = null;
        this.entryPageTransitionScrollEndHandler = null;
        this.entryPageTransitionToken = 0;
        this.entryTotalPages = 1;
        this.customSelectMenuEl = null;
        this.customSelectMenuAnchor = null;
        this.customSelectMenuCleanup = null;
        this.entryBlockPageMap = new Map();
        this.blockFlipMap = new Map();
        this.blockExpandMap = new Map();
        this.blockExpandMotionPending = '';
        this.blockCollapseTimer = null;
        this.blockShellPlaceholderHeight = 0;
        this.blockBackViewMap = new Map();
        this.blockConditionTargetMap = new Map();
        this.blockEditorFocusMap = new Map();
        this.blockManageOverlay = null;
        this.blockManageModal = null;
        this.blockManageList = null;
        this.blockManageCloseBtn = null;
        this.blockManageEntryId = '';
        this.variableGuideActive = false;
        this.variableGuidePending = false;
        this.variableGuideStepIndex = 0;
        this.variableGuideSteps = [];
        this.variableGuideBubbleEl = null;
        this.variableGuideCurrentTarget = null;
        this.variableGuideRepositionHandler = null;
        this.variableGuideResizeHandler = null;
        this.nodeEditorCleanup = null;
        this.closeMotionTimer = null;
        this.entryListMotionPending = false;
        this.editorMotionEntryId = '';
    }

    applyDebugFocus({ entryId = '', blockId = '', nodeId = '' } = {}) {
        const targetEntryId = String(entryId ?? '').trim();
        if (!targetEntryId) return false;
        const targetBlockId = String(blockId || '').trim();
        const targetNodeId = String(nodeId || '').trim();
        const { idx, entry } = this.resolveEntryById(targetEntryId);
        if (!entry || idx < 0) return false;
        const entryKey = this.getEntryId(entry, idx);
        const blocks = this.ensureEntryPromptBlocks(entry);
        if (!Array.isArray(blocks) || !blocks.length) return false;
        let blockIndex = 0;
        if (targetBlockId) {
            const hit = blocks.findIndex(block => String(block?.id || '').trim() === targetBlockId);
            if (hit >= 0) blockIndex = hit;
        }
        const targetBlock = blocks[blockIndex] || blocks[0];
        if (!targetBlock) return false;
        this.setEntryBlockPage(entry, entryKey, blockIndex);
        this.selectEntry(idx);
        this.openBlockNodeEditor(targetBlock.id, targetNodeId ? [targetNodeId] : []);
        return true;
    }

    async show(name, data, options = {}) {
        if (!this.modal) {
            this.createUI();
        }
        let sourceData = data;
        let sourceSnapshot = options?.snapshot && typeof options.snapshot === 'object'
            ? options.snapshot
            : null;
        if (!sourceSnapshot) {
            const { getWorldInfoSnapshot } = resolveWorldEditorBridgeContext();
            if (typeof getWorldInfoSnapshot === 'function') {
                try {
                    sourceSnapshot = await getWorldInfoSnapshot(name);
                } catch {}
            }
        }
        if (sourceSnapshot?.data && typeof sourceSnapshot.data === 'object') {
            sourceData = sourceSnapshot.data;
        }
        const wasClosing = this.modal?.classList.contains('is-closing');
        const wasVisible = this.modal?.style.display !== 'none';
        this.worldName = name;
        this.originalName = name;
        this.data = deepClone(sourceData || { name, entries: [] });
        this.baseRevision = Number.isFinite(Number(sourceSnapshot?.revision))
            ? Number(sourceSnapshot.revision)
            : null;
        this.baseGeneration = Number.isFinite(Number(sourceSnapshot?.generation))
            ? Number(sourceSnapshot.generation)
            : null;
        if (!Array.isArray(this.data.entries)) this.data.entries = [];
        const hasRefs = Array.isArray(this.data.refs) && this.data.refs.length > 0;
        const hasEntries = this.data.entries.length > 0;
        this.refMode = hasRefs && !hasEntries;
        this.refLocalEntries = hasEntries ? null : this.data.entries.slice();
        if (this.refMode) {
            try {
                const resolved = await this.resolveRefEntriesForDisplay(this.data.refs);
                this.data.entries = Array.isArray(resolved) ? resolved : [];
            } catch (err) {
                logger.warn('读取引用世界书失败', err);
                this.data.entries = [];
            }
        }
        const isCharacterCardWorld = String(this.data?.source || '').trim() === 'character_card';
        this.data.entries = this.data.entries.map((e, i) => normalizeEntry(e, i, {
            characterCardWorld: isCharacterCardWorld,
        }));
        if (!this.data.entries.length && !this.refMode) {
            this.data.entries.push(createDefaultEntry(0));
        }
        this.batchMode = false;
        this.selectedEntries.clear();
        this.blockFlipMap.clear();
        this.blockExpandMap.clear();
        this.blockExpandMotionPending = '';
        if (this.blockCollapseTimer) {
            clearTimeout(this.blockCollapseTimer);
            this.blockCollapseTimer = null;
        }
        this.blockManageEntryId = '';
        this.entrySearchTerm = '';
        this.entrySearchCache = new WeakMap();
        if (this.entryCommentRenderTimer) {
            clearTimeout(this.entryCommentRenderTimer);
            this.entryCommentRenderTimer = null;
        }
        this.entryPageIndex = 0;
        this.updateBatchBar();
        if (this.nameInputEl) {
            const displayName = String(this.data?.name || name || '').trim();
            this.nameInputEl.value = displayName || '';
        }
        const baseName = String(this.nameInputEl?.value || this.data?.name || name || '').trim();
        this.baseWorldData = this.refMode ? null : deepClone(this.prepareForSave(baseName));
        this.refBaseEntries = this.refMode
            ? this.data.entries.map((entry, index) => deepClone(compactNormalizedEntryForSave(
                normalizeEntry(entry, index, { characterCardWorld: isCharacterCardWorld }),
                index,
            )))
            : null;
        if (this.entrySearchEl) this.entrySearchEl.value = '';
        const firstEnabledIndex = this.data.entries.findIndex(entry => !entry?.disable);
        this.currentIndex = firstEnabledIndex >= 0 ? firstEnabledIndex : 0;
        this.entryListMotionPending = !wasVisible || wasClosing;
        this.editorMotionEntryId = '';
        this.renderList();
        this.selectEntry(this.currentIndex);
        this.applyDebugFocus(options);
        this.updateRefModeUI();
        if (this.closeMotionTimer) {
            clearTimeout(this.closeMotionTimer);
            this.closeMotionTimer = null;
        }
        this.overlay.classList.remove('is-closing', 'is-opening');
        this.modal.classList.remove('is-closing', 'is-opening');
        this.overlay.style.display = 'flex';
        this.modal.style.display = 'flex';
        if ((!wasVisible || wasClosing) && !isWorldMotionReduced()) {
            this.overlay.classList.add('is-opening');
            this.modal.classList.add('is-opening');
        }
    }

    hide() {
        this.cleanupNodeEditor();
        this.closeCustomSelectMenu();
        this.finishVariableGuide({ markSeen: false });
        this.hideManageModal();
        this.hideAiModal();
        this.closeVariableModal(null);
        this.closeVariableBrowser(null);
        this.hideBlockManageModal();
        if (this.refSyncTimer) {
            clearTimeout(this.refSyncTimer);
            this.refSyncTimer = null;
        }
        if (this.entrySearchTimer) {
            clearTimeout(this.entrySearchTimer);
            this.entrySearchTimer = null;
        }
        if (this.entryCommentRenderTimer) {
            clearTimeout(this.entryCommentRenderTimer);
            this.entryCommentRenderTimer = null;
        }
        if (this.blockCollapseTimer) {
            clearTimeout(this.blockCollapseTimer);
            this.blockCollapseTimer = null;
        }
        this.finishEntryPageTransition();
        if (!this.overlay || !this.modal || this.modal.style.display === 'none') return;
        if (this.modal.classList.contains('is-closing')) return;

        const finish = () => {
            this.closeMotionTimer = null;
            this.overlay.style.display = 'none';
            this.modal.style.display = 'none';
            this.overlay.classList.remove('is-opening', 'is-closing');
            this.modal.classList.remove('is-opening', 'is-closing');
        };
        if (isWorldMotionReduced()) {
            finish();
            return;
        }
        this.overlay.classList.remove('is-opening');
        this.modal.classList.remove('is-opening');
        this.overlay.classList.add('is-closing');
        this.modal.classList.add('is-closing');
        this.closeMotionTimer = setTimeout(finish, 220);
    }

    cleanupNodeEditor() {
        if (typeof this.nodeEditorCleanup === 'function') {
            try { this.nodeEditorCleanup(); } catch {}
        }
        this.nodeEditorCleanup = null;
    }

    updateRefModeUI() {
        const disabled = Boolean(this.refMode);
        const applyState = (btn) => {
            if (!btn) return;
            btn.disabled = disabled;
            btn.style.opacity = disabled ? '0.6' : '';
            btn.style.cursor = disabled ? 'not-allowed' : '';
        };
        applyState(this.addBtn);
        applyState(this.manageBtn);
        if (this.nameInputEl) {
            this.nameInputEl.disabled = disabled;
            this.nameInputEl.style.opacity = disabled ? '0.6' : '';
        }
    }

    isVariableGuideSeen() {
        try {
            return localStorage.getItem(WORLD_VAR_GUIDE_KEY) === '1';
        } catch {
            return false;
        }
    }

    markVariableGuideSeen() {
        try {
            localStorage.setItem(WORLD_VAR_GUIDE_KEY, '1');
        } catch {}
    }

    shouldShowVariableGuide() {
        return !this.isVariableGuideSeen();
    }

    requestVariableGuide() {
        if (!this.shouldShowVariableGuide()) return;
        this.variableGuidePending = true;
    }

    clearVariableGuideTarget() {
        if (this.variableGuideCurrentTarget) {
            this.variableGuideCurrentTarget.classList.remove('world-guide-target');
            this.variableGuideCurrentTarget = null;
        }
    }

    buildVariableGuideSteps() {
        const q = (selector) => this.editorEl?.querySelector(selector) || null;
        const rawSteps = [
            {
                selector: '.world-node-toolbar-btn[data-action="addCondition"]',
                title: '一步生成条件链',
                text: '先点“条件链”，会自动生成“变量 -> 比较 -> 值”的基础结构。',
                effect: '你不需要手工拼三类节点；若加错，选中后按 Delete 或点“删除”即可移除。',
            },
            {
                selector: '.world-node-toolbar-btn[data-action="addMore"]',
                title: '变量是进阶可选项',
                text: '“新增”菜单里有变量、值、比较、逻辑节点；只有做动态条件时才需要变量。',
                effect: '例如“好感度 > 10”这类状态判断，才需要变量。',
            },
            {
                selector: '#we-node-inspector',
                title: '在这里改条件细节',
                text: '选中比较节点后，可在属性区设置比较符和值（如 > 10）。',
                effect: '条件命中才注入，不命中就不会注入这段内容。',
            },
            {
                selector: '#we-block-editor-save',
                title: '保存后开始生效',
                text: '设置完成后记得保存，系统会把当前节点规则写回世界书条目。',
                effect: '后续可在概览和调试里看到命中/未命中的原因。',
            },
        ];
        return rawSteps
            .map((step) => {
                const target = q(step.selector);
                if (!target) return null;
                return { ...step, target };
            })
            .filter(Boolean);
    }

    ensureVariableGuideBubble() {
        if (this.variableGuideBubbleEl) return;
        const bubble = document.createElement('div');
        bubble.className = 'world-guide-bubble';
        bubble.style.display = 'none';
        bubble.innerHTML = `
            <div class="world-guide-head">
                <span class="world-guide-kicker">新手引导</span>
                <span class="world-guide-step"></span>
            </div>
            <div class="world-guide-title"></div>
            <div class="world-guide-text"></div>
            <div class="world-guide-effect"></div>
            <div class="world-guide-actions">
                <button type="button" class="world-guide-btn ghost" data-action="skip">跳过</button>
                <button type="button" class="world-guide-btn ghost" data-action="prev">上一步</button>
                <button type="button" class="world-guide-btn primary" data-action="next">下一步</button>
            </div>
        `;
        bubble.addEventListener('click', (event) => event.stopPropagation());
        bubble.querySelector('[data-action="skip"]')?.addEventListener('click', () => this.finishVariableGuide({ markSeen: true }));
        bubble.querySelector('[data-action="prev"]')?.addEventListener('click', () => this.advanceVariableGuide(-1));
        bubble.querySelector('[data-action="next"]')?.addEventListener('click', () => this.advanceVariableGuide(1));
        document.body.appendChild(bubble);
        this.variableGuideBubbleEl = bubble;
    }

    positionVariableGuideBubble() {
        if (!this.variableGuideActive || !this.variableGuideBubbleEl) return;
        const step = this.variableGuideSteps[this.variableGuideStepIndex];
        if (!step?.target || !step.target.isConnected) return;
        const bubble = this.variableGuideBubbleEl;
        const rect = step.target.getBoundingClientRect();
        bubble.style.visibility = 'hidden';
        bubble.style.display = 'block';
        const bubbleRect = bubble.getBoundingClientRect();
        const gap = 10;
        let top = rect.bottom + gap;
        let place = 'bottom';
        if (top + bubbleRect.height > window.innerHeight - 8) {
            top = Math.max(8, rect.top - bubbleRect.height - gap);
            place = 'top';
        }
        let left = rect.left + rect.width / 2 - bubbleRect.width / 2;
        left = Math.max(8, Math.min(window.innerWidth - bubbleRect.width - 8, left));
        bubble.style.left = `${Math.round(left)}px`;
        bubble.style.top = `${Math.round(top)}px`;
        bubble.setAttribute('data-place', place);
        bubble.style.visibility = 'visible';
    }

    showVariableGuideStep(index = 0) {
        if (!this.variableGuideActive) return;
        const total = this.variableGuideSteps.length;
        if (!total) {
            this.finishVariableGuide({ markSeen: false });
            return;
        }
        const nextIndex = Math.max(0, Math.min(total - 1, Number(index) || 0));
        this.variableGuideStepIndex = nextIndex;
        const step = this.variableGuideSteps[nextIndex];
        if (!step?.target || !step.target.isConnected) {
            this.finishVariableGuide({ markSeen: false });
            return;
        }
        this.clearVariableGuideTarget();
        this.variableGuideCurrentTarget = step.target;
        step.target.classList.add('world-guide-target');
        this.ensureVariableGuideBubble();
        if (!this.variableGuideBubbleEl) return;
        const bubble = this.variableGuideBubbleEl;
        const stepEl = bubble.querySelector('.world-guide-step');
        const titleEl = bubble.querySelector('.world-guide-title');
        const textEl = bubble.querySelector('.world-guide-text');
        const effectEl = bubble.querySelector('.world-guide-effect');
        const prevBtn = bubble.querySelector('[data-action="prev"]');
        const nextBtn = bubble.querySelector('[data-action="next"]');
        if (stepEl) stepEl.textContent = `${nextIndex + 1}/${total}`;
        if (titleEl) titleEl.textContent = step.title;
        if (textEl) textEl.textContent = step.text;
        if (effectEl) effectEl.textContent = `效果：${step.effect}`;
        if (prevBtn) prevBtn.disabled = nextIndex <= 0;
        if (nextBtn) nextBtn.textContent = nextIndex >= total - 1 ? '完成' : '下一步';
        this.positionVariableGuideBubble();
    }

    advanceVariableGuide(stepDelta = 1) {
        if (!this.variableGuideActive) return;
        const total = this.variableGuideSteps.length;
        if (!total) {
            this.finishVariableGuide({ markSeen: false });
            return;
        }
        const nextIndex = this.variableGuideStepIndex + Number(stepDelta || 0);
        if (nextIndex >= total) {
            this.finishVariableGuide({ markSeen: true });
            return;
        }
        if (nextIndex < 0) {
            this.showVariableGuideStep(0);
            return;
        }
        this.showVariableGuideStep(nextIndex);
    }

    finishVariableGuide({ markSeen = true } = {}) {
        if (markSeen) this.markVariableGuideSeen();
        this.variableGuideActive = false;
        this.variableGuidePending = false;
        this.variableGuideStepIndex = 0;
        this.variableGuideSteps = [];
        this.clearVariableGuideTarget();
        if (this.variableGuideBubbleEl) {
            this.variableGuideBubbleEl.style.display = 'none';
        }
        if (this.variableGuideRepositionHandler) {
            window.removeEventListener('scroll', this.variableGuideRepositionHandler, true);
            this.variableGuideRepositionHandler = null;
        }
        if (this.variableGuideResizeHandler) {
            window.removeEventListener('resize', this.variableGuideResizeHandler);
            this.variableGuideResizeHandler = null;
        }
    }

    maybeStartVariableGuide() {
        if (!this.variableGuidePending || this.variableGuideActive) return;
        if (!this.shouldShowVariableGuide()) {
            this.variableGuidePending = false;
            return;
        }
        const steps = this.buildVariableGuideSteps();
        if (!steps.length) return;
        this.variableGuidePending = false;
        this.variableGuideSteps = steps;
        this.variableGuideActive = true;
        this.ensureVariableGuideBubble();
        if (!this.variableGuideRepositionHandler) {
            this.variableGuideRepositionHandler = () => this.positionVariableGuideBubble();
            window.addEventListener('scroll', this.variableGuideRepositionHandler, true);
        }
        if (!this.variableGuideResizeHandler) {
            this.variableGuideResizeHandler = () => this.positionVariableGuideBubble();
            window.addEventListener('resize', this.variableGuideResizeHandler);
        }
        this.showVariableGuideStep(0);
    }

    scheduleRefSync() {
        if (!this.refMode) return;
        if (this.refSyncTimer) clearTimeout(this.refSyncTimer);
        if (this.isAiTraceWatchActive()) {
            this.traceAi('ref.sync.schedule', {
                delay: this.refSyncDelay,
                inFlight: this.refSyncInFlight,
                pending: this.refSyncPending,
            });
        }
        this.refSyncTimer = setTimeout(() => this.flushRefSync(), this.refSyncDelay);
    }

    async flushRefSync() {
        if (!this.refMode) return;
        if (this.refSyncInFlight) {
            this.refSyncPending = true;
            if (this.isAiTraceWatchActive()) {
                this.traceAi('ref.sync.defer', { reason: 'in-flight' });
            }
            return;
        }
        this.refSyncInFlight = true;
        if (this.isAiTraceWatchActive()) {
            this.traceAi('ref.sync.start', {
                pending: this.refSyncPending,
            });
        }
        try {
            await this.saveRefEdits({ showToast: false });
        } finally {
            this.refSyncInFlight = false;
            if (this.isAiTraceWatchActive()) {
                this.traceAi('ref.sync.finish', {
                    pending: this.refSyncPending,
                });
            }
            if (this.refSyncPending) {
                this.refSyncPending = false;
                this.scheduleRefSync();
            }
        }
    }

    createUI() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'world-editor-overlay';
        this.overlay.className = 'popup-overlay app-themed-overlay';
        this.overlay.style.display = 'none';
        // Ensure editor sits above world management panel
        this.overlay.style.position = 'fixed';
        this.overlay.style.inset = '0';
        this.overlay.style.background = 'rgba(0,0,0,0.45)';
        this.overlay.style.zIndex = '23000';
        this.overlay.style.padding = 'calc(10px + env(safe-area-inset-top, 0px)) calc(10px + env(safe-area-inset-right, 0px)) calc(10px + env(safe-area-inset-bottom, 0px)) calc(10px + env(safe-area-inset-left, 0px))';
        this.overlay.style.boxSizing = 'border-box';
        this.overlay.style.alignItems = 'center';
        this.overlay.style.justifyContent = 'center';
        bindBackdropActivation(this.overlay, {
            onActivate: () => this.hide(),
        });

        this.modal = document.createElement('div');
        this.modal.id = 'world-editor-modal';
        this.modal.className = 'world-editor-popup app-themed-panel';
        this.modal.style.display = 'none';
        this.modal.style.position = 'relative';
        this.modal.style.top = 'auto';
        this.modal.style.left = 'auto';
        this.modal.style.transform = 'none';
        this.modal.style.width = 'min(900px, 100%)';
        this.modal.style.maxWidth = '100%';
        this.modal.style.height = 'min(90vh, 100%)';
        this.modal.style.maxHeight = '100%';
        this.modal.style.zIndex = '23000';
        this.modal.onclick = (e) => e.stopPropagation();

        this.modal.innerHTML = `
            <div class="world-editor-header">
                <div class="world-editor-title">
                    <span style="margin-right:6px;">世界书</span>
                    <input id="world-editor-name" type="text" placeholder="名称" style="font-weight:700; font-size:14px; color:var(--app-text-primary); border:1px solid var(--app-border-default); border-radius:8px; padding:4px 8px; min-width:140px; max-width:260px;">
                </div>
                <div class="world-editor-actions">
                    <button id="world-editor-save" data-maid-guide-target="worldbook-save">保存</button>
                    <button id="world-editor-export">导出</button>
                    <button id="world-editor-manage">管理</button>
                    <button id="world-editor-close" class="world-editor-close">×</button>
                </div>
            </div>
            <div class="world-editor-body">
                <div class="world-entries-column">
                    <div class="world-entries-toolbar">
                        <button id="world-entry-add" data-maid-guide-target="worldbook-entry-add">＋ 新条目</button>
                        <div class="world-entries-search">
                            <input id="world-entry-search" type="search" placeholder="搜索条目">
                        </div>
                        <div class="world-entries-pager">
                            <span class="world-entries-pager-label">每页</span>
                            <input id="world-entry-page-size" type="number" min="1" max="200" step="1" list="world-entry-page-sizes" value="4">
                            <datalist id="world-entry-page-sizes">
                                <option value="4"></option>
                                <option value="5"></option>
                                <option value="10"></option>
                                <option value="50"></option>
                                <option value="100"></option>
                            </datalist>
                            <button id="world-entry-page-prev" type="button" aria-label="上一页">‹</button>
                            <span id="world-entry-page-indicator">1/1</span>
                            <button id="world-entry-page-next" type="button" aria-label="下一页">›</button>
                        </div>
                    </div>
                    <ul id="world-entries-list" class="world-entries-list"></ul>
                    <div id="world-entry-dots" class="world-entries-dots"></div>
                </div>
                <div id="world-entry-editor" class="world-entry-editor"></div>
            </div>
        `;

        this.entriesListEl = this.modal.querySelector('#world-entries-list');
        this.editorEl = this.modal.querySelector('#world-entry-editor');
        this.nameInputEl = this.modal.querySelector('#world-editor-name');
        this.saveBtn = this.modal.querySelector('#world-editor-save');
        this.addBtn = this.modal.querySelector('#world-entry-add');
        this.exportBtn = this.modal.querySelector('#world-editor-export');
        this.manageBtn = this.modal.querySelector('#world-editor-manage');
        this.entrySearchEl = this.modal.querySelector('#world-entry-search');
        this.entryPageSizeEl = this.modal.querySelector('#world-entry-page-size');
        this.entryPagePrevBtn = this.modal.querySelector('#world-entry-page-prev');
        this.entryPageNextBtn = this.modal.querySelector('#world-entry-page-next');
        this.entryPageIndicatorEl = this.modal.querySelector('#world-entry-page-indicator');
        this.entryDotsEl = this.modal.querySelector('#world-entry-dots');

        this.modal.querySelector('#world-editor-close').onclick = () => this.hide();
        this.saveBtn.onclick = () => this.saveWorld();
        if (this.exportBtn) this.exportBtn.onclick = () => this.exportWorld();
        this.addBtn.onclick = () => this.addEntry();
        if (this.manageBtn) this.manageBtn.onclick = () => this.showManageModal();
        if (this.entrySearchEl) {
            this.entrySearchEl.addEventListener('input', () => {
                if (this.entrySearchTimer) clearTimeout(this.entrySearchTimer);
                this.entrySearchTimer = setTimeout(() => {
                    this.entrySearchTimer = null;
                    this.entrySearchTerm = String(this.entrySearchEl.value || '');
                    this.entryPageIndex = 0;
                    this.renderList();
                }, 160);
            });
        }
        if (this.entryPageSizeEl) {
            this.entryPageSizeEl.addEventListener('input', () => {
                const raw = Number(this.entryPageSizeEl.value);
                if (!Number.isFinite(raw)) return;
                const next = Math.max(1, Math.min(200, Math.trunc(raw)));
                this.entryPageSize = next;
                this.entryPageSizeEl.value = String(next);
                this.entryPageIndex = 0;
                this.renderList();
            });
        }
        this.entryPagePrevBtn?.addEventListener('click', () => {
            this.changeEntryPage(this.entryPageIndex - 1);
        });
        this.entryPageNextBtn?.addEventListener('click', () => {
            this.changeEntryPage(this.entryPageIndex + 1);
        });

        this.overlay.appendChild(this.modal);
        document.body.appendChild(this.overlay);
        this.createAiModal();
        this.createManageModal();
    }

    createAiModal() {
        if (this.aiModal) return;
        this.aiOverlay = document.createElement('div');
        this.aiOverlay.className = 'world-ai-overlay';
        this.aiOverlay.style.display = 'none';
        this.aiOverlay.addEventListener('click', () => this.hideAiModal());

        this.aiModal = document.createElement('div');
        this.aiModal.className = 'world-ai-modal';
        this.aiModal.style.display = 'none';
        this.aiModal.innerHTML = `
            <div class="world-ai-header">
                <div>
                    <div class="world-ai-title">AI 生成角色世界书</div>
                    <div class="world-ai-subtitle">输入人物设定，自动生成 YAML 条目</div>
                </div>
                <button type="button" class="world-ai-close" aria-label="关闭">×</button>
            </div>
            <div class="world-ai-body">
                <label class="world-ai-label">人物设定</label>
                <textarea id="world-ai-input" class="world-ai-textarea" placeholder="例如：名字、性别、背景、外貌、性格、说话习惯、关系等"></textarea>
                <div class="world-ai-hint">生成过程中可关闭此窗，完成后自动写入内容并保存。</div>

                <label class="world-ai-label">生成模板</label>
                <textarea id="world-ai-template" class="world-ai-textarea world-ai-template" placeholder="可编辑模板（建议保留字段结构）"></textarea>

                <div class="world-ai-actions">
                    <label class="world-ai-web-toggle" title="仅下一次生成或继续使用联网搜索">
                        <input type="checkbox" id="world-ai-web-search">
                        <span>本次联网</span>
                    </label>
                    <button type="button" class="world-ai-btn ghost" id="world-ai-cancel">关闭</button>
                    <button type="button" class="world-ai-btn" id="world-ai-continue">继续</button>
                    <button type="button" class="world-ai-btn primary" id="world-ai-generate">生成</button>
                </div>
                <div class="world-ai-status" id="world-ai-status"></div>
                <div class="ad-hoc-web-sources world-ai-sources" id="world-ai-sources" hidden></div>
            </div>
        `;
        this.aiModal.addEventListener('click', (e) => e.stopPropagation());

        this.aiInputEl = this.aiModal.querySelector('#world-ai-input');
        this.aiTemplateEl = this.aiModal.querySelector('#world-ai-template');
        this.aiStatusEl = this.aiModal.querySelector('#world-ai-status');
        this.aiGenerateBtn = this.aiModal.querySelector('#world-ai-generate');
        this.aiContinueBtn = this.aiModal.querySelector('#world-ai-continue');
        this.aiCloseBtn = this.aiModal.querySelector('.world-ai-close');
        this.aiWebSearchToggleEl = this.aiModal.querySelector('#world-ai-web-search');
        this.aiWebSourcesEl = this.aiModal.querySelector('#world-ai-sources');
        const cancelBtn = this.aiModal.querySelector('#world-ai-cancel');

        this.aiWebSearchToggleRuntime = createAdHocWebSearchToggleRuntime({
            toggleEl: this.aiWebSearchToggleEl,
            confirm: () => appConfirm({
                title: '允许本次联网？',
                message: '联网搜索可能产生额外费用，并会把本次生成所需的查询发送给搜索服务。此开关仅对下一次生成或继续生效。',
                confirmText: '允许本次联网',
                cancelText: '取消',
            }),
        });
        this.aiWebSearchToggleEl?.addEventListener('change', () => {
            if (this.aiWebSearchToggleEl?.checked) {
                void this.aiWebSearchToggleRuntime?.confirmEnabled();
            }
        });

        if (this.aiInputEl) {
            this.aiInputEl.value = loadWorldAiInput();
            this.aiInputEl.addEventListener('input', () => saveWorldAiInput(this.aiInputEl.value));
        }
        if (this.aiTemplateEl) {
            this.aiTemplateEl.value = loadWorldAiTemplate();
            this.aiTemplateEl.addEventListener('input', () => saveWorldAiTemplate(this.aiTemplateEl.value));
        }

        if (this.aiGenerateBtn) this.aiGenerateBtn.onclick = () => this.handleAiGenerate();
        if (this.aiContinueBtn) this.aiContinueBtn.onclick = () => this.handleAiContinue();
        if (this.aiCloseBtn) this.aiCloseBtn.onclick = () => this.hideAiModal();
        if (cancelBtn) cancelBtn.onclick = () => this.hideAiModal();

        document.body.appendChild(this.aiOverlay);
        document.body.appendChild(this.aiModal);
    }

    showAiModal(entry) {
        if (!entry) return;
        if (!this.aiModal) this.createAiModal();
        const idx = this.data.entries.findIndex(item => item === entry);
        const entryIndex = idx >= 0 ? idx : this.currentIndex;
        const entryId = this.getEntryId(entry, entryIndex);
        const blocks = this.ensureEntryPromptBlocks(entry);
        const blockPage = this.getEntryBlockPage(entry, entryId);
        const activeBlock = blocks[blockPage] || blocks[0] || null;
        this.aiTargetEntryId = entryId;
        this.aiTargetBlockId = String(activeBlock?.id || '').trim();
        this.traceAi('modal.open', {
            entryIndex,
            currentIndex: this.currentIndex,
            entryId,
            blockPage,
            blockCount: blocks.length,
            blockId: this.aiTargetBlockId,
            blockSummary: summarizeTraceText(activeBlock?.content || ''),
        });
        if (this.aiTemplateEl && !String(this.aiTemplateEl.value || '').trim()) {
            this.aiTemplateEl.value = loadWorldAiTemplate();
        }
        this.aiWebSearchToggleRuntime?.reset();
        renderAdHocWebSources(this.aiWebSourcesEl, []);
        this.setAiStatus('');
        this.aiOverlay.style.display = 'block';
        this.aiModal.style.display = 'block';
    }

    hideAiModal() {
        if (this.aiOverlay) this.aiOverlay.style.display = 'none';
        if (this.aiModal) this.aiModal.style.display = 'none';
        // 关闭弹窗即停止在途生成，不再让请求与联网工具循环空耗
        try { this.aiAbortController?.abort(); } catch {}
        this.traceAi('modal.hide', {
            aiBusy: this.aiBusy,
            pendingEntryId: this.aiPendingEntryId,
            targetEntryId: this.aiTargetEntryId,
            targetBlockId: this.aiTargetBlockId,
        });
        if (!this.aiBusy) {
            this.aiTargetEntryId = '';
            this.aiTargetBlockId = '';
        }
    }

    createVariableModal() {
        return createVariableModalImpl.call(this, {
            BLOCK_RIGHT_TYPE_OPTIONS,
            BLOCK_OP_OPTIONS,
            buildVariableCreationDraft,
            normalizeRightTypeValue,
        });
    }

    renderVariableModalDraft() {
        return renderVariableModalDraftImpl.call(this, {
            BLOCK_RIGHT_TYPE_OPTIONS,
            BLOCK_OP_OPTIONS,
            buildVariableCreationDraft,
        });
    }

    openVariableModal(initialDraft = {}) {
        return openVariableModalImpl.call(this, initialDraft, {
            buildVariableCreationDraft,
        });
    }

    submitVariableModal() {
        return submitVariableModalImpl.call(this, {
            buildVariableCreationDraft,
            parseTypedValue,
        });
    }

    closeVariableModal(value = null) {
        return closeVariableModalImpl.call(this, value);
    }

    getSessionVariableRecords(options = {}) {
        return getSessionVariableRecordsImpl.call(this, options);
    }

    setVariableBrowserScope(scope = 'current') {
        return setVariableBrowserScopeImpl.call(this, scope);
    }

    rememberRecentVariable(record = null) {
        return rememberRecentVariableImpl.call(this, record, {
            saveRecentVariableNames,
        });
    }

    deleteVariableBrowserDraft() {
        return deleteVariableBrowserDraftImpl.call(this, {
            saveRecentVariableNames,
        });
    }

    formatVariableBrowserValue(value, type = 'string') {
        return formatVariableBrowserValueImpl.call(this, value, type);
    }

    buildVariableBrowserDraft(record = null) {
        return buildVariableBrowserDraftImpl.call(this, record);
    }

    createVariableBrowserModal() {
        return createVariableBrowserModalImpl.call(this, {
            BLOCK_RIGHT_TYPE_OPTIONS,
            parseTypedValue,
            escapeHtml,
        });
    }

    renderVariableBrowserDetail() {
        return renderVariableBrowserDetailImpl.call(this, {
            BLOCK_RIGHT_TYPE_OPTIONS,
        });
    }

    renderVariableBrowser() {
        return renderVariableBrowserImpl.call(this, {
            BLOCK_RIGHT_TYPE_OPTIONS,
            escapeHtml,
        });
    }

    saveVariableBrowserDraft() {
        return saveVariableBrowserDraftImpl.call(this, {
            parseTypedValue,
        });
    }

    openVariableBrowser({ initialName = '' } = {}) {
        return openVariableBrowserImpl.call(this, { initialName });
    }

    closeVariableBrowser(value = null) {
        return closeVariableBrowserImpl.call(this, value);
    }

    applyVariablePayloadToNode(node, payload) {
        if (!node || typeof node !== 'object' || !payload) return false;
        if (!node.data || typeof node.data !== 'object') node.data = {};
        node.data.path = String(payload.name || '').trim();
        node.data.autoCreate = true;
        node.data.varType = String(payload.type || 'number').trim().toLowerCase();
        node.data.defaultValue = payload.defaultValue;
        return true;
    }

    ensureOverviewQuickFixVariableNode(block, fixKind = 'missing_left_variable', targetIndex = 0) {
        if (!block || typeof block !== 'object') return null;
        const graph = this.ensureBlockNodeGraph(block);
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];
        const nodeById = new Map(nodes.map(node => [String(node.id || ''), node]));
        const compareNodes = nodes
            .filter(node => normalizeNodeType(node?.type) === 'compare')
            .sort((a, b) => {
                const yDelta = Number(a?.y || 0) - Number(b?.y || 0);
                if (yDelta !== 0) return yDelta;
                return Number(a?.x || 0) - Number(b?.x || 0);
            });
        const matchKind = String(fixKind || '').trim();
        let hitIndex = -1;
        for (const compareNode of compareNodes) {
            const compareId = String(compareNode.id || '').trim();
            if (!compareId) continue;
            const compareData = normalizeGraphNodeData('compare', compareNode.data || {});
            const port = matchKind === 'missing_right_variable' ? 'right' : 'left';
            const edge = edges.find(item => item.to === compareId && item.toPort === port) || null;
            const linkedNode = edge ? nodeById.get(String(edge.from || '')) : null;
            let matches = false;
            if (matchKind === 'missing_left_variable') {
                matches = !linkedNode || (normalizeNodeType(linkedNode.type) === 'variable' && !String(linkedNode?.data?.path || '').trim());
            } else if (matchKind === 'missing_right_variable') {
                matches =
                    compareData.fallbackRightType === 'variable' &&
                    (
                        !linkedNode ||
                        (normalizeNodeType(linkedNode.type) === 'variable' && !String(linkedNode?.data?.path || '').trim())
                    );
            }
            if (!matches) continue;
            hitIndex += 1;
            if (hitIndex !== Math.max(0, Number(targetIndex || 0))) continue;
            if (linkedNode && normalizeNodeType(linkedNode.type) === 'variable') {
                if (!linkedNode.data || typeof linkedNode.data !== 'object') linkedNode.data = {};
                return { graph, node: linkedNode };
            }
            const nextX = Number(compareNode.x || 0) + (port === 'left' ? -240 : 240);
            const nextY = Number(compareNode.y || 0);
            const node = normalizeGraphNode({
                id: genNodeId(),
                type: 'variable',
                x: nextX,
                y: nextY,
                data: { autoCreate: false, varType: 'string', defaultValue: '' },
            }, nodes.length);
            graph.nodes.push(node);
            graph.edges = edges.filter(item => !(item.to === compareId && item.toPort === port));
            graph.edges.push({
                id: genEdgeId(),
                from: node.id,
                fromPort: 'out',
                to: compareId,
                toPort: port,
            });
            return { graph, node };
        }
        return null;
    }

    async applyOverviewQuickFix(block, item = null) {
        const fixKind = String(item?.kind || '').trim();
        if (!fixKind) return false;
        if (fixKind === 'disconnected_from_result') {
            const nodeId = String(item?.nodeId || '').trim();
            const blockId = String(block?.id || '').trim();
            if (!blockId || !nodeId) return false;
            this.openBlockNodeEditor(blockId, [nodeId]);
            window.toastr?.info?.('已定位到未接入当前生效链路的断点节点');
            return true;
        }
        const target = this.ensureOverviewQuickFixVariableNode(block, fixKind, item?.fixIndex || 0);
        if (!target?.node) return false;
        const result = await this.openVariableBrowser({ initialName: String(target.node?.data?.path || '').trim() });
        if (!result) return false;
        if (result?.payload) {
            if (!this.applyVariablePayloadToNode(target.node, result.payload)) return false;
            this.ensureVariableInStore(result.payload.name, result.payload.type, result.payload.defaultValue);
        } else {
            if (!target.node.data || typeof target.node.data !== 'object') target.node.data = {};
            target.node.data.path = String(result?.name || '').trim();
            target.node.data.varType = String(result?.type || target.node.data.varType || 'string').trim().toLowerCase();
            if (Object.prototype.hasOwnProperty.call(result || {}, 'defaultValue')) {
                target.node.data.defaultValue = result.defaultValue;
            }
            if (target.node.data.path) target.node.data.autoCreate = false;
        }
        this.syncBlockWhenFromNodeGraph(block);
        this.renderEditor();
        window.toastr?.success?.('已应用快速修复');
        return true;
    }

    getBlockRuntimeFocusTargets(block) {
        const emptyResult = {
            pathNodeIds: [],
            hitNodeIds: [],
            missNodeIds: [],
            pendingNodeIds: [],
        };
        if (!block || typeof block !== 'object') return emptyResult;
        const graph = this.ensureBlockNodeGraph(block);
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];
        if (!nodes.length) return emptyResult;

        const nodeById = new Map();
        nodes.forEach((node) => {
            const id = String(node?.id || '').trim();
            if (!id) return;
            nodeById.set(id, node);
        });
        const incomingByTo = new Map();
        edges.forEach((edge) => {
            const toId = String(edge?.to || '').trim();
            if (!toId) return;
            if (!incomingByTo.has(toId)) incomingByTo.set(toId, []);
            incomingByTo.get(toId).push(edge);
        });
        const getNodeById = (nodeId = '') => nodeById.get(String(nodeId || '').trim()) || null;
        const getIncomingEdges = (nodeId = '') => incomingByTo.get(String(nodeId || '').trim()) || [];
        const normalizeFocusNodeIds = (nodeIds = []) => [...new Set(
            (Array.isArray(nodeIds) ? nodeIds : [])
                .map(nodeId => String(nodeId || '').trim())
                .filter((nodeId) => {
                    if (!nodeId) return false;
                    const node = getNodeById(nodeId);
                    return Boolean(node) && normalizeNodeType(node?.type) !== 'result';
                }),
        )];

        const resultNode = nodes.find(node => normalizeNodeType(node?.type) === 'result') || null;
        if (!resultNode) return emptyResult;
        const resultNodeId = String(resultNode?.id || '').trim();
        const sourceEdge = getIncomingEdges(resultNodeId).find(edge => String(edge?.toPort || '').trim() === 'in') || null;
        const sourceNodeId = String(sourceEdge?.from || '').trim();
        if (!sourceNodeId) return emptyResult;

        const runtimeContext = this.getConditionRuntimeContext();
        const summaryCache = new Map();
        const summarizeNode = (nodeId = '', seen = new Set()) => {
            const id = String(nodeId || '').trim();
            if (!id || seen.has(id)) return null;
            if (summaryCache.has(id)) return summaryCache.get(id);
            const node = getNodeById(id);
            if (!node) return null;
            const type = normalizeNodeType(node?.type);
            const nextSeen = new Set(seen);
            nextSeen.add(id);

            if (type === 'compare') {
                const incoming = getIncomingEdges(id);
                const leftEdge = incoming.find(edge => String(edge?.toPort || '').trim() === 'left') || null;
                const rightEdge = incoming.find(edge => String(edge?.toPort || '').trim() === 'right') || null;
                const leftNode = getNodeById(leftEdge?.from);
                const rightNode = getNodeById(rightEdge?.from);
                const compareData = normalizeGraphNodeData('compare', node?.data || {});
                const op = String(compareData?.op || '>').trim();
                const needsRight = !['is_empty', 'not_empty'].includes(op.toLowerCase());
                const rightNodeType = normalizeNodeType(rightNode?.type);
                const rightType = rightNode
                    ? (rightNodeType === 'variable'
                        ? 'variable'
                        : normalizeRightTypeValue(rightNode?.data?.rightType || 'number'))
                    : normalizeRightTypeValue(compareData?.fallbackRightType || 'number');
                const rightPath = String(rightNode?.data?.path || '').trim();
                const rightRawValue = String(rightNode?.data?.value ?? '');
                const pendingReason = !String(leftNode?.data?.path || '').trim()
                    ? 'missing_left'
                    : !needsRight
                        ? ''
                        : !rightNode
                            ? 'missing_right_input'
                            : rightNodeType === 'variable'
                                ? (rightPath ? '' : 'missing_right_variable')
                                : (rightRawValue.trim() ? '' : 'missing_right_literal');
                const clause = normalizePromptClause({
                    left: String(leftNode?.data?.path || '').trim(),
                    op,
                    rightType,
                    right: !needsRight
                        ? ''
                        : !rightNode
                            ? ''
                            : rightNodeType === 'variable'
                                ? rightPath
                                : (rightRawValue.trim() ? parseTypedValue(rightRawValue, rightType) : ''),
                    pendingReason,
                });
                const explanation = explainConditionTree(clause, runtimeContext);
                const summary = {
                    nodeId: id,
                    type,
                    clause,
                    explanation,
                    result: typeof explanation?.result === 'boolean' ? explanation.result : null,
                };
                summaryCache.set(id, summary);
                return summary;
            }

            if (type === 'logic') {
                const logic = normalizeLogicValue(node?.data?.logic || 'and');
                const children = getNodePortSpec(node).inputs
                    .map((port) => {
                        const portName = String(port || '').trim();
                        const edge = getIncomingEdges(id).find(item => String(item?.toPort || '').trim() === portName) || null;
                        return {
                            port: portName,
                            edge,
                            child: edge ? summarizeNode(edge?.from, nextSeen) : null,
                        };
                    });
                const combined = combineConditionLogicState(logic, children.map(item => item?.child?.result));
                const summary = { nodeId: id, type, logic, children, result: combined.result };
                summaryCache.set(id, summary);
                return summary;
            }

            const summary = { nodeId: id, type, result: null };
            summaryCache.set(id, summary);
            return summary;
        };

        const hitNodeIds = [];
        const missNodeIds = [];
        const pendingNodeIds = [];
        nodes.forEach((node) => {
            const id = String(node?.id || '').trim();
            if (!id) return;
            const type = normalizeNodeType(node?.type);
            if (type !== 'compare' && type !== 'logic') return;
            const summary = summarizeNode(id);
            if (summary?.result === true) hitNodeIds.push(id);
            else if (summary?.result === false) missNodeIds.push(id);
            else pendingNodeIds.push(id);
        });

        const pathNodeSet = new Set();
        const walkVisited = new Set();
        const walkRuntimePath = (nodeId = '') => {
            const id = String(nodeId || '').trim();
            if (!id || walkVisited.has(id)) return;
            walkVisited.add(id);
            const node = getNodeById(id);
            if (!node) return;
            const type = normalizeNodeType(node?.type);
            if (type !== 'result') pathNodeSet.add(id);
            const incoming = getIncomingEdges(id);
            if (!incoming.length) return;

            if (type === 'compare') {
                const summary = summarizeNode(id);
                const op = String(summary?.clause?.op || node?.data?.op || '>').trim().toLowerCase();
                const needsRight = !['is_empty', 'not_empty'].includes(op);
                const leftEdge = incoming.find(edge => String(edge?.toPort || '').trim() === 'left') || null;
                const rightEdge = incoming.find(edge => String(edge?.toPort || '').trim() === 'right') || null;
                if (leftEdge?.from) walkRuntimePath(leftEdge.from);
                if (needsRight && rightEdge?.from) walkRuntimePath(rightEdge.from);
                return;
            }

            if (type === 'logic') {
                const summary = summarizeNode(id);
                const logicValue = normalizeLogicValue(summary?.logic || node?.data?.logic || 'and');
                const connected = Array.isArray(summary?.children) ? summary.children.filter(item => item?.edge?.from) : [];
                let selected = connected;
                if (logicValue === 'not') {
                    selected = connected.slice(0, 1);
                } else if (logicValue === 'and') {
                    if (summary?.result === true) {
                        const hits = connected.filter(item => item?.child?.result === true);
                        selected = hits.length
                            ? hits
                            : connected.filter(item => item?.child?.result !== false);
                        if (!selected.length) selected = connected;
                    } else if (summary?.result === false) {
                        const misses = connected.filter(item => item?.child?.result === false);
                        selected = misses.length ? misses : connected;
                    }
                } else if (logicValue === 'or') {
                    if (summary?.result === true) {
                        const hits = connected.filter(item => item?.child?.result === true);
                        selected = hits.length ? hits : connected;
                    } else if (summary?.result === false) {
                        const misses = connected.filter(item => item?.child?.result === false);
                        selected = misses.length ? misses : connected;
                    }
                }
                selected.forEach((item) => {
                    if (item?.edge?.from) walkRuntimePath(item.edge.from);
                });
                return;
            }

            incoming.forEach((edge) => {
                if (edge?.from) walkRuntimePath(edge.from);
            });
        };
        walkRuntimePath(sourceNodeId);

        return {
            pathNodeIds: normalizeFocusNodeIds([...pathNodeSet]),
            hitNodeIds: normalizeFocusNodeIds(hitNodeIds),
            missNodeIds: normalizeFocusNodeIds(missNodeIds),
            pendingNodeIds: normalizeFocusNodeIds(pendingNodeIds),
        };
    }

    getBlockDisconnectedNodeTargets(block) {
        if (!block || typeof block !== 'object') return [];
        const graph = this.ensureBlockNodeGraph(block);
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];
        if (!nodes.length) return [];
        const resultNode = nodes.find(node => normalizeNodeType(node?.type) === 'result') || null;
        if (!resultNode) return [];
        const activeNodeIds = new Set();
        const stack = [String(resultNode.id || '').trim()].filter(Boolean);
        while (stack.length) {
            const currentId = String(stack.pop() || '').trim();
            if (!currentId || activeNodeIds.has(currentId)) continue;
            activeNodeIds.add(currentId);
            edges
                .filter(edge => String(edge?.to || '').trim() === currentId)
                .forEach((edge) => {
                    const fromId = String(edge?.from || '').trim();
                    if (fromId) stack.push(fromId);
                });
        }
        const disconnectedNodes = nodes
            .filter(node => normalizeNodeType(node?.type) !== 'result')
            .filter(node => !activeNodeIds.has(String(node?.id || '').trim()));
        if (!disconnectedNodes.length) return [];
        const disconnectedIds = new Set(disconnectedNodes.map(node => String(node?.id || '').trim()).filter(Boolean));
        const candidates = disconnectedNodes.filter((node) => {
            const nodeId = String(node?.id || '').trim();
            if (!nodeId) return false;
            const outgoing = edges.filter(edge => String(edge?.from || '').trim() === nodeId);
            return !outgoing.some((edge) => disconnectedIds.has(String(edge?.to || '').trim()));
        });
        const targets = (candidates.length ? candidates : disconnectedNodes)
            .slice()
            .sort((a, b) => {
                const yDelta = Number(a?.y || 0) - Number(b?.y || 0);
                if (yDelta !== 0) return yDelta;
                return Number(a?.x || 0) - Number(b?.x || 0);
            })
            .map((node, index) => ({
                nodeId: String(node?.id || '').trim(),
                label: `${this.getOverviewNodeTypeLabel(node?.type)} ${index + 1}`,
            }));
        return targets.filter(item => item.nodeId);
    }

    getOverviewNodeTypeLabel(type = '') {
        const normalized = normalizeNodeType(type);
        if (normalized === 'variable') return '变量节点';
        if (normalized === 'value') return '值节点';
        if (normalized === 'compare') return '比较节点';
        if (normalized === 'logic') return '逻辑节点';
        return '节点';
    }

    createChatNameModal() {
        if (this.chatNameModal) return;
        this.chatNameOverlay = document.createElement('div');
        this.chatNameOverlay.className = 'world-chatname-overlay';
        this.chatNameOverlay.style.display = 'none';
        this.chatNameOverlay.addEventListener('click', () => this.closeChatNameModal(''));

        this.chatNameModal = document.createElement('div');
        this.chatNameModal.className = 'world-chatname-modal';
        this.chatNameModal.style.display = 'none';
        this.chatNameModal.innerHTML = `
            <div class="world-chatname-header">
                <div class="world-chatname-title">创建聊天室</div>
                <button type="button" class="world-chatname-close" aria-label="关闭">×</button>
            </div>
            <div class="world-chatname-body">
                <label class="world-chatname-label" for="world-chatname-input">聊天室名称</label>
                <input id="world-chatname-input" class="world-chatname-input" type="text" value="">
                <div class="world-chatname-hint">名称可修改，默认使用选中条目的名称</div>
            </div>
            <div class="world-chatname-actions">
                <button type="button" class="world-chatname-btn ghost" id="world-chatname-cancel">取消</button>
                <button type="button" class="world-chatname-btn primary" id="world-chatname-ok">创建</button>
            </div>
        `;
        this.chatNameModal.addEventListener('click', (e) => e.stopPropagation());

        this.chatNameInputEl = this.chatNameModal.querySelector('#world-chatname-input');
        const closeBtn = this.chatNameModal.querySelector('.world-chatname-close');
        const cancelBtn = this.chatNameModal.querySelector('#world-chatname-cancel');
        const okBtn = this.chatNameModal.querySelector('#world-chatname-ok');

        closeBtn?.addEventListener('click', () => this.closeChatNameModal(''));
        cancelBtn?.addEventListener('click', () => this.closeChatNameModal(''));
        okBtn?.addEventListener('click', () => this.submitChatNameModal());

        this.chatNameInputEl?.addEventListener('focus', () => {
            if (!this.chatNameInputEl) return;
            if (this.chatNameInputEl.classList.contains('is-placeholder')) {
                this.chatNameInputEl.value = '';
                this.chatNameInputEl.classList.remove('is-placeholder');
            }
        });
        this.chatNameInputEl?.addEventListener('blur', () => this.restoreChatNamePlaceholder());

        document.body.appendChild(this.chatNameOverlay);
        document.body.appendChild(this.chatNameModal);
    }

    openChatNameModal(defaultName) {
        if (!this.chatNameModal) this.createChatNameModal();
        if (!this.chatNameOverlay || !this.chatNameModal || !this.chatNameInputEl) return Promise.resolve('');
        const defaultText = String(defaultName || '').trim();
        this.chatNameInputEl.dataset.defaultName = defaultText;
        this.chatNameInputEl.value = defaultText;
        this.chatNameInputEl.classList.toggle('is-placeholder', Boolean(defaultText));
        this.chatNameOverlay.style.display = 'block';
        this.chatNameModal.style.display = 'block';

        if (this.chatNameKeyHandler) {
            document.removeEventListener('keydown', this.chatNameKeyHandler);
        }
        this.chatNameKeyHandler = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeChatNameModal('');
            } else if (event.key === 'Enter') {
                event.preventDefault();
                this.submitChatNameModal();
            }
        };
        document.addEventListener('keydown', this.chatNameKeyHandler);

        return new Promise((resolve) => {
            this.chatNameResolve = resolve;
        });
    }

    restoreChatNamePlaceholder() {
        if (!this.chatNameInputEl) return;
        const text = String(this.chatNameInputEl.value || '').trim();
        if (!text) {
            const fallback = String(this.chatNameInputEl.dataset?.defaultName || '').trim();
            this.chatNameInputEl.value = fallback;
            this.chatNameInputEl.classList.toggle('is-placeholder', Boolean(fallback));
        } else {
            this.chatNameInputEl.classList.remove('is-placeholder');
        }
    }

    submitChatNameModal() {
        if (!this.chatNameInputEl) return;
        const isPlaceholder = this.chatNameInputEl.classList.contains('is-placeholder');
        const raw = String(this.chatNameInputEl.value || '').trim();
        const fallback = String(this.chatNameInputEl.dataset?.defaultName || '').trim();
        const value = (isPlaceholder || !raw) ? fallback : raw;
        this.closeChatNameModal(value);
    }

    closeChatNameModal(value) {
        if (this.chatNameOverlay) this.chatNameOverlay.style.display = 'none';
        if (this.chatNameModal) this.chatNameModal.style.display = 'none';
        if (this.chatNameKeyHandler) {
            document.removeEventListener('keydown', this.chatNameKeyHandler);
            this.chatNameKeyHandler = null;
        }
        if (this.chatNameResolve) {
            const resolve = this.chatNameResolve;
            this.chatNameResolve = null;
            resolve(String(value || ''));
        }
    }

    createManageModal() {
        if (this.manageModal) return;
        this.manageOverlay = document.createElement('div');
        this.manageOverlay.className = 'world-manage-overlay';
        this.manageOverlay.style.display = 'none';
        this.manageOverlay.addEventListener('click', () => this.hideManageModal());

        this.manageModal = document.createElement('div');
        this.manageModal.className = 'world-manage-modal';
        this.manageModal.style.display = 'none';
        this.manageModal.innerHTML = `
            <div class="world-manage-header">
                <div>
                    <div class="world-manage-title">条目管理</div>
                    <div class="world-manage-subtitle">批量操作、创建聊天室、删除与移动</div>
                </div>
                <button type="button" class="world-manage-close" aria-label="关闭">×</button>
            </div>
            <div class="world-manage-body">
                <div class="world-manage-toolbar">
                    <div class="world-manage-label">条目列表</div>
                    <div id="world-manage-count" class="world-manage-count">已选 0</div>
                    <div class="world-manage-actions">
                        <button type="button" class="world-manage-link" id="world-manage-selectall">全选</button>
                        <button type="button" class="world-manage-link" id="world-manage-clear">清空</button>
                        <span class="world-manage-sep"></span>
                        <button type="button" class="world-manage-link" id="world-manage-create-selected">创建聊天室</button>
                        <span class="world-manage-sep"></span>
                        <button type="button" class="world-manage-icon" id="world-manage-move-top" aria-label="置顶">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M5 4h14v2H5z"></path>
                                <path d="M12 7l-5 5h3v6h4v-6h3z"></path>
                            </svg>
                        </button>
                        <button type="button" class="world-manage-icon" id="world-manage-move-up" aria-label="上移">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6l-6 6h4v6h4v-6h4z"></path></svg>
                        </button>
                        <button type="button" class="world-manage-icon" id="world-manage-move-down" aria-label="下移">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18l6-6h-4V6h-4v6H6z"></path></svg>
                        </button>
                        <button type="button" class="world-manage-icon" id="world-manage-move-bottom" aria-label="置底">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M5 18h14v2H5z"></path>
                                <path d="M12 17l5-5h-3V6h-4v6H7z"></path>
                            </svg>
                        </button>
                        <button type="button" class="world-manage-link danger" id="world-manage-delete">删除</button>
                    </div>
                </div>
                <div id="world-manage-list" class="world-manage-list"></div>
            </div>
            <div class="world-manage-footer">
                <button type="button" class="world-manage-btn primary" id="world-manage-close-btn">完成</button>
            </div>
        `;
        this.manageModal.addEventListener('click', (e) => e.stopPropagation());
        this.manageModal.querySelector('.world-manage-close')?.addEventListener('click', () => this.hideManageModal());
        this.manageModal.querySelector('#world-manage-close-btn')?.addEventListener('click', () => this.hideManageModal());

        this.manageCountEl = this.manageModal.querySelector('#world-manage-count');
        this.manageSelectAllBtn = this.manageModal.querySelector('#world-manage-selectall');
        this.manageClearBtn = this.manageModal.querySelector('#world-manage-clear');
        this.manageCreateSelectedBtn = this.manageModal.querySelector('#world-manage-create-selected');
        this.manageDeleteBtn = this.manageModal.querySelector('#world-manage-delete');
        this.manageMoveUpBtn = this.manageModal.querySelector('#world-manage-move-up');
        this.manageMoveDownBtn = this.manageModal.querySelector('#world-manage-move-down');
        this.manageMoveTopBtn = this.manageModal.querySelector('#world-manage-move-top');
        this.manageMoveBottomBtn = this.manageModal.querySelector('#world-manage-move-bottom');
        this.manageListEl = this.manageModal.querySelector('#world-manage-list');

        this.manageSelectAllBtn?.addEventListener('click', () => {
            this.selectAllEntries();
        });
        this.manageClearBtn?.addEventListener('click', () => this.clearSelection());
        this.manageCreateSelectedBtn?.addEventListener('click', () => this.createChatFromSelection());
        this.manageDeleteBtn?.addEventListener('click', () => this.deleteSelectedEntries());
        this.manageMoveUpBtn?.addEventListener('click', () => this.moveSelectedEntries(-1));
        this.manageMoveDownBtn?.addEventListener('click', () => this.moveSelectedEntries(1));
        this.manageMoveTopBtn?.addEventListener('click', () => this.moveSelectedToEdge('top'));
        this.manageMoveBottomBtn?.addEventListener('click', () => this.moveSelectedToEdge('bottom'));

        document.body.appendChild(this.manageOverlay);
        document.body.appendChild(this.manageModal);
    }

    showManageModal() {
        if (!this.manageModal) this.createManageModal();
        this.updateManageState();
        if (this.manageOverlay) this.manageOverlay.style.display = 'block';
        if (this.manageModal) this.manageModal.style.display = 'block';
    }

    hideManageModal() {
        if (this.manageOverlay) this.manageOverlay.style.display = 'none';
        if (this.manageModal) this.manageModal.style.display = 'none';
    }

    traceAi(stage, payload = {}, level = 'info') {
        const seq = ++this.aiTraceSeq;
        const eventName = String(stage || 'event').trim() || 'event';
        const details = Object.entries(payload && typeof payload === 'object' ? payload : {})
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${formatTraceValue(value)}`)
            .join(' ');
        const message = `[WORLD_AI_TRACE#${seq}] ${eventName}${details ? ` ${details}` : ''}`;
        if (level === 'error') {
            logger.error(message);
        } else if (level === 'warn') {
            logger.warn(message);
        } else {
            logger.info(message);
        }
    }

    isAiTraceWatchActive() {
        return Date.now() <= Number(this.aiTraceWatchUntil || 0);
    }

    beginAiTraceWatch({ entryId = '', blockId = '', requestId = 0, reason = '' } = {}) {
        const now = Date.now();
        const watchUntil = now + AI_TRACE_WATCH_MS;
        this.aiTraceWatchUntil = watchUntil;
        this.aiLastWriteMeta = {
            entryId: String(entryId || '').trim(),
            blockId: String(blockId || '').trim(),
            requestId: Number.isFinite(Number(requestId)) ? Number(requestId) : 0,
            reason: String(reason || '').trim(),
            startedAt: now,
        };
        this.traceAi('watch.start', {
            entryId: this.aiLastWriteMeta.entryId,
            blockId: this.aiLastWriteMeta.blockId,
            requestId: this.aiLastWriteMeta.requestId,
            reason: this.aiLastWriteMeta.reason,
            watchUntil,
        });
    }

    setAiStatus(message, tone = '') {
        if (!this.aiStatusEl) return;
        this.aiStatusEl.textContent = message || '';
        if (tone) {
            this.aiStatusEl.setAttribute('data-tone', tone);
        } else {
            this.aiStatusEl.removeAttribute('data-tone');
        }
    }

    setAiBusy(isBusy, entryId = '') {
        const prevBusy = this.aiBusy;
        const prevPendingEntryId = String(this.aiPendingEntryId || '').trim();
        this.aiBusy = Boolean(isBusy);
        if (this.aiGenerateBtn) this.aiGenerateBtn.disabled = this.aiBusy;
        if (this.aiContinueBtn) this.aiContinueBtn.disabled = this.aiBusy;
        if (this.aiWebSearchToggleEl) this.aiWebSearchToggleEl.disabled = this.aiBusy;
        if (this.aiBusy && entryId) {
            this.aiPendingEntryId = String(entryId);
        } else if (!this.aiBusy) {
            this.aiPendingEntryId = '';
        }
        this.traceAi('busy.set', {
            prevBusy,
            nextBusy: this.aiBusy,
            requestEntryId: entryId,
            prevPendingEntryId,
            nextPendingEntryId: this.aiPendingEntryId,
            targetEntryId: this.aiTargetEntryId,
            targetBlockId: this.aiTargetBlockId,
        });
        this.renderEditor();
    }

    async ensureChatConfigReady() {
        // 每次都重新读取：load() 会缓存首次结果，切换 API 模型档后仍会沿用旧档（曾导致选了 OpenRouter 却在调用 Gemini）
        const config = await this.chatConfigManager.reload();
        if (!canUseApiConfig(config)) {
            window.toastr?.warning?.('请先配置聊天模型 API');
            return null;
        }
        return config;
    }

    resolveEntryById(entryId) {
        const targetId = String(entryId ?? '').trim();
        if (!targetId) {
            this.traceAi('entry.resolve.skip-empty', { entryId });
            return { idx: -1, entry: null };
        }
        const idx = this.data.entries.findIndex((entry, entryIdx) => {
            const localId = this.getEntryId(entry, entryIdx);
            const refId = String(entry?._refEntryId ?? '').trim();
            return localId === targetId || refId === targetId;
        });
        if (idx < 0) {
            this.traceAi('entry.resolve.miss', {
                entryId: targetId,
                total: this.data.entries.length,
            }, 'warn');
            return { idx: -1, entry: null };
        }
        if (this.isAiTraceWatchActive()) {
            this.traceAi('entry.resolve.hit', {
                entryId: targetId,
                idx,
                currentIndex: this.currentIndex,
            });
        }
        return { idx, entry: this.data.entries[idx] };
    }

    getEntryContentForAi(entryId, blockId = '') {
        const { idx, entry } = this.resolveEntryById(entryId);
        if (!entry || idx < 0) return '';
        const blocks = this.ensureEntryPromptBlocks(entry);
        const targetBlockId = String(blockId || '').trim();
        const currentEntryId = this.getEntryId(entry, idx);
        const currentBlockPage = this.getEntryBlockPage(entry, currentEntryId);
        const currentVisibleBlock = blocks[currentBlockPage] || blocks[0] || null;
        const targetBlock = targetBlockId
            ? (blocks.find(block => String(block?.id || '').trim() === targetBlockId) || currentVisibleBlock)
            : currentVisibleBlock;
        const targetIsVisible = !targetBlockId || String(currentVisibleBlock?.id || '').trim() === targetBlockId;
        let source = 'block';
        if (this.currentIndex === idx && targetIsVisible) {
            const textarea = this.editorEl?.querySelector('#we-block-content');
            const live = String(textarea?.value || '').trim();
            if (live) {
                source = 'textarea';
                const summary = summarizeTraceText(live);
                this.traceAi('draft.read', {
                    entryId,
                    targetBlockId,
                    resolvedBlockId: String(targetBlock?.id || '').trim(),
                    visibleBlockId: String(currentVisibleBlock?.id || '').trim(),
                    source,
                    summary,
                });
                return live;
            }
        }
        const content = String(targetBlock?.content ?? entry.content ?? '').trim();
        this.traceAi('draft.read', {
            entryId,
            targetBlockId,
            resolvedBlockId: String(targetBlock?.id || '').trim(),
            visibleBlockId: String(currentVisibleBlock?.id || '').trim(),
            source,
            summary: summarizeTraceText(content),
        });
        return content;
    }

    applyAiContentToEntry(entryId, content, blockId = '') {
        const { idx, entry } = this.resolveEntryById(entryId);
        if (idx < 0) {
            window.toastr?.warning?.('目标条目不存在，未写入内容');
            this.traceAi('write.apply.miss-entry', { entryId, blockId }, 'warn');
            return false;
        }
        const blocks = this.ensureEntryPromptBlocks(entry);
        const targetBlockId = String(blockId || '').trim();
        const normalizedContent = String(content ?? '');
        const currentEntryId = this.getEntryId(entry, idx);
        const currentBlockPage = this.getEntryBlockPage(entry, currentEntryId);
        const currentVisibleBlock = blocks[currentBlockPage] || blocks[0] || null;
        const foundIndex = targetBlockId
            ? blocks.findIndex(block => String(block?.id || '').trim() === targetBlockId)
            : currentBlockPage;
        const resolvedIndex = foundIndex >= 0 ? foundIndex : (currentBlockPage >= 0 ? currentBlockPage : 0);
        const targetBlock = blocks[resolvedIndex] || blocks[0] || null;
        const beforeContent = String(targetBlock?.content ?? entry.content ?? '');
        if (targetBlock) {
            targetBlock.content = normalizedContent;
        } else {
            entry.content = normalizedContent;
        }

        // Keep canonical entry.promptBlocks in sync with the resolved target block write.
        const entryBlocks = Array.isArray(entry.promptBlocks) ? entry.promptBlocks : [];
        let canonicalTargetBlock = null;
        if (targetBlockId) {
            canonicalTargetBlock = entryBlocks.find(block => String(block?.id || '').trim() === targetBlockId) || null;
        }
        if (!canonicalTargetBlock) {
            canonicalTargetBlock = entryBlocks[resolvedIndex] || entryBlocks[0] || null;
        }
        if (canonicalTargetBlock) {
            canonicalTargetBlock.content = normalizedContent;
        }

        this.syncEntryContentFromBlocks(entry);

        const verifiedTarget = targetBlockId
            ? (entryBlocks.find(block => String(block?.id || '').trim() === targetBlockId) || canonicalTargetBlock)
            : canonicalTargetBlock;
        const verifiedContent = String(verifiedTarget?.content ?? '');
        if (verifiedTarget && verifiedContent !== normalizedContent) {
            this.traceAi('write.verify.mismatch', {
                entryId,
                targetBlockId,
                resolvedIndex,
                expected: summarizeTraceText(normalizedContent),
                actual: summarizeTraceText(verifiedContent),
            }, 'warn');
            verifiedTarget.content = normalizedContent;
            this.syncEntryContentFromBlocks(entry);
        }

        const targetIsVisible = !targetBlockId || String(currentVisibleBlock?.id || '').trim() === targetBlockId;
        if (this.currentIndex === idx && targetIsVisible) {
            const textarea = this.editorEl?.querySelector('#we-block-content');
            if (textarea) textarea.value = normalizedContent;
        }
        const resolvedBlockId = String(targetBlock?.id || '').trim();
        this.traceAi('write.apply', {
            entryId,
            targetBlockId,
            resolvedBlockId,
            resolvedIndex,
            blockCount: blocks.length,
            currentVisibleBlockId: String(currentVisibleBlock?.id || '').trim(),
            targetIsVisible,
            before: summarizeTraceText(beforeContent),
            after: summarizeTraceText(normalizedContent),
            canonicalBlock: summarizeTraceText(String(verifiedTarget?.content ?? '')),
            entryContent: summarizeTraceText(String(entry.content || '')),
            currentIndex: this.currentIndex,
            targetIndex: idx,
        });
        this.renderList();
        this.scheduleRefSync();
        return true;
    }

    async runWorldAi({ mode = 'generate' } = {}) {
        if (this.aiBusy) {
            window.toastr?.warning?.('AI 生成中，请稍后');
            this.traceAi('run.rejected.busy', {
                mode,
                pendingEntryId: this.aiPendingEntryId,
                targetEntryId: this.aiTargetEntryId,
                targetBlockId: this.aiTargetBlockId,
            }, 'warn');
            return;
        }
        const inputText = String(this.aiInputEl?.value || '').trim();
        if (!inputText) {
            window.toastr?.warning?.('请先输入人物设定');
            this.traceAi('run.rejected.no-input', { mode }, 'warn');
            return;
        }
        if (this.aiConfigPending) {
            this.traceAi('run.rejected.config-pending', { mode }, 'warn');
            return;
        }
        // 双击防护：config 加载 await 期间 aiBusy 尚未上锁，用独立闩挡住重入
        this.aiConfigPending = true;
        let config = null;
        try {
            config = await this.ensureChatConfigReady();
        } finally {
            this.aiConfigPending = false;
        }
        if (!config) {
            this.traceAi('run.rejected.no-config', { mode }, 'warn');
            return;
        }
        if (this.aiBusy) {
            this.traceAi('run.rejected.busy', { mode, phase: 'post-config' }, 'warn');
            return;
        }
        const currentEntry = this.data.entries[this.currentIndex] || null;
        const entryId = String(
            this.aiTargetEntryId || this.getEntryId(currentEntry, this.currentIndex) || '',
        ).trim();
        const blockId = String(this.aiTargetBlockId || '').trim();
        if (!entryId) {
            window.toastr?.warning?.('未找到可写入的条目');
            this.traceAi('run.rejected.no-entry', {
                mode,
                currentIndex: this.currentIndex,
                targetEntryId: this.aiTargetEntryId,
                targetBlockId: blockId,
            }, 'warn');
            return;
        }
        const template = String(this.aiTemplateEl?.value || WORLD_AI_TEMPLATE || '').trim();
        if (!template) {
            window.toastr?.warning?.('模板不能为空');
            this.traceAi('run.rejected.no-template', { mode, entryId, blockId }, 'warn');
            return;
        }
        const draft = this.getEntryContentForAi(entryId, blockId);
        if (mode === 'continue' && !draft) {
            window.toastr?.warning?.('当前内容为空，无法继续');
            this.traceAi('run.rejected.empty-draft', {
                mode,
                entryId,
                blockId,
            }, 'warn');
            return;
        }
        const requestId = ++this.aiRequestId;
        this.traceAi('run.start', {
            requestId,
            mode,
            entryId,
            blockId,
            currentIndex: this.currentIndex,
            pendingEntryId: this.aiPendingEntryId,
            targetEntryId: this.aiTargetEntryId,
            targetBlockId: this.aiTargetBlockId,
            inputSummary: summarizeTraceText(inputText),
            templateSummary: summarizeTraceText(template),
            draftSummary: summarizeTraceText(draft),
        });
        this.setAiBusy(true, entryId);
        const loadingText = mode === 'continue' ? '正在继续补全角色条目...' : '正在生成角色条目...';
        this.setAiStatus(loadingText, 'loading');
        try {
            const client = new LLMClient(config);
            const useWebSearch = await this.aiWebSearchToggleRuntime?.consume() === true;
            renderAdHocWebSources(this.aiWebSourcesEl, []);
            try { this.aiAbortController?.abort(); } catch {}
            const abortController = new AbortController();
            this.aiAbortController = abortController;
            const messages = mode === 'continue'
                ? buildWorldAiContinueMessages(template, inputText, draft)
                : buildWorldAiMessages(template, inputText);
            this.traceAi('run.request', {
                requestId,
                mode,
                model: describeAdHocModel(config),
                webSearch: useWebSearch,
                messageCount: messages.length,
                firstMessageSummary: summarizeTraceText(messages?.[0]?.content || ''),
            });
            // 原生联网失败时依次改用搜索服务、不联网生成，不让整次生成失败
            const { output, route, degraded } = await runAdHocWebSearchChat({
                client,
                config,
                enabled: useWebSearch,
                sessionId: `world-ai:${this.worldName || 'editor'}`,
                requestOptions: { temperature: 0.6, signal: abortController.signal },
                messages,
                onStatus: status => {
                    if (requestId !== this.aiRequestId) return;
                    this.setAiStatus(
                        status?.state === 'unavailable'
                            ? `${status?.message || '本次联网不可用'}；继续普通生成…`
                            : (status?.message || ''),
                        'loading',
                    );
                },
                onSources: sources => {
                    if (requestId !== this.aiRequestId) return;
                    renderAdHocWebSources(this.aiWebSourcesEl, sources);
                },
            });
            this.traceAi('run.response', {
                requestId,
                mode,
                webSearchRoute: route,
                webSearchDegraded: degraded,
                outputSummary: summarizeTraceText(output),
            });
            if (requestId !== this.aiRequestId) {
                this.traceAi('run.response.stale', {
                    requestId,
                    activeRequestId: this.aiRequestId,
                }, 'warn');
                return;
            }
            const yaml = stripCodeFence(output);
            if (!yaml) throw new Error('AI 未返回内容');
            this.traceAi('run.response.yaml', {
                requestId,
                yamlSummary: summarizeTraceText(yaml),
            });
            const applied = this.applyAiContentToEntry(entryId, yaml, blockId);
            if (!applied) {
                this.setAiStatus('生成成功，但未找到条目写入', 'error');
                this.traceAi('run.write.failed', {
                    requestId,
                    entryId,
                    blockId,
                }, 'warn');
                return;
            }
            this.beginAiTraceWatch({
                entryId,
                blockId,
                requestId,
                reason: mode === 'continue' ? 'continue-apply' : 'generate-apply',
            });
            this.traceAi('run.write.success', {
                requestId,
                entryId,
                blockId,
                appliedSummary: summarizeTraceText(yaml),
            });
            const saved = await this.saveWorldSilently({ showToast: false });
            this.traceAi('run.save.result', {
                requestId,
                saved,
                worldName: this.worldName,
            }, saved ? 'info' : 'warn');
            if (saved) {
                const fallbackRoute = useWebSearch && degraded ? route : '';
                const successText = mode === 'continue'
                    ? ({
                        tool: '补全完成，已写入内容并保存（原生联网失败，已改用搜索服务）',
                        none: '补全完成，已写入内容并保存（联网失败，本次未联网）',
                    }[fallbackRoute] || '补全完成，已写入内容并保存')
                    : ({
                        tool: '生成完成，已写入内容并保存（原生联网失败，已改用搜索服务）',
                        none: '生成完成，已写入内容并保存（联网失败，本次未联网）',
                    }[fallbackRoute] || '生成完成，已写入内容并保存');
                this.setAiStatus(successText, 'success');
                window.toastr?.success?.(mode === 'continue' ? 'AI 补全已写入并保存' : 'AI 生成已写入并保存');
            } else {
                this.setAiStatus('生成完成，但自动保存失败', 'error');
                window.toastr?.warning?.(mode === 'continue' ? 'AI 已补全，但自动保存失败' : 'AI 已生成，但自动保存失败');
            }
        } catch (err) {
            if (err?.name === 'AbortError') {
                this.traceAi('run.aborted', { requestId, mode }, 'warn');
                if (requestId === this.aiRequestId) this.setAiStatus('已停止本次生成', '');
                return;
            }
            logger.error(mode === 'continue' ? 'AI 补全世界书失败' : 'AI 生成世界书失败', err);
            const modelLabel = describeAdHocModel(config);
            this.traceAi('run.error', {
                requestId,
                mode,
                model: modelLabel,
                message: err?.message || 'unknown',
            }, 'error');
            const errorMessage = err?.message || '未知错误';
            this.setAiStatus(modelLabel ? `生成失败（${modelLabel}）：${errorMessage}` : `生成失败：${errorMessage}`, 'error');
            window.toastr?.error?.(mode === 'continue' ? 'AI 补全失败' : 'AI 生成失败');
        } finally {
            if (requestId === this.aiRequestId) {
                this.setAiBusy(false);
                this.traceAi('run.finish', {
                    requestId,
                    mode,
                    activeRequestId: this.aiRequestId,
                    pendingEntryId: this.aiPendingEntryId,
                });
            } else {
                this.traceAi('run.finish.stale', {
                    requestId,
                    activeRequestId: this.aiRequestId,
                }, 'warn');
            }
        }
    }

    async handleAiGenerate() {
        return this.runWorldAi({ mode: 'generate' });
    }

    async handleAiContinue() {
        return this.runWorldAi({ mode: 'continue' });
    }

    getEntryId(entry, idx = 0) {
        const raw = entry && typeof entry === 'object' ? entry : {};
        const id = raw.id ?? raw.uid ?? `entry-${idx}`;
        return String(id ?? '').trim();
    }

    getEntryDisplayName(entry, idx = 0) {
        const raw = entry && typeof entry === 'object' ? entry : {};
        const title = String(raw.comment || raw.title || '').trim();
        return title || `条目 ${idx + 1}`;
    }

    ensureEntryPromptBlocks(entry) {
        if (!entry || typeof entry !== 'object') return [];
        if (!Array.isArray(entry.promptBlocks)) entry.promptBlocks = [];
        if (!entry.promptBlocks.length) {
            entry.promptBlocks = [normalizePromptBlock({
                content: String(entry.content || ''),
                title: String(entry.comment || '内容 1'),
            }, 0, String(entry.content || ''))];
            return entry.promptBlocks;
        }

        // Preserve block object identity. Replacing block objects on every normalize
        // can stale existing closures (e.g. node editor save handlers) and cause writes
        // to land on detached block instances.
        const blocks = entry.promptBlocks;
        for (let idx = 0; idx < blocks.length; idx += 1) {
            const raw = blocks[idx];
            const normalized = normalizePromptBlock(raw, idx, idx === 0 ? entry.content : '');
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                Object.keys(raw).forEach((key) => {
                    if (!Object.prototype.hasOwnProperty.call(normalized, key)) delete raw[key];
                });
                Object.assign(raw, normalized);
                blocks[idx] = raw;
            } else {
                blocks[idx] = normalized;
            }
        }
        return blocks;
    }

    getEntryBlockPage(entry, entryId = '') {
        const blocks = this.ensureEntryPromptBlocks(entry);
        const key = String(entryId || this.getEntryId(entry) || '').trim();
        const raw = Number(this.entryBlockPageMap.get(key) || 0);
        const page = Number.isFinite(raw) ? Math.max(0, Math.min(blocks.length - 1, Math.trunc(raw))) : 0;
        this.entryBlockPageMap.set(key, page);
        return page;
    }

    setEntryBlockPage(entry, entryId = '', page = 0) {
        const blocks = this.ensureEntryPromptBlocks(entry);
        const key = String(entryId || this.getEntryId(entry) || '').trim();
        const next = Math.max(0, Math.min(blocks.length - 1, Math.trunc(Number(page) || 0)));
        this.entryBlockPageMap.set(key, next);
        this.renderEditor();
    }

    isBlockFlipped(blockId = '') {
        return this.blockFlipMap.get(String(blockId || '').trim()) === true;
    }

    setBlockFlipped(blockId = '', flipped = false) {
        const id = String(blockId || '').trim();
        if (!id) return;
        const next = Boolean(flipped);
        this.blockFlipMap.set(id, next);
        if (next) this.blockBackViewMap.set(id, 'summary');
        this.renderEditor();
    }

    isBlockExpanded(blockId = '') {
        return this.blockExpandMap.get(String(blockId || '').trim()) === true;
    }

    setBlockExpanded(blockId = '', expanded = false) {
        const id = String(blockId || '').trim();
        if (!id) return;
        const next = Boolean(expanded);
        if (this.blockCollapseTimer) {
            clearTimeout(this.blockCollapseTimer);
            this.blockCollapseTimer = null;
        }
        if (!next && this.blockExpandMap.get(id) === true && !isWorldMotionReduced()) {
            const shell = this.editorEl?.querySelector?.('#we-block-shell.is-expanded');
            const overlay = this.editorEl?.querySelector?.('#we-block-overlay.show');
            if (shell) {
                shell.classList.add('is-closing');
                overlay?.classList.add('is-closing');
                this.blockCollapseTimer = setTimeout(() => {
                    this.blockCollapseTimer = null;
                    this.blockExpandMap.set(id, false);
                    this.blockFlipMap.set(id, false);
                    this.blockBackViewMap.set(id, 'summary');
                    this.renderEditor();
                }, 220);
                return;
            }
        }
        if (next && this.blockExpandMap.get(id) !== true) {
            // 浮起后卡片脱离文档流；先量下方高度（取小数避免整数取整造成 1px 跳动），
            // 渲染时用等高占位符防止“基础触发设置”上跳。
            const shell = this.editorEl?.querySelector?.('#we-block-shell:not(.is-expanded)');
            const height = Number(shell?.getBoundingClientRect?.().height) || 0;
            if (height > 0) this.blockShellPlaceholderHeight = height;
        }
        this.blockExpandMap.set(id, next);
        if (next) this.blockExpandMotionPending = id;
        if (!next) {
            this.blockFlipMap.set(id, false);
            this.blockBackViewMap.set(id, 'summary');
        }
        this.renderEditor();
    }

    getBlockBackView(blockId = '') {
        const id = String(blockId || '').trim();
        if (!id) return 'summary';
        return this.blockBackViewMap.get(id) === 'editor' ? 'editor' : 'summary';
    }

    setBlockBackView(blockId = '', view = 'summary') {
        const id = String(blockId || '').trim();
        if (!id) return;
        const next = String(view || '').trim().toLowerCase() === 'editor' ? 'editor' : 'summary';
        this.blockBackViewMap.set(id, next);
        this.renderEditor();
    }

    setBlockEditorFocus(blockId = '', focusState = null) {
        const id = String(blockId || '').trim();
        if (!id) return;
        if (!focusState || typeof focusState !== 'object') {
            this.blockEditorFocusMap.delete(id);
            return;
        }
        const normalizedNodeIds = Array.isArray(focusState.nodeIds)
            ? focusState.nodeIds.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        const next = {
            nodeIds: [...new Set(normalizedNodeIds)],
        };
        if (!next.nodeIds.length) {
            this.blockEditorFocusMap.delete(id);
            return;
        }
        this.blockEditorFocusMap.set(id, next);
    }

    consumeBlockEditorFocus(blockId = '') {
        const id = String(blockId || '').trim();
        if (!id) return null;
        const focus = this.blockEditorFocusMap.get(id) || null;
        this.blockEditorFocusMap.delete(id);
        return focus;
    }

    openBlockConditionEditor(blockId = '', focusState = null) {
        const id = String(blockId || '').trim();
        if (!id) return;
        this.setBlockEditorFocus(id, focusState);
        this.blockBackViewMap.set(id, 'editor');
        this.requestVariableGuide();
        this.renderEditor();
    }

    openBlockNodeEditor(blockId = '', nodeIds = []) {
        const id = String(blockId || '').trim();
        if (!id) return [];
        const normalizedNodeIds = [...new Set(
            (Array.isArray(nodeIds) ? nodeIds : [nodeIds])
                .map(item => String(item || '').trim())
                .filter(Boolean),
        )];
        this.openBlockConditionEditor(
            id,
            normalizedNodeIds.length ? { nodeIds: normalizedNodeIds } : null,
        );
        return normalizedNodeIds;
    }

    async saveBlockConditionEditor(blockId = '', block = null) {
        const id = String(blockId || '').trim();
        if (!id) return;
        if (block && typeof block === 'object') {
            this.syncBlockWhenFromNodeGraph(block);
        }
        const saved = await this.saveWorldSilently({ showToast: true });
        if (saved) {
            this.blockBackViewMap.set(id, 'summary');
        }
        this.renderEditor();
    }

    syncEntryContentFromBlocks(entry) {
        if (!entry || typeof entry !== 'object') return;
        const blocks = Array.isArray(entry.promptBlocks) && entry.promptBlocks.length
            ? entry.promptBlocks
            : this.ensureEntryPromptBlocks(entry);
        const first = blocks[0];
        entry.content = String(first?.content || '').trim();
        this.entrySearchCache?.delete?.(entry);
    }

    addPromptBlock(entry) {
        if (!entry || typeof entry !== 'object') return;
        const blocks = this.ensureEntryPromptBlocks(entry);
        const entryId = this.getEntryId(entry);
        const next = normalizePromptBlock({
            title: `内容 ${blocks.length + 1}`,
            content: '',
        }, blocks.length, '');
        blocks.push(next);
        if (entryId) this.entryBlockPageMap.set(String(entryId), Math.max(0, blocks.length - 1));
        this.syncEntryContentFromBlocks(entry);
        this.renderEditor();
        this.renderBlockManageModalList();
        if (this.refMode) this.scheduleRefSync();
    }

    removePromptBlock(entry, blockIndex = 0) {
        if (!entry || typeof entry !== 'object') return;
        const blocks = this.ensureEntryPromptBlocks(entry);
        if (blocks.length <= 1) {
            window.toastr?.warning?.('至少保留一页内容');
            return;
        }
        const removeAt = Math.max(0, Math.min(blocks.length - 1, Math.trunc(Number(blockIndex) || 0)));
        const removed = blocks[removeAt];
        const removedId = String(removed?.id || '').trim();
        blocks.splice(removeAt, 1);
        if (removedId) {
            this.blockFlipMap.delete(removedId);
            this.blockExpandMap.delete(removedId);
        }
        const entryId = this.getEntryId(entry);
        if (entryId) {
            const current = this.getEntryBlockPage(entry, entryId);
            const next = Math.max(0, Math.min(blocks.length - 1, current >= removeAt ? current - 1 : current));
            this.entryBlockPageMap.set(String(entryId), next);
        }
        this.syncEntryContentFromBlocks(entry);
        this.renderEditor();
        this.renderBlockManageModalList();
        if (this.refMode) this.scheduleRefSync();
    }

    movePromptBlock(entry, fromIndex, toIndex) {
        if (!entry || typeof entry !== 'object') return;
        const blocks = this.ensureEntryPromptBlocks(entry);
        const from = Math.trunc(Number(fromIndex));
        const to = Math.trunc(Number(toIndex));
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length || from === to) return;
        const [moved] = blocks.splice(from, 1);
        blocks.splice(to, 0, moved);
        const entryId = this.getEntryId(entry);
        if (entryId) this.entryBlockPageMap.set(String(entryId), to);
        this.syncEntryContentFromBlocks(entry);
        this.renderEditor();
        this.renderBlockManageModalList();
        if (this.refMode) this.scheduleRefSync();
    }

    ensureBlockPrimaryClause(block) {
        if (!block || typeof block !== 'object') return normalizePromptClause({});
        block.when = normalizeConditionTree(block.when, createDefaultPromptClause());
        return getPrimaryClauseFromConditionTree(block.when, createDefaultPromptClause());
    }

    ensureBlockConditionTree(block) {
        if (!block || typeof block !== 'object') return normalizeConditionTree(null, createDefaultPromptClause());
        block.when = normalizeConditionTree(block.when, createDefaultPromptClause());
        return block.when;
    }

    ensureBlockNodeGraph(block) {
        if (!block || typeof block !== 'object') return null;
        const primaryClause = this.ensureBlockPrimaryClause(block);
        block.nodeGraph = normalizeNodeGraph(block.nodeGraph, block.when, primaryClause);
        return block.nodeGraph;
    }

    syncBlockWhenFromNodeGraph(block, graph = null) {
        if (!block || typeof block !== 'object') return null;
        const primaryClause = this.ensureBlockPrimaryClause(block);
        const nodeGraph = graph || this.ensureBlockNodeGraph(block);
        if (!nodeGraph) return block.when;
        block.when = buildWhenFromNodeGraph(nodeGraph, primaryClause);
        if (!block.when || typeof block.when !== 'object') {
            block.when = { logic: 'and', clauses: [normalizePromptClause(primaryClause)] };
        }
        const logic = normalizeLogicValue(block.when.logic || 'and');
        if (logic === 'not') {
            const child = block.when.clause && typeof block.when.clause === 'object'
                ? block.when.clause
                : (Array.isArray(block.when.clauses) ? block.when.clauses[0] : null);
            block.when.logic = 'not';
            block.when.clause = child?.logic ? child : normalizePromptClause(child || primaryClause);
            delete block.when.clauses;
            return block.when;
        }
        const clauses = Array.isArray(block.when.clauses) ? block.when.clauses : [];
        block.when.logic = logic;
        block.when.clauses = clauses.length
            ? clauses.map(item => (item?.logic ? item : normalizePromptClause(item)))
            : [normalizePromptClause(primaryClause)];
        delete block.when.clause;
        return block.when;
    }

    syncBlockNodeGraphFromWhen(block) {
        if (!block || typeof block !== 'object') return null;
        const primaryClause = this.ensureBlockPrimaryClause(block);
        block.nodeGraph = normalizeNodeGraph(null, block.when, primaryClause);
        return block.nodeGraph;
    }

    getConditionSummaryOperator(op = '>') {
        return getConditionSummaryOperatorImpl.call(this, op);
    }

    getConditionSummaryValueText(value, rightType = 'number') {
        return getConditionSummaryValueTextImpl.call(this, value, rightType, {
            normalizeRightTypeValue,
            parseTypedValue,
            stringifyTypedValue,
        });
    }

    getConditionRuntimeContext() {
        return getConditionRuntimeContextImpl.call(this, {
            buildVariableContext,
        });
    }

    formatConditionRuntimeValue(value, rightType = 'string') {
        return formatConditionRuntimeValueImpl.call(this, value, rightType);
    }

    getConditionExplanationReason(clauseRaw, explanation = null) {
        return getConditionExplanationReasonImpl.call(this, clauseRaw, explanation, {
            normalizePromptClause,
        });
    }

    getConditionGroupExplanationReason(logicRaw = 'and', explanation = null) {
        return getConditionGroupExplanationReasonImpl.call(this, logicRaw, explanation, {
            normalizeLogicValue,
        });
    }

    getEntryActivationExplanation(entry, idx = this.currentIndex) {
        return getEntryActivationExplanationImpl.call(this, entry, idx, {
            logger,
        });
    }

    hasConfiguredVariableInBlock(block) {
        if (!block || typeof block !== 'object') return false;
        const graphNodes = Array.isArray(block?.nodeGraph?.nodes) ? block.nodeGraph.nodes : [];
        const hasGraphVariable = graphNodes.some((node) => {
            if (normalizeNodeType(node?.type) !== 'variable') return false;
            return Boolean(String(node?.data?.path || '').trim());
        });
        if (hasGraphVariable) return true;
        const tree = normalizeConditionTree(block.when, createDefaultPromptClause());
        let found = false;
        visitConditionTree(tree, (node) => {
            if (found || isConditionTreeGroup(node)) return;
            const clause = normalizePromptClause(node);
            const left = String(clause?.left || '').trim();
            const rightType = String(clause?.rightType || '').trim().toLowerCase();
            const right = String(clause?.right || '').trim();
            if (left) {
                found = true;
                return;
            }
            if (rightType === 'variable' && right) {
                found = true;
            }
        });
        return found;
    }

    getEntryVariableStatus(entry, idx = this.currentIndex, { includeActivation = true, blocks = null } = {}) {
        if (!entry || typeof entry !== 'object') {
            return {
                hasVariable: false,
                isActive: false,
            };
        }
        const resolvedBlocks = Array.isArray(blocks) && blocks.length
            ? blocks
            : (Array.isArray(entry.promptBlocks) && entry.promptBlocks.length
                ? entry.promptBlocks
                : this.ensureEntryPromptBlocks(entry));
        const hasVariable = this.hasConfiguredVariableInBlock(entry)
            || resolvedBlocks.some(block => this.hasConfiguredVariableInBlock(block));
        if (!hasVariable) {
            return {
                hasVariable: false,
                isActive: false,
            };
        }
        if (!includeActivation || entry.disable) {
            return {
                hasVariable: true,
                isActive: false,
            };
        }
        const explanation = this.getEntryActivationExplanation(entry, idx);
        return {
            hasVariable: true,
            isActive: Boolean(explanation?.active),
        };
    }

    getBlockVariableStatus(entry, block, idx = this.currentIndex, { includeActivation = true } = {}) {
        if (!entry || typeof entry !== 'object' || !block || typeof block !== 'object') {
            return {
                hasVariable: false,
                isActive: false,
            };
        }
        if (entry.disable || block.enabled === false) {
            return {
                hasVariable: false,
                isActive: false,
            };
        }
        const hasVariable = this.hasConfiguredVariableInBlock(block);
        if (!hasVariable) {
            return {
                hasVariable: false,
                isActive: false,
            };
        }
        if (!includeActivation) {
            return {
                hasVariable: true,
                isActive: false,
            };
        }
        const primaryClause = this.ensureBlockPrimaryClause(block);
        const graph = this.ensureBlockNodeGraph(block);
        const compiledWhen = buildWhenFromNodeGraph(graph, primaryClause);
        const tree = normalizeConditionTree(compiledWhen, primaryClause);
        block.when = tree;
        const runtimeContext = this.getConditionRuntimeContext();
        const explanation = explainConditionTree(tree, runtimeContext);
        return {
            hasVariable: true,
            isActive: Boolean(explanation?.result),
        };
    }

    renderEntryActivationOverview(explanation) {
        return renderEntryActivationOverviewImpl.call(this, explanation, {
            escapeHtml,
        });
    }

    renderBlockSettingsPanel(block, blockPage = 0) {
        return renderBlockSettingsPanelImpl.call(this, block, blockPage, {
            escapeHtml,
            ROLE_OPTIONS,
        });
    }

    collectBlockConditionOverview(entry, block) {
        return collectBlockConditionOverviewImpl.call(this, entry, block, {
            buildWhenFromNodeGraph,
            normalizeConditionTree,
            explainConditionTree,
            visitConditionTree,
            isConditionTreeGroup,
            normalizePromptClause,
        });
    }

    renderConditionOverviewNode(node, depth = 0, explanation = null) {
        return renderConditionOverviewNodeImpl.call(this, node, depth, explanation, {
            isConditionTreeGroup,
            normalizeLogicValue,
            createDefaultPromptClause,
            normalizePromptClause,
            escapeHtml,
        });
    }

    renderBlockConditionOverview(entry, block) {
        return renderBlockConditionOverviewImpl.call(this, entry, block, {
            escapeHtml,
            BLOCK_RIGHT_TYPE_OPTIONS,
        });
    }

    getSessionVariableOptions() {
        return getWorldVariableOptions(resolveWorldVariableSessionContext());
    }

    ensureVariableInStore(name, type = 'number', defaultValue = 0, options = {}) {
        return ensureWorldVariableInStore({
            ...resolveWorldVariableSessionContext(),
            name,
            type,
            defaultValue,
            source: options?.source,
        });
    }

    mountNodeEditor({ entry, block, markRefDirty }) {
        return this.mountNodeEditorCore({ entry, block, markRefDirty });
    }

    mountNodeEditorCore({ entry, block, markRefDirty }) {
        return mountNodeEditorCoreImpl(this, { entry, block, markRefDirty }, {
            genNodeId,
            genEdgeId,
            sanitizeNodeId,
            normalizeNodeType,
            normalizeLogicValue,
            normalizeRightTypeValue,
            parseTypedValue,
            stringifyTypedValue,
            buildNodeDefineSpec,
            getNodePortSpec,
            normalizeGraphNodeData,
            normalizeGraphNode,
            normalizeGraphEdge,
            isConditionLogicNode,
            autoLayoutNodeGraph,
            buildNodeGraphFromWhen,
            normalizeNodeGraph,
            buildWhenFromNodeGraph,
            normalizePromptClause,
            isConditionTreeGroup,
            createDefaultPromptClause,
            normalizeConditionTree,
            getPrimaryClauseFromConditionTree,
            visitConditionTree,
            buildVariableContext,
            combineConditionLogicState,
            explainConditionTree,
            BLOCK_OP_OPTIONS,
            BLOCK_RIGHT_TYPE_OPTIONS,
            NODE_LOGIC_OPTIONS,
            NODE_CANVAS_MIN_WIDTH,
            NODE_CANVAS_MIN_HEIGHT,
            NODE_CANVAS_PADDING_X,
            NODE_CANVAS_PADDING_Y,
            deepClone,
            escapeHtml,
            clamp,
            translateUiText,
        });
    }

    ensureBlockManageModal() {
        if (this.blockManageModal) return;
        this.blockManageOverlay = document.createElement('div');
        this.blockManageOverlay.className = 'world-block-manage-overlay';
        this.blockManageOverlay.style.display = 'none';
        this.blockManageOverlay.addEventListener('click', () => this.hideBlockManageModal());

        this.blockManageModal = document.createElement('div');
        this.blockManageModal.className = 'world-block-manage-modal';
        this.blockManageModal.style.display = 'none';
        this.blockManageModal.innerHTML = `
            <div class="world-block-manage-modal-header">
                <div class="world-block-manage-modal-title">分页管理</div>
                <button type="button" class="world-block-manage-modal-close" aria-label="关闭">×</button>
            </div>
            <div class="world-block-manage-modal-list" id="world-block-manage-modal-list"></div>
            <div class="world-block-manage-modal-footer">
                <button type="button" class="world-block-manage-modal-done" id="world-block-manage-modal-done">完成</button>
            </div>
        `;
        this.blockManageModal.addEventListener('click', (event) => event.stopPropagation());
        this.blockManageList = this.blockManageModal.querySelector('#world-block-manage-modal-list');
        this.blockManageCloseBtn = this.blockManageModal.querySelector('#world-block-manage-modal-done');

        this.blockManageModal.querySelector('.world-block-manage-modal-close')?.addEventListener('click', () => this.hideBlockManageModal());
        this.blockManageCloseBtn?.addEventListener('click', () => this.hideBlockManageModal());

        document.body.appendChild(this.blockManageOverlay);
        document.body.appendChild(this.blockManageModal);
    }

    getBlockManageEntry() {
        const id = String(this.blockManageEntryId || '').trim();
        if (!id) return null;
        const { entry } = this.resolveEntryById(id);
        return entry || null;
    }

    renderBlockManageModalList() {
        if (!this.blockManageList) return;
        const entry = this.getBlockManageEntry();
        if (!entry) {
            this.blockManageList.innerHTML = '<div class="world-block-manage-modal-empty">未找到条目</div>';
            return;
        }
        const entryId = this.getEntryId(entry);
        const blocks = this.ensureEntryPromptBlocks(entry);
        const currentPage = this.getEntryBlockPage(entry, entryId);
        const compact = (text, max = 50) => {
            const raw = String(text || '').replace(/\s+/g, ' ').trim();
            if (!raw) return '（空）';
            return raw.length > max ? `${raw.slice(0, max)}…` : raw;
        };
        this.blockManageList.innerHTML = blocks.map((block, idx) => `
            <div class="world-block-manage-modal-item ${idx === currentPage ? 'is-active' : ''}">
                <button type="button" class="world-block-manage-modal-open" data-action="open" data-idx="${idx}">
                    <span class="world-block-manage-modal-page">
                        <span>第 ${idx + 1} 页</span>
                        <span class="world-block-manage-modal-badges">
                            <span class="world-block-manage-modal-badge ${block?.enabled === false ? 'warn' : ''}">${block?.enabled === false ? '已禁用' : '已启用'}</span>
                            <span class="world-block-manage-modal-badge subtle">${escapeHtml(this.getOptionLabel(ROLE_OPTIONS, block?.role, 'system'))}</span>
                            <span class="world-block-manage-modal-badge subtle">P${escapeHtml(String(Number.isFinite(Number(block?.priority)) ? Number(block.priority) : 100))}</span>
                        </span>
                    </span>
                    <span class="world-block-manage-modal-titleline" data-i18n-skip>${escapeHtml(translateUiText(String(block?.title || '').trim() || `内容 ${idx + 1}`))}</span>
                    <span class="world-block-manage-modal-preview" data-i18n-skip>${escapeHtml(compact(block?.content))}</span>
                </button>
                <div class="world-block-manage-modal-actions">
                    <button type="button" data-action="up" data-idx="${idx}" ${idx <= 0 ? 'disabled' : ''}>上移</button>
                    <button type="button" data-action="down" data-idx="${idx}" ${idx >= blocks.length - 1 ? 'disabled' : ''}>下移</button>
                    <button type="button" data-action="delete" data-idx="${idx}" ${blocks.length <= 1 ? 'disabled' : ''}>删除</button>
                </div>
            </div>
        `).join('');

        this.blockManageList.querySelectorAll('button[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = String(btn.dataset.action || '');
                const idx = Number(btn.dataset.idx);
                if (!Number.isFinite(idx)) return;
                if (action === 'open') {
                    this.setEntryBlockPage(entry, entryId, idx);
                    this.hideBlockManageModal();
                    return;
                }
                if (action === 'up') this.movePromptBlock(entry, idx, idx - 1);
                if (action === 'down') this.movePromptBlock(entry, idx, idx + 1);
                if (action === 'delete') this.removePromptBlock(entry, idx);
                this.renderBlockManageModalList();
            });
        });
    }

    showBlockManageModal(entry, entryId = '') {
        if (!entry || typeof entry !== 'object') return;
        this.ensureBlockManageModal();
        this.blockManageEntryId = String(entryId || this.getEntryId(entry) || '').trim();
        this.renderBlockManageModalList();
        if (this.blockManageOverlay) this.blockManageOverlay.style.display = 'block';
        if (this.blockManageModal) this.blockManageModal.style.display = 'block';
    }

    hideBlockManageModal() {
        if (this.blockManageOverlay) this.blockManageOverlay.style.display = 'none';
        if (this.blockManageModal) this.blockManageModal.style.display = 'none';
    }

    toggleBatchMode(force = null) {
        this.batchMode = force === null ? !this.batchMode : Boolean(force);
        if (!this.batchMode) {
            this.selectedEntries.clear();
        }
        this.updateBatchBar();
        this.renderList();
    }

    syncSelectedEntries() {
        const existing = new Set(this.data.entries.map((entry, idx) => this.getEntryId(entry, idx)));
        const next = new Set();
        this.selectedEntries.forEach((id) => {
            if (existing.has(id)) next.add(id);
        });
        this.selectedEntries = next;
    }

    updateBatchBar() {
        this.syncSelectedEntries();
        const count = this.selectedEntries.size;
        if (this.batchBarEl) {
            this.batchBarEl.style.display = this.batchMode ? 'flex' : 'none';
            if (this.batchCountEl) this.batchCountEl.textContent = `${translateUiText('已选')} ${count}`;
            if (this.batchCreateBtn) this.batchCreateBtn.disabled = count === 0;
        }
        this.updateManageState();
    }

    updateManageState() {
        this.syncSelectedEntries();
        const count = this.selectedEntries.size;
        if (this.manageCountEl) this.manageCountEl.textContent = `${translateUiText('已选')} ${count}`;
        const disableBatchActions = count === 0;
        if (this.manageCreateSelectedBtn) this.manageCreateSelectedBtn.disabled = disableBatchActions;
        if (this.manageDeleteBtn) this.manageDeleteBtn.disabled = disableBatchActions;
        if (this.manageMoveUpBtn) this.manageMoveUpBtn.disabled = disableBatchActions;
        if (this.manageMoveDownBtn) this.manageMoveDownBtn.disabled = disableBatchActions;
        if (this.manageMoveTopBtn) this.manageMoveTopBtn.disabled = disableBatchActions;
        if (this.manageMoveBottomBtn) this.manageMoveBottomBtn.disabled = disableBatchActions;
        this.renderManageList();
    }

    renderManageList() {
        if (!this.manageListEl) return;
        this.manageListEl.innerHTML = '';
        const compact = (text, max = 52) => {
            const raw = String(text || '').replace(/\s+/g, ' ').trim();
            if (!raw) return '';
            return raw.length > max ? `${raw.slice(0, max)}…` : raw;
        };
        this.data.entries.forEach((entry, idx) => {
            const entryId = this.getEntryId(entry, idx);
            const title = this.getEntryDisplayName(entry, idx);
            const content = compact(entry.content, 48);
            const isSelected = this.selectedEntries.has(entryId);
            const isActive = idx === this.currentIndex;
            const item = document.createElement('div');
            item.className = `world-manage-item${isActive ? ' active' : ''}${isSelected ? ' is-selected' : ''}`;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'world-manage-check';
            checkbox.checked = isSelected;
            checkbox.addEventListener('click', (event) => {
                event.stopPropagation();
                this.toggleEntrySelection(entryId);
            });
            item.appendChild(checkbox);

            const main = document.createElement('div');
            main.className = 'world-manage-item-main';
            const titleEl = document.createElement('div');
            titleEl.className = 'world-manage-item-title';
            titleEl.dataset.i18nSkip = '';
            titleEl.textContent = translateUiText(title);
            const subEl = document.createElement('div');
            subEl.className = 'world-manage-item-sub';
            subEl.dataset.i18nSkip = '';
            subEl.textContent = content || '';
            main.appendChild(titleEl);
            main.appendChild(subEl);
            item.appendChild(main);

            item.addEventListener('click', () => {
                this.currentIndex = idx;
                this.toggleEntrySelection(entryId);
                this.renderEditor();
            });

            this.manageListEl.appendChild(item);
        });
    }

    toggleEntrySelection(entryId) {
        const id = String(entryId || '').trim();
        if (!id) return;
        if (this.selectedEntries.has(id)) this.selectedEntries.delete(id);
        else this.selectedEntries.add(id);
        this.updateBatchBar();
        this.renderList();
    }

    selectAllEntries() {
        this.selectedEntries = new Set(this.data.entries.map((entry, idx) => this.getEntryId(entry, idx)).filter(Boolean));
        this.updateBatchBar();
        this.renderList();
    }

    clearSelection() {
        this.selectedEntries.clear();
        this.updateBatchBar();
        this.renderList();
    }

    getSelectedEntries() {
        const selected = this.selectedEntries;
        return this.data.entries.filter((entry, idx) => selected.has(this.getEntryId(entry, idx)));
    }

    async createChatFromSelection() {
        if (!this.selectedEntries.size) {
            window.toastr?.info?.('请先选择条目');
            return;
        }
        const selected = this.getSelectedEntries();
        const firstEntry = selected[0] || null;
        const firstIdx = firstEntry ? this.data.entries.findIndex(e => this.getEntryId(e) === this.getEntryId(firstEntry)) : -1;
        const defaultName = firstEntry ? this.getEntryDisplayName(firstEntry, Math.max(0, firstIdx)) : '新聊天室';
        const name = await this.openChatNameModal(defaultName);
        if (!name || !String(name).trim()) return;
        await this.createChatFromEntries(selected, { name });
        this.clearSelection();
        this.updateBatchBar();
    }

    async createChatFromAllEntries() {
        const name = prompt('输入聊天室名称（将引用整本世界书）', this.worldName || '新聊天室');
        if (!name || !String(name).trim()) return;
        await this.createChatFromEntries(this.data.entries, { name, includeAll: true });
    }

    deleteSelectedEntries() {
        if (!this.selectedEntries.size) {
            window.toastr?.info?.('请先选择条目');
            return;
        }
        const count = this.selectedEntries.size;
        const ok = window.confirm(`确定删除已选 ${count} 个条目？此操作不可撤销。`);
        if (!ok) return;
        const selected = new Set(this.selectedEntries);
        const currentId = this.getEntryId(this.data.entries[this.currentIndex], this.currentIndex);
        this.data.entries = this.data.entries.filter((entry, idx) => !selected.has(this.getEntryId(entry, idx)));
        if (!this.data.entries.length) this.data.entries.push(createDefaultEntry(0));
        this.selectedEntries.clear();
        this.batchMode = false;
        this.currentIndex = Math.max(0, this.data.entries.findIndex((entry, idx) => this.getEntryId(entry, idx) === currentId));
        if (this.currentIndex < 0) this.currentIndex = 0;
        this.renderList();
        this.renderEditor();
    }

    moveSelectedEntries(direction = 0) {
        if (!this.selectedEntries.size) {
            window.toastr?.info?.('请先选择条目');
            return;
        }
        if (!direction) return;
        const selected = new Set(this.selectedEntries);
        const currentId = this.getEntryId(this.data.entries[this.currentIndex], this.currentIndex);
        const entries = this.data.entries;
        if (direction < 0) {
            for (let i = 1; i < entries.length; i += 1) {
                const id = this.getEntryId(entries[i], i);
                const prevId = this.getEntryId(entries[i - 1], i - 1);
                if (selected.has(id) && !selected.has(prevId)) {
                    const tmp = entries[i - 1];
                    entries[i - 1] = entries[i];
                    entries[i] = tmp;
                }
            }
        } else {
            for (let i = entries.length - 2; i >= 0; i -= 1) {
                const id = this.getEntryId(entries[i], i);
                const nextId = this.getEntryId(entries[i + 1], i + 1);
                if (selected.has(id) && !selected.has(nextId)) {
                    const tmp = entries[i + 1];
                    entries[i + 1] = entries[i];
                    entries[i] = tmp;
                }
            }
        }
        this.currentIndex = Math.max(0, entries.findIndex((entry, idx) => this.getEntryId(entry, idx) === currentId));
        if (this.currentIndex < 0) this.currentIndex = 0;
        this.renderList();
        this.renderEditor();
    }

    moveSelectedToEdge(target = 'top') {
        if (!this.selectedEntries.size) {
            window.toastr?.info?.('请先选择条目');
            return;
        }
        const selected = new Set(this.selectedEntries);
        const currentId = this.getEntryId(this.data.entries[this.currentIndex], this.currentIndex);
        const entries = this.data.entries;
        const selectedEntries = entries.filter((entry, idx) => selected.has(this.getEntryId(entry, idx)));
        const rest = entries.filter((entry, idx) => !selected.has(this.getEntryId(entry, idx)));
        this.data.entries = target === 'bottom' ? [...rest, ...selectedEntries] : [...selectedEntries, ...rest];
        this.currentIndex = Math.max(0, this.data.entries.findIndex((entry, idx) => this.getEntryId(entry, idx) === currentId));
        if (this.currentIndex < 0) this.currentIndex = 0;
        this.renderList();
        this.renderEditor();
    }

    getEntryTriggerStrategy(entry) {
        return entry?.constant ? 'blue' : 'green';
    }

    applyEntryTriggerStrategy(entry, strategy = 'green') {
        if (!entry || typeof entry !== 'object') return;
        const mode = String(strategy || '').toLowerCase() === 'blue' ? 'blue' : 'green';
        if (mode === 'blue') {
            entry.constant = true;
            entry.selective = false;
            entry.selectiveExplicit = false;
            return;
        }
        entry.constant = false;
        entry.selective = Boolean(entry.selective);
    }

    setEntryDisabled(index, disabled) {
        const entry = this.data.entries[index];
        if (!entry) return;
        entry.disable = Boolean(disabled);
        if (!entry.disable && !entry.constant && !entry.selective) {
            this.applyEntryTriggerStrategy(entry, 'green');
        }
        this.renderList();
        if (this.currentIndex === index) this.renderEditor();
        if (this.refMode) this.scheduleRefSync();
    }

    getOptionLabel(options = [], value, fallback = '') {
        const target = String(value ?? '').trim();
        const hit = (Array.isArray(options) ? options : []).find((opt) => String(opt?.value ?? '').trim() === target);
        return hit?.label || fallback || target;
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
            this.customSelectMenuEl.innerHTML = '';
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
            const selected = value === current;
            const label = String(opt?.label ?? value);
            return `
                <button type="button" class="world-app-select-item ${selected ? 'is-selected' : ''}" data-value="${value}">
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

    changeEntryPage(nextPageIndex) {
        const next = Number(nextPageIndex);
        const total = Math.max(1, Number(this.entryTotalPages) || 1);
        if (!Number.isInteger(next) || next < 0 || next >= total || next === this.entryPageIndex) return false;
        const pageDirection = next > this.entryPageIndex ? 1 : -1;
        this.entryPageIndex = next;
        this.renderList({ pageDirection });
        return true;
    }

    finishEntryPageTransition() {
        this.entryPageTransitionToken += 1;
        if (this.entryPageTransitionTimer) {
            clearTimeout(this.entryPageTransitionTimer);
            this.entryPageTransitionTimer = null;
        }
        const list = this.entriesListEl;
        if (list && this.entryPageTransitionScrollEndHandler) {
            list.removeEventListener('scrollend', this.entryPageTransitionScrollEndHandler);
        }
        this.entryPageTransitionScrollEndHandler = null;
        const target = this.entryPageTransitionTargetEl;
        this.entryPageTransitionTargetEl = null;
        if (list) {
            list.classList.remove('is-page-transitioning');
            target?.classList.remove('is-page-incoming');
            if (target && list.contains(target)) list.replaceChildren(target);
            list.scrollLeft = 0;
        }
    }

    mountEntryPage(pageEl, previousPageEl = null, pageDirection = 0) {
        const list = this.entriesListEl;
        if (!list || !pageEl) return;
        const direction = Math.sign(Number(pageDirection) || 0);
        const canSlide = direction !== 0
            && previousPageEl
            && previousPageEl.parentElement === list
            && list.clientWidth > 0
            && !isWorldMotionReduced();
        if (!canSlide) {
            list.replaceChildren(pageEl);
            list.scrollLeft = 0;
            return;
        }

        const width = list.clientWidth;
        const targetLeft = direction > 0 ? width : 0;
        pageEl.classList.add('is-page-incoming');
        previousPageEl.classList.add('is-page-outgoing');
        list.classList.add('is-page-transitioning');
        if (direction > 0) {
            list.replaceChildren(previousPageEl, pageEl);
            list.scrollLeft = 0;
        } else {
            list.replaceChildren(pageEl, previousPageEl);
            list.scrollLeft = width;
        }
        this.entryPageTransitionTargetEl = pageEl;
        const token = ++this.entryPageTransitionToken;
        const finish = () => {
            if (token !== this.entryPageTransitionToken) return;
            this.finishEntryPageTransition();
        };
        const beginScroll = () => {
            if (token !== this.entryPageTransitionToken || this.entryPageTransitionTargetEl !== pageEl) return;
            this.entryPageTransitionScrollEndHandler = finish;
            list.addEventListener('scrollend', finish, { once: true });
            list.scrollTo({ left: targetLeft, behavior: 'smooth' });
            this.entryPageTransitionTimer = setTimeout(finish, 520);
        };
        requestAnimationFrame(() => requestAnimationFrame(beginScroll));
    }

    renderList({ pageDirection = 0 } = {}) {
        if (!this.entriesListEl) return;
        this.updateBatchBar();
        this.finishEntryPageTransition();
        const previousPageEl = this.entriesListEl.querySelector(':scope > .world-entry-page');
        const animateRows = this.entryListMotionPending;
        this.entryListMotionPending = false;
        let motionIndex = 0;
        const searchTerm = this.getEntrySearchTerm();
        const filtered = this.getFilteredEntries(searchTerm);

        const page = paginateWorldEntries(filtered, this.entryPageIndex, this.entryPageSize);
        this.entryPageSize = page.pageSize;
        this.entryPageIndex = page.pageIndex;
        this.entryTotalPages = page.totalPages;
        if (this.entryPageSizeEl) this.entryPageSizeEl.value = String(page.pageSize);

        const buildEntryItem = (entry, i) => {
            const entryId = this.getEntryId(entry, i);
            const isSelected = this.selectedEntries.has(entryId);
            const variableStatus = this.getEntryVariableStatus(entry, i, {
                includeActivation: i === this.currentIndex,
            });
            const item = document.createElement('div');
            item.className = `world-entry-item ${i === this.currentIndex ? 'active' : ''}`;
            if (animateRows && motionIndex < 12) {
                item.classList.add('is-entering');
                item.style.setProperty('--world-motion-order', String(Math.min(motionIndex, 8)));
            }
            if (animateRows) motionIndex += 1;
            item.dataset.entryIndex = String(i);
            item.dataset.entryId = entryId;
            if (this.batchMode && isSelected) item.classList.add('is-selected');
            if (entry.disable) item.classList.add('is-disabled');
            if (variableStatus.hasVariable) item.classList.add('has-variable-condition');
            if (variableStatus.isActive) item.classList.add('is-variable-active');

            const lights = document.createElement('div');
            lights.className = 'world-entry-lights';
            const strategyLight = document.createElement('span');
            const strategy = this.getEntryTriggerStrategy(entry);
            strategyLight.className = `world-entry-light ${entry.disable ? 'off' : strategy}`;
            lights.appendChild(strategyLight);
            if (variableStatus.hasVariable) {
                const variableLight = document.createElement('span');
                variableLight.className = `world-entry-light variable is-configured${variableStatus.isActive ? ' is-active' : ''}`;
                variableLight.setAttribute('title', variableStatus.isActive ? '变量条件生效中' : '已配置变量条件');
                lights.appendChild(variableLight);
            }

            const main = document.createElement('div');
            main.className = 'world-entry-main';
            const title = document.createElement('div');
            title.className = 'world-entry-title';
            title.dataset.i18nSkip = '';
            title.textContent = translateUiText(entry.comment || `（无标题 ${i + 1}）`);
            const meta = document.createElement('div');
            meta.className = 'world-entry-meta';
            const pos = positionLabel(entry.position, entry.role, entry.depth);
            meta.innerHTML = `
                <span>${pos}</span>
                <span>D${entry.depth}</span>
                <span>O${entry.order}</span>
                <span>${entry.useProbability ? `${entry.probability}%` : '100%'}</span>
            `;
            main.appendChild(title);
            main.appendChild(meta);

            if (this.batchMode) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'world-entry-select';
                checkbox.checked = isSelected;
                checkbox.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.toggleEntrySelection(entryId);
                });
                item.appendChild(checkbox);
            }
            item.appendChild(lights);
            item.appendChild(main);
            const controls = document.createElement('div');
            controls.className = 'world-entry-controls';
            const enableToggle = document.createElement('button');
            enableToggle.type = 'button';
            enableToggle.className = `world-entry-enable-toggle ${entry.disable ? 'is-off' : 'is-on'}`;
            enableToggle.setAttribute('aria-label', entry.disable ? '启用条目' : '停用条目');
            enableToggle.setAttribute('aria-pressed', entry.disable ? 'false' : 'true');
            enableToggle.addEventListener('click', (event) => {
                event.stopPropagation();
                this.setEntryDisabled(i, !entry.disable);
            });
            controls.appendChild(enableToggle);
            item.appendChild(controls);
            item.onclick = () => this.selectEntry(i);
            return item;
        };

        if (!filtered.length) {
            const pageEl = document.createElement('li');
            pageEl.className = 'world-entry-page';
            const list = document.createElement('div');
            list.className = 'world-entry-page-list';
            const empty = document.createElement('div');
            empty.className = 'world-entry-empty';
            if (animateRows) empty.classList.add('is-entering');
            empty.textContent = searchTerm ? '没有匹配的条目' : '（无条目）';
            list.appendChild(empty);
            pageEl.appendChild(list);
            this.mountEntryPage(pageEl, previousPageEl, pageDirection);
            this.updateEntryPageIndicator();
            return;
        }

        const pageEl = document.createElement('li');
        pageEl.className = 'world-entry-page';
        const list = document.createElement('div');
        list.className = 'world-entry-page-list';
        page.items.forEach(({ entry, idx: originalIndex }) => {
            list.appendChild(buildEntryItem(entry, originalIndex));
        });
        pageEl.appendChild(list);
        this.mountEntryPage(pageEl, previousPageEl, pageDirection);
        this.updateEntryPageIndicator();
    }

    getEntrySearchTerm() {
        return String(this.entrySearchTerm || '').trim().toLowerCase();
    }

    getFilteredEntries(searchTerm = this.getEntrySearchTerm()) {
        return this.data.entries
            .map((entry, idx) => ({ entry, idx }))
            .filter(({ entry }) => {
                if (!searchTerm) return true;
                let haystack = this.entrySearchCache.get(entry);
                if (typeof haystack !== 'string') {
                    const parts = [];
                    if (entry?.comment) parts.push(entry.comment);
                    if (entry?.content) parts.push(entry.content);
                    if (Array.isArray(entry?.key)) parts.push(entry.key.join(' '));
                    if (!Array.isArray(entry?.key) && entry?.key) parts.push(entry.key);
                    if (Array.isArray(entry?.keysecondary)) parts.push(entry.keysecondary.join(' '));
                    if (!Array.isArray(entry?.keysecondary) && entry?.keysecondary) parts.push(entry.keysecondary);
                    if (entry?.id) parts.push(entry.id);
                    haystack = parts.join(' ').toLowerCase();
                    this.entrySearchCache.set(entry, haystack);
                }
                return haystack.includes(searchTerm);
            })
            .sort((a, b) => {
                const aDisabled = a.entry?.disable ? 1 : 0;
                const bDisabled = b.entry?.disable ? 1 : 0;
                if (aDisabled !== bDisabled) return aDisabled - bDisabled;
                return a.idx - b.idx;
            });
    }

    updateEntryPageIndicator() {
        const total = Math.max(1, this.entryTotalPages || 1);
        const current = Math.min(Math.max(0, this.entryPageIndex), total - 1);
        if (this.entryPageIndicatorEl) this.entryPageIndicatorEl.textContent = `${current + 1}/${total}`;
        if (this.entryPagePrevBtn) this.entryPagePrevBtn.disabled = current <= 0;
        if (this.entryPageNextBtn) this.entryPageNextBtn.disabled = current >= total - 1;
        if (this.entryDotsEl) {
            this.entryDotsEl.innerHTML = '';
            if (total <= 1) {
                this.entryDotsEl.style.display = 'none';
                return;
            }
            this.entryDotsEl.style.display = 'flex';
            getCompactPageItems(total, current).forEach((item) => {
                if (item === 'ellipsis') {
                    const ellipsis = document.createElement('span');
                    ellipsis.className = 'world-entries-ellipsis';
                    ellipsis.textContent = '…';
                    this.entryDotsEl.appendChild(ellipsis);
                    return;
                }
                const i = item;
                const dot = document.createElement('button');
                dot.type = 'button';
                const distance = Math.min(3, Math.abs(i - current));
                dot.className = `world-entries-dot distance-${distance}${i === current ? ' active' : ''}`;
                dot.setAttribute('aria-label', `第 ${i + 1} 页`);
                dot.addEventListener('click', () => this.changeEntryPage(i));
                this.entryDotsEl.appendChild(dot);
            });
        }
    }

    refreshEntryListSelection() {
        if (!this.entriesListEl?.querySelectorAll) return false;
        const items = Array.from(this.entriesListEl.querySelectorAll('.world-entry-item') || []);
        if (!items.length) return false;
        items.forEach((item) => {
            const idx = Number(item.dataset?.entryIndex);
            if (!Number.isInteger(idx)) return;
            const entry = this.data.entries[idx];
            if (!entry) return;
            const entryId = item.dataset?.entryId || this.getEntryId(entry, idx);
            const variableStatus = this.getEntryVariableStatus(entry, idx, {
                includeActivation: idx === this.currentIndex,
            });
            item.classList.toggle('active', idx === this.currentIndex);
            item.classList.toggle('is-selected', this.batchMode && this.selectedEntries.has(entryId));
            item.classList.toggle('is-disabled', Boolean(entry.disable));
            item.classList.toggle('has-variable-condition', Boolean(variableStatus.hasVariable));
            item.classList.toggle('is-variable-active', Boolean(variableStatus.isActive));
            const strategyLight = item.querySelector?.('.world-entry-light');
            if (strategyLight) {
                strategyLight.className = `world-entry-light ${entry.disable ? 'off' : this.getEntryTriggerStrategy(entry)}`;
            }
            const variableLight = item.querySelector?.('.world-entry-light.variable');
            if (variableLight) {
                variableLight.classList.toggle('is-active', Boolean(variableStatus.isActive));
                variableLight.setAttribute('title', variableStatus.isActive ? '变量条件生效中' : '已配置变量条件');
            }
        });
        this.updateEntryPageIndicator();
        return true;
    }

    selectEntry(index, { forceRenderList = false } = {}) {
        this.hideBlockManageModal();
        const previousPageIndex = this.entryPageIndex;
        this.currentIndex = Math.max(0, Math.min(index, this.data.entries.length - 1));
        const filtered = this.getFilteredEntries();
        const currentPos = filtered.findIndex(item => item.idx === this.currentIndex);
        let shouldRenderList = Boolean(forceRenderList);
        if (currentPos >= 0) {
            const rawSize = Number(this.entryPageSize);
            const pageSize = Math.max(1, Math.min(200, Number.isFinite(rawSize) ? Math.trunc(rawSize) : 4));
            const nextPageIndex = Math.floor(currentPos / pageSize);
            if (nextPageIndex !== previousPageIndex) shouldRenderList = true;
            this.entryPageIndex = nextPageIndex;
        } else if (filtered.length) {
            shouldRenderList = true;
        }
        if (shouldRenderList || !this.refreshEntryListSelection()) this.renderList();
        this.renderEditor();
    }

    renderEditor() {
        if (!this.editorEl) return;
        this.cleanupNodeEditor();
        this.closeCustomSelectMenu();
        const entry = this.data.entries[this.currentIndex];
        if (!entry) {
            this.editorEl.innerHTML = '<div style="color:#888;">（无条目）</div>';
            return;
        }

        const blocks = this.ensureEntryPromptBlocks(entry);
        const entryId = this.getEntryId(entry, this.currentIndex);
        const animateEditorEntry = entryId !== this.editorMotionEntryId;
        this.editorMotionEntryId = entryId;
        const blockPage = this.getEntryBlockPage(entry, entryId);
        const activeBlock = blocks[blockPage] || blocks[0];
        const activeBlockId = String(activeBlock?.id || '').trim();
        const blockFlipped = this.isBlockFlipped(activeBlock?.id);
        const blockExpanded = this.isBlockExpanded(activeBlock?.id);
        const blockExpandEntering = blockExpanded && this.blockExpandMotionPending === activeBlockId;
        if (blockExpandEntering) this.blockExpandMotionPending = '';
        const blockBackView = this.getBlockBackView(activeBlock?.id);
        const conditionTargetKind = this.blockConditionTargetMap.get(activeBlockId) === 'entry'
            ? 'entry'
            : 'block';
        const conditionTarget = conditionTargetKind === 'entry' ? entry : activeBlock;
        const entryGateConfigured = this.hasConfiguredVariableInBlock(entry);
        const aiBusy = this.aiBusy && entryId === String(this.aiPendingEntryId || '').trim();
        const aiLockTarget = aiBusy && activeBlockId && activeBlockId === String(this.aiTargetBlockId || '').trim();
        const triggerStrategy = this.getEntryTriggerStrategy(entry);
        const triggerStrategyLabel = this.getOptionLabel(TRIGGER_STRATEGY_OPTIONS, triggerStrategy, '🟢 绿灯（关键词触发）');
        const positionLabelText = this.getOptionLabel(POSITION_OPTIONS, entry.position, '↑Char（角色前）');
        const roleLabelText = this.getOptionLabel(ROLE_OPTIONS, entry.role, 'system');
        const selectiveLogicLabel = this.getOptionLabel(SELECTIVE_LOGIC_OPTIONS, entry.selectiveLogic, 'AND 任一（匹配任一关键词）');
        const blockVariableStatus = this.getBlockVariableStatus(entry, activeBlock, this.currentIndex, {
            includeActivation: true,
        });
        const renderRevision = ++this.editorRenderRevision;
        if (aiBusy || this.isAiTraceWatchActive()) {
            this.traceAi('render.state', {
                renderRevision,
                entryId,
                blockPage,
                activeBlockId,
                aiBusy,
                aiLockTarget,
                pendingEntryId: this.aiPendingEntryId,
                targetEntryId: this.aiTargetEntryId,
                targetBlockId: this.aiTargetBlockId,
                blockSummary: summarizeTraceText(activeBlock?.content || ''),
            });
        }
        this.editorEl.innerHTML = `
            <div class="world-entry-form${animateEditorEntry ? ' is-entering' : ''}">
                <div class="world-entry-card${blockVariableStatus.hasVariable ? ' has-variable-condition' : ''}${blockVariableStatus.isActive ? ' is-variable-active' : ''}">
                    ${blockVariableStatus.hasVariable ? `
                        <div class="world-entry-variable-state ${blockVariableStatus.isActive ? 'is-active' : 'is-configured'}">
                            <span class="world-entry-variable-dot" aria-hidden="true"></span>
                            <span>${blockVariableStatus.isActive ? '本卡变量条件：生效中' : '本卡变量条件：未生效'}</span>
                        </div>
                    ` : ''}
                    <label>标题 / Memo</label>
                    <input type="text" id="we-comment" value="${entry.comment || ''}" placeholder="条目标题（可选）">

                    <div class="world-block-toolbar">
                        <div class="world-block-toolbar-actions">
                            <button type="button" class="world-ai-trigger" id="we-ai-generate" ${aiBusy ? 'disabled' : ''}>${aiBusy ? '生成中...' : 'AI生成'}</button>
                            <button type="button" class="world-block-btn" id="we-block-add">＋</button>
                            <button type="button" class="world-block-btn" id="we-block-manage">管理</button>
                        </div>
                    </div>

                    <div class="world-content-title">内容</div>
                    <div class="world-block-overlay ${blockExpanded ? 'show' : ''}${blockExpandEntering ? ' is-entering' : ''}" id="we-block-overlay"></div>
                    ${blockExpanded && this.blockShellPlaceholderHeight > 0 ? `
                        <div class="world-block-shell-placeholder" style="height: ${Number(this.blockShellPlaceholderHeight).toFixed(2)}px" aria-hidden="true"></div>
                    ` : ''}
                    <div class="world-flip-card world-content-card ${blockFlipped ? 'is-flipped' : ''} ${blockExpanded ? 'is-expanded' : ''}${blockExpandEntering ? ' is-entering' : ''}" id="we-block-shell">
                        <button type="button" class="world-block-corner-btn" id="we-block-corner-btn" aria-label="${blockExpanded ? '翻转' : '展开'}">
                            ${blockExpanded ? BLOCK_FLIP_ICON_SVG : BLOCK_EXPAND_ICON_SVG}
                        </button>
                        <div class="world-flip-card-face world-flip-card-front">
                            <textarea id="we-block-content" placeholder="输入本页提示词内容" ${aiLockTarget ? 'readonly' : ''}>${activeBlock?.content || ''}</textarea>
                        </div>
                        <div class="world-flip-card-face world-flip-card-back">
                            <div class="world-block-back-tools">
                                ${blockBackView === 'editor' ? `
                                    <div class="world-block-back-tool-group">
                                        <button type="button" class="world-block-back-nav-btn" id="we-block-editor-back">概览</button>
                                        <span class="world-block-settings-subtitle">正在编辑：${conditionTargetKind === 'entry' ? '条目级门控' : '当前分页条件'}</span>
                                    </div>
                                    <button type="button" class="world-block-back-save-btn" id="we-block-editor-save">保存</button>
                                ` : `
                                    <div class="world-block-back-tool-group">
                                        <button type="button" class="world-block-back-nav-btn primary" id="we-block-open-node">${BLOCK_MODE_NODE_ICON_SVG}<span>分页条件</span></button>
                                        <button type="button" class="world-block-back-nav-btn ${entryGateConfigured ? 'primary' : ''}" id="we-entry-open-node">${BLOCK_MODE_NODE_ICON_SVG}<span>条目门控${entryGateConfigured ? ' · 已配置' : ''}</span></button>
                                    </div>
                                `}
                            </div>
                            ${conditionTargetKind === 'entry' && blockBackView === 'editor'
                                ? `
                                    <div class="world-block-settings-card">
                                        <div class="world-block-settings-head">
                                            <div>
                                                <div class="world-block-settings-title">条目级变量门控</div>
                                                <div class="world-block-settings-subtitle">先判断此条件；未通过时，常驻、关键词、递归和分组竞争都不会继续。</div>
                                            </div>
                                        </div>
                                    </div>
                                `
                                : this.renderBlockSettingsPanel(activeBlock, blockPage)}
                            ${blockBackView === 'editor' ? `
                                <div class="world-node-editor" id="we-node-editor">
                                    <div class="world-node-toolbar">
                                        <button type="button" class="world-node-toolbar-btn" data-action="template" title="常用节点模板">模板</button>
                                        <button type="button" class="world-node-toolbar-btn primary" data-action="addCondition" title="一键新增变量->比较->值链路">条件链</button>
                                        <button type="button" class="world-node-toolbar-btn" data-action="deleteSelection" title="删除当前选中节点">删除</button>
                                        <button type="button" class="world-node-toolbar-btn" data-action="addMore" title="新增变量/值/比较/逻辑">新增 ▾</button>
                                        <button type="button" class="world-node-toolbar-btn" data-action="viewMenu" title="缩放与聚焦">视图 ▾</button>
                                        <button type="button" class="world-node-toolbar-btn" data-action="arrangeMenu" title="整理与排版">整理 ▾</button>
                                    </div>
                                    <div class="world-node-status" id="we-node-status" data-tone="muted"></div>
                                    <div class="world-node-canvas-wrap" id="we-node-canvas-wrap">
                                        <div class="world-node-scene" id="we-node-scene">
                                            <svg class="world-node-links" id="we-node-links" viewBox="0 0 760 320" preserveAspectRatio="none" aria-hidden="true"></svg>
                                            <div class="world-node-guides" id="we-node-guides" aria-hidden="true"></div>
                                            <div class="world-node-canvas" id="we-node-canvas"></div>
                                            <div class="world-node-marquee" id="we-node-marquee"></div>
                                        </div>
                                        <div class="world-node-context-menu" id="we-node-context-menu"></div>
                                    </div>
                                    <div class="world-node-inspector" id="we-node-inspector"></div>
                                </div>
                            ` : this.renderBlockConditionOverview(entry, activeBlock)}
                        </div>
                    </div>

                    <div class="world-block-page-dots" id="we-block-dots">
                        ${blocks.map((_, idx) => `
                            <button type="button" class="world-block-dot ${idx === blockPage ? 'active' : ''}" data-idx="${idx}" aria-label="第 ${idx + 1} 页"></button>
                        `).join('')}
                    </div>
                </div>

                <div class="world-entry-card">
                    <div class="world-entry-card-title">基础触发设置</div>
                    <div class="world-entry-grid world-entry-grid-core">
                        <div class="world-entry-field">
                            <label>触发策略</label>
                            <button type="button" class="world-app-select-btn" id="we-triggerStrategy-btn">
                                <span>${triggerStrategyLabel}</span>
                                <span class="world-app-select-btn-chevron">▾</span>
                            </button>
                        </div>
                        <div class="world-entry-field">
                            <label>位置（position）</label>
                            <button type="button" class="world-app-select-btn" id="we-position-btn">
                                <span>${positionLabelText}</span>
                                <span class="world-app-select-btn-chevron">▾</span>
                            </button>
                        </div>
                        <div class="world-entry-field">
                            <label>深度（depth）</label>
                            <input type="number" id="we-depth" min="0" max="1000" value="${entry.depth}">
                        </div>
                        <div class="world-entry-field">
                            <label>顺序 / Order</label>
                            <input type="number" id="we-order" min="-9999" max="9999" value="${entry.order}">
                        </div>
                        <div class="world-entry-field">
                            <label>触发概率（Trigger %）</label>
                            <input type="number" id="we-probability" min="0" max="100" value="${entry.probability}">
                        </div>
                        <div class="world-entry-field">
                            <label>&nbsp;</label>
                            <label class="world-entry-inline-check">
                                <input type="checkbox" id="we-useProbability" ${entry.useProbability ? 'checked' : ''}>
                                <span>启用概率</span>
                            </label>
                        </div>
                    </div>
                </div>

                <details class="world-entry-advanced">
                    <summary>高级设置</summary>
                    <div class="world-entry-advanced-clip">
                      <div class="world-entry-advanced-body">
                        <div class="world-entry-group">
                            <div class="world-entry-group-title">关键词与角色</div>
                            <div class="world-entry-grid world-entry-grid-2">
                                <div class="world-entry-field">
                                    <label>主触发关键词（key）</label>
                                    <textarea id="we-key" placeholder="用逗号或换行分隔">${(entry.key || []).join(', ')}</textarea>
                                </div>
                                <div class="world-entry-field">
                                    <label>副触发关键词（keysecondary）</label>
                                    <textarea id="we-keysecondary" placeholder="用逗号或换行分隔">${(entry.keysecondary || []).join(', ')}</textarea>
                                </div>
                            </div>
                            <div class="world-entry-grid world-entry-grid-2">
                                <div class="world-entry-field" id="we-role-wrap" style="${Number(entry.position) === 4 ? '' : 'display:none;'}">
                                    <label>插入角色（role）</label>
                                    <button type="button" class="world-app-select-btn" id="we-role-btn">
                                        <span>${roleLabelText}</span>
                                        <span class="world-app-select-btn-chevron">▾</span>
                                    </button>
                                </div>
                                <div class="world-entry-field" id="we-depth-anchor-wrap" style="${Number(entry.position) === 4 ? '' : 'display:none;'}">
                                    <label>D0 锚点</label>
                                    <button type="button" class="world-app-select-btn" id="we-depth-anchor-btn">
                                        <span>${this.getOptionLabel(DEPTH_ANCHOR_OPTIONS, entry.latestUserAnchor, '默认（D0 在最新输入后）')}</span>
                                        <span class="world-app-select-btn-chevron">▾</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="world-entry-group">
                            <div class="world-entry-group-title">触发补充与递归</div>
                            <div class="world-entry-toggle-grid">
                                <label><input type="checkbox" id="we-ignoreBudget" ${entry.ignoreBudget ? 'checked' : ''}> 忽略预算</label>
                                <label><input type="checkbox" id="we-excludeRecursion" ${entry.excludeRecursion ? 'checked' : ''}> 不参与递归</label>
                                <label><input type="checkbox" id="we-preventRecursion" ${entry.preventRecursion ? 'checked' : ''}> 阻止递归</label>
                            </div>
                            <div class="world-entry-toggle-grid" style="margin-top:8px;">
                                <label><input type="checkbox" id="we-selective" ${!entry.constant && entry.selective ? 'checked' : ''}> 启用副关键词逻辑（selective）</label>
                            </div>
                            <label style="margin-top:8px;">选择性逻辑（Selective Logic）</label>
                            <button type="button" class="world-app-select-btn" id="we-selectiveLogic-btn">
                                <span>${selectiveLogicLabel}</span>
                                <span class="world-app-select-btn-chevron">▾</span>
                            </button>
                        </div>

                        <div class="world-entry-group">
                            <div class="world-entry-group-title">匹配来源（Match）</div>
                            <div class="world-entry-toggle-grid">
                                <label><input type="checkbox" id="we-matchPersonaDescription" ${entry.matchPersonaDescription ? 'checked' : ''}> Persona 描述</label>
                                <label><input type="checkbox" id="we-matchCharacterDescription" ${entry.matchCharacterDescription ? 'checked' : ''}> 角色描述</label>
                                <label><input type="checkbox" id="we-matchCharacterPersonality" ${entry.matchCharacterPersonality ? 'checked' : ''}> 角色性格</label>
                                <label><input type="checkbox" id="we-matchCharacterDepthPrompt" ${entry.matchCharacterDepthPrompt ? 'checked' : ''}> 角色深度提示</label>
                                <label><input type="checkbox" id="we-matchScenario" ${entry.matchScenario ? 'checked' : ''}> 场景</label>
                                <label><input type="checkbox" id="we-matchCreatorNotes" ${entry.matchCreatorNotes ? 'checked' : ''}> 作者注释</label>
                            </div>
                        </div>

                        <div class="world-entry-group">
                            <div class="world-entry-group-title">分组与覆盖</div>
                            <div class="world-entry-grid world-entry-grid-3">
                                <div class="world-entry-field">
                                    <label>纳入组（group）</label>
                                    <input type="text" id="we-group" value="${entry.group || ''}" placeholder="逗号分隔多个组">
                                </div>
                                <div class="world-entry-field">
                                    <label>组权重（groupWeight）</label>
                                    <input type="number" id="we-groupWeight" min="0" max="9999" value="${entry.groupWeight}">
                                </div>
                                <div class="world-entry-field">
                                    <label>递归延迟（delayUntilRecursion）</label>
                                    <input type="number" id="we-delayUntilRecursion" min="0" max="9999" value="${entry.delayUntilRecursion ?? 0}">
                                </div>
                            </div>
                            <div class="world-entry-toggle-grid" style="margin-top:6px;">
                                <label><input type="checkbox" id="we-groupOverride" ${entry.groupOverride ? 'checked' : ''}> 允许覆盖同组</label>
                                <label><input type="checkbox" id="we-caseSensitive" ${entry.caseSensitive ? 'checked' : ''}> 区分大小写（覆盖）</label>
                                <label><input type="checkbox" id="we-matchWholeWords" ${entry.matchWholeWords ? 'checked' : ''}> 全词匹配（覆盖）</label>
                                <label><input type="checkbox" id="we-useGroupScoring" ${entry.useGroupScoring ? 'checked' : ''}> 组打分（覆盖）</label>
                            </div>
                            <label style="margin-top:6px;">扫描深度覆盖（scanDepth，可空）</label>
                            <input type="number" id="we-scanDepth" min="0" max="1000" value="${entry.scanDepth ?? ''}" placeholder="留空使用全局设置">
                        </div>
                      </div>
                    </div>
                </details>

                <div class="world-entry-actions">
                    <button id="we-duplicate">复制条目</button>
                    <button id="we-transfer">移动 / 复制到…</button>
                    <button id="we-delete">删除条目</button>
                </div>
            </div>
        `;

        const q = (sel) => this.editorEl.querySelector(sel);
        const advancedDetails = q('.world-entry-advanced');
        const advancedSummary = advancedDetails?.querySelector('summary');
        const advancedClip = q('.world-entry-advanced-clip');
        if (advancedDetails && advancedSummary && advancedClip) {
            advancedSummary.setAttribute('aria-expanded', 'false');
            advancedSummary.addEventListener('click', (event) => {
                event.preventDefault();
                const shouldOpen = !advancedDetails.classList.contains('is-expanded');
                advancedDetails.classList.toggle('is-expanded', shouldOpen);
                advancedSummary.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
                if (shouldOpen) {
                    advancedClip.style.display = 'none';
                    advancedDetails.open = true;
                }
                setWorldDisclosureState(advancedClip, shouldOpen, {
                    duration: 340,
                    onFinish: () => {
                        if (!shouldOpen) advancedDetails.open = false;
                    },
                });
            });
        }
        const markRefDirty = () => {
            if (this.refMode) this.scheduleRefSync();
        };
        const bindInput = (sel, key, map = (v) => v) => {
            const el = q(sel);
            if (!el) return;
            el.addEventListener('input', () => {
                entry[key] = map(el.value);
                if (key === 'comment' || key === 'key' || key === 'keysecondary') {
                    this.entrySearchCache?.delete?.(entry);
                }
                if (key === 'comment') {
                    if (this.entryCommentRenderTimer) clearTimeout(this.entryCommentRenderTimer);
                    this.entryCommentRenderTimer = setTimeout(() => {
                        this.entryCommentRenderTimer = null;
                        this.renderList();
                    }, 160);
                }
                markRefDirty();
            });
        };
        const bindNumber = (sel, key, def, min, max) => {
            const el = q(sel);
            if (!el) return;
            el.addEventListener('input', () => {
                let v = toNumber(el.value, def);
                if (min != null) v = Math.max(min, v);
                if (max != null) v = Math.min(max, v);
                entry[key] = v;
                if (key === 'order' || key === 'depth' || key === 'position') this.renderList();
                markRefDirty();
            });
        };
        const bindCheck = (sel, key) => {
            const el = q(sel);
            if (!el) return;
            el.addEventListener('change', () => {
                entry[key] = el.checked;
                this.renderList();
                markRefDirty();
            });
        };

        bindInput('#we-comment', 'comment', (v) => v);
        bindInput('#we-key', 'key', (v) => normalizeArray(v));
        bindInput('#we-keysecondary', 'keysecondary', (v) => normalizeArray(v));

        const blockContentEl = q('#we-block-content');
        if (blockContentEl) {
            if (aiLockTarget) {
                blockContentEl.style.opacity = '0.75';
                blockContentEl.setAttribute('aria-busy', 'true');
            }
            let blockScrollTimer = null;
            blockContentEl.addEventListener('input', () => {
                const nextValue = String(blockContentEl.value || '');
                if (this.editorRenderRevision !== renderRevision) {
                    if (this.isAiTraceWatchActive()) {
                        this.traceAi('input.drop.stale-render', {
                            eventRenderRevision: renderRevision,
                            liveRenderRevision: this.editorRenderRevision,
                            entryId,
                            activeBlockId,
                            valueSummary: summarizeTraceText(nextValue),
                        }, 'warn');
                    }
                    return;
                }
                const pendingEntryId = String(this.aiPendingEntryId || '').trim();
                const pendingBlockId = String(this.aiTargetBlockId || '').trim();
                const isAiLockedNow = this.aiBusy
                    && pendingEntryId
                    && pendingBlockId
                    && pendingEntryId === entryId
                    && pendingBlockId === activeBlockId;
                if (isAiLockedNow) {
                    blockContentEl.value = String(activeBlock?.content || '');
                    this.traceAi('input.drop.ai-locked', {
                        entryId,
                        activeBlockId,
                        pendingEntryId,
                        pendingBlockId,
                        valueSummary: summarizeTraceText(nextValue),
                        keptSummary: summarizeTraceText(activeBlock?.content || ''),
                    }, 'warn');
                    return;
                }
                const beforeValue = String(activeBlock?.content || '');
                activeBlock.content = nextValue;
                if (this.isAiTraceWatchActive()) {
                    const watchEntryId = String(this.aiLastWriteMeta?.entryId || '').trim();
                    const watchBlockId = String(this.aiLastWriteMeta?.blockId || '').trim();
                    const touchesWatchTarget = watchEntryId === entryId
                        && Boolean(watchBlockId)
                        && watchBlockId === activeBlockId;
                    this.traceAi('input.commit', {
                        entryId,
                        activeBlockId,
                        watchEntryId,
                        watchBlockId,
                        touchesWatchTarget,
                        beforeSummary: summarizeTraceText(beforeValue),
                        afterSummary: summarizeTraceText(nextValue),
                    }, touchesWatchTarget ? 'warn' : 'info');
                }
                this.syncEntryContentFromBlocks(entry);
                this.renderList();
                markRefDirty();
            });
            blockContentEl.addEventListener('scroll', () => {
                const shell = q('#we-block-shell');
                if (!shell) return;
                shell.classList.add('is-scrolling');
                if (blockScrollTimer) clearTimeout(blockScrollTimer);
                blockScrollTimer = setTimeout(() => {
                    shell.classList.remove('is-scrolling');
                    blockScrollTimer = null;
                }, 520);
            }, { passive: true });
        }

        const blockTitleEl = q('#we-block-title');
        if (blockTitleEl) {
            blockTitleEl.addEventListener('input', () => {
                activeBlock.title = String(blockTitleEl.value || '');
                this.renderBlockManageModalList();
                markRefDirty();
            });
        }

        const blockEnabledEl = q('#we-block-enabled');
        if (blockEnabledEl) {
            blockEnabledEl.addEventListener('change', () => {
                activeBlock.enabled = Boolean(blockEnabledEl.checked);
                this.renderBlockManageModalList();
                markRefDirty();
                this.renderEditor();
            });
        }

        const blockPriorityEl = q('#we-block-priority');
        if (blockPriorityEl) {
            blockPriorityEl.addEventListener('input', () => {
                activeBlock.priority = toNumber(blockPriorityEl.value, 100);
                this.renderBlockManageModalList();
                markRefDirty();
            });
        }

        bindNumber('#we-depth', 'depth', DEFAULT_DEPTH, 0, 1000);
        bindNumber('#we-order', 'order', 100, -9999, 9999);
        bindNumber('#we-probability', 'probability', 100, 0, 100);
        bindNumber('#we-groupWeight', 'groupWeight', DEFAULT_WEIGHT, 0, 9999);
        bindNumber('#we-delayUntilRecursion', 'delayUntilRecursion', 0, 0, 9999);

        const bindCustomSelect = ({ btnSelector, options, getValue, setValue, rerenderList = false, rerenderEditor = false }) => {
            const btn = q(btnSelector);
            if (!btn) return;
            const renderBtn = () => {
                const label = this.getOptionLabel(options, getValue(), '');
                const labelEl = btn.querySelector('span');
                if (labelEl) labelEl.textContent = label;
            };
            renderBtn();
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.openCustomSelectMenu({
                    anchorEl: btn,
                    options,
                    currentValue: getValue(),
                    onSelect: (value) => {
                        setValue(value);
                        renderBtn();
                        if (rerenderList) this.renderList();
                        if (rerenderEditor) this.renderEditor();
                        markRefDirty();
                    },
                });
            });
        };

        bindCustomSelect({
            btnSelector: '#we-position-btn',
            options: POSITION_OPTIONS,
            getValue: () => entry.position,
            setValue: (value) => {
                entry.position = toNumber(value, 0);
                const roleWrap = q('#we-role-wrap');
                if (roleWrap) roleWrap.style.display = Number(entry.position) === 4 ? '' : 'none';
                const anchorWrap = q('#we-depth-anchor-wrap');
                if (anchorWrap) anchorWrap.style.display = Number(entry.position) === 4 ? '' : 'none';
            },
            rerenderList: true,
        });

        bindCustomSelect({
            btnSelector: '#we-role-btn',
            options: ROLE_OPTIONS,
            getValue: () => entry.role,
            setValue: (value) => {
                entry.role = toNumber(value, 0);
            },
            rerenderList: true,
        });

        bindCustomSelect({
            btnSelector: '#we-depth-anchor-btn',
            options: DEPTH_ANCHOR_OPTIONS,
            getValue: () => entry.latestUserAnchor || '',
            setValue: (value) => {
                const token = String(value || '').trim().toLowerCase();
                entry.latestUserAnchor = token === 'before_latest_user' || token === 'after_latest_user' ? token : '';
            },
            rerenderList: true,
        });

        bindCustomSelect({
            btnSelector: '#we-block-role-btn',
            options: ROLE_OPTIONS,
            getValue: () => activeBlock?.role,
            setValue: (value) => {
                activeBlock.role = toNumber(value, 0);
                this.renderBlockManageModalList();
            },
            rerenderList: false,
        });

        bindCustomSelect({
            btnSelector: '#we-selectiveLogic-btn',
            options: SELECTIVE_LOGIC_OPTIONS,
            getValue: () => entry.selectiveLogic,
            setValue: (value) => {
                entry.selectiveLogic = toNumber(value, 0);
            },
            rerenderList: false,
        });

        // 覆盖类字段：checkbox 表示 true；若取消则置 null（表示不覆盖）
        const bindOverrideCheck = (sel, key) => {
            const el = q(sel);
            if (!el) return;
            el.addEventListener('change', () => {
                entry[key] = el.checked ? true : null;
                markRefDirty();
            });
        };

        bindCustomSelect({
            btnSelector: '#we-triggerStrategy-btn',
            options: TRIGGER_STRATEGY_OPTIONS,
            getValue: () => this.getEntryTriggerStrategy(entry),
            setValue: (value) => {
                this.applyEntryTriggerStrategy(entry, value);
            },
            rerenderList: true,
            rerenderEditor: true,
        });

        const selectiveEl = q('#we-selective');
        if (selectiveEl) {
            selectiveEl.addEventListener('change', () => {
                entry.selective = !entry.constant && selectiveEl.checked;
                entry.selectiveExplicit = entry.selective === true;
                markRefDirty();
            });
        }

        this.editorEl.querySelectorAll('.world-block-dot').forEach((dot) => {
            dot.addEventListener('click', () => {
                const idx = Number(dot.dataset.idx);
                if (!Number.isFinite(idx)) return;
                this.setEntryBlockPage(entry, entryId, idx);
            });
        });
        const addBlockBtn = q('#we-block-add');
        if (addBlockBtn) addBlockBtn.addEventListener('click', () => this.addPromptBlock(entry));
        const manageBtn = q('#we-block-manage');
        if (manageBtn) manageBtn.addEventListener('click', () => this.showBlockManageModal(entry, entryId));

        const blockOverlayEl = q('#we-block-overlay');
        if (blockOverlayEl) blockOverlayEl.addEventListener('click', () => this.setBlockExpanded(activeBlock?.id, false));

        const cornerBtn = q('#we-block-corner-btn');
        if (cornerBtn) {
            cornerBtn.addEventListener('click', () => {
                if (!this.isBlockExpanded(activeBlock?.id)) {
                    this.setBlockExpanded(activeBlock?.id, true);
                    return;
                }
                this.setBlockFlipped(activeBlock?.id, !this.isBlockFlipped(activeBlock?.id));
            });
        }
        const openNodeBtn = q('#we-block-open-node');
        if (openNodeBtn) {
            openNodeBtn.addEventListener('click', () => {
                this.blockConditionTargetMap.set(activeBlockId, 'block');
                this.openBlockConditionEditor(activeBlock?.id);
            });
        }
        const openEntryNodeBtn = q('#we-entry-open-node');
        if (openEntryNodeBtn) {
            openEntryNodeBtn.addEventListener('click', () => {
                this.blockConditionTargetMap.set(activeBlockId, 'entry');
                this.openBlockConditionEditor(activeBlock?.id);
            });
        }
        const editorBackBtn = q('#we-block-editor-back');
        if (editorBackBtn) {
            editorBackBtn.addEventListener('click', () => {
                this.blockConditionTargetMap.set(activeBlockId, 'block');
                this.setBlockBackView(activeBlock?.id, 'summary');
            });
        }
        const editorSaveBtn = q('#we-block-editor-save');
        if (editorSaveBtn) {
            editorSaveBtn.addEventListener('click', () => {
                void this.saveBlockConditionEditor(activeBlock?.id, conditionTarget);
            });
        }
        this.editorEl.querySelectorAll('.world-cond-overview-pending-main').forEach((btn) => {
            btn.addEventListener('click', () => {
                const nodeId = String(btn.dataset.nodeId || '').trim();
                this.openBlockNodeEditor(activeBlock?.id, nodeId ? [nodeId] : []);
            });
        });
        this.editorEl.querySelectorAll('.world-cond-overview-pending-fix').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const kind = String(btn.dataset.fixKind || '').trim();
                const fixIndex = Math.max(0, Number(btn.dataset.fixIndex || 0));
                const nodeId = String(btn.dataset.nodeId || '').trim();
                void this.applyOverviewQuickFix(activeBlock, { kind, fixIndex, nodeId });
            });
        });
        this.editorEl.querySelectorAll('.world-block-runtime-action[data-runtime-focus]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const kind = String(btn.dataset.runtimeFocus || '').trim().toLowerCase();
                const targets = this.getBlockRuntimeFocusTargets(activeBlock);
                let nodeIds = [];
                if (kind === 'hit') nodeIds = targets.hitNodeIds || [];
                else if (kind === 'miss') nodeIds = targets.missNodeIds || [];
                else if (kind === 'pending') nodeIds = targets.pendingNodeIds || [];
                else nodeIds = targets.pathNodeIds || [];
                const focusedNodeIds = this.openBlockNodeEditor(activeBlock?.id, nodeIds);
                if (!focusedNodeIds.length) {
                    window.toastr?.info?.('当前暂无可定位节点，已打开节点编辑器');
                }
            });
        });
        if (blockBackView === 'editor') {
            this.mountNodeEditor({ entry, block: conditionTarget, markRefDirty });
            window.requestAnimationFrame(() => this.maybeStartVariableGuide());
        } else if (this.variableGuideActive) {
            this.finishVariableGuide({ markSeen: false });
        }

        const blockShellEl = q('#we-block-shell');
        if (blockShellEl) {
            let startX = 0;
            let startY = 0;
            blockShellEl.addEventListener('touchstart', (event) => {
                const touch = event.touches?.[0];
                if (!touch) return;
                startX = touch.clientX;
                startY = touch.clientY;
            }, { passive: true });
            blockShellEl.addEventListener('touchend', (event) => {
                if (this.isBlockExpanded(activeBlock?.id)) return;
                const touch = event.changedTouches?.[0];
                if (!touch) return;
                const dx = touch.clientX - startX;
                const dy = touch.clientY - startY;
                if (Math.abs(dx) < 46 || Math.abs(dx) <= Math.abs(dy)) return;
                if (dx < 0 && blockPage < blocks.length - 1) {
                    this.setEntryBlockPage(entry, entryId, blockPage + 1);
                } else if (dx > 0 && blockPage > 0) {
                    this.setEntryBlockPage(entry, entryId, blockPage - 1);
                }
            }, { passive: true });
        }

        bindCheck('#we-ignoreBudget', 'ignoreBudget');
        bindCheck('#we-excludeRecursion', 'excludeRecursion');
        bindCheck('#we-preventRecursion', 'preventRecursion');

        bindCheck('#we-matchPersonaDescription', 'matchPersonaDescription');
        bindCheck('#we-matchCharacterDescription', 'matchCharacterDescription');
        bindCheck('#we-matchCharacterPersonality', 'matchCharacterPersonality');
        bindCheck('#we-matchCharacterDepthPrompt', 'matchCharacterDepthPrompt');
        bindCheck('#we-matchScenario', 'matchScenario');
        bindCheck('#we-matchCreatorNotes', 'matchCreatorNotes');

        bindInput('#we-group', 'group', (v) => v);
        bindCheck('#we-groupOverride', 'groupOverride');

        bindOverrideCheck('#we-caseSensitive', 'caseSensitive');
        bindOverrideCheck('#we-matchWholeWords', 'matchWholeWords');
        bindOverrideCheck('#we-useGroupScoring', 'useGroupScoring');

        const scanDepthEl = q('#we-scanDepth');
        if (scanDepthEl) {
            scanDepthEl.addEventListener('input', () => {
                const v = scanDepthEl.value.trim();
                entry.scanDepth = v === '' ? null : toNumber(v, null);
                markRefDirty();
            });
        }

        bindCheck('#we-useProbability', 'useProbability');

        const dupBtn = q('#we-duplicate');
        if (dupBtn) {
            if (this.refMode) {
                dupBtn.disabled = true;
                dupBtn.style.opacity = '0.6';
                dupBtn.style.cursor = 'not-allowed';
            } else {
                dupBtn.onclick = () => this.duplicateEntry(this.currentIndex);
            }
        }
        const delBtn = q('#we-delete');
        if (delBtn) {
            if (this.refMode) {
                delBtn.disabled = true;
                delBtn.style.opacity = '0.6';
                delBtn.style.cursor = 'not-allowed';
            } else {
                delBtn.onclick = () => this.deleteEntry(this.currentIndex);
            }
        }
        const transferBtn = q('#we-transfer');
        if (transferBtn) {
            if (this.refMode) {
                transferBtn.disabled = true;
                transferBtn.style.opacity = '0.6';
                transferBtn.style.cursor = 'not-allowed';
                transferBtn.title = '引用型世界书的条目需在来源世界书中操作';
            } else {
                transferBtn.onclick = () => this.promptEntryTransfer(this.currentIndex);
            }
        }
        const aiBtn = q('#we-ai-generate');
        if (aiBtn) aiBtn.onclick = () => this.showAiModal(entry);
    }

    addEntry() {
        const newEntry = createDefaultEntry(this.data.entries.length);
        newEntry.id = `entry-${Date.now()}`;
        this.data.entries.unshift(newEntry);
        this.selectEntry(0, { forceRenderList: true });
    }

    duplicateEntry(index) {
        const base = this.data.entries[index];
        if (!base) return;
        const copy = normalizeEntry(deepClone(base), this.data.entries.length);
        copy.id = `entry-${Date.now()}`;
        copy.comment = `${copy.comment || 'entry'}（复制）`;
        this.data.entries.splice(index + 1, 0, copy);
        this.selectEntry(index + 1, { forceRenderList: true });
    }

    async transferEntryToWorld({
        mode = '',
        targetWorldId = '',
        entryId = '',
        entryIndex = this.currentIndex,
    } = {}) {
        if (this.refMode) return { ok: false, reason: 'source-reference-world' };
        const action = String(mode || '').trim().toLowerCase();
        const sourceWorldId = String(this.worldName || '').trim();
        const targetId = String(targetWorldId || '').trim();
        const bridge = resolveWorldEditorBridgeContext();
        if (typeof bridge.getWorldInfoSnapshot !== 'function' || typeof bridge.saveWorldInfo !== 'function') {
            return { ok: false, reason: 'bridge-unavailable' };
        }

        const sourceData = this.prepareForSave(sourceWorldId);
        let plan = null;
        let targetSaveResult = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const targetSnapshot = await bridge.getWorldInfoSnapshot(targetId);
            if (!targetSnapshot?.exists || !targetSnapshot?.data) {
                return { ok: false, reason: 'target-missing' };
            }
            plan = buildWorldEntryTransferPlan({
                mode: action,
                sourceWorldId,
                targetWorldId: targetId,
                sourceData,
                targetData: targetSnapshot.data,
                entryId,
                entryIndex,
                createEntryId: () => `entry-${Date.now()}`,
            });
            if (!plan.ok) return plan;
            targetSaveResult = await bridge.saveWorldInfo(targetId, plan.targetData, {
                expectedRevision: targetSnapshot.revision,
                expectedGeneration: targetSnapshot.generation,
                expectedExists: true,
                conflictMode: 'return',
            });
            if (targetSaveResult?.ok === false && targetSaveResult.reason === 'worldbook_revision_conflict') {
                continue;
            }
            if (targetSaveResult?.ok === false) {
                return { ...targetSaveResult, targetWorldId: targetId };
            }
            break;
        }
        if (!plan || !targetSaveResult || targetSaveResult?.ok === false) {
            return { ok: false, reason: 'target-busy', targetWorldId: targetId };
        }

        const savedTargetData = deepClone(targetSaveResult.data || plan.targetData);
        if (action === 'copy') {
            this.onSaved?.(targetId, savedTargetData);
            return {
                ok: true,
                mode: action,
                sourceWorldId,
                targetWorldId: targetId,
                transferredEntryId: plan.transferredEntryId,
            };
        }

        let sourceSaveResult = null;
        try {
            sourceSaveResult = await bridge.saveWorldInfo(sourceWorldId, plan.sourceData, {
                expectedRevision: this.baseRevision,
                expectedGeneration: this.baseGeneration,
                expectedExists: true,
                conflictMode: 'return',
            });
        } catch (error) {
            this.onSaved?.(targetId, savedTargetData);
            return {
                ok: false,
                reason: 'source-save-failed',
                targetSaved: true,
                sourceWorldId,
                targetWorldId: targetId,
                error,
            };
        }
        if (sourceSaveResult?.ok === false) {
            this.onSaved?.(targetId, savedTargetData);
            return {
                ok: false,
                reason: 'source-save-failed',
                targetSaved: true,
                sourceWorldId,
                targetWorldId: targetId,
                sourceResult: sourceSaveResult,
            };
        }

        this.worldName = sourceWorldId;
        this.originalName = sourceWorldId;
        this.data = deepClone(sourceSaveResult?.data || plan.sourceData);
        this.baseWorldData = deepClone(this.data);
        this.baseRevision = sourceSaveResult?.revision ?? null;
        this.baseGeneration = sourceSaveResult?.generation ?? null;
        this.selectedEntries.delete(plan.originalEntryId);
        this.entryBlockPageMap.delete(plan.originalEntryId);
        this.entrySearchCache = new WeakMap();
        const nextIndex = Math.max(0, Math.min(plan.sourceEntryIndex, this.data.entries.length - 1));
        this.selectEntry(nextIndex, { forceRenderList: true });
        this.onSaved?.(this.worldName, this.data);
        return {
            ok: true,
            mode: action,
            sourceWorldId,
            targetWorldId: targetId,
            transferredEntryId: plan.transferredEntryId,
        };
    }

    async promptEntryTransfer(index = this.currentIndex) {
        if (this.refMode) {
            window.toastr?.warning?.('引用型世界书请到来源世界书操作条目');
            return false;
        }
        const entry = this.data.entries[index];
        if (!entry) return false;
        const entryId = this.getEntryId(entry, index);
        const entryName = this.getEntryDisplayName(entry, index);
        const mode = await appChoice({
            title: '移动或复制条目',
            message: `条目「${entryName}」要如何处理？`,
            actions: [
                { id: 'move', label: '移动（此处不保留）' },
                { id: 'copy', label: '复制（此处保留）', primary: true },
                { id: 'cancel', label: '取消' },
            ],
            defaultActionId: 'copy',
        });
        if (mode !== 'move' && mode !== 'copy') return false;

        try {
            const { listWorlds } = resolveWorldEditorBridgeContext();
            const sourceWorldId = String(this.worldName || '').trim();
            const targets = (typeof listWorlds === 'function' ? await listWorlds() : [])
                .map(name => String(name || '').trim())
                .filter(name => name && name !== sourceWorldId)
                .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
            if (!targets.length) {
                window.toastr?.warning?.('没有其他世界书可作为目标');
                return false;
            }
            const targetAction = await appChoice({
                title: mode === 'move' ? '移动到世界书' : '复制到世界书',
                message: `选择「${entryName}」的目标世界书`,
                actions: [
                    ...targets.map((name, targetIndex) => ({
                        id: `target_${targetIndex}`,
                        label: name,
                    })),
                    { id: 'cancel', label: '取消' },
                ],
                defaultActionId: 'target_0',
            });
            if (!String(targetAction || '').startsWith('target_')) return false;
            const targetIndex = Number(String(targetAction).slice('target_'.length));
            const targetWorldId = Number.isInteger(targetIndex) ? targets[targetIndex] : '';
            if (!targetWorldId) return false;

            const sourceSaved = await this.saveWorldSilently({ showToast: false });
            if (!sourceSaved) {
                window.toastr?.warning?.('当前世界书尚未保存，未执行移动或复制');
                return false;
            }
            const resolved = this.resolveEntryById(entryId);
            if (!resolved.entry || resolved.idx < 0) {
                window.toastr?.warning?.('条目已发生变化，请重新选择');
                return false;
            }
            const result = await this.transferEntryToWorld({
                mode,
                targetWorldId,
                entryId,
                entryIndex: resolved.idx,
            });
            if (result.ok) {
                window.toastr?.success?.(mode === 'move'
                    ? `已移动到「${targetWorldId}」`
                    : `已复制到「${targetWorldId}」`);
                return true;
            }
            if (result.reason === 'source-save-failed' && result.targetSaved) {
                window.toastr?.warning?.(`已复制到「${targetWorldId}」，但来源删除失败；原条目已保留`);
                return false;
            }
            const messages = {
                'target-reference-world': '引用型世界书不能作为目标，请选择实际世界书',
                'target-missing': '目标世界书已不存在，请重新选择',
                'entry-missing': '条目已不存在，请重新选择',
                'same-world': '请选择另一本世界书',
                'target-busy': '目标世界书正在变更，请稍后重试',
            };
            window.toastr?.warning?.(messages[result.reason] || '移动或复制失败，请稍后重试');
            return false;
        } catch (err) {
            logger.error('移动或复制世界书条目失败', err);
            window.toastr?.error?.('移动或复制失败，请检查控制台');
            return false;
        }
    }

    deleteEntry(index) {
        if (this.data.entries.length <= 1) {
            window.toastr?.warning('至少保留一个条目');
            return;
        }
        this.data.entries.splice(index, 1);
        this.selectEntry(Math.max(0, index - 1), { forceRenderList: true });
    }

    ensureUniqueSessionId(baseName, contactsStore) {
        const name = String(baseName || '').trim() || '新聊天室';
        let sessionId = name;
        let idx = 1;
        while (contactsStore.getContact(sessionId)) {
            sessionId = `${name}_${idx}`;
            idx += 1;
        }
        return { sessionId, name };
    }

    async ensureUniqueWorldbookId(baseName, { allowUnicode = false } = {}) {
        return ensureUniqueWorldbookIdCore({
            ...resolveWorldEditorBridgeContext(),
            baseName,
            allowUnicode,
        });
    }

    buildWorldRefs(entries = [], { includeAll = false } = {}) {
        const sourceWorldId = String(this.worldName || '').trim();
        if (!sourceWorldId) return [];
        if (includeAll) {
            return [{ sourceId: sourceWorldId, includeAll: true }];
        }
        const list = Array.isArray(entries) ? entries : [];
        const refs = [];
        const seen = new Set();
        list.forEach((entry, idx) => {
            const entryId = this.getEntryId(entry, idx);
            if (!entryId || seen.has(entryId)) return;
            seen.add(entryId);
            refs.push({ sourceId: sourceWorldId, entryId });
        });
        return refs;
    }

    async resolveRefEntriesForDisplay(refs = []) {
        return resolveRefEntriesForDisplayCore({
            ...resolveWorldEditorBridgeContext(),
            refs,
        });
    }

    async createChatFromEntries(entries, { name = '', includeAll = false } = {}) {
        const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
        if (!list.length) {
            window.toastr?.warning?.('未选择任何条目');
            return;
        }
        const {
            contactsStore,
            chatStore,
            saveWorldInfo,
            bindWorldToSession,
        } = resolveWorldEditorBridgeContext();
        if (!contactsStore || !chatStore) {
            window.toastr?.warning?.('联系人/会话尚未就绪');
            return;
        }
        const baseName = String(name || '').trim() || String(list[0]?.comment || list[0]?.title || '新聊天室').trim() || '新聊天室';
        const { sessionId, name: resolvedName } = this.ensureUniqueSessionId(baseName, contactsStore);
        contactsStore.upsertContact({
            id: sessionId,
            name: resolvedName,
            avatar: '',
            isGroup: false,
            addedAt: Date.now(),
            description: '',
            source: 'world_entry',
            isUserCreated: true,
        });
        if (typeof chatStore._ensureSession === 'function') {
            chatStore._ensureSession(sessionId);
            const settings = chatStore.getSessionSettings?.(sessionId) || {};
            chatStore.setSessionSettings?.(sessionId, { ...settings, sharedVariables: true, sharedMemory: false });
            chatStore._persist?.();
        }
        window.dispatchEvent(new CustomEvent('contacts-updated', { detail: { id: sessionId, source: 'world_entry' } }));
        list.forEach((entry) => {
            const splitTo = Array.isArray(entry.splitTo) ? entry.splitTo.slice() : [];
            if (!splitTo.includes(sessionId)) splitTo.push(sessionId);
            entry.splitTo = splitTo;
        });
        const refs = this.buildWorldRefs(list, { includeAll });
        if (refs.length) {
            const worldName = resolvedName;
            const worldId = await this.ensureUniqueWorldbookId(worldName, { allowUnicode: true });
            const payload = {
                name: worldName,
                entries: [],
                refs,
                source: 'world_entry',
            };
            await saveWorldInfo?.(worldId, payload);
            bindWorldToSession?.(sessionId, worldId, { silent: true });
        } else {
            window.toastr?.warning?.('未能创建引用世界书，请稍后重试');
        }
        this.renderList();
        this.renderEditor();
        this.saveWorldSilently?.({ showToast: false });
        window.toastr?.success?.(`已创建聊天室：${resolvedName}`);
    }

    async createChatFromEntry(entry) {
        if (!entry) return;
        await this.createChatFromEntries([entry], { name: entry.comment || entry.title || '' });
    }

    prepareForSave(nameOverride = this.worldName) {
        const sourceEntries = this.refMode ? (this.refLocalEntries || []) : this.data.entries;
        const isCharacterCardWorld = String(this.data?.source || '').trim() === 'character_card';
        const entries = sourceEntries.map((entry, i) => {
            const e = normalizeEntry(entry, i, {
                characterCardWorld: isCharacterCardWorld,
            });
            // 兼容旧命名
            e.title = e.comment;
            e.triggers = e.key;
            e.secondary = e.keysecondary;
            e.priority = e.order;
            return compactNormalizedEntryForSave(e, i);
        });
        return { ...(this.data || {}), name: nameOverride, entries };
    }

    async saveRefEdits({ showToast = true } = {}) {
        try {
            const list = Array.isArray(this.data?.entries) ? this.data.entries : [];
            if (this.isAiTraceWatchActive()) {
                const watchEntryId = String(this.aiLastWriteMeta?.entryId || '').trim();
                const touchedCount = watchEntryId
                    ? list.filter((item, idx) => this.getEntryId(item, idx) === watchEntryId || String(item?._refEntryId || '').trim() === watchEntryId).length
                    : 0;
                this.traceAi('ref.save.start', {
                    showToast,
                    listCount: list.length,
                    watchEntryId,
                    touchedCount,
                });
            }
            if (!list.length) {
                if (showToast) window.toastr?.warning?.('没有可同步的条目');
                return false;
            }
            const cleanRefEntry = (entry, idx, targetId = '') => {
                const cleaned = compactNormalizedEntryForSave(normalizeEntry(entry, idx), idx);
                delete cleaned._refSourceId;
                delete cleaned._refWorldId;
                delete cleaned._refEntryId;
                delete cleaned._refEntryIndex;
                if (targetId) cleaned.id = targetId;
                if (cleaned.uid == null && /^\d+$/.test(cleaned.id)) cleaned.uid = Number(cleaned.id);
                return cleaned;
            };
            const refEntryKey = (entry, idx) => {
                const sourceId = String(entry?._refSourceId || '').trim();
                const targetId = String(entry?._refEntryId ?? entry?.id ?? entry?.uid ?? '').trim();
                const fallbackIndex = Number.isFinite(Number(entry?._refEntryIndex))
                    ? Number(entry._refEntryIndex)
                    : idx;
                return `${sourceId}\u0000${targetId || `index:${fallbackIndex}`}`;
            };
            const baseByKey = new Map();
            (Array.isArray(this.refBaseEntries) ? this.refBaseEntries : []).forEach((entry, idx) => {
                const targetId = String(entry?._refEntryId ?? entry?.id ?? entry?.uid ?? '').trim();
                baseByKey.set(refEntryKey(entry, idx), cleanRefEntry(entry, idx, targetId));
            });
            const updatesBySource = new Map();
            list.forEach((entry, idx) => {
                const sourceId = String(entry?._refSourceId || '').trim();
                if (!sourceId) return;
                const targetId = String(entry?._refEntryId ?? entry?.id ?? entry?.uid ?? '').trim();
                const fallbackIndex = Number.isFinite(Number(entry?._refEntryIndex)) ? Number(entry._refEntryIndex) : idx;
                const cleaned = cleanRefEntry(entry, idx, targetId);
                if (!updatesBySource.has(sourceId)) updatesBySource.set(sourceId, []);
                updatesBySource.get(sourceId).push({
                    targetId,
                    fallbackIndex,
                    key: refEntryKey(entry, idx),
                    data: cleaned,
                    baseData: baseByKey.get(refEntryKey(entry, idx)) || null,
                });
            });
            if (!updatesBySource.size) {
                if (showToast) window.toastr?.warning?.('未找到可同步的来源世界书');
                return false;
            }
            const { getWorldInfo, saveWorldInfo } = resolveWorldEditorBridgeContext();
            if (typeof getWorldInfo !== 'function' || typeof saveWorldInfo !== 'function') {
                if (showToast) window.toastr?.warning?.('来源世界书暂时不可用');
                return false;
            }
            const updatedSources = [];
            let updatedCount = 0;
            let failedCount = 0;
            const appliedEntries = new Map();
            const applySavedEntries = () => {
                if (!appliedEntries.size) return;
                this.data.entries = this.data.entries.map((entry, idx) => {
                    const merged = appliedEntries.get(refEntryKey(entry, idx));
                    if (!merged) return entry;
                    return {
                        ...deepClone(merged),
                        _refSourceId: entry._refSourceId,
                        ...(entry._refWorldId !== undefined ? { _refWorldId: entry._refWorldId } : {}),
                        _refEntryId: entry._refEntryId,
                        _refEntryIndex: entry._refEntryIndex,
                    };
                });
                this.refBaseEntries = deepClone(this.data.entries);
            };
            for (const [sourceId, updates] of updatesBySource.entries()) {
                let sourceSaved = false;
                let plannedCount = 0;
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    let sourceData = null;
                    try {
                        sourceData = await getWorldInfo?.(sourceId);
                    } catch {}
                    if (!sourceData || !Array.isArray(sourceData.entries)) break;
                    const nextEntries = sourceData.entries.map((item) => ({ ...item }));
                    const mergedUpdates = [];
                    const conflicts = [];
                    updates.forEach(({ targetId, fallbackIndex, key, data, baseData }) => {
                        let idx = -1;
                        if (targetId) {
                            idx = nextEntries.findIndex(item => String(item?.id ?? item?.uid ?? '').trim() === targetId);
                        }
                        const mayUseLegacyIndex = !targetId || /^entry-\d+$/.test(targetId);
                        if (
                            idx < 0
                            && mayUseLegacyIndex
                            && Number.isFinite(fallbackIndex)
                            && fallbackIndex >= 0
                            && fallbackIndex < nextEntries.length
                        ) {
                            idx = fallbackIndex;
                        }
                        if (idx < 0) {
                            conflicts.push({
                                sourceId,
                                path: `entries.${targetId || `index:${fallbackIndex}`}`,
                                base: baseData,
                                local: data,
                                latest: undefined,
                            });
                            return;
                        }
                        let mergedEntry = { ...nextEntries[idx], ...data };
                        if (baseData) {
                            const baseWorld = { entries: [baseData] };
                            const latestWorld = this.normalizeWorldDataForMerge(
                                { entries: [nextEntries[idx]] },
                                sourceId,
                                baseWorld,
                            );
                            const merge = mergeWorldbookChanges({
                                base: baseWorld,
                                local: { entries: [data] },
                                latest: latestWorld,
                            });
                            if (merge.conflicts.length) {
                                conflicts.push(...merge.conflicts.map(conflict => ({ ...conflict, sourceId })));
                                return;
                            }
                            mergedEntry = merge.merged.entries[0];
                        }
                        nextEntries[idx] = mergedEntry;
                        mergedUpdates.push({ key, data: mergedEntry });
                    });
                    plannedCount = mergedUpdates.length;
                    if (conflicts.length) {
                        applySavedEntries();
                        await this.reviewRefWorldSaveConflict({ conflicts });
                        return false;
                    }
                    if (!plannedCount) break;
                    try {
                        const result = await saveWorldInfo?.(sourceId, { ...sourceData, entries: nextEntries });
                        if (result?.ok === false && result?.reason === 'worldbook_revision_conflict') continue;
                        mergedUpdates.forEach(item => appliedEntries.set(item.key, item.data));
                        updatedCount += plannedCount;
                        updatedSources.push(sourceId);
                        sourceSaved = true;
                        break;
                    } catch (error) {
                        const reason = String(error?.code || error?.details?.reason || '').trim();
                        if (reason === 'worldbook_revision_conflict') continue;
                        throw error;
                    }
                }
                if (!sourceSaved) failedCount += updates.length || plannedCount;
            }
            applySavedEntries();
            if (showToast) {
                if (updatedCount > 0) {
                    const labels = updatedSources.length ? `（${updatedSources.join('、')}）` : '';
                    window.toastr?.success?.(`已同步到来源世界书${labels}`);
                } else {
                    window.toastr?.warning?.('未找到可同步的条目');
                }
                if (failedCount > 0) {
                    window.toastr?.warning?.('部分来源世界书不可用，已跳过');
                }
            }
            if (this.isAiTraceWatchActive()) {
                this.traceAi('ref.save.finish', {
                    updatedCount,
                    failedCount,
                    updatedSources: updatedSources.join(','),
                }, updatedCount > 0 ? 'info' : 'warn');
            }
            return updatedCount > 0;
        } catch (err) {
            logger.error('同步引用世界书失败', err);
            if (this.isAiTraceWatchActive()) {
                this.traceAi('ref.save.error', {
                    message: err?.message || 'unknown',
                }, 'error');
            }
            if (showToast) window.toastr?.error?.('同步失败，请检查控制台');
            return false;
        }
    }

    sanitizeExportName(name, fallback = 'worldbook') {
        const raw = String(name || '').trim();
        const safe = raw.replace(/[\\/:*?"<>|]+/g, '_').trim();
        return safe || fallback;
    }

    async pickSavePath(defaultName) {
        return pickNativeSavePath({
            defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
    }

    async exportWorld() {
        try {
            const nextName = String(this.nameInputEl?.value || '').trim();
            if (!nextName) {
                window.toastr?.warning('名称不能为空');
                return;
            }
            const payload = this.prepareForSave(nextName);

            // 追加绑定正则集合（便于导入时自动带上）
            const bound = await collectBoundWorldRegexSets({
                ...resolveWorldEditorBridgeContext(),
                worldId: nextName,
            });
            if (bound.length) payload.boundRegexSets = bound;

            const baseName = String(nextName || '').trim() || 'worldbook';
            const filename = baseName.toLowerCase().endsWith('.json')
                ? baseName
                : `${baseName}.json`;

            if (!hasTauriRuntime()) {
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                window.toastr?.success(`已导出：${filename}`);
                return;
            }

            const pick = await this.pickSavePath(filename);
            if (pick.cancelled) return;
            const dataUrl = buildJsonDataUrl(payload);
            const resp = pick.fallback
                ? await safeInvoke('export_attachment', { dataUrl, fileName: filename })
                : await safeInvoke('export_attachment', { dataUrl, fileName: filename, path: pick.path });
            const savedPath = String(resp?.path || '').trim();
            if (savedPath) {
                window.toastr?.success(`已导出：${savedPath}`);
            } else {
                window.toastr?.success(`已导出：${filename}`);
            }
        } catch (err) {
            logger.error('导出世界书失败', err);
            window.toastr?.error('导出失败');
        }
    }

    normalizeWorldDataForMerge(data, fallbackName = this.worldName, alignPromptBlockIdsFrom = null) {
        const source = deepClone(data || { name: fallbackName, entries: [] });
        const isCharacterCardWorld = String(source?.source || '').trim() === 'character_card';
        const entryIdentity = (entry, index) => {
            const id = String(entry?.id ?? '').trim();
            if (id) return id;
            if (entry?.uid !== null && entry?.uid !== undefined && String(entry.uid).trim()) {
                return `uid:${String(entry.uid).trim()}`;
            }
            return `index:${index}`;
        };
        const referenceEntries = Array.isArray(alignPromptBlockIdsFrom?.entries)
            ? alignPromptBlockIdsFrom.entries
            : [];
        const referenceById = new Map(
            referenceEntries.map((entry, index) => [entryIdentity(entry, index), entry]),
        );
        const entries = (Array.isArray(source.entries) ? source.entries : []).map((entry, index) => {
            const normalized = normalizeEntry(entry, index, { characterCardWorld: isCharacterCardWorld });
            const sourceBlocks = Array.isArray(entry?.promptBlocks) ? entry.promptBlocks : [];
            const referenceBlocks = referenceById.get(entryIdentity(entry, index))?.promptBlocks;
            if (Array.isArray(referenceBlocks)) {
                normalized.promptBlocks.forEach((block, blockIndex) => {
                    const sourceId = String(sourceBlocks[blockIndex]?.id || '').trim();
                    const referenceId = String(referenceBlocks[blockIndex]?.id || '').trim();
                    if (!sourceId && referenceId) block.id = referenceId;
                });
            }
            normalized.title = normalized.comment;
            normalized.triggers = normalized.key;
            normalized.secondary = normalized.keysecondary;
            normalized.priority = normalized.order;
            return compactNormalizedEntryForSave(normalized, index);
        });
        return {
            ...source,
            name: String(source?.name || fallbackName || '').trim(),
            entries,
        };
    }

    async resolveWorldConflictSnapshot(result = {}) {
        if (result?.latestSnapshot && typeof result.latestSnapshot === 'object') {
            return result.latestSnapshot;
        }
        const { getWorldInfoSnapshot, getWorldInfo } = resolveWorldEditorBridgeContext();
        if (typeof getWorldInfoSnapshot === 'function') {
            return await getWorldInfoSnapshot(this.worldName);
        }
        const data = typeof getWorldInfo === 'function' ? await getWorldInfo(this.worldName) : null;
        return { worldbookId: this.worldName, exists: Boolean(data), data, revision: null, generation: null };
    }

    async makeConflictCopyName(nextName = this.worldName) {
        const { listWorlds } = resolveWorldEditorBridgeContext();
        const existing = new Set(
            (typeof listWorlds === 'function' ? await listWorlds() : [])
                ?.map?.(item => String(item || '').trim())
                .filter(Boolean) || [],
        );
        const base = `${String(nextName || this.worldName || '世界书').trim()}（冲突副本）`;
        if (!existing.has(base)) return base;
        let index = 2;
        while (existing.has(`${base} ${index}`) && index < 1000) index += 1;
        return `${base} ${index}`;
    }

    async saveWorldConflictCopy(nextName, payload) {
        const { getWorldInfoSnapshot, saveWorldInfo } = resolveWorldEditorBridgeContext();
        if (typeof saveWorldInfo !== 'function') return { ok: false, reason: 'save-unavailable' };
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const copyName = await this.makeConflictCopyName(nextName);
            const snapshot = typeof getWorldInfoSnapshot === 'function'
                ? await getWorldInfoSnapshot(copyName)
                : { exists: false, revision: null, generation: null };
            const copyPayload = { ...deepClone(payload), name: copyName };
            const result = await saveWorldInfo(copyName, copyPayload, {
                ...(snapshot?.revision !== null && snapshot?.revision !== undefined
                    ? { expectedRevision: snapshot.revision }
                    : {}),
                ...(snapshot?.generation !== null && snapshot?.generation !== undefined
                    ? { expectedGeneration: snapshot.generation }
                    : {}),
                expectedExists: false,
                conflictMode: 'return',
            });
            if (result?.ok === false && result?.reason === 'worldbook_revision_conflict') continue;
            if (result?.ok === false) return result;
            return {
                ok: true,
                worldName: copyName,
                payload: result?.data || copyPayload,
                revision: result?.revision ?? null,
                generation: result?.generation ?? null,
                savedAsCopy: true,
            };
        }
        return { ok: false, reason: 'worldbook_busy' };
    }

    async reviewWorldSaveConflict({ nextName, payload, latestSnapshot, conflicts }) {
        const items = conflicts.slice(0, 20).map((conflict, index) => ({
            id: `conflict-${index + 1}`,
            label: formatWorldbookConflictPath(conflict.path),
            meta: '你的草稿与最新内容都修改了这里',
            status: '冲突',
            warning: true,
        }));
        const message = `世界书在编辑期间被其他操作修改，发现 ${conflicts.length} 处重叠。APP 不会自动覆盖任何一方。`;
        let choice = await appChoice({
            title: '世界书内容冲突',
            message,
            actions: [
                { id: 'review', label: '查看冲突', primary: true },
                { id: 'load_latest', label: '载入最新' },
                { id: 'save_copy', label: '另存副本' },
                { id: 'cancel', label: '保留草稿' },
            ],
            defaultActionId: 'review',
        });
        if (choice === 'review') {
            choice = await appChoice({
                title: '冲突字段',
                message: `${message}\n请选择处理方式。`,
                items,
                actions: [
                    { id: 'load_latest', label: '载入最新' },
                    { id: 'save_copy', label: '另存副本', primary: true },
                    { id: 'cancel', label: '保留草稿' },
                ],
                defaultActionId: 'save_copy',
            });
        }
        if (choice === 'load_latest') {
            await this.show(this.worldName, latestSnapshot?.data, { snapshot: latestSnapshot });
            window.toastr?.info?.('已载入最新世界书；原草稿未覆盖远端内容');
            return { ok: false, handled: true, reason: 'loaded-latest' };
        }
        if (choice === 'save_copy') {
            const copy = await this.saveWorldConflictCopy(nextName, payload);
            if (!copy.ok) window.toastr?.warning?.('另存副本失败，请稍后重试');
            return copy;
        }
        window.toastr?.info?.('已保留当前草稿，尚未写入世界书');
        return { ok: false, handled: true, reason: 'draft-kept' };
    }

    async reviewRefWorldSaveConflict({ conflicts = [] } = {}) {
        const items = conflicts.slice(0, 20).map((conflict, index) => ({
            id: `ref-conflict-${index + 1}`,
            label: `${String(conflict.sourceId || '来源世界书')} / ${formatWorldbookConflictPath(conflict.path)}`,
            meta: '你的引用草稿与来源世界书最新内容都修改了这里',
            status: '冲突',
            warning: true,
        }));
        const message = `引用来源在编辑期间被其他操作修改，发现 ${conflicts.length} 处重叠。APP 不会自动覆盖任何一方。`;
        let choice = await appChoice({
            title: '引用世界书内容冲突',
            message,
            actions: [
                { id: 'review', label: '查看冲突', primary: true },
                { id: 'load_latest', label: '载入最新' },
                { id: 'cancel', label: '保留草稿' },
            ],
            defaultActionId: 'review',
        });
        if (choice === 'review') {
            choice = await appChoice({
                title: '引用来源冲突字段',
                message: `${message}\n请选择处理方式。`,
                items,
                actions: [
                    { id: 'load_latest', label: '载入最新', primary: true },
                    { id: 'cancel', label: '保留草稿' },
                ],
                defaultActionId: 'load_latest',
            });
        }
        if (choice === 'load_latest') {
            const { getWorldInfoSnapshot, getWorldInfo } = resolveWorldEditorBridgeContext();
            const snapshot = typeof getWorldInfoSnapshot === 'function'
                ? await getWorldInfoSnapshot(this.worldName)
                : null;
            const data = snapshot?.data || (typeof getWorldInfo === 'function'
                ? await getWorldInfo(this.worldName)
                : null);
            await this.show(this.worldName, data, snapshot ? { snapshot } : {});
            window.toastr?.info?.('已重新载入引用来源的最新内容');
            return false;
        }
        window.toastr?.info?.('已保留当前引用草稿，冲突字段尚未写入来源世界书');
        return false;
    }

    async commitWorldPayload(nextName, payload) {
        let base = deepClone(this.baseWorldData || this.normalizeWorldDataForMerge(this.data, this.worldName));
        let candidate = deepClone(payload);
        let expectedRevision = this.baseRevision;
        let expectedGeneration = this.baseGeneration;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const saveResult = await saveWorldInfoWithName({
                ...resolveWorldEditorBridgeContext(),
                currentName: this.worldName,
                nextName,
                payload: candidate,
                expectedRevision,
                expectedGeneration,
            });
            if (saveResult.ok) {
                return {
                    ok: true,
                    worldName: saveResult.worldName,
                    payload: saveResult.data || candidate,
                    revision: saveResult.revision ?? null,
                    generation: saveResult.generation ?? null,
                };
            }
            if (saveResult.reason === 'duplicate-name' || saveResult.reason === 'worldbook_name_conflict') {
                return { ok: false, reason: 'duplicate-name' };
            }
            if (saveResult.reason !== 'worldbook_revision_conflict') return saveResult;

            const latestSnapshot = await this.resolveWorldConflictSnapshot(saveResult);
            if (!latestSnapshot?.exists || !latestSnapshot?.data) {
                return await this.reviewWorldSaveConflict({
                    nextName,
                    payload: candidate,
                    latestSnapshot,
                    conflicts: [{ path: '世界书', local: candidate, latest: undefined }],
                });
            }
            const latest = this.normalizeWorldDataForMerge(latestSnapshot.data, this.worldName, base);
            const merge = mergeWorldbookChanges({ base, local: candidate, latest });
            if (merge.conflicts.length) {
                return await this.reviewWorldSaveConflict({
                    nextName,
                    payload: candidate,
                    latestSnapshot,
                    conflicts: merge.conflicts,
                });
            }
            base = latest;
            candidate = merge.merged;
            expectedRevision = latestSnapshot.revision ?? null;
            expectedGeneration = latestSnapshot.generation ?? null;
        }
        return { ok: false, reason: 'worldbook_busy' };
    }

    async saveWorld() {
        try {
            if (this.refMode) {
                const ok = await this.saveRefEdits({ showToast: true });
                if (ok) this.onSaved?.(this.worldName, this.data);
                this.hide();
                return;
            }
            const nextName = String(this.nameInputEl?.value || '').trim();
            if (!nextName) {
                window.toastr?.warning('名称不能为空');
                return;
            }
            const payload = this.prepareForSave(nextName);
            const saveResult = await this.commitWorldPayload(nextName, payload);
            if (saveResult.reason === 'duplicate-name') {
                window.toastr?.warning('名称已存在，请换一个');
                return;
            }
            if (!saveResult.ok) {
                if (!saveResult.handled) window.toastr?.warning?.('世界书暂时无法保存，请稍后重试');
                return;
            }
            this.worldName = saveResult.worldName;
            this.data = deepClone(saveResult.payload || payload);
            this.baseWorldData = deepClone(this.data);
            this.baseRevision = saveResult.revision;
            this.baseGeneration = saveResult.generation;
            window.toastr?.success(saveResult.savedAsCopy
                ? `已另存冲突副本：${this.worldName}`
                : `世界书已保存：${this.worldName}`);
            this.onSaved?.(this.worldName, this.data);
            this.hide();
        } catch (err) {
            logger.error('保存世界书失败', err);
            window.toastr?.error('保存失败，请检查控制台');
        }
    }

    async saveWorldSilently({ showToast = true } = {}) {
        try {
            if (this.isAiTraceWatchActive()) {
                const watchEntryId = String(this.aiLastWriteMeta?.entryId || '').trim();
                const watchBlockId = String(this.aiLastWriteMeta?.blockId || '').trim();
                const { idx, entry } = watchEntryId ? this.resolveEntryById(watchEntryId) : { idx: -1, entry: null };
                const blocks = entry ? this.ensureEntryPromptBlocks(entry) : [];
                const watchedBlock = watchBlockId
                    ? blocks.find((item) => String(item?.id || '').trim() === watchBlockId)
                    : null;
                this.traceAi('save.silent.start', {
                    showToast,
                    refMode: this.refMode,
                    worldName: this.worldName,
                    watchEntryId,
                    watchBlockId,
                    watchEntryIndex: idx,
                    watchBlockSummary: summarizeTraceText(String(watchedBlock?.content || '')),
                });
            }
            if (this.refMode) {
                const ok = await this.saveRefEdits({ showToast });
                if (ok) this.onSaved?.(this.worldName, this.data);
                if (this.isAiTraceWatchActive()) {
                    this.traceAi('save.silent.finish', {
                        refMode: true,
                        ok,
                    }, ok ? 'info' : 'warn');
                }
                return ok;
            }
            const nextName = String(this.nameInputEl?.value || '').trim();
            if (!nextName) {
                if (showToast) window.toastr?.warning?.('名称不能为空');
                if (this.isAiTraceWatchActive()) {
                    this.traceAi('save.silent.reject.empty-name', {}, 'warn');
                }
                return false;
            }
            const payload = this.prepareForSave(nextName);
            const saveResult = await this.commitWorldPayload(nextName, payload);
            if (saveResult.reason === 'duplicate-name') {
                if (showToast) window.toastr?.warning?.('名称已存在，无法自动保存');
                if (this.isAiTraceWatchActive()) {
                    this.traceAi('save.silent.reject.duplicate-name', {
                        nextName,
                    }, 'warn');
                }
                return false;
            }
            if (!saveResult.ok) {
                if (showToast && !saveResult.handled) window.toastr?.warning?.('世界书暂时无法保存，请稍后重试');
                return false;
            }
            this.worldName = saveResult.worldName;
            this.data = deepClone(saveResult.payload || payload);
            this.baseWorldData = deepClone(this.data);
            this.baseRevision = saveResult.revision;
            this.baseGeneration = saveResult.generation;
            this.onSaved?.(this.worldName, this.data);
            if (showToast) window.toastr?.success?.(saveResult.savedAsCopy
                ? `已另存冲突副本：${this.worldName}`
                : `世界书已保存：${this.worldName}`);
            if (this.isAiTraceWatchActive()) {
                this.traceAi('save.silent.finish', {
                    refMode: false,
                    ok: true,
                    worldName: this.worldName,
                });
            }
            return true;
        } catch (err) {
            logger.error('自动保存世界书失败', err);
            if (this.isAiTraceWatchActive()) {
                this.traceAi('save.silent.error', {
                    message: err?.message || 'unknown',
                }, 'error');
            }
            if (showToast) window.toastr?.error?.('自动保存失败');
            return false;
        }
    }
}
