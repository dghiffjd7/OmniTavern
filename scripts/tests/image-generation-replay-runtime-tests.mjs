import assert from 'node:assert/strict';
import { createImageGenerationReplayRuntime, snapshotImageGenerationReplay } from '../../src/scripts/ui/chat/image-generation-replay-runtime.js';
import { createImagePromptRuntime } from '../../src/scripts/ui/image-prompt/image-prompt-runtime.js';
import { createDefaultImageGenerationPreset } from '../../src/scripts/ui/image-generation-params-utils.js';

const reference = 'data:image/png;base64,YQ==';
const generated = { kind: 'image', status: 'running', prompt: 'old scene', provider: 'openai', model: 'gpt-image-1',
  generationParams: { size: '1024x1024', referenceImages: [reference] } };
let message = { id: 'source', role: 'assistant', meta: { generatedMedia: generated } }, context = 'archive-a';
const requests = [], errors = [];
let resolveRead;
const readGate = new Promise(resolve => { resolveRead = resolve; });
const replay = createImageGenerationReplayRuntime({ getMessage: () => message, getContextKey: () => context,
  loadReferences: async refs => { await readGate; return refs; },
  runImageGeneration: async request => { requests.push(request); return true; }, notifyError: error => errors.push(error),
});
const waiting = replay({ sessionId: 'writing', messageId: 'source' });
generated.prompt = 'source changed'; generated.generationParams.size = '1536x1024'; generated.generationParams.referenceImages[0] = 'different';
resolveRead();
assert.equal(await waiting, true);
assert.equal(requests[0].prompt, 'old scene');
assert.equal(requests[0].replaySnapshot.generationParams.size, '1024x1024');
assert.equal(requests[0].referenceImages[0].dataUrl, reference);
assert.equal(requests[0].sourceMessageIdOverride, 'source');
assert.equal(Object.hasOwn(requests[0], 'replaceMessageId'), false);
assert.equal(Object.hasOwn(requests[0].replaySnapshot.generationParams, 'referenceImages'), false);

let release;
const delayed = createImageGenerationReplayRuntime({ getMessage: () => message, getContextKey: () => context,
  loadReferences: () => new Promise(resolve => { release = resolve; }),
  runImageGeneration: async () => { throw Error('must not run after archive change'); }, notifyError: error => errors.push(error),
});
const moving = delayed({ sessionId: 'writing', messageId: 'source' });
context = 'archive-b'; release([]);
assert.equal(await moving, false);
assert.match(errors.at(-1), /目标聊天或存档已变化/);

const missing = createImageGenerationReplayRuntime({ getMessage: () => message, getContextKey: () => context,
  loadReferences: async () => { throw Error('reference missing'); },
  runImageGeneration: async () => { throw Error('must not run without references'); }, notifyError: error => errors.push(error),
});
assert.equal(await missing({ sessionId: 'writing', messageId: 'source' }), false);
assert.equal(errors.at(-1), 'reference missing');

message = { id: 'inline', role: 'assistant', meta: { generatedInlineImages: [
  { id: 'one', prompt: 'first scene', output: { path: '/first.png' } },
  { id: 'two', prompt: 'second scene', output: { path: '/second.png' } },
] } };
assert.equal(await replay({ sessionId: 'writing', messageId: 'inline', inlineGeneratedImage: { ref: '/second.png' } }), true);
assert.equal(requests.at(-1).prompt, 'second scene');
assert.equal(message.meta.generatedInlineImages.length, 2);

const preset = createDefaultImageGenerationPreset();
preset.paramsByProvider.novelai.promptPrefix = 'changed prefix';
preset.paramsByProvider.novelai.negativePrompt = 'changed negative';
const runtime = createImagePromptRuntime({ paramsStore: { ready: Promise.resolve(), getActive: () => preset, list: () => [preset] } });
const legacy = snapshotImageGenerationReplay({ prompt: 'legacy scene', provider: 'novelai', negativePrompt: 'old negative', generationParams: { seed: 42, promptPrefix: 'old prefix' } });
const request = await runtime.prepare({ prompt: legacy.prompt, config: { provider: 'novelai', model: 'nai-diffusion-4-5-full' }, options: legacy.generationParams });
assert.equal(request.prompt, 'old prefix, legacy scene');
assert.equal(request.options.negativePrompt, 'old negative');
assert.equal(request.options.seed, 42);
console.log('ok - repeat snapshots isolate changing source jobs, selected inline images, legacy prompts, missing references and archive changes');
