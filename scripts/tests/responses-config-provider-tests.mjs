import assert from 'node:assert/strict';
import { LLMClient } from '../../src/scripts/api/client.js';
import { CustomProvider } from '../../src/scripts/api/providers/custom.js';
import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';
import { buildOpenAICompatibleEndpoint, normalizeOpenAIApiFormat } from '../../src/scripts/api/openai-api-format.js';
import { buildOpenAIResponsesRequestBody } from '../../src/scripts/api/providers/openai-responses-utils.js';
import { createProviderToolCallDeltaAccumulator } from '../../src/scripts/agent/provider-tool-call-delta-adapter.js';
import { createProviderToolLlmClientNativeRunner } from '../../src/scripts/agent/provider-tool-llmclient-native-runner.js';
import { attachProviderToolContinuationContext } from '../../src/scripts/agent/provider-tool-continuation-context.js';
import { buildProviderToolRequestSchema } from '../../src/scripts/agent/provider-tool-request-schema.js';
import { resolveProviderFcTransport } from '../../src/scripts/agent/provider-fc-transport.js';
import { createInputSuggestionRequest } from '../../src/scripts/ui/chat/input-suggestion-runtime.js';
import { createWebSearchGenerationClient } from '../../src/scripts/ui/chat/web-search-generation-client.js';
import { renderAgentRequestPreview } from '../../src/scripts/ui/chat/agent-request-preview.js';
import { buildPromptOverviewView } from '../../src/scripts/ui/chat/prompt-preview-view-utils.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
const config = { provider: 'custom', apiFormat: 'responses', baseUrl: 'https://gateway.example/prefix/v1/', model: 'muse-spark', apiKey: 'fixture-key' };
const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello' }];
const outputMessage = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const completed = (text = '你好') => ({ id: 'resp_fixture', status: 'completed', output: [outputMessage(text)], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
const streamEvents = () => [
  { type: 'response.created', response: { id: 'resp_fixture', output: [] } },
  { type: 'response.reasoning_summary_text.delta', delta: '思考' },
  { type: 'response.output_text.delta', delta: '你' },
  { type: 'response.output_text.delta', delta: '好' },
  { type: 'response.completed', response: completed() },
];
const sse = events => events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
const streamResponse = events => {
  const bytes = new TextEncoder().encode(sse(events));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
};
const collect = async generator => { const chunks = []; for await (const chunk of generator) chunks.push(chunk); return chunks; };

test('profile migration, persistence, copying and runtime selection retain wire format', async () => {
  const local = new Map();
  local.set('log_level', 'ERROR');
  globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) };
  const { ConfigManager } = await import('../../src/scripts/storage/config.js');
  const scope = `responses_${Date.now()}`;
  const manager = new ConfigManager({ scope });
  await manager.ensureStores();
  await manager.createProfile('旧配置', { ...config, apiFormat: undefined, apiKey: undefined });
  assert.equal(manager.get().apiFormat, 'chat_completions');
  const legacyId = manager.getActiveProfileId();
  await manager.createProfile('Responses', { ...config, apiKey: undefined });
  await manager.save({ ...config, apiKey: null });
  const responsesId = manager.getActiveProfileId();
  assert.equal(manager.get().apiFormat, 'responses');
  const exported = JSON.parse(JSON.stringify(manager.getActiveProfile()));
  const reload = new ConfigManager({ scope });
  assert.equal((await reload.load()).apiFormat, 'responses');
  await reload.setActiveProfile(legacyId);
  assert.equal(reload.get().apiFormat, 'chat_completions');
  await reload.setActiveProfile(responsesId);
  assert.equal(reload.get().apiFormat, 'responses');
  await reload.createProfile('Copy', { ...exported, id: undefined });
  assert.equal(reload.get().apiFormat, 'responses');
  assert.equal(normalizeOpenAIApiFormat('unknown'), 'chat_completions');
});

test('Responses input covers multimodal text, function results and native reasoning items', () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-fixture' };
  const body = buildOpenAIResponsesRequestBody({ model: config.model, messages: [
    ...messages,
    { role: 'user', content: [{ type: 'text', text: '图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'low' } }] },
    reasoning,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ], options: { maxTokens: 96, reasoning_effort: 'low', tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { id: { type: 'number' } } } } }], tool_choice: { type: 'function', function: { name: 'lookup' } }, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: false } }, stop: ['x'], presence_penalty: 1, signal: new AbortController().signal } });
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 96);
  assert.equal(body.input[2].content[1].type, 'input_image');
  assert.deepEqual(body.input[3], reasoning);
  assert.equal(body.input[4].type, 'function_call');
  assert.equal(body.input[5].call_id, 'call_1');
  assert.equal(body.input[5].output, 'result');
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(body.tools[0].strict, false, 'optional Chat schema fields must stay optional');
  assert.equal(body.text.format.name, 'answer');
  for (const key of ['messages', 'stop', 'presence_penalty', 'signal', 'maxTokens']) assert.equal(Object.hasOwn(body, key), false, key);
});

test('client, health test, model list and preview use the same configured endpoint', async () => {
  const client = new LLMClient({ ...config, baseUrl: 'https://gateway.example/prefix/v1/responses' });
  const requests = [];
  client.provider.requestJson = async req => { requests.push(req); return req.method === 'GET' ? { data: [{ id: 'muse-spark' }, { id: 'next-model' }] } : completed(); };
  client.provider.request = async req => { requests.push(req); return { ok: true, status: 200, body: JSON.stringify({ data: [{ id: 'muse-spark' }, { id: 'next-model' }] }) }; };
  let usage;
  assert.equal(await client.chat(messages, { max_tokens: 40, onProviderUsage: u => { usage = u; } }), '你好');
  const prepared = client.prepareChatRequest(messages, { max_tokens: 40, stream: false });
  assert.deepEqual(JSON.parse(requests[0].body), prepared.payload);
  assert.equal(usage.totalTokens, 15);
  assert.deepEqual(await client.healthCheck(), { ok: true });
  assert.equal(JSON.parse(requests[1].body).max_output_tokens, 128);
  assert.deepEqual(await client.listModels(), ['muse-spark', 'next-model']);
  assert.equal(requests[2].url, 'https://gateway.example/prefix/v1/models');
  assert.equal(buildOpenAICompatibleEndpoint('https://gateway.example/v1/chat/completions/', 'responses'), 'https://gateway.example/v1/responses');
  const request = { messages, model: config.model, apiFormat: 'responses', options: { max_tokens: 40 }, wireRequest: { url: prepared.url, body: prepared.body } };
  const ac = renderAgentRequestPreview(request);
  assert.ok(ac.includes('max_output_tokens'));
  assert.ok(ac.includes('&quot;input&quot;'));
  assert.ok(!ac.includes('max_tokens'));
  assert.ok(JSON.stringify(buildPromptOverviewView(request)).includes('api_format'));
  const old = new LLMClient({ ...config, apiFormat: undefined });
  assert.equal(old.prepareChatRequest(messages).payload.messages.length, 2);
  await assert.rejects(new OpenAIProvider({ ...config, provider: 'openai' }).chat(messages, { openaiApi: 'responses' }), /official/);
});

test('browser stream decodes fragmented UTF-8, reasoning and terminal usage without duplicate text', async () => {
  let usage, calls = 0;
  globalThis.fetch = async (url, init) => { calls++; assert.equal(url, 'https://gateway.example/prefix/v1/responses'); assert.equal(JSON.parse(init.body).stream, true); return streamResponse(streamEvents()); };
  const chunks = await collect(new LLMClient(config).streamChat(messages, { onProviderUsage: u => { usage = u; } }));
  assert.equal(chunks.filter(x => typeof x === 'string').join(''), '你好');
  assert.ok(chunks.some(x => typeof x === 'object'));
  assert.equal(usage.totalTokens, 15);
  assert.equal(calls, 1);
  globalThis.fetch = async () => streamResponse([{ type: 'response.completed', response: completed('完整返回') }]);
  assert.deepEqual(await collect(new LLMClient(config).streamChat(messages)), ['完整返回']);
});

test('Responses errors, premature EOF, failed HTTP 200 and abort stay on the chosen protocol', async () => {
  const provider = new CustomProvider(config);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }); };
  await assert.rejects(collect(provider.streamChat(messages)), /401.*invalid key/);
  assert.equal(calls, 1);
  globalThis.fetch = async () => streamResponse([{ type: 'error', message: 'unsupported model' }]);
  await assert.rejects(collect(provider.streamChat(messages)), /unsupported model/);
  globalThis.fetch = async () => streamResponse([{ type: 'response.output_text.delta', delta: 'partial' }]);
  await assert.rejects(collect(provider.streamChat(messages)), /完成事件前中断/);
  provider.requestJson = async () => ({ status: 'failed', error: { message: 'capacity exceeded' } });
  assert.deepEqual(await provider.healthCheck(), { ok: false, error: 'capacity exceeded' });
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async () => assert.fail('pre-aborted request sent');
  await assert.rejects(collect(provider.streamChat(messages, { signal: controller.signal })), { name: 'AbortError' });
  provider.requestJson = async () => assert.fail('pre-aborted request sent');
  await assert.rejects(provider.chat(messages, { signal: controller.signal }), { name: 'AbortError' });
});

test('native streaming respects proxy routing, reports usage and closes on cancellation', async () => {
  const raw = sse(streamEvents());
  let offset = 0, closed = 0, usage;
  globalThis.__TAURI__ = { core: { invoke: async (command, args) => {
    if (command === 'http_stream_request_start') { assert.ok(args.url.includes('proxy.example')); assert.equal(JSON.parse(args.body).input[0].role, 'system'); return; }
    if (command === 'http_stream_request_read') { const chunk = raw.slice(offset, offset + 17); offset += 17; return { status: 200, ok: true, chunks: [chunk], done: offset >= raw.length }; }
    if (command === 'http_stream_request_close') { closed++; return; }
    assert.fail(command);
  } } };
  const chunks = await collect(new LLMClient({ ...config, connectionMode: 'reverse_proxy', proxyBaseUrl: 'https://proxy.example' }).streamChat(messages, { onProviderUsage: u => { usage = u; } }));
  assert.equal(chunks.filter(x => typeof x === 'string').join(''), '你好');
  assert.equal(usage.totalTokens, 15); assert.equal(closed, 1);
  const controller = new AbortController();
  let pendingRead;
  globalThis.__TAURI__.core.invoke = async command => {
    if (command === 'http_stream_request_start') return;
    if (command === 'http_stream_request_read') return new Promise(resolve => { pendingRead = resolve; queueMicrotask(() => controller.abort()); });
    if (command === 'http_stream_request_close') { pendingRead?.({ done: true }); return; }
    assert.fail(command);
  };
  await assert.rejects(collect(new LLMClient(config).streamChat(messages, { signal: controller.signal })), { name: 'AbortError' });
  delete globalThis.__TAURI__;
});

test('compatible tool result continuation preserves call IDs, reasoning and selected path', async () => {
  const nativeOutput = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted', summary: [] }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' }];
  const acc = createProviderToolCallDeltaAccumulator({ provider: 'custom', model: config.model });
  const calls = acc.push({ output: nativeOutput }).completed;
  assert.equal(calls[0].toolCallId, 'call_1');
  assert.deepEqual(calls[0].providerContinuation.assistantOutput, nativeOutput);
  const provider = new CustomProvider({ ...config, baseUrl: 'https://gateway.example/v1/responses' });
  let captured;
  provider.requestJson = async req => { captured = req; return completed('查到了'); };
  const runner = createProviderToolLlmClientNativeRunner({ provider });
  const request = attachProviderToolContinuationContext({ provider: 'openai', sourceProvider: 'custom', format: 'openai_responses_function_call_output', input: [...nativeOutput, { type: 'function_call_output', call_id: 'call_1', output: 'result' }] }, { historyMessages: messages });
  const result = await runner.runProviderToolRequest(request);
  assert.equal(result.finalText, '查到了');
  assert.equal(captured.url, 'https://gateway.example/v1/responses');
  assert.deepEqual(JSON.parse(captured.body).input.slice(2, 4), nativeOutput);
  const cc = createProviderToolLlmClientNativeRunner({ provider: new CustomProvider({ ...config, apiFormat: 'chat_completions' }) });
  await assert.rejects(cc.runProviderToolRequest(request), /Responses/);
  assert.equal(buildProviderToolRequestSchema({ ...config }).diagnostics.format, 'openai_responses');
  assert.equal(resolveProviderFcTransport(config).supported, false, 'format selection must not claim verified structured-chat capability');
});

test('web tools replay the final native output and lightweight input agent keeps the profile format', async () => {
  const client = new LLMClient(config);
  const output = [{ type: 'reasoning', id: 'rs_web', encrypted_content: 'final-encrypted', summary: [] }, { type: 'function_call', call_id: 'call_web', id: 'fc_web', name: 'web_search', arguments: '{"query":"example"}' }];
  let calls = 0, last;
  client.provider.requestJson = async req => { calls++; last = JSON.parse(req.body); return calls === 1 ? { ...completed(), output } : completed('有结果了'); };
  const wrapped = createWebSearchGenerationClient({ client, provider: 'custom', model: config.model,
    plan: { enabled: true, fallback: true, fallbackToolNames: { web_search: 'web.search' } },
    toolRuntime: { executeTool: async () => ({ status: 'succeeded', result: { ok: true, results: [] } }) } });
  assert.equal(await wrapped.chat(messages, { tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }] }), '有结果了');
  assert.deepEqual(last.input.slice(2, 4), output);
  assert.equal(last.input.at(-1).type, 'function_call_output');
  assert.equal(last.input.at(-1).call_id, 'call_web');
  const request = createInputSuggestionRequest({ getProfileConfig: async () => config, createClient: cfg => {
    const agent = new LLMClient(cfg);
    agent.provider.requestJson = async req => { assert.ok(req.url.endsWith('/responses')); const body = JSON.parse(req.body); assert.equal(body.max_output_tokens, 96); assert.equal(body.tool_choice, 'none'); return completed('建议'); };
    return agent;
  } });
  assert.equal(await request({ settings: { modelMode: 'profile', modelProfileId: 'fixture' }, before: '今天', after: '' }, new AbortController().signal), '建议');
});

test('OpenCode Responses profiles expose returned model IDs without the Chat-family filter', async () => {
  const client = new LLMClient({ ...config, provider: 'opencode', baseUrl: undefined });
  client.provider.requestJson = async req => { assert.equal(req.url, 'https://opencode.ai/zen/go/v1/models'); return { data: [{ id: 'muse-spark' }, { id: 'glm-5.3' }] }; };
  assert.deepEqual(await client.listModels(), ['muse-spark', 'glm-5.3']);
  assert.equal(client.prepareChatRequest(messages).url, 'https://opencode.ai/zen/go/v1/responses');
  assert.equal(resolveProviderFcTransport({ ...config, provider: 'opencode' }).supported, false);
});

const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, tauri: globalThis.__TAURI__ };
try {
  delete globalThis.__TAURI__;
  const from = Math.max(1, Number(process.argv.find(arg => arg.startsWith('--from='))?.split('=')[1]) || 1);
  globalThis.fetch = async () => assert.fail('unexpected unmocked fetch');
  for (const { name, run } of tests.slice(from - 1)) { await run(); console.log(`ok - ${name}`); }
  console.log(`responses-config-provider-tests passed (${tests.length} groups; mocked requests only)`);
} finally {
  globalThis.fetch = saved.fetch;
  if (saved.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.localStorage;
  if (saved.tauri === undefined) delete globalThis.__TAURI__; else globalThis.__TAURI__ = saved.tauri;
}
