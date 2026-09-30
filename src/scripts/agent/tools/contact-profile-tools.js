import { normalizeScopeId } from '../../storage/store-scope.js';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

// Built-in maid access to the current scoped store. Explicit user rules take
// precedence; writes still require the per-operation safety confirmation below.
export const MAID_CONTACT_PROFILE_PERMISSION_RULES = Object.freeze([
  'contact_profile.read',
  'contact_profile.get',
  'contact_profile.list',
  'contact_profile.upsert',
].map(toolName => Object.freeze({
  id: `maid-builtin:${toolName}:storage`,
  layer: 'default',
  priority: -100,
  toolName,
  permission: 'storage',
  source: 'maid-assistant',
  decision: 'allow',
})));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

// Keep the model-facing shape aligned with normalizeContactProfile: unknown top-level
// fields such as age/occupation would otherwise be silently dropped by the store.
const profileStringList = () => ({ type: 'array', items: { type: 'string' } });
const profileFactList = () => ({
  type: 'array',
  items: {
    type: 'object',
    required: ['label'],
    properties: {
      label: { type: 'string', minLength: 1 },
      weight: { type: 'number' },
      sourceRefs: profileStringList(),
    },
  },
});

const contactProfileSchema = () => ({
  type: 'object',
  required: ['contactId'],
  additionalProperties: false,
  properties: {
    contactId: { type: 'string', minLength: 1, description: '真实私聊 sessionId，来自 session.create 返回值或 session.list；不能用显示名称代替。' },
    id: { type: 'string', description: '保留已读取档案的 id；新档案可省略。' },
    scopeId: { type: 'string', description: '已有档案的作用域；实际写入仍由当前 store 作用域决定。' },
    displayName: { type: 'string' },
    aliases: profileStringList(),
    relationship: {
      type: 'object',
      additionalProperties: false,
      properties: {
        current: { type: 'string' },
        user_dynamic: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        sourceRefs: profileStringList(),
      },
    },
    stable_traits: {
      ...profileFactList(),
      description: '完整保留用户给定的年龄、职业、性格、爱好等，每项用 label 描述用户提供的具体信息。',
    },
    important_events: profileFactList(),
    interaction_focus: profileStringList(),
    trigger_keywords: profileStringList(),
    negative_or_sensitive: profileStringList(),
    sourceRefs: profileStringList(),
    updatedAt: { type: 'number' },
    version: { type: 'integer', minimum: 1 },
  },
});

export const createContactProfileAgentTools = ({
  contactProfileStore = null,
  getMaidScopeContext = null,
} = {}) => {
  const resolveStore = () => {
    if (!contactProfileStore || typeof contactProfileStore !== 'object') return null;
    return contactProfileStore;
  };
  const scopeFailure = reason => ({ ok: false, saved: false, conflict: reason === 'target_scope_changed', reason, profile: null });
  const captureMaidScope = (context, store) => {
    if (context?.source !== 'maid-assistant') return null;
    const roleCardId = trim(context?.roleCardId);
    if (!roleCardId) return { failure: scopeFailure('maid_identity_required') };
    let current;
    try { current = getMaidScopeContext?.(); } catch {}
    if (!trim(current?.roleCardId) || !store || typeof current?.scopeId !== 'string') {
      return { failure: scopeFailure('contact_profile_scope_unavailable') };
    }
    const scopeId = normalizeScopeId(current.scopeId);
    if (roleCardId !== trim(current.roleCardId) || scopeId !== normalizeScopeId(store.scopeId)) {
      return { failure: scopeFailure('target_scope_changed') };
    }
    return { roleCardId, scopeId, scopeToken: store.getScopeSnapshot?.()?.scopeToken, ready: store.ready };
  };
  const waitForMaidScope = async (context, store) => {
    const authority = captureMaidScope(context, store);
    if (!authority || authority.failure) return authority;
    try { await authority.ready; }
    catch { return { failure: scopeFailure('contact_profile_scope_unavailable') }; }
    return authority;
  };
  // Recheck synchronously at the read/capture/commit point, after every await.
  // The trusted callback also distinguishes cards when contacts use a shared store.
  const validateMaidScope = (context, store, authority) => {
    if (context?.source !== 'maid-assistant') return null;
    if (authority?.failure) return authority.failure;
    const current = captureMaidScope(context, store);
    if (current?.failure) return current.failure;
    if (!authority || current.roleCardId !== authority.roleCardId || current.scopeId !== authority.scopeId
      || current.scopeToken !== authority.scopeToken || current.ready !== authority.ready) {
      return scopeFailure('target_scope_changed');
    }
    return store.isLoaded === false ? scopeFailure('contact_profile_scope_unavailable') : null;
  };
  const upsertPlans = new WeakMap();
  const captureUpsertPlan = (args = {}) => {
    const store = resolveStore();
    const profile = clone(isPlainObject(args.profile) ? args.profile : {});
    const contactId = trim(
      profile.contactId || profile.contact_id || profile.sessionId || profile.id ||
      profile.displayName || profile.name || profile.label,
    );
    const snapshot = typeof store?.getProfileSnapshot === 'function'
      ? store.getProfileSnapshot(contactId)
      : {
        contactId,
        scopeId: trim(store?.scopeId),
        scopeToken: Number(store?.scopeToken || 0),
        exists: Boolean(store?.getProfile?.(contactId)),
        revision: null,
        profile: clone(store?.getProfile?.(contactId)) || null,
      };
    return { store, profile, contactId, snapshot };
  };

  return [
    {
      name: 'contact_profile.read',
      title: 'Read contact profile',
      description: 'Read a stored contact profile by contact id.',
      source: 'contact-profile-store',
      permissions: ['storage'],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'none',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['contactId'],
        additionalProperties: false,
        properties: {
          contactId: { type: 'string', minLength: 1 },
        },
      },
      execute: async (args = {}, context = {}) => {
        const store = resolveStore();
        const authority = await waitForMaidScope(context, store);
        const failure = validateMaidScope(context, store, authority);
        if (failure) return failure;
        if (!store || typeof store.getProfile !== 'function') {
          throw new Error('contact profile store not available');
        }
        const contactId = trim(args.contactId);
        const profile = store.getProfile(contactId);
        return {
          contactId,
          found: Boolean(profile),
          profile: clone(profile) || null,
        };
      },
      summarizeResult: result => result?.ok === false ? `contact profile read blocked: ${trim(result.reason)}` : (result?.found
        ? `contact profile loaded for ${trim(result.contactId)}`
        : `contact profile missing for ${trim(result?.contactId)}`),
    },
    {
      name: 'contact_profile.get',
      title: 'Get contact profile',
      description: 'Get a stored contact profile by contact id for provider tool calls.',
      source: 'contact-profile-store',
      permissions: ['storage'],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['contactId'],
        additionalProperties: false,
        properties: {
          contactId: { type: 'string', minLength: 1 },
        },
      },
      execute: async (args = {}, context = {}) => {
        const store = resolveStore();
        const authority = await waitForMaidScope(context, store);
        const failure = validateMaidScope(context, store, authority);
        if (failure) return failure;
        if (!store || typeof store.getProfile !== 'function') {
          throw new Error('contact profile store not available');
        }
        const contactId = trim(args.contactId);
        const profile = store.getProfile(contactId);
        return {
          contactId,
          found: Boolean(profile),
          profile: clone(profile) || null,
        };
      },
      summarizeResult: result => result?.ok === false ? `contact profile read blocked: ${trim(result.reason)}` : (result?.found
        ? `contact profile loaded for ${trim(result.contactId)}`
        : `contact profile missing for ${trim(result?.contactId)}`),
    },
    {
      name: 'contact_profile.list',
      title: 'List contact profiles',
      description: 'List stored contact profiles in the current scope.',
      source: 'contact-profile-store',
      permissions: ['storage'],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      outputLimit: 1200,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 0, maximum: 1000 },
        },
      },
      execute: async (args = {}, context = {}) => {
        const store = resolveStore();
        const authority = await waitForMaidScope(context, store);
        const failure = validateMaidScope(context, store, authority);
        if (failure) return failure;
        if (!store || typeof store.listProfiles !== 'function') {
          throw new Error('contact profile store not available');
        }
        const limit = Number.isFinite(Number(args.limit)) ? Math.max(0, Math.trunc(Number(args.limit))) : 0;
        const profiles = store.listProfiles();
        const list = Array.isArray(profiles) ? profiles.map(clone) : [];
        return {
          count: list.length,
          profiles: limit > 0 ? list.slice(0, limit) : list,
        };
      },
      summarizeResult: result => result?.ok === false ? `contact profile list blocked: ${trim(result.reason)}` : `contact profiles listed: ${Number(result?.count || 0)}`,
    },
    {
      name: 'contact_profile.upsert',
      title: 'Upsert contact profile',
      description: 'Save a complete profile for an existing private contact using its real sessionId as profile.contactId. Read the current profile first and preserve unchanged fields. Put age, occupation, personality and interests in stable_traits[].label. Requires confirmation and rejects a changed scope or revision.',
      source: 'contact-profile-store',
      permissions: ['storage'],
      riskLevel: 'medium',
      capabilities: {
        read: false,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual',
        modelContext: 'none',
        confirmation: 'required',
      },
      safety: {
        operationType: 'upsert_contact_profile',
        destructive: 'conditional',
        description: 'Replaces one complete contact profile only when its confirmed scope and revision are unchanged.',
        preflight: async (args = {}, context = {}) => {
          const store = resolveStore();
          const authority = await waitForMaidScope(context, store);
          const failure = validateMaidScope(context, store, authority);
          const plan = failure ? { store, failure } : { ...captureUpsertPlan(args), authority };
          upsertPlans.set(args, plan);
          if (failure) return { destructive: false };
          if (!plan.contactId) return { destructive: false };
          return {
            requiresConfirmation: true,
            kind: 'contact_profile.upsert',
            operationType: 'upsert_contact_profile',
            title: plan.snapshot?.exists ? '确认更新联系人画像' : '确认创建联系人画像',
            message: plan.snapshot?.exists
              ? `将替换联系人「${plan.contactId}」的完整画像；确认期间若画像变化，本次写入会被拒绝。`
              : `将为联系人「${plan.contactId}」创建画像；确认期间若已有画像出现，本次写入会被拒绝。`,
            confirmText: '确认保存',
            cancelText: '取消',
            danger: plan.snapshot?.exists === true,
            allowAlways: false,
            argsPreview: {
              contactId: plan.contactId,
              scopeId: trim(plan.snapshot?.scopeId),
              exists: plan.snapshot?.exists === true,
              revision: plan.snapshot?.revision,
            },
            onDeny: {
              action: 'skip',
              reason: 'contact_profile_upsert_cancelled',
              result: {
                ok: false,
                saved: false,
                skipped: true,
                reason: 'contact_profile_upsert_cancelled',
                contactId: plan.contactId,
              },
            },
          };
        },
      },
      schema: {
        type: 'object',
        required: ['profile'],
        additionalProperties: false,
        properties: {
          profile: contactProfileSchema(),
        },
      },
      execute: async (args = {}, context = {}) => {
        const pinned = upsertPlans.get(args);
        upsertPlans.delete(args);
        if (pinned?.failure) return pinned.failure;
        const store = pinned?.store || resolveStore();
        const authority = await waitForMaidScope(context, store);
        const failure = validateMaidScope(context, store, authority)
          || (pinned && validateMaidScope(context, store, pinned.authority));
        if (failure) return failure;
        const plan = pinned || captureUpsertPlan(args);
        if (!store || typeof store.upsertProfile !== 'function') {
          throw new Error('contact profile store not available');
        }
        const profile = plan.profile;
        if (!plan.contactId) {
          return {
            ok: false,
            saved: false,
            conflict: false,
            reason: 'missing_contact_id',
            contactId: '',
            profile: null,
          };
        }
        const mutation = typeof store.upsertProfileIfUnchanged === 'function'
          ? store.upsertProfileIfUnchanged(profile, plan.snapshot)
          : { ok: true, saved: true, profile: store.upsertProfile(profile) };
        if (!mutation?.ok || !mutation?.saved) {
          return {
            ok: false,
            saved: false,
            conflict: mutation?.conflict === true,
            reason: trim(mutation?.reason, 'profile_save_failed'),
            contactId: plan.contactId,
            profile: null,
            latestProfile: clone(mutation?.latestSnapshot?.profile) || null,
          };
        }
        const saved = mutation.profile;
        return {
          ok: true,
          saved: Boolean(saved),
          conflict: false,
          reason: '',
          contactId: trim(saved?.contactId || plan.contactId),
          profile: clone(saved) || null,
        };
      },
      summarizeResult: result => (result?.saved
        ? `contact profile saved for ${trim(result.contactId)}`
        : `contact profile save skipped: ${trim(result?.reason, 'unknown')}`),
    },
  ];
};

export const registerContactProfileAgentTools = (registry, deps = {}) => {
  const tools = createContactProfileAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
