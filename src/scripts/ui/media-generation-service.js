import { isNovelAIPreciseReferenceModel } from '../api/providers/novelai-image-model-catalog.js';
import { getWaveSpeedReferenceInput } from '../api/providers/wavespeed-model-catalog.js';

const DEFAULT_IMAGE_MIME = 'image/png';
const DEFAULT_GEMINI_REFERENCE_IMAGE_MAX = 3;
const DEFAULT_OPENAI_GPT_IMAGE_REFERENCE_IMAGE_MAX = 16;
const DEFAULT_CUSTOM_OPENAI_REFERENCE_IMAGE_MAX = 16;
// 还没拉过 WaveSpeed 模型列表、不知道当前模型能带几张时先按这个算；生成前渠道会按参数表再检查
const DEFAULT_WAVESPEED_REFERENCE_IMAGE_MAX = 4;

const createId = (prefix = 'media') => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
};

const abortError = () => {
  const err = new Error('Image generation aborted');
  err.name = 'AbortError';
  return err;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError();
};

export const getImageMimeFromDataUrl = (dataUrl = '') => {
  const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : DEFAULT_IMAGE_MIME;
};

export const getImageExtensionFromMime = (mime = '') => {
  const raw = String(mime || '').toLowerCase();
  if (raw.includes('jpeg') || raw.includes('jpg')) return 'jpg';
  if (raw.includes('webp')) return 'webp';
  if (raw.includes('gif')) return 'gif';
  if (raw.includes('avif')) return 'avif';
  return 'png';
};

const readExplicitReferenceImageMax = (config = {}) => {
  const keys = [
    'referenceImageMax',
    'referenceImagesMax',
    'maxReferenceImages',
    'imageReferenceMax',
    'imageReferenceImagesMax',
  ];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue;
    const value = Number(config[key]);
    if (!Number.isFinite(value)) continue;
    return Math.max(0, Math.trunc(value));
  }
  return null;
};

/** params：当前生图参数（NovelAI 要看「精准参考」有没有打开）。 */
export const resolveImageReferenceCapability = (config = {}, params = null) => {
  const explicitMax = readExplicitReferenceImageMax(config || {});
  if (explicitMax === 0) {
    return {
      supported: false,
      max: 0,
      reason: '当前配置已关闭参考图输入',
      source: 'config',
    };
  }

  const provider = String(config?.provider || '').trim().toLowerCase();
  const model = String(config?.model || '').trim().toLowerCase();
  const unsupported = (reason) => ({
    supported: false,
    max: 0,
    reason,
    source: 'builtin',
  });

  if (provider === 'makersuite' || provider === 'gemini') {
    if (model.includes('imagen') || model.startsWith('imagegeneration')) {
      return unsupported('当前 Google Imagen 链路暂不支持参考图');
    }
    if (!model || model.includes('gemini') || model.includes('banana')) {
      const max = explicitMax !== null ? explicitMax : DEFAULT_GEMINI_REFERENCE_IMAGE_MAX;
      return {
        supported: max > 0,
        max,
        reason: max > 0
          ? `当前 Gemini 图片链路支持最多 ${max} 张参考图`
          : '当前配置已关闭参考图输入',
        source: explicitMax !== null ? 'config' : 'builtin',
      };
    }
    return unsupported('当前 Google 图片模型未标记为支持参考图');
  }

  if (provider === 'openai') {
    if (model.startsWith('gpt-image')) {
      const max = explicitMax !== null ? explicitMax : DEFAULT_OPENAI_GPT_IMAGE_REFERENCE_IMAGE_MAX;
      return {
        supported: max > 0,
        max,
        reason: max > 0
          ? `当前 OpenAI GPT Image 链路支持最多 ${max} 张参考图`
          : '当前配置已关闭参考图输入',
        source: explicitMax !== null ? 'config' : 'builtin',
      };
    }
    return unsupported('当前 OpenAI 图片模型暂不支持参考图');
  }

  if (provider === 'custom') {
    const max = explicitMax !== null ? explicitMax : DEFAULT_CUSTOM_OPENAI_REFERENCE_IMAGE_MAX;
    return {
      supported: max > 0,
      max,
      reason: max > 0
        ? `当前自定义 OpenAI 兼容图片链路支持最多 ${max} 张参考图`
        : '当前配置已关闭参考图输入',
      source: explicitMax !== null ? 'config' : 'builtin',
    };
  }

  if (provider === 'vertexai') {
    return unsupported('当前 Vertex AI 图片生成链路暂未接入参考图');
  }

  if (provider === 'wavespeed') {
    const input = getWaveSpeedReferenceInput({ baseUrl: config?.baseUrl, model: config?.model });
    if (input.known && !input.field) {
      return unsupported('当前 WaveSpeed 模型不能用参考图，请在设置里改选编辑模型（名称里通常带 edit）');
    }
    const modelMax = input.known ? input.max : DEFAULT_WAVESPEED_REFERENCE_IMAGE_MAX;
    const max = explicitMax !== null ? Math.min(explicitMax, modelMax) : modelMax;
    return {
      supported: max > 0,
      max,
      reason: input.known
        ? `当前 WaveSpeed 模型最多用 ${max} 张参考图`
        : 'WaveSpeed 能带几张参考图以所选模型为准，生成前会再检查',
      source: explicitMax !== null ? 'config' : 'builtin',
    };
  }

  if (provider === 'novelai') {
    if (!isNovelAIPreciseReferenceModel(model)) return unsupported('NovelAI 精准参考只支持 V4.5 模型');
    const mode = String(params?.preciseReference || 'off');
    if (mode === 'off') return unsupported('在 NAI 参数里打开「精准参考」后才会用参考图（每张图另扣 5 Anlas）');
    return { supported: true, max: 1, reason: 'NovelAI 精准参考只用第一张参考图（每张图另扣 5 Anlas）', source: 'builtin' };
  }

  if ([
    'stability',
    'togetherai',
    'pollinations',
    'automatic1111',
    'a1111',
    'comfyui',
    'comfy',
  ].includes(provider)) {
    return unsupported('当前图片渠道先接入文本生图，参考图链路暂未开放');
  }

  return unsupported('当前图片模型暂不支持参考图');
};

export const normalizeGeneratedImageResult = (item = {}) => {
  if (!item || typeof item !== 'object') return null;
  const dataUrl = String(item.dataUrl || item.data_url || '').trim();
  if (dataUrl.startsWith('data:image/')) {
    return {
      dataUrl,
      mime: getImageMimeFromDataUrl(dataUrl),
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : 0,
    };
  }
  const b64 = String(item.b64_json || item.b64 || item.base64 || '').trim();
  if (b64) {
    const mime = String(item.mime || item.mimeType || DEFAULT_IMAGE_MIME).trim() || DEFAULT_IMAGE_MIME;
    return {
      dataUrl: `data:${mime};base64,${b64}`,
      mime,
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : 0,
    };
  }
  const url = String(item.url || item.fileUri || item.file_uri || '').trim();
  if (url) {
    return {
      url,
      mime: String(item.mime || item.mimeType || '').trim(),
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : 0,
    };
  }
  return null;
};

const normalizeGenerationMetadataOptions = (options = {}) => {
  const out = {};
  Object.entries(options && typeof options === 'object' ? options : {}).forEach(([key, value]) => {
    if (key === 'signal') return;
    if (key === 'referenceImages' || key === 'reference_images') return;
    if (typeof value === 'function') return;
    if (value === undefined) return;
    out[key] = value;
  });
  return out;
};

const blobToDataUrl = async (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('read generated image failed'));
  reader.readAsDataURL(blob);
});

export const createMediaGenerationService = ({
  createClient,
  saveDataUrl,
  agentTaskRuntime = null,
  fetchFn = (...args) => fetch(...args),
  now = () => Date.now(),
  logger = console,
  preparePromptRequest = null,
  referenceStore = null,
} = {}) => {
  const fetchImageAsDataUrl = async (url, signal) => {
    const raw = String(url || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return '';
    throwIfAborted(signal);
    const response = await fetchFn(raw, { signal });
    if (!response?.ok) throw new Error(`图片下载失败：HTTP ${response?.status || 0}`);
    const blob = await response.blob();
    throwIfAborted(signal);
    return blobToDataUrl(blob);
  };

  const persistImage = async ({
    normalized,
    prompt,
    config,
    sessionId,
    signal,
    retainDataUrl = false,
    fileLabel = 'generated_image',
  }) => {
    throwIfAborted(signal);
    let dataUrl = normalized.dataUrl || '';
    let remoteUrl = normalized.url || '';
    let mime = normalized.mime || '';

    if (!dataUrl && remoteUrl) {
      try {
        dataUrl = await fetchImageAsDataUrl(remoteUrl, signal);
        mime = getImageMimeFromDataUrl(dataUrl) || mime;
      } catch (err) {
        logger?.warn?.('generated image url persistence failed; using remote url', err);
      }
    }

    let path = '';
    let bytes = 0;
    if (dataUrl && typeof saveDataUrl === 'function') {
      const ext = getImageExtensionFromMime(getImageMimeFromDataUrl(dataUrl) || mime);
      const fileName = `${fileLabel}_${now()}_${Number(normalized.index || 0) + 1}.${ext}`;
      const saved = await saveDataUrl(dataUrl, fileName, { sessionId, prompt, config });
      if (typeof saved === 'string') {
        path = saved;
      } else if (saved && typeof saved === 'object') {
        path = String(saved.path || '').trim();
        bytes = Number(saved.bytes || 0) || 0;
      }
    }

    return {
      path,
      url: path ? '' : remoteUrl,
      mime: mime || getImageMimeFromDataUrl(dataUrl),
      bytes,
      dataUrl: retainDataUrl ? dataUrl : '',
    };
  };

  const canRecordAgentTask = () => (
    agentTaskRuntime
    && typeof agentTaskRuntime.startRun === 'function'
    && typeof agentTaskRuntime.startStep === 'function'
    && typeof agentTaskRuntime.finishStep === 'function'
    && typeof agentTaskRuntime.finishRun === 'function'
  );

  const buildImageAgentOutput = (result = {}) => ({
    id: String(result?.id || '').trim(),
    provider: String(result?.provider || '').trim(),
    model: String(result?.model || '').trim(),
    path: String(result?.output?.path || '').trim(),
    url: String(result?.output?.url || '').trim(),
    status: String(result?.status || '').trim(),
  });

  const recordImageAgentTask = async ({
    prompt,
    config,
    sessionId,
    scope,
    task,
  }) => {
    if (!canRecordAgentTask()) return task();
    const provider = String(config?.provider || '').trim();
    const model = String(config?.model || '').trim();
    const run = agentTaskRuntime.startRun({
      kind: 'image_generation',
      title: 'Image generation',
      sessionId,
      surface: 'chat',
      trigger: 'image.generate',
      source: 'media-generation-service',
      summary: 'image generation started',
      metadata: {
        provider,
        model,
        scope: scope && typeof scope === 'object' ? scope : {},
      },
    });
    const step = run?.id ? agentTaskRuntime.startStep(run.id, {
      type: 'image.generate',
      title: 'Generate image',
      summary: 'generating image',
      input: {
        prompt,
        provider,
        model,
      },
    }) : null;
    try {
      const result = await task();
      const output = buildImageAgentOutput(result);
      if (run?.id && step?.id) {
        agentTaskRuntime.finishStep(run.id, step.id, {
          status: 'succeeded',
          output,
          summary: output.path || output.url ? 'image generated' : 'image generation succeeded',
        });
      }
      if (run?.id) {
        agentTaskRuntime.finishRun(run.id, {
          status: 'succeeded',
          summary: 'image generation succeeded',
        });
      }
      return result;
    } catch (err) {
      const status = err?.name === 'AbortError' ? 'cancelled' : 'failed';
      const message = err?.message ? String(err.message) : String(err || '');
      if (run?.id && step?.id) {
        agentTaskRuntime.finishStep(run.id, step.id, {
          status,
          errorMessage: message,
          summary: status === 'cancelled' ? 'image generation cancelled' : 'image generation failed',
        });
      }
      if (run?.id) {
        agentTaskRuntime.finishRun(run.id, {
          status,
          errorMessage: message,
          summary: status === 'cancelled' ? 'image generation cancelled' : 'image generation failed',
        });
      }
      throw err;
    }
  };

  const generateImage = async ({
    prompt,
    config,
    sessionId = '',
    scope = {},
    options = {},
    signal,
    agentTask = true,
    retainDataUrl = false,
    // 生成途中的中间画面（支持流式的渠道才会调用）：{ dataUrl, step, total }
    onPreview = null,
  } = {}) => {
    throwIfAborted(signal);
    let text = String(prompt || '').trim();
    if (typeof preparePromptRequest === 'function') {
      const prepared = await preparePromptRequest({ prompt: text, config, options });
      text = prepared.prompt;
      options = prepared.options;
    }
    if (!text) throw new Error('图片提示词为空');
    if (!config || typeof config !== 'object') throw new Error('图片生成配置为空');
    if (typeof createClient !== 'function') throw new Error('图片生成客户端未配置');
    throwIfAborted(signal);
    const referenceInputs = [...(options.referenceImages || options.reference_images || [])];

    // 记住最后一张中间图：生成失败（不是取消）时存成图片挂在错误上（error.partialImage），调用方显示在失败处
    let lastPreview = null;
    const watchPreview = typeof onPreview === 'function'
      ? (preview) => {
        if (preview?.dataUrl) lastPreview = preview;
        onPreview(preview);
      }
      : null;
    const keepPartialImage = async (error) => {
      if (!lastPreview || !error || typeof error !== 'object' || signal?.aborted || error.name === 'AbortError') return;
      try {
        const saved = await persistImage({
          normalized: { dataUrl: lastPreview.dataUrl, index: 0 },
          prompt: text,
          config,
          sessionId,
          fileLabel: 'generated_partial',
        });
        if (saved.path) {
          error.partialImage = { path: saved.path, mime: saved.mime, step: Number(lastPreview.step) || 0, total: Number(lastPreview.total) || 0 };
        }
      } catch (saveError) {
        logger?.warn?.('partial image persistence failed', saveError);
      }
    };

    const execute = async () => {
      const client = createClient(config);
      let images;
      try {
        images = await client.generateImage(text, {
          ...options,
          signal,
          ...(watchPreview ? { onPreview: watchPreview } : {}),
        });
      } catch (error) {
        await keepPartialImage(error);
        throw error;
      }
      throwIfAborted(signal);

      const normalized = (Array.isArray(images) ? images : [])
        .map(normalizeGeneratedImageResult)
        .find(Boolean);
      if (!normalized) throw new Error('图片模型未返回可用图片');

      const output = await persistImage({
        normalized,
        prompt: text,
        config,
        sessionId,
        signal,
        retainDataUrl,
      });
      throwIfAborted(signal);
      if (!output.path && !output.url && !output.dataUrl) {
        throw new Error('图片生成成功，但保存结果失败');
      }
      const generationParams = normalizeGenerationMetadataOptions(options);
      if (referenceInputs.length) {
        generationParams.referenceImages = referenceStore
          ? await referenceStore.persist(referenceInputs, sessionId)
          : referenceInputs;
      }
      throwIfAborted(signal);

      return {
        id: createId('image'),
        kind: 'image',
        provider: String(config.provider || '').trim(),
        model: String(config.model || '').trim(),
        prompt: text,
        negativePrompt: String(options.negativePrompt || options.negative_prompt || '').trim(),
        generationParams,
        output,
        status: 'succeeded',
        scope: {
          surface: 'chat',
          targetId: String(sessionId || '').trim(),
          ...(scope && typeof scope === 'object' ? scope : {}),
        },
        createdAt: now(),
      };
    };

    if (agentTask === false) return execute();
    return recordImageAgentTask({
      prompt: text,
      config,
      sessionId,
      scope,
      task: execute,
    });
  };

  return {
    generateImage,
  };
};
