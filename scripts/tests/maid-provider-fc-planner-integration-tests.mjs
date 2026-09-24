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
