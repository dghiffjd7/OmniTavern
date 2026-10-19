import assert from 'node:assert/strict';

import { AGENT_PERMISSION_DECISIONS, createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createPresetRegexScriptAgentTools } from '../../src/scripts/agent/tools/preset-regex-script-tools.js';
import { createPresetGroupStore } from '../../src/scripts/storage/preset-group-store.js';
import { searchMaidCapabilityConcepts } from '../../src/scripts/agent/maid-capability-concept-retriever.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

// 女仆帮忙分类预设：先列出分法，用户确认后才移动（设计页「管理分类」）。
const presets = {
  p1: { name: 'Izumi 1002' }, p2: { name: 'Izumi_0923' }, p3: { name: 'Kemini v3' },
  d1: { name: '同名' }, d2: { name: '同名' },
};
const presetStore = {
  ready: Promise.resolve(),
  listSummaries: type => (type === 'openai' ? Object.entries(presets).map(([id, data]) => ({ id, name: data.name })) : []),
  getPreset: (type, id) => (type === 'openai' && presets[id] ? { id, ...presets[id] } : null),
  getEnabled: () => true,
  getActiveId: () => 'p1',
  getResolvedActiveId: () => ({ presetId: 'p1', source: 'global' }),
};

const setup = async () => {
  let n = 0;
  const groupStore = createPresetGroupStore({ storage: null, loadKv: null, saveKv: async () => {}, createId: () => `g${++n}`, logger: null });
  await groupStore.ready;
  const events = [];
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: AGENT_PERMISSION_DECISIONS.allow }),
    logger: { warn: () => {} },
  });
  registry.registerMany(createPresetRegexScriptAgentTools({ presetStore, presetGroupStore: groupStore, getCurrentSessionId: () => 's1', onPresetGroupsChanged: () => events.push('groups-changed') }));
  const requests = [];
  const run = (name, args, { allow = true } = {}) => registry.executeTool(name, args, {
    sessionId: 's1', operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => { requests.push(request); return { decision: allow ? 'allow' : 'deny' }; },
  });
  return { groupStore, run, requests, events };
};

{
  const env = await setup();
  await env.groupStore.createGroup('旧分类');
  await env.groupStore.movePreset('p3', 'g1');
  const listed = (await env.run('preset.groups.list', {})).result;
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.groups, [{ name: '旧分类', presets: [{ id: 'p3', name: 'Kemini v3' }] }]);
  // 名称排序依赖系统语言（Windows 与 WSL 的 Node 中英文先后不同），只比对内容
  assert.deepEqual(listed.uncategorized.map(p => p.name).sort(), ['Izumi 1002', 'Izumi_0923', '同名', '同名'].sort());
  console.log('ok - preset.groups.list shows categories and uncategorized presets');
}

{
  const env = await setup();
  const args = { assignments: [
    { preset: 'Izumi 1002', group: 'Izumi' },
    { preset: 'p2', group: 'Izumi' },
    { preset: 'Kemini v3', group: '' },
    { preset: '同名', group: 'X' },
    { preset: '不存在', group: 'X' },
  ] };
  const denied = (await env.run('preset.groups.apply', args, { allow: false })).result;
  assert.notEqual(denied?.ok, true);
  assert.deepEqual(env.groupStore.getGroups(), [], '拒绝时不新建、不移动');
  const request = env.requests[0];
  assert.match(request.message, /新建 1 个分类/);
  assert.match(request.message, /移动 2 个预设/);
  assert.deepEqual(request.details.items.filter(item => item.status === 'planned').map(item => [item.label, item.meta]), [
    ['Izumi 1002', 'Izumi'], ['Izumi_0923', 'Izumi'],
  ]);

  const applied = (await env.run('preset.groups.apply', args)).result;
  // 找不到或重名的预设不猜，记为跳过并列出原因（同其他批量工具）
  assert.equal(applied.ok, true);
  assert.equal(applied.succeededCount, 2);
  assert.equal(applied.skippedCount, 3);
  assert.deepEqual(env.groupStore.getGroups().map(g => [g.name, g.presetIds]), [['Izumi', ['p1', 'p2']]]);
  assert.deepEqual(applied.results.map(item => item.status), ['succeeded', 'succeeded', 'skipped', 'ambiguous', 'missing']);
  assert.ok(env.events.includes('groups-changed'));
  console.log('ok - preset.groups.apply lists the plan for confirmation, creates groups and moves presets');
}

{
  const feature = listAppFeatures().find(item => item.id === 'preset.groups');
  assert.ok(feature, '功能目录有预设分类');
  assert.deepEqual(feature.tools, ['preset.groups.apply', 'preset.groups.list']);
  for (const input of ['帮我把预设分类', '整理一下我的预设，按系列分组']) {
    const ids = searchMaidCapabilityConcepts(input, { features: listAppFeatures() }).map(item => item.id);
    assert.ok(ids.includes('preset.groups'), `${input} → preset.groups（实际：${ids.slice(0, 8).join(', ')}）`);
  }
  console.log('ok - maid routes preset grouping requests to the grouping tools');
}
