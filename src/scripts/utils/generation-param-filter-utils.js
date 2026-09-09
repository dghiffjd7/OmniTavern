export const COMMON_GENERATION_PARAM_FILTERS = Object.freeze([
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'stop',
  'seed',
  'n',
  'max_tokens',
  'max_completion_tokens',
  'maxTokens',
  'reasoning_effort',
  'reasoning',
  'thinking',
  'tools',
  'tool_choice',
  'response_format',
]);

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.$:-]{0,159}$/;

export const normalizeGenerationParamFilterName = (value = '') => {
  const name = String(value || '').trim();
  if (!name || name.length > 160) return '';
  if (!PARAM_NAME_RE.test(name)) return '';
  return name;
};

export const splitGenerationParamFilterInput = (value = '') =>
  String(value || '')
    .split(/[\s,，;；]+/g)
    .map(normalizeGenerationParamFilterName)
    .filter(Boolean);

export const normalizeGenerationParamFilterList = (value = []) => {
  const rawList = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? splitGenerationParamFilterInput(value)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const name = normalizeGenerationParamFilterName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 100) break;
  }
  return out;
};

export const applyGenerationParamFilter = (options = {}, excludedParams = [], { protectedParams = [] } = {}) => {
  const source = options && typeof options === 'object' ? options : {};
  const out = { ...source };
  const protectedSet = new Set(normalizeGenerationParamFilterList(protectedParams));
  for (const key of normalizeGenerationParamFilterList(excludedParams)) {
    if (protectedSet.has(key)) continue;
    delete out[key];
  }
  return out;
};
