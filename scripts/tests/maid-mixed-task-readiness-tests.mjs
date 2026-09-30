import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import {
  buildMaidModelPlannerMessages,
  buildMaidModelReActMessages,
} from '../../src/scripts/agent/maid-model-planner.js';

// This is a captured-input and prompt-contract regression, not a model replay.
// It does not claim that a model will follow the added guidance.
const captured = JSON.parse(readFileSync(new URL('./fixtures/maid-h05-mixed-task-readiness.json', import.meta.url), 'utf8'));
const features = listAppFeatures();
const selected = features.filter(feature => ['session.compare', 'session.delete_many', 'group.create', 'app.capabilities.search'].includes(feature.id));
const builds = [buildMaidModelPlannerMessages, buildMaidModelReActMessages];
const modes = ['prompted_json', 'provider_fc'];

const checks = [
  ['captured request survives all three calls and both post-read decisions had all four groups and clarification control', () => {
    assert.equal(captured.source_sha256, '727ce9a10d793058f5a480ad3c5f3a5420e039e6271dda5374c039d1a1011b1b');
    assert.equal(captured.calls.length, 3);
    assert.equal(captured.groups.length, 4);
    for (const call of captured.calls) assert(call.userMessage.includes(captured.input));
    // The initial call precedes any private data read. Only the next two calls
    // can contain the observed group records; do not invent an earlier read.
    for (const call of captured.calls.slice(1)) {
      assert(call.offeredToolNames.includes('maid_planner_control'));
      for (const group of captured.groups) {
        assert(call.userMessage.includes(group.id));
        assert(call.userMessage.includes(`"name":"${group.name}"`));
        assert(call.userMessage.includes(`"memberCount":${group.memberCount}`));
      }
      assert(call.userMessage.includes('"total":4'));
      assert(call.userMessage.includes('"hasMore":false'));
    }
    assert.deepEqual(captured.selectedDelete.sessions, captured.groups.filter(group => group.memberCount === 0).map(group => group.id));
    assert.equal(captured.selectedDelete.preview, false);
    assert.equal(captured.approvalDecision.reason, 'observe_only');
    assert.deepEqual(captured.changedStateFields, ['at', 'conversation', 'runs']);
  }],
  ['initial and ReAct JSON/FC prompts share readiness guidance without adding a second approval to ready tasks', () => {
    let sharedRule;
    for (const build of builds) for (const transportMode of modes) {
      const [system, user] = build({
        input: captured.input, features: selected, featureIndex: features,
        steps: captured.readSteps, transportMode,
      });
      const rule = system.content.split('\n').find(line => line.startsWith('For a request containing multiple operations,'));
      assert(rule, 'mixed-operation readiness guidance is missing');
      assert.match(rule, /necessary read-only checks/);
      assert.match(rule, /later operation still lacks a required target or parameter/);
      assert.match(rule, /before the first irreversible operation/);
      assert.match(rule, /observed results, exact proposed targets, and missing choices/);
      assert.match(rule, /clarification/);
      assert.match(rule, /Keep the requested execution order/);
      assert.match(rule, /explicitly asks to execute an independent ready step first/);
      assert.match(rule, /single ready operation|single operation with complete parameters/);
      assert.match(rule, /all requested operations have complete parameters/);
      assert.match(rule, /creative details/);
      assert.match(rule, /APP approval/);
      assert.equal(sharedRule ?? rule, rule);
      sharedRule = rule;
      assert.match(system.content, /唯一准确匹配[^\n]*preview:false/);
      assert.match(system.content, /不需要额外的文字确认/);
      assert.match(system.content, /不得自动[^\n]*preview:true[^\n]*实际删除/);
      assert(user.content.includes(captured.input));
      if (build === buildMaidModelReActMessages) {
        for (const group of captured.groups) assert(user.content.includes(group.id));
      }
    }
  }],
  ['read-once completion is limited to completed read-only requests and keeps other requested operations pending', () => {
    for (const transportMode of modes) {
      const [system] = buildMaidModelReActMessages({ input: captured.input, steps: captured.readSteps, transportMode });
      assert.doesNotMatch(system.content, /一次成功读取已经返回用户要求的字段时，立即 final/);
      assert.match(system.content, /For a read-only request, finalize once all requested facts/);
      assert.match(system.content, /For a mixed request, one successful read does not complete the other requested operations/);
      assert.match(system.content, /do not repeat a successful read/);
    }
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try { check(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}: ${error.message.split('\n')[0]}`); }
}
assert.equal(failed, 0, `${failed} mixed-task readiness contract checks failed`);
console.log(`passed ${checks.length} mixed-task readiness contract checks`);
