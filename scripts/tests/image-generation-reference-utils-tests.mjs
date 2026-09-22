import assert from 'node:assert/strict';
import {
  normalizeImageGenerationReferenceItems,
  createImageGenerationReferenceReader,
  getGeneratedImageReferenceItems,
} from '../../src/scripts/ui/image-generation-reference-utils.js';

const inputs = [' first ', { url: 'second', name: ' photo.png ', type: 'image/png', size: '7' }, null, 'third'];
assert.deepEqual(normalizeImageGenerationReferenceItems(inputs, { supported: true, max: 2 }), [
  { dataUrl: 'first', name: '', mime: '', size: 0 },
  { dataUrl: 'second', name: 'photo.png', mime: 'image/png', size: 7 },
]);
assert.deepEqual(normalizeImageGenerationReferenceItems(inputs, { supported: false, max: 4 }), []);
assert.deepEqual(normalizeImageGenerationReferenceItems(inputs, { supported: true, max: 0 }), []);
assert.equal(inputs[0], ' first ');

const reads = [], compressions = [];
const reader = createImageGenerationReferenceReader({
  readFileAsDataUrl: async file => { reads.push(file.name); return `data:${file.name}`; },
  isGifFile: file => file.type === 'image/gif',
  compressImageDataUrl: async (url, options) => {
    compressions.push([url, options]);
    if (url === 'data:fallback.png') throw new Error('compression unavailable');
    return `${url}:compressed`;
  },
});
const files = [
  { name: 'skip.txt', type: 'text/plain' },
  { name: 'still.png', type: 'image/png', size: 12 },
  { name: 'motion.gif', type: 'image/gif', size: 24 },
  { name: 'fallback.png', type: 'image/png', size: 36 },
  { name: 'over-limit.png', type: 'image/png' },
];
assert.deepEqual((await reader(files, 3)).map(item => [item.name, item.dataUrl, item.size]), [
  ['still.png', 'data:still.png:compressed', 12],
  ['motion.gif', 'data:motion.gif', 24],
  ['fallback.png', 'data:fallback.png', 36],
]);
assert.deepEqual(reads, ['still.png', 'motion.gif', 'fallback.png']);
assert.deepEqual(compressions.map(item => item[0]), ['data:still.png', 'data:fallback.png']);
assert.deepEqual(compressions[0][1], { maxDim: 1280, quality: 0.9, maxBytes: 2_000_000 });
assert.deepEqual(await reader(files, 0), []);

const stored = { generationParams: { reference_images: ['first', { url: 'second', name: 'embedded.png' }] },
  referenceImageNames: ['character.png', 'ignored.png'], referenceImageCount: 2 };
const before = structuredClone(stored);
assert.deepEqual(getGeneratedImageReferenceItems(stored).map(item => [item.dataUrl, item.name]), [
  ['first', 'character.png'], ['second', 'embedded.png'],
]);
assert.deepEqual(stored, before);
assert.deepEqual(getGeneratedImageReferenceItems({ referenceImageCount: 1 }), []);
console.log('image-generation-reference-utils-tests passed: input order and limits, GIF preservation, compression fallback, saved reference compatibility');
