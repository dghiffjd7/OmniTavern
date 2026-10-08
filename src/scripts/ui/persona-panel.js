
import { MediaPicker } from './media-picker.js';
import { avatarDataUrlFromFile } from '../utils/image.js';
import { appChoice, appConfirm } from './app-confirm.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { appSettings } from '../storage/app-settings.js';
import { CharacterCardImporter } from './character-card-importer.js';
import { CharacterCardExporter } from './character-card-exporter.js';
import { getCharacterCardDisplayName, getCharacterCardSource } from '../utils/character-card-display.js';
import { getDefaultAppIcon } from '../utils/default-icon.js';
import { bindCustomSelectButton, closeCustomSelectMenu, refreshCustomSelectButton } from './custom-select.js';
import { cleanupPersonaScopedData, deletePersonaCard } from './persona-runtime-utils.js';
import {
    applyPersonaGlobalMemorySnapshot,
    restorePersonaRoleArchive,
    runPersonaNewChatFlow,
} from './persona-new-chat-runtime-utils.js';
import { getRegexLocalSet, removeRegexLocalSet, waitForRegexStoreReady } from './regex-store-runtime-utils.js';
import { getPresetStore } from './preset-store-runtime-utils.js';
import { waitForScriptStoreReady } from './script-runtime-utils.js';
import { deleteWorldSessionMapEntry } from './world-session-runtime-utils.js';
import {
    applyMemoryTableSnapshot as applySharedMemoryTableSnapshot,
    askMemoryTableNewChatMode,
    buildMemoryTableSnapshot as buildSharedMemoryTableSnapshot,
    resolveDefaultMemoryTemplateId as resolveSharedDefaultMemoryTemplateId,
} from './session-memory-table-utils.js';
import { emitMemoryRowsUpdated as emitSharedMemoryRowsUpdated } from './session-memory-event-utils.js';
import { logger } from '../utils/logger.js';
import { translateUiText } from '../i18n/index.js';
import {
    buildPersonaGalleryDetails,
    filterPersonaGalleryItems,
} from './persona-gallery-utils.js';

export class PersonaPanel {
    constructor({
        personaStore,
        userStore = null,
        chatStore = null,
        contactsStore = null,
        rpSessionStore = null,
        momentsStore = null,
        momentSummaryStore = null,
        personaArchiveStore = null,
        memoryTableStore = null,
        memoryTemplateStore = null,
        getSessionId = null,
        getMemoryStorageMode = null,
        getPersonaScopeKey = null,
        getRpSessionIdForPersona = null,
        onPersonaChanged,
        onUserPersonaSwitch = null,
        onGreetingsImported = null,
        onRoleNewChatFinished = null,
        cardAssetWriter = null,
    }) {
        this.store = personaStore;
        this.userStore = userStore;
        this.chatStore = chatStore;
        this.contactsStore = contactsStore;
        this.rpSessionStore = rpSessionStore;
        this.momentsStore = momentsStore;
        this.momentSummaryStore = momentSummaryStore;
        this.personaArchiveStore = personaArchiveStore;
        this.memoryTableStore = memoryTableStore;
        this.memoryTemplateStore = memoryTemplateStore;
        this.getSessionId = typeof getSessionId === 'function' ? getSessionId : null;
        this.getMemoryStorageMode = typeof getMemoryStorageMode === 'function' ? getMemoryStorageMode : () => 'off';
        this.getPersonaScopeKey = typeof getPersonaScopeKey === 'function' ? getPersonaScopeKey : null;
        this.getRpSessionIdForPersona = typeof getRpSessionIdForPersona === 'function' ? getRpSessionIdForPersona : null;
        this.onPersonaChanged = onPersonaChanged;
        this.onUserPersonaSwitch = typeof onUserPersonaSwitch === 'function' ? onUserPersonaSwitch : null;
        this.onGreetingsImported = typeof onGreetingsImported === 'function' ? onGreetingsImported : null;
        this.onRoleNewChatFinished = typeof onRoleNewChatFinished === 'function' ? onRoleNewChatFinished : null;
        this.overlay = null;
        this.panel = null;
        this.mediaPicker = new MediaPicker({
            onUrl: (url) => this.updateAvatarPreview(url),
            onFile: async (dataUrl, file) => {
                if (file) {
                    try {
                        const compressed = await avatarDataUrlFromFile(file, { maxDim: 256, quality: 0.84, maxBytes: 420_000 });
                        this.updateAvatarPreview(compressed);
                        return;
                    } catch {}
                }
                if (dataUrl) this.updateAvatarPreview(dataUrl);
            }
        });
        this.editingId = null;
        this.bulkModal = null;
        this.bulkState = null;
        this.cardImporter = new CharacterCardImporter({
            personaStore: this.store,
            appBridge: window.appBridge,
            rpSessionStore: this.rpSessionStore,
            onPersonaChanged: () => this.notifyPersonaChanged(),
            onGreetingsImported: payload => this.notifyGreetingsImported(payload),
            getPersonaScopeKey: personaId => (typeof this.getPersonaScopeKey === 'function' ? this.getPersonaScopeKey(personaId) : personaId),
            // 导入失败回滚：本次创建的世界书／正则／预设／脚本由导入服务逐项撤销，这里只删角色卡本身及其数据
            deletePersona: personaId => this.deleteCore(personaId, { cleanupBindings: false }),
            chatStore: this.chatStore,
            assetWriter: cardAssetWriter,
        });
        this.cardExporter = new CharacterCardExporter({
            appBridge: window.appBridge,
            getFallbackAvatar: () => getDefaultAppIcon(),
        });
        this.importInput = null;
        this.importOverlay = null;
        this.importModal = null;
        this.importUrlInput = null;
        this.importUrlBtn = null;
        this.importFileBtn = null;
        this.importCloseBtn = null;
        this.roleNewChatRunning = false;
        this.roleArchiveModal = null;
        this.roleArchiveState = null;
        this.galleryOverlay = null;
        this.galleryPanel = null;
        this.galleryQuery = '';
        this.galleryFlippedId = '';
        this.galleryDetailCache = new Map();
        this.galleryDetailRequests = new Map();
        this.galleryDetailOverlay = null;
        this.galleryDetailPanel = null;
        this.galleryKeydownHandler = null;
    }

    async notifyPersonaChanged() {
        if (typeof this.onPersonaChanged !== 'function') return;
        await Promise.resolve(this.onPersonaChanged());
    }

    async notifyGreetingsImported(payload = {}) {
        if (typeof this.onGreetingsImported !== 'function') return;
        await Promise.resolve(this.onGreetingsImported(payload));
    }

    getPersonaScopeId(personaId) {
        try {
            return String(this.getPersonaScopeKey?.(personaId) || '').trim();
        } catch {
            return '';
        }
    }

    getRoleRpSessionId(personaId) {
        try {
            const resolved = String(this.getRpSessionIdForPersona?.(personaId) || '').trim();
            if (resolved) return resolved;
        } catch {}
        return `rp:${String(personaId || 'default').trim() || 'default'}`;
    }

    resolveDefaultMemoryTemplateId() {
        return resolveSharedDefaultMemoryTemplateId({ memoryTemplateStore: this.memoryTemplateStore });
    }

    buildPersonaMemoryTableSnapshot(payload = {}) {
        return buildSharedMemoryTableSnapshot({
            ...payload,
            memoryTableStore: this.memoryTableStore,
            resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
        });
    }

    applyPersonaMemoryTableSnapshot(payload = {}) {
        return applySharedMemoryTableSnapshot({
            ...payload,
            memoryTableStore: this.memoryTableStore,
            resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
            notifyRowsUpdated: detail => this.notifyPersonaMemoryRowsUpdated(detail),
        });
    }

    notifyPersonaMemoryRowsUpdated({ sessionId = '', templateId = '' } = {}) {
        return emitSharedMemoryRowsUpdated({ target: window, sessionId, templateId });
    }

    async ensurePersonaArchiveScope(personaId) {
        const pid = String(personaId || '').trim();
        if (!pid) return false;
        const activeId = String(this.store.getActive?.()?.id || '').trim();
        if (activeId === pid) return true;
        const switched = await this.store.setActive(pid);
        if (!switched) return false;
        this.renderList();
        await this.notifyPersonaChanged();
        return true;
    }

    async startRoleNewChat(personaId) {
        const pid = String(personaId || '').trim();
        if (!pid || this.roleNewChatRunning) return;
        const persona = this.store.get(pid);
        if (!persona) return;
        const name = this.getCharacterCardName(persona) || pid;
        const scopeId = this.getPersonaScopeId(pid);
        if (!scopeId) {
            window.toastr?.warning?.('当前数据未按角色卡隔离，无法安全执行角色卡新聊天');
            return;
        }

        const ok = await appConfirm({
            title: '角色卡开启新聊天',
            message: `将为「${name}」创建角色卡存档，并清空当前角色卡下的聊天室、创意写作、动态和对应记忆表格。之后可在角色卡存档中整体切回。`,
            confirmText: '开启新聊天',
            cancelText: '取消',
            danger: true,
        });
        if (!ok) return;

        this.roleNewChatRunning = true;
        const editBtn = this.panel?.querySelector?.('#persona-new-chat-btn');
        const listBtns = this.panel?.querySelectorAll?.('.persona-new-chat-btn') || [];
        try {
            if (editBtn) {
                editBtn.disabled = true;
                editBtn.textContent = '处理中...';
            }
            listBtns.forEach((btn) => {
                btn.disabled = true;
                btn.style.opacity = '0.65';
            });

            if (!await this.ensurePersonaArchiveScope(pid)) {
                window.toastr?.error?.('无法切换到目标角色卡');
                return;
            }

            const result = await runPersonaNewChatFlow({
                personaId: pid,
                personaName: name,
                rpSessionId: this.getRoleRpSessionId(pid),
                chatStore: this.chatStore,
                contactsStore: this.contactsStore,
                momentsStore: this.momentsStore,
                momentSummaryStore: this.momentSummaryStore,
                memoryTableStore: this.memoryTableStore,
                resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
                getMemoryStorageMode: place => this.getMemoryStorageMode(place),
                askMemoryTableNewChatMode,
                promptForArchiveName: () => prompt('请输入本次角色卡存档名称（留空将自动命名）：'),
                buildMemoryTableSnapshot: payload => this.buildPersonaMemoryTableSnapshot(payload),
                captureArchivePointer: (sessionId, options) =>
                    window.appBridge?.buildArchivePointerFromCurrentThread?.(sessionId, options),
                persistArchivePointer: (sessionId, archiveId, archivePointer, options) =>
                    window.appBridge?.setArchivePointerForArchive?.(sessionId, archiveId, archivePointer, options),
                restoreMemoryForActiveThread: (sessionId, options) =>
                    window.appBridge?.restoreMemoryForActiveThread?.(sessionId, options),
                notifyRowsUpdated: detail => this.notifyPersonaMemoryRowsUpdated(detail),
                createRoleArchive: (payload) => {
                    const activeArchiveId = String(this.personaArchiveStore?.getCurrentArchiveId?.() || '').trim();
                    const existing = activeArchiveId ? this.personaArchiveStore?.getArchive?.(activeArchiveId) : null;
                    const nextPayload = existing
                        ? {
                            ...payload,
                            id: activeArchiveId,
                            createdAt: existing.createdAt,
                            name: String(payload?.name || '').trim() || existing.name,
                        }
                        : payload;
                    return this.personaArchiveStore?.addArchive?.(nextPayload);
                },
                requireRoleArchiveForExtras: true,
                clearMemoryOnlyTargets: true,
                clearMoments: true,
                clearGlobalMemories: true,
                logger,
            });
            if (result?.cancelled) return;
            this.personaArchiveStore?.clearCurrentArchiveId?.();

            const details = [];
            if (result?.startedSessions) details.push(`${result.startedSessions} 个会话`);
            if (result?.clearedMoments) details.push(`${result.clearedMoments} 条动态`);
            const suffix = details.length ? `（${details.join(' · ')}）` : '';
            window.toastr?.success?.(`已为「${name}」开启新聊天${suffix}`);
            await this.onRoleNewChatFinished?.({ personaId: pid, scopeId, result });
            this.renderList();
        } catch (err) {
            logger.warn('persona new chat failed', err);
            window.toastr?.error?.('角色卡开启新聊天失败');
        } finally {
            this.roleNewChatRunning = false;
            if (editBtn) {
                editBtn.disabled = false;
                editBtn.textContent = '为此角色卡开启新聊天';
            }
            const freshBtns = this.panel?.querySelectorAll?.('.persona-new-chat-btn') || [];
            freshBtns.forEach((btn) => {
                btn.disabled = false;
                btn.style.opacity = '';
            });
            if (this.galleryPanel) this.renderGallery();
        }
    }

    ensureRoleArchiveModal() {
        if (this.roleArchiveModal) return;
        const overlay = document.createElement('div');
        overlay.className = 'app-themed-overlay persona-role-archive-overlay';
        overlay.style.cssText = `
            display:none; position:fixed; inset:0;
            background: rgba(0,0,0,0.38);
            z-index: 22060;
            padding: calc(10px + env(safe-area-inset-top, 0px)) 10px calc(10px + env(safe-area-inset-bottom, 0px)) 10px;
            box-sizing: border-box;
            align-items:center;
            justify-content:center;
        `;
        bindBackdropActivation(overlay, {
            onActivate: () => this.hideRoleArchiveModal(),
        });

        const panel = document.createElement('div');
        panel.className = 'app-themed-panel persona-role-archive-panel';
        panel.style.cssText = `
            width: min(94vw, 520px);
            max-height: min(86vh, 720px);
            background: var(--app-surface-card);
            border-radius: 14px;
            overflow: hidden;
            display:flex;
            flex-direction:column;
            box-shadow: 0 10px 40px rgba(0,0,0,0.22);
        `;
        panel.addEventListener('click', (event) => event.stopPropagation());
        panel.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--app-surface-subtle); border-bottom:1px solid var(--app-border-default);">
                <div style="min-width:0; flex:1;">
                    <div id="persona-role-archive-title" style="font-weight:900; color:var(--app-text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">角色卡存档</div>
                    <div id="persona-role-archive-subtitle" style="font-size:12px; color:var(--app-text-muted); margin-top:2px;"></div>
                </div>
                <button id="persona-role-archive-close" style="width:38px; height:38px; border:none; background:transparent; border-radius:10px; font-size:20px; cursor:pointer; color:var(--app-text-secondary);">×</button>
            </div>
            <div id="persona-role-archive-list" style="flex:1; min-height:0; overflow:auto; -webkit-overflow-scrolling:touch; padding:12px;"></div>
            <div style="padding:10px 14px; border-top:1px solid var(--app-border-subtle); color:var(--app-text-muted); font-size:12px; line-height:1.45;">
                加载存档会先自动保存当前会话状态，再切回该角色卡存档中的聊天、创作、动态和记忆表格。
            </div>
        `;
        panel.querySelector('#persona-role-archive-close')?.addEventListener('click', () => this.hideRoleArchiveModal());
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.roleArchiveModal = { overlay, panel };
    }

    hideRoleArchiveModal() {
        if (this.roleArchiveModal) this.roleArchiveModal.overlay.style.display = 'none';
    }

    formatRoleArchiveTime(value = 0) {
        const ts = Number(value || 0) || 0;
        if (!ts) return '';
        try {
            return new Date(ts).toLocaleString();
        } catch {
            return '';
        }
    }

    async openRoleArchiveModal(personaId) {
        const pid = String(personaId || '').trim();
        if (!pid) return;
        if (!this.personaArchiveStore?.listArchives) {
            window.toastr?.warning?.('当前环境不支持角色卡存档');
            return;
        }
        const persona = this.store.get(pid);
        if (!persona) return;
        const scopeId = this.getPersonaScopeId(pid);
        if (!scopeId) {
            window.toastr?.warning?.('当前数据未按角色卡隔离，无法查看角色卡存档');
            return;
        }
        if (!await this.ensurePersonaArchiveScope(pid)) {
            window.toastr?.error?.('无法切换到目标角色卡');
            return;
        }
        this.ensureRoleArchiveModal();
        this.roleArchiveState = {
            personaId: pid,
            personaName: this.getCharacterCardName(persona) || pid,
        };
        this.renderRoleArchiveList();
        this.roleArchiveModal.overlay.style.display = 'flex';
    }

    renderRoleArchiveList() {
        if (!this.roleArchiveModal || !this.roleArchiveState) return;
        const panel = this.roleArchiveModal.panel;
        const titleEl = panel.querySelector('#persona-role-archive-title');
        const subtitleEl = panel.querySelector('#persona-role-archive-subtitle');
        const listEl = panel.querySelector('#persona-role-archive-list');
        if (!listEl) return;
        const archives = this.personaArchiveStore?.listArchives?.() || [];
        if (titleEl) titleEl.textContent = '角色卡存档';
        if (subtitleEl) subtitleEl.textContent = `${this.roleArchiveState.personaName} · ${archives.length} 份`;
        listEl.innerHTML = '';
        if (!archives.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:26px 12px; text-align:center; color:var(--app-text-muted); font-size:14px;';
            empty.textContent = '暂无角色卡存档';
            listEl.appendChild(empty);
            return;
        }
        archives.forEach((archive) => {
            const row = document.createElement('div');
            row.style.cssText = `
                display:flex; gap:10px; align-items:flex-start;
                padding:12px;
                border:1px solid var(--app-border-subtle);
                border-radius:12px;
                background:var(--app-surface-card);
                margin-bottom:10px;
            `;
            const main = document.createElement('div');
            main.style.cssText = 'flex:1; min-width:0;';
            const name = document.createElement('div');
            name.style.cssText = 'font-weight:900; color:var(--app-text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = archive.name || '未命名存档';
            const meta = document.createElement('div');
            meta.style.cssText = 'margin-top:4px; color:var(--app-text-muted); font-size:12px; line-height:1.45;';
            const stats = archive.stats || {};
            const parts = [
                this.formatRoleArchiveTime(archive.createdAt),
                `${Number(stats.sessions || archive.sessionArchives?.length || 0)} 个会话`,
                `${Number(stats.moments || archive.momentsSnapshot?.moments?.length || 0)} 条动态`,
                `${Number(stats.memoryOnlyTargets || archive.memoryOnlySnapshots?.length || 0)} 个纯记忆目标`,
            ].filter(Boolean);
            meta.textContent = parts.join(' · ');
            main.appendChild(name);
            main.appendChild(meta);

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex; gap:6px; flex-shrink:0;';
            const loadBtn = document.createElement('button');
            loadBtn.type = 'button';
            loadBtn.textContent = '加载';
            loadBtn.style.cssText = 'border:none; background:#2563eb; color:var(--app-text-inverse); border-radius:10px; padding:8px 10px; font-weight:800; cursor:pointer;';
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.textContent = '删除';
            deleteBtn.style.cssText = 'border:1px solid var(--app-danger-border); background:var(--app-danger-soft); color:var(--app-danger-text); border-radius:10px; padding:8px 10px; font-weight:800; cursor:pointer;';
            loadBtn.addEventListener('click', () => this.loadRoleArchive(archive.id));
            deleteBtn.addEventListener('click', () => this.deleteRoleArchive(archive.id));
            actions.appendChild(loadBtn);
            actions.appendChild(deleteBtn);
            row.appendChild(main);
            row.appendChild(actions);
            listEl.appendChild(row);
        });
    }

    async loadRoleArchive(archiveId) {
        const archive = this.personaArchiveStore?.getArchive?.(archiveId);
        if (!archive || !this.roleArchiveState) return;
        const ok = await appConfirm({
            title: '加载角色卡存档',
            message: `确定要加载「${archive.name || '未命名存档'}」吗？当前状态会先按各会话规则自动保存。`,
            confirmText: '加载',
            cancelText: '取消',
        });
        if (!ok) return;
        try {
            const currentRoleArchiveId = String(this.personaArchiveStore?.getCurrentArchiveId?.() || '').trim();
            const result = await restorePersonaRoleArchive({
                archive,
                chatStore: this.chatStore,
                memoryTableStore: this.memoryTableStore,
                resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
                getMemoryStorageMode: place => this.getMemoryStorageMode(place),
                buildMemoryTableSnapshot: payload => this.buildPersonaMemoryTableSnapshot(payload),
                captureArchivePointer: (sessionId, options) =>
                    window.appBridge?.buildArchivePointerFromCurrentThread?.(sessionId, options),
                loadArchivedMessages: (archiveId, sessionId, options) =>
                    this.chatStore?.loadArchivedMessages?.(archiveId, sessionId, options),
                getLastArchiveTransition: sessionId => this.chatStore?.getLastArchiveTransition?.(sessionId),
                persistArchivePointer: (sessionId, nextArchiveId, archivePointer, options) =>
                    window.appBridge?.setArchivePointerForArchive?.(sessionId, nextArchiveId, archivePointer, options),
                applyMemoryTableSnapshot: payload => this.applyPersonaMemoryTableSnapshot(payload),
                applyGlobalMemorySnapshot: payload => applyPersonaGlobalMemorySnapshot({
                    ...payload,
                    memoryTableStore: this.memoryTableStore,
                    resolveDefaultMemoryTemplateId: () => this.resolveDefaultMemoryTemplateId(),
                    notifyRowsUpdated: detail => this.notifyPersonaMemoryRowsUpdated(detail),
                }),
                restoreArchivePointerForLoadedThread: (sessionId, options) =>
                    window.appBridge?.restoreArchivePointerForLoadedThread?.(sessionId, options),
                momentsStore: this.momentsStore,
                momentSummaryStore: this.momentSummaryStore,
                currentRoleArchiveId,
                createSavedCurrentRoleArchive: (payload) => {
                    const payloadId = String(payload?.id || '').trim();
                    const existing = payloadId ? this.personaArchiveStore?.getArchive?.(payloadId) : null;
                    const payloadSessionArchives = Array.isArray(payload?.sessionArchives) ? payload.sessionArchives : [];
                    return this.personaArchiveStore?.addArchive?.({
                        ...payload,
                        personaId: this.roleArchiveState.personaId,
                        personaName: this.roleArchiveState.personaName,
                        createdAt: existing?.createdAt || payload?.createdAt,
                        name: String(payload?.name || '').trim() || existing?.name || '自动存档',
                        sessionArchives: payloadSessionArchives.length
                            ? payloadSessionArchives
                            : (existing?.sessionArchives || []),
                        memoryOnlySnapshots: Array.isArray(payload?.memoryOnlySnapshots)
                            ? payload.memoryOnlySnapshots
                            : (existing?.memoryOnlySnapshots || []),
                    });
                },
                notifyRowsUpdated: detail => this.notifyPersonaMemoryRowsUpdated(detail),
                logger,
            });
            if (!result?.loaded) {
                window.toastr?.warning?.('未能加载该角色卡存档');
                return;
            }
            this.personaArchiveStore?.setCurrentArchiveId?.(archive.id);
            const missing = Array.isArray(result.missingSessionArchives) ? result.missingSessionArchives.length : 0;
            window.toastr?.success?.(missing ? `已加载角色卡存档，${missing} 个会话存档缺失` : '已加载角色卡存档');
            await this.onRoleNewChatFinished?.({ personaId: this.roleArchiveState.personaId, result });
            this.renderRoleArchiveList();
        } catch (err) {
            logger.warn('load persona role archive failed', err);
            window.toastr?.error?.('加载角色卡存档失败');
        }
    }

    async deleteRoleArchive(archiveId) {
        const archive = this.personaArchiveStore?.getArchive?.(archiveId);
        if (!archive) return;
        const ok = await appConfirm({
            title: '删除角色卡存档',
            message: `确定要删除「${archive.name || '未命名存档'}」吗？`,
            confirmText: '删除',
            cancelText: '取消',
            danger: true,
        });
        if (!ok) return;
        const deleted = this.personaArchiveStore?.deleteArchive?.(archiveId);
        if (deleted) {
            window.toastr?.success?.('已删除角色卡存档');
            this.renderRoleArchiveList();
        }
    }

    ensureUI() {
        if (this.overlay) return;

        this.overlay = document.createElement('div');
        this.overlay.className = 'panel-overlay app-themed-overlay persona-panel-overlay';
        this.overlay.style.display = 'none';
        this.overlay.style.zIndex = '21000'; // High z-index to sit on top
        this.overlay.style.position = 'fixed';
        this.overlay.style.inset = '0';
        this.overlay.style.background = 'rgba(0,0,0,0.38)';
        this.overlay.style.padding = 'calc(10px + env(safe-area-inset-top, 0px)) 10px calc(10px + env(safe-area-inset-bottom, 0px)) 10px';
        this.overlay.style.boxSizing = 'border-box';
        
        // Handle clicking outside to close
        bindBackdropActivation(this.overlay, {
            onActivate: () => this.hide(),
        });

        this.panel = document.createElement('div');
        this.panel.className = 'panel-content app-themed-panel persona-panel-shell';
        this.panel.style.cssText = `
            position: relative;
            display: flex; flex-direction: column;
            width: min(94vw, 420px); height: min(82vh, 640px); max-height: calc(100% - 8px);
            background: var(--app-surface-card); border-radius: 12px; overflow: hidden;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        `;

        this.panel.innerHTML = `
            <div class="panel-header" style="padding: 15px; border-bottom: 1px solid var(--app-border-subtle); display: flex; justify-content: space-between; align-items: center; background: var(--app-surface-subtle);">
                <span style="font-weight: bold; font-size: 16px;">🎭 角色卡管理</span>
                <button class="close-btn" style="border: none; background: transparent; font-size: 20px; cursor: pointer; color: var(--app-text-secondary);">×</button>
            </div>
            <div id="persona-session-lock-bar" style="padding: 10px 15px; border-bottom: 1px solid rgba(0,0,0,0.06); background: var(--app-surface-card); display:none;">
                <!-- Filled dynamically -->
            </div>
            <div id="persona-list-container" style="flex: 1; overflow-y: auto; padding: 10px;">
                <!-- List goes here -->
            </div>
            <div class="panel-footer" style="padding: 15px; border-top: 1px solid var(--app-border-subtle); background: var(--app-surface-card); text-align: center;">
                <div style="display:flex; gap:8px;">
                    <button id="import-card-btn" style="
                        background: #0f172a; color: var(--app-text-inverse); border: none; padding: 10px 16px;
                        border-radius: 18px; font-size: 13px; cursor: pointer; flex: 1;
                    ">导入角色卡</button>
                    <button id="create-persona-btn" data-maid-guide-target="create-persona" style="
                        background: #007bff; color: var(--app-text-inverse); border: none; padding: 10px 16px; 
                        border-radius: 18px; font-size: 13px; cursor: pointer; flex: 1;
                        box-shadow: 0 2px 5px rgba(0,123,255,0.3);
                    ">+ 新建角色卡</button>
                </div>
            </div>
            <input type="file" id="persona-card-import" accept=".png,.json,.charx,application/json,image/png" style="display:none;">

            <!-- Edit View (Hidden by default) -->
            <div id="persona-edit-view" style="
                display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                background: var(--app-surface-card); z-index: 10; flex-direction: column;
            ">
                <div style="padding: 12px 12px; border-bottom: 1px solid var(--app-border-subtle); display: flex; align-items: center; gap: 8px; background: var(--app-surface-subtle);">
                    <button id="edit-back-btn" aria-label="返回" style="
                        width: 44px; height: 44px;
                        border: none; background: transparent;
                        font-size: 22px; cursor: pointer;
                        display: flex; align-items: center; justify-content: center;
                        border-radius: 12px;
                    ">←</button>
                    <span style="font-weight: bold; font-size: 16px;">编辑角色卡</span>
                </div>
                <div style="flex: 1; overflow-y: auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <div id="edit-avatar-preview" style="
                            width: 80px; height: 80px; border-radius: 50%; background-color: var(--app-surface-hover);
                            margin: 0 auto 10px; background-size: cover; background-position: center;
                            border: 2px solid var(--app-surface-card); box-shadow: 0 2px 8px rgba(0,0,0,0.1); cursor: pointer;
                        "></div>
                        <button id="edit-avatar-btn" style="font-size: 12px; padding: 4px 10px; background: var(--app-surface-hover); border: none; border-radius: 10px; color: var(--app-text-primary);">更换头像</button>
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 12px; color: var(--app-text-secondary); margin-bottom: 5px;">角色卡名称</label>
                        <input type="text" id="edit-name" style="width: 100%; padding: 10px; border: 1px solid var(--app-border-default); border-radius: 8px; box-sizing: border-box;">
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label class="has-help" data-help="可用于手动补充角色卡设定" style="display: block; font-size: 12px; color: var(--app-text-secondary); margin-bottom: 5px;">
                            角色描述
                        </label>
                        <textarea id="edit-desc" style="
                            width: 100%; height: 120px; padding: 10px; border: 1px solid var(--app-border-default); 
                            border-radius: 8px; resize: none; box-sizing: border-box; font-family: inherit;
                        " placeholder="例如：外表冷淡、说话简短，但会在关键时刻保护同伴。"></textarea>
                    </div>

                    <div style="margin-bottom: 15px; padding: 12px; border: 1px solid rgba(0,0,0,0.06); border-radius: 10px; background: rgba(248,250,252,0.8);">
                        <div class="has-help" data-help="当前仍沿用旧字段结构，后续会继续调整角色卡编辑内容。" style="font-size: 12px; font-weight: 700; color: var(--app-text-secondary); margin-bottom: 8px;">注入设置</div>
                        <div style="margin-bottom: 10px;">
                            <label style="display:block; font-size:12px; color:var(--app-text-secondary); margin-bottom:5px;">插入位置</label>
                            <select id="edit-position" style="display:none;">
                                <option value="0">IN_PROMPT（作为 system prompt 注入）</option>
                                <option value="4">AT_DEPTH（插入到聊天历史指定深度）</option>
                                <option value="9">NONE（不注入）</option>
                            </select>
                            <button type="button" id="edit-position-btn" class="world-app-select-btn" style="width:100%; margin-top:0;">
                                <span data-custom-select-label>插入位置</span>
                                <span class="world-app-select-btn-chevron">▾</span>
                            </button>
                        </div>
                        <div id="edit-depth-wrap" style="display:none; gap:10px;">
                            <div style="flex:1;">
                                <label style="display:block; font-size:12px; color:var(--app-text-secondary); margin-bottom:5px;">深度（0=最后一条）</label>
                                <input type="number" id="edit-depth" min="0" step="1" style="width:100%; padding:10px; border:1px solid var(--app-border-default); border-radius:8px; box-sizing:border-box;" />
                            </div>
                            <div style="flex:1;">
                                <label style="display:block; font-size:12px; color:var(--app-text-secondary); margin-bottom:5px;">注入角色</label>
                                <select id="edit-role" style="display:none;">
                                    <option value="0">system</option>
                                    <option value="1">user</option>
                                    <option value="2">assistant</option>
                                </select>
                                <button type="button" id="edit-role-btn" class="world-app-select-btn" style="width:100%; margin-top:0;">
                                    <span data-custom-select-label>注入角色</span>
                                    <span class="world-app-select-btn-chevron">▾</span>
                                </button>
                            </div>
                        </div>
                        <div style="margin-top:10px; font-size:11px; color:var(--app-text-muted); line-height:1.4;">
                            当前仍沿用旧字段结构，后续会继续调整角色卡编辑内容。
                        </div>
                    </div>

                    <button id="persona-new-chat-btn" class="persona-new-chat-btn" style="width: 100%; padding: 12px; background: var(--app-surface-subtle); color: #b45309; border: 1px solid #fcd34d; border-radius: 8px; margin-top: 20px; cursor: pointer; font-weight: 700;">为此角色卡开启新聊天</button>
                    <button id="export-persona-btn" style="width: 100%; padding: 12px; background: var(--app-surface-card); color: var(--app-text-primary); border: 1px solid var(--app-border-default); border-radius: 8px; margin-top: 10px; cursor: pointer; font-weight: 700;">导出角色卡</button>
                    <button id="persona-archive-btn" style="width: 100%; padding: 12px; background: var(--app-surface-card); color: var(--app-text-primary); border: 1px solid var(--app-border-default); border-radius: 8px; margin-top: 10px; cursor: pointer; font-weight: 700;">角色卡存档</button>
                    <button id="delete-persona-btn" style="width: 100%; padding: 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 8px; margin-top: 10px; cursor: pointer;">删除此角色卡</button>
                </div>
                <div style="padding: 15px; border-top: 1px solid var(--app-border-subtle); background: var(--app-surface-card);">
                    <button id="save-persona-btn" style="width: 100%; padding: 12px; background: #007bff; color: var(--app-text-inverse); border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">保存</button>
                </div>
            </div>
        `;

        this.overlay.appendChild(this.panel);
        document.body.appendChild(this.overlay);

        // Bind Events
        this.panel.querySelector('.close-btn').addEventListener('click', () => this.hide());
        this.panel.querySelector('#create-persona-btn').addEventListener('click', () => this.openEdit());
        const importBtn = this.panel.querySelector('#import-card-btn');
        this.importInput = this.panel.querySelector('#persona-card-import');
        if (importBtn && this.importInput) {
            importBtn.addEventListener('click', () => {
                this.showImportModal();
            });
            this.importInput.addEventListener('change', () => this.handleCardImport());
        }
        this.panel.querySelector('#edit-back-btn').addEventListener('click', () => this.closeEdit());
        this.panel.querySelector('#edit-avatar-preview').addEventListener('click', () => this.changeAvatar());
        this.panel.querySelector('#edit-avatar-btn').addEventListener('click', () => this.changeAvatar());
        this.panel.querySelector('#save-persona-btn').addEventListener('click', () => this.saveEdit());
        this.panel.querySelector('#delete-persona-btn').addEventListener('click', () => this.deleteCurrent());
        this.panel.querySelector('#persona-new-chat-btn').addEventListener('click', () => this.startRoleNewChat(this.editingId));
        this.panel.querySelector('#export-persona-btn').addEventListener('click', () => this.exportPersonaCard(this.editingId));
        this.panel.querySelector('#persona-archive-btn').addEventListener('click', () => this.openRoleArchiveModal(this.editingId));
        this.panel.querySelector('#edit-position').addEventListener('change', () => this.updateInjectionUi());
        bindCustomSelectButton({
            buttonEl: this.panel.querySelector('#edit-position-btn'),
            selectEl: this.panel.querySelector('#edit-position'),
            fallback: '插入位置',
        });
        bindCustomSelectButton({
            buttonEl: this.panel.querySelector('#edit-role-btn'),
            selectEl: this.panel.querySelector('#edit-role'),
            fallback: '注入角色',
        });

    }

    ensureImportModal() {
        if (this.importOverlay) return;
        const overlay = document.createElement('div');
        overlay.className = 'app-themed-overlay persona-import-overlay';
        overlay.style.cssText = `
            display:none; position:fixed; inset:0;
            background: rgba(0,0,0,0.38);
            z-index: 22040;
            padding: calc(10px + env(safe-area-inset-top, 0px)) 10px calc(10px + env(safe-area-inset-bottom, 0px)) 10px;
            box-sizing: border-box;
            align-items:center;
            justify-content:center;
        `;
        bindBackdropActivation(overlay, {
            onActivate: () => this.hideImportModal(),
        });

        const modal = document.createElement('div');
        modal.className = 'app-themed-panel persona-import-panel';
        modal.style.cssText = `
            width: min(92vw, 420px);
            background: var(--app-surface-card);
            border-radius: 14px;
            overflow: hidden;
            display:flex;
            flex-direction:column;
            box-shadow: 0 10px 40px rgba(0,0,0,0.18);
            max-height: min(84vh, 560px);
        `;
        modal.addEventListener('click', (e) => e.stopPropagation());

        modal.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--app-surface-subtle); border-bottom:1px solid var(--app-border-default);">
                <div style="font-weight:800;">导入角色卡</div>
                <button id="persona-import-close" style="margin-left:auto; width:36px; height:36px; border:none; background:transparent; font-size:20px; border-radius:10px; cursor:pointer;">×</button>
            </div>
            <div style="padding:14px; display:flex; flex-direction:column; gap:12px;">
                <div>
                    <div style="font-size:12px; color:var(--app-text-muted); margin-bottom:6px;">本地文件</div>
                    <button id="persona-import-file" style="width:100%; padding:10px 12px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-card); cursor:pointer; font-size:14px;">选择文件（PNG / JSON）</button>
                </div>
                <div style="border-top:1px dashed var(--app-border-default); padding-top:12px;">
                    <div style="font-size:12px; color:var(--app-text-muted); margin-bottom:6px;">链接导入</div>
                    <input id="persona-import-url" type="url" placeholder="粘贴 PNG/JSON 链接" style="width:100%; padding:8px 10px; border:1px solid var(--app-border-default); border-radius:10px; box-sizing:border-box;">
                    <button id="persona-import-url-btn" style="margin-top:8px; width:100%; padding:9px 12px; border:none; border-radius:10px; background:#0f172a; color:var(--app-text-inverse); cursor:pointer; font-size:14px;">导入链接</button>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        this.importOverlay = overlay;
        this.importModal = modal;
        this.importUrlInput = modal.querySelector('#persona-import-url');
        this.importUrlBtn = modal.querySelector('#persona-import-url-btn');
        this.importFileBtn = modal.querySelector('#persona-import-file');
        this.importCloseBtn = modal.querySelector('#persona-import-close');

        this.importCloseBtn?.addEventListener('click', () => this.hideImportModal());
        this.importFileBtn?.addEventListener('click', () => {
            if (!this.importInput) return;
            this.importInput.value = '';
            this.importInput.click();
        });
        if (this.importUrlInput && this.importUrlBtn) {
            const syncBtn = () => {
                const has = String(this.importUrlInput?.value || '').trim().length > 0;
                this.importUrlBtn.disabled = !has;
                this.importUrlBtn.style.opacity = has ? '1' : '0.6';
                this.importUrlBtn.style.cursor = has ? 'pointer' : 'not-allowed';
            };
            this.importUrlInput.addEventListener('input', syncBtn);
            this.importUrlInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.handleCardImportUrl();
                }
            });
            syncBtn();
        }
        this.importUrlBtn?.addEventListener('click', () => this.handleCardImportUrl());
    }

    getCharacterCardName(card) {
        return getCharacterCardDisplayName(card, '角色卡');
    }

    showImportModal() {
        this.ensureImportModal();
        if (this.importUrlInput) this.importUrlInput.value = '';
        if (this.importUrlBtn) {
            this.importUrlBtn.disabled = true;
            this.importUrlBtn.style.opacity = '0.6';
            this.importUrlBtn.style.cursor = 'not-allowed';
            this.importUrlBtn.textContent = '导入链接';
        }
        if (this.importOverlay) this.importOverlay.style.display = 'flex';
    }

    hideImportModal() {
        if (this.importOverlay) this.importOverlay.style.display = 'none';
    }

    ensureBulkModal() {
        if (this.bulkModal) return;
        const overlay = document.createElement('div');
        overlay.className = 'app-themed-overlay persona-bulk-overlay';
        overlay.style.cssText = `
            display:none; position:fixed; inset:0;
            background: rgba(0,0,0,0.38);
            z-index: 22050;
            padding: calc(10px + env(safe-area-inset-top, 0px)) 10px calc(10px + env(safe-area-inset-bottom, 0px)) 10px;
            box-sizing: border-box;
        `;
        bindBackdropActivation(overlay, {
            onActivate: () => this.hideBulkModal(),
        });

        const panel = document.createElement('div');
        panel.className = 'app-themed-panel persona-bulk-panel';
        panel.style.cssText = `
            width: min(96vw, 520px);
            height: min(86vh, 720px);
            background: var(--app-surface-card);
            border-radius: 14px;
            overflow: hidden;
            display:flex;
            flex-direction:column;
            box-shadow: 0 10px 40px rgba(0,0,0,0.18);
        `;
        panel.addEventListener('click', (e) => e.stopPropagation());

        panel.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; padding:12px; background:var(--app-surface-page); border-bottom:1px solid var(--app-border-default);">
                <button id="persona-bulk-back" style="width:44px; height:44px; border:none; background:transparent; border-radius:12px; font-size:22px; display:flex; align-items:center; justify-content:center; cursor:pointer;">←</button>
                <div style="font-weight:900;">批量绑定角色卡</div>
                <div id="persona-bulk-meta" style="margin-left:auto; font-size:12px; color:var(--app-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>
            </div>

            <div style="padding:10px 12px; border-bottom:1px solid rgba(0,0,0,0.06);">
                <div id="persona-bulk-search-box" style="display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid rgba(0,0,0,0.10); border-radius:14px; background:var(--app-surface-card);">
                    <input id="persona-bulk-search" type="text" placeholder="搜索联系人/群组..." style="flex:1; border:none; outline:none; font-size:14px; background:transparent;">
                    <button id="persona-bulk-clear" type="button" aria-label="清除搜索" style="display:none; width:32px; height:32px; border:none; border-radius:10px; background:var(--app-surface-hover); cursor:pointer;">×</button>
                </div>
                <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                    <button id="persona-bulk-select-all" style="border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:10px; padding:8px 10px; font-size:13px; cursor:pointer;">全选</button>
                    <button id="persona-bulk-select-none" style="border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:10px; padding:8px 10px; font-size:13px; cursor:pointer;">全不选</button>
                    <div id="persona-bulk-count" style="margin-left:auto; color:var(--app-text-muted); font-size:12px;"></div>
                </div>
            </div>

            <div id="persona-bulk-list" style="flex:1; min-height:0; overflow:auto; -webkit-overflow-scrolling:touch; padding:10px 12px;"></div>

            <div style="padding:12px; border-top:1px solid rgba(0,0,0,0.08); display:flex; gap:10px;">
                <button id="persona-bulk-cancel" style="flex:1; border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:12px; padding:12px; font-weight:700; cursor:pointer;">取消</button>
                <button id="persona-bulk-save" style="flex:2; border:none; background:#2563eb; color:var(--app-text-inverse); border-radius:12px; padding:12px; font-weight:900; cursor:pointer;">保存绑定</button>
            </div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const q = (sel) => panel.querySelector(sel);
        q('#persona-bulk-back')?.addEventListener('click', () => this.hideBulkModal());
        q('#persona-bulk-cancel')?.addEventListener('click', () => this.hideBulkModal());
        q('#persona-bulk-save')?.addEventListener('click', () => this.applyBulkModal());

        const searchEl = q('#persona-bulk-search');
        const clearEl = q('#persona-bulk-clear');
        const updateSearch = (val) => {
            if (!this.bulkState) return;
            this.bulkState.term = String(val || '');
            const has = this.bulkState.term.trim().length > 0;
            if (clearEl) clearEl.style.display = has ? 'block' : 'none';
            this.renderBulkList();
        };
        searchEl?.addEventListener('input', (e) => updateSearch(e.target.value));
        searchEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (searchEl) searchEl.value = '';
                updateSearch('');
            }
        });
        clearEl?.addEventListener('click', () => {
            if (searchEl) searchEl.value = '';
            updateSearch('');
            searchEl?.focus?.();
        });
        q('#persona-bulk-select-all')?.addEventListener('click', () => this.bulkSelectAll(true));
        q('#persona-bulk-select-none')?.addEventListener('click', () => this.bulkSelectAll(false));

        this.bulkModal = { overlay, panel };
    }

    hideBulkModal() {
        if (!this.bulkModal) return;
        this.bulkModal.overlay.style.display = 'none';
        this.bulkState = null;
    }

    getBulkSessions() {
        const ids = new Set();
        try {
            (this.contactsStore?.listContacts?.() || []).forEach((c) => {
                if (c?.id) ids.add(String(c.id));
            });
        } catch {}
        try {
            (this.chatStore?.listSessions?.() || []).forEach((id) => ids.add(String(id)));
        } catch {}
        return [...ids].filter(Boolean);
    }

    openBulkModal(personaId) {
        if (!this.chatStore) {
            window.toastr?.warning?.('当前环境不支持会话绑定（缺少 chatStore）');
            return;
        }
        this.ensureBulkModal();
        const p = this.store.get(personaId);
        if (!p) return;

        // Ensure contacts include all sessions (best-effort)
        try { this.contactsStore?.ensureFromSessions?.(this.chatStore.listSessions?.() || [], { defaultAvatar: '' }); } catch {}

        const sessionIds = this.getBulkSessions();
        const bound = new Set();
        sessionIds.forEach((sid) => {
            const lock = this.chatStore.getPersonaLock?.(sid);
            if (lock && String(lock) === String(personaId)) bound.add(String(sid));
        });

        this.bulkState = {
            personaId: String(personaId),
            personaName: this.getCharacterCardName(p) || personaId,
            term: '',
            sessionIds,
            selected: new Set(bound),
        };

        const metaEl = this.bulkModal.panel.querySelector('#persona-bulk-meta');
        if (metaEl) {
            metaEl.dataset.i18nSkip = '';
            metaEl.textContent = `${translateUiText('角色卡')}：${this.bulkState.personaName}`;
        }

        this.renderBulkList();
        this.bulkModal.overlay.style.display = 'block';
        this.bulkModal.panel.querySelector('#persona-bulk-search')?.focus?.();
    }

    bulkSelectAll(next) {
        if (!this.bulkState) return;
        const want = Boolean(next);
        if (want) this.bulkState.sessionIds.forEach((id) => this.bulkState.selected.add(String(id)));
        else this.bulkState.selected.clear();
        this.renderBulkList();
    }

    renderBulkList() {
        if (!this.bulkModal || !this.bulkState) return;
        const listEl = this.bulkModal.panel.querySelector('#persona-bulk-list');
        const countEl = this.bulkModal.panel.querySelector('#persona-bulk-count');
        if (!listEl) return;

        const term = String(this.bulkState.term || '').trim().toLowerCase();
        const items = this.bulkState.sessionIds
            .map((id) => {
                const c = this.contactsStore?.getContact?.(id) || null;
                const name = String(c?.name || id).trim();
                const avatar = String(c?.avatar || '').trim();
                const isGroup = Boolean(c?.isGroup) || String(id).startsWith('group:');
                return { id: String(id), name, avatar, isGroup };
            })
            .filter((it) => {
                if (!term) return true;
                const hay = `${it.name} ${it.id}`.toLowerCase();
                return hay.includes(term);
            })
            .sort((a, b) => {
                // Prefer groups first, then name
                const ga = a.isGroup ? 0 : 1;
                const gb = b.isGroup ? 0 : 1;
                if (ga !== gb) return ga - gb;
                return a.name.localeCompare(b.name);
            });

        listEl.innerHTML = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:18px 10px; color:var(--app-text-muted); text-align:center;';
            empty.textContent = '未找到匹配的联系人/群组';
            listEl.appendChild(empty);
        } else {
            items.forEach((it) => {
                const checked = this.bulkState.selected.has(it.id);
                const row = document.createElement('div');
                row.style.cssText = `
                    display:flex; align-items:center; gap:10px;
                    padding:10px 10px;
                    border: 1px solid rgba(0,0,0,0.06);
                    border-radius: 12px;
                    margin-bottom: 8px;
                    background: ${checked ? 'rgba(37,99,235,0.06)' : 'var(--app-surface-card)'};
                `;
                const avatarUrl = it.avatar || getDefaultAppIcon();
                row.innerHTML = `
                    <input class="persona-bulk-check" type="checkbox" ${checked ? 'checked' : ''} style="width:18px; height:18px;">
                    <img src="${avatarUrl}" alt="" style="width:36px; height:36px; border-radius:12px; object-fit:cover; background:var(--app-surface-hover);">
                    <div style="flex:1; min-width:0;">
                        <div data-i18n-skip style="font-weight:800; color:var(--app-text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            ${it.name}${it.isGroup ? ` · ${translateUiText('群组')}` : ''}
                        </div>
                        <div data-i18n-skip style="color:var(--app-text-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${it.id}</div>
                    </div>
                `;
                const checkbox = row.querySelector('.persona-bulk-check');
                const toggle = () => {
                    const next = !this.bulkState.selected.has(it.id);
                    if (next) this.bulkState.selected.add(it.id);
                    else this.bulkState.selected.delete(it.id);
                    this.renderBulkList();
                };
                row.addEventListener('click', (e) => {
                    if (e.target === checkbox) return;
                    toggle();
                });
                checkbox?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggle();
                });
                listEl.appendChild(row);
            });
        }
        if (countEl) countEl.textContent = `${translateUiText('已选')} ${this.bulkState.selected.size} / ${this.bulkState.sessionIds.length}`;
    }

    async applyBulkModal() {
        if (!this.bulkState || !this.chatStore) return;
        const personaId = this.bulkState.personaId;
        const selected = this.bulkState.selected;
        const ids = this.bulkState.sessionIds;

        let changed = 0;
        ids.forEach((sid) => {
            const id = String(sid);
            const want = selected.has(id);
            const cur = String(this.chatStore.getPersonaLock?.(id) || '');
            if (want) {
                if (cur !== personaId) {
                    this.chatStore.setPersonaLock?.(id, personaId);
                    changed++;
                }
            } else {
                if (cur === personaId) {
                    this.chatStore.clearPersonaLock?.(id);
                    changed++;
                }
            }
        });

        window.toastr?.success?.(`已应用 ${changed} 项绑定变更`);
        this.hideBulkModal();
        this.renderList();
        await this.notifyPersonaChanged();
    }

    updateInjectionUi() {
        const posEl = this.panel?.querySelector?.('#edit-position');
        const wrap = this.panel?.querySelector?.('#edit-depth-wrap');
        if (!posEl || !wrap) return;
        const pos = Number(posEl.value);
        // SillyTavern: AT_DEPTH=4 shows depth/role controls
        wrap.style.display = (pos === 4) ? 'flex' : 'none';
    }

    getCurrentSessionId() {
        try {
            return this.getSessionId ? String(this.getSessionId() || '').trim() : '';
        } catch {
            return '';
        }
    }

    getSessionLockPersonaId(sessionId) {
        try {
            if (!this.chatStore || !sessionId) return '';
            const lockId = this.chatStore.getPersonaLock?.(sessionId);
            return lockId ? String(lockId) : '';
        } catch {
            return '';
        }
    }

    setSessionLockPersonaId(sessionId, personaId) {
        try {
            if (!this.chatStore || !sessionId) return false;
            const pid = String(personaId || '').trim();
            if (!pid) return false;
            this.chatStore.setPersonaLock?.(sessionId, pid);
            return true;
        } catch {
            return false;
        }
    }

    clearSessionLockPersonaId(sessionId) {
        try {
            if (!this.chatStore || !sessionId) return false;
            this.chatStore.clearPersonaLock?.(sessionId);
            return true;
        } catch {
            return false;
        }
    }

    ensureGalleryUI() {
        if (this.galleryOverlay) return;
        const overlay = document.createElement('div');
        overlay.className = 'app-themed-overlay persona-gallery-overlay';
        overlay.style.display = 'none';
        bindBackdropActivation(overlay, {
            onActivate: () => this.hideGallery(),
        });

        const panel = document.createElement('section');
        panel.className = 'app-themed-panel persona-gallery-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', '角色卡浏览');
        panel.addEventListener('click', event => event.stopPropagation());
        panel.innerHTML = `
            <header class="persona-gallery-header">
                <div class="persona-gallery-heading-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="3"></rect><path d="M9 8h6M9 12h6M9 16h4"></path></svg>
                </div>
                <div class="persona-gallery-heading-copy">
                    <h2>角色卡浏览</h2>
                    <p>搜索角色，点击卡片查看详情</p>
                </div>
                <button type="button" class="persona-gallery-header-action" data-persona-gallery-manage>进入管理</button>
                <button type="button" class="persona-gallery-close" data-persona-gallery-close aria-label="关闭">×</button>
            </header>
            <div class="persona-gallery-toolbar">
                <label class="persona-gallery-search">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg>
                    <input type="search" placeholder="搜索名称、说明或来源文件" autocomplete="off">
                    <button type="button" aria-label="清除搜索" data-persona-gallery-clear hidden>×</button>
                </label>
                <span class="persona-gallery-count" aria-live="polite"></span>
            </div>
            <div class="persona-gallery-scroll">
                <div class="persona-gallery-grid"></div>
            </div>
            <footer class="persona-gallery-footer">卡片视图用于浏览与快速操作；导入、删除和批量整理仍在「角色卡管理」。</footer>
        `;

        const searchInput = panel.querySelector('.persona-gallery-search input');
        const clearButton = panel.querySelector('[data-persona-gallery-clear]');
        searchInput?.addEventListener('input', () => {
            this.galleryQuery = String(searchInput.value || '');
            if (clearButton) clearButton.hidden = !this.galleryQuery;
            this.galleryFlippedId = '';
            this.renderGallery();
        });
        clearButton?.addEventListener('click', () => {
            this.galleryQuery = '';
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            clearButton.hidden = true;
            this.galleryFlippedId = '';
            this.renderGallery();
        });
        panel.querySelector('[data-persona-gallery-close]')?.addEventListener('click', () => this.hideGallery());
        panel.querySelector('[data-persona-gallery-manage]')?.addEventListener('click', async () => {
            this.hideGallery();
            await this.show();
        });

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.galleryOverlay = overlay;
        this.galleryPanel = panel;
    }

    async showGallery() {
        await this.store.ready;
        this.ensureUI();
        this.ensureGalleryUI();
        this.galleryFlippedId = '';
        const searchInput = this.galleryPanel?.querySelector('.persona-gallery-search input');
        if (searchInput) searchInput.value = this.galleryQuery;
        const clearButton = this.galleryPanel?.querySelector('[data-persona-gallery-clear]');
        if (clearButton) clearButton.hidden = !this.galleryQuery;
        this.renderGallery();
        this.galleryOverlay.style.display = 'flex';
        this.galleryPanel.classList.remove('is-entering');
        requestAnimationFrame(() => this.galleryPanel?.classList.add('is-entering'));
        setTimeout(() => this.galleryPanel?.classList.remove('is-entering'), 260);
        if (!this.galleryKeydownHandler) {
            this.galleryKeydownHandler = (event) => {
                if (event.key !== 'Escape') return;
                if (this.galleryDetailOverlay?.style.display === 'flex') {
                    this.hideGalleryDetailOverlay();
                    return;
                }
                this.hideGallery();
            };
            document.addEventListener('keydown', this.galleryKeydownHandler);
        }
    }

    hideGallery() {
        this.hideGalleryDetailOverlay();
        if (this.galleryOverlay) this.galleryOverlay.style.display = 'none';
        this.galleryPanel?.classList.remove('is-entering');
        this.galleryFlippedId = '';
        if (this.galleryKeydownHandler) {
            document.removeEventListener('keydown', this.galleryKeydownHandler);
            this.galleryKeydownHandler = null;
        }
    }

    formatGalleryDate(value = 0) {
        const timestamp = Number(value || 0);
        if (!timestamp) return '';
        try {
            return new Date(timestamp).toLocaleDateString();
        } catch {
            return '';
        }
    }

    async loadGalleryDetails(persona) {
        const personaId = String(persona?.id || '').trim();
        if (!personaId) return buildPersonaGalleryDetails(persona);
        if (this.galleryDetailCache.has(personaId)) return this.galleryDetailCache.get(personaId);
        if (this.galleryDetailRequests.has(personaId)) return this.galleryDetailRequests.get(personaId);
        const request = (async () => {
            let rawCard = persona?.originalCard && typeof persona.originalCard === 'object'
                ? persona.originalCard
                : null;
            let loadFailed = false;
            if (!rawCard && persona?.source?.originalCardStored === true) {
                try {
                    rawCard = await window.appBridge?.loadPersonaCard?.(personaId);
                } catch (error) {
                    loadFailed = true;
                    logger.debug('load persona gallery details failed', error);
                }
            }
            const details = buildPersonaGalleryDetails(persona, rawCard);
            // 读原卡失败时不落缓存，下次翻面可重试
            if (!loadFailed) this.galleryDetailCache.set(personaId, details);
            return details;
        })().finally(() => this.galleryDetailRequests.delete(personaId));
        this.galleryDetailRequests.set(personaId, request);
        return request;
    }

    renderGalleryDetails(card, persona, details) {
        if (!card || !details) return;
        const intro = card.querySelector('.persona-gallery-back-intro');
        if (intro) {
            intro.textContent = String(details.description || details.summary || '').trim() || '暂无角色卡说明';
        }
        const tags = card.querySelector('.persona-gallery-back-tags');
        if (tags) {
            tags.replaceChildren();
            const shown = details.tags.slice(0, 4);
            shown.forEach(label => {
                const tag = document.createElement('span');
                tag.textContent = label;
                tags.appendChild(tag);
            });
            if (details.tags.length > shown.length) {
                const more = document.createElement('span');
                more.className = 'is-more';
                more.textContent = `+${details.tags.length - shown.length}`;
                tags.appendChild(more);
            }
            tags.hidden = !tags.childElementCount;
        }
    }

    renderGalleryDetailSections(body, details) {
        if (!body || !details) return;
        body.replaceChildren();
        const addSection = (label, value, className = '') => {
            const content = String(value || '').trim();
            if (!content) return;
            const section = document.createElement('section');
            section.className = `persona-gallery-detail-section${className ? ` ${className}` : ''}`;
            const heading = document.createElement('h4');
            heading.textContent = label;
            const paragraph = document.createElement('p');
            paragraph.textContent = content;
            section.append(heading, paragraph);
            body.appendChild(section);
        };
        addSection('角色说明', details.description || details.summary);
        addSection('性格', details.personality);
        addSection('场景', details.scenario);
        addSection('作者说明', details.creatorNotes);
        if (details.tags.length) {
            const section = document.createElement('section');
            section.className = 'persona-gallery-detail-section';
            const heading = document.createElement('h4');
            heading.textContent = '标签';
            const tags = document.createElement('div');
            tags.className = 'persona-gallery-detail-tags';
            details.tags.slice(0, 12).forEach(label => {
                const tag = document.createElement('span');
                tag.textContent = label;
                tags.appendChild(tag);
            });
            section.append(heading, tags);
            body.appendChild(section);
        }
        const metadata = [details.creator ? `作者 ${details.creator}` : '', details.sourceLabel].filter(Boolean).join(' · ');
        addSection('来源', metadata);
        if (details.tooLarge) addSection('提示', '原始角色卡过大，详情仅显示本地摘要。', 'is-note');
        if (!body.childElementCount) addSection('角色说明', '暂无可显示的角色卡详情。');
    }

    ensureGalleryDetailOverlay() {
        if (this.galleryDetailOverlay) return;
        const overlay = document.createElement('div');
        overlay.className = 'app-themed-overlay persona-gallery-detail-overlay';
        overlay.style.display = 'none';
        bindBackdropActivation(overlay, {
            onActivate: () => this.hideGalleryDetailOverlay(),
        });
        const panel = document.createElement('section');
        panel.className = 'app-themed-panel persona-gallery-detail-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', '角色卡完整资料');
        panel.addEventListener('click', event => event.stopPropagation());
        panel.innerHTML = `
            <header class="persona-gallery-detail-header">
                <img alt="">
                <div class="persona-gallery-detail-title">
                    <h3></h3>
                    <span></span>
                </div>
                <button type="button" class="persona-gallery-close" data-persona-gallery-detail-close aria-label="关闭">×</button>
            </header>
            <div class="persona-gallery-detail-scroll"></div>
        `;
        panel.querySelector('[data-persona-gallery-detail-close]')?.addEventListener('click', () => this.hideGalleryDetailOverlay());
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.galleryDetailOverlay = overlay;
        this.galleryDetailPanel = panel;
    }

    async openGalleryDetailOverlay(personaId) {
        const persona = this.store.get(personaId);
        if (!persona) return;
        this.ensureGalleryDetailOverlay();
        const avatar = this.galleryDetailPanel.querySelector('.persona-gallery-detail-header img');
        if (avatar) avatar.src = persona.avatar || getDefaultAppIcon();
        const title = this.galleryDetailPanel.querySelector('.persona-gallery-detail-title h3');
        if (title) title.textContent = this.getCharacterCardName(persona);
        const subtitle = this.galleryDetailPanel.querySelector('.persona-gallery-detail-title span');
        if (subtitle) subtitle.textContent = this.formatGalleryDate(persona.updated) || '';
        const body = this.galleryDetailPanel.querySelector('.persona-gallery-detail-scroll');
        if (body) body.replaceChildren();
        this.galleryDetailOverlay.style.display = 'flex';
        const details = await this.loadGalleryDetails(persona);
        if (this.galleryDetailOverlay.style.display === 'flex') {
            this.renderGalleryDetailSections(body, details);
        }
    }

    hideGalleryDetailOverlay() {
        if (this.galleryDetailOverlay) this.galleryDetailOverlay.style.display = 'none';
    }

    async openGalleryMoreMenu(personaId) {
        const persona = this.store.get(personaId);
        if (!persona) return;
        const choice = await appChoice({
            title: this.getCharacterCardName(persona),
            message: '选择要执行的操作。',
            actions: [
                { id: 'edit', label: '编辑' },
                { id: 'export', label: '导出角色卡' },
                { id: 'archive', label: '存档' },
                { id: 'cancel', label: '取消' },
            ],
            defaultActionId: 'cancel',
        });
        if (choice === 'edit') {
            this.hideGallery();
            await this.show();
            this.openEdit(personaId);
        } else if (choice === 'export') {
            await this.exportPersonaCard(personaId);
        } else if (choice === 'archive') {
            this.openRoleArchiveModal(personaId);
        }
    }

    toggleGalleryCard(card, persona) {
        if (!card || !persona) return;
        const nextFlipped = !card.classList.contains('is-flipped');
        this.galleryPanel?.querySelectorAll('.persona-gallery-card.is-flipped').forEach(item => {
            item.classList.remove('is-flipped');
            item.setAttribute('aria-pressed', 'false');
        });
        this.galleryFlippedId = nextFlipped ? String(persona.id || '') : '';
        card.classList.toggle('is-flipped', nextFlipped);
        card.setAttribute('aria-pressed', String(nextFlipped));
        if (!nextFlipped) return;
        this.loadGalleryDetails(persona).then(details => {
            const mounted = Array.from(this.galleryPanel?.querySelectorAll('.persona-gallery-card') || [])
                .find(item => String(item.dataset.personaId || '') === String(persona.id || ''));
            if (mounted) this.renderGalleryDetails(mounted, persona, details);
        });
    }

    async activatePersona(personaId) {
        const targetId = String(personaId || '').trim();
        if (!targetId || !this.store.get(targetId)) return false;
        const currentId = String(this.store.activeId || '');
        if (currentId !== targetId) {
            this.onUserPersonaSwitch?.({
                fromPersonaId: currentId,
                toPersonaId: targetId,
            });
            const switched = await this.store.setActive(targetId);
            if (!switched) return false;
            await this.notifyPersonaChanged();
        }
        if (this.panel) this.renderList();
        if (this.galleryPanel) this.renderGallery();
        return true;
    }

    renderGallery() {
        if (!this.galleryPanel) return;
        const grid = this.galleryPanel.querySelector('.persona-gallery-grid');
        const count = this.galleryPanel.querySelector('.persona-gallery-count');
        if (!grid) return;
        const allPersonas = this.store.getAll?.() || [];
        const personas = filterPersonaGalleryItems(allPersonas, this.galleryQuery);
        if (count) count.textContent = this.galleryQuery ? `${personas.length} / ${allPersonas.length} 张` : `${allPersonas.length} 张角色卡`;
        grid.replaceChildren();
        if (!personas.length) {
            const empty = document.createElement('div');
            empty.className = 'persona-gallery-empty';
            empty.innerHTML = '<span aria-hidden="true">⌕</span><strong>没有找到角色卡</strong><p>换个名称或关键词试试</p>';
            grid.appendChild(empty);
            return;
        }
        const activeId = String(this.store.activeId || '');
        const sessionId = this.getCurrentSessionId();
        const lockPersonaId = sessionId ? this.getSessionLockPersonaId(sessionId) : '';
        personas.forEach(persona => {
            const personaId = String(persona.id || '');
            const isActive = personaId === activeId;
            const isLocked = Boolean(lockPersonaId && personaId === lockPersonaId);
            const card = document.createElement('article');
            card.className = `persona-gallery-card${isActive ? ' is-active' : ''}${this.galleryFlippedId === personaId ? ' is-flipped' : ''}`;
            card.dataset.personaId = personaId;
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', `${this.getCharacterCardName(persona)}，点击翻面`);
            card.setAttribute('aria-pressed', String(this.galleryFlippedId === personaId));

            const inner = document.createElement('div');
            inner.className = 'persona-gallery-card-inner';
            const front = document.createElement('div');
            front.className = 'persona-gallery-card-face persona-gallery-card-front';
            front.setAttribute('data-persona-gallery-flip', 'front');
            const cover = document.createElement('div');
            cover.className = 'persona-gallery-cover';
            const image = document.createElement('img');
            image.src = persona.avatar || getDefaultAppIcon();
            image.alt = '';
            cover.appendChild(image);
            const badges = document.createElement('div');
            badges.className = 'persona-gallery-badges';
            if (isActive) {
                const badge = document.createElement('span');
                badge.className = 'is-active';
                badge.textContent = '使用中';
                badges.appendChild(badge);
            }
            if (isLocked) {
                const badge = document.createElement('span');
                badge.textContent = '会话锁定';
                badges.appendChild(badge);
            }
            cover.appendChild(badges);
            const frontCopy = document.createElement('div');
            frontCopy.className = 'persona-gallery-front-copy';
            const name = document.createElement('h3');
            name.textContent = this.getCharacterCardName(persona);
            const summary = document.createElement('p');
            summary.textContent = String(persona.description || '').trim() || '点击查看角色卡详情与快捷操作';
            const hint = document.createElement('span');
            hint.className = 'persona-gallery-flip-hint';
            hint.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"></path><path d="m9 4-3 3 3 3M15 20l3-3-3-3"></path></svg> 查看背面';
            frontCopy.append(name, summary, hint);
            front.append(cover, frontCopy);

            const back = document.createElement('div');
            back.className = 'persona-gallery-card-face persona-gallery-card-back';
            back.setAttribute('data-persona-gallery-flip', 'back');
            const backHeader = document.createElement('div');
            backHeader.className = 'persona-gallery-back-header';
            const backName = document.createElement('h3');
            backName.textContent = this.getCharacterCardName(persona);
            const updated = document.createElement('span');
            updated.textContent = this.formatGalleryDate(persona.updated) || '角色卡详情';
            backHeader.append(backName, updated);
            const backIntro = document.createElement('p');
            backIntro.className = 'persona-gallery-back-intro';
            const backTags = document.createElement('div');
            backTags.className = 'persona-gallery-back-tags';
            backTags.hidden = true;
            const initialDetails = this.galleryDetailCache.get(personaId)
                || buildPersonaGalleryDetails(persona, persona.originalCard);
            const detailLink = document.createElement('button');
            detailLink.type = 'button';
            detailLink.className = 'persona-gallery-detail-link';
            detailLink.dataset.personaGalleryAction = 'detail';
            detailLink.textContent = '查看完整资料';
            const actions = document.createElement('div');
            actions.className = 'persona-gallery-card-actions';
            const makeAction = (label, action, className = '') => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = label;
                button.dataset.personaGalleryAction = action;
                if (className) button.className = className;
                return button;
            };
            const useButton = makeAction(isActive ? '使用中' : '使用', 'activate', 'is-primary');
            useButton.disabled = isActive;
            const newChatButton = makeAction('新聊天', 'new-chat');
            const moreButton = makeAction('⋯', 'more', 'is-ellipsis');
            moreButton.setAttribute('aria-label', '更多操作');
            moreButton.title = '更多操作';
            actions.append(useButton, newChatButton, moreButton);
            const flipBack = document.createElement('button');
            flipBack.type = 'button';
            flipBack.className = 'persona-gallery-flip-back';
            flipBack.setAttribute('aria-label', '翻回封面');
            flipBack.title = '翻回封面';
            flipBack.textContent = '↩';
            back.append(backHeader, backIntro, backTags, detailLink, actions, flipBack);
            inner.append(front, back);
            card.appendChild(inner);
            this.renderGalleryDetails(card, persona, initialDetails);

            card.addEventListener('click', event => {
                if (event.target.closest('button, a, input')) return;
                this.toggleGalleryCard(card, persona);
            });
            card.addEventListener('keydown', event => {
                if (!['Enter', ' '].includes(event.key) || event.target.closest('button')) return;
                event.preventDefault();
                this.toggleGalleryCard(card, persona);
            });
            flipBack.addEventListener('click', event => {
                event.stopPropagation();
                this.toggleGalleryCard(card, persona);
            });
            useButton.addEventListener('click', async event => {
                event.stopPropagation();
                await this.activatePersona(personaId);
            });
            newChatButton.addEventListener('click', event => {
                event.stopPropagation();
                this.startRoleNewChat(personaId);
            });
            detailLink.addEventListener('click', event => {
                event.stopPropagation();
                this.openGalleryDetailOverlay(personaId);
            });
            moreButton.addEventListener('click', event => {
                event.stopPropagation();
                this.openGalleryMoreMenu(personaId);
            });
            grid.appendChild(card);
            if (this.galleryFlippedId === personaId && !this.galleryDetailCache.has(personaId)) {
                this.loadGalleryDetails(persona).then(details => this.renderGalleryDetails(card, persona, details));
            }
        });
    }

    renderSessionLockBar() {
        const bar = this.panel?.querySelector?.('#persona-session-lock-bar');
        if (!bar) return;
        const sessionId = this.getCurrentSessionId();
        if (!sessionId || !this.chatStore) {
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
        }
        const lockPersonaId = this.getSessionLockPersonaId(sessionId);
        const lockedPersona = lockPersonaId ? this.store.get(lockPersonaId) : null;
        const lockedName = this.getCharacterCardName(lockedPersona) || lockPersonaId || '';

        bar.style.display = 'block';
        bar.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <div style="flex:1; min-width:0;">
                    <div data-i18n-skip style="font-weight:800; color:var(--app-text-primary); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${translateUiText(`当前会话：${sessionId}`)}</div>
                    <div data-i18n-skip style="color:var(--app-text-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${translateUiText(lockPersonaId ? `已锁定角色卡：${lockedName}` : '未锁定（使用全局角色卡）')}
                    </div>
                </div>
                ${lockPersonaId ? `<button id="persona-unlock-btn" style="border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:10px; padding:6px 10px; cursor:pointer;">解除锁定</button>` : ''}
            </div>
        `;
        bar.querySelector('#persona-unlock-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            this.clearSessionLockPersonaId(sessionId);
            this.renderList();
            await this.notifyPersonaChanged();
        });
    }

    async show() {
        await this.store.ready;
        this.ensureUI();
        this.renderList();
        this.overlay.style.display = 'flex';
        // Center overlay
        this.overlay.style.justifyContent = 'center';
        this.overlay.style.alignItems = 'center';
    }

    hide() {
        closeCustomSelectMenu();
        if (this.overlay) this.overlay.style.display = 'none';
        this.closeEdit();
    }

    renderList() {
        this.renderSessionLockBar();
        const listEl = this.panel.querySelector('#persona-list-container');
        listEl.innerHTML = '';
        const personas = this.store.getAll();
        const activeId = this.store.activeId;
        const sessionId = this.getCurrentSessionId();
        const lockPersonaId = sessionId ? this.getSessionLockPersonaId(sessionId) : '';

        personas.forEach(p => {
            const item = document.createElement('div');
            item.style.cssText = `
                display: flex; align-items: center; gap: 10px; padding: 12px;
                border-bottom: 1px solid var(--app-border-subtle); cursor: pointer;
                background: ${p.id === activeId ? '#f0f9ff' : 'var(--app-surface-card)'};
                border-radius: 8px; margin-bottom: 5px;
                border: 1px solid ${p.id === activeId ? '#bae6fd' : 'transparent'};
            `;

            const avatarUrl = p.avatar || getDefaultAppIcon(); // Default user avatar
            const isLockedForSession = lockPersonaId && p.id === lockPersonaId;
            const cardName = this.getCharacterCardName(p);
            const subtitle = p.description || '未设置角色描述';
            const subtitleSkipAttribute = p.description ? ' data-i18n-skip' : '';

            item.innerHTML = `
                <div style="position: relative;">
                    <img src="${avatarUrl}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--app-surface-hover);">
                    ${p.id === activeId ? '<div style="position: absolute; bottom: 0; right: 0; width: 14px; height: 14px; background: #007bff; border-radius: 50%; border: 2px solid var(--app-surface-card);"></div>' : ''}
                    ${isLockedForSession ? '<div title="此会话已锁定" style="position:absolute; top:-4px; right:-4px; width:18px; height:18px; background:#0f172a; color:var(--app-text-inverse); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; border:2px solid var(--app-surface-card);">🔒</div>' : ''}
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div data-i18n-skip style="font-weight: bold; color: var(--app-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${cardName}</div>
                    <div${subtitleSkipAttribute} style="font-size: 12px; color: var(--app-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${subtitle}</div>
                </div>
                <div class="persona-card-actions" style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                    <button class="persona-new-chat-btn" title="为此角色卡开启新聊天" style="
                        padding: 7px 8px; border: 1px solid var(--app-border-default); background: var(--app-surface-subtle);
                        color: var(--app-text-secondary); cursor: pointer; font-size: 12px; border-radius: 9px; font-weight: 700;
                        white-space: nowrap;
                    ">新聊天</button>
                    <button class="edit-btn" style="
                        width: 34px; height: 34px; border: none; background: transparent; color: var(--app-text-muted); cursor: pointer;
                        font-size: 16px; border-radius: 9px;
                    ">✎</button>
                </div>
            `;

            // Click item to switch
            item.addEventListener('click', async (e) => {
                // Ignore if clicked edit button
                if (e.target.closest('.edit-btn, .persona-new-chat-btn')) return;
                await this.activatePersona(p.id);
            });

            item.querySelector('.persona-new-chat-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.startRoleNewChat(p.id);
            });

            // Click edit button
            item.querySelector('.edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.openEdit(p.id);
            });

            listEl.appendChild(item);
        });
    }

    openEdit(id = null) {
        this.editingId = id;
        const view = this.panel.querySelector('#persona-edit-view');
        const nameInput = this.panel.querySelector('#edit-name');
        const descInput = this.panel.querySelector('#edit-desc');
        const posEl = this.panel.querySelector('#edit-position');
        const depthEl = this.panel.querySelector('#edit-depth');
        const roleEl = this.panel.querySelector('#edit-role');
        const posBtn = this.panel.querySelector('#edit-position-btn');
        const roleBtn = this.panel.querySelector('#edit-role-btn');
        const deleteBtn = this.panel.querySelector('#delete-persona-btn');
        const newChatBtn = this.panel.querySelector('#persona-new-chat-btn');
        const archiveBtn = this.panel.querySelector('#persona-archive-btn');
        const exportBtn = this.panel.querySelector('#export-persona-btn');
        const title = view.querySelector('span');

        if (id) {
            const p = this.store.get(id);
            if (!p) return;
            nameInput.value = this.getCharacterCardName(p);
            descInput.value = p.description || '';
            if (posEl) posEl.value = String(Number.isFinite(Number(p.position)) ? Number(p.position) : 0);
            if (depthEl) depthEl.value = String(Number.isFinite(Number(p.depth)) ? Math.max(0, Math.trunc(Number(p.depth))) : 2);
            if (roleEl) roleEl.value = String(Number.isFinite(Number(p.role)) ? Math.max(0, Math.min(2, Math.trunc(Number(p.role)))) : 0);
            this.updateAvatarPreview(p.avatar);
            deleteBtn.style.display = 'block';
            if (newChatBtn) newChatBtn.style.display = 'block';
            if (archiveBtn) archiveBtn.style.display = 'block';
            if (exportBtn) exportBtn.style.display = 'block';
            title.textContent = '编辑角色卡';
            
            // Disable delete if it's the only one
            if (this.store.getAll().length <= 1) {
                deleteBtn.style.display = 'none';
            }
        } else {
            nameInput.value = '新角色卡';
            descInput.value = '';
            if (posEl) posEl.value = '0';
            if (depthEl) depthEl.value = '2';
            if (roleEl) roleEl.value = '0';
            this.updateAvatarPreview('');
            deleteBtn.style.display = 'none';
            if (newChatBtn) newChatBtn.style.display = 'none';
            if (archiveBtn) archiveBtn.style.display = 'none';
            if (exportBtn) exportBtn.style.display = 'none';
            title.textContent = '新建角色卡';
        }

        refreshCustomSelectButton(posBtn, posEl, '插入位置');
        refreshCustomSelectButton(roleBtn, roleEl, '注入角色');
        this.updateInjectionUi();

        view.style.display = 'flex';
        // Animation
        view.style.opacity = '0';
        view.style.transform = 'translateY(20px)';
        requestAnimationFrame(() => {
            view.style.transition = 'all 0.2s ease-out';
            view.style.opacity = '1';
            view.style.transform = 'translateY(0)';
        });
    }

    closeEdit() {
        closeCustomSelectMenu();
        const view = this.panel.querySelector('#persona-edit-view');
        view.style.display = 'none';
        this.editingId = null;
    }

    updateAvatarPreview(url) {
        const div = this.panel.querySelector('#edit-avatar-preview');
        // If no URL, use default image for preview context
        const safeUrl = url || getDefaultAppIcon();
        div.style.backgroundImage = `url("${safeUrl}")`;
        div.dataset.url = url || '';
    }

    async changeAvatar() {
        // Use MediaPicker to pick image
        const useFile = await appConfirm({
            title: '头像来源',
            message: '使用本地图片文件吗？',
            confirmText: '本地文件',
            cancelText: '使用 URL',
        });
        if (useFile) {
            await this.mediaPicker.pickFile('image');
        } else {
            await this.mediaPicker.pickUrl('请输入头像地址', getDefaultAppIcon());
        }
    }

    // 导入角色卡文件并刷新列表；返回导入器结果（用户在弹窗中取消时为 false）。女仆附件导入也走这里
    async importCardFile(file) {
        const imported = await this.cardImporter.importFromFile(file);
        this.galleryDetailCache.clear();
        this.renderList();
        if (this.galleryPanel) this.renderGallery();
        return imported;
    }

    // 女仆附件导入角色卡：先计划后提交；不弹导入选项（内容由用户的话决定），提交后刷新列表
    async planCardFile(file) {
        return this.cardImporter.planFromFile(file);
    }

    async commitCardPlan(planned, { include = {}, activate = false } = {}) {
        const result = await this.cardImporter.service.commit(planned, { include, activate });
        if (result.ok) {
            this.galleryDetailCache.clear();
            // 面板尚未打开时没有 DOM；打开时会按存储重新渲染
            if (this.panel) this.renderList();
            if (this.galleryPanel) this.renderGallery();
            if (result.activated && result.greetingCount > 0) {
                try {
                    await this.notifyGreetingsImported({ personaId: result.personaId, greetingCount: result.greetingCount });
                } catch {}
            }
        }
        return result;
    }

    async handleCardImport() {
        const file = this.importInput?.files?.[0];
        if (!file) return;
        try {
            await this.importCardFile(file);
            this.hideImportModal();
        } catch (err) {
            const msg = err?.message || '导入失败';
            window.toastr?.error?.(msg);
        }
    }

    async handleCardImportUrl() {
        const url = String(this.importUrlInput?.value || '').trim();
        if (!url) return;
        if (this.importUrlBtn) {
            this.importUrlBtn.disabled = true;
            this.importUrlBtn.textContent = '导入中...';
        }
        try {
            await this.cardImporter.importFromUrl(url);
            this.galleryDetailCache.clear();
            this.renderList();
            if (this.galleryPanel) this.renderGallery();
            this.hideImportModal();
        } catch (err) {
            const msg = err?.message || '链接导入失败';
            window.toastr?.error?.(msg);
        } finally {
            if (this.importUrlBtn) {
                this.importUrlBtn.disabled = false;
                this.importUrlBtn.textContent = '导入链接';
            }
        }
    }

    async exportPersonaCard(personaId) {
        const persona = this.store.get(String(personaId || '').trim());
        if (!persona) {
            window.toastr?.error?.('未找到要导出的角色卡');
            return '';
        }
        const choice = await appChoice({
            title: '导出角色卡',
            message: '选择 SillyTavern 兼容格式。PNG 会把角色资料（V2 与 CCv3 两份）写入头像图片；JSON 只导出角色资料；.charx 为 CCv3 资源包，含头像及导入时附带的资源。',
            actions: [
                { id: 'png', label: 'PNG 角色卡', primary: true },
                { id: 'json', label: 'JSON 角色卡' },
                { id: 'charx', label: 'CCv3 .charx' },
                { id: 'cancel', label: '取消' },
            ],
            defaultActionId: 'png',
        });
        if (!['png', 'json', 'charx'].includes(choice)) return '';
        try {
            const result = await this.cardExporter.export(persona, choice);
            if (!result?.path) return '';
            window.toastr?.success?.(`已导出角色卡：${result.path}`);
            return result.path;
        } catch (err) {
            logger.error('导出角色卡失败', err);
            window.toastr?.error?.(`导出角色卡失败：${err?.message || '未知错误'}`);
            return '';
        }
    }

    async saveEdit() {
        const name = this.panel.querySelector('#edit-name').value.trim();
        const description = this.panel.querySelector('#edit-desc').value;
        const avatar = this.panel.querySelector('#edit-avatar-preview').dataset.url || '';
        const position = Number(this.panel.querySelector('#edit-position')?.value ?? 0);
        const depth = Math.max(0, Math.trunc(Number(this.panel.querySelector('#edit-depth')?.value ?? 2) || 0));
        const role = Math.max(0, Math.min(2, Math.trunc(Number(this.panel.querySelector('#edit-role')?.value ?? 0) || 0)));

        if (!name) {
            alert('请输入角色卡名称');
            return;
        }

        const applySourcePatch = (existing = null) => {
            const source = { ...getCharacterCardSource(existing) };
            if (getCharacterCardDisplayName(existing, '') || source.type === 'character_card') {
                source.characterName = name;
            }
            return Object.keys(source).length ? source : null;
        };

        if (this.editingId) {
            const current = this.store.get(this.editingId);
            await this.store.update(this.editingId, { name, description, avatar, position, depth, role, source: applySourcePatch(current) });
            this.galleryDetailCache.delete(this.editingId);
        } else {
            const newP = await this.store.create({ name, description, avatar, position, depth, role, source: applySourcePatch(null) });
            await this.store.setActive(newP.id); // Auto switch to new
        }

        this.closeEdit();
        this.renderList();
        if (this.galleryPanel) this.renderGallery();
        await this.notifyPersonaChanged();
    }

    async deleteCore(deleteId, options = {}) {
        const personaId = String(deleteId || '').trim();
        const persona = personaId ? this.store.get(personaId) : null;
        if (!persona) {
            return { ok: true, deleted: false, reason: 'already_absent', personaId };
        }

        const success = await this.store.delete(personaId);
        if (!success) {
            const remaining = this.store.getAll?.() || [];
            return {
                ok: false,
                deleted: false,
                reason: remaining.length <= 1 ? 'last_persona_protected' : 'delete_failed',
                personaId,
            };
        }

        const warnings = [];
        if (options.notify !== false) {
            try {
                await this.notifyPersonaChanged();
            } catch (error) {
                warnings.push({ step: 'notify_persona_changed', message: String(error?.message || error || '') });
            }
        }
        try {
            await deletePersonaCard(window.appBridge, personaId);
        } catch (error) {
            warnings.push({ step: 'delete_persona_card', message: String(error?.message || error || '') });
        }
        if (options.cleanupBindings !== false) {
            try {
                await this.cleanupPersonaBindings(persona, options);
            } catch (error) {
                warnings.push({ step: 'cleanup_persona_bindings', message: String(error?.message || error || '') });
            }
        }
        try {
            await this.cleanupPersonaData(persona, { remainingPersonas: this.store.getAll?.() || [] });
        } catch (error) {
            warnings.push({ step: 'cleanup_persona_data', message: String(error?.message || error || '') });
        }
        return {
            ok: true,
            deleted: true,
            personaId,
            warnings,
        };
    }

    async deleteCurrent() {
        if (!this.editingId) return;
        const deleteId = String(this.editingId || '').trim();
        const persona = this.store.get(deleteId);
        const options = await this.promptDeleteOptions(persona);
        if (!options?.confirm) return;

        const result = await this.deleteCore(deleteId, options);
        if (result.deleted) {
            this.galleryDetailCache.delete(deleteId);
            this.closeEdit();
            this.renderList();
            if (this.galleryPanel) this.renderGallery();
            if (result.warnings?.length) {
                window.toastr?.warning?.('角色卡已删除，但部分绑定数据清理失败，请查看调试日志');
            }
        } else {
            alert('无法删除（至少保留一个角色卡）');
        }
    }

    async promptDeleteOptions(persona) {
        const source = (persona && typeof persona === 'object' && persona.source && typeof persona.source === 'object')
            ? persona.source
            : {};
        const worldId = String(source.worldbookId || '').trim();
        const regexSetId = String(source.regexSetId || '').trim();
        const systemPresetId = String(source.systemPresetId || '').trim();
        const scriptStore = await waitForScriptStoreReady(window.appBridge);
        let scriptCount = 0;
        try {
            if (scriptStore?.getScripts) {
                scriptCount = (scriptStore.getScripts('character', persona?.id || '') || []).length;
            }
        } catch {}
        const hasWorld = Boolean(worldId);
        const hasRegex = Boolean(regexSetId);
        const hasPreset = Boolean(systemPresetId);
        const hasScripts = scriptCount > 0;
        const preciseScopeCleanup = appSettings.get().personaBindContacts !== false;
        const otherPersonas = (this.store.getAll?.() || []).filter(item => String(item?.id || '') !== String(persona?.id || ''));
        const countOtherReferences = (key, value) => value
            ? otherPersonas.filter(item => String(item?.source?.[key] || '').trim() === value).length
            : 0;
        const sharedWorldCount = countOtherReferences('worldbookId', worldId);
        const sharedRegexCount = countOtherReferences('regexSetId', regexSetId);
        const sharedPresetCount = countOtherReferences('systemPresetId', systemPresetId);

        if (!hasWorld && !hasRegex && !hasPreset && !hasScripts && preciseScopeCleanup) {
            const ok = await appConfirm({ title: '删除角色卡', message: '确定要删除此角色卡吗？', danger: true });
            return { confirm: ok, deleteWorld: false, deleteRegex: false, deletePreset: false, deleteScripts: false };
        }

        const worldLabel = hasWorld ? worldId : '';
        let regexLabel = hasRegex ? regexSetId : '';
        try {
            await waitForRegexStoreReady(window.appBridge);
            const set = getRegexLocalSet(window.appBridge, regexSetId);
            if (set?.name) regexLabel = set.name;
        } catch {}
        let worldName = worldLabel;
        try {
            const data = await window.appBridge?.getWorldInfo?.(worldId);
            if (data?.name) worldName = data.name;
        } catch {}
        let presetName = systemPresetId;
        try {
            const presetStore = getPresetStore(window.appBridge);
            if (presetStore?.ready) await presetStore.ready;
            const preset = presetStore?.list?.('sysprompt')?.find(item => String(item?.id || '') === systemPresetId);
            if (preset?.name) presetName = preset.name;
        } catch {}
        const sharedSuffix = count => count ? `（另有 ${count} 张角色卡引用，默认保留）` : '';
        const sharedCleanupNote = preciseScopeCleanup ? '' : `
            <div style="margin-top:12px; padding:10px 12px; border-radius:10px; background:#fff7ed; color:#9a3412; font-size:12px; line-height:1.5;">
                当前联系人未按角色隔离。本次会清理角色卡文件、绑定资源、该角色的 RP 会话，以及可识别的旧残留 scope；不会删除共享聊天或共享联系人数据。
            </div>
        `;

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'app-confirm-overlay';
            overlay.style.display = 'block';
            overlay.addEventListener('click', () => cleanup(false));

            const modal = document.createElement('div');
            modal.className = 'app-confirm-modal is-danger';
            modal.style.display = 'flex';
            modal.innerHTML = `
                <div class="app-confirm-header">
                    <div class="app-confirm-title">删除角色卡</div>
                    <button type="button" class="app-confirm-close" aria-label="关闭">×</button>
                </div>
                <div class="app-confirm-body" style="text-align:left;">
                    <div style="margin-bottom:10px;">确定要删除此角色卡吗？</div>
                    <div style="display:flex; flex-direction:column; gap:8px; font-size:13px;">
                        ${hasWorld ? `
                            <label style="display:flex; align-items:center; gap:8px;">
                                <input type="checkbox" id="persona-del-world" ${sharedWorldCount ? '' : 'checked'}>
                                <span>删除绑定世界书（${worldName}）${sharedSuffix(sharedWorldCount)}</span>
                            </label>
                        ` : ''}
                        ${hasRegex ? `
                            <label style="display:flex; align-items:center; gap:8px;">
                                <input type="checkbox" id="persona-del-regex" ${sharedRegexCount ? '' : 'checked'}>
                                <span>删除绑定正则（${regexLabel}）${sharedSuffix(sharedRegexCount)}</span>
                            </label>
                        ` : ''}
                        ${hasPreset ? `
                            <label style="display:flex; align-items:center; gap:8px;">
                                <input type="checkbox" id="persona-del-preset" ${sharedPresetCount ? '' : 'checked'}>
                                <span>删除绑定系统提示预设（${presetName}）${sharedSuffix(sharedPresetCount)}</span>
                            </label>
                        ` : ''}
                        ${hasScripts ? `
                            <label style="display:flex; align-items:center; gap:8px;">
                                <input type="checkbox" id="persona-del-scripts" checked>
                                <span>删除绑定脚本（${scriptCount} 条）</span>
                            </label>
                        ` : ''}
                    </div>
                    ${sharedCleanupNote}
                </div>
                <div class="app-confirm-actions">
                    <button type="button" class="app-confirm-btn app-confirm-cancel">取消</button>
                    <button type="button" class="app-confirm-btn app-confirm-ok" data-variant="danger">删除</button>
                </div>
            `;
            modal.addEventListener('click', (event) => event.stopPropagation());

            const closeBtn = modal.querySelector('.app-confirm-close');
            const cancelBtn = modal.querySelector('.app-confirm-cancel');
            const okBtn = modal.querySelector('.app-confirm-ok');
            const worldBox = modal.querySelector('#persona-del-world');
            const regexBox = modal.querySelector('#persona-del-regex');
            const presetBox = modal.querySelector('#persona-del-preset');
            const scriptBox = modal.querySelector('#persona-del-scripts');
            if (worldBox) worldBox.checked = sharedWorldCount === 0;
            if (regexBox) regexBox.checked = sharedRegexCount === 0;
            if (presetBox) presetBox.checked = sharedPresetCount === 0;
            if (scriptBox) scriptBox.checked = true;

            const cleanup = (confirm) => {
                overlay.remove();
                modal.remove();
                resolve({
                    confirm,
                    deleteWorld: confirm && hasWorld ? Boolean(worldBox?.checked) : false,
                    deleteRegex: confirm && hasRegex ? Boolean(regexBox?.checked) : false,
                    deletePreset: confirm && hasPreset ? Boolean(presetBox?.checked) : false,
                    deleteScripts: confirm && hasScripts ? Boolean(scriptBox?.checked) : false,
                });
            };

            closeBtn?.addEventListener('click', () => cleanup(false));
            cancelBtn?.addEventListener('click', () => cleanup(false));
            okBtn?.addEventListener('click', () => cleanup(true));

            document.body.appendChild(overlay);
            document.body.appendChild(modal);
            requestAnimationFrame(() => okBtn?.focus());
        });
    }

    cleanupScopedLocalStorage(scopes = []) {
        const scopeList = Array.isArray(scopes)
            ? scopes.map(scope => String(scope || '').trim()).filter(Boolean)
            : [];
        if (!scopeList.length) return;
        const scopedKeys = [
            'contacts_store_v1',
            'contact_groups_v1',
            'chat_store_v1',
            'moments_store_v1',
            'moment_summary_store_v1',
            'rp_session_v1',
            'world_session_map_v1',
            'global_world_id_v1',
            'world_global_settings_v1',
        ];
        try {
            scopeList.forEach((scope) => {
                scopedKeys.forEach((base) => {
                    localStorage.removeItem(`${base}__${scope}`);
                });
            });
        } catch {}
    }

    collectScopedLocalStorageCandidates(keepPersonaIds = [], explicitDeleteIds = []) {
        const keepSet = new Set(
            (Array.isArray(keepPersonaIds) ? keepPersonaIds : [])
                .map(id => String(id || '').trim())
                .filter(Boolean),
        );
        return Array.from(new Set(
            (Array.isArray(explicitDeleteIds) ? explicitDeleteIds : [])
                .map(id => String(id || '').trim())
                .filter(id => id && !keepSet.has(id)),
        ));
    }

    async cleanupPersonaData(persona, { remainingPersonas = [] } = {}) {
        const personaId = String(persona?.id || '').trim();
        if (!personaId) return;

        this.cleanupSharedPersonaArtifacts(personaId);

        const keepPersonaIds = (Array.isArray(remainingPersonas) ? remainingPersonas : [])
            .map(item => String(item?.id || '').trim())
            .filter(Boolean);
        let deletedScopes = [];
        let nativeCleanupError = null;
        try {
            const result = await cleanupPersonaScopedData(window.appBridge, keepPersonaIds, [personaId]);
            deletedScopes = Array.isArray(result?.deletedScopes)
                ? result.deletedScopes.map(scope => String(scope || '').trim()).filter(Boolean)
                : [];
            if (Array.isArray(result?.failedScopes) && result.failedScopes.length) {
                nativeCleanupError = new Error(`角色资料清理失败：${result.failedScopes.map(item => item?.scope || '').filter(Boolean).join('、')}`);
            }
        } catch (error) {
            nativeCleanupError = error;
        }

        const localOnlyScopes = this.collectScopedLocalStorageCandidates(keepPersonaIds, [personaId]);
        if (localOnlyScopes.length) {
            deletedScopes = Array.from(new Set([...(deletedScopes || []), ...localOnlyScopes]));
        }

        if (!deletedScopes.length && personaId.startsWith('persona_')) {
            deletedScopes = [personaId];
        }
        this.cleanupScopedLocalStorage(deletedScopes);
        if (nativeCleanupError) throw nativeCleanupError;
    }

    cleanupSharedPersonaArtifacts(personaId) {
        const pid = String(personaId || '').trim();
        if (!pid) return;
        const rpSessionId = `rp:${pid}`;
        try {
            this.chatStore?.delete?.(rpSessionId);
        } catch {}
        try {
            const sessionIds = this.chatStore?.listSessions?.() || [];
            sessionIds.forEach((sessionId) => {
                const lockId = String(this.chatStore?.getPersonaLock?.(sessionId) || '').trim();
                if (lockId === pid) {
                    this.chatStore?.clearPersonaLock?.(sessionId);
                }
            });
        } catch {}
        try {
            deleteWorldSessionMapEntry(window.appBridge, rpSessionId);
        } catch {}
    }

    async cleanupPersonaBindings(persona, options) {
        if (!persona || typeof persona !== 'object' || !options) return;
        const source = (persona.source && typeof persona.source === 'object') ? persona.source : {};
        const worldId = String(source.worldbookId || '').trim();
        const regexSetId = String(source.regexSetId || '').trim();
        const systemPresetId = String(source.systemPresetId || '').trim();
        const failures = [];
        const runCleanup = async (label, task) => {
            try {
                await task();
            } catch (error) {
                failures.push(`${label}: ${String(error?.message || error || '未知错误')}`);
            }
        };
        if (options.deleteWorld && worldId) {
            await runCleanup('世界书', async () => {
                const result = await window.appBridge?.deleteWorldInfo?.(worldId);
                if (result?.ok === false) throw new Error('删除被拒绝');
            });
        }
        if (options.deleteRegex && regexSetId) {
            await runCleanup('正则', async () => {
                await waitForRegexStoreReady(window.appBridge);
                await removeRegexLocalSet(window.appBridge, regexSetId);
            });
        }
        if (options.deletePreset && systemPresetId) {
            await runCleanup('系统提示预设', async () => {
                const presetStore = getPresetStore(window.appBridge);
                if (presetStore?.ready) await presetStore.ready;
                if (typeof presetStore?.remove !== 'function') throw new Error('预设存储未就绪');
                await presetStore.remove('sysprompt', systemPresetId);
            });
        }
        if (options.deleteScripts) {
            await runCleanup('脚本', async () => {
                const scriptStore = await waitForScriptStoreReady(window.appBridge);
                if (typeof scriptStore?.removeScope === 'function') {
                    await scriptStore.removeScope('character', persona.id);
                } else {
                    await scriptStore?.setScripts?.('character', persona.id, []);
                }
            });
        } else {
            await runCleanup('脚本空 scope', async () => {
                const scriptStore = await waitForScriptStoreReady(window.appBridge);
                const scripts = scriptStore?.getScripts?.('character', persona.id) || [];
                if (!scripts.length && typeof scriptStore?.removeScope === 'function') {
                    await scriptStore.removeScope('character', persona.id);
                }
            });
        }
        if (failures.length) throw new Error(failures.join('；'));
    }
}
