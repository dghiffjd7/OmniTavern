import assert from 'node:assert/strict';

import { createRealtimeCallRuntime } from '../../src/scripts/ui/realtime/realtime-call-runtime.js';

class FakeSessionClient {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.sent = [];
    this.closed = false;
  }
  async connect(payload) { this.connectPayload = payload; }
  sendEvent(event) { this.sent.push(event); }
  setMicrophoneMuted(value) { this.micMuted = value; return true; }
  setOutputMuted(value) { this.outputMuted = value; return true; }
  async close() { this.closed = true; }
  emit(event) { this.callbacks.onEvent(event); }
  emitConnectionState(value) { this.callbacks.onConnectionState(value); }
}

const committedUsers = [];
const committedAssistants = [];
const stateChanges = [];
const snapshotRequests = [];
let fakeClient;
let currentSessionId = 'private:musashi';
const runtime = createRealtimeCallRuntime({
  createSessionClient: callbacks => (fakeClient = new FakeSessionClient(callbacks)),
  resolveConnection: async () => ({
    config: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      sttLanguage: 'ja',
    },
    settings: {
      realtimeModel: 'gpt-realtime-2.1',
      transcriptionModel: 'gpt-4o-mini-transcribe',
      transcriptionLanguage: 'zh,en',
      voice: 'marin',
    },
  }),
  buildSemanticSnapshot: async payload => {
    snapshotRequests.push(payload);
    return { instructions: `snapshot:${payload.inputText || 'initial'}` };
  },
  getCallTarget: () => ({
    supported: true,
    sessionId: currentSessionId,
    revision: 'rev-1',
    uiMode: 'chat',
    name: '武藏',
  }),
  isTargetCurrent: target => target.sessionId === currentSessionId,
  commitUserMessage: async payload => {
    committedUsers.push(payload);
    return { messageId: `user-${committedUsers.length}` };
  },
  commitAssistantMessage: async payload => {
    committedAssistants.push(payload);
    return { messageId: `assistant-${committedAssistants.length}` };
  },
  onStateChange: state => stateChanges.push(state.status),
  setIntervalFn: () => 1,
  clearIntervalFn: () => {},
});

assert.equal(await runtime.start(), true);
assert.equal(runtime.getState().status, 'listening');
assert.equal(runtime.getState().provider, 'openai');
assert.equal(fakeClient.connectPayload.sessionConfig.instructions, 'snapshot:initial');
assert.equal(fakeClient.connectPayload.sessionConfig.audio.input.transcription.language, 'zh');
assert.equal(fakeClient.connectPayload.sessionConfig.audio.input.turn_detection.create_response, false);

fakeClient.emit({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'item_u1',
  transcript: '你好，武藏',
  usage: { input_tokens: 12 },
});
await runtime.whenIdle();
assert.equal(committedUsers.length, 1);
assert.equal(committedUsers[0].text, '你好，武藏');
assert.deepEqual(fakeClient.sent.map(event => event.type), ['session.update', 'response.create']);
assert.equal(fakeClient.sent[0].session.instructions, 'snapshot:你好，武藏');

fakeClient.emit({ type: 'response.created', response: { id: 'resp_1' } });
fakeClient.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', delta: '很高兴' });
fakeClient.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', delta: '见到你。' });
fakeClient.emit({
  type: 'response.done',
  response: { id: 'resp_1', usage: { input_tokens: 20, output_tokens: 8 } },
});
await runtime.whenIdle();
assert.equal(committedAssistants.length, 1);
assert.equal(committedAssistants[0].text, '很高兴见到你。');
assert.equal(committedAssistants[0].meta.realtimeInterrupted, false);
assert.equal(committedAssistants[0].meta.usage.output_tokens, 8);

fakeClient.emit({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'item_u_next',
  transcript: '继续说',
});
await runtime.whenIdle();
assert.deepEqual(snapshotRequests.at(-1).excludeMessageIds, ['user-1', 'assistant-1']);
assert.equal(fakeClient.sent.filter(event => event.type === 'response.create').length, 2);

fakeClient.emit({ type: 'response.created', response: { id: 'resp_2' } });
fakeClient.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp_2', delta: '这是一段被打断的回答' });
fakeClient.emit({ type: 'input_audio_buffer.speech_started' });
await runtime.whenIdle();
assert.equal(committedAssistants.length, 2);
assert.equal(committedAssistants[1].meta.realtimeInterrupted, true);
assert.equal(committedAssistants[1].meta.transcriptApproximate, true);
fakeClient.emit({
  type: 'response.done',
  response: {
    id: 'resp_2',
    output: [{ content: [{ transcript: '这是一段被打断的回答，但是迟发的完整内容不能覆盖。' }] }],
  },
});
await runtime.whenIdle();
assert.equal(committedAssistants.length, 2);

fakeClient.emit({
  type: 'conversation.item.input_audio_transcription.failed',
  item_id: 'item_u2',
  error: { message: 'transcription failed' },
});
await runtime.whenIdle();
assert.equal(fakeClient.sent.filter(event => event.type === 'response.create').length, 2);

currentSessionId = 'private:other';
fakeClient.emit({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'late_item',
  transcript: '迟发内容',
});
await runtime.whenIdle();
assert.equal(committedUsers.length, 2);

await runtime.end('test');
assert.equal(runtime.getState().status, 'idle');
assert.equal(fakeClient.closed, true);
assert.ok(stateChanges.includes('connecting'));
assert.ok(stateChanges.includes('speaking'));

let resolvePendingConnection;
let cancelledClientCreated = false;
const cancellationErrors = [];
const cancelledRuntime = createRealtimeCallRuntime({
  createSessionClient: () => {
    cancelledClientCreated = true;
    return new FakeSessionClient({});
  },
  resolveConnection: () => new Promise(resolve => { resolvePendingConnection = resolve; }),
  buildSemanticSnapshot: async () => ({ instructions: 'should-not-run' }),
  getCallTarget: () => ({ supported: true, sessionId: 'cancelled-target' }),
  isTargetCurrent: () => true,
  onError: error => cancellationErrors.push(error),
  setIntervalFn: () => 2,
  clearIntervalFn: () => {},
});
const pendingStart = cancelledRuntime.start();
assert.equal(cancelledRuntime.getState().status, 'requesting_permission');
await cancelledRuntime.end('user');
resolvePendingConnection({
  config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
  settings: { realtimeModel: 'gpt-realtime-2.1', transcriptionModel: 'gpt-4o-mini-transcribe' },
});
assert.equal(await pendingStart, false);
assert.equal(cancelledRuntime.getState().status, 'idle');
assert.equal(cancelledClientCreated, false);
assert.equal(cancellationErrors.length, 0);

{
  const assistants = [];
  const orderedUsage = [];
  let orderedClient;
  const orderedRuntime = createRealtimeCallRuntime({
    createSessionClient: callbacks => (orderedClient = new FakeSessionClient(callbacks)),
    resolveConnection: async () => ({
      config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      settings: { realtimeModel: 'gpt-realtime-2.1', transcriptionModel: 'gpt-4o-mini-transcribe' },
    }),
    buildSemanticSnapshot: async () => ({ instructions: 'ordered snapshot' }),
    getCallTarget: () => ({ supported: true, sessionId: 'ordered-target' }),
    isTargetCurrent: () => true,
    commitUserMessage: async () => ({}),
    commitAssistantMessage: async payload => {
      assistants.push(payload);
      return { messageId: `ordered-${assistants.length}` };
    },
    onUsage: event => orderedUsage.push(event),
    setIntervalFn: () => 3,
    clearIntervalFn: () => {},
  });
  assert.equal(await orderedRuntime.start(), true);
  orderedClient.emit({ type: 'response.created', response: { id: 'resp_ordered' } });
  orderedClient.emit({
    type: 'response.done',
    response: { id: 'resp_ordered', usage: { input_tokens: 4, output_tokens: 2 } },
  });
  await orderedRuntime.whenIdle();
  assert.equal(assistants.length, 0);
  assert.deepEqual(orderedUsage.map(event => event.type), ['response']);
  orderedClient.emit({
    type: 'response.output_audio_transcript.done',
    response_id: 'resp_ordered',
    transcript: '乱序仍须保存。',
  });
  await orderedRuntime.whenIdle();
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, '乱序仍须保存。');
  assert.equal(assistants[0].meta.usage.output_tokens, 2);
  orderedClient.emit({
    type: 'response.output_audio_transcript.done',
    response_id: 'resp_ordered',
    transcript: '重复 final 不得再次保存。',
  });
  await orderedRuntime.whenIdle();
  assert.equal(assistants.length, 1);
  assert.deepEqual(orderedUsage.map(event => event.type), ['response']);
  orderedClient.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'empty_transcript_usage',
    transcript: '',
    usage: { total_tokens: 9 },
  });
  await orderedRuntime.whenIdle();
  assert.deepEqual(orderedUsage.map(event => event.type), ['response', 'transcription']);
  await orderedRuntime.end('test');
}

const waitForAsyncEnd = () => new Promise(resolve => setImmediate(resolve));

{
  let clock = 1_000;
  let timeoutClient;
  const warnings = [];
  const states = [];
  const timeoutRuntime = createRealtimeCallRuntime({
    createSessionClient: callbacks => (timeoutClient = new FakeSessionClient(callbacks)),
    resolveConnection: async () => ({
      config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      settings: {
        realtimeModel: 'gpt-realtime-2.1',
        transcriptionModel: 'gpt-4o-mini-transcribe',
        idleTimeoutMinutes: 2,
      },
    }),
    buildSemanticSnapshot: async () => ({ instructions: 'timeout snapshot' }),
    getCallTarget: () => ({ supported: true, sessionId: 'timeout-target' }),
    isTargetCurrent: () => true,
    commitUserMessage: async () => ({}),
    commitAssistantMessage: async () => ({}),
    onWarning: message => warnings.push(message),
    onStateChange: state => states.push(state),
    now: () => clock,
    setIntervalFn: () => 4,
    clearIntervalFn: () => {},
  });
  assert.equal(await timeoutRuntime.start(), true);
  clock = 31_000;
  timeoutClient.emit({ type: 'response.output_audio.delta', delta: 'audio' });
  clock = 61_000;
  assert.equal(timeoutRuntime.checkTimeouts(clock), false);
  assert.equal(timeoutRuntime.checkTimeouts(clock), false);
  assert.equal(warnings.length, 0);
  clock = 91_000;
  assert.equal(timeoutRuntime.checkTimeouts(clock), false);
  assert.equal(warnings.filter(message => message.includes('1 分钟后')).length, 1);
  clock = 121_000;
  timeoutClient.emit({ type: 'session.updated', session: { id: 'timeout-session' } });
  clock = 151_000;
  assert.equal(timeoutRuntime.checkTimeouts(clock), true);
  await waitForAsyncEnd();
  assert.equal(timeoutRuntime.getState().status, 'idle');
  assert.ok(states.some(state => state.status === 'ending' && state.endReason === 'idle_timeout'));
}

{
  let clock = 10_000;
  let durationClient;
  const warnings = [];
  const states = [];
  const errors = [];
  const durationRuntime = createRealtimeCallRuntime({
    createSessionClient: callbacks => (durationClient = new FakeSessionClient(callbacks)),
    resolveConnection: async () => ({
      config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      settings: {
        realtimeModel: 'gpt-realtime-2.1',
        transcriptionModel: 'gpt-4o-mini-transcribe',
        idleTimeoutMinutes: 120,
      },
    }),
    buildSemanticSnapshot: async () => ({ instructions: 'duration snapshot' }),
    getCallTarget: () => ({ supported: true, sessionId: 'duration-target' }),
    isTargetCurrent: () => true,
    commitUserMessage: async () => ({}),
    commitAssistantMessage: async () => ({}),
    onWarning: message => warnings.push(message),
    onError: error => errors.push(error),
    onStateChange: state => states.push(state),
    now: () => clock,
    setIntervalFn: () => 5,
    clearIntervalFn: () => {},
  });
  assert.equal(await durationRuntime.start(), true);
  clock = 10_000 + 54 * 60 * 1000;
  durationClient.emit({ type: 'input_audio_buffer.speech_started' });
  await durationRuntime.whenIdle();
  clock = 10_000 + 55 * 60 * 1000;
  assert.equal(durationRuntime.checkTimeouts(clock), false);
  assert.equal(durationRuntime.checkTimeouts(clock), false);
  assert.equal(warnings.filter(message => message.includes('5 分钟内')).length, 1);
  durationClient.emitConnectionState('disconnected');
  assert.equal(durationRuntime.getState().status, 'reconnecting');
  assert.equal(errors.at(-1).code, 'connection_lost');
  clock = 10_000 + 60 * 60 * 1000;
  assert.equal(durationRuntime.checkTimeouts(clock), true);
  await waitForAsyncEnd();
  assert.equal(durationRuntime.getState().status, 'idle');
  assert.ok(states.some(state => state.status === 'ending' && state.endReason === 'duration_limit'));
}

{
  let guardClient;
  let guardSessionId = 'guard-target';
  let guardCommitImpl = async () => null;
  let guardCommitCalls = 0;
  const guardErrors = [];
  const guardRuntime = createRealtimeCallRuntime({
    createSessionClient: callbacks => (guardClient = new FakeSessionClient(callbacks)),
    resolveConnection: async () => ({
      config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      settings: { realtimeModel: 'gpt-realtime-2.1', transcriptionModel: 'gpt-4o-mini-transcribe' },
    }),
    buildSemanticSnapshot: async () => ({ instructions: 'guard snapshot' }),
    getCallTarget: () => ({ supported: true, sessionId: 'guard-target' }),
    isTargetCurrent: target => target.sessionId === guardSessionId,
    commitUserMessage: async payload => {
      guardCommitCalls += 1;
      return guardCommitImpl(payload);
    },
    commitAssistantMessage: async () => ({}),
    onError: error => guardErrors.push(error),
    setIntervalFn: () => 6,
    clearIntervalFn: () => {},
  });
  assert.equal(await guardRuntime.start(), true);

  guardClient.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'guard_null_commit',
    transcript: '提交失败不得生成',
  });
  await guardRuntime.whenIdle();
  assert.equal(guardCommitCalls, 1);
  assert.deepEqual(guardClient.sent.map(event => event.type), [], '落库失败后不得发送 session.update/response.create');
  assert.equal(guardRuntime.getState().status, 'listening', '当前通话落库失败后必须恢复 listening');
  assert.equal(guardErrors.at(-1)?.code, 'user_message_commit_failed');

  guardCommitImpl = async () => {
    guardSessionId = 'guard-switched';
    return { messageId: 'guard-u2' };
  };
  guardClient.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'guard_target_switch',
    transcript: '提交期间切会话不得生成',
  });
  await guardRuntime.whenIdle();
  assert.equal(guardCommitCalls, 2);
  assert.deepEqual(guardClient.sent.map(event => event.type), [], '提交期间 target 失效后不得发送 session.update/response.create');

  guardSessionId = 'guard-target';
  let resolvePendingCommit;
  guardCommitImpl = () => new Promise(resolve => { resolvePendingCommit = resolve; });
  guardClient.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'guard_hangup_during_commit',
    transcript: '提交期间挂断不得生成',
  });
  await waitForAsyncEnd();
  assert.equal(guardCommitCalls, 3);
  const pendingEnd = guardRuntime.end('user');
  assert.equal(guardRuntime.getState().status, 'ending');
  resolvePendingCommit({ messageId: 'guard-u3' });
  await pendingEnd;
  assert.deepEqual(guardClient.sent.map(event => event.type), [], '提交期间挂断后不得发送 session.update/response.create');
  assert.equal(guardErrors.length, 1, '挂断与 target 失效属于静默取消，不应追加落库错误');
  assert.equal(guardRuntime.getState().status, 'idle');
}

console.log('realtime call runtime tests passed');
