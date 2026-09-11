import assert from 'node:assert/strict';
import { createHopscotchBoardStore } from '../../src/scripts/storage/hopscotch-board-store.js';
import { createHopscotchTurnRuntime, createHopscotchExecutors, trimHouseInputToBudget, buildHousePromptBlock } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createLlmContextBuilder } from '../../src/scripts/ui/chat/llm-context-runtime-utils.js';
import { normalizePromptInjectionBlock } from '../../src/scripts/ui/chat/prompt-injection-runtime-utils.js';
import { createSessionAsyncWorkRuntime } from '../../src/scripts/ui/chat/session-async-work-runtime-utils.js';
import { estimateTokens } from '../../src/scripts/memory/memory-prompt-utils.js';
import { createSessionSummaryCompactionRuntime } from '../../src/scripts/ui/chat/summary-compaction-runtime-utils.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cache = new Map();
const store = createHopscotchBoardStore({ storage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) } });
await store.setGlobalBoard({ rows: [
  { id: 'a', houses: [
    { id: 'first', kind: 'custom_prompt', config: { prompt: 'first', includeContext: 'none', output: { mode: 'context', injectIntoBody: true } } },
    { id: 'second', kind: 'custom_prompt', config: { prompt: 'second', includeContext: 'none', output: { mode: 'context', injectIntoBody: true } } },
  ] }, { id: 'b', houses: [{ id: 'body', kind: 'body' }] },
] });
let firstResolve;
const work = createSessionAsyncWorkRuntime();
const runtime = createHopscotchTurnRuntime({
  getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, sessionAsyncWorkRuntime: work,
  createExecutors: info => createHopscotchExecutors({ ...info, custom: { backgroundChat: messages => messages[0].content === 'first' ? new Promise(resolve => { firstResolve = resolve; }) : Promise.resolve('second') } }),
});
const turn = runtime.prepareTurn({ sessionId: 'a', rpUiMode: true });
await tick();
firstResolve('first');
await turn.waitForBodyStart();
assert.deepEqual(turn.getPromptBlocks().map(block => block.houseId), ['first', 'second']);
assert.equal(work.count('a'), 1);
const cancelled = await work.cancelAndWait('a', { timeoutMs: 100 });
assert.equal(cancelled.ok, true);
assert.equal((await turn.turnPromise).status, 'cancelled');
assert.equal(runtime.isSessionBusy('a'), false);
assert.equal(runtime.getLatestTurn('a'), turn);
runtime.clearScope();
assert.equal(runtime.getLatestTurn('a'), null);
console.log('ok - stable injection order, session deletion lease and scope record isolation');

await store.setScope('other');
assert.equal(store.getGlobalBoard(), null);
await store.setScope('');
assert.ok(store.getGlobalBoard());
console.log('ok - board default follows persona scope switching');

{
  const original = store.getGlobalBoard();
  let storageMode = 'table';
  const scoped = createHopscotchTurnRuntime({
    boardStore: store,
    resolveWritingSettings: () => ({ memory: { storageMode, autoExtract: true, autoExtractMode: 'inline' }, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'profile' } }),
  });
  assert.equal(scoped.resolveBoard('chat', { place: 'chat' }).source, 'derived');
  assert.deepEqual(scoped.resolveBoard('chat', { place: 'chat' }).board.rows.map(r => r.houses.map(h => h.kind)), [['body'], ['format_review']], '聊天只读设置投影不加载创意写作全局编排');
  storageMode = 'summary';
  const summary = scoped.resolveBoard('chat', { place: 'chat' }).board;
  assert.equal(summary.rows.flatMap(r => r.houses).some(h => h.kind === 'summary_compaction'), true);
  assert.deepEqual(scoped.resolveBoard('rp:test').board, original, '设置变化不重写已保存编排');
  assert.deepEqual(store.getGlobalBoard(), original);
  let reviews = 0;
  const scopedExecutors = createHopscotchExecutors({ getTurnContext: () => ({ body: { messageId: 'm' } }), formatReview: { place: 'writing', run: () => { reviews++; return { status: 'succeeded' }; } } });
  assert.equal((await scopedExecutors.format_review.run({ signal: new AbortController().signal })).status, 'succeeded');
  assert.equal(reviews, 1, '创意写作格式修复委托专用运行时检查格式要求和模型可用性');
  console.log('ok - chat projection is isolated, saved boards remain intact and writing review is delegated');
}

const history = [{ role: 'user', content: 'before' }];
const captured = [];
const executors = createHopscotchExecutors({
  getTurnContext: () => ({ body: { messageId: 'body' } }),
  custom: { getRecentMessages: () => history, getBodyText: () => 'SECRET_BODY', backgroundChat: async (messages, options) => { captured.push(messages); options.onProviderUsage({ totalTokens: 7 }); return 'note'; } },
});
history.push({ role: 'assistant', content: 'SECRET_BODY' });
const customResult = await executors.custom_prompt.run({ house: { id: 'c', config: { prompt: '{{body}} task', includeContext: 'recent', output: { mode: 'note' } } }, rowInput: { bodyDelivered: false, artifacts: {} }, signal: new AbortController().signal });
assert.ok(!JSON.stringify(captured).includes('SECRET_BODY'));
assert.equal(customResult.usage.providerUsage.totalTokens, 7);
assert.ok(estimateTokens(trimHouseInputToBudget('故事'.repeat(500), 100), 'rough') <= 100);
console.log('ok - same-row history/body isolation, provider usage and bounded inputs');

{
  const block = buildHousePromptBlock({ house: { id: 'analysis', label: 'analysis' }, artifact: { text: '{{setvar::probe::wrong}} {{char}}' } });
  const normalized = normalizePromptInjectionBlock(block);
  const build = createLlmContextBuilder({ sessionId: 'rp:test', getInjectedPromptBlocks: () => [normalized], getHopscotchFused: () => ['image_prompt'] });
  const context = build('input');
  assert.equal(context.meta.extraPromptBlocks[0].preRendered, true, '模型产物进入真实上下文拼装后仍禁止二次宏展开');
  assert.equal(context.meta.extraPromptBlocks[0].houseId, 'analysis');
  assert.ok(context.meta.extraPromptBlocks[0].content.includes('{{setvar::probe::wrong}}'));
  assert.deepEqual(context.meta.hopscotchFused, ['image_prompt']);
  console.log('ok - main context pipeline preserves house provenance, literal macros and turn-local fusion');
}

let finishRequest;
let writes = 0;
const ac = new AbortController();
const compact = createSessionSummaryCompactionRuntime({
  getIsSummaryMemoryEnabled: () => true, buildMessages: () => [], backgroundChat: async () => '',
  createAdapter: async () => ({ getItems: async () => ['a'], persist: async () => { writes++; }, setRaw: async () => { writes++; } }),
  shouldCompact: () => true, requestCompactionRaw: async ({ options }) => { assert.equal(options.signal, ac.signal); return new Promise(resolve => { finishRequest = resolve; }); },
  parseCompactionResult: () => ({ text: 'summary', valid: true }), delayMs: 0,
});
const pending = compact('a', { signal: ac.signal, detailed: true });
await tick(); await tick(); ac.abort(); finishRequest('late summary');
assert.equal((await pending).status, 'cancelled');
assert.equal(writes, 0);
console.log('ok - compaction waits actual completion and rejects late persistence after abort');

{
  let reads = 0, requests = 0;
  const request = createSessionSummaryCompactionRuntime({
    getIsCompactionEnabled: () => true, buildMessages: () => [], backgroundChat: async () => '',
    // 正文期间模式已改成 summary：会回退到摘要存储，表格维护不能跟过去。
    createAdapter: async () => null,
    chatStore: { getSummaries: () => { reads++; return ['a']; }, setCompactedSummary: () => {} },
    shouldCompact: () => true, requestCompactionRaw: async () => { requests++; return ''; }, delayMs: 0,
  });
  const result = await request('rp:table', { place: 'writing', detailed: true, expectedAdapterKind: 'memory_table' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'adapter_changed');
  assert.equal(reads, 0); assert.equal(requests, 0);
  console.log('ok - table maintenance cannot switch to summary storage during a turn');
}

// 保存新默认板后，表格维护仍受行屏障/取消/超时管理，不需要可见的摘要房子。
const savedTableTurn = async ({ mode = 'inline', request, memoryResult = { status: 'succeeded' }, bodyStatus = 'succeeded', policy = {}, changeBoard = () => {}, storageMode = 'table', placeEnabled = true } = {}) => {
  const cache = new Map();
  const boardStore = createHopscotchBoardStore({ storage: { getItem: k => cache.get(k), setItem: (k, v) => cache.set(k, v) } });
  const events = [];
  const laneUpdates = [];
  let laneRun;
  let effectiveMode = 'table';
  let effectivePlaceEnabled = true;
  const runtime = createHopscotchTurnRuntime({
    boardStore, getSettings: () => ({ creativeHopscotchEnabled: true }),
    resolveWritingSettings: () => ({ memory: { storageMode: effectiveMode, autoExtract: true, autoExtractMode: mode, placeEnabled: effectivePlaceEnabled } }),
    laneRuntime: {
      startRun: info => { laneRun = { id: info.runId }; return true; }, getState: () => ({ run: laneRun }),
      activateTask: id => laneUpdates.push([id, 'running']),
      finishTask: (id, status) => laneUpdates.push([id, status]),
      failTask: (id, error, patch) => laneUpdates.push([id, 'failed', patch]),
    },
    createExecutors: info => createHopscotchExecutors({
      ...info,
      memory: {
        runMemoryUpdateAfterChat: async () => { events.push('memory'); return memoryResult; },
        runTimelineRepair: async () => { events.push('repair'); },
      },
      compaction: { place: 'writing', request: async (sid, options) => { events.push('compaction'); return request ? request(sid, options) : false; } },
      custom: { backgroundChat: async () => { events.push('post'); return 'note'; } },
    }),
    logger: { warn() {} },
  });
  const board = runtime.resolveBoard('rp:table').board;
  assert.ok(!board.rows.flatMap(r => r.houses).some(h => h.kind === 'summary_compaction'));
  board.policy = { ...board.policy, ...policy };
  board.rows.push({ id: 'last', houses: [{ id: 'post', kind: 'custom_prompt', config: { prompt: 'post', includeContext: 'none' } }] });
  changeBoard(board);
  await boardStore.setGlobalBoard(board);
  effectiveMode = storageMode;
  effectivePlaceEnabled = placeEnabled;
  const turn = runtime.prepareTurn({ sessionId: 'rp:table', rpUiMode: true });
  await turn.waitForBodyStart();
  turn.setBodyContext({ buildMemoryContext: () => ({}) });
  turn.resolveBody({ status: bodyStatus, messageId: 'delivered' });
  return { turn, runtime, events, laneUpdates };
};

for (const mode of ['inline', 'separate']) {
  let finish;
  const { turn, runtime, events, laneUpdates } = await savedTableTurn({ mode, request: (sid, { signal, detailed, place, expectedAdapterKind }) => {
    assert.equal(sid, 'rp:table'); assert.equal(place, 'writing'); assert.equal(detailed, true); assert.ok(signal);
    assert.equal(expectedAdapterKind, 'memory_table');
    return new Promise(resolve => { finish = resolve; });
  } });
  await tick();
  assert.equal(events.filter(e => e === 'compaction').length, 1, '保存默认板不能丢失表格内部摘要维护');
  assert.equal(events.includes('post'), false, '后续行必须等待维护结束');
  assert.equal(runtime.isSessionBusy('rp:table'), true);
  const host = mode === 'inline' ? 'body' : 'memory';
  assert.ok(!laneUpdates.some(([id, status]) => id === host && status === 'succeeded'), '维护完成前泳道不能提前完成');
  assert.equal(turn.getHouseStates().find(h => h.id === host).childResults[0].status, 'running');
  finish(false);
  const result = await turn.turnPromise;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.bodyDelivered, true);
  assert.equal(result.houses[host].childResults[0].reason, 'threshold_not_reached');
  assert.equal(result.houses[host].status, 'succeeded');
  assert.equal(events.at(-1), 'post');
  if (mode === 'separate') assert.deepEqual(events, ['memory', 'repair', 'compaction', 'post']);
  assert.equal(runtime.isSessionBusy('rp:table'), false);
}
console.log('ok - saved inline/separate defaults retain tracked table maintenance and row barrier');

for (const onHouseFailure of ['continue', 'stop_following_rows']) {
  const { turn } = await savedTableTurn({ policy: { onHouseFailure }, request: async () => { throw new Error('maintenance failed'); } });
  const result = await turn.turnPromise;
  assert.equal(result.status, 'partial');
  assert.equal(result.bodyDelivered, true, '维护失败不能抹掉正文交付');
  assert.equal(result.artifacts.body.messageId, 'delivered');
  assert.equal(result.houses.body.status, 'succeeded');
  assert.equal(result.houses.body.childResults[0].status, 'failed');
  assert.equal(result.houses.post.status, onHouseFailure === 'continue' ? 'succeeded' : 'skipped');
}
console.log('ok - internal maintenance failure is partial, preserves body and obeys failure policy');

{
  const { turn } = await savedTableTurn({ request: async () => ({ status: 'cancelled', reason: 'request_aborted' }) });
  const result = await turn.turnPromise;
  assert.equal(result.status, 'partial', '子请求自行取消，未停止整轮，也不能报告全部完成');
  assert.equal(result.houses.body.childResults[0].status, 'cancelled');
  assert.equal(result.bodyDelivered, true);
}

for (const cancel of [true, false]) {
  let lateResolve, requestSignal;
  const { turn, runtime } = await savedTableTurn({ policy: { houseTimeoutMs: 50 }, request: (_, { signal }) => {
    requestSignal = signal;
    return new Promise(resolve => { lateResolve = resolve; });
  } });
  await tick();
  if (cancel) turn.abort();
  const result = await turn.turnPromise;
  assert.equal(result.status, cancel ? 'cancelled' : 'partial');
  assert.equal(result.bodyDelivered, true);
  assert.equal(result.houses.body.status, 'succeeded');
  const child = result.houses.body.childResults[0];
  assert.equal(child.status, cancel ? 'cancelled' : 'failed');
  assert.equal(child.reason, cancel ? 'user_cancelled' : 'timeout');
  assert.equal(requestSignal.aborted, true);
  assert.equal(runtime.isSessionBusy('rp:table'), false);
  lateResolve({ status: 'succeeded', artifact: { text: 'late' } });
  await tick();
  assert.equal(turn.getHouseStates().find(h => h.id === 'body').childResults[0].status, child.status);
}
console.log('ok - maintenance cancellation/timeout preserves body and rejects late results');

for (const options of [
  { changeBoard: board => { delete board.policy.tableSummaryMaintenance; } },
  { changeBoard: board => { board.rows[0].houses[0].fused = []; } },
  { storageMode: 'off' },
  { storageMode: 'summary' },
  { placeEnabled: false },
  { bodyStatus: 'failed' },
  { bodyStatus: 'cancelled' },
  { mode: 'separate', memoryResult: { skipped: true, reason: 'cadence' } },
  { mode: 'separate', memoryResult: { status: 'failed', reason: 'memory_failed' } },
]) {
  const { turn, events } = await savedTableTurn(options);
  await turn.turnPromise;
  assert.equal(events.includes('compaction'), false, '旧板/移除表格/模式关闭/未写表不能偷偷增加请求');
}
{
  const { turn, events } = await savedTableTurn({ changeBoard: board => {
    board.rows.push({ id: 'explicit', houses: [{ id: 'compact', kind: 'summary_compaction' }] });
  } });
  const result = await turn.turnPromise;
  assert.equal(events.filter(e => e === 'compaction').length, 1);
  assert.deepEqual(result.houses.body.childResults, []);
}
console.log('ok - legacy/disabled boards remain unchanged; explicit compaction is never duplicated');

for (const cancel of [false, true]) {
  let finish, requestCompletion, writes = 0, started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const compact = createSessionSummaryCompactionRuntime({
    getIsCompactionEnabled: () => true, buildMessages: () => [], backgroundChat: async () => '',
    createAdapter: async () => ({ kind: 'memory_table', getItems: () => ['a', 'b', 'c'], setRaw: () => { writes++; }, persist: () => { writes++; } }),
    shouldCompact: () => true, parseCompactionResult: () => ({ text: 'summary', valid: true }), delayMs: 0,
    requestCompactionRaw: () => { started(); return new Promise(resolve => { finish = resolve; }); },
  });
  const { turn } = await savedTableTurn({ request: (sid, options) => (requestCompletion = compact(sid, options)) });
  await requestStarted;
  if (cancel) turn.abort();
  finish('summary');
  await requestCompletion;
  const result = await turn.turnPromise;
  assert.equal(result.status, cancel ? 'cancelled' : 'succeeded');
  assert.equal(result.bodyDelivered, true);
  assert.equal(writes, cancel ? 0 : 2, '真实压缩运行时只允许未取消的表格维护提交');
}
console.log('ok - saved-default maintenance reaches compaction persistence and blocks aborted writes');

{
  let bodyAborts = 0;
  const ac = new AbortController();
  const executors = createHopscotchExecutors({ abortBody: () => { bodyAborts++; } });
  const body = executors.body.run({ signal: ac.signal });
  ac.abort();
  assert.equal((await body).status, 'cancelled');
  assert.equal(bodyAborts, 1, '板停止需要透传到正文发送请求');
  const postAc = new AbortController();
  const done = createHopscotchExecutors({ abortBody: () => { bodyAborts++; } });
  const completedBody = done.body.run({ signal: postAc.signal });
  done.__body.resolve({ status: 'succeeded' });
  await completedBody;
  postAc.abort();
  assert.equal(bodyAborts, 1, '正文已完成后移除监听器，不误取消其他主请求');
  console.log('ok - body cancellation reaches generation, post-body cleanup does not cancel another request');
}
