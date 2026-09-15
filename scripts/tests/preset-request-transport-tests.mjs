import assert from 'node:assert/strict';
import { createPresetRequestWorker } from '../../src/scripts/plugins/preset-request-worker.js';
import { PresetRequestTransport, makePresetRequestBody, applyPresetRequestBody,
  createPresetGenerationClient, isCreativePresetRequest } from '../../src/scripts/plugins/preset-request-transport.js';
import { toScriptPreset, fromScriptPreset, mergeScriptPresetChanges } from '../../src/scripts/plugins/preset-script-api.js';

const context = { sessionId: 'rp:test', openaiPresetId: 'test' };
function harness(middleware) {
  let worker;
  const base = (...args) => worker.interceptFetch(...args) || Promise.reject(new Error('unexpected external fetch'));
  const fetch = middleware ? middleware(base) : base;
  const host = new PresetRequestTransport({ post: value => queueMicrotask(() => worker.handle(value)), onTimeout: () => assert.fail('worker timed out') });
  worker = createPresetRequestWorker({ send: value => queueMicrotask(() => host.handle(value)),
    getFetch: () => fetch, getBaseFetch: () => base, getSettings: () => ({ allowNetwork: false }), getContext: () => context });
  return host;
}
const config = { provider: 'custom', model: 'fixture', stream: true };
const preset = { prompts: [{ identifier: 'body', content: 'body tool' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'body', enabled: true }] }] };
const spreset = {
  ChatSquash: { enabled: false, squashed_post_script_enable: true, squashed_post_script: '(messages) => messages.map(m => ({ ...m, content: "prepared:" + m.content }))' },
  ToolBindings: { body: { enabled: true, valid: true, code: 'return {name:"write_body",parameters:{type:"object",properties:{content:{type:"string"}},required:["content"]}}' } },
  OutputPreprocessing: { enabled: true, consumeToolCalls: true, script: String.raw`({buffer, final}) => {
    const tail = final ? null : /\\u[0-9a-f]{0,3}$/i.exec(buffer);
    const hold = tail ? tail[0] : '';
    const text = hold ? buffer.slice(0, -hold.length) : buffer;
    return {output:text.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code,16))), hold};
  }` },
};
const input = [{ role: 'user', content: 'hello' }];
const payload = (overrides = {}) => ({ body: makePresetRequestBody(input, {}, config, true), stream: true,
  sessionId: context.sessionId, presetId: context.openaiPresetId, preset, spreset, ...overrides });

assert.equal(isCreativePresetRequest({ presetContext: { uiMode: 'chat' } }), false);
assert.equal(isCreativePresetRequest({ presetContext: { uiMode: 'rp' }, purpose: 'maintenance' }), false);
assert.equal(isCreativePresetRequest({ presetContext: { uiMode: 'rp' }, context: { task: { type: 'maid' } } }), false);
assert.equal(isCreativePresetRequest({ presetContext: { uiMode: 'rp' } }), true);

{
  const host = harness();
  const session = await host.prepare(payload());
  assert.equal(session.body.messages[0].content, 'prepared:hello');
  assert.equal(session.body.tools[0].function.name, 'write_body');
  assert.equal(input[0].content, 'hello');
  const client = createPresetGenerationClient({ session, config, client: {
    async *streamChat(_messages, options) {
      const push = delta => options.onProviderToolCallDelta({ choices: [{ delta }] });
      yield 'prefix \\u4'; yield 'f60';
      push({ tool_calls: [{ index: 0, id: 'one', function: { name: 'write_body', arguments: '{"content":"正文\\n' } }] });
      push({ tool_calls: [{ index: 0, function: { arguments: '\\u4f60\\ud83d\\ude00"}' } }] });
      options.onProviderToolCallDelta({ choices: [{ finish_reason: 'tool_calls', delta: {} }] });
    },
  } });
  let result = '';
  for await (const value of client.streamChat(input, {})) result += value;
  assert.equal(result, 'prefix 你\n正文\n你😀');
  assert.equal(host.jobs.size, 0);
}

{
  const host = harness();
  const session = await host.prepare(payload({ stream: false }));
  const client = createPresetGenerationClient({ session, config: { provider: 'gemini' }, client: {
    async chat(_messages, options) {
      options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: 'write_body', args: { content: 'Gemini 正文' } } }] } }] });
      return '';
    },
  } });
  assert.equal(await client.chat(input, {}), 'Gemini 正文');
  assert.equal(host.jobs.size, 0);
}

{
  // Gemini providers yield text as well as their raw packet callback. Preserve
  // one copy of the text and assemble partialArgs into the body at EOF.
  const host = harness();
  const session = await host.prepare(payload());
  const client = createPresetGenerationClient({ session, config: { provider: 'gemini' }, client: {
    async *streamChat(_messages, options) {
      options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ text: '前言' }] } }] });
      yield '前言';
      for (const text of ['正文', '🌟']) options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{
        functionCall: { name: 'write_body', partialArgs: [{ jsonPath: '$.content', stringValue: text }] },
      }] } }] });
    },
  } });
  const values = [];
  for await (const value of client.streamChat(input, {})) values.push(value);
  assert.equal(values.join(''), '前言\n正文🌟');
}

for (const provider of ['anthropic', 'openai']) {
  const host = harness();
  const session = await host.prepare(payload());
  const reasoning = { __chatappStream: true, kind: 'reasoning', text: 'internal', hidden: true, provider, label: 'Thinking' };
  const client = createPresetGenerationClient({ session, config: { provider }, client: {
    async *streamChat(_messages, options) {
      yield reasoning;
      const push = options.onProviderToolCallDelta;
      if (provider === 'anthropic') {
        push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'write_body', input: {} } });
        push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"content":"正文"}' } });
        push({ type: 'content_block_stop', index: 0 });
      } else {
        push({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'a', name: 'write_body', arguments: '' } });
        push({ type: 'response.function_call_arguments.delta', item_id: 'item', output_index: 0, delta: '{"content":"正文"}' });
        push({ type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'write_body', arguments: '{"content":"正文"}' });
      }
    },
  } });
  const values = [];
  for await (const value of client.streamChat(input, {})) values.push(value);
  assert.deepEqual(values, [reasoning, '正文']);
}

{
  const host = harness(base => (...args) => base(...args));
  const controller = new AbortController();
  const session = await host.prepare(payload({ spreset: null }), { signal: controller.signal });
  let stopped = false;
  const client = createPresetGenerationClient({ session, config, client: {
    async *streamChat(_messages, options) {
      yield 'partial';
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      stopped = true;
    },
  } });
  const stream = client.streamChat(input, { signal: controller.signal });
  assert.equal((await stream.next()).value, 'partial');
  controller.abort();
  await assert.rejects(stream.next(), { name: 'AbortError' });
  assert.equal(stopped, true);
  assert.equal(host.jobs.size, 0);
}

{
  // Legacy middleware really sees and rewrites the per-request virtual fetch.
  const host = harness(base => async (url, init) => {
    const body = JSON.parse(init.body);
    body.messages.unshift({ role: 'system', content: 'middleware' });
    const response = await base(url, { ...init, body: JSON.stringify(body) });
    const json = await response.json();
    json.choices[0].message.content = '[' + json.choices[0].message.content + ']';
    return Response.json(json);
  });
  const session = await host.prepare(payload({ stream: false, spreset: null }));
  assert.equal(session.body.messages[0].content, 'middleware');
  const client = createPresetGenerationClient({ session, config, client: { chat: async () => '原文' } });
  assert.equal(await client.chat(input, {}), '[原文]');
}

{
  const host = harness();
  const session = await host.prepare(payload({ preview: true }));
  assert.equal(session.body.tools.length, 1);
  assert.equal(host.jobs.size, 0);
  await assert.rejects(host.prepare(payload({ sessionId: 'rp:changed' })), /会话或预设已切换/);
  const controller = new AbortController();
  const pending = await host.prepare(payload(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(async () => { for await (const _ of pending.read()) {} }, { name: 'AbortError' });
  assert.equal(host.jobs.size, 0);
}

{
  const options = { temperature: 0.7, tools: [{ functionDeclarations: [{ name: 'write_body', parameters: { type: 'object' } }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } }, onProviderToolCallDelta() {}, signal: new AbortController().signal };
  const body = makePresetRequestBody(input, options, { provider: 'gemini', model: 'test', apiKey: 'secret' }, true);
  assert.equal(JSON.stringify(body).includes('secret'), false);
  const restored = applyPresetRequestBody(body, options, { provider: 'gemini' });
  assert.deepEqual(restored.options.tools, options.tools);
  assert.equal(restored.options.signal, options.signal);
  assert.equal(restored.options.onProviderToolCallDelta, options.onProviderToolCallDelta);
}

{
  const original = { name: 'test', prompts: [{ identifier: 'a', content: 'a' }, { identifier: 'b', content: 'b' }, { identifier: 'unused', content: 'u' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }] }] };
  const before = toScriptPreset(original, []);
  assert.deepEqual(fromScriptPreset(original, before), original, 'a no-op must preserve raw prompt order and fields');
  assert.deepEqual(before.prompts.map(item => item.id), ['b', 'a']);
  assert.equal(before.prompts[0].enabled, false);
  assert.equal(before.prompts_unused[0].id, 'unused');
  const edited = structuredClone(before), concurrent = structuredClone(before);
  edited.prompts[0].enabled = true;
  concurrent.prompts[1].content = 'user edit';
  const saved = fromScriptPreset(original, mergeScriptPresetChanges(before, edited, concurrent));
  assert.equal(saved.prompts.find(item => item.identifier === 'a').content, 'user edit');
  assert.equal(saved.prompt_order[0].order[0].enabled, true);
  const inserted = structuredClone(before);
  inserted.prompts.push({ ...inserted.prompts[0], id: 'new', content: 'new' });
  assert.equal(fromScriptPreset(original, inserted).prompts.find(item => item.identifier === 'new').content, 'new');
  edited.prompts[1].content = 'script edit';
  assert.throws(() => mergeScriptPresetChanges(before, edited, concurrent), /已改变/);
}
console.log('ok - creative request scope, virtual middleware, tool output, Unicode, cancellation, provider mapping and preset updates');
