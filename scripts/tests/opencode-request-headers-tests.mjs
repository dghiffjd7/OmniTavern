import assert from 'node:assert/strict';
import { LLMClient } from '../../src/scripts/api/client.js';
import { prepareTransportRequest } from '../../src/scripts/api/transport.js';
import { captureRequestContext, setRequestContextResolver } from '../../src/scripts/api/request-context.js';
import { buildOpenCodeRequestHeaders } from '../../src/scripts/api/opencode-request-headers.js';
import { createInputSuggestionRequest } from '../../src/scripts/ui/chat/input-suggestion-runtime.js';
import { buildAdHocWebSearchRuntime } from '../../src/scripts/ui/chat/ad-hoc-web-search-runtime.js';
import { createProviderToolLlmClientNativeRunner } from '../../src/scripts/agent/provider-tool-llmclient-native-runner.js';
import { attachProviderToolContinuationContext } from '../../src/scripts/agent/provider-tool-continuation-context.js';
import { createMaidRuntimeConfigResolver } from '../../src/scripts/agent/maid-runtime-config.js';
import { runProviderToolRealRunnerAdapter } from '../../src/scripts/agent/provider-tool-real-runner-adapter.js';
import { buildPromptOverviewView } from '../../src/scripts/ui/chat/prompt-preview-view-utils.js';
import { renderAgentRequestPreview } from '../../src/scripts/ui/chat/agent-request-preview.js';

const tests = [], test = (name, run) => tests.push({ name, run });
const config = { provider: 'opencode', apiKey: 'fixture-key', model: 'glm-5.3' };
const messages = [{ role: 'user', content: 'fixture' }];
const a = captureRequestContext({ scopeId: 'persona-a', sessionId: 'chat-a', archiveId: 'archive-a' });
const b = captureRequestContext({ scopeId: 'persona-a', sessionId: 'chat-b', archiveId: 'archive-a' });
const bodyFor = url => url.endsWith('/responses')
  ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
  : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
const streamFor = url => url.endsWith('/responses')
  ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: bodyFor(url) })}\n\n`
  : `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const collect = async stream => { let out = ''; for await (const part of stream) if (typeof part === 'string') out += part; return out; };
const sessionHeader = request => request.headers['x-opencode-session'];
const assertWire = request => {
  assert.match(sessionHeader(request), /^ot_[a-f0-9]{32}$/);
  assert.equal(request.headers['User-Agent'], 'OmniTavern');
  const body = JSON.parse(request.body || '{}');
  for (const key of ['requestContext', 'scopeId', 'sessionId', 'archiveId', 'captured']) assert.equal(key in body, false, key);
};
const installNative = requests => {
  const streams = new Map();
  globalThis.__TAURI__ = { core: { invoke: async (command, args) => {
    if (command === 'http_request') {
      requests.push(args);
      return { status: 200, ok: true, body: JSON.stringify(args.url.endsWith('/models') ? { data: [{ id: 'glm-5.3' }] } : bodyFor(args.url)) };
    }
    if (command === 'http_stream_request_start') { requests.push(args); streams.set(args.requestId, args); return true; }
    if (command === 'http_stream_request_read') return { status: 200, ok: true, chunks: [streamFor(streams.get(args.requestId).url)], done: true };
    if (['http_stream_request_close', 'http_abort_request'].includes(command)) return true;
    assert.fail(`unexpected native command ${command}`);
  } } };
};

test('routing identities survive client recreation and isolate conversations, personas and archives', () => {
  const header = context => buildOpenCodeRequestHeaders({ config: { ...config, requestContext: context } })['x-opencode-session'];
  assert.equal(header(a), header({ ...a }));
  assert.notEqual(header(a), header(b));
  assert.notEqual(header(a), header({ ...a, scopeId: 'persona-b' }));
  assert.notEqual(header(a), header({ ...a, archiveId: 'archive-b' }));
  assert.doesNotMatch(header(a), /persona|chat|archive/);
  let scope = 'before', archive = 'old';
  setRequestContextResolver(source => ({ ...source, scopeId: scope, archiveId: archive }));
  const captured = captureRequestContext({ sessionId: 'original' });
  scope = 'after'; archive = 'new';
  assert.equal(captureRequestContext(captured), captured);
  assert.equal(captured.scopeId, 'before');
  assert.equal(captured.archiveId, 'old');
  const restored = captureRequestContext(JSON.parse(JSON.stringify(captured)));
  assert.equal(restored.scopeId, 'before');
  assert.equal(restored.archiveId, 'old');
  assert.ok(Object.isFrozen(restored));
  assert.notEqual(header(captured), header(captureRequestContext({ sessionId: 'original' })));
  setRequestContextResolver(null);
});

test('official custom endpoints and reverse proxies preserve headers; unrelated hosts remain isolated', () => {
  const original = { Authorization: 'Bearer fixture', 'user-agent': 'old', 'X-OpenCode-Session': 'old' };
  const routed = prepareTransportRequest({ config: { ...config, requestContext: a, connectionMode: 'reverse_proxy', proxyBaseUrl: 'https://proxy.example', proxyAuthHeaderName: 'X-Proxy-Auth', proxyAuthToken: 'proxy-fixture' }, url: 'https://opencode.ai/zen/go/v1/responses', headers: original });
  assert.equal(routed.url, 'https://proxy.example/zen/go/v1/responses');
  assert.equal(routed.headers.Authorization, 'Bearer fixture');
  assert.equal(routed.headers['X-Proxy-Auth'], 'proxy-fixture');
  assert.equal(routed.headers['user-agent'], undefined);
  assert.equal(routed.headers['X-OpenCode-Session'], undefined);
  assert.equal(original['user-agent'], 'old');
  for (const url of ['https://opencode.ai/zen/v1/chat/completions', 'https://opencode.ai/zen/go/v1/responses']) {
    const custom = prepareTransportRequest({ config: { provider: 'custom', requestContext: a }, url });
    assert.equal(sessionHeader(custom), sessionHeader(routed));
  }
  for (const url of ['https://api.openai.com/v1/responses', 'https://opencode.ai.evil.example/v1', 'https://opencode.ai@unrelated.example/v1', 'https://unrelated.example/opencode.ai']) {
    const untouched = prepareTransportRequest({ config: { provider: 'custom', requestContext: a }, url, headers: { Authorization: 'fixture' } });
    assert.deepEqual(untouched.headers, { Authorization: 'fixture' });
  }
});

test('native ordinary/streaming Chat Completions and Responses reuse context without mutating a shared client', async () => {
  const requests = []; installNative(requests);
  for (const apiFormat of ['chat_completions', 'responses']) {
    const client = new LLMClient({ ...config, apiFormat });
    assert.equal(await client.chat(messages, { requestContext: a, requestId: 'one' }), 'ok');
    assert.equal(await collect(client.streamChat(messages, { requestContext: a, requestId: 'two' })), 'ok');
    await Promise.all([client.chat(messages, { requestContext: b }), client.chat(messages, { requestContext: a })]);
    const [first, stream, secondChat, originalChat] = requests.slice(-4);
    for (const req of [first, stream, secondChat, originalChat]) assertWire(req);
    assert.equal(sessionHeader(first), sessionHeader(stream));
    assert.equal(sessionHeader(first), sessionHeader(originalChat));
    assert.notEqual(sessionHeader(first), sessionHeader(secondChat));
    assert.equal(client.provider.transportConfig.requestContext, undefined);
    await new LLMClient({ ...config, apiFormat, model: 'another-model' }).chat(messages, { requestContext: a });
    assert.equal(sessionHeader(requests.at(-1)), sessionHeader(first));
  }
  const custom = new LLMClient({ ...config, provider: 'custom', baseUrl: 'https://opencode.ai/zen/v1', apiFormat: 'responses' });
  await custom.chat(messages, { requestContext: a });
  assertWire(requests.at(-1));
  assert.equal(sessionHeader(requests[0]), sessionHeader(requests.at(-1)));
});

test('fetch transport uses the same headers and standalone catalog/health checks have isolated IDs', async () => {
  delete globalThis.__TAURI__;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    const stream = JSON.parse(options.body || '{}').stream;
    return new Response(stream ? streamFor(url) : JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'glm-5.3' }] } : bodyFor(url)), { status: 200 });
  };
  for (const apiFormat of ['chat_completions', 'responses']) {
    const client = new LLMClient({ ...config, apiFormat });
    assert.equal(await client.chat(messages, { requestContext: a }), 'ok');
    assert.equal(await collect(client.streamChat(messages, { requestContext: a })), 'ok');
    for (const req of requests.slice(-2)) assertWire(req);
  }
  const check = new LLMClient(config);
  await check.listModels();
  assert.equal((await check.healthCheck()).ok, true);
  assert.equal(sessionHeader(requests.at(-1)), sessionHeader(requests.at(-2)));
  assert.notEqual(sessionHeader(requests[0]), sessionHeader(requests.at(-1)));
  await new LLMClient(config).healthCheck();
  assert.notEqual(sessionHeader(requests.at(-1)), sessionHeader(requests.at(-2)));
});

test('stream compatibility retry preserves the conversation header', async () => {
  delete globalThis.__TAURI__;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return requests.length === 1
      ? new Response(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }), { status: 400 })
      : new Response(streamFor(url), { status: 200 });
  };
  const client = new LLMClient({ ...config, baseUrl: 'https://opencode-retry.example/v1' });
  assert.equal(await collect(client.streamChat(messages, { requestContext: a })), 'ok');
  assert.equal(requests.length, 2);
  assert.equal(sessionHeader(requests[0]), sessionHeader(requests[1]));
  assert.ok(JSON.parse(requests[0].body).stream_options);
  assert.equal(JSON.parse(requests[1].body).stream_options, undefined);
});

test('input suggestions, web requests and Responses tool continuation retain their originating context', async () => {
  const requests = []; installNative(requests);
  const cfg = { ...config, apiFormat: 'responses' };
  const suggestion = createInputSuggestionRequest({ getProfileConfig: async () => cfg, createClient: value => new LLMClient(value) });
  assert.equal(await suggestion({ settings: { modelMode: 'profile', modelProfileId: 'fixture' }, before: 'hello', after: '', requestContext: a }, new AbortController().signal), 'ok');
  const expected = sessionHeader(requests.at(-1));
  assert.equal(JSON.parse(requests.at(-1).body).max_output_tokens, 96);
  const adHoc = buildAdHocWebSearchRuntime({ client: new LLMClient(cfg), config: cfg, sessionId: a.sessionId, requestOptions: { requestContext: a } });
  await adHoc.client.chat(messages, adHoc.requestOptions);
  const client = new LLMClient(cfg);
  const runner = createProviderToolLlmClientNativeRunner({ llmClient: client });
  const continuation = attachProviderToolContinuationContext({ provider: 'openai', sourceProvider: 'opencode', sessionId: a.sessionId, format: 'openai_responses_function_call_output', input: [{ type: 'function_call_output', call_id: 'call_fixture', output: 'result' }] }, { historyMessages: messages, providerRequestOptions: { requestContext: a } });
  setRequestContextResolver(source => ({ ...source, scopeId: 'switched-persona', archiveId: 'switched-archive' }));
  assert.equal((await runner.runProviderToolRequest(continuation, { requestContext: b })).finalText, 'ok');
  const ccRequest = attachProviderToolContinuationContext({ provider: 'openai', sessionId: a.sessionId,
    format: 'openai_chat_completions_tool_result', messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_cc', type: 'function', function: { name: 'fixture', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_cc', content: 'result' },
    ] }, { historyMessages: messages, providerRequestOptions: { requestContext: a } });
  const resumed = await runProviderToolRealRunnerAdapter({ enabled: true, allowNetwork: true,
    runnerRequestDraft: { ok: true, status: 'ready', output: 'provider_stream_events', provider: 'openai',
      model: config.model, sessionId: a.sessionId, requestPreviewFormat: ccRequest.format, payloadKind: 'messages', request: ccRequest },
    providerClient: new LLMClient(config), requestOptions: { requestContext: b },
  });
  assert.equal(resumed.finalText, 'ok');
  setRequestContextResolver(null);
  for (const req of requests) { assertWire(req); assert.equal(sessionHeader(req), expected); }
  assert.equal(JSON.parse(requests.at(-2).body).input.at(-1).call_id, 'call_fixture');
});

test('routing salt survives reload, optional configs work, and internal context stays out of parameter previews', async () => {
  const first = buildOpenCodeRequestHeaders({ config: { ...config, requestContext: a } });
  const fresh = await import('../../src/scripts/api/opencode-request-headers.js?fresh-module');
  assert.equal(fresh.buildOpenCodeRequestHeaders({ config: { ...config, requestContext: a } })['x-opencode-session'], first['x-opencode-session']);
  assert.match(buildOpenCodeRequestHeaders({ config: null, url: 'https://opencode.ai/zen/v1/models' })['x-opencode-session'], /^ot_[a-f0-9]{32}$/);
  const request = { messages, options: { temperature: 0.4, requestContext: a } };
  for (const html of [buildPromptOverviewView(request).html, renderAgentRequestPreview(request)]) {
    assert.doesNotMatch(String(html), /requestContext|persona-a|archive-a/);
    assert.match(String(html), /temperature/);
  }
});

test('maid primary and fallback clients retain the captured context while config loads', async () => {
  const requests = []; installNative(requests);
  let scope = 'before';
  setRequestContextResolver(source => ({ ...source, scopeId: scope, archiveId: '' }));
  const resolve = createMaidRuntimeConfigResolver({
    settingsStore: { getBoundProfileId: () => 'main', getFallbackProfileId: () => 'fallback' },
    configManager: { ensureStores: async () => { scope = 'after'; }, getRuntimeConfigByProfileId: async () => config },
    createClient: value => new LLMClient(value), isConfigReady: () => true,
  });
  const runtime = await resolve({ sessionId: 'origin' });
  await runtime.client.chat(messages);
  await runtime.fallbackClient.chat(messages);
  const expected = buildOpenCodeRequestHeaders({ config: { ...config, requestContext: { scopeId: 'before', sessionId: 'origin', archiveId: '' } } })['x-opencode-session'];
  for (const req of requests) { assertWire(req); assert.equal(sessionHeader(req), expected); }
  setRequestContextResolver(null);
});

const saved = { fetch: globalThis.fetch, tauri: globalThis.__TAURI__, storage: globalThis.localStorage };
const local = new Map();
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
try {
  const filter = process.argv.find(arg => arg.startsWith('--match='))?.slice(8);
  for (const { name, run } of tests.filter(item => !filter || item.name.includes(filter))) {
    await run(); console.log(`ok - ${name}`);
  }
} finally {
  setRequestContextResolver(null);
  globalThis.fetch = saved.fetch;
  if (saved.tauri === undefined) delete globalThis.__TAURI__; else globalThis.__TAURI__ = saved.tauri;
  if (saved.storage === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.storage;
}
