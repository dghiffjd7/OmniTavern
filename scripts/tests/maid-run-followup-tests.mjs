import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createMaidTodoTools } from '../../src/scripts/agent/tools/maid-todo-tools.js';
import { buildMaidRunContinuationSnapshot } from '../../src/scripts/agent/maid-run-continuation.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { classifyMaidRunFollowup, resolveMaidRunFollowup, settleMaidRunContinuation, guardMaidContinuationResult } from '../../src/scripts/agent/maid-run-followup.js';
import { createMaidTaskInputPersistence } from '../../src/scripts/ui/maid-run-resume-utils.js';

const logger = { debug() {}, warn() {} };
const scope = { roleCardId: 'test-card', sessionId: '', uiMode: 'chat', contactsScopeId: 'test-card', chatScopeId: 'test-card' };
const makeFixture = () => {
  const store = new AgentRunStore({ storage: null });
  const runtime = createAgentTaskRuntime({ store, logger });
  const source = runtime.startRun({ id: 'run:interrupted', kind: 'maid_assistant',
    metadata: { goal: '给小雪、莉莉丝和阿凯生成并设置头像', maidTaskInputs: { context: scope },
      todos: [
        { content: '小雪头像', status: 'completed' },
        { content: '莉莉丝头像', status: 'pending' },
        { content: '阿凯头像', status: 'pending' },
      ] },
  });
  const continuationSnapshot = buildMaidRunContinuationSnapshot({ run: source,
    result: { reason: 'provider_request_failed', continuable: true } });
  runtime.finishRun(source.id, { status: 'failed', metadata: { continuable: true, continuationSnapshot,
    maidStatus: 'interrupted', reason: 'provider_request_failed' } });
  return { store, runtime, sourceId: source.id };
};

// Reduced J01/J02/J03 decisions from the real 2026-09-30 records. The APP
// entry point, run store and todo tools are real; no model/network calls here.
test('plain continue resolves the interrupted run in the current card', async () => {
  const { runtime, sourceId } = makeFixture(); let received;
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, logger,
    planner: async (_input, context) => { received = context; return { ok: true, action: 'final', message: '继续处理' }; },
  });
  await agent.runPrompt('继续', scope);
  assert.equal(received?.runContinuation?.sourceRunId, sourceId);
  assert.equal(received.runContinuation.remainingTodos.length, 2);
});

test('a progress question reads the previous run instead of a new empty todo list', async () => {
  const { runtime, sourceId } = makeFixture(); const observations = [];
  const tools = createMaidTodoTools({ getRun: runtime.getRun, updateRun: runtime.updateRun });
  const registry = { executeTool: async (name, args, context) => {
    const result = await tools.find(t => t.name === name).execute(args, context);
    observations.push(result); return { toolName: name, status: 'succeeded', result };
  } };
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, toolRegistry: registry, logger,
    planner: async () => ({ ok: true, action: 'tool', featureId: 'maid.todo', toolName: 'maid.todo.read', args: {} }),
    reactPlanner: async () => ({ ok: true, action: 'final', message: '报告任务进度' }),
  });
  const result = await agent.runPrompt('昨天那个弄好了吗', scope);
  // A local, evidence-backed status reply is also valid and avoids a model call.
  if (observations.length) assert.equal(observations[0].todos.length, 3);
  else assert.match(result.message, /小雪[\s\S]*莉莉丝[\s\S]*阿凯/);
  assert.equal(runtime.getRun(sourceId).metadata.continuable, true);
});

test('stored progress preserves the failure source and distinguishes stale todos from actual receipts', async () => {
  const { runtime, sourceId } = makeFixture(); let modelCalls = 0;
  const step = runtime.startStep(sourceId, { input: { toolName: 'contact.set_avatar', args: {} } });
  runtime.finishStep(sourceId, step.id, { status: 'succeeded', output: {
    summary: 'set contact avatar 小雪', result: { ok: true, target: { name: '小雪' } },
  } });
  runtime.updateRun(sourceId, { metadata: { todos: runtime.getRun(sourceId).metadata.todos.map(todo => ({ ...todo, status: 'pending' })) } });
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, logger,
    chatResponder: async () => { modelCalls++; return { ok: true, message: '小雪已完成，其余因生图服务报错中断。' }; },
  });
  const result = await agent.runPrompt('昨天那个弄好了吗', scope);
  assert.match(result.message, /规划模型请求失败/);
  assert.doesNotMatch(result.message, /生图服务报错/);
  assert.match(result.message, /成功操作记录/);
  assert.match(result.message, /未同步/);
  assert.equal(modelCalls, 0);
});

test('cancel a previous interrupted task persists cancellation and clears resume state', async () => {
  const { runtime, sourceId } = makeFixture();
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, logger,
    planner: async () => ({ ok: false, reason: 'unsupported_intent' }),
    chatResponder: async () => ({ ok: true, message: '已取消头像任务。' }),
  });
  await agent.runPrompt('算了那个不用了', scope);
  const run = runtime.getRun(sourceId);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.metadata.continuable, false);
  assert.equal(run.metadata.continuationSnapshot, null);
  assert.equal(run.metadata.todos[0].status, 'completed');
  assert.equal(run.metadata.todos[1].status, 'cancelled');
});

test('task attachment persistence captures the owning card as well as the session', async () => {
  const persistence = createMaidTaskInputPersistence({ referenceStore: {}, native: false });
  const saved = await persistence.persist([], scope);
  assert.equal(saved.context.roleCardId, scope.roleCardId);
  assert.equal(saved.context.contactsScopeId, scope.contactsScopeId);
});

test('resume supplied through UI controls cannot cross cards or replay a cancelled task', async () => {
  const { runtime, sourceId } = makeFixture(); let calls = 0;
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, logger,
    planner: async () => { calls++; return { ok: true, action: 'final', message: '不应调用' }; },
  });
  const snapshot = runtime.getRun(sourceId).metadata.continuationSnapshot;
  const foreign = await agent.runPrompt('继续', { ...scope, roleCardId: 'other-card', runContinuation: snapshot });
  assert.equal(foreign.reason, 'maid_previous_task_unavailable');
  assert.throws(() => agent.prepareSkillTaskContext('继续', { ...scope, roleCardId: 'other-card', runContinuation: snapshot }), /scope_mismatch/);
  await agent.runPrompt('算了那个不用了', scope);
  const cancelled = await agent.runPrompt('继续', { ...scope, runContinuation: snapshot });
  assert.equal(cancelled.reason, 'maid_previous_task_unavailable');
  assert.equal(calls, 0);
});

test('task followups preserve negation, ordinary chat, voice and ambiguous ownership', () => {
  const { runtime } = makeFixture();
  for (const input of ['不要取消那个任务', '昨天那个弄好了，继续聊吧', '继续给另一个角色换头像', '任务进度怎么样，顺便删掉旧群']) {
    assert.equal(classifyMaidRunFollowup(input), '', input);
  }
  const runs = runtime.listRuns();
  assert.equal(resolveMaidRunFollowup({ input: '继续', context: { ...scope, roleCardId: 'other' }, runs }), null);
  assert.equal(resolveMaidRunFollowup({ input: '继续', context: { ...scope, source: 'maid_realtime' }, runs }), null);
  const second = { ...runs[0], id: 'run:other', metadata: { ...runs[0].metadata, goal: '另一条任务' } };
  assert.equal(resolveMaidRunFollowup({ input: '取消那个任务', context: scope, runs: [...runs, second] }).ambiguous, true);
  assert.equal(resolveMaidRunFollowup({ input: '取消任务「另一条任务」', context: scope, runs: [...runs, second] }).run.id, second.id);
});

const resumeChild = ({ runtime, sourceId }, { finishTodos = true, toolName = 'contact.set_avatar', output = { ok: true }, continuable = false } = {}) => {
  const source = runtime.getRun(sourceId);
  const child = runtime.startRun({ kind: 'maid_assistant', metadata: { maidTaskScope: scope, resumedFromRunId: sourceId,
    todos: source.metadata.todos.map(todo => ({ ...todo, status: finishTodos ? 'completed' : todo.status })) } });
  const step = runtime.startStep(child.id, { input: { toolName, args: {} } });
  runtime.finishStep(child.id, step.id, { status: 'succeeded', output: { result: output } });
  const result = { ok: !continuable, continuable, status: continuable ? 'interrupted' : 'succeeded' };
  const continuation = source.metadata.continuationSnapshot;
  const snapshot = continuable ? buildMaidRunContinuationSnapshot({ run: runtime.getRun(child.id), result, previousSnapshot: continuation }) : null;
  const finished = runtime.finishRun(child.id, { status: continuable ? 'failed' : 'succeeded', metadata: { continuable, continuationSnapshot: snapshot } });
  return { continuation, childRun: finished, result };
};

test('successful continuation closes the source task and preserves the interruption audit', () => {
  const fixture = makeFixture();
  const child = resumeChild(fixture);
  settleMaidRunContinuation({ ...fixture, ...child, context: scope });
  const run = fixture.runtime.getRun(fixture.sourceId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.metadata.continuable, false);
  assert.equal(run.metadata.continuationSnapshot, null);
  assert.equal(run.metadata.originalInterruption.reason, 'provider_request_failed');
  assert.ok(run.metadata.todos.every(todo => todo.status === 'completed'));
});

test('todos alone, failed business output and unfinished obligations never close the source task', () => {
  for (const options of [{ toolName: 'maid.todo.write' }, { output: { ok: false } }, { finishTodos: false }]) {
    const fixture = makeFixture();
    const child = resumeChild(fixture, options);
    const checked = guardMaidContinuationResult({ result: child.result, continuation: child.continuation, run: child.childRun });
    assert.equal(checked.continuable, true);
    settleMaidRunContinuation({ ...fixture, ...child, result: checked, context: scope });
    assert.notEqual(fixture.runtime.getRun(fixture.sourceId).status, 'succeeded');
  }
});

test('a second interruption hands off to one current task and cancellation closes its chain', async () => {
  const fixture = makeFixture();
  const child = resumeChild(fixture, { finishTodos: false, continuable: true });
  settleMaidRunContinuation({ ...fixture, ...child, context: scope });
  const next = resolveMaidRunFollowup({ input: '继续', context: scope, runs: fixture.runtime.listRuns() });
  assert.equal(next.run.id, child.childRun.id);
  const agent = createMaidAssistantAgent({ agentTaskRuntime: fixture.runtime, logger });
  await agent.runPrompt('算了那个不用了', scope);
  for (const id of [fixture.sourceId, child.childRun.id]) {
    assert.equal(fixture.runtime.getRun(id).status, 'cancelled');
    assert.equal(fixture.runtime.getRun(id).metadata.continuable, false);
  }
});

test('a failed cancellation save does not claim persistent success', async () => {
  const { runtime } = makeFixture();
  const agent = createMaidAssistantAgent({ agentTaskRuntime: { ...runtime, flush: async () => false }, logger });
  const result = await agent.runPrompt('算了那个不用了', scope);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'maid_previous_task_cancel_not_persisted');
});

test('a restart without a continuation snapshot still closes every owned ancestor', () => {
  const fixture = makeFixture();
  const first = resumeChild(fixture, { finishTodos: false });
  fixture.runtime.finishRun(first.childRun.id, { status: 'cancelled', cancelReason: 'app_restarted',
    metadata: { continuationSnapshot: null, continuable: true } });
  const second = resumeChild({ ...fixture, sourceId: first.childRun.id }, { finishTodos: false });
  fixture.runtime.finishRun(second.childRun.id, { status: 'cancelled', cancelReason: 'app_restarted',
    metadata: { continuationSnapshot: null, continuable: true } });
  const child = resumeChild({ ...fixture, sourceId: second.childRun.id });
  settleMaidRunContinuation({ ...fixture, ...child,
    continuation: { sourceRunId: second.childRun.id }, context: scope });
  assert.equal(fixture.runtime.getRun(first.childRun.id).status, 'succeeded');
  assert.equal(fixture.runtime.getRun(fixture.sourceId).status, 'succeeded');
});

test('completed obligations dropped in later continuations still reconcile the oldest checklist', () => {
  const fixture = makeFixture();
  fixture.runtime.updateRun(fixture.sourceId, { metadata: { todos: [{ content: '查询联系人', status: 'in_progress' }, ...fixture.runtime.getRun(fixture.sourceId).metadata.todos] } });
  const first = resumeChild(fixture);
  const second = resumeChild({ ...fixture, sourceId: first.childRun.id });
  fixture.runtime.updateRun(second.childRun.id, { metadata: { todos: second.childRun.metadata.todos.filter(t => t.content !== '查询联系人') } });
  second.childRun = fixture.runtime.getRun(second.childRun.id);
  const finish = () => settleMaidRunContinuation({ ...fixture, ...second, continuation: { sourceRunId: first.childRun.id }, context: scope });
  finish(); finish();
  assert.ok(fixture.runtime.getRun(fixture.sourceId).metadata.todos.every(t => t.status === 'completed'));
});
