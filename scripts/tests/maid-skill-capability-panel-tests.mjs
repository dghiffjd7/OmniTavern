import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMaidSkillPanel } = await import('../../src/scripts/ui/maid-skill-panel.js');
const { MaidSettingsStore } = await import('../../src/scripts/storage/maid-settings-store.js');
const { listMaidBuiltinCapabilityStates } = await import('../../src/scripts/agent/tools/maid-capability-tools.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.value = '';
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.classList = { add: (...tokens) => { this.className = [this.className, ...tokens].filter(Boolean).join(' '); } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  dispatch(type) { (this.listeners.get(type) || []).forEach(handler => handler({})); }
  click() {}
}
const doc = { head: new FakeElement('head'), createElement: tag => new FakeElement(tag), getElementById: () => null };
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const kv = new Map();
const settings = new MaidSettingsStore({ storage: null, loadKv: async key => kv.get(key) ?? null, saveKv: async (key, value) => { kv.set(key, value); }, now: () => Date.now() });
await settings.load();
const skillStore = {
  list: () => [{ id: 'skill-1', kind: 'custom', title: '整理世界书', description: '', enabled: true, invocationMode: 'auto', revision: 1 }],
  exportState: () => ({ quarantined: [] }),
  subscribe() {},
  ready: Promise.resolve(),
};
const panel = createMaidSkillPanel({
  store: skillStore,
  documentRef: doc,
  capabilities: {
    list: () => listMaidBuiltinCapabilityStates(settings),
    setEnabled: (id, enabled) => settings.setBuiltinCapabilityEnabled(id, enabled, { source: 'settings' }),
    subscribe: listener => settings.subscribeCapabilities(listener),
  },
});
const root = new FakeElement('div');
panel.mount(root);

{
  // 技能页顶部的「内置能力」分组：默认关闭，一行一个，开关写进设置并记为用户在设置里改的
  const [row] = byClass(root, 'is-capability');
  assert.ok(row, 'the built-in capability group renders above the skills');
  assert.equal(byClass(row, 'maid-skill-capability-title')[0].textContent, '随机互动');
  assert.equal(byClass(row, 'maid-skill-description')[0].textContent, '骰子 · 抽签 · 帮你选');
  assert.match(byClass(row, 'maid-skill-capability-icon')[0].innerHTML, /<svg/);
  const toggle = walk(row).find(node => node.tagName === 'INPUT');
  assert.equal(toggle.checked, false, 'capabilities are off by default');
  assert.ok(row.className.includes('is-disabled'));

  toggle.checked = true;
  toggle.dispatch('change');
  await flush();
  assert.equal(settings.getBuiltinCapability('random').enabled, true);
  assert.deepEqual(settings.getCapabilityLog().map(item => [item.enabled, item.source]), [[true, 'settings']]);
  const [enabledRow] = byClass(root, 'is-capability');
  assert.ok(!enabledRow.className.includes('is-disabled'), 'the row re-renders after the switch changes');
  assert.equal(byClass(enabledRow, 'maid-skill-capability-used').length, 0, 'no last-used line before it is used');

  await settings.markBuiltinCapabilityUsed('random');
  assert.match(byClass(root, 'maid-skill-capability-used')[0]?.textContent || '', /^上次使用 · 今天 /, 'last use shows on the row once the capability is used');
  console.log('ok - skills page lists built-in capabilities with a switch and last use');
}

{
  // 筛选与搜索同时作用于能力和技能；没有可显示的能力时，分组标题一起隐藏
  const select = walk(root).find(node => node.tagName === 'SELECT');
  const search = walk(root).find(node => node.tagName === 'INPUT' && node.type === 'search');
  const capabilityGroup = byClass(root, 'maid-skill-capabilities')[0];
  const groupTitles = () => byClass(root, 'maid-skill-group-title').map(node => node.hidden);
  for (const [filter, shown] of [['custom', 0], ['builtin', 1], ['enabled', 1], ['disabled', 0], ['all', 1]]) {
    select.value = filter;
    select.dispatch('change');
    assert.equal(capabilityGroup.children.length, shown, `filter ${filter}`);
    assert.deepEqual(groupTitles(), [!shown, !shown]);
  }
  search.value = '骰子';
  search.dispatch('input');
  assert.equal(capabilityGroup.children.length, 1, 'search matches the subtitle');
  search.value = '世界书';
  search.dispatch('input');
  assert.equal(capabilityGroup.children.length, 0);
  console.log('ok - skill filters and search apply to built-in capabilities too');
}

{
  // 保存失败：提示失败，开关回到真实状态
  const failRoot = new FakeElement('div');
  createMaidSkillPanel({
    store: skillStore,
    documentRef: doc,
    capabilities: {
      list: () => listMaidBuiltinCapabilityStates({ getBuiltinCapability: () => ({ enabled: false, lastUsedAt: 0, revision: 0 }) }),
      setEnabled: async () => ({ ok: false, reason: 'save_failed' }),
    },
  }).mount(failRoot);
  const toggle = walk(byClass(failRoot, 'is-capability')[0]).find(node => node.tagName === 'INPUT');
  toggle.checked = true;
  toggle.dispatch('change');
  await flush();
  assert.equal(walk(byClass(failRoot, 'is-capability')[0]).find(node => node.tagName === 'INPUT').checked, false, 'the switch shows the real state after a failed save');
  assert.ok(byClass(failRoot, 'maid-skill-error').length, 'the failure is reported');
  console.log('ok - a failed capability save reports the error and keeps the real state');
}

console.log('maid-skill-capability-panel-tests passed');
