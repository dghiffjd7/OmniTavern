export const AGENT_RUN_SCHEMA_VERSION = 2;

// Phase B 真实计量：AgentRun 的 provider usage/延迟/降级/中止画像。
// 硬约束——token 类指标 provider 不返回时 status='unknown' 且各字段为 null，绝不自行估算。
// modelCallCount/toolCallCount/latencyMs/aborted/degraded 是本地可得事实，与 provider usage 是否可用无关。
export const AGENT_USAGE_STATUSES = Object.freeze(['unknown', 'recorded']);
const USAGE_STATUS_SET = new Set(AGENT_USAGE_STATUSES);

const toNullableTokenCount = (value) => {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
};

const toNullableMetric = (value, { integer = false } = {}) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return integer ? Math.trunc(numeric) : numeric;
};

const responseIdentity = value => String(value ?? '').trim().slice(0, 512);

const normalizeProviderCallUsage = (raw = {}) => {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const promptTokens = toNullableTokenCount(src.promptTokens ?? src.prompt_tokens);
  const completionTokens = toNullableTokenCount(src.completionTokens ?? src.completion_tokens);
  const totalTokensRaw = toNullableTokenCount(src.totalTokens ?? src.total_tokens);
  const totalTokens = totalTokensRaw != null
    ? totalTokensRaw
    : (promptTokens != null || completionTokens != null ? (promptTokens || 0) + (completionTokens || 0) : null);
  return {
    callIndex: Math.max(0, Math.trunc(Number(src.callIndex ?? src.call_index)) || 0),
    mode: responseIdentity(src.mode),
    outcome: responseIdentity(src.outcome),
    provider: responseIdentity(src.provider),
    model: responseIdentity(src.model),
    stream: src.stream === true,
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs: toNullableMetric(src.latencyMs ?? src.latency_ms, { integer: true }),
    firstMeaningfulDeltaLatencyMs: toNullableMetric(
      src.firstMeaningfulDeltaLatencyMs ?? src.firstTokenLatencyMs,
      { integer: true },
    ),
    outputDurationMs: toNullableMetric(src.outputDurationMs, { integer: true }),
    tokensPerSecond: toNullableMetric(src.tokensPerSecond),
    outputSpeedStatus: responseIdentity(src.outputSpeedStatus),
    streamDeltaCount: toNullableMetric(src.streamDeltaCount, { integer: true }),
    streamObservedDurationMs: toNullableMetric(src.streamObservedDurationMs, { integer: true }),
    finishReason: responseIdentity(src.finishReason ?? src.finish_reason),
    systemFingerprint: responseIdentity(src.systemFingerprint ?? src.system_fingerprint),
    modelVersion: responseIdentity(src.modelVersion ?? src.model_version),
    responseId: responseIdentity(src.responseId ?? src.response_id),
    responseModel: responseIdentity(src.responseModel ?? src.response_model),
    routedProvider: responseIdentity(src.routedProvider ?? src.routed_provider),
  };
};

export const normalizeAgentUsage = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const promptTokens = toNullableTokenCount(src.promptTokens ?? src.prompt_tokens ?? src.inputTokens ?? src.input_tokens);
  const completionTokens = toNullableTokenCount(src.completionTokens ?? src.completion_tokens ?? src.outputTokens ?? src.output_tokens);
  const totalTokensRaw = toNullableTokenCount(src.totalTokens ?? src.total_tokens);
  const totalTokens = totalTokensRaw != null
    ? totalTokensRaw
    : (promptTokens != null || completionTokens != null ? (promptTokens || 0) + (completionTokens || 0) : null);
  const hasTokens = promptTokens != null || completionTokens != null || totalTokens != null;
  // status 显式声明优先；否则由是否拿到 token 推断，不猜。
  const declared = trimString(src.status, '').toLowerCase();
  const status = USAGE_STATUS_SET.has(declared) ? declared : (hasTokens ? 'recorded' : 'unknown');
  const normalized = {
    status,
    provider: trimString(src.provider, ''),
    model: trimString(src.model, ''),
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs: toNullableTokenCount(src.latencyMs ?? src.latency_ms),
    modelCallCount: Math.max(0, Math.trunc(Number(src.modelCallCount ?? src.model_call_count)) || 0),
    toolCallCount: Math.max(0, Math.trunc(Number(src.toolCallCount ?? src.tool_call_count)) || 0),
    degraded: src.degraded === true,
    aborted: src.aborted === true,
    finishReason: trimString(src.finishReason ?? src.finish_reason, ''),
  };
  const optionalMetrics = {
    firstTokenLatencyMs: toNullableMetric(src.firstTokenLatencyMs, { integer: true }),
    firstMeaningfulDeltaLatencyMs: toNullableMetric(
      src.firstMeaningfulDeltaLatencyMs ?? src.firstTokenLatencyMs,
      { integer: true },
    ),
    firstUserVisibleRenderLatencyMs: toNullableMetric(src.firstUserVisibleRenderLatencyMs, { integer: true }),
    outputDurationMs: toNullableMetric(src.outputDurationMs, { integer: true }),
    tokensPerSecond: toNullableMetric(src.tokensPerSecond),
    streamDeltaCount: toNullableMetric(src.streamDeltaCount, { integer: true }),
    streamObservedDurationMs: toNullableMetric(src.streamObservedDurationMs, { integer: true }),
  };
  Object.entries(optionalMetrics).forEach(([key, value]) => {
    if (value != null) normalized[key] = value;
  });
  [
    ['outputSpeedStatus', src.outputSpeedStatus],
    ['systemFingerprint', src.systemFingerprint ?? src.system_fingerprint],
    ['modelVersion', src.modelVersion ?? src.model_version],
    ['responseId', src.responseId ?? src.response_id],
    ['responseModel', src.responseModel ?? src.response_model],
    ['routedProvider', src.routedProvider ?? src.routed_provider],
  ].forEach(([key, value]) => {
    const identity = responseIdentity(value);
    if (identity) normalized[key] = identity;
  });
  if (Array.isArray(src.providerCalls) && src.providerCalls.length) {
    normalized.providerCalls = src.providerCalls.slice(0, 12).map(normalizeProviderCallUsage);
  }
  return normalized;
};

export const AGENT_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_permission',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

export const AGENT_EVENT_TYPES = Object.freeze({
  runQueued: 'agent.run.queued',
  runStarted: 'agent.run.started',
  runUpdated: 'agent.run.updated',
  runFinished: 'agent.run.finished',
  stepStarted: 'agent.step.started',
  stepUpdated: 'agent.step.updated',
  stepFinished: 'agent.step.finished',
  toolStarted: 'agent.tool.started',
  toolFinished: 'agent.tool.finished',
  permissionRequested: 'agent.permission.requested',
});

const STATUS_SET = new Set(AGENT_STATUSES);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trimString = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const toFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeTimestamp = (value, fallback) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  return fallback;
};

export const cloneAgentValue = (value, fallback = null) => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (Array.isArray(value)) return value.slice();
    return isPlainObject(value) ? { ...value } : fallback;
  }
};

export const createAgentId = (prefix = 'agent') => {
  const head = trimString(prefix, 'agent').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${head}:${crypto.randomUUID()}`;
  }
  return `${head}:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

export const normalizeAgentStatus = (status = '', fallback = 'queued') => {
  const token = trimString(status, '').toLowerCase();
  if (STATUS_SET.has(token)) return token;
  return STATUS_SET.has(fallback) ? fallback : 'queued';
};

// 深度截断存储值：长字符串、大数组、深嵌套裁剪——run store 用于展示/恢复提示，不是数据源
export const truncateAgentValue = (value, {
  maxString = 600,
  maxArrayItems = 12,
  maxKeys = 30,
  maxDepth = 4,
} = {}, depth = 0) => {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}…[truncated ${value.length}]` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[nested…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map(item => truncateAgentValue(item, { maxString, maxArrayItems, maxKeys, maxDepth }, depth + 1));
    if (value.length > maxArrayItems) items.push(`…[+${value.length - maxArrayItems} more]`);
    return items;
  }
  const out = {};
  const keys = Object.keys(value);
  keys.slice(0, maxKeys).forEach((key) => {
    out[key] = truncateAgentValue(value[key], { maxString, maxArrayItems, maxKeys, maxDepth }, depth + 1);
  });
  if (keys.length > maxKeys) out['…'] = `+${keys.length - maxKeys} keys`;
  return out;
};

export const normalizeAgentStep = (raw = {}, {
  runId = '',
  stepId = '',
  now = Date.now,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const fallbackNow = normalizeTimestamp(now?.(), Date.now());
  const startedAt = normalizeTimestamp(src.startedAt ?? src.createdAt, fallbackNow);
  const finishedAt = src.finishedAt == null ? null : normalizeTimestamp(src.finishedAt, startedAt);
  const id = trimString(src.id || src.stepId || stepId, createAgentId('step'));
  return {
    id,
    runId: trimString(src.runId || runId, ''),
    type: trimString(src.type || src.kind, 'task'),
    title: trimString(src.title, ''),
    status: normalizeAgentStatus(src.status, finishedAt == null ? 'running' : 'succeeded'),
    summary: trimString(src.summary, ''),
    input: truncateAgentValue(cloneAgentValue(src.input, null)),
    output: truncateAgentValue(cloneAgentValue(src.output, null)),
    metadata: isPlainObject(src.metadata) ? truncateAgentValue(cloneAgentValue(src.metadata, {})) : {},
    errorMessage: trimString(src.errorMessage || src.error, ''),
    startedAt,
    updatedAt: normalizeTimestamp(src.updatedAt, finishedAt ?? startedAt),
    finishedAt,
  };
};

export const normalizeAgentToolCall = (raw = {}, {
  runId = '',
  stepId = '',
  toolCallId = '',
  now = Date.now,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const fallbackNow = normalizeTimestamp(now?.(), Date.now());
  const startedAt = normalizeTimestamp(src.startedAt ?? src.createdAt, fallbackNow);
  const finishedAt = src.finishedAt == null ? null : normalizeTimestamp(src.finishedAt, startedAt);
  const id = trimString(src.id || src.toolCallId || toolCallId, createAgentId('tool'));
  return {
    id,
    runId: trimString(src.runId || runId, ''),
    stepId: trimString(src.stepId || stepId, ''),
    toolName: trimString(src.toolName || src.name, ''),
    status: normalizeAgentStatus(src.status, finishedAt == null ? 'running' : 'succeeded'),
    args: cloneAgentValue(src.args, null),
    result: cloneAgentValue(src.result, null),
    metadata: isPlainObject(src.metadata) ? cloneAgentValue(src.metadata, {}) : {},
    errorMessage: trimString(src.errorMessage || src.error, ''),
    startedAt,
    updatedAt: normalizeTimestamp(src.updatedAt, finishedAt ?? startedAt),
    finishedAt,
  };
};

export const normalizeAgentRun = (raw = {}, {
  runId = '',
  now = Date.now,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const fallbackNow = normalizeTimestamp(now?.(), Date.now());
  const createdAt = normalizeTimestamp(src.createdAt ?? src.startedAt, fallbackNow);
  const finishedAt = src.finishedAt == null ? null : normalizeTimestamp(src.finishedAt, createdAt);
  const id = trimString(src.id || src.runId || runId, createAgentId('run'));
  const statusFallback = src.status ? 'queued' : (finishedAt == null ? 'queued' : 'succeeded');
  return {
    id,
    version: AGENT_RUN_SCHEMA_VERSION,
    kind: trimString(src.kind || src.type, 'task'),
    title: trimString(src.title, ''),
    sessionId: trimString(src.sessionId, ''),
    surface: trimString(src.surface, ''),
    trigger: trimString(src.trigger, ''),
    source: trimString(src.source, 'agent-task-runtime'),
    status: normalizeAgentStatus(src.status, statusFallback),
    summary: trimString(src.summary, ''),
    errorMessage: trimString(src.errorMessage || src.error, ''),
    cancelReason: trimString(src.cancelReason, ''),
    exportable: src.exportable !== false,
    usage: normalizeAgentUsage(src.usage),
    metadata: isPlainObject(src.metadata) ? cloneAgentValue(src.metadata, {}) : {},
    steps: (Array.isArray(src.steps) ? src.steps : [])
      .map(step => normalizeAgentStep(step, { runId: id, now })),
    toolCalls: (Array.isArray(src.toolCalls) ? src.toolCalls : [])
      .map(call => normalizeAgentToolCall(call, { runId: id, now })),
    createdAt,
    updatedAt: normalizeTimestamp(src.updatedAt, finishedAt ?? createdAt),
    finishedAt,
  };
};

export const normalizeAgentEvent = (raw = {}, {
  eventId = '',
  now = Date.now,
} = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const createdAt = normalizeTimestamp(src.createdAt ?? src.startedAt, normalizeTimestamp(now?.(), Date.now()));
  return {
    id: trimString(src.id || src.eventId || eventId, createAgentId('event')),
    type: trimString(src.type, AGENT_EVENT_TYPES.runUpdated),
    runId: trimString(src.runId, ''),
    stepId: trimString(src.stepId, ''),
    toolCallId: trimString(src.toolCallId, ''),
    sessionId: trimString(src.sessionId, ''),
    source: trimString(src.source, 'agent-task-runtime'),
    status: normalizeAgentStatus(src.status, 'running'),
    summary: trimString(src.summary, ''),
    details: isPlainObject(src.details) ? cloneAgentValue(src.details, {}) : {},
    createdAt,
  };
};

export const buildAgentTraceEvent = (event = {}) => {
  const normalized = normalizeAgentEvent(event);
  return {
    category: 'agent',
    phase: normalized.type.replace(/^agent\./, ''),
    sessionId: normalized.sessionId,
    source: normalized.source,
    status: normalized.status,
    startedAt: normalized.createdAt,
    summary: normalized.summary,
    details: {
      runId: normalized.runId,
      stepId: normalized.stepId,
      toolCallId: normalized.toolCallId,
      ...normalized.details,
    },
  };
};
