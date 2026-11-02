import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
};
globalThis.window = globalThis.window || {
  dispatchEvent: () => true,
};

const { ScriptStore, fillDeclaredScriptButtons } = await import('../../src/scripts/storage/script-store.js');
const { SCRIPT_COMPATIBILITY_VERSION } = await import('../../src/scripts/import/script-capability-preflight.js');

const makeStore = (state) => {
  const store = Object.create(ScriptStore.prototype);
  store.state = structuredClone(state);
  store.persistCount = 0;
  store.persistArgs = [];
  store.persist = async (options) => {
    store.persistCount += 1;
    store.persistArgs.push(options);
  };
  return store;
};

const emptyState = () => ({
  version: 2,
  global: { scripts: [], variables: {} },
  character: {},
  preset: {},
});

{
  const store = makeStore(emptyState());
  assert.deepEqual(store.getScripts('preset', 'missing'), []);
  assert.deepEqual(store.getScopeVariables('character', 'missing'), {});
  assert.equal(await store.toggleScript('preset', 'missing', 's1', true), false);
  assert.equal(await store.updateScript('preset', 'missing', 's1', { enabled: true }), false);
  assert.equal(await store.updateScriptData('preset', 'missing', 's1', { value: true }), false);
  assert.equal(await store.deleteScript('preset', 'missing', 's1'), false);
  assert.deepEqual(store.listScopes(), { character: [], preset: [] });
  console.log('ok - script store no-op reads and mutations do not create empty orphan buckets');
}

{
  const store = makeStore(emptyState());
  assert.equal(await store.setScopeVariables('preset', 'preset-1', { tagFixer: { enabled: true } }), true);
  assert.deepEqual(store.getScopeVariables('preset', 'preset-1'), { tagFixer: { enabled: true } });
  const snapshot = store.getScopeVariables('preset', 'preset-1');
  snapshot.tagFixer.enabled = false;
  assert.equal(store.getScopeVariables('preset', 'preset-1').tagFixer.enabled, true);
  assert.equal(store.persistCount, 1);
  assert.deepEqual(store.persistArgs, [{ notifyScriptsChanged: false }]);
  console.log('ok - script store persists isolated preset and character variable buckets');
}

{
  const store = makeStore({
    ...emptyState(),
    preset: {
      empty: { scripts: [], variables: {} },
      variablesOnly: { scripts: [], variables: { keep: true } },
      orphan: { scripts: [{ id: 's1', name: 'old' }], variables: { stale: true } },
    },
  });
  await store.setScripts('preset', 'empty', []);
  await store.setScripts('preset', 'variablesOnly', []);
  assert.equal(store.state.preset.empty, undefined);
  assert.deepEqual(store.state.preset.variablesOnly.variables, { keep: true });
  assert.equal(await store.removeScope('preset', 'orphan'), true);
  assert.equal(store.state.preset.orphan, undefined);
  assert.equal(await store.removeScope('preset', 'orphan'), false);
  assert.equal(store.persistArgs.at(-1), undefined);
  console.log('ok - script store prunes empty buckets and can remove an orphan scope atomically');
}

{
  const store = makeStore(emptyState());
  const externalLoader = {
    id: 'external-loader',
    name: '外部扩展加载器',
    enabled: true,
    authorized: true,
    content: [
      'const root = window.parent ?? window;',
      "const version = await fetch('https://example.com/version.json');",
      "const script = root.document.createElement('script');",
      "script.src = 'https://example.com/extension.js';",
      'root.document.head.appendChild(script);',
    ].join('\n'),
  };
  const ordinary = {
    id: 'ordinary-script',
    name: '普通事件脚本',
    content: "eventOn('ready', () => api.log('ready'));",
  };
  const result = await store.importTavernHelperScripts({
    scripts: [externalLoader, ordinary],
    scope: 'character',
    scopeId: 'card-1',
    source: 'card',
  });
  assert.equal(result.count, 2);
  assert.deepEqual(result.runnableIds, ['ordinary-script']);
  assert.deepEqual(result.blockedIds, ['external-loader']);
  assert.equal(result.compatibility.blockedCount, 1);
  assert.equal(result.compatibility.runnableCount, 1);

  const imported = store.getScripts('character', 'card-1');
  const blocked = imported.find(script => script.id === 'external-loader');
  assert.equal(blocked.compatibility.level, 'external_extension');
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.authorized, false);
  assert.equal(await store.toggleScript('character', 'card-1', blocked.id, true), false);
  assert.equal(await store.toggleScript('character', 'card-1', 'ordinary-script', true), true);
  assert.deepEqual(
    store.getActiveScripts({ personaId: 'card-1' }).map(script => script.id),
    ['ordinary-script'],
  );
  console.log('ok - script store keeps external extension loaders imported but blocked');
}

{
  const storedCompatibility = {
    version: SCRIPT_COMPATIBILITY_VERSION,
    level: 'module',
    blocked: false,
    reasons: ['top_level_await'],
    signals: {
      topLevelAwait: true,
      hostDomAccess: false,
      remoteAssetLoader: false,
      nativeExtensionApi: false,
    },
    fingerprint: 'module:top_level_await',
    message: 'stored compatibility',
    marker: 'stored-result',
  };
  const state = emptyState();
  state.global.scripts.push({
    id: 'stored-module',
    name: '已归一化模块脚本',
    content: 'const value = await Promise.resolve(1);',
    enabled: true,
    authorized: true,
    compatibility: storedCompatibility,
  });
  const store = makeStore(state);
  const NativeFunction = globalThis.Function;
  let compileCount = 0;
  globalThis.Function = function (...args) {
    compileCount += 1;
    return NativeFunction(...args);
  };
  let active;
  try {
    active = store.getActiveScripts();
  } finally {
    globalThis.Function = NativeFunction;
  }
  assert.equal(compileCount, 0);
  assert.equal(active[0]?.compatibility?.marker, 'stored-result');
  console.log('ok - active script reads reuse normalized compatibility metadata');
}

{
  const store = makeStore(emptyState());
  const result = await store.importTavernHelperScripts({
    scope: 'preset',
    scopeId: 'p1',
    source: 'preset',
    scripts: [
      { id: 'jx', name: '剑仙187', content: 'void 0;', button: { enabled: true, buttons: [{ name: ' 剑仙187 ', visible: true }, { name: '隐藏', visible: false }, { name: '' }, null] } },
      { type: 'folder', scripts: [{ id: 'off', name: 'off', content: 'void 0;', button: { enabled: false, buttons: [{ name: 'B' }] } }] },
      { id: 'bad', name: 'bad', content: 'void 0;', button: 'oops' },
    ],
  });
  assert.equal(result.count, 3);
  const byId = id => store.getScripts('preset', 'p1').find(script => script.id === id);
  const [jx, off, bad] = ['jx', 'off', 'bad'].map(byId);
  assert.deepEqual(jx.button, { enabled: true, buttons: [{ name: '剑仙187', visible: true }, { name: '隐藏', visible: false }] });
  assert.deepEqual(off.button, { enabled: false, buttons: [{ name: 'B', visible: true }] });
  assert.equal('button' in bad, false);
  assert.equal(await store.updateScript('preset', 'p1', 'jx', { name: '改名' }), true);
  assert.deepEqual(byId('jx').button.buttons[0], { name: '剑仙187', visible: true }, 'editing keeps the declaration');
  console.log('ok - script store keeps TavernHelper button declarations through import and edits');
}

{
  const stored = [
    { id: 'jx', name: '剑仙187', content: 'a' },
    { id: 'kept', name: 'kept', content: 'b', button: { enabled: true, buttons: [{ name: 'mine', visible: true }] } },
    { id: 'plain', name: 'plain', content: 'c' },
  ];
  const originals = [
    { id: 'jx', button: { enabled: true, buttons: [{ name: '剑仙187', visible: true }] } },
    { type: 'folder', scripts: [{ id: 'kept', button: { enabled: true, buttons: [{ name: 'theirs', visible: true }] } }] },
  ];
  const filled = fillDeclaredScriptButtons(stored, originals);
  assert.deepEqual(filled[0].button, { enabled: true, buttons: [{ name: '剑仙187', visible: true }] });
  assert.equal(filled[1].button.buttons[0].name, 'mine', 'a stored declaration wins');
  assert.equal('button' in filled[2], false);
  assert.equal('button' in stored[0], false, 'the stored record is not modified');
  assert.equal(fillDeclaredScriptButtons(stored, []), stored);
  console.log('ok - missing button declarations are recovered by script id from the original preset scripts');
}

{
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/scripts/ui/preset-panel.js', import.meta.url), 'utf8');
  assert.match(source, /helper\.scripts = deepClone\(fillDeclaredScriptButtons\(boundScripts, helper\.scripts\)\);/);
  console.log('ok - preset export writes button declarations back into tavern_helper scripts');
}
