import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createImageGenerationReferenceStore } from '../../src/scripts/ui/image-generation-reference-store.js';
import { getGeneratedImageReferenceItems } from '../../src/scripts/ui/image-generation-reference-utils.js';

const source = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const openChatImageGenerationFlow =');
const end = source.indexOf('const autoImagePromptProcessedSourceIds =', start);
assert(start > 0 && end > start);
const first = 'data:image/png;base64,YQ==', second = 'data:image/webp;base64,Yg==';
const rows = { '/a.png': first, '/b.webp': second };
const store = createImageGenerationReferenceStore({ readDataUrl: async item => rows[item.path] });
const requests = [], opens = [], errors = [];
const context = {
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
    return { prompt: options.initialPrompt, referenceImages: options.referenceImages, generationParamOverrides: options.generationParamOverrides };
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
console.log('ok - actual album reuse entry restores references in order, supports legacy assets and stops on missing files');
