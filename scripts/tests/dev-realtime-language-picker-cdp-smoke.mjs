// Uses an in-memory settings panel in the running Windows WebView. No API calls.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const page = await findAppPageTarget(), pending = new Map(); let socket, sequence = 0;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const ev = code => evaluateInApp(`(async () => { const f = window.__rtLanguageSmoke; ${code} })()`);
const pause = () => new Promise(resolve => setTimeout(resolve, 180));
const click = async (selector, mobile = false) => {
  await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});`); await pause();
  const target = await ev(`const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect(); const x = r.left+r.width/2, y = r.top+r.height/2, hit = document.elementFromPoint(x,y); return { x, y, hit: hit?.className, reachable: node.contains(hit) };`);
  assert(target.reachable, `click target ${selector}: ${JSON.stringify(target)}`);
  const point = { x: target.x, y: target.y };
  if (mobile) {
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  await pause();
};
const key = async (key, virtual) => {
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: virtual, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: virtual }); await pause();
};
const menuState = () => ev(`const menu = document.querySelector('.realtime-reply-language-menu'); const r = menu?.getBoundingClientRect(); return {
  open: !!menu && menu.style.display !== 'none', value: f.panel.root.querySelector('#rt-reply-language').value,
  count: menu?.querySelectorAll('button').length, within: !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
  rect: r?.toJSON(), viewport: { width: innerWidth, height: innerHeight },
  expanded: f.panel.root.querySelector('.realtime-reply-language-toggle').getAttribute('aria-expanded'),
};`);
try {
  await evaluateInApp(`(async () => {
    const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
    const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
    const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
    const picker = await import('/scripts/ui/realtime/realtime-reply-language-picker.js');
    const { initializeI18n, getCurrentLocale } = await import('/scripts/i18n/index.js');
    const previous = document.querySelector('#config-panel'), previousFocus = document.activeElement, locale = getCurrentLocale();
    if (previous) previous.id = 'config-panel-before-language-smoke';
    const host = document.createElement('div'); host.id = 'config-panel'; host.className = 'api-config-panel is-open';
    host.style.cssText = 'position:fixed;inset:0;z-index:24000;display:block;overflow:auto;pointer-events:auto;padding:24px;background:var(--app-surface-card)';
    host.innerHTML = '<div style="max-width:620px;margin:0 auto"><div id="rt-language-card"><h3 class="api-config-realtime-heading">Realtime</h3></div><div id="rt-language-legacy"></div></div>';
    document.body.append(host);
    const keys = new Map(); let n = 0;
    const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem() {} }, invoke: async () => null,
      keyring: { addKey: async (id, value) => { const key = String(++n); keys.set(key,value); return key; }, decryptKey: async (id,key) => keys.get(key), removeKey: async (id,key) => keys.delete(key) } });
    const panel = new RealtimeSettingsPanel({ card: host.querySelector('#rt-language-card'), store }); panel.targetFields = () => '';
    window.__rtLanguageSmoke = { host, panel, store, picker, previous, previousFocus, locale, initializeI18n, makeRealtimeProfile };
    await panel.ready; await initializeI18n({ preference:'zh-CN' });
    panel.draft = makeRealtimeProfile('gemini_live'); panel.render();
  })()`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('#rt-language-card .realtime-reply-language-toggle');
  let state = await menuState(); assert(state.open && state.within, JSON.stringify(state)); assert.equal(state.count, 10);
  await click('.realtime-reply-language-menu [data-value="台湾普通话"]');
  state = await menuState(); assert.equal(state.value, '台湾普通话'); assert(!state.open); assert.equal(state.expanded, 'false');
  assert.equal(await ev('return f.panel.dirty;'), true);
  await ev(`f.panel.root.querySelector('[data-secret="apiKey"]').value = 'offline-only'; await f.panel.root.querySelector('#rt-save').onclick();`);
  assert.equal(await ev(`return f.store.get(f.panel.draft.id).replyLanguage;`), '台湾普通话');
  await ev(`const input = f.panel.root.querySelector('#rt-reply-language'); input.value = 'English with a light Irish accent'; input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await click('#rt-language-card .realtime-reply-language-toggle'); await key('Escape', 27);
  assert.equal((await menuState()).value, 'English with a light Irish accent', 'opening/cancelling preserves custom text');
  await ev(`f.panel.root.querySelector('#rt-reply-language').focus();`); await key('ArrowDown', 40); await key('Home', 36); await key('Enter', 13);
  assert.equal((await menuState()).value, '', 'keyboard can select Automatic');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true });
  await click('#rt-language-card .realtime-reply-language-toggle', true);
  state = await menuState(); assert(state.open && state.within, JSON.stringify(state));
  mkdirSync('scripts/dev/tmp/realtime-language-picker', { recursive: true });
  const shot = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync('scripts/dev/tmp/realtime-language-picker/mobile.png', Buffer.from(shot.data,'base64'));
  await click('.realtime-reply-language-menu [data-value="日文"]', true); assert.equal((await menuState()).value, '日文');
  await click('#rt-language-card .realtime-reply-language-toggle', true);
  await ev(`f.panel.render();`); assert.equal((await menuState()).expanded, 'false', 'render dismisses the old menu');
  await ev(`f.panel.draft = f.makeRealtimeProfile('nova_sonic'); f.panel.render();`);
  await click('#rt-language-card .realtime-reply-language-toggle', true); assert.equal((await menuState()).count, 5);
  await ev(`const host = f.host.querySelector('#rt-language-legacy'); host.style.cssText = 'position:fixed;top:24px;left:24px;right:24px;background:var(--app-surface-card);padding:12px'; host.innerHTML = f.picker.realtimeReplyLanguageField('legacy-language','自定义口音'); f.legacy = f.picker.bindRealtimeReplyLanguagePicker(host.querySelector('input')); host.querySelector('button').click();`);
  assert.equal((await menuState()).expanded, 'false', 'another anchor closes the previous menu and ARIA state');
  await click('.realtime-reply-language-menu [data-value="英文"]', true);
  assert.equal(await ev(`return f.host.querySelector('#legacy-language').value;`), '英文');
  await ev(`f.legacy.close(); f.panel.hide();`);
  console.log('realtime language picker passed: dropdown, custom text, auto, keyboard, touch, persistence, Nova and menu cleanup');
} finally {
  await evaluateInApp(`(async () => { const f=window.__rtLanguageSmoke; if(!f)return; f.legacy?.destroy(); f.panel.hide(); f.panel.languagePicker?.destroy(); f.panel.voicePicker?.destroy(); f.host.remove(); if(f.previous)f.previous.id='config-panel'; await f.initializeI18n({preference:f.locale}); f.previousFocus?.focus?.(); delete window.__rtLanguageSmoke; })()`);
  await command('Emulation.setTouchEmulationEnabled', { enabled: false }); await command('Emulation.clearDeviceMetricsOverride'); socket.close();
}
