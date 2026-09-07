import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

// Real renderer file drops in the running Windows WebView; isolated profiles, no cloud requests.
const directory = mkdtempSync(join(tmpdir(), 'realtime-upload-'));
const samples = 24000, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
const first = join(directory, 'reference.wav'), second = join(directory, 'another.wav');
writeFileSync(first, wav); writeFileSync(second, wav);
const page = await findAppPageTarget(), pending = new Map(); let socket, sequence = 0, chooser;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw); if (message.method === 'Page.fileChooserOpened') chooser = message.params;
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const setup = async () => {
  const { RealtimeSettingsPanel } = await import('/scripts/ui/realtime/realtime-settings-panel.js');
  const { RealtimeProfileStore } = await import('/scripts/storage/realtime-profile-store.js');
  const { makeRealtimeProfile } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
  const fixture = document.createElement('section'); fixture.id = 'config-panel'; fixture.className = 'api-config-panel';
  fixture.style.cssText = 'position:fixed;inset:12px 12px 12px auto;width:min(720px,calc(100vw - 24px));height:calc(100vh - 24px);box-sizing:border-box;padding:16px;background:var(--app-surface-card);z-index:90000;display:block;pointer-events:auto;transform:none;visibility:visible;opacity:1;border:1px solid var(--app-border-default);border-radius:16px';
  fixture.innerHTML = '<div class="api-config-scroll" style="height:100%;overflow:auto"><div class="api-config-realtime-card"><div class="api-config-realtime-heading"></div></div></div>';
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/assets/css/api-config.css'; document.head.append(style);
  await new Promise(resolve => { style.onload = resolve; }); document.body.append(fixture);
  const keys = new Map();
  const store = new RealtimeProfileStore({ storage: { getItem: () => null, setItem: () => {} }, invoke: async () => null,
    keyring: { addKey: async (id, value) => { keys.set(id, value); return id; }, decryptKey: async id => keys.get(id), removeKey: async id => keys.delete(id) } });
  await store.save(makeRealtimeProfile('step_realtime'), { apiKey: 'SMOKE_KEY' });
  const panel = new RealtimeSettingsPanel({ card: fixture.querySelector('.api-config-realtime-card'), store }); await panel.ready;
  const urls = new Set(); panel.enrollmentView.urlApi = { createObjectURL: file => { const url = URL.createObjectURL(file); urls.add(url); return url; }, revokeObjectURL: url => { urls.delete(url); URL.revokeObjectURL(url); } };
  let trusted = false;
  fixture.addEventListener('drop', event => { trusted = event.isTrusted; }, true);
  const query = id => fixture.querySelector(`#${id}`);
  const change = (id, value) => { const input = query(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
  fixture.querySelector('.rt-enrollment').open = true;
  const snapshot = () => ({ file: panel.enrollmentView.file?.name || '', inputFile: query('rt-clone-file').files[0]?.name || '', preview: query('rt-clone-preview').currentSrc, duration: query('rt-clone-preview').duration, message: query('rt-file-status').textContent, trusted, activeUrls: urls.size, dragging: query('rt-clone-upload').classList.contains('is-dragover') });
  const cleanup = () => { panel.hide(); panel.voicePicker?.destroy(); fixture.remove(); style.remove(); delete window.__realtimeUploadSmoke; };
  window.__realtimeUploadSmoke = { panel, fixture, query, change, snapshot, urls, cleanup };
};
const inspect = () => evaluateInApp('window.__realtimeUploadSmoke.snapshot()');
const drop = async files => {
  const point = await evaluateInApp(`(() => { const node = window.__realtimeUploadSmoke.query('rt-clone-upload'); node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 30 }; })()`);
  const data = { items: [], files, dragOperationsMask: 1 };
  await command('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
  await command('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
  const dragging = (await inspect()).dragging;
  await command('Input.dispatchDragEvent', { type: 'drop', ...point, data });
  return dragging;
};
const results = [];
const titlePoint = selector => evaluateInApp(`(() => { const title = window.__realtimeUploadSmoke.fixture.querySelector(${JSON.stringify(selector)}); title.scrollIntoView({block:'center'}); const r=title.getBoundingClientRect(); return {x:r.left+Math.min(20,r.width/2),y:r.top+r.height/2}; })()`);
const tipState = () => evaluateInApp(`(() => { const tip=document.querySelector('.app-help-tip'), r=tip.getBoundingClientRect(); return {visible:tip.classList.contains('is-visible'),text:tip.textContent,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,focused:document.activeElement?.id}; })()`);
const tap = async point => { await command('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]}); await command('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]}); };
try {
  await evaluateInApp(`(${setup.toString()})()`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.enable'); await command('Page.setInterceptFileChooserDialog', { enabled: true });
  const focus = await evaluateInApp("(() => { window.__realtimeUploadSmoke.query('rt-clone-choose').focus(); return { id: document.activeElement?.id, hasFocus: document.hasFocus() }; })()");
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const chooserDeadline = Date.now() + 3000;
  while (!chooser && Date.now() < chooserDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(chooser?.backendNodeId, `Keyboard selection did not open a file chooser: ${JSON.stringify(focus)}`);
  await command('DOM.setFileInputFiles', { files: [second], backendNodeId: chooser.backendNodeId });
  assert.equal((await inspect()).file, 'another.wav');
  await command('Page.setInterceptFileChooserDialog', { enabled: false });
  assert(await drop([first]), 'File drag did not highlight the target');
  await evaluateInApp(`(async () => { const audio = window.__realtimeUploadSmoke.query('rt-clone-preview'); if (!audio.readyState) await new Promise((resolve, reject) => { audio.addEventListener('loadedmetadata', resolve, { once: true }); setTimeout(() => reject(new Error('Preview metadata missing')), 3000); }); })()`);
  const selected = await inspect();
  assert.equal(selected.file, 'reference.wav'); assert.equal(selected.inputFile, selected.file);
  assert(selected.trusted && selected.preview.startsWith('blob:') && selected.duration === 1 && selected.activeUrls === 1);
  assert(await drop([first, second]));
  const multiple = await inspect();
  assert.equal(multiple.file, selected.file); assert.equal(multiple.preview, selected.preview); assert(multiple.message.includes('1'));
  await evaluateInApp(`(() => { const f = window.__realtimeUploadSmoke; f.query('rt-voice-label').value = '我的参考声音'; f.query('rt-clone-text').value = '保留参考文字'; f.change('rt-voice-kind', 'custom'); return f.query('rt-voice-label').value === '我的参考声音' && f.query('rt-clone-text').value === '保留参考文字'; })()`).then(assert);
  assert.equal((await inspect()).file, selected.file); assert.equal((await inspect()).activeUrls, 1);
  await evaluateInApp('window.__realtimeUploadSmoke.panel.busy = true');
  assert.equal(await drop([second]), false); assert.equal((await inspect()).file, selected.file);
  await evaluateInApp('window.__realtimeUploadSmoke.panel.busy = false');
  assert(await drop([second])); assert.equal((await inspect()).file, 'another.wav'); assert.equal((await inspect()).activeUrls, 1);
  for (const width of [1100, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const layout = await evaluateInApp(`(async () => { const f = window.__realtimeUploadSmoke, enrollment = f.fixture.querySelector('.rt-enrollment'); enrollment.scrollIntoView({block:'start'}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); const r = f.fixture.getBoundingClientRect(), nodes = [f.fixture, enrollment, f.query('rt-clone-upload')]; return { overflow: nodes.filter(n => n.scrollWidth > n.clientWidth + 2).map(n => ({id:n.id,tag:n.tagName,client:n.clientWidth,scroll:n.scrollWidth})), clip: {x:r.x,y:r.y,width:r.width,height:r.height,scale:1} }; })()`);
    const screenshot = await command('Page.captureScreenshot', { format: 'png', clip: layout.clip });
    const path = `../realtime-checks/realtime-clone-upload-${width}.png`; writeFileSync(path, Buffer.from(screenshot.data, 'base64')); results.push({ width, overflow: layout.overflow, screenshot: path });
    assert(!layout.overflow.length, `Upload area overflow at ${width}px: ${JSON.stringify(layout.overflow)}`);
    const point = await titlePoint('#rt-clone-file-hint');
    if (width === 1100) {
      await command('Input.dispatchMouseEvent', {type:'mouseMoved',...point});
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      await command('Emulation.setTouchEmulationEnabled', {enabled:true,maxTouchPoints:1});
      await tap(point);
    }
    const tip = await tipState(); assert(tip.visible && tip.inside && tip.text.includes('WAV') && tip.text.includes('10 MB'), 'Audio help is not visible inside the viewport');
    await new Promise(resolve => setTimeout(resolve, 160)); // Wait for the tooltip fade before capture.
    const helpShot = await command('Page.captureScreenshot', {format:'png',clip:layout.clip});
    writeFileSync(`../realtime-checks/realtime-clone-help-${width}.png`,Buffer.from(helpShot.data,'base64'));
    if (width === 390) {
      await tap(point); assert.equal((await tipState()).visible,false,'Second tap should close help');
      const modelPoint = await titlePoint('label[for="rt-model"] .has-help');
      await evaluateInApp('document.activeElement?.blur()'); await tap(modelPoint);
      const modelTip = await tipState(); assert(modelTip.visible && modelTip.focused !== 'rt-model', 'Help tap focused the associated model input');
      await tap({x:2,y:2}); assert.equal((await tipState()).visible,false,'Outside tap should close help');
      assert.equal((await inspect()).file,'another.wav');
      await command('Emulation.setTouchEmulationEnabled', {enabled:false});
    } else {
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});
    }
  }
  await evaluateInApp(`(() => { const f = window.__realtimeUploadSmoke; f.query('rt-clone-file-remove').click(); return !f.panel.enrollmentView.file && f.urls.size === 0 && f.query('rt-clone-selected').hidden && !f.query('rt-clone-file').files.length; })()`).then(assert);
  await drop([first]);
  await evaluateInApp(`(() => { const f = window.__realtimeUploadSmoke; f.change('rt-region', 'global'); return !f.panel.enrollmentView.file && f.urls.size === 0 && !f.query('rt-clone-text').value && !f.query('rt-voice-label').value; })()`).then(assert);
  await drop([first]);
  await evaluateInApp(`(() => { const f = window.__realtimeUploadSmoke, audio = f.query('rt-clone-preview'); f.panel.hide(); return f.urls.size === 0 && audio.paused && !audio.hasAttribute('src'); })()`).then(assert);
  console.log(JSON.stringify({ passed: true, desktopHoverHelp: true, mobileTapHelpWithoutInputActivation: true, keyboardFileChooser: true, trustedFileDrop: true, playableLocalPreview: true, multipleFilesPreserveSelection: true, draftAndBusyPreserved: true, removeAndContextCleanup: true, externalRequests: 0, userSettingsWrites: 0, results }, null, 2));
} finally {
  await command('Page.setInterceptFileChooserDialog', { enabled: false });
  await command('Emulation.setTouchEmulationEnabled', {enabled:false});
  await command('Emulation.clearDeviceMetricsOverride');
  await evaluateInApp('window.__realtimeUploadSmoke?.cleanup()'); socket.close();
}
