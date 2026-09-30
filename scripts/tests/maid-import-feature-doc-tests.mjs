import assert from 'node:assert/strict';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { buildMaidModelReActMessages, normalizeMaidModelPlan } from '../../src/scripts/agent/maid-model-planner.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';

// A06's actual native query returned no_catalog_match before this regression fix.
const input = 'can you help me import a character card?';
const featureId = 'persona.import.help';
const uiActions = [];
const permissionEvaluator = { evaluateTool: () => ({ decision: 'allow', checks: [] }) };
const registry = createAgentToolRegistry({ permissionEvaluator, logger: { warn() {} } });
registry.registerMany(createAppNavigationAgentTools({
  actions: { settings: () => uiActions.push('settings'), session: () => uiActions.push('session') },
}));
const execute = async (tool, args) => {
  const output = await registry.executeTool(tool, args);
  assert.equal(output.status, 'succeeded');
  return output.result;
};
for (const query of ['import character card', input, '导入角色卡', '匯入角色卡']) {
  const result = await execute('app.search_feature', { query });
  const feature = result.features.find(item => item.id === featureId);
  assert.ok(feature, `manual import guide must be discoverable: ${query}`);
  assert.equal(feature.writes, false);
  assert.deepEqual(feature.tools, ['app.read_feature_doc']);
  assert.equal(feature.directAction, 'app.read_feature_doc');
}
const doc = await execute('app.read_feature_doc', { featureId });
assert.equal(doc.ok, true);
assert.deepEqual(doc.feature.uiPath, ['顶部头像', '角色卡管理', '导入角色卡', '选择文件（PNG / JSON）']);
assert.match(doc.feature.doc, /用户.*选择.*确认/);
assert.match(doc.feature.doc, /女仆.*附件.*不会.*导入/);

const routing = createMaidCapabilityRoutingRuntime({
  features: listAppFeatures(), toolRegistry: registry, permissionEvaluator, storage: null,
});
const request = routing.beginRequest({ input });
const snapshot = routing.prepareDecision({ requestId: request.id, input, configOverride: { mode: 'bounded' } });
assert.ok(snapshot.candidateIds.has(featureId), 'English request must retain manual guide in bounded candidates');
const plan = normalizeMaidModelPlan({ featureId, toolName: 'app.read_feature_doc', args: { featureId } }, {
  features: snapshot.candidateFeatures, candidateMode: true, candidateSnapshotId: snapshot.id,
});
assert.equal(plan.ok, true);
const messages = buildMaidModelReActMessages({
  input, features: snapshot.promptFeatures,
  steps: [{ index: 1, toolName: plan.toolName, args: plan.args, status: 'succeeded', output: doc }],
});
const observed = JSON.stringify(messages);
assert.ok(observed.includes('PNG / JSON'), 'real guide observation must expose supported file formats');
assert.ok(observed.includes('角色卡管理'), 'real guide observation must expose the actual panel');
assert.equal(normalizeMaidModelPlan({ featureId, toolName: 'persona.import', args: {} }, {
  features: snapshot.candidateFeatures, candidateMode: true,
}).ok, false, 'manual guide cannot authorize an invented import tool');
assert.deepEqual(uiActions, [], 'reading import instructions must not open panels or start an import');
console.log('ok - A06 actual English query resolves manual PNG/JSON guidance through registry and routing');
