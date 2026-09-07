import assert from 'node:assert/strict';
import { makeRealtimeProfile, REALTIME_PROVIDERS, validateRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { RealtimeProfileStore } from '../../src/scripts/storage/realtime-profile-store.js';
import { Pcm16Framer, decodePcm16, bytesToBase64, base64ToBytes } from '../../src/scripts/ui/realtime/realtime-pcm-codec.js';
import { buildJsonRealtimeSession, createJsonRealtimeProtocol } from '../../src/scripts/ui/realtime/realtime-json-protocol.js';
import { buildGeminiLiveSetup, createGeminiLiveProtocol } from '../../src/scripts/ui/realtime/realtime-gemini-protocol.js';
import { encodeDoubaoFrame, decodeDoubaoFrame, buildDoubaoSession } from '../../src/scripts/ui/realtime/realtime-doubao-protocol.js';
import { buildNovaStartEvents, createNovaSonicProtocol } from '../../src/scripts/ui/realtime/realtime-nova-protocol.js';
import { buildQwenVoiceEnrollment, buildDoubaoVoiceEnrollment, buildStepVoiceMultipart } from '../../src/scripts/ui/realtime/realtime-voice-enrollment.js';
import { createRealtimeCallRuntime } from '../../src/scripts/ui/realtime/realtime-call-runtime.js';
import { NativeRealtimeSessionClient } from '../../src/scripts/ui/realtime/native-realtime-session-client.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let count = 0;
const test = async (name, body) => { await body(); console.log(`ok - ${name}`); count++; };
await test('all seven providers have independent model and voice defaults', () => {
  assert.equal(Object.keys(REALTIME_PROVIDERS).length, 7);
  for (const id of Object.keys(REALTIME_PROVIDERS)) validateRealtimeProfile(makeRealtimeProfile(id));
  assert.equal(makeRealtimeProfile('gemini_live').voice, 'Kore');
});
await test('profiles keep typed credentials outside metadata and roll back failed saves', async () => {
  const keys = new Map(); let sequence = 0, fail = false; const persisted = [];
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, keyring: {
    addKey: async (id, value) => { const key = `key${++sequence}`; keys.set(key, value); return key; }, decryptKey: async (id, key) => keys.get(key), removeKey: async (id, key) => keys.delete(key),
  }, invoke: async (cmd, args) => { if (cmd === 'save_kv') { if (fail) throw Error('disk full'); persisted.push(args.data); } return null; } });
  let profile = await store.save(makeRealtimeProfile('qwen_audio_realtime'), { apiKey: 'SECRET' });
  assert.equal((await store.resolve()).config.credentials.apiKey, 'SECRET');
  assert(!JSON.stringify(persisted).includes('SECRET'));
  profile.customVoices.push({ voiceId: 'Voice_CaseSensitive', label: 'mine', targetModel: profile.model, region: profile.region, workspaceId: profile.workspaceId, credentialId: profile.credentialId, status: 'ready' });
  profile.voiceKind = 'custom'; profile.voice = 'Voice_CaseSensitive'; profile = await store.save(profile);
  assert.equal((await store.resolve()).settings.voice, 'Voice_CaseSensitive');
  assert.throws(() => validateRealtimeProfile({ ...profile, model: 'qwen-audio-3.0-realtime-flash' }), /目标模型/);
  await assert.rejects(store.save(profile, { apiKey: 'OTHER_ACCOUNT' }), /其他账号/);
  assert.equal(keys.size, 1); assert.equal((await store.resolve()).config.credentials.apiKey, 'SECRET');
  fail = true; await assert.rejects(store.save({ ...profile, name: 'changed' }), /disk full/); assert.notEqual(store.get(profile.id).name, 'changed');
  fail = false; const duplicate = await store.duplicate(profile.id);
  assert.notEqual(duplicate.id, profile.id); assert.notEqual(duplicate.credentialId, profile.credentialId);
  assert.equal(duplicate.customVoices[0].credentialId, duplicate.credentialId); assert.equal(store.activeId, profile.id);
  const target = { supported: true, scopeId: 'scope-a', uiMode: 'rp', sessionId: 'rp:character' };
  await store.bindTarget(target, duplicate.id); await store.activate(''); assert.equal(await store.resolve(), null);
  assert.equal((await store.resolveBinding(target)).settings.voice, 'Voice_CaseSensitive');
  assert.equal(await store.resolveBinding({ ...target, scopeId: 'scope-b' }), null);
  await store.remove(duplicate.id); await assert.rejects(store.resolveBinding(target), /重新绑定/);
  await store.bindTarget(target); assert.equal(await store.resolveBinding(target), null);
});
await test('fractional resampling retains phase across chunks and encodes signed LE PCM', () => {
  const samples = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 20) * .8);
  const run = chunk => { const output = []; const framer = new Pcm16Framer(44100, 16000); for (let i = 0; i < samples.length; i += chunk) framer.push(samples.subarray(i, i + chunk), bytes => output.push(...bytes)); return output; };
  const a = run(128), b = run(733); assert.equal(a.length, 32000); assert.deepEqual(a, b);
  assert.deepEqual([...decodePcm16(new Uint8Array([0,128,255,127]))], [-1,32767/32768]);
  assert.deepEqual(base64ToBytes(bytesToBase64(new Uint8Array(a))), new Uint8Array(a));
});
await test('Qwen, Step and xAI sessions use their documented VAD and audio schemas', () => {
  const q = buildJsonRealtimeSession(makeRealtimeProfile('qwen_audio_realtime'), 'role');
  const s = buildJsonRealtimeSession(makeRealtimeProfile('step_realtime'), 'role');
  const x = buildJsonRealtimeSession(makeRealtimeProfile('xai_voice'), 'role');
  assert.equal(q.input_audio_format, 'pcm'); assert.equal(s.input_audio_format, 'pcm16'); assert.equal(s.turn_detection.energy_awakeness_threshold, 2500);
  assert.equal(x.audio.input.format.rate, 24000); assert.equal(x.audio.input.transcription.model, 'grok-transcribe');
  assert(!JSON.stringify([q,s,x]).includes('create_response'));
});
await test('JSON adapters normalize transcript names and cancel queued playback', () => {
  const events = [], sent = [], played = []; let cleared = 0;
  const p = createJsonRealtimeProtocol({ profile: makeRealtimeProfile('step_realtime'), instructions: 'role', send: e => sent.push(e), emit: e => events.push(e), ready: () => {}, play: d => played.push(d), clear: () => cleared++ });
  p.start(); p.receive({ type: 'response.created', response: { id: 'r' } }); p.receive({ type: 'response.audio_transcript.delta', response_id: 'r', delta: 'hello' });
  p.cancel(); p.receive({ type: 'response.audio.delta', response_id: 'r', delta: 'AAAA' });
  assert.equal(events[1].type, 'response.output_audio_transcript.delta'); assert.equal(cleared, 1); assert.equal(played.length, 0); assert.equal(sent.at(-1).type, 'response.cancel');
});
await test('Gemini preserves voice case, coalesces input, and emits user before response completion', () => {
  const profile = makeRealtimeProfile('gemini_live'); assert.equal(buildGeminiLiveSetup(profile, 'role').setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  const events = [];
  const p = createGeminiLiveProtocol({ profile, instructions: 'role', send: () => {}, emit: e => events.push(e), ready: () => {}, play: () => {}, clear: () => {}, renew: () => {} });
  p.receive({ serverContent: { inputTranscription: { text: '你' } } }); p.receive({ serverContent: { inputTranscription: { text: '好' }, outputTranscription: { text: '你好！' }, turnComplete: true } });
  const userIndex = events.findIndex(e => e.type === 'conversation.item.input_audio_transcription.completed');
  assert.equal(events[userIndex].transcript, '你好'); assert(userIndex < events.findIndex(e => e.type === 'response.done'));
  assert.throws(() => p.receive(new Uint8Array([0xff])), /无效的消息格式/);
  assert.throws(() => p.receive(new TextEncoder().encode('{broken')), /无效的消息格式/);
});
await test('Doubao binary frames match official bytes and reject truncated frames', async () => {
  assert.deepEqual([...encodeDoubaoFrame(1, {})], [17,20,16,0,0,0,0,1,0,0,0,2,123,125]);
  const encoded = encodeDoubaoFrame(100, { dialog: { character_manifest: '中文' } }, 'session');
  const decoded = await decodeDoubaoFrame(encoded); assert.equal(decoded.sessionId, 'session'); assert.equal(decoded.data.dialog.character_manifest, '中文');
  await assert.rejects(decodeDoubaoFrame(encoded.subarray(0, encoded.length - 1)), /Truncated/);
  const session = buildDoubaoSession({ ...makeRealtimeProfile('doubao_realtime'), model: '2.2.0.0' }, 'role');
  assert.equal(session.dialog.extra.model, '2.2.0.0'); assert.equal(session.dialog.character_manifest, 'role'); assert(!session.dialog.system_role); assert.equal(session.tts.audio_config.format, 'pcm_s16le');
});
await test('Nova transmits history before audio and persists FINAL transcript only', () => {
  const profile = makeRealtimeProfile('nova_sonic'), start = buildNovaStartEvents(profile, 'role', { promptName: 'p', audioName: 'a', history: [{ role: 'user', text: 'history' }] });
  assert.equal(start.at(-1).event.contentStart.type, 'AUDIO'); assert(start.some(e => e.event.textInput?.content === 'history'));
  const events = []; const p = createNovaSonicProtocol({ profile, instructions: 'role', send: () => {}, emit: e => events.push(e), ready: () => {}, play: () => {}, clear: () => {} });
  p.receive({ event: { completionStart: { completionId: 'r' } } });
  for (const [id, stage, text] of [['s','SPECULATIVE','unspoken'], ['f','FINAL','spoken']]) {
    p.receive({ event: { contentStart: { contentId: id, completionId: 'r', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: JSON.stringify({ generationStage: stage }) } } });
    p.receive({ event: { textOutput: { contentId: id, content: text } } });
    p.receive({ event: { contentEnd: { contentId: id } } });
  }
  p.receive({ event: { usageEvent: { totalInputTokens: 10, totalOutputTokens: 3 } } }); p.receive({ event: { usageEvent: { totalInputTokens: 12, totalOutputTokens: 4 } } });
  assert.deepEqual(events.filter(e => e.type.endsWith('transcript.delta')).map(e => e.delta), ['spoken']);
  assert.deepEqual(events.filter(e => e.type === 'usage.delta').map(e => e.usage.input_tokens), [10,2]);
});
await test('voice enrollment uses product-specific Qwen target and Doubao clone generation', () => {
  const q = buildQwenVoiceEnrollment(makeRealtimeProfile('qwen_audio_realtime'), { url: 'https://example.com/a.wav', prefix: 'myvoice' });
  assert.equal(q.body.model, 'voice-enrollment'); assert.equal(q.body.input.action, 'create_voice'); assert(q.body.input.target_model.includes('realtime'));
  assert.throws(() => buildQwenVoiceEnrollment({ ...makeRealtimeProfile('qwen_audio_realtime'), region: 'ap-southeast-1' }, {}), /北京/);
  const d = buildDoubaoVoiceEnrollment(makeRealtimeProfile('doubao_realtime'), { apiKey: 'key', appId: '123' }, { voiceId: 'S_Test', audioBytes: 'AA==', audioFormat: 'wav' });
  assert.equal(d.headers.Authorization, 'Bearer; key'); assert.equal(d.body.model_type, 4); assert.equal(d.headers['Resource-Id'], 'seed-icl-2.0');
  const s = buildStepVoiceMultipart(new Uint8Array([0,255]), 'wav'); assert(new TextDecoder().decode(base64ToBytes(s.bodyBase64)).includes('storage\r\n'));
});
await test('natural sessions avoid extra response.create and preserve late Step ASR ordering', async () => {
  let callbacks; const saved = [], sent = [], snapshots = [];
  const profile = makeRealtimeProfile('step_realtime');
  const runtime = createRealtimeCallRuntime({ getCallTarget: () => ({ supported: true, sessionId: 's' }), resolveConnection: async () => ({ config: profile, settings: { ...profile, realtimeModel: profile.model, contextMode: 'session_snapshot' } }),
    buildSemanticSnapshot: async value => { snapshots.push(value); return { instructions: 'role' }; }, createSessionClient: options => { callbacks = options; return { connect: async () => {}, close: async () => {}, sendEvent: e => sent.push(e) }; },
    commitUserMessage: async value => { saved.push(['user', value.text]); return { id: 'u' }; }, commitAssistantMessage: async value => { saved.push(['assistant', value.text]); return { id: 'a' }; }, setIntervalFn: () => null });
  assert(await runtime.start());
  assert.equal(runtime.getState().provider, 'step_realtime');
  const emit = callbacks.onEvent;
  emit({ type: 'input_audio_buffer.speech_started', item_id: 'u' }); emit({ type: 'response.created', response: { id: 'r' } }); emit({ type: 'response.output_audio_transcript.done', response_id: 'r', transcript: 'reply' }); emit({ type: 'response.done', response: { id: 'r' } }); await runtime.whenIdle(); assert.equal(saved.length, 0);
  emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'question' }); await runtime.whenIdle();
  assert.deepEqual(saved, [['user','question'], ['assistant','reply']]); assert.equal(snapshots.length, 1); assert.equal(sent.length, 0);
  await runtime.end(); emit({ type: 'response.created', response: { id: 'late' } }); assert.equal(runtime.getState().status, 'idle');
});
await test('native client drains setup, stops audio, closes transport and ignores late events', async () => {
  let callback; const commands = [], events = []; let audioClosed = 0;
  const profile = { ...makeRealtimeProfile('qwen_audio_realtime'), credentials: { apiKey: 'secret' } };
  const client = new NativeRealtimeSessionClient({ onEvent: e => events.push(e), createChannel: fn => { callback = fn; return { id: 123 }; },
    createAudio: () => ({ open: async () => {}, close: async () => { audioClosed++; }, clear: () => {}, play: () => {} }),
    invoke: async (command, args) => { commands.push([command,args]); if (command === 'realtime_transport_open') callback({ kind: 'open' }); if (command === 'realtime_transport_send' && args.messages.some(e => e.data.includes('session.update'))) callback({ kind: 'text', data: JSON.stringify({ type: 'session.updated' }) }); },
  });
  await client.connect({ config: profile, sessionConfig: { instructions: 'role' } });
  await client.close(); const length = events.length; callback({ kind: 'text', data: JSON.stringify({ type: 'response.created', response: { id: 'late' } }) }); await tick();
  assert.equal(events.length, length); assert.equal(audioClosed, 1); assert(commands.some(([cmd]) => cmd === 'realtime_transport_close')); assert.equal(client.id, '');
});
await test('cancelling a pending native open also closes a connection that opens late', async () => {
  let releaseOpen; const opened = new Promise(resolve => { releaseOpen = resolve; }); let active = false, closes = 0;
  const controller = new AbortController();
  const client = new NativeRealtimeSessionClient({ createChannel: () => ({ id: 1 }), createAudio: () => ({ open: async () => {}, close: async () => {} }),
    invoke: async command => { if (command === 'realtime_transport_open') { await opened; active = true; } if (command === 'realtime_transport_close') { active = false; closes++; } },
  });
  const connected = client.connect({ config: makeRealtimeProfile('qwen_audio_realtime'), sessionConfig: { instructions: 'role' }, signal: controller.signal });
  const rejected = assert.rejects(connected, error => error.name === 'AbortError');
  await tick(); controller.abort(); await tick(); releaseOpen(); await rejected;
  assert.equal(active, false); assert(closes >= 1);
});
await test('Gemini binary JSON completes native setup and retains UTF-8 transcripts for Developer and Vertex', async () => {
  for (const backend of ['developer', 'vertex']) for (const kind of ['text', 'binary']) {
    let callback; const events = [], controller = new AbortController();
    const frame = value => ({ kind, data: kind === 'binary' ? bytesToBase64(new TextEncoder().encode(JSON.stringify(value))) : JSON.stringify(value) });
    const profile = { ...makeRealtimeProfile('gemini_live'), geminiBackend: backend, vertexaiAuthMode: 'express', credentials: { apiKey: 'test', vertexaiApiKey: 'test' } };
    if (backend === 'vertex') profile.model = 'gemini-live-2.5-flash-native-audio';
    validateRealtimeProfile(profile);
    const client = new NativeRealtimeSessionClient({ onEvent: event => events.push(event), createChannel: fn => { callback = fn; return { id: 1 }; },
      createAudio: () => ({ open: async () => {}, close: async () => {}, clear: () => {} }),
      invoke: async (name, args) => {
        if (name === 'realtime_transport_open') callback({ kind: 'open' });
        if (name === 'realtime_transport_send' && args.messages.some(message => JSON.parse(message.data).setup)) callback(frame({ setupComplete: {} }));
      },
    });
    // Fail promptly when setupComplete is silently ignored, rather than waiting for the production 30s timeout.
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      await client.connect({ config: profile, sessionConfig: { instructions: 'role' }, signal: controller.signal });
      assert(client.streaming, `${backend}/${kind} did not become ready`);
      callback(frame({ serverContent: { inputTranscription: { text: '你好，测试🙂' }, turnComplete: true } })); await tick();
      assert.equal(events.find(event => event.type === 'conversation.item.input_audio_transcription.completed')?.transcript, '你好，测试🙂');
    } finally { clearTimeout(timer); await client.close(); }
  }
});
await test('Nova renewal replays final conversation history through a fresh native stream', async () => {
  const commands = []; let callback;
  const client = new NativeRealtimeSessionClient({ createChannel: fn => { callback = fn; return { id: Math.random() }; }, createAudio: () => ({ open: async () => {}, close: async () => {}, clear: () => {} }),
    invoke: async (command, args) => { commands.push([command,args]); if (command === 'realtime_transport_open') { callback({ kind: 'open' }); callback({ kind: 'ready' }); } },
  });
  await client.connect({ config: makeRealtimeProfile('nova_sonic'), sessionConfig: { instructions: 'role' } });
  client.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'remember this' });
  client.emit({ type: 'response.created', response: { id: 'first' } }); client.emit({ type: 'response.output_audio_transcript.delta', delta: 'remembered' }); client.emit({ type: 'response.done' });
  await client.renew(); await client.flush();
  assert.equal(commands.filter(([name]) => name === 'realtime_transport_open').length, 2);
  const frames = commands.filter(([name]) => name === 'realtime_transport_send').flatMap(([,args]) => args.messages).map(frame => JSON.parse(frame.data));
  assert(frames.some(frame => frame.event.textInput?.content === 'remember this'));
  assert(frames.some(frame => frame.event.textInput?.content === 'remembered'));
  await client.close();
});
await test('provider completion waits for playback and interruption cancels remaining queued speech', async () => {
  let callback; const events = [], sent = [];
  const audio = { open: async () => {}, close: async () => {}, context: { currentTime: 0 }, nextTime: 1, clear: () => { audio.nextTime = 0; } };
  const client = new NativeRealtimeSessionClient({ onEvent: e => events.push(e), createChannel: fn => { callback = fn; return { id: 1 }; }, createAudio: () => audio,
    invoke: async (command, args) => {
      if (command === 'realtime_transport_open') callback({ kind: 'open' });
      if (command === 'realtime_transport_send') { sent.push(...args.messages); if (args.messages.some(e => e.data.includes('session.update'))) callback({ kind: 'text', data: JSON.stringify({ type: 'session.updated' }) }); }
    },
  });
  await client.connect({ config: makeRealtimeProfile('step_realtime'), sessionConfig: { instructions: 'role' } });
  client.emit({ type: 'response.created', response: { id: 'playing' } });
  client.emit({ type: 'response.output_audio_transcript.delta', response_id: 'playing', delta: 'queued speech' });
  client.emit({ type: 'response.done', response: { id: 'playing', status: 'completed' } });
  assert(!events.some(e => e.type === 'response.done')); assert.equal(client.pendingFinals.size, 1);
  client.sendEvent({ type: 'response.cancel' });
  assert(events.some(e => e.type === 'response.cancelled' && e.response.id === 'playing')); assert.equal(client.pendingFinals.size, 0); assert.equal(audio.nextTime, 0);
  await client.close();
});
await test('natural calls close on failed user persistence without saving an orphan reply', async () => {
  let callbacks, closed = false, assistantWrites = 0; const errors = [];
  const profile = makeRealtimeProfile('step_realtime');
  const runtime = createRealtimeCallRuntime({ getCallTarget: () => ({ supported: true, sessionId: 's' }), resolveConnection: async () => ({ config: profile, settings: { ...profile, realtimeModel: profile.model, contextMode: 'session_snapshot' } }),
    buildSemanticSnapshot: async () => ({ instructions: 'role' }), createSessionClient: value => { callbacks = value; return { connect: async () => {}, close: async () => { closed = true; }, sendEvent: () => {} }; },
    commitUserMessage: async () => null, commitAssistantMessage: async () => { assistantWrites++; return { id: 'a' }; }, onError: error => errors.push(error), setIntervalFn: () => null });
  await runtime.start();
  callbacks.onEvent({ type: 'response.created', response: { id: 'r' } }); callbacks.onEvent({ type: 'response.output_audio_transcript.delta', response_id: 'r', delta: 'reply' });
  callbacks.onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'question' });
  await runtime.whenIdle(); await tick(); await tick();
  assert(closed); assert.equal(runtime.getState().status, 'idle'); assert.equal(assistantWrites, 0); assert.equal(errors[0].code, 'user_message_commit_failed');
});
console.log(`realtime multi-provider tests passed (${count})`);
