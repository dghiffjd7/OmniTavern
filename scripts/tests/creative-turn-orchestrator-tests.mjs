import assert from 'node:assert/strict';

import { createCreativeTurnOrchestrator } from '../../src/scripts/ui/chat/creative-turn-orchestrator.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const custom = (id, config = {}) => ({ id, kind: 'custom_prompt', label: id, config });
const body = (fused = []) => ({ id: 'body', kind: 'body', fused });
const ok = (artifact) => ({ status: 'succeeded', artifact });
const makeExec = (fn) => ({ run: fn });

{
  // 行屏障 + 同行并发 + 同行隔离快照 + 下游按行序合并
  const events = [];
  let active = 0, maxActive = 0;
  const exec = makeExec(async ({ house, rowInput }) => {
    active += 1; maxActive = Math.max(maxActive, active);
    events.push(`start:${house.id}:${Object.keys(rowInput.artifacts).sort().join('+') || '-'}`);
    await wait(house.id === 'a' ? 20 : 5);
    active -= 1;
    events.push(`end:${house.id}`);
    return ok(`art_${house.id}`);
  });
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [
      { id: 'r1', houses: [custom('a'), custom('b')] },
      { id: 'r2', houses: [body(['memory_table'])] },
      { id: 'r3', houses: [{ id: 'rev', kind: 'format_review' }, custom('c')] },
    ], policy: { rowConcurrencyMax: 2 } },
    executors: { custom_prompt: exec, body: exec, format_review: exec },
  });
  const result = await orch.runTurn({});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.bodyDelivered, true);
  assert.equal(maxActive, 2);
  // 第二行必须等 a、b 都结束；第三行只看到 a、b、body 的产物
  const idx = name => events.indexOf(name);
  assert.ok(idx('start:body:a+b') > idx('end:a') && idx('start:body:a+b') > idx('end:b'), '行屏障');
  assert.ok(events.includes('start:c:a+b+body'), '第三行拿到前两行产物快照');
  assert.ok(events.includes('start:b:-'), '同行不看到同行产物');
  assert.deepEqual(Object.keys(result.artifacts).sort(), ['a', 'b', 'body', 'c', 'rev']);
  assert.deepEqual(orch.getHouseState('body').fused, ['memory_table']);
  console.log('ok - row barrier, concurrency limit and same-row isolation');
}

{
  // 并发上限 1：串行
  let active = 0, maxActive = 0;
  const exec = makeExec(async () => { active += 1; maxActive = Math.max(maxActive, active); await wait(3); active -= 1; return ok(1); });
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r', houses: [body(), custom('a'), custom('b'), custom('c')] }], policy: { rowConcurrencyMax: 1 } },
    executors: { custom_prompt: exec, body: exec },
  });
  await orch.runTurn();
  assert.equal(maxActive, 1);
  console.log('ok - rowConcurrencyMax 1 serializes');
}

{
  // 正文失败 → 后续行全部 skipped（reason body_not_succeeded）；整轮 failed
  const exec = makeExec(async ({ house }) => (house.kind === 'body' ? { status: 'failed', error: 'model 500' } : ok(1)));
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r1', houses: [custom('pre')] }, { id: 'r2', houses: [body(['image_prompt'])] }, { id: 'r3', houses: [{ id: 'img', kind: 'image_generation' }] }] },
    executors: { custom_prompt: exec, body: exec, image_generation: exec },
  });
  const result = await orch.runTurn();
  assert.equal(result.status, 'failed');
  assert.equal(result.houses.pre.status, 'succeeded');
  assert.equal(result.houses.body.status, 'failed');
  assert.equal(result.houses.body.error, 'model 500');
  assert.equal(result.houses.img.status, 'skipped');
  assert.equal(result.houses.img.reason, 'body_not_succeeded');
  console.log('ok - body failure hard-stops following rows');
}

{
  // 普通房子失败：continue → 继续且整轮 partial；stop_following_rows → 后续行 skipped、同行其他房子照常
  const exec = makeExec(async ({ house }) => (house.id === 'bad' ? { status: 'failed', reason: 'boom' } : ok(house.id)));
  const mk = policy => createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r1', houses: [custom('bad'), custom('good')] }, { id: 'r2', houses: [body()] }, { id: 'r3', houses: [custom('post')] }], policy },
    executors: { custom_prompt: exec, body: exec },
  });
  const cont = await mk({ onHouseFailure: 'continue' }).runTurn();
  assert.equal(cont.status, 'partial');
  assert.equal(cont.houses.body.status, 'succeeded');
  assert.equal(cont.houses.post.status, 'succeeded');
  const stop = await mk({ onHouseFailure: 'stop_following_rows' }).runTurn();
  assert.equal(stop.houses.good.status, 'succeeded', '同行其他房子不受影响');
  assert.equal(stop.houses.body.status, 'skipped');
  assert.equal(stop.houses.body.reason, 'stop_following_rows');
  assert.equal(stop.houses.post.status, 'skipped');
  assert.equal(stop.status, 'failed', '正文被跳过即整轮失败');
  console.log('ok - continue vs stop_following_rows');
}

{
  // 取消：进行中房子收到 signal → cancelled；未启动 → cancelled(未启动)；整轮 cancelled；已完成不回滚
  const ac = new AbortController();
  const seen = [];
  const exec = makeExec(({ house, signal }) => new Promise((resolve, reject) => {
    seen.push(house.id);
    if (house.id === 'pre') return resolve(ok('pre'));
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    if (house.id === 'body') setTimeout(() => ac.abort(), 5);
  }));
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r1', houses: [custom('pre')] }, { id: 'r2', houses: [body(), custom('side')] }, { id: 'r3', houses: [custom('post')] }] },
    executors: { custom_prompt: exec, body: exec },
    signal: ac.signal,
  });
  const result = await orch.runTurn();
  assert.equal(result.status, 'cancelled');
  assert.equal(result.houses.pre.status, 'succeeded');
  assert.equal(result.houses.body.status, 'cancelled');
  assert.equal(result.houses.side.status, 'cancelled');
  assert.equal(result.houses.post.status, 'cancelled');
  assert.equal(result.houses.post.error, '未启动');
  assert.ok(!seen.includes('post'), '取消后不再启动新房子');
  console.log('ok - cancel semantics');
}

{
  // 超时：房子 failed(timeout)，子 signal 已 abort，迟到 resolve 不能改写终态
  let lateResolve;
  let childSignal;
  const exec = makeExec(({ house, signal }) => {
    if (house.kind === 'body') return ok('b');
    childSignal = signal;
    return new Promise((resolve) => { lateResolve = resolve; });
  });
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r1', houses: [body()] }, { id: 'r2', houses: [custom('slow', { timeoutMs: 1000 })] }] },
    executors: { custom_prompt: exec, body: exec },
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms >= 1000 ? 10 : ms),
  });
  const result = await orch.runTurn();
  assert.equal(result.houses.slow.status, 'failed');
  assert.equal(result.houses.slow.reason, 'timeout');
  assert.equal(childSignal.aborted, true);
  lateResolve(ok('late'));
  await tick();
  assert.equal(orch.getHouseState('slow').status, 'failed', '迟到结果不改写终态');
  assert.equal(orch.getHouseState('slow').artifact, null);
  console.log('ok - timeout aborts child signal and blocks late results');
}

{
  // 执行器缺失 / 返回非终态 / 抛异常 → failed 且带 reason；skipped 保留原因
  const exec = makeExec(async ({ house }) => {
    if (house.id === 'weird') return { status: 'running' };
    if (house.id === 'throws') throw new Error('kaboom');
    if (house.id === 'skip') return { status: 'skipped', reason: 'threshold_not_reached' };
    return ok(house.id);
  });
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r1', houses: [body(['image_prompt'])] }, { id: 'r2', houses: [custom('weird'), custom('throws'), custom('skip'), { id: 'img', kind: 'image_generation' }] }], policy: { rowConcurrencyMax: 4 } },
    executors: { custom_prompt: exec, body: { run: exec.run } }, // image_generation 故意无执行器
    logger: { warn() {} },
  });
  const result = await orch.runTurn();
  assert.equal(result.houses.weird.status, 'failed');
  assert.equal(result.houses.weird.reason, 'invalid_executor_result');
  assert.equal(result.houses.throws.status, 'failed');
  assert.equal(result.houses.throws.error, 'kaboom');
  assert.equal(result.houses.skip.status, 'skipped');
  assert.equal(result.houses.skip.reason, 'threshold_not_reached');
  assert.equal(result.houses.img.status, 'failed');
  assert.equal(result.houses.img.reason, 'executor_missing');
  assert.equal(result.status, 'partial');
  console.log('ok - executor contract violations are surfaced, not silent');
}

{
  // 校验失败的板直接拒绝构建
  assert.throws(() => createCreativeTurnOrchestrator({ board: { rows: [{ id: 'r', houses: [custom('x')] }] }, executors: {} }), /invalid hopscotch board/);
  // onHouseUpdate 事件按状态变化上报
  const updates = [];
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r1', houses: [body()] }] },
    executors: { body: makeExec(async () => ok('b')) },
    onHouseUpdate: s => updates.push(`${s.id}:${s.status}`),
  });
  await orch.runTurn();
  assert.deepEqual(updates, ['body:running', 'body:succeeded']);
  console.log('ok - invalid board rejected; house updates emitted');
}

{
  const controller = new AbortController();
  let calls = 0;
  const orch = createCreativeTurnOrchestrator({
    board: { rows: [{ id: 'r', houses: [body()] }] },
    signal: controller.signal,
    executors: { body: makeExec(async () => { calls += 1; await wait(15); return ok('late'); }) },
  });
  const pending = orch.runTurn();
  await tick();
  controller.abort();
  const result = await pending;
  assert.equal(result.houses.body.status, 'cancelled', '不服从 signal 的迟到成功不能覆盖取消');
  assert.equal(result.artifacts.body, undefined);
  await orch.runTurn();
  assert.equal(calls, 1, '同一编排对象只能执行一次');
  console.log('ok - late success cannot override cancellation; repeated run joins original turn');
}

console.log('creative-turn-orchestrator tests passed');
