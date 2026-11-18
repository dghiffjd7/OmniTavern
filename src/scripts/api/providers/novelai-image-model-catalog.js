const NOVELAI_IMAGE_MODEL_ID_RE = /^nai-diffusion-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_NOVELAI_IMAGE_MODELS = Object.freeze([
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
  'nai-diffusion-2',
  'nai-diffusion-furry-3',
]);

export const NOVELAI_IMAGE_MODEL_CATALOG_URLS = Object.freeze([
  'https://raw.githubusercontent.com/dghiffjd7/OmniTavern/main/src/assets/catalogs/novelai-image-models.json',
  'https://cdn.jsdelivr.net/gh/dghiffjd7/OmniTavern@main/src/assets/catalogs/novelai-image-models.json',
]);

export const NOVELAI_IMAGE_MODEL_CACHE_KEY = 'novelai_image_model_catalog_v1';

const modelCollection = value => (
  Array.isArray(value)
    ? value
    : Array.isArray(value?.models)
      ? value.models
      : Array.isArray(value?.data)
        ? value.data
        : []
);

export const normalizeNovelAIImageModelIds = (value) => {
  const seen = new Set();
  const models = [];
  modelCollection(value).forEach((entry) => {
    const id = String(
      typeof entry === 'string'
        ? entry
        : entry?.id || entry?.value || entry?.model || '',
    ).trim().toLowerCase();
    if (!id || id.length > 96 || !NOVELAI_IMAGE_MODEL_ID_RE.test(id) || seen.has(id)) return;
    seen.add(id);
    models.push(id);
  });
  return models;
};

const normalizeOfficialModelsEndpoint = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 512) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'image.novelai.net') return '';
    if (url.username || url.password || url.hash) return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const normalizeNovelAIImageModelCatalog = (value = {}) => ({
  schemaVersion: Math.max(1, Math.trunc(Number(value?.schemaVersion)) || 1),
  updatedAt: String(value?.updatedAt || '').trim().slice(0, 64),
  officialModelsEndpoint: normalizeOfficialModelsEndpoint(value?.officialModelsEndpoint),
  models: normalizeNovelAIImageModelIds(value),
});

const persistResolvedCatalog = async (saveCache, result) => {
  if (typeof saveCache !== 'function') return;
  try {
    await saveCache({
      schemaVersion: 1,
      updatedAt: result.updatedAt || '',
      cachedAt: new Date().toISOString(),
      models: result.models,
    });
  } catch {}
};

export const resolveNovelAIImageModelCatalog = async ({
  catalogUrls = NOVELAI_IMAGE_MODEL_CATALOG_URLS,
  fetchJson = null,
  loadCache = null,
  saveCache = null,
  bundledModels = DEFAULT_NOVELAI_IMAGE_MODELS,
} = {}) => {
  if (typeof fetchJson === 'function') {
    for (const url of Array.isArray(catalogUrls) ? catalogUrls : []) {
      let remote;
      try {
        remote = normalizeNovelAIImageModelCatalog(await fetchJson(url, { kind: 'remote' }));
      } catch {
        continue;
      }
      if (!remote.models.length && !remote.officialModelsEndpoint) continue;

      if (remote.officialModelsEndpoint) {
        try {
          const officialModels = normalizeNovelAIImageModelIds(
            await fetchJson(remote.officialModelsEndpoint, { kind: 'official' }),
          );
          if (officialModels.length) {
            const result = {
              source: 'official',
              updatedAt: remote.updatedAt,
              models: officialModels,
            };
            await persistResolvedCatalog(saveCache, result);
            return result;
          }
        } catch {}
      }

      if (remote.models.length) {
        const result = {
          source: 'remote',
          updatedAt: remote.updatedAt,
          models: remote.models,
        };
        await persistResolvedCatalog(saveCache, result);
        return result;
      }
    }
  }

  if (typeof loadCache === 'function') {
    try {
      const cached = normalizeNovelAIImageModelCatalog(await loadCache());
      if (cached.models.length) {
        return {
          source: 'cache',
          updatedAt: cached.updatedAt,
          models: cached.models,
        };
      }
    } catch {}
  }

  return {
    source: 'bundled',
    updatedAt: '',
    models: normalizeNovelAIImageModelIds(bundledModels),
  };
};

// 精准参考（Precise Reference）：官方文档说只在 V4.5 模型上可用、每张图另扣 5 Anlas。
// V5（nai-diffusion-5-full）带 director_reference_* 会回 500（11-06 实测；NekoAI-JS 也写明 V5 不能用 director references）。
export const isNovelAIPreciseReferenceModel = (model = '') => /nai-diffusion-4-5\b/i.test(String(model || ''));
