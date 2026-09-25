import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMaidSkillText, readMaidSkillImportFiles, commitMaidSkillImport, exportMaidSkillMarkdown, exportMaidSkillPackage } from '../../src/scripts/ui/maid-skill-transfer.js';
import { MaidSkillStore } from '../../src/scripts/storage/maid-skill-store.js';

test('YAML preview has no writes; confirmed import preserves multiline text and never imports an external ID', async () => {
  let writes = 0;
  const store = new MaidSkillStore({ loadKv: async () => null, saveKv: async () => { writes++; } });
  await store.ready;
  const entries = parseMaidSkillText('---\nname: card-guide\ndescription: |\n  制作角色卡时使用。\n  保留原始设定。\ncontext: fork\n---\n按资料编写角色卡。');
  assert.equal(writes, 0); assert.equal(entries[0].skill.description, '制作角色卡时使用。\n保留原始设定。\n');
  await assert.rejects(commitMaidSkillImport(store, entries), { code: 'skill_import_review_required' });
  entries[0].textOnlyAccepted = true;
  const [saved] = await commitMaidSkillImport(store, entries);
  assert.equal(writes, 1); assert.equal(saved.content, '按资料编写角色卡。');
  const exported = exportMaidSkillMarkdown(saved);
  const [again] = parseMaidSkillText(exported.text, { fileName: exported.fileName });
  assert.equal(again.skill.content, saved.content);
  assert.equal(again.skill.portableMetadata.frontmatter.context, 'fork');
  const pkg = JSON.parse(exportMaidSkillPackage([saved]).text);
  assert.equal(pkg.skills[0].id, undefined);
  assert.equal(pkg.skills[0].enabled, undefined);
});

test('duplicate YAML keys, aliases and custom tags are rejected without evaluating commands', () => {
  for (const header of ['name: one\nname: two', 'name: &n one\ndescription: *n', 'name: !custom value']) {
    assert.throws(() => parseMaidSkillText(`---\n${header}\n---\nbody`), { code: 'skill_yaml_invalid' });
  }
});

test('a valid metadata-heavy library exports a package within the same import byte limit', async () => {
  const store = new MaidSkillStore({ loadKv: async () => null, saveKv: async () => {} }); await store.ready;
  const metadata = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`k${index}`, 'abcd']));
  const entries = Array.from({ length: 35 }, (_, index) => ({ skill: { title: `Skill ${index}`, name: `skill-${index}`, description: 'Workflow', content: 'x'.repeat(16000), portableMetadata: { values: metadata } } }));
  const saved = await store.importEntries(entries);
  const file = exportMaidSkillPackage(saved);
  assert.equal(parseMaidSkillText(file.text, { fileName: file.fileName }).length, 35);
});

test('duplicate documents in one package or file batch default to skip without discarding editable previews', async () => {
  const skill = { title: 'Guide', name: 'guide', description: 'Write a story', content: 'Keep the original setting.' };
  const pkg = exportMaidSkillPackage([skill, skill]);
  const packaged = parseMaidSkillText(pkg.text, { fileName: pkg.fileName });
  assert.deepEqual(packaged.map(entry => entry.action), ['new', 'skip']);
  const markdown = exportMaidSkillMarkdown(skill).text;
  const bytes = new TextEncoder().encode(markdown);
  const entries = await readMaidSkillImportFiles(['one.md', 'two.md'].map(name => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer })));
  assert.deepEqual(entries.map(entry => entry.selected), [true, false]);
  assert.equal(entries[1].skill.content, skill.content);
});
