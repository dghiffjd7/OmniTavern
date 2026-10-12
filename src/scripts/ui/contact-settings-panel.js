/**
 * Contact settings panel
 * - Edit contact display name + avatar (does not rename session id)
 */
import { logger } from '../utils/logger.js';
import { avatarDataUrlFromFile } from '../utils/image.js';
import { appSettings } from '../storage/app-settings.js';
import { getSummaryTableIdsForContext, isRpSessionId } from '../memory/memory-context-utils.js';
import { MemoryTableEditor } from './memory-table-editor.js';
import { appConfirm, appPromptText } from './app-confirm.js';
import { normalizeBadgeList } from '../utils/name-badges.js';
import { FEATHER_DEFAULT, resolveLineAvatar } from '../utils/line-avatar.js';
import { bindCustomSelectButton, closeCustomSelectMenu, refreshCustomSelectButton } from './custom-select.js';
import {
    runContactSettingsPopulateFlow,
    runContactSettingsSaveFlow,
} from './contact-settings-runtime-utils.js';
import { createContactMemoryShareRuntime } from './contact-memory-share-runtime-utils.js';
import { t, translateUiText } from '../i18n/index.js';
import { getMemoryTableStore, getMemoryTemplateStore } from './memory-store-runtime-utils.js';
import {
    applySessionPanelMemoryMode,
    runSessionPanelShowFlow,
} from './session-panel-display-runtime-utils.js';
import {
    buildSessionFooterStyle,
    buildSessionSurfaceBoxStyle,
    buildSessionSummaryRowStyle,
    SESSION_PANEL_STYLES,
} from './session-panel-style-utils.js';
import {
    bindSettingsTagInput,
    buildSessionSettingsCloseInnerHtml,
    buildSessionSettingsNavHtml,
    createSessionSettingsChrome,
    isSettingsReducedMotion,
    SESSION_SETTINGS_ICONS,
    SETTINGS_DISCARD_CONFIRM,
    splitSettingsTags,
} from './session-settings-chrome-utils.js';
import {
    bindSessionMemoryShareButton,
    bindSessionPanelSharedWindowEvents,
    bindSessionSummarySectionControls,
} from './session-panel-binding-utils.js';
import { createSessionArchiveSectionRuntime } from './session-archive-section-runtime-utils.js';
import { createSessionNewChatSectionRuntime } from './session-new-chat-section-runtime-utils.js';
import { runArchiveSwitchFlow } from './session-archive-switch-utils.js';
import { runArchiveDeleteFlow } from './session-archive-delete-utils.js';
import {
    applyMemoryTableSnapshot as applySharedMemoryTableSnapshot,
    askMemoryTableNewChatMode,
    buildMemoryTableSnapshot as buildSharedMemoryTableSnapshot,
    getMemoryStorageMode,
    resolveDefaultMemoryTemplateDefinition as resolveSharedDefaultMemoryTemplateDefinition,
    resolveDefaultMemoryTemplateId as resolveSharedDefaultMemoryTemplateId,
} from './session-memory-table-utils.js';
import {
    normalizeSummaryItems,
    renderCompactedSummary,
    renderSummaryList,
} from './session-summary-utils.js';
import { emitMemoryRowsUpdated as emitSharedMemoryRowsUpdated } from './session-memory-event-utils.js';
import { createSessionSummarySectionRuntime } from './session-summary-section-runtime-utils.js';
import { loadConversationExportState, runSessionConversationExportFlow } from './session-conversation-export-utils.js';
import { openConversationExportDialog } from './conversation-export-dialog.js';
import {
    bindConversationImportDropZone,
    pickConversationImportFile,
    runSessionConversationImportFlow,
} from './session-conversation-import-utils.js';
import { openConversationImportDialog } from './conversation-import-dialog.js';
import { highlightSessionArchiveRow } from './session-archive-view-utils.js';
import {
    createSessionArchiveEmptyState,
    createSessionArchiveManagerModal,
    createSessionArchiveRow,
} from './session-shared-view-utils.js';
const resolveDefaultMemoryTemplateId = async (memoryTemplateStore = null) => resolveSharedDefaultMemoryTemplateId({
    memoryTemplateStore,
});

const resolveDefaultMemoryTemplateDefinition = async (memoryTemplateStore = null) => resolveSharedDefaultMemoryTemplateDefinition({
    memoryTemplateStore,
});

const buildMemoryTableSnapshot = async ({
    sessionId,
    isGroup,
    memoryTableStore = null,
    memoryTemplateStore = null,
} = {}) => buildSharedMemoryTableSnapshot({
    sessionId,
    isGroup,
    memoryTableStore,
    resolveDefaultMemoryTemplateId: () => resolveDefaultMemoryTemplateId(memoryTemplateStore),
});

const applyMemoryTableSnapshot = async ({
    sessionId,
    isGroup,
    snapshot,
    memoryTableStore = null,
    memoryTemplateStore = null,
} = {}) => applySharedMemoryTableSnapshot({
    sessionId,
    isGroup,
    snapshot,
    memoryTableStore,
    resolveDefaultMemoryTemplateId: () => resolveDefaultMemoryTemplateId(memoryTemplateStore),
    notifyRowsUpdated: ({ sessionId, templateId }) =>
        emitSharedMemoryRowsUpdated({ target: window, sessionId, templateId }),
});

const trimProfileText = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

const listProfileText = (items = [], {
    field = '',
    limit = 6,
} = {}) => {
    const source = Array.isArray(items) ? items : [items];
    const values = source
        .map(item => trimProfileText(field && item && typeof item === 'object' ? item[field] : item))
        .filter(Boolean)
        .slice(0, Math.max(0, Number(limit) || 0));
    return values.join('、');
};

const formatProfileUpdatedAt = (value = 0) => {
    const time = Number(value || 0);
    if (!Number.isFinite(time) || time <= 0) return '';
    try {
        return new Date(time).toLocaleString();
    } catch {
        return '';
    }
};

const clearElement = (element) => {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
};

export class ContactSettingsPanel {
    constructor({
        contactsStore,
        chatStore,
        getSessionId,
        memoryTableStore = null,
        memoryTemplateStore = null,
        onSaved,
        onExportExperiencePack,
        onOpenRegex,
        onOpenVariables,
        voiceRegistryStore = null,
    } = {}) {
        this.contactsStore = contactsStore;
        this.chatStore = chatStore;
        const bridge = typeof window !== 'undefined' ? window.appBridge : null;
        this.memoryTableStore = memoryTableStore || getMemoryTableStore(bridge);
        this.memoryTemplateStore = memoryTemplateStore || getMemoryTemplateStore(bridge);
        this.getSessionId = typeof getSessionId === 'function' ? getSessionId : () => 'default';
        this.onSaved = typeof onSaved === 'function' ? onSaved : null;
        this.onExportExperiencePack = typeof onExportExperiencePack === 'function' ? onExportExperiencePack : null;
        this.onOpenRegex = typeof onOpenRegex === 'function' ? onOpenRegex : null;
        this.onOpenVariables = typeof onOpenVariables === 'function' ? onOpenVariables : null;
        this.voiceRegistryStore = voiceRegistryStore;
        this.overlay = null;
        this.panel = null;
        this.fileInput = null;
        this.avatarPreview = null;
        this.nameInput = null;
        this.archivesList = null;
        this.archiveRuntime = null;
        this.archiveManageButton = null;
        this.archiveManagerModal = null;
        this.archiveManagerRuntime = null;
        this.newChatRuntime = null;
        this.summariesList = null;
        this.compactedList = null;
        this.summarySection = null;
        this.memoryTableSection = null;
        this.memoryFeaturesSection = null;
        this.memoryTableContent = null;
        this.memoryTableEditor = null;
        this.currentAvatar = '';
        this.summaryBatchMode = false;
        this.summarySelectedKeys = new Set();
        this.summaryRuntime = null;
        this.summariesBatchBar = null;
        this.summaryEditOverlay = null;
        this.summaryEditPanel = null;
        this.summaryEditTextarea = null;
        this.summaryEditSave = null;
        this.summaryEditCancel = null;
        this.summaryCompacting = false;
        this.templateToggle = null;
        this.scriptToggle = null;
        this.openRegexBtn = null;
        this.openVariablesBtn = null;
        this.resetVarsBtn = null;
        this.rpBridgeSection = null;
        this.rpBridgeToggle = null;
        this.rpBridgeLimitInput = null;
        this.rpBridgeSourceNote = null;
        this.memoryShareSection = null;
        this.memoryShareButton = null;
        this.memoryShareSummary = null;
        this.memoryShareRuntime = null;
        this.exportExperiencePackBtn = null;
        this.contactProfileButton = null;
        this.contactProfileOverlay = null;
        this.contactProfilePanel = null;
        this.contactProfileTitle = null;
        this.contactProfileSubtitle = null;
        this.contactProfileBody = null;
        this.contactProfileRefreshButton = null;
        this.contactProfileGenerateButton = null;
    }

    resolveDefaultMemoryTemplateId() {
        return resolveDefaultMemoryTemplateId(this.memoryTemplateStore);
    }

    resolveDefaultMemoryTemplateDefinition() {
        return resolveDefaultMemoryTemplateDefinition(this.memoryTemplateStore);
    }

    buildMemoryTableSnapshot(payload = {}) {
        return buildMemoryTableSnapshot({
            ...payload,
            memoryTableStore: this.memoryTableStore,
            memoryTemplateStore: this.memoryTemplateStore,
        });
    }

    applyMemoryTableSnapshot(payload = {}) {
        return applyMemoryTableSnapshot({
            ...payload,
            memoryTableStore: this.memoryTableStore,
            memoryTemplateStore: this.memoryTemplateStore,
        });
    }

    show() {
        const shown = runSessionPanelShowFlow({
            ensureUi: () => {
                if (!this.panel) this.createUI();
            },
            applyMemoryMode: () => this.applyMemoryMode(),
            populate: () => this.populate(),
            renderArchives: () => this.renderArchives(),
            renderSummaries: () => this.renderSummaries(),
            renderCompactedSummary: () => this.renderCompactedSummary(),
            getMemoryMode: getMemoryStorageMode,
            renderMemoryTable: () => this.memoryTableEditor?.render?.(),
            // 显示与动画交给 settingsChrome，避免在基线记录前就露出面板。
            getOverlayEl: () => null,
            getPanelEl: () => null,
        });
        if (shown) this.settingsChrome?.show();
        return shown;
    }

    hide() {
        this.hideArchiveManager();
        this.settingsChrome?.hide();
    }

    requestClose() {
        return this.settingsChrome ? this.settingsChrome.requestClose() : Promise.resolve(true);
    }

    applyMemoryMode() {
        const result = applySessionPanelMemoryMode({
            memoryMode: getMemoryStorageMode(),
            memoryFeaturesSection: this.memoryFeaturesSection,
            summarySection: this.summarySection,
            memoryTableSection: this.memoryTableSection,
            renderMemoryTable: () => this.memoryTableEditor?.render?.(),
        });
        this.settingsChrome?.syncSections();
        return result;
    }

    createUI() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'contact-settings-overlay';
        this.overlay.className = 'app-themed-overlay ssp-overlay';
        this.overlay.style.display = 'none';
        this.overlay.addEventListener('click', () => void this.requestClose());

        this.panel = document.createElement('div');
        this.panel.id = 'contact-settings-panel';
        this.panel.className = 'app-themed-panel ssp-panel';
        this.panel.style.display = 'none';
        this.panel.tabIndex = -1;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-modal', 'true');
        this.panel.setAttribute('aria-labelledby', 'contact-settings-title');
        this.panel.addEventListener('click', (event) => event.stopPropagation());

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.onchange = async () => {
            const file = this.fileInput.files?.[0];
            if (!file) return;
            try {
                this.currentAvatar = await avatarDataUrlFromFile(file, { maxDim: 256, quality: 0.84, maxBytes: 420_000 });
                if (this.avatarPreview) this.avatarPreview.src = this.currentAvatar;
                this.settingsChrome?.refreshDirty();
            } catch (err) {
                logger.warn('读取/压缩头像失败', err);
                window.toastr?.error?.('读取头像失败');
            }
        };

        this.panel.innerHTML = `
            <header class="ssp-header">
                <div class="ssp-heading">
                    <h2 id="contact-settings-title" class="ssp-title has-help" data-help-title="会话 ID" data-help="">设置</h2>
                    <span id="contact-settings-sub" class="ssp-subtitle"></span>
                </div>
                <button id="contact-settings-close" type="button" class="ssp-icon-btn ssp-close ssp-ctl" aria-label="关闭设置">${buildSessionSettingsCloseInnerHtml()}</button>
            </header>
            <div class="ssp-main">
                <nav class="ssp-nav" aria-label="设置分区">
                    <span class="ssp-nav-indicator" aria-hidden="true"></span>
                    ${buildSessionSettingsNavHtml([
                        { id: 'basic', label: '基本资料', icon: 'profile' },
                        { id: 'script', label: '模板与脚本', icon: 'script' },
                        { id: 'memory-share', label: '记忆共享', icon: 'memory' },
                        { id: 'archives', label: '聊天与存档', icon: 'archive' },
                        { id: 'summary', label: '摘要', icon: 'summary' },
                        { id: 'memory-table', label: '记忆表格', icon: 'table' },
                    ])}
                </nav>
                <div class="ssp-scroll">
                    <section class="ssp-card" data-settings-section="basic">
                        <div class="ssp-row ssp-basic">
                        <div class="ssp-avatar-col">
                            <button id="contact-avatar-btn" type="button" class="ssp-avatar ssp-ctl" aria-label="更换头像" title="点击更换头像">
                                <img id="contact-avatar-preview" alt="">
                                <span class="ssp-avatar-badge" aria-hidden="true">${SESSION_SETTINGS_ICONS.edit}</span>
                            </button>
                            <button id="contact-avatar-clear" type="button" class="ssp-link-btn ssp-ctl">清除头像</button>
                        </div>
                        <div class="ssp-basic-fields">
                            <label class="ssp-field">
                                <span class="ssp-label has-help" data-help="仅修改显示名称，不会改变聊天室 ID。">名称</span>
                                <input id="contact-name-input" class="ssp-input" autocomplete="off">
                            </label>
                            <div class="ssp-field">
                                <label for="contact-labels-entry" class="ssp-label has-help" data-help="用来分类和展示；输入后按回车或逗号添加，最多 8 个。">标签</label>
                                <div class="ssp-tags-box">
                                    <span id="contact-labels-chips" class="ssp-tags"></span>
                                    <input id="contact-labels-entry" class="ssp-tags-entry ssp-ctl" autocomplete="off" placeholder="添加标签">
                                </div>
                                <input id="contact-labels-input" type="hidden">
                            </div>
                            <div id="contact-voice-section">
                                <label class="ssp-field">
                                    <span class="ssp-label has-help" data-help="默认（全局）跟随当前 TTS 设置；声音绑定仅保存在本机。人物声音在 API 设置 → 语音模型 → 人物声音库中管理。">声音</span>
                                    <select id="contact-voice-select" class="ssp-input"></select>
                                </label>
                            </div>
                            <button id="contact-export-experience-pack" type="button" class="ssp-btn ssp-ctl ssp-pack-btn" data-help="把角色卡、世界书与相关设置打包，方便分享给别人体验。" data-help-mode="press">导出角色体验包</button>
                        </div>
                        </div>
                    </section>

                    <section class="ssp-card" data-settings-section="script">
                        <div class="ssp-row is-wrap">
                        <h3 class="ssp-card-title has-help" data-help="这里的设置只对本会话生效。">模板与脚本</h3>
                        <label class="ssp-switch has-help" data-help="执行角色卡模板（生成前与渲染后）。" data-help-mode="press">
                            <span>模板处理</span>
                            <input type="checkbox" id="contact-template-enabled" class="ssp-switch-input">
                        </label>
                        <label class="ssp-switch has-help" data-help="允许角色卡脚本参与运行时逻辑。" data-help-mode="press">
                            <span>脚本</span>
                            <input type="checkbox" id="contact-script-enabled" class="ssp-switch-input">
                        </label>
                        <div class="ssp-card-actions">
                            <button id="contact-open-regex" type="button" class="ssp-btn ssp-ctl">正则</button>
                            <button id="contact-open-vars-panel" type="button" class="ssp-btn ssp-ctl">变量</button>
                            <button id="contact-reset-vars" type="button" class="ssp-btn is-danger-soft ssp-ctl" data-help="清空本会话的 local 变量，不影响全局变量。" data-help-mode="press">重置变量</button>
                        </div>
                        </div>
                    </section>

                    <section id="contact-memory-features-section" class="ssp-card" data-settings-section="memory-share">
                        <div id="contact-memory-share-section" style="display:none;">
                            <div class="ssp-row ssp-share-row">
                                <h3 class="ssp-card-title has-help" data-help="哪些记忆表格在聊天与创意写作之间共享。">记忆共享</h3>
                                <div id="contact-memory-share-summary" class="ssp-muted ssp-share-summary"></div>
                                <button id="contact-memory-share-manage" type="button" class="ssp-btn ssp-ctl">调整</button>
                            </div>
                        </div>
                        <div id="contact-rp-bridge-section" class="ssp-bridge" style="display:none;">
                            <label class="ssp-switch">
                                <span class="has-help" data-help="默认来源为当前角色的创意写作会话。" data-help-mode="press">注入创意写作总体大纲</span>
                                <input type="checkbox" id="contact-rp-bridge-enabled" class="ssp-switch-input">
                            </label>
                            <div id="contact-rp-bridge-source-note" class="ssp-muted"></div>
                            <label class="ssp-inline-field">
                                <span>注入条数（0=全部）</span>
                                <input type="number" id="contact-rp-bridge-limit" class="ssp-input is-compact" min="0" step="1">
                            </label>
                        </div>
                    </section>

                    <section class="ssp-card" data-settings-section="archives">
                        <div class="ssp-card-head">
                            <h3 class="ssp-card-title has-help" data-help="点存档可加载；当前聊天会先自动存档。">聊天与存档</h3>
                            <div class="ssp-card-actions">
                                <button id="contact-archives-import" type="button" class="ssp-btn ssp-ctl" data-help="导入本 APP 导出的 md／txt 聊天记录，存成新存档；电脑上也可以把文件拖到这里。" data-help-mode="press">导入</button>
                                <button id="contact-archives-manage" type="button" class="ssp-btn ssp-ctl">管理</button>
                                <button id="contact-new-chat" type="button" class="ssp-btn is-accent-outline ssp-ctl" data-help="把当前聊天存档后，开始新的聊天。" data-help-mode="press">${SESSION_SETTINGS_ICONS.plus}<span>新聊天</span></button>
                            </div>
                        </div>
                        <div id="contact-archives-list" class="ssp-list"></div>
                    </section>

                    <section id="contact-summary-section" class="ssp-card" data-settings-section="summary">
                        <div class="ssp-card-head">
                            <h3 class="ssp-card-title has-help" data-help="每次对话保存一条摘要（与聊天存档绑定）。">摘要</h3>
                            <div class="ssp-card-actions">
                                <button id="contact-summaries-batch" type="button" title="批量操作" aria-label="批量操作" class="ssp-icon-btn is-bordered ssp-ctl">☰</button>
                                <button id="contact-summaries-clear" type="button" class="ssp-btn is-danger-soft ssp-ctl">清空</button>
                            </div>
                        </div>
                        <div id="contact-summaries-batchbar" class="ssp-batchbar" style="display:none;">
                            <button id="contact-summaries-batch-edit" type="button" title="批量编辑" aria-label="批量编辑" class="ssp-icon-btn is-bordered ssp-ctl">✎</button>
                            <button id="contact-summaries-batch-delete" type="button" title="批量删除" aria-label="批量删除" class="ssp-icon-btn is-bordered is-danger ssp-ctl">🗑</button>
                            <button id="contact-summaries-batch-cancel" type="button" title="退出批量" aria-label="退出批量" class="ssp-icon-btn is-bordered ssp-ctl">×</button>
                        </div>
                        <div id="contact-summaries-list" class="ssp-list"></div>
                        <div class="ssp-card-head ssp-subhead">
                            <h4 class="ssp-subtitle-title has-help" data-help="摘要满记忆 Agent「触发与频率」设定的条数或字数时，会自动生成大总结（与聊天存档绑定）。">大总结</h4>
                            <div class="ssp-card-actions">
                                <button id="contact-compacted-raw" type="button" title="查看原始回复" aria-label="查看原始回复" class="ssp-icon-btn is-bordered ssp-ctl">📄</button>
                                <button id="contact-compacted-edit" type="button" title="编辑" aria-label="编辑" class="ssp-icon-btn is-bordered ssp-ctl">✎</button>
                                <button id="contact-compacted-run" type="button" title="手动生成/刷新" aria-label="手动生成/刷新" class="ssp-icon-btn is-bordered ssp-ctl">↻</button>
                                <button id="contact-compacted-clear" type="button" title="删除" aria-label="删除" class="ssp-icon-btn is-bordered is-danger ssp-ctl">🗑</button>
                            </div>
                        </div>
                        <div id="contact-compacted-summary" class="ssp-list"></div>
                    </section>

                    <section id="contact-memory-table-section" class="ssp-card" data-settings-section="memory-table" style="display:none;">
                        <div class="ssp-card-head">
                            <h3 class="ssp-card-title has-help" data-help="AI 在对话中自动维护的记忆，跟随聊天存档切换。">记忆表格</h3>
                            <div class="ssp-card-actions">
                                <button id="contact-profile-manage" type="button" class="ssp-btn ssp-ctl">联系人画像</button>
                            </div>
                        </div>
                        <div class="ssp-table-summary">
                            <span class="ssp-muted" data-role="table-overview">…</span>
                            <button type="button" class="ssp-btn is-accent-outline ssp-ctl" data-action="open-tables">打开</button>
                        </div>
                        <div id="contact-memory-table-content" class="ssp-table-host"></div>
                    </section>
                </div>
            </div>
            <footer class="ssp-footer">
                <span class="ssp-dirty" aria-live="polite"><i aria-hidden="true"></i>有未保存的更改</span>
                <div class="ssp-footer-actions">
                    <button id="contact-settings-cancel" type="button" class="ssp-btn is-large ssp-ctl">取消</button>
                    <button id="contact-settings-save" type="button" class="ssp-btn is-large is-primary ssp-ctl" title="保存（Ctrl+S）">保存</button>
                </div>
            </footer>
            <div class="ssp-subpage-scrim" aria-hidden="true"></div>
            <section class="ssp-subpage" hidden aria-hidden="true">
                <header class="ssp-subpage-header">
                    <button type="button" class="ssp-icon-btn ssp-subpage-back ssp-ctl" aria-label="返回设置">${SESSION_SETTINGS_ICONS.back}</button>
                    <h2 class="ssp-subpage-title has-help"></h2>
                </header>
                <div class="ssp-subpage-body"></div>
            </section>
        `;

        document.body.appendChild(this.overlay);
        document.body.appendChild(this.panel);
        document.body.appendChild(this.fileInput);

        this.avatarPreview = this.panel.querySelector('#contact-avatar-preview');
        this.nameInput = this.panel.querySelector('#contact-name-input');
        this.labelsInput = this.panel.querySelector('#contact-labels-input');
        this.voiceSelect = this.panel.querySelector('#contact-voice-select');
        this.voiceSection = this.panel.querySelector('#contact-voice-section');
        this.archivesList = this.panel.querySelector('#contact-archives-list');
        this.archiveManageButton = this.panel.querySelector('#contact-archives-manage');
        this.summariesList = this.panel.querySelector('#contact-summaries-list');
        this.compactedList = this.panel.querySelector('#contact-compacted-summary');
        this.summarySection = this.panel.querySelector('#contact-summary-section');
        this.memoryTableSection = this.panel.querySelector('#contact-memory-table-section');
        this.memoryFeaturesSection = this.panel.querySelector('#contact-memory-features-section');
        this.memoryTableContent = this.panel.querySelector('#contact-memory-table-content');
        this.summariesBatchBar = this.panel.querySelector('#contact-summaries-batchbar');
        this.templateToggle = this.panel.querySelector('#contact-template-enabled');
        this.scriptToggle = this.panel.querySelector('#contact-script-enabled');
        this.openRegexBtn = this.panel.querySelector('#contact-open-regex');
        this.openVariablesBtn = this.panel.querySelector('#contact-open-vars-panel');
        this.resetVarsBtn = this.panel.querySelector('#contact-reset-vars');
        this.rpBridgeSection = this.panel.querySelector('#contact-rp-bridge-section');
        this.rpBridgeToggle = this.panel.querySelector('#contact-rp-bridge-enabled');
        this.rpBridgeLimitInput = this.panel.querySelector('#contact-rp-bridge-limit');
        this.rpBridgeSourceNote = this.panel.querySelector('#contact-rp-bridge-source-note');
        this.memoryShareSection = this.panel.querySelector('#contact-memory-share-section');
        this.memoryShareButton = this.panel.querySelector('#contact-memory-share-manage');
        this.memoryShareSummary = this.panel.querySelector('#contact-memory-share-summary');
        this.exportExperiencePackBtn = this.panel.querySelector('#contact-export-experience-pack');
        this.contactProfileButton = this.panel.querySelector('#contact-profile-manage');
        this.labelsTagInput = bindSettingsTagInput({
            hiddenInput: this.labelsInput,
            entryInput: this.panel.querySelector('#contact-labels-entry'),
            chipsEl: this.panel.querySelector('#contact-labels-chips'),
        });
        this.settingsChrome = createSessionSettingsChrome({
            overlayEl: this.overlay,
            panelEl: this.panel,
            scrollEl: this.panel.querySelector('.ssp-scroll'),
            navEl: this.panel.querySelector('.ssp-nav'),
            dirtyEl: this.panel.querySelector('.ssp-dirty'),
            getSessionId: () => this.getSessionId(),
            readSnapshot: () => this.readSettingsSnapshot(),
            confirmDiscard: () => appConfirm(SETTINGS_DISCARD_CONFIRM),
            onSave: () => this.save(),
            onCloseConfirmed: () => this.hide(),
            isReducedMotion: isSettingsReducedMotion,
            subpageEl: this.panel.querySelector('.ssp-subpage'),
        });
        this.tableOverview = this.panel.querySelector('[data-role="table-overview"]');
        this.panel.querySelector('[data-action="open-tables"]')?.addEventListener('click', () => {
            this.settingsChrome.openSubpage({
                title: translateUiText('记忆表格'),
                help: translateUiText('AI 在对话中自动维护的记忆，跟随聊天存档切换。'),
                contentEl: this.memoryTableContent,
            });
        });
        const summariesClearButton = this.panel.querySelector('#contact-summaries-clear');
        const summariesBatchButton = this.panel.querySelector('#contact-summaries-batch');
        const summariesBatchCancelButton = this.panel.querySelector('#contact-summaries-batch-cancel');
        const summariesBatchDeleteButton = this.panel.querySelector('#contact-summaries-batch-delete');
        const summariesBatchEditButton = this.panel.querySelector('#contact-summaries-batch-edit');
        const compactedRawButton = this.panel.querySelector('#contact-compacted-raw');
        const compactedEditButton = this.panel.querySelector('#contact-compacted-edit');
        const compactedRunButton = this.panel.querySelector('#contact-compacted-run');
        const compactedClearButton = this.panel.querySelector('#contact-compacted-clear');
        const syncBridgeControls = () => {
            if (this.rpBridgeLimitInput) {
                this.rpBridgeLimitInput.disabled = this.rpBridgeToggle?.checked === false;
            }
        };

        this.panel.querySelector('#contact-settings-close').onclick = () => void this.requestClose();
        this.panel.querySelector('#contact-settings-cancel').onclick = () => void this.requestClose();
        this.exportExperiencePackBtn?.addEventListener('click', async () => {
            const sid = String(this.getSessionId?.() || '').trim();
            if (!sid || typeof this.onExportExperiencePack !== 'function') return;
            if (this.exportExperiencePackBtn) this.exportExperiencePackBtn.disabled = true;
            try {
                await this.onExportExperiencePack(sid);
            } catch (err) {
                logger.error('导出角色体验包失败', err);
                window.toastr?.error?.(err?.message || '导出体验包失败');
            } finally {
                if (this.exportExperiencePackBtn) this.exportExperiencePackBtn.disabled = false;
            }
        });
        this.panel.querySelector('#contact-avatar-btn').onclick = () => {
            this.fileInput.value = '';
            this.fileInput.click();
        };
        this.panel.querySelector('#contact-avatar-clear').onclick = () => {
            this.currentAvatar = '';
            if (this.avatarPreview) {
                const sid = this.getSessionId();
                const c = sid ? (this.contactsStore?.getContact?.(sid) || {}) : {};
                const name = String(this.nameInput?.value || c?.name || sid || '好友').trim() || '好友';
                const tags = Array.isArray(c?.libraryTags) && c.libraryTags.length
                    ? c.libraryTags
                    : Array.isArray(c?.labels)
                        ? c.labels
                        : [];
                this.avatarPreview.src = resolveLineAvatar({
                    avatar: FEATHER_DEFAULT,
                    name,
                    tags,
                    size: 96,
                });
            }
            this.settingsChrome?.refreshDirty();
        };
        this.panel.querySelector('#contact-settings-save').onclick = () => this.save();
        this.rpBridgeToggle?.addEventListener('change', syncBridgeControls);
        this.openRegexBtn?.addEventListener('click', async () => {
            if (!await this.requestClose()) return;
            this.onOpenRegex?.();
        });
        this.openVariablesBtn?.addEventListener('click', async () => {
            if (!await this.requestClose()) return;
            this.onOpenVariables?.();
        });
        bindSessionMemoryShareButton({
            buttonEl: this.memoryShareButton,
            openManager: () => this.openMemoryShareManager(),
            logger,
            warnMessage: 'open memory share manager failed',
            errorMessage: '打开记忆共享失败',
            toastr: window.toastr,
        });
        this.contactProfileButton?.addEventListener('click', () => {
            this.openContactProfileManager();
        });
        this.resetVarsBtn?.addEventListener('click', async () => {
            const sid = this.getSessionId();
            if (!sid) return;
            const ok = await appConfirm({
                title: '重置变量',
                message: '会清空本会话的全部 local 变量（变量面板与状态栏会回到空白），全局变量不受影响。此操作无法撤销。',
                confirmText: '清空变量',
                danger: true,
            });
            if (!ok) return;
            try {
                this.chatStore?.clearVariables?.(sid);
                window.toastr?.success?.('已清空本会话变量');
            } catch (err) {
                logger.warn('clear session variables failed', err);
                window.toastr?.error?.('清空失败');
            }
        });
        this.panel.querySelector('#contact-new-chat').onclick = () => this.startNewChat();
        this.archiveManageButton?.addEventListener('click', () => this.openArchiveManager());
        this.panel.querySelector('#contact-archives-import')?.addEventListener('click', () => {
            pickConversationImportFile({ onFile: file => this.importConversationFile(file) });
        });
        bindConversationImportDropZone({
            zoneEl: this.panel.querySelector('[data-settings-section=archives]'),
            onFile: file => this.importConversationFile(file),
        });
        bindSessionSummarySectionControls({
            clearButtonEl: summariesClearButton,
            batchButtonEl: summariesBatchButton,
            batchCancelButtonEl: summariesBatchCancelButton,
            batchDeleteButtonEl: summariesBatchDeleteButton,
            batchEditButtonEl: summariesBatchEditButton,
            compactedRawButtonEl: compactedRawButton,
            compactedEditButtonEl: compactedEditButton,
            compactedRunButtonEl: compactedRunButton,
            compactedClearButtonEl: compactedClearButton,
            getSessionId: () => this.getSessionId(),
            getSummaryBatchMode: () => this.summaryBatchMode,
            clearSelectedKeys: () => {
                this.summarySelectedKeys = new Set();
            },
            setSummaryBatchMode: (enabled) => this.setSummaryBatchMode(enabled),
            renderSummaries: () => this.renderSummaries(),
            deleteSelectedSummaries: () => this.deleteSelectedSummaries(),
            editSelectedSummaries: () => this.editSelectedSummaries(),
            openCompactedRaw: () => this.openCompactedRaw(),
            editCompactedSummary: () => this.editCompactedSummary(),
            runCompactedSummary: () => this.runCompactedSummary(),
            renderCompactedSummary: () => this.renderCompactedSummary(),
            clearSummaries: (sessionId) => this.chatStore?.clearSummaries?.(sessionId),
            clearCompactedSummary: (sessionId) => this.chatStore?.clearCompactedSummary?.(sessionId),
            confirm: (options) => appConfirm(options),
        });

        if (this.memoryTableContent && this.memoryTableStore && this.memoryTemplateStore) {
            this.memoryTableEditor = new MemoryTableEditor({
                container: this.memoryTableContent,
                getContext: () => {
                    const contactId = this.getSessionId();
                    return { type: isRpSessionId(contactId) ? 'rp' : 'contact', contactId };
                },
                memoryStore: this.memoryTableStore,
                templateStore: this.memoryTemplateStore,
                contactsStore: this.contactsStore,
                chatStore: this.chatStore,
                includeGlobal: true,
                onRendered: ({ tableCount, rowCount }) => {
                    if (this.tableOverview) this.tableOverview.textContent = t('{tables} 张表 · {rows} 行', { tables: tableCount, rows: rowCount });
                },
            });
        }

        bindSessionPanelSharedWindowEvents({
            target: window,
            isPanelVisible: () => Boolean(this.panel && this.panel.style.display !== 'none'),
            applyMemoryMode: () => this.applyMemoryMode(),
            getSessionId: () => this.getSessionId(),
            renderSummaries: () => this.renderSummaries(),
            renderCompactedSummary: () => this.renderCompactedSummary(),
        });
    }

    readSettingsSnapshot() {
        const pendingLabels = this.panel?.querySelector?.('#contact-labels-entry')?.value || '';
        return {
            avatar: String(this.currentAvatar || ''),
            name: String(this.nameInput?.value || ''),
            labels: splitSettingsTags(`${this.labelsInput?.value || ''},${pendingLabels}`),
            voice: String(this.voiceSelect?.value || ''),
            template: this.templateToggle?.checked === true,
            script: this.scriptToggle?.checked === true,
        };
    }

    ensureSummaryRuntime() {
        if (this.summaryRuntime) return this.summaryRuntime;
        this.summaryRuntime = createSessionSummarySectionRuntime({
            variant: 'contact',
            getSessionId: () => this.getSessionId(),
            getChatStore: () => this.chatStore,
            getSummariesContainer: () => this.summariesList,
            getCompactedContainer: () => this.compactedList,
            getBatchBar: () => this.summariesBatchBar,
            getBatchMode: () => this.summaryBatchMode,
            setBatchModeState: (value) => {
                this.summaryBatchMode = Boolean(value);
            },
            getSelectedKeys: () => this.summarySelectedKeys,
            setSelectedKeys: (value) => {
                this.summarySelectedKeys = value instanceof Set ? value : new Set(value || []);
            },
            getSummaryCompacting: () => this.summaryCompacting,
            setSummaryCompacting: (value) => {
                this.summaryCompacting = Boolean(value);
            },
            confirm: (options) => appConfirm(options),
            copyText: async (text) => navigator.clipboard?.writeText?.(text),
            toastr: window.toastr,
            logger,
            getNormalRowStyle: () => buildSessionSummaryRowStyle(),
            dispatchUpdated: (sessionId) => {
                window.dispatchEvent(new CustomEvent('chatapp-summaries-updated', { detail: { sessionId } }));
            },
            resolveRequestSummaryCompaction: () =>
                globalThis?.__chatappRequestSummaryCompaction ||
                window?.__chatappRequestSummaryCompaction ||
                window?.appBridge?.requestSummaryCompaction,
        });
        return this.summaryRuntime;
    }

    openCompactedRaw() {
        return this.ensureSummaryRuntime().openCompactedRaw();
    }

    editCompactedSummary() {
        return this.ensureSummaryRuntime().editCompactedSummary();
    }

    setSummaryBatchMode(enabled) {
        return this.ensureSummaryRuntime().setSummaryBatchMode(enabled);
    }

    async deleteSelectedSummaries() {
        await this.ensureSummaryRuntime().deleteSelectedSummaries();
    }

    editSelectedSummaries() {
        return this.ensureSummaryRuntime().editSelectedSummaries();
    }

    async runCompactedSummary() {
        await this.ensureSummaryRuntime().runCompactedSummary();
    }

    ensureNewChatRuntime() {
        if (this.newChatRuntime) return this.newChatRuntime;
        this.newChatRuntime = createSessionNewChatSectionRuntime({
            getSessionId: () => this.getSessionId(),
            isGroup: false,
            resolveSessionMode: ({ sessionId }) => isRpSessionId(sessionId) ? 'rp' : 'chat',
            getMemoryStorageMode,
            askMemoryTableNewChatMode,
            promptForArchiveName: () => appPromptText({
                title: '为当前聊天存档',
                message: '留空会自动命名；取消则不会开启新聊天。',
                placeholder: '存档名称（可选）',
                confirmText: '继续',
            }),
            buildMemoryTableSnapshot: ({ sessionId, isGroup }) => this.buildMemoryTableSnapshot({ sessionId, isGroup }),
            captureArchivePointer: (sessionId, options) =>
                window.appBridge?.buildArchivePointerFromCurrentThread?.(sessionId, options),
            memoryTableStore: this.memoryTableStore,
            resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
            resolveSummaryTableIds: ({ sessionId, isGroup, sessionMode }) => {
                const { summaryTableId, outlineTableId } = getSummaryTableIdsForContext({
                    sessionId,
                    isGroup,
                    contextType: isRpSessionId(sessionId) ? 'rp' : (isGroup ? 'group' : 'contact'),
                    uiMode: sessionMode === 'rp' || isRpSessionId(sessionId) ? 'rp' : 'chat',
                });
                return [summaryTableId, outlineTableId];
            },
            notifyRowsUpdated: ({ sessionId, templateId }) =>
                emitSharedMemoryRowsUpdated({ target: window, sessionId, templateId }),
            startNewChat: (sessionId, archiveName, options) => this.chatStore.startNewChat(sessionId, archiveName, options),
            persistArchivePointer: (sessionId, archiveId, archivePointer, options) =>
                window.appBridge?.setArchivePointerForArchive?.(sessionId, archiveId, archivePointer, options),
            restoreMemoryForActiveThread: (sessionId, options) =>
                window.appBridge?.restoreMemoryForActiveThread?.(sessionId, options),
            logger,
            sourcePrefix: 'contact',
            onStarted: ({ sessionId }) => {
                window.toastr?.success('已开启新聊天');
                this.onSaved?.({ id: sessionId, forceRefresh: true });
                this.hide();
            },
        });
        return this.newChatRuntime;
    }

    ensureArchiveRuntime() {
        if (this.archiveRuntime) return this.archiveRuntime;
        this.archiveRuntime = createSessionArchiveSectionRuntime({
            getContainer: () => this.archivesList,
            getSessionId: () => this.getSessionId(),
            getChatStore: () => this.chatStore,
            isGroup: false,
            getMemoryStorageMode,
            buildMemoryTableSnapshot: ({ sessionId, isGroup }) => this.buildMemoryTableSnapshot({ sessionId, isGroup }),
            captureArchivePointer: (sessionId, options) =>
                window.appBridge?.buildArchivePointerFromCurrentThread?.(sessionId, options),
            loadArchivedMessages: (archiveId, sessionId, options) =>
                this.chatStore.loadArchivedMessages(archiveId, sessionId, options),
            getLastArchiveTransition: (sessionId) => this.chatStore.getLastArchiveTransition?.(sessionId),
            persistArchivePointer: (sessionId, archiveId, archivePointer, options) =>
                window.appBridge?.setArchivePointerForArchive?.(sessionId, archiveId, archivePointer, options),
            applyMemoryTableSnapshot: ({ sessionId, isGroup, snapshot }) =>
                this.applyMemoryTableSnapshot({ sessionId, isGroup, snapshot }),
            restoreArchivePointerForLoadedThread: (sessionId, options) =>
                window.appBridge?.restoreArchivePointerForLoadedThread?.(sessionId, options),
            logger,
            appConfirmFn: appConfirm,
            runArchiveSwitchFlow,
            runArchiveDeleteFlow,
            deleteArchiveTurnCheckpointState: (sessionId, archiveId) =>
                window.appBridge?.deleteArchiveTurnCheckpointState?.(sessionId, archiveId),
            deleteArchive: (archiveId, sessionId) => this.chatStore.deleteArchive(archiveId, sessionId),
            renameArchive: (archiveId, name, sessionId) => this.chatStore.renameArchive(archiveId, name, sessionId),
            promptArchiveRenameName: ({ archive }) => prompt('重命名存档', archive?.name || ''),
            includeCurrentThread: true,
            onExportCurrent: ({ sessionId }) => this.exportConversationArchive({ sessionId, current: true }),
            onExportArchive: ({ sessionId, archive }) => this.exportConversationArchive({ sessionId, archive }),
            onArchiveLoaded: (sessionId) => {
                window.toastr?.success('已加载存档');
                this.onSaved?.({ id: sessionId, forceRefresh: true });
            },
            onArchiveDeleted: () => this.renderArchives(),
            onArchiveRenamed: (sessionId) => {
                window.toastr?.success('已重命名存档');
                this.onSaved?.({ id: sessionId, forceRefresh: true });
                this.renderArchives();
            },
            onHide: () => this.hide(),
            createEmptyState: () => createSessionArchiveEmptyState(),
            createArchiveRow: (payload) => createSessionArchiveRow(payload),
            sourcePrefix: 'contact',
            restoreWarnMessage: 'restore checkpoint memory after archive load failed',
            deleteWarnMessage: 'delete archive turn checkpoint state failed',
        });
        return this.archiveRuntime;
    }

    renderArchives() {
        return this.ensureArchiveRuntime().renderArchives();
    }

    exportConversationArchive(payload = {}) {
        const sessionId = String(payload?.sessionId || this.getSessionId() || '').trim();
        const archive = payload?.archive || null;
        const current = payload?.current === true;
        return runSessionConversationExportFlow({
            chatStore: this.chatStore,
            sessionId,
            archive,
            current,
            title: current ? '当前聊天' : (archive?.name || '未命名存档'),
            sourceLabel: current ? '当前聊天' : `存档：${archive?.name || archive?.id || '未命名存档'}`,
            openExportDialog: options => openConversationExportDialog({ ...options, isReducedMotion: isSettingsReducedMotion }),
            loadState: () => loadConversationExportState({
                chatStore: this.chatStore,
                sessionId,
                archive,
                current,
                buildMemoryTableSnapshot: ({ sessionId: sid }) => (getMemoryStorageMode() === 'table'
                    ? this.buildMemoryTableSnapshot({ sessionId: sid, isGroup: false })
                    : null),
                readArchiveState: (sid, aid) => window.appBridge?.readArchiveTransferState?.(sid, aid),
            }),
            toastSuccess: text => window.toastr?.success?.(text),
            toastWarning: text => window.toastr?.warning?.(text),
            toastError: text => window.toastr?.error?.(text),
            logger,
        });
    }

    importConversationFile(file) {
        const sessionId = String(this.getSessionId() || '').trim();
        return runSessionConversationImportFlow({
            file,
            chatStore: this.chatStore,
            sessionId,
            resolveMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
            getMemoryStorageMode,
            bindImportedState: (sid, aid, payload) => window.appBridge?.bindImportedArchiveState?.(sid, aid, payload),
            openImportDialog: options => openConversationImportDialog({ ...options, isReducedMotion: isSettingsReducedMotion }),
            onImported: ({ archiveId }) => {
                this.renderArchives();
                highlightSessionArchiveRow(this.archivesList, archiveId);
            },
            loadArchive: archiveId => this.ensureArchiveRuntime().loadArchive(archiveId),
            toastWarning: text => window.toastr?.warning?.(text),
            toastError: text => window.toastr?.error?.(text),
            logger,
        });
    }

    ensureArchiveManagerModal() {
        if (this.archiveManagerModal) return this.archiveManagerModal;
        const modal = createSessionArchiveManagerModal({
            documentRef: document,
            title: '历史存档',
        });
        modal.overlay.addEventListener('click', () => this.hideArchiveManager());
        modal.closeButton.addEventListener('click', () => this.hideArchiveManager());
        document.body.appendChild(modal.overlay);
        document.body.appendChild(modal.panel);
        this.archiveManagerModal = modal;
        return modal;
    }

    openArchiveManager() {
        const modal = this.ensureArchiveManagerModal();
        const sessionId = this.getSessionId();
        const count = Number(this.chatStore?.getArchives?.(sessionId)?.length || 0) || 0;
        if (modal.subtitleEl) modal.subtitleEl.textContent = `${count} 份`;
        modal.overlay.style.display = 'block';
        modal.panel.style.display = 'flex';
        this.renderArchiveManagerArchives();
    }

    hideArchiveManager() {
        if (this.archiveManagerModal?.overlay) this.archiveManagerModal.overlay.style.display = 'none';
        if (this.archiveManagerModal?.panel) this.archiveManagerModal.panel.style.display = 'none';
    }

    ensureArchiveManagerRuntime() {
        if (this.archiveManagerRuntime) return this.archiveManagerRuntime;
        this.archiveManagerRuntime = createSessionArchiveSectionRuntime({
            getContainer: () => this.ensureArchiveManagerModal().listEl,
            getSessionId: () => this.getSessionId(),
            getChatStore: () => this.chatStore,
            isGroup: false,
            getMemoryStorageMode,
            buildMemoryTableSnapshot: ({ sessionId, isGroup }) => this.buildMemoryTableSnapshot({ sessionId, isGroup }),
            captureArchivePointer: (sessionId, options) =>
                window.appBridge?.buildArchivePointerFromCurrentThread?.(sessionId, options),
            loadArchivedMessages: (archiveId, sessionId, options) =>
                this.chatStore.loadArchivedMessages(archiveId, sessionId, options),
            getLastArchiveTransition: (sessionId) => this.chatStore.getLastArchiveTransition?.(sessionId),
            persistArchivePointer: (sessionId, archiveId, archivePointer, options) =>
                window.appBridge?.setArchivePointerForArchive?.(sessionId, archiveId, archivePointer, options),
            applyMemoryTableSnapshot: ({ sessionId, isGroup, snapshot }) =>
                this.applyMemoryTableSnapshot({ sessionId, isGroup, snapshot }),
            restoreArchivePointerForLoadedThread: (sessionId, options) =>
                window.appBridge?.restoreArchivePointerForLoadedThread?.(sessionId, options),
            logger,
            appConfirmFn: appConfirm,
            runArchiveSwitchFlow,
            runArchiveDeleteFlow,
            deleteArchiveTurnCheckpointState: (sessionId, archiveId) =>
                window.appBridge?.deleteArchiveTurnCheckpointState?.(sessionId, archiveId),
            deleteArchive: (archiveId, sessionId) => this.chatStore.deleteArchive(archiveId, sessionId),
            renameArchive: (archiveId, name, sessionId) => this.chatStore.renameArchive(archiveId, name, sessionId),
            promptArchiveRenameName: ({ archive }) => prompt('重命名存档', archive?.name || ''),
            includeCurrentThread: true,
            onExportCurrent: ({ sessionId }) => this.exportConversationArchive({ sessionId, current: true }),
            onExportArchive: ({ sessionId, archive }) => this.exportConversationArchive({ sessionId, archive }),
            onArchiveLoaded: (sessionId) => {
                window.toastr?.success('已加载存档');
                this.onSaved?.({ id: sessionId, forceRefresh: true });
            },
            onArchiveDeleted: () => {
                this.renderArchives();
                this.renderArchiveManagerArchives();
            },
            onArchiveRenamed: (sessionId) => {
                window.toastr?.success('已重命名存档');
                this.onSaved?.({ id: sessionId, forceRefresh: true });
                this.renderArchives();
                this.renderArchiveManagerArchives();
            },
            onHide: () => {
                this.hideArchiveManager();
                this.hide();
            },
            createEmptyState: () => createSessionArchiveEmptyState(),
            createArchiveRow: (payload) => createSessionArchiveRow(payload),
            sourcePrefix: 'contact',
            restoreWarnMessage: 'restore checkpoint memory after archive load failed',
            deleteWarnMessage: 'delete archive turn checkpoint state failed',
        });
        return this.archiveManagerRuntime;
    }

    renderArchiveManagerArchives() {
        const modal = this.ensureArchiveManagerModal();
        const sessionId = this.getSessionId();
        const count = Number(this.chatStore?.getArchives?.(sessionId)?.length || 0) || 0;
        if (modal.subtitleEl) modal.subtitleEl.textContent = `${count} 份`;
        return this.ensureArchiveManagerRuntime().renderArchives();
    }

    renderSummaries() {
        return this.ensureSummaryRuntime().renderSummaries();
    }

    renderCompactedSummary() {
        return this.ensureSummaryRuntime().renderCompactedSummary();
    }

    async startNewChat() {
        if (!this.chatStore) return;
        return this.ensureNewChatRuntime().startNewChat();
    }

    getRpDisplayName(sessionId = this.getSessionId()) {
        return this.ensureMemoryShareRuntime().getRpDisplayName(sessionId);
    }

    ensureMemoryShareRuntime() {
        if (this.memoryShareRuntime) return this.memoryShareRuntime;
        this.memoryShareRuntime = createContactMemoryShareRuntime({
            getSessionId: () => this.getSessionId(),
            getSummaryEl: () => this.memoryShareSummary,
            getSessionSettings: (sessionId) => this.chatStore?.getSessionSettings?.(sessionId),
            setSessionSettings: (sessionId, sessionSettings) => this.chatStore?.setSessionSettings?.(sessionId, sessionSettings),
            getContact: (sessionId) => this.contactsStore?.getContact?.(sessionId),
            listSessions: () => this.chatStore?.listSessions?.() || [],
            memoryTableStore: this.memoryTableStore,
            resolveTemplateDefinition: () => this.resolveDefaultMemoryTemplateDefinition(),
            resolveTemplateId: () => this.resolveDefaultMemoryTemplateId(),
            getRpCharacterNameForSession: (sessionId) => window.appBridge?.getRpCharacterNameForSession?.(sessionId),
            getRpSessionIdForSession: (sessionId) => window.appBridge?.getRpSessionIdForSession?.(sessionId),
            getRpSessionIdForActivePersona: () => window.appBridge?.getRpSessionIdForActivePersona?.(),
            bodyEl: document.body,
            bindSourceButton: ({ buttonEl, selectEl, fallback }) => {
                bindCustomSelectButton({ buttonEl, selectEl, fallback });
            },
            refreshSourceButton: ({ sourceButtonEl, sourceSelectEl, fallbackLabel }) =>
                refreshCustomSelectButton(sourceButtonEl, sourceSelectEl, fallbackLabel),
            closeSourceMenu: () => closeCustomSelectMenu(),
            documentRef: document,
            getGlobalSettings: () => appSettings.get(),
            updateGlobalSettings: (patch) => appSettings.update(patch),
            dispatchSettingChanged: (key, value) =>
                window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value } })),
            notifySaveSuccess: () => window.toastr?.success?.('已保存记忆共享设置'),
            notifySaveError: () => window.toastr?.error?.('保存记忆共享失败'),
            logger,
        });
        return this.memoryShareRuntime;
    }

    async refreshMemoryShareSummary(sessionId = this.getSessionId()) {
        return this.ensureMemoryShareRuntime().refreshMemoryShareSummary(sessionId);
    }

    ensureMemoryShareModal() {
        return this.ensureMemoryShareRuntime().ensureMemoryShareModal();
    }

    closeMemoryShareManager() {
        return this.ensureMemoryShareRuntime().closeMemoryShareManager();
    }

    async renderMemoryShareManager() {
        return this.ensureMemoryShareRuntime().renderMemoryShareManager();
    }

    async openMemoryShareManager() {
        await this.ensureMemoryShareRuntime().openMemoryShareManager();
    }

    async saveMemoryShareManager() {
        await this.ensureMemoryShareRuntime().saveMemoryShareManager();
    }

    getContactProfileBridge() {
        return typeof window !== 'undefined' ? window.appBridge : null;
    }

    getCurrentContactProfile(contactId = this.getSessionId()) {
        const id = trimProfileText(contactId);
        if (!id) return null;
        const bridge = this.getContactProfileBridge();
        try {
            const direct = bridge?.getContactProfile?.(id);
            if (direct) return direct;
        } catch {}
        try {
            return (bridge?.listContactProfiles?.() || [])
                .find(profile => trimProfileText(profile?.contactId || profile?.id) === id) || null;
        } catch {
            return null;
        }
    }

    listContactProfilePendingUpdates(contactId = this.getSessionId()) {
        const id = trimProfileText(contactId);
        if (!id) return [];
        const bridge = this.getContactProfileBridge();
        try {
            return (bridge?.listContactProfilePendingUpdates?.() || [])
                .filter(item => trimProfileText(item?.contactId || item?.profile?.contactId) === id);
        } catch {
            return [];
        }
    }

    callContactProfileAction(actionName = '', payload = {}) {
        const bridge = this.getContactProfileBridge();
        const direct = bridge?.[actionName];
        if (typeof direct === 'function') return direct.call(bridge, payload);
        const debugAction = bridge?.debugUiRegistry?.actions?.[actionName];
        if (typeof debugAction === 'function') return debugAction(payload);
        return null;
    }

    describeContactProfile(profile = {}) {
        const parts = [];
        const relationship = trimProfileText(profile?.relationship?.current);
        const focus = listProfileText(profile?.interaction_focus, { limit: 4 });
        const traits = listProfileText(profile?.stable_traits, { field: 'label', limit: 3 });
        const events = listProfileText(profile?.important_events, { field: 'label', limit: 2 });
        if (relationship) parts.push(relationship);
        if (focus) parts.push(`近期主题：${focus}`);
        if (traits) parts.push(`特征：${traits}`);
        if (events) parts.push(`事件：${events}`);
        return parts.join('；');
    }

    createContactProfileField(label = '', value = '') {
        const text = trimProfileText(value);
        if (!text) return null;
        const row = document.createElement('div');
        row.style.cssText = 'display:grid; grid-template-columns:86px minmax(0, 1fr); gap:8px; align-items:start; margin-top:8px;';
        const labelEl = document.createElement('div');
        labelEl.style.cssText = 'color:var(--app-text-muted); font-size:12px;';
        labelEl.textContent = label;
        const valueEl = document.createElement('div');
        valueEl.style.cssText = 'color:var(--app-text-primary); font-size:13px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere;';
        valueEl.textContent = text;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        return row;
    }

    createContactProfileButton(label = '', {
        danger = false,
        primary = false,
    } = {}) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = `
            padding:8px 10px; border-radius:10px; cursor:pointer; font-weight:800;
            border:1px solid ${danger ? '#fecaca' : (primary ? '#2563eb' : 'var(--app-border-default)')};
            background:${primary ? '#2563eb' : 'var(--app-surface-card)'};
            color:${primary ? 'white' : (danger ? '#b91c1c' : 'var(--app-text-primary)')};
        `;
        return button;
    }

    ensureContactProfileModal() {
        if (this.contactProfileOverlay) return;
        const overlay = document.createElement('div');
        overlay.id = 'contact-profile-overlay';
        overlay.className = 'app-themed-overlay';
        overlay.style.cssText = `
            display:none; position:fixed; inset:0; z-index:23000;
            background:rgba(0,0,0,0.45); align-items:center; justify-content:center;
            padding:calc(12px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) calc(12px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px));
        `;
        const panel = document.createElement('div');
        panel.id = 'contact-profile-panel';
        panel.className = 'app-themed-panel';
        panel.style.cssText = `
            width:min(640px, 100%); max-height:calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            background:var(--app-surface-card); color:var(--app-text-primary);
            border:1px solid var(--app-border-default); border-radius:14px; box-shadow:0 16px 48px rgba(0,0,0,0.32);
            overflow:hidden; display:flex; flex-direction:column;
        `;
        const header = document.createElement('div');
        header.style.cssText = 'padding:14px 16px; border-bottom:1px solid var(--app-border-subtle); background:var(--app-surface-subtle); display:flex; align-items:center; justify-content:space-between; gap:10px;';
        const titleWrap = document.createElement('div');
        titleWrap.style.minWidth = '0';
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:900; color:var(--app-text-primary);';
        title.textContent = '联系人画像';
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'margin-top:2px; color:var(--app-text-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        titleWrap.appendChild(title);
        titleWrap.appendChild(subtitle);
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = '×';
        closeButton.style.cssText = SESSION_PANEL_STYLES.closeButton;
        header.appendChild(titleWrap);
        header.appendChild(closeButton);

        const body = document.createElement('div');
        body.style.cssText = 'padding:14px 16px; overflow:auto; flex:1; min-height:0; -webkit-overflow-scrolling:touch;';
        const footer = document.createElement('div');
        footer.style.cssText = buildSessionFooterStyle({ safeAreaBottom: true, alignItems: 'center' });
        const refreshButton = this.createContactProfileButton('刷新');
        const generateButton = this.createContactProfileButton('生成候选', { primary: true });
        const doneButton = this.createContactProfileButton('关闭');
        footer.appendChild(refreshButton);
        footer.appendChild(generateButton);
        footer.appendChild(doneButton);

        panel.appendChild(header);
        panel.appendChild(body);
        panel.appendChild(footer);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', () => this.closeContactProfileManager());
        panel.addEventListener('click', event => event.stopPropagation());
        closeButton.addEventListener('click', () => this.closeContactProfileManager());
        doneButton.addEventListener('click', () => this.closeContactProfileManager());
        refreshButton.addEventListener('click', () => this.renderContactProfileManager());
        generateButton.addEventListener('click', () => this.runContactProfileCandidateUpdate());

        this.contactProfileOverlay = overlay;
        this.contactProfilePanel = panel;
        this.contactProfileTitle = title;
        this.contactProfileSubtitle = subtitle;
        this.contactProfileBody = body;
        this.contactProfileRefreshButton = refreshButton;
        this.contactProfileGenerateButton = generateButton;
    }

    closeContactProfileManager() {
        if (this.contactProfileOverlay) this.contactProfileOverlay.style.display = 'none';
    }

    async openContactProfileManager() {
        this.ensureContactProfileModal();
        if (this.contactProfileOverlay) this.contactProfileOverlay.style.display = 'flex';
        await this.renderContactProfileManager();
    }

    appendContactProfileCard(title = '') {
        const card = document.createElement('section');
        card.style.cssText = buildSessionSurfaceBoxStyle({
            margin: '0 0 12px',
            padding: 12,
            radius: 10,
            background: 'var(--app-surface-subtle)',
        });
        if (title) {
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:900; margin-bottom:8px; color:var(--app-text-primary);';
            titleEl.textContent = title;
            card.appendChild(titleEl);
        }
        this.contactProfileBody?.appendChild(card);
        return card;
    }

    appendContactProfileEmpty(message = '') {
        const empty = this.appendContactProfileCard('');
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--app-text-muted)';
        empty.style.fontWeight = '700';
        empty.textContent = message;
    }

    async renderContactProfileManager() {
        this.ensureContactProfileModal();
        const body = this.contactProfileBody;
        if (!body) return;
        clearElement(body);
        const sessionId = trimProfileText(this.getSessionId());
        const contact = sessionId ? (this.contactsStore?.getContact?.(sessionId) || {}) : {};
        const displayName = trimProfileText(contact.name || contact.displayName || sessionId, '当前联系人');
        if (this.contactProfileTitle) this.contactProfileTitle.textContent = '联系人画像';
        if (this.contactProfileSubtitle) {
            this.contactProfileSubtitle.dataset.i18nSkip = '';
            this.contactProfileSubtitle.textContent = `${displayName} · ${sessionId || '-'}`;
        }

        const profile = this.getCurrentContactProfile(sessionId);
        const pendingUpdates = this.listContactProfilePendingUpdates(sessionId);
        if (!profile && !pendingUpdates.length) {
            this.appendContactProfileEmpty('还没有画像候选。');
        }

        if (profile) {
            const card = this.appendContactProfileCard('当前画像');
            [
                this.createContactProfileField('名称', trimProfileText(profile.displayName || displayName)),
                this.createContactProfileField('关系', trimProfileText(profile.relationship?.current)),
                this.createContactProfileField('互动', trimProfileText(profile.relationship?.user_dynamic)),
                this.createContactProfileField('近期主题', listProfileText(profile.interaction_focus, { limit: 8 })),
                this.createContactProfileField('触发词', listProfileText(profile.trigger_keywords, { limit: 12 })),
                this.createContactProfileField('稳定特征', listProfileText(profile.stable_traits, { field: 'label', limit: 6 })),
                this.createContactProfileField('重要事件', listProfileText(profile.important_events, { field: 'label', limit: 4 })),
                this.createContactProfileField('注意事项', listProfileText(profile.negative_or_sensitive, { limit: 6 })),
                this.createContactProfileField('更新时间', formatProfileUpdatedAt(profile.updatedAt)),
            ].filter(Boolean).forEach(row => card.appendChild(row));
        }

        pendingUpdates.forEach((item) => {
            const card = this.appendContactProfileCard('待保存候选');
            const profileSummary = this.describeContactProfile(item.profile || {});
            [
                this.createContactProfileField('原因', trimProfileText(item.reason, '手动更新')),
                this.createContactProfileField('摘要', profileSummary || trimProfileText(item.raw).slice(0, 240)),
                this.createContactProfileField('时间', formatProfileUpdatedAt(item.updatedAt || item.createdAt)),
            ].filter(Boolean).forEach(row => card.appendChild(row));
            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; margin-top:12px;';
            const approve = this.createContactProfileButton('保存画像', { primary: true });
            const deny = this.createContactProfileButton('忽略', { danger: true });
            approve.addEventListener('click', () => this.handleContactProfilePendingAction('approve', item.id));
            deny.addEventListener('click', () => this.handleContactProfilePendingAction('deny', item.id));
            actions.appendChild(approve);
            actions.appendChild(deny);
            card.appendChild(actions);
        });
    }

    async runContactProfileCandidateUpdate() {
        const sessionId = trimProfileText(this.getSessionId());
        if (!sessionId) return;
        const button = this.contactProfileGenerateButton;
        if (button) button.disabled = true;
        try {
            const result = await Promise.resolve(this.callContactProfileAction('runContactProfileUpdate', {
                sessionId,
                contactId: sessionId,
                reason: 'manual_contact_settings',
                force: true,
            }));
            if (!result) {
                window.toastr?.info?.('当前环境暂不支持生成画像候选');
                return;
            }
            window.toastr?.success?.('已生成画像候选');
            await this.renderContactProfileManager();
        } catch (err) {
            logger.warn('run contact profile update failed', err);
            window.toastr?.error?.(err?.message || '生成画像候选失败');
        } finally {
            if (button) button.disabled = false;
        }
    }

    async handleContactProfilePendingAction(action = '', pendingId = '') {
        const id = trimProfileText(pendingId);
        if (!id) return;
        const approving = action === 'approve';
        const ok = await appConfirm({
            title: approving ? '保存联系人画像' : '忽略画像候选',
            message: approving ? '保存后会用于后续提示词上下文和动态弱触发。' : '忽略只会清除本次候选，不删除已有画像。',
            danger: !approving,
            confirmText: approving ? '保存' : '忽略',
        });
        if (!ok) return;
        try {
            const result = await Promise.resolve(this.callContactProfileAction(
                approving ? 'approveContactProfilePendingUpdate' : 'denyContactProfilePendingUpdate',
                { id },
            ));
            if (!result?.ok) {
                const conflictMessage = result?.reason === 'profile_changed_during_operation'
                    ? '画像在候选生成后已被修改，请忽略旧候选并重新生成'
                    : (result?.reason === 'target_scope_changed'
                        ? '当前角色已切换，请返回原角色后再处理候选'
                        : '');
                window.toastr?.error?.(conflictMessage || (approving ? '保存画像失败' : '忽略候选失败'));
                return;
            }
            window.toastr?.success?.(approving ? '已保存画像' : '已忽略候选');
            await this.renderContactProfileManager();
        } catch (err) {
            logger.warn('contact profile pending action failed', err);
            window.toastr?.error?.(err?.message || '画像候选处理失败');
        }
    }

    populate() {
        this.syncVoiceOptions();
        void Promise.resolve(this.voiceRegistryStore?.ready).then(() => this.syncVoiceOptions());
        const result = runContactSettingsPopulateFlow({
            sessionId: this.getSessionId(),
            contactsStore: this.contactsStore,
            chatStore: this.chatStore,
            panel: this.panel,
            avatarPreview: this.avatarPreview,
            nameInput: this.nameInput,
            labelsInput: this.labelsInput,
            voiceSelect: this.voiceSelect,
            voiceSection: this.voiceSection,
            templateToggle: this.templateToggle,
            scriptToggle: this.scriptToggle,
            rpBridgeSection: this.rpBridgeSection,
            memoryShareSection: this.memoryShareSection,
            memoryShareSummary: this.memoryShareSummary,
            exportExperiencePackBtn: this.exportExperiencePackBtn,
            onExportExperiencePack: this.onExportExperiencePack,
            globalSettings: appSettings.get(),
            setCurrentAvatar: (value) => {
                this.currentAvatar = value;
            },
            getRpDisplayName: (sessionId) => this.getRpDisplayName(sessionId),
            refreshMemoryShareSummary: (sessionId) => this.refreshMemoryShareSummary(sessionId),
            resolveAvatar: (payload) => resolveLineAvatar(payload),
            defaultAvatar: FEATHER_DEFAULT,
            logger,
        });
        const labelsEntry = this.panel?.querySelector?.('#contact-labels-entry');
        if (labelsEntry) labelsEntry.value = '';
        this.labelsTagInput?.render();
        return result;
    }

    save() {
        this.labelsTagInput?.commitPending();
        return runContactSettingsSaveFlow({
            sessionId: this.getSessionId(),
            contactsStore: this.contactsStore,
            chatStore: this.chatStore,
            nameInput: this.nameInput,
            labelsInput: this.labelsInput,
            voiceSelect: this.voiceSelect,
            currentAvatar: this.currentAvatar,
            templateToggle: this.templateToggle,
            scriptToggle: this.scriptToggle,
            onSaved: this.onSaved,
            hide: () => this.hide(),
            notifySuccess: (message) => window.toastr?.success?.(message),
            notifyError: (message) => window.toastr?.error?.(message),
            logger,
        });
    }

    syncVoiceOptions() {
        if (!this.voiceSelect) return;
        const current = String(
            this.contactsStore?.getContact?.(this.getSessionId())?.voiceRef || this.voiceSelect.value || '',
        ).trim();
        const voices = this.voiceRegistryStore?.list?.() || [];
        this.voiceSelect.innerHTML = '';
        const addOption = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            this.voiceSelect.appendChild(option);
        };
        addOption('', '默认（全局）');
        voices.forEach(record => addOption(record.id, `${record.label} · ${record.providerSnapshot || '未知服务商'}`));
        if (current && !voices.some(record => record.id === current)) {
            addOption(current, '当前绑定（已失效，将回退默认）');
        }
        this.voiceSelect.value = current;
    }
}
