import assert from 'node:assert/strict';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ||= { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };

const { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } = await import('../../src/scripts/agent/agent-permissions.js');
const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { createVariableEditAgentTools } = await import('../../src/scripts/agent/tools/variable-edit-tools.js');
const { createMemoryTableEditAgentTools } = await import('../../src/scripts/agent/tools/memory-table-edit-tools.js');
const { createMemorySettingsAgentTools } = await import('../../src/scripts/agent/tools/memory-settings-tools.js');
const { createVariablePreviewCommandsRuntime, createVariablePreviewCommitRuntime } = await import('../../src/scripts/ui/agent-write-preview-runtime-utils.js');
const { searchMaidCapabilityConcepts } = await import('../../src/scripts/agent/maid-capability-concept-retriever.js');
const { listAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');

const makeRegistry = (tools) => {
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const requests = [];
  const run = (name, args, { allow = true, onConfirm = null } = {}) => registry.executeTool(name, args, {
    sessionId: 'contact_1',
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: async (request) => {
      requests.push(request);
      return onConfirm ? onConfirm(request) : { decision: allow ? 'allow' : 'deny' };
    },
  });
  return { run, requests };
};

// 变量：真实的指令预览与提交处理器，chatStore 放内存
const setupVariables = ({ shared = false, enabled = true } = {}) => {
  const store = {
    sessions: { contact_1: { 金币: 10, 任务: { 进度: 1, 名称: '送信' }, 临时: 'x' } },
    global: { 天气: '晴' },
    listVariables(sid) { return structuredClone(this.sessions[sid] || {}); },
    listGlobalVariables() { return structuredClone(this.global); },
    setVariable(key, value, sid) { (this.sessions[sid] ||= {})[key] = structuredClone(value); return true; },
    deleteVariable(key, sid) { if (!(key in (this.sessions[sid] || {}))) return false; delete this.sessions[sid][key]; return true; },
    setGlobalVariable(key, value) { this.global[key] = structuredClone(value); return true; },
    deleteGlobalVariable(key) { if (!(key in this.global)) return false; delete this.global[key]; return true; },
  };
  const tools = createVariableEditAgentTools({
    getCurrentSessionId: () => 'contact_1',
    resolveUseGlobal: () => shared,
    isVariableRuntimeEnabled: () => enabled,
    previewVariableCommands: createVariablePreviewCommandsRuntime({ chatStore: store }),
    commitVariables: createVariablePreviewCommitRuntime({ chatStore: store }).commit,
    listVariables: ({ sessionId, useGlobal }) => (useGlobal ? store.listGlobalVariables() : store.listVariables(sessionId)),
  });
  return { store, ...makeRegistry(tools) };
};

// 记忆表格：动作上下文、预览与提交用替身（真实预览／提交另有测试），专测工具自己的解析、确认、复验与读回
const setupMemory = () => {
  const rows = [
    { id: 'r1', table_id: 'profile', contact_id: 'contact_1', row_data: { nickname: '阿青', notes: '喜欢下棋' } },
    { id: 'r2', table_id: 'events', contact_id: 'contact_1', row_data: { event: '第一次见面' } },
  ];
  const tables = [
    { id: 'profile', name: '角色档案', columns: [{ id: 'nickname', name: '称呼', type: 'text' }, { id: 'notes', name: '其他信息', type: 'multiline' }] },
    { id: 'events', name: '重要事件', columns: [{ id: 'event', name: '事件', type: 'text' }] },
  ];
  const context = () => ({
    tableOrder: tables.map(table => table.id),
    tableById: new Map(tables.map(table => [table.id, table])),
    allRows: structuredClone(rows),
    rowsById: new Map(rows.map(row => [row.id, structuredClone(row)])),
  });
  const commits = [];
  const tools = createMemoryTableEditAgentTools({
    getCurrentSessionId: () => 'contact_1',
    getUiMode: () => 'chat',
    loadMemoryContext: async () => context(),
    previewMemoryActions: async ({ actions }) => ({ entries: actions.map((action, index) => {
      const row = rows.find(item => item.id === action.rowId);
      if (action.action === 'delete') return { index, kind: 'delete', rowId: action.rowId, diff: { before: row.row_data, after: null } };
      if (action.action === 'update') {
        const after = { ...row.row_data, ...action.data };
        if (JSON.stringify(after) === JSON.stringify(row.row_data)) return { index, kind: 'skip', skipped: true, reason: 'unchanged' };
        return { index, kind: 'update', rowId: action.rowId, diff: { before: row.row_data, after } };
      }
      return { index, kind: 'insert', diff: { before: null, after: action.data } };
    }) }),
    commitMemory: async ({ args }) => {
      commits.push(args);
      for (const action of args.actions) {
        if (action.action === 'delete') rows.splice(rows.findIndex(row => row.id === action.rowId), 1);
        else if (action.action === 'update') Object.assign(rows.find(row => row.id === action.rowId).row_data, action.data);
        else rows.push({ id: `r${rows.length + 10}`, table_id: action.tableId, contact_id: 'contact_1', row_data: { ...action.data } });
      }
      return { status: 'committed' };
    },
  });
  return { rows, commits, ...makeRegistry(tools) };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('variable.set changes several paths with one confirmation and reads them back', async () => {
  const { run, requests, store } = setupVariables();
  const result = await run('variable.set', { values: [{ path: '金币', value: 25 }, { path: '任务.进度', value: 2 }, { path: '地点', value: '集市' }] });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  const request = requests.at(-1);
  assert.equal(request.kind, 'variable.set');
  assert.equal(request.danger, false);
  assert.match(request.message, /当前会话变量的 3 项/);
  assert.ok(request.details.items.some(item => item.label === '金币' && /10 ⇒ 25/.test(item.meta)));
  assert.ok(request.details.items.some(item => item.label === '地点' && /^新增：/.test(item.meta)), 'a new variable shows as added, not undefined ⇒ value');
  assert.equal(store.sessions.contact_1.金币, 25);
  assert.deepEqual(store.sessions.contact_1.任务, { 进度: 2, 名称: '送信' }, 'nested fields keep their siblings');
  assert.equal(store.sessions.contact_1.地点, '集市');
});

test('variable.delete uses a dangerous confirmation and removes only what exists', async () => {
  const { run, requests, store } = setupVariables();
  const result = await run('variable.delete', { paths: ['临时', '任务.名称'] });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.equal(requests.at(-1).danger, true);
  assert.match(requests.at(-1).message, /将删除当前会话变量的 2 项/);
  assert.match(requests.at(-1).message, /只能手动重设/);
  assert.equal('临时' in store.sessions.contact_1, false);
  assert.deepEqual(store.sessions.contact_1.任务, { 进度: 1 });
  const nothing = await run('variable.delete', { paths: ['不存在的变量'] });
  assert.equal(nothing.result.skipped, true);
  assert.equal(nothing.result.ok, true, 'deleting something that is not there is already done');
  assert.equal(nothing.result.notApplied.length, 1);
});

test('variables changed during the confirmation are not overwritten; cancelling writes nothing', async () => {
  const { run, store } = setupVariables();
  const result = await run('variable.set', { values: [{ path: '金币', value: 25 }] }, {
    onConfirm: async () => { store.sessions.contact_1.金币 = 99; return { decision: 'allow' }; },
  });
  assert.equal(result.result.reason, 'target_changed_during_confirmation');
  assert.equal(store.sessions.contact_1.金币, 99);
  const cancelled = await run('variable.set', { values: [{ path: '金币', value: 1 }] }, { allow: false });
  assert.equal(cancelled.result.ok, false);
  assert.equal(store.sessions.contact_1.金币, 99);
});

test('shared conversations write the shared variables; disabled variables and bad paths are refused', async () => {
  const shared = setupVariables({ shared: true });
  const result = await shared.run('variable.set', { values: [{ path: '天气', value: '雨' }] });
  assert.equal(result.result.useGlobal, true);
  assert.equal(shared.store.global.天气, '雨');
  assert.equal(shared.store.sessions.contact_1.天气, undefined);
  const off = setupVariables({ enabled: false });
  assert.equal((await off.run('variable.set', { values: [{ path: '金币', value: 1 }] })).result.reason, 'variable_runtime_disabled');
  const bad = setupVariables();
  const invalid = await bad.run('variable.set', { values: [{ path: '.', value: 1 }] });
  assert.deepEqual(invalid.result.invalid.map(item => item.reason), ['invalid_path']);
  assert.equal(bad.requests.length, 0);
});

test('memory.rows.read lists tables with columns and rows', async () => {
  const { run } = setupMemory();
  const read = await run('memory.rows.read', {});
  assert.equal(read.result.ok, true);
  assert.deepEqual(read.result.tables.map(table => table.name), ['角色档案', '重要事件']);
  assert.deepEqual(read.result.tables[0].columns.map(column => column.name), ['称呼', '其他信息']);
  assert.equal(read.result.tables[0].rows[0].rowId, 'r1');
  const one = await run('memory.rows.read', { table: '重要事件' });
  assert.equal(one.result.tables.length, 1);
});

test('memory.rows.upsert changes a row by column name and adds a row in one confirmation', async () => {
  const { run, requests, rows, commits } = setupMemory();
  const result = await run('memory.rows.upsert', { rows: [
    { table: '角色档案', rowId: 'r1', values: [{ column: '称呼', value: '小青' }] },
    { table: 'events', values: [{ column: '事件', value: '一起去集市' }] },
  ] });
  assert.equal(result.result.succeededCount, 2, JSON.stringify(result.result));
  const request = requests.at(-1);
  assert.equal(request.kind, 'memory.rows.upsert');
  assert.equal(request.details.items[0].meta, '称呼：阿青 ⇒ 小青');
  assert.match(request.details.items[1].meta, /新增：事件=一起去集市/);
  assert.equal(rows.find(row => row.id === 'r1').row_data.nickname, '小青');
  assert.equal(rows.find(row => row.row_data.event === '一起去集市')?.table_id, 'events');
  assert.equal(commits[0].updateMode, 'full');
});

test('unknown tables, columns or rows fail before the confirmation; unchanged rows are skipped', async () => {
  const { run, requests } = setupMemory();
  const result = await run('memory.rows.upsert', { rows: [
    { table: '不存在', values: [{ column: '称呼', value: 'x' }] },
    { table: '角色档案', rowId: 'r1', values: [{ column: '年龄', value: 'x' }] },
    { table: '角色档案', rowId: 'r2', values: [{ column: '称呼', value: 'x' }] },
    { table: '角色档案', rowId: 'r1', values: [{ column: '称呼', value: '阿青' }] },
  ] });
  assert.deepEqual(result.result.results.map(item => item.reason), ['table_not_found', 'unknown_column', 'row_not_found', 'unchanged']);
  assert.equal(requests.length, 0);
});

test('memory.rows.delete is dangerous; rows changed during the confirmation are not touched', async () => {
  const { run, requests, rows } = setupMemory();
  const changed = await run('memory.rows.delete', { rows: [{ table: '角色档案', rowId: 'r1' }] }, {
    onConfirm: async () => { rows[0].row_data.notes = '别处改了'; return { decision: 'allow' }; },
  });
  assert.equal(changed.result.reason, 'target_changed_during_confirmation');
  assert.equal(rows.some(row => row.id === 'r1'), true);
  const deleted = await run('memory.rows.delete', { rows: [{ table: '角色档案', rowId: 'r1' }] });
  assert.equal(deleted.result.succeededCount, 1);
  assert.equal(requests.at(-1).danger, true);
  assert.equal(rows.some(row => row.id === 'r1'), false);
});

test('memory settings show before ⇒ after, note the depth rule and reject unknown values', async () => {
  const settings = { memoryInjectPosition: 'before_latest_user', memoryInjectDepth: 0, memoryTableEnabledChat: true, memoryBudgetMode: 'token' };
  const { run, requests } = makeRegistry(createMemorySettingsAgentTools({ getSettings: () => ({ ...settings }), updateSettings: patch => Object.assign(settings, patch) }));
  const read = await run('memory.settings.read', {});
  assert.equal(read.result.settings.memoryInjectPosition.value, 'before_latest_user');
  const depth = await run('memory.settings.update', { settings: { memoryInjectDepth: 3, memoryTableEnabledChat: false } });
  assert.equal(depth.result.ok, true, JSON.stringify(depth.result));
  assert.match(requests.at(-1).message, /历史深度/, 'depth only applies with the history-depth position');
  assert.ok(requests.at(-1).details.items.some(item => item.meta === '开启 ⇒ 关闭'));
  assert.equal(settings.memoryTableEnabledChat, false);
  const same = await run('memory.settings.update', { settings: { memoryInjectDepth: 3 } });
  assert.equal(same.result.skipped, true);
  await assert.rejects(run('memory.settings.update', { settings: { memoryInjectPosition: 'somewhere' } }), /must be one of/);
  await assert.rejects(run('memory.settings.update', { settings: { apiKey: 'x' } }), /not allowed|additional/i);
});

test('with the app\'s ask-by-default permissions the new tools reach their own confirmation', async () => {
  // app 的权限评估器默认「询问」：工具若声明权限会在确认窗出现前被挡下（实测时变量工具就这样失败）
  const { createMemorySettingsAgentTools: settingsTools } = await import('../../src/scripts/agent/tools/memory-settings-tools.js');
  const all = [
    ...createVariableEditAgentTools({}), ...createMemoryTableEditAgentTools({}), ...settingsTools({}),
    ...(await import('../../src/scripts/agent/tools/flow-board-tools.js')).createFlowBoardAgentTools({}),
    ...(await import('../../src/scripts/agent/tools/preset-edit-tools.js')).createPresetEditAgentTools({}),
    ...(await import('../../src/scripts/agent/tools/agent-config-tools.js')).createAgentConfigAgentTools({}),
  ];
  const evaluator = createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.ask });
  for (const tool of all) {
    const result = evaluator.evaluateTool(tool);
    assert.notEqual(result?.decision, AGENT_PERMISSION_DECISIONS.ask, `${tool.name} would be stopped before its confirmation`);
  }
  const { run, store } = (() => {
    const shared = setupVariables();
    return shared;
  })();
  const askRegistry = createAgentToolRegistry({ permissionEvaluator: evaluator, logger: { warn: () => {} } });
  askRegistry.registerMany(createVariableEditAgentTools({
    getCurrentSessionId: () => 'contact_1',
    previewVariableCommands: createVariablePreviewCommandsRuntime({ chatStore: store }),
    commitVariables: createVariablePreviewCommitRuntime({ chatStore: store }).commit,
    listVariables: ({ sessionId }) => store.listVariables(sessionId),
  }));
  const result = await askRegistry.executeTool('variable.set', { values: [{ path: '金币', value: 5 }] }, {
    sessionId: 'contact_1', operationIntentPolicy: { mode: 'write_allowed' }, requestToolConfirmation: async () => ({ decision: 'allow' }),
  });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.equal(store.sessions.contact_1.金币, 5);
  void run;
});

test('the maid finds the variable and memory tools', async () => {
  const features = listAppFeatures();
  const top = query => searchMaidCapabilityConcepts(query, { features, limit: 4 }).map(item => item.id);
  assert.ok(top('把变量金币改成50').includes('variable.set'));
  assert.ok(top('删除这个临时变量').includes('variable.delete'));
  assert.ok(top('记忆表格里有哪些内容').includes('memory.rows.read'));
  assert.ok(top('把记忆表格里阿青的称呼改成小青').includes('memory.rows.upsert'));
  assert.ok(top('删掉记忆表格这一行').includes('memory.rows.delete'));
  assert.ok(top('记忆注入位置改成历史深度').includes('memory.settings.update'));
  assert.ok(top('关闭聊天的记忆表格').includes('memory.settings.update'));
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}
if (failed) process.exit(1);
