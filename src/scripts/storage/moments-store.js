import { initializeProtocolMessageTime, preserveMessageDisplayTime } from '../utils/chat-time-policy.js';

/**
 * Moments (动态) store - simplified
 * - Persists to disk (Tauri save_kv/load_kv) with localStorage fallback
 * - Stores parsed moments from AI output (moment_start...moment_end) and replies
 */

import { logger } from '../utils/logger.js';
import { makeScopedKey, normalizeScopeId } from './store-scope.js';

const isQuotaError = (err) => {
    try {
        const name = String(err?.name || '');
        const msg = String(err?.message || '');
        return name === 'QuotaExceededError'
            || name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || Number(err?.code) === 22
            || /quota/i.test(msg);
    } catch {
        return false;
    }
};

const getInvoker = () => {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    return g?.__TAURI__?.core?.invoke || g?.__TAURI__?.invoke || g?.__TAURI_INVOKE__ || g?.__TAURI_INTERNALS__?.invoke;
};

const waitForInvoker = async (timeoutMs = 5000) => {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    if (!g?.__TAURI__) return null;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const inv = getInvoker();
        if (typeof inv === 'function') return inv;
        await new Promise(r => setTimeout(r, 50));
    }
    return null;
};

const safeInvoke = async (cmd, args) => {
    const invoker = getInvoker() || await waitForInvoker();
    if (typeof invoker !== 'function') throw new Error('Tauri invoke not available');
    return invoker(cmd, args);
};

const BASE_STORE_KEY = 'moments_store_v1';
const LEGACY_MIGRATION_KEY = `${BASE_STORE_KEY}__scoped_migrated`;

const isLegacyMigrated = () => {
    try {
        return localStorage.getItem(LEGACY_MIGRATION_KEY) === '1';
    } catch {
        return false;
    }
};

const markLegacyMigrated = () => {
    try {
        localStorage.setItem(LEGACY_MIGRATION_KEY, '1');
    } catch {}
};

const readLocalState = (key) => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

const clone = (v) => {
    try {
        return structuredClone(v);
    } catch {
        return JSON.parse(JSON.stringify(v));
    }
};

const genId = (prefix = 'moment') => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const normalizeGeneratedImages = (items = []) => {
    const seen = new Set();
    const out = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const output = item.output && typeof item.output === 'object' ? item.output : {};
        const path = String(output.path || item.path || '').trim();
        const url = String(output.url || item.url || '').trim();
        const dataUrl = String(output.dataUrl || '').trim();
        if (!path && !url && !dataUrl) return;
        const id = String(item.id || '').trim() || path || url || dataUrl.slice(0, 80);
        const key = id || path || url || dataUrl.slice(0, 80);
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        out.push({
            id,
            kind: 'image',
            provider: String(item.provider || '').trim(),
            model: String(item.model || '').trim(),
            prompt: String(item.prompt || '').trim(),
            output: {
                path,
                url,
                dataUrl,
                mime: String(output.mime || item.mime || '').trim(),
                bytes: Number(output.bytes || item.bytes || 0) || 0,
            },
            status: String(item.status || 'succeeded').trim() || 'succeeded',
            token: String(item.token || '').trim(),
            sourceMomentId: String(item.sourceMomentId || '').trim(),
            createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
        });
    });
    return out;
};

const normalizeMentions = (items = []) => {
    const seen = new Set();
    const out = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const id = String(item.id || item.sessionId || '').trim();
        const name = String(item.name || item.label || id).trim();
        if (!id && !name) return;
        if (id.toLowerCase().startsWith('rp:') || name.toLowerCase().startsWith('rp:')) return;
        const type = item.type === 'group' || item.isGroup === true || id.startsWith('group:')
            ? 'group'
            : 'contact';
        const key = `${type}:${id || name}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ id, name: name || id, type });
    });
    return out;
};

export class MomentsStore {
    constructor({ scopeId = '' } = {}) {
        this.scopeId = normalizeScopeId(scopeId);
        this.storeKey = makeScopedKey(BASE_STORE_KEY, this.scopeId);
        this._scopeToken = 0;
        this.state = this._load();
        this._normalizeState();
        this._pendingDiskSave = Promise.resolve();
        this.lastDiskError = '';
        this._diskBacked = false;
        this._lsDisabled = false;
        this._lsQuotaWarned = false;
        this._hydrateRetryCount = 0;
        this.ready = this._hydrateFromDisk();
    }

    _normalizeState() {
        try {
            const list = Array.isArray(this.state?.moments) ? this.state.moments : [];
            list.forEach((m) => {
                if (!m || typeof m !== 'object') return;
                const momentRegexMode = String(m.regexMode || '').trim().toLowerCase();
                m.regexMode = momentRegexMode === 'input' ? 'input' : 'output';
                if (typeof m.authorAvatar === 'string') {
                    m.authorAvatar = this._sanitizeAvatarForStore(m.authorAvatar);
                }
                m.generatedImages = normalizeGeneratedImages(m.generatedImages);
                m.mentions = normalizeMentions(m.mentions);
                m.userLiked = Boolean(m.userLiked);
                // Ensure comment ids for stable delete operations
                if (Array.isArray(m.comments)) {
                    m.comments = m.comments.map((c) => {
                        if (!c || typeof c !== 'object') return c;
                        const next = !c.id ? { ...c, id: genId('comment') } : { ...c };
                        const commentRegexMode = String(next.regexMode || '').trim().toLowerCase();
                        next.regexMode = commentRegexMode === 'input'
                            ? 'input'
                            : String(next.author || '').trim() === '我'
                                ? 'input'
                                : 'output';
                        return next;
                    });
                }
            });
        } catch (err) {
            logger.warn('moments store normalize failed', err);
        }
    }

    _load() {
        const data = readLocalState(this.storeKey);
        if (data) {
            if (this.scopeId) markLegacyMigrated();
            return data;
        }
        if (this.scopeId && !isLegacyMigrated()) {
            const legacy = readLocalState(BASE_STORE_KEY);
            if (legacy) {
                markLegacyMigrated();
                return legacy;
            }
        }
        return { moments: [] };
    }

    async _hydrateFromDisk() {
        const token = this._scopeToken;
        const storeKey = this.storeKey;
        const scopeId = this.scopeId;
        try {
            let kv = await safeInvoke('load_kv', { name: storeKey });
            if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
            if (!kv && this.scopeId && !isLegacyMigrated()) {
                const legacy = await safeInvoke('load_kv', { name: BASE_STORE_KEY });
                if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
                if (legacy && typeof legacy === 'object' && Array.isArray(legacy.moments)) {
                    kv = legacy;
                    markLegacyMigrated();
                    try {
                        await safeInvoke('save_kv', { name: storeKey, data: legacy });
                    } catch (err) {
                        logger.debug('moments store legacy migrate failed (可能非 Tauri)', err);
                    }
                }
            }
            if (kv && typeof kv === 'object' && Array.isArray(kv.moments)) {
                if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
                this.state = kv;
                this._normalizeState();
                this._diskBacked = true;
                if (this.scopeId) markLegacyMigrated();
                try { localStorage.removeItem(storeKey); } catch {}
                logger.debug('moments store hydrated from disk');
                try {
                    window.dispatchEvent(new CustomEvent('store-hydrated', { detail: { store: 'moments' } }));
                } catch {}
            }
        } catch (err) {
            this.lastDiskError = String(err?.message || err || '');
            logger.debug('moments store disk load skipped (可能非 Tauri)', err);
            try {
                const g = typeof globalThis !== 'undefined' ? globalThis : window;
                const msg = String(err?.message || '');
                const canRetry = Boolean(g?.__TAURI__) && msg.includes('invoke not available');
                if (token === this._scopeToken && canRetry && this._hydrateRetryCount < 3) {
                    const attempt = ++this._hydrateRetryCount;
                    logger.warn(`moments store hydrate retry scheduled (${attempt}/3)`);
                    setTimeout(() => { this._hydrateFromDisk(); }, 800 * attempt);
                }
            } catch {}
        }
    }

    _sanitizeAvatarForStore(avatar) {
        const s = String(avatar || '').trim();
        if (!s) return '';
        // Avoid duplicating huge base64 blobs into moments file; rely on contactsStore for data: avatars.
        // (On mobile, large JSON can fail to persist and lead to "moments empty after restart".)
        if (s.startsWith('data:')) return '';
        return s;
    }

    _persist() {
        if (!this._diskBacked && !this._lsDisabled) {
            try { localStorage.setItem(this.storeKey, JSON.stringify(this.state)); } catch (err) {
                if (isQuotaError(err)) {
                    this._lsDisabled = true;
                    if (!this._lsQuotaWarned) {
                        this._lsQuotaWarned = true;
                        logger.warn('moments store: localStorage quota exceeded; disabling localStorage writes and relying on Tauri KV.', err);
                    }
                    try { localStorage.removeItem(this.storeKey); } catch {}
                } else {
                    logger.warn('moments store persist -> localStorage failed', err);
                }
            }
        }
        this._pendingDiskSave = this._pendingDiskSave
            .catch(() => {}) // keep chain alive
            .then(() => safeInvoke('save_kv', { name: this.storeKey, data: this.state }))
            .then(() => { this.lastDiskError = ''; })
            .catch((err) => {
                this.lastDiskError = String(err?.message || err || '');
                logger.warn('moments store save_kv failed (可能非 Tauri)', err);
            });
    }

    async flush() {
        await this._pendingDiskSave.catch(() => {});
        return true;
    }

    async setScope(scopeId = '') {
        const nextScope = normalizeScopeId(scopeId);
        if (nextScope === this.scopeId) return this.ready;
        await this.flush();
        this._scopeToken += 1;
        this.scopeId = nextScope;
        this.storeKey = makeScopedKey(BASE_STORE_KEY, this.scopeId);
        this._diskBacked = false;
        this._lsDisabled = false;
        this._lsQuotaWarned = false;
        this._hydrateRetryCount = 0;
        this.lastDiskError = '';
        this.state = this._load();
        this._normalizeState();
        this.ready = this._hydrateFromDisk();
        return this.ready;
    }

    list() {
        const list = Array.isArray(this.state.moments) ? this.state.moments : [];
        return list.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    get(id) {
        const list = Array.isArray(this.state.moments) ? this.state.moments : [];
        return list.find(m => m.id === id) || null;
    }

    upsert(moment) {
        if (!moment || typeof moment !== 'object') return null;
        const sig = String(moment.signature || '').trim();
        const list = Array.isArray(this.state.moments) ? this.state.moments : [];
        const existingBySig = sig ? list.find(x => String(x.signature || '').trim() === sig) : null;
        const id = String(moment.id || '').trim() || existingBySig?.id || genId('moment');
        const existingById = list.find(m => m && m.id === id) || null;
        const existing = existingById || existingBySig;
        if (moment.protocolTimeMode) {
            moment = { ...moment };
            if (existing) preserveMessageDisplayTime(moment, existing);
            else initializeProtocolMessageTime(moment, { timeMode: moment.protocolTimeMode, modelTime: moment.time });
        }

        // Patch-safe updates: only overwrite fields if provided, otherwise keep existing value.
        // (UI may call upsert with partial objects for backfill/migration.)
        const authorId = hasOwn(moment, 'authorId') ? String(moment.authorId || '').trim() : (existingById?.authorId || existingBySig?.authorId || '');
        const author = hasOwn(moment, 'author') ? String(moment.author || '').trim() : (existingById?.author || existingBySig?.author || '');
        const content = hasOwn(moment, 'content') ? String(moment.content || '') : (existingById?.content || existingBySig?.content || '');
        const time = hasOwn(moment, 'time') ? String(moment.time || '') : (existingById?.time || existingBySig?.time || '');
        const originSessionId = hasOwn(moment, 'originSessionId') ? String(moment.originSessionId || '').trim() : (existingById?.originSessionId || existingBySig?.originSessionId || '');
        const momentRegexModeRaw = hasOwn(moment, 'regexMode')
            ? String(moment.regexMode || '').trim().toLowerCase()
            : String(existingById?.regexMode || existingBySig?.regexMode || '').trim().toLowerCase();
        const regexMode = momentRegexModeRaw === 'input' ? 'input' : 'output';

        const views = hasOwn(moment, 'views')
            ? (Number.isFinite(Number(moment.views)) ? Number(moment.views) : 0)
            : (Number.isFinite(Number(existingById?.views)) ? Number(existingById.views) : (Number.isFinite(Number(existingBySig?.views)) ? Number(existingBySig.views) : 0));
        const likes = hasOwn(moment, 'likes')
            ? (Number.isFinite(Number(moment.likes)) ? Number(moment.likes) : 0)
            : (Number.isFinite(Number(existingById?.likes)) ? Number(existingById.likes) : (Number.isFinite(Number(existingBySig?.likes)) ? Number(existingBySig.likes) : 0));
        const userLiked = hasOwn(moment, 'userLiked')
            ? Boolean(moment.userLiked)
            : Boolean(existingById?.userLiked || existingBySig?.userLiked);

        const normalizeComments = (incoming = []) => {
            const list = Array.isArray(incoming) ? incoming : [];
            const used = new Set();
            const out = [];
            list.forEach((c) => {
                if (!c || typeof c !== 'object') return;
                const rawId = String(c.id || '').trim();
                const id = (rawId && !used.has(rawId)) ? rawId : genId('comment');
                used.add(id);
                const previous = existing?.comments?.find(item => item.id === id);
                const nextComment = { ...c };
                if (moment.protocolTimeMode) {
                    if (previous) preserveMessageDisplayTime(nextComment, previous);
                    else initializeProtocolMessageTime(nextComment, { timeMode: moment.protocolTimeMode, modelTime: c.time });
                }
                out.push({
                    id,
                    author: String(c.author || '').trim(),
                    content: String(c.content || ''),
                    regexMode: String(c.regexMode || '').trim().toLowerCase() === 'input'
                        ? 'input'
                        : String(c.author || '').trim() === '我'
                            ? 'input'
                            : 'output',
                    replyTo: String(c.replyTo || '').trim(),
                    replyToAuthor: String(c.replyToAuthor || '').trim(),
                    time: String(nextComment.time || ''),
                    ...(nextComment.meta?.chatTime ? { meta: { chatTime: nextComment.meta.chatTime } } : {}),
                    timestamp: Number.isFinite(Number(c.timestamp)) ? Number(c.timestamp) : Date.now(),
                });
            });
            return out;
        };

        const comments = hasOwn(moment, 'comments')
            ? normalizeComments(moment.comments)
            : normalizeComments(Array.isArray(existingById?.comments) ? existingById.comments : (Array.isArray(existingBySig?.comments) ? existingBySig.comments : []));
        const generatedImages = hasOwn(moment, 'generatedImages')
            ? normalizeGeneratedImages(moment.generatedImages)
            : normalizeGeneratedImages(Array.isArray(existingById?.generatedImages) ? existingById.generatedImages : (Array.isArray(existingBySig?.generatedImages) ? existingBySig.generatedImages : []));
        const mentions = hasOwn(moment, 'mentions')
            ? normalizeMentions(moment.mentions)
            : normalizeMentions(Array.isArray(existingById?.mentions) ? existingById.mentions : (Array.isArray(existingBySig?.mentions) ? existingBySig.mentions : []));

        const timestamp = moment.protocolTimeMode && existing
            ? existing.timestamp
            : hasOwn(moment, 'timestamp')
            ? (Number.isFinite(Number(moment.timestamp)) ? Number(moment.timestamp) : Date.now())
            : (Number.isFinite(Number(existingById?.timestamp)) ? Number(existingById.timestamp) : (Number.isFinite(Number(existingBySig?.timestamp)) ? Number(existingBySig.timestamp) : Date.now()));

        const signature = sig || existingById?.signature || existingBySig?.signature || `${author}\u0000${content}\u0000${time}`;
        const authorAvatarRaw = hasOwn(moment, 'authorAvatar')
            ? String(moment.authorAvatar || '')
            : String(existingById?.authorAvatar || existingBySig?.authorAvatar || '');
        const authorAvatar = this._sanitizeAvatarForStore(authorAvatarRaw);

        const next = {
            id,
            signature,
            authorId,
            author,
            authorAvatar,
            originSessionId,
            regexMode,
            content,
            time,
            ...((moment.meta?.chatTime || existing?.meta?.chatTime) ? { meta: { chatTime: moment.meta?.chatTime || existing.meta.chatTime } } : {}),
            views,
            likes,
            userLiked,
            comments,
            generatedImages,
            mentions,
            timestamp,
        };
        const idx = list.findIndex(m => m.id === id);
        if (idx === -1) list.push(next);
        else list[idx] = { ...list[idx], ...next };
        this.state.moments = list;
        this._persist();
        return next;
    }

    likeMoment(momentId) {
        const id = String(momentId || '').trim();
        if (!id) return null;
        const moment = this.get(id);
        if (!moment) return null;
        const likes = Number.isFinite(Number(moment.likes)) ? Number(moment.likes) : 0;
        const nextLiked = !moment.userLiked;
        const nextLikes = nextLiked ? likes + 1 : Math.max(0, likes - 1);
        return this.upsert({ id, likes: nextLikes, userLiked: nextLiked });
    }

    addMany(moments = []) {
        const added = [];
        (Array.isArray(moments) ? moments : []).forEach((m) => {
            const saved = this.upsert(m);
            if (saved) added.push(saved);
        });
        return added;
    }

    addComments(momentId, comments = []) {
        const id = String(momentId || '').trim();
        if (!id) return null;
        const m = this.get(id);
        if (!m) return null;
        const existing = Array.isArray(m.comments) ? m.comments.slice() : [];
        (Array.isArray(comments) ? comments : []).forEach((c) => {
            if (!c) return;
            const proposedId = String(c.id || '').trim();
            const cid = (proposedId && !existing.some(x => String(x?.id || '').trim() === proposedId))
                ? proposedId
                : genId('comment');
            existing.push({
                id: cid,
                author: String(c.author || '').trim(),
                content: String(c.content || ''),
                regexMode: String(c.regexMode || '').trim().toLowerCase() === 'input'
                    ? 'input'
                    : String(c.author || '').trim() === '我'
                        ? 'input'
                        : 'output',
                replyTo: String(c.replyTo || '').trim(),
                replyToAuthor: String(c.replyToAuthor || '').trim(),
                time: String(c.time || ''),
                ...(c.meta?.chatTime ? { meta: { chatTime: c.meta.chatTime } } : {}),
                timestamp: Number.isFinite(Number(c.timestamp)) ? Number(c.timestamp) : Date.now(),
            });
        });
        // Keep at most 50 comments
        const trimmed = existing.slice(-50);
        this.upsert({ ...m, comments: trimmed, timestamp: m.timestamp || Date.now() });
        return this.get(id);
    }

    removeComment(momentId, commentId) {
        const id = String(momentId || '').trim();
        const cid = String(commentId || '').trim();
        if (!id || !cid) return false;
        const m = this.get(id);
        if (!m) return false;
        const list = Array.isArray(m.comments) ? m.comments : [];
        const next = list.filter((c) => String(c?.id || '').trim() !== cid);
        if (next.length === list.length) return false;
        this.upsert({ id, comments: next });
        return true;
    }

    remove(momentId) {
        const id = String(momentId || '').trim();
        if (!id) return false;
        const list = Array.isArray(this.state.moments) ? this.state.moments : [];
        const next = list.filter(m => m && m.id !== id);
        if (next.length === list.length) return false;
        this.state.moments = next;
        this._persist();
        return true;
    }

    clearAll() {
        this.state.moments = [];
        this._persist();
    }

    exportState() {
        return clone(this.state);
    }

    importState(state = {}) {
        const next = state && typeof state === 'object' ? clone(state) : {};
        this.state = {
            moments: Array.isArray(next.moments) ? next.moments : [],
        };
        this._normalizeState();
        this._persist();
        return this.exportState();
    }
}
