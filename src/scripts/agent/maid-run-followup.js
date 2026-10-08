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

export const classifyMaidRunFollowup = (input = '') => {
  const text = trim(input).normalize('NFKC').replace(/[。！!？?\s]+$/u, '');
  const named = text.match(/^(继续|取消|查看)(?:任务)?[「“"]([^」”"]+)[」”"]$/u);
  if (named) return { 继续: 'resume', 取消: 'cancel', 查看: 'status' }[named[1]];
  if (/^(?:(?:请|麻烦)?(?:继续(?:吧|执行|做|上次的任务|之前的任务|昨天那个)?|接着做)|(?:please\s+)?(?:continue|resume)(?:\s+(?:that|the previous)\s+task)?)$/iu.test(text)) return 'resume';
  if (/^(?:(?:算了[，, ]*)?(?:那个|这个|刚才那个|之前那个|上次那个)?(?:任务)?(?:不用了|不要了|先不做了)|算了|取消(?:那个|这个|刚才那个|之前那个)?任务|(?:please\s+)?(?:cancel|stop)\s+(?:that|the previous)\s+task|never\s*mind)$/iu.test(text)) return 'cancel';
  if (/^(?:(?:昨天|刚才|之前|上次|前面)(?:那个|的)?(?:任务)?|那个任务|这个任务)(?:弄好|做好|做完|完成|结束)了?(?:吗|没|没有|了吗|了没)$|^(?:那个|这个|刚才的|之前的)?任务(?:的)?(?:进度|状态)(?:怎么样|如何|呢)?$|^(?:is|was)\s+(?:that|the previous)\s+task\s+(?:done|finished)$/iu.test(text)) return 'status';
  return '';
};

export const resolveMaidRunFollowup = ({ input = '', context = {}, runs = [] } = {}) => {
  const action = classifyMaidRunFollowup(input);
  if (!action || !trim(context.roleCardId) || context.source === 'maid_realtime' || context.voiceCallId || context.runContinuation) return null;
  const name = trim(trim(input).match(/^(?:继续|取消|查看)(?:任务)?[「“"]([^」”"]+)[」”"]/u)?.[1]);
  const owned = runs.filter(run => runBelongsToMaidContext(run, context)
    && (!name || trim(run.metadata?.goal || run.title) === name));
  const resumable = owned.filter(run => run.metadata?.continuable === true
    && !run.metadata?.continuedByRunId && !run.metadata?.continuationResolution
    && !['running', 'queued', 'waiting_permission', 'succeeded'].includes(run.status));
  if (resumable.length > 1) return { action, ambiguous: true, candidates: resumable };
  const run = resumable[0] || (action === 'status'
    ? owned.filter(run => !['running', 'queued', 'waiting_permission'].includes(run.status))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]
    : null);
  return run ? { action, run, continuation: action === 'resume' ? resolveMaidRunContinuationFromRun(run) : null }
    : action !== 'resume' || name ? { action, unavailable: true } : null;
};

const baseReply = (input, reason, message, extra = {}) => ({
  ok: true, status: 'responded', responseType: 'workflow', input: trim(input), reason, message, ...extra,
});

export const describeMaidRunStatus = run => {
  const todos = todosOf(run);
  const done = todos.filter(todo => todo.status === 'completed').map(todo => trim(todo.content));
  const pending = todos.filter(todo => ['pending', 'in_progress'].includes(todo.status)).map(todo => trim(todo.content));
  const label = run.status === 'succeeded' ? t('已完成') : run.status === 'cancelled' ? t('已取消') : t('尚未完成');
  const reason = trim(run.metadata?.reason || run.metadata?.continuationSnapshot?.reason || run.errorMessage);
  const cause = reason === 'provider_request_failed' ? t('规划模型请求失败') : reason;
  const receipts = (run.steps || []).filter(step => step.status === 'succeeded' && step.output?.result?.ok !== false
    && !trim(step.input?.toolName).startsWith('maid.todo.')).map(step => {
    const feature = APP_FEATURE_DEFINITIONS.find(item => item.directAction === step.input?.toolName);
    if (!feature) return trim(step.output?.summary || step.summary);
    const target = trim(step.output?.result?.target?.name || step.input?.args?.subject);
    return `${t(feature.title)}${target ? ` · ${target}` : ''}`;
  }).filter(Boolean).slice(-6);
  return [
    t('任务「{goal}」：{status}。', { goal: trim(run.metadata?.goal || run.title), status: label }),
    done.length ? t('已完成：{items}。', { items: done.join('、') }) : '',
    receipts.length ? t('成功操作记录：{items}。', { items: receipts.join('；') }) : '',
    pending.length ? t(receipts.length ? '待办清单（可能未同步，以成功操作记录为准）：{items}。' : '尚未完成：{items}。', { items: pending.join('、') }) : '',
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

export const handleMaidRunFollowup = ({ followup, runtime, input, context }) => {
  if (!followup) return null;
  if (followup.unavailable) return baseReply(input, 'maid_previous_task_unavailable',
    t('当前角色卡中没有找到符合条件的任务，没有更改任何任务。'));
  if (followup.ambiguous) return baseReply(input, 'maid_previous_task_ambiguous',
    t('有多条未完成的任务，请说明任务名称，例如：取消任务「任务名称」。也可从任务历史选择继续。') + '\n'
      + followup.candidates.slice(0, 5).map(run => `- ${trim(run.metadata?.goal || run.title)}`).join('\n'));
  const run = runtime.getRun(followup.run.id);
  if (!runBelongsToMaidContext(run, context)) return null;
  if (followup.action === 'status') return baseReply(input, 'maid_previous_task_status', describeMaidRunStatus(run), {
    taskReadback: { runId: run.id, goal: trim(run.metadata?.goal || run.title), status: run.status,
      todos: clone(todosOf(run)), reason: trim(run.metadata?.reason),
      continuation: resolveMaidRunContinuationFromRun(run),
      evidenceRule: 'This is a readback of the selected stored task, not a new empty todo list. Successful tool receipts take precedence over stale todo labels. provider_request_failed means the planning model request failed, not image generation. Report what actually completed and what remains; do not execute or claim cancellation.',
    },
  });
  if (followup.action !== 'cancel') return null;
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
  if (!cancelled.includes(run.id)) return baseReply(input, 'maid_previous_task_cancel_failed',
    t('任务取消未保存成功，请从任务历史中重试。'), { ok: false, status: 'failed' });
  return baseReply(input, 'maid_previous_task_cancelled',
    t('已取消这条未完成任务，已完成的结果保留，剩余步骤不再继续。'), {
      status: 'cancelled', taskReadback: { runId: run.id, status: 'cancelled', cancelledRunIds: cancelled },
    });
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
