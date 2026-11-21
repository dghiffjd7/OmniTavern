import { t } from '../i18n/index.js';
import { APP_FEATURE_DEFINITIONS } from './app-feature-catalog.js';
import { resolveMaidRunContinuationFromRun } from './maid-run-continuation.js';

const trim = value => String(value ?? '').trim();
const clone = value => JSON.parse(JSON.stringify(value));
const todosOf = run => Array.isArray(run?.metadata?.todos) ? run.metadata.todos : [];

export const runBelongsToMaidContext = (run, context = {}) => {
  if (run?.kind !== 'maid_assistant' || !trim(context.roleCardId)) return false;
  const saved = run.metadata?.maidTaskScope || run.metadata?.maidTaskInputs?.context || {};
  return trim(saved.roleCardId) === trim(context.roleCardId)
    && (!trim(saved.uiMode) || !trim(context.uiMode) || trim(saved.uiMode) === trim(context.uiMode));
};

const ACTIVE_STATUSES = ['running', 'queued', 'waiting_permission'];

// 可以接着做、也可以取消的任务：与任务历史上「继续」按钮同一条件，且还没有后续任务接手
export const isMaidRunResumable = run => run?.metadata?.continuable === true
  && !run.metadata?.continuedByRunId && !run.metadata?.continuationResolution
  && ![...ACTIVE_STATUSES, 'succeeded'].includes(run?.status);

export const isMaidRunActive = run => ACTIVE_STATUSES.includes(run?.status);

// 中断原因：原始代码照存；给人和模型看的说法共用这一份（任务纪录摘要、maid.task.list／read）
export const getMaidRunInterruptionCode = run => trim(run?.metadata?.reason || run?.metadata?.continuationSnapshot?.reason || run?.errorMessage);

// 会写进女仆任务 metadata.reason 的代码（runPromptWithTracker 与其规划器、聊天回复、导入角色卡建房、建群流程）。
// 其余是工具失败摘要或错误讯息等原文，照原样显示。
const INTERRUPTION_LABELS = Object.freeze({
  // 可以接着做的中断
  provider_request_failed: () => t('规划模型请求失败'),
  max_steps_reached: () => t('已达到本轮步骤上限'),
  invalid_model_plan: () => t('模型给出的计划无效'),
  feature_not_found: () => t('模型选了不存在的功能'),
  tool_not_allowed: () => t('模型选了本轮不能用的工具'),
  invalid_model_react_decision: () => t('模型的下一步判断无效'),
  missing_final_message: () => t('模型没有给出最终回复'),
  invalid_react_action: () => t('模型给出的下一步动作无效'),
  same_tool_overuse: () => t('同一工具连续调用过多次'),
  repeated_tool_loop: () => t('同一工具用相同参数重复调用，没有进展'),
  continuation_incomplete: () => t('接着做的任务尚未确认全部完成'),
  // 执行与规划
  user_aborted: () => t('用户中止'),
  repeated_tool_failure: () => t('同一工具反复失败'),
  search_no_relevant_evidence: () => t('连续搜索没有找到相关来源'),
  unsupported_intent: () => t('暂时还不支持这个请求'),
  empty_input: () => t('没有收到输入内容'),
  maid_task_resume_queued: () => t('已排入接着做的任务'),
  pending_action_unavailable: () => t('待确认清单已结束或过期'),
  pending_action_needs_preview: () => t('删除预览缺少完整的目标记录'),
  maid_react_recovery_failed: () => t('重新判断下一步失败'),
  maid_react_failed: () => t('模型判断下一步失败'),
  maid_react_unavailable: () => t('无法继续判断下一步'),
  react_stopped: () => t('模型停止了任务'),
  maid_model_planner_failed: () => t('规划模型判断失败'),
  maid_model_planner_unavailable: () => t('规划模型不可用'),
  maid_planner_required: () => t('需要先由 AI 判断要调用的工具'),
  maid_client_error: () => t('无法建立 API 连接'),
  maid_api_not_configured: () => t('女仆没有可用的 API 配置'),
  maid_profile_not_bound: () => t('女仆尚未绑定 API 配置'),
  maid_profile_missing: () => t('女仆绑定的 API 配置已不存在'),
  maid_chat_failed: () => t('女仆回复失败'),
  maid_runtime_unavailable: () => t('女仆运行环境不可用'),
  chat_response_contains_tool_plan: () => t('回复里混入了工具调用计划'),
  // 导入角色卡建房
  imported_card_workflow_failed: () => t('导入角色卡建房流程未能继续'),
  frozen_persona_scope_changed: () => t('确认期间角色卡或其世界书关联已变化'),
  frozen_worldbook_index_changed: () => t('确认期间世界书条目已变化'),
  frozen_private_session_changed: () => t('确认期间私聊已变化'),
  frozen_group_changed: () => t('确认期间群聊已变化'),
  frozen_group_member_resolution_failed: () => t('无法把群成员对应到私聊会话'),
  persona_switch_failed: () => t('切换角色卡失败'),
  session_list_failed: () => t('读取会话列表失败'),
  private_session_name_conflict: () => t('候选人物与群聊同名'),
  group_name_conflict: () => t('群聊名与私聊冲突'),
  private_session_create_failed: () => t('建立私聊失败'),
  existing_group_read_failed: () => t('读取现有群聊失败'),
  group_write_failed: () => t('写入群聊失败'),
  result_verification_read_failed: () => t('读回核对结果失败'),
  imported_card_result_verification_failed: () => t('建房结果核对未通过'),
  invalid_pending_workflow: () => t('建房清单无效'),
  pending_workflow_not_active: () => t('建房清单已不在进行中'),
  pending_workflow_expired: () => t('建房清单已过期'),
  pending_workflow_scope_missing: () => t('建房清单缺少适用范围'),
  pending_workflow_candidates_invalid: () => t('建房清单的人物候选无效'),
  pending_workflow_group_invalid: () => t('建房清单的群聊设置无效'),
  // 建群预览
  group_preview_unavailable: () => t('建群清单已失效'),
  group_preview_scope_changed: () => t('页面或角色卡已变化，建群清单不能继续使用'),
});

export const describeMaidRunInterruption = run => {
  const reason = getMaidRunInterruptionCode(run);
  return Object.hasOwn(INTERRUPTION_LABELS, reason) ? INTERRUPTION_LABELS[reason]() : reason;
};

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// 结果栏位表明这一步没有实际改动：跳过（skipped、status:'skipped'、reason 为 no_change 或 already_*）、
// 明说没改（changed:false、updated:false、noChange）、只是预览（preview:true）、本次没执行（localToolExecutionSkipped，
// 如复验上一轮已做过的写入），或逐项结果全部跳过
const isNoChangeResult = (result) => {
  if (!isPlainObject(result)) return false;
  if ([result.skipped, result.noChange, result.preview, result.localToolExecutionSkipped].includes(true)) return true;
  if (result.changed === false || result.updated === false) return true;
  const reason = trim(result.reason);
  if (trim(result.status) === 'skipped' || reason === 'no_change' || reason.startsWith('already_')) return true;
  const items = Array.isArray(result.results) ? result.results : [];
  return items.length > 0 && items.every(item => trim(item?.status) === 'skipped');
};

// 成功操作记录里的对象：先看工具结果、再看参数，取现有的名称类栏位（如联系人名称）；没有单一名称时
// 取逐项列表（如变量的 changes[].key、values[].path、paths）。都取不到就只写功能名。
const RECEIPT_TARGET_FIELDS = ['target', 'name', 'title', 'displayName', 'sessionName', 'personaName', 'groupName', 'scriptName', 'subject'];
const RECEIPT_TARGET_LIST_FIELDS = ['changes', 'values', 'paths', 'targets'];
const RECEIPT_ITEM_LABEL_FIELDS = ['name', 'title', 'displayName', 'path', 'key'];
const RECEIPT_MAX_TARGETS = 3;
const textOf = value => (typeof value === 'string' || typeof value === 'number' ? trim(value).slice(0, 60) : '');
const receiptLabelOf = value => {
  if (!isPlainObject(value)) return textOf(value);
  for (const key of RECEIPT_ITEM_LABEL_FIELDS) {
    const text = textOf(value[key]);
    if (text) return text;
  }
  return '';
};
const receiptTargetOf = step => {
  for (const source of [step.output?.result, step.input?.args]) {
    if (!isPlainObject(source)) continue;
    for (const key of RECEIPT_TARGET_FIELDS) {
      const text = receiptLabelOf(source[key]);
      if (text) return text;
    }
    for (const key of RECEIPT_TARGET_LIST_FIELDS) {
      const labels = [...new Set((Array.isArray(source[key]) ? source[key] : []).map(receiptLabelOf).filter(Boolean))];
      if (labels.length) return labels.slice(0, RECEIPT_MAX_TARGETS).join('、') + (labels.length > RECEIPT_MAX_TARGETS ? '…' : '');
    }
  }
  return '';
};

// 这条任务里实际成功、会改内容的工具步骤，最多取最近 6 条。isWriteTool 照工具定义的 capabilities.write 回答：
// 明确为 false 的读取步骤不列；查不到定义的工具按写入列出（与 maid-run-target-ledger 同一规则）。待办清单读写、
// 结果表明没有实际改动的步骤不列。
export const listMaidRunReceipts = (run, { isWriteTool = () => undefined } = {}) => (run?.steps || []).filter((step) => {
  const toolName = trim(step.input?.toolName);
  return step.status === 'succeeded' && step.output?.result?.ok !== false
    && !toolName.startsWith('maid.todo.') && isWriteTool(toolName) !== false
    && !isNoChangeResult(step.output?.result) && step.output?.localToolExecutionSkipped !== true;
}).map(step => {
  const feature = APP_FEATURE_DEFINITIONS.find(item => item.directAction === step.input?.toolName);
  if (!feature) return trim(step.output?.summary || step.summary);
  const target = receiptTargetOf(step);
  return `${t(feature.title)}${target ? ` · ${target}` : ''}`;
}).filter(Boolean).slice(-6);

// 进度以实际成功的工具步骤为准：待办是自由文字，对不上具体步骤，有成功步骤时只把没勾掉的待办列为
// 「可能未同步」的清单，不断定它们没做；没有任何成功步骤时才列为尚未完成
export const describeMaidRunProgress = (run, options = {}) => {
  const todos = todosOf(run);
  const done = todos.filter(todo => todo.status === 'completed').map(todo => trim(todo.content));
  const pending = todos.filter(todo => ['pending', 'in_progress'].includes(todo.status)).map(todo => trim(todo.content));
  const receipts = listMaidRunReceipts(run, options);
  return [
    done.length ? t('已完成：{items}。', { items: done.join('、') }) : '',
    receipts.length ? t('成功操作记录：{items}。', { items: receipts.join('；') }) : '',
    pending.length ? t(receipts.length ? '待办清单（可能未同步，以成功操作记录为准）：{items}。' : '尚未完成：{items}。', { items: pending.join('、') }) : '',
  ].filter(Boolean);
};

export const describeMaidRunStatus = (run, options = {}) => {
  const todos = todosOf(run);
  const label = run.status === 'succeeded' ? t('已完成') : run.status === 'cancelled' ? t('已取消') : t('尚未完成');
  const cause = describeMaidRunInterruption(run);
  return [
    t('任务「{goal}」：{status}。', { goal: trim(run.metadata?.goal || run.title), status: label }),
    ...describeMaidRunProgress(run, options),
    run.metadata?.continuable === true && cause ? t('中断原因：{reason}。', { reason: cause }) : '',
    !todos.length ? t('该任务没有保存逐项待办，以上状态来自任务记录。') : '',
  ].filter(Boolean).join('\n');
};

const chainRuns = (runtime, source, context) => {
  const pending = [source.id], seen = new Set(), chain = [];
  while (pending.length) {
    const id = pending.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const run = runtime.getRun(id);
    if (!runBelongsToMaidContext(run, context)) continue;
    chain.push(run);
    const snapshot = resolveMaidRunContinuationFromRun(run);
    pending.push(run.metadata?.resumedFromRunId, snapshot?.rootRunId, ...(snapshot?.priorRunIds || []));
  }
  return chain;
};

// 取消这条任务与它接续链上所有尚未完成的任务；已完成的结果保留。回传实际改成取消的任务 ID
export const cancelMaidRunChain = ({ runtime, run, context }) => {
  const cancelled = [];
  for (const source of chainRuns(runtime, run, context)) {
    if (source.status === 'succeeded' || source.metadata?.continuationResolution?.status === 'succeeded') continue;
    const saved = runtime.finishRun(source.id, {
      status: 'cancelled', cancelReason: 'user_cancelled_followup',
      metadata: { maidStatus: 'cancelled', continuable: false, continuationSnapshot: null, continueHint: '',
        continuationResolution: { status: 'cancelled', at: Date.now() },
        todos: todosOf(source).map(todo => ({ ...todo, status: todo.status === 'completed' ? 'completed' : 'cancelled' })),
      },
    });
    if (saved) cancelled.push(source.id);
  }
  return cancelled;
};

export const settleMaidRunContinuation = ({ runtime, context, continuation, childRun, result }) => {
  if (!continuation?.sourceRunId || !childRun) return;
  const source = runtime.getRun(continuation.sourceRunId);
  if (!runBelongsToMaidContext(source, context) || (source.metadata?.continuationResolution
    && source.metadata.continuationResolution.runId !== childRun.id)
    || source.cancelReason === 'user_cancelled_followup') return;
  const childTodos = todosOf(childRun);
  const complete = result?.ok === true && result?.continuable !== true
    && hasMaidContinuationProgress(childRun)
    && !getMaidContinuationPendingTodos(continuation, childRun).length;
  if (!complete) {
    if (result?.continuable === true) runtime.updateRun(source.id, { metadata: {
      continuable: false, continuedByRunId: childRun.id,
    } });
    return;
  }
  const chain = chainRuns(runtime, source, context);
  const completedContents = new Set([...childTodos, ...chain.flatMap(todosOf)]
    .filter(todo => todo.status === 'completed').map(todo => todo.content));
  for (const ancestor of chain) {
    if (ancestor.cancelReason === 'user_cancelled_followup') continue;
    runtime.finishRun(ancestor.id, { status: 'succeeded', errorMessage: '',
      summary: childRun.summary,
      metadata: {
        continuable: false, continuationSnapshot: null, continueHint: '', maidStatus: 'succeeded',
        continuationResolution: { status: 'succeeded', runId: childRun.id, at: Date.now() },
        originalInterruption: ancestor.metadata?.originalInterruption || { status: ancestor.status, reason: ancestor.metadata?.reason || '' },
        todos: todosOf(ancestor).map(todo => ({ ...todo,
          status: childTodos.find(item => item.content === todo.content)?.status
            || (completedContents.has(todo.content) ? 'completed' : todo.status),
        })),
      },
    });
  }
};

export const hasMaidContinuationProgress = run => (run?.steps || []).some(step => {
  const tool = trim(step.input?.toolName || step.toolName);
  return step.status === 'succeeded' && step.output?.result?.ok !== false
    && tool && !tool.startsWith('maid.todo.') && !['app.search_feature', 'app.read_skill', 'app.read_feature_doc'].includes(tool);
});

// Preserve the original obligations even if a model replaces or empties its todo
// list. A changed description is not evidence that the original work was done.
export const getMaidContinuationPendingTodos = (continuation, run) => {
  if (!continuation) return [];
  const todos = todosOf(run);
  const pending = new Map();
  for (const todo of continuation.remainingTodos || []) {
    if (!todos.some(item => item.content === todo.content && item.status === 'completed')) pending.set(todo.content, todo);
  }
  for (const todo of todos) {
    if (['pending', 'in_progress'].includes(todo.status)) pending.set(todo.content, todo);
  }
  return [...pending.values()].map(clone);
};

export const guardMaidContinuationResult = ({ result, continuation, run }) => {
  if (!continuation || result?.ok !== true || result.status === 'awaiting_confirmation') return result;
  const remaining = getMaidContinuationPendingTodos(continuation, run);
  if (!remaining.length && hasMaidContinuationProgress(run)) return result;
  return { ...result, ok: false, status: 'interrupted', continuable: true,
    reason: 'continuation_incomplete', reactStoppedReason: 'continuation_incomplete',
    message: t('这条任务尚未确认全部完成，已保留已完成的结果和剩余步骤。')
      + (remaining.length ? '\n' + remaining.map(todo => `- ${todo.content}`).join('\n') : ''),
  };
};
