import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { findAppFeature, listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { searchMaidCapabilityConcepts } from '../../src/scripts/agent/maid-capability-concept-retriever.js';
import { createMaidCapabilityRetriever, createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { buildMaidModelPlannerMessages, buildMaidModelReActMessages, normalizeMaidModelPlan } from '../../src/scripts/agent/maid-model-planner.js';
import { buildMaidProviderFcToolPlan, normalizeMaidProviderFcCompletedCalls } from '../../src/scripts/agent/maid-provider-fc-planner.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppSessionAgentTools } from '../../src/scripts/agent/tools/app-session-tools.js';

const createFixture = () => {
  const effects = [];
  const registry = createAgentToolRegistry();
  registry.registerMany(createAppNavigationAgentTools({
    readResource: () => effects.push('private-read'),
    actions: { worldbook: () => effects.push('open-worldbook') },
  }));
  registry.registerMany(createAppContentAgentTools({}));
  registry.registerMany(createAppSessionAgentTools({}));
  return {
    registry, effects,
    call: async (name, args) => {
      const result = await registry.executeTool(name, args);
      assert.equal(result.status, 'succeeded');
      return result.result;
    },
  };
};

test('public merge lookup discovers comparison workflows without claiming an executable merge', async () => {
  const fixture = createFixture();
  for (const query of ['合并', 'merge']) {
    const found = await fixture.call('app.search_feature', { query });
    for (const id of ['worldbook.compare', 'session.compare']) {
      assert.ok(found.features.some(feature => feature.id === id), `${query}: ${id}`);
    }
    assert.equal(found.scope, 'registered_app_feature_catalog');
    assert.equal(found.exhaustive, false);
  }
  assert.deepEqual(fixture.effects, [], 'public discovery must not look up private records or open UI');
});

test('registered worldbook comparison documentation explains real content comparison and later approval', async () => {
  const fixture = createFixture();
  const result = await fixture.call('app.read_feature_doc', { featureId: 'worldbook.compare' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.feature.tools, ['worldbook.list', 'worldbook.read']);
  for (const fact of ['includeContent:true', '相同', '源独有', '目标独有', '冲突', 'APP', '确认']) {
    assert.ok(result.feature.doc.includes(fact), `workflow must explain ${fact}`);
  }
  assert.match(result.feature.doc, /源.*目标/);
  assert.match(result.feature.doc, /不.*一键|没有.*一键/);
  assert.match(result.feature.doc, /截断|完整/);
  assert.deepEqual(fixture.effects, []);
});

test('registered contact comparison documentation distinguishes identity, evidence and data loss', async () => {
  const fixture = createFixture();
  const result = await fixture.call('app.read_feature_doc', { featureId: 'session.compare' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.feature.tools, ['session.list', 'app.read_resource']);
  for (const fact of ['ID', 'description', 'messageCount', '聊天', '归档', '确认']) {
    assert.ok(result.feature.doc.includes(fact), `workflow must explain ${fact}`);
  }
  assert.match(result.feature.doc, /同名.*不|不.*同名/);
  assert.match(result.feature.doc, /建议|方案/);
  assert.deepEqual(fixture.effects, []);
});

test('concept retrieval prioritizes explicit comparison domains without guessing a resource from a bare merge', () => {
  const features = listAppFeatures(), retriever = createMaidCapabilityRetriever();
  for (const [query, id] of [
    ['把世界书副本合并回原书', 'worldbook.compare'],
    ['比较两本世界书的正文差异', 'worldbook.compare'],
    ['compare worldbooks', 'worldbook.compare'],
    ['把重复的联系人删掉只留一个', 'session.compare'],
    ['比较同名好友的人设和聊天数量', 'session.compare'],
    ['merge duplicate contacts', 'session.compare'],
  ]) {
    assert.equal(retriever.retrieve(query, { features, limit: 8 })[0]?.id, id, query);
  }
  for (const query of ['合并', '把陌生项目的副本合并回去', 'merge these files', '不要合并世界书', '别清理重复联系人']) {
    assert.ok(!searchMaidCapabilityConcepts(query, { features }).some(feature => feature.id.endsWith('.compare')), query);
  }
});

test('real routing and both planner projections expose only existing reads under each comparison capability', async () => {
  const fixture = createFixture();
  const features = listAppFeatures();
  const routing = createMaidCapabilityRoutingRuntime({ features, toolRegistry: fixture.registry, storage: null });
  for (const [id, input, required, forbidden] of [
    ['worldbook.compare', '比较两本世界书的差异', ['worldbook.list', 'worldbook.read'], 'worldbook.update_entries'],
    ['session.compare', '比较同名联系人', ['session.list', 'app.read_resource'], 'session.delete_many'],
  ]) {
    const request = routing.beginRequest({ input });
    const snapshot = routing.prepareDecision({ requestId: request.id, input, configOverride: { mode: 'bounded' } });
    const comparison = snapshot.candidateFeatures.find(feature => feature.id === id);
    assert.ok(comparison, `${id} must survive real tool availability filtering`);
    assert.equal(comparison.writes, false);
    assert.equal(comparison.riskLevel, 'low');
    assert.equal(comparison.firstRunGuide, '');
    assert.ok(!comparison.verification);
    for (const tool of required) assert.equal(fixture.registry.get(tool).capabilities.write, false);
    const doc = await fixture.call('app.read_feature_doc', { featureId: id });
    const planner = JSON.stringify(buildMaidModelPlannerMessages({ input, features: [comparison] }));
    const react = JSON.stringify(buildMaidModelReActMessages({ input, features: [comparison], steps: [
      { index: 1, toolName: 'app.read_feature_doc', args: { featureId: id }, status: 'succeeded', output: doc },
    ] }));
    assert.ok(planner.includes(id) && planner.includes(id === 'worldbook.compare' ? 'includeContent:true' : 'messageCount'), 'the selected workflow must reach the planning prompt');
    assert.ok(react.includes(id) && react.includes('确认'), 'the observed workflow must reach the next prompt');
    for (const config of [
      { provider: 'makersuite', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
      { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
    ]) {
      const plan = buildMaidProviderFcToolPlan({ config, features: [comparison] });
      assert.equal(plan.ok, true, plan.reason);
      assert.deepEqual(plan.toolMappings.filter(tool => !tool.control).map(tool => tool.internalName).sort(), required.slice().sort());
      assert.equal(normalizeMaidProviderFcCompletedCalls({ toolPlan: plan, completedToolCalls: [
        { toolName: forbidden.replaceAll('.', '_'), arguments: {} },
      ] }).reason, 'unknown_tool');
    }
    assert.equal(normalizeMaidModelPlan({ featureId: id, toolName: forbidden, args: {} }, {
      features: [comparison], candidateMode: true, candidateSnapshotId: snapshot.id,
    }).ok, false, 'comparison must not authorize a write through prompted JSON');
  }
  assert.deepEqual(fixture.effects, []);
});

test('missing catalog matches remain unknown and existing destructive capabilities retain approval', async () => {
  const fixture = createFixture();
  const found = await fixture.call('app.search_feature', { query: '夔夔夔夔' });
  assert.deepEqual(found.features, []);
  assert.equal(found.matchStatus, 'no_catalog_match');
  assert.equal(found.exhaustive, false);
  assert.match(found.message, /does not establish.*unsupported/);
  const missing = await fixture.call('app.read_feature_doc', { featureId: 'unregistered.merge' });
  assert.equal(missing.reason, 'feature_not_found');
  for (const id of ['worldbook.update_entries', 'worldbook.delete_many', 'session.delete_many']) {
    const feature = findAppFeature(id);
    assert.equal(feature.writes, true);
    assert.ok(['required', 'allow_once'].includes(feature.confirmation));
  }
});
