import assert from 'node:assert/strict';

import {
  createRealtimeCallAppRuntime,
  isRealtimeCallTargetMatch,
  resolveRealtimeCallTarget,
} from '../../src/scripts/ui/realtime/realtime-call-app-runtime.js';

{
  const target = resolveRealtimeCallTarget({
    uiMode: 'rp',
    currentSessionId: '',
    activePersonaId: 'persona-1',
    getRpSessionId: personaId => `rp:${personaId}`,
    scopeId: 'persona-1',
    lifecycleEpoch: 7,
    getContact: () => null,
    formatSessionName: sessionId => `name:${sessionId}`,
    getAssistantAvatar: sessionId => `avatar:${sessionId}`,
  });
  assert.deepEqual(target, {
    supported: true,
    sessionId: 'rp:persona-1',
    scopeId: 'persona-1',
    lifecycleEpoch: 7,
    uiMode: 'rp',
    name: 'name:rp:persona-1',
    avatar: 'avatar:rp:persona-1',
  });
}

{
  const target = resolveRealtimeCallTarget({
    uiMode: 'rp',
    currentSessionId: 'social-room-1',
    activePersonaId: 'persona-2',
    getRpSessionId: personaId => `rp:${personaId}`,
    getContact: sessionId => ({ id: sessionId, name: '社交角色' }),
    formatSessionName: sessionId => sessionId,
    getAssistantAvatar: sessionId => sessionId,
  });
  assert.equal(target.supported, true);
  assert.equal(target.sessionId, 'rp:persona-2');
  assert.equal(target.uiMode, 'rp');
}

{
  const staleRpInSocialMode = resolveRealtimeCallTarget({
    uiMode: 'chat',
    currentSessionId: 'rp:persona-1',
  });
  assert.equal(staleRpInSocialMode.supported, false);

  const group = resolveRealtimeCallTarget({
    uiMode: 'chat',
    currentSessionId: 'group:1',
    getContact: () => ({ isGroup: true }),
  });
  assert.equal(group.supported, false);

  assert.equal(isRealtimeCallTargetMatch(
    { supported: true, sessionId: 'rp:p1', scopeId: 'p1', lifecycleEpoch: 3, uiMode: 'rp' },
    { supported: true, sessionId: 'rp:p1', scopeId: 'p1', lifecycleEpoch: 3, uiMode: 'rp' },
  ), true);
  assert.equal(isRealtimeCallTargetMatch(
    { supported: true, sessionId: 'rp:p1', scopeId: 'p1', lifecycleEpoch: 3, uiMode: 'rp' },
    { supported: true, sessionId: 'social-1', scopeId: 'p1', lifecycleEpoch: 3, uiMode: 'chat' },
  ), false);
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  async fire(type) { return await this.listeners.get(type)?.(); }
}

const button = new FakeEventTarget();
button.classList = { toggle() {} };
button.setAttribute = () => {};
const documentRef = new FakeEventTarget();
documentRef.visibilityState = 'visible';
const windowLike = new FakeEventTarget();
const panelCalls = [];
const panel = {
  show: (target, options) => panelCalls.push(['show', target.sessionId, options?.expanded === true]),
  hide: () => panelCalls.push(['hide']),
  destroy: () => panelCalls.push(['destroy']),
  renderState: state => panelCalls.push(['state', state.status]),
  setAudioLevel: value => panelCalls.push(['audioLevel', value]),
  setCaption: value => panelCalls.push(['caption', value.text]),
  setWarning: value => panelCalls.push(['warning', value]),
  setUsage: value => panelCalls.push([
    'usage',
    value.responseCount,
    value.transcriptionCount,
    value.response?.inputTextTokens ?? null,
    value.transcription?.totalTokens ?? null,
  ]),
};
let runtimeOptions;
let runtimeStatus = 'idle';
const runtime = {
  getState: () => ({ status: runtimeStatus, muted: false, outputMuted: false }),
  start: async () => {
    runtimeStatus = 'listening';
    runtimeOptions.onStateChange({ status: 'listening' });
    return true;
  },
  end: async reason => {
    panelCalls.push(['end', reason]);
    runtimeStatus = 'idle';
    runtimeOptions.onStateChange({ status: 'idle' });
    return true;
  },
};
let invalidated = '';
let settingsOpened = 0;
const appRuntime = createRealtimeCallAppRuntime({
  button,
  documentRef,
  windowLike,
  getCallTarget: () => ({ supported: true, sessionId: 'contact-1' }),
  resolveConnection: async () => ({}),
  buildSemanticSnapshot: async () => ({}),
  isTargetCurrent: () => true,
  commitUserMessage: async () => ({}),
  commitAssistantMessage: async () => ({}),
  openVoiceSettings: () => { settingsOpened += 1; },
  onLifecycleInvalidated: reason => { invalidated = reason; },
  createPanel: options => {
    assert.equal(options.windowLike, windowLike);
    return panel;
  },
  createRuntime: options => {
    runtimeOptions = options;
    return runtime;
  },
});

assert.equal(button.hidden, false);
await button.fire('click');
assert.equal(runtimeStatus, 'listening');
assert.deepEqual(panelCalls.slice(0, 4), [
  ['usage', 0, 0, null, null],
  ['warning', ''],
  ['caption', '连接后即可自然说话'],
  ['show', 'contact-1', true],
]);

await button.fire('click');
assert.deepEqual(panelCalls.at(-1), ['show', 'contact-1', true], 'active call opens its controls');

const meterFrame = { input: { level: .3, bands: [.1] }, output: { level: 0, bands: [] } };
runtimeOptions.onAudioLevel(meterFrame);
assert.deepEqual(panelCalls.at(-1), ['audioLevel', meterFrame]);

runtimeOptions.onUsage({
  type: 'response',
  usage: { input_token_details: { text_tokens: 7 } },
});
runtimeOptions.onUsage({ type: 'transcription', usage: { total_tokens: 11 } });
assert.deepEqual(panelCalls.at(-1), ['usage', 1, 1, 7, 11]);
runtimeOptions.onError(Object.assign(new Error('请设置连接'), { code: 'realtime_config_profile_missing' }));
assert.equal(settingsOpened, 1);

runtimeOptions.onStateChange({ status: 'idle' });
assert.deepEqual(panelCalls.at(-1), ['hide'], 'remote/automatic call completion removes the pill');

documentRef.visibilityState = 'hidden';
await documentRef.fire('visibilitychange');
assert.equal(invalidated, 'app_background');
assert.ok(panelCalls.some(call => call[0] === 'end' && call[1] === 'app_background'));

await appRuntime.destroy();
assert.equal(button.listeners.has('click'), false);
assert.deepEqual(panelCalls.at(-1), ['destroy']);
assert.equal(windowLike.listeners.size, 0);
assert.equal(documentRef.listeners.size, 0);

console.log('realtime call app runtime tests passed');
