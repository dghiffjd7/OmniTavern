const trim = value => String(value ?? '').trim();
const revision = message => JSON.stringify([message?.content, message?.type, message?.meta?.activeSwipe || 0, message?.meta?.swipes?.length || 0]);

export const isReplyNotificationMessage = message => Boolean(
  message?.role === 'assistant' && message?.id && !message?.meta?.isGreeting &&
  !message?.meta?.pending && !message?.meta?.cancelled && !message?.meta?.partial &&
  (trim(message.content) || ['image', 'sticker', 'voice', 'audio', 'video'].includes(message.type))
);

// Capture identity before async generation; finish only at a committed reply boundary.
// This module owns filtering, stale-result checks and notification failure isolation.
export const createReplyCompletionRuntime = ({
  service, chatStore, getPersonaId, getScopeId, getSessionName, formatBody,
  onError = () => {}, makeId = () => `reply:${Date.now()}:${Math.random().toString(36).slice(2)}`,
} = {}) => ({
  begin(sessionId, { eligible = true, existingMessageId = '' } = {}) {
    if (!eligible) return { finish: async () => false };
    const context = {
      personaId: trim(getPersonaId()), scopeId: trim(getScopeId()), sessionId: trim(sessionId),
      archiveId: trim(chatStore.getCurrentArchiveId(sessionId)),
    };
    const before = new Set((chatStore.getMessages(sessionId) || []).map(message => message?.id));
    // Only continuation/regeneration needs a text revision; avoid cloning history.
    const beforeRevision = existingMessageId ? revision(chatStore.findMessage(existingMessageId, sessionId)) : null;
    const runId = makeId();
    let finished = false;
    const current = () => trim(getScopeId()) === context.scopeId &&
      Boolean(chatStore.state?.sessions?.[context.sessionId]) &&
      trim(chatStore.getCurrentArchiveId(context.sessionId)) === context.archiveId;
    return {
      async finish({ succeeded = true, cancelled = false, refs = [], messageId = '', allowExisting = false } = {}) {
        if (finished || !eligible || !succeeded || cancelled || !current()) return false;
        if (service.get && (!service.get().supported || !service.get().enabled)) { finished = true; return false; }
        const candidates = [
          ...refs.map(ref => ({ sessionId: trim(ref.targetSessionId || ref.sessionId || sessionId), messageId: trim(ref.messageId) })),
          ...(chatStore.getMessages(sessionId) || []).filter(message => !before.has(message?.id)).map(message => ({ sessionId, messageId: message.id })),
          ...(allowExisting && messageId === existingMessageId && beforeRevision !== revision(chatStore.findMessage(messageId, sessionId)) ? [{ sessionId, messageId }] : []),
        ];
        // Prefer a reply in the requested conversation, then a routed protocol reply.
        candidates.sort((a, b) => Number(a.sessionId === sessionId) - Number(b.sessionId === sessionId));
        const target = candidates.reverse().find(ref => isReplyNotificationMessage(chatStore.findMessage(ref.messageId, ref.sessionId)));
        if (!target) return false;
        finished = true;
        const route = { ...context, sessionId: target.sessionId, messageId: target.messageId,
          archiveId: trim(chatStore.getCurrentArchiveId(target.sessionId)),
          swipeIndex: Number(chatStore.findMessage(target.messageId, target.sessionId)?.meta?.activeSwipe || 0),
        };
        const name = Array.from(trim(getSessionName(target.sessionId)).replace(/[\r\n\t]+/g, ' ')).slice(0, 100).join('');
        try {
          // Persist before sending a notification that can also activate a cold app.
          await chatStore.flush?.();
          if (!current() || trim(chatStore.getCurrentArchiveId(target.sessionId)) !== route.archiveId ||
              !isReplyNotificationMessage(chatStore.findMessage(target.messageId, target.sessionId))) return false;
          await service.complete({ runId, route, body: formatBody(name) });
          return true;
        } catch (error) { onError(error); return false; }
      },
    };
  },
});

// Reuse the application's normal scope, archive and room navigation contracts.
export const openReplyNotificationRoute = async (route, {
  chatStore, getPersona, getPersonaId, switchPersona, getScopeId, saveDraft,
  hasSession, setMode, enterRoom, loadArchive, locateMessage, selectSwipe,
} = {}) => {
  if (!route || !trim(route.sessionId) || !trim(route.messageId)) return false;
  if (trim(route.personaId) !== trim(getPersonaId()) && !getPersona(route.personaId)) return false;
  saveDraft();
  if (trim(getPersonaId()) !== trim(route.personaId) && !(await switchPersona(route.personaId))) return false;
  if (trim(getScopeId()) !== trim(route.scopeId) || !hasSession(route.sessionId)) return false;
  if (trim(route.archiveId) && trim(chatStore.getCurrentArchiveId(route.sessionId)) !== trim(route.archiveId)) {
    if (!chatStore.getArchives(route.sessionId).some(archive => archive.id === route.archiveId)) return false;
    if (!(await loadArchive(route.archiveId, route.sessionId))) return false;
  }
  setMode(route.sessionId.startsWith('rp:') ? 'rp' : 'chat');
  const entered = await enterRoom(route.sessionId, route.messageId);
  if (entered?.blocked || entered?.stale) return false;
  const located = entered?.jumpedToTarget || await locateMessage(route.sessionId, route.messageId);
  if (located && Number.isInteger(route.swipeIndex)) await selectSwipe?.(route.sessionId, route.messageId, route.swipeIndex);
  return Boolean(located);
};
