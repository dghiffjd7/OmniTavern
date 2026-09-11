// Runs in the Windows dev WebView with an isolated, in-memory parameter preset.
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
const ev = code => evaluateInApp(`(async () => { const f = window.__imageSizeSmoke; ${code} })()`);
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
const key = async (key, code) => {
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code }); await pause();
};
const state = () => ev(`const input = f.panel.body.querySelector('.image-size-value'), select = f.panel.body.querySelector('[data-image-size-choice]'); return {
  value: input?.value, hidden: input?.hidden, selected: select?.value, valid: input?.checkValidity(),
  options: [...(select?.options || [])].map(o => o.value), saved: f.preset.paramsByProvider.openai.size,
};`);
try {
  await evaluateInApp(`(async () => {
    const { ImageGenerationParamsPanel } = await import('/scripts/ui/image-generation-params-panel.js');
    const utils = await import('/scripts/ui/image-generation-params-utils.js');
    const controls = await import('/scripts/ui/image-generation-size-control.js');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:20px;z-index:30000;max-width:660px;margin:auto;border-radius:16px;overflow:hidden;background:var(--app-surface-card)';
    document.body.append(host);
    const f = { host, focus: document.activeElement, utils, controls, config: { provider: 'openai', model: 'gpt-image-2.5-sunburst' }, preset: utils.createDefaultImageGenerationPreset(), changes: 0 };
    const store = { ready: Promise.resolve(), list: () => [structuredClone(f.preset)], getActive: () => structuredClone(f.preset), upsert: async value => { f.preset = structuredClone(value); } };
    f.panel = new ImageGenerationParamsPanel({ store, getImageConfig: async () => f.config });
    f.panel.emitChanged = () => {}; f.panel.showStatus = () => {};
    window.__imageSizeSmoke = f; await f.panel.showEmbedded({ container: host });
  })()`);
  let current = await state(); assert.equal(current.options.length, 10); assert(current.hidden);
  await ev(`f.panel.body.querySelector('[data-image-size-choice]').focus();`); await key('End', 35);
  assert.equal((await state()).hidden, false);
  await command('Input.insertText', { text: '3840✖2160' }); await key('Tab', 9);
  assert.equal((await state()).value, '3840x2160');
  await ev(`await f.panel.saveCurrent();`); current = await state();
  assert.equal(current.saved, '3840x2160'); assert.equal(current.selected, '3840x2160'); assert(current.hidden);
  await ev(`const el = f.panel.body.querySelector('[data-image-size-choice]'); el.value = '__custom__'; el.dispatchEvent(new Event('change', {bubbles:true}));`);
  await command('Input.insertText', { text: '3840x3840' });
  assert.equal((await state()).valid, false);
  await ev(`await f.panel.saveCurrent();`); assert.equal((await state()).saved, '3840x2160', 'invalid dimensions do not overwrite the preset');
  await ev(`const input = f.panel.body.querySelector('.image-size-value'); input.value = '1536 × 864'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); await f.panel.saveCurrent();`);
  current = await state(); assert.equal(current.saved, '1536x864'); assert.equal(current.selected, '__custom__'); assert(!current.hidden);
  await ev(`f.config.model = 'gpt-image-1.5'; await f.panel.render();`);
  assert.equal(await ev(`return f.panel.body.querySelector('[data-param-key="size"]').options.length;`), 4);
  await ev(`f.config.model = 'gpt-image-2.5-flare'; await f.panel.render();`); assert.equal((await state()).value, '1536x864');
  mkdirSync('scripts/dev/tmp/image-size', { recursive: true });
  for (const width of [1100, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 860, deviceScaleFactor: 1, mobile: width < 600 }); await pause();
    await ev(`f.panel.body.querySelector('.image-size-control').scrollIntoView({block:'center'});`); await pause();
    const layout = await ev(`const control = f.panel.body.querySelector('.image-size-control'), r=control.getBoundingClientRect(); return { left:r.left, right:r.right, overflow:control.scrollWidth > control.clientWidth + 1 };`);
    assert(layout.left >= 0 && layout.right <= width && !layout.overflow, JSON.stringify({width,layout}));
    const shot = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync('scripts/dev/tmp/image-size/' + width + '.png', Buffer.from(shot.data,'base64'));
  }
  await command('Emulation.setTouchEmulationEnabled', {enabled:true});
  const point = await ev(`const input = f.panel.body.querySelector('.image-size-value'); input.blur(); const r=input.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
  await command('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{...point,id:1}]});
  await command('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  assert.equal(await ev(`return document.activeElement === f.panel.body.querySelector('.image-size-value');`), true);
  await ev(`const field=f.utils.resolveImageGenerationParamSchema(f.config).fields.find(item=>item.key==='size'); f.panel.hide();
    f.chat=f.controls.createImageGenerationSizeControl({field,value:'2160x3840',controlClass:'chat-image-gen-param-field',onChange:()=>{f.changes++;}}); f.host.append(f.chat);
    const select=f.chat.querySelector('select'); select.value='3840x2160'; select.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.equal(await ev(`return f.chat.querySelector('[data-param-key="size"]').value;`), '3840x2160');
  assert.equal(await ev(`return f.changes;`), 2, 'chat/moments control notifies the existing override collectors');
  console.log('passed: 4K presets, keyboard/custom input, invalid save guard, model switching, restored custom value, 1100/390/320px layout, touch and chat control callbacks');
} finally {
  await ev(`if (f) { f.panel.hide(); f.host.remove(); f.focus?.focus?.(); delete window.__imageSizeSmoke; }`);
  await command('Emulation.setTouchEmulationEnabled', {enabled:false}); await command('Emulation.clearDeviceMetricsOverride'); socket.close();
}
