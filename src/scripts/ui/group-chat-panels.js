/**
 * Group chat panels
 * - Create group from contacts
 * - Manage group settings (name/avatar/members)
 */

import { logger } from '../utils/logger.js';
import { avatarDataUrlFromFile } from '../utils/image.js';
import { FEATHER_DEFAULT, resolveLineAvatar } from '../utils/line-avatar.js';
import { appSettings } from '../storage/app-settings.js';
import { MemoryTableEditor } from './memory-table-editor.js';
import { appConfirm } from './app-confirm.js';
import { createGroupCreateRuntime } from './group-create-runtime-utils.js';
import { createContactAvatarElement } from './group-avatar-view-utils.js';
import { createGroupPanelMotionRuntime } from './group-panel-motion-runtime-utils.js';
import { resolveContactGroupColor } from '../storage/contact-group-color-utils.js';
import { createGroupMemoryShareRuntime } from './group-memory-share-runtime-utils.js';
import { createGroupMemberManagementRuntime } from './group-member-management-runtime-utils.js';
import { runGroupSettingsSaveFlow } from './group-settings-save-runtime-utils.js';
import { getMemoryTableStore, getMemoryTemplateStore } from './memory-store-runtime-utils.js';
import {
    applySessionPanelMemoryMode,
    runSessionPanelShowFlow,
} from './session-panel-display-runtime-utils.js';
import {
    buildSessionCheckboxInputStyle,
    buildSessionSummaryRowStyle,
} from './session-panel-style-utils.js';
import {
    buildSessionSettingsCloseInnerHtml,
    buildSessionSettingsNavHtml,
    createSessionSettingsChrome,
    isSettingsReducedMotion,
    SESSION_SETTINGS_ICONS,
    SETTINGS_DISCARD_CONFIRM,
} from './session-settings-chrome-utils.js';
import { t, translateUiText } from '../i18n/index.js';
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

const genGroupId = () => `group:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const normalize = (s) => String(s || '').trim();
const normalizeKey = (s) => normalize(s).toLowerCase().replace(/\s+/g, '');

const defaultAvatar = FEATHER_DEFAULT;

const resolveContactAvatar = (contact, fallbackName = '') => {
    const c = contact || {};
    const name = String(c?.name || fallbackName || c?.id || '').trim() || '未知';
    const tags = Array.isArray(c?.libraryTags) && c.libraryTags.length
        ? c.libraryTags
        : Array.isArray(c?.labels)
            ? c.labels
            : [];
    return resolveLineAvatar({
        avatar: c?.avatar || defaultAvatar,
        name,
        tags,
        size: 96,
    });
};

export class GroupCreatePanel {
    constructor({ contactsStore, chatStore, groupStore = null, onCreated } = {}) {
        this.contactsStore = contactsStore;
        this.chatStore = chatStore;
        this.groupStore = groupStore;
        this.onCreated = typeof onCreated === 'function' ? onCreated : null;

        this.overlay = null;
        this.panel = null;
        this.fileInput = null;
        this.motion = null;

        this.avatar = '';
        this.selected = new Set();
        this.validationAttempted = false;
        this.createRuntime = null;
    }

    show() {
        if (!this.panel) this.createUI();
        this.avatar = '';
        this.selected.clear();
        this.validationAttempted = false;
        this.panel.querySelector('#group-name').value = '';
        this.panel.querySelector('#group-search').value = '';
        this.updateHeaderCopy();
        this.renderContacts();
        this.updateAvatarPreview();
        this.updateCreateEnabled();
        this.motion?.show();
        setTimeout(() => this.panel?.querySelector?.('#group-name')?.focus?.(), 100);
    }

    hide() {
        this.motion?.hide();
    }

    ensureCreateRuntime() {
        if (this.createRuntime) return this.createRuntime;
        this.createRuntime = createGroupCreateRuntime({
            getPanel: () => this.panel,
            getSelected: () => this.selected,
            getContactsStore: () => this.contactsStore,
            getChatStore: () => this.chatStore,
            getAvatar: () => this.avatar,
            normalize,
            normalizeKey,
            resolveContactAvatar,
            genGroupId,
            hide: () => this.hide(),
            onCreated: this.onCreated,
            onSelectionChanged: () => this.syncSelectionUI(),
            onValidationError: (validation) => this.showValidationMotion(validation),
            notifySuccess: (message) => window.toastr?.success?.(message),
            notifyError: (message) => window.toastr?.error?.(message),
            logger,
            deps: {
                createSelectableContactEmptyState: () => this.createEmptyContactState(),
                createSelectableContactRow: (payload) => this.createMemberRow(payload),
            },
        });
        return this.createRuntime;
    }

    createUI() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'group-create-overlay';
        this.overlay.className = 'app-themed-overlay group-redesign-overlay group-create-overlay';
        this.overlay.style.display = 'none';

        this.panel = document.createElement('div');
        this.panel.id = 'group-create-panel';
        this.panel.className = 'app-themed-panel group-redesign-panel group-create-panel';
        this.panel.style.display = 'none';
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-modal', 'true');
        this.panel.setAttribute('aria-labelledby', 'group-create-title');
        this.panel.addEventListener('click', (event) => event.stopPropagation());
        this.panel.innerHTML = `
            <header class="group-redesign-header group-create-header">
                <button id="group-avatar-btn" class="group-create-avatar-button" type="button" title="选择群组头像" aria-label="选择群组头像">
                    <span id="group-avatar-preview" class="group-create-avatar-preview"></span>
                    <span class="group-create-avatar-edit" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="M14.5 5 13 3h-2L9.5 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"></path><circle cx="12" cy="12" r="3.2"></circle></svg>
                    </span>
                </button>
                <div class="group-redesign-heading">
                    <h2 id="group-create-title">创建群组</h2>
                    <p id="group-create-subtitle">给新群组起个名字，再挑几位聊得来的伙伴</p>
                </div>
                <button id="group-close" class="group-redesign-close" type="button" aria-label="关闭">
                    <svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg>
                </button>
            </header>

            <div class="group-create-body">
                <section class="group-create-name-section">
                    <label class="group-create-label" for="group-name">群组名称<span class="group-required-dot" aria-hidden="true"></span></label>
                    <div id="group-name-field" class="group-create-input-shell">
                        <input id="group-name" maxlength="20" placeholder="例如：周五奶茶拼单群" autocomplete="off">
                        <span id="group-name-count" class="group-create-count">0/20</span>
                    </div>
                    <div id="group-name-hint" class="group-create-validation" aria-live="polite"></div>
                </section>

                <section id="group-selected-section" class="group-selected-section" hidden>
                    <div class="group-create-section-heading">
                        <span>已选成员</span>
                        <span id="group-selected-count" class="group-selected-count">0</span>
                        <button id="group-selected-clear" type="button">清空</button>
                    </div>
                    <div id="group-selected-chips" class="group-selected-chips"></div>
                </section>

                <section class="group-create-members-section">
                    <div class="group-create-member-toolbar">
                        <span class="group-create-label">选择成员</span>
                        <label class="group-create-search">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
                            <input id="group-search" placeholder="搜索联系人…" autocomplete="off">
                        </label>
                    </div>
                    <div id="group-contacts" class="group-create-contact-list"></div>
                    <div id="group-member-hint" class="group-create-validation" aria-live="polite"></div>
                </section>
            </div>

            <footer class="group-create-footer">
                <div id="group-footer-selected" class="group-footer-selected"></div>
                <div class="group-create-footer-actions">
                    <button id="group-cancel" class="group-redesign-cancel" type="button">取消</button>
                    <button id="group-create" class="group-redesign-primary" type="button" aria-disabled="true">创建群组</button>
                </div>
            </footer>
        `;
        this.overlay.addEventListener('click', () => this.hide());

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.onchange = async () => {
            const file = this.fileInput.files?.[0];
            if (!file) return;
            try {
                this.avatar = await avatarDataUrlFromFile(file, { maxDim: 256, quality: 0.84, maxBytes: 520_000 });
                this.updateAvatarPreview();
            } catch (err) {
                logger.warn('读取/压缩群组头像失败', err);
                window.toastr?.error?.('读取头像失败');
            }
        };

        document.body.appendChild(this.overlay);
        document.body.appendChild(this.panel);
        document.body.appendChild(this.fileInput);
        this.motion = createGroupPanelMotionRuntime({
            overlayEl: this.overlay,
            panelEl: this.panel,
            isReducedMotion: () =>
                document.body?.dataset?.reducedMotion === 'on' ||
                window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
        });

        this.panel.querySelector('#group-close').onclick = () => this.hide();
        this.panel.querySelector('#group-cancel').onclick = () => this.hide();
        this.panel.querySelector('#group-avatar-btn').onclick = () => {
            this.fileInput.value = '';
            this.fileInput.click();
        };
        this.panel.querySelector('#group-name').addEventListener('input', () => {
            this.updateHeaderCopy();
            this.updateAvatarPreview();
            this.updateCreateEnabled();
        });
        this.panel.querySelector('#group-name').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            this.createGroup();
        });
        this.panel.querySelector('#group-search').addEventListener('input', () => this.renderContacts());
        this.panel.querySelector('#group-create').onclick = () => this.createGroup();
        this.panel.querySelector('#group-selected-clear').onclick = () => {
            this.selected.clear();
            this.ensureCreateRuntime().syncRenderedSelection();
        };
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.motion?.isVisible?.()) this.hide();
        });
    }

    updateAvatarPreview() {
        const preview = this.panel?.querySelector('#group-avatar-preview');
        if (!preview) return;
        const nameInput = this.panel?.querySelector('#group-name');
        const name = String(nameInput?.value || '群聊').trim() || '群聊';
        const avatar = createContactAvatarElement({
            documentRef: document,
            sessionId: 'group:preview',
            contact: {
                id: 'group:preview',
                name,
                avatar: this.avatar,
                isGroup: true,
                members: [...this.selected],
            },
            getContact: (id) => this.contactsStore?.getContact?.(id),
            resolveAvatar: (id, contact) => resolveContactAvatar(contact, id),
            className: 'group-create-avatar-art',
        });
        preview.replaceChildren(avatar);
        this.panel?.querySelector?.('#group-avatar-btn')?.classList?.toggle?.('has-manual-avatar', Boolean(this.avatar));
    }

    updateCreateEnabled() {
        const state = this.ensureCreateRuntime().updateCreateEnabled();
        const revealValidation = this.validationAttempted;
        const nameHint = this.panel?.querySelector?.('#group-name-hint');
        const memberHint = this.panel?.querySelector?.('#group-member-hint');
        this.panel?.querySelector?.('#group-name-field')?.classList?.toggle?.(
            'is-invalid',
            Boolean(revealValidation && state?.nameError),
        );
        this.panel?.querySelector?.('.group-create-members-section')?.classList?.toggle?.(
            'is-invalid',
            Boolean(revealValidation && state?.memberError),
        );
        if (!revealValidation) {
            if (nameHint) {
                nameHint.textContent = '';
                nameHint.style.color = 'var(--app-text-muted)';
            }
            if (memberHint) {
                memberHint.textContent = `已选择 ${state?.membersCount || 0} 位成员`;
                memberHint.style.color = 'var(--app-text-muted)';
            }
        }
        return state;
    }

    renderContacts() {
        return this.ensureCreateRuntime().renderContacts();
    }

    createGroup() {
        return this.ensureCreateRuntime().createGroup();
    }

    updateHeaderCopy() {
        const input = this.panel?.querySelector?.('#group-name');
        const name = String(input?.value || '').trim();
        const subtitle = this.panel?.querySelector?.('#group-create-subtitle');
        const counter = this.panel?.querySelector?.('#group-name-count');
        if (subtitle) {
            subtitle.textContent = name
                ? `「${name}」即将诞生`
                : '给新群组起个名字，再挑几位聊得来的伙伴';
        }
        if (counter) counter.textContent = `${String(input?.value || '').length}/20`;
    }

    getSelectedContacts() {
        return [...this.selected]
            .map((id) => this.contactsStore?.getContact?.(id) || null)
            .filter(Boolean);
    }

    syncSelectionUI() {
        if (!this.panel) return;
        const contacts = this.getSelectedContacts();
        const section = this.panel.querySelector('#group-selected-section');
        const count = this.panel.querySelector('#group-selected-count');
        const chips = this.panel.querySelector('#group-selected-chips');
        const footer = this.panel.querySelector('#group-footer-selected');
        if (section) section.hidden = contacts.length === 0;
        if (count) count.textContent = String(contacts.length);

        if (chips) {
            const rendered = new Map(
                [...chips.querySelectorAll('.group-selected-chip[data-contact-id]')]
                    .map((chip) => [chip.dataset.contactId, chip]),
            );
            // 只追加新 chip：appendChild 移动既有节点会重放入场动画，整条已选栏跟着闪
            let appendedInBatch = 0;
            contacts.forEach((contact) => {
                let chip = rendered.get(contact.id);
                if (!chip) {
                    chip = document.createElement('span');
                    chip.className = 'group-selected-chip';
                    chip.dataset.contactId = contact.id;
                    const image = document.createElement('img');
                    image.alt = '';
                    const name = document.createElement('span');
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>';
                    chip.append(image, name, remove);
                }
                rendered.delete(contact.id);
                if (chip._groupChipRemovalTimer) {
                    clearTimeout(chip._groupChipRemovalTimer);
                    chip._groupChipRemovalTimer = null;
                }
                chip.classList.remove('is-leaving');
                const image = chip.querySelector('img');
                image.src = resolveContactAvatar(contact, contact.id);
                const name = chip.querySelector(':scope > span');
                name.textContent = contact.name || contact.id;
                const remove = chip.querySelector('button');
                remove.setAttribute('aria-label', `移除 ${contact.name || contact.id}`);
                remove.onclick = () => {
                    this.selected.delete(contact.id);
                    this.ensureCreateRuntime().syncRenderedSelection();
                };
                if (!chip.isConnected) {
                    // 交错延迟只按本批新增计数：整面板首次填充有阶梯感，单个勾选零延迟
                    chip.style.setProperty('--group-chip-index', String(Math.min(appendedInBatch, 8)));
                    appendedInBatch += 1;
                    chips.appendChild(chip);
                }
            });
            rendered.forEach((chip) => {
                chip.classList.add('is-leaving');
                chip._groupChipRemovalTimer = setTimeout(() => chip.remove(), 140);
            });
        }

        if (footer) {
            if (!contacts.length) {
                if (!footer.querySelector('.group-footer-empty')) {
                    const empty = document.createElement('span');
                    empty.className = 'group-footer-empty';
                    empty.innerHTML = `
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path></svg>
                        从上方挑几位聊得来的伙伴
                    `;
                    footer.replaceChildren(empty);
                }
            } else {
                let stack = footer.querySelector('.group-avatar-stack');
                let text = footer.querySelector('.group-footer-count');
                if (!stack || !text) {
                    stack = document.createElement('span');
                    stack.className = 'group-avatar-stack';
                    text = document.createElement('span');
                    text.className = 'group-footer-count';
                    footer.replaceChildren(stack, text);
                }
                const rendered = new Map(
                    [...stack.querySelectorAll('img[data-contact-id]')]
                        .map((image) => [image.dataset.contactId, image]),
                );
                contacts.slice(0, 5).forEach((contact) => {
                    let image = rendered.get(contact.id);
                    if (!image) {
                        image = document.createElement('img');
                        image.dataset.contactId = contact.id;
                        image.alt = '';
                    }
                    rendered.delete(contact.id);
                    image.src = resolveContactAvatar(contact, contact.id);
                    stack.appendChild(image);
                });
                rendered.forEach((image) => image.remove());
                stack.querySelectorAll('img:not([data-contact-id])').forEach((image) => image.remove());
                const total = document.createElement('b');
                total.textContent = String(contacts.length);
                text.replaceChildren('已选 ', total, ' 位伙伴');
            }
        }
        this.updateCreateEnabled();
        this.updateAvatarPreview();
    }

    createEmptyContactState() {
        const empty = document.createElement('div');
        empty.className = 'group-create-empty';
        const query = String(this.panel?.querySelector?.('#group-search')?.value || '').trim();
        empty.innerHTML = `
            <span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4M8.5 8.5l5 5M13.5 8.5l-5 5"></path></svg></span>
            <p>${query ? '没有找到相关联系人' : '暂无可选联系人'}</p>
        `;
        return empty;
    }

    createMemberRow({ id, name, avatar, contact = {}, index = 0, selected = false, onClick } = {}) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `group-create-member-row${selected ? ' is-selected' : ''}`;
        row.dataset.contactId = id;
        row.setAttribute('aria-pressed', selected ? 'true' : 'false');
        row.style.setProperty('--group-member-index', String(Math.min(index, 12)));
        row.onclick = onClick;

        const check = document.createElement('span');
        check.className = 'group-create-member-check';
        check.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.4 4.7 8.8 9.8 3.4"></path></svg>';

        const image = document.createElement('img');
        image.className = 'group-create-member-avatar';
        image.src = avatar || defaultAvatar;
        image.alt = '';

        const info = document.createElement('span');
        info.className = 'group-create-member-info';
        const memberName = document.createElement('span');
        memberName.className = 'group-create-member-name';
        memberName.setAttribute('data-i18n-skip', '');
        memberName.textContent = name || id;
        const description = document.createElement('span');
        description.className = 'group-create-member-description';
        const descriptionValue = String(contact?.description || contact?.signature || contact?.remark || '').trim();
        if (descriptionValue) description.setAttribute('data-i18n-skip', '');
        description.textContent = descriptionValue || '准备好一起聊天';
        info.append(memberName, description);

        const organization = (this.groupStore?.listGroups?.() || [])
            .find((group) => Array.isArray(group?.contacts) && group.contacts.includes(id));
        if (organization) {
            const color = resolveContactGroupColor(organization.color);
            const badge = document.createElement('span');
            badge.className = 'group-create-member-group';
            badge.setAttribute('data-i18n-skip', '');
            badge.style.setProperty('--group-badge-color', color.value);
            badge.innerHTML = `<i></i><span></span>`;
            badge.lastElementChild.textContent = organization.name;
            row.append(check, image, info, badge);
        } else {
            row.append(check, image, info);
        }

        const selectedText = document.createElement('span');
        selectedText.className = 'group-create-member-selected';
        selectedText.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg><span>已选</span>';
        row.appendChild(selectedText);
        return { row };
    }

    showValidationMotion(validation = {}) {
        this.validationAttempted = true;
        this.updateCreateEnabled();
        const target = validation?.nameError
            ? this.panel?.querySelector?.('.group-create-name-section')
            : this.panel?.querySelector?.('.group-create-members-section');
        if (!target) return;
        target.classList.remove('is-shaking');
        void target.offsetWidth;
        target.classList.add('is-shaking');
        setTimeout(() => target.classList.remove('is-shaking'), 420);
    }
}

export class GroupSettingsPanel {
    constructor({
        contactsStore,
        chatStore,
        memoryTableStore = null,
        memoryTemplateStore = null,
        onSaved,
    } = {}) {
        this.contactsStore = contactsStore;
        this.chatStore = chatStore;
        const bridge = typeof window !== 'undefined' ? window.appBridge : null;
        this.memoryTableStore = memoryTableStore || getMemoryTableStore(bridge);
        this.memoryTemplateStore = memoryTemplateStore || getMemoryTemplateStore(bridge);
        this.onSaved = typeof onSaved === 'function' ? onSaved : null;

        this.overlay = null;
        this.panel = null;
        this.fileInput = null;

        this.groupId = '';
        this.avatar = '';
        this.members = [];
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
        this.rpBridgeSection = null;
        this.rpBridgeToggle = null;
        this.rpBridgeLimitInput = null;
        this.rpBridgeSourceNote = null;
        this.memoryShareSection = null;
        this.memoryShareButton = null;
        this.memoryShareSummary = null;
        this.memoryShareRuntime = null;
        this.memberManagementRuntime = null;

        this.addOverlay = null;
        this.addPanel = null;
        this.addSelected = new Set();
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

    show(groupId) {
        const id = normalize(groupId);
        if (!id) return;
        const shown = runSessionPanelShowFlow({
            ensureUi: () => {
                if (!this.panel) this.createUI();
            },
            beforeShow: () => {
                this.groupId = id;
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
        this.overlay.id = 'group-settings-overlay';
        this.overlay.className = 'app-themed-overlay ssp-overlay';
        this.overlay.style.display = 'none';
        this.overlay.addEventListener('click', () => void this.requestClose());

        this.panel = document.createElement('div');
        this.panel.id = 'group-settings-panel';
        this.panel.className = 'app-themed-panel ssp-panel';
        this.panel.style.display = 'none';
        this.panel.tabIndex = -1;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-modal', 'true');
        this.panel.setAttribute('aria-labelledby', 'group-settings-title');
        this.panel.addEventListener('click', (event) => event.stopPropagation());
        this.panel.innerHTML = `
            <header class="ssp-header">
                <div class="ssp-heading">
                    <h2 id="group-settings-title" class="ssp-title has-help" data-help-title="会话 ID" data-help="">群聊设置</h2>
                    <span id="group-settings-sub" class="ssp-subtitle"></span>
                </div>
                <button id="group-settings-close" type="button" class="ssp-icon-btn ssp-close ssp-ctl" aria-label="关闭设置">${buildSessionSettingsCloseInnerHtml()}</button>
            </header>
            <div class="ssp-main">
                <nav class="ssp-nav" aria-label="设置分区">
                    <span class="ssp-nav-indicator" aria-hidden="true"></span>
                    ${buildSessionSettingsNavHtml([
                        { id: 'basic', label: '基本资料', icon: 'members' },
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
                                <button id="group-settings-avatar-btn" type="button" class="ssp-avatar ssp-ctl" aria-label="更换头像" title="点击更换头像">
                                    <span id="group-settings-avatar-preview" class="group-settings-avatar-preview"></span>
                                    <span class="ssp-avatar-badge" aria-hidden="true">${SESSION_SETTINGS_ICONS.edit}</span>
                                </button>
                            </div>
                            <div class="ssp-basic-fields is-single">
                                <label class="ssp-field">
                                    <span class="ssp-label has-help" data-help="修改名称不会改变聊天室 ID。">群组名称</span>
                                    <input id="group-settings-name" class="ssp-input" autocomplete="off">
                                </label>
                            </div>
                        </div>
                        <div class="ssp-card-head ssp-subhead">
                            <h4 class="ssp-subtitle-title">成员</h4>
                            <div class="ssp-card-actions">
                                <button id="group-settings-add" type="button" class="ssp-btn ssp-ctl">${SESSION_SETTINGS_ICONS.plus}<span>添加</span></button>
                            </div>
                        </div>
                        <div id="group-settings-members" class="ssp-members"></div>
                    </section>

                    <section id="group-memory-features-section" class="ssp-card" data-settings-section="memory-share">
                        <div id="group-memory-share-section">
                            <div class="ssp-row ssp-share-row">
                                <h3 class="ssp-card-title has-help" data-help="哪些记忆表格在聊天与创意写作之间共享。">记忆共享</h3>
                                <div id="group-memory-share-summary" class="ssp-muted ssp-share-summary"></div>
                                <button id="group-memory-share-manage" type="button" class="ssp-btn ssp-ctl">调整</button>
                            </div>
                        </div>
                        <div id="group-rp-bridge-section" style="display:none;"></div>
                    </section>

                    <section class="ssp-card" data-settings-section="archives">
                        <div class="ssp-card-head">
                            <h3 class="ssp-card-title has-help" data-help="点存档可加载；当前聊天会先自动存档。">聊天与存档</h3>
                            <div class="ssp-card-actions">
                                <button id="group-archives-import" type="button" class="ssp-btn ssp-ctl" data-help="导入本 APP 导出的 md／txt 聊天记录，存成新存档；电脑上也可以把文件拖到这里。" data-help-mode="press">导入</button>
                                <button id="group-archives-manage" type="button" class="ssp-btn ssp-ctl">管理</button>
                                <button id="group-new-chat" type="button" class="ssp-btn is-accent-outline ssp-ctl" data-help="把当前聊天存档后，开始新的聊天。" data-help-mode="press">${SESSION_SETTINGS_ICONS.plus}<span>新聊天</span></button>
                            </div>
                        </div>
                        <div id="group-archives-list" class="ssp-list"></div>
                    </section>

                    <section id="group-summary-section" class="ssp-card" data-settings-section="summary">
                        <div class="ssp-card-head">
                            <h3 class="ssp-card-title has-help" data-help="该群聊每次互动保存一条摘要（与聊天存档绑定）。">摘要</h3>
                            <div class="ssp-card-actions">
                                <button id="group-summaries-batch" type="button" title="批量操作" aria-label="批量操作" class="ssp-icon-btn is-bordered ssp-ctl">☰</button>
                                <button id="group-summaries-clear" type="button" class="ssp-btn is-danger-soft ssp-ctl">清空</button>
                            </div>
                        </div>
                        <div id="group-summaries-batchbar" class="ssp-batchbar" style="display:none;">
                            <button id="group-summaries-batch-edit" type="button" title="批量编辑" aria-label="批量编辑" class="ssp-icon-btn is-bordered ssp-ctl">✎</button>
                            <button id="group-summaries-batch-delete" type="button" title="批量删除" aria-label="批量删除" class="ssp-icon-btn is-bordered is-danger ssp-ctl">🗑</button>
                            <button id="group-summaries-batch-cancel" type="button" title="退出批量" aria-label="退出批量" class="ssp-icon-btn is-bordered ssp-ctl">×</button>
                        </div>
                        <div id="group-summaries-list" class="ssp-list"></div>
                        <div class="ssp-card-head ssp-subhead">
                            <h4 class="ssp-subtitle-title has-help" data-help="摘要满记忆 Agent「触发与频率」设定的条数或字数时，会自动生成大总结（与聊天存档绑定）。">大总结</h4>
                            <div class="ssp-card-actions">
                                <button id="group-compacted-raw" type="button" title="查看原始回复" aria-label="查看原始回复" class="ssp-icon-btn is-bordered ssp-ctl">📄</button>
                                <button id="group-compacted-edit" type="button" title="编辑" aria-label="编辑" class="ssp-icon-btn is-bordered ssp-ctl">✎</button>
                                <button id="group-compacted-run" type="button" title="手动生成/刷新" aria-label="手动生成/刷新" class="ssp-icon-btn is-bordered ssp-ctl">↻</button>
                                <button id="group-compacted-clear" type="button" title="删除" aria-label="删除" class="ssp-icon-btn is-bordered is-danger ssp-ctl">🗑</button>
                            </div>
                        </div>
                        <div id="group-compacted-summary" class="ssp-list"></div>
                    </section>

                    <section id="group-memory-table-section" class="ssp-card" data-settings-section="memory-table" style="display:none;">
                        <h3 class="ssp-card-title has-help" data-help="AI 在对话中自动维护的记忆，跟随聊天存档切换。">记忆表格</h3>
                        <div class="ssp-table-summary">
                            <span class="ssp-muted" data-role="table-overview">…</span>
                            <button type="button" class="ssp-btn is-accent-outline ssp-ctl" data-action="open-tables">打开</button>
                        </div>
                        <div id="group-memory-table-content" class="ssp-table-host"></div>
                    </section>
                </div>
            </div>
            <footer class="ssp-footer">
                <span class="ssp-dirty" aria-live="polite"><i aria-hidden="true"></i>有未保存的更改</span>
                <div class="ssp-footer-actions">
                    <button id="group-settings-cancel" type="button" class="ssp-btn is-large ssp-ctl">取消</button>
                    <button id="group-settings-save" type="button" class="ssp-btn is-large is-primary ssp-ctl" title="保存（Ctrl+S）">保存</button>
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

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.onchange = async () => {
            const file = this.fileInput.files?.[0];
            if (!file) return;
            try {
                this.avatar = await avatarDataUrlFromFile(file, { maxDim: 256, quality: 0.84, maxBytes: 520_000 });
                this.updateAvatarPreview();
                this.settingsChrome?.refreshDirty();
            } catch (err) {
                logger.warn('读取/压缩群组头像失败', err);
                window.toastr?.error?.('读取头像失败');
            }
        };

        document.body.appendChild(this.overlay);
        document.body.appendChild(this.panel);
        document.body.appendChild(this.fileInput);
        this.archivesList = this.panel.querySelector('#group-archives-list');
        this.archiveManageButton = this.panel.querySelector('#group-archives-manage');
        this.summariesList = this.panel.querySelector('#group-summaries-list');
        this.compactedList = this.panel.querySelector('#group-compacted-summary');
        this.summarySection = this.panel.querySelector('#group-summary-section');
        this.memoryTableSection = this.panel.querySelector('#group-memory-table-section');
        this.memoryFeaturesSection = this.panel.querySelector('#group-memory-features-section');
        this.memoryTableContent = this.panel.querySelector('#group-memory-table-content');
        this.summariesBatchBar = this.panel.querySelector('#group-summaries-batchbar');
        this.rpBridgeSection = this.panel.querySelector('#group-rp-bridge-section');
        this.rpBridgeToggle = this.panel.querySelector('#group-rp-bridge-enabled');
        this.rpBridgeLimitInput = this.panel.querySelector('#group-rp-bridge-limit');
        this.rpBridgeSourceNote = this.panel.querySelector('#group-rp-bridge-source-note');
        this.memoryShareSection = this.panel.querySelector('#group-memory-share-section');
        this.memoryShareButton = this.panel.querySelector('#group-memory-share-manage');
        this.memoryShareSummary = this.panel.querySelector('#group-memory-share-summary');
        this.settingsChrome = createSessionSettingsChrome({
            overlayEl: this.overlay,
            panelEl: this.panel,
            scrollEl: this.panel.querySelector('.ssp-scroll'),
            navEl: this.panel.querySelector('.ssp-nav'),
            dirtyEl: this.panel.querySelector('.ssp-dirty'),
            getSessionId: () => this.groupId,
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
        const summariesClearButton = this.panel.querySelector('#group-summaries-clear');
        const summariesBatchButton = this.panel.querySelector('#group-summaries-batch');
        const summariesBatchCancelButton = this.panel.querySelector('#group-summaries-batch-cancel');
        const summariesBatchDeleteButton = this.panel.querySelector('#group-summaries-batch-delete');
        const summariesBatchEditButton = this.panel.querySelector('#group-summaries-batch-edit');
        const compactedRawButton = this.panel.querySelector('#group-compacted-raw');
        const compactedEditButton = this.panel.querySelector('#group-compacted-edit');
        const compactedRunButton = this.panel.querySelector('#group-compacted-run');
        const compactedClearButton = this.panel.querySelector('#group-compacted-clear');

        this.panel.querySelector('#group-settings-close').onclick = () => void this.requestClose();
        this.panel.querySelector('#group-settings-cancel').onclick = () => void this.requestClose();
        this.panel.querySelector('#group-settings-avatar-btn').onclick = () => {
            this.fileInput.value = '';
            this.fileInput.click();
        };
        this.panel.querySelector('#group-settings-add').onclick = () => this.openAddMembers();
        this.panel.querySelector('#group-settings-save').onclick = () => this.save();
        bindSessionMemoryShareButton({
            buttonEl: this.memoryShareButton,
            openManager: () => this.openMemoryShareManager(),
            logger,
            warnMessage: 'open group memory share manager failed',
            errorMessage: '打开记忆共享失败',
            toastr: window.toastr,
        });
        this.panel.querySelector('#group-new-chat').onclick = () => this.startNewChat();
        this.archiveManageButton?.addEventListener('click', () => this.openArchiveManager());
        this.panel.querySelector('#group-archives-import')?.addEventListener('click', () => {
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
            getSessionId: () => this.groupId,
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
            summaryClearMessage: '确定要清空该群聊当前存档/聊天的所有摘要吗？',
            compactedClearMessage: '确定要清空该群聊当前存档/聊天的大总结吗？',
        });

        if (this.memoryTableContent && this.memoryTableStore && this.memoryTemplateStore) {
            this.memoryTableEditor = new MemoryTableEditor({
                container: this.memoryTableContent,
                getContext: () => ({ type: 'group', groupId: this.groupId }),
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
            getSessionId: () => this.groupId,
            renderSummaries: () => this.renderSummaries(),
            renderCompactedSummary: () => this.renderCompactedSummary(),
        });
    }

    readSettingsSnapshot() {
        return {
            avatar: String(this.avatar || ''),
            name: String(this.panel?.querySelector?.('#group-settings-name')?.value || ''),
            members: Array.isArray(this.members) ? [...this.members] : [],
        };
    }

    ensureSummaryRuntime() {
        if (this.summaryRuntime) return this.summaryRuntime;
        this.summaryRuntime = createSessionSummarySectionRuntime({
            variant: 'group',
            getSessionId: () => this.groupId,
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
            getNormalRowStyle: () => buildSessionSummaryRowStyle({ clickable: true }),
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

    setSummaryBatchMode(enabled) {
        return this.ensureSummaryRuntime().setSummaryBatchMode(enabled);
    }

    openCompactedRaw() {
        return this.ensureSummaryRuntime().openCompactedRaw();
    }

    editCompactedSummary() {
        return this.ensureSummaryRuntime().editCompactedSummary();
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

    populate() {
        const g = this.contactsStore?.getContact?.(this.groupId);
        if (!g) return;
        this.panel.querySelector('#group-settings-title')?.setAttribute('data-help', this.groupId);
        const sub = this.panel.querySelector('#group-settings-sub');
        if (sub) {
            sub.setAttribute('data-i18n-skip', '');
            sub.textContent = `${g.name || this.groupId} · ${translateUiText('群聊')}`;
        }
        this.avatar = g.avatar || '';
        this.members = Array.isArray(g.members) ? g.members.map(normalize).filter(Boolean) : [];
        const nameEl = this.panel.querySelector('#group-settings-name');
        if (nameEl) nameEl.value = g.name || '';
        if (this.rpBridgeSection) this.rpBridgeSection.style.display = 'none';
        if (this.memoryShareSection) this.memoryShareSection.style.display = 'block';
        this.refreshMemoryShareSummary().catch((err) => {
            logger.warn('refresh group memory share summary failed', err);
            if (this.memoryShareSummary) this.memoryShareSummary.textContent = '记忆共享状态读取失败';
        });
        this.updateAvatarPreview();
        this.renderMembers();
    }

    ensureMemoryShareRuntime() {
        if (this.memoryShareRuntime) return this.memoryShareRuntime;
        this.memoryShareRuntime = createGroupMemoryShareRuntime({
            getSessionId: () => this.groupId,
            getSummaryEl: () => this.memoryShareSummary,
            getSessionSettings: (sessionId) => this.chatStore?.getSessionSettings?.(sessionId),
            setSessionSettings: (sessionId, sessionSettings) => this.chatStore?.setSessionSettings?.(sessionId, sessionSettings),
            getContact: (sessionId) => this.contactsStore?.getContact?.(sessionId),
            memoryTableStore: this.memoryTableStore,
            resolveTemplateDefinition: () => this.resolveDefaultMemoryTemplateDefinition(),
            resolveTemplateId: () => this.resolveDefaultMemoryTemplateId(),
            getRpCharacterNameForSession: (sessionId) => window.appBridge?.getRpCharacterNameForSession?.(sessionId),
            getRpSessionIdForSession: (sessionId) => window.appBridge?.getRpSessionIdForSession?.(sessionId),
            getRpSessionIdForActivePersona: () => window.appBridge?.getRpSessionIdForActivePersona?.(),
            documentRef: document,
            bodyEl: document.body,
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

    async refreshMemoryShareSummary(sessionId = this.groupId) {
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

    renderSummaries() {
        return this.ensureSummaryRuntime().renderSummaries();
    }

    renderCompactedSummary() {
        return this.ensureSummaryRuntime().renderCompactedSummary();
    }

    ensureNewChatRuntime() {
        if (this.newChatRuntime) return this.newChatRuntime;
        this.newChatRuntime = createSessionNewChatSectionRuntime({
            getSessionId: () => this.groupId,
            isGroup: true,
            resolveSessionMode: () => 'chat',
            getMemoryStorageMode,
            askMemoryTableNewChatMode,
            promptForArchiveName: () => prompt('请输入当前聊天的存档名称（留空将自动命名）：'),
            buildMemoryTableSnapshot: ({ sessionId, isGroup }) => this.buildMemoryTableSnapshot({ sessionId, isGroup }),
            captureArchivePointer: (sessionId, options) =>
                window.appBridge?.buildArchivePointerFromCurrentThread?.(sessionId, options),
            memoryTableStore: this.memoryTableStore,
            resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
            resolveSummaryTableIds: ({ isGroup }) => [
                isGroup ? 'group_summary' : 'chat_summary',
                isGroup ? 'group_outline' : 'chat_outline',
            ],
            notifyRowsUpdated: ({ sessionId, templateId }) =>
                emitSharedMemoryRowsUpdated({ target: window, sessionId, templateId }),
            startNewChat: (sessionId, archiveName, options) => this.chatStore.startNewChat(sessionId, archiveName, options),
            persistArchivePointer: (sessionId, archiveId, archivePointer, options) =>
                window.appBridge?.setArchivePointerForArchive?.(sessionId, archiveId, archivePointer, options),
            restoreMemoryForActiveThread: (sessionId, options) =>
                window.appBridge?.restoreMemoryForActiveThread?.(sessionId, options),
            logger,
            sourcePrefix: 'group',
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
            getSessionId: () => this.groupId,
            getChatStore: () => this.chatStore,
            isGroup: true,
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
            sourcePrefix: 'group',
            restoreWarnMessage: 'restore checkpoint memory after group archive load failed',
            deleteWarnMessage: 'delete group archive turn checkpoint state failed',
        });
        return this.archiveRuntime;
    }

    renderArchives() {
        return this.ensureArchiveRuntime().renderArchives();
    }

    exportConversationArchive(payload = {}) {
        const sessionId = String(payload?.sessionId || this.groupId || '').trim();
        const archive = payload?.archive || null;
        const current = payload?.current === true;
        return runSessionConversationExportFlow({
            chatStore: this.chatStore,
            sessionId,
            archive,
            current,
            title: current ? '当前群聊' : (archive?.name || '未命名存档'),
            sourceLabel: current ? '当前群聊' : `群聊存档：${archive?.name || archive?.id || '未命名存档'}`,
            openExportDialog: options => openConversationExportDialog({ ...options, isReducedMotion: isSettingsReducedMotion }),
            loadState: () => loadConversationExportState({
                chatStore: this.chatStore,
                sessionId,
                archive,
                current,
                buildMemoryTableSnapshot: ({ sessionId: sid }) => (getMemoryStorageMode() === 'table'
                    ? this.buildMemoryTableSnapshot({ sessionId: sid, isGroup: true })
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
        return runSessionConversationImportFlow({
            file,
            chatStore: this.chatStore,
            sessionId: String(this.groupId || '').trim(),
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
            title: '群聊历史存档',
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
        const count = Number(this.chatStore?.getArchives?.(this.groupId)?.length || 0) || 0;
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
            getSessionId: () => this.groupId,
            getChatStore: () => this.chatStore,
            isGroup: true,
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
            sourcePrefix: 'group',
            restoreWarnMessage: 'restore checkpoint memory after group archive load failed',
            deleteWarnMessage: 'delete group archive turn checkpoint state failed',
        });
        return this.archiveManagerRuntime;
    }

    renderArchiveManagerArchives() {
        const modal = this.ensureArchiveManagerModal();
        const count = Number(this.chatStore?.getArchives?.(this.groupId)?.length || 0) || 0;
        if (modal.subtitleEl) modal.subtitleEl.textContent = `${count} 份`;
        return this.ensureArchiveManagerRuntime().renderArchives();
    }

    ensureMemberManagementRuntime() {
        if (this.memberManagementRuntime) return this.memberManagementRuntime;
        this.memberManagementRuntime = createGroupMemberManagementRuntime({
            getPanel: () => this.panel,
            getMembers: () => this.members,
            setMembers: (nextMembers) => {
                this.members = Array.isArray(nextMembers) ? nextMembers : [];
                this.updateAvatarPreview();
                this.settingsChrome?.refreshDirty();
            },
            getContactsStore: () => this.contactsStore,
            getAddOverlay: () => this.addOverlay,
            setAddOverlay: (overlay) => {
                this.addOverlay = overlay;
            },
            getAddPanel: () => this.addPanel,
            setAddPanel: (panel) => {
                this.addPanel = panel;
            },
            getAddSelected: () => this.addSelected,
            documentRef: document,
            bodyEl: document.body,
            normalize,
            normalizeKey,
            resolveContactAvatar,
            notifyInfo: (message) => window.toastr?.info?.(message),
        });
        return this.memberManagementRuntime;
    }

    updateAvatarPreview() {
        const preview = this.panel?.querySelector('#group-settings-avatar-preview');
        if (!preview) return;
        const group = this.contactsStore?.getContact?.(this.groupId) || {};
        const name = String(this.panel?.querySelector?.('#group-settings-name')?.value || group?.name || '群聊').trim() || '群聊';
        const avatar = createContactAvatarElement({
            documentRef: document,
            sessionId: this.groupId || 'group:settings-preview',
            contact: {
                ...group,
                id: this.groupId || 'group:settings-preview',
                name,
                avatar: this.avatar,
                isGroup: true,
                members: this.members,
            },
            getContact: (id) => this.contactsStore?.getContact?.(id),
            resolveAvatar: (id, contact) => resolveContactAvatar(contact, id),
            className: 'group-settings-avatar-art',
        });
        preview.replaceChildren(avatar);
    }

    renderMembers() {
        return this.ensureMemberManagementRuntime().renderMembers();
    }

    openAddMembers() {
        return this.ensureMemberManagementRuntime().openAddMembers();
    }

    ensureAddModal() {
        return this.ensureMemberManagementRuntime().ensureAddModal();
    }

    closeAddModal() {
        return this.ensureMemberManagementRuntime().closeAddModal();
    }

    renderAddCandidates() {
        return this.ensureMemberManagementRuntime().renderAddCandidates();
    }

    async startNewChat() {
        if (!this.chatStore) return;
        return this.ensureNewChatRuntime().startNewChat();
    }

    save() {
        return runGroupSettingsSaveFlow({
            groupId: this.groupId,
            panel: this.panel,
            avatar: this.avatar,
            members: this.members,
            contactsStore: this.contactsStore,
            chatStore: this.chatStore,
            onSaved: this.onSaved,
            hide: () => this.hide(),
            normalize,
            normalizeKey,
            notifySuccess: (message) => window.toastr?.success?.(message),
            notifyError: (message) => window.toastr?.error?.(message),
            logger,
        });
    }
}
