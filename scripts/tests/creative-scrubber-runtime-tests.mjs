import assert from 'node:assert/strict';
import { createCreativeScrubber } from '../../src/scripts/ui/chat/creative-scrubber.js';
import { layoutScrubberItems } from '../../src/scripts/ui/chat/creative-scrubber-model.js';

import {
  buildCreativeScrubberIndex,
  matchSummaryForReply,
  matchTableSummaryForTurn,
} from '../../src/scripts/ui/chat/creative-scrubber-runtime.js';

{
  // 只收对话消息；轮次按「你发了几条」计算；开场白（第一条 AI）没有轮次
  const { entries, indexById } = buildCreativeScrubberIndex([
    { id: 'g', role: 'assistant', content: '开场白', timestamp: 1 },
    { id: 'u1', role: 'user', rawInput: '原文输入', raw: '存储版', content: '<b>美化版</b>', timestamp: 2 },
    { id: 'd', role: 'system', type: 'divider', content: '以下为未读讯息' },
    { id: 'a1', role: 'assistant', content: '正文'.repeat(1000), timestamp: 3 },
    { id: 'x', role: 'assistant', content: '临时', meta: { transient: true } },
    { id: 'u2', role: 'user', content: '第二条', timestamp: 4 },
  ]);
  assert.deepEqual(entries.map(e => `${e.id}:${e.role}:${e.turn}`), ['g:ai:0', 'u1:user:1', 'a1:ai:1', 'u2:user:2']);
  assert.equal(entries[1].source, '原文输入');
  assert.equal(entries[2].source.length, 1600);
  assert.equal(indexById.get('a1'), 3);
  console.log('ok - scrubber index keeps conversation messages with turn numbers and raw input');
}

{
  const summaries = [{ at: 1_000, text: '太早' }, { at: 10_400, text: '这一条' }, { at: 400_000, text: '太晚' }];
  assert.equal(matchSummaryForReply(summaries, 10_000)?.text, '这一条');
  assert.equal(matchSummaryForReply(summaries, 100_000), null);
  assert.equal(matchSummaryForReply(summaries, 0), null);
  console.log('ok - summary-mode previews match the summary written right after the reply');
}

{
  const rows = [
    { row_data: { summary: '第 1–20 轮合并', _coverage: { from: 1, to: 20 } } },
    { row_data: { summary: '第 12 轮', _coverage: { from: 12, to: 12 } } },
    { row_data: { summary: '', _coverage: { from: 13, to: 13 } } },
  ];
  assert.equal(matchTableSummaryForTurn(rows, 12)?.text, '第 12 轮');
  assert.deepEqual(matchTableSummaryForTurn(rows, 13), { text: '第 1–20 轮合并', from: 1, to: 20, span: 19 });
  assert.equal(matchTableSummaryForTurn(rows, 30), null);
  console.log('ok - table-mode previews prefer the single-turn row over merged summaries');
}


// 刻度条界面的假 DOM：宿主与聊天区都在原点、宽 940 高 600；刻度条按它的 style 算位置。
// 由此 place() 得到：刻度条 top 12、高 576、右缘 x=938，宽 40（手机 30）。
const RAIL = { top: 12, height: 576, right: 938 };
const createFakeDom = () => {
  class Element {
    children = [];
    parent = null;
    dataset = {};
    handlers = {};
    style = { setProperty() {} };
    className = '';
    hidden = false;
    textContent = '';
    get classList() {
      const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        contains: token => tokens().has(token),
        add: (...names) => { const next = tokens(); names.forEach(n => next.add(n)); this.className = [...next].join(' '); },
        remove: (...names) => { const next = tokens(); names.forEach(n => next.delete(n)); this.className = [...next].join(' '); },
        toggle: (token, on) => (on ? this.classList.add(token) : this.classList.remove(token)),
      };
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent?.removeChild(node);
        node.parent = this;
        this.children.push(node);
      }
    }
    removeChild(node) { this.children = this.children.filter(child => child !== node); node.parent = null; }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...nodes); }
    remove() { this.parent?.removeChild(this); }
    setAttribute() {}
    addEventListener(name, listener) { this.handlers[name] = listener; }
    setPointerCapture() {}
    releasePointerCapture() {}
    querySelector() { return null; }
    get offsetHeight() { return 60; }
    getBoundingClientRect() {
      if (this.rect) return this.rect;
      const px = value => parseFloat(value) || 0;
      const top = px(this.style.top), height = px(this.style.height), width = px(this.style.width);
      const right = 940 - px(this.style.right);
      return { top, bottom: top + height, height, left: right - width, right, width };
    }
  }
  const host = new Element();
  const scrollEl = new Element();
  host.rect = scrollEl.rect = { top: 0, bottom: 600, height: 600, left: 0, right: 940, width: 940 };
  return { documentRef: { createElement: () => new Element() }, host, scrollEl };
};

// 第 k 项（0 起）在屏幕上的 y：与刻度条用同一套排列
const itemClientY = (items, k, { coarse = false } = {}) => (
  RAIL.top + layoutScrubberItems(items, RAIL.height, { centerRatio: coarse ? 0.64 : 0.5 }).ys[k]
);
const THREE = [{ t: 'tick', i: 1 }, { t: 'tick', i: 2 }, { t: 'tick', i: 3 }];

const mountScrubber = (options = {}) => {
  const { documentRef, host, scrollEl } = createFakeDom();
  const jumps = [];
  const frames = [];
  const scrubber = createCreativeScrubber({
    documentRef, hostEl: host, scrollEl,
    getTotal: () => 3, getCurrent: () => 1,
    onJump: index => jumps.push(index),
    isCoarsePointer: () => false,
    prefersReducedMotion: () => true,
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame: () => {},
    ...options,
  });
  scrubber.setVisible(true);
  const [rail, preview] = host.children;
  const hit = rail.children.find(el => el.className === 'creative-scrubber-hit');
  const glow = rail.children.find(el => el.className === 'creative-scrubber-glow');
  const items = rail.children.find(el => el.className === 'creative-scrubber-items');
  // 跑完排队的动画帧（减少动态效果时一帧就到位）
  const flush = () => { for (let guard = 0; frames.length && guard < 50; guard += 1) frames.shift()(); };
  const pointer = (x, y, pointerType = '') => ({ button: 0, pointerId: 1, pointerType, clientX: x, clientY: y, preventDefault() {} });
  return { scrubber, rail, preview, hit, glow, items, jumps, flush, pointer };
};

{
  // 鼠标：条外松开取消（即使没有收到最后一帧 pointermove），移回已预览刻度后松开仍跳转
  const { scrubber, preview, hit, jumps, pointer } = mountScrubber();
  try {
    const y2 = itemClientY(THREE, 1);
    hit.handlers.pointerdown(pointer(920, y2));
    assert.equal(preview.dataset.index, '2');
    hit.handlers.pointerup(pointer(500, y2));
    assert.deepEqual(jumps, [], '左侧松开必须取消跳转');
    hit.handlers.pointerdown(pointer(920, y2));
    hit.handlers.pointermove(pointer(1000, y2));
    assert.equal(preview.hidden, true, '移出右侧应隐藏预览');
    hit.handlers.pointerup(pointer(1000, y2));
    assert.deepEqual(jumps, [], '右侧松开必须取消跳转');
    hit.handlers.pointerdown(pointer(920, y2));
    hit.handlers.pointermove(pointer(500, y2));
    hit.handlers.pointermove(pointer(920, y2));
    hit.handlers.pointerup(pointer(920, y2));
    assert.deepEqual(jumps, [2], '重新移回已预览刻度后松开仍应跳转');
    console.log('ok - pointer release outside the scrubber cancels while returning inside still jumps');
  } finally {
    scrubber.destroy();
  }
}

{
  // 手指按住拖动：横向往左在弧的延伸之外再容忍 60px，上下拖过头停在首尾刻度；鼠标维持严格判断。手机上整条放低（0.64）
  const { scrubber, hit, jumps, pointer } = mountScrubber({ isCoarsePointer: () => true });
  try {
    const y2 = itemClientY(THREE, 1, { coarse: true });
    hit.handlers.pointerdown(pointer(920, y2, 'touch'));
    hit.handlers.pointermove(pointer(860, y2, 'touch'));
    hit.handlers.pointerup(pointer(860, y2, 'touch'));
    assert.deepEqual(jumps, [2], '手指往左偏 48px 松开仍跳转');
    hit.handlers.pointerdown(pointer(920, y2, 'touch'));
    hit.handlers.pointerup(pointer(700, y2, 'touch'));
    assert.deepEqual(jumps, [2], '手指偏出弧外 60px 以上松开取消');
    hit.handlers.pointerdown(pointer(920, y2, 'touch'));
    hit.handlers.pointermove(pointer(920, 700, 'touch'));
    hit.handlers.pointerup(pointer(920, 700, 'touch'));
    assert.deepEqual(jumps, [2, 3], '往下拖过头停在最后一条');
    hit.handlers.pointerdown(pointer(920, y2, 'mouse'));
    hit.handlers.pointerup(pointer(860, y2, 'mouse'));
    assert.deepEqual(jumps, [2, 3], '鼠标仍按严格判断：条外松开取消');
    console.log('ok - touch drags tolerate drifting off the narrow scrubber while mouse stays strict');
  } finally {
    scrubber.destroy();
  }
}

{
  // 不在底部时最后一道刻度下面有回底箭头：悬停提示，按住松开回到底部；回到底部后箭头收起
  let atBottom = false;
  let bottomJumps = 0;
  const { scrubber, preview, hit, jumps, pointer } = mountScrubber({
    isAtBottom: () => atBottom,
    onJumpToBottom: () => { bottomJumps += 1; },
  });
  try {
    const withEnd = [...THREE, { t: 'end' }];
    const yEnd = itemClientY(withEnd, 3);
    assert.equal(yEnd - itemClientY(withEnd, 2), 24, '回底箭头与最后一道刻度多隔开一点');
    hit.handlers.pointermove(pointer(920, yEnd, 'mouse'));
    assert.equal(preview.textContent, '回到底部');
    assert.equal(preview.dataset.end, '1');
    hit.handlers.pointerdown(pointer(920, yEnd, 'mouse'));
    assert.equal(preview.textContent, '松开回到底部');
    hit.handlers.pointerup(pointer(920, yEnd, 'mouse'));
    assert.equal(bottomJumps, 1);
    assert.deepEqual(jumps, []);
    atBottom = true;
    scrubber.refresh();
    hit.handlers.pointermove(pointer(920, yEnd, 'mouse'));
    assert.equal(preview.dataset.end, undefined, '已在底部时不再有回底箭头');
    assert.equal(preview.dataset.index, '3');
    console.log('ok - a back-to-bottom arrow sits under the last tick until the reader is at the bottom');
  } finally {
    scrubber.destroy();
  }
}

{
  // 手机细线状态：轻点一下只唤醒、不出预览也不跳转；按下后拖动才开始操作刻度
  const { scrubber, rail, preview, hit, jumps, pointer } = mountScrubber({ isCoarsePointer: () => true });
  try {
    const y2 = itemClientY(THREE, 1, { coarse: true });
    rail.classList.add('is-rest');
    hit.handlers.pointerdown(pointer(920, y2, 'touch'));
    assert.equal(preview.hidden, true, '细线状态按下不立即出预览');
    assert.equal(rail.classList.contains('is-rest'), false, '按下就唤醒');
    hit.handlers.pointerup(pointer(920, y2, 'touch'));
    assert.deepEqual(jumps, [], '轻点只唤醒，不跳转');
    rail.classList.add('is-rest');
    hit.handlers.pointerdown(pointer(920, y2, 'touch'));
    hit.handlers.pointermove(pointer(920, y2 + 20, 'touch'));
    assert.equal(preview.dataset.index, '3');
    hit.handlers.pointerup(pointer(920, y2 + 20, 'touch'));
    assert.deepEqual(jumps, [3], '拖动后照常预览并跳转');
    console.log('ok - a tap on the resting scrubber only wakes it while a drag scrubs');
  } finally {
    scrubber.destroy();
  }
}

{
  // 弧形凸起：鼠标悬停不鼓起；手指按住立即在按住处鼓出（读不到手指大小时向左移 64px），松开收回
  const { scrubber, hit, glow, items, flush, pointer } = mountScrubber({ isCoarsePointer: () => true });
  try {
    const y2 = itemClientY(THREE, 1, { coarse: true });
    const tick2 = () => items.children.find(el => el.dataset.key === 't2').children[0];
    flush();
    hit.handlers.pointermove(pointer(920, y2, 'mouse'));
    flush();
    assert.equal(glow.style.opacity, '0.000', '悬停不鼓起');
    hit.handlers.pointerdown(pointer(920, y2, 'touch'));
    flush();
    assert.equal(glow.style.opacity, '1.000');
    assert.match(tick2().style.transform, /^translateX\(-64\.00px\) rotate\(0\.0000rad\)$/);
    hit.handlers.pointerup(pointer(920, y2, 'touch'));
    flush();
    assert.equal(glow.style.opacity, '0.000');
    assert.match(tick2().style.transform, /^translateX\(0\.00px\)/);
    console.log('ok - hovering never bulges while a held finger bulges the ticks at once');
  } finally {
    scrubber.destroy();
  }
}

{
  // 弧按手指大小拉出：按下处离右缘 18px（刻度条宽 30、按在 x=12），接触面长边 40 → 68；按住期间压扁到 50 → 78，只会变长
  const { scrubber, hit, items, flush, pointer } = mountScrubber({ isCoarsePointer: () => true });
  try {
    const y2 = itemClientY(THREE, 1, { coarse: true });
    const tick2 = () => items.children.find(el => el.dataset.key === 't2').children[0];
    const touch = (x, y, size) => ({ ...pointer(x, y, 'touch'), width: size.w, height: size.h });
    hit.handlers.pointerdown(touch(920, y2, { w: 25.6, h: 40 }));
    flush();
    assert.match(tick2().style.transform, /^translateX\(-68\.00px\)/);
    hit.handlers.pointermove(touch(920, y2, { w: 33, h: 50 }));
    flush();
    assert.match(tick2().style.transform, /^translateX\(-78\.00px\)/);
    hit.handlers.pointermove(touch(880, y2, { w: 25, h: 30 }));
    flush();
    assert.match(tick2().style.transform, /^translateX\(-78\.00px\)/, '手指往弧那边移、接触面变小时弧不缩回也不外跑');
    hit.handlers.pointerup(touch(880, y2, { w: 25, h: 30 }));
    console.log('ok - the touch arc follows the finger contact size measured while holding');
  } finally {
    scrubber.destroy();
  }
}
