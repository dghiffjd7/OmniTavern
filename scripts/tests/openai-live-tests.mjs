import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { buildOpenAiLiveSessionConfig, filterOpenAiLiveBackendModels } from '../../src/scripts/ui/realtime/openai-live-config.js';
import { makeRealtimeProfile, validateRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { RealtimeModelDiscovery, filterRealtimeModels, realtimeModelDefaults, realtimeModelSource } from '../../src/scripts/ui/realtime/realtime-model-discovery.js';
import { getRealtimeSystemVoices } from '../../src/scripts/ui/realtime/realtime-voice-catalog.js';
import { normalizeRealtimeVoiceSettings } from '../../src/scripts/ui/realtime/realtime-voice-config-utils.js';
import { RealtimeProfileStore } from '../../src/scripts/storage/realtime-profile-store.js';
import { OpenAiLiveSessionClient } from '../../src/scripts/ui/realtime/openai-live-session-client.js';
import { OpenAiLiveTranscript, createLiveTranscriptCommitter } from '../../src/scripts/ui/realtime/openai-live-transcript.js';
import { createOpenAiLiveCallEvents } from '../../src/scripts/ui/realtime/openai-live-call-events.js';
import { createRealtimeCallRuntime } from '../../src/scripts/ui/realtime/realtime-call-runtime.js';
import { createRealtimeCallAppRuntime } from '../../src/scripts/ui/realtime/realtime-call-app-runtime.js';
import { accumulateRealtimeUsage, createRealtimeUsageTotals, formatRealtimeUsageText } from '../../src/scripts/ui/realtime/realtime-usage-utils.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const tick = () => new Promise(resolve => setImmediate(resolve));
const profile = { ...makeRealtimeProfile('openai'), openaiBackend: 'live', model: 'gpt-live-1', voice: 'willow', replyLanguage: '台湾普通话' };
const settings = normalizeRealtimeVoiceSettings(profile);
assert.equal(settings.contextMode, 'full_duplex');
assert.equal(settings.realtimeModel, 'gpt-live-1');
assert.equal(settings.voice, 'willow');
assert.equal(settings.transcriptionModel, '');
assert.equal(makeRealtimeProfile('openai').openaiBackend, 'realtime');
validateRealtimeProfile(profile);
assert.throws(() => validateRealtimeProfile({ ...profile, openaiBackend: 'realtime' }), /GPT-Live/);
assert.throws(() => validateRealtimeProfile({ ...profile, model: 'gpt-live-transcribe' }), /模型 ID/);
assert.throws(() => validateRealtimeProfile({ ...profile, openaiBackend: 'realtime', model: 'gpt-realtime-2.1' }), /声音/);
assert.equal(getRealtimeSystemVoices(profile).length, 22);
assert.equal(getRealtimeSystemVoices(makeRealtimeProfile('openai')).length, 10);
assert.deepEqual(realtimeModelDefaults(profile), ['gpt-live-1']);
assert.notEqual(realtimeModelSource(profile), realtimeModelSource({ ...profile, openaiBackend: 'realtime' }));
const models = ['gpt-realtime-2.1', 'gpt-live-1', 'gpt-live-1-2026-09-11', 'gpt-live-transcribe', 'gpt-live-1-transcribe', 'gpt-5.6-luna', 'gpt-image-2', 'whisper-1'];
assert.deepEqual(filterRealtimeModels(profile, models.map(id => ({ id }))), models.slice(1, 3));
assert.deepEqual(filterRealtimeModels(profile, [{ id: 'gpt-live-next' }]), ['gpt-live-next'], 'future aliases remain editable');
assert.deepEqual(filterOpenAiLiveBackendModels(models.map(id => ({ id }))), ['gpt-5.6-luna']);
const payload = buildOpenAiLiveSessionConfig({ ...settings, instructions: 'character snapshot' });
assert.equal(payload.model, 'gpt-live-1');
assert.deepEqual(payload.audio, { output: { voice: 'willow' } });
assert.equal(payload.delegation.type, 'responses');
assert.equal(payload.delegation.responses.model, 'gpt-5.6-luna');
assert.equal(payload.delegation.responses.tool_choice, 'none');
assert.match(payload.delegation.responses.instructions, /character snapshot/);
assert.equal(payload.store, false);
assert(!('type' in payload) && !('input' in payload.audio) && !('format' in payload.audio));

{
  const discovery = new RealtimeModelDiscovery({ invoke: async (command, args) => {
    assert.equal(command, 'http_request'); assert.equal(args.url, 'https://api.openai.com/v1/models');
    return { status: 200, body: JSON.stringify({ data: [...Array.from({ length: 130 }, (_, i) => ({ id: `gpt-5.6-candidate-${i}` })), ...models.map(id => ({ id }))] }) };
  } });
  assert.equal((await discovery.list(profile, { apiKey: 'test' })).models.length, 2);
  assert.equal((await discovery.listBackendModels(profile, { apiKey: 'test' })).models.length, 131, 'no first-100 truncation');
  const keys = new Map(); let disk;
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem() {} },
    invoke: async (cmd, args) => cmd === 'save_kv' ? (disk = args.data) : disk,
    keyring: { addKey: async (id, data) => { keys.set(id, data); return 'key-1'; }, decryptKey: async id => keys.get(id), removeKey: async () => {} },
  });
  const saved = await store.save(profile, { apiKey: 'secret' });
  const resolved = await store.resolve();
  assert.equal(resolved.settings.openaiBackend, 'live'); assert.equal(resolved.settings.liveBackendModel, 'gpt-5.6-luna');
  assert.equal(resolved.settings.contextMode, 'full_duplex'); assert.equal(resolved.config.apiKey, 'secret');
  assert(!JSON.stringify(disk).includes('secret'));
  assert.equal(store.get(saved.id).voice, 'willow');
}

class Channel extends EventTarget {
  readyState = 'connecting'; sent = [];
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
  event(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  send(raw) { const event = JSON.parse(raw); this.sent.push(event); this.onSend?.(event); }
  close() { this.readyState = 'closed'; }
}
class Peer extends EventTarget {
  constructor() { super(); this.channel = new Channel(); this.iceGatheringState = 'new'; this.connectionState = 'new'; Peer.latest = this; }
  addTrack() {}
  createDataChannel(label) { assert.equal(label, 'oai-events'); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'pending-ice' }; }
  async setLocalDescription(offer) {
    this.localDescription = offer;
    queueMicrotask(() => { this.iceGatheringState = 'complete'; this.localDescription = { type: 'offer', sdp: 'complete-ice' }; this.dispatchEvent(new Event('icegatheringstatechange')); });
  }
  async setRemoteDescription(answer) { this.answer = answer; this.channel.open(); }
  close() { this.connectionState = 'closed'; }
}
const makeClient = (overrides = {}) => {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } }, events = [], requests = [];
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const client = new OpenAiLiveSessionClient({
    peerConnectionClass: Peer, mediaDevices: { getUserMedia: async () => stream }, microphoneAccess: { acquire: async () => stream },
    createAudioElement: () => ({ style: {}, remove() {}, play() {} }), createMeter: () => ({ attach() {}, setMuted() {}, close() {} }),
    onEvent: event => events.push(event), closeTimeoutMs: 20,
    invoke: async (command, args) => {
      requests.push({ command, args });
      return { status: 201, body: JSON.stringify({ session: { id: 'live-test' }, transport: { type: 'webrtc', sdp: 'answer' } }) };
    }, ...overrides,
  });
  return { client, track, events, requests };
};
const connectReady = async client => {
  const pending = client.connect({ config: { apiKey: 'test-key' }, sessionConfig: payload });
  await tick(); Peer.latest.channel.event({ type: 'session.started', session: { id: 'live-test' } });
  await pending; return Peer.latest;
};
{
  const { client, track, events, requests } = makeClient();
  let ready = false;
  const connecting = client.connect({ config: { apiKey: 'test-key' }, sessionConfig: payload }).then(() => { ready = true; });
  await tick();
  assert.equal(ready, false, 'open data channel is insufficient before session.started');
  const peer = Peer.latest;
  assert.deepEqual(peer.answer, { type: 'answer', sdp: 'answer' });
  assert.equal(requests[0].command, 'http_request');
  assert.equal(requests[0].args.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(requests[0].args.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].args.body), { session: payload, transport: { type: 'webrtc', sdp: 'complete-ice' } });
  peer.channel.event({ type: 'session.started', session: { id: 'live-test' } }); await connecting;
  assert.equal(client.setMicrophoneMuted(true), true); assert.equal(track.enabled, false);
  client.setMicrophoneMuted(false); assert.equal(track.enabled, true);
  assert.deepEqual(peer.channel.sent.map(e => e.type), ['session.input_audio.mute', 'session.input_audio.unmute']);
  let receivedClose = false;
  peer.channel.onSend = event => { if (event.type === 'session.close') {
    receivedClose = true; assert.equal(track.stopped, false); assert.equal(peer.channel.readyState, 'open');
    queueMicrotask(() => {
      peer.channel.event({ type: 'session.output_transcript.delta', event_id: 'late', delta: '最后一个字', start_ms: 10, end_ms: 20 });
      peer.channel.event({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 17 } });
    });
  } };
  await client.close();
  assert(receivedClose && track.stopped);
  assert.equal(events.at(-1).type, 'session.closed'); assert.equal(events.at(-2).delta, '最后一个字');
  assert(!peer.channel.sent.some(e => ['session.start', 'response.create', 'response.cancel'].includes(e.type)));
}
{
  const { client, track, events } = makeClient(); await connectReady(client); await client.close();
  assert(track.stopped); assert.equal(events.at(-1).type, 'live.finalization.incomplete');
}
{
  const { client, track } = makeClient({ invoke: async () => ({ status: 401, body: JSON.stringify({ error: { message: 'No access test-key' } }) }) });
  await assert.rejects(client.connect({ config: { apiKey: 'test-key' }, sessionConfig: payload }), error => /401/.test(error.message) && !error.message.includes('test-key'));
  assert(track.stopped);
}
{
  const { client, track } = makeClient(); const controller = new AbortController();
  const pending = client.connect({ config: { apiKey: 'test-key' }, sessionConfig: payload, signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert(track.stopped);
}
{
  let acquire;
  const lateTrack = { stopped: false, stop() { this.stopped = true; } };
  const { client } = makeClient({ microphoneAccess: { acquire: () => new Promise(resolve => { acquire = resolve; }) } });
  const controller = new AbortController();
  const pending = client.connect({ signal: controller.signal, config: { apiKey: 'test-key' }, sessionConfig: payload });
  await tick(); controller.abort(); acquire({ getTracks: () => [lateTrack] });
  await assert.rejects(pending, { name: 'AbortError' }); assert(lateTrack.stopped, 'permission completing after cancellation releases its stream');
}
{
  const { client, track } = makeClient();
  await assert.rejects(client.connect({ config: { apiKey: 'test-key' }, sessionConfig: payload, timeoutMs: 20 }), /连接超时/);
  assert(track.stopped, 'startup timeout is visible and releases media');
}
{
  let acquire;
  const lateTrack = { stopped: false, stop() { this.stopped = true; } };
  const { client } = makeClient({ microphoneAccess: { acquire: () => new Promise(resolve => { acquire = resolve; }) } });
  const controller = new AbortController();
  const pending = client.connect({ signal: controller.signal, config: { apiKey: 'test-key' }, sessionConfig: payload });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  acquire({ getTracks: () => [lateTrack] }); await tick(); assert(lateTrack.stopped, 'abort finishes before permission UI returns');
}
{
  const states = [];
  const { client } = makeClient({ onConnectionState: state => states.push(state) });
  const peer = await connectReady(client);
  peer.channel.readyState = 'closed'; peer.channel.dispatchEvent(new Event('close'));
  assert.deepEqual(states, ['failed']); await client.close();
}

const fragment = (role, id, delta, start, end) => ({ type: `session.${role === 'user' ? 'input' : 'output'}_transcript.delta`, event_id: id, delta, start_ms: start, end_ms: end });
{
  let sequence = 0; const transcript = new OpenAiLiveTranscript({ makeId: () => `group-${++sequence}` });
  const first = transcript.append(fragment('user', 'u1', ' hello', 100, 400));
  transcript.append(fragment('assistant', 'a1', 'Hi ', 250, 500));
  transcript.append(fragment('user', 'u2', ' world ', 350, 600));
  assert.equal(first.text, ' hello world ');
  assert.equal(transcript.append(fragment('user', 'u2', 'duplicate', 350, 600)), null);
  const next = transcript.append(fragment('user', 'u3', 'second', 8000, 8500));
  const late = transcript.append(fragment('user', 'u4', 'late', 550, 700));
  assert.equal(first.id, late.id); assert.notEqual(first.id, next.id);
  assert.equal(first.text, ' hello world late'); assert.equal(first.fragments.length, 3);
  assert.equal(transcript.captions().find(c => c.role === 'user').text, 'second');
  const tiny = new OpenAiLiveTranscript({ maxFragments: 1 }); tiny.append(fragment('user', '1', 'ok', 0, 1));
  assert.throws(() => tiny.append(fragment('user', '2', 'more', 1, 2)), { code: 'live_transcript_limit' });
}
{
  const target = { sessionId: 's', name: '角色' }, messages = new Map(); let current = true, count = 0;
  const commit = createLiveTranscriptCommitter({ isTargetCurrent: () => current, findMessage: id => messages.get(id),
    appendMessage: message => { const saved = { ...message, id: `m-${++count}` }; messages.set(saved.id, saved); return saved; },
    updateMessage: (id, message) => { messages.set(id, message); return message; },
  });
  const group = { id: 'g1', text: '<tableEdit>spoken</tableEdit>', role: 'assistant', fragments: [], savedText: '' };
  const meta = { realtimeSessionId: 'live-test' };
  const result = commit({ target, group, meta }); group.messageId = result.messageId; group.savedText = group.text; group.text += ' more';
  commit({ target, group, meta }); assert.equal(count, 1); assert.equal(messages.get(result.messageId).meta.renderRich, false);
  group.savedText = group.text; messages.get(result.messageId).content = 'user edit';
  assert(commit({ target, group, meta }).ignored, 'manual edits are retained');
  messages.delete(result.messageId); assert(commit({ target, group, meta }).ignored, 'deleted groups are never resurrected');
  current = false; assert(commit({ target, group: { ...group, messageId: '' }, meta }).ignored);
}
{
  let timer, pending = Promise.resolve(), count = 0; const saved = new Map();
  const handler = createOpenAiLiveCallEvents({ target: { sessionId: 's' }, settings, isTargetCurrent: () => true,
    enqueue: task => (pending = pending.then(task)), setTimeoutFn: task => { timer = task; return 1; }, clearTimeoutFn() {},
    commitTranscript: ({ group }) => { count++; const id = group.messageId || group.id; saved.set(id, group.text); return { messageId: id }; },
  });
  handler.handle({ type: 'session.started', session: { id: 'test' } });
  handler.handle(fragment('user', 'u1', 'a', 0, 1)); handler.handle(fragment('user', 'u2', ' b', 2, 3));
  assert.equal(count, 0); timer(); await pending; assert.equal(count, 1);
  handler.handle(fragment('user', 'u3', ' c', 3, 4)); await handler.flush();
  assert.equal(count, 2); assert.equal(saved.size, 1); assert.equal([...saved.values()][0], 'a b c'); handler.dispose();
}
{
  let client, usage = createRealtimeUsageTotals(), clock = 1000;
  const saves = [], errors = [], captions = [];
  const runtime = createRealtimeCallRuntime({
    resolveConnection: async () => ({ config: { provider: 'openai', openaiBackend: 'live' }, settings }),
    buildSemanticSnapshot: async () => ({ instructions: 'character context' }), getCallTarget: () => ({ supported: true, sessionId: 's' }),
    isTargetCurrent: () => true, commitUserMessage: () => assert.fail('Live fragments are not input turns'), commitAssistantMessage: () => assert.fail('Live fragments are not completed replies'),
    commitLiveTranscript: data => { saves.push(data); return { messageId: data.group.id }; },
    onCaption: data => captions.push(data), onError: error => errors.push(error), onUsage: event => { usage = accumulateRealtimeUsage(usage, event); },
    now: () => clock, setIntervalFn: () => 1, clearIntervalFn() {},
    createSessionClient: callbacks => (client = { callbacks, sent: [],
      async connect(options) { this.options = options; callbacks.onEvent({ type: 'session.started', session: { id: 'live-call' } }); },
      sendEvent(event) { this.sent.push(event); },
      async close() { callbacks.onEvent(fragment('assistant', 'a2', ' bye', 900, 1000)); callbacks.onEvent({ type: 'session.closed', usage: { seconds: 14 }, reason: 'close_requested' }); },
    }),
  });
  assert(await runtime.start()); assert.equal(client.callbacks.openaiBackend, 'live');
  assert.equal(runtime.getState().openaiBackend, 'live'); assert.match(client.options.sessionConfig.instructions, /台湾普通话/);
  client.callbacks.onEvent(fragment('user', 'u1', ' hello', 10, 100));
  client.callbacks.onEvent(fragment('assistant', 'a1', 'hi', 50, 150));
  client.callbacks.onEvent({ type: 'session.usage.updated', usage: { seconds: 8 } });
  client.callbacks.onEvent({ type: 'session.usage.updated', usage: { seconds: 10 } });
  const response = { type: 'response.event', event: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 20, output_tokens: 3 } } } };
  client.callbacks.onEvent(response); client.callbacks.onEvent(response);
  assert.equal(usage.live.seconds, 10); assert.equal(usage.responseCount, 1);
  assert.equal(captions.at(-1).captions.length, 2);
  assert.equal(await runtime.interrupt(), false); assert.equal(client.sent.length, 0);
  clock += 10 * 60 * 1000; client.callbacks.onAudioLevel({ input: { level: .5 } });
  assert.equal(runtime.checkTimeouts(clock), false, 'audio activity keeps a live call active');
  await runtime.end(); assert.equal(runtime.getState().status, 'idle');
  assert.equal(usage.live.seconds, 14); assert.equal(usage.live.finalized, true);
  assert.equal(saves.length, 2); assert.equal(saves[1].group.text, 'hi bye'); assert.equal(saves[0].meta.realtimeSessionId, 'live-call');
  assert.equal(saves[1].meta.realtimeLiveUsage.seconds, 14); assert.equal(saves[1].meta.realtimeLiveUsage.finalized, true);
  assert.equal(saves[1].meta.realtimeLiveUsage.backendInputTokens, 20);
  assert.equal(errors.length, 0); assert.match(formatRealtimeUsageText(usage), /14/);
  client.callbacks.onEvent(fragment('user', 'stale', 'stale', 5000, 5100)); assert.equal(saves.length, 2);
}
{
  let connecting, liveClient;
  const runtime = createRealtimeCallRuntime({
    resolveConnection: async () => ({ config: { provider: 'openai', openaiBackend: 'live' }, settings }),
    buildSemanticSnapshot: async () => ({ instructions: 'context' }), getCallTarget: () => ({ supported: true, sessionId: 'cancel' }),
    isTargetCurrent: () => true, commitLiveTranscript: () => assert.fail('no transcript'), setIntervalFn: () => 1, clearIntervalFn() {},
    createSessionClient: callbacks => (liveClient = {
      connect: ({ signal }) => new Promise((resolve, reject) => { connecting = true; signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); }),
      close: async () => { await tick(); callbacks.onEvent({ type: 'live.finalization.incomplete' }); },
    }),
  });
  const start = runtime.start(); await tick(); assert(connecting && liveClient);
  const close = runtime.end('user'); await Promise.all([start, close]);
  assert.equal(runtime.getState().status, 'idle');
}
{
  const documentRef = new EventTarget(); documentRef.visibilityState = 'visible';
  const windowLike = new EventTarget(); let epoch = 0; const saves = [];
  const app = createRealtimeCallAppRuntime({ documentRef, windowLike,
    getCallTarget: () => ({ supported: true, sessionId: 'background', lifecycleEpoch: epoch }),
    isTargetCurrent: target => target.lifecycleEpoch === epoch,
    resolveConnection: async () => ({ config: { provider: 'openai', openaiBackend: 'live' }, settings }),
    buildSemanticSnapshot: async () => ({ instructions: 'context' }), onLifecycleInvalidated: () => { epoch++; },
    commitLiveTranscript: data => { saves.push(data); return { messageId: data.group.id }; },
    createPanel: () => ({ hide() {}, renderState() {}, setUsage() {}, setCaption() {}, destroy() {} }),
    createSessionClient: callbacks => ({
      async connect() { callbacks.onEvent({ type: 'session.started', session: { id: 'background-live' } }); },
      async close() { await tick(); callbacks.onEvent(fragment('assistant', 'last', '再见', 10, 20)); callbacks.onEvent({ type: 'session.closed', usage: { seconds: 2 } }); },
    }),
  });
  assert(await app.runtime.start()); documentRef.visibilityState = 'hidden'; documentRef.dispatchEvent(new Event('visibilitychange'));
  assert.equal(app.runtime.getState().status, 'ending'); assert.equal(epoch, 0);
  await app.runtime.end(); await tick();
  assert.equal(epoch, 1); assert.equal(saves[0].group.text, '再见', 'background termination drains while its captured target is still valid');
  await app.destroy();
}
console.log('OpenAI Live: discovery, encrypted profiles, WebRTC lifecycle, transcript revisions, persistence and usage passed');
