import { t, translateUiText } from '../../i18n/index.js';

const trim = value => String(value ?? '').trim();
const stable = value => JSON.stringify(value, (_, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item
));
const AUTHORIZATION = Symbol('worldbook write authorization');
const targetDescriptor = ({ worldbookId, newBook, bindPersonaId, allowNewCopy }) => ({
  worldbookId, newBook, bindPersonaId, allowNewCopy,
});
const failure = (reason, worldbookId = '') => ({
  ok: false, reason, worldbookId, worldbookSaved: false,
  message: reason === 'worldbook_target_confirmation_required'
    ? t('目标世界书属于其他角色卡或共享范围。请先确认具体世界书及操作，并在本次确认面板允许一次。')
    : t('世界书目标、归属或本次操作在确认后发生变化，请重新核对目标并确认。'),
});

/** One invocation owns one approval. Model arguments never grant authority. */
export const createWorldbookWriteBoundary = ({
  getCurrentPersona, listPersonas, readSnapshot, getGlobalIds, getSessionMap,
  resolveTargets, personaIdentity, waitForReady, getCurrentSessionId,
} = {}) => {
  const pending = new WeakMap();
  let sequence = 0;
  const personaState = persona => persona ? {
    id: trim(persona.id), name: trim(persona.name),
    generation: trim(personaIdentity?.(persona)),
    worldbookId: trim(persona.source?.worldbookId),
    enabled: persona.source?.worldbookEnabled !== false,
  } : null;
  const capture = async targets => {
    const snapshots = await Promise.all(targets.map(target => readSnapshot(trim(target.worldbookId))));
    const globals = await getGlobalIds?.() || [];
    const sessions = await getSessionMap?.() || {};
    // Read card identities after all asynchronous storage reads. A card switch
    // while a snapshot is loading must be visible to the commit check.
    const current = personaState(getCurrentPersona?.());
    const personas = (listPersonas?.() || []).map(personaState).filter(Boolean);
    const items = [];
    for (const [index, target] of targets.entries()) {
      const id = trim(target.worldbookId);
      const snapshot = snapshots[index];
      const owners = target.newBook ? [] : personas.filter(persona => persona.worldbookId === id)
        .sort((a, b) => a.id.localeCompare(b.id));
      const global = !target.newBook && globals.includes(id);
      const sessionIds = target.newBook ? [] : Object.entries(sessions)
        .filter(([, ids]) => (Array.isArray(ids) ? ids : [ids]).includes(id))
        .map(([sessionId]) => sessionId).sort();
      const otherSessionIds = sessionIds.filter(id => id !== trim(getCurrentSessionId?.()));
      const bindingPersona = target.bindPersonaId
        ? personas.find(persona => persona.id === target.bindPersonaId) || null : null;
      const currentOwns = current?.worldbookId === id;
      const outsideCurrent = owners.some(persona => persona.id !== current?.id);
      const requiresConfirmation = Boolean(
        (target.bindPersonaId && target.bindPersonaId !== current?.id)
        || (!target.newBook && snapshot.exists && (
          outsideCurrent || global || otherSessionIds.length > 0 || (current && !currentOwns)
        )),
      );
      items.push({
        ...target, owners, global, sessionIds, otherSessionIds, bindingPersona, requiresConfirmation,
        exists: target.newBook ? false : snapshot.exists,
        generation: target.newBook ? null : snapshot.generation,
        revision: target.newBook ? null : snapshot.revision,
        // Legacy stores have no revision/generation. Keep an exact fallback.
        data: target.newBook || snapshot.revision != null ? null : snapshot.data,
      });
    }
    return JSON.parse(JSON.stringify({ current, items }));
  };
  const sameScope = (before, after, requireVersion) => {
    const project = state => ({
      current: state.current,
      items: state.items.map(({ revision, data, ...item }) => ({
        ...item, ...(requireVersion ? { revision, data } : {}),
      })),
    });
    return stable(project(before)) === stable(project(after));
  };
  const changeReason = (before, after) => {
    const scope = state => ({
      current: state.current,
      items: state.items.map(({ exists, generation, revision, data, requiresConfirmation, ...item }) => item),
    });
    return stable(scope(before)) === stable(scope(after))
      ? 'worldbook_changed_since_confirmation' : 'worldbook_target_changed';
  };
  const describe = state => state.items.map(item => {
    const owners = item.owners.map(persona => `「${persona.name || persona.id}」`).join('、');
    const scope = owners ? t('绑定角色卡：{owners}', { owners })
      : item.newBook ? t('新建世界书') : t('未绑定当前角色卡');
    return t('世界书「{worldbook}」：{scope}{global}{sessions}', {
      worldbook: item.worldbookId, scope,
      global: item.global ? t('，全局共享') : '',
      sessions: item.otherSessionIds.length ? t('，另有 {count} 个会话引用', { count: item.otherSessionIds.length }) : '',
    });
  }).join('；');

  const wrap = tool => {
    if (!resolveTargets[tool.name]) return tool;
    const originalPreflight = tool.safety?.preflight;
    return {
      ...tool,
      safety: {
        ...tool.safety, destructive: 'conditional',
        preflight: async (args = {}, context = {}) => {
          await waitForReady?.();
          const original = await originalPreflight?.(args, context) || { destructive: false };
          const targets = await resolveTargets[tool.name](args);
          const state = await capture(targets);
          const required = state.items.some(item => item.requiresConfirmation);
          const id = `worldbook-write:${++sequence}`;
          pending.set(args, { id, state, args: stable(args), required, toolName: tool.name });
          if (!required) return original;
          return {
            ...original, destructive: true, kind: original.kind || 'worldbook.write_target',
            operationType: original.operationType || tool.name,
            title: translateUiText(original.title || '确认世界书写入目标'),
            message: t('当前角色卡：{persona}。{targets}。{operation}请确认允许本次操作。', {
              persona: state.current?.name || t('未选择'), targets: describe(state),
              operation: original.message ? translateUiText(original.message)
                : t('将执行 {operation}。', { operation: translateUiText(tool.title || tool.name) }),
            }),
            confirmText: translateUiText(original.confirmText || '允许一次'), cancelText: t('取消'),
            allowAlways: false, danger: original.danger === true,
            details: {
              ...original.details, worldbookWriteBoundaryId: id,
              currentPersonaId: state.current?.id || '',
              worldbookTargets: state.items.map(item => ({
                worldbookId: item.worldbookId, newBook: item.newBook === true,
                ownerCards: item.owners.map(persona => ({ id: persona.id, name: persona.name })),
                global: item.global, otherSessionIds: item.otherSessionIds, bindPersonaId: item.bindPersonaId || '',
              })),
            },
            // A rejected cross-card replacement must not create a copy or bind it.
            onDeny: { action: 'skip', reason: 'worldbook_target_confirmation_cancelled',
              result: { ok: false, skipped: true, worldbookSaved: false, reason: 'worldbook_target_confirmation_cancelled' } },
          };
        },
      },
      execute: async (args = {}, context = {}) => {
        await waitForReady?.();
        let authorization = pending.get(args);
        pending.delete(args);
        const state = await capture(authorization
          ? authorization.state.items.map(targetDescriptor)
          : await resolveTargets[tool.name](args));
        // Batch deletion validates each target immediately before deleting it;
        // an independently removed/edited item must not cancel all other items.
        const scopeUnchanged = authorization && (tool.name === 'worldbook.delete_many'
          ? stable(authorization.state.current) === stable(state.current)
          : sameScope(authorization.state, state, authorization.required));
        if (authorization && (authorization.args !== stable(args) || !scopeUnchanged)) {
          return failure(authorization.args !== stable(args)
            ? 'worldbook_target_changed' : changeReason(authorization.state, state), authorization.state.items[0]?.worldbookId);
        }
        const required = state.items.some(item => item.requiresConfirmation);
        if (required && (!authorization?.required
          || context.toolSafety?.required !== true || context.toolSafety?.decision !== 'allow'
          || context.toolSafety?.request?.toolName !== tool.name
          || context.toolSafety?.request?.details?.worldbookWriteBoundaryId !== authorization.id)) {
          return failure('worldbook_target_confirmation_required', state.items[0]?.worldbookId);
        }
        authorization ||= { state, args: stable(args), required: false, toolName: tool.name };
        return tool.execute(args, { ...context, [AUTHORIZATION]: authorization });
      },
    };
  };

  const validateCommit = async (worldbookId, context = {}) => {
    const authorization = context[AUTHORIZATION];
    if (!authorization) return failure('worldbook_target_confirmation_required', worldbookId);
    const exact = authorization.state.items.find(item => item.worldbookId === worldbookId && !item.newBook);
    const targets = exact ? [exact] : authorization.state.items.filter(item => (
      item.newBook || (item.allowNewCopy && !authorization.required)
    ));
    const previous = { current: authorization.state.current, items: targets };
    const current = await capture(targets.map(targetDescriptor));
    if (!sameScope(previous, current, authorization.required)) {
      return failure(changeReason(previous, current), worldbookId);
    }
    if (!exact) {
      // create_new may resolve a name collision to a unique new name. It can
      // never use that fallback to append to another already existing book.
      const newTarget = targets.length > 0;
      const snapshot = await readSnapshot(worldbookId);
      if (!newTarget || snapshot.exists) return failure('worldbook_target_changed', worldbookId);
    }
    return null;
  };
  return { wrap, validateCommit };
};
