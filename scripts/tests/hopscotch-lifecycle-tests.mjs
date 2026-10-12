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
const savedTableTurn = async ({ mode = 'inline', request, memoryResult = { status: 'succeeded' }, bodyStatus = 'succeeded', policy = {}, changeBoard = () => {}, storageMode = 'table', placeEnabled = true, postGate = null } = {}) => {
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
      custom: { backgroundChat: async () => { events.push('post'); if (postGate) await postGate; return 'note'; } },
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
  // 维护在后台：后续行照跑、整轮照常收尾（发送键解锁），不再卡在「正文生成」。
  const result = await turn.turnPromise;
  assert.equal(events.filter(e => e === 'compaction').length, 1, '保存默认板不能丢失表格内部摘要维护');
  assert.equal(events.includes('post'), true, '后续行不等待后台维护');
  assert.equal(runtime.isSessionBusy('rp:table'), false, '整轮收尾后会话不再忙碌');
  const host = mode === 'inline' ? 'body' : 'memory';
  assert.ok(laneUpdates.some(([id, status]) => id === host && status === 'succeeded'), '宿主交付后泳道立即显示完成');
  const firstDone = laneUpdates.findIndex(([id, status]) => id === host && status === 'succeeded');
  assert.ok(!laneUpdates.slice(firstDone).some(([id, status]) => id === host && status === 'running'), '宿主完成后泳道不能再变回执行中');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.bodyDelivered, true);
  assert.equal(result.houses[host].status, 'succeeded');
  assert.equal(turn.getHouseStates().find(h => h.id === host).childResults[0].status, 'running');
  if (mode === 'separate') assert.deepEqual(events, ['memory', 'repair', 'compaction', 'post']);
  finish(false);
  await turn.maintenancePromise;
  assert.equal(turn.getHouseStates().find(h => h.id === host).childResults[0].reason, 'threshold_not_reached');
}
console.log('ok - saved inline/separate defaults run table maintenance in the background without holding later rows or the turn');

for (const onHouseFailure of ['continue', 'stop_following_rows']) {
  const { turn } = await savedTableTurn({ policy: { onHouseFailure }, request: async () => { throw new Error('maintenance failed'); } });
  const result = await turn.turnPromise;
  await turn.maintenancePromise;
  assert.equal(result.bodyDelivered, true, '维护失败不能抹掉正文交付');
  assert.equal(result.artifacts.body.messageId, 'delivered');
  assert.equal(result.houses.body.status, 'succeeded');
  // 失败时机取决于后台请求，整轮只可能是完成或部分失败，绝不能因维护而失败或取消。
  assert.ok(['succeeded', 'partial'].includes(result.status), result.status);
  const body = turn.getHouseStates().find(h => h.id === 'body');
  assert.equal(body.childResults[0].status, 'failed');
}
console.log('ok - internal maintenance failure is recorded on the host and never erases the delivered body');

{
  const { turn } = await savedTableTurn({ request: async () => ({ status: 'cancelled', reason: 'request_aborted' }) });
  const result = await turn.turnPromise;
  await turn.maintenancePromise;
  assert.equal(result.bodyDelivered, true);
  assert.equal(turn.getHouseStates().find(h => h.id === 'body').childResults[0].status, 'cancelled');
}

{
  let lateResolve, requestSignal;
  const { turn, runtime } = await savedTableTurn({ request: (_, { signal }) => {
    requestSignal = signal;
    return new Promise(resolve => { lateResolve = resolve; });
  } });
  const result = await turn.turnPromise;
  assert.equal(result.bodyDelivered, true);
  assert.equal(runtime.isSessionBusy('rp:table'), false);
  turn.abort();
  await turn.maintenancePromise;
  const child = turn.getHouseStates().find(h => h.id === 'body').childResults[0];
  assert.equal(child.status, 'cancelled');
  assert.equal(child.reason, 'user_cancelled');
  assert.equal(requestSignal.aborted, true, '整轮收尾后仍可停止后台维护');
  assert.equal(turn.getHouseStates().find(h => h.id === 'body').status, 'succeeded');
  lateResolve({ status: 'succeeded', artifact: { text: 'late' } });
  await tick();
  assert.equal(turn.getHouseStates().find(h => h.id === 'body').childResults[0].status, child.status);
}
console.log('ok - background maintenance stays cancellable after the turn and rejects late results');

{
  let requestSignal;
  const { turn, runtime } = await savedTableTurn({ request: (_, { signal }) => {
    requestSignal = signal;
    return new Promise(() => {});
  } });
  await turn.turnPromise;
  runtime.clearScope();
  await turn.maintenancePromise;
  assert.equal(requestSignal.aborted, true, '切换作用域必须取消仍在后台的维护');
}
console.log('ok - scope change cancels background maintenance');

{
  // 停止发生在正文之后的行时，后台维护一并取消
  let requestSignal, releasePost;
  const { turn } = await savedTableTurn({
    request: (_, { signal }) => { requestSignal = signal; return new Promise(() => {}); },
    changeBoard: board => {
      board.rows.at(-1).houses[0].config.prompt = 'post';
    },
    postGate: new Promise(resolve => { releasePost = resolve; }),
  });
  await tick();
  turn.abort();
  releasePost?.();
  const result = await turn.turnPromise;
  await turn.maintenancePromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.bodyDelivered, true);
  assert.equal(requestSignal.aborted, true);
}
console.log('ok - stopping the turn while later rows run also cancels background maintenance');

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
  await turn.maintenancePromise;
  assert.equal(result.bodyDelivered, true);
  assert.equal(turn.getHouseStates().find(h => h.id === 'body').childResults[0].status, cancel ? 'cancelled' : 'succeeded');
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
