import assert from 'node:assert/strict';
import { makeRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { getRealtimeSystemVoices, getRealtimeVoiceOptions, realtimeVoiceMatches } from '../../src/scripts/ui/realtime/realtime-voice-catalog.js';
import { filterRealtimeVoices } from '../../src/scripts/ui/realtime/realtime-voice-picker.js';
import { RealtimeVoiceDiscovery, parseXaiRealtimeVoices } from '../../src/scripts/ui/realtime/realtime-voice-discovery.js';
let count = 0;
const test = async (name, run) => { await run(); console.log(`ok - ${name}`); count++; };
await test('system catalogs cover documented default voices and preserve model boundaries', () => {
  for (const [provider, count] of Object.entries({ openai: 10, gemini_live: 30, doubao_realtime: 7, qwen_audio_realtime: 5, step_realtime: 34, xai_voice: 28, nova_sonic: 16 })) {
    const profile = makeRealtimeProfile(provider), voices = getRealtimeSystemVoices(profile);
    assert.equal(voices.length, count, provider); assert.equal(new Set(voices.map(voice => voice.id)).size, count);
    assert.equal(voices[0].id, profile.voice);
  }
  const doubao = makeRealtimeProfile('doubao_realtime');
  assert.equal(getRealtimeSystemVoices({ ...doubao, model: '2.2.0.0' }).length, 21);
  assert(getRealtimeSystemVoices({ ...doubao, model: '2.2.0.0' }).every(voice => voice.id.startsWith('saturn_')));
  assert.equal(getRealtimeSystemVoices({ ...doubao, model: '1.1.0.0' }).length, 4);
  const step = makeRealtimeProfile('step_realtime');
  assert.equal(getRealtimeSystemVoices({ ...step, model: 'step-audio-2-mini' }).length, 2);
  assert.equal(getRealtimeSystemVoices({ ...step, model: 'step-audio-2' }).length, 4);
});
await test('search matches translated traits and exact gender, without mutating catalog or selected voice', () => {
  const profile = makeRealtimeProfile('gemini_live'), voices = getRealtimeSystemVoices(profile), snapshot = JSON.stringify(voices);
  assert.deepEqual(filterRealtimeVoices(voices, '女声 坚定').map(voice => voice.id), ['Kore']);
  assert.deepEqual(filterRealtimeVoices(voices, 'female bright', text => ({ 明亮: 'Bright' })[text] || text).map(voice => voice.id), ['Zephyr', 'Autonoe']);
  assert(filterRealtimeVoices(voices, 'male').every(voice => voice.gender === 'male'));
  assert.equal(filterRealtimeVoices(voices, 'unknown-voice').length, 0);
  assert.equal(JSON.stringify(voices), snapshot); assert.equal(profile.voice, 'Kore');
  assert.equal(getRealtimeSystemVoices(makeRealtimeProfile('openai'))[0].gender, '');
});
await test('saved custom voices remain isolated and only known xAI builtins match old casing', () => {
  const profile = { ...makeRealtimeProfile('qwen_audio_realtime'), voiceKind: 'custom', customVoices: [{ voiceId: 'MyCase', label: 'My voice', status: 'training' }], voice: 'MyCase' };
  assert.deepEqual(getRealtimeVoiceOptions(profile).map(voice => voice.id), ['MyCase']);
  assert.equal(getRealtimeVoiceOptions(profile)[0].description, '训练中');
  assert(!realtimeVoiceMatches(profile, 'MyCase', 'mycase'));
  assert(realtimeVoiceMatches({ provider: 'xai_voice' }, 'ara', 'Ara'));
  assert(!realtimeVoiceMatches({ provider: 'xai_voice' }, 'Custom_X', 'custom_x'));
});
await test('xAI refresh parses official voice IDs and enriches known voices without guessing new genders', async () => {
  const calls = [], profile = makeRealtimeProfile('xai_voice');
  const discovery = new RealtimeVoiceDiscovery({ invoke: async (name, args) => {
    calls.push([name, args]); return { status: 200, body: JSON.stringify({ voices: [{ voice_id: 'ara', name: 'Ara' }, { voice_id: 'future', name: '<future>', language: 'en' }, { voice_id: 'ara' }, null] }) };
  } });
  const voices = await discovery.list(profile, { apiKey: 'SECRET' });
  assert.equal(calls[0][0], 'http_request'); assert.equal(calls[0][1].url, 'https://api.x.ai/v1/tts/voices');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer SECRET'); assert(calls[0][1].requestId);
  assert.equal(voices.length, 2); assert.equal(voices[0].gender, 'female'); assert.equal(voices[1].gender, '');
  assert.equal(profile.voice, 'ara');
  assert.throws(() => parseXaiRealtimeVoices({ voices: [] }), /音色/);
  assert.throws(() => parseXaiRealtimeVoices({ voices: [{ voice_id: '<script>' }] }), /音色/);
  const failed = new RealtimeVoiceDiscovery({ invoke: async () => ({ status: 401, body: 'PRIVATE_KEY' }) });
  await assert.rejects(failed.list(profile, { apiKey: 'SECRET' }), error => error.message.includes('401') && !error.message.includes('PRIVATE_KEY'));
});
await test('cancelling voice refresh aborts its native request and stops waiting', async () => {
  const calls = [], controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const discovery = new RealtimeVoiceDiscovery({ invoke: async (name, args) => { calls.push([name,args]); if (name === 'http_request') { started(); return new Promise(() => {}); } } });
  const rejected = assert.rejects(discovery.list(makeRealtimeProfile('xai_voice'), { apiKey: 'SECRET' }, { signal: controller.signal }), error => error.name === 'AbortError');
  await ready; controller.abort(); await rejected;
  assert.equal(calls[1][0], 'http_abort_request'); assert.equal(calls[0][1].requestId, calls[1][1].requestId);
});
console.log(`Realtime voice picker tests passed (${count})`);
