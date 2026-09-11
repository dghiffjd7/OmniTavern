import { createLinkedAbortController, invokeNativeHttpRequest } from '../abort.js';
import { prepareTransportRequest } from '../transport.js';
import { safeInvoke } from '../../utils/tauri.js';
import {
  NOVELAI_IMAGE_MODEL_CACHE_KEY,
  NOVELAI_IMAGE_MODEL_CATALOG_URLS,
  resolveNovelAIImageModelCatalog,
} from './novelai-image-model-catalog.js';

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
            body: typeof body === 'string' ? body : body == null ? null : String(body),
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
        body,
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

export class NovelAIImageProvider extends ImageProviderBase {
  constructor(config = {}) {
    super({
      ...config,
      provider: 'novelai',
      baseUrl: config.baseUrl || 'https://image.novelai.net',
      model: config.model || 'nai-diffusion-4-5-full',
    });
    this.lastModelCatalogSource = 'bundled';
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

  async generateImage(prompt, options = {}) {
    const { signal } = options || {};
    if (!this.apiKey) throw new Error('缺少 NovelAI Access Token');
    const payload = this.buildPayload(prompt, options);
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
    const { signal } = options || {};
    const workflow = this.buildWorkflow(String(prompt || '').trim(), options);
    const queued = await this.requestJson({
      url: joinUrl(this.baseUrl, '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });
    const promptId = String(queued?.prompt_id || '').trim();
    if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');

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
