const trim = (value, fallback = '') => String(value ?? '').trim() || fallback;

const normalizeBaseUrl = (value = '') => trim(value, 'https://openrouter.ai/api/v1')
  .replace(/\/+$/u, '')
  .toLowerCase();

const keyOf = ({ baseUrl = '', model = '' } = {}) => (
  `${normalizeBaseUrl(baseUrl)}\u0000${trim(model).toLowerCase()}`
);

const records = new Map();

const normalizeSupportedParameters = (value = []) => [...new Set(
  (Array.isArray(value) ? value : [])
    .map(item => trim(item).toLowerCase())
    .filter(Boolean),
)];

export const recordOpenRouterModelCapabilities = ({
  baseUrl = '',
  model = {},
} = {}) => {
  const id = trim(model?.id);
  if (!id) return null;
  const supportedParameters = normalizeSupportedParameters(model?.supported_parameters);
  const record = Object.freeze({
    known: true,
    id,
    canonicalSlug: trim(model?.canonical_slug || id),
    contextLength: Number(model?.context_length) > 0 ? Number(model.context_length) : null,
    supportedParameters: Object.freeze(supportedParameters),
    supportsTools: supportedParameters.includes('tools'),
    supportsToolChoice: supportedParameters.includes('tool_choice'),
  });
  records.set(keyOf({ baseUrl, model: id }), record);
  return { ...record, supportedParameters: [...record.supportedParameters] };
};

export const recordOpenRouterModelCatalog = ({ baseUrl = '', models = [] } = {}) => {
  (Array.isArray(models) ? models : []).forEach((model) => {
    recordOpenRouterModelCapabilities({ baseUrl, model });
  });
};

export const readOpenRouterModelCapabilities = ({ baseUrl = '', model = '' } = {}) => {
  const record = records.get(keyOf({ baseUrl, model }));
  return record
    ? { ...record, supportedParameters: [...record.supportedParameters] }
    : {
        known: false,
        id: trim(model),
        canonicalSlug: '',
        supportedParameters: [],
        supportsTools: false,
        supportsToolChoice: false,
      };
};

export const clearOpenRouterModelCapabilitiesForTests = () => records.clear();
