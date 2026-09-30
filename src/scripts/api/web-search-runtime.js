export const WEB_SEARCH_ROUTES = Object.freeze({
  disabled: 'disabled',
  openrouter: 'openrouter_native',
  gemini: 'gemini_native',
  anthropic: 'anthropic_native',
  zhipu: 'zhipu_native',
  kimi: 'kimi_native',
  openai: 'openai_native',
  deepseek: 'deepseek_native',
  toolFallback: 'tool_fallback',
});

const FALLBACK_PROVIDER_NAMES = Object.freeze({
  'web.search': 'web_search',
  'web.research': 'web_research',
  'web.fetch_url': 'web_fetch',
});

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const parseEndpoint = (value, fallback = '') => {
  try {
    const url = new URL(trim(value, fallback));
    if (
      url.protocol !== 'https:'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return null;
    return url;
  } catch {
    return null;
  }
};

const hasOfficialEndpoint = (value, {
  fallback = '',
  hosts = [],
  paths = null,
} = {}) => {
  const url = parseEndpoint(value, fallback);
  if (!url || !hosts.includes(url.hostname.toLowerCase())) return false;
  if (!Array.isArray(paths)) return true;
  const path = url.pathname.replace(/\/+$/u, '') || '/';
  return paths.includes(path);
};

const isOfficialGoogleEndpoint = (value = '', provider = '') => {
  const normalizedProvider = trim(provider).toLowerCase();
  const fallback = normalizedProvider === 'vertexai'
    ? 'https://aiplatform.googleapis.com'
    : 'https://generativelanguage.googleapis.com';
  const url = parseEndpoint(value, fallback);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (normalizedProvider === 'vertexai') {
    return host === 'aiplatform.googleapis.com' || host.endsWith('-aiplatform.googleapis.com');
  }
  return host === 'generativelanguage.googleapis.com'
    || host === 'aiplatform.googleapis.com'
    || host.endsWith('-aiplatform.googleapis.com');
};

const isSupportedOpenAIWebSearchModel = model => (
  /^gpt-(?:4\.1|[5-9])(?:[.\-]|$)/iu.test(trim(model))
  || /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/iu.test(trim(model))
  || /^o(?:3|4-mini)(?:[.\-]|$)/iu.test(trim(model))
);

const isSupportedKimiWebSearchModel = model => (
  /^(?:kimi-|moonshot-v1-)/iu.test(trim(model))
);

const isSupportedZhipuWebSearchModel = model => (
  /^glm-(?:4|5)(?:[.\-]|$)/iu.test(trim(model))
);

const supportsAnthropicDynamicWebSearch = (model = '') => {
  // 仅识别新命名 claude-<family>-<major>[-<minor>][-<date>]；旧命名
  // claude-3-5-sonnet 不匹配，八位快照日期也不会被误读成 minor。
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/iu.exec(trim(model));
  if (!match) return false;
  const major = Number(match[2]);
  const minor = Number(match[3] || 0);
  return major >= 5 || (major === 4 && minor >= 6);
};

const clone = (value) => {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const normalizeUrl = (value) => {
  const raw = trim(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
};

const fallbackTitleFromUrl = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url;
  } catch {
    return url;
  }
};

const toSourceCandidate = (source = {}, defaultProvider = '') => {
  const src = isPlainObject(source) ? source : {};
  const citation = isPlainObject(src.url_citation) ? src.url_citation : {};
  const web = isPlainObject(src.web) ? src.web : {};
  const url = normalizeUrl(
    src.url
    || src.uri
    || src.link
    || citation.url
    || citation.uri
    || web.url
    || web.uri,
  );
  if (!url) return null;
  const title = trim(
    src.title
    || src.name
    || citation.title
    || web.title,
    fallbackTitleFromUrl(url),
  ).slice(0, 300);
  const snippet = trim(
    src.snippet
    || src.content
    || src.cited_text
    || src.citedText
    || citation.content,
  ).slice(0, 800);
  const provider = trim(src.provider || src.source, defaultProvider).slice(0, 80);
  return {
    url,
    title,
    ...(snippet ? { snippet } : {}),
    ...(provider ? { provider } : {}),
  };
};

export const normalizeWebSources = (sources = [], {
  provider = '',
  maxSources = 20,
} = {}) => {
  const input = Array.isArray(sources) ? sources : [sources];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const source = toSourceCandidate(item, provider);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
    if (out.length >= Math.max(1, Math.trunc(Number(maxSources)) || 20)) break;
  }
  return out;
};

export const mergeWebSources = (...groups) => normalizeWebSources(groups.flatMap(group => (
  Array.isArray(group) ? group : (group ? [group] : [])
)));

export const resolveWebSearchRoute = ({
  enabled = false,
  provider = '',
  baseUrl = '',
  model = '',
} = {}) => {
  if (enabled !== true) return WEB_SEARCH_ROUTES.disabled;
  const value = trim(provider).toLowerCase();
  if (value === 'openrouter') {
    return hasOfficialEndpoint(baseUrl, {
      fallback: 'https://openrouter.ai/api/v1',
      hosts: ['openrouter.ai'],
      paths: ['/api/v1'],
    }) ? WEB_SEARCH_ROUTES.openrouter : WEB_SEARCH_ROUTES.toolFallback;
  }
  if (value === 'gemini' || value === 'makersuite' || value === 'vertexai') {
    return isOfficialGoogleEndpoint(baseUrl, value)
      ? WEB_SEARCH_ROUTES.gemini
      : WEB_SEARCH_ROUTES.toolFallback;
  }
  if (value === 'anthropic') {
    return hasOfficialEndpoint(baseUrl, {
      fallback: 'https://api.anthropic.com/v1',
      hosts: ['api.anthropic.com'],
      paths: ['/', '/v1'],
    }) ? WEB_SEARCH_ROUTES.anthropic : WEB_SEARCH_ROUTES.toolFallback;
  }
  if (value === 'zhipu') {
    return isSupportedZhipuWebSearchModel(model) && hasOfficialEndpoint(baseUrl, {
      fallback: 'https://open.bigmodel.cn/api/paas/v4',
      hosts: ['open.bigmodel.cn'],
      paths: ['/api/paas/v4'],
    }) ? WEB_SEARCH_ROUTES.zhipu : WEB_SEARCH_ROUTES.toolFallback;
  }
  if (value === 'kimi') {
    return isSupportedKimiWebSearchModel(model) && hasOfficialEndpoint(baseUrl, {
      fallback: 'https://api.moonshot.ai/v1',
      hosts: ['api.moonshot.ai', 'api.moonshot.cn'],
      paths: ['/v1'],
    }) ? WEB_SEARCH_ROUTES.kimi : WEB_SEARCH_ROUTES.toolFallback;
  }
  if (value === 'openai') {
    return isSupportedOpenAIWebSearchModel(model) && hasOfficialEndpoint(baseUrl, {
      fallback: 'https://api.openai.com/v1',
      hosts: ['api.openai.com'],
      paths: ['/', '/v1'],
    }) ? WEB_SEARCH_ROUTES.openai : WEB_SEARCH_ROUTES.toolFallback;
  }
  if (value === 'deepseek') {
    // DeepSeek Responses ignores built-in web_search tools. Use executable
    // function tools instead: https://api-docs.deepseek.com/guides/responses_api/
    return WEB_SEARCH_ROUTES.toolFallback;
  }
  return WEB_SEARCH_ROUTES.toolFallback;
};

const collectExistingTools = (existingOptions = []) => {
  const sources = Array.isArray(existingOptions) ? existingOptions : [existingOptions];
  const tools = [];
  const seen = new Set();
  sources.forEach((source) => {
    if (!isPlainObject(source) || !Array.isArray(source.tools)) return;
    source.tools.forEach((tool) => {
      if (!isPlainObject(tool)) return;
      const key = JSON.stringify([
        trim(tool.type),
        trim(tool.name || tool.function?.name),
        Object.keys(tool).sort(),
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      tools.push(clone(tool));
    });
  });
  return tools;
};

const appendUniqueTool = (tools, tool, matcher) => {
  if (!tools.some(existing => matcher(existing))) tools.push(tool);
  return tools;
};

const normalizeFallbackDefinitions = (definitions = []) => {
  const byProviderName = {};
  const tools = [];
  (Array.isArray(definitions) ? definitions : [])
    .filter(definition => isPlainObject(definition))
    .forEach((definition) => {
      const internalName = trim(definition.name);
      const providerName = FALLBACK_PROVIDER_NAMES[internalName];
      if (!providerName || byProviderName[providerName]) return;
      byProviderName[providerName] = internalName;
      tools.push({
        type: 'function',
        function: {
          name: providerName,
          description: trim(definition.description || definition.title, internalName),
          parameters: isPlainObject(definition.schema)
            ? clone(definition.schema)
            : { type: 'object', additionalProperties: false, properties: {} },
        },
      });
    });
  return { tools, byProviderName };
};

const disabledPlan = ({ route = WEB_SEARCH_ROUTES.disabled, reason = 'disabled' } = {}) => ({
  enabled: false,
  route,
  native: false,
  fallback: false,
  requestOptions: {},
  fallbackToolNames: {},
  diagnostics: { enabled: false, route, reason },
});

export const buildWebSearchRequestPlan = ({
  enabled = false,
  provider = '',
  baseUrl = '',
  model = '',
  existingOptions = [],
  fallbackToolDefinitions = [],
} = {}) => {
  const route = resolveWebSearchRoute({ enabled, provider, baseUrl, model });
  if (route === WEB_SEARCH_ROUTES.disabled) return disabledPlan({ route, reason: 'profile switch is disabled' });
  const existingTools = collectExistingTools(existingOptions);

  if (
    trim(provider).toLowerCase() === 'deepseek'
    && (Array.isArray(existingOptions) ? existingOptions : [existingOptions]).some(option => (
      trim(option?.deepseekPrefix?.prefix)
    ))
  ) {
    return disabledPlan({
      route,
      reason: 'deepseek prefix completion is incompatible with web search',
    });
  }

  if (route === WEB_SEARCH_ROUTES.openrouter) {
    const tools = existingTools.slice();
    appendUniqueTool(tools, {
      type: 'openrouter:web_search',
      parameters: {
        max_results: 3,
        max_total_results: 6,
      },
    }, tool => trim(tool?.type) === 'openrouter:web_search');
    // 服务端抓取工具：模型可直接读取用户给出的网址（服务端执行，无需客户端处理）
    appendUniqueTool(tools, {
      type: 'openrouter:web_fetch',
      parameters: {
        max_uses: 2,
        max_content_tokens: 6000,
      },
    }, tool => trim(tool?.type) === 'openrouter:web_fetch');
    return {
      enabled: true,
      route,
      native: true,
      fallback: false,
      requestOptions: { tools, max_tool_calls: 3 },
      fallbackToolNames: {},
      diagnostics: {
        enabled: true,
        route,
        reason: '',
        maxResults: 3,
        maxToolCalls: 3,
      },
    };
  }

  if (route === WEB_SEARCH_ROUTES.gemini) {
    const tools = existingTools.slice();
    const hasFunctionTools = tools.some(tool => (
      Array.isArray(tool?.functionDeclarations)
      || Array.isArray(tool?.function_declarations)
      || trim(tool?.type) === 'function'
    ));
    const isGemini3 = /^gemini-3(?:[.\-]|$)/i.test(trim(model));
    if (hasFunctionTools && !isGemini3) {
      return disabledPlan({
        route,
        reason: 'gemini native search conflicts with existing function tools for this model',
      });
    }
    const isVertex = trim(provider).toLowerCase() === 'vertexai';
    const nativeTool = isVertex ? { googleSearch: {} } : { google_search: {} };
    appendUniqueTool(
      tools,
      nativeTool,
      tool => isPlainObject(tool?.googleSearch) || isPlainObject(tool?.google_search),
    );
    return {
      enabled: true,
      route,
      native: true,
      fallback: false,
      requestOptions: { tools },
      fallbackToolNames: {},
      diagnostics: { enabled: true, route, reason: '' },
    };
  }

  if (route === WEB_SEARCH_ROUTES.anthropic) {
    const tools = existingTools.slice();
    const dynamic = supportsAnthropicDynamicWebSearch(model);
    appendUniqueTool(tools, {
      type: dynamic ? 'web_search_20260209' : 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
      ...(dynamic ? { allowed_callers: ['direct', 'code_execution_20260120'] } : {}),
    }, tool => trim(tool?.name) === 'web_search' && trim(tool?.type).startsWith('web_search_'));
    return {
      enabled: true,
      route,
      native: true,
      fallback: false,
      requestOptions: { tools },
      fallbackToolNames: {},
      diagnostics: { enabled: true, route, reason: '', maxUses: 3 },
    };
  }

  if (route === WEB_SEARCH_ROUTES.zhipu) {
    const tools = existingTools.slice();
    appendUniqueTool(tools, {
      type: 'web_search',
      web_search: {
        enable: true,
        search_engine: 'search_pro',
        search_result: true,
        count: 5,
        content_size: 'medium',
      },
    }, tool => trim(tool?.type) === 'web_search' && isPlainObject(tool?.web_search));
    return {
      enabled: true,
      route,
      native: true,
      fallback: false,
      requestOptions: { tools },
      fallbackToolNames: {},
      diagnostics: {
        enabled: true,
        route,
        reason: '',
        execution: 'provider_native',
        searchEngine: 'search_pro',
      },
    };
  }

  if (route === WEB_SEARCH_ROUTES.kimi) {
    const tools = existingTools.slice();
    appendUniqueTool(tools, {
      type: 'builtin_function',
      function: { name: '$web_search' },
    }, tool => (
      trim(tool?.type) === 'builtin_function'
      && trim(tool?.function?.name) === '$web_search'
    ));
    return {
      enabled: true,
      route,
      native: true,
      fallback: false,
      requestOptions: { tools },
      fallbackToolNames: {},
      diagnostics: {
        enabled: true,
        route,
        reason: '',
        execution: 'provider_native',
        maxContinuationTurns: 3,
      },
    };
  }

  if (route === WEB_SEARCH_ROUTES.openai) {
    const tools = existingTools.slice();
    appendUniqueTool(
      tools,
      { type: 'web_search' },
      tool => trim(tool?.type) === 'web_search' || trim(tool?.type) === 'web_search_preview',
    );
    return {
      enabled: true,
      route,
      native: true,
      fallback: false,
      requestOptions: {
        openaiApi: 'responses',
        tools,
        tool_choice: 'auto',
        max_tool_calls: 3,
        include: ['web_search_call.action.sources'],
      },
      fallbackToolNames: {},
      diagnostics: {
        enabled: true,
        route,
        reason: '',
        execution: 'provider_native',
        maxToolCalls: 3,
      },
    };
  }

  const fallback = normalizeFallbackDefinitions(fallbackToolDefinitions);
  if (!fallback.tools.length) {
    return disabledPlan({ route, reason: 'web tool runtime is unavailable' });
  }
  const tools = existingTools.slice();
  fallback.tools.forEach(tool => appendUniqueTool(
    tools,
    tool,
    existing => trim(existing?.function?.name) === trim(tool?.function?.name),
  ));
  return {
    enabled: true,
    route,
    native: false,
    fallback: true,
    requestOptions: {
      tools,
      tool_choice: 'auto',
    },
    fallbackToolNames: fallback.byProviderName,
    diagnostics: {
      enabled: true,
      route,
      reason: '',
      internalToolNames: Object.values(fallback.byProviderName),
      maxToolCalls: 2,
      maxContinuationTurns: 1,
    },
  };
};

const visitObjects = (value, visitor, depth = 0, seen = new Set()) => {
  if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => visitObjects(item, visitor, depth + 1, seen));
    return;
  }
  Object.values(value).forEach(item => visitObjects(item, visitor, depth + 1, seen));
};

const extractOpenRouterSources = (payload, provider) => {
  const candidates = [];
  visitObjects(payload, (value) => {
    if (!isPlainObject(value)) return;
    if (trim(value.type) === 'url_citation') {
      candidates.push({ ...(isPlainObject(value.url_citation) ? value.url_citation : value), provider });
    }
    if (Array.isArray(value.sources)) {
      value.sources.forEach(source => {
        if (isPlainObject(source)) candidates.push({ ...source, provider });
      });
    }
  });
  return normalizeWebSources(candidates, { provider });
};

const extractGenericNativeSources = (payload, provider) => {
  const candidates = [];
  visitObjects(payload, (value) => {
    if (!isPlainObject(value)) return;
    const type = trim(value.type).toLowerCase();
    if (
      type === 'url_citation'
      || type === 'web_search_result'
      || type === 'web_search_result_location'
    ) {
      candidates.push({ ...(isPlainObject(value.url_citation) ? value.url_citation : value), provider });
    }
    if (Array.isArray(value.sources)) {
      value.sources.forEach(source => {
        if (isPlainObject(source)) candidates.push({ ...source, provider });
      });
    }
  });
  return normalizeWebSources(candidates, { provider });
};

const extractGeminiSources = (payload, provider) => {
  const candidates = [];
  const responseCandidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  responseCandidates.forEach((candidate) => {
    const metadata = candidate?.groundingMetadata || candidate?.grounding_metadata || {};
    const chunks = metadata?.groundingChunks || metadata?.grounding_chunks || [];
    (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
      const web = chunk?.web || chunk?.retrievedContext || chunk?.retrieved_context;
      if (isPlainObject(web)) candidates.push({ ...web, provider });
    });
  });
  return normalizeWebSources(candidates, { provider });
};

const extractAnthropicSources = (payload, provider) => {
  const candidates = [];
  visitObjects(payload, (value) => {
    if (!isPlainObject(value)) return;
    const type = trim(value.type);
    if (type === 'web_search_result' || type === 'web_search_result_location') {
      candidates.push({ ...value, provider });
    }
    const citation = isPlainObject(value.citation) ? value.citation : null;
    if (citation && trim(citation.type) === 'web_search_result_location') {
      candidates.push({ ...citation, provider });
    }
  });
  return normalizeWebSources(candidates, { provider });
};

const extractZhipuSources = (payload, provider) => normalizeWebSources(
  Array.isArray(payload?.web_search)
    ? payload.web_search.map(source => ({ ...(isPlainObject(source) ? source : {}), provider }))
    : [],
  { provider },
);

const parseJsonObject = (value) => {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const extractKimiSources = (payload, provider) => {
  const candidates = [];
  visitObjects(payload, (value) => {
    if (!isPlainObject(value)) return;
    const fn = isPlainObject(value.function) ? value.function : null;
    if (!fn || trim(fn.name) !== '$web_search') return;
    const args = parseJsonObject(fn.arguments);
    if (!args) return;
    [args.results, args.sources, args.documents]
      .filter(Array.isArray)
      .forEach(group => group.forEach(source => {
        if (isPlainObject(source)) candidates.push({ ...source, provider });
      }));
  });
  return normalizeWebSources(candidates, { provider });
};

export const extractProviderWebSources = (payload, { provider = '' } = {}) => {
  if (!payload || typeof payload !== 'object') return [];
  const normalizedProvider = trim(provider).toLowerCase();
  if (normalizedProvider === 'openrouter') return extractOpenRouterSources(payload, normalizedProvider);
  if (normalizedProvider === 'gemini' || normalizedProvider === 'makersuite' || normalizedProvider === 'vertexai') {
    return extractGeminiSources(payload, normalizedProvider);
  }
  if (normalizedProvider === 'anthropic') return extractAnthropicSources(payload, normalizedProvider);
  if (normalizedProvider === 'zhipu') return extractZhipuSources(payload, normalizedProvider);
  if (normalizedProvider === 'kimi') {
    return mergeWebSources(
      extractKimiSources(payload, normalizedProvider),
      extractGenericNativeSources(payload, normalizedProvider),
    );
  }
  if (normalizedProvider === 'openai' || normalizedProvider === 'deepseek') {
    return extractGenericNativeSources(payload, normalizedProvider);
  }
  return normalizeWebSources([], { provider: normalizedProvider });
};

export const extractProviderWebSearchActivity = (payload, { provider = '' } = {}) => {
  if (!payload || typeof payload !== 'object') return null;
  const normalizedProvider = trim(provider).toLowerCase();
  const callKeys = new Set();
  let detected = false;
  let completed = false;
  let engine = '';

  const zhipuResults = Array.isArray(payload?.web_search) ? payload.web_search : [];
  if (zhipuResults.length) {
    detected = true;
    completed = true;
    callKeys.add('zhipu:web_search');
  }

  visitObjects(payload, (value) => {
    if (!isPlainObject(value)) return;
    const type = trim(value.type).toLowerCase();
    const responseWebSearchEvent = /^response\.web_search_call\.(searching|in_progress|completed)$/u.exec(type);
    const status = trim(value.status || responseWebSearchEvent?.[1]).toLowerCase();
    const fnName = trim(value?.function?.name || value.name);
    const isWebCall = Boolean(responseWebSearchEvent)
      || type === 'web_search_call'
      || type === 'web_search_tool_result'
      || (type === 'server_tool_use' && fnName === 'web_search')
      || fnName === '$web_search';
    if (isWebCall) {
      detected = true;
      const key = trim(value.id || value.item_id || value.call_id, `${type}:${fnName}`);
      if (key) callKeys.add(key);
      if (
        status === 'completed'
        || status === 'succeeded'
        || type === 'web_search_tool_result'
        || fnName === '$web_search'
      ) completed = true;
    }
    if (value.groundingMetadata || value.grounding_metadata) {
      detected = true;
      completed = true;
      callKeys.add('gemini:grounding');
    }
    const candidateEngine = trim(
      value.web_search_engine
      || value.webSearchEngine
      || value.search_engine
      || value.searchEngine
      || (isWebCall ? value.engine : ''),
    );
    if (candidateEngine) engine = candidateEngine;
  });

  const sources = extractProviderWebSources(payload, { provider: normalizedProvider });
  if (sources.length) {
    detected = true;
    completed = true;
  }
  if (!detected) return null;
  return {
    state: completed ? 'done' : 'searching',
    provider: normalizedProvider,
    execution: 'provider_native',
    ...(engine ? { engine } : {}),
    searchRequests: callKeys.size || null,
    sourceCount: sources.length,
  };
};

export const extractToolResultWebSources = (output = {}, { provider = '' } = {}) => {
  const source = isPlainObject(output?.result) ? output.result : (isPlainObject(output) ? output : {});
  const groups = [source.sources, source.results, source.documents]
    .filter(Array.isArray)
    .map(items => items.map(item => ({ ...item, provider: trim(provider || source.provider) })));
  // web.fetch_url 单页结果没有列表字段，抓取页本身就是来源
  if (!groups.length && trim(source.url)) {
    groups.push([{ url: source.url, title: source.title, provider: trim(provider || source.provider) }]);
  }
  return mergeWebSources(...groups);
};

export const reportProviderWebSources = (options, payload, { provider = '' } = {}) => {
  const activity = extractProviderWebSearchActivity(payload, { provider });
  if (activity && typeof options?.onProviderSearchActivity === 'function') {
    try {
      options.onProviderSearchActivity(activity);
    } catch {}
  }
  const callback = options?.onProviderSources;
  const sources = extractProviderWebSources(payload, { provider });
  if (typeof callback !== 'function' || !sources.length) return sources;
  try {
    callback(sources, {
      provider: trim(provider),
      execution: 'provider_native',
      ...(activity?.engine ? { engine: activity.engine } : {}),
    });
  } catch {}
  return sources;
};
