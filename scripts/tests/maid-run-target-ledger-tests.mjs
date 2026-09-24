import assert from 'node:assert/strict';

import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import {
  ALREADY_DELETED_REASON,
  buildMaidStepActionKey,
  buildMaidTargetAliases,
  countConsecutiveSameAction,
  findAlreadyDeletedTargets,
  resolveMaidRunOutcome,
} from '../../src/scripts/agent/maid-run-target-ledger.js';

const deleteStep = (index, targets, results, status = 'succeeded') => ({
  index, toolName: 'regex.delete_many', args: { targets }, status, output: { ok: status === 'succeeded', results },
});

// ── 删除幂等：按 ID 删过的目标，再按名称删也能认出来 ──
{
  const steps = [deleteStep(3, ['re-set-1'], [{ target: 're-set-1', type: 'set', id: 're-set-1', name: '性能测试临时', status: 'succeeded' }])];
  const byName = findAlreadyDeletedTargets({ toolName: 'regex.delete_many', args: { targets: ['性能测试 临时'] } }, steps);
  assert.deepEqual(byName.deleted, [{ target: '性能测试 临时', stepIndex: 3, label: '性能测试临时' }]);
  assert.deepEqual(byName.remaining, []);
  const mixed = findAlreadyDeletedTargets({ toolName: 'regex.delete_many', args: { targets: ['re-set-1', '别的组'] } }, steps);
  assert.deepEqual(mixed.remaining, ['别的组']);
  assert.equal(findAlreadyDeletedTargets({ toolName: 'script.delete_many', args: { scripts: ['re-set-1'] } }, steps), null, 'other resource kinds are separate');
  const missingBefore = [deleteStep(1, ['x'], [{ target: 'x', status: 'missing', reason: 'not_found' }], 'failed')];
  assert.equal(findAlreadyDeletedTargets({ toolName: 'regex.delete_many', args: { targets: ['x'] } }, missingBefore), null, 'only real deletions count');
  const presetSteps = [{ index: 1, toolName: 'preset.delete_many', args: { type: 'openai', presets: ['A'] }, status: 'succeeded', output: { results: [{ target: 'A', presetId: 'p1', name: 'A', status: 'succeeded' }] } }];
  assert.equal(findAlreadyDeletedTargets({ toolName: 'preset.delete_many', args: { type: 'sysprompt', presets: ['A'] } }, presetSteps), null, 'preset types are separate');
  console.log('ok - already deleted targets are recognised by id or name');
}

{
  const listed = items => ({ toolName: 'regex.list', status: 'succeeded', output: { sets: items } });
  const a = { id: 'set-a', name: '同名' };
  const b = { id: 'set-b', name: '同名' };
  const removed = deleteStep(2, [a.id], [{ ...a, target: a.id, type: 'set', status: 'succeeded' }]);
  const plan = { toolName: 'regex.delete_many', args: { targets: ['同名'], kind: 'set' } };
  assert.equal(findAlreadyDeletedTargets(plan, [listed([a, b]), removed, listed([b])]), null, 'a remaining same-name object must still be deleted');
  assert.equal(findAlreadyDeletedTargets(plan, [removed, listed([b])]), null, 'a newly created same-name object has a different identity');
  assert.deepEqual(findAlreadyDeletedTargets({ ...plan, args: { targets: [a.id] } }, [listed([a, b]), removed]).remaining, [], 'an exact deleted ID remains idempotent despite name ambiguity');
  const otherResource = { toolName: 'script.list', status: 'succeeded', output: { scripts: [{ id: 'script-a', name: '同名' }] } };
  assert.deepEqual(findAlreadyDeletedTargets(plan, [otherResource, removed]).remaining, [], 'names in another resource family do not prevent an unambiguous repeat');
  assert.equal(findAlreadyDeletedTargets(plan, [removed, listed(Array.from({ length: 4100 }, (_, index) => ({ id: `other-${index}`, name: `其他${index}` })))]), null, 'an incomplete scan cannot prove a name is unique');
  console.log('ok - deletion idempotency does not conflate different same-name objects');
}

// 通用读取列出的同类对象也算名称证据；别的资源的通用读取不算
{
  const removed = deleteStep(2, ['re-a'], [{ target: 're-a', id: 're-a', name: '同名', status: 'succeeded' }]);
  const plan = { toolName: 'regex.delete_many', args: { targets: ['同名'] } };
  const readRegex = { toolName: 'app.read_resource', args: { resource: 'regexes' }, status: 'succeeded', output: { resource: 'regex', sets: [{ id: 're-a', name: '同名' }, { id: 're-b', name: '同名' }] } };
  assert.equal(findAlreadyDeletedTargets(plan, [readRegex, removed]), null, 'a same-name set seen through app.read_resource must still be deleted');
  const readPersona = { toolName: 'app.read_resource', args: { resource: 'persona' }, status: 'succeeded', output: { resource: 'persona', personas: [{ id: 'p-1', name: '同名' }] } };
  assert.deepEqual(findAlreadyDeletedTargets(plan, [readPersona, removed]).remaining, [], 'another resource read does not block an unambiguous repeat');
  console.log('ok - generic resource reads count as evidence for their own resource only');
}

// 一次很深的读取不会让整轮的名称与 ID 对应失效
{
  const list = { toolName: 'regex.list', status: 'succeeded', output: { sets: [{ id: 're-1', name: '临时' }] } };
  const deepCard = { toolName: 'app.read_resource', args: { resource: 'persona' }, status: 'succeeded',
    output: { resource: 'persona', persona: { data: { character_book: { entries: [{ extensions: { depth_prompt: { nested: { role: 'system' } } } }] } } } } };
  assert.equal(buildMaidTargetAliases([list, deepCard]).get('临时'), 're-1', 'deep subtrees are skipped, not treated as an incomplete scan');
  const deepRegex = { toolName: 'regex.list', status: 'succeeded', output: { a: { b: { c: { d: { e: { f: { g: { id: 're-9', name: '深处' } } } } } } }, sets: [{ id: 're-1', name: '临时' }] } };
  assert.equal(buildMaidTargetAliases([deepRegex]).get('临时'), 're-1');
  const toggle = (target, status) => ({ toolName: 'regex.toggle', args: { targets: [target], enabled: false }, status, output: {} });
  assert.equal(countConsecutiveSameAction([deepCard, list, toggle('re-1', 'failed'), toggle('临时', 'failed'), toggle('re-1', 'failed')], 'failed').count, 3);
  const isWriteTool = name => ({ 'regex.toggle': true, 'regex.list': false, 'app.read_resource': false })[name];
  assert.deepEqual(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [deepCard, list, toggle('re-1', 'succeeded'), toggle('临时', 'failed')] }),
    { ok: true, reason: 'redundant_repeat' });
  console.log('ok - a deep read does not disable name/id matching for the run');
}

// ── 重复检测看目标：按名称与按 ID 的同一操作算同一件事；内容不同仍是不同操作 ──
{
  const listStep = { index: 1, toolName: 'regex.list', args: {}, status: 'succeeded', output: { sets: [{ id: 're-set-1', name: '性能测试临时' }, { id: 'dup-1', name: '同名' }, { id: 'dup-2', name: '同名' }] } };
  const aliases = buildMaidTargetAliases([listStep]);
  assert.equal(aliases.get('性能测试临时'), 're-set-1');
  assert.equal(aliases.has('同名'), false, 'ambiguous names are not aliased');
  const toggle = (index, target, enabled, status) => ({ index, toolName: 'regex.toggle', args: { targets: [target], enabled, kind: 'set' }, status, output: {} });
  assert.equal(buildMaidStepActionKey(toggle(2, 're-set-1', false), aliases), buildMaidStepActionKey(toggle(3, '性能测试临时', false), aliases));
  assert.notEqual(buildMaidStepActionKey(toggle(2, 're-set-1', false), aliases), buildMaidStepActionKey(toggle(3, 're-set-1', true), aliases));
  const failures = countConsecutiveSameAction([listStep, toggle(2, 're-set-1', false, 'failed'), toggle(3, '性能测试临时', false, 'failed'), toggle(4, 're-set-1', false, 'failed')], 'failed');
  assert.equal(failures.count, 3);
  const successes = countConsecutiveSameAction([listStep, toggle(2, 're-set-1', false, 'succeeded'), toggle(3, '性能测试临时', true, 'succeeded')], 'succeeded');
  assert.equal(successes.count, 1, 'different switch value is a different action');
  console.log('ok - repeat detection compares targets, not argument spelling');
}

// ── 成败看目标 ──
{
  const isWriteTool = name => ({ 'regex.toggle': true, 'regex.upsert_rules': true, 'regex.list': false })[name];
  const listStep = { index: 1, toolName: 'regex.list', args: {}, status: 'succeeded', output: { sets: [{ id: 're-set-1', name: '临时' }] } };
  const ok = (toolName, args, index) => ({ index, toolName, args, status: 'succeeded', output: {} });
  const fail = (toolName, args, index) => ({ index, toolName, args, status: 'failed', output: {} });
  assert.deepEqual(resolveMaidRunOutcome({ lastOk: true, steps: [], isWriteTool }), { ok: true, reason: '' });
  assert.deepEqual(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [listStep,
    ok('regex.toggle', { targets: ['re-set-1'], enabled: false }, 2),
    fail('regex.toggle', { targets: ['临时'], enabled: false }, 3)] }), { ok: true, reason: 'redundant_repeat' });
  assert.deepEqual(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    ok('regex.upsert_rules', { newSetName: '临时', rules: [] }, 1),
    fail('regex.list', {}, 2)] }), { ok: true, reason: 'goal_reached' });
  assert.deepEqual(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    fail('regex.upsert_rules', { newSetName: '临时', rules: [1] }, 1),
    ok('regex.upsert_rules', { newSetName: '临时', rules: [2] }, 2),
    fail('regex.list', {}, 3)] }), { ok: true, reason: 'goal_reached' }, 'a corrected write reaches the target');
  assert.equal(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    ok('regex.upsert_rules', { newSetName: '甲', rules: [] }, 1),
    fail('regex.upsert_rules', { newSetName: '乙', rules: [] }, 2),
    fail('regex.list', {}, 3)] }).ok, false, 'an unreached write target keeps the run failed');
  assert.equal(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    ok('regex.toggle', { targets: ['re-set-1'], enabled: false }, 1),
    fail('regex.toggle', { targets: ['re-set-1'], enabled: true }, 2)] }).ok, false, 'a new, different write that failed is a real failure');
  assert.equal(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [fail('regex.list', {}, 1)] }).ok, false, 'read-only runs still follow the read result');
  assert.equal(resolveMaidRunOutcome({ lastOk: false, steps: [ok('x.unknown', {}, 1), fail('y.unknown', {}, 2)] }).ok, false, 'unknown tools are not assumed read-only');
  const toggleArgs = (id, enabled = false) => ({ targets: [id], enabled });
  assert.equal(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    ok('regex.toggle', toggleArgs('a'), 1),
    fail('regex.toggle', toggleArgs('b'), 2),
    fail('regex.toggle', toggleArgs('a'), 3)] }).ok, false, 'a redundant repeat cannot hide another failed target');
  assert.equal(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    ok('regex.list', {}, 1),
    fail('regex.toggle', toggleArgs('b'), 2),
    fail('regex.list', {}, 3)] }).ok, false, 'a previously successful read cannot hide a failed write');
  assert.equal(resolveMaidRunOutcome({ lastOk: false, isWriteTool, steps: [
    ok('regex.toggle', toggleArgs('a'), 1),
    ok('regex.toggle', toggleArgs('a', true), 2),
    fail('regex.toggle', toggleArgs('a'), 3)] }).ok, false, 'an intervening write invalidates the earlier achieved state');
  console.log('ok - run outcome follows target state, not only the last step');
}

// ── 集成：模型按 ID 删完又按名称删，第二次不再调用工具，整次任务成功 ──
{
  const calls = [];
  let exists = true;
  let reactCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({ ok: true, toolName: 'regex.delete_many', args: { targets: ['re-set-1'] }, featureId: 'regex.delete_many', title: '删除正则', response: '我来删除。' }),
    reactPlanner: async () => {
      reactCalls += 1;
      if (reactCalls === 1) return { ok: true, action: 'tool', toolName: 'regex.delete_many', args: { targets: ['性能测试临时'] }, featureId: 'regex.delete_many', title: '按名称删除', response: '我再按名称确认删除。' };
      return { ok: true, action: 'final', message: '已删除「性能测试临时」。' };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'regex.list') return { toolName, status: 'succeeded', result: { ok: true, global: { rules: [] }, sets: exists ? [{ id: 're-set-1', name: '性能测试临时' }] : [] } };
        if (toolName === 'regex.delete_many') {
          const hit = exists && args.targets.some(target => target === 're-set-1' || target === '性能测试临时');
          if (hit) {
            exists = false;
            return { toolName, status: 'succeeded', result: { ok: true, requestedCount: 1, succeededCount: 1, skippedCount: 0, failedCount: 0, results: [{ target: args.targets[0], type: 'set', id: 're-set-1', name: '性能测试临时', status: 'succeeded' }] } };
          }
          return { toolName, status: 'succeeded', result: { ok: false, requestedCount: 1, succeededCount: 0, skippedCount: 1, failedCount: 0, results: [{ target: args.targets[0], status: 'missing', reason: 'not_found' }] } };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('删除正则组「性能测试临时」');
  assert.equal(calls.filter(call => call.toolName === 'regex.delete_many').length, 1, 'the second delete is answered from the run ledger');
  const repeat = result.steps.filter(step => step.toolName === 'regex.delete_many').at(-1);
  assert.equal(repeat.status, 'succeeded');
  assert.equal(repeat.output.reason, ALREADY_DELETED_REASON);
  assert.match(repeat.summary, /「性能测试临时」已在第 1 步删除，无需重复/);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  console.log('ok - repeated delete in one run is skipped and the run succeeds');
}

// ── 集成：最后一步是对已完成目标的多余失败，整次任务仍成功 ──
{
  let reactCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({ ok: true, toolName: 'regex.toggle', args: { targets: ['re-set-1'], enabled: false, kind: 'set' }, featureId: 'regex.toggle', title: '停用正则', response: '我来停用。' }),
    reactPlanner: async () => {
      reactCalls += 1;
      if (reactCalls === 1) return { ok: true, action: 'tool', toolName: 'regex.toggle', args: { targets: ['临时组'], enabled: false, kind: 'set' }, featureId: 'regex.toggle', title: '再停用一次', response: '再确认一下。' };
      return { ok: true, action: 'final', message: '已停用。' };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        if (toolName === 'regex.list') return { toolName, status: 'succeeded', result: { ok: true, sets: [{ id: 're-set-1', name: '临时组', enabled: false }] } };
        if (args.targets[0] === 're-set-1') return { toolName, status: 'succeeded', result: { ok: true, results: [{ target: 're-set-1', type: 'set', id: 're-set-1', name: '临时组', status: 'succeeded' }] } };
        return { toolName, status: 'succeeded', result: { ok: false, reason: 'toggle_failed', results: [{ target: '临时组', status: 'failed' }] } };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('停用正则组「临时组」');
  assert.equal(result.steps.at(-1).status, 'failed');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outcomeReason, 'redundant_repeat');
  console.log('ok - a redundant failing repeat no longer flips a finished run to failed');
}

// 实际 agent 入口：A 成功、B 失败、重试 A 失败，不能报全部成功。
{
  let reactCalls = 0;
  let toggleCalls = 0;
  const plan = target => ({ ok: true, action: 'tool', toolName: 'regex.toggle', args: { targets: [target], enabled: false, kind: 'set' }, featureId: 'regex.toggle', title: '停用正则', response: '执行下一项。' });
  const agent = createMaidAssistantAgent({
    planner: async () => plan('a'),
    reactPlanner: async () => {
      reactCalls += 1;
      return reactCalls <= 2 ? plan(reactCalls === 1 ? 'b' : 'a') : { ok: true, action: 'final', message: '执行结束。' };
    },
    toolRegistry: { executeTool: async (toolName, args) => {
      if (toolName === 'regex.list') return { toolName, status: 'succeeded', result: { ok: true, sets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } };
      assert.equal(toolName, 'regex.toggle');
      const ok = ++toggleCalls === 1;
      return { toolName, status: 'succeeded', result: { ok, reason: ok ? '' : 'toggle_failed', results: [{ id: args.targets[0], target: args.targets[0], status: ok ? 'succeeded' : 'failed' }] } };
    } },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('停用正则组 A 和 B');
  assert.equal(toggleCalls, 3);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  console.log('ok - an unfinished target keeps the actual maid run failed');
}

// 实际 agent 入口：先按 ID 删除一个，再按唯一名称删除另一个同名对象。
{
  const remaining = new Map([['set-a', { id: 'set-a', name: '同名' }], ['set-b', { id: 'set-b', name: '同名' }]]);
  let reactCalls = 0;
  let deleteCalls = 0;
  const plan = (toolName, args) => ({ ok: true, action: 'tool', toolName, args, featureId: toolName, title: '删除正则', response: '处理目标。' });
  const agent = createMaidAssistantAgent({
    planner: async () => plan('regex.list', {}),
    reactPlanner: async () => {
      reactCalls += 1;
      return reactCalls <= 2
        ? plan('regex.delete_many', { targets: [reactCalls === 1 ? 'set-a' : '同名'], kind: 'set' })
        : { ok: true, action: 'final', message: '已处理。' };
    },
    toolRegistry: { executeTool: async (toolName, args) => {
      if (toolName === 'regex.list') return { toolName, status: 'succeeded', result: { ok: true, sets: [...remaining.values()] } };
      assert.equal(toolName, 'regex.delete_many');
      deleteCalls += 1;
      const query = args.targets[0];
      const target = remaining.get(query) || [...remaining.values()].find(item => item.name === query);
      assert.ok(target);
      remaining.delete(target.id);
      return { toolName, status: 'succeeded', result: { ok: true, results: [{ ...target, target: query, type: 'set', status: 'succeeded' }] } };
    } },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('删除两个同名正则组，先删除 set-a，再删除剩下的那个');
  assert.equal(deleteCalls, 2, 'both existing IDs must reach the deletion tool');
  assert.equal(remaining.size, 0);
  assert.equal(result.ok, true);
  console.log('ok - the actual maid run deletes both same-name objects');
}

console.log('maid run target ledger tests passed');

// 任务卡的“执行模型”与分段计时：首次模型调用返回后记到 run 上，失败的函数调用尝试不算
{
  const { createAgentTaskRuntime } = await import('../../src/scripts/agent/agent-task-runtime.js');
  const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
  const { AgentRunStore } = await import('../../src/scripts/storage/agent-run-store.js');
  const registry = createAgentToolRegistry({ logger: { warn() {}, debug() {} } });
  registry.register({
    name: 'regex.list', title: 'List regex', description: 'List regex', source: 'test', permissions: [],
    schema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true, sets: [] }),
  });
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: runtime,
    toolRegistry: registry,
    planner: async (_input, context) => {
      context.onModelUsage?.({ model: 'gemini-3.8-flash', latencyMs: 40000, transport: 'provider_fc', outcome: 'provider_request_failed', error: 'Vertex AI Error: 400' });
      context.onModelUsage?.({ model: 'deepseek-flash', latencyMs: 1200, promptTokens: 5400, completionTokens: 200 });
      return { ok: true, toolName: 'regex.list', args: {}, featureId: 'regex.list', title: '查看正则', response: '我看看。' };
    },
    reactPlanner: async (_input, context) => {
      context.onModelUsage?.({ model: 'deepseek-flash', latencyMs: 900, promptTokens: 6400, completionTokens: 100 });
      return { ok: true, action: 'final', message: '一共 0 个正则组。' };
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('看看有几个正则组');
  assert.equal(result.ok, true);
  const run = store.listRuns().find(item => item.kind === 'maid_assistant');
  assert.equal(run.metadata.executionModel, 'deepseek-flash', 'the failed FC attempt model is not shown as the executor');
  const calls = run.metadata.timing.modelCalls;
  assert.deepEqual(calls.map(call => call.phase), ['maid_planner', 'maid_planner', 'maid_react']);
  assert.equal(calls[0].outcome, 'provider_request_failed');
  assert.match(calls[0].error, /400/);
  assert.equal(calls[1].promptTokens, 5400);
  assert.ok(run.metadata.timing.promptStartedAt > 0);
  console.log('ok - the run records its executing model and per-call timing');
}
