import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const page = await findAppPageTarget(); let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return;
  pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const results = [];
try {
  await evaluateInApp(`(async () => {
    const { createRealtimeCallPanel } = await import('/scripts/ui/realtime/realtime-call-panel.js');
    const { REALTIME_PROVIDERS } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
    const { initializeI18n, getCurrentLocale } = await import('/scripts/i18n/index.js');
    const host = document.createElement('div'); document.body.append(host);
    const panel = createRealtimeCallPanel({ documentRef: { body: host, createElement: name => document.createElement(name) } });
    window.__rtPanelSmoke = { host, panel, providers: REALTIME_PROVIDERS, locale: getCurrentLocale(), initializeI18n };
  })()`);
  for (const [width, locale] of [[1100, 'zh-CN'], [390, 'en']]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    const result = await evaluateInApp(`(async () => {
      const f = window.__rtPanelSmoke; await f.initializeI18n({ preference: ${JSON.stringify(locale)} });
      f.panel.show({ name: 'Gemini Live' }); const rows = [];
      for (const provider of Object.keys(f.providers)) {
        f.panel.renderState({ status: 'connecting', provider });
        const status = f.host.querySelector('.realtime-call-status'), disclosure = f.host.querySelector('.realtime-call-disclosure');
        const box = f.host.querySelector('.realtime-call-panel');
        rows.push({ provider, label: status.textContent, disclosure: disclosure.textContent,
          overflow: box.scrollWidth > box.clientWidth + 2 || status.getBoundingClientRect().right > box.getBoundingClientRect().right });
      }
      f.panel.renderState({ status: 'connecting', provider: '' });
      const fallback = f.host.querySelector('.realtime-call-status').textContent;
      f.panel.renderState({ status: 'connecting', provider: 'gemini_live' });
      await new Promise(r => setTimeout(r, 350));
      return { rows, fallback };
    })()`);
    for (const row of result.rows) {
      assert(!row.overflow, `${width}/${row.provider} overflows`);
      if (row.provider !== 'openai') assert(!row.label.includes('OpenAI') && !row.disclosure.includes('OpenAI'));
      if (row.provider === 'gemini_live') assert(row.label.includes('Gemini Live') && row.disclosure.includes('Gemini Live'));
    }
    assert(!result.fallback.includes('OpenAI'));
    const shot = await command('Page.captureScreenshot', { format: 'png' }); mkdirSync('../realtime-checks', { recursive: true });
    writeFileSync(`../realtime-checks/realtime-call-provider-${width}-${locale}.png`, Buffer.from(shot.data, 'base64'));
    results.push({ width, locale, ...result });
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await evaluateInApp(`(async () => { const f = window.__rtPanelSmoke; if (!f) return; f.panel.hide(); f.host.remove(); await f.initializeI18n({ preference: f.locale }); delete window.__rtPanelSmoke; })()`);
  await command('Emulation.clearDeviceMetricsOverride'); socket.close();
}
