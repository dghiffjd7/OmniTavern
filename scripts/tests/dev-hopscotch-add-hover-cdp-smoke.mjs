// Windows dev WebView；独立 DOM 夹具，仅验证新增按钮，不写真实板或会话。
import assert from 'node:assert/strict';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const page = await findAppPageTarget();
let sequence = 0;
const pending = new Map();
let socket;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject,
    onMessage: raw => {
      const message = JSON.parse(raw);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    },
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const settle = () => evaluateInApp('new Promise(resolve => setTimeout(resolve, 220))');
const inspect = () => evaluateInApp(`(() => {
  const root = document.getElementById('hop-add-hover-smoke');
  return { hover: matchMedia('(hover: hover) and (pointer: fine)').matches, coarse: matchMedia('(any-pointer: coarse)').matches,
    buttons: [...root.querySelectorAll('.hop-plus')].map(node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, opacity: Number(getComputedStyle(node).opacity), focused: document.activeElement === node, gap: node.classList.contains('hop-gap') };
    }) };
})()`);
try {
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluateInApp(`(async () => {
    const { renderHopscotchCourt } = await import('/scripts/ui/chat/hopscotch-court-view.js');
    window.__hopAddHoverSmokeFocus = document.activeElement;
    const root = document.createElement('dialog'); root.id = 'hop-add-hover-smoke'; root.className = 'hop-dialog';
    root.innerHTML = '<button type="button" autofocus>Test only</button>' + renderHopscotchCourt({ rows: [{ houses: [{ id: 'body', kind: 'body', label: '正文', fused: [] }] }] }, { editable: true });
    root.addEventListener('click', event => { const plus = event.target.closest('[data-hop-add]'); if (plus) root.dataset.clicked = plus.dataset.hopNew; });
    document.body.append(root); root.showModal();
  })()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await settle();
  const desktop = await inspect();
  assert.ok(desktop.hover && !desktop.coarse, 'desktop pointer emulation unavailable');
  assert.equal(desktop.buttons.length, 3);
  assert.ok(desktop.buttons.every(button => button.opacity === 0), 'desktop plus buttons should be hidden at rest');
  for (const [index, button] of desktop.buttons.entries()) {
    // 图形外 6px、仍在扩展热区内；不用精确瞄准隐藏的 26px 圆钮。
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x - 6, y: button.y + button.height / 2 });
    await settle();
    const hovered = await inspect();
    assert.equal(hovered.buttons[index].opacity, 1, 'approaching each add edge must reveal its plus');
    assert.ok(hovered.buttons.every((other, i) => i === index || other.opacity === 0), 'do not reveal unrelated plus buttons');
  }
  const side = desktop.buttons.find(button => !button.gap);
  const point = { x: side.x + side.width / 2, y: side.y + side.height / 2 };
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  assert.equal(await evaluateInApp("document.getElementById('hop-add-hover-smoke').dataset.clicked"), '0', 'revealed parallel add remains clickable');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await evaluateInApp("document.querySelector('#hop-add-hover-smoke .hop-cell').focus()");
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await settle();
  const keyboard = await inspect();
  assert.ok(keyboard.buttons.some(button => button.focused && button.opacity === 1), 'keyboard focus must reveal the add button');
  for (let i = 0; i < desktop.buttons.length; i++) {
    assert.deepEqual([keyboard.buttons[i].x, keyboard.buttons[i].y], [desktop.buttons[i].x, desktop.buttons[i].y], 'show/hide must not shift the board');
  }
  await evaluateInApp("document.querySelector('#hop-add-hover-smoke button').focus()");
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await settle();
  const mobile = await inspect();
  assert.ok(mobile.coarse && !mobile.hover, 'touch pointer emulation unavailable');
  assert.ok(mobile.buttons.every(button => button.opacity === 1), 'touch users must not need hover to find add');
  const gap = mobile.buttons.find(button => button.gap);
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gap.x + gap.width / 2, y: gap.y + gap.height / 2 }] });
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await evaluateInApp("document.getElementById('hop-add-hover-smoke').dataset.clicked"), '1', 'touch add remains directly tappable');
  console.log('ok - desktop hidden/edge hover/click/keyboard, stable geometry and touch-visible/tappable add controls');
} finally {
  await evaluateInApp("(() => { document.getElementById('hop-add-hover-smoke')?.remove(); const focus = window.__hopAddHoverSmokeFocus; if (focus?.isConnected) focus.focus({ preventScroll: true }); delete window.__hopAddHoverSmokeFocus; })()");
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
