import assert from 'node:assert/strict';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const {
  createAgentCenterSettingsStore,
  isLazyPresetMigrationNoop,
  lazyMigratePresetProfileToAgentCenterSettings,
} = await import('../../src/scripts/storage/agent-center-settings-store.js');
const { MemoryTemplateStore } = await import('../../src/scripts/storage/memory-template-store.js');
const { DEFAULT_MEMORY_TEMPLATE } = await import('../../src/scripts/memory/default-template.js');
const { AgentCenterStatusChip } = await import('../../src/scripts/ui/agent-center-status-chip.js');

// 空闲写盘守卫：读取路径上的懒迁移、内置模板同步与状态胶囊定时刷新，在没有变化或看不见时不写盘、不刷新

const makeStorage = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), writes: () => map.size };
};

{
  const saves = [];
  let clock = 1000;
  const store = createAgentCenterSettingsStore({ storage: makeStorage(), saveKv: async (_cmd, payload) => { saves.push(payload); return true; }, loadKv: async () => null });
  const preset = { name: '主预设', memory_data_position: 'after', memory_data_depth: 2 };
  await store.lazyMigratePresetProfile({ profileType: 'openai', presetId: 'p1', preset }, { now: () => clock });
  assert.equal(saves.length, 1, '首次迁移会写入');
  const firstUpdatedAt = store.getSettings().profiles['openai:p1']?.updatedAt ?? Object.values(store.getSettings().profiles)[0]?.updatedAt;
  clock = 9000;
  await store.lazyMigratePresetProfile({ profileType: 'openai', presetId: 'p1', preset }, { now: () => clock });
  await store.lazyMigratePresetProfile({ profileType: 'openai', presetId: 'p1', preset }, { now: () => clock });
  assert.equal(saves.length, 1, '已迁移且无变化时不再写盘');
  const afterUpdatedAt = store.getSettings().profiles['openai:p1']?.updatedAt ?? Object.values(store.getSettings().profiles)[0]?.updatedAt;
  assert.equal(afterUpdatedAt, firstUpdatedAt, '无变化时不刷新时间戳');
  await store.lazyMigratePresetProfile({ profileType: 'openai', presetId: 'p1', preset: { ...preset, name: '改名后' } }, { now: () => clock });
  assert.equal(saves.length, 2, '预设改名这类真实变化照常写入');

  const before = lazyMigratePresetProfileToAgentCenterSettings({}, { profileType: 'openai', presetId: 'p2', preset, now: () => 1 });
  const again = lazyMigratePresetProfileToAgentCenterSettings(before, { profileType: 'openai', presetId: 'p2', preset, now: () => 2 });
  assert.equal(isLazyPresetMigrationNoop(before, again, { profileType: 'openai', presetId: 'p2' }), true);
  assert.equal(isLazyPresetMigrationNoop({}, before, { profileType: 'openai', presetId: 'p2' }), false, '新建配置不算无变化');
  console.log('ok - lazy preset migration skips no-op writes and keeps timestamps');
}

{
  const makeTemplateStore = (existing) => {
    const store = Object.create(MemoryTemplateStore.prototype);
    const saved = [];
    Object.assign(store, {
      scopeId: 'test', ready: Promise.resolve(true), writeChain: Promise.resolve(), writePending: 0,
      queueResetAt: null, queueResetReason: null, queueResetCount: 0,
      getTemplateById: async () => existing(),
      invokeCommand: async (cmd, args) => { if (cmd === 'save_template') saved.push(args.input); return true; },
    });
    return { store, saved };
  };
  // 模拟数据库回读：键顺序被打乱但内容与内置定义一致
  const meta = DEFAULT_MEMORY_TEMPLATE.meta;
  const shuffledSchema = JSON.parse(JSON.stringify({ tables: DEFAULT_MEMORY_TEMPLATE.tables, meta: { tags: meta.tags || [], description: meta.description, author: meta.author, version: meta.version, name: meta.name, id: meta.id } }));
  const record = () => ({
    id: meta.id, name: meta.name, author: meta.author || null, version: meta.version || null, description: meta.description || null,
    schema: shuffledSchema, injection: DEFAULT_MEMORY_TEMPLATE.injection || null, is_default: true, is_builtin: true,
  });
  const same = makeTemplateStore(record);
  assert.equal(await same.store.ensureDefaultTemplate(), false);
  assert.equal(same.saved.length, 0, '内置模板已与代码一致时不重写');

  const stale = makeTemplateStore(() => ({ ...record(), description: '旧描述' }));
  assert.equal(await stale.store.ensureDefaultTemplate(), true);
  assert.equal(stale.saved.length, 1, '内容不同照常同步到代码版本');
  console.log('ok - built-in memory template is rewritten only when it differs');
}

{
  let collected = 0;
  let intervalFn = null;
  const docListeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: type => docListeners.delete(type),
    getElementById: () => null,
    head: { appendChild() {} },
    defaultView: {},
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { intervalFn = fn; return 1; };
  try {
    const chip = new AgentCenterStatusChip({ documentRef: doc, collectView: async () => { collected += 1; return {}; } });
    let shown = true;
    chip.element = { isConnected: true, checkVisibility: () => shown };
    chip.render = () => {};
    chip.start();
    intervalFn();
    assert.equal(collected, 1, '可见时照常刷新');
    shown = false;
    intervalFn(); intervalFn();
    assert.equal(collected, 1, '所在页面隐藏时跳过刷新');
    shown = true;
    docListeners.get('visibilitychange')();
    assert.equal(collected, 2, '重新可见时立刻补刷一次');
    docListeners.get('visibilitychange')();
    assert.equal(collected, 2, '没有跳过就不重复补刷');
    doc.visibilityState = 'hidden';
    intervalFn();
    assert.equal(collected, 2, '应用在后台时也跳过');
    chip.stop();
    assert.equal(docListeners.has('visibilitychange'), false, '停止时移除监听');
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  console.log('ok - agent status chip pauses refresh while hidden and catches up when shown');
}
