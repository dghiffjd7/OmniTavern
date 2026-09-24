import assert from 'node:assert/strict';
import {
  PROVIDER_FC_FAMILIES,
  PROVIDER_FC_TOOL_CHOICE_MODES,
  buildProviderFcRequestOptionsForLocalDiagnostics,
  buildProviderFcRequestPlan,
  resolveChatProviderFcRelease,
  resolveProviderFcTransport,
  sanitizeProviderFcInheritedRequestOptions,
} from '../../src/scripts/agent/provider-fc-transport.js';
import { DeepseekProvider } from '../../src/scripts/api/providers/deepseek.js';
import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';
import { OpenCodeProvider } from '../../src/scripts/api/providers/opencode.js';
import { buildPrivateReplyProviderToolDefinition } from '../../src/scripts/ui/chat/phone-reply-ir.js';
import { buildPhoneReplyBatchProviderToolDefinition } from '../../src/scripts/ui/chat/phone-reply-batch-ir.js';
import {
  clearOpenRouterModelCapabilitiesForTests,
  recordOpenRouterModelCapabilities,
} from '../../src/scripts/api/openrouter-model-capabilities.js';

const tool = {
  type: 'function',
  function: {
    name: 'emit_reply',
    description: 'Emit one reply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
    },
  },
};

{
  const fixtures = [
    [
      { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
      plan => assert.equal(plan.requestOptions.tool_choice, 'auto'),
    ],
    [
      { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com/v1' },
      plan => assert.deepEqual(plan.requestOptions.tool_choice, {
        type: 'auto',
        disable_parallel_tool_use: true,
      }),
    ],
  ];
  fixtures.forEach(([config, verify]) => {
    const plan = buildProviderFcRequestPlan({
      config,
      tools: [tool],
      toolChoiceMode: PROVIDER_FC_TOOL_CHOICE_MODES.auto,
      intermediateToolsEnabled: true,
    });
    assert.equal(plan.ok, true, `${config.provider}: ${plan.reason}`);
    assert.equal(plan.diagnostics.toolChoiceMode, PROVIDER_FC_TOOL_CHOICE_MODES.auto);
    verify(plan);
  });
  for (const config of [
    { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' },
    { provider: 'opencode', model: 'glm-5.3', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { provider: 'makersuite', model: 'gemini-3.7-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  ]) {
    assert.equal(buildProviderFcRequestPlan({
      config,
      tools: [tool],
      toolChoiceMode: PROVIDER_FC_TOOL_CHOICE_MODES.auto,
      intermediateToolsEnabled: true,
    }).reason, 'provider_model_tool_continuation_not_verified');
  }
  assert.equal(buildProviderFcRequestPlan({
    config: { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
    tools: [tool],
    toolChoiceMode: PROVIDER_FC_TOOL_CHOICE_MODES.auto,
  }).reason, 'provider_fc_intermediate_tools_not_enabled');
  assert.equal(buildProviderFcRequestPlan({
    config: { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
    tools: [tool],
    toolChoiceMode: 'anything-goes',
  }).reason, 'provider_fc_tool_choice_mode_unsupported');
  console.log('ok - provider-native auto is gated by exact tool-result continuation evidence');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
    },
    tools: [tool],
    thinkingEnabled: true,
    reasoningOptions: { reasoning: { effort: 'high' } },
  });
  assert.equal(plan.ok, true, plan.reason);
  const localOptions = buildProviderFcRequestOptionsForLocalDiagnostics(plan);
  assert.equal(Object.hasOwn(localOptions, 'tools'), false);
  assert.equal(localOptions.tool_choice.name, 'emit_reply');
  assert.equal(localOptions.parallel_tool_calls, false);
  assert.equal(localOptions.reasoning.effort, 'none');
  console.log('ok - local Prompt diagnostics reuse actual FC request policy without duplicating tool schema');
}

{
  const fixtures = [
    [{ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }, PROVIDER_FC_FAMILIES.openai],
    [{ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, PROVIDER_FC_FAMILIES.openai],
    [{ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, PROVIDER_FC_FAMILIES.anthropic],
    [{ provider: 'makersuite', baseUrl: 'https://generativelanguage.googleapis.com' }, PROVIDER_FC_FAMILIES.gemini],
    [{ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }, PROVIDER_FC_FAMILIES.gemini],
    [{ provider: 'vertexai', baseUrl: 'https://us-central1-aiplatform.googleapis.com' }, PROVIDER_FC_FAMILIES.gemini],
    [{ provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1' }, PROVIDER_FC_FAMILIES.openai],
    [{ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }, PROVIDER_FC_FAMILIES.openai],
    [{ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, PROVIDER_FC_FAMILIES.openai],
  ];
  fixtures.forEach(([config, family]) => {
    const result = resolveProviderFcTransport(config);
    assert.equal(result.supported, true);
    assert.equal(result.family, family);
  });
  assert.equal(resolveProviderFcTransport({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
  }).endpoint, 'official_deepseek_responses');
  assert.equal(resolveProviderFcTransport({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  }).endpoint, 'official_openai_responses');
  assert.equal(resolveProviderFcTransport({
    provider: 'opencode',
    baseUrl: 'https://opencode.ai/zen/go/v1/',
  }).endpoint, 'official_opencode_go_chat_completions');
  assert.equal(resolveProviderFcTransport({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1/',
  }).endpoint, 'official_openrouter_chat_completions');
  console.log('ok - official FC transports are classified by provider and endpoint');
}

{
  clearOpenRouterModelCapabilitiesForTests();
  const baseConfig = {
    provider: 'openrouter',
    model: 'vendor/tool-model:free',
    baseUrl: 'https://openrouter.ai/api/v1',
  };
  assert.equal(buildProviderFcRequestPlan({ config: baseConfig, tools: [tool] }).reason, 'openrouter_model_capabilities_unknown');
  recordOpenRouterModelCapabilities({
    baseUrl: baseConfig.baseUrl,
    model: { id: baseConfig.model, supported_parameters: ['tools'] },
  });
  assert.equal(buildProviderFcRequestPlan({ config: baseConfig, tools: [tool] }).reason, 'openrouter_model_tools_unsupported');
  clearOpenRouterModelCapabilitiesForTests();
  recordOpenRouterModelCapabilities({
    baseUrl: baseConfig.baseUrl,
    model: { id: baseConfig.model, supported_parameters: ['tools', 'tool_choice'] },
  });
  const plan = buildProviderFcRequestPlan({
    config: baseConfig,
    tools: [tool],
    reasoningOptions: { provider: { data_collection: 'deny', require_parameters: false } },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.requestOptions.tool_choice, 'required');
  assert.equal(Object.hasOwn(plan.requestOptions, 'parallel_tool_calls'), false);
  assert.deepEqual(plan.requestOptions.provider, {
    data_collection: 'deny',
    require_parameters: true,
  });
  assert.equal(buildProviderFcRequestPlan({
    config: { ...baseConfig, model: 'openrouter/auto' },
    tools: [tool],
  }).reason, 'openrouter_auto_model_unsupported');
  assert.equal(resolveProviderFcTransport({
    ...baseConfig,
    connectionMode: 'reverse_proxy',
    proxyBaseUrl: 'https://proxy.example/v1',
  }).reason, 'unverified_provider_endpoint');

  const verifiedConfig = {
    provider: 'openrouter',
    model: 'google/gemini-3.7-flash',
    baseUrl: 'https://openrouter.ai/api/v1',
  };
  clearOpenRouterModelCapabilitiesForTests();
  const catalogOnlyRelease = resolveChatProviderFcRelease(verifiedConfig);
  assert.equal(catalogOnlyRelease.enabled, true);
  assert.equal(catalogOnlyRelease.capabilityLayer, 'bundled');
  assert.equal(buildProviderFcRequestPlan({ config: verifiedConfig, tools: [tool] }).ok, true);
  recordOpenRouterModelCapabilities({
    baseUrl: verifiedConfig.baseUrl,
    model: {
      id: verifiedConfig.model,
      canonical_slug: 'google/gemini-3.7-flash-20260813',
      supported_parameters: ['tools', 'tool_choice'],
    },
  });
  const verifiedRelease = resolveChatProviderFcRelease(verifiedConfig);
  assert.equal(verifiedRelease.enabled, true);
  assert.equal(verifiedRelease.capabilities.providerRoute, 'google-ai-studio/flex');
  const verifiedPlan = buildProviderFcRequestPlan({ config: verifiedConfig, tools: [tool] });
  assert.deepEqual(verifiedPlan.requestOptions.provider, {
    only: ['google-ai-studio/flex'],
    allow_fallbacks: false,
    require_parameters: true,
  });
  const privateTool = buildPrivateReplyProviderToolDefinition({
    allowedItemTypes: ['text', 'music', 'sticker'],
    allowedStickerKeywords: ['收到'],
  });
  const phonePlan = buildProviderFcRequestPlan({ config: verifiedConfig, tools: [privateTool] });
  const phoneParameters = phonePlan.requestOptions.tools[0].function.parameters;
  assert.equal(JSON.stringify(phoneParameters).includes('"oneOf"'), false);
  assert.equal(JSON.stringify(phoneParameters).includes('"anyOf"'), false);
  assert.equal(phoneParameters.type, 'object');
  assert.equal(phoneParameters.properties.messages.items.type, 'object');
  assert.equal(Object.hasOwn(phoneParameters.properties.messages, 'minItems'), false);
  assert.equal(Object.hasOwn(phoneParameters.properties.messages, 'maxItems'), false);
  assert.equal(Object.hasOwn(phoneParameters, 'additionalProperties'), false);
  assert.equal(JSON.stringify(privateTool.function.parameters).includes('"oneOf"'), true);
  assert.deepEqual(sanitizeProviderFcInheritedRequestOptions({
    provider: 'openrouter',
    options: {
      temperature: 0.7,
      top_p: 0.9,
      seed: 7,
      frequency_penalty: 0,
      presence_penalty: 0,
      n: 1,
      tools: [tool],
      tool_choice: 'auto',
    },
  }), {
    temperature: 0.7,
    top_p: 0.9,
    seed: 7,
  });
  console.log('ok - OpenRouter FC requires exact model metadata, route pinning, and upstream-safe schema');
}

{
  for (const config of [
    { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' },
    { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com/v1' },
    { provider: 'opencode', model: 'glm-5.3', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { provider: 'opencode', model: 'glm-5.2', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { provider: 'opencode', model: 'glm-5', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { provider: 'opencode', model: 'mimo-v2.5-pro', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { provider: 'makersuite', model: 'gemini-3.7-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  ]) {
    const release = resolveChatProviderFcRelease(config);
    assert.equal(release.enabled, true);
    assert.equal(release.reason, '');
    assert.equal(release.provider, config.provider);
    assert.equal(release.model, config.model);
    assert.equal(release.capabilitySource, 'verified_seed');
    assert.equal(release.capabilityLayer, 'bundled');
    assert.equal(release.capabilityRevision, 5);
    assert.ok(release.capabilityRuleId.startsWith('bundled.'));
    assert.equal(release.capabilities.basicToolCall, true);
    assert.equal(release.capabilities.uniqueTerminalTool, true);
    assert.equal(release.capabilities.streamingArguments, true);
  }
  const unverifiedGemini = resolveChatProviderFcRelease({
    provider: 'makersuite',
    model: 'gemini-3.6-pro',
    baseUrl: 'https://generativelanguage.googleapis.com',
  });
  assert.equal(unverifiedGemini.enabled, false);
  assert.equal(unverifiedGemini.reason, 'provider_model_not_verified');
  assert.equal(unverifiedGemini.provider, 'makersuite');
  assert.equal(unverifiedGemini.model, 'gemini-3.6-pro');
  assert.deepEqual(unverifiedGemini.capabilities, {});

  for (const config of [
    { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    { provider: 'openai', model: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'anthropic', model: 'claude-sonnet-4-4', baseUrl: 'https://api.anthropic.com/v1' },
    { provider: 'opencode', model: 'glm-5.1', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { provider: 'openai', model: '', baseUrl: 'https://api.openai.com/v1' },
  ]) {
    const release = resolveChatProviderFcRelease(config);
    assert.equal(release.enabled, false);
    assert.equal(release.reason, 'provider_model_not_verified');
    assert.equal(release.provider, config.provider);
    assert.equal(release.model, String(config.model || ''));
    assert.deepEqual(release.capabilities, {});
  }
  assert.equal(resolveChatProviderFcRelease({
    provider: 'openai',
    model: 'gpt-5.6-sol',
    baseUrl: 'https://proxy.example/v1',
  }).reason, 'unverified_provider_endpoint');
  assert.equal(resolveChatProviderFcRelease({
    provider: 'makersuite',
    model: 'gemini-3.7-flash',
    baseUrl: 'https://generativelanguage.googleapis.com',
    connectionMode: 'reverse_proxy',
    proxyBaseUrl: 'https://proxy.example/v1',
  }).reason, 'unverified_provider_endpoint');
  console.log('ok - chat FC release is limited to verified provider/model seeds on official endpoints');
}

{
  const custom = resolveProviderFcTransport({
    provider: 'custom',
    model: 'gemini-3.1-pro-preview',
    baseUrl: 'https://gcli.example/v1',
  });
  const proxiedOpenAI = resolveProviderFcTransport({
    provider: 'openai',
    baseUrl: 'https://proxy.example/v1',
  });
  const malformedOpenAI = resolveProviderFcTransport({
    provider: 'openai',
    baseUrl: 'not-a-valid-url',
  });
  const wrongOpenCodePlan = resolveProviderFcTransport({
    provider: 'opencode',
    baseUrl: 'https://opencode.ai/zen/v1',
  });
  const proxiedOpenCode = resolveProviderFcTransport({
    provider: 'opencode',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    connectionMode: 'reverse_proxy',
    proxyBaseUrl: 'https://proxy.example/v1',
  });
  assert.equal(custom.supported, false);
  assert.equal(custom.reason, 'unverified_custom_endpoint');
  assert.equal(proxiedOpenAI.supported, false);
  assert.equal(proxiedOpenAI.reason, 'unverified_provider_endpoint');
  assert.equal(malformedOpenAI.supported, false);
  assert.equal(malformedOpenAI.reason, 'unverified_provider_endpoint');
  assert.equal(wrongOpenCodePlan.supported, false);
  assert.equal(wrongOpenCodePlan.reason, 'unverified_provider_endpoint');
  assert.equal(proxiedOpenCode.supported, false);
  assert.equal(proxiedOpenCode.reason, 'unverified_provider_endpoint');
  console.log('ok - unverified custom, proxied, and malformed endpoints remain fail-closed');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'opencode',
      model: 'glm-5.3',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
    tools: [tool],
    temperature: 0,
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.transport.endpoint, 'official_opencode_go_chat_completions');
  assert.deepEqual(plan.requestOptions.tool_choice, {
    type: 'function',
    function: { name: 'emit_reply' },
  });
  assert.equal(plan.requestOptions.parallel_tool_calls, false);
  assert.equal(Object.hasOwn(plan.requestOptions, 'openaiApi'), false);
  assert.equal(plan.generationOptions.temperature, 0);

  const secondVerifiedModel = buildProviderFcRequestPlan({
    config: {
      provider: 'opencode',
      model: 'glm-5.2',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
    tools: [tool],
  });
  assert.equal(secondVerifiedModel.ok, true, secondVerifiedModel.reason);

  const wrongModel = buildProviderFcRequestPlan({
    config: {
      provider: 'opencode',
      model: 'glm-5.1',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
    tools: [tool],
  });
  assert.equal(wrongModel.ok, false);
  assert.equal(wrongModel.reason, 'opencode_go_model_unsupported');
  console.log('ok - OpenCode FC is pinned to exact verified Go Chat Completions models');
}

{
  let captured = null;
  let toolDelta = null;
  let usage = null;
  const provider = new OpenCodeProvider({
    apiKey: 'test-key',
    model: 'glm-5.3',
  });
  provider.requestJson = async request => {
    captured = request;
    return {
      id: 'chatcmpl-opencode-test',
      model: 'glm-5.3',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-opencode-test',
            type: 'function',
            function: { name: 'emit_reply', arguments: '{"content":"ok"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
  };
  const text = await provider.chat([
    { role: 'system', content: 'Use the tool.' },
    { role: 'user', content: 'Reply.' },
  ], {
    tools: [tool],
    tool_choice: { type: 'function', function: { name: 'emit_reply' } },
    parallel_tool_calls: false,
    max_tokens: 64,
    onProviderToolCallDelta: data => { toolDelta = data; },
    onProviderUsage: value => { usage = value; },
  });
  const body = JSON.parse(captured.body);
  assert.equal(captured.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(text, '');
  assert.equal(body.stream, false);
  assert.equal(body.tools[0].function.name, 'emit_reply');
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'emit_reply' } });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_tokens, 64);
  assert.equal(toolDelta.choices[0].message.tool_calls[0].function.name, 'emit_reply');
  assert.equal(usage.provider, 'opencode');
  assert.equal(usage.responseId, 'chatcmpl-opencode-test');
  assert.equal(usage.finishReason, 'tool_calls');
  console.log('ok - OpenCode provider preserves Chat Completions tool calls and usage identities');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      baseUrl: 'https://api.openai.com/v1',
    },
    tools: [tool],
    temperature: 0,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.requestOptions.tool_choice, 'required');
  assert.equal(plan.requestOptions.openaiApi, 'responses');
  assert.equal(plan.requestOptions.parallel_tool_calls, false);
  assert.equal(plan.requestOptions.tools[0].function.name, 'emit_reply');
  assert.equal(plan.generationOptions.reasoning_effort, 'none');
  assert.equal(Object.hasOwn(plan.generationOptions, 'thinking'), false);
  console.log('ok - official OpenAI FC selects Responses and disables incompatible sol reasoning effort');
}

{
  let captured = null;
  let toolDelta = null;
  let usage = null;
  const provider = new OpenAIProvider({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  });
  provider.requestJson = async request => {
    captured = request;
    return {
      id: 'resp-test',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc-test',
        call_id: 'call-test',
        name: 'emit_reply',
        arguments: '{"content":"ok"}',
      }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
  };
  const text = await provider.chat([
    { role: 'system', content: 'Use the tool.' },
    { role: 'user', content: 'Reply.' },
  ], {
    openaiApi: 'responses',
    tools: [tool],
    tool_choice: 'required',
    parallel_tool_calls: false,
    max_tokens: 64,
    reasoning_effort: 'none',
    onProviderToolCallDelta: data => { toolDelta = data; },
    onProviderUsage: value => { usage = value; },
  });
  const body = JSON.parse(captured.body);
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(text, '');
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.input[0].role, 'system');
  assert.equal(body.input[1].role, 'user');
  assert.equal(body.tools[0].name, 'emit_reply');
  assert.equal(body.tools[0].function, undefined);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_output_tokens, 64);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(toolDelta.id, 'resp-test');
  assert.equal(usage.promptTokens, 5);
  assert.equal(usage.completionTokens, 3);
  console.log('ok - OpenAI provider sends a stateless Responses FC request and reports its tool output');
}

{
  const provider = new OpenAIProvider({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://proxy.example/v1',
    model: 'gpt-5.6-sol',
  });
  await assert.rejects(
    () => provider.chat([{ role: 'user', content: 'Reply.' }], { openaiApi: 'responses' }),
    /official api\.openai\.com or api\.deepseek\.com endpoint/u,
  );
  console.log('ok - OpenAI Responses stays fail-closed on unverified proxy endpoints');
}

{
  let preparedStream = null;
  const providerEvents = [];
  let usage = null;
  const provider = new OpenAIProvider({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  });
  provider.requestJson = async () => {
    throw new Error('Responses streaming must not fall back to buffered requestJson');
  };
  provider.streamResponsesEvents = async function* (prepared) {
    preparedStream = prepared;
    yield {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc-stream',
        call_id: 'call-stream',
        name: 'emit_reply',
        arguments: '',
      },
    };
    yield {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc-stream',
      output_index: 0,
      delta: '{"content":"ok"}',
    };
    yield {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc-stream',
        call_id: 'call-stream',
        name: 'emit_reply',
        arguments: '{"content":"ok"}',
      },
    };
    yield { type: 'response.output_text.delta', delta: 'OK' };
    yield {
      type: 'response.completed',
      response: {
        id: 'resp-stream',
        status: 'completed',
        output: [],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      },
    };
  };
  const chunks = [];
  for await (const chunk of provider.streamChat([
    { role: 'system', content: 'Use the tool.' },
    { role: 'user', content: 'Reply.' },
  ], {
    openaiApi: 'responses',
    tools: [tool],
    tool_choice: 'required',
    parallel_tool_calls: false,
    max_tokens: 64,
    reasoning_effort: 'none',
    onProviderToolCallDelta: event => providerEvents.push(event.type),
    onProviderUsage: value => { usage = value; },
  })) {
    chunks.push(chunk);
  }
  assert.equal(preparedStream.body.stream, true);
  assert.equal(preparedStream.body.store, false);
  assert.equal(preparedStream.body.tools[0].name, 'emit_reply');
  assert.deepEqual(chunks, ['OK']);
  assert.deepEqual(providerEvents, [
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.output_item.done',
    'response.output_text.delta',
    'response.completed',
  ]);
  assert.equal(usage.promptTokens, 7);
  assert.equal(usage.completionTokens, 2);
  console.log('ok - OpenAI Responses streams official tool events, text deltas, and usage without buffering');
}

{
  const previousTauri = globalThis.__TAURI__;
  const events = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc-native',
        call_id: 'call-native',
        name: 'emit_reply',
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc-native',
      output_index: 0,
      delta: '{"content":"native"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc-native',
        call_id: 'call-native',
        name: 'emit_reply',
        arguments: '{"content":"native"}',
      },
    },
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [],
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      },
    },
  ];
  const sse = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const splitAt = [17, 83, 161, sse.length - 9];
  const chunks = [];
  let offset = 0;
  splitAt.forEach((end) => {
    chunks.push(sse.slice(offset, end));
    offset = end;
  });
  chunks.push(sse.slice(offset));
  const starts = [];
  let readIndex = 0;
  let closeCount = 0;
  globalThis.__TAURI__ = {
    core: {
      invoke: async (command, payload) => {
        if (command === 'http_stream_request_start') {
          starts.push(payload);
          return null;
        }
        if (command === 'http_stream_request_read') {
          const chunk = chunks[readIndex++] || '';
          return {
            status: 200,
            ok: true,
            chunks: chunk ? [chunk] : [],
            done: readIndex >= chunks.length,
          };
        }
        if (command === 'http_stream_request_close') {
          closeCount += 1;
          return null;
        }
        throw new Error(`unexpected invoke command: ${command}`);
      },
    },
  };
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-sol',
    });
    const receivedTypes = [];
    let usage = null;
    for await (const _chunk of provider.streamChat([{ role: 'user', content: 'Reply.' }], {
      openaiApi: 'responses',
      nativeRequestId: 'unsafe:request:id',
      tools: [tool],
      onProviderToolCallDelta: event => receivedTypes.push(event.type),
      onProviderUsage: value => { usage = value; },
    })) {}
    assert.deepEqual(receivedTypes, events.map(event => event.type));
    assert.equal(starts.length, 1);
    assert.equal(starts[0].requestId, 'unsafe_request_id');
    assert.equal(JSON.parse(starts[0].body).stream, true);
    assert.equal(closeCount, 1);
    assert.equal(usage.totalTokens, 5);
  } finally {
    if (previousTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = previousTauri;
  }
  console.log('ok - OpenAI Responses native SSE survives arbitrary chunk boundaries and sanitizes request ids');
}

{
  const controller = new AbortController();
  controller.abort();
  let transportCalls = 0;
  const provider = new OpenAIProvider({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  });
  provider.streamResponsesEvents = async function* () {
    transportCalls += 1;
  };
  await assert.rejects(async () => {
    for await (const _chunk of provider.streamChat([{ role: 'user', content: 'Reply.' }], {
      openaiApi: 'responses',
      signal: controller.signal,
    })) {}
  }, error => error?.name === 'AbortError');
  assert.equal(transportCalls, 0);
  console.log('ok - OpenAI Responses pre-abort exits before opening the native stream');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
    },
    tools: [tool],
    thinkingEnabled: false,
    temperature: 0,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.generationOptions.reasoning, { effort: 'none' });
  assert.equal(plan.generationOptions.temperature, 0);
  assert.deepEqual(plan.requestOptions.tool_choice, {
    type: 'function',
    name: 'emit_reply',
  });
  assert.equal(plan.requestOptions.openaiApi, 'responses');
  assert.equal(plan.requestOptions.parallel_tool_calls, false);
  assert.equal(Object.hasOwn(plan.generationOptions, 'thinking'), false);
  console.log('ok - DeepSeek FC uses Responses with one named terminal tool when thinking is off');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
    },
    tools: [tool],
    thinkingEnabled: true,
    reasoningOptions: { reasoning_effort: 'max' },
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.generationOptions.reasoning, { effort: 'none' });
  assert.deepEqual(plan.requestOptions.tool_choice, {
    type: 'function',
    name: 'emit_reply',
  });
  assert.equal(plan.requestOptions.openaiApi, 'responses');
  assert.equal(Object.hasOwn(plan.generationOptions, 'thinking'), false);
  assert.equal(plan.diagnostics.thinkingRequested, true);
  assert.equal(plan.diagnostics.thinkingEnabled, false);
  assert.equal(plan.diagnostics.thinkingOverrideReason, 'deepseek_forced_tool_choice_incompatible');
  console.log('ok - DeepSeek forced FC disables incompatible thinking with an explicit diagnostic');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    },
    tools: [tool],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'deepseek_responses_model_unsupported');
  console.log('ok - DeepSeek Responses fails closed before request for unsupported model ids');
}

{
  let captured = null;
  let toolDelta = null;
  const provider = new DeepseekProvider({
    provider: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  });
  provider.requestJson = async request => {
    captured = request;
    return {
      id: 'ds-response-test',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc-ds-test',
        call_id: 'call-ds-test',
        name: 'emit_reply',
        arguments: '{"content":"ok"}',
      }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
  };
  const text = await provider.chat([{ role: 'user', content: 'Reply.' }], {
    openaiApi: 'responses',
    tools: [tool],
    tool_choice: { type: 'function', name: 'emit_reply' },
    parallel_tool_calls: false,
    reasoning: { effort: 'none' },
    onProviderToolCallDelta: data => { toolDelta = data; },
  });
  const body = JSON.parse(captured.body);
  assert.equal(captured.url, 'https://api.deepseek.com/responses');
  assert.equal(text, '');
  assert.equal(body.store, false);
  assert.equal(body.tools[0].name, 'emit_reply');
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'emit_reply' });
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(toolDelta.id, 'ds-response-test');
  console.log('ok - official DeepSeek provider sends a stateless Responses FC request');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: 'https://api.anthropic.com/v1',
    },
    tools: [tool],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.requestOptions.tools[0].name, 'emit_reply');
  assert.deepEqual(plan.requestOptions.tools[0].input_schema, tool.function.parameters);
  assert.deepEqual(plan.requestOptions.tool_choice, {
    type: 'tool',
    name: 'emit_reply',
    disable_parallel_tool_use: true,
  });
  assert.equal(Object.hasOwn(plan.generationOptions, 'temperature'), false);
  assert.equal(Object.hasOwn(plan.requestOptions.tools[0], 'function'), false);
  console.log('ok - Anthropic FC uses input_schema and a single forced client tool');
}

{
  const manualThinking = buildProviderFcRequestPlan({
    config: {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: 'https://api.anthropic.com/v1',
    },
    tools: [tool],
    thinkingEnabled: true,
    reasoningOptions: { thinking: { type: 'enabled', budget_tokens: 2048 } },
  });
  assert.equal(manualThinking.ok, false);
  assert.equal(manualThinking.reason, 'anthropic_manual_thinking_forced_tool_unsupported');

  const adaptiveThinking = buildProviderFcRequestPlan({
    config: {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: 'https://api.anthropic.com/v1',
    },
    tools: [tool],
    thinkingEnabled: true,
    reasoningOptions: {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    },
  });
  assert.equal(adaptiveThinking.ok, true);
  assert.deepEqual(adaptiveThinking.generationOptions.thinking, {
    type: 'adaptive',
    display: 'summarized',
  });
  assert.deepEqual(adaptiveThinking.generationOptions.output_config, { effort: 'high' });
  assert.equal(adaptiveThinking.requestOptions.tool_choice.type, 'tool');
  console.log('ok - Anthropic forced FC rejects manual thinking and preserves adaptive thinking');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'makersuite',
      model: 'gemini-3.6-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
    },
    tools: [tool],
  });
  const declaration = plan.requestOptions.tools[0].functionDeclarations[0];
  assert.equal(plan.ok, true);
  assert.equal(declaration.name, 'emit_reply');
  assert.equal(declaration.parameters.type, 'OBJECT');
  assert.equal(declaration.parameters.properties.content.type, 'STRING');
  assert.equal(Object.hasOwn(declaration.parameters, 'additionalProperties'), false);
  assert.deepEqual(plan.requestOptions.toolConfig, {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: ['emit_reply'],
    },
  });
  console.log('ok - Gemini FC uses functionDeclarations and an ANY allowlist');
}

{
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'makersuite',
      model: 'gemini-3.6-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
    },
    tools: [{
      type: 'function',
      function: {
        name: 'emit_batch',
        description: 'Emit a discriminated batch.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                oneOf: [{
                  type: 'object',
                  properties: { kind: { const: 'chat' } },
                  required: ['kind'],
                }],
              },
            },
          },
          required: ['items'],
        },
      },
    }],
  });
  assert.equal(plan.ok, true);
  const parameters = plan.requestOptions.tools[0].functionDeclarations[0].parameters;
  assert.equal(JSON.stringify(parameters).includes('"const"'), false);
  assert.equal(JSON.stringify(parameters).includes('"oneOf"'), false);
  assert.deepEqual(parameters.properties.items.items.anyOf[0].properties.kind, {
    enum: ['chat'],
    type: 'STRING',
  });
  console.log('ok - Gemini FC compiles JSON Schema discriminated unions into supported anyOf enums');
}

{
  const original = buildPrivateReplyProviderToolDefinition({
    allowedItemTypes: ['text', 'music', 'sticker'],
    allowedStickerKeywords: ['收到'],
  });
  assert.equal(JSON.stringify(original.function.parameters).includes('"oneOf"'), true);
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'makersuite',
      model: 'gemini-3.7-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
    },
    tools: [original],
  });
  assert.equal(plan.ok, true);
  const parameters = plan.requestOptions.tools[0].functionDeclarations[0].parameters;
  const serialized = JSON.stringify(parameters);
  ['"oneOf"', '"anyOf"', '"const"', '"additionalProperties"', '"minLength"', '"maxLength"', '"pattern"']
    .forEach(keyword => assert.equal(serialized.includes(keyword), false, keyword));
  assert.deepEqual(parameters.properties.messages.items.properties.type.enum, ['text', 'music', 'sticker']);
  assert.deepEqual(parameters.properties.messages.items.required, ['type', 'content']);
  assert.equal(parameters.properties.messages.items.properties.artist.type, 'STRING');
  assert.equal(JSON.stringify(original.function.parameters).includes('"oneOf"'), true);
  console.log('ok - Gemini private phone schema folds unions without mutating the strict local contract');
}

{
  const original = buildPhoneReplyBatchProviderToolDefinition({
    target: {
      mode: 'group_chat',
      members: [{ id: 'member-a', name: 'A' }, { id: 'member-b', name: 'B' }],
      momentAuthors: [{ id: 'member-a', name: 'A' }, { id: 'member-b', name: 'B' }],
      tableTargets: [{ id: 'memory', name: 'Memory', rowIds: ['row-1'] }],
    },
    capabilities: {
      momentPost: true,
      imagePrompt: true,
      tableEdit: true,
      variableUpdate: true,
      summary: true,
    },
    allowedItemTypes: ['text', 'music'],
  });
  const plan = buildProviderFcRequestPlan({
    config: {
      provider: 'makersuite',
      model: 'gemini-3.7-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
    },
    tools: [original],
  });
  assert.equal(plan.ok, true);
  const parameters = plan.requestOptions.tools[0].functionDeclarations[0].parameters;
  const serialized = JSON.stringify(parameters);
  ['"oneOf"', '"anyOf"', '"const"', '"additionalProperties"', '"minItems"', '"maxItems"', '"pattern"']
    .forEach(keyword => assert.equal(serialized.includes(keyword), false, keyword));
  assert.deepEqual(parameters.properties.items.items.properties.kind.enum, [
    'chat',
    'moment_post',
    'image_prompt',
    'table_edit',
    'variable_update',
    'summary',
  ]);
  assert.deepEqual(parameters.properties.items.items.required, ['kind']);
  assert.equal(parameters.properties.items.items.properties.actions.items.type, 'OBJECT');
  assert.equal(
    Object.hasOwn(parameters.properties.items.items.properties.actions.items.properties.rowIndex, 'enum'),
    false,
  );
  assert.equal(JSON.stringify(original.function.parameters).includes('"oneOf"'), true);
  console.log('ok - Gemini batch phone schema is a union-free provider view with unchanged local validation');
}

{
  const plan = buildProviderFcRequestPlan({
    config: { provider: 'custom', baseUrl: 'https://gcli.example/v1' },
    tools: [tool],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'unverified_custom_endpoint');
  console.log('ok - request planning cannot bypass endpoint capability eligibility');
}

{
  // Vertex 实测会 400 的写法：约束型 anyOf、type 数组、缺 items 的数组、嵌套长度约束；本地 schema 仍负责这些校验
  const plan = buildProviderFcRequestPlan({
    config: { provider: 'vertexai', model: 'gemini-3.8-flash', vertexaiAuthMode: 'express', apiKey: 'k' },
    tools: [{
      type: 'function',
      function: {
        name: 'group_update_members',
        description: 'Update members.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            group: { type: 'string', maxLength: 160 },
            members: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 160 } },
            refs: { type: 'array', items: { type: ['string', 'integer'], minLength: 1 } },
            entries: { type: 'array', minItems: 1 },
            maybe: { type: ['null', 'string'] },
            pick: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          },
          anyOf: [{ required: ['group'] }, { required: ['groupId'] }],
        },
      },
    }],
  });
  if (plan.ok) {
    const parameters = plan.requestOptions.tools[0].functionDeclarations[0].parameters;
    assert.equal(parameters.type, 'OBJECT');
    assert.equal(Object.hasOwn(parameters, 'anyOf'), false, 'constraint-only anyOf is dropped');
    assert.equal(parameters.properties.refs.items.type, 'STRING');
    assert.equal(parameters.properties.maybe.type, 'STRING');
    assert.equal(parameters.properties.maybe.nullable, true);
    assert.equal(parameters.properties.entries.items.type, 'OBJECT');
    assert.equal(parameters.properties.pick.anyOf.length, 2, 'typed unions stay');
    for (const key of ['"minLength"', '"maxLength"', '"minItems"', '"maxItems"']) {
      assert.equal(JSON.stringify(parameters).includes(key), false, `${key} is not sent to Gemini`);
    }
    console.log('ok - Gemini declarations drop constructs Vertex rejects while keeping typed unions');
  } else {
    console.log(`ok - (skipped Vertex schema check: ${plan.reason})`);
  }
}
