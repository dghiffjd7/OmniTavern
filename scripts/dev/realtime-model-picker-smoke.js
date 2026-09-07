(async () => {
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { RealtimeModelDiscovery, buildNovaModelsRequest } = await import('/scripts/ui/realtime/realtime-model-discovery.js');
  const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = () => new Promise(resolve => setTimeout(resolve, 10));
  const fixture = document.createElement('section'); fixture.hidden = true; fixture.innerHTML = '<div class="api-config-realtime-heading"></div>'; document.body.append(fixture);
  let behavior = 'success', httpRequests = 0, aborts = 0, writes = 0;
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => { writes++; } }, invoke: async name => { if (name === 'save_kv') writes++; return null; } });
  const discovery = new RealtimeModelDiscovery({ invoke: async (name, args) => {
    if (name === 'http_abort_request') { aborts++; return; }
    assert(name === 'http_request', 'Unexpected native command'); httpRequests++;
    assert(args.headers['x-goog-api-key'] === 'SMOKE_KEY', 'Unsaved API Key not used');
    if (behavior === 'pending') return new Promise(() => {});
    if (behavior === 'error') return { status: 403, body: 'SMOKE_KEY' };
    return { status: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-3.1-flash-live-preview' }, { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025' }] }) };
  } });
  const panel = new RealtimeSettingsPanel({ card: fixture, store, modelDiscovery: discovery });
  const input = (id, value) => { const node = fixture.querySelector(`#${id}`); node.value = value; node.dispatchEvent(new Event('input')); };
  const refresh = async () => { fixture.querySelector('#rt-refresh-models').click(); while (panel.busy) await wait(); };
  try {
    await panel.ready; fixture.querySelector('#rt-new').click(); await wait();
    assert(fixture.querySelector('#rt-model').value === makeRealtimeProfile().model, 'Default model missing');
    input('rt-secret-apiKey', 'SMOKE_KEY'); input('rt-model', 'gemini-my-manual-live');
    await refresh(); assert(httpRequests === 1 && fixture.querySelectorAll('.api-config-model-chip').length === 2, 'Refresh candidates missing');
    assert(fixture.querySelector('#rt-model').value === 'gemini-my-manual-live', 'Refresh overwrote manual model');
    fixture.querySelectorAll('.api-config-model-chip')[1].click(); const selected = fixture.querySelector('#rt-model').value;
    assert(selected === 'gemini-2.5-flash-native-audio-preview-12-2025' && panel.dirty, 'Candidate selection failed');
    behavior = 'error'; await refresh();
    assert(fixture.querySelector('#rt-model').value === selected && fixture.querySelectorAll('.api-config-model-chip').length === 2, 'Error cleared current model/list');
    assert(fixture.querySelector('#rt-status').dataset.type === 'error' && !fixture.querySelector('#rt-status').textContent.includes('SMOKE_KEY'), 'Error leaks credential');
    behavior = 'pending'; fixture.querySelector('#rt-refresh-models').click(); while (httpRequests < 3) await wait(); panel.hide(); while (panel.busy) await wait();
    assert(aborts === 1 && !fixture.querySelector('#rt-refresh-models').disabled, 'Hide did not cancel refresh');
    input('rt-secret-apiKey', 'CHANGED'); assert(!fixture.querySelectorAll('.api-config-model-chip').length, 'Old account model list retained');
    assert(writes === 0, 'Refresh saved profile or credentials');
    const nova = await buildNovaModelsRequest(makeRealtimeProfile('nova_sonic'), { accessKeyId: 'SMOKE_ACCESS', secretAccessKey: 'SMOKE_SECRET', sessionToken: 'SMOKE_SESSION' });
    assert(nova.headers.authorization.includes('/bedrock/aws4_request') && nova.headers['x-amz-security-token'] === 'SMOKE_SESSION', 'AWS signer unavailable in browser');
    return { passed: true, defaultModel: true, manualInputPreserved: true, refreshAndSelect: true, failurePreservesList: true, cancel: true, accountIsolation: true, browserAwsSigner: true, persistenceWrites: writes, externalRequests: 0 };
  } finally { panel.hide(); fixture.remove(); }
})()
