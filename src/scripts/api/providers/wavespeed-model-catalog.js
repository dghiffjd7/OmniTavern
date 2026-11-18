// WaveSpeed 模型目录。/models 回的参数表缓存在内存里；每个模型的参考图栏位（栏位名、最多几张、是否必填）
// 另存一份小摘要到本地，让「能带几张参考图」这种同步判断在 APP 重启后也查得到——
// 用户在设置里拉过模型列表、选了编辑模型，摘要就有了。

export const WAVESPEED_DEFAULT_BASE_URL = 'https://api.wavespeed.ai/api/v3';
export const WAVESPEED_IMAGE_MODEL_TYPES = Object.freeze(['text-to-image', 'image-to-image']);

const MEMORY_TTL_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'wavespeed_reference_inputs_v1';
// images 栏位没写 maxItems 时按这个上限算
const DEFAULT_IMAGES_MAX = 4;
const memory = new Map();

const keyOf = baseUrl => String(baseUrl || WAVESPEED_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');

const readStored = () => {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeStored = (data) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
};

export const findWaveSpeedRequestSchema = (models = [], modelId = '') => {
  const id = String(modelId || '').trim();
  const model = (Array.isArray(models) ? models : []).find(item => String(item?.model_id || '').trim() === id);
  const schemas = Array.isArray(model?.api_schema?.api_schemas) ? model.api_schema.api_schemas : [];
  const run = schemas.find(item => item?.type === 'model_run') || schemas[0];
  const schema = run?.request_schema;
  return schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema : null;
};

/** 参考图栏位：images（数组）或 image（单张）；都没有就是不能用参考图的模型。 */
export const describeWaveSpeedReferenceInput = (schema = null) => {
  const properties = schema?.properties || {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (properties.images?.type === 'array') {
    const max = Math.trunc(Number(properties.images.maxItems)) || DEFAULT_IMAGES_MAX;
    return { field: 'images', max: Math.max(1, max), required: required.includes('images') };
  }
  if (properties.image?.type === 'string') {
    return { field: 'image', max: 1, required: required.includes('image') };
  }
  return { field: '', max: 0, required: false };
};

export const getCachedWaveSpeedModels = (baseUrl = '') => {
  const hit = memory.get(keyOf(baseUrl));
  return hit && Date.now() - hit.at < MEMORY_TTL_MS ? hit.models : null;
};

export const rememberWaveSpeedModels = (baseUrl = '', models = []) => {
  const key = keyOf(baseUrl);
  const list = Array.isArray(models) ? models : [];
  memory.set(key, { at: Date.now(), models: list });
  const inputs = {};
  for (const model of list) {
    const id = String(model?.model_id || '').trim();
    if (!id || !WAVESPEED_IMAGE_MODEL_TYPES.includes(String(model?.type || ''))) continue;
    const input = describeWaveSpeedReferenceInput(findWaveSpeedRequestSchema([model], id));
    inputs[id] = input.field ? [input.field, input.max, input.required ? 1 : 0] : 0;
  }
  const stored = readStored();
  stored[key] = inputs;
  writeStored(stored);
};

/** 同步查询：known 为 false 表示还没拉过这个模型的参数表。 */
export const getWaveSpeedReferenceInput = ({ baseUrl = '', model = '' } = {}) => {
  const id = String(model || '').trim();
  const schema = findWaveSpeedRequestSchema(memory.get(keyOf(baseUrl))?.models, id);
  if (schema) return { known: true, ...describeWaveSpeedReferenceInput(schema) };
  const entry = readStored()[keyOf(baseUrl)]?.[id];
  if (entry === 0) return { known: true, field: '', max: 0, required: false };
  if (Array.isArray(entry) && entry[0]) {
    return { known: true, field: String(entry[0]), max: Math.max(1, Math.trunc(Number(entry[1])) || 1), required: entry[2] === 1 };
  }
  return { known: false, field: '', max: 0, required: false };
};
