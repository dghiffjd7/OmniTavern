import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createImageGenerationReferenceStore, collectStoredImageReferences } from '../../src/scripts/ui/image-generation-reference-store.js';
import { createMediaGenerationService } from '../../src/scripts/ui/media-generation-service.js';
import { buildGeneratedImageMessagePatch, collectGeneratedImageAssetsFromMessages } from '../../src/scripts/ui/media-generation-adapter-utils.js';
import { getGeneratedImageReferenceItems } from '../../src/scripts/ui/image-generation-reference-utils.js';
import { sanitizeImageGenerationParams } from '../../src/scripts/ui/image-generation-params-utils.js';
import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';

globalThis.crypto ||= webcrypto;
const first = 'data:image/png;base64,YQ==', second = 'data:image/webp;base64,Yg==';
const files = new Map(), libraries = new Map();
let writes = 0;
const dependencies = {
  saveDataUrl: async (dataUrl, name, { sessionId }) => {
    const path = `/${sessionId}/${++writes}-${name}`; files.set(path, dataUrl); return { path };
  },
  readDataUrl: async reference => {
    if (!files.has(reference.path)) throw Error('missing');
    return files.get(reference.path);
  },
  getLibrary: sessionId => ({
    items: libraries.get(sessionId) || [],
    remember: item => libraries.set(sessionId, [...(libraries.get(sessionId) || []).filter(ref => ref.hash !== item.hash), item]),
  }),
};
const store = createImageGenerationReferenceStore(dependencies);
const references = await store.persist([first, second, first], 'writing');
assert.equal(writes, 2);
assert.equal(references[0].path, references[2].path);
assert.equal(JSON.stringify(references).includes('base64'), false);
assert.deepEqual((await store.load(references)).map(ref => ref.dataUrl), [first, second, first]);
const concurrent = await Promise.all([store.persist([first], 'new'), store.persist([first], 'new')]);
assert.equal(writes, 3);
assert.equal(concurrent[0][0].path, concurrent[1][0].path);
assert.notEqual(concurrent[0][0].path, references[0].path, 'sessions own independent attachment lifetimes');
const restoredLibrary = JSON.parse(JSON.stringify(libraries.get('writing')));
const restarted = createImageGenerationReferenceStore({ ...dependencies, getLibrary: () => ({ items: restoredLibrary }) });
assert.equal((await restarted.persist([first], 'writing'))[0].path, references[0].path);
assert.equal(writes, 3, 'restarting with no loaded generation messages still reuses the session index');
files.delete(references[0].path);
await assert.rejects(store.load([references[0]]), /参考图 1 读取失败/);
assert.notEqual((await store.persist([first], 'writing'))[0].path, references[0].path, 'stale attachment paths are repaired');
assert.equal(writes, 4);
const fallback = createImageGenerationReferenceStore({ saveDataUrl: async () => { throw Error('disk full'); }, logger: { warn() {} } });
assert.deepEqual(await fallback.persist([first]), [first], 'persistence errors preserve the successful generation and its inputs');
const legacy = getGeneratedImageReferenceItems({ generationParams: { reference_images: [first] }, referenceImageNames: ['portrait.png'] });
assert.deepEqual((await store.load(legacy)).map(ref => ref.name), ['portrait.png']);

let sent;
const service = createMediaGenerationService({
  referenceStore: store,
  createClient: () => ({ generateImage: async (_prompt, options) => { sent = options; return [{ dataUrl: first }]; } }),
  saveDataUrl: dependencies.saveDataUrl,
});
const asset = await service.generateImage({ prompt: 'garden', config: { provider: 'openai', model: 'gpt-image-1' }, sessionId: 'writing', options: { referenceImages: [first, second] } });
assert.deepEqual(sent.referenceImages, [first, second]);
const message = { id: 'message', ...buildGeneratedImageMessagePatch(asset, { surface: 'writing', targetId: 'writing' }) };
const restoredAsset = collectGeneratedImageAssetsFromMessages(JSON.parse(JSON.stringify([message])))[0];
const restored = getGeneratedImageReferenceItems(restoredAsset);
assert.deepEqual((await store.load(restored)).map(ref => ref.dataUrl), [first, second]);
assert.equal(collectStoredImageReferences({ messages: [message] }).length, 2);
assert.equal(JSON.stringify(restoredAsset.generationParams).includes('base64'), false);
console.log('ok - references survive service, message persistence and reuse, with concurrent/session/restart deduplication');

const config = { provider: 'openai', model: 'gpt-image-1' };
const params = sanitizeImageGenerationParams({ background: 'transparent', output_format: 'jpeg', output_compression: 80 }, config);
assert.equal(params.background, 'transparent'); assert.equal(params.output_format, 'png');
assert.equal(Object.hasOwn(params, 'output_compression'), false);
assert.equal(sanitizeImageGenerationParams({ background: 'transparent', output_format: 'webp' }, config).output_format, 'webp');
const provider = new OpenAIProvider({ ...config, apiKey: 'test' });
let request;
provider.requestJson = async value => { request = value; return { data: [{ b64_json: 'YQ==' }] }; };
for (const referenceImages of [[], [first]]) {
  const result = await provider.generateImage('transparent icon', { background: 'transparent', outputFormat: 'jpeg', outputCompression: 80, referenceImages });
  const body = JSON.parse(request.body);
  assert.equal(body.background, 'transparent'); assert.equal(body.output_format, 'png');
  assert.equal(Object.hasOwn(body, 'output_compression'), false);
  assert.equal(result[0].dataUrl, first);
  assert.equal(request.url.endsWith(referenceImages.length ? '/images/edits' : '/images/generations'), true);
  assert.equal((await provider.generateImage('transparent icon', { background: 'transparent', output_format: 'webp', referenceImages }))[0].dataUrl, 'data:image/webp;base64,YQ==');
}
console.log('ok - transparent generation and edits use valid output formats and preserve WebP MIME');
