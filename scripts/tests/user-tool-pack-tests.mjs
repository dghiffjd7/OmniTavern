import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { buildUserToolPack, parseUserToolPack, planUserToolImport, USER_TOOL_PACK_FORMAT } = await import('../../src/scripts/ui/tools/user-tool-pack.js');

const tools = [
  { id: 'tool_a', name: '删掉', icon: 'trash', direct: true, action: { source: 'builtin', id: 'reply.delete', params: {} } },
  { id: 'tool_b', name: '润色', icon: 'pen', action: { source: 'agent', id: 'text-edit:polish', params: {} } },
  { id: 'tool_c', name: '大声', icon: 'code', action: { source: 'plugin', id: 'shout:go', params: {} } },
  { id: 'tool_d', name: '脚本', icon: 'code', action: { source: 'script', id: 'inline', params: {} }, script: { code: 'return 1', capabilities: ['read', 'model'], approved: ['read', 'model'] } },
];
const bindings = [
  { id: 'bind_1', toolId: 'tool_a', kind: 'shortcut', shortcut: { code: 'KeyD', alt: true, ctrl: false, meta: false, shift: false, label: 'Alt + D' } },
  { id: 'bind_2', toolId: 'tool_a', kind: 'gesture', gesture: { position: 'assistant_bubble', gesture: 'double' } },
];
const describeAction = (source, id) => ({ 'text-edit:polish': { title: '正文润色' }, 'shout:go': { title: '大声说', pluginName: '大声插件' } }[id] || null);

{
  // 导出：依赖只记名称；脚本不带「已确认」；可选不含绑定
  const pack = buildUserToolPack({ tools, bindings, describeAction, now: () => Date.UTC(2026, 9, 30) });
  assert.equal(pack.format, USER_TOOL_PACK_FORMAT);
  assert.equal(pack.exportedAt, '2026-10-30T00:00:00.000Z');
  assert.deepEqual(pack.requires, { agents: [{ id: 'text-edit:polish', title: '正文润色' }], plugins: [{ id: 'shout:go', title: '大声说', pluginName: '大声插件' }] });
  assert.deepEqual(pack.tools[0].gestures, [{ position: 'assistant_bubble', gesture: 'double' }]);
  assert.equal(pack.tools[0].shortcut.label, 'Alt + D');
  assert.deepEqual(pack.tools[3].script, { code: 'return 1', capabilities: ['read', 'model'] }, 'approval is not exported');
  assert.equal(JSON.stringify(pack).includes('tool_a'), false, 'local ids are not exported');
  const bare = buildUserToolPack({ tools, bindings, includeBindings: false, describeAction });
  assert.equal('shortcut' in bare.tools[0] || 'gestures' in bare.tools[0], false);
  console.log('ok - packs carry tools, optional bindings and named dependencies only');
}

{
  // 解析：格式、版本、坏资料
  assert.equal(parseUserToolPack('nope').error, '不是有效的 JSON 文件');
  assert.equal(parseUserToolPack('{"format":"other"}').error, '这不是工具包文件');
  assert.equal(parseUserToolPack(JSON.stringify({ format: USER_TOOL_PACK_FORMAT, version: 9, tools: [] })).error, '工具包来自较新的版本，请先更新 APP');
  assert.equal(parseUserToolPack(JSON.stringify({ format: USER_TOOL_PACK_FORMAT, version: 1, tools: [{ name: '' }] })).error, '工具包里没有可导入的工具');
  const pack = buildUserToolPack({ tools, bindings, describeAction });
  pack.tools.push({ name: 'bad gesture', action: { source: 'builtin', id: 'reply.stop' }, gestures: [{ position: 'assistant_bubble', gesture: 'long' }], shortcut: { code: 'KeyQ' } });
  const parsed = parseUserToolPack(JSON.stringify(pack));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pack.tools.length, 5);
  assert.deepEqual(['gestures' in parsed.pack.tools[4], 'shortcut' in parsed.pack.tools[4]], [false, false], 'invalid bindings are dropped');
  console.log('ok - pack files are validated and normalized');
}

{
  // 导入计划：可直接用／要选 Agent／缺插件／脚本要确认；冲突的绑定不绑；同名加编号
  const parsed = parseUserToolPack(JSON.stringify(buildUserToolPack({ tools: [...tools, { ...tools[0], id: 'tool_e' }], bindings: [...bindings, { id: 'bind_3', toolId: 'tool_e', kind: 'shortcut', shortcut: bindings[0].shortcut }], describeAction })));
  const plan = planUserToolImport({
    pack: parsed.pack,
    resolveAction: (source, id) => (source === 'builtin' || (source === 'script' && id === 'inline') ? { id } : null),
    listAgentActions: () => [{ id: 'text-edit:other', title: '别的润色' }],
    findShortcut: () => null,
    findGesture: (position, gesture) => (position === 'assistant_bubble' && gesture === 'double' ? { toolName: '现有工具' } : null),
    existingNames: ['删掉'],
  });
  assert.deepEqual(plan.items.map(item => item.status), ['ready', 'needs_agent', 'missing_plugin', 'needs_approval', 'ready']);
  assert.deepEqual(plan.items.map(item => item.tool.name), ['删掉 (2)', '润色', '大声', '脚本', '删掉 (3)']);
  assert.deepEqual(plan.items[1].agentOptions, [{ id: 'text-edit:other', title: '别的润色' }]);
  assert.deepEqual(plan.items[0].bindings.map(binding => binding.conflict), ['', '现有工具']);
  assert.equal(plan.items[4].bindings[0].conflict, '删掉 (2)', 'two tools in the pack cannot share a shortcut');
  const unknown = planUserToolImport({ pack: { tools: [{ key: 'x', name: 'x', action: { source: 'builtin', id: 'nope', params: {} } }] } });
  assert.deepEqual([unknown.items[0].status, unknown.items[0].include], ['unknown_action', false]);
  console.log('ok - import plans map agents, flag plugins and scripts, and skip taken bindings');
}

console.log('user-tool-pack-tests passed');
