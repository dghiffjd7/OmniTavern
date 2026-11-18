import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createImageGenerationReferenceStore } from '../../src/scripts/ui/image-generation-reference-store.js';
import { getGeneratedImageReferenceItems } from '../../src/scripts/ui/image-generation-reference-utils.js';
import { mergeChatReferenceImages } from '../../src/scripts/ui/chat/chat-image-reference-pins.js';
import { resolveImageReferenceCapability } from '../../src/scripts/ui/media-generation-service.js';

const source = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const openChatImageGenerationFlow =');
const end = source.indexOf('const autoImagePromptProcessedSourceIds =', start);
assert(start > 0 && end > start);
const first = 'data:image/png;base64,YQ==', second = 'data:image/webp;base64,Yg==';
const rows = { '/a.png': first, '/b.webp': second };
const store = createImageGenerationReferenceStore({ readDataUrl: async item => rows[item.path] });
const requests = [], opens = [], errors = [];
// 本聊天参考图
const pinned = [{ key: '/pin.png', dataUrl: 'data:image/png;base64,cGlu', name: '三视图' }];
let usePinned = false;
const context = {
  chatImageReferencePins: { load: async () => ({ items: pinned, missing: [] }), pin: async () => ({ ok: true }), unpin: () => true },
  loadChatPinnedReferences: async (_sid, capability) => pinned.slice(0, capability.max),
  mergeChatReferenceImages,
  getGeneratedImageReferenceItems, imageGenerationReferenceStore: store,
  chatStore: { getCurrent: () => 'writing' },
  window: { toastr: { error: message => errors.push(message) } },
  resolveMediaSurfaceForSession: () => 'writing', getMediaSurfaceCopy: () => ({}),
  isWritingMediaSurface: () => true, resolveChatImageInitialPrompt: () => '',
  loadImageReferenceCapability: async () => ({ supported: true, max: 16 }),
  loadImageGenerationParamContext: async () => ({}),
  openWritingAssetPanel() {}, openGeneratedImageAlbumPanel() {},
  getChatImagePromptModal: () => ({ open: async options => {
    opens.push(options);
    return { prompt: options.initialPrompt, referenceImages: options.referenceImages, generationParamOverrides: options.generationParamOverrides, usePinnedReferences: usePinned };
  } }),
  runChatImageGeneration: async options => { requests.push(options); return true; },
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}; globalThis.open = openChatImageGenerationFlow;`, context);
const asset = { scope: { targetId: 'writing' }, generationParams: { referenceImages: [
  { path: '/a.png', sessionId: 'writing', name: 'first' }, { path: '/b.webp', sessionId: 'writing', name: 'second' },
] } };
assert.equal(await context.open({ surface: 'writing', initialPrompt: 'garden', referenceAsset: asset, useComposerFallback: false }), true);
assert.deepEqual(Array.from(opens[0].referenceImages, item => item.dataUrl), [first, second]);
assert.deepEqual(Array.from(requests[0].referenceImages, item => item.dataUrl), [first, second]);
delete rows['/a.png'];
assert.equal(await context.open({ initialPrompt: 'garden', referenceAsset: asset }), false);
assert.equal(requests.length, 1, 'a missing reference never silently becomes a text-only generation');
assert.match(errors[0], /参考图 1 读取失败/);
assert.equal(await context.open({ initialPrompt: 'legacy asset' }), true);
assert.equal(requests[1].referenceImages.length, 0);
assert.deepEqual(opens[0].pinnedReferences.items, pinned, 'the dialog receives the chat reference images');
usePinned = true;
assert.equal(await context.open({ initialPrompt: 'with pins', referenceAsset: { ...asset, generationParams: { referenceImages: [{ path: '/b.webp', sessionId: 'writing', name: 'second' }] } } }), true);
assert.deepEqual(Array.from(requests.at(-1).referenceImages, item => item.dataUrl), ['data:image/png;base64,cGlu', second], 'chat reference images come first');
console.log('ok - actual album reuse entry restores references in order, supports legacy assets and stops on missing files');

// NAI 的本次开关覆盖预设：合并固定图必须使用与最终请求相同的参数。
const naiConfig = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
let presetMode = 'off', overrideMode = 'character';
context.loadImageReferenceCapability = async (overrides = {}) => resolveImageReferenceCapability(naiConfig, { preciseReference: presetMode, ...overrides });
context.getChatImagePromptModal = () => ({ open: async () => ({
  prompt: 'portrait', referenceImages: [], usePinnedReferences: true, generationParamOverrides: { preciseReference: overrideMode },
}) });
await context.open({ initialPrompt: 'portrait' });
assert.equal(requests.at(-1).referenceImages.length, 1, '本次开启精准参考时应带上固定图');
presetMode = 'character'; overrideMode = 'off';
await context.open({ initialPrompt: 'portrait' });
assert.equal(requests.at(-1).referenceImages.length, 0, '本次关闭精准参考时应忽略固定图');
console.log('ok - NAI pinned references follow per-request overrides in both directions');
