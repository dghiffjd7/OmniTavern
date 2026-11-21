import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyMaidResultPresentation } from '../../src/scripts/agent/maid-result-presentation.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';

// 11/21 用户定：跨卡目标澄清交给模型自己问。读取工具的输出已带真实的绑定状态与目标选项，APP 不再改写模型的最终回复。
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-target-clarification-D10.json', import.meta.url), 'utf8'));
const registry = createAgentToolRegistry();
registry.registerMany(createAppNavigationAgentTools({}));
registry.registerMany(createAppContentAgentTools({}));
const fresh = () => structuredClone(captured);
const present = fixture => applyMaidResultPresentation(fixture.result, {
  context: fixture.context,
  isWriteTool: name => registry.get(name)?.capabilities?.write,
});

test('captured D10 clarify keeps the model question unchanged', () => {
  const fixture = fresh(), original = JSON.stringify(fixture.result);
  assert.strictEqual(present(fixture), fixture.result);
  assert.equal(JSON.stringify(fixture.result), original);
});

test('the read the model saw carries the unbound current card and both target options', () => {
  const fixture = fresh();
  const read = fixture.result.steps.find(step => step.args?.resource === 'worldbook');
  const book = read.output.worldbooks.find(item => item.entries.length);
  const evidence = book.targetSelectionEvidence;
  assert.equal(evidence.currentCard.personaId, fixture.context.roleCardId);
  assert.equal(evidence.currentCard.bindingState, 'unbound');
  assert.deepEqual(evidence.targetOptions.map(option => option.intent).sort(), ['create_and_bind', 'use_observed_worldbook']);
  // 录下的 DeepSeek 原文自己就问了这两个选项
  assert.match(fixture.result.message, /邻家篇世界书/);
  assert.match(fixture.result.message, /新建/);
});
