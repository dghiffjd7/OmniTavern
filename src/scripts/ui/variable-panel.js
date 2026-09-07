import { appConfirm } from './app-confirm.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { VariablePanel as VariablePanelRuntime } from './variable-panel-runtime.js';
import {
    buildVariableListRows,
    buildVariableScopeImpactText,
    formatVariableScopeLabel,
    getVariableRenderSlice,
    isVariableValueFilled,
} from './variable-panel-state-utils.js';
import {
    renderVariableListView,
    renderVariableSummaryCards,
    renderVariableTreeView,
} from './variable-panel-views.js';
import {
    renderVariableRulesPage,
    renderVariableTemplatesPage,
} from './variable-manager-pages.js';
import { VariableSchemaEditor } from './variable-schema-editor.js';
import {
    applyTemplate,
    listVariableTemplates,
} from '../variables/variable-templates.js';
import { translateUiText } from '../i18n/index.js';

export {
    buildVariableScopeImpactText,
    formatVariableScopeLabel,
};

export const VARIABLE_LIST_BATCH_SIZE = 80;

const VARIABLE_MANAGER_PAGES = new Set(['variables', 'templates', 'rules']);
const VARIABLE_UNDO_TTL_MS = 6500;

const isReducedMotion = () => (
    globalThis.document?.body?.dataset?.reducedMotion === 'on'
    || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
);

const isVisible = element => Boolean(
    element
    && element.hidden !== true
    && element.style?.display !== 'none'
);

const isTextEntry = element => {
    const tagName = String(element?.tagName || '').toLowerCase();
    return (
        tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || element?.isContentEditable === true
    );
};

const cloneValue = (value) => {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {}
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
};

const makeButton = (className, label, action, { danger = false } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${className}${danger ? ' is-danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
};

const recoveryErrorMessage = (code = '') => {
    const messages = {
        persona_not_found: '当前会话没有可重新转换的角色卡',
        not_character_card: '当前角色不是从角色卡导入，无法重新转换',
        card_unavailable: '找不到原始角色卡数据',
        card_invalid: '原始角色卡数据无效',
        no_variables: '角色卡中没有检测到 MVU 变量',
        invalid_target: '当前会话不可用',
        variable_runtime_disabled: '当前会话的变量运行已暂停，请先开启后再转换',
    };
    return messages[String(code || '')] || '重新转换变量失败';
};

export class VariablePanel extends VariablePanelRuntime {
    constructor(options) {
        super(options);
        this.isVariableRuntimeEnabled = typeof options?.isVariableRuntimeEnabled === 'function'
            ? options.isVariableRuntimeEnabled
            : sessionId => window.appBridge?.isVariableRuntimeEnabled?.(sessionId) !== false;
        this.setVariableRuntimeEnabled = typeof options?.setVariableRuntimeEnabled === 'function'
            ? options.setVariableRuntimeEnabled
            : (sessionId, enabled) => window.appBridge?.setVariableRuntimeEnabled?.(sessionId, enabled);
        this.page = 'variables';
        this.filter = 'all';
        this.sort = 'name';
        this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
        this.updatedAtByKey = Object.create(null);
        this.selectedKey = '';
        this.currentRows = [];
        this.templateTerm = '';
        this.graveyard = [];
        this.graveyardTimer = null;
        this.visibilityRevision = 0;
        this.keyboardHandler = event => this.handleKeyboard(event);
        this.elements = null;

        this.schemaEditor = new VariableSchemaEditor({
            getContext: () => this.resolveScope(),
            getSchema: key => this.getSchema(key),
            getValue: key => this.listVars()?.[key],
            getInitialValue: key => this.getInitialValue(key),
            setSchema: (key, schema) => this.setSchema(key, schema),
            deleteSchema: key => this.deleteSchema(key),
            setVariable: (key, value) => this.setVar(key, value),
            isGlobalScope: () => this.isGlobalScope(),
            restoreInitialValue: (key, value) => this.setVar(key, value),
            onChange: detail => {
                if (detail?.key) this.markVariableUpdated(detail.key);
                this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
                this.renderList();
            },
            onDelete: key => this.deleteKey(key),
            getMountRoot: () => this.panel || document.body,
        });
    }

    ensureUI() {
        if (this.overlay) return;

        const overlay = document.createElement('div');
        overlay.className = 'app-themed-overlay variable-panel-overlay variable-manager-overlay';
        overlay.style.display = 'none';
        bindBackdropActivation(overlay, {
            onActivate: () => this.hide(),
        });

        const panel = document.createElement('div');
        panel.className = 'app-themed-panel variable-panel-shell variable-manager-shell';
        panel.addEventListener('click', event => event.stopPropagation());
        panel.innerHTML = `
            <nav class="variable-manager-rail" aria-label="变量管理器页面">
                <div class="variable-manager-mark" aria-hidden="true">{ }</div>
                <button type="button" class="variable-rail-button is-active" data-variable-page="variables" aria-label="变量">
                    <span aria-hidden="true">◆</span>
                    <span class="variable-rail-label">变量</span>
                    <span class="variable-page-count" data-count="variables">0</span>
                </button>
                <button type="button" class="variable-rail-button" data-variable-page="templates" aria-label="模板">
                    <span aria-hidden="true">▦</span>
                    <span class="variable-rail-label">模板</span>
                </button>
                <button type="button" class="variable-rail-button" data-variable-page="rules" aria-label="规则">
                    <span aria-hidden="true">⌁</span>
                    <span class="variable-rail-label">规则</span>
                    <span class="variable-page-count" data-count="rules">0</span>
                </button>
                <button type="button" class="variable-rail-button variable-manager-close" data-action="close" aria-label="关闭变量管理器">
                    <span aria-hidden="true">×</span>
                    <span class="variable-rail-label">关闭</span>
                </button>
            </nav>

            <main class="variable-manager-workspace">
                <header class="variable-manager-mobile-header">
                    <div>
                        <div class="variable-manager-kicker">ROLEPLAY STATE</div>
                        <h1>变量管理器</h1>
                    </div>
                    <button type="button" class="variable-icon-button" data-action="close" aria-label="关闭">×</button>
                </header>
                <nav class="variable-manager-mobile-tabs" aria-label="变量管理页面">
                    <button type="button" class="is-active" data-variable-page="variables">变量 <span data-count="variables">0</span></button>
                    <button type="button" data-variable-page="templates">模板</button>
                    <button type="button" data-variable-page="rules">规则 <span data-count="rules">0</span></button>
                </nav>

                <section class="variable-manager-page is-active" data-page-panel="variables">
                    <header class="variable-manager-toolbar">
                        <div class="variable-toolbar-heading">
                            <div>
                                <h2>变量</h2>
                                <p id="var-meta">当前会话</p>
                            </div>
                            <span id="var-impact" class="variable-panel-scope-badge"></span>
                        </div>
                        <div class="variable-toolbar-controls">
                            <label class="variable-panel-search-box">
                                <span class="variable-panel-search-icon" aria-hidden="true">⌕</span>
                                <input id="var-search" type="search" placeholder="搜索变量…" autocomplete="off">
                                <kbd>/</kbd>
                                <button id="var-clear-search" type="button" aria-label="清除搜索" hidden>×</button>
                            </label>
                            <div class="variable-view-switch" id="var-view-toggle" role="group" aria-label="变量视图">
                                <span class="variable-view-pill" aria-hidden="true"></span>
                                <button type="button" class="is-active" data-view-mode="list">列表</button>
                                <button type="button" data-view-mode="tree">树状</button>
                            </div>
                            <label class="variable-compact-select">
                                <span>筛选</span>
                                <select id="var-filter">
                                    <option value="all">全部</option>
                                    <option value="filled">已填</option>
                                    <option value="empty">空值</option>
                                </select>
                            </label>
                            <label class="variable-compact-select">
                                <span>排序</span>
                                <select id="var-sort">
                                    <option value="name">名称</option>
                                    <option value="updated">更新时间</option>
                                </select>
                            </label>
                            <button id="var-add" type="button" class="variable-primary-button">＋ 新增</button>
                            <button id="var-more" type="button" class="variable-icon-button" aria-label="更多操作" title="更多操作">⋮</button>
                        </div>
                    </header>

                    <section class="variable-runtime-control" data-field="runtime-control">
                        <div class="variable-runtime-copy">
                            <div class="variable-runtime-title-row">
                                <strong>启用当前会话变量运行</strong>
                                <span data-field="runtime-status">运行中</span>
                            </div>
                            <p>关闭后暂停脚本、规则与宏的变量计算；分支和归档仍会恢复既有快照，避免损坏数据。</p>
                        </div>
                        <button type="button" class="variable-runtime-switch" data-action="toggle-variable-runtime" role="switch" aria-checked="true" aria-label="启用当前会话变量运行">
                            <span aria-hidden="true"></span>
                        </button>
                    </section>

                    <div id="var-cards" class="variable-summary-strip"></div>
                    <section id="var-empty-recovery" class="variable-recovery-card" hidden>
                        <div class="variable-recovery-icon" aria-hidden="true">↻</div>
                        <div>
                            <h3>变量配置存在，但当前值为空</h3>
                            <p>可先从 Schema 默认值初始化；若角色卡旧数据缺少默认值，再重新转换角色卡变量。</p>
                        </div>
                        <div class="variable-recovery-actions">
                            <button type="button" class="variable-secondary-button" data-action="initialize-variables">初始化变量</button>
                            <button type="button" class="variable-primary-button" data-action="reconvert-variables">重新转换</button>
                        </div>
                    </section>

                    <div class="variable-list-meta">
                        <span data-field="list-count">0 个变量</span>
                        <span>提示词中使用 <code class="variable-panel-inline-code">{{getvar::name}}</code></span>
                    </div>
                    <div id="var-list-scroll" class="variable-manager-scroll">
                        <div id="var-list" class="variable-list-view"></div>
                        <button id="var-load-more" type="button" class="variable-load-more" hidden>加载更多</button>
                    </div>
                </section>

                <section class="variable-manager-page" data-page-panel="templates" hidden>
                    <header class="variable-manager-toolbar">
                        <div class="variable-toolbar-heading">
                            <div>
                                <h2>变量模板</h2>
                                <p>快速建立常用的角色状态组合</p>
                            </div>
                            <span class="variable-panel-scope-badge" data-field="template-impact"></span>
                        </div>
                        <div class="variable-toolbar-controls">
                            <label class="variable-panel-search-box variable-template-search">
                                <span class="variable-panel-search-icon" aria-hidden="true">⌕</span>
                                <input id="var-template-search" type="search" placeholder="搜索模板或变量…" autocomplete="off">
                            </label>
                        </div>
                    </header>
                    <div class="variable-manager-scroll">
                        <div id="var-template-grid" class="variable-template-grid"></div>
                    </div>
                </section>

                <section class="variable-manager-page" data-page-panel="rules" hidden>
                    <header class="variable-manager-toolbar">
                        <div class="variable-toolbar-heading">
                            <div>
                                <h2>变量规则</h2>
                                <p data-field="rule-count">0 条规则已启用</p>
                            </div>
                            <span class="variable-panel-scope-badge" data-field="rule-impact"></span>
                        </div>
                        <div class="variable-toolbar-controls">
                            <button type="button" class="variable-secondary-button" data-action="run-rules">立即运行</button>
                            <button type="button" class="variable-primary-button" data-action="add-rule">＋ 新建规则</button>
                        </div>
                    </header>
                    <div class="variable-rule-banner">
                        <span aria-hidden="true">⌁</span>
                        <div>
                            <strong>规则会在对话进行中自动修改变量</strong>
                            <p>关闭规则后不会再触发；手动规则可从卡片立即运行。</p>
                        </div>
                    </div>
                    <div class="variable-manager-scroll">
                        <div id="var-rule-list" class="variable-rule-list"></div>
                    </div>
                </section>
            </main>
            <div id="variable-undo-host" class="variable-undo-host" aria-live="polite"></div>
        `;

        const query = selector => panel.querySelector(selector);
        this.elements = {
            pagePanels: Array.from(panel.querySelectorAll('[data-page-panel]')),
            pageButtons: Array.from(panel.querySelectorAll('[data-variable-page]')),
            search: query('#var-search'),
            clearSearch: query('#var-clear-search'),
            filter: query('#var-filter'),
            sort: query('#var-sort'),
            viewSwitch: query('#var-view-toggle'),
            viewPill: query('.variable-view-pill'),
            viewButtons: Array.from(panel.querySelectorAll('[data-view-mode]')),
            list: query('#var-list'),
            listScroll: query('#var-list-scroll'),
            loadMore: query('#var-load-more'),
            listCount: query('[data-field="list-count"]'),
            cards: query('#var-cards'),
            recovery: query('#var-empty-recovery'),
            meta: query('#var-meta'),
            templateSearch: query('#var-template-search'),
            templateGrid: query('#var-template-grid'),
            templateImpact: query('[data-field="template-impact"]'),
            ruleList: query('#var-rule-list'),
            ruleCount: query('[data-field="rule-count"]'),
            ruleImpact: query('[data-field="rule-impact"]'),
            runtimeControl: query('[data-field="runtime-control"]'),
            runtimeStatus: query('[data-field="runtime-status"]'),
            runtimeToggle: query('[data-action="toggle-variable-runtime"]'),
            runRules: query('[data-action="run-rules"]'),
            undoHost: query('#variable-undo-host'),
        };
        this.viewButtons = {
            list: this.elements.viewButtons.find(button => button.dataset.viewMode === 'list'),
            tree: this.elements.viewButtons.find(button => button.dataset.viewMode === 'tree'),
        };
        this.templatePanel = this.elements.pagePanels.find(
            pagePanel => pagePanel.dataset.pagePanel === 'templates',
        ) || null;
        this.rulePanel = this.elements.pagePanels.find(
            pagePanel => pagePanel.dataset.pagePanel === 'rules',
        ) || null;
        this.ruleList = this.elements.ruleList;

        panel.querySelectorAll('[data-action="close"]').forEach(button => {
            button.addEventListener('click', () => this.hide());
        });
        this.elements.pageButtons.forEach(button => {
            button.addEventListener('click', () => this.switchPage(button.dataset.variablePage));
        });
        this.elements.search?.addEventListener('input', event => {
            this.term = String(event.target?.value || '');
            this.elements.clearSearch.hidden = !this.term;
            this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
            this.renderList();
        });
        this.elements.clearSearch?.addEventListener('click', () => {
            this.term = '';
            this.elements.search.value = '';
            this.elements.clearSearch.hidden = true;
            this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
            this.renderList();
            this.elements.search.focus();
        });
        this.elements.filter?.addEventListener('change', event => {
            this.filter = String(event.target?.value || 'all');
            this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
            this.renderList();
        });
        this.elements.sort?.addEventListener('change', event => {
            this.sort = String(event.target?.value || 'name');
            this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
            this.renderList();
        });
        this.elements.viewButtons.forEach(button => {
            button.addEventListener('click', () => this.setViewMode(button.dataset.viewMode));
        });
        query('#var-add')?.addEventListener('click', () => this.promptAdd());
        query('#var-more')?.addEventListener('click', event => this.showMoreMenu(event.currentTarget));
        this.elements.loadMore?.addEventListener('click', () => this.loadMoreVariables());
        this.elements.listScroll?.addEventListener('scroll', () => {
            const scroll = this.elements.listScroll;
            if (!scroll || scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 120) return;
            this.loadMoreVariables();
        }, { passive: true });
        query('[data-action="initialize-variables"]')?.addEventListener('click', () => this.initializeVariables());
        query('[data-action="reconvert-variables"]')?.addEventListener('click', () => this.reconvertVariables());
        this.elements.templateSearch?.addEventListener('input', event => {
            this.templateTerm = String(event.target?.value || '');
            this.renderTemplatesPage();
        });
        query('[data-action="run-rules"]')?.addEventListener('click', () => this.runRules());
        this.elements.runtimeToggle?.addEventListener('click', () => this.toggleVariableRuntime());
        query('[data-action="add-rule"]')?.addEventListener('click', () => this.showRuleEditor(null));

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', this.keyboardHandler);
        this.overlay = overlay;
        this.panel = panel;
        this.updateViewToggle({ animate: false });
    }

    show({ onClose = null } = {}) {
        this.ensureUI();
        this.onClose = onClose;
        const { sid, scope } = this.resolveScope();
        this.term = '';
        this.templateTerm = '';
        this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
        if (this.elements?.search) this.elements.search.value = '';
        if (this.elements?.templateSearch) this.elements.templateSearch.value = '';
        if (this.elements?.clearSearch) this.elements.clearSearch.hidden = true;
        if (this.elements?.meta) {
            this.elements.meta.dataset.i18nSkip = '';
            this.elements.meta.textContent = translateUiText(formatVariableScopeLabel({ scope, sessionId: sid }));
        }
        this.setImpactText('#var-impact', 'manage', this.panel);
        this.syncVariableRuntimeControl();
        this.switchPage('variables', { force: true });
        const visibilityRevision = ++this.visibilityRevision;
        this.overlay.style.display = '';
        requestAnimationFrame(() => {
            if (
                this.visibilityRevision !== visibilityRevision
                || this.overlay?.style?.display === 'none'
            ) return;
            this.overlay.classList.add('is-open');
            this.updateViewToggle({ animate: false });
        });
    }

    hide() {
        this.visibilityRevision += 1;
        const onClose = this.onClose;
        this.onClose = null;
        this.schemaEditor.hide();
        this.hideRuleEditor();
        this.hideDataModal();
        this.closeMoreMenu();
        if (!this.overlay) return;
        this.overlay.classList.remove('is-open');
        const finish = () => {
            if (this.overlay && !this.overlay.classList.contains('is-open')) {
                this.overlay.style.display = 'none';
                onClose?.();
            }
        };
        if (isReducedMotion()) finish();
        else setTimeout(finish, 190);
    }

    getVariableRuntimeState() {
        const { sid } = this.resolveScope();
        if (!sid) return { sid: '', enabled: true };
        try {
            return { sid, enabled: this.isVariableRuntimeEnabled(sid) !== false };
        } catch {
            return { sid, enabled: true };
        }
    }

    syncVariableRuntimeControl() {
        const { sid, enabled } = this.getVariableRuntimeState();
        const toggle = this.elements?.runtimeToggle;
        if (toggle) {
            toggle.disabled = !sid;
            toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
            toggle.classList.toggle('is-enabled', enabled);
        }
        if (this.elements?.runtimeStatus) {
            this.elements.runtimeStatus.textContent = enabled ? '运行中' : '已暂停';
            this.elements.runtimeStatus.classList.toggle('is-paused', !enabled);
        }
        this.elements?.runtimeControl?.classList.toggle('is-paused', !enabled);
        if (this.elements?.runRules) this.elements.runRules.disabled = !sid || !enabled;
        return enabled;
    }

    async toggleVariableRuntime() {
        const { sid, enabled } = this.getVariableRuntimeState();
        const toggle = this.elements?.runtimeToggle;
        if (!sid || typeof this.setVariableRuntimeEnabled !== 'function' || toggle?.disabled) return false;
        if (toggle) toggle.disabled = true;
        let result = null;
        try {
            result = await Promise.resolve(this.setVariableRuntimeEnabled(sid, !enabled));
        } catch {}
        const ok = result?.ok === true;
        this.syncVariableRuntimeControl();
        if (!ok) {
            window.toastr?.error?.('变量运行设置保存失败');
            return false;
        }
        window.toastr?.info?.(enabled
            ? '已暂停当前会话的变量运行；已有变量仍会保留'
            : '已恢复当前会话的变量运行');
        return true;
    }

    hasVisibleLayer() {
        return Boolean(
            isVisible(this.dataOverlay)
            || isVisible(this.ruleEditorOverlay)
            || this.schemaEditor.isVisible()
            || isVisible(this.overlay)
        );
    }

    closeTopLayer() {
        if (isVisible(this.dataOverlay)) {
            this.hideDataModal();
            return true;
        }
        if (isVisible(this.ruleEditorOverlay)) {
            this.hideRuleEditor();
            return true;
        }
        if (this.schemaEditor.isVisible()) {
            this.hideSchemaModal();
            return true;
        }
        if (document.querySelector('.var-more-menu')) {
            this.closeMoreMenu();
            return true;
        }
        if (this.page !== 'variables') {
            this.switchPage('variables');
            return true;
        }
        if (isVisible(this.overlay)) {
            this.hide();
            return true;
        }
        return false;
    }

    switchPage(rawPage, { force = false } = {}) {
        this.ensureUI();
        const page = VARIABLE_MANAGER_PAGES.has(rawPage) ? rawPage : 'variables';
        if (!force && page !== 'variables' && this.isGlobalScope()) {
            window.toastr?.info?.(
                page === 'rules'
                    ? '全局变量暂不支持规则'
                    : '全局变量暂不支持模板',
            );
            return false;
        }
        this.page = page;
        this.elements.pageButtons.forEach(button => {
            const active = button.dataset.variablePage === page;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        this.elements.pagePanels.forEach(pagePanel => {
            const active = pagePanel.dataset.pagePanel === page;
            pagePanel.hidden = !active;
            pagePanel.classList.toggle('is-active', active);
            if (active) {
                pagePanel.classList.remove('is-page-entering');
                void pagePanel.offsetWidth;
                pagePanel.classList.add('is-page-entering');
            }
        });
        this.renderCurrentPage();
        return true;
    }

    renderCurrentPage() {
        if (this.page === 'templates') {
            this.renderTemplatesPage();
            return;
        }
        if (this.page === 'rules') {
            this.renderRulesPage();
            return;
        }
        this.renderList();
    }

    setViewMode(mode) {
        const next = mode === 'tree' ? 'tree' : 'list';
        if (this.viewMode === next) return;
        this.viewMode = next;
        this.visibleLimit = VARIABLE_LIST_BATCH_SIZE;
        this.updateViewToggle({ animate: true });
        this.renderList();
    }

    updateViewToggle({ animate = false } = {}) {
        const container = this.elements?.viewSwitch;
        const pill = this.elements?.viewPill;
        const activeButton = this.elements?.viewButtons?.find(
            button => button.dataset.viewMode === this.viewMode,
        );
        if (!container || !pill || !activeButton) return;
        const first = animate && !isReducedMotion() ? pill.getBoundingClientRect() : null;
        this.elements.viewButtons.forEach(button => {
            const active = button === activeButton;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const containerRect = container.getBoundingClientRect();
        const activeRect = activeButton.getBoundingClientRect();
        pill.style.left = `${activeRect.left - containerRect.left}px`;
        pill.style.width = `${activeRect.width}px`;
        if (!first || typeof pill.animate !== 'function') return;
        const last = pill.getBoundingClientRect();
        const deltaX = first.left - last.left;
        const scaleX = last.width > 0 ? first.width / last.width : 1;
        pill.animate(
            [
                { transform: `translateX(${deltaX}px) scaleX(${scaleX})`, transformOrigin: 'left center' },
                { transform: 'translateX(0) scaleX(1)', transformOrigin: 'left center' },
            ],
            {
                duration: 260,
                easing: 'cubic-bezier(.22, 1, .36, 1)',
            },
        );
    }

    markVariableUpdated(key) {
        const name = String(key || '').trim();
        if (name) this.updatedAtByKey[name] = Date.now();
    }

    getInitialValue(key) {
        const { sid } = this.resolveScope();
        if (!sid) return undefined;
        return this.chatStore?.getInitialVariable?.(String(key || '').trim(), sid);
    }

    renderCards() {
        if (!this.elements?.cards) return;
        const { vars } = this.getVars();
        return renderVariableSummaryCards({
            cardsEl: this.elements.cards,
            vars,
            schemas: this.listSchemas(),
        });
    }

    renderList() {
        if (!this.elements?.list) return;
        this.renderCards();
        const { sid, vars, scope } = this.getVars();
        const schemas = this.listSchemas();
        const allRows = buildVariableListRows({
            vars,
            schemas,
            term: this.term,
            filter: this.filter,
            sort: this.sort,
            updatedAtByKey: this.updatedAtByKey,
        });
        this.currentRows = allRows;
        if (this.elements.meta) {
            this.elements.meta.dataset.i18nSkip = '';
            this.elements.meta.textContent = translateUiText(formatVariableScopeLabel({ scope, sessionId: sid }));
        }
        if (this.elements.listCount) {
            const total = Object.keys(vars || {}).length;
            this.elements.listCount.textContent = `${allRows.length}/${total} 个变量`;
        }
        const allValuesMissing = (
            Object.keys(schemas).length > 0
            && Object.values(vars || {}).every(value => !isVariableValueFilled(value))
        );
        this.elements.recovery.hidden = !allValuesMissing || scope === 'global';
        this.elements.list.classList.toggle('is-tree-view', this.viewMode === 'tree');

        if (this.viewMode === 'tree') {
            const filteredVars = Object.fromEntries(allRows.map(row => [row.key, row.value]));
            renderVariableTreeView({
                listEl: this.elements.list,
                vars: filteredVars,
                schemas,
                term: this.term,
                hasSession: Boolean(sid),
                onConfigure: key => this.promptSchema(key),
                onCopy: key => this.copyReference(key),
            });
            this.elements.loadMore.hidden = true;
        } else {
            const slice = getVariableRenderSlice({
                rows: allRows,
                limit: this.visibleLimit,
                batchSize: VARIABLE_LIST_BATCH_SIZE,
            });
            renderVariableListView({
                listEl: this.elements.list,
                rows: slice.rows,
                hasSession: Boolean(sid),
                onConfigure: key => this.promptSchema(key),
                onEdit: (key, value) => this.promptEdit(key, value),
                onDelete: key => this.deleteKey(key),
                onCopy: key => this.copyReference(key),
                onChangeValue: (key, value) => {
                    if (this.setVar(key, value) === false) return;
                    this.markVariableUpdated(key);
                    this.renderList();
                },
                onSelect: key => {
                    this.selectedKey = key;
                },
            });
            this.elements.loadMore.hidden = !slice.hasMore;
            if (slice.hasMore) {
                this.elements.loadMore.textContent = `加载更多（剩余 ${slice.total - slice.rendered}）`;
            }
        }
        this.updatePageCounts();
        this.syncSelectedRow();
    }

    loadMoreVariables() {
        if (this.viewMode !== 'list' || this.visibleLimit >= this.currentRows.length) return;
        this.visibleLimit = Math.min(
            this.currentRows.length,
            this.visibleLimit + VARIABLE_LIST_BATCH_SIZE,
        );
        this.renderList();
    }

    updatePageCounts() {
        const variableCount = Object.keys(this.listVars() || {}).length;
        const ruleCount = this.listRules().length;
        this.panel?.querySelectorAll?.('[data-count="variables"]')?.forEach?.(element => {
            element.textContent = String(variableCount);
        });
        this.panel?.querySelectorAll?.('[data-count="rules"]')?.forEach?.(element => {
            element.textContent = String(ruleCount);
        });
    }

    syncSelectedRow() {
        const rows = Array.from(this.elements?.list?.querySelectorAll?.('[data-variable-key]') || []);
        rows.forEach(row => row.classList.toggle(
            'is-selected',
            row.dataset.variableKey === this.selectedKey,
        ));
    }

    moveSelection(delta) {
        if (!this.currentRows.length) return;
        let index = this.currentRows.findIndex(row => row.key === this.selectedKey);
        if (index < 0) index = delta > 0 ? -1 : 0;
        index = (index + delta + this.currentRows.length) % this.currentRows.length;
        this.selectedKey = this.currentRows[index].key;
        if (index >= this.visibleLimit) {
            this.visibleLimit = Math.min(
                this.currentRows.length,
                Math.ceil((index + 1) / VARIABLE_LIST_BATCH_SIZE) * VARIABLE_LIST_BATCH_SIZE,
            );
            this.renderList();
        }
        this.syncSelectedRow();
        const selected = this.elements?.list?.querySelector?.(
            `[data-variable-key="${CSS.escape(this.selectedKey)}"]`,
        );
        selected?.scrollIntoView?.({ block: 'nearest' });
    }

    showSchemaModal({ key = '', value = undefined, schema = null, mode = 'create' } = {}) {
        this.ensureUI();
        const name = String(key || '').trim();
        this.selectedKey = name;
        this.schemaEditor.show({
            key: name,
            value: value !== undefined ? value : this.listVars()?.[name],
            schema: schema || this.getSchema(name),
            mode,
        });
        this.schemaOverlay = this.schemaEditor.overlay;
        this.schemaPanel = this.schemaEditor.panel;
    }

    hideSchemaModal() {
        this.schemaEditor.hide();
    }

    showTemplateModal() {
        return this.switchPage('templates');
    }

    hideTemplateModal() {
        if (this.page === 'templates') this.switchPage('variables');
    }

    showRules() {
        return this.switchPage('rules');
    }

    hideRules() {
        if (this.page === 'rules') this.switchPage('variables');
    }

    renderTemplatesPage() {
        if (!this.elements?.templateGrid) return;
        const { sid, vars, scope } = this.getVars();
        if (this.elements.templateImpact) {
            const impact = buildVariableScopeImpactText({
                scope,
                sessionId: sid,
                action: 'templates',
            });
            this.elements.templateImpact.dataset.i18nSkip = '';
            this.elements.templateImpact.textContent = translateUiText(formatVariableScopeLabel({ scope, sessionId: sid }));
            this.elements.templateImpact.title = translateUiText(impact);
        }
        renderVariableTemplatesPage({
            container: this.elements.templateGrid,
            templates: listVariableTemplates(),
            vars,
            term: this.templateTerm,
            onApply: template => this.applyVariableTemplate(template),
        });
        this.updatePageCounts();
    }

    async applyVariableTemplate(template) {
        const { sid, vars, scope } = this.getVars();
        if (!sid || scope === 'global') return false;
        const keys = (template?.variables || [])
            .map(variable => String(variable?.id || variable?.name || '').trim())
            .filter(Boolean);
        const existing = keys.filter(key => Object.prototype.hasOwnProperty.call(vars || {}, key));
        if (existing.length) {
            const confirmed = await appConfirm({
                title: '覆盖模板变量',
                message: `已存在变量：${existing.join('、')}\n模板会覆盖这些值，是否继续？\n\n${buildVariableScopeImpactText({
                    scope,
                    sessionId: sid,
                    action: 'templates',
                })}`,
                danger: true,
            });
            if (!confirmed) return false;
        }
        const result = applyTemplate(this.chatStore, sid, template.id, { overwrite: true });
        if (!result?.ok) {
            window.toastr?.error?.('模板应用失败');
            return false;
        }
        (template.variables || []).forEach(variable => {
            const key = String(variable?.id || variable?.name || '').trim();
            if (!key || !Object.prototype.hasOwnProperty.call(variable || {}, 'default')) return;
            this.chatStore?.setInitialVariable?.(key, cloneValue(variable.default), sid);
            this.markVariableUpdated(key);
        });
        window.toastr?.success?.('模板已应用');
        this.renderTemplatesPage();
        return true;
    }

    renderRulesPage() {
        if (!this.elements?.ruleList) return;
        const { sid, scope, rules } = this.getRules();
        if (this.elements.ruleImpact) {
            const impact = buildVariableScopeImpactText({
                scope,
                sessionId: sid,
                action: 'rules',
            });
            this.elements.ruleImpact.dataset.i18nSkip = '';
            this.elements.ruleImpact.textContent = translateUiText(formatVariableScopeLabel({ scope, sessionId: sid }));
            this.elements.ruleImpact.title = translateUiText(impact);
        }
        const result = renderVariableRulesPage({
            container: this.elements.ruleList,
            rules,
            normalizeRule: rule => this.normalizeRule(rule),
            describeTrigger: rule => this.describeRuleTrigger(rule),
            describeAction: rule => this.describeRuleAction(rule),
            onToggle: (ruleId, enabled) => this.toggleRule(ruleId, enabled),
            onEdit: rule => this.showRuleEditor(rule),
            onDelete: ruleId => this.deleteRuleById(ruleId),
            onRun: ruleId => this.runRule(ruleId),
        });
        if (this.elements.ruleCount) {
            this.elements.ruleCount.textContent = `${result.enabled} / ${result.rendered} 条规则已启用`;
        }
        this.syncVariableRuntimeControl();
        this.updatePageCounts();
    }

    renderRuleList() {
        this.renderRulesPage();
    }

    toggleRule(ruleId, enabled) {
        const { rules } = this.getRules();
        const targetId = String(ruleId || '');
        this.setRules(rules.map(rule => (
            String(rule?.id || '') === targetId ? { ...rule, enabled: Boolean(enabled) } : rule
        )));
        this.renderRulesPage();
    }

    runRules() {
        const { sid } = this.getRules();
        if (!sid) {
            window.toastr?.warning?.('请先进入聊天室');
            return false;
        }
        if (!this.isVariableRuntimeEnabled(sid)) {
            window.toastr?.warning?.('当前会话的变量运行已暂停');
            return false;
        }
        if (typeof window.appBridge?.runVariableRules !== 'function') {
            window.toastr?.warning?.('规则引擎未就绪');
            return false;
        }
        window.appBridge.runVariableRules(sid);
        window.toastr?.info?.('已触发当前启用规则');
        return true;
    }

    deleteRuleById(ruleId) {
        const { sid, rules } = this.getRules();
        const id = String(ruleId || '').trim();
        const index = rules.findIndex(rule => String(rule?.id || '') === id);
        if (!sid || index < 0) return false;
        const rule = cloneValue(rules[index]);
        this.setRules(rules.filter((_, currentIndex) => currentIndex !== index));
        this.pushGraveyard({
            kind: 'rule',
            label: rule?.name || id,
            rule,
            index,
        });
        this.renderRulesPage();
        return true;
    }

    deleteKey(rawKey) {
        const key = String(rawKey || '').trim();
        const { sid, vars } = this.getVars();
        if (!sid || !key || !Object.prototype.hasOwnProperty.call(vars || {}, key)) return false;
        const schema = this.getSchema(key);
        const record = {
            kind: 'variable',
            label: key,
            key,
            value: cloneValue(vars[key]),
            schema: cloneValue(schema),
            hasSchema: Boolean(schema),
        };
        this.deleteVar(key);
        this.deleteSchema(key);
        this.pushGraveyard(record);
        if (this.selectedKey === key) this.selectedKey = '';
        this.renderList();
        return true;
    }

    pushGraveyard(entry) {
        const record = {
            ...entry,
            id: `variable-grave-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            deletedAt: Date.now(),
        };
        this.graveyard.push(record);
        if (this.graveyard.length > 20) this.graveyard.shift();
        this.showUndoToast(record);
        return record.id;
    }

    showUndoToast(record) {
        const host = this.elements?.undoHost;
        if (!host) return;
        if (this.graveyardTimer) clearTimeout(this.graveyardTimer);
        host.replaceChildren();
        const toast = document.createElement('div');
        toast.className = 'variable-undo-toast';
        const message = document.createElement('span');
        message.textContent = record.kind === 'rule'
            ? `已删除规则「${record.label}」`
            : `已删除变量「${record.label}」`;
        const undo = makeButton('variable-undo-button', '撤销', () => this.undoGraveyard(record.id));
        const close = makeButton('variable-undo-close', '×', () => host.replaceChildren());
        close.setAttribute('aria-label', '关闭');
        toast.appendChild(message);
        toast.appendChild(undo);
        toast.appendChild(close);
        host.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('is-visible'));
        this.graveyardTimer = setTimeout(() => {
            toast.classList.remove('is-visible');
            setTimeout(() => {
                if (host.contains(toast)) toast.remove();
            }, isReducedMotion() ? 0 : 180);
            this.graveyard = this.graveyard.filter(item => item.id !== record.id);
        }, VARIABLE_UNDO_TTL_MS);
    }

    undoGraveyard(recordId) {
        const index = this.graveyard.findIndex(record => record.id === recordId);
        if (index < 0) return false;
        const [record] = this.graveyard.splice(index, 1);
        if (record.kind === 'variable') {
            this.setVar(record.key, cloneValue(record.value));
            if (record.hasSchema) this.setSchema(record.key, cloneValue(record.schema));
            this.markVariableUpdated(record.key);
            this.renderList();
        } else if (record.kind === 'rule') {
            const { rules } = this.getRules();
            const next = rules.slice();
            next.splice(Math.min(record.index, next.length), 0, cloneValue(record.rule));
            this.setRules(next);
            this.renderRulesPage();
        }
        if (this.graveyardTimer) clearTimeout(this.graveyardTimer);
        this.elements?.undoHost?.replaceChildren();
        window.toastr?.success?.('已撤销删除');
        return true;
    }

    async copyReference(key) {
        const name = String(key || '').trim();
        if (!name) return false;
        const reference = `{{getvar::${name}}}`;
        try {
            await navigator.clipboard?.writeText?.(reference);
            window.toastr?.success?.('变量引用已复制');
            return true;
        } catch {
            window.toastr?.warning?.('复制失败');
            return false;
        }
    }

    async initializeVariables() {
        const { sid } = this.resolveScope();
        const initializeMvuVariables = window.appBridge?.initializeMvuVariables;
        if (!sid || typeof initializeMvuVariables !== 'function') {
            window.toastr?.warning?.('变量初始化服务未就绪');
            return null;
        }
        if (!this.isVariableRuntimeEnabled(sid)) {
            window.toastr?.warning?.('当前会话的变量运行已暂停，请先开启');
            return null;
        }
        const result = await Promise.resolve(initializeMvuVariables(sid, {
            reason: 'variable_manager_empty_state',
        }));
        this.renderList();
        if (result?.applied || result?.keys?.length) {
            window.toastr?.success?.(`已初始化 ${result.keys.length} 个变量`);
        } else {
            window.toastr?.info?.('Schema 中没有可用默认值，可尝试「重新转换」');
        }
        return result;
    }

    async reconvertVariables() {
        const { sid, scope } = this.resolveScope();
        const reconvertMvuVariables = window.appBridge?.reconvertMvuVariables;
        if (!sid || typeof reconvertMvuVariables !== 'function') {
            window.toastr?.warning?.('变量重新转换服务未就绪');
            return null;
        }
        if (!this.isVariableRuntimeEnabled(sid)) {
            window.toastr?.warning?.('当前会话的变量运行已暂停，请先开启');
            return null;
        }
        const confirmed = await appConfirm({
            title: '从角色卡重新转换变量',
            message: `将重新读取原始角色卡，刷新 Schema 默认值与初始值；当前变量只会填补空缺，0、false、数组、对象及已有文本均不会被覆盖。\n\n${buildVariableScopeImpactText({
                scope,
                sessionId: sid,
                action: 'edit',
            })}`,
            danger: false,
        });
        if (!confirmed) return null;
        const result = await reconvertMvuVariables({ sessionId: sid });
        this.renderList();
        if (!result?.ok) {
            window.toastr?.warning?.(recoveryErrorMessage(result?.code));
            return result;
        }
        window.toastr?.success?.(
            `重新转换完成：填补 ${result.filledKeys?.length || 0} 项，保留 ${result.preservedKeys?.length || 0} 项`,
        );
        return result;
    }

    showMoreMenu(anchor) {
        if (document.querySelector('.var-more-menu')) {
            this.closeMoreMenu();
            return;
        }
        const menu = document.createElement('div');
        menu.className = 'var-more-menu variable-manager-menu';
        const items = [
            ['导出', () => this.showExportModal()],
            ['导入', () => this.showImportModal()],
            ['重新转换变量', () => this.reconvertVariables()],
            ['清空当前变量', () => this.clearAll(), { danger: true }],
        ];
        items.forEach(([label, action, options]) => {
            menu.appendChild(makeButton(
                'variable-manager-menu-item',
                label,
                () => {
                    this.closeMoreMenu();
                    action();
                },
                options,
            ));
        });
        document.body.appendChild(menu);
        const rect = anchor?.getBoundingClientRect?.() || {
            left: globalThis.innerWidth - 180,
            right: globalThis.innerWidth - 16,
            bottom: 56,
        };
        const menuWidth = 184;
        const left = Math.max(8, Math.min(
            globalThis.innerWidth - menuWidth - 8,
            rect.right - menuWidth,
        ));
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.min(globalThis.innerHeight - menu.offsetHeight - 8, rect.bottom + 6)}px`;
        const closeMenu = event => {
            if (!menu.contains(event.target) && event.target !== anchor) this.closeMoreMenu();
        };
        this.moreMenuCloseHandler = closeMenu;
        setTimeout(() => document.addEventListener('pointerdown', closeMenu, true), 0);
    }

    handleKeyboard(event) {
        if (!isVisible(this.overlay)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closeTopLayer();
            return;
        }
        if ((globalThis.innerWidth || 0) < 768 || this.schemaEditor.isVisible()) return;
        const typing = isTextEntry(event.target || document.activeElement);
        if (event.key === '/' && !typing) {
            event.preventDefault();
            this.switchPage('variables');
            this.elements?.search?.focus?.();
            return;
        }
        if (event.key.toLowerCase() === 'n' && !typing) {
            event.preventDefault();
            if (this.page === 'rules') this.showRuleEditor(null);
            else {
                this.switchPage('variables');
                this.promptAdd();
            }
            return;
        }
        if (this.page !== 'variables' || typing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key === 'Enter' && this.selectedKey) {
            event.preventDefault();
            this.promptSchema(this.selectedKey);
        }
    }
}
