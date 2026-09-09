// Run from Windows PowerShell against the inspectable dev App (CDP 9222).
// Uses isolated stores and mocked discovery; restores the browser capability.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const smoke = async () => {
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { normalizeHopscotchBoard } = await import('/scripts/ui/chat/hopscotch-board-utils.js');
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
  const { getRealtimeSystemVoices } = await import('/scripts/ui/realtime/realtime-voice-catalog.js');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const waitFor = async checkReady => {
    const deadline = Date.now() + 3000;
    while (!checkReady() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    check(checkReady(), 'UI action timed out');
  };
  const fixture = document.createElement('section');
  fixture.style.cssText = 'position:fixed;inset:16px;background:var(--app-surface-card,#fff);overflow:auto;z-index:100000;';
  fixture.innerHTML = '<div data-board-host></div><div class="api-config-realtime-card"><div class="api-config-realtime-heading"></div></div>';
  document.body.append(fixture);
  const data = new Map(), keys = new Map(), uiErrors = [];
  const onError = event => uiErrors.push(event.error?.message || event.reason?.message || event.message);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
  let boardPanel, voicePanel;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  try {
    delete globalThis.structuredClone;
    check(typeof globalThis.structuredClone === 'undefined', 'Native API was not removed');
    const boardStore = createHopscotchBoardStore({ storage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) } });
    const runtime = createHopscotchTurnRuntime({ boardStore, getSettings: () => ({ creativeHopscotchEnabled: true }) });
    check(runtime.resolveExecutionPlan('rp:legacy-smoke').source === 'derived', 'Default send plan failed');
    const original = normalizeHopscotchBoard({ rows: [{ id: 'main', houses: [{ id: 'body', kind: 'body' }] }] });
    check((await boardStore.setGlobalBoard(original)).ok, 'Fixture board was rejected');
    const host = fixture.querySelector('[data-board-host]');
    boardPanel = createHopscotchBoardPanel({ boardStore, runtime, embedded: true, getSessionId: () => 'rp:legacy-smoke', getEnabled: () => true });
    boardPanel.mount(host);
    const action = name => {
      const button = host.querySelector(`[data-action="${name}"]`);
      check(button && !button.disabled, `Missing board action: ${name}`);
      button.click();
    };
    const detail = () => [...document.querySelectorAll('.hop-detail[open]')].at(-1);
    const readDraft = () => {
      action('transfer');
      const draft = JSON.parse(detail().querySelector('[name="boardJson"]').value);
      detail().querySelector('[data-action="close-detail"]').click();
      return draft;
    };
    const initial = readDraft();
    action('settings');
    detail().querySelector('[name="concurrency"]').value = initial.policy.rowConcurrencyMax === 1 ? '2' : '1';
    detail().querySelector('[data-action="apply-policy"]').click();
    check(readDraft().policy.rowConcurrencyMax !== initial.policy.rowConcurrencyMax, 'Policy edit failed');
    action('undo');
    check(JSON.stringify(readDraft()) === JSON.stringify(initial), 'Undo did not restore the draft');
    action('transfer');
    const imported = JSON.parse(detail().querySelector('[name="boardJson"]').value);
    imported.rows[0].houses[0].label = 'Legacy fixture';
    detail().querySelector('[name="boardJson"]').value = JSON.stringify(imported);
    detail().querySelector('[data-action="import"]').click();
    check(readDraft().rows[0].houses[0].label === 'Legacy fixture', 'Board import failed');
    action('undo');
    check(JSON.stringify(readDraft()) === JSON.stringify(initial), 'Import undo lost original data');
    check(boardStore.getGlobalBoard().rows[0].houses[0].label === original.rows[0].houses[0].label, 'Draft edited saved data');
    boardPanel.dispose(); boardPanel = null;

    const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
      keyring: { addKey: async (id, value) => { keys.set(id, value); return id; }, decryptKey: async id => keys.get(id), removeKey: async id => keys.delete(id) } });
    const profile = await store.save(makeRealtimeProfile('xai_voice'), { apiKey: 'LEGACY_FIXTURE_KEY' });
    const voices = getRealtimeSystemVoices(profile).slice(0, 2), snapshots = [];
    voicePanel = new RealtimeSettingsPanel({ card: fixture.querySelector('.api-config-realtime-card'), store,
      modelDiscovery: { list: async snapshot => { snapshots.push(snapshot); return { remote: true, models: [profile.model, 'legacy-fixture-model'] }; } },
      voiceDiscovery: { list: async snapshot => { snapshots.push(snapshot); return voices; } },
    });
    await voicePanel.ready;
    voicePanel.root.querySelector('#rt-refresh-models').click();
    await waitFor(() => !voicePanel.busy);
    check(voicePanel.root.querySelector('#rt-status').dataset.type !== 'error', 'Model refresh reported an error');
    check([...voicePanel.root.querySelectorAll('#rt-model-options button')].some(node => node.textContent === 'legacy-fixture-model'), 'Model list missing');
    voicePanel.root.querySelector('#rt-refresh-voices').click();
    await waitFor(() => !voicePanel.busy);
    check(voicePanel.root.querySelector('#rt-status').dataset.type !== 'error', 'Voice refresh reported an error');
    check(voicePanel.root.querySelectorAll('[data-rt-voice]').length === voices.length, 'Voice list missing');
    check(snapshots.length === 2 && snapshots.every(snapshot => snapshot !== voicePanel.draft), 'Discovery received live drafts');
    snapshots[0].name = 'changed snapshot';
    check(voicePanel.draft.name !== snapshots[0].name, 'Snapshot edit leaked into the draft');
    check(uiErrors.length === 0, `UI errors: ${uiErrors.join('; ')}`);
    check(typeof globalThis.structuredClone === 'undefined', 'Smoke silently restored native cloning');
    return { passed: true, missingNative: true, defaultSendPlan: true, boardEditImportUndo: true, realtimeModelAndVoiceRefresh: true, userSettingsWrites: 0, providerRequests: 0 };
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'structuredClone', descriptor);
    else delete globalThis.structuredClone;
    boardPanel?.dispose();
    voicePanel?.hide(); voicePanel?.voicePicker?.destroy();
    fixture.remove();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
  }
};

try {
  const result = await evaluateInApp(`(${smoke.toString()})()`);
  assert.equal(result.passed, true);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
