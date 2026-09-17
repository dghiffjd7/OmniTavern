// Target preparation is read-only. A card and its execution share one frozen
// source/range; asynchronous loading must never silently select a newer reply.
export const agentToolContextKey = context => JSON.stringify(['place', 'scopeId', 'sessionId', 'archiveId'].map(key => String(context?.[key] || '')));
const messageState = message => [message?.id, message?.role, message?.type,
  message?.content, message?.rawInput, message?.rawSource, message?.raw, message?.status, message?.pending,
  message?.meta?.activeSwipe, message?.meta?.swipes?.length, message?.meta?.streaming,
  message?.meta?.swipeRegenerating, message?.meta?.activeSwipeDraft?.active, message?.meta?.autoImagePromptRawContent];
export const agentToolMessageIdentity = message => JSON.stringify(messageState(message));
export const isAgentToolReply = message => Boolean(message?.id && message.role === 'assistant'
  && (!message.type || message.type === 'text') && !message.pending && !message.error
  && !['pending', 'sending'].includes(message.status) && !message.meta?.streaming
  && !message.meta?.swipeRegenerating && !message.meta?.activeSwipeDraft?.active && !message.meta?.generatedMedia);
export const formatToolTargetKey = target => JSON.stringify([target?.sourceKind, target?.sourceSessionId,
  target?.turnId, target?.sourceMessageIds, target?.sourceText]);
const stale = () => ({ ok: false, message: '消息、回复分支或存档已变化，请重新选择文字' });

export const createAgentToolTargets = ({ getContext, getMessages, getRaw, read, resolveTarget, getFormatTarget } = {}) => {
  const messageFor = (id, context) => (getMessages(context.sessionId) || []).find(message => message.id === id);
  const captureIdentity = ({ messageId, context = getContext() } = {}) => {
    const message = messageFor(messageId, context);
    return { context: { ...context }, messageId, identity: agentToolMessageIdentity(message), messageState: messageState(message),
      cachedOriginal: typeof message?.rawOriginal === 'string' ? message.rawOriginal : undefined };
  };
  const isCurrent = snapshot => {
    if (!snapshot || agentToolContextKey(getContext()) !== agentToolContextKey(snapshot.context)) return false;
    const message = messageFor(snapshot.messageId, snapshot.context);
    if (!isAgentToolReply(message) || snapshot.cachedOriginal !== undefined && message.rawOriginal !== snapshot.cachedOriginal) return false;
    // UI mutation checks compare a small array of scalar/string identities; they
    // never serialize full replies or reassemble target text while streaming.
    return snapshot.messageState ? messageState(message).every((value, index) => value === snapshot.messageState[index])
      : agentToolMessageIdentity(message) === snapshot.identity;
  };
  const capture = async options => {
    if (options.expectedIdentity && (options.expectedIdentity.messageId !== options.messageId || !isCurrent(options.expectedIdentity))) return stale();
    const context = { ...(options.context || getContext()) }, messages = getMessages(context.sessionId) || [];
    const message = options.messageId ? messages.find(item => item.id === options.messageId) : [...messages].reverse().find(isAgentToolReply);
    const snapshot = { context, messageId: message?.id || '', identity: agentToolMessageIdentity(message), messageState: messageState(message),
      cachedOriginal: typeof message?.rawOriginal === 'string' ? message.rawOriginal : undefined };
    if (!isCurrent(snapshot)) return stale();
    snapshot.source = String(await getRaw(message, context.sessionId) ?? '');
    if (!isCurrent(snapshot)) return stale();
    snapshot.cachedOriginal = typeof message.rawOriginal === 'string' ? message.rawOriginal : undefined;
    return { ok: true, snapshot, message };
  };
  const captureSelection = async options => {
    const captured = await capture(options);
    if (!captured.ok) return captured;
    const { snapshot, message } = captured;
    const target = await resolveTarget(snapshot.source, { mode: 'rendered' }, {
      renderedSelection: String(options.selectedText || ''), message, context: snapshot.context,
    });
    if (!isCurrent(snapshot)) return stale();
    if (!target.ok) return target;
    return { ok: true, snapshot: { ...snapshot, target, selected: true } };
  };
  const validate = async snapshot => isCurrent(snapshot)
    && String(await getRaw(messageFor(snapshot.messageId, snapshot.context), snapshot.context.sessionId) ?? '') === snapshot.source
    && isCurrent(snapshot);
  const prepare = async options => {
    const captured = options.selectionSnapshot
      ? await validate(options.selectionSnapshot) ? { ok: true, snapshot: options.selectionSnapshot, message: messageFor(options.selectionSnapshot.messageId, options.selectionSnapshot.context) } : stale()
      : await capture(options);
    if (!captured.ok) return captured;
    const { snapshot, message } = captured, saved = read({ id: options.id, context: snapshot.context });
    if (!saved.config) return { ok: false, message: '此 Agent 已移除' };
    let target, formatTarget;
    if (saved.config.kind === 'format_review') {
      formatTarget = await getFormatTarget?.(message, snapshot.context);
      if (!formatTarget?.ok) return { ok: false, message: '只能检查最新一轮有完整原文的回复，请选择最新回复', reason: formatTarget?.reason };
      target = { ok: true, text: formatTarget.sourceText, source: formatTarget.sourceText };
    } else target = snapshot.selected ? snapshot.target : await resolveTarget(snapshot.source, saved.config.target, {
      bodyRule: saved.bodyRule, message, context: snapshot.context, readOnly: saved.config.outputMode === 'note',
    });
    if (!isCurrent(snapshot)) return stale();
    if (!target.ok) return target;
    return { ok: true, snapshot: { ...snapshot, target, formatTarget, agentId: options.id, configRevision: saved.revision,
      targetMode: saved.config.target?.mode === 'body' ? saved.bodyRule?.mode : saved.config.target?.mode,
      configUpdatedAt: saved.config.updatedAt, bodyRevision: saved.bodyRevision } };
  };
  return { captureIdentity, captureSelection, prepare, validate, isCurrent };
};
