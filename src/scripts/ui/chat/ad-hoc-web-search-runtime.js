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
    provider: config?.provider,
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
  });
  return { client: generationClient, requestOptions: mergedOptions, plan };
};
