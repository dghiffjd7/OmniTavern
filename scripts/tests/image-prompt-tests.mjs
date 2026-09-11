import assert from 'node:assert/strict';
import { compileImagePrompt, createImagePromptBlock, imagePromptDocumentFromLegacy, normalizeImagePromptDocument, fillImagePromptScene, buildImagePromptRequest, restoreImagePromptFromAsset, resolveImagePromptCapabilities } from '../../src/scripts/ui/image-prompt/image-prompt-utils.js';
import { createImagePromptRuntime } from '../../src/scripts/ui/image-prompt/image-prompt-runtime.js';
import { resolveImagePromptForm, updateImagePromptFormText } from '../../src/scripts/ui/image-prompt/image-prompt-form-utils.js';
import { createDefaultImageGenerationPreset, mergeImageGenerationRequestOptions, sanitizeImageGenerationParams } from '../../src/scripts/ui/image-generation-params-utils.js';
import { createMediaGenerationService } from '../../src/scripts/ui/media-generation-service.js';
import { NovelAIImageProvider } from '../../src/scripts/api/providers/image-generation-providers.js';
import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';

const nai = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
const oai = { provider: 'openai', model: 'gpt-image-2.5-sunburst', apiKey: 'test' };
const preset = createDefaultImageGenerationPreset();
preset.paramsByProvider.novelai = { ...preset.paramsByProvider.novelai, promptPrefix: 'watercolor', promptSuffix: 'soft light', negativePrompt: 'blurry' };
const paramsStore = { ready: Promise.resolve(), list: () => [preset], getActive: () => preset };
const runtime = createImagePromptRuntime({ paramsStore });
assert.deepEqual(createImagePromptBlock('character').center, { x: 0.5, y: 0.5 });
assert.throws(() => normalizeImagePromptDocument({ version: 2 }), /版本较新/);
const collidingIds = normalizeImagePromptDocument({ blocks: [{ kind: 'character', id: 'scene' }, { kind: 'character', id: 'scene' }] });
assert.equal(new Set(collidingIds.blocks.map(b => b.id)).size, 3);
const legacyDocument = fillImagePromptScene(imagePromptDocumentFromLegacy(preset), 'garden');
assert.equal(compileImagePrompt(legacyDocument, nai).prompt, 'watercolor, garden, soft light');
assert.equal(compileImagePrompt(legacyDocument, nai).negativePrompt, 'blurry');
assert.equal(compileImagePrompt(legacyDocument, oai).prompt, 'garden');
assert.equal(compileImagePrompt(legacyDocument, oai).unused.length, 3);
assert.deepEqual(legacyDocument, normalizeImagePromptDocument(JSON.parse(JSON.stringify(legacyDocument))));

let form = resolveImagePromptForm(legacyDocument, nai);
assert.deepEqual(form.positive.map(f => f.role), ['positive-prefix', 'positive-main', 'positive-suffix']);
assert.deepEqual(form.negative.map(f => f.role), ['negative-fixed', 'negative-main']);
assert.equal(form.negative[0].text, 'blurry');
let editedText = legacyDocument;
const editText = (role, value) => {
  const fields = resolveImagePromptForm(editedText, nai);
  editedText = updateImagePromptFormText(editedText, [...fields.positive, ...fields.negative].find(f => f.role === role), value);
};
editText('positive-prefix', 'ink'); editText('positive-main', 'pond'); editText('positive-suffix', '');
editText('negative-fixed', ''); editText('negative-main', 'letters');
let textRequest = await runtime.prepare({ prompt: 'ignored', config: nai, options: { imagePromptDocument: editedText } });
assert.equal(textRequest.prompt, 'ink, pond');
assert.equal(textRequest.options.negativePrompt, 'letters');
assert.equal(preset.paramsByProvider.novelai.promptPrefix, 'watercolor');
assert.equal(preset.paramsByProvider.novelai.negativePrompt, 'blurry');
const textRestore = restoreImagePromptFromAsset({ generationParams: { imagePromptDocument: editedText } });
assert.equal(resolveImagePromptForm(textRestore, nai).negative[0].text, '', 'a cleared fixed slot remains empty on re-edit');
assert.equal(resolveImagePromptForm(textRestore, nai).positive.find(f => f.role === 'positive-suffix').text, '');
form = resolveImagePromptForm(textRestore, oai);
assert.equal(form.showNegative, true, 'preserve entered negative text when switching to a model that omits it');
assert.equal(compileImagePrompt(textRestore, oai).negativePrompt, '');
assert.equal(resolveImagePromptForm({}, oai).showNegative, false, 'an unsupported empty negative area is hidden');

const oldParts = normalizeImagePromptDocument({ blocks: [
  { id: 'p1', kind: 'style', text: 'ink' }, { id: 'p2', kind: 'style', text: 'warm' },
  { id: 's1', kind: 'scene', text: 'garden' }, { id: 's2', kind: 'scene', text: 'bench' },
  { id: 'role', kind: 'character', text: 'traveler' },
  { id: 'suffix', kind: 'style', placement: 'after', text: 'soft light' },
  { id: 'n1', kind: 'negative', text: 'watermark' }, { id: 'n2', kind: 'negative', text: 'blurry' },
  { id: 'off', kind: 'style', text: 'disabled original', enabled: false },
  { id: 'other', kind: 'style', text: 'other provider', provider: 'stability' },
] });
const oldSnapshot = JSON.stringify(oldParts), oldRequest = compileImagePrompt(oldParts, oai);
form = resolveImagePromptForm(oldParts, oai);
assert.equal(JSON.stringify(oldParts), oldSnapshot, 'opening the simpler form preserves all old source blocks');
assert.deepEqual(compileImagePrompt(oldParts, oai), oldRequest);
assert.equal(form.negative[0].text, 'watermark, blurry');
const changedOldParts = updateImagePromptFormText(oldParts, form.positive.find(f => f.role === 'positive-main'), 'lake');
assert.equal(compileImagePrompt(changedOldParts, oai).prompt, 'ink\n\nwarm\n\nlake\n\nCharacter: traveler\n\nsoft light');
assert.equal(changedOldParts.blocks.find(b => b.id === 'off').text, 'disabled original');
assert.equal(changedOldParts.blocks.find(b => b.id === 'other').text, 'other provider');
assert.equal(JSON.stringify(oldParts), oldSnapshot, 'editing a restored form owns a copy of the image snapshot');

const genericPreset = createDefaultImageGenerationPreset();
genericPreset.paramsByProvider.openai = sanitizeImageGenerationParams({ promptPrefix: 'watercolor', promptSuffix: 'soft light' }, oai);
const genericRuntime = createImagePromptRuntime({ paramsStore: { ready: Promise.resolve(), getActive: () => genericPreset } });
const genericRequest = await genericRuntime.prepare({ prompt: 'garden', config: oai });
assert.equal(genericRequest.prompt, 'watercolor\n\ngarden\n\nsoft light');
assert.equal(genericRequest.options.promptPrefix, undefined);
assert.equal(resolveImagePromptForm(genericRequest.options.imagePromptDocument, oai).positive[0].text, 'watercolor');

let prepared = await runtime.prepare({ prompt: 'garden', config: nai, options: mergeImageGenerationRequestOptions({ config: nai, preset, extra: { negativePrompt: 'letters' } }) });
assert.equal(prepared.prompt, 'watercolor, garden, soft light');
assert.equal(prepared.options.negativePrompt, 'blurry, letters');
assert.equal(prepared.options.promptPrefix, undefined);
form = resolveImagePromptForm(prepared.options.imagePromptDocument, nai);
assert.deepEqual(form.negative.map(f => f.text), ['blurry', 'letters'], 'fixed and extra negative text remain separately editable');
prepared = await runtime.prepare({ prompt: 'garden', config: nai, options: mergeImageGenerationRequestOptions({ config: nai, preset, extra: { negativePrompt: 'blurry, letters' } }) });
assert.equal(prepared.options.negativePrompt, 'blurry, letters', 'an already merged negative is not duplicated');
prepared = await runtime.prepare({ prompt: 'garden', config: nai, options: mergeImageGenerationRequestOptions({ config: nai, preset, extra: { negativePrompt: '' }, negativePromptMode: 'replace' }) });
assert.equal(prepared.options.negativePrompt, undefined);
form = resolveImagePromptForm(prepared.options.imagePromptDocument, nai);
assert.equal(form.negative[0].text, '', 'explicit clearing overrides fixed negative text only for this run');
const punctuationPreset = createDefaultImageGenerationPreset();
punctuationPreset.paramsByProvider.novelai.negativePrompt = 'blurry,';
const punctuationRuntime = createImagePromptRuntime({ paramsStore: { ready: Promise.resolve(), getActive: () => punctuationPreset } });
assert.equal((await punctuationRuntime.prepare({ prompt: 'garden', config: nai, options: { imagePromptNegativeOverride: { mode: 'append', value: 'letters' } } })).options.negativePrompt, 'blurry, letters');

const blocks = normalizeImagePromptDocument({ positionMode: 'custom', blocks: [
  { id: 'scene', kind: 'scene', text: '2girls, garden' },
  { id: 'a', kind: 'character', name: 'Alice', text: 'girl, red coat', negative: 'blue coat', center: { x: 0.15, y: 0.7 } },
  { id: 'b', kind: 'character', name: 'Beth', text: 'girl, blue coat', center: { x: 0.9, y: 0.7 } },
  { id: 'off', kind: 'character', name: 'Off', text: 'bird', enabled: false },
  { id: 'negative', kind: 'negative', text: 'watermark' },
] });
const compiled = compileImagePrompt(blocks, nai);
assert.equal(compiled.characters.length, 2);
assert.equal(compiled.characters[0].center.x, 0.1);
assert.equal(compiled.unused[0].id, 'off');
const payload = new NovelAIImageProvider(nai).buildPayload('ignored', buildImagePromptRequest(blocks, nai).options);
assert.equal(payload.input, '2girls, garden');
assert.equal(payload.parameters.v4_prompt.caption.char_captions[0].char_caption, 'girl, red coat');
assert.equal(payload.parameters.v4_negative_prompt.caption.char_captions[0].char_caption, 'blue coat');
assert.deepEqual(payload.parameters.v4_prompt.caption.char_captions[1].centers, [{ x: 0.9, y: 0.7 }]);
assert.equal(payload.parameters.v4_prompt.use_coords, true);
assert.equal(payload.parameters.characterPrompts[0].uc, 'blue coat');
const many = { blocks: [{ kind: 'scene', text: 'people' }, ...Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, kind: 'character', text: 'person' }))] };
assert(compileImagePrompt(many, nai).errors[0].includes('6'));
assert.equal(compileImagePrompt(many, { ...nai, model: 'nai-diffusion-5-full' }).errors.length, 0);
assert.equal(compileImagePrompt(many, { ...nai, model: 'nai-diffusion-3' }).characters.length, 0);
assert.equal(resolveImagePromptCapabilities({ provider: 'vertexai', model: 'imagen-4.0-generate-001' }).negative, false);
assert.equal(resolveImagePromptCapabilities({ provider: 'vertexai', model: 'imagen-3.0-fast-generate-001' }).negative, true);
assert.equal(resolveImagePromptCapabilities({ provider: 'togetherai', model: 'FLUX.2' }).negative, false);
assert.equal(resolveImagePromptCapabilities({ provider: 'comfyui' }, { workflowJson: '{"text":"%negative_prompt%"}' }).negative, true);
assert.equal(resolveImagePromptCapabilities({ provider: 'comfyui' }, { workflowJson: '{"text":"%prompt%"}' }).negative, false);
assert(compileImagePrompt({ blocks: [{ kind: 'scene', text: 'scene | role' }, { kind: 'character', text: 'role' }] }, nai).errors.length);
assert.equal(compileImagePrompt(blocks, oai).negativePrompt, '');
assert(compileImagePrompt(blocks, oai).prompt.includes('Alice: girl, red coat'));
assert(!compileImagePrompt(blocks, oai).prompt.includes('watermark'));

const options = mergeImageGenerationRequestOptions({ config: nai, preset });
prepared = await runtime.prepare({ prompt: 'ignored', config: nai, options: { ...options, imagePromptDocument: blocks } });
assert.equal(prepared.options.negativePrompt, 'watermark', 'the image draft owns text over old parameter defaults');
assert(!prepared.prompt.includes('watercolor'));
const editedDraft = await runtime.getDraft({ prompt: 'first image', config: nai });
editedDraft.blocks[0].text = 'edited first image';
editedDraft.blocks.push(createImagePromptBlock('character', { text: 'unique character' }));
const nextDraft = await runtime.getDraft({ prompt: 'second image', config: nai });
assert.equal(nextDraft.blocks[0].text, 'second image', 'each generation starts from its own input');
assert.equal(nextDraft.blocks.filter(b => b.kind === 'character').length, 0, 'another image does not inherit edited blocks');
assert.equal(preset.paramsByProvider.novelai.promptPrefix, 'watercolor', 'editing the current draft leaves legacy parameter text intact');

let request, calls = 0;
const service = createMediaGenerationService({
  preparePromptRequest: value => runtime.prepare(value),
  createClient: config => {
    const provider = new OpenAIProvider(config);
    provider.requestJson = async value => { calls++; request = JSON.parse(value.body); return { data: [{ b64_json: 'aW1hZ2U=' }] }; };
    return provider;
  },
  saveDataUrl: async () => ({ path: 'test-image.png' }),
});
const snapshot = buildImagePromptRequest(blocks, oai, { quality: 'max', size: '3840x2160' });
const asset = await service.generateImage({ prompt: snapshot.prompt, config: oai, options: snapshot.options, agentTask: false });
assert.equal(calls, 1); assert.equal(request.prompt, snapshot.compiled.prompt);
assert.equal(request.quality, 'max'); assert.equal(request.size, '3840x2160');
assert(!Object.keys(request).some(key => key.startsWith('imagePrompt')));
assert.deepEqual(asset.generationParams.imagePromptDocument, blocks);
assert.equal(asset.prompt, snapshot.compiled.prompt);
preset.paramsByProvider.novelai.promptPrefix = 'unrelated new defaults';
const restored = restoreImagePromptFromAsset(asset);
prepared = await runtime.prepare({ prompt: asset.prompt, config: oai, options: { imagePromptDocument: restored } });
assert.equal(prepared.prompt, asset.prompt, 're-edit uses the image snapshot, not newer defaults');
assert.equal(compileImagePrompt(restored, nai).characters[0].negative, 'blue coat', 'switching models retains the source character negative');
assert.equal(compileImagePrompt(restoreImagePromptFromAsset({ provider: 'novelai', prompt: 'old picture', generationParams: { promptPrefix: 'ink' } }), nai).prompt, 'ink, old picture');
const aborted = new AbortController(); aborted.abort();
await assert.rejects(service.generateImage({ prompt: 'ignored', config: oai, options: snapshot.options, signal: aborted.signal }), { name: 'AbortError' });
assert.equal(calls, 1);
console.log('passed: per-image drafts, legacy defaults, negative ownership, native characters/positions, model limits, actual OpenAI request, snapshot regeneration and cancellation');
