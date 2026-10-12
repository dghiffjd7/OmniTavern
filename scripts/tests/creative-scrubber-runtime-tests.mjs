import assert from 'node:assert/strict';
import { createCreativeScrubber } from '../../src/scripts/ui/chat/creative-scrubber.js';

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

{
  // 使用真实指针处理器；模拟 pointer capture 后移出刻度条的 move/up。
  class Element {
    children = [];
    dataset = {};
    handlers = {};
    style = { setProperty() {} };
    className = '';
    hidden = false;
    get classList() {
      const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        contains: token => tokens().has(token),
        add: token => { this.className = [...tokens().add(token)].join(' '); },
        remove: token => { const next = tokens(); next.delete(token); this.className = [...next].join(' '); },
        toggle: (token, on) => on ? this.classList.add(token) : this.classList.remove(token),
      };
    }
    append(...nodes) { this.children.push(...nodes.flatMap(node => node.fragment ? node.children : [node])); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute() {}
    addEventListener(name, listener) { this.handlers[name] = listener; }
    getBoundingClientRect() { return { left: 900, right: 940, top: 0, bottom: 600, height: 600 }; }
    querySelectorAll(selector) { return this.children.filter(node => node.classList.contains(selector.slice(1))); }
    contains(node) { return this.children.includes(node); }
    closest() { return this; }
    setPointerCapture() {}
    releasePointerCapture() {}
    remove() {}
  }
  const host = new Element();
  const jumps = [];
  let tick;
  const documentRef = {
    createElement: () => new Element(),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    elementFromPoint: (x, y) => x >= 900 && x <= 940 && y >= 0 && y <= 600 ? tick : null,
  };
  const scrubber = createCreativeScrubber({ documentRef, hostEl: host, scrollEl: new Element(),
    getTotal: () => 3, getCurrent: () => 1, onJump: index => jumps.push(index), isCoarsePointer: () => false });
  try {
    scrubber.setVisible(true);
    const rail = host.children[0];
    const pointer = (x = 920) => ({ button: 0, pointerId: 1, clientX: x, clientY: 100, target: tick, preventDefault() {} });
    const press = () => { tick = rail.children[1]; rail.handlers.pointerdown(pointer()); };
    press();
    rail.handlers.pointerup(pointer(500));
    assert.deepEqual(jumps, [], '左侧松开必须取消跳转，即使没有收到最后一帧 pointermove');
    press();
    rail.handlers.pointermove(pointer(1000));
    assert.equal(host.children[1].hidden, true, '移出右侧应隐藏预览');
    rail.handlers.pointerup(pointer(1000));
    assert.deepEqual(jumps, [], '右侧松开必须取消跳转');
    press();
    rail.handlers.pointermove(pointer(500));
    rail.handlers.pointermove(pointer());
    rail.handlers.pointerup(pointer());
    assert.deepEqual(jumps, [2], '重新移回已预览刻度后松开仍应跳转');
    console.log('ok - pointer release outside the scrubber cancels while returning inside still jumps');
  } finally {
    scrubber.destroy();
  }
}

{
  // 手指按住拖动：横向往左偏 60px 内仍算在条上，上下拖过头停在首尾刻度；鼠标维持严格判断
  class Element {
    children = [];
    dataset = {};
    handlers = {};
    style = { setProperty() {} };
    className = '';
    hidden = false;
    get classList() {
      const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        contains: token => tokens().has(token),
        add: token => { this.className = [...tokens().add(token)].join(' '); },
        remove: token => { const next = tokens(); next.delete(token); this.className = [...next].join(' '); },
        toggle: (token, on) => on ? this.classList.add(token) : this.classList.remove(token),
      };
    }
    append(...nodes) { this.children.push(...nodes.flatMap(node => node.fragment ? node.children : [node])); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute() {}
    addEventListener(name, listener) { this.handlers[name] = listener; }
    getBoundingClientRect() { return { left: 900, right: 940, top: 0, bottom: 600, height: 600 }; }
    querySelectorAll(selector) { return this.children.filter(node => node.classList.contains(selector.slice(1))); }
    contains(node) { return this.children.includes(node); }
    closest() { return this; }
    setPointerCapture() {}
    releasePointerCapture() {}
    remove() {}
  }
  const host = new Element();
  const jumps = [];
  let tick;
  const probes = [];
  const documentRef = {
    createElement: () => new Element(),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    elementFromPoint: (x, y) => { probes.push(y); return x >= 900 && x <= 940 && y >= 0 && y <= 600 ? tick : null; },
  };
  const scrubber = createCreativeScrubber({ documentRef, hostEl: host, scrollEl: new Element(),
    getTotal: () => 3, getCurrent: () => 1, onJump: index => jumps.push(index), isCoarsePointer: () => true });
  try {
    scrubber.setVisible(true);
    const rail = host.children[0];
    const pointer = (x, y = 100, pointerType = 'touch') => ({ button: 0, pointerId: 1, pointerType, clientX: x, clientY: y, target: tick, preventDefault() {} });
    const press = (pointerType = 'touch') => { tick = rail.children[1]; rail.handlers.pointerdown(pointer(920, 100, pointerType)); };
    press();
    rail.handlers.pointermove(pointer(860));
    rail.handlers.pointerup(pointer(860));
    assert.deepEqual(jumps, [2], '手指往左偏 40px 内松开仍跳转');
    press();
    rail.handlers.pointerup(pointer(820));
    assert.deepEqual(jumps, [2], '手指偏出 60px 以上松开取消');
    press();
    probes.length = 0;
    rail.handlers.pointerup(pointer(920, 700));
    assert.ok(probes.every(y => y <= 600), '往下拖过头时探测点钳回到最后一条');
    assert.deepEqual(jumps, [2, 2]);
    press('mouse');
    rail.handlers.pointerup(pointer(860, 100, 'mouse'));
    assert.deepEqual(jumps, [2, 2], '鼠标仍按严格判断：条外松开取消');
    console.log('ok - touch drags tolerate drifting off the narrow scrubber while mouse stays strict');
  } finally {
    scrubber.destroy();
  }
}
