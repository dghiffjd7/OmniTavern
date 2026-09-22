import assert from 'node:assert/strict';

import { OpenAiRealtimeSessionClient } from '../../src/scripts/ui/realtime/openai-realtime-session-client.js';
import { microphonePermissionRecovery } from '../../src/scripts/ui/microphone-permission-recovery.js';

class FakeDataChannel {
  constructor() {
    this.readyState = 'connecting';
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  emit(type, event = {}) {
    this.listeners.get(type)?.forEach(callback => callback(event));
  }

  open() {
    this.readyState = 'open';
    this.emit('open');
  }

  send(payload) { this.sent.push(payload); }
  close() { this.readyState = 'closed'; }
}

class FakePeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.channel = new FakeDataChannel();
    this.tracks = [];
    FakePeerConnection.instance = this;
  }

  createDataChannel(label) {
    assert.equal(label, 'oai-events');
    return this.channel;
  }

  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=fake-offer\r\n' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) {
    this.remoteDescription = value;
    queueMicrotask(() => this.channel.open());
  }
  close() { this.connectionState = 'closed'; }
}

const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
const audioElement = {
  autoplay: false,
  muted: false,
  srcObject: null,
  async play() { this.played = true; },
  remove() { this.removed = true; },
};
const events = [];
const connectionStates = [];
const calls = [];
const microphoneCalls = [];
const mediaDevices = { getUserMedia: async () => stream };
const meterCalls = [], audioLevels = [];
let meterCallback;
const client = new OpenAiRealtimeSessionClient({
  invoke: async (command, args) => {
    calls.push({ command, args });
    return 'v=0\r\no=fake-answer';
  },
  peerConnectionClass: FakePeerConnection,
  mediaDevices,
  microphoneAccess: {
    acquire: async options => {
      microphoneCalls.push(options);
      return microphonePermissionRecovery.acquire(options);
    },
  },
  createAudioElement: () => audioElement,
  onEvent: event => events.push(event),
  onConnectionState: state => connectionStates.push(state),
  onAudioLevel: value => audioLevels.push(value),
  createMeter: ({ onLevel }) => {
    meterCallback = onLevel;
    return { attach: (channel, source) => meterCalls.push(['attach', channel, source]), setMuted: (channel, muted) => meterCalls.push(['mute', channel, muted]), close: async () => meterCalls.push(['close']) };
  },
});

await client.connect({
  config: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' },
  sessionConfig: { type: 'realtime', model: 'gpt-realtime-2.1' },
});
assert.equal(microphoneCalls.length, 1, 'Realtime must acquire audio through the permission recovery service');
assert.equal(microphoneCalls[0].mediaDevices, mediaDevices);
assert.deepEqual(microphoneCalls[0].constraints, {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
});
assert.equal(client.localStream, stream);
assert.equal(calls.length, 1);
assert.equal(calls[0].command, 'openai_realtime_create_call');
assert.equal(calls[0].args.sdp, 'v=0\r\no=fake-offer\r\n');
assert.equal(JSON.parse(calls[0].args.sessionJson).model, 'gpt-realtime-2.1');
assert.match(calls[0].args.requestId, /^openai_realtime_/);
assert.equal(FakePeerConnection.instance.remoteDescription.type, 'answer');
assert.equal(audioElement.autoplay, true);
FakePeerConnection.instance.ontrack({ streams: [{ id: 'remote-stream' }] });
assert.equal(audioElement.srcObject.id, 'remote-stream');
assert.equal(audioElement.played, true);
assert.deepEqual(meterCalls.filter(call => call[0] === 'attach').map(call => call[1]), ['input', 'output']);
meterCallback({ input: { level: .4 } }); assert.equal(audioLevels.length, 1);

FakePeerConnection.instance.channel.emit('message', {
  data: JSON.stringify({ type: 'session.created', session: { id: 'sess_1' } }),
});
assert.equal(events[0].type, 'session.created');
FakePeerConnection.instance.channel.emit('message', { data: '{invalid-json' });
FakePeerConnection.instance.channel.emit('message', { data: JSON.stringify({ type: 'response.done' }) });
assert.deepEqual(events.map(event => event.type), ['session.created', 'response.done']);
FakePeerConnection.instance.connectionState = 'disconnected';
FakePeerConnection.instance.onconnectionstatechange();
assert.deepEqual(connectionStates, ['disconnected']);

client.sendEvent({ type: 'response.create' });
assert.equal(JSON.parse(FakePeerConnection.instance.channel.sent[0]).type, 'response.create');
assert.equal(client.setMicrophoneMuted(true), true);
assert.equal(track.enabled, false);
assert.equal(client.setOutputMuted(true), true);
assert.equal(audioElement.muted, true);
assert.deepEqual(meterCalls.slice(-2), [['mute', 'input', true], ['mute', 'output', true]]);

await client.close();
assert.equal(track.stopped, true);
assert.equal(FakePeerConnection.instance.connectionState, 'closed');
assert.equal(audioElement.srcObject, null);
assert.deepEqual(meterCalls.at(-1), ['close']);
meterCallback({ input: { level: 1 } }); assert.equal(audioLevels.length, 1);

{
  let brokerStarted;
  const brokerStartedPromise = new Promise(resolve => { brokerStarted = resolve; });
  const cancelCalls = [];
  const cancelTrack = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const cancelClient = new OpenAiRealtimeSessionClient({
    invoke: (command, args) => {
      cancelCalls.push({ command, args });
      if (command === 'openai_realtime_create_call') {
        brokerStarted();
        return new Promise(() => {});
      }
      return Promise.resolve(true);
    },
    peerConnectionClass: FakePeerConnection,
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [cancelTrack],
        getTracks: () => [cancelTrack],
      }),
    },
    createAudioElement: () => ({
      style: {},
      async play() {},
      remove() {},
      srcObject: null,
    }),
  });
  const controller = new AbortController();
  const pendingConnect = cancelClient.connect({
    config: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' },
    sessionConfig: { type: 'realtime', model: 'gpt-realtime-2.1' },
    signal: controller.signal,
  });
  await brokerStartedPromise;
  controller.abort();
  const outcome = await Promise.race([
    pendingConnect.then(() => 'connected', error => error?.name),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 100)),
  ]);
  assert.equal(outcome, 'AbortError');
  assert.equal(cancelCalls[1].command, 'http_abort_request');
  assert.equal(cancelCalls[1].args.requestId, cancelCalls[0].args.requestId);
  assert.equal(cancelTrack.stopped, true);
}

console.log('openai realtime session client tests passed');
