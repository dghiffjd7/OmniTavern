import assert from 'node:assert/strict';
import test from 'node:test';
import { makeRealtimeProfile, validateRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { RealtimeProfileStore } from '../../src/scripts/storage/realtime-profile-store.js';
import { normalizeCustomRealtimeEndpoint, customRealtimeHeaders, parseCustomRealtimeHeaders } from '../../src/scripts/ui/realtime/custom-realtime-config.js';
import { normalizeRealtimeVoiceSettings, buildOpenAiRealtimeSessionConfig } from '../../src/scripts/ui/realtime/realtime-voice-config-utils.js';
import { createCustomRealtimeProtocol } from '../../src/scripts/ui/realtime/custom-realtime-protocol.js';
import { NativeRealtimeSessionClient } from '../../src/scripts/ui/realtime/native-realtime-session-client.js';
import { checkCustomRealtime } from '../../src/scripts/ui/realtime/custom-realtime-probe.js';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';
import { registerRealtimeSettingsTarget, acquireRealtimeSettingsCheck, isRealtimeSettingsCheckActive } from '../../src/scripts/ui/realtime/realtime-settings-target.js';
const profile = () => ({ ...makeRealtimeProfile('custom'), endpoint: 'https://voice.example.test/proxy/v1?route=a', model: 'vendor/MyVoice', voice: 'Voice_A', transcriptionModel: 'vendor-transcribe' });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('custom addresses preserve routes, reject unsafe schemes, and keep credentials in headers', () => {
  assert.equal(normalizeCustomRealtimeEndpoint(profile().endpoint), 'wss://voice.example.test/proxy/v1/realtime?route=a');
  assert.equal(normalizeCustomRealtimeEndpoint('wss://voice.example.test/speech/ws?api-version=v2'), 'wss://voice.example.test/speech/ws?api-version=v2');
  assert.equal(normalizeCustomRealtimeEndpoint('http://127.0.0.1:1234'), 'ws://127.0.0.1:1234/v1/realtime');
  for (const url of ['ws://example.test/a', 'file:///C:/a', 'https://user:pass@example.test/v1', 'https://example.test/v1#token']) assert.throws(() => normalizeCustomRealtimeEndpoint(url));
  assert.deepEqual(customRealtimeHeaders(profile(), { apiKey: 'secret', extraHeaders: '{"X-Route":"regional"}' }), { 'x-route': 'regional', authorization: 'Bearer secret' });
  assert.deepEqual(customRealtimeHeaders({ ...profile(), authMode: 'header', authHeader: 'api-key' }, { apiKey: 'secret' }), { 'api-key': 'secret' });
  assert.deepEqual(customRealtimeHeaders({ ...profile(), authMode: 'none' }, {}), {});
  assert.equal(parseCustomRealtimeHeaders('{"__proto__":"route"}').__proto__, 'route');
  assert.equal(customRealtimeHeaders({ ...profile(), authMode: 'header', authHeader: '__proto__' }, { apiKey:'secret' }).__proto__, 'secret');
  for (const headers of [{ Host: 'wrong' }, { 'Sec-WebSocket-Protocol': 'wrong' }, { A: '1', a: '2' }, { a: 'one\r\ninjected' }, []]) assert.throws(() => parseCustomRealtimeHeaders(headers));
  assert.throws(() => customRealtimeHeaders(profile(), { apiKey: 'key', extraHeaders: '{"Authorization":"duplicate"}' }));
  assert.throws(() => validateRealtimeProfile({ ...profile(), transcriptionModel: '' }));
});

test('custom profiles survive restart, duplicate and role binding without persisting secrets in metadata', async () => {
  const keys = new Map(); let saved;
  const deps = { storage: { getItem: () => null, setItem: () => {} },
    invoke: async (command, args) => command === 'save_kv' ? (saved = structuredClone(args.data)) : saved,
    keyring: { addKey: async (id, value) => { const key = crypto.randomUUID(); keys.set(key, value); return key; }, decryptKey: async (id, key) => keys.get(key), removeKey: async (id, key) => keys.delete(key) } };
  const store = new RealtimeProfileStore(deps); await store.ready;
  const item = await store.save({ ...profile(), vad: { threshold: .7, prefixPaddingMs: 500, silenceDurationMs: 1200 } }, { apiKey: 'secret', extraHeaders: '{"X-Secret":"header-secret"}' });
  const target = { supported: true, sessionId: 'maid', uiMode: 'maid' };
  await store.bindTarget(target, item.id);
  const reloaded = new RealtimeProfileStore(deps); await reloaded.ready;
  const resolved = await reloaded.resolveBinding(target);
  assert.equal(resolved.config.endpoint, profile().endpoint);
  assert.equal(resolved.config.credentials.apiKey, 'secret');
  assert.equal(normalizeRealtimeVoiceSettings(resolved.settings).contextMode, 'per_turn');
  assert.equal(resolved.settings.transcriptionModel, 'vendor-transcribe');
  assert.equal(resolved.settings.voice, 'Voice_A');
  const detection = buildOpenAiRealtimeSessionConfig(resolved.settings).audio.input.turn_detection;
  assert.equal(detection.threshold, .7);
  assert.equal(detection.prefix_padding_ms, 500);
  assert.equal(detection.silence_duration_ms, 1200);
  assert.equal(detection.create_response, false);
  assert(!JSON.stringify(saved).includes('header-secret')); assert(!JSON.stringify(saved).includes('"apiKey"'));
  const copy = await reloaded.duplicate(item.id); assert.notEqual(copy.credentialId, item.credentialId);
  assert.equal(copy.endpoint, item.endpoint);
  assert.deepEqual(copy.vad, item.vad);
  const noKey = await reloaded.save({ ...profile(), authMode: 'none' }, null);
  assert(noKey.credentialId); assert.deepEqual(await reloaded.credentials(noKey), {});
});

test('custom VAD defaults survive old profiles and malformed values cannot change turn ownership', () => {
  const detection = value => buildOpenAiRealtimeSessionConfig({ ...profile(), vad: value }).audio.input.turn_detection;
  assert.equal(detection(undefined).silence_duration_ms, 600);
  assert.equal(detection({ threshold: '', prefixPaddingMs: null }).threshold, .5);
  const normalized = detection({ threshold: 5, silenceDurationMs: -1, prefixPaddingMs: 'bad', mode: 'semantic_vad', createResponse: true, interruptResponse: false });
  assert.equal(normalized.type, 'server_vad');
  assert.equal(normalized.threshold, 1);
  assert.equal(normalized.silence_duration_ms, 100);
  assert.equal(normalized.prefix_padding_ms, 300);
  assert.equal(normalized.create_response, false);
  assert.equal(normalized.interrupt_response, true);
});

test('GA adapter waits for session acceptance, streams PCM and truncates heard audio without counting silence gaps', () => {
  const sent = [], events = []; let accepted = 0, now = 0, plays = 0, clears = 0;
  const sessionConfig = buildOpenAiRealtimeSessionConfig({ ...profile(), realtimeModel: profile().model, instructions: 'role' });
  sessionConfig.tools = [{ type: 'function', name: 'maid_task' }];
  const adapter = createCustomRealtimeProtocol({ sessionConfig, send: event => sent.push(event), emit: event => events.push(event), ready: () => accepted++,
    play: () => ++plays === 1 ? { start: .15, end: 1.15 } : { start: 2.15, end: 3.15 }, clear: () => { clears++; assert.equal(events.at(-1).type, 'input_audio_buffer.speech_started'); }, playbackTime: () => now });
  adapter.start(); assert.equal(sent[0].session.audio.input.format.rate, 24000);
  assert.equal(sent[0].session.audio.input.transcription.model, 'vendor-transcribe'); assert.equal(sent[0].session.audio.output.voice, 'Voice_A');
  assert.equal(sent[0].session.audio.input.turn_detection.create_response, false); assert.equal(sent[0].session.tools[0].name, 'maid_task');
  assert(!('truncation' in sent[0].session)); assert(!('input_audio_format' in sent[0].session));
  adapter.receive({ type: 'session.created' }); assert.equal(accepted, 0); adapter.receive({ type: 'session.updated' }); assert.equal(accepted, 1);
  adapter.audio('AAAA'); assert.equal(sent.at(-1).type, 'input_audio_buffer.append');
  adapter.sendEvent({ type: 'session.update', session: { instructions: 'new role' } }); assert.equal(sent.at(-1).session.instructions, 'new role');
  adapter.receive({ type: 'response.created', response: { id: 'r' } });
  const audio = { type: 'response.output_audio.delta', response_id: 'r', item_id: 'item', content_index: 0, delta: 'AAAA' };
  adapter.receive(audio); now = 1.2; adapter.receive(audio); now = 2.65;
  adapter.receive({ type: 'response.done', response: { id: 'r', status: 'completed' } });
  adapter.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u' });
  assert.equal(sent.at(-1).type, 'conversation.item.truncate'); assert.equal(sent.at(-1).audio_end_ms, 1500);
  assert(!sent.some(event => event.type === 'response.cancel'), 'generation ended, queued playback still gets truncated');
  adapter.receive(audio); assert.equal(plays, 2); assert.equal(clears, 1);
  adapter.receive({ type: 'response.created', response: { id: 'new' } }); adapter.receive(audio); assert.equal(plays, 2, 'stale audio stays suppressed');
});

const fakeTransport = ({ rejectSetup = false, badTool = false } = {}) => {
  const sent = [], closed = [], connections = []; let callback, session, receipt;
  const emit = event => callback({ kind: 'text', data: JSON.stringify(event) });
  const invoke = async (name, args) => {
    if (name === 'realtime_transport_open') { connections.push(args.connection); callback = args.onEvent; queueMicrotask(() => callback({ kind: 'open' })); }
    if (name === 'realtime_transport_close') closed.push(args.id);
    if (name === 'realtime_transport_send') for (const frame of args.messages) {
      const event = JSON.parse(frame.data); sent.push(event);
      if (event.type === 'session.update') {
        session = event.session;
        emit(rejectSetup ? { type: 'error', error: { message: 'Unsupported transcription model' } } : { type: 'session.updated', session: { id: 's' } });
      }
      if (event.item?.type === 'function_call_output') receipt = JSON.parse(event.item.output).receipt;
      if (event.type === 'response.create') {
        emit({ type: 'response.created', response: { id: 'r' } });
        const first = event.response.tool_choice?.type === 'function';
        const output = first ? [{ type: 'function_call', name: 'realtime_compatibility_probe', call_id: 'probe', arguments: JSON.stringify({ token: badTool ? 'wrong' : session.tools[0].parameters.properties.token.enum[0] }) }]
          : [{ type: 'message', content: [{ type: 'output_text', text: receipt }] }];
        emit({ type: 'response.done', response: { id: 'r', status: 'completed', output } });
      }
    }
  };
  return { sent, closed, connections, emit, createClient: options => new NativeRealtimeSessionClient({ ...options, invoke, createChannel: cb => cb }) };
};

test('connection and tool checks exercise native client, both tool directions, and close without opening a microphone', async () => {
  const transport = fakeTransport();
  const result = await checkCustomRealtime(profile(), { apiKey: 'private' }, { checkTools: true, createClient: transport.createClient });
  assert.deepEqual(result, { connected: true, tools: 'verified', audio: 'unverified' });
  assert.equal(transport.connections[0].endpoint, 'wss://voice.example.test/proxy/v1/realtime?route=a');
  assert.equal(transport.closed.length, 1); assert.equal(transport.sent.filter(e => e.type === 'response.create').length, 2);
  assert(!transport.sent.some(e => e.type === 'input_audio_buffer.append'));
  assert(!transport.sent.some(e => e.session?.instructions?.includes('role')));
  const connectionOnly = fakeTransport();
  assert.equal((await checkCustomRealtime(profile(), { apiKey: 'key' }, { createClient: connectionOnly.createClient })).tools, 'unverified');
  assert.equal(connectionOnly.closed.length, 1);
});

test('failed session initialization, unsupported tools and cancellation release the native connection', async () => {
  for (const scenario of [{ rejectSetup: true }, { badTool: true }]) {
    const transport = fakeTransport(scenario);
    await assert.rejects(checkCustomRealtime(profile(), { apiKey: 'key' }, { createClient: transport.createClient, checkTools: true }));
    assert.equal(transport.closed.length, 1);
  }
  const controller = new AbortController(); controller.abort(); const transport = fakeTransport();
  await assert.rejects(checkCustomRealtime(profile(), { apiKey: 'key' }, { createClient: transport.createClient, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(transport.connections.length, 0);
});

test('custom maid calls return accepted IDs and independently resume with finished task results', async () => {
  const sent = []; const target = { uiMode: 'maid', maidCallId: 'call' };
  const session = createRealtimeMaidTaskSession({ provider: 'custom', target,
    getClient: () => ({ sendToolResults: results => sent.push({ results }), sendTaskUpdate: text => sent.push({ text }), requestResponse: () => sent.push({ respond: true }) }),
    handleTaskRequest: async () => ({ ok: true, accepted: true, task_id: 'task' }) });
  const event = { type: 'response.done', response: { id: 'r', status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'maid_task', arguments: '{"action":"execute","request":"create a room"}' }] } };
  session.handle({ type: 'response.created', response: { id: 'r' } }); session.handle(event); session.handle(event); await tick();
  assert.equal(sent.filter(e => e.results).length, 1); assert.equal(sent[0].results[0].result.task_id, 'task'); assert.equal(sent.filter(e => e.respond).length, 1);
  session.handle({ type: 'response.created', response: { id: 'ack' } }); session.handle({ type: 'response.done', response: { id: 'ack', status: 'completed' } });
  session.notifyTaskUpdate({ target, task_id: 'task', status: 'completed', message: 'room created' });
  assert(sent.some(e => e.text?.includes('room created'))); assert.equal(sent.filter(e => e.respond).length, 2); session.dispose();
});

test('settings checks cannot replace an active call or overlap another check', () => {
  let busy = true; const unregister = registerRealtimeSettingsTarget(() => null, () => {}, () => busy);
  assert.equal(acquireRealtimeSettingsCheck(), null); busy = false;
  const release = acquireRealtimeSettingsCheck(); assert(release); assert(isRealtimeSettingsCheckActive()); assert.equal(acquireRealtimeSettingsCheck(), null);
  release(); assert(!isRealtimeSettingsCheckActive()); unregister();
});
