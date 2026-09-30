import assert from 'node:assert/strict';

import {
  WEB_SEARCH_ROUTES,
  buildWebSearchRequestPlan,
  extractProviderWebSources,
  extractProviderWebSearchActivity,
  extractToolResultWebSources,
  mergeWebSources,
  normalizeWebSources,
  resolveWebSearchRoute,
} from '../../src/scripts/api/web-search-runtime.js';

assert.equal(resolveWebSearchRoute({ enabled: false, provider: 'openrouter' }), WEB_SEARCH_ROUTES.disabled);
assert.equal(resolveWebSearchRoute({ enabled: true, provider: 'openrouter' }), WEB_SEARCH_ROUTES.openrouter);
assert.equal(resolveWebSearchRoute({ enabled: true, provider: 'makersuite' }), WEB_SEARCH_ROUTES.gemini);
assert.equal(resolveWebSearchRoute({ enabled: true, provider: 'vertexai' }), WEB_SEARCH_ROUTES.gemini);
assert.equal(resolveWebSearchRoute({ enabled: true, provider: 'anthropic' }), WEB_SEARCH_ROUTES.anthropic);
assert.equal(resolveWebSearchRoute({
  enabled: true,
  provider: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-5.2',
}), WEB_SEARCH_ROUTES.zhipu);
assert.equal(resolveWebSearchRoute({
  enabled: true,
  provider: 'kimi',
  baseUrl: 'https://api.moonshot.ai/v1',
  model: 'kimi-k2.6',
}), WEB_SEARCH_ROUTES.kimi);
assert.equal(resolveWebSearchRoute({
  enabled: true,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-sol',
}), WEB_SEARCH_ROUTES.openai);
assert.equal(resolveWebSearchRoute({
  enabled: true,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-pro',
}), WEB_SEARCH_ROUTES.toolFallback);
assert.equal(resolveWebSearchRoute({
  enabled: true,
  provider: 'deepseek',
  baseUrl: 'https://proxy.example/v1',
  model: 'deepseek-v4-pro',
}), WEB_SEARCH_ROUTES.toolFallback);
assert.equal(resolveWebSearchRoute({
  enabled: true,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
}), WEB_SEARCH_ROUTES.toolFallback);
console.log('ok - web search route stays disabled by default and selects native providers first');

{
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'openrouter',
    existingOptions: [{
      tools: [{ type: 'function', function: { name: 'existing', parameters: { type: 'object' } } }],
    }],
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.native, true);
  assert.equal(plan.requestOptions.tools.length, 3);
  assert.equal(plan.requestOptions.tools[1].type, 'openrouter:web_search');
  assert.deepEqual(plan.requestOptions.tools[1].parameters, { max_results: 3, max_total_results: 6 });
  assert.equal(plan.requestOptions.tools[2].type, 'openrouter:web_fetch');
  assert.deepEqual(plan.requestOptions.tools[2].parameters, { max_uses: 2, max_content_tokens: 6000 });
  assert.equal(plan.requestOptions.max_tool_calls, 3);
}

{
  const aiStudio = buildWebSearchRequestPlan({ enabled: true, provider: 'makersuite' });
  const vertex = buildWebSearchRequestPlan({ enabled: true, provider: 'vertexai' });
  assert.deepEqual(aiStudio.requestOptions.tools, [{ google_search: {} }]);
  assert.deepEqual(vertex.requestOptions.tools, [{ googleSearch: {} }]);
}

{
  // Gemini 2 原生搜索与既有 function 工具混用会被拒绝。
  const conflicted = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    existingOptions: [{ tools: [{ functionDeclarations: [{ name: 'existing' }] }] }],
  });
  assert.equal(conflicted.enabled, false);
  assert.equal(conflicted.route, 'gemini_native');
  assert.match(conflicted.diagnostics.reason, /function tools/);

  const gemini3 = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'gemini',
    model: 'gemini-3-pro-preview',
    existingOptions: [{ tools: [{ functionDeclarations: [{ name: 'existing' }] }] }],
  });
  assert.equal(gemini3.enabled, true);
  assert.equal(gemini3.native, true);
  assert.equal(gemini3.fallback, false);
  assert.deepEqual(gemini3.requestOptions.tools, [
    { functionDeclarations: [{ name: 'existing' }] },
    { google_search: {} },
  ]);
}

{
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
  });
  assert.deepEqual(plan.requestOptions.tools, [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
  }]);

  const dynamic = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  });
  assert.deepEqual(dynamic.requestOptions.tools, [{
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 3,
    allowed_callers: ['direct', 'code_execution_20260120'],
  }]);

  // 旧命名格式（claude-<major>-<minor>-<family>）不得被误判为支持动态搜索工具。
  for (const legacyModel of [
    'claude-3-5-sonnet-20241022',
    'claude-3-7-sonnet-20250219',
    'claude-3-opus-20240229',
  ]) {
    const legacy = buildWebSearchRequestPlan({
      enabled: true,
      provider: 'anthropic',
      model: legacyModel,
    });
    assert.equal(legacy.requestOptions.tools[0].type, 'web_search_20250305', legacyModel);
    assert.equal(Object.hasOwn(legacy.requestOptions.tools[0], 'allowed_callers'), false, legacyModel);
  }

  // family-first 的 Claude 4.0 快照中，八位数字是发布日期，不是 minor 版本。
  for (const datedModel of [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
  ]) {
    const dated = buildWebSearchRequestPlan({
      enabled: true,
      provider: 'anthropic',
      model: datedModel,
    });
    assert.equal(dated.requestOptions.tools[0].type, 'web_search_20250305', datedModel);
    assert.equal(Object.hasOwn(dated.requestOptions.tools[0], 'allowed_callers'), false, datedModel);
  }
}

{
  const zhipu = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
  });
  assert.equal(zhipu.native, true);
  assert.equal(zhipu.fallback, false);
  assert.deepEqual(zhipu.requestOptions.tools, [{
    type: 'web_search',
    web_search: {
      enable: true,
      search_engine: 'search_pro',
      search_result: true,
      count: 5,
      content_size: 'medium',
    },
  }]);

  const kimi = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
  });
  assert.equal(kimi.native, true);
  assert.equal(kimi.fallback, false);
  assert.deepEqual(kimi.requestOptions.tools, [{
    type: 'builtin_function',
    function: { name: '$web_search' },
  }]);
  assert.equal(kimi.diagnostics.maxContinuationTurns, 3);

  // gpt-4o 系列官方支持 Responses web_search，须命中 openai 原生路由。
  for (const model of [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4o-2024-11-20',
    'gpt-4o-mini-2024-07-18',
  ]) {
    assert.equal(resolveWebSearchRoute({
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model,
    }), 'openai_native', model);
  }

  // 名称同样以 gpt-4o 开头的专用模型，不得套用通用 Responses web_search 合同。
  for (const model of [
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-tts',
    'gpt-4o-realtime-preview',
    'gpt-4o-audio-preview',
    'gpt-4o-search-preview',
    'gpt-4o-mini-search-preview',
  ]) {
    assert.equal(resolveWebSearchRoute({
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model,
    }), 'tool_fallback', model);
  }

  const openai = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    existingOptions: [{
      tools: [{ type: 'function', function: { name: 'existing', parameters: { type: 'object' } } }],
    }],
  });
  assert.equal(openai.native, true);
  assert.equal(openai.fallback, false);
  assert.equal(openai.requestOptions.openaiApi, 'responses');
  assert.equal(openai.requestOptions.tools[0].function.name, 'existing');
  assert.deepEqual(openai.requestOptions.tools[1], { type: 'web_search' });
  assert.deepEqual(openai.requestOptions.include, ['web_search_call.action.sources']);

  const deepseek = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    fallbackToolDefinitions: [{ name: 'web.search', schema: { type: 'object', properties: {} } }],
  });
  assert.equal(deepseek.native, false);
  assert.equal(deepseek.fallback, true);
  assert.equal(deepseek.requestOptions.tools[0].type, 'function');
  assert.deepEqual(deepseek.fallbackToolNames, { web_search: 'web.search' });
  assert.equal(Object.hasOwn(deepseek.requestOptions, 'include'), false);
}

{
  const definitions = [
    { name: 'web.search', description: 'Search', schema: { type: 'object', required: ['query'] } },
    { name: 'web.research', description: 'Research', schema: { type: 'object', required: ['query'] } },
    { name: 'web.fetch_url', description: 'Fetch page', schema: { type: 'object', required: ['url'] } },
  ];
  const plan = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'deepseek',
    fallbackToolDefinitions: definitions,
  });
  assert.equal(plan.fallback, true);
  assert.equal(plan.requestOptions.tool_choice, 'auto');
  assert.deepEqual(plan.requestOptions.tools.map(item => item.function.name), ['web_search', 'web_research', 'web_fetch']);
  assert.deepEqual(plan.fallbackToolNames, {
    web_search: 'web.search',
    web_research: 'web.research',
    web_fetch: 'web.fetch_url',
  });

  const proxy = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'zhipu',
    baseUrl: 'https://proxy.example/v1',
    model: 'glm-5.2',
    fallbackToolDefinitions: definitions,
  });
  assert.equal(proxy.route, WEB_SEARCH_ROUTES.toolFallback);
  assert.equal(proxy.native, false);
  assert.equal(proxy.fallback, true);

  const prefix = buildWebSearchRequestPlan({
    enabled: true,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    existingOptions: [{ deepseekPrefix: { prefix: '<content>' } }],
    fallbackToolDefinitions: definitions,
  });
  assert.equal(prefix.enabled, false);
  assert.match(prefix.diagnostics.reason, /prefix/iu);
}
console.log('ok - web search request plans preserve existing tools and use current provider-native schemas');

{
  const normalized = normalizeWebSources([
    { url: 'https://example.com/a#section', title: 'Example A', snippet: 'one', provider: 'x' },
    { uri: 'https://example.com/a', title: 'duplicate' },
    { url: 'javascript:alert(1)', title: 'bad' },
    { link: 'https://example.org/b', name: 'Example B' },
  ]);
  assert.deepEqual(normalized, [
    { url: 'https://example.com/a', title: 'Example A', snippet: 'one', provider: 'x' },
    { url: 'https://example.org/b', title: 'Example B' },
  ]);
  assert.equal(mergeWebSources(normalized, [{ url: 'https://example.net/c', title: 'C' }]).length, 3);
}

{
  const openrouter = extractProviderWebSources({
    choices: [{
      message: {
        annotations: [{
          type: 'url_citation',
          url_citation: { url: 'https://or.example/a', title: 'OR source', content: 'excerpt' },
        }],
      },
    }],
  }, { provider: 'openrouter' });
  assert.deepEqual(openrouter, [{
    url: 'https://or.example/a',
    title: 'OR source',
    snippet: 'excerpt',
    provider: 'openrouter',
  }]);

  const gemini = extractProviderWebSources({
    candidates: [{
      groundingMetadata: {
        groundingChunks: [{ web: { uri: 'https://gemini.example/a', title: 'Gemini source' } }],
      },
    }],
  }, { provider: 'makersuite' });
  assert.deepEqual(gemini, [{
    url: 'https://gemini.example/a',
    title: 'Gemini source',
    provider: 'makersuite',
  }]);

  const anthropic = extractProviderWebSources({
    content: [
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://claude.example/a', title: 'Claude source' }],
      },
      {
        type: 'text',
        text: 'answer',
        citations: [{
          type: 'web_search_result_location',
          url: 'https://claude.example/a',
          title: 'Claude source',
          cited_text: 'cited',
        }],
      },
    ],
  }, { provider: 'anthropic' });
  assert.deepEqual(anthropic, [{
    url: 'https://claude.example/a',
    title: 'Claude source',
    provider: 'anthropic',
  }]);

  const openai = extractProviderWebSources({
    output: [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          sources: [{ url: 'https://openai.example/a', title: 'OpenAI full source' }],
        },
      },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          annotations: [{ type: 'url_citation', url: 'https://openai.example/b', title: 'OpenAI citation' }],
        }],
      },
    ],
  }, { provider: 'openai' });
  assert.deepEqual(openai, [
    { url: 'https://openai.example/a', title: 'OpenAI full source', provider: 'openai' },
    { url: 'https://openai.example/b', title: 'OpenAI citation', provider: 'openai' },
  ]);

  const zhipu = extractProviderWebSources({
    web_search: [{ link: 'https://glm.example/a', title: 'GLM source', content: 'fresh fact' }],
  }, { provider: 'zhipu' });
  assert.deepEqual(zhipu, [{
    url: 'https://glm.example/a',
    title: 'GLM source',
    snippet: 'fresh fact',
    provider: 'zhipu',
  }]);

  const kimi = extractProviderWebSources({
    choices: [{
      message: {
        tool_calls: [{
          function: {
            name: '$web_search',
            arguments: JSON.stringify({
              results: [{ url: 'https://kimi.example/a', title: 'Kimi source', snippet: 'result' }],
            }),
          },
        }],
      },
    }],
  }, { provider: 'kimi' });
  assert.deepEqual(kimi, [{
    url: 'https://kimi.example/a',
    title: 'Kimi source',
    snippet: 'result',
    provider: 'kimi',
  }]);
}
console.log('ok - provider citation payloads normalize into one safe source contract');

{
  assert.deepEqual(extractProviderWebSearchActivity({
    type: 'response.web_search_call.searching',
    item_id: 'ws-1',
  }, { provider: 'openai' }), {
    state: 'searching',
    provider: 'openai',
    execution: 'provider_native',
    searchRequests: 1,
    sourceCount: 0,
  });
  assert.deepEqual(extractProviderWebSearchActivity({
    type: 'response.web_search_call.completed',
    item_id: 'ws-1',
  }, { provider: 'openai' }), {
    state: 'done',
    provider: 'openai',
    execution: 'provider_native',
    searchRequests: 1,
    sourceCount: 0,
  });
}
console.log('ok - native streaming activity distinguishes provider search start and completion');

{
  // web.fetch_url 单页结果：抓取页本身作为来源
  const fetched = extractToolResultWebSources({
    result: { ok: true, url: 'https://page.example/doc', title: 'Doc', text: 'body text' },
  }, { provider: 'web.fetch_url' });
  assert.deepEqual(fetched, [{
    url: 'https://page.example/doc',
    title: 'Doc',
    provider: 'web.fetch_url',
  }]);
}
console.log('ok - fetched single pages surface as their own source');
