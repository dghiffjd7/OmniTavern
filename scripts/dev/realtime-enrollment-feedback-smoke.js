(async () => {
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { RealtimeVoiceEnrollment } = await import('/scripts/ui/realtime/realtime-voice-enrollment.js');
  const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const fixture = document.createElement('section'); fixture.id = 'config-panel'; fixture.className = 'api-config-panel';
  fixture.style.cssText = 'position:fixed;inset:12px 12px 12px auto;width:min(720px,calc(100vw - 24px));height:calc(100vh - 24px);box-sizing:border-box;padding:18px;background:var(--app-surface-card);z-index:100000;display:block;pointer-events:auto;transform:none;visibility:visible;opacity:1;border:1px solid var(--app-border-default);border-radius:16px;';
  fixture.innerHTML = '<div class="api-config-scroll" style="height:100%;overflow:auto"><div class="api-config-realtime-card"><div class="api-config-realtime-heading"></div></div></div>';
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/assets/css/api-config.css'; document.head.append(style);
  await new Promise(resolve => { style.onload = resolve; }); document.body.append(fixture);
  const keys = new Map(), requests = []; let responseMode = 'success', pause = true, releaseUpload, releaseCreate, diskFailure = false;
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} },
    invoke: async name => { if (name === 'save_kv' && diskFailure) throw new Error('disk full'); return null; },
    keyring: { addKey: async (id, value) => { keys.set(id, value); return id; }, decryptKey: async id => keys.get(id), removeKey: async id => keys.delete(id) } });
  const saved = await store.save(makeRealtimeProfile('step_realtime'), { apiKey: 'SMOKE_KEY' });
  const enrollment = new RealtimeVoiceEnrollment({ invoke: async (name, args) => {
    assert(name === 'http_request', 'Unexpected command'); requests.push(args.url);
    if (args.url.endsWith('/files')) { if (pause) await new Promise(resolve => { releaseUpload = resolve; }); return { status: 200, body: '{"id":"file-test"}' }; }
    if (pause) await new Promise(resolve => { releaseCreate = resolve; });
    return responseMode === 'fail' ? { status: 400, body: '{"error":{"message":"Audio must be 5-10 seconds. SMOKE_KEY"}}' } : { status: 200, body: JSON.stringify({ id: diskFailure ? 'Cloud_Recovery_ID' : 'Clone_CASE' }) };
  } });
  const panel = new RealtimeSettingsPanel({ card: fixture.querySelector('.api-config-realtime-card'), store, enrollment }); await panel.ready;
  const query = id => fixture.querySelector(`#${id}`);
  const change = (id, value) => { const node = query(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
  const waitFor = async check => { const deadline = Date.now() + 3000; while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert(check(), 'Action timed out'); };
  const selectFile = () => { const transfer = new DataTransfer(); const file = new File([new Uint8Array(4)], 'sample.mp3', { type: 'audio/mpeg' }); transfer.items.add(file); query('rt-clone-file').files = transfer.files; query('rt-clone-file').dispatchEvent(new Event('input', { bubbles: true })); return file; };
  const visible = () => { const node = query('rt-clone-status'), rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 80), rect.top + Math.min(rect.height / 2, 10)); return hit === node || node.contains(hit); };
  const layout = async () => { query('rt-clone-status').scrollIntoView({ block: 'nearest' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return { visible: visible(), viewport: innerWidth, status: query('rt-clone-status').textContent, hasHorizontalOverflow: fixture.scrollWidth > fixture.clientWidth + 2 }; };
  const cleanup = () => { panel.hide(); panel.voicePicker?.destroy(); fixture.remove(); style.remove(); delete window.__realtimeCloneSmoke; };
  window.__realtimeCloneSmoke = { layout, cleanup };
  try {
    change('rt-voice-kind', 'custom'); fixture.querySelector('details').open = true; selectFile();
    query('rt-clone').click(); await waitFor(() => !!releaseUpload);
    assert(query('rt-clone').disabled && /创建|Creating|建立/.test(query('rt-clone').textContent), 'Busy button is missing');
    assert(/上传|Uploading|上傳/.test(query('rt-clone-status').textContent) && visible(), 'Upload feedback is not visible');
    releaseUpload(); await waitFor(() => !!releaseCreate);
    assert(/创建克隆|Creating the cloned|建立克隆/.test(query('rt-clone-status').textContent) && visible(), 'Creation phase is not visible');
    releaseCreate(); await waitFor(() => !panel.busy); pause = false;
    assert(query('rt-clone-status').textContent.includes('Clone_CASE') && visible(), 'Successful voice ID is not visible');
    assert(fixture.querySelector('details').open && query('rt-voice').value === 'Clone_CASE' && panel.dirty, 'First clone selection was lost');
    assert(store.get(saved.id).voiceKind === 'system', 'Cloning silently applied a voice');
    query('rt-save').click(); await waitFor(() => !panel.busy);
    assert(store.get(saved.id).voice === 'Clone_CASE', 'Save did not apply clone');
    change('rt-region', 'global'); const file = selectFile(), before = requests.length;
    query('rt-clone').click(); await waitFor(() => !panel.busy);
    assert(requests.length === before && query('rt-clone-status').dataset.type === 'error' && visible(), 'Unsaved site was submitted or error hidden');
    assert(query('rt-clone-file').files[0] === file, 'Validation discarded the selected file');
    change('rt-region', 'cn'); selectFile(); diskFailure = true;
    query('rt-clone').click(); await waitFor(() => !panel.busy);
    assert(query('rt-clone-status').textContent.includes('Cloud_Recovery_ID') && query('rt-clone-status').textContent.includes('disk full') && visible(), 'Cloud ID lost on local registration failure');
    diskFailure = false; responseMode = 'fail'; const retryFile = query('rt-clone-file').files[0];
    query('rt-clone').click(); await waitFor(() => !panel.busy);
    const error = query('rt-clone-status').textContent;
    assert(error.includes('400') && error.includes('5-10 seconds') && !error.includes('SMOKE_KEY'), 'Provider reason missing or credential leaked');
    assert(!query('rt-clone').disabled && query('rt-clone-file').files[0] === retryFile && visible(), 'Retry lost its file or visible feedback');
    return { passed: true, firstCloneCreated: true, explicitVoiceSave: true, uploadAndCreationVisible: true, unsavedSiteBlocked: true, cloudIdRecoverable: true, providerFailureVisible: true, selectedFilePreserved: true, userSettingsWrites: 0, externalRequests: 0 };
  } catch (error) { cleanup(); throw error; }
})()
