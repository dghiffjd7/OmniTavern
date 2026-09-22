// Run in the ordinary Windows dev with existing data. All messages and requests
// below are isolated in memory; no model call or user-chat write is performed.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

async function setup() {
  const { renderMessageBubbleContentCore } = await import('/scripts/ui/chat/message-bubble-content-ui-utils.js');
  const { buildMessageElementCore } = await import('/scripts/ui/chat/message-element-ui-utils.js');
  const { createStandardMessageWrapperCore, createMessageAvatarImageCore } = await import('/scripts/ui/chat/message-wrapper-ui-utils.js');
  const { buildBubbleStackCore, appendStandardMessageLayoutCore } = await import('/scripts/ui/chat/message-layout-ui-utils.js');
  const { showContextMenuCore } = await import('/scripts/ui/chat/context-menu-orchestration-ui-utils.js');
  const { resolveContextMenuContext } = await import('/scripts/ui/chat/context-menu-runtime-utils.js');
  const { buildContextMenuActions, positionContextMenu } = await import('/scripts/ui/chat/context-menu-ui-utils.js');
  const { createContextMenuActionButton, createContextMenuDivider } = await import('/scripts/ui/chat/context-menu-dom-utils.js');
  const { dispatchContextMenuAction } = await import('/scripts/ui/chat/context-menu-action-runtime-utils.js');
  const { createImageGenerationReplayRuntime } = await import('/scripts/ui/chat/image-generation-replay-runtime.js');
  const { createImageGenerationReferenceStore } = await import('/scripts/ui/image-generation-reference-store.js');
  const { translateUiText } = await import('/scripts/i18n/index.js');
  const host = document.createElement('div');
  host.id = 'image-replay-smoke';
  host.style.cssText = 'position:fixed;inset:0;z-index:50000;padding:24px 12px;overflow:auto;background:var(--app-surface-page);color:var(--app-text-primary);';
  const inner = document.createElement('div');
  inner.style.cssText = 'max-width:720px;margin:auto;display:flex;flex-direction:column;gap:24px;';
  host.append(inner);
  const menu = document.createElement('div');
  menu.className = 'chat-message-context-menu';
  menu.style.cssText = 'position:fixed;display:none;z-index:50001;';
  document.body.append(host, menu);
  const draw = (width, height, color) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#e8ca84'; ctx.beginPath(); ctx.arc(width * .7, height * .25, height * .12, 0, Math.PI * 2); ctx.fill();
    return canvas.toDataURL('image/png');
  };
  const refs = [draw(100, 120, '#4f7471'), draw(120, 100, '#596481')];
  const running = { id: 'replay-running', role: 'assistant', type: 'text', name: '创作插图', time: '20:00',
    content: '正在生成插图：月光下的庭院，柔和的水彩笔触。',
    meta: { showName: true, generatedMedia: { kind: 'image', status: 'running', surface: 'writing',
      provider: 'openai', model: 'gpt-image-1', prompt: '月光下的庭院，柔和的水彩笔触。',
      referenceImageCount: 2, generationParams: { size: '1024x1024', background: 'transparent', output_format: 'webp', referenceImages: refs } } } };
  const succeeded = structuredClone(running);
  succeeded.id = 'replay-succeeded'; succeeded.type = 'image'; succeeded.content = draw(270, 170, '#63796c');
  succeeded.meta.generatedMedia.status = 'succeeded';
  succeeded.meta.generatedMedia.output = { dataUrl: succeeded.content };
  const f = { host, menu, refs, messages: [running, succeeded], requests: [], errors: [], focus: document.activeElement };
  window.__imageReplaySmoke = f;
  f.before = JSON.stringify(f.messages);
  const referenceStore = createImageGenerationReferenceStore();
  const repeat = createImageGenerationReplayRuntime({
    getMessage: id => f.messages.find(message => message.id === id), getContextKey: () => 'fixture',
    loadReferences: (items, sessionId) => referenceStore.load(items, sessionId),
    runImageGeneration: async options => { f.requests.push({ ...options, menuHidden: menu.style.display === 'none' }); return true; },
    notifyError: error => f.errors.push(error),
  });
  for (const message of f.messages) {
    const wrapper = buildMessageElementCore({
      message, documentLike: document, resolveMessageSessionId: () => 'replay-smoke',
      createStandardMessageWrapper: createStandardMessageWrapperCore,
      createMessageAvatarImage: args => createMessageAvatarImageCore({ ...args, defaultAvatar: refs[0] }),
      createBubble: doc => { const el = doc.createElement('div'); el.className = 'QQ_chat_msgdiv'; return el; },
      renderMessageBubbleContent: args => renderMessageBubbleContentCore({ ...args, documentLike: document, translateText: translateUiText }),
      buildBubbleStack: buildBubbleStackCore, appendStandardMessageLayout: appendStandardMessageLayoutCore, getUiMode: () => 'chat',
    });
    wrapper.addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopPropagation();
      showContextMenuCore({
        event, message, contextMenu: menu, scrollEl: inner, documentLike: document, windowLike: window,
        resolveContextMenuContext, buildContextMenuActions, createContextMenuActionButton, createContextMenuDivider,
        dispatchContextMenuAction, positionContextMenu, getPoint: ev => ({ x: ev.clientX, y: ev.clientY }),
        actionHandler: async (action, source, payload) => {
          if (action !== 'repeat-image-generation') throw Error('unexpected fixture action');
          return repeat({ sessionId: 'replay-smoke', messageId: source.id, inlineGeneratedImage: payload.inlineGeneratedImage });
        },
      });
    });
    inner.append(wrapper);
  }
  return { refs: host.querySelectorAll('.generated-image-reference-card').length };
}

const page = await findAppPageTarget();
let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return;
  pending.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
} }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const ev = code => evaluateInApp(`(async () => { const f = window.__imageReplaySmoke; ${code} })()`);
const click = async (expression, button = 'left') => {
  const point = await ev(`const el=${expression};el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
};
const shot = async name => { const result = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(`scripts/dev/tmp/image-replay/${name}.png`, Buffer.from(result.data, 'base64')); };
mkdirSync('scripts/dev/tmp/image-replay', { recursive: true });
try {
  await evaluateInApp(`(async()=>{for(let i=0;i<120&&!window.__chatappBootDiag?.runtimeReady;i++)await new Promise(r=>setTimeout(r,200));if(!window.__chatappBootDiag?.runtimeReady)throw Error('app boot timeout');})()`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await evaluateInApp(`(${setup.toString()})()`), { refs: 4 });
  await click('f.host.querySelector("[data-msg-id=replay-running] .QQ_chat_msgdiv")', 'right');
  assert.equal(await ev('return f.menu.querySelector("[data-action-key=repeat-image-generation] .chat-context-menu-action-label").textContent;'), '再生成一张');
  assert.equal(await ev('return !!f.menu.querySelector("[data-action-key=cancel-media-generation]");'), true);
  await shot('running-menu');
  await click('f.menu.querySelector("[data-action-key=repeat-image-generation]")');
  await ev('for(let i=0;i<60&&f.requests.length<1;i++)await new Promise(r=>setTimeout(r,50));');
  assert.equal(await ev('return f.requests.length;'), 1);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await click('f.host.querySelector("[data-msg-id=replay-succeeded] .QQ_chat_msgdiv")', 'right');
  assert.equal(await ev('return !!f.menu.querySelector("[data-action-key=generate-image]");'), true);
  assert.equal(await ev('const r=f.menu.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;'), true);
  await shot('completed-menu-mobile');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ev('f.menu.querySelector("[data-action-key=repeat-image-generation]").focus();');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await ev('for(let i=0;i<60&&f.requests.length<2;i++)await new Promise(r=>setTimeout(r,50));');
  assert.deepEqual(await ev(`return {count:f.requests.length,errors:f.errors,unchanged:JSON.stringify(f.messages)===f.before,valid:f.requests.every(r=>r.menuHidden && !r.replaceMessageId && r.prompt===f.messages[0].meta.generatedMedia.prompt && r.replaySnapshot.generationParams.background==='transparent' && JSON.stringify(r.referenceImages.map(x=>x.dataUrl))===JSON.stringify(f.refs))};`), { count: 2, errors: [], unchanged: true, valid: true });
  console.log('ok - running and completed image menus, mouse/keyboard direct reuse, original messages preserved, all reference inputs and parameters retained, 390px menu layout');
} finally {
  await ev('if(f){f.menu?.remove();f.host?.remove();f.focus?.focus?.();delete window.__imageReplaySmoke;}').catch(() => {});
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await command('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  socket.close();
}
