import { canInitClient } from '../api/client-config-utils.js';
import { captureRequestContext } from '../api/request-context.js';
import { createProviderToolLlmClientNativeRunner } from './provider-tool-llmclient-native-runner.js';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const readTimestamp = (now = Date.now) => Number(now?.() || Date.now()) || Date.now();

const normalizeProviderFamily = (provider = '') => {
  const value = trim(provider).toLowerCase();
  if (value.includes('anthropic') || value.includes('claude')) return 'anthropic';
  if (value.includes('gemini') || value.includes('maker') || value.includes('vertex')) return 'gemini';
  if (value.includes('openai') || value.includes('custom') || value.includes('deepseek') || value === 'opencode') return 'openai';
  return value || 'generic';
};

const sanitizeConfig = (config = {}) => {
  const source = isPlainObject(config) ? config : {};
  return {
    provider: trim(source.provider),
    model: trim(source.model),
    baseUrl: trim(source.baseUrl),
    stream: source.stream === true,
    configured: canInitClient(source),
  };
};

const sanitizeRuntime = (runtime = {}) => {
  const source = isPlainObject(runtime) ? runtime : {};
  return {
    profileId: trim(source.profileId),
    bindingSource: trim(source.bindingSource, 'global'),
    bound: source.bound === true,
    sessionId: trim(source.sessionId),
    uiMode: trim(source.uiMode),
  };
};

const buildResult = ({
  ok = false,
  status = 'blocked',
  reason = '',
  providerClient = null,
  clientKind = '',
  runtime = null,
  config = {},
  sessionGate = null,
  runnerRequestOptions = {},
  now = Date.now,
} = {}) => {
  const sanitizedConfig = sanitizeConfig(config);
  const diagnostics = {
    ok: ok === true,
    status: trim(status, ok === true ? 'ready' : 'blocked'),
    reason: trim(reason),
    source: 'current_provider_config',
    provider: sanitizedConfig.provider,
    model: sanitizedConfig.model,
    providerFamily: normalizeProviderFamily(sanitizedConfig.provider),
    clientKind: trim(clientKind),
    config: sanitizedConfig,
    runtime: sanitizeRuntime(runtime),
    sessionGate: {
      enabled: sessionGate?.enabled === true,
      networkAllowed: sessionGate?.networkAllowed === true,
      realRunnerAllowed: sessionGate?.realRunnerAllowed === true,
      writesChat: sessionGate?.writesChat === true,
    },
    network: ok === true,
    writesChat: false,
    rollback: 'disable providerToolSessionGate or call without allowCurrentProviderRunner',
    createdAt: readTimestamp(now),
  };
  return {
    ok: ok === true,
    status: diagnostics.status,
    reason: diagnostics.reason,
    providerClient: ok === true ? providerClient : null,
    runnerRequestOptions: ok === true && isPlainObject(runnerRequestOptions) ? runnerRequestOptions : {},
    diagnostics,
  };
};

const resolveBridgeRuntime = async ({
  bridge = null,
  sessionId = '',
  uiMode = '',
  taskType = '',
} = {}) => {
  if (typeof bridge?.resolveRequestRuntimeConfig === 'function') {
    return await bridge.resolveRequestRuntimeConfig({
      sessionId,
      uiMode,
      taskType,
    });
  }
  const config = typeof bridge?.getConfig === 'function'
    ? bridge.getConfig()
    : (isPlainObject(bridge?.config) && typeof bridge.config.get === 'function' ? bridge.config.get() : {});
  return {
    config: isPlainObject(config) ? config : {},
    client: null,
    profileId: typeof bridge?.getActiveConfigProfileId === 'function' ? bridge.getActiveConfigProfileId() : '',
    bindingSource: 'global',
    bound: false,
    sessionId,
    uiMode,
  };
};

const createClientFromRuntime = ({
  runtime = null,
  createClient = null,
} = {}) => {
  if (runtime?.client) return runtime.client;
  const config = isPlainObject(runtime?.config) ? runtime.config : {};
  if (!canInitClient(config)) return null;
  if (typeof createClient !== 'function') return null;
  return createClient(config);
};

const buildProviderClient = ({
  llmClient = null,
  provider = '',
  providerApi = '',
  useNativeRunnerShim = true,
  now = Date.now,
} = {}) => {
  const family = normalizeProviderFamily(provider);
  if ((family === 'anthropic' || family === 'gemini' || (
    family === 'openai' && trim(providerApi) === 'openai_responses'
  )) && useNativeRunnerShim !== false) {
    return {
      providerClient: createProviderToolLlmClientNativeRunner({
        llmClient,
        now,
      }),
      clientKind: 'llmclient_native_shim',
    };
  }
  return {
    providerClient: llmClient,
    clientKind: 'llmclient_stream_chat',
  };
};

export const resolveProviderToolCurrentRunnerClient = async ({
  bridge = null,
  sessionId = '',
  uiMode = '',
  taskType = '',
  sessionGate = null,
  enabled = false,
  allowCurrentProviderRunner = false,
  allowRunnerNetwork = false,
  createClient = null,
  useNativeRunnerShim = true,
  providerApi = '',
  requestId = '',
  now = Date.now,
} = {}) => {
  const gate = isPlainObject(sessionGate) ? sessionGate : {};
  const requestContext = captureRequestContext({ sessionId });
  if (enabled !== true) {
    return buildResult({
      status: 'disabled',
      reason: 'current provider runner client disabled',
      sessionGate: gate,
      now,
    });
  }
  if (allowCurrentProviderRunner !== true || allowRunnerNetwork !== true) {
    return buildResult({
      status: 'blocked',
      reason: 'current provider runner requires explicit runner and network allowance',
      sessionGate: gate,
      now,
    });
  }
  if (gate.enabled !== true || gate.realRunnerAllowed !== true || gate.networkAllowed !== true) {
    return buildResult({
      status: 'blocked',
      reason: 'current provider runner blocked by session gate',
      sessionGate: gate,
      now,
    });
  }

  let runtime = null;
  try {
    runtime = await resolveBridgeRuntime({
      bridge,
      sessionId,
      uiMode,
      taskType,
    });
  } catch (error) {
    return buildResult({
      status: 'blocked',
      reason: trim(error?.message, 'current provider config unavailable'),
      sessionGate: gate,
      now,
    });
  }

  const config = isPlainObject(runtime?.config) ? runtime.config : {};
  let llmClient = null;
  try {
    llmClient = createClientFromRuntime({ runtime, createClient });
  } catch (error) {
    return buildResult({
      status: 'blocked',
      reason: trim(error?.message, 'current provider client creation failed'),
      runtime,
      config,
      sessionGate: gate,
      now,
    });
  }
  if (!llmClient) {
    return buildResult({
      status: 'blocked',
      reason: 'current provider config is not ready',
      runtime,
      config,
      sessionGate: gate,
      now,
    });
  }

  const { providerClient, clientKind } = buildProviderClient({
    llmClient,
    provider: config.provider,
    providerApi,
    useNativeRunnerShim,
    now,
  });
  if (!providerClient ||
    (typeof providerClient.streamChat !== 'function' &&
      typeof providerClient.chat !== 'function' &&
      typeof providerClient.runProviderToolRequest !== 'function')) {
    return buildResult({
      status: 'blocked',
      reason: 'current provider client cannot run provider continuation',
      runtime,
      config,
      sessionGate: gate,
      now,
    });
  }

  return buildResult({
    ok: true,
    status: 'ready',
    providerClient,
    clientKind,
    runtime,
    config,
    sessionGate: gate,
    runnerRequestOptions: {
      requestContext,
      requestId: trim(requestId, `provider-tool-current-runner:${readTimestamp(now)}`),
      source: 'provider-tool-current-runner',
      configProfileId: trim(runtime?.profileId),
    },
    now,
  });
};
