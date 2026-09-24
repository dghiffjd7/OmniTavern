import { AGENT_EVENT_TYPES, cloneAgentValue } from './agent-events.js';
import {
  AGENT_PERMISSION_DECISIONS,
  createAgentPermissionEvaluator,
} from './agent-permissions.js';

export class AgentToolError extends Error {
  constructor(message, {
    code = 'agent_tool_error',
    toolName = '',
    details = null,
  } = {}) {
    super(message);
    this.name = 'AgentToolError';
    this.code = code;
    this.toolName = toolName;
    this.details = details;
  }
}

export class AgentToolPermissionError extends AgentToolError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'agent_tool_permission' });
    this.name = 'AgentToolPermissionError';
  }
}

export class AgentToolSafetyError extends AgentToolError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'agent_tool_safety' });
    this.name = 'AgentToolSafetyError';
  }
}

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const clone = value => cloneAgentValue(value, value && typeof value === 'object' ? {} : value);

const createAbortError = (message = 'Agent tool aborted') => {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
  }
};

const normalizeToolName = (name = '') => trim(name).replace(/\s+/g, '_');

const SAFETY_DESTRUCTIVE_VALUES = new Set(['never', 'conditional', 'always']);
const SAFETY_DENY_ACTIONS = new Set(['skip', 'replace_args', 'throw']);

const normalizeAgentToolCapabilities = (capabilities = {}, {
  permissions = [],
  riskLevel = 'low',
} = {}) => {
  const src = isPlainObject(capabilities) ? capabilities : {};
  const permissionSet = new Set(list(permissions));
  const risk = trim(riskLevel, 'low');
  const write = src.write === true || permissionSet.has('storage:write') || risk === 'medium' || risk === 'high';
  const network = (src.network === true || permissionSet.has('network'))
    ? true
    : (src.network === 'opt_in' ? 'opt_in' : false);
  return {
    read: src.read !== false,
    write,
    network,
    cost: trim(src.cost, network ? 'variable' : 'none'),
    undo: trim(src.undo, write ? 'manual' : 'none'),
    modelContext: trim(src.modelContext, 'none'),
    confirmation: trim(src.confirmation, write || network ? 'required' : 'allow_once'),
  };
};

const normalizeAgentToolSafety = (safety = null, { capabilities = {} } = {}) => {
  const declared = isPlainObject(safety);
  const src = declared ? safety : {};
  const rawDestructive = src.destructive === true
    ? 'always'
    : (src.destructive === false ? 'never' : trim(src.destructive, 'never'));
  const destructive = SAFETY_DESTRUCTIVE_VALUES.has(rawDestructive) ? rawDestructive : 'never';
  const rawDenyAction = trim(src.onDeny?.action || src.onCancel?.action || src.denyAction, 'skip');
  return {
    declared,
    operationType: trim(src.operationType || src.operation || (capabilities.write ? 'write' : 'read'), capabilities.write ? 'write' : 'read'),
    destructive,
    description: trim(src.description),
    preflight: typeof src.preflight === 'function' ? src.preflight : null,
    onDeny: {
      action: SAFETY_DENY_ACTIONS.has(rawDenyAction) ? rawDenyAction : 'skip',
      reason: trim(src.onDeny?.reason || src.onCancel?.reason || src.denyReason, 'destructive_operation_cancelled'),
    },
  };
};

const publicToolDefinition = tool => ({
  ...tool,
  execute: undefined,
  prepareArguments: undefined,
  summarizeResult: undefined,
  safety: tool?.safety ? { ...tool.safety, preflight: undefined } : undefined,
});

export const normalizeAgentToolDefinition = (definition = {}) => {
  const src = isPlainObject(definition) ? definition : {};
  const name = normalizeToolName(src.name);
  if (!name) throw new AgentToolError('Agent tool name is required', { code: 'tool_name_required' });
  if (typeof src.execute !== 'function') {
    throw new AgentToolError(`Agent tool "${name}" missing execute function`, {
      code: 'tool_execute_required',
      toolName: name,
    });
  }
  const permissions = list(src.permissions);
  const riskLevel = trim(src.riskLevel || src.risk, 'low');
  const capabilities = normalizeAgentToolCapabilities(src.capabilities || src.metadata?.capabilities, {
    permissions,
    riskLevel,
  });
  return {
    name,
    title: trim(src.title || src.label, name),
    description: trim(src.description),
    source: trim(src.source, 'internal'),
    permissions,
    riskLevel,
    executionMode: trim(src.executionMode, 'sequential'),
    capabilities,
    safety: normalizeAgentToolSafety(src.safety, { capabilities }),
    schema: isPlainObject(src.schema) ? clone(src.schema) : { type: 'object' },
    timeoutMs: Math.max(0, Number(src.timeoutMs || 0) || 0),
    timeoutErrorCode: trim(src.timeoutErrorCode),
    timeoutSettleGraceMs: Math.max(0, Number(src.timeoutSettleGraceMs ?? DEFAULT_TIMEOUT_SETTLE_GRACE_MS) || 0),
    outputLimit: Math.max(0, Number(src.outputLimit || 0) || 0),
    prepareArguments: typeof src.prepareArguments === 'function' ? src.prepareArguments : null,
    summarizeResult: typeof src.summarizeResult === 'function' ? src.summarizeResult : null,
    execute: src.execute,
    metadata: isPlainObject(src.metadata) ? clone(src.metadata) : {},
  };
};

const typeMatches = (value, type) => {
  if (!type) return true;
  if (Array.isArray(type)) return type.some(item => typeMatches(value, item));
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(Number(value));
  if (type === 'number') return Number.isFinite(Number(value));
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
};

const validateValue = (value, schema = {}, path = 'args') => {
  const errors = [];
  if (!isPlainObject(schema)) return errors;
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path} expected ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}`);
    return errors;
  }
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(Number(schema.minLength)) && value.length < Number(schema.minLength)) {
      errors.push(`${path} must be at least ${Number(schema.minLength)} chars`);
    }
    if (Number.isFinite(Number(schema.maxLength)) && value.length > Number(schema.maxLength)) {
      errors.push(`${path} must be at most ${Number(schema.maxLength)} chars`);
    }
  }
  if (Number.isFinite(Number(value))) {
    const numeric = Number(value);
    if (Number.isFinite(Number(schema.minimum)) && numeric < Number(schema.minimum)) {
      errors.push(`${path} must be >= ${Number(schema.minimum)}`);
    }
    if (Number.isFinite(Number(schema.maximum)) && numeric > Number(schema.maximum)) {
      errors.push(`${path} must be <= ${Number(schema.maximum)}`);
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) => {
      errors.push(...validateValue(item, schema.items, `${path}[${index}]`));
    });
  }
  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    required.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`);
    });
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    Object.entries(properties).forEach(([key, childSchema]) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return;
      errors.push(...validateValue(value[key], childSchema, `${path}.${key}`));
    });
    if (schema.additionalProperties === false) {
      Object.keys(value).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}.${key} is not allowed`);
      });
    }
  }
  return errors;
};

export const validateAgentToolArguments = (args = {}, schema = {}) => {
  const normalized = isPlainObject(args) ? args : {};
  const errors = validateValue(normalized, isPlainObject(schema) ? schema : { type: 'object' }, 'args');
  return {
    ok: errors.length === 0,
    errors,
    args: normalized,
  };
};

const summarizeResultValue = (result, outputLimit = 0) => {
  if (result === null || result === undefined) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (!outputLimit || raw.length <= outputLimit) return raw;
  return `${raw.slice(0, outputLimit)}...`;
};

const DEFAULT_TIMEOUT_SETTLE_GRACE_MS = 3000;

const runWithTimeout = async (task, timeoutMs = 0, signal = null, {
  timeoutErrorCode = '',
  timeoutSettleGraceMs = DEFAULT_TIMEOUT_SETTLE_GRACE_MS,
  toolName = '',
} = {}) => {
  if (signal?.aborted) throw createAbortError();
  if (!timeoutMs) return task(signal);
  const timeoutController = typeof AbortController === 'function'
    ? new AbortController()
    : null;
  const executionSignal = timeoutController?.signal || signal;
  const relayAbort = () => {
    try {
      timeoutController?.abort?.(signal?.reason);
    } catch {}
  };
  signal?.addEventListener?.('abort', relayAbort, { once: true });
  let timeoutId = null;
  let graceId = null;
  try {
    return await Promise.race([
      task(executionSignal),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = timeoutErrorCode
            ? new AgentToolError('Agent tool timed out', {
              code: timeoutErrorCode,
              toolName,
              details: { timeoutMs },
            })
            : createAbortError('Agent tool timed out');
          try {
            timeoutController?.abort?.(timeoutError);
          } catch {}
          if (!timeoutErrorCode || !timeoutController || !(timeoutSettleGraceMs > 0)) {
            reject(timeoutError);
            return;
          }
          // 域超时先中止执行信号，留短宽限让任务用真实终态收尾（如已落库/协议被拒），
          // 宽限内未收尾才回退到笼统超时错误——避免结果已定却误报 timeout 码。
          graceId = setTimeout(() => reject(timeoutError), timeoutSettleGraceMs);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (graceId) clearTimeout(graceId);
    signal?.removeEventListener?.('abort', relayAbort);
  }
};

const isSafetyConfirmationAllowed = value => {
  if (value === true || value === AGENT_PERMISSION_DECISIONS.allow || value === 'confirmed') return true;
  if (!isPlainObject(value)) return false;
  const decision = trim(value.decision || value.status || value.action).toLowerCase();
  return value.confirmed === true || decision === AGENT_PERMISSION_DECISIONS.allow || decision === 'confirmed';
};

const normalizeSafetyPreflightResult = (result = {}, tool = {}, args = {}) => {
  const src = isPlainObject(result) ? result : {};
  const destructive = src.destructive === true || src.requiresConfirmation === true;
  const rawDenyAction = trim(src.onDeny?.action || src.onCancel?.action || tool.safety?.onDeny?.action, 'skip');
  return {
    destructive,
    kind: trim(src.kind || src.action || `${tool.name}.${tool.safety?.operationType || 'operation'}`),
    operationType: trim(src.operationType || tool.safety?.operationType, 'write'),
    title: trim(src.title || src.confirmTitle || '确认危险操作'),
    message: trim(src.message || src.confirmMessage || `工具「${tool.name}」将执行可能覆盖或删除已有内容的操作。`),
    confirmText: trim(src.confirmText || '确认执行'),
    cancelText: trim(src.cancelText || '取消'),
    danger: src.danger !== false,
    allowAlways: src.allowAlways !== false,
    argsPreview: clone(src.argsPreview || args),
    details: isPlainObject(src.details) ? clone(src.details) : null,
    onDeny: {
      action: SAFETY_DENY_ACTIONS.has(rawDenyAction) ? rawDenyAction : 'skip',
      args: isPlainObject(src.onDeny?.args || src.onCancel?.args) ? clone(src.onDeny?.args || src.onCancel?.args) : null,
      result: isPlainObject(src.onDeny?.result || src.onCancel?.result) ? clone(src.onDeny?.result || src.onCancel?.result) : null,
      reason: trim(src.onDeny?.reason || src.onCancel?.reason || tool.safety?.onDeny?.reason, 'destructive_operation_cancelled'),
    },
  };
};

const compactSafetyConfirmationRequest = (request = {}) => {
  const compact = clone(request);
  const details = isPlainObject(compact?.details) ? compact.details : null;
  const items = Array.isArray(details?.items) ? details.items : [];
  if (!details || !items.length) return compact;
  delete details.items;
  details.itemCount = items.length;
  details.itemIds = items
    .map(item => trim(item?.id))
    .filter(Boolean);
  return compact;
};

const buildSafetySkippedOutput = (tool, preflight, durationMs = 0) => {
  const result = preflight.onDeny.result || {
    ok: false,
    skipped: true,
    reason: preflight.onDeny.reason,
    safety: {
      kind: preflight.kind,
      operationType: preflight.operationType,
      destructive: true,
    },
  };
  return {
    toolName: tool.name,
    status: 'skipped',
    result,
    summary: trim(result?.message || result?.reason, `tool skipped: ${tool.name}`),
    durationMs,
  };
};

// 只读意图下的写工具不再硬拒绝，而是升级为强制用户确认（无视 allow-always 规则）：
// 误判（条件式写入/预览后取消等）的代价从任务失败降为多点一次确认；
// 无确认通道（headless/测试）时保持 fail-closed 抛错，「无静默写入」性质不变。
const enforceOperationIntentPolicy = async (tool, context = {}) => {
  const policy = isPlainObject(context?.operationIntentPolicy)
    ? context.operationIntentPolicy
    : null;
  if (
    policy?.mode !== 'read_only' ||
    tool?.capabilities?.write !== true ||
    tool?.metadata?.allowInReadOnlyIntent === true
  ) {
    return;
  }
  const requestConfirmation = context.requestToolConfirmation ||
    context.confirmToolSafety ||
    context.requestSafetyConfirmation;
  if (typeof requestConfirmation === 'function') {
    const request = {
      escalation: 'read_only_write',
      toolName: tool.name,
      source: tool.source,
      riskLevel: tool.riskLevel,
      kind: 'read_only_write_escalation',
      operationType: trim(tool?.safety?.operationType, 'write'),
      title: '本轮请求按只读理解',
      message: `工具「${tool.title || tool.name}」需要写入数据。要允许这一次写入吗？`,
      confirmText: '允许一次',
      cancelText: '取消',
      danger: true,
    };
    let allowed = false;
    try { context.onToolConfirmationPending?.(request); } catch {}
    try {
      allowed = isSafetyConfirmationAllowed(await requestConfirmation(request, { signal: context.signal, runId: context.runId }));
    } finally {
      try { context.onToolConfirmationResolved?.(request); } catch {}
    }
    if (allowed) return;
  }
  throw new AgentToolSafetyError(
    `用户本轮只授权查询或查看，未确认写入工具「${tool.name}」；如需执行，请让用户明确提出写入动作。`,
    {
      code: 'agent_tool_write_intent_required',
      toolName: tool.name,
      details: {
        mode: 'read_only',
        source: trim(policy.source),
        reason: trim(policy.reason, 'explicit_read_without_write'),
        operationType: trim(tool?.safety?.operationType, 'write'),
      },
    },
  );
};

export const createAgentToolRegistry = ({
  permissionEvaluator = createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.ask }),
  requireSafetyForWrites = false,
  logger = console,
} = {}) => {
  const tools = new Map();

  const register = (definition = {}) => {
    const normalized = normalizeAgentToolDefinition(definition);
    if (requireSafetyForWrites && normalized.capabilities.write && normalized.safety.declared !== true) {
      throw new AgentToolSafetyError(`Agent write tool missing safety policy: ${normalized.name}`, {
        code: 'agent_tool_safety_required',
        toolName: normalized.name,
      });
    }
    tools.set(normalized.name, normalized);
    return publicToolDefinition(normalized);
  };

  const registerMany = (definitions = []) => (Array.isArray(definitions) ? definitions : [])
    .map(register);

  const get = (name = '') => {
    const tool = tools.get(normalizeToolName(name)) || null;
    if (!tool) return null;
    return publicToolDefinition(tool);
  };

  const listTools = () => Array.from(tools.values())
    .map(publicToolDefinition)
    .sort((a, b) => a.name.localeCompare(b.name));

  const evaluatePermission = async (tool, args = {}, context = {}) => {
    const check = permissionEvaluator?.evaluateTool
      ? permissionEvaluator.evaluateTool(tool, {
        ...context,
        toolName: tool.name,
        source: context.source || tool.source,
      })
      : { decision: AGENT_PERMISSION_DECISIONS.allow, checks: [] };
    if (check.decision === AGENT_PERMISSION_DECISIONS.allow) return check;
    if (check.decision === AGENT_PERMISSION_DECISIONS.ask && typeof context.requestPermission === 'function') {
      const requested = await context.requestPermission({
        toolName: tool.name,
        permissions: tool.permissions.slice(),
        argsPreview: clone(args),
        checks: check.checks,
        riskLevel: tool.riskLevel,
      });
      const decision = typeof requested === 'string'
        ? requested
        : requested?.decision;
      if (decision === AGENT_PERMISSION_DECISIONS.allow) {
        return { ...check, decision: AGENT_PERMISSION_DECISIONS.allow, requested };
      }
    }
    throw new AgentToolPermissionError(`Agent tool permission ${check.decision}: ${tool.name}`, {
      toolName: tool.name,
      details: check,
      code: check.decision === AGENT_PERMISSION_DECISIONS.deny
        ? 'agent_tool_denied'
        : 'agent_tool_permission_required',
    });
  };

  const evaluateSafety = async (tool, args = {}, context = {}) => {
    const safety = tool.safety || {};
    let rawPreflight = null;
    if (typeof safety.preflight === 'function') {
      rawPreflight = await safety.preflight(args, {
        ...context,
        tool: publicToolDefinition(tool),
      });
    } else if (safety.destructive === 'always') {
      rawPreflight = { destructive: true };
    }
    const preflight = normalizeSafetyPreflightResult(rawPreflight || {}, tool, args);
    if (!preflight.destructive) {
      return {
        args,
        preflight,
        confirmation: {
          required: false,
          decision: 'not_required',
        },
      };
    }

    const requestConfirmation = context.requestToolConfirmation ||
      context.confirmToolSafety ||
      context.requestSafetyConfirmation;
    const displayRequest = {
      toolName: tool.name,
      source: tool.source,
      riskLevel: tool.riskLevel,
      operationType: preflight.operationType,
      kind: preflight.kind,
      title: preflight.title,
      message: preflight.message,
      confirmText: preflight.confirmText,
      cancelText: preflight.cancelText,
      danger: preflight.danger,
      allowAlways: preflight.allowAlways,
      argsPreview: preflight.argsPreview,
      details: preflight.details,
    };
    const request = compactSafetyConfirmationRequest(displayRequest);
    let allowed = false;
    if (typeof requestConfirmation === 'function') {
      // 等待用户确认期间通知调用方（run 可标记 waiting_permission，避免看起来像卡死）
      try { context.onToolConfirmationPending?.(request); } catch {}
      try {
        allowed = isSafetyConfirmationAllowed(await requestConfirmation(displayRequest, { signal: context.signal, runId: context.runId }));
      } finally {
        try { context.onToolConfirmationResolved?.(request); } catch {}
      }
    }
    if (allowed) {
      return {
        args,
        preflight,
        confirmation: {
          required: true,
          decision: 'allow',
          request,
        },
      };
    }

    if (preflight.onDeny.action === 'replace_args' && preflight.onDeny.args) {
      const fallbackValidation = validateAgentToolArguments(preflight.onDeny.args, tool.schema);
      if (!fallbackValidation.ok) {
        throw new AgentToolSafetyError(`Agent tool safety fallback arguments invalid: ${fallbackValidation.errors.join('; ')}`, {
          code: 'agent_tool_safety_fallback_args_invalid',
          toolName: tool.name,
          details: fallbackValidation.errors,
        });
      }
      return {
        args: fallbackValidation.args,
        preflight,
        confirmation: {
          required: true,
          decision: 'fallback',
          request,
          reason: preflight.onDeny.reason,
        },
      };
    }

    if (preflight.onDeny.action === 'throw') {
      throw new AgentToolSafetyError(`Agent tool destructive operation not confirmed: ${tool.name}`, {
        code: 'agent_tool_safety_confirmation_required',
        toolName: tool.name,
        details: request,
      });
    }

    return {
      args,
      preflight,
      skip: true,
      confirmation: {
        required: true,
        decision: 'deny',
        request,
        reason: preflight.onDeny.reason,
      },
    };
  };

  const executeTool = async (name = '', args = {}, context = {}) => {
    const toolName = normalizeToolName(name);
    const tool = tools.get(toolName);
    if (!tool) {
      throw new AgentToolError(`Agent tool not found: ${toolName}`, {
        code: 'agent_tool_not_found',
        toolName,
      });
    }
    const validation = validateAgentToolArguments(args, tool.schema);
    if (!validation.ok) {
      throw new AgentToolError(`Agent tool arguments invalid: ${validation.errors.join('; ')}`, {
        code: 'agent_tool_args_invalid',
        toolName,
        details: validation.errors,
      });
    }
    await enforceOperationIntentPolicy(tool, context);
    await evaluatePermission(tool, validation.args, context);
    const startedAt = Date.now();
    const safety = await evaluateSafety(tool, validation.args, context);
    if (safety.skip) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const output = buildSafetySkippedOutput(tool, safety.preflight, durationMs);
      context.emit?.({
        type: AGENT_EVENT_TYPES.toolFinished,
        runId: context.runId,
        stepId: context.stepId,
        sessionId: context.sessionId,
        source: tool.source,
        status: 'skipped',
        summary: output.summary || `tool skipped: ${tool.name}`,
        details: {
          toolName: tool.name,
          durationMs,
          safety: clone(safety.confirmation),
        },
      });
      return output;
    }
    const preparedArgs = tool.prepareArguments
      ? await tool.prepareArguments(safety.args, context)
      : safety.args;
    context.emit?.({
      type: AGENT_EVENT_TYPES.toolStarted,
      runId: context.runId,
      stepId: context.stepId,
      sessionId: context.sessionId,
      source: tool.source,
      status: 'running',
      summary: `tool started: ${tool.name}`,
      details: { toolName: tool.name },
    });
    try {
      const result = await runWithTimeout(
        executionSignal => tool.execute(preparedArgs, {
          ...context,
          signal: executionSignal,
          tool,
          toolSafety: clone(safety.confirmation),
        }),
        tool.timeoutMs,
        context.signal,
        {
          timeoutErrorCode: tool.timeoutErrorCode,
          timeoutSettleGraceMs: tool.timeoutSettleGraceMs,
          toolName: tool.name,
        },
      );
      const durationMs = Math.max(0, Date.now() - startedAt);
      const summary = tool.summarizeResult
        ? String(await tool.summarizeResult(result, { args: preparedArgs, context }) || '')
        : summarizeResultValue(result, tool.outputLimit);
      const output = {
        toolName: tool.name,
        status: 'succeeded',
        result: clone(result),
        summary,
        durationMs,
      };
      context.emit?.({
        type: AGENT_EVENT_TYPES.toolFinished,
        runId: context.runId,
        stepId: context.stepId,
        sessionId: context.sessionId,
        source: tool.source,
        status: 'succeeded',
        summary: summary || `tool finished: ${tool.name}`,
        details: { toolName: tool.name, durationMs },
      });
      return output;
    } catch (err) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      context.emit?.({
        type: AGENT_EVENT_TYPES.toolFinished,
        runId: context.runId,
        stepId: context.stepId,
        sessionId: context.sessionId,
        source: tool.source,
        status: err?.name === 'AbortError' ? 'cancelled' : 'failed',
        summary: err?.message ? String(err.message) : `tool failed: ${tool.name}`,
        details: { toolName: tool.name, durationMs },
      });
      logger?.warn?.('agent tool failed', tool.name, err);
      throw err;
    }
  };

  return {
    executeTool,
    get,
    listTools,
    register,
    registerMany,
    unregister: name => tools.delete(normalizeToolName(name)),
  };
};
