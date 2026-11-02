import assert from 'node:assert/strict';

const { summarizeCardMemory, summarizeSessionMemory, summarizePendingMemoryPreviews, memoryRoomOf } = await import('../../src/scripts/memory/memory-overview-model.js');
const { auditMemoryData, createMemoryAuditAgent } = await import('../../src/scripts/agent/memory-audit-agent.js');

const row = (id, fields = {}, extra = {}) => ({ id, template_id: 'default-v1', table_id: 'events', contact_id: null, group_id: null, row_data: fields, is_active: true, created_at: 1000, updated_at: 1000, ...extra });
const NOW = 10 * 24 * 60 * 60 * 1000;

{
  // 聊天室归属：私聊／创意写作按 contact_id，群聊按 group_id，都没有的是全局／动态
  assert.deepEqual(memoryRoomOf(row('a', {}, { contact_id: 'c1' })), { key: 'c1', kind: 'private', sessionId: 'c1' });
  assert.equal(memoryRoomOf(row('a', {}, { contact_id: 'rp:x' })).kind, 'rp');
  assert.equal(memoryRoomOf(row('a', {}, { group_id: 'group:g' })).kind, 'group');
  assert.equal(memoryRoomOf(row('a')).kind, 'global');

  const card = summarizeCardMemory({ templateId: 'default-v1', rows: [
    row('1', { a: 'x' }, { contact_id: 'c1', updated_at: 5000 }),
    row('2', { a: 'y' }, { contact_id: 'c1', table_id: 'state', updated_at: 7000, is_active: false }),
    row('3', { a: 'z' }, { contact_id: 'rp:s', updated_at: 9000 }),
    row('4', { a: 'g' }),
    row('5', { a: 'old' }, { template_id: 'old-v0', contact_id: 'c1' }),
  ] });
  assert.equal(card.totalRows, 4, 'rows of other templates are not counted as live memory');
  assert.deepEqual(card.rooms.map(room => [room.key, room.rowCount, room.tableCount, room.lastUpdatedAt]), [
    ['rp:s', 1, 1, 9000], ['c1', 2, 2, 7000], ['', 1, 1, 1000],
  ], 'newest rooms first, global last');
  assert.equal(card.rooms[1].inactiveCount, 1);
  assert.deepEqual(card.otherTemplates, [{ templateId: 'old-v0', rowCount: 1 }]);
  console.log('ok - the card summary groups live rows by room and lists other templates separately');
}

{
  // 当前会话：只用最近一次真实发送的计划，分清楚没发过、发在别的会话、没开表格模式
  const plan = {
    enabled: true, targetId: 'c1', tokenTotal: 1234,
    items: [{}, {}, {}], recallItems: [{}], truncated: [{}, {}],
    audit: { segments: [
      { id: 'memory_state', label: '常驻状态', rowCount: 3 },
      { id: 'memory_bridge_writing_to_chat', label: '创意写作记忆', rowCount: 5, trimmedCount: 1 },
      { id: 'memory_keyword_recall', label: '关键词召回', rowCount: 0 },
    ] },
  };
  const pending = [
    { toolName: 'memory.preview_actions', status: 'pending', sessionId: 'c1', createdAt: 2000 },
    { toolName: 'memory.preview_actions', status: 'pending', sessionId: 'c1', createdAt: 1500 },
    { toolName: 'memory.preview_actions', status: 'pending', sessionId: 'c2', createdAt: 100 },
    { toolName: 'variable.preview_commands', status: 'pending', sessionId: 'c1', createdAt: 50 },
  ];
  const summary = summarizeSessionMemory({ sessionId: 'c1', plan, storageMode: 'table', autoWrite: { enabled: true, mode: 'inline' }, pending });
  assert.deepEqual(summary.injection, {
    state: 'ok', localRows: 4, sharedRows: 5, trimmedRows: 3, tokens: 1234,
    shared: [{ id: 'memory_bridge_writing_to_chat', label: '创意写作记忆', rowCount: 5, trimmedCount: 1 }],
  });
  assert.deepEqual(summary.pending, { count: 2, oldestAt: 1500 });
  assert.deepEqual(summary.autoWrite, { enabled: true, mode: 'inline' });
  assert.equal(summarizeSessionMemory({ sessionId: 'c2', plan }).injection.state, 'other_session');
  assert.equal(summarizeSessionMemory({ sessionId: 'c1' }).injection.state, 'no_send');
  assert.equal(summarizeSessionMemory({ sessionId: 'c1', plan, storageMode: 'summary' }).injection.state, 'off');
  assert.equal(summarizeSessionMemory({ sessionId: 'c1', plan: { enabled: false, targetId: 'c1', reason: 'missing_template' } }).injection.reason, 'missing_template');
  assert.deepEqual(summarizePendingMemoryPreviews(pending), { count: 3, oldestAt: 100 }, 'without a session it counts every room');
  console.log('ok - the session summary uses only the last real send and counts pending memory previews');
}

{
  // 记忆管家：规则只读检查
  const template = { schema: { tables: [
    { id: 'events', name: '事件' }, { id: 'state', name: '状态', maxRows: 2 }, { id: 'chat_summary', name: '聊天摘要' }, { id: 'never', name: '从没用过' },
  ] } };
  const long = '很长的摘要'.repeat(200);
  const rows = [
    row('1', { what: '一起去看海', when: '周六' }, { contact_id: 'c1' }),
    row('2', { when: '周六', what: '一起去看海 ' }, { contact_id: 'c1' }),
    row('3', { what: '我们周六一起去海边看日落，然后吃了烤鱼', when: '周六' }, { contact_id: 'c1' }),
    row('3b', { what: '我们周六一起去海边看日落，然后吃了烤鱼呢', when: '周六' }, { contact_id: 'c1' }),
    row('4', { what: '一起去看海', when: '周六' }, { contact_id: 'c2' }),
    row('5', { what: '', when: ' ' }, { contact_id: 'c1' }),
    row('6', { a: '1' }, { contact_id: 'c1', table_id: 'state' }),
    row('7', { a: '2' }, { contact_id: 'c1', table_id: 'state' }),
    row('8', { a: '3' }, { contact_id: 'c1', table_id: 'state' }),
    row('9', { text: long }, { contact_id: 'c1', table_id: 'chat_summary' }),
    row('10', { a: 'old' }, { template_id: 'old-v0' }),
  ];
  const session = { storageMode: 'table', autoWrite: { enabled: false }, injection: { state: 'ok', trimmedRows: 2, sharedRows: 25, shared: [{ label: '创意写作记忆' }] } };
  const report = auditMemoryData({ rows, templateId: 'default-v1', template, session });
  const byType = type => report.findings.filter(item => item.type === type);
  assert.deepEqual(byType('old_template_rows').map(item => item.params), [{ templateId: 'old-v0', count: 1 }]);
  assert.deepEqual(byType('duplicate_rows').map(item => [item.room.key, item.params.count]), [['c1', 1]], 'duplicates are per room and table; whitespace and column order do not matter');
  assert.deepEqual(byType('similar_rows').map(item => [item.room.key, item.params.count]), [['c1', 1]]);
  assert.deepEqual(byType('empty_rows').map(item => item.params.count), [1]);
  assert.deepEqual(byType('over_max_rows').map(item => [item.params.tableName, item.params.count, item.params.maxRows]), [['状态', 3, 2]]);
  assert.deepEqual(byType('long_summaries').map(item => item.params.count), [1]);
  assert.deepEqual(byType('unused_tables').map(item => item.params.names), [['从没用过']]);
  assert.deepEqual(byType('injection_trimmed').map(item => item.params.count), [2]);
  assert.deepEqual(byType('shared_heavy').map(item => item.params.count), [25]);
  assert.equal(byType('auto_write_off').length, 1);
  assert.equal(report.counts.warnings, report.findings.filter(item => item.severity === 'warning').length);

  // 只写创意写作的卡：私聊、群聊、动态的表不算「没写过」
  const rpOnly = auditMemoryData({ templateId: 'default-v1', rows: [row('1', { a: 'x' }, { contact_id: 'rp:s', table_id: 'rp_summary' })], template: { schema: { tables: [
    { id: 'user_profile', name: '用户档案', scope: 'global', usage: 'all' }, { id: 'chat_summary', name: '私聊摘要', scope: 'contact', usage: 'chat' },
    { id: 'group_outline', name: '群聊总体大纲', scope: 'group', usage: 'chat' }, { id: 'moment_summary', name: '动态摘要', scope: 'global', usage: 'moments' },
    { id: 'rp_summary', name: '摘要', scope: 'contact', usage: 'rp' }, { id: 'rp_tasks', name: '任务', scope: 'contact', usage: 'rp' },
  ] } } });
  assert.deepEqual(rpOnly.findings.filter(item => item.type === 'unused_tables').map(item => item.params.names), [['用户档案', '任务']]);

  const clean = auditMemoryData({ rows: [row('1', { a: 'x' })], templateId: 'default-v1', template: { schema: { tables: [{ id: 'events' }] } }, session: { storageMode: 'table', autoWrite: { enabled: true }, injection: { state: 'no_send' } }, now: NOW });
  assert.deepEqual(clean.findings, [], 'healthy memory reports nothing');
  console.log('ok - the memory steward flags old-template, duplicate, similar, empty, oversized and heavily shared items read-only');
}

{
  // 排进 Agent 运行：读取 → 检查两步，结果带回报告
  const steps = [];
  const runtime = {
    enqueue: async (run, task) => task({
      runId: 'run-1',
      startStep: (step) => { steps.push({ ...step, status: 'running' }); return { id: steps.length - 1 }; },
      finishStep: (id, patch) => Object.assign(steps[id], patch),
    }).then(result => ({ run, result })),
  };
  const agent = createMemoryAuditAgent({ agentTaskRuntime: runtime, now: () => NOW, collect: async ({ sessionId }) => ({ rows: [row('1', { a: '' })], templateId: 'default-v1', template: { tables: [] }, session: { sessionId } }) });
  const { run, result } = await agent.auditMemory({ sessionId: 'c1' });
  assert.deepEqual([run.kind, run.title, run.sessionId], ['memory_audit', '记忆检查', 'c1']);
  assert.deepEqual(steps.map(step => [step.type, step.status]), [['memory_audit.load', 'succeeded'], ['memory_audit.analyze', 'succeeded']]);
  assert.equal(result.report.findings[0].type, 'empty_rows');
  assert.equal(result.checkedAt, NOW);

  const failing = createMemoryAuditAgent({ agentTaskRuntime: runtime, collect: async () => { throw new Error('读不到'); } });
  await assert.rejects(failing.auditMemory({}), /读不到/);
  assert.equal(steps.at(-1).status, 'failed');
  console.log('ok - the memory check runs as an agent run with load and analyze steps');
}

console.log('memory-overview-tests passed');
