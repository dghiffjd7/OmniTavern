import assert from 'node:assert/strict';
import { NativeRealtimeSessionClient } from '../../src/scripts/ui/realtime/native-realtime-session-client.js';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';
import { makeRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { createMaidRealtimeTools } from '../../src/scripts/ui/realtime/realtime-maid-tools.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const exercise = async ({ status, outputStatus = status, includeOutput = true, interrupt = true, overlap = false, duplicate = false, terminalType = 'response.done' }) => {
  let callback, taskSession;
  const events = [], sent = [], requests = [];
  const audio = { context: { currentTime: 0 }, nextTime: 0, open: async () => {}, close: async () => {},
    play: () => { audio.nextTime = 5; }, clear: () => { audio.nextTime = 0; } };
  const client = new NativeRealtimeSessionClient({
    createAudio: () => audio, createChannel: handler => { callback = handler; return { id: 1 }; },
    onEvent: event => { events.push(event); taskSession?.handle(event); },
    invoke: async (command, args) => {
      if (command === 'realtime_transport_open') callback({ kind: 'open' });
      if (command === 'realtime_transport_send') for (const frame of args.messages) {
        const event = JSON.parse(frame.data); sent.push(event);
        if (event.type === 'session.update') callback({ kind: 'text', data: JSON.stringify({ type: 'session.updated' }) });
      }
    },
  });
  taskSession = createRealtimeMaidTaskSession({
    target: { supported: true, uiMode: 'maid', sessionId: 'maid', maidCallId: 'lifecycle-fixture' },
    provider: 'step_realtime', getClient: () => client,
    handleTaskRequest: async request => { requests.push(request); return { ok: true, accepted: true, task_id: 'accepted', status: 'running' }; },
  });
  try {
    await client.connect({ config: makeRealtimeProfile('step_realtime'), sessionConfig: { instructions: 'fixture', tools: createMaidRealtimeTools() } });
    const receive = event => client.protocol.receive(event);
    const call = { type: 'function_call', status: outputStatus, call_id: 'fixture-call', name: 'maid_task', arguments: '{"action":"execute","request":"Read available profile settings"}' };
    receive({ type: 'input_audio_buffer.speech_started', item_id: 'first-input' });
    receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first-input', transcript: 'Read available profile settings' });
    receive({ type: 'response.created', response: { id: 'answer' } });
    receive({ type: 'response.audio.delta', response_id: 'answer', delta: 'AAA=' });
    receive({ type: 'response.function_call_arguments.done', response_id: 'answer', call_id: call.call_id, name: call.name, arguments: call.arguments });
    await tick();
    assert.equal(requests.length, 0, 'arguments.done alone must never execute a task');
    if (overlap) {
      receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-input' });
      receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-input', transcript: 'A different question' });
      receive({ type: 'response.created', response: { id: 'new-answer' } });
      receive({ type: 'response.audio.delta', response_id: 'new-answer', delta: 'AAA=' });
    }
    const terminal = { type: terminalType, response: { id: 'answer', status, ...(includeOutput ? { output: [call] } : {}) } };
    receive(terminal);
    if (duplicate) receive(terminal);
    assert.equal(client.pendingFinals.size, terminalType === 'response.done' ? 1 : 0, 'playback final remains separate from service tool completion');
    const notExecuted = events.filter(event => event.type === 'maid.tools.not_executed');
    assert.equal(notExecuted.length, status === 'completed' ? 0 : 1, 'service cancellation is reported before local playback finishes');
    if (notExecuted.length) assert.deepEqual(notExecuted[0], { type: 'maid.tools.not_executed', response_id: 'answer', reason: status, calls: [{ id: 'fixture-call', name: 'maid_task' }] });
    if (overlap) {
      receive({ type: 'response.audio.delta', delta: 'AAA=' });
      assert.equal(events.at(-1).response_id, 'new-answer', 'old service done cannot clear the current audio response id');
      assert.equal(events.at(-1).playbackSuppressed, false);
      assert.equal(client.activeResponse, 'new-answer');
    }
    if (interrupt) receive({ type: 'input_audio_buffer.speech_started', item_id: 'second-input' });
    else {
      // Drain this exact pending playback timer without a wall-clock sleep.
      const final = client.pendingFinals.get('answer'); clearTimeout(final.timer); client.pendingFinals.delete('answer');
      audio.nextTime = 0; client.emit(final.event, true);
    }
    await tick(); await client.flush();
    if (requests.length) {
      assert.equal(requests[0].inputItemId, 'first-input', 'the completed tool keeps its originating input despite overlapping speech');
      assert.equal(requests[0].inputText, 'Read available profile settings');
    }
    assert.equal(events.filter(event => event.type === 'maid.tools.not_executed').length, notExecuted.length, 'local playback cancellation never changes a completed tool into not-executed');
    assert.equal(client.pendingToolCalls?.size || 0, 0, 'terminal server events discard cached argument fragments');
    if (overlap) assert.equal(client.activeResponse, 'new-answer', 'draining an old final does not close the current response');
    const receipts = sent.filter(event => event.item?.type === 'function_call_output');
    const replyRequests = sent.filter(event => event.type === 'response.create');
    return { status, outputStatus, includeOutput, interrupt, overlap, duplicate, terminalType, executions: requests.length, receipts: receipts.length,
      replyRequests: replyRequests.length, events: events.map(event => event.type) };
  } finally { taskSession.dispose(); await client.close(); }
};

const cases = [
  { status: 'completed', includeOutput: true, interrupt: true },
  { status: 'completed', includeOutput: false, interrupt: true },
  { status: 'cancelled', interrupt: true },
  { status: 'incomplete', interrupt: true },
  { status: 'completed', interrupt: false },
  { status: 'completed', includeOutput: false, interrupt: false, overlap: true },
  { status: 'completed', interrupt: false, overlap: true, duplicate: true },
  { status: 'cancelled', includeOutput: false, terminalType: 'response.cancelled' },
  { status: 'completed', outputStatus: 'incomplete' },
];
const results = [];
for (const scenario of cases) results.push(await exercise(scenario));
console.log(JSON.stringify(results.map(({ events, ...result }) => result)));
assert.deepEqual(results.map(result => result.executions), [1, 1, 0, 0, 1, 1, 1, 0, 0], 'service-completed tools survive playback interruption; explicit incomplete tools cannot fall back to cached arguments');
assert.deepEqual(results.map(result => result.receipts), [1, 1, 0, 0, 1, 1, 1, 0, 0], 'each executed call returns its function receipt exactly once');
assert(results.every(result => result.replyRequests === 0), 'the interrupted input does not start an acknowledgement over the next speaker');
console.log('native realtime tool lifecycle: service completion, playback interruption, cancellation and exact receipts passed');

// A local renewal deadline cannot claim that the service cancelled a tool.
{
  const events = [];
  const client = new NativeRealtimeSessionClient({ onEvent: event => events.push(event) });
  client.closed = false; client.config = { provider: 'nova_sonic' }; client.history = [];
  client.activeResponse = 'local-deadline';
  client.pendingToolCalls.set('local-deadline', new Map([['pending', { id: 'pending', name: 'maid_task' }]]));
  client.clearPlayback = () => {};
  client.renew = async () => {};
  const originalTimeout = globalThis.setTimeout;
  let deadline;
  try {
    globalThis.setTimeout = fn => { deadline = fn; return 1; };
    client.requestRenew();
    deadline();
  } finally { globalThis.setTimeout = originalTimeout; client.closed = true; }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'response.cancelled');
  assert.equal(events[0].response_id, 'local-deadline');
  assert.equal(events.some(event => event.type === 'maid.tools.not_executed'), false);
  console.log('ok - local renewal cancellation does not manufacture service tool-cancellation evidence');
}
