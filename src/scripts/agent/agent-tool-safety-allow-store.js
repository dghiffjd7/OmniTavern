export const AGENT_TOOL_SAFETY_ALLOW_STORAGE_KEY = 'agent_tool_safety_allow_rules_v1';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const readStorage = (storage = globalThis?.localStorage) => {
  try {
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : null;
  } catch {
    return null;
  }
};

const toTimestamp = (value, fallbackNow = Date.now) => {
  const fallback = () => {
    try {
      const next = typeof fallbackNow === 'function' ? fallbackNow() : fallbackNow;
      const numeric = Number(next);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
    } catch {
      return Date.now();
    }
  };
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback();
};

export const buildAgentToolSafetyAllowKey = (request = {}) => {
  const source = isPlainObject(request) ? request : {};
  return [
    trim(source.toolName),
    trim(source.kind),
    trim(source.operationType),
  ].filter(Boolean).join('|');
};

// 「这个角色卡一律允许」的规则只在该角色卡生效；没有 roleCardId 的是旧的全局规则，照旧对所有地方生效
const roleCardRuleKey = (baseKey, roleCardId) => `${baseKey}#card:${roleCardId}`;

const normalizeRule = (rule = {}, now = Date.now) => {
  const source = isPlainObject(rule) ? rule : {};
  const roleCardId = trim(source.roleCardId);
  const baseKey = buildAgentToolSafetyAllowKey(source);
  const key = trim(source.key) || (baseKey && roleCardId ? roleCardRuleKey(baseKey, roleCardId) : baseKey);
  if (!key) return null;
  return {
    key,
    ...(roleCardId ? { roleCardId, roleCardName: trim(source.roleCardName) } : {}),
    toolName: trim(source.toolName),
    kind: trim(source.kind),
    operationType: trim(source.operationType),
    title: trim(source.title),
    source: trim(source.source),
    riskLevel: trim(source.riskLevel),
    createdAt: toTimestamp(source.createdAt, now),
    updatedAt: toTimestamp(source.updatedAt || source.createdAt, now),
  };
};

const normalizeRules = (value = {}, now = Date.now) => {
  const source = Array.isArray(value)
    ? value
    : (Array.isArray(value?.rules) ? value.rules : []);
  const rules = [];
  const seen = new Set();
  source.forEach((entry) => {
    const rule = normalizeRule(entry, now);
    if (!rule || seen.has(rule.key)) return;
    seen.add(rule.key);
    rules.push(rule);
  });
  return rules;
};

export const createAgentToolSafetyAllowStore = ({
  storage = globalThis?.localStorage,
  loadKv = null,
  saveKv = null,
  key = AGENT_TOOL_SAFETY_ALLOW_STORAGE_KEY,
  now = Date.now,
} = {}) => {
  const targetStorage = readStorage(storage);
  let memoryRules = [];
  let hydrated = false;

  const load = () => {
    // kv hydrate 后内存态为权威（localStorage 配额满时写入会静默失败，不能再作真值）。
    if (hydrated) return memoryRules;
    if (!targetStorage) return memoryRules;
    try {
      const raw = targetStorage.getItem(key);
      if (!raw) {
        memoryRules = [];
        return memoryRules;
      }
      memoryRules = normalizeRules(JSON.parse(raw), now);
      return memoryRules;
    } catch {
      memoryRules = [];
      return memoryRules;
    }
  };

  const save = (rules = []) => {
    memoryRules = normalizeRules(rules, now);
    hydrated = true;
    try {
      targetStorage?.setItem(key, JSON.stringify({
        version: 1,
        rules: memoryRules,
      }));
    } catch {
      // Keep the in-memory rules for the current session when storage is unavailable.
    }
    if (typeof saveKv === 'function') {
      Promise.resolve(saveKv(key, { version: 1, rules: memoryRules })).catch(() => {});
    }
  };

  // kv 为权威通道：优先取 kv，回落 localStorage 旧数据（并合并去重）。
  const hydrate = async () => {
    if (typeof loadKv !== 'function') return memoryRules;
    try {
      const kvRaw = await loadKv(key);
      if (kvRaw && typeof kvRaw === 'object' && !kvRaw._tooLarge) {
        const kvRules = normalizeRules(kvRaw, now);
        const localRules = load();
        const merged = normalizeRules([...kvRules, ...localRules], now);
        memoryRules = merged;
      }
    } catch {}
    hydrated = true;
    return memoryRules;
  };

  load();

  const list = () => load().map(rule => ({ ...rule }));

  const isAllowed = (request = {}, { roleCardId = '' } = {}) => {
    const allowKey = buildAgentToolSafetyAllowKey(request);
    if (!allowKey) return false;
    const cardKey = trim(roleCardId) ? roleCardRuleKey(allowKey, trim(roleCardId)) : '';
    return load().some(rule => (rule.key === allowKey && !rule.roleCardId) || (cardKey && rule.key === cardKey));
  };

  const upsertRule = (request = {}, { roleCardId = '', roleCardName = '' } = {}) => {
    const source = isPlainObject(request) ? request : {};
    const baseKey = buildAgentToolSafetyAllowKey(source);
    if (!baseKey) return null;
    const cardId = trim(roleCardId);
    const allowKey = cardId ? roleCardRuleKey(baseKey, cardId) : baseKey;
    const existingRules = load();
    const existing = existingRules.find(rule => rule.key === allowKey);
    const timestamp = toTimestamp(null, now);
    const nextRule = normalizeRule({
      ...existing,
      key: allowKey,
      toolName: trim(source.toolName || existing?.toolName),
      kind: trim(source.kind || existing?.kind),
      operationType: trim(source.operationType || existing?.operationType),
      title: trim(source.title || existing?.title),
      source: trim(source.source || existing?.source),
      riskLevel: trim(source.riskLevel || existing?.riskLevel),
      ...(cardId ? { roleCardId: cardId, roleCardName: trim(roleCardName || existing?.roleCardName) } : {}),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    }, now);
    const nextRules = existing
      ? existingRules.map(rule => (rule.key === allowKey ? nextRule : rule))
      : [...existingRules, nextRule];
    save(nextRules);
    return nextRule ? { ...nextRule } : null;
  };

  const allowAlways = request => upsertRule(request);
  const allowForRoleCard = (request, { roleCardId = '', roleCardName = '' } = {}) => (
    trim(roleCardId) ? upsertRule(request, { roleCardId, roleCardName }) : null
  );

  const revoke = (ruleKey = '') => {
    const target = trim(ruleKey);
    if (!target) return false;
    const existingRules = load();
    const nextRules = existingRules.filter(rule => rule.key !== target);
    if (nextRules.length === existingRules.length) return false;
    save(nextRules);
    return true;
  };

  const clear = () => {
    memoryRules = [];
    hydrated = true;
    try {
      if (typeof targetStorage?.removeItem === 'function') {
        targetStorage.removeItem(key);
      } else {
        targetStorage?.setItem(key, JSON.stringify({ version: 1, rules: [] }));
      }
    } catch {}
    if (typeof saveKv === 'function') {
      Promise.resolve(saveKv(key, { version: 1, rules: [] })).catch(() => {});
    }
  };

  return {
    key,
    buildKey: buildAgentToolSafetyAllowKey,
    hydrate,
    isAllowed,
    allowAlways,
    allowForRoleCard,
    list,
    revoke,
    clear,
  };
};
