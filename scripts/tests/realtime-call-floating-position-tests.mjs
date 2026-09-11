import assert from 'node:assert/strict';
import { bindRealtimeCallFloatingPosition } from '../../src/scripts/ui/realtime/realtime-call-floating-position.js';

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (!listeners?.size) this.listeners.delete(type);
  }
  fire(type, props = {}) {
    const event = { preventDefault() { this.prevented = true; }, stopPropagation() {},
      stopImmediatePropagation() { this.stopped = true; }, ...props };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}

const doc = new Events(), handle = new Events(), win = new Events(), visual = new Events();
Object.assign(visual, { width: 1100, height: 800, offsetLeft: 0, offsetTop: 0 });
let frame = null, observed = 0, width = 284, height = 62, expanded = false;
Object.assign(win, {
  innerWidth: 1100, innerHeight: 800, visualViewport: visual,
  getComputedStyle: () => ({ paddingLeft: '10px', paddingRight: '10px', paddingTop: '30px', paddingBottom: '18px' }),
  requestAnimationFrame: callback => { frame = callback; return 1; },
  cancelAnimationFrame: () => { frame = null; },
  ResizeObserver: class { observe() { observed++; } disconnect() { observed--; } },
});
const classes = new Set();
const panel = {
  ownerDocument: doc,
  dataset: {},
  style: { setProperty(key, value) { this[key] = value; } },
  classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  getBoundingClientRect() {
    const left = Number.parseFloat(this.style.left) || 0, top = Number.parseFloat(this.style.top) || 0;
    const targetWidth = expanded ? 368 : this.dataset.dock === 'top' ? width : 88;
    const targetHeight = expanded ? 460 : this.dataset.dock === 'top' ? height : 88;
    const w = Math.min(targetWidth, Number.parseFloat(this.style['--realtime-call-available-width']) || targetWidth);
    const h = Math.min(targetHeight, Number.parseFloat(this.style['--realtime-call-available-height']) || targetHeight);
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  },
};
handle.setPointerCapture = () => {};
handle.releasePointerCapture = () => {};
const layer = { hidden: false };
const position = bindRealtimeCallFloatingPosition({ layer, panel, handle, windowLike: win, isExpanded: () => expanded, onExpandedChange: value => { expanded = value; } });
const rect = () => panel.getBoundingClientRect();
const flush = () => { const callback = frame; frame = null; callback?.(); };
const down = (id = 1) => handle.fire('pointerdown', { pointerId: id, button: 0, clientX: rect().left + 80, clientY: rect().top + 30 });

position.start();
assert.equal(rect().left + rect().width / 2, 550);
assert.equal(rect().top, 30, 'initial placement respects safe area');
position.start(); assert.equal(observed, 1, 'showing again keeps one observer');
const original = rect();
down();
doc.fire('pointermove', { pointerId: 2, clientX: 0, clientY: 0 });
assert.deepEqual(rect(), original, 'another pointer cannot move the pill');
doc.fire('pointermove', { pointerId: 1, clientX: 3000, clientY: 3000 });
assert(classes.has('is-dragging'));
handle.fire('lostpointercapture', { target: {}, pointerId: 1 });
assert(classes.has('is-dragging'), 'touch capture handoff from a child keeps dragging');
assert(rect().right <= 1090 && rect().bottom <= 782, 'drag past screen edges stays reachable');
doc.fire('pointerup', { pointerId: 1 });
assert(!classes.has('is-dragging'));
assert(handle.fire('click', { detail: 1 }).stopped, 'release click is consumed after dragging');
const preferred = rect();
assert.equal(panel.dataset.dock, 'right'); assert.equal(rect().width, 88);

// Expansion can move the panel temporarily; collapse returns to the user's pill position.
expanded = true; position.layout();
assert(rect().right <= 1090 && rect().bottom <= 782);
assert.equal(rect().left + rect().width / 2, 550, 'expanded call is centered');
expanded = false; position.layout();
assert.deepEqual(rect(), preferred);

// Mobile keyboards change the visual viewport without resizing the layout viewport.
Object.assign(visual, { width: 320, height: 270, offsetLeft: 5, offsetTop: 40 });
visual.fire('resize'); flush();
assert(rect().left >= 15 && rect().top >= 70 && rect().right <= 315 && rect().bottom <= 292);
Object.assign(visual, { width: 1100, height: 800, offsetLeft: 0, offsetTop: 0 });
visual.fire('resize'); flush();
assert.deepEqual(rect(), preferred, 'closing keyboard restores the preferred position');

down(); doc.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 60 });
doc.fire('pointercancel', { pointerId: 1 });
assert.deepEqual(rect(), preferred, 'cancelled gesture restores position');
down(); doc.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 60 });
win.fire('blur'); assert.deepEqual(rect(), preferred, 'window blur clears a pending drag');
down(); doc.fire('pointerup', { pointerId: 1 });
assert(!handle.fire('click', { detail: 1 }).stopped, 'a fresh tap after cancellation remains usable');
handle.fire('keydown', { key: 'Home', altKey: true });
assert.deepEqual(rect(), original, 'keyboard can return to the default location');

expanded = true; position.layout();
down(); doc.fire('pointermove', { pointerId: 1, clientX: 55, clientY: 410 });
assert.equal(expanded, false, 'dragging the expanded call minimizes it immediately');
doc.fire('pointercancel', { pointerId: 1 });
assert.equal(expanded, true, 'cancel restores the expanded state');
down(); doc.fire('pointermove', { pointerId: 1, clientX: 55, clientY: 410 });
doc.fire('pointerup', { pointerId: 1 });
assert.equal(panel.dataset.dock, 'left'); assert.equal(rect().left, 10); assert.equal(expanded, false);

win.fire('resize'); assert(frame);
position.stop();
assert.equal(frame, null); assert.equal(observed, 0);
for (const target of [doc, handle, win, visual]) assert.equal(target.listeners.size, 0, 'hidden widget releases global listeners');
position.start(); position.stop(); position.stop();
assert.equal(observed, 0);
console.log('realtime call floating position tests passed (bounds, gestures, visual viewport, keyboard and cleanup)');
