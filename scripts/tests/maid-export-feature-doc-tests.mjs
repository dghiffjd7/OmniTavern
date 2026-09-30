import assert from 'node:assert/strict';

import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { buildAppFeatureSearchContextText, listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';
import { buildMaidModelPlannerMessages, buildMaidModelReActMessages, normalizeMaidModelPlan } from '../../src/scripts/agent/maid-model-planner.js';
import { buildMaidProviderFcToolPlan, normalizeMaidProviderFcCompletedCalls } from '../../src/scripts/agent/maid-provider-fc-planner.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';

const featureId = 'chat.export.help';
const input = '帮我看看这个APP能不能导出聊天记录啊？先告诉我有哪些办法就行，别改东西。';
const uiActions = [];
const tools = createAppNavigationAgentTools({
  actions: { settings: () => uiActions.push('settings'), chat: () => uiActions.push('chat') },
});
const getTool = name => tools.find(tool => tool.name === name);
const searchTool = getTool('app.search_feature');
const docTool = getTool('app.read_feature_doc');

// These include the real comparison request and the models' actual catalog queries.
for (const query of [input, '导出聊天记录', '导出', '导出聊天记录 导出会话 备份']) {
  const result = await searchTool.execute({ query });
  const feature = result.features.find(item => item.id === featureId);
  assert.ok(feature, `export guidance must be discoverable for: ${query}`);
  assert.equal(feature.writes, false);
  assert.deepEqual(feature.tools, ['app.read_feature_doc']);
  assert.equal(feature.directAction, 'app.read_feature_doc');
  assert.equal(result.scope, 'registered_app_feature_catalog');
  assert.equal(result.exhaustive, false);
  assert.equal(result.matchStatus, 'matched');
}
const doc = await docTool.execute({ featureId });
assert.equal(doc.ok, true);
for (const label of ['正文 Markdown', '完整 Markdown', '正文 TXT', '完整 TXT', '联系人', '群', '历史存档', '⇩']) {
  assert.ok(doc.feature.doc.includes(label), `export documentation must explain ${label}`);
}
assert.match(doc.feature.doc, /已保存.*原文.*推理/);
assert.match(doc.feature.doc, /用户.*保存/);
assert.match(doc.feature.doc, /不.*自动导出|不.*实际导出/);
console.log('ok - real export requests find accurate read-only guidance for all four options');

const permissionEvaluator = { evaluateTool: () => ({ decision: 'allow', checks: [] }) };
const registry = createAgentToolRegistry({ permissionEvaluator, logger: { warn() {} } });
registry.registerMany(tools);
const routing = createMaidCapabilityRoutingRuntime({
  features: listAppFeatures(), toolRegistry: registry, permissionEvaluator, storage: null,
});
const request = routing.beginRequest({ input });
const snapshot = routing.prepareDecision({
  requestId: request.id, input, configOverride: { mode: 'bounded' },
});
assert.ok(snapshot.candidateIds.has(featureId), 'read-only docs must survive tool candidate filtering');
const plan = normalizeMaidModelPlan({
  featureId, toolName: 'app.read_feature_doc', args: { featureId },
}, { features: snapshot.candidateFeatures, candidateMode: true, candidateSnapshotId: snapshot.id });
assert.equal(plan.ok, true);
assert.equal(plan.toolName, 'app.read_feature_doc');
assert.equal((await getTool(plan.toolName).execute(plan.args)).feature.id, featureId);
const messages = buildMaidModelPlannerMessages({ input, features: snapshot.promptFeatures });
assert.ok(JSON.stringify(messages).includes(featureId), 'the planner must see the help capability');
assert.ok(JSON.stringify(messages).includes('app.read_feature_doc'), 'the planner must be able to request the guide');
const observedMessages = buildMaidModelReActMessages({
  input,
  features: snapshot.promptFeatures,
  steps: [{ index: 1, toolName: plan.toolName, args: plan.args, status: 'succeeded', output: doc }],
});
for (const label of ['正文 Markdown', '完整 Markdown', '正文 TXT', '完整 TXT']) {
  assert.ok(JSON.stringify(observedMessages).includes(label), `the read guide must expose ${label} to the next model turn`);
}
const fcPlan = buildMaidProviderFcToolPlan({
  config: { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' },
  features: snapshot.candidateFeatures,
});
assert.equal(fcPlan.ok, true);
const docMapping = fcPlan.toolMappings.find(item => item.internalName === 'app.read_feature_doc');
assert.ok(docMapping);
const fcCall = normalizeMaidProviderFcCompletedCalls({
  toolPlan: fcPlan,
  completedToolCalls: [{ toolName: docMapping.providerName, arguments: { featureId } }],
});
assert.equal(fcCall.ok, true);
assert.equal(fcCall.selection.toolName, 'app.read_feature_doc');
assert.equal((await getTool(fcCall.selection.toolName).execute(fcCall.selection.args)).feature.id, featureId);
const unsupportedExport = normalizeMaidModelPlan({
  featureId, toolName: 'chat.export', args: {},
}, { features: snapshot.candidateFeatures, candidateMode: true });
assert.equal(unsupportedExport.ok, false);
assert.deepEqual(uiActions, [], 'reading export instructions must not open UI or begin export');
console.log('ok - export help stays selectable through real routing and both planner transports');

const unknownQuery = '夔夔夔夔';
const missing = await searchTool.execute({ query: unknownQuery });
assert.deepEqual(missing.features, []);
assert.equal(missing.scope, 'registered_app_feature_catalog');
assert.equal(missing.exhaustive, false);
assert.equal(missing.matchStatus, 'no_catalog_match');
assert.match(missing.message, /does not establish.*unsupported/);
assert.match(searchTool.summarizeResult(missing), /APP support.*unknown/);
assert.match(buildAppFeatureSearchContextText(unknownQuery), /非穷尽.*不能.*不支持/);
const missingDoc = await docTool.execute({ featureId: unknownQuery });
assert.equal(missingDoc.ok, false);
assert.equal(missingDoc.reason, 'feature_not_found');
assert.equal(missingDoc.exhaustive, false);
assert.match(missingDoc.message, /does not establish.*unsupported/);
console.log('ok - absent catalog entries remain unknown APP support instead of unsupported');
