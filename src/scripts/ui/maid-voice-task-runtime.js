import { t } from '../i18n/index.js';
import { classifyMaidPendingActionReply } from '../agent/maid-pending-action.js';
import { MAID_IMPORTED_CARD_WORKFLOW_KIND } from '../agent/maid-imported-card-workflow.js';

const text = value => String(value ?? '').trim();
const terminal = task => ['succeeded', 'failed', 'cancelled', 'awaiting_confirmation'].includes(task.status);
// 续接授权只属于那一次“允许”：复用任务上下文（修订、引用旧任务继续做事）时必须去掉
const withoutPendingAuthorization = (context) => {
  if (!context) return context;
  const { pendingActionSubmissionId, ...rest } = context;
  return rest;
};
const publicTask = task => task ? { task_id: task.id, request: task.request, status: task.status, message: task.message, has_references: Boolean(task.attachments?.length || task.context?.userSelection?.length) } : null;

// Owns accepted voice work independently of the microphone/session lifetime.
// Execution, ordering and cancellation still belong to the existing maid queue.
export const createMaidVoiceTaskRuntime = ({
  getCommandRuntime, captureContext = () => ({}), onChange = () => {}, onResult = () => {},
  prepareSubmission = null,
  // 口头“允许”：只作用于本通话任务正在卡内等待的确认，结果恒为允许一次
  confirmApproval = () => false,
  cancelPendingAction = () => false,
  makeId = () => `maid_voice_${globalThis.crypto.randomUUID()}`,
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
  const submitPrepared = async ({ request, target, requestId, context, attachments = [], preserveDraft = true, showInput = false, pendingTask = null, useDraftSkills = true }) => {
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
      return result;
    }).catch(error => {
      task.status = 'failed'; task.message = text(error?.message) || t('执行失败。');
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
        const taskId = args.task_id ? (followContinuation(tasks.get(text(args.task_id)))?.id || text(args.task_id)) : '';
        const scopedTasks = [...tasks.values()].filter(task => task.target?.maidCallId === target?.maidCallId && (!taskId || task.id === taskId));
        const pendingTask = scopedTasks.slice().reverse().find(task => task.status === 'awaiting_confirmation');
        // 检查原始转写和工具参数；模型将带条件的原话缩写为“允许”也不能扩大授权。
        const answers = [text(inputText), text(args.request)].filter(Boolean);
        const replies = answers.map(answer => classifyMaidPendingActionReply(answer, { voice: true }));
        const correctionIndex = replies.indexOf('none');
        // 带条件的确认与取消都作用于正在等待确认的那个任务，而不是本通话最后交办的任务
        if (correctionIndex !== -1) return revise(pendingTask || scopedTasks.at(-1), answers[correctionIndex], { target, requestId, preserveDraft, showInput });
        if (replies.includes('cancel')) return cancel(pendingTask?.id || taskId, false, target?.maidCallId || '');
        const vague = replies.includes('ambiguous');
        if (vague && pendingTask?.pendingWorkflowKind !== MAID_IMPORTED_CARD_WORKFLOW_KIND) {
          return { ok: false, message: t('请明确说「允许」或「取消」。') };
        }
        const scope = scopedTasks.filter(task => !terminal(task)).map(task => task.id);
        if (!vague && confirmApproval(scope) === true) return { ok: true, confirmed: true, message: t('已允许一次') };
        const current = scopedTasks.at(-1);
        const continuation = pendingTask ? tasks.get(pendingTask.continuationId)
          : tasks.get(current?.continuationId) || (current?.pendingActionSubmissionId ? current : null);
        if (continuation && !continuation.superseded) {
          return { ok: !['failed', 'cancelled'].includes(continuation.status), ...publicTask(continuation), accepted: !terminal(continuation), reused: true };
        }
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
        return revise(findTask(text(args.task_id), target?.maidCallId), commandText, { target, requestId, preserveDraft, showInput });
      }
      if (action !== 'execute') return { ok: false, message: t('未知的女仆任务操作') };
      const reference = args.task_id ? findTask(text(args.task_id), target?.maidCallId) : null;
      if (args.task_id && !reference) return { ok: false, message: t('找不到引用的女仆任务，请重新说明目标') };
      return submit({ request: commandText, target, requestId, attachments: attachments?.length ? attachments : reference?.attachments,
        context: withoutPendingAuthorization(reference?.context), preserveDraft, showInput });
    })();
    if (requestId) requests.set(key, operation);
    prune();
    return operation;
  };
  return {
    request, cancel, getState: snapshot,
    getTaskMeta: id => {
      const task = tasks.get(text(id));
      return task ? { task_id: task.id, request: task.request, target: task.target, requestId: task.requestId, status: task.status } : null;
    },
  };
};
