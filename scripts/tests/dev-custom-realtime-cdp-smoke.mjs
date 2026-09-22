import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { evaluateInApp, findAppPageTarget, createWsClient } from '../dev/cdp-client.mjs';

// Local fixture exercising the real Tauri transport, without cloud calls.
const connections = [], sockets = new Set(), server = createServer();
const uiOnly = process.argv.includes('--ui-only');
server.on('upgrade', (request, socket, head) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  const record = { url: request.url, auth: request.headers['api-key'], route: request.headers['x-fixture'], events: [] }; connections.push(record);
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = event => {
    const bytes = Buffer.from(JSON.stringify(event)), header = Buffer.alloc(bytes.length < 126 ? 2 : 4); header[0] = 0x81;
    if (bytes.length < 126) header[1] = bytes.length; else { header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
    socket.write(Buffer.concat([header, bytes]));
  };
  let buffer = head, session, receipt;
  const receive = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, masked = buffer[1] & 128; let length = buffer[1] & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null; if (masked) offset += 4;
      const data = Buffer.from(buffer.subarray(offset, offset + length)); buffer = buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if (opcode === 8) { socket.end(); return; } if (opcode !== 1) continue;
      const event = JSON.parse(data); record.events.push(event.type);
      if (event.type === 'session.update') { session = event.session; send({ type: 'session.updated', session: { id: 'local-session' } }); }
      if (event.item?.type === 'function_call_output') receipt = JSON.parse(event.item.output).receipt;
      if (event.type === 'response.create') {
        send({ type: 'response.created', response: { id: 'response-local' } });
        const output = event.response.tool_choice?.type === 'function'
          ? [{ type: 'function_call', name: 'realtime_compatibility_probe', call_id: 'local-tool', arguments: JSON.stringify({ token: session.tools[0].parameters.properties.token.enum[0] }) }]
          : [{ type: 'message', content: [{ type: 'output_text', text: receipt }] }];
        send({ type: 'response.done', response: { id: 'response-local', status: 'completed', output } });
      }
    }
  };
  socket.on('data', receive); if (head.length) receive(Buffer.alloc(0));
  send({ type: 'session.created', session: { id: 'local-session' } });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `ws://127.0.0.1:${server.address().port}/tenant/realtime?route=fixture&model=old`;
let cdp; const pending = new Map(); let sequence = 0;
try {
  await evaluateInApp(`(async () => {
    const deadline = Date.now() + 25000;
    while (!window.__chatappBootDiag?.runtimeReady && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    if (!window.__chatappBootDiag?.runtimeReady) throw new Error('Boot not ready');
    const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
    const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
    const keys = new Map(); let saved;
    const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} },
      invoke: async (command, args) => command === 'save_kv' ? (saved = structuredClone(args.data)) : saved,
      keyring: { addKey: async (id, value) => { const key = crypto.randomUUID(); keys.set(key, value); return key; }, decryptKey: async (id, key) => keys.get(key), removeKey: async (id, key) => keys.delete(key) } });
    const original = document.querySelector('#config-panel'), marker = document.createComment('realtime-test'); original?.replaceWith(marker);
    const host = document.createElement('section'); host.id = 'config-panel'; host.className = 'api-config-panel';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;width:min(760px,100%);height:100%;margin:auto;padding:24px;box-sizing:border-box;overflow:auto;background:var(--app-surface-card);color:var(--app-text-primary)';
    host.innerHTML = '<div class="api-config-realtime-heading"><strong>Realtime</strong></div>'; document.body.append(host);
    const panel = new RealtimeSettingsPanel({ card: host, store }); await panel.ready;
    window.__customRealtimeSmoke = { host, panel, original, marker, focus: document.activeElement };
    panel.root.querySelector('#rt-new').click(); await new Promise(r => setTimeout(r, 30));
    const provider = panel.root.querySelector('#rt-provider'); provider.value = 'custom'; provider.dispatchEvent(new Event('change'));
    const set = (id, value) => { const node = panel.root.querySelector('#' + id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
    set('rt-auth-mode', 'header'); panel.root.querySelector('#rt-auth-mode').dispatchEvent(new Event('change'));
    set('rt-endpoint', ${JSON.stringify(endpoint)}); set('rt-name', 'Local compatibility check'); set('rt-model', 'vendor/voice'); set('rt-voice', 'Exact_Voice');
    set('rt-transcription-model', 'local-transcription'); set('rt-secret-apiKey', 'LOCAL_FIXTURE_KEY'); set('rt-extra-headers', JSON.stringify({ 'X-Fixture': 'local' }));
    panel.root.querySelector('#rt-save').click(); while (panel.busy) await new Promise(r => setTimeout(r, 20));
    if (!panel.draft.id) throw new Error(panel.root.querySelector('#rt-status').textContent);
    if (JSON.stringify(store.state).includes('LOCAL_FIXTURE_KEY')) throw new Error('Secret leaked into metadata');
    if (store.get(panel.draft.id).voice !== 'Exact_Voice') throw new Error('Voice case changed');
  })()`);
  for (const [id, text] of (uiOnly ? [] : [['rt-check-connection', '会话初始化成功'], ['rt-check-tools', '任务调用与结果回传通过']])) {
    const result = await evaluateInApp(`(async () => {
      const { panel } = window.__customRealtimeSmoke; panel.root.querySelector('#${id}').click();
      const deadline = Date.now() + 20000; while (panel.busy && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
      return { busy: panel.busy, status: panel.root.querySelector('#rt-status').textContent };
    })()`);
    assert(!result.busy); assert(result.status.includes(text), result.status);
  }
  const page = await findAppPageTarget();
  await new Promise((resolve, reject) => { cdp = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const item = JSON.parse(raw), waiter = pending.get(item.id); if (!waiter) return; pending.delete(item.id); item.error ? waiter.reject(new Error(item.error.message)) : waiter.resolve(item.result);
  } }); });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params })); });
  for (const width of [1100, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const layout = await evaluateInApp(`(() => { const { host, panel } = window.__customRealtimeSmoke; host.scrollTop = 0;
      const rect = host.getBoundingClientRect(); return { overflow: [...panel.root.querySelectorAll('input,select,textarea,button')].filter(e => e.getClientRects().length).some(e => e.getBoundingClientRect().right > rect.right + 2), option: panel.root.querySelector('#rt-provider option[value="custom"]').textContent }; })()`);
    assert.equal(layout.option, '自定义'); assert(!layout.overflow, 'form overflow at ' + width);
    const shot = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(`scripts/dev/tmp/custom-realtime-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
  await command('Emulation.clearDeviceMetricsOverride');
  assert.equal(connections.length, uiOnly ? 0 : 2);
  for (const item of connections) { assert.equal(item.auth, 'LOCAL_FIXTURE_KEY'); assert.equal(item.route, 'local'); assert(!item.events.includes('input_audio_buffer.append')); assert.equal(new URL(item.url, 'http://localhost').searchParams.get('model'), 'vendor/voice'); }
  console.log(JSON.stringify({ passed: true, nativeConnections: connections.length, cloudCalls: 0, microphoneOpened: false, views: [1100, 390] }));
} finally {
  if (cdp) { cdp.send(JSON.stringify({ id: ++sequence, method: 'Emulation.clearDeviceMetricsOverride', params: {} })); cdp.close(); }
  await evaluateInApp(`(() => { const state = window.__customRealtimeSmoke; if (state) { state.panel.hide(); state.panel.voicePicker?.destroy(); state.panel.languagePicker?.destroy(); state.host.remove(); if (state.original) state.marker.replaceWith(state.original); state.focus?.focus?.({ preventScroll: true }); delete window.__customRealtimeSmoke; } })()`).catch(() => {});
  for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
}
