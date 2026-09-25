import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidSkillContext, readMaidTaskSkill, buildMaidSkillContextPrompt, serializeMaidSkillContext, restoreMaidSkillContext, searchMaidTaskSkills, assertMaidSkillRequestBudget } from '../../src/scripts/agent/maid-skill-context.js';

const custom = { id: 'custom:example', name: 'example', title: '角色规范', description: '整理角色时使用', content: '保持人物设定。', featureIds: ['app.resource.read'], enabled: true, invocationMode: 'auto', revision: 3, kind: 'custom' };
test('accepted tasks keep their selected version through edits, disabling and restoration', () => {
  const catalog = [{ ...custom }], context = createMaidSkillContext({ catalog, selectedIds: [custom.id] });
  catalog[0].content = '新的说明'; catalog[0].enabled = false;
  assert(buildMaidSkillContextPrompt(context).includes('保持人物设定。'));
  const restored = restoreMaidSkillContext({ metadata: { maidSkills: serializeMaidSkillContext(context) } });
  assert.equal(readMaidTaskSkill(restored, custom.id).skill.revision, 3);
  assert(buildMaidSkillContextPrompt(restored).includes('保持人物设定。'));
  assert(!buildMaidSkillContextPrompt(restored).includes('新的说明'));
});

test('manual discovery, cursor ownership and document budgets remain bounded without truncating instructions', () => {
  const catalog = Array.from({ length: 30 }, (_, index) => ({ ...custom, id: `custom:${index}`, content: '文'.repeat(12000), invocationMode: index === 0 ? 'manual' : 'auto' }));
  const context = createMaidSkillContext({ catalog });
  const page = searchMaidTaskSkills(context, { limit: 5 });
  assert.equal(page.total, 29); assert.equal(page.skills.length, 5);
  assert(!page.skills.some(item => item.id === 'custom:0'));
  assert.equal(searchMaidTaskSkills(context, { includeManualOnly: true }).total, 30);
  assert.equal(searchMaidTaskSkills(createMaidSkillContext({ catalog }), { cursor: page.nextCursor, limit: 5 }).reason, 'skill_cursor_invalid');
  assert(readMaidTaskSkill(context, 'custom:1').ok); assert(readMaidTaskSkill(context, 'custom:2').ok);
  assert.equal(readMaidTaskSkill(context, 'custom:3').reason, 'skill_context_limit');
  assert(readMaidTaskSkill(context, 'custom:1').alreadyLoaded);
  const saved = serializeMaidSkillContext(context);
  assert.equal(saved.loaded.length, 2); assert.equal(saved.catalog, undefined);
  assert.equal(restoreMaidSkillContext({ metadata: { maidSkills: saved } }).catalog[0].content.length, 12000);
  delete saved.loaded[0].skill;
  assert.throws(() => restoreMaidSkillContext({ metadata: { maidSkills: saved } }), { code: 'skill_snapshot_unavailable' });
  const messages = [{ role: 'user', content: buildMaidSkillContextPrompt(context) }];
  assert.throws(() => assertMaidSkillRequestBudget(messages, { contextLength: 20000 }, 8000), { code: 'skill_context_limit' });
  assert.doesNotThrow(() => assertMaidSkillRequestBudget(messages, { contextLength: 128000 }, 8000));
});
