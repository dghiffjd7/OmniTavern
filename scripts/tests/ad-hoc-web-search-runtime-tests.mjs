import assert from 'node:assert/strict';

import {
  AD_HOC_WEB_SEARCH_NOTICE_KEY,
  buildAdHocWebSearchRuntime,
  confirmAdHocWebSearchToggle,
  consumeAdHocWebSearchToggle,
  createAdHocWebSearchToggleRuntime,
  describeAdHocModel,
  renderAdHocWebSources,
  runAdHocWebSearchChat,
} from '../../src/scripts/ui/chat/ad-hoc-web-search-runtime.js';

const client = { chat: async () => 'plain' };
const definitions = Object.fromEntries(['web.search', 'web.research', 'web.fetch_url'].map(name => [name, {
  name,
  description: name,
  schema: { type: 'object', additionalProperties: false },
}]));
const toolRuntime = {
  getTool: name => definitions[name] || null,
  executeTool: async () => ({ status: 'succeeded', result: { ok: true } }),
};

{
  const built = buildAdHocWebSearchRuntime({
    client,
    config: { provider: 'deepseek', model: 'deepseek-chat' },
    enabled: false,
    requestOptions: { temperature: 0.6 },
    toolRuntime,
  });
  assert.equal(built.client, client);
  assert.deepEqual(built.requestOptions, { temperature: 0.6 });
  assert.equal(built.plan.enabled, false);
}

{
  const toggle = { checked: true };
  let resolveConfirmation;
  let confirms = 0;
  const toggleRuntime = createAdHocWebSearchToggleRuntime({
    toggleEl: toggle,
    storage: { getItem: () => null, setItem() {} },
    confirm: () => {
      confirms += 1;
      return new Promise(resolve => { resolveConfirmation = resolve; });
    },
  });
  const first = toggleRuntime.confirmEnabled();
  const consumed = toggleRuntime.consume();
  assert.equal(confirms, 1);
  resolveConfirmation(true);
  assert.equal(await first, true);
  assert.equal(await consumed, true);
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggleRuntime.reset();
  assert.equal(toggle.checked, false);
}

{
  const statuses = [];
  const sourceSnapshots = [];
  const built = buildAdHocWebSearchRuntime({
    client,
    config: { provider: 'openrouter', model: 'openai/gpt-5' },
    enabled: true,
    requestOptions: { temperature: 0.4 },
    toolRuntime: null,
    onStatus: status => statuses.push(status),
    onSources: sources => sourceSnapshots.push(sources),
  });
  assert.equal(built.client, client);
  assert.equal(built.requestOptions.temperature, 0.4);
  assert.equal(built.requestOptions.tools[0].type, 'openrouter:web_search');
  built.requestOptions.onProviderSources([
    { url: 'https://example.com/a#part', title: 'A' },
    { url: 'javascript:alert(1)', title: 'bad' },
  ]);
  assert.deepEqual(sourceSnapshots.at(-1), [{ url: 'https://example.com/a', title: 'A' }]);
  assert.deepEqual(statuses.map(item => item.state), ['ready', 'done']);
}

{
  const built = buildAdHocWebSearchRuntime({
    client,
    config: { provider: 'deepseek', model: 'deepseek-chat' },
    enabled: true,
    requestOptions: { temperature: 0.2 },
    toolRuntime,
  });
  assert.notEqual(built.client, client);
  assert.equal(built.plan.fallback, true);
  assert.equal(built.requestOptions.temperature, 0.2);
  assert.equal(built.requestOptions.tool_choice, 'auto');
  assert.deepEqual(built.requestOptions.tools.map(item => item.function.name), [
    'web_search',
    'web_research',
    'web_fetch',
  ]);
}

{
  const statuses = [];
  const built = buildAdHocWebSearchRuntime({
    client,
    config: { provider: 'deepseek', model: 'deepseek-chat' },
    enabled: true,
    requestOptions: { temperature: 0.1 },
    toolRuntime: null,
    onStatus: status => statuses.push(status),
  });
  assert.equal(built.client, client);
  assert.deepEqual(built.requestOptions, { temperature: 0.1 });
  assert.equal(built.plan.enabled, false);
  assert.equal(statuses[0].state, 'unavailable');
}

{
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const toggle = { checked: true };
  let confirms = 0;
  assert.equal(await confirmAdHocWebSearchToggle({
    toggleEl: toggle,
    storage,
    confirm: async () => { confirms += 1; return true; },
  }), true);
  assert.equal(values.get(AD_HOC_WEB_SEARCH_NOTICE_KEY), '1');
  assert.equal(await confirmAdHocWebSearchToggle({
    toggleEl: toggle,
    storage,
    confirm: async () => { confirms += 1; return true; },
  }), true);
  assert.equal(confirms, 1);
  assert.equal(consumeAdHocWebSearchToggle(toggle), true);
  assert.equal(toggle.checked, false);
  assert.equal(consumeAdHocWebSearchToggle(toggle), false);

  const cancelledToggle = { checked: true };
  assert.equal(await confirmAdHocWebSearchToggle({
    toggleEl: cancelledToggle,
    storage: { getItem: () => null, setItem() {} },
    confirm: async () => false,
  }), false);
  assert.equal(cancelledToggle.checked, false);
}

{
  const children = [];
  const container = {
    hidden: false,
    replaceChildren: () => { children.length = 0; },
    appendChild: child => children.push(child),
  };
  const documentRef = {
    createElement: tagName => ({ tagName, className: '', textContent: '', href: '', target: '', rel: '', title: '' }),
  };
  const sources = renderAdHocWebSources(container, [
    { url: 'https://safe.example/doc', title: '<img src=x>' },
    { url: 'data:text/html,bad', title: 'bad' },
  ], { documentRef });
  assert.equal(sources.length, 1);
  assert.equal(children[1].textContent, '<img src=x>');
  assert.equal(children[1].href, 'https://safe.example/doc');
  assert.equal(children[1].rel, 'noopener noreferrer');
}

console.log('ok - ad-hoc web search is one-shot, provider-aware, and renders safe sources');

// 原生联网失败的回退：先改用 APP 搜索服务，再不行就不联网生成；鉴权错误与中止不重试
{
  const openrouter = { provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro' };
  const makeClient = (results) => {
    const calls = [];
    return {
      calls,
      chat: async (messages, options = {}) => {
        const tools = (options.tools || []).map(tool => tool.type === 'function' ? `fn:${tool.function?.name}` : tool.type);
        calls.push(tools);
        const next = results.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'function') return next(options);
        return next;
      },
    };
  };
  const failure = (message, status = 0) => Object.assign(new Error(message), status ? { status } : {});

  const callSearch = options => {
    options.onProviderToolCallDelta?.({ choices: [{ message: { tool_calls: [{
      id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' },
    }] }, finish_reason: 'tool_calls' }] }, { provider: 'openrouter', model: openrouter.model });
    return '';
  };
  const viaTools = makeClient([failure('provider error 500', 500), callSearch, 'from tools']);
  const statuses = [];
  const toolResult = await runAdHocWebSearchChat({
    client: viaTools, config: openrouter, enabled: true, messages: [{ role: 'user', content: 'x' }],
    requestOptions: { temperature: 0.6 }, toolRuntime, onStatus: status => statuses.push(status),
  });
  assert.deepEqual({ ...toolResult, reason: undefined }, { output: 'from tools', route: 'tool', degraded: true, reason: undefined });
  assert.ok(viaTools.calls[0].includes('openrouter:web_search'), 'first attempt uses native search');
  assert.ok(viaTools.calls[1].some(name => name.startsWith('fn:')) && !viaTools.calls[1].includes('openrouter:web_search'), 'retry uses app search tools');
  assert.match(statuses.find(item => item.state === 'fallback').message, /改用搜索服务/);

  const noTools = makeClient([failure('rate limited', 429), 'plain']);
  const plainResult = await runAdHocWebSearchChat({
    client: noTools, config: openrouter, enabled: true, messages: [], toolRuntime: null,
  });
  assert.deepEqual({ ...plainResult, reason: undefined }, { output: 'plain', route: 'none', degraded: true, reason: undefined });
  assert.deepEqual(noTools.calls[1], [], 'last resort sends no search tools');

  const bothFail = makeClient([failure('native down', 502), failure('search down', 503), 'plain again']);
  const lastResort = await runAdHocWebSearchChat({ client: bothFail, config: openrouter, enabled: true, messages: [], toolRuntime });
  assert.equal(lastResort.route, 'none');
  assert.equal(bothFail.calls.length, 3);

  const unauthorized = makeClient([failure('Unauthorized', 401), 'never']);
  await assert.rejects(runAdHocWebSearchChat({ client: unauthorized, config: openrouter, enabled: true, messages: [], toolRuntime }), /Unauthorized/);
  assert.equal(unauthorized.calls.length, 1, 'auth errors are not retried');

  const aborted = makeClient([Object.assign(new Error('aborted'), { name: 'AbortError' }), 'never']);
  await assert.rejects(runAdHocWebSearchChat({ client: aborted, config: openrouter, enabled: true, messages: [], toolRuntime }), /aborted/);
  assert.equal(aborted.calls.length, 1);

  const offline = makeClient(['plain only']);
  const offlineResult = await runAdHocWebSearchChat({ client: offline, config: openrouter, enabled: false, messages: [] });
  assert.deepEqual([offlineResult.output, offlineResult.route, offlineResult.degraded], ['plain only', 'none', false]);
  assert.equal(typeof toolResult.reason, 'string', 'first-plan diagnostics reason is carried for callers');
  assert.equal(describeAdHocModel({ provider: 'vertexai', model: 'gemini-3.8-flash' }), 'vertexai · gemini-3.8-flash');
  console.log('ok - ad hoc web search falls back from native search to the search service, then to plain generation');

  const stale = [{ url: 'https://stale.example/', title: 'failed native response' }];
  const fresh = [{ url: 'https://fresh.example/', title: 'successful search' }];
  const nativeFailsAfterSources = options => {
    options.onProviderSources(stale);
    throw failure('empty native response', 502);
  };
  for (const output of [
    { status: 'failed', result: { ok: false, reason: 'service down', results: stale } },
    { status: 'succeeded', result: { ok: false, reason: 'service down', results: stale } },
    { status: 'succeeded', result: { ok: true, results: [] } },
    { status: 'succeeded', result: { ok: true, results: fresh } },
  ]) {
    const sourceReports = [];
    const providerReports = [];
    const receiptStatuses = [];
    const succeeded = output.result.ok;
    const receiptClient = makeClient([nativeFailsAfterSources, callSearch, 'answer after tool receipt']);
    const result = await runAdHocWebSearchChat({
      client: receiptClient, config: openrouter, enabled: true, messages: [],
      toolRuntime: { ...toolRuntime, executeTool: async () => output },
      requestOptions: { onProviderSources: sources => providerReports.push(sources) },
      onSources: sources => sourceReports.push(sources), onStatus: status => receiptStatuses.push(status),
    });
    assert.equal(result.route, succeeded ? 'tool' : 'none', 'route is based on tool evidence, including successful zero hits');
    assert.equal(result.degraded, true);
    assert.equal(receiptClient.calls.length, 3, 'use the answer based on the receipt without another model retry');
    assert.equal(sourceReports.length, 1, 'publish only the completed attempt');
    assert.equal(providerReports.length, 1, 'the original callback also sees only committed sources');
    const expectedUrls = succeeded ? output.result.results.map(item => item.url) : [];
    assert.deepEqual(sourceReports[0].map(item => item.url), expectedUrls);
    assert.deepEqual(providerReports[0].map(item => item.url), expectedUrls);
    if (!succeeded) assert.equal(receiptStatuses.at(-1).state, 'failed', 'failed receipts cannot end with search done');
  }

  const offlineSources = [];
  const fromFailedNative = await runAdHocWebSearchChat({
    client: makeClient([nativeFailsAfterSources, 'offline answer']), config: openrouter, enabled: true,
    toolRuntime: null, onSources: sources => offlineSources.push(sources),
  });
  assert.equal(fromFailedNative.route, 'none');
  assert.deepEqual(offlineSources, [[]]);

  const unusedSearch = await runAdHocWebSearchChat({
    client: makeClient(['answer without calling tools']), config: { provider: 'deepseek', model: 'deepseek-chat' },
    enabled: true, toolRuntime,
  });
  assert.equal(unusedSearch.route, 'none', 'exposing tools is not proof that search ran');
  console.log('ok - search receipts and final-attempt sources determine actual web use');
}
