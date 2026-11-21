import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { buildMaidRunContinuationSnapshot, fingerprintMaidToolCall } from '../../src/scripts/agent/maid-run-continuation.js';
import { createMaidTaskTools, MAID_TASK_RESUME_TOOL, registerMaidTaskTools } from '../../src/scripts/agent/tools/maid-task-tools.js';
import { describeMaidRunInterruption, listMaidRunReceipts } from '../../src/scripts/agent/maid-run-followup.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';
import { buildMaidRunResumeSubmission } from '../../src/scripts/ui/maid-run-resume-utils.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

// 11/21 用户定：继续／进度／取消照 Noa 改成任务工具，由模型决定调用，不再按用户原话的关键词在本地处理。
const logger = { debug() {}, warn() {} };
const scope = { roleCardId: 'test-card', sessionId: '', uiMode: 'chat', contactsScopeId: 'test-card', chatScopeId: 'test-card' };
const tool = (tools, name) => tools.find(item => item.name === name);

const makeFixture = ({ store = new AgentRunStore({ storage: null }), resumeRun = null } = {}) => {
  const runtime = createAgentTaskRuntime({ store, logger });
  const source = runtime.startRun({ id: 'run:interrupted', kind: 'maid_assistant',
    metadata: { goal: '给小雪、莉莉丝和阿凯生成并设置头像', maidTaskInputs: { context: scope },
      todos: [
        { content: '小雪头像', status: 'completed' },
        { content: '莉莉丝头像', status: 'pending' },
        { content: '阿凯头像', status: 'pending' },
      ] },
  });
  const step = runtime.startStep(source.id, { input: { toolName: 'contact.set_avatar', args: {} } });
  runtime.finishStep(source.id, step.id, { status: 'succeeded', output: {
    summary: 'set contact avatar 小雪', result: { ok: true, target: { name: '小雪' } },
  } });
  const continuationSnapshot = buildMaidRunContinuationSnapshot({ run: runtime.getRun(source.id),
    result: { reason: 'provider_request_failed', continuable: true } });
  runtime.finishRun(source.id, { status: 'failed', metadata: { continuable: true, continuationSnapshot,
    maidStatus: 'interrupted', reason: 'provider_request_failed' } });
  const foreign = runtime.startRun({ id: 'run:foreign', kind: 'maid_assistant',
    metadata: { goal: '别的角色卡的任务', maidTaskScope: { ...scope, roleCardId: 'other-card' } } });
  runtime.finishRun(foreign.id, { status: 'failed', metadata: { continuable: true } });
  const done = runtime.startRun({ id: 'run:done', kind: 'maid_assistant', metadata: { goal: '已完成的任务', maidTaskScope: scope } });
  runtime.finishRun(done.id, { status: 'succeeded' });
  const tools = createMaidTaskTools({ agentTaskRuntime: runtime, resumeRun });
  return { store, runtime, tools, sourceId: source.id };
};

test('listing shows only this card\'s resumable or running tasks, excluding the current run', async () => {
  const { runtime, tools, sourceId } = makeFixture();
  const current = runtime.startRun({ id: 'run:current', kind: 'maid_assistant', metadata: { maidTaskScope: scope } });
  const list = tool(tools, 'maid.task.list');
  const listed = await list.execute({}, { ...scope, runId: current.id });
  assert.deepEqual(listed.tasks.map(task => [task.id, task.status, task.resumable]), [[sourceId, 'failed', true]]);
  assert.deepEqual(listed.tasks[0].todos, { total: 3, markedCompleted: 1, markedOpen: 2 });
  assert.equal(listed.tasks[0].successfulSteps, 1);
  // 中断原因与任务纪录摘要同一套说法，原始代码另附
  assert.equal(listed.tasks[0].interruption, '规划模型请求失败');
  assert.equal(listed.tasks[0].interruptionCode, 'provider_request_failed');
  const all = await list.execute({ includeFinished: true }, { ...scope, runId: current.id });
  assert.deepEqual(all.tasks.map(task => task.id).sort(), ['run:done', sourceId].sort());
  const inProgress = await list.execute({}, { ...scope, runId: 'run:other' });
  assert.ok(inProgress.tasks.some(task => task.id === current.id && task.status === 'running' && task.resumable === false));
  // 正在接着做的那条不算「可以接着做」
  const continuing = await list.execute({}, { ...scope, runId: current.id, runContinuation: { sourceRunId: sourceId } });
  assert.deepEqual(continuing.tasks, []);
  assert.equal((await list.execute({}, { ...scope, roleCardId: '' })).count, 0);
});

test('reading a task returns the stored record that the old progress reply used', async () => {
  const { runtime, tools, sourceId } = makeFixture();
  // 待办清单没同步：成功操作记录为准
  runtime.updateRun(sourceId, { metadata: { todos: runtime.getRun(sourceId).metadata.todos.map(todo => ({ ...todo, status: 'pending' })) } });
  const read = await tool(tools, 'maid.task.read').execute({ taskId: sourceId }, scope);
  assert.equal(read.ok, true);
  assert.equal(read.task.resumable, true);
  assert.equal(read.task.unfinishedTodos, undefined, '保存的待办没对照成功步骤，不当成「未完成」回给模型');
  assert.deepEqual(read.task.todos.map(todo => todo.status), ['pending', 'pending', 'pending']);
  assert.equal(read.task.successfulSteps.length, 1);
  assert.equal(read.task.interruption, '规划模型请求失败');
  assert.equal(read.task.interruptionCode, 'provider_request_failed');
  assert.match(read.summary, /规划模型请求失败/);
  assert.match(read.summary, /成功操作记录/);
  assert.match(read.summary, /未同步/);
  assert.deepEqual(await tool(tools, 'maid.task.read').execute({ taskId: 'run:foreign' }, scope), { ok: false, reason: 'task_not_found', taskId: 'run:foreign' });
});

test('cancelling goes through a confirmation card and reports the actual result', async () => {
  const { runtime, tools, sourceId } = makeFixture();
  const registry = createAgentToolRegistry({ logger });
  registry.registerMany(tools);
  const cards = [];
  const cancel = answer => registry.executeTool('maid.task.cancel', { taskId: sourceId }, {
    ...scope, requestToolConfirmation: async request => { cards.push(request); return { decision: answer }; },
  });
  const declined = await cancel('deny');
  assert.equal(declined.result.reason, 'task_cancel_declined');
  assert.equal(runtime.getRun(sourceId).metadata.continuable, true, '用户没批准就不取消');
  assert.equal(cards[0].operationType, 'cancel_maid_task');
  assert.match(cards[0].message, /给小雪、莉莉丝和阿凯生成并设置头像/);
  assert.match(cards[0].message, /已完成：小雪头像/);
  assert.match(cards[0].message, /待办清单（可能未同步，以成功操作记录为准）：莉莉丝头像、阿凯头像/);
  const allowed = await cancel('allow');
  assert.deepEqual([allowed.result.taskCancelled, allowed.result.persisted, allowed.result.cancelledTaskIds], [true, true, [sourceId]]);
  const run = runtime.getRun(sourceId);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.metadata.continuable, false);
  assert.equal(run.metadata.continuationSnapshot, null);
  assert.deepEqual(run.metadata.todos.map(todo => todo.status), ['completed', 'cancelled', 'cancelled']);
  // 已取消的任务不再弹卡，工具照实回报
  const again = await cancel('allow');
  assert.equal(again.result.reason, 'task_not_cancellable');
  assert.equal(cards.length, 2);
});

test('the cancel card offers allow once and this task, never this role card', async () => {
  const opened = [];
  const confirmations = createMaidToolConfirmationRuntime({
    choose: args => { opened.push(args.actions.map(action => action.id)); return Promise.resolve('deny'); },
  });
  const { tools, sourceId } = makeFixture();
  const request = await tool(tools, 'maid.task.cancel').safety.preflight({ taskId: sourceId }, scope);
  await confirmations.request({ ...request, toolName: 'maid.task.cancel' }, { runId: 'run-a', submissionId: 'sub-a', ...scope });
  assert.deepEqual(opened[0], ['allow_task', 'deny', 'allow_once']);
});

// J03（11/21 基线）：回复说「取消状态尚未确认保存」，任务其实已取消。根因：浏览器隔离环境没有 Tauri，
// AgentRunStore.persist() 写进 localStorage（load() 也从这里读回）后又因 save_kv 不可用回报 false。
test('the saved flag follows the run store: localStorage counts outside Tauri, a failed write does not', async () => {
  const previous = globalThis.localStorage;
  try {
    const data = new Map();
    globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
    const saved = makeFixture({ store: new AgentRunStore() });
    const ok = await tool(saved.tools, 'maid.task.cancel').execute({ taskId: saved.sourceId }, scope);
    assert.deepEqual([ok.taskCancelled, ok.persisted], [true, true]);
    const reloaded = new AgentRunStore();
    await reloaded.load();
    assert.equal(reloaded.getRun(saved.sourceId).status, 'cancelled', 'the cancellation is really in the store');

    globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); }, removeItem() {} };
    const failing = makeFixture({ store: new AgentRunStore() });
    const unsaved = await tool(failing.tools, 'maid.task.cancel').execute({ taskId: failing.sourceId }, scope);
    assert.deepEqual([unsaved.taskCancelled, unsaved.persisted], [true, false]);
    assert.equal(failing.runtime.getRun(failing.sourceId).status, 'cancelled');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('resuming refuses other cards, cancelled tasks, the task being continued and a missing resume path', async () => {
  const resumed = [];
  const { runtime, tools, sourceId } = makeFixture({ resumeRun: run => { resumed.push(run.id); return true; } });
  const resume = tool(tools, MAID_TASK_RESUME_TOOL);
  assert.equal((await resume.execute({ taskId: 'run:foreign' }, scope)).reason, 'task_not_found');
  assert.equal((await resume.execute({ taskId: 'run:done' }, scope)).reason, 'task_not_resumable');
  assert.equal((await resume.execute({ taskId: sourceId }, { ...scope, runContinuation: { sourceRunId: sourceId } })).reason, 'task_not_resumable');
  assert.equal((await tool(createMaidTaskTools({ agentTaskRuntime: runtime }), MAID_TASK_RESUME_TOOL).execute({ taskId: sourceId }, scope)).reason, 'task_resume_unavailable');
  assert.deepEqual(resumed, []);
  await tool(tools, 'maid.task.cancel').execute({ taskId: sourceId }, scope);
  assert.equal((await resume.execute({ taskId: sourceId }, scope)).reason, 'task_not_resumable');
});

test('the resume tool queues the same structured continuation as the 继续 button and keeps replay protection', async () => {
  const registry = createAgentToolRegistry({ logger });
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), toolRegistry: registry, logger });
  const createArgs = { name: '已建立角色卡' };
  const source = runtime.startRun({ id: 'run:persona', kind: 'maid_assistant', metadata: { goal: '创建角色卡并设置开场白',
    maidTaskInputs: { context: scope }, todos: [{ content: '创建角色卡', status: 'completed' }] } });
  runtime.finishRun(source.id, { status: 'failed', metadata: { continuable: true, reason: 'provider_request_failed', continuationSnapshot: {
    sourceRunId: source.id, goal: '创建角色卡并设置开场白', remainingTodos: [],
    successfulSteps: [{ toolName: 'persona.create', argsDigest: fingerprintMaidToolCall('persona.create', createArgs),
      result: { ok: true, personaId: 'persona-existing', name: '已建立角色卡' },
      resourceRefs: [{ kind: 'persona', id: 'persona-existing', name: '已建立角色卡' }], verification: 'readback' }],
  } } });
  const queued = [];
  const calls = [];
  registry.registerMany(createMaidTaskTools({ agentTaskRuntime: runtime,
    resumeRun: run => { queued.push(buildMaidRunResumeSubmission(run)); return true; } }));
  registry.register({ name: 'persona.create', riskLevel: 'low', capabilities: { read: false, write: true },
    schema: { type: 'object', additionalProperties: true, properties: {} },
    execute: async args => { calls.push('persona.create'); return { ok: true, personaId: 'persona-new', name: args.name }; } });
  registry.register({ name: 'app.read_resource', riskLevel: 'low', capabilities: { read: true, write: false },
    schema: { type: 'object', additionalProperties: true, properties: {} },
    execute: async () => { calls.push('app.read_resource'); return { ok: true, resource: 'persona', items: [{ id: 'persona-existing', name: '已建立角色卡' }] }; } });
  let reactCalls = 0;
  const planned = [];
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, toolRegistry: registry, logger,
    planner: async (_input, context) => {
      planned.push(context.runContinuation?.sourceRunId || '');
      return context.runContinuation
        ? { ok: true, action: 'tool', toolName: 'persona.create', featureId: 'persona.create', args: createArgs, title: '继续创建角色卡' }
        : { ok: true, action: 'tool', toolName: MAID_TASK_RESUME_TOOL, featureId: 'maid.task.resume', args: { taskId: source.id }, title: '继续任务' };
    },
    reactPlanner: async () => { reactCalls++; return { ok: true, action: 'final', message: '角色卡已存在，没有重复创建。' }; },
  });
  const first = await agent.runPrompt('把刚才那个接着做完', scope);
  assert.equal(first.reason, 'maid_task_resume_queued');
  assert.match(first.message, /创建角色卡并设置开场白/);
  assert.equal(reactCalls, 0, '排进续跑后本轮直接结束，不再调用模型');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].controls.context.runContinuation.sourceRunId, source.id);

  // 本轮结束后，排队的续跑与「继续」按钮一样以 runContinuation 进来：已成功的写入按稳定 ID 复验，不重做
  await agent.runPrompt(queued[0].text, { ...scope, ...queued[0].controls.context });
  assert.deepEqual(planned, ['', source.id]);
  assert.deepEqual(calls, ['app.read_resource']);
});

// 11/21 对照：J02「昨天那个弄好了吗」、J03「算了那个不用了」不含「任务」两字，按字眼检索拿不到任务工具。
// 改成看状态：当前角色卡有可以接着做或进行中的任务时，任务工具一律进候选，不看用户原话。
const TASK_FEATURES = ['maid.task.status', 'maid.task.resume', 'maid.task.cancel'];
const routeWith = (runs, input, context = scope) => {
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) }, logger });
  registry.registerMany(createMaidTaskTools({}));
  for (const name of ['session.create', 'session.list']) {
    registry.register({ name, riskLevel: 'low', capabilities: { read: name === 'session.list', write: name === 'session.create' },
      schema: { type: 'object', additionalProperties: true, properties: {} }, execute: async () => ({ ok: true }) });
  }
  const routing = createMaidCapabilityRoutingRuntime({ features: listAppFeatures(), toolRegistry: registry, logger,
    storage: null, listMaidRuns: () => runs });
  const request = routing.beginRequest({ input, context });
  const snapshot = routing.prepareDecision({ requestId: request.id, input, context, phase: 'planner', configOverride: { mode: 'bounded' } });
  return {
    ids: snapshot.candidateFeatures.map(feature => feature.id),
    stateAdded: snapshot.candidateRefs.filter(ref => ref.reasonCodes.includes('open_maid_task')).map(ref => ref.id),
    snapshot,
  };
};
const openRun = (patch = {}) => ({ id: 'run:open', kind: 'maid_assistant', status: 'failed', updatedAt: 1,
  ...patch, metadata: { goal: '给小雪换头像', maidTaskScope: scope, continuable: true, ...(patch.metadata || {}) } });

test('an open task on this card puts the task tools in the candidates whatever the wording', () => {
  for (const input of ['昨天那个弄好了吗', '算了那个不用了', '继续']) {
    const { ids, stateAdded } = routeWith([openRun()], input);
    for (const id of TASK_FEATURES) assert.ok(ids.includes(id), `${input}: ${id}`);
    assert.deepEqual(stateAdded.sort(), [...TASK_FEATURES].sort(), input);
  }
  // 进行中（例如等确认的任务）也算
  assert.deepEqual(routeWith([openRun({ status: 'waiting_permission', metadata: { continuable: false } })], '昨天那个弄好了吗').stateAdded.length, 3);
});

test('task tools are added beyond the candidate limit and do not count as matches for this request', () => {
  const { ids, snapshot } = routeWith([openRun()], '创建联系人小美');
  assert.ok(ids.includes('session.create'), '本句检索到的功能仍在');
  for (const id of TASK_FEATURES) assert.ok(ids.includes(id), id);
  assert.equal(snapshot.useCandidates, true);
  const empty = routeWith([openRun()], '昨天那个弄好了吗').snapshot;
  assert.equal(empty.useCandidates, false, '只有任务工具时不当成本句的检索命中');
});

test('no open task, another card\'s task, the current run or the task being continued add nothing', () => {
  const none = input => routeWith([], input).stateAdded;
  assert.deepEqual(none('昨天那个弄好了吗'), []);
  for (const id of TASK_FEATURES) assert.ok(!routeWith([], '算了那个不用了').ids.includes(id), id);
  for (const [runs, context] of [
    [[openRun({ metadata: { maidTaskScope: { ...scope, roleCardId: 'other-card' } } })], scope],
    [[openRun({ status: 'succeeded', metadata: { continuable: false } })], scope],
    [[openRun({ metadata: { continuable: false } })], scope],
    [[openRun({ status: 'running', metadata: { continuable: false, submissionId: 'sub-now' } })], { ...scope, submissionId: 'sub-now' }],
    [[openRun({ status: 'running', metadata: { continuable: false } })], { ...scope, maidRunId: 'run:open' }],
    [[openRun()], { ...scope, runContinuation: { sourceRunId: 'run:open' } }],
    [[openRun()], { ...scope, roleCardId: '' }],
  ]) assert.deepEqual(routeWith(runs, '昨天那个弄好了吗', context).stateAdded, [], JSON.stringify(context));
});

test('in a real run the current task does not keep the task tools pinned after its first step', async () => {
  const contexts = [];
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) }, logger });
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), toolRegistry: registry, logger });
  registry.registerMany(createMaidTaskTools({ agentTaskRuntime: runtime }));
  registry.register({ name: 'session.list', riskLevel: 'low', capabilities: { read: true, write: false },
    schema: { type: 'object', additionalProperties: true, properties: {} }, execute: async () => ({ ok: true, contacts: [] }) });
  const routing = createMaidCapabilityRoutingRuntime({ features: listAppFeatures(), toolRegistry: registry, logger, storage: null,
    listMaidRuns: () => runtime.listRuns({ kind: 'maid_assistant', limit: 100 }) });
  let react = 0;
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, toolRegistry: registry, capabilityRoutingRuntime: routing, logger,
    planner: async (_input, context) => { contexts.push(context.capabilitySnapshot); return { ok: true, action: 'tool', toolName: 'session.list', featureId: 'session.list', args: {} }; },
    reactPlanner: async (_input, context) => { contexts.push(context.capabilitySnapshot); react += 1; return { ok: true, action: 'final', message: '列好了。' }; },
  });
  await agent.runPrompt('列出所有联系人', scope);
  assert.equal(react, 1);
  for (const snapshot of contexts) {
    assert.ok(!snapshot.candidateRefs.some(ref => ref.reasonCodes.includes('open_maid_task')), snapshot.phase);
  }
});

// 11/21 对照：取消卡把素材任务的 3 条待办都标「未完成」，但小雪那条其实做完了（成功步骤里有生图与设头像）。
// 素材形态：待办全标 pending，成功步骤是小雪的 media.generate_image 与 contact.set_avatar。
const fixtureShapedRun = () => {
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), logger });
  const run = runtime.startRun({ id: 'run:avatars', kind: 'maid_assistant', metadata: {
    goal: '按顺序为小雪、莉莉丝、阿凯分别生成并设置头像', maidTaskScope: scope,
    todos: ['为小雪生成并设置头像', '为莉莉丝生成并设置头像', '为阿凯生成并设置头像'].map(content => ({ content, status: 'pending' })) } });
  for (const [toolName, args, result] of [
    ['media.generate_image', { subject: '小雪', target: '小雪', purpose: 'avatar' }, { ok: true, attachmentId: 'img-1' }],
    ['contact.set_avatar', { target: '小雪', attachmentId: 'img-1' }, { ok: true, target: { name: '小雪' } }],
  ]) {
    const step = runtime.startStep(run.id, { input: { toolName, args } });
    runtime.finishStep(run.id, step.id, { status: 'succeeded', output: { toolName, status: 'succeeded', result } });
  }
  runtime.finishRun(run.id, { status: 'failed', metadata: { continuable: true, reason: 'provider_request_failed' } });
  return { runtime, tools: createMaidTaskTools({ agentTaskRuntime: runtime }), runId: run.id };
};

test('the cancel card states progress from successful steps, not from stale todo marks', async () => {
  const { tools, runId } = fixtureShapedRun();
  const card = await tool(tools, 'maid.task.cancel').safety.preflight({ taskId: runId }, scope);
  const lines = card.message.split('\n');
  assert.match(lines[0], /将取消任务「按顺序为小雪、莉莉丝、阿凯分别生成并设置头像」/);
  assert.match(card.message, /成功操作记录：生成图片附件 · 小雪；设置联系人头像 · 小雪。/);
  assert.match(card.message, /待办清单（可能未同步，以成功操作记录为准）：为小雪生成并设置头像、为莉莉丝生成并设置头像、为阿凯生成并设置头像。/);
  assert.doesNotMatch(card.message, /尚未完成|未完成：/, '对不上成功步骤时不断定哪条没做');
  assert.equal(card.details, undefined, '不再把待办逐条标成「未完成」');
});

test('reading the same task gives the model the successful steps and the saved checklist without calling it unfinished', async () => {
  const { tools, runId } = fixtureShapedRun();
  const read = await tool(tools, 'maid.task.read').execute({ taskId: runId }, scope);
  assert.deepEqual(read.task.successfulSteps, ['生成图片附件 · 小雪', '设置联系人头像 · 小雪']);
  assert.equal(read.task.unfinishedTodos, undefined);
  assert.match(read.summary, /成功操作记录：生成图片附件 · 小雪；设置联系人头像 · 小雪。/);
  assert.match(read.summary, /待办清单（可能未同步，以成功操作记录为准）/);
  const listed = await tool(tools, 'maid.task.list').execute({}, scope);
  assert.deepEqual([listed.tasks[0].todos, listed.tasks[0].successfulSteps], [{ total: 3, markedCompleted: 0, markedOpen: 3 }, 2]);
});

test('with no successful step yet, open todos are still reported as unfinished', async () => {
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), logger });
  const run = runtime.startRun({ id: 'run:fresh', kind: 'maid_assistant', metadata: { goal: '整理世界书', maidTaskScope: scope,
    todos: [{ content: '读取世界书', status: 'pending' }] } });
  runtime.finishRun(run.id, { status: 'failed', metadata: { continuable: true } });
  const card = await tool(createMaidTaskTools({ agentTaskRuntime: runtime }), 'maid.task.cancel').safety.preflight({ taskId: run.id }, scope);
  assert.match(card.message, /尚未完成：读取世界书。/);
});

// 11/21 Gemini J03 重跑：取消成功后本轮被记成「已取消」，用户看到的是工具摘要英文原文。
// 根因是成功结果用了 cancelled:true，女仆执行层把这个字段当成「这次调用被用户取消」。
test('after a successful cancel the turn goes on and the model writes the final reply', async () => {
  const registry = createAgentToolRegistry({ logger });
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), toolRegistry: registry, logger });
  const source = runtime.startRun({ id: 'run:avatars', kind: 'maid_assistant', metadata: { goal: '给三位联系人换头像', maidTaskScope: scope,
    todos: [{ content: '小雪头像', status: 'pending' }] } });
  runtime.finishRun(source.id, { status: 'failed', metadata: { continuable: true } });
  registry.registerMany(createMaidTaskTools({ agentTaskRuntime: runtime }));
  const observed = [];
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, toolRegistry: registry, logger,
    planner: async () => ({ ok: true, action: 'tool', toolName: 'maid.task.cancel', featureId: 'maid.task.cancel', args: { taskId: source.id }, title: '取消任务' }),
    reactPlanner: async (_input, context) => { observed.push(context.maidReactSteps); return { ok: true, action: 'final', message: '好的，换头像的任务已经取消了。' }; },
  });
  const result = await agent.runPrompt('算了那个不用了', { ...scope, requestToolConfirmation: async () => ({ decision: 'allow' }) });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message, '好的，换头像的任务已经取消了。');
  assert.equal(observed.length, 1, '模型拿到取消结果后给出最终回答');
  assert.equal(runtime.getRun(source.id).status, 'cancelled');
  const current = runtime.listRuns({ kind: 'maid_assistant' }).find(run => run.id !== source.id);
  assert.equal(current.status, 'succeeded', '本轮自己的任务不被记成已取消');
  assert.equal(current.steps[0].status, 'succeeded');
});

// 11/21 对照：取消卡写成「读取 APP 结构化资源；修改变量；读取 APP 结构化资源」——读取步骤也算进去，变量没写出对象。
// 改成只列会改内容的步骤（照工具定义的 capabilities.write），并照结果／参数里的名称类栏位写出对象。
test('the receipts list only steps that changed content and name what they changed', async () => {
  const registry = createAgentToolRegistry({ logger });
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), logger });
  for (const [name, write] of [['app.read_resource', false], ['variable.set', true]]) {
    registry.register({ name, riskLevel: write ? 'medium' : 'low', capabilities: { read: true, write },
      schema: { type: 'object', additionalProperties: true, properties: {} }, execute: async () => ({ ok: true }) });
  }
  const tools = registerMaidTaskTools(registry, { agentTaskRuntime: runtime });
  const run = runtime.startRun({ id: 'run:variables', kind: 'maid_assistant', metadata: { goal: '把好感度改成 5', maidTaskScope: scope,
    todos: [{ content: '修改好感度', status: 'pending' }] } });
  for (const [toolName, args, result] of [
    ['app.read_resource', { resource: 'variables' }, { ok: true, resource: 'variables', items: [] }],
    ['variable.set', { values: [{ path: '好感度', value: 5 }] }, { ok: true, sessionId: 's1', changes: [{ key: '好感度', kind: 'update', before: '3', after: '5' }] }],
    ['app.read_resource', { resource: 'variables' }, { ok: true, resource: 'variables', items: [] }],
    // 没登记定义的工具查不到 capabilities，按写入列出
    ['contact.set_avatar', { target: '小雪', attachmentId: 'img-1' }, { ok: true }],
  ]) {
    const step = runtime.startStep(run.id, { input: { toolName, args } });
    runtime.finishStep(run.id, step.id, { status: 'succeeded', output: { toolName, status: 'succeeded', result } });
  }
  runtime.finishRun(run.id, { status: 'failed', metadata: { continuable: true, reason: 'provider_request_failed' } });
  const card = await tool(tools, 'maid.task.cancel').safety.preflight({ taskId: run.id }, scope);
  assert.match(card.message, /成功操作记录：修改变量 · 好感度；设置联系人头像 · 小雪。/);
  assert.doesNotMatch(card.message, /读取 APP 结构化资源/);
  const read = await tool(tools, 'maid.task.read').execute({ taskId: run.id }, scope);
  assert.deepEqual(read.task.successfulSteps, ['修改变量 · 好感度', '设置联系人头像 · 小雪']);
  assert.match(read.summary, /成功操作记录：修改变量 · 好感度；设置联系人头像 · 小雪。/);
  const listed = await tool(tools, 'maid.task.list').execute({}, scope);
  assert.equal(listed.tasks[0].successfulSteps, 2);
});

test('receipt targets come from result or argument name fields, else only the feature title', () => {
  const runOf = (...steps) => ({ steps: steps.map(([toolName, args, result]) => ({ status: 'succeeded', input: { toolName, args }, output: { result } })) });
  assert.deepEqual(listMaidRunReceipts(runOf(
    ['variable.delete', { paths: ['临时标记', '角色.小雅.备注'] }, { ok: true, sessionId: 's1' }],
    ['variable.set', { values: ['甲', '乙', '丙', '丁'].map(path => ({ path, value: 1 })) }, { ok: true }],
    ['contact_profile.upsert', { contactId: 'session-1', displayName: '莉莉丝' }, { ok: true }],
    ['variable.set', {}, { ok: true }],
  )), ['移除变量 · 临时标记、角色.小雅.备注', '修改变量 · 甲、乙、丙…', '保存联系人档案与人设 · 莉莉丝', '修改变量']);
  // 明确不写入的工具不列；没有判断依据时照旧列出
  const reads = runOf(['app.read_resource', { resource: 'variables' }, { ok: true }]);
  assert.deepEqual(listMaidRunReceipts(reads, { isWriteTool: () => false }), []);
  assert.deepEqual(listMaidRunReceipts(reads), ['读取 APP 结构化资源']);
});

// 11/21 用户定：没有实际改动的步骤（值没变、已是目标状态、只是预览、本次没执行）不算成功操作，照结果栏位通用判断
test('steps whose results show no actual change are left out of the receipts', () => {
  const runOf = (...results) => ({ steps: results.map(result => ({ status: 'succeeded', input: { toolName: 'variable.set', args: { values: [{ path: '好感度', value: 5 }] } }, output: { result } })) });
  for (const result of [
    { ok: true, skipped: true, reason: 'no_change', sessionId: 's1' },
    { ok: true, changed: false },
    { ok: true, updated: false, changed: false, target: '小雪' },
    { ok: true, preview: true, updated: false },
    { ok: true, noChange: true, changes: [] },
    { ok: true, status: 'skipped', reason: 'already_in_state' },
    { ok: true, installed: false, reason: 'already_installed' },
    { ok: true, reusedVerifiedAction: true, localToolExecutionSkipped: true, reason: 'cross_run_action_already_verified' },
    { ok: true, results: [{ id: 'a', status: 'skipped', reason: 'already_in_state' }, { id: 'b', status: 'skipped' }] },
  ]) assert.deepEqual(listMaidRunReceipts(runOf(result)), [], JSON.stringify(result));
  assert.deepEqual(listMaidRunReceipts(runOf(
    { ok: true, changes: [{ key: '好感度', kind: 'update', before: '3', after: '5' }] },
    { ok: true, results: [{ id: 'a', status: 'skipped' }, { id: 'b', status: 'succeeded' }] },
  )), ['修改变量 · 好感度', '修改变量 · 好感度'], '有实际改动（含部分项目跳过）的照列');
});

test('every interruption code a maid run can record has a readable label; free text stays as is', async () => {
  const runWith = reason => ({ metadata: { reason } });
  assert.equal(describeMaidRunInterruption(runWith('max_steps_reached')), '已达到本轮步骤上限');
  assert.equal(describeMaidRunInterruption(runWith('same_tool_overuse')), '同一工具连续调用过多次');
  assert.equal(describeMaidRunInterruption(runWith('continuation_incomplete')), '接着做的任务尚未确认全部完成');
  assert.equal(describeMaidRunInterruption(runWith('Network error: timeout')), 'Network error: timeout');
  assert.equal(describeMaidRunInterruption(runWith('toString')), 'toString', '不读到物件原型上的属性');
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }), logger });
  const tools = createMaidTaskTools({ agentTaskRuntime: runtime });
  for (const [id, reason] of [['run:steps', 'max_steps_reached'], ['run:text', '工具「x」执行失败']]) {
    runtime.startRun({ id, kind: 'maid_assistant', metadata: { goal: id, maidTaskScope: scope } });
    runtime.finishRun(id, { status: 'failed', metadata: { continuable: true, reason } });
  }
  const listed = await tool(tools, 'maid.task.list').execute({}, scope);
  const byId = Object.fromEntries(listed.tasks.map(task => [task.id, task]));
  assert.deepEqual([byId['run:steps'].interruption, byId['run:steps'].interruptionCode], ['已达到本轮步骤上限', 'max_steps_reached']);
  assert.deepEqual([byId['run:text'].interruption, byId['run:text'].interruptionCode], ['工具「x」执行失败', undefined], '原文没有另附代码');
  const read = await tool(tools, 'maid.task.read').execute({ taskId: 'run:steps' }, scope);
  assert.match(read.summary, /中断原因：已达到本轮步骤上限。/);
});
