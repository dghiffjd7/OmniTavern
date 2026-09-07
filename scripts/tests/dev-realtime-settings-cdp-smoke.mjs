import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const output = '../realtime-checks'; mkdirSync(output, { recursive: true });
await evaluateInApp(readFileSync('scripts/dev/realtime-ui-inspect.js', 'utf8'));
const page = await findAppPageTarget(), pending = new Map(); let socket, sequence = 0;
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const results = [];
try {
  await evaluateInApp(`(async () => {
    const { getCurrentLocale } = await import('/scripts/i18n/index.js'); window.__realtimeSmokeLocale = getCurrentLocale();
    if (!document.querySelector('#rt-provider')) { document.querySelector('#rt-new').click(); await new Promise(r => setTimeout(r, 50)); }
    return true;
  })()`);
  for (const provider of ['gemini_live','doubao_realtime','qwen_audio_realtime','step_realtime','xai_voice','nova_sonic','openai']) {
    const row = await evaluateInApp(`(() => {
      const select = document.querySelector('#rt-provider'); select.value = ${JSON.stringify(provider)}; select.dispatchEvent(new Event('change'));
      return { provider: document.querySelector('#rt-provider').value, model: document.querySelector('#rt-model').value, secretFields: [...document.querySelectorAll('[data-secret]')].map(e => e.dataset.secret), legacyHidden: !document.querySelector('#config-realtime-model').getClientRects().length };
    })()`);
    assert.equal(row.provider, provider); assert(row.model); assert(row.legacyHidden); results.push(row);
  }
  for (const mode of ['service_account', 'express']) {
    const row = await evaluateInApp(`(() => {
      const change = (id, value) => { const node = document.querySelector(id); node.value = value; node.dispatchEvent(new Event('change')); };
      change('#rt-provider', 'gemini_live'); change('#rt-gemini-backend', 'vertex'); change('#rt-vertex-auth-mode', ${JSON.stringify(mode)});
      return { provider: document.querySelector('#rt-provider').value, model: document.querySelector('#rt-model').value, secretFields: [...document.querySelectorAll('[data-secret]')].map(e => e.dataset.secret), project: !!document.querySelector('#rt-vertex-project'), region: document.querySelector('#rt-region')?.value || '' };
    })()`);
    assert.equal(row.provider, 'gemini_live'); assert.equal(row.model, 'gemini-live-2.5-flash-native-audio');
    assert.deepEqual(row.secretFields, [mode === 'express' ? 'vertexaiApiKey' : 'vertexaiServiceAccount']);
    assert.equal(row.project, mode === 'service_account'); assert.equal(row.region, mode === 'service_account' ? 'us-central1' : ''); results.push({ mode, ...row });
  }
  for (const [width, locale] of [[1100,'zh-CN'], [390,'en']]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const layout = await evaluateInApp(`(async () => {
      const { initializeI18n } = await import('/scripts/i18n/index.js'); await initializeI18n({ preference: ${JSON.stringify(locale)} });
      const select = document.querySelector('#rt-provider'); select.value = 'doubao_realtime'; select.dispatchEvent(new Event('change'));
      const refresh = document.querySelector('#rt-refresh-models'); refresh.click();
      const deadline = Date.now() + 3000; while (refresh.disabled && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      document.querySelector('#rt-profile').scrollIntoView({ block: 'start' });
      await new Promise(r => setTimeout(r, 150));
      const root = document.querySelector('.api-config-realtime-profiles'), rect = root.getBoundingClientRect();
      return { label: document.querySelector('#rt-save').textContent, candidates: root.querySelectorAll('#rt-model-options .api-config-model-chip').length, overflow: [...root.querySelectorAll('input,select,button,textarea')].filter(e => e.getClientRects().length).some(e => e.getBoundingClientRect().right > rect.right + 2), viewport: innerWidth };
    })()`);
    assert(!layout.overflow, `Form overflows at ${width}px`);
    assert.equal(layout.candidates, 2, 'Built-in fallback list should be visible');
    if (locale === 'en') assert.equal(layout.label, 'Save and use');
    const shot = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${output}/realtime-model-picker-${width}-${locale}.png`, Buffer.from(shot.data, 'base64'));
    results.push({ width, locale, ...layout });
  }
  console.log(JSON.stringify({ passed: true, results, screenshots: output }, null, 2));
} finally {
  await command('Emulation.clearDeviceMetricsOverride');
  await evaluateInApp(`(async () => {
    const { initializeI18n } = await import('/scripts/i18n/index.js'); await initializeI18n({ preference: window.__realtimeSmokeLocale || 'zh-CN' }); delete window.__realtimeSmokeLocale;
    const select = document.querySelector('#rt-provider'); if (select) { select.value = 'qwen_audio_realtime'; select.dispatchEvent(new Event('change')); }
  })()`);
  socket.close();
}
