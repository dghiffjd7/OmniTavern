// Structured image prompts. This module has no DOM, storage or network dependencies.
export const IMAGE_PROMPT_VERSION = 1;
export const IMAGE_PROMPT_DOCUMENT_KEY = 'imagePromptDocument';
export const IMAGE_PROMPT_TEXT_KEYS = ['promptPrefix', 'promptSuffix', 'negativePrompt', 'negative_prompt'];
const text = value => String(value ?? '').trim();
const providerKey = value => ({ gemini: 'makersuite', a1111: 'automatic1111', comfy: 'comfyui' }[text(value).toLowerCase()] || text(value).toLowerCase());
const copy = value => JSON.parse(JSON.stringify(value));
export const createImagePromptId = () => globalThis.crypto?.randomUUID?.() || `ip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const joinImagePromptNegativeTexts = parts => parts.map(text).filter(Boolean).reduce((result, part) => result ? `${result}${/[,，;；]$/.test(result) ? ' ' : ', '}${part}` : part, '');
export const createImagePromptBlock = (kind = 'character', values = {}) => ({
  id: createImagePromptId(), kind, name: '', text: '', enabled: true,
  provider: '', placement: 'before', negative: '', center: { x: 0.5, y: 0.5 }, ...values,
});
export const normalizeImagePromptDocument = (value = {}) => {
  if (Number(value?.version) > IMAGE_PROMPT_VERSION) throw new Error('图片提示词版本较新，请更新 App');
  const seen = new Set();
  const blocks = (Array.isArray(value?.blocks) ? value.blocks : []).filter(block => block && ['scene', 'character', 'style', 'negative'].includes(block.kind)).map((block, index) => {
    let id = text(block.id) || `block-${index}`;
    while (seen.has(id)) id += '-copy';
    seen.add(id);
    const center = block.center && typeof block.center === 'object' ? block.center : {};
    return {
      id, kind: block.kind, name: String(block.name ?? ''), text: String(block.text ?? ''), enabled: block.enabled !== false,
      provider: providerKey(block.provider), placement: block.placement === 'after' ? 'after' : 'before',
      negative: String(block.negative ?? ''),
      ...(IMAGE_PROMPT_TEXT_KEYS.includes(block.parameterKey) ? { parameterKey: block.parameterKey } : {}),
      center: { x: Number.isFinite(Number(center.x)) ? Math.min(1, Math.max(0, Number(center.x))) : 0.5, y: Number.isFinite(Number(center.y)) ? Math.min(1, Math.max(0, Number(center.y))) : 0.5 },
    };
  });
  if (!blocks.some(block => block.kind === 'scene')) {
    let id = 'scene'; while (seen.has(id)) id += '-copy';
    blocks.unshift({ ...createImagePromptBlock('scene'), id });
  }
  return { version: IMAGE_PROMPT_VERSION, positionMode: value?.positionMode === 'custom' ? 'custom' : 'auto', blocks };
};

export const resolveImagePromptCapabilities = (config = {}, options = {}) => {
  const provider = providerKey(config.provider), model = text(config.model).toLowerCase();
  const novelVersion = provider === 'novelai' ? (/^nai-diffusion-5(?:-|$)/.test(model) ? 5 : (!model || /^nai-diffusion-4(?:-|$)/.test(model) ? 4 : 0)) : 0;
  let negative = ['novelai', 'stability', 'automatic1111'].includes(provider);
  let negativeReason = '当前模型使用正向画面描述';
  if (['togetherai', 'pollinations'].includes(provider)) {
    negative = /(?:stable.?diffusion|sdxl|sd3|playground|dreamshaper)/.test(model);
    negativeReason = '仅在已确认支持负向的模型中使用';
  }
  if (['makersuite', 'vertexai'].includes(provider)) {
    negative = /(?:imagen-3\.0-(?:fast-generate|generate|capability)-001|imagen-2|imagegeneration)/.test(model);
  }
  if (provider === 'comfyui') {
    // The adapter replaces this literal placeholder in the selected workflow.
    negative = String(options.workflowJson || config.workflowJson || '').includes('%negative_prompt%');
    negativeReason = '在工作流中连接负向提示词占位符后使用';
  }
  return {
    provider, model, negative, negativeReason,
    nativeCharacters: novelVersion > 0, maxCharacters: novelVersion === 5 ? 22 : (novelVersion === 4 ? 6 : null),
    positions: novelVersion > 0, positionStep: novelVersion === 4 ? 0.2 : 0.01,
    textMode: provider === 'novelai' || ['automatic1111', 'stability', 'comfyui'].includes(provider) ? 'tags' : 'natural',
  };
};

export const imagePromptDocumentFromLegacy = (paramsPreset = {}) => {
  const blocks = [{ id: 'scene', kind: 'scene', text: '', enabled: true }];
  Object.entries(paramsPreset.paramsByProvider || {}).forEach(([provider, params]) => {
    const add = (key, kind, name, placement = 'before') => {
      if (!text(params?.[key])) return;
      blocks.push({ id: `legacy-${provider}-${key}`, kind, name, text: String(params[key]), enabled: true, provider, placement, parameterKey: key });
    };
    add('promptPrefix', 'style', '固定正向前缀');
    add('promptSuffix', 'style', '固定正向后缀', 'after');
    add('negativePrompt', 'negative', '固定负面提示词');
    if (!params?.negativePrompt) add('negative_prompt', 'negative', '固定负面提示词');
  });
  return normalizeImagePromptDocument({ blocks });
};

export const fillImagePromptScene = (document, scene = '', { append = false } = {}) => {
  const next = normalizeImagePromptDocument(document);
  const block = next.blocks.find(item => item.kind === 'scene');
  if (text(scene)) block.text = append && text(block.text) && text(block.text) !== text(scene) ? `${text(block.text)}\n\n${text(scene)}` : String(scene);
  return next;
};

export const compileImagePrompt = (document, config = {}, options = {}) => {
  const draft = normalizeImagePromptDocument(document), capability = resolveImagePromptCapabilities(config, options);
  const unused = [], active = [];
  for (const block of draft.blocks) {
    if (!text(block.text) && !text(block.negative)) continue;
    const reason = !block.enabled ? '已停用' : (block.provider && block.provider !== capability.provider ? '适用于其他渠道' : (block.kind === 'negative' && !capability.negative ? capability.negativeReason : ''));
    if (reason) unused.push({ id: block.id, name: block.name || block.kind, text: block.text, reason });
    else active.push(block);
  }
  const characters = active.filter(b => b.kind === 'character' && text(b.text));
  const errors = [];
  if (capability.maxCharacters && characters.length > capability.maxCharacters) errors.push(`当前模型最多支持 ${capability.maxCharacters} 个启用角色`);
  const before = active.filter(b => b.kind === 'style' && b.placement !== 'after');
  const scenes = active.filter(b => b.kind === 'scene');
  const after = active.filter(b => b.kind === 'style' && b.placement === 'after');
  const positives = [...before, ...scenes, ...(capability.nativeCharacters ? [] : characters), ...after].filter(b => text(b.text));
  const serialize = block => {
    if (block.kind === 'character' && capability.textMode === 'natural') return `${text(block.name) || 'Character'}: ${text(block.text)}`;
    return text(block.text);
  };
  const prompt = positives.map(serialize).join(capability.textMode === 'tags' ? ', ' : '\n\n');
  const negativePrompt = joinImagePromptNegativeTexts(active.filter(b => b.kind === 'negative').map(b => b.text));
  const nativeCharacters = capability.nativeCharacters ? characters.map(block => {
    const snap = v => Math.round((capability.positionStep === 0.2 ? Math.min(0.9, Math.max(0.1, 0.1 + Math.round((v - 0.1) / 0.2) * 0.2)) : v) * 100) / 100;
    return { id: block.id, name: block.name, prompt: text(block.text), negative: text(block.negative), center: { x: snap(block.center.x), y: snap(block.center.y) } };
  }) : [];
  if (!capability.nativeCharacters) characters.filter(b => text(b.negative)).forEach(b => unused.push({ id: b.id, name: b.name, text: b.negative, reason: capability.negative ? '当前模型使用画面级负向描述' : capability.negativeReason }));
  if (!prompt && !nativeCharacters.length) errors.push('请填写正向或角色提示词');
  if (capability.nativeCharacters && characters.length && prompt.includes('|')) errors.push('角色区块与 | 分隔语法请择一使用');
  return { prompt, negativePrompt, characters: nativeCharacters, useCoords: capability.positions && draft.positionMode === 'custom', capability, unused, errors, sources: positives.map(b => ({ id: b.id, name: b.name || b.kind, text: serialize(b) })), document: draft };
};

// Explicit document means a complete snapshot: do not re-append global text fields.
export const buildImagePromptRequest = (document, config, options = {}) => {
  const compiled = compileImagePrompt(document, config, options);
  if (compiled.errors.length) throw new Error(compiled.errors[0]);
  const next = { ...options };
  [...IMAGE_PROMPT_TEXT_KEYS, 'prompt_prefix', 'prompt_suffix', 'imagePromptResolved', 'imagePromptNegativeOverride', 'imagePromptParamsPresetId'].forEach(key => { delete next[key]; });
  next.imagePromptDocument = copy(compiled.document);
  next.imagePromptResolved = { prompt: compiled.prompt, negativePrompt: compiled.negativePrompt, characters: compiled.characters, useCoords: compiled.useCoords };
  if (compiled.negativePrompt) next.negativePrompt = compiled.negativePrompt;
  return { prompt: compiled.prompt || compiled.characters.map(c => c.prompt).join(', '), options: next, compiled };
};

export const restoreImagePromptFromAsset = (asset = {}) => {
  const params = asset.generationParams || {};
  if (params.imagePromptDocument) return normalizeImagePromptDocument(params.imagePromptDocument);
  const provider = providerKey(asset.provider);
  return fillImagePromptScene(imagePromptDocumentFromLegacy({ paramsByProvider: { [provider]: { ...params, negativePrompt: asset.negativePrompt || params.negativePrompt || '' } } }), asset.prompt || '');
};
