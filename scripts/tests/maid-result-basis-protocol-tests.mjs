import assert from 'node:assert/strict';
import { buildMaidResultBasis } from '../../src/scripts/agent/maid-result-basis.js';
import { formatMaidTaskUpdate, maidTaskUpdateText } from '../../src/scripts/ui/realtime/realtime-maid-tools.js';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';

const target = { maidCallId: 'basis-protocol' };
const basis = buildMaidResultBasis({ responseType: 'react', steps: [{ toolName: 'web.search', status: 'succeeded', output: {
  sources: Array.from({ length: 8 }, (_, i) => ({ title: 'Source', url: `https://example.test/${i}/` + 'x'.repeat(100) })),
} }] }, { recordedAt: 1000 });
const update = { target, task_id: 'task', status: 'succeeded', message: 'Result', resultBasis: basis };
const parsed = JSON.parse(formatMaidTaskUpdate(update));
assert.equal(parsed.resultBasis.kind, 'tool_execution');
assert.equal(parsed.resultBasis.recordedAt, 1000);
assert.equal(parsed.resultBasis.sources.length, 3);
assert.match(maidTaskUpdateText(update), /not independently verified facts/);
assert.equal(JSON.parse(formatMaidTaskUpdate({ status: 'succeeded' })).resultBasis, null);
assert.equal(JSON.parse(formatMaidTaskUpdate({ resultBasis: buildMaidResultBasis({ responseType: 'chat' }) })).resultBasis.kind, 'explanation');

const sent = [], timers = [];
const request = 'Long "quoted" request '.repeat(30);
const session = createRealtimeMaidTaskSession({ target, live: true,
  getClient: () => ({ sendEvent: event => sent.push(event) }),
  getLiveGroups: () => [{ role: 'user', fragments: [{ delta: request, startMs: 0, endMs: 100 }] }],
  handleTaskRequest: () => ({ ok: true, accepted: true, status: 'running', task_id: 'task-' + 'a'.repeat(80), request }),
  setTimeoutFn: fn => { timers.push(fn); return timers.length; }, clearTimeoutFn() {},
});
session.handle({ type: 'session.delegation.created', delegation: { id: 'delegation', target: 'client' }, offset_ms: 100 });
timers[0]();
await new Promise(resolve => setImmediate(resolve));
const receipt = JSON.parse(sent[0].content);
assert.equal(sent[0].type, 'session.thinking.append');
assert.equal(receipt.request.length, 160);
assert.equal(receipt.request_truncated, true);
assert.equal(receipt.task_id.length, 85);
session.notifyTaskUpdate(update);
const resultEvent = sent.at(-1);
assert.ok(resultEvent.content.length > 420, 'the meaningful result deliberately exceeds the old mid-JSON limit');
const liveResult = JSON.parse(resultEvent.content.slice(resultEvent.content.indexOf('{')));
assert.deepEqual(liveResult.resultBasis, parsed.resultBasis);
assert.equal(liveResult.message, update.message);
session.notifyTaskUpdate({ target, kind: 'confirmation', message: 'Allow this operation?' });
assert.match(sent.at(-1).content, /permission request/);
session.dispose();
console.log('result basis protocol: bounded complete JSON, recorded evidence, neutral acceptance and permission feedback passed');
