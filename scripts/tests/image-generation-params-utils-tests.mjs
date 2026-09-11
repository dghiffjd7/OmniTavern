import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { initializeI18n } from '../../src/scripts/i18n/index.js';
import {
  ImageGenerationParamsPanel,
  resolveImageGenerationOptionLabel,
} from '../../src/scripts/ui/image-generation-params-panel.js';
import {
  combineImageNegativePrompts,
  createDefaultImageGenerationPreset,
  getParamsForImageConfig,
  mergeImageGenerationRequestOptions,
  normalizeImageGenerationPreset,
  resolveImageGenerationParamSchema,
  resolveImageNegativePromptDraft,
  sanitizeImageGenerationParams,
} from '../../src/scripts/ui/image-generation-params-utils.js';

const findNegativeField = (config) => resolveImageGenerationParamSchema(config)
  .fields
  .find(field => field.key === 'negativePrompt');

for (const config of [
  { provider: 'novelai', model: 'nai-diffusion-4-5-full' },
  { provider: 'stability', model: 'stable-image-ultra' },
  { provider: 'togetherai', model: 'black-forest-labs/FLUX.1-schnell-Free' },
  { provider: 'pollinations', model: 'flux' },
  { provider: 'automatic1111', model: 'local' },
  { provider: 'comfyui', model: 'local' },
  { provider: 'vertexai', model: 'imagen-4.0-generate-001' },
]) {
  const field = findNegativeField(config);
  assert.ok(field, `${config.provider} should expose a fixed negative prompt field`);
  assert.equal(field.type, 'textarea');
  assert.equal(field.variant, 'persistent-negative');
  assert.equal(field.fullWidth, true);
  assert.match(field.help, /弹窗中的编辑只覆盖本次生成/);
}

assert.equal(findNegativeField({ provider: 'vertexai', model: 'gemini-2.5-flash-image' }), undefined);
assert.equal(findNegativeField({ provider: 'openai', model: 'gpt-image-2' }), undefined);

{
  const preset = createDefaultImageGenerationPreset();
  for (const model of [
    'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08',
    'gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08',
  ]) {
    const config = { provider: 'openai', model };
    const field = resolveImageGenerationParamSchema(config).fields.find(item => item.key === 'quality');
    assert.deepEqual(field.options.map(option => option.value), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const quality of ['low', 'medium', 'high', 'xhigh', 'max']) {
      preset.paramsByProvider.openai = sanitizeImageGenerationParams({ quality }, config);
      const restored = normalizeImageGenerationPreset(JSON.parse(JSON.stringify(preset)));
      assert.equal(getParamsForImageConfig(restored, config).quality, quality, `${model} retains ${quality} after saving`);
    }
  }
  for (const model of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-unknown', 'dall-e-3', 'dall-e-2']) {
    assert.equal(getParamsForImageConfig(preset, { provider: 'openai', model }).quality, undefined, `${model} must not receive max from another model`);
  }
  assert.equal(preset.paramsByProvider.openai.quality, 'max', 'changing models does not rewrite the saved preset');
  assert.equal(getParamsForImageConfig(preset, { provider: 'openai', model: 'gpt-image-2.5-sunburst' }).quality, 'max');
  assert.equal(sanitizeImageGenerationParams({ quality: 'auto' }, { provider: 'openai', model: 'gpt-image-2.5-sunburst' }).quality, undefined);
  assert.equal(sanitizeImageGenerationParams({ quality: 'relay-quality' }, { provider: 'custom', model: 'relay-model' }).quality, 'relay-quality');
}

{
  const config = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
  const sanitized = sanitizeImageGenerationParams({
    width: 1024,
    negativePrompt: ' low quality, blurry ',
  }, config);
  assert.equal(sanitized.negativePrompt, 'low quality, blurry');
}

assert.equal(combineImageNegativePrompts('low quality', 'bad hands'), 'low quality, bad hands');
assert.equal(combineImageNegativePrompts('low quality', ''), 'low quality');
assert.equal(combineImageNegativePrompts('', 'bad hands'), 'bad hands');
assert.equal(
  combineImageNegativePrompts('low quality', 'low quality, bad hands'),
  'low quality, bad hands',
  'regenerating with an effective prompt must not duplicate the fixed prefix',
);

assert.equal(
  resolveImageNegativePromptDraft('', { negativePrompt: ' low quality, blurry ' }),
  'low quality, blurry',
  'a new generation dialog should show the fixed preset prompt',
);
assert.equal(
  resolveImageNegativePromptDraft(' custom one-shot prompt ', { negativePrompt: 'fixed prompt' }),
  'custom one-shot prompt',
  'an explicit one-shot prompt should take priority over the fixed preset',
);

{
  const config = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
  const preset = createDefaultImageGenerationPreset();
  preset.paramsByProvider.novelai.negativePrompt = 'low quality, blurry';
  const options = mergeImageGenerationRequestOptions({
    config,
    preset,
    extra: { negativePrompt: 'bad hands' },
  });
  assert.equal(options.negativePrompt, 'low quality, blurry, bad hands');
}

{
  const config = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
  const preset = createDefaultImageGenerationPreset();
  preset.paramsByProvider.novelai.negativePrompt = 'low quality, blurry';
  const replaced = mergeImageGenerationRequestOptions({
    config,
    preset,
    extra: { negativePrompt: 'bad hands' },
    negativePromptMode: 'replace',
  });
  const cleared = mergeImageGenerationRequestOptions({
    config,
    preset,
    extra: { negativePrompt: '' },
    negativePromptMode: 'replace',
  });
  assert.equal(replaced.negativePrompt, 'bad hands');
  assert.equal(Object.hasOwn(cleared, 'negativePrompt'), false);
  assert.equal(preset.paramsByProvider.novelai.negativePrompt, 'low quality, blurry');
}


{
  const englishBase = JSON.parse(await readFile(new URL('../i18n/en.base.json', import.meta.url), 'utf8'));
  await initializeI18n({
    preference: 'en',
    documentLike: null,
    fetchFn: async () => ({ ok: true, json: async () => englishBase }),
  });
  const configs = [
    { provider: 'openai', model: 'gpt-image-1' },
    { provider: 'openai', model: 'gpt-image-2.5-sunburst' },
    { provider: 'openai', model: 'dall-e-3' },
    { provider: 'novelai', model: 'nai-diffusion-4-5-full' },
    { provider: 'stability', model: 'stable-image-ultra' },
    { provider: 'togetherai', model: 'black-forest-labs/FLUX.1-schnell-Free' },
    { provider: 'pollinations', model: 'flux' },
    { provider: 'automatic1111', model: 'local' },
    { provider: 'custom', model: 'custom' },
  ];
  const optionLabels = configs.flatMap(config => resolveImageGenerationParamSchema(config).fields)
    .flatMap(field => field.options || [])
    .map(resolveImageGenerationOptionLabel);
  assert.equal(optionLabels.some(label => /\p{Script=Han}/u.test(label)), false);

  const booleanField = resolveImageGenerationParamSchema({
    provider: 'novelai',
    model: 'nai-diffusion-4-5-full',
  }).fields.find(field => field.key === 'qualityToggle');
  const panel = new ImageGenerationParamsPanel({ store: {} });
  const html = panel.renderField(booleanField, 'true');
  assert.match(html, />Off<\/option>/);
  assert.match(html, />On<\/option>/);
  assert.doesNotMatch(html, />Close<\/option>|>开启<\/option>/);
}

console.log('ok - image parameters retain model-specific quality and fixed negative prompts without mutating presets');
