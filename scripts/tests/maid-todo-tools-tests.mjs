import assert from 'node:assert/strict';

import { createMaidTodoTools } from '../../src/scripts/agent/tools/maid-todo-tools.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

{
  const runs = new Map([['run-1', { id: 'run-1', metadata: {} }]]);
  const tools = createMaidTodoTools({
    getRun: runId => runs.get(runId) || null,
    updateRun: (runId, patch) => {
      const run = runs.get(runId);
      if (!run) return null;
      run.metadata = { ...run.metadata, ...(patch?.metadata || {}) };
      return run;
    },
  });
  const wrote = await getTool(tools, 'maid.todo.write').execute({
    todos: [
      { content: '读取世界书', status: 'completed' },
      { content: '删除重复条目', status: 'in_progress' },
      { content: '读回验证' },
    ],
  }, { runId: 'run-1' });
  assert.equal(wrote.ok, true);
  assert.equal(wrote.count, 3);
  assert.equal(wrote.todos[2].status, 'pending', '缺省状态应归一为 pending');

  const read = await getTool(tools, 'maid.todo.read').execute({}, { runId: 'run-1' });
  assert.equal(read.ok, true);
  assert.deepEqual(read.todos.map(todo => todo.status), ['completed', 'in_progress', 'pending']);
  console.log('ok - maid todo 工具写入并读回当前 run 的任务清单');
}

{
  const tools = createMaidTodoTools({});
  const wrote = await getTool(tools, 'maid.todo.write').execute({ todos: [{ content: 'x' }] }, {});
  assert.equal(wrote.ok, false);
  assert.equal(wrote.reason, 'maid_run_unavailable');
  const read = await getTool(tools, 'maid.todo.read').execute({}, { runId: '' });
  assert.equal(read.ok, false);
  console.log('ok - maid todo 工具在没有 run 上下文时返回可读错误');
}

{
  const runs = new Map([['run-1', { id: 'run-1', metadata: {} }]]);
  const tools = createMaidTodoTools({
    getRun: runId => runs.get(runId) || null,
    updateRun: (runId, patch) => {
      const run = runs.get(runId);
      if (!run) return null;
      run.metadata = { ...run.metadata, ...(patch?.metadata || {}) };
      return run;
    },
  });
  const wrote = await getTool(tools, 'maid.todo.write').execute({
    todos: [
      { content: '', status: 'in_progress' },
      { content: '  有效项  ', status: 'weird_status' },
    ],
  }, { runId: 'run-1' });
  assert.equal(wrote.count, 1, '空 content 应被过滤');
  assert.equal(wrote.todos[0].content, '有效项');
  assert.equal(wrote.todos[0].status, 'pending', '非法状态应归一为 pending');
  console.log('ok - maid todo 工具过滤空项并归一非法状态');
}

console.log('maid-todo-tools-tests passed');

{
  const run = { id: 'resume', metadata: { resumedFromRunId: 'source', todos: [{ content: '原未完成项', status: 'pending' }] } };
  const tools = createMaidTodoTools({ getRun: id => id === run.id ? run : null,
    updateRun: (id, patch) => { if (id !== run.id) return null; Object.assign(run.metadata, patch.metadata); return run; } });
  const write = getTool(tools, 'maid.todo.write');
  assert.equal((await write.execute({ todos: [] }, { runId: run.id })).reason, 'continuation_todos_missing');
  assert.equal(run.metadata.todos.length, 1, 'failed write preserves the original obligations');
  assert.equal((await write.execute({ todos: [{ content: '原未完成项', status: 'cancelled' }] }, { runId: run.id })).ok, true);
  assert.equal((await getTool(tools, 'maid.todo.read').execute({}, { runId: run.id })).todos[0].status, 'cancelled');
  assert.equal((await write.execute({ todos: [] }, { runId: 'missing' })).ok, false);
  assert.equal((await getTool(tools, 'maid.todo.read').execute({}, { runId: 'missing' })).ok, false);
  console.log('ok - continuation todos cannot silently disappear; cancelled and missing-run states roundtrip honestly');
}
