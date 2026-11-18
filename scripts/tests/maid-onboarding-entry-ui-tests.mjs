import assert from 'node:assert/strict';

const { createMaidOnboardingEntryUi } = await import('../../src/scripts/ui/maid-onboarding-entry-ui.js');

// 最小假 DOM：只做气泡用到的部分
const makeElement = (tag) => {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: '', textContent: '', innerHTML: '', listeners: {},
    style: { setProperty(name, value) { this[name] = value; } },
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, append(...items) { this.children.push(...items); }, appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    remove() { this.removed = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 84, right: 320, bottom: 84 }),
  };
  return el;
};

const createHarness = () => {
  const timers = [];
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.disconnected = true; this.targets = []; }
  }
  const documentRef = {
    head: makeElement('head'), body: makeElement('body'),
    createElement: makeElement, getElementById: () => null,
  };
  const windowRef = { innerWidth: 430, innerHeight: 932, addEventListener() {}, removeEventListener() {}, MutationObserver: FakeMutationObserver };
  const ui = createMaidOnboardingEntryUi({
    documentRef, windowRef,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const flushTimers = () => { timers.splice(0).filter(t => !t.cleared).forEach(t => t.fn()); };
  return { ui, documentRef, observers, flushTimers };
};

{
  // 首次开 APP：气泡出现时小球还在画面中央，随后才移到底部（带 0.22 秒过渡）。气泡要跟着小球停稳的位置重新对齐。
  const { ui, documentRef, observers, flushTimers } = createHarness();
  let ballRect = { left: 202, top: 453, width: 26, height: 26, right: 228, bottom: 479 };
  const ball = makeElement('div');
  ball.getBoundingClientRect = () => ballRect;
  assert.equal(ui.showHint({ anchorEl: ball }), true);
  const hint = documentRef.body.children.find(el => el.className === 'maid-onboarding-hint');
  assert.equal(hint.style.top, `${453 - 84 - 12}px`, 'first placed above the ball where it is now');

  // 小球被移到底部：观察到小球的 style 变化 → 等它停稳后重新对齐
  const watcher = observers.find(o => o.targets.some(t => t.target === ball));
  assert.ok(watcher, 'the hint watches the ball while it is shown');
  ballRect = { left: 202, top: 837, width: 26, height: 26, right: 228, bottom: 863 };
  watcher.callback([{ type: 'attributes', attributeName: 'style' }]);
  flushTimers();
  assert.equal(hint.style.top, `${837 - 84 - 12}px`, 'realigned above the ball after it settles');
  assert.equal(hint.dataset.placement, 'above');

  // 关掉气泡就不再跟踪
  ui.hideHint();
  assert.equal(watcher.disconnected, true);
  console.log('ok - the first-run hint follows the maid ball after it moves into place');
}

console.log('maid-onboarding-entry-ui-tests passed');
