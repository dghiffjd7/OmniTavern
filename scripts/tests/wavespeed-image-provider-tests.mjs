import assert from 'node:assert/strict';

const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: key => memoryStorage.get(String(key)) ?? null,
  setItem: (key, value) => { memoryStorage.set(String(key), String(value)); },
  removeItem: key => { memoryStorage.delete(String(key)); },
};

const { WaveSpeedImageProvider } = await import('../../src/scripts/api/providers/image-generation-providers.js');
const { LLMClient } = await import('../../src/scripts/api/client.js');
const {
  createDefaultImageGenerationPreset,
  mergeImageGenerationRequestOptions,
  resolveImageGenerationParamSchema,
} = await import('../../src/scripts/ui/image-generation-params-utils.js');
const { resolveImageReferenceCapability } = await import('../../src/scripts/ui/media-generation-service.js');

// WaveSpeed 生图不是 OpenAI 格式：每个模型自己的路径、异步任务要轮询，参数也按模型不同（来自 /models 的 api_schema）
const BASE = 'https://api.wavespeed.ai/api/v3';
const schemaOf = (modelId, properties, required = ['prompt']) => ({
  api_schemas: [{
    type: 'model_run', method: 'POST', server: 'https://api.wavespeed.ai', api_path: `/api/v3/${modelId}`,
    request_schema: { type: 'object', additionalProperties: false, required, properties },
  }],
});
const MODELS = {
  code: 200,
  message: 'success',
  data: [
    { model_id: 'google/video-x', type: 'text-to-video', api_schema: schemaOf('google/video-x', { prompt: { type: 'string' } }) },
    {
      model_id: 'bytedance/seedream-v5.5', type: 'text-to-image',
      api_schema: schemaOf('bytedance/seedream-v5.5', {
        prompt: { type: 'string' },
        aspect_ratio: { type: 'string', default: '1:1', enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] },
        resolution: { type: 'string', default: '1k', enum: ['1k', '1.5k', '2k', '3k'] },
        output_format: { type: 'string', default: 'png', enum: ['jpeg', 'png'] },
      }),
    },
    {
      model_id: 'wavespeed-ai/flux-dev', type: 'text-to-image',
      api_schema: schemaOf('wavespeed-ai/flux-dev', {
        prompt: { type: 'string' },
        size: { type: 'string', default: '1024*1024' },
        num_inference_steps: { type: 'integer', minimum: 1, maximum: 50 },
        seed: { type: 'integer' },
        num_images: { type: 'integer', minimum: 1, maximum: 4 },
        image: { type: 'string' },
      }),
    },
    {
      model_id: 'bytedance/seedream-v5.5/edit', type: 'image-to-image',
      api_schema: schemaOf('bytedance/seedream-v5.5/edit', {
        prompt: { type: 'string' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        aspect_ratio: { type: 'string', enum: ['1:1', '9:16', '16:9'] },
        resolution: { type: 'string', default: '1k', enum: ['1k', '2k'] },
      }, ['prompt', 'images']),
    },
    {
      model_id: 'wavespeed-ai/flux-kontext-dev', type: 'image-to-image',
      api_schema: schemaOf('wavespeed-ai/flux-kontext-dev', { prompt: { type: 'string' }, image: { type: 'string' }, size: { type: 'string' } }),
    },
  ],
};

const submitsOf = calls => calls.filter(call => call.method === 'POST' && !call.url.endsWith('/media/uploads'));
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const makeProvider = ({ model, polls, download = () => ({ ok: true, status: 200, headers: { 'content-type': 'image/png' }, body: 'QUFB' }) }) => {
  const provider = new WaveSpeedImageProvider({ provider: 'wavespeed', apiKey: 'secret-key', baseUrl: BASE, model, pollIntervalMs: 0 });
  const calls = [];
  const queue = [...(polls || [])];
  provider.request = async (request) => {
    calls.push(request);
    const { url, method = 'GET' } = request;
    if (url === `${BASE}/models`) return json(MODELS);
    if (url === `${BASE}/media/uploads`) {
      const n = calls.filter(call => call.url === `${BASE}/media/uploads`).length;
      return json({ code: 200, message: 'success', data: {
        type: 'image', download_url: `https://files.example/ref-${n}.png`,
        upload: { method: 'PUT', url: `https://upload.example/ref-${n}`, headers: { 'Content-Type': 'image/png' } },
      } });
    }
    if (url.startsWith('https://upload.example/')) return { ok: true, status: 200, headers: {}, body: '' };
    if (method === 'POST') return json({ code: 200, message: 'success', data: { id: 'task-1', status: 'created', outputs: [] } });
    if (url === `${BASE}/predictions/task-1/result`) {
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return json({ code: 200, message: 'success', data: next });
    }
    return download(request);
  };
  return { provider, calls };
};

{
  const { provider, calls } = makeProvider({ model: 'bytedance/seedream-v5.5' });
  assert.deepEqual(await provider.listModels(), ['bytedance/seedream-v5.5', 'wavespeed-ai/flux-dev', 'bytedance/seedream-v5.5/edit', 'wavespeed-ai/flux-kontext-dev']);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-key');
  console.log('ok - model list keeps text-to-image and image-to-image models');
}

{
  const { provider, calls } = makeProvider({
    model: 'bytedance/seedream-v5.5',
    polls: [{ id: 'task-1', status: 'processing', outputs: [] }, { id: 'task-1', status: 'completed', outputs: ['https://cdn.example/x.png'] }],
  });
  const images = await provider.generateImage('a cat', { width: 1024, height: 1792, n: 2, seed: '42', negativePrompt: 'blurry' });
  const submits = calls.filter(call => call.method === 'POST');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].url, `${BASE}/bytedance/seedream-v5.5`);
  assert.deepEqual(JSON.parse(submits[0].body), { prompt: 'a cat', aspect_ratio: '9:16', resolution: '2k' }, '只发这个模型认得的参数');
  const download = calls.find(call => call.url === 'https://cdn.example/x.png');
  assert.equal(download.responseBase64, true);
  assert.equal(download.headers?.Authorization, undefined, '下载图片不带 API key');
  assert.deepEqual(images, [{ dataUrl: 'data:image/png;base64,QUFB', index: 0 }]);
  console.log('ok - seedream maps width and height to aspect ratio and resolution, polls once submitted, downloads the image');
}

{
  const { provider, calls } = makeProvider({
    model: 'wavespeed-ai/flux-dev',
    polls: [{ id: 'task-1', status: 'completed', outputs: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] }],
  });
  const images = await provider.generateImage('a dog', { width: 1024, height: 768, n: 2, seed: '7', steps: 20, negativePrompt: 'blurry' });
  const body = JSON.parse(calls.find(call => call.method === 'POST').body);
  assert.deepEqual(body, { prompt: 'a dog', size: '1024*768', num_images: 2, seed: 7, num_inference_steps: 20 });
  assert.equal(images.length, 2);
  console.log('ok - flux maps width and height to size and passes only supported parameters');
}

{
  const { provider, calls } = makeProvider({
    model: 'wavespeed-ai/flux-dev',
    polls: [() => json({ code: 502, message: 'bad gateway' }, 502), () => { throw new Error('network down'); }, { id: 'task-1', status: 'completed', outputs: ['https://cdn.example/a.png'] }],
  });
  const images = await provider.generateImage('a dog', {});
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, '查结果出错时继续查同一个任务，不重新提交（重复提交会重复扣费）');
  assert.equal(images.length, 1);
  console.log('ok - transient polling errors keep polling the same task without resubmitting');
}

{
  const { provider } = makeProvider({
    model: 'bytedance/seedream-v5.5',
    polls: [{ id: 'task-1', status: 'failed', error: 'content flagged by safety checker', outputs: [] }],
  });
  await assert.rejects(provider.generateImage('x', {}), error => /content flagged by safety checker/.test(error.message) && /task-1/.test(error.message));
  console.log('ok - a failed task reports the provider error and task id');
}

{
  const controller = new AbortController();
  const { provider, calls } = makeProvider({
    model: 'bytedance/seedream-v5.5',
    polls: [() => { controller.abort(); return json({ code: 200, data: { id: 'task-1', status: 'processing', outputs: [] } }); }, { id: 'task-1', status: 'completed', outputs: ['https://cdn.example/x.png'] }],
  });
  await assert.rejects(provider.generateImage('x', { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls.filter(call => call.url.endsWith('/result')).length, 1, '取消后不再查结果');
  console.log('ok - aborting stops polling');
}

{
  const { provider } = makeProvider({
    model: 'bytedance/seedream-v5.5',
    polls: [{ id: 'task-1', status: 'completed', outputs: ['https://cdn.example/x.png'] }],
    download: () => ({ ok: false, status: 403, headers: {}, body: '' }),
  });
  assert.deepEqual(await provider.generateImage('x', {}), [{ url: 'https://cdn.example/x.png', index: 0 }], '下载失败时交回网址，由 APP 再试');
  console.log('ok - a failed download falls back to the image URL');
}

{
  const { provider, calls } = makeProvider({ model: 'someone/unknown-model', polls: [{ id: 'task-1', status: 'completed', outputs: ['https://cdn.example/x.png'] }] });
  await provider.generateImage('x', { width: 512, height: 512, seed: '3' });
  assert.deepEqual(JSON.parse(calls.find(call => call.method === 'POST').body), { prompt: 'x' }, '查不到参数表时只发提示词');
  console.log('ok - an unlisted model receives only the prompt');
}

{
  const config = { provider: 'wavespeed', apiKey: 'k', baseUrl: BASE, model: 'wavespeed-ai/flux-dev' };
  assert.ok(new LLMClient(config).provider instanceof WaveSpeedImageProvider);
  const fields = resolveImageGenerationParamSchema(config).fields.map(field => field.key);
  for (const key of ['negativePrompt', 'n', 'width', 'height', 'seed']) assert.ok(fields.includes(key), key);
  const options = mergeImageGenerationRequestOptions({ config, preset: createDefaultImageGenerationPreset() });
  assert.equal(options.width, 1024);
  assert.equal(options.height, 1024);
  console.log('ok - wavespeed is registered with its own parameter panel');
}

const PNG_A = 'data:image/png;base64,QUFBQQ==';
const PNG_B = 'data:image/png;base64,QkJCQkJC';

{
  const { provider, calls } = makeProvider({
    model: 'bytedance/seedream-v5.5/edit',
    polls: [{ id: 'task-1', status: 'completed', outputs: ['https://cdn.example/x.png'] }],
  });
  await provider.generateImage('换成红色外套', { width: 1024, height: 1024, referenceImages: [PNG_A, { dataUrl: PNG_B, name: 'b.png' }] });
  const tickets = calls.filter(call => call.url === `${BASE}/media/uploads`);
  assert.equal(tickets.length, 2);
  assert.deepEqual(JSON.parse(tickets[0].body), { filename: 'reference-1.png', size: 4, content_type: 'image/png' });
  assert.equal(tickets[0].headers.Authorization, 'Bearer secret-key');
  const puts = calls.filter(call => call.url.startsWith('https://upload.example/'));
  assert.deepEqual(puts.map(call => [call.method, call.bodyBase64, call.headers.Authorization, call.headers['Content-Type']]), [
    ['PUT', 'QUFBQQ==', undefined, 'image/png'],
    ['PUT', 'QkJCQkJC', undefined, 'image/png'],
  ], '图片字节传到上传凭证给的地址，不带 API key');
  assert.deepEqual(JSON.parse(submitsOf(calls)[0].body), {
    prompt: '换成红色外套',
    images: ['https://files.example/ref-1.png', 'https://files.example/ref-2.png'],
    resolution: '1k',
  }, '带参考图时不发比例，跟着参考图走');
  console.log('ok - an edit model uploads local reference images and sends their URLs');
}

{
  const { provider, calls } = makeProvider({
    model: 'wavespeed-ai/flux-kontext-dev',
    polls: [{ id: 'task-1', status: 'completed', outputs: ['https://cdn.example/x.png'] }],
  });
  await provider.generateImage('x', { width: 1024, height: 1024, referenceImages: ['https://files.example/already-online.png'] });
  assert.equal(calls.filter(call => call.url === `${BASE}/media/uploads`).length, 0, '已经是网址的参考图不用再上传');
  assert.deepEqual(JSON.parse(submitsOf(calls)[0].body), { prompt: 'x', image: 'https://files.example/already-online.png' });
  console.log('ok - a single-image model receives one image URL');
}

for (const [label, model, referenceImages, pattern] of [
  ['too many references', 'bytedance/seedream-v5.5/edit', [PNG_A, PNG_B, PNG_A], /最多.*2.*3/],
  ['text-to-image model with references', 'bytedance/seedream-v5.5', [PNG_A], /不能用参考图/],
  ['edit model without references', 'bytedance/seedream-v5.5/edit', [], /需要.*参考图/],
]) {
  const { provider, calls } = makeProvider({ model });
  await assert.rejects(provider.generateImage('x', { referenceImages }), error => pattern.test(error.message), label);
  assert.equal(calls.filter(call => call.url !== `${BASE}/models`).length, 0, `${label}: 不上传也不提交`);
  console.log(`ok - ${label} is rejected before any upload or paid request`);
}

{
  const base = { provider: 'wavespeed', apiKey: 'k', baseUrl: BASE };
  const edit = resolveImageReferenceCapability({ ...base, model: 'bytedance/seedream-v5.5/edit' });
  assert.equal(edit.supported, true);
  assert.equal(edit.max, 2);
  const single = resolveImageReferenceCapability({ ...base, model: 'wavespeed-ai/flux-kontext-dev' });
  assert.equal(single.max, 1);
  const textOnly = resolveImageReferenceCapability({ ...base, model: 'bytedance/seedream-v5.5' });
  assert.equal(textOnly.supported, false);
  assert.match(textOnly.reason, /编辑模型/);
  const unknown = resolveImageReferenceCapability({ ...base, model: 'someone/not-listed' });
  assert.equal(unknown.supported, true, '没拉过模型列表时先允许，生成前再按参数表检查');
  const restarted = await import('../../src/scripts/api/providers/wavespeed-model-catalog.js?restart');
  assert.deepEqual(
    restarted.getWaveSpeedReferenceInput({ baseUrl: BASE, model: 'bytedance/seedream-v5.5/edit' }),
    { known: true, field: 'images', max: 2, required: true },
    'APP 重启后仍记得每个模型能带几张参考图',
  );
  console.log('ok - reference capability follows the selected model and survives a restart');
}
