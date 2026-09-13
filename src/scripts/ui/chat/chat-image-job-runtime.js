const trim = value => String(value ?? '').trim();

const isRunningImageMessage = message => Boolean(
  message && (!message.type || message.type === 'text')
  && message.meta?.generatedMedia?.kind === 'image'
  && message.meta.generatedMedia.status === 'running'
);

const buildTerminalPatch = (message, status, now) => {
  const generated = message.meta.generatedMedia;
  const content = status === 'cancelled'
    ? (generated.surface === 'writing' ? '插图生成已取消' : generated.surface === 'moments' ? '配图生成已取消' : '图片生成已取消')
    : (generated.surface === 'writing' ? '插图生成已中断' : generated.surface === 'moments' ? '配图生成已中断' : '图片生成已中断');
  return {
    type: 'text',
    content,
    meta: {
      ...message.meta,
      generatedMedia: {
        ...generated,
        status,
        error: status === 'interrupted' ? '生成连接已中断，可重新生成' : '',
        finishedAt: now(),
      },
    },
  };
};

/** Owns only requests in this process; persisted `running` messages are not resumable jobs. */
export const createChatImageJobRuntime = ({
  getContextKey = () => '',
  getMessage = () => null,
  updateMessage = () => null,
  onUpdated = () => {},
  now = () => Date.now(),
} = {}) => {
  const owners = new Map();
  const contextFor = sessionId => trim(getContextKey(sessionId));
  const keyFor = (messageId, sessionId, context = contextFor(sessionId)) => (
    JSON.stringify([context, trim(sessionId), trim(messageId)])
  );
  const ownerIsActive = owner => Boolean(owner && !owner.controller.signal.aborted);

  const has = (messageId, sessionId) => (
    ownerIsActive(owners.get(keyFor(messageId, sessionId)))
  );

  const register = ({ sessionId = '', messageId = '', controller } = {}) => {
    const sid = trim(sessionId);
    const mid = trim(messageId);
    if (!sid || !mid || typeof controller?.abort !== 'function' || !controller.signal) {
      throw new TypeError('Image job requires a session, message and AbortController');
    }
    if (controller.signal.aborted) throw new Error('Cannot register an aborted image job');
    const context = contextFor(sid);
    const key = keyFor(mid, sid, context);
    if (ownerIsActive(owners.get(key))) throw new Error('Image job is already active');
    const owner = { controller };
    owners.set(key, owner);
    return {
      // An externally aborted owner may still settle its cancellation. cancel() revokes ownership first.
      isCurrent() {
        return owners.get(key) === owner
          && contextFor(sid) === context
          && isRunningImageMessage(getMessage(mid, sid));
      },
      release() {
        if (owners.get(key) !== owner) return false;
        owners.delete(key);
        return true;
      },
    };
  };

  const applyTerminal = (message, sessionId, status) => {
    const mid = trim(message.id);
    const updated = updateMessage(mid, buildTerminalPatch(message, status, now), sessionId);
    if (updated) onUpdated(mid, updated, sessionId);
    return updated || null;
  };

  const cancel = (messageId, sessionId) => {
    const sid = trim(sessionId);
    const mid = trim(messageId);
    const message = sid && mid ? getMessage(mid, sid) : null;
    if (!isRunningImageMessage(message)) {
      return { changed: false, active: false, status: String(message?.meta?.generatedMedia?.status || '') };
    }
    const key = keyFor(mid, sid);
    const owner = owners.get(key);
    const active = ownerIsActive(owner);
    // Revoke and save before abort listeners fire, so an old catch/finally cannot overwrite a retry.
    owners.delete(key);
    let updated;
    try {
      updated = applyTerminal(message, sid, 'cancelled');
    } finally {
      if (owner && !owner.controller.signal.aborted) owner.controller.abort('cancelled by user');
    }
    return { changed: Boolean(updated), active, status: updated ? 'cancelled' : String(message.meta.generatedMedia.status) };
  };

  const recover = (messages = [], sessionId = '') => {
    const list = Array.isArray(messages) ? messages : [];
    const sid = trim(sessionId);
    if (!sid) return list;
    const context = contextFor(sid);
    let changed = false;
    const result = list.map(message => {
      if (contextFor(sid) !== context || !isRunningImageMessage(message)) return message;
      const mid = trim(message.id);
      if (!mid || has(mid, sid)) return message;
      // The loaded list can precede a completion. Always reconcile the current stored record.
      const current = getMessage(mid, sid);
      if (!current || !isRunningImageMessage(current)) {
        if (current && current !== message) changed = true;
        return current || message;
      }
      owners.delete(keyFor(mid, sid, context));
      const updated = applyTerminal(current, sid, 'interrupted');
      if (!updated) return message;
      changed = true;
      return updated;
    });
    return changed ? result : list;
  };

  return { register, has, cancel, recover };
};
