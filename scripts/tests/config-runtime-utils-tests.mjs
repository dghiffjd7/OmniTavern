import assert from 'node:assert/strict';
import {
  createConfigRuntimeAdapter,
  createConfigProfile,
  ensureConfigStores,
  getActiveConfigProfile,
  getActiveConfigProfileId,
  getBridgeConfig,
  getConfigProfileById,
  getConfigProfiles,
  isBridgeConfigured,
  loadBridgeConfig,
  reloadBridgeConfig,
  resolveConfigRuntimeBridge,
  setActiveConfigProfile,
  syncChatRuntimeConfigToBridge,
} from '../../src/scripts/ui/config-runtime-utils.js';
import {
  applyGenerationParamFilter,
  normalizeGenerationParamFilterList,
  splitGenerationParamFilterInput,
} from '../../src/scripts/utils/generation-param-filter-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('resolveConfigRuntimeBridge binds explicit config runtime methods', () => {
  const bridge = {
    config: { id: 'config-manager' },
    marker: 'bridge-marker',
    getConfig() {
      return { marker: this.marker };
    },
    loadConfig() {
      return { loaded: this.marker };
    },
    reloadConfig() {
      return { reloaded: this.marker };
    },
    ensureConfigStores() {
      return `ensured:${this.marker}`;
    },
    getConfigProfiles() {
      return [{ id: this.marker }];
    },
    getConfigProfileById(id) {
      return { id, marker: this.marker };
    },
    getActiveConfigProfile() {
      return { active: this.marker };
    },
    getActiveConfigProfileId() {
      return this.marker;
    },
    setActiveConfigProfile(id) {
      return { id, marker: this.marker };
    },
    createConfigProfile(name, config) {
      return { name, config, marker: this.marker };
    },
    setChatRuntimeConfig(config) {
      return { configured: config.enabled === true };
    },
    isConfigured() {
      return this.marker === 'bridge-marker';
    },
  };
  const context = resolveConfigRuntimeBridge({ bridge });
  assert.equal(context.configManager.id, 'config-manager');
  assert.deepEqual(context.getConfig(), { marker: 'bridge-marker' });
  assert.deepEqual(context.loadConfig(), { loaded: 'bridge-marker' });
  assert.deepEqual(context.reloadConfig(), { reloaded: 'bridge-marker' });
  assert.equal(context.ensureConfigStores(), 'ensured:bridge-marker');
  assert.deepEqual(context.getConfigProfiles(), [{ id: 'bridge-marker' }]);
  assert.deepEqual(context.getConfigProfileById('p1'), { id: 'p1', marker: 'bridge-marker' });
  assert.deepEqual(context.getActiveConfigProfile(), { active: 'bridge-marker' });
  assert.equal(context.getActiveConfigProfileId(), 'bridge-marker');
  assert.deepEqual(context.setActiveConfigProfile('p2'), { id: 'p2', marker: 'bridge-marker' });
  assert.deepEqual(context.createConfigProfile('New', { provider: 'openai' }), {
    name: 'New',
    config: { provider: 'openai' },
    marker: 'bridge-marker',
  });
  assert.deepEqual(context.setChatRuntimeConfig({ enabled: true }), { configured: true });
  assert.equal(context.isConfigured(), true);
});

test('getBridgeConfig and loadBridgeConfig prefer contract methods with config fallback', async () => {
  const contractBridge = {
    getConfig: () => ({ provider: 'contract' }),
    loadConfig: async () => ({ provider: 'loaded-contract' }),
  };
  const fallbackBridge = {
    config: {
      loaded: false,
      get() {
        return { provider: this.loaded ? 'loaded-fallback' : 'fallback' };
      },
      async load() {
        this.loaded = true;
        return { provider: 'raw-load' };
      },
    },
  };
  assert.deepEqual(getBridgeConfig(contractBridge), { provider: 'contract' });
  assert.deepEqual(await loadBridgeConfig(contractBridge), { provider: 'loaded-contract' });
  assert.deepEqual(getBridgeConfig(fallbackBridge), { provider: 'fallback' });
  assert.deepEqual(await loadBridgeConfig(fallbackBridge), { provider: 'loaded-fallback' });
});

test('reloadBridgeConfig uses contract method or config manager fallback', async () => {
  const contractBridge = {
    reloadConfig: async () => ({ provider: 'contract' }),
  };
  const fallbackBridge = {
    config: {
      async reload() {
        return { provider: 'fallback' };
      },
    },
  };
  assert.deepEqual(await reloadBridgeConfig(contractBridge), { provider: 'contract' });
  assert.deepEqual(await reloadBridgeConfig(fallbackBridge), { provider: 'fallback' });
});

test('profile helpers prefer contract methods with config manager fallback', async () => {
  const contractBridge = {
    ensureConfigStores: async () => 'contract-ready',
    getConfigProfiles: () => [{ id: 'contract' }],
    getConfigProfileById: id => ({ id, source: 'contract' }),
    getActiveConfigProfile: () => ({ id: 'active-contract' }),
    getActiveConfigProfileId: () => 'active-contract',
    setActiveConfigProfile: async id => ({ id, source: 'contract-set' }),
    createConfigProfile: async (name, config) => ({ name, config, source: 'contract-create' }),
  };
  const fallbackBridge = {
    config: {
      ensured: false,
      async ensureStores() {
        this.ensured = true;
        return 'fallback-ready';
      },
      getProfiles: () => [{ id: 'fallback' }],
      getProfileById: id => ({ id, source: 'fallback' }),
      getActiveProfile: () => ({ id: 'active-fallback' }),
      getActiveProfileId: () => 'active-fallback',
      setActiveProfile: async id => ({ id, source: 'fallback-set' }),
      createProfile: async (name, config) => ({ name, config, source: 'fallback-create' }),
    },
  };
  assert.equal(await ensureConfigStores(contractBridge), 'contract-ready');
  assert.deepEqual(getConfigProfiles(contractBridge), [{ id: 'contract' }]);
  assert.deepEqual(getConfigProfileById(contractBridge, 'p1'), { id: 'p1', source: 'contract' });
  assert.deepEqual(getActiveConfigProfile(contractBridge), { id: 'active-contract' });
  assert.equal(getActiveConfigProfileId(contractBridge), 'active-contract');
  assert.deepEqual(await setActiveConfigProfile(contractBridge, 'p2'), { id: 'p2', source: 'contract-set' });
  assert.deepEqual(await createConfigProfile(contractBridge, 'New', { model: 'm' }), {
    name: 'New',
    config: { model: 'm' },
    source: 'contract-create',
  });
  assert.equal(await ensureConfigStores(fallbackBridge), 'fallback-ready');
  assert.deepEqual(getConfigProfiles(fallbackBridge), [{ id: 'fallback' }]);
  assert.deepEqual(getConfigProfileById(fallbackBridge, 'p1'), { id: 'p1', source: 'fallback' });
  assert.deepEqual(getActiveConfigProfile(fallbackBridge), { id: 'active-fallback' });
  assert.equal(getActiveConfigProfileId(fallbackBridge), 'active-fallback');
  assert.deepEqual(await setActiveConfigProfile(fallbackBridge, 'p2'), { id: 'p2', source: 'fallback-set' });
  assert.deepEqual(await createConfigProfile(fallbackBridge, 'New', { model: 'm' }), {
    name: 'New',
    config: { model: 'm' },
    source: 'fallback-create',
  });
});

test('createConfigRuntimeAdapter exposes config manager compatible surface', async () => {
  const bridge = {
    getConfig: () => ({ provider: 'openai' }),
    loadConfig: async () => ({ provider: 'loaded' }),
    reloadConfig: async () => ({ provider: 'reloaded' }),
    getConfigProfiles: () => [{ id: 'p1' }],
    getConfigProfileById: id => ({ id }),
    getActiveConfigProfile: () => ({ id: 'active' }),
    getActiveConfigProfileId: () => 'active',
    setActiveConfigProfile: async id => ({ id, active: true }),
    createConfigProfile: async (name, config) => ({ id: 'created', name, config }),
  };
  const adapter = createConfigRuntimeAdapter(bridge);
  assert.deepEqual(adapter.get(), { provider: 'openai' });
  assert.deepEqual(await adapter.load(), { provider: 'loaded' });
  assert.deepEqual(await adapter.reload(), { provider: 'reloaded' });
  assert.deepEqual(adapter.getProfiles(), [{ id: 'p1' }]);
  assert.deepEqual(adapter.getProfileById('p2'), { id: 'p2' });
  assert.deepEqual(adapter.getActiveProfile(), { id: 'active' });
  assert.equal(adapter.getActiveProfileId(), 'active');
  assert.deepEqual(await adapter.setActiveProfile('p2'), { id: 'p2', active: true });
  assert.deepEqual(await adapter.createProfile('New', { provider: 'custom' }), {
    id: 'created',
    name: 'New',
    config: { provider: 'custom' },
  });
});

test('syncChatRuntimeConfigToBridge uses contract method when available', () => {
  const calls = [];
  const bridge = {
    setChatRuntimeConfig(config) {
      calls.push(config);
      return { ok: true, configured: true, clientReady: true };
    },
  };
  const result = syncChatRuntimeConfigToBridge({
    bridge,
    runtime: { provider: 'openai' },
  });
  assert.deepEqual(calls, [{ provider: 'openai' }]);
  assert.deepEqual(result, { ok: true, configured: true, clientReady: true });
});

test('isBridgeConfigured prefers contract method and defaults to configured', () => {
  assert.equal(isBridgeConfigured({ isConfigured: () => false }), false);
  assert.equal(isBridgeConfigured({ isConfigured: () => true }), true);
  assert.equal(isBridgeConfigured({}), true);
});

test('generation parameter filter normalizes names and removes selected request fields', () => {
  assert.deepEqual(
    splitGenerationParamFilterInput('temperature, top_p；bad/name\nstop'),
    ['temperature', 'top_p', 'stop']
  );
  assert.deepEqual(
    normalizeGenerationParamFilterList(['temperature', 'top_p', 'temperature', 'bad name', '_custom.param']),
    ['temperature', 'top_p', '_custom.param']
  );
  assert.deepEqual(
    applyGenerationParamFilter(
      { temperature: 1, top_p: 0.9, signal: 'keep', stop: ['x'] },
      ['temperature', 'stop', 'signal'],
      { protectedParams: ['signal'] }
    ),
    { top_p: 0.9, signal: 'keep' }
  );
});

test('syncChatRuntimeConfigToBridge fallback writes config and client', () => {
  const stored = [];
  const bridge = {
    config: {
      set: config => stored.push(config),
    },
    client: null,
  };
  const result = syncChatRuntimeConfigToBridge({
    bridge,
    runtime: { provider: 'openai', apiKey: 'k' },
    canInitClient: config => Boolean(config.apiKey),
    createClient: config => ({ provider: config.provider }),
  });
  assert.deepEqual(stored, [{ provider: 'openai', apiKey: 'k' }]);
  assert.deepEqual(bridge.client, { provider: 'openai' });
  assert.deepEqual(result, { ok: true, configured: true, clientReady: true });
});

test('ConfigManager stores excluded generation params per active profile', async () => {
  const previousStorage = globalThis.localStorage;
  const previousTauri = globalThis.__TAURI__;
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd) => {
        if (cmd === 'save_kv') return true;
        return null;
      },
    },
  };

  try {
    const { ConfigManager } = await import('../../src/scripts/storage/config.js');
    const manager = new ConfigManager({ scope: `param_filter_${Date.now()}` });
    const filtered = await manager.createProfile('Filtered', {
      provider: 'custom',
      baseUrl: 'https://example.com/v1',
      model: 'pioneer-model',
      excludedGenerationParams: ['temperature', 'top_p', 'bad name', 'stop', 'temperature'],
    });
    assert.deepEqual(manager.get().excludedGenerationParams, ['temperature', 'top_p', 'stop']);

    const unfiltered = await manager.createProfile('Unfiltered', {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
    assert.deepEqual(manager.get().excludedGenerationParams, []);

    await manager.setActiveProfile(filtered.id);
    assert.deepEqual(manager.get().excludedGenerationParams, ['temperature', 'top_p', 'stop']);

    await manager.save({
      provider: 'custom',
      baseUrl: 'https://example.com/v1',
      model: 'pioneer-model',
      stream: true,
      excludedGenerationParams: ['presence_penalty'],
    });
    assert.deepEqual(manager.get().excludedGenerationParams, ['presence_penalty']);

    await manager.setActiveProfile(unfiltered.id);
    assert.deepEqual(manager.get().excludedGenerationParams, []);
  } finally {
    if (previousStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
    if (previousTauri === undefined) {
      delete globalThis.__TAURI__;
    } else {
      globalThis.__TAURI__ = previousTauri;
    }
  }
});

test('ConfigManager treats profile backup quota as non-fatal after Tauri KV save', async () => {
  const previousStorage = globalThis.localStorage;
  const previousTauri = globalThis.__TAURI__;
  const calls = [];
  globalThis.localStorage = {
    getItem: () => null,
    setItem: (key) => {
      calls.push(['setItem', key]);
      const err = new Error('quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: key => calls.push(['removeItem', key]),
  };
  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args?.name]);
        return true;
      },
    },
  };
  try {
    const { ConfigManager } = await import('../../src/scripts/storage/config.js');
    const manager = new ConfigManager();
    await manager.persistProfiles({
      activeProfileId: 'profile-a',
      profiles: {
        'profile-a': {
          id: 'profile-a',
          name: 'A',
          provider: 'custom',
        },
      },
      savedAt: 1,
    });
    assert.deepEqual(calls[0], ['save_kv', 'llm_profiles_v1']);
    assert.deepEqual(calls[1], ['setItem', 'llm_profiles_v1']);
    assert.deepEqual(calls[2], ['removeItem', 'llm_profiles_v1']);
  } finally {
    if (previousStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
    if (previousTauri === undefined) {
      delete globalThis.__TAURI__;
    } else {
      globalThis.__TAURI__ = previousTauri;
    }
  }
});

test('profile listing during creation preserves the active editor and its populated choices', async () => {
  const previous = { storage: globalThis.localStorage, tauri: globalThis.__TAURI__, document: globalThis.document, window: globalThis.window, prompt: globalThis.prompt };
  let release;
  const pendingRead = new Promise(resolve => { release = resolve; });
  const calls = [];
  const local = new Map();
  globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
  globalThis.window = {};
  globalThis.prompt = () => '111';
  try {
    const [{ ConfigManager }, { ConfigPanel }] = await Promise.all([
      import('../../src/scripts/storage/config.js'),
      import('../../src/scripts/ui/config-panel.js'),
    ]);
    const manager = new ConfigManager();
    const original = { ...manager.getDefault(), id: 'original', name: '默认', updatedAt: 1 };
    manager.profileStore = { activeProfileId: original.id, profiles: { [original.id]: original }, savedAt: 1 };
    manager.keyringStore = { keysByProfile: {} };
    manager.storesEnsured = true;
    manager.config = original;
    manager.isLoaded = true;
    const oldDiskSnapshot = structuredClone(manager.profileStore);
    const originalStore = manager.profileStore;
    globalThis.__TAURI__ = { core: { invoke: async (command, args) => {
      calls.push([command, args.name]);
      await pendingRead;
      return oldDiskSnapshot;
    } } };
    // Model the same overlapping read as the status chip, with storage delayed
    // until after the user has finished creating their new profile.
    const listing = manager.readProfileSnapshot();
    assert.equal(manager.profileStore, originalStore);
    assert.equal(manager.config, original);
    manager.persistProfiles = async () => {
      local.set(manager.profileStoreKey, JSON.stringify(manager.profileStore));
    };
    const options = [];
    const select = { id: 'config-profile', value: '', options, appendChild: option => options.push(option) };
    Object.defineProperty(select, 'innerHTML', { set: () => { options.length = 0; select.value = ''; } });
    globalThis.document = { createElement: () => ({}) };
    const panel = Object.create(ConfigPanel.prototype);
    panel.configManager = manager;
    panel.element = { querySelector: selector => selector === '#config-profile' ? select : null };
    panel.refreshCustomSelect = () => {};
    panel.populateForm = () => panel.refreshProfileOptions();
    panel.syncActiveProfileRuntime = async () => {};
    panel.emitProfileChanged = () => {};
    await panel.createProfile();
    const createdId = manager.getActiveProfileId();
    const createdRuntime = manager.get();
    assert.equal(manager.getActiveProfile().name, '111');
    assert.equal(select.value, createdId);
    assert.deepEqual(options.map(option => option.textContent), ['111', '默认']);
    release();
    const snapshot = await listing;
    assert.equal(snapshot.activeId, createdId);
    assert.equal(snapshot.profiles[0].name, '111');
    assert.equal(manager.getActiveProfileId(), createdId);
    assert.equal(manager.get(), createdRuntime);
    assert.equal(select.value, createdId);
    assert.equal(options.length, 2);
    snapshot.profiles[0].name = 'changed snapshot';
    assert.equal(manager.getActiveProfile().name, '111');
    assert.deepEqual(calls, [['load_kv', 'llm_profiles_v1']]);
  } finally {
    release();
    for (const [key, value] of Object.entries({ localStorage: previous.storage, __TAURI__: previous.tauri, document: previous.document, window: previous.window, prompt: previous.prompt })) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('profile snapshots see external changes and scoped backups without replacing cached config or loading credentials', async () => {
  const previousStorage = globalThis.localStorage;
  const previousTauri = globalThis.__TAURI__;
  const reads = [];
  const local = new Map();
  globalThis.localStorage = { getItem: key => local.get(key) ?? null };
  const saved = { activeProfileId: 'external', savedAt: 20, profiles: { external: { id: 'external', name: '外部更新', updatedAt: 20 } } };
  let fromKv = saved;
  globalThis.__TAURI__ = { core: { invoke: async (command, args) => { reads.push([command, args.name]); return fromKv; } } };
  try {
    const { ConfigManager } = await import('../../src/scripts/storage/config.js');
    const manager = new ConfigManager({ scope: 'image' });
    manager.profileStore = { activeProfileId: 'old', profiles: { old: { id: 'old', name: '编辑中的设置档' } } };
    manager.config = { model: 'unsaved-model' };
    const beforeStore = manager.profileStore;
    const beforeConfig = manager.config;
    assert.equal((await manager.readProfileSnapshot()).profiles[0].name, '外部更新');
    fromKv = { _tooLarge: true };
    local.set('llm_profiles_image_v1', JSON.stringify(saved));
    assert.equal((await manager.readProfileSnapshot()).activeId, 'external');
    local.clear();
    assert.equal((await manager.readProfileSnapshot()).activeId, 'old');
    assert.equal(manager.profileStore, beforeStore);
    assert.equal(manager.config, beforeConfig);
    assert.deepEqual(reads, Array.from({ length: 3 }, () => ['load_kv', 'llm_profiles_image_v1']));
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
    if (previousTauri === undefined) delete globalThis.__TAURI__; else globalThis.__TAURI__ = previousTauri;
  }
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

if (failed > 0) {
  process.exit(1);
}
