import assert from 'node:assert/strict';

import { DebugPanel } from '../../src/scripts/ui/debug-panel.js';

// 回归：调试日志常在流式重建创意写作气泡的途中写入。面板若同步刷新并读取高度，会在气泡只塞回一半时强制排版，
// 把聊天列表的滚动位置截到气泡开头（开启调试执行日志 + Izumi 吐槽美化时可在手机上复现）。
{
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  const panel = Object.create(DebugPanel.prototype);
  Object.assign(panel, { logs: [], seenMessages: new Set(), maxLogs: 100, renderCount: 0 });
  panel.render = function render() { this.renderCount += 1; };

  panel.log('render msg=a len=1');
  panel.log('render msg=a len=2');
  panel.log('render msg=a len=2');
  assert.equal(panel.renderCount, 0, 'logging must not render (and force layout) synchronously');
  assert.equal(panel.logs.length, 2);
  assert.equal(frames.length, 1, 'several logs in one frame share a single render');

  frames.shift()();
  assert.equal(panel.renderCount, 1);
  panel.log('render msg=a len=3');
  assert.equal(frames.length, 1, 'a new frame is scheduled after the previous render ran');
  frames.shift()();
  assert.equal(panel.renderCount, 2);
  delete globalThis.requestAnimationFrame;
  console.log('ok - debug panel defers log rendering to the next frame');
}
