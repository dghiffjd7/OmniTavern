(async () => {
  const { RealtimePcmAudio } = await import('/scripts/ui/realtime/realtime-pcm-audio.js');
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ctx = new AudioContext(), oscillator = ctx.createOscillator(), destination = ctx.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start(); await ctx.resume();
  let frames = [], audioError = null;
  const audio = new RealtimePcmAudio({ microphoneAccess: { acquire: async () => destination.stream }, onFrame: frame => frames.push(frame), onError: error => { audioError = error; } });
  try {
    await audio.open({ inputRate: 16000, outputRate: 24000 });
    const deadline = Date.now() + 3000; while (frames.length < 3 && !audioError && Date.now() < deadline) await wait(50);
    assert(frames.length >= 3 && frames[0].length === 640, `PCM capture/worklet failed: ${JSON.stringify({ count: frames.length, sizes: frames.map(frame => frame.length), captureState: audio.context?.state, sourceState: ctx.state, inputRate: audio.context?.sampleRate, captureTime: audio.context?.currentTime, sourceTime: ctx.currentTime, visibility: document.visibilityState, error: audioError?.message, trackState: destination.stream.getTracks().map(track => track.readyState) })}`);
    audio.setMicrophoneMuted(true); frames = []; await wait(100);
    assert(frames.length && frames.every(frame => frame.every(byte => byte === 0)), 'Muted microphone leaked audio');
    audio.setOutputMuted(true); audio.play(new Uint8Array(4800)); assert(audio.sources.size === 1, 'PCM playback not scheduled');
    audio.clear(); assert(audio.sources.size === 0, 'Interruption did not clear PCM playback');
    assert(!audioError, audioError?.message || 'Audio error');
  } finally { await audio.close(); oscillator.stop(); await ctx.close(); }
  assert(destination.stream.getTracks().every(track => track.readyState === 'ended'), 'Audio tracks not released');
  const fixture = document.createElement('section'); fixture.id = 'realtime-smoke-fixture'; fixture.style.display = 'none'; fixture.innerHTML = '<div class="api-config-realtime-heading"></div><div></div>'; document.body.append(fixture);
  const keys = new Map(); let keyId = 0;
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
    keyring: { addKey: async (id, value) => { const key = `test_${++keyId}`; keys.set(key, value); return key; }, decryptKey: async (id, key) => keys.get(key), removeKey: async (id, key) => keys.delete(key) } });
  const panel = new RealtimeSettingsPanel({ card: fixture, store });
  const click = async id => { fixture.querySelector(`#${id}`).click(); await wait(30); };
  const input = (id, value) => { const node = fixture.querySelector(`#${id}`); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
  const change = (id, value) => { const node = fixture.querySelector(`#${id}`); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
  try {
    await panel.ready; await click('rt-new'); change('rt-provider', 'qwen_audio_realtime');
    input('rt-name', 'Offline smoke'); input('rt-secret-apiKey', 'FAKE_KEY_NEVER_SENT'); await click('rt-save');
    assert(store.list().length === 1 && store.activeId, fixture.querySelector('#rt-status').textContent);
    input('rt-voice-label', 'Test clone'); input('rt-voice-id', 'Voice_CaseSensitive'); await click('rt-register');
    assert(store.get(store.activeId).customVoices[0].voiceId === 'Voice_CaseSensitive', 'Voice registration failed');
    change('rt-voice-kind', 'custom'); await click('rt-save');
    assert((await store.resolve()).settings.voice === 'Voice_CaseSensitive', 'Custom voice did not resolve');
    if (fixture.querySelector('#rt-bind')) { await click('rt-bind'); assert(Object.keys(store.state.bindings).length === 1, 'Character voice binding failed'); }
    const saved = store.get(store.activeId); panel.draft = { ...saved, provider: 'doubao_realtime', id: '', model: '1.2.1.1', voiceKind: 'system' }; panel.render(); change('rt-model', '2.2.0.0');
    assert(fixture.querySelector('#rt-voice').value.startsWith('saturn_'), 'SC2.0 did not switch voice family');
  } finally { panel.hide(); fixture.remove(); }
  const { safeInvoke } = await import('/scripts/utils/tauri.js');
  const { createTauriPluginChannel } = await import('/scripts/ui/app-native-back-button-utils.js');
  const channel = createTauriPluginChannel({ callback: () => {} });
  try {
    let rejection = '';
    try { await safeInvoke('realtime_transport_open', { id: 'realtime_offline_probe', connection: { provider: 'unsupported', model: 'fixture', credentials: {} }, onEvent: channel }); }
    catch (error) { rejection = String(error.message || error); }
    assert(rejection.includes('Unsupported realtime provider'), `Native realtime command unavailable: ${rejection}`);
  } finally { globalThis.__TAURI_INTERNALS__?.unregisterCallback?.(channel.id); }
  return { nativeCommand: 'passed', pcmWorklet: 'passed', microphoneMute: 'passed', playbackInterrupt: 'passed', trackCleanup: 'passed', profileSave: 'passed', customVoice: 'passed', doubaoGeneration: 'passed', externalRequests: 0 };
})()
