import {
  findAppFeature,
  searchAppFeatures,
} from './app-feature-catalog.js';
import {
  classifyMaidRunFailure,
  classifyMaidToolFailure,
  isMaidUserAbort as isMaidAbortError,
} from './maid-failure-codes.js';
import {
  buildMaidRunContinuationSnapshot,
  extractMaidResumeRunId,
  findMaidRunContinuationSuccess,
  maidContinuationRefsExistInOutput,
  resolveMaidRunContinuationFromRun,
} from './maid-run-continuation.js';
import {
  buildMaidImportedCardExecutionMessage,
  buildMaidImportedCardPreviewMessage,
  buildMaidImportedCardWorkflowSnapshot,
  classifyMaidImportedCardConfirmation,
  classifyMaidImportedCardWorkflowIntent,
  normalizeMaidImportedCardClassification,
  resolvePendingMaidImportedCardWorkflow,
  validateMaidImportedCardWorkflowSnapshot,
} from './maid-imported-card-workflow.js';
import { buildMaidSourceGroundingContext } from './maid-source-grounding.js';
import { createMaidSkillContext, restoreMaidSkillContext, serializeMaidSkillContext, stripMaidSkillObservationBodies } from './maid-skill-context.js';
import {
  buildConfirmedPendingActionPlan,
  cancelPendingMaidAction,
  buildMaidPendingActionFromSteps,
  classifyMaidPendingActionReply,
  resolvePendingMaidAction,
} from './maid-pending-action.js';
import {
  ALREADY_DELETED_REASON,
  appendAlreadyDeletedResults,
  buildAlreadyDeletedExecution,
  countConsecutiveSameAction,
  findAlreadyDeletedTargets,
  resolveMaidRunOutcome,
  stripAlreadyDeletedTargets,
} from './maid-run-target-ledger.js';
import {
  createMaidVisualSpecLedger,
  normalizeMaidVisualSpecLedger,
} from './maid-visual-spec.js';
import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { t } from '../i18n/index.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeText = value => trim(value)
  .toLowerCase()
  .replace(/[「」『』“”"'`]/g, '')
  .replace(/\s+/g, ' ');

const compactText = value => normalizeText(value).replace(/\s+/g, '');

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const throwIfMaidAborted = (signal = null) => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Maid task stopped by user');
  error.name = 'AbortError';
  throw error;
};

const buildMaidCancelledResult = ({ input = '', steps = [] } = {}) => {
  const snapshots = Array.isArray(steps) ? clone(steps) : [];
  const completedCount = snapshots.filter(step => step?.status === 'succeeded').length;
  return {
    ok: false,
    status: 'cancelled',
    cancelled: true,
    responseType: 'react',
    input: trim(input),
    reason: 'user_aborted',
    failureCode: 'user_aborted',
    steps: snapshots,
    message: `任务已终止；已完成 ${completedCount} 步，后续步骤未执行。`,
  };
};

const MAID_READ_INTENT_PATTERN = /(查询|查看|检查|确认|核对|读取|只读|只查|列出|列表|清单|统计|比较|分析|告诉我|有哪些|哪些|是否|有没有|当前(?:状态|情况)?|状态|情况|是什么|怎么样|如何|\b(?:show|list|read|check|inspect|verify|status|what|which|whether|inventory|identit(?:y|ies))\b)/iu;
const MAID_NO_TOOL_INTENT_PATTERN = /(?:(?:不要|不得|禁止|无需|不用|不必)\s*(?:再)?(?:调用|使用|动用|执行)\s*(?:任何|任意|任一)?\s*工具|(?:不调用|不使用)\s*(?:任何|任意|任一)?\s*工具|\b(?:do\s+not|don't|dont|never)\s+(?:use|call)\s+(?:any\s+)?tools?\b|\bwithout\s+(?:using\s+)?tools?\b)/iu;
const MAID_WRITE_VERB_PATTERN = /(创建|新建|添加|追加|新增|写入|保存|绑(?:定|上|到)|启用|禁用|修改|更改|更新|编辑|替换|覆盖|删除|删掉|移除|清空|清理|发布|发送|设置|切换|应用|修复|优化|生成|上传|导入|回复)/gu;
const MAID_WRITE_COMMAND_CUE_PATTERN = /(?:^|[，,。；;！？!?])(?:请|麻烦|帮我|替我|给我|给(?:这些|那些|所有|全部|多个|每个|各个|上述|前述)|为我|我要|我想|需要|把|将|然后|接着|随后|再|并且|并|同时|顺便|之后|后再|就|分别|直接|立即|现在|若没有|如果没有|没有才|没有就|没有则|没有的话|缺少就|缺少才|缺少的|缺的|不存在时才|不存在则|不存在就|不存在再|不存在的话|若无|如无|执行|先执行).{0,48}$/u;
const MAID_POSTCHECK_WRITE_CUE_PATTERN = /(?:^|[，,。；;！？!?])(?:检查|确认|核对|验证|查完|查看)[^，,。；;！？!?\n]{0,24}(?:后|之后)(?:(?:再|就|然后|接着|随后|仅|只)\s*)?$/u;
const MAID_POSTCHECK_OBJECT_WRITE_CUE_PATTERN = /(?:^|[，,。；;！？!?])(?:检查|确认|核对|验证|查完|查看)[^，,。；;！？!?\n]{0,24}(?:后|之后)(?:(?:再|就|然后|接着|随后)\s*)?(?:把|将)\s*[^，,。；;！？!?\n]{0,32}$/u;
const MAID_NEGATED_WRITE_CLAUSE_PATTERN = /(?:^|[，,、。；;！？!?\s]|请)(?:不要|别|无需|不用|禁止|避免|不可|不能)\s*(?:再|去|进行)?[^。；;！？!?\n]*$/u;
const MAID_WRITE_STATE_SUFFIX_PATTERN = /^(?:(?:书|世界书|条目|内容|角色|用户|会话|聊天室|绑定|配置|记录))?(?:已|是否|有没有|状态|情况|仍|还|曾|过|了吗|吗|呢)/u;
const MAID_READ_STATE_BEFORE_WRITE_PATTERN = /(?:是否(?:已经|已)?|有没有|有无|是不是|为何|为什么|怎么会|何时|哪里|谁|当前|现有|已有|原有|已|已经|曾经?|被|正在)\s*$/u;
const MAID_READ_ACTION_BEFORE_WRITE_PATTERN = /(?:查询|查看|检查|确认|核对|读取|列出|统计|比较|分析)(?:一下|下)?\s*$/u;
const MAID_NON_TOOL_REPLY_SUFFIX_PATTERN = /^(?:我|检查结果|核对结果|验证结果|结果|答案|结论|情况|说明)(?:[，,。；;！？!?\s]|$)/u;
const MAID_ENGLISH_WRITE_PATTERN = /\b(?:create|add|append|write|save|bind|enable|disable|modify|update|edit|replace|overwrite|delete|remove|clear|clean|publish|send|set|switch|apply|repair|optimize|generate|upload|import|reply)\b/iu;
const MAID_ENGLISH_NEGATED_WRITE_PATTERN = /\b(?:do\s+not|don't|dont|never|without)\s+(?:create|add|append|write|save|bind|enable|disable|modify|update|edit|replace|overwrite|delete|remove|clear|clean|publish|send|set|switch|apply|repair|optimize|generate|upload|import|reply)\b/iu;

const hasExplicitMaidWriteIntent = (input = '') => {
  const text = String(input ?? '').normalize('NFKC').toLowerCase().trim();
  if (!text) return false;
  if (MAID_ENGLISH_WRITE_PATTERN.test(text) && !MAID_ENGLISH_NEGATED_WRITE_PATTERN.test(text)) {
    return true;
  }
  MAID_WRITE_VERB_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MAID_WRITE_VERB_PATTERN)) {
    const index = Number(match.index || 0);
    const verb = match[0];
    const clauseStart = Math.max(
      text.lastIndexOf('。', index - 1),
      text.lastIndexOf('；', index - 1),
      text.lastIndexOf(';', index - 1),
      text.lastIndexOf('！', index - 1),
      text.lastIndexOf('!', index - 1),
      text.lastIndexOf('？', index - 1),
      text.lastIndexOf('?', index - 1),
      text.lastIndexOf('\n', index - 1),
    ) + 1;
    const before = text.slice(clauseStart, index);
    const localClauseStart = Math.max(
      before.lastIndexOf('，'),
      before.lastIndexOf(','),
      before.lastIndexOf('、'),
    ) + 1;
    const localBefore = before.slice(localClauseStart);
    const after = text.slice(index + verb.length, index + verb.length + 16);
    if (MAID_NEGATED_WRITE_CLAUSE_PATTERN.test(before)) continue;
    if (MAID_WRITE_STATE_SUFFIX_PATTERN.test(after)) continue;
    if (
      MAID_READ_STATE_BEFORE_WRITE_PATTERN.test(localBefore) ||
      MAID_READ_ACTION_BEFORE_WRITE_PATTERN.test(localBefore) ||
      (verb === '回复' && MAID_NON_TOOL_REPLY_SUFFIX_PATTERN.test(after))
    ) {
      continue;
    }
    if (
      !before.trim() ||
      MAID_WRITE_COMMAND_CUE_PATTERN.test(before) ||
      MAID_POSTCHECK_WRITE_CUE_PATTERN.test(before) ||
      MAID_POSTCHECK_OBJECT_WRITE_CUE_PATTERN.test(before)
    ) {
      return true;
    }
  }
  return false;
};

export const classifyMaidOperationIntent = (input = '') => {
  const text = String(input ?? '').normalize('NFKC').trim();
  const noToolIntent = MAID_NO_TOOL_INTENT_PATTERN.test(text);
  const readIntent = MAID_READ_INTENT_PATTERN.test(text);
  const writeIntent = hasExplicitMaidWriteIntent(text);
  return {
    mode: noToolIntent
      ? 'no_tool'
      : (writeIntent ? 'write_allowed' : (readIntent ? 'read_only' : 'unspecified')),
    source: 'maid_user_request',
    reason: noToolIntent
      ? 'explicit_no_tool'
      : (writeIntent
        ? 'explicit_write'
        : (readIntent ? 'explicit_read_without_write' : 'intent_unspecified')),
  };
};

const MAID_BACKGROUND_PRESENTATION_PATTERN = /(后台(?:执行|处理|完成)?|保持当前位置|留在当前(?:页面|界面|聊天室|会话)?|不要打开|别打开|无需打开|不用打开|不要进入|别进入|无需进入|不用进入|不要跳转|别跳转|不要切换(?:页面|界面|聊天室|会话))/iu;
const MAID_SCOPED_NEGATED_NAVIGATION_PATTERN = /(?:不要|不得|别|无需|不用|禁止|避免|不可|不能)(?!\s*(?:忘(?:记|了)?|漏(?:掉)?|阻止|妨碍|拒绝|不))(?:(?![，,。；;！？!?\n]|但|但是|不过|然而).){0,32}?(?:打开|进入|跳转|切(?:换)?到)/iu;
const MAID_GUIDE_PRESENTATION_PATTERN = /(一步一步|一步步|逐步|教我|指导我|引导我|带着我|手把手|怎么(?:操作|设置|配置|创建|使用)|如何(?:操作|设置|配置|创建|使用))/iu;
const MAID_NEGATED_GUIDE_PATTERN = /(?:不要|别|无需|不用|取消|停止)\s*(?:再)?(?:引导|指导|教学|教程|一步一步|一步步)/iu;
const MAID_REVEAL_PRESENTATION_PATTERN = /(打开(?:给我看)?|进入(?:这个|该|对应)?(?:界面|页面|聊天室|会话)?|跳转(?:到)?|带我(?:去)?看(?:看)?|带我去|切到(?:对应)?(?:界面|页面|聊天室|会话)|(?:做完|完成|处理完|创建后|结束后).{0,16}(?:打开|进入|跳转|带我去|显示(?:界面|页面)))/iu;
const MAID_DEFERRED_REVEAL_PRESENTATION_PATTERN = /(?:(?:全部|都|整体|一切).{0,4})?(?:做完|完成|处理完|创建后|结束后|配置完|准备好)(?:以后|之后|后)?.{0,72}(?:打开|进入|跳转|带我(?:去)?看|显示(?:界面|页面)|切(?:换)?到)/iu;

const hasMaidDeferredResultReveal = (input = '') => (
  String(input ?? '')
    .split(/[，,。；;！？!?\n]/u)
    .map(item => item.trim())
    .filter(Boolean)
    .some(clause => (
      MAID_DEFERRED_REVEAL_PRESENTATION_PATTERN.test(clause) &&
      !MAID_SCOPED_NEGATED_NAVIGATION_PATTERN.test(clause)
    ))
);

export const classifyMaidPresentationIntent = (input = '') => {
  const text = String(input ?? '').normalize('NFKC').trim();
  const explicitGuide = MAID_GUIDE_PRESENTATION_PATTERN.test(text) &&
    !MAID_NEGATED_GUIDE_PATTERN.test(text);
  if (text && !explicitGuide && hasMaidDeferredResultReveal(text)) {
    return {
      mode: 'reveal',
      source: 'maid_user_request',
      reason: 'explicit_deferred_result_reveal',
    };
  }
  if (
    !text ||
    MAID_BACKGROUND_PRESENTATION_PATTERN.test(text) ||
    MAID_SCOPED_NEGATED_NAVIGATION_PATTERN.test(text)
  ) {
    return {
      mode: 'background',
      source: 'maid_user_request',
      reason: text ? 'explicit_background_or_no_navigation' : 'default_background',
    };
  }
  if (explicitGuide) {
    return {
      mode: 'guide',
      source: 'maid_user_request',
      reason: 'explicit_teaching_or_step_by_step',
    };
  }
  if (MAID_REVEAL_PRESENTATION_PATTERN.test(text)) {
    return {
      mode: 'reveal',
      source: 'maid_user_request',
      reason: 'explicit_navigation_or_result_reveal',
    };
  }
  return {
    mode: 'background',
    source: 'maid_user_request',
    reason: 'default_background',
  };
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const MAID_OPTIONAL_NAVIGATION_TOOLS = new Set([
  'session.create',
  'group.create',
]);

export const applyMaidPresentationPolicy = (plan = {}, presentationIntent = {}) => {
  const next = clone(plan || {});
  const mode = ['background', 'reveal', 'guide'].includes(trim(presentationIntent?.mode))
    ? trim(presentationIntent.mode)
    : 'background';
  if (MAID_OPTIONAL_NAVIGATION_TOOLS.has(trim(next?.toolName))) {
    next.args = {
      ...(isPlainObject(next?.args) ? next.args : {}),
      open: mode === 'guide',
    };
  }
  if (['persona.create', 'user.create'].includes(trim(next?.toolName))) {
    next.args = {
      ...(isPlainObject(next?.args) ? next.args : {}),
      setActive: mode === 'guide',
    };
  }
  if (trim(next?.toolName) === 'chat.send_message') {
    const args = isPlainObject(next?.args) ? next.args : {};
    const role = trim(args.role, 'user').toLowerCase();
    const triggersReply = role === 'user' && args.triggerReply !== false;
    next.args = {
      ...args,
      // 当前正常回复链依赖目标成为 current；在显式 target 隔离完成前不可伪装成后台发送。
      open: triggersReply || mode === 'reveal' || mode === 'guide',
    };
  }
  if (mode === 'guide') next.forceGuide = true;
  return next;
};

const stableForKey = (value) => {
  if (Array.isArray(value)) return value.map(stableForKey);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stableForKey(value[key]);
    return acc;
  }, {});
};

const stableJsonStringify = (value) => {
  try {
    return JSON.stringify(stableForKey(value));
  } catch {
    return String(value ?? '');
  }
};

const hasOwn = (value, key) => value !== null &&
  value !== undefined &&
  Object.prototype.hasOwnProperty.call(Object(value), key);

const unwrapToolOutputResult = (output = {}) => (
  hasOwn(output, 'result') ? output.result : output
);

const isToolOutputOk = (output = {}) => {
  if (output?.status && output.status !== 'succeeded') return false;
  const result = unwrapToolOutputResult(output);
  if (isPlainObject(result) && result.ok === false) return false;
  return true;
};

const isToolOutputCancelled = (output = {}) => {
  const result = unwrapToolOutputResult(output);
  return [output, result].some(value => (
    value?.cancelled === true ||
    trim(value?.status) === 'cancelled' ||
    trim(value?.reason) === 'user_aborted' ||
    trim(value?.failureCode) === 'user_aborted'
  ));
};

const summarizeToolFailure = (output = {}) => {
  const result = unwrapToolOutputResult(output);
  return trim(
    output?.summary ||
    result?.message ||
    result?.reason ||
    output?.reason ||
    '女仆执行失败。',
  );
};

const makeToolErrorOutput = (plan = {}, error = null) => ({
  toolName: trim(plan?.toolName),
  status: 'failed',
  summary: error?.message || String(error || 'maid assistant tool failed'),
  errorMessage: error?.message || String(error || ''),
  errorCode: trim(error?.code),
  result: {
    ok: false,
    reason: error?.message || String(error || 'maid assistant tool failed'),
  },
});

const countArrayItems = value => (Array.isArray(value) ? value.length : 0);
const countExecutedMaidToolCalls = steps => (
  (Array.isArray(steps) ? steps : [])
    .filter(step => step?.output?.localToolExecutionSkipped !== true)
    .length
);

const truncateForRun = (value = '', max = 200) => {
  const text = trim(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

// Phase B 真实计量：把一次 run 里所有 ReAct 模型调用的 provider usage 聚合成 AgentRun.usage。
// token 类只在至少一次调用真实返回 token 时才 recorded 并求和，否则 status=unknown、token 为 null（不估算）。
// latencyMs 求和为本轮模型总耗时；modelCallCount/toolCallCount/aborted 是本地可得事实。
export const aggregateMaidModelUsage = (entries = [], { toolCallCount = 0, aborted = false } = {}) => {
  const list = (Array.isArray(entries) ? entries : []).filter(e => e && typeof e === 'object');
  const finite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const hasTokens = list.some(e => finite(e.promptTokens) != null || finite(e.completionTokens) != null || finite(e.totalTokens) != null);
  const sum = (key) => list.reduce((acc, e) => {
    const v = finite(e[key]);
    return v != null ? acc + v : acc;
  }, 0);
  const lastWith = (key) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (trim(list[i][key])) return trim(list[i][key]);
    }
    return '';
  };
  return {
    status: hasTokens ? 'recorded' : 'unknown',
    provider: lastWith('provider'),
    model: lastWith('model'),
    promptTokens: hasTokens ? sum('promptTokens') : null,
    completionTokens: hasTokens ? sum('completionTokens') : null,
    // total = prompt 和 + completion 和，避免个别轮缺 total 字段导致与分项不自洽
    totalTokens: hasTokens ? sum('promptTokens') + sum('completionTokens') : null,
    latencyMs: list.length ? sum('latencyMs') : null,
    modelCallCount: list.reduce((count, entry) => {
      const reported = Math.trunc(Number(entry.modelCallCount));
      return count + (Number.isFinite(reported) && reported > 0 ? reported : 1);
    }, 0),
    toolCallCount: Math.max(0, Math.trunc(Number(toolCallCount)) || 0),
    degraded: list.some(e => e.degraded === true),
    aborted: aborted === true,
    finishReason: lastWith('finishReason'),
  };
};

const VALID_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);

const buildCapabilityPlanTrace = (plan = {}) => ({
  candidateSnapshotId: trim(plan?.candidateSnapshotId),
  retrieverVersion: trim(plan?.retrieverVersion),
  selectedCapabilityId: trim(plan?.selectedCapabilityId || plan?.featureId),
  candidateHit: typeof plan?.candidateHit === 'boolean' ? plan.candidateHit : null,
});

const resolveTrackedToolStepStatus = (output = {}) => {
  const outerStatus = trim(output?.status);
  if (isToolOutputCancelled(output)) return 'cancelled';
  if (outerStatus === 'skipped') return 'skipped';
  if (outerStatus === 'failed') return 'failed';
  if (!isToolOutputOk(output)) return 'failed';
  return VALID_STEP_STATUSES.has(outerStatus) ? outerStatus : 'succeeded';
};

// 一次 runPrompt 对应一个持久 run：目标、每个工具步骤、最终状态和 continueHint
// 都写入 agent run store；没有执行任何工具的纯聊天回应不建 run。
// 每次模型调用的分段计时（相对本次请求开始，毫秒），写入 run.metadata.timing 供耗时诊断
const summarizeMaidModelCallTiming = (usage = [], promptStartedAt = 0) => (Array.isArray(usage) ? usage : [])
  .filter(entry => Number.isFinite(Number(entry?.endedAt)) && promptStartedAt)
  .map(entry => ({
    phase: trim(entry.phase) || 'other',
    startMs: Math.max(0, Number(entry.endedAt) - (Number(entry.latencyMs) || 0) - promptStartedAt),
    latencyMs: Number(entry.latencyMs) || 0,
    promptTokens: Number.isFinite(Number(entry.promptTokens)) ? Number(entry.promptTokens) : null,
    completionTokens: Number.isFinite(Number(entry.completionTokens)) ? Number(entry.completionTokens) : null,
    ...(trim(entry.transport) ? { transport: trim(entry.transport) } : {}),
    ...(trim(entry.outcome) ? { outcome: trim(entry.outcome) } : {}),
    ...(trim(entry.error) ? { error: trim(entry.error).slice(0, 160) } : {}),
  }));

const createMaidRunTracker = ({ agentTaskRuntime = null, input = '', context = {}, promptStartedAt = 0 } = {}) => {
  const canTrack = Boolean(
    agentTaskRuntime &&
    typeof agentTaskRuntime.startRun === 'function' &&
    typeof agentTaskRuntime.finishRun === 'function' &&
    typeof agentTaskRuntime.startStep === 'function' &&
    typeof agentTaskRuntime.finishStep === 'function',
  );
  let run = null;
  // 实际执行的模型：首次模型调用返回时记下，任务卡显示“由哪个模型执行”
  let executionModel = '';
  const continuation = isPlainObject(context?.runContinuation) ? context.runContinuation : null;
  const trackedGoal = trim(continuation?.goal || input);
  const ensureRun = () => {
    if (!canTrack || run) return run;
    run = agentTaskRuntime.startRun({
      kind: 'maid_assistant',
      source: 'maid-assistant',
      trigger: 'manual',
      sessionId: trim(context.sessionId),
      title: truncateForRun(trackedGoal, 80),
      summary: truncateForRun(trackedGoal, 200),
      metadata: {
        goal: trackedGoal,
        maidSkills: serializeMaidSkillContext(context.maidSkillContext),
        ...(context.maidTaskInputs ? { maidTaskInputs: clone(context.maidTaskInputs) } : {}),
        ...(executionModel ? { executionModel } : {}),
        ...(context.source === 'maid_realtime' ? { submissionSource: context.source, submissionId: context.submissionId, voiceCallId: context.voiceCallId } : {}),
        ...(trim(continuation?.sourceRunId) ? {
          resumedFromRunId: trim(continuation.sourceRunId),
          continuationVersion: trim(continuation.version),
          todos: clone(continuation.remainingTodos || []),
        } : {}),
      },
    });
    return run;
  };
  const startToolStep = (plan = {}) => {
    const current = ensureRun();
    if (!current) return null;
    return agentTaskRuntime.startStep(current.id, {
      type: 'tool',
      summary: trim(plan.title || plan.toolName),
      input: {
        toolName: trim(plan.toolName),
        args: clone(plan.args || {}),
        ...buildCapabilityPlanTrace(plan),
      },
    });
  };
  const noteModel = (model = '') => {
    const name = trim(model);
    if (!name || name === executionModel) return;
    executionModel = name;
    if (run && typeof agentTaskRuntime?.updateRun === 'function') {
      agentTaskRuntime.updateRun(run.id, { metadata: { executionModel } });
    }
  };
  const finishToolStep = (step = null, patch = {}) => {
    if (!run || !step?.id) return;
    const toolName = step.input?.toolName || patch.output?.toolName;
    const output = toolName === 'app.read_skill'
      ? stripMaidSkillObservationBodies([{ toolName, output: patch.output }], context.maidSkillContext)[0].output
      : patch.output;
    if (toolName === 'app.read_skill') {
      agentTaskRuntime.updateRun?.(run.id, { metadata: { maidSkills: serializeMaidSkillContext(context.maidSkillContext) } });
    }
    agentTaskRuntime.finishStep(run.id, step.id, { ...patch, output });
  };
  const finish = (result = {}, usage = null) => {
    if (!run) return;
    const ok = result?.ok === true;
    const failureCode = ok ? '' : classifyMaidRunFailure(result);
    const cancelled = trim(result?.status) === 'cancelled' || failureCode === 'user_aborted';
    const maidContext = isPlainObject(context?.maidConversationContextRef?.current)
      ? context.maidConversationContextRef.current
      : (isPlainObject(context?.maidConversationContext) ? context.maidConversationContext : {});
    const runUsage = aggregateMaidModelUsage(Array.isArray(usage) ? usage : [], {
      toolCallCount: countExecutedMaidToolCalls(result?.steps),
      aborted: cancelled,
    });
    const continuationSnapshot = result?.continuable === true
      ? buildMaidRunContinuationSnapshot({
          run: agentTaskRuntime?.getRun?.(run.id) || run,
          result,
          previousSnapshot: continuation,
          visualSpecLedger: context?.maidVisualSpecLedger,
        })
      : null;
    const visualSpecLedger = normalizeMaidVisualSpecLedger(context?.maidVisualSpecLedger);
    const hasVisualSpecs = Object.keys(visualSpecLedger.specs).length > 0;
    const summary = truncateForRun(
      result?.message || result?.reason || (ok ? '女仆已完成。' : '女仆执行失败。'),
    );
    const metadata = {
      goal: trackedGoal,
      maidSkills: serializeMaidSkillContext(context.maidSkillContext),
      ...(executionModel ? { executionModel } : {}),
      ...(trim(continuation?.sourceRunId) ? {
        resumedFromRunId: trim(continuation.sourceRunId),
        continuationVersion: trim(continuation.version),
      } : {}),
      ...(continuationSnapshot ? { continuationSnapshot } : {}),
      ...(hasVisualSpecs ? { visualSpecLedger } : {}),
      maidStatus: trim(result?.status),
      responseType: trim(result?.responseType),
      reason: trim(result?.reason),
      failureCode,
      continuable: result?.continuable === true,
      continueHint: trim(result?.continueHint),
      stepCount: countArrayItems(result?.steps),
      reactStoppedReason: trim(result?.reactStoppedReason),
      lastCandidateSnapshotId: trim(result?.capabilityRouting?.lastCandidateSnapshotId),
      candidateEffectiveMode: trim(result?.capabilityRouting?.effectiveMode),
      candidateDecisionCount: Number(result?.capabilityRouting?.decisionCount || 0) || 0,
      candidateValidSelectionCount: Number(result?.capabilityRouting?.validSelectionCount || 0) || 0,
      candidateHitCount: Number(result?.capabilityRouting?.hitCount || 0) || 0,
      candidateAllCovered: result?.capabilityRouting?.validSelectionCount > 0
        ? result?.capabilityRouting?.allValidSelectionsCovered === true
        : null,
      timing: {
        promptStartedAt,
        modelCalls: summarizeMaidModelCallTiming(usage, promptStartedAt),
      },
      maidContextVersion: trim(maidContext?.maidContextVersion),
      maidContextTokenCount: Number(maidContext?.tokenCount || 0) || 0,
      maidContextHistoryTokenCount: Number(maidContext?.historyTokenCount || 0) || 0,
      maidContextMemoryTokenCount: Number(maidContext?.memoryTokenCount || 0) || 0,
      maidContextMemoryIds: (Array.isArray(maidContext?.selectedMemoryIds)
        ? maidContext.selectedMemoryIds
        : [])
        .map(item => trim(item))
        .filter(Boolean)
        .slice(0, 12),
      ...(isPlainObject(result?.pendingWorkflow) ? {
        pendingWorkflow: clone(result.pendingWorkflow),
      } : {}),
    };
    if (
      trim(result?.status) === 'awaiting_confirmation' &&
      isPlainObject(result?.pendingWorkflow) &&
      typeof agentTaskRuntime?.updateRun === 'function'
    ) {
      agentTaskRuntime.updateRun(run.id, {
        status: 'waiting_permission',
        summary,
        errorMessage: '',
        usage: runUsage,
        metadata,
      });
      try { void agentTaskRuntime.flush?.(); } catch {}
      return;
    }
    agentTaskRuntime.finishRun(run.id, {
      status: cancelled ? 'cancelled' : (ok ? 'succeeded' : 'failed'),
      summary,
      errorMessage: ok || cancelled ? '' : truncateForRun(result?.reason || result?.message || ''),
      ...(cancelled ? { cancelReason: 'user_cancelled' } : {}),
      usage: runUsage,
      metadata,
    });
  };
  const markWaitingPermission = (pending = true) => {
    if (!canTrack || !run || typeof agentTaskRuntime.updateRun !== 'function') return;
    try {
      agentTaskRuntime.updateRun(run.id, { status: pending ? 'waiting_permission' : 'running' });
    } catch {}
  };
  return {
    canTrack,
    ensureRun,
    startToolStep,
    finishToolStep,
    finish,
    noteModel,
    markWaitingPermission,
    getRunId: () => trim(run?.id),
  };
};

const extractExplicitMaidChatWrites = (input = '') => {
  const text = String(input ?? '').normalize('NFKC');
  if (
    !/(?:后台|保持当前(?:房间|聊天室|会话)|不(?:要|得)打开)/iu.test(text) ||
    !/triggerReply\s*:\s*false/iu.test(text) ||
    !/open\s*:\s*false/iu.test(text)
  ) return [];
  const writes = [];
  const seen = new Set();
  const pattern = /给\s*[「『“"']([^」』”"']{1,160})[」』”"']\s*(?:写(?:入)?|发送)\s*[「『“"']([^」』”"']{1,1000})[」』”"']/gu;
  for (const match of text.matchAll(pattern)) {
    const sessionName = trim(match?.[1]);
    const content = trim(match?.[2]);
    const key = `${normalizeText(sessionName)}:${content}`;
    if (!sessionName || !content || seen.has(key)) continue;
    seen.add(key);
    writes.push({ sessionName, content, key });
  }
  return writes.length >= 2 ? writes.slice(0, 20) : [];
};

const hasSucceededMaidChatWrite = (steps = [], obligation = {}) => (
  (Array.isArray(steps) ? steps : []).some(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'chat.send_message' &&
    normalizeText(step?.args?.sessionName || step?.args?.sessionId || step?.args?.target || step?.args?.chatName) ===
      normalizeText(obligation.sessionName) &&
    trim(step?.args?.content || step?.args?.message || step?.args?.text) === trim(obligation.content)
  ))
);

const hasSucceededMaidChatReadback = (steps = [], sessionName = '') => (
  (Array.isArray(steps) ? steps : []).some(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'app.read_resource' &&
    trim(step?.args?.resource || step?.output?.resource).toLowerCase() === 'chat' &&
    normalizeText(step?.args?.sessionName || step?.args?.sessionId || step?.args?.target) === normalizeText(sessionName)
  ))
);

const buildPendingExplicitMaidChatPlan = ({
  input = '',
  steps = [],
  decision = {},
} = {}) => {
  const writes = extractExplicitMaidChatWrites(input);
  if (!writes.length) return null;
  const pendingWrite = writes.find(item => !hasSucceededMaidChatWrite(steps, item));
  const trace = {
    candidateSnapshotId: trim(decision?.candidateSnapshotId),
    retrieverVersion: trim(decision?.retrieverVersion),
    capabilityRoutingMode: trim(decision?.capabilityRoutingMode),
  };
  if (pendingWrite) {
    return {
      ok: true,
      action: 'tool',
      toolName: 'chat.send_message',
      args: {
        sessionName: pendingWrite.sessionName,
        content: pendingWrite.content,
        role: 'user',
        triggerReply: false,
        open: false,
      },
      featureId: 'chat.send_message',
      title: `继续写入「${pendingWrite.sessionName}」`,
      response: `继续处理尚未完成的「${pendingWrite.sessionName}」。`,
      metadata: {
        workflowTransition: 'remaining_chat_write',
        obligationKey: pendingWrite.key,
      },
      ...trace,
    };
  }
  const needsReadback = /(?:结构化\s*chat|chat\s*资源).{0,40}(?:读取|读回)|(?:读取|读回).{0,40}(?:最后一条|末条)消息/iu.test(
    String(input ?? '').normalize('NFKC'),
  );
  if (needsReadback) {
    const pendingReadback = writes.find(item => !hasSucceededMaidChatReadback(steps, item.sessionName));
    if (pendingReadback) {
      return {
        ok: true,
        action: 'tool',
        toolName: 'app.read_resource',
        args: {
          resource: 'chat',
          sessionName: pendingReadback.sessionName,
          limit: 1,
        },
        featureId: 'app.resource.read',
        title: `读回「${pendingReadback.sessionName}」末条消息`,
        response: `核对「${pendingReadback.sessionName}」的写入结果。`,
        metadata: {
          workflowTransition: 'remaining_chat_readback',
          obligationKey: `chat-readback:${pendingReadback.sessionName}`,
        },
        ...trace,
      };
    }
  }
  return buildPendingMaidFinalStatePlan({ input, steps, decision });
};

const resolveReactStepBudget = ({
  input = '',
  plan = {},
  context = {},
  configuredMaxReactSteps = 40,
} = {}) => {
  const toolName = trim(plan?.toolName);
  const args = isPlainObject(plan?.args) ? plan.args : {};
  const hardMax = Math.max(1, Math.min(80, Math.trunc(Number(
    context.maxReactSteps || context.reactMaxSteps || configuredMaxReactSteps || 40,
  )) || 40));
  // 2026-08-17 上调：日常任务频繁打到 6-10 的小预算后要用户手动「继续」，整体约 1.5 倍；
  // 类型内上限从固定 40 改为跟随 hardMax，让用户设置的步数上限对长任务真实生效。
  let recommended = 12;
  if (toolName === 'maid.todo.write') {
    // 以任务清单开场 = 复合多步任务：按清单长度给预算（每项工具+验证+清单更新约 6 步）。
    recommended = Math.min(hardMax, 12 + countArrayItems(args.todos) * 6);
  } else if (toolName === 'app.open_panel' || toolName === 'session.open' || toolName === 'session.open_config') {
    recommended = 10;
  } else if (toolName === 'chat.send_message') {
    const explicitTargetCount = extractExplicitMaidChatWrites(input).length;
    recommended = explicitTargetCount > 1
      ? Math.min(hardMax, Math.max(10, explicitTargetCount * 3 + 4))
      : 10;
  } else if (toolName === 'app.read_resource' || toolName === 'worldbook.read' || toolName === 'worldbook.list') {
    recommended = 14;
  } else if (toolName === 'web.search_images' || toolName === 'media.fetch_image') {
    // 联网找图设头像/壁纸：图源 403 换图重试是常态，多目标（头像+壁纸）步数翻倍。
    recommended = 24;
  } else if (toolName === 'worldbook.create' || toolName === 'worldbook.update_entries' || toolName === 'worldbook.delete_entries') {
    const batchSize = Math.max(countArrayItems(args.entries), countArrayItems(args.updates), countArrayItems(args.deletes), 1);
    recommended = Math.min(hardMax, 18 + (batchSize * 4));
  } else if (/^(persona|user|session|contact|group)\./.test(toolName)) {
    recommended = 14;
  }
  const feature = findAppFeature(trim(plan?.featureId) || toolName);
  const writeLike = toolName === 'maid.todo.write' || feature?.writes === true;
  // recommended 是主任务动作额度；写任务另留一个有界尾舱给读回复验、
  // 清单收口或模型修正。用户/构造器设置的 hardMax 仍是绝对上限。
  const verificationReserve = writeLike ? (toolName === 'maid.todo.write' ? 4 : 2) : 0;
  const actionSteps = Math.max(1, Math.min(hardMax, recommended));
  const maxSteps = Math.max(1, Math.min(hardMax, actionSteps + verificationReserve));
  return {
    maxSteps,
    hardMax,
    recommended,
    actionSteps,
    verificationReserve: Math.max(0, maxSteps - actionSteps),
    toolName,
  };
};

// 重复检测按目标比较：参数里的名称与 ID 先统一成同一目标（见 maid-run-target-ledger.js），
// 按名称删和按 ID 删、按名称停用和按 ID 停用都算同一操作。
const getConsecutiveRepeatedFailure = (steps = []) => countConsecutiveSameAction(steps, 'failed');

// 同一工具同一目标连续成功调用（如反复 maid.todo.read）说明模型在原地转圈，不产出实际进展。
const getConsecutiveRepeatedSuccess = (steps = []) => countConsecutiveSameAction(steps, 'succeeded');

// 同一工具连续调用（参数可不同）超过上限 = 在单一工具上打转（如反复换词搜索），无编排进展。
const getConsecutiveSameToolCount = (steps = []) => {
  const list = Array.isArray(steps) ? steps : [];
  const last = list.at(-1);
  const toolName = trim(last?.toolName);
  if (!toolName) return { count: 0, toolName: '' };
  let count = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (trim(list[index]?.toolName) !== toolName) break;
    count += 1;
  }
  return { count, toolName };
};

const MAID_READ_RESOURCE_KEYS = new Set([
  'persona',
  'user',
  'preset',
  'regex',
  'variables',
  'config',
]);

const stripNegatedMaidActionClauses = value => String(value ?? '')
  .replace(/(?:不要|不得|别|禁止|无需|不用|不可|不能|避免)\s*[^，,。；;！？!?\n]*/gu, ' ');

const extractConditionalMaidProfileCreateObligation = ({
  input = '',
  operationIntentPolicy = {},
} = {}) => {
  if (operationIntentPolicy?.mode !== 'write_allowed') return null;
  const text = String(input ?? '').normalize('NFKC');
  const condition = text.match(
    /(?:不存在|没有|缺少|若无|如无)(?:时|的话)?(?:才|就|则|再)?\s*(?:创建|新建|新增|添加)/iu,
  );
  if (!condition) return null;
  const tail = text.slice(Number(condition.index || 0) + condition[0].length);
  const target = trim(tail.match(/[「『“"']([^」』”"']{1,160})[」』”"']/u)?.[1]);
  if (!target) return null;
  const hasPersona = /角色卡|角色档案|人物卡/iu.test(text);
  const hasUser = /用户清单|用户列表|用户名称|用户名|用户档案/iu.test(text);
  if (hasPersona === hasUser) return null;
  const resource = hasPersona ? 'persona' : 'user';
  return {
    resource,
    target,
    createTool: `${resource}.create`,
    featureId: `${resource}.create`,
    label: resource === 'persona' ? '角色卡' : '用户',
  };
};

const maidProfileReadContainsTarget = (step = {}, obligation = {}) => (
  step?.status === 'succeeded' &&
  trim(step?.toolName) === 'app.read_resource' &&
  trim(step?.args?.resource || step?.output?.resource).toLowerCase() === obligation.resource &&
  (Array.isArray(step?.output?.items) ? step.output.items : []).some(item => (
    normalizeText(item?.name || item?.id) === normalizeText(obligation.target)
  ))
);

const isConclusiveMissingMaidProfileRead = (step = {}, obligation = {}) => {
  if (
    step?.status !== 'succeeded' ||
    trim(step?.toolName) !== 'app.read_resource' ||
    trim(step?.args?.resource || step?.output?.resource).toLowerCase() !== obligation.resource
  ) return false;
  const requestedTarget = trim(step?.args?.name || step?.args?.id || step?.args?.query);
  if (requestedTarget && normalizeText(requestedTarget) === normalizeText(obligation.target)) return true;
  const items = Array.isArray(step?.output?.items) ? step.output.items : [];
  const count = Number(step?.output?.count);
  return Number.isFinite(count) && count >= 0 && items.length >= count;
};

const buildMaidConditionalProfileCreateProgress = ({
  input = '',
  operationIntentPolicy = {},
  steps = [],
} = {}) => {
  const obligation = extractConditionalMaidProfileCreateObligation({
    input,
    operationIntentPolicy,
  });
  if (!obligation) return null;
  const source = Array.isArray(steps) ? steps : [];
  const matchingReads = source.filter(step => (
    trim(step?.toolName) === 'app.read_resource' &&
    trim(step?.args?.resource || step?.output?.resource).toLowerCase() === obligation.resource
  ));
  const targetExists = matchingReads.some(step => maidProfileReadContainsTarget(step, obligation));
  const created = source.some(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === obligation.createTool &&
    normalizeText(step?.args?.name || step?.args?.target) === normalizeText(obligation.target)
  ));
  if (targetExists) {
    const message = created
      ? `已创建${obligation.label}「${obligation.target}」并读回确认；当前${obligation.label}未切换。`
      : `${obligation.label}「${obligation.target}」已存在，因此没有重复创建，也没有切换当前${obligation.label}。`;
    return {
      complete: true,
      finalDecision: {
        ok: true,
        action: 'final',
        source: 'deterministic_conditional_create_completion',
        message,
      },
    };
  }
  if (created) return null;
  const conclusiveMissing = matchingReads.findLast(step => (
    isConclusiveMissingMaidProfileRead(step, obligation)
  ));
  if (!conclusiveMissing) {
    if (!matchingReads.length) return null;
    return {
      complete: false,
      nextPlan: {
        ok: true,
        action: 'tool',
        toolName: 'app.read_resource',
        args: { resource: obligation.resource, name: obligation.target },
        featureId: 'app.resource.read',
        title: `精确确认${obligation.label}是否存在`,
        response: `清单结果有截断，先精确确认「${obligation.target}」是否存在。`,
        metadata: {
          workflowTransition: 'conditional_create_target_probe',
          obligationKey: `${obligation.resource}:${normalizeText(obligation.target)}`,
        },
      },
    };
  }
  return {
    complete: false,
    nextPlan: {
      ok: true,
      action: 'tool',
      toolName: obligation.createTool,
      args: { name: obligation.target, setActive: false },
      featureId: obligation.featureId,
      title: `创建缺少的${obligation.label}`,
      response: `清单中没有「${obligation.target}」，继续创建并读回确认。`,
      metadata: {
        workflowTransition: 'conditional_create_missing_target',
        obligationKey: `${obligation.resource}:${normalizeText(obligation.target)}`,
      },
    },
  };
};

const buildPendingMaidFinalStatePlan = ({
  input = '',
  steps = [],
  decision = {},
} = {}) => {
  const positiveText = stripNegatedMaidActionClauses(String(input ?? '').normalize('NFKC'));
  if (!/(?:最后|再|然后).{0,20}读取\s*APP\s*状态/iu.test(positiveText)) return null;
  const hasState = (Array.isArray(steps) ? steps : []).some(step => (
    step?.status === 'succeeded' && trim(step?.toolName) === 'app.get_current_state'
  ));
  if (hasState) return null;
  return {
    ok: true,
    action: 'tool',
    toolName: 'app.get_current_state',
    args: {},
    featureId: 'app.state.read',
    title: '确认当前 APP 状态',
    response: '最后确认当前房间没有变化。',
    metadata: {
      workflowTransition: 'remaining_state_verification',
      obligationKey: 'app-state',
    },
    candidateSnapshotId: trim(decision?.candidateSnapshotId),
    retrieverVersion: trim(decision?.retrieverVersion),
    capabilityRoutingMode: trim(decision?.capabilityRoutingMode),
  };
};

const getMaidRevealFinalMessage = (steps = [], decision = {}) => (
  trim(decision?.message) ||
  trim((Array.isArray(steps) ? steps : []).find(step => (
    trim(step?.metadata?.workflowTransition) === 'result_reveal' &&
    trim(step?.metadata?.revealFinalMessage)
  ))?.metadata?.revealFinalMessage)
);

const getMaidRevealTargets = (steps = []) => {
  const source = (Array.isArray(steps) ? steps : []).filter(step => (
    step?.status === 'succeeded' &&
    trim(step?.metadata?.workflowTransition) !== 'result_reveal'
  ));
  const personaStep = source.find(step => trim(step?.toolName) === 'persona.create');
  const userStep = source.find(step => trim(step?.toolName) === 'user.create');
  const groupStep = source.findLast(step => trim(step?.toolName) === 'group.create');
  const sessionStep = source.find(step => trim(step?.toolName) === 'session.create');
  const personaId = trim(personaStep?.output?.personaId || personaStep?.output?.profile?.id);
  const userId = trim(userStep?.output?.userId || userStep?.output?.profile?.id);
  const groupSessionId = trim(
    groupStep?.output?.groupId ||
    groupStep?.output?.group?.id ||
    groupStep?.output?.sessionId,
  );
  const privateSessionId = trim(
    (Array.isArray(sessionStep?.output?.sessionIds) ? sessionStep.output.sessionIds[0] : '') ||
    (Array.isArray(sessionStep?.output?.sessions)
      ? sessionStep.output.sessions[0]?.sessionId || sessionStep.output.sessions[0]?.id
      : '') ||
    sessionStep?.output?.sessionId ||
    (Array.isArray(sessionStep?.args?.names) ? sessionStep.args.names[0] : '') ||
    sessionStep?.args?.name,
  );
  return {
    personaId,
    userId,
    sessionId: groupSessionId || privateSessionId,
  };
};

const MAID_PERSONA_BUILD_REQUEST_PATTERN = /(?:(?:创建|建立|新建|导入|建|配好)(?:(?!(?:删除|清理|移除|归档)).){0,40}(?:角色卡|角色档案|人物卡)|(?:角色卡|角色档案|人物卡)(?:(?!(?:删除|清理|移除|归档)).){0,24}(?:创建|建立|新建|导入|建|配好)|\b(?:create|build|import)\b.{0,40}\b(?:persona|character\s*card)\b)/isu;
const MAID_PERSONA_SCOPED_BUILD_REQUEST_PATTERN = /(?:(?:创建|建立|新建|新增|生成|配好|建|开)(?:(?!(?:角色卡|角色档案|人物卡|删除|清理|移除|归档|查看|读取|检查|保留|取消)).){0,48}(?:私聊|单聊|聊天室|会话|房间|群聊|群组|联系人)|\b(?:create|build|add)\b(?:(?!\b(?:persona|character\s*card|delete|remove|inspect|read|keep)\b).){0,48}\b(?:private\s*chat|chat|session|room|group|contact)\b)/isu;

const hasMaidPersonaScopedBuildRequest = (input = '') => {
  const text = String(input ?? '').normalize('NFKC');
  return MAID_PERSONA_BUILD_REQUEST_PATTERN.test(text) &&
    MAID_PERSONA_SCOPED_BUILD_REQUEST_PATTERN.test(text);
};

const getMaidPersonaStepTarget = (step = {}) => trim(
  step?.output?.personaId ||
  step?.output?.profile?.id ||
  step?.args?.target ||
  step?.args?.personaId ||
  step?.args?.id ||
  step?.args?.name,
);

const getLatestSucceededMaidPersonaSwitch = (steps = []) => (
  (Array.isArray(steps) ? steps : []).findLast(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'persona.switch'
  )) || null
);

const buildPendingMaidWorkScopePlan = ({
  input = '',
  steps = [],
} = {}) => {
  if (!hasMaidPersonaScopedBuildRequest(input)) return null;
  const source = Array.isArray(steps) ? steps : [];
  const personaStep = source.find(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'persona.create'
  ));
  const personaId = getMaidPersonaStepTarget(personaStep);
  if (!personaId) return null;
  const latestSwitch = getLatestSucceededMaidPersonaSwitch(source);
  if (
    latestSwitch &&
    normalizeText(getMaidPersonaStepTarget(latestSwitch)) === normalizeText(personaId)
  ) return null;
  const attempted = source.some(step => (
    trim(step?.metadata?.workflowTransition) === 'work_scope' &&
    trim(step?.metadata?.workScopeKind) === 'persona'
  ));
  if (attempted) return null;
  return {
    ok: true,
    action: 'tool',
    toolName: 'persona.switch',
    args: { target: personaId },
    featureId: 'persona.switch',
    title: '切换角色卡工作域',
    response: '先切换到新角色卡的工作域，再继续建立其中的聊天室与群聊。',
    metadata: {
      workflowTransition: 'work_scope',
      workScopeKind: 'persona',
      workScopeTargetId: personaId,
    },
    source: 'deterministic_work_scope',
  };
};

export const buildPendingMaidResultRevealPlan = ({
  presentationIntent = {},
  steps = [],
  decision = {},
} = {}) => {
  if (trim(presentationIntent?.mode) !== 'reveal') return null;
  const targets = getMaidRevealTargets(steps);
  const completedKinds = new Set(
    (Array.isArray(steps) ? steps : [])
      .filter(step => (
        step?.status === 'succeeded' &&
        trim(step?.metadata?.workflowTransition) === 'result_reveal'
      ))
      .map(step => trim(step?.metadata?.revealKind))
      .filter(Boolean),
  );
  const finalMessage = getMaidRevealFinalMessage(steps, decision);
  const trace = {
    candidateSnapshotId: trim(decision?.candidateSnapshotId),
    retrieverVersion: trim(decision?.retrieverVersion),
    capabilityRoutingMode: trim(decision?.capabilityRoutingMode),
  };
  const latestPersonaSwitch = getLatestSucceededMaidPersonaSwitch(steps);
  const personaAlreadyActive = Boolean(
    latestPersonaSwitch &&
    normalizeText(getMaidPersonaStepTarget(latestPersonaSwitch)) === normalizeText(targets.personaId),
  );
  const buildRevealPlan = ({
    kind,
    toolName,
    args,
    featureId,
    title,
    response,
  }) => ({
    ok: true,
    action: 'tool',
    toolName,
    args,
    featureId,
    title,
    response,
    metadata: {
      workflowTransition: 'result_reveal',
      revealKind: kind,
      revealFinalMessage: finalMessage,
      skipAutoVerification: true,
    },
    ...trace,
  });
  if (targets.personaId && !personaAlreadyActive && !completedKinds.has('persona')) {
    return buildRevealPlan({
      kind: 'persona',
      toolName: 'persona.switch',
      args: { target: targets.personaId },
      featureId: 'persona.switch',
      title: '激活主要角色卡',
      response: '任务已经完成，我来激活主要角色卡。',
    });
  }
  if (targets.userId && !completedKinds.has('user')) {
    return buildRevealPlan({
      kind: 'user',
      toolName: 'user.switch',
      args: { target: targets.userId },
      featureId: 'user.switch',
      title: '激活主要用户',
      response: '继续激活这次任务的主要用户。',
    });
  }
  if (targets.sessionId && !completedKinds.has('session')) {
    return buildRevealPlan({
      kind: 'session',
      toolName: 'session.open',
      args: { sessionId: targets.sessionId },
      featureId: 'session.open',
      title: '打开主要会话',
      response: '最后打开一个主要会话给你查看。',
    });
  }
  return null;
};

const hasMaidInteractiveActionRequest = (input = '') => {
  const text = stripNegatedMaidActionClauses(String(input ?? '').normalize('NFKC'));
  return /(打开|进入|点击|点开|按下|切换|跳转|返回|关闭|选择|勾选|滚动|展开|收起|导航|\b(?:open|enter|click|press|switch|navigate|select|scroll)\b)/iu.test(text);
};

const hasMaidDetailedReadRequest = (input = '') => (
  /(完整|详情|描述|设定|简介|头像|正文|原文|具体(?:内容|数值|规则)?|提示词|挑出|选出|筛选|候选(?:清单|名单)?|归类|归纳|分析|判断|推荐|主要(?:人物|角色|成员)|变量[^。；;！？!?\n]{0,16}(?:值|内容)|\b(?:prompt|description|avatar|details?|content|value|base\s*url|endpoint|transport)\b)/iu
    .test(String(input ?? '').normalize('NFKC'))
);

const getRequestedMaidReadKeys = (input = '') => {
  const text = String(input ?? '').normalize('NFKC');
  const patterns = [
    ['state', /(APP\s*状态|当前状态|状态摘要|当前页面|哪个页面|当前位置|where\s+am\s+i)/iu],
    ['todo', /(待办|任务清单|\btodo\b)/iu],
    ['persona', /(角色卡|角色皮|character\s*cards?)/iu],
    ['user', /(用户(?:名称|资料|清单|身份|资源)?|user\s+identit(?:y|ies)|current\s+user)/iu],
    ['preset', /(?:\bpreset\b|预设)/iu],
    ['regex', /(?:\bregex\b|正则)/iu],
    ['variables', /(?:\bvariables?\b|变量)/iu],
    ['config', /(模型档|模型配置|当前模型|服务商|\bprovider\b)/iu],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
};

const getMaidReadStepKey = (step = {}) => {
  if (step?.status !== 'succeeded') return '';
  const toolName = trim(step?.toolName);
  if (toolName === 'app.get_current_state') return 'state';
  if (toolName === 'maid.todo.read') return 'todo';
  if (toolName !== 'app.read_resource') return '';
  const resource = trim(step?.output?.resource || step?.args?.resource).toLowerCase();
  return MAID_READ_RESOURCE_KEYS.has(resource) ? resource : '';
};

const countObjectKeys = value => (isPlainObject(value) ? Object.keys(value).length : 0);

const summarizeMaidProfileAssociations = (item = {}) => {
  const associations = isPlainObject(item?.associations) ? item.associations : {};
  const refs = [];
  const worldbookId = trim(associations.worldbookId);
  const systemPresetId = trim(associations.systemPresetId);
  const regexSetId = trim(associations.regexSetId);
  if (worldbookId) {
    refs.push(`世界书「${worldbookId}」（${associations.worldbookEnabled === false ? '未启用' : '已启用'}）`);
  }
  if (systemPresetId) refs.push(`系统预设「${systemPresetId}」`);
  if (regexSetId) refs.push(`正则集「${regexSetId}」`);
  return `${trim(item?.name || item?.id, '未命名角色卡')}：${refs.length ? refs.join('、') : '未记录关联资源'}`;
};

const summarizeMaidProfileRead = (label, output = {}) => {
  const items = Array.isArray(output?.items) ? output.items : [];
  const count = Number.isFinite(Number(output?.count)) ? Number(output.count) : items.length;
  const activeId = trim(output?.activeId);
  const active = items.find(item => item?.active === true || (activeId && trim(item?.id) === activeId));
  const activeName = trim(active?.name || activeId, '未设置');
  const names = items.map(item => trim(item?.name)).filter(Boolean).slice(0, 8);
  const includesAssociations = Array.isArray(output?.includedFields) &&
    output.includedFields.some(field => trim(field).toLowerCase() === 'associations');
  const associationSummaries = includesAssociations
    ? items.slice(0, 8).map(summarizeMaidProfileAssociations)
    : [];
  return [
    `${label}：共 ${count} 项；当前为「${activeName}」`,
    names.length ? `本次返回：${names.join('、')}${items.length > names.length ? '…' : ''}` : '',
    associationSummaries.length
      ? `关联资源：${associationSummaries.join('；')}${items.length > associationSummaries.length ? '…' : ''}`
      : '',
  ].filter(Boolean).join('；');
};

const summarizeMaidReadResult = (key, output = {}) => {
  if (key === 'state') {
    return [
      `APP 状态：页面 ${trim(output?.activePage, '未知')}`,
      trim(output?.uiMode) ? `模式 ${trim(output.uiMode)}` : '',
      trim(output?.sessionId) ? `当前会话「${trim(output.sessionId)}」` : '',
    ].filter(Boolean).join('；');
  }
  if (key === 'todo') {
    const todos = Array.isArray(output?.todos) ? output.todos : [];
    if (!todos.length) return '待办：当前没有项目';
    const count = Number.isFinite(Number(output?.count)) ? Number(output.count) : todos.length;
    const completed = todos.filter(item => item?.status === 'completed').length;
    const inProgress = todos.filter(item => item?.status === 'in_progress').length;
    const pending = todos.filter(item => item?.status === 'pending').length;
    return `待办：共 ${count} 项；已完成 ${completed}，进行中 ${inProgress}，待处理 ${pending}`;
  }
  if (key === 'persona') return summarizeMaidProfileRead('角色卡', output);
  if (key === 'user') return summarizeMaidProfileRead('用户', output);
  if (key === 'preset') {
    const active = Object.entries(isPlainObject(output?.presets) ? output.presets : {})
      .map(([scope, value]) => `${scope}=${trim(value?.activeId, '未设置')}`);
    return `预设：${active.length ? active.join('、') : '未返回活动预设'}`;
  }
  if (key === 'regex') {
    const count = Number.isFinite(Number(output?.count))
      ? Number(output.count)
      : countArrayItems(output?.sets);
    const enabled = output?.session?.enabled === false ? '未启用' : '已启用';
    return `正则：${enabled}，共 ${count} 个规则集`;
  }
  if (key === 'variables') {
    return `变量：会话 ${countObjectKeys(output?.variables)} 项，全局 ${countObjectKeys(output?.globalVariables)} 项`;
  }
  if (key === 'config') {
    const config = isPlainObject(output?.config) ? output.config : {};
    return [
      `模型配置：服务商 ${trim(config.provider, '未设置')}`,
      `模型 ${trim(config.model, '未设置')}`,
      trim(config.activeProfileId) ? `当前档 ${trim(config.activeProfileId)}` : '',
    ].filter(Boolean).join('；');
  }
  return '';
};

const extractMaidQuotedValues = (value = '') => (
  Array.from(String(value ?? '').matchAll(/[「『“"']([^」』”"']{1,160})[」』”"']/gu))
    .map(match => trim(match?.[1]))
    .filter(Boolean)
);

const buildMaidStructuredReadObligations = ({
  input = '',
  operationIntentPolicy = {},
} = {}) => {
  const text = String(input ?? '').normalize('NFKC');
  if (
    operationIntentPolicy?.mode !== 'read_only' ||
    !/(?:审计|稽核|完整核对|最终核对)/iu.test(text) ||
    hasMaidInteractiveActionRequest(text)
  ) return [];
  const obligations = [];
  const auditPrefix = trim(
    text.match(/(?:对|核对)\s*[「『“"']([^」』”"']{1,160})[」』”"']\s*(?:资源)?(?:做|进行)?(?:最终)?(?:只读)?(?:审计|核对)/iu)?.[1],
  );
  const add = (value) => {
    if (!value?.key || obligations.some(item => item.key === value.key)) return;
    obligations.push(value);
  };
  const worldbookMatch = text.match(
    /读取(?:世界书)?\s*[「『“"']([^」』”"']{1,160})[」』”"']\s*(?:全文|完整)?(?:索引|目录)/iu,
  );
  if (worldbookMatch?.[1]) {
    const name = trim(worldbookMatch[1]);
    add({
      key: `worldbook:${normalizeText(name)}`,
      kind: 'worldbook',
      target: name,
      toolName: 'worldbook.read',
      featureId: 'worldbook.read',
      args: { name },
      title: `读取世界书「${name}」索引`,
    });
  }
  if (/(?:读取|查看|核对)(?:完整)?(?:会话|聊天室)(?:清单|列表)/iu.test(text)) {
    add({
      key: 'session-list',
      kind: 'session-list',
      auditPrefix,
      toolName: 'session.list',
      featureId: 'session.list',
      args: {},
      title: '读取完整会话清单',
    });
  }
  if (/(?:读取|查看|核对)[^。；;！？!?\n]{0,40}用户[^。；;！？!?\n]{0,24}(?:清单|列表)/iu.test(text)) {
    add({
      key: 'resource:user',
      kind: 'resource',
      resource: 'user',
      auditPrefix,
      toolName: 'app.read_resource',
      featureId: 'app.resource.read',
      args: { resource: 'user' },
      title: '读取用户清单',
    });
  }
  if (/(?:读取|查看|核对)[^。；;！？!?\n]{0,64}角色卡[^。；;！？!?\n]{0,24}(?:清单|列表)/iu.test(text)) {
    add({
      key: 'resource:persona',
      kind: 'resource',
      resource: 'persona',
      auditPrefix,
      toolName: 'app.read_resource',
      featureId: 'app.resource.read',
      args: { resource: 'persona' },
      title: '读取角色卡清单',
    });
  }
  const profileSegment = text.match(/分别读取([^。；;！？!?\n]{1,480}?)的格式画像/iu)?.[1] || '';
  extractMaidQuotedValues(profileSegment).forEach((target) => {
    add({
      key: `format-profile:${normalizeText(target)}`,
      kind: 'format-profile',
      target,
      toolName: 'chat.read_format_profile',
      featureId: 'chat.format.profile',
      args: { sessionName: target },
      title: `读取「${target}」格式画像`,
    });
  });
  if (/(?:读取|查看|核对)\s*APP\s*状态/iu.test(text)) {
    add({
      key: 'app-state',
      kind: 'state',
      toolName: 'app.get_current_state',
      featureId: 'app.state.read',
      args: {},
      title: '读取 APP 状态',
    });
  }
  const hasTargetedIndex = obligations.some(item => item.kind === 'worldbook');
  const hasTargetedProfiles = obligations.some(item => item.kind === 'format-profile');
  return obligations.length >= 4 && (hasTargetedIndex || hasTargetedProfiles)
    ? obligations
    : [];
};

const resolveMaidStructuredWorldbookOutput = (obligation = {}, step = {}) => {
  const output = isPlainObject(step?.output) ? step.output : {};
  const toolName = trim(step?.toolName);
  if (toolName === 'worldbook.read') {
    const target = output?.name || output?.id || step?.args?.name || step?.args?.worldbookId || step?.args?.id;
    return normalizeText(target) === normalizeText(obligation.target) ? output : null;
  }
  if (
    toolName !== 'app.read_resource' ||
    trim(step?.args?.resource || output?.resource).toLowerCase() !== 'worldbook' ||
    normalizeText(step?.args?.name || step?.args?.worldbookId || step?.args?.id) !== normalizeText(obligation.target)
  ) return null;
  return (Array.isArray(output?.worldbooks) ? output.worldbooks : []).find(item => (
    normalizeText(item?.name || item?.id) === normalizeText(obligation.target) &&
    Array.isArray(item?.entries)
  )) || null;
};

const maidStructuredReadObligationMatchesStep = (obligation = {}, step = {}) => {
  if (step?.status !== 'succeeded') return false;
  if (obligation.kind === 'worldbook') {
    return Boolean(resolveMaidStructuredWorldbookOutput(obligation, step));
  }
  if (trim(step?.toolName) !== trim(obligation.toolName)) return false;
  if (obligation.kind === 'resource') {
    return trim(step?.output?.resource || step?.args?.resource).toLowerCase() === obligation.resource;
  }
  if (obligation.kind === 'format-profile') {
    return normalizeText(
      step?.output?.sessionId ||
      step?.output?.profile?.sessionId ||
      step?.args?.sessionName ||
      step?.args?.sessionId ||
      step?.args?.target,
    ) === normalizeText(obligation.target);
  }
  return true;
};

const summarizeMaidStructuredRead = (obligation = {}, output = {}, step = {}) => {
  if (obligation.kind === 'worldbook') {
    const worldbook = resolveMaidStructuredWorldbookOutput(obligation, {
      ...step,
      output,
    }) || output;
    const entries = Array.isArray(worldbook?.entries) ? worldbook.entries : [];
    const titles = entries
      .map(item => trim(item?.title || item?.comment || item?.name || item?.id))
      .filter(Boolean);
    const counts = new Map();
    titles.forEach(title => counts.set(normalizeText(title), (counts.get(normalizeText(title)) || 0) + 1));
    const duplicateCount = Array.from(counts.values()).reduce((total, count) => total + Math.max(0, count - 1), 0);
    const entryCount = Number.isFinite(Number(worldbook?.entryCount)) ? Number(worldbook.entryCount) : entries.length;
    return `世界书「${obligation.target}」：共 ${entryCount} 条；标题：${titles.join('、') || '未返回'}；重复项 ${duplicateCount}`;
  }
  if (obligation.kind === 'session-list') {
    const contacts = Array.isArray(output?.contacts) ? output.contacts : [];
    const count = Number.isFinite(Number(output?.count)) ? Number(output.count) : contacts.length;
    const names = contacts.map(item => trim(item?.name || item?.id)).filter(Boolean).slice(0, 12);
    const auditItems = trim(obligation.auditPrefix)
      ? contacts
          .map(item => trim(item?.name || item?.id))
          .filter(name => normalizeText(name).startsWith(normalizeText(obligation.auditPrefix)))
      : [];
    const auditCounts = new Map();
    auditItems.forEach(name => auditCounts.set(normalizeText(name), (auditCounts.get(normalizeText(name)) || 0) + 1));
    const duplicateCount = Array.from(auditCounts.values()).reduce(
      (total, itemCount) => total + Math.max(0, itemCount - 1),
      0,
    );
    return [
      `会话清单：共 ${count} 项${names.length ? `；本次返回：${names.join('、')}${contacts.length > names.length ? '…' : ''}` : ''}`,
      auditItems.length
        ? `前缀「${obligation.auditPrefix}」：${auditItems.length} 项；重复名称 ${duplicateCount}；${auditItems.join('、')}`
        : '',
    ].filter(Boolean).join('\n');
  }
  if (obligation.kind === 'resource') {
    const base = summarizeMaidReadResult(obligation.resource, output);
    const auditItems = trim(obligation.auditPrefix) && Array.isArray(output?.items)
      ? output.items.filter(item => (
          normalizeText(item?.name || item?.id).startsWith(normalizeText(obligation.auditPrefix))
        ))
      : [];
    const auditSummary = auditItems
      .map(item => `${trim(item?.name || item?.id)}（${item?.active === true ? 'active' : 'inactive'}）`)
      .join('、');
    return [base, auditSummary ? `审计项：${auditSummary}` : ''].filter(Boolean).join('\n');
  }
  if (obligation.kind === 'format-profile') {
    if (isPlainObject(output?.staleProfile) && !isPlainObject(output?.profile)) {
      const reasons = Array.isArray(output.staleProfile.staleReasons)
        ? output.staleProfile.staleReasons.map(trim).filter(Boolean).join('、')
        : '';
      return `格式画像「${obligation.target}」：已失效，需重新调查来源${reasons ? `（${reasons}）` : ''}`;
    }
    const profile = isPlainObject(output?.profile) ? output.profile : output;
    const guide = trim(profile?.guide, '未设置');
    const sources = (Array.isArray(profile?.sources) ? profile.sources : [])
      .map(item => [trim(item?.type), trim(item?.ref)].filter(Boolean).join(':'))
      .filter(Boolean);
    return `格式画像「${obligation.target}」：${guide}${sources.length ? `；来源 ${sources.join('、')}` : ''}`;
  }
  if (obligation.kind === 'state') return summarizeMaidReadResult('state', output);
  return '';
};

const buildMaidStructuredReadProgress = ({
  input = '',
  operationIntentPolicy = {},
  steps = [],
} = {}) => {
  const obligations = buildMaidStructuredReadObligations({ input, operationIntentPolicy });
  if (!obligations.length) return null;
  const sourceSteps = Array.isArray(steps) ? steps : [];
  if (sourceSteps.some(step => (
    step?.status !== 'succeeded' ||
    !obligations.some(obligation => maidStructuredReadObligationMatchesStep(obligation, step))
  ))) return null;
  const completed = obligations.map((obligation) => {
    const step = sourceSteps.find(candidate => maidStructuredReadObligationMatchesStep(obligation, candidate)) || null;
    return { obligation, step };
  });
  const pending = completed.find(item => !item.step)?.obligation || null;
  if (pending) {
    return {
      complete: false,
      nextPlan: {
        ok: true,
        action: 'tool',
        toolName: pending.toolName,
        args: clone(pending.args),
        featureId: pending.featureId,
        title: pending.title,
        response: pending.title,
        metadata: {
          workflowTransition: 'structured_read_remaining_target',
          obligationKey: pending.key,
        },
      },
    };
  }
  const lines = completed
    .map(({ obligation, step }) => summarizeMaidStructuredRead(obligation, step?.output || {}, step))
    .filter(Boolean);
  if (lines.length !== obligations.length) return null;
  return {
    complete: true,
    finalDecision: {
      ok: true,
      action: 'final',
      source: 'deterministic_structured_read_completion',
      message: lines.join('\n'),
    },
  };
};

const buildDeterministicMaidReadDecision = ({
  input = '',
  operationIntentPolicy = {},
  steps = [],
} = {}) => {
  if (
    operationIntentPolicy?.mode !== 'read_only' ||
    hasMaidInteractiveActionRequest(input) ||
    hasMaidDetailedReadRequest(input)
  ) return null;
  const requestedKeys = getRequestedMaidReadKeys(input);
  if (!requestedKeys.length) return null;
  const latestByKey = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (trim(step?.toolName) === 'maid.todo.write') continue;
    const key = getMaidReadStepKey(step);
    if (!key) return null;
    latestByKey.set(key, step.output || {});
  }
  if (!requestedKeys.every(key => latestByKey.has(key))) return null;
  const lines = requestedKeys
    .map(key => summarizeMaidReadResult(key, latestByKey.get(key)))
    .filter(Boolean);
  if (lines.length !== requestedKeys.length) return null;
  return {
    ok: true,
    action: 'final',
    source: 'deterministic_read_completion',
    message: lines.join('\n'),
  };
};

const isRepeatedSuccessfulTodoWrite = (plan = {}, steps = []) => {
  if (trim(plan?.toolName) !== 'maid.todo.write') return false;
  const argsKey = stableJsonStringify(plan?.args || {});
  return (Array.isArray(steps) ? steps : []).some(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'maid.todo.write' &&
    stableJsonStringify(step?.args || {}) === argsKey
  ));
};

const buildUnchangedTodoExecution = () => ({
  output: {
    toolName: 'maid.todo.write',
    status: 'failed',
    summary: 'todo list unchanged',
    errorCode: 'maid_todo_unchanged',
    result: {
      ok: false,
      reason: 'todo_unchanged',
      message: '清单没有变化；不要重复写入，请执行当前 in_progress 或 pending 项的具体工具。',
    },
  },
  guided: false,
  guide: null,
  message: '',
});

const MAID_MODEL_CALL_TIMEOUT_MS = 240_000;

// 模型请求可能无限挂起（API 端异常），包一层超时让 run 可失败、可继续，而不是永久 running。
const callModelWithTimeout = async (invoke, { timeoutMs = MAID_MODEL_CALL_TIMEOUT_MS, label = 'model_call' } = {}) => {
  let timer = null;
  try {
    return await Promise.race([
      invoke(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const formatMaidPromptText = (key, fallback, replacements = {}) => {
  let text = getLocalizedPromptText(key, fallback);
  Object.entries(replacements).forEach(([name, value]) => {
    text = text.split(`{${name}}`).join(String(value ?? ''));
  });
  return text;
};

export const buildContinueHint = ({
  input = '',
  pendingPlan = {},
  steps = [],
  reason = '',
} = {}) => {
  const list = Array.isArray(steps) ? steps : [];
  const lastStep = list.at(-1) || {};
  const pendingTool = trim(pendingPlan?.toolName);
  const lastTool = trim(lastStep.toolName);
  // 恢复轮凭模糊记忆汇报会把已成功项误报为未完成；附准确的已完成/失败清单。
  const summarizeStep = (step) => {
    const summary = trim(step?.summary).slice(0, 60);
    const tool = trim(
      step?.toolName,
      getLocalizedPromptText('maid.continue.unknown_tool', '未知工具'),
    );
    return summary
      ? formatMaidPromptText('maid.continue.step', '{tool}（{summary}）', { tool, summary })
      : tool;
  };
  const completed = list.filter(step => step?.status === 'succeeded').slice(-8).map(summarizeStep);
  const failed = list.filter(step => step?.status === 'failed').slice(-3).map(summarizeStep);
  const separator = getLocalizedPromptText('maid.continue.separator', '；');
  return [
    formatMaidPromptText('maid.continue.goal', '用户原始目标：{value}', { value: trim(input, '-') }),
    completed.length ? formatMaidPromptText(
      'maid.continue.completed',
      '已完成步骤（恢复后不要重复执行，也不要报告为未完成）：{value}',
      { value: completed.join(separator) },
    ) : '',
    failed.length ? formatMaidPromptText('maid.continue.failed', '失败步骤：{value}', {
      value: failed.join(separator),
    }) : '',
    lastTool ? formatMaidPromptText('maid.continue.last_tool', '上一轮最后执行工具：{value}', { value: lastTool }) : '',
    pendingTool ? formatMaidPromptText('maid.continue.next_tool', '下一步建议工具：{value}', { value: pendingTool }) : '',
    reason ? formatMaidPromptText('maid.continue.reason', '中断原因：{value}', { value: reason }) : '',
    getLocalizedPromptText(
      'maid.continue.instruction',
      '用户说“继续”时，应基于本轮历史继续执行、验证和修正，不要改成普通闲聊。',
    ),
  ].filter(Boolean).join('\n');
};

const isContinuableReactStop = (reason = '') => {
  const normalized = trim(reason);
  return [
    'max_steps_reached',
    'invalid_model_plan',
    'feature_not_found',
    'tool_not_allowed',
    'invalid_model_react_decision',
    'missing_final_message',
    'invalid_react_action',
  ].includes(normalized);
};

const shouldAttemptReactPlanRecovery = ({
  input = '',
  plan = {},
  reactPlanner = null,
} = {}) => {
  if (typeof reactPlanner !== 'function' || !trim(input)) return false;
  const reason = trim(plan?.reason);
  if ([
    'invalid_model_plan',
    'feature_not_found',
    'tool_not_allowed',
    'invalid_model_react_decision',
    'missing_final_message',
    'invalid_react_action',
  ].includes(reason)) return true;
  const text = compactText(input);
  if (!text) return false;
  if (/^(继续|请继续|好的|好|是的|对|没错|确认|允许|可以|再试一次|重试)$/u.test(text)) return true;
  return /(刚失败|失败了|没生效|没有生效|没有更新|再试|重试|继续|确认|替换成|扩展版|重新)/u.test(text);
};

// 解析目录 verification.argsFrom 的取值路径，如 'result.worldbookId|args.name'。
const resolveVerificationValue = (spec = '', { result = {}, args = {} } = {}) => {
  for (const path of String(spec || '').split('|')) {
    const segments = path.trim().split('.');
    const root = segments.shift();
    let node = root === 'result' ? result : (root === 'args' ? args : undefined);
    for (const key of segments) {
      node = isPlainObject(node) ? node[key] : undefined;
    }
    const value = trim(node);
    if (value) return value;
  }
  return '';
};

// 按目录声明的 verification 元数据构建读回验证计划；worldbook 写入有专用分支
// （按条目数决定是否读回正文），其余写工具走这里。
const buildCatalogVerificationPlan = (plan = {}, result = {}) => {
  const feature = findAppFeature(trim(plan?.featureId) || trim(plan?.toolName));
  const verification = feature?.verification;
  if (!verification?.tool) return null;
  const args = isPlainObject(verification.args) ? clone(verification.args) : {};
  const required = Array.isArray(verification.requiredArgs) ? verification.requiredArgs : [];
  for (const [key, spec] of Object.entries(verification.argsFrom || {})) {
    const value = resolveVerificationValue(spec, { result, args: plan?.args || {} });
    if (value) args[key] = value;
    else if (required.includes(key)) return null;
  }
  return {
    ok: true,
    action: 'tool',
    toolName: verification.tool,
    args,
    featureId: trim(feature.id),
    title: '验证执行结果',
    response: '我再读回确认一下结果。',
    metadata: {
      verificationFor: trim(plan?.toolName),
      verificationSuccess: trim(verification.success),
    },
    source: 'auto_verification',
  };
};

const buildAutoVerificationPlan = (plan = {}, output = {}) => {
  const toolName = trim(plan?.toolName);
  if (trim(plan?.metadata?.verificationFor) || plan?.metadata?.skipAutoVerification === true) return null;
  const result = unwrapToolOutputResult(output);
  if (!isPlainObject(result) || result.ok === false) return null;
  if (result.reusedVerifiedAction === true) return null;
  if (toolName === 'worldbook.create' || toolName === 'worldbook.update_entries' || toolName === 'worldbook.delete_entries') {
    const worldbookName = trim(result.worldbookId || plan?.args?.worldbookId || plan?.args?.name || plan?.args?.id);
    if (!worldbookName) return null;
    const entryCount = Number(result.entryCount || 0) || 0;
    const touchedCount = Number(result.updatedEntryCount || 0) + Number(result.createdEntryCount || result.addedEntryCount || 0);
    const includeContent = entryCount > 0 && entryCount <= 6 && touchedCount <= 3;
    return {
      ok: true,
      action: 'tool',
      toolName: 'worldbook.read',
      args: {
        name: worldbookName,
        maxEntries: includeContent ? 10 : 80,
        includeContent,
        ...(includeContent ? { maxContentLength: 4000 } : {}),
      },
      featureId: 'worldbook.read',
      title: '验证世界书内容',
      response: '我再读回世界书确认是否已经保存。',
      metadata: {
        verificationFor: toolName,
      },
      source: 'auto_verification',
    };
  }
  return buildCatalogVerificationPlan(plan, result);
};

const resolveCrossRunResumePlan = ({
  plan = {},
  continuation = null,
  steps = [],
} = {}) => {
  if (!isPlainObject(continuation) || !trim(plan?.toolName)) return null;
  const previous = findMaidRunContinuationSuccess(
    continuation,
    plan.toolName,
    isPlainObject(plan?.args) ? plan.args : {},
  );
  if (!previous || !Array.isArray(previous.resourceRefs) || !previous.resourceRefs.length) return null;
  const priorVerification = (Array.isArray(steps) ? steps : []).findLast(step => (
    trim(step?.metadata?.crossRunArgsDigest) === previous.argsDigest &&
    trim(step?.metadata?.crossRunSourceRunId) === trim(continuation.sourceRunId)
  ));
  if (priorVerification) {
    return maidContinuationRefsExistInOutput(previous.resourceRefs, priorVerification.output)
      ? { status: 'verified', previous, verificationStep: priorVerification }
      : { status: 'missing', previous, verificationStep: priorVerification };
  }
  const verificationPlan = buildAutoVerificationPlan(plan, {
    status: 'succeeded',
    result: previous.result || {},
  });
  if (!verificationPlan) return null;
  return {
    status: 'verify',
    previous,
    verificationPlan: {
      ...verificationPlan,
      source: 'cross_run_resume_verification',
      response: '我先按上一轮保存的稳定 ID 复验资源，确认仍存在后再继续。',
      metadata: {
        ...(isPlainObject(verificationPlan.metadata) ? verificationPlan.metadata : {}),
        crossRunArgsDigest: previous.argsDigest,
        crossRunSourceRunId: trim(continuation.sourceRunId),
        expectedResourceRefs: clone(previous.resourceRefs),
      },
    },
  };
};

const buildReusedCrossRunExecution = (match = {}) => ({
  output: {
    toolName: trim(match?.previous?.toolName),
    status: 'succeeded',
    result: {
      ...(isPlainObject(match?.previous?.result) ? clone(match.previous.result) : {}),
      ok: true,
      reusedVerifiedAction: true,
      localToolExecutionSkipped: true,
      reason: 'cross_run_action_already_verified',
      message: '上一轮的同一写动作已按稳定 ID 复验仍然有效；本次没有重复执行。',
    },
    summary: 'cross-run action already exists and was verified; duplicate execution skipped',
  },
  guided: false,
  guide: null,
  message: '',
});

const normalizeEntryTitle = (entry = {}) => compactText(
  entry?.entryTitle ||
  entry?.title ||
  entry?.comment ||
  entry?.name ||
  entry?.id ||
  ''
);

const extractEntryTitleSet = (entries = []) => new Set(
  (Array.isArray(entries) ? entries : [])
    .map(entry => normalizeEntryTitle(entry))
    .filter(Boolean)
);

const sameWorldbookTarget = (a = '', b = '') => {
  const left = compactText(a);
  const right = compactText(b);
  return Boolean(left && right && left === right);
};

const hasVerifiedWorldbookAfterStep = (steps = [], index = -1, worldbookId = '', minEntryCount = 0) => (
  (Array.isArray(steps) ? steps : [])
    .slice(Math.max(0, index + 1))
    .some(step => (
      step?.toolName === 'worldbook.read' &&
      step?.status === 'succeeded' &&
      sameWorldbookTarget(
        step?.output?.id || step?.output?.name || step?.args?.name || step?.args?.worldbookId,
        worldbookId,
      ) &&
      Number(step?.output?.entryCount || 0) >= Number(minEntryCount || 0)
    ))
);

const shouldStopDuplicateWorldbookWriteAfterVerification = (decision = {}, steps = []) => {
  const toolName = trim(decision?.toolName);
  if (!['worldbook.create', 'worldbook.update_entries'].includes(toolName)) return false;
  const args = isPlainObject(decision?.args) ? decision.args : {};
  const targetName = trim(args.name || args.worldbookId || args.id);
  if (!targetName) return false;
  const nextTitles = extractEntryTitleSet(toolName === 'worldbook.create' ? args.entries : args.updates);
  if (!nextTitles.size) return false;
  const list = Array.isArray(steps) ? steps : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const step = list[index];
    if (step?.toolName !== toolName || step?.status !== 'succeeded') continue;
    const output = step.output || {};
    const previousTarget = trim(output.worldbookId || output.name || step.args?.name || step.args?.worldbookId || step.args?.id);
    if (!sameWorldbookTarget(previousTarget, targetName)) continue;
    const previousTitles = extractEntryTitleSet(toolName === 'worldbook.create' ? step.args?.entries : step.args?.updates);
    if (!previousTitles.size) continue;
    const allAlreadyWritten = Array.from(nextTitles).every(title => previousTitles.has(title));
    if (!allAlreadyWritten) continue;
    const minEntryCount = Number(output.entryCount || 0) || previousTitles.size;
    if (hasVerifiedWorldbookAfterStep(list, index, previousTarget, minEntryCount)) return true;
  }
  return false;
};

const getSessionCreateTargets = (args = {}) => (
  Array.from(new Set([
    ...(Array.isArray(args?.names) ? args.names : [args?.names])
      .map(value => trim(value))
      .filter(Boolean),
    trim(args?.name),
  ].filter(Boolean))).sort((left, right) => left.localeCompare(right))
);

const hasSameSessionCreateTargets = (left = [], right = []) => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

const findVerifiedIdempotentSessionCreate = (plan = {}, steps = []) => {
  if (trim(plan?.toolName) !== 'session.create') return null;
  const targets = getSessionCreateTargets(plan?.args);
  if (!targets.length) return null;
  const source = Array.isArray(steps) ? steps : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const step = source[index];
    if (step?.status !== 'succeeded' || trim(step?.toolName) !== 'session.create') continue;
    if (!hasSameSessionCreateTargets(getSessionCreateTargets(step?.args), targets)) continue;
    const returnedIds = new Set([
      ...(Array.isArray(step?.output?.sessionIds) ? step.output.sessionIds : [step?.output?.sessionIds])
        .map(value => trim(value))
        .filter(Boolean),
      ...(Array.isArray(step?.output?.sessions) ? step.output.sessions : [])
        .map(item => trim(item?.sessionId || item?.id || item?.name))
        .filter(Boolean),
    ]);
    if (!targets.every(target => returnedIds.has(target))) continue;
    const verification = source.slice(index + 1).find(candidate => (
      candidate?.status === 'succeeded' &&
      trim(candidate?.toolName) === 'session.list' &&
      trim(candidate?.metadata?.verificationFor) === 'session.create' &&
      targets.every(target => (
        (Array.isArray(candidate?.output?.contacts) ? candidate.output.contacts : [])
          .some(contact => [contact?.id, contact?.name].map(value => trim(value)).includes(target))
      ))
    ));
    if (verification) {
      return {
        targets,
        createStep: step,
        verificationStep: verification,
      };
    }
  }
  return null;
};

const buildReusedSessionCreateExecution = (match = {}) => ({
  output: {
    toolName: 'session.create',
    status: 'succeeded',
    result: {
      ok: true,
      created: false,
      createdCount: Number(match?.createStep?.output?.createdCount || 0) || 0,
      sessionIds: clone(match?.targets || []),
      reusedVerifiedAction: true,
      localToolExecutionSkipped: true,
      reason: 'duplicate_idempotent_action_skipped',
      message: '同一组聊天室已在本轮完成幂等创建并通过 session.list 验证；本次重复调用未执行，请继续下一个未完成目标。',
    },
    summary: 'session.create already completed and verified; duplicate execution skipped',
  },
  guided: false,
  guide: null,
  message: '',
});

const GENERATED_MEDIA_QUANTITY_MAP = Object.freeze({
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

const GENERATED_MEDIA_PURPOSE_ALIASES = Object.freeze({
  avatar: ['头像', '頭像', 'avatar', 'profile picture'],
  wallpaper: ['壁纸', '壁紙', '聊天室背景', '聊天背景', 'wallpaper', 'background image'],
});

const listGeneratedMediaPurposeMatches = (clause = '', purpose = '') => {
  const text = String(clause || '').toLowerCase();
  const aliases = GENERATED_MEDIA_PURPOSE_ALIASES[purpose] || [];
  const matches = [];
  aliases.forEach(alias => {
    const needle = String(alias || '').toLowerCase();
    let index = text.indexOf(needle);
    while (needle && index >= 0) {
      matches.push(index);
      index = text.indexOf(needle, index + needle.length);
    }
  });
  return matches;
};

const resolveGeneratedMediaTargetQuota = (input = '', args = {}) => {
  const normalized = stripNegatedMaidActionClauses(
    String(input ?? '').normalize('NFKC'),
  );
  const purpose = trim(args?.purpose).toLowerCase();
  const targetKey = normalizeText(args?.target || args?.subject);
  const clauses = normalized
    .split(/(?:[，,。；;！？!?\n]+|然后|随后|接着|看完(?:之后|以后|后)?|再(?=(?:来|生成|画|绘|制作|做|换)))/gu)
    .map(value => trim(value))
    .filter(Boolean);
  const sourceClauses = clauses.length ? clauses : [normalized];
  const hasTargetMention = Boolean(
    targetKey && sourceClauses.some(clause => normalizeText(clause).includes(targetKey)),
  );
  const hasPurposeMention = sourceClauses.some(clause => (
    listGeneratedMediaPurposeMatches(clause, purpose).length > 0
  ));
  let quota = 1;
  let relevantActionCount = 0;
  let targetActive = !hasTargetMention;
  let purposeActive = !hasPurposeMention;

  for (const clause of sourceClauses) {
    const clauseKey = normalizeText(clause);
    const mentionsTarget = Boolean(targetKey && clauseKey.includes(targetKey));
    const directedTarget = clause.match(
      /(?:给|为|替)\s*([^，,。；;！？!?\n]{1,40}?)(?=(?:生成|画(?!风)|绘制|制作|做|重画|重绘|换))/u,
    );
    if (mentionsTarget) {
      targetActive = true;
    } else if (hasTargetMention && directedTarget) {
      targetActive = false;
    }

    const currentPurposeMatches = listGeneratedMediaPurposeMatches(clause, purpose);
    const otherPurposeMatches = Object.keys(GENERATED_MEDIA_PURPOSE_ALIASES)
      .filter(candidate => candidate !== purpose)
      .flatMap(candidate => listGeneratedMediaPurposeMatches(clause, candidate));
    if (currentPurposeMatches.length) {
      purposeActive = true;
    } else if (hasPurposeMention && otherPurposeMatches.length) {
      purposeActive = false;
    }
    if (!targetActive || !purposeActive) continue;
    const hasGenerationAction = /(?:生成|画(?!风)|绘制|制作|做图|重(?:新)?生成|重画|重绘|再画|来一张|换(?:掉|成|一张)?)/u.test(clause);
    const hasBareVariant = Array.from(clause.matchAll(/另(?:一|1)(?:张|幅)/gu)).some((match) => {
      const index = Number(match.index || 0);
      const beforeVariant = clause.slice(Math.max(0, index - 18), index);
      const afterVariant = clause.slice(index + match[0].length, index + match[0].length + 12);
      if (/(?:画风|风格)?参考(?:图|图片|素材|附件)?(?:的)?\s*$/u.test(beforeVariant)) return false;
      return !/^[^，,。；;！？!?\n]{0,12}(?:画风|风格)?参考/u.test(afterVariant);
    })
      || /另一个版本/u.test(clause);
    if (!hasGenerationAction && !hasBareVariant) {
      continue;
    }

    relevantActionCount += 1;
    const purposePositions = currentPurposeMatches.map(index => ({ index, current: true }))
      .concat(otherPurposeMatches.map(index => ({ index, current: false })));
    for (const match of clause.matchAll(/([1-9一两二三四五六七八九])\s*(?:张|幅|个)/gu)) {
      const quantityIndex = Number(match.index || 0);
      const beforeQuantity = clause.slice(Math.max(0, quantityIndex - 16), quantityIndex);
      const afterQuantity = clause.slice(quantityIndex + match[0].length, quantityIndex + match[0].length + 16);
      if (
        /(?:画风|风格)?参考(?:图|图片|素材)?\s*$/u.test(beforeQuantity)
        || /^\s*(?:画风|风格)?参考(?:图|图片|素材)?/u.test(afterQuantity)
      ) {
        continue;
      }
      const quantity = Number(match[1]) || GENERATED_MEDIA_QUANTITY_MAP[match[1]] || 1;
      if (!purposePositions.length || !otherPurposeMatches.length) {
        quota = Math.max(quota, quantity);
        continue;
      }
      const nearest = purposePositions
        .slice()
        .sort((left, right) => Math.abs(left.index - quantityIndex) - Math.abs(right.index - quantityIndex))[0];
      if (nearest?.current) quota = Math.max(quota, quantity);
    }
    if (/(?:多张|几张|多个版本|多种方案|候选图|候选图片)/u.test(clause)) {
      quota = Math.max(quota, 2);
    }
  }
  return Math.max(quota, relevantActionCount);
};

const getGeneratedMediaKey = (args = {}) => {
  const target = normalizeText(args?.target || args?.subject);
  const purpose = trim(args?.purpose).toLowerCase();
  return target && purpose ? `${target}:${purpose}` : '';
};

const getGeneratedMediaWriteTools = (purpose = '') => {
  if (purpose === 'avatar') return new Set(['contact.set_avatar', 'persona.set_avatar']);
  if (purpose === 'wallpaper') return new Set(['session.set_wallpaper']);
  return new Set();
};

const findAppliedGeneratedMedia = ({
  input = '',
  plan = {},
  steps = [],
} = {}) => {
  if (trim(plan?.toolName) !== 'media.generate_image') return null;
  const key = getGeneratedMediaKey(plan?.args);
  const purpose = trim(plan?.args?.purpose).toLowerCase();
  const writeTools = getGeneratedMediaWriteTools(purpose);
  if (!key || !writeTools.size) return null;
  const source = Array.isArray(steps) ? steps : [];
  const targetQuota = resolveGeneratedMediaTargetQuota(input, plan.args);
  const appliedMatches = [];
  const appliedAttachmentIds = new Set();
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const generatedStep = source[index];
    if (
      generatedStep?.status !== 'succeeded' ||
      trim(generatedStep?.toolName) !== 'media.generate_image' ||
      getGeneratedMediaKey(generatedStep?.args) !== key
    ) continue;
    const attachmentId = trim(generatedStep?.output?.attachmentId);
    if (!attachmentId) continue;
    const appliedStep = source.slice(index + 1).find(step => (
      step?.status === 'succeeded' &&
      writeTools.has(trim(step?.toolName)) &&
      trim(step?.args?.attachmentId) === attachmentId
    ));
    if (appliedStep && !appliedAttachmentIds.has(attachmentId)) {
      appliedAttachmentIds.add(attachmentId);
      appliedMatches.push({ generatedStep, appliedStep, attachmentId });
    }
  }
  if (appliedMatches.length < targetQuota) return null;
  return {
    ...appliedMatches[0],
    appliedCount: appliedMatches.length,
    targetQuota,
  };
};

const buildReusedGeneratedMediaExecution = (match = {}) => ({
  output: {
    toolName: 'media.generate_image',
    status: 'succeeded',
    result: {
      ...(isPlainObject(match?.generatedStep?.output) ? clone(match.generatedStep.output) : {}),
      ok: true,
      attachmentId: trim(match?.attachmentId),
      reusedVerifiedAction: true,
      localToolExecutionSkipped: true,
      alreadyApplied: true,
      appliedByTool: trim(match?.appliedStep?.toolName),
      appliedVariantCount: Number(match?.appliedCount || 0),
      requestedVariantQuota: Number(match?.targetQuota || 1),
      reason: 'generated_media_already_applied',
      message: '同一对象与用途已完成用户要求的图片数量并成功写回；本次未重复产生计费生图调用，请继续下一个未完成目标。',
    },
    summary: 'generated media already applied; duplicate billed generation skipped',
  },
  guided: false,
  guide: null,
  message: '',
});

const getWorldbookBatchBindingKey = (args = {}) => stableJsonStringify({
  worldbookId: trim(args?.worldbookId || args?.name || args?.id),
  sessions: (Array.isArray(args?.sessions) ? args.sessions : [])
    .map(value => trim(value))
    .filter(Boolean),
  mode: trim(args?.mode, 'append') === 'replace' ? 'replace' : 'append',
});

const hasExplicitWorldbookPreviewApplyRequest = (input = '') => {
  const text = stripNegatedMaidActionClauses(String(input ?? '').normalize('NFKC'));
  return /(?:preview|预览)/iu.test(text) && (
    /(?:实际|正式)(?:执行|应用)/iu.test(text) ||
    /预览[^。；;！？!?\n]{0,80}(?:再|然后|随后)[^。；;！？!?\n]{0,40}(?:执行|应用|绑定)/iu.test(text)
  );
};

const advanceRepeatedWorldbookPreviewToApply = ({
  input = '',
  plan = {},
  steps = [],
  operationIntentPolicy = {},
} = {}) => {
  if (
    trim(plan?.toolName) !== 'worldbook.bind_sessions' ||
    plan?.args?.preview !== true ||
    operationIntentPolicy?.mode !== 'write_allowed' ||
    !hasExplicitWorldbookPreviewApplyRequest(input)
  ) return plan;
  const key = getWorldbookBatchBindingKey(plan.args);
  const previewStep = (Array.isArray(steps) ? steps : []).findLast(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'worldbook.bind_sessions' &&
    step?.args?.preview === true &&
    getWorldbookBatchBindingKey(step.args) === key &&
    step?.output?.preview === true &&
    Number(step?.output?.failedCount || 0) === 0 &&
    Number(step?.output?.plannedCount || 0) > 0
  ));
  if (!previewStep) return plan;
  return {
    ...plan,
    args: {
      ...(isPlainObject(plan.args) ? plan.args : {}),
      preview: false,
    },
    metadata: {
      ...(isPlainObject(plan.metadata) ? plan.metadata : {}),
      workflowTransition: 'preview_to_apply',
      previewStepIndex: Number(previewStep.index || 0) || undefined,
    },
    title: trim(plan.title, '执行批量绑定'),
    response: trim(plan.response, '预览已确认可处理，继续实际执行绑定。'),
  };
};

const buildPendingWorldbookPreviewApplyPlan = ({
  input = '',
  steps = [],
  decision = {},
  operationIntentPolicy = {},
} = {}) => {
  if (
    operationIntentPolicy?.mode !== 'write_allowed' ||
    !hasExplicitWorldbookPreviewApplyRequest(input)
  ) return null;
  const source = Array.isArray(steps) ? steps : [];
  const previewStep = source.findLast(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'worldbook.bind_sessions' &&
    step?.args?.preview === true &&
    step?.output?.preview === true &&
    Number(step?.output?.failedCount || 0) === 0 &&
    Number(step?.output?.plannedCount || 0) > 0
  ));
  if (!previewStep) return null;
  const key = getWorldbookBatchBindingKey(previewStep.args);
  const alreadyApplied = source.some(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'worldbook.bind_sessions' &&
    step?.args?.preview !== true &&
    getWorldbookBatchBindingKey(step.args) === key &&
    step?.output?.preview !== true &&
    Number(step?.output?.failedCount || 0) === 0
  ));
  if (alreadyApplied) return null;
  return {
    ok: true,
    action: 'tool',
    toolName: 'worldbook.bind_sessions',
    args: {
      ...(isPlainObject(previewStep.args) ? clone(previewStep.args) : {}),
      preview: false,
    },
    featureId: 'worldbook.bind_sessions',
    title: '执行已通过预览的批量绑定',
    response: '预览全部可处理，继续实际执行绑定。',
    metadata: {
      workflowTransition: 'preview_to_apply',
      previewStepIndex: Number(previewStep.index || 0) || undefined,
    },
    candidateSnapshotId: trim(decision?.candidateSnapshotId),
    retrieverVersion: trim(decision?.retrieverVersion),
    capabilityRoutingMode: trim(decision?.capabilityRoutingMode),
  };
};

const hasExplicitWorldbookTailReadReveal = (input = '') => {
  const text = stripNegatedMaidActionClauses(String(input ?? '').normalize('NFKC'));
  return /(?:读出来给我看|读给我看|把[^。；;！？!?\n]{0,60}读出来|展示给我看|显示给我看|列出来给我看|让我看看|给我看(?:一下)?)/iu.test(text);
};

const findVerifiedWorldbookBindingForTailRead = (decision = {}, steps = [], input = '') => {
  const toolName = trim(decision?.toolName);
  const args = isPlainObject(decision?.args) ? decision.args : {};
  if (hasExplicitWorldbookTailReadReveal(input)) return null;
  const include = (Array.isArray(args.include) ? args.include : [])
    .map(value => trim(value).toLowerCase())
    .filter(Boolean);
  const isSessionWorldbookRead = toolName === 'app.read_resource' &&
    trim(args.resource).toLowerCase() === 'session' &&
    include.length === 1 &&
    include[0] === 'worldbooks';
  const isWorldbookListRead = toolName === 'worldbook.list';
  if (!isSessionWorldbookRead && !isWorldbookListRead) return null;
  const readTarget = trim(args.sessionId || args.sessionName || args.target || args.chatName);
  if (!readTarget) return null;
  const source = Array.isArray(steps) ? steps : [];

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const step = source[index];
    if (step?.status !== 'succeeded') continue;
    if (trim(step?.toolName) === 'worldbook.bind_session') {
      const target = trim(step?.output?.sessionId || step?.args?.sessionId || step?.args?.sessionName);
      if (target !== readTarget) continue;
      const verified = source.slice(index + 1).some(candidate => (
        candidate?.status === 'succeeded' &&
        trim(candidate?.toolName) === 'worldbook.list' &&
        trim(candidate?.metadata?.verificationFor) === 'worldbook.bind_session' &&
        trim(candidate?.args?.sessionId || candidate?.args?.sessionName) === target
      ));
      if (verified) return { step, target };
      continue;
    }
    if (
      trim(step?.toolName) === 'worldbook.bind_sessions' &&
      step?.args?.preview !== true &&
      step?.output?.preview !== true
    ) {
      const targets = (Array.isArray(step?.args?.sessions) ? step.args.sessions : [])
        .map(value => trim(value))
        .filter(Boolean);
      const succeededCount = Number(step?.output?.succeededCount || 0);
      const verifiedCount = Number(step?.output?.verifiedCount || 0);
      const failedCount = Number(step?.output?.failedCount || 0);
      if (
        targets.includes(readTarget) &&
        succeededCount > 0 &&
        verifiedCount >= succeededCount &&
        failedCount === 0
      ) {
        return { step, target: readTarget };
      }
    }
  }
  return null;
};

const buildReactStepSnapshot = ({
  index = 0,
  plan = {},
  execution = {},
  output = {},
  ok = false,
} = {}) => {
  const cancelled = isToolOutputCancelled(output);
  return {
    index,
    toolName: trim(plan?.toolName),
    featureId: trim(plan?.featureId),
    title: trim(plan?.title),
    args: clone(plan?.args || {}),
    status: cancelled ? 'cancelled' : (ok ? 'succeeded' : 'failed'),
    guided: Boolean(execution?.guided),
    guide: clone(execution?.guide || null),
    guideMessage: trim(execution?.message),
    summary: trim(output?.summary),
    output: clone(unwrapToolOutputResult(output)),
    metadata: clone(plan?.metadata || null),
    ...buildCapabilityPlanTrace(plan),
    errorMessage: cancelled ? '' : trim(output?.errorMessage || (!ok ? summarizeToolFailure(output) : '')),
    failureCode: (!ok || cancelled) ? classifyMaidToolFailure({
      errorCode: output?.errorCode,
      message: output?.errorMessage || summarizeToolFailure(output),
      result: unwrapToolOutputResult(output),
    }) : '',
  };
};

const getObservationCharacterCount = (value) => {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
};

const getDataUrlMediaType = (value = '') => {
  const match = String(value || '').match(/^data:([^;,]+)[;,]/iu);
  return trim(match?.[1], 'application/octet-stream');
};

const projectFullPersonaObservationForModel = (output = {}) => {
  const omittedFields = [];
  const projectedItems = (Array.isArray(output?.items) ? output.items : []).map((item, index) => {
    if (!isPlainObject(item)) return clone(item);
    const projected = {};
    // 结构化身份与绑定事实放在正文前，避免尾部截断时再次丢失 worldbookId 等关键引用。
    ['id', 'name', 'active', 'source'].forEach((key) => {
      if (Object.hasOwn(item, key)) projected[key] = clone(item[key]);
    });
    Object.entries(item).forEach(([key, value]) => {
      if (Object.hasOwn(projected, key)) return;
      if (key === 'avatar' && /^data:/iu.test(trim(value))) {
        omittedFields.push({
          path: `items[${index}].avatar`,
          kind: 'inline_binary',
          mediaType: getDataUrlMediaType(value),
          characterCount: getObservationCharacterCount(value),
        });
        return;
      }
      if (key === 'originalCard' && value !== null && value !== undefined) {
        omittedFields.push({
          path: `items[${index}].originalCard`,
          kind: 'embedded_resource',
          characterCount: getObservationCharacterCount(value),
        });
        return;
      }
      projected[key] = clone(value);
    });
    return projected;
  });
  const projected = {
    ...clone(output),
    items: projectedItems,
  };
  if (omittedFields.length) {
    projected.observationProjection = {
      kind: 'maid_model',
      omittedFields,
    };
  }
  return projected;
};

const projectMaidReactStepsForModel = (steps = []) => (
  (Array.isArray(steps) ? steps : []).map((step) => {
    const projected = clone(step);
    if (
      trim(projected?.toolName) === 'app.read_resource' &&
      trim(projected?.output?.resource).toLowerCase() === 'persona' &&
      trim(projected?.output?.projection).toLowerCase() === 'full'
    ) {
      projected.output = projectFullPersonaObservationForModel(projected.output);
    }
    return projected;
  })
);

const buildSuccessMessage = ({ plan = {}, output = {}, execution = {} } = {}) => {
  const guideMessage = trim(execution?.message);
  const result = unwrapToolOutputResult(output);
  if (result?.requestTriggered === true && plan?.toolName === 'chat.send_message') {
    const target = trim(result.sessionName || result.sessionId);
    return target ? `已发送给「${target}」，联系人正在回复。` : '已发送，联系人正在回复。';
  }
  const actionMessage = trim(plan.response || output?.summary || '已完成。');
  return [guideMessage, actionMessage]
    .filter(Boolean)
    .join(' ');
};

const buildInterruptedMessage = ({ decision = {}, plan = {}, output = {}, execution = {}, fallback = '' } = {}) => {
  const actionMessage = buildSuccessMessage({ plan, output, execution });
  const reason = trim(decision?.message || decision?.reason || fallback, '女仆没有完成后续整理。');
  return [
    actionMessage ? `已执行：${actionMessage}` : '',
    `但这轮女仆没有完成最终回答：${reason}`,
  ].filter(Boolean).join('\n');
};

const stripTrailingPunctuation = value => trim(value)
  .replace(/[。.!！?？,，;；:：\s]+$/g, '')
  .trim();

const extractQuotedName = (text = '') => {
  const raw = String(text || '');
  const patterns = [
    /[叫名为為]\s*[「『“"']([^」』”"']{1,80})[」』”"']/,
    /[「『“"']([^」』”"']{1,80})[」』”"']/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return stripTrailingPunctuation(match[1]);
  }
  return '';
};

const extractSessionName = (text = '') => {
  const quoted = extractQuotedName(text);
  if (quoted) return quoted;
  const raw = String(text || '').trim();
  const patterns = [
    /(?:创建|新建|新增|添加|开)(?:一个|一個)?(?:叫|名为|名為)?\s*([^，。,.!?！？]{1,80}?)(?:的)?(?:聊天室|会话|好友|联系人)/,
    /(?:创建|新建|新增|添加|开)(?:一个|一個)?(?:聊天室|会话|好友|联系人)\s*([^，。,.!?！？]{1,80})/,
    /(?:聊天室|会话|好友|联系人)(?:叫|名为|名為)?\s*([^，。,.!?！？]{1,80})/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = stripTrailingPunctuation(match?.[1] || '');
    if (!value) continue;
    const cleaned = value
      .replace(/^(一个|一個|叫|名为|名為)\s*/u, '')
      .replace(/\s*(吧|一下|并打开|並打開|打开|進入|进入)$/u, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
};

const extractSessionNames = (text = '') => {
  const raw = String(text || '').trim();
  const quoted = Array.from(raw.matchAll(/[「『“"']([^」』”"']{1,80})[」』”"']/g))
    .map(match => stripTrailingPunctuation(match?.[1] || ''))
    .filter(Boolean);
  if (quoted.length > 1) return Array.from(new Set(quoted)).slice(0, 20);
  const explicitlyMultiple = /(?:两个|兩個|多个|多個|一些|几个|幾個|[2-9]\d*\s*[个個])\s*(?:聊天室|会话|好友|联系人)/u.test(raw);
  if (quoted.length === 1 && !explicitlyMultiple) return quoted;
  const patterns = [
    /(?:创建|新建|新增|添加|开)(?:\s*(?:两个|兩個|多个|多個|一些|几个|幾個|\d+\s*个))?(?:聊天室|会话|好友|联系人)[，,：:\s]*(.{1,180})/u,
    /(?:聊天室|会话|好友|联系人)[，,：:\s]*(.{1,180})/u,
  ];
  let source = '';
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      source = match[1];
      break;
    }
  }
  if (!source) return [];
  source = source
    .replace(/^(分别|分別|为|為|叫|名为|名為)\s*/u, '')
    .replace(/\s*(的|吧|一下|并打开|並打開|打开|進入|进入)$/u, '')
    .trim();
  const names = source
    .split(/(?:和|与|及|以及|、|，|,|；|;|\s+and\s+)/iu)
    .map(item => stripTrailingPunctuation(item)
      .replace(/^(一个|一個|两个|兩個|多个|多個|聊天室|会话|好友|联系人)\s*/u, '')
      .replace(/\s*(的|聊天室|会话|好友|联系人)$/u, '')
      .trim())
    .filter(item => item && !/^(两个|兩個|多个|多個|聊天室|会话|好友|联系人)$/.test(item));
  return Array.from(new Set(names)).slice(0, 20);
};

const extractQuotedAfter = (text = '', keywords = []) => {
  const raw = String(text || '');
  for (const keyword of keywords) {
    const index = raw.indexOf(keyword);
    if (index < 0) continue;
    const value = extractQuotedName(raw.slice(index));
    if (value) return value;
  }
  return '';
};

const extractNamedTarget = (text = '', keywords = [], fallback = '') => (
  extractQuotedAfter(text, keywords) || extractQuotedName(text) || fallback
);

const extractChatMessageContent = (text = '') => {
  const quoted = extractQuotedAfter(text, ['消息', '内容', '发送', '发']);
  if (quoted) return quoted;
  const raw = String(text || '').trim();
  const match = raw.match(/(?:发送|发)(?:消息)?\s*([^，。,.!?！？]{1,120})/);
  const value = stripTrailingPunctuation(match?.[1] || '')
    .replace(/^(一)?(个|条|点|句)\s*/u, '');
  if (value && value !== '消息' && !/(到|给|至)?(?:聊天室|会话)/.test(value)) return value;
  if (/晚上好/i.test(raw)) return '晚上好';
  if (/\bhi\b/i.test(raw)) return 'hi';
  return '';
};

const extractWorldEntries = (text = '') => {
  const raw = String(text || '');
  const entries = [];
  const pattern = /条目\s*[「『“"']([^」』”"']{1,80})[」』”"'][^「『“"']{0,24}[「『“"']([^」』”"']{1,2000})[」』”"']/g;
  let match = pattern.exec(raw);
  while (match) {
    const title = stripTrailingPunctuation(match[1]);
    const content = trim(match[2]);
    if (title && content) {
      entries.push({
        title,
        content,
        keys: [title],
        constant: true,
      });
    }
    match = pattern.exec(raw);
  }
  const compact = compactText(raw);
  if (!entries.some(entry => compactText(entry.title).includes('大姐姐')) && compact.includes('大姐姐')) {
    entries.push({
      title: '温柔大姐姐',
      content: '超级温柔、特别会照顾人的大姐姐，和用户是姐弟关系。她说话耐心，会主动关心用户的状态。',
      keys: ['温柔大姐姐', '大姐姐', '姐姐'],
      constant: true,
    });
  }
  if (!entries.some(entry => compactText(entry.title).includes('青梅竹马')) && (compact.includes('青梅竹马') || compact.includes('大小姐'))) {
    entries.push({
      title: '傲娇大小姐青梅竹马',
      content: '傲娇的大小姐青梅竹马，嘴上不坦率，但很在意用户，和用户从小熟识。',
      keys: ['傲娇大小姐青梅竹马', '大小姐', '青梅竹马'],
      constant: true,
    });
  }
  return entries;
};

const resolvePanelFromFeature = (feature = null) => {
  const panel = trim(feature?.panel);
  if (panel) return panel;
  const id = trim(feature?.id);
  if (id === 'config.api.open') return 'config';
  if (id === 'agent.center.open') return 'agent-center';
  if (id === 'worldbook.open') return 'worldbook';
  if (id === 'memory.open') return 'memory';
  if (id === 'variables.open') return 'variables';
  if (id === 'regex.open') return 'regex';
  return '';
};

const buildPlan = ({
  toolName = '',
  args = {},
  featureId = '',
  title = '',
  response = '',
} = {}) => ({
  ok: true,
  toolName: trim(toolName),
  args: isPlainObject(args) ? clone(args) : {},
  featureId: trim(featureId),
  title: trim(title),
  response: trim(response),
});

const unsupportedPlan = (reason = 'unsupported_intent', message = '暂时还不会执行这个请求。') => ({
  ok: false,
  status: 'unsupported',
  reason,
  message,
});

const requireAiPlanner = (input = '') => {
  if (!trim(input)) return unsupportedPlan('empty_input', '请输入想让女仆做的事。');
  return unsupportedPlan('maid_planner_required', '女仆需要先由 AI 判定要调用哪个工具。');
};

export const planMaidAssistantCommand = (input = '', context = {}) => {
  const text = trim(input);
  if (!text) return unsupportedPlan('empty_input', '请输入想让女仆做的事。');
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const presentationIntent = classifyMaidPresentationIntent(text);
  const shouldOpenOptionalResult = presentationIntent.mode === 'guide';

  if (compact.includes('会话配置') || compact.includes('聊天室配置') || compact.includes('配置聊天室')) {
    return buildPlan({
      toolName: 'session.open_config',
      args: {},
      featureId: 'session.config.open',
      title: '打开会话配置',
      response: '我来打开当前会话配置。',
    });
  }

  if (
    /(当前|现在|目前).*(状态|资源|会话|页面)/.test(normalized) ||
    compact.includes('当前状态') ||
    compact.includes('用了哪些资源') ||
    compact.includes('当前资源')
  ) {
    return buildPlan({
      toolName: 'app.get_current_state',
      args: {},
      featureId: 'app.state.read',
      title: '查看当前 APP 状态',
      response: '我先查看当前 APP 状态。',
    });
  }

  if (
    /(发送|发).*(消息|hi|晚上好|聊天室|会话)/.test(normalized) ||
    /(聊天室|会话).*(发送|发)/.test(normalized)
  ) {
    const sessionId = extractQuotedAfter(text, ['聊天室', '会话', '给', '到', '至']) || extractSessionName(text);
    const content = extractChatMessageContent(text);
    if (!content) return unsupportedPlan('missing_message_content', '请告诉我要发送什么消息。');
    return buildPlan({
      toolName: 'chat.send_message',
      args: {
        ...(sessionId ? { sessionId } : {}),
        content,
        role: 'user',
        open: true,
      },
      featureId: 'chat.send_message',
      title: '发送聊天消息',
      response: sessionId ? `我来向「${sessionId}」发送消息。` : '我来发送消息。',
    });
  }

  const worldbookWriteIntent = (
    /(创建|新建|新增|写|绑定).*(世界书)/.test(normalized) ||
    /(世界书).*(创建|新建|新增|写|绑定|条目)/.test(normalized)
  ) &&
    !/(删除|清理|去重|删掉|移除)/.test(normalized) &&
    !(/绑定/.test(normalized) && /(聊天室|会话)/.test(normalized));
  if (worldbookWriteIntent) {
    const name = extractNamedTarget(text, ['世界书'], '女仆创建的世界书');
    const personaName = extractQuotedAfter(text, ['角色卡', '角色']);
    const entries = extractWorldEntries(text);
    if (!entries.length) return unsupportedPlan('missing_worldbook_entries', '请告诉我要写入世界书的条目内容。');
    return buildPlan({
      toolName: 'worldbook.create',
      args: {
        name,
        entries,
        ...(personaName ? { personaName, bindToPersona: true } : {}),
      },
      featureId: 'worldbook.create',
      title: '创建世界书',
      response: `我来创建世界书「${name}」。`,
    });
  }

  if (/(创建|新建|新增|添加).*(用户名称|用户名|用户)/.test(normalized)) {
    const name = extractNamedTarget(text, ['用户名称', '用户名', '用户'], '');
    if (!name) return unsupportedPlan('missing_user_name', '请告诉我要创建的用户名称。');
    return buildPlan({
      toolName: 'user.create',
      args: { name, setActive: true },
      featureId: 'user.create',
      title: '创建用户名称',
      response: `我来创建用户「${name}」。`,
    });
  }

  if (/(切换|更换|使用|换成|设为当前).*(用户名称|用户名|用户)/.test(normalized)) {
    const target = extractNamedTarget(text, ['用户名称', '用户名', '用户'], '');
    if (!target) return unsupportedPlan('missing_user_name', '请告诉我要切换到哪个用户。');
    return buildPlan({
      toolName: 'user.switch',
      args: { target },
      featureId: 'user.switch',
      title: '切换用户名称',
      response: `我来切换到用户「${target}」。`,
    });
  }

  if (
    /(创建|新建|新增|添加).*(角色卡|角色)/.test(normalized) ||
    /(角色卡|角色).*(创建|新建|新增|添加)/.test(normalized)
  ) {
    const name = extractNamedTarget(text, ['角色卡', '角色'], '');
    if (!name) return unsupportedPlan('missing_persona_name', '请告诉我要创建的角色卡名称。');
    return buildPlan({
      toolName: 'persona.create',
      args: { name, setActive: true },
      featureId: 'persona.create',
      title: '创建角色卡',
      response: `我来创建角色卡「${name}」。`,
    });
  }

  if (
    /(切换|更换|使用|换成|设为当前).*(角色卡|角色)/.test(normalized) ||
    /(角色卡|角色).*(切换|更换|使用|换成|设为当前)/.test(normalized)
  ) {
    const target = extractNamedTarget(text, ['角色卡', '角色'], '');
    if (!target) return unsupportedPlan('missing_persona_name', '请告诉我要切换到哪个角色卡。');
    return buildPlan({
      toolName: 'persona.switch',
      args: { target },
      featureId: 'persona.switch',
      title: '切换角色卡',
      response: `我来切换到角色卡「${target}」。`,
    });
  }

  if (
    /(创建|新建|新增|添加|开).*(聊天室|会话|好友|联系人)/.test(normalized) ||
    /(聊天室|会话|好友|联系人).*(创建|新建|新增|添加)/.test(normalized)
  ) {
    const names = extractSessionNames(text);
    if (names.length > 1) {
      return buildPlan({
        toolName: 'session.create',
        args: { names, open: shouldOpenOptionalResult },
        featureId: 'session.create',
        title: '创建聊天室',
        response: `我来创建 ${names.length} 个聊天室。`,
      });
    }
    const name = names[0] || extractSessionName(text);
    if (!name) return unsupportedPlan('missing_session_name', '请告诉我要创建的聊天室名称。');
    return buildPlan({
      toolName: 'session.create',
      args: { name, open: shouldOpenOptionalResult },
      featureId: 'session.create',
      title: '创建聊天室',
      response: `我来创建聊天室「${name}」。`,
    });
  }

  if (
    /(打开|进入|切换).*(聊天室|会话)/.test(normalized) &&
    !compact.includes('会话配置') &&
    !compact.includes('聊天室配置')
  ) {
    const name = extractSessionName(text) || stripTrailingPunctuation(
      text
        .replace(/^(打开|进入|切换)\s*/u, '')
        .replace(/(聊天室|会话)/gu, '')
        .trim(),
    );
    if (!name) return unsupportedPlan('missing_session_id', '请告诉我要打开哪个聊天室。');
    return buildPlan({
      toolName: 'session.open',
      args: { sessionId: name },
      featureId: 'session.open',
      title: '打开聊天室',
      response: `我来打开聊天室「${name}」。`,
    });
  }

  const matches = searchAppFeatures(text, { limit: 3 });
  const feature = matches[0] || null;
  if (feature && Number(feature.score || 0) >= 45) {
    const panel = resolvePanelFromFeature(feature);
    if (feature.id === 'app.state.read') {
      return buildPlan({
        toolName: 'app.get_current_state',
        args: {},
        featureId: feature.id,
        title: feature.title,
        response: '我先查看当前 APP 状态。',
      });
    }
    if (feature.id === 'session.config.open') {
      return buildPlan({
        toolName: 'session.open_config',
        args: {},
        featureId: feature.id,
        title: feature.title,
        response: '我来打开当前会话配置。',
      });
    }
    if (panel) {
      return buildPlan({
        toolName: 'app.open_panel',
        args: {
          panel,
          ...(feature.id === 'config.api.open' ? { tab: 'chat' } : {}),
        },
        featureId: feature.id,
        title: feature.title,
        response: `我来打开${feature.title}。`,
      });
    }
  }

  return unsupportedPlan('unsupported_intent', '这个请求还没有接入女仆工具。');
};

const executeWithRegistry = async ({
  toolRegistry = null,
  plan = null,
  context = {},
} = {}) => {
  if (!plan?.toolName) throw new Error('maid assistant plan missing tool');
  if (!toolRegistry || typeof toolRegistry.executeTool !== 'function') {
    throw new Error('maid assistant tool registry unavailable');
  }
  return toolRegistry.executeTool(plan.toolName, plan.args || {}, context);
};

export const createMaidAssistantAgent = ({
  toolRegistry = null,
  agentTaskRuntime = null,
  capabilityRoutingRuntime = null,
  planner = requireAiPlanner,
  reactPlanner = null,
  importedCardClassifier = null,
  chatResponder = null,
  guidedActionRuntime = null,
  prepareConversationContext = null,
  getCapabilityRoutingConfigOverride = null,
  getSkillCatalog = null,
  maxReactSteps = 48,
  repeatedFailureLimit = 3,
  logger = console,
} = {}) => {
  const runPlannedTool = async (plan, context = {}, tracker = null) => {
    throwIfMaidAborted(context?.signal);
    if (tracker?.canTrack && typeof agentTaskRuntime?.executeTool === 'function') {
      const step = tracker.startToolStep(plan);
      try {
        const output = await agentTaskRuntime.executeTool(plan.toolName, plan.args || {}, {
          ...context,
          runId: tracker.getRunId(),
          stepId: step?.id,
          source: 'maid-assistant',
          onToolConfirmationPending: () => tracker.markWaitingPermission(true),
          onToolConfirmationResolved: () => tracker.markWaitingPermission(false),
        });
        const stepStatus = resolveTrackedToolStepStatus(output);
        tracker.finishToolStep(step, {
          status: stepStatus,
          summary: output?.summary || plan.title || plan.toolName,
          errorMessage: stepStatus === 'failed' ? summarizeToolFailure(output) : '',
          output,
        });
        return output;
      } catch (error) {
        const cancelled = isMaidAbortError(error, context?.signal);
        tracker.finishToolStep(step, {
          status: cancelled ? 'cancelled' : 'failed',
          summary: cancelled ? '用户终止了女仆任务。' : (error?.message || 'maid assistant tool failed'),
          errorMessage: cancelled ? '' : (error?.message || String(error || '')),
        });
        throw error;
      }
    }
    if (agentTaskRuntime && typeof agentTaskRuntime.enqueue === 'function') {
      const runResult = await agentTaskRuntime.enqueue({
        kind: 'maid_assistant',
        source: 'maid-assistant',
        trigger: 'manual',
        sessionId: trim(context.sessionId),
        summary: plan.title || plan.toolName,
      }, async ({ runId, startStep, finishStep }) => {
        const step = startStep?.({
          type: 'tool',
          summary: plan.title || plan.toolName,
          input: {
            toolName: plan.toolName,
            args: plan.args,
            ...buildCapabilityPlanTrace(plan),
          },
        });
        try {
          const output = await agentTaskRuntime.executeTool(plan.toolName, plan.args || {}, {
            ...context,
            runId,
            stepId: step?.id,
            source: 'maid-assistant',
          });
          const stepStatus = resolveTrackedToolStepStatus(output);
          finishStep?.(step?.id, {
            status: stepStatus,
            summary: output?.summary || plan.title || plan.toolName,
            errorMessage: stepStatus === 'failed' ? summarizeToolFailure(output) : '',
            output,
          });
          return output;
        } catch (error) {
          const cancelled = isMaidAbortError(error, context?.signal);
          finishStep?.(step?.id, {
            status: cancelled ? 'cancelled' : 'failed',
            summary: cancelled ? '用户终止了女仆任务。' : (error?.message || 'maid assistant tool failed'),
            errorMessage: cancelled ? '' : (error?.message || String(error || '')),
          });
          throw error;
        }
      });
      return runResult;
    }
    return executeWithRegistry({ toolRegistry, plan, context });
  };

  const executePlan = async (plan, context = {}, tracker = null) => {
    throwIfMaidAborted(context?.signal);
    if (plan.source === 'confirmed_pending_action' && plan.metadata?.confirmedDelete) {
      context = { ...context, maidConfirmedDelete: plan.metadata.confirmedDelete };
    }
    // Voice work can wait in the queue while the user switches rooms. Bind an
    // omitted session target before validation, confirmation and execution.
    if (context.voiceCallId && trim(context.sessionId)
      && toolRegistry?.get?.(plan.toolName)?.schema?.properties?.sessionId
      && !['sessionId', 'sessionName', 'chatName', 'target'].some(key => trim(plan.args?.[key]))) {
      plan = { ...plan, args: { ...plan.args, sessionId: context.sessionId } };
    }
    let executablePlan = plan;
    if (capabilityRoutingRuntime && typeof capabilityRoutingRuntime.validatePlan === 'function') {
      let validation = null;
      try {
        validation = capabilityRoutingRuntime.validatePlan(plan, { context });
      } catch (error) {
        logger?.warn?.('maid capability validation failed', error);
        validation = {
          ok: false,
          reason: error?.message || 'capability_validation_failed',
          message: error?.message || '候选能力校验失败。',
        };
      }
      if (validation?.ok === false) {
        const error = new Error(validation.message || validation.reason || '候选能力校验失败。');
        error.code = validation.reason || 'capability_validation_failed';
        error.details = {
          candidateSnapshotId: trim(plan?.candidateSnapshotId),
          nearestCandidates: clone(validation.nearestCandidates || []),
        };
        if (tracker?.canTrack) {
          const step = tracker.startToolStep(plan);
          tracker.finishToolStep(step, {
            status: 'failed',
            summary: error.message,
            errorMessage: error.message,
            output: {
              ok: false,
              reason: error.code,
              message: error.message,
              candidateSnapshotId: trim(plan?.candidateSnapshotId),
              nearestCandidates: clone(validation.nearestCandidates || []),
            },
          });
        }
        throw error;
      }
      executablePlan = validation?.plan || plan;
    }
    if (guidedActionRuntime && typeof guidedActionRuntime.run === 'function') {
      throwIfMaidAborted(context?.signal);
      return guidedActionRuntime.run({
        plan: executablePlan,
        context,
        execute: () => runPlannedTool(executablePlan, context, tracker),
      });
    }
    throwIfMaidAborted(context?.signal);
    const output = await runPlannedTool(executablePlan, context, tracker);
    return {
      output,
      guided: false,
      guide: null,
      message: '',
    };
  };

  const makeImportedCardWorkflowPlan = ({
    toolName = '',
    args = {},
    featureId = '',
    title = '',
    response = '',
    phase = '',
  } = {}) => ({
    ok: true,
    action: 'tool',
    toolName,
    args,
    featureId,
    title,
    response,
    source: 'bounded_imported_card_workflow',
    metadata: {
      workflowTransition: 'imported_card_session_setup',
      workflowPhase: phase,
    },
  });

  const runImportedCardWorkflowTool = async ({
    plan = {},
    context = {},
    tracker = null,
    steps = [],
    authorizePlan = null,
  } = {}) => {
    const executablePlan = typeof authorizePlan === 'function'
      ? authorizePlan(plan, steps)
      : plan;
    let execution = null;
    try {
      execution = await executePlan(executablePlan, context, tracker);
    } catch (error) {
      if (isMaidAbortError(error, context?.signal)) throw error;
      logger?.warn?.('maid imported-card workflow tool failed', error);
      execution = {
        output: makeToolErrorOutput(executablePlan, error),
        guided: false,
        guide: null,
        message: '',
      };
    }
    const output = execution?.output ?? execution;
    const ok = isToolOutputOk(output);
    steps.push(buildReactStepSnapshot({
      index: steps.length + 1,
      plan: executablePlan,
      execution,
      output,
      ok,
    }));
    return {
      ok,
      plan: executablePlan,
      execution,
      output,
      result: unwrapToolOutputResult(output),
    };
  };

  const importedCardWorkflowFailure = ({
    input = '',
    reason = 'imported_card_workflow_failed',
    message = '导入角色卡建房流程未能继续。',
    steps = [],
    output = null,
    status = 'failed',
  } = {}) => ({
    ok: false,
    status,
    responseType: 'workflow',
    input: trim(input),
    reason,
    message,
    steps: clone(steps),
    output: clone(output),
  });

  const resolveImportedCardPersona = (result = {}, intent = {}) => {
    const items = Array.isArray(result?.items) ? result.items : [];
    const targetName = trim(intent?.targetPersonaName);
    if (targetName) {
      const targetKey = compactText(targetName);
      const matches = items.filter(item => (
        compactText(item?.id) === targetKey || compactText(item?.name) === targetKey
      ));
      if (matches.length === 1) return { persona: matches[0], reason: '' };
      return {
        persona: null,
        reason: matches.length > 1 ? 'persona_target_ambiguous' : 'persona_target_not_found',
      };
    }
    const activeId = trim(result?.activeId);
    const active = items.find(item => (
      item?.active === true || (activeId && trim(item?.id) === activeId)
    )) || null;
    if (active) return { persona: active, reason: '' };
    return {
      persona: null,
      reason: items.length > 1 ? 'persona_target_required' : 'active_persona_not_found',
    };
  };

  const isAmbiguousImportedCardEntry = (entry = {}) => {
    const title = compactText(entry?.title || entry?.name || entry?.id);
    const keys = [
      ...(Array.isArray(entry?.keys) ? entry.keys : []),
      ...(Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys : []),
    ].map(item => trim(item)).filter(Boolean);
    return (
      /^(?:角色|人物|角色设定|人物设定|角色资料|人物资料|character|profile|设定)$/iu.test(title) ||
      (!keys.length && /^(?:entry|条目|资料)\d*$/iu.test(title))
    );
  };

  const runImportedCardPreviewWorkflow = async ({
    input = '',
    intent = {},
    context = {},
    tracker = null,
    authorizePlan = null,
  } = {}) => {
    const steps = [];
    if (intent?.requestedStrategy === 'isolated_session_worldbooks') {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: 'isolated_worldbook_strategy_not_supported_in_imported_card_workflow',
        message: '这张导入卡已有共用世界书；当前有界流程只支持安全继承。若确实要为每个聊天室建立隔离世界书，请另行明确每位人物的隔离范围。',
      });
    }
    if (typeof importedCardClassifier !== 'function') {
      return importedCardWorkflowFailure({
        input,
        status: 'unsupported',
        reason: 'imported_card_classifier_unavailable',
        message: '导入角色卡的人物分类器尚未配置，未执行任何写入。',
      });
    }

    const personaRead = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'app.read_resource',
        args: {
          resource: 'persona',
          ...(trim(intent?.targetPersonaName) ? { name: trim(intent.targetPersonaName) } : {}),
          include: ['associations'],
        },
        featureId: 'app.resource.read',
        title: '读取目标角色卡关联资源',
        response: '先确认目标角色卡及其关联世界书。',
        phase: 'read_persona',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    if (!personaRead.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: 'persona_read_failed',
        message: summarizeToolFailure(personaRead.output),
        steps,
        output: personaRead.result,
      });
    }
    const resolvedPersona = resolveImportedCardPersona(personaRead.result, intent);
    if (!resolvedPersona.persona) {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: resolvedPersona.reason,
        message: resolvedPersona.reason === 'persona_target_ambiguous'
          ? '找到多张同名角色卡，请先明确要处理的角色卡 ID。'
          : '没有找到唯一的目标角色卡；请先切到目标角色卡，或在指令中写出角色卡名称。',
        steps,
        output: personaRead.result,
      });
    }
    const persona = resolvedPersona.persona;
    const activePersonaId = trim(personaRead.result?.activeId);
    if (
      persona?.active !== true &&
      (!activePersonaId || trim(persona?.id) !== activePersonaId)
    ) {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: 'target_persona_not_active',
        message: `「${trim(persona?.name || persona?.id)}」目前不是活动角色卡。请先切换到它再预览，避免读取或冻结到其他角色卡的聊天室作用域。`,
        steps,
        output: personaRead.result,
      });
    }
    const worldbookId = trim(persona?.associations?.worldbookId);
    if (!worldbookId || persona?.associations?.worldbookEnabled === false) {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: worldbookId ? 'persona_worldbook_disabled' : 'persona_worldbook_missing',
        message: worldbookId
          ? `角色卡「${trim(persona?.name || persona?.id)}」关联的世界书目前未启用。`
          : `角色卡「${trim(persona?.name || persona?.id)}」没有可继承的关联世界书。`,
        steps,
        output: personaRead.result,
      });
    }

    const worldbookRead = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'worldbook.read',
        args: { name: worldbookId, maxEntries: 200 },
        featureId: 'worldbook.read',
        title: '读取完整世界书紧凑索引',
        response: '读取完整条目索引后再做一次人物分类。',
        phase: 'read_worldbook_index',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    if (!worldbookRead.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: 'worldbook_read_failed',
        message: summarizeToolFailure(worldbookRead.output),
        steps,
        output: worldbookRead.result,
      });
    }
    const entryCount = Math.max(0, Math.trunc(Number(worldbookRead.result?.entryCount) || 0));
    const returnedEntryCount = Math.max(
      0,
      Math.trunc(Number(worldbookRead.result?.returnedEntryCount) || 0),
    );
    if (
      entryCount > 200 ||
      returnedEntryCount !== entryCount ||
      worldbookRead.result?.truncated === true
    ) {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: 'worldbook_index_incomplete',
        message: `关联世界书共有 ${entryCount} 条，但本轮只能安全取得 ${returnedEntryCount} 条完整索引；未分类、未创建任何资源。`,
        steps,
        output: worldbookRead.result,
      });
    }
    let entries = (Array.isArray(worldbookRead.result?.entries) ? worldbookRead.result.entries : [])
      .map(item => clone(item));
    const ambiguousEntries = entries.filter(isAmbiguousImportedCardEntry).slice(0, 6);
    for (const entry of ambiguousEntries) {
      const detailRead = await runImportedCardWorkflowTool({
        plan: makeImportedCardWorkflowPlan({
          toolName: 'worldbook.read',
          args: {
            name: worldbookId,
            entryId: trim(entry?.id),
            includeContent: true,
            maxEntries: 1,
            maxContentLength: 1200,
          },
          featureId: 'worldbook.read',
          title: `补读含糊条目「${trim(entry?.title || entry?.id)}」`,
          response: '只补读标题不足以判断的少数条目。',
          phase: 'read_ambiguous_entry',
        }),
        context,
        tracker,
        steps,
        authorizePlan,
      });
      if (!detailRead.ok) continue;
      const detailed = Array.isArray(detailRead.result?.entries)
        ? detailRead.result.entries[0]
        : null;
      if (!detailed) continue;
      entries = entries.map(item => (
        trim(item?.id) === trim(entry?.id)
          ? { ...item, content: trim(detailed?.content).slice(0, 1200) }
          : item
      ));
    }

    let rawClassification = null;
    try {
      rawClassification = await importedCardClassifier({
        input: trim(input),
        persona: { id: trim(persona?.id), name: trim(persona?.name || persona?.id) },
        worldbook: {
          id: trim(worldbookRead.result?.id || worldbookId),
          name: trim(worldbookRead.result?.name || worldbookId),
          entryCount,
        },
        entries,
      }, context);
    } catch (error) {
      if (isMaidAbortError(error, context?.signal)) throw error;
      return importedCardWorkflowFailure({
        input,
        reason: 'imported_card_classification_failed',
        message: error?.message || '人物分类模型调用失败；未执行任何写入。',
        steps,
        output: worldbookRead.result,
      });
    }
    const classification = normalizeMaidImportedCardClassification(rawClassification, {
      entries,
      requestedGroupName: intent?.requestedGroupName,
      groupRequested: intent?.groupRequested === true,
    });
    if (!classification.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: classification.reason,
        message: `人物分类结果未通过完整性校验（${classification.reason}）；未执行任何写入。`,
        steps,
        output: classification,
      });
    }

    const worldbook = {
      id: trim(worldbookRead.result?.id || worldbookId),
      name: trim(worldbookRead.result?.name || worldbookId),
      enabled: true,
      entryCount,
      returnedEntryCount,
    };
    if (intent?.createRequested !== true) {
      const previewSnapshot = buildMaidImportedCardWorkflowSnapshot({
        persona,
        worldbook,
        classification,
      });
      return {
        ok: true,
        status: 'succeeded',
        responseType: 'workflow',
        input: trim(input),
        steps: clone(steps),
        output: clone(worldbookRead.result),
        classification: clone(classification),
        message: buildMaidImportedCardPreviewMessage(previewSnapshot, { previewOnly: true }),
      };
    }

    const sessionList = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'session.list',
        args: { limit: 100, includeGroups: true },
        featureId: 'session.list',
        title: '读取当前角色卡会话清单',
        response: '核对候选聊天室与群聊是否已经存在。',
        phase: 'read_existing_sessions',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    if (!sessionList.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: 'session_list_failed',
        message: summarizeToolFailure(sessionList.output),
        steps,
        output: sessionList.result,
      });
    }
    const contacts = Array.isArray(sessionList.result?.contacts) ? sessionList.result.contacts : [];
    const groupKey = compactText(classification?.group?.name);
    const existingGroup = classification?.group?.enabled === true
      ? contacts.find(item => (
          compactText(item?.id) === groupKey || compactText(item?.name) === groupKey
        ))
      : null;
    let existingGroupMembers = [];
    if (existingGroup?.isGroup === true) {
      const groupRead = await runImportedCardWorkflowTool({
        plan: makeImportedCardWorkflowPlan({
          toolName: 'app.read_resource',
          args: {
            resource: 'session',
            id: trim(existingGroup?.id),
            include: ['members'],
          },
          featureId: 'app.resource.read',
          title: '冻结现有群聊成员',
          response: '记录现有群聊的精确成员 ID。',
          phase: 'read_existing_group',
        }),
        context,
        tracker,
        steps,
        authorizePlan,
      });
      if (!groupRead.ok) {
        return importedCardWorkflowFailure({
          input,
          reason: 'existing_group_read_failed',
          message: summarizeToolFailure(groupRead.output),
          steps,
          output: groupRead.result,
        });
      }
      existingGroupMembers = (groupRead.result?.sessions?.[0]?.members || [])
        .map(item => trim(item?.id || item))
        .filter(Boolean);
    }
    const snapshot = buildMaidImportedCardWorkflowSnapshot({
      persona,
      worldbook,
      classification,
      contacts,
      existingGroupMembers,
      revealRequested: intent?.revealRequested === true,
    });
    const privateConflict = snapshot.privateSessions.find(item => item.existingType === 'group');
    if (privateConflict) {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: 'private_session_name_conflict',
        message: `候选人物「${privateConflict.name}」与现有群聊同名，无法安全冻结建房清单。`,
        steps,
        output: snapshot,
      });
    }
    if (snapshot.group.enabled && snapshot.group.existingType === 'private') {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: 'group_name_conflict',
        message: `拟建群聊「${snapshot.group.name}」与现有私聊同名，请先换一个群名。`,
        steps,
        output: snapshot,
      });
    }
    const validation = validateMaidImportedCardWorkflowSnapshot(snapshot);
    if (!validation.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: validation.reason,
        message: `冻结清单未通过校验（${validation.reason}）；未执行任何写入。`,
        steps,
        output: snapshot,
      });
    }
    return {
      ok: true,
      status: 'awaiting_confirmation',
      responseType: 'workflow',
      input: trim(input),
      steps: clone(steps),
      output: clone(sessionList.result),
      pendingWorkflow: validation.snapshot,
      message: buildMaidImportedCardPreviewMessage(validation.snapshot),
    };
  };

  const sameImportedCardMemberSet = (left = [], right = []) => {
    const leftSet = Array.from(new Set(left.map(item => trim(item)).filter(Boolean))).sort();
    const rightSet = Array.from(new Set(right.map(item => trim(item)).filter(Boolean))).sort();
    return leftSet.length === rightSet.length &&
      leftSet.every((item, index) => item === rightSet[index]);
  };

  const runImportedCardApplyWorkflow = async ({
    input = '',
    pending = null,
    context = {},
    tracker = null,
    authorizePlan = null,
  } = {}) => {
    const steps = [];
    const validation = validateMaidImportedCardWorkflowSnapshot(pending?.snapshot);
    if (!validation.ok) {
      return importedCardWorkflowFailure({
        input,
        status: 'needs_input',
        reason: validation.reason,
        message: '上一份建房清单已经失效，请重新发起预览。',
      });
    }
    const snapshot = validation.snapshot;
    const personaRead = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'app.read_resource',
        args: {
          resource: 'persona',
          id: snapshot.persona.id,
          include: ['associations'],
        },
        featureId: 'app.resource.read',
        title: '复验冻结角色卡',
        response: '执行前先复验角色卡与世界书关联没有变化。',
        phase: 'apply_verify_persona',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    const currentPersona = personaRead.result?.items?.find(item => (
      trim(item?.id) === snapshot.persona.id
    ));
    if (
      !personaRead.ok ||
      !currentPersona ||
      trim(currentPersona?.associations?.worldbookId) !== snapshot.worldbook.id ||
      currentPersona?.associations?.worldbookEnabled === false
    ) {
      return importedCardWorkflowFailure({
        input,
        reason: 'frozen_persona_scope_changed',
        message: '角色卡或其世界书关联在确认期间发生变化，已停止写入；请重新预览。',
        steps,
        output: personaRead.result,
      });
    }
    const worldbookRead = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'worldbook.read',
        args: { name: snapshot.worldbook.id, maxEntries: 200 },
        featureId: 'worldbook.read',
        title: '复验冻结世界书条目',
        response: '确认候选来源条目仍存在。',
        phase: 'apply_verify_worldbook',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    const currentEntryIds = new Set(
      (Array.isArray(worldbookRead.result?.entries) ? worldbookRead.result.entries : [])
        .map(item => trim(item?.id))
        .filter(Boolean),
    );
    if (
      !worldbookRead.ok ||
      Number(worldbookRead.result?.entryCount || 0) !== Number(snapshot.worldbook.entryCount || 0) ||
      snapshot.candidates.some(item => !currentEntryIds.has(trim(item?.entryId)))
    ) {
      return importedCardWorkflowFailure({
        input,
        reason: 'frozen_worldbook_index_changed',
        message: '世界书条目在确认期间发生变化，已停止写入；请重新预览候选。',
        steps,
        output: worldbookRead.result,
      });
    }

    if (currentPersona?.active !== true && trim(personaRead.result?.activeId) !== snapshot.persona.id) {
      const switched = await runImportedCardWorkflowTool({
        plan: makeImportedCardWorkflowPlan({
          toolName: 'persona.switch',
          args: { target: snapshot.persona.id },
          featureId: 'persona.switch',
          title: '切换到冻结角色卡作用域',
          response: '进入已确认的角色卡作用域后再创建会话。',
          phase: 'apply_switch_persona',
        }),
        context,
        tracker,
        steps,
        authorizePlan,
      });
      if (!switched.ok) {
        return importedCardWorkflowFailure({
          input,
          reason: 'persona_switch_failed',
          message: summarizeToolFailure(switched.output),
          steps,
          output: switched.result,
        });
      }
    }

    const sessionList = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'session.list',
        args: { limit: 100, includeGroups: true },
        featureId: 'session.list',
        title: '执行前复验会话清单',
        response: '复验冻结 ID，避免确认期间的同名资源变化。',
        phase: 'apply_verify_sessions',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    if (!sessionList.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: 'session_list_failed',
        message: summarizeToolFailure(sessionList.output),
        steps,
        output: sessionList.result,
      });
    }
    const currentContacts = Array.isArray(sessionList.result?.contacts)
      ? sessionList.result.contacts
      : [];
    const findCurrentContact = (target = '') => {
      const key = compactText(target);
      return currentContacts.find(item => (
        compactText(item?.id) === key || compactText(item?.name) === key
      )) || null;
    };
    for (const item of snapshot.privateSessions) {
      const byFrozenId = trim(item?.existingSessionId)
        ? currentContacts.find(contact => trim(contact?.id) === trim(item.existingSessionId))
        : null;
      if (trim(item?.existingSessionId) && (!byFrozenId || byFrozenId?.isGroup === true)) {
        return importedCardWorkflowFailure({
          input,
          reason: 'frozen_private_session_changed',
          message: `私聊「${item.name}」在确认期间发生变化，已停止写入；请重新预览。`,
          steps,
          output: sessionList.result,
        });
      }
      const byName = findCurrentContact(item.name);
      if (byName?.isGroup === true) {
        return importedCardWorkflowFailure({
          input,
          reason: 'private_session_name_conflict',
          message: `候选人物「${item.name}」现在与群聊同名，已停止写入。`,
          steps,
          output: sessionList.result,
        });
      }
    }
    const frozenGroupId = trim(snapshot?.group?.existingSessionId);
    const currentGroup = snapshot?.group?.enabled === true
      ? (frozenGroupId
          ? currentContacts.find(item => trim(item?.id) === frozenGroupId)
          : findCurrentContact(snapshot.group.name))
      : null;
    if (
      frozenGroupId &&
      (!currentGroup || currentGroup?.isGroup !== true)
    ) {
      return importedCardWorkflowFailure({
        input,
        reason: 'frozen_group_changed',
        message: `群聊「${snapshot.group.name}」在确认期间发生变化，已停止写入；请重新预览。`,
        steps,
        output: sessionList.result,
      });
    }
    if (currentGroup && currentGroup?.isGroup !== true) {
      return importedCardWorkflowFailure({
        input,
        reason: 'group_name_conflict',
        message: `群聊名「${snapshot.group.name}」现在与私聊冲突，已停止写入。`,
        steps,
        output: sessionList.result,
      });
    }

    const sessionCreate = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'session.create',
        args: {
          names: snapshot.privateSessions.map(item => item.name),
          open: false,
        },
        featureId: 'session.create',
        title: '建立冻结私聊清单',
        response: '一次性建立缺少的私聊，已存在项按精确名称复用。',
        phase: 'apply_create_private_sessions',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    if (!sessionCreate.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: 'private_session_create_failed',
        message: summarizeToolFailure(sessionCreate.output),
        steps,
        output: sessionCreate.result,
      });
    }
    const sessionResults = Array.isArray(sessionCreate.result?.sessions)
      ? sessionCreate.result.sessions
      : [];
    const privateSessionIds = snapshot.privateSessions.map((item, index) => trim(
      sessionResults[index]?.sessionId ||
      sessionCreate.result?.sessionIds?.[index] ||
      item?.existingSessionId ||
      item?.name,
    ));
    const privateCreatedCount = sessionResults.length
      ? sessionResults.filter(item => item?.created === true).length
      : Number(sessionCreate.result?.createdCount || 0);
    const privateReusedCount = snapshot.privateSessions.length - privateCreatedCount;
    const privateSessionIdByName = new Map(
      snapshot.privateSessions.map((item, index) => [
        compactText(item?.name),
        privateSessionIds[index],
      ]),
    );
    const groupMemberSessionIds = snapshot?.group?.enabled === true
      ? snapshot.group.memberNames
          .map(name => trim(privateSessionIdByName.get(compactText(name))))
          .filter(Boolean)
      : [];
    if (
      snapshot?.group?.enabled === true &&
      groupMemberSessionIds.length !== snapshot.group.memberNames.length
    ) {
      return importedCardWorkflowFailure({
        input,
        reason: 'frozen_group_member_resolution_failed',
        message: '已建立私聊，但无法把冻结群成员完整解析到稳定会话 ID；已停止群聊写入并保留清单供重试。',
        steps,
        output: { privateSessionIds, groupMemberNames: snapshot.group.memberNames },
      });
    }

    let groupSessionId = trim(currentGroup?.id);
    let groupCreated = false;
    let groupReused = false;
    if (snapshot?.group?.enabled === true) {
      let existingMemberIds = [];
      if (currentGroup?.isGroup === true) {
        const currentGroupRead = await runImportedCardWorkflowTool({
          plan: makeImportedCardWorkflowPlan({
            toolName: 'app.read_resource',
            args: {
              resource: 'session',
              id: trim(currentGroup.id),
              include: ['members'],
            },
            featureId: 'app.resource.read',
            title: '复验现有群聊成员',
            response: '取得群聊当前成员 ID，避免重复或错误覆盖。',
            phase: 'apply_read_group_members',
          }),
          context,
          tracker,
          steps,
          authorizePlan,
        });
        if (!currentGroupRead.ok) {
          return importedCardWorkflowFailure({
            input,
            reason: 'existing_group_read_failed',
            message: summarizeToolFailure(currentGroupRead.output),
            steps,
            output: currentGroupRead.result,
          });
        }
        existingMemberIds = (currentGroupRead.result?.sessions?.[0]?.members || [])
          .map(item => trim(item?.id || item))
          .filter(Boolean);
      }
      if (currentGroup?.isGroup === true && sameImportedCardMemberSet(existingMemberIds, groupMemberSessionIds)) {
        groupReused = true;
      } else {
        const groupPlan = currentGroup?.isGroup === true
          ? makeImportedCardWorkflowPlan({
              toolName: 'group.update_members',
              args: {
                groupId: trim(currentGroup.id),
                members: groupMemberSessionIds,
                open: false,
              },
              featureId: 'group.members.update',
              title: '更新冻结群聊成员',
              response: '把现有群聊成员调整为已确认的精确集合。',
              phase: 'apply_update_group',
            })
          : makeImportedCardWorkflowPlan({
              toolName: 'group.create',
              args: {
                name: snapshot.group.name,
                members: groupMemberSessionIds,
                open: false,
              },
              featureId: 'group.create',
              title: '建立冻结群聊',
              response: '建立群聊并加入冻结的私聊联系人。',
              phase: 'apply_create_group',
            });
        const groupWrite = await runImportedCardWorkflowTool({
          plan: groupPlan,
          context,
          tracker,
          steps,
          authorizePlan,
        });
        if (!groupWrite.ok) {
          return importedCardWorkflowFailure({
            input,
            reason: 'group_write_failed',
            message: summarizeToolFailure(groupWrite.output),
            steps,
            output: groupWrite.result,
          });
        }
        groupSessionId = trim(
          groupWrite.result?.group?.id ||
          groupWrite.result?.groupId ||
          currentGroup?.id,
        );
        groupCreated = groupWrite.result?.created === true;
        groupReused = !groupCreated;
      }
    }

    const verification = await runImportedCardWorkflowTool({
      plan: makeImportedCardWorkflowPlan({
        toolName: 'app.read_resource',
        args: {
          resource: 'session',
          include: ['members', 'worldbooks'],
          limit: 200,
        },
        featureId: 'app.resource.read',
        title: '验收会话、群成员与世界书继承',
        response: '读回所有冻结目标的成员和世界书来源。',
        phase: 'apply_verify_result',
      }),
      context,
      tracker,
      steps,
      authorizePlan,
    });
    if (!verification.ok) {
      return importedCardWorkflowFailure({
        input,
        reason: 'result_verification_read_failed',
        message: summarizeToolFailure(verification.output),
        steps,
        output: verification.result,
      });
    }
    const verifiedSessions = Array.isArray(verification.result?.sessions)
      ? verification.result.sessions
      : [];
    const verifiedById = new Map(verifiedSessions.map(item => [trim(item?.id), item]));
    const verifyWorldInheritance = (item = {}) => (
      Array.isArray(item?.worldbooks?.directWorldIds) &&
      item.worldbooks.directWorldIds.length === 0 &&
      Array.isArray(item?.worldbooks?.roleWorldIds) &&
      item.worldbooks.roleWorldIds.includes(snapshot.worldbook.id)
    );
    const privateVerified = privateSessionIds.every((sessionId) => {
      const item = verifiedById.get(sessionId);
      return Boolean(item && item?.isGroup !== true && verifyWorldInheritance(item));
    });
    const verifiedGroup = snapshot?.group?.enabled === true
      ? verifiedById.get(groupSessionId)
      : null;
    const verifiedGroupMemberIds = (verifiedGroup?.members || [])
      .map(item => trim(item?.id || item))
      .filter(Boolean);
    const groupVerified = snapshot?.group?.enabled !== true || Boolean(
      verifiedGroup &&
      verifiedGroup?.isGroup === true &&
      sameImportedCardMemberSet(verifiedGroupMemberIds, groupMemberSessionIds) &&
      verifyWorldInheritance(verifiedGroup)
    );
    if (!privateVerified || !groupVerified) {
      return importedCardWorkflowFailure({
        input,
        reason: 'imported_card_result_verification_failed',
        message: '建房结果没有同时通过私聊集合、群成员、角色卡世界书继承与空直接绑定验收；已保留冻结清单供幂等重试。',
        steps,
        output: {
          privateVerified,
          groupVerified,
          privateSessionIds,
          groupSessionId,
        },
      });
    }

    let opened = false;
    if (snapshot.revealRequested === true) {
      const revealSessionId = groupSessionId || privateSessionIds[0];
      if (revealSessionId) {
        const reveal = await runImportedCardWorkflowTool({
          plan: makeImportedCardWorkflowPlan({
            toolName: 'session.open',
            args: { sessionId: revealSessionId },
            featureId: 'session.open',
            title: '打开主要结果',
            response: '只打开一个主要会话供你查看。',
            phase: 'apply_reveal',
          }),
          context,
          tracker,
          steps,
          authorizePlan,
        });
        opened = reveal.ok;
      }
    }

    if (pending?.runId && typeof agentTaskRuntime?.finishRun === 'function') {
      try {
        agentTaskRuntime.finishRun(pending.runId, {
          status: 'succeeded',
          summary: '导入角色卡建房清单已确认并执行。',
          metadata: {
            maidStatus: 'succeeded',
            pendingWorkflow: {
              ...snapshot,
              state: 'consumed',
              consumedAt: Date.now(),
              consumedByRunId: tracker?.getRunId?.() || '',
            },
          },
        });
      } catch {}
    }
    return {
      ok: true,
      status: 'succeeded',
      responseType: 'workflow',
      input: trim(input),
      steps: clone(steps),
      output: clone(verification.result),
      verified: true,
      message: buildMaidImportedCardExecutionMessage({
        snapshot,
        privateCreatedCount,
        privateReusedCount,
        groupCreated,
        groupReused,
        opened,
      }),
    };
  };

  const runPromptWithTracker = async (input = '', context = {}, tracker = null) => {
    // 每轮独立的视觉附件池：工具可把截图加入同一轮 ReAct，但不会回写输入框或跨 run 留存。
    context = {
      ...(isPlainObject(context) ? context : {}),
      operationIntentPolicy: classifyMaidOperationIntent(input),
      presentationIntent: classifyMaidPresentationIntent(input),
      maidUserInput: trim(input),
      maidSourceGrounding: buildMaidSourceGroundingContext({ input, steps: [] }),
      maidVisualSpecLedger: isPlainObject(context?.maidVisualSpecLedger)
        ? context.maidVisualSpecLedger
        : createMaidVisualSpecLedger(context?.runContinuation?.visualSpecLedger),
      maidAttachments: (Array.isArray(context?.maidAttachments) ? context.maidAttachments : [])
        .map(item => (isPlainObject(item) ? { ...item } : item)),
    };
    throwIfMaidAborted(context?.signal);
    // 空指令直接拒绝：不进 planner，否则模型会按女仆历史重放上一条旧指令。
    const hasAttachments = Array.isArray(context?.maidAttachments) && context.maidAttachments.length > 0;
    const hasSelection = Array.isArray(context?.userSelection) && context.userSelection.length > 0;
    if (!trim(input) && !hasAttachments && !hasSelection) {
      return {
        ok: false,
        status: 'failed',
        reason: 'empty_input',
        input: '',
        message: '这次没有收到指令内容，女仆先不行动～请告诉我需要做什么。',
      };
    }
    if (context.operationIntentPolicy.mode === 'no_tool') {
      if (typeof chatResponder !== 'function') {
        return {
          ok: false,
          status: 'unsupported',
          responseType: 'chat',
          input: trim(input),
          reason: 'tools_forbidden_by_user',
          message: '你要求本轮不调用工具，但当前没有可用的纯聊天回复能力。',
        };
      }
      try {
        throwIfMaidAborted(context?.signal);
        const chatResult = await chatResponder(input, context, {
          plan: {
            ok: false,
            status: 'unsupported',
            reason: 'tools_forbidden_by_user',
            message: '用户明确要求本轮不调用工具。',
          },
        });
        throwIfMaidAborted(context?.signal);
        if (chatResult?.ok && trim(chatResult.message)) {
          return {
            ok: true,
            status: chatResult.status || 'responded',
            responseType: 'chat',
            source: chatResult.source || 'maid_chat_responder',
            input: trim(input),
            message: trim(chatResult.message),
          };
        }
        return {
          ok: false,
          status: chatResult?.status || 'failed',
          responseType: 'chat',
          input: trim(input),
          reason: chatResult?.reason || 'maid_chat_failed',
          message: chatResult?.message || '女仆暂时无法在不调用工具的前提下回答。',
        };
      } catch (error) {
        if (isMaidAbortError(error, context?.signal)) throw error;
        logger?.warn?.('maid assistant no-tool chat response failed', error);
        return {
          ok: false,
          status: 'failed',
          responseType: 'chat',
          input: trim(input),
          reason: error?.message || 'maid_chat_failed',
          message: error?.message || '女仆暂时无法在不调用工具的前提下回答。',
        };
      }
    }
    let capabilityRoutingConfigOverride = null;
    if (typeof getCapabilityRoutingConfigOverride === 'function') {
      try {
        const override = getCapabilityRoutingConfigOverride({ input, context });
        if (isPlainObject(override)) capabilityRoutingConfigOverride = { ...override };
      } catch (error) {
        logger?.debug?.('maid capability routing override skipped', error);
      }
    }
    const callRoutedPlanner = async ({
      plannerFn,
      phase = 'planner',
      label = 'maid_planner',
      extraContext = {},
    } = {}) => {
      throwIfMaidAborted(context?.signal);
      const decisionContext = {
        ...context,
        ...(isPlainObject(extraContext) ? extraContext : {}),
      };
      if (typeof context?.onModelUsage === 'function') {
        // 标出这次调用属于规划还是 ReAct，并记下结束时间，供分段计时
        decisionContext.onModelUsage = usage => context.onModelUsage({ ...usage, phase: label, endedAt: Date.now() });
      }
      let snapshot = null;
      if (capabilityRoutingRuntime && typeof capabilityRoutingRuntime.prepareDecision === 'function') {
        try {
          snapshot = capabilityRoutingRuntime.prepareDecision({
            requestId: trim(context?.capabilityRequestId),
            input,
            context: decisionContext,
            steps: Array.isArray(decisionContext.maidReactSteps) ? decisionContext.maidReactSteps : [],
            phase,
            configOverride: capabilityRoutingConfigOverride,
          });
          if (snapshot) decisionContext.capabilitySnapshot = snapshot;
        } catch (error) {
          logger?.debug?.('maid capability retrieval skipped', error);
        }
      }
      let decision = null;
      try {
        throwIfMaidAborted(context?.signal);
        decision = await callModelWithTimeout(() => plannerFn(input, decisionContext), { label });
        throwIfMaidAborted(context?.signal);
      } catch (error) {
        const cancelled = isMaidAbortError(error, context?.signal);
        if (!cancelled && snapshot && capabilityRoutingRuntime && typeof capabilityRoutingRuntime.observeDecision === 'function') {
          try {
            capabilityRoutingRuntime.observeDecision(snapshot, {
              ok: false,
              reason: 'model_call_failed',
            }, { countForRecall: false });
          } catch {}
        }
        throw error;
      }
      if (snapshot && capabilityRoutingRuntime && typeof capabilityRoutingRuntime.observeDecision === 'function') {
        try {
          return capabilityRoutingRuntime.observeDecision(snapshot, decision);
        } catch (error) {
          logger?.debug?.('maid capability decision observation skipped', error);
        }
      }
      return decision;
    };
    const authorizeDeterministicWorkflowPlan = (workflowPlan = {}, steps = []) => {
      if (
        !workflowPlan?.ok ||
        !capabilityRoutingRuntime
      ) return workflowPlan;
      try {
        if (typeof capabilityRoutingRuntime.authorizeWorkflowPlan === 'function') {
          return capabilityRoutingRuntime.authorizeWorkflowPlan({
            requestId: trim(context?.capabilityRequestId),
            parentPlan: (Array.isArray(steps) ? steps.at(-1) : null) || {},
            workflowPlan,
            context,
          }) || workflowPlan;
        }
        if (
          typeof capabilityRoutingRuntime.prepareDecision !== 'function' ||
          typeof capabilityRoutingRuntime.observeDecision !== 'function'
        ) return workflowPlan;
        const snapshot = capabilityRoutingRuntime.prepareDecision({
          requestId: trim(context?.capabilityRequestId),
          input,
          context: {
            ...context,
            maidReactSteps: projectMaidReactStepsForModel(steps),
          },
          steps: projectMaidReactStepsForModel(steps),
          phase: 'deterministic_workflow',
          configOverride: capabilityRoutingConfigOverride,
        });
        return snapshot
          ? capabilityRoutingRuntime.observeDecision(snapshot, workflowPlan, {
              countForRecall: false,
              metricEligible: false,
            })
          : workflowPlan;
      } catch (error) {
        logger?.debug?.('maid deterministic workflow capability snapshot skipped', error);
        return workflowPlan;
      }
    };

    let pendingImportedCardWorkflow = null;
    if (!context.runContinuation && typeof agentTaskRuntime?.listRuns === 'function') {
      try {
        pendingImportedCardWorkflow = resolvePendingMaidImportedCardWorkflow(
          agentTaskRuntime.listRuns({ kind: 'maid_assistant', limit: 20 }),
          { context },
        );
      } catch (error) {
        logger?.debug?.('maid imported-card pending workflow lookup skipped', error);
      }
    }
    const importedCardConfirmation = pendingImportedCardWorkflow
      ? classifyMaidImportedCardConfirmation(input)
      : 'none';
    if (pendingImportedCardWorkflow && importedCardConfirmation === 'cancel') {
      if (typeof agentTaskRuntime?.finishRun === 'function') {
        try {
          agentTaskRuntime.finishRun(pendingImportedCardWorkflow.runId, {
            status: 'cancelled',
            summary: '用户取消了导入角色卡建房清单。',
            cancelReason: 'user_cancelled_pending_workflow',
            metadata: {
              maidStatus: 'cancelled',
              pendingWorkflow: {
                ...pendingImportedCardWorkflow.snapshot,
                state: 'cancelled',
                cancelledAt: Date.now(),
              },
            },
          });
        } catch {}
      }
      return {
        ok: true,
        status: 'cancelled',
        responseType: 'workflow',
        input: trim(input),
        message: '已取消上一份导入角色卡建房清单，没有执行任何写入。',
      };
    }
    if (pendingImportedCardWorkflow && importedCardConfirmation === 'confirm') {
      return runImportedCardApplyWorkflow({
        input,
        pending: pendingImportedCardWorkflow,
        context: {
          ...context,
          operationIntentPolicy: {
            mode: 'write_allowed',
            source: 'frozen_workflow_confirmation',
            reason: 'confirmed_imported_card_session_setup',
          },
        },
        tracker,
        authorizePlan: authorizeDeterministicWorkflowPlan,
      });
    }
    const importedCardIntent = classifyMaidImportedCardWorkflowIntent(input);
    if (importedCardIntent.matched && typeof importedCardClassifier === 'function') {
      return runImportedCardPreviewWorkflow({
        input,
        intent: importedCardIntent,
        context,
        tracker,
        authorizePlan: authorizeDeterministicWorkflowPlan,
      });
    }

    // 上一轮留下的“待确认删除清单”：明确确认则原样执行，取消则作废，说了别的就视为放弃
    let confirmedPendingPlan = null;
    if (!context.runContinuation && typeof agentTaskRuntime?.listRuns === 'function') {
      let pendingAction = null;
      try {
        pendingAction = resolvePendingMaidAction(agentTaskRuntime.listRuns({ kind: 'maid_assistant', limit: 100 }), { context });
      } catch (error) {
        logger?.debug?.('maid pending action lookup skipped', error);
      }
      if (context.pendingActionSubmissionId && !pendingAction && !pendingImportedCardWorkflow) {
        return { ok: false, status: 'cancelled', reason: 'pending_action_unavailable', message: '这份待确认清单已结束或过期，没有执行任何操作。' };
      }
      if (pendingAction) {
        const reply = classifyMaidPendingActionReply(input, { voice: Boolean(trim(context.voiceCallId)) });
        const closePending = (state, status, summary) => {
          try {
            agentTaskRuntime.finishRun?.(pendingAction.runId, {
              status,
              summary,
              ...(status === 'cancelled' ? { cancelReason: 'user_cancelled_pending_action' } : {}),
              metadata: { maidStatus: status, pendingWorkflow: { ...pendingAction.snapshot, state, closedAt: Date.now() } },
            });
          } catch {}
        };
        if (reply === 'cancel') {
          closePending('cancelled', 'cancelled', '用户取消了待确认的删除清单。');
          return {
            ok: true,
            status: 'cancelled',
            responseType: 'workflow',
            input: trim(input),
            message: '好的，已取消上一份待确认的删除清单，没有删除任何内容。',
          };
        }
        if (reply === 'ambiguous') {
          // 语音里的“好 / 可以”不算确认：清单保留，请用户明确回答。
          // 这一轮不标记为待确认，之后的“允许”仍指向原来那份清单所属的任务。
          return {
            ok: true,
            status: 'responded',
            responseType: 'workflow',
            input: trim(input),
            message: '要执行这份删除清单，请明确说「允许」；不需要的话说「取消」。',
          };
        }
        if (reply === 'confirm') {
          if (pendingAction.snapshot.version !== 2 || !pendingAction.snapshot.targets?.length) {
            closePending('superseded', 'cancelled', '旧版删除预览缺少目标快照，需要重新预览。');
            return { ok: false, status: 'failed', reason: 'pending_action_needs_preview', message: '这份删除预览没有完整的目标记录，请重新预览后再确认。' };
          }
          closePending('consumed', 'succeeded', '用户已确认，按清单执行。');
          confirmedPendingPlan = authorizeDeterministicWorkflowPlan(buildConfirmedPendingActionPlan(pendingAction), []);
          Object.assign(context, pendingAction.snapshot.context);
          // 用户确认的正是这份写入清单：本轮按允许写入处理，不再额外弹“只读请求要不要写入”（删除本身的确认照常）
          context.operationIntentPolicy = { mode: 'write_allowed', source: 'confirmed_pending_action', reason: 'user_confirmed_pending_action' };
        } else {
          // 此时还不知道是改说别的事还是修改清单（由模型判断），摘要措辞对两种情况都成立
          closePending('superseded', 'cancelled', '收到新的指示，原待确认的删除清单已作废，未执行删除。');
          // 这句可能是对清单的修改（“确认，但保留乙”）：含义交给模型判断。本次任务允许使用原清单的删除功能，
          // 不因这句话没写“删除”二字被高风险检查挡掉；真正删除时 APP 的删除确认照常弹出。
          context.pendingActionRevision = {
            featureId: trim(pendingAction.snapshot.featureId, pendingAction.snapshot.toolName),
            toolName: trim(pendingAction.snapshot.toolName),
          };
          // 回复待确认的写入清单不是只读查询（“确认”一词会被当成“确认一下”）
          if (context.operationIntentPolicy?.mode === 'read_only') {
            context.operationIntentPolicy = { mode: 'unspecified', source: 'pending_action_revision', reason: 'reply_to_pending_write_list' };
          }
        }
      }
    }

    let plan = confirmedPendingPlan || await callRoutedPlanner({ plannerFn: planner, phase: 'planner', label: 'maid_planner' });
    if (
      plan?.ok === true &&
      plan?.action === 'final' &&
      plan?.source === 'maid_provider_fc' &&
      trim(plan?.message)
    ) {
      return {
        ok: true,
        status: 'responded',
        responseType: 'chat',
        source: plan.source,
        input: trim(input),
        finalDecision: clone(plan),
        message: trim(plan.message),
      };
    }
    if (!plan?.ok) {
      let reactRecoveryFailure = null;
      if (shouldAttemptReactPlanRecovery({ input, plan, reactPlanner })) {
        try {
          const decision = await callRoutedPlanner({
            plannerFn: reactPlanner,
            phase: 'react_recovery',
            label: 'maid_react',
            extraContext: {
              maidReactSteps: [],
              plannerFailure: clone(plan),
              lastPlan: clone(plan),
              lastToolOk: false,
            },
          });
          if (decision?.ok && decision.action === 'final') {
            return {
              ok: true,
              status: 'succeeded',
              responseType: 'react',
              source: decision.source || 'maid_react_recovery',
              input: trim(input),
              finalDecision: clone(decision),
              message: trim(decision.message),
            };
          }
          if (decision?.ok && decision.action === 'tool') {
            plan = decision;
          } else if (decision && !decision.ok && decision.reason !== 'unsupported_intent') {
            const stoppedReason = decision.reason || 'react_recovery_failed';
            const continuable = isContinuableReactStop(stoppedReason);
            reactRecoveryFailure = {
              ok: false,
              status: continuable ? 'interrupted' : 'failed',
              responseType: 'react',
              input: trim(input),
              partial: continuable,
              continuable,
              continueHint: continuable ? buildContinueHint({
                input,
                pendingPlan: {},
                steps: [],
                reason: stoppedReason,
              }) : '',
              reason: stoppedReason,
              message: decision.message || decision.reason || '女仆暂时无法继续执行。',
              reactStoppedReason: stoppedReason,
            };
          }
        } catch (error) {
          if (isMaidAbortError(error, context?.signal)) throw error;
          logger?.warn?.('maid assistant react recovery failed', error);
          reactRecoveryFailure = {
            ok: false,
            status: 'failed',
            responseType: 'react',
            input: trim(input),
            reason: error?.message || 'maid_react_recovery_failed',
            message: error?.message || '女仆暂时无法继续执行。',
          };
        }
      }
      if (plan?.ok) {
        // ReAct recovered a tool plan; continue through the normal execution loop.
      } else if (reactRecoveryFailure) {
        return reactRecoveryFailure;
      } else {
        const shouldTryChat = Boolean(
          trim(input) &&
          plan?.reason !== 'empty_input' &&
          typeof chatResponder === 'function',
        );
        if (shouldTryChat) {
          try {
            throwIfMaidAborted(context?.signal);
            const chatResult = await chatResponder(input, context, { plan });
            throwIfMaidAborted(context?.signal);
            if (chatResult?.ok && trim(chatResult.message)) {
              return {
                ok: true,
                status: chatResult.status || 'responded',
                responseType: 'chat',
                source: chatResult.source || 'maid_chat_responder',
                input: trim(input),
                message: trim(chatResult.message),
              };
            }
            if (chatResult?.status === 'failed') {
              return {
                ok: false,
                status: 'failed',
                responseType: 'chat',
                input: trim(input),
                reason: chatResult.reason || 'maid_chat_failed',
                message: chatResult.message || '女仆暂时无法回复。',
              };
            }
          } catch (error) {
            if (isMaidAbortError(error, context?.signal)) throw error;
            logger?.warn?.('maid assistant chat response failed', error);
            return {
              ok: false,
              status: 'failed',
              responseType: 'chat',
              input: trim(input),
              reason: error?.message || 'maid_chat_failed',
              message: error?.message || '女仆暂时无法回复。',
            };
          }
        }
        return {
          ok: false,
          status: plan?.status || 'unsupported',
          reason: plan?.reason || 'unsupported_intent',
          message: plan?.message || '暂时还不会执行这个请求。',
          input: trim(input),
        };
      }
    }
    plan = applyMaidPresentationPolicy(plan, context.presentationIntent);
    let currentPlan = plan;
    let lastExecution = null;
    let lastOutput = null;
    let lastOk = false;
    let cyclesUsed = 0;
    const steps = [];
    const crossRunFallbackPlans = new Map();
    let stepBudget = resolveReactStepBudget({
      input,
      plan,
      context,
      configuredMaxReactSteps: maxReactSteps,
    });
    let maxSteps = stepBudget.maxSteps;
    const expandStepBudget = (nextPlan = {}) => {
      const next = resolveReactStepBudget({
        input,
        plan: nextPlan,
        context,
        configuredMaxReactSteps: maxReactSteps,
      });
      if (next.maxSteps <= maxSteps) return;
      maxSteps = next.maxSteps;
      stepBudget = {
        ...stepBudget,
        maxSteps,
        recommended: Math.max(stepBudget.recommended, next.recommended),
        actionSteps: Math.max(stepBudget.actionSteps, next.actionSteps),
        verificationReserve: Math.max(stepBudget.verificationReserve, next.verificationReserve),
        expandedByToolName: next.toolName,
      };
    };
    const failureLimit = Math.max(2, Math.min(8, Math.trunc(Number(
      context.repeatedFailureLimit || repeatedFailureLimit,
    )) || 3));
    try {
      const loopProbe = (stage) => {
        try { globalThis.__maidLoopProbe = { stage, at: Date.now() }; } catch {}
      };
      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
        throwIfMaidAborted(context?.signal);
        cyclesUsed += 1;
        loopProbe(`step-${stepIndex}:start`);
        currentPlan = advanceRepeatedWorldbookPreviewToApply({
          input,
          plan: currentPlan,
          steps,
          operationIntentPolicy: context.operationIntentPolicy,
        });
        context.maidSourceGrounding = buildMaidSourceGroundingContext({ input, steps });
        expandStepBudget(currentPlan);
        let crossRunResumeMatch = resolveCrossRunResumePlan({
          plan: currentPlan,
          continuation: context.runContinuation,
          steps,
        });
        if (crossRunResumeMatch?.status === 'verify') {
          const originalPlan = currentPlan;
          let verificationPlan = crossRunResumeMatch.verificationPlan;
          if (
            capabilityRoutingRuntime &&
            typeof capabilityRoutingRuntime.authorizeVerification === 'function'
          ) {
            try {
              verificationPlan = capabilityRoutingRuntime.authorizeVerification({
                requestId: trim(context?.capabilityRequestId),
                parentPlan: originalPlan,
                verificationPlan,
                context,
              });
            } catch (error) {
              logger?.debug?.('maid cross-run verification capability snapshot skipped', error);
            }
          }
          crossRunFallbackPlans.set(crossRunResumeMatch.previous.argsDigest, clone(originalPlan));
          currentPlan = applyMaidPresentationPolicy(verificationPlan, context.presentationIntent);
          crossRunResumeMatch = null;
        }
        if (trim(currentPlan.response) && typeof context?.onStatus === 'function') {
          context.onStatus({
            stage: stepIndex === 0 ? 'planned' : 'react_planned',
            tone: 'thinking',
            message: trim(currentPlan.response),
            plan: clone(currentPlan),
          });
        }

        let execution = null;
        const reusableSessionCreate = findVerifiedIdempotentSessionCreate(currentPlan, steps);
        const reusableGeneratedMedia = findAppliedGeneratedMedia({
          input,
          plan: currentPlan,
          steps,
        });
        // 删除幂等：本轮已删除的目标不再交给工具，全部已删则整步跳过
        const alreadyDeleted = findAlreadyDeletedTargets(currentPlan, steps);
        if (crossRunResumeMatch?.status === 'verified') {
          execution = buildReusedCrossRunExecution(crossRunResumeMatch);
        } else if (reusableSessionCreate) {
          execution = buildReusedSessionCreateExecution(reusableSessionCreate);
        } else if (reusableGeneratedMedia) {
          execution = buildReusedGeneratedMediaExecution(reusableGeneratedMedia);
        } else if (isRepeatedSuccessfulTodoWrite(currentPlan, steps)) {
          execution = buildUnchangedTodoExecution();
        } else if (alreadyDeleted && !alreadyDeleted.remaining.length) {
          execution = buildAlreadyDeletedExecution(alreadyDeleted);
        } else {
          try {
            loopProbe(`step-${stepIndex}:tool-exec`);
            throwIfMaidAborted(context?.signal);
            execution = await executePlan(
              alreadyDeleted ? stripAlreadyDeletedTargets(currentPlan, alreadyDeleted) : currentPlan,
              context,
              tracker,
            );
            if (alreadyDeleted) {
              execution = execution && hasOwn(execution, 'output')
                ? { ...execution, output: appendAlreadyDeletedResults(execution.output, alreadyDeleted) }
                : appendAlreadyDeletedResults(execution, alreadyDeleted);
            }
            loopProbe(`step-${stepIndex}:tool-done`);
          } catch (error) {
            if (isMaidAbortError(error, context?.signal)) throw error;
            logger?.warn?.('maid assistant tool execution failed', error);
            execution = {
              output: makeToolErrorOutput(currentPlan, error),
              guided: false,
              guide: null,
              message: '',
            };
          }
        }
        const output = execution?.output ?? execution;
        let ok = isToolOutputOk(output);
        let observedPlan = currentPlan;
        let observedExecution = execution;
        let observedOutput = output;
        steps.push(buildReactStepSnapshot({
          index: stepIndex + 1,
          plan: currentPlan,
          execution,
          output,
          ok,
        }));
        if (ok && reactPlanner) {
          loopProbe(`step-${stepIndex}:verify-check`);
          let verificationPlan = buildAutoVerificationPlan(currentPlan, output, steps);
          if (
            verificationPlan &&
            capabilityRoutingRuntime &&
            typeof capabilityRoutingRuntime.authorizeVerification === 'function'
          ) {
            try {
              verificationPlan = capabilityRoutingRuntime.authorizeVerification({
                requestId: trim(context?.capabilityRequestId),
                parentPlan: currentPlan,
                verificationPlan,
                context,
              });
            } catch (error) {
              logger?.debug?.('maid verification capability snapshot skipped', error);
              if (trim(currentPlan?.capabilityRoutingMode) === 'candidate') {
                verificationPlan = {
                  ...verificationPlan,
                  candidateSnapshotId: trim(currentPlan?.candidateSnapshotId),
                  retrieverVersion: trim(currentPlan?.retrieverVersion),
                  capabilityRoutingMode: 'candidate',
                };
              }
            }
          }
          if (verificationPlan) {
            if (typeof context?.onStatus === 'function') {
              context.onStatus({
                stage: 'verifying',
                tone: 'thinking',
                message: trim(verificationPlan.response),
                plan: clone(verificationPlan),
                steps: clone(steps),
              });
            }
            let verificationExecution = null;
            try {
              throwIfMaidAborted(context?.signal);
              verificationExecution = await executePlan(verificationPlan, context, tracker);
            } catch (error) {
              if (isMaidAbortError(error, context?.signal)) throw error;
              logger?.warn?.('maid assistant verification failed', error);
              verificationExecution = {
                output: makeToolErrorOutput(verificationPlan, error),
                guided: false,
                guide: null,
                message: '',
              };
            }
            const verificationOutput = verificationExecution?.output ?? verificationExecution;
            const verificationOk = isToolOutputOk(verificationOutput);
            steps.push(buildReactStepSnapshot({
              index: steps.length + 1,
              plan: verificationPlan,
              execution: verificationExecution,
              output: verificationOutput,
              ok: verificationOk,
            }));
            ok = verificationOk;
            observedPlan = verificationPlan;
            observedExecution = verificationExecution;
            observedOutput = verificationOutput;
          }
        }
        if (isToolOutputCancelled(observedOutput)) {
          return {
            ...buildMaidCancelledResult({ input, steps }),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            message: summarizeToolFailure(observedOutput),
          };
        }
        lastExecution = observedExecution;
        lastOutput = observedOutput;
        lastOk = ok;

        const crossRunArgsDigest = trim(observedPlan?.metadata?.crossRunArgsDigest);
        if (
          ok &&
          crossRunArgsDigest &&
          !maidContinuationRefsExistInOutput(
            observedPlan?.metadata?.expectedResourceRefs,
            observedOutput,
          )
        ) {
          const fallbackPlan = crossRunFallbackPlans.get(crossRunArgsDigest);
          if (fallbackPlan) {
            currentPlan = fallbackPlan;
            expandStepBudget(currentPlan);
            continue;
          }
        }

        const pendingWorkScopePlan = ok
          ? buildPendingMaidWorkScopePlan({ input, steps })
          : null;
        if (pendingWorkScopePlan) {
          currentPlan = applyMaidPresentationPolicy(
            authorizeDeterministicWorkflowPlan(pendingWorkScopePlan, steps),
            context.presentationIntent,
          );
          expandStepBudget(currentPlan);
          continue;
        }

        const conditionalProfileCreateProgress = ok
          ? buildMaidConditionalProfileCreateProgress({
              input,
              operationIntentPolicy: context.operationIntentPolicy,
              steps,
            })
          : null;
        if (
          conditionalProfileCreateProgress?.complete &&
          conditionalProfileCreateProgress.finalDecision
        ) {
          return {
            ok: true,
            status: 'succeeded',
            responseType: 'react',
            input: trim(input),
            plan: clone(plan),
            finalDecision: clone(conditionalProfileCreateProgress.finalDecision),
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            reason: '',
            message: conditionalProfileCreateProgress.finalDecision.message,
          };
        }
        if (conditionalProfileCreateProgress?.nextPlan) {
          currentPlan = applyMaidPresentationPolicy(
            authorizeDeterministicWorkflowPlan(conditionalProfileCreateProgress.nextPlan, steps),
            context.presentationIntent,
          );
          expandStepBudget(currentPlan);
          continue;
        }

        const structuredReadProgress = ok
          ? buildMaidStructuredReadProgress({
              input,
              operationIntentPolicy: context.operationIntentPolicy,
              steps,
            })
          : null;
        if (structuredReadProgress?.complete && structuredReadProgress.finalDecision) {
          return {
            ok: true,
            status: 'succeeded',
            responseType: 'react',
            input: trim(input),
            plan: clone(plan),
            finalDecision: clone(structuredReadProgress.finalDecision),
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            reason: '',
            message: structuredReadProgress.finalDecision.message,
          };
        }
        if (structuredReadProgress?.nextPlan) {
          currentPlan = applyMaidPresentationPolicy(
            authorizeDeterministicWorkflowPlan(structuredReadProgress.nextPlan, steps),
            context.presentationIntent,
          );
          expandStepBudget(currentPlan);
          continue;
        }

        const deterministicReadDecision = ok
          ? buildDeterministicMaidReadDecision({
              input,
              operationIntentPolicy: context.operationIntentPolicy,
              steps,
            })
          : null;
        if (deterministicReadDecision) {
          return {
            ok: true,
            status: 'succeeded',
            responseType: 'react',
            input: trim(input),
            plan: clone(plan),
            finalDecision: clone(deterministicReadDecision),
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            reason: '',
            message: deterministicReadDecision.message,
          };
        }

        const revealWorkflowActive = (Array.isArray(steps) ? steps : []).some(step => (
          trim(step?.metadata?.workflowTransition) === 'result_reveal'
        ));
        if (ok && revealWorkflowActive) {
          const nextRevealPlan = buildPendingMaidResultRevealPlan({
            presentationIntent: context.presentationIntent,
            steps,
          });
          if (nextRevealPlan) {
            currentPlan = applyMaidPresentationPolicy(
              authorizeDeterministicWorkflowPlan(nextRevealPlan, steps),
              context.presentationIntent,
            );
            expandStepBudget(currentPlan);
            continue;
          }
          const finalMessage = getMaidRevealFinalMessage(steps) || '任务已经完成，并已打开主要结果。';
          return {
            ok: true,
            status: 'succeeded',
            responseType: 'react',
            input: trim(input),
            plan: clone(plan),
            finalDecision: {
              ok: true,
              action: 'final',
              message: finalMessage,
              source: 'deterministic_result_reveal',
            },
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            reason: '',
            message: finalMessage,
          };
        }

        const sameTool = getConsecutiveSameToolCount(steps);
        if (sameTool.count >= 8) {
          const reason = 'same_tool_overuse';
          const message = `工具「${sameTool.toolName}」已连续调用 ${sameTool.count} 次仍未推进到下一步，已停止；请检查上一步结果并改用其他工具继续。`;
          return {
            ok: false,
            status: 'interrupted',
            responseType: 'react',
            reason,
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            partial: true,
            continuable: true,
            failureCode: reason,
            continueHint: buildContinueHint({ input, pendingPlan: null, steps, reason: message }),
            message,
          };
        }
        const repeatedSuccess = getConsecutiveRepeatedSuccess(steps);
        if (repeatedSuccess.count >= 3 && trim(steps.at(-1)?.output?.reason) === ALREADY_DELETED_REASON) {
          const message = `${trim(steps.at(-1)?.summary) || '目标已在本轮删除'}；已停止重复删除。`;
          return {
            ok: true,
            status: 'succeeded',
            responseType: 'react',
            input: trim(input),
            plan: clone(plan),
            finalDecision: { ok: true, action: 'final', message, source: 'already_deleted_guard' },
            output: clone(observedOutput),
            steps: clone(steps),
            guided: false,
            guide: null,
            reason: '',
            message,
          };
        }
        if (repeatedSuccess.count >= 3) {
          const reason = 'repeated_tool_loop';
          const message = `同一工具「${repeatedSuccess.toolName || '未知工具'}」用相同参数连续调用 ${repeatedSuccess.count} 次没有产生新进展，已停止；说“继续”时请直接执行清单上的具体任务。`;
          return {
            ok: false,
            status: 'interrupted',
            responseType: 'react',
            reason,
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            partial: true,
            continuable: true,
            failureCode: reason,
            continueHint: buildContinueHint({ input, pendingPlan: null, steps, reason: message }),
            message,
          };
        }
        const repeatedFailure = getConsecutiveRepeatedFailure(steps);
        if (repeatedFailure.count >= failureLimit) {
          const reason = 'repeated_tool_failure';
          const message = `同一工具「${repeatedFailure.toolName || '未知工具'}」用相同参数连续失败 ${repeatedFailure.count} 次，已停止继续重试。`;
          return {
            ok: false,
            status: 'failed',
            responseType: 'react',
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            partial: true,
            continuable: false,
            reason,
            message,
            reactStoppedReason: reason,
            reactStepBudget: {
              used: cyclesUsed,
              toolSteps: steps.length,
              maxSteps,
              hardMax: stepBudget.hardMax,
              actionSteps: stepBudget.actionSteps,
              verificationReserve: stepBudget.verificationReserve,
              repeatedFailureLimit: failureLimit,
            },
          };
        }

        if (!reactPlanner) {
          if (!ok) {
            return {
              ok: false,
              status: 'failed',
              input: trim(input),
              plan: clone(observedPlan),
              output: clone(observedOutput),
              steps: clone(steps),
              guided: Boolean(observedExecution?.guided),
              guide: clone(observedExecution?.guide || null),
              reason: summarizeToolFailure(observedOutput),
              message: summarizeToolFailure(observedOutput),
            };
          }
          const pendingRevealPlan = buildPendingMaidResultRevealPlan({
            presentationIntent: context.presentationIntent,
            steps,
            decision: {
              message: buildSuccessMessage({
                plan: observedPlan,
                output: observedOutput,
                execution: observedExecution,
              }),
            },
          });
          if (pendingRevealPlan) {
            currentPlan = applyMaidPresentationPolicy(
              authorizeDeterministicWorkflowPlan(pendingRevealPlan, steps),
              context.presentationIntent,
            );
            expandStepBudget(currentPlan);
            continue;
          }
          return {
            ok: true,
            status: 'succeeded',
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            message: buildSuccessMessage({ plan: observedPlan, output: observedOutput, execution: observedExecution }),
          };
        }

        if (typeof context?.onStatus === 'function') {
          context.onStatus({
            stage: ok ? 'observed' : 'repairing',
            // 写死的过程提示用 progress（UI 收进轻量 live 行）；模型生成的话语保持 thinking（正常气泡）
            tone: 'progress',
            message: ok ? '我已经取得结果，正在整理给你。' : '工具遇到错误，我正在尝试修正参数。',
            steps: clone(steps),
          });
        }

        loopProbe(`step-${stepIndex}:react-call`);
        throwIfMaidAborted(context?.signal);
        const modelReactSteps = projectMaidReactStepsForModel(steps);
        const decision = await callRoutedPlanner({
          plannerFn: reactPlanner,
          phase: 'react',
          label: 'maid_react',
          extraContext: {
            maidReactSteps: modelReactSteps,
            lastPlan: clone(observedPlan),
            lastOutput: clone(modelReactSteps.at(-1)?.output ?? observedOutput),
            lastToolOk: ok,
          },
        });
        loopProbe(`step-${stepIndex}:react-done`);
        if (!decision?.ok) {
          if (ok) {
            const stoppedReason = decision?.reason || 'react_stopped';
            const continuable = isContinuableReactStop(stoppedReason);
            return {
              ok: false,
              status: 'interrupted',
              responseType: 'react',
              input: trim(input),
              plan: clone(observedPlan),
              output: clone(observedOutput),
              steps: clone(steps),
              guided: Boolean(observedExecution?.guided),
              guide: clone(observedExecution?.guide || null),
              partial: true,
              continuable,
              continueHint: continuable ? buildContinueHint({
                input,
                pendingPlan: observedPlan,
                steps,
                reason: stoppedReason,
              }) : '',
              reason: stoppedReason,
              message: buildInterruptedMessage({ decision, plan: observedPlan, output: observedOutput, execution: observedExecution }),
              reactStoppedReason: stoppedReason,
              reactStepBudget: {
                used: cyclesUsed,
                toolSteps: steps.length,
                maxSteps,
                hardMax: stepBudget.hardMax,
                recommended: stepBudget.recommended,
                actionSteps: stepBudget.actionSteps,
                verificationReserve: stepBudget.verificationReserve,
                initialToolName: stepBudget.toolName,
              },
            };
          }
          return {
            ok: false,
            status: 'failed',
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            reason: decision?.message || decision?.reason || summarizeToolFailure(observedOutput),
            message: decision?.message || summarizeToolFailure(observedOutput),
          };
        }
        if (decision.action === 'final') {
          const pendingWorkflowPlan = buildPendingWorldbookPreviewApplyPlan({
            input,
            steps,
            decision,
            operationIntentPolicy: context.operationIntentPolicy,
          }) ||
            buildPendingExplicitMaidChatPlan({ input, steps, decision }) ||
            buildPendingMaidFinalStatePlan({ input, steps, decision }) ||
            buildPendingMaidResultRevealPlan({
              presentationIntent: context.presentationIntent,
              steps,
              decision,
            });
          if (pendingWorkflowPlan) {
            currentPlan = applyMaidPresentationPolicy(
              authorizeDeterministicWorkflowPlan(pendingWorkflowPlan, steps),
              context.presentationIntent,
            );
            expandStepBudget(currentPlan);
            continue;
          }
          // 删除预览后收尾：本轮结束为“待确认”，冻结清单等用户下一句确认
          const pendingAction = buildMaidPendingActionFromSteps(steps, { context });
          if (pendingAction) {
            return {
              ok: true,
              status: 'awaiting_confirmation',
              responseType: 'react',
              input: trim(input),
              plan: clone(plan),
              finalDecision: clone(decision),
              output: clone(observedOutput),
              steps: clone(steps),
              pendingWorkflow: pendingAction,
              reason: '',
              message: trim(decision.message),
            };
          }
          // 成败看目标的最终状态，而不是只看最后一步：对已完成目标的多余重复、
          // 或写入都已达成后的收尾读取失败，不把整次任务判为失败。
          const outcome = resolveMaidRunOutcome({
            lastOk: ok,
            steps,
            isWriteTool: (toolName) => {
              const writes = findAppFeature(toolName)?.writes;
              return typeof writes === 'boolean' ? writes : undefined;
            },
          });
          return {
            ok: outcome.ok,
            status: outcome.ok ? 'succeeded' : 'failed',
            responseType: 'react',
            input: trim(input),
            plan: clone(plan),
            finalDecision: clone(decision),
            output: clone(observedOutput),
            steps: clone(steps),
            guided: Boolean(observedExecution?.guided),
            guide: clone(observedExecution?.guide || null),
            reason: outcome.ok ? '' : summarizeToolFailure(observedOutput),
            ...(outcome.reason ? { outcomeReason: outcome.reason } : {}),
            message: trim(decision.message),
          };
        }
        if (decision.action === 'tool') {
          const verifiedBinding = findVerifiedWorldbookBindingForTailRead(decision, steps, input);
          if (verifiedBinding) {
            const message = `世界书绑定已由工具完成并读回验证；没有再对「${verifiedBinding.target}」执行重复核对。`;
            return {
              ok: true,
              status: 'succeeded',
              responseType: 'react',
              input: trim(input),
              plan: clone(plan),
              finalDecision: {
                ok: true,
                action: 'final',
                message,
                source: 'verified_write_tail_read_guard',
              },
              output: clone(observedOutput),
              steps: clone(steps),
              guided: Boolean(observedExecution?.guided),
              guide: clone(observedExecution?.guide || null),
              reason: '',
              message,
            };
          }
          if (shouldStopDuplicateWorldbookWriteAfterVerification(decision, steps)) {
            return {
              ok: true,
              status: 'succeeded',
              responseType: 'react',
              input: trim(input),
              plan: clone(plan),
              finalDecision: {
                ok: true,
                action: 'final',
                message: '已经写入并读回验证成功；为避免重复追加相同世界书条目，本轮未再次执行重复写入。',
                source: 'duplicate_write_guard',
              },
              output: clone(observedOutput),
              steps: clone(steps),
              guided: Boolean(observedExecution?.guided),
              guide: clone(observedExecution?.guide || null),
              reason: '',
              message: '已经写入并读回验证成功；为避免重复追加相同世界书条目，本轮未再次执行重复写入。',
            };
          }
          currentPlan = applyMaidPresentationPolicy(decision, context.presentationIntent);
          expandStepBudget(currentPlan);
          continue;
        }
        if (!ok) {
          return {
            ok: false,
            status: 'failed',
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            reason: summarizeToolFailure(observedOutput),
            message: summarizeToolFailure(observedOutput),
          };
        }
        return {
          ok: true,
          status: 'succeeded',
          input: trim(input),
          plan: clone(observedPlan),
          output: clone(observedOutput),
          steps: clone(steps),
          guided: Boolean(observedExecution?.guided),
          guide: clone(observedExecution?.guide || null),
          message: buildSuccessMessage({ plan: observedPlan, output: observedOutput, execution: observedExecution }),
        };
      }

      if (!lastOk) {
        return {
          ok: false,
          status: 'failed',
          input: trim(input),
          plan: clone(currentPlan),
          output: clone(lastOutput),
          steps: clone(steps),
          reason: summarizeToolFailure(lastOutput),
          message: summarizeToolFailure(lastOutput),
        };
      }
      return {
        ok: false,
        status: 'interrupted',
        responseType: 'react',
        input: trim(input),
        plan: clone(currentPlan),
        pendingPlan: clone(currentPlan),
        output: clone(lastOutput),
        steps: clone(steps),
        guided: Boolean(lastExecution?.guided),
        guide: clone(lastExecution?.guide || null),
        partial: true,
        continuable: true,
        continueHint: buildContinueHint({
          input,
          pendingPlan: currentPlan,
          steps,
          reason: 'max_steps_reached',
        }),
        reason: 'max_steps_reached',
        message: buildInterruptedMessage({
          decision: { reason: 'max_steps_reached' },
          plan: currentPlan,
          output: lastOutput,
          execution: lastExecution,
          fallback: `已达到本轮执行预算（${cyclesUsed}/${maxSteps} 个执行轮，实际 ${steps.length} 个工具步骤）。你可以直接说“继续”，女仆会接着当前任务执行。`,
        }),
        reactStoppedReason: 'max_steps_reached',
        reactStepBudget: {
          used: cyclesUsed,
          toolSteps: steps.length,
          maxSteps,
          hardMax: stepBudget.hardMax,
          recommended: stepBudget.recommended,
          actionSteps: stepBudget.actionSteps,
          verificationReserve: stepBudget.verificationReserve,
          initialToolName: stepBudget.toolName,
        },
      };
    } catch (error) {
      if (isMaidAbortError(error, context?.signal)) {
        return buildMaidCancelledResult({ input, steps });
      }
      logger?.warn?.('maid assistant run failed', error);
      return {
        ok: false,
        status: 'failed',
        input: trim(input),
        plan: clone(currentPlan),
        steps: clone(steps),
        reason: error?.message || String(error || ''),
        message: error?.message || '女仆执行失败。',
      };
    }
  };

  // Called before queue acceptance as well as by direct agent callers. It only
  // resolves existing task ownership; natural-language execution stays with the planner.
  const prepareSkillTaskContext = (input = '', context = {}) => {
    if (context.maidSkillContextPrepared) return { context, useDraftSkills: false };
    const sourceRunId = trim(context.runContinuation?.sourceRunId) || extractMaidResumeRunId(input);
    const runs = agentTaskRuntime?.listRuns?.({ kind: 'maid_assistant', limit: 100 }) || [];
    const deletion = resolvePendingMaidAction(runs, { context });
    const imported = !deletion ? resolvePendingMaidImportedCardWorkflow(runs, { context }) : null;
    const pending = deletion || imported;
    const reply = deletion ? classifyMaidPendingActionReply(input, { voice: Boolean(trim(context.voiceCallId)) })
      : imported ? classifyMaidImportedCardConfirmation(input) : 'none';
    // 任务归属由代码判断：只有结构化续接（语音确认指明了任务）或明确的确认 / 取消，才接回待确认任务的房间、附图与技能快照。
    // 其他话（包括带条件的修改、无关的新请求）都是新任务：留在当前房间，含义交给模型判断，旧清单随后作废并把功能留给模型。
    const inheritPending = !sourceRunId && pending && (context.pendingActionSubmissionId || reply === 'confirm' || reply === 'cancel');
    const restoreId = sourceRunId || (inheritPending ? pending.runId : '');
    if (!restoreId) return { context, useDraftSkills: true };
    const run = agentTaskRuntime?.getRun?.(restoreId) || runs.find(item => item.id === restoreId);
    if (!run && !agentTaskRuntime) return { context: { ...context, maidSkillContext: context.maidSkillContext || createMaidSkillContext(), maidSkillContextPrepared: true }, useDraftSkills: false };
    if (!run) throw Object.assign(new Error('skill_snapshot_unavailable'), { code: 'skill_snapshot_unavailable' });
    const maidSkillContext = restoreMaidSkillContext(run) || createMaidSkillContext();
    return { context: { ...context, ...(run.metadata?.maidTaskInputs?.context || {}), maidSkillContext, maidSkillContextPrepared: true,
      ...(run.metadata?.maidTaskInputs ? { maidTaskInputs: clone(run.metadata.maidTaskInputs) } : {}),
      ...(inheritPending && run.metadata?.submissionId ? { pendingActionSubmissionId: run.metadata.submissionId } : {}) }, useDraftSkills: false };
  };

  const runPrompt = async (input = '', context = {}) => {
    const promptStartedAt = Date.now();
    try {
      throwIfMaidAborted(context?.signal);
    } catch {
      return buildMaidCancelledResult({ input, steps: [] });
    }
    let runContinuation = isPlainObject(context?.runContinuation)
      ? context.runContinuation
      : null;
    const resumeRunId = runContinuation ? '' : extractMaidResumeRunId(input);
    if (resumeRunId && typeof agentTaskRuntime?.getRun === 'function') {
      try {
        const sourceRun = agentTaskRuntime.getRun(resumeRunId);
        if (
          sourceRun?.kind === 'maid_assistant' &&
          (
            sourceRun?.metadata?.continuable === true ||
            ['failed', 'cancelled'].includes(trim(sourceRun?.status))
          )
        ) {
          runContinuation = resolveMaidRunContinuationFromRun(sourceRun);
        }
      } catch (error) {
        logger?.debug?.('maid run continuation lookup skipped', error);
      }
    }
    const maidConversationContextRef = isPlainObject(context?.maidConversationContextRef)
      ? context.maidConversationContextRef
      : { current: null };
    const requestContext = {
      ...(isPlainObject(context) ? context : {}),
      ...(runContinuation ? { runContinuation } : {}),
      maidConversationContextRef,
    };
    try {
      Object.assign(requestContext, prepareSkillTaskContext(input, requestContext).context);
      if (!requestContext.maidSkillContext) {
        const catalog = typeof getSkillCatalog === 'function' ? await getSkillCatalog() : undefined;
        requestContext.maidSkillContext = createMaidSkillContext({ catalog });
      }
    } catch (error) {
      return { ok: false, status: 'failed', reason: error.code || 'skill_store_unavailable', message: t('这次任务的技能版本已无法恢复，请重新发起任务') };
    }
    if (
      !isPlainObject(maidConversationContextRef.current) &&
      typeof prepareConversationContext === 'function'
    ) {
      try {
        const prepared = await prepareConversationContext({
          input,
          context: requestContext,
          taskType: 'maid_assistant',
        });
        throwIfMaidAborted(requestContext?.signal);
        if (isPlainObject(prepared)) maidConversationContextRef.current = prepared;
      } catch (error) {
        if (isMaidAbortError(error, requestContext?.signal)) {
          return buildMaidCancelledResult({ input, steps: [] });
        }
        logger?.debug?.('maid conversation context preparation skipped', error);
      }
    }
    let capabilityRequest = null;
    if (capabilityRoutingRuntime && typeof capabilityRoutingRuntime.beginRequest === 'function') {
      try {
        capabilityRequest = capabilityRoutingRuntime.beginRequest({ input, context: requestContext });
      } catch (error) {
        logger?.debug?.('maid capability request start skipped', error);
      }
    }
    // Phase B 计量：run 级 usage 收集器，经 context 穿透到 planner 的 chatWithFallback（按引用累加）。
    const modelUsageEntries = [];
    let tracker = null;
    const routedContext = {
      ...requestContext,
      ...(capabilityRequest?.id ? { capabilityRequestId: capabilityRequest.id } : {}),
      onModelUsage: (usage) => {
        if (!usage || typeof usage !== 'object') return;
        modelUsageEntries.push({ endedAt: Date.now(), ...usage });
        if (usage.outcome !== 'provider_request_failed') tracker?.noteModel?.(usage.model);
      },
    };
    tracker = createMaidRunTracker({ agentTaskRuntime, input, context: routedContext, promptStartedAt });
    if (routedContext.maidSkillContext?.loaded?.length) tracker.ensureRun();
    try {
      const result = await runPromptWithTracker(input, routedContext, tracker);
      let capabilityRouting = null;
      if (capabilityRequest?.id && typeof capabilityRoutingRuntime?.finishRequest === 'function') {
        try {
          capabilityRouting = capabilityRoutingRuntime.finishRequest(capabilityRequest.id, result);
        } catch (error) {
          logger?.debug?.('maid capability request finish skipped', error);
        }
      }
      const finalResult = capabilityRouting ? { ...result, capabilityRouting } : result;
      tracker.finish(finalResult, modelUsageEntries);
      return finalResult;
    } catch (error) {
      if (isMaidAbortError(error, routedContext?.signal)) {
        const cancelledResult = buildMaidCancelledResult({ input, steps: [] });
        if (capabilityRequest?.id && typeof capabilityRoutingRuntime?.finishRequest === 'function') {
          try { capabilityRoutingRuntime.finishRequest(capabilityRequest.id, cancelledResult); } catch {}
        }
        tracker.finish(cancelledResult, modelUsageEntries);
        return cancelledResult;
      }
      if (capabilityRequest?.id && typeof capabilityRoutingRuntime?.finishRequest === 'function') {
        try {
          capabilityRoutingRuntime.finishRequest(capabilityRequest.id, {
            ok: false,
            reason: error?.message || String(error || ''),
          });
        } catch {}
      }
      tracker.finish({
        ok: false,
        status: 'failed',
        reason: error?.message || String(error || ''),
        message: error?.message || '女仆执行失败。',
      }, modelUsageEntries);
      throw error;
    }
  };

  return {
    plan: planner,
    prepareSkillTaskContext,
    runPrompt,
    cancelPendingAction: (options = {}) => {
      if (cancelPendingMaidAction(agentTaskRuntime, options)) return true;
      if (!trim(options.submissionId) || !trim(options.voiceCallId)) return false;
      const pending = resolvePendingMaidImportedCardWorkflow(agentTaskRuntime?.listRuns?.({ kind: 'maid_assistant', limit: 100 }), {
        context: { voiceCallId: options.voiceCallId, pendingActionSubmissionId: options.submissionId },
      });
      if (!pending || typeof agentTaskRuntime?.finishRun !== 'function') return false;
      return Boolean(agentTaskRuntime.finishRun(pending.runId, {
        status: 'cancelled', cancelReason: 'user_cancelled_pending_workflow',
        metadata: { maidStatus: 'cancelled', pendingWorkflow: { ...pending.snapshot, state: 'cancelled', cancelledAt: Date.now() } },
      }));
    },
    getFeature: findAppFeature,
  };
};
