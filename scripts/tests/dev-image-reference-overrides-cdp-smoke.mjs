// Windows 原生 dev：真实对话框 + 内存参数/参考图，不写用户资料、不发图片请求。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, evaluateInApp, findAppPageTarget } from '../dev/cdp-client.mjs';

try {
const result = await evaluateInApp(`(async () => {
  if (document.querySelector('#chat-image-gen-overlay.is-active')) throw new Error('用户正在使用生图对话框');
  const { createChatImagePromptModal } = await import('/scripts/ui/chat-image-prompt-modal.js');
  const { createImagePromptRuntime } = await import('/scripts/ui/image-prompt/image-prompt-runtime.js');
  const { createDefaultImageGenerationPreset, getParamsForImageConfig, resolveImageGenerationParamSchema } = await import('/scripts/ui/image-generation-params-utils.js');
  const { resolveImageReferenceCapability } = await import('/scripts/ui/media-generation-service.js');
  const config = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
  const preset = createDefaultImageGenerationPreset();
  const baseParams = { ...getParamsForImageConfig(preset, config), preciseReference: 'off' };
  const runtime = createImagePromptRuntime({ paramsStore: { ready: Promise.resolve(), getActive: () => preset } });
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
  const painter = canvas.getContext('2d'); painter.fillStyle = '#648c79'; painter.fillRect(0, 0, 24, 24);
  const modal = createChatImagePromptModal({ imagePromptRuntime: runtime, normalizeImageGenerationReferenceItems: items => items })();
  const pending = modal.open({
    initialPrompt: 'portrait', generationParamContext: { config, baseParams, schema: resolveImageGenerationParamSchema(config) },
    referenceCapability: resolveImageReferenceCapability(config, baseParams),
    pinnedReferences: { items: [{ key: 'memory-only', dataUrl: canvas.toDataURL(), name: '测试参考图' }], pin() {}, unpin() {} },
  });
  window.__referenceOverridesSmoke = { modal, pending };
  const overlay = [...document.querySelectorAll('#chat-image-gen-overlay')].at(-1);
  const state = () => ({ disabled: overlay.querySelector('.chat-image-gen-ref-add').disabled, hint: overlay.querySelector('.chat-image-gen-pins-hint').textContent });
  for (let i = 0; overlay.querySelector('.chat-image-gen-submit').disabled && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  if (overlay.querySelector('.chat-image-gen-submit').disabled) throw new Error('提示词编辑器未能载入');
  // 固定图占用唯一名额，先关闭「本次使用」才能通过添加按钮观察能力变化。
  const toggle = overlay.querySelector('.chat-image-gen-pins-toggle'); toggle.checked = false; toggle.dispatchEvent(new Event('change'));
  const states = { initial: state() };
  overlay.querySelector('.chat-image-gen-advanced-open').click();
  const setMode = value => {
    const control = overlay.querySelector('[data-param-key="preciseReference"]');
    const segment = control.parentElement.querySelector('[data-value="' + value + '"]');
    if (segment) segment.click(); else { control.value = value; control.dispatchEvent(new Event('change')); }
  };
  setMode('character'); states.enabled = state();
  setMode('off'); states.disabled = state();
  setMode('character');
  overlay.querySelector('.chat-image-gen-param-reset').click(); states.reset = state();
  setMode('character');
  overlay.querySelector('.chat-image-gen-param-done').click();
  toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  return states;
})()`);

  assert.equal(result.initial.disabled, true);
  assert.equal(result.enabled.disabled, false);
  assert.equal(result.disabled.disabled, true);
  assert.equal(result.reset.disabled, true);
  const dir = 'scripts/dev/tmp/review-079-fixes';
  mkdirSync(dir, { recursive: true });
  const page = await findAppPageTarget();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket?.close(); reject(new Error('screenshot timed out')); }, 10000);
    const socket = createWsClient(page.webSocketDebuggerUrl, {
      onOpen: () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })),
      onMessage: raw => {
        const message = JSON.parse(raw);
        if (message.id !== 1) return;
        clearTimeout(timer); socket.close();
        if (!message.result?.data) { reject(new Error('screenshot failed')); return; }
        writeFileSync(dir + '/nai-reference-enabled.png', Buffer.from(message.result.data, 'base64')); resolve();
      }, onError: reject,
    });
  });
  const submitted = await evaluateInApp(`(async () => {
    [...document.querySelectorAll('#chat-image-gen-overlay')].at(-1).querySelector('.chat-image-gen-submit').click();
    const value = await window.__referenceOverridesSmoke.pending;
    return { preciseReference: value.generationParamOverrides.preciseReference, usePinnedReferences: value.usePinnedReferences };
  })()`);
  assert.deepEqual(submitted, { preciseReference: 'character', usePinnedReferences: true });
  writeFileSync(dir + '/nai-reference-overrides.json', JSON.stringify({ states: result, submitted }, null, 2));
  console.log('PASS native NAI dialog: enable / disable / reset / submit with pinned references');
} finally {
  await evaluateInApp('(() => { window.__referenceOverridesSmoke?.modal.destroy(); delete window.__referenceOverridesSmoke; })()');
}
