(async () => {
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { safeInvoke } = await import('/scripts/utils/tauri.js');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const fixture = document.createElement('section'); fixture.hidden = true; fixture.innerHTML = '<div class="api-config-realtime-heading"></div>'; document.body.append(fixture);
  const keys = new Map(); let sequence = 0;
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
    keyring: { addKey: async (id, value) => { const key = `key_${++sequence}`; keys.set(key, value); return key; }, decryptKey: async (id, key) => keys.get(key), removeKey: async (id, key) => keys.delete(key) } });
  const panel = new RealtimeSettingsPanel({ card: fixture, store });
  const change = (id, value) => { const node = fixture.querySelector(`#${id}`); node.value = value; node.dispatchEvent(new Event('input')); node.dispatchEvent(new Event('change')); };
  const save = async () => { fixture.querySelector('#rt-save').click(); while (panel.busy) await new Promise(resolve => setTimeout(resolve, 10)); };
  try {
    await panel.ready; fixture.querySelector('#rt-new').click(); await new Promise(resolve => setTimeout(resolve, 20));
    change('rt-gemini-backend', 'vertex');
    change('rt-secret-vertexaiServiceAccount', JSON.stringify({ project_id: 'smoke-project', client_email: 'smoke@smoke-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nSMOKE_ONLY\n-----END PRIVATE KEY-----' }));
    change('rt-vertex-auth-mode', 'express'); assert(fixture.querySelector('#rt-secret-vertexaiApiKey'), 'Express key missing');
    change('rt-vertex-auth-mode', 'service_account'); assert(fixture.querySelector('textarea').value.includes('SMOKE_ONLY'), 'JSON draft lost on mode change');
    await save(); assert(panel.draft.id && panel.draft.vertexaiProjectId === 'smoke-project', 'Service Account save/project detection failed');
    assert(!fixture.querySelector('textarea').value && !fixture.innerHTML.includes('SMOKE_ONLY'), 'Saved private key echoed');
    change('rt-vertex-auth-mode', 'express'); await save(); assert(panel.dirty && fixture.querySelector('#rt-status').dataset.type === 'error', 'Wrong credential accepted for Express');
    change('rt-secret-vertexaiApiKey', 'EXPRESS_SMOKE'); await save(); assert(store.get(panel.draft.id).vertexaiAuthMode === 'express', 'Express not saved');
    change('rt-vertex-auth-mode', 'service_account'); await save(); assert(!panel.dirty && (await store.resolve()).config.credentials.vertexaiServiceAccount.includes('SMOKE_ONLY'), 'Saved Service Account lost');
    assert(!JSON.stringify(store.state).includes('SMOKE_ONLY') && !JSON.stringify(store.state).includes('EXPRESS_SMOKE'), 'Secrets in profile metadata');
    // Invalid mode fails validation before native networking; this also checks the running binary is current.
    let rejection = '';
    try { await safeInvoke('realtime_transport_open', { id: 'vertex_offline_probe', connection: { provider: 'gemini_live', model: 'gemini-live-2.5-flash-native-audio', geminiBackend: 'vertex', vertexaiAuthMode: 'invalid', credentials: {} }, onEvent: '__CHANNEL__:0' }); }
    catch (error) { rejection = String(error); }
    assert(rejection.includes('Invalid Vertex authentication mode'), `Native Vertex command not current: ${rejection}`);
    return { passed: true, modes: 3, jsonDraft: 'preserved', savedSecret: 'hidden', project: 'detected', credentialIsolation: 'passed', nativeVertex: 'passed', externalRequests: 0 };
  } finally { panel.hide(); fixture.remove(); }
})()
