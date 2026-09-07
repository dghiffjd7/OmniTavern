import assert from 'node:assert/strict';

import { createCreativeTurnTracker } from '../../src/scripts/ui/chat/creative-turn-tracker.js';

// 假泳道：记录调用序列与 payload，模拟 run/generationId 与任务状态。
const createFakeLane = ({ startRunReturns = 'run-1', generationId = 7, tasks = [] } = {}) => {
  const calls = [];
  const state = { run: null, tasks: tasks.map(task => ({ ...task })) };
  const setStatus = (id, status) => {
    const task = state.tasks.find(item => item.id === id);
    if (task) task.status = status;
  };
  return {
    calls,
    state,
    startRun(options) { calls.push(['startRun', options]); if (startRunReturns) state.run = { id: startRunReturns, generationId: options.generationId }; return startRunReturns; },
    finishTask(id, status, payload) { calls.push(['finishTask', id, status, payload]); setStatus(id, status); },
    activateTask(id, payload) { calls.push(['activateTask', id, payload]); setStatus(id, 'running'); },
    failTask(id, err) { calls.push(['failTask', id, String(err?.message || err)]); setStatus(id, 'failed'); },
    skipTask(id, payload) { calls.push(['skipTask', id, payload]); setStatus(id, 'skipped'); },
    markPostModelTasksRunning(summary) { calls.push(['markPostModelTasksRunning', summary]); },
    cancelRun(reason) { calls.push(['cancelRun', reason]); },
    failRun(message) { calls.push(['failRun', message]); },
    getState() { return state; },
  };
};
const noopLogger = { warn() {} };
const baseTracker = (lane, overrides = {}) => createCreativeTurnTracker({
  laneRuntime: lane,
  generationId: 7,
  sessionId: 'rp:alice',
  rpUiMode: true,
  place: 'writing',
  isMemoryAutoExtractInline: () => true,
  isMemoryAutoExtractSeparate: () => false,
  logger: noopLogger,
  ...overrides,
});

{
  const lane = createFakeLane();
  const tracker = baseTracker(lane, { rpUiMode: false });
  assert.equal(tracker.start({ title: 'x' }), false);
  tracker.modelRequested({});
  tracker.modelDone({});
  tracker.afterSendSucceeded({ imagePromptScheduled: true });
  tracker.afterSendFailed({});
  assert.deepEqual(lane.calls, [], '非创意写作模式不向泳道上报任何事件');
  console.log('ok - social mode is a no-op');
}

{
  const lane = createFakeLane();
  const tracker = baseTracker(lane);
  const input = { summary: '输入已整理', output: { textLength: 3 } };
  const context = { summary: '上下文与请求配置已就绪', detail: { sessionId: 'rp:alice' } };
  const model = { summary: '等待流式模型响应', detail: { provider: 'openai' } };
  assert.equal(tracker.start({ title: '创意写作流程', text: 'abc', input, context, model }), true);
  assert.equal(tracker.isActive(), true);
  assert.deepEqual(lane.calls, [
    ['startRun', { sessionId: 'rp:alice', generationId: 7, title: '创意写作流程', text: 'abc', executionPlan: { memoryPhase: 'sync', variablePhase: 'sync' } }],
    ['finishTask', 'input', 'succeeded', input],
    ['finishTask', 'context', 'succeeded', context],
    ['activateTask', 'model', model],
  ]);
  lane.calls.length = 0;
  tracker.modelRequested({ generationId: 7, stream: true, protocolEnabled: false });
  tracker.modelStreaming();
  tracker.modelDone({ checkpointTargetMessageId: 'm1', stream: true });
  assert.deepEqual(lane.calls, [
    ['activateTask', 'model', { summary: '模型请求已发送', detail: { generationId: 7, stream: true, protocolEnabled: false } }],
    ['activateTask', 'model', '正在接收流式内容'],
    ['finishTask', 'model', 'succeeded', { summary: '模型回复已生成', output: { checkpointTargetMessageId: 'm1', stream: true } }],
    ['finishTask', 'memory', 'succeeded', { summary: '记忆表已随正文同步处理' }],
  ]);
  console.log('ok - start/model sequence and inline memory phase match legacy payloads');
}

{
  const lane = createFakeLane();
  const tracker = baseTracker(lane, { isMemoryAutoExtractInline: () => false, isMemoryAutoExtractSeparate: () => true });
  tracker.start({});
  lane.calls.length = 0;
  tracker.modelBuffered();
  tracker.modelDone({ checkpointTargetMessageId: 'm2', stream: false, branch: 'protocol' });
  assert.deepEqual(lane.calls, [
    ['activateTask', 'model', '已收到完整模型回复，正在保存与解析'],
    ['finishTask', 'model', 'succeeded', { summary: '模型回复已生成', output: { checkpointTargetMessageId: 'm2', branch: 'protocol', stream: false } }],
    ['markPostModelTasksRunning', '同步记忆表与轮次快照'],
  ]);
  const laneNone = createFakeLane();
  const trackerNone = baseTracker(laneNone, { isMemoryAutoExtractInline: () => false, isMemoryAutoExtractSeparate: () => false });
  trackerNone.start({});
  laneNone.calls.length = 0;
  trackerNone.modelDone({ checkpointTargetMessageId: '', stream: true });
  assert.deepEqual(laneNone.calls[1], ['skipTask', 'memory', { summary: '本次未触发记忆表同步' }]);
  console.log('ok - buffered output shape and separate/none memory phases');
}

{
  // 泳道 run 已被新一轮覆盖（generationId 不同）时，后模型同步与变量上报都必须静默。
  const lane = createFakeLane();
  const tracker = baseTracker(lane);
  tracker.start({});
  lane.state.run = { id: 'run-2', generationId: 8 };
  lane.calls.length = 0;
  tracker.modelDone({ stream: true });
  assert.equal(lane.calls.length, 1, '只上报 model 完成，不再同步记忆任务');
  tracker.variableApplied({ changed: true, targetSessionId: 'rp:alice', messageId: 'x' });
  assert.equal(lane.calls.length, 1);
  console.log('ok - stale run guards');
}

{
  const lane = createFakeLane();
  const tracker = baseTracker(lane);
  tracker.start({});
  lane.calls.length = 0;
  tracker.variableApplied({ changed: false, targetSessionId: 'rp:alice', messageId: 'a' });
  tracker.variableApplied({ changed: true, targetSessionId: 'rp:bob', messageId: 'b' });
  assert.deepEqual(lane.calls, []);
  tracker.variableApplied({ changed: true, targetSessionId: ' rp:alice ', messageId: 'c' });
  assert.deepEqual(lane.calls, [['finishTask', 'variable', 'succeeded', { summary: '回复内变量编辑已应用', output: { messageId: 'c' } }]]);
  console.log('ok - variable applied guards (changed / session / current run)');
}

{
  // 独立记忆：activate → run → afterSuccess → finish；失败：warn → failTask → rethrow
  const lane = createFakeLane();
  const warns = [];
  const tracker = baseTracker(lane, {
    isMemoryAutoExtractInline: () => false,
    isMemoryAutoExtractSeparate: () => true,
    logger: { warn: (...args) => warns.push(args) },
  });
  tracker.start({});
  lane.calls.length = 0;
  const order = [];
  const task = tracker.runMemoryTask({
    targetSessionId: 'rp:alice',
    targetIsGroup: 0,
    run: () => { order.push('run'); return Promise.resolve({ ok: 1 }); },
    afterSuccess: async (memoryResult) => { order.push('repair'); assert.deepEqual(memoryResult, { ok: 1 }); return { repaired: true }; },
  });
  assert.deepEqual(lane.calls[0], ['activateTask', 'memory', { summary: '同步记忆表与轮次快照', detail: { targetSessionId: 'rp:alice', targetIsGroup: false } }]);
  assert.deepEqual(order, ['run'], 'activate 发生在 run 之前，afterSuccess 异步');
  const result = await task;
  assert.deepEqual(result, { repaired: true });
  assert.deepEqual(lane.calls[1], ['finishTask', 'memory', 'succeeded', { summary: '记忆表同步完成', output: { memoryResult: { ok: 1 }, repairResult: { repaired: true } } }]);

  lane.calls.length = 0;
  const failing = tracker.runMemoryTask({ targetSessionId: 'rp:alice', run: () => Promise.reject(new Error('boom')), afterSuccess: async () => null });
  await assert.rejects(failing, /boom/);
  assert.equal(warns[0][0], 'memory update before timeline auto repair failed');
  assert.deepEqual(lane.calls[1], ['failTask', 'memory', 'boom']);
  console.log('ok - separate memory task tracking and failure path');
}

{
  // inline 模式：不 activate、不 finish、不记录 memoryTask，但仍返回等价 Promise（含 afterSuccess）
  const lane = createFakeLane();
  const tracker = baseTracker(lane);
  tracker.start({});
  lane.calls.length = 0;
  const task = tracker.runMemoryTask({ run: () => 'raw', afterSuccess: async r => `${r}-repaired` });
  assert.equal(await task, 'raw-repaired');
  assert.deepEqual(lane.calls, []);
  console.log('ok - inline memory does not touch lane but still chains repair');
}

{
  // 成功收尾：image 成功/跳过；variable/profile 未终态则跳过；有 memoryTask 时等其结束再收尾
  const completes = [];
  const lane = createFakeLane({ tasks: [{ id: 'variable', status: 'queued' }, { id: 'profile', status: 'queued' }] });
  const tracker = baseTracker(lane, {
    isMemoryAutoExtractInline: () => false,
    isMemoryAutoExtractSeparate: () => true,
    completeIfIdle: () => completes.push('complete'),
  });
  tracker.start({});
  let release;
  tracker.runMemoryTask({ run: () => new Promise(resolve => { release = resolve; }), afterSuccess: async () => null });
  lane.calls.length = 0;
  tracker.afterSendSucceeded({ imagePromptScheduled: true });
  assert.deepEqual(lane.calls, [
    ['finishTask', 'image', 'succeeded', { summary: '图片提示词已进入生成队列' }],
    ['finishTask', 'variable', 'skipped', { summary: '本次未触发变量更新' }],
    ['finishTask', 'profile', 'skipped', { summary: '本次未触发画像任务' }],
  ]);
  assert.deepEqual(completes, [], '记忆任务未结束前不收尾');
  release(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(completes, ['complete']);

  const lane2 = createFakeLane({ tasks: [{ id: 'variable', status: 'succeeded' }, { id: 'profile', status: 'queued' }] });
  const completes2 = [];
  const tracker2 = baseTracker(lane2, { completeIfIdle: () => completes2.push('complete') });
  tracker2.start({});
  lane2.calls.length = 0;
  tracker2.afterSendSucceeded({ imagePromptScheduled: false });
  assert.deepEqual(lane2.calls, [
    ['finishTask', 'image', 'skipped', { summary: '本次未触发图片提示词任务' }],
    ['finishTask', 'profile', 'skipped', { summary: '本次未触发画像任务' }],
  ]);
  assert.deepEqual(completes2, ['complete'], '无记忆任务时立即收尾');
  console.log('ok - afterSendSucceeded image/variable/profile and completion chaining');
}

{
  const lane = createFakeLane();
  const tracker = baseTracker(lane);
  tracker.start({});
  lane.calls.length = 0;
  tracker.afterSendFailed({ interrupted: true, message: 'x' });
  tracker.afterSendFailed({ interrupted: false, message: '' });
  tracker.afterSendFailed({ interrupted: false, message: '网络错误' });
  assert.deepEqual(lane.calls, [['cancelRun', 'interrupted'], ['failRun', '发送失败'], ['failRun', '网络错误']]);
  const laneInactive = createFakeLane({ startRunReturns: '' });
  const trackerInactive = baseTracker(laneInactive);
  assert.equal(trackerInactive.start({}), false, 'startRun 返回空即视为未激活');
  laneInactive.calls.length = 0;
  trackerInactive.afterSendFailed({ interrupted: true });
  trackerInactive.afterSendSucceeded({ imagePromptScheduled: true });
  assert.deepEqual(laneInactive.calls, []);
  console.log('ok - afterSendFailed branches and inactive tracker');
}

{
  // generationId 在 tracker 创建后才分配：必须延迟读取，否则 startRun 记录 0 且 stale 守卫失效
  const lane = createFakeLane();
  let gen = 0;
  const tracker = createCreativeTurnTracker({ laneRuntime: lane, getGenerationId: () => gen, sessionId: 'rp:alice', rpUiMode: true, place: 'writing', isMemoryAutoExtractInline: () => true, isMemoryAutoExtractSeparate: () => false, logger: noopLogger });
  gen = 42;
  tracker.start({});
  assert.equal(lane.calls[0][1].generationId, 42);
  lane.state.run = { id: 'run-x', generationId: 43 };
  lane.calls.length = 0;
  tracker.modelDone({ stream: true });
  assert.equal(lane.calls.length, 1, 'generationId 不匹配时不同步记忆任务');
  console.log('ok - generation id is read lazily');
}

console.log('creative-turn-tracker tests passed');
