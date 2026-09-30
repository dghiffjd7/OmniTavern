import assert from 'node:assert/strict';
import { buildOpenAiLiveSessionConfig } from '../../src/scripts/ui/realtime/openai-live-config.js';
import { resolveMaidLiveControl } from '../../src/scripts/ui/realtime/realtime-maid-tools.js';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';

// Preserve the punctuation from the actual service transcript, rather than the input recording script.
const correction = '哦,对。我刚才说得不清楚。是两个人用同一台电脑玩';
for (const input of [correction, '哦，对我刚才说得不清楚，是两个人用同一台电脑玩', '哦对，我刚才说得不清楚，是两个人用同一台电脑玩', '我刚才没说清楚，其实是两个人共用一台电脑', '喔，對。我剛才說錯了。應該是同一台電腦',
  'Oh right, I was unclear. I meant two people on the same computer', 'I misspoke, it should be one computer']) {
  assert.deepEqual(resolveMaidLiveControl(input), { action: 'revise', request: input });
}
for (const input of ['同一台吧', '便宜一点', '两个人用同一台电脑玩', '哦对，我刚才说得不清楚，是',
  '哦,对。我刚才说得不清楚。是', '哦,对。我刚才说得不清楚。是。', '哦,对。我刚才说得不清楚。是 ，。；：', '哦,对。我刚才说得不清楚。是…',
  'I was unclear', 'I was unclear about how these games work', '她说我刚才说得不清楚，是两个人']) {
  assert.equal(resolveMaidLiveControl(input).action, 'execute', `no automatic revision for ${input}`);
}
const config = buildOpenAiLiveSessionConfig({ maidTasks: true, instructions: 'Role context' });
assert.equal(config.delegation.type, 'client');
assert.match(config.instructions, /explicit corrections to unfinished work/);
assert.doesNotMatch(config.instructions, /game-search|same computer/);
assert.match(config.instructions, /progress or status also requires client delegation/);
assert.equal(buildOpenAiLiveSessionConfig({ instructions: 'Role context' }).instructions, 'Role context');

const tick = () => new Promise(resolve => setImmediate(resolve));
const target = { supported: true, sessionId: 'maid', uiMode: 'maid', maidCallId: 'correction-call' };
const fixture = () => {
  const submissions = [], cancelled = [], requests = [], sent = [], timers = new Map(), groups = [{ role: 'user', fragments: [] }];
  let sequence = 0, timerSequence = 0;
  const voice = createMaidVoiceTaskRuntime({ makeId: () => `task-${++sequence}`, captureContext: () => ({ sessionId: 'frozen-room' }),
    getCommandRuntime: () => ({
      isSubmitting: () => submissions.some(item => !item.finished),
      submitVoiceTask: (text, options) => new Promise(resolve => submissions.push({ text, options, resolve, finished: false })),
      cancelSubmission: id => {
        const submission = submissions.find(item => item.options.id === id);
        if (!submission || submission.finished) return false;
        cancelled.push(id); submission.finished = true; submission.resolve({ cancelled: true }); return true;
      },
    }),
  });
  const session = createRealtimeMaidTaskSession({ target, live: true, getClient: () => ({ sendEvent: event => sent.push(event) }),
    getLiveGroups: () => groups, handleTaskRequest: options => { requests.push(options); return voice.request(options); },
    setTimeoutFn: (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; }, clearTimeoutFn: id => timers.delete(id),
  });
  const transcript = text => {
    groups[0].fragments.push({ delta: text, startMs: 0, endMs: 500 });
    session.handle({ type: 'session.input_transcript.delta' });
  };
  const delegate = async () => {
    session.handle({ type: 'session.delegation.created', offset_ms: 500, delegation: { id: 'correction-delegation', target: 'client' } });
    for (const [id, timer] of timers) if (timer.ms === 250) { timers.delete(id); timer.fn(); }
    await tick();
  };
  const submit = request => voice.request({ target, args: { action: 'execute', request } });
  const cleanup = () => {
    session.dispose();
    submissions.forEach(item => { if (!item.finished) { item.finished = true; item.resolve({ ok: true }); } });
    assert.equal(timers.size, 0);
  };
  return { session, voice, requests, sent, submissions, cancelled, transcript, delegate, submit, cleanup };
};
{
  const env = fixture(), original = '找两款便宜的双人电脑游戏';
  const accepted = await env.submit(original);
  env.transcript(correction); await tick();
  assert.equal(env.requests.length, 0, 'transcript alone never dispatches a task');
  assert.equal(env.submissions.length, 1);
  await env.delegate();
  assert.deepEqual(env.requests.map(item => item.args.action), ['status', 'revise']);
  assert.notEqual(env.requests[0].requestId, env.requests[1].requestId, 'status lookup does not occupy revision deduplication identity');
  assert.equal(env.requests[1].args.task_id, accepted.task_id);
  assert.deepEqual(env.cancelled, [accepted.task_id]);
  assert.equal(env.submissions.length, 2);
  assert.equal(env.submissions[1].text, `${original}\n\n用户修正：${correction}`);
  assert.equal(env.submissions[1].options.context.sessionId, 'frozen-room');
  assert.equal(env.sent.at(-1).type, 'session.commentary.append', 'revision reports its actual outcome');
  env.cleanup();
}
{
  const env = fixture(); await env.submit('游戏搜索'); await env.submit('另一个任务');
  env.transcript(correction); await env.delegate();
  assert.deepEqual(env.requests.map(item => item.args.action), ['status']);
  assert.equal(env.submissions.length, 2); assert.deepEqual(env.cancelled, []);
  assert.equal(JSON.parse(env.sent.at(-1).content).ok, false);
  assert.match(JSON.parse(env.sent.at(-1).content).message, /多个进行中的任务/);
  env.cleanup();
}
{
  const env = fixture(); env.transcript(correction); await env.delegate();
  assert.equal(env.submissions.length, 0); assert.deepEqual(env.cancelled, []);
  assert.match(JSON.parse(env.sent.at(-1).content).message, /任务已经结束/);
  env.cleanup();
}
{
  const env = fixture(); await env.submit('游戏搜索');
  env.transcript('现在进度如何'); await env.delegate();
  assert.deepEqual(env.requests.map(item => item.args.action), ['status']);
  assert.equal(env.submissions.length, 1); assert.equal(env.sent.at(-1).type, 'session.commentary.append');
  env.cleanup();
}
console.log('maid live corrections: narrow language recognition, delegation boundary, explicit target selection, preserved original goal, ambiguity and status passed');
