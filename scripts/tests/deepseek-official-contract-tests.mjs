import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderFcRequestPlan } from '../../src/scripts/agent/provider-fc-transport.js';
import { readChatFcCapability } from '../../src/scripts/agent/chat-fc-capability-catalog.js';
import { DeepseekProvider } from '../../src/scripts/api/providers/deepseek.js';
import { buildReasoningRequestOptions } from '../../src/scripts/api/model-capabilities.js';
import { getVisionInputCapability } from '../../src/scripts/api/vision-capabilities.js';
import { buildWebSearchRequestPlan } from '../../src/scripts/api/web-search-runtime.js';

const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' };
const messages = [{ role: 'user', content: 'Read the supplied item.' }];
const tool = { type: 'function', function: { name: 'emit_result', parameters: {
  type: 'object', properties: { content: { type: 'string' } }, required: ['content'],
} } };

test('current official DeepSeek ID reaches stateless native FC without rewriting the profile', () => {
  const plan = buildProviderFcRequestPlan({ config, tools: [tool], thinkingEnabled: false });
  assert.equal(plan.ok, true, plan.reason);
  const provider = new DeepseekProvider(config);
  const prepared = provider.prepareChatRequest(messages, { ...plan.generationOptions, ...plan.requestOptions });
  assert.equal(prepared.url, 'https://api.deepseek.com/responses');
  assert.equal(prepared.body.model, 'deepseek-flash');
  assert.equal(prepared.body.store, false);
  assert.deepEqual(prepared.body.tool_choice, { type: 'function', name: 'emit_result' });
  assert.deepEqual(prepared.body.reasoning, { effort: 'none' });
  assert.equal(prepared.body.tools[0].strict, false);
  assert.deepEqual(config, { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' });
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    assert.equal(buildProviderFcRequestPlan({ config: { ...config, model }, tools: [tool] }).ok, true);
  }
  assert.equal(buildProviderFcRequestPlan({ config: { ...config, model: 'deepseek-unknown' }, tools: [tool] }).ok, false);
  assert.equal(buildProviderFcRequestPlan({ config: { ...config, baseUrl: 'https://proxy.example/v1' }, tools: [tool] }).ok, false);
  assert.equal(readChatFcCapability({ providerId: 'deepseek', modelId: config.model,
    endpointClass: 'official_deepseek_responses' }).matched, false, 'documentation does not invent completed app-level verification');
});

test('DeepSeek reasoning toggle survives Chat Completions and Responses formatting', () => {
  const provider = new DeepseekProvider(config);
  const disabled = buildReasoningRequestOptions({ ...config, requestReasoning: false });
  assert.deepEqual(provider.prepareChatRequest(messages, disabled).payload.thinking, { type: 'disabled' });
  assert.deepEqual(provider.prepareResponsesRequest(messages, disabled).body.reasoning, { effort: 'none' });
  const enabled = buildReasoningRequestOptions({ ...config, requestReasoning: true, reasoningEffort: 'max' });
  assert.deepEqual(provider.prepareResponsesRequest(messages, enabled).body.reasoning, { effort: 'max' });
  assert.deepEqual(provider.prepareResponsesRequest(messages, { ...enabled, reasoning: { effort: 'none' } }).body.reasoning, { effort: 'none' });
});

test('documented DeepSeek image model is supported only on the official endpoint', () => {
  assert.equal(getVisionInputCapability(config).supported, true);
  assert.equal(getVisionInputCapability({ ...config, baseUrl: '' }).supported, true);
  for (const baseUrl of ['https://proxy.example/v1', 'https://api.deepseek.com.evil.example/v1']) {
    assert.equal(getVisionInputCapability({ ...config, baseUrl }).supported, false);
  }
  assert.equal(getVisionInputCapability({ ...config, model: 'deepseek-chat' }).supported, false);
  const image = 'https://example.com/image.png';
  const prepared = new DeepseekProvider(config).prepareResponsesRequest([{ role: 'user', content: [
    { type: 'text', text: 'Describe.' }, { type: 'image_url', image_url: { url: image } },
  ] }]);
  assert.deepEqual(prepared.body.input[0].content[1], { type: 'input_image', image_url: image });
});

test('DeepSeek search uses executable local function tools instead of ignored built-in web_search', () => {
  const definition = { name: 'web.search', description: 'Search', schema: {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
  } };
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
    const plan = buildWebSearchRequestPlan({ ...config, model, enabled: true, fallbackToolDefinitions: [definition] });
    assert.equal(plan.native, false, model);
    assert.equal(plan.fallback, true, model);
    assert.deepEqual(plan.fallbackToolNames, { web_search: 'web.search' });
    const prepared = new DeepseekProvider({ ...config, model }).prepareChatRequest(messages, plan.requestOptions);
    assert.equal(prepared.payload.tools[0].type, 'function');
    assert.equal(prepared.payload.tools[0].function.name, 'web_search');
  }
});
