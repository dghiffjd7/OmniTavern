import assert from 'node:assert/strict';

import {
  buildExpansionSamples,
  buildFollowItems,
  buildZoomItems,
  clipScrubberPreview,
  layoutScrubberItems,
  pickScrubberItem,
  scrubberLens,
  touchArcForContact,
} from '../../src/scripts/ui/chat/creative-scrubber-model.js';

const describe = items => items.map(item => (item.t === 'tick' ? String(item.i) : `…${item.from}-${item.to}`)).join(' ');

{
  // 不超过 10 条时全部显示
  assert.equal(describe(buildFollowItems(3, 6)), '1 2 3 4 5 6');
  assert.deepEqual(buildFollowItems(1, 0), []);
  console.log('ok - follow items show every message for short threads');
}

{
  // 首尾固定，中间 8 个跟随阅读位置；顶部/底部与首尾合并
  assert.equal(describe(buildFollowItems(1, 1000)), '1 2 3 4 5 6 7 8 9 …10-999 1000');
  assert.equal(describe(buildFollowItems(345, 1000)), '1 …2-341 342 343 344 345 346 347 348 349 …350-999 1000');
  assert.equal(describe(buildFollowItems(1000, 1000)), '1 …2-991 992 993 994 995 996 997 998 999 1000');
  for (const center of [1, 5, 6, 7, 500, 994, 995, 1000]) {
    assert.equal(buildFollowItems(center, 1000).filter(item => item.t === 'tick').length, 10, `center ${center}`);
  }
  console.log('ok - follow items pin the first and last message and keep ten ticks');
}

{
  // 渐进·靠近你：近端连续 3 条，越远越疏，远端 2 条连续
  assert.deepEqual(buildExpansionSamples({ from: 10, to: 999 }, 9), [10, 11, 12, 22, 62, 142, 270, 452, 693, 998, 999]);
  const mirrored = buildExpansionSamples({ from: 10, to: 999 }, 1000);
  assert.deepEqual(mirrored.slice(-3), [997, 998, 999]);
  assert.deepEqual(mirrored.slice(0, 2), [10, 11]);
  assert.deepEqual(buildExpansionSamples({ from: 5, to: 9 }, 1), [5, 6, 7, 8, 9]);
  console.log('ok - expansion samples are dense near the reading position');
}

{
  const items = buildZoomItems({ from: 10, to: 999 }, 1000, 9);
  assert.equal(describe(items.slice(0, 4)), '1 …2-8 9 10');
  assert.equal(items[items.length - 1].i, 1000);
  const entering = items.filter(item => item.t === 'tick' && item.enter);
  assert.deepEqual(entering.map(item => item.order), entering.map((_, k) => k));
  assert.ok(items.some(item => item.t === 'gap' && item.from === 13 && item.to === 21));
  console.log('ok - zoom items keep neighbours and order the entering ticks from the near side');
}

{
  assert.equal(clipScrubberPreview('  一段\n很长的   文字  ', 4), '一段 很…');
  assert.equal(clipScrubberPreview('短句'), '短句');
  console.log('ok - preview text is collapsed and clipped');
}

{
  // 紧凑排列：固定 18px 间距，整条以 centerRatio 处为中心；回底箭头多隔开 6px；放不下才压缩间距
  const ticks = n => Array.from({ length: n }, (_, k) => ({ t: 'tick', i: k + 1 }));
  const centered = layoutScrubberItems(ticks(11), 600);
  assert.equal(centered.pitch, 18);
  assert.deepEqual([centered.ys[0], centered.ys[10]], [210, 390]);
  const lower = layoutScrubberItems(ticks(11), 600, { centerRatio: 0.64 });
  assert.deepEqual([lower.ys[0], lower.ys[10]], [294, 474]);
  const withEnd = layoutScrubberItems([...ticks(10), { t: 'end' }], 600);
  assert.equal(withEnd.ys[10] - withEnd.ys[9], 24);
  assert.equal(withEnd.ys[0] + withEnd.ys[10], 600, '加上回底箭头后整条仍居中');
  const crowded = layoutScrubberItems(ticks(41), 400);
  assert.equal(crowded.pitch, 10);
  assert.deepEqual([crowded.ys[0], crowded.ys[40]], [0, 400]);
  const nearEdge = layoutScrubberItems(ticks(21), 400, { centerRatio: 0.9 });
  assert.equal(nearEdge.ys[20], 400, '中心太靠下时整条贴底，不超出刻度条');
  assert.deepEqual(layoutScrubberItems([], 400).ys, []);
  console.log('ok - scrubber items are packed at a fixed pitch around the chosen centre');
}

{
  // 按住的凸起：手指处不动、先后顺序不变；越近越往左鼓、越长；上方刻度左端朝上倾斜
  const focus = 300;
  const at = y => scrubberLens(y, focus, 1);
  assert.equal(at(focus).y, focus);
  assert.equal(at(focus).rot, 0);
  const ys = [200, 250, 282, 300, 318, 350, 400].map(y => at(y).y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
  assert.ok(at(318).y - at(300).y > 18, '手指附近间距放大');
  assert.ok(at(300).dx > at(318).dx && at(318).dx > at(400).dx);
  assert.ok(at(300).lenF > at(400).lenF);
  assert.ok(at(282).rot > 0 && at(318).rot < 0);
  assert.deepEqual(scrubberLens(250, focus, 0), { y: 250, dx: 0, rot: 0, lenF: 1 });
  console.log('ok - the hold lens bulges ticks around the finger without reordering them');
}

{
  // 指针对应的项目：取最近的一项；鼠标严格在条内，手指按住往左容忍 60px、往右 24px，上下拖过头停在首尾
  const entries = [{ key: 'a', y: 100 }, { key: 'b', y: 118 }, { key: 'c', y: 136 }];
  const pick = opts => pickScrubberItem(entries, { width: 40, pitch: 18, ...opts })?.key || null;
  assert.equal(pick({ x: 20, y: 120 }), 'b');
  assert.equal(pick({ x: -5, y: 120 }), null);
  assert.equal(pick({ x: 45, y: 120 }), null);
  assert.equal(pick({ x: 20, y: 160 }), null);
  assert.equal(pick({ x: -55, y: 120, lenient: true }), 'b');
  assert.equal(pick({ x: -65, y: 120, lenient: true }), null);
  assert.equal(pick({ x: 60, y: 120, lenient: true }), 'b');
  assert.equal(pick({ x: 20, y: 400, lenient: true }), 'c');
  assert.equal(pick({ x: 20, y: -50, lenient: true }), 'a');
  assert.equal(pick({ x: -30, y: 120, extraLeft: 50 }), 'b', '鼠标按住时凸起往左的部分也算');
  assert.equal(pick({ x: -100, y: 120, lenient: true, extraLeft: 50 }), 'b', '手指按住时容错再加上弧往左的延伸');
  assert.equal(pick({ x: -115, y: 120, lenient: true, extraLeft: 50 }), null);
  assert.equal(pickScrubberItem([], { x: 0, y: 0, width: 40 }), null);
  console.log('ok - pointer picking stays strict for mice and tolerant for held fingers');
}

{
  // 手指按住的弧：按下处离刻度条右缘的距离 + 接触面长边 + 10，限制在 48–110；读不到接触面（0 或 1）用 64
  // 实测 Pixel 10 平常按：离右缘约 13px、接触面长边约 40px → 63，正好是用户试过觉得合适的 64 左右
  assert.deepEqual(touchArcForContact({ contact: 40, edge: 13 }), { magnify: 0.9, bulge: 63, width: 71, spread: 39 });
  assert.equal(touchArcForContact({ contact: 0, edge: 13 }).bulge, 64);
  assert.equal(touchArcForContact({ contact: 1, edge: 13 }).bulge, 64);
  assert.equal(touchArcForContact({ contact: 120, edge: 20 }).bulge, 110);
  assert.equal(touchArcForContact({ contact: 10, edge: 0 }).bulge, 48);
  assert.equal(touchArcForContact().bulge, 64);
  console.log('ok - the touch arc reaches past the finger according to its contact size');
}
