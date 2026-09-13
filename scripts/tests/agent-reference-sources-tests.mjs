import assert from 'node:assert/strict';
import { createAgentReferenceSourceCatalog } from '../../src/scripts/ui/chat/agent-reference-sources.js';
import { buildAgentReferenceContext, normalizeAgentReferenceConfig } from '../../src/scripts/agent/agent-reference-context.js';

const bookId = name => `worldbook:${encodeURIComponent(name)}`;
const entryId = (name, id) => `${bookId(name)}:${encodeURIComponent(id)}`;
const books = {
  'Bound: World': { entries: [
    { uid: 0, comment: 'Zero', content: 'LOCAL ZERO' },
    { uid: null, id: 'fallback', comment: 'Fallback', content: 'FALLBACK CONTENT' },
    { uid: 2, content: 'DISABLED ENTRY', disable: true },
    { uid: 3, content: 'LEGACY CONTENT', promptBlocks: [{ id: 'a', content: 'BLOCK CONTENT' }, { id: 'b', enabled: false, content: 'DISABLED BLOCK' }] },
    { comment: 'Legacy without ID', content: 'ANONYMOUS CONTENT' },
  ], refs: [{ sourceId: 'Reference', entryIds: ['r'] }, { sourceId: 'Reference', entryIds: ['r'] }] },
  Reference: { entries: [{ id: 'r', uid: 0, comment: 'Referenced zero', content: 'REFERENCE CONTENT' }, { id: 'unused', uid: 2, content: 'UNSELECTED REFERENCE' }] },
  Unbound: { entries: [{ id: 'only', content: 'UNBOUND CONTENT' }] },
};
const before = JSON.stringify(books), loads = [], reads = [];
const world = { ready: Promise.resolve(), list: () => Object.keys(books), has: name => name in books,
  load: name => { reads.push(name); return books[name] || null; }, getMetadata: name => books[name] ? { entriesCount: books[name].entries.length } : null,
  ensureLoadedMany: async (names, options) => { loads.push({ names, options }); },
};
let enableSystem = true;
const presetContexts = [];
const presets = { ready: Promise.resolve(), getEnabled: type => type === 'sysprompt' ? enableSystem : true,
  getResolvedActive: (type, context) => {
    presetContexts.push(context);
    return type === 'sysprompt' ? { presetId: 'system:id', preset: { name: 'System', content: 'SYSTEM CONTENT', post_history: 'POST HISTORY' } }
      : { presetId: 'openai:id', preset: { name: 'Writing', prompts: [
        { identifier: 'active', name: 'Active', content: 'ACTIVE PROMPT' },
        { identifier: 'off', name: 'Off', content: 'DISABLED PROMPT' },
        { identifier: 'unused', name: 'Unused', content: 'UNORDERED PROMPT' },
        { identifier: 'marker', name: 'History', marker: true, content: 'MARKER CONTENT' },
      ], prompt_order: [
        { character_id: 100000, order: [{ identifier: 'off', enabled: true }] },
        { character_id: 100001, order: [{ identifier: 'active', enabled: true }, { identifier: 'off', enabled: false }, { identifier: 'marker', enabled: true }] },
      ] } };
  },
};
const context = { sessionId: 'rp:current', place: 'writing', scopeId: 'scope', archiveId: 'archive' };
let current = true;
const catalog = createAgentReferenceSourceCatalog({ getWorldStore: () => world, getPresetStore: () => presets,
  getResolvedWorldState: (sid, options) => { assert.equal(sid, context.sessionId); assert.equal(options.uiMode, 'rp'); return { worldIds: ['Bound: World'] }; },
  isCurrent: value => current && value.sessionId === context.sessionId,
});
const records = await catalog(context);
assert.deepEqual(loads[0], { names: ['Bound: World'], options: { includeRefs: true } });
assert.equal(reads.includes('Unbound'), false, 'unbound metadata does not read its body even if a store cache exists');
const whole = records.find(record => record.id === bookId('Bound: World'));
assert.ok(whole.text.includes('LOCAL ZERO') && whole.text.includes('FALLBACK CONTENT'));
assert.equal(whole.text.match(/REFERENCE CONTENT/g)?.length, 1, 'read-only ref expansion is deduplicated by source identity');
assert.equal(whole.text.includes('UNSELECTED REFERENCE'), false);
assert.ok(whole.text.includes('BLOCK CONTENT') && whole.text.includes('ANONYMOUS CONTENT'));
assert.equal(whole.text.includes('LEGACY CONTENT'), false, 'promptBlocks mode matches the worldbook renderer');
assert.equal(whole.text.includes('DISABLED'), false);
assert.ok(records.some(record => record.id === entryId('Bound: World', 0)));
assert.ok(records.some(record => record.id === entryId('Bound: World', 'fallback')));
assert.ok(records.some(record => record.id === `${bookId('Bound: World')}:ref:Reference:0`));
assert.equal(records.find(record => record.id === bookId('Unbound')).entriesLoaded, false);
assert.equal(records.some(record => record.id === entryId('Unbound', 'only')), false);
const promptRecords = records.filter(record => record.kind === 'prompt');
assert.equal(promptRecords.find(record => record.title === 'Off').disabled, true);
assert.equal(promptRecords.find(record => record.title === 'Unused').disabled, true);
assert.equal(promptRecords.some(record => record.title === 'History'), false);
assert.ok(promptRecords.some(record => record.text === 'POST HISTORY'));
assert.ok(presetContexts.every(value => value.sessionId === context.sessionId && value.uiMode === 'rp'));
assert.equal(JSON.stringify(books), before, 'reading references never mutates worlds, variables or prompt blocks');

const config = { worldbook: { enabled: true, ids: [bookId('Bound: World'), entryId('Bound: World', 0), bookId('Unbound'), bookId('Gone')] } };
const selected = await catalog(context, { config });
assert.ok(loads.at(-1).names.includes('Unbound'));
assert.ok(selected.find(record => record.id === entryId('Unbound', 'only')));
assert.equal(selected.find(record => record.id === entryId('Bound: World', 0)).covered, true);
assert.equal(selected.some(record => record.id === bookId('Gone')), false);
const reference = buildAgentReferenceContext([], config, { sources: selected });
assert.equal(reference.text.match(/LOCAL ZERO/g)?.length, 1, 'whole and individual selections do not duplicate reference text');
assert.equal(reference.sources.find(source => source.id === entryId('Bound: World', 0)).status, 'covered');
assert.equal(reference.sources.find(source => source.id === bookId('Gone')).status, 'missing');
const requested = await catalog(context, { worldbookId: 'Unbound' });
assert.ok(requested.find(record => record.id === entryId('Unbound', 'only')));
assert.equal(normalizeAgentReferenceConfig(null).history.enabled, false, 'legacy null context is readable');

enableSystem = false;
assert.equal((await catalog(context)).some(record => record.id.startsWith('prompt:sysprompt:')), false, 'actual getEnabled controls preset participation');
current = false;
const loadCount = loads.length;
assert.deepEqual(await catalog(context), []);
assert.equal(loads.length, loadCount, 'stale scope performs no source load');
current = true;
const originalLoad = world.ensureLoadedMany;
world.ensureLoadedMany = async () => { current = false; };
assert.deepEqual(await catalog(context), [], 'scope changes while loading discard the entire result');
world.ensureLoadedMany = originalLoad; current = true;
const controller = new AbortController(); controller.abort();
await assert.rejects(catalog(context, { signal: controller.signal }), error => error.name === 'AbortError');

const unreadableWorld = { ready: Promise.resolve(), list: () => ['Broken'], has: () => true,
  getMetadata: () => ({ entriesCount: 1 }), load: () => null, ensureLoadedMany: async () => { throw new Error('disk read failed'); } };
const unavailableCatalog = createAgentReferenceSourceCatalog({ getWorldStore: () => unreadableWorld, getPresetStore: () => null });
const unavailable = await unavailableCatalog(context, { config: { worldbook: { enabled: true, ids: [bookId('Broken')] } } });
assert.equal(unavailable[0].available, false);
assert.match(unavailable[0].message, /读取失败/);
console.log('agent reference sources tests passed');
