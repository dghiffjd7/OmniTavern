import assert from 'node:assert/strict';

const { bindUserToolGestures, locateGestureTarget, GESTURE_DOUBLE_MS, GESTURE_LONG_MS } = await import('../../src/scripts/ui/tools/user-tool-gestures.js');

// 最小 DOM：节点有标签、类名、父节点；closest 支援「tag」「.a」「tag.a」与逗号分隔
class Node {
  constructor(tag, classes = '', parent = null, extra = {}) {
    this.tagName = tag.toUpperCase();
    this.classes = new Set(classes.split(' ').filter(Boolean));
    this.parent = parent;
    this.dataset = {};
    this.listeners = new Map();
    Object.assign(this, extra);
    const owner = this;
    this.classList = { add: name => owner.classes.add(name), remove: name => owner.classes.delete(name), contains: name => owner.classes.has(name) };
  }
  matches(selector) {
    return selector.split(',').map(item => item.trim()).some((one) => {
      if (one.startsWith('[')) return false;
      const [tag, ...classes] = one.split('.');
      return (!tag || tag.toUpperCase() === this.tagName) && classes.every(name => this.classes.has(name));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  contains(node) { for (let cur = node; cur; cur = cur.parent) if (cur === this) return true; return false; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  emit(type, event = {}) { const e = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...event }; (this.listeners.get(type) || []).forEach(fn => fn(e)); return e; }
}

const build = () => {
  const scrollEl = new Node('div', 'chat-scroll');
  const charmsg = new Node('div', 'QQ_chat_charmsg', scrollEl, { __chatappMessage: { id: 'a1', role: 'assistant' } });
  charmsg.dataset.msgId = 'a1';
  const charHead = new Node('img', 'QQ_chat_head', charmsg);
  const charStack = new Node('div', 'chat-message-stack', charmsg);
  const charText = new Node('p', '', new Node('div', 'QQ_chat_msgdiv', charStack));
  const charButton = new Node('button', '', charStack);
  const mymsg = new Node('div', 'QQ_chat_mymsg', scrollEl, { __chatappMessage: { id: 'u1', role: 'user' } });
  mymsg.dataset.msgId = 'u1';
  const myText = new Node('span', '', new Node('div', 'chat-message-stack', mymsg));
  return { scrollEl, charHead, charText, charButton, myText };
};

const setup = (bindings = {}, { generating = false, enabled = true } = {}) => {
  const dom = build();
  const sendBtn = new Node('button', 'send-btn');
  let clock = 1000;
  const timers = [];
  const runs = [];
  const sends = [];
  let guard = null;
  const state = { generating, enabled };
  const handle = bindUserToolGestures({
    documentRef: { defaultView: { getSelection: () => ({ toString: () => '', removeAllRanges() {} }), addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} },
    scrollEl: dom.scrollEl,
    sendBtn,
    findGesture: (position, gesture) => (bindings[`${position}:${gesture}`] ? { toolId: bindings[`${position}:${gesture}`] } : null),
    run: (toolId, options) => runs.push([toolId, options.messageId]),
    isEnabled: () => state.enabled,
    isGenerating: () => state.generating,
    setSendClickGuard: (fn) => { guard = fn; },
    performSend: () => sends.push(clock),
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: clock + ms, done: false }; timers.push(timer); return timer; },
    cancel: (timer) => { if (timer) timer.done = true; },
  });
  const advance = (ms) => {
    clock += ms;
    timers.filter(timer => !timer.done && timer.at <= clock).forEach((timer) => { timer.done = true; timer.fn(); });
  };
  return { ...dom, sendBtn, runs, sends, advance, state, handle, guard: () => guard?.() };
};

{
  const { scrollEl, charHead, charText, charButton, myText } = build();
  assert.deepEqual(locateGestureTarget(charText, scrollEl), { position: 'assistant_bubble', messageId: 'a1' });
  assert.deepEqual(locateGestureTarget(myText, scrollEl), { position: 'user_bubble', messageId: 'u1' });
  assert.deepEqual(locateGestureTarget(charHead, scrollEl), { position: 'message_avatar', messageId: 'a1' });
  assert.equal(locateGestureTarget(charButton, scrollEl), null, 'controls inside the bubble keep their own clicks');
  assert.equal(locateGestureTarget(new Node('div', 'outside'), scrollEl), null);
  console.log('ok - gesture targets resolve to bubbles and avatars but skip inner controls');
}

{
  // 滑鼠：原生 dblclick；没绑定就不碰
  const bound = setup({ 'assistant_bubble:double': 'tool_a' });
  const e = bound.scrollEl.emit('dblclick', { target: bound.charText });
  assert.equal(e.prevented, true);
  assert.deepEqual(bound.runs, [['tool_a', 'a1']]);
  bound.scrollEl.emit('dblclick', { target: bound.myText });
  assert.equal(bound.runs.length, 1, 'the user bubble has no binding here');
  const free = setup({});
  assert.equal(free.scrollEl.emit('dblclick', { target: free.charText }).prevented, undefined, 'unbound bubbles keep the native double-click');
  const disabled = setup({ 'assistant_bubble:double': 'tool_a' }, { enabled: false });
  disabled.scrollEl.emit('dblclick', { target: disabled.charText });
  assert.deepEqual(disabled.runs, []);
  console.log('ok - mouse double-clicks on bound bubbles run the tool once');
}

{
  // 触控：两次点按够近够快才算双击；之后浏览器补的 dblclick 不重复执行
  const t = setup({ 'user_bubble:double': 'tool_u' });
  const tap = (target, extra = {}) => t.scrollEl.emit('click', { target, pointerType: 'touch', clientX: 10, clientY: 10, ...extra });
  tap(t.myText);
  t.advance(150);
  tap(t.myText);
  assert.deepEqual(t.runs, [['tool_u', 'u1']]);
  t.scrollEl.emit('dblclick', { target: t.myText });
  assert.equal(t.runs.length, 1, 'the synthetic dblclick after a touch double tap is ignored');
  t.advance(1000);
  tap(t.myText);
  t.advance(GESTURE_DOUBLE_MS + 50);
  tap(t.myText);
  assert.equal(t.runs.length, 1, 'slow taps are two single taps');
  t.advance(1000);
  tap(t.myText);
  t.advance(100);
  tap(t.myText, { clientX: 200 });
  assert.equal(t.runs.length, 1, 'far apart taps are not a double tap');
  console.log('ok - touch double taps are detected by timing and distance');
}

{
  // 头像：只绑点击立即执行；只绑双击要两下；都绑了单击等一下
  const clickOnly = setup({ 'message_avatar:click': 'tool_c' });
  assert.equal(clickOnly.scrollEl.emit('click', { target: clickOnly.charHead }).stopped, true);
  assert.deepEqual(clickOnly.runs, [['tool_c', 'a1']]);
  const doubleOnly = setup({ 'message_avatar:double': 'tool_d' });
  doubleOnly.scrollEl.emit('click', { target: doubleOnly.charHead });
  doubleOnly.advance(GESTURE_DOUBLE_MS + 10);
  assert.deepEqual(doubleOnly.runs, [], 'a single click does nothing when only double is bound');
  doubleOnly.scrollEl.emit('click', { target: doubleOnly.charHead });
  doubleOnly.advance(100);
  doubleOnly.scrollEl.emit('click', { target: doubleOnly.charHead });
  assert.deepEqual(doubleOnly.runs, [['tool_d', 'a1']]);
  const both = setup({ 'message_avatar:click': 'tool_c', 'message_avatar:double': 'tool_d' });
  both.scrollEl.emit('click', { target: both.charHead });
  assert.deepEqual(both.runs, [], 'the click waits to rule out a double click');
  both.advance(GESTURE_DOUBLE_MS + 10);
  assert.deepEqual(both.runs, [['tool_c', 'a1']]);
  both.scrollEl.emit('click', { target: both.charHead });
  both.advance(100);
  both.scrollEl.emit('click', { target: both.charHead });
  both.advance(GESTURE_DOUBLE_MS + 10);
  assert.deepEqual(both.runs, [['tool_c', 'a1'], ['tool_d', 'a1']], 'a double click runs only the double tool');
  console.log('ok - avatar clicks and double clicks coordinate only when both are bound');
}

{
  // 发送键长按：到时间执行、吞掉随后的点击；移动或放开取消；生成中不触发
  const s = setup({ 'send_button:long': 'tool_l' });
  s.sendBtn.emit('pointerdown', { button: 0, clientX: 5, clientY: 5 });
  assert.equal(s.sendBtn.classes.has('is-tool-holding'), true);
  s.advance(GESTURE_LONG_MS + 10);
  assert.deepEqual(s.runs, [['tool_l', '']]);
  assert.equal(s.guard(), true, 'the click after a long press does not send');
  s.advance(1000);
  assert.equal(s.guard(), false, 'later clicks send normally');
  s.sendBtn.emit('pointerdown', { button: 0, clientX: 5, clientY: 5 });
  s.sendBtn.emit('pointermove', { clientX: 40, clientY: 5 });
  s.advance(GESTURE_LONG_MS + 10);
  s.sendBtn.emit('pointerdown', { button: 0, clientX: 5, clientY: 5 });
  s.advance(200);
  s.sendBtn.emit('pointerup', {});
  s.advance(GESTURE_LONG_MS);
  assert.equal(s.runs.length, 1, 'moving or releasing early cancels the long press');
  assert.equal(s.sendBtn.emit('contextmenu', {}).prevented, true);
  s.state.generating = true;
  s.sendBtn.emit('pointerdown', { button: 0 });
  s.advance(GESTURE_LONG_MS + 10);
  assert.equal(s.runs.length, 1, 'while generating the send key stays a stop button');
  console.log('ok - long-pressing the send key runs its tool and swallows the click');
}

{
  // 触屏长按：Android WebView 到系统长按时间（约 0.5 秒，早于 GESTURE_LONG_MS）先送 pointercancel 再送 contextmenu，
  // 这就是长按成功；滑动造成的 pointercancel 后面没有 contextmenu，照样取消
  const s = setup({ 'send_button:long': 'tool_l' });
  s.sendBtn.emit('pointerdown', { button: 0, pointerType: 'touch', clientX: 5, clientY: 5 });
  s.advance(495);
  s.sendBtn.emit('pointercancel', { pointerType: 'touch' });
  assert.equal(s.sendBtn.emit('contextmenu', { pointerType: 'touch' }).prevented, true);
  assert.deepEqual(s.runs, [['tool_l', '']], 'the system long press completes the gesture');
  assert.equal(s.sendBtn.classes.has('is-tool-holding'), false);
  s.advance(GESTURE_LONG_MS);
  assert.equal(s.runs.length, 1, 'the timer does not run it a second time');
  assert.equal(s.guard(), true, 'the click after it does not send');
  s.advance(1000);
  s.sendBtn.emit('pointerdown', { button: 0, pointerType: 'touch', clientX: 5, clientY: 5 });
  s.advance(120);
  s.sendBtn.emit('pointercancel', { pointerType: 'touch' });
  s.advance(1000);
  s.sendBtn.emit('contextmenu', {});
  assert.equal(s.runs.length, 1, 'a cancel from scrolling is not a long press');
  const mouse = setup({ 'send_button:long': 'tool_l' });
  mouse.sendBtn.emit('pointerdown', { button: 2, pointerType: 'mouse' });
  mouse.sendBtn.emit('contextmenu', {});
  assert.deepEqual(mouse.runs, [], 'a right click is not a long press');
  console.log('ok - a touch long press completes on the system long-press signal');
}

{
  // 发送键双击：单击等一下才送出；两下就执行工具不送出；生成中不拦
  const d = setup({ 'send_button:double': 'tool_2' });
  assert.equal(d.guard(), true);
  assert.deepEqual(d.sends, []);
  d.advance(GESTURE_DOUBLE_MS + 10);
  assert.equal(d.sends.length, 1, 'a single click sends after the double-click window');
  assert.equal(d.guard(), true);
  d.advance(100);
  assert.equal(d.guard(), true);
  d.advance(GESTURE_DOUBLE_MS + 10);
  assert.deepEqual([d.runs, d.sends.length], [[['tool_2', '']], 1], 'a double click runs the tool and sends nothing');
  d.state.generating = true;
  assert.equal(d.guard(), false, 'stopping a generation is never delayed');
  const none = setup({});
  assert.equal(none.guard(), false, 'without a binding the send key is untouched');
  console.log('ok - double-clicking the send key runs its tool, single clicks still send');
}

console.log('user-tool-gestures-tests passed');
