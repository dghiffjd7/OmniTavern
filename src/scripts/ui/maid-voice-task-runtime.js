import { t } from '../i18n/index.js';

const text = value => String(value ?? '').trim();
const terminal = task => ['succeeded', 'failed', 'cancelled', 'awaiting_confirmation'].includes(task.status);
const publicTask = task => task ? { task_id: task.id, request: task.request, status: task.status, message: task.message, has_references: Boolean(task.attachments?.length || task.context?.userSelection?.length) } : null;

// Owns accepted voice work independently of the microphone/session lifetime.
// Execution, ordering and cancellation still belong to the existing maid queue.
export const createMaidVoiceTaskRuntime = ({
  getCommandRuntime, captureContext = () => ({}), onChange = () => {}, onResult = () => {},
  makeId = () => `maid_voice_${globalThis.crypto.randomUUID()}`,
} = {}) => {
  const tasks = new Map();
  const requests = new Map();
  let latest = null;
  const snapshot = () => ({
    active: [...tasks.values()].filter(task => !terminal(task)).map(publicTask),
    latest: publicTask(latest),
  });
  const notify = () => { try { onChange(snapshot()); } catch {} };
  const prune = () => {
    for (const [id, task] of tasks) {
      if (tasks.size <= 80) break;
      if (terminal(task) && task !== latest) tasks.delete(id);
    }
    while (requests.size > 160) requests.delete(requests.keys().next().value);
  };
  const findTask = id => id ? tasks.get(id) : [...tasks.values()].find(task => !terminal(task)) || latest;
  const submit = ({ request, target, requestId, context, attachments = [], preserveDraft = true, showInput = false }) => {
    const command = getCommandRuntime?.();
    if (!command?.submitVoiceTask) throw new Error(t('女仆任务入口尚未就绪'));
    const id = makeId();
    const task = { id, request, target: { ...target }, requestId, context: structuredClone(context || captureContext()), attachments: attachments.map(item => ({ ...item })),
      status: command.isSubmitting?.() ? 'queued' : 'running', message: command.isSubmitting?.() ? t('排队') : t('正在处理'), completion: null };
    tasks.set(id, task); latest = task; prune(); notify();
    let completion;
    try {
      completion = command.submitVoiceTask(request, {
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
      task.message = text(result.message || result.summary || result.reason) || t(task.status === 'succeeded' ? '已完成。' : task.status === 'cancelled' ? '任务已终止。' : '执行失败。');
      return result;
    }).catch(error => {
      task.status = 'failed'; task.message = text(error?.message) || t('执行失败。');
      return { ok: false, status: 'failed', message: task.message };
    }).then(result => {
      notify();
      // The receiver checks the original call identity before speaking a result.
      if (!task.superseded) { try { onResult({ ...publicTask(task), target: task.target, requestId, result }); } catch {} }
      return result;
    });
    return { ok: true, ...publicTask(task), accepted: true };
  };
  const cancel = async (id, all = false) => {
    const selected = all ? [...tasks.values()].filter(task => !terminal(task)) : [findTask(id)].filter(task => task && !terminal(task));
    let count = 0;
    for (const task of selected) {
      if (await getCommandRuntime?.()?.cancelSubmission?.(task.id)) count++;
    }
    return { ok: count > 0, cancelled: count, message: count ? t('已停止女仆任务') : t('没有正在执行的女仆任务') };
  };
  const request = async ({ args = {}, target, requestId = '', inputText = '', attachments, preserveDraft, showInput } = {}) => {
    const key = `${target?.maidCallId || ''}:${requestId}`;
    if (requestId && requests.has(key)) return requests.get(key);
    const operation = (async () => {
      const action = text(args.action || 'execute');
      if (action === 'status') return { ok: true, ...snapshot() };
      if (action === 'cancel') return cancel(text(args.task_id), args.scope === 'all');
      const commandText = text(args.request || inputText);
      if (!commandText || commandText.length > 12000) return { ok: false, message: t('请完整说出要女仆处理的需求') };
      if (action === 'revise') {
        const old = findTask(text(args.task_id));
        if (!old || (terminal(old) && old.status !== 'awaiting_confirmation')) return { ok: false, message: t('该任务已经结束，请说明接下来需要修改什么') };
        old.superseded = true;
        const stopped = old.status === 'awaiting_confirmation' || await getCommandRuntime?.()?.cancelSubmission?.(old.id);
        if (!stopped) { old.superseded = false; return { ok: false, message: t('任务状态已改变，请确认当前结果后再修改') }; }
        // The shared queue drains the cancelled work before starting the revision.
        return submit({ request: `${old.request}\n\n${t('用户修正：')}${commandText}`, target, requestId, context: old.context, attachments: old.attachments });
      }
      if (action !== 'execute') return { ok: false, message: t('未知的女仆任务操作') };
      const reference = args.task_id ? tasks.get(text(args.task_id)) : null;
      if (args.task_id && !reference) return { ok: false, message: t('找不到引用的女仆任务，请重新说明目标') };
      return submit({ request: commandText, target, requestId, attachments: attachments?.length ? attachments : reference?.attachments,
        context: reference?.context, preserveDraft, showInput });
    })();
    if (requestId) requests.set(key, operation);
    prune();
    return operation;
  };
  return { request, cancel, getState: snapshot };
};
