import { safeInvoke } from '../utils/tauri.js';

// 脚本单独调用模型（酒馆 /api/backends/chat-completions/generate）的费用同意记录。
// 每个脚本一条，按脚本 id 存；记着同意时的代码指纹，代码改了就不算数、要再问一次。
// KV 档格式：{ version: 1, updatedAt, grants: { [scriptId]: { scriptId, scriptName, scope, scopeId, sourceName, fingerprint, grantedAt } } }
export const SCRIPT_MODEL_CONSENT_STORE_KEY = 'script_model_consent_v1';
const VERSION = 1;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const trim = (value, max = 200) => String(value ?? '').trim().slice(0, max);

const normalizeGrant = (value) => {
  if (!isPlainObject(value)) return null;
  const scriptId = trim(value.scriptId);
  const fingerprint = trim(value.fingerprint, 100);
  if (!scriptId || !fingerprint) return null;
  const scope = ['global', 'character', 'preset'].includes(value.scope) ? value.scope : 'global';
  return {
    scriptId,
    scriptName: trim(value.scriptName),
    scope,
    scopeId: trim(value.scopeId),
    sourceName: trim(value.sourceName),
    fingerprint,
    grantedAt: Math.max(0, Math.trunc(Number(value.grantedAt) || 0)),
  };
};

export const normalizeScriptModelConsentState = (value) => {
  const grants = {};
  Object.values(isPlainObject(value?.grants) ? value.grants : {}).forEach((raw) => {
    const grant = normalizeGrant(raw);
    if (grant) grants[grant.scriptId] = grant;
  });
  return { version: VERSION, updatedAt: Math.max(0, Math.trunc(Number(value?.updatedAt) || 0)), grants };
};

// 代码内容的指纹（SHA-256），用来判断同意之后脚本代码有没有改
export const fingerprintScriptCode = async (code = '') => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(code ?? '')));
  return 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const createScriptModelConsentStore = ({
  loadKv = name => safeInvoke('load_kv', { name }),
  saveKv = (name, data) => safeInvoke('save_kv', { name, data }),
  key = SCRIPT_MODEL_CONSENT_STORE_KEY,
  now = () => Date.now(),
} = {}) => {
  let state = null;
  let loading = null;
  let saving = Promise.resolve();
  const ready = () => {
    if (state) return Promise.resolve(state);
    loading ||= Promise.resolve()
      .then(() => loadKv(key))
      .catch(() => null)
      .then((raw) => {
        state ||= normalizeScriptModelConsentState(isPlainObject(raw) && !raw._tooLarge ? raw : {});
        return state;
      });
    return loading;
  };
  // 依序写入，后写的不会被先写但较慢的盖掉
  const persist = () => {
    const snapshot = JSON.parse(JSON.stringify(state));
    saving = saving.catch(() => {}).then(() => saveKv(key, snapshot));
    return saving;
  };
  return {
    async list() {
      const current = await ready();
      return Object.values(current.grants).map(grant => ({ ...grant })).sort((a, b) => b.grantedAt - a.grantedAt);
    },
    async isGranted(scriptId, fingerprint) {
      const current = await ready();
      const grant = current.grants[trim(scriptId)];
      return Boolean(grant && fingerprint && grant.fingerprint === fingerprint);
    },
    async grant(record = {}) {
      const current = await ready();
      const grant = normalizeGrant({ ...record, grantedAt: now() });
      if (!grant) return null;
      current.grants[grant.scriptId] = grant;
      current.updatedAt = grant.grantedAt;
      await persist();
      return { ...grant };
    },
    // 撤销后这个脚本下次调用模型会再问
    async revoke(scriptId) {
      const current = await ready();
      const id = trim(scriptId);
      if (!Object.hasOwn(current.grants, id)) return false;
      delete current.grants[id];
      current.updatedAt = now();
      await persist();
      return true;
    },
  };
};

let sharedStore = null;
export const getScriptModelConsentStore = () => {
  sharedStore ||= createScriptModelConsentStore();
  return sharedStore;
};
