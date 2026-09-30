import { validateAgentToolArguments } from './agent-tool-registry.js';
import { createProviderToolCallDeltaAccumulator } from './provider-tool-call-delta-adapter.js';
import { buildProviderFcRequestPlan, resolveProviderFcTransport } from './provider-fc-transport.js';
import { toProviderToolModelName } from './provider-tool-name-map.js';
import { buildMaidReasoningBaseOptions, hasReasoningOptions } from './maid-generation-settings.js';
import { getReasoningCapability } from '../api/model-capabilities.js';

export const MAID_PROVIDER_FC_MODE = 'provider_fc';
export const MAID_PROMPTED_JSON_MODE = 'prompted_json';
export const MAID_PROVIDER_FC_CONTROL_TOOL_NAME = 'maid_planner_control';
export const MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH = 6000;
const MAID_PROVIDER_FC_REASON_MAX_LENGTH = 120;

// Only these local reads may be serialized from one response. UI actions,
// generation, writes and planner controls still require a single selection.
const SERIAL_READ_TOOLS = new Set([
  'app.read_resource', 'app.get_current_state', 'app.search_feature',
  'app.read_feature_doc', 'app.read_skill', 'app.search_skills',
  'worldbook.list', 'worldbook.read', 'session.list', 'contact_profile.read',
]);
export const MAID_PROVIDER_FC_READ_BATCH_LIMIT = 8;

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const resolveMaidProviderFcRuntimeStatus = ({
  compatibilityModeEnabled = false,
  runtimeOverride = null,
} = {}) => {
  const overrideActive = isPlainObject(runtimeOverride);
  return {
    enabled: overrideActive
      ? runtimeOverride.enabled === true
      : compatibilityModeEnabled !== true,
    thinkingEnabled: overrideActive && runtimeOverride.thinkingEnabled === true,
    defaultEnabled: true,
    runtimeOnly: false,
    overrideActive,
    compatibilityModeEnabled: compatibilityModeEnabled === true,
    source: overrideActive ? 'runtime_override' : 'product_default',
  };
};

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const clone = (value, fallback = null) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const truncate = (value = '', max = 240) => {
  const text = trim(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const hashText = (value = '') => {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const hasImageParts = (messages = []) => (Array.isArray(messages) ? messages : []).some(message => (
  Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url')
));

// 同一服务商+模型的函数调用请求失败后，冷却一段时间直接走普通规划：
// 失败的尝试已经等了一轮，回退还要重发完整提示词，连续失败会让每一步都付两次时间和 token。
export const MAID_PROVIDER_FC_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const providerFcCooldowns = new Map();
const providerFcCooldownKey = (config = {}) => `${trim(config?.provider)}|${trim(config?.model)}`;
export const markMaidProviderFcFailure = (config = {}, now = Date.now()) => {
  providerFcCooldowns.set(providerFcCooldownKey(config), Number(now) + MAID_PROVIDER_FC_FAILURE_COOLDOWN_MS);
};
export const isMaidProviderFcCoolingDown = (config = {}, now = Date.now()) => {
  const key = providerFcCooldownKey(config);
  const until = providerFcCooldowns.get(key) || 0;
  if (until > Number(now)) return true;
  providerFcCooldowns.delete(key);
  return false;
};
export const resetMaidProviderFcCooldowns = () => providerFcCooldowns.clear();
export const isProviderFcRequestRejection = (error = null) => {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 400 || status === 422) return true;
  return /\b(?:400|422)\b|invalid argument|invalid json payload|unknown name|schema|function_?declaration|tool[_ ]?choice/i
    .test(String(error?.message || error || ''));
};

export const resolveMaidProviderFcEligibility = ({
  experimentStatus = null,
  config = {},
  capabilitySnapshot = null,
  messages = [],
  phase = 'planner',
  client = null,
  now = Date.now,
} = {}) => {
  const enabled = experimentStatus?.enabled === true;
  const thinkingEnabled = experimentStatus?.thinkingEnabled === true;
  const normalizedPhase = trim(phase, 'planner').toLowerCase();
  const providerTransport = resolveProviderFcTransport(config);
  let reason = '';
  if (!enabled) reason = 'experiment_disabled';
  else if (!providerTransport.supported) reason = providerTransport.reason;
  else if (providerTransport.provider === 'opencode') reason = 'provider_rollout_deferred';
  else if (isMaidProviderFcCoolingDown(config, Number(now?.() || Date.now()))) reason = 'provider_fc_cooling_down';
  else if (!['planner', 'react'].includes(normalizedPhase)) reason = 'unsupported_phase';
  else if (!client || typeof client.chat !== 'function') reason = 'provider_client_unavailable';
  else if (capabilitySnapshot?.useCandidates !== true) reason = 'candidate_snapshot_required';
  else if (!Array.isArray(capabilitySnapshot?.candidateFeatures) || !capabilitySnapshot.candidateFeatures.length) {
    reason = 'candidate_snapshot_empty';
  } else if (hasImageParts(messages)) reason = 'multimodal_input';
  return {
    eligible: !reason,
    reason,
    requestedMode: enabled ? MAID_PROVIDER_FC_MODE : MAID_PROMPTED_JSON_MODE,
    thinkingEnabled,
    phase: normalizedPhase,
    provider: trim(config?.provider),
    model: trim(config?.model),
    providerFamily: providerTransport.family,
    providerEndpoint: providerTransport.endpoint,
    candidateSnapshotId: trim(capabilitySnapshot?.id),
    candidateFeatureCount: Array.isArray(capabilitySnapshot?.candidateFeatures)
      ? capabilitySnapshot.candidateFeatures.length
      : 0,
  };
};

const toProviderSafeName = (internalName = '', usedNames = new Map()) => {
  const source = trim(toProviderToolModelName(internalName), 'tool');
  let base = source.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  if (/^[0-9]/.test(base)) base = `tool_${base}`;
  if (base.length > 55) base = `${base.slice(0, 46)}_${hashText(internalName)}`;
  let candidate = base;
  const owner = usedNames.get(candidate);
  if (owner && owner !== internalName) {
    candidate = `${base.slice(0, 54)}_${hashText(internalName).slice(0, 8)}`.slice(0, 64);
  }
  usedNames.set(candidate, internalName);
  return candidate;
};

const buildControlSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'message'],
  properties: {
    action: {
      type: 'string',
      enum: ['final', 'clarify', 'unsupported', 'no_tool'],
      description: 'Use final when observations are sufficient; otherwise clarify, unsupported, or no_tool.',
    },
    // 最终答复可能是较长的清单（例如列出几十个名称）。Gemini 的 schema 不支持 maxLength，模型看不到上限，
    // 上限过小会让合法的长答复在本地校验失败、再走一次文本路径重新生成
    message: {
      type: 'string',
      minLength: 1,
      maxLength: MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH,
      description: 'Natural user-facing answer or clarification, without tool JSON.',
    },
    reason: {
      type: 'string',
      maxLength: MAID_PROVIDER_FC_REASON_MAX_LENGTH,
    },
  },
});

const buildToolDescription = (feature = {}, toolName = '') => truncate([
  trim(feature?.title, feature?.id),
  trim(feature?.summary),
  trim(feature?.argsHint),
  `APP capability: ${trim(feature?.id)}; internal tool: ${toolName}`,
].filter(Boolean).join('。'), 480);

const selectOfferedToolOwner = (owners = [], toolName = '') => (
  owners.find(feature => trim(feature.id) === toolName)
  || owners.filter(feature => feature.writes === false)
    .sort((left, right) => Number(trim(right.directAction) === toolName) - Number(trim(left.directAction) === toolName)
      || trim(left.id).localeCompare(trim(right.id)))[0]
  || owners[0]
);

export const buildMaidProviderFcToolPlan = ({
  config = {},
  features = [],
  phase = 'planner',
  thinkingEnabled = false,
  reasoningOptions = {},
} = {}) => {
  const candidateFeatures = Array.isArray(features) ? features : [];
  const usedNames = new Map([[MAID_PROVIDER_FC_CONTROL_TOOL_NAME, MAID_PROVIDER_FC_CONTROL_TOOL_NAME]]);
  const toolMappings = [];
  const missingSchemas = [];
  const ownersByTool = new Map();
  for (const feature of candidateFeatures) {
    for (const internalName of list(feature?.tools)) {
      const owners = ownersByTool.get(internalName) || [];
      owners.push(feature);
      ownersByTool.set(internalName, owners);
    }
  }

  ownersByTool.forEach((owners, internalName) => {
      // Select metadata and authority from this offered snapshot only. Shared
      // prerequisite reads must not inherit a write owner merely by rank.
      const feature = selectOfferedToolOwner(owners, internalName);
      const schemas = isPlainObject(feature?.toolSchemas) ? feature.toolSchemas : {};
      if (!Object.prototype.hasOwnProperty.call(schemas, internalName) || !isPlainObject(schemas[internalName])) {
        missingSchemas.push({ featureId: trim(feature?.id), toolName: internalName });
        return;
      }
      const auxiliaryRead = feature.writes === true && SERIAL_READ_TOOLS.has(internalName);
      toolMappings.push({
        providerName: toProviderSafeName(internalName, usedNames),
        internalName,
        featureId: trim(feature?.id),
        title: auxiliaryRead ? internalName : trim(feature?.title, feature?.id || internalName),
        description: auxiliaryRead
          ? `Read-only auxiliary tool ${internalName}, offered under APP capability ${trim(feature.id)}. This call reads data only; it does not create, bind, or otherwise complete the parent capability's write operation. Use the parameters in this tool's schema. APP capability: ${trim(feature.id)}; internal tool: ${internalName}`
          : buildToolDescription(feature, internalName),
        schema: clone(schemas[internalName], { type: 'object' }),
        control: false,
      });
  });

  if (missingSchemas.length) {
    return {
      ok: false,
      reason: 'candidate_schema_missing',
      requestOptions: {},
      toolMappings: [],
      diagnostics: {
        missingSchemas,
        candidateFeatureCount: candidateFeatures.length,
      },
    };
  }
  if (!toolMappings.length) {
    return {
      ok: false,
      reason: 'candidate_tools_empty',
      requestOptions: {},
      toolMappings: [],
      diagnostics: { candidateFeatureCount: candidateFeatures.length },
    };
  }

  const controlSchema = buildControlSchema();
  toolMappings.push({
    providerName: MAID_PROVIDER_FC_CONTROL_TOOL_NAME,
    internalName: '',
    featureId: '',
    title: 'Finish or stop planning safely',
    description: trim(phase).toLowerCase() === 'react'
      ? 'Return a final answer when observations are sufficient, or stop safely to clarify/decline.'
      : 'Use only when no APP business tool should run: answer, clarify, or decline safely.',
    schema: controlSchema,
    control: true,
  });

  const tools = toolMappings.map(mapping => ({
    type: 'function',
    function: {
      name: mapping.providerName,
      description: mapping.description,
      parameters: clone(mapping.schema, { type: 'object' }),
    },
  }));
  const requestPlan = buildProviderFcRequestPlan({
    config,
    tools,
    thinkingEnabled: thinkingEnabled && (resolveProviderFcTransport(config).family !== 'anthropic'
      || getReasoningCapability(config).supported || ['enabled', 'adaptive'].includes(reasoningOptions?.thinking?.type)),
    reasoningOptions,
    temperature: 0,
  });
  if (!requestPlan.ok) {
    return {
      ok: false,
      reason: requestPlan.reason,
      requestOptions: {},
      generationOptions: {},
      toolMappings: [],
      diagnostics: {
        candidateFeatureCount: candidateFeatures.length,
        providerFamily: requestPlan.transport?.family || '',
        providerEndpoint: requestPlan.transport?.endpoint || '',
      },
    };
  }
  return {
    ok: true,
    reason: '',
    toolMappings,
    requestOptions: requestPlan.requestOptions,
    generationOptions: hasReasoningOptions(requestPlan.generationOptions)
      ? requestPlan.generationOptions
      : { ...reasoningOptions, ...requestPlan.generationOptions },
    diagnostics: {
      phase: trim(phase, 'planner'),
      ...(requestPlan.diagnostics || {}),
      internalToolNames: toolMappings.filter(item => !item.control).map(item => item.internalName),
      providerToolNames: toolMappings.map(item => item.providerName),
      candidateFeatureCount: candidateFeatures.length,
      businessToolCount: toolMappings.filter(item => !item.control).length,
      controlToolCount: 1,
      providerFamily: requestPlan.transport.family,
      providerEndpoint: requestPlan.transport.endpoint,
    },
  };
};

const parseArgumentsText = (call = {}) => {
  const text = trim(call?.metadata?.streamingArgumentsText);
  if (!text) return { ok: true, args: isPlainObject(call?.arguments) ? call.arguments : {} };
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed)
      ? { ok: true, args: parsed }
      : { ok: false, reason: 'invalid_arguments_json' };
  } catch {
    return { ok: false, reason: 'invalid_arguments_json' };
  }
};

const invalidCompletedCall = (reason, details = {}) => ({
  ok: false,
  reason,
  ...details,
});

export const normalizeMaidProviderFcCompletedCalls = ({
  completedToolCalls = [],
  toolPlan = null,
  phase = 'planner',
  allowReadBatch = false,
} = {}) => {
  const calls = Array.isArray(completedToolCalls) ? completedToolCalls : [];
  if (!toolPlan?.ok) return invalidCompletedCall(toolPlan?.reason || 'tool_plan_unavailable');
  if (!calls.length) return invalidCompletedCall('no_tool_call', { toolCallCount: 0 });
  if (calls.length !== 1) {
    const rejected = () => invalidCompletedCall('multiple_tool_calls', { toolCallCount: calls.length });
    if (!allowReadBatch || calls.length > MAID_PROVIDER_FC_READ_BATCH_LIMIT) return rejected();
    // Validate the whole response before returning even the first selection.
    const normalized = calls.map(call => normalizeMaidProviderFcCompletedCalls({
      completedToolCalls: [call], toolPlan, phase,
    }));
    if (normalized.some(item => !item.ok || item.kind !== 'tool'
      || !SERIAL_READ_TOOLS.has(item.selection.toolName))) return rejected();
    const selections = normalized.map(item => item.selection);
    return { ok: true, kind: 'tool', toolCallCount: calls.length,
      selection: selections[0], remainingSelections: selections.slice(1) };
  }

  const call = calls[0] || {};
  const providerName = trim(call?.toolName || call?.name);
  // The delta accumulator normalizes known provider aliases to internal names.
  // Resolve either form only within this offered plan, without guessing aliases
  // or choosing one tool when the two name domains are ambiguous.
  const matches = toolPlan.toolMappings.filter(item => item.providerName === providerName
    || (!item.control && item.internalName === providerName));
  if (matches.length > 1) return invalidCompletedCall('ambiguous_tool', { providerName, toolCallCount: 1 });
  const mapping = matches[0] || null;
  if (!mapping) return invalidCompletedCall('unknown_tool', { providerName, toolCallCount: 1 });
  const parsedArgs = parseArgumentsText(call);
  if (!parsedArgs.ok) return invalidCompletedCall(parsedArgs.reason, { providerName, toolCallCount: 1 });
  // Gemini omits string bounds from its offered schema. This reason is only
  // diagnostic metadata: bound a copy before validation so it cannot reject an
  // otherwise valid control. Preserve message, types, extra fields and business
  // arguments for the same strict validation, and leave the raw call untouched.
  const args = mapping.control && typeof parsedArgs.args.reason === 'string'
    ? { ...parsedArgs.args, reason: parsedArgs.args.reason.trim().slice(0, MAID_PROVIDER_FC_REASON_MAX_LENGTH) }
    : parsedArgs.args;
  const validation = validateAgentToolArguments(args, mapping.schema);
  if (!validation.ok) {
    return invalidCompletedCall('invalid_tool_arguments', {
      providerName,
      toolCallCount: 1,
      validationErrors: validation.errors,
    });
  }

  if (mapping.control) {
    return {
      ok: true,
      kind: 'control',
      toolCallCount: 1,
      control: {
        action: trim(validation.args.action, 'no_tool').toLowerCase(),
        message: truncate(validation.args.message, MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH),
        reason: trim(validation.args.reason),
      },
    };
  }
  return {
    ok: true,
    kind: 'tool',
    toolCallCount: 1,
    selection: {
      toolName: mapping.internalName,
      args: clone(validation.args, {}),
      featureId: mapping.featureId,
      title: mapping.title,
      response: `我来处理「${mapping.title}」。`,
      phase: trim(phase, 'planner'),
      providerToolName: mapping.providerName,
    },
  };
};

const isAbortError = (error, signal = null) => (
  signal?.aborted === true || error?.name === 'AbortError'
);

export const runMaidProviderFcAttempt = async ({
  client = null,
  messages = [],
  config = {},
  capabilitySnapshot = null,
  experimentStatus = null,
  phase = 'planner',
  signal = null,
  maxTokens = 8000,
  generationSettings = null,
  onModelUsage = null,
  allowReadBatch = false,
  now = Date.now,
} = {}) => {
  const eligibility = resolveMaidProviderFcEligibility({
    experimentStatus,
    config,
    capabilitySnapshot,
    messages,
    phase,
    client,
    now,
  });
  if (!eligibility.eligible) {
    return {
      attempted: false,
      ok: false,
      reason: eligibility.reason,
      diagnostics: eligibility,
    };
  }

  const toolPlan = buildMaidProviderFcToolPlan({
    config,
    features: capabilitySnapshot.candidateFeatures,
    phase: eligibility.phase,
    thinkingEnabled: eligibility.thinkingEnabled || generationSettings?.reasoningMode === 'on',
    reasoningOptions: buildMaidReasoningBaseOptions(config, generationSettings),
  });
  if (!toolPlan.ok) {
    return {
      attempted: false,
      ok: false,
      reason: toolPlan.reason,
      diagnostics: { ...eligibility, ...toolPlan.diagnostics },
    };
  }

  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: eligibility.provider,
    model: eligibility.model,
    now,
  });
  const completedToolCalls = [];
  let capturedUsage = null;
  const startedAt = Number(now?.() || Date.now()) || Date.now();
  // outcome/error 记下这次函数调用尝试的结局（ok 或回退原因），供分段计时区分“慢”与“失败后回退”
  const reportUsage = ({ outcome = '', error = '' } = {}) => {
    if (typeof onModelUsage !== 'function') return;
    try {
      onModelUsage({
        ...(isPlainObject(capturedUsage) ? capturedUsage : {}),
        provider: eligibility.provider,
        model: eligibility.model,
        latencyMs: Math.max(0, (Number(now?.() || Date.now()) || Date.now()) - startedAt),
        modelCallCount: 1,
        degraded: false,
        transport: 'provider_fc',
        ...(outcome ? { outcome } : {}),
        ...(error ? { error } : {}),
      });
    } catch {}
  };

  let responseText = '';
  try {
    // 思考参数已参与工具计划的兼容校验，不能在校验后追加可能不兼容的参数。
    responseText = await client.chat(messages, {
      ...toolPlan.generationOptions,
      maxTokens,
      max_tokens: maxTokens,
      ...toolPlan.requestOptions,
      signal,
      onProviderUsage: usage => { capturedUsage = usage; },
      onProviderToolCallDelta: (data, meta = {}) => {
        const next = accumulator.push(data, {
          provider: trim(meta?.provider, eligibility.provider),
          model: trim(meta?.model, eligibility.model),
        });
        completedToolCalls.push(...next.completed);
      },
    });
  } catch (error) {
    reportUsage({ outcome: 'provider_request_failed', error: truncate(error?.message || error, 160) });
    if (isAbortError(error, signal)) throw error;
    // 只有服务商拒收这类函数调用请求（400/422、参数/schema 无效）才冷却；配额、鉴权、网络等临时故障与函数调用无关
    if (isProviderFcRequestRejection(error)) markMaidProviderFcFailure(config, Number(now?.() || Date.now()));
    return {
      attempted: true,
      ok: false,
      reason: 'provider_request_failed',
      errorMessage: truncate(error?.message || error, 240),
      diagnostics: {
        ...eligibility,
        ...toolPlan.diagnostics,
        completedToolCallCount: completedToolCalls.length,
        responseChars: 0,
      },
    };
  }

  const normalized = normalizeMaidProviderFcCompletedCalls({
    completedToolCalls,
    toolPlan,
    phase: eligibility.phase,
    allowReadBatch,
  });
  reportUsage({ outcome: normalized.ok ? 'ok' : trim(normalized.reason, 'no_tool_call') });
  return {
    attempted: true,
    ...normalized,
    diagnostics: {
      ...eligibility,
      ...toolPlan.diagnostics,
      completedToolCallCount: completedToolCalls.length,
      responseChars: String(responseText || '').length,
    },
  };
};
