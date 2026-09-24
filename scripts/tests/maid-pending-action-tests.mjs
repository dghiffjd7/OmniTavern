import assert from 'node:assert/strict';

import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { createPresetRegexScriptAgentTools } from '../../src/scripts/agent/tools/preset-regex-script-tools.js';
import {
  buildMaidImportedCardWorkflowSnapshot,
  classifyMaidImportedCardConfirmation,
  resolvePendingMaidImportedCardWorkflow,
} from '../../src/scripts/agent/maid-imported-card-workflow.js';
import {
  isPendingRunInContext,
  buildMaidPendingActionFromSteps,
  classifyMaidPendingActionReply,
  resolvePendingMaidAction,
} from '../../src/scripts/agent/maid-pending-action.js';

// 自然语言由现有 planner 判断：待确认清单不能在模型看到原话之前取消或整单执行。
for (const [kind, input] of [
  ['delete', '允许一次，但第二个别删'],
  ['delete', '好的，算了'],
  ['import', '我没有确认'],
  ['import', '确认，跳过第二个'],
  ['import', '取消第二个，其他照常'],
]) {
  const modelInputs = [];
  const toolInputs = [];
  const registry = createAgentToolRegistry({ logger: { warn() {}, debug() {} } });
  registry.register({
    name: 'app.read_resource', title: 'Read fixture', description: 'Read fixture', permissions: [],
    schema: { type: 'object', additionalProperties: true }, riskLevel: 'low',
    execute: async args => { toolInputs.push(args); return { ok: true, items: [] }; },
  });
  const snapshot = kind === 'delete'
    ? buildMaidPendingActionFromSteps([{
      toolName: 'regex.delete_many', featureId: 'regex.delete_many', title: '删除正则', status: 'succeeded',
      args: { targets: ['a', 'b'], preview: true },
      output: { ok: true, preview: true, plannedCount: 2, items: [{ id: 'a', name: '甲', status: 'planned' }, { id: 'b', name: '乙', status: 'planned' }] },
    }])
    : buildMaidImportedCardWorkflowSnapshot({
      persona: { id: 'p1', name: '卡' }, worldbook: { id: 'wb1', name: '书' },
      classification: { candidates: [{ entryId: 'e1', name: '甲', confidence: 1 }, { entryId: 'e2', name: '乙', confidence: 1 }] },
    });
  const runtime = createAgentTaskRuntime({ store: new AgentRunStore(), toolRegistry: registry, logger: { warn() {} } });
  runtime.startRun({ id: 'pending-fixture', kind: 'maid_assistant', status: 'waiting_permission', metadata: { voiceCallId: 'call', submissionId: 'original', pendingWorkflow: snapshot } });
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: runtime, toolRegistry: registry, logger: { warn() {}, debug() {} },
    planner: async text => {
      modelInputs.push(text);
      return { ok: true, action: 'final', source: 'maid_provider_fc', message: '由模型结合清单处理原话。' };
    },
  });
  await agent.runPrompt(input, { source: 'maid_realtime', voiceCallId: 'call', submissionId: 'followup' });
  assert.deepEqual(modelInputs, [input], `${kind}: forward the complete reply to the planner`);
  assert.deepEqual(toolInputs, [], `${kind}: no frozen workflow apply before model interpretation`);
}
console.log('ok - natural-language pending replies reach the planner intact before execution');

// 只认简短、明确的确认或取消
{
  for (const text of ['确认后执行', '确认执行', '确认', '好的', '执行吧', '删吧', '确认删除', 'OK', '允许', '允許', 'allow']) assert.equal(classifyMaidPendingActionReply(text), 'confirm', text);
  for (const text of ['取消', '算了', '先不删了', '别删']) assert.equal(classifyMaidPendingActionReply(text), 'cancel', text);
  for (const text of ['帮我确认一下正则还在不在', '确认一下有哪些？', '再新建一个规则集叫测试', '']) assert.equal(classifyMaidPendingActionReply(text), 'none', text);
  // 与语音协议同一套明确确认词；含糊回答打字时算确认，语音中是 ambiguous（不执行也不作废）
  for (const text of ['允许一次', '我允许', '允许执行', 'allow once', 'yes, allow', 'Yes']) assert.equal(classifyMaidPendingActionReply(text), 'confirm', text);
  for (const text of ['允许', '允许一次', '确认后执行', 'yes']) assert.equal(classifyMaidPendingActionReply(text, { voice: true }), 'confirm', `voice ${text}`);
  for (const text of ['好', '好的', '可以', 'ok', '嗯', '没问题']) assert.equal(classifyMaidPendingActionReply(text, { voice: true }), 'ambiguous', `voice ${text}`);
  assert.equal(classifyMaidPendingActionReply('取消', { voice: true }), 'cancel');
  assert.equal(classifyMaidPendingActionReply('允许，但保留第二个'), 'none', 'a confirmation with conditions is a new request');
  // 整句话的含义都交给模型，包括取消的自然表达；快捷入口不再拆句判断。
  for (const text of ['允许，但第二个别删', '确认，第三个不删', '好的，谢谢', '允许一次，但第二个别删', '允许执行，但第二个别删', '好的，算了', '允许，还是算了', '先不删第二个']) {
    assert.equal(classifyMaidPendingActionReply(text), 'none', text);
    assert.equal(classifyMaidPendingActionReply(text, { voice: true }), 'none', `voice ${text}`);
  }
  for (const text of ['别删', '先不删了']) assert.equal(classifyMaidPendingActionReply(text), 'cancel', text);
  console.log('ok - pending delete replies only accept short explicit confirmations');
}

// 待确认工作流只在所属通话/任务内生效：导入角色卡建房清单与删除清单同一规则
{
  const voiceRun = { metadata: { voiceCallId: 'call-a', submissionId: 'task-1' } };
  assert.equal(isPendingRunInContext(voiceRun, {}), false, 'bare typed confirmations cannot consume a voice list');
  assert.equal(isPendingRunInContext(voiceRun, { pendingActionSubmissionId: 'task-1' }), true, 'an explicitly selected task can continue after the call');
  assert.equal(isPendingRunInContext(voiceRun, { voiceCallId: 'call-b', pendingActionSubmissionId: 'task-1' }), false);
  assert.equal(isPendingRunInContext(voiceRun, { voiceCallId: 'call-a' }), true);
  assert.equal(isPendingRunInContext(voiceRun, { voiceCallId: 'call-b' }), false);
  assert.equal(isPendingRunInContext(voiceRun, { voiceCallId: 'call-a', pendingActionSubmissionId: 'task-2' }), false);
  const snapshot = buildMaidImportedCardWorkflowSnapshot({
    persona: { id: 'p1', name: '卡' }, worldbook: { id: 'wb1', name: '书' },
    classification: { candidates: [{ entryId: 'e1', name: '甲', confidence: 0.9 }] },
  });
  const typedRun = { id: 'typed', status: 'waiting_permission', metadata: { pendingWorkflow: snapshot } };
  assert.equal(resolvePendingMaidImportedCardWorkflow([typedRun]).runId, 'typed');
  assert.equal(resolvePendingMaidImportedCardWorkflow([typedRun], { context: { voiceCallId: 'call-a' } }), null, 'a voice confirmation cannot confirm a text-chat setup list');
  const callRun = { ...typedRun, id: 'voice', metadata: { ...typedRun.metadata, voiceCallId: 'call-a', submissionId: 'task-1' } };
  assert.equal(resolvePendingMaidImportedCardWorkflow([callRun]), null);
  assert.equal(resolvePendingMaidImportedCardWorkflow([callRun], { context: { voiceCallId: 'call-a' } }).runId, 'voice');
  assert.equal(resolvePendingMaidImportedCardWorkflow([callRun], { context: { voiceCallId: 'call-a', pendingActionSubmissionId: 'task-9' } }), null, 'a confirmation aimed at another task skips this list');
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, logger: { warn() {} } });
  runtime.startRun({ ...callRun, kind: 'maid_assistant' });
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, logger: { warn() {}, debug() {} } });
  assert.equal(agent.cancelPendingAction({ voiceCallId: 'call-b', submissionId: 'task-1' }), false);
  assert.equal(agent.cancelPendingAction({ voiceCallId: 'call-a', submissionId: 'task-1' }), true, 'revision can retire the old imported-card list too');
  assert.equal(resolvePendingMaidImportedCardWorkflow(store.listRuns(), { context: { voiceCallId: 'call-a' } }), null);
  console.log('ok - pending workflows only answer confirmations from their own call and task');
}

// 本轮最后一次删除是预览才算待确认；预览后又真正执行过则不是
{
  const preview = { toolName: 'regex.delete_many', featureId: 'regex.delete_many', title: '删除正则', args: { targets: ['甲', '乙', '找不到'], preview: true }, status: 'succeeded', output: { ok: true, preview: true, plannedCount: 2, items: [{ id: 'id-a', name: '规则集「甲」', status: 'planned' }, { id: 'id-b', name: '规则集「乙」', status: 'planned' }, { name: '找不到', status: 'missing' }] } };
  const pending = buildMaidPendingActionFromSteps([{ toolName: 'regex.list', args: {}, status: 'succeeded', output: {} }, preview], { now: 1000 });
  assert.deepEqual(pending.args, { targets: ['id-a', 'id-b'] }, 'freeze only resolved planned IDs, never names or missing targets');
  assert.deepEqual(pending.items, ['规则集「甲」', '规则集「乙」']);
  assert.equal(pending.expiresAt > 1000, true);
  assert.equal(buildMaidPendingActionFromSteps([preview, { ...preview, args: { targets: ['甲', '乙'] } }]), null, 'already executed');
  assert.equal(buildMaidPendingActionFromSteps([{ ...preview, output: { ok: true, preview: true, plannedCount: 0, items: [] } }]), null, 'nothing to delete');
  const run = { id: 'r1', status: 'waiting_permission', metadata: { pendingWorkflow: pending } };
  assert.equal(resolvePendingMaidAction([run], { now: 2000 }).runId, 'r1');
  assert.equal(resolvePendingMaidAction([run], { now: pending.expiresAt + 1 }), null, 'expired');
  assert.equal(resolvePendingMaidAction([{ ...run, status: 'succeeded' }], { now: 2000 }), null);
  console.log('ok - a delete preview at the end of a turn becomes a frozen pending action');
}

// 完整流程：预览 → 待确认 → “确认后执行”原样执行（不再经过规划模型）；取消与改说别的都不会删除
{
  const setup = () => {
    const deleted = [];
    const registry = createAgentToolRegistry({ logger: { warn() {}, debug() {} } });
    registry.register({
      name: 'regex.delete_many', title: 'Delete regex', description: 'Delete regex', source: 'test', permissions: [], riskLevel: 'high',
      schema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, preview: { type: 'boolean' } } },
      execute: async (args) => (args.preview
        ? { ok: true, preview: true, plannedCount: args.targets.length, items: args.targets.map(name => ({ id: name, name, status: 'planned' })) }
        : (deleted.push(...args.targets), { ok: true, results: args.targets.map(name => ({ target: name, id: name, name, status: 'succeeded' })) })),
    });
    const store = new AgentRunStore();
    const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
    let plannerCalls = 0;
    const agent = createMaidAssistantAgent({
      agentTaskRuntime: runtime,
      toolRegistry: registry,
      planner: async (input) => {
        plannerCalls += 1;
        if (/删除/.test(input)) return { ok: true, toolName: 'regex.delete_many', args: { targets: ['批测甲', '批测乙'], preview: true }, featureId: 'regex.delete_many', title: '删除正则', response: '先列清单。' };
        return { ok: true, action: 'final', message: '好的。' };
      },
      reactPlanner: async (_input, context) => {
        const last = context.maidReactSteps.at(-1);
        return { ok: true, action: 'final', message: last?.args?.preview ? '要删除这两个规则集，请回复「确认后执行」。' : '已删除。' };
      },
      logger: { warn() {}, debug() {} },
    });
    return { agent, deleted, store, planner: () => plannerCalls };
  };

  const confirmFlow = setup();
  const preview = await confirmFlow.agent.runPrompt('删除规则集「批测甲」和「批测乙」');
  assert.equal(preview.status, 'awaiting_confirmation');
  assert.equal(confirmFlow.deleted.length, 0, 'preview deletes nothing');
  assert.equal(confirmFlow.store.listRuns().find(run => run.metadata?.pendingWorkflow)?.status, 'waiting_permission');
  const callsBefore = confirmFlow.planner();
  const confirmed = await confirmFlow.agent.runPrompt('确认后执行');
  assert.equal(confirmFlow.planner(), callsBefore, 'the confirmed list runs without re-planning (no intent gate on the bare confirmation)');
  assert.deepEqual(confirmFlow.deleted, ['批测甲', '批测乙']);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmFlow.store.listRuns().find(run => run.metadata?.pendingWorkflow)?.metadata.pendingWorkflow.state, 'consumed');
  await confirmFlow.agent.runPrompt('确认后执行');
  assert.equal(confirmFlow.deleted.length, 2, 'a consumed list is never executed twice');

  const cancelFlow = setup();
  await cancelFlow.agent.runPrompt('删除规则集「批测甲」和「批测乙」');
  const cancelled = await cancelFlow.agent.runPrompt('算了');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelFlow.deleted.length, 0);

  const supersedeFlow = setup();
  await supersedeFlow.agent.runPrompt('删除规则集「批测甲」和「批测乙」');
  await supersedeFlow.agent.runPrompt('今天天气怎么样');
  await supersedeFlow.agent.runPrompt('确认');
  assert.equal(supersedeFlow.deleted.length, 0, 'a later confirmation cannot revive a list the user moved away from');
  console.log('ok - preview, confirm, cancel and supersede keep deletes explicit and exact');
}

// 真实工具链：同名新项目、看起来像旧 id 的名称、跨脚本作用域与跨房间都不能替换预览目标。
for (const scenario of ['regex-name', 'regex-missing-id', 'preset-name', 'script-scope', 'script-duplicate-ids', 'regex-session']) {
  const sets = [{ id: 'original', name: '临时', rules: [] }];
  const presets = [{ id: 'original', name: '临时' }, { id: 'keep', name: '保留' }];
  const scripts = { global: [{ id: 'original', name: '临时' }], character: [] };
  if (scenario === 'script-duplicate-ids') scripts.character.push({ id: 'original', name: '另一脚本' });
  const sessions = { 'room-a': { rules: [{ id: 'room-rule', scriptName: '房内规则' }] }, 'room-b': { rules: [{ id: 'room-rule', scriptName: '房内规则' }] } };
  const deleted = [], confirmations = [];
  const regexStore = {
    getGlobal: () => ({ rules: [] }), listLocalSets: () => sets,
    getLocalSet: id => sets.find(item => item.id === id),
    removeLocalSet: async id => { deleted.push(id); sets.splice(sets.findIndex(item => item.id === id), 1); },
    getSession: id => sessions[id], setSession: async (id, value) => { sessions[id] = value; },
  };
  const presetStore = {
    listSummaries: () => presets, getSelectionState: () => ({ builtinActive: { openai: 'keep' } }),
    remove: async (_type, id) => { deleted.push(id); presets.splice(presets.findIndex(item => item.id === id), 1); },
  };
  const scriptStore = {
    listScopes: () => ({ character: ['card-a'], preset: [] }), getScripts: scope => scripts[scope] || [],
    deleteScript: async (scope, _scopeId, id) => { deleted.push(`${scope}:${id}`); scripts[scope] = scripts[scope].filter(item => item.id !== id); },
  };
  const logger = { warn() {}, debug() {} }, registry = createAgentToolRegistry({ logger });
  registry.registerMany(createPresetRegexScriptAgentTools({ regexStore, presetStore, scriptStore }));
  const store = new AgentRunStore();
  const [toolName, args] = scenario.startsWith('preset') ? ['preset.delete_many', { type: 'openai', presets: ['临时', '将来才出现'] }]
    : scenario.startsWith('script') ? ['script.delete_many', { scripts: scenario === 'script-duplicate-ids' ? ['临时', '另一脚本'] : ['临时'] }]
      : ['regex.delete_many', { targets: [scenario === 'regex-session' ? '房内规则' : '临时'] }];
  const agent = createMaidAssistantAgent({ toolRegistry: registry,
    agentTaskRuntime: createAgentTaskRuntime({ store, toolRegistry: registry, logger }), logger,
    planner: async () => ({ ok: true, toolName, featureId: toolName, args: { ...args, preview: true } }),
    reactPlanner: async () => ({ ok: true, action: 'final', message: '完成这一轮。' }),
  });
  const context = { sessionId: 'room-a', requestToolConfirmation: request => { confirmations.push(request); return { decision: 'allow' }; } };
  assert.equal((await agent.runPrompt('删除这些项目，先预览', context)).status, 'awaiting_confirmation');
  assert.equal(confirmations.length, 0);
  const persisted = store.listRuns().find(run => run.metadata?.pendingWorkflow)?.metadata.pendingWorkflow;
  assert.equal(persisted.version, 2);
  if (scenario === 'regex-name') { sets[0].name = '旧名字'; sets.push({ id: 'replacement', name: '临时', rules: [] }); }
  if (scenario === 'regex-missing-id') { sets.splice(0); sets.push({ id: 'replacement', name: 'original', rules: [] }); }
  if (scenario === 'preset-name') { presets[0].name = '旧名字'; presets.push({ id: 'replacement', name: '临时' }, { id: 'new', name: '将来才出现' }); }
  if (scenario === 'script-scope') { scripts.global[0].name = '旧名字'; scripts.character.push({ id: 'original', name: '临时' }); }
  await agent.runPrompt('确认', { ...context, sessionId: 'room-b' });
  if (scenario === 'regex-session') {
    assert.equal(sessions['room-a'].rules.length, 0, 'the previewed room is used even after switching rooms');
    assert.equal(sessions['room-b'].rules.length, 1);
  } else {
    const expected = scenario === 'regex-missing-id' ? [] : scenario === 'script-duplicate-ids' ? ['global:original', 'character:original'] : [scenario === 'script-scope' ? 'global:original' : 'original'];
    assert.deepEqual(deleted, expected, scenario);
  }
  assert.equal(confirmations.length, scenario === 'regex-missing-id' ? 0 : 1, 'actual deletes still require APP confirmation');
}
console.log('ok - confirmed deletions keep exact IDs and scopes, without name fallback or newly found targets');

// 语音中的含糊回答：清单保留、不删除，之后明确“允许一次”才执行
{
  const deleted = [];
  const registry = createAgentToolRegistry({ logger: { warn() {}, debug() {} } });
  registry.register({
    name: 'regex.delete_many', title: 'Delete regex', description: 'Delete regex', source: 'test', permissions: [], riskLevel: 'high',
    schema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, preview: { type: 'boolean' } } },
    execute: async (args) => (args.preview
      ? { ok: true, preview: true, plannedCount: args.targets.length, items: args.targets.map(name => ({ id: name, name, status: 'planned' })) }
      : (deleted.push(...args.targets), { ok: true, results: args.targets.map(name => ({ target: name, id: name, name, status: 'succeeded' })) })),
  });
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: runtime,
    toolRegistry: registry,
    planner: async input => (/删除/.test(input)
      ? { ok: true, toolName: 'regex.delete_many', args: { targets: ['批测甲'], preview: true }, featureId: 'regex.delete_many', title: '删除正则', response: '先列清单。' }
      : { ok: true, action: 'final', message: '好的。' }),
    reactPlanner: async () => ({ ok: true, action: 'final', message: '请确认。' }),
    logger: { warn() {}, debug() {} },
  });
  const voice = { source: 'maid_realtime', voiceCallId: 'call-a', submissionId: 'task-1' };
  assert.equal((await agent.runPrompt('删除规则集「批测甲」', voice)).status, 'awaiting_confirmation');
  const vague = await agent.runPrompt('好', { source: 'maid_realtime', voiceCallId: 'call-a', submissionId: 'task-2' });
  assert.equal(vague.status, 'responded', 'not a new awaiting task, so a later 允许 still targets the original list');
  assert.match(vague.message, /允许/);
  assert.deepEqual(deleted, []);
  assert.equal(store.listRuns().find(run => run.metadata?.pendingWorkflow)?.metadata.pendingWorkflow.state, 'pending', 'the list is kept');
  await agent.runPrompt('允许一次', { source: 'maid_realtime', voiceCallId: 'call-b', submissionId: 'task-3' });
  assert.deepEqual(deleted, [], 'another call cannot confirm it');
  await agent.runPrompt('允许一次', { source: 'maid_realtime', voiceCallId: 'call-a', submissionId: 'task-4' });
  assert.deepEqual(deleted, ['批测甲']);
  console.log('ok - vague voice replies keep the pending list until an explicit allow');
}

// 建房清单：短答复可宽松确认（与语音同一套含糊词），否定与带条件的确认不执行整份清单
{
  for (const text of ['好', '好吧', 'ok', '嗯', '可以的', '允许', '确认', '开始', '就按这份清单来']) assert.equal(classifyMaidImportedCardConfirmation(text), 'confirm', text);
  for (const text of ['不同意', '我不确认', '取消', '不用了']) assert.equal(classifyMaidImportedCardConfirmation(text), 'cancel', text);
  for (const text of ['确认，但不要创建群聊', '确认，除了第二个', '没确认过', '帮我看看第二个是谁', '我没有确认', '确认，跳过第二个', '取消第二个，其他照常', '不同意第二项，其他照常', '确认，按这个清单帮我建好房间']) assert.equal(classifyMaidImportedCardConfirmation(text), 'none', text);
  console.log('ok - imported-card setup confirmations accept short replies but never negations or conditional confirms');
}

// 带条件的回复交给模型：旧清单作废，本次任务带上原清单的功能（不被高风险检查挡掉），也不按只读查询处理
{
  const registry = createAgentToolRegistry({ logger: { warn() {}, debug() {} } });
  registry.register({
    name: 'regex.delete_many', title: 'Delete regex', description: 'Delete regex', source: 'test', permissions: [], riskLevel: 'high',
    schema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, preview: { type: 'boolean' } } },
    execute: async args => ({ ok: true, preview: true, plannedCount: args.targets.length, items: args.targets.map(name => ({ id: name, name, status: 'planned' })) }),
  });
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const seen = [];
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: runtime,
    toolRegistry: registry,
    planner: async (input, context) => {
      seen.push({ input, revision: context.pendingActionRevision, intent: context.operationIntentPolicy?.mode });
      if (/删除规则集/.test(input)) return { ok: true, toolName: 'regex.delete_many', args: { targets: ['甲', '乙'], preview: true }, featureId: 'regex.delete_many', title: '删除正则', response: '先列清单。' };
      return { ok: true, action: 'final', message: '好的。' };
    },
    reactPlanner: async () => ({ ok: true, action: 'final', message: '请确认。' }),
    logger: { warn() {}, debug() {} },
  });
  await agent.runPrompt('删除规则集甲和乙');
  await agent.runPrompt('确认，但保留乙，只删甲');
  const reply = seen.at(-1);
  assert.equal(reply.input, '确认，但保留乙，只删甲', 'the full reply reaches the model');
  assert.deepEqual(reply.revision, { featureId: 'regex.delete_many', toolName: 'regex.delete_many' });
  assert.notEqual(reply.intent, 'read_only', 'a reply to a pending write list is not a read-only query');
  assert.equal(store.listRuns().find(run => run.metadata?.pendingWorkflow)?.metadata.pendingWorkflow.state, 'superseded');
  await agent.runPrompt('今天天气怎么样');
  assert.equal(seen.at(-1).revision, undefined, 'only the reply right after the list carries it');
  console.log('ok - a conditional reply goes to the model with the pending list feature available');
}

console.log('maid pending action tests passed');
