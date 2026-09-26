import assert from 'node:assert/strict';
import test from 'node:test';
import { MaidSkillStore } from '../../src/scripts/storage/maid-skill-store.js';
import { createMaidSkillRuntime } from '../../src/scripts/ui/maid-skill-runtime.js';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { buildMaidPendingActionFromSteps } from '../../src/scripts/agent/maid-pending-action.js';
import { createMaidSkillContext, serializeMaidSkillContext } from '../../src/scripts/agent/maid-skill-context.js';
import { buildMaidRunResumeSubmission, createMaidTaskInputPersistence } from '../../src/scripts/ui/maid-run-resume-utils.js';
import { setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';

const setup = async () => {
  const store = new MaidSkillStore({ loadKv: async () => null, saveKv: async () => {} }); await store.ready;
  const skill = await store.save({ title: '写作规范', name: 'writing-rules', description: '写故事', content: '旧版本', featureIds: [] });
  let unavailable = false;
  const runtime = createMaidSkillRuntime({ store, validateTask: async () => { if (unavailable) throw new Error('unconfigured'); } });
  return { store, skill, runtime, fail: value => { unavailable = value; } };
};
test('preparation preserves draft on failure and freezes the library before queue acceptance', async () => {
  const { store, skill, runtime, fail } = await setup(); runtime.setSelected([skill.id]); fail(true);
  await assert.rejects(runtime.prepare('write'), /unconfigured/);
  assert.deepEqual(runtime.getSelected(), [skill.id]); fail(false);
  const prepared = await runtime.prepare('write');
  assert.deepEqual(runtime.getSelected(), [skill.id]);
  await store.save({ ...skill, content: '新版本', enabled: false }, { id: skill.id, expectedRevision: 1 });
  prepared.onAccepted(); assert.deepEqual(runtime.getSelected(), []);
  assert.equal(prepared.context.maidSkillContext.catalog.find(item => item.id === skill.id).content, '旧版本');
  assert.equal(prepared.context.maidSkillContext.loaded[0].revision, 1);
});
test('voice status/confirm do not consume a selection, execute consumes once, unused selection returns on hangup', async () => {
  const { runtime, skill } = await setup(); runtime.setSelected([skill.id]); runtime.beginCall('call-a');
  const submissions = [];
  const tasks = createMaidVoiceTaskRuntime({ prepareSubmission: runtime.prepare, getCommandRuntime: () => ({
    submitVoiceTask: (_text, controls) => { submissions.push(controls); controls.onAccepted?.(); return Promise.resolve({ ok: true }); },
  }) });
  await tasks.request({ target: { maidCallId: 'call-a' }, args: { action: 'status' } });
  await tasks.request({ target: { maidCallId: 'call-a' }, args: { action: 'confirm' } });
  assert.deepEqual(runtime.getSelected(), [skill.id]);
  await Promise.all(['one', 'two'].map(request => tasks.request({ target: { maidCallId: 'call-a' }, args: { action: 'execute', request } })));
  assert.equal(submissions[0].context.maidSkillContext.loaded.length, 1);
  assert.equal(submissions[1].context.maidSkillContext.loaded.length, 0);
  runtime.setSelected([skill.id]); runtime.endCall('call-a'); assert.deepEqual(runtime.getSelected(), [skill.id]);
  runtime.beginCall('call-b');
  const priorTask = tasks.getState('call-a').latest.task_id;
  assert.equal((await tasks.request({ target: { maidCallId: 'call-b' }, args: { action: 'status' } })).latest, null);
  const crossCall = await tasks.request({ target: { maidCallId: 'call-b' }, args: { action: 'execute', task_id: priorTask, request: 'continue' } });
  assert.equal(crossCall.ok, false); assert.equal(submissions.length, 2);
  await assert.rejects(runtime.prepare('stale', [], { source: 'maid_realtime', voiceCallId: 'call-a' }), { code: 'skill_call_changed' });
  assert.deepEqual(runtime.getSelected(), [skill.id]); runtime.endCall('call-b');
});

test('confirmation preserves next-task selection and localized retries restore the selected run explicitly', async () => {
  const { store, skill } = await setup();
  const next = await store.save({ ...skill, title: '下一任务', name: 'next-task', content: '下一任务流程' });
  const saved = serializeMaidSkillContext(createMaidSkillContext({ catalog: store.list(), selectedIds: [skill.id] }));
  const pendingWorkflow = buildMaidPendingActionFromSteps([{ toolName: 'regex.delete_many', featureId: 'regex.delete_many', status: 'succeeded', args: { targets: ['a'], preview: true },
    output: { ok: true, preview: true, plannedCount: 1, items: [{ id: 'a', name: '甲', status: 'planned' }] } }]);
  const run = { id: 'saved-run', kind: 'maid_assistant', status: 'waiting_permission', metadata: { maidSkills: saved, pendingWorkflow, goal: '整理正则' } };
  const agent = createMaidAssistantAgent({ agentTaskRuntime: { getRun: id => id === run.id ? run : null, listRuns: () => [run] } });
  const runtime = createMaidSkillRuntime({ store, resolveTaskContext: agent.prepareSkillTaskContext });
  runtime.setSelected([next.id]);
  const confirmation = await runtime.prepare('确认'); confirmation.onAccepted?.();
  assert.deepEqual(runtime.getSelected(), [next.id]);
  assert.equal(confirmation.context.maidSkillContext.loaded[0].id, skill.id);
  const independent = await runtime.prepare('按照所选技能写一个故事');
  assert.equal(independent.context.maidSkillContext.loaded[0].id, next.id);
  independent.onAccepted(); assert.deepEqual(runtime.getSelected(), []);
  await store.save({ ...skill, content: '新版本' }, { id: skill.id, expectedRevision: 1 });
  run.status = 'failed';
  try {
    for (const locale of ['en', 'zh-TW']) {
      setPromptLocale(locale);
      const retry = buildMaidRunResumeSubmission(run);
      assert.equal(retry.controls.context.runContinuation.sourceRunId, run.id);
      const prepared = await runtime.prepare(retry.text, [], retry.controls);
      assert.equal(prepared.context.maidSkillContext.catalog.find(item => item.id === skill.id).content, '旧版本');
    }
  } finally { setPromptLocale('zh-CN'); }
});

test('task attachment snapshots persist references and restore the original images', async () => {
  const persistence = createMaidTaskInputPersistence({ native: true, referenceStore: {
    persist: async () => [{ path: 'input.png', sessionId: 'maid-task-inputs', hash: 'stable' }],
    load: async references => references.map(() => ({ dataUrl: 'data:image/png;base64,AAAA', name: 'input.png' })),
  } });
  const saved = await persistence.persist([{ kind: 'image', url: 'data:image/png;base64,AAAA' }], { sessionId: 'room' });
  assert.equal(JSON.stringify(saved).includes('base64'), false);
  assert.equal((await persistence.restore(saved))[0].url, 'data:image/png;base64,AAAA');
  assert.equal(saved.context.sessionId, 'room');
});

test('explicit retry preserves an unrelated pending task and new attachments replace restored inputs', async () => {
  const { store, skill } = await setup();
  const saved = serializeMaidSkillContext(createMaidSkillContext({ catalog: store.list(), selectedIds: [skill.id] }));
  const tasks = createAgentTaskRuntime({ store: new AgentRunStore(), logger: { warn() {} } });
  tasks.startRun({ id: 'retry-source', kind: 'maid_assistant', status: 'failed', metadata: {
    goal: '整理资料', maidSkills: saved, maidTaskInputs: { version: 1, references: [{ path: 'old.png' }], context: { sessionId: 'original-room' } },
  } });
  const pendingWorkflow = buildMaidPendingActionFromSteps([{ toolName: 'regex.delete_many', featureId: 'regex.delete_many', status: 'succeeded', args: { targets: ['a'], preview: true },
    output: { ok: true, preview: true, plannedCount: 1, items: [{ id: 'a', name: '甲', status: 'planned' }] } }]);
  tasks.startRun({ id: 'unrelated-pending', kind: 'maid_assistant', status: 'waiting_permission', metadata: { submissionId: 'pending-submission', pendingWorkflow } });
  let restores = 0, persisted = null, modelCalls = 0;
  const agent = createMaidAssistantAgent({ agentTaskRuntime: tasks,
    planner: async () => { modelCalls++; return { ok: true, action: 'final', source: 'maid_provider_fc', message: '完成' }; },
    logger: { warn() {}, debug() {} },
  });
  const runtime = createMaidSkillRuntime({ store, resolveTaskContext: agent.prepareSkillTaskContext, inputPersistence: {
    restore: async () => { restores++; return [{ kind: 'image', url: 'old-image' }]; },
    persist: async attachments => { persisted = attachments; return { version: 1, references: [{ path: 'new.png' }] }; },
  } });
  const retry = buildMaidRunResumeSubmission(tasks.getRun('retry-source'));
  const images = [{ kind: 'image', url: 'new-image' }];
  const prepared = await runtime.prepare(retry.text, images, retry.controls);
  assert.equal(prepared.context.pendingActionSubmissionId, undefined);
  assert.deepEqual(prepared.attachments, images); assert.deepEqual(persisted, images); assert.equal(restores, 0);
  assert.equal(prepared.context.maidTaskInputs.references[0].path, 'new.png');
  await agent.runPrompt(retry.text, prepared.context);
  assert.equal(modelCalls, 1);
  assert.equal(tasks.getRun('unrelated-pending').status, 'waiting_permission');
  const restored = await runtime.prepare(retry.text, [], retry.controls);
  assert.equal(restores, 1); assert.equal(restored.attachments[0].url, 'old-image');
});

test('an unreadable library only blocks explicit selections; other tasks continue with builtin skills', async () => {
  const store = new MaidSkillStore({ loadKv: async () => ({ schemaVersion: 99 }), saveKv: async () => {} });
  await store.ready.catch(() => {});
  const runtime = createMaidSkillRuntime({ store });
  const prepared = await runtime.prepare('hello');
  assert.ok(prepared.context.maidSkillContext.catalog.length >= 2, 'builtin skills remain available');
  assert.equal(prepared.context.maidSkillContext.catalog.every(item => item.kind === 'builtin'), true);
});

test('a resumed task keeps loaded skill versions and regains the rest of the library', async () => {
  const { store, skill } = await setup();
  const other = await store.save({ title: '另一份', name: 'other-rules', description: '其他', content: '其他正文', featureIds: [] });
  const frozen = createMaidSkillContext({ catalog: store.list(), selectedIds: [skill.id] });
  const run = { metadata: { maidSkills: serializeMaidSkillContext(frozen) } };
  const { restoreMaidSkillContext } = await import('../../src/scripts/agent/maid-skill-context.js');
  const restored = restoreMaidSkillContext(run);
  assert.ok(restored.catalog.some(item => item.kind === 'builtin'), 'builtins are back in a resumed task');
  await store.save({ ...skill, content: '新版本' }, { id: skill.id, expectedRevision: skill.revision });
  const runtime = createMaidSkillRuntime({ store, resolveTaskContext: (_text, context) => ({ context: { ...context, maidSkillContext: restored, maidSkillContextPrepared: true }, useDraftSkills: false }) });
  const prepared = await runtime.prepare('继续');
  const catalog = prepared.context.maidSkillContext.catalog;
  assert.equal(catalog.find(item => item.id === skill.id).content, '旧版本', 'the loaded version stays frozen');
  assert.equal(catalog.find(item => item.id === other.id)?.content, '其他正文', 'unloaded skills come from the current library');
});

test('a voice follow-up that references an old task prepares skills from the current call selection', async () => {
  const submissions = [];
  const tasks = createMaidVoiceTaskRuntime({ getCommandRuntime: () => ({
    submitVoiceTask: (_text, controls) => { submissions.push(controls); return Promise.resolve({ ok: true }); },
  }), makeId: (() => { let n = 0; return () => `task-${++n}`; })() });
  const target = { maidCallId: 'call-a' };
  await tasks.request({ target, args: { action: 'execute', request: '画一张图' } });
  submissions[0].context.maidSkillContext = { loaded: [{ id: 'old' }] };
  submissions[0].context.maidSkillContextPrepared = true;
  await new Promise(resolve => setTimeout(resolve, 0));
  await tasks.request({ target, args: { action: 'execute', request: '同样再来一张', task_id: 'task-1' } });
  const followUp = submissions.at(-1).context;
  assert.equal(followUp.maidSkillContext, undefined);
  assert.equal(followUp.maidSkillContextPrepared, undefined);
});
test('typing during a call uses the call chips shown on screen and consumes them once', async () => {
  const { skill, runtime } = await setup(); runtime.beginCall('call-a'); runtime.setSelected([skill.id]);
  const prepared = await runtime.prepare('typed while talking');
  assert.deepEqual(prepared.context.maidSkillContext.loaded.map(item => item.id), [skill.id]);
  prepared.onAccepted(); assert.deepEqual(runtime.getSelected(), []);
  runtime.setSelected([skill.id]);
  const stale = runtime.prepare('typed then hung up');
  runtime.endCall('call-a');
  await assert.rejects(stale, { code: 'skill_call_changed' });
  assert.deepEqual(runtime.getSelected(), [skill.id], 'the selection returns to the draft on hangup');
});
test('only skill codes map to skill-loading messages', async () => {
  const { maidSkillMessage } = await import('../../src/scripts/ui/maid-skill-messages.js');
  assert.equal(maidSkillMessage({ code: 'skill_something_new' }), '技能暂时无法载入');
  assert.equal(maidSkillMessage(Object.assign(new Error('附件保存失败'), { code: 'attachment_write_failed' })), '附件保存失败');
  assert.equal(maidSkillMessage({ code: 'attachment_write_failed' }), '技能操作失败，请重试');
});
