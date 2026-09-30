import assert from 'node:assert/strict';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';

const createFixture = (names = ['雾港志', '雾港志（副本）', '雾港志 copy', '雾港志 (2)', '雾港志-3', '雾港志续篇', '雾港']) => {
  const worlds = new Map(names.map(name => [name, { name, entries: [{ id: 'one', content: name }] }]));
  const revisions = new Map(names.map(name => [name, 1]));
  const deleted = [], approvals = [];
  const bindings = { session: ['雾港志'], global: ['雾港志'] };
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow' }) } });
  registry.registerMany(createAppContentAgentTools({
    listWorlds: async () => [...worlds.keys()],
    getWorldInfo: async id => worlds.get(id) || null,
    getWorldInfoSnapshot: async id => ({ exists: worlds.has(id), data: worlds.get(id) || null, revision: revisions.get(id) || 0, generation: 1 }),
    worldInfoExists: async id => worlds.has(id),
    getWorldSessionMap: () => ({ chat: bindings.session }),
    getGlobalWorldIds: () => bindings.global,
    deleteWorldInfo: async (id, options) => {
      assert.equal(options.expectedRevision, revisions.get(id));
      assert.equal(options.expectedGeneration, 1);
      assert.equal(options.expectedExists, true);
      assert.equal(options.conflictMode, 'return');
      deleted.push(id); worlds.delete(id);
      bindings.session = bindings.session.filter(value => value !== id);
      bindings.global = bindings.global.filter(value => value !== id);
      return { ok: true };
    },
  }));
  const call = (args, decide = () => true) => registry.executeTool('worldbook.delete_many', args, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => { approvals.push(request); return decide(request); },
  });
  return { worlds, revisions, deleted, approvals, bindings, call };
};

const checks = [
  ['confirmation warns about real unselected copies while only deleting the exact target', async () => {
    const f = createFixture();
    const result = await f.call({ worldbooks: ['雾港志'] });
    assert.equal(result.result.succeededCount, 1);
    assert.equal(f.approvals.length, 1);
    const request = f.approvals[0];
    for (const name of ['雾港志（副本）', '雾港志 copy', '雾港志 (2)', '雾港志-3']) assert(request.message.includes(name), name);
    assert.match(request.message, /保留/);
    assert.match(request.message, /\n\n另有/);
    assert.deepEqual(request.details.items.map(item => item.id), ['雾港志']);
    assert.deepEqual(request.argsPreview.worldbooks, ['雾港志']);
    assert.equal(request.allowAlways, false);
    assert.equal(request.details.items[0].meta, '绑定中 ×2');
    assert.deepEqual(request.details.keptSimilarWorldbooks.items.map(item => item.id), ['雾港志（副本）', '雾港志 copy', '雾港志 (2)', '雾港志-3']);
    assert.deepEqual(f.deleted, ['雾港志']);
    assert.equal(f.worlds.size, 6);
    assert.deepEqual(f.bindings, { session: [], global: [] });
  }],
  ['selected copies never appear as preserved suggestions', async () => {
    const f = createFixture();
    const result = await f.call({ worldbooks: ['雾港志', '雾港志（副本）'], preview: true });
    assert.equal(f.approvals.length, 0);
    assert.deepEqual(f.deleted, []);
    assert.equal(result.result.plannedCount, 2);
    assert.deepEqual(result.result.keptSimilarWorldbooks.items.map(item => item.id), ['雾港志 copy', '雾港志 (2)', '雾港志-3']);
    assert.equal(result.result.keptSimilarWorldbooks.count, 3);
  }],
  ['warning stays bounded and ignores unrelated shared prefixes', async () => {
    const f = createFixture(['雾港志', '雾港志续篇', '雾港志资料', '雾港', ...Array.from({ length: 8 }, (_, i) => `雾港志 (${i + 2})`)]);
    await f.call({ worldbooks: ['雾港志'] }, () => false);
    const warning = f.approvals[0].details.keptSimilarWorldbooks;
    assert.equal(warning.count, 8);
    assert.equal(warning.items.length, 5);
    assert.equal(warning.truncated, true);
    assert.match(f.approvals[0].message, /8/);
    assert.equal(warning.items.some(item => ['雾港志续篇', '雾港志资料', '雾港'].includes(item.id)), false);
    assert.deepEqual(f.deleted, []);
  }],
  ['no similarity warning is added when only unrelated names exist', async () => {
    const f = createFixture(['雾港志', '雾港志续篇', '雾港']);
    await f.call({ worldbooks: ['雾港志'] }, () => false);
    assert.equal(f.approvals[0].details.keptSimilarWorldbooks.count, 0);
    assert.equal(f.approvals[0].message.includes('近似名'), false);
  }],
  ['selecting a copy keeps the original and normalizes only advisory name matching', async () => {
    const selected = 'Ｆｏｇ　Ａｒｃｈｉｖｅ COPY (2)';
    const f = createFixture(['Fog Archive', selected, 'Fog Archives', 'Fog']);
    const result = await f.call({ worldbooks: [selected] });
    assert.equal(result.result.succeededCount, 1);
    assert.deepEqual(f.deleted, [selected]);
    assert.deepEqual(f.approvals[0].details.items.map(item => item.id), [selected]);
    assert.deepEqual(f.approvals[0].details.keptSimilarWorldbooks.items.map(item => item.id), ['Fog Archive']);
    assert.equal(f.worlds.has('Fog Archive'), true);
  }],
  ['editing a selected target during confirmation still prevents deletion', async () => {
    const f = createFixture();
    const result = await f.call({ worldbooks: ['雾港志'] }, async () => {
      await Promise.resolve(); f.revisions.set('雾港志', 2); return true;
    });
    assert.equal(result.result.succeededCount, 0);
    assert.equal(result.result.results[0].reason, 'worldbook_changed_since_confirmation');
    assert.deepEqual(f.deleted, []);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try { await check(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}: ${error.message}`); }
}
assert.equal(failed, 0, `${failed} worldbook similarity checks failed`);
console.log(`passed ${checks.length} worldbook deletion similarity checks`);
