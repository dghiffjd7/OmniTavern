import {
  findAppFeature,
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
  MAID_IMPORTED_CARD_PLAN_TOOL,
  buildMaidImportedCardExecutionMessage,
  classifyMaidImportedCardConfirmation,
  resolvePendingMaidImportedCardWorkflow,
  validateMaidImportedCardWorkflowSnapshot,
} from './maid-imported-card-workflow.js';
import { buildMaidSourceGroundingContext } from './maid-source-grounding.js';
import { runBelongsToMaidContext, settleMaidRunContinuation, getMaidContinuationPendingTodos, guardMaidContinuationResult } from './maid-run-followup.js';
import { MAID_TASK_RESUME_TOOL } from './tools/maid-task-tools.js';
import { findUnsupportedMaidWebAmounts } from './maid-web-observations.js';
import { findMaidImageTargetMismatch } from './maid-image-target-evidence.js';
import { applyMaidResultPresentation } from './maid-result-presentation.js';
import { createMaidAppDiscoveryPlan, shouldRecoverMaidAppDiscovery } from './maid-app-discovery-recovery.js';
import { createMaidSkillContext, mergeMaidSkillCatalog, restoreMaidSkillContext, serializeMaidSkillContext, stripMaidSkillObservationBodies } from './maid-skill-context.js';
import {
  buildConfirmedPendingActionPlan,
  cancelPendingMaidAction,
  buildMaidPendingActionFromSteps,
  classifyMaidPendingActionReply,
  resolvePendingMaidAction,
} from './maid-pending-action.js';
import {
  MAID_GROUP_PREVIEW_KIND,
  buildMaidGroupPreviewFromSteps,
  resolvePendingMaidGroupPreview,
  classifyMaidGroupPreviewReply,
  buildConfirmedGroupPreviewPlan,
  buildGroupPreviewMessage,
  buildGroupCreationMessage,
} from './maid-group-preview-workflow.js';
import {
  ALREADY_DELETED_REASON,
  appendAlreadyDeletedResults,
  buildAlreadyDeletedExecution,
  countConsecutiveSameAction,
  countRunSameFailedAction,
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
import { buildMaidStepOutcomes } from './maid-run-outcomes.js';
import {
  buildMaidWorldbookObservationLedger,
  normalizeCarriedMaidWorldbookObservations,
} from './maid-worldbook-observations.js';
import {
  inspectMaidWorldbookRead,
  buildMaidWorldbookAlreadyReadExecution,
  buildMaidWorldbookReadBlockedExecution,
  noteMaidWorldbookRepeatedRead,
} from './maid-worldbook-read-repeats.js';

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

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
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
  const hasEntryTokens = e => finite(e.promptTokens) != null || finite(e.completionTokens) != null || finite(e.totalTokens) != null;
  const hasTokens = list.some(hasEntryTokens);
  const sum = (key) => list.reduce((acc, e) => {
    const v = finite(e[key]);
    return v != null ? acc + v : acc;
  }, 0);
  const lastWith = (key, source = list) => {
    for (let i = source.length - 1; i >= 0; i -= 1) {
      if (trim(source[i][key])) return trim(source[i][key]);
    }
    return '';
  };
  // provider/model 记实际产生结果的调用：失败的尝试（常是之后换上的备用模型）照实计入次数、耗时与 token，但不决定模型。
  // 取最后一次带 token 的成功调用，没有就取最后一次成功调用；全部失败时留空（与任务卡 executionModel 同一规则）。
  const succeeded = list.filter(e => trim(e.outcome) !== 'provider_request_failed');
  const modelSource = succeeded.some(hasEntryTokens) ? succeeded.filter(hasEntryTokens) : succeeded;
  return {
    status: hasTokens ? 'recorded' : 'unknown',
    provider: lastWith('provider', modelSource),
    model: lastWith('model', modelSource),
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

const createMaidRunTracker = ({ agentTaskRuntime = null, input = '', context = {}, promptStartedAt = 0, onOutcomes = null } = {}) => {
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
        maidTaskScope: { roleCardId: trim(context.roleCardId), sessionId: trim(context.sessionId), uiMode: trim(context.uiMode) },
        maidSkills: serializeMaidSkillContext(context.maidSkillContext),
        ...(context.maidTaskInputs ? { maidTaskInputs: clone(context.maidTaskInputs) } : {}),
        ...(context.pendingGroupPreviewRevision ? { groupPreviewRevision: clone(context.pendingGroupPreviewRevision) } : {}),
        ...(executionModel ? { executionModel } : {}),
        ...(trim(context.submissionId) ? { submissionId: trim(context.submissionId) } : {}),
        ...(context.source === 'maid_realtime' ? { submissionSource: context.source, voiceCallId: context.voiceCallId } : {}),
        ...(trim(continuation?.sourceRunId) ? {
          resumedFromRunId: trim(continuation.sourceRunId),
          continuationVersion: trim(continuation.version),
          todos: clone(agentTaskRuntime.getRun?.(continuation.sourceRunId)?.metadata?.todos || continuation.remainingTodos || []),
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
          // 「继续」时带上本轮结束时的世界书已读记录（含上一轮带来、本轮仍有效的部分）
          worldbookObservations: normalizeCarriedMaidWorldbookObservations(buildMaidWorldbookObservationLedger({
            steps: Array.isArray(result?.steps) ? result.steps : [],
            context,
            carried: continuation?.worldbookObservations,
          })),
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
    const runStatus = cancelled ? 'cancelled' : (ok ? 'succeeded' : 'failed');
    // 检索 → 执行 → 自动验证 → 结果：每个动作步骤记一条，并挂回它的检索快照
    const outcomes = buildMaidStepOutcomes(result?.steps, { runStatus });
    if (outcomes.length) {
      metadata.outcomes = outcomes;
      try { onOutcomes?.(outcomes, { runId: run.id, status: runStatus }); } catch {}
    }
    const finishedRun = agentTaskRuntime.finishRun(run.id, {
      status: runStatus,
      summary,
      errorMessage: ok || cancelled ? '' : (trim(result?.errorDetail) || truncateForRun(result?.reason || result?.message || '')),
      ...(cancelled ? { cancelReason: 'user_cancelled' } : {}),
      usage: runUsage,
      metadata,
    });
    settleMaidRunContinuation({ runtime: agentTaskRuntime, context, continuation, childRun: finishedRun, result });
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

const resolveReactStepBudget = ({
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
    recommended = 10;
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

// 连续失败，或整轮中同一失败操作累计达到上限（中间夹着读取也算）：取次数较多的一方
const getRepeatedFailure = (steps = []) => {
  const consecutive = getConsecutiveRepeatedFailure(steps);
  const acrossRun = countRunSameFailedAction(steps);
  return acrossRun.count > consecutive.count ? { ...acrossRun, acrossRun: true } : consecutive;
};

// 同一工具同一目标连续成功调用（如反复 maid.todo.read）说明模型在原地转圈，不产出实际进展。
const getConsecutiveRepeatedSuccess = (steps = []) => countConsecutiveSameAction(steps, 'succeeded');

const countConsecutiveSearchWithoutEvidence = (steps = []) => {
  let count = 0;
  let targetTerms = null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const check = unwrapToolOutputResult(step?.output)?.targetCheck;
    if (!['web.search', 'web.research'].includes(step?.toolName) || step?.status !== 'succeeded'
      || check?.checked !== true || check.relevantSourceCount !== 0) break;
    const terms = [step.args?.target, ...(Array.isArray(step.args?.targetAliases) ? step.args.targetAliases : [])]
      .map(value => trim(value).toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '')).filter(Boolean);
    if (!terms.length || (targetTerms && !terms.some(term => targetTerms.has(term)))) break;
    if (!targetTerms) targetTerms = new Set(terms);
    count += 1;
  }
  return count;
};

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

const stripNegatedMaidActionClauses = value => String(value ?? '')
  .replace(/(?:不要|不得|别|禁止|无需|不用|不可|不能|避免)\s*[^，,。；;！？!?\n]*/gu, ' ');

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
    'provider_request_failed',
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
  return [
    'invalid_model_plan',
    'feature_not_found',
    'tool_not_allowed',
    'invalid_model_react_decision',
    'missing_final_message',
    'invalid_react_action',
  ].includes(trim(plan?.reason));
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
    featureId: trim(verification.featureId),
    skipGuide: true,
    title: '验证执行结果',
    response: '我再读回确认一下结果。',
    metadata: {
      verificationFor: trim(plan?.toolName),
      verificationSuccess: trim(verification.success),
    },
    source: 'auto_verification',
  };
};

const buildAutoVerificationPlan = (plan = {}, output = {}, toolDefinition = null) => {
  // Features can expose auxiliary reads alongside their write action. Only the
  // executed tool's capabilities determine whether there was a write to verify.
  if (toolDefinition?.capabilities?.write === false) return null;
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
      skipGuide: true,
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
  toolDefinition = null,
} = {}) => {
  if (toolDefinition?.capabilities?.write === false) return null;
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
  }, toolDefinition);
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

const findGeneratedMediaAtQuota = ({
  input = '',
  plan = {},
  steps = [],
} = {}) => {
  if (trim(plan?.toolName) !== 'media.generate_image') return null;
  const key = getGeneratedMediaKey(plan?.args);
  const purpose = trim(plan?.args?.purpose).toLowerCase();
  const writeTools = getGeneratedMediaWriteTools(purpose);
  if (!key) return null;
  const source = Array.isArray(steps) ? steps : [];
  const targetQuota = resolveGeneratedMediaTargetQuota(input, plan.args);
  const generatedMatches = [];
  const generatedAttachmentIds = new Set();
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const generatedStep = source[index];
    if (
      generatedStep?.status !== 'succeeded' ||
      generatedStep?.output?.ok === false ||
      generatedStep?.output?.localToolExecutionSkipped === true ||
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
    if (!generatedAttachmentIds.has(attachmentId)) {
      generatedAttachmentIds.add(attachmentId);
      generatedMatches.push({ generatedStep, appliedStep, attachmentId });
    }
  }
  if (generatedMatches.length < targetQuota) return null;
  return {
    ...generatedMatches[0],
    generatedCount: generatedMatches.length,
    appliedCount: generatedMatches.filter(match => match.appliedStep).length,
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
      alreadyApplied: Boolean(match?.appliedStep),
      appliedByTool: trim(match?.appliedStep?.toolName),
      appliedVariantCount: Number(match?.appliedCount || 0),
      generatedVariantCount: Number(match?.generatedCount || 0),
      requestedVariantQuota: Number(match?.targetQuota || 1),
      generationState: 'completed',
      reason: match?.appliedStep ? 'generated_media_already_applied' : 'requested_media_already_generated',
      message: match?.appliedStep
        ? '同一对象与用途已完成用户要求的图片数量并成功写回；本次未重复产生计费生图调用，请继续下一个未完成目标。'
        : 'The image for THIS user message was successfully generated and attachmentId is ready. This APP guard skipped a duplicate call; provider credits and rate limits have not failed. Present this actual image, or apply this attachment only if authorized. Do not ask the user to wait, retry or regenerate an image that is already available.',
    },
    summary: match?.appliedStep
      ? 'generated media already applied; duplicate billed generation skipped'
      : 'requested media already generated; duplicate billed generation skipped',
  },
  guided: false,
  guide: null,
  message: '',
});

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
    // Native paths restore attachments locally; planners only need their IDs.
    if (isPlainObject(projected.output)) delete projected.output.attachmentReference;
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
  chatResponder = null,
  guidedActionRuntime = null,
  prepareConversationContext = null,
  getCapabilityRoutingConfigOverride = null,
  getSkillCatalog = null,
  getCurrentContext = null,
  maxReactSteps = 48,
  repeatedFailureLimit = 3,
  logger = console,
} = {}) => {
  const groupScopeKeys = ['roleCardId', 'sessionId', 'uiMode', 'contactsScopeId', 'chatScopeId', 'contactsScopeToken', 'chatScopeToken'];
  const currentGroupContext = context => {
    let current;
    try { current = getCurrentContext?.(); } catch {}
    if (!current || !trim(context.roleCardId) || !trim(context.uiMode)
      || ['roleCardId', 'sessionId', 'uiMode'].some(key => trim(current[key]) !== trim(context[key]))) return null;
    return { ...context, ...Object.fromEntries(groupScopeKeys.map(key => [key, current[key]])) };
  };
  const closeGroupPreview = (pending, state) => {
    const closed = agentTaskRuntime?.finishRun?.(pending.runId, {
      status: state === 'consumed' ? 'succeeded' : 'cancelled',
      cancelReason: state === 'consumed' ? undefined : 'group_preview_' + state,
      metadata: { maidStatus: state === 'consumed' ? 'responded' : 'cancelled',
        pendingWorkflow: { ...pending.snapshot, state, closedAt: Date.now() } },
    });
    return closed !== false && closed !== null && closed !== undefined;
  };
  const groupReplyResult = (input, reason, message, status = 'responded') => ({
    ok: status !== 'failed', status, responseType: 'workflow', source: 'app_group_preview', input: trim(input), reason, message,
  });
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
      const toolDefinition = toolRegistry?.get?.(executablePlan.toolName);
      const feature = findAppFeature(executablePlan.featureId);
      const guidePlan = toolDefinition?.capabilities?.write === false && feature?.writes === true
        ? { ...executablePlan, skipGuide: true }
        : executablePlan;
      return guidedActionRuntime.run({
        plan: guidePlan,
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

  const runPromptWithTracker = async (input = '', context = {}, tracker = null, groupWorkflow = null) => {
    // 每轮独立的视觉附件池：工具可把截图加入同一轮 ReAct，但不会回写输入框或跨 run 留存。
    context = {
      ...(isPlainObject(context) ? context : {}),
      // Planner/ReAct context copies share this state; each run gets a fresh ref.
      maidProviderFcState: { fallbackReason: '', diagnostics: null },
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
            // 本轮自己的任务 run：候选看「之前的任务」状态时排除它
            context: { ...decisionContext, maidRunId: tracker?.getRunId?.() || '' },
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
        // 规划请求的时长由所用模型配置的请求超时约束（API 异常挂起时由请求层中止），不另包计时。
        decision = await plannerFn(input, decisionContext);
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
    if (!groupWorkflow && !context.runContinuation && typeof agentTaskRuntime?.listRuns === 'function') {
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
        context,
        tracker,
        authorizePlan: authorizeDeterministicWorkflowPlan,
      });
    }
    // 上一轮留下的“待确认删除清单”：明确确认则原样执行，取消则作废，说了别的就视为放弃
    let confirmedPendingPlan = null;
    if (!groupWorkflow && !context.runContinuation && typeof agentTaskRuntime?.listRuns === 'function') {
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
        } else {
          // 此时还不知道是改说别的事还是修改清单（由模型判断），摘要措辞对两种情况都成立
          closePending('superseded', 'cancelled', '收到新的指示，原待确认的删除清单已作废，未执行删除。');
          // 这句可能是对清单的修改（“确认，但保留乙”）：含义交给模型判断。本次任务允许使用原清单的删除功能，
          // 不因这句话没写“删除”二字被高风险检查挡掉；真正删除时 APP 的删除确认照常弹出。
          context.pendingActionRevision = {
            featureId: trim(pendingAction.snapshot.featureId, pendingAction.snapshot.toolName),
            toolName: trim(pendingAction.snapshot.toolName),
          };
        }
      }
    }

    let plan = (groupWorkflow?.mode === 'confirm'
      ? authorizeDeterministicWorkflowPlan(groupWorkflow.plan, []) : confirmedPendingPlan)
      || await callRoutedPlanner({ plannerFn: planner, phase: 'planner', label: 'maid_planner' });
    if (typeof reactPlanner === 'function'
      && typeof capabilityRoutingRuntime?.authorizeDiscovery === 'function'
      && shouldRecoverMaidAppDiscovery({ input, decision: plan, context })) {
      const discovery = capabilityRoutingRuntime.authorizeDiscovery({
        requestId: trim(context.capabilityRequestId), parentPlan: plan, context,
        discoveryPlan: createMaidAppDiscoveryPlan({ input, decision: plan, title: findAppFeature('app.capabilities.search')?.title }),
      });
      if (discovery?.ok) {
        context.maidDiscoveryRecovery = clone(discovery.metadata.discoveryRecovery);
        plan = discovery;
      }
    }
    // 先看再给计划（ROADMAP 29-⑨）：本次任务进入规划——之后的决策只拿到只读工具，写入由工具层挡下；
    // 看完交出计划卡（plan）后停下，用户在卡上点「开始做」另起一轮才执行
    if (plan?.ok === true && plan?.source === 'maid_provider_fc' && plan?.providerFcControl === 'plan_first'
      && typeof reactPlanner === 'function') {
      context.operationIntentPolicy = { mode: 'planning', source: 'maid_plan_first', reason: 'look_before_plan' };
      plan = await callRoutedPlanner({
        plannerFn: reactPlanner,
        phase: 'react',
        label: 'maid_react',
        extraContext: { maidReactSteps: [], lastPlan: clone(plan), lastToolOk: true },
      });
    }
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
              ...(trim(decision.errorMessage) ? { errorDetail: trim(decision.errorMessage) } : {}),
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
    let currentPlan = plan;
    let lastExecution = null;
    let lastOutput = null;
    let lastOk = false;
    let cyclesUsed = 0;
    let webEvidenceCorrectionUsed = false;
    let continuationCompletionReviewUsed = false;
    const steps = [];
    const crossRunFallbackPlans = new Map();
    let stepBudget = resolveReactStepBudget({
      plan,
      context,
      configuredMaxReactSteps: maxReactSteps,
    });
    let maxSteps = stepBudget.maxSteps;
    const expandStepBudget = (nextPlan = {}) => {
      const next = resolveReactStepBudget({
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
        if (groupWorkflow) {
          const fresh = currentGroupContext(context);
          if (!fresh || groupScopeKeys.some(key => fresh[key] !== groupWorkflow.scope[key])) {
            return { ...groupReplyResult(input, 'group_preview_scope_changed',
              t('页面或角色卡已变化，原建群清单不能继续使用。请重新预览。'), 'cancelled'), steps: clone(steps) };
          }
        }
        context.maidSourceGrounding = buildMaidSourceGroundingContext({ input, steps });
        expandStepBudget(currentPlan);
        let crossRunResumeMatch = resolveCrossRunResumePlan({
          plan: currentPlan,
          continuation: context.runContinuation,
          steps,
          toolDefinition: toolRegistry?.get?.(currentPlan.toolName),
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
          currentPlan = verificationPlan;
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
        const reusableGeneratedMedia = findGeneratedMediaAtQuota({
          input,
          plan: currentPlan,
          steps,
        });
        // 删除幂等：本轮已删除的目标不再交给工具，全部已删则整步跳过
        const alreadyDeleted = findAlreadyDeletedTargets(currentPlan, steps);
        // 同一任务里重复读世界书：已在已读记录里的不再返回正文，读太多次就拦下（见 maid-worldbook-read-repeats.js）
        const worldbookRead = inspectMaidWorldbookRead({ plan: currentPlan, steps, context,
          carried: context.runContinuation?.worldbookObservations });
        const imageTargetMismatch = findMaidImageTargetMismatch({plan:currentPlan,steps});
        if (imageTargetMismatch) {
          const output = {toolName:currentPlan.toolName,status:'failed',result:imageTargetMismatch,
            summary:'Image target must match an observed identity; no provider call sent.'};
          const step = tracker.startToolStep(currentPlan);
          tracker.finishToolStep(step,{status:'failed',summary:output.summary,
            errorMessage:imageTargetMismatch.reason,output});
          execution = {output,guided:false,guide:null,message:''};
        } else if (crossRunResumeMatch?.status === 'verified') {
          execution = buildReusedCrossRunExecution(crossRunResumeMatch);
        } else if (reusableSessionCreate) {
          execution = buildReusedSessionCreateExecution(reusableSessionCreate);
        } else if (reusableGeneratedMedia) {
          execution = buildReusedGeneratedMediaExecution(reusableGeneratedMedia);
        } else if (isRepeatedSuccessfulTodoWrite(currentPlan, steps)) {
          execution = buildUnchangedTodoExecution();
        } else if (alreadyDeleted && !alreadyDeleted.remaining.length) {
          execution = buildAlreadyDeletedExecution(alreadyDeleted);
        } else if (worldbookRead?.blocked) {
          execution = buildMaidWorldbookReadBlockedExecution(worldbookRead);
        } else if (worldbookRead?.alreadyRead) {
          execution = buildMaidWorldbookAlreadyReadExecution(worldbookRead);
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
            if (worldbookRead) execution = noteMaidWorldbookRepeatedRead(execution, worldbookRead);
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
        if (ok && currentPlan.toolName === 'group.create' && currentPlan.args?.preview === true) {
          const fresh = currentGroupContext(context);
          const pending = fresh && buildMaidGroupPreviewFromSteps(steps, {
            input: groupWorkflow?.originalGoal || input,
            context: { ...fresh, runId: tracker?.getRunId(), submissionId: context.submissionId },
          });
          if (pending) return {
            ok: true, status: 'awaiting_confirmation', responseType: 'workflow', source: 'app_group_preview',
            input: trim(input), plan: clone(currentPlan), output: clone(output), steps: clone(steps),
            modelDraft: clone(currentPlan),
            pendingWorkflow: pending, message: buildGroupPreviewMessage(pending),
          };
          if (groupWorkflow?.mode === 'preview') return {
            ...groupReplyResult(input, 'group_preview_unavailable',
              t('建群预览缺少有效的目标或作用域，未创建群聊。请重新预览。'), 'failed'),
            output: clone(output), steps: clone(steps),
          };
        }
        // 角色卡世界书挑人物建房：工具冻结了建房清单时本轮停下，等用户下一句确认或取消（确认后由 runImportedCardApplyWorkflow 执行）
        if (ok && currentPlan.toolName === MAID_IMPORTED_CARD_PLAN_TOOL) {
          const planResult = unwrapToolOutputResult(output);
          const frozen = planResult?.awaitingConfirmation === true
            ? validateMaidImportedCardWorkflowSnapshot(planResult.pendingWorkflow)
            : null;
          if (frozen?.ok) return {
            ok: true, status: 'awaiting_confirmation', responseType: 'workflow',
            input: trim(input), plan: clone(currentPlan), output: clone(output), steps: clone(steps),
            pendingWorkflow: frozen.snapshot, message: trim(planResult.message),
          };
        }
        // 续跑任务：已排进与「继续」按钮同一条结构化续跑，本轮到此结束，续跑在本轮之后开始并自己回报
        if (ok && currentPlan.toolName === MAID_TASK_RESUME_TOOL) {
          const resumed = unwrapToolOutputResult(output);
          if (resumed?.queued === true) return {
            ok: true, status: 'succeeded', responseType: 'workflow', reason: 'maid_task_resume_queued',
            input: trim(input), plan: clone(currentPlan), output: clone(output), steps: clone(steps),
            message: t('已把任务「{goal}」排进续跑，接下来按原任务记录接着做。', { goal: trim(resumed.title) }),
          };
        }
        if (groupWorkflow?.mode === 'confirm' && currentPlan.toolName === 'group.create') {
          const cancelled = isToolOutputCancelled(output);
          return { ok: ok && !cancelled, status: cancelled ? 'cancelled' : ok ? 'succeeded' : 'failed',
            responseType: 'workflow', source: 'confirmed_group_preview', input: trim(input),
            plan: clone(currentPlan), output: clone(output), steps: clone(steps),
            reason: ok ? '' : summarizeToolFailure(output),
            message: ok ? (buildGroupCreationMessage(output) || buildSuccessMessage({ plan: currentPlan, output, execution })) : summarizeToolFailure(output) };
        }
        if (ok && reactPlanner) {
          loopProbe(`step-${stepIndex}:verify-check`);
          let verificationPlan = buildAutoVerificationPlan(currentPlan, output, toolRegistry?.get?.(currentPlan.toolName));
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

        if (countConsecutiveSearchWithoutEvidence(steps) >= 3) {
          const reason = 'search_no_relevant_evidence';
          return {
            ok: false,
            status: 'interrupted',
            responseType: 'react',
            reason,
            reactStoppedReason: reason,
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            partial: true,
            continuable: false,
            failureCode: reason,
            message: t('连续查询未找到与目标相关的来源，所需信息仍未确认。已停止重复搜索；可以补充更准确的名称或指定来源后再查。'),
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
        const repeatedFailure = getRepeatedFailure(steps);
        if (repeatedFailure.count >= failureLimit) {
          const reason = 'repeated_tool_failure';
          const message = `同一工具「${repeatedFailure.toolName || '未知工具'}」用相同参数${repeatedFailure.acrossRun ? '反复' : '连续'}失败 ${repeatedFailure.count} 次，已停止继续重试。`;
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
            // 每完成一步都会显示，不能说成已取得最终结果（多步任务第一步后就出现）
            tone: 'progress',
            message: ok ? '这一步完成了，接着处理。' : '工具遇到错误，我正在尝试修正参数。',
            steps: clone(steps),
          });
        }

        loopProbe(`step-${stepIndex}:react-call`);
        throwIfMaidAborted(context?.signal);
        const modelReactSteps = projectMaidReactStepsForModel(steps);
        let decision = await callRoutedPlanner({
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
        if (decision?.ok && decision.action === 'final' && context.runContinuation && tracker.canTrack && !continuationCompletionReviewUsed) {
          const pending = getMaidContinuationPendingTodos(context.runContinuation, agentTaskRuntime?.getRun?.(tracker.getRunId()));
          if (pending.length) {
            continuationCompletionReviewUsed = true;
            decision = await callRoutedPlanner({ plannerFn: reactPlanner, phase: 'react', label: 'maid_react_continuation_review',
              extraContext: {
                maidReactSteps: modelReactSteps,
                lastPlan: clone(observedPlan), lastOutput: clone(modelReactSteps.at(-1)?.output ?? observedOutput), lastToolOk: ok,
                maidContinuationFeedback: { reason: 'original_todos_unfinished', todos: pending },
              },
            });
          }
        }
        // Monetary coverage is advisory: historical comparisons and arithmetic
        // need model interpretation. Never let it override APP writes or pending workflows.
        const onlyWebReads = steps.length > 0 && steps.every(step => ['web.search', 'web.research', 'web.fetch_url'].includes(step.toolName));
        const unsupportedAmounts = onlyWebReads && decision?.ok && decision.action === 'final'
          ? findUnsupportedMaidWebAmounts({ input, steps, message: decision.message }) : [];
        if (unsupportedAmounts.length && !webEvidenceCorrectionUsed) {
          webEvidenceCorrectionUsed = true;
          throwIfMaidAborted(context?.signal);
          const originalDecision = decision;
          let correctedDecision = null;
          try {
            correctedDecision = await callRoutedPlanner({
              plannerFn: reactPlanner, phase: 'react', label: 'maid_react_evidence_correction',
              extraContext: {
                maidReactSteps: modelReactSteps,
                lastPlan: clone(observedPlan), lastOutput: clone(modelReactSteps.at(-1)?.output ?? observedOutput), lastToolOk: ok,
                maidWebEvidenceFeedback: { reason: 'web_amount_evidence_missing', unsupportedAmounts },
              },
            });
          } catch (error) {
            if (isMaidAbortError(error, context?.signal)) throw error;
            logger?.debug?.('maid optional amount review unavailable', error);
          }
          if (isMaidAbortError(correctedDecision, context?.signal)) {
            const error = new Error(trim(correctedDecision?.message, 'Maid task stopped by user'));
            error.code = 'user_aborted';
            throw error;
          }
          decision = correctedDecision?.ok ? correctedDecision : {
            ...originalDecision,
            message: `${t('以下金额未能完成额外核对：{amounts}。', { amounts: unsupportedAmounts.join('、') })}\n${trim(originalDecision.message)}`,
          };
        }
        if (!decision?.ok) {
          // 模型请求失败时的报错原文，界面原样显示、执行记录原样保存
          const errorDetail = trim(decision?.errorMessage);
          if (ok) {
            const stoppedReason = decision?.reason || 'react_stopped';
            const continuable = isContinuableReactStop(stoppedReason);
            return {
              ok: false,
              status: 'interrupted',
              responseType: 'react',
              ...(errorDetail ? { errorDetail } : {}),
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
                pendingPlan: stoppedReason === 'provider_request_failed' ? null : observedPlan,
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
            ...(errorDetail ? { errorDetail } : {}),
            input: trim(input),
            plan: clone(observedPlan),
            output: clone(observedOutput),
            steps: clone(steps),
            reason: decision?.message || decision?.reason || summarizeToolFailure(observedOutput),
            message: decision?.message || summarizeToolFailure(observedOutput),
          };
        }
        if (decision.action === 'final') {
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
          currentPlan = decision;
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
    if (sourceRunId && trim(context.roleCardId) && !runBelongsToMaidContext(run, context)) {
      throw Object.assign(new Error('maid_previous_task_scope_mismatch'), { code: 'maid_previous_task_scope_mismatch' });
    }
    const maidSkillContext = restoreMaidSkillContext(run) || { ...createMaidSkillContext(), catalogNeedsRefresh: true };
    return { context: { ...context, ...(run.metadata?.maidTaskInputs?.context || {}), maidSkillContext, maidSkillContextPrepared: true,
      ...(run.metadata?.maidTaskInputs ? { maidTaskInputs: clone(run.metadata.maidTaskInputs) } : {}),
      ...(inheritPending && run.metadata?.submissionId ? { pendingActionSubmissionId: run.metadata.submissionId } : {}) }, useDraftSkills: false };
  };

  const runPrompt = async (input = '', context = {}) => {
    const promptStartedAt = Date.now();
    const rawUserInput = trim(input);
    try {
      throwIfMaidAborted(context?.signal);
    } catch {
      return buildMaidCancelledResult({ input, steps: [] });
    }
    let groupWorkflow = null;
    const textTask = context.source !== 'maid_realtime' && !context.voiceCallId && !context.voiceRequestId
      && !context.runContinuation && !extractMaidResumeRunId(input);
    if (textTask) {
      const runs = agentTaskRuntime?.listRuns?.({ kind: 'maid_assistant', limit: 100 }) || [];
      const fresh = currentGroupContext(context);
      if (fresh) {
        for (const run of runs) {
          const snapshot = run?.metadata?.pendingWorkflow;
          if (run?.status !== 'waiting_permission' || snapshot?.kind !== MAID_GROUP_PREVIEW_KIND
            || snapshot.state !== 'pending' || snapshot.origin?.runId !== run.id
            || ['roleCardId', 'sessionId', 'uiMode', 'contactsScopeId', 'chatScopeId'].some(key => snapshot.scope?.[key] !== fresh[key])) continue;
          if (Number(snapshot.expiresAt) <= Date.now()
            || ['contactsScopeToken', 'chatScopeToken'].some(key => snapshot.scope?.[key] !== fresh[key])) {
            closeGroupPreview({ runId: run.id, snapshot }, 'expired');
          }
        }
      }
      const pending = fresh && resolvePendingMaidGroupPreview(runs, { context: fresh });
      if (pending) {
        const reply = classifyMaidGroupPreviewReply(input, pending.snapshot);
        if (reply === 'unclear') return groupReplyResult(input, 'group_preview_reply_unclear',
          t('这份建群清单仍待确认。请明确确认、修改要求，或回复“不要”取消。'));
        if (!closeGroupPreview(pending, reply === 'confirm' ? 'consumed' : reply === 'cancel' ? 'cancelled' : 'superseded')) {
          return groupReplyResult(input, 'group_preview_unavailable', t('这份建群清单已失效，请重新预览。'), 'cancelled');
        }
        if (reply === 'cancel') return groupReplyResult(input, 'group_preview_cancelled', t('已取消这份建群清单，没有创建群聊。'), 'cancelled');
        if (reply === 'confirm') {
          groupWorkflow = { mode: 'confirm', scope: pending.snapshot.scope, plan: buildConfirmedGroupPreviewPlan(pending) };
          if (!groupWorkflow.plan) return groupReplyResult(input, 'group_preview_unavailable', t('这份建群清单已失效，请重新预览。'), 'cancelled');
        } else if (reply === 'revise') {
          const correction = trim(input);
          input = `${pending.snapshot.input}\n\n${t('用户修正：')}${correction}`;
          context = { ...context, pendingGroupPreviewRevision: { originalGoal: pending.snapshot.input, correction,
            planningInput: input, runId: pending.runId, submissionId: pending.snapshot.origin.submissionId } };
          groupWorkflow = { mode: 'preview', scope: pending.snapshot.scope, originalGoal: input };
        }
      } else if (runs.some(run => run?.status === 'waiting_permission' && run?.metadata?.pendingWorkflow?.kind === MAID_GROUP_PREVIEW_KIND)
        && classifyMaidGroupPreviewReply(input) !== 'none'
        && !resolvePendingMaidAction(runs, { context }) && !resolvePendingMaidImportedCardWorkflow(runs, { context })) {
        return groupReplyResult(input, 'group_preview_unavailable', t('这份建群清单已失效，请重新预览。'), 'cancelled');
      }
    }
    let runContinuation = isPlainObject(context?.runContinuation)
      ? context.runContinuation
      : null;
    const resumeRunId = runContinuation ? '' : extractMaidResumeRunId(input);
    const requestedSourceId = resumeRunId || trim(runContinuation?.sourceRunId);
    if (requestedSourceId && typeof agentTaskRuntime?.getRun === 'function') {
      try {
        const sourceRun = agentTaskRuntime.getRun(requestedSourceId);
        const current = getCurrentContext?.();
        if (!sourceRun || (current && trim(context.roleCardId) && trim(current.roleCardId) !== trim(context.roleCardId))
          || (trim(context.roleCardId) && !runBelongsToMaidContext(sourceRun, context)
          || sourceRun.metadata?.continuationResolution || sourceRun.metadata?.continuedByRunId
          || sourceRun.cancelReason === 'user_cancelled_followup' || sourceRun.status === 'succeeded')) {
          return groupReplyResult(input, 'maid_previous_task_unavailable', t('这条任务已结束、已有后续任务，或不属于当前角色卡。请从当前任务历史选择。'), 'cancelled');
        }
        if (
          sourceRun?.kind === 'maid_assistant' &&
          (
            sourceRun?.metadata?.continuable === true ||
            ['failed', 'cancelled'].includes(trim(sourceRun?.status))
          )
        ) {
          runContinuation = resolveMaidRunContinuationFromRun(sourceRun);
        } else {
          return groupReplyResult(input, 'maid_previous_task_unavailable', t('这条任务已结束、已有后续任务，或不属于当前角色卡。请从当前任务历史选择。'), 'cancelled');
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
      if (!groupWorkflow) Object.assign(requestContext, prepareSkillTaskContext(input, requestContext).context);
      if (!requestContext.maidSkillContext) {
        const catalog = typeof getSkillCatalog === 'function' ? await getSkillCatalog() : undefined;
        requestContext.maidSkillContext = createMaidSkillContext({ catalog });
      } else if (requestContext.maidSkillContext.catalogNeedsRefresh) {
        // Direct continuations share the input runtime's restoration rules.
        // Already accepted task catalogs remain frozen while waiting in queues.
        let catalog;
        try { catalog = typeof getSkillCatalog === 'function' ? await getSkillCatalog() : undefined; } catch {}
        mergeMaidSkillCatalog(requestContext.maidSkillContext, catalog);
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
    tracker = createMaidRunTracker({ agentTaskRuntime, input: rawUserInput, context: routedContext, promptStartedAt,
      onOutcomes: outcomes => capabilityRoutingRuntime?.observeOutcomes?.(outcomes) });
    if (routedContext.maidSkillContext?.loaded?.length || runContinuation) tracker.ensureRun();
    try {
      const rawResult = await runPromptWithTracker(input, routedContext, tracker, groupWorkflow);
      const result = applyMaidResultPresentation(rawResult, {
        context: routedContext,
        isWriteTool: name => toolRegistry?.get?.(name)?.capabilities?.write,
      });
      let capabilityRouting = null;
      if (capabilityRequest?.id && typeof capabilityRoutingRuntime?.finishRequest === 'function') {
        try {
          capabilityRouting = capabilityRoutingRuntime.finishRequest(capabilityRequest.id, result);
        } catch (error) {
          logger?.debug?.('maid capability request finish skipped', error);
        }
      }
      const checkedResult = tracker.canTrack ? guardMaidContinuationResult({ result, continuation: runContinuation,
        run: agentTaskRuntime?.getRun?.(tracker.getRunId()) }) : result;
      const finalResult = { ...checkedResult, input: rawUserInput,
        ...(rawUserInput !== trim(input) ? { planningInput: trim(input) } : {}),
        ...(capabilityRouting ? { capabilityRouting } : {}) };
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
