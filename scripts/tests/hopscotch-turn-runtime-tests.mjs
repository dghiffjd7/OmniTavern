import assert from 'node:assert/strict';

import {
  buildHousePromptBlock,
  buildRecentContextText,
  createHopscotchExecutors,
  createHopscotchTurnRuntime,
  renderCustomHousePrompt,
} from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createHopscotchBoardStore } from '../../src/scripts/storage/hopscotch-board-store.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
const fakeLane = () => {
  const calls = [];
  const state = { run: null, tasks: [] };
  return {
    calls, state,
    startRun(o) { calls.push(['startRun', { lanes: o.lanes?.map(l => l.id), tasks: o.tasks?.map(t => t.id), memoryPhase: o.executionPlan?.memoryPhase }]); state.run = { generationId: o.generationId }; state.tasks = (o.tasks || []).map(t => ({ ...t, status: 'queued' })); return 'run-1'; },
    finishTask(id, status, p) { calls.push(['finishTask', id, status]); },
    activateTask(id) { calls.push(['activateTask', id]); },
    failTask(id, err) { calls.push(['failTask', id, String(err)]); },
    completeRun() { calls.push(['completeRun']); },
    failRun(m) { calls.push(['failRun', m]); },
    cancelRun(r) { calls.push(['cancelRun', r]); },
    getState() { return state; },
  };
};
const userBoard = () => ({ rows: [
  { id: 'r1', houses: [{ id: 'h_analysis', kind: 'custom_prompt', label: '分析', config: { prompt: '要点：{{user_input}}', includeContext: 'none', output: { mode: 'context', injectIntoBody: true } } }] },
  { id: 'r2', houses: [{ id: 'body', kind: 'body', fused: ['image_prompt'] }] },
  { id: 'r3', houses: [{ id: 'image', kind: 'image_generation' }, { id: 'review', kind: 'format_review' }, { id: 'memory', kind: 'memory_table' }] },
  { id: 'r4', houses: [{ id: 'compaction', kind: 'summary_compaction' }, { id: 'h_edit', kind: 'custom_prompt', label: '编修', config: { prompt: '建议：{{body}} / {{house:h_analysis}}', includeContext: 'none', output: { mode: 'note' } } }] },
] });
const writingSettings = () => ({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'inline' }, replyCheck: { enabled: false }, autoImage: { enabled: false }, variables: { enabled: false } });

const makeDeps = (overrides = {}) => {
  const log = [];
  const deps = {
    memory: {
      runMemoryUpdateAfterChat: async (sid, group, ctx, options) => { log.push(['memory', options.forceSeparate, options.checkpointMessageId]); return { ok: true }; },
      runTimelineRepair: async () => { log.push(['repair']); return { repaired: 1 }; },
      abortMemoryUpdate: () => log.push(['abortMemory']),
    },
    compaction: { request: async () => { log.push(['compaction']); return false; }, place: 'writing' },
    formatReview: { run: async ({ messageId }) => { log.push(['review', messageId]); return { status: 'succeeded', artifact: { kind: 'format_review' } }; } },
    image: { run: async ({ messageId }) => { log.push(['image', messageId]); return { status: 'succeeded' }; } },
    custom: {
      backgroundChat: async (messages) => { log.push(['chat', messages[messages.length - 1].content]); return `A:${messages.length}`; },
      getRuntimeConfigByProfileId: async id => (id === 'p1' ? { provider: 'openai', model: 'm' } : null),
      getRecentMessages: () => [{ role: 'user', content: 'hi' }],
      getBodyText: () => 'BODY',
      charName: 'Alice', userName: 'Me',
    },
    ...overrides,
  };
  return { deps, log };
};

{
  assert.equal(renderCustomHousePrompt('{{user_input}}|{{body}}|{{house:a}}|{{house:none}}|{{char}}|{{user}}', { userInput: 'U', bodyText: 'B', artifacts: { a: { text: 'AA' } }, charName: 'C', userName: 'Me' }), 'U|B|AA||C|Me');
  assert.equal(renderCustomHousePrompt('{{ house:b }}', { artifacts: { b: 'plain' } }), 'plain');
  assert.equal(renderCustomHousePrompt('{{user_input}} / {{house:a}}', {
    userInput: '{{body}} {{char}}', bodyText: 'SECRET', charName: 'CHAR',
    artifacts: { a: { text: '{{user}} {{house:b}}' }, b: { text: 'OTHER' } }, userName: 'USER',
  }), '{{body}} {{char}} / {{user}} {{house:b}}', '插入的用户与模型文本不得被后续替换再次解释为宏');
  const ctx = buildRecentContextText([{ role: 'system', content: 'x' }, { role: 'user', name: 'Me', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }], { maxCount: 2, charBudget: 1000 });
  assert.equal(ctx, 'assistant: two\nuser: three');
  const tight = buildRecentContextText([{ role: 'user', content: 'aaaaaaaaaa' }, { role: 'user', content: 'bbbbb' }], { maxCount: 5, charBudget: 12 });
  assert.equal(tight, 'user: bbbbb', '预算不够时优先保留最近一条');
  const block = buildHousePromptBlock({ house: { id: 'h', label: '分析' }, artifact: { text: 'T' }, order: 2 });
  assert.equal(block.position, 'before_latest_user');
  assert.equal(block.source, 'hopscotch_house');
  assert.ok(block.content.endsWith('\nT'));
  assert.equal(buildHousePromptBlock({ house: { id: 'h' }, artifact: { text: '  ' } }), null);
  console.log('ok - custom prompt macros, recent context budget, prompt block shape');
}

{
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p' });
  const lane = fakeLane();
  const runtime = createHopscotchTurnRuntime({ getSettings: () => ({ creativeHopscotchEnabled: false }), boardStore: store, resolveWritingSettings: writingSettings, laneRuntime: lane });
  assert.equal(runtime.prepareTurn({ sessionId: 'rp:a', rpUiMode: true }), null, '开关关闭');
  const on = createHopscotchTurnRuntime({ getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, resolveWritingSettings: writingSettings, laneRuntime: lane });
  assert.equal(on.prepareTurn({ sessionId: 'rp:a', rpUiMode: true }), null, '无用户板（推导默认板）走既有流程');
  assert.equal(on.resolveBoard('rp:a').source, 'derived');
  await store.setGlobalBoard(userBoard());
  assert.equal(on.prepareTurn({ sessionId: 'c:a', rpUiMode: false }), null, '社交聊天不接管');
  assert.equal(on.prepareTurn({ sessionId: 'rp:a', rpUiMode: true, previewOnly: true }), null, '预览不接管');
  assert.equal(lane.calls.length, 0);
  console.log('ok - board mode gating');
}

{
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p' });
  await store.setGlobalBoard(userBoard());
  const lane = fakeLane();
  const { deps, log } = makeDeps();
  const runtime = createHopscotchTurnRuntime({
    getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, resolveWritingSettings: writingSettings, laneRuntime: lane,
    createExecutors: info => createHopscotchExecutors({ ...info, ...deps, logger: { warn() {} } }),
  });
  const turn = runtime.prepareTurn({ sessionId: 'rp:a', rpUiMode: true, text: '写雨夜', generationId: 3, title: 'T' });
  assert.ok(turn);
  assert.equal(runtime.isSessionBusy('rp:a'), true);
  assert.equal(turn.memoryInline, false);
  assert.deepEqual(lane.calls[0], ['startRun', { lanes: ['request', 'context', 'h_analysis', 'body', 'image', 'review', 'memory', 'compaction', 'h_edit'], tasks: ['input', 'context', 'h_analysis', 'body', 'image', 'review', 'memory', 'compaction', 'h_edit'], memoryPhase: 'async' }]);
  const start = await turn.waitForBodyStart();
  assert.equal(start.proceed, true);
  assert.deepEqual(log[0], ['chat', '要点：写雨夜'], '前置房子在正文前完成');
  const blocks = turn.getPromptBlocks();
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].content.includes('A:1'), '前置产物注入正文提示块');
  assert.ok(lane.calls.some(c => c[0] === 'activateTask' && c[1] === 'body'), '正文房子在泳道上 running');
  turn.setBodyContext({ buildMemoryContext: () => ({ meta: {} }), checkpointMessageId: 'm9' });
  turn.resolveBody({ status: 'succeeded', messageId: 'm9' });
  const result = await turn.turnPromise;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.houses.compaction.status, 'skipped');
  assert.equal(result.houses.compaction.reason, 'threshold_not_reached');
  assert.equal(result.houses.h_edit.status, 'succeeded');
  assert.ok(log.some(e => e[0] === 'memory' && e[1] === true && e[2] === 'm9'), '独立记忆房子以 forceSeparate 调用并带 checkpoint');
  assert.ok(log.some(e => e[0] === 'review' && e[1] === 'm9'));
  assert.ok(log.some(e => e[0] === 'image' && e[1] === 'm9'));
  const editCall = log.find(e => e[0] === 'chat' && String(e[1]).startsWith('建议：'));
  assert.equal(editCall[1], '建议：BODY / A:1', '后置房子读到正文与前置产物');
  assert.deepEqual(lane.calls[lane.calls.length - 1], ['completeRun']);
  assert.equal(runtime.isSessionBusy('rp:a'), false);
  assert.equal(turn.getPromptBlocks().length, 1, '后置产物不进正文提示块');
  console.log('ok - full turn: pre row → body deferral → post rows with real executor deps');
}

{
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p' });
  await store.setGlobalBoard(userBoard());
  const lane = fakeLane();
  const { deps, log } = makeDeps();
  const runtime = createHopscotchTurnRuntime({ getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, resolveWritingSettings: writingSettings, laneRuntime: lane, createExecutors: info => createHopscotchExecutors({ ...info, ...deps, logger: { warn() {} } }) });
  const turn = runtime.prepareTurn({ sessionId: 'rp:a', rpUiMode: true, text: 'x', generationId: 4 });
  await turn.waitForBodyStart();
  turn.resolveBody({ status: 'failed', error: 'provider 500' });
  const result = await turn.turnPromise;
  assert.equal(result.status, 'failed');
  assert.equal(result.houses.image.status, 'skipped');
  assert.equal(result.houses.memory.reason, 'body_not_succeeded');
  assert.ok(!log.some(e => e[0] === 'memory'), '正文失败不写记忆');
  assert.deepEqual(lane.calls[lane.calls.length - 1], ['failRun', '正文未完成']);
  console.log('ok - body failure skips post rows and fails the lane run');
}

{
  // 取消：前置行进行中中止 → 正文不启动，waitForBodyStart 返回 proceed:false，泳道 cancelRun
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p' });
  await store.setGlobalBoard(userBoard());
  const lane = fakeLane();
  const { deps } = makeDeps({ custom: { backgroundChat: (messages, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), getRecentMessages: () => [], getBodyText: () => '', charName: '', userName: '' } });
  const runtime = createHopscotchTurnRuntime({ getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, resolveWritingSettings: writingSettings, laneRuntime: lane, createExecutors: info => createHopscotchExecutors({ ...info, ...deps, logger: { warn() {} } }) });
  const turn = runtime.prepareTurn({ sessionId: 'rp:a', rpUiMode: true, text: 'x', generationId: 5 });
  await tick();
  assert.equal(runtime.abortSessionTurn('rp:a', 'user'), true);
  const start = await turn.waitForBodyStart();
  assert.equal(start.proceed, false);
  const result = await turn.turnPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.houses.body.status, 'cancelled');
  assert.deepEqual(lane.calls[lane.calls.length - 1], ['cancelRun', 'interrupted']);
  assert.equal(runtime.isSessionBusy('rp:a'), false);
  console.log('ok - abort before body: body never starts, lane cancelled');
}

{
  // 执行器细节：记忆按频率跳过；profile 模型档缺失；空响应；中止后 abortMemoryUpdate
  const ctxHolder = { body: { buildMemoryContext: () => ({}), checkpointMessageId: 'm1', messageId: 'm1' } };
  const { deps, log } = makeDeps({
    memory: { runMemoryUpdateAfterChat: async () => ({ skipped: true, reason: 'cadence' }), runTimelineRepair: async () => null, abortMemoryUpdate: () => log.push(['abortMemory']) },
    custom: { backgroundChat: async () => '   ', getRuntimeConfigByProfileId: async () => null, getRecentMessages: () => [], getBodyText: () => '', charName: '', userName: '' },
  });
  const ex = createHopscotchExecutors({ sessionId: 'rp:a', getTurnContext: () => ctxHolder, ...deps, logger: { warn() {} } });
  const mem = await ex.memory_table.run({ signal: new AbortController().signal });
  assert.equal(mem.status, 'skipped');
  assert.equal(mem.reason, 'cadence');
  const ac = new AbortController();
  const { deps: d2, log: l2 } = makeDeps();
  const ex2 = createHopscotchExecutors({ sessionId: 'rp:a', getTurnContext: () => ctxHolder, ...d2, logger: { warn() {} } });
  const p = ex2.memory_table.run({ signal: ac.signal });
  ac.abort();
  await p;
  assert.ok(l2.some(e => e[0] === 'abortMemory'), '中止时透传到记忆运行时');
  const empty = await ex.custom_prompt.run({ house: { id: 'c', config: { prompt: 'x', includeContext: 'none' } }, rowInput: { artifacts: {} }, signal: new AbortController().signal });
  assert.equal(empty.status, 'failed');
  assert.equal(empty.reason, 'empty_response');
  const missing = await ex.custom_prompt.run({ house: { id: 'c', config: { prompt: 'x', includeContext: 'none', modelMode: 'profile', modelProfileId: 'nope' } }, rowInput: { artifacts: {} }, signal: new AbortController().signal });
  assert.equal(missing.reason, 'model_profile_missing');
  const blank = await ex.custom_prompt.run({ house: { id: 'c', config: { prompt: '{{house:none}}', includeContext: 'none' } }, rowInput: { artifacts: {} }, signal: new AbortController().signal });
  assert.equal(blank.reason, 'empty_prompt');
  const noBody = await ex.format_review.run({ signal: new AbortController().signal });
  assert.equal(noBody.status, 'succeeded', '有 body 上下文时执行复核');
  ctxHolder.body = null;
  assert.equal((await ex.format_review.run({ signal: new AbortController().signal })).reason, 'body_message_missing');
  assert.equal((await ex.image_generation.run({ signal: new AbortController().signal })).reason, 'body_message_missing');
  assert.equal((await ex.memory_table.run({ signal: new AbortController().signal })).reason, 'body_context_missing');
  console.log('ok - executor edge cases');
}

{
  // 记忆表格总开关/写作位置关闭时，即使板融合了记忆也不内联注入；历史快照按板内最大需求截取
  const store = createHopscotchBoardStore({ storage: memoryStorage(), scopeId: 'p' });
  await store.setGlobalBoard({ rows: [
    { id: 'r1', houses: [{ id: 'h_a', kind: 'custom_prompt', label: 'a', config: { prompt: 'x', includeContext: 'recent', recentMessageCount: 3, output: { mode: 'context' } } }] },
    { id: 'r2', houses: [{ id: 'body', kind: 'body', fused: ['memory_table'] }] },
  ] });
  const lane = fakeLane();
  const requested = [];
  const { deps } = makeDeps({ custom: { backgroundChat: async () => 'ok', getRuntimeConfigByProfileId: async () => null, getRecentMessages: (sid, count) => { requested.push(count); return []; }, getBodyText: () => '', charName: '', userName: '' } });
  const disabled = createHopscotchTurnRuntime({
    getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, laneRuntime: lane,
    resolveWritingSettings: () => ({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'inline', placeEnabled: false }, replyCheck: { enabled: false }, autoImage: { enabled: false }, variables: { enabled: false } }),
    createExecutors: info => createHopscotchExecutors({ ...info, ...deps, logger: { warn() {} } }),
  });
  const turn = disabled.prepareTurn({ sessionId: 'rp:a', rpUiMode: true, text: 'x', generationId: 9 });
  assert.equal(turn.fused.includes('memory_table'), false, '停用项不进入本轮有效融合项');
  assert.equal(turn.board.rows[1].houses[0].fused.includes('memory_table'), true, '原始布局仍保留记忆融合格');
  assert.equal(turn.memoryInline, false, '写作位置关闭时不内联注入记忆提示');
  assert.deepEqual(requested, [3], '历史快照只按板内 recentMessageCount 上限读取');
  turn.abort('test');
  await turn.turnPromise;
  const enabled = createHopscotchTurnRuntime({
    getSettings: () => ({ creativeHopscotchEnabled: true }), boardStore: store, laneRuntime: fakeLane(),
    resolveWritingSettings: () => ({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'inline', placeEnabled: true }, replyCheck: { enabled: false }, autoImage: { enabled: false }, variables: { enabled: false } }),
    createExecutors: info => createHopscotchExecutors({ ...info, ...deps, logger: { warn() {} } }),
  });
  const turn2 = enabled.prepareTurn({ sessionId: 'rp:b', rpUiMode: true, text: 'x', generationId: 10 });
  assert.equal(turn2.memoryInline, true);
  turn2.abort('test');
  await turn2.turnPromise;
  console.log('ok - memory inline respects table memory master switch; history snapshot bounded by board');
}

console.log('hopscotch-turn-runtime tests passed');
