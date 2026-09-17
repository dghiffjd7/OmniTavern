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
  buildStructuredFailureShapeDiagnostics,
  redactProviderToolSchemaForDiagnostics,
  sanitizeProtocolDiagnosticCodes,
} from './protocol-generation-diagnostics-utils.js';
import {
  PHONE_REPLY_IR_BATCH_TOOL_NAME,
  buildPhoneReplyBatchIr,
  buildPhoneReplyBatchProviderToolDefinition,
  serializePhoneReplyBatchIr,
} from './phone-reply-batch-ir.js';
import { parseProviderToolArguments } from './provider-tool-arguments-json-utils.js';
import { containsTextProtocol } from '../../utils/text-protocol-marker-utils.js';

const REQUESTED_MODE = 'provider_fc';
const LEGACY_MODE = 'legacy_text';
const SUPPORTED_SURFACES = new Set(['private_chat', 'group_chat', 'moment_comment']);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeIdentityList = (value = []) => (Array.isArray(value) ? value : [])
  .map(item => ({ id: trim(item?.id), name: trim(item?.name || item?.id) }))
  .filter(item => item.id && item.name);

const normalizeAllowedItemTypes = (value = ['text']) => {
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

const normalizeCapabilities = (value = {}) => ({
  momentPost: value?.momentPost === true,
  momentCommentSideChats: value?.momentCommentSideChats === true,
  imagePrompt: value?.imagePrompt === true,
  tableEdit: value?.tableEdit === true,
  variableUpdate: value?.variableUpdate === true,
  summary: value?.summary === true,
});

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

const sanitizeMemoryEditRulesBody = (value = '') => String(value ?? '')
  .replace(/<\s*tableEdit\b[^>]*>[\s\S]*?<\s*\/\s*tableEdit\s*>/gi, '')
  .replace(/^\s*<\s*\/?\s*[^>\n]+>\s*$/gim, '')
  .replace(/^.*(?:按|依照|使用|严格).*?(?:XML|标签|文本格式|序列化|tableEdit).*?(?:输出|返回|提交|回复).*$/gimu, '')
  .replace(/^.*(?:输出|返回|提交|回复).*?(?:XML|标签|文本格式|序列化|tableEdit).*$/gimu, '')
  .replace(/^.*\b(?:output|return|submit|reply)\b.*?\b(?:XML|tags?|tableEdit|serializ\w*)\b.*$/gim, '')
  .replace(/^.*\b(?:XML|tableEdit|serializ\w*)\b.*?\b(?:output|return|submit|reply)\b.*$/gim, '')
  .replace(/^.*(?:除此之外|不要输出解释|不得输出解释|只输出).*(?:输出|解释|内容).*$/gimu, '')
  .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
  .trim();

export const sanitizePhoneBatchSemanticText = (value = '') => String(value ?? '')
  .replace(/<\s*memory_edit_rules\b[^>]*>([\s\S]*?)<\s*\/\s*memory_edit_rules\s*>/gi, (_match, body) => (
    sanitizeMemoryEditRulesBody(body)
  ))
  .replace(/<\s*tableEdit\b[^>]*>[\s\S]*?<\s*\/\s*tableEdit\s*>/gi, () => getLocalizedPromptText('fc.batch.sanitize_table'))
  .replace(/<\s*UpdateVariable\b[^>]*>[\s\S]*?<\s*\/\s*UpdateVariable\s*>/gi, () => getLocalizedPromptText('fc.batch.sanitize_variable'))
  .replace(/<\s*image_prompt\b[^>]*>[\s\S]*?<\s*\/\s*image_prompt\s*>/gi, 'image_prompt item')
  .replace(/<\s*details\b[^>]*>\s*<\s*summary\b[^>]*>\s*摘要\s*<\s*\/\s*summary\s*>[\s\S]*?<\s*\/\s*details\s*>/gi, 'summary item')
  .replace(/<\s*\/?\s*content\s*>/gi, () => getLocalizedPromptText('fc.batch.sanitize_content'))
  .replace(/\bmoment_reply_start\s*\/\s*moment_reply_end\b/gi, 'moment_comment item')
  .replace(/\bmoment_start\s*(?:\.{3}|…{1,2}|\/|到|至)\s*moment_end\b/gi, 'moment_post item')
  .replace(/\b(?:MiPhone|msg)_(?:start|end)\b/gi, '')
  .replace(/\bmoment_reply_(?:start|end)\b/gi, '')
  .replace(/\bmoment_(?:start|end)\b/gi, '')
  .replace(/^\s*(?:评论人|联系人名|群成员名|说话人|发布者)--[^\r\n]*$/gim, '')
  .replace(/\breply_to_author::/gi, 'replyToAuthor 字段：')
  .replace(/\breply_to::/gi, 'replyTo 字段：')
  .replace(/^\s*(?:MiPhone_(?:start|end)|msg_(?:start|end)|moment_(?:start|end|reply_start|reply_end))\s*$/gim, '')
  .replace(/^\s*\[\s*summary_format\s*\]\s*$/gim, '')
  .replace(/^\s*<\s*\/?\s*(?:memory_edit_rules|generate_img_rule|线上格式|QQ聊天格式介绍|QQ空间格式介绍|聊天内容|成员|content)\b[^>]*>\s*$/gim, '')
  .replace(/^\s*<\s*\/?\s*[^>\n]*的私聊\s*>\s*$/gim, '')
  .replace(/^\s*<\s*\/?\s*群聊\s*[:：][^>\n]*>\s*$/gim, '')
  .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
  .trim();

const describeIdentities = (label, identities) => {
  const list = normalizeIdentityList(identities);
  if (!list.length) return '';
  return `${label}：${list.map(item => `${item.id}=${item.name}`).join('；')}`;
};

export const buildPhoneBatchStructuredTransportInstruction = ({
  target = {},
  capabilities = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => {
  const mode = trim(target?.mode).toLowerCase();
  const caps = normalizeCapabilities(capabilities);
  const itemTypes = normalizeAllowedItemTypes(allowedItemTypes);
  const stickerKeywords = normalizeKeywords(allowedStickerKeywords);
  const order = [
    mode === 'moment_comment' ? 'moment_comment' : 'chat',
    ...(mode === 'moment_comment' && caps.momentCommentSideChats ? ['private_chat/group_chat'] : []),
    ...(caps.momentPost ? ['moment_post'] : []),
    ...(caps.imagePrompt ? ['image_prompt'] : []),
    ...(caps.tableEdit ? ['table_edit'] : []),
    ...(caps.variableUpdate ? ['variable_update'] : []),
    ...(caps.summary ? ['summary'] : []),
  ];
  const t = key => getLocalizedPromptText(key);
  const fill = (key, params = {}) => Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value ?? '')),
    t(key),
  );
  const lines = [
    t('fc.batch.head'),
    t('fc.batch.frozen'),
    fill('fc.batch.order', {
      order: order.join(' → '),
      first: mode === 'moment_comment' ? ' moment_comment' : ' chat',
    }),
    t('fc.batch.kinds'),
    fill('fc.batch.types', { types: itemTypes.join('、') }),
    mode === 'group_chat' ? describeIdentities(t('fc.batch.label_group_members'), target?.members) : '',
    mode === 'moment_comment' ? describeIdentities(t('fc.batch.label_comment_authors'), target?.momentAuthors) : '',
    caps.momentPost ? describeIdentities(t('fc.batch.label_moment_authors'), target?.momentAuthors) : '',
    mode === 'moment_comment' && caps.momentCommentSideChats
      ? describeIdentities(t('fc.batch.label_private_targets'), target?.privateTargets)
      : '',
    mode === 'moment_comment' && caps.momentCommentSideChats && Array.isArray(target?.groupTargets)
      ? fill('fc.batch.group_targets', {
          list: target.groupTargets.map(item => `${trim(item?.id)}=${trim(item?.name || item?.id)}`).filter(Boolean).join('；'),
        })
      : '',
    itemTypes.includes('sticker') && stickerKeywords.length
      ? fill('fc.batch.stickers', { keywords: stickerKeywords.join('、') })
      : '',
    caps.momentPost ? t('fc.batch.moment_post_shape') : '',
    caps.momentPost ? t('fc.batch.moment_post_when') : '',
    caps.imagePrompt ? t('fc.batch.image_prompt_when') : '',
    caps.tableEdit && Array.isArray(target?.tableTargets)
      ? fill('fc.batch.tables', {
          list: target.tableTargets.map((item) => {
            const id = trim(item?.id);
            const name = trim(item?.name || item?.id);
            if (!id || !name) return '';
            const rowCount = Array.isArray(item?.rowIds)
              ? item.rowIds.filter(rowId => trim(rowId)).length
              : 0;
            if (!rowCount) return fill('fc.batch.table_empty', { id, name });
            const indexes = rowCount === 1 ? '0' : `0–${rowCount - 1}`;
            return fill('fc.batch.table_rows', { id, name, indexes });
          }).filter(Boolean).join('；'),
        })
      : '',
    caps.tableEdit ? t('fc.batch.table_rules') : '',
    caps.variableUpdate ? t('fc.batch.variable_rules') : '',
    caps.summary ? t('fc.batch.summary_rule') : '',
  ];
  return lines.filter(Boolean).join('\n');
};

export const buildPhoneBatchStructuredPromptMessages = ({
  messages = [],
  transportPlan = {},
  instruction = '',
  snapshotContext = {},
} = {}) => {
  const surface = trim(transportPlan?.surface).toLowerCase();
  const requiredBlocks = [];
  const phoneLayers = resolvePhoneFormatTransportLayers(transportPlan);
  const outputLayer = trim(transportPlan?.outputFormatReminder);
  if (surface !== 'moment_comment') {
    if (!phoneLayers.length || !outputLayer) {
      return {
        ok: false,
        reason: 'text_transport_plan_unavailable',
        messages: [],
        diagnostics: { removals: {} },
      };
    }
    requiredBlocks.push(...phoneLayers);
  }
  if (!outputLayer) {
    return {
      ok: false,
      reason: 'text_transport_plan_unavailable',
      messages: [],
      diagnostics: { removals: {} },
    };
  }
  requiredBlocks.push({ id: 'output_format', content: outputLayer });
  (Array.isArray(transportPlan?.removableProtocolBlocks) ? transportPlan.removableProtocolBlocks : [])
    .forEach((entry, index) => {
      const content = trim(entry?.content);
      if (content) requiredBlocks.push({ id: trim(entry?.id, `owned_${index}`), content });
    });
  const momentCommentDataContent = trim(transportPlan?.momentCommentDataContent);
  if (momentCommentDataContent) {
    requiredBlocks.push({ id: 'moment_comment_data', content: momentCommentDataContent });
  }

  const semanticTexts = (Array.isArray(transportPlan?.semanticSources) ? transportPlan.semanticSources : [])
    .map(entry => sanitizePhoneBatchSemanticText(entry?.content))
    .filter(Boolean);
  const momentCommentSemantic = sanitizePhoneBatchSemanticText(momentCommentDataContent);
  if (momentCommentSemantic) semanticTexts.push(momentCommentSemantic);
  const structuredInstruction = trim(instruction) || '只通过唯一结构化函数提交最终回复。';
  const transportMessage = [
    trim(transportPlan?.scenarioReminder),
    ...semanticTexts,
    structuredInstruction,
  ].filter(Boolean).join('\n\n');
  const deferredLayers = Array.isArray(transportPlan?.deferredLegacyLayers)
    ? transportPlan.deferredLegacyLayers
    : [];
  const snapshotLayers = requiredBlocks.map(block => ({
    ...block,
    marker: trim(deferredLayers.find(entry => trim(entry?.id) === block.id)?.marker),
  }));
  const created = createChatSemanticSnapshot({
    ...(snapshotContext && typeof snapshotContext === 'object' ? snapshotContext : {}),
    legacyMessages: messages,
    legacyLayers: snapshotLayers,
    providerFcTransportMessage: transportMessage,
  });
  const removals = { ...(created.diagnostics?.layerMatches || {}) };
  if (!created.ok) {
    return {
      ok: false,
      reason: 'text_transport_layer_mismatch',
      messages: [],
      diagnostics: { removals },
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
      diagnostics: { removals },
    };
  }
  return {
    ok: true,
    reason: '',
    messages: nextMessages,
    semanticSnapshot: created.snapshot,
    snapshotFingerprint: created.snapshot.fingerprint,
    diagnostics: { removals },
  };
};

export const resolvePhoneBatchProviderFcEligibility = ({
  enabled = false,
  config = {},
  client = null,
  messages = [],
  context = {},
  target = {},
  localRuleOverride = null,
} = {}) => {
  const surface = trim(context?.surface || target?.mode).toLowerCase();
  const providerTransport = resolveProviderFcTransport(config, { localRuleOverride });
  let reason = '';
  if (enabled !== true) reason = 'feature_disabled';
  else if (context?.compatibilityModeEnabled === true) reason = 'compatibility_mode';
  else if (!providerTransport.supported) reason = providerTransport.reason;
  else if (!client || typeof client.chat !== 'function') reason = 'provider_client_unavailable';
  else if (trim(context?.uiMode, 'chat').toLowerCase() === 'rp') reason = 'creative_mode';
  else if (!SUPPORTED_SURFACES.has(surface) || trim(target?.mode).toLowerCase() !== surface) reason = 'unsupported_surface';
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
  else if (!trim(target?.sessionId) || !trim(target?.targetName)) reason = 'target_unavailable';
  else if (surface === 'private_chat' && !trim(target?.speakerName)) reason = 'target_unavailable';
  else if (surface === 'group_chat' && !normalizeIdentityList(target?.members).length) reason = 'target_unavailable';
  else if (surface === 'moment_comment' && (!trim(target?.momentId) || !normalizeIdentityList(target?.momentAuthors).length)) {
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
    surface,
    sessionId: trim(target?.sessionId),
  };
};

export const preparePhoneBatchProviderFcRoute = ({
  enabled = false,
  config = {},
  client = null,
  messages = [],
  transportPlan = {},
  context = {},
  target = {},
  capabilities = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
  snapshotContext = {},
} = {}) => {
  if (enabled !== true) {
    const eligibility = resolvePhoneBatchProviderFcEligibility({
      enabled,
      config,
      client,
      messages: [],
      context,
      target,
    });
    return { ...eligibility, messages: [], promptDiagnostics: null };
  }
  const toolDefinition = buildPhoneReplyBatchProviderToolDefinition({
    target,
    capabilities,
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
  const structured = buildPhoneBatchStructuredPromptMessages({
    messages,
    transportPlan,
    instruction: buildPhoneBatchStructuredTransportInstruction({
      target,
      capabilities,
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
      surface: trim(context?.surface || target?.mode),
      sessionId: trim(target?.sessionId),
      messages: [],
      semanticSnapshot: structured.semanticSnapshot || null,
      snapshotFingerprint: String(structured.snapshotFingerprint || ''),
      toolSchemaDiagnostics,
      toolSchemaLocal,
      promptDiagnostics: structured.diagnostics || null,
    };
  }
  const eligibility = resolvePhoneBatchProviderFcEligibility({
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

export const normalizePhoneBatchProviderFcCalls = ({
  completedToolCalls = [],
  target = {},
  capabilities = {},
  source = {},
  allowedItemTypes = ['text'],
  allowedStickerKeywords = [],
} = {}) => {
  const calls = Array.isArray(completedToolCalls) ? completedToolCalls : [];
  if (!calls.length) return { ok: false, reason: 'no_tool_call', toolCallCount: 0 };
  if (calls.length !== 1) return { ok: false, reason: 'multiple_tool_calls', toolCallCount: calls.length };
  const call = calls[0] || {};
  const toolName = trim(call?.toolName || call?.name);
  if (toolName !== PHONE_REPLY_IR_BATCH_TOOL_NAME) {
    return { ok: false, reason: 'unknown_tool', toolCallCount: 1 };
  }
  const parsed = parseProviderToolArguments(call);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, toolCallCount: 1 };
  const built = buildPhoneReplyBatchIr({
    args: parsed.args,
    target,
    capabilities,
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
  const serialized = serializePhoneReplyBatchIr(built.ir, {
    timeMode: target.timeMode,
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

export const runPhoneBatchProviderFcAttempt = async ({
  enabled = true,
  client = null,
  config = {},
  messages = [],
  context = {},
  target = {},
  capabilities = {},
  thinkingEnabled = false,
  temperature = 0.7,
  maxTokens = 3200,
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
  const eligibility = resolvePhoneBatchProviderFcEligibility({
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
        tools: [buildPhoneReplyBatchProviderToolDefinition({
          target,
          capabilities,
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
    mode: 'batch',
    toolName: PHONE_REPLY_IR_BATCH_TOOL_NAME,
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
  const normalized = normalizePhoneBatchProviderFcCalls({
    completedToolCalls,
    target,
    capabilities,
    source: {
      transport: REQUESTED_MODE,
      provider: eligibility.provider,
      model: eligibility.model,
    },
    allowedItemTypes,
    allowedStickerKeywords,
  });
  const validationErrorCodes = sanitizeProtocolDiagnosticCodes(normalized.validationErrors);
  const rawArguments = completedToolCalls.length === 1
    ? String(
        completedToolCalls[0]?.metadata?.streamingArgumentsText
        ?? completedToolCalls[0]?.argumentsText
        ?? completedToolCalls[0]?.arguments
        ?? '',
      )
    : '';
  const failureShape = normalized.ok ? null : buildStructuredFailureShapeDiagnostics({
    raw: rawArguments,
    finishReason: capturedUsage?.finishReason || capturedUsage?.finish_reason,
    maxTokens,
    completionTokens: capturedUsage?.completionTokens || capturedUsage?.completion_tokens,
    validationErrors: [normalized.reason, ...(normalized.validationErrors || [])],
  });
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
      ...(failureShape ? { failureShape } : {}),
      argumentRepairApplied: normalized.argumentRepairApplied === true,
      argumentRepairKinds: sanitizeProtocolDiagnosticCodes(normalized.argumentRepairKinds),
      ...streamPreview.getDiagnostics(),
    },
  };
};

export const runPhoneBatchGenerationWithFallback = async ({
  runTextFallback = null,
  persistentCommitStarted = false,
  ...attemptOptions
} = {}) => {
  const attempt = await runPhoneBatchProviderFcAttempt(attemptOptions);
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
