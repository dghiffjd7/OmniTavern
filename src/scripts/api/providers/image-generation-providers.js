import { createLinkedAbortController, invokeNativeHttpRequest } from '../abort.js';
import { prepareTransportRequest } from '../transport.js';
import { safeInvoke } from '../../utils/tauri.js';
import { base64ImageToDataUrl, emitImagePreview, streamImageSse } from './image-stream-transport.js';
import { openComfyUIPreviewSocket } from './comfyui-preview-socket.js';
import {
  NOVELAI_IMAGE_MODEL_CACHE_KEY,
  NOVELAI_IMAGE_MODEL_CATALOG_URLS,
  isNovelAIPreciseReferenceModel,
  resolveNovelAIImageModelCatalog,
} from './novelai-image-model-catalog.js';
import {
  WAVESPEED_DEFAULT_BASE_URL,
  WAVESPEED_IMAGE_MODEL_TYPES,
  describeWaveSpeedReferenceInput,
  findWaveSpeedRequestSchema,
  getCachedWaveSpeedModels,
  rememberWaveSpeedModels,
} from './wavespeed-model-catalog.js';

const DEFAULT_IMAGE_MIME = 'image/png';

const getTauriInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
  return (
    g?.__TAURI__?.core?.invoke ||
    g?.__TAURI__?.invoke ||
    g?.__TAURI_INVOKE__ ||
    g?.__TAURI_INTERNALS__?.invoke
  );
};

const isTauriWebview = () => {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
    const origin = String(g?.location?.origin || '');
    return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || origin.includes('tauri.localhost'));
  } catch {
    return false;
  }
};

const makeAbortError = () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
};

const toInt = (value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const toNumber = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const hasValue = (value) => String(value ?? '').trim() !== '';

const isRandomSeedRequest = (value) => {
  if (!hasValue(value)) return false;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n === -1;
};

const toOptionalSeed = (value, { max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!hasValue(value) || isRandomSeedRequest(value)) return undefined;
  return toInt(value, 0, { min: 0, max });
};

const randomSeed = (max = Number.MAX_SAFE_INTEGER) => Math.floor(Math.random() * Math.max(1, max));

const toRandomSeed = (value, { max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!hasValue(value) || isRandomSeedRequest(value)) return randomSeed(max);
  return toInt(value, 0, { min: 0, max });
};

const isEnabled = (value) => value === true || String(value ?? '').trim().toLowerCase() === 'true';

const trimTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

const joinUrl = (baseUrl, path) => {
  const base = trimTrailingSlash(baseUrl);
  const tail = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
  return `${base}${tail}`;
};

const mimeFromFormat = (format = '') => {
  const raw = String(format || '').trim().toLowerCase();
  if (raw === 'jpg' || raw === 'jpeg') return 'image/jpeg';
  if (raw === 'webp') return 'image/webp';
  if (raw === 'gif') return 'image/gif';
  return DEFAULT_IMAGE_MIME;
};

const base64ToByteArray = (base64 = '') => {
  const raw = String(base64 || '').replace(/^data:[^,]+,/i, '');
  const bin = atob(raw);
  const bytes = new Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const extractZipImageDataUrl = async (zipBase64 = '') => {
  const bytes = base64ToByteArray(zipBase64);
  const entries = await safeInvoke('read_zip_entries', { bytes });
  const image = (Array.isArray(entries) ? entries : []).find((entry) => {
    const name = String(entry?.name || '').toLowerCase();
    return entry?.base64 && /\.(png|jpe?g|webp)$/i.test(name);
  });
  if (!image?.base64) {
    throw new Error('NovelAI 返回了压缩包，但没有找到图片文件');
  }
  const name = String(image.name || '').toLowerCase();
  const mime = name.endsWith('.jpg') || name.endsWith('.jpeg')
    ? 'image/jpeg'
    : name.endsWith('.webp')
      ? 'image/webp'
      : DEFAULT_IMAGE_MIME;
  return `data:${mime};base64,${image.base64}`;
};

const encodeMultipartField = (boundary, name, value) => {
  const key = String(name || '').trim();
  if (!key || value === undefined || value === null || String(value) === '') return '';
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${key}"`,
    '',
    String(value),
    '',
  ].join('\r\n');
};

const buildMultipartBody = (fields = {}) => {
  const boundary = `MiPhoneBoundary${Date.now().toString(36)}${Math.random().toString(16).slice(2)}`;
  const body = `${Object.entries(fields)
    .map(([name, value]) => encodeMultipartField(boundary, name, value))
    .filter(Boolean)
    .join('')}${`--${boundary}--\r\n`}`;
  return { boundary, body };
};

class ImageProviderBase {
  constructor(config = {}) {
    this.transportConfig = config || {};
    this.provider = String(config.provider || '').trim();
    this.apiKey = String(config.apiKey || '').trim();
    this.baseUrl = trimTrailingSlash(config.baseUrl || '');
    this.model = String(config.model || '').trim();
    this.timeout = config.timeout || 60000;
  }

  authHeaders() {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async request({
    url,
    method = 'GET',
    headers = {},
    body = undefined,
    bodyBase64 = '',
    signal,
    requestId = '',
    responseBase64 = false,
    allowProxy = true,
    timeoutMs = this.timeout,
  } = {}) {
    const prepared = prepareTransportRequest({
      config: this.transportConfig,
      provider: this.provider,
      url,
      headers,
      allowProxy,
    });
    const mergedHeaders = { ...(prepared.headers || {}) };
    const invoker = getTauriInvoker();
    if (typeof invoker === 'function') {
      if (signal?.aborted) throw makeAbortError();
      try {
        return await invokeNativeHttpRequest({
          invoker,
          signal,
          requestId,
          args: {
            url: prepared.url,
            method,
            headers: mergedHeaders,
            body: bodyBase64 ? null : typeof body === 'string' ? body : body == null ? null : String(body),
            bodyBase64: bodyBase64 || null,
            timeoutMs,
            responseBase64: Boolean(responseBase64),
          },
        });
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw makeAbortError();
        if (isTauriWebview()) {
          const e = new Error(`native http_request failed: ${err?.message || err}`);
          e.cause = err;
          throw e;
        }
      }
    }

    const { controller, cleanup } = createLinkedAbortController({ timeoutMs, signal });
    try {
      const response = await fetch(prepared.url, {
        method,
        headers: mergedHeaders,
        signal: controller.signal,
        body: bodyBase64 ? Uint8Array.from(base64ToByteArray(bodyBase64)) : body,
      });
      const outHeaders = {};
      response.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      const responseBody = responseBase64
        ? await this.responseArrayBufferToBase64(response)
        : await response.text();
      return { status: response.status, ok: response.ok, headers: outHeaders, body: responseBody };
    } finally {
      cleanup();
    }
  }

  async responseArrayBufferToBase64(response) {
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  async requestJson(request = {}) {
    const res = await this.request(request);
    if (!res.ok) {
      const detail = String(res.body || '').trim().slice(0, 500);
      throw new Error(`${this.provider || 'Image'} API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
    }
    try {
      return JSON.parse(res.body || '{}');
    } catch (err) {
      throw new Error(`${this.provider || 'Image'} API returned invalid JSON: ${err.message}`);
    }
  }

  async healthCheck() {
    try {
      await this.listModels();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

export class TogetherAIImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'togetherai',
      baseUrl: config.baseUrl || 'https://api.together.xyz/v1',
      model: config.model || 'black-forest-labs/FLUX.1-schnell',
    });
  }

  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    if (Array.isArray(options.referenceImages) && options.referenceImages.length) {
      throw new Error('Together AI 参考图链路尚未接入本地图片上传');
    }
    const payload = {
      model: this.model,
      prompt: String(prompt || '').trim(),
      n: toInt(options.n, 1, { min: 1, max: 4 }),
    };
    if (hasValue(options.width)) payload.width = toInt(options.width, 1024, { min: 128, max: 2048 });
    if (hasValue(options.height)) payload.height = toInt(options.height, 1024, { min: 128, max: 2048 });
    if (hasValue(options.steps)) payload.steps = toInt(options.steps, 4, { min: 1, max: 100 });
    const seed = toOptionalSeed(options.seed);
    if (seed !== undefined) payload.seed = seed;
    if (hasValue(options.negativePrompt || options.negative_prompt)) payload.negative_prompt = options.negativePrompt || options.negative_prompt;
    if (hasValue(options.guidanceScale || options.guidance_scale)) payload.guidance_scale = toNumber(options.guidanceScale || options.guidance_scale, 3.5, { min: 0, max: 30 });
    if (hasValue(options.responseFormat || options.response_format)) payload.response_format = options.responseFormat || options.response_format;
    if (hasValue(options.outputFormat || options.output_format)) payload.output_format = options.outputFormat || options.output_format;
    if (isEnabled(options.disableSafetyChecker || options.disable_safety_checker)) payload.disable_safety_checker = true;

    const data = await this.requestJson({
      url: joinUrl(this.baseUrl, '/images/generations'),
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map((item, index) => {
      const b64 = item?.b64_json || item?.b64 || item?.image || '';
      if (b64) return { dataUrl: `data:${mimeFromFormat(options.output_format || 'png')};base64,${b64}`, index };
      return { url: String(item?.url || '').trim(), index };
    });
  }

  async listModels() {
    return [
      'black-forest-labs/FLUX.1-schnell',
      'black-forest-labs/FLUX.1-dev',
      'black-forest-labs/FLUX.1.1-pro',
      'black-forest-labs/FLUX.1-kontext-dev',
    ];
  }
}

export class PollinationsImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'pollinations',
      baseUrl: config.baseUrl || 'https://gen.pollinations.ai',
      model: config.model || 'flux',
    });
  }

  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    const url = new URL(joinUrl(this.baseUrl, `/image/${encodeURIComponent(String(prompt || '').trim())}`));
    if (this.model) url.searchParams.set('model', this.model);
    if (hasValue(options.width)) url.searchParams.set('width', String(toInt(options.width, 1024, { min: 64, max: 4096 })));
    if (hasValue(options.height)) url.searchParams.set('height', String(toInt(options.height, 1024, { min: 64, max: 4096 })));
    const seed = toOptionalSeed(options.seed);
    if (seed !== undefined) url.searchParams.set('seed', String(seed));
    const negative = options.negativePrompt || options.negative_prompt;
    if (hasValue(negative)) url.searchParams.set('negative_prompt', String(negative));
    if (isEnabled(options.enhance)) url.searchParams.set('enhance', 'true');
    if (options.noLogo !== false && options.nologo !== false) url.searchParams.set('nologo', 'true');
    if (options.private !== false) url.searchParams.set('private', 'true');
    if (this.apiKey) url.searchParams.set('token', this.apiKey);

    const res = await this.request({
      url: url.toString(),
      method: 'GET',
      headers: { ...this.authHeaders(), Accept: 'image/*' },
      signal,
      responseBase64: true,
    });
    if (!res.ok) {
      throw new Error(`Pollinations API Error: ${res.status}`);
    }
    const mime = String(res.headers?.['content-type'] || res.headers?.['Content-Type'] || 'image/jpeg').split(';')[0] || 'image/jpeg';
    return [{ dataUrl: `data:${mime};base64,${res.body}`, index: 0 }];
  }

  async listModels() {
    try {
      const data = await this.requestJson({ url: joinUrl(this.baseUrl, '/image/models'), method: 'GET' });
      if (Array.isArray(data)) return data.map(item => String(item?.value || item?.id || item?.name || item).trim()).filter(Boolean);
    } catch {}
    return ['flux', 'turbo'];
  }
}

// WaveSpeed：生图不是 OpenAI 格式。每个模型有自己的路径，提交后是异步任务，要轮询结果；
// 参数也按模型不同（参数表不收额外字段），按 /models 返回的 api_schema 只发该模型认得的参数。
const WAVESPEED_MAX_WAIT_MS = 5 * 60 * 1000;
const WAVESPEED_MAX_POLL_FAILURES = 5;
const WAVESPEED_FAILED_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'timeout', 'deleted']);

const pickWaveSpeedAspectRatio = (choices = [], width = 0, height = 0) => {
  const target = Math.log(width / height);
  let best = '';
  let bestDiff = Infinity;
  for (const choice of choices) {
    const [w, h] = String(choice).split(':').map(Number);
    if (!(w > 0 && h > 0)) continue;
    const diff = Math.abs(Math.log(w / h) - target);
    if (diff < bestDiff) {
      best = String(choice);
      bestDiff = diff;
    }
  }
  return best;
};

// 清晰度档位如 1k / 1.5k / 2k：取能装下宽高长边的最小一档
const pickWaveSpeedResolution = (choices = [], width = 0, height = 0) => {
  const tiers = choices
    .map(choice => ({ choice: String(choice), k: Number(String(choice).match(/^(\d+(?:\.\d+)?)k$/i)?.[1]) }))
    .filter(tier => tier.k > 0)
    .sort((a, b) => a.k - b.k);
  if (!tiers.length) return '';
  const need = Math.max(width, height) / 1024;
  return (tiers.find(tier => tier.k + 1e-6 >= need) || tiers[tiers.length - 1]).choice;
};

// 带参考图时不发尺寸和比例：编辑模型默认按参考图的比例出图
const buildWaveSpeedPayload = (prompt = '', options = {}, properties = null, { hasReferences = false } = {}) => {
  const payload = { prompt };
  if (!properties) return payload;
  const has = key => Object.prototype.hasOwnProperty.call(properties, key);
  const width = hasValue(options.width) ? toInt(options.width, 0, { min: 1 }) : 0;
  const height = hasValue(options.height) ? toInt(options.height, 0, { min: 1 }) : 0;
  if (width && height) {
    if (has('size')) {
      if (!hasReferences) payload.size = `${width}*${height}`;
    } else {
      const ratio = has('aspect_ratio') && !hasReferences ? pickWaveSpeedAspectRatio(properties.aspect_ratio?.enum, width, height) : '';
      if (ratio) payload.aspect_ratio = ratio;
      const resolution = has('resolution') ? pickWaveSpeedResolution(properties.resolution?.enum, width, height) : '';
      if (resolution) payload.resolution = resolution;
    }
  }
  if (has('num_images') && hasValue(options.n)) {
    payload.num_images = toInt(options.n, 1, {
      min: Number(properties.num_images?.minimum ?? 1),
      max: Number(properties.num_images?.maximum ?? 4),
    });
  }
  const seed = toOptionalSeed(options.seed);
  if (has('seed') && seed !== undefined) payload.seed = seed;
  if (has('num_inference_steps') && hasValue(options.steps)) {
    payload.num_inference_steps = toInt(options.steps, 28, {
      min: Number(properties.num_inference_steps?.minimum ?? 1),
      max: Number(properties.num_inference_steps?.maximum ?? 100),
    });
  }
  const negative = options.negativePrompt || options.negative_prompt;
  if (has('negative_prompt') && hasValue(negative)) payload.negative_prompt = String(negative).trim();
  return payload;
};

const sleepWithSignal = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(makeAbortError());
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(makeAbortError());
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

const normalizeWaveSpeedReferences = (referenceImages = []) => (Array.isArray(referenceImages) ? referenceImages : [])
  .map(item => String(typeof item === 'string' ? item : item?.dataUrl || item?.data_url || item?.url || item?.imageUrl || item?.image_url || '').trim())
  .filter(Boolean);

const base64ByteLength = (base64 = '') => {
  const raw = String(base64 || '');
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
};

const extensionFromMime = (mime = '') => {
  const sub = String(mime || '').toLowerCase().split('/')[1] || 'png';
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'png';
};

export class WaveSpeedImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'wavespeed',
      baseUrl: config.baseUrl || WAVESPEED_DEFAULT_BASE_URL,
      model: config.model || 'bytedance/seedream-v5.5',
    });
    const interval = Number(config.pollIntervalMs);
    this.pollIntervalMs = Number.isFinite(interval) && interval >= 0 ? interval : 1500;
  }

  async loadModelCatalog({ signal, refresh = false } = {}) {
    const cached = refresh ? null : getCachedWaveSpeedModels(this.baseUrl);
    if (cached) return cached;
    const data = await this.requestJson({ url: joinUrl(this.baseUrl, '/models'), method: 'GET', headers: this.authHeaders(), signal });
    const models = Array.isArray(data?.data) ? data.data : [];
    rememberWaveSpeedModels(this.baseUrl, models);
    return models;
  }

  // 查不到这个模型的参数表时回 null，只发提示词
  async resolveModelSchema(signal) {
    try {
      return findWaveSpeedRequestSchema(await this.loadModelCatalog({ signal }), this.model);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw makeAbortError();
      return null;
    }
  }

  // 本地参考图先上传到 WaveSpeed（文件在那边保留 7 天），模型栏位里填的是返回的网址
  async uploadReference(reference, index, signal) {
    if (/^https?:\/\//i.test(reference)) return reference;
    const match = String(reference).match(/^data:([^;,]*)[^,]*;base64,(.*)$/is);
    if (!match) throw new Error('参考图格式无法识别');
    const mime = match[1] || DEFAULT_IMAGE_MIME;
    const base64 = match[2].replace(/\s+/g, '');
    const ticket = await this.requestJson({
      url: joinUrl(this.baseUrl, '/media/uploads'),
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: `reference-${index + 1}.${extensionFromMime(mime)}`, size: base64ByteLength(base64), content_type: mime }),
      signal,
    });
    const upload = ticket?.data?.upload;
    const downloadUrl = String(ticket?.data?.download_url || '').trim();
    if (!upload?.url || !downloadUrl) throw new Error('WaveSpeed 没有返回参考图上传地址');
    // 上传地址是签好名的临时地址，不带 API key
    const res = await this.request({
      url: String(upload.url),
      method: String(upload.method || 'PUT').toUpperCase(),
      headers: { ...(upload.headers && typeof upload.headers === 'object' ? upload.headers : {}) },
      bodyBase64: base64,
      signal,
    });
    if (!res.ok) throw new Error(`参考图上传失败：HTTP ${res.status}`);
    return downloadUrl;
  }

  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    const references = normalizeWaveSpeedReferences(options.referenceImages || options.reference_images);
    const schema = await this.resolveModelSchema(signal);
    const input = describeWaveSpeedReferenceInput(schema);
    // 这些情况在上传和提交前就拦下，不花钱
    if (references.length && !schema) throw new Error('查不到当前 WaveSpeed 模型的参数，没法确定参考图怎么传');
    if (references.length && !input.field) throw new Error('当前 WaveSpeed 模型不能用参考图，请在设置里改选编辑模型（名称里通常带 edit）');
    if (references.length > input.max && input.field) {
      throw new Error(`当前 WaveSpeed 模型最多只能用 ${input.max} 张参考图，这次带了 ${references.length} 张`);
    }
    if (!references.length && input.required) throw new Error('当前 WaveSpeed 模型是编辑模型，需要先添加参考图');
    const payload = buildWaveSpeedPayload(String(prompt || '').trim(), options, schema?.properties || null, {
      hasReferences: references.length > 0,
    });
    if (references.length) {
      const urls = [];
      for (const [index, reference] of references.entries()) urls.push(await this.uploadReference(reference, index, signal));
      payload[input.field] = input.field === 'images' ? urls : urls[0];
    }
    const submitted = await this.requestJson({
      url: joinUrl(this.baseUrl, `/${this.model}`),
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const taskId = String(submitted?.data?.id || '').trim();
    if (!taskId) {
      throw new Error(`WaveSpeed 没有返回任务 ID：${String(submitted?.message || '').slice(0, 300)}`);
    }
    const result = String(submitted?.data?.status || '').toLowerCase() === 'completed'
      ? submitted.data
      : await this.waitForResult(taskId, signal);
    const urls = (Array.isArray(result?.outputs) ? result.outputs : [])
      .map(item => String(typeof item === 'string' ? item : item?.url || '').trim())
      .filter(Boolean);
    if (!urls.length) throw new Error(`WaveSpeed 任务 ${taskId} 已完成，但没有返回图片`);
    const images = [];
    for (const [index, url] of urls.entries()) images.push(await this.downloadOutput(url, index, signal));
    return images;
  }

  // 只查同一个任务，不重新提交：重新提交会另开任务、重复扣费
  async waitForResult(taskId, signal) {
    const deadline = Date.now() + Math.max(this.timeout, WAVESPEED_MAX_WAIT_MS);
    const url = joinUrl(this.baseUrl, `/predictions/${encodeURIComponent(taskId)}/result`);
    let failures = 0;
    for (;;) {
      if (signal?.aborted) throw makeAbortError();
      let data = null;
      try {
        const res = await this.request({ url, method: 'GET', headers: this.authHeaders(), signal });
        if (res.ok) data = JSON.parse(res.body || '{}')?.data || null;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw makeAbortError();
      }
      if (data) {
        failures = 0;
        const status = String(data.status || '').toLowerCase();
        if (status === 'completed') return data;
        if (WAVESPEED_FAILED_STATUSES.has(status)) {
          throw new Error(`WaveSpeed 任务 ${taskId} 失败：${String(data.error || status).slice(0, 300)}`);
        }
      } else {
        failures += 1;
        if (failures >= WAVESPEED_MAX_POLL_FAILURES) {
          throw new Error(`WaveSpeed 任务 ${taskId} 的结果连续查询失败；任务可能仍在运行，可到 WaveSpeed 后台查看`);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`WaveSpeed 任务 ${taskId} 等待超时；任务可能仍在运行，可到 WaveSpeed 后台查看`);
      }
      await sleepWithSignal(this.pollIntervalMs, signal);
    }
  }

  // 图片网址可能过期，也可能不允许页面跨域读取，所以这里直接下载；下载不了再交回网址
  async downloadOutput(url, index, signal) {
    try {
      const res = await this.request({ url, method: 'GET', headers: {}, signal, responseBase64: true });
      if (res.ok && res.body) {
        const type = String(res.headers?.['content-type'] || res.headers?.['Content-Type'] || '').split(';')[0].trim();
        const ext = String(url).split(/[?#]/)[0].split('.').pop();
        const mime = type.startsWith('image/') ? type : mimeFromFormat(ext);
        return { dataUrl: `data:${mime};base64,${res.body}`, index };
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw makeAbortError();
    }
    return { url, index };
  }

  async listModels() {
    const models = await this.loadModelCatalog({ refresh: true });
    return models
      .filter(item => WAVESPEED_IMAGE_MODEL_TYPES.includes(String(item?.type || '')))
      .map(item => String(item?.model_id || '').trim())
      .filter(Boolean);
  }
}

export class StabilityAIImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'stability',
      baseUrl: config.baseUrl || 'https://api.stability.ai',
      model: config.model || 'stable-image-core',
    });
  }

  resolveEndpointAndPayload(options = {}, prompt = '') {
    const model = String(this.model || 'stable-image-core').trim();
    const lower = model.toLowerCase();
    const outputFormat = String(options.outputFormat || options.output_format || 'png').trim() || 'png';
    const payload = {
      prompt: String(prompt || '').trim().slice(0, 10000),
      negative_prompt: String(options.negativePrompt || options.negative_prompt || '').trim().slice(0, 10000),
      aspect_ratio: String(options.aspectRatio || options.aspect_ratio || '1:1').trim(),
      seed: toOptionalSeed(options.seed, { max: 4294967294 }),
      style_preset: options.stylePreset || options.style_preset || undefined,
      output_format: outputFormat,
    };
    if (lower.includes('ultra')) {
      return { path: '/v2beta/stable-image/generate/ultra', payload, outputFormat };
    }
    if (lower.includes('core')) {
      return { path: '/v2beta/stable-image/generate/core', payload, outputFormat };
    }
    payload.mode = 'text-to-image';
    if (model && model !== 'stable-diffusion-3') payload.model = model;
    return { path: '/v2beta/stable-image/generate/sd3', payload, outputFormat };
  }

  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    const { path, payload, outputFormat } = this.resolveEndpointAndPayload(options, prompt);
    const { boundary, body } = buildMultipartBody(payload);
    const res = await this.request({
      url: joinUrl(this.baseUrl, path),
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        Accept: 'image/*',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal,
      responseBase64: true,
    });
    if (!res.ok) {
      const detail = String(res.body || '').trim().slice(0, 240);
      throw new Error(`Stability AI API Error: ${res.status}${detail ? ` - ${detail}` : ''}`);
    }
    return [{ dataUrl: `data:${mimeFromFormat(outputFormat)};base64,${res.body}`, index: 0 }];
  }

  async listModels() {
    return ['stable-image-core', 'stable-image-ultra', 'stable-diffusion-3', 'sd3.5-large', 'sd3.5-large-turbo'];
  }

  async healthCheck() {
    if (!this.apiKey) return { ok: false, error: '缺少 Stability AI API Key' };
    try {
      const res = await this.request({
        url: joinUrl(this.baseUrl, '/v1/user/balance'),
        method: 'GET',
        headers: this.authHeaders(),
      });
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

// NovelAI 精准参考的参考图：官方只收 1024×1536、1536×1024、1472×1472 三种尺寸（「黑边补齐」），
// 按长宽比选一种，等比缩放后居中、黑边补齐，转成 PNG base64（不带 data: 前缀）。
export const pickNovelAIReferenceSize = (width, height) => {
  const ratio = Number(width) / Math.max(1, Number(height));
  if (ratio < 0.83) return [1024, 1536];
  if (ratio > 1.2) return [1536, 1024];
  return [1472, 1472];
};

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export const padNovelAIReferenceImage = async (dataUrl) => {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const [width, height] = pickNovelAIReferenceSize(bitmap.width, bitmap.height);
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = Math.round(bitmap.width * scale);
  const drawHeight = Math.round(bitmap.height * scale);
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, Math.round((width - drawWidth) / 2), Math.round((height - drawHeight) / 2), drawWidth, drawHeight);
  bitmap.close?.();
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return arrayBufferToBase64(await blob.arrayBuffer());
};

const clampUnit = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && String(value ?? '').trim() !== '' ? Math.min(1, Math.max(0, number)) : fallback;
};

export class NovelAIImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'novelai',
      baseUrl: config.baseUrl || 'https://image.novelai.net',
      model: config.model || 'nai-diffusion-4-5-full',
    });
    this.lastModelCatalogSource = 'bundled';
    this.prepareReferenceImage = typeof config.prepareReferenceImage === 'function' ? config.prepareReferenceImage : padNovelAIReferenceImage;
  }

  async loadModelCatalogCache() {
    try {
      const cached = await safeInvoke('load_kv', { name: NOVELAI_IMAGE_MODEL_CACHE_KEY });
      if (cached && typeof cached === 'object') return cached;
    } catch {}
    try {
      const raw = globalThis.localStorage?.getItem?.(NOVELAI_IMAGE_MODEL_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async saveModelCatalogCache(value) {
    try {
      await safeInvoke('save_kv', { name: NOVELAI_IMAGE_MODEL_CACHE_KEY, data: value });
    } catch {}
    try {
      globalThis.localStorage?.setItem?.(NOVELAI_IMAGE_MODEL_CACHE_KEY, JSON.stringify(value));
    } catch {}
  }

  buildPayload(prompt, options = {}) {
    const negative = String(options.negativePrompt || options.negative_prompt || '').trim();
    const seed = toRandomSeed(options.seed, { max: 9999999999 });
    const width = toInt(options.width, 1024, { min: 64, max: 2048 });
    const height = toInt(options.height, 1024, { min: 64, max: 2048 });
    const scale = toNumber(options.scale, 5, { min: 0, max: 30 });
    const cfgRescale = toNumber(options.cfgRescale || options.cfg_rescale, 0, { min: 0, max: 1 });
    const sampler = String(options.sampler || 'k_euler_ancestral').trim();
    const scheduler = String(options.scheduler || options.noise_schedule || 'karras').trim();
    const steps = toInt(options.steps, 23, { min: 1, max: 50 });
    const promptPrefix = String(options.promptPrefix || options.prompt_prefix || '').trim();
    const promptSuffix = String(options.promptSuffix || options.prompt_suffix || '').trim();
    const resolved = options.imagePromptResolved;
    const input = resolved ? String(resolved.prompt || '') : [promptPrefix, String(prompt || '').trim(), promptSuffix].filter(Boolean).join(', ');
    const characters = Array.isArray(resolved?.characters) ? resolved.characters : [];
    const useCoords = resolved?.useCoords === true && characters.length > 0;
    const sm = sampler === 'ddim' ? false : isEnabled(options.sm);
    const smDyn = sm ? isEnabled(options.sm_dyn) : false;
    return {
      action: 'generate',
      input,
      model: this.model || 'nai-diffusion-4-5-full',
      parameters: {
        params_version: 3,
        prefer_brownian: true,
        negative_prompt: negative,
        height,
        width,
        scale,
        seed,
        sampler,
        noise_schedule: scheduler,
        steps,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: isEnabled(options.qualityToggle ?? true),
        add_original_image: false,
        controlnet_strength: 1,
        deliberate_euler_ancestral_bug: false,
        dynamic_thresholding: isEnabled(options.decrisper),
        legacy: false,
        legacy_v3_extend: false,
        sm,
        sm_dyn: smDyn,
        uncond_scale: 1,
        cfg_rescale: cfgRescale,
        use_coords: useCoords,
        characterPrompts: characters.map(character => ({ prompt: character.prompt, uc: character.negative, center: character.center })),
        reference_image_multiple: [],
        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],
        v4_negative_prompt: {
          caption: {
            base_caption: negative,
            char_captions: characters.map(character => ({ char_caption: character.negative, centers: [character.center] })),
          },
        },
        v4_prompt: {
          caption: {
            base_caption: input,
            char_captions: characters.map(character => ({ char_caption: character.prompt, centers: [character.center] })),
          },
          use_coords: useCoords,
          use_order: true,
        },
      },
    };
  }

  /**
   * 流式生图（/ai/generate-image-stream，SSE）：intermediate 事件是去噪中的预览，final 是成图，error 是错误。
   * 返回成图；接口不存在（404／405）时返回 null 让调用方改用一般接口，其他错误照常抛出（避免重复扣点）。
   */
  async generateImageStream(payload, { signal, onPreview } = {}) {
    const total = Number(payload?.parameters?.steps) || 0;
    const prepared = prepareTransportRequest({
      config: this.transportConfig,
      provider: this.provider,
      url: joinUrl(this.baseUrl, '/ai/generate-image-stream'),
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      allowProxy: true,
    });
    try {
      const events = streamImageSse({
        url: prepared.url,
        headers: prepared.headers,
        body: JSON.stringify({ ...payload, parameters: { ...payload.parameters, stream: 'sse' } }),
        signal,
        timeoutMs: Math.max(this.timeout, 180000),
        label: 'NovelAI',
        invoker: getTauriInvoker(),
      });
      for await (const { event, data } of events) {
        const type = String(data?.event_type || event || '').trim().toLowerCase();
        const image = typeof data?.image === 'string' ? data.image : '';
        if (type === 'error') throw new Error(`NovelAI API Error: ${String(data?.message || data?.error || JSON.stringify(data)).slice(0, 300)}`);
        if (type === 'intermediate' && image) {
          const step = Number.isFinite(Number(data?.step_ix)) ? Number(data.step_ix) + 1 : 0;
          emitImagePreview(onPreview, { dataUrl: base64ImageToDataUrl(image), step, total, index: Number(data?.samp_ix) || 0 });
        } else if (type === 'final' && image) {
          return [{ dataUrl: base64ImageToDataUrl(image), index: 0 }];
        }
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw makeAbortError();
      if ([404, 405].includes(Number(error?.status))) return null;
      throw error;
    }
    throw new Error('NovelAI 流式回应没有返回最终图片');
  }

  /**
   * 精准参考（参数「精准参考」不是关闭、且有参考图时）：用第一张参考图。字段照官方接口定义（director_reference_*）；
   * 保真度在接口里是反的（1 − 保真度，与官网界面一致：见计划书「聊天参考图与高级参数重设计」）。每张图另扣 5 Anlas。
   */
  async addPreciseReference(payload, options = {}) {
    const mode = String(options.preciseReference || 'off');
    const first = (Array.isArray(options.referenceImages) ? options.referenceImages : [])[0];
    const dataUrl = typeof first === 'string' ? first : String(first?.dataUrl || '');
    if (!['character', 'character&style', 'style'].includes(mode) || !dataUrl || !isNovelAIPreciseReferenceModel(payload.model)) return payload;
    const image = await this.prepareReferenceImage(dataUrl);
    const fidelity = clampUnit(options.preciseReferenceFidelity, 1);
    return {
      ...payload,
      parameters: {
        ...payload.parameters,
        director_reference_images: [image],
        director_reference_descriptions: [{ caption: { base_caption: mode, char_captions: [] }, legacy_uc: false }],
        director_reference_information_extracted: [1],
        director_reference_strength_values: [clampUnit(options.preciseReferenceStrength, 1)],
        director_reference_secondary_strength_values: [Number((1 - fidelity).toFixed(4))],
      },
    };
  }

  async generateImage(prompt, options = {}) {
    const { signal, onPreview } = options || {};
    if (!this.apiKey) throw new Error('缺少 NovelAI Access Token');
    const payload = await this.addPreciseReference(this.buildPayload(prompt, options), options);
    // 有人要看生成过程时走流式接口
    if (typeof onPreview === 'function') {
      const streamed = await this.generateImageStream(payload, { signal, onPreview });
      if (streamed) return streamed;
    }
    const res = await this.request({
      url: joinUrl(this.baseUrl, '/ai/generate-image'),
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
      responseBase64: true,
    });
    if (!res.ok) {
      throw new Error(`NovelAI API Error: ${res.status}`);
    }
    const dataUrl = await extractZipImageDataUrl(res.body);
    return [{ dataUrl, index: 0 }];
  }

  async listModels() {
    const result = await resolveNovelAIImageModelCatalog({
      catalogUrls: NOVELAI_IMAGE_MODEL_CATALOG_URLS,
      fetchJson: (url, { kind } = {}) => this.requestJson({
        url,
        method: 'GET',
        headers: {
          ...(kind === 'official' ? this.authHeaders() : {}),
          Accept: 'application/json',
        },
        allowProxy: false,
        timeoutMs: 8000,
      }),
      loadCache: () => this.loadModelCatalogCache(),
      saveCache: value => this.saveModelCatalogCache(value),
    });
    this.lastModelCatalogSource = result.source;
    return result.models;
  }
}

export class Automatic1111ImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'automatic1111',
      baseUrl: config.baseUrl || 'http://127.0.0.1:7860',
      model: config.model || 'default',
    });
  }

  authHeaders() {
    if (!this.apiKey) return {};
    if (this.apiKey.includes(':')) return { Authorization: `Basic ${btoa(this.apiKey)}` };
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    const payload = {
      prompt: String(prompt || '').trim(),
      negative_prompt: String(options.negativePrompt || options.negative_prompt || '').trim(),
      width: toInt(options.width, 1024, { min: 64, max: 4096 }),
      height: toInt(options.height, 1024, { min: 64, max: 4096 }),
      steps: toInt(options.steps, 20, { min: 1, max: 150 }),
      cfg_scale: toNumber(options.cfgScale || options.cfg_scale, 7, { min: 0, max: 30 }),
      batch_size: toInt(options.n, 1, { min: 1, max: 8 }),
    };
    if (hasValue(options.samplerName || options.sampler_name)) payload.sampler_name = options.samplerName || options.sampler_name;
    if (hasValue(options.scheduler)) payload.scheduler = options.scheduler;
    if (hasValue(options.seed)) {
      const seed = toInt(options.seed, -1);
      payload.seed = seed < 0 ? -1 : seed;
    }
    if (isEnabled(options.restoreFaces || options.restore_faces)) payload.restore_faces = true;
    if (isEnabled(options.enableHr || options.enable_hr)) payload.enable_hr = true;
    if (this.model && this.model !== 'default') {
      payload.override_settings = { sd_model_checkpoint: this.model };
    }

    const data = await this.requestJson({
      url: joinUrl(this.baseUrl, '/sdapi/v1/txt2img'),
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const images = Array.isArray(data?.images) ? data.images : [];
    return images.map((image, index) => {
      const raw = String(image || '').trim();
      return {
        dataUrl: raw.startsWith('data:image/') ? raw : `data:image/png;base64,${raw}`,
        index,
      };
    });
  }

  async listModels() {
    try {
      const data = await this.requestJson({
        url: joinUrl(this.baseUrl, '/sdapi/v1/sd-models'),
        method: 'GET',
        headers: this.authHeaders(),
      });
      if (Array.isArray(data)) {
        return data.map(item => String(item?.model_name || item?.title || item?.name || '').trim()).filter(Boolean);
      }
    } catch {}
    return [this.model || 'default'];
  }
}

// ComfyUI 校验不通过时回 400 + { error, node_errors }；整理成「节点 id（类型）：原因」，看得出是哪个参数不对。
const formatComfyUIPromptError = (status, body) => {
  const raw = String(body || '').trim();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}
  if (!data?.error) return `comfyui API Error: ${status}${raw ? ` - ${raw.slice(0, 500)}` : ''}`;
  const clip = text => String(text || '').trim().slice(0, 300);
  const nodeLines = Object.entries(data.node_errors || {}).flatMap(([nodeId, node]) => (
    (Array.isArray(node?.errors) ? node.errors : []).map(error => (
      `节点 ${nodeId}（${node?.class_type || '?'}）：${clip(error?.details || error?.message)}`
    ))
  ));
  const summary = nodeLines.length
    ? nodeLines.join('；')
    : `${clip(data.error.message)}${data.error.details ? `（${clip(data.error.details)}）` : ''}`;
  return `ComfyUI 拒绝了工作流（HTTP ${status}）：${summary}`;
};

export class ComfyUIImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'comfyui',
      baseUrl: config.baseUrl || 'http://127.0.0.1:8188',
      model: config.model || 'workflow',
    });
  }

  buildWorkflow(prompt, options = {}) {
    const raw = String(options.workflowJson || options.workflow_json || '').trim();
    if (!raw) {
      throw new Error('ComfyUI 需要先在图片生成参数中填写 API Format workflow JSON');
    }
    // 模型栏默认是占位的 workflow；工作流用 %model% 时会被当成模型名，ComfyUI 校验回 400。
    const model = String(this.model || '').trim();
    if (raw.includes('%model%') && (!model || model === 'workflow')) {
      throw new Error('ComfyUI 工作流用了 %model%，请先在图片 API 配置的模型栏选择 ComfyUI 里的模型');
    }
    const seed = toRandomSeed(options.seed);
    const replacements = {
      prompt,
      negative_prompt: String(options.negativePrompt || options.negative_prompt || ''),
      seed,
      model: this.model || '',
      sampler: options.sampler || '',
      scheduler: options.scheduler || '',
      steps: hasValue(options.steps) ? toInt(options.steps, 20, { min: 1, max: 150 }) : 20,
      scale: hasValue(options.scale) ? toNumber(options.scale, 7, { min: 0, max: 30 }) : 7,
      width: hasValue(options.width) ? toInt(options.width, 1024, { min: 64, max: 4096 }) : 1024,
      height: hasValue(options.height) ? toInt(options.height, 1024, { min: 64, max: 4096 }) : 1024,
    };
    let text = raw;
    Object.entries(replacements).forEach(([key, value]) => {
      text = text.replaceAll(`"%${key}%"`, JSON.stringify(value));
      text = text.replaceAll(`%${key}%`, String(value));
    });
    const parsed = JSON.parse(text);
    return parsed?.prompt && typeof parsed.prompt === 'object' ? parsed.prompt : parsed;
  }

  async generateImage(prompt, options = {}) {
    const { signal, onPreview } = options || {};
    const workflow = this.buildWorkflow(String(prompt || '').trim(), options);
    // 有人要看过程：先开预览连线，/prompt 带同一个 client_id，服务端就把步数与预览图推过来
    const clientId = typeof onPreview === 'function' ? `omnitavern-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}` : '';
    const preview = clientId ? openComfyUIPreviewSocket({ baseUrl: this.baseUrl, clientId, onPreview }) : null;
    try {
      const watching = preview ? await preview.ready : false;
      return await this.runWorkflow(workflow, { signal, clientId: watching ? clientId : '', preview });
    } finally {
      preview?.close();
    }
  }

  async runWorkflow(workflow, { signal, clientId = '', preview = null } = {}) {
    const queuedRes = await this.request({
      url: joinUrl(this.baseUrl, '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientId ? { prompt: workflow, client_id: clientId } : { prompt: workflow }),
      signal,
    });
    if (!queuedRes.ok) throw new Error(formatComfyUIPromptError(queuedRes.status, queuedRes.body));
    let queued = null;
    try {
      queued = JSON.parse(queuedRes.body || '{}');
    } catch (err) {
      throw new Error(`comfyui API returned invalid JSON: ${err.message}`);
    }
    const promptId = String(queued?.prompt_id || '').trim();
    if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');
    preview?.setPromptId(promptId);

    const startedAt = Date.now();
    let item = null;
    while (Date.now() - startedAt < this.timeout) {
      const history = await this.requestJson({
        url: joinUrl(this.baseUrl, `/history/${encodeURIComponent(promptId)}`),
        method: 'GET',
        signal,
      });
      item = history?.[promptId];
      if (item) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!item) throw new Error('ComfyUI 生成超时');
    if (item?.status?.status_str === 'error') {
      throw new Error('ComfyUI 生成失败');
    }
    const outputs = Object.values(item.outputs || {});
    const image = outputs.flatMap(output => output?.images || output?.gifs || [])[0];
    if (!image?.filename) throw new Error('ComfyUI 未返回图片输出');
    const url = new URL(joinUrl(this.baseUrl, '/view'));
    url.searchParams.set('filename', image.filename);
    if (image.subfolder) url.searchParams.set('subfolder', image.subfolder);
    if (image.type) url.searchParams.set('type', image.type);
    const res = await this.request({
      url: url.toString(),
      method: 'GET',
      signal,
      responseBase64: true,
    });
    if (!res.ok) throw new Error(`ComfyUI 图片下载失败: HTTP ${res.status}`);
    const mime = mimeFromFormat(String(image.filename || '').split('.').pop() || 'png');
    return [{ dataUrl: `data:${mime};base64,${res.body}`, index: 0 }];
  }

  async listModels() {
    try {
      const data = await this.requestJson({ url: joinUrl(this.baseUrl, '/object_info'), method: 'GET' });
      const ckpts = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      const unets = data?.UNETLoader?.input?.required?.unet_name?.[0] || [];
      return [...ckpts, ...unets].map(item => String(item || '').trim()).filter(Boolean);
    } catch {}
    return [this.model || 'workflow'];
  }
}
