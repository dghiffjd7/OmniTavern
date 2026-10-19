import assert from 'node:assert/strict';

import { resolveHelpTrigger, computeTooltipPlacement } from '../../src/scripts/ui/help-tooltip.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- resolveHelpTrigger：可点控件=press（长按），纯标题=tap（点一下） ---
const fakeEl = (tag, { role = '', mode = '', href = '' } = {}) => ({
  matches(sel) {
    const parts = sel.split(',').map(s => s.trim());
    return parts.some((p) => {
      if (p === tag) return true;
      if (p === 'a[href]') return tag === 'a' && !!href;
      if (p.startsWith('[role="') && role) return p === `[role="${role}"]`;
      return false;
    });
  },
  getAttribute(name) {
    if (name === 'data-help-mode') return mode;
    return '';
  },
});

test('resolveHelpTrigger: button → press (长按出说明)', () => {
  assert.equal(resolveHelpTrigger(fakeEl('button')), 'press');
});

test('resolveHelpTrigger: 纯 div/span 标题 → tap (点一下出说明)', () => {
  assert.equal(resolveHelpTrigger(fakeEl('div')), 'tap');
  assert.equal(resolveHelpTrigger(fakeEl('span')), 'tap');
});

test('resolveHelpTrigger: a[href] / role=switch → press', () => {
  assert.equal(resolveHelpTrigger(fakeEl('a', { href: '#' })), 'press');
  assert.equal(resolveHelpTrigger(fakeEl('div', { role: 'switch' })), 'press');
});

test('resolveHelpTrigger: 裸 a（无 href）→ tap', () => {
  assert.equal(resolveHelpTrigger(fakeEl('a')), 'tap');
});

test('resolveHelpTrigger: data-help-mode 显式覆盖', () => {
  assert.equal(resolveHelpTrigger(fakeEl('button', { mode: 'tap' })), 'tap');
  assert.equal(resolveHelpTrigger(fakeEl('div', { mode: 'press' })), 'press');
});

test('resolveHelpTrigger: 空/无效元素兜底 tap', () => {
  assert.equal(resolveHelpTrigger(null), 'tap');
  assert.equal(resolveHelpTrigger({}), 'tap');
});

// --- computeTooltipPlacement：优先下方，放不下翻上，水平夹在视口内 ---
const vp = { width: 400, height: 800 };

test('placement: 下方有空间 → bottom', () => {
  const r = { left: 100, top: 100, bottom: 120, width: 80, height: 20 };
  const p = computeTooltipPlacement(r, { width: 200, height: 60 }, vp);
  assert.equal(p.placement, 'bottom');
  assert.equal(p.top, 128); // bottom + gap(8)
});

test('placement: 靠底部放不下 → 翻到 top', () => {
  const r = { left: 100, top: 760, bottom: 785, width: 80, height: 25 };
  const p = computeTooltipPlacement(r, { width: 200, height: 60 }, vp);
  assert.equal(p.placement, 'top');
  assert.equal(p.top, 760 - 8 - 60); // top - gap - tipHeight
});

test('placement: 左对齐锚点左边、并夹进视口左右边', () => {
  // 锚点在最右，浮层会顶到右边界并被夹住
  const r = { left: 380, top: 100, bottom: 120, width: 20, height: 20 };
  const p = computeTooltipPlacement(r, { width: 200, height: 60 }, vp);
  assert.equal(p.left, vp.width - 200 - 8); // 192，夹在右边距
  // 锚点在最左
  const r2 = { left: 0, top: 100, bottom: 120, width: 20, height: 20 };
  const p2 = computeTooltipPlacement(r2, { width: 200, height: 60 }, vp);
  assert.equal(p2.left, 8); // 夹在左边距 gap
});

test('placement: 宽 block 标签 → 左对齐锚点左边缘（不居中飘到中间）', () => {
  const r = { left: 100, top: 100, bottom: 120, width: 300, height: 20 }; // 整行标签
  const p = computeTooltipPlacement(r, { width: 200, height: 60 }, vp);
  assert.equal(p.left, 100); // 左对齐 100，而非居中 (100+150-100=150)
});

test('placement: 顶部和底部都放不下 → 仍回落 bottom（不越界翻上）', () => {
  const r = { left: 100, top: 5, bottom: 790, width: 80, height: 785 };
  const p = computeTooltipPlacement(r, { width: 200, height: 60 }, vp);
  // top 空间不足(top-gap-th = 5-8-60 < gap) → 不翻上，保持 bottom
  assert.equal(p.placement, 'bottom');
});

// --- initHelpTooltips 事件流：假 document/window + 手动推进的计时器；每个用例载入一份新模块（模块内只初始化一次） ---
let caseSeq = 0;
const setupTooltips = async () => {
  const listeners = [];
  const timers = [];
  let now = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const t = { fn, at: now + ms, done: false }; timers.push(t); return t; };
  globalThis.clearTimeout = (t) => { if (t) t.done = true; };
  const restore = () => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; };
  const advance = (ms) => {
    now += ms;
    for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.fn(); }
  };
  const rect = { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
  const makeEl = ({ tag = 'div', attrs = {}, focusVisible = false } = {}) => {
    const el = {
      tag, attrs: { ...attrs }, id: attrs.id || '', style: {}, dataset: {}, children: [],
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
      },
      getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      closest(sel) { return sel === '[data-help]' && this.getAttribute('data-help') != null ? this : null; },
      matches(sel) {
        if (sel === ':focus-visible') return focusVisible;
        return sel.split(',').map(s => s.trim()).includes(tag);
      },
      contains(node) { return node === this || this.children.includes(node); },
      getBoundingClientRect() { return rect; },
      querySelector() { return null; },
      appendChild(child) { this.children.push(child); return child; },
    };
    return el;
  };
  const tipParts = { title: makeEl(), body: makeEl() };
  const doc = {
    body: makeEl({ tag: 'body' }),
    createElement() {
      const tip = makeEl();
      tip.querySelector = sel => (sel.includes('title') ? tipParts.title : tipParts.body);
      tip.children.push(tipParts.title, tipParts.body);
      return tip;
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
  };
  const win = { innerWidth: 400, innerHeight: 800, addEventListener() {} };
  caseSeq += 1;
  const mod = await import(`../../src/scripts/ui/help-tooltip.js?case=${caseSeq}`);
  mod.initHelpTooltips({ document: doc, window: win });
  const tip = doc.body.children[0];
  const fire = (type, target, extra = {}) => {
    const event = {
      type, target, pointerType: 'touch', clientX: 50, clientY: 20, relatedTarget: null, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
      ...extra,
    };
    for (const l of listeners) if (l.type === type) l.fn(event);
    return event;
  };
  return { makeEl, fire, advance, restore, tipVisible: () => tip.classList.contains('is-visible') };
};

test('手机短按带说明的按钮：不出说明、原 click 放行，之后的点击也不会被吞', async () => {
  const h = await setupTooltips();
  try {
    const button = h.makeEl({ tag: 'button', attrs: { 'data-help': '导出说明', 'data-help-mode': 'press' } });
    const other = h.makeEl({ tag: 'button' });
    h.fire('pointerdown', button);
    h.advance(80);
    h.fire('pointerup', button);
    assert.equal(h.fire('click', button).defaultPrevented, false);
    h.advance(500);
    assert.equal(h.tipVisible(), false, '短按松手后长按计时不应再触发');
    assert.equal(h.fire('click', other).defaultPrevented, false, '下一次点击不应被吞');
  } finally { h.restore(); }
});

test('手机长按带说明的按钮：450ms 出说明，并只吞掉随后那一次 click', async () => {
  const h = await setupTooltips();
  try {
    const button = h.makeEl({ tag: 'button', attrs: { 'data-help': '导出说明' } });
    const other = h.makeEl({ tag: 'button' });
    h.fire('pointerdown', button);
    h.advance(460);
    assert.equal(h.tipVisible(), true);
    h.fire('pointerup', button);
    assert.equal(h.fire('click', button).defaultPrevented, true);
    assert.equal(h.fire('click', other).defaultPrevented, false);
  } finally { h.restore(); }
});

test('手机按下后滑动（滚动）：取消长按，不出说明', async () => {
  const h = await setupTooltips();
  try {
    const button = h.makeEl({ tag: 'button', attrs: { 'data-help': '导出说明' } });
    h.fire('pointerdown', button);
    h.fire('pointermove', button, { clientY: 60 });
    h.advance(500);
    assert.equal(h.tipVisible(), false);
  } finally { h.restore(); }
});

test('聚焦：键盘聚焦（:focus-visible）出说明，触控点按造成的聚焦不出', async () => {
  const h = await setupTooltips();
  try {
    const tapped = h.makeEl({ tag: 'button', attrs: { 'data-help': '说明' }, focusVisible: false });
    h.fire('focusin', tapped);
    assert.equal(h.tipVisible(), false);
    const tabbed = h.makeEl({ tag: 'button', attrs: { 'data-help': '说明' }, focusVisible: true });
    h.fire('focusin', tabbed);
    assert.equal(h.tipVisible(), true);
    h.fire('focusout', tabbed);
    assert.equal(h.tipVisible(), false);
  } finally { h.restore(); }
});

test('手机点纯标题：点一下出、再点收，并吞掉标题的 click', async () => {
  const h = await setupTooltips();
  try {
    const label = h.makeEl({ tag: 'span', attrs: { 'data-help': '标题说明' } });
    h.fire('pointerdown', label);
    h.fire('pointerup', label);
    assert.equal(h.tipVisible(), true);
    assert.equal(h.fire('click', label).defaultPrevented, true);
    h.fire('pointerdown', label);
    h.fire('pointerup', label);
    assert.equal(h.tipVisible(), false);
  } finally { h.restore(); }
});

test('长按出说明的控件不让手机选字（否则系统选字菜单和说明一起弹出）', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../src/assets/css/main.css', import.meta.url), 'utf8');
  const rule = css.match(/([^{}]*button\[data-help\][^{}]*)\{([^}]*)\}/);
  assert.ok(rule, 'main.css 要有 button[data-help] 的规则');
  for (const selector of ['button[data-help]', '[role="button"][data-help]', '[data-help-mode="press"]']) {
    assert.ok(rule[1].includes(selector), `规则要包含 ${selector}`);
  }
  assert.match(rule[2], /(^|[;\s])user-select:\s*none/);
  assert.match(rule[2], /-webkit-user-select:\s*none/);
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok - ${t.name}`); }
  catch (err) { failed += 1; console.error(`not ok - ${t.name}`); console.error(err); }
}
if (failed > 0) process.exit(1);
