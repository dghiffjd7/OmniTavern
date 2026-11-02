import assert from 'node:assert/strict';

import {
  AGENT_CAPABILITY_KIND,
  buildCapabilityRef,
  capabilityRefKey,
  createAgentRegistry,
  createSubAgentRegistryProvider,
  createConfiguredAgentRegistryProvider,
  createMaidSkillRegistryProvider,
  projectConfiguredAgentCapability,
  projectSubAgentCapability,
} from '../../src/scripts/agent/agent-registry.js';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('buildCapabilityRef fills defaults and ref falls back to id', () => {
  const ref = buildCapabilityRef({ id: 'worldbook.generate_entries' });
  assert.deepEqual(ref, {
    id: 'worldbook.generate_entries', version: '1', namespace: 'builtin',
    kind: 'agent', provider: 'app', ref: 'worldbook.generate_entries',
  });
  assert.equal(capabilityRefKey(ref), 'builtin:agent:worldbook.generate_entries@1');
});

test('projectSubAgentCapability maps config to unified agent capability', () => {
  const cap = projectSubAgentCapability({
    id: 'sub-1', name: '便宜档', modelProfileId: 'p-deepseek', modelOverride: 'v4-flash',
    skills: ['worldbook', 'longform'], note: '用于批量条目', enabled: true,
  });
  assert.equal(cap.ref.kind, AGENT_CAPABILITY_KIND);
  assert.equal(cap.ref.namespace, 'user');
  assert.equal(cap.ref.provider, 'maid-sub-agent');
  assert.equal(cap.ref.id, 'sub-1');
  assert.deepEqual(cap.capabilityTags, ['worldbook', 'longform']);
  assert.equal(cap.modelProfileRef, 'p-deepseek');
  assert.equal(cap.modelOverride, 'v4-flash');
  assert.equal(cap.memoryScope, 'maid-run');
  assert.equal(cap.delegation.maxDepth, 1);
  // 行为兼容投影：与迁移前 planner 收到的 sub-agent 形状一致
  assert.deepEqual(cap.promptShape, { id: 'sub-1', name: '便宜档', skills: ['worldbook', 'longform'], note: '用于批量条目', enabled: true, profileHint: '' });
});

test('sub-agent budgets project into the registry contract', () => {
  const cap = projectSubAgentCapability({ id: 's', name: 'S', modelProfileId: 'p', timeLimitSeconds: 60, maxOutputTokens: 4000 });
  assert.deepEqual(cap.budgets, { tokens: 4000, timeMs: 60000, toolCalls: null });
  assert.deepEqual(projectSubAgentCapability({ id: 's', modelProfileId: 'p' }).budgets, { tokens: null, timeMs: null, toolCalls: null });
  assert.equal(cap.role, 'sub_agent');
});

test('projectSubAgentCapability rejects records without id', () => {
  assert.equal(projectSubAgentCapability({ name: 'x', modelProfileId: 'p' }), null);
  assert.equal(projectSubAgentCapability(null), null);
});

test('registry lists projected sub-agents and looks up by id/ref', () => {
  const registry = createAgentRegistry({
    providers: [createSubAgentRegistryProvider(() => ([
      { id: 'a', name: 'A', modelProfileId: 'pa', skills: ['x'], enabled: true },
      { id: 'b', name: 'B', modelProfileId: 'pb', skills: [], enabled: false },
    ]))],
  });
  const all = registry.listAgents();
  assert.equal(all.length, 2);
  assert.deepEqual(registry.providers, ['maid-sub-agent']);
  assert.equal(registry.listEnabledAgents().length, 1);
  assert.equal(registry.getAgent('a').name, 'A');
  assert.equal(registry.getAgentByRef(all[0].ref).id, 'a');
  assert.equal(registry.listByProvider('maid-sub-agent').length, 2);
  // listPromptShapes 只含 enabled，且形状与迁移前一致（供 planner）
  const shapes = registry.listPromptShapes();
  assert.equal(shapes.length, 1);
  assert.deepEqual(shapes[0], { id: 'a', name: 'A', skills: ['x'], note: '', enabled: true, profileHint: '' });
});

test('registry preserves order and dedupes by capability ref key across providers', () => {
  const provA = createSubAgentRegistryProvider(() => ([{ id: 'dup', name: 'first', modelProfileId: 'p1' }]));
  const provB = createSubAgentRegistryProvider(() => ([{ id: 'dup', name: 'second', modelProfileId: 'p2' }, { id: 'uniq', name: 'u', modelProfileId: 'p3' }]));
  const registry = createAgentRegistry({ providers: [provA, provB] });
  const all = registry.listAgents();
  assert.equal(all.length, 2); // dup 只保留先注册 provider 的
  assert.equal(registry.getAgent('dup').name, 'first');
  assert.equal(registry.getAgent('uniq').name, 'u');
});

test('registry tolerates throwing providers without breaking others', () => {
  const bad = { provider: 'bad', listCapabilities: () => { throw new Error('boom'); } };
  const good = createSubAgentRegistryProvider(() => ([{ id: 'ok', name: 'ok', modelProfileId: 'p' }]));
  const registry = createAgentRegistry({ providers: [bad, good] });
  assert.equal(registry.listAgents().length, 1);
  assert.equal(registry.getAgent('ok').name, 'ok');
});

test('configured agents and maid skills join the registry without reaching delegation', async () => {
  // 真实的 agent-config-store：内置可配置 Agent 加一个用户自建的正文 Agent
  const config = createAgentConfigStore({ storage: null, loadKv: async () => null, saveKv: async () => {} });
  const context = { place: 'chat', sessionId: 's1', scopeId: 'p1' };
  const saved = await config.save({ id: 'text-edit:polish', context, scope: 'global', config: { title: '正文润色', enabled: true, modelMode: 'profile', modelProfileId: 'p-a', modelOverride: 'm-1', invocationMode: 'manual', tools: { enabled: true, ids: ['worldbook.read'] } } });
  assert.equal(saved.ok, true);
  const registry = createAgentRegistry({ providers: [
    createSubAgentRegistryProvider(() => ([{ id: 'sub-1', name: '便宜档', modelProfileId: 'p-d', skills: ['worldbook'], enabled: true }])),
    createConfiguredAgentRegistryProvider(() => config.list(context, 'effective')),
    createMaidSkillRegistryProvider(() => ([
      { id: 'builtin:avatar', kind: 'builtin', title: '生成并设置头像', description: '为角色卡生成头像', enabled: true, invocationMode: 'auto', featureIds: ['image.generate'] },
      { id: 'skill-1', kind: 'custom', title: '整理世界书', enabled: false, invocationMode: 'manual' },
    ])),
  ] });
  const roles = registry.listAgents().map(agent => agent.role);
  assert.ok(roles.includes('sub_agent') && roles.includes('format_review') && roles.includes('maid_skill'));
  assert.deepEqual(registry.providers, ['maid-sub-agent', 'agent-config', 'maid-skill']);
  // 委派与 planner 只看 Sub-agent
  assert.deepEqual(registry.listEnabledAgents({ role: 'sub_agent' }).map(agent => agent.id), ['sub-1']);
  assert.deepEqual(registry.listPromptShapes().map(shape => shape.id), ['sub-1']);
  const skill = registry.getAgent('builtin:avatar');
  assert.deepEqual([skill.ref.kind, skill.ref.namespace, skill.invocation, skill.capabilityTags, skill.execution.runtime], ['workflow', 'builtin', 'auto', ['image.generate'], 'maid-skill']);
  assert.equal(registry.getAgent('skill-1').ref.namespace, 'user');
  const polish = registry.getAgent('text-edit:polish');
  assert.deepEqual([polish.role, polish.custom, polish.modelProfileRef, polish.modelOverride, polish.invocation, polish.tools, polish.ref.namespace],
    ['text_edit', true, 'p-a', 'm-1', 'manual', 1, 'user']);
});

test('configured agent projection keeps model modes apart and rejects unknown kinds', () => {
  const follow = projectConfiguredAgentCapability({ config: { id: 'reply_check', kind: 'format_review', title: '格式修复', enabled: true, modelMode: 'follow_current', modelProfileId: 'ignored' }, source: 'global' });
  assert.deepEqual([follow.modelMode, follow.modelProfileRef, follow.custom, follow.ref.namespace, follow.scope], ['follow_current', '', false, 'builtin', 'global']);
  assert.equal(projectConfiguredAgentCapability({ config: { id: 'x', kind: 'unknown' } }), null);
  assert.equal(projectConfiguredAgentCapability({ config: { kind: 'text_edit' } }), null);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}
if (failed > 0) process.exit(1);
