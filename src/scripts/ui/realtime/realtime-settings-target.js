// The app runtime owns target resolution; the settings panel only consumes it.
let resolver = null, startCall = null;
export const registerRealtimeSettingsTarget = (getTarget, start) => {
  resolver = getTarget; startCall = start;
  return () => { if (resolver === getTarget) { resolver = null; startCall = null; } };
};
export const getRealtimeSettingsTarget = () => resolver?.() || null;
export const startRealtimeSettingsCall = () => startCall?.() || false;
export const realtimeTargetBindingKey = target => target?.supported && target.sessionId
  ? JSON.stringify([String(target.scopeId || 'default'), ['rp', 'maid'].includes(target.uiMode) ? target.uiMode : 'chat', String(target.sessionId)]) : '';
