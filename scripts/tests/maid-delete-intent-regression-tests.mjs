import assert from 'node:assert/strict';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';

const features = listAppFeatures();
let executed = 0;
const createRuntime = ({ denyDelete = false } = {}) => {
  const permissionEvaluator = {
    evaluateTool: tool => ({
      decision: denyDelete && tool.name === 'worldbook.delete_many' ? 'deny' : 'allow',
      checks: [],
    }),
  };
  const toolRegistry = createAgentToolRegistry({ permissionEvaluator, logger: { warn() {} } });
  const registered = new Set();
  for (const feature of features) {
    for (const name of feature.tools || []) {
      if (registered.has(name)) continue;
      registered.add(name);
      toolRegistry.register({
        name,
        schema: { type: 'object', properties: {} },
        riskLevel: feature.riskLevel,
        execute: async () => { executed += 1; return { ok: true }; },
      });
    }
  }
  return createMaidCapabilityRoutingRuntime({
    features, toolRegistry, permissionEvaluator, logger: { debug() {} },
  });
};

const prepare = (runtime, input, { readDoc = false } = {}) => runtime.prepareDecision({
  input,
  phase: 'react',
  configOverride: { mode: 'bounded' },
  steps: readDoc ? [{
    toolName: 'app.read_feature_doc', status: 'succeeded',
    args: { featureId: 'worldbook.delete_many' },
  }] : [],
});

const checks = [
  ['colloquial deletion is available before reading docs', () => {
    const snapshot = prepare(createRuntime(), '把世界书「雾港旧档」删了');
    assert.equal(snapshot.candidateIds.has('worldbook.delete_many'), true);
    assert.equal(snapshot.useCandidates, true);
    assert.equal(snapshot.excluded.some(item => item.id === 'worldbook.delete_many'), false);
  }],
  ['a previously read doc restores the eligible named-resource delete candidate', () => {
    const snapshot = prepare(createRuntime(), '把「雾港旧档」删了', { readDoc: true });
    assert.equal(snapshot.candidateIds.has('worldbook.delete_many'), true);
    assert.equal(snapshot.candidateRefs.find(item => item.id === 'worldbook.delete_many')
      .reasonCodes.includes('looked_up_feature'), true);
  }],
  ['negation and read-only requests stay filtered even after a successful doc read', () => {
    for (const input of [
      '不要把世界书「雾港旧档」删了',
      '我不想把世界书「雾港旧档」删了',
      '我不打算把世界书「雾港旧档」删了',
      '我没让你把世界书「雾港旧档」删了',
      '不删了，世界书「雾港旧档」先保留',
      '别把世界书「雾港旧档」删掉',
      '暂别把世界书「雾港旧档」删了',
      '世界书「雾港旧档」暂时别删了',
      '先别删除世界书「雾港旧档」',
      '不执行删除世界书「雾港旧档」',
      '仅查看世界书「雾港旧档」是否已经删了',
      '只读核对世界书「雾港旧档」，不要删除',
    ]) {
      const snapshot = prepare(createRuntime(), input, { readDoc: true });
      assert.equal(snapshot.candidateIds.has('worldbook.delete_many'), false, input);
      assert.equal(snapshot.excluded.some(item => item.id === 'worldbook.delete_many'
        && item.reason === 'risk_intent_not_explicit'), true, input);
    }
  }],
  ['negation ends at punctuation before an independent positive request', () => {
    for (const refusal of ['不想', '不打算', '没让你']) {
      const snapshot = prepare(createRuntime(), `我${refusal}把世界书「雾港旧档」删了，删除世界书「过期备份」`);
      assert.equal(snapshot.candidateIds.has('worldbook.delete_many'), true, refusal);
      assert.equal(snapshot.excluded.some(item => item.id === 'worldbook.delete_many'), false, refusal);
    }
  }],
  ['deletion previews retain a high-risk candidate without performing a write', () => {
    const snapshot = prepare(createRuntime(), '只读生成世界书「雾港旧档」的删除预览，不要实际执行删除');
    assert.equal(snapshot.candidateIds.has('worldbook.delete_many'), true);
    assert.equal(snapshot.candidateFeatures.find(item => item.id === 'worldbook.delete_many').riskLevel, 'high');
    assert.equal(snapshot.candidateFeatures.find(item => item.id === 'worldbook.delete_many').writes, true);
    assert.equal(executed, 0);
  }],
  ['reading a doc cannot override a denied delete permission', () => {
    const snapshot = prepare(createRuntime({ denyDelete: true }), '把世界书「雾港旧档」删了', { readDoc: true });
    assert.equal(snapshot.candidateIds.has('worldbook.delete_many'), false);
    assert.equal(snapshot.excluded.some(item => item.id === 'worldbook.delete_many'
      && item.reason !== 'risk_intent_not_explicit'), true);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try { check(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}: ${error.message}`); }
}
assert.equal(failed, 0, `${failed} delete-intent regression checks failed`);
console.log(`passed ${checks.length} delete-intent regression checks`);
