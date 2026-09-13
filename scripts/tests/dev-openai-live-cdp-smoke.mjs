// Isolated Windows WebView fixtures. No real credentials, saved user settings,
// microphone access or billable OpenAI sessions.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const page = await findAppPageTarget();
let socket, sequence = 0; const pending = new Map(), results = [];
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const data = JSON.parse(raw), waiter = pending.get(data.id); if (!waiter) return;
    pending.delete(data.id); data.error ? waiter.reject(new Error(data.error.message)) : waiter.resolve(data.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const ev = body => evaluateInApp(`(async () => { const f = window.__liveSmoke; ${body} })()`);
const output = 'scripts/dev/tmp/openai-live'; mkdirSync(output, { recursive: true });
const screenshot = async name => {
  const result = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${output}/${name}.png`, Buffer.from(result.data, 'base64'));
};
try {
  await evaluateInApp(`(async () => {
    const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
    const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
    const { RealtimeModelDiscovery } = await import('/scripts/ui/realtime/realtime-model-discovery.js');
    const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
    const { createRealtimeCallPanel } = await import('/scripts/ui/realtime/realtime-call-panel.js');
    const { initializeI18n, getCurrentLocale } = await import('/scripts/i18n/index.js');
    const locale = getCurrentLocale(), focus = document.activeElement;
    const host = document.createElement('section'); host.id = 'config-panel'; host.className = 'api-config-panel';
    host.style.cssText = 'position:fixed;inset:12px 12px 12px auto;width:min(720px,calc(100vw - 24px));height:calc(100vh - 24px);box-sizing:border-box;padding:18px;overflow:auto;background:var(--app-surface-card);z-index:100000;display:block;pointer-events:auto;transform:none;visibility:visible;opacity:1;border:1px solid var(--app-border-default);border-radius:16px;';
    host.innerHTML = '<div class="api-config-realtime-card"><div class="api-config-realtime-heading"><h3>实时语音</h3></div></div>';
    const styles = ['api-config', 'chat'].map(name => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/assets/css/' + name + '.css?liveSmoke=' + Date.now(); document.head.append(link); return link; });
    const keys = new Map();
    const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem() {} }, invoke: async () => null,
      keyring: { addKey: async (id, key) => { keys.set(id, key); return 'fixture'; }, decryptKey: async id => keys.get(id), removeKey: async () => {} },
    });
    await store.save(makeRealtimeProfile('openai'), { apiKey: 'FIXTURE' });
    document.body.append(host);
    const f = { host, store, styles, locale, initializeI18n, focus, fail: false, requests: 0 };
    const modelDiscovery = new RealtimeModelDiscovery({ invoke: async () => {
      f.requests++;
      return f.fail ? { status: 401, body: '{}' } : { status: 200, body: JSON.stringify({ data: [
        { id: 'gpt-live-1' }, { id: 'gpt-live-1-2026-09-11' }, { id: 'gpt-live-transcribe' }, { id: 'gpt-realtime-2.1' },
        ...Array.from({ length: 131 }, (_, i) => ({ id: i ? 'gpt-5.6-model-' + i : 'gpt-5.6-luna' }))] }) };
    } });
    f.panel = new RealtimeSettingsPanel({ card: host.firstElementChild, store, modelDiscovery }); await f.panel.ready;
    f.query = id => host.querySelector('#' + id);
    f.change = (id, value) => { const node = f.query(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
    f.settle = async () => { const deadline = Date.now() + 3000; while (f.panel.busy && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); if (f.panel.busy) throw Error('fixture operation timeout'); };
    f.callHost = document.createElement('div'); f.callHost.style.cssText = 'position:fixed;inset:0;z-index:100010;pointer-events:none'; document.body.append(f.callHost);
    f.call = createRealtimeCallPanel({ documentRef: { body: f.callHost, createElement: name => document.createElement(name) } });
    window.__liveSmoke = f;
  })()`);
  const config = await ev(`
    f.change('rt-openai-backend', 'live');
    if (f.query('rt-model').value !== 'gpt-live-1' || f.query('rt-backend-model').value !== 'gpt-5.6-luna') throw Error('incorrect defaults');
    if (f.query('rt-transcription-language')) throw Error('Live exposes separate STT config');
    f.query('rt-refresh-models').click(); await f.settle();
    f.query('rt-refresh-backend-models').click(); await f.settle();
    const models = [...f.query('rt-model-options').querySelectorAll('button')].map(e => e.textContent);
    const backendCount = f.query('rt-backend-model-options').querySelectorAll('button').length;
    f.change('rt-model', 'gpt-live-1-future'); f.change('rt-backend-model', 'gpt-5.6-custom');
    f.query('rt-refresh-models').click(); await f.settle(); f.query('rt-refresh-backend-models').click(); await f.settle();
    if (f.query('rt-model').value !== 'gpt-live-1-future' || f.query('rt-backend-model').value !== 'gpt-5.6-custom') throw Error('refresh overwrote manual IDs');
    f.fail = true; f.query('rt-refresh-models').click(); await f.settle();
    if (!f.query('rt-status').textContent.includes('401') || f.query('rt-model').value !== 'gpt-live-1-future') throw Error('failed refresh lost input'); f.fail = false;
    f.change('rt-model', 'gpt-live-1'); f.change('rt-backend-model', 'gpt-5.6-luna'); f.change('rt-voice', 'willow');
    f.query('rt-save').click(); await f.settle(); const saved = f.store.get(f.store.activeId);
    f.change('rt-openai-backend', 'realtime');
    if (f.query('rt-model').value !== 'gpt-realtime-2.1' || f.query('rt-voice').value !== 'marin') throw Error('incompatible Live voice survived protocol switch');
    f.change('rt-openai-backend', 'live'); f.change('rt-voice', 'willow');
    return { models, backendCount, voiceCount: f.query('rt-voice-options').querySelectorAll('[data-rt-voice]').length, saved: { backend: saved.openaiBackend, model: saved.model, voice: saved.voice }, externalRequests: 0 };
  `);
  assert.deepEqual(config.models, ['gpt-live-1', 'gpt-live-1-2026-09-11']); assert.equal(config.backendCount, 131);
  assert.equal(config.voiceCount, 22); assert.equal(config.saved.backend, 'live'); assert.equal(config.saved.voice, 'willow'); results.push(config);
  for (const [width, locale] of [[1100, 'zh-CN'], [390, 'zh-TW'], [320, 'en']]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await ev(`await f.initializeI18n({ preference: ${JSON.stringify(locale)}, fetchFn: url => fetch(url + '?liveSmoke=' + Date.now()) }); f.panel.render(); f.host.scrollTop = 0; await new Promise(r => setTimeout(r, 250));`);
    const layout = await ev(`const root = f.panel.root, rect = f.host.getBoundingClientRect();
      return { overflow: f.host.scrollWidth > f.host.clientWidth + 2 || [...root.querySelectorAll('input,select,button')].filter(e => e.getClientRects().length).some(e => e.getBoundingClientRect().right > rect.right + 2),
        title: f.query('rt-backend-model').closest('.api-config-realtime-field').querySelector('label').textContent,
        voices: f.query('rt-voice-options').querySelectorAll('[data-rt-voice]').length };
    `);
    assert.equal(layout.overflow, false, `${width}px overflow`); assert.equal(layout.voices, 22);
    if (locale === 'en') assert.match(layout.title, /Reasoning model/);
    await screenshot(`settings-${width}-${locale}`);
    const detail = await ev(`f.query('rt-voice-options').querySelector('[data-rt-voice="willow"]').click(); return f.query('rt-voice-detail').textContent;`);
    if (locale === 'en') assert.match(detail, /Female voice[\s\S]*Irish/);
    await ev(`f.host.hidden = true; f.host.style.display = 'none'; f.call.show({ name: 'GPT-Live', avatar: '/assets/external/feather-default.png' });
      f.call.renderState({ status: 'listening', provider: 'openai', openaiBackend: 'live', elapsedMs: 14000 });
      f.call.setCaption({ captions: [{ role: 'user', text: '我们可以边走边聊吗？' }, { role: 'assistant', text: '可以呀，你说，我在听。<tableEdit> 这也是字幕。' }] });
      f.call.setUsage({ live: { seconds: 14, finalized: false }, responseCount: 1, response: { inputTokens: 21, outputTokens: 8 } });
      await new Promise(r => setTimeout(r, 250));
    `);
    const call = await ev(`const node = f.callHost.querySelector('.realtime-call-panel'); return {
      paragraphs: [...node.querySelectorAll('.realtime-call-caption p')].map(p => ({ text: p.textContent, elements: p.children.length })),
      interruptHidden: getComputedStyle(node.querySelector('[data-call-action="interrupt"]')).display === 'none',
      overflow: node.scrollWidth > node.clientWidth + 1,
      status: node.querySelector('.realtime-call-status').textContent,
    };`);
    assert.equal(call.paragraphs.length, 2); assert(call.paragraphs.every(p => p.elements === 0)); assert(call.interruptHidden && !call.overflow);
    await screenshot(`call-${width}-${locale}`);
    await ev(`f.call.hide(); f.host.hidden = false; f.host.style.display = 'block';`);
    results.push({ width, locale, ...layout, detail, call });
  }
  console.log(JSON.stringify({ passed: true, results, screenshots: output }, null, 2));
} finally {
  await command('Emulation.clearDeviceMetricsOverride');
  await ev(`if (f) { f.panel.hide(); f.panel.voicePicker?.destroy(); f.panel.languagePicker?.destroy(); f.call.destroy(); f.callHost.remove(); f.host.remove(); f.styles.forEach(style => style.remove()); await f.initializeI18n({ preference: f.locale }); f.focus?.focus?.(); delete window.__liveSmoke; }`);
  socket.close();
}
