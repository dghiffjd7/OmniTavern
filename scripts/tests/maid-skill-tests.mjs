import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { listMaidSkills } from '../../src/scripts/agent/maid-skill-catalog.js';
import { buildMaidFeatureCatalogPrompt } from '../../src/scripts/agent/maid-model-planner.js';
import { createMaidSkillContext, buildMaidSkillContextPrompt } from '../../src/scripts/agent/maid-skill-context.js';

test('the planner can discover and read both workflows with valid capability references and no writes', async () => {
  const features = listAppFeatures(), ids = new Set(features.map(feature => feature.id));
  const tool = createAppNavigationAgentTools().find(tool => tool.name === 'app.read_skill');
  const rules = buildMaidFeatureCatalogPrompt({ features }).staticText;
  const prompt = buildMaidSkillContextPrompt(createMaidSkillContext());
  assert(rules.includes('app.search_skills'));
  assert(!rules.includes('avatar.create_and_set'), 'user-editable catalog belongs in request context');
  assert.equal(tool.capabilities.write, false);
  assert.equal(tool.capabilities.network, false);
  assert.deepEqual(listMaidSkills().map(skill => skill.id), ['avatar.create_and_set', 'worldbook.from_sources']);
  for (const entry of listMaidSkills()) {
    assert(prompt.includes(entry.id));
    const result = await tool.execute({ skillId: entry.id });
    assert.equal(result.ok, true);
    assert(result.skill.content.length > 100);
    assert(result.skill.featureIds.every(id => ids.has(id)), 'all workflow references resolve to real capabilities');
    result.skill.featureIds.length = 0;
    assert((await tool.execute({ skillId: entry.id })).skill.featureIds.length > 0, 'callers cannot mutate the catalog');
  }
  assert.equal((await tool.execute({ skillId: 'unknown' })).reason, 'skill_not_found');
});
