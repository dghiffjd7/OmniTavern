import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { buildMaidRunContinuationSnapshot } from '../../src/scripts/agent/maid-run-continuation.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { cancelMaidRunChain, isMaidRunResumable, settleMaidRunContinuation, guardMaidContinuationResult } from '../../src/scripts/agent/maid-run-followup.js';
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

// 11/21 起继续／进度／取消由模型调用任务工具（见 maid-task-tools-tests），这里只测任务链的作用域、续接与取消。
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
  cancelMaidRunChain({ runtime, run: runtime.getRun(sourceId), context: scope });
  const cancelled = await agent.runPrompt('继续', { ...scope, runContinuation: snapshot });
  assert.equal(cancelled.reason, 'maid_previous_task_unavailable');
  assert.equal(calls, 0);
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

test('a second interruption hands off to one current task and cancellation closes its chain', () => {
  const fixture = makeFixture();
  const child = resumeChild(fixture, { finishTodos: false, continuable: true });
  settleMaidRunContinuation({ ...fixture, ...child, context: scope });
  assert.deepEqual(fixture.runtime.listRuns().filter(isMaidRunResumable).map(run => run.id), [child.childRun.id]);
  const cancelled = cancelMaidRunChain({ runtime: fixture.runtime, run: fixture.runtime.getRun(child.childRun.id), context: scope });
  assert.deepEqual(cancelled.sort(), [fixture.sourceId, child.childRun.id].sort());
  for (const id of [fixture.sourceId, child.childRun.id]) {
    assert.equal(fixture.runtime.getRun(id).status, 'cancelled');
    assert.equal(fixture.runtime.getRun(id).metadata.continuable, false);
  }
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
