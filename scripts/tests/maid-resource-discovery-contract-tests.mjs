import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppResourceReader } from '../../src/scripts/agent/app-resource-reader.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { resolveWorldbookCurrentPersona } from '../../src/scripts/agent/worldbook-resource-ownership.js';

const createFixture = ({ personas = null } = {}) => {
  const cards = personas || [
    { id: 'current', name: '当前卡', source: { worldbookId: 'shared', worldbookEnabled: true } },
    { id: 'neighbor', name: '邻家篇', source: { worldbookId: 'foreign', worldbookEnabled: true } },
    { id: 'other', name: '共享卡', source: { worldbookId: 'shared', worldbookEnabled: false } },
  ];
  let activeId = 'current';
  const personaStore = {
    getAll: () => cards, get: id => cards.find(card => card.id === id),
    getActive: () => cards.find(card => card.id === activeId),
  };
  const contact = { id: 'luna', name: 'Luna', description: '猫娘，英文名 Luna，棕色短发与猫耳，喜欢晒太阳。' };
  const chatStore = {
    getCurrent: () => '', listSessions: () => ['luna'], getMessages: () => [], getSessionSettings: () => ({}),
  };
  const worlds = {
    shared: { name: '共享设定', entries: [{ id: 'shared-entry', title: '共同设定', content: '共同正文' }] },
    foreign: { name: '邻家篇世界书', entries: [{ id: 'other_01', title: '林念初', content: '青梅竹马。' }] },
  };
  const appBridge = {
    waitForWorldStoreReady: async () => {}, listWorlds: () => Object.keys(worlds),
    getWorldInfo: id => worlds[id], getWorldIdsForSession: () => [], getGlobalWorldIds: () => [],
  };
  const deps = { appBridge, personaStore, chatStore, contactsStore: { getContact: () => contact } };
  const registry = createAgentToolRegistry();
  registry.registerMany(createAppNavigationAgentTools({ readResource: createAppResourceReader(deps) }));
  registry.registerMany(createAppContentAgentTools({ personaStore, chatStore, ...appBridge }));
  return {
    contact, deps, worlds, setActive: id => { activeId = id; },
    call: async (name, args = {}) => {
      const output = await registry.executeTool(name, args);
      assert.equal(output.status, 'succeeded');
      return output.result;
    },
  };
};

const ownership = value => Object.fromEntries([
  'ownershipKnown', 'currentCard', 'personaBindings', 'ownerCards', 'otherOwnerCards', 'sharedAcrossCards', 'ownerHint', 'targetSelectionEvidence',
].map(key => [key, value[key]]));

test('registered resource tool exposes the real contact description only on request', async () => {
  const fixture = createFixture();
  const summary = await fixture.call('app.read_resource', { resource: 'session' });
  assert.equal(Object.hasOwn(summary.sessions[0], 'description'), false);
  const result = await fixture.call('app.read_resource', { resource: 'session', name: 'Luna', include: ['description'] });
  assert.equal(result.sessions[0].description, fixture.contact.description);
  assert.equal(result.sessions[0].descriptionLength, fixture.contact.description.length);
  assert.equal(result.sessions[0].descriptionTruncated, false);
  assert.deepEqual(result.includedFields, ['description']);
});

test('description expansion has an explicit bounded length and truncation evidence', async () => {
  const fixture = createFixture();
  fixture.contact.description = '设定'.repeat(7000);
  const result = await fixture.call('app.read_resource', { resource: 'session', include: ['description'], maxTextLength: 120 });
  assert.equal(result.sessions[0].description.length, 120);
  assert.equal(result.sessions[0].descriptionLength, 14000);
  assert.equal(result.sessions[0].descriptionTruncated, true);
  const defaults = await fixture.call('app.read_resource', { resource: 'session', include: ['description'] });
  assert.equal(defaults.sessions[0].description.length, 2000);
});

test('worldbook list/read/resource expose identical foreign and shared card ownership', async () => {
  const fixture = createFixture();
  const listed = await fixture.call('worldbook.list');
  const resource = await fixture.call('app.read_resource', { resource: 'worldbook', query: '林念初' });
  assert.deepEqual(resource.currentCard, listed.currentCard);
  assert.deepEqual(resource.currentCard, { personaId: 'current', personaName: '当前卡', worldbookId: 'shared' });
  for (const id of ['foreign', 'shared']) {
    const read = await fixture.call('worldbook.read', { name: id });
    const item = resource.worldbooks.find(item => item.id === id);
    assert.deepEqual(ownership(item), ownership(read));
    assert.deepEqual(ownership(item), ownership(listed.worldbooks.find(item => item.id === id)));
    assert.equal(item.ownershipKnown, true);
  }
  const foreign = resource.worldbooks.find(item => item.id === 'foreign');
  assert.equal(foreign.currentCard, false);
  assert.deepEqual(foreign.ownerCards, ['邻家篇']);
  assert.match(foreign.ownerHint, /确认/);
  const shared = resource.worldbooks.find(item => item.id === 'shared');
  assert.equal(shared.currentCard, true);
  assert.equal(shared.sharedAcrossCards, true);
  assert.deepEqual(shared.otherOwnerCards, ['共享卡']);
  assert.equal(shared.personaBindings.find(card => card.personaId === 'other').enabled, false);
  assert.match(shared.ownerHint, /共享卡/);
});

test('explicit RP scope resolves its card consistently without switching the active card', async () => {
  const fixture = createFixture();
  const args = { sessionId: 'rp:neighbor' };
  const listed = await fixture.call('worldbook.list', args);
  const read = await fixture.call('worldbook.read', { ...args, name: 'foreign' });
  const resource = await fixture.call('app.read_resource', { ...args, resource: 'worldbook' });
  assert.equal(resource.currentCard.personaId, 'neighbor');
  assert.deepEqual(resource.currentCard, listed.currentCard);
  assert.equal(read.currentCard, true);
  assert.deepEqual(ownership(resource.worldbooks.find(item => item.id === 'foreign')), ownership(read));
  assert.equal(fixture.deps.personaStore.getActive().id, 'current');
});

test('unknown explicit RP card reports unknown read ownership without changing legacy write resolution', async () => {
  const fixture = createFixture();
  const args = { sessionId: 'rp:missing-card' };
  const listed = await fixture.call('worldbook.list', args);
  const read = await fixture.call('worldbook.read', { ...args, name: 'shared' });
  const resource = await fixture.call('app.read_resource', { ...args, resource: 'worldbook' });
  assert.equal(resource.currentCard, null);
  assert.equal(listed.currentCard, null);
  const item = resource.worldbooks.find(item => item.id === 'shared');
  assert.equal(item.ownershipKnown, false);
  assert.equal(item.currentCard, false);
  assert.deepEqual(ownership(item), ownership(read));
  assert.deepEqual(ownership(item), ownership(listed.worldbooks.find(item => item.id === 'shared')));
  assert.deepEqual(item.ownerCards, ['当前卡', '共享卡']);
  assert.equal(item.ownerHint, undefined, 'cannot claim a cross-card comparison without a current card');
  assert.equal(item.targetSelectionEvidence.currentCard.bindingState, 'unknown');
  assert.deepEqual(item.targetSelectionEvidence.targetOptions, []);
  assert.equal(resolveWorldbookCurrentPersona({ ...fixture.deps, ...args }).id, 'current');
});

test('foreign ownership presents a current-card creation choice only for a known unbound card', async () => {
  const fixture = createFixture();
  fixture.deps.personaStore.getActive().source.worldbookId = '';
  const result = await fixture.call('app.read_resource', { resource: 'worldbook', query: '林念初' });
  const foreign = result.worldbooks.find(book => book.id === 'foreign');
  assert.deepEqual(foreign.targetSelectionEvidence, {
    currentCard: { personaId: 'current', personaName: '当前卡', worldbookId: '', bindingState: 'unbound' },
    observedWorldbook: { worldbookId: 'foreign', personaBindings: [{ personaId: 'neighbor', personaName: '邻家篇', enabled: true }] },
    targetOptions: [
      { target: 'current_card', personaId: 'current', worldbookId: '', intent: 'create_and_bind' },
      { target: 'observed_worldbook', worldbookId: 'foreign', intent: 'use_observed_worldbook' },
    ],
  });
  const read = await fixture.call('worldbook.read', { name: 'foreign' });
  assert.deepEqual(read.targetSelectionEvidence, foreign.targetSelectionEvidence);
});

test('target choices describe saved bindings without claiming existence or duplicating a shared current book', async () => {
  const fixture = createFixture();
  const foreign = await fixture.call('worldbook.read', { name: 'foreign' });
  assert.equal(foreign.targetSelectionEvidence.currentCard.bindingState, 'bound');
  assert.deepEqual(foreign.targetSelectionEvidence.targetOptions[0], {
    target: 'current_card', personaId: 'current', worldbookId: 'shared', intent: 'use_current_binding',
  });
  const shared = await fixture.call('worldbook.read', { name: 'shared' });
  assert.deepEqual(shared.targetSelectionEvidence.targetOptions, []);
  fixture.deps.personaStore.getActive().source.worldbookId = 'saved-but-unverified';
  const dangling = await fixture.call('worldbook.read', { name: 'foreign' });
  assert.equal(dangling.targetSelectionEvidence.currentCard.bindingState, 'bound');
  assert.equal(dangling.targetSelectionEvidence.targetOptions[0].worldbookId, 'saved-but-unverified');
  const unknown = await createAppResourceReader({ ...fixture.deps, personaStore: null })({ resource: 'worldbook' });
  assert.deepEqual(unknown.worldbooks[1].targetSelectionEvidence.targetOptions, []);
});

test('missing persona and bridge dependencies do not invent ownership or books', async () => {
  const fixture = createFixture();
  const read = createAppResourceReader({ ...fixture.deps, personaStore: null });
  const unknown = await read({ resource: 'worldbook' });
  assert.equal(unknown.currentCard, null);
  assert.equal(unknown.worldbooks[0].ownershipKnown, false);
  assert.deepEqual(unknown.worldbooks[0].personaBindings, []);
  const unavailable = await createAppResourceReader({ personaStore: fixture.deps.personaStore, appBridge: {} })({ resource: 'worldbook' });
  assert.deepEqual(unavailable.worldbooks, []);
  assert.equal(unavailable.currentCard.personaId, 'current');
});

test('ownership uses the current card after awaited book reads complete', async () => {
  const fixture = createFixture();
  fixture.deps.appBridge.getWorldInfo = async id => {
    fixture.setActive('neighbor');
    return fixture.worlds[id];
  };
  const result = await createAppResourceReader(fixture.deps)({ resource: 'worldbook' });
  assert.equal(result.currentCard.personaId, 'neighbor');
  assert.equal(result.worldbooks.find(item => item.id === 'foreign').currentCard, true);
  assert.equal(result.worldbooks.find(item => item.id === 'shared').currentCard, false);
});
