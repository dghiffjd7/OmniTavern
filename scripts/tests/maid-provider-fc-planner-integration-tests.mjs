import assert from 'node:assert/strict';
import {
  buildMaidModelPlannerMessages,
  createMaidModelBackedPlanner,
  createMaidModelBackedReActPlanner,
} from '../../src/scripts/agent/maid-model-planner.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { MAID_PROVIDER_FC_CONTROL_TOOL_NAME } from '../../src/scripts/agent/maid-provider-fc-planner.js';
import { resolveGlobalSemanticPromptPlan } from '../../src/scripts/agent/global-semantic-prompt-library.js';

const feature = {
  id: 'session.list',
  title: '读取会话列表',
  tools: ['session.list'],
  toolSchemas: {
    'session.list': {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1 } },
    },
  },
};

const snapshot = {
  id: 'cap-stage-e-integration',
  useCandidates: true,
  candidateFeatures: [feature],
  promptFeatures: [feature],
};

const runtimeConfig = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com/v1',
};

const context = {
  sessionId: 'maid-stage-e',
  uiMode: 'chat',
  capabilitySnapshot: snapshot,
};

const emitToolCall = (options, {
  control = false,
  args = { query: '当前' },
} = {}) => {
  const tool = control
    ? options.tools.find(item => item.function.name === MAID_PROVIDER_FC_CONTROL_TOOL_NAME)
    : options.tools.find(item => item.function.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
  options.onProviderToolCallDelta({
    choices: [{
      message: {
        tool_calls: [{
          id: 'call-integration',
          type: 'function',
          function: { name: tool.function.name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
};

{
  let task = 1;
  const modelCalls = [];
  const executed = [];
  const decisions = [];
  const client = {
    async chat(_messages, options) {
      const native = Array.isArray(options.tools) && options.tools.length > 0;
      modelCalls.push({ task, mode: native ? 'provider_fc' : 'prompted_json' });
      if (native && task === 1) {
        const tool = options.tools.find(item => item.function.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
        options.onProviderToolCallDelta({ output: ['rejected-first', 'rejected-second'].map((query, index) => ({
          type: 'function_call', id: `fc-multiple-${index}`, call_id: `call-multiple-${index}`,
          name: tool.function.name, arguments: JSON.stringify({ query: index === 1 ? 42 : query }),
        })) }, { provider: 'deepseek', model: 'deepseek-flash' });
        return '';
      }
      const taskExecutions = executed.filter(item => item.task === task).length;
      if (native) {
        emitToolCall(options, taskExecutions
          ? { control: true, args: { action: 'final', message: 'Complete.' } }
          : { args: { query: 'independent-task' } });
        return '';
      }
      return JSON.stringify(taskExecutions < 2
        ? { ok: true, action: 'tool', toolName: 'session.list', featureId: 'session.list', args: { query: `accepted-${taskExecutions}` } }
        : { ok: true, action: 'final', message: 'Complete.' });
    },
  };
  const dependencies = {
    features: [feature],
    resolveRuntimeConfig: async () => ({ config: { ...runtimeConfig, model: 'deepseek-flash' }, client }),
    getProviderFcExperimentStatus: () => ({ enabled: true }),
    logger: { warn() {}, debug() {} },
  };
  const planner = createMaidModelBackedPlanner(dependencies);
  const react = createMaidModelBackedReActPlanner(dependencies);
  const recordDecision = fn => async (input, decisionContext) => {
    const decision = await fn(input, decisionContext);
    decisions.push({ task, transport: decision.plannerTransport });
    return decision;
  };
  const agent = createMaidAssistantAgent({
    planner: recordDecision(planner), reactPlanner: recordDecision(react), maxReactSteps: 5,
    toolRegistry: { executeTool: async (toolName, args) => {
      executed.push({ task, toolName, query: args.query });
      return { toolName, status: 'succeeded', result: { ok: true, count: 2 } };
    } },
    logger: { warn() {}, debug() {} },
  });
  const first = await agent.runPrompt('List the sessions and check them again.', context);
  assert.equal(first.ok, true);
  assert.deepEqual(modelCalls.map(call => call.mode), ['provider_fc', 'prompted_json', 'prompted_json', 'prompted_json'],
    'a rejected batch causes only one FC attempt in this task, across copied planner/ReAct contexts');
  assert.deepEqual(executed.map(item => item.query), ['accepted-0', 'accepted-1'], 'no rejected child call is executed or replayed');
  assert.ok(decisions.every(item => item.transport.effectiveMode === 'prompted_json'
    && item.transport.fallbackReason === 'multiple_tool_calls'));
  task = 2;
  const second = await agent.runPrompt('List the sessions.', context);
  assert.equal(second.ok, true);
  assert.deepEqual(modelCalls.filter(call => call.task === 2).map(call => call.mode), ['provider_fc', 'provider_fc'],
    'the next task retries FC without a global cooldown or profile change');
  assert.deepEqual(executed.filter(item => item.task === 2).map(item => item.query), ['independent-task']);
  assert.ok(decisions.filter(item => item.task === 2).every(item => item.transport.fallbackReason === ''));
  console.log('ok - invalid multiple FC calls switch only the current task to JSON without executing the rejected batch');
}

{
  const modelCalls = [], executed = [];
  const client = { async chat(_messages, options) {
    modelCalls.push(options);
    if (modelCalls.length === 1) {
      const tool = options.tools.find(item => item.function.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
      options.onProviderToolCallDelta({ output: ['first', 'second', 'third'].map((query, index) => ({
        type: 'function_call', id: `read-${index}`, call_id: `read-${index}`,
        name: tool.function.name, arguments: JSON.stringify({ query }),
      })) }, { provider: 'deepseek', model: 'deepseek-flash' });
    } else emitToolCall(options, { control: true, args: { action: 'final', message: 'Read all three.' } });
    return '';
  } };
  const dependencies = { features: [feature],
    resolveRuntimeConfig: async () => ({ config: runtimeConfig, client }),
    getProviderFcExperimentStatus: () => ({ enabled: true }), logger: { warn() {}, debug() {} } };
  const agent = createMaidAssistantAgent({
    planner: createMaidModelBackedPlanner(dependencies), reactPlanner: createMaidModelBackedReActPlanner(dependencies),
    maxReactSteps: 5, toolRegistry: { executeTool: async (toolName, args) => {
      executed.push({ toolName, args });
      return { toolName, status: 'succeeded', result: { ok: true, query: args.query } };
    } }, logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('Read three different session searches.', context);
  assert.equal(result.ok, true);
  assert.deepEqual(executed.map(item => item.args.query), ['first', 'second', 'third']);
  assert.equal(modelCalls.length, 2, 'one response supplies three reads; model sees all observations before finishing');
  console.log('ok - validated native reads execute serially through normal agent steps without extra model calls');
}

// A queued selection is never a cached permission. Failed observations, changed
// candidates and cancellation must prevent the remaining read from running.
for (const scenario of ['failed_read', 'candidate_removed', 'cancelled', 'new_input']) {
  let modelCalls = 0;
  const shared = { fallbackReason: '', diagnostics: null };
  const client = { async chat(_messages, options) {
    modelCalls++;
    if (modelCalls === 1) {
      const tool = options.tools.find(item => item.function.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
      options.onProviderToolCallDelta({ output: ['a', 'b'].map((query, index) => ({
        type: 'function_call', id: `guard-${index}`, call_id: `guard-${index}`,
        name: tool.function.name, arguments: JSON.stringify({ query }),
      })) }, { provider: 'deepseek', model: 'deepseek-flash' });
      return '';
    }
    if (options.tools) {
      emitToolCall(options, { control: true, args: { action: 'final', message: 'Stopped.' } });
      return '';
    }
    return JSON.stringify({ ok: true, action: 'final', message: 'Stopped.' });
  } };
  const dependencies = { features: [feature], resolveRuntimeConfig: async () => ({ config: runtimeConfig, client }),
    getProviderFcExperimentStatus: () => ({ enabled: true }), logger: { warn() {}, debug() {} } };
  const planner = createMaidModelBackedPlanner(dependencies), react = createMaidModelBackedReActPlanner(dependencies);
  const first = await planner('Read a and b.', { ...context, maidProviderFcState: shared });
  assert.equal(first.args.query, 'a');
  const nextContext = { ...context, maidProviderFcState: shared, maidReactSteps: [{
    toolName: first.toolName, args: first.args, status: scenario === 'failed_read' ? 'failed' : 'succeeded', output: { ok: scenario !== 'failed_read' },
  }] };
  if (scenario === 'candidate_removed') nextContext.capabilitySnapshot = { ...snapshot, candidateFeatures: [] };
  if (scenario === 'cancelled') nextContext.signal = AbortSignal.abort();
  if (scenario === 'cancelled') await assert.rejects(react('Read a and b.', nextContext), { name: 'AbortError' });
  else {
    const next = await react(scenario === 'new_input' ? 'Stop reading.' : 'Read a and b.', nextContext);
    assert.notEqual(next.toolName, 'session.list', scenario);
    assert.equal(modelCalls, 2, scenario);
  }
  assert.equal(shared.readBatch, null, scenario);
}
console.log('ok - pending native reads stop after failure, lost candidates, cancellation or a changed request');

// 从 provider tool call 一直走到最终 decision，避免标准化后又被第二次截断。
{
  const answer = '规则集名称。'.repeat(340) + 'FINAL_ENTRY';
  const planner = createMaidModelBackedReActPlanner({
    getProviderFcExperimentStatus: () => ({ enabled: true }),
    resolveRuntimeConfig: async () => ({ configured: true, config: runtimeConfig,
      client: { chat: async (_messages, options) => { emitToolCall(options, { control: true, args: { action: 'final', message: answer } }); return ''; } },
    }),
    logger: { warn() {}, debug() {} },
  });
  const decision = await planner('列出全部名称', { ...context, maidReactSteps: [] });
  assert.equal(decision.ok, true);
  assert.equal(decision.message, answer);
  console.log('ok - long FC answers reach the final decision without losing entries');
}

// 手动思考不先发送一个注定被拒的强制工具请求，直接走兼容文本规划并保留思考设置。
{
  let calls = 0;
  const planner = createMaidModelBackedPlanner({
    features: [feature], getProviderFcExperimentStatus: () => ({ enabled: true }),
    resolveRuntimeConfig: async () => ({ config: { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
      generationSettings: { reasoningMode: 'on', reasoningEffort: 'low' },
      client: { chat: async (_messages, options) => {
        calls++;
        assert.equal(options.thinking, undefined);
        assert.equal(options.tool_choice.type, 'any');
        const tool = options.tools.find(item => item.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
        options.onProviderToolCallDelta({ type: 'message', content: [{ type: 'tool_use', id: 'haiku-tool', name: tool.name, input: { query: '当前' } }] });
        return '';
      } },
    }), logger: { warn() {}, debug() {} },
  });
  const result = await planner('列出当前会话', context);
  assert.equal(result.ok, true);
  assert.equal(result.plannerTransport.effectiveMode, 'provider_fc');
  assert.equal(result.plannerTransport.thinkingEnabled, false);
  assert.equal(calls, 1);
  console.log('ok - unsupported reasoning does not disable available Anthropic function calling');
}

{
  let calls = 0;
  const planner = createMaidModelBackedPlanner({
    features: [feature], getProviderFcExperimentStatus: () => ({ enabled: true }),
    resolveRuntimeConfig: async () => ({ config: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      generationSettings: { reasoningMode: 'on', reasoningEffort: 'low' },
      client: { chat: async (_messages, options) => {
        calls++;
        assert.equal(options.tools, undefined);
        assert.equal(options.thinking.type, 'enabled');
        assert.equal(options.temperature, undefined);
        return JSON.stringify({ ok: true, toolName: 'session.list', args: { query: '当前' }, featureId: 'session.list' });
      } },
    }), logger: { warn() {}, debug() {} },
  });
  const result = await planner('列出当前会话', context);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(result.plannerTransport.fallbackReason, 'anthropic_manual_thinking_forced_tool_unsupported');
  console.log('ok - manual Anthropic thinking falls back before a request, preserving thinking without forced tools');
}

{
  const globalSemanticPromptPlan = resolveGlobalSemanticPromptPlan({
    blocks: [
      {
        id: 'maid-header',
        name: 'Maid header',
        enabled: true,
        content: 'GLOBAL HEADER {{char}}',
        scope: 'maid',
        anchor: 'semantic_header',
      },
      {
        id: 'maid-latest',
        name: 'Before latest',
        enabled: true,
        content: 'GLOBAL BEFORE USER',
        scope: 'maid',
        anchor: 'before_latest_user',
      },
    ],
  }, {
    scope: 'maid',
    rootPlanner: true,
    char: 'Serena',
  });
  const messages = buildMaidModelPlannerMessages({
    input: '列出会话',
    features: [feature],
    globalSemanticPromptPlan,
  });
  assert.equal(messages[0].content, 'GLOBAL HEADER Serena');
  assert.equal(messages.at(-2).content, 'GLOBAL BEFORE USER');
  assert.equal(messages.at(-1).role, 'user');
  assert.ok(messages.every(message => message.role === 'system' || message.role === 'user'));
  console.log('ok - maid root planner injects the frozen global semantic plan at named anchors');
}

{
  let libraryReads = 0;
  const captured = [];
  const planner = createMaidModelBackedPlanner({
    features: [feature],
    resolveRuntimeConfig: async () => ({
      config: runtimeConfig,
      client: {
        async chat(messages, options) {
          captured.push(messages.map(message => String(message.content || '')));
          if (options.tools) return '没有调用工具';
          return JSON.stringify({
            ok: true,
            toolName: 'session.list',
            args: { query: '当前' },
            featureId: 'session.list',
            title: '读取会话列表',
            response: '我来查看。',
          });
        },
      },
    }),
    getProviderFcExperimentStatus: () => ({ enabled: true }),
    getGlobalSemanticPromptLibrary: () => {
      libraryReads += 1;
      return {
        blocks: [{
          id: 'maid-once',
          name: 'Once',
          enabled: true,
          content: 'FROZEN MAID GLOBAL',
          scope: 'maid',
          anchor: 'semantic_header',
        }],
      };
    },
  });
  const result = await planner('列出当前会话', context);
  assert.equal(result.ok, true);
  assert.equal(libraryReads, 1, 'the library and macros are resolved once for the root task');
  assert.equal(captured.length, 2, 'FC failure uses the existing prompted-JSON fallback');
  assert.equal(captured[0][0], 'FROZEN MAID GLOBAL');
  assert.equal(captured[1][0], 'FROZEN MAID GLOBAL');
  console.log('ok - maid FC fallback reuses one frozen global prompt plan');
}

{
  let capturedMessages = null;
  let calls = 0;
  const planner = createMaidModelBackedPlanner({
    features: [feature],
    resolveRuntimeConfig: async () => ({
      config: runtimeConfig,
      client: {
        async chat(messages, options) {
          calls += 1;
          capturedMessages = messages;
          emitToolCall(options);
          return '';
        },
      },
      profileId: 'deepseek-stage-e',
    }),
    getProviderFcExperimentStatus: () => ({ enabled: true, thinkingEnabled: false }),
  });
  const plan = await planner('列出当前会话', context);
  assert.equal(calls, 1);
  assert.equal(plan.ok, true);
  assert.equal(plan.toolName, 'session.list');
  assert.equal(plan.featureId, 'session.list');
  assert.equal(plan.source, 'maid_provider_fc');
  assert.equal(plan.plannerTransport.requestedMode, 'provider_fc');
  assert.equal(plan.plannerTransport.effectiveMode, 'provider_fc');
  assert.equal(plan.plannerTransport.providerEndpoint, 'official_deepseek_responses');
  assert.equal(plan.plannerTransport.thinkingRequested, false);
  assert.equal(plan.plannerTransport.thinkingEnabled, false);
  assert.equal(plan.plannerTransport.thinkingOverrideReason, '');
  const systemText = String(capturedMessages[0]?.content || '');
  assert.doesNotMatch(systemText, /严格 JSON|\{"ok"/);
  assert.match(systemText, /APP 函数/);
  console.log('ok - maid planner uses native FC without prompted JSON when the bounded DeepSeek gate is eligible');
}

{
  let calls = 0;
  const planner = createMaidModelBackedPlanner({
    features: [feature],
    resolveRuntimeConfig: async () => ({
      config: runtimeConfig,
      client: {
        async chat(_messages, options) {
          calls += 1;
          if (options.tools) return '没有调用工具';
          return JSON.stringify({
            ok: true,
            toolName: 'session.list',
            args: { query: '当前' },
            featureId: 'session.list',
            title: '读取会话列表',
            response: '我来查看。',
          });
        },
      },
      profileId: 'deepseek-stage-e',
    }),
    getProviderFcExperimentStatus: () => ({ enabled: true, thinkingEnabled: false }),
  });
  const plan = await planner('列出当前会话', context);
  assert.equal(calls, 2);
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'model_planner');
  assert.equal(plan.plannerTransport.requestedMode, 'provider_fc');
  assert.equal(plan.plannerTransport.effectiveMode, 'prompted_json');
  assert.equal(plan.plannerTransport.fallbackReason, 'no_tool_call');
  console.log('ok - maid planner falls back to prompted JSON before execution when FC returns no call');
}

{
  const reactPlanner = createMaidModelBackedReActPlanner({
    features: [feature],
    resolveRuntimeConfig: async () => ({
      config: runtimeConfig,
      client: {
        async chat(_messages, options) {
          emitToolCall(options, {
            control: true,
            args: { action: 'final', message: '已经查完了。' },
          });
          return '';
        },
      },
    }),
    getProviderFcExperimentStatus: () => ({ enabled: true, thinkingEnabled: true }),
  });
  const decision = await reactPlanner('列出当前会话', {
    ...context,
    maidReactSteps: [{ toolName: 'session.list', status: 'succeeded', output: { count: 2 } }],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'final');
  assert.equal(decision.message, '已经查完了。');
  assert.equal(decision.source, 'maid_provider_fc');
  assert.equal(decision.plannerTransport.providerEndpoint, 'official_deepseek_responses');
  assert.equal(decision.plannerTransport.thinkingRequested, true);
  assert.equal(decision.plannerTransport.thinkingEnabled, false);
  assert.equal(
    decision.plannerTransport.thinkingOverrideReason,
    'deepseek_forced_tool_choice_incompatible',
  );
  console.log('ok - maid ReAct consumes the local FC final control call');
}

{
  let chatResponderCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      action: 'final',
      message: '请先告诉我要操作哪个会话。',
      source: 'maid_provider_fc',
      providerFcControl: 'clarify',
    }),
    chatResponder: async () => {
      chatResponderCalls += 1;
      return { ok: true, message: '不应调用' };
    },
  });
  const result = await agent.runPrompt('帮我处理一下');
  assert.equal(result.ok, true);
  assert.equal(result.responseType, 'chat');
  assert.equal(result.message, '请先告诉我要操作哪个会话。');
  assert.equal(chatResponderCalls, 0);
  console.log('ok - initial maid FC control decisions return locally without executing a tool or a second model');
}

{
  const messages = buildMaidModelPlannerMessages({
    input: '列出会话',
    features: [feature],
    transportMode: 'provider_fc',
  });
  assert.doesNotMatch(String(messages[0].content), /schemas:/);
  assert.doesNotMatch(String(messages[0].content), /严格 JSON|\{"ok"/);
  console.log('ok - FC planner prompt omits duplicated schema text and prompted-JSON examples');
}
