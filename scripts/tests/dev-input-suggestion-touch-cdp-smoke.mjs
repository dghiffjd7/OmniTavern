// Windows dev WebView，真实触摸事件与隔离输入框；不写用户配置或请求模型。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const page = await findAppPageTarget(), pending = new Map();
const initialViewport = await evaluateInApp('({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })');
let client, sequence = 0;
await new Promise((resolve, reject) => {
  client = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), item = pending.get(message.id); if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); client.send(JSON.stringify({ id, method, params }));
});
const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const ev = source => evaluateInApp(`(() => { const f = window.__inputSuggestionTouchSmoke; ${source} })()`);
let touching = false;
const touch = async (type, point) => {
  await command('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
  if (type === 'touchStart') touching = true;
  if (type === 'touchEnd' || type === 'touchCancel') touching = false;
};
const pointAt = index => ev(`return f.pointAt(${index});`);
const state = () => ev(`const label = f.label(); const preview = document.querySelector('.input-suggestion-touch-preview:not([hidden])');
  const rect = preview?.getBoundingClientRect();
  return { value: f.input.value, focused: document.activeElement === f.input, events: f.events, requests: f.requests,
    selected: label.querySelector('.input-suggestion-selected').textContent, remaining: label.querySelector('.input-suggestion-remaining').textContent,
    active: f.button().classList.contains('is-touch-selecting'), visible: !f.button().hidden, scroll: label.scrollLeft,
    preview: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null };`);
const reset = async (suggestion = '公园散步，顺便买一杯咖啡。', after = '') => {
  await ev(`f.reset(${JSON.stringify(suggestion)}, ${JSON.stringify(after)});`); await pause();
};
const hold = async () => { const point = await pointAt(0); await touch('touchStart', point); await pause(460); return point; };
const screenshot = async name => {
  if (!process.env.INPUT_SUGGESTION_SCREENSHOT_DIR) return;
  const { data } = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${process.env.INPUT_SUGGESTION_SCREENSHOT_DIR}/input-touch-${name}.png`, Buffer.from(data, 'base64'));
};

try {
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await evaluateInApp(`(async () => {
    const { bindInputSuggestionComposer } = await import('/scripts/ui/chat/input-suggestion-composer.js');
    const { splitInputSuggestionCharacters } = await import('/scripts/ui/chat/input-suggestion-runtime.js');
    const previousFocus = document.activeElement, host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:var(--app-surface-page);display:flex;align-items:flex-end;padding:24px 16px;box-sizing:border-box';
    host.innerHTML = '<div style="width:100%;padding:30px 16px 16px;border-radius:20px;background:var(--app-surface-card);box-sizing:border-box"><div class="chat-input-wrap"><textarea class="chat-input" rows="3" aria-label="触摸输入建议测试"></textarea></div></div>';
    document.body.append(host);
    const input = host.querySelector('textarea');
    const f = { host, input, previousFocus, requests: 0, events: 0, key: 'touch:fixture', suggestion: '' };
    f.button = () => host.querySelector('.input-suggestion-accept'); f.label = () => host.querySelector('.input-suggestion-label');
    f.controller = bindInputSuggestionComposer({ input,
      getSettings: () => ({ enabled: true, modelMode: 'profile', modelProfileId: 'mock' }),
      getContext: () => ({ key: f.key }), request: async () => { f.requests++; return f.suggestion; },
      runtimeOptions: { delayMs: 10 }
    });
    input.addEventListener('input', () => f.events++);
    f.reset = (suggestion, after) => {
      f.controller.cancel(); f.suggestion = suggestion;
      input.value = '今天想去' + after; input.focus(); input.setSelectionRange(4, 4);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    f.pointAt = index => {
      const label = f.label(), characters = splitInputSuggestionCharacters(label.textContent);
      const start = characters.slice(0, index).join('').length, end = start + characters[index].length;
      const walker = document.createTreeWalker(label, 4), nodes = []; let node, offset = 0;
      while ((node = walker.nextNode())) { nodes.push({ node, offset }); offset += node.length; }
      const locate = value => { const item = nodes.find(n => value <= n.offset + n.node.length); return [item.node, value - item.offset]; };
      const range = document.createRange(); range.setStart(...locate(start)); range.setEnd(...locate(end));
      const rect = range.getBoundingClientRect(); return { x: rect.left + rect.width * .6, y: rect.top + rect.height / 2 };
    };
    window.__inputSuggestionTouchSmoke = f;
  })()`);

  await reset();
  assert.equal(await ev(`return !!f.host.querySelector('.input-suggestion-shortcut');`), false, 'arrow shortcut removed');
  assert((await ev(`return f.button().getBoundingClientRect().height;`)) >= 44, 'touch target should be at least 44px tall');
  let baseline = await state(), point = await pointAt(0);
  await touch('touchStart', point); await touch('touchEnd'); await pause();
  let current = await state();
  assert.equal(current.value, '今天想去公园散步，顺便买一杯咖啡。');
  assert.equal(current.events, baseline.events + 1); assert.equal(current.focused, true);

  await reset(); baseline = await state(); await hold();
  current = await state(); assert.equal(current.active, true); assert.equal(current.selected, ''); assert.equal(current.preview, null);
  await screenshot('held');
  await touch('touchEnd'); await pause(); current = await state();
  assert.equal(current.value, '今天想去'); assert.equal(current.events, baseline.events); assert.equal(current.visible, true);

  await reset('公园👩🏽‍💻散步，顺便买一杯咖啡。', '，晚上回来。'); baseline = await state(); await hold();
  await touch('touchMove', await pointAt(3));
  current = await state(); assert.equal(current.selected, '公园👩🏽‍💻散');
  await touch('touchMove', await pointAt(2));
  // CDP may acknowledge a coalesced touch move before WebView dispatches pointermove.
  await pause(); current = await state();
  assert.equal(current.selected, '公园👩🏽‍💻'); assert.equal(current.events, baseline.events); assert.equal(current.focused, true);
  assert(current.preview && current.preview.left >= 0 && current.preview.right <= 390);
  assert.equal(await ev(`return String(window.getSelection());`), '', 'system text selection should remain inactive');
  await screenshot('selected');
  await touch('touchEnd'); await pause(); current = await state();
  assert.equal(current.value, '今天想去公园👩🏽‍💻，晚上回来。'); assert.equal(current.remaining, '散步，顺便买一杯咖啡。');
  assert.equal(current.events, baseline.events + 1); assert.equal(current.requests, baseline.requests);
  assert.equal(current.preview, null); await screenshot('accepted');
  assert.equal(await ev(`const ok = document.execCommand('undo'); f.controller.cancel(); return ok && f.input.value === '今天想去，晚上回来。';`), true);

  await reset(); await hold(); await touch('touchMove', await pointAt(2));
  point = await ev(`const r = f.label().getBoundingClientRect(); return { x: r.left - 4, y: r.top + r.height / 2 };`);
  await touch('touchMove', point); assert.equal((await state()).selected, '');
  await touch('touchEnd'); assert.equal((await state()).value, '今天想去');

  point = await pointAt(0); await touch('touchStart', point);
  await touch('touchMove', { x: point.x, y: point.y - 30 }); await pause(440); await touch('touchEnd');
  assert.equal((await state()).value, '今天想去', 'movement before long press must not become a tap');
  await hold(); await touch('touchMove', await pointAt(2)); await touch('touchCancel');
  current = await state(); assert.equal(current.value, '今天想去'); assert.equal(current.preview, null);

  await hold(); await touch('touchMove', await pointAt(2));
  await ev(`f.input.dispatchEvent(new CompositionEvent('compositionstart'));`); await touch('touchEnd');
  current = await state(); assert.equal(current.value, '今天想去'); assert.equal(current.visible, false); assert.equal(current.preview, null);
  await ev(`f.input.dispatchEvent(new CompositionEvent('compositionend')); f.controller.cancel();`);
  await reset(); await hold(); await touch('touchMove', await pointAt(2));
  await ev(`f.key = 'touch:another-chat'; window.dispatchEvent(new Event('session-changed'));`); await touch('touchEnd');
  assert.equal((await state()).value, '今天想去', 'switching sessions must cancel touch acceptance');

  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 440, deviceScaleFactor: 1, mobile: true });
  await reset('春夏秋冬山河湖海清风明月'.repeat(10)); await hold();
  point = await ev(`const r = f.label().getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 };`);
  await touch('touchMove', point); baseline = await state(); await pause(260); current = await state();
  assert(current.scroll > 0 && current.selected.length > baseline.selected.length, 'edge hold should scroll and extend selection');
  assert(current.preview && current.preview.left >= 0 && current.preview.right <= 320 && current.preview.bottom < point.y);
  await screenshot('edge-320');
  const rightScroll = current.scroll;
  point = await ev(`const r = f.label().getBoundingClientRect(); return { x: r.left + 2, y: r.top + r.height / 2 };`);
  await touch('touchMove', point); await pause(120); current = await state();
  assert(current.scroll < rightScroll, 'left edge should scroll back');
  await touch('touchMove', { x: point.x, y: point.y - 90 }); await touch('touchEnd'); await pause();
  current = await state(); assert.equal(current.value, '今天想去'); assert.equal(current.preview, null); assert.equal(current.scroll, 0);
  console.log(JSON.stringify({ passed: true, trustedTouch: true, viewports: [390, 320], tap: true, prefixAndUndo: true, cancellation: true, edgeScroll: true, modelRequests: 0 }));
} finally {
  if (touching) await touch('touchCancel');
  await ev(`if (f) { f.controller.dispose(); f.host.remove(); f.previousFocus?.focus?.({ preventScroll: true }); delete window.__inputSuggestionTouchSmoke; }`);
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  // WebView2 清除模拟后会保留最后的可见尺寸，先恢复进入检查时的视口。
  await command('Emulation.setDeviceMetricsOverride', { ...initialViewport, mobile: false });
  await command('Emulation.clearDeviceMetricsOverride'); client.close();
}
process.exit(0);
