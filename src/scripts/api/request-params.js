// Profile-owned rules run after protocol mapping, before serialization.
// Keep request metadata out of the JSON body; reports belong to the exact body object.
import { normalizeGenerationParamFilterList } from '../utils/generation-param-filter-utils.js';
import { usesConfiguredResponses } from './openai-api-format.js';
import { getPresetRequestParamField, getPresetNativeParamPaths, partitionPresetRequestParam } from './request-param-ownership.js';

const reports = new WeakMap();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export const REQUEST_PARAM_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'array', 'null']);
export const MAX_REQUEST_PARAMS = 100;

export const requestParamType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export const parseRequestParamPath = name => {
  const text = String(name ?? '').trim();
  const parts = text.split('.');
  if (!text || text.length > 160 || parts.length > 12
    || parts.some(part => !/^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(part) || forbidden.has(part))) {
    throw new Error('参数名需由字母或下划线开头，使用点号连接嵌套字段');
  }
  return parts;
};
const cloneJson = (value, depth = 0) => {
  if (depth > 32) throw new Error('JSON 嵌套层级过多');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => cloneJson(item, depth + 1));
  if (plain(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error('JSON 包含保留字段名');
      out[key] = cloneJson(item, depth + 1);
    }
    return out;
  }
  throw new Error('请输入有效的 JSON 值');
};

export const normalizeCustomRequestParams = value => (Array.isArray(value) ? value : [])
  .filter(plain).map(row => ({
    name: String(row.name ?? '').trim(),
    type: REQUEST_PARAM_TYPES.includes(row.type) ? row.type : requestParamType(row.value),
    value: row.value === undefined ? undefined : cloneJson(row.value),
    enabled: row.enabled !== false,
  }));

export const parseRequestParamValue = (type, text) => {
  if (type === 'string') return String(text ?? '');
  if (type === 'null') return null;
  let value;
  try { value = JSON.parse(String(text)); } catch { throw new Error('请输入有效的 JSON 值'); }
  if (requestParamType(value) !== type || !REQUEST_PARAM_TYPES.includes(type)) {
    throw new Error('参数值与所选类型不符');
  }
  return cloneJson(value);
};
export const formatRequestParamValue = row => row.type === 'string' ? String(row.value ?? '')
  : JSON.stringify(row.value, null, 2) ?? '';
const overlaps = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
export const validateCustomRequestParams = (rows, { activeOnly = false } = {}) => {
  const errors = [];
  const names = [];
  if (rows.length > MAX_REQUEST_PARAMS) errors.push({ index: -1, message: '自定义参数最多 100 项' });
  rows.forEach((row, index) => {
    if (activeOnly && row.enabled === false) return;
    try {
      parseRequestParamPath(row.name);
      if (!REQUEST_PARAM_TYPES.includes(row.type) || requestParamType(row.value) !== row.type) {
        throw new Error('参数值与所选类型不符');
      }
      cloneJson(row.value);
      // Disabled alternatives can share a path, but active rules must be unambiguous.
      if (row.enabled !== false) {
        const duplicate = names.find(name => overlaps(name, row.name));
        if (duplicate) throw new Error('参数路径重复或与上级、下级字段冲突：' + duplicate);
        names.push(row.name);
      }
    } catch (error) { errors.push({ index, name: row.name, message: error.message }); }
  });
  return errors;
};

const mergeObject = (target, value) => {
  const out = plain(target) ? { ...target } : {};
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error('JSON 包含保留字段名');
    out[key] = plain(item) ? mergeObject(out[key], item) : cloneJson(item);
  }
  return out;
};
const setPath = (body, parts, value) => {
  const [key, ...rest] = parts;
  if (!rest.length) body[key] = plain(value) ? mergeObject(body[key], value) : cloneJson(value);
  else {
    if (own(body, key) && body[key] !== undefined && !plain(body[key])) {
      throw new Error('嵌套参数的上级字段需为对象：' + key);
    }
    body[key] = { ...(body[key] || {}) };
    setPath(body[key], rest, value);
  }
};
const removePath = (body, parts) => {
  const [key, ...rest] = parts;
  if (!own(body, key)) return false;
  if (!rest.length) { delete body[key]; return true; }
  if (!plain(body[key])) return false;
  body[key] = { ...body[key] };
  return removePath(body[key], rest);
};
const readPath = (body, path) => path.split('.').reduce((obj, key) => obj && own(obj, key) ? obj[key] : undefined, body);

export const getRequestParamProtocol = (config = {}, options = {}) => {
  if (['gemini', 'makersuite', 'vertexai'].includes(config.provider)) return 'gemini';
  if (config.provider === 'anthropic') return 'anthropic';
  if (usesConfiguredResponses(config) || [options.openaiApi, options.openai_api].includes('responses')) return 'responses';
  return 'chat_completions';
};
const tokenPaths = (protocol, body = {}, config = {}) => protocol === 'gemini' ? ['generationConfig.maxOutputTokens']
  : protocol === 'responses' ? ['max_output_tokens']
    : protocol === 'anthropic' ? ['max_tokens']
      : own(body, 'max_completion_tokens') || (config.provider === 'openai' && /^(gpt-5|o1|o3|o4)/i.test(config.model || ''))
        ? ['max_completion_tokens', 'max_tokens'] : ['max_tokens', 'max_completion_tokens'];
export const resolveExcludedRequestParamPaths = (name, protocol, body = {}, config = {}) => {
  if (['maxTokens', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens'].includes(name)) {
    return tokenPaths(protocol, body, config);
  }
  const aliases = protocol === 'gemini' ? {
    temperature: 'generationConfig.temperature', top_p: 'generationConfig.topP', top_k: 'generationConfig.topK',
    stop: 'generationConfig.stopSequences', seed: 'generationConfig.seed',
    thinking: 'generationConfig.thinkingConfig', reasoning: 'generationConfig.thinkingConfig',
    thinkingBudget: 'generationConfig.thinkingConfig.thinkingBudget', thinkingLevel: 'generationConfig.thinkingConfig.thinkingLevel',
    reasoning_effort: 'generationConfig.thinkingConfig', tool_choice: 'toolConfig',
  } : protocol === 'responses' ? { reasoning_effort: 'reasoning.effort', response_format: 'text.format' } : {};
  return [aliases[name] || name];
};

const managedRoots = [
  'model', 'messages', 'input', 'contents', 'system', 'systemInstruction', 'instructions',
  'stream', 'previous_response_id', 'conversation', 'background',
  'signal', 'requestId', 'nativeRequestId', 'requestParamConstraints',
  'openaiApi', 'openai_api', 'apiKey', 'baseUrl', 'headers',
];
export const getRequestParamProtection = (name, { protocol = 'chat_completions', config = {}, options = {}, operation = 'set' } = {}) => {
  if (managedRoots.some(path => overlaps(name, path)) || /^on[A-Z]/.test(name)) return 'managed';
  if (operation === 'set' && getPresetRequestParamField(name, { config })) return 'preset';
  if (operation === 'exclude' && protocol === 'anthropic' && overlaps(name, 'max_tokens')) return 'required';
  const toolPaths = ['tools', 'tool_choice', 'toolConfig', 'include', 'max_tool_calls', 'parallel_tool_calls'];
  const protectedParams = options.requestParamConstraints?.protectedParams || [];
  if (protectedParams.some(path => overlaps(name, path))) return 'task';
  if (config.webSearchEnabled === true && Array.isArray(options.tools) && options.tools.length
    && toolPaths.some(path => overlaps(name, path))) return 'task';
  return '';
};

export const getPresetParamExclusions = (field, config = {}) => {
  const protocol = getRequestParamProtocol(config);
  const targets = getPresetNativeParamPaths(field, protocol);
  return [...new Set(normalizeGenerationParamFilterList(config.excludedGenerationParams)
    .flatMap(name => resolveExcludedRequestParamPaths(name, protocol, {}, config))
    .filter(path => targets.some(target => overlaps(path, target))
      && !getRequestParamProtection(path, { config, protocol, operation: 'exclude' })))];
};

export const getRequestParamReport = body => reports.get(body) || [];
export const sanitizeRequestPreviewUrl = value => {
  try {
    const url = new URL(value);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const name of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|authorization|credential|signature|^sig$/i.test(name)) url.searchParams.set(name, 'redacted');
    }
    return url.toString();
  } catch { return ''; }
};
export const finalizeTextRequestBody = (body, { config = {}, options = {}, protocol = getRequestParamProtocol(config, options) } = {}) => {
  const finish = result => {
    try { options.onProviderRequestPrepared?.({ body: result, protocol, parameterReport: getRequestParamReport(result) }); } catch {}
    return result;
  };
  const rows = normalizeCustomRequestParams(config.customRequestParams);
  const excluded = normalizeGenerationParamFilterList(config.excludedGenerationParams);
  const constraints = options.requestParamConstraints || {};
  if (!rows.length && !excluded.length && !Object.keys(constraints).length) return finish(body);
  const errors = validateCustomRequestParams(rows, { activeOnly: true });
  if (errors.length) throw new Error('请求参数：' + (errors[0].name ? errors[0].name + ' · ' : '') + errors[0].message);
  const out = { ...body };
  const report = [];
  for (const row of rows) {
    const reason = getRequestParamProtection(row.name, { config, protocol, options });
    if (!row.enabled || reason) {
      report.push({ name: row.name, operation: 'set', status: !row.enabled ? 'disabled' : reason });
      continue;
    }
    const parts = partitionPresetRequestParam(row, { config });
    if (parts.hasValue) setPath(out, parseRequestParamPath(row.name), parts.value);
    report.push({ name: row.name, operation: 'set', status: parts.status || 'applied',
      ...(parts.blocked.length ? { presetPaths: [...new Set(parts.blocked.map(item => item.path))] } : {}) });
  }
  for (const name of excluded) {
    for (const path of resolveExcludedRequestParamPaths(name, protocol, body, config)) {
      let parts;
      try { parts = parseRequestParamPath(path); } catch {
        report.push({ name, path, operation: 'exclude', status: 'invalid' });
        continue;
      }
      const reason = getRequestParamProtection(path, { config, protocol, options, operation: 'exclude' });
      if (reason) { report.push({ name, path, operation: 'exclude', status: reason }); continue; }
      const removed = removePath(out, parts);
      report.push({ name, path, operation: 'exclude', status: removed ? 'excluded' : 'absent' });
      if (removed) report.forEach(item => {
        if (item.operation === 'set' && ['applied', 'partially_excluded'].includes(item.status) && overlaps(item.name, path)) {
          item.status = path.startsWith(item.name + '.') ? 'partially_excluded' : 'excluded';
        }
      });
    }
  }
  const cap = Number(constraints.maxOutputTokens);
  if (Number.isFinite(cap) && cap > 0) {
    const paths = tokenPaths(protocol, out, config);
    const present = paths.filter(path => readPath(out, path) !== undefined);
    for (const path of present.length ? present : paths.slice(0, 1)) {
      const value = readPath(out, path);
      const limited = typeof value === 'number' && value > 0 ? Math.min(Math.trunc(value), Math.trunc(cap)) : Math.trunc(cap);
      if (value !== limited) {
        setPath(out, path.split('.'), limited);
        report.push({ name: path, operation: 'constraint', status: 'limited', limit: Math.trunc(cap) });
      }
    }
  }
  if (constraints.tools === 'none') {
    for (const path of ['tools', 'tool_choice', 'toolConfig', 'parallel_tool_calls', 'max_tool_calls']) {
      if (path === 'tool_choice' && body.tool_choice === 'none' && ['chat_completions', 'responses'].includes(protocol)) {
        if (out.tool_choice !== 'none') report.push({ name: path, operation: 'constraint', status: 'task' });
        out.tool_choice = 'none';
        continue;
      }
      if (removePath(out, [path])) report.push({ name: path, operation: 'constraint', status: 'task' });
    }
    if (protocol === 'chat_completions' && own(out, 'n') && out.n !== 1) {
      out.n = 1;
      report.push({ name: 'n', operation: 'constraint', status: 'task' });
    }
  }
  if (protocol === 'anthropic' && (typeof out.max_tokens !== 'number' || !Number.isFinite(out.max_tokens) || out.max_tokens < 1)) {
    throw new Error('请求参数：max_tokens 需为正数');
  }
  reports.set(out, report);
  return finish(out);
};

// JSON mode edits active values. Disabled alternatives remain in the row editor.
export const requestParamsToJson = rows => {
  const errors = validateCustomRequestParams(rows);
  if (errors.length) throw new Error(errors[0].message);
  const body = {};
  rows.filter(row => row.enabled !== false).forEach(row => setPath(body, parseRequestParamPath(row.name), row.value));
  return JSON.stringify(body, null, 2);
};
export const requestParamsFromJson = (text, previous = []) => {
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('请输入有效的 JSON 对象'); }
  if (!plain(body)) throw new Error('请输入有效的 JSON 对象');
  cloneJson(body);
  const active = [];
  const visit = (value, prefix = '') => {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? prefix + '.' + key : key;
      parseRequestParamPath(name);
      const existing = previous.find(row => row.enabled !== false && row.name === name);
      if (plain(item) && Object.keys(item).length && existing?.type !== 'object') visit(item, name);
      else active.push({ name, type: requestParamType(item), value: item, enabled: true });
    }
  };
  visit(body);
  const result = [...active, ...previous.filter(row => row.enabled === false)];
  const errors = validateCustomRequestParams(result);
  if (errors.length) throw new Error(errors[0].message);
  return result;
};

export const getCommonRequestParams = (protocol = 'chat_completions', { forExclusion = false, config } = {}) => {
  const entries = protocol === 'gemini' ? [
    ['generationConfig.temperature', 0.7], ['generationConfig.topP', 0.9], ['generationConfig.topK', 40],
    ['generationConfig.maxOutputTokens', 2048], ['generationConfig.stopSequences', []],
    ['generationConfig.thinkingConfig.thinkingBudget', 1024], ['generationConfig.responseMimeType', 'application/json'],
  ] : protocol === 'responses' ? [
    ['temperature', 0.7], ['top_p', 0.9], ['max_output_tokens', 2048], ['reasoning.effort', 'low'],
    ['text.verbosity', 'low'], ['text.format', { type: 'text' }], ['store', false],
  ] : protocol === 'anthropic' ? [
    ['temperature', 0.7], ['top_p', 0.9], ['top_k', 40], ['max_tokens', 2048], ['stop_sequences', []],
    ['thinking', { type: 'enabled', budget_tokens: 1024 }],
  ] : [
    ['temperature', 0.7], ['top_p', 0.9], ['max_tokens', 2048], ['max_completion_tokens', 2048],
    ['presence_penalty', 0], ['frequency_penalty', 0], ['seed', 0], ['stop', []],
    ['reasoning_effort', 'low'], ['response_format', { type: 'text' }],
  ];
  const rows = entries.map(([name, value]) => ({ name, type: requestParamType(value), value, enabled: true }));
  return forExclusion ? rows : rows.filter(row => !partitionPresetRequestParam(row, { config }).status);
};
