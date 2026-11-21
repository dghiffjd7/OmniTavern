import assert from 'node:assert/strict';

import {
  aggregateMaidModelUsage,
  buildContinueHint,
  createMaidAssistantAgent,
} from '../../src/scripts/agent/maid-assistant-agent.js';
import { setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';
import { buildMaidModelReActMessages } from '../../src/scripts/agent/maid-model-planner.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { normalizeMaidImportedCardClassification } from '../../src/scripts/agent/maid-imported-card-workflow.js';
import { createImportedCardRoomTools } from '../../src/scripts/agent/tools/imported-card-room-tools.js';
import { fingerprintMaidToolCall } from '../../src/scripts/agent/maid-run-continuation.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';

setPromptLocale('en');
const englishContinueHint = buildContinueHint({
  input: 'Finish the task',
  steps: [{ status: 'succeeded', toolName: 'session.list', summary: 'Read sessions' }],
  pendingPlan: { toolName: 'session.create' },
  reason: 'budget',
});
assert.match(englishContinueHint, /Original user goal: Finish the task/);
assert.match(englishContinueHint, /Completed steps .*session\.list \(Read sessions\)/);
assert.doesNotMatch(englishContinueHint, /\p{Script=Han}/u);
setPromptLocale('zh-CN');

{
  // 多轮 ReAct usage 求和：至少一轮返回 token → recorded 且各项相加；latency 求和为模型总耗时
  const usage = aggregateMaidModelUsage([
    { provider: 'deepseek', model: 'v4-pro', promptTokens: 1000, completionTokens: 200, latencyMs: 3000, finishReason: 'stop' },
    { provider: 'deepseek', model: 'v4-pro', promptTokens: 1500, completionTokens: 400, totalTokens: 1900, latencyMs: 2500, degraded: true, finishReason: 'stop' },
  ], { toolCallCount: 2, aborted: false });
  assert.equal(usage.status, 'recorded');
  assert.equal(usage.provider, 'deepseek');
  assert.equal(usage.promptTokens, 2500);
  assert.equal(usage.completionTokens, 600);
  assert.equal(usage.totalTokens, 3100); // = promptSum + completionSum，自洽于分项
  assert.equal(usage.latencyMs, 5500);
  assert.equal(usage.modelCallCount, 2);
  assert.equal(usage.toolCallCount, 2);
  assert.equal(usage.degraded, true);
  assert.equal(usage.aborted, false);
  console.log('ok - aggregateMaidModelUsage sums real token usage across ReAct calls');
}

{
  // 无任何 token（provider 未返回 usage）→ unknown、token 为 null，但本地事实保留
  const usage = aggregateMaidModelUsage([
    { provider: 'anthropic', model: 'opus', latencyMs: 900 },
  ], { toolCallCount: 1, aborted: true });
  assert.equal(usage.status, 'unknown');
  assert.equal(usage.promptTokens, null);
  assert.equal(usage.completionTokens, null);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.latencyMs, 900);
  assert.equal(usage.modelCallCount, 1);
  assert.equal(usage.toolCallCount, 1);
  assert.equal(usage.aborted, true);
  console.log('ok - aggregateMaidModelUsage marks unknown without inventing tokens');
}

{
  // 无任何模型调用（纯规则命中/空）→ latencyMs 也为 null，不伪造
  const usage = aggregateMaidModelUsage([], { toolCallCount: 0 });
  assert.equal(usage.status, 'unknown');
  assert.equal(usage.latencyMs, null);
  assert.equal(usage.modelCallCount, 0);
  assert.equal(usage.toolCallCount, 0);
  console.log('ok - aggregateMaidModelUsage keeps null latency when no model call happened');
}

{
  // 失败的任务：token 全来自 DeepSeek，最后几次是备用模型的失败尝试。次数照实计入，模型不记成备用模型
  const usage = aggregateMaidModelUsage([
    { provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 1000, completionTokens: 50, latencyMs: 800 },
    { provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 1200, completionTokens: 40, latencyMs: 900 },
    { provider: 'makersuite', model: 'gemini-4-carbon', latencyMs: 300, outcome: 'provider_request_failed' },
    // 失败的尝试也可能带回 token（服务商回了 usage 但没有可用内容）：照实相加，仍不决定模型
    { provider: 'makersuite', model: 'gemini-4-carbon', promptTokens: 100, completionTokens: 5, latencyMs: 200, outcome: 'provider_request_failed' },
  ], { toolCallCount: 1 });
  assert.equal(usage.provider, 'deepseek');
  assert.equal(usage.model, 'deepseek-v4-flash');
  assert.equal(usage.modelCallCount, 4);
  assert.equal(usage.promptTokens, 2300);
  assert.equal(usage.completionTokens, 95);
  assert.equal(usage.latencyMs, 2200);

  const noTokens = aggregateMaidModelUsage([
    { provider: 'deepseek', model: 'deepseek-v4-flash', latencyMs: 800 },
    { provider: 'makersuite', model: 'gemini-4-carbon', latencyMs: 300, outcome: 'provider_request_failed' },
  ]);
  assert.deepEqual([noTokens.status, noTokens.provider, noTokens.model], ['unknown', 'deepseek', 'deepseek-v4-flash'], '没有 token 时取最后一次成功调用');

  const allFailed = aggregateMaidModelUsage([
    { provider: 'makersuite', model: 'gemini-4-carbon', latencyMs: 300, outcome: 'provider_request_failed' },
  ]);
  assert.deepEqual([allFailed.provider, allFailed.model, allFailed.modelCallCount], ['', '', 1], '全部失败时不认定执行模型');
  console.log('ok - aggregateMaidModelUsage attributes the model to the call that produced the result, not failed fallbacks');
}

{
  const calls = [];
  const statuses = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书',
      response: '我来打开世界书。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args, context) => {
        calls.push({ toolName, args, context });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true },
          summary: `ran ${toolName}`,
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('打开世界书', {
    sessionId: 's1',
    onStatus: status => statuses.push(status),
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].toolName, 'app.open_panel');
  assert.equal(calls[0].args.panel, 'worldbook');
  assert.equal(calls[0].context.sessionId, 's1');
  assert.equal(calls[0].context.operationIntentPolicy, undefined, '程序不再用关键词判断读写意图（11/20）');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].stage, 'planned');
  assert.equal(statuses[0].message, '我来打开世界书。');
  console.log('ok - maid assistant agent executes planned tools through registry');
}

{
  const order = [];
  const preparedSnapshot = {
    maidContextVersion: 'maid-context-test',
    historyText: '冻结的近期历史',
    memoryText: '冻结的长期记忆',
    tokenCount: 12,
  };
  let routingSnapshot = null;
  let plannerSnapshot = null;
  const agent = createMaidAssistantAgent({
    prepareConversationContext: async ({ input }) => {
      order.push(`prepare:${input}`);
      return preparedSnapshot;
    },
    capabilityRoutingRuntime: {
      beginRequest: ({ context }) => {
        order.push('route');
        routingSnapshot = context.maidConversationContextRef.current;
        return null;
      },
    },
    planner: async (_input, context) => {
      order.push('plan');
      plannerSnapshot = context.maidConversationContextRef.current;
      return {
        ok: true,
        toolName: 'app.open_panel',
        args: { panel: 'worldbook' },
        featureId: 'worldbook.open',
        title: '打开世界书',
      };
    },
    toolRegistry: {
      executeTool: async toolName => ({
        toolName,
        status: 'succeeded',
        result: { ok: true },
        summary: 'opened',
      }),
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('打开世界书');
  assert.equal(result.ok, true);
  assert.deepEqual(order.slice(0, 3), ['prepare:打开世界书', 'route', 'plan']);
  assert.equal(routingSnapshot, preparedSnapshot);
  assert.equal(plannerSnapshot, preparedSnapshot);
  console.log('ok - maid run prepares and freezes async conversation context before routing');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'session.create',
      args: { name: '打开测试房', open: true },
      featureId: 'session.create',
      title: '创建聊天室',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '已创建。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, created: true, sessionId: args.name },
          summary: 'created session',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('创建聊天室「打开测试房」，不要打开');
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    toolName: 'session.create',
    args: { name: '打开测试房', open: true },
  }, '要不要打开照模型给的参数，执行层不看原话改写');
  console.log('ok - maid execution keeps the model-provided open argument');
}

{
  const routingCalls = [];
  const agent = createMaidAssistantAgent({
    capabilityRoutingRuntime: {
      prepareDecision: (options = {}) => {
        routingCalls.push(options);
        return null;
      },
    },
    getCapabilityRoutingConfigOverride: () => ({ mode: 'bounded' }),
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书',
    }),
    toolRegistry: {
      executeTool: async toolName => ({
        toolName,
        status: 'succeeded',
        result: { ok: true },
      }),
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('只读检查当前状态');
  assert.equal(result.ok, true);
  assert.equal(routingCalls.length, 1);
  assert.deepEqual(routingCalls[0].configOverride, { mode: 'bounded' });
  console.log('ok - maid runtime can inject a non-persistent capability routing override');
}

{
  const calls = [];
  let reactIndex = 0;
  const reactDecisions = [
    {
      ok: true,
      action: 'tool',
      toolName: 'user.create',
      args: { name: '主用户', setActive: true },
      featureId: 'user.create',
      title: '创建主用户',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'group.create',
      args: { name: '侍奉部', members: ['雪乃', '结衣'], open: true },
      featureId: 'group.create',
      title: '创建主群聊',
    },
    {
      ok: true,
      action: 'final',
      message: '整套角色卡已经建立完成。',
    },
  ];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'persona.create',
      args: { name: '总武高', setActive: true },
      featureId: 'persona.create',
      title: '创建主角色卡',
    }),
    reactPlanner: async () => reactDecisions[reactIndex++],
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'persona.create') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, created: true, personaId: 'persona-main', profile: { id: 'persona-main', name: '总武高' } },
          };
        }
        if (toolName === 'user.create') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, created: true, userId: 'user-main', profile: { id: 'user-main', name: '主用户' } },
          };
        }
        if (toolName === 'group.create') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, created: true, verified: true, group: { id: 'group:service-club', name: '侍奉部' } },
          };
        }
        if (toolName === 'app.read_resource') {
          return { toolName, status: 'succeeded', result: { ok: true, items: [] } };
        }
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, sessionId: args.sessionId || args.target },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('请建立整套角色卡，全部做好以后打开主要结果给我看。');
  assert.equal(result.ok, true);
  assert.equal(result.message, '整套角色卡已经建立完成。');
  assert.deepEqual(calls.map(call => call.toolName), [
    'persona.create',
    'app.read_resource',
    'user.create',
    'app.read_resource',
    'group.create',
    'session.list',
  ], '完成后切卡、切用户、打开结果都由模型决定，执行层不再自动追加');
  assert.equal(calls[0].args.setActive, true);
  assert.equal(calls[2].args.setActive, true);
  assert.equal(calls[4].args.open, true);
  console.log('ok - creation args follow the model and the agent appends no automatic switch or reveal steps');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.list',
      args: { sessionId: '冻结观察会话-A-0728' },
      featureId: 'worldbook.list',
      title: '查看世界书列表',
      response: '我先查询当前绑定。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '当前绑定仍在。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args, context) => {
        calls.push({ toolName, args, context });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, worldbooks: [] },
          summary: 'listed worldbooks',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('查询「冻结观察会话-A-0728」的世界书绑定，确认原绑定仍在且新增书已启用。');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.operationIntentPolicy, undefined, '查询句不再被关键词判成只读；要不要写交给模型，写入照工具确认');
  console.log('ok - read-like requests carry no keyword intent policy into tool execution');
}

{
  let writes = 0;
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.register({
    name: 'worldbook.list',
    capabilities: { read: true, write: false },
    execute: async () => ({ ok: true, worldbooks: [] }),
  });
  registry.register({
    name: 'worldbook.bind_session',
    riskLevel: 'medium',
    capabilities: { read: true, write: true },
    // 11/20 起会动到内容的工具一律弹确认；挡住写入的是工具自己的确认，不再是关键词判出的只读
    safety: {
      operationType: 'bind_worldbook_to_session',
      preflight: async () => ({ destructive: true, kind: 'worldbook.bind_session', operationType: 'bind_worldbook_to_session' }),
    },
    execute: async () => {
      writes += 1;
      return { ok: true, bound: true };
    },
  });
  let reactRound = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.list',
      args: {},
      featureId: 'worldbook.list',
      title: '查看世界书列表',
    }),
    reactPlanner: async () => {
      reactRound += 1;
      if (reactRound === 1) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'worldbook.bind_session',
          args: { worldbookId: '冻结观察SubAgent测试-0728', sessionId: '冻结观察会话-A-0728' },
          featureId: 'worldbook.bind_session',
          title: '绑定世界书',
        };
      }
      return {
        ok: true,
        action: 'final',
        message: '原请求是只读查询，因此没有执行绑定。',
      };
    },
    toolRegistry: registry,
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('查询「冻结观察会话-A-0728」的世界书绑定，确认原绑定仍在且新增书已启用。');
  assert.equal(writes, 0, '没有确认就不写');
  assert.equal(result.steps[1].toolName, 'worldbook.bind_session');
  assert.notEqual(result.steps[1].status, 'succeeded');
  console.log('ok - obs-03-016 a write after a read-like request still needs the tool confirmation');
}

{
  const modelResponse = '模型生成的发送前回应。';
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'chat.send_message',
      args: { sessionName: '目标联系人', message: '测试消息' },
      featureId: 'chat.send_message',
      title: '发送聊天消息',
      response: modelResponse,
    }),
    toolRegistry: {
      executeTool: async () => ({
        toolName: 'chat.send_message',
        status: 'succeeded',
        result: {
          ok: true,
          sent: true,
          requestTriggered: true,
          sessionId: '目标联系人',
        },
        summary: 'sent message to target contact',
      }),
    },
    logger: { warn() {} },
  });
  const statuses = [];
  const result = await agent.runPrompt('给目标联系人发送测试消息', {
    onStatus: status => statuses.push(status),
  });
  assert.equal(result.ok, true);
  assert.equal(statuses[0].message, modelResponse);
  assert.equal(result.message, '已发送给「目标联系人」，联系人正在回复。');
  console.log('ok - maid assistant agent reports pre-action reply and send-trigger final status');
}

{
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书',
      response: '我来打开世界书。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => ({
        toolName,
        status: 'succeeded',
        result: { ok: true, args },
        summary: `ran ${toolName}`,
      }),
    },
    guidedActionRuntime: {
      run: async ({ execute }) => {
        const output = await execute();
        return {
          output,
          guided: true,
          guide: { guideId: 'worldbook.open.guide' },
          message: '首次引导：打开世界书的 APP 路径是「聊天室右上角菜单 -> 世界书」。',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('打开世界书');
  assert.equal(result.ok, true);
  assert.equal(result.guided, true);
  assert.equal(result.guide.guideId, 'worldbook.open.guide');
  assert.match(result.message, /首次引导/);
  console.log('ok - maid assistant agent includes guided action results');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'variables' },
      featureId: 'variables.open',
      title: '打开变量',
      response: '我来打开变量。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true },
          summary: `ran ${toolName}`,
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('异步规划');
  assert.equal(result.ok, true);
  assert.equal(calls[0].toolName, 'app.open_panel');
  assert.equal(calls[0].args.panel, 'variables');
  console.log('ok - maid assistant agent awaits async planners');
}

{
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'session.open_config',
      args: {},
      featureId: 'session.config.open',
      title: '打开会话配置',
      response: '我来打开当前会话配置。',
    }),
    toolRegistry: {
      executeTool: async () => ({
        status: 'succeeded',
        result: { ok: false, reason: 'missing_session_id' },
        summary: 'open session config failed: missing_session_id',
      }),
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('打开当前聊天室的会话配置');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /missing_session_id/);
  console.log('ok - maid assistant agent reports business-level tool failures');
}

{
  const statuses = [];
  const reactCalls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'chat', sessionName: '精灵女王' },
      featureId: 'app.resource.read',
      title: '读取聊天消息',
      response: '我先看看精灵女王最后回了什么。',
    }),
    reactPlanner: async (input, context) => {
      reactCalls.push({ input, context });
      return {
        ok: true,
        action: 'final',
        message: '精灵女王最后回复了「晚上好，今天辛苦了」。',
      };
    },
    toolRegistry: {
      executeTool: async () => ({
        toolName: 'app.read_resource',
        status: 'succeeded',
        result: {
          ok: true,
          resource: 'chat',
          messages: [
            { role: 'user', content: '晚上好' },
            { role: 'assistant', rawOriginal: '晚上好，今天辛苦了', displayText: '晚上好，今天辛苦了' },
          ],
        },
        summary: 'read resource chat',
      }),
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('女王最后回了我什么？', {
    onStatus: status => statuses.push(status),
  });
  assert.equal(result.ok, true);
  assert.equal(result.responseType, 'react');
  assert.match(result.message, /今天辛苦了/);
  assert.equal(result.steps.length, 1);
  assert.equal(reactCalls.length, 1);
  assert.equal(reactCalls[0].context.maidReactSteps[0].toolName, 'app.read_resource');
  assert.equal(statuses.some(status => status.stage === 'observed'), true);
  console.log('ok - maid assistant agent continues after read tool and returns final answer');
}

{
  const avatar = `data:image/png;base64,${'A'.repeat(20_000)}`;
  const originalCard = {
    data: {
      character_book: {
        entries: [{ comment: '世界观', content: '原卡内的大段世界书正文' }],
      },
    },
  };
  const routedReactSteps = [];
  let reactContext = null;
  let reactPrompt = '';
  const agent = createMaidAssistantAgent({
    capabilityRoutingRuntime: {
      prepareDecision: ({ phase, steps }) => {
        if (phase === 'react') routedReactSteps.push(steps);
        return null;
      },
    },
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'persona', id: 'p1', include: ['details'] },
      featureId: 'app.resource.read',
      title: '读取完整角色卡',
      response: '我先读取完整角色卡。',
    }),
    reactPlanner: async (_input, context) => {
      reactContext = context;
      reactPrompt = buildMaidModelReActMessages({
        input: '读取完整角色卡，然后根据绑定的世界书继续处理人物条目',
        context,
        features: [],
        steps: context.maidReactSteps,
      })[1].content;
      return {
        ok: true,
        action: 'final',
        message: '角色卡绑定了世界书「精灵抱抱」。',
      };
    },
    toolRegistry: {
      executeTool: async () => ({
        toolName: 'app.read_resource',
        status: 'succeeded',
        result: {
          ok: true,
          resource: 'persona',
          activeId: 'p1',
          count: 1,
          projection: 'full',
          includedFields: ['details'],
          items: [{
            id: 'p1',
            name: '精灵女王',
            avatar,
            description: '温柔而坚定的精灵女王',
            source: {
              worldbookId: '精灵抱抱',
              worldbookEnabled: true,
              originalCardStored: true,
            },
            originalCard,
            active: true,
          }],
        },
        summary: 'read resource persona',
      }),
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('读取完整角色卡，然后根据绑定的世界书继续处理人物条目');
  const modelOutput = reactContext?.maidReactSteps?.[0]?.output;
  const routedOutput = routedReactSteps[0]?.[0]?.output;

  assert.equal(result.ok, true);
  assert.equal(modelOutput.items[0].source.worldbookId, '精灵抱抱');
  assert.equal(modelOutput.items[0].description, '温柔而坚定的精灵女王');
  assert.equal(Object.hasOwn(modelOutput.items[0], 'avatar'), false);
  assert.equal(Object.hasOwn(modelOutput.items[0], 'originalCard'), false);
  assert.equal(modelOutput.observationProjection.omittedFields[0].path, 'items[0].avatar');
  assert.equal(modelOutput.observationProjection.omittedFields[1].path, 'items[0].originalCard');
  assert.equal(JSON.stringify(modelOutput).includes('data:image'), false);
  assert.equal(JSON.stringify(modelOutput).length < 4_000, true);
  assert.match(reactPrompt, /"worldbookId":"精灵抱抱"/);
  assert.doesNotMatch(reactPrompt, /data:image|原卡内的大段世界书正文/);
  assert.deepEqual(routedOutput, modelOutput, 'capability retrieval and ReAct should share the bounded model snapshot');
  assert.equal(result.steps[0].output.items[0].avatar, avatar, 'internal step result must stay truthful and complete');
  assert.deepEqual(result.steps[0].output.items[0].originalCard, originalCard);
  console.log('ok - maid assistant projects full persona observations before routing and ReAct');
}

{
  const calls = [];
  const reactCalls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'chat', sessionId: '姐姐' },
      featureId: 'app.resource.read',
      title: '读取姐姐聊天',
      response: '我先读取姐姐的聊天。',
    }),
    reactPlanner: async (input, context) => {
      reactCalls.push({ input, context });
      if (reactCalls.length === 1) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'app.read_resource',
          args: { resource: 'chat', sessionId: '发小' },
          featureId: 'app.resource.read',
          title: '读取发小聊天',
          response: '我再读取发小的聊天。',
        };
      }
      if (reactCalls.length === 2) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'chat.send_message',
          args: { sessionId: '姐姐', content: '我吃过了，你也早点睡。' },
          featureId: 'chat.send_message',
          title: '回复姐姐',
          response: '我先回复姐姐。',
        };
      }
      if (reactCalls.length === 3) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'chat.send_message',
          args: { sessionId: '发小', content: '在吗？' },
          featureId: 'chat.send_message',
          title: '回复发小',
          response: '我再回复发小。',
        };
      }
      return {
        ok: true,
        action: 'final',
        message: '已经分别回复姐姐和发小。',
      };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'app.read_resource') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, resource: 'chat', sessionId: args.sessionId, messages: [] },
            summary: 'read resource chat',
          };
        }
        if (toolName === 'chat.send_message') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, sent: true, requestTriggered: true, sessionId: args.sessionId },
            summary: `sent message to ${args.sessionId}`,
          };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('根据刚才读取到的回应，分别回复姐姐和发小');
  assert.equal(result.ok, true);
  assert.equal(result.message, '已经分别回复姐姐和发小。');
  assert.deepEqual(calls.map(call => `${call.toolName}:${call.args.sessionId}`), [
    'app.read_resource:姐姐',
    'app.read_resource:发小',
    'chat.send_message:姐姐',
    'chat.send_message:发小',
  ]);
  assert.equal(reactCalls.length, 4);
  console.log('ok - maid assistant agent continues ReAct after chat sends');
}

{
  const calls = [];
  const reactCalls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'chat', sessionName: '精灵女王' },
      featureId: 'app.resource.read',
      title: '读取聊天消息',
      response: '我先读取聊天消息。',
    }),
    reactPlanner: async (input, context) => {
      reactCalls.push({ input, context });
      if (reactCalls.length === 1) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'app.read_resource',
          args: { resource: 'chat', sessionId: 's1' },
          featureId: 'app.resource.read',
          title: '重新读取聊天消息',
          response: '我换成正确的会话参数再试一次。',
        };
      }
      return {
        ok: true,
        action: 'final',
        message: '精灵女王最后回复了「晚上好」。',
      };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (calls.length === 1) {
          throw new Error('Agent tool arguments invalid: args.sessionName is not allowed');
        }
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, messages: [{ role: 'assistant', rawOriginal: '晚上好。' }] },
          summary: 'read resource chat',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('女王最后回了我什么？');
  assert.equal(result.ok, true);
  assert.match(result.message, /晚上好/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.sessionName, '精灵女王');
  assert.equal(calls[1].args.sessionId, 's1');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[1].status, 'succeeded');
  console.log('ok - maid assistant agent can repair tool args through ReAct loop');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    maxReactSteps: 2,
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'worldbook', name: '异世界 世界书' },
      featureId: 'app.resource.read',
      title: '读取世界书',
      response: '我先读取世界书。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'app.read_resource',
      args: { resource: 'worldbook', name: '异世界 世界书', includeContent: true },
      featureId: 'app.resource.read',
      title: '继续读取世界书',
      response: '我继续读取正文。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, resource: 'worldbook', entryCount: 3 },
          summary: 'read resource worldbook',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('帮我完整检查异世界世界书');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.continuable, true);
  assert.equal(result.reactStoppedReason, 'max_steps_reached');
  assert.match(result.continueHint, /下一步建议工具/);
  assert.equal(result.reactStepBudget.maxSteps, 2);
  assert.equal(calls.length, 2);
  console.log('ok - maid assistant agent returns continuable max-step interruption');
}

{
  let reactCalls = 0;
  const calls = [];
  const agent = createMaidAssistantAgent({
    maxReactSteps: 12,
    planner: async () => ({
      ok: true,
      toolName: 'app.get_current_state',
      args: {},
      featureId: 'app.state.read',
      title: '检查当前状态',
      response: '我先检查当前状态。',
    }),
    reactPlanner: async () => {
      reactCalls += 1;
      if (reactCalls === 1) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'persona.create',
          args: { name: '预算测试角色卡' },
          featureId: 'persona.create',
          title: '创建角色卡',
          response: '接着建立角色卡。',
        };
      }
      if (reactCalls >= 11) {
        return { ok: true, action: 'final', message: '写入、读回验证与收尾都已完成。' };
      }
      const inspect = reactCalls % 2 === 0;
      return inspect
        ? {
            ok: true,
            action: 'tool',
            toolName: 'app.get_current_state',
            args: {},
            featureId: 'app.state.read',
            title: '核对状态',
            response: '我继续核对。',
          }
        : {
            ok: true,
            action: 'tool',
            toolName: 'app.open_panel',
            args: { panel: reactCalls % 4 === 1 ? 'worldbook' : 'memory' },
            featureId: 'worldbook.open',
            title: '继续处理',
            response: '我继续处理。',
          };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'persona.create') {
          return { toolName, status: 'succeeded', result: { ok: true, personaId: 'persona-budget' } };
        }
        if (toolName === 'app.read_resource') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, resource: 'persona', items: [{ id: 'persona-budget', name: '预算测试角色卡' }] },
          };
        }
        return { toolName, status: 'succeeded', result: { ok: true } };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('创建角色卡并完成后续批量配置');
  assert.equal(result.ok, true, '读后写任务也应动态扩展验证和最终收尾额度，不应在初始读取的 10 步边界中断');
  assert.equal(reactCalls, 11);
  assert.equal(calls[0].toolName, 'app.get_current_state');
  assert.equal(calls[1].toolName, 'persona.create');
  assert.equal(calls[2].toolName, 'app.read_resource', '创建后仍应执行自动读回验证');
  console.log('ok - read-first task dynamically reserves bounded verification and finalization cycles');
}

{
  const createArgs = { name: '已建立角色卡' };
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'persona.create',
      args: createArgs,
      featureId: 'persona.create',
      title: '继续创建角色卡',
      response: '我继续处理。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '已按稳定 ID 复验，角色卡仍存在，因此没有重复创建。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'persona.create') {
          return { toolName, status: 'succeeded', result: { ok: true, personaId: 'persona-existing' } };
        }
        return {
          toolName,
          status: 'succeeded',
          result: {
            ok: true,
            resource: 'persona',
            items: [{ id: 'persona-existing', name: '已建立角色卡' }],
          },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('继续这条已中断的女仆任务。', {
    runContinuation: {
      version: 'maid-run-continuation-v1',
      sourceRunId: 'run-before',
      goal: '创建角色卡并继续其他配置',
      successfulSteps: [{
        toolName: 'persona.create',
        argsDigest: fingerprintMaidToolCall('persona.create', createArgs),
        result: { ok: true, personaId: 'persona-existing', name: '已建立角色卡' },
        resourceRefs: [{ kind: 'persona', id: 'persona-existing', name: '已建立角色卡' }],
        verification: 'readback',
      }],
      remainingTodos: [],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.toolName), ['app.read_resource']);
  console.log('ok - resumed run verifies prior stable IDs instead of replaying a successful create');
}

{
  const agent = createMaidAssistantAgent({
    repeatedFailureLimit: 3,
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'chat', sessionName: '精灵女王' },
      featureId: 'app.resource.read',
      title: '读取聊天消息',
      response: '我先读取聊天消息。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'app.read_resource',
      args: { resource: 'chat', sessionName: '精灵女王' },
      featureId: 'app.resource.read',
      title: '再次读取聊天消息',
      response: '我再试一次。',
    }),
    toolRegistry: {
      executeTool: async () => {
        throw new Error('Agent tool arguments invalid: args.sessionName is not allowed');
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('女王最后回了我什么？');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'repeated_tool_failure');
  assert.equal(result.continuable, false);
  assert.equal(result.steps.length, 3);
  assert.match(result.message, /连续失败 3 次/);
  console.log('ok - maid assistant agent stops repeated identical tool failures');
}

{
  // 相同的失败写入之间夹着读取时，连续计数会被打断；整轮累计也要能停下（曾循环 37 步）
  let react = 0;
  const failingUpdate = { toolName: 'worldbook.update_entries', args: { name: '苏晓彤', updates: [{}] }, featureId: 'worldbook.update_entries' };
  const agent = createMaidAssistantAgent({
    repeatedFailureLimit: 3,
    maxReactSteps: 40,
    planner: async () => ({ ok: true, ...failingUpdate, title: '修改条目', response: '我来改。' }),
    reactPlanner: async () => {
      react += 1;
      return react % 2
        ? { ok: true, action: 'tool', toolName: 'worldbook.read', args: { name: '苏晓彤' }, featureId: 'worldbook.read', title: '读取', response: '我看看。' }
        : { ok: true, action: 'tool', ...failingUpdate, title: '再改一次', response: '再试一次。' };
    },
    toolRegistry: {
      executeTool: async (toolName) => {
        if (toolName === 'worldbook.read') return { toolName, status: 'succeeded', result: { ok: true, name: '苏晓彤', entries: [] }, summary: 'read' };
        throw new Error('update worldbook entries failed: invalid_updates');
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('帮我把林念初加进世界书');
  assert.equal(result.reason, 'repeated_tool_failure');
  assert.equal(result.steps.filter(step => step.toolName === 'worldbook.update_entries').length, 3);
  assert.equal(result.steps.length, 5);
  assert.match(result.message, /反复失败 3 次/);
  console.log('ok - maid assistant agent stops identical failures repeated across interleaved reads');
}

{
  const calls = [];
  const reactCalls = [];
  const statuses = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.update_entries',
      args: {
        name: '异世界 世界书',
        updates: [{ entryTitle: '精灵女王', content: '扩展后的精灵女王设定。' }],
      },
      featureId: 'worldbook.update_entries',
      title: '修改世界书条目',
      response: '我来更新这个条目。',
    }),
    reactPlanner: async (input, context) => {
      reactCalls.push({ input, context });
      return {
        ok: true,
        action: 'final',
        message: '已经更新并读回确认，世界书里仍有 3 个条目。',
      };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'worldbook.update_entries') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, worldbookId: '异世界 世界书', updatedEntryCount: 1, entryCount: 3 },
            summary: 'updated worldbook entries',
          };
        }
        if (toolName === 'worldbook.read') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              name: args.name,
              entryCount: 3,
              entries: [{ title: '精灵女王', contentLength: 12 }],
            },
            summary: 'read worldbook for verification',
          };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('把精灵女王条目替换成扩展版', {
    onStatus: status => statuses.push(status),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.toolName), ['worldbook.update_entries', 'worldbook.read']);
  assert.equal(calls[1].args.name, '异世界 世界书');
  assert.equal(calls[1].args.includeContent, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].metadata.verificationFor, 'worldbook.update_entries');
  assert.equal(reactCalls.length, 1);
  assert.deepEqual(reactCalls[0].context.maidReactSteps.map(step => step.toolName), ['worldbook.update_entries', 'worldbook.read']);
  assert.equal(statuses.some(status => status.stage === 'verifying'), true);
  assert.match(result.message, /读回确认/);
  console.log('ok - maid assistant agent verifies worldbook writes before final answer');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.create',
      args: {
        name: '测试世界书',
        entries: [
          { title: '超级温柔大姐姐', content: '大姐姐设定。' },
          { title: '傲娇大小姐青梅竹马', content: '青梅竹马设定。' },
        ],
      },
      featureId: 'worldbook.create',
      title: '创建测试世界书',
      response: '我来创建测试世界书。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'worldbook.create',
      args: {
        name: '测试世界书',
        entries: [
          { title: '超级温柔大姐姐', content: '重复的大姐姐设定。' },
          { title: '傲娇大小姐青梅竹马', content: '重复的青梅竹马设定。' },
        ],
      },
      featureId: 'worldbook.create',
      title: '再次创建测试世界书',
      response: '我再创建一次。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'worldbook.create') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, worldbookId: args.name, addedEntryCount: args.entries.length, entryCount: 2 },
            summary: 'saved worldbook',
          };
        }
        if (toolName === 'worldbook.read') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, name: args.name, entryCount: 2, entries: args.includeContent ? [] : [] },
            summary: 'read worldbook',
          };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('创建测试世界书');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.toolName), ['worldbook.create', 'worldbook.read']);
  assert.equal(result.finalDecision.source, 'duplicate_write_guard');
  assert.match(result.message, /避免重复追加/);
  console.log('ok - maid assistant agent stops duplicate verified worldbook writes');
}

{
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'worldbook', name: '青梅竹马' },
      featureId: 'app.resource.read',
      title: '读取世界书',
      response: '我先读取世界书。',
    }),
    reactPlanner: async () => ({
      ok: false,
      reason: 'invalid_model_react_decision',
      message: '模型没有返回有效 ReAct 决策。',
    }),
    toolRegistry: {
      executeTool: async () => ({
        toolName: 'app.read_resource',
        status: 'succeeded',
        result: { ok: true, resource: 'worldbook', worldbooks: [{ id: '青梅竹马', entryCount: 4 }] },
        summary: 'read resource worldbook',
      }),
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('帮我看青梅竹马世界书');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.partial, true);
  assert.equal(result.continuable, true);
  assert.equal(result.reactStoppedReason, 'invalid_model_react_decision');
  assert.match(result.continueHint, /用户原始目标/);
  assert.match(result.message, /没有完成最终回答/);
  console.log('ok - maid assistant agent reports ReAct interruption instead of false success');
}

{
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书面板',
    }),
    reactPlanner: async () => ({
      ok: false,
      reason: 'tool_not_allowed',
      message: '模型把功能与工具配错了。',
    }),
    toolRegistry: {
      executeTool: async toolName => ({
        toolName,
        status: 'succeeded',
        result: { ok: true, panel: 'worldbook' },
        summary: 'opened worldbook panel',
      }),
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('先打开世界书面板，再继续完成整套配置');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.partial, true);
  assert.equal(result.continuable, true);
  assert.equal(result.reactStoppedReason, 'tool_not_allowed');
  assert.match(result.continueHint, /已完成步骤/);
  console.log('ok - safe model tool-selection failure after successful work remains continuable');
}

for (const stopReason of ['feature_not_found', 'invalid_model_plan']) {
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书面板',
    }),
    reactPlanner: async () => ({
      ok: false,
      reason: stopReason,
      message: '模型选择了无法执行的下一步。',
    }),
    toolRegistry: {
      executeTool: async toolName => ({
        toolName,
        status: 'succeeded',
        result: { ok: true, panel: 'worldbook' },
        summary: 'opened worldbook panel',
      }),
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('先打开世界书面板，再继续完成整套配置');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.partial, true);
  assert.equal(result.continuable, true, `${stopReason} 必须保持可继续`);
  assert.equal(result.reactStoppedReason, stopReason);
  assert.match(result.continueHint, /已完成步骤/);
  console.log(`ok - ${stopReason} after successful work remains continuable`);
}

{
  const agent = createMaidAssistantAgent({
    toolRegistry: {
      executeTool: async () => {
        throw new Error('should not run');
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_input');
  console.log('ok - maid assistant agent requires planner input without calling tools');
}

{
  // 空指令（无附件/无选区）不得进 planner——否则模型会按女仆历史重放旧指令
  let plannerCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => {
      plannerCalls += 1;
      return { ok: true, toolName: 'app.open_panel', args: { panel: 'worldbook' }, featureId: 'worldbook.open' };
    },
    toolRegistry: {
      executeTool: async () => {
        throw new Error('should not run');
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('', { sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_input');
  assert.equal(plannerCalls, 0);
  // 有附件时空文字仍然放行（用户只发图给女仆的场景）
  const withAttachment = await agent.runPrompt('', { maidAttachments: [{ id: 'att-1' }] });
  assert.equal(plannerCalls, 1);
  assert.notEqual(withAttachment.reason, 'empty_input');
  console.log('ok - maid assistant agent rejects empty input before planner, allows attachment-only');
}

{
  const agent = createMaidAssistantAgent({
    toolRegistry: {
      executeTool: async () => {
        throw new Error('should not run');
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('打开世界书');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'maid_planner_required');
  console.log('ok - maid assistant agent does not use local rules by default');
}

{
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: false,
      status: 'unsupported',
      reason: 'unsupported_intent',
      message: '这个请求还没有接入女仆工具。',
    }),
    chatResponder: async (input, context) => ({
      ok: true,
      status: 'responded',
      source: 'test_chat',
      message: `你好，${input} / ${context.sessionId}`,
    }),
    toolRegistry: {
      executeTool: async () => {
        throw new Error('should not run');
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('你好啊', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'responded');
  assert.equal(result.responseType, 'chat');
  assert.equal(result.source, 'test_chat');
  assert.match(result.message, /你好啊/);
  console.log('ok - maid assistant agent uses chat responder for unsupported plain input');
}

{
  // 「不要调用工具」也交给模型判断，程序不再按关键词跳过规划（11/20）
  let plannerCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => {
      plannerCalls += 1;
      return { ok: false, status: 'unsupported', reason: 'invalid_model_plan', message: '模型没有返回有效计划。' };
    },
    chatResponder: async () => ({ ok: true, status: 'responded', message: '记忆回答' }),
    toolRegistry: { executeTool: async () => ({ ok: true }) },
    logger: { warn() {} },
  });
  await agent.runPrompt('不要调用任何工具，只根据长期记忆回答我的偏好。');
  assert.equal(plannerCalls, 1, '不按关键词绕过模型');
  console.log('ok - no-tool wording reaches the model instead of a keyword shortcut');
}

{
  const calls = [];
  const reactContexts = [];
  let chatCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: false,
      status: 'unsupported',
      reason: 'invalid_model_plan',
      message: '模型没有返回有效计划。',
    }),
    reactPlanner: async (input, context) => {
      reactContexts.push(context);
      if (!context.maidReactSteps?.length) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'worldbook.read',
          args: { name: '异世界 世界书', includeContent: true },
          featureId: 'worldbook.read',
          title: '读取世界书',
          response: '我重新读取世界书。',
        };
      }
      return {
        ok: true,
        action: 'final',
        message: '已经重新读回世界书内容。',
      };
    },
    chatResponder: async () => {
      chatCalls += 1;
      return { ok: true, status: 'responded', message: '不该进入聊天。' };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, name: args.name, entryCount: 3 },
          summary: 'read worldbook',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('刚失败了，再试一次');
  assert.equal(result.ok, true);
  assert.equal(result.responseType, 'react');
  assert.equal(chatCalls, 0);
  assert.deepEqual(calls.map(call => call.toolName), ['worldbook.read']);
  assert.equal(calls[0].args.includeContent, true);
  assert.equal(reactContexts[0].plannerFailure.reason, 'invalid_model_plan');
  assert.equal(reactContexts[1].maidReactSteps.length, 1);
  assert.match(result.message, /读回/);
  console.log('ok - maid assistant agent lets ReAct recover invalid planner continuations');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'persona.create',
      args: { name: '精灵女王', setActive: true },
      featureId: 'persona.create',
      title: '创建角色卡',
      response: '我来创建角色卡。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '角色卡已创建并读回确认。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'persona.create') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, personaId: 'p-1', name: '精灵女王' },
            summary: 'created persona',
          };
        }
        if (toolName === 'app.read_resource') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, resource: 'persona', items: [{ id: 'p-1', name: '精灵女王', active: true }] },
            summary: 'read personas',
          };
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('创建角色卡精灵女王');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.toolName), ['persona.create', 'app.read_resource']);
  assert.equal(calls[1].args.resource, 'persona');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].metadata.verificationFor, 'persona.create');
  assert.equal(result.steps[1].metadata.verificationSuccess, '角色卡列表包含新建的角色卡');
  console.log('ok - maid assistant agent auto-verifies catalog-declared write tools');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'session.set_wallpaper',
      args: { sessionId: 'A' },
      featureId: 'session.wallpaper.set',
      title: '设置聊天室壁纸',
      response: '我来设置壁纸。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '壁纸已应用。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, applied: true },
          summary: 'wallpaper applied',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('把这张图设为壁纸');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.toolName), ['session.set_wallpaper'], 'verification: null 的工具不应触发读回');
  console.log('ok - maid assistant agent skips auto-verification for result-authoritative tools');
}

{
  const calls = [];
  let reactIndex = 0;
  const reactDecisions = [
    {
      ok: true,
      action: 'tool',
      toolName: 'session.set_wallpaper',
      args: {
        target: '岑夏',
        attachmentId: 'generated-wallpaper-1',
      },
      featureId: 'session.wallpaper.set',
      title: '写回聊天室壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'media.generate_image',
      args: {
        prompt: 'cenxia, school courtyard, anime style',
        subject: '岑夏',
        subjectAliases: ['cenxia'],
        target: '岑夏',
        purpose: 'wallpaper',
        appearance: 'silver short hair',
        outfit: 'navy school uniform',
        style: 'anime style',
        targetAspectRatio: '1:1',
      },
      featureId: 'media.generate_image',
      title: '重复生成同一壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'app.read_resource',
      args: { resource: 'persona' },
      featureId: 'app.resource.read',
      title: '继续核对角色卡',
    },
    {
      ok: true,
      action: 'final',
      message: '壁纸已经写回，并完成了后续核对。',
    },
  ];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'media.generate_image',
      args: {
        prompt: 'cenxia, school courtyard, soft lighting, anime style',
        subject: '岑夏',
        subjectAliases: ['cenxia'],
        target: '岑夏',
        purpose: 'wallpaper',
        appearance: 'silver short hair',
        outfit: 'navy school uniform',
        style: 'anime style',
        targetAspectRatio: '1:1',
      },
      featureId: 'media.generate_image',
      title: '生成聊天室壁纸',
    }),
    reactPlanner: async () => reactDecisions[reactIndex++],
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'media.generate_image') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              attachmentId: 'generated-wallpaper-1',
              visualSpec: {
                target: args.target,
                purpose: args.purpose,
              },
            },
          };
        }
        if (toolName === 'session.set_wallpaper') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              sessionId: args.target,
            },
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: {
            ok: true,
            resource: args.resource,
            items: [],
          },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('请重新生成一张岑夏的聊天室壁纸并设置好，然后继续核对角色卡。');
  assert.equal(result.ok, true);
  assert.equal(
    calls.filter(call => call.toolName === 'media.generate_image').length,
    1,
    '同一对象与用途的图片已经成功写回后，不得再次产生计费生图调用',
  );
  assert.deepEqual(
    calls.map(call => call.toolName),
    ['media.generate_image', 'session.set_wallpaper', 'app.read_resource'],
    '拦截重复生图后仍须继续执行后续未完成任务',
  );
  const guardedStep = result.steps.find(step => step?.output?.reason === 'generated_media_already_applied');
  assert.equal(guardedStep?.output?.reusedVerifiedAction, true);
  assert.equal(guardedStep?.output?.attachmentId, 'generated-wallpaper-1');
  console.log('ok - a one-image regenerate request consumes one target quota instead of bypassing the guard');
}

{
  const calls = [];
  let reactIndex = 0;
  let generateSeq = 0;
  const generateArgs = seq => ({
    prompt: seq === 1
      ? 'cenxia, school courtyard, anime style'
      : 'cenxia, night rooftop, anime style',
    subject: '岑夏',
    subjectAliases: ['cenxia'],
    target: '岑夏',
    purpose: 'wallpaper',
    appearance: 'silver short hair',
    outfit: 'navy school uniform',
    style: 'anime style',
    targetAspectRatio: '1:1',
  });
  const reactDecisions = [
    {
      ok: true,
      action: 'tool',
      toolName: 'session.set_wallpaper',
      args: { target: '岑夏', attachmentId: 'generated-wallpaper-1' },
      featureId: 'session.wallpaper.set',
      title: '写回聊天室壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'media.generate_image',
      args: generateArgs(2),
      featureId: 'media.generate_image',
      title: '按用户要求换一张壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'session.set_wallpaper',
      args: { target: '岑夏', attachmentId: 'generated-wallpaper-2' },
      featureId: 'session.wallpaper.set',
      title: '写回替换后的壁纸',
    },
    {
      ok: true,
      action: 'final',
      message: '已生成并替换为新壁纸。',
    },
  ];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'media.generate_image',
      args: generateArgs(1),
      featureId: 'media.generate_image',
      title: '生成聊天室壁纸',
    }),
    reactPlanner: async () => reactDecisions[reactIndex++],
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'media.generate_image') {
          generateSeq += 1;
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              attachmentId: `generated-wallpaper-${generateSeq}`,
              visualSpec: { target: args.target, purpose: args.purpose },
            },
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, sessionId: args.target },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('先给岑夏生成聊天室壁纸设置上，看完之后重新生成换掉它。');
  assert.equal(result.ok, true);
  assert.equal(
    calls.filter(call => call.toolName === 'media.generate_image').length,
    2,
    '用户明确要求再生成/换一张时，幂等保护不得拦截第二次生图',
  );
  assert.equal(
    result.steps.some(step => step?.output?.reason === 'generated_media_already_applied'),
    false,
    '显式变体请求下不得出现本地复用拦截步骤',
  );
  assert.deepEqual(
    calls.map(call => call.toolName),
    ['media.generate_image', 'session.set_wallpaper', 'media.generate_image', 'session.set_wallpaper'],
  );
  console.log('ok - explicit regenerate request bypasses the generated-media idempotency guard');
}

const runGeneratedMediaQuotaProbe = async input => {
  const calls = [];
  let reactIndex = 0;
  let generated = 0;
  const mediaArgs = suffix => ({
    prompt: `cenxia, ${suffix}, anime wallpaper`,
    subject: '岑夏',
    target: '岑夏',
    purpose: 'wallpaper',
  });
  const reactDecisions = [
    {
      ok: true,
      action: 'tool',
      toolName: 'session.set_wallpaper',
      args: { target: '岑夏', attachmentId: 'quota-wallpaper-1' },
      featureId: 'session.wallpaper.set',
      title: '设置第一张壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'media.generate_image',
      args: mediaArgs('night'),
      featureId: 'media.generate_image',
      title: '尝试生成第二张壁纸',
    },
    {
      ok: true,
      action: 'final',
      message: '配额探针结束。',
    },
  ];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'media.generate_image',
      args: mediaArgs('day'),
      featureId: 'media.generate_image',
      title: '生成第一张壁纸',
    }),
    reactPlanner: async () => reactDecisions[reactIndex++],
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'media.generate_image') {
          generated += 1;
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, attachmentId: `quota-wallpaper-${generated}` },
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, sessionId: args.target },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt(input);
  return {
    result,
    generated: calls.filter(call => call.toolName === 'media.generate_image').length,
  };
};

{
  const probe = await runGeneratedMediaQuotaProbe(
    '给岑夏生成一张聊天室壁纸并设置，不要再生成第二张。',
  );
  assert.equal(probe.generated, 1, '否定分句中的“第二张”不得扩大生图额度');
  assert.equal(
    probe.result.steps.some(step => step?.output?.reason === 'generated_media_already_applied'),
    true,
  );
  console.log('ok - negated regenerate wording does not increase generated-media quota');
}

{
  const probe = await runGeneratedMediaQuotaProbe(
    '给岑夏生成一张聊天室壁纸并设置，画风参考两张附件。',
  );
  assert.equal(probe.generated, 1, '画风参考的输入图片数量不得当成输出生图额度');
  console.log('ok - style-reference units are excluded from generated-media quota');
}

{
  const probe = await runGeneratedMediaQuotaProbe(
    '给岑夏生成一张聊天室壁纸并设置，画风参考另一张附件。',
  );
  assert.equal(probe.generated, 1, '前置“画风参考”修饰的另一张附件不得扩大输出生图额度');
  console.log('ok - leading style-reference wording does not grant another generated image');
}

{
  const probe = await runGeneratedMediaQuotaProbe(
    '给岑夏生成聊天室壁纸并设置，一张白天，另一张夜景。',
  );
  assert.equal(probe.generated, 2, '继承同一目标与用途的裸“另一张”应授权第二个变体');
  assert.equal(
    probe.result.steps.some(step => step?.output?.reason === 'generated_media_already_applied'),
    false,
  );
  console.log('ok - bare another-image wording grants one additional target-purpose variant');
}

{
  const calls = [];
  let reactIndex = 0;
  const reactDecisions = [
    {
      ok: true,
      action: 'tool',
      toolName: 'contact.set_avatar',
      args: { target: '岑夏', attachmentId: 'avatar-1' },
      featureId: 'contact.avatar.set',
      title: '设置头像',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'media.generate_image',
      args: {
        prompt: 'cenxia, school courtyard, anime wallpaper',
        subject: '岑夏',
        target: '岑夏',
        purpose: 'wallpaper',
      },
      featureId: 'media.generate_image',
      title: '生成壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'session.set_wallpaper',
      args: { target: '岑夏', attachmentId: 'wallpaper-1' },
      featureId: 'session.wallpaper.set',
      title: '设置壁纸',
    },
    {
      ok: true,
      action: 'tool',
      toolName: 'media.generate_image',
      args: {
        prompt: 'cenxia, portrait, another avatar',
        subject: '岑夏',
        target: '岑夏',
        purpose: 'avatar',
      },
      featureId: 'media.generate_image',
      title: '误重复生成头像',
    },
    {
      ok: true,
      action: 'final',
      message: '头像和壁纸都已设置。',
    },
  ];
  const generatedByPurpose = new Map();
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'media.generate_image',
      args: {
        prompt: 'cenxia, portrait, anime avatar',
        subject: '岑夏',
        target: '岑夏',
        purpose: 'avatar',
      },
      featureId: 'media.generate_image',
      title: '生成头像',
    }),
    reactPlanner: async () => reactDecisions[reactIndex++],
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'media.generate_image') {
          const purpose = args.purpose;
          const sequence = (generatedByPurpose.get(purpose) || 0) + 1;
          generatedByPurpose.set(purpose, sequence);
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, attachmentId: `${purpose}-${sequence}` },
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('请给岑夏生成一张头像并设置，再生成一张聊天室壁纸并设置。');

  assert.equal(result.ok, true);
  assert.equal(
    calls.filter(call => call.toolName === 'media.generate_image' && call.args.purpose === 'avatar').length,
    1,
    '头像与壁纸各一张不能被误算成头像配额两张',
  );
  assert.equal(
    calls.filter(call => call.toolName === 'media.generate_image' && call.args.purpose === 'wallpaper').length,
    1,
  );
  assert.equal(
    result.steps.some(step => (
      step?.toolName === 'media.generate_image'
      && step?.output?.reason === 'generated_media_already_applied'
    )),
    true,
  );
  console.log('ok - mixed avatar and wallpaper requests keep independent target-purpose quotas');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.bind_sessions',
      args: { worldbookId: '精灵抱抱', sessions: ['艾露维娅', '薇拉妮丝'] },
      featureId: 'worldbook.bind_sessions',
      title: '批量绑定世界书',
      response: '我来批量绑定并逐项验证。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '两个聊天室都已绑定并验证。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: {
            ok: true,
            worldbookId: args.worldbookId,
            requestedCount: 2,
            succeededCount: 2,
            verifiedCount: 2,
            results: args.sessions.map(sessionId => ({ sessionId, status: 'succeeded', verified: true })),
          },
          summary: 'batch worldbook binding completed',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('给这两个房都绑上世界书「精灵抱抱」');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.toolName), ['worldbook.bind_sessions']);
  assert.equal(result.steps.length, 1, 'batch tool verifies each item internally and should not add N verification calls');
  assert.match(result.message, /两个聊天室/);
  console.log('ok - maid assistant treats verified batch binding as a single result-authoritative step');
}

{
  const calls = [];
  let reactIndex = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.bind_session',
      args: {
        worldbookId: 'V4F-V2档案库-0731',
        sessionName: 'V4F-V2观测站-A-0731',
        mode: 'append',
      },
      featureId: 'worldbook.bind_session',
      title: '追加绑定世界书',
    }),
    reactPlanner: async () => ([
      {
        ok: true,
        action: 'tool',
        toolName: 'app.read_resource',
        args: {
          resource: 'session',
          sessionName: 'V4F-V2观测站-A-0731',
          include: ['worldbooks'],
        },
        featureId: 'app.resource.read',
        title: '读回绑定',
      },
      {
        ok: true,
        action: 'final',
        message: '已完成绑定并验证。',
      },
    ][reactIndex++]),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'worldbook.bind_session') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              bound: true,
              sessionId: args.sessionName,
              worldbookId: args.worldbookId,
              worldbookIds: [args.worldbookId],
            },
          };
        }
        if (toolName === 'worldbook.list') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              count: 1,
              worldbooks: [{
                id: 'V4F-V2档案库-0731',
                name: 'V4F-V2档案库-0731',
                boundToCurrentSession: true,
              }],
            },
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, resource: args.resource, sessions: [] },
        };
      },
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt(
    '把「V4F-V2档案库-0731」追加绑定到「V4F-V2观测站-A-0731」，保留原绑定，完成后读回确认。',
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map(call => call.toolName),
    ['worldbook.bind_session', 'worldbook.list', 'app.read_resource'],
    '自动验证之后模型要再读一次，执行层照做，不看原话拦截',
  );
  assert.equal(result.message, '已完成绑定并验证。');
  console.log('ok - a model-requested read after a verified binding is executed');
}

{
  const previewFlags = [];
  let reactCalls = 0;
  const sessions = ['观测站', '档案室', '检查站'];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'worldbook.bind_sessions',
      args: { worldbookId: '档案库', sessions, mode: 'append', preview: true },
      featureId: 'worldbook.bind_sessions',
      title: '只预览三房绑定',
    }),
    reactPlanner: async () => {
      reactCalls += 1;
      return reactCalls === 1
        ? {
            ok: true,
            action: 'tool',
            toolName: 'worldbook.bind_sessions',
            args: { worldbookId: '档案库', sessions, mode: 'append', preview: true },
            featureId: 'worldbook.bind_sessions',
            title: '再次核对预览',
          }
        : {
            ok: true,
            action: 'final',
            message: '仅完成预览，没有实际应用。',
          };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        previewFlags.push(args.preview);
        return {
          toolName,
          status: 'succeeded',
          result: {
            ok: true,
            preview: args.preview === true,
            plannedCount: args.preview === true ? sessions.length : 0,
            succeededCount: args.preview === true ? 0 : sessions.length,
            verifiedCount: args.preview === true ? 0 : sessions.length,
            failedCount: 0,
            results: sessions.map(sessionId => ({
              sessionId,
              status: args.preview === true ? 'planned' : 'succeeded',
              verified: args.preview !== true,
            })),
          },
          summary: args.preview === true ? 'batch preview completed' : 'batch binding completed',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt(
    '把世界书「档案库」追加绑定到三个测试房；这次只预览，不要实际执行或应用任何绑定。',
  );
  assert.equal(result.ok, true);
  assert.deepEqual(previewFlags, [true, true], '否定 apply 的请求即使模型重复 preview，也绝不能升级为实际写入');
  console.log('ok - preview-only requests never advance to an apply write');
}

{
  const calls = [];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'chat.send_message',
      args: {
        sessionName: '观测站',
        content: 'OBS-A',
        role: 'user',
        triggerReply: false,
        open: false,
      },
      featureId: 'chat.send_message',
      title: '写入观测站消息',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'final',
      message: '观测站已写入。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          toolName,
          status: 'succeeded',
          result: { ok: true, sessionId: args.sessionName, sessionName: args.sessionName },
          summary: `sent message to ${args.sessionName}`,
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt(
    '保持当前房间不变，向三个测试房后台各写一条用户消息：给「观测站」写“OBS-A”，给「档案室」写“OBS-B”，给「检查站」写“OBS-C”；全部必须 triggerReply:false、open:false。最后读取 APP 状态。',
  );
  assert.equal(result.ok, true);
  assert.equal(result.message, '观测站已写入。');
  assert.deepEqual(
    calls.map(call => call.toolName),
    ['chat.send_message'],
    '模型给出最终回答就结束；执行层不再按原话补发其余房间、读回或读取 APP 状态',
  );
  console.log('ok - the model final answer ends the task without keyword-built follow-up steps');
}

{
  const calls = [];
  let reactCalls = 0;
  const roomNames = ['复杂压力·岚', '复杂压力·弦'];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'session.list',
      args: {},
      featureId: 'session.list',
      title: '先查聊天室',
    }),
    reactPlanner: async () => {
      reactCalls += 1;
      if (reactCalls <= 2) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'session.create',
          args: { names: roomNames, open: false },
          featureId: 'session.create',
          title: reactCalls === 1 ? '幂等建立聊天室' : '重复建立聊天室',
        };
      }
      if (reactCalls === 3) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'worldbook.bind_sessions',
          args: { worldbookId: '复杂压力·资料', sessions: roomNames, mode: 'append' },
          featureId: 'worldbook.bind_sessions',
          title: '继续批量绑定',
        };
      }
      return {
        ok: true,
        action: 'final',
        message: '两个聊天室已复用，世界书绑定也已核对。',
      };
    },
    toolRegistry: {
      executeTool: async (toolName, args) => {
        calls.push({ toolName, args });
        if (toolName === 'session.list') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              count: 2,
              contacts: roomNames.map(name => ({ id: name, name })),
            },
            summary: 'listed 2 session(s)',
          };
        }
        if (toolName === 'session.create') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              created: false,
              createdCount: 0,
              sessionIds: roomNames,
              sessions: roomNames.map(name => ({
                ok: true,
                created: false,
                existing: true,
                sessionId: name,
              })),
            },
            summary: 'created 0 of 2 session(s)',
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: {
            ok: true,
            worldbookId: args.worldbookId,
            skippedCount: 2,
            failedCount: 0,
            verifiedCount: 2,
          },
          summary: 'batch worldbook binding completed',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt(
    '重复执行幂等核对：用一次 session.create(names[]) 请求两个房，再用一次 worldbook.bind_sessions 绑定；不要打开页面。',
  );
  assert.equal(result.ok, true);
  assert.equal(calls.filter(call => call.toolName === 'session.create').length, 1, '已验证的同参幂等创建不得真实执行第二次');
  assert.equal(calls.filter(call => call.toolName === 'session.list').length, 2, '只允许初始清单和第一次创建后的自动验证');
  assert.equal(calls.filter(call => call.toolName === 'worldbook.bind_sessions').length, 1, '拦截重复创建后必须继续下一个用户子目标');
  const guardedStep = result.steps.find(step => step?.output?.reason === 'duplicate_idempotent_action_skipped');
  assert.equal(guardedStep?.output?.reusedVerifiedAction, true);
  assert.match(result.message, /世界书绑定/);
  console.log('ok - verified idempotent session creation is reused instead of re-executed');
}

{
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'maid.todo.write',
      args: { todos: [{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }] },
      featureId: 'maid.todo',
      title: '记录任务清单',
      response: '我先记录任务清单。',
    }),
    reactPlanner: (() => {
      let round = 0;
      // 工具名与 args 每轮变化：预算测试需要跑满步数，不能触发重复/同工具 guard
      const toolNames = ['app.open_panel', 'app.read_resource', 'app.get_current_state'];
      return async () => {
        round += 1;
        return {
          ok: true,
          action: 'tool',
          toolName: toolNames[round % toolNames.length],
          args: { panel: `worldbook-${round}` },
          featureId: 'worldbook.open',
          title: '继续执行',
          response: '继续。',
        };
      };
    })(),
    toolRegistry: { executeTool: async () => ({ ok: true }) },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('复合任务');
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reactStepBudget.maxSteps, 40, '4 项清单应在 36 个主动作步外保留 4 个验证/收尾步');
  assert.equal(result.continuable, true);
  console.log('ok - maid.todo.write 开场的复合任务获得 36 主动作步 + 4 验证收尾步');
}

{
  // 同工具同参数连续成功 3 次 = 原地转圈，应中断且可继续
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书',
      response: '我来打开世界书。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '再次打开世界书',
      response: '我再打开一次。',
    }),
    toolRegistry: { executeTool: async toolName => ({ toolName, status: 'succeeded', result: { ok: true }, summary: 'panel opened' }) },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('重复打开世界书面板测试');
  assert.equal(result.status, 'interrupted');
  assert.equal(result.failureCode, 'repeated_tool_loop', '应以 repeated_tool_loop 中断');
  assert.equal(result.continuable, true);
  assert.ok((result.steps || []).length <= 4, '应在少量重复后即中断而不是耗尽预算');
  console.log('ok - 同参数连续成功重复触发防转圈中断');
}

{
  let reactCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'persona', id: 'p1', include: ['associations'] },
      featureId: 'app.resource.read',
      title: '读取海贼王角色卡关联资源',
    }),
    reactPlanner: async () => {
      reactCalls += 1;
      if (reactCalls === 1) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'worldbook.read',
          args: { name: '海贼王', includeContent: false },
          featureId: 'worldbook.read',
          title: '读取海贼王世界书目录',
        };
      }
      return {
        ok: true,
        action: 'final',
        message: '候选成员：路飞、索隆、娜美。',
      };
    },
    toolRegistry: {
      executeTool: async toolName => {
        if (toolName === 'worldbook.read') {
          return {
            toolName,
            status: 'succeeded',
            result: {
              ok: true,
              id: '海贼王',
              name: '海贼王',
              entryCount: 4,
              entries: [
                { id: '0', title: '世界观' },
                { id: '1', title: '蒙奇·D·路飞' },
                { id: '2', title: '罗罗诺亚·索隆' },
                { id: '3', title: '航海士-娜美' },
              ],
            },
            summary: 'read worldbook 海贼王',
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: {
            ok: true,
            resource: 'persona',
            activeId: 'p1',
            count: 1,
            includedFields: ['associations'],
            items: [{
              id: 'p1',
              name: '海贼王',
              active: true,
              associations: {
                worldbookId: '海贼王',
                worldbookEnabled: true,
              },
            }],
          },
          summary: 'read resource persona associations',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt(
    '看看「海贼王」角色卡关联的世界书，从里面挑出适合长期聊天的草帽一伙主要成员，先给我候选清单。',
  );
  assert.equal(result.ok, true);
  assert.equal(result.finalDecision?.source, undefined);
  assert.equal(reactCalls, 2, '筛选候选的分析任务必须继续读取世界书并由模型整理');
  assert.deepEqual(result.steps.map(step => step.toolName), ['app.read_resource', 'worldbook.read']);
  assert.match(result.message, /路飞、索隆、娜美/);
  console.log('ok - 角色卡关联读取不会提前收口需要跨资源筛选的候选任务');
}

{
  let reactCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.read_resource',
      args: { resource: 'persona', include: ['description'] },
      featureId: 'app.resource.read',
      title: '读取角色卡描述',
    }),
    reactPlanner: async () => {
      reactCalls += 1;
      return {
        ok: true,
        action: 'final',
        message: '当前角色卡的完整描述是：详细设定。',
      };
    },
    toolRegistry: {
      executeTool: async toolName => ({
        toolName,
        status: 'succeeded',
        result: {
          ok: true,
          resource: 'persona',
          activeId: 'p1',
          count: 1,
          items: [{ id: 'p1', name: '女仆能力测试', active: true, description: '详细设定。' }],
        },
        summary: 'read resource persona',
      }),
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('读取当前角色卡的完整描述。');
  assert.equal(result.ok, true);
  assert.equal(result.finalDecision?.source, undefined);
  assert.equal(reactCalls, 1, '详细内容请求仍应交给 ReAct 整理');
  assert.match(result.message, /详细设定/);
  console.log('ok - 详细资源内容不被固定摘要提前收口');
}

{
  const calls = [];
  let reactCalls = 0;
  const todos = [{ content: '读取当前 APP 状态', status: 'in_progress' }];
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'maid.todo.write',
      args: { todos },
      featureId: 'maid.todo',
      title: '记录清单',
    }),
    reactPlanner: async () => {
      reactCalls += 1;
      if (reactCalls === 1) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'maid.todo.write',
          args: { todos },
          featureId: 'maid.todo',
          title: '重复记录清单',
        };
      }
      if (reactCalls === 2) {
        return {
          ok: true,
          action: 'tool',
          toolName: 'app.get_current_state',
          args: {},
          featureId: 'app.state.read',
          title: '读取当前状态',
        };
      }
      // 读完由模型自己收尾（11/20 起不再由程序按只读意图整理答案）
      return { ok: true, action: 'final', message: '当前页面是 chat。' };
    },
    toolRegistry: {
      executeTool: async toolName => {
        calls.push(toolName);
        if (toolName === 'maid.todo.write') {
          return {
            toolName,
            status: 'succeeded',
            result: { ok: true, count: 1, todos },
            summary: 'todo list updated',
          };
        }
        return {
          toolName,
          status: 'succeeded',
          result: { activePage: 'chat', uiMode: 'chat', sessionId: '格式修复测试' },
          summary: 'state page=chat session=格式修复测试',
        };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('请读取当前 APP 状态并告诉我当前页面。');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['maid.todo.write', 'app.get_current_state'], '相同清单不应重复写入工具');
  assert.equal(result.steps.some(step => step.output?.reason === 'todo_unchanged'), true);
  assert.match(result.message, /chat/);
  console.log('ok - 相同 todo 写入被视为无进展并引导模型执行具体读取');
}

{
  // 同工具连续（参数不同）超过 8 次 = 单工具打转，应中断可继续
  let round = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true, toolName: 'web.search_images', args: { query: 'q0' },
      featureId: 'web.search', title: '搜索', response: '搜。',
    }),
    reactPlanner: async () => ({
      ok: true, action: 'tool', toolName: 'web.search_images',
      args: { query: `q${round += 1}` },
      featureId: 'web.search', title: '再搜', response: '再搜。',
    }),
    toolRegistry: { executeTool: async (toolName, args) => ({ toolName, status: 'succeeded', result: { ok: true, images: [] }, summary: `searched ${args?.query}` }) },
    maxReactSteps: 40,
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('找图', { maxReactSteps: 40 });
  assert.equal(result.failureCode, 'same_tool_overuse');
  assert.ok((result.steps || []).length <= 10, '应在 8 次左右中断');
  assert.equal(result.continuable, true);
  console.log('ok - 同工具连续超限触发打转中断');
}

{
  let call = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书',
      response: '我来打开世界书。',
    }),
    reactPlanner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'app.open_panel',
      args: { panel: 'memory' },
      featureId: 'memory.open',
      title: '继续',
      response: '继续。',
    }),
    toolRegistry: {
      executeTool: async (toolName, args) => {
        call += 1;
        if (call === 2) {
          return { toolName, status: 'failed', result: { ok: false, reason: 'memory panel busy' }, summary: 'memory panel busy' };
        }
        return { toolName, status: 'succeeded', result: { ok: true }, summary: `opened ${args?.panel}` };
      },
    },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('打开世界书和记忆', { maxReactSteps: 3, repeatedFailureLimit: 8 });
  assert.equal(result.status, 'interrupted', '应因步数耗尽中断（最后一步成功）');
  assert.equal(result.continuable, true);
  assert.match(result.continueHint, /已完成步骤（恢复后不要重复执行，也不要报告为未完成）：/);
  assert.match(result.continueHint, /opened worldbook/);
  assert.match(result.continueHint, /失败步骤：/);
  assert.match(result.continueHint, /memory panel busy/);
  console.log('ok - continueHint 附带已完成与失败步骤清单');
}

{
  // 等待工具确认期间 run 应标记 waiting_permission，确认后恢复 running
  const statusLog = [];
  const runtimeMock = {
    startRun: () => ({ id: 'run-1' }),
    finishRun: () => {},
    startStep: () => ({ id: 'step-1' }),
    finishStep: () => {},
    updateRun: (id, patch) => { statusLog.push(patch?.status); },
    executeTool: async (toolName, args, context) => {
      context.onToolConfirmationPending?.({ toolName });
      await new Promise(r => setTimeout(r, 5));
      context.onToolConfirmationResolved?.({ toolName });
      return { toolName, status: 'succeeded', result: { ok: true }, summary: 'done' };
    },
  };
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true, toolName: 'session.set_wallpaper', args: { target: 'x' },
      featureId: 'session.wallpaper.set', title: '设置', response: '我来设置。',
    }),
    reactPlanner: async () => ({ ok: true, action: 'final', message: '完成', response: '完成' }),
    agentTaskRuntime: runtimeMock,
    toolRegistry: { executeTool: async () => ({ ok: true }) },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('设置壁纸');
  assert.equal(result.ok, true);
  assert.deepEqual(statusLog.filter(s => s === 'waiting_permission').length, 1, '确认等待应标记一次');
  const waitIdx = statusLog.indexOf('waiting_permission');
  const resumeIdx = statusLog.indexOf('running');
  assert.ok(waitIdx >= 0 && resumeIdx > waitIdx, '确认后应恢复 running');
  console.log('ok - 工具确认等待期间 run 标记 waiting_permission 并在确认后恢复');
}

{
  const snapshots = [];
  const observed = [];
  const routingRuntime = {
    beginRequest: () => ({ id: 'request-1' }),
    prepareDecision: ({ phase }) => {
      const snapshot = {
        id: `snapshot-${snapshots.length + 1}`,
        phase,
        useCandidates: false,
        promptFeatures: [],
      };
      snapshots.push(snapshot);
      return snapshot;
    },
    observeDecision: (snapshot, decision) => {
      observed.push({ snapshot: snapshot.id, decision });
      return {
        ...decision,
        candidateSnapshotId: snapshot.id,
        retrieverVersion: 'test-v1',
        selectedCapabilityId: decision.featureId || '',
        candidateHit: Boolean(decision.toolName),
      };
    },
    validatePlan: plan => ({ ok: true, plan }),
    finishRequest: () => ({
      requestId: 'request-1',
      decisionCount: snapshots.length,
      validSelectionCount: 1,
      hitCount: 1,
      allValidSelectionsCovered: true,
      lastCandidateSnapshotId: snapshots.at(-1)?.id || '',
    }),
  };
  const agent = createMaidAssistantAgent({
    capabilityRoutingRuntime: routingRuntime,
    planner: async (_input, context) => {
      assert.equal(context.capabilitySnapshot.id, 'snapshot-1');
      return {
        ok: true,
        toolName: 'app.open_panel',
        args: { panel: 'worldbook' },
        featureId: 'worldbook.open',
        title: '打开世界书',
      };
    },
    reactPlanner: async (_input, context) => {
      assert.equal(context.capabilitySnapshot.id, 'snapshot-2');
      assert.equal(context.maidReactSteps.length, 1);
      return { ok: true, action: 'final', message: '完成。' };
    },
    toolRegistry: {
      executeTool: async () => ({
        toolName: 'app.open_panel',
        status: 'succeeded',
        result: { ok: true },
        summary: 'opened',
      }),
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('打开世界书', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshots.map(item => item.phase), ['planner', 'react']);
  assert.equal(result.steps[0].candidateSnapshotId, 'snapshot-1');
  assert.equal(result.steps[0].candidateHit, true);
  assert.equal(result.capabilityRouting.allValidSelectionsCovered, true);
  assert.equal(observed.length, 2);
  console.log('ok - maid assistant creates a fresh capability snapshot for every Planner/ReAct decision');
}

{
  const agent = createMaidAssistantAgent({
    capabilityRoutingRuntime: {
      beginRequest: () => ({ id: 'fallback-request' }),
      prepareDecision: () => { throw new Error('retriever unavailable'); },
      finishRequest: () => null,
    },
    planner: async () => ({
      ok: true,
      toolName: 'app.open_panel',
      args: { panel: 'worldbook' },
      featureId: 'worldbook.open',
      title: '打开世界书',
    }),
    reactPlanner: async () => ({ ok: true, action: 'final', message: '完成。' }),
    toolRegistry: {
      executeTool: async () => ({
        toolName: 'app.open_panel',
        status: 'succeeded',
        result: { ok: true },
      }),
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('打开世界书');
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].toolName, 'app.open_panel');
  console.log('ok - retriever failures degrade to the existing full-catalog execution path');
}

{
  const observed = [];
  let finished = 0;
  const agent = createMaidAssistantAgent({
    capabilityRoutingRuntime: {
      beginRequest: () => ({ id: 'failed-request' }),
      prepareDecision: () => ({ id: 'failed-snapshot', useCandidates: false, promptFeatures: [] }),
      observeDecision: (_snapshot, decision, options) => {
        observed.push({ decision, options });
        return decision;
      },
      finishRequest: () => { finished += 1; },
    },
    planner: async () => { throw new Error('planner offline'); },
    logger: { warn() {}, debug() {} },
  });
  await assert.rejects(() => agent.runPrompt('看看状态'), /planner offline/);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].decision.reason, 'model_call_failed');
  assert.equal(observed[0].options.countForRecall, false);
  assert.equal(finished, 1);
  console.log('ok - failed model calls still record the shown candidate impression');
}

{
  const incomplete = normalizeMaidImportedCardClassification({
    entries: [{ entryId: 'e1', kind: 'character' }],
    candidates: [{ entryId: 'e1', name: '甲', confidence: 1, reason: '主角' }],
  }, {
    entries: [{ id: 'e1', title: '甲' }, { id: 'e2', title: '世界观' }],
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'classification_coverage_incomplete');
  console.log('ok - imported-card classification must cover every worldbook entry');
}

const buildImportedCardHarness = () => {
  const worldEntries = Array.from({ length: 97 }, (_, index) => ({
    id: `entry-${index + 1}`,
    title: `明确条目-${index + 1}`,
    keys: [`key-${index + 1}`],
    disabled: index % 2 === 0,
  }));
  const selected = [
    { entryId: 'entry-1', name: '路飞', confidence: 0.99, reason: '船长与主角' },
    { entryId: 'entry-2', name: '索隆', confidence: 0.98, reason: '核心战斗员' },
    { entryId: 'entry-3', name: '娜美', confidence: 0.98, reason: '核心航海士' },
  ];
  const contacts = new Map();
  const state = { activePersonaId: 'persona-one-piece', classifierCalls: 0, classifierInputs: [] };
  const calls = [];
  const allowAll = { evaluateTool: () => ({ decision: 'allow', checks: [] }) };
  const registry = createAgentToolRegistry({ permissionEvaluator: allowAll, logger: { warn() {} } });
  const makeTool = (name, execute) => ({
    name,
    title: name,
    description: name,
    schema: { type: 'object', additionalProperties: true },
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: ['persona.switch', 'session.create', 'group.create', 'group.update_members'].includes(name),
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'none',
      confirmation: 'allow_once',
    },
    execute,
  });
  registry.registerMany([
    makeTool('app.read_resource', async (args = {}) => {
      calls.push({ toolName: 'app.read_resource', args: structuredClone(args) });
      if (args.resource === 'persona') {
        return {
          ok: true,
          resource: 'persona',
          activeId: state.activePersonaId,
          items: [{
            id: 'persona-one-piece',
            name: '海贼王',
            active: state.activePersonaId === 'persona-one-piece',
            associations: {
              worldbookId: 'world-one-piece',
              worldbookEnabled: true,
            },
          }],
        };
      }
      if (args.resource === 'session') {
        return {
          ok: true,
          resource: 'session',
          sessions: Array.from(contacts.values()).map(contact => ({
            id: contact.id,
            name: contact.name,
            isGroup: contact.isGroup === true,
            members: (contact.members || []).map(id => ({ id, name: id })),
            memberCount: (contact.members || []).length,
            worldbooks: {
              directWorldIds: [],
              roleWorldIds: ['world-one-piece'],
              resolvedWorldIds: ['world-one-piece'],
              globalWorldId: '',
            },
          })),
        };
      }
      return { ok: false, reason: 'unsupported_fixture_resource' };
    }),
    makeTool('worldbook.read', async (args = {}) => {
      calls.push({ toolName: 'worldbook.read', args: structuredClone(args) });
      return {
        ok: true,
        id: 'world-one-piece',
        name: '海贼王',
        entryCount: worldEntries.length,
        returnedEntryCount: worldEntries.length,
        entries: worldEntries,
        truncated: false,
      };
    }),
    makeTool('session.list', async (args = {}) => {
      calls.push({ toolName: 'session.list', args: structuredClone(args) });
      return {
        count: contacts.size,
        contacts: Array.from(contacts.values()).map(contact => ({
          id: contact.id,
          name: contact.name,
          isGroup: contact.isGroup === true,
          memberCount: (contact.members || []).length,
        })),
      };
    }),
    makeTool('persona.switch', async (args = {}) => {
      calls.push({ toolName: 'persona.switch', args: structuredClone(args) });
      state.activePersonaId = args.target;
      return { ok: true, personaId: state.activePersonaId };
    }),
    makeTool('session.create', async (args = {}) => {
      calls.push({ toolName: 'session.create', args: structuredClone(args) });
      const sessions = args.names.map((name) => {
        const existing = contacts.get(name);
        if (!existing) contacts.set(name, { id: name, name, isGroup: false, members: [] });
        return { ok: true, created: !existing, sessionId: name };
      });
      return {
        ok: true,
        created: true,
        count: sessions.length,
        createdCount: sessions.filter(item => item.created).length,
        sessionIds: sessions.map(item => item.sessionId),
        sessions,
      };
    }),
    makeTool('group.create', async (args = {}) => {
      calls.push({ toolName: 'group.create', args: structuredClone(args) });
      const group = {
        id: 'group:crew',
        name: args.name,
        isGroup: true,
        members: args.members.slice(),
      };
      contacts.set(group.id, group);
      return {
        ok: true,
        created: true,
        verified: true,
        group: {
          ...group,
          memberCount: group.members.length,
          members: group.members.map(id => ({ id, name: id })),
        },
      };
    }),
    makeTool('group.update_members', async () => ({ ok: false, reason: 'not_expected' })),
    makeTool('session.open', async (args = {}) => {
      calls.push({ toolName: 'session.open', args: structuredClone(args) });
      return { ok: true, sessionId: args.sessionId };
    }),
  ]);
  registry.registerMany(createImportedCardRoomTools({
    executeTool: (name, args, context) => registry.executeTool(name, args, context),
    classify: async ({ input, entries }) => {
      state.classifierCalls += 1;
      state.classifierInputs.push(input);
      assert.equal(entries.length, 97, '分类器必须拿到完整紧凑索引');
      return {
        entries: entries.map(entry => ({
          entryId: entry.id,
          kind: selected.some(item => item.entryId === entry.id) ? 'character' : 'other',
        })),
        candidates: selected,
        group: {
          enabled: true,
          name: '草帽一伙',
          memberEntryIds: selected.map(item => item.entryId),
        },
      };
    },
  }));
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  return { registry, runtime, store, calls, state, contacts };
};

{
  // 导入卡挑人物建房改成模型可调用的工具：模型传 createRooms/groupName/openWhenDone，工具冻结清单，确认后照旧执行
  const h = buildImportedCardHarness();
  let plannerCalls = 0;
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: h.runtime,
    toolRegistry: h.registry,
    planner: async () => {
      plannerCalls += 1;
      return plannerCalls === 1
        ? {
            ok: true,
            toolName: 'session.plan_character_rooms',
            featureId: 'session.character_rooms.plan',
            args: { createRooms: true, groupName: '草帽一伙', criteria: '草帽一伙主要成员', openWhenDone: true },
            title: '挑人物建房',
          }
        : { ok: false, reason: 'normal_planner_must_not_run' };
    },
    logger: { warn() {}, debug() {} },
  });

  const preview = await agent.runPrompt(
    '我现在就在「海贼王」角色卡。请从这张导入卡自带的世界书挑出草帽一伙主要人物，给每个人建立私聊并建一个「草帽一伙」群聊；先给我确认，建好后打开群聊。',
    { source: 'maid_realtime', voiceCallId: 'import-call', submissionId: 'import-preview' },
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.status, 'awaiting_confirmation');
  assert.equal(h.state.classifierCalls, 1);
  assert.deepEqual(h.state.classifierInputs, ['草帽一伙主要成员'], '挑人物范围由模型的 criteria 参数传给分类器');
  assert.equal(plannerCalls, 1);
  assert.match(preview.message, /路飞/);
  assert.match(preview.message, /继承角色卡世界书/);
  assert.equal(h.calls.some(call => ['session.create', 'group.create', 'persona.switch'].includes(call.toolName)), false);
  assert.equal(
    h.calls.find(call => call.toolName === 'worldbook.read').args.maxEntries,
    200,
    '工具按有界完整索引上限读取',
  );
  const pendingRun = h.store.listRuns({ kind: 'maid_assistant' })[0];
  assert.equal(pendingRun.status, 'waiting_permission');
  assert.equal(pendingRun.metadata.maidStatus, 'awaiting_confirmation');
  assert.equal(pendingRun.metadata.pendingWorkflow.candidates.length, 3);
  assert.equal(pendingRun.metadata.pendingWorkflow.group.name, '草帽一伙');
  assert.equal(pendingRun.metadata.pendingWorkflow.revealRequested, true);

  const applied = await agent.runPrompt('好', { source: 'maid_realtime', voiceCallId: 'import-call', submissionId: 'import-apply' });
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'succeeded');
  assert.equal(h.state.classifierCalls, 1, '确认轮必须消费冻结快照，不得重新分类');
  assert.equal(plannerCalls, 1);
  assert.deepEqual(
    h.calls.find(call => call.toolName === 'session.create').args.names,
    ['路飞', '索隆', '娜美'],
  );
  assert.deepEqual(
    h.calls.find(call => call.toolName === 'group.create').args.members,
    ['路飞', '索隆', '娜美'],
  );
  assert.deepEqual(h.calls.at(-1), { toolName: 'session.open', args: { sessionId: 'group:crew' } });
  assert.match(applied.message, /3.*私聊/u);
  assert.match(applied.message, /群聊/u);
  const runs = h.store.listRuns({ kind: 'maid_assistant' });
  const consumedRun = runs.find(run => run.id === pendingRun.id);
  assert.equal(consumedRun.status, 'succeeded');
  assert.equal(consumedRun.metadata.pendingWorkflow.state, 'consumed');
  assert.equal(runs[0].status, 'succeeded');
  console.log('ok - imported-card room tool freezes a zero-write plan and the confirmation applies it');
}

{
  const h = buildImportedCardHarness();
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: h.runtime,
    toolRegistry: h.registry,
    planner: async () => ({
      ok: true,
      toolName: 'session.plan_character_rooms',
      featureId: 'session.character_rooms.plan',
      args: {},
      title: '只挑候选',
    }),
    reactPlanner: async (_input, context) => {
      const step = context.maidReactSteps.at(-1);
      assert.equal(step.output.createRooms, false);
      assert.equal(step.output.candidates.length, 3);
      return { ok: true, action: 'final', message: '候选：路飞、索隆、娜美。' };
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('帮我从当前角色卡的世界书挑出主要人物，这一步只给候选。');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.pendingWorkflow, undefined);
  assert.equal(result.message, '候选：路飞、索隆、娜美。');
  assert.equal(h.calls.some(call => call.toolName === 'session.list'), false, '只列候选时不读会话清单、不冻结清单');
  assert.equal(h.store.listRuns({ kind: 'maid_assistant' }).some(run => run.status === 'waiting_permission'), false);
  console.log('ok - imported-card room tool lists candidates only when createRooms is omitted');
}

{
  const h = buildImportedCardHarness();
  const agent = createMaidAssistantAgent({
    agentTaskRuntime: h.runtime,
    toolRegistry: h.registry,
    planner: async () => ({
      ok: true,
      toolName: 'session.plan_character_rooms',
      featureId: 'session.character_rooms.plan',
      args: { createRooms: true, worldbookStrategy: 'isolated_session_worldbooks' },
      title: '隔离世界书建房',
    }),
    reactPlanner: async (_input, context) => {
      const step = context.maidReactSteps.at(-1);
      assert.equal(step.status, 'failed');
      assert.equal(step.output.reason, 'isolated_worldbook_strategy_not_supported_in_imported_card_workflow');
      assert.equal(step.output.needsInput, true);
      return { ok: true, action: 'final', message: '目前只能继承角色卡世界书。' };
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('从角色卡世界书挑人物，每个私聊用隔离世界书。');
  assert.equal(result.message, '目前只能继承角色卡世界书。');
  assert.equal(h.calls.length, 0, '不支持的世界书策略在读取前就停下');
  assert.equal(h.state.classifierCalls, 0);
  console.log('ok - imported-card room tool reports the unsupported isolated worldbook strategy without reading');
}

{
  const controller = new AbortController();
  let plannerStarted = null;
  const started = new Promise(resolve => { plannerStarted = resolve; });
  const agent = createMaidAssistantAgent({
    planner: async (_input, context) => new Promise((resolve, reject) => {
      plannerStarted();
      context.signal.addEventListener('abort', () => {
        const error = new Error('stopped by user');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    logger: { warn() {}, debug() {} },
  });
  const pending = agent.runPrompt('请规划一个任务', { signal: controller.signal });
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'user_aborted');
  assert.match(result.message, /已完成 0 步/);
  console.log('ok - maid planner cancellation becomes a code-generated cancelled result');
}

{
  const controller = new AbortController();
  let toolStarted = null;
  const started = new Promise(resolve => { toolStarted = resolve; });
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.register({
    name: 'test.wait_for_abort',
    title: '等待取消',
    description: '等待上层取消信号',
    schema: { type: 'object', additionalProperties: false },
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'none',
      confirmation: 'never',
    },
    execute: async (_args, context) => new Promise((resolve, reject) => {
      toolStarted();
      context.signal.addEventListener('abort', () => {
        const error = new Error('tool stopped by user');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const agent = createMaidAssistantAgent({
    toolRegistry: registry,
    agentTaskRuntime: runtime,
    planner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'test.wait_for_abort',
      args: {},
      title: '等待取消',
    }),
    logger: { warn() {}, debug() {} },
  });
  const pending = agent.runPrompt('执行并等待我停止', { signal: controller.signal });
  await started;
  controller.abort();
  const result = await pending;
  const run = store.listRuns({ kind: 'maid_assistant' })[0];
  assert.equal(result.status, 'cancelled');
  assert.equal(run.status, 'cancelled');
  assert.equal(run.metadata.failureCode, 'user_aborted');
  assert.equal(run.steps[0].status, 'cancelled');
  assert.equal(run.steps.filter(step => step.status === 'cancelled').length, 1);
  console.log('ok - maid tool cancellation stops execution and records cancelled run/step exactly once');
}

{
  // 步间取消：工具正常完成后用户点停 → 下一轮 ReAct 规划前立即终止，不再调用模型
  const controller = new AbortController();
  let reactPlannerCalls = 0;
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.register({
    name: 'test.complete_then_stop',
    title: '完成后停止',
    description: '执行成功后触发用户停止',
    schema: { type: 'object', additionalProperties: false },
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'none',
      confirmation: 'never',
    },
    execute: async () => {
      controller.abort();
      return { ok: true, message: '第一步已完成' };
    },
  });
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const agent = createMaidAssistantAgent({
    toolRegistry: registry,
    agentTaskRuntime: runtime,
    planner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'test.complete_then_stop',
      args: {},
      title: '完成后停止',
    }),
    reactPlanner: async () => {
      reactPlannerCalls += 1;
      return { ok: true, action: 'final', response: '不应到达这里' };
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('做完第一步就停', { signal: controller.signal });
  const run = store.listRuns({ kind: 'maid_assistant' })[0];
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'user_aborted');
  assert.equal(reactPlannerCalls, 0);
  assert.equal(run.status, 'cancelled');
  assert.match(result.message, /已完成 1 步/);
  console.log('ok - cancellation between steps stops before the next ReAct planner round with an honest step count');
}

{
  // 外层 signal 未中止时，单独 AbortError 必须保留为供应商失败。
  const agent = createMaidAssistantAgent({
    planner: async () => {
      const error = new Error('transport aborted');
      error.name = 'AbortError';
      throw error;
    },
    logger: { warn() {}, debug() {} },
  });
  const controller = new AbortController();
  await assert.rejects(
    () => agent.runPrompt('规划', { signal: controller.signal }),
    error => error?.name === 'AbortError' && error?.message === 'transport aborted',
  );
  assert.equal(controller.signal.aborted, false);
  console.log('ok - bare AbortError with a live caller signal is not misclassified as user cancellation');
}

{
  // registry 会把工具结果包在 output.result；内层取消仍必须记为 cancelled。
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.register({
    name: 'test.return_cancelled',
    title: '返回取消',
    description: '模拟工具以业务结果返回用户取消',
    schema: { type: 'object', additionalProperties: false },
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'none',
      confirmation: 'never',
    },
    execute: async () => ({
      ok: false,
      cancelled: true,
      reason: 'user_aborted',
      message: '用户已取消该工具。',
    }),
  });
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const agent = createMaidAssistantAgent({
    toolRegistry: registry,
    agentTaskRuntime: runtime,
    planner: async () => ({
      ok: true,
      action: 'tool',
      toolName: 'test.return_cancelled',
      args: {},
      title: '返回取消',
    }),
    reactPlanner: async () => {
      throw new Error('取消后不得继续 ReAct');
    },
    logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('执行后取消');
  const run = store.listRuns({ kind: 'maid_assistant' })[0];
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'user_aborted');
  assert.equal(result.steps[0].status, 'cancelled');
  assert.equal(run.status, 'cancelled');
  assert.equal(run.steps[0].status, 'cancelled');
  console.log('ok - registry-wrapped tool cancellation stops ReAct and records cancelled run/step');
}

{
  // 用户设置的执行步数上限（context.maxReactSteps）抬高 hardMax，且类型内上限跟随生效
  const makeAgent = () => createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      toolName: 'maid.todo.write',
      args: { todos: Array.from({ length: 10 }, (_, index) => ({ content: `item-${index}` })) },
      featureId: 'maid.todo',
      title: '记录任务清单',
      response: '我先记录任务清单。',
    }),
    reactPlanner: (() => {
      let round = 0;
      const toolNames = ['app.open_panel', 'app.read_resource', 'app.get_current_state'];
      return async () => {
        round += 1;
        return {
          ok: true,
          action: 'tool',
          toolName: toolNames[round % toolNames.length],
          args: { panel: `worldbook-${round}` },
          featureId: 'worldbook.open',
          title: '继续执行',
          response: '继续。',
        };
      };
    })(),
    toolRegistry: { executeTool: async () => ({ ok: true }) },
    logger: { warn() {} },
  });
  const defaultResult = await makeAgent().runPrompt('十项清单长任务');
  assert.equal(defaultResult.status, 'interrupted');
  assert.equal(defaultResult.reactStepBudget.hardMax, 48, '未设置时 hardMax 沿用出厂 48');
  assert.equal(defaultResult.reactStepBudget.maxSteps, 48, '10 项清单预算被 hardMax 钳制');
  const raisedResult = await makeAgent().runPrompt('十项清单长任务', { maxReactSteps: 80 });
  assert.equal(raisedResult.status, 'interrupted');
  assert.equal(raisedResult.reactStepBudget.hardMax, 80);
  assert.equal(
    raisedResult.reactStepBudget.maxSteps,
    76,
    '调高上限后 10 项清单应获得 72 主动作步 + 4 验证收尾步（类型内上限跟随 hardMax）',
  );
  console.log('ok - user-configured maxReactSteps raises both hardMax and per-type budget caps');
}
