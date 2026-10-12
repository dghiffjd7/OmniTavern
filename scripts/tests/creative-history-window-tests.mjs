import assert from 'node:assert/strict';

import { planHistoryJump } from '../../src/scripts/ui/chat/creative-history-window.js';

{
  // 已渲染从第 500 条起（下标）：目标已在画面里 / 很近接着补 / 很远只渲染附近并折叠中间
  assert.deepEqual(planHistoryJump({ targetIndex: 600, renderedStart: 500 }), { kind: 'rendered' });
  assert.deepEqual(planHistoryJump({ targetIndex: 470, renderedStart: 500 }), { kind: 'extend', from: 455, to: 499 });
  assert.deepEqual(planHistoryJump({ targetIndex: 20, renderedStart: 500 }), { kind: 'window', from: 5, to: 35, gapFrom: 36, gapTo: 499 });
  assert.deepEqual(planHistoryJump({ targetIndex: 3, renderedStart: 500 }), { kind: 'window', from: 0, to: 18, gapFrom: 19, gapTo: 499 });
  assert.deepEqual(planHistoryJump({ targetIndex: -1, renderedStart: 500 }), { kind: 'missing' });
  console.log('ok - history jump renders only the neighbourhood of far targets');
}

{
  // 共用的跳到消息（引用跳转、搜索跳转）遇到写作历史折叠时交给窗口跳转
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('const ensureMessageVisibleInCurrentChat = async'), app.indexOf('const focusOpts = {', app.indexOf('const ensureMessageVisibleInCurrentChat = async')));
  assert.match(body, /querySelector\?\.\(':scope > \.creative-history-gap'\)/);
  assert.match(body, /return Boolean\(await creativeHistoryWindow\?\.jumpToMessage\(sid, mid\)\);/);
  console.log('ok - shared message jumps defer to the history window while history is collapsed');
}
