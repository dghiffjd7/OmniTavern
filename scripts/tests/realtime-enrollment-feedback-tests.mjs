import assert from 'node:assert/strict';
import { RealtimeSettingsPanel } from '../../src/scripts/ui/realtime/realtime-settings-panel.js';
import { RealtimeProfileStore } from '../../src/scripts/storage/realtime-profile-store.js';
import { makeRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { RealtimeVoiceEnrollment } from '../../src/scripts/ui/realtime/realtime-voice-enrollment.js';
import { validateRealtimeReferenceFiles } from '../../src/scripts/ui/realtime/realtime-enrollment-view.js';
let count = 0;
const test = async (name, run) => { await run(); console.log(`ok - ${name}`); count++; };
const createStore = () => {
  const keys = new Map();
  return new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
    keyring: { addKey: async (id, value) => { keys.set(id, value); return id; }, decryptKey: async id => keys.get(id), removeKey: async id => keys.delete(id) } });
};
const fixture = async () => {
  const store = createStore();
  const saved = await store.save(makeRealtimeProfile('step_realtime'), { apiKey: 'TEST_KEY' });
  const panel = Object.assign(Object.create(RealtimeSettingsPanel.prototype), { store, draft: { ...saved, voiceKind: 'custom', voice: '', idleTimeoutMinutes: '10' }, dirty: true, secretDraft: {}, capture: () => {}, render: () => {} });
  return { store, saved, panel };
};

await test('an empty custom voice draft can create its first voice while unsaved connection edits remain blocked', async () => {
  const { panel, saved } = await fixture();
  assert.throws(() => panel.requireSaved(), /请先保存/);
  assert.deepEqual(panel.requireSaved({ allowVoiceDraft: true }), saved);
  for (const [field, value] of Object.entries({ region: 'global', model: 'stepaudio-future-realtime', name: 'new name', idleTimeoutMinutes: 12, credentialId: 'other' })) {
    const original = panel.draft[field]; panel.draft[field] = value;
    assert.throws(() => panel.requireSaved({ allowVoiceDraft: true }), /请先保存/, field); panel.draft[field] = original;
  }
  panel.secretDraft.apiKey = 'NEW_KEY'; assert.throws(() => panel.requireSaved({ allowVoiceDraft: true }), /请先保存/);
  panel.secretDraft = {}; panel.draft.id = ''; assert.throws(() => panel.requireSaved({ allowVoiceDraft: true }), /请先保存/);
});

await test('registering the first clone preserves the voice draft and only applies it when explicitly saved', async () => {
  const { panel, saved, store } = await fixture();
  await panel.registerVoice({ voiceId: 'Clone_CASE', status: 'ready', label: 'My clone' });
  assert.equal(store.get(saved.id).customVoices[0].region, saved.region);
  assert.equal(store.get(saved.id).voice, saved.voice);
  assert.equal(panel.draft.voiceKind, 'custom'); assert.equal(panel.draft.voice, 'Clone_CASE'); assert(panel.dirty);
  assert.equal(store.activeId, saved.id);
  await store.save(panel.draft);
  assert.equal((await store.resolve()).settings.voice, 'Clone_CASE');
  const second = await fixture(); second.panel.draft.voice = 'Keep_My_Selection';
  await second.panel.registerVoice({ voiceId: 'Another_CASE', status: 'ready' });
  assert.equal(second.panel.draft.voice, 'Keep_My_Selection');
});

await test('Step reports upload and creation separately and surfaces safe provider error details', async () => {
  const phases = [], requests = [], file = { name: 'sample.mp3', size: 4, arrayBuffer: async () => new Uint8Array(4).buffer };
  const enrollment = new RealtimeVoiceEnrollment({ invoke: async (name, args) => {
    requests.push(args.url); return { status: 200, body: JSON.stringify({ id: requests.length === 1 ? 'file-test' : 'Clone_CASE' }) };
  } });
  await enrollment.create(makeRealtimeProfile('step_realtime'), { apiKey: 'TEST_KEY' }, { file, onProgress: phase => phases.push(phase) });
  assert.deepEqual(phases, ['uploading', 'creating']);
  for (const [status, body, expected] of [
    [400, JSON.stringify({ error: { message: 'Audio must be 5–10 seconds; TEST_KEY' } }), /5–10 seconds/],
    [402, JSON.stringify({ error: { message: 'Insufficient balance' } }), /余额不足/],
    [401, '<html>Unauthorized</html>', /鉴权失败/],
    [200, JSON.stringify({ code: 'InvalidParameter', message: 'Invalid sample audio' }), /Invalid sample audio/],
  ]) {
    const failing = new RealtimeVoiceEnrollment({ invoke: async () => ({ status, body }) });
    await assert.rejects(failing.create(makeRealtimeProfile('step_realtime'), { apiKey: 'TEST_KEY' }, { file }), error => error.message.includes(String(status)) && expected.test(error.message) && !error.message.includes('TEST_KEY'));
  }
});
await test('reference upload accepts one WAV/MP3 and rejects multi-file, empty, unsupported and oversized input', () => {
  const valid = { name: 'Reference.WAV', size: 10 * 1024 * 1024 };
  assert.equal(validateRealtimeReferenceFiles([valid]), valid);
  assert.throws(() => validateRealtimeReferenceFiles([valid, valid]), /1 个音档/);
  for (const file of [{ name: 'sample.mp3', size: 0 }, { name: 'sample.wav', size: valid.size + 1 }]) assert.throws(() => validateRealtimeReferenceFiles([file]), /10 MB/);
  assert.throws(() => validateRealtimeReferenceFiles([{ name: 'sample.png', size: 200 }]), /WAV 或 MP3/);
});
console.log(`Realtime enrollment feedback tests passed (${count})`);
