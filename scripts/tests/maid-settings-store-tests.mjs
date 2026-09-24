import assert from 'node:assert/strict';

import {
  MAID_SETTINGS_STORE_KEY,
  MAID_REACT_STEP_LIMIT_DEFAULT,
  MAID_REACT_STEP_LIMIT_MIN,
  MAID_REACT_STEP_LIMIT_MAX,
  MaidSettingsStore,
  normalizeMaidReactStepLimit,
  normalizeMaidSettingsState,
} from '../../src/scripts/storage/maid-settings-store.js';
import { DEFAULT_MAID_PROMPT } from '../../src/scripts/agent/maid-prompt-defaults.js';

const createStorage = () => {
  const backing = new Map();
  return {
    backing,
    getItem: key => backing.get(String(key)) ?? null,
    setItem: (key, value) => {
      backing.set(String(key), String(value));
    },
    removeItem: key => {
      backing.delete(String(key));
    },
  };
};

{
  const state = normalizeMaidSettingsState({
    boundProfileId: ' profile-a ',
    maidPrompt: ' maid ',
    memoryExtractionMode: ' custom ',
    memoryExtractionProfileId: ' memory-profile ',
    memoryExtractionModelOverride: ' memory-model ',
    memoryExtractionFallbackToMain: false,
    updatedAt: 10,
  });
  assert.equal(state.boundProfileId, 'profile-a');
  assert.equal(state.maidPrompt, 'maid');
  assert.equal(state.personaPrompt, 'maid');
  assert.deepEqual(state.memoryExtraction, {
    mode: 'custom',
    profileId: 'memory-profile',
    modelOverride: 'memory-model',
    fallbackToMain: false,
  });
  assert.equal(state.updatedAt, 10);
  console.log('ok - maid settings state normalizes binding and persona');
}

{
  const state = normalizeMaidSettingsState({});
  assert.equal(state.maidPrompt, DEFAULT_MAID_PROMPT);
  assert.equal(state.personaPrompt, DEFAULT_MAID_PROMPT);
  assert.deepEqual(state.memoryExtraction, {
    mode: 'follow_main',
    profileId: '',
    modelOverride: '',
    fallbackToMain: false,
  });
  console.log('ok - maid settings state exposes current default maid prompt');
}

{
  let now = 1000;
  const storage = createStorage();
  const kv = new Map();
  const store = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => now,
  });
  await store.load();
  assert.equal(store.getBoundProfileId(), '');
  await store.savePatch({
    boundProfileId: 'profile-a',
    maidPrompt: '稳重女仆',
  });
  store.setLastExchange({
    requestPrompt: 'system:\nsecret prompt',
    appContext: '检索：已执行',
    fullResponse: 'raw response',
    source: 'test',
  });
  await store.setPersonaPrompt('稳重女仆 2');
  await store.setMemoryExtractionSettings({
    mode: 'custom',
    profileId: 'profile-memory',
    modelOverride: 'deepseek-v4-flash',
    fallbackToMain: false,
  });
  assert.match(storage.backing.get(MAID_SETTINGS_STORE_KEY), /profile-a/);
  assert.match(storage.backing.get(MAID_SETTINGS_STORE_KEY), /secret prompt/);
  assert.match(storage.backing.get(MAID_SETTINGS_STORE_KEY), /检索：已执行/);
  assert.match(storage.backing.get(MAID_SETTINGS_STORE_KEY), /raw response/);
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).boundProfileId, 'profile-a');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).maidPrompt, '稳重女仆 2');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).personaPrompt, undefined);
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).memoryExtractionMode, 'custom');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).memoryExtractionProfileId, 'profile-memory');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).memoryExtractionModelOverride, 'deepseek-v4-flash');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).memoryExtractionFallbackToMain, false);
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).lastRequestPrompt, 'system:\nsecret prompt');
  assert.equal(store.getLastRequestPrompt(), 'system:\nsecret prompt');
  assert.equal(store.getLastAppContext(), '检索：已执行');
  assert.equal(store.getLastFullResponse(), 'raw response');

  now = 1200;
  const restored = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => now,
  });
  await restored.load();
  assert.equal(restored.getBoundProfileId(), 'profile-a');
  assert.equal(restored.getMaidPrompt(), '稳重女仆 2');
  assert.equal(restored.getPersonaPrompt(), '稳重女仆 2');
  assert.equal(restored.getLastRequestPrompt(), 'system:\nsecret prompt');
  assert.equal(restored.getLastAppContext(), '检索：已执行');
  assert.equal(restored.getLastFullResponse(), 'raw response');
  assert.deepEqual(restored.getMemoryExtractionSettings(), {
    mode: 'custom',
    profileId: 'profile-memory',
    modelOverride: 'deepseek-v4-flash',
    fallbackToMain: false,
  });
  console.log('ok - MaidSettingsStore persists explicit maid binding and debug exchange to KV and local backup');
}

{
  const storage = createStorage();
  const kv = new Map([
    [MAID_SETTINGS_STORE_KEY, {
      version: 1,
      updatedAt: 3000,
      boundProfileId: 'profile-kv',
      maidPrompt: 'kv maid',
    }],
  ]);
  storage.setItem(MAID_SETTINGS_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 2000,
    boundProfileId: 'profile-local',
    maidPrompt: 'local maid',
  }));
  const restored = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => 4000,
  });
  await restored.load();
  assert.equal(restored.getBoundProfileId(), 'profile-kv');
  assert.equal(restored.getMaidPrompt(), 'kv maid');
  assert.match(storage.backing.get(MAID_SETTINGS_STORE_KEY), /profile-kv/);
  console.log('ok - MaidSettingsStore restores newer KV binding over local backup');
}

{
  const storage = createStorage();
  const kv = new Map();
  storage.setItem(MAID_SETTINGS_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 5000,
    boundProfileId: 'profile-local-only',
    personaPrompt: 'legacy local',
  }));
  const restored = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => 6000,
  });
  await restored.load();
  assert.equal(restored.getBoundProfileId(), 'profile-local-only');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).boundProfileId, 'profile-local-only');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).maidPrompt, 'legacy local');
  console.log('ok - MaidSettingsStore migrates local-only binding into KV');
}

{
  const storage = createStorage();
  const kv = new Map([
    [MAID_SETTINGS_STORE_KEY, {
      version: 1,
      updatedAt: 8000,
      boundProfileId: '',
      maidPrompt: 'new prompt only',
    }],
  ]);
  storage.setItem(MAID_SETTINGS_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 7000,
    boundProfileId: 'profile-local-bound',
  }));
  const restored = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => 9000,
  });
  await restored.load();
  assert.equal(restored.getBoundProfileId(), 'profile-local-bound');
  assert.equal(restored.getMaidPrompt(), 'new prompt only');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).boundProfileId, 'profile-local-bound');
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).maidPrompt, 'new prompt only');
  console.log('ok - MaidSettingsStore merges prompt-only KV with older local binding');
}

{
  // 执行步数上限：归一化、持久化与 KV/local 双源恢复
  assert.equal(normalizeMaidReactStepLimit(undefined), MAID_REACT_STEP_LIMIT_DEFAULT);
  assert.equal(normalizeMaidReactStepLimit(null), MAID_REACT_STEP_LIMIT_DEFAULT);
  assert.equal(normalizeMaidReactStepLimit(''), MAID_REACT_STEP_LIMIT_DEFAULT);
  assert.equal(normalizeMaidReactStepLimit('abc'), MAID_REACT_STEP_LIMIT_DEFAULT);
  assert.equal(normalizeMaidReactStepLimit(0), MAID_REACT_STEP_LIMIT_DEFAULT);
  assert.equal(normalizeMaidReactStepLimit(3), MAID_REACT_STEP_LIMIT_MIN);
  assert.equal(normalizeMaidReactStepLimit(999), MAID_REACT_STEP_LIMIT_MAX);
  assert.equal(normalizeMaidReactStepLimit(60.9), 60);

  let now = 5000;
  const storage = createStorage();
  const kv = new Map();
  const store = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => now,
  });
  await store.load();
  assert.equal(store.getMaxReactSteps(), MAID_REACT_STEP_LIMIT_DEFAULT);
  await store.savePatch({ boundProfileId: 'profile-steps' });
  await store.setMaxReactSteps(64);
  assert.equal(store.getMaxReactSteps(), 64);
  assert.equal(kv.get(MAID_SETTINGS_STORE_KEY).maxReactSteps, 64);

  now = 5200;
  const restored = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    now: () => now,
  });
  await restored.load();
  assert.equal(restored.getMaxReactSteps(), 64, 'load 合并列表必须保留 maxReactSteps，不得回落默认值');
  // 语音任务执行方式：未选时按语音执行；选过后跨重载保留
  assert.equal(restored.hasChosenVoiceTaskExecutor(), false);
  assert.equal(restored.getVoiceTaskExecutor(), 'voice');
  await restored.setVoiceTaskExecutor('maid');
  // 女仆思考设置：默认不开（强度预设为低），修改后跨重载保留
  assert.deepEqual(restored.getGenerationSettings(), { reasoningMode: 'off', reasoningEffort: 'low' });
  await restored.setGenerationSettings({ reasoningMode: 'on' });
  await restored.setGenerationSettings({ reasoningEffort: 'medium' });
  await restored.setGenerationSettings({ reasoningMode: 'bogus' });
  assert.deepEqual(restored.getGenerationSettings(), { reasoningMode: 'off', reasoningEffort: 'medium' }, 'unknown modes fall back to off');
  await restored.setGenerationSettings({ reasoningMode: 'on' });
  now = 5400;
  const reloaded = new MaidSettingsStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => { kv.set(key, JSON.parse(JSON.stringify(value))); },
    now: () => now,
  });
  await reloaded.load();
  assert.equal(reloaded.hasChosenVoiceTaskExecutor(), true, 'load 合并列表必须保留 voiceTaskExecutor');
  assert.equal(reloaded.getVoiceTaskExecutor(), 'maid');
  assert.deepEqual(reloaded.getGenerationSettings(), { reasoningMode: 'on', reasoningEffort: 'medium' }, 'load 合并列表必须保留 generation');
  console.log('ok - MaidSettingsStore normalizes and persists the react step limit across reloads');
}
