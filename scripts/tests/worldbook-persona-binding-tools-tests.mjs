import assert from 'node:assert/strict';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';

const cards = new Map([
  ['a', { id: 'a', name: 'Current card', created: 1 }],
  ['b', { id: 'b', name: 'Target card', created: 2 }],
]);
const worlds = new Map(), bindings = [];
const tools = createAppContentAgentTools({
  personaStore: { getAll: () => [...cards.values()], get: id => cards.get(id), getActive: () => cards.get('a') },
  listWorlds: async () => [...worlds.keys()], getWorldInfo: async id => worlds.get(id),
  saveWorldInfo: async (id, data) => worlds.set(id, data),
  assignWorldToPersona: async (personaId, worldId, { enabled }) => {
    bindings.push({ personaId, worldId });
    cards.get(personaId).source = { worldbookId: worldId, worldbookEnabled: enabled };
    return true;
  },
});
const created = await tools.find(tool => tool.name === 'worldbook.create').execute({ name: 'Saved lore', entries: [{ title: 'Place', content: 'An island.' }] });
assert.equal(created.ok, true);
const before = JSON.stringify(worlds.get('Saved lore'));
const bind = tools.find(tool => tool.name === 'worldbook.bind_persona');
assert(bind, 'the maid needs a tool to bind an already saved worldbook to a specific character card without regenerating entries');
const result = await bind.execute({ worldbookId: 'Saved lore', personaId: 'b' });
assert.equal(result.ok, true);
assert.deepEqual(bindings, [{ personaId: 'b', worldId: 'Saved lore' }]);
assert.equal(JSON.stringify(worlds.get('Saved lore')), before, 'binding does not rewrite or duplicate existing entries');
assert.equal(cards.get('a').source, undefined, 'the active card is not modified');
const listed = await tools.find(tool => tool.name === 'worldbook.list').execute({});
assert.deepEqual(listed.worldbooks[0].personaBindings, [{ personaId: 'b', personaName: 'Target card', enabled: true }]);
assert.equal((await bind.execute({ worldbookId: 'Saved lore', personaName: 'Target card' })).changed, false);
assert.equal(bindings.length, 1, 'repeated binding is idempotent');
assert.equal((await bind.execute({ worldbookId: 'Saved lore' })).reason, 'missing_persona_target');
assert.equal((await bind.execute({ worldbookId: 'missing', personaId: 'b' })).reason, 'worldbook_not_found');
cards.set('c', { id: 'c', name: 'Target card', created: 3 });
assert.equal((await bind.execute({ worldbookId: 'Saved lore', personaName: 'Target card' })).reason, 'ambiguous_persona');
assert.equal(bindings.length, 1);

worlds.set('Another lore', { name: 'Another lore', entries: [] });
const registry = createAgentToolRegistry({ permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: 'allow' }), logger: { warn() {} } });
registry.registerMany(tools);
const requests = [];
const replace = confirm => registry.executeTool('worldbook.bind_persona', { worldbookId: 'Another lore', personaId: 'b' }, {
  operationIntentPolicy: { mode: 'write_allowed' },
  requestToolConfirmation: request => { requests.push(request); return confirm(); },
});
assert.equal((await replace(() => false)).status, 'skipped');
assert.equal(cards.get('b').source.worldbookId, 'Saved lore');
assert.equal(requests[0].allowAlways, false);
assert.equal(requests[0].details.personaId, 'b');
assert.equal(requests[0].details.previousWorldbookId, 'Saved lore');
assert.equal((await replace(() => true)).result.ok, true);
assert.equal(cards.get('b').source.worldbookId, 'Another lore');
assert.equal(worlds.get('Saved lore').entries[0].content, 'An island.');

cards.get('b').source.worldbookId = 'Saved lore';
const changed = await replace(() => { cards.get('b').source.worldbookId = 'user-choice'; return true; });
assert.equal(changed.result.reason, 'persona_binding_changed');
assert.equal(cards.get('b').source.worldbookId, 'user-choice');
cards.get('b').source.worldbookId = 'Saved lore';
const recreated = await replace(() => { cards.set('b', { ...cards.get('b'), created: 99 }); return true; });
assert.equal(recreated.result.reason, 'persona_target_changed');
const missingWorld = await replace(() => { worlds.delete('Another lore'); return true; });
assert.equal(missingWorld.result.reason, 'worldbook_deleted_during_operation');
assert.equal(bindings.length, 2, 'cancelled and stale operations never change the binding');
console.log('ok - saved worldbook can be bound to an explicitly selected non-active character card');
console.log('ok - readback, idempotency, ambiguous targets, replacement confirmation and concurrent edits are handled');
