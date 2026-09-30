const trim = value => String(value ?? '').trim();
const normalizeKey = value => trim(value).toLowerCase().replace(/\s+/g, '');
const listPersonas = store => {
  const items = typeof store?.getAll === 'function' ? store.getAll()
    : typeof store?.listContacts === 'function' ? store.listContacts() : [];
  return Array.isArray(items) ? items.filter(Boolean) : [];
};

// Keep the existing APP target rule: an RP session selects its card;
// ordinary sessions use the active card. This does not grant write authority.
export const resolveWorldbookCurrentPersona = ({ personaStore, chatStore, sessionId = '', strictRP = false } = {}) => {
  const sid = trim(sessionId || chatStore?.getCurrent?.());
  const personaId = sid.startsWith('rp:') ? sid.slice(3) : '';
  if (personaId) {
    const direct = typeof personaStore?.get === 'function' ? personaStore.get(personaId)
      : personaStore?.getContact?.(personaId);
    const key = normalizeKey(personaId);
    const match = direct || listPersonas(personaStore).find(persona => (
      strictRP ? trim(persona.id) === personaId
        : normalizeKey(persona.id) === key || normalizeKey(persona.name) === key
    ));
    if (match) return match;
  }
  // Read evidence must not present an unresolved RP target as the active card.
  // Keep the original active-card fallback for existing write callers.
  if (strictRP && sid.startsWith('rp:')) return null;
  try { return personaStore?.getActive?.() || null; } catch { return null; }
};

/** Capture one read-only view after awaited book reads; all readers share it. */
export const captureWorldbookResourceOwnership = (deps = {}) => {
  const { personaStore } = deps;
  const current = resolveWorldbookCurrentPersona({ ...deps, strictRP: true });
  const currentId = trim(current?.id);
  const currentWorldId = trim(current?.source?.worldbookId);
  const known = Boolean(currentId) && (typeof personaStore?.getAll === 'function' || typeof personaStore?.listContacts === 'function');
  const bindings = listPersonas(personaStore).map(persona => ({
    personaId: trim(persona.id), personaName: trim(persona.name || persona.id),
    worldbookId: trim(persona.source?.worldbookId), enabled: persona.source?.worldbookEnabled !== false,
  })).filter(persona => persona.personaId).sort((a, b) => a.personaId.localeCompare(b.personaId));
  return {
    context: {
      currentCard: current ? { personaId: currentId, personaName: trim(current.name || current.id), worldbookId: currentWorldId } : null,
      ...(current && !currentWorldId ? {
        currentCardHint: '当前角色卡没有绑定自己的世界书；不要因为别的世界书名称与要求相似就写进去。给当前角色卡加内容时，不传 name 调用 worldbook.create 会为它新建并绑定一本。',
      } : {}),
    },
    project: (worldbookId = '') => {
      const id = trim(worldbookId);
      const personaBindings = id ? bindings.filter(persona => persona.worldbookId === id)
        .map(({ worldbookId: ignored, ...persona }) => persona) : [];
      const currentCard = Boolean(id && currentId && currentWorldId === id);
      const ownerCards = personaBindings.map(persona => persona.personaName);
      const otherOwnerCards = personaBindings.filter(persona => persona.personaId !== currentId).map(persona => persona.personaName);
      // Neutral target evidence, not a clarification decision or write approval.
      // "bound" records a saved reference; the book must still be checked before use.
      const targetSelectionEvidence = {
        currentCard: {
          personaId: currentId, personaName: trim(current?.name || currentId), worldbookId: currentWorldId,
          bindingState: !known ? 'unknown' : currentWorldId ? 'bound' : 'unbound',
        },
        observedWorldbook: { worldbookId: id, personaBindings },
        targetOptions: known && !currentCard && otherOwnerCards.length ? [
          {
            target: 'current_card', personaId: currentId, worldbookId: currentWorldId,
            intent: currentWorldId ? 'use_current_binding' : 'create_and_bind',
          },
          { target: 'observed_worldbook', worldbookId: id, intent: 'use_observed_worldbook' },
        ] : [],
      };
      return {
        ownershipKnown: known, currentCard, personaBindings, ownerCards, otherOwnerCards,
        sharedAcrossCards: personaBindings.length > 1,
        targetSelectionEvidence,
        ...(currentId && otherOwnerCards.length ? {
          ownerHint: currentCard
            ? `这本世界书同时绑定角色卡「${otherOwnerCards.join('、')}」；修改会影响这些角色卡，写入或修改前先向用户确认共享范围。`
            : `这本世界书属于角色卡「${ownerCards.join('、')}」，不是当前角色卡的世界书；除非用户点名这本，写入或修改前先向用户确认。`,
        } : {}),
      };
    },
  };
};
