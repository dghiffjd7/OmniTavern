import assert from 'node:assert/strict';
import { createPresetRequestWorker } from '../../src/scripts/plugins/preset-request-worker.js';
import { PresetRequestTransport, makePresetRequestBody, applyPresetRequestBody,
  createPresetGenerationClient, isCreativePresetRequest, resolveForcedPromptPostProcessing,
  applyPresetEntryDecisions } from '../../src/scripts/plugins/preset-request-transport.js';
import { toScriptPreset, fromScriptPreset, mergeScriptPresetChanges } from '../../src/scripts/plugins/preset-script-api.js';
import { createGenerationProviderCallDiagnosticsTracker } from '../../src/scripts/ui/chat/generation-provider-call-diagnostics-utils.js';

const context = { sessionId: 'rp:test', openaiPresetId: 'test' };
function harness(middleware, workerOptions = {}) {
  let worker;
  const base = (...args) => worker.interceptFetch(...args) || Promise.reject(new Error('unexpected external fetch'));
  const fetch = middleware ? middleware(base) : base;
  const host = new PresetRequestTransport({ post: value => queueMicrotask(() => worker.handle(value)), onTimeout: () => assert.fail('worker timed out') });
  worker = createPresetRequestWorker({ send: value => queueMicrotask(() => host.handle(value)),
    getFetch: () => fetch, getBaseFetch: () => base, getSettings: () => ({ allowNetwork: false }), getContext: () => context,
    ...workerOptions });
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

{
  // A preset can wait for the whole upstream reply, then release several SSE
  // deltas at once. Chunk count alone must not turn that replay into model TPS.
  let tick = 1000;
  const tracker = createGenerationProviderCallDiagnosticsTracker({ now: () => tick });
  const callId = tracker.start({ stream: true });
  const host = harness(base => async (...args) => {
    const response = await base(...args);
    const buffered = await response.text();
    return new Response(buffered, { headers: response.headers });
  });
  const session = await host.prepare(payload({ spreset: null }));
  const client = createPresetGenerationClient({ session, config, client: {
    async *streamChat(_messages, options) {
      tick = 2000; yield 'one';
      tick = 3000; yield 'two';
      tick = 4000;
      options.onProviderUsage({ completionTokens: 4000 });
    },
  } });
  let result = '';
  for await (const chunk of client.streamChat(input, { onProviderUsage: usage => tracker.observeUsage(callId, usage) })) {
    tracker.observeMeaningfulDelta(callId);
    result += chunk;
  }
  tick += 18;
  tracker.finish(callId);
  const call = tracker.snapshot()[0];
  assert.equal(result, 'onetwo');
  assert.equal(call.streamDeltaCount, 2);
  assert.equal(call.streamObservedDurationMs, 0);
  assert.equal(call.outputSpeedStatus, 'insufficient_samples');
  assert.equal(call.tokensPerSecond, null);
  assert.equal(call.completionTokens, 4000);
  assert.equal(host.jobs.size, 0);
}

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

{
  // SPreset ChatSquash（聊天合并）：行为对照上游 inject.js，设置取自「小猫之神·喵赛亚」
  const squashOn = { enabled: true, conditional_enabled: true, conditional_tag: '<|merge|>', role: 'assistant',
    user_prefix: '|{{user}}|\n', user_suffix: '', char_prefix: '|游戏剧情|\n', char_suffix: '', prefix_system: '', suffix_system: '',
    enable_squashed_separator: true, squashed_separator_string: '<|sep|>', squashed_separator_regex: false,
    separate_chat_history: false, parse_clewd: false, re_split: false, user_role_system: false,
    enable_stop_string: false, stop_string: '["<end>"]', squashed_post_script_enable: false, squashed_post_script: '' };
  const substitute = text => String(text).replaceAll('{{user}}', '哲');
  const squash = async (messages, ChatSquash, options = {}) => (await harness(null, { substitute }).prepare(payload({
    body: makePresetRequestBody(messages, options, config, true), spreset: { ChatSquash },
  }))).body;

  const source = [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2<|merge|>' },
    { role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }];
  let body = await squash(source, squashOn);
  assert.deepEqual(body.messages, [{ role: 'assistant', content: 'S1\nS2|哲|\nU1|游戏剧情|\nA1|哲|\nU2' }],
    '同角色换行接上，换角色时加后缀与前缀，条件标签被移除');
  assert.equal(body.stop, undefined);
  assert.equal(source[1].content, 'S2<|merge|>', '不改调用方的消息');

  body = await squash([{ role: 'system', content: 'S1' }, { role: 'user', content: 'U1' }],
    { ...squashOn, squashed_post_script_enable: true, squashed_post_script: 'text => "X"' });
  assert.deepEqual(body.messages, [{ role: 'system', content: 'S1' }, { role: 'user', content: 'U1' }],
    '没有条件标签时整份不合并，也不跑后处理');

  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  body = await squash([{ role: 'system', content: 'S1<|merge|>' }, { role: 'user', content: 'U1' },
    { role: 'system', content: 'TAIL<|sep|>' }, { role: 'user', content: [{ type: 'text', text: '看图' }, image] },
    { role: 'user', content: 'U2' }], squashOn);
  assert.deepEqual(body.messages, [
    { role: 'assistant', content: 'S1|哲|\nU1' },
    { role: 'system', content: 'TAIL' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, image] },
    { role: 'assistant', content: '|哲|\nU2' },
  ], '带分隔符的消息单独成条（去掉分隔符），带图消息原样保留，前后分段合并');

  body = await squash([{ role: 'user', content: [{ type: 'text', text: 'U1' }, { type: 'text', text: 'U1b' }] },
    { role: 'system', content: 'S1' }, { role: 'assistant', content: 'A1<|sep|>' }, { role: 'user', content: 'U2' }],
  { ...squashOn, conditional_enabled: false, role: 'follow', user_role_system: true,
    squashed_post_script_enable: true, squashed_post_script: 'text => text.toUpperCase();',
    enable_stop_string: true, stop_string: '["<end>", "<ctrl"]' }, { stop: ['<end>', 'User:'] });
  assert.deepEqual(body.messages, [
    { role: 'user', content: '|哲|\nU1U1B\nS1' },
    { role: 'assistant', content: 'A1' },
    { role: 'assistant', content: '|哲|\nU2' },
  ], 'follow 跟随第一条与单独成条的角色；system 当 user；后处理拿合并后的整段文字');
  assert.deepEqual(body.stop, ['User:', '<end>', '<ctrl'], '停止字符去重后追加');

  await assert.rejects(squash(source, { ...squashOn, squashed_post_script_enable: true, squashed_post_script: 'text => undefined' }),
    /合并后处理必须返回文字/);
  await assert.rejects(squash(source, { ...squashOn, parse_clewd: true, re_split: true }),
    /尚未支持的选项：解析 clewd 标记、重新拆分提示词/);
  console.log('ok - SPreset ChatSquash merges prompts like upstream');

  // SPreset 最终请求处理：在合并之后、发出之前运行。脚本仿「小猫之神·喵赛亚」：整段剧情搬进 context 工具说明，
  // 最后只发 system + user，请求不再以 assistant 结尾
  const finalScript = `({ request, provider, model, source, stream, preview }) => {
    const marker = '<run_tool_replacement>';
    if (!request.messages.some(m => m.role === 'system' && m.content.includes(marker))) return request;
    if (request.messages.length !== 3) throw new Error('预期消息为三条：system → assistant → user');
    const [system, assistant, user] = request.messages;
    request.tools = [...(request.tools ?? []), { type: 'function', function: { name: 'context',
      description: assistant.content, parameters: { type: 'object', properties: {} } } }];
    request.messages = [{ ...system, content: system.content.replaceAll(marker, '') }, user];
    request.seen = { provider, model, source, stream, preview };
  }`;
  const finalRequest = async (messages, FinalRequestProcessing, overrides = {}) => (await harness(null, { substitute }).prepare(payload({
    body: makePresetRequestBody(messages, {}, config, true), spreset: { ChatSquash: squashOn, FinalRequestProcessing },
    provider: { provider: 'custom', model: 'fixture' }, ...overrides,
  }))).body;
  const story = [{ role: 'system', content: '<|sep|><|merge|><run_tool_replacement>' }, { role: 'system', content: 'S1' },
    { role: 'user', content: 'U1' }, { role: 'user', content: '<|sep|>", "function": ' }];
  body = await finalRequest(story, { enabled: true, script: finalScript }, { preview: true });
  assert.deepEqual(body.messages, [{ role: 'system', content: '' }, { role: 'user', content: '", "function": ' }]);
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'context', description: 'S1|哲|\nU1',
    parameters: { type: 'object', properties: {} } } }], '合并后的整段进工具说明');
  assert.deepEqual(body.seen, { provider: { provider: 'custom', model: 'fixture' }, model: 'fixture', source: 'custom',
    stream: true, preview: true }, '脚本拿到供应方、模型、来源、流式与预览标记');

  body = await finalRequest(story, { enabled: false, script: finalScript });
  assert.equal(body.messages.length, 3, '关闭时不运行');
  body = await finalRequest(input, { enabled: true, script: '({ request }) => ({ ...request, messages: [{ role: "user", content: "replaced" }] })' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'replaced' }], '返回的新请求对象替换原请求');

  await assert.rejects(finalRequest(story.filter(m => !m.content.includes('function')), { enabled: true, script: finalScript }),
    /SPreset 最终请求处理失败：预期消息为三条/);
  await assert.rejects(finalRequest(input, { enabled: true, script: '() => "text"' }), /必须返回请求对象/);
  await assert.rejects(finalRequest(input, { enabled: true, script: '({ request }) => { request.stream = false; }' }),
    /不能改变 stream 或 chat_completion_source/);
  console.log('ok - SPreset final request processing runs after squash and before sending');
}

{
  const forced = (enabled, mode) => resolveForcedPromptPostProcessing({ ForcedPostProcessing: { enabled, mode } });
  assert.equal(forced(true, ''), 'none', '上游空模式即强制不处理');
  assert.equal(forced(true, 'strict_tools'), 'strict');
  assert.equal(forced(true, 'claude'), 'merge', '旧名 claude 同 merge');
  assert.equal(forced(true, 'single'), 'single');
  assert.equal(forced(false, 'strict'), null);
  assert.equal(forced(true, 'unknown'), null);
  assert.equal(resolveForcedPromptPostProcessing(null), null);
  console.log('ok - SPreset forced prompt post-processing maps to app modes');
}

{
  // SPreset 条目条件：在 Worker 里跑，结果只决定这一轮的开关；条件仿「小猫之神·喵赛亚」的「user尾」
  const chat = [{ name: '哲', is_user: true, mes: '你好' }];
  const host = harness(null, { getContext: () => ({ ...context, chat }) });
  const entry = (identifier, script, extra = {}) => ({ identifier, name: identifier, spreset_condition_enabled: true,
    spreset_condition_script: script, ...extra });
  const result = await host.evaluateEntryConditions({ sessionId: context.sessionId, presetId: context.openaiPresetId,
    provider: { source: 'vertexai', model: 'gemini-4-argon' }, generationType: 'normal', entries: [
      entry('tail', '({ model }) => /3\\.[78]|4/i.test(model)'),
      entry('prefill', '({ model }) => /3\\.1/i.test(model)'),
      entry('seen', '(args) => { globalThis.__entryArgs = args; return true; }', { content: 'body' }),
      entry('text', '() => "yes"'),
      entry('broken', '() => { throw new Error("坏了"); }'),
    ] });
  assert.deepEqual(result.decisions, { tail: true, prefill: false, seen: true, text: false, broken: false });
  assert.deepEqual(result.failures.map(f => [f.identifier, f.error]), [
    ['text', '条目条件必须返回 true 或 false'], ['broken', '坏了']], '非布尔值和报错的条目本轮不启用');
  const args = globalThis.__entryArgs;
  assert.deepEqual({ ...args, entry: args.entry.content }, { model: 'gemini-4-argon', provider: { source: 'vertexai', model: 'gemini-4-argon' },
    source: 'vertexai', type: 'normal', entry: 'body', chat }, '脚本拿到模型、来源、生成类型、条目和聊天记录');
  delete globalThis.__entryArgs;
  await assert.rejects(host.evaluateEntryConditions({ sessionId: 'rp:other', presetId: context.openaiPresetId, entries: [] }),
    /会话或预设已切换/);

  const order = [{ identifier: 'tail', enabled: false }, { identifier: 'prefill', enabled: true }, { identifier: 'main', enabled: true }];
  assert.deepEqual(applyPresetEntryDecisions(order, { tail: true, prefill: false }),
    [{ identifier: 'tail', enabled: true }, { identifier: 'prefill', enabled: false }, { identifier: 'main', enabled: true }]);
  assert.equal(order[0].enabled, false, '不改原预设');
  assert.equal(applyPresetEntryDecisions(order, null), order);
  console.log('ok - SPreset entry conditions decide entries for one generation');
}
