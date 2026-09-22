// Reference inputs belong to one image job, independently of parameter presets.
export const normalizeImageGenerationReferenceItems = (items = [], capability = {}) => {
  const supported = Boolean(capability?.supported);
  const max = Math.max(0, Math.trunc(Number(capability?.max || 0)));
  if (!supported || max <= 0) return [];
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === 'string') {
        return { dataUrl: item.trim(), name: '', mime: '', size: 0 };
      }
      return {
        dataUrl: String(item?.dataUrl || item?.url || '').trim(),
        name: String(item?.name || '').trim(),
        mime: String(item?.mime || item?.type || '').trim(),
        size: Number(item?.size || 0) || 0,
      };
    })
    .filter(item => item.dataUrl)
    .slice(0, max);
};

export const createImageGenerationReferenceReader = ({
  readFileAsDataUrl,
  isGifFile,
  compressImageDataUrl,
} = {}) => async (files = [], limit = 0) => {
  const max = Math.max(0, Math.trunc(Number(limit || 0)));
  if (max <= 0) return [];
  const refs = [];
  for (const file of Array.from(files || [])) {
    if (refs.length >= max) break;
    if (!String(file?.type || '').startsWith('image/')) continue;
    const rawDataUrl = await readFileAsDataUrl(file);
    if (!rawDataUrl) continue;
    let dataUrl = rawDataUrl;
    if (!isGifFile(file)) {
      try {
        dataUrl = await compressImageDataUrl(rawDataUrl, {
          maxDim: 1280,
          quality: 0.9,
          maxBytes: 2_000_000,
        });
      } catch {
        dataUrl = rawDataUrl;
      }
    }
    refs.push({
      dataUrl,
      name: String(file?.name || '').trim(),
      mime: String(file?.type || '').trim(),
      size: Number(file?.size || 0) || 0,
    });
  }
  return refs;
};

// Both retry and display read the saved request, never the current upload draft
// or current model limits. Names are stored separately to avoid duplicating base64.
export const getGeneratedImageReferenceItems = (generated = {}) => {
  const params = generated?.generationParams || {};
  const images = Array.isArray(params.referenceImages) ? params.referenceImages
    : Array.isArray(params.reference_images) ? params.reference_images : [];
  const names = Array.isArray(generated?.referenceImageNames) ? generated.referenceImageNames : [];
  return images.flatMap((image, index) => {
    if (image?.path) return [{ ...image, name: image.name || names[index] || '' }];
    return normalizeImageGenerationReferenceItems([
      typeof image === 'string' ? { dataUrl: image, name: names[index] || '' }
        : { ...image, name: image?.name || names[index] || '' },
    ], { supported: true, max: 1 });
  });
};

export const getImageGenerationReferencePreviewUrl = (reference = {}) => {
  if (!reference.path) return String(reference.dataUrl || reference.url || '');
  const g = globalThis;
  const convert = g.__TAURI__?.core?.convertFileSrc || g.__TAURI__?.convertFileSrc || g.__TAURI_INTERNALS__?.convertFileSrc;
  if (convert) return convert(reference.path);
  return `file:///${String(reference.path).replace(/\\/g, '/').replace(/^\//, '')}`;
};
