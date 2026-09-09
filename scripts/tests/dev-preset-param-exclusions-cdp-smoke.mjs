// Narrow visual check for the new Preset badges; profile data stays in memory.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const page = await findAppPageTarget(), pending = new Map();
const touchOnly = process.argv.includes('--touch-only');
let socket, id = 0, touching = false;
const viewport = await evaluateInApp('({width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio})');
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const seq = ++id; pending.set(seq, { resolve, reject }); socket.send(JSON.stringify({ id: seq, method, params }));
});
const ev = source => evaluateInApp(`(async () => { const f = window.__presetParamBadgeFixture; ${source} })()`);
try {
  await evaluateInApp(`(async () => {
    const { PresetPanel } = await import('/scripts/ui/preset-panel.js');
    const original = document.getElementById('preset-panel'), overlay = document.getElementById('preset-overlay');
    if (original && getComputedStyle(original).display !== 'none') throw new Error('Preset has an open user draft');
    if (original) original.id = 'preset-panel-badge-original'; if (overlay) overlay.id = 'preset-overlay-badge-original';
    const panel = new PresetPanel();
    await panel.store.ready;
    panel.setRuntimeContext({ configPanel: { getDraftConfig: () => ({ name: 'Fixture API', provider: 'custom', model: 'gpt-5', apiFormat: 'responses',
      baseUrl: 'https://badge-fixture.example/v1', excludedGenerationParams: ['temperature', 'top_p', 'max_output_tokens', 'reasoning_effort'] }) } });
    window.__presetParamBadgeFixture = { panel, original, overlay, state: JSON.stringify(panel.store.getState()), focus: document.activeElement };
    await panel.show({ section: 'openai', focusParam: 'temperature' });
  })()`);
  for (const width of touchOnly ? [320] : [1200, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width < 600 });
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = await ev(`const badge=f.panel.element.querySelector('[data-param-field="temperature"]');badge.scrollIntoView({block:'center'});
      const r=badge.getBoundingClientRect(),root=f.panel.element.getBoundingClientRect();
      return { badges: f.panel.element.querySelectorAll('[data-param-field]').length, badgeFits:r.left>=root.left&&r.right<=root.right,
        profileSaved:JSON.stringify(f.panel.store.getState())!==f.state };`);
    assert.equal(result.badges, 4); assert.equal(result.badgeFits, true); assert.equal(result.profileSaved, false);
    if (!touchOnly && process.env.REQUEST_PARAMS_SCREENSHOT_DIR) {
      const { data } = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${process.env.REQUEST_PARAMS_SCREENSHOT_DIR}/preset-param-exclusions-${width}.png`, Buffer.from(data, 'base64'));
    }
    console.log(JSON.stringify({ width, ...result }));
  }
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const point = await ev(`const r=f.panel.element.querySelector('[data-param-field="temperature"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`);
  touching = true;
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); touching = false;
  const tip = await ev(`const badge=f.panel.element.querySelector('[data-param-field="temperature"]');return { visible: [...document.querySelectorAll('.app-help-tip[aria-hidden="false"]')].some(el=>el.textContent.includes(badge.dataset.help)), profileNameFromActiveContext: !badge.dataset.help.includes('Fixture API') };`);
  assert.equal(tip.visible, true, JSON.stringify(tip));
  console.log('Preset exclusion badges and touch help passed; model requests: 0');
} finally {
  if (touching) await command('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await ev(`if(f){f.panel.hide();f.panel.element?.remove();f.panel.overlayElement?.remove();
    if(f.original)f.original.id='preset-panel';if(f.overlay)f.overlay.id='preset-overlay';
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));f.focus?.focus?.({preventScroll:true});delete window.__presetParamBadgeFixture;}`);
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false });
  await command('Emulation.clearDeviceMetricsOverride'); socket.close();
}
process.exit(0);
