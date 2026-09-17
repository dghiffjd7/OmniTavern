import { validateBuiltinPhoneFormat } from '../../utils/builtin-phone-format-contract.js';

const asObject = value => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const text = (value, fallback = '') => {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
};

const finiteNumber = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
};

const nonNegativeInteger = (value, fallback = null) => {
  const normalized = finiteNumber(value, fallback);
  return normalized === null ? null : Math.max(0, Math.trunc(normalized));
};

const nonNegativeNumber = (value, fallback = null) => {
  const normalized = finiteNumber(value, fallback);
  return normalized === null ? null : Math.max(0, normalized);
};

const diagnosticCode = (value, fallback = '') => {
  const normalized = text(value).slice(0, 96);
  if (!normalized) return fallback;
  return /^[\w.:-]+$/u.test(normalized) ? normalized : fallback;
};

const SAFE_SCHEMA_ENUM_VALUES = new Set([
  'text',
  'sticker',
  'voice',
  'transfer',
  'music',
  'image',
  'chat',
  'private_chat',
  'group_chat',
  'moment_post',
  'moment_comment',
  'image_prompt',
  'table_edit',
  'variable_update',
  'summary',
  'insert',
  'update',
  'delete',
  'replace',
  'delta',
  'add',
  'remove',
  'move',
]);

const redactSchemaNode = (value, depth = 0) => {
  if (depth > 16) return '[redacted:max-depth]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactSchemaNode(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.entries(value).slice(0, 200).forEach(([key, child]) => {
    if (key === 'description' || key === 'title' || key === 'examples' || key === 'default') return;
    if (key === 'enum' && Array.isArray(child)) {
      const safe = child.length > 0 && child.every(item => (
        typeof item === 'string' && SAFE_SCHEMA_ENUM_VALUES.has(item)
      ));
      out.enum = safe
        ? child.slice()
        : [`[redacted:${child.length} values]`];
      return;
    }
    if (key === 'const') {
      out.const = typeof child === 'string' && !SAFE_SCHEMA_ENUM_VALUES.has(child)
        ? '[redacted]'
        : child;
      return;
    }
    out[key] = redactSchemaNode(child, depth + 1);
  });
  return out;
};

export const redactProviderToolSchemaForDiagnostics = (tool = {}) => {
  const fn = asObject(tool?.function);
  const toolName = diagnosticCode(fn.name || tool?.name);
  const schema = asObject(fn.parameters || tool?.parameters || tool?.input_schema);
  return {
    schemaVersion: 1,
    redacted: true,
    toolName,
    schema: redactSchemaNode(schema),
  };
};

const countMatches = (source, pattern) => {
  const matches = String(source ?? '').match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
};

const findMarker = (source, pattern) => {
  const match = pattern.exec(String(source ?? ''));
  return match ? { index: match.index, length: match[0].length } : null;
};

const uniqueCodes = values => Array.from(new Set(
  (Array.isArray(values) ? values : [])
    .map(value => diagnosticCode(value))
    .filter(Boolean),
));

export const sanitizeProtocolDiagnosticCodes = (values = [], limit = 20) => (
  uniqueCodes(values).slice(0, Math.max(0, Math.trunc(Number(limit) || 0)))
);

const hasProtocolMarker = value => (
  /MiPhone_(?:start|end)|msg_(?:start|end)|moment_(?:reply_)?start|<\s*[^/][^>]*的私聊\s*>|<\s*群聊\s*[:：]/i
    .test(String(value ?? ''))
);

const resolveRequestedSurface = (request = {}) => {
  const taskType = diagnosticCode(request?.task?.type).toLowerCase();
  if (taskType === 'moment_comment') return 'moment_comment';
  if (request?.session?.isGroup === true) return 'group_chat';
  return request?.session?.id ? 'private_chat' : '';
};

const resolveThinkingFacts = (request = {}) => {
  const options = {
    ...asObject(request?.options),
    ...asObject(request?.requestOptions),
  };
  const thinking = asObject(options.thinking);
  const reasoning = asObject(options.reasoning);
  const effort = diagnosticCode(
    options.reasoning_effort
    || reasoning.effort
    || options.thinkingLevel
    || options.thinking_level,
  );
  const thinkingType = diagnosticCode(thinking.type);
  const hasThinkingBudget = finiteNumber(
    thinking.budget_tokens ?? options.thinkingBudget ?? options.thinking_budget,
  ) !== null;
  const enabled = Boolean(
    effort
    || hasThinkingBudget
    || (thinkingType && thinkingType !== 'disabled')
    || options.request_reasoning === true,
  );
  return {
    thinkingEnabled: enabled,
    thinkingMode: effort || thinkingType || (hasThinkingBudget ? 'budget' : (enabled ? 'enabled' : 'off')),
  };
};

const isTruncatedFinishReason = (value) => {
  const reason = diagnosticCode(value).toLowerCase();
  return reason === 'length'
    || reason === 'max_tokens'
    || reason === 'max_output_tokens'
    || reason === 'content_filter';
};

export const buildStructuredFailureShapeDiagnostics = ({
  raw = '',
  finishReason = '',
  maxTokens = 0,
  completionTokens = 0,
  validationErrors = [],
} = {}) => {
  const source = String(raw ?? '');
  const compact = source.trim();
  const safeFinishReason = diagnosticCode(finishReason).toLowerCase();
  const tokenLimit = nonNegativeInteger(maxTokens, 0) || 0;
  const usedTokens = nonNegativeInteger(completionTokens, 0) || 0;
  const startsWithObject = compact.startsWith('{');
  const endsWithObject = compact.endsWith('}');
  return {
    finishReason: safeFinishReason,
    characterCount: source.length,
    startsWithObject,
    endsWithObject,
    hasCodeFence: /```/u.test(source),
    hasTableEdit: /<\s*\/?\s*tableEdit\b/iu.test(source),
    hasProtocolMarker: hasProtocolMarker(source),
    truncationSuspected: isTruncatedFinishReason(safeFinishReason)
      || (tokenLimit > 0 && usedTokens >= tokenLimit)
      || (startsWithObject && !endsWithObject),
    validationCodes: sanitizeProtocolDiagnosticCodes(validationErrors),
  };
};

export const inspectProtocolRaw = (raw = '') => {
  const source = String(raw ?? '');
  const phoneStart = findMarker(source, /<\s*MiPhone_start\s*>|MiPhone_start/i);
  const phoneEnd = findMarker(source, /<\s*MiPhone_end\s*>|MiPhone_end/i);
  const messageStart = findMarker(source, /<\s*msg_start\s*>|msg_start/i);
  const messageEnd = findMarker(source, /<\s*msg_end\s*>|msg_end/i);
  const phoneStartCount = countMatches(source, /(?:<\s*MiPhone_start\s*>|MiPhone_start)/gi);
  const phoneEndCount = countMatches(source, /(?:<\s*MiPhone_end\s*>|MiPhone_end)/gi);
  const messageStartCount = countMatches(source, /(?:<\s*msg_start\s*>|msg_start)/gi);
  const messageEndCount = countMatches(source, /(?:<\s*msg_end\s*>|msg_end)/gi);
  const detectedSurfaces = [];
  if (/<\s*[^/][^>]*的私聊\s*>/i.test(source)) detectedSurfaces.push('private_chat');
  if (/<\s*群聊\s*[:：]/i.test(source)) detectedSurfaces.push('group_chat');
  if (/moment_start/i.test(source)) detectedSurfaces.push('moment_post');
  if (/moment_reply_start/i.test(source)) detectedSurfaces.push('moment_comment');
  const phoneShellClosed = Boolean(phoneStart && phoneEnd && phoneEnd.index > phoneStart.index);
  const messageShellClosed = Boolean(messageStart && messageEnd && messageEnd.index > messageStart.index);
  const hasUnclosedPhoneShell = Boolean(phoneStart) && (
    !phoneShellClosed || phoneStartCount !== phoneEndCount
  );
  const hasUnclosedMessageShell = Boolean(messageStart) && (
    !messageShellClosed || messageStartCount !== messageEndCount
  );
  const trailingAfterPhoneEnd = phoneEnd
    ? source.slice(phoneEnd.index + phoneEnd.length).trim().length > 0
    : false;
  const hasAnyProtocolMarker = Boolean(
    phoneStart
    || phoneEnd
    || messageStart
    || messageEnd
    || detectedSurfaces.length,
  );
  return {
    rawLength: source.length,
    isEmpty: source.trim().length === 0,
    hasAnyProtocolMarker,
    phoneStartCount,
    phoneEndCount,
    messageStartCount,
    messageEndCount,
    phoneShellClosed,
    messageShellClosed,
    phoneMarkersOrdered: Boolean(phoneStart && phoneEnd && phoneEnd.index > phoneStart.index),
    messageMarkersOrdered: Boolean(messageStart && messageEnd && messageEnd.index > messageStart.index),
    trailingAfterPhoneEnd,
    appearsTruncated: hasUnclosedPhoneShell || hasUnclosedMessageShell,
    detectedSurfaces: uniqueCodes(detectedSurfaces),
  };
};

export const inspectProtocolHistory = (messages = [], { lastRawResponse = '' } = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  let priorUserCount = 0;
  let priorAssistantCount = 0;
  let protocolAssistantRawCount = 0;
  for (const message of list) {
    if (message?.role === 'user') priorUserCount += 1;
    if (message?.role !== 'assistant') continue;
    priorAssistantCount += 1;
    if (typeof message?.raw !== 'string' || !message.raw.trim()) continue;
    if (hasProtocolMarker(message.raw)) protocolAssistantRawCount += 1;
  }
  if (protocolAssistantRawCount === 0 && hasProtocolMarker(lastRawResponse)) {
    protocolAssistantRawCount = 1;
  }
  return {
    priorConversationMessageCount: priorUserCount + priorAssistantCount,
    priorUserCount,
    priorAssistantCount,
    protocolAssistantRawCount,
    hasProtocolAssistantRaw: protocolAssistantRawCount > 0,
    firstProtocolTurn: protocolAssistantRawCount === 0,
    isFirstAssistantGeneration: priorAssistantCount === 0,
  };
};

export const normalizeProtocolRequestFacts = (request = {}) => {
  const value = asObject(request);
  const response = asObject(value.responseDiagnostics);
  const providerTools = asObject(value.providerToolRequestSchema);
  const webSearch = asObject(value.webSearch);
  const format = asObject(value.deepSeekFormatDebug);
  const phonePrefill = asObject(value.deepSeekPhonePrefill);
  const phoneReply = asObject(value.phoneReplyTransport);
  const phoneReplyJsonContract = asObject(phoneReply.jsonContract);
  const profile = asObject(value.configProfile);
  const responsePrefix = typeof value.responsePrefix === 'string' ? value.responsePrefix : '';
  const finishReason = diagnosticCode(response.finishReason);
  const providerToolNames = uniqueCodes(providerTools.internalToolNames);
  const providerCalls = (Array.isArray(response.providerCalls) ? response.providerCalls : [])
    .slice(0, 12)
    .map((raw) => {
      const call = asObject(raw);
      return {
        callIndex: nonNegativeInteger(call.callIndex, 0),
        mode: diagnosticCode(call.mode),
        outcome: diagnosticCode(call.outcome),
        provider: diagnosticCode(call.provider),
        model: text(call.model).slice(0, 160),
        stream: call.stream === true,
        promptTokens: nonNegativeInteger(call.promptTokens),
        completionTokens: nonNegativeInteger(call.completionTokens),
        totalTokens: nonNegativeInteger(call.totalTokens),
        latencyMs: nonNegativeInteger(call.latencyMs),
        firstMeaningfulDeltaLatencyMs: nonNegativeInteger(
          call.firstMeaningfulDeltaLatencyMs ?? call.firstTokenLatencyMs,
        ),
        outputDurationMs: nonNegativeInteger(call.outputDurationMs),
        tokensPerSecond: nonNegativeNumber(call.tokensPerSecond),
        outputSpeedStatus: diagnosticCode(call.outputSpeedStatus),
        streamDeltaCount: nonNegativeInteger(call.streamDeltaCount),
        streamObservedDurationMs: nonNegativeInteger(call.streamObservedDurationMs),
        finishReason: diagnosticCode(call.finishReason),
        systemFingerprint: text(call.systemFingerprint).slice(0, 512),
        modelVersion: text(call.modelVersion).slice(0, 512),
        responseId: text(call.responseId).slice(0, 512),
        responseModel: text(call.responseModel).slice(0, 512),
        routedProvider: text(call.routedProvider).slice(0, 512),
      };
    });
  return {
    requestId: text(value.requestId),
    provider: diagnosticCode(value.provider),
    model: text(value.model).slice(0, 160),
    stream: value.stream === true,
    uiMode: diagnosticCode(value?.presetContext?.uiMode),
    taskType: diagnosticCode(value?.task?.type),
    taskMode: diagnosticCode(value?.task?.mode),
    requestedSurface: resolveRequestedSurface(value),
    sessionIsGroup: value?.session?.isGroup === true,
    configProfileBound: profile.bound === true,
    configProfileSource: diagnosticCode(profile.source),
    ...resolveThinkingFacts(value),
    webSearchEnabled: webSearch.enabled === true,
    webSearchRoute: diagnosticCode(webSearch.route),
    providerToolsEnabled: providerTools.enabled === true,
    providerToolFormat: diagnosticCode(providerTools.format),
    providerToolCount: providerToolNames.length,
    providerToolNames,
    prefillEnabled: responsePrefix.length > 0,
    prefillLength: responsePrefix.length,
    prefillMode: diagnosticCode(value?.requestOptions?.deepseekPrefix?.mode),
    phonePrefillExperimentEnabled: phonePrefill.experimentEnabled === true,
    phonePrefillEligible: phonePrefill.eligible === true,
    phonePrefillSkipReason: diagnosticCode(phonePrefill.reason),
    phoneReplyRequestedMode: diagnosticCode(phoneReply.requestedMode),
    phoneReplyEffectiveMode: diagnosticCode(phoneReply.effectiveMode),
    phoneReplyRouteLayer: diagnosticCode(phoneReply.routeLayer),
    phoneReplyRouteReason: diagnosticCode(phoneReply.routeReason),
    phoneReplyFallbackFrom: diagnosticCode(phoneReply.fallbackFrom),
    phoneReplyFallbackReason: diagnosticCode(phoneReply.fallbackReason),
    phoneReplyProbationEligible: phoneReply.probationEligible === true,
    phoneReplyProbationReason: diagnosticCode(phoneReply.probationReason),
    phoneReplyEvidenceStatus: diagnosticCode(phoneReply.evidenceStatus),
    phoneReplyEvidenceStrictSuccessCount: nonNegativeInteger(
      phoneReply.evidenceStrictSuccessCount,
      0,
    ),
    phoneReplyCircuitOpen: phoneReply.circuitOpen === true,
    phoneReplyCooldownUntil: nonNegativeInteger(phoneReply.cooldownUntil, 0),
    phoneReplyEvidenceAction: diagnosticCode(phoneReply.evidenceAction),
    phoneReplyJsonContractVersion: diagnosticCode(phoneReplyJsonContract.version),
    phoneReplyJsonFormatMode: diagnosticCode(phoneReplyJsonContract.formatMode),
    phoneReplyValidationErrorCodes: sanitizeProtocolDiagnosticCodes(phoneReply.validationErrorCodes),
    phoneReplyArgumentRepairApplied: phoneReply.argumentRepairApplied === true,
    phoneReplyArgumentRepairKinds: sanitizeProtocolDiagnosticCodes(phoneReply.argumentRepairKinds),
    phoneReplyThinkingRequested: phoneReply.thinkingRequested === true,
    phoneReplyThinkingEnabled: phoneReply.thinkingEnabled === true,
    phoneReplyThinkingOverrideReason: diagnosticCode(phoneReply.thinkingOverrideReason),
    phoneReplyCapabilitySource: diagnosticCode(phoneReply.capabilitySource),
    phoneReplyCapabilityLayer: diagnosticCode(phoneReply.capabilityLayer),
    phoneReplyCapabilityRuleId: diagnosticCode(phoneReply.capabilityRuleId),
    phoneReplyLocalRuleCircuitOpen: phoneReply.localRuleCircuitOpen === true,
    phoneReplyLocalRuleFailureCount: nonNegativeInteger(phoneReply.localRuleFailureCount, 0),
    phoneReplyLocalRuleLastFailureReason: diagnosticCode(phoneReply.localRuleLastFailureReason),
    phoneReplyLocalRuleHealthAction: diagnosticCode(phoneReply.localRuleHealthAction),
    phoneReplySnapshotFingerprint: diagnosticCode(phoneReply.snapshotFingerprint),
    phoneReplyFallbackAssembly: diagnosticCode(phoneReply.fallbackAssembly || phoneReply.primaryAssembly),
    phoneReplyEligible: phoneReply.eligible === true,
    phoneReplyAttempted: phoneReply.attempted === true,
    formatReminderInjected: format.dsFormatInjected === true,
    usesDefaultPreset: format.isDefaultOpenAIPreset === true,
    usesCustomPreset: Boolean(Object.keys(format).length) && format.isDefaultOpenAIPreset === false,
    latencyMs: nonNegativeInteger(response.latencyMs),
    firstTokenLatencyMs: nonNegativeInteger(response.firstTokenLatencyMs),
    firstMeaningfulDeltaLatencyMs: nonNegativeInteger(
      response.firstMeaningfulDeltaLatencyMs ?? response.firstTokenLatencyMs,
    ),
    outputDurationMs: nonNegativeInteger(response.outputDurationMs),
    tokensPerSecond: nonNegativeNumber(response.tokensPerSecond),
    outputSpeedStatus: diagnosticCode(response.outputSpeedStatus),
    streamDeltaCount: nonNegativeInteger(response.streamDeltaCount),
    streamObservedDurationMs: nonNegativeInteger(response.streamObservedDurationMs),
    promptTokens: nonNegativeInteger(response.promptTokens),
    completionTokens: nonNegativeInteger(response.completionTokens),
    totalTokens: nonNegativeInteger(response.totalTokens),
    systemFingerprint: text(response.systemFingerprint).slice(0, 512),
    modelVersion: text(response.modelVersion).slice(0, 512),
    responseId: text(response.responseId).slice(0, 512),
    responseModel: text(response.responseModel).slice(0, 512),
    routedProvider: text(response.routedProvider).slice(0, 512),
    usagePersistenceTarget: diagnosticCode(response.usagePersistenceTarget),
    providerCalls,
    finishReason,
    truncated: isTruncatedFinishReason(finishReason),
  };
};

export const classifyProtocolGenerationError = (error = null) => {
  const value = error && typeof error === 'object' ? error : {};
  const errorName = diagnosticCode(value.name, 'Error');
  const errorCode = diagnosticCode(value.code).toLowerCase();
  const message = String(value.message || error || '');
  const statusValue = Math.trunc(Number(value.status ?? value.statusCode));
  const httpStatus = Number.isFinite(statusValue) && statusValue >= 100 && statusValue <= 599
    ? statusValue
    : null;
  const cancelled = value.cancelled === true
    || errorName === 'AbortError'
    || errorCode === 'abort_err'
    || /\b(?:cancelled|canceled|aborted)\b|取消|中止/i.test(message);
  const timedOut = errorName === 'TimeoutError'
    || errorCode === 'etimedout'
    || httpStatus === 408
    || httpStatus === 504
    || /\b(?:timed?\s*out|timeout)\b|超时/i.test(message);
  return {
    outcome: cancelled ? 'cancelled' : (timedOut ? 'timeout' : 'failed'),
    errorKind: errorName,
    httpStatus,
  };
};

const normalizeHistoryFacts = history => {
  const value = asObject(history);
  return {
    priorConversationMessageCount: nonNegativeInteger(value.priorConversationMessageCount, 0),
    priorUserCount: nonNegativeInteger(value.priorUserCount, 0),
    priorAssistantCount: nonNegativeInteger(value.priorAssistantCount, 0),
    protocolAssistantRawCount: nonNegativeInteger(value.protocolAssistantRawCount, 0),
    hasProtocolAssistantRaw: value.hasProtocolAssistantRaw === true,
    firstProtocolTurn: value.firstProtocolTurn !== false,
    isFirstAssistantGeneration: value.isFirstAssistantGeneration === true,
  };
};

const normalizeInitialFacts = (initial = {}, startedAt = 0) => ({
  turnId: text(initial.turnId),
  generationId: nonNegativeInteger(initial.generationId, 0),
  sessionId: text(initial.sessionId),
  uiMode: diagnosticCode(initial.uiMode),
  requestedSurface: diagnosticCode(initial.requestedSurface),
  taskType: diagnosticCode(initial.taskType),
  contractEligible: initial.contractEligible === true,
  requestedMode: diagnosticCode(initial.requestedMode, 'legacy_text'),
  effectiveMode: diagnosticCode(initial.effectiveMode, 'legacy_text'),
  fallbackReason: diagnosticCode(initial.fallbackReason),
  formatProfileEnabled: initial.formatProfileEnabled === true,
  formatProfileTarget: diagnosticCode(initial.formatProfileTarget),
  controlledExpectedSurface: diagnosticCode(initial.controlledExpectedSurface),
  history: normalizeHistoryFacts(initial.history),
  startedAt,
});

const normalizeProtocolResultFacts = (result = {}) => {
  const value = asObject(result);
  const reason = diagnosticCode(value.reason);
  const eventCount = nonNegativeInteger(value.eventCount, 0);
  const eventTypes = uniqueCodes(
    (Array.isArray(value.eventResults) ? value.eventResults : []).map(item => item?.type),
  );
  const parseFailure = reason === 'protocol_parse_failed'
    || reason === 'protocol_parse_incomplete'
    || reason === 'no_events';
  const handled = value.handled === true;
  return {
    parseSuccess: handled || (eventCount > 0 && !parseFailure),
    dispatchSuccess: handled && !value.postCommitError,
    retryRecovered: handled && diagnosticCode(value.candidateSource, 'raw') !== 'raw',
    rejected: !handled,
    protocolReason: reason,
    protocolEventCount: eventCount,
    protocolEventTypes: eventTypes,
    candidateSource: diagnosticCode(value.candidateSource),
    postCommitError: Boolean(value.postCommitError),
  };
};

const resolveTraceStatus = outcome => {
  if (outcome === 'completed') return 'success';
  if (outcome === 'rejected') return 'warning';
  if (outcome === 'cancelled') return 'cancelled';
  return 'error';
};

const buildCohortKey = details => [
  details.provider || 'unknown-provider',
  details.model || 'unknown-model',
  details.surface || 'unknown-surface',
  details.firstProtocolTurn ? 'first-protocol-turn' : 'protocol-history',
  details.thinkingEnabled ? 'thinking-on' : 'thinking-off',
].join('|');

const buildDetails = state => {
  const request = state.request || {};
  const protocol = state.protocol || {};
  const history = state.initial.history;
  const structuralFacts = state.structuralFacts || null;
  const contractValidation = state.contractValidation || null;
  const contractEligible = state.initial.contractEligible === true
    && state.initial.formatProfileEnabled !== true;
  const detectedSurfaces = uniqueCodes([
    ...(structuralFacts?.detectedSurfaces || []),
    ...(protocol.protocolEventTypes || []).map((type) => {
      if (type === 'moments') return 'moment_post';
      if (type === 'moment_reply') return 'moment_comment';
      return type;
    }),
  ]);
  const surface = request.requestedSurface || state.initial.requestedSurface || '';
  const controlledExpectedSurface = state.initial.controlledExpectedSurface;
  const expectedSurfaceMatch = controlledExpectedSurface
    ? detectedSurfaces.includes(controlledExpectedSurface)
    : null;
  const details = {
    schemaVersion: 1,
    outcome: state.terminal?.outcome || 'pending',
    requestId: request.requestId || '',
    turnId: state.initial.turnId,
    generationId: state.initial.generationId,
    provider: request.provider || '',
    model: request.model || '',
    uiMode: request.uiMode || state.initial.uiMode,
    surface,
    taskType: request.taskType || state.initial.taskType,
    taskMode: request.taskMode || '',
    contractEligible,
    requestedMode: state.initial.requestedMode,
    effectiveMode: state.initial.effectiveMode,
    fallbackReason: state.initial.fallbackReason,
    phoneReplyRouteLayer: request.phoneReplyRouteLayer || '',
    phoneReplyRouteReason: request.phoneReplyRouteReason || '',
    phoneReplyFallbackFrom: request.phoneReplyFallbackFrom || '',
    phoneReplyProbationEligible: request.phoneReplyProbationEligible === true,
    phoneReplyProbationReason: request.phoneReplyProbationReason || '',
    phoneReplyEvidenceStatus: request.phoneReplyEvidenceStatus || '',
    phoneReplyEvidenceStrictSuccessCount: request.phoneReplyEvidenceStrictSuccessCount || 0,
    phoneReplyCircuitOpen: request.phoneReplyCircuitOpen === true,
    phoneReplyCooldownUntil: request.phoneReplyCooldownUntil || 0,
    phoneReplyEvidenceAction: request.phoneReplyEvidenceAction || '',
    phoneReplyJsonContractVersion: request.phoneReplyJsonContractVersion || '',
    phoneReplyJsonFormatMode: request.phoneReplyJsonFormatMode || '',
    phoneReplyValidationErrorCodes: request.phoneReplyValidationErrorCodes || [],
    phoneReplyArgumentRepairApplied: request.phoneReplyArgumentRepairApplied === true,
    phoneReplyArgumentRepairKinds: request.phoneReplyArgumentRepairKinds || [],
    firstProtocolTurn: history.firstProtocolTurn,
    isFirstAssistantGeneration: history.isFirstAssistantGeneration,
    hasProtocolAssistantRaw: history.hasProtocolAssistantRaw,
    priorUserCount: history.priorUserCount,
    priorAssistantCount: history.priorAssistantCount,
    protocolAssistantRawCount: history.protocolAssistantRawCount,
    stream: request.stream === true,
    thinkingEnabled: request.thinkingEnabled === true,
    thinkingMode: request.thinkingMode || 'off',
    webSearchEnabled: request.webSearchEnabled === true,
    webSearchRoute: request.webSearchRoute || '',
    providerToolsEnabled: request.providerToolsEnabled === true,
    providerToolFormat: request.providerToolFormat || '',
    providerToolCount: request.providerToolCount || 0,
    providerToolNames: request.providerToolNames || [],
    prefillEnabled: request.prefillEnabled === true,
    prefillLength: request.prefillLength || 0,
    prefillMode: request.prefillMode || '',
    phoneReplyCapabilitySource: request.phoneReplyCapabilitySource || '',
    phoneReplyCapabilityLayer: request.phoneReplyCapabilityLayer || '',
    phoneReplyCapabilityRuleId: request.phoneReplyCapabilityRuleId || '',
    phoneReplyLocalRuleCircuitOpen: request.phoneReplyLocalRuleCircuitOpen === true,
    phoneReplyLocalRuleFailureCount: request.phoneReplyLocalRuleFailureCount || 0,
    phoneReplyLocalRuleLastFailureReason: request.phoneReplyLocalRuleLastFailureReason || '',
    phoneReplyLocalRuleHealthAction: request.phoneReplyLocalRuleHealthAction || '',
    phoneReplySnapshotFingerprint: request.phoneReplySnapshotFingerprint || '',
    phoneReplyFallbackAssembly: request.phoneReplyFallbackAssembly || '',
    phonePrefillExperimentEnabled: request.phonePrefillExperimentEnabled === true,
    phonePrefillEligible: request.phonePrefillEligible === true,
    phonePrefillSkipReason: request.phonePrefillSkipReason || '',
    formatReminderInjected: request.formatReminderInjected === true,
    usesDefaultPreset: request.usesDefaultPreset === true,
    usesCustomPreset: request.usesCustomPreset === true,
    formatProfileEnabled: state.initial.formatProfileEnabled,
    formatProfileTarget: state.initial.formatProfileTarget,
    rawLength: structuralFacts?.rawLength ?? null,
    structuralFacts,
    structuralContractSuccess: contractEligible && contractValidation
      ? contractValidation.valid === true
      : null,
    contractVersion: contractEligible
      ? diagnosticCode(contractValidation?.version)
      : '',
    contractIssueCodes: contractEligible
      ? uniqueCodes(contractValidation?.issues)
      : [],
    detectedSurfaces,
    expectedSurfaceMatch,
    parseSuccess: protocol.parseSuccess ?? null,
    dispatchSuccess: protocol.dispatchSuccess ?? null,
    retryRecovered: protocol.retryRecovered === true,
    protocolReason: protocol.protocolReason || '',
    protocolEventCount: protocol.protocolEventCount ?? 0,
    protocolEventTypes: protocol.protocolEventTypes || [],
    rejected: protocol.rejected === true || state.terminal?.outcome === 'rejected',
    guardianQueued: state.guardianQueued === true,
    guardianOutcome: state.guardianOutcome || '',
    finishReason: request.finishReason || '',
    truncated: request.truncated === true || structuralFacts?.appearsTruncated === true,
    promptTokens: request.promptTokens ?? null,
    completionTokens: request.completionTokens ?? null,
    totalTokens: request.totalTokens ?? null,
    providerLatencyMs: request.latencyMs ?? null,
    firstTokenLatencyMs: request.firstTokenLatencyMs ?? null,
    firstMeaningfulDeltaLatencyMs: request.firstMeaningfulDeltaLatencyMs ?? null,
    outputDurationMs: request.outputDurationMs ?? null,
    tokensPerSecond: request.tokensPerSecond ?? null,
    outputSpeedStatus: request.outputSpeedStatus || '',
    streamDeltaCount: request.streamDeltaCount ?? null,
    streamObservedDurationMs: request.streamObservedDurationMs ?? null,
    systemFingerprint: request.systemFingerprint || '',
    modelVersion: request.modelVersion || '',
    responseId: request.responseId || '',
    responseModel: request.responseModel || '',
    routedProvider: request.routedProvider || '',
    usagePersistenceTarget: request.usagePersistenceTarget || '',
    providerCalls: request.providerCalls || [],
    firstVisibleLatencyMs: state.firstVisibleAt == null
      ? null
      : Math.max(0, state.firstVisibleAt - state.initial.startedAt),
    firstUserVisibleRenderLatencyMs: state.firstVisibleAt == null
      ? null
      : Math.max(0, state.firstVisibleAt - state.initial.startedAt),
    totalLatencyMs: state.terminal?.endedAt == null
      ? null
      : Math.max(0, state.terminal.endedAt - state.initial.startedAt),
    errorKind: state.terminal?.errorKind || '',
    httpStatus: state.terminal?.httpStatus ?? null,
  };
  details.cohortKey = buildCohortKey(details);
  return details;
};

const buildTraceEvent = state => {
  const details = buildDetails(state);
  const endedAt = state.terminal?.endedAt ?? null;
  const outcome = details.outcome;
  return {
    eventId: `protocol-generation:${state.initial.turnId}`,
    category: 'chat_protocol',
    phase: 'generation.terminal',
    sessionId: state.initial.sessionId,
    source: 'protocol-generation-diagnostics',
    status: resolveTraceStatus(outcome),
    startedAt: state.initial.startedAt,
    endedAt,
    durationMs: endedAt == null ? null : Math.max(0, endedAt - state.initial.startedAt),
    summary: `chat protocol generation ${outcome}`,
    details,
    relatedIds: uniqueCodes([
      details.requestId,
      details.turnId,
      details.generationId ? `generation:${details.generationId}` : '',
    ]),
  };
};

const metric = (count, denominator) => ({
  count,
  denominator,
  rate: denominator > 0 ? Math.round((count / denominator) * 10000) / 10000 : null,
});

const summarizeDiagnosticRecords = (records = []) => {
  const outcomes = {
    completed: 0,
    rejected: 0,
    cancelled: 0,
    timeout: 0,
    failed: 0,
  };
  records.forEach((details) => {
    const outcome = diagnosticCode(details?.outcome, 'failed');
    if (Object.prototype.hasOwnProperty.call(outcomes, outcome)) outcomes[outcome] += 1;
    else outcomes.failed += 1;
  });
  const eligibleRecords = records.filter(details => details?.contractEligible === true);
  const completedRecords = eligibleRecords.filter(details => (
    details?.outcome === 'completed' || details?.outcome === 'rejected'
  ));
  const structuralRecords = completedRecords.filter(details => (
    typeof details?.structuralContractSuccess === 'boolean'
  ));
  const expectedSurfaceRecords = completedRecords.filter(details => (
    typeof details?.expectedSurfaceMatch === 'boolean'
  ));
  return {
    totalGenerations: records.length,
    contractEligibleGenerations: eligibleRecords.length,
    completedResponseDenominator: completedRecords.length,
    outcomes,
    parseSuccess: metric(
      completedRecords.filter(details => details?.parseSuccess === true).length,
      completedRecords.length,
    ),
    dispatchSuccess: metric(
      completedRecords.filter(details => details?.dispatchSuccess === true).length,
      completedRecords.length,
    ),
    retryRecovered: metric(
      completedRecords.filter(details => details?.retryRecovered === true).length,
      completedRecords.length,
    ),
    rejected: metric(outcomes.rejected, completedRecords.length),
    guardianQueued: metric(
      records.filter(details => details?.guardianQueued === true).length,
      records.length,
    ),
    structuralContractSuccess: metric(
      structuralRecords.filter(details => details?.structuralContractSuccess === true).length,
      structuralRecords.length,
    ),
    expectedSurfaceMatch: metric(
      expectedSurfaceRecords.filter(details => details?.expectedSurfaceMatch === true).length,
      expectedSurfaceRecords.length,
    ),
  };
};

export const summarizeProtocolGenerationDiagnostics = (events = []) => {
  const seen = new Set();
  const records = [];
  (Array.isArray(events) ? events : []).forEach((event, index) => {
    if (event?.category !== 'chat_protocol' || event?.phase !== 'generation.terminal') return;
    const details = asObject(event.details);
    const identity = text(details.requestId)
      || text(details.turnId)
      || text(event.eventId)
      || `event:${index}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    records.push(details);
  });
  const summary = summarizeDiagnosticRecords(records);
  const cohorts = new Map();
  records.forEach((details) => {
    const key = text(details.cohortKey, 'unknown');
    const list = cohorts.get(key) || [];
    list.push(details);
    cohorts.set(key, list);
  });
  return {
    ...summary,
    cohorts: Array.from(cohorts.entries()).map(([cohortKey, cohortRecords]) => ({
      cohortKey,
      ...summarizeDiagnosticRecords(cohortRecords),
    })),
  };
};

const cloneProtocolDiagnosticEvent = (event = {}) => ({
  ...(event && typeof event === 'object' ? event : {}),
  details: { ...asObject(event?.details) },
  relatedIds: Array.isArray(event?.relatedIds) ? event.relatedIds.slice() : [],
});

export const createProtocolGenerationDiagnosticStore = ({ maxEntries = 500 } = {}) => {
  const events = [];
  const limit = Math.max(1, Math.trunc(Number(maxEntries) || 500));
  const trim = () => {
    while (events.length > limit) events.shift();
  };
  const record = (event = {}) => {
    const normalized = cloneProtocolDiagnosticEvent(event);
    const eventId = text(normalized.eventId);
    if (!eventId) return null;
    normalized.eventId = eventId;
    const existingIndex = events.findIndex(item => item.eventId === eventId);
    if (existingIndex >= 0) events[existingIndex] = normalized;
    else events.push(normalized);
    trim();
    return cloneProtocolDiagnosticEvent(normalized);
  };
  const update = (eventId, patch = {}) => {
    const id = text(eventId);
    if (!id) return null;
    const index = events.findIndex(item => item.eventId === id);
    if (index < 0) return null;
    const previous = events[index];
    const value = patch && typeof patch === 'object' ? patch : {};
    const next = cloneProtocolDiagnosticEvent({
      ...previous,
      ...value,
      eventId: id,
      details: Object.prototype.hasOwnProperty.call(value, 'details')
        ? asObject(value.details)
        : previous.details,
      relatedIds: Object.prototype.hasOwnProperty.call(value, 'relatedIds')
        ? value.relatedIds
        : previous.relatedIds,
    });
    events[index] = next;
    return cloneProtocolDiagnosticEvent(next);
  };
  const clear = () => {
    events.length = 0;
  };
  const snapshot = ({ category = '', sessionId = '', status = '', limit: snapshotLimit = 0 } = {}) => {
    const categoryFilter = text(category);
    const sessionFilter = text(sessionId);
    const statusFilter = text(status);
    const filtered = events.filter((event) => {
      if (categoryFilter && event.category !== categoryFilter) return false;
      if (sessionFilter && event.sessionId !== sessionFilter) return false;
      if (statusFilter && event.status !== statusFilter) return false;
      return true;
    });
    const count = Math.max(0, Math.trunc(Number(snapshotLimit) || 0));
    return (count ? filtered.slice(-count) : filtered).map(cloneProtocolDiagnosticEvent);
  };
  return {
    maxEntries: limit,
    record,
    update,
    clear,
    snapshot,
  };
};

export const createProtocolGenerationDiagnosticsRuntime = ({
  now = Date.now,
  recordEvent = () => null,
  updateEvent = () => null,
  maxEntries = 200,
} = {}) => {
  const turns = new Map();
  const requestTurns = new Map();
  const entryLimit = Math.max(10, Math.trunc(Number(maxEntries) || 200));
  let sequence = 0;

  const getState = turnId => turns.get(text(turnId)) || null;
  const trimEntries = () => {
    while (turns.size > entryLimit) {
      const finalizedKey = Array.from(turns.entries()).find(([, state]) => state.finalized)?.[0];
      const key = finalizedKey || turns.keys().next().value;
      if (!key) break;
      const state = turns.get(key);
      const requestId = text(state?.request?.requestId);
      if (requestId && requestTurns.get(requestId) === key) requestTurns.delete(requestId);
      turns.delete(key);
    }
  };
  const patchRecorded = (state) => {
    if (!state?.finalized || state.duplicate === true || !state.eventId) return null;
    const event = buildTraceEvent(state);
    const patch = {
      status: event.status,
      endedAt: event.endedAt,
      durationMs: event.durationMs,
      summary: event.summary,
      details: event.details,
      relatedIds: event.relatedIds,
    };
    const updated = updateEvent(state.eventId, patch);
    state.event = {
      ...(state.event || event),
      ...patch,
      ...(updated && typeof updated === 'object' ? updated : {}),
      eventId: state.eventId,
    };
    return updated;
  };

  const start = (initial = {}) => {
    const startedAt = nonNegativeInteger(now?.(), Date.now());
    const explicitTurnId = text(initial.turnId);
    const turnId = explicitTurnId || `protocol-turn-${startedAt}-${sequence += 1}`;
    if (turns.has(turnId)) return turnId;
    const normalized = normalizeInitialFacts({ ...initial, turnId }, startedAt);
    turns.set(turnId, {
      initial: normalized,
      request: null,
      structuralFacts: null,
      contractValidation: null,
      protocol: null,
      guardianQueued: false,
      guardianOutcome: '',
      firstVisibleAt: null,
      terminal: null,
      finalized: false,
      duplicate: false,
      eventId: '',
      event: null,
    });
    trimEntries();
    return turnId;
  };

  const observeRequest = (turnId, request = {}) => {
    const state = getState(turnId);
    if (!state) return null;
    const normalizedRequest = normalizeProtocolRequestFacts(request);
    state.request = {
      ...(state.request || {}),
      ...normalizedRequest,
    };
    if (normalizedRequest.phoneReplyRequestedMode) {
      state.initial.requestedMode = normalizedRequest.phoneReplyRequestedMode;
      if (normalizedRequest.phoneReplyEffectiveMode) {
        state.initial.effectiveMode = normalizedRequest.phoneReplyEffectiveMode;
      }
      state.initial.fallbackReason = normalizedRequest.phoneReplyFallbackReason || '';
    }
    patchRecorded(state);
    return state.request;
  };

  const observeRaw = (turnId, raw = '') => {
    const state = getState(turnId);
    if (!state) return null;
    state.structuralFacts = inspectProtocolRaw(raw);
    if (state.initial.contractEligible === true && state.initial.formatProfileEnabled !== true) {
      const surface = state.request?.requestedSurface || state.initial.requestedSurface || '';
      state.contractValidation = validateBuiltinPhoneFormat(raw, { surface });
    }
    patchRecorded(state);
    return state.structuralFacts;
  };

  const observeProtocolResult = (turnId, result = {}) => {
    const state = getState(turnId);
    if (!state) return null;
    state.protocol = normalizeProtocolResultFacts(result);
    patchRecorded(state);
    return state.protocol;
  };

  const markFirstVisible = (turnId) => {
    const state = getState(turnId);
    if (!state) return false;
    if (state.firstVisibleAt == null) {
      state.firstVisibleAt = nonNegativeInteger(now?.(), Date.now());
      patchRecorded(state);
    }
    return true;
  };

  const markGuardianQueued = (turnId) => {
    const state = getState(turnId);
    if (!state) return false;
    state.guardianQueued = true;
    if (!state.guardianOutcome) state.guardianOutcome = 'queued';
    patchRecorded(state);
    return true;
  };

  const markGuardianOutcome = (turnId, outcome = {}) => {
    const state = getState(turnId);
    if (!state) return false;
    const value = asObject(outcome);
    if (value.queued === true) state.guardianQueued = true;
    state.guardianOutcome = diagnosticCode(
      value.status
      || value.outcome
      || (value.failed === true ? 'failed' : ''),
      state.guardianOutcome || 'completed',
    );
    patchRecorded(state);
    return true;
  };

  const finalize = (turnId, terminal = {}) => {
    const state = getState(turnId);
    if (!state) return null;
    if (state.finalized) return state.event;
    const requestId = text(state.request?.requestId);
    const existingTurnId = requestId ? requestTurns.get(requestId) : '';
    if (existingTurnId && existingTurnId !== state.initial.turnId) {
      const existing = getState(existingTurnId);
      state.finalized = true;
      state.duplicate = true;
      state.eventId = text(existing?.eventId);
      state.event = existing?.event || null;
      return state.event;
    }
    const value = asObject(terminal);
    let failure = null;
    if (value.error) failure = classifyProtocolGenerationError(value.error);
    else if (value.failure && typeof value.failure === 'object') failure = value.failure;
    let outcome = failure?.outcome || '';
    if (!outcome && value.cancelled === true) outcome = 'cancelled';
    if (!outcome && value.timedOut === true) outcome = 'timeout';
    if (!outcome && value.sendSucceeded === true) outcome = 'completed';
    if (!outcome && state.protocol?.rejected === true) outcome = 'rejected';
    if (!outcome) outcome = 'failed';
    const endedAt = nonNegativeInteger(now?.(), Date.now());
    state.terminal = {
      outcome,
      endedAt,
      errorKind: diagnosticCode(failure?.errorKind),
      httpStatus: nonNegativeInteger(failure?.httpStatus),
    };
    const event = buildTraceEvent(state);
    const recorded = recordEvent(event) || event;
    state.finalized = true;
    state.eventId = text(recorded?.eventId, event.eventId);
    state.event = { ...event, ...recorded, eventId: state.eventId };
    if (requestId) requestTurns.set(requestId, state.initial.turnId);
    return state.event;
  };

  return {
    start,
    observeRequest,
    observeRaw,
    observeProtocolResult,
    markFirstVisible,
    markGuardianQueued,
    markGuardianOutcome,
    finalize,
  };
};

export const createMomentProtocolGenerationDiagnosticsRunner = ({
  diagnostics = null,
  runGeneration = null,
  getLastRequest = () => null,
  getHistory = () => inspectProtocolHistory([]),
  finalizeStructuredEvidence = null,
} = {}) => async (input, context, options = {}) => {
  if (typeof runGeneration !== 'function') {
    throw new TypeError('runGeneration is required');
  }
  const targetSessionId = text(context?.session?.id, 'moments');
  const turnId = diagnostics?.start?.({
    sessionId: targetSessionId,
    uiMode: 'moments',
    requestedSurface: 'moment_comment',
    taskType: 'moment_comment',
    contractEligible: true,
    requestedMode: 'legacy_text',
    effectiveMode: 'legacy_text',
    history: getHistory?.() || inspectProtocolHistory([]),
  });
  let primaryRequest = null;
  const generate = async (...args) => {
    const previousRequest = getLastRequest?.() || null;
    try {
      return await options.generate?.(...args);
    } finally {
      const candidate = getLastRequest?.() || null;
      const candidateSessionId = text(candidate?.session?.id);
      if (
        turnId
        && candidate
        && candidate !== previousRequest
        && (!candidateSessionId || candidateSessionId === targetSessionId)
      ) {
        primaryRequest = candidate;
        diagnostics?.observeRequest?.(turnId, candidate);
      }
    }
  };
  const applyEvents = (events = []) => {
    const result = options.applyEvents?.(events) || {};
    if (result?.touchedMoments === true) diagnostics?.markFirstVisible?.(turnId);
    return result;
  };
  try {
    const result = await runGeneration(input, context, {
      ...options,
      generate,
      applyEvents,
    });
    if (primaryRequest) diagnostics?.observeRequest?.(turnId, primaryRequest);
    diagnostics?.observeRaw?.(turnId, result?.fullRaw || '');
    diagnostics?.observeProtocolResult?.(turnId, {
      handled: result?.sawMomentReply === true,
      reason: result?.sawMomentReply === true ? '' : 'no_events',
      eventCount: result?.sawMomentReply === true ? 1 : 0,
      candidateSource: result?.retryRecovered === true ? 'retry' : 'raw',
      eventResults: result?.sawMomentReply === true
        ? [{ type: 'moment_reply', consumed: true, didAnything: true, mutatedMoments: true }]
        : [],
    });
    diagnostics?.finalize?.(turnId, {
      sendSucceeded: result?.sawMomentReply === true,
    });
    if (primaryRequest?.requestId && typeof finalizeStructuredEvidence === 'function') {
      try {
        await finalizeStructuredEvidence({
          requestId: primaryRequest.requestId,
          committed: result?.sawMomentReply === true,
        });
      } catch {}
    }
    return result;
  } catch (error) {
    if (primaryRequest) diagnostics?.observeRequest?.(turnId, primaryRequest);
    diagnostics?.finalize?.(turnId, {
      failure: classifyProtocolGenerationError(error),
    });
    if (primaryRequest?.requestId && typeof finalizeStructuredEvidence === 'function') {
      try {
        await finalizeStructuredEvidence({
          requestId: primaryRequest.requestId,
          committed: false,
        });
      } catch {}
    }
    throw error;
  }
};
