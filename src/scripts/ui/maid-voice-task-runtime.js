import { t } from '../i18n/index.js';
import { classifyMaidPendingActionReply } from '../agent/maid-pending-action.js';
import { MAID_IMPORTED_CARD_WORKFLOW_KIND } from '../agent/maid-imported-card-workflow.js';
import { buildMaidResultBasis, normalizeMaidResultBasis } from '../agent/maid-result-basis.js';

const text = value => String(value ?? '').trim();
const terminal = task => ['succeeded', 'failed', 'cancelled', 'awaiting_confirmation'].includes(task.status);
// 续接授权只属于那一次“允许”：复用任务上下文（修订、引用旧任务继续做事）时必须去掉
const withoutPendingAuthorization = (context) => {
  if (!context) return context;
  const { pendingActionSubmissionId, ...rest } = context;
  return rest;
};
// 引用旧任务交办的新请求：沿用它的目标房间与附图，但技能按本次通话当前的选择重新准备，不沿用旧任务冻结的技能
const forNewTaskFrom = (context) => {
  if (!context) return context;
  const { maidSkillContext, maidSkillContextPrepared, maidTaskInputs, ...rest } = withoutPendingAuthorization(context);
  return rest;
};
const publicTask = task => task ? { task_id: task.id, request: task.request, status: task.status, message: task.message, has_references: Boolean(task.attachments?.length || task.context?.userSelection?.length),
  ...(task.resultBasis ? { resultBasis: normalizeMaidResultBasis(task.resultBasis) } : {}) } : null;

// Owns accepted voice work independently of the microphone/session lifetime.
// Execution, ordering and cancellation still belong to the existing maid queue.
export const createMaidVoiceTaskRuntime = ({
  getCommandRuntime, captureContext = () => ({}), onChange = () => {}, onResult = () => {},
  prepareSubmission = null,
  // 口头“允许”：只作用于本通话任务正在卡内等待的确认，结果恒为允许一次
  getApproval = () => null,
  confirmApproval = () => false,
  cancelPendingAction = () => false,
  makeId = () => `maid_voice_${globalThis.crypto.randomUUID()}`,
  now = Date.now,
} = {}) => {
  const tasks = new Map();
  const requests = new Map();
  let latest = null;
  const scopedTasks = callId => [...tasks.values()].filter(task => !callId || task.target?.maidCallId === callId);
  const snapshot = (callId = '') => {
    const list = scopedTasks(callId);
    return { active: list.filter(task => !terminal(task)).map(publicTask), latest: publicTask(list.at(-1)), recent: list.slice(-3).reverse().map(publicTask) };
  };
  const notify = () => { try { onChange(snapshot()); } catch {} };
  const prune = () => {
    for (const [id, task] of tasks) {
      if (tasks.size <= 80) break;
      if (terminal(task) && task !== latest) tasks.delete(id);
    }
    while (requests.size > 160) requests.delete(requests.keys().next().value);
  };
  const findTask = (id, callId) => {
    const list = scopedTasks(callId);
    return id ? list.find(task => task.id === id) : list.find(task => !terminal(task)) || list.at(-1);
  };
  const followContinuation = task => {
    while (task?.continuationId && tasks.has(task.continuationId)) task = tasks.get(task.continuationId);
    return task;
  };
  const syncClosedWorkflow = task => {
    if (task?.status !== 'awaiting_confirmation' || !['succeeded', 'failed', 'cancelled'].includes(task.traceStatus)) return false;
    task.status = task.traceStatus;
    task.message = task.traceSummary || task.message;
    return true;
  };
  const confirmationTarget = (id, callId) => {
    const taskId = id ? (followContinuation(tasks.get(id))?.id || id) : '';
    const list = scopedTasks(callId).filter(task => task.target?.maidCallId === callId && (!taskId || task.id === taskId));
    if (taskId && !list.length) return { error: { ok: false, message: t('找不到引用的女仆任务，请重新说明目标') } };
    // 卡内授权期间 submission 仍是 running；确认归属取真实权限项，不能靠最后交办的任务猜测。
    // 已有续接时只看续接任务，避免把原预览与其正在执行的续接算作两个待确认项。
    const candidates = [...new Map(list.map(task => {
      const current = followContinuation(task);
      return [current.id, current];
    })).values()].filter(task => task.status === 'awaiting_confirmation' || (!terminal(task) && getApproval(task.id)));
    if (candidates.length > 1) return { error: {
      ok: false, reason: 'ambiguous_confirmation_target',
      message: t('有多个待确认任务，请说明要确认哪一个'), tasks: candidates.map(publicTask),
    } };
    return { taskId, list, pendingTask: candidates[0] || null };
  };
  const submitPrepared = async ({ request, target, requestId, context, attachments = [], preserveDraft = true, showInput = false, pendingTask = null, useDraftSkills = true }) => {
    // Different provider request IDs may confirm the same preview in one turn.
    // Recheck after reaching the serial queue, where the first continuation is now known.
    const continuation = pendingTask?.continuationId ? followContinuation(tasks.get(pendingTask.continuationId)) : null;
    if (continuation && !continuation.superseded) {
      return { ok: !['failed', 'cancelled'].includes(continuation.status), ...publicTask(continuation), accepted: !terminal(continuation), reused: true };
    }
    if (pendingTask && pendingTask.status !== 'awaiting_confirmation') return { ok: false, message: t('当前没有需要确认的操作') };
    const command = getCommandRuntime?.();
    if (!command?.submitVoiceTask) throw new Error(t('女仆任务入口尚未就绪'));
    const id = makeId();
    const prepared = prepareSubmission ? await prepareSubmission(request, attachments, { source: 'maid_realtime', voiceCallId: target?.maidCallId || '',
      context: structuredClone(context || captureContext()), useDraftSkills }) : {};
    const task = { id, request, target: { ...target }, requestId, context: prepared.context || structuredClone(context || captureContext()), attachments: (prepared.attachments || attachments).map(item => ({ ...item })),
      status: command.isSubmitting?.() ? 'queued' : 'running', message: command.isSubmitting?.() ? t('排队') : t('正在处理'), completion: null,
      pendingActionSubmissionId: pendingTask?.id || '', goal: pendingTask?.goal || request };
    if (pendingTask) pendingTask.continuationId = id;
    tasks.set(id, task); latest = task; prune(); notify();
    let completion;
    try {
      completion = command.submitVoiceTask(request, {
        ...prepared,
        id, source: 'maid_realtime', context: task.context, voiceCallId: target?.maidCallId || '',
        voiceRequestId: requestId, attachments: task.attachments, preserveDraft, showInput,
        onStatus: (message, tone) => {
          if (terminal(task)) return;
          task.status = 'running'; task.message = text(message); task.tone = tone; notify();
        },
      });
    } catch (error) { completion = Promise.reject(error); }
    task.completion = Promise.resolve(completion).then(result => {
      if (!result) throw new Error(t('女仆任务未提交'));
      task.status = result.cancelled || result.status === 'cancelled' ? 'cancelled' : result.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : result.ok === false ? 'failed' : 'succeeded';
      task.pendingWorkflowKind = text(result.pendingWorkflow?.kind);
      task.message = text(result.message || result.summary || result.reason) || t(task.status === 'succeeded' ? '已完成。' : task.status === 'cancelled' ? '任务已终止。' : '执行失败。');
      task.resultBasis = buildMaidResultBasis(result, { traceView: task.traceView, recordedAt: now() });
      syncClosedWorkflow(task);
      return result;
    }).catch(error => {
      task.status = 'failed'; task.message = text(error?.message) || t('执行失败。');
      task.resultBasis = buildMaidResultBasis({}, { traceView: task.traceView, recordedAt: now() });
      return { ok: false, status: 'failed', message: task.message };
    }).then(result => {
      if (pendingTask) { pendingTask.status = task.status === 'awaiting_confirmation' ? 'succeeded' : task.status; pendingTask.message = task.message; }
      notify();
      // The receiver checks the original call identity before speaking a result.
      if (!task.superseded) { try { onResult({ ...publicTask(task), target: task.target, requestId, result }); } catch {} }
      return result;
    });
    return { ok: true, ...publicTask(task), accepted: true };
  };
  // Preparation and queue acceptance are ordered so only one execute takes the call draft.
  let submitQueue = Promise.resolve();
  const submit = options => {
    const result = submitQueue.then(() => submitPrepared(options));
    submitQueue = result.catch(() => {});
    return result;
  };
  const cancel = async (id, all = false, callId = '') => {
    if (id) id = followContinuation(tasks.get(id))?.id || id;
    const available = [...tasks.values()].filter(task => (!terminal(task) || task.status === 'awaiting_confirmation') && (!callId || task.target?.maidCallId === callId));
    const selected = all ? available : [id ? available.find(task => task.id === id) : available.find(task => !terminal(task)) || available.at(-1)].filter(Boolean);
    let count = 0;
    for (const task of selected) {
      const cancelPending = submissionId => cancelPendingAction({ submissionId, voiceCallId: task.target?.maidCallId || '' });
      const stopped = task.status === 'awaiting_confirmation' ? await cancelPending(task.id) : await getCommandRuntime?.()?.cancelSubmission?.(task.id);
      if (stopped) {
        if (task.pendingActionSubmissionId) await cancelPending(task.pendingActionSubmissionId);
        task.status = 'cancelled'; task.message = t('任务已终止。'); count++;
      }
    }
    notify();
    return { ok: count > 0, cancelled: count, message: count ? t('已停止女仆任务') : t('没有正在执行的女仆任务') };
  };
  const revise = async (old, correction, options) => {
    old = followContinuation(old);
    if (!old || (terminal(old) && old.status !== 'awaiting_confirmation')) return { ok: false, message: t('该任务已经结束，请说明接下来需要修改什么') };
    old.superseded = true;
    const stopped = old.status === 'awaiting_confirmation'
      ? await cancelPendingAction({ submissionId: old.id, voiceCallId: old.target?.maidCallId || '' })
      : await getCommandRuntime?.()?.cancelSubmission?.(old.id);
    if (!stopped) { old.superseded = false; return { ok: false, message: t('任务状态已改变，请确认当前结果后再修改') }; }
    old.status = 'cancelled';
    // 新一轮是修订请求，不得继承上一轮的无条件授权标记。
    return submit({ ...options, request: `${old.goal || old.request}\n\n${t('用户修正：')}${correction}`, context: withoutPendingAuthorization(old.context), attachments: old.attachments });
  };
  const request = async ({ args = {}, target, requestId = '', inputText = '', attachments, preserveDraft, showInput } = {}) => {
    const key = `${target?.maidCallId || ''}:${requestId}`;
    if (requestId && requests.has(key)) return requests.get(key);
    const operation = (async () => {
      const action = text(args.action || 'execute');
      if (action === 'status') return { ok: true, ...snapshot(target?.maidCallId) };
      if (action === 'cancel') return cancel(text(args.task_id), args.scope === 'all', target?.maidCallId || '');
      if (action === 'confirm') {
        const selected = confirmationTarget(text(args.task_id), target?.maidCallId);
        if (selected.error) return selected.error;
        const { taskId, list, pendingTask } = selected;
        // 检查原始转写和工具参数；模型将带条件的原话缩写为“允许”也不能扩大授权。
        const answers = [text(inputText), text(args.request)].filter(Boolean);
        const replies = answers.map(answer => classifyMaidPendingActionReply(answer, { voice: true }));
        const correctionIndex = replies.indexOf('none');
        // 带条件的确认与取消都作用于正在等待确认的那个任务，而不是本通话最后交办的任务
        if (correctionIndex !== -1 || replies.includes('cancel')) {
          if (!pendingTask) return { ok: false, message: t('当前没有需要确认的操作') };
          return correctionIndex !== -1
            ? revise(pendingTask, answers[correctionIndex], { target, requestId, preserveDraft, showInput })
            : cancel(pendingTask.id, false, target?.maidCallId || '');
        }
        const vague = replies.includes('ambiguous');
        if (vague && pendingTask?.pendingWorkflowKind !== MAID_IMPORTED_CARD_WORKFLOW_KIND) {
          return { ok: false, message: t('请明确说「允许」或「取消」。') };
        }
        if (!vague && pendingTask && getApproval(pendingTask.id) && confirmApproval([pendingTask.id]) === true) {
          return { ok: true, confirmed: true, message: t('已允许一次') };
        }
        if (pendingTask && pendingTask.status !== 'awaiting_confirmation') {
          return { ok: false, message: t('当前没有需要确认的操作') };
        }
        const current = list.at(-1);
        const continuation = pendingTask ? tasks.get(pendingTask.continuationId)
          : tasks.get(current?.continuationId) || (current?.pendingActionSubmissionId ? current : null);
        if (continuation && !continuation.superseded) {
          return { ok: !['failed', 'cancelled'].includes(continuation.status), ...publicTask(continuation), accepted: !terminal(continuation), reused: true };
        }
        if (taskId && !pendingTask) return { ok: false, message: t('当前没有需要确认的操作') };
        // 没有待确认项时，“yes/允许”只是普通回答，交给女仆按上下文处理
        const answer = text(inputText || args.request);
        if (!answer && !pendingTask) return { ok: false, message: t('当前没有需要确认的操作') };
        // 导入建房的短答复可宽松确认；删除与卡内授权仍要求明确同意。
        return submit({ request: pendingTask ? (vague ? answer : '确认') : answer, target, requestId, attachments: attachments?.length ? attachments : pendingTask?.attachments, preserveDraft, showInput, pendingTask, useDraftSkills: false,
          context: pendingTask ? { ...pendingTask.context, pendingActionSubmissionId: pendingTask.id } : undefined });
      }
      const commandText = text(args.request || inputText);
      if (!commandText || commandText.length > 12000) return { ok: false, message: t('请完整说出要女仆处理的需求') };
      if (action === 'revise') {
        const selected = confirmationTarget(text(args.task_id), target?.maidCallId);
        if (selected.error) return selected.error;
        return revise(selected.pendingTask || findTask(selected.taskId, target?.maidCallId), commandText, { target, requestId, preserveDraft, showInput });
      }
      if (action !== 'execute') return { ok: false, message: t('未知的女仆任务操作') };
      const reference = args.task_id ? findTask(text(args.task_id), target?.maidCallId) : null;
      if (args.task_id && !reference) return { ok: false, message: t('找不到引用的女仆任务，请重新说明目标') };
      return submit({ request: commandText, target, requestId, attachments: attachments?.length ? attachments : reference?.attachments,
        context: forNewTaskFrom(reference?.context), preserveDraft, showInput });
    })();
    if (requestId) requests.set(key, operation);
    prune();
    return operation;
  };
  return {
    request, cancel, getState: snapshot,
    updateTaskFromTrace: view => {
      const task = tasks.get(text(view?.submissionId));
      if (!task) return;
      if (task.traceView?.runId && task.traceView.runId !== text(view.runId)) return;
      if (Number(view.updatedAt) < Number(task.traceView?.updatedAt)) return;
      task.traceView = { runId: text(view.runId), updatedAt: Number(view.updatedAt) || 0,
        steps: (Array.isArray(view.steps) ? view.steps : []).map(step => ({
          id: text(step.id), toolName: text(step.toolName), status: text(step.status),
          startedAt: Number(step.startedAt) || 0, finishedAt: Number(step.finishedAt) || 0,
        })) };
      if (task.resultBasis) task.resultBasis = buildMaidResultBasis({ resultBasis: task.resultBasis }, {
        traceView: task.traceView, recordedAt: task.resultBasis.recordedAt,
      });
      task.traceStatus = text(view.status);
      task.traceSummary = text(view.doneSummary);
      const closed = syncClosedWorkflow(task);
      if (closed || task.resultBasis) notify();
    },
    getTaskMeta: id => {
      const task = tasks.get(text(id));
      return task ? { task_id: task.id, request: task.request, target: task.target, requestId: task.requestId, status: task.status } : null;
    },
  };
};
