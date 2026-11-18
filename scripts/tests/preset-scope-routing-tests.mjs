import assert from 'node:assert/strict';

globalThis.localStorage ||= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.window ||= {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};

const {
  PRESET_APP_SCOPES,
  PresetStore,
  hasLegacyMigratedPresetBindings,
  isPresetEligibleForMode,
  migratePresetScopeState,
  normalizePresetAppScope,
} = await import('../../src/scripts/storage/preset-store.js');

const TYPES = ['sysprompt', 'context', 'instruct', 'openai', 'reasoning'];

const makeState = () => ({
  version: 1,
  presets: Object.fromEntries(TYPES.map(type => [type, {
    builtin: { name: `${type} builtin` },
    custom: { name: `${type} custom` },
  }])),
  active: Object.fromEntries(TYPES.map(type => [type, 'custom'])),
  enabled: Object.fromEntries(TYPES.map(type => [type, true])),
  bindings: {
    byType: {
      openai: {
        modes: { chat: 'builtin' },
      },
    },
  },
});

const makeBundledDefaults = () => Object.fromEntries(TYPES.map(type => [type, {
  builtin: { name: `${type} builtin` },
  addedLater: { name: `${type} added later` },
}]));

{
  const state = makeState();
  const migrated = migratePresetScopeState(state, {
    builtinActive: Object.fromEntries(TYPES.map(type => [type, 'builtin'])),
    existingInstall: true,
    now: () => 1234,
  });

  for (const type of TYPES) {
    assert.equal(migrated.presets[type].builtin.app_scope, PRESET_APP_SCOPES.all);
    assert.equal(migrated.presets[type].custom.app_scope, PRESET_APP_SCOPES.all);
    assert.equal(migrated.builtinActive[type], 'builtin');
    assert.equal(migrated.bindings.byType[type].modes.moments, 'custom');
    assert.equal(
      migrated.bindings.byType[type].modeBindingOrigins.moments,
      'legacy_migrated_mode_binding',
    );
  }
  assert.equal(migrated.bindings.byType.openai.modes.chat, 'builtin');
  assert.notEqual(
    migrated.bindings.byType.openai.modeBindingOrigins.chat,
    'legacy_migrated_mode_binding',
    'an existing mode binding must not be relabelled as a migration binding',
  );
  assert.deepEqual(migrated.bindings.migrations.presetScopeV1, {
    completed: true,
    migratedAt: 1234,
  });
  assert.equal(hasLegacyMigratedPresetBindings(migrated), true);

  const migratedStore = Object.create(PresetStore.prototype);
  migratedStore.state = migrated;
  migratedStore.ready = Promise.resolve(migrated);
  migratedStore.persist = async () => migratedStore.state;
  const legacyExpectedByMode = {
    chat: 'builtin',
    moments: state.active.openai,
    rp: state.active.openai,
  };
  for (const [mode, expectedPresetId] of Object.entries(legacyExpectedByMode)) {
    const sessionId = mode === 'rp' ? 'rp:migration-equivalence' : `migration-${mode}`;
    assert.equal(
      migratedStore.getResolvedActiveId('openai', { sessionId, uiMode: mode }).presetId,
      expectedPresetId,
      `migration must preserve legacy resolution for ${mode}`,
    );
  }
  const migratedMoments = migratedStore.getResolvedActiveId('openai', {
    sessionId: 'migration-moments',
    uiMode: 'moments',
  });
  assert.equal(migratedMoments.bindingOrigin, 'legacy_migrated_mode_binding');
  assert.equal(migratedMoments.hasCustomBinding, true);

  migrated.bindings.byType.openai.modes.moments = '';
  migrated.bindings.byType.openai.modeBindingOrigins.moments = 'cleared';
  const rerun = migratePresetScopeState(migrated, {
    builtinActive: Object.fromEntries(TYPES.map(type => [type, 'builtin'])),
    existingInstall: true,
    now: () => 9999,
  });
  assert.equal(rerun.bindings.byType.openai.modes.moments, '');
  assert.equal(rerun.bindings.byType.openai.modeBindingOrigins.moments, 'cleared');
  assert.equal(rerun.bindings.migrations.presetScopeV1.migratedAt, 1234);
  for (const type of TYPES) {
    for (const mode of ['chat', 'moments']) {
      rerun.bindings.byType[type].modes[mode] = '';
      rerun.bindings.byType[type].modeBindingOrigins[mode] = 'cleared';
    }
  }
  assert.equal(hasLegacyMigratedPresetBindings(rerun), false);
  console.log('ok - preset scope migration preserves behavior, existing bindings, and cleared idempotent state');
}

{
  assert.equal(normalizePresetAppScope(undefined), PRESET_APP_SCOPES.creative);
  assert.equal(isPresetEligibleForMode({}, 'rp'), true);
  assert.equal(isPresetEligibleForMode({}, 'chat'), false);
  assert.equal(isPresetEligibleForMode({ app_scope: 'creative' }, 'rp'), true);
  assert.equal(isPresetEligibleForMode({ app_scope: 'creative' }, 'chat'), false);
  assert.equal(isPresetEligibleForMode({ app_scope: 'chat' }, 'moments'), true);
  assert.equal(isPresetEligibleForMode({ app_scope: 'chat' }, 'rp'), false);
  assert.equal(isPresetEligibleForMode({ app_scope: 'all' }, 'chat'), true);
  console.log('ok - preset scope eligibility separates creative and chat surfaces');
}

{
  const freshStore = Object.create(PresetStore.prototype);
  freshStore.state = null;
  freshStore.isLoaded = false;
  freshStore.persistedItemSignatures = new Map();
  freshStore.loadShardedState = async () => ({ state: null, skipPersistOnLoad: false });
  freshStore.loadBundledDefaults = async () => makeBundledDefaults();
  freshStore.persist = async (next) => {
    freshStore.state = next;
    return next;
  };

  const freshState = await freshStore.load();
  for (const type of TYPES) {
    assert.equal(freshState.presets[type].builtin.app_scope, PRESET_APP_SCOPES.creative);
    assert.equal(freshState.presets[type].addedLater.app_scope, PRESET_APP_SCOPES.creative);
  }

  const existingState = migratePresetScopeState(makeState(), {
    builtinActive: Object.fromEntries(TYPES.map(type => [type, 'builtin'])),
    existingInstall: true,
  });
  const upgradedStore = Object.create(PresetStore.prototype);
  upgradedStore.state = null;
  upgradedStore.isLoaded = false;
  upgradedStore.persistedItemSignatures = new Map();
  upgradedStore.loadShardedState = async () => ({ state: existingState, skipPersistOnLoad: false });
  upgradedStore.loadBundledDefaults = async () => makeBundledDefaults();
  upgradedStore.persist = async (next) => {
    upgradedStore.state = next;
    return next;
  };

  const upgradedState = await upgradedStore.load();
  for (const type of TYPES) {
    assert.equal(upgradedState.presets[type].custom.app_scope, PRESET_APP_SCOPES.all);
    assert.equal(upgradedState.presets[type].addedLater.app_scope, PRESET_APP_SCOPES.creative);
  }
  console.log('ok - fresh and newly bundled presets default to creative without rewriting legacy scopes');
}

{
  const store = Object.create(PresetStore.prototype);
  store.state = migratePresetScopeState(makeState(), {
    builtinActive: Object.fromEntries(TYPES.map(type => [type, 'builtin'])),
    existingInstall: false,
  });
  store.isLoaded = true;
  store.ready = Promise.resolve(store.state);
  store.persist = async () => store.state;

  store.state.presets.openai.builtin.app_scope = 'all';
  store.state.presets.openai.custom.app_scope = 'all';
  store.state.bindings.byType.openai.modes.chat = '';
  store.state.bindings.byType.openai.modeBindingOrigins.chat = 'cleared';

  const chatDefault = store.getResolvedActiveId('openai', { sessionId: 'alice', uiMode: 'chat' });
  assert.equal(chatDefault.presetId, 'builtin');
  assert.equal(chatDefault.source, 'builtin');
  assert.equal(chatDefault.isBuiltinDefault, true);
  assert.equal(chatDefault.hasCustomBinding, false);

  const creativeDefault = store.getResolvedActiveId('openai', { sessionId: 'rp:hero', uiMode: 'rp' });
  assert.equal(creativeDefault.presetId, 'custom');
  assert.equal(creativeDefault.source, 'global');

  await store.setSessionBinding('openai', 'alice', 'custom');
  const chatCustom = store.getResolvedActiveId('openai', { sessionId: 'alice', uiMode: 'chat' });
  assert.equal(chatCustom.presetId, 'custom');
  assert.equal(chatCustom.source, 'session');
  assert.equal(chatCustom.hasCustomBinding, true);

  store.state.presets.openai.custom.app_scope = 'creative';
  await store.clearSessionBinding('openai', 'alice');
  await store.setModeBinding('openai', 'chat', 'custom');
  assert.equal(store.getModeBindingId('openai', 'chat'), null, 'an ineligible preset must not bind to chat');

  const importedId = await store.upsert('openai', {
    id: 'imported',
    name: 'Imported preset',
    data: { name: 'Imported preset' },
    appScope: 'creative',
    makeActive: true,
  });
  assert.equal(store.state.presets.openai[importedId].app_scope, 'creative');
  assert.equal(store.getResolvedActiveId('openai', { sessionId: 'alice', uiMode: 'chat' }).presetId, 'builtin');
  assert.equal(store.getModeBindingId('openai', 'chat'), null);

  const firstDefaultId = await store.upsert('openai', {
    id: 'default-scope-a',
    name: 'Default scope A',
    data: { name: 'Default scope A' },
    makeActive: false,
  });
  const secondDefaultId = await store.upsert('openai', {
    id: 'default-scope-b',
    name: 'Default scope B',
    data: { name: 'Default scope B' },
    makeActive: false,
  });
  assert.equal(store.state.presets.openai[firstDefaultId].app_scope, PRESET_APP_SCOPES.creative);
  assert.equal(store.state.presets.openai[secondDefaultId].app_scope, PRESET_APP_SCOPES.creative);

  await store.setPresetAppScope('openai', firstDefaultId, PRESET_APP_SCOPES.chat);
  await store.setPresetAppScope('openai', secondDefaultId, PRESET_APP_SCOPES.all);
  assert.equal(store.state.presets.openai[firstDefaultId].app_scope, PRESET_APP_SCOPES.chat);
  assert.equal(store.state.presets.openai[secondDefaultId].app_scope, PRESET_APP_SCOPES.all);
  console.log('ok - chat resolution never falls through creative global active and imports create no chat binding');
  console.log('ok - new presets default to creative and persist scope independently');
}

{
  // 全新安装：内置预设一律是「创意写作」适用范围。聊天模式没有绑定时仍要用内置默认（选单上的「内置默认（X）」），
  // 不能因适用范围解析成空：否则群聊规则（群名、成员）与对话规则都不会注入，模型自编群名，整轮被丢。
  const store = Object.create(PresetStore.prototype);
  store.state = migratePresetScopeState(makeState(), {
    builtinActive: Object.fromEntries(TYPES.map(type => [type, 'builtin'])),
    existingInstall: false,
  });
  store.isLoaded = true;
  store.ready = Promise.resolve(store.state);
  store.persist = async () => store.state;
  for (const type of TYPES) {
    store.state.presets[type].builtin.app_scope = PRESET_APP_SCOPES.creative;
    store.state.presets[type].custom.app_scope = PRESET_APP_SCOPES.creative;
  }

  const chat = store.getResolvedActiveId('sysprompt', { sessionId: 'alice', uiMode: 'chat' });
  assert.deepEqual([chat.presetId, chat.source, chat.isBuiltinDefault], ['builtin', 'builtin', true]);
  assert.equal(store.getResolvedActive('sysprompt', { sessionId: 'alice', uiMode: 'chat' }).preset?.name, 'sysprompt builtin');

  // 用户选的（会话绑定）照旧检查适用范围：绑一个只适用创意写作的预设，聊天模式不会用它，退回内置默认
  store.state.bindings.byType.sysprompt = { ...(store.state.bindings.byType.sysprompt || {}), sessions: { alice: 'custom' } };
  assert.equal(store.getResolvedActiveId('sysprompt', { sessionId: 'alice', uiMode: 'chat' }).presetId, 'builtin');
  // 创意写作照旧走全局当前预设
  assert.equal(store.getResolvedActiveId('sysprompt', { sessionId: 'rp:hero', uiMode: 'rp' }).presetId, 'custom');
  console.log('ok - a fresh install still uses the built-in default in chat mode while user choices keep their scope');
}

console.log('preset-scope-routing-tests passed');
