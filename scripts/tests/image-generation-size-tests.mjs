import assert from 'node:assert/strict';
import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';
import {
  createDefaultImageGenerationPreset, getParamsForImageConfig, mergeImageGenerationRequestOptions,
  normalizeImageGenerationPreset, getImageGenerationSizeError, normalizeImageGenerationSize,
  resolveImageGenerationParamSchema, sanitizeImageGenerationParams,
} from '../../src/scripts/ui/image-generation-params-utils.js';

for (const model of ['gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2.5-flare-2026-09-08']) {
  const config = { provider: 'openai', model };
  const field = resolveImageGenerationParamSchema(config).fields.find(item => item.key === 'size');
  assert.equal(field.type, 'image-size');
  for (const size of ['2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840']) {
    assert(field.options.some(option => option.value === size));
    assert.equal(sanitizeImageGenerationParams({ size }, config).size, size);
  }
}
for (const value of ['3840 × 2160', '3840✖2160', '3840X2160', '3840*2160']) {
  assert.equal(normalizeImageGenerationSize(value), '3840x2160');
}
for (const size of ['auto', '', '1536x864', '640x1024', '2880x2880', '3840x2160', '2160x3840']) assert.equal(getImageGenerationSizeError(size), '', size);
for (const size of ['4k', '1023x1024', '0x1024', '-1024x1024', '4096x2048', '3840x3840', '512x512', '3840x1024']) {
  assert(getImageGenerationSizeError(size), size);
  assert.throws(() => sanitizeImageGenerationParams({ size }, { provider: 'openai', model: 'gpt-image-2.5-sunburst' }));
}
const preset = createDefaultImageGenerationPreset();
preset.paramsByProvider.openai.size = '3840x2160';
for (const model of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2.5-unknown', 'dall-e-2', 'dall-e-3']) {
  assert.equal(getParamsForImageConfig(preset, { provider: 'openai', model }).size, undefined);
}
assert.equal(preset.paramsByProvider.openai.size, '3840x2160');
const restored = normalizeImageGenerationPreset(JSON.parse(JSON.stringify(preset)));
assert.equal(getParamsForImageConfig(restored, { provider: 'openai', model: 'gpt-image-2.5-sunburst' }).size, '3840x2160');
assert.equal(sanitizeImageGenerationParams({ size: 'auto' }, { provider: 'openai', model: 'gpt-image-2' }).size, undefined);

for (const [model, size, edit] of [
  ['gpt-image-2.5-sunburst', '3840✖2160', false],
  ['gpt-image-2.5-flare', '1536 × 864', true],
  ['gpt-image-2', '2160x3840', false],
]) {
  const config = { provider: 'openai', model, apiKey: 'test' };
  const provider = new OpenAIProvider(config); let sent;
  provider.requestJson = async request => { sent = { url: request.url, body: JSON.parse(request.body) }; return { data: [{ b64_json: 'abc' }] }; };
  await provider.generateImage('cat', mergeImageGenerationRequestOptions({ config, preset: restored, overrides: { size }, extra: edit ? { referenceImages: ['data:image/png;base64,cmVm'] } : {} }));
  assert.equal(sent.body.size, normalizeImageGenerationSize(size));
  assert(sent.url.endsWith(edit ? '/images/edits' : '/images/generations'));
}
console.log('ok - model-specific 2K/4K and custom dimensions persist, validate limits, and reach generation/edit requests');
