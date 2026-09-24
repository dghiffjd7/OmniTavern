import { captureRequestContext } from '../api/request-context.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const createMaidRuntimeConfigResolver = ({
  settingsStore = null,
  configManager = null,
  createClient = null,
  isConfigReady = () => false,
  // Phase B：Sub-agent 来源改由统一 Agent Registry 提供（投影为 planner 兼容形状）；
  // 缺省回退到直接读 settingsStore，保持既有行为与单测不变。
  getSubAgents = null,
  logger = console,
} = {}) => async (context = {}) => {
  const requestContext = captureRequestContext(context.requestContext || { sessionId: context.sessionId || 'maid' });
  const profileId = trim(settingsStore?.getBoundProfileId?.());
  const modelOverride = trim(settingsStore?.getBoundModelOverride?.());
  const fallbackProfileId = trim(settingsStore?.getFallbackProfileId?.());
  const rawSubAgents = typeof getSubAgents === 'function'
    ? (getSubAgents() || [])
    : (settingsStore?.listSubAgents?.() || []);
  const subAgents = rawSubAgents.filter(item => item?.enabled !== false);
  const maidPrompt = trim(settingsStore?.getMaidPrompt?.() || settingsStore?.getPersonaPrompt?.());
  // 女仆思考设置随运行时下发，由各调用按实际模型（主档/降级档/语音档）换成对应参数
  const generationSettings = settingsStore?.getGenerationSettings?.() || null;
  if (!profileId) {
    return {
      configured: false,
      bound: false,
      profileId: '',
      maidPrompt,
      personaPrompt: maidPrompt,
      generationSettings,
      reason: 'maid_profile_not_bound',
      subAgents,
    };
  }

  try {
    await configManager?.ensureStores?.();
    let config = await configManager?.getRuntimeConfigByProfileId?.(profileId);
    if (isPlainObject(config) && modelOverride) {
      config = { ...config, model: modelOverride };
    }
    if (!isPlainObject(config)) {
      return {
        configured: false,
        bound: true,
        profileId,
        maidPrompt,
        personaPrompt: maidPrompt,
        generationSettings,
        reason: 'maid_profile_missing',
        subAgents,
      };
    }
    const ready = Boolean(isConfigReady(config));
    // 女仆 planner/ReAct 输出为小 JSON，超时不应继承聊天档的超长配置（如 100 分钟）——
    // 上限 240s 走 Rust 请求层，不受窗口后台 timer 冻结影响。
    const cappedConfig = {
      ...config,
      requestContext,
      timeout: Math.min(Number(config.timeout) > 0 ? Number(config.timeout) : 240000, 240000),
    };
    const client = ready && typeof createClient === 'function' ? createClient(cappedConfig) : null;
    // 主档故障降级：配置了 fallback 档时提供备用 client（调用方在主档请求失败时重试一次）
    let fallbackClient = null;
    let fallbackConfig = null;
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const rawFallbackConfig = await configManager?.getRuntimeConfigByProfileId?.(fallbackProfileId);
        if (isPlainObject(rawFallbackConfig) && isConfigReady(rawFallbackConfig) && typeof createClient === 'function') {
          fallbackConfig = {
            ...rawFallbackConfig,
            requestContext,
            timeout: Math.min(Number(rawFallbackConfig.timeout) > 0 ? Number(rawFallbackConfig.timeout) : 240000, 240000),
          };
          fallbackClient = createClient(fallbackConfig);
        }
      } catch {}
    }
    return {
      configured: Boolean(client),
      bound: true,
      config,
      client,
      fallbackClient,
      fallbackConfig,
      fallbackProfileId: fallbackClient ? fallbackProfileId : '',
      subAgents,
      profileId,
      maidPrompt,
      personaPrompt: maidPrompt,
      generationSettings,
      bindingSource: 'maid',
      reason: client ? '' : 'maid_profile_incomplete',
    };
  } catch (error) {
    logger?.warn?.('maid runtime config resolve failed', error);
    return {
      configured: false,
      bound: true,
      profileId,
      maidPrompt,
      personaPrompt: maidPrompt,
      generationSettings,
      reason: error?.message || 'maid_profile_error',
      subAgents,
      error,
    };
  }
};

export const createMaidMemoryExtractionRuntimeResolver = ({
  settingsStore = null,
  configManager = null,
  resolveMainRuntime = null,
  createClient = null,
  isConfigReady = () => false,
  logger = console,
} = {}) => async (context = {}) => {
  const requestContext = captureRequestContext(context.requestContext || { sessionId: context.sessionId || 'maid' });
  const selection = settingsStore?.getMemoryExtractionSettings?.() || {};
  const mode = trim(selection?.mode).toLowerCase() === 'custom' ? 'custom' : 'follow_main';
  const fallbackToMain = selection?.fallbackToMain === true;
  const resolveMain = async () => {
    if (typeof resolveMainRuntime !== 'function') return null;
    return resolveMainRuntime({
      ...context,
      requestContext,
      taskType: 'maid_memory_extract',
      uiMode: 'maid',
    });
  };

  if (mode !== 'custom') {
    const mainRuntime = await resolveMain();
    return {
      ...(isPlainObject(mainRuntime) ? mainRuntime : {}),
      memoryExtractionMode: 'follow_main',
      memoryExtractionModelSource: 'maid_main',
      memoryExtractionFallbackToMain: false,
      extractionFallbackClient: null,
      extractionFallbackConfig: null,
    };
  }

  const profileId = trim(selection?.profileId);
  const modelOverride = trim(selection?.modelOverride);
  let mainRuntime = null;
  if (fallbackToMain) {
    try {
      mainRuntime = await resolveMain();
    } catch (error) {
      logger?.warn?.('maid memory extraction main fallback resolve failed', error);
    }
  }
  const extractionFallbackClient = mainRuntime?.configured && mainRuntime?.client
    ? mainRuntime.client
    : null;
  const extractionFallbackConfig = extractionFallbackClient && isPlainObject(mainRuntime?.config)
    ? mainRuntime.config
    : null;

  let config = null;
  let client = null;
  let reason = profileId ? 'memory_extraction_profile_missing' : 'memory_extraction_profile_not_bound';
  try {
    await configManager?.ensureStores?.();
    const rawConfig = profileId
      ? await configManager?.getRuntimeConfigByProfileId?.(profileId)
      : null;
    if (isPlainObject(rawConfig)) {
      config = {
        ...rawConfig,
        requestContext,
        ...(modelOverride ? { model: modelOverride } : {}),
        timeout: Math.min(Number(rawConfig.timeout) > 0 ? Number(rawConfig.timeout) : 240000, 240000),
      };
      if (isConfigReady(config) && typeof createClient === 'function') {
        client = createClient(config);
        reason = '';
      } else {
        reason = 'memory_extraction_profile_incomplete';
      }
    }
  } catch (error) {
    reason = error?.message || 'memory_extraction_profile_error';
    logger?.warn?.('maid memory extraction runtime resolve failed', error);
  }

  return {
    configured: Boolean(client || extractionFallbackClient),
    bound: Boolean(profileId),
    profileId,
    config,
    client,
    reason: client || extractionFallbackClient ? '' : reason,
    memoryExtractionMode: 'custom',
    memoryExtractionModelSource: 'custom',
    memoryExtractionFallbackToMain: fallbackToMain,
    extractionFallbackClient,
    extractionFallbackConfig,
    extractionFallbackProfileId: extractionFallbackClient
      ? trim(mainRuntime?.profileId)
      : '',
  };
};

export const isMaidRuntimeConfigured = async (resolveRuntimeConfig = null) => {
  if (typeof resolveRuntimeConfig !== 'function') return false;
  const runtime = await resolveRuntimeConfig();
  return Boolean(runtime?.configured && runtime?.client);
};
