import { t } from '../../i18n/index.js';
import {
  cancelMaidRunChain,
  describeMaidRunInterruption,
  describeMaidRunProgress,
  describeMaidRunStatus,
  getMaidRunInterruptionCode,
  isMaidRunActive,
  isMaidRunResumable,
  listMaidRunReceipts,
  runBelongsToMaidContext,
} from '../maid-run-followup.js';

// 女仆之前的任务（参考 Noa 的 get_task／find_tasks／cancel_task）：查、读、取消、续跑都由模型决定要不要调用。
// 作用域与任务历史相同：只看当前角色卡（runBelongsToMaidContext）。
export const MAID_TASK_LIST_TOOL = 'maid.task.list';
export const MAID_TASK_READ_TOOL = 'maid.task.read';
export const MAID_TASK_CANCEL_TOOL = 'maid.task.cancel';
export const MAID_TASK_RESUME_TOOL = 'maid.task.resume';

const trim = value => String(value ?? '').trim();
const todosOf = run => Array.isArray(run?.metadata?.todos) ? run.metadata.todos : [];
const goalOf = run => trim(run?.metadata?.goal || run?.title);
// 中断原因用与任务纪录摘要同一套说法；翻译过的另附原始代码
const interruptionFields = (run) => {
  const code = getMaidRunInterruptionCode(run);
  if (!code) return {};
  const text = describeMaidRunInterruption(run);
  return { interruption: text, ...(text !== code ? { interruptionCode: code } : {}) };
};
const READ_CAPABILITIES = Object.freeze({
  read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'allowlist', confirmation: 'allow_once',
});
const taskIdSchema = { type: 'string', minLength: 1, maxLength: 200, description: 'Task id from maid.task.list.' };

export const createMaidTaskTools = ({ agentTaskRuntime = null, resumeRun = null, isWriteTool = null } = {}) => {
  const runtime = () => (agentTaskRuntime && typeof agentTaskRuntime.getRun === 'function' ? agentTaskRuntime : null);
  // 成功操作记录只列会改内容的步骤：isWriteTool 照工具定义的 capabilities.write 判断（registerMaidTaskTools 接上工具登记表）
  const receiptOptions = typeof isWriteTool === 'function' ? { isWriteTool } : {};
  // 本轮正在执行的任务、以及本轮正在接着做的那条，都不算「可以接着做」
  const isSelf = (run, context) => run.id === trim(context?.runId);
  const resumableIn = (run, context) => isMaidRunResumable(run) && !isSelf(run, context)
    && run.id !== trim(context?.runContinuation?.sourceRunId);
  const findTask = (taskId, context) => {
    const id = trim(taskId);
    const run = id ? runtime()?.getRun(id) : null;
    return run && runBelongsToMaidContext(run, context) && !isSelf(run, context) ? run : null;
  };
  const notFound = taskId => ({ ok: false, reason: 'task_not_found', taskId: trim(taskId) });
  const unavailable = () => ({ ok: false, reason: 'task_store_unavailable' });
  // 待办计数照任务最后保存的勾选状态，可能落后于实际成功的步骤（successfulSteps）
  const todoCounts = run => {
    const todos = todosOf(run);
    return {
      total: todos.length,
      markedCompleted: todos.filter(todo => todo.status === 'completed').length,
      markedOpen: todos.filter(todo => ['pending', 'in_progress'].includes(todo.status)).length,
    };
  };

  return [
    {
      name: MAID_TASK_LIST_TOOL,
      title: 'List maid tasks',
      description: 'List maid tasks of the active character card that can be continued (resumable:true) or are still in progress, newest first, with id, title, status, the saved todo checklist counts, the number of successful steps that changed content and the interruption reason. includeFinished:true also lists recently finished, cancelled or failed tasks.',
      source: 'maid-task',
      permissions: [],
      riskLevel: 'low',
      capabilities: READ_CAPABILITIES,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeFinished: { type: 'boolean', description: 'Also list finished, cancelled and failed tasks.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10.' },
        },
      },
      execute: async (args = {}, context = {}) => {
        if (!runtime()) return unavailable();
        const limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit)) || 10));
        const tasks = (runtime().listRuns?.({ kind: 'maid_assistant', limit: 100 }) || [])
          .filter(run => runBelongsToMaidContext(run, context) && !isSelf(run, context))
          .filter(run => args.includeFinished === true || resumableIn(run, context) || isMaidRunActive(run))
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
          .slice(0, limit)
          .map(run => ({
            id: run.id,
            title: goalOf(run),
            status: trim(run.status),
            resumable: resumableIn(run, context),
            updatedAt: Number(run.updatedAt) || 0,
            todos: todoCounts(run),
            successfulSteps: listMaidRunReceipts(run, receiptOptions).length,
            ...(run.metadata?.continuable === true ? interruptionFields(run) : {}),
          }));
        return { ok: true, count: tasks.length, tasks };
      },
      summarizeResult: result => (result?.ok === false
        ? `task list unavailable: ${trim(result?.reason)}`
        : `${Number(result?.count || 0)} maid task(s) listed`),
    },
    {
      name: MAID_TASK_READ_TOOL,
      title: 'Read a maid task record',
      description: 'Read the stored record of one maid task: status, the saved todo checklist, the successful steps that changed content and the interruption reason. Successful steps come from the actual tool results; the checklist statuses are what the task last saved and can lag behind them.',
      source: 'maid-task',
      permissions: [],
      riskLevel: 'low',
      capabilities: READ_CAPABILITIES,
      schema: {
        type: 'object',
        required: ['taskId'],
        additionalProperties: false,
        properties: { taskId: taskIdSchema },
      },
      execute: async (args = {}, context = {}) => {
        if (!runtime()) return unavailable();
        const run = findTask(args.taskId, context);
        if (!run) return notFound(args.taskId);
        const todos = todosOf(run).map(todo => ({ content: trim(todo.content), status: trim(todo.status) }));
        return {
          ok: true,
          task: {
            id: run.id,
            title: goalOf(run),
            status: trim(run.status),
            resumable: resumableIn(run, context),
            updatedAt: Number(run.updatedAt) || 0,
            todos,
            successfulSteps: listMaidRunReceipts(run, receiptOptions),
            ...interruptionFields(run),
          },
          summary: describeMaidRunStatus(run, receiptOptions),
        };
      },
      summarizeResult: result => (result?.ok === false
        ? `task record unavailable: ${trim(result?.reason)}`
        : `read maid task ${trim(result?.task?.id)} (${trim(result?.task?.status)})`),
    },
    {
      name: MAID_TASK_CANCEL_TOOL,
      title: 'Cancel a maid task',
      description: 'Cancel an unfinished maid task (resumable:true in maid.task.list) when the user explicitly asks to cancel or drop it. Results already completed stay; the remaining steps will not run and the task can no longer be continued. The APP asks the user to confirm first. The result reports the cancelled task ids and whether the cancellation was saved.',
      source: 'maid-task',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: false, write: true, network: false, cost: 'none', undo: 'none', modelContext: 'allowlist', confirmation: 'required',
      },
      safety: {
        operationType: 'cancel_maid_task',
        destructive: 'conditional',
        preflight: async (args = {}, context = {}) => {
          const run = runtime() ? findTask(args.taskId, context) : null;
          if (!run || !resumableIn(run, context)) return { destructive: false, operationType: 'cancel_maid_task' };
          // 进度照实际成功的步骤写（与读任务纪录、任务状态回报同一套）；保存的待办可能还没勾掉已做完的项
          return {
            destructive: true,
            kind: MAID_TASK_CANCEL_TOOL,
            operationType: 'cancel_maid_task',
            title: t('取消任务'),
            message: [
              t('将取消任务「{goal}」：已完成的结果保留，剩余步骤不再继续，之后也不能再接着做。', { goal: goalOf(run) }),
              ...describeMaidRunProgress(run, receiptOptions),
            ].join('\n'),
            confirmText: t('取消任务'),
            cancelText: t('保留任务'),
            danger: true,
            onDeny: { action: 'skip', reason: 'task_cancel_declined', result: { ok: false, skipped: true, reason: 'task_cancel_declined' } },
          };
        },
      },
      schema: {
        type: 'object',
        required: ['taskId'],
        additionalProperties: false,
        properties: { taskId: taskIdSchema },
      },
      execute: async (args = {}, context = {}) => {
        if (!runtime()) return unavailable();
        const run = findTask(args.taskId, context);
        if (!run) return notFound(args.taskId);
        if (!resumableIn(run, context)) return { ok: false, reason: 'task_not_cancellable', taskId: run.id, status: trim(run.status) };
        if (typeof runtime().finishRun !== 'function') return unavailable();
        const cancelledTaskIds = cancelMaidRunChain({ runtime: runtime(), run, context });
        if (!cancelledTaskIds.includes(run.id)) return { ok: false, reason: 'task_cancel_failed', taskId: run.id, cancelledTaskIds };
        let persisted = false;
        try { persisted = await runtime().flush?.() !== false; } catch {}
        // 不用 cancelled 这个字段名：在女仆执行层它表示「这次工具调用被用户取消」，会让本轮以「已取消」结束
        return { ok: true, taskCancelled: true, taskId: run.id, title: goalOf(run), cancelledTaskIds, persisted };
      },
      summarizeResult: result => {
        if (result?.ok === false) return `task not cancelled: ${trim(result?.reason)}`;
        return result?.persisted
          ? `cancelled maid task ${trim(result?.taskId)}; saved`
          : `cancelled maid task ${trim(result?.taskId)} for this session; saving was not confirmed`;
      },
    },
    {
      name: MAID_TASK_RESUME_TOOL,
      title: 'Continue a maid task',
      description: 'Continue an interrupted maid task (resumable:true in maid.task.list) when the user asks to continue it. The APP queues it the same way as the 继续 button in the task history: a new run starts after this turn with the task record (successful steps, unfinished todos, interruption reason), verifies earlier writes by their stored ids instead of repeating them, and reports its own result. This turn ends once the task is queued.',
      source: 'maid-task',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: false, write: false, network: false, cost: 'variable', undo: 'none', modelContext: 'allowlist', confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['taskId'],
        additionalProperties: false,
        properties: { taskId: taskIdSchema },
      },
      execute: async (args = {}, context = {}) => {
        if (!runtime()) return unavailable();
        const run = findTask(args.taskId, context);
        if (!run) return notFound(args.taskId);
        if (!resumableIn(run, context)) return { ok: false, reason: 'task_not_resumable', taskId: run.id, status: trim(run.status) };
        if (typeof resumeRun !== 'function') return { ok: false, reason: 'task_resume_unavailable', taskId: run.id };
        // 只排队、不等续跑做完：续跑要等本轮结束才开始
        if (resumeRun(run) === false) return { ok: false, reason: 'task_resume_unavailable', taskId: run.id };
        return { ok: true, queued: true, taskId: run.id, title: goalOf(run) };
      },
      summarizeResult: result => (result?.ok === false
        ? `task not resumed: ${trim(result?.reason)}`
        : `queued maid task ${trim(result?.taskId)} to continue`),
    },
  ];
};

export const registerMaidTaskTools = (registry, deps = {}) => {
  const tools = createMaidTaskTools({ isWriteTool: name => registry?.get?.(name)?.capabilities?.write, ...deps });
  if (registry && typeof registry.registerMany === 'function') registry.registerMany(tools);
  return tools;
};
