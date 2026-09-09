// Windows dev WebView. In-memory profiles and an intercepted fixture host only.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const page = await findAppPageTarget(), pending = new Map();
const initialViewport = await evaluateInApp('({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })');
let client, id = 0, touching = false;
await new Promise((resolve, reject) => {
  client = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => { const seq = ++id; pending.set(seq, { resolve, reject }); client.send(JSON.stringify({ id: seq, method, params })); });
const ev = source => evaluateInApp(`(async () => { const f = window.__responsesConfigSmoke; ${source} })()`);
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const screenshot = async name => {
  if (!process.env.RESPONSES_SCREENSHOT_DIR) return;
  const { data } = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${process.env.RESPONSES_SCREENSHOT_DIR}/responses-${name}.png`, Buffer.from(data, 'base64'));
};
try {
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  const setup = await evaluateInApp(`(async () => {
    const { ConfigPanel } = await import('/scripts/ui/config-panel.js');
    const { CustomProvider } = await import('/scripts/api/providers/custom.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const oldPanel = document.getElementById('config-panel');
    check(!oldPanel || getComputedStyle(oldPanel).display === 'none', 'API panel has an active user draft');
    const oldOverlay = document.getElementById('config-overlay');
    if (oldPanel) oldPanel.id = 'config-panel-smoke-original';
    if (oldOverlay) oldOverlay.id = 'config-overlay-smoke-original';
    const runtime = { id: 'responses-ui-fixture', name: 'Muse Spark', provider: 'custom', apiFormat: 'responses', baseUrl: 'https://responses-ui.example/v1', apiKey: 'fixture-key', model: 'muse-spark', stream: true, timeout: 60000, connectionMode: 'direct', forwardProviderAuth: true };
    const manager = { ensureStores: async () => {}, load: async () => ({...runtime}), get: () => ({...runtime}), getDefault: () => ({...runtime}), getProfiles: () => [{...runtime}], getActiveProfile: () => ({...runtime}), getActiveProfileId: () => runtime.id, listKeys: () => [], validate: () => {}, save: async data => { const key = runtime.apiKey; Object.assign(runtime, data); runtime.apiKey = data.apiKey || key; } };
    const panel = new ConfigPanel({ chatConfigManager: manager, imageConfigManager: manager, voiceSharedConfigManager: manager, voiceTtsConfigManager: manager, voiceSttConfigManager: manager, webSearchCredentialManager: manager });
    let draftEvents = 0, requests = [];
    panel.emitDraftChange = () => { draftEvents++; };
    panel.refreshMaidSearchInputs = async () => {};
    panel.updateFcCompatibilitySummary = () => {};
    const originalRequest = CustomProvider.prototype.request;
    CustomProvider.prototype.request = async function(req) {
      if (new URL(req.url).hostname !== 'responses-ui.example') return originalRequest.call(this, req);
      requests.push({ url: req.url, method: req.method, body: req.body ? JSON.parse(req.body) : null });
      return { status: 200, ok: true, body: JSON.stringify(req.method === 'GET'
        ? { data: [{ id: 'muse-spark' }, { id: 'muse-spark-next' }] }
        : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }) };
    };
    window.__responsesConfigSmoke = { panel, manager, runtime, requests, check, oldPanel, oldOverlay, originalRequest, CustomProvider, previousFocus: document.activeElement, get draftEvents() { return draftEvents; } };
    await panel.show();
    check(panel.getFormData().apiFormat === 'responses', 'loaded Responses profile changed format');
    check(panel.element.querySelector('#config-api-format-section').getBoundingClientRect().height > 0, 'format selector missing');
    return true;
  })()`);
  assert.equal(setup, true); await pause(400); await screenshot('desktop');
  await ev(`const input = f.panel.element.querySelector('input[value="chat_completions"]'); input.focus();`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  assert.equal(await ev('return f.panel.getFormData().apiFormat;'), 'responses');
  const checks = await ev(`
    const root = f.panel.element;
    root.querySelector('input[value="chat_completions"]').click();
    f.check(f.panel.getFormData().apiFormat === 'chat_completions', 'Chat Completions selection failed');
    root.querySelector('input[value="responses"]').click();
    await f.manager.save(f.panel.getFormData()); f.panel.populateForm(await f.manager.load());
    f.check(f.panel.getFormData().apiFormat === 'responses', 'form roundtrip lost Responses');
    await f.panel.onTest();
    f.check(root.querySelector('#config-status').classList.contains('is-success'), 'test button failed: '+root.querySelector('#config-status').textContent);
    f.check(f.requests[0].url.endsWith('/responses') && f.requests[0].body.input.length === 1, 'test button used wrong wire format');
    await f.panel.refreshModels();
    f.check(f.requests.at(-1).url.endsWith('/models'), 'refresh used wrong endpoint');
    f.check(root.querySelectorAll('#model-options button').length === 2, 'models not displayed as a list');
    [...root.querySelectorAll('#model-options button')].find(b => b.textContent === 'muse-spark-next').click();
    f.check(root.querySelector('#config-model').value === 'muse-spark-next', 'model chip failed');
    root.querySelector('#config-model').value = 'custom-entered-model';
    f.check(f.panel.getFormData().model === 'custom-entered-model', 'manual model entry failed');
    f.panel.activeTab = 'image'; f.panel.updateFieldVisibility('custom');
    f.check(getComputedStyle(root.querySelector('#config-api-format-section')).display === 'none', 'image settings show text format');
    f.check(f.panel.getFormData().apiFormat === 'chat_completions', 'image settings leaked Responses');
    f.panel.activeTab = 'voice'; f.panel.updateFieldVisibility('custom');
    f.check(getComputedStyle(root.querySelector('#config-api-format-section')).display === 'none', 'voice settings show text format');
    f.panel.activeTab = 'chat'; f.panel.updateFieldVisibility('opencode');
    f.check(getComputedStyle(root.querySelector('#config-api-format-section')).display !== 'none', 'OpenCode format missing');
    f.panel.updateFieldVisibility('openai');
    f.check(getComputedStyle(root.querySelector('#config-api-format-section')).display === 'none', 'fixed provider format should stay hidden');
    f.panel.populateForm(f.runtime); f.panel.clearModelOptions();
    root.querySelector('#config-status').style.display = 'none';
    return { requests: f.requests.length, draftEvents: f.draftEvents };
  `);
  for (const width of [390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 1, mobile: true });
    await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await ev(`f.panel.element.querySelector('#config-api-format-section').scrollIntoView({block:'center'});`); await pause();
    const bounds = await ev(`const root = f.panel.element, picker = root.querySelector('.api-config-format-picker'); const r = picker.getBoundingClientRect(); const buttons = [...picker.querySelectorAll('span')].map(n => { const p=n.getBoundingClientRect(); return { x:p.x+p.width/2, y:p.y+p.height/2, h:p.height }; }); return { left:r.left, right:r.right, overflow:picker.scrollWidth>picker.clientWidth, buttons };`);
    assert.ok(bounds.left >= 0 && bounds.right <= width && !bounds.overflow);
    assert.ok(bounds.buttons.every(p => p.h >= 44));
    for (const [index, value] of [[0, 'chat_completions'], [1, 'responses']]) {
      const p = bounds.buttons[index]; touching = true;
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x:p.x, y:p.y, id:1 }] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); touching = false;
      await pause(); assert.equal(await ev('return f.panel.getFormData().apiFormat;'), value);
    }
    await screenshot('mobile-'+width);
  }
  const helpPoint = await ev(`const r = f.panel.element.querySelector('#config-api-format-label').getBoundingClientRect(); return {x:r.x+20,y:r.y+r.height/2};`);
  touching = true;
  await command('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{...helpPoint,id:1}] });
  await command('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] }); touching = false; await pause(180);
  assert.equal(await ev(`return [...document.querySelectorAll('.app-help-tip[aria-hidden="false"]')].some(n => n.textContent.includes('/responses'));`), true, 'phone tap help missing');
  await screenshot('mobile-help');
  console.log(JSON.stringify({ passed:true, ...checks, viewports:[1200,390,320], keyboard:true, trustedTouch:true, tooltip:true, modelRequests:0 }));
} finally {
  if (touching) await command('Input.dispatchTouchEvent', { type:'touchCancel', touchPoints:[] });
  await ev(`if (f) {
    f.CustomProvider.prototype.request = f.originalRequest;
    f.panel.hide(); f.panel.closeCustomSelectMenu(); f.panel.element?.remove(); f.panel.overlayElement?.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    if (f.oldPanel) f.oldPanel.id='config-panel'; if (f.oldOverlay) f.oldOverlay.id='config-overlay';
    f.previousFocus?.focus?.({preventScroll:true}); delete window.__responsesConfigSmoke;
  }`);
  await command('Emulation.setTouchEmulationEnabled', { enabled:false });
  await command('Emulation.setDeviceMetricsOverride', {...initialViewport,mobile:false});
  await command('Emulation.clearDeviceMetricsOverride'); client.close();
}
process.exit(0);
