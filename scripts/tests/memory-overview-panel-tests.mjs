import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMemoryOverviewPanel, describeMemoryFinding, formatMemoryAge } = await import('../../src/scripts/ui/memory-overview-panel.js');
const { memoryRoomEditorContext } = await import('../../src/scripts/memory/memory-overview-model.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
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
  insertAdjacentHTML(position, html) { this.innerHTML = position === 'afterbegin' ? html + this.innerHTML : this.innerHTML + html; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  async dispatch(type, event = {}) { await Promise.all((this.listeners.get(type) || []).map(handler => handler({ target: this, ...event }))); }
}
const doc = { head: new FakeElement('head'), body: new FakeElement('body'), createElement: tag => new FakeElement(tag), getElementById: () => null };
const walk = (node, out = []) => { out.push(node); node.children.forEach(child => walk(child, out)); return out; };
const byClass = (root, name) => walk(root).filter(node => node.className.split(' ').includes(name));
const buttonNamed = (root, label) => walk(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const NOW = 1_000_000_000;

{
  assert.equal(formatMemoryAge(NOW - 30 * 1000, NOW), '刚刚');
  assert.equal(formatMemoryAge(NOW - 3 * 60 * 1000, NOW), '3 分钟前');
  assert.equal(formatMemoryAge(NOW - 26 * 60 * 60 * 1000, NOW), '1 天前');
  assert.equal(formatMemoryAge(0, NOW), '');
  assert.deepEqual(memoryRoomEditorContext({ key: 'rp:a', kind: 'rp' }), { type: 'rp', contactId: 'rp:a' });
  assert.deepEqual(memoryRoomEditorContext({ key: 'g1', kind: 'group' }), { type: 'group', groupId: 'g1' });
  assert.deepEqual(memoryRoomEditorContext({ key: 'c1', kind: 'private' }), { type: 'contact', contactId: 'c1' });
  assert.deepEqual(memoryRoomEditorContext({ key: '', kind: 'global' }), { type: 'global' });
  const room = { key: 'c1', kind: 'private' };
  const described = describeMemoryFinding({ type: 'duplicate_rows', room, params: { tableName: '事件', count: 2, examples: ['一起去看海'] } }, { roomName: () => '苏晓彤' });
  assert.deepEqual([described.text, described.examples, described.action.kind], ['「苏晓彤」的「事件」有 2 条重复', ['一起去看海'], 'room']);
  assert.equal(describeMemoryFinding({ type: 'shared_heavy', params: { count: 25, sources: ['创意写作记忆'] } }).action.kind, 'share');
  console.log('ok - memory overview helpers format ages, editor contexts and findings');
}

const card = {
  templateId: 'default-v1', totalRows: 9, otherTemplates: [{ templateId: 'old-v0', rowCount: 2 }],
  rooms: [
    { key: 'rp:s', kind: 'rp', sessionId: 'rp:s', rowCount: 5, inactiveCount: 0, tableCount: 3, lastUpdatedAt: NOW - 3 * 60 * 1000 },
    { key: 'c1', kind: 'private', sessionId: 'c1', rowCount: 3, inactiveCount: 1, tableCount: 2, lastUpdatedAt: NOW - 2 * 24 * 60 * 60 * 1000 },
    { key: '', kind: 'global', sessionId: '', rowCount: 1, inactiveCount: 0, tableCount: 1, lastUpdatedAt: 0 },
  ],
};
const session = {
  sessionId: 'rp:s', room: { key: 'rp:s', kind: 'rp', sessionId: 'rp:s' }, storageMode: 'table',
  injection: { state: 'ok', localRows: 4, sharedRows: 2, trimmedRows: 1, tokens: 900, shared: [{ id: 'memory_bridge_chat_to_writing', label: '聊天记忆', rowCount: 2, trimmedCount: 0 }] },
  autoWrite: { enabled: true, mode: 'separate' }, pending: { count: 1, oldestAt: NOW - 60 * 1000 },
};
const names = { 'rp:s': '苏鸦', c1: '苏晓彤' };
const opened = [];
const mounted = [];
const panel = createMemoryOverviewPanel({
  documentRef: doc,
  now: () => NOW,
  load: async () => ({ cardName: '青梅竹马', templateName: '通用记忆模板', card, session, sessionName: '苏鸦' }),
  roomName: room => names[room.key] || room.key,
  mountRoomEditor: (container, room) => { mounted.push({ room: room.key, container }); return { destroy: () => mounted.push({ destroyed: room.key }) }; },
  runAudit: async ({ sessionId }) => ({ checkedAt: NOW, report: { findings: [
    { type: 'duplicate_rows', severity: 'warning', room: card.rooms[1], params: { tableName: '事件', count: 1, examples: ['重复的那行'] } },
    { type: 'auto_write_off', severity: 'info', params: {}, sessionId },
  ] } }),
  openTemplates: () => opened.push('templates'),
  openShare: sessionId => opened.push(`share:${sessionId}`),
  openAutoWriteSettings: () => opened.push('auto_write'),
  openPending: () => opened.push('pending'),
});

{
  // 两层：整张卡（各聊天室）与当前会话；旧模板单独提示
  await panel.show();
  const overlay = panel.overlay;
  assert.ok(panel.isOpen());
  const titles = byClass(overlay, 'mo-section-title').map(node => node.textContent);
  assert.deepEqual(titles, ['整张卡', '当前会话「苏鸦」', '记忆管家']);
  assert.deepEqual(byClass(overlay, 'mo-room-name').map(node => node.textContent), ['苏鸦', '苏晓彤', '全局／动态']);
  assert.deepEqual(byClass(overlay, 'mo-room-meta').map(node => node.textContent), ['创意写作 · 5 条 · 3 分钟前', '私聊 · 3 条 · 1 条停用 · 2 天前', '1 条']);
  const text = walk(overlay).map(node => node.textContent).join('\n');
  assert.match(text, /2 个聊天室 · 9 条 · 模板「通用记忆模板」/, 'global memory is not counted as a chat room');
  assert.match(text, /旧模板「old-v0」留下 2 条记忆，当前模板不会读取/);
  assert.match(text, /上次发送注入 4 条本会话记忆、2 条共享记忆，约 900 tokens/);
  assert.match(text, /裁掉 1 条（超出预算）/);
  assert.match(text, /自动写表：开 · 单独请求写入/);
  assert.match(text, /1 个记忆写入预览等待确认（最久 1 分钟前）/);
  assert.deepEqual(byClass(overlay, 'mo-chip').map(node => node.textContent), ['聊天记忆 · 2 条']);
  assert.equal(overlay.className.includes('is-open'), true);
  console.log('ok - the overview shows the whole card by room and the current session');
}

{
  // 聊天室在页内用表格编辑器打开；返回键先退出聊天室，再关总览
  const overlay = panel.overlay;
  await byClass(overlay, 'mo-room')[1].dispatch('click');
  assert.deepEqual(mounted.map(item => item.room), ['c1']);
  assert.equal(byClass(overlay, 'mo-title')[0].textContent, '苏晓彤');
  assert.equal(byClass(overlay, 'mo-icon-btn')[0].hidden, false, 'the back button shows inside a room');
  assert.equal(panel.closeTopLayer(), true);
  await tick();
  assert.deepEqual(mounted.at(-1), { destroyed: 'c1' }, 'leaving the room destroys its editor');
  assert.equal(byClass(overlay, 'mo-title')[0].textContent, '记忆总览');
  assert.equal(panel.isOpen(), true);
  console.log('ok - rooms open in place with the existing table editor and back returns to the overview');
}

{
  // 记忆管家：检查结果附「去处理」；跳到别的主界面前先关总览
  const overlay = panel.overlay;
  await buttonNamed(overlay, '检查').dispatch('click');
  await tick();
  const findings = byClass(overlay, 'mo-finding');
  assert.equal(findings.length, 2);
  assert.match(findings[0].innerHTML, /<svg/);
  assert.equal(byClass(findings[0], 'mo-line')[0].textContent, '「苏晓彤」的「事件」有 1 条重复');
  assert.equal(byClass(findings[0], 'mo-finding-example')[0].textContent, '重复的那行');
  await buttonNamed(findings[0], '打开表格').dispatch('click');
  assert.equal(mounted.at(-1).room, 'c1', 'a room finding opens that room');
  panel.closeTopLayer();
  await tick();
  await buttonNamed(byClass(panel.overlay, 'mo-finding')[1], '设置').dispatch('click');
  assert.deepEqual(opened, ['auto_write']);
  assert.equal(panel.isOpen(), false, 'handing off to another screen closes the overview first');

  await panel.show();
  await buttonNamed(panel.overlay, '管理共享').dispatch('click');
  await panel.show();
  await buttonNamed(panel.overlay, '去确认').dispatch('click');
  await panel.show();
  await buttonNamed(panel.overlay, '模板管理').dispatch('click');
  assert.deepEqual(opened, ['auto_write', 'share:rp:s', 'pending', 'templates']);
  console.log('ok - the steward reports with jump actions and hand-offs close the overview');
}

{
  // 读取失败与没有会话
  const failing = createMemoryOverviewPanel({ documentRef: doc, load: async () => { throw new Error('资料库没打开'); } });
  await failing.show();
  assert.match(walk(failing.overlay).map(node => node.textContent).join('\n'), /读取记忆失败：资料库没打开/);
  const empty = createMemoryOverviewPanel({ documentRef: doc, load: async () => ({ card: { rooms: [], otherTemplates: [], totalRows: 0 }, session: { sessionId: '' } }) });
  await empty.show();
  const text = walk(empty.overlay).map(node => node.textContent).join('\n');
  assert.match(text, /这张卡还没有记忆表格的内容。/);
  assert.match(text, /还没有打开会话。/);
  console.log('ok - load failures and empty cards are shown plainly');
}

console.log('memory-overview-panel-tests passed');
