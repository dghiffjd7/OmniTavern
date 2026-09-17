const toTimestamp = (value) => {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.trunc(next) : null;
};

const toTokenCount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? Math.trunc(next) : null;
};

const toNonNegativeNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? next : null;
};

const identityText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || String(fallback ?? '').trim();
};

export const buildFirstTokenResponseDiagnostics = (current = null, {
  requestStartedAt = 0,
  firstTokenAt = 0,
  stream = true,
} = {}) => {
  const previous = current && typeof current === 'object' ? current : {};
  if (
    toTimestamp(previous.firstMeaningfulDeltaAt ?? previous.firstTokenAt)
    || toNonNegativeNumber(previous.firstMeaningfulDeltaLatencyMs ?? previous.firstTokenLatencyMs) !== null
  ) {
    return previous;
  }
  const startedAt = toTimestamp(requestStartedAt);
  const tokenAt = toTimestamp(firstTokenAt);
  if (!startedAt || !tokenAt || tokenAt < startedAt) return previous;
  return {
    ...previous,
    stream: Boolean(stream),
    firstTokenAt: tokenAt,
    firstTokenLatencyMs: tokenAt - startedAt,
    firstMeaningfulDeltaAt: tokenAt,
    firstMeaningfulDeltaLatencyMs: tokenAt - startedAt,
  };
};

export const buildFirstMeaningfulDeltaResponseDiagnostics = buildFirstTokenResponseDiagnostics;

// Below 100 ms, queued SSE events / worker messages can dominate the entire
// observed window. This is a measurement floor, not a cap on a model's speed.
const MIN_STREAM_SAMPLE_MS = 100;

export const resolveResponseOutputSpeed = (diagnostics = {}) => {
  const duration = toNonNegativeNumber(diagnostics.outputDurationMs);
  const count = toTokenCount(diagnostics.streamDeltaCount);
  const observed = toNonNegativeNumber(diagnostics.streamObservedDurationMs);
  const tokens = toTokenCount(diagnostics.completionTokens);
  let outputSpeedStatus = '';
  if (diagnostics.outputSpeedStatus === 'multiple_calls') outputSpeedStatus = 'multiple_calls';
  else if (diagnostics.stream !== true) outputSpeedStatus = 'non_stream';
  else if ((count !== null && count < 2)
    || (observed !== null && observed < MIN_STREAM_SAMPLE_MS)
    || (duration !== null && duration < MIN_STREAM_SAMPLE_MS)) outputSpeedStatus = 'insufficient_samples';
  else if (duration === null) outputSpeedStatus = 'missing_timing';
  else if (tokens === null || tokens === 0) outputSpeedStatus = 'missing_usage';
  else outputSpeedStatus = 'measured';
  return {
    outputSpeedStatus,
    tokensPerSecond: outputSpeedStatus === 'measured'
      ? Math.round((tokens * 1000 / duration) * 10) / 10
      : null,
  };
};

export const buildCompletedResponseDiagnostics = (current = null, {
  requestStartedAt = 0,
  completedAt = 0,
  usage = null,
  stream = null,
} = {}) => {
  const previous = current && typeof current === 'object' ? current : {};
  const startedAt = toTimestamp(requestStartedAt);
  const endedAt = toTimestamp(completedAt);
  const latencyMs = startedAt && endedAt && endedAt >= startedAt
    ? endedAt - startedAt
    : null;
  const firstMeaningfulDeltaAt = toTimestamp(
    previous.firstMeaningfulDeltaAt ?? previous.firstTokenAt,
  );
  const firstMeaningfulDeltaLatency = toNonNegativeNumber(
    previous.firstMeaningfulDeltaLatencyMs ?? previous.firstTokenLatencyMs,
  );
  const firstTokenLatencyMs = firstMeaningfulDeltaLatency === null
    ? null
    : Math.trunc(firstMeaningfulDeltaLatency);
  const outputDurationMs = latencyMs !== null && firstTokenLatencyMs !== null
    ? Math.max(0, latencyMs - firstTokenLatencyMs)
    : null;
  const completionTokens = toTokenCount(usage?.completionTokens);
  const streaming = stream === null ? Boolean(previous.stream) : Boolean(stream);
  const streamDeltaCount = toTokenCount(previous.streamDeltaCount);
  const lastDeltaAt = toTimestamp(previous.lastMeaningfulDeltaAt);
  const streamObservedDurationMs = firstMeaningfulDeltaAt && lastDeltaAt
    ? Math.max(0, lastDeltaAt - firstMeaningfulDeltaAt)
    : toNonNegativeNumber(previous.streamObservedDurationMs);
  const outputSpeed = resolveResponseOutputSpeed({
    stream: streaming, outputDurationMs, completionTokens, streamDeltaCount, streamObservedDurationMs,
  });

  return {
    ...previous,
    stream: streaming,
    completedAt: endedAt,
    latencyMs,
    firstMeaningfulDeltaAt,
    firstMeaningfulDeltaLatencyMs: firstTokenLatencyMs,
    firstTokenLatencyMs,
    outputDurationMs,
    streamDeltaCount,
    streamObservedDurationMs,
    ...outputSpeed,
    promptTokens: toTokenCount(usage?.promptTokens),
    completionTokens,
    totalTokens: toTokenCount(usage?.totalTokens),
    finishReason: String(usage?.finishReason || '').trim(),
    systemFingerprint: identityText(usage?.systemFingerprint, previous.systemFingerprint),
    modelVersion: identityText(usage?.modelVersion, previous.modelVersion),
    responseId: identityText(usage?.responseId, previous.responseId),
    responseModel: identityText(usage?.responseModel, previous.responseModel),
    routedProvider: identityText(usage?.routedProvider, previous.routedProvider),
    webSearchRequests: toTokenCount(usage?.webSearchRequests),
    webSearchTokens: toTokenCount(usage?.webSearchTokens),
    webSearchEngine: identityText(usage?.webSearchEngine, previous.webSearchEngine),
  };
};

export const mergeResponseDiagnosticsIntoUsage = (
  usage = null,
  responseDiagnostics = null,
  { providerCalls = [] } = {},
) => {
  const src = usage && typeof usage === 'object' ? usage : {};
  const diagnostics = responseDiagnostics && typeof responseDiagnostics === 'object'
    ? responseDiagnostics
    : {};
  const calls = Array.isArray(providerCalls) ? providerCalls.map(call => ({ ...call })) : [];
  if (!Object.keys(src).length && !Object.keys(diagnostics).length && !calls.length) return null;
  return {
    ...src,
    latencyMs: toTokenCount(diagnostics.latencyMs ?? src.latencyMs),
    firstTokenLatencyMs: toTokenCount(
      diagnostics.firstTokenLatencyMs
      ?? diagnostics.firstMeaningfulDeltaLatencyMs
      ?? src.firstTokenLatencyMs,
    ),
    firstMeaningfulDeltaLatencyMs: toTokenCount(
      diagnostics.firstMeaningfulDeltaLatencyMs
      ?? diagnostics.firstTokenLatencyMs
      ?? src.firstMeaningfulDeltaLatencyMs,
    ),
    outputDurationMs: toTokenCount(diagnostics.outputDurationMs ?? src.outputDurationMs),
    // A deliberately unavailable speed must clear an earlier provisional value.
    tokensPerSecond: toNonNegativeNumber(Object.hasOwn(diagnostics, 'tokensPerSecond')
      ? diagnostics.tokensPerSecond : src.tokensPerSecond),
    outputSpeedStatus: identityText(diagnostics.outputSpeedStatus, src.outputSpeedStatus),
    streamDeltaCount: toTokenCount(diagnostics.streamDeltaCount ?? src.streamDeltaCount),
    streamObservedDurationMs: toTokenCount(diagnostics.streamObservedDurationMs ?? src.streamObservedDurationMs),
    systemFingerprint: identityText(diagnostics.systemFingerprint, src.systemFingerprint),
    modelVersion: identityText(diagnostics.modelVersion, src.modelVersion),
    responseId: identityText(diagnostics.responseId, src.responseId),
    responseModel: identityText(diagnostics.responseModel, src.responseModel),
    routedProvider: identityText(diagnostics.routedProvider, src.routedProvider),
    webSearchRequests: toTokenCount(diagnostics.webSearchRequests ?? src.webSearchRequests),
    webSearchTokens: toTokenCount(diagnostics.webSearchTokens ?? src.webSearchTokens),
    webSearchEngine: identityText(diagnostics.webSearchEngine, src.webSearchEngine),
    ...(calls.length ? { providerCalls: calls } : {}),
  };
};
