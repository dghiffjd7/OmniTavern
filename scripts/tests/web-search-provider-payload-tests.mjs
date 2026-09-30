import assert from 'node:assert/strict';

import { splitRequestOptions } from '../../src/scripts/api/abort.js';
import { buildWebSearchRequestPlan } from '../../src/scripts/api/web-search-runtime.js';
import { AnthropicProvider } from '../../src/scripts/api/providers/anthropic.js';
import { DeepseekProvider } from '../../src/scripts/api/providers/deepseek.js';
import { GeminiProvider } from '../../src/scripts/api/providers/gemini.js';
import { KimiProvider } from '../../src/scripts/api/providers/kimi.js';
import { MakersuiteProvider } from '../../src/scripts/api/providers/makersuite.js';
import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';
import { OpenRouterProvider } from '../../src/scripts/api/providers/openrouter.js';
import { VertexAIProvider } from '../../src/scripts/api/providers/vertexai.js';
import { ZhipuProvider } from '../../src/scripts/api/providers/zhipu.js';

const messages = [{ role: 'user', content: 'latest news' }];
const sourceCallback = () => {};

{
  const split = splitRequestOptions({
    tools: [{ type: 'test' }],
    onProviderSources: sourceCallback,
  });
  assert.equal(split.onProviderSources, sourceCallback);
  assert.deepEqual(split.options, { tools: [{ type: 'test' }] });
}

{
  const plan = buildWebSearchRequestPlan({ enabled: true, provider: 'openrouter' });
  const provider = new OpenRouterProvider({ apiKey: 'test', model: 'openrouter/auto' });
  const prepared = provider.prepareChatRequest(messages, {
    ...plan.requestOptions,
    onProviderSources: sourceCallback,
  });
  assert.deepEqual(prepared.payload.tools, plan.requestOptions.tools);
  assert.equal(prepared.payload.max_tool_calls, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(prepared.payload, 'onProviderSources'), false);
}

{
  const aiStudioPlan = buildWebSearchRequestPlan({ enabled: true, provider: 'makersuite' });
  const makersuite = new MakersuiteProvider({ apiKey: 'test', model: 'gemini-test' });
  const gemini = new GeminiProvider({ apiKey: 'test', model: 'gemini-test' });
  assert.deepEqual(makersuite.buildRequestBody(messages, aiStudioPlan.requestOptions).tools, [{ google_search: {} }]);
  assert.deepEqual(gemini.buildRequestBody(messages, aiStudioPlan.requestOptions).tools, [{ google_search: {} }]);

  const vertexPlan = buildWebSearchRequestPlan({ enabled: true, provider: 'vertexai' });
  const vertex = new VertexAIProvider({
    apiKey: 'test',
    model: 'gemini-test',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    vertexaiProjectId: 'project-test',
  });
  assert.deepEqual(vertex.buildRequestBody(messages, vertexPlan.requestOptions).tools, [{ googleSearch: {} }]);
}

{
  const plan = buildWebSearchRequestPlan({ enabled: true, provider: 'anthropic' });
  const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-test' });
  let requestBody = null;
  provider.requestJson = async (request) => {
    requestBody = JSON.parse(request.body);
    return { content: [{ type: 'text', text: 'answer' }], usage: {} };
  };
  assert.equal(await provider.chat(messages, {
    ...plan.requestOptions,
    onProviderSources: sourceCallback,
  }), 'answer');
  assert.deepEqual(requestBody.tools, plan.requestOptions.tools);
  assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'onProviderSources'), false);
}

{
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
  });
  const provider = new ZhipuProvider({ apiKey: 'test', model: 'glm-5.2' });
  const prepared = provider.prepareChatRequest(messages, {
    ...plan.requestOptions,
    onProviderSources: sourceCallback,
  });
  assert.deepEqual(prepared.payload.tools, plan.requestOptions.tools);
  assert.equal(Object.hasOwn(prepared.payload, 'onProviderSources'), false);
}

{
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
  });
  const provider = new KimiProvider({ apiKey: 'test', model: 'kimi-k2.6' });
  const prepared = provider.prepareChatRequest(messages, {
    ...plan.requestOptions,
    onProviderSources: sourceCallback,
  });
  assert.deepEqual(prepared.payload.tools, [{
    type: 'builtin_function',
    function: { name: '$web_search' },
  }]);
  assert.equal(Object.hasOwn(prepared.payload, 'onProviderSources'), false);
}

{
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  });
  const provider = new OpenAIProvider({
    provider: 'openai',
    apiKey: 'test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  });
  const prepared = provider.prepareResponsesRequest(messages, {
    ...plan.requestOptions,
    onProviderSources: sourceCallback,
  });
  assert.equal(prepared.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(prepared.body.tools, [{ type: 'web_search' }]);
  assert.equal(prepared.body.tool_choice, 'auto');
  assert.deepEqual(prepared.body.include, ['web_search_call.action.sources']);
  assert.equal(Object.hasOwn(prepared.body, 'onProviderSources'), false);
}

{
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    fallbackToolDefinitions: [{ name: 'web.search', schema: { type: 'object', properties: {} } }],
  });
  const provider = new DeepseekProvider({
    provider: 'deepseek',
    apiKey: 'test',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
  });
  const prepared = provider.prepareChatRequest(messages, plan.requestOptions);
  assert.equal(prepared.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(prepared.payload.tools[0].type, 'function');
  assert.equal(prepared.payload.tools[0].function.name, 'web_search');
  assert.equal(prepared.payload.tool_choice, 'auto');
  assert.equal(Object.hasOwn(prepared.payload, 'include'), false);
}

console.log('ok - native web search schemas reach each provider payload without leaking callbacks');
