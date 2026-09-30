import assert from 'node:assert/strict';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createPresetRegexScriptAgentTools } from '../../src/scripts/agent/tools/preset-regex-script-tools.js';
import {
  buildMaidModelPlannerMessages, buildMaidModelReActMessages,
  normalizeMaidModelPlan, normalizeMaidModelReActDecision,
} from '../../src/scripts/agent/maid-model-planner.js';

// The captured D02 inputs had empty memory/history, yet the preview rule did not
// distinguish an APP approval from an extra chat turn. This checks that message
// contract; it does not simulate or claim to predict a model decision.
const features = listAppFeatures();
const deleteFeature = features.find(feature => feature.id === 'worldbook.delete_many');
const builds = [buildMaidModelPlannerMessages, buildMaidModelReActMessages];
const checks = [
  ['both planning stages distinguish exact-target APP approval from an extra preview turn', () => {
    for (const build of builds) {
      const messages = build({
        input: '删除世界书「港湾记录」', features: [deleteFeature], featureIndex: features,
        conversationContext: { memoryText: '', historyText: '' },
        steps: [{ toolName: 'worldbook.list', status: 'succeeded', args: {}, output: {
          worldbooks: [{ id: 'book-a', name: '港湾记录' }, { id: 'book-b', name: '港湾记录 (copy)' }],
        } }],
      });
      const system = messages[0].content;
      assert.match(system, /唯一准确匹配/);
      assert.match(system, /省略 preview 或传 preview:false/);
      assert.match(system, /APP 确认面板/);
      assert.match(system, /不需要额外的文字确认/);
      assert.match(system, /近似[^\n]*保留/);
    }
  }],
  ['preview-only, real ambiguity, explicit habits and later consent remain distinct', () => {
    const preference = '每次删除前先列清单，等我回复确认再删。';
    for (const build of builds) {
      const messages = build({
        input: '先给删除方案，暂不执行', features: [deleteFeature], featureIndex: features,
        conversationContext: { memoryText: preference, historyText: '' },
      });
      assert(messages[1].content.includes(preference), 'real user preferences remain in the model input');
      const system = messages[0].content;
      assert.match(system, /只要预览、方案或不执行/);
      assert.match(system, /明确偏好[^\n]*preview:true/);
      assert.match(system, /多个准确匹配[^\n]*澄清/);
      assert.match(system, /预览成功[^\n]*不代表批准/);
      assert.match(system, /不得自动[^\n]*preview:true[^\n]*实际删除/);
    }
  }],
  ['normalizers preserve a selected preview instead of silently converting it to a write', () => {
    const plan = { ok: true, action: 'tool', featureId: 'worldbook.delete_many', toolName: 'worldbook.delete_many', args: { worldbooks: ['book-a'], preview: true } };
    for (const normalize of [normalizeMaidModelPlan, normalizeMaidModelReActDecision]) {
      const result = normalize(plan, { features });
      assert.equal(result.ok, true);
      assert.equal(result.args.preview, true);
      assert.deepEqual(result.args.worldbooks, ['book-a']);
    }
  }],
  ['actual delete help documents the existing confirmation and optional preview in every supported batch domain', async () => {
    const read = createAppNavigationAgentTools().find(tool => tool.name === 'app.read_feature_doc');
    const batchIds = ['worldbook.delete_many', 'session.delete_many', 'persona.delete_many', 'preset.delete_many', 'regex.delete_many', 'script.delete_many'];
    const extraTools = createPresetRegexScriptAgentTools();
    for (const featureId of batchIds) {
      const output = await read.execute({ featureId });
      assert.equal(output.ok, true);
      assert.match(output.feature.argsHint, /省略 preview 或传 preview:false/);
      assert.match(output.feature.argsHint, /APP 确认/);
      assert.match(output.feature.argsHint, /preview:true[^。]*不执行/);
      assert.equal(output.feature.confirmation, 'required');
      if (/^(preset|regex|script)\./.test(featureId)) {
        assert.equal(extraTools.find(tool => tool.name === featureId).schema.properties.preview.type, 'boolean');
      }
    }
    const worldbookDoc = await read.execute({ featureId: 'worldbook.delete_many' });
    assert.match(worldbookDoc.feature.argsHint, /近似名[^。]*保留/);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try { await check(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}: ${error.message.split('\n')[0]}`); }
}
assert.equal(failed, 0, `${failed} delete confirmation contract checks failed`);
console.log(`passed ${checks.length} delete confirmation contract checks`);
