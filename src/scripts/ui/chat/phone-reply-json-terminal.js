import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';
import {
  sanitizeProviderFcInheritedRequestOptions,
} from '../../agent/provider-fc-transport.js';
import {
  PHONE_REPLY_IR_VERSION,
  buildPrivateReplyProviderToolDefinition,
} from './phone-reply-ir.js';
import {
  buildPhoneReplyBatchProviderToolDefinition,
} from './phone-reply-batch-ir.js';
import {
  buildPrivateChatStructuredPromptMessages,
  normalizePrivateChatProviderFcCalls,
} from './private-chat-provider-fc.js';
import {
  buildPhoneBatchStructuredPromptMessages,
  normalizePhoneBatchProviderFcCalls,
} from './phone-batch-provider-fc.js';
import { parseProviderToolArguments } from './provider-tool-arguments-json-utils.js';
import { isMeaningfulTextStreamDelta } from './generation-provider-call-diagnostics-utils.js';
import {
  buildStructuredFailureShapeDiagnostics,
  sanitizeProtocolDiagnosticCodes,
} from './protocol-generation-diagnostics-utils.js';

export const PHONE_REPLY_JSON_FORMAT_MODES = Object.freeze({
  jsonSchema: 'json_schema',
  jsonObject: 'json_object',
  promptJson: 'prompt_json',
});

const FORMAT_MODES = new Set(Object.values(PHONE_REPLY_JSON_FORMAT_MODES));
const REQUESTED_MODE = 'json_terminal';
const PRIVATE_ADAPTER = 'private_reply';
const BATCH_ADAPTER = 'phone_batch';
const SUPPORTED_ADAPTERS = new Set([PRIVATE_ADAPTER, BATCH_ADAPTER]);
const SUPPORTED_SURFACES = new Set(['private_chat', 'group_chat', 'moment_comment']);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const trim = (value, fallback = '') => String(value ?? '').trim() || fallback;
const trimLower = value => trim(value).toLowerCase();
const clone = (value, fallback = null) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

export const sanitizePhoneReplyJsonInheritedRequestOptions = ({
  provider = '',
  options = {},
} = {}) => {
  const original = isPlainObject(options) ? options : {};
  const sanitized = sanitizeProviderFcInheritedRequestOptions({ provider, options: original });
  // JSON 终态不携带任何工具或旧 response_format，但必须保留用户的推理偏好；
  // FC 清理器会移除这些字段，因为强制工具路径可能需要覆盖它们。
  ['reasoning_effort', 'thinking'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(original, key)) {
      sanitized[key] = clone(original[key], original[key]);
    }
  });
  delete sanitized.parallel_tool_calls;
  return sanitized;
};

const normalizeAdapter = value => (
  trimLower(value) === BATCH_ADAPTER ? BATCH_ADAPTER : PRIVATE_ADAPTER
);

const isAbortError = (error, signal = null) => signal?.aborted === true || error?.name === 'AbortError';

const normalizeProviderErrorCode = (error = {}) => trimLower(
  error?.providerCode
  || error?.providerErrorCode
  || error?.code
  || error?.type
  || error?.name,
).replace(/[^a-z0-9._:-]+/gu, '_').slice(0, 160);

const normalizeHttpStatus = value => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 100 && number <= 599 ? number : 0;
};

const isOfficialHost = (value, hosts) => {
  const raw = trim(value);
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
};

export const resolvePhoneReplyJsonFormatMode = ({
  config = {},
  capabilities = {},
} = {}) => {
  const explicit = trimLower(capabilities?.formatMode || config?.phoneReplyJsonFormatMode);
  if (FORMAT_MODES.has(explicit)) return explicit;
  if (capabilities?.jsonSchema === true) return PHONE_REPLY_JSON_FORMAT_MODES.jsonSchema;
  if (capabilities?.jsonObject === true) return PHONE_REPLY_JSON_FORMAT_MODES.jsonObject;
  const provider = trimLower(config?.provider);
  if (
    provider === 'deepseek'
    && isOfficialHost(config?.baseUrl, ['api.deepseek.com'])
  ) return PHONE_REPLY_JSON_FORMAT_MODES.jsonObject;
  return PHONE_REPLY_JSON_FORMAT_MODES.promptJson;
};

export const derivePhoneReplyJsonFormatCapabilities = ({
  provider = '',
  metadataKnown = false,
  supportedParameters = [],
} = {}) => {
  // 唯一的元数据来源是 OpenRouter 缓存的 supported_parameters（由显式模型刷新填充）；
  // 其他 Provider 留空，交由 config 显式档位或 DeepSeek 官方 host 规则决定。
  if (trimLower(provider) !== 'openrouter' || metadataKnown !== true) return {};
  const params = new Set(
    (Array.isArray(supportedParameters) ? supportedParameters : [])
      .map(item => trimLower(item))
      .filter(Boolean),
  );
  const capabilities = {};
  if (params.has('structured_outputs')) capabilities.jsonSchema = true;
  if (params.has('response_format')) capabilities.jsonObject = true;
  return capabilities;
};

const buildArgumentsSchema = ({
  adapter,
  target = {},
  capabilities = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => {
  const tool = normalizeAdapter(adapter) === BATCH_ADAPTER
    ? buildPhoneReplyBatchProviderToolDefinition({
        target,
        capabilities,
        allowedItemTypes,
        allowedStickerKeywords,
      })
    : buildPrivateReplyProviderToolDefinition({
      timeMode: target.timeMode,
        allowedItemTypes,
        allowedStickerKeywords,
      });
  return clone(tool?.function?.parameters, { type: 'object', properties: {} });
};

export const buildPhoneReplyJsonEnvelopeSchema = ({
  adapter = PRIVATE_ADAPTER,
  target = {},
  capabilities = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => ({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'payload'],
  properties: {
    version: {
      const: PHONE_REPLY_IR_VERSION,
      description: 'Fixed terminal contract version.',
    },
    payload: buildArgumentsSchema({
      adapter,
      target,
      capabilities,
      allowedItemTypes,
      allowedStickerKeywords,
    }),
  },
});

export const buildPhoneReplyJsonRequestOptions = ({
  formatMode = PHONE_REPLY_JSON_FORMAT_MODES.promptJson,
  schema = {},
} = {}) => {
  const normalizedMode = FORMAT_MODES.has(trimLower(formatMode))
    ? trimLower(formatMode)
    : PHONE_REPLY_JSON_FORMAT_MODES.promptJson;
  if (normalizedMode === PHONE_REPLY_JSON_FORMAT_MODES.jsonSchema) {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'phone_reply_ir',
          strict: true,
          schema: clone(schema, {}),
        },
      },
    };
  }
  if (normalizedMode === PHONE_REPLY_JSON_FORMAT_MODES.jsonObject) {
    return { response_format: { type: 'json_object' } };
  }
  return {};
};

export const buildPhoneReplyJsonTransportInstruction = ({
  formatMode = PHONE_REPLY_JSON_FORMAT_MODES.promptJson,
  schema = {},
  semanticInstruction = '',
} = {}) => {
  const normalizedMode = FORMAT_MODES.has(trimLower(formatMode))
    ? trimLower(formatMode)
    : PHONE_REPLY_JSON_FORMAT_MODES.promptJson;
  const lines = [
    getLocalizedPromptText('fc.json_terminal.head'),
    getLocalizedPromptText('fc.json_terminal.envelope').split('{irVersion}').join(PHONE_REPLY_IR_VERSION),
    trim(semanticInstruction),
  ].filter(Boolean);
  if (normalizedMode !== PHONE_REPLY_JSON_FORMAT_MODES.jsonSchema) {
    lines.push(getLocalizedPromptText('fc.json_terminal.schema').split('{schema}').join(JSON.stringify(schema)));
  } else {
    lines.push(getLocalizedPromptText('fc.json_terminal.mode').split('{mode}').join(normalizedMode));
  }
  return lines.join('\n');
};

const validateEnvelope = (value) => {
  if (!isPlainObject(value)) return { ok: false, reason: 'invalid_terminal_envelope', payload: null };
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'payload' || keys[1] !== 'version') {
    return { ok: false, reason: 'invalid_terminal_envelope', payload: null };
  }
  if (trim(value.version) !== PHONE_REPLY_IR_VERSION) {
    return { ok: false, reason: 'terminal_version_unsupported', payload: null };
  }
  if (!isPlainObject(value.payload)) {
    return { ok: false, reason: 'invalid_terminal_envelope', payload: null };
  }
  return { ok: true, reason: '', payload: value.payload };
};

export const normalizePhoneReplyJsonResponse = ({
  text = '',
  adapter = PRIVATE_ADAPTER,
  target = {},
  capabilities = {},
  source = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => {
  const parsed = parseProviderToolArguments({
    metadata: { streamingArgumentsText: String(text ?? '') },
  });
  if (!parsed.ok) {
    return {
      ok: false,
      reason: 'invalid_terminal_json',
      argumentRepairApplied: false,
      argumentRepairKinds: [],
    };
  }
  const envelope = validateEnvelope(parsed.args);
  if (!envelope.ok) {
    return {
      ok: false,
      reason: envelope.reason,
      argumentRepairApplied: parsed.repairApplied === true,
      argumentRepairKinds: parsed.repairKinds || [],
    };
  }
  const normalizedAdapter = normalizeAdapter(adapter);
  const call = { arguments: envelope.payload };
  const normalized = normalizedAdapter === BATCH_ADAPTER
    ? normalizePhoneBatchProviderFcCalls({
        completedToolCalls: [{ ...call, toolName: 'emit_phone_batch' }],
        target,
        capabilities,
        source: { ...source, transport: REQUESTED_MODE },
        allowedItemTypes,
        allowedStickerKeywords,
      })
    : normalizePrivateChatProviderFcCalls({
        completedToolCalls: [{ ...call, toolName: 'emit_private_reply' }],
        target,
        source: { ...source, transport: REQUESTED_MODE },
        allowedItemTypes,
        allowedStickerKeywords,
      });
  return {
    ...normalized,
    argumentRepairApplied: parsed.repairApplied === true,
    argumentRepairKinds: parsed.repairKinds || [],
    canonicalRoundTrip: normalized.ok === true,
    frozenTargetMatched: normalized.ok === true,
    domainValidated: normalized.ok === true,
  };
};

const resolveJsonEligibility = ({
  enabled,
  client,
  context,
  target,
  adapter,
} = {}) => {
  const surface = trimLower(context?.surface || target?.mode || 'private_chat');
  const requestedAdapter = trimLower(adapter, PRIVATE_ADAPTER);
  let reason = '';
  if (enabled !== true) reason = 'feature_disabled';
  else if (!client || typeof client.chat !== 'function') reason = 'provider_client_unavailable';
  else if (!SUPPORTED_ADAPTERS.has(requestedAdapter)) reason = 'json_adapter_unsupported';
  else if (context?.compatibilityModeEnabled === true) reason = 'compatibility_mode';
  else if (trimLower(context?.uiMode, 'chat') === 'rp') reason = 'creative_mode';
  else if (!SUPPORTED_SURFACES.has(surface)) reason = 'unsupported_surface';
  else if (context?.protocolParserEnabled !== true) reason = 'protocol_parser_disabled';
  else if (context?.hasUnsupportedSideEffects === true) reason = 'unsupported_side_effects';
  else if (context?.assistantContinuation === true) reason = 'assistant_continuation';
  else if (context?.webSearchEnabled === true) reason = 'web_search_enabled';
  else if (context?.hasProviderTools === true) reason = 'provider_tools_present';
  else if (context?.hasAssistantPrefill === true) reason = 'assistant_prefill_present';
  else if (context?.usesDefaultPreset !== true) reason = 'custom_preset';
  else if (context?.usesBuiltinFormat !== true) reason = 'custom_format';
  else if (context?.formatProfileEnabled === true) reason = 'custom_format_profile';
  else if (!['assistant', 'character'].includes(trimLower(context?.responseTarget, 'assistant'))) {
    reason = 'unsupported_response_target';
  }
  else if (!trim(target?.sessionId) || !trim(target?.targetName)) reason = 'target_unavailable';
  return { eligible: !reason, reason, surface };
};

export const preparePhoneReplyJsonRoute = ({
  enabled = false,
  config = {},
  client = null,
  messages = [],
  transportPlan = {},
  context = {},
  target = {},
  adapter = PRIVATE_ADAPTER,
  capabilities = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
  snapshotContext = {},
  formatCapabilities = {},
} = {}) => {
  const normalizedAdapter = normalizeAdapter(adapter);
  const eligibility = resolveJsonEligibility({ enabled, client, context, target, adapter });
  const formatMode = resolvePhoneReplyJsonFormatMode({ config, capabilities: formatCapabilities });
  const schema = buildPhoneReplyJsonEnvelopeSchema({
    adapter: normalizedAdapter,
    target,
    capabilities,
    allowedItemTypes,
    allowedStickerKeywords,
  });
  if (!eligibility.eligible) {
    return {
      ...eligibility,
      requestedMode: REQUESTED_MODE,
      formatMode,
      messages: [],
      semanticSnapshot: null,
      schema,
    };
  }
  const semanticInstruction = normalizedAdapter === BATCH_ADAPTER
    ? getLocalizedPromptText('fc.json_terminal.semantic_batch')
    : getLocalizedPromptText('fc.json_terminal.semantic_private');
  const instruction = buildPhoneReplyJsonTransportInstruction({
    formatMode,
    schema,
    semanticInstruction,
  });
  const structured = normalizedAdapter === BATCH_ADAPTER
    ? buildPhoneBatchStructuredPromptMessages({
        messages,
        transportPlan,
        instruction,
        snapshotContext,
      })
    : buildPrivateChatStructuredPromptMessages({
        messages,
        transportPlan,
        instruction,
        snapshotContext,
      });
  if (!structured.ok) {
    return {
      ...eligibility,
      eligible: false,
      reason: structured.reason,
      requestedMode: REQUESTED_MODE,
      formatMode,
      messages: [],
      semanticSnapshot: structured.semanticSnapshot || null,
      snapshotFingerprint: trim(structured.snapshotFingerprint),
      promptDiagnostics: structured.diagnostics || null,
      schema,
    };
  }
  return {
    ...eligibility,
    requestedMode: REQUESTED_MODE,
    formatMode,
    messages: structured.messages,
    semanticSnapshot: structured.semanticSnapshot || null,
    snapshotFingerprint: trim(structured.snapshotFingerprint),
    promptDiagnostics: structured.diagnostics || null,
    schema,
    requestOptions: buildPhoneReplyJsonRequestOptions({ formatMode, schema }),
  };
};

export const runPhoneReplyJsonAttempt = async ({
  enabled = true,
  client = null,
  config = {},
  messages = [],
  adapter = PRIVATE_ADAPTER,
  target = {},
  capabilities = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
  formatMode = PHONE_REPLY_JSON_FORMAT_MODES.promptJson,
  schema = null,
  stream = false,
  maxTokens = 3200,
  signal = null,
  requestOptions = {},
  onProviderUsage = null,
  onFirstProviderDelta = null,
  onProviderDelta = null,
  now = Date.now,
} = {}) => {
  if (enabled !== true || !client || typeof client.chat !== 'function') {
    return {
      attempted: false,
      ok: false,
      reason: enabled === true ? 'provider_client_unavailable' : 'feature_disabled',
      requestedMode: REQUESTED_MODE,
      effectiveMode: '',
      diagnostics: {},
    };
  }
  const normalizedAdapter = normalizeAdapter(adapter);
  const terminalSchema = schema || buildPhoneReplyJsonEnvelopeSchema({
    adapter: normalizedAdapter,
    target,
    capabilities,
    allowedItemTypes,
    allowedStickerKeywords,
  });
  const baseOptions = sanitizePhoneReplyJsonInheritedRequestOptions({
    provider: config?.provider,
    options: requestOptions,
  });
  const terminalOptions = buildPhoneReplyJsonRequestOptions({ formatMode, schema: terminalSchema });
  let text = '';
  let capturedUsage = null;
  let firstMeaningfulDeltaObserved = false;
  const startedAt = Number(now?.() || Date.now()) || Date.now();
  try {
    const options = {
      ...baseOptions,
      maxTokens,
      max_tokens: maxTokens,
      ...terminalOptions,
      signal,
      onProviderUsage: usage => {
        capturedUsage = usage;
        try { onProviderUsage?.(usage); } catch {}
      },
    };
    if (stream === true && typeof client.streamChat === 'function') {
      for await (const chunk of client.streamChat(messages, options)) {
        if (typeof chunk !== 'string') continue;
        text += chunk;
        if (isMeaningfulTextStreamDelta(chunk)) {
          const event = { at: Number(now?.() || Date.now()) || Date.now() };
          try { onProviderDelta?.(event); } catch {}
          if (!firstMeaningfulDeltaObserved) {
            firstMeaningfulDeltaObserved = true;
            try { onFirstProviderDelta?.(event); } catch {}
          }
        }
      }
    } else {
      text = String(await client.chat(messages, options) ?? '');
    }
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return {
      attempted: true,
      ok: false,
      reason: 'provider_request_failed',
      requestedMode: REQUESTED_MODE,
      effectiveMode: '',
      diagnostics: {
        httpStatus: normalizeHttpStatus(error?.status || error?.statusCode),
        providerCode: normalizeProviderErrorCode(error),
        providerCategory: trimLower(error?.providerCategory)
          .replace(/[^a-z0-9._:-]+/gu, '_').slice(0, 160),
        firstMeaningfulDeltaObserved,
        responseChars: text.length,
        latencyMs: Math.max(0, (Number(now?.() || Date.now()) || Date.now()) - startedAt),
      },
    };
  }
  const normalized = normalizePhoneReplyJsonResponse({
    text,
    adapter: normalizedAdapter,
    target,
    capabilities,
    source: {
      provider: trim(config?.provider),
      model: trim(config?.model),
    },
    allowedItemTypes,
    allowedStickerKeywords,
  });
  const validationErrorCodes = sanitizeProtocolDiagnosticCodes([
    normalized.reason,
    ...(normalized.validationErrors || []),
  ]);
  const failureShape = normalized.ok ? null : buildStructuredFailureShapeDiagnostics({
    raw: text,
    finishReason: capturedUsage?.finishReason || capturedUsage?.finish_reason,
    maxTokens,
    completionTokens: capturedUsage?.completionTokens || capturedUsage?.completion_tokens,
    validationErrors: validationErrorCodes,
  });
  return {
    attempted: true,
    ...normalized,
    requestedMode: REQUESTED_MODE,
    effectiveMode: normalized.ok ? REQUESTED_MODE : '',
    diagnostics: {
      formatMode,
      responseChars: text.length,
      firstMeaningfulDeltaObserved,
      argumentRepairApplied: normalized.argumentRepairApplied === true,
      argumentRepairKinds: Array.isArray(normalized.argumentRepairKinds)
        ? normalized.argumentRepairKinds.slice(0, 20)
        : [],
      validationErrorCount: Array.isArray(normalized.validationErrors)
        ? normalized.validationErrors.length
        : 0,
      validationErrorCodes,
      ...(failureShape ? { failureShape } : {}),
      latencyMs: Math.max(0, (Number(now?.() || Date.now()) || Date.now()) - startedAt),
    },
  };
};
