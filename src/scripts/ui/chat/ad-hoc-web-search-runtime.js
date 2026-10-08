import {
  buildWebSearchRequestPlan,
  mergeWebSources,
} from '../../api/web-search-runtime.js';
import { createWebSearchGenerationClient } from './web-search-generation-client.js';
import { captureRequestContext } from '../../api/request-context.js';

export const AD_HOC_WEB_SEARCH_NOTICE_KEY = 'chatapp.ad_hoc_web_search_notice_v1';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const getDefaultToolRuntime = () => {
  try {
    return globalThis?.window?.appBridge?.getWebSearchToolRuntime?.() || null;
  } catch {
    return null;
  }
};

export const hasAcknowledgedAdHocWebSearch = (storage = globalThis?.localStorage) => {
  try {
    return storage?.getItem?.(AD_HOC_WEB_SEARCH_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
};

export const acknowledgeAdHocWebSearch = (storage = globalThis?.localStorage) => {
  try {
    storage?.setItem?.(AD_HOC_WEB_SEARCH_NOTICE_KEY, '1');
    return true;
  } catch {
    return false;
  }
};

export const confirmAdHocWebSearchToggle = async ({
  toggleEl = null,
  confirm = null,
  storage = globalThis?.localStorage,
} = {}) => {
  if (toggleEl?.checked !== true) return false;
  if (hasAcknowledgedAdHocWebSearch(storage)) return true;
  const accepted = typeof confirm === 'function' ? await confirm() : false;
  if (accepted !== true) {
    if (toggleEl) toggleEl.checked = false;
    return false;
  }
  acknowledgeAdHocWebSearch(storage);
  return true;
};

export const consumeAdHocWebSearchToggle = (toggleEl = null) => {
  const enabled = toggleEl?.checked === true;
  if (toggleEl) toggleEl.checked = false;
  return enabled;
};

export const createAdHocWebSearchToggleRuntime = ({
  toggleEl = null,
  confirm = null,
  storage = globalThis?.localStorage,
} = {}) => {
  let confirmationPromise = null;
  const confirmEnabled = () => {
    if (toggleEl?.checked !== true) return Promise.resolve(false);
    if (!confirmationPromise) {
      confirmationPromise = Promise.resolve(confirmAdHocWebSearchToggle({ toggleEl, confirm, storage }))
        .finally(() => { confirmationPromise = null; });
    }
    return confirmationPromise;
  };
  return {
    confirmEnabled,
    async consume() {
      const allowed = await confirmEnabled();
      return allowed === true ? consumeAdHocWebSearchToggle(toggleEl) : false;
    },
    reset() {
      if (toggleEl) toggleEl.checked = false;
    },
  };
};

export const renderAdHocWebSources = (container = null, sources = [], {
  documentRef = globalThis?.document || null,
} = {}) => {
  const normalized = mergeWebSources(sources || []);
  if (!container || !documentRef?.createElement) return normalized;
  container.replaceChildren?.();
  container.hidden = normalized.length === 0;
  if (!normalized.length) return normalized;
  const label = documentRef.createElement('span');
  label.className = 'ad-hoc-web-sources-label';
  label.textContent = '来源';
  container.appendChild(label);
  normalized.forEach((source) => {
    const link = documentRef.createElement('a');
    link.className = 'ad-hoc-web-source-link';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = trim(source.title, source.url);
    if (source.snippet) link.title = source.snippet;
    container.appendChild(link);
  });
  return normalized;
};

export const buildAdHocWebSearchRuntime = ({
  client = null,
  config = {},
  enabled = false,
  sessionId = '',
  requestOptions = {},
  toolRuntime = undefined,
  onStatus = null,
  onSources = null,
  onSearchOutcome = null,
  // 原生联网失败后的回退：按非原生服务商规划，改用 APP 搜索工具（实际请求仍发给原模型）
  forceToolFallback = false,
} = {}) => {
  const baseOptions = requestOptions && typeof requestOptions === 'object' ? { ...requestOptions } : {};
  if (baseOptions.requestContext || sessionId) {
    baseOptions.requestContext = captureRequestContext(baseOptions.requestContext || { sessionId });
  }
  const runtime = toolRuntime === undefined ? getDefaultToolRuntime() : toolRuntime;
  const fallbackToolDefinitions = ['web.search', 'web.research', 'web.fetch_url']
    .map(name => runtime?.getTool?.(name))
    .filter(Boolean);
  const plan = buildWebSearchRequestPlan({
    enabled: enabled === true,
    provider: forceToolFallback ? 'app_tool_fallback' : config?.provider,
    baseUrl: config?.baseUrl,
    model: config?.model,
    existingOptions: [baseOptions],
    fallbackToolDefinitions,
  });
  const notifyStatus = (status = {}) => {
    try { onStatus?.(status); } catch {}
  };
  if (enabled === true && plan.enabled !== true) {
    notifyStatus({
      state: 'unavailable',
      message: '当前模型暂不支持本次联网，将继续普通生成。',
      reason: trim(plan?.diagnostics?.reason, 'web search unavailable'),
    });
    return { client, requestOptions: baseOptions, plan };
  }
  if (plan.enabled !== true) return { client, requestOptions: baseOptions, plan };

  let collectedSources = [];
  const originalSources = baseOptions.onProviderSources;
  const mergedOptions = {
    ...baseOptions,
    ...(plan.requestOptions || {}),
    onProviderSources: (sources, meta = {}) => {
      try { originalSources?.(sources, meta); } catch {}
      collectedSources = mergeWebSources(collectedSources, sources || []);
      try { onSources?.(collectedSources.slice(), meta); } catch {}
      if (collectedSources.length && plan.native === true) {
        notifyStatus({ state: 'done', message: '已取得联网资料。' });
      }
    },
    onProviderSearchActivity: (activity = {}) => {
      notifyStatus({
        ...activity,
        message: activity?.state === 'done'
          ? '供应方原生联网搜索完成。'
          : '供应方正在原生联网搜索…',
      });
    },
  };
  if (plan.fallback === true || plan.route === 'kimi_native') {
    const originalStatus = baseOptions.onWebSearchStatus;
    mergedOptions.onWebSearchStatus = (status = {}) => {
      try { originalStatus?.(status); } catch {}
      notifyStatus(status);
    };
  }
  notifyStatus({ state: 'ready', message: '已允许本次联网，正在生成…' });
  const generationClient = createWebSearchGenerationClient({
    client,
    plan,
    toolRuntime: runtime,
    provider: config?.provider,
    model: config?.model,
    sessionId,
    onSearchOutcome,
  });
  return { client: generationClient, requestOptions: mergedOptions, plan };
};

const isAbortError = error => error?.name === 'AbortError';

const readErrorStatus = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (Number.isFinite(status) && status > 0) return status;
  const match = String(error?.message || '').match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : 0;
};

// 鉴权类错误与联网无关，换联网方式重试只会重复失败
const isRetryableWebSearchFailure = error => !isAbortError(error) && ![401, 403].includes(readErrorStatus(error));

// 报错时写明实际调用的服务商与模型，便于分辨是谁返回的错误（如 429）
export const describeAdHocModel = (config = {}) => [trim(config?.provider), trim(config?.model)].filter(Boolean).join(' · ');

const shortError = error => trim(error?.message, '未知错误').slice(0, 120);

// 带回退的单次生成：原生联网 → 失败改用 APP 搜索服务 → 仍失败或不可用则不联网生成。
// 返回 { output, route: 'native' | 'tool' | 'none', degraded }；中止与鉴权错误直接抛出。
export const runAdHocWebSearchChat = async ({
  client = null,
  config = {},
  enabled = false,
  sessionId = '',
  requestOptions = {},
  messages = [],
  toolRuntime = undefined,
  onStatus = null,
  onSources = null,
} = {}) => {
  const notify = (status) => { try { onStatus?.(status); } catch {} };
  const build = (extra = {}) => {
    const attempt = { sources: [], sourceMeta: {}, outcome: null };
    const generation = buildAdHocWebSearchRuntime({
      client, config, enabled, sessionId, toolRuntime, onStatus, ...extra,
      // 每次尝试独立收集来源。chat 成功后才提交，避免失败响应污染降级回答。
      requestOptions: {
        ...requestOptions,
        onProviderSources: (sources, meta = {}) => {
          attempt.sources = mergeWebSources(attempt.sources, sources || []);
          attempt.sourceMeta = meta;
        },
      },
      onSearchOutcome: outcome => { attempt.outcome = outcome; },
    });
    return { ...generation, attempt };
  };
  const first = build();
  const reason = String(first.plan?.diagnostics?.reason || '');
  const complete = async (generation, degraded = false) => {
    const output = await generation.client.chat(messages, generation.requestOptions);
    const { attempt, plan } = generation;
    const route = plan?.enabled !== true ? 'none'
      : (plan.native === true ? 'native' : (attempt.outcome?.succeeded > 0 ? 'tool' : 'none'));
    const sources = route === 'none' ? [] : attempt.sources.slice();
    try { requestOptions?.onProviderSources?.(sources, attempt.sourceMeta); } catch {}
    try { onSources?.(sources, attempt.sourceMeta); } catch {}
    return {
      output,
      route,
      degraded: degraded || (plan?.fallback === true && attempt.outcome?.failed > 0),
      reason: attempt.outcome?.reason || reason,
    };
  };
  try {
    return await complete(first);
  } catch (error) {
    if (first.plan?.enabled !== true || !isRetryableWebSearchFailure(error)) throw error;
    if (first.plan.native === true) {
      const viaTools = build({ forceToolFallback: true });
      if (viaTools.plan?.enabled === true) {
        notify({ state: 'fallback', message: `原生联网失败（${shortError(error)}），改用搜索服务…` });
        try {
          return await complete(viaTools, true);
        } catch (toolError) {
          if (!isRetryableWebSearchFailure(toolError)) throw toolError;
          notify({ state: 'fallback', message: `搜索服务也失败（${shortError(toolError)}），改为不联网生成…` });
        }
      } else {
        notify({ state: 'fallback', message: `原生联网失败（${shortError(error)}），未配置可用的搜索服务，改为不联网生成…` });
      }
    } else {
      notify({ state: 'fallback', message: `联网失败（${shortError(error)}），改为不联网生成…` });
    }
    const plain = build({ enabled: false, onStatus: null });
    return complete(plain, true);
  }
};
