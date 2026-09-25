import assert from 'node:assert/strict';
import test from 'node:test';
import { MaidSkillStore } from '../../src/scripts/storage/maid-skill-store.js';

const draft = { title: '角色卡规范', name: 'character-guide', description: '整理角色卡时使用。', content: '保留用户设定，按实际结果汇报。', featureIds: [] };
const createMemoryStore = () => {
  let disk = null, fail = false;
  const options = { loadKv: async () => structuredClone(disk), saveKv: async (_key, value) => {
    if (fail) throw new Error('disk full');
    disk = structuredClone(value);
  } };
  return { store: new MaidSkillStore(options), reopen: () => new MaidSkillStore(options), fail: value => { fail = value; } };
};

test('saving a builtin copy and disabling its source is atomic and survives reload', async () => {
  const memory = createMemoryStore(), { store } = memory;
  await store.ready;
  assert.equal(store.list().length, 2);
  memory.fail(true);
  await assert.rejects(store.save(draft, { disableBuiltinId: 'avatar.create_and_set' }), /disk full/);
  assert.equal(store.list().length, 2);
  assert.equal(store.list().find(item => item.id === 'avatar.create_and_set').enabled, true);
  memory.fail(false);
  const saved = await store.save(draft, { disableBuiltinId: 'avatar.create_and_set' });
  const reopened = memory.reopen(); await reopened.ready;
  assert.equal(reopened.list().find(item => item.id === saved.id).content, draft.content);
  assert.equal(reopened.list().find(item => item.id === 'avatar.create_and_set').enabled, false);
});

test('invalid persistence is surfaced and replacement uses revision checks', async () => {
  const broken = new MaidSkillStore({ loadKv: async () => ({ schemaVersion: 99 }), saveKv: async () => { throw new Error('must not write'); } });
  await assert.rejects(broken.ready, { code: 'skill_store_invalid' });
  assert.throws(() => broken.list(), { code: 'skill_store_invalid' });
  const { store } = createMemoryStore(); await store.ready;
  const skill = await store.save(draft);
  await store.setAvailability(skill.id, { enabled: false });
  const saved = await store.save({ ...skill, content: '修改内容' }, { id: skill.id, expectedRevision: 1 });
  assert.equal(saved.revision, 2);
  await assert.rejects(store.save(draft, { id: skill.id, expectedRevision: 1 }), { code: 'skill_revision_conflict' });
});
