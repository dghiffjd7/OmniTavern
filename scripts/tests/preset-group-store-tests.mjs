import assert from 'node:assert/strict';

import {
  PRESET_GROUP_STORE_KEY,
  buildPresetPickerSections,
  createPresetGroupStore,
  normalizePresetGroupState,
} from '../../src/scripts/storage/preset-group-store.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
};

const makeStore = (overrides = {}) => {
  const storage = memoryStorage();
  const kv = new Map();
  let n = 0;
  const changes = [];
  const store = createPresetGroupStore({
    storage,
    loadKv: async name => (kv.has(name) ? JSON.parse(JSON.stringify(kv.get(name))) : null),
    saveKv: async (name, data) => { kv.set(name, JSON.parse(JSON.stringify(data))); },
    createId: () => `g${++n}`,
    now: () => 1000 + n,
    onChange: () => changes.push(true),
    logger: null,
    ...overrides,
  });
  return { store, storage, kv, changes };
};

test('normalize drops broken groups, duplicate names and presets claimed twice', () => {
  const state = normalizePresetGroupState({
    groups: [
      { id: 'a', name: '  Izumi  ', color: 'violet', presetIds: ['p1', 'p2', 'p1', ''] },
      { id: 'b', name: 'Izumi', presetIds: ['p3'] },
      { id: '', name: 'no id', presetIds: [] },
      { id: 'c', name: '', presetIds: [] },
      { id: 'a', name: 'dup id', presetIds: [] },
      { id: 'd', name: '总结用', color: 'not-a-color', presetIds: ['p2', 'p4'] },
      null,
    ],
  });
  assert.deepEqual(state.groups, [
    { id: 'a', name: 'Izumi', color: 'violet', presetIds: ['p1', 'p2'] },
    { id: 'd', name: '总结用', color: 'sky', presetIds: ['p4'] },
  ]);
});

test('create, rename, recolor, move and delete keep one group per preset', async () => {
  const { store, kv, changes } = makeStore();
  await store.ready;
  const izumi = await store.createGroup('Izumi', 'violet');
  assert.equal(izumi.ok, true);
  assert.equal((await store.createGroup(' Izumi ')).reason, 'duplicate_name');
  assert.equal((await store.createGroup('   ')).reason, 'empty_name');
  const summary = await store.createGroup('总结用');
  assert.equal(summary.group.color, 'sky');

  await store.movePreset('p1', izumi.group.id);
  await store.movePreset('p2', izumi.group.id);
  await store.movePreset('p1', summary.group.id);
  assert.equal(store.getGroupOfPreset('p1')?.id, summary.group.id);
  assert.deepEqual(store.getGroups().find(g => g.id === izumi.group.id).presetIds, ['p2']);

  await store.movePreset('p2', '');
  assert.equal(store.getGroupOfPreset('p2'), null);

  assert.equal((await store.renameGroup(summary.group.id, 'Izumi')).reason, 'duplicate_name');
  assert.equal((await store.renameGroup(summary.group.id, '大总结')).ok, true);
  assert.equal((await store.setGroupColor(summary.group.id, 'rose')).ok, true);
  assert.equal((await store.movePreset('p9', 'missing')).reason, 'group_missing');

  await store.deleteGroup(summary.group.id);
  assert.equal(store.getGroupOfPreset('p1'), null);
  assert.deepEqual(store.getGroups().map(g => g.name), ['Izumi']);
  assert.deepEqual(kv.get(PRESET_GROUP_STORE_KEY).groups.map(g => g.name), ['Izumi']);
  assert.ok(changes.length >= 6);
});

test('prune removes deleted presets and only saves when something changed', async () => {
  const { store, kv } = makeStore();
  const g = (await store.createGroup('Kemini')).group;
  await store.movePreset('k1', g.id);
  await store.movePreset('k2', g.id);
  const before = kv.get(PRESET_GROUP_STORE_KEY).updatedAt;
  assert.equal((await store.prune(['k1', 'k2', 'x'])).changed, false);
  assert.equal(kv.get(PRESET_GROUP_STORE_KEY).updatedAt, before);
  assert.equal((await store.prune(['k2'])).changed, true);
  assert.deepEqual(store.getGroups()[0].presetIds, ['k2']);
});

test('hydrate prefers the newer kv copy over the local mirror', async () => {
  const storage = memoryStorage();
  storage.setItem(PRESET_GROUP_STORE_KEY, JSON.stringify({ updatedAt: 5, groups: [{ id: 'l', name: 'local', presetIds: [] }] }));
  const store = createPresetGroupStore({
    storage,
    loadKv: async () => ({ updatedAt: 9, groups: [{ id: 'k', name: 'kv', presetIds: ['p'] }] }),
    saveKv: async () => {},
    logger: null,
  });
  await store.ready;
  assert.deepEqual(store.getGroups().map(g => g.name), ['kv']);
});

test('a failed kv save reports failure and keeps the previous state', async () => {
  const { store } = makeStore({ saveKv: async () => { throw new Error('disk'); } });
  const result = await store.createGroup('Izumi');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'save_failed');
  assert.deepEqual(store.getGroups(), []);
});

test('picker sections follow preset order, put uncategorized last and expand the current group', () => {
  const presets = [
    { id: 'd', name: 'Default' },
    { id: 'i1', name: 'Izumi 1002' },
    { id: 's1', name: '大总结专用' },
    { id: 'i2', name: 'Izumi_0923' },
  ];
  const groups = [
    { id: 'gs', name: '总结用', color: 'rose', presetIds: ['s1', 'gone'] },
    { id: 'gi', name: 'Izumi', color: 'violet', presetIds: ['i2', 'i1'] },
    { id: 'ge', name: '空分类', color: 'sky', presetIds: [] },
  ];
  const sections = buildPresetPickerSections({ presets, groups, currentId: 'i1', uncategorizedLabel: '未分类' });
  assert.deepEqual(sections.map(s => [s.id, s.name, s.items.map(i => i.id), s.expanded]), [
    ['gs', '总结用', ['s1'], false],
    ['gi', 'Izumi', ['i1', 'i2'], true],
    ['ge', '空分类', [], false],
    ['', '未分类', ['d'], false],
  ]);
  assert.equal(sections[1].items[0].selected, true);

  const searched = buildPresetPickerSections({ presets, groups, currentId: 'i1', query: 'IZUMI_0', uncategorizedLabel: '未分类' });
  assert.deepEqual(searched.map(s => [s.id, s.items.map(i => i.id), s.expanded]), [['gi', ['i2'], true]]);

  const toggled = buildPresetPickerSections({ presets, groups, currentId: 'i1', expanded: { gi: false, '': true }, uncategorizedLabel: '未分类' });
  assert.deepEqual(toggled.map(s => s.expanded), [false, false, false, true]);
});

test('picker sections without groups show one uncategorized section expanded', () => {
  const sections = buildPresetPickerSections({ presets: [{ id: 'a', name: 'A' }], groups: [], uncategorizedLabel: '全部预设' });
  assert.deepEqual(sections.map(s => [s.id, s.name, s.expanded, s.items.length]), [['', '全部预设', true, 1]]);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
