import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { buildMaidResultBasis, normalizeMaidResultBasis } from '../../src/scripts/agent/maid-result-basis.js';
import { MaidConversationStore, MAID_CONVERSATION_STORE_KEY, formatMaidHistoryContextText } from '../../src/scripts/storage/maid-conversation-store.js';

const now = 1790632800000;
const createStore = (data = new Map()) => new MaidConversationStore({
  storage: null,
  loadKv: async key => structuredClone(data.get(key) || null),
  saveKv: async (key, value) => data.set(key, structuredClone(value)),
  now: () => now,
  compactionTurnThreshold: 1000,
  compactionHistoryTokenThreshold: 100000,
});
const projectedBasis = text => [...text.matchAll(/resultBasis: (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]));
const executedBasis = buildMaidResultBasis({
  status: 'succeeded', responseType: 'tool', runId: 'run-web',
  steps: [{ toolName: 'web_read', status: 'succeeded', id: 'step-web',
    startedAt: now - 1000, finishedAt: now - 100,
    output: { ok: true, sources: [{ title: 'Official reference', url: 'https://example.com/reference' }] },
  }],
}, { recordedAt: now });

// Both initial load and appended records use the whitelist. Export/reload and
// prompt projection retain factual metadata without keeping tool arguments.
{
  const rawBasis = { ...executedBasis, secret: 'do-not-persist',
    tools: [{ ...executedBasis.tools[0], args: { credential: 'do-not-persist' }, output: 'do-not-persist' }],
    sources: [...executedBasis.sources, { title: 'Unsafe', url: 'javascript:alert(1)' }],
  };
  const data = new Map([[MAID_CONVERSATION_STORE_KEY, { updatedAt: now,
    turns: [{ id: 'loaded-evidence', at: now, input: 'Read the reference', message: 'Found a reference', resultBasis: rawBasis }],
  }]]);
  const store = createStore(data);
  await store.load();
  assert.deepEqual(store.exportState().turns[0].resultBasis, normalizeMaidResultBasis(rawBasis));
  await store.appendTurn({ id: 'appended-evidence', input: 'Read again', message: 'Reference found', resultBasis: rawBasis });
  const exported = store.exportState();
  assert.equal(JSON.stringify(exported).includes('do-not-persist'), false);
  exported.turns[0].resultBasis.tools[0].name = 'mutated-export';
  assert.equal(store.exportState().turns[0].resultBasis.tools[0].name, 'web_read');
  const reloaded = createStore(data);
  await reloaded.load();
  assert.deepEqual(reloaded.exportState().turns.map(turn => turn.resultBasis), [executedBasis, executedBasis]);
  assert.deepEqual(projectedBasis(reloaded.getHistoryContextText()), [0, 1].map(() => ({
    kind: 'tool_execution', recordedAt: now, sources: executedBasis.sources,
  })));
  for (const kind of ['fetched', 'read_document', 'search_result', 'unknown']) {
    const sources = [{ ...executedBasis.sources[0], kind }];
    const history = formatMaidHistoryContextText({ turns: [
      { at: now, message: 'Reference available', resultBasis: { ...executedBasis, sources } },
    ] });
    assert.deepEqual(projectedBasis(history)[0].sources, sources, 'history preserves the recorded access kind');
  }
}
console.log('ok - result basis survives whitelist normalization, save, reload, export and history');

// Exercise the real app persistence hook: a successful plan has no observed
// tool evidence; actual result steps do. Legacy turns retain null metadata.
{
  const data = new Map([[MAID_CONVERSATION_STORE_KEY, { updatedAt: now,
    turns: [{ id: 'legacy', at: now, input: 'Old request', message: 'Claimed success', status: 'succeeded', plan: { toolName: 'web_read' } }],
  }]]);
  const store = createStore(data);
  await store.load();
  assert.equal(store.exportState().turns[0].resultBasis, null);
  assert.deepEqual(projectedBasis(store.getHistoryContextText()), [{ kind: 'unverified', sources: [] }]);
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /import \{ buildMaidResultBasis \} from '\.\.\/agent\/maid-result-basis\.js';/);
  const marker = 'const recordMaidTurnFromResult = ';
  const start = appSource.indexOf(marker);
  const end = appSource.indexOf('\n  const resolveMaidRuntimeConfig =', start);
  assert.ok(start >= 0 && end > start);
  const hook = appSource.slice(start + marker.length, end).trim().replace(/;$/, '');
  const warnings = [];
  const record = runInNewContext(`(${hook})`, {
    maidConversationStore: store, buildMaidResultBasis,
    projectMaidStructuredMemoriesFromResult: () => [],
    logger: { warn: (...args) => warnings.push(args) },
  });
  await record({ input: 'Proposed lookup', result: { ok: true, status: 'succeeded', responseType: 'tool',
    message: 'Planned lookup', plan: { toolName: 'web_read' }, runId: 'plan-only' } });
  await record({ input: 'Actual lookup', context: { voiceCallId: 'call-1' }, result: {
    ok: true, status: 'succeeded', responseType: 'tool', message: 'Read the reference',
    steps: [{ toolName: 'web_read', status: 'succeeded', output: { sources: executedBasis.sources } }],
  } });
  assert.deepEqual(warnings, []);
  const turns = store.exportState().turns;
  assert.equal(turns[1].toolName, 'web_read', 'the existing plan display label remains compatible');
  assert.equal(turns[1].resultBasis.kind, 'unverified');
  assert.equal(turns[1].resultBasis.toolCount, 0);
  assert.deepEqual(turns[1].resultBasis.tools, []);
  assert.equal(turns[2].resultBasis.kind, 'tool_execution');
  assert.equal(turns[2].context.voiceCallId, 'call-1');
  assert.ok(turns[2].resultBasis.recordedAt > 0);
  assert.deepEqual(turns[2].resultBasis.sources, executedBasis.sources);
  assert.deepEqual(projectedBasis(formatMaidHistoryContextText({ turns: [
    { at: now, responseType: 'realtime', status: 'succeeded', message: 'A spoken completion claim' },
  ] })), [], 'speech status alone adds no execution evidence');
}
console.log('ok - app result persistence distinguishes actual steps from plans and supports legacy turns');

// Compaction retains a short basis alongside the result text; the archive
// preserves all source URLs. Long URLs are shortened to their explicit origin.
{
  const store = createStore();
  await store.load();
  const longUrl = `https://example.net/reference?query=${'a'.repeat(300)}`;
  const fullBasis = { ...executedBasis, sources: [...executedBasis.sources,
    { title: 'Long reference', url: longUrl }, { title: 'Third reference', url: 'https://example.org/third' }],
  };
  const expectedFullBasis = normalizeMaidResultBasis(fullBasis);
  await store.appendTurn({ id: 'compact-evidence', input: 'Read references', message: 'References found', resultBasis: fullBasis });
  await store.appendTurn({ id: 'compact-legacy', input: 'Old request', message: 'Claimed completion', status: 'succeeded' });
  await store.appendTurn({ id: 'compact-explanation', input: 'Explain the concept', message: 'A general explanation',
    resultBasis: buildMaidResultBasis({ responseType: 'chat', status: 'succeeded' }, { recordedAt: now }),
  });
  for (let index = 0; index < 8; index++) {
    await store.appendTurn({ id: `recent-${index}`, input: `Recent request ${index}`, message: 'Recent response' });
  }
  const row = store.compactHistoryToMemory({ force: true });
  assert.deepEqual(row.sourceTurnIds, ['compact-evidence', 'compact-legacy', 'compact-explanation']);
  assert.deepEqual(projectedBasis(row.content), [
    { kind: 'tool_execution', recordedAt: now, sources: [executedBasis.sources[0], { title: 'Long reference', kind: 'unknown', origin: 'https://example.net' }] },
    { kind: 'unverified', sources: [] },
    { kind: 'explanation', recordedAt: now, sources: [] },
  ]);
  assert.ok(row.content.length < 1200, 'basis projection stays compact');
  assert.equal(row.content.includes(longUrl), false);
  const archived = store.getLegacyArchive().compactedTurns.find(turn => turn.id === 'compact-evidence');
  assert.deepEqual(archived?.resultBasis, expectedFullBasis);
  await store.write();
  const exported = store.exportState();
  assert.deepEqual(exported.turns.find(turn => turn.id === 'compact-evidence').resultBasis, expectedFullBasis);
}
console.log('ok - compacted history keeps factual basis and archived turns retain full sources');
