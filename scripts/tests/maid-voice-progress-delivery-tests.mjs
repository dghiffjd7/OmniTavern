import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMaidVoiceTaskRuntime, MAID_VOICE_PROGRESS_HINT_MS } = await import('../../src/scripts/ui/maid-voice-task-runtime.js');
const { createRealtimeMaidTaskSession } = await import('../../src/scripts/ui/realtime/realtime-maid-task-session.js');
const { maidTaskUpdateText, resolveMaidLiveControl } = await import('../../src/scripts/ui/realtime/realtime-maid-tools.js');
const { MaidConversationStore, isRepeatedMaidReceipt } = await import('../../src/scripts/storage/maid-conversation-store.js');
const { createMaidVoiceRuntime } = await import('../../src/scripts/ui/maid-voice-runtime.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const target = { uiMode: 'maid', sessionId: 'maid', maidCallId: 'call-1' };

// 可控时钟与计时器
const makeClock = () => {
  let at = 1000, nextId = 0;
  const timers = new Map();
  return {
    now: () => at,
    setTimeoutFn: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, due: at + ms }); return id; },
    clearTimeoutFn: id => timers.delete(id),
    advance: (ms) => {
      at += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= at) { timers.delete(id); timer.fn(); }
    },
    pending: () => timers.size,
  };
};

const makeTasks = ({ clock, queued = false } = {}) => {
  const progress = [], submissions = [];
  const runtime = createMaidVoiceTaskRuntime({
    makeId: () => `task-${submissions.length + 1}`,
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    onProgress: update => progress.push(update),
    getCommandRuntime: () => ({
      isSubmitting: () => queued,
      submitVoiceTask: (request, options) => { const done = deferred(); submissions.push({ request, options, done }); return done.promise; },
    }),
  });
  return { runtime, progress, submissions };
};
const trace = (taskId, steps, extra = {}) => ({ submissionId: taskId, runId: `run-${taskId}`, updatedAt: Date.now(), status: 'running', steps, ...extra });

{
  // D：status 带最近 3 条步骤（标题＋操作对象）；进度提示在实际执行约 20 秒后、有步骤时最多一次
  const clock = makeClock();
  const { runtime, progress, submissions } = makeTasks({ clock });
  const accepted = await runtime.request({ target, args: { action: 'execute', request: '查台北天气并整理成表' } });
  await tick();
  runtime.updateTaskFromTrace(trace(accepted.task_id, [
    { id: 's1', title: '打开页面', toolName: 'app.open', status: 'succeeded' },
    { id: 's2', title: '搜索', toolName: 'web.search', args: { query: '台北 天气' }, status: 'succeeded' },
    { id: 's3', title: '读取第 1 个结果', toolName: 'web.fetch', status: 'succeeded' },
    { id: 's4', title: '整理表格', toolName: 'table.write', status: 'running' },
  ]));
  const status = await runtime.request({ target, args: { action: 'status' } });
  assert.deepEqual(status.active[0].steps, [
    { label: '搜索：台北 天气', status: 'succeeded' },
    { label: '读取第 1 个结果', status: 'succeeded' },
    { label: '整理表格', status: 'running' },
  ]);
  assert.equal(progress.length, 0, 'no hint before the task has run for a while');
  clock.advance(MAID_VOICE_PROGRESS_HINT_MS);
  assert.equal(progress.length, 1);
  assert.deepEqual([progress[0].kind, progress[0].task_id, progress[0].steps.length, progress[0].isCurrent()], ['progress', accepted.task_id, 3, true]);
  runtime.updateTaskFromTrace(trace(accepted.task_id, [{ id: 's5', title: '检查', status: 'running' }], { updatedAt: Date.now() + 1 }));
  clock.advance(MAID_VOICE_PROGRESS_HINT_MS);
  assert.equal(progress.length, 1, 'at most one automatic progress hint per task');
  submissions[0].done.resolve({ ok: true, message: '整理好了' });
  await tick(); await tick();
  assert.equal(progress[0].isCurrent(), false, 'a finished task invalidates its queued progress hint');
  console.log('ok - status carries recent step labels and long tasks get at most one progress hint');
}

{
  // 步骤没有标题时用工具说明当标签：只给工具名时，语音模型会把「搜索某功能」说成「某功能已经做完」
  const clock = makeClock();
  const runtime = createMaidVoiceTaskRuntime({
    makeId: () => 'task-x', now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    describeTool: name => ({ 'app.search_feature': 'Search APP features' })[name] || '',
    getCommandRuntime: () => ({ isSubmitting: () => false, submitVoiceTask: () => new Promise(() => {}) }),
  });
  const accepted = await runtime.request({ target, args: { action: 'execute', request: '让记忆管家检查一遍' } });
  await tick();
  runtime.updateTaskFromTrace(trace(accepted.task_id, [
    { id: 's1', title: '', toolName: 'app.search_feature', args: { query: '记忆管家 提示词管家' }, status: 'succeeded' },
    { id: 's2', title: '', toolName: 'maid.unknown_tool', status: 'running' },
  ]));
  const status = await runtime.request({ target, args: { action: 'status' } });
  assert.deepEqual(status.active[0].steps.map(step => step.label), ['Search APP features：记忆管家 提示词管家', 'maid.unknown_tool']);
  console.log('ok - untitled steps are labelled with the tool description');
}

{
  // 排队时间不算执行；没有步骤不报；结束后清掉计时器
  const clock = makeClock();
  const { runtime, progress, submissions } = makeTasks({ clock, queued: true });
  const accepted = await runtime.request({ target, args: { action: 'execute', request: '排队的任务' } });
  await tick();
  assert.equal(accepted.status, 'queued');
  clock.advance(MAID_VOICE_PROGRESS_HINT_MS * 2);
  assert.equal(clock.pending(), 0, 'no timer while queued');
  submissions[0].options.onStatus('正在处理', 'progress');
  clock.advance(MAID_VOICE_PROGRESS_HINT_MS);
  assert.equal(progress.length, 0, 'no steps yet, so nothing to report');
  runtime.updateTaskFromTrace(trace(accepted.task_id, [{ id: 's1', title: '搜索', status: 'running' }]));
  assert.equal(progress.length, 1, 'the first step after the threshold triggers the one hint');
  submissions[0].done.resolve({ ok: true, message: 'done' });
  await tick(); await tick();
  assert.equal(clock.pending(), 0);
  console.log('ok - queue time is not execution time, and no steps means no progress hint');
}

{
  // E：结果版本与送达状态；重拨后可查询之前通话的任务
  const clock = makeClock();
  const { runtime, submissions } = makeTasks({ clock });
  const accepted = await runtime.request({ target, args: { action: 'execute', request: '掷骰子' } });
  await tick();
  submissions[0].done.resolve({ ok: true, message: '掷出了 7' });
  await tick(); await tick();
  let latest = runtime.getState('call-1').latest;
  assert.deepEqual([latest.result_version, latest.delivery], [1, 'pending']);
  runtime.setDelivery({ task_id: accepted.task_id, result_version: 1, state: 'interrupted' });
  runtime.setDelivery({ task_id: accepted.task_id, result_version: 2, state: 'spoken' });
  latest = runtime.getState('call-1').latest;
  assert.equal(latest.delivery, 'interrupted', 'a state for another result version is ignored');

  const redial = { ...target, maidCallId: 'call-2' };
  const overview = await runtime.request({ target: redial, args: { action: 'status' } });
  assert.deepEqual([overview.latest, overview.earlier_calls.map(task => task.task_id)], [null, [accepted.task_id]]);
  const looked = await runtime.request({ target: redial, args: { action: 'status', task_id: accepted.task_id } });
  assert.deepEqual([looked.from_earlier_call, looked.task.message, looked.task.status], [true, '掷出了 7', 'succeeded']);
  const cancel = await runtime.request({ target: redial, args: { action: 'cancel', task_id: accepted.task_id } });
  assert.equal(cancel.ok, false, 'an earlier call task can be queried, not controlled');
  console.log('ok - results carry a version and delivery state, and earlier call tasks can be queried after redialing');
}

const makeSession = ({ provider = 'openai', live = false } = {}) => {
  const sent = [], deliveries = [];
  const session = createRealtimeMaidTaskSession({
    target, provider, live,
    getClient: () => ({ sendEvent: event => sent.push(event), sendTaskUpdate: text => sent.push({ type: 'task_update', text }), requestResponse() {} }),
    handleTaskRequest: async () => ({ ok: true }),
    onDelivery: delivery => deliveries.push(delivery.state),
  });
  return { session, sent, deliveries };
};
const systemTexts = sent => sent.filter(event => event.type === 'conversation.item.create').map(event => event.item.content[0].text);

{
  // E：同一结果版本只安排一次播报；送达状态按真实回放区分
  const { session, sent, deliveries } = makeSession();
  const result = { target, task_id: 't1', result_version: 1, status: 'succeeded', message: '掷出了 7' };
  assert.equal(session.notifyTaskUpdate(result), true);
  assert.equal(session.notifyTaskUpdate({ ...result }), false, 'the same version is not scheduled twice');
  assert.equal(systemTexts(sent).length, 1);
  session.handle({ type: 'response.created', response: { id: 'r1' } });
  session.handle({ type: 'response.output_audio.delta', response_id: 'r1', delta: 'AAA' });
  session.handle({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
  assert.deepEqual(deliveries, ['sent', 'speaking', 'spoken']);

  session.notifyTaskUpdate({ ...result, task_id: 't2' });
  session.handle({ type: 'response.created', response: { id: 'r2' } });
  session.handle({ type: 'response.output_audio.delta', response_id: 'r2', delta: 'AAA' });
  session.handle({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  session.handle({ type: 'response.cancelled', response: { id: 'r2' } });
  assert.deepEqual(deliveries.slice(3), ['sent', 'speaking', 'interrupted']);
  session.handle({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  assert.equal(session.notifyTaskUpdate({ ...result, task_id: 't2' }), false, 'an interrupted result is not replayed automatically');

  session.notifyTaskUpdate({ ...result, task_id: 't3' });
  session.handle({ type: 'response.created', response: { id: 'r3' } });
  session.handle({ type: 'response.done', response: { id: 'r3', status: 'completed', output: [] } });
  assert.equal(deliveries.at(-1), 'unconfirmed', 'a reply without audio is not counted as heard');
  session.dispose();
  console.log('ok - results are scheduled once per version and delivery reflects actual playback');
}

{
  // D：进度提示等没人说话时才发，发前复核任务未结束；进度不算结果、不去重
  const { session, sent } = makeSession();
  let current = true;
  session.handle({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  session.notifyTaskUpdate({ target, kind: 'progress', task_id: 't1', request: '查天气', steps: [{ label: '搜索：台北 天气', status: 'running' }], isCurrent: () => current });
  assert.equal(systemTexts(sent).length, 0, 'not while the user is speaking');
  current = false;
  session.handle({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  session.handle({ type: 'output_audio_buffer.stopped' });
  assert.equal(systemTexts(sent).length, 0, 'a task that ended meanwhile drops its progress hint');
  assert.equal(sent.filter(event => event.type === 'response.create').length, 0, 'and no reply is requested for it');

  session.notifyTaskUpdate({ target, kind: 'progress', task_id: 't2', request: '研究', steps: [{ label: '读取第 1 个结果', status: 'running' }], isCurrent: () => true });
  const [text] = systemTexts(sent);
  assert.match(text, /maid_task_progress/);
  assert.match(text, /读取第 1 个结果/);
  assert.match(text, /Do not say it is finished/);
  // 步骤是最近做过的动作，不是请求里已完成的部分
  assert.match(text, /not parts of the request that are done/);
  session.dispose();

  const liveSession = makeSession({ live: true });
  liveSession.session.notifyTaskUpdate({ target, kind: 'progress', task_id: 't3', steps: [{ label: '搜索', status: 'running' }], isCurrent: () => true });
  assert.match(liveSession.sent[0].content, /APP task progress/);
  assert.match(liveSession.sent[0].content, /not parts of the request that are done/);
  liveSession.session.dispose();
  console.log('ok - progress hints wait for silence and are dropped once the task ends');
}

{
  // F：重复提示只附在下一次本来就要发的更新上，只附一次
  const { session, sent } = makeSession();
  session.noteRepetition();
  assert.equal(systemTexts(sent).length, 0, 'noting a repetition never asks the model to speak');
  session.notifyTaskUpdate({ target, task_id: 't1', result_version: 1, status: 'succeeded', message: 'ok' });
  session.handle({ type: 'response.created', response: { id: 'r1' } });
  session.handle({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
  session.notifyTaskUpdate({ target, task_id: 't2', result_version: 1, status: 'succeeded', message: 'ok' });
  const texts = systemTexts(sent);
  assert.match(texts[0], /repeated earlier wording/);
  assert.doesNotMatch(texts[1], /repeated earlier wording/);
  session.dispose();
  console.log('ok - a repetition note rides on the next update once');
}

{
  // F：自动接单／状态复述的相似度标记与计数；不吞有新内容的话、用户主动查询的状态
  assert.equal(isRepeatedMaidReceipt('好的，我已经交给女仆处理了。', '好的，已经交给女仆处理了'), true);
  assert.equal(isRepeatedMaidReceipt('好的，交给女仆了', '好的，交给女仆了，你想要哪种颜色？'), false, 'added content is not a repeat');
  assert.equal(isRepeatedMaidReceipt('好', '好'), true);
  assert.equal(isRepeatedMaidReceipt('好的', '行的'), false);

  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {} });
  await store.load();
  const ack = { maidTranscriptKind: 'ack', maidTranscriptAutomatic: true, maidTranscriptContentOnly: false };
  const first = await store.upsertRealtimeTranscript({ id: 'a1', callId: 'call-1', role: 'assistant', text: '好的，这就去帮你查台北的天气', meta: ack });
  const second = await store.upsertRealtimeTranscript({ id: 'a2', callId: 'call-1', role: 'assistant', text: '好的，这就去帮你查台北天气', meta: ack });
  assert.equal(first.repeated, undefined);
  assert.equal(second.repeated, true);
  const again = await store.upsertRealtimeTranscript({ id: 'a2', callId: 'call-1', role: 'assistant', text: '好的，这就去帮你查台北天气', meta: ack });
  assert.equal(again.repeated, undefined, 'a revision of the same caption is counted once');
  const asked = await store.upsertRealtimeTranscript({ id: 'a3', callId: 'call-1', role: 'assistant', text: '好的，这就去帮你查台北天气', meta: { ...ack, maidTranscriptKind: 'status', maidTranscriptAutomatic: false } });
  assert.equal(asked.repeated, undefined, 'a status the user asked for is never treated as a repeat');
  const otherCall = await store.upsertRealtimeTranscript({ id: 'b1', callId: 'call-2', role: 'assistant', text: '好的，这就去帮你查台北天气', meta: ack });
  assert.equal(otherCall.repeated, undefined, 'a new call starts fresh');

  const turns = store.exportState().turns;
  assert.equal(turns.find(turn => turn.id === 'a2').context.maidTranscriptRepeat, true, 'the caption is kept and marked');
  const projected = store.getContextSnapshot({ context: { uiMode: 'maid' } });
  const text = JSON.stringify(projected);
  assert.ok(text.includes('这就去帮你查台北的天气'), 'the first receipt stays in the history');
  assert.equal((text.match(/这就去帮你查台北天气/g) || []).length, 2, 'the repeat is left out; the asked-for status and the other call remain');
  console.log('ok - repeated automatic receipts are marked, counted once and left out of later history');
}

{
  // E：逐轮上下文只在状态变化或用户问进度时附完整任务状态
  assert.equal(resolveMaidLiveControl('好了吗').action, 'status');
  const states = [];
  const voice = createMaidVoiceRuntime({
    settingsStore: { getVoiceInputMode: () => 'realtime', getMaidPrompt: () => '' },
    conversationStore: { finalizeRealtimeConversation: async () => {} },
    prepareConversationContext: async () => ({}),
    getAppContext: () => ({}),
    getCommandRuntime: () => ({ submitVoiceTask: () => new Promise(() => {}), isSubmitting: () => false }),
    getCallAppRuntime: () => ({ runtime: { notifyTaskUpdate() {} } }),
    createOrb: () => ({ setTasks() {}, setApproval() {} }),
    makeId: () => `id-${states.length}`,
  });
  const callTarget = voice.getTarget();
  await voice.beforeRealtimeStart(callTarget);
  const build = async inputText => (await voice.buildSemanticSnapshot({ target: callTarget, inputText })).instructions;
  states.push(await build('你好'));
  states.push(await build('今天天气不错'));
  await voice.handleTaskRequest({ target: callTarget, requestId: 'r1', args: { action: 'execute', request: '查天气' } });
  states.push(await build('嗯'));
  states.push(await build('好了吗'));
  assert.match(states[0], /Current maid task state/);
  assert.match(states[1], /unchanged since the previous turn/);
  assert.match(states[2], /Current maid task state[\s\S]*查天气/, 'a change brings the full state back');
  assert.match(states[3], /Current maid task state/, 'asking about progress brings the full state');
  console.log('ok - per-turn context attaches the full task state only on change or when asked');
}

console.log('maid-voice-progress-delivery-tests passed');
