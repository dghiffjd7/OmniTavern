import assert from 'node:assert/strict';

import { createInlineEditUiRuntime } from '../../src/scripts/ui/chat/inline-edit-ui-utils.js';

const createFakeDocument = () => {
  const createClassList = () => {
    const classes = new Set();
    return {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    };
  };
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.classList = createClassList();
      this.className = '';
      this.textContent = '';
      this.value = '';
      this.dataset = {};
      this.scrollHeight = 72;
      this.listeners = new Map();
    }
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    emit(type, event = {}) {
      return this.listeners.get(type)?.(event);
    }
    focus() {
      this.focused = true;
    }
    setSelectionRange(start, end) {
      this.selection = [start, end];
    }
    blur() {
      this.emit('blur');
    }
  }
  return {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
};

{
  const documentLike = createFakeDocument();
  documentLike.body = { dataset: { uiMode: 'rp' } };
  const scheduled = [];
  const confirms = [];
  const bubble = {
    children: [],
    style: {},
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    textContent: '',
    innerHTML: '',
    appendChild(child) {
      this.children = [child];
      this.lastChild = child;
      return child;
    },
  };
  const scrollEl = {
    querySelector(selector) {
      if (selector === '[data-msg-id="m1"]') {
        return {
          classList: {
            add(value) { this.value = value; },
            remove(value) { if (this.value === value) this.value = ''; },
            contains(value) { return this.value === value; },
            value: '',
          },
          querySelector(nextSelector) {
            if (nextSelector === '.QQ_chat_msgdiv') return bubble;
            return null;
          },
        };
      }
      return null;
    },
  };
  const runtime = createInlineEditUiRuntime({
    documentLike,
    schedule: cb => scheduled.push(cb),
    onConfirmEdit: (message, text) => confirms.push([message.id, text]),
  });
  runtime.startInlineEdit({
    scrollEl,
    message: { id: 'm1', role: 'user', content: 'hello' },
  });
  const shell = bubble.lastChild;
  const textarea = shell.children[0];
  const saveButton = shell.children[2].children[1];
  textarea.value = '  next text  ';
  scheduled[0]();
  assert.equal(textarea.className, 'chat-inline-edit-textarea');
  assert.equal(textarea.dataset.viewportKeyboardDiagnostic, 'creative-user-bubble-edit');
  assert.equal(textarea.focused, true);
  assert.deepEqual(textarea.selection, [13, 13]);
  textarea.emit('keydown', {
    key: 'Enter',
    shiftKey: false,
    preventDefault() {},
  });
  assert.deepEqual(confirms, []);
  await saveButton.emit('click');
  assert.deepEqual(confirms, [['m1', '  next text  ']]);
  console.log('ok - startInlineEdit preserves whitespace and saves only through explicit action');
}

{
  // 量高度时先把编辑框收成 auto，聊天列表变短会把滚动位置截短；量完要放回原位置（编辑的气泡后面还有消息、列表在接近底部时会跳到气泡上方）
  const documentLike = createFakeDocument();
  const scheduled = [];
  const bubble = { children: [], style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, innerHTML: '',
    appendChild(child) { this.children = [child]; this.lastChild = child; return child; } };
  const scrollEl = {
    scrollTop: 600,
    querySelector(selector) {
      if (selector !== '[data-msg-id="m1"]') return null;
      return { classList: { add() {}, remove() {}, contains() { return false; } }, querySelector: next => (next === '.QQ_chat_msgdiv' ? bubble : null) };
    },
  };
  const runtime = createInlineEditUiRuntime({ documentLike, schedule: cb => scheduled.push(cb), onConfirmEdit: () => true });
  runtime.startInlineEdit({ scrollEl, message: { id: 'm1', role: 'user', content: 'long text' } });
  const textarea = bubble.lastChild.children[0];
  let height = '';
  textarea.style = {
    get height() { return height; },
    set height(value) { height = value; if (value === 'auto') scrollEl.scrollTop = Math.min(scrollEl.scrollTop, 205); },
  };
  textarea.emit('input');
  assert.equal(height, '72px');
  assert.equal(scrollEl.scrollTop, 600);
  console.log('ok - resizing the editor keeps the chat list scroll position');
}

{
  const documentLike = createFakeDocument();
  const renderedNode = { kind: 'rendered-rich-content' };
  const bubble = {
    children: [renderedNode],
    style: { whiteSpace: '' },
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    textContent: '',
    _innerHTML: '<article>rendered</article>',
    get childNodes() { return this.children; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      this.lastChild = child;
      return child;
    },
  };
  const scrollEl = {
    querySelector() {
      return {
        classList: {
          add(value) { this.value = value; },
          remove(value) { if (this.value === value) this.value = ''; },
          contains(value) { return this.value === value; },
          value: '',
        },
        querySelector() {
          return bubble;
        },
      };
    },
  };
  const runtime = createInlineEditUiRuntime({
    documentLike,
    schedule: cb => cb(),
    onConfirmEdit: () => {
      throw new Error('should not confirm on escape');
    },
  });
  runtime.startInlineEdit({
    scrollEl,
    message: { id: 'm2', content: 'origin' },
    initialText: '<status>raw origin</status>',
  });
  const textarea = bubble.lastChild.children[0];
  assert.equal(textarea.value, '<status>raw origin</status>');
  textarea.value = 'changed';
  textarea.emit('keydown', {
    key: 'Escape',
    preventDefault() {},
  });
  textarea.emit('blur');
  assert.deepEqual(bubble.children, [renderedNode]);
  assert.equal(bubble.style.whiteSpace, '');
  console.log('ok - startInlineEdit uses raw initial text while restoring the original rendered nodes on escape');
}

{
  const documentLike = createFakeDocument();
  const bubble = {
    children: [],
    style: {},
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    _innerHTML: '',
    get childNodes() { return this.children; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      this.lastChild = child;
      return child;
    },
  };
  const wrapper = {
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    querySelector() {
      return bubble;
    },
  };
  const saves = [];
  const runtime = createInlineEditUiRuntime({
    documentLike,
    schedule: cb => cb(),
    onConfirmEdit: async (_message, text) => {
      saves.push(text);
      return false;
    },
  });
  runtime.startInlineEdit({
    scrollEl: { querySelector: () => wrapper },
    message: {
      id: 'm3',
      content: 'rendered',
      raw: 'stored-regex',
      rawInput: '正则前原文',
    },
  });
  const shell = bubble.lastChild;
  const textarea = shell.children[0];
  const status = shell.children[1];
  const saveButton = shell.children[2].children[1];
  assert.equal(textarea.value, '正则前原文');
  textarea.value = '输入法内容';
  textarea.emit('compositionstart');
  textarea.emit('keydown', {
    key: 'Enter',
    ctrlKey: true,
    preventDefault() {},
  });
  assert.deepEqual(saves, []);
  textarea.emit('compositionend');
  await saveButton.emit('click');
  assert.deepEqual(saves, ['输入法内容']);
  assert.equal(wrapper.classList.contains('is-inline-editing'), true);
  assert.match(status.textContent, /仍保留/);
  console.log('ok - startInlineEdit uses pre-regex input, respects IME, and retains failed edits');
}

{
  // 精确指针（桌面）：Enter 直接保存，Shift+Enter 不保存，IME 组合中 Enter 不保存。
  const documentLike = createFakeDocument();
  const bubble = {
    children: [],
    style: {},
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    _innerHTML: '',
    get childNodes() { return this.children; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      this.lastChild = child;
      return child;
    },
  };
  const wrapper = {
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    querySelector() {
      return bubble;
    },
  };
  const saves = [];
  const runtime = createInlineEditUiRuntime({
    documentLike,
    windowLike: {
      matchMedia: query => ({ matches: query.includes('pointer: fine') }),
    },
    schedule: cb => cb(),
    onConfirmEdit: async (_message, text) => {
      saves.push(text);
      return true;
    },
  });
  runtime.startInlineEdit({
    scrollEl: { querySelector: () => wrapper },
    message: { id: 'm4', content: 'origin' },
  });
  const shell = bubble.lastChild;
  const textarea = shell.children[0];
  const status = shell.children[1];
  assert.match(status.textContent, /Enter 保存/);
  textarea.value = '第一次修改';
  textarea.emit('keydown', { key: 'Enter', shiftKey: true, preventDefault() {} });
  assert.deepEqual(saves, []);
  textarea.emit('compositionstart');
  textarea.emit('keydown', { key: 'Enter', preventDefault() {} });
  assert.deepEqual(saves, []);
  textarea.emit('compositionend');
  await textarea.emit('keydown', { key: 'Enter', preventDefault() {} });
  assert.deepEqual(saves, ['第一次修改']);
  console.log('ok - fine-pointer Enter saves directly while Shift+Enter and IME composition do not');
}

{
  // 点击气泡外直接取消编辑，不弹确认。
  const documentListeners = new Map();
  const documentLike = {
    ...createFakeDocument(),
    addEventListener(type, handler) { documentListeners.set(type, handler); },
    removeEventListener(type) { documentListeners.delete(type); },
  };
  const renderedNode = { kind: 'origin-node' };
  const bubble = {
    children: [renderedNode],
    style: { whiteSpace: '' },
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    _innerHTML: '<span>origin</span>',
    get childNodes() { return this.children; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      this.lastChild = child;
      return child;
    },
  };
  const wrapper = {
    classList: {
      add(value) { this.value = value; },
      remove(value) { if (this.value === value) this.value = ''; },
      contains(value) { return this.value === value; },
      value: '',
    },
    querySelector() {
      return bubble;
    },
  };
  const runtime = createInlineEditUiRuntime({
    documentLike,
    schedule: cb => cb(),
    onConfirmEdit: () => {
      throw new Error('clicking elsewhere must neither save nor cancel');
    },
  });
  runtime.startInlineEdit({
    scrollEl: { querySelector: () => wrapper },
    message: { id: 'm5', content: 'origin' },
  });
  const shell = bubble.lastChild;
  const textarea = shell.children[0];
  textarea.value = 'changed and kept';
  // 点击气泡外：不挂文档级监听，编辑保持原样，修改不丢
  assert.equal(documentListeners.has('pointerdown'), false, 'no outside-click listener is registered');
  assert.deepEqual(bubble.children, [shell]);
  assert.equal(textarea.value, 'changed and kept');
  assert.equal(wrapper.classList.contains('is-inline-editing'), true);
  console.log('ok - clicking outside the bubble keeps the edit open with its changes');
}
