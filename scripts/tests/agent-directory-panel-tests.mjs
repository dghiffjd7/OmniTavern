import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createAgentDirectoryPanel, describeAgentDirectoryMeta, agentDirectoryGroupOf } = await import('../../src/scripts/ui/agent-directory-panel.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.checked = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    const owner = this;
    this.classList = {
      add: (...names) => { owner.className = [...new Set([...owner.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { owner.className = owner.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => owner.className.split(' ').includes(name),
      toggle: (name, force) => (force ? owner.classList.add(name) : owner.classList.remove(name)),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...items) { this.children = [...items]; }
  insertAdjacentHTML(position, html) { this.innerHTML += html; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  dispatch(type) { (this.listeners.get(type) || []).forEach(handler => handler({ target: this })); }
  querySelectorAll(selector) { const name = selector.replace(/^\./, ''); return walk(this).filter(node => node.className.split(' ').includes(name)); }
}
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const doc = { head: new FakeElement('head'), body: new FakeElement('body'), createElement: tag => new FakeElement(tag), getElementById: () => null };

const agents = [
  { id: 'sub-1', name: '便宜档', role: 'sub_agent', enabled: true, modelProfileRef: 'p-d', budgets: { timeMs: 60000, tokens: 4000, toolCalls: null }, ref: { namespace: 'user' } },
  { id: 'reply_check', name: '格式修复', role: 'format_review', enabled: true, modelMode: 'follow_current', invocation: 'auto', ref: { namespace: 'builtin' } },
  { id: 'text-edit:polish', name: '正文润色', role: 'text_edit', enabled: false, modelMode: 'profile', modelProfileRef: 'p-a', invocation: 'manual', tools: 2, custom: true, ref: { namespace: 'user' } },
  { id: 'text_completion', name: '文本建议', role: 'input_suggestion', enabled: false, modelMode: 'none', invocation: 'auto', ref: { namespace: 'builtin' } },
  { id: 'builtin:avatar', name: '生成并设置头像', role: 'maid_skill', enabled: true, summary: '为角色卡生成头像', invocation: 'auto', ref: { namespace: 'builtin' } },
];
const models = { 'p-d': 'Deepseek · v4-flash', 'p-a': 'vertex · gemini' };

{
  assert.equal(agentDirectoryGroupOf({ role: 'sub_agent' }), 'sub_agent');
  assert.equal(agentDirectoryGroupOf({ role: 'maid_skill' }), 'skill');
  assert.equal(agentDirectoryGroupOf({ role: 'input_agent' }), 'text');
  const describe = agent => describeAgentDirectoryMeta(agent, { describeModel: item => models[item.modelProfileRef] || '' });
  assert.equal(describe(agents[0]), '模型：Deepseek · v4-flash · 由女仆委派 · 时间上限 60 秒 · 输出上限 4000 tokens');
  assert.equal(describe(agents[1]), '跟随当前对话的模型 · 自动触发');
  assert.equal(describe(agents[2]), '模型：vertex · gemini · 手动触发 · 可查 2 个工具');
  assert.equal(describe(agents[3]), '未选模型 · 自动触发');
  assert.equal(describe(agents[4]), '为角色卡生成头像 · 女仆可自动选用');
  console.log('ok - directory rows describe model, trigger, budgets and tools');
}

{
  const opened = [];
  const panel = createAgentDirectoryPanel({ documentRef: doc, listAgents: () => agents, describeModel: item => models[item.modelProfileRef] || '', openAgent: agent => opened.push(agent.id) });
  panel.show();
  const overlay = panel.overlay;
  assert.equal(byClass(overlay, 'ad-subtitle')[0].textContent, '共 5 个 · 已开启 3 个');
  assert.deepEqual(byClass(overlay, 'ad-group-title').map(node => node.textContent), ['女仆 Sub-agent', '文字与输入 Agent', '女仆技能']);
  assert.deepEqual(byClass(overlay, 'ad-count').map(node => node.textContent), ['1', '3', '1']);
  const items = byClass(overlay, 'ad-item');
  assert.deepEqual(items.map(item => item.className.includes('is-off')), [false, false, true, true, false]);
  assert.deepEqual(byClass(items[2], 'ad-chip').map(node => node.textContent), ['正文 Agent', '自建']);
  assert.deepEqual(byClass(items[1], 'ad-chip').map(node => node.textContent), [], 'a type chip that repeats the name is hidden');
  assert.deepEqual(byClass(items[0], 'ad-chip').map(node => node.textContent), ['自建'], 'other groups rely on their heading for the type');
  assert.match(items[0].innerHTML, /<svg/);

  // 筛选与只看已开启
  byClass(overlay, 'ad-filter').find(node => node.dataset.filter === 'text').dispatch('click');
  assert.deepEqual(byClass(overlay, 'ad-name').map(node => node.textContent), ['格式修复', '正文润色', '文本建议']);
  assert.equal(byClass(overlay, 'ad-filter').find(node => node.dataset.filter === 'text').className.includes('is-active'), true);
  const onlyOn = walk(overlay).find(node => node.tagName === 'INPUT');
  onlyOn.checked = true;
  onlyOn.dispatch('change');
  assert.deepEqual(byClass(overlay, 'ad-name').map(node => node.textContent), ['格式修复']);
  byClass(overlay, 'ad-filter').find(node => node.dataset.filter === 'skill').dispatch('click');
  onlyOn.checked = false;
  onlyOn.dispatch('change');
  assert.deepEqual(byClass(overlay, 'ad-name').map(node => node.textContent), ['生成并设置头像']);

  // 点一项：先关目录，再跳到它的设置
  byClass(overlay, 'ad-item')[0].dispatch('click');
  assert.deepEqual(opened, ['builtin:avatar']);
  assert.equal(panel.isOpen(), false);
  panel.show();
  assert.equal(panel.closeTopLayer(), true);
  assert.equal(panel.closeTopLayer(), false);
  console.log('ok - the directory groups agents by source, filters them and hands off to their settings');
}

{
  // 打开时等资料载入后再画一次
  let ready = false;
  let release;
  const late = createAgentDirectoryPanel({ documentRef: doc, listAgents: () => [agents[0]], describeModel: () => (ready ? 'Deepseek · v4-flash' : ''), prepare: () => new Promise((resolve) => { release = resolve; }) });
  const showing = late.show();
  assert.match(byClass(late.overlay, 'ad-meta')[0].textContent, /^未选模型/);
  ready = true;
  release();
  await showing;
  assert.match(byClass(late.overlay, 'ad-meta')[0].textContent, /^模型：Deepseek · v4-flash/);
  console.log('ok - the directory redraws once its data has loaded');
}

{
  const empty = createAgentDirectoryPanel({ documentRef: doc, listAgents: () => [] });
  empty.show();
  assert.equal(byClass(empty.overlay, 'ad-empty')[0].textContent, '还没有 Agent。');
  assert.equal(byClass(empty.overlay, 'ad-item').length, 0);
  console.log('ok - an empty directory says so plainly');
}

console.log('agent-directory-panel-tests passed');
