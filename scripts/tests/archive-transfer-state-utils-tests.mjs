import assert from 'node:assert/strict';

import { createArchiveTransferStateRuntime, resolveArchivePointerVariableSnapshotId } from '../../src/scripts/ui/chat/archive-transfer-state-utils.js';

const createStores = () => {
  const pointers = new Map();
  const memory = new Map();
  const variables = new Map();
  let seq = 0;
  return {
    pointers,
    memory,
    variables,
    turnCheckpointStore: {
      getArchivePointer: async (sid, aid) => pointers.get(`${sid}/${aid}`) || null,
      setArchivePointer: async (sid, aid, pointer) => { pointers.set(`${sid}/${aid}`, pointer); return pointer; },
    },
    memorySnapshotStore: {
      getSnapshot: async id => memory.get(id) || null,
      persistSnapshot: async (sid, snapshot) => { const id = `mem-${++seq}`; memory.set(id, snapshot); return { id }; },
    },
    variableSnapshotStore: {
      getSnapshot: async id => variables.get(id) || null,
      persistSnapshot: async (sid, snapshot) => { const id = `var-${++seq}`; variables.set(id, snapshot); return { id }; },
    },
  };
};

{
  const stores = createStores();
  const refreshed = [];
  const runtime = createArchiveTransferStateRuntime({
    isEnabled: sid => sid.startsWith('rp:'),
    ...stores,
    buildMemorySnapshot: async ({ sessionId, templateId, rows }) => ({ templateId: templateId || 'default-tpl', scope: 'contact', rows: rows.map(row => ({ ...row, contact_id: sessionId })) }),
    listArchiveMessages: async () => [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'g', role: 'assistant', meta: { isGreeting: true } },
    ],
    refreshReachability: async sid => refreshed.push(sid),
    now: () => 77,
  });

  const result = await runtime.bindImportedArchiveState('rp:card', 'arc', {
    memoryTable: { templateId: 'tpl', rows: [{ table_id: 'people', row_data: { name: 'x' } }] },
    variables: { 好感: 3 },
  });
  assert.deepEqual(result, { memory: true, variables: true });
  const pointer = stores.pointers.get('rp:card/arc');
  assert.equal(pointer.tailAssistantMessageId, 'a1', '指向最后一条非开场白的 AI 消息');
  assert.equal(pointer.tailSwipeIndex, 0);
  assert.equal(pointer.source, 'conversation_import');
  assert.deepEqual(stores.memory.get(pointer.memorySnapshotId).rows, [{ table_id: 'people', row_data: { name: 'x' }, contact_id: 'rp:card' }]);
  assert.deepEqual(stores.variables.get(pointer.variableSnapshotId), { scope: 'session', variables: { 好感: 3 }, capturedAt: 77 });
  assert.deepEqual(refreshed, ['rp:card'], '写完刷新快照可达性，免得被回收');

  assert.deepEqual(await runtime.readArchiveTransferState('rp:card', 'arc'), {
    memoryTable: { templateId: 'tpl', rows: [{ table_id: 'people', row_data: { name: 'x' }, contact_id: 'rp:card' }] },
    variables: { 好感: 3 },
  }, '导出存档时读回它的存档指针所指的快照');

  await runtime.bindImportedArchiveState('rp:card', 'arc2', { memoryTable: null, variables: { v: 1 } });
  const second = stores.pointers.get('rp:card/arc2');
  assert.deepEqual(stores.memory.get(second.memorySnapshotId).rows, [], '不带表格时记忆快照为空表（加载时清空）');
  assert.equal(stores.memory.get(second.memorySnapshotId).templateId, 'default-tpl');

  await runtime.bindImportedArchiveState('rp:card', 'arc3', { memoryTable: { templateId: 'tpl', rows: [] }, variables: null });
  assert.equal(stores.pointers.get('rp:card/arc3').variableSnapshotId, '', '不带变量时不记变量快照（加载时变量不变）');

  assert.equal(await runtime.readArchiveTransferState('rp:card', 'missing'), null, '没有存档指针时为 null');
  assert.deepEqual(await runtime.bindImportedArchiveState('chat:off', 'arc', { variables: { v: 1 } }), { memory: false, variables: false }, '未启用回合检查点时不写入');
  assert.equal(stores.pointers.has('chat:off/arc'), false);
  assert.equal(await runtime.readArchiveTransferState('chat:off', 'arc'), null);
  console.log('ok - archive transfer state binds imported tables and variables to the archive pointer and reads them back');
}

{
  const persisted = [];
  const deps = {
    sessionId: 'rp:card',
    isActive: () => true,
    buildSnapshot: async sid => ({ scope: 'session', variables: { 当前: sid }, capturedAt: 1 }),
    persistSnapshot: async (sid, snapshot) => { persisted.push(snapshot); return { id: `var-${persisted.length}` }; },
  };
  assert.equal(await resolveArchivePointerVariableSnapshotId({ ...deps, branch: { variableSnapshotId: 'var-branch' }, meta: { variableSnapshotId: 'var-meta' } }), 'var-branch', '优先用尾部 AI 消息当前分支的变量快照');
  assert.equal(await resolveArchivePointerVariableSnapshotId({ ...deps, branch: {}, meta: { variableSnapshotId: 'var-meta' } }), 'var-meta');
  assert.equal(persisted.length, 0, '已有快照时不另存');
  assert.equal(await resolveArchivePointerVariableSnapshotId({ ...deps, branch: {}, meta: {} }), 'var-1', '尾部消息没有变量快照（如导入的存档）时记下此刻的变量');
  assert.deepEqual(persisted[0].variables, { 当前: 'rp:card' });
  assert.equal(await resolveArchivePointerVariableSnapshotId({ ...deps }), 'var-2', '没有尾部 AI 消息时也记下此刻的变量');
  assert.equal(await resolveArchivePointerVariableSnapshotId({ ...deps, isActive: () => false }), '', '会话没有变量活动时不记');
  assert.equal(persisted.length, 2);
  console.log('ok - archive pointer variable snapshot prefers the tail branch snapshot and falls back to current variables');
}
