(async () => {
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { RealtimeModelDiscovery } = await import('/scripts/ui/realtime/realtime-model-discovery.js');
  const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const fixture = document.createElement('section'); fixture.hidden = true;
  fixture.innerHTML = '<div class="api-config-realtime-heading"></div>'; document.body.append(fixture);
  const keys = new Map(), requests = [];
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
    keyring: { addKey: async (id, value) => { keys.set(id, value); return id; }, decryptKey: async id => keys.get(id), removeKey: async id => keys.delete(id) } });
  await store.ready; const saved = await store.save(makeRealtimeProfile('step_realtime'), { apiKey: 'SMOKE_ONLY' });
  const modelDiscovery = new RealtimeModelDiscovery({ invoke: async (name, args) => {
    requests.push(args.url); assert(args.headers.Authorization === 'Bearer SMOKE_ONLY', 'Draft key was lost on site change');
    return { status: 200, body: JSON.stringify({ data: [{ id: 'stepaudio-2.5-realtime' }] }) };
  } });
  const panel = new RealtimeSettingsPanel({ card: fixture, store, modelDiscovery });
  const query = id => fixture.querySelector(`#${id}`);
  const change = (id, value) => { const node = query(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
  const settle = async () => { const deadline = Date.now() + 3000; while (panel.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert(!panel.busy, 'Action timed out'); };
  const voices = () => query('rt-voice-options').querySelectorAll('[data-rt-voice]').length;
  try {
    await panel.ready;
    assert(query('rt-region').options.length === 2 && query('rt-region').value === 'cn', 'Site options missing');
    assert(voices() === 34, 'Mainland voices missing');
    query('rt-refresh-models').click(); await settle();
    assert(query('rt-model-options').children.length === 1, 'Mainland models missing');
    change('rt-secret-apiKey', 'SMOKE_ONLY'); change('rt-model', 'stepaudio-future-realtime');
    change('rt-region', 'global');
    assert(voices() === 7 && query('rt-voice').value === 'soft-spoken-gentleman', 'International voice list/default incorrect');
    assert(query('rt-model-options').children.length === 0, 'Old site models were retained');
    assert(query('rt-model').value === 'stepaudio-future-realtime', 'Manual model was overwritten');
    query('rt-refresh-models').click(); await settle();
    assert(requests[0] === 'https://api.stepfun.com/v1/models' && requests[1] === 'https://api.stepfun.ai/v1/models', 'Refresh site mismatch');
    query('rt-save').click(); await settle();
    const profile = store.get(saved.id);
    assert(profile.region === 'global' && profile.voice === 'soft-spoken-gentleman', 'Site/voice were not saved');
    assert((await store.resolve()).config.region === 'global', 'Call config uses wrong site');
    change('rt-region', 'cn'); assert(voices() === 34 && query('rt-voice').value === 'soft-spoken-gentleman', 'Shared voice lost');
    change('rt-voice', 'Manual_CASE'); change('rt-region', 'global');
    assert(query('rt-voice').value === 'Manual_CASE', 'Manual voice was overwritten');
    panel.draft.voiceKind = 'custom'; panel.draft.voice = 'Clone_CASE';
    panel.draft.customVoices = [{ voiceId: 'Clone_CASE', status: 'ready', region: 'global', credentialId: profile.credentialId, workspaceId: '' }]; panel.render();
    change('rt-region', 'cn');
    assert(query('rt-voice').value === 'Clone_CASE' && panel.draft.customVoices[0].region === 'global', 'Clone was silently moved to another site');
    query('rt-save').click(); await settle();
    assert(query('rt-status').dataset.type === 'error' && store.get(saved.id).region === 'global', 'Cross-site clone save was accepted');
    return { passed: true, sites: 2, mainlandVoices: 34, internationalVoices: 7, modelRefreshAndSave: true, compatibleAndManualVoicesPreserved: true, crossSiteCloneRejected: true, userSettingsWrites: 0, externalRequests: 0 };
  } finally { panel.hide(); panel.voicePicker?.destroy(); fixture.remove(); }
})()
