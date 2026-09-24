/**
 * Regex Store (SillyTavern-like, scoped)
 * Scopes:
 *  1) global: always applies
 *  2) local: bound to preset/world (auto applies when bound target active)
 *  3) session: per chat session id
 */
import { logger } from '../utils/logger.js';

// ST-like placement enum (subset used by our app too)
export const regex_placement = {
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
};

export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

const getTauriInvoker = () => {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    return g?.__TAURI__?.core?.invoke || g?.__TAURI__?.invoke || g?.__TAURI_INVOKE__ || g?.__TAURI_INTERNALS__?.invoke;
};

const safeInvoke = async (cmd, args) => {
    const invoker = getTauriInvoker();
    if (typeof invoker !== 'function') {
        throw new Error('Tauri invoke not available');
    }
    return invoker(cmd, args);
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const loadKvWithRetry = async (name) => {
    const retryDelays = [40, 120];
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        try {
            return await safeInvoke('load_kv', { name });
        } catch (err) {
            lastError = err;
            if (attempt < retryDelays.length) await wait(retryDelays[attempt]);
        }
    }
    throw lastError || new Error('load_kv failed');
};

const STORE_KEY = 'regex_store_v1';

const genId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const clone = (v) => {
    try {
        return structuredClone(v);
    } catch {
        return JSON.parse(JSON.stringify(v));
    }
};

const ensureObj = (v, fallback) => (v && typeof v === 'object') ? v : fallback;
const ensureArr = (v) => Array.isArray(v) ? v : [];
const isNonEmptyObject = (value) => Boolean(value && typeof value === 'object' && Object.keys(value).length);
const isRegexStoreState = (value) => Boolean(
    value && typeof value === 'object' && (
        Object.prototype.hasOwnProperty.call(value, 'global') ||
        Object.prototype.hasOwnProperty.call(value, 'local') ||
        Object.prototype.hasOwnProperty.call(value, 'session')
    )
);

const ensureNumOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const uniqueStrings = (values = []) => {
    const out = [];
    const seen = new Set();
    (Array.isArray(values) ? values : [values]).forEach((value) => {
        const id = String(value || '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push(id);
    });
    return out;
};

const getPresetBindIds = (bind) => {
    if (!bind || typeof bind !== 'object' || bind.type !== 'preset') return [];
    return uniqueStrings([
        ...(Array.isArray(bind.presetIds) ? bind.presetIds : []),
        bind.presetId,
    ]);
};

const normalizeBind = (bind) => {
    if (!bind || typeof bind !== 'object') return null;
    if (bind.type === 'preset') {
        const presetType = String(bind.presetType || '').trim();
        const presetIds = getPresetBindIds(bind);
        if (!presetType || !presetIds.length) return null;
        const next = {
            type: 'preset',
            presetType,
            presetId: presetIds[0],
        };
        if (presetIds.length > 1 || Array.isArray(bind.presetIds)) next.presetIds = presetIds;
        return next;
    }
    if (bind.type === 'world') {
        const worldId = String(bind.worldId || '').trim();
        return worldId ? { type: 'world', worldId } : null;
    }
    return null;
};

const normalizeRulePlacement = (rule = {}, { legacyDefaultBoth = false } = {}) => {
    if (Array.isArray(rule.placement)) {
        return rule.placement.map((value) => Number(value)).filter(Number.isFinite);
    }

    const source = rule.source && typeof rule.source === 'object' ? rule.source : null;
    if (source) {
        const placement = [];
        if (source.user_input) placement.push(regex_placement.USER_INPUT);
        if (source.ai_output) placement.push(regex_placement.AI_OUTPUT);
        if (source.slash_command) placement.push(regex_placement.SLASH_COMMAND);
        if (source.world_info) placement.push(regex_placement.WORLD_INFO);
        if (source.reasoning) placement.push(regex_placement.REASONING);
        return placement;
    }

    const when = String(rule.when || '').trim().toLowerCase();
    if (when === 'input') return [regex_placement.USER_INPUT];
    if (when === 'output') return [regex_placement.AI_OUTPUT];
    if (when === 'both' || legacyDefaultBoth) {
        return [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT];
    }
    return [];
};

/**
 * Canonical regex-rule normalization shared by storage and every import path.
 * Accepts ST camelCase, TavernHelper snake_case, and legacy pattern rules.
 */
export const normalizeRegexRule = (rule = {}) => {
    const r = rule && typeof rule === 'object' ? rule : {};
    const hasFindRegex = Object.prototype.hasOwnProperty.call(r, 'findRegex')
        || Object.prototype.hasOwnProperty.call(r, 'find_regex');
    const legacyRule = !hasFindRegex && (
        Object.prototype.hasOwnProperty.call(r, 'pattern')
        || Object.prototype.hasOwnProperty.call(r, 'when')
        || Object.prototype.hasOwnProperty.call(r, 'replacement')
    );
    const pattern = legacyRule ? String(r.pattern || '') : '';
    const flags = legacyRule
        ? ((r.flags === undefined || r.flags === null) ? 'g' : String(r.flags))
        : '';
    const findRegex = legacyRule
        ? (pattern ? `/${pattern}/${flags}` : '')
        : String(r.findRegex || r.find_regex || '');
    const destination = r.destination && typeof r.destination === 'object' ? r.destination : {};
    const hasEnabled = typeof r.enabled === 'boolean';
    const hasDisabled = typeof r.disabled === 'boolean';
    const substituteRegex = Number(r.substituteRegex ?? r.substitute_regex ?? 0);

    return {
        id: r.id || genId('re'),
        scriptName: String(r.scriptName || r.script_name || r.name || '').trim(),
        findRegex,
        replaceString: String(r.replaceString ?? r.replace_string ?? r.replacement ?? ''),
        trimStrings: ensureArr(r.trimStrings || r.trim_strings).map((value) => String(value || '')).filter(Boolean),
        placement: normalizeRulePlacement(r, { legacyDefaultBoth: legacyRule }),
        disabled: hasDisabled ? r.disabled : (hasEnabled ? !r.enabled : false),
        markdownOnly: Boolean(r.markdownOnly ?? r.markdown_only ?? destination.display),
        promptOnly: Boolean(r.promptOnly ?? r.prompt_only ?? destination.prompt),
        runOnEdit: Boolean(r.runOnEdit ?? r.run_on_edit),
        substituteRegex: substituteRegex === 1 || substituteRegex === 2
            ? substituteRegex
            : substitute_find_regex.NONE,
        minDepth: ensureNumOrNull(r.minDepth ?? r.min_depth),
        maxDepth: ensureNumOrNull(r.maxDepth ?? r.max_depth),
    };
};

const normalizeRule = normalizeRegexRule;

const normalizeLocalSet = (s = {}) => {
    const bind = normalizeBind(s.bind);
    const manualEnabled = (typeof s.manualEnabled === 'boolean')
        ? s.manualEnabled
        : (bind ? true : (s.enabled !== false));
    return {
        id: s.id || genId('re-set'),
        name: String(s.name || '未命名正则').trim() || '未命名正则',
        // bind: null | { type:'preset', presetType, presetId, presetIds? } | { type:'world', worldId }
        bind,
        // Legacy note:
        // older sync logic rewrote `enabled` for bound sets based on the currently active preset/world,
        // which breaks mode/session-bound matching. Persist a dedicated manual switch and treat old bound
        // records as enabled-by-default unless the user explicitly saved `manualEnabled`.
        enabled: manualEnabled,
        manualEnabled,
        rules: ensureArr(s.rules).map(normalizeRule),
        createdAt: Number.isFinite(Number(s.createdAt)) ? Number(s.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(s.updatedAt)) ? Number(s.updatedAt) : Date.now(),
    };
};

const makeDefaultState = () => ({
    version: 1,
    global: {
        enabled: true,
        rules: [],
    },
    local: {
        order: [],
        sets: {},
    },
    session: {}, // sessionId -> { enabled, rules }
});

const matchBind = (bind, ctx) => {
    if (!bind || typeof bind !== 'object') return false;
    const type = bind.type;
    if (type === 'preset') {
        const pt = String(bind.presetType || '');
        const ids = getPresetBindIds(bind);
        const activeId = String(ctx?.activePresets?.[pt] || '').trim();
        if (!pt || !ids.length || !activeId) return false;
        return ids.includes(activeId);
    }
    if (type === 'world') {
        const wid = String(bind.worldId || '');
        if (!wid) return false;
        const primary = String(ctx?.worldId || '');
        if (primary === wid) return true;
        const list = Array.isArray(ctx?.worldIds) ? ctx.worldIds.map(String) : [];
        return list.includes(wid);
    }
    return false;
};

// Match SillyTavern's regex priority: preset transforms run before character-scoped transforms.
// Keep insertion order within each scope so recovery/import order cannot invert the scope priority.
const LOCAL_BIND_EXECUTION_ORDER = ['preset', 'world'];

export const isLocalRegexSetAutoActive = (set, ctx = {}) => {
    if (!set || typeof set !== 'object') return false;
    if (set.manualEnabled === false) return false;
    const bind = set.bind;
    if (!bind || typeof bind !== 'object') return false;
    return matchBind(bind, ctx);
};

export class RegexStore {
    constructor() {
        this.state = null;
        this.isLoaded = false;
        this.persistenceBlocked = false;
        this.ready = this.load();
    }

    async load() {
        if (this.isLoaded && this.state) return this.state;

        let state = null;
        let skipPersistOnLoad = false;
        let kvReadFailed = false;
        const expectsKv = typeof getTauriInvoker() === 'function';
        try {
            const kv = await loadKvWithRetry(STORE_KEY);
            if (isRegexStoreState(kv)) {
                state = kv;
            } else if (isNonEmptyObject(kv)) {
                skipPersistOnLoad = true;
                if (kv._tooLarge) {
                    logger.warn('regex store load_kv payload too large; skip startup overwrite', kv);
                } else {
                    logger.warn('regex store load_kv payload invalid; skip startup overwrite', kv);
                }
            }
        } catch (err) {
            kvReadFailed = expectsKv;
            logger.debug('load_kv regex store failed (可能非 Tauri)', err);
        }

        if (!state) {
            try {
                const raw = localStorage.getItem(STORE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (isRegexStoreState(parsed)) state = parsed;
                }
            } catch {}
        }

        this.persistenceBlocked = kvReadFailed || skipPersistOnLoad;
        const persistLoadedState = async (next) => {
            if (this.persistenceBlocked) {
                this.state = next;
                return;
            }
            await this.persist(next);
        };
        if (!state || typeof state !== 'object') {
            state = makeDefaultState();
            await persistLoadedState(state);
        } else {
            state.version = 1;
            state.global = ensureObj(state.global, { enabled: true, rules: [] });
            state.global.enabled = state.global.enabled !== false;
            state.global.rules = ensureArr(state.global.rules).map(normalizeRule);

            state.local = ensureObj(state.local, { order: [], sets: {} });
            state.local.order = ensureArr(state.local.order);
            state.local.sets = ensureObj(state.local.sets, {});

            // normalize sets and order
            const normalizedSets = {};
            for (const [id, s] of Object.entries(state.local.sets)) {
                const next = normalizeLocalSet({ ...s, id });
                normalizedSets[next.id] = next;
            }
            state.local.sets = normalizedSets;
            const existingIds = new Set(Object.keys(state.local.sets));
            state.local.order = state.local.order.filter(id => existingIds.has(id));
            for (const id of existingIds) {
                if (!state.local.order.includes(id)) state.local.order.push(id);
            }

            state.session = ensureObj(state.session, {});
            for (const [sid, v] of Object.entries(state.session)) {
                const obj = ensureObj(v, {});
                state.session[sid] = {
                    enabled: obj.enabled !== false,
                    rules: ensureArr(obj.rules).map(normalizeRule),
                };
            }

            await persistLoadedState(state);
        }

        this.state = state;
        this.isLoaded = true;
        return this.state;
    }

    assertWritable() {
        if (!this.persistenceBlocked) return;
        const error = new Error('正则存储暂时无法读取，已阻止写入以保护现有数据。请重新载入 APP 后重试。');
        error.code = 'regex_store_read_unavailable';
        throw error;
    }

    async persist(next = this.state) {
        this.assertWritable();
        this.state = next;
        try {
            await safeInvoke('save_kv', { name: STORE_KEY, data: this.state });
        } catch (err) {
            logger.warn('save_kv regex store failed (可能非 Tauri)，回退 localStorage', err);
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify(this.state));
            } catch {}
        }
    }

    getState() {
        return this.state ? clone(this.state) : null;
    }

    /* ---------------- Global ---------------- */
    getGlobal() {
        return clone(this.state?.global || { enabled: true, rules: [] });
    }

    async setGlobal(next) {
        await this.ready;
        this.assertWritable();
        this.state.global = {
            enabled: next?.enabled !== false,
            rules: ensureArr(next?.rules).map(normalizeRule),
        };
        await this.persist();
        return this.getGlobal();
    }

    /* ---------------- Local sets ---------------- */
    // filter 在复制前以只读方式筛选（不得修改传入的 set），只复制命中的规则集
    listLocalSets(filter = null) {
        const order = ensureArr(this.state?.local?.order);
        const sets = ensureObj(this.state?.local?.sets, {});
        const list = order.map(id => sets[id]).filter(Boolean);
        return (typeof filter === 'function' ? list.filter(set => filter(set)) : list).map(clone);
    }

    listLocalSetSummaries() {
        const order = ensureArr(this.state?.local?.order);
        const sets = ensureObj(this.state?.local?.sets, {});
        return order.map(id => sets[id]).filter(Boolean).map(setObj => ({
            id: setObj.id,
            name: setObj.name,
            manualEnabled: setObj.manualEnabled,
            enabled: setObj.enabled,
            bind: setObj.bind ? clone(setObj.bind) : null,
            updatedAt: setObj.updatedAt,
            rules: ensureArr(setObj.rules).map(rule => ({
                scriptName: String(rule?.scriptName || rule?.script_name || rule?.name || '').trim(),
                placement: ensureArr(rule?.placement).map(Number).filter(Number.isFinite),
                disabled: rule?.disabled === true,
            })),
        }));
    }

    getLocalSet(id) {
        const s = this.state?.local?.sets?.[id];
        return s ? clone(s) : null;
    }

    async upsertLocalSet({ id, name, enabled, bind, rules }) {
        await this.ready;
        this.assertWritable();
        const prev = id ? this.state?.local?.sets?.[id] : null;
        const next = normalizeLocalSet({
            ...(prev || {}),
            id,
            name,
            bind,
            rules,
            manualEnabled: enabled !== false,
            updatedAt: Date.now(),
        });
        this.state.local ||= { order: [], sets: {} };
        this.state.local.sets ||= {};
        this.state.local.order ||= [];
        this.state.local.sets[next.id] = next;
        if (!this.state.local.order.includes(next.id)) this.state.local.order.push(next.id);
        await this.persist();
        return next.id;
    }

    async removeLocalSet(id) {
        await this.ready;
        this.assertWritable();
        if (!id) return;
        delete this.state?.local?.sets?.[id];
        if (Array.isArray(this.state?.local?.order)) {
            this.state.local.order = this.state.local.order.filter(x => x !== id);
        }
        await this.persist();
    }

    /**
     * Auto-enable preset-bound local sets for the currently active preset,
     * and auto-disable preset-bound sets for inactive presets (same presetType).
     *
     * This matches the product requirement: switching presets automatically switches bound regex.
     */
    async syncPresetBindings(activePresets = {}) {
        await this.ready;
        this.assertWritable();
        const sets = ensureObj(this.state?.local?.sets, {});
        let changed = false;
        for (const s of Object.values(sets)) {
            if (!s || typeof s !== 'object') continue;
            const bind = s.bind;
            if (!bind || typeof bind !== 'object' || bind.type !== 'preset') continue;
            const pt = String(bind.presetType || '').trim();
            const ids = getPresetBindIds(bind);
            if (!pt || !ids.length) continue;
            const shouldEnable = ids.includes(String(activePresets?.[pt] || '').trim());
            if (s.enabled !== shouldEnable) {
                s.enabled = shouldEnable;
                s.updatedAt = Date.now();
                changed = true;
            }
        }
        if (changed) await this.persist();
        return changed;
    }

    async syncWorldBindings(activeWorldIds = []) {
        await this.ready;
        this.assertWritable();
        const ids = new Set(
            (Array.isArray(activeWorldIds) ? activeWorldIds : [activeWorldIds])
                .map(v => String(v || '').trim())
                .filter(Boolean),
        );
        const sets = ensureObj(this.state?.local?.sets, {});
        let changed = false;
        for (const s of Object.values(sets)) {
            if (!s || typeof s !== 'object') continue;
            const bind = s.bind;
            if (!bind || typeof bind !== 'object' || bind.type !== 'world') continue;
            const wid = String(bind.worldId || '').trim();
            if (!wid) continue;
            const shouldEnable = ids.has(wid);
            if (s.enabled !== shouldEnable) {
                s.enabled = shouldEnable;
                s.updatedAt = Date.now();
                changed = true;
            }
        }
        if (changed) await this.persist();
        return changed;
    }

    /* ---------------- Session ---------------- */
    getSession(sessionId) {
        const sid = String(sessionId || '');
        if (!sid) return { enabled: true, rules: [] };
        const v = this.state?.session?.[sid];
        if (!v) return { enabled: true, rules: [] };
        return clone(v);
    }

    async setSession(sessionId, next) {
        await this.ready;
        this.assertWritable();
        const sid = String(sessionId || '');
        if (!sid) return;
        this.state.session ||= {};
        this.state.session[sid] = {
            enabled: next?.enabled !== false,
            rules: ensureArr(next?.rules).map(normalizeRule),
        };
        await this.persist();
        return this.getSession(sid);
    }

    /* ---------------- Apply ---------------- */
    computeActiveRules(ctx = {}) {
        const out = [];

        const g = this.state?.global;
        if (g?.enabled !== false) {
            for (const r of ensureArr(g?.rules)) {
                if (!r) continue;
                out.push(r);
            }
        }

        const sets = ensureObj(this.state?.local?.sets, {});
        const order = ensureArr(this.state?.local?.order);
        for (const bindType of LOCAL_BIND_EXECUTION_ORDER) {
            for (const id of order) {
                const s = sets[id];
                if (!s || s.manualEnabled === false) continue;
                const bind = s.bind;
                // local set without bind: treat as disabled by default (to keep "局部"语义清晰)
                if (!bind || bind.type !== bindType) continue;
                if (!matchBind(bind, ctx)) continue;
                for (const r of ensureArr(s.rules)) {
                    if (!r) continue;
                    const override = bind.type === 'preset' && bind.presetType === 'openai'
                        ? ctx.presetRegexOverrides?.find(item => item.__chatappSetId === id && item.id === r.id)
                        : null;
                    out.push(override ? { ...r, disabled: override.enabled === false } : r);
                }
            }
        }

        const sid = String(ctx?.sessionId || '');
        const ses = sid ? this.state?.session?.[sid] : null;
        if (ses?.enabled !== false) {
            for (const r of ensureArr(ses?.rules)) {
                if (!r) continue;
                out.push(r);
            }
        }

        return out.map(normalizeRule);
    }

    regexFromString(input) {
        try {
            const str = String(input ?? '');
            // Same parser as ST: /(\/?)(.+)\1([a-z]*)/i
            const m = str.match(/(\/?)(.+)\1([a-z]*)/i);
            if (!m) return;
            // Invalid flags => let RegExp throw
            if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
                return RegExp(str);
            }
            return new RegExp(m[2], m[3]);
        } catch {
            return;
        }
    }

    sanitizeRegexMacro(x) {
        return (x && typeof x === 'string') ?
            x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
                switch (s) {
                    case '\n': return '\\\\n';
                    case '\r': return '\\\\r';
                    case '\t': return '\\\\t';
                    case '\v': return '\\\\v';
                    case '\f': return '\\\\f';
                    case '\0': return '\\\\0';
                    default: return '\\\\' + s;
                }
            }) : x;
    }

    applyMacros(text, vars, { escape = false } = {}) {
        const raw = String(text ?? '');
        if (!raw) return '';
        const normalizeKey = (val) => String(val || '').trim();
        const isMacroLookupKey = (val) => {
            const rawKey = normalizeKey(val);
            if (!rawKey) return false;
            const lower = rawKey.toLowerCase();
            const lookupBody = lower.startsWith('getvar::')
                ? rawKey.slice(8)
                : lower.startsWith('getvar:')
                    ? rawKey.slice(7)
                    : rawKey;
            const body = String(lookupBody || '').trim();
            if (!body) return false;
            return /^(?:[\p{L}_$][\p{L}\p{N}_$]*|\d+)(?:(?:\.(?:[\p{L}_$][\p{L}\p{N}_$]*|\d+))|(?:\[(?:\d+|["'][^"'\\]+["'])\]))*$/u.test(body);
        };
        const toPath = (val) => {
            const rawKey = normalizeKey(val);
            if (!rawKey) return [];
            const bracketed = rawKey.replace(/\[([^\]]+)\]/g, '.$1');
            return bracketed
                .split('.')
                .map(seg => seg.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        };
        const getByPath = (obj, key) => {
            const parts = toPath(key);
            if (!parts.length) return undefined;
            let cur = obj;
            for (const part of parts) {
                if (cur === null || cur === undefined) return undefined;
                const idx = /^\d+$/.test(part) ? Number(part) : null;
                if (idx !== null && Array.isArray(cur)) {
                    cur = cur[idx];
                    continue;
                }
                if (typeof cur !== 'object') return undefined;
                if (!(part in cur)) return undefined;
                cur = cur[part];
            }
            return cur;
        };
        const formatValue = (value) => {
            if (value === null || value === undefined) return '';
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };
        return raw.replace(/{{\s*([^}]+)\s*}}/g, (full, rawKey) => {
            const key = normalizeKey(rawKey);
            if (!key) return '';
            // Only expand variable-like lookup keys. Preserve JSX / CSS object literals
            // such as `style={{flex: 1}}` or `style={{fontSize:'10px'}}`.
            if (!isMacroLookupKey(key)) return full;
            const lower = key.toLowerCase();
            let lookupKey = key;
            if (lower.startsWith('getvar::')) lookupKey = key.slice(8);
            else if (lower.startsWith('getvar:')) lookupKey = key.slice(7);
            const value = getByPath(vars, lookupKey);
            const out = formatValue(value);
            return escape ? this.sanitizeRegexMacro(out) : out;
        });
    }

    filterString(rawString, trimStrings = [], vars) {
        let out = String(rawString ?? '');
        (Array.isArray(trimStrings) ? trimStrings : []).forEach((t) => {
            const sub = this.applyMacros(String(t || ''), vars, { escape: false });
            if (!sub) return;
            out = out.split(sub).join('');
        });
        return out;
    }

    runRegexScript(script, rawString, vars) {
        let newString = String(rawString ?? '');
        if (!script || script.disabled || !script.findRegex || !newString) return newString;
        const STATUS_TOKEN = '__CHATAPP_STATUS__';

        const getRegexString = () => {
            const mode = Number(script.substituteRegex ?? 0);
            switch (mode) {
                case substitute_find_regex.NONE:
                    return script.findRegex;
                case substitute_find_regex.RAW:
                    return this.applyMacros(script.findRegex, vars, { escape: false });
                case substitute_find_regex.ESCAPED:
                    return this.applyMacros(script.findRegex, vars, { escape: true });
                default:
                    return script.findRegex;
            }
        };

        const regexString = getRegexString();
        const findRegex = this.regexFromString(regexString);
        if (!findRegex) return newString;

        newString = newString.replace(findRegex, function () {
            const args = [...arguments];
            const replaceString = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
            const replaceWithGroups = replaceString.replace(/\$(\d+)|\$<([^>]+)>/g, (_m, num, groupName) => {
                let match = '';
                if (num) {
                    match = args[Number(num)] || '';
                } else if (groupName) {
                    const groups = args[args.length - 1];
                    match = (groups && typeof groups === 'object' && groups[groupName]) ? groups[groupName] : '';
                }
                if (!match) return '';
                return this.filterString(match, script.trimStrings, vars);
            });

            let replaced = replaceWithGroups;
            const statusInFind = /StatusPlaceHolderImpl/i.test(String(script.findRegex || ''));
            const statusInReplace = /StatusPlaceHolderImpl/i.test(String(script.replaceString || ''));
            if (statusInFind || statusInReplace) {
                const looksLikeScripted =
                    /<script\b/i.test(replaced) ||
                    /getAllVariables\s*\(/i.test(replaced) ||
                    /waitGlobalInitialized\s*\(/i.test(replaced) ||
                    /\bMvu\b/i.test(replaced) ||
                    /\beventOn\s*\(/i.test(replaced);
                const looksLikeHtml =
                    /```\\s*html/i.test(replaced) ||
                    /<html\b/i.test(replaced) ||
                    /<body\b/i.test(replaced) ||
                    /<style\b/i.test(replaced) ||
                    /<div\b/i.test(replaced) ||
                    /<iframe\b/i.test(replaced) ||
                    /<svg\b/i.test(replaced);
                if (!looksLikeScripted && !looksLikeHtml) {
                    const statusRe = /<StatusPlaceHolderImpl\s*\/?>/gi;
                    if (statusRe.test(replaced)) {
                        replaced = replaced.replace(statusRe, STATUS_TOKEN);
                    } else {
                        const insertIdx = replaced.lastIndexOf('</');
                        if (insertIdx > -1) {
                            replaced = `${replaced.slice(0, insertIdx)}${STATUS_TOKEN}${replaced.slice(insertIdx)}`;
                        } else {
                            replaced = `${replaced}${STATUS_TOKEN}`;
                        }
                    }
                }
            }
            return this.applyMacros(replaced, vars, { escape: false });
        }.bind(this));

        return newString;
    }

    /**
     * ST-like apply:
     * - placement controls where it applies
     * - markdownOnly/promptOnly control ephemerality
     */
    apply(text, ctx = {}, placement, { isMarkdown = false, isPrompt = false, isEdit = false, depth } = {}) {
        const raw = String(text ?? '');
        if (!raw) return raw;
        const scripts = this.computeActiveRules(ctx);
        const vars = ctx?.macroVars || {};
        let out = raw;

        const p = Number(placement);
        for (const s of scripts) {
            if (!s || s.disabled) continue;

            const mdOnly = Boolean(s.markdownOnly);
            const prOnly = Boolean(s.promptOnly);
            const allow =
                (mdOnly && isMarkdown) ||
                (prOnly && isPrompt) ||
                (!mdOnly && !prOnly && (isPrompt || (!isMarkdown && !isPrompt)));
            if (!allow) continue;

            if (isEdit && !s.runOnEdit) continue;

            if (typeof depth === 'number' && Number.isFinite(depth)) {
                const minD = (typeof s.minDepth === 'number' && Number.isFinite(s.minDepth)) ? s.minDepth : null;
                const maxD = (typeof s.maxDepth === 'number' && Number.isFinite(s.maxDepth)) ? s.maxDepth : null;
                if (minD !== null && minD >= -1 && depth < minD) continue;
                if (maxD !== null && maxD >= 0 && depth > maxD) continue;
                if (minD !== null && maxD !== null && maxD < minD) continue;
            }

            const placements = Array.isArray(s.placement) ? s.placement : [];
            if (Number.isFinite(p) && placements.length && !placements.includes(p)) continue;

            out = this.runRegexScript(s, out, vars);
        }

        return out;
    }
}
