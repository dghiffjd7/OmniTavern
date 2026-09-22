// Windows dev with real app data; isolated UI and temporary attachment files only.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async () => {
  const { createGeneratedImageAlbumPanel } = await import('/scripts/ui/generated-image-album-panel.js');
  const { createFeedbackOverlayUiRuntime } = await import('/scripts/ui/chat/feedback-overlay-ui-utils.js');
  const { createImageGenerationReferenceStore } = await import('/scripts/ui/image-generation-reference-store.js');
  const { getGeneratedImageReferenceItems, normalizeImageGenerationReferenceItems } = await import('/scripts/ui/image-generation-reference-utils.js');
  const { createChatImagePromptModal } = await import('/scripts/ui/chat-image-prompt-modal.js');
  const { createImagePromptRuntime } = await import('/scripts/ui/image-prompt/image-prompt-runtime.js');
  const { createDefaultImageGenerationPreset, resolveImageGenerationParamSchema, getParamsForImageConfig } = await import('/scripts/ui/image-generation-params-utils.js');
  const { safeInvoke } = await import('/scripts/utils/tauri.js');
  if (!window.__chatappBootDiag?.runtimeReady) throw Error('app not ready');
  const f = { files: [], opens: [], safeInvoke, focus: document.activeElement, sessionId: `dev_image_refs_${Date.now()}` };
  window.__imageAssetReferenceSmoke = f;
  const draw = (width, height, color, label) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif'; ctx.fillText(label, 16, 35);
    return canvas.toDataURL('image/png');
  };
  f.inputs = [draw(120, 180, '#426967', 'A'), draw(180, 110, '#79594a', 'B')];
  const referenceStore = createImageGenerationReferenceStore({
    saveDataUrl: async (dataUrl, fileName, { sessionId }) => {
      const result = await safeInvoke('save_attachment', { dataUrl, fileName, sessionId }); f.files.push(result.path); return result;
    },
    readDataUrl: async item => (await safeInvoke('read_attachment_data_url', { path: item.path, sessionId: item.sessionId }))?.dataUrl,
  });
  const refs = await referenceStore.persist(f.inputs, f.sessionId);
  if (refs.some(item => !item.path)) throw Error('native attachment persistence failed');
  f.asset = { id: 'fixture', kind: 'image', provider: 'openai', model: 'gpt-image-1', prompt: '庭院里的旅行者，午后自然光，柔和的水彩笔触。', generationParams: { referenceImages: refs }, output: { dataUrl: draw(360, 240, '#526764', 'Generated image') } };
  const config = { provider: 'openai', model: 'gpt-image-1' }, preset = createDefaultImageGenerationPreset();
  const paramsStore = { ready: Promise.resolve(), getActive: () => preset, list: () => [preset] };
  f.modal = createChatImagePromptModal({ imagePromptRuntime: createImagePromptRuntime({ paramsStore }),
    normalizeImageGenerationReferenceItems, pickFilesFromInput: async () => [], getReferencePicker: () => null, readImageGenerationReferenceFiles: async () => [],
  })();
  f.modalEl = [...document.querySelectorAll('#chat-image-gen-overlay')].at(-1);
  f.openDraft = async (capability = { supported: true, max: 16 }) => {
    const references = await referenceStore.load(getGeneratedImageReferenceItems(f.asset));
    f.result = undefined;
    f.modal.open({ initialPrompt: f.asset.prompt, referenceImages: references, referenceCapability: capability,
      generationParamContext: { config, schema: resolveImageGenerationParamSchema(config), baseParams: getParamsForImageConfig(preset, config) },
      generationParamOverrides: { output_format: 'jpeg' },
    }).then(result => { f.result = result; });
  };
  f.panel = createGeneratedImageAlbumPanel({
    resolveGeneratedImagePreviewUrl: asset => asset.output.dataUrl,
    getGeneratedImageNegativePrompt: () => '', formatGeneratedImageAlbumTime: () => '',
    escapeHtml: text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    openLightbox: url => { f.opens.push(url); f.lightbox = createFeedbackOverlayUiRuntime({ documentLike: document }).openLightbox(url); },
  });
  f.options = { title: '插图素材', collect: () => [f.asset], allowUse: true, onUse: () => f.openDraft() };
  f.panel.open(f.options);
  f.panelEl = [...document.querySelectorAll('#generated-image-album-overlay')].at(-1);
  return { files: f.files.length, cards: f.panelEl.querySelectorAll('.generated-image-reference-card').length };
};
const page = await findAppPageTarget();
let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return;
  pending.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const ev = code => evaluateInApp(`(async () => { const f = window.__imageAssetReferenceSmoke; ${code} })()`);
const click = async selector => {
  const point = await ev(`const el = f.panelEl.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
const shot = async name => { const result = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(`scripts/dev/tmp/image-assets/${name}.png`, Buffer.from(result.data, 'base64')); };
mkdirSync('scripts/dev/tmp/image-assets', { recursive: true });
try {
  await evaluateInApp(`(async()=>{for(let i=0;i<120&&!window.__chatappBootDiag?.runtimeReady;i++)await new Promise(r=>setTimeout(r,200));if(!window.__chatappBootDiag?.runtimeReady)throw Error('app boot timeout');})()`);
  assert.deepEqual(await evaluateInApp(`(${setup.toString()})()`), { files: 2, cards: 2 });
  const cards = await ev(`return [...f.panelEl.querySelectorAll('.generated-image-reference-card')].map(el => ({text:el.textContent,title:el.title,label:el.getAttribute('aria-label')}));`);
  assert(cards.every(card => !card.text && !card.title && card.label));
  await shot('asset-reference-cards');
  await click('.generated-image-reference-card');
  assert.equal(await ev('return f.opens.length;'), 1);
  assert.equal(await ev("return f.panelEl.querySelector('.generated-image-album-detail').hidden;"), true);
  await shot('reference-zoom');
  await ev("f.lightbox.remove();");
  await click('.writing-media-asset-card > img');
  assert.equal(await ev("return f.panelEl.querySelector('.generated-image-album-detail').hidden;"), false);
  assert.equal(await ev("return f.panelEl.querySelectorAll('.generated-image-album-references .generated-image-reference-card').length;"), 2);
  await shot('asset-reference-detail');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ev("f.panelEl.querySelector('.generated-image-album-references .generated-image-reference-card').focus();");
  assert.equal(await ev("return document.activeElement === f.panelEl.querySelector('.generated-image-album-references .generated-image-reference-card');"), true, 'reference card receives keyboard focus');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await ev('return f.opens.length;'), 2);
  await ev("f.lightbox.remove();");
  await click('[data-action="use-detail-asset"]');
  await ev("for(let i=0;i<60 && (!f.modalEl.classList.contains('is-active') || f.modalEl.querySelector('.chat-image-gen-submit')?.disabled);i++) await new Promise(r=>setTimeout(r,50));");
  assert.equal(await ev("return f.modalEl.querySelectorAll('.chat-image-gen-ref-item').length;"), 2);
  await ev("f.modalEl.querySelector('.chat-image-gen-advanced-open').click(); const bg=f.modalEl.querySelector('[data-param-key=background]'); bg.value='transparent'; bg.dispatchEvent(new Event('change')); ");
  assert.deepEqual(await ev("const el=f.modalEl.querySelector('[data-param-key=output_format]');return {format:el.value,disabled:el.querySelector('[value=jpeg]').disabled};"), { format: 'png', disabled: true });
  await ev("f.modalEl.querySelector('.chat-image-gen-param-done').click();");
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await shot('reuse-references-mobile');
  await ev("f.modalEl.querySelector('.chat-image-gen-submit').click();");
  assert.deepEqual(await ev("return {refsMatch:JSON.stringify(f.result.referenceImages.map(item=>item.dataUrl))===JSON.stringify(f.inputs),bg:f.result.generationParamOverrides.background,format:f.result.generationParamOverrides.output_format || 'png'};"), { refsMatch: true, bg: 'transparent', format: 'png' });
  await ev("await f.openDraft({supported:false,max:0}); for(let i=0;i<60 && f.modalEl.querySelector('.chat-image-gen-submit')?.disabled;i++) await new Promise(r=>setTimeout(r,50)); f.modalEl.querySelector('.chat-image-gen-submit').click();");
  assert.equal(await ev('return f.result === undefined;'), true);
  assert.equal(await ev("return f.modalEl.querySelectorAll('.chat-image-gen-ref-item').length;"), 2);
  console.log('ok - native attachment cards, detail and keyboard zoom, automatic reuse, transparent format controls and unsupported-model guard');
} finally {
  await ev("if(f){f.modal?.destroy();f.panel?.destroy();f.lightbox?.remove();for(const path of f.files)await f.safeInvoke('delete_attachment',{sessionId:f.sessionId,path});f.focus?.focus?.();delete window.__imageAssetReferenceSmoke;}").catch(() => {});
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await command('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  socket.close();
}
