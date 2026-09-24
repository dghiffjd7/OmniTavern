import assert from 'node:assert/strict';

globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window ||= { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
const { PresetStore } = await import('../../src/scripts/storage/preset-store.js');
const { RegexStore } = await import('../../src/scripts/storage/regex-store.js');
const { ScriptRuntime } = await import('../../src/scripts/plugins/script-runtime.js');
const { createPresetScriptApi } = await import('../../src/scripts/plugins/preset-script-api.js');

const sid = 'rp:settings';
const context = { sessionId: sid, uiMode: 'rp' };
const saved = { name: 'fixture', app_scope: 'creative', temperature: 0.6,
  prompts: [{ identifier: 'row', content: 'unchanged' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'row', enabled: false }] }],
  extensions: { regex_scripts: [{ id: 'rule', scriptName: 'display', disabled: false }] },
};
const presets = Object.create(PresetStore.prototype);
presets.state = { presets: { openai: { p: structuredClone(saved), other: { name: 'other', app_scope: 'creative' } } },
  active: { openai: 'p' }, enabled: { openai: true } };
presets.ready = Promise.resolve();
let presetWrites = 0;
presets.persist = async () => { presetWrites++; };
const regex = Object.create(RegexStore.prototype);
regex.state = { local: { order: ['set'], sets: { set: { id: 'set', name: 'bound', enabled: true,
  bind: { type: 'preset', presetType: 'openai', presetId: 'p' },
  rules: [{ id: 'rule', scriptName: 'display', findRegex: 'text', replaceString: 'changed', disabled: false }],
} } } };
let regexWrites = 0;
regex.upsertLocalSet = async set => { regex.state.local.sets[set.id] = structuredClone(set); regexWrites++; };
const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
await runtime.ready;
runtime.presets = presets;
runtime.bridge = { regex };
runtime.context = { ...context, openaiPresetId: 'p' };
runtime.buildContext = (sessionId = sid) => ({ sessionId, openaiPresetId: presets.getResolvedActiveId('openai', { sessionId, uiMode: 'rp' }).presetId });
runtime.syncScripts = async () => {};
const snapshot = name => runtime.processRpc('preset.getSnapshot', { name, sessionId: sid });
const update = async (name, mutate) => {
  const before = await snapshot(name);
  const edited = structuredClone(before.preset);
  mutate(edited);
  return runtime.processRpc('preset.update', { name, sessionId: sid, presetId: before.presetId, before: before.preset, edited });
};
const mutate = preset => { preset.prompts[0].enabled = true; preset.extensions.regex_scripts[0].enabled = false; };

await update('in_use', mutate);
assert.equal((await snapshot('in_use')).preset.prompts[0].enabled, true);
assert.equal((await snapshot('fixture')).preset.prompts[0].enabled, false);
assert.equal(presets.getResolvedActive('openai', context).preset.prompt_order[0].order[0].enabled, true);
assert.equal(presets.getResolvedActive('openai', { ...context, sessionId: 'rp:other' }).preset.prompt_order[0].order[0].enabled, false);
assert.deepEqual(presets.state.presets.openai.p, saved);
assert.equal(presetWrites + regexWrites, 0, 'in_use never writes saved presets or regex sets');
const regexContext = { ...context, activePresets: { openai: 'p' }, presetRegexOverrides: presets.getInUsePresetRegexOverrides('openai', context) };
assert.equal(regex.computeActiveRules(regexContext)[0].disabled, true);
assert.equal(regex.computeActiveRules({ ...context, activePresets: { openai: 'p' } })[0].disabled, false);

const inUse = (await snapshot('in_use')).preset;
const onDisk = (await snapshot('fixture')).preset;
const api = createPresetScriptApi({ getContext: () => ({ presetName: 'fixture', activePreset: inUse, savedPreset: onDisk,
  presetRegexes: inUse.regexes, savedPresetRegexes: onDisk.regexes }), clone: structuredClone });
assert.equal(api.getPreset().prompts[0].enabled, true);
assert.equal(api.getPreset('fixture').prompts[0].enabled, false);

await update('fixture', mutate);
assert.equal(presetWrites, 1);
assert.equal(regexWrites, 1);
assert.equal(presets.state.presets.openai.p.prompt_order[0].order[0].enabled, true);
assert.equal(presets.state.presets.openai.p.extensions.regex_scripts[0].disabled, true);
assert.equal(regex.state.local.sets.set.rules[0].disabled, true);
assert.equal(presets.getInUsePresetRegexOverrides('openai', context), null);

await update('in_use', preset => { preset.prompts[0].enabled = false; });
await runtime.syncContext({ sessionId: 'rp:other' });
assert.equal(presets.getResolvedActive('openai', context).preset.prompt_order[0].order[0].enabled, true, 'leaving the session discards unsaved changes');

const before = await snapshot('fixture');
const edited = structuredClone(before.preset);
edited.prompts[0].enabled = false;
await presets.upsert('openai', { id: 'p', data: { ...presets.state.presets.openai.p,
  prompts: [{ identifier: 'row', content: 'concurrent user edit' }] }, makeActive: false });
await runtime.processRpc('preset.update', { name: 'fixture', sessionId: sid, presetId: 'p', before: before.preset, edited });
assert.equal(presets.state.presets.openai.p.prompts[0].content, 'concurrent user edit');
assert.equal(presets.state.presets.openai.p.prompt_order[0].order[0].enabled, false);
assert.equal(presets.getActiveId('openai'), 'p');
console.log('ok - script preset edits separate in-use working data from named persistence, scope regex overrides and preserve concurrent edits');

{
  // 规则集筛选在复制前进行：只复制命中的规则集，返回的仍是副本
  const store = Object.create(RegexStore.prototype);
  const bound = { id: 'a', bind: { type: 'preset', presetType: 'openai', presetId: 'p' }, rules: [{ id: 'r1' }] };
  const other = { id: 'b', bind: { type: 'world', worldId: 'w' }, rules: [{ id: 'r2' }] };
  store.state = { local: { order: ['a', 'b'], sets: { a: bound, b: other } } };
  const seen = [];
  const hits = store.listLocalSets(set => { seen.push(set.id); return set.bind?.type === 'preset'; });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(hits.map(set => set.id), ['a']);
  assert.notEqual(hits[0], bound, '命中的规则集仍以副本返回');
  assert.deepEqual(store.listLocalSets().map(set => set.id), ['a', 'b'], '不传筛选时行为不变');
  console.log('ok - regex listLocalSets filters before cloning');
}
