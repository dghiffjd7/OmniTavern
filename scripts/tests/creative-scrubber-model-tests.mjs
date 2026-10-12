import assert from 'node:assert/strict';

import {
  buildExpansionSamples,
  buildFollowItems,
  buildZoomItems,
  clipScrubberPreview,
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
