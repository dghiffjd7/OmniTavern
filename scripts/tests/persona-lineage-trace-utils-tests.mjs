import assert from 'node:assert/strict';

import { buildPersonaLineageTrace } from '../../src/scripts/ui/chat/persona-lineage-trace-utils.js';

const contacts = [
  { id: 'alice', name: 'Alice', isGroup: false, members: [] },
  { id: 'bob', name: 'Bob', isGroup: false, members: [] },
  { id: 'group:g1', name: '茶会', isGroup: true, members: ['alice', 'ghost'] },
];
const contactById = new Map(contacts.map(contact => [contact.id, contact]));
const worldStates = {
  alice: { globalWorldIds: ['common'], roleWorldIds: ['alice-lore'], sessionWorldIds: [] },
  bob: { globalWorldIds: ['common'], roleWorldIds: [], sessionWorldIds: ['bob-room'] },
  'group:g1': { globalWorldIds: ['common'], roleWorldIds: [], sessionWorldIds: [] },
  'rp:card-1': { globalWorldIds: ['common'], roleWorldIds: [], sessionWorldIds: ['novel'] },
};

const build = (overrides = {}) => buildPersonaLineageTrace({
  at: 1760000000000,
  scopeId: 'card-1',
  persona: { id: 'card-1', name: '测试卡' },
  contacts,
  getContact: id => contactById.get(id) || null,
  profiles: [{ contactId: 'alice', trigger_keywords: ['猫', '茶'], sourceRefs: ['m1'], updatedAt: '2026-11-01' }],
  resolveWorldState: sessionId => worldStates[sessionId] || {},
  ...overrides,
});

const nodeOf = (graph, id) => graph.nodes.find(node => node.id === id);
const hasEdge = (graph, source, target, type) => graph.edges.some(edge => edge.source === source && edge.target === target && edge.type === type);

{
  // 原有部分（联系人、群成员、世界书、画像）保持不变
  const trace = build();
  const { graph } = trace;
  assert.equal(graph.mode, 'persona');
  assert.equal(graph.rootId, 'persona:card-1');
  assert.equal(nodeOf(graph, 'persona:card-1').label, '测试卡');
  assert.deepEqual(nodeOf(graph, 'persona:card-1').open, { kind: 'persona' });
  assert.ok(hasEdge(graph, 'persona:card-1', 'contact:alice', 'contains'));
  assert.ok(hasEdge(graph, 'persona:card-1', 'group:group:g1', 'contains'));
  assert.ok(hasEdge(graph, 'contact:alice', 'group:group:g1', 'member_of'));
  assert.equal(nodeOf(graph, 'contact:ghost').label, 'ghost');
  assert.ok(hasEdge(graph, 'contact:ghost', 'group:group:g1', 'member_of'));
  assert.equal(nodeOf(graph, 'worldbook:common').label, '全局世界书 common');
  assert.equal(nodeOf(graph, 'worldbook:alice-lore').label, '角色世界书 alice-lore');
  assert.equal(graph.edges.find(edge => edge.target === 'worldbook:bob-room').reason, 'manual_binding');
  assert.equal(nodeOf(graph, 'contact_profile:alice').summary, '猫, 茶');
  assert.deepEqual(nodeOf(graph, 'contact:alice').open, { kind: 'contact', id: 'alice' });
  assert.deepEqual(nodeOf(graph, 'group:group:g1').open, { kind: 'group', id: 'group:g1' });
  // 共用的世界书：分量 = 用到它的会话数
  assert.equal(nodeOf(graph, 'worldbook:common').meta.weight, 3);
  assert.equal(nodeOf(graph, 'worldbook:common').meta.stat, '3 个会话使用');
  assert.equal(trace.spans[0].attrs.contacts, 2);
  assert.equal(trace.spans[0].attrs.groups, 1);
  // 没给新资料来源时不多出节点
  assert.equal(graph.nodes.some(node => /^(preset|regex|memory|summary|variables|moment|creative):/.test(node.id)), false);
  console.log('ok - persona lineage keeps contacts, groups, worldbooks and profiles');
}

{
  // 创意写作会话 + 预设（共用计数）+ 正则规则集挂在预设／世界书下
  const { graph } = build({
    creative: { sessionId: 'rp:card-1', label: '测试卡' },
    resolvePreset: (sessionId, { mode }) => (mode === 'rp'
      ? { presetId: 'novel-preset', name: '小说预设', source: 'mode', enabled: true }
      : { presetId: 'chat-preset', name: '聊天预设', source: sessionId === 'bob' ? 'session' : 'mode', enabled: true }),
    regexSets: [
      { id: 'set-a', name: '去除思考', manualEnabled: true, bind: { type: 'preset', presetType: 'openai', presetIds: ['novel-preset'] }, rules: [{}, { disabled: true }, {}] },
      { id: 'set-b', name: '世界书清理', manualEnabled: false, bind: { type: 'world', worldId: 'novel' }, rules: [{}] },
      { id: 'set-c', name: '不相关', bind: { type: 'preset', presetId: 'other' }, rules: [{}] },
    ],
    globalRegexCount: 4,
    sessionRegexCount: sessionId => (sessionId === 'alice' ? 2 : 0),
  });
  const creative = nodeOf(graph, 'creative:rp:card-1');
  assert.equal(creative.type, 'creative_session');
  assert.equal(creative.label, '创意写作 · 测试卡');
  assert.deepEqual(creative.open, { kind: 'creative', id: 'rp:card-1' });
  assert.ok(hasEdge(graph, 'persona:card-1', 'creative:rp:card-1', 'contains'));
  assert.ok(hasEdge(graph, 'creative:rp:card-1', 'worldbook:novel', 'binds'));
  assert.equal(nodeOf(graph, 'worldbook:common').meta.weight, 4);

  const chatPreset = nodeOf(graph, 'preset:chat-preset');
  assert.equal(chatPreset.type, 'preset');
  assert.equal(chatPreset.label, '聊天预设');
  assert.equal(chatPreset.meta.weight, 3);
  assert.equal(chatPreset.meta.stat, '3 个会话使用');
  assert.deepEqual(chatPreset.open, { kind: 'preset', id: 'chat-preset' });
  assert.equal(graph.edges.find(edge => edge.source === 'contact:bob' && edge.target === 'preset:chat-preset').reason, 'manual_binding');
  assert.equal(graph.edges.find(edge => edge.source === 'contact:alice' && edge.target === 'preset:chat-preset').reason, 'default_enabled');
  assert.ok(hasEdge(graph, 'creative:rp:card-1', 'preset:novel-preset', 'binds'));

  assert.equal(nodeOf(graph, 'regex:set-a').meta.stat, '2 条规则');
  assert.ok(hasEdge(graph, 'preset:novel-preset', 'regex:set-a', 'binds'));
  assert.equal(nodeOf(graph, 'regex:set-b').status, 'disabled');
  assert.equal(nodeOf(graph, 'regex:set-b').meta.stat, '1 条规则 · 已关闭');
  assert.ok(hasEdge(graph, 'worldbook:novel', 'regex:set-b', 'binds'));
  assert.equal(nodeOf(graph, 'regex:set-c'), undefined);
  assert.ok(hasEdge(graph, 'persona:card-1', 'regex:global', 'contains'));
  assert.equal(nodeOf(graph, 'regex:global').meta.stat, '4 条规则');
  assert.ok(hasEdge(graph, 'contact:alice', 'regex:session:alice', 'contains'));
  assert.equal(nodeOf(graph, 'regex:session:bob'), undefined);
  console.log('ok - persona lineage adds creative session, shared presets and bound regex sets');
}

{
  // 记忆按聊天室聚合；别的模板的行不算；会话已不在的挂在角色卡下；全局／动态记忆单独一个节点
  const rows = [
    { template_id: 'tpl', table_id: 'events', contact_id: 'alice', group_id: '', is_active: true },
    { template_id: 'tpl', table_id: 'events', contact_id: 'alice', group_id: '', is_active: false },
    { template_id: 'tpl', table_id: 'people', contact_id: 'alice', group_id: '' },
    { template_id: 'tpl', table_id: 'events', contact_id: '', group_id: 'group:g1' },
    { template_id: 'tpl', table_id: 'outline', contact_id: 'rp:card-1', group_id: '' },
    { template_id: 'tpl', table_id: 'events', contact_id: 'gone', group_id: '' },
    { template_id: 'tpl', table_id: 'user', contact_id: '', group_id: '' },
    { template_id: 'old', table_id: 'events', contact_id: 'bob', group_id: '' },
  ];
  const { graph } = build({
    creative: { sessionId: 'rp:card-1', label: '测试卡' },
    memory: { templateId: 'tpl', rows, tableNames: { events: '重要事件', people: '人物' } },
    getSessionLabel: sessionId => (sessionId === 'gone' ? '已删除的人' : sessionId),
  });
  const alice = nodeOf(graph, 'memory:alice');
  assert.equal(alice.type, 'memory_table');
  assert.equal(alice.meta.weight, 3);
  assert.equal(alice.meta.stat, '3 行 · 2 张表 · 1 行停用');
  assert.equal(alice.summary, '重要事件 2, 人物 1');
  assert.deepEqual(alice.open, { kind: 'memory', room: { key: 'alice', kind: 'private', sessionId: 'alice' } });
  assert.ok(hasEdge(graph, 'contact:alice', 'memory:alice', 'contains'));
  assert.ok(hasEdge(graph, 'group:group:g1', 'memory:group:g1', 'contains'));
  assert.ok(hasEdge(graph, 'creative:rp:card-1', 'memory:rp:card-1', 'contains'));
  assert.equal(nodeOf(graph, 'memory:gone').label, '记忆 · 已删除的人');
  assert.ok(hasEdge(graph, 'persona:card-1', 'memory:gone', 'contains'));
  assert.equal(nodeOf(graph, 'memory:global').label, '全局／动态记忆');
  assert.deepEqual(nodeOf(graph, 'memory:global').open, { kind: 'memory', room: null });
  assert.ok(hasEdge(graph, 'persona:card-1', 'memory:global', 'contains'));
  assert.equal(nodeOf(graph, 'memory:bob'), undefined);
  console.log('ok - persona lineage aggregates memory rows per room for the current template');
}

{
  // 摘要、会话变量、共用全局变量、动态（按发布者）与动态摘要
  const { graph } = build({
    getSessionStats: sessionId => ({
      alice: { summaryCount: 5, compacted: true, variableCount: 12, sharedVariables: false },
      bob: { summaryCount: 0, compacted: false, variableCount: 3, sharedVariables: true },
      'group:g1': { summaryCount: 0, compacted: false, variableCount: 0, sharedVariables: true },
    }[sessionId] || {}),
    globalVariableCount: 40,
    moments: [
      { authorId: 'alice', author: 'Alice', comments: [{}, {}] },
      { authorId: 'alice', author: 'Alice', comments: [] },
      { authorId: 'stranger', author: '路人', comments: [] },
    ],
    momentSummary: { count: 2, compacted: false },
  });
  const summary = nodeOf(graph, 'summary:alice');
  assert.equal(summary.meta.stat, '5 条 · 已压缩');
  assert.equal(summary.meta.weight, 6);
  assert.deepEqual(summary.open, { kind: 'summary', id: 'alice' });
  assert.equal(nodeOf(graph, 'summary:bob'), undefined);
  assert.equal(nodeOf(graph, 'variables:alice').meta.stat, '12 个变量');
  const bobVariables = nodeOf(graph, 'variables:bob');
  assert.equal(bobVariables.status, 'disabled');
  assert.equal(bobVariables.meta.stat, '3 个变量 · 已改用全局变量');
  const globalVariables = nodeOf(graph, 'variables:global');
  assert.equal(globalVariables.meta.stat, '40 个变量 · 2 个会话共用');
  assert.equal(globalVariables.open, undefined, 'variable manager follows the current session, so global variables have no jump');
  assert.deepEqual(nodeOf(graph, 'variables:alice').open, { kind: 'variables', id: 'alice' });
  assert.ok(hasEdge(graph, 'contact:bob', 'variables:global', 'binds'));
  assert.ok(hasEdge(graph, 'group:group:g1', 'variables:global', 'binds'));
  assert.equal(nodeOf(graph, 'moment:alice').meta.stat, '2 条动态 · 2 条评论');
  assert.ok(hasEdge(graph, 'contact:alice', 'moment:alice', 'contains'));
  assert.ok(hasEdge(graph, 'persona:card-1', 'moment:stranger', 'contains'));
  assert.equal(nodeOf(graph, 'summary:moments').meta.stat, '2 条');
  assert.deepEqual(nodeOf(graph, 'summary:moments').open, { kind: 'moment_summary' });
  console.log('ok - persona lineage adds summaries, variables and moments with stats');
}
