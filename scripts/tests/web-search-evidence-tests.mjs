import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebSearchAgentTools } from '../../src/scripts/agent/tools/web-search-tools.js';
import { annotateMaidSearchResult } from '../../src/scripts/agent/maid-source-grounding.js';

// Reduced from the real Steam price search: populated results, no named game or
// corresponding price evidence. All HTTP is supplied at the external boundary.
const steamResults = [
  ['Welcome to Steam', 'https://store.steampowered.com/', 'The ultimate destination for playing games.'],
  ['Steam, The Ultimate Online Game Platform', 'https://store.steampowered.com/about', 'Experience Steam Hardware.'],
  ['登入 - Steam Community', 'https://steamcommunity.com/login?l=tchinese', '免費又好用。發掘數千款遊戲。'],
  ['Sign In - Steam Community', 'https://steamcommunity.com/login', 'Discover thousands of games.'],
  ['欢迎来到蒸汽平台', 'http://store.steamchina.com/', '折扣与活动 -20% ¥ 58.00 ¥ 46.40'],
];
const rss = `<rss><channel>${steamResults.map(([title, url, snippet]) =>
  `<item><title>${title}</title><link>${url}</link><description>${snippet}</description></item>`).join('')}</channel></rss>`;
const tools = createWebSearchAgentTools({
  httpRequest: async ({ url }) => {
    if (url.startsWith('https://api.duckduckgo.com/')) throw new Error('failed');
    if (url.startsWith('https://html.duckduckgo.com/')) return { ok: true, status: 200, body: '<html></html>' };
    if (url.startsWith('https://www.bing.com/search?')) return { ok: true, status: 200, body: rss };
    throw new Error(`Unexpected HTTP request: ${url}`);
  },
});

test('search and research report unrelated Steam results without treating HTTP success as price verification', async () => {
  for (const name of ['web.search', 'web.research']) {
    const tool = tools.find(candidate => candidate.name === name);
    const result = await tool.execute({
      query: 'Steam Pico Park Unravel Two 国区 价格',
      target: 'PICO PARK', targetAliases: ['ピコパーク'],
      ...(name === 'web.research' ? { fetchTop: 0 } : {}),
    });
    assert.equal(result.ok, true, `${name}: preserve request success`);
    assert.equal(result.provider, 'bing_rss');
    assert.equal(result.results.length, 5);
    assert.equal(result.evidenceStatus, 'no_relevant_sources', `${name}: unrelated home/login pages cannot support the named game`);
    assert.equal(result.targetCheck.relevantSourceCount, 0);
    assert.equal(result.targetCheck.method, 'normalized_name_match');
    assert.equal(result.factVerification, 'not_performed');
    assert.match(tool.summarizeResult(result), /no.*relevant.*evidence/i);
    assert.deepEqual(result.providerOutcomes, ['duckduckgo_instant:failed', 'duckduckgo_html:no_results']);
  }
});

test('both search tools keep broad discovery explicitly unchecked and expose the same optional target contract', async () => {
  const search = tools.find(tool => tool.name === 'web.search');
  const research = tools.find(tool => tool.name === 'web.research');
  assert.deepEqual(search.schema.properties.target, research.schema.properties.target);
  assert.deepEqual(search.schema.properties.targetAliases, research.schema.properties.targetAliases);
  for (const tool of [search, research]) {
    const result = await tool.execute({ query: 'Steam games', ...(tool === research ? { fetchTop: 0 } : {}) });
    assert.equal(result.ok, true);
    assert.equal(result.evidenceStatus, 'target_not_checked');
    assert.equal(result.targetCheck.checked, false);
    assert.equal(result.results.every(item => item.targetRelevant === null), true);
    assert.equal(result.factVerification, 'not_performed');
    assert.match(tool.summarizeResult(result), /target_not_checked/);
  }
});

test('name matches and aliases indicate relevance without verifying an unsupported price', () => {
  const result = annotateMaidSearchResult({
    ok: true,
    results: [{ title: 'ピコパーク', url: 'https://example.test/game', snippet: 'Local co-op game. Price unavailable.' }],
  }, { target: 'PICO PARK', targetAliases: ['ピコパーク'] });
  assert.equal(result.evidenceStatus, 'target_matched');
  assert.equal(result.targetCheck.relevantSourceCount, 1);
  assert.deepEqual(result.sources[0].matchedTargetTerms, ['ピコパーク']);
  assert.equal(result.factVerification, 'not_performed');
});

test('a URL or fallback URL title cannot establish the subject of a source', () => {
  const result = annotateMaidSearchResult({
    ok: true,
    results: [{ title: 'https://store.steampowered.com/app/PICO_PARK', url: 'https://store.steampowered.com/app/PICO_PARK',
      snippet: 'Visit https://store.steampowered.com/app/PICO_PARK for details.' }],
  }, { target: 'PICO PARK' });
  assert.equal(result.evidenceStatus, 'no_relevant_sources');
  assert.equal(result.results[0].targetRelevant, false);
  const unchecked = annotateMaidSearchResult(result);
  assert.equal(unchecked.evidenceStatus, 'target_not_checked', 'A prior target verdict must not survive a different unchecked request');
});

test('provider failure remains failure while both tools state that no facts were verified', async () => {
  const failedTools = createWebSearchAgentTools({
    getSearchConfig: () => ({ webSearchProvider: 'brave', apiKey: 'fixture-key' }),
    httpRequest: () => { throw new Error('Network unavailable'); },
  });
  for (const name of ['web.search', 'web.research']) {
    const result = await failedTools.find(tool => tool.name === name).execute({ query: 'PICO PARK price', target: 'PICO PARK' });
    assert.equal(result.ok, false);
    assert.equal(result.message, 'Network unavailable');
    assert.equal(result.evidenceStatus, 'no_relevant_sources');
    assert.equal(result.factVerification, 'not_performed');
    assert.equal(result.targetCheck.relevantSourceCount, 0);
  }
});
