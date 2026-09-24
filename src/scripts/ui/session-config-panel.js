import { PresetStore, isPresetEligibleForMode } from '../storage/preset-store.js';
import { getReasoningCapability } from '../api/model-capabilities.js';
import { logger } from '../utils/logger.js';
import { t } from '../i18n/index.js';
import { getActiveConfigProfileId, getConfigProfileById, getConfigProfiles } from './config-runtime-utils.js';
import { closeCustomSelectMenu as closeSharedCustomSelectMenu, openCustomSelectMenu } from './custom-select.js';
import { getPresetStore } from './preset-store-runtime-utils.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[ch] || ch);

const SC_PANEL_CSS = `
.pp-binding-stack { display:block; }
.pp-binding-stack > * + * { margin-top:12px; }
.pp-binding-card {
    border:1px solid var(--app-border-default); border-radius:16px;
    background:var(--app-surface-card); box-shadow:0 4px 18px rgba(15,23,42,0.04); padding:12px;
}
.pp-binding-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.pp-binding-card-title { font-size:14px; font-weight:800; color:var(--app-text-primary); line-height:1.35; }
.pp-binding-card-sub { margin-top:4px; font-size:12px; color:var(--app-text-muted); line-height:1.5; }
.pp-binding-btn {
    appearance:none; -webkit-appearance:none; min-height:34px; padding:8px 12px;
    border-radius:10px; border:1px solid #dbe2ea; background:var(--app-surface-card);
    color:var(--app-text-secondary); font-size:12px; font-weight:700; cursor:pointer;
}
.pp-binding-btn.is-primary { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
.pp-binding-btn.is-muted { background:var(--app-surface-subtle); color:var(--app-text-muted); }
.pp-binding-btn:disabled { opacity:0.45; cursor:not-allowed; }
.pp-binding-list { margin-top:10px; }
.pp-binding-list > * + * { margin-top:8px; }
.pp-binding-item {
    border:1px solid var(--app-border-default); border-radius:14px;
    background:var(--app-surface-subtle); padding:10px 12px;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
}
.pp-binding-item-main { min-width:0; display:flex; flex-direction:column; gap:4px; }
.pp-binding-item-title {
    font-size:13px; font-weight:700; color:var(--app-text-primary);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.pp-binding-item-sub {
    font-size:12px; color:var(--app-text-muted); line-height:1.45;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.pp-binding-empty {
    padding:12px; border:1px dashed var(--app-border-strong); border-radius:14px;
    background:var(--app-surface-subtle); font-size:12px; color:var(--app-text-muted); line-height:1.5;
}
.pp-binding-filter {
    display:block; width:100%; box-sizing:border-box; margin-top:10px;
    padding:8px 10px; border:1px solid var(--app-border-default); border-radius:10px;
    background:var(--app-surface-subtle); color:var(--app-text-primary);
    font-size:13px; outline:none;
}
.pp-binding-filter::placeholder { color:var(--app-text-muted); }
.pp-binding-filter:focus { border-color:var(--app-accent-primary); }
.sc-session-list {
    margin-top:10px;
    display:flex;
    flex-direction:column;
    gap:10px;
    max-height:42vh;
    overflow-y:auto;
    -webkit-overflow-scrolling:touch;
    overscroll-behavior:contain;
}
.sc-session-list > * + * { margin-top:0 !important; }
.sc-session-entry {
    border:1px solid var(--app-border-default);
    border-radius:14px;
    background:var(--app-surface-subtle);
    overflow:visible;
    display:flex;
    flex-direction:column;
    flex:0 0 auto;
    min-height:118px;
    padding:12px;
    box-sizing:border-box;
    gap:10px;
}
.sc-session-head {
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:12px;
}
.sc-session-main {
    min-width:0;
    flex:1;
    display:flex;
    flex-direction:column;
    gap:6px;
}
.sc-session-titleline {
    display:flex;
    align-items:center;
    gap:8px;
    min-width:0;
}
.sc-session-meta {
    flex-shrink:0;
    display:inline-flex;
    align-items:center;
    min-height:22px;
    padding:0 8px;
    border-radius:999px;
    border:1px solid var(--app-border-default);
    background:var(--app-surface-card);
    font-size:11px;
    font-weight:700;
    color:var(--app-text-muted);
}
.sc-session-sub {
    font-size:12px;
    color:var(--app-text-muted);
    line-height:1.5;
}
.sc-session-chiprow {
    display:flex;
    align-items:center;
    gap:6px;
    flex-wrap:wrap;
}
.sc-session-chip {
    display:inline-flex;
    align-items:center;
    min-height:24px;
    padding:0 8px;
    border-radius:999px;
    border:1px solid var(--app-border-default);
    background:var(--app-surface-card);
    font-size:11px;
    font-weight:700;
    color:var(--app-text-secondary);
}
.sc-session-actions {
    flex:0 0 auto;
    display:flex;
    align-items:flex-start;
}
.sc-session-extras {
    border-top:1px dashed var(--app-border-default);
    padding-top:10px;
    display:flex;
    flex-direction:column;
    gap:10px;
}
.sc-reasoning-row {
    display:flex;
    align-items:flex-start;
    gap:8px;
    flex-wrap:wrap;
}
.sc-reasoning-label {
    font-size:12px;
    color:var(--app-text-muted);
    white-space:nowrap;
    flex-shrink:0;
    padding-top:6px;
}
.sc-reasoning-controls {
    flex:1 1 220px;
    min-width:0;
    display:flex;
    align-items:center;
    gap:8px;
    flex-wrap:wrap;
}
@media (min-width: 900px) {
    .sc-reasoning-controls {
        flex-wrap:nowrap;
    }
}
@media (min-width: 900px) {
    .sc-session-entry { padding:14px 16px; }
}
`;

export class SessionConfigPanel {
    constructor({ store = null } = {}) {
        const bridge = typeof window !== 'undefined' ? window.appBridge : null;
        this.store = store || getPresetStore(bridge) || new PresetStore();
        this.overlay = null;
        this.panel = null;
        this.scrollEl = null;
        this.editorEl = null;
        this.focusSessionId = null;
        this.runtimeContext = {
            chatStore: null,
            contactsStore: null,
            personaStore: null,
            configPanel: null,
            getUiMode: null,
        };
        this.expandedSessionByGroup = { chat: '', rp: '' };
        this.groupScrollTop = { chat: 0, rp: 0 };
    }

    setRuntimeContext(ctx = {}) {
        if (ctx.chatStore) this.runtimeContext.chatStore = ctx.chatStore;
        if (ctx.contactsStore) this.runtimeContext.contactsStore = ctx.contactsStore;
        if (ctx.personaStore) this.runtimeContext.personaStore = ctx.personaStore;
        if (ctx.configPanel) this.runtimeContext.configPanel = ctx.configPanel;
        if (typeof ctx.getUiMode === 'function') this.runtimeContext.getUiMode = ctx.getUiMode;
    }

    createUI() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'session-config-overlay';
        this.overlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:20000;';
        this.overlay.onclick = () => this.hide();

        this.panel = document.createElement('div');
        this.panel.id = 'session-config-panel';
        this.panel.style.cssText = `
            display:none; position:fixed;
            top: calc(10px + env(safe-area-inset-top, 0px));
            bottom: calc(10px + env(safe-area-inset-bottom, 0px));
            left: calc(10px + env(safe-area-inset-left, 0px));
            right: calc(10px + env(safe-area-inset-right, 0px));
            box-sizing: border-box;
            background:var(--app-surface-card); border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,0.25);
            z-index: 21000; flex-direction: column; overflow: hidden;
        `;
        this.panel.onclick = (e) => e.stopPropagation();

        this.panel.innerHTML = `
            <style>${SC_PANEL_CSS}</style>
            <div style="display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--app-border-default);">
                <div style="min-width:0; flex:1;">
                    <div style="font-size:16px; font-weight:800; color:var(--app-text-primary);">会话配置管理</div>
                    <div style="font-size:12px; color:var(--app-text-muted); margin-top:2px;">为各会话设定预设、连线配置与推理覆盖</div>
                </div>
                <button id="sc-close" style="border:none; background:none; font-size:22px; color:var(--app-text-muted); cursor:pointer; padding:4px 8px; line-height:1;">&times;</button>
            </div>
            <div id="sc-scroll" style="flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:12px 14px 24px;">
                <div id="sc-editor"></div>
            </div>
        `;

        this.panel.querySelector('#sc-close').addEventListener('click', () => this.hide());
        this.scrollEl = this.panel.querySelector('#sc-scroll');
        this.editorEl = this.panel.querySelector('#sc-editor');

        const refreshForChatConfig = (event) => {
            if (event?.detail?.tab && event.detail.tab !== 'chat') return;
            if (this.panel?.style.display === 'none') return;
            this.rerender();
        };
        window.addEventListener('config-profile-changed', refreshForChatConfig);
        window.addEventListener('config-draft-changed', refreshForChatConfig);

        document.body.appendChild(this.overlay);
        document.body.appendChild(this.panel);
    }

    show(options = {}) {
        if (!this.panel) this.createUI();
        this.focusSessionId = options.sessionId || null;
        if (this.focusSessionId) {
            const group = this.focusSessionId.startsWith('rp:') ? 'rp' : 'chat';
            this.expandedSessionByGroup[group] = this.focusSessionId;
        }
        this.render();
        this.overlay.style.display = 'block';
        this.panel.style.display = 'flex';

        if (this.focusSessionId) {
            requestAnimationFrame(() => {
                const el = this.findSessionElement(this.focusSessionId);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
    }

    hide() {
        this.closeCustomSelectMenu();
        if (this.overlay) this.overlay.style.display = 'none';
        if (this.panel) this.panel.style.display = 'none';
    }

    /* ── data ── */

    getSessionEntries() {
        const { chatStore, contactsStore, personaStore } = this.runtimeContext;
        const sessionIds = Array.isArray(chatStore?.listSessions?.()) ? chatStore.listSessions() : [];
        return sessionIds.map((sid) => {
            const sessionId = String(sid || '').trim();
            if (!sessionId) return null;
            const isRp = sessionId.startsWith('rp:');
            const contact = contactsStore?.getContact?.(sessionId) || null;
            const personaId = isRp ? sessionId.slice(3) : '';
            const persona = personaId ? personaStore?.get?.(personaId) : null;
            const name = isRp
                ? String(persona?.name || persona?.title || personaId || sessionId).trim() || sessionId
                : String(contact?.name || sessionId).trim() || sessionId;
            const meta = isRp ? '创意写作' : (contact?.isGroup ? '群聊' : '聊天室');
            return { id: sessionId, name, meta, group: isRp ? 'rp' : 'chat' };
        }).filter(Boolean);
    }

    getProfiles() {
        return getConfigProfiles(window.appBridge);
    }

    getPresetList(mode = 'chat') {
        return this.store.listSummaries('openai')
            .filter(preset => isPresetEligibleForMode(preset, mode))
            .map(({ id, name }) => ({ value: id, label: name || id }));
    }

    getPresetName(presetId) {
        const p = this.store.listSummaries('openai').find(preset => preset.id === presetId);
        return String(p?.name || '').trim() || presetId || '';
    }

    getProfileName(profileId) {
        const profile = profileId ? getConfigProfileById(window.appBridge, profileId) : null;
        return String(profile?.name || '').trim() || (profileId || '');
    }

    getProfileForReasoning(profileId) {
        const id = String(profileId || '').trim();
        const profile = id ? getConfigProfileById(window.appBridge, id) : null;
        const draft = this.runtimeContext.configPanel?.getDraftConfig?.({ tab: 'chat' }) || null;
        if (!draft) return profile;
        const activeId = getActiveConfigProfileId(window.appBridge);
        if (id && activeId && id !== activeId) return profile;
        return {
            ...(profile || {}),
            ...draft,
            id: profile?.id || activeId || id,
            name: profile?.name || '当前聊天配置草稿',
        };
    }

    findSessionElement(sessionId) {
        const id = String(sessionId || '').trim();
        if (!id || !this.editorEl) return null;
        try {
            return this.editorEl.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
        } catch {
            return null;
        }
    }

    findSessionList(group) {
        const key = String(group || '').trim();
        if (!key || !this.editorEl) return null;
        try {
            return this.editorEl.querySelector(`[data-session-group="${CSS.escape(key)}"]`);
        } catch {
            return null;
        }
    }

    captureScrollState(anchorSessionId = '') {
        const scrollEl = this.scrollEl;
        if (!scrollEl) return null;
        const sessionId = String(anchorSessionId || '').trim();
        const state = {
            scrollTop: Number(scrollEl.scrollTop || 0),
            anchorSessionId: sessionId,
            anchorOffsetTop: null,
            groupScrollTop: { ...this.groupScrollTop },
        };
        ['chat', 'rp'].forEach((group) => {
            const listEl = this.findSessionList(group);
            if (listEl) state.groupScrollTop[group] = Number(listEl.scrollTop || 0);
        });
        if (sessionId) {
            const anchorEl = this.findSessionElement(sessionId);
            if (anchorEl) {
                state.anchorOffsetTop = anchorEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
            }
        }
        return state;
    }

    restoreScrollState(state) {
        if (!state || !this.scrollEl) return;
        requestAnimationFrame(() => {
            if (!this.scrollEl) return;
            this.scrollEl.scrollTop = Number.isFinite(state.scrollTop) ? state.scrollTop : 0;
            ['chat', 'rp'].forEach((group) => {
                const listEl = this.findSessionList(group);
                if (listEl) {
                    const nextTop = Number(state.groupScrollTop?.[group] || 0);
                    listEl.scrollTop = Number.isFinite(nextTop) ? nextTop : 0;
                }
            });
            if (state.anchorSessionId && Number.isFinite(state.anchorOffsetTop)) {
                const anchorEl = this.findSessionElement(state.anchorSessionId);
                if (anchorEl) {
                    const nextOffsetTop = anchorEl.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
                    this.scrollEl.scrollTop += (nextOffsetTop - state.anchorOffsetTop);
                }
            }
        });
    }

    rerender(options = {}) {
        const scrollState = this.captureScrollState(options.focusSessionId || this.focusSessionId || '');
        this.render();
        this.restoreScrollState(scrollState);
    }

    /* ── render ── */

    render() {
        this.editorEl.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'pp-binding-stack';

        const profiles = this.getProfiles();
        const chatPresetList = this.getPresetList('chat');
        const rpPresetList = this.getPresetList('rp');
        const momentsPresetList = this.getPresetList('moments');

        this.renderModeCard(wrap, 'chat', '聊天默认', profiles, chatPresetList);
        this.renderModeCard(wrap, 'rp', '创意写作默认', profiles, rpPresetList);
        this.renderModeCard(wrap, 'moments', '动态任务默认', profiles, momentsPresetList);
        this.renderSessionGroup(wrap, 'chat', '聊天对话会话', '还没有聊天室或群聊。', profiles, chatPresetList);
        this.renderSessionGroup(wrap, 'rp', '创意写作会话', '还没有创意写作会话。', profiles, rpPresetList);

        this.editorEl.appendChild(wrap);
    }

    renderModeCard(wrap, mode, title, profiles, presetList) {
        const card = document.createElement('div');
        card.className = 'pp-binding-card';

        const head = document.createElement('div');
        head.className = 'pp-binding-card-head';
        head.innerHTML = `<div>
            <div class="pp-binding-card-title">${escapeHtml(title)}</div>
            <div class="pp-binding-card-sub">未在会话级覆盖时，此模式下所有会话使用此配置。</div>
        </div>`;
        card.appendChild(head);

        const itemWrap = document.createElement('div');
        itemWrap.style.cssText = 'margin-top:10px; border:1px solid var(--app-border-default); border-radius:14px; background:var(--app-surface-subtle); overflow:hidden;';

        const boundPresetId = this.store.getModeBindingId('openai', mode) || '';
        const bindingOrigin = String(this.store.getBindings('openai')?.modeBindingOrigins?.[mode] || '').trim();
        const isLegacyBinding = boundPresetId && bindingOrigin === 'legacy_migrated_mode_binding';
        const fallbackLabel = mode === 'rp' ? '跟随创意写作默认' : '跟随 APP 内建默认';
        const presetOptions = [{ value: '', label: fallbackLabel }, ...presetList];
        const presetSub = boundPresetId
            ? t(isLegacyBinding ? '沿用旧设置：{name}' : '已绑定：{name}', { name: this.getPresetName(boundPresetId) })
            : fallbackLabel;

        const row = document.createElement('div');
        row.className = 'pp-binding-item';
        row.innerHTML = `
            <div class="pp-binding-item-main">
                <div class="pp-binding-item-title">预设</div>
                <div class="pp-binding-item-sub">${escapeHtml(presetSub)}</div>
            </div>
        `;
        const presetBtn = document.createElement('button');
        presetBtn.type = 'button';
        presetBtn.className = `pp-binding-btn ${boundPresetId ? 'is-muted' : 'is-primary'}`;
        presetBtn.textContent = boundPresetId ? (isLegacyBinding ? '更改或清除' : '更改预设') : '绑定预设';
        presetBtn.addEventListener('click', () => {
            this.openSelectMenu(presetBtn, presetOptions, boundPresetId, (val) => {
                this.runTask(() => val
                    ? this.store.setModeBinding('openai', mode, val)
                    : this.store.clearModeBinding('openai', mode));
            });
        });
        row.appendChild(presetBtn);
        itemWrap.appendChild(row);

        const extras = document.createElement('div');
        extras.style.cssText = 'padding:8px 12px 10px; border-top:1px dashed var(--app-border-default); display:flex; flex-direction:column; gap:8px;';
        this.renderProfileRow(extras, profiles, {
            getId: () => this.store.getModeProfileId('openai', mode) || '',
            onSelect: (val) => val
                ? this.store.setModeProfile('openai', mode, val)
                : this.store.clearModeProfile('openai', mode),
        });

        const currentProfileId = this.store.getModeProfileId('openai', mode) || '';
        if (currentProfileId) {
            this.renderReasoningControls(extras, currentProfileId, {
                uiMode: mode,
                getReasoning: () => this.store.getModeReasoning('openai', mode),
                setReasoning: (r) => this.store.setModeReasoning('openai', mode, r),
                clearReasoning: () => this.store.clearModeReasoning('openai', mode),
            });
        }

        itemWrap.appendChild(extras);
        card.appendChild(itemWrap);
        wrap.appendChild(card);
    }

    renderSessionGroup(wrap, group, title, emptyText, profiles, presetList) {
        const card = document.createElement('div');
        card.className = 'pp-binding-card';

        const head = document.createElement('div');
        head.className = 'pp-binding-card-head';
        head.innerHTML = `<div>
            <div class="pp-binding-card-title">${escapeHtml(title)}</div>
            <div class="pp-binding-card-sub">会话级绑定优先于模式默认；不设置时使用该模式的默认预设。</div>
        </div>`;
        card.appendChild(head);

        const entries = this.getSessionEntries().filter((e) => e.group === group);
        if (this.expandedSessionByGroup[group] && !entries.some((entry) => entry.id === this.expandedSessionByGroup[group])) {
            this.expandedSessionByGroup[group] = '';
        }
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'pp-binding-empty';
            empty.textContent = emptyText;
            card.appendChild(empty);
            wrap.appendChild(card);
            return;
        }

        const list = document.createElement('div');
        list.className = 'pp-binding-list sc-session-list';
        list.dataset.sessionGroup = group;
        list.scrollTop = Number(this.groupScrollTop[group] || 0);
        list.addEventListener('scroll', () => {
            this.groupScrollTop[group] = Number(list.scrollTop || 0);
        });
        entries.forEach((entry) => this.renderSessionItem(list, entry, profiles, presetList));
        card.appendChild(list);
        wrap.appendChild(card);
    }

    renderSessionItem(list, entry, profiles, presetList) {
        const itemWrap = document.createElement('div');
        itemWrap.dataset.sessionId = entry.id;
        itemWrap.className = 'sc-session-entry';

        const boundPresetId = this.store.getSessionBindingId('openai', entry.id) || '';
        const resolved = this.store.getResolvedActive('openai', {
            sessionId: entry.id,
            uiMode: entry.group === 'rp' ? 'rp' : 'chat',
        });
        const resolvedName = String(resolved?.preset?.name || '').trim();
        const presetOptions = [{
            value: '',
            label: entry.group === 'rp' ? '跟随创意写作默认' : '跟随聊天默认',
        }, ...presetList];
        const currentProfileId = this.store.getSessionProfileId('openai', entry.id) || '';
        const currentProfileName = currentProfileId ? (this.getProfileName(currentProfileId) || currentProfileId) : t('跟随全局');
        const subtitle = boundPresetId
            ? t('已绑定预设：{name}', { name: this.getPresetName(boundPresetId) })
            : t('当前预设：{name}', { name: resolvedName || t('未设置') });

        const head = document.createElement('div');
        head.className = 'sc-session-head';

        const main = document.createElement('div');
        main.className = 'sc-session-main';
        main.innerHTML = `
            <div class="sc-session-titleline">
                <div class="pp-binding-item-title" data-i18n-skip>${escapeHtml(entry.name)}</div>
                <span class="sc-session-meta">${escapeHtml(entry.meta)}</span>
            </div>
            <div class="sc-session-sub">${escapeHtml(subtitle)}</div>
        `;
        const chipRow = document.createElement('div');
        chipRow.className = 'sc-session-chiprow';
        chipRow.innerHTML = `<span class="sc-session-chip">${escapeHtml(t('连线 {name}', { name: currentProfileName }))}</span>`;
        const reasoningSummary = this.getSessionReasoningSummary(entry, currentProfileId, resolved?.preset || {});
        if (reasoningSummary) {
            const chip = document.createElement('span');
            chip.className = 'sc-session-chip';
            chip.textContent = reasoningSummary;
            chipRow.appendChild(chip);
        }
        main.appendChild(chipRow);

        const presetBtn = document.createElement('button');
        presetBtn.type = 'button';
        presetBtn.className = `pp-binding-btn ${boundPresetId ? 'is-muted' : 'is-primary'}`;
        presetBtn.textContent = boundPresetId ? '更改预设' : '绑定预设';
        presetBtn.addEventListener('click', () => {
            this.openSelectMenu(presetBtn, presetOptions, boundPresetId, (val) => {
                this.runTask(() => val
                    ? this.store.setSessionBinding('openai', entry.id, val)
                    : this.store.clearSessionBinding('openai', entry.id), {
                    focusSessionId: entry.id,
                });
            });
        });
        const actionWrap = document.createElement('div');
        actionWrap.className = 'sc-session-actions';
        actionWrap.appendChild(presetBtn);
        head.appendChild(main);
        head.appendChild(actionWrap);
        itemWrap.appendChild(head);

        const extras = document.createElement('div');
        extras.className = 'sc-session-extras';

        this.renderProfileRow(extras, profiles, {
            getId: () => this.store.getSessionProfileId('openai', entry.id) || '',
            onSelect: (val) => val
                ? this.store.setSessionProfile('openai', entry.id, val)
                : this.store.clearSessionProfile('openai', entry.id),
            focusSessionId: entry.id,
        });

        if (currentProfileId) {
            this.renderReasoningControls(extras, currentProfileId, {
                sessionId: entry.id,
                uiMode: entry.group === 'rp' ? 'rp' : 'chat',
                getReasoning: () => this.store.getSessionReasoning('openai', entry.id),
                setReasoning: (r) => this.store.setSessionReasoning('openai', entry.id, r),
                clearReasoning: () => this.store.clearSessionReasoning('openai', entry.id),
                focusSessionId: entry.id,
            });
        }

        itemWrap.appendChild(extras);
        list.appendChild(itemWrap);
    }

    /* ── shared field renderers ── */

    getSessionReasoningSummary(entry, currentProfileId, resolvedPreset = {}) {
        if (!currentProfileId) return '';
        const profile = this.getProfileForReasoning(currentProfileId);
        if (!profile) return '';
        const cap = getReasoningCapability({ provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl });
        if (!cap.supported || !cap.requestControl) return '';
        const currentReasoning = this.store.getSessionReasoning('openai', entry.id) || null;
        const enabled = resolvedPreset.request_reasoning === true || currentReasoning?.request_reasoning === true;
        if (!enabled) return '推理 关闭';
        if (!cap.effortControl) return '推理 已启用';
        const effortValue = currentReasoning?.reasoning_effort || resolvedPreset.reasoning_effort || cap.effortOptions?.[0]?.value || '';
        const effortLabel = cap.effortOptions?.find((option) => option.value === effortValue)?.label || effortValue || '已启用';
        return `推理 ${effortLabel}`;
    }

    renderPresetRow(container, { currentPresetId, options, onSelect, focusSessionId = '' }) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px;';
        const label = document.createElement('span');
        label.style.cssText = 'font-size:12px; color:var(--app-text-muted); white-space:nowrap; flex-shrink:0;';
        label.textContent = '会话预设';
        row.appendChild(label);

        const current = options.find((option) => option.value === currentPresetId) || options[0];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'world-app-select-btn';
        btn.style.cssText = 'flex:1; min-width:0; min-height:32px; padding:5px 10px; font-size:12px;';
        btn.innerHTML = `
            <span class="pp-custom-select-label">${escapeHtml(current?.label || '跟随默认')}</span>
            <span class="world-app-select-btn-chevron">▾</span>
        `;
        btn.addEventListener('click', () => {
            this.openSelectMenu(btn, options, currentPresetId, (val) => {
                this.runTask(() => onSelect(val), { focusSessionId });
            });
        });
        row.appendChild(btn);
        container.appendChild(row);
    }

    renderProfileRow(container, profiles, { getId, onSelect, focusSessionId = '' }) {
        const currentProfileId = getId();
        const profileOptions = [
            { value: '', label: '跟随全局' },
            ...profiles.map((p) => ({ value: p.id, label: p.name || p.id })),
        ];
        const profileCurrent = profileOptions.find((o) => o.value === currentProfileId) || profileOptions[0];

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px;';
        const label = document.createElement('span');
        label.style.cssText = 'font-size:12px; color:var(--app-text-muted); white-space:nowrap; flex-shrink:0;';
        label.textContent = '连线配置';
        row.appendChild(label);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'world-app-select-btn';
        btn.style.cssText = 'flex:1; min-width:0; min-height:32px; padding:5px 10px; font-size:12px;';
        btn.innerHTML = `
            <span class="pp-custom-select-label">${escapeHtml(profileCurrent.label)}</span>
            <span class="world-app-select-btn-chevron">▾</span>
        `;
        btn.addEventListener('click', () => {
            this.openSelectMenu(btn, profileOptions, currentProfileId, (val) => {
                this.runTask(() => onSelect(val), { focusSessionId });
            });
        });
        row.appendChild(btn);
        container.appendChild(row);
    }

    renderReasoningControls(container, profileId, ctx) {
        const profile = this.getProfileForReasoning(profileId);
        if (!profile) return;
        const cap = getReasoningCapability({ provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl });
        if (!cap.supported || !cap.requestControl) return;

        const resolveCtx = {};
        if (ctx.sessionId) resolveCtx.sessionId = ctx.sessionId;
        if (ctx.uiMode) resolveCtx.uiMode = ctx.uiMode;
        const resolvedPreset = this.store.getResolvedActive('openai', resolveCtx)?.preset || {};
        const globalEnabled = resolvedPreset.request_reasoning === true;
        const currentR = ctx.getReasoning();

        const row = document.createElement('div');
        row.className = 'sc-reasoning-row';
        const rl = document.createElement('span');
        rl.className = 'sc-reasoning-label';
        rl.textContent = '推理请求';
        row.appendChild(rl);

        const controlWrap = document.createElement('div');
        controlWrap.className = 'sc-reasoning-controls';

        if (!globalEnabled) {
            const cbLabel = document.createElement('label');
            cbLabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; color:var(--app-text-primary); cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = currentR?.request_reasoning === true;
            cbLabel.appendChild(cb);
            cbLabel.appendChild(document.createTextNode('启用'));
            controlWrap.appendChild(cbLabel);

            if (cap.effortControl && currentR?.request_reasoning === true) {
                this.appendEffortButton(
                    controlWrap,
                    cap,
                    currentR?.reasoning_effort || 'high',
                    (v) => ctx.setReasoning({ request_reasoning: true, reasoning_effort: v }),
                    ctx.focusSessionId,
                );
            }

            cb.addEventListener('change', () => {
                this.runTask(() => cb.checked
                    ? ctx.setReasoning({ request_reasoning: true, reasoning_effort: currentR?.reasoning_effort || 'high' })
                    : ctx.clearReasoning(), {
                    focusSessionId: ctx.focusSessionId,
                });
            });
        } else if (cap.effortControl) {
            const effortVal = currentR?.reasoning_effort || resolvedPreset.reasoning_effort || 'high';
            this.appendEffortButton(
                controlWrap,
                cap,
                effortVal,
                (v) => ctx.setReasoning({ request_reasoning: true, reasoning_effort: v }),
                ctx.focusSessionId,
            );

            if (currentR) {
                const resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'pp-binding-btn is-muted';
                resetBtn.style.cssText = 'padding:3px 8px; min-height:26px; font-size:11px;';
                resetBtn.textContent = '重置';
                resetBtn.addEventListener('click', () => {
                    this.runTask(() => ctx.clearReasoning(), { focusSessionId: ctx.focusSessionId });
                });
                controlWrap.appendChild(resetBtn);
            }
        }

        row.appendChild(controlWrap);
        container.appendChild(row);
    }

    appendEffortButton(container, cap, effortVal, onEffortChange, focusSessionId = '') {
        const effortOptions = cap.effortOptions.map((o) => ({ value: o.value, label: o.label }));
        const effortCur = effortOptions.find((o) => o.value === effortVal) || effortOptions[0];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'world-app-select-btn';
        btn.style.cssText = 'flex:1; min-width:0; min-height:28px; padding:4px 10px; font-size:12px;';
        btn.innerHTML = `
            <span class="pp-custom-select-label">${escapeHtml(effortCur?.label || effortVal)}</span>
            <span class="world-app-select-btn-chevron">▾</span>
        `;
        btn.addEventListener('click', () => {
            this.openSelectMenu(btn, effortOptions, effortVal, (v) => {
                this.runTask(() => onEffortChange(v), { focusSessionId });
            });
        });
        container.appendChild(btn);
    }

    /* ── task ── */

    async runTask(fn, options = {}) {
        const focusSessionId = String(options?.focusSessionId || this.focusSessionId || '').trim();
        if (focusSessionId) {
            const group = focusSessionId.startsWith('rp:') ? 'rp' : 'chat';
            this.expandedSessionByGroup[group] = focusSessionId;
        }
        const scrollState = this.captureScrollState(focusSessionId);
        try {
            await fn();
            this.render();
            this.restoreScrollState(scrollState);
            window.dispatchEvent(new CustomEvent('preset-changed'));
        } catch (err) {
            logger.warn('session-config task failed', err);
            window.toastr?.error?.('操作失败');
        }
    }

    /* ── custom select menu ── */

    ensureSelectMenu() {
        return null;
    }

    closeCustomSelectMenu() {
        closeSharedCustomSelectMenu();
    }

    openSelectMenu(anchorEl, options, currentValue, onSelect) {
        if (!anchorEl) return;
        openCustomSelectMenu({
            anchorEl,
            options,
            currentValue,
            onSelect,
        });
    }
}
