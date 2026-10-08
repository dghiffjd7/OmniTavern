const clonePayload = (payload = null) =>
  payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : null;

const mergeMeta = (current = null, next = null) => ({
  ...((current && typeof current === 'object') ? current : {}),
  ...((next && typeof next === 'object') ? next : {}),
});

export const isStreamCtrlConnected = (ctrl) => {
  if (!ctrl) return false;
  if (typeof ctrl.isConnected !== 'function') return true;
  try {
    return ctrl.isConnected() !== false;
  } catch {
    return false;
  }
};

export const createAssistantStreamRuntime = ({
  generationId = 0,
  sessionId = '',
  getStreamCtrl = () => null,
  setStreamCtrl = () => null,
  getActiveGeneration = () => null,
  isGenerationInterrupted = () => false,
  isSessionActive = () => false,
  createAssistantStreamCtrl = () => null,
  hideTyping = () => {},
  fastForwardDelivery = () => {},
} = {}) => {
  const withMatchingGeneration = (handler) => {
    const generation = getActiveGeneration();
    if (!generation || generation.id !== generationId || generation.sessionId !== sessionId) return null;
    handler(generation);
    return generation;
  };

  const updateActiveGenerationStreamCache = (text, meta = {}, payload = null) => {
    withMatchingGeneration((generation) => {
      generation.streamText = String(text ?? '');
      generation.lastActivityAt = Date.now();
      generation.streamPayload = clonePayload(payload);
      generation.streamMeta = mergeMeta(generation.streamMeta, meta);
    });
  };

  const ensureAssistantStreamCtrl = (meta = {}) => {
    if (isGenerationInterrupted(generationId)) return null;

    let streamCtrl = getStreamCtrl();
    if (isStreamCtrlConnected(streamCtrl)) return streamCtrl;
    if (streamCtrl && !isStreamCtrlConnected(streamCtrl)) {
      streamCtrl = setStreamCtrl(null);
    }

    const generation = getActiveGeneration();
    const sharedCtrl =
      generation?.id === generationId && generation?.sessionId === sessionId
        ? generation.streamCtrl
        : null;
    if (sharedCtrl && sharedCtrl !== streamCtrl && isStreamCtrlConnected(sharedCtrl)) {
      return setStreamCtrl(sharedCtrl);
    }

    if (!isSessionActive(sessionId)) {
      withMatchingGeneration((currentGeneration) => {
        currentGeneration.streamCtrl = null;
      });
      return null;
    }

    hideTyping();
    fastForwardDelivery(sessionId);
    const nextCtrl = createAssistantStreamCtrl(meta);
    if (!nextCtrl) return null;

    streamCtrl = setStreamCtrl(nextCtrl);
    withMatchingGeneration((currentGeneration) => {
      currentGeneration.streamCtrl = nextCtrl;
      currentGeneration.streamMeta = mergeMeta(currentGeneration.streamMeta, meta);
    });
    return streamCtrl;
  };

  const pushAssistantStreamText = (value, meta = {}) => {
    const payload = clonePayload(value);
    const renderedText = payload ? String(payload.content ?? '') : String(value ?? '');
    updateActiveGenerationStreamCache(renderedText, meta, payload);
    const streamCtrl = ensureAssistantStreamCtrl(meta);
    if (streamCtrl) streamCtrl.update(payload || renderedText);
    return streamCtrl;
  };

  const bindActiveGenerationReattach = () => {
    withMatchingGeneration((generation) => {
      generation.reattachStream = () => {
        if (isGenerationInterrupted(generationId)) return false;
        const meta =
          generation.streamMeta && typeof generation.streamMeta === 'object'
            ? generation.streamMeta
            : {};
        const payload = clonePayload(generation.streamPayload);
        const text = String(generation.streamText ?? '');
        const streamCtrl = ensureAssistantStreamCtrl(meta);
        if (streamCtrl && (payload || text)) streamCtrl.update(payload || text);
        return Boolean(streamCtrl);
      };
    });
  };

  return {
    updateActiveGenerationStreamCache,
    ensureAssistantStreamCtrl,
    pushAssistantStreamText,
    bindActiveGenerationReattach,
  };
};
