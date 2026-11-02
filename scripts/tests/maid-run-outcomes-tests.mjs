import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { buildMaidStepOutcomes, summarizeMaidToolOutcomes } = await import('../../src/scripts/agent/maid-run-outcomes.js');
const { CapabilityRetrievalStore } = await import('../../src/scripts/storage/capability-retrieval-store.js');
const { createMaidCapabilityRoutingRuntime } = await import('../../src/scripts/agent/maid-capability-routing.js');
const { buildAgentRunSummary } = await import('../../src/scripts/agent/agent-run-view-model.js');

const step = (toolName, status = 'succeeded', extra = {}) => ({ toolName, status, candidateSnapshotId: `snap-${toolName}`, candidateHit: true, ...extra });

{
  // 每个动作配上它后面的自动验证；验证步骤本身不算动作
  const outcomes = buildMaidStepOutcomes([
    step('worldbook.update_entries'),
    step('worldbook.read', 'succeeded', { metadata: { verificationFor: 'worldbook.update_entries' } }),
    step('session.create'),
    step('session.list', 'failed', { metadata: { verificationFor: 'session.create' } }),
    step('app.read_resource'),
    step('persona.delete_many', 'failed', { failureCode: 'permission_denied' }),
    step('chat.send_message', 'failed'),
    step('image.generate', 'skipped', { output: { reason: 'capability_enable_declined' } }),
  ], { runStatus: 'failed' });
  assert.deepEqual(outcomes.map(item => [item.toolName, item.outcome, item.verification]), [
    ['worldbook.update_entries', 'verified', 'verified'],
    ['session.create', 'verification_failed', 'failed'],
    ['app.read_resource', 'succeeded', 'none'],
    ['persona.delete_many', 'denied', 'none'],
    ['chat.send_message', 'failed', 'none'],
    ['image.generate', 'denied', 'none'],
  ]);
  assert.equal(outcomes[0].candidateSnapshotId, 'snap-worldbook.update_entries');
  assert.equal(outcomes[0].candidateHit, true, 'the retrieval hit is kept apart from the outcome');

  const cancelled = buildMaidStepOutcomes([step('a.write'), step('b.write', 'running')], { runStatus: 'cancelled' });
  assert.deepEqual(cancelled.map(item => item.outcome), ['succeeded', 'cancelled'], 'steps left unfinished by a cancel count as cancelled');
  assert.deepEqual(buildMaidStepOutcomes(null), []);
  console.log('ok - each action is linked to its auto-verification and classified by real outcome');
}

{
  // 按工具汇总；出问题多的在前
  const runs = [
    { metadata: { outcomes: [
      { toolName: 'worldbook.update_entries', outcome: 'verified' },
      { toolName: 'session.create', outcome: 'verification_failed' },
    ] } },
    { outcomes: [{ toolName: 'worldbook.update_entries', outcome: 'verified' }, { toolName: 'chat.send_message', outcome: 'denied' }, { toolName: 'x', outcome: 'bogus' }] },
    { metadata: {} },
  ];
  const profile = summarizeMaidToolOutcomes(runs);
  assert.deepEqual(profile.overall, { executions: 4, verified: 2, verificationFailed: 1, succeeded: 0, failed: 0, denied: 1, cancelled: 0 });
  assert.deepEqual(profile.byTool.map(item => [item.toolName, item.executions]), [['session.create', 1], ['chat.send_message', 1], ['worldbook.update_entries', 2]]);
  console.log('ok - tool outcomes summarize by tool with problem tools first');
}

{
  // 结果挂回它的检索快照；再次记录选择时不丢
  const store = new CapabilityRetrievalStore({ storage: null, loadKv: async () => null, saveKv: async () => {}, now: () => 1000, setTimeoutFn: null });
  await store.load();
  store.recordDecision({ id: 'snap-1', requestId: 'r1', createdAt: 1000, candidates: [{ id: 'worldbook.update_entries' }], selectedCapabilityId: 'worldbook.update_entries', candidateHit: true, validSelection: true });
  const routing = createMaidCapabilityRoutingRuntime({ toolRegistry: { listTools: () => [] }, storage: null, retrievalStore: store });
  routing.observeOutcomes([
    { candidateSnapshotId: 'snap-1', toolName: 'worldbook.update_entries', outcome: 'verified', verification: 'verified' },
    { candidateSnapshotId: 'missing', toolName: 'x', outcome: 'failed' },
    { candidateSnapshotId: '', toolName: 'y', outcome: 'failed' },
  ]);
  let snapshot = store.listSnapshots({ requestId: 'r1' })[0];
  assert.deepEqual(snapshot.outcome, { outcome: 'verified', verification: 'verified', toolName: 'worldbook.update_entries', recordedAt: 1000 });
  store.recordDecision({ id: 'snap-1', requestId: 'r1', createdAt: 1000, candidates: [{ id: 'worldbook.update_entries' }], selectedCapabilityId: 'worldbook.update_entries', candidateHit: true, validSelection: true });
  snapshot = store.listSnapshots({ requestId: 'r1' })[0];
  assert.equal(snapshot.outcome.outcome, 'verified', 're-recording the decision keeps the outcome');
  assert.equal(store.recordOutcome('snap-1', { outcome: 'nonsense' }), null);
  console.log('ok - outcomes attach to their retrieval snapshot without being overwritten');
}

{
  // 活动列表的摘要带上结果；Agent Center 活动页显示工具成效
  assert.deepEqual(buildAgentRunSummary({ id: 'r', metadata: { outcomes: [{ toolName: 'a', outcome: 'verified' }] } }).outcomes, [{ toolName: 'a', outcome: 'verified' }]);
  assert.equal('outcomes' in buildAgentRunSummary({ id: 'r', metadata: {} }), false, 'runs without outcomes keep the old summary shape');
  const panelSource = await readFile(new URL('../../src/scripts/ui/agent-center-panel.js', import.meta.url), 'utf8');
  assert.match(panelSource, /renderUsageProfileSummary\(activity\.usageProfile\)\}\$\{renderToolOutcomeSummary\(activity\.toolOutcomes\)\}/);
  const agentSource = await readFile(new URL('../../src/scripts/agent/maid-assistant-agent.js', import.meta.url), 'utf8');
  assert.match(agentSource, /const outcomes = buildMaidStepOutcomes\(result\?\.steps, \{ runStatus \}\);/);
  assert.match(agentSource, /onOutcomes: outcomes => capabilityRoutingRuntime\?\.observeOutcomes\?\.\(outcomes\)/);
  console.log('ok - run summaries and the activity page carry the outcome chain');
}

console.log('maid-run-outcomes-tests passed');
