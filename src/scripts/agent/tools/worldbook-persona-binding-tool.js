import { t } from '../../i18n/index.js';

const trim = value => String(value ?? '').trim();
const key = value => trim(value).toLowerCase().replace(/\s+/g, '');
const bindingOf = persona => ({
  worldbookId: trim(persona?.source?.worldbookId),
  enabled: persona?.source?.worldbookEnabled !== false,
});
const sameBinding = (left, right) => left.worldbookId === right.worldbookId && left.enabled === right.enabled;
const generationOf = persona => persona?.created ?? persona?.createdAt ?? null;

// Binding a saved book is a separate operation from writing its entries. This
// tool pins the explicitly selected card and its single role-world slot across
// storage reads and replacement confirmation, without changing the active card.
export const createWorldbookPersonaBindingTool = ({
  personaStore, waitForWorldStoreReady, readWorldbookSnapshot, assignWorldToPersona,
  refreshChatAndContacts, confirmDestructiveWrite,
} = {}) => {
  const targets = new WeakMap();
  const failure = (reason, extra = {}) => ({ ok: false, bound: false, reason, ...extra });
  const capture = async args => {
    const query = trim(args.personaId || args.personaName);
    if (!query) return { error: failure('missing_persona_target') };
    const direct = personaStore?.get?.(query);
    const matches = direct ? [direct] : (personaStore?.getAll?.() || []).filter(persona => key(persona.name) === key(query));
    if (!matches.length) return { error: failure('persona_not_found', { personaQuery: query }) };
    if (matches.length > 1) return { error: failure('ambiguous_persona', { candidates: matches.map(persona => ({ id: persona.id, name: persona.name })) }) };
    const persona = matches[0];
    const snapshot = {
      personaId: trim(persona.id), personaName: trim(persona.name || persona.id),
      personaRef: persona, generation: generationOf(persona), previous: bindingOf(persona),
      worldbookId: trim(args.worldbookId), enabled: args.enabled !== false,
    };
    if (!snapshot.worldbookId) return { error: failure('missing_worldbook_id') };
    await waitForWorldStoreReady?.();
    snapshot.world = await readWorldbookSnapshot(snapshot.worldbookId);
    if (!snapshot.world?.exists) return { error: failure('worldbook_not_found', { worldbookId: snapshot.worldbookId }) };
    return snapshot;
  };
  const replacementRequest = snapshot => ({
    destructive: true, kind: 'worldbook.bind_persona', operationType: 'replace_role_worldbook',
    title: t('更换角色世界书'),
    message: t('角色卡「{persona}」当前绑定「{previous}」。将改为「{next}」，原世界书仍会保留。', {
      persona: snapshot.personaName, previous: snapshot.previous.worldbookId, next: snapshot.worldbookId,
    }),
    confirmText: t('更换绑定'), cancelText: t('取消'), allowAlways: false,
    details: { personaId: snapshot.personaId, worldbookId: snapshot.worldbookId, previousWorldbookId: snapshot.previous.worldbookId },
  });
  const isReplacement = snapshot => !!snapshot.previous.worldbookId && snapshot.previous.worldbookId !== snapshot.worldbookId;
  return {
    name: 'worldbook.bind_persona', title: 'Bind worldbook to character card',
    description: 'Bind an already saved worldbook to one explicitly identified character card, without rewriting entries or switching the active card. Use personaId, or an unambiguous personaName. Each card has one role-world binding; replacing a different book requires confirmation. For creative-writing-only lore use worldbook.bind_rp_session instead.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_unbind', modelContext: 'none', confirmation: 'allow_once' },
    schema: {
      type: 'object', required: ['worldbookId'], additionalProperties: false,
      properties: {
        worldbookId: { type: 'string', minLength: 1, maxLength: 160 },
        personaId: { type: 'string', minLength: 1, maxLength: 160 },
        personaName: { type: 'string', minLength: 1, maxLength: 160 },
        enabled: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'bind_role_worldbook', destructive: 'conditional',
      preflight: async args => {
        const snapshot = await capture(args);
        targets.set(args, snapshot);
        return !snapshot.error && isReplacement(snapshot) ? replacementRequest(snapshot) : { destructive: false };
      },
    },
    execute: async (args = {}, context = {}) => {
      const snapshot = targets.get(args) || await capture(args);
      if (snapshot.error) return snapshot.error;
      const { personaId, personaName, worldbookId, enabled, previous } = snapshot;
      const target = { personaId, personaName, worldbookId, enabled, previousWorldbookId: previous.worldbookId };
      if (typeof assignWorldToPersona !== 'function') return failure('persona_binding_unavailable', target);
      if (isReplacement(snapshot) && !(context.toolSafety?.decision === 'allow' && context.toolSafety?.request?.kind === 'worldbook.bind_persona')) {
        if (await confirmDestructiveWrite?.(replacementRequest(snapshot)) !== true) return failure('persona_binding_cancelled', target);
      }
      const latestWorld = await readWorldbookSnapshot(worldbookId);
      if (!latestWorld?.exists) return failure('worldbook_deleted_during_operation', target);
      if (snapshot.world.generation != null && latestWorld.generation != null && String(snapshot.world.generation) !== String(latestWorld.generation)) {
        return failure('worldbook_recreated_during_operation', target);
      }
      const persona = personaStore?.get?.(personaId);
      if (!persona || (snapshot.generation != null ? generationOf(persona) !== snapshot.generation : persona !== snapshot.personaRef)) {
        return failure('persona_target_changed', target);
      }
      if (!sameBinding(bindingOf(persona), previous)) return failure('persona_binding_changed', target);
      if (previous.worldbookId === worldbookId && previous.enabled === enabled) return { ok: true, bound: true, changed: false, scope: 'persona', ...target };
      const saved = await assignWorldToPersona(personaId, worldbookId, { enabled });
      if (saved === false || saved?.ok === false || !sameBinding(bindingOf(personaStore?.get?.(personaId)), { worldbookId, enabled })) {
        return failure('persona_binding_save_failed', target);
      }
      refreshChatAndContacts?.({ immediate: true });
      return { ok: true, bound: true, changed: true, scope: 'persona', ...target };
    },
    summarizeResult: result => result?.ok === false
      ? `bind worldbook to character card failed: ${trim(result.reason)}`
      : `bound worldbook ${trim(result.worldbookId)} to character card ${trim(result.personaName)} (${trim(result.personaId)})`,
  };
};
