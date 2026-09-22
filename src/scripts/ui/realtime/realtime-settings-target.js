// The app runtime owns target resolution; the settings panel only consumes it.
let resolver = null, startCall = null, callBusy = null, checking = false;
export const registerRealtimeSettingsTarget = (getTarget, start, isBusy = () => false) => {
  resolver = getTarget; startCall = start; callBusy = isBusy;
  return () => { if (resolver === getTarget) { resolver = null; startCall = null; callBusy = null; } };
};
export const isRealtimeSettingsCheckActive = () => checking;
export const acquireRealtimeSettingsCheck = () => {
  if (checking || callBusy?.()) return null;
  checking = true;
  return () => { checking = false; };
};
export const getRealtimeSettingsTarget = () => resolver?.() || null;
export const startRealtimeSettingsCall = () => startCall?.() || false;
export const realtimeTargetBindingKey = target => target?.supported && target.sessionId
  ? JSON.stringify([String(target.scopeId || 'default'), ['rp', 'maid'].includes(target.uiMode) ? target.uiMode : 'chat', String(target.sessionId)]) : '';
