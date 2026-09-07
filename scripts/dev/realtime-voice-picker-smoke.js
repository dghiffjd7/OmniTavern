(async () => {
  window.__voicePickerSmoke?.cleanup();
  const version = Date.now();
  const { RealtimeSettingsPanel } = await import(`/scripts/ui/realtime/realtime-settings-panel.js?voicePicker=${version}`);
  const { makeRealtimeProfile } = await import(`/scripts/ui/realtime/realtime-provider-catalog.js?voicePicker=${version}`);
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { RealtimeVoiceDiscovery } = await import('/scripts/ui/realtime/realtime-voice-discovery.js');
  const { initializeI18n, getCurrentLocale } = await import('/scripts/i18n/index.js');
  const locale = getCurrentLocale(), assert = (value, message) => { if (!value) throw new Error(message); };
  const fixture = document.createElement('section'); fixture.id = 'config-panel'; fixture.className = 'api-config-panel';
  fixture.style.cssText = 'position:fixed;inset:12px 12px 12px auto;width:min(720px,calc(100vw - 24px));height:calc(100vh - 24px);box-sizing:border-box;padding:18px;overflow:auto;background:var(--app-surface-card);z-index:100000;display:block;pointer-events:auto;transform:none;visibility:visible;opacity:1;border:1px solid var(--app-border-default);border-radius:16px;';
  fixture.innerHTML = '<div class="api-config-realtime-card"><div class="api-config-realtime-heading"></div></div>';
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = `/assets/css/api-config.css?voicePicker=${version}`;
  const loaded = new Promise(resolve => { style.onload = resolve; }); document.head.append(style); await loaded;
  document.body.append(fixture);
  const keys = new Map(); let sequence = 0, requestMode = 'success', mockRequests = 0, aborted = 0;
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
    keyring: { addKey: async (id, value) => { const key = `fixture_${++sequence}`; keys.set(key,value); return key; }, decryptKey: async (id,key) => keys.get(key), removeKey: async (id,key) => keys.delete(key) } });
  await store.ready; const saved = await store.save(makeRealtimeProfile('gemini_live'), { apiKey: 'SMOKE_ONLY' });
  const voiceDiscovery = new RealtimeVoiceDiscovery({ invoke: async name => {
    if (name === 'http_abort_request') { aborted++; return; }
    mockRequests++;
    if (requestMode === 'wait') return new Promise(() => {});
    if (requestMode === 'fail') return { status: 401, body: 'PRIVATE_CREDENTIAL_DETAIL' };
    return { status: 200, body: JSON.stringify({ voices: [{ voice_id: 'ara', name: 'Ara' }, { voice_id: 'future', name: '<img src=x onerror=alert(1)>', language: 'en' }] }) };
  } });
  const panel = new RealtimeSettingsPanel({ card: fixture.firstElementChild, store, voiceDiscovery }); await panel.ready;
  const query = id => fixture.querySelector(`#${id}`);
  const change = (id, value) => { const node = query(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
  const settle = async () => { const deadline = Date.now() + 3000; while (panel.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,10)); assert(!panel.busy, 'Action timed out'); };
  const show = provider => { panel.voicePicker?.destroy(); panel.draft = makeRealtimeProfile(provider); panel.secretDraft = {}; panel.dirty = false; panel.render(); };
  const prepare = async (width, locale) => {
    await initializeI18n({ preference: locale, fetchFn: url => fetch(`${url}?voicePicker=${version}`) });
    show('gemini_live'); query('rt-voice-picker').scrollIntoView({ block: 'start', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { width, locale, voices: query('rt-voice-options').querySelectorAll('[data-rt-voice]').length };
  };
  window.__voicePickerSmoke = {
    fixture, panel, query, show, change, prepare,
    async verify() {
      assert(query('rt-voice').tagName === 'INPUT', 'Voice dropdown remains');
      change('rt-voice-search', 'female'); assert(!panel.dirty && query('rt-voice').value === 'Kore', 'Search changed voice or dirty state');
      assert([...query('rt-voice-options').querySelectorAll('small')].every(node => /女声|Female/.test(node.textContent)), 'Gender filter incorrect');
      change('rt-voice-search', 'Sulafat'); query('rt-voice-options').querySelector('button').click();
      assert(query('rt-voice').value === 'Sulafat' && panel.dirty, 'Selection not captured');
      query('rt-save').click(); await settle(); assert(store.get(saved.id).voice === 'Sulafat', 'Selection not saved');
      change('rt-gemini-backend', 'vertex'); assert(query('rt-voice').value === 'Sulafat', 'Backend switch lost voice');
      change('rt-gemini-backend', 'developer'); change('rt-voice', 'Future_Voice_Case'); query('rt-save').click(); await settle();
      panel.refresh(); assert(query('rt-voice').value === 'Future_Voice_Case', 'Manual voice was overwritten');
      show('doubao_realtime'); change('rt-model', '2.2.0.0');
      assert(query('rt-voice-options').querySelectorAll('button').length === 21 && query('rt-voice').value.startsWith('saturn_'), 'SC2 list/default incorrect');
      show('step_realtime'); change('rt-model', 'step-audio-2-mini'); assert(query('rt-voice-options').querySelectorAll('button').length === 2, 'Step model voices not filtered');
      show('xai_voice'); change('rt-secret-apiKey', 'SMOKE_ONLY'); change('rt-voice', 'Ara'); panel.dirty = false;
      query('rt-refresh-voices').click(); await settle(); assert(query('rt-voice-options').querySelectorAll('button').length === 2, 'xAI not refreshed');
      assert(query('rt-voice').value === 'Ara' && !panel.dirty, 'Refresh changed voice or dirty state');
      assert(!query('rt-voice-options').querySelector('img'), 'Remote label was not escaped');
      requestMode = 'fail'; query('rt-refresh-voices').click(); await settle();
      assert(query('rt-voice-options').querySelectorAll('button').length === 2 && query('rt-voice').value === 'Ara', 'Failure discarded list or voice');
      assert(!query('rt-status').textContent.includes('PRIVATE'), 'Error leaked server detail');
      change('rt-secret-apiKey', 'OTHER_SMOKE'); assert(query('rt-voice-options').querySelectorAll('button').length === 28, 'Credential change retained remote catalog');
      requestMode = 'wait'; query('rt-refresh-voices').click(); await new Promise(resolve => setTimeout(resolve,30)); panel.hide(); await settle();
      assert(aborted === 1, 'Closing did not abort voice refresh');
      show('qwen_audio_realtime'); panel.draft.voiceKind = 'custom'; panel.draft.customVoices = [{ voiceId: 'Clone_Case', label: 'My clone', status: 'ready' }]; panel.draft.voice = 'Clone_Case'; panel.render();
      assert(query('rt-voice-options').querySelectorAll('button').length === 1 && query('rt-voice').value === 'Clone_Case', 'Clone selection changed');
      return { passed: true, search: 'read-only', selection: 'saved', manualId: 'preserved', modelBoundaries: 'passed', refresh: 'passed', cancelled: aborted, mockRequests, externalRequests: 0, userSettingsWrites: 0 };
    },
    async cleanup() { panel.hide(); panel.voicePicker?.destroy(); fixture.remove(); style.remove(); await initializeI18n({ preference: locale }); delete window.__voicePickerSmoke; },
  };
  return { ready: true };
})()
