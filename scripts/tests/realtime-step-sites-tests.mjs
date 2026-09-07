import assert from 'node:assert/strict';
import { makeRealtimeProfile, validateRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { getRealtimeSystemVoices } from '../../src/scripts/ui/realtime/realtime-voice-catalog.js';
import { RealtimeProfileStore, REALTIME_PROFILE_STORE_KEY } from '../../src/scripts/storage/realtime-profile-store.js';
import { RealtimeModelDiscovery, realtimeModelSource } from '../../src/scripts/ui/realtime/realtime-model-discovery.js';
import { RealtimeVoiceEnrollment } from '../../src/scripts/ui/realtime/realtime-voice-enrollment.js';
import { NativeRealtimeSessionClient } from '../../src/scripts/ui/realtime/native-realtime-session-client.js';
let count = 0;
const test = async (name, run) => { await run(); console.log(`ok - ${name}`); count++; };
const mainland = () => makeRealtimeProfile('step_realtime');
const international = () => ({ ...mainland(), region: 'global', voice: 'soft-spoken-gentleman' });
const credentials = { apiKey: 'TEST_KEY' };
const response = data => ({ status: 200, body: JSON.stringify(data) });

await test('Step voices follow site boundaries and reject obsolete character voice bindings', () => {
  assert.equal(mainland().region, 'cn');
  assert.equal(getRealtimeSystemVoices(mainland()).length, 34);
  const voices = getRealtimeSystemVoices(international());
  assert.deepEqual(voices.map(voice => voice.id), ['soft-spoken-gentleman', 'magnetic-voiced-male', 'vibrant-youth', 'lively-girl', 'livelybreezy-female', 'elegantgentle-female', 'zixinnansheng']);
  validateRealtimeProfile(international());
  assert.throws(() => validateRealtimeProfile({ ...international(), voice: 'qingchunshaonv' }), /站点/);
  validateRealtimeProfile({ ...international(), voice: 'future-manually-entered-voice' });
  assert.throws(() => validateRealtimeProfile({ ...international(), region: 'invalid' }), /区域/);
});

await test('model refresh uses only the selected Step site and keeps model/account sources isolated', async () => {
  const calls = [];
  const discovery = new RealtimeModelDiscovery({ invoke: async (name, args) => {
    calls.push(args); assert.equal(name, 'http_request'); assert.equal(args.headers.Authorization, 'Bearer TEST_KEY');
    return response({ data: [{ id: 'stepaudio-2.5-realtime' }, { id: 'stepaudio-2.5-tts' }, { id: 'stepaudio-2.5-chat' }] });
  } });
  for (const [profile, host] of [[mainland(), 'api.stepfun.com'], [international(), 'api.stepfun.ai']]) {
    const result = await discovery.list(profile, credentials);
    assert.deepEqual(result.models, ['stepaudio-2.5-realtime']); assert(result.remote);
    assert.equal(calls.at(-1).url, `https://${host}/v1/models`);
    assert(!calls.at(-1).url.includes('TEST_KEY'));
  }
  assert.notEqual(realtimeModelSource(mainland()), realtimeModelSource(international()));
  await assert.rejects(discovery.list({ ...international(), region: 'global.evil.test' }, credentials), /站点/);
  assert.equal(calls.length, 2);
  let failedCalls = 0;
  await assert.rejects(new RealtimeModelDiscovery({ invoke: async () => { failedCalls++; return { status: 401, body: 'PRIVATE_KEY_DETAIL' }; } }).list(international(), credentials), error => error.message.includes('401') && !error.message.includes('PRIVATE'));
  assert.equal(failedCalls, 1, 'No credential retry on another site');
});

await test('Step upload and clone stay on one site and stop after a failed upload', async () => {
  const file = { name: 'sample.wav', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  for (const [profile, host] of [[mainland(), 'api.stepfun.com'], [international(), 'api.stepfun.ai']]) {
    const requests = [];
    const enrollment = new RealtimeVoiceEnrollment({ invoke: async (name, args) => {
      requests.push(args); assert.equal(args.headers.Authorization, 'Bearer TEST_KEY');
      return response({ id: requests.length === 1 ? 'file-test' : 'Voice_CASE' });
    } });
    assert.deepEqual(await enrollment.create(profile, credentials, { file, text: 'Test sample.' }), { voiceId: 'Voice_CASE', status: 'ready' });
    assert.deepEqual(requests.map(request => request.url), [`https://${host}/v1/files`, `https://${host}/v1/audio/voices`]);
    assert.match(Buffer.from(requests[0].bodyBase64, 'base64').toString(), /storage/);
    assert.deepEqual(JSON.parse(requests[1].body), { model: 'stepaudio-2.5-tts', file_id: 'file-test', text: 'Test sample.' });
  }
  let requests = 0;
  const failed = new RealtimeVoiceEnrollment({ invoke: async () => { requests++; return { status: 401, body: '{}' }; } });
  await assert.rejects(failed.create(international(), credentials, { file }), /401/);
  assert.equal(requests, 1);
});

await test('legacy Step profiles and clones migrate as mainland without transferring clones to international', async () => {
  const legacy = { ...mainland(), id: 'legacy', region: '', credentialId: 'key-old', voiceKind: 'custom', voice: 'Voice_CASE', customVoices: [{ voiceId: 'Voice_CASE', label: 'My voice', status: 'ready', region: '', workspaceId: '', credentialId: 'key-old', targetModel: mainland().model }] };
  const snapshot = { version: 1, profiles: [legacy], activeProfileId: 'legacy' };
  for (const source of ['local', 'native']) {
    const persisted = [];
    const store = new RealtimeProfileStore({ storage: { getItem: key => key === REALTIME_PROFILE_STORE_KEY && source === 'local' ? JSON.stringify(snapshot) : null, setItem: () => {} },
      keyring: { decryptKey: async () => JSON.stringify(credentials) },
      invoke: async (name, args) => { if (name === 'load_kv') return source === 'native' ? snapshot : null; if (name === 'save_kv') persisted.push(args.data); } });
    await store.ready;
    const profile = store.get('legacy');
    assert.equal(profile.region, 'cn'); assert.equal(profile.customVoices[0].region, 'cn');
    assert.equal((await store.resolve()).settings.voice, 'Voice_CASE');
    const target = { supported: true, scopeId: 'test', uiMode: 'rp', sessionId: 'rp:test' };
    await store.bindTarget(target, profile.id);
    assert.equal((await store.resolveBinding(target)).config.region, 'cn');
    await assert.rejects(store.save({ ...profile, region: 'global' }), /其他账号、区域/);
    await store.save({ ...profile, region: 'global', voiceKind: 'system', voice: international().voice }, null, { activate: false });
    assert.equal(store.get('legacy').customVoices[0].region, 'cn');
    assert.equal((await store.resolve()).config.region, 'global');
    await assert.rejects(store.resolveBinding(target), /其他账号、区域/);
    await store.bindTarget(target, profile.id);
    assert.equal((await store.resolveBinding(target)).settings.voice, international().voice);
    assert(!JSON.stringify(persisted).includes('TEST_KEY'));
  }
});
await test('native Step failures distinguish wrong site credentials from insufficient balance and close the connection', async () => {
  for (const [status, message] of [[401, /站点一致/], [402, /余额不足/], [403, /^Realtime handshake HTTP 403$/]]) {
    let callback, closed = 0; const errors = [];
    const client = new NativeRealtimeSessionClient({ createChannel: handler => { callback = handler; return { id: 1 }; },
      createAudio: () => ({ open: async () => {}, close: async () => {}, clear: () => {} }),
      onEvent: event => { if (event.type === 'error') errors.push(event.error.message); },
      invoke: async (name, args) => {
        if (name === 'realtime_transport_open') { assert.equal(args.connection.region, 'global'); callback({ kind: 'error', data: `Realtime handshake HTTP ${status}` }); }
        if (name === 'realtime_transport_close') closed++;
      } });
    await assert.rejects(client.connect({ config: { ...international(), credentials }, sessionConfig: { instructions: 'Test' } }), error => message.test(error.message));
    assert.match(errors[0], message); assert.equal(closed, 1); assert(client.closed);
  }
});
console.log(`Realtime Step sites tests passed (${count})`);
