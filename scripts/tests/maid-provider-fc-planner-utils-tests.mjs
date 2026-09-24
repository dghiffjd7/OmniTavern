import assert from 'node:assert/strict';
import {
  MAID_PROVIDER_FC_CONTROL_TOOL_NAME,
  buildMaidProviderFcToolPlan,
  normalizeMaidProviderFcCompletedCalls,
  resolveMaidProviderFcEligibility,
  resolveMaidProviderFcRuntimeStatus,
  runMaidProviderFcAttempt,
  MAID_PROVIDER_FC_FAILURE_COOLDOWN_MS,
  isProviderFcRequestRejection,
  resetMaidProviderFcCooldowns,
} from '../../src/scripts/agent/maid-provider-fc-planner.js';

const readFeature = {
  id: 'session.list',
  title: '读取会话列表',
  tools: ['session.list'],
  toolSchemas: {
    'session.list': {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
      },
    },
  },
};

const writeFeature = {
  id: 'session.create',
  title: '创建会话',
  tools: ['session.create'],
  toolSchemas: {
    'session.create': {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
      },
    },
  },
};

const candidateSnapshot = {
  id: 'cap-stage-e',
  useCandidates: true,
  candidateFeatures: [readFeature, writeFeature],
  promptFeatures: [readFeature, writeFeature],
};

const deepSeekConfig = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com/v1',
};

{
  assert.deepEqual(resolveMaidProviderFcRuntimeStatus(), {
    enabled: true,
    thinkingEnabled: false,
    defaultEnabled: true,
    runtimeOnly: false,
    overrideActive: false,
    compatibilityModeEnabled: false,
    source: 'product_default',
  });
  assert.equal(resolveMaidProviderFcRuntimeStatus({
    compatibilityModeEnabled: true,
  }).enabled, false);
  assert.deepEqual(resolveMaidProviderFcRuntimeStatus({
    compatibilityModeEnabled: true,
    runtimeOverride: { enabled: true, thinkingEnabled: true },
  }), {
    enabled: true,
    thinkingEnabled: true,
    defaultEnabled: true,
    runtimeOnly: false,
    overrideActive: true,
    compatibilityModeEnabled: true,
    source: 'runtime_override',
  });
  console.log('ok - maid provider FC defaults on, respects compatibility mode, and supports bounded dev overrides');
}

{
  const eligible = resolveMaidProviderFcEligibility({
    experimentStatus: { enabled: true, thinkingEnabled: false },
    config: deepSeekConfig,
    capabilitySnapshot: candidateSnapshot,
    messages: [{ role: 'user', content: '列出会话' }],
    phase: 'planner',
    client: { chat() {} },
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, '');
  assert.equal(eligible.thinkingEnabled, false);

  assert.equal(resolveMaidProviderFcEligibility({
    experimentStatus: { enabled: false },
    config: deepSeekConfig,
    capabilitySnapshot: candidateSnapshot,
    phase: 'planner',
    client: { chat() {} },
  }).reason, 'experiment_disabled');
  assert.equal(resolveMaidProviderFcEligibility({
    experimentStatus: { enabled: true },
    config: { ...deepSeekConfig, provider: 'custom', baseUrl: 'https://example.com/v1' },
    capabilitySnapshot: candidateSnapshot,
    phase: 'planner',
    client: { chat() {} },
  }).reason, 'unverified_custom_endpoint');
  assert.equal(resolveMaidProviderFcEligibility({
    experimentStatus: { enabled: true },
    config: {
      provider: 'opencode',
      model: 'glm-5.3',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
    capabilitySnapshot: candidateSnapshot,
    phase: 'planner',
    client: { chat() {} },
  }).reason, 'provider_rollout_deferred');
  assert.equal(resolveMaidProviderFcEligibility({
    experimentStatus: { enabled: true },
    config: deepSeekConfig,
    capabilitySnapshot: { ...candidateSnapshot, useCandidates: false },
    phase: 'planner',
    client: { chat() {} },
  }).reason, 'candidate_snapshot_required');
  assert.equal(resolveMaidProviderFcEligibility({
    experimentStatus: { enabled: true },
    config: deepSeekConfig,
    capabilitySnapshot: candidateSnapshot,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
    phase: 'planner',
    client: { chat() {} },
  }).reason, 'multimodal_input');
  [
    { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com/v1' },
    { provider: 'makersuite', model: 'gemini-3.6-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  ].forEach((providerConfig) => {
    assert.equal(resolveMaidProviderFcEligibility({
      experimentStatus: { enabled: true },
      config: providerConfig,
      capabilitySnapshot: candidateSnapshot,
      messages: [{ role: 'user', content: '列出会话' }],
      phase: 'planner',
      client: { chat() {} },
    }).eligible, true, providerConfig.provider);
  });
  console.log('ok - maid provider FC eligibility supports verified official transports and remains candidate-only/text-only');
}

{
  const plan = buildMaidProviderFcToolPlan({
    config: deepSeekConfig,
    features: candidateSnapshot.candidateFeatures,
    phase: 'planner',
    thinkingEnabled: false,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.requestOptions.tool_choice, 'required');
  assert.equal(plan.requestOptions.openaiApi, 'responses');
  assert.equal(plan.requestOptions.parallel_tool_calls, false);
  assert.equal(plan.requestOptions.tools.length, 3);
  assert.equal(plan.toolMappings.filter(item => item.control !== true).length, 2);
  assert.equal(plan.toolMappings.some(item => item.providerName.includes('.')), false);
  assert.equal(plan.requestOptions.tools.every(item => item.function.name.length <= 64), true);
  assert.equal(plan.requestOptions.tools.some(item => item.function.name === MAID_PROVIDER_FC_CONTROL_TOOL_NAME), true);
  assert.equal(
    Object.hasOwn(plan.requestOptions.tools[0].function.parameters.properties || {}, 'response'),
    false,
  );

  const thinkingPlan = buildMaidProviderFcToolPlan({
    config: deepSeekConfig,
    features: candidateSnapshot.candidateFeatures,
    phase: 'react',
    thinkingEnabled: true,
  });
  assert.equal(thinkingPlan.requestOptions.tool_choice, 'required');
  assert.equal(thinkingPlan.requestOptions.openaiApi, 'responses');
  assert.deepEqual(thinkingPlan.generationOptions.reasoning, { effort: 'none' });
  assert.equal(thinkingPlan.diagnostics.thinkingRequested, true);
  assert.equal(thinkingPlan.diagnostics.thinkingEnabled, false);
  assert.equal(thinkingPlan.diagnostics.thinkingOverrideReason, 'deepseek_forced_tool_choice_incompatible');
  console.log('ok - maid provider FC exposes only candidate schemas plus one local control tool');
}

{
  const toolPlan = buildMaidProviderFcToolPlan({
    config: deepSeekConfig,
    features: candidateSnapshot.candidateFeatures,
    phase: 'planner',
  });
  const readMapping = toolPlan.toolMappings.find(item => item.internalName === 'session.list');
  const selected = normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [{
      toolName: readMapping.providerName,
      arguments: { query: '当前' },
      metadata: { streamingArgumentsText: '{"query":"当前"}' },
    }],
    toolPlan,
    phase: 'planner',
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.kind, 'tool');
  assert.equal(selected.selection.toolName, 'session.list');
  assert.equal(selected.selection.featureId, 'session.list');
  assert.deepEqual(selected.selection.args, { query: '当前' });

  // 较长的最终答复（例如列出几十个名称）也是合法的，不能因为长度被判为参数错误而重新生成
  const longFinal = normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [{ toolName: MAID_PROVIDER_FC_CONTROL_TOOL_NAME, arguments: { action: 'final', message: '规则集名称。'.repeat(340) } }],
    toolPlan,
    phase: 'react',
  });
  assert.equal(longFinal.ok, true, longFinal.reason);
  assert.equal(longFinal.kind, 'control');
  assert.equal(longFinal.control.message, '规则集名称。'.repeat(340), 'accepted long answers must retain every entry');
  assert.equal(normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [],
    toolPlan,
  }).reason, 'no_tool_call');
  assert.equal(normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [
      { toolName: readMapping.providerName, arguments: { query: 'a' } },
      { toolName: readMapping.providerName, arguments: { query: 'b' } },
    ],
    toolPlan,
  }).reason, 'multiple_tool_calls');
  assert.equal(normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [{ toolName: 'outside_candidate', arguments: {} }],
    toolPlan,
  }).reason, 'unknown_tool');
  assert.equal(normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [{ toolName: readMapping.providerName, arguments: {} }],
    toolPlan,
  }).reason, 'invalid_tool_arguments');
  assert.equal(normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [{
      toolName: readMapping.providerName,
      arguments: {},
      metadata: { streamingArgumentsText: '{bad json' },
    }],
    toolPlan,
  }).reason, 'invalid_arguments_json');

  const control = normalizeMaidProviderFcCompletedCalls({
    completedToolCalls: [{
      toolName: MAID_PROVIDER_FC_CONTROL_TOOL_NAME,
      arguments: { action: 'clarify', message: '请告诉我要查看哪个会话。' },
    }],
    toolPlan,
    phase: 'planner',
  });
  assert.equal(control.ok, true);
  assert.equal(control.kind, 'control');
  assert.equal(control.control.action, 'clarify');
  console.log('ok - maid provider FC rejects zero/multiple/outside/invalid calls and accepts local control');
}

{
  const anthropicPlan = buildMaidProviderFcToolPlan({
    config: { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com/v1' },
    features: [readFeature],
    phase: 'planner',
  });
  assert.equal(anthropicPlan.ok, true);
  assert.equal(anthropicPlan.requestOptions.tools[0].name.length > 0, true);
  assert.equal(anthropicPlan.requestOptions.tool_choice.type, 'any');
  assert.equal(anthropicPlan.requestOptions.tool_choice.disable_parallel_tool_use, true);

  const geminiPlan = buildMaidProviderFcToolPlan({
    config: { provider: 'makersuite', model: 'gemini-3.6-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
    features: [readFeature],
    phase: 'planner',
  });
  assert.equal(geminiPlan.ok, true);
  assert.equal(geminiPlan.requestOptions.tools[0].functionDeclarations.length, 2);
  assert.equal(geminiPlan.requestOptions.toolConfig.functionCallingConfig.mode, 'ANY');
  console.log('ok - maid tool candidates compile to Anthropic and Gemini native request schemas');
}

{
  let capturedOptions = null;
  const attempt = await runMaidProviderFcAttempt({
    client: {
      async chat(_messages, options) {
        capturedOptions = options;
        const businessTool = options.tools.find(item => item.function.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
        options.onProviderToolCallDelta({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-stage-e',
                type: 'function',
                function: {
                  name: businessTool.function.name,
                  arguments: '{"query":"最近"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
        return '';
      },
    },
    messages: [{ role: 'user', content: '列出最近会话' }],
    config: deepSeekConfig,
    capabilitySnapshot: {
      ...candidateSnapshot,
      candidateFeatures: [readFeature],
      promptFeatures: [readFeature],
    },
    experimentStatus: { enabled: true, thinkingEnabled: false },
    phase: 'planner',
  });
  assert.equal(attempt.ok, true);
  assert.equal(attempt.kind, 'tool');
  assert.equal(attempt.selection.toolName, 'session.list');
  assert.equal(capturedOptions.tool_choice, 'required');
  assert.equal(capturedOptions.openaiApi, 'responses');
  assert.deepEqual(capturedOptions.reasoning, { effort: 'none' });
  assert.equal(Object.hasOwn(capturedOptions, 'thinking'), false);
  console.log('ok - maid provider FC captures one complete non-streaming OpenAI-compatible tool call');
}

{
  const fixtures = [
    {
      label: 'OpenAI',
      config: { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
      emit(options) {
        const toolName = options.tools.find(item => item.function.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME).function.name;
        assert.equal(options.reasoning_effort, 'none');
        options.onProviderToolCallDelta({
          choices: [{
            message: { tool_calls: [{ id: 'call_openai', type: 'function', function: { name: toolName, arguments: '{"query":"最近"}' } }] },
            finish_reason: 'tool_calls',
          }],
        }, { provider: 'openai', model: 'gpt-5.6-sol' });
      },
    },
    {
      label: 'Anthropic',
      config: { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com/v1' },
      emit(options) {
        const toolName = options.tools.find(item => item.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME).name;
        assert.equal(options.tool_choice.type, 'any');
        options.onProviderToolCallDelta({
          content: [{ type: 'tool_use', id: 'toolu_anthropic', name: toolName, input: { query: '最近' } }],
          stop_reason: 'tool_use',
        }, { provider: 'anthropic', model: 'claude-opus-4-8' });
      },
    },
    {
      label: 'Gemini',
      config: { provider: 'makersuite', model: 'gemini-3.6-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
      emit(options) {
        const declarations = options.tools[0].functionDeclarations;
        const toolName = declarations.find(item => item.name !== MAID_PROVIDER_FC_CONTROL_TOOL_NAME).name;
        assert.equal(options.toolConfig.functionCallingConfig.mode, 'ANY');
        options.onProviderToolCallDelta({
          candidates: [{ content: { parts: [{ functionCall: { id: 'call_gemini', name: toolName, args: { query: '最近' } } }] } }],
        }, { provider: 'makersuite', model: 'gemini-3.6-flash' });
      },
    },
  ];

  for (const fixture of fixtures) {
    const attempt = await runMaidProviderFcAttempt({
      client: {
        async chat(_messages, options) {
          fixture.emit(options);
          return '';
        },
      },
      messages: [{ role: 'user', content: '列出最近会话' }],
      config: fixture.config,
      capabilitySnapshot: {
        ...candidateSnapshot,
        candidateFeatures: [readFeature],
        promptFeatures: [readFeature],
      },
      experimentStatus: { enabled: true, thinkingEnabled: false },
      phase: 'planner',
    });
    assert.equal(attempt.ok, true, `${fixture.label}: ${attempt.reason}`);
    assert.equal(attempt.selection.toolName, 'session.list');
  }
  console.log('ok - maid provider FC consumes terminal calls from official OpenAI, Anthropic, and Gemini transports');
}

{
  // 女仆思考设置在函数调用路径只做底：传输层对该服务商有思考兼容规则时以规则为准（DeepSeek 函数调用必须关思考）
  resetMaidProviderFcCooldowns();
  const seen = {};
  const run = (label, config) => runMaidProviderFcAttempt({
    client: { async chat(_messages, options) { seen[label] = options; return ''; } },
    messages: [{ role: 'user', content: '列出最近会话' }],
    config,
    capabilitySnapshot: { ...candidateSnapshot, candidateFeatures: [readFeature], promptFeatures: [readFeature] },
    experimentStatus: { enabled: true, thinkingEnabled: false },
    phase: 'planner',
    generationSettings: { reasoningMode: 'on', reasoningEffort: 'low' },
  });
  await run('gemini', { provider: 'makersuite', model: 'gemini-3.6-flash', baseUrl: 'https://generativelanguage.googleapis.com' });
  assert.equal(seen.gemini.thinkingLevel, 'low', 'no transport rule, so the maid setting applies');
  await run('deepseek', deepSeekConfig);
  assert.deepEqual(seen.deepseek.reasoning, { effort: 'none' }, 'the transport rule wins');
  assert.equal(seen.deepseek.thinking, undefined);
  assert.equal(seen.deepseek.reasoning_effort, undefined);
  const manual = await run('anthropicManual', { provider: 'anthropic', model: 'claude-sonnet-4-5' });
  assert.equal(manual.attempted, false, 'manual thinking and forced tools must be rejected before calling the provider');
  assert.equal(manual.reason, 'anthropic_manual_thinking_forced_tool_unsupported');
  assert.equal(seen.anthropicManual, undefined);
  await run('anthropicAdaptive', { provider: 'anthropic', model: 'claude-opus-4-7' });
  assert.equal(seen.anthropicAdaptive.thinking.type, 'adaptive', 'compatible adaptive thinking still uses FC');
  assert.equal(seen.anthropicAdaptive.temperature, undefined);
  assert.equal(seen.anthropicAdaptive.tool_choice.type, 'any');
  resetMaidProviderFcCooldowns();
  console.log('ok - maid reasoning settings only fill in where provider FC has no reasoning rule of its own');
}

{
  // 请求失败后同一模型冷却：不再先试函数调用再回退，冷却结束或换模型后恢复
  resetMaidProviderFcCooldowns();
  let clock = 1_000_000;
  const now = () => clock;
  const base = {
    messages: [{ role: 'user', content: '列出会话' }],
    config: deepSeekConfig,
    capabilitySnapshot: { ...candidateSnapshot, candidateFeatures: [readFeature], promptFeatures: [readFeature] },
    experimentStatus: { enabled: true, thinkingEnabled: false },
    phase: 'planner',
    now,
  };
  const usages = [];
  const failed = await runMaidProviderFcAttempt({ ...base, client: { async chat() { throw new Error('Vertex AI Error: 400 - Request contains an invalid argument.'); } }, onModelUsage: usage => usages.push(usage) });
  assert.equal(failed.reason, 'provider_request_failed');
  assert.equal(usages[0].outcome, 'provider_request_failed');
  assert.match(usages[0].error, /400/);
  let calls = 0;
  const skipped = await runMaidProviderFcAttempt({ ...base, client: { async chat() { calls += 1; return ''; } } });
  assert.equal(skipped.attempted, false);
  assert.equal(skipped.reason, 'provider_fc_cooling_down');
  assert.equal(calls, 0, 'cooling down skips the provider request entirely');
  assert.equal(resolveMaidProviderFcEligibility({ ...base, config: { ...deepSeekConfig, model: 'other-model' }, client: { chat() {} } }).eligible, true, 'other models are unaffected');
  clock += MAID_PROVIDER_FC_FAILURE_COOLDOWN_MS + 1;
  assert.equal(resolveMaidProviderFcEligibility({ ...base, client: { chat() {} } }).eligible, true, 'the cooldown expires');
  resetMaidProviderFcCooldowns();
  // 配额、鉴权、空响应等临时故障不冷却，函数调用下一次仍会尝试
  for (const message of ['Vertex AI Error: 429 - Resource exhausted.', 'Failed to authenticate with Service Account: undefined', 'Empty response from Vertex AI']) {
    assert.equal(isProviderFcRequestRejection(new Error(message)), false, message);
    await runMaidProviderFcAttempt({ ...base, client: { async chat() { throw new Error(message); } } });
    assert.equal(resolveMaidProviderFcEligibility({ ...base, client: { chat() {} } }).eligible, true, `${message} does not cool down`);
  }
  assert.equal(isProviderFcRequestRejection(Object.assign(new Error('bad'), { status: 422 })), true);
  assert.equal(isProviderFcRequestRejection(new Error('Vertex AI Error: 400 - Invalid JSON payload received. Unknown name "type"')), true);
  resetMaidProviderFcCooldowns();
  console.log('ok - a failed provider FC request cools down that model instead of paying twice on every call');
}

{
  const abortError = new Error('Aborted');
  abortError.name = 'AbortError';
  await assert.rejects(() => runMaidProviderFcAttempt({
    client: { chat: async () => { throw abortError; } },
    messages: [{ role: 'user', content: '列出会话' }],
    config: deepSeekConfig,
    capabilitySnapshot: candidateSnapshot,
    experimentStatus: { enabled: true },
    phase: 'planner',
  }), error => error?.name === 'AbortError');
  console.log('ok - maid provider FC propagates cancellation instead of falling back');
}
