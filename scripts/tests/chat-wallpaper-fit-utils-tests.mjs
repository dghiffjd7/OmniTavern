import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { computeChatWallpaperTransform, observeChatWallpaperContainer } = await import('../../src/scripts/ui/chat/chat-wallpaper-fit-utils.js');

const scaleOf = transform => Number(String(transform).match(/scale\(([\d.]+)\)/)?.[1]);

{
  // 铺满（cover）：竖图壁纸放进手机聊天室，高度方向要铺满
  const t = computeChatWallpaperTransform({ containerWidth: 430, containerHeight: 932, imageWidth: 1024, imageHeight: 1536 });
  assert.equal(scaleOf(t).toFixed(4), (932 / 1536).toFixed(4));
  assert.match(t, /^translate\(-50%, -50%\) translate\(0px, 0px\) rotate\(0deg\) scale\(/);
  // 用户的缩放、旋转、偏移照旧叠上去
  const custom = computeChatWallpaperTransform({ containerWidth: 400, containerHeight: 800, imageWidth: 1000, imageHeight: 1000, meta: { zoom: 1.5, rotate: 90, offsetX: 0.1, offsetY: -0.25 } });
  assert.match(custom, /^translate\(-50%, -50%\) translate\(40px, -200px\) rotate\(90deg\) scale\(/);
  assert.ok(Math.abs(scaleOf(custom) - 1.2) < 1e-9);
  assert.equal(computeChatWallpaperTransform({ containerWidth: 0, containerHeight: 932, imageWidth: 1024, imageHeight: 1536 }), null, 'unknown sizes leave the wallpaper alone');
  console.log('ok - the wallpaper covers the chat room and keeps the user adjustments');
}

{
  // 聊天室尺寸一变就重算：window resize 当下 fixed 容器的高度还是旧的（实测慢一帧），
  // 只在 resize 里算会照旧高度缩放（键盘收起后上下各空一条），要跟着容器本身的尺寸走
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(el) { this.target = el; }
    disconnect() { this.disconnected = true; }
  }
  const room = {};
  let calls = 0;
  const stop = observeChatWallpaperContainer({ containerEl: room, onResize: () => { calls += 1; }, ResizeObserverCtor: FakeResizeObserver });
  const ro = observers[0];
  assert.equal(ro.target, room);
  ro.callback([{ contentRect: { width: 430, height: 600 } }]);
  ro.callback([{ contentRect: { width: 430, height: 932 } }]);
  assert.equal(calls, 2, 'each new container size reapplies the wallpaper');
  ro.callback([{ contentRect: { width: 430, height: 932 } }]);
  assert.equal(calls, 2, 'the same size does not redo the work');
  stop();
  assert.equal(ro.disconnected, true);
  assert.doesNotThrow(() => observeChatWallpaperContainer({ containerEl: room, onResize: () => {}, ResizeObserverCtor: undefined })());
  console.log('ok - the wallpaper follows the chat room size, not only window resize');
}

{
  // app.js：壁纸缩放用同一个函数，并观察聊天室本身
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /computeChatWallpaperTransform\(\{/);
  assert.match(appSource, /observeChatWallpaperContainer\(\{\s*containerEl: chatRoom,/);
  console.log('ok - the app wires the wallpaper to the chat room size');
}

console.log('chat-wallpaper-fit-utils-tests passed');
