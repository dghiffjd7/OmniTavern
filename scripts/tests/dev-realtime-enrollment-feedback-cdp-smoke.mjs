import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
if (!await evaluateInApp('Boolean(window.__realtimeCloneSmoke)')) await evaluateInApp(readFileSync('scripts/dev/realtime-enrollment-feedback-smoke.js', 'utf8'));
const page = await findAppPageTarget(), pending = new Map(); let socket, sequence = 0;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const results = [];
try {
  for (const width of [1100, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const layout = await evaluateInApp('window.__realtimeCloneSmoke.layout()');
    assert(layout.visible, `Clone feedback hidden at ${width}px`); assert(!layout.hasHorizontalOverflow, `Clone feedback overflow at ${width}px`);
    const errorColor = await evaluateInApp(`(() => { const status = [...document.querySelectorAll('#rt-clone-status')].at(-1), probe = document.createElement('span'); probe.style.color = 'var(--app-danger-text)'; status.parentElement.append(probe); const expected = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(status).color === expected; })()`);
    assert(errorColor, 'Error feedback uses muted helper-text color');
    const clip = await evaluateInApp(`(() => { const rect = [...document.querySelectorAll('#config-panel')].at(-1).getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }; })()`);
    const screenshot = await command('Page.captureScreenshot', { format: 'png', clip });
    const path = `../realtime-checks/realtime-clone-feedback-${width}.png`; writeFileSync(path, Buffer.from(screenshot.data, 'base64'));
    results.push({ width, visible: layout.visible, overflow: layout.hasHorizontalOverflow, screenshot: path });
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await command('Emulation.clearDeviceMetricsOverride');
  await evaluateInApp('window.__realtimeCloneSmoke?.cleanup()'); socket.close();
}
