/**
 * 世界书管理面板（简易版）
 * - 查看已保存的世界书列表（localStorage）
 * - 从 ST JSON 文本导入并保存为简化格式
 */

import { convertSTWorld } from '../storage/worldinfo.js';
import {
    getWorldbookBoundRegexSets,
    importWorldbookBoundRegexSets,
} from '../import/worldbook-bound-regex-import.js';
import { BUILTIN_PHONE_FORMAT_WORLDBOOK_ID } from '../storage/builtin-worldbooks.js';
import { logger } from '../utils/logger.js';
import { FEATHER_DEFAULT, resolveLineAvatar } from '../utils/line-avatar.js';
import { hasTauriRuntime, pickSavePath } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';
import { formatDateTime, t, translateUiText } from '../i18n/index.js';
import { WorldEditorModal } from './world-editor.js';
import { appChoice, appConfirm } from './app-confirm.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { bindCustomSelectButton, closeCustomSelectMenu, refreshCustomSelectButton } from './custom-select.js';
import { isWorldMotionReduced, setWorldDisclosureState } from './world-management-motion-utils.js';
import {
    WORLDBOOK_IMPORT_DECISIONS,
    buildWorldbookImportPlan,
} from './worldbook-import-conflict-utils.js';
import {
    listRegexLocalSets,
    syncWorldRegexBindings,
    upsertRegexLocalSet,
    waitForRegexStoreReady,
} from './regex-store-runtime-utils.js';
import { emitWorldInfoChanged, getCurrentWorldId, getGlobalWorldId, getGlobalWorldIds } from './world-session-runtime-utils.js';

const SCOPE_BADGE_STYLE = 'display:inline-flex; align-items:center; width:max-content; max-width:100%; padding:4px 8px; border:1px solid var(--app-border-default); border-radius:999px; background:var(--app-surface-subtle); color:var(--app-text-secondary); font-size:11px; line-height:1.3; cursor:help;';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}[char]));

export {
    collectWorldbookRegexSignaturesForWorld,
    getWorldbookRegexRuleSignature,
} from '../import/worldbook-bound-regex-import.js';

const normalizeWorldTarget = (value, fallbackScope = 'session') => {
    const raw = String(value || '').trim();
    if (raw === 'global') return 'global';
    if (raw === 'role') return 'role';
    if (raw === 'session_extra') return 'session_extra';
    const fallback = String(fallbackScope || '').trim();
    if (fallback === 'global') return 'global';
    if (fallback === 'role') return 'role';
    if (fallback === 'session_extra') return 'session_extra';
    return 'session_manage';
};

export const formatWorldScopeLabel = ({
    scope = 'session',
    sessionId = '',
    targetType = '',
} = {}) => {
    const sid = String(sessionId || '').trim();
    const target = normalizeWorldTarget(targetType, scope);
    if (target === 'global') return '全局世界书（所有会话共享）';
    if (target === 'role') return sid ? `角色绑定（当前会话「${sid}」）` : '角色绑定';
    if (target === 'session_extra') {
        if (sid.startsWith('rp:')) return `创意写作会话「${sid}」的专属世界书`;
        return sid ? `当前会话「${sid}」的附加世界书` : '当前会话的附加世界书';
    }
    return sid ? `当前会话「${sid}」的角色/附加世界书` : '当前会话的角色/附加世界书';
};

export const buildWorldbookImpactText = ({
    scope = 'session',
    sessionId = '',
    targetType = '',
    action = 'manage',
} = {}) => {
    const target = formatWorldScopeLabel({ scope, sessionId, targetType });
    if (action === 'bind') {
        return `影响范围：${target}。点击绑定、停用或切换会立即保存，并影响后续消息的世界书检索与提示词注入；不会改写已有聊天记录。`;
    }
    if (action === 'delete') {
        return `影响范围：${target}。删除会从世界书库移除该世界书，相关全局、角色或会话绑定可能失效；取消确认不会删除，建议先导出备份。`;
    }
    if (action === 'import') {
        return `影响范围：${target}。导入会保存为世界书；同名时必须明确确认，不会静默覆盖。如包含绑定正则，需再次确认后才会一并导入。`;
    }
    if (action === 'regex_import') {
        return `影响范围：${target}。一并导入会创建或更新正则集合，并绑定到该世界书；取消只保留世界书，不导入正则。`;
    }
    if (action === 'edit') {
        return `影响范围：${target}。编辑器内保存后才会写入世界书；关闭或取消不会保存本次未提交修改。`;
    }
    return `影响范围：${target}。世界书会参与后续消息的关键词扫描、条目注入和变量联动；关闭面板不会撤销已保存的绑定或设置。`;
};

export class WorldPanel {
    constructor({ contactsStore = null, personaStore = null, getSessionId = null } = {}) {
        this.overlay = null;
        this.panel = null;
        this.listEl = null;
        this.impactEl = null;
        this.importImpactEl = null;
        this.libraryOverlay = null;
        this.libraryModal = null;
        this.libraryListEl = null;
        this.libraryImpactEl = null;
        this.libraryToggleBtn = null;
        this.librarySearchEl = null;
        this.librarySortEl = null;
        this.librarySortButton = null;
        this.libraryResetBtn = null;
        this.librarySortDirBtn = null;
        this.globalSettingsEl = null;
        this.globalSettingsBody = null;
        this.globalSettingsToggle = null;
        this.globalScanInput = null;
        this.globalStrategySelect = null;
        this.globalStrategyButton = null;
        this.globalVariableDefineStrategySelect = null;
        this.globalVariableDefineStrategyButton = null;
        this.globalContextInput = null;
        this.globalIncludeNames = null;
        this.globalBudgetInput = null;
        this.globalMinActivationsInput = null;
        this.globalMaxDepthInput = null;
        this.globalMaxRecursionInput = null;
        this.globalRecursiveScan = null;
        this.globalCaseSensitive = null;
        this.globalMatchWholeWords = null;
        this.globalUseGroupScoring = null;
        this.globalOverflowWarning = null;
        this.globalSettingsOpen = false;
        this.fileInput = null;
        this.fileBtn = null;
        this.fileNameEl = null;
        this.scope = 'session'; // session | global
        this.contactsStore = contactsStore;
        this.personaStore = personaStore;
        this.getSessionId = typeof getSessionId === 'function' ? getSessionId : null;
        this.librarySearchTerm = '';
        this.librarySort = 'time';
        this.librarySortDir = 'desc';
        this.libraryTarget = { type: 'session_extra', sessionId: '', personaId: '' };
        this.panelCloseTimer = null;
        this.libraryCloseTimer = null;
        this.panelEntryMotionPending = false;
        this.libraryEntryMotionPending = false;
        this.editor = new WorldEditorModal({
            onSaved: async () => {
                await this.refreshList();
            }
        });
    }

    async show({ scope = 'session' } = {}) {
        this.scope = scope === 'global' ? 'global' : 'session';
        if (!this.panel) {
            this.createUI();
        }
        const wasClosing = this.panel?.classList.contains('is-closing');
        const wasVisible = this.panel?.style.display !== 'none';
        this.panelEntryMotionPending = !wasVisible || wasClosing;
        await this.refreshList();
        if (this.panelCloseTimer) {
            clearTimeout(this.panelCloseTimer);
            this.panelCloseTimer = null;
        }
        this.overlay.classList.remove('is-closing', 'is-opening');
        this.panel.classList.remove('is-closing', 'is-opening');
        this.overlay.style.display = 'block';
        this.panel.style.display = 'block';
        if ((!wasVisible || wasClosing) && !isWorldMotionReduced()) {
            this.overlay.classList.add('is-opening');
            this.panel.classList.add('is-opening');
        }
    }

    hide() {
        closeCustomSelectMenu();
        this.closeLibraryModal?.();
        if (!this.overlay || !this.panel || this.panel.style.display === 'none') return;
        if (this.panel.classList.contains('is-closing')) return;

        const finish = () => {
            this.panelCloseTimer = null;
            this.overlay.style.display = 'none';
            this.panel.style.display = 'none';
            this.overlay.classList.remove('is-opening', 'is-closing');
            this.panel.classList.remove('is-opening', 'is-closing');
        };
        if (isWorldMotionReduced()) {
            finish();
            return;
        }
        this.overlay.classList.remove('is-opening');
        this.panel.classList.remove('is-opening');
        this.overlay.classList.add('is-closing');
        this.panel.classList.add('is-closing');
        this.panelCloseTimer = setTimeout(finish, 220);
    }

    buildToggle({ enabled, disabled = false, labelOn = '已启用', labelOff = '未启用', onClick } = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sticker-ai-toggle';
        btn.disabled = Boolean(disabled);
        btn.classList.toggle('is-enabled', Boolean(enabled) && !disabled);
        btn.classList.toggle('is-disabled', !enabled || disabled);
        btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
        btn.style.opacity = disabled ? '0.7' : '1';
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        btn.innerHTML = `<span class="sticker-ai-dot"></span><span>${enabled ? labelOn : labelOff}</span>`;
        btn.onclick = () => {
            if (btn.disabled) return;
            onClick?.();
        };
        return btn;
    }

    getActiveSessionKey(fallback = '') {
        return String(
            fallback
            || this.getSessionId?.()
            || window.appBridge?.getActiveSessionId?.()
            || 'default',
        ).trim() || 'default';
    }

    // 把内部会话 ID（如 rp:persona_xxx）解析为用户可读的名称（角色卡/联系人名），显示层统一用这个。
    resolveSessionDisplayName(sessionId = '') {
        const raw = String(sessionId || '').trim();
        if (!raw) return raw;
        const contactName = String(this.contactsStore?.getContact?.(raw)?.name || '').trim();
        if (contactName && !contactName.startsWith('rp:')) return contactName;
        if (raw.startsWith('rp:')) {
            const personaName = String(this.personaStore?.get?.(raw.slice(3))?.name || '').trim();
            if (personaName) return personaName;
        }
        return raw;
    }

    setImpactText(action = 'manage', { sessionId = '', targetType = '' } = {}) {
        const sid = this.getActiveSessionKey(sessionId);
        const base = {
            scope: this.scope,
            sessionId: this.resolveSessionDisplayName(sid),
            targetType,
        };
        if (this.impactEl) {
            const impactText = buildWorldbookImpactText({
                ...base,
                action,
            });
            this.impactEl.textContent = t('作用域：{scope}', {
                scope: translateUiText(formatWorldScopeLabel(base)),
            });
            this.impactEl.setAttribute('data-i18n-skip', '');
            this.impactEl.title = impactText;
            this.impactEl.setAttribute('aria-label', impactText);
        }
        if (this.importImpactEl) {
            const impactText = buildWorldbookImpactText({
                ...base,
                action: 'import',
            });
            this.importImpactEl.textContent = t('作用域：{scope}', {
                scope: translateUiText(formatWorldScopeLabel(base)),
            });
            this.importImpactEl.setAttribute('data-i18n-skip', '');
            this.importImpactEl.title = impactText;
            this.importImpactEl.setAttribute('aria-label', impactText);
        }
    }

    setLibraryImpactText(action = 'bind', target = this.libraryTarget) {
        if (!this.libraryImpactEl) return;
        const normalizedTarget = this.normalizeLibraryTarget(target);
        const base = {
            scope: normalizedTarget.type,
            sessionId: this.resolveSessionDisplayName(normalizedTarget.sessionId),
            targetType: normalizedTarget.type,
        };
        const impactText = buildWorldbookImpactText({ ...base, action });
        this.libraryImpactEl.textContent = t('作用域：{scope}', {
            scope: translateUiText(formatWorldScopeLabel(base)),
        });
        this.libraryImpactEl.setAttribute('data-i18n-skip', '');
        this.libraryImpactEl.title = impactText;
        this.libraryImpactEl.setAttribute('aria-label', impactText);
    }

    sanitizeExportName(name, fallback = 'worldbook') {
        const raw = String(name || '').trim();
        const safe = raw.replace(/[\\/:*?"<>|]+/g, '_').trim();
        return safe || fallback;
    }

    async downloadJson(payload, filename) {
        const json = JSON.stringify(payload, null, 2);
        if (hasTauriRuntime()) {
            const pick = await pickSavePath({
                defaultName: filename || 'worldbook.json',
                filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (pick.cancelled) return false;
            const bytes = new TextEncoder().encode(json);
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            const dataUrl = `data:application/json;base64,${btoa(binary)}`;
            if (pick.fallback) {
                await safeInvoke('export_attachment', { dataUrl, fileName: filename || 'worldbook.json' });
            } else {
                await safeInvoke('export_attachment', { dataUrl, fileName: filename || 'worldbook.json', path: pick.path });
            }
            return true;
        }
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'worldbook.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return true;
    }

    async resolveWorldEntries(data, { worldId = '' } = {}) {
        const localEntries = Array.isArray(data?.localEntries)
            ? data.localEntries
            : (Array.isArray(data?.entries) ? data.entries : []);
        const refs = Array.isArray(data?.refs) ? data.refs : [];
        if (!refs.length) return localEntries;
        const results = [...localEntries];
        const cache = new Map();
        for (const raw of refs) {
            const ref = raw && typeof raw === 'object' ? raw : {};
            const sourceId = String(ref.sourceId || ref.worldId || ref.source || '').trim();
            if (!sourceId) continue;
            if (!cache.has(sourceId)) {
                let sourceData = null;
                try {
                    sourceData = await window.appBridge?.getWorldInfo?.(sourceId);
                } catch {}
                cache.set(sourceId, sourceData || null);
            }
            const sourceData = cache.get(sourceId);
            const sourceEntries = Array.isArray(sourceData?.entries) ? sourceData.entries : [];
            if (!sourceEntries.length) continue;
            const entryIdRaw = String(ref.entryId || ref.entry || '').trim();
            const entryIds = Array.isArray(ref.entryIds)
                ? ref.entryIds.map(val => String(val || '').trim()).filter(Boolean)
                : [];
            const includeAll = ref.includeAll === true || ref.all === true || entryIdRaw === '*' || entryIds.includes('*');
            const idSet = new Set(entryIds);
            if (entryIdRaw) idSet.add(entryIdRaw);
            sourceEntries.forEach((entry, idx) => {
                if (!entry) return;
                const entryId = String(entry?.id ?? entry?.uid ?? '').trim();
                if (!includeAll && (!entryId || !idSet.has(entryId))) return;
                results.push({
                    ...entry,
                    _refSourceId: sourceId,
                    _refWorldId: String(worldId || '').trim(),
                    _refEntryId: entryId || `entry-${idx}`,
                    _refEntryIndex: idx,
                });
            });
        }
        return results;
    }

    normalizeLibraryTarget(target = null) {
        const raw = target && typeof target === 'object' ? target : {};
        const type = ['global', 'session_extra', 'role'].includes(String(raw.type || '').trim())
            ? String(raw.type || '').trim()
            : (this.scope === 'global' ? 'global' : 'session_extra');
        return {
            type,
            sessionId: String(raw.sessionId || this.getSessionId?.() || window.appBridge?.getActiveSessionId?.() || '').trim(),
            personaId: String(raw.personaId || '').trim(),
        };
    }

    getRoleBindings(sessionId = '', options = {}) {
        const list = window.appBridge?.getRoleWorldBindings?.(sessionId, options) || [];
        return Array.isArray(list) ? list : [];
    }

    async refreshList() {
        if (!this.listEl) return;
        this.listEl.innerHTML = '';
        const animatePanelRows = this.panelEntryMotionPending;
        this.panelEntryMotionPending = false;
        let panelMotionIndex = 0;
        try {
            const sessionId = this.getSessionId ? this.getSessionId() : (window.appBridge?.getActiveSessionId?.() || 'default');
            const sessionKey = String(sessionId || 'default').trim() || 'default';
            const contact = this.contactsStore?.getContact?.(sessionKey) || null;
            const isRpSession = sessionKey.startsWith('rp:');
            const isGroupSession = this.scope === 'session' && (Boolean(contact?.isGroup) || sessionKey.startsWith('group:'));
            const listTitle = this.panel?.querySelector('#world-list-title');
            const newBtn = this.panel?.querySelector('#world-new');
            const indicator = this.panel?.querySelector('#world-current');
            const buildToggle = (opts) => this.buildToggle(opts);
            this.setImpactText('manage', {
                sessionId: sessionKey,
                targetType: this.scope === 'global' ? 'global' : 'session_manage',
            });
            const visibleSessionIds = (window.appBridge?.getWorldIdsForSession?.(sessionKey) || []).filter((id) => id !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);
            const normalizedGlobalIds = getGlobalWorldIds(window.appBridge)
                .filter((id) => id !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);
            const roleBindings = this.getRoleBindings(sessionKey, { includeEmpty: true })
                .filter((item) => item?.hasWorld || item?.isActive);
            const activeRoleBindings = roleBindings.filter((item) => item?.isActive);
            const activeRoleIds = activeRoleBindings
                .filter((item) => item?.enabled !== false)
                .map((item) => String(item?.worldId || '').trim())
                .filter(Boolean);
            const roleSummary = activeRoleIds.length ? activeRoleIds.join(' + ') : '未启用';

            if (listTitle) {
                listTitle.textContent = this.scope === 'global' ? '全局世界书' : '角色与聊天室世界书';
            }
            if (this.globalSettingsEl) {
                this.globalSettingsEl.style.display = this.scope === 'global' ? '' : 'none';
            }

            const defaultLibraryTarget = this.normalizeLibraryTarget(
                this.scope === 'global'
                    ? { type: 'global' }
                    : { type: 'session_extra', sessionId: sessionKey },
            );
            const keepLibraryTarget = Boolean(this.libraryOverlay?.classList.contains('is-active') && this.libraryTarget?.type);
            this.libraryTarget = this.normalizeLibraryTarget(keepLibraryTarget ? this.libraryTarget : defaultLibraryTarget);

            if (newBtn) {
                if (this.scope === 'global') {
                    newBtn.style.display = '';
                    newBtn.textContent = '新增全局';
                } else if (!isGroupSession) {
                    newBtn.style.display = '';
                    newBtn.textContent = isRpSession ? '新增创作专属' : '新增附加';
                } else {
                    newBtn.style.display = 'none';
                }
            }
            if (this.libraryToggleBtn) {
                if (this.scope === 'global') {
                    this.libraryToggleBtn.style.display = '';
                    this.libraryToggleBtn.textContent = '全局世界书库';
                } else if (!isGroupSession) {
                    this.libraryToggleBtn.style.display = '';
                    this.libraryToggleBtn.textContent = isRpSession ? '创作世界书库' : '附加世界书库';
                } else {
                    this.libraryToggleBtn.style.display = 'none';
                }
            }

            if (this.scope === 'global') {
                const settings = window.appBridge?.getWorldGlobalSettings?.() || {};
                const scanDepth = Number.isFinite(Number(settings.scanDepth)) ? Number(settings.scanDepth) : '';
                if (this.globalScanInput) this.globalScanInput.value = scanDepth === '' ? '' : String(scanDepth);
                const contextPercent = Number.isFinite(Number(settings.contextPercent)) ? Number(settings.contextPercent) : '';
                if (this.globalContextInput) this.globalContextInput.value = contextPercent === '' ? '' : String(contextPercent);
                const budgetCap = Number.isFinite(Number(settings.budgetCap)) ? Number(settings.budgetCap) : '';
                if (this.globalBudgetInput) this.globalBudgetInput.value = budgetCap === '' ? '' : String(budgetCap);
                const minActivations = Number.isFinite(Number(settings.minActivations)) ? Number(settings.minActivations) : '';
                if (this.globalMinActivationsInput) this.globalMinActivationsInput.value = minActivations === '' ? '' : String(minActivations);
                const maxDepth = Number.isFinite(Number(settings.maxDepth)) ? Number(settings.maxDepth) : '';
                if (this.globalMaxDepthInput) this.globalMaxDepthInput.value = maxDepth === '' ? '' : String(maxDepth);
                const maxRecursion = Number.isFinite(Number(settings.maxRecursionSteps)) ? Number(settings.maxRecursionSteps) : '';
                if (this.globalMaxRecursionInput) this.globalMaxRecursionInput.value = maxRecursion === '' ? '' : String(maxRecursion);
                const strategy = String(settings.insertionStrategy || 'role_first');
                if (this.globalStrategySelect) {
                    this.globalStrategySelect.value = strategy;
                    if (this.globalStrategyButton) {
                        refreshCustomSelectButton(this.globalStrategyButton, this.globalStrategySelect, '角色世界书优先');
                    }
                }
                const strategyRaw = String(settings.variableDefineStrategy || 'legacy_eager');
                const variableDefineStrategy = ['legacy_eager', 'first_hit', 'off'].includes(strategyRaw)
                    ? strategyRaw
                    : 'legacy_eager';
                if (this.globalVariableDefineStrategySelect) {
                    this.globalVariableDefineStrategySelect.value = variableDefineStrategy;
                    if (this.globalVariableDefineStrategyButton) {
                        refreshCustomSelectButton(this.globalVariableDefineStrategyButton, this.globalVariableDefineStrategySelect, '请求前自动建立（旧行为）');
                    }
                }
                if (this.globalIncludeNames) this.globalIncludeNames.checked = settings.includeNames === true;
                if (this.globalRecursiveScan) this.globalRecursiveScan.checked = settings.recursiveScan !== false;
                if (this.globalCaseSensitive) this.globalCaseSensitive.checked = settings.caseSensitive === true;
                if (this.globalMatchWholeWords) this.globalMatchWholeWords.checked = settings.matchWholeWords === true;
                if (this.globalUseGroupScoring) this.globalUseGroupScoring.checked = settings.useGroupScoring === true;
                if (this.globalOverflowWarning) this.globalOverflowWarning.checked = settings.alertOnOverflow === true;
            }

            if (indicator) {
                let indicatorText = '';
                if (this.scope === 'global') {
                    indicatorText = t('全局当前：{value}', {
                        value: normalizedGlobalIds.length
                            ? normalizedGlobalIds.join(' + ')
                            : translateUiText('未启用'),
                    });
                } else if (isGroupSession) {
                    indicatorText = t('群聊 {name}：角色 {role} / 成员附加自动合并', {
                        name: contact?.name || sessionKey,
                        role: roleSummary === '未启用' ? translateUiText(roleSummary) : roleSummary,
                    });
                } else if (isRpSession) {
                    const extrasLabel = visibleSessionIds.length ? visibleSessionIds.join(' + ') : '未启用';
                    indicatorText = t('创意写作会话：角色 {role} / 创作专属 {extras}', {
                        role: roleSummary === '未启用' ? translateUiText(roleSummary) : roleSummary,
                        extras: extrasLabel === '未启用' ? translateUiText(extrasLabel) : extrasLabel,
                    });
                } else {
                    const extrasLabel = visibleSessionIds.length ? visibleSessionIds.join(' + ') : '未启用';
                    indicatorText = t('私聊 {name}：角色 {role} / 附加 {extras}', {
                        name: contact?.name || sessionKey,
                        role: roleSummary === '未启用' ? translateUiText(roleSummary) : roleSummary,
                        extras: extrasLabel === '未启用' ? translateUiText(extrasLabel) : extrasLabel,
                    });
                }
                indicator.textContent = indicatorText;
                indicator.setAttribute('data-i18n-skip', '');
            }

            const names = await window.appBridge.listWorlds?.();
            const visibleNames = (names || []).filter((name) => name !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);
            const worldDataCache = new Map();
            const getWorldData = async (worldId) => {
                const key = String(worldId || '').trim();
                if (!key) return null;
                if (worldDataCache.has(key)) return worldDataCache.get(key);
                let data = null;
                try {
                    data = await window.appBridge.getWorldInfo(key);
                } catch {}
                worldDataCache.set(key, data || null);
                return data || null;
            };
            const appendEmpty = (container, text) => {
                const empty = document.createElement('div');
                empty.textContent = text;
                empty.style.cssText = 'font-size:12px; color:var(--app-text-muted); padding:6px 0;';
                container.appendChild(empty);
            };
            const createTextButton = (label, variant = 'neutral') => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `world-panel-inline-btn world-panel-inline-btn-${variant}`;
                const palette = variant === 'danger'
                    ? 'border:1px solid #fecaca;background:var(--app-surface-card);color:#b91c1c;'
                    : variant === 'primary'
                        ? 'border:1px solid rgba(14,116,144,0.18);background:#ecfeff;color:#0f766e;'
                        : 'border:1px solid var(--app-border-default);background:var(--app-surface-card);color:var(--app-text-primary);';
                btn.style.cssText = `padding:4px 8px;border-radius:999px;font-size:12px;cursor:pointer;${palette}`;
                btn.textContent = label;
                return btn;
            };
            const createSection = ({ title, description = '' } = {}) => {
                const host = document.createElement('li');
                host.className = 'world-panel-section-item';
                host.style.listStyle = 'none';
                host.style.marginBottom = '10px';

                const box = document.createElement('div');
                box.className = 'world-panel-section-card';
                box.style.cssText = 'padding:12px; border:1px solid var(--app-border-default); border-radius:14px; background:linear-gradient(180deg, var(--app-surface-card) 0%, var(--app-surface-subtle) 100%);';

                const header = document.createElement('div');
                header.className = 'world-panel-section-head';
                header.style.cssText = 'display:flex; align-items:flex-start; justify-content:space-between; gap:12px;';

                const titleWrap = document.createElement('div');
                titleWrap.className = 'world-panel-section-copy';
                const titleEl = document.createElement('div');
                titleEl.className = 'world-panel-section-title';
                titleEl.textContent = title;
                titleEl.style.cssText = 'font-weight:800; color:var(--app-text-primary);';
                // 说明搬进 data-help：桌面 hover、手机点一下浮现（标题非交互，用 tap 触发）
                if (description) {
                    titleEl.setAttribute('data-help', description);
                    titleEl.classList.add('has-help');
                }
                titleWrap.appendChild(titleEl);

                const actions = document.createElement('div');
                actions.className = 'world-panel-section-actions';
                actions.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end;';

                const body = document.createElement('div');
                body.className = 'world-panel-section-body';
                body.style.cssText = 'margin-top:10px; display:flex; flex-direction:column; gap:8px;';

                header.appendChild(titleWrap);
                header.appendChild(actions);
                box.appendChild(header);
                box.appendChild(body);
                host.appendChild(box);
                this.listEl.appendChild(host);
                return { host, box, body, actions };
            };
            const confirmDeleteWorld = async (worldId, displayName) => {
                const ok = await appConfirm({
                    title: '删除世界书',
                    message: `确定要删除世界书「${displayName || worldId}」吗？此操作不可恢复。\n\n${buildWorldbookImpactText({
                        scope: this.scope,
                        sessionId: this.resolveSessionDisplayName(sessionKey),
                        targetType: this.scope === 'global' ? 'global' : 'session_manage',
                        action: 'delete',
                    })}`,
                    danger: true,
                });
                if (!ok) return false;
                const result = await window.appBridge.deleteWorldInfo(worldId, {
                    expectedExists: true,
                    conflictMode: 'return',
                });
                if (result?.ok === false) {
                    window.toastr?.warning?.('世界书已不存在或状态已变化，请刷新后重试');
                    return false;
                }
                window.toastr?.success('已删除世界书');
                await this.refreshList();
                return true;
            };
            const buildWorldCard = async (worldId, {
                subtitle = '',
                toggleEnabled = true,
                toggleLabelOn = '已启用',
                toggleLabelOff = '未启用',
                onToggle = null,
                extraButtons = [],
            } = {}) => {
                const worldData = await getWorldData(worldId);
                const displayName = worldData?.name || worldId;
                const card = document.createElement('div');
                card.className = 'world-panel-world-card';
                card.style.cssText = 'padding:10px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-card);';
                if (animatePanelRows) {
                    card.classList.add('is-entering');
                    card.style.setProperty('--world-motion-order', String(Math.min(panelMotionIndex, 8)));
                    panelMotionIndex += 1;
                }

                const header = document.createElement('div');
                header.className = 'world-panel-world-card-head';
                header.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

                const titleWrap = document.createElement('div');
                titleWrap.className = 'world-panel-world-card-copy';
                titleWrap.style.cssText = 'display:flex; flex-direction:column; gap:2px; min-width:0; flex:1;';
                const title = document.createElement('button');
                title.type = 'button';
                title.className = 'world-panel-world-card-title';
                title.setAttribute('data-i18n-skip', '');
                title.textContent = displayName;
                title.style.cssText = 'padding:0; border:none; background:none; text-align:left; font-weight:700; color:var(--app-text-primary); cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
                const meta = document.createElement('div');
                meta.className = 'world-panel-world-card-meta';
                meta.setAttribute('data-i18n-skip', '');
                meta.textContent = translateUiText(subtitle || '点击标题展开条目');
                meta.style.cssText = 'font-size:12px; color:var(--app-text-muted);';
                titleWrap.appendChild(title);
                titleWrap.appendChild(meta);

                const actions = document.createElement('div');
                actions.className = 'world-panel-world-card-actions';
                actions.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-start;';

                // 启用/禁用放最前并加显著（尺寸不变）；删除/解绑收进「更换」（世界书库）里操作。
                if (typeof onToggle === 'function') {
                    const toggle = buildToggle({
                        enabled: Boolean(toggleEnabled),
                        labelOn: toggleLabelOn,
                        labelOff: toggleLabelOff,
                        onClick: () => onToggle(),
                    });
                    toggle.style.fontWeight = '700';
                    actions.appendChild(toggle);
                }
                const editBtn = createTextButton('编辑');
                editBtn.onclick = async (event) => {
                    event.stopPropagation();
                    await this.openEditor(worldId);
                };
                actions.appendChild(editBtn);
                (Array.isArray(extraButtons) ? extraButtons : []).forEach((btn) => {
                    if (btn) actions.appendChild(btn);
                });

                const entriesWrap = document.createElement('div');
                entriesWrap.className = 'world-panel-world-card-entries';
                entriesWrap.style.cssText = 'display:none; overflow:hidden;';
                const entriesInner = document.createElement('div');
                entriesInner.className = 'world-panel-world-card-entries-inner';
                entriesInner.style.cssText = 'margin-top:8px; padding-top:8px; border-top:1px dashed var(--app-border-default); max-height:220px; overflow:auto;';
                entriesWrap.appendChild(entriesInner);
                let entriesLoaded = false;

                const renderEntries = async () => {
                    if (entriesLoaded) return;
                    entriesLoaded = true;
                    try {
                        const latest = await getWorldData(worldId);
                        const entries = latest ? await this.resolveWorldEntries(latest, { worldId }) : [];
                        meta.textContent = translateUiText(latest ? `共 ${entries.length} 条目${subtitle ? ` · ${subtitle}` : ''}` : '世界书不存在或已删除');
                        if (!entries.length) {
                            appendEmpty(entriesInner, latest ? '（无条目）' : '（无法读取条目）');
                            return;
                        }
                        entries.forEach((entry, idx) => {
                            const row = document.createElement('div');
                            row.className = 'world-panel-world-entry-row';
                            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0;';
                            const label = String(entry?.comment || entry?.title || entry?.id || `entry-${idx}`);
                            const nameEl = document.createElement('div');
                            nameEl.className = 'world-panel-world-entry-name';
                            nameEl.setAttribute('data-i18n-skip', '');
                            nameEl.textContent = label;
                            nameEl.style.cssText = `font-size:12px; color:${entry?.disable ? 'var(--app-text-muted)' : 'var(--app-text-primary)'}; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;
                            const entryToggle = buildToggle({
                                enabled: !entry?.disable,
                                labelOn: '已启用',
                                labelOff: '未启用',
                                onClick: async () => {
                                    const targetWorldId = entry?._refSourceId || worldId;
                                    const latestWorld = await window.appBridge.getWorldInfo(targetWorldId);
                                    if (!latestWorld || !Array.isArray(latestWorld.entries)) {
                                        window.toastr?.warning?.('世界书不存在或已删除');
                                        return;
                                    }
                                    const targetId = String(entry?._refEntryId ?? entry?.id ?? entry?.uid ?? '').trim();
                                    const fallbackIndex = Number.isFinite(Number(entry?._refEntryIndex)) ? Number(entry._refEntryIndex) : idx;
                                    let updated = false;
                                    const nextEntries = latestWorld.entries.map((item) => {
                                        const itemId = String(item?.id ?? item?.uid ?? '').trim();
                                        if (targetId && itemId === targetId) {
                                            updated = true;
                                            return { ...item, disable: !item?.disable };
                                        }
                                        return item;
                                    });
                                    if (!updated && fallbackIndex >= 0 && fallbackIndex < latestWorld.entries.length) {
                                        nextEntries[fallbackIndex] = { ...latestWorld.entries[fallbackIndex], disable: !latestWorld.entries[fallbackIndex]?.disable };
                                        updated = true;
                                    }
                                    if (!updated) {
                                        window.toastr?.warning?.('未找到要更新的条目');
                                        return;
                                    }
                                    await window.appBridge.saveWorldInfo(targetWorldId, { ...latestWorld, entries: nextEntries });
                                    entry.disable = !entry?.disable;
                                    nameEl.style.color = entry?.disable ? 'var(--app-text-muted)' : 'var(--app-text-primary)';
                                    entryToggle.classList.toggle('is-enabled', !entry?.disable);
                                    entryToggle.classList.toggle('is-disabled', Boolean(entry?.disable));
                                    entryToggle.setAttribute('aria-pressed', entry?.disable ? 'false' : 'true');
                                    const labelEl = entryToggle.querySelector('span:last-child');
                                    if (labelEl) labelEl.textContent = entry?.disable ? '未启用' : '已启用';
                                    window.toastr?.success(entry?.disable ? '条目已停用' : '条目已启用');
                                },
                            });
                            row.appendChild(nameEl);
                            row.appendChild(entryToggle);
                            entriesInner.appendChild(row);
                        });
                    } catch (err) {
                        meta.textContent = '条目读取失败';
                        appendEmpty(entriesInner, '（读取条目失败）');
                    }
                };

                title.setAttribute('aria-expanded', 'false');
                title.onclick = async (event) => {
                    event.stopPropagation();
                    const shouldOpen = !entriesWrap.classList.contains('is-open');
                    entriesWrap.classList.toggle('is-open', shouldOpen);
                    title.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
                    if (shouldOpen) {
                        await renderEntries();
                        if (!entriesWrap.classList.contains('is-open')) return;
                    }
                    setWorldDisclosureState(entriesWrap, shouldOpen, { duration: 320 });
                };

                header.appendChild(titleWrap);
                header.appendChild(actions);
                card.appendChild(header);
                card.appendChild(entriesWrap);
                return card;
            };

            if (this.scope === 'global') {
                const globalSection = createSection({
                    title: '全局世界书',
                    description: '全局世界书在聊天界面与创意写作界面共用，深度和预算配置由下面的全局设置统一控制。',
                });
                if (!normalizedGlobalIds.length) {
                    appendEmpty(globalSection.body, '尚未启用全局世界书。');
                } else {
                    for (const worldId of normalizedGlobalIds) {
                        const card = await buildWorldCard(worldId, {
                            subtitle: '聊天 / 创意写作共用',
                            onToggle: async () => {
                                await window.appBridge.setGlobalWorldIds(
                                    normalizedGlobalIds.filter((id) => id !== worldId),
                                );
                                window.toastr?.success?.('已停用全局世界书');
                                await this.refreshList();
                            },
                        });
                        globalSection.body.appendChild(card);
                    }
                }
            } else if (isGroupSession) {
                const roleSection = createSection({
                    title: '角色世界书',
                    description: '当前角色卡的角色世界书在聊天界面与创意写作界面共用。',
                });
                const activeEmptyBinding = roleBindings.find((item) => item?.isActive && !item?.hasWorld);
                if (activeEmptyBinding) {
                    const newRoleBtn = createTextButton('为当前角色新建', 'primary');
                    newRoleBtn.onclick = async () => {
                        await this.onNewWorld({ target: { type: 'role', personaId: activeEmptyBinding.personaId, sessionId: sessionKey } });
                    };
                    const roleLibraryBtn = createTextButton('角色世界书库');
                    roleLibraryBtn.onclick = () => this.openLibraryModal({ type: 'role', personaId: activeEmptyBinding.personaId, sessionId: sessionKey });
                    roleSection.actions.appendChild(newRoleBtn);
                    roleSection.actions.appendChild(roleLibraryBtn);
                }
                if (!roleBindings.length) {
                    appendEmpty(roleSection.body, '当前角色卡没有角色世界书绑定。');
                } else {
                    for (const binding of roleBindings) {
                        if (!binding?.hasWorld) {
                            const row = document.createElement('div');
                            row.className = 'world-panel-empty-bind-row';
                            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px; border:1px dashed var(--app-border-default); border-radius:12px; background:var(--app-surface-card);';
                            const info = document.createElement('div');
                            info.className = 'world-panel-empty-bind-copy';
                            info.style.cssText = 'min-width:0; flex:1;';
                            info.innerHTML = `
                                <div style="font-weight:700; color:var(--app-text-primary);"><span data-i18n-skip>${escapeHtml(binding.personaName)}</span><span> · 当前角色卡</span></div>
                                <div style="font-size:12px; color:var(--app-text-muted); margin-top:2px;">未绑定角色世界书</div>
                            `;
                            const actions = document.createElement('div');
                            actions.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;';
                            const newBtnRole = createTextButton('新建', 'primary');
                            newBtnRole.onclick = async () => {
                                await this.onNewWorld({ target: { type: 'role', personaId: binding.personaId, sessionId: sessionKey } });
                            };
                            const pickBtn = createTextButton('书库');
                            pickBtn.onclick = () => this.openLibraryModal({ type: 'role', personaId: binding.personaId, sessionId: sessionKey });
                            actions.appendChild(newBtnRole);
                            actions.appendChild(pickBtn);
                            row.appendChild(info);
                            row.appendChild(actions);
                            roleSection.body.appendChild(row);
                            continue;
                        }
                        const chooseBtn = createTextButton('更换');
                        chooseBtn.onclick = (event) => {
                            event.stopPropagation();
                            this.openLibraryModal({ type: 'role', personaId: binding.personaId, sessionId: sessionKey });
                        };
                        const card = await buildWorldCard(binding.worldId, {
                            subtitle: `角色：${binding.personaName} · 当前角色卡`,
                            toggleEnabled: binding.enabled !== false,
                            toggleLabelOn: '已启用',
                            toggleLabelOff: '已停用',
                            onToggle: async () => {
                                await window.appBridge?.setRoleWorldEnabled?.(binding.personaId, binding.enabled === false);
                                window.toastr?.success?.(binding.enabled === false ? '已启用角色世界书' : '已停用角色世界书');
                                await this.refreshList();
                            },
                            extraButtons: [chooseBtn],
                        });
                        roleSection.body.appendChild(card);
                    }
                }
                const memberSection = createSection({
                    title: '成员聊天室附加世界书',
                    description: '群聊会自动合并群成员各自私聊中的附加世界书；只在包含该成员的群聊中生效。',
                });
                const members = Array.isArray(contact?.members) ? contact.members : [];
                if (!members.length) {
                    appendEmpty(memberSection.body, '当前群聊没有成员。');
                } else {
                    members.forEach((mid) => {
                        const memberId = String(mid || '').trim();
                        if (!memberId) return;
                        const memberContact = this.contactsStore?.getContact?.(memberId) || null;
                        const name = memberContact?.name || memberId;
                        const tags = Array.isArray(memberContact?.libraryTags) && memberContact.libraryTags.length
                            ? memberContact.libraryTags
                            : Array.isArray(memberContact?.labels) ? memberContact.labels : [];
                        const avatar = resolveLineAvatar({
                            avatar: memberContact?.avatar || FEATHER_DEFAULT,
                            name,
                            tags,
                            size: 96,
                        });
                        const bound = (window.appBridge?.getWorldIdsForSession?.(memberId) || []).filter((id) => id !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);

                        const row = document.createElement('div');
                        row.className = 'world-panel-member-row';
                        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-card);';
                        row.innerHTML = `
                            <img src="${avatar}" alt="" style="width:34px; height:34px; border-radius:50%; object-fit:cover;">
                            <div style="flex:1; min-width:0;">
                                <div style="font-weight:700; color:var(--app-text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</div>
                                <div style="font-size:12px; color:${bound.length ? 'var(--app-text-secondary)' : 'var(--app-text-muted)'}; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    ${bound.length ? `已绑定：${bound.join(' + ')}` : '未设置成员附加世界书'}
                                </div>
                            </div>
                        `;
                        const actions = document.createElement('div');
                        actions.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;';
                        const chooseBtn = createTextButton(bound.length ? '更换' : '绑定');
                        chooseBtn.onclick = () => this.openLibraryModal({ type: 'session_extra', sessionId: memberId });
                        const offBtn = createTextButton('清空', 'danger');
                        offBtn.disabled = !bound.length;
                        offBtn.style.opacity = offBtn.disabled ? '0.55' : '1';
                        offBtn.style.cursor = offBtn.disabled ? 'not-allowed' : 'pointer';
                        offBtn.onclick = async () => {
                            if (offBtn.disabled) return;
                            window.appBridge?.setSessionWorldIds?.(memberId, [], { silent: true });
                            syncWorldRegexBindings(window.appBridge);
                            emitWorldInfoChanged(window.appBridge, { sessionId: sessionKey });
                            window.toastr?.success?.('已清空成员附加世界书');
                            await this.refreshList();
                        };
                        actions.appendChild(chooseBtn);
                        actions.appendChild(offBtn);
                        row.appendChild(actions);
                        memberSection.body.appendChild(row);
                    });
                }
            } else {
                const roleSection = createSection({
                    title: '角色世界书',
                    description: '当前角色卡的角色世界书在聊天界面与创意写作界面共用。',
                });
                const activeEmptyBinding = roleBindings.find((item) => item?.isActive && !item?.hasWorld);
                if (activeEmptyBinding) {
                    const newRoleBtn = createTextButton('为当前角色新建', 'primary');
                    newRoleBtn.onclick = async () => {
                        await this.onNewWorld({ target: { type: 'role', personaId: activeEmptyBinding.personaId, sessionId: sessionKey } });
                    };
                    const roleLibraryBtn = createTextButton('角色世界书库');
                    roleLibraryBtn.onclick = () => this.openLibraryModal({ type: 'role', personaId: activeEmptyBinding.personaId, sessionId: sessionKey });
                    roleSection.actions.appendChild(newRoleBtn);
                    roleSection.actions.appendChild(roleLibraryBtn);
                }
                if (!roleBindings.length) {
                    appendEmpty(roleSection.body, '当前角色卡没有角色世界书绑定。');
                } else {
                    for (const binding of roleBindings) {
                        if (!binding?.hasWorld) {
                            const row = document.createElement('div');
                            row.className = 'world-panel-empty-bind-row';
                            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px; border:1px dashed var(--app-border-default); border-radius:12px; background:var(--app-surface-card);';
                            const info = document.createElement('div');
                            info.className = 'world-panel-empty-bind-copy';
                            info.style.cssText = 'min-width:0; flex:1;';
                            info.innerHTML = `
                                <div style="font-weight:700; color:var(--app-text-primary);"><span data-i18n-skip>${escapeHtml(binding.personaName)}</span><span> · 当前角色卡</span></div>
                                <div style="font-size:12px; color:var(--app-text-muted); margin-top:2px;">未绑定角色世界书</div>
                            `;
                            const actions = document.createElement('div');
                            actions.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;';
                            const newBtnRole = createTextButton('新建', 'primary');
                            newBtnRole.onclick = async () => {
                                await this.onNewWorld({ target: { type: 'role', personaId: binding.personaId, sessionId: sessionKey } });
                            };
                            const pickBtn = createTextButton('书库');
                            pickBtn.onclick = () => this.openLibraryModal({ type: 'role', personaId: binding.personaId, sessionId: sessionKey });
                            actions.appendChild(newBtnRole);
                            actions.appendChild(pickBtn);
                            row.appendChild(info);
                            row.appendChild(actions);
                            roleSection.body.appendChild(row);
                            continue;
                        }
                        const chooseBtn = createTextButton('更换');
                        chooseBtn.onclick = (event) => {
                            event.stopPropagation();
                            this.openLibraryModal({ type: 'role', personaId: binding.personaId, sessionId: sessionKey });
                        };
                        const card = await buildWorldCard(binding.worldId, {
                            subtitle: `角色：${binding.personaName} · 当前角色卡`,
                            toggleEnabled: binding.enabled !== false,
                            toggleLabelOn: '已启用',
                            toggleLabelOff: '已停用',
                            onToggle: async () => {
                                await window.appBridge?.setRoleWorldEnabled?.(binding.personaId, binding.enabled === false);
                                window.toastr?.success?.(binding.enabled === false ? '已启用角色世界书' : '已停用角色世界书');
                                await this.refreshList();
                            },
                            extraButtons: [chooseBtn],
                        });
                        roleSection.body.appendChild(card);
                    }
                }
                const sessionSection = createSection({
                    title: isRpSession ? '创作专属世界书' : '聊天室附加世界书',
                    description: isRpSession
                        ? '只对当前角色卡的创意写作会话生效；不会进入该角色卡的私聊。'
                        : '只对当前聊天室生效；不会影响创意写作会话或其他聊天。',
                });
                if (!visibleSessionIds.length) {
                    appendEmpty(sessionSection.body, isRpSession
                        ? '当前创意写作会话还没有专属世界书。'
                        : '当前聊天室还没有附加世界书。');
                } else {
                    for (const worldId of visibleSessionIds) {
                        const card = await buildWorldCard(worldId, {
                            subtitle: `聊天室：${contact?.name || sessionKey}`,
                            onToggle: async () => {
                                const next = visibleSessionIds.filter((id) => id !== worldId);
                                window.appBridge?.setSessionWorldIds?.(sessionKey, next, { silent: false });
                                window.toastr?.success?.('已停用附加世界书');
                                await this.refreshList();
                            },
                        });
                        sessionSection.body.appendChild(card);
                    }
                }
            }

            let boundIds = [];
            if (this.libraryTarget.type === 'global') {
                boundIds = normalizedGlobalIds;
            } else if (this.libraryTarget.type === 'role') {
                const binding = roleBindings.find((item) => item.personaId === this.libraryTarget.personaId);
                boundIds = binding?.worldId ? [binding.worldId] : [];
            } else {
                boundIds = (window.appBridge?.getWorldIdsForSession?.(this.libraryTarget.sessionId || sessionKey) || []).filter((id) => id !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);
            }
            await this.renderLibraryList({
                names: visibleNames,
                boundIds,
                scope: this.libraryTarget.type,
                sessionId: this.libraryTarget.sessionId || sessionKey,
                personaId: this.libraryTarget.personaId,
            });
        } catch (err) {
            logger.error('刷新世界书列表失败', err);
        }
    }

    formatLibraryRowMeta(entriesCount, updatedAt) {
        const timeText = updatedAt ? formatDateTime(updatedAt, {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }) : '';
        const countText = translateUiText(entriesCount === null ? '条目数待载入' : `${entriesCount} 条目`);
        return timeText ? `${countText} · ${translateUiText(`更新：${timeText}`)}` : countText;
    }

    // 懒加载下条目数首次载入正文时才可知；只回填对应行文本，不整表重渲染。
    updateLibraryRowEntriesCount(worldId, metadata = {}) {
        const name = String(worldId || '').trim();
        if (!name || !this.libraryListEl?.isConnected) return;
        const rows = this.libraryListEl.querySelectorAll(':scope > .world-library-row');
        for (const row of rows) {
            if (row.dataset.worldName !== name) continue;
            const meta = row.querySelector('.sticker-bind-meta');
            if (!meta) return;
            const countRaw = Number(metadata?.entriesCount);
            const entriesCount = Number.isFinite(countRaw) && countRaw >= 0 ? Math.trunc(countRaw) : null;
            if (entriesCount === null) return;
            meta.textContent = this.formatLibraryRowMeta(
                entriesCount,
                Number(metadata?.updatedAt || metadata?.createdAt || 0),
            );
            return;
        }
    }

    async renderLibraryList({ names = [], boundIds = [], sessionId = '', scope = 'session_extra', personaId = '' } = {}) {
        if (!this.libraryListEl) return;
        const listEl = this.libraryListEl;
        window.appBridge?.setWorldEntriesCountBackfill?.((id, metadata) => this.updateLibraryRowEntriesCount(id, metadata));
        listEl.innerHTML = '';
        const animateRows = this.libraryEntryMotionPending;
        this.libraryEntryMotionPending = false;
        const scopeKey = ['global', 'role', 'session_extra'].includes(String(scope || '').trim())
            ? String(scope || '').trim()
            : 'session_extra';
        const normalizedTarget = this.normalizeLibraryTarget({ type: scopeKey, sessionId, personaId });
        this.libraryTarget = normalizedTarget;
        this.setLibraryImpactText('bind', normalizedTarget);
        const subtitleEl = this.libraryOverlay?.querySelector('.sticker-bind-subtitle');
        if (subtitleEl) {
            subtitleEl.textContent = scopeKey === 'global'
                ? '选择要设为全局的世界书'
                : (scopeKey === 'role' ? '选择要绑定到角色的世界书' : '选择要附加到聊天室的世界书');
        }
        if (this.librarySearchEl && this.librarySearchEl.value !== this.librarySearchTerm) {
            this.librarySearchEl.value = this.librarySearchTerm || '';
        }
        if (this.librarySortEl && this.librarySortEl.value !== this.librarySort) {
            this.librarySortEl.value = this.librarySort || 'time';
            if (this.librarySortButton) {
                refreshCustomSelectButton(this.librarySortButton, this.librarySortEl, '时间');
            }
        }
        if (this.librarySortDirBtn) {
            const isAsc = this.librarySortDir === 'asc';
            this.librarySortDirBtn.classList.toggle('is-asc', isAsc);
            this.librarySortDirBtn.classList.toggle('is-desc', !isAsc);
            this.librarySortDirBtn.innerHTML = `
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style="display:block; transform: translateY(1px);">
                    <path class="world-library-sort-arrow world-library-sort-arrow-up" d="M8 2L11 5H9V7H7V5H5L8 2Z"></path>
                    <path class="world-library-sort-arrow world-library-sort-arrow-down" d="M8 14L5 11H7V9H9V11H11L8 14Z"></path>
                </svg>
            `;
            this.librarySortDirBtn.title = isAsc ? '升序' : '降序';
            this.librarySortDirBtn.setAttribute('aria-pressed', isAsc ? 'true' : 'false');
        }
        const renderEmpty = (text) => {
            const empty = document.createElement('div');
            empty.className = 'sticker-bind-empty';
            if (animateRows) empty.classList.add('is-entering');
            empty.textContent = text;
            listEl.appendChild(empty);
        };

        if (!Array.isArray(names) || !names.length) {
            renderEmpty('暂无世界书');
            return;
        }

        const keyword = String(this.librarySearchTerm || '').trim().toLowerCase();
        const sort = String(this.librarySort || 'time').trim() || 'time';
        const dir = this.librarySortDir === 'asc' ? 'asc' : 'desc';

        const boundSet = new Set(Array.isArray(boundIds) ? boundIds : []);
        const items = names.map((name, index) => {
            const metadata = window.appBridge.getWorldInfoMetadata?.(name) || null;
            const hasEntryCount = metadata?.entriesCount !== null && metadata?.entriesCount !== undefined;
            const countRaw = hasEntryCount ? Number(metadata.entriesCount) : Number.NaN;
            return {
                name,
                index,
                entriesCount: Number.isFinite(countRaw) && countRaw >= 0 ? Math.trunc(countRaw) : null,
                updatedAt: Number(metadata?.updatedAt || metadata?.createdAt || 0),
            };
        });

        let filtered = keyword
            ? items.filter(item => String(item.name).toLowerCase().includes(keyword))
            : items.slice();

        const compareName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans', { sensitivity: 'base' });
        if (sort === 'name') {
            filtered.sort((a, b) => (dir === 'asc' ? compareName(a, b) : compareName(b, a)));
        } else {
            filtered.sort((a, b) => {
                const ta = a.updatedAt || 0;
                const tb = b.updatedAt || 0;
                if (ta !== tb) return dir === 'asc' ? ta - tb : tb - ta;
                return compareName(a, b);
            });
        }

        if (!filtered.length) {
            renderEmpty('暂无匹配世界书');
            return;
        }

        filtered.forEach((item, motionIndex) => {
            const row = document.createElement('div');
            row.className = 'sticker-bind-row world-library-row';
            row.dataset.worldName = item.name;
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            if (animateRows && motionIndex < 12) {
                row.classList.add('is-entering');
                row.style.setProperty('--world-motion-order', String(Math.min(motionIndex, 8)));
            }
            if (boundSet.has(item.name)) {
                row.classList.add('is-bound');
            }

            const info = document.createElement('div');
            info.className = 'sticker-bind-info';
            const title = document.createElement('div');
            title.className = 'sticker-bind-name';
            title.dataset.i18nSkip = '';
            title.textContent = item.name;
            const meta = document.createElement('div');
            meta.className = 'sticker-bind-meta';
            meta.dataset.i18nSkip = '';
            meta.textContent = this.formatLibraryRowMeta(item.entriesCount, item.updatedAt);
            info.appendChild(title);
            info.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'world-library-row-actions';
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '6px';

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'world-library-btn world-library-btn-neutral';
            editBtn.textContent = '编辑';
            editBtn.style.cssText = 'padding:4px 8px;border:1px solid var(--app-border-default);border-radius:999px;background:var(--app-surface-card);font-size:12px;cursor:pointer;';
            editBtn.onclick = async (e) => {
                e.stopPropagation();
                await this.openEditor(item.name);
            };

            const toggle = this.buildToggle({
                enabled: boundSet.has(item.name),
                labelOn: scopeKey === 'global' ? '已启用' : '已绑定',
                labelOff: scopeKey === 'global' ? '未启用' : '未绑定',
                onClick: async () => {
                    if (scopeKey === 'global') {
                        const next = new Set(boundSet);
                        if (boundSet.has(item.name)) {
                            next.delete(item.name);
                            await window.appBridge.setGlobalWorldIds(Array.from(next));
                            window.toastr?.success('已停用世界书');
                        } else {
                            next.add(item.name);
                            await window.appBridge.setGlobalWorldIds(Array.from(next));
                            logger.info('Activated world', item.name, window.appBridge.getWorldInfoMetadata?.(item.name));
                            window.toastr?.success(`已启用世界书：${item.name}`);
                        }
                    } else if (scopeKey === 'role') {
                        const pid = String(normalizedTarget.personaId || '').trim();
                        if (!pid) {
                            window.toastr?.warning?.('未指定角色');
                            return;
                        }
                        if (boundSet.has(item.name)) {
                            await window.appBridge?.clearRoleWorldForPersona?.(pid);
                            window.toastr?.success?.('已解绑角色世界书');
                        } else {
                            await window.appBridge?.assignRoleWorldToPersona?.(pid, item.name, { enabled: true });
                            logger.info('Activated role world', item.name, window.appBridge.getWorldInfoMetadata?.(item.name));
                            window.toastr?.success?.(`已绑定角色世界书：${item.name}`);
                        }
                    } else {
                        const next = new Set(boundSet);
                        if (next.has(item.name)) {
                            next.delete(item.name);
                            window.toastr?.success('已停用世界书');
                        } else {
                            next.add(item.name);
                            logger.info('Activated world', item.name, window.appBridge.getWorldInfoMetadata?.(item.name));
                            window.toastr?.success(`已启用世界书：${item.name}`);
                        }
                        const activeSessionId = String(window.appBridge?.getActiveSessionId?.() || '').trim();
                        const sid = String(normalizedTarget.sessionId || activeSessionId || '').trim();
                        const isActiveSession = sid === activeSessionId;
                        window.appBridge?.setSessionWorldIds?.(sid, Array.from(next), { silent: !isActiveSession });
                        if (!isActiveSession) {
                            syncWorldRegexBindings(window.appBridge);
                            emitWorldInfoChanged(window.appBridge, { sessionId: sid });
                        }
                    }
                    await this.refreshList();
                },
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'world-library-btn world-library-btn-danger';
            deleteBtn.textContent = '删除';
            deleteBtn.style.cssText = 'padding:4px 8px;border:1px solid #fecaca;border-radius:6px;background:var(--app-surface-card);color:#b91c1c;cursor:pointer;';
            deleteBtn.onclick = async () => {
                const ok = await appConfirm({
                    title: '删除世界书',
                    message: `确定要删除世界书「${item.name}」吗？此操作不可恢复。\n\n${buildWorldbookImpactText({
                        scope: scopeKey,
                        sessionId: this.resolveSessionDisplayName(normalizedTarget.sessionId),
                        targetType: scopeKey,
                        action: 'delete',
                    })}`,
                    danger: true,
                });
                if (!ok) return;
                const result = await window.appBridge.deleteWorldInfo(item.name, {
                    expectedExists: true,
                    conflictMode: 'return',
                });
                if (result?.ok === false) {
                    window.toastr?.warning?.('世界书已不存在或状态已变化，请刷新后重试');
                    return;
                }
                window.toastr?.success('已删除世界书');
                await this.refreshList();
            };

            actions.appendChild(editBtn);
            actions.appendChild(toggle);
            actions.appendChild(deleteBtn);

            row.appendChild(info);
            row.appendChild(actions);
            listEl.appendChild(row);
        });
    }

    async openEditor(name, options = {}) {
        try {
            const data = await window.appBridge.getWorldInfo(name);
            await this.editor.show(name, data, options);
        } catch (err) {
            logger.error('打开世界书编辑器失败', err);
            window.toastr?.error('打开编辑器失败');
        }
    }

    async onNewWorld(options = {}) {
        try {
            const target = this.normalizeLibraryTarget(options?.target || this.libraryTarget);
            if (target.type === 'role' && !String(target.personaId || '').trim()) {
                window.toastr?.warning?.('未指定角色，无法新建角色世界书');
                return;
            }
            const raw = prompt('新建世界书名称', '新世界书');
            const name = String(raw || '').trim();
            if (!name) return;
            const existing = await window.appBridge.listWorlds?.();
            if (Array.isArray(existing) && existing.includes(name)) {
                window.toastr?.warning('名称已存在，请换一个');
                return;
            }

            const blank = { name, entries: [] };
            const snapshot = await window.appBridge.getWorldInfoSnapshot?.(name);
            if (snapshot?.exists) {
                window.toastr?.warning('名称已存在，请换一个');
                return;
            }
            await window.appBridge.saveWorldInfo(name, blank, snapshot ? {
                expectedRevision: snapshot.revision,
                expectedGeneration: snapshot.generation,
                expectedExists: false,
            } : undefined);

            if (target.type === 'global' || this.scope === 'global') {
                const current = getGlobalWorldIds(window.appBridge);
                await window.appBridge.setGlobalWorldIds(Array.from(new Set([...current, name])));
            } else if (target.type === 'role') {
                await window.appBridge?.assignRoleWorldToPersona?.(String(target.personaId || '').trim(), name, { enabled: true });
            } else {
                const activeSessionId = String(window.appBridge?.getActiveSessionId?.() || '').trim();
                const sid = String(target.sessionId || activeSessionId || '').trim();
                const current = window.appBridge?.getWorldIdsForSession?.(sid) || [];
                const next = Array.from(new Set([...(Array.isArray(current) ? current : []), name]));
                const isActiveSession = sid === activeSessionId;
                await window.appBridge?.setSessionWorldIds?.(sid, next, { silent: !isActiveSession });
                if (!isActiveSession) {
                    syncWorldRegexBindings(window.appBridge);
                    emitWorldInfoChanged(window.appBridge, { sessionId: sid });
                }
            }

            window.toastr?.success(`已新建并启用：${name}`);
            await this.refreshList();

            // Open editor immediately for convenience
            await this.openEditor(name);
        } catch (err) {
            logger.error('新建世界书失败', err);
            window.toastr?.error('新建世界书失败');
        }
    }

    createUI() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'world-overlay';
        this.overlay.className = 'app-themed-overlay world-panel-overlay';
        this.overlay.style.cssText = `
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.4);
            z-index: 20000;
        `;
        this.overlay.onclick = () => this.hide();

        this.panel = document.createElement('div');
        this.panel.id = 'world-panel';
        this.panel.className = 'app-themed-panel world-panel-shell';
        this.panel.style.cssText = `
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--app-surface-card);
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            padding: 16px;
            width: min(560px, 92vw);
            max-height: 80vh;
            overflow: auto;
            z-index: 21000;
        `;
        this.panel.onclick = (e) => e.stopPropagation();

        this.panel.innerHTML = `
            <h3 style="margin: 0 0 12px; color: var(--app-text-primary);">世界书管理</h3>
            <div id="world-current" style="margin: -4px 0 12px; color:var(--app-text-secondary); font-size:13px;">当前：未启用</div>
            <div id="world-impact" class="world-panel-scope-badge" style="margin: -4px 0 12px; ${SCOPE_BADGE_STYLE}"></div>
            <div id="world-global-settings" style="display:none; margin: 0 0 12px; padding:10px; border:1px dashed var(--app-border-default); border-radius:12px; background:var(--app-surface-subtle);">
                <div id="world-global-settings-header" style="display:flex; align-items:center; justify-content:space-between; cursor:pointer;">
                    <div style="font-weight:700;">全局设置</div>
                    <div id="world-global-settings-toggle" style="font-size:12px; color:var(--app-text-muted);">▼</div>
                </div>
                <div id="world-global-settings-body" style="display:none; margin-top:8px;">
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <span class="has-help" data-help="0 = 不扫描历史。控制向上回溯多少条历史消息做关键词扫描。" style="font-size:12px; color:var(--app-text-secondary);">扫描深度</span>
                        <input id="world-global-scan-depth" type="number" min="0" step="1" placeholder="默认2" style="width:120px; padding:6px 8px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px;">
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span class="has-help" data-help="世界书从统一输入预算中取得的最高占比；设为 0 时不按百分比限制。若同时设置绝对上限，两者取更小值。" style="font-size:12px; color:var(--app-text-secondary);">统一预算占比</span>
                        <input id="world-global-context-percent" type="number" min="0" max="100" step="1" placeholder="默认" style="width:120px; padding:6px 8px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px;">
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span class="has-help" data-help="世界书配额的绝对 Token 上限；大于 0 时与统一预算占比取更小值。占比为 0 时可单独使用此上限。" style="font-size:12px; color:var(--app-text-secondary);">Token 配额上限</span>
                        <input id="world-global-budget-cap" type="number" min="0" step="1" placeholder="0 = 不限制" style="width:120px; padding:6px 8px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px;">
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span class="has-help" data-help="自动加深扫描。命中条目少于该次数时自动加大扫描深度，直到满足或触达最大深度。" style="font-size:12px; color:var(--app-text-secondary);">最小启动次数</span>
                        <input id="world-global-min-activations" type="number" min="0" step="1" placeholder="0 = 关闭" style="width:120px; padding:6px 8px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px;">
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span style="font-size:12px; color:var(--app-text-secondary);">最大深度</span>
                        <input id="world-global-max-depth" type="number" min="0" step="1" placeholder="0 = 不限制" style="width:120px; padding:6px 8px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px;">
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span style="font-size:12px; color:var(--app-text-secondary);">最大递归步数</span>
                        <input id="world-global-max-recursion" type="number" min="0" step="1" placeholder="0 = 不限制" style="width:120px; padding:6px 8px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px;">
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span style="font-size:12px; color:var(--app-text-secondary);">插入策略</span>
                        <select id="world-global-strategy" style="display:none;">
                            <option value="role_first">角色世界书优先</option>
                            <option value="global_first">全局世界书优先</option>
                            <option value="even">平均混合</option>
                        </select>
                        <button type="button" id="world-global-strategy-btn" class="world-app-select-btn" style="min-width:180px;">
                            <span class="pp-custom-select-label" data-custom-select-label>角色世界书优先</span>
                            <span class="world-app-select-btn-chevron">▾</span>
                        </button>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <span style="font-size:12px; color:var(--app-text-secondary);">变量自动建立</span>
                        <select id="world-global-variable-define-strategy" style="display:none;">
                            <option value="legacy_eager">请求前自动建立（旧行为）</option>
                            <option value="first_hit">命中后建立（条目门控变量除外）</option>
                            <option value="off">关闭运行时自动建立</option>
                        </select>
                        <button type="button" id="world-global-variable-define-strategy-btn" class="world-app-select-btn" style="min-width:220px;">
                            <span class="pp-custom-select-label" data-custom-select-label>请求前自动建立（旧行为）</span>
                            <span class="world-app-select-btn-chevron">▾</span>
                        </button>
                    </div>
                    <div style="display:flex; gap:12px; align-items:center; margin-top:8px; flex-wrap:wrap;">
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary);">
                            <input id="world-global-include-names" type="checkbox">
                            包含说话人名称
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary);">
                            <input id="world-global-recursive-scan" type="checkbox">
                            递归扫描
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary);">
                            <input id="world-global-case-sensitive" type="checkbox">
                            区分大小写
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary);">
                            <input id="world-global-full-match" type="checkbox">
                            完全配对
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary);">
                            <input id="world-global-group-scoring" type="checkbox">
                            使用群组评分
                        </label>
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-secondary);">
                            <input id="world-global-overflow-warning" type="checkbox">
                            溢位时警告
                        </label>
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:12px; flex-wrap: wrap;">
                <div style="flex:1 1 100%; min-width: 0;">
                    <div id="world-list-title" style="font-weight:700; margin-bottom:6px;">已绑定</div>
                    <ul id="world-list" style="list-style:none; padding:0; border:none; border-radius:0; max-height:none; overflow:visible; margin:0; display:flex; flex-direction:column; gap:10px;"></ul>
                    <div style="display:flex; gap:8px; margin-top:8px; flex-wrap: wrap;">
                        <button id="world-new" data-maid-guide-target="worldbook-new" style="flex:1; min-width:120px; padding:8px 10px; border:1px solid var(--app-border-default); border-radius:8px; background:#019aff; color:var(--app-text-inverse); font-weight:700;">新增</button>
                        <button id="world-library-toggle" style="flex:1; min-width:120px; padding:8px 10px; border:1px solid var(--app-border-default); border-radius:8px; background:var(--app-surface-subtle);">世界书库</button>
                    </div>
                </div>
                <div style="flex:1 1 100%; min-width: 0;">
                    <div class="has-help" data-help="名称将取自 JSON 的 name 或文件名（无需手动填写）。同名时必须明确确认，不会静默覆盖；含绑定正则时需再次确认才一并导入。" style="font-weight:700; margin-bottom:6px;">导入世界书</div>
                    <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                        <button id="world-file-btn" type="button" style="padding:6px 10px; border-radius:8px; border:1px solid var(--app-border-default); background:var(--app-surface-subtle); cursor:pointer;">选择文件</button>
                        <span id="world-file-name" style="font-size:12px; color:var(--app-text-muted);">未选择文件</span>
                    </div>
                    <input id="world-file" type="file" accept=".json,application/json" style="display:none;">
                    <div id="world-import-impact" class="world-panel-scope-badge" style="margin:6px 0 0; ${SCOPE_BADGE_STYLE}"></div>
                    <div style="display:flex; gap:8px; margin-top:8px; justify-content:flex-end;">
                        <button id="world-import" style="padding:8px 14px; border-radius:8px; border:1px solid var(--app-border-default); background:var(--app-surface-subtle);">导入</button>
                        <button id="world-close" style="padding:8px 14px; border-radius:8px; border:1px solid var(--app-border-default); background:var(--app-surface-subtle);">关闭</button>
                    </div>
                </div>
            </div>
        `;

        this.listEl = this.panel.querySelector('#world-list');
        this.impactEl = this.panel.querySelector('#world-impact');
        this.importImpactEl = this.panel.querySelector('#world-import-impact');
        this.libraryToggleBtn = this.panel.querySelector('#world-library-toggle');
        this.fileInput = this.panel.querySelector('#world-file');
        this.fileBtn = this.panel.querySelector('#world-file-btn');
        this.fileNameEl = this.panel.querySelector('#world-file-name');
        this.globalSettingsEl = this.panel.querySelector('#world-global-settings');
        this.globalSettingsBody = this.panel.querySelector('#world-global-settings-body');
        this.globalSettingsToggle = this.panel.querySelector('#world-global-settings-toggle');
        this.globalScanInput = this.panel.querySelector('#world-global-scan-depth');
        this.globalStrategySelect = this.panel.querySelector('#world-global-strategy');
        this.globalStrategyButton = this.panel.querySelector('#world-global-strategy-btn');
        this.globalVariableDefineStrategySelect = this.panel.querySelector('#world-global-variable-define-strategy');
        this.globalVariableDefineStrategyButton = this.panel.querySelector('#world-global-variable-define-strategy-btn');
        this.globalContextInput = this.panel.querySelector('#world-global-context-percent');
        this.globalIncludeNames = this.panel.querySelector('#world-global-include-names');
        this.globalBudgetInput = this.panel.querySelector('#world-global-budget-cap');
        this.globalMinActivationsInput = this.panel.querySelector('#world-global-min-activations');
        this.globalMaxDepthInput = this.panel.querySelector('#world-global-max-depth');
        this.globalMaxRecursionInput = this.panel.querySelector('#world-global-max-recursion');
        this.globalRecursiveScan = this.panel.querySelector('#world-global-recursive-scan');
        this.globalCaseSensitive = this.panel.querySelector('#world-global-case-sensitive');
        this.globalMatchWholeWords = this.panel.querySelector('#world-global-full-match');
        this.globalUseGroupScoring = this.panel.querySelector('#world-global-group-scoring');
        this.globalOverflowWarning = this.panel.querySelector('#world-global-overflow-warning');
        bindCustomSelectButton({
            buttonEl: this.globalStrategyButton,
            selectEl: this.globalStrategySelect,
            fallback: '角色世界书优先',
        });
        bindCustomSelectButton({
            buttonEl: this.globalVariableDefineStrategyButton,
            selectEl: this.globalVariableDefineStrategySelect,
            fallback: '请求前自动建立（旧行为）',
        });

        this.panel.querySelector('#world-close').onclick = () => this.hide();
        this.panel.querySelector('#world-import').onclick = () => this.onImport();
        this.panel.querySelector('#world-new').onclick = () => this.onNewWorld({
            target: this.scope === 'global'
                ? { type: 'global' }
                : { type: 'session_extra', sessionId: this.getSessionId ? this.getSessionId() : (window.appBridge?.getActiveSessionId?.() || '') },
        });
        const exportBtn = this.panel.querySelector('#world-export-current');
        if (exportBtn) exportBtn.onclick = () => this.onExportCurrent();
        if (this.libraryToggleBtn) {
            this.libraryToggleBtn.onclick = () => this.openLibraryModal(
                this.scope === 'global'
                    ? { type: 'global' }
                    : { type: 'session_extra', sessionId: this.getSessionId ? this.getSessionId() : (window.appBridge?.getActiveSessionId?.() || '') },
            );
        }
        if (this.fileBtn && this.fileInput) {
            this.fileBtn.onclick = () => this.fileInput?.click();
        }
        if (this.fileInput) {
            this.fileInput.onchange = () => {
                const name = this.fileInput?.files?.[0]?.name || '';
                if (this.fileNameEl) this.fileNameEl.textContent = name || '未选择文件';
            };
        }
        if (this.fileNameEl) this.fileNameEl.textContent = '未选择文件';

        if (this.globalScanInput) {
            this.globalScanInput.onchange = () => {
                const raw = String(this.globalScanInput.value || '').trim();
                const scanDepth = raw === '' ? null : Math.max(0, Math.trunc(Number(raw)));
                window.appBridge?.setWorldGlobalSettings?.({ scanDepth });
            };
        }
        if (this.globalContextInput) {
            this.globalContextInput.onchange = () => {
                const raw = String(this.globalContextInput.value || '').trim();
                const percent = raw === '' ? null : Math.max(0, Math.min(100, Math.trunc(Number(raw))));
                window.appBridge?.setWorldGlobalSettings?.({ contextPercent: percent });
            };
        }
        if (this.globalBudgetInput) {
            this.globalBudgetInput.onchange = () => {
                const raw = String(this.globalBudgetInput.value || '').trim();
                const budgetCap = raw === '' ? null : Math.max(0, Math.trunc(Number(raw)));
                window.appBridge?.setWorldGlobalSettings?.({ budgetCap });
            };
        }
        if (this.globalMinActivationsInput) {
            this.globalMinActivationsInput.onchange = () => {
                const raw = String(this.globalMinActivationsInput.value || '').trim();
                const minActivations = raw === '' ? null : Math.max(0, Math.trunc(Number(raw)));
                window.appBridge?.setWorldGlobalSettings?.({ minActivations });
            };
        }
        if (this.globalMaxDepthInput) {
            this.globalMaxDepthInput.onchange = () => {
                const raw = String(this.globalMaxDepthInput.value || '').trim();
                const maxDepth = raw === '' ? null : Math.max(0, Math.trunc(Number(raw)));
                window.appBridge?.setWorldGlobalSettings?.({ maxDepth });
            };
        }
        if (this.globalMaxRecursionInput) {
            this.globalMaxRecursionInput.onchange = () => {
                const raw = String(this.globalMaxRecursionInput.value || '').trim();
                const maxRecursionSteps = raw === '' ? null : Math.max(0, Math.trunc(Number(raw)));
                window.appBridge?.setWorldGlobalSettings?.({ maxRecursionSteps });
            };
        }
        if (this.globalStrategySelect) {
            this.globalStrategySelect.onchange = () => {
                const value = String(this.globalStrategySelect.value || 'role_first');
                refreshCustomSelectButton(this.globalStrategyButton, this.globalStrategySelect, '角色世界书优先');
                window.appBridge?.setWorldGlobalSettings?.({ insertionStrategy: value });
            };
        }
        if (this.globalVariableDefineStrategySelect) {
            this.globalVariableDefineStrategySelect.onchange = () => {
                const value = String(this.globalVariableDefineStrategySelect.value || 'legacy_eager');
                refreshCustomSelectButton(this.globalVariableDefineStrategyButton, this.globalVariableDefineStrategySelect, '请求前自动建立（旧行为）');
                window.appBridge?.setWorldGlobalSettings?.({ variableDefineStrategy: value });
            };
        }
        if (this.globalIncludeNames) {
            this.globalIncludeNames.onchange = () => {
                const enabled = Boolean(this.globalIncludeNames.checked);
                window.appBridge?.setWorldGlobalSettings?.({ includeNames: enabled });
            };
        }
        if (this.globalRecursiveScan) {
            this.globalRecursiveScan.onchange = () => {
                const enabled = Boolean(this.globalRecursiveScan.checked);
                window.appBridge?.setWorldGlobalSettings?.({ recursiveScan: enabled });
            };
        }
        if (this.globalCaseSensitive) {
            this.globalCaseSensitive.onchange = () => {
                const enabled = Boolean(this.globalCaseSensitive.checked);
                window.appBridge?.setWorldGlobalSettings?.({ caseSensitive: enabled });
            };
        }
        if (this.globalMatchWholeWords) {
            this.globalMatchWholeWords.onchange = () => {
                const enabled = Boolean(this.globalMatchWholeWords.checked);
                window.appBridge?.setWorldGlobalSettings?.({ matchWholeWords: enabled });
            };
        }
        if (this.globalUseGroupScoring) {
            this.globalUseGroupScoring.onchange = () => {
                const enabled = Boolean(this.globalUseGroupScoring.checked);
                window.appBridge?.setWorldGlobalSettings?.({ useGroupScoring: enabled });
            };
        }
        if (this.globalOverflowWarning) {
            this.globalOverflowWarning.onchange = () => {
                const enabled = Boolean(this.globalOverflowWarning.checked);
                window.appBridge?.setWorldGlobalSettings?.({ alertOnOverflow: enabled });
            };
        }
        const globalHeader = this.panel.querySelector('#world-global-settings-header');
        if (globalHeader && this.globalSettingsBody && this.globalSettingsToggle) {
            const toggleGlobalSettings = () => {
                this.globalSettingsOpen = !this.globalSettingsOpen;
                this.globalSettingsEl?.classList.toggle('is-expanded', this.globalSettingsOpen);
                globalHeader.setAttribute('aria-expanded', this.globalSettingsOpen ? 'true' : 'false');
                setWorldDisclosureState(this.globalSettingsBody, this.globalSettingsOpen, { duration: 320 });
            };
            globalHeader.onclick = () => toggleGlobalSettings();
            this.globalSettingsEl?.classList.toggle('is-expanded', this.globalSettingsOpen);
            globalHeader.setAttribute('aria-expanded', this.globalSettingsOpen ? 'true' : 'false');
            this.globalSettingsBody.style.display = this.globalSettingsOpen ? 'block' : 'none';
            this.globalSettingsToggle.textContent = '▼';
        }

        this.libraryOverlay = document.createElement('div');
        this.libraryOverlay.id = 'world-library-overlay';
        this.libraryOverlay.className = 'app-themed-overlay sticker-bind-overlay world-library-overlay';
        this.libraryOverlay.innerHTML = `
            <div class="sticker-bind-modal world-library-modal">
                <div class="sticker-bind-header">
                    <div>
                        <div class="sticker-bind-title">世界书库</div>
                        <div class="sticker-bind-subtitle">选择要绑定的世界书</div>
                    </div>
                    <button type="button" class="sticker-bind-close" aria-label="关闭">×</button>
                </div>
                <div id="world-library-impact" class="world-panel-scope-badge" style="margin:0 12px 10px; ${SCOPE_BADGE_STYLE}"></div>
                <div class="sticker-bind-search">
                    <div style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="world-library-search" placeholder="搜索世界书" style="flex:1;">
                        <button type="button" id="world-library-reset" style="border:1px solid rgba(148,163,184,0.45); background:var(--app-surface-card); border-radius:999px; padding:5px 10px; font-size:12px; cursor:pointer;">清除</button>
                    </div>
                </div>
                <div class="sticker-bind-toolbar" style="flex-wrap:wrap;">
                    <div class="world-library-sort-control" role="group" aria-label="世界书排序">
                        <span class="world-library-sort-label">排序</span>
                        <select id="world-library-sort" style="display:none;">
                            <option value="time">时间</option>
                            <option value="name">字母</option>
                        </select>
                        <button type="button" id="world-library-sort-btn" class="world-app-select-btn world-library-sort-select">
                            <span class="pp-custom-select-label" data-custom-select-label>时间</span>
                            <span class="world-app-select-btn-chevron">▾</span>
                        </button>
                        <button type="button" id="world-library-sort-dir" class="world-library-sort-dir is-desc" aria-label="切换排序方向">
                            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style="display:block; transform: translateY(1px);">
                                <path class="world-library-sort-arrow world-library-sort-arrow-up" d="M8 2L11 5H9V7H7V5H5L8 2Z"></path>
                                <path class="world-library-sort-arrow world-library-sort-arrow-down" d="M8 14L5 11H7V9H9V11H11L8 14Z"></path>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="sticker-bind-list" id="world-library-list"></div>
                <div class="sticker-bind-footer">
                    <button type="button" id="world-library-close">关闭</button>
                </div>
            </div>
        `;
        this.libraryModal = this.libraryOverlay.querySelector('.world-library-modal');
        if (this.libraryModal) {
            this.libraryModal.id = 'world-library-modal';
            this.libraryModal.classList.add('app-themed-panel', 'world-library-shell');
        }
        this.libraryListEl = this.libraryOverlay.querySelector('#world-library-list');
        this.libraryImpactEl = this.libraryOverlay.querySelector('#world-library-impact');
        this.librarySearchEl = this.libraryOverlay.querySelector('#world-library-search');
        this.librarySortEl = this.libraryOverlay.querySelector('#world-library-sort');
        this.librarySortButton = this.libraryOverlay.querySelector('#world-library-sort-btn');
        this.libraryResetBtn = this.libraryOverlay.querySelector('#world-library-reset');
        this.librarySortDirBtn = this.libraryOverlay.querySelector('#world-library-sort-dir');
        bindCustomSelectButton({
            buttonEl: this.librarySortButton,
            selectEl: this.librarySortEl,
            fallback: '时间',
        });

        const closeLibrary = () => {
            closeCustomSelectMenu();
            if (!this.libraryOverlay || !this.libraryModal) return;
            if (this.libraryOverlay.classList.contains('is-closing')) return;

            const wasActive = this.libraryOverlay.classList.contains('is-active');
            const finish = () => {
                this.libraryCloseTimer = null;
                this.libraryOverlay.classList.remove('is-active', 'is-opening', 'is-closing');
                this.libraryModal.classList.remove('is-opening', 'is-closing');
            };
            if (!wasActive || isWorldMotionReduced()) {
                finish();
                return;
            }
            this.libraryOverlay.classList.remove('is-active', 'is-opening');
            this.libraryModal.classList.remove('is-opening');
            this.libraryOverlay.classList.add('is-closing');
            this.libraryModal.classList.add('is-closing');
            this.libraryCloseTimer = setTimeout(finish, 220);
        };

        const openLibrary = async (target = null) => {
            if (!this.libraryOverlay) return;
            if (target) this.libraryTarget = this.normalizeLibraryTarget(target);
            if (this.libraryCloseTimer) {
                clearTimeout(this.libraryCloseTimer);
                this.libraryCloseTimer = null;
            }
            this.libraryOverlay.classList.remove('is-closing', 'is-opening');
            this.libraryModal?.classList.remove('is-closing', 'is-opening');
            this.libraryOverlay.classList.add('is-active');
            this.libraryEntryMotionPending = true;
            if (!isWorldMotionReduced()) {
                this.libraryOverlay.classList.add('is-opening');
                this.libraryModal?.classList.add('is-opening');
            }
            await this.refreshList();
        };

        this.openLibraryModal = openLibrary;
        this.closeLibraryModal = closeLibrary;

        bindBackdropActivation(this.libraryOverlay, {
            onActivate: () => closeLibrary(),
        });
        this.libraryModal?.addEventListener('click', (event) => event.stopPropagation());
        this.libraryOverlay.querySelector('.sticker-bind-close')?.addEventListener('click', () => closeLibrary());
        this.libraryOverlay.querySelector('#world-library-close')?.addEventListener('click', () => closeLibrary());
        this.librarySearchEl?.addEventListener('input', () => {
            this.librarySearchTerm = String(this.librarySearchEl?.value || '');
            this.refreshList();
        });
        this.librarySortEl?.addEventListener('change', () => {
            this.librarySort = String(this.librarySortEl?.value || 'time') || 'time';
            refreshCustomSelectButton(this.librarySortButton, this.librarySortEl, '时间');
            this.refreshList();
        });
        this.librarySortDirBtn?.addEventListener('click', () => {
            this.librarySortDir = this.librarySortDir === 'asc' ? 'desc' : 'asc';
            this.refreshList();
        });
        this.libraryResetBtn?.addEventListener('click', () => {
            this.librarySearchTerm = '';
            this.librarySort = 'time';
            this.librarySortDir = 'desc';
            if (this.librarySearchEl) this.librarySearchEl.value = '';
            if (this.librarySortEl) this.librarySortEl.value = 'time';
            if (this.librarySortButton && this.librarySortEl) {
                refreshCustomSelectButton(this.librarySortButton, this.librarySortEl, '时间');
            }
            this.refreshList();
        });

        document.body.appendChild(this.overlay);
        document.body.appendChild(this.panel);
        document.body.appendChild(this.libraryOverlay);
    }

    async onImport() {
        let jsonText = '';
        let nameHint = '';

        const file = this.fileInput?.files?.[0];
        if (file) {
            nameHint = file.name.replace(/\\.json$/i, '');
            jsonText = await file.text();
        }

        if (!jsonText) {
            window.toastr?.warning('请选择 ST JSON 文件');
            return;
        }

        try {
            const json = JSON.parse(jsonText);
            const nameFromJson = json.name || json.title || '';
            const name = nameFromJson || nameHint || 'imported';
            const simplified = convertSTWorld(json, name);
            const snapshot = await window.appBridge.getWorldInfoSnapshot?.(name);
            const importPlan = buildWorldbookImportPlan({
                worldId: name,
                incomingWorld: simplified,
                snapshot,
            });
            if (importPlan.conflict) {
                const existingCount = Array.isArray(importPlan.conflict.base?.entries)
                    ? importPlan.conflict.base.entries.length
                    : 0;
                const incomingCount = Array.isArray(importPlan.conflict.incoming?.entries)
                    ? importPlan.conflict.incoming.entries.length
                    : 0;
                const decision = await appChoice({
                    title: '同名世界书已存在',
                    message: `世界书「${name}」已存在（现有 ${existingCount} 条，导入文件 ${incomingCount} 条）。\n\n覆盖会完整替换现有世界书内容；当前会话、角色和全局对该书的绑定不会自动移除。若尚未确认差异，建议取消并先导出现有世界书备份。`,
                    actions: [
                        { id: WORLDBOOK_IMPORT_DECISIONS.cancel, label: '取消导入', primary: true },
                        { id: WORLDBOOK_IMPORT_DECISIONS.overwrite, label: '覆盖现有世界书', variant: 'danger' },
                    ],
                    defaultActionId: WORLDBOOK_IMPORT_DECISIONS.cancel,
                });
                if (decision !== WORLDBOOK_IMPORT_DECISIONS.overwrite) {
                    window.toastr?.info?.('已取消导入，现有世界书未变更');
                    return;
                }
            }
            await window.appBridge.saveWorldInfo(
                importPlan.targetId,
                importPlan.incomingWorld,
                importPlan.saveOptions,
            );

            // 若导入文件包含绑定的正则集合，则一并导入并绑定到该世界书
            const boundSets = getWorldbookBoundRegexSets(json);
            if (Array.isArray(boundSets) && boundSets.length) {
                try {
                    const sessionId = this.getActiveSessionKey();
                    const ok = await appConfirm({
                        title: '导入正则',
                        message: `检测到世界书包含绑定的正规表达式（${boundSets.length} 组）。是否一并导入并绑定？\n\n${buildWorldbookImpactText({
                            scope: this.scope,
                            sessionId: this.resolveSessionDisplayName(sessionId),
                            targetType: this.scope === 'global' ? 'global' : 'session_manage',
                            action: 'regex_import',
                        })}`,
                        confirmText: '一并导入',
                        cancelText: '仅导入世界书',
                    });
                    if (!ok) {
                        await this.refreshList();
                        window.toastr?.success(`导入成功：${name}`);
                        if (this.fileInput) this.fileInput.value = '';
                        if (this.fileNameEl) this.fileNameEl.textContent = '未选择文件';
                        return;
                    }

                    await waitForRegexStoreReady(window.appBridge);
                    let existingSets = [];
                    try {
                        existingSets = listRegexLocalSets(window.appBridge);
                    } catch {}
                    const { importedRuleCount, skippedRuleCount } = await importWorldbookBoundRegexSets({
                        worldId: name,
                        boundSets,
                        existingSets,
                        upsertLocalSet: set => upsertRegexLocalSet(window.appBridge, set),
                    });
                    const skippedText = skippedRuleCount > 0 ? `，跳过目标世界书已有或重复规则 ${skippedRuleCount} 条` : '';
                    window.toastr?.success(`已导入并绑定正则：${importedRuleCount} 条${skippedText}`);
                    window.dispatchEvent(new CustomEvent('regex-changed'));
                } catch (err) {
                    logger.warn('导入绑定正则失败', err);
                }
            }

            await this.refreshList();
            window.toastr?.success(`导入成功：${name}`);
            if (this.fileInput) this.fileInput.value = '';
            if (this.fileNameEl) this.fileNameEl.textContent = '未选择文件';
        } catch (err) {
            logger.error('导入世界书失败', err);
            if (err?.code === 'worldbook_revision_conflict') {
                window.toastr?.warning?.('确认期间世界书已被修改，请重新导入并核对最新内容');
            } else {
                window.toastr?.error('导入失败，请检查 JSON', '错误');
            }
        }
    }

    async onExportCurrent() {
        const current = this.scope === 'global'
            ? getGlobalWorldId(window.appBridge)
            : getCurrentWorldId(window.appBridge);
        if (!current || current === '未启用') {
            window.toastr?.warning('没有可导出的世界书');
            return;
        }
        const data = await window.appBridge.getWorldInfo(current);
        if (!data) {
            window.toastr?.warning('没有可导出的世界书');
            return;
        }
        const payload = { ...(data || {}), name: current };

        // 追加绑定正则集合（便于导入时自动带上）
        try {
            await waitForRegexStoreReady(window.appBridge);
            const sets = listRegexLocalSets(window.appBridge);
            const bound = sets.filter(s => s?.bind?.type === 'world' && s.bind.worldId === current)
                .map(s => ({ name: s.name, enabled: s.enabled !== false, rules: s.rules || [] }));
            if (bound.length) payload.boundRegexSets = bound;
        } catch {}

        const filename = `${this.sanitizeExportName(current, 'worldbook')}.json`;
        const ok = await this.downloadJson(payload, filename);
        if (ok) window.toastr?.success(`已导出：${filename}`);
    }

}
