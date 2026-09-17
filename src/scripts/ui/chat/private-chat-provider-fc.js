import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';
import { createProviderToolCallDeltaAccumulator } from '../../agent/provider-tool-call-delta-adapter.js';
import {
  buildProviderFcRequestPlan,
  resolveProviderFcTransport,
  sanitizeProviderFcInheritedRequestOptions,
} from '../../agent/provider-fc-transport.js';
import { createPhoneFcProviderStreamRuntime } from './phone-fc-stream-preview-utils.js';
import {
  assembleProviderFcRequest,
  createChatSemanticSnapshot,
  resolvePhoneFormatTransportLayers,
} from './chat-semantic-snapshot-utils.js';
import {
  redactProviderToolSchemaForDiagnostics,
  sanitizeProtocolDiagnosticCodes,
} from './protocol-generation-diagnostics-utils.js';
import {
  PHONE_REPLY_IR_PRIVATE_TOOL_NAME,
  buildPrivateChatPhoneReplyIr,
  buildPrivateReplyProviderToolDefinition,
  serializePhoneReplyIr,
} from './phone-reply-ir.js';
import { parseProviderToolArguments } from './provider-tool-arguments-json-utils.js';
import { containsTextProtocol } from '../../utils/text-protocol-marker-utils.js';

const REQUESTED_MODE = 'provider_fc';
const LEGACY_MODE = 'legacy_text';
const PRIVATE_SURFACE = 'private_chat';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const messageText = (message = {}) => {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(part => part?.type === 'text')
    .map(part => String(part?.text || ''))
    .join('\n');
};

const messagesContainImages = (messages = []) => (Array.isArray(messages) ? messages : [])
  .some(message => Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url'));

const messagesContainTextProtocol = (messages = []) => (Array.isArray(messages) ? messages : [])
  .some(message => containsTextProtocol(messageText(message)));

const isAbortError = (error, signal = null) => signal?.aborted === true || error?.name === 'AbortError';

const normalizeItemTypes = (value = ['text']) => {
  const supported = new Set(['text', 'sticker', 'voice', 'transfer', 'music', 'image']);
  const out = [];
  (Array.isArray(value) ? value : []).forEach((item) => {
    const type = trim(item).toLowerCase();
    if (supported.has(type) && !out.includes(type)) out.push(type);
  });
  return out.length ? out : ['text'];
};

const normalizeKeywords = (value = []) => {
  const out = [];
  (Array.isArray(value) ? value : []).forEach((item) => {
    const keyword = trim(item).replace(/[\[\]\r\n]/g, '').trim();
    if (keyword && !out.includes(keyword)) out.push(keyword);
  });
  return out;
};

export const buildPrivateChatStructuredTransportInstruction = ({
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => {
  const types = normalizeItemTypes(allowedItemTypes);
  const stickerKeywords = normalizeKeywords(allowedStickerKeywords);
  const t = key => getLocalizedPromptText(key);
  const specialLines = [];
  if (types.includes('sticker')) {
    specialLines.push(stickerKeywords.length
      ? t('fc.private.sticker_some').split('{keywords}').join(stickerKeywords.join('、'))
      : t('fc.private.sticker_none'));
  }
  if (types.includes('voice')) specialLines.push(t('fc.private.voice'));
  if (types.includes('transfer')) specialLines.push(t('fc.private.transfer'));
  if (types.includes('music')) specialLines.push(t('fc.private.music'));
  if (types.includes('image')) specialLines.push(t('fc.private.image'));
  return [
    t('fc.private.head'),
    t('fc.private.frozen'),
    t('fc.private.types').split('{types}').join(types.join('、')),
    ...specialLines,
  ].join('\n');
};

export const buildPrivateChatStructuredPromptMessages = ({
  messages = [],
  transportPlan = {},
  instruction = '',
  snapshotContext = {},
} = {}) => {
  const phoneLayers = resolvePhoneFormatTransportLayers(transportPlan);
  const outputLayer = trim(transportPlan?.outputFormatReminder);
  const scenario = trim(transportPlan?.scenarioReminder);
  if (!phoneLayers.length || !outputLayer) {
    return {
      ok: false,
      reason: 'text_transport_plan_unavailable',
      messages: [],
      diagnostics: { phoneLayerRemoved: 0, outputLayerRemoved: 0 },
    };
  }
  const structuredInstruction = trim(instruction) || buildPrivateChatStructuredTransportInstruction();
  const transportMessage = [scenario, structuredInstruction].filter(Boolean).join('\n\n');
  const deferredLayers = Array.isArray(transportPlan?.deferredLegacyLayers)
    ? transportPlan.deferredLegacyLayers
    : [];
  const legacyLayer = (id, content) => ({
    id,
    content,
    marker: trim(deferredLayers.find(entry => trim(entry?.id) === id)?.marker),
  });
  const created = createChatSemanticSnapshot({
    ...(snapshotContext && typeof snapshotContext === 'object' ? snapshotContext : {}),
    legacyMessages: messages,
    legacyLayers: [
      ...phoneLayers.map(layer => legacyLayer(layer.id, layer.content)),
      legacyLayer('output_format', outputLayer),
    ],
    providerFcTransportMessage: transportMessage,
  });
  const phoneLayerRemoved = phoneLayers.reduce((sum, layer) => (
    sum + Number(created.diagnostics?.layerMatches?.[layer.id] || 0)
  ), 0);
  const outputLayerRemoved = Number(created.diagnostics?.layerMatches?.output_format || 0);
  if (!created.ok) {
    return {
      ok: false,
      reason: 'text_transport_layer_mismatch',
      messages: [],
      diagnostics: {
        phoneLayerRemoved,
        outputLayerRemoved,
      },
    };
  }
  const assembled = assembleProviderFcRequest(created.snapshot);
  const nextMessages = assembled.ok ? assembled.messages : [];
  if (messagesContainTextProtocol(nextMessages)) {
    return {
      ok: false,
      reason: 'text_protocol_prompt_present',
      messages: [],
      semanticSnapshot: created.snapshot,
      snapshotFingerprint: created.snapshot.fingerprint,
      diagnostics: {
        phoneLayerRemoved,
        outputLayerRemoved,
      },
    };
  }
  return {
    ok: true,
    reason: '',
    messages: nextMessages,
    semanticSnapshot: created.snapshot,
    snapshotFingerprint: created.snapshot.fingerprint,
    diagnostics: {
      phoneLayerRemoved,
      outputLayerRemoved,
    },
  };
};

export const resolvePrivateChatProviderFcEligibility = ({
  enabled = false,
  config = {},
  client = null,
  messages = [],
  context = {},
  target = {},
  localRuleOverride = null,
} = {}) => {
  const providerTransport = resolveProviderFcTransport(config, { localRuleOverride });
  let reason = '';
  if (enabled !== true) reason = 'feature_disabled';
  else if (context?.compatibilityModeEnabled === true) reason = 'compatibility_mode';
  else if (!providerTransport.supported) reason = providerTransport.reason;
  else if (!client || typeof client.chat !== 'function') reason = 'provider_client_unavailable';
  else if (trim(context?.uiMode, 'chat').toLowerCase() === 'rp') reason = 'creative_mode';
  else if (trim(context?.surface, PRIVATE_SURFACE).toLowerCase() !== PRIVATE_SURFACE) reason = 'unsupported_surface';
  else if (context?.isGroupChat === true) reason = 'group_chat';
  else if (context?.protocolParserEnabled !== true) reason = 'protocol_parser_disabled';
  else if (context?.hasUnsupportedSideEffects === true) reason = 'unsupported_side_effects';
  else if (!['assistant', 'character'].includes(trim(context?.responseTarget, 'assistant').toLowerCase())) {
    reason = 'unsupported_response_target';
  }
  else if (context?.assistantContinuation === true) reason = 'assistant_continuation';
  else if (context?.webSearchEnabled === true || config?.webSearchEnabled === true) reason = 'web_search_enabled';
  else if (context?.hasProviderTools === true) reason = 'provider_tools_present';
  else if (context?.hasAssistantPrefill === true) reason = 'assistant_prefill_present';
  else if (context?.usesDefaultPreset !== true) reason = 'custom_preset';
  else if (context?.usesBuiltinFormat !== true) reason = 'custom_format';
  else if (context?.formatProfileEnabled === true) reason = 'custom_format_profile';
  else if (messagesContainImages(messages)) reason = 'multimodal_input';
  else if (messagesContainTextProtocol(messages)) reason = 'text_protocol_prompt_present';
  else if (!trim(target?.sessionId) || !trim(target?.targetName) || !trim(target?.speakerName)) {
    reason = 'target_unavailable';
  }
  return {
    eligible: !reason,
    reason,
    requestedMode: REQUESTED_MODE,
    provider: trim(config?.provider),
    model: trim(config?.model),
    providerFamily: providerTransport.family,
    providerEndpoint: providerTransport.endpoint,
    surface: trim(context?.surface, PRIVATE_SURFACE),
    sessionId: trim(target?.sessionId),
  };
};

export const preparePrivateChatProviderFcRoute = ({
  enabled = false,
  config = {},
  client = null,
  messages = [],
  transportPlan = {},
  context = {},
  target = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
  snapshotContext = {},
} = {}) => {
  if (enabled !== true) {
    const eligibility = resolvePrivateChatProviderFcEligibility({
      enabled,
      config,
      client,
      messages: [],
      context,
      target,
    });
    return { ...eligibility, messages: [], promptDiagnostics: null };
  }
  const toolDefinition = buildPrivateReplyProviderToolDefinition({
      timeMode: target.timeMode,
    allowedItemTypes,
    allowedStickerKeywords,
  });
  const toolSchemaDiagnostics = redactProviderToolSchemaForDiagnostics(toolDefinition);
  const toolSchemaLocal = {
    schemaVersion: 1,
    redacted: false,
    toolName: toolDefinition.function.name,
    schema: toolDefinition.function.parameters,
  };
  const structured = buildPrivateChatStructuredPromptMessages({
    messages,
    transportPlan,
    instruction: buildPrivateChatStructuredTransportInstruction({
      allowedItemTypes,
      allowedStickerKeywords,
    }),
    snapshotContext,
  });
  if (!structured.ok) {
    return {
      eligible: false,
      reason: structured.reason,
      requestedMode: REQUESTED_MODE,
      provider: trim(config?.provider),
      model: trim(config?.model),
      surface: trim(context?.surface, PRIVATE_SURFACE),
      sessionId: trim(target?.sessionId),
      messages: [],
      semanticSnapshot: structured.semanticSnapshot || null,
      snapshotFingerprint: String(structured.snapshotFingerprint || ''),
      toolSchemaDiagnostics,
      toolSchemaLocal,
      promptDiagnostics: structured.diagnostics || null,
    };
  }
  const eligibility = resolvePrivateChatProviderFcEligibility({
    enabled,
    config,
    client,
    messages: structured.messages,
    context,
    target,
  });
  return {
    ...eligibility,
    messages: eligibility.eligible ? structured.messages : [],
    semanticSnapshot: structured.semanticSnapshot || null,
    snapshotFingerprint: String(structured.snapshotFingerprint || ''),
    toolSchemaDiagnostics,
    toolSchemaLocal,
    toolDefinition,
    promptDiagnostics: structured.diagnostics || null,
  };
};

export const normalizePrivateChatProviderFcCalls = ({
  completedToolCalls = [],
  target = {},
  source = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => {
  const calls = Array.isArray(completedToolCalls) ? completedToolCalls : [];
  if (!calls.length) return { ok: false, reason: 'no_tool_call', toolCallCount: 0 };
  if (calls.length !== 1) {
    return { ok: false, reason: 'multiple_tool_calls', toolCallCount: calls.length };
  }
  const call = calls[0] || {};
  const toolName = trim(call?.toolName || call?.name);
  if (toolName !== PHONE_REPLY_IR_PRIVATE_TOOL_NAME) {
    return { ok: false, reason: 'unknown_tool', toolCallCount: 1 };
  }
  const parsed = parseProviderToolArguments(call);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, toolCallCount: 1 };

  const built = buildPrivateChatPhoneReplyIr({
    args: parsed.args,
    target,
    source,
    allowedItemTypes,
    allowedStickerKeywords,
  });
  if (!built.ok) {
    return {
      ok: false,
      reason: 'invalid_phone_reply_ir',
      toolCallCount: 1,
      validationErrors: built.errors,
      argumentRepairApplied: parsed.repairApplied === true,
      argumentRepairKinds: parsed.repairKinds || [],
    };
  }
  const serialized = serializePhoneReplyIr(built.ir, {
    timeMode: target.timeMode,
    userName: trim(target?.userName, '我'),
    expectedSessionId: trim(target?.sessionId),
  });
  if (!serialized.ok) {
    return {
      ok: false,
      reason: 'canonical_serialization_failed',
      toolCallCount: 1,
      validationErrors: serialized.errors,
      argumentRepairApplied: parsed.repairApplied === true,
      argumentRepairKinds: parsed.repairKinds || [],
    };
  }
  return {
    ok: true,
    reason: '',
    toolCallCount: 1,
    argumentRepairApplied: parsed.repairApplied === true,
    argumentRepairKinds: parsed.repairKinds || [],
    ir: built.ir,
    raw: serialized.raw,
  };
};

export const runPrivateChatProviderFcAttempt = async ({
  enabled = true,
  client = null,
  config = {},
  messages = [],
  context = {},
  target = {},
  thinkingEnabled = false,
  temperature = 0.7,
  maxTokens = 2400,
  signal = null,
  onModelUsage = null,
  onProviderUsage = null,
  onFirstProviderDelta = null,
  onProviderDelta = null,
  requestOptions = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
  streamPreviewEnabled = false,
  onStructuredPreview = null,
  now = Date.now,
  localRuleOverride = null,
  probationMode = false,
  preparedProviderRequestPlan = null,
} = {}) => {
  const eligibility = resolvePrivateChatProviderFcEligibility({
    enabled,
    config,
    client,
    messages,
    context,
    target,
    localRuleOverride,
  });
  if (!eligibility.eligible) {
    return {
      attempted: false,
      ok: false,
      reason: eligibility.reason,
      requestedMode: REQUESTED_MODE,
      effectiveMode: '',
      diagnostics: eligibility,
    };
  }

  const providerRequestPlan = preparedProviderRequestPlan?.ok === true
    ? preparedProviderRequestPlan
    : buildProviderFcRequestPlan({
        config,
        tools: [buildPrivateReplyProviderToolDefinition({
      timeMode: target.timeMode,
          allowedItemTypes,
          allowedStickerKeywords,
        })],
        thinkingEnabled,
        temperature,
        reasoningOptions: requestOptions,
        localRuleOverride,
        probationMode,
      });
  if (!providerRequestPlan.ok) {
    return {
      attempted: false,
      ok: false,
      reason: providerRequestPlan.reason,
      requestedMode: REQUESTED_MODE,
      effectiveMode: '',
      diagnostics: {
        ...eligibility,
        providerFamily: providerRequestPlan.transport?.family || eligibility.providerFamily,
        providerEndpoint: providerRequestPlan.transport?.endpoint || eligibility.providerEndpoint,
      },
    };
  }

  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: eligibility.provider,
    model: eligibility.model,
    now,
  });
  const completedToolCalls = [];
  const streamPreview = createPhoneFcProviderStreamRuntime({
    enabled: streamPreviewEnabled,
    client,
    mode: 'private',
    toolName: PHONE_REPLY_IR_PRIVATE_TOOL_NAME,
    onPreview: onStructuredPreview,
    onFirstArgumentsDelta: onFirstProviderDelta,
    onArgumentsDelta: onProviderDelta,
    now,
  });
  let capturedUsage = null;
  const startedAt = Number(now?.() || Date.now()) || Date.now();
  const reportUsage = () => {
    if (typeof onModelUsage !== 'function') return;
    try {
      onModelUsage({
        ...(isPlainObject(capturedUsage) ? capturedUsage : {}),
        provider: eligibility.provider,
        model: eligibility.model,
        latencyMs: Math.max(0, (Number(now?.() || Date.now()) || Date.now()) - startedAt),
        modelCallCount: 1,
        degraded: false,
      });
    } catch {}
  };

  let responseText = '';
  try {
    const baseRequestOptions = sanitizeProviderFcInheritedRequestOptions({
      provider: eligibility.provider,
      options: requestOptions,
    });
    responseText = await streamPreview.request(messages, {
      ...baseRequestOptions,
      ...providerRequestPlan.generationOptions,
      maxTokens,
      max_tokens: maxTokens,
      ...providerRequestPlan.requestOptions,
      signal,
      onProviderUsage: usage => {
        capturedUsage = usage;
        try { onProviderUsage?.(usage); } catch {}
      },
      onProviderToolCallDelta: (data, meta = {}) => {
        const next = accumulator.push(data, {
          provider: trim(meta?.provider, eligibility.provider),
          model: trim(meta?.model, eligibility.model),
        });
        completedToolCalls.push(...next.completed);
        streamPreview.pushDeltas(next.deltas);
      },
    });
    reportUsage();
  } catch (error) {
    reportUsage();
    if (isAbortError(error, signal)) {
      streamPreview.dispose('aborted', 'aborted');
      throw error;
    }
    streamPreview.dispose('fallback', 'provider_request_failed');
    return {
      attempted: true,
      ok: false,
      reason: 'provider_request_failed',
      requestedMode: REQUESTED_MODE,
      effectiveMode: '',
      diagnostics: {
        ...eligibility,
        ...(providerRequestPlan.diagnostics || {}),
        toolCallCount: completedToolCalls.length,
        responseChars: 0,
        errorCode: trim(error?.code || error?.name, 'request_failed'),
        httpStatus: Number.isFinite(Number(error?.status || error?.statusCode))
          ? Math.trunc(Number(error?.status || error?.statusCode))
          : 0,
        providerCode: trim(
          error?.providerCode || error?.providerErrorCode || error?.code || error?.type,
        ).replace(/[^a-z0-9._:-]+/giu, '_').slice(0, 160),
        providerCategory: trim(error?.providerCategory)
          .replace(/[^a-z0-9._:-]+/giu, '_').slice(0, 160),
        ...streamPreview.getDiagnostics(),
      },
    };
  }

  const responseChars = String(responseText || '').length;
  const normalized = normalizePrivateChatProviderFcCalls({
    completedToolCalls,
    target,
    source: {
      transport: REQUESTED_MODE,
      provider: eligibility.provider,
      model: eligibility.model,
    },
    allowedItemTypes,
    allowedStickerKeywords,
  });
  const validationErrorCodes = sanitizeProtocolDiagnosticCodes(normalized.validationErrors);
  if (normalized.ok && trim(responseText)) {
    streamPreview.dispose('fallback', 'unexpected_response_text');
    return {
      attempted: true,
      ok: false,
      reason: 'unexpected_response_text',
      requestedMode: REQUESTED_MODE,
      effectiveMode: '',
      diagnostics: {
        ...eligibility,
        ...(providerRequestPlan.diagnostics || {}),
        toolCallCount: completedToolCalls.length,
        responseChars,
        validationErrorCount: 0,
        validationErrorCodes: [],
        ...streamPreview.getDiagnostics(),
      },
    };
  }
  streamPreview.dispose(normalized.ok ? 'accepted' : 'fallback', normalized.reason);
  return {
    attempted: true,
    ...normalized,
    requestedMode: REQUESTED_MODE,
    effectiveMode: normalized.ok ? REQUESTED_MODE : '',
    diagnostics: {
      ...eligibility,
      ...(providerRequestPlan.diagnostics || {}),
      toolCallCount: completedToolCalls.length,
      responseChars,
      validationErrorCount: Array.isArray(normalized.validationErrors)
        ? normalized.validationErrors.length
        : 0,
      validationErrorCodes,
      argumentRepairApplied: normalized.argumentRepairApplied === true,
      argumentRepairKinds: sanitizeProtocolDiagnosticCodes(normalized.argumentRepairKinds),
      ...streamPreview.getDiagnostics(),
    },
  };
};

export const runPrivateChatGenerationWithFallback = async ({
  runTextFallback = null,
  persistentCommitStarted = false,
  ...attemptOptions
} = {}) => {
  const attempt = await runPrivateChatProviderFcAttempt(attemptOptions);
  if (attempt.ok) return attempt;
  if (persistentCommitStarted === true) {
    return {
      ...attempt,
      ok: false,
      reason: 'fallback_after_commit_forbidden',
      fallbackReason: attempt.reason,
    };
  }
  if (typeof runTextFallback !== 'function') return attempt;
  const fallback = await runTextFallback({
    reason: attempt.reason,
    attempted: attempt.attempted === true,
    diagnostics: attempt.diagnostics,
  });
  return {
    ...(isPlainObject(fallback) ? fallback : { ok: true, raw: String(fallback ?? '') }),
    requestedMode: REQUESTED_MODE,
    effectiveMode: LEGACY_MODE,
    fallbackReason: attempt.reason,
  };
};
