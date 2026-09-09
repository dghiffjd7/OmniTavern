import assert from 'node:assert/strict';
import {
  parseRequestParamValue, validateCustomRequestParams, finalizeTextRequestBody, getRequestParamReport,
  requestParamsToJson, requestParamsFromJson, normalizeCustomRequestParams, sanitizeRequestPreviewUrl,
  getCommonRequestParams, getPresetParamExclusions,
} from '../../src/scripts/api/request-params.js';
import { partitionPresetRequestParam } from '../../src/scripts/api/request-param-ownership.js';
import { LLMClient } from '../../src/scripts/api/client.js';
import { createInputSuggestionRequest } from '../../src/scripts/ui/chat/input-suggestion-runtime.js';
import { createProviderToolLlmClientNativeRunner } from '../../src/scripts/agent/provider-tool-llmclient-native-runner.js';
import { attachProviderToolContinuationContext } from '../../src/scripts/agent/provider-tool-continuation-context.js';
import { buildPromptOverviewView } from '../../src/scripts/ui/chat/prompt-preview-view-utils.js';
import { renderAgentRequestPreview } from '../../src/scripts/ui/chat/agent-request-preview.js';

const tests = [], test = (name, run) => tests.push({ name, run });
const row = (name, value, enabled = true) => ({ name, value, enabled, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
const config = { provider: 'custom', baseUrl: 'https://params.example/v1', apiKey: 'fixture', model: 'fixture-model' };
const messages = [{ role: 'system', content: 'Fixture system' }, { role: 'user', content: 'Hi' }];
const responseData = protocol => protocol === 'responses'
  ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
  : protocol === 'gemini' ? { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }
    : protocol === 'anthropic' ? { content: [{ type: 'text', text: 'ok' }] }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
const wireProtocol = url => url.includes('/responses') ? 'responses' : url.includes('generateContent') || url.includes('GenerateContent') ? 'gemini' : url.endsWith('/messages') ? 'anthropic' : 'chat_completions';
const collect = async iterable => { const result = []; for await (const part of iterable) result.push(part); return result; };

test('typed values, nested merge, arrays, disabled rules, exclusion precedence and isolation', () => {
  assert.equal(parseRequestParamValue('number', '0'), 0);
  assert.equal(parseRequestParamValue('boolean', 'false'), false);
  assert.equal(parseRequestParamValue('string', ''), '');
  assert.equal(parseRequestParamValue('null', ''), null);
  assert.throws(() => parseRequestParamValue('number', ''), /JSON/);
  assert.throws(() => parseRequestParamValue('boolean', '"false"'), /类型/);
  const original = { model: 'fixture', input: [], reasoning: { effort: 'high', summary: 'auto' }, include: ['a'], temperature: 1 };
  const cfg = { ...config, apiFormat: 'responses', customRequestParams: [
    row('reasoning.effort', 'low'), row('include', ['b']), row('temperature', 0.2), row('vendor.flag', false),
    row('vendor.zero', 0), row('vendor.empty', ''), row('vendor.none', null), row('vendor.off', 7, false),
  ], excludedGenerationParams: ['temperature', 'reasoning.effort'] };
  const final = finalizeTextRequestBody(original, { config: cfg, protocol: 'responses' });
  assert.deepEqual(final.reasoning, { summary: 'auto' });
  assert.deepEqual(final.include, ['b']);
  assert.deepEqual(final.vendor, { flag: false, zero: 0, empty: '', none: null });
  assert.equal('temperature' in final, false);
  assert.deepEqual(original.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(original.temperature, 1);
  final.include.push('later'); assert.deepEqual(cfg.customRequestParams[1].value, ['b']);
  assert.ok(getRequestParamReport(final).some(item => item.name === 'temperature' && item.operation === 'set' && item.status === 'preset'));
  assert.ok(getRequestParamReport(final).some(item => item.name === 'vendor.off' && item.status === 'disabled'));
  const partial = finalizeTextRequestBody({}, { config: { ...config, model: 'gpt-5', customRequestParams: [row('reasoning', { effort: 'low', summary: 'auto' })], excludedGenerationParams: ['reasoning.effort'] }, protocol: 'responses' });
  assert.equal(getRequestParamReport(partial)[0].status, 'partially_preset');
  assert.deepEqual(partial.reasoning, { summary: 'auto' });
  const removed = finalizeTextRequestBody({}, { config: { customRequestParams: [row('vendor', { enabled: true, level: 2 })], excludedGenerationParams: ['vendor.level'] } });
  assert.equal(getRequestParamReport(removed)[0].status, 'partially_excluded');
  assert.deepEqual(removed.vendor, { enabled: true });
});

test('ambiguous paths, invalid JSON and unsafe paths are rejected; JSON keeps disabled drafts and types', () => {
  for (const name of ['__proto__.polluted', 'constructor.name', 'a..b', 'tools.0.name']) {
    assert.ok(validateCustomRequestParams([row(name, 'x')]).length, name);
  }
  assert.ok(validateCustomRequestParams([row('a', {}), row('a.b', 2)]).length);
  assert.ok(validateCustomRequestParams([row('a', 1), row('a', 2)]).length);
  assert.equal(validateCustomRequestParams([row('a', 1), row('a', 2, false)]).length, 0);
  assert.throws(() => requestParamsFromJson('{'), /JSON/);
  assert.throws(() => requestParamsFromJson('[]'), /JSON/);
  assert.throws(() => requestParamsFromJson('{"__proto__":{"polluted":true}}'), /保留/);
  assert.equal({}.polluted, undefined);
  const rows = [row('reasoning.effort', 'low'), row('vendor', { flag: false, count: 0, list: [1, null] }), row('off', 'saved', false)];
  const json = requestParamsToJson(rows);
  assert.equal('off' in JSON.parse(json), false);
  assert.deepEqual(requestParamsFromJson(json, rows), rows);
  const copied = normalizeCustomRequestParams(rows); copied[1].value.list.push('other');
  assert.equal(rows[1].value.list.length, 2);
});

test('final-body aliases remove provider defaults and managed fields remain under task control', () => {
  const cfg = { excludedGenerationParams: ['temperature', 'top_p', 'maxTokens', 'thinkingBudget', 'stream', 'messages', 'signal'] };
  const final = finalizeTextRequestBody({ contents: [], generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 42, includeThoughts: true } } }, { config: cfg, protocol: 'gemini' });
  assert.deepEqual(final.generationConfig, { thinkingConfig: { includeThoughts: true } });
  const anthropic = finalizeTextRequestBody({ model: 'a', messages, max_tokens: 4096 }, { config: { excludedGenerationParams: ['maxTokens'] }, protocol: 'anthropic' });
  assert.equal(anthropic.max_tokens, 4096);
  assert.equal(getRequestParamReport(anthropic)[0].status, 'required');
  const protectedBody = finalizeTextRequestBody({ model: 'fixture', input: [], stream: true, max_output_tokens: 96, tool_choice: 'none' }, {
    config: { ...config, customRequestParams: [row('model', 'replacement'), row('input', []), row('stream', false), row('max_output_tokens', 9999), row('tools', [{ type: 'web_search' }])], excludedGenerationParams: ['maxTokens'] },
    protocol: 'responses', options: { requestParamConstraints: { maxOutputTokens: 96, tools: 'none' } },
  });
  assert.equal(protectedBody.model, 'fixture'); assert.equal(protectedBody.stream, true);
  assert.equal(protectedBody.max_output_tokens, 96); assert.equal(protectedBody.tools, undefined);
  assert.equal(protectedBody.tool_choice, 'none');
  const web = finalizeTextRequestBody({ tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] }, {
    config: { webSearchEnabled: true, customRequestParams: [row('tools', [])], excludedGenerationParams: ['tools', 'include'] },
    options: { tools: [{ type: 'web_search' }] }, protocol: 'responses',
  });
  assert.equal(web.tools.length, 1); assert.equal(web.include.length, 1);
});

test('profile save, reload, copy and old profiles isolate custom parameters', async () => {
  const local = new Map([['log_level', 'ERROR']]);
  globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) };
  const { ConfigManager } = await import('../../src/scripts/storage/config.js');
  const scope = 'request_params_' + Date.now();
  const manager = new ConfigManager({ scope });
  await manager.ensureStores();
  await manager.createProfile('old', { ...config, apiKey: undefined });
  const oldId = manager.getActiveProfileId();
  assert.deepEqual(manager.get().customRequestParams, []);
  const rules = [row('vendor', { enabled: false, weights: [0, 1] }), row('temperature', 0.2, false)];
  await manager.createProfile('custom', { ...config, apiKey: undefined });
  await manager.save({ ...config, apiKey: null, customRequestParams: rules, excludedGenerationParams: ['vendor.weights'] });
  const reloaded = new ConfigManager({ scope }); await reloaded.load();
  assert.deepEqual(reloaded.get().customRequestParams, rules);
  const copy = JSON.parse(JSON.stringify(reloaded.getActiveProfile()));
  await reloaded.createProfile('copy', { ...copy, id: undefined });
  assert.deepEqual(reloaded.get().customRequestParams, rules);
  await reloaded.setActiveProfile(oldId); assert.deepEqual(reloaded.get().customRequestParams, []);
});

test('all text provider families send the same final body they prepare, including streaming', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const protocol = wireProtocol(String(url)); const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const data = responseData(protocol);
    if (!body.stream && !String(url).includes('streamGenerateContent')) return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    const events = protocol === 'responses' ? [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: data }]
      : protocol === 'gemini' ? [data] : protocol === 'anthropic'
        ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]
        : [{ choices: [{ delta: { content: 'ok' } }] }];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    for (const provider of ['openai', 'custom', 'responses', 'anthropic', 'gemini', 'makersuite', 'vertexai', 'kimi', 'zhipu', 'openrouter', 'ollama', 'opencode']) {
      const cfg = { ...config, provider: provider === 'responses' ? 'custom' : provider, apiFormat: provider === 'responses' ? 'responses' : 'chat_completions', vertexaiAuthMode: 'express', customRequestParams: [row('vendor.fixture', false), row('vendor.arr', [0, 2])], excludedGenerationParams: ['temperature', 'stream_options'] };
      const client = new LLMClient(cfg);
      for (const stream of [false, true]) {
        const options = { temperature: 0.9, maxTokens: 128, stream };
        const expected = client.prepareChatRequest(messages, options).body;
        const result = stream ? (await collect(client.streamChat(messages, options))).filter(item => typeof item === 'string').join('') : await client.chat(messages, options);
        assert.equal(result, 'ok', provider + ' stream=' + stream);
        const sent = requests.at(-1).body;
        assert.deepEqual(sent, JSON.parse(JSON.stringify(expected)), provider + ' prepared/wire mismatch');
        assert.deepEqual(sent.vendor, { fixture: false, arr: [0, 2] }, provider);
        assert.equal(sent.generationConfig ? sent.generationConfig.temperature : sent.temperature, undefined, provider);
        assert.equal(sent.stream_options, undefined);
        assert.equal(sent.requestParamConstraints, undefined);
      }
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('native stream transport receives final custom fields and exclusions', async () => {
  const previous = globalThis.__TAURI_INVOKE__;
  try {
    for (const apiFormat of ['chat_completions', 'responses']) {
      let body, read = 0;
      globalThis.__TAURI_INVOKE__ = async (command, args) => {
        if (command === 'http_stream_request_start') { body = JSON.parse(args.body); return { ok: true, status: 200 }; }
        if (command === 'http_stream_request_read') {
          if (read++ > 2) throw new Error('native fixture read limit');
          if (read > 1) return { done: true, chunks: [] };
          const event = apiFormat === 'responses' ? { type: 'response.completed', response: responseData('responses') } : { choices: [{ delta: { content: 'ok' } }] };
          return { ok: true, status: 200, done: false, chunks: ['data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n'] };
        }
        if (command === 'http_stream_request_close') return true;
        throw new Error('Unexpected native fixture command: ' + command);
      };
      const client = new LLMClient({ ...config, apiFormat, customRequestParams: [row('vendor.mode', 'native')], excludedGenerationParams: ['temperature', 'stream_options'] });
      assert.equal((await collect(client.streamChat(messages, { temperature: 1 }))).join(''), 'ok');
      assert.deepEqual(body.vendor, { mode: 'native' }); assert.equal(body.temperature, undefined); assert.equal(body.stream_options, undefined);
    }
  } finally { if (previous === undefined) delete globalThis.__TAURI_INVOKE__; else globalThis.__TAURI_INVOKE__ = previous; }
});

test('connection test and input suggestions retain hard output and tool limits', async () => {
  for (const apiFormat of ['chat_completions', 'responses']) {
    const cfg = { ...config, apiFormat, customRequestParams: [row(apiFormat === 'responses' ? 'max_output_tokens' : 'max_tokens', 5000), row('vendor.fast', true), row('tools', [{ type: 'web_search' }]), row('n', 4)] };
    let captured;
    const makeClient = data => {
      const client = new LLMClient(data);
      client.provider.request = async request => { captured = JSON.parse(request.body); return { ok: true, status: 200, body: JSON.stringify(responseData(apiFormat)) }; };
      return client;
    };
    assert.equal((await makeClient(cfg).healthCheck()).ok, true);
    assert.equal(captured[apiFormat === 'responses' ? 'max_output_tokens' : 'max_tokens'], 128);
    const suggest = createInputSuggestionRequest({ getProfileConfig: async () => cfg, createClient: makeClient });
    assert.equal(await suggest({ before: 'Hello', after: '', settings: { modelMode: 'profile', modelProfileId: 'fixture' } }, new AbortController().signal), 'ok');
    assert.equal(captured[apiFormat === 'responses' ? 'max_output_tokens' : 'max_tokens'], 96);
    assert.equal(captured.tools, undefined); assert.deepEqual(captured.vendor, { fast: true });
    if (apiFormat === 'chat_completions') assert.equal(captured.n, 1);
  }
});

test('native function continuation applies profile parameters and previews include custom fields and reports', async () => {
  const cfg = { ...config, apiFormat: 'responses', customRequestParams: [row('vendor.mode', 'continuation'), row('reasoning.effort', 'low')], excludedGenerationParams: ['temperature'] };
  const client = new LLMClient(cfg); let body;
  client.provider.requestJson = async request => { body = JSON.parse(request.body); return responseData('responses'); };
  const input = [{ type: 'function_call', call_id: 'call_fixture', name: 'lookup', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_fixture', output: 'found' }];
  const request = attachProviderToolContinuationContext({ provider: 'openai', sourceProvider: 'custom', format: 'openai_responses_function_call_output', input }, { historyMessages: messages, providerRequestOptions: { temperature: 1 } });
  const runner = createProviderToolLlmClientNativeRunner({ provider: client.provider });
  assert.equal((await runner.runProviderToolRequest(request)).finalText, 'ok');
  assert.deepEqual(body.vendor, { mode: 'continuation' }); assert.equal(body.temperature, undefined); assert.equal(body.input.at(-1).call_id, 'call_fixture');
  const prepared = client.prepareChatRequest(messages, { temperature: 1 });
  const preview = { messages, apiFormat: 'responses', wireRequest: { url: prepared.url, body: prepared.body, parameterReport: prepared.parameterReport } };
  const html = renderAgentRequestPreview(preview); assert.match(html, /vendor/); assert.match(html, /已排除/);
  const overview = buildPromptOverviewView(preview); assert.match(overview.html, /continuation/); assert.match(overview.html, /参数处理结果/); assert.doesNotMatch(overview.html, /fixture-key/);
});

test('request capture observes the final body without serializing callbacks or credentials', async () => {
  const cfg = { ...config, customRequestParams: [row('temperature', 0.2)], excludedGenerationParams: ['stream_options'] };
  const client = new LLMClient(cfg); let capture;
  const prepared = client.prepareChatRequest(messages, { temperature: 1, stream: true, onProviderRequestPrepared: value => { capture = value; } });
  assert.equal(capture.body, prepared.body);
  assert.equal(capture.body.temperature, 1);
  assert.equal(capture.body.stream_options, undefined);
  assert.equal('onProviderRequestPrepared' in capture.body, false);
  const url = sanitizeRequestPreviewUrl('https://user:secret@fixture.example/generate?key=fixture-secret&alt=sse');
  assert.doesNotMatch(url, /fixture-secret|user:secret/);
  assert.match(url, /alt=sse/);
});

test('preset-owned aliases and object leaves keep generation options while extras and exclusions still work', () => {
  const names = ['temperature', 'topP', 'top_p', 'top_k', 'maxTokens', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens',
    'presence_penalty', 'frequency_penalty', 'reasoning_effort', 'reasoning.effort', 'thinkingBudget', 'thinkingLevel', 'output_config.effort', 'max_context'];
  for (const protocol of ['chat_completions', 'responses', 'anthropic', 'gemini']) {
    const original = { model: 'fixture', temperature: 0.8, max_tokens: 300, reasoning: { effort: 'high' },
      generationConfig: { temperature: 0.9, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 400 } } };
    const cfg = { ...config, model: 'gpt-5', customRequestParams: names.map(name => row(name, 0)), excludedGenerationParams: [] };
    const final = finalizeTextRequestBody(original, { config: cfg, protocol });
    assert.deepEqual(final, original, protocol);
    assert.ok(getRequestParamReport(final).every(item => item.status === 'preset'));
    assert.equal(cfg.customRequestParams.every(item => item.enabled && item.value === 0), true, 'stored legacy values stay intact');
    const suggestions = getCommonRequestParams(protocol);
    assert.ok(suggestions.every(item => !partitionPresetRequestParam(item).status));
    assert.ok(getCommonRequestParams(protocol, { forExclusion: true }).some(item => /temperature/.test(item.name)));
  }
  const original = { generationConfig: { topP: 0.8, thinkingConfig: { thinkingLevel: 'high' } } };
  const rules = requestParamsFromJson(JSON.stringify({ generationConfig: { temperature: 0, topP: 0.1, maxOutputTokens: 1,
    thinkingConfig: { thinkingBudget: 0, includeThoughts: false }, responseMimeType: 'application/json' }, seed: 0, stop: ['END'], vendor: { temperature: 0.2 } }));
  const cfg = { provider: 'gemini', model: 'gemini-3.1-pro-preview', customRequestParams: rules };
  const final = finalizeTextRequestBody(original, { config: cfg, protocol: 'gemini' });
  assert.deepEqual(final.generationConfig, { topP: 0.8, thinkingConfig: { thinkingLevel: 'high', includeThoughts: false }, responseMimeType: 'application/json' });
  assert.equal(final.temperature, undefined);
  assert.deepEqual(final.vendor, { temperature: 0.2 }); assert.equal(final.seed, 0); assert.deepEqual(final.stop, ['END']);
  const whole = finalizeTextRequestBody(original, { config: { ...cfg, customRequestParams: [row('generationConfig', { topP: 0.1, responseMimeType: 'application/json' })] }, protocol: 'gemini' });
  assert.equal(whole.generationConfig.topP, 0.8); assert.equal(whole.generationConfig.responseMimeType, 'application/json');
  assert.equal(getRequestParamReport(whole)[0].status, 'partially_preset');
  assert.deepEqual(getRequestParamReport(whole)[0].presetPaths, ['generationConfig.topP']);
  for (const value of [null, false, [], 'off']) {
    const guarded = finalizeTextRequestBody(original, { config: { customRequestParams: [row('generationConfig', value)] }, protocol: 'gemini' });
    assert.deepEqual(guarded, original);
  }
  const empty = finalizeTextRequestBody({}, { config: { customRequestParams: [row('generationConfig', { temperature: 1 })] }, protocol: 'gemini' });
  assert.deepEqual(empty, {}, 'disabled or unavailable preset fields cannot be reintroduced');
  const excluded = finalizeTextRequestBody(original, { config: { customRequestParams: [row('generationConfig', { topP: 0.1, responseMimeType: 'application/json' })], excludedGenerationParams: ['top_p'] }, protocol: 'gemini' });
  assert.equal(excluded.generationConfig.topP, undefined);
  assert.equal(original.generationConfig.topP, 0.8, 'preset body stays isolated');
  const specialized = finalizeTextRequestBody({}, { config: { ...config, customRequestParams: [row('reasoning.effort', 'custom-effort')] }, protocol: 'responses' });
  assert.equal(specialized.reasoning.effort, 'custom-effort', 'models without a Preset reasoning control retain extra fields');
});

test('preset exclusion badges match native paths and retain required-field exceptions', () => {
  assert.deepEqual(getPresetParamExclusions('temperature', { provider: 'vertexai', excludedGenerationParams: ['temperature', 'generationConfig.temperature'] }), ['generationConfig.temperature']);
  assert.deepEqual(getPresetParamExclusions('max_output_tokens', { provider: 'anthropic', excludedGenerationParams: ['maxTokens'] }), []);
  assert.deepEqual(getPresetParamExclusions('reasoning', { ...config, apiFormat: 'responses', excludedGenerationParams: ['reasoning_effort'] }), ['reasoning.effort']);
  assert.deepEqual(getPresetParamExclusions('reasoning', { provider: 'gemini', excludedGenerationParams: ['generationConfig.thinkingConfig'] }), ['generationConfig.thinkingConfig']);
  assert.deepEqual(getPresetParamExclusions('temperature', { ...config, excludedGenerationParams: ['generationConfig.temperature'] }), []);
  assert.deepEqual(getPresetParamExclusions('max_context', { ...config, excludedGenerationParams: ['max_context'] }), []);
});

test('preset navigation returns to the same API draft on close or open failure', async () => {
  globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const { ConfigPanel } = await import('../../src/scripts/ui/config-panel.js');
  const { PresetPanel } = await import('../../src/scripts/ui/preset-panel.js');
  let openOptions;
  const panel = Object.create(ConfigPanel.prototype);
  panel.element = { style: { visibility: '' } }; panel.overlayElement = { style: { visibility: 'visible' } };
  panel.closeCustomSelectMenu = () => {};
  panel.onOpenPresetParams = options => { openOptions = options; };
  const rules = { excludedGenerationParams: ['temperature'], customRequestParams: [row('vendor.flag', false)] };
  const opened = panel.openPresetFromRequestParams({ field: 'temperature', rules });
  assert.equal(panel.element.style.visibility, 'hidden'); assert.equal(panel.requestParamsPresetDraft, rules);
  assert.equal(openOptions.section, 'openai'); assert.equal(openOptions.focusParam, 'temperature');
  const preset = Object.create(PresetPanel.prototype);
  preset.captureCurrentDetailDraft = () => {}; preset.closeCustomSelectMenu = () => {};
  preset.element = { style: {} }; preset.overlayElement = { style: {} };
  let hides = 0;
  preset.pendingOpenOptions = { onHide: () => { hides++; openOptions.onHide(); } };
  preset.hide(); preset.hide(); await opened;
  assert.equal(hides, 1); assert.equal(panel.requestParamsPresetDraft, null);
  assert.equal(panel.element.style.visibility, ''); assert.equal(panel.overlayElement.style.visibility, 'visible');
  panel.onOpenPresetParams = () => Promise.reject(new Error('fixture open failure'));
  await assert.rejects(panel.openPresetFromRequestParams({ field: 'temperature', rules }), /fixture open failure/);
  assert.equal(panel.requestParamsPresetDraft, null); assert.equal(panel.element.style.visibility, '');
});

const from = Number(process.argv.find(arg => arg.startsWith('--from='))?.split('=')[1]) || 1;
const groups = process.argv.find(arg => arg.startsWith('--groups='))?.slice('--groups='.length).split(',').map(Number);
const passed = [];
for (let index = from - 1; index < tests.length; index++) {
  if (groups && !groups.includes(index + 1)) continue;
  await tests[index].run(); console.log(`ok ${index + 1} - ${tests[index].name}`);
  passed.push(index + 1);
}
console.log(`request parameter groups passed: ${passed.join(', ')}`);
