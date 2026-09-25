import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildReasoningRequestOptions,
  getReasoningCapability,
} from '../../src/scripts/api/model-capabilities.js';
import { LLMClient } from '../../src/scripts/api/client.js';
import { OpenRouterProvider } from '../../src/scripts/api/providers/openrouter.js';
import {
  clearOpenRouterModelCapabilitiesForTests,
  readOpenRouterModelCapabilities,
} from '../../src/scripts/api/openrouter-model-capabilities.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('OpenRouterProvider uses OpenRouter defaults and attribution headers', () => {
  const provider = new OpenRouterProvider({ apiKey: 'or-key' });
  assert.equal(provider.provider, 'openrouter');
  assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(provider.model, 'openrouter/auto');

  const headers = provider.getHeaders();
  assert.equal(headers.Authorization, 'Bearer or-key');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['HTTP-Referer'], 'https://github.com/dghiffjd7/OmniTavern');
  assert.equal(headers['X-OpenRouter-Title'], 'OmniTavern');
  assert.equal(headers['X-Title'], 'OmniTavern');
});

test('OpenRouterProvider honors custom attribution config', () => {
  const provider = new OpenRouterProvider({
    apiKey: 'or-key',
    openrouterReferer: 'https://example.test',
    openrouterTitle: 'Example App',
  });
  const headers = provider.getHeaders();
  assert.equal(headers['HTTP-Referer'], 'https://example.test');
  assert.equal(headers['X-OpenRouter-Title'], 'Example App');
  assert.equal(headers['X-Title'], 'Example App');
});

test('OpenRouterProvider prepares OpenAI-compatible chat completions', () => {
  const provider = new OpenRouterProvider({
    apiKey: 'or-key',
    model: 'openai/gpt-5.2',
  });
  const prepared = provider.prepareChatRequest([{ role: 'user', content: 'hi' }], {
    temperature: 0.7,
    max_tokens: 64,
    reasoning: { effort: 'high' },
    tools: [{ type: 'function', function: { name: 'contact_profile_list', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  });
  assert.equal(prepared.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(prepared.payload.model, 'openai/gpt-5.2');
  assert.equal(prepared.payload.temperature, 0.7);
  assert.equal(prepared.payload.max_tokens, 64);
  assert.deepEqual(prepared.payload.reasoning, { effort: 'high' });
  assert.equal(prepared.payload.tools[0].function.name, 'contact_profile_list');
  assert.equal(prepared.payload.tool_choice, 'auto');
});

test('OpenRouterProvider preserves FC routing requirements and disables parallel calls', () => {
  const provider = new OpenRouterProvider({ apiKey: 'or-key', model: 'openai/gpt-5.2' });
  const prepared = provider.prepareChatRequest([{ role: 'user', content: 'hi' }], {
    tools: [{ type: 'function', function: { name: 'emit_reply', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'emit_reply' } },
    parallel_tool_calls: false,
    provider: { data_collection: 'deny', require_parameters: true },
  });
  assert.equal(prepared.payload.parallel_tool_calls, false);
  assert.deepEqual(prepared.payload.provider, {
    data_collection: 'deny',
    require_parameters: true,
  });
});

test('OpenRouterProvider restricts requests to selected upstream providers', () => {
  const provider = new OpenRouterProvider({
    apiKey: 'or-key',
    model: 'moonshotai/kimi-k3',
    openrouterProviderOnly: ['deepinfra', ' together ', 'deepinfra'],
  });
  const prepared = provider.prepareChatRequest([{ role: 'user', content: 'hi' }], {
    provider: { data_collection: 'deny', require_parameters: true },
  });
  assert.deepEqual(prepared.payload.provider, {
    data_collection: 'deny',
    require_parameters: true,
    only: ['deepinfra', 'together'],
  });
});

test('OpenRouterProvider leaves routing unrestricted when no upstream is selected', () => {
  const provider = new OpenRouterProvider({
    apiKey: 'or-key',
    model: 'moonshotai/kimi-k3',
    openrouterProviderOnly: [],
  });
  const prepared = provider.prepareChatRequest([{ role: 'user', content: 'hi' }]);
  assert.equal(Object.prototype.hasOwnProperty.call(prepared.payload, 'provider'), false);
});

test('OpenRouter reasoning models use reasoning.effort options', () => {
  const capability = getReasoningCapability({
    provider: 'openrouter',
    model: 'openai/gpt-5.2',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  assert.equal(capability.supported, true);
  assert.equal(capability.strategy, 'openrouter-reasoning');
  assert.deepEqual(
    buildReasoningRequestOptions({
      provider: 'openrouter',
      model: 'openai/gpt-5.2',
      baseUrl: 'https://openrouter.ai/api/v1',
      requestReasoning: true,
      reasoningEffort: 'high',
    }),
    { reasoning: { effort: 'high' } },
  );
  assert.deepEqual(
    buildReasoningRequestOptions({
      provider: 'openrouter',
      model: 'openai/gpt-5.2',
      baseUrl: 'https://openrouter.ai/api/v1',
      requestReasoning: true,
      reasoningEffort: 'auto',
    }),
    {},
  );
});

test('OpenRouterProvider lists OpenRouter models without filtering provider slugs', async () => {
  clearOpenRouterModelCapabilitiesForTests();
  const provider = new OpenRouterProvider({ apiKey: 'or-key' });
  provider.requestJson = async ({ url, method, headers }) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.equal(method, 'GET');
    assert.equal(headers.Authorization, 'Bearer or-key');
    return {
      data: [
        { id: 'openrouter/auto' },
        { id: 'anthropic/claude-sonnet-4.5' },
        { id: 'openai/gpt-5.2', canonical_slug: 'openai/gpt-5.2-202608', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] },
        { id: 'deepseek/deepseek-v3.2' },
      ],
    };
  };
  assert.deepEqual(await provider.listModels(), [
    'openrouter/auto',
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5.2',
    'deepseek/deepseek-v3.2',
  ]);
  assert.deepEqual(readOpenRouterModelCapabilities({
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.2',
  }), {
    known: true,
    id: 'openai/gpt-5.2',
    canonicalSlug: 'openai/gpt-5.2-202608',
    contextLength: 128000,
    supportedParameters: ['tools', 'tool_choice'],
    supportsTools: true,
    supportsToolChoice: true,
  });
});

test('OpenRouterProvider lists and deduplicates upstream providers for one model', async () => {
  const provider = new OpenRouterProvider({ apiKey: 'or-key', model: 'moonshotai/kimi-k3' });
  provider.requestJson = async ({ url, method, headers }) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models/moonshotai/kimi-k3/endpoints');
    assert.equal(method, 'GET');
    assert.equal(headers.Authorization, 'Bearer or-key');
    return {
      data: {
        endpoints: [
          { provider_name: 'Morph', tag: 'morph/fast' },
          { provider_name: 'DeepInfra', tag: 'deepinfra/bf16' },
          { provider_name: 'Morph', tag: 'morph/quality' },
          { provider_name: 'Together', tag: 'together' },
        ],
      },
    };
  };
  assert.deepEqual(await provider.listModelProviders(), [
    { slug: 'morph', name: 'Morph' },
    { slug: 'deepinfra', name: 'DeepInfra' },
    { slug: 'together', name: 'Together' },
  ]);
});

test('OpenRouterProvider preflights one exact model and caches its tool parameters', async () => {
  clearOpenRouterModelCapabilitiesForTests();
  const provider = new OpenRouterProvider({ apiKey: 'or-key', model: 'vendor/tool-model:free' });
  let calls = 0;
  provider.requestJson = async ({ url, method, headers }) => {
    calls += 1;
    assert.equal(url, 'https://openrouter.ai/api/v1/model/vendor/tool-model%3Afree');
    assert.equal(method, 'GET');
    assert.equal(headers.Authorization, 'Bearer or-key');
    return {
      data: {
        id: 'vendor/tool-model:free',
        canonical_slug: 'vendor/tool-model',
        supported_parameters: ['tools', 'tool_choice', 'temperature'],
      },
    };
  };
  const first = await provider.prepareProviderFcCapabilities();
  const second = await provider.prepareProviderFcCapabilities();
  assert.equal(calls, 1);
  assert.equal(first.supportsTools, true);
  assert.equal(first.supportsToolChoice, true);
  assert.deepEqual(second, first);
});

test('OpenRouterProvider falls back to auto router when models endpoint fails', async () => {
  const provider = new OpenRouterProvider({ apiKey: 'or-key' });
  provider.requestJson = async () => {
    throw new Error('network down');
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await provider.listModels(), ['openrouter/auto']);
  } finally {
    console.warn = originalWarn;
  }
});

test('LLMClient can create the OpenRouter provider', () => {
  const client = new LLMClient({ provider: 'openrouter', apiKey: 'or-key' });
  assert.equal(client.provider instanceof OpenRouterProvider, true);
});

test('ConfigManager persists OpenRouter upstream selections per profile', async () => {
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
  };
  try {
    const { ConfigManager } = await import('../../src/scripts/storage/config.js');
    const scope = `openrouter_routing_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const manager = new ConfigManager({ scope });
    await manager.ensureStores();
    await manager.createProfile('OpenRouter routing', {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'moonshotai/kimi-k3',
    });
    await manager.save({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'moonshotai/kimi-k3',
      openrouterProviderOnly: ['deepinfra', ' together ', 'deepinfra'],
    });
    assert.deepEqual(manager.get().openrouterProviderOnly, ['deepinfra', 'together']);
    assert.deepEqual(manager.getActiveProfile().openrouterProviderOnly, ['deepinfra', 'together']);
    const reloaded = await new ConfigManager({ scope }).load();
    assert.deepEqual(reloaded.openrouterProviderOnly, ['deepinfra', 'together']);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('ConfigPanel exposes OpenRouter as a chat provider with defaults', async () => {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = previousLocalStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    const { ConfigPanel } = await import('../../src/scripts/ui/config-panel.js');
    const panel = new ConfigPanel();
    assert.equal(panel.getProviderOptions().some(item => item.value === 'openrouter'), true);
    assert.deepEqual(panel.getProviderDefaults('openrouter'), {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
      urlHelp: 'OpenRouter API 基础 URL',
    });

    panel.activeTab = 'image';
    assert.equal(panel.getProviderOptions().some(item => item.value === 'openrouter'), false);
  } finally {
    if (previousLocalStorage) {
      globalThis.localStorage = previousLocalStorage;
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('ConfigPanel exposes model-specific multi-select OpenRouter routing controls', async () => {
  const panelSource = await readFile(new URL('../../src/scripts/ui/config-panel.js', import.meta.url), 'utf8');
  assert.match(panelSource, /id="openrouter-provider-routing"/);
  assert.match(panelSource, /id="refresh-openrouter-providers"/);
  assert.match(panelSource, /openrouterProviderOnly/);
  assert.match(panelSource, /listModelProviders/);
  assert.match(panelSource, /不指定[^\n]*全部/);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) process.exit(1);
