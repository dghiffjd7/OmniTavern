import assert from 'node:assert/strict';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';
import { createJsonRealtimeProtocol } from '../../src/scripts/ui/realtime/realtime-json-protocol.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const sent = [], executed = [];
let session;
const protocol = createJsonRealtimeProtocol({ profile: { provider: 'step_realtime' }, instructions: '',
  send: event => sent.push(event), emit: event => session.handle(event), ready() {}, play() {}, clear() {} });
session = createRealtimeMaidTaskSession({ provider: 'step_realtime', target: { uiMode: 'maid', maidCallId: 'test-call' },
  getClient: () => ({ sendTaskUpdate: text => protocol.taskUpdate(text), sendToolResults: results => protocol.toolResults(results), requestResponse: () => protocol.respond() }),
  handleTaskRequest: options => { executed.push(options); return { ok: true, accepted: true, task_id: 'actual-task', status: 'running' }; },
});
const interrupted = (id, reason = 'incomplete', name = 'maid_task') => ({ type: 'maid.tools.not_executed', response_id: 'interrupted-response', reason, calls: [{ id, name }] });
const updates = () => sent.filter(e => e.item?.type === 'message');
const outputs = () => sent.filter(e => e.item?.type === 'function_call_output');

protocol.receive({ type: 'response.created', response: { id: 'interrupted-response' } });
protocol.receive({ type: 'response.function_call_arguments.done', response_id: 'interrupted-response', call_id: 'abandoned', name: 'maid_task', arguments: '{"action":"execute","request":"Inspect avatar settings"}' });
session.handle(interrupted('abandoned'));
protocol.receive({ type: 'response.done', response: { id: 'interrupted-response', status: 'incomplete' } });
await tick();
assert.equal(updates().length, 1, 'an interrupted known maid call supplies one factual not-executed update');
assert.equal(updates()[0].item.role, 'user', 'Step receives its supported message role');
const notice = updates()[0].item.content[0].text;
assert.match(notice, /not executed/);
assert.match(notice, /abandoned/);
assert.match(notice, /latest complete request/);
assert.equal(executed.length, 0, 'interrupted work is never dispatched');
assert.equal(outputs().length, 0, 'an incomplete call receives no fabricated function result');
assert.equal(sent.filter(e => e.type === 'response.create').length, 0, 'status injection does not request a response');

session.handle(interrupted('abandoned'));
session.handle(interrupted('abandoned', 'cancelled'));
session.handle(interrupted('other', 'incomplete', 'unrelated_tool'));
session.handle(interrupted('unknown-reason', 'completed'));
assert.equal(updates().length, 1, 'duplicate, foreign and invalid status notices are ignored');

protocol.receive({ type: 'input_audio_buffer.speech_started', item_id: 'followup' });
protocol.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'followup', transcript: 'Only tell me how; change nothing.' });
protocol.receive({ type: 'response.created', response: { id: 'fresh-response' } });
protocol.receive({ type: 'response.audio.delta', response_id: 'fresh-response', delta: 'audio' });
protocol.receive({ type: 'response.done', response: { id: 'fresh-response', status: 'completed', output: [
  { type: 'function_call', status: 'completed', call_id: 'fresh', name: 'maid_task', arguments: '{"action":"execute","request":"Inspect avatar settings; change nothing"}' },
] } });
await tick();
assert.equal(executed.length, 1, 'only a new complete model call can start the work');
assert.match(executed[0].args.request, /change nothing/);
assert.equal(outputs().length, 1);
assert.equal(outputs()[0].item.call_id, 'fresh');
assert.equal(JSON.parse(outputs()[0].item.output).task_id, 'actual-task');
session.handle(interrupted('fresh'));
assert.equal(updates().length, 1, 'a delayed cancellation cannot report dispatched work as unexecuted');

// A final response can contain an explicitly incomplete function item. Its
// earlier argument buffer must not override the authoritative item status.
protocol.receive({ type: 'response.created', response: { id: 'partial-output' } });
protocol.receive({ type: 'response.function_call_arguments.done', response_id: 'partial-output', call_id: 'partial', name: 'maid_task', arguments: '{"action":"execute","request":"Must not run"}' });
protocol.receive({ type: 'response.done', response: { id: 'partial-output', status: 'completed', output: [
  { type: 'function_call', status: 'incomplete', call_id: 'partial', name: 'maid_task', arguments: '{"action":"execute","request":"Must not run"}' },
] } });
await tick();
assert.equal(executed.length, 1, 'explicitly incomplete function output cannot revive its cached arguments');
assert.equal(outputs().length, 1);

session.dispose();
session.handle(interrupted('after-close'));
assert.equal(updates().length, 1);
console.log('maid interrupted calls: factual state, Step wire role, deduplication, no execution/response, fresh constrained retry and close passed');
