// Routing metadata travels beside generation options, never in the model body.
let contextResolver = null;
const trim = value => String(value ?? '').trim();

export const setRequestContextResolver = resolver => {
  contextResolver = typeof resolver === 'function' ? resolver : null;
};

export const captureRequestContext = (context = {}) => {
  if (context?.captured === true && Object.isFrozen(context)) return context;
  const source = context && typeof context === 'object' ? context : {};
  // Callers must name their conversation. Standalone tests/editors keep a client-local ID.
  const sessionId = trim(source.sessionId);
  const resolved = source.captured !== true && sessionId && contextResolver
    ? contextResolver({ ...source, sessionId }) : source;
  return Object.freeze({
    captured: true,
    scopeId: trim(resolved?.scopeId),
    sessionId,
    archiveId: trim(resolved?.archiveId),
  });
};
