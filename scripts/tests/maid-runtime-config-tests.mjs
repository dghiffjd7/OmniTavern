import assert from 'node:assert/strict';

import {
  createMaidMemoryExtractionRuntimeResolver,
  createMaidRuntimeConfigResolver,
} from '../../src/scripts/agent/maid-runtime-config.js';

{
  const resolver = createMaidRuntimeConfigResolver({
    settingsStore: {
      getBoundProfileId: () => '',
      getPersonaPrompt: () => 'test persona',
      listSubAgents: () => [{ id: 'sub', enabled: true }, { id: 'disabled', enabled: false }],
    },
    configManager: {
      ensureStores: async () => {
        throw new Error('should not load config without binding');
      },
    },
  });
  const runtime = await resolver();
  assert.equal(runtime.configured, false);
  assert.equal(runtime.bound, false);
  assert.equal(runtime.reason, 'maid_profile_not_bound');
  assert.equal(runtime.maidPrompt, 'test persona');
  assert.equal(runtime.personaPrompt, 'test persona');
  assert.deepEqual(runtime.subAgents.map(item => item.id), ['sub'], 'voice-only tasks still see independently configured sub-agents');
  console.log('ok - maid runtime config resolver refuses unbound current config fallback');
}

{
  const resolver = createMaidRuntimeConfigResolver({
    settingsStore: {
      getBoundProfileId: () => 'maid-profile',
      getMaidPrompt: () => 'quiet',
    },
    configManager: {
      ensureStores: async () => {},
      getRuntimeConfigByProfileId: async (profileId) => ({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        apiKey: profileId === 'maid-profile' ? 'key' : '',
      }),
    },
    isConfigReady: config => Boolean(config?.apiKey),
    createClient: config => ({ chat: async () => config.model }),
  });
  const runtime = await resolver();
  assert.equal(runtime.configured, true);
  assert.equal(runtime.bound, true);
  assert.equal(runtime.profileId, 'maid-profile');
  assert.equal(runtime.maidPrompt, 'quiet');
  assert.equal(runtime.personaPrompt, 'quiet');
  assert.equal(typeof runtime.client.chat, 'function');
console.log('ok - maid runtime config resolver uses explicit maid profile');
}

{
  const resolver = createMaidRuntimeConfigResolver({
    settingsStore: {
      getBoundProfileId: () => 'vision-main',
      getFallbackProfileId: () => 'text-fallback',
      getGenerationSettings: () => ({ reasoningMode: 'on', reasoningEffort: 'low' }),
    },
    configManager: {
      ensureStores: async () => {},
      getRuntimeConfigByProfileId: async profileId => (profileId === 'vision-main'
        ? { provider: 'openai', model: 'gpt-4o', apiKey: 'main-key' }
        : { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'fallback-key' }),
    },
    isConfigReady: config => Boolean(config?.apiKey),
    createClient: config => ({ chat: async () => config.model }),
  });
  const runtime = await resolver();
  assert.equal(runtime.fallbackConfig.provider, 'deepseek');
  assert.equal(runtime.fallbackConfig.model, 'deepseek-chat');
  assert.deepEqual(runtime.generationSettings, { reasoningMode: 'on', reasoningEffort: 'low' }, 'maid reasoning settings travel with the runtime');
  assert.equal(runtime.fallbackProfileId, 'text-fallback');
  assert.equal(typeof runtime.fallbackClient.chat, 'function');
  console.log('ok - maid runtime config exposes fallback capability metadata');
}

{
  // Phase B：getSubAgents（来自 Agent Registry）替代直接读 store，subAgents 结果与来源一致且过 enabled
  const resolver = createMaidRuntimeConfigResolver({
    settingsStore: {
      getBoundProfileId: () => 'maid-profile',
      getMaidPrompt: () => 'p',
      // 若 registry 路径生效，此方法不应被调用
      listSubAgents: () => { throw new Error('should use getSubAgents, not settingsStore.listSubAgents'); },
    },
    configManager: {
      ensureStores: async () => {},
      getRuntimeConfigByProfileId: async () => ({ provider: 'openai', model: 'm', apiKey: 'k' }),
    },
    isConfigReady: () => true,
    createClient: () => ({ chat: async () => 'ok' }),
    getSubAgents: () => ([
      { id: 's1', name: 'A', skills: ['x'], note: '', enabled: true, profileHint: '' },
      { id: 's2', name: 'B', skills: [], note: '', enabled: false, profileHint: '' },
    ]),
  });
  const runtime = await resolver();
  assert.equal(runtime.subAgents.length, 1);
  assert.equal(runtime.subAgents[0].id, 's1');
  console.log('ok - maid runtime config sources sub-agents from registry provider when supplied');
}

{
  const mainRuntime = {
    configured: true,
    profileId: 'maid-main',
    config: { provider: 'deepseek', model: 'main-model', apiKey: 'main-key' },
    client: { chat: async () => 'main' },
  };
  const resolver = createMaidMemoryExtractionRuntimeResolver({
    settingsStore: {
      getMemoryExtractionSettings: () => ({
        mode: 'follow_main',
        profileId: '',
        modelOverride: '',
        fallbackToMain: true,
      }),
    },
    resolveMainRuntime: async () => mainRuntime,
  });
  const runtime = await resolver();
  assert.equal(runtime.client, mainRuntime.client);
  assert.equal(runtime.memoryExtractionMode, 'follow_main');
  assert.equal(runtime.memoryExtractionModelSource, 'maid_main');
  assert.equal(runtime.extractionFallbackClient, null);
  console.log('ok - memory extraction follows the maid main model by default');
}

{
  const createdConfigs = [];
  const mainClient = { chat: async () => 'main' };
  const resolver = createMaidMemoryExtractionRuntimeResolver({
    settingsStore: {
      getMemoryExtractionSettings: () => ({
        mode: 'custom',
        profileId: 'memory-profile',
        modelOverride: 'memory-model-override',
        fallbackToMain: true,
      }),
    },
    configManager: {
      ensureStores: async () => {},
      getRuntimeConfigByProfileId: async profileId => ({
        provider: 'pioneer',
        model: `${profileId}-saved-model`,
        apiKey: 'memory-key',
        timeout: 900000,
      }),
    },
    resolveMainRuntime: async () => ({
      configured: true,
      profileId: 'maid-main',
      config: { provider: 'deepseek', model: 'main-model', apiKey: 'main-key' },
      client: mainClient,
    }),
    isConfigReady: config => Boolean(config?.apiKey),
    createClient: config => {
      createdConfigs.push(config);
      return { chat: async () => config.model };
    },
  });
  const runtime = await resolver();
  assert.equal(runtime.configured, true);
  assert.equal(runtime.profileId, 'memory-profile');
  assert.equal(runtime.config.model, 'memory-model-override');
  assert.equal(runtime.config.timeout, 240000);
  assert.equal(runtime.memoryExtractionMode, 'custom');
  assert.equal(runtime.memoryExtractionModelSource, 'custom');
  assert.equal(runtime.extractionFallbackClient, mainClient);
  assert.equal(createdConfigs.length, 1);
  console.log('ok - custom memory extraction resolves its own profile/model and exposes maid-main fallback');
}

{
  let mainResolveCount = 0;
  const resolver = createMaidMemoryExtractionRuntimeResolver({
    settingsStore: {
      getMemoryExtractionSettings: () => ({
        mode: 'custom',
        profileId: 'missing-profile',
        fallbackToMain: false,
      }),
    },
    configManager: {
      ensureStores: async () => {},
      getRuntimeConfigByProfileId: async () => null,
    },
    resolveMainRuntime: async () => {
      mainResolveCount += 1;
      return { configured: true, client: { chat: async () => 'main' } };
    },
  });
  const runtime = await resolver();
  assert.equal(runtime.configured, false);
  assert.equal(runtime.client, null);
  assert.equal(runtime.extractionFallbackClient, null);
  assert.equal(mainResolveCount, 0, '关闭兜底时不应解析或调用女仆主模型');
  console.log('ok - custom memory extraction can explicitly disable maid-main fallback');
}

{
  const mainClient = { chat: async () => 'main' };
  const resolver = createMaidMemoryExtractionRuntimeResolver({
    settingsStore: {
      getMemoryExtractionSettings: () => ({
        mode: 'custom',
        profileId: 'missing-profile',
        fallbackToMain: true,
      }),
    },
    configManager: {
      ensureStores: async () => {},
      getRuntimeConfigByProfileId: async () => null,
    },
    resolveMainRuntime: async () => ({
      configured: true,
      profileId: 'maid-main',
      config: { model: 'main-model' },
      client: mainClient,
    }),
  });
  const runtime = await resolver();
  assert.equal(runtime.configured, true);
  assert.equal(runtime.client, null);
  assert.equal(runtime.extractionFallbackClient, mainClient);
  console.log('ok - unavailable custom extraction can immediately use the enabled maid-main fallback');
}
