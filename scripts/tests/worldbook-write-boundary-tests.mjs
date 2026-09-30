import assert from 'node:assert/strict';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';
import { buildRoleWorldBindingsImpl, collectEnabledRoleWorldIds } from '../../src/scripts/ui/world-role-binding-utils.js';

const clone = value => JSON.parse(JSON.stringify(value));
const entry = (title = '新增人物') => ({ title, content: `${title}的完整人物设定与关系。`, keys: [title] });
const createFixture = () => {
  const personas = [
    { id: 'current', name: '测试', created: 1, source: { worldbookId: '当前卡书', worldbookEnabled: true } },
    { id: 'other', name: '邻家篇', created: 2, source: { worldbookId: '邻家篇世界书', worldbookEnabled: true } },
  ];
  let active = 'current';
  const worlds = new Map(['当前卡书', '邻家篇世界书', '共享资料'].map(name => [name, {
    name, entries: [{ id: 'one', ...entry('林念初') }, { id: 'two', ...entry('住宅区') }],
  }]));
  const revisions = new Map([...worlds.keys()].map(name => [name, 1]));
  const generations = new Map([...worlds.keys()].map(name => [name, 1]));
  const globals = [];
  const sessionMap = {};
  const saves = [], deleted = [];
  let generated = 0, onGenerate = null, onSnapshot = null, snapshotCalls = 0;
  const deps = {
    personaStore: {
      getAll: () => personas, get: id => personas.find(item => item.id === id),
      getActive: () => personas.find(item => item.id === active), getActiveId: () => active,
    },
    chatStore: { getCurrent: () => '' },
    getGlobalWorldIds: () => globals,
    getWorldSessionMap: () => sessionMap,
    getWorldIdsForSession: () => [],
    listWorlds: async () => [...worlds.keys()],
    getWorldInfo: async id => clone(worlds.get(id) || null),
    worldInfoExists: async id => worlds.has(id),
    getWorldInfoSnapshot: async id => {
      await onSnapshot?.(id, ++snapshotCalls);
      return {
        exists: worlds.has(id), data: clone(worlds.get(id) || null),
        revision: revisions.get(id) || 0, generation: generations.get(id) || 0,
      };
    },
    saveWorldInfo: async (id, value, options = {}) => {
      if (options.expectedExists !== worlds.has(id)
        || options.expectedRevision !== (revisions.get(id) || 0)
        || options.expectedGeneration !== (generations.get(id) || 0)) {
        return { ok: false, reason: 'worldbook_revision_conflict' };
      }
      saves.push(id); worlds.set(id, clone(value)); revisions.set(id, (revisions.get(id) || 0) + 1);
      return { ok: true };
    },
    deleteWorldInfo: async id => { deleted.push(id); worlds.delete(id); return { ok: true }; },
    assignWorldToPersona: async (id, worldbookId, { enabled = true } = {}) => {
      const source = personas.find(persona => persona.id === id).source;
      source.worldbookId = worldbookId;
      source.worldbookEnabled = enabled;
      return true;
    },
    generateWithSubAgent: async () => {
      generated += 1;
      await onGenerate?.();
      return { ok: true, text: '一段完整的人物设定，包含背景、性格以及人际关系。' };
    },
  };
  const tools = createAppContentAgentTools(deps);
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow' }) } });
  registry.registerMany(tools);
  return {
    registry, tools, worlds, personas, globals, sessionMap, saves, deleted, revisions, generations,
    generated: () => generated, setActive: id => { active = id; },
    onGenerate: callback => { onGenerate = callback; },
    onSnapshot: callback => { snapshotCalls = 0; onSnapshot = callback; },
  };
};
const call = (fixture, name, args, requestToolConfirmation) => fixture.registry.executeTool(name, args, {
  requestToolConfirmation, runId: 'run-test',
});

// D09: append itself must enter the real registry confirmation path.
{
  const f = createFixture();
  f.personas[0].source.worldbookId = '';
  let request;
  const result = await call(f, 'worldbook.create', { name: '邻家篇世界书', entries: [entry('林念初的母亲')] }, async value => {
    request = value; return { decision: 'deny' };
  });
  assert.equal(result.status, 'skipped');
  assert.equal(request.allowAlways, false);
  assert.match(request.message, /测试.*邻家篇/);
  assert.equal(request.details.worldbookTargets[0].ownerCards[0].id, 'other');
  assert.equal(f.worlds.get('邻家篇世界书').entries.length, 2);
  assert.deepEqual(f.saves, []);
}

// Every mutation route must preserve the target boundary, including createMissing
// and updates that do not overwrite text (which previously skipped confirmation).
for (const [name, args] of [
  ['worldbook.create', { name: '邻家篇世界书', mode: 'replace', entries: [entry()] }],
  ['worldbook.generate_entries', { name: '邻家篇世界书', entries: [{ title: '母亲', outline: '温柔但管得很严' }] }],
  ['worldbook.update_entries', { name: '邻家篇世界书', createMissing: true, updates: [entry('新人物')] }],
  ['worldbook.update_entries', { name: '邻家篇世界书', updates: [{ entryId: 'one', disabled: true }] }],
  ['worldbook.delete_entries', { name: '邻家篇世界书', entries: ['one'] }],
  ['worldbook.delete_many', { worldbooks: ['邻家篇世界书'] }],
]) {
  const f = createFixture();
  const before = clone([...f.worlds]);
  let asks = 0;
  const result = await call(f, name, args, async request => {
    asks += 1; assert.equal(request.allowAlways, false); return { decision: 'deny' };
  });
  assert.equal(asks, 1, name);
  assert.equal(result.status, 'skipped', name);
  assert.deepEqual([...f.worlds], before, name);
  assert.equal(f.generated(), 0, 'denied generation must not spend model calls');
}

// D10: a persistent allow rule cannot skip this invocation's UI decision.
{
  const f = createFixture();
  let cacheChecks = 0, dialogs = 0;
  const runtime = createMaidToolConfirmationRuntime({
    allowStore: { isAllowed: () => { cacheChecks += 1; return true; } },
    choose: async options => {
      dialogs += 1;
      assert.ok(!options.actions.some(item => item.id === 'allow_always'));
      return 'allow_once';
    },
  });
  const result = await call(f, 'worldbook.update_entries', {
    name: '邻家篇世界书', updates: [{ entryId: 'one', content: '经本次明确批准的新正文。' }],
  }, runtime.request);
  assert.equal(result.result.ok, true);
  assert.equal(dialogs, 1);
  assert.equal(cacheChecks, 0);
  assert.equal(f.worlds.get('邻家篇世界书').entries[0].content, '经本次明确批准的新正文。');
}

// Own exclusive books keep the ordinary append flow; shared ownership and
// global books remain protected even when the current card also owns them.
{
  const f = createFixture();
  const result = await call(f, 'worldbook.create', { entries: [entry()] }, () => assert.fail('own append should not ask'));
  assert.equal(result.result.ok, true);
  assert.equal(f.worlds.get('当前卡书').entries.length, 3);
}
for (const configure of [
  f => { f.personas[1].source.worldbookId = '当前卡书'; },
  f => { f.globals.push('当前卡书'); },
  f => { f.sessionMap['other-chat'] = ['当前卡书']; },
]) {
  const f = createFixture(); configure(f);
  let asks = 0;
  const result = await call(f, 'worldbook.create', { entries: [entry()] }, request => {
    asks += 1; assert.equal(request.allowAlways, false); return { decision: 'deny' };
  });
  assert.equal(asks, 1);
  assert.equal(result.status, 'skipped');
}
{
  const f = createFixture();
  for (const args of [
    { name: '共享资料', entries: [entry()] },
    { sessionId: 'rp:other', entries: [entry()] },
    { personaId: 'other', name: '另一张卡的新书', entries: [entry()] },
  ]) {
    const result = await call(f, 'worldbook.create', args, () => ({ decision: 'deny' }));
    assert.equal(result.status, 'skipped');
  }
  assert.deepEqual(f.saves, []);
}

// An actual single approval may append to the specified foreign book only.
{
  const f = createFixture();
  const result = await call(f, 'worldbook.create', { name: '邻家篇世界书', entries: [entry('母亲')] }, () => ({ decision: 'allow' }));
  assert.equal(result.result.ok, true);
  assert.deepEqual(f.saves, ['邻家篇世界书']);
  assert.equal(f.worlds.get('邻家篇世界书').entries.length, 3);
  assert.equal(f.worlds.get('当前卡书').entries.length, 2);
  const raw = f.tools.find(tool => tool.name === 'worldbook.create');
  const bypass = await raw.execute({ name: '邻家篇世界书', entries: [entry('再写一次')] }, {
    toolSafety: { required: true, decision: 'allow', request: { toolName: 'worldbook.create', kind: 'worldbook.write_target' } },
  });
  assert.equal(bypass.reason, 'worldbook_target_confirmation_required');
  assert.equal(f.saves.length, 1);
}

// Scope changes while waiting for a human or generating text invalidate approval.
{
  const f = createFixture();
  const result = await call(f, 'worldbook.create', { name: '邻家篇世界书', entries: [entry()] }, () => {
    f.personas[1].source.worldbookId = '共享资料';
    return { decision: 'allow' };
  });
  assert.equal(result.result.reason, 'worldbook_target_changed');
  assert.deepEqual(f.saves, []);
}
for (const [change, reason] of [
  [f => f.setActive('other'), 'worldbook_target_changed'],
  [f => { f.personas[1].source.worldbookId = '当前卡书'; }, 'worldbook_target_changed'],
  [f => f.generations.set('当前卡书', 2), 'worldbook_changed_since_confirmation'],
]) {
  const f = createFixture(); f.onGenerate(() => change(f));
  const result = await call(f, 'worldbook.generate_entries', {
    name: '当前卡书', entries: [{ title: '人物', outline: '人物的完整背景设定' }],
  }, () => assert.fail('own book does not require target approval'));
  assert.equal(result.result.reason, reason);
  assert.deepEqual(f.saves, []);
}

// A scope change specifically during the boundary's awaited snapshot read is
// detected too; sampling card ownership before that await would miss it.
for (const change of [f => f.setActive('other'), f => f.globals.push('当前卡书')]) {
  const f = createFixture();
  f.onGenerate(() => f.onSnapshot(async (_id, index) => {
    if (index === 2) { await Promise.resolve(); change(f); }
  }));
  const result = await call(f, 'worldbook.generate_entries', {
    name: '当前卡书', entries: [{ title: '人物', outline: '人物的完整背景设定' }],
  });
  assert.equal(result.result.reason, 'worldbook_target_changed');
  assert.deepEqual(f.saves, []);
}

// One approved batch may delete its frozen targets; deleting the first target
// must not invalidate the authorization of the remaining targets.
{
  const f = createFixture();
  const result = await call(f, 'worldbook.delete_many', {
    worldbooks: ['邻家篇世界书', '共享资料'],
  }, () => ({ decision: 'allow' }));
  assert.equal(result.result.succeededCount, 2);
  assert.deepEqual(f.deleted, ['邻家篇世界书', '共享资料']);
  assert.ok(f.worlds.has('当前卡书'));
}

// New current-card books are still created and bound without a false cross-card
// approval, including a name collision with an existing other-card book.
{
  const f = createFixture();
  f.personas[0].source.worldbookId = '';
  f.personas[0].source.worldbookEnabled = false;
  const result = await call(f, 'worldbook.create', { entries: [entry()] }, () => assert.fail('new own book should not ask'));
  assert.equal(result.result.ok, true);
  assert.equal(result.result.boundPersonaId, 'current');
  assert.equal(f.personas[0].source.worldbookId, result.result.worldbookId);
  assert.equal(f.personas[0].source.worldbookEnabled, true, 'first binding enables a book even when the empty binding was disabled');
  const bindings = buildRoleWorldBindingsImpl({ personas: f.personas, activePersonaId: 'current' });
  assert.deepEqual(collectEnabledRoleWorldIds(bindings), [result.result.worldbookId]);
}

// A disabled existing book reflects a user's choice. Neither appending nor
// rebinding a newly created replacement may silently enable it.
for (const mode of ['append', 'create_new']) {
  const f = createFixture();
  f.personas[0].source.worldbookEnabled = false;
  const result = await call(f, 'worldbook.create', { mode, entries: [entry()] }, () => assert.fail('own book should not ask'));
  assert.equal(result.result.ok, true);
  assert.equal(f.personas[0].source.worldbookId, result.result.worldbookId);
  assert.equal(f.personas[0].source.worldbookEnabled, false, mode);
  const bindings = buildRoleWorldBindingsImpl({ personas: f.personas, activePersonaId: 'current' });
  assert.deepEqual(collectEnabledRoleWorldIds(bindings), [], mode);
}
console.log('ok - worldbook writes enforce per-invocation target approval across all mutation routes');
