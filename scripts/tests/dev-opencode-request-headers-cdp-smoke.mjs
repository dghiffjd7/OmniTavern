// Windows Tauri -> real native HTTP -> loopback fixture. No provider key or user chat writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
const received = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  received.push({ path: req.url, headers: req.headers, body });
  const responses = req.url.endsWith('/responses');
  const complete = responses
    ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
    : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(responses
      ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: complete })}\n\n`
      : `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'glm-5.3' }] } : complete));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
try {
  const result = await evaluateInApp(`(async () => {
    const { LLMClient } = await import('/scripts/api/client.js');
    const { captureRequestContext } = await import('/scripts/api/request-context.js');
    const { createInputSuggestionRequest } = await import('/scripts/ui/chat/input-suggestion-runtime.js');
    const { createProviderToolLlmClientNativeRunner } = await import('/scripts/agent/provider-tool-llmclient-native-runner.js');
    const { attachProviderToolContinuationContext } = await import('/scripts/agent/provider-tool-continuation-context.js');
    const check = (ok, label) => { if (!ok) throw new Error(label); };
    check(window.appBridge?.initialized, 'App is not ready');
    const originalProvider = window.appBridge.client?.provider;
    const originalSession = window.appBridge.getActiveSessionId();
    const originalProfile = window.appBridge.getActiveConfigProfileId();
    const config = { provider: 'opencode', baseUrl: ${JSON.stringify(baseUrl)}, apiKey: 'loopback-fixture', model: 'glm-5.3' };
    const messages = [{ role: 'user', content: 'loopback fixture' }];
    const a = captureRequestContext({ scopeId: 'opencode-smoke', sessionId: 'fixture-a', archiveId: 'archive-a' });
    const b = captureRequestContext({ scopeId: 'opencode-smoke', sessionId: 'fixture-b', archiveId: 'archive-a' });
    const collect = async stream => { let out = ''; for await (const chunk of stream) if (typeof chunk === 'string') out += chunk; return out; };
    // Inherit the real background-chat method, replacing only fixture dependencies.
    const bridge = Object.create(Object.getPrototypeOf(window.appBridge));
    bridge.initialized = true;
    check(bridge.backgroundChat === Object.getPrototypeOf(window.appBridge).backgroundChat, 'fixture must use the unbound prototype method');
    bridge.scopeId = a.scopeId; bridge.activeSessionId = a.sessionId;
    bridge.chatStore = { getCurrentArchiveId: () => a.archiveId };
    bridge.config = { get: () => config };
    bridge.getGenerationOptions = () => ({ max_tokens: 8 });
    bridge.normalizeOutgoingProviderMessages = value => value;
    bridge.resolveRequestRuntimeConfig = async () => {
      bridge.activeSessionId = b.sessionId;
      await Promise.resolve();
      return { config, client: new LLMClient(config) };
    };
    check(await bridge.backgroundChat(messages, { presetContext: { sessionId: a.sessionId } }) === 'ok', 'background result');
    const client = new LLMClient(config);
    check(await collect(client.streamChat(messages, { requestContext: a })) === 'ok', 'Chat Completions stream');
    check(await client.chat(messages, { requestContext: b }) === 'ok', 'second conversation');
    const responsesConfig = { ...config, apiFormat: 'responses' };
    const responses = new LLMClient(responsesConfig);
    check(await responses.chat(messages, { requestContext: a }) === 'ok', 'Responses result');
    check(await collect(responses.streamChat(messages, { requestContext: a })) === 'ok', 'Responses stream');
    const proxy = new LLMClient({ ...responsesConfig, provider: 'custom', baseUrl: 'https://opencode.ai/zen/go/v1',
      connectionMode: 'reverse_proxy', proxyBaseUrl: ${JSON.stringify(baseUrl)}, proxyAuthHeaderName: 'X-Fixture-Proxy', proxyAuthToken: 'fixture-proxy' });
    check(await proxy.chat(messages, { requestContext: a }) === 'ok', 'custom proxy result');
    const continuation = attachProviderToolContinuationContext({ provider: 'openai', sourceProvider: 'opencode', sessionId: a.sessionId,
      format: 'openai_responses_function_call_output', input: [{ type: 'function_call_output', call_id: 'fixture-call', output: 'ok' }] },
      { historyMessages: messages, providerRequestOptions: { requestContext: a } });
    const runner = createProviderToolLlmClientNativeRunner({ llmClient: responses });
    check((await runner.runProviderToolRequest(continuation)).finalText === 'ok', 'native tool continuation');
    const suggest = createInputSuggestionRequest({ getProfileConfig: async () => responsesConfig, createClient: cfg => new LLMClient(cfg) });
    check(await suggest({ settings: { modelMode: 'profile', modelProfileId: 'fixture' }, before: 'hello', after: '', requestContext: a }, new AbortController().signal) === 'ok', 'input suggestion');
    const standalone = new LLMClient(config);
    check((await standalone.listModels()).includes('glm-5.3'), 'catalog');
    check((await standalone.healthCheck()).ok, 'connection check');
    check(window.appBridge.client?.provider === originalProvider && window.appBridge.getActiveSessionId() === originalSession
      && window.appBridge.getActiveConfigProfileId() === originalProfile, 'user state changed');
    return { ready: true, ordinary: true, streams: true, continuation: true, suggestions: true, userStatePreserved: true };
  })()`, { timeoutMs: 30000 });
  assert.equal(received.length, 10);
  const id = received[0].headers['x-opencode-session'];
  assert.match(id, /^ot_[a-f0-9]{32}$/);
  for (const [index, req] of received.entries()) {
    assert.equal(req.headers['user-agent'], `OmniTavern/${version}`, `native User-Agent ${index}`);
    assert.match(req.headers['x-opencode-session'], /^ot_[a-f0-9]{32}$/);
    assert.equal(req.headers.authorization, 'Bearer loopback-fixture');
    for (const key of ['requestContext', 'scopeId', 'sessionId', 'archiveId', 'captured']) assert.equal(key in req.body, false, key);
  }
  for (const index of [1, 3, 4, 5, 6, 7]) assert.equal(received[index].headers['x-opencode-session'], id, `same conversation ${index}`);
  assert.notEqual(received[2].headers['x-opencode-session'], id);
  assert.notEqual(received[8].headers['x-opencode-session'], id);
  assert.equal(received[8].headers['x-opencode-session'], received[9].headers['x-opencode-session']);
  assert.equal(received[5].headers['x-fixture-proxy'], 'fixture-proxy');
  assert.equal(received[6].body.input.at(-1).call_id, 'fixture-call');
  assert.equal(received[7].body.max_output_tokens, 96);
  console.log(JSON.stringify({ ...result, nativeUserAgent: `OmniTavern/${version}`, fixtureRequests: received.length, externalRequests: 0 }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
