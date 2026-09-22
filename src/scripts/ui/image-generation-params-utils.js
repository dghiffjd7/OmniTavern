const toKey = (value) => String(value || '').trim().toLowerCase();

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clampInt = (value, min, max, fallback) => {
  const raw = Math.trunc(Number(value));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
};

const clampNumber = (value, min, max, fallback) => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
};

const optionValues = (field) => new Set((field?.options || []).map(item => String(item.value)));
const AUTO_OPTION_OMIT_KEYS = new Set(['quality', 'size', 'background', 'moderation']);

export const normalizeImageGenerationSize = (value) => String(value ?? '').trim().toLowerCase()
  .replace(/[×✖*]/g, 'x').replace(/\s+/g, '') || 'auto';

export const getImageGenerationSizeError = (value) => {
  const size = normalizeImageGenerationSize(value);
  if (size === 'auto') return '';
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return '请填写宽 × 高，例如 3840 × 2160。';
  const width = Number(match[1]), height = Number(match[2]);
  if (width <= 0 || height <= 0 || width % 16 || height % 16) return '宽和高须为 16 的正整数倍。';
  if (width > 3840 || height > 3840) return '每条边最多 3840 像素。';
  if (Math.max(width, height) > Math.min(width, height) * 3) return '长边与短边的比例最多为 3:1。';
  if (width * height < 655360 || width * height > 8294400) return '总像素须在 655,360 到 8,294,400 之间。';
  return '';
};

const makeSelect = (key, label, options, fallback, help = '') => ({
  key,
  label,
  type: 'select',
  options,
  defaultValue: fallback,
  help,
});

const makeNumber = (key, label, { min, max, step = 1, fallback, help = '', integer = true } = {}) => ({
  key,
  label,
  type: 'number',
  min,
  max,
  step,
  defaultValue: fallback,
  integer,
  help,
});

const makeText = (key, label, fallback = '', help = '') => ({
  key,
  label,
  type: 'text',
  defaultValue: fallback,
  help,
});

const makeTextarea = (key, label, fallback = '', help = '') => ({
  key,
  label,
  type: 'textarea',
  defaultValue: fallback,
  help,
});

const makeFixedNegativePromptField = () => ({
  ...makeTextarea(
    'negativePrompt',
    '固定负面提示词',
    '',
    '随当前参数预设保存；打开生图弹窗时会自动带入，弹窗中的编辑只覆盖本次生成。',
  ),
  badge: '随预设保存',
  placeholder: '例如：low quality, blurry, bad hands…',
  fullWidth: true,
  variant: 'persistent-negative',
});

const BOOLEAN_OPTIONS = [
  { value: '', label: '关闭', i18nContext: 'image-boolean' },
  { value: 'true', label: '开启', i18nContext: 'image-boolean' },
];

const NOVELAI_LEGACY_DEFAULTS = {
  steps: 28,
  scale: 9,
  sampler: 'k_dpmpp_2m',
};

const NOVELAI_DEFAULTS = {
  promptPrefix: '',
  promptSuffix: '',
  width: 1024,
  height: 1024,
  steps: 23,
  scale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  scheduler: 'karras',
  negativePrompt: '',
  seed: '',
  qualityToggle: 'true',
  sm: '',
  sm_dyn: '',
  decrisper: '',
};

export const IMAGE_GENERATION_PARAM_STORE_KEY = 'image_generation_params_v1';

export const DEFAULT_IMAGE_GENERATION_PRESET_ID = 'default';

export const createDefaultImageGenerationPreset = () => ({
  id: DEFAULT_IMAGE_GENERATION_PRESET_ID,
  name: '默认图片参数',
  paramsByProvider: {
    openai: {
      n: 1,
      quality: 'auto',
      size: 'auto',
      output_format: 'png',
      output_compression: 100,
      background: 'auto',
      moderation: 'auto',
      response_format: '',
      style: '',
    },
    makersuite: {
      n: 1,
      aspectRatio: '1:1',
      negativePrompt: '',
      responseMimeType: 'image/png',
      outputCompression: 100,
    },
    vertexai: {
      n: 1,
      aspectRatio: '1:1',
      negativePrompt: '',
      responseMimeType: 'image/png',
      outputCompression: 100,
    },
    custom: {
      n: 1,
      size: '',
      quality: '',
      style: '',
      response_format: '',
      seed: '',
    },
    novelai: {
      ...NOVELAI_DEFAULTS,
    },
    stability: {
      aspectRatio: '1:1',
      output_format: 'png',
      style_preset: '',
      negativePrompt: '',
      seed: '',
    },
    togetherai: {
      n: 1,
      width: 1024,
      height: 1024,
      steps: 4,
      guidance_scale: 3.5,
      negativePrompt: '',
      seed: '',
      response_format: '',
      output_format: 'png',
      disable_safety_checker: '',
    },
    pollinations: {
      width: 1024,
      height: 1024,
      negativePrompt: '',
      seed: '',
      enhance: '',
    },
    automatic1111: {
      n: 1,
      width: 1024,
      height: 1024,
      steps: 20,
      cfg_scale: 7,
      sampler_name: '',
      scheduler: '',
      negativePrompt: '',
      seed: '',
      restore_faces: '',
      enable_hr: '',
    },
    comfyui: {
      width: 1024,
      height: 1024,
      steps: 20,
      scale: 7,
      sampler: '',
      scheduler: '',
      negativePrompt: '',
      seed: '',
      workflowJson: '',
    },
  },
});

export const normalizeImageProviderKey = (provider = '') => {
  const p = toKey(provider);
  if (p === 'gemini') return 'makersuite';
  if (p === 'vertexai') return 'vertexai';
  if (p === 'openai') return 'openai';
  if (p === 'custom') return 'custom';
  if (p === 'novel' || p === 'novelai') return 'novelai';
  if (p === 'stability' || p === 'stabilityai') return 'stability';
  if (p === 'together' || p === 'togetherai') return 'togetherai';
  if (p === 'pollinations') return 'pollinations';
  if (p === 'automatic1111' || p === 'a1111' || p === 'auto') return 'automatic1111';
  if (p === 'comfy' || p === 'comfyui') return 'comfyui';
  return p || 'custom';
};

export const resolveImageNegativePromptCapability = (config = {}) => {
  const provider = normalizeImageProviderKey(config?.provider);
  const model = toKey(config?.model);
  const supported = (help = '生成时可填写本次负面提示词。') => ({
    supported: true,
    key: 'negativePrompt',
    label: '负面提示词',
    help,
  });
  const unsupported = (reason = '当前图片模型不支持负面提示词。') => ({
    supported: false,
    key: 'negativePrompt',
    label: '负面提示词',
    reason,
  });

  if (provider === 'makersuite' || provider === 'vertexai') {
    const isImagen = model.includes('imagen') || model.startsWith('imagegeneration');
    return isImagen
      ? supported('Google Imagen 链路会传递 negativePrompt。')
      : unsupported('当前 Gemini 图片链路未接入独立负面提示词参数。');
  }
  if ([
    'novelai',
    'stability',
    'togetherai',
    'pollinations',
    'automatic1111',
    'comfyui',
  ].includes(provider)) {
    return supported();
  }
  return unsupported();
};

const resolveImageProviderParamSchema = (config = {}) => {
  const provider = normalizeImageProviderKey(config?.provider);
  const model = toKey(config?.model);

  if (provider === 'openai') {
    const isGptImage = model.startsWith('gpt-image');
    // OpenAI Docs: Image 2.5 Sunburst/Flare add xhigh and max, including dated snapshots.
    // /models does not expose parameter capabilities; keep this rule model-specific.
    const hasExtendedQuality = /^gpt-image-2\.5-(?:sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    const hasCustomSize = hasExtendedQuality || /^gpt-image-2(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    const isDalle3 = model.includes('dall-e-3');
    const isDalle2 = model.includes('dall-e-2');
    if (isGptImage) {
      return {
        provider,
        model,
        title: 'OpenAI GPT Image 参数',
        fields: [
          makeNumber('n', '生成张数', { min: 1, max: 10, fallback: 1, help: '多数入口只会使用第一张图；保留多张用于后续扩展。' }),
          makeSelect('quality', '质量', [
            { value: 'auto', label: '自动' },
            { value: 'low', label: '低' },
            { value: 'medium', label: '中' },
            { value: 'high', label: '高' },
            ...(hasExtendedQuality ? [
              { value: 'xhigh', label: '超高（xhigh）' },
              { value: 'max', label: '最高（max）' },
            ] : []),
          ], 'auto', '质量越高，延迟和成本通常越高。'),
          { ...makeSelect('size', '尺寸', [
            { value: 'auto', label: '自动' },
            { value: '1024x1024', label: '1024 x 1024' },
            { value: '1536x1024', label: '1536 x 1024' },
            { value: '1024x1536', label: '1024 x 1536' },
            ...(hasCustomSize ? [
              { value: '2048x2048', label: '2K 方图 · 2048 × 2048' },
              { value: '2048x1152', label: '2K 横图 · 2048 × 1152' },
              { value: '1152x2048', label: '2K 竖图 · 1152 × 2048' },
              { value: '3840x2160', label: '4K 横图 · 3840 × 2160' },
              { value: '2160x3840', label: '4K 竖图 · 2160 × 3840' },
            ] : []),
          ], 'auto', hasCustomSize ? '可选择常用尺寸或自定义宽 × 高；边长须为 16 的倍数，最多 3840 像素，长宽比介于 1:3 到 3:1，总像素为 655,360 到 8,294,400。超过 2560 × 1440 总像素的输出属于实验性功能。' : ''),
          type: hasCustomSize ? 'image-size' : 'select' },
          makeSelect('output_format', '输出格式', [
            { value: 'png', label: 'PNG' },
            { value: 'jpeg', label: 'JPEG' },
            { value: 'webp', label: 'WebP' },
          ], 'png'),
          makeNumber('output_compression', '压缩质量', { min: 0, max: 100, fallback: 100, help: '仅 JPEG/WebP 适用。' }),
          makeSelect('background', '背景', [
            { value: 'auto', label: '自动' },
            { value: 'opaque', label: '不透明' },
            { value: 'transparent', label: '透明' },
          ], 'auto', '透明背景使用 PNG 或 WebP；选择透明时 JPEG 会切换为 PNG。'),
          makeSelect('moderation', '审核强度', [
            { value: 'auto', label: '自动' },
            { value: 'low', label: '低' },
          ], 'auto'),
        ],
      };
    }
    if (isDalle3) {
      return {
        provider,
        model,
        title: 'OpenAI DALL·E 3 参数',
        fields: [
          makeNumber('n', '生成张数', { min: 1, max: 1, fallback: 1 }),
          makeSelect('quality', '质量', [
            { value: '', label: '默认' },
            { value: 'standard', label: 'standard' },
            { value: 'hd', label: 'hd' },
          ], ''),
          makeSelect('size', '尺寸', [
            { value: '', label: '默认' },
            { value: '1024x1024', label: '1024 x 1024' },
            { value: '1792x1024', label: '1792 x 1024' },
            { value: '1024x1792', label: '1024 x 1792' },
          ], ''),
          makeSelect('style', '风格', [
            { value: '', label: '默认' },
            { value: 'vivid', label: 'vivid' },
            { value: 'natural', label: 'natural' },
          ], ''),
          makeSelect('response_format', '返回格式', [
            { value: '', label: '默认' },
            { value: 'url', label: 'URL' },
            { value: 'b64_json', label: 'Base64' },
          ], ''),
        ],
      };
    }
    return {
      provider,
      model,
      title: isDalle2 ? 'OpenAI DALL·E 2 参数' : 'OpenAI 图片参数',
      fields: [
        makeNumber('n', '生成张数', { min: 1, max: 10, fallback: 1 }),
        makeSelect('size', '尺寸', [
          { value: '', label: '默认' },
          { value: '256x256', label: '256 x 256' },
          { value: '512x512', label: '512 x 512' },
          { value: '1024x1024', label: '1024 x 1024' },
        ], ''),
        makeSelect('response_format', '返回格式', [
          { value: '', label: '默认' },
          { value: 'url', label: 'URL' },
          { value: 'b64_json', label: 'Base64' },
        ], ''),
      ],
    };
  }

  if (provider === 'makersuite' || provider === 'vertexai') {
    const isImagen = model.includes('imagen') || model.startsWith('imagegeneration');
    return {
      provider,
      model,
      title: isImagen ? 'Google Imagen 参数' : 'Gemini 图片参数',
      fields: [
        ...(isImagen ? [makeFixedNegativePromptField()] : []),
        makeNumber('n', '生成张数', { min: 1, max: 8, fallback: 1 }),
        makeSelect('aspectRatio', '比例', [
          { value: '1:1', label: '1:1' },
          { value: '3:4', label: '3:4' },
          { value: '4:3', label: '4:3' },
          { value: '9:16', label: '9:16' },
          { value: '16:9', label: '16:9' },
        ], '1:1'),
        makeSelect('responseMimeType', '输出格式', [
          { value: 'image/png', label: 'PNG' },
          { value: 'image/jpeg', label: 'JPEG' },
          { value: 'image/webp', label: 'WebP' },
        ], 'image/png'),
        makeNumber('outputCompression', '压缩质量', { min: 1, max: 100, fallback: 100, help: 'Imagen 预测链路使用；其他模型可能忽略。' }),
      ],
    };
  }

  if (provider === 'novelai') {
    return {
      provider,
      model,
      title: 'NovelAI Diffusion 参数',
      fields: [
        makeFixedNegativePromptField(),
        makeNumber('width', '宽度', { min: 64, max: 2048, step: 64, fallback: 1024 }),
        makeNumber('height', '高度', { min: 64, max: 2048, step: 64, fallback: 1024 }),
        makeNumber('steps', '步数', { min: 1, max: 50, fallback: 23 }),
        makeNumber('scale', 'Prompt Guidance / Scale', { min: 0, max: 30, step: 0.5, fallback: 5, integer: false }),
        makeNumber('cfgRescale', 'Prompt Guidance Rescale', { min: 0, max: 1, step: 0.05, fallback: 0, integer: false, help: '高 Prompt Guidance 时可缓解过饱和和伪影；0 表示关闭。' }),
        makeSelect('sampler', '采样器', [
          { value: 'k_euler_ancestral', label: 'k_euler_ancestral' },
          { value: 'k_euler', label: 'k_euler' },
          { value: 'k_dpmpp_2m', label: 'k_dpmpp_2m' },
          { value: 'k_dpmpp_sde', label: 'k_dpmpp_sde' },
          { value: 'k_dpmpp_2s_ancestral', label: 'k_dpmpp_2s_ancestral' },
          { value: 'k_dpm_fast', label: 'k_dpm_fast' },
          { value: 'ddim', label: 'ddim' },
        ], 'k_euler_ancestral'),
        makeSelect('scheduler', '噪声调度', [
          { value: 'karras', label: 'karras' },
          { value: 'native', label: 'native' },
          { value: 'exponential', label: 'exponential' },
          { value: 'polyexponential', label: 'polyexponential' },
        ], 'karras'),
        makeText('seed', 'Seed', '', '留空或 -1 则随机；固定 seed 请填 0 或正整数。'),
        makeSelect('qualityToggle', 'Quality Tags Enabled', BOOLEAN_OPTIONS, 'true', '开启后由 NovelAI 追加模型对应质量标签；如提示词已手写大量质量词，可关闭。'),
        makeSelect('sm', 'SMEA', BOOLEAN_OPTIONS, ''),
        makeSelect('sm_dyn', 'SMEA DYN', BOOLEAN_OPTIONS, ''),
        makeSelect('decrisper', 'Decrisper', BOOLEAN_OPTIONS, ''),
      ],
    };
  }

  if (provider === 'stability') {
    return {
      provider,
      model,
      title: 'Stability AI 参数',
      fields: [
        makeFixedNegativePromptField(),
        makeSelect('aspectRatio', '比例', [
          { value: '1:1', label: '1:1' },
          { value: '16:9', label: '16:9' },
          { value: '9:16', label: '9:16' },
          { value: '4:3', label: '4:3' },
          { value: '3:4', label: '3:4' },
          { value: '3:2', label: '3:2' },
          { value: '2:3', label: '2:3' },
          { value: '21:9', label: '21:9' },
          { value: '9:21', label: '9:21' },
        ], '1:1'),
        makeSelect('output_format', '输出格式', [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
        ], 'png'),
        makeSelect('style_preset', '风格预设', [
          { value: '', label: '不传' },
          { value: '3d-model', label: '3d-model' },
          { value: 'analog-film', label: 'analog-film' },
          { value: 'anime', label: 'anime' },
          { value: 'cinematic', label: 'cinematic' },
          { value: 'comic-book', label: 'comic-book' },
          { value: 'digital-art', label: 'digital-art' },
          { value: 'fantasy-art', label: 'fantasy-art' },
          { value: 'isometric', label: 'isometric' },
          { value: 'line-art', label: 'line-art' },
          { value: 'low-poly', label: 'low-poly' },
          { value: 'modeling-compound', label: 'modeling-compound' },
          { value: 'neon-punk', label: 'neon-punk' },
          { value: 'origami', label: 'origami' },
          { value: 'photographic', label: 'photographic' },
          { value: 'pixel-art', label: 'pixel-art' },
          { value: 'tile-texture', label: 'tile-texture' },
        ], ''),
        makeText('seed', 'Seed', '', '留空或 -1 则由服务商随机；固定 seed 请填 0 或正整数。'),
      ],
    };
  }

  if (provider === 'togetherai') {
    return {
      provider,
      model,
      title: 'Together AI 图片参数',
      fields: [
        makeFixedNegativePromptField(),
        makeNumber('n', '生成张数', { min: 1, max: 4, fallback: 1 }),
        makeNumber('width', '宽度', { min: 128, max: 2048, step: 64, fallback: 1024 }),
        makeNumber('height', '高度', { min: 128, max: 2048, step: 64, fallback: 1024 }),
        makeNumber('steps', '步数', { min: 1, max: 100, fallback: 4 }),
        makeNumber('guidance_scale', 'Guidance Scale', { min: 0, max: 30, step: 0.1, fallback: 3.5, integer: false }),
        makeText('seed', 'Seed', '', '留空或 -1 则不传 seed；固定 seed 请填 0 或正整数。'),
        makeSelect('response_format', '返回格式', [
          { value: '', label: '默认' },
          { value: 'base64', label: 'Base64' },
          { value: 'url', label: 'URL' },
        ], ''),
        makeSelect('output_format', '输出格式', [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
        ], 'png'),
        makeSelect('disable_safety_checker', '关闭安全检查', BOOLEAN_OPTIONS, ''),
      ],
    };
  }

  if (provider === 'pollinations') {
    return {
      provider,
      model,
      title: 'Pollinations 参数',
      fields: [
        makeFixedNegativePromptField(),
        makeNumber('width', '宽度', { min: 64, max: 4096, step: 64, fallback: 1024 }),
        makeNumber('height', '高度', { min: 64, max: 4096, step: 64, fallback: 1024 }),
        makeText('seed', 'Seed', '', '留空或 -1 则不传 seed；固定 seed 请填 0 或正整数。'),
        makeSelect('enhance', '增强提示词', BOOLEAN_OPTIONS, ''),
      ],
    };
  }

  if (provider === 'automatic1111') {
    return {
      provider,
      model,
      title: 'AUTOMATIC1111 参数',
      fields: [
        makeFixedNegativePromptField(),
        makeNumber('n', '生成张数', { min: 1, max: 8, fallback: 1 }),
        makeNumber('width', '宽度', { min: 64, max: 4096, step: 64, fallback: 1024 }),
        makeNumber('height', '高度', { min: 64, max: 4096, step: 64, fallback: 1024 }),
        makeNumber('steps', '步数', { min: 1, max: 150, fallback: 20 }),
        makeNumber('cfg_scale', 'CFG Scale', { min: 0, max: 30, step: 0.5, fallback: 7, integer: false }),
        makeText('sampler_name', '采样器', '', '例如 Euler a、DPM++ 2M Karras；留空则使用服务端默认。'),
        makeText('scheduler', '调度器', '', '仅在你的 WebUI 版本支持时传递。'),
        makeText('seed', 'Seed', '', '留空或 -1 则随机；A1111 会保留 -1。固定 seed 请填 0 或正整数。'),
        makeSelect('restore_faces', '面部修复', BOOLEAN_OPTIONS, ''),
        makeSelect('enable_hr', 'Highres Fix', BOOLEAN_OPTIONS, ''),
      ],
    };
  }

  if (provider === 'comfyui') {
    return {
      provider,
      model,
      title: 'ComfyUI 参数',
      fields: [
        makeFixedNegativePromptField(),
        makeNumber('width', '宽度', { min: 64, max: 4096, step: 64, fallback: 1024 }),
        makeNumber('height', '高度', { min: 64, max: 4096, step: 64, fallback: 1024 }),
        makeNumber('steps', '步数', { min: 1, max: 150, fallback: 20 }),
        makeNumber('scale', 'CFG / Scale', { min: 0, max: 30, step: 0.5, fallback: 7, integer: false }),
        makeText('sampler', '采样器', ''),
        makeText('scheduler', '调度器', ''),
        makeText('seed', 'Seed', '', '留空或 -1 则随机；固定 seed 请填 0 或正整数。'),
        makeTextarea('workflowJson', 'Workflow JSON', '', '粘贴 ComfyUI 的 Save (API Format) JSON；可使用 "%prompt%"、"%negative_prompt%"、"%model%"、"%seed%"、"%width%"、"%height%"、"%steps%"、"%scale%" 等占位符。'),
      ],
    };
  }

  if (provider === 'custom') {
    return {
      provider,
      model,
      title: '自定义 OpenAI 兼容图片参数',
      fields: [
        makeNumber('n', '生成张数', { min: 1, max: 10, fallback: 1 }),
        makeText('size', '尺寸', '', '例如 1024x1024；留空则不传。'),
        makeText('quality', '质量', '', '仅在你的兼容端点支持时填写。'),
        makeText('style', '风格', '', '仅在你的兼容端点支持时填写。'),
        makeText('seed', 'Seed', '', '留空或 -1 则不传 seed；固定 seed 请填 0 或正整数。'),
        makeSelect('response_format', '返回格式', [
          { value: '', label: '不传' },
          { value: 'url', label: 'URL' },
          { value: 'b64_json', label: 'Base64' },
        ], ''),
      ],
    };
  }

  return {
    provider,
    model,
    title: '图片生成参数',
    fields: [
      makeNumber('n', '生成张数', { min: 1, max: 4, fallback: 1 }),
    ],
  };
};

export const resolveImageGenerationParamSchema = (config = {}) => {
  const schema = resolveImageProviderParamSchema(config);
  const fixedPositive = [
    { ...makeTextarea('promptPrefix', '固定正向前缀', '', '随当前参数预设保存，放在正向开头；生图输入框中可修改为本次覆盖。'), fullWidth: true, badge: '随预设保存' },
    { ...makeTextarea('promptSuffix', '固定正向后缀', '', '随当前参数预设保存，放在正向末尾；生图输入框中可修改为本次覆盖。'), fullWidth: true, badge: '随预设保存' },
  ];
  return { ...schema, fields: [...fixedPositive, ...schema.fields] };
};

export const normalizeImageGenerationPreset = (preset = {}) => {
  const fallback = createDefaultImageGenerationPreset();
  const source = isObject(preset) ? preset : {};
  const id = String(source.id || fallback.id).trim() || fallback.id;
  const sourceParamsByProvider = isObject(source.paramsByProvider) ? source.paramsByProvider : {};
  const paramsByProvider = {
    ...fallback.paramsByProvider,
    ...sourceParamsByProvider,
  };
  if (isObject(paramsByProvider.novelai)) {
    const sourceNovel = isObject(sourceParamsByProvider.novelai) ? sourceParamsByProvider.novelai : {};
    const nextNovel = { ...paramsByProvider.novelai };
    if (id === DEFAULT_IMAGE_GENERATION_PRESET_ID) {
      if (Number(nextNovel.steps) === NOVELAI_LEGACY_DEFAULTS.steps) nextNovel.steps = NOVELAI_DEFAULTS.steps;
      if (Number(nextNovel.scale) === NOVELAI_LEGACY_DEFAULTS.scale) nextNovel.scale = NOVELAI_DEFAULTS.scale;
      if (String(nextNovel.sampler || '') === NOVELAI_LEGACY_DEFAULTS.sampler) nextNovel.sampler = NOVELAI_DEFAULTS.sampler;
    }
    if (!Object.hasOwn(sourceNovel, 'cfgRescale')) nextNovel.cfgRescale = NOVELAI_DEFAULTS.cfgRescale;
    if (!Object.hasOwn(sourceNovel, 'qualityToggle')) nextNovel.qualityToggle = NOVELAI_DEFAULTS.qualityToggle;
    if (!Object.hasOwn(sourceNovel, 'promptPrefix')) nextNovel.promptPrefix = NOVELAI_DEFAULTS.promptPrefix;
    if (!Object.hasOwn(sourceNovel, 'promptSuffix')) nextNovel.promptSuffix = NOVELAI_DEFAULTS.promptSuffix;
    paramsByProvider.novelai = nextNovel;
  }
  return {
    id,
    name: String(source.name || fallback.name).trim() || fallback.name,
    paramsByProvider,
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now(),
  };
};

export const syncImageGenerationOutputControls = (root) => {
  const background = root?.querySelector('[data-param-key="background"]');
  const format = root?.querySelector('[data-param-key="output_format"]');
  if (!background || !format) return;
  const transparent = background.value === 'transparent';
  const jpeg = format.querySelector('option[value="jpeg"]');
  if (jpeg) jpeg.disabled = transparent;
  if (transparent && format.value === 'jpeg') format.value = 'png';
  const compression = root.querySelector('[data-param-key="output_compression"]');
  if (compression) compression.disabled = format.value === 'png';
};

export const sanitizeImageGenerationParams = (params = {}, config = {}) => {
  const schema = resolveImageGenerationParamSchema(config);
  const raw = isObject(params) ? params : {};
  const out = {};
  schema.fields.forEach((field) => {
    const value = raw[field.key];
    if (field.type === 'image-size') {
      const size = normalizeImageGenerationSize(value);
      const error = getImageGenerationSizeError(size);
      if (error) throw new Error(error);
      if (size !== 'auto') out[field.key] = size;
      return;
    }
    if (field.type === 'number') {
      const safe = field.integer === false
        ? clampNumber(value, field.min ?? -Number.MAX_SAFE_INTEGER, field.max ?? Number.MAX_SAFE_INTEGER, field.defaultValue ?? 0)
        : clampInt(value, field.min ?? Number.MIN_SAFE_INTEGER, field.max ?? Number.MAX_SAFE_INTEGER, field.defaultValue ?? 0);
      if (Number.isFinite(safe)) out[field.key] = safe;
      return;
    }
    if (field.type === 'select') {
      const safe = String(value ?? field.defaultValue ?? '');
      const values = optionValues(field);
      const next = values.has(safe) ? safe : String(field.defaultValue ?? '');
      if (next !== '') out[field.key] = next;
      if (AUTO_OPTION_OMIT_KEYS.has(field.key) && out[field.key] === 'auto') delete out[field.key];
      return;
    }
    const text = String(value ?? field.defaultValue ?? '').trim();
    if (text) out[field.key] = text;
  });

  if (out.background === 'transparent' && out.output_format === 'jpeg') out.output_format = 'png';
  if (out.output_format && out.output_format === 'png') {
    delete out.output_compression;
  }
  if (out.responseMimeType && out.responseMimeType === 'image/png') {
    delete out.outputCompression;
  }
  if (schema.provider === 'novelai') {
    if (out.sampler === 'ddim') {
      delete out.sm;
      delete out.sm_dyn;
    } else if (!out.sm) {
      delete out.sm_dyn;
    }
  }
  return out;
};

export const getParamsForImageConfig = (preset = {}, config = {}) => {
  const normalized = normalizeImageGenerationPreset(preset);
  const provider = normalizeImageProviderKey(config?.provider);
  const params = normalized.paramsByProvider?.[provider] || {};
  return sanitizeImageGenerationParams(params, config);
};

export const resolveImageNegativePromptDraft = (initialPrompt = '', baseParams = {}) => {
  const initial = String(initialPrompt || '').trim();
  if (initial) return initial;
  return String(baseParams?.negativePrompt || baseParams?.negative_prompt || '').trim();
};

export const combineImageNegativePrompts = (fixedPrompt = '', perRunPrompt = '') => {
  const fixed = String(fixedPrompt || '').trim();
  const perRun = String(perRunPrompt || '').trim();
  if (!fixed) return perRun;
  if (!perRun) return fixed;
  if (perRun === fixed) return perRun;
  if (perRun.startsWith(fixed)) {
    const boundary = perRun.slice(fixed.length, fixed.length + 1);
    if ([',', '，', ';', '；', '\n'].includes(boundary)) return perRun;
  }
  if (/[,，;；]$/.test(fixed)) return `${fixed} ${perRun}`;
  return `${fixed}, ${perRun}`;
};

export const mergeImageGenerationRequestOptions = ({
  config = {},
  preset = null,
  overrides = {},
  extra = {},
  negativePromptMode = 'append',
} = {}) => {
  const base = preset ? getParamsForImageConfig(preset, config) : {};
  const merged = sanitizeImageGenerationParams({ ...base, ...(isObject(overrides) ? overrides : {}) }, config);
  const extraOptions = isObject(extra) ? { ...extra } : {};
  const hasExtraNegativePrompt = Object.prototype.hasOwnProperty.call(extraOptions, 'negativePrompt')
    || Object.prototype.hasOwnProperty.call(extraOptions, 'negative_prompt');
  const extraNegativePrompt = Object.prototype.hasOwnProperty.call(extraOptions, 'negativePrompt')
    ? extraOptions.negativePrompt
    : extraOptions.negative_prompt;
  const negativePrompt = negativePromptMode === 'replace' && hasExtraNegativePrompt
    ? String(extraNegativePrompt || '').trim()
    : combineImageNegativePrompts(
      merged.negativePrompt || merged.negative_prompt,
      extraNegativePrompt,
    );
  delete merged.negativePrompt;
  delete merged.negative_prompt;
  delete extraOptions.negativePrompt;
  delete extraOptions.negative_prompt;
  const options = {
    ...merged,
    ...extraOptions,
  };
  if (preset?.id) options.imagePromptParamsPresetId = preset.id;
  if (hasExtraNegativePrompt) options.imagePromptNegativeOverride = { value: String(extraNegativePrompt || ''), mode: negativePromptMode };
  if (overrides?.imagePromptDocument) options.imagePromptDocument = overrides.imagePromptDocument;
  if (negativePrompt) options.negativePrompt = negativePrompt;
  return options;
};
