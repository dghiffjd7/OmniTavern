const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

const normalizeTodos = (todos = []) => (Array.isArray(todos) ? todos : [])
  .map((todo) => ({
    content: trim(todo?.content).slice(0, 200),
    status: TODO_STATUSES.has(trim(todo?.status)) ? trim(todo.status) : 'pending',
  }))
  .filter(todo => todo.content)
  .slice(0, 30);

// 女仆持久任务清单（计划 16.7）：todos 挂在当前女仆 run 的 metadata 上，
// 随 run 一起持久化；只记录女仆自己的任务进度，不写用户数据。
export const createMaidTodoTools = ({
  getRun = null,
  updateRun = null,
} = {}) => [
  {
    name: 'maid.todo.write',
    title: 'Write maid todo list',
    description: 'Replace the todo list of the current maid run to track multi-step task progress.',
    source: 'maid-todo',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['todos'],
      additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            required: ['content'],
            additionalProperties: false,
            properties: {
              content: { type: 'string', minLength: 1, maxLength: 200 },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            },
          },
        },
      },
    },
    execute: async (args = {}, context = {}) => {
      const runId = trim(context?.runId);
      if (!runId || typeof updateRun !== 'function') {
        return { ok: false, reason: 'maid_run_unavailable' };
      }
      const todos = normalizeTodos(args.todos);
      const run = getRun?.(runId);
      if (run?.metadata?.resumedFromRunId) {
        const missing = normalizeTodos(run.metadata.todos).filter(todo => ['pending', 'in_progress'].includes(todo.status)
          && !todos.some(item => item.content === todo.content));
        if (missing.length) return { ok: false, reason: 'continuation_todos_missing', todos: missing,
          message: 'Keep the original unfinished todo content strings and update their statuses using actual tool evidence.' };
      }
      if (!updateRun(runId, { metadata: { todos } })) return { ok: false, reason: 'maid_run_unavailable' };
      return { ok: true, count: todos.length, todos };
    },
    summarizeResult: result => (result?.ok === false
      ? 'todo write unavailable'
      : `todo list updated (${Number(result?.count || 0)} item(s))`),
  },
  {
    name: 'maid.todo.read',
    title: 'Read maid todo list',
    description: 'Read the todo list of the current maid run.',
    source: 'maid-todo',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    execute: async (args = {}, context = {}) => {
      const runId = trim(context?.runId);
      if (!runId || typeof getRun !== 'function') {
        return { ok: false, reason: 'maid_run_unavailable' };
      }
      const run = getRun(runId);
      if (!run) return { ok: false, reason: 'maid_run_unavailable' };
      const todos = normalizeTodos(run?.metadata?.todos);
      return { ok: true, count: todos.length, todos };
    },
    summarizeResult: result => (result?.ok === false
      ? 'todo read unavailable'
      : `todo list has ${Number(result?.count || 0)} item(s)`),
  },
];

export const registerMaidTodoTools = (registry, deps = {}) => {
  const tools = createMaidTodoTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
