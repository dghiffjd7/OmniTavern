import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createUserToolSettingsPanel } = await import('../../src/scripts/ui/tools/user-tool-settings-panel.js');
const { UserToolStore } = await import('../../src/scripts/storage/user-tool-store.js');
const { BUILTIN_TOOL_ACTIONS, getBuiltinToolAction, agentToolAction, SCRIPT_TOOL_ACTION } = await import('../../src/scripts/ui/tools/user-tool-actions.js');
const { toolboxManagementMarkup, toolboxNamedIcon } = await import('../../src/scripts/ui/agent-toolbox-view.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    const owner = this;
    this.classList = {
      add: (...names) => { owner.className = [...new Set([...owner.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { owner.className = owner.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => owner.className.split(' ').includes(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  dispatch(type, extra = {}) { (this.listeners.get(type) || []).forEach(handler => handler({ target: this, ...extra })); }
}
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const text = node => walk(node).map(item => item.textContent).join('');
const buttonLabeled = (root, label) => walk(root).find(node => node.tagName === 'BUTTON' && text(node) === label);
const field = (root, name) => walk(root).find(node => node.dataset.field === name);
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

const winListeners = new Map();
const win = {
  addEventListener: (type, fn) => winListeners.set(type, [...(winListeners.get(type) || []), fn]),
  removeEventListener: (type, fn) => winListeners.set(type, (winListeners.get(type) || []).filter(item => item !== fn)),
};
const press = (extra) => {
  const event = { key: 'x', code: 'KeyX', preventDefault() {}, stopImmediatePropagation() {}, ...extra };
  (winListeners.get('keydown') || []).forEach(fn => fn(event));
};
const doc = { head: new FakeElement('head'), body: new FakeElement('body'), createElement: tag => new FakeElement(tag), getElementById: () => null, defaultView: win };

const agents = [agentToolAction({ id: 'text-edit:polish', title: '润色' }, { iconName: 'pen' })];
const actions = [...BUILTIN_TOOL_ACTIONS, ...agents, SCRIPT_TOOL_ACTION];
const getAction = (source, id) => (source === 'builtin' ? getBuiltinToolAction(id) : source === 'script' ? SCRIPT_TOOL_ACTION : agents.find(action => action.id === id) || null);

const setup = async (panelOptions = {}) => {
  let saved = null;
  const store = new UserToolStore({ loadKv: async () => saved, saveKv: async (key, value) => { saved = JSON.parse(JSON.stringify(value)); } });
  await store.load();
  const panel = createUserToolSettingsPanel({
    documentRef: doc, store, listActions: () => actions, getAction,
    shortcutTaken: shortcut => (shortcut.code === 'KeyJ' && shortcut.ctrl && shortcut.alt ? '打开工具箱' : ''),
    ...panelOptions,
  });
  return { store, panel };
};

{
  // 空白：示例一键填表；保存后列表显示说明与「直接执行」
  const { store, panel } = await setup();
  panel.show();
  const overlay = panel.overlay;
  assert.equal(byClass(overlay, 'uts-empty-title')[0].textContent, '还没有工具');
  assert.equal(byClass(overlay, 'uts-add')[0].hidden, true, 'the empty state leads with its own buttons');
  const templates = byClass(overlay, 'uts-template');
  assert.equal(templates.length, 4);
  templates[0].dispatch('click');
  assert.equal(field(overlay, 'name').value, '删掉最后回复');
  assert.equal(byClass(overlay, 'uts-action').find(node => node.className.includes('is-selected')).dataset.action, 'builtin:reply.delete');
  assert.equal(field(overlay, 'direct').checked, true);
  assert.match(text(byClass(overlay, 'uts-form')[0]), /作用于：这条或最后一条 AI 回复/);
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  const [tool] = store.listTools();
  assert.deepEqual([tool.name, tool.action.id, tool.direct, tool.icon], ['删掉最后回复', 'reply.delete', true, 'trash']);
  assert.equal(byClass(overlay, 'uts-tool-desc')[0].textContent, '删除回复 · 直接执行');
  assert.deepEqual(byClass(overlay, 'uts-chip').map(text), ['直接执行']);
  assert.equal(byClass(overlay, 'uts-subtitle')[0].textContent, '1 个工具（最多 60 个）');
  console.log('ok - templates fill the form and saved tools list their action');
}

{
  // 新建：选动作时名称与图标跟着带入（手动改过就不动）；参数必填；不可直接执行的动作没有开关
  const { store, panel } = await setup();
  panel.show({ create: true });
  const overlay = panel.overlay;
  const pick = id => byClass(overlay, 'uts-action').find(node => node.dataset.action === id).dispatch('click');
  pick('builtin:reply.regenerate');
  assert.equal(field(overlay, 'name').value, '重新生成');
  assert.equal(byClass(overlay, 'uts-icon-choice').find(node => node.className.includes('is-selected')).dataset.icon, 'regenerate');
  assert.equal(field(overlay, 'direct'), undefined, 'only destructive actions offer direct mode');
  pick('builtin:text.phrase');
  assert.equal(field(overlay, 'name').value, '快捷短语', 'an untouched name follows the action');
  field(overlay, 'name').value = '早安';
  field(overlay, 'name').dispatch('input');
  pick('builtin:open.panel');
  assert.equal(field(overlay, 'name').value, '早安', 'a typed name is kept');
  pick('builtin:text.phrase');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.equal(byClass(overlay, 'uts-form-error')[0].textContent, '请填写「文字」');
  const textarea = walk(overlay).find(node => node.dataset.param === 'text');
  textarea.value = '早安呀';
  textarea.dispatch('input');
  const send = walk(overlay).find(node => node.dataset.param === 'send');
  send.checked = true;
  send.dispatch('change');
  // Agent 动作也能选
  assert.ok(byClass(overlay, 'uts-action').some(node => node.dataset.action === 'agent:text-edit:polish'));
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  const [tool] = store.listTools();
  assert.deepEqual(tool.action, { source: 'builtin', id: 'text.phrase', params: { text: '早安呀', mode: 'insert', send: true } });
  assert.equal(byClass(overlay, 'uts-tool-desc')[0].textContent, '快捷短语 · 「早安呀」 · 直接发送');
  console.log('ok - choosing an action fills name and icon, and params are validated');
}

{
  // 打开功能：名称跟着所选面板；说明和名称一样时改说作用对象
  const { store, panel } = await setup();
  panel.show({ create: true });
  const overlay = panel.overlay;
  byClass(overlay, 'uts-action').find(node => node.dataset.action === 'builtin:open.panel').dispatch('click');
  assert.equal(field(overlay, 'name').value, '打开 AI 绘图');
  const select = walk(overlay).find(node => node.dataset.param === 'panel');
  select.value = 'memory';
  select.dispatch('change');
  assert.equal(field(overlay, 'name').value, '打开记忆总览', 'the untouched name follows the chosen panel');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  await store.saveTool({ name: '复制这条', icon: 'copy', action: { source: 'builtin', id: 'text.copy', params: {} } });
  panel.refresh();
  assert.equal(byClass(overlay, 'uts-tool').length, 2);
  // 「打开记忆总览」说明与名称相同、又不作用于消息：不重复显示；「复制这条」改说作用对象
  assert.deepEqual(byClass(overlay, 'uts-tool-desc').map(node => node.textContent), ['作用于：这条消息或最后一条 AI 回复']);
  console.log('ok - names follow the chosen panel and duplicate descriptions name the target instead');
}

{
  // 快捷键录制：要修饰键、不能用编辑键与 APP 已占用的；和别的工具重复时要勾选改绑
  const { store, panel } = await setup();
  const first = await store.saveTool({ name: 'A', icon: 'bolt', action: { source: 'builtin', id: 'reply.regenerate', params: {} } });
  await store.setShortcut(first.id, { code: 'KeyR', alt: true, label: 'Alt + R' });
  const second = await store.saveTool({ name: 'B', icon: 'bolt', action: { source: 'builtin', id: 'reply.continue', params: {} } });
  panel.show({ toolId: second.id });
  const overlay = panel.overlay;
  const key = () => walk(overlay).find(node => node.dataset.key === 'shortcut');
  key().dispatch('click');
  assert.equal(panel.isRecording(), true);
  press({ key: 'r', code: 'KeyR' });
  assert.match(text(byClass(overlay, 'uts-key-error')[0]), /Ctrl、Alt 或 ⌘/);
  press({ key: 'c', code: 'KeyC', ctrlKey: true });
  assert.match(text(byClass(overlay, 'uts-key-error')[0]), /常用的编辑按键/);
  press({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
  assert.match(text(byClass(overlay, 'uts-key-error')[0]), /已用于打开工具箱/);
  assert.equal(panel.closeTopLayer(), true, 'Back stops recording first');
  assert.equal(panel.isRecording(), false);
  assert.ok(byClass(overlay, 'uts-form').length, 'and keeps the form open');
  key().dispatch('click');
  press({ key: 'r', code: 'KeyR', altKey: true });
  assert.equal(panel.isRecording(), false);
  assert.match(text(byClass(overlay, 'uts-key-error')[0]), /已被「A」使用/);
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.match(byClass(overlay, 'uts-form-error')[0].textContent, /改绑到这个工具/);
  const replace = field(overlay, 'shortcutReplace');
  replace.checked = true;
  replace.dispatch('change');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.equal(store.findShortcut({ code: 'KeyR', alt: true }).toolId, second.id);
  assert.deepEqual(byClass(overlay, 'uts-chip').map(text), ['Alt + R'], 'only B shows the shortcut now');
  assert.equal((winListeners.get('keydown') || []).length, 0, 'the recorder detaches after use');
  console.log('ok - shortcut recording rejects reserved combos and moves conflicts only when asked');
}

{
  // 手势：对不上动作的位置停用；别的工具在用会标出、选了就改绑；取消选取会移除
  const { store, panel } = await setup();
  const other = await store.saveTool({ name: '别的', icon: 'bolt', action: { source: 'builtin', id: 'reply.regenerate', params: {} } });
  await store.setGesture(other.id, { position: 'send_button', gesture: 'long' });
  panel.show({ create: true });
  const overlay = panel.overlay;
  const chip = key => byClass(overlay, 'uts-gesture').find(node => node.dataset.gesture === key);
  byClass(overlay, 'uts-action').find(node => node.dataset.action === 'builtin:message.retract').dispatch('click');
  assert.equal(chip('assistant_bubble:double').disabled, true, 'a user-message action cannot sit on AI bubbles');
  assert.equal(chip('user_bubble:double').disabled, false);
  assert.match(text(chip('send_button:long')), /「别的」在用/);
  chip('user_bubble:double').dispatch('click');
  chip('send_button:long').dispatch('click');
  assert.match(text(chip('send_button:long')), /会从「别的」改绑过来/);
  // 换成只作用 AI 回复的动作：用户气泡的选取自动拿掉
  byClass(overlay, 'uts-action').find(node => node.dataset.action === 'builtin:reply.regenerate').dispatch('click');
  assert.equal(chip('user_bubble:double').attributes['aria-pressed'], 'false');
  chip('assistant_bubble:double').dispatch('click');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  const saved = store.listTools().find(tool => tool.id !== other.id);
  assert.deepEqual(store.listBindings({ toolId: saved.id }).map(binding => `${binding.gesture.position}:${binding.gesture.gesture}`).sort(), ['assistant_bubble:double', 'send_button:long']);
  assert.equal(store.listBindings({ toolId: other.id }).length, 0, 'the long press moved over');
  const card = byClass(overlay, 'uts-tool').find(node => node.dataset.toolId === saved.id);
  assert.deepEqual(byClass(card, 'uts-chip').map(text), ['AI 气泡 · 双击', '发送键 · 长按']);
  // 再编辑：取消一个
  panel.show({ toolId: saved.id });
  chip('assistant_bubble:double').dispatch('click');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.deepEqual(store.listBindings({ toolId: saved.id }).map(binding => binding.gesture.position), ['send_button']);
  console.log('ok - gestures respect the action target, move from other tools and can be removed');
}

{
  // 脚本：选了带出范例；保存时确认能力（拒绝就不存）；能力没变再存不再问
  const asked = [];
  let answer = false;
  const { store, panel } = await setup({ confirmScriptCapabilities: async (payload) => { asked.push(payload.capabilities); return answer; } });
  panel.show({ create: true });
  const overlay = panel.overlay;
  byClass(overlay, 'uts-action').find(node => node.dataset.action === 'script:inline').dispatch('click');
  const code = field(overlay, 'code');
  assert.match(code.value, /return \{ notify/);
  const capability = id => walk(overlay).find(node => node.dataset.capability === id);
  assert.equal(capability('read').checked, true, 'reading the message is on by default');
  capability('model').checked = true;
  capability('model').dispatch('change');
  code.value = 'return { input: ctx.message.content };';
  code.dispatch('input');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.deepEqual(asked, [['read', 'model']]);
  assert.equal(store.listTools().length, 0, 'declining the capabilities does not save');
  answer = true;
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  const [tool] = store.listTools();
  assert.deepEqual(tool.script, { code: 'return { input: ctx.message.content };', capabilities: ['read', 'model'], approved: ['read', 'model'] });
  assert.match(byClass(overlay, 'uts-tool-desc')[0].textContent, /读消息与选区、调用模型／联网/);
  panel.show({ toolId: tool.id });
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.equal(asked.length, 2, 'unchanged capabilities are not asked again');
  panel.show({ toolId: tool.id });
  capability('input').checked = true;
  capability('input').dispatch('change');
  buttonLabeled(overlay, '保存').dispatch('click');
  await flush();
  assert.deepEqual(asked.at(-1), ['read', 'input', 'model'], 'a new capability is confirmed again');
  console.log('ok - script tools ask before saving the capabilities they declare');
}

{
  // 导出：只带勾选的工具，可不含绑定；导入：缺的 Agent 要对应，脚本要重新确认，冲突的绑定不绑
  const exported = [];
  let packText = null;
  const { store, panel } = await setup({ exportPack: async (pack, filename) => { exported.push([pack, filename]); return { saved: true }; }, pickPackText: async () => packText });
  const keep = await store.saveTool({ name: '删掉', icon: 'trash', action: { source: 'builtin', id: 'reply.delete', params: {} }, direct: true });
  await store.setShortcut(keep.id, { code: 'KeyD', alt: true, label: 'Alt + D' });
  await store.saveTool({ name: '重来', icon: 'regenerate', action: { source: 'builtin', id: 'reply.regenerate', params: {} } });
  panel.show();
  const overlay = panel.overlay;
  walk(overlay).find(node => node.dataset.key === 'export').dispatch('click');
  assert.equal(byClass(overlay, 'uts-form-title')[0].textContent, '导出工具包');
  const second = walk(overlay).find(node => node.dataset.exportTool && node.dataset.exportTool !== keep.id);
  second.checked = false;
  second.dispatch('change');
  field(overlay, 'includeBindings').checked = false;
  field(overlay, 'includeBindings').dispatch('change');
  walk(overlay).find(node => node.dataset.key === 'do-export').dispatch('click');
  await flush();
  assert.equal(exported.length, 1);
  assert.deepEqual(exported[0][0].tools.map(tool => [tool.name, 'shortcut' in tool]), [['删掉', false]]);
  assert.match(exported[0][1], /^omnitavern-tools-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(byClass(overlay, 'uts-flash')[0].textContent, '已导出 1 个工具');

  packText = JSON.stringify({
    format: 'omnitavern.tools', version: 1,
    tools: [
      { key: 't1', name: '删掉', icon: 'trash', direct: true, action: { source: 'builtin', id: 'reply.delete', params: {} }, shortcut: { code: 'KeyD', alt: true, label: 'Alt + D' }, gestures: [{ position: 'user_bubble', gesture: 'double' }] },
      { key: 't2', name: '外地润色', icon: 'pen', action: { source: 'agent', id: 'text-edit:far', params: {} } },
      { key: 't3', name: '脚本', icon: 'code', action: { source: 'script', id: 'inline', params: {} }, script: { code: 'return 1', capabilities: ['model'] } },
    ],
    requires: { agents: [{ id: 'text-edit:far', title: '远方的润色' }], plugins: [] },
  });
  walk(overlay).find(node => node.dataset.key === 'import').dispatch('click');
  await flush();
  assert.equal(byClass(overlay, 'uts-form-title')[0].textContent, '导入工具包');
  const notes = byClass(overlay, 'uts-pack-note').map(node => node.textContent);
  assert.ok(notes.some(note => note.includes('需要 Agent「远方的润色」')));
  assert.ok(notes.some(note => note.includes('确认它要用的能力（调用模型／联网）')));
  assert.ok(byClass(overlay, 'uts-chip').some(node => node.textContent === 'Alt + D（已被「删掉」使用，不绑定）'));
  assert.match(walk(overlay).find(node => node.dataset.key === 'do-import').children.at(-1).textContent, /导入（2 个）/, 'an unmapped agent tool is left out');
  const select = walk(overlay).find(node => node.dataset.agentFor === 't2');
  select.value = 'text-edit:polish';
  select.dispatch('change');
  walk(overlay).find(node => node.dataset.key === 'do-import').dispatch('click');
  await flush();
  assert.equal(byClass(overlay, 'uts-flash')[0].textContent, '已导入 3 个工具');
  const imported = store.listTools().slice(2);
  assert.deepEqual(imported.map(tool => [tool.name, tool.action.source, tool.action.id]), [['删掉 (2)', 'builtin', 'reply.delete'], ['外地润色', 'agent', 'text-edit:polish'], ['脚本', 'script', 'inline']]);
  assert.deepEqual(imported[2].script, { code: 'return 1', capabilities: ['model'], approved: [] }, 'imported scripts must be confirmed again');
  assert.deepEqual(store.listBindings({ toolId: imported[0].id }).map(binding => binding.kind), ['gesture'], 'the taken shortcut was skipped, the free gesture kept');
  // 坏文件：留在列表并说明
  packText = '{"format":"nope"}';
  walk(overlay).find(node => node.dataset.key === 'import').dispatch('click');
  await flush();
  assert.equal(byClass(overlay, 'uts-flash')[0].textContent, '这不是工具包文件');
  console.log('ok - tool packs export the chosen tools and import with mapping, re-approval and conflict skipping');
}

{
  // 删除确认、动作不在了的提示、返回键逐层
  const { store, panel } = await setup();
  await store.saveTool({ name: '旧 Agent', icon: 'pen', action: { source: 'agent', id: 'text-edit:gone', params: {} } });
  panel.show();
  const overlay = panel.overlay;
  assert.equal(byClass(overlay, 'uts-tool')[0].className.includes('is-broken'), true);
  assert.deepEqual(byClass(overlay, 'uts-chip').map(text), ['Agent 已不存在']);
  assert.equal(byClass(overlay, 'uts-tool-desc')[0].textContent, '动作不可用');
  walk(overlay).find(node => node.attributes['aria-label'] === '删除「旧 Agent」').dispatch('click');
  assert.match(byClass(overlay, 'uts-confirm')[0].children[0].textContent, /快捷键与手势也会一起移除/);
  assert.equal(panel.closeTopLayer(), true);
  assert.equal(byClass(overlay, 'uts-confirm').length, 0, 'Back cancels the delete confirmation');
  walk(overlay).find(node => node.attributes['aria-label'] === '删除「旧 Agent」').dispatch('click');
  buttonLabeled(byClass(overlay, 'uts-confirm')[0], '删除').dispatch('click');
  await flush();
  assert.equal(store.listTools().length, 0);
  assert.equal(panel.closeTopLayer(), true);
  assert.equal(panel.isOpen(), false);
  console.log('ok - deleting confirms in place and missing actions are flagged');
}

{
  // 工具箱管理清单：用户工具用自己的图示；有工具入口
  const config = { id: 'tool_abc123', title: '早安', kind: 'user_tool', enabled: true, icon: 'phrase', iconMarkup: '<svg data-tool></svg>' };
  assert.match(toolboxNamedIcon(config), /data-tool/);
  const markup = toolboxManagementMarkup({ items: [config], catalog: [config], ordering: false, shortcut: null, recording: false, shortcutError: '', expanded: false, userTools: true });
  assert.match(markup, /data-key="user-tools"/);
  assert.match(markup, /data-key="config:tool_abc123"/);
  assert.doesNotMatch(toolboxManagementMarkup({ items: [], catalog: [], ordering: false }), /user-tools/);
  console.log('ok - the toolbox management list shows user tools and links to their settings');
}

console.log('user-tool-settings-panel-tests passed');
