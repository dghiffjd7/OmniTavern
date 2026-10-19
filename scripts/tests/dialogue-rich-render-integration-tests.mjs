import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.style = { cssText: '', setProperty() {}, removeProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this._innerHTML = '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    if (!this._innerHTML) this.children = [];
  }

  get innerHTML() { return this._innerHTML; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
  body: { dataset: {} },
  createElement: tagName => new FakeElement(tagName),
};
globalThis.window = { appBridge: null };

const { renderRichText } = await import('../../src/scripts/ui/chat/rich-text-renderer.js');

const highlighted = new FakeElement();
renderRichText(highlighted, '旁白“对白”收尾', { highlightDialogue: true });
assert.deepEqual(highlighted.children.map(child => [child.className, child.textContent]), [
  ['', '旁白'],
  ['rp-dialogue-text', '“对白”'],
  ['', '收尾'],
]);

const streaming = new FakeElement();
renderRichText(streaming, '旁白“尚未闭合', { highlightDialogue: true, streaming: true });
assert.equal(streaming.children.some(child => child.className === 'rp-dialogue-text'), false);
renderRichText(streaming, '旁白“已经闭合”', { highlightDialogue: true, streaming: true });
assert.equal(streaming.children.some(child => child.className === 'rp-dialogue-text'), true);

const disabled = new FakeElement();
renderRichText(disabled, '旁白“普通文字”', { highlightDialogue: false });
assert.equal(disabled.children.some(child => child.className === 'rp-dialogue-text'), false);

const source = fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/rich-text-renderer.js'), 'utf8');
assert.ok(source.indexOf("if (p.type === 'code')") < source.indexOf('segmentDialogueText(statusSeg)'));
assert.ok(source.indexOf('renderScopedRichFragment') < source.indexOf('segmentDialogueText(statusSeg)'));

console.log('ok - creative dialogue highlighting is explicit, streaming-safe, and isolated from rich routes');

{
  // 富文本片段（预设正则把吐槽、平行事件换成 HTML 后）：卡片外的正文照样着色，作者卡片、代码与状态卡里不着色
  class FakeNode {
    constructor(nodeType, { tagName = '', nodeValue = '', attrs = {} } = {}) {
      this.nodeType = nodeType;
      this.tagName = tagName.toUpperCase();
      this.nodeValue = nodeValue;
      this.attrs = { ...attrs };
      this.childNodes = [];
      this.parentNode = null;
      this.ownerDocument = fakeDoc;
    }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    set className(value) { this.attrs.class = value; }
    get className() { return this.attrs.class || ''; }
    set textContent(value) { this.childNodes = []; this.appendChild(fakeDoc.createTextNode(value)); }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
    appendChild(child) {
      const items = child.nodeType === 11 ? child.childNodes.splice(0) : [child];
      items.forEach(item => { item.parentNode = this; this.childNodes.push(item); });
      return child;
    }
    replaceChild(next, old) {
      const index = this.childNodes.indexOf(old);
      const items = next.nodeType === 11 ? next.childNodes.splice(0) : [next];
      items.forEach(item => { item.parentNode = this; });
      this.childNodes.splice(index, 1, ...items);
      return old;
    }
  }
  const fakeDoc = {
    createTextNode: value => new FakeNode(3, { nodeValue: String(value) }),
    createElement: tag => new FakeNode(1, { tagName: tag }),
    createDocumentFragment: () => new FakeNode(11),
  };
  const el = (tag, attrs, ...children) => {
    const node = new FakeNode(1, { tagName: tag, attrs });
    children.forEach(child => node.appendChild(typeof child === 'string' ? fakeDoc.createTextNode(child) : child));
    return node;
  };
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  const { highlightDialogueInFlow } = await import('../../src/scripts/ui/chat/rich-text-renderer.js');
  const root = new FakeNode(11);
  [
    el('style', {}, '.chat-rich-tucao-w{color:red}'),
    el('p', {}, '她抬头：“', el('strong', {}, '快走'), '！”', el('br', {}), '“跨行'),
    el('p', {}, '对白”不配对。'),
    el('details', { class: 'chat-rich-tucao-w' }, el('summary', {}, '吐槽'), el('p', {}, '卡片里“不着色”')),
    el('p', {}, '前文“被', el('span', { style: 'color:red' }, '卡片'), '隔开”'),
    el('div', { class: 'chat-variable-status-card' }, '“状态卡”'),
    el('pre', {}, el('code', {}, '"code"')),
    el('ul', {}, el('li', {}, '「列表对白」')),
  ].forEach(node => root.appendChild(node));
  highlightDialogueInFlow(root);
  const highlighted = [];
  const walk = node => node.childNodes.forEach(child => {
    if (child.className === 'rp-dialogue-text') highlighted.push(child.textContent);
    walk(child);
  });
  walk(root);
  assert.deepEqual(highlighted, ['“', '快走', '！”', '「列表对白」']);
  assert.equal(root.childNodes[1].textContent, '她抬头：“快走！”“跨行');
  console.log('ok - rich fragment narration is highlighted while author cards, code and status cards are left alone');
}
