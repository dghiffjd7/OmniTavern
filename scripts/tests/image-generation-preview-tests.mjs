import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { parseImageSseBuffer, streamImageSse, base64ImageToDataUrl } = await import('../../src/scripts/api/providers/image-stream-transport.js');
const { NovelAIImageProvider } = await import('../../src/scripts/api/providers/image-generation-providers.js');
const {
  createImageGenerationPreviews, createImagePreviewPlaceholder, buildImagePreviewPlaceholderHtml, IMAGE_PREVIEW_JOB_TOKEN,
} = await import('../../src/scripts/ui/chat/image-generation-preview.js');

// Rust 原生流式请求的假实现：start 记下参数，read 依次交出预先排好的批次
const createFakeStreamInvoker = (batches = []) => {
  const calls = [];
  const queue = batches.slice();
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'http_stream_request_start') return true;
    if (cmd === 'http_stream_request_read') return queue.shift() || { chunks: [], done: true, status: 200, ok: true };
    if (cmd === 'http_stream_request_close') return true;
    throw new Error(`unexpected ${cmd}`);
  };
  return { invoke, calls };
};
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

{
  // SSE：保留 event 名称；data 不是 JSON 时原样给出；不完整的一段留到下次
  const parsed = parseImageSseBuffer('event: intermediate\ndata: {"step_ix":0}\n\n: ping\n\ndata: plain\n\ndata: [DONE]\n\nevent: final\ndata: {"im');
  assert.deepEqual(parsed.events, [{ event: 'intermediate', data: { step_ix: 0 } }, { event: '', data: 'plain' }]);
  assert.equal(parsed.rest, 'event: final\ndata: {"im');
  assert.deepEqual(parseImageSseBuffer('data: {"a":1}\r\ndata: 2', { final: true }).events, [{ event: '', data: '{"a":1}\n2' }]);
  assert.equal(base64ImageToDataUrl('/9j/abc'), 'data:image/jpeg;base64,/9j/abc');
  assert.equal(base64ImageToDataUrl('iVBORw0'), 'data:image/png;base64,iVBORw0');
  console.log('ok - image SSE parsing keeps event names and buffers partial frames');
}

{
  // 原生流式：跨批次拆开的事件也能接起来；回应不是 2xx 时抛错并带 status
  const frame = sse('intermediate', { step_ix: 3 });
  const { invoke, calls } = createFakeStreamInvoker([
    { chunks: [frame.slice(0, 10)], status: 200, ok: true },
    { chunks: [frame.slice(10)], status: 200, ok: true, done: true },
  ]);
  const events = [];
  for await (const event of streamImageSse({ url: 'https://x/stream', body: '{}', invoker: invoke })) events.push(event);
  assert.deepEqual(events, [{ event: 'intermediate', data: { step_ix: 3 } }]);
  assert.deepEqual(calls.map(call => call.cmd), ['http_stream_request_start', 'http_stream_request_read', 'http_stream_request_read', 'http_stream_request_close']);

  const failing = createFakeStreamInvoker([{ chunks: ['{"message":"bad"}'], status: 402, ok: false, done: true }]);
  await assert.rejects(async () => { for await (const _ of streamImageSse({ url: 'https://x', invoker: failing.invoke, label: 'NovelAI' })); }, error => error.status === 402 && /NovelAI API Error: 402/.test(error.message));
  console.log('ok - native image streams join split frames and report HTTP errors');
}

{
  // NovelAI：有人要看过程才走流式接口；中间图按步数回报（step_ix 从 0 起），final 是成图
  const intermediate = step => sse('intermediate', { event_type: 'intermediate', samp_ix: 0, step_ix: step, gen_id: 1, sigma: 1, image: `/9j/step${step}` });
  const { invoke, calls } = createFakeStreamInvoker([
    { chunks: [intermediate(0), intermediate(1)], status: 200, ok: true },
    { chunks: [sse('final', { event_type: 'final', samp_ix: 0, gen_id: 1, image: 'iVBORfinal' })], status: 200, ok: true, done: true },
  ]);
  globalThis.__TAURI_INTERNALS__ = { invoke };
  try {
    const provider = new NovelAIImageProvider({ apiKey: 'k', model: 'nai-diffusion-4-5-full' });
    const previews = [];
    const result = await provider.generateImage('1girl', { steps: 28, onPreview: preview => previews.push(preview) });
    assert.deepEqual(result, [{ dataUrl: 'data:image/png;base64,iVBORfinal', index: 0 }]);
    assert.deepEqual(previews.map(p => [p.step, p.total, p.dataUrl]), [[1, 28, 'data:image/jpeg;base64,/9j/step0'], [2, 28, 'data:image/jpeg;base64,/9j/step1']]);
    const start = calls.find(call => call.cmd === 'http_stream_request_start').args;
    assert.equal(start.url, 'https://image.novelai.net/ai/generate-image-stream');
    assert.equal(JSON.parse(start.body).parameters.stream, 'sse');
    assert.equal(start.headers.Authorization, 'Bearer k');

    // error 事件照常抛出；回调出错不影响生成
    const broken = createFakeStreamInvoker([{ chunks: [sse('error', { event_type: 'error', message: 'quota' })], status: 200, ok: true, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: broken.invoke };
    await assert.rejects(() => provider.generateImage('x', { onPreview() {} }), /NovelAI API Error: quota/);
    const noisy = createFakeStreamInvoker([{ chunks: [intermediate(0), sse('final', { event_type: 'final', image: 'iVBORok' })], status: 200, ok: true, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: noisy.invoke };
    assert.equal((await provider.generateImage('x', { onPreview() { throw new Error('ui'); } }))[0].dataUrl, 'data:image/png;base64,iVBORok');

    // 流式接口不存在（404）时改走一般接口；其他错误（例如 402）不重试，免得重复扣点
    const missing = createFakeStreamInvoker([{ chunks: ['not found'], status: 404, ok: false, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: missing.invoke };
    const fallbackUrls = [];
    provider.request = async ({ url }) => { fallbackUrls.push(url); throw new Error('fallback reached'); };
    await assert.rejects(() => provider.generateImage('x', { onPreview() {} }), /fallback reached/);
    assert.deepEqual(fallbackUrls, ['https://image.novelai.net/ai/generate-image']);
    const paid = createFakeStreamInvoker([{ chunks: ['{"message":"insufficient"}'], status: 402, ok: false, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: paid.invoke };
    await assert.rejects(() => provider.generateImage('x', { onPreview() {} }), /402/);
    assert.equal(fallbackUrls.length, 1, 'a paid-request error is not retried on the regular endpoint');

    // 没人看过程时照旧用一般接口
    await assert.rejects(() => provider.generateImage('x', {}), /fallback reached/);
    assert.equal(fallbackUrls.length, 2);
  } finally {
    delete globalThis.__TAURI_INTERNALS__;
  }
  console.log('ok - NovelAI streams previews when asked, returns the final image and falls back only when the stream endpoint is missing');
}

{
  // OpenAI gpt-image：设了中间图张数且有人看过程才加 stream；generations 与 edits 的事件都认；中转站回整包 JSON 照常出图
  const { OpenAIProvider } = await import('../../src/scripts/api/providers/openai.js');
  const provider = new OpenAIProvider({ apiKey: 'sk', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2' });
  const partial = (type, index) => sse(type, { type, partial_image_index: index, b64_json: `p${index}`, output_format: 'png' });
  const { invoke, calls } = createFakeStreamInvoker([
    { chunks: [partial('image_generation.partial_image', 0), partial('image_generation.partial_image', 1)], status: 200, ok: true },
    { chunks: [sse('image_generation.completed', { type: 'image_generation.completed', b64_json: 'final', output_format: 'png' })], status: 200, ok: true, done: true },
  ]);
  globalThis.__TAURI_INTERNALS__ = { invoke };
  try {
    const previews = [];
    const result = await provider.generateImage('a cat', { partial_images: '2', onPreview: p => previews.push(p) });
    assert.deepEqual(result, [{ dataUrl: 'data:image/png;base64,final', index: 0 }]);
    assert.deepEqual(previews.map(p => [p.step, p.total, p.dataUrl]), [[1, 2, 'data:image/png;base64,p0'], [2, 2, 'data:image/png;base64,p1']]);
    const start = calls.find(call => call.cmd === 'http_stream_request_start').args;
    assert.equal(start.url, 'https://api.openai.com/v1/images/generations');
    assert.deepEqual([JSON.parse(start.body).stream, JSON.parse(start.body).partial_images], [true, 2]);

    // edits（有参考图）走 image_edit.* 事件
    const edits = createFakeStreamInvoker([{ chunks: [partial('image_edit.partial_image', 0), sse('image_edit.completed', { type: 'image_edit.completed', b64_json: 'edited' })], status: 200, ok: true, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: edits.invoke };
    const edited = await provider.generateImage('a cat', { partial_images: 1, onPreview() {}, referenceImages: ['data:image/png;base64,cmVm'] });
    assert.equal(edited[0].dataUrl, 'data:image/png;base64,edited');
    assert.equal(edits.calls.find(call => call.cmd === 'http_stream_request_start').args.url, 'https://api.openai.com/v1/images/edits');

    // 中转站忽略 stream、回整包 JSON
    const relay = createFakeStreamInvoker([{ chunks: ['{"data":[{"b64_json":"whole"}],"output_format":"png"}'], status: 200, ok: true, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: relay.invoke };
    assert.equal((await provider.generateImage('a cat', { partial_images: 3, onPreview() {} }))[0].dataUrl, 'data:image/png;base64,whole');

    // 错误：HTTP 错误照原本格式；没设张数时不走流式
    const failing = createFakeStreamInvoker([{ chunks: ['{"error":{"message":"bad size"}}'], status: 400, ok: false, done: true }]);
    globalThis.__TAURI_INTERNALS__ = { invoke: failing.invoke };
    await assert.rejects(() => provider.generateImage('a cat', { partial_images: 1, onPreview() {} }), error => error.status === 400 && /OpenAI API Error: 400 - bad size/.test(error.message));
    const plainBodies = [];
    provider.request = async ({ url, body }) => { plainBodies.push([url, JSON.parse(body)]); return { ok: true, status: 200, body: '{"data":[{"b64_json":"plain"}]}' }; };
    assert.equal((await provider.generateImage('a cat', { partial_images: '0', onPreview() {} }))[0].dataUrl, 'data:image/png;base64,plain');
    assert.equal((await provider.generateImage('a cat', { partial_images: 2 }))[0].dataUrl, 'data:image/png;base64,plain', 'no one watching: no stream');
    assert.ok(plainBodies.every(([, body]) => body.stream === undefined && body.partial_images === undefined));
  } finally {
    delete globalThis.__TAURI_INTERNALS__;
  }
  // 设置：gpt-image 才有「生成过程预览」，默认关（每张中间图另计费）
  const { createDefaultImageGenerationPreset, mergeImageGenerationRequestOptions } = await import('../../src/scripts/ui/image-generation-params-utils.js');
  const preset = createDefaultImageGenerationPreset();
  assert.equal(mergeImageGenerationRequestOptions({ config: { provider: 'openai', model: 'gpt-image-2' }, preset }).partial_images, '0');
  assert.equal(mergeImageGenerationRequestOptions({ config: { provider: 'openai', model: 'gpt-image-2' }, preset, overrides: { partial_images: '2' } }).partial_images, '2');
  assert.equal(mergeImageGenerationRequestOptions({ config: { provider: 'openai', model: 'dall-e-3' }, preset, overrides: { partial_images: '2' } }).partial_images, undefined);
  console.log('ok - OpenAI gpt-image streams partial images only when asked and still accepts whole JSON replies');
}

{
  // ComfyUI：WebSocket 的二进制预览帧（类型 1／4）与 progress 步数；只认这次的 prompt；连不上照常生成、不带 client_id
  const { parseComfyUIPreviewFrame, buildComfyUIPreviewSocketUrl, openComfyUIPreviewSocket } = await import('../../src/scripts/api/providers/comfyui-preview-socket.js');
  const { ComfyUIImageProvider } = await import('../../src/scripts/api/providers/image-generation-providers.js');
  const frame1 = (imageType, bytes) => { const buf = new ArrayBuffer(8 + bytes.length); const view = new DataView(buf); view.setUint32(0, 1); view.setUint32(4, imageType); new Uint8Array(buf, 8).set(bytes); return buf; };
  const frame4 = (meta, bytes) => {
    const json = new TextEncoder().encode(JSON.stringify(meta));
    const buf = new ArrayBuffer(8 + json.length + bytes.length);
    const view = new DataView(buf);
    view.setUint32(0, 4); view.setUint32(4, json.length);
    new Uint8Array(buf, 8).set(json); new Uint8Array(buf, 8 + json.length).set(bytes);
    return buf;
  };
  assert.deepEqual(parseComfyUIPreviewFrame(frame1(1, [1, 2, 3])), { dataUrl: 'data:image/jpeg;base64,AQID', promptId: '' });
  assert.equal(parseComfyUIPreviewFrame(frame1(2, [1])).dataUrl, 'data:image/png;base64,AQ==');
  assert.deepEqual(parseComfyUIPreviewFrame(frame4({ image_type: 'image/png', prompt_id: 'p1' }, [9])), { dataUrl: 'data:image/png;base64,CQ==', promptId: 'p1' });
  const textFrame = new ArrayBuffer(8); new DataView(textFrame).setUint32(0, 3);
  assert.equal(parseComfyUIPreviewFrame(textFrame), null, 'text frames are not previews');
  assert.equal(buildComfyUIPreviewSocketUrl('https://comfy.example/base/', 'c1'), 'wss://comfy.example/base/ws?clientId=c1');
  assert.equal(buildComfyUIPreviewSocketUrl('http://127.0.0.1:8188', 'c1'), 'ws://127.0.0.1:8188/ws?clientId=c1');

  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); queueMicrotask(() => (this.fail ? this.onerror?.() : this.onopen?.())); }
    close() { this.closed = true; }
    send(data) { this.onmessage?.({ data }); }
  }
  const previews = [];
  const watcher = openComfyUIPreviewSocket({ baseUrl: 'http://127.0.0.1:8188', clientId: 'c1', onPreview: p => previews.push(p), WebSocketImpl: FakeSocket });
  assert.equal(await watcher.ready, true);
  assert.equal(sockets[0].binaryType, 'arraybuffer');
  watcher.setPromptId('p1');
  const ws = sockets[0];
  ws.send(JSON.stringify({ type: 'progress', data: { value: 5, max: 20, prompt_id: 'p1' } }));
  ws.send(JSON.stringify({ type: 'progress', data: { value: 9, max: 20, prompt_id: 'other' } }));
  ws.send(frame4({ image_type: 'image/jpeg', prompt_id: 'p1' }, [7]));
  ws.send(frame4({ image_type: 'image/jpeg', prompt_id: 'other' }, [8]));
  ws.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: 'p1' } }));
  assert.deepEqual(previews, [{ dataUrl: '', step: 5, total: 20 }, { dataUrl: 'data:image/jpeg;base64,Bw==', step: 5, total: 20 }]);
  watcher.close();
  assert.equal(ws.closed, true);

  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const provider = new ComfyUIImageProvider({ baseUrl: 'http://127.0.0.1:8188' });
    const bodies = [];
    provider.request = async ({ url, body }) => {
      if (url.endsWith('/prompt')) { bodies.push(JSON.parse(body)); return { ok: true, status: 200, body: '{"prompt_id":"p9"}' }; }
      if (url.includes('/view')) return { ok: true, status: 200, body: 'AQID' };
      throw new Error(`unexpected ${url}`);
    };
    provider.requestJson = async () => ({ p9: { outputs: { 9: { images: [{ filename: 'out.png', type: 'output' }] } } } });
    const workflow = JSON.stringify({ 3: { inputs: { text: '%prompt%' } } });
    const result = await provider.generateImage('fox', { workflowJson: workflow, onPreview() {} });
    assert.equal(result[0].dataUrl, 'data:image/png;base64,AQID');
    assert.match(bodies[0].client_id, /^omnitavern-/);
    assert.equal(sockets.at(-1).closed, true, 'the preview socket is closed after the run');
    assert.match(sockets.at(-1).url, new RegExp(`clientId=${bodies[0].client_id}$`));

    // 连不上：照常生成，不带 client_id；没人看过程：不开连线
    FakeSocket.prototype.fail = true;
    await provider.generateImage('fox', { workflowJson: workflow, onPreview() {} });
    assert.equal(bodies[1].client_id, undefined);
    delete FakeSocket.prototype.fail;
    const opened = sockets.length;
    await provider.generateImage('fox', { workflowJson: workflow });
    assert.deepEqual([sockets.length, bodies[2].client_id], [opened, undefined]);
  } finally {
    globalThis.WebSocket = realWebSocket;
  }
  console.log('ok - ComfyUI previews arrive over the websocket for this prompt only and never block generation');
}

// 假 DOM：只支持预览模块用到的部分
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.src = '';
    this.classList = {
      add: (...tokens) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...tokens])].join(' '); },
      remove: (...tokens) => { this.className = this.className.split(' ').filter(token => token && !tokens.includes(token)).join(' '); },
      contains: token => this.className.split(' ').includes(token),
    };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  getAttribute(name) { return name === 'src' ? this.src : null; }
  querySelector(selector) {
    const cls = selector.slice(1);
    const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
    return walk(this).find(node => node.className.split(' ').includes(cls)) || null;
  }
}
const createFakeDocument = () => {
  const placed = []; // { msgId, node }
  return {
    placed,
    createElement: tag => new FakeElement(tag),
    querySelectorAll(selector) {
      const unquote = value => value.replace(/\\(["\\])/g, '$1');
      const id = unquote(selector.match(/\[data-msg-id="((?:\\.|[^"\\])*)"\]/)[1]);
      const token = unquote(selector.match(/\[data-image-preview-token="((?:\\.|[^"\\])*)"\]/)[1]);
      return placed.filter(item => item.msgId === id
        && (item.node.dataset.imagePreviewToken === token || (item.node.tagName === 'IMG' && item.node.dataset.generatedImageToken === token))).map(item => item.node);
    },
  };
};

{
  // 预览：按消息与占位记号找到原位的占位，换上中间画面与进度；限频（排程一次）；结束后清掉
  const doc = createFakeDocument();
  const scheduled = [];
  const previews = createImageGenerationPreviews({ documentRef: doc, schedule: fn => scheduled.push(fn) });
  const token = '[img-图片生成中 2]';
  const placeholder = createImagePreviewPlaceholder(doc, token, '图片生成中');
  doc.placed.push({ msgId: 'm"1', node: placeholder });
  previews.update('m"1', token, { dataUrl: 'data:image/jpeg;base64,a', step: 5, total: 28 });
  previews.update('m"1', token, { dataUrl: 'data:image/jpeg;base64,b', step: 7, total: 28 });
  assert.equal(scheduled.length, 1, 'updates are batched');
  scheduled.shift()();
  assert.ok(placeholder.classList.contains('has-preview'));
  assert.equal(placeholder.querySelector('.image-gen-preview-img').src, 'data:image/jpeg;base64,b');
  assert.equal(placeholder.querySelector('.image-gen-preview-label').textContent, '生成中 7/28');
  assert.equal(placeholder.querySelector('.image-gen-preview-bar').style.width, '25%');
  previews.update('other', token, { dataUrl: 'x' });
  scheduled.shift()();
  assert.equal(placeholder.querySelector('.image-gen-preview-img').src, 'data:image/jpeg;base64,b', 'another message does not touch this placeholder');
  previews.finish('m"1', token);
  assert.equal(previews.get('m"1', token), null);
  assert.match(buildImagePreviewPlaceholderHtml('[img-图片生成中]', '图片生成中'), /^<span class="image-gen-preview" data-image-preview-token="\[img-图片生成中\]">/);

  // 重新生成：旧图先换成中间画面；失败结束后还原，成功（原地换成新图）后只去掉预览样式
  const img = new FakeElement('img');
  img.src = 'file://old.png';
  img.dataset.generatedImageToken = '[img-file://old.png]';
  doc.placed.push({ msgId: 'm2', node: img });
  previews.update('m2', '[img-file://old.png]', { dataUrl: 'data:image/jpeg;base64,p', step: 1, total: 28 });
  scheduled.shift()();
  assert.deepEqual([img.src, img.classList.contains('is-image-gen-previewing')], ['data:image/jpeg;base64,p', true]);
  previews.finish('m2', '[img-file://old.png]');
  assert.deepEqual([img.src, img.classList.contains('is-image-gen-previewing')], ['file://old.png', false]);
  previews.update('m2', '[img-file://old.png]', { dataUrl: 'data:image/jpeg;base64,q', step: 2, total: 28 });
  scheduled.shift()();
  img.dataset.generatedImageToken = '[img-file://new.png]';
  img.src = 'file://new.png';
  previews.finish('m2', '[img-file://old.png]');
  assert.deepEqual([img.src, img.classList.contains('is-image-gen-previewing')], ['file://new.png', false]);
  assert.equal(IMAGE_PREVIEW_JOB_TOKEN, 'job');
  console.log('ok - previews update their placeholders in place, batch updates and restore swapped images');
}

{
  // 写作模式的自动配图占位 [img-图片生成中 N] 显示成预览占位，不再露出原始记号；一般图片记号照旧
  const { expandRichImageTokensForHtml } = await import('../../src/scripts/ui/chat/rich-text-renderer.js');
  const html = expandRichImageTokensForHtml('前文 [img-图片生成中 2] 后文 [img-https://a.test/x.png]');
  assert.match(html, /<span class="image-gen-preview" data-image-preview-token="\[img-图片生成中 2\]">/);
  assert.doesNotMatch(html, /前文 \[img-图片生成中/);
  assert.match(html, /<img class="previewable chat-rich-inline-image chat-inline-generated-image"[^>]*src="https:\/\/a\.test\/x\.png"/);
  // 写作配图失败时留下的最后一张中间图：接在失败提示后面
  const errorToken = `[img-error-${encodeURIComponent(JSON.stringify({ brief: '中断', partial: { path: 'C:\\imgs\\generated_partial_2.jpg', step: 26, total: 28 } }))}]`;
  const failedHtml = expandRichImageTokensForHtml(`前文 ${errorToken} 后文`);
  assert.match(failedHtml, /图片生成失败：中断<\/span><\/span><span class="generated-media-partial"><img class="previewable generated-media-partial-image"[^>]*src="file:\/\/\/C:\/imgs\/generated_partial_2\.jpg">/);
  assert.match(failedHtml, /未完成的中间图 · 26\/28/);
  assert.doesNotMatch(expandRichImageTokensForHtml(`[img-error-${encodeURIComponent(JSON.stringify({ brief: 'x' }))}]`), /generated-media-partial/);
  console.log('ok - pending writing images render as preview placeholders');
}

{
  // 预览要和最终图一样大：聊天与写作的最终图都受 `.QQ_chat_msgdiv img.previewable` 的 max-width／max-height 限制（竖图约 164×240），
  // 预览原本只限宽 320、不限高，竖图会大将近三倍，画完一下子缩小。预览图要用同样的上限，外框贴着图片。
  const { readFile } = await import('node:fs/promises');
  const legacyCss = await readFile(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8');
  const previewSource = await readFile(new URL('../../src/scripts/ui/chat/image-generation-preview.js', import.meta.url), 'utf8');
  const finalRule = legacyCss.match(/\.QQ_chat_msgdiv img\.previewable\s*\{([^}]*)\}/)[1];
  const finalMax = name => finalRule.match(new RegExp(`${name}:\\s*(\\d+px)`))[1];
  const imgRule = previewSource.match(/\.image-gen-preview-img\s*\{([^}]*)\}/)[1];
  assert.match(imgRule, new RegExp(`max-width:\\s*min\\(${finalMax('max-width')},\\s*100%\\)`), 'preview width cap matches the final image');
  assert.match(imgRule, new RegExp(`max-height:\\s*${finalMax('max-height')}`), 'preview height cap matches the final image');
  assert.match(imgRule, /width:\s*auto/);
  const frameRule = previewSource.match(/\.image-gen-preview-frame\s*\{([^}]*)\}/)[1];
  assert.match(frameRule, /width:\s*fit-content/, 'the frame hugs the image so the progress bar spans the picture');
  assert.doesNotMatch(frameRule, /320px/);
  console.log('ok - the live preview is the same size as the finished image');
}

{
  // 占位记号 [img-图片生成中] 是协议字串，不翻译；显示出来的标签跟随界面语言
  const { initializeI18n } = await import('../../src/scripts/i18n/index.js');
  const { expandRichImageTokensForHtml } = await import('../../src/scripts/ui/chat/rich-text-renderer.js');
  try {
    await initializeI18n({
      preference: 'en',
      documentLike: null,
      fetchFn: async () => ({ ok: true, json: async () => ({ 图片生成中: 'Generating image' }) }),
    });
    const html = expandRichImageTokensForHtml('[img-图片生成中]');
    assert.match(html, /data-image-preview-token="\[img-图片生成中\]"/);
    assert.match(html, /<span class="image-gen-preview-label">Generating image<\/span>/);
  } finally {
    await initializeI18n({ preference: 'zh-CN', documentLike: null });
  }
  console.log('ok - the writing image placeholder label follows the UI language');
}

console.log('image-generation-preview-tests passed');
