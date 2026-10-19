import assert from 'node:assert/strict';

globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
const {
  CREATIVE_BODY_FC_TOOL_NAME,
  buildCreativeBodyFcTool,
  planCreativeBodyFc,
  createCreativeBodyFcDecoder,
  resolveCreativeBodyFcOutcome,
  streamCreativeBodyFc,
  chatCreativeBodyFc,
  describeCreativeBodyFcNotice,
  createBodyToolTransportSetting,
  classifyReplyTruncation,
  planCreativeBodyFcTruncationHint,
} = await import('../../src/scripts/ui/chat/creative-body-fc.js');

const vertex = { provider: 'vertexai', model: 'gemini-4-argon', baseUrl: '' };
const studio = { provider: 'makersuite', model: 'gemini-4-argon', baseUrl: '' };
const deepseek = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' };

{
  // 防截断传输：只给一个正文工具并强制调用；生成参数不动（不用手机 FC 的温度 0、关思考）
  const tool = buildCreativeBodyFcTool();
  assert.equal(tool.function.name, CREATIVE_BODY_FC_TOOL_NAME);
  assert.deepEqual(tool.function.parameters.required, ['content']);
  const plan = planCreativeBodyFc({ enabled: true, uiMode: 'rp', config: vertex, requestOptions: { temperature: 1 } });
  assert.equal(plan.active, true);
  assert.equal(plan.requestOptions.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.deepEqual(plan.requestOptions.toolConfig.functionCallingConfig.allowedFunctionNames, [CREATIVE_BODY_FC_TOOL_NAME]);
  assert.equal(plan.requestOptions.toolConfig.functionCallingConfig.streamFunctionCallArguments, true, 'Vertex 请求逐段送参数');
  assert.equal(plan.requestOptions.temperature, undefined, '只给工具相关参数');
  const studioPlan = planCreativeBodyFc({ enabled: true, uiMode: 'rp', config: studio, requestOptions: {} });
  assert.equal(studioPlan.active, true);
  assert.equal(studioPlan.requestOptions.toolConfig.functionCallingConfig.streamFunctionCallArguments, undefined, 'AI Studio 不认这个参数，不送');
  const deepseekPlan = planCreativeBodyFc({ enabled: true, uiMode: 'rp', config: deepseek, requestOptions: { thinking: { type: 'disabled' } } });
  assert.equal(deepseekPlan.active, true);
  assert.ok(Array.isArray(deepseekPlan.requestOptions.tools) && deepseekPlan.requestOptions.tools.length === 1);

  const skip = (input, reason, notice) => {
    const result = planCreativeBodyFc({ enabled: true, uiMode: 'rp', config: vertex, requestOptions: {}, ...input });
    assert.equal(result.active, false, reason);
    assert.equal(result.reason, reason);
    assert.equal(result.notice === true, notice, `${reason} 是否提示`);
  };
  skip({ enabled: false }, 'disabled', false);
  skip({ uiMode: 'chat' }, 'not_creative', false);
  skip({ phoneRoute: true }, 'not_creative', false);
  skip({ requestOptions: { tools: [{ googleSearch: {} }] } }, 'caller_tools', true);
  skip({ requestOptions: { tool_choice: 'auto' } }, 'caller_tools', true);
  skip({ presetRequestSession: { bypass: false } }, 'preset_request_session', true);
  assert.equal(planCreativeBodyFc({ enabled: true, uiMode: 'rp', config: vertex, requestOptions: {}, presetRequestSession: { bypass: true } }).active, true);
  skip({ config: { provider: 'custom', model: 'x', baseUrl: 'https://example.com/v1' } }, 'unsupported_provider', false);
  skip({ config: deepseek, requestOptions: { thinking: { type: 'enabled' } } }, 'thinking_incompatible', true);
  skip({ config: { provider: 'anthropic', model: 'claude-x', baseUrl: '' }, requestOptions: { thinking: { type: 'enabled', budget_tokens: 2048 } } }, 'thinking_incompatible', true);
  console.log('ok - creative body FC plans a single forced tool and skips with reasons');
}

{
  // 逐段解码：OpenAI arguments 片段（含转义与 \u）、Anthropic input_json_delta、Gemini 整包、Vertex partialArgs
  const openai = createCreativeBodyFcDecoder({ provider: 'deepseek', model: 'deepseek-flash' });
  const tc = (args, extra = {}) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...extra, function: { ...(extra.name ? { name: extra.name } : {}), arguments: args } }] } }] });
  assert.equal(openai.push(tc('{"con', { id: 'c1', name: CREATIVE_BODY_FC_TOOL_NAME, type: 'function' })), '');
  assert.equal(openai.push(tc('tent": "第一行\\n')), '第一行\n');
  assert.equal(openai.push(tc('\\u94a5')), '钥');
  assert.equal(openai.push(tc('匙\\"')), '匙"');
  assert.equal(openai.push(tc('"}')), '');
  openai.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  assert.deepEqual(openai.finish(), { toolStarted: true, toolCompleted: true, toolContent: '第一行\n钥匙"', finishReason: 'tool_calls', remainder: '' });

  const half = createCreativeBodyFcDecoder({ provider: 'deepseek' });
  half.push(tc('{"content":"写到一半\\', { id: 'c2', name: CREATIVE_BODY_FC_TOOL_NAME }));
  const cut = half.finish();
  assert.equal(cut.toolContent, '写到一半', '残缺转义先不输出');
  assert.equal(cut.toolCompleted, false);

  const claude = createCreativeBodyFcDecoder({ provider: 'anthropic' });
  claude.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: CREATIVE_BODY_FC_TOOL_NAME, input: {} } });
  assert.equal(claude.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"content":"雨' } }), '雨');
  assert.equal(claude.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '夜"}' } }), '夜');
  claude.push({ type: 'content_block_stop', index: 0 });
  claude.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  assert.equal(claude.finish().toolCompleted, true);

  const gemini = createCreativeBodyFcDecoder({ provider: 'makersuite' });
  assert.equal(gemini.push({ candidates: [{ content: { parts: [{ functionCall: { name: CREATIVE_BODY_FC_TOOL_NAME, args: { content: '整段正文' } } }] }, finishReason: 'STOP' }] }), '整段正文');
  assert.equal(gemini.finish().finishReason, 'STOP');

  const streamed = createCreativeBodyFcDecoder({ provider: 'vertexai' });
  const part = p => ({ candidates: [{ content: { parts: [p] } }] });
  assert.equal(streamed.push(part({ functionCall: { name: CREATIVE_BODY_FC_TOOL_NAME, id: 'v1', willContinue: true } })), '');
  assert.equal(streamed.push(part({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '钟楼', willContinue: true }], willContinue: true } })), '钟楼');
  assert.equal(streamed.push(part({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '的怀表' }], willContinue: true } })), '的怀表');
  assert.equal(streamed.push({ candidates: [{ content: { parts: [{ functionCall: {} }] }, finishReason: 'STOP' }] }), '');
  assert.equal(streamed.finish().toolCompleted, true);

  const other = createCreativeBodyFcDecoder({ provider: 'makersuite' });
  assert.equal(other.push({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { content: '不是正文' } } }] } }] }), '', '别的工具不当正文');
  console.log('ok - creative body FC decoder streams the content field across provider formats');
}

{
  // 收尾判定：有工具内容用工具内容；没调用用普通文字；没写完或异常结束标记可能不完整
  assert.deepEqual(resolveCreativeBodyFcOutcome({ toolStarted: true, toolCompleted: true, toolContent: '正文', plainText: '杂讯', finishReason: 'STOP' }),
    { outcome: 'transported', text: '正文', incomplete: false, finishReason: 'STOP' });
  assert.equal(resolveCreativeBodyFcOutcome({ toolStarted: true, toolCompleted: false, toolContent: '写到一半', finishReason: '' }).incomplete, true);
  assert.equal(resolveCreativeBodyFcOutcome({ toolStarted: true, toolCompleted: true, toolContent: '正文', finishReason: 'MAX_TOKENS' }).incomplete, true);
  assert.equal(resolveCreativeBodyFcOutcome({ toolStarted: true, toolCompleted: true, toolContent: '正文', finishReason: 'length' }).incomplete, true);
  assert.deepEqual(resolveCreativeBodyFcOutcome({ toolStarted: false, toolCompleted: false, toolContent: '', plainText: '直接写的正文', finishReason: 'stop' }),
    { outcome: 'no_tool_call', text: '直接写的正文', incomplete: false, finishReason: 'stop' });
  assert.equal(resolveCreativeBodyFcOutcome({ toolStarted: false, toolContent: '', plainText: '', finishReason: '' }).outcome, 'empty');
  console.log('ok - creative body FC outcome picks the tool content, falls back to plain text and flags cut-offs');
}

{
  // 流式包装：参数片段在服务商回调里到达，也要立刻吐出；思考事件原样放行；普通文字只在没调用工具时补上
  const reasoning = { type: 'reasoning', text: '想一想' };
  const outcomes = [];
  const fakeStream = (chunks) => (options) => (async function* () {
    for (const item of chunks) {
      if (item.data) options.onProviderToolCallDelta?.(item.data, { provider: 'vertexai' });
      if (item.yield !== undefined) yield item.yield;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  })();
  const part = p => ({ candidates: [{ content: { parts: [p] } }] });
  const seen = [];
  const out = [];
  for await (const chunk of streamCreativeBodyFc({
    streamChat: fakeStream([
      { yield: reasoning },
      { data: part({ functionCall: { name: CREATIVE_BODY_FC_TOOL_NAME, id: 'v', willContinue: true } }) },
      { data: part({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '第一段' }], willContinue: true } }) },
      { data: part({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '第二段' }], willContinue: true } }), yield: '' },
      { data: { candidates: [{ content: { parts: [{ functionCall: {} }] }, finishReason: 'STOP' }] } },
    ]),
    options: { onProviderToolCallDelta: data => seen.push(data) },
    decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }),
    isReasoningEvent: value => value?.type === 'reasoning',
    onOutcome: outcome => outcomes.push(outcome),
  })) out.push(chunk);
  assert.deepEqual(out, [reasoning, '第一段', '第二段']);
  assert.equal(seen.length, 4, '原本的回调照样收到');
  assert.deepEqual(outcomes.map(item => [item.outcome, item.incomplete]), [['transported', false]]);

  const plainOut = [];
  const plainOutcomes = [];
  for await (const chunk of streamCreativeBodyFc({
    streamChat: fakeStream([{ yield: '没调用' }, { yield: '工具' }, { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }]),
    decoder: createCreativeBodyFcDecoder({ provider: 'deepseek' }),
    onOutcome: outcome => plainOutcomes.push(outcome),
  })) plainOut.push(chunk);
  assert.deepEqual(plainOut, ['没调用工具']);
  assert.equal(plainOutcomes[0].outcome, 'no_tool_call');

  const failing = streamCreativeBodyFc({
    streamChat: () => (async function* () { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); })(),
    decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }),
  });
  await assert.rejects(async () => { for await (const _ of failing) { /* drain */ } }, /aborted/);
  console.log('ok - creative body FC stream yields decoded content as it arrives and keeps reasoning events');
}

{
  // 非流式：从完整回应里取出正文
  const result = await chatCreativeBodyFc({
    chat: async (options) => {
      options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: CREATIVE_BODY_FC_TOOL_NAME, args: { content: '完整回复' } } }] }, finishReason: 'STOP' }] }, { provider: 'vertexai' });
      return '';
    },
    decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }),
  });
  assert.deepEqual(result, { outcome: 'transported', text: '完整回复', incomplete: false, finishReason: 'STOP' });
  const fallback = await chatCreativeBodyFc({ chat: async () => '普通文字回复', decoder: createCreativeBodyFcDecoder({ provider: 'deepseek' }) });
  assert.equal(fallback.outcome, 'no_tool_call');
  assert.equal(fallback.text, '普通文字回复');
  // 完全没拿到正文：交给原本的错误处理，不留下空回复
  await assert.rejects(chatCreativeBodyFc({ chat: async () => '', decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }) }), { code: 'creative_body_fc_empty' });
  const emptyOutcomes = [];
  const emptyStream = streamCreativeBodyFc({
    streamChat: () => (async function* () { yield ''; })(),
    decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }),
    onOutcome: outcome => emptyOutcomes.push(outcome),
  });
  await assert.rejects(async () => { for await (const _ of emptyStream) { /* drain */ } }, { code: 'creative_body_fc_empty' });
  assert.deepEqual(emptyOutcomes, [], '空回复只报错，不另外弹不完整提示');
  console.log('ok - creative body FC reads the content from a non-stream response');
}

{
  // 开关跟着模型设置档：默认关；运行时配置带上；单独切换某个设置档，不做完整校验、不换当前启用的设置档
  const { ConfigManager } = await import('../../src/scripts/storage/config.js');
  const manager = new ConfigManager();
  assert.equal(manager.getDefault().bodyToolTransport, false);
  manager.profileStore = { activeProfileId: 'a', profiles: {
    a: { id: 'a', name: 'studio', provider: 'makersuite', model: 'gemini-4-argon' },
    b: { id: 'b', name: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', bodyToolTransport: true },
  } };
  manager.keyringStore = { keysByProfile: {} };
  manager.storesEnsured = true;
  let persisted = 0;
  manager.persistProfiles = async () => { persisted += 1; };
  manager.config = await manager.buildRuntimeConfig(manager.getActiveProfile());
  assert.equal(manager.config.bodyToolTransport, false);
  assert.equal((await manager.buildRuntimeConfig(manager.getProfileById('b'))).bodyToolTransport, true);
  assert.equal(await manager.setProfileBodyToolTransport('a', true), true);
  assert.equal(manager.getProfileById('a').bodyToolTransport, true);
  assert.equal(manager.config.bodyToolTransport, true, '当前设置档立即生效');
  assert.equal(await manager.setProfileBodyToolTransport('b', false), true);
  assert.equal(manager.getProfileById('b').bodyToolTransport, false);
  assert.equal(manager.config.bodyToolTransport, true, '改别的设置档不动当前运行配置');
  assert.equal(manager.getActiveProfileId(), 'a');
  assert.equal(await manager.setProfileBodyToolTransport('missing', true), false);
  assert.equal(persisted, 2);
  console.log('ok - body tool transport is a per-profile switch that saves without switching profiles');
}

{
  // 轻提示：开关开着却没生效、没调用工具、可能不完整才提示；不支持的接口由 AC 卡片说明，不逐轮提示
  assert.equal(describeCreativeBodyFcNotice({ reason: 'caller_tools' }).message, '请求带有其他工具，本轮未启用防截断传输');
  assert.equal(describeCreativeBodyFcNotice({ reason: 'preset_request_session' }).level, 'info');
  assert.match(describeCreativeBodyFcNotice({ reason: 'thinking_incompatible' }).message, /思考/);
  assert.deepEqual(describeCreativeBodyFcNotice({ outcome: 'transported', incomplete: true }), { level: 'warning', message: '防截断传输：上游提前断流，本条回复可能不完整' });
  assert.equal(describeCreativeBodyFcNotice({ outcome: 'no_tool_call' }).message, '防截断传输：模型这轮没有调用工具，已按普通文字输出');
  for (const quiet of [{ reason: 'disabled' }, { reason: 'unsupported_provider' }, { reason: 'not_creative' }, { outcome: 'transported', incomplete: false }]) {
    assert.equal(describeCreativeBodyFcNotice(quiet), null, JSON.stringify(quiet));
  }
  console.log('ok - body tool transport notices only speak when the switch did not take effect or the reply may be cut');
}

{
  // bridge 接线：工具加在预设请求通道之后、请求预览之前；流式与非流式都改由正文工具取回
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
  const planAt = source.indexOf('const creativeBodyFcPlan = planCreativeBodyFc({');
  assert.ok(planAt > source.indexOf('presetRequestSession = creativeRequest.session;'), '在预设请求通道之后判断');
  assert.ok(planAt < source.indexOf('const preparedRequest = phoneProviderFcRoute.eligible'), '在请求预览之前加上工具');
  assert.match(source, /enabled: config\?\.bodyToolTransport === true,\s*uiMode: presetContext\?\.uiMode,\s*config,\s*requestOptions,\s*presetRequestSession,\s*phoneRoute: phoneProviderFcRoute\.eligible,/);
  assert.match(source, /creativeBodyFc: creativeBodyFcPlan\.active \? \{/);
  assert.match(source, /streamMeta\?\.creativeBodyFc\s*\? streamCreativeBodyFc\(\{/);
  assert.match(source, /if \(creativeBodyFcPlan\.active\) \{\s*const outcome = await chatCreativeBodyFc\(\{/);
  console.log('ok - bridge routes creative replies through the body tool when the switch is on');
}

{
  // AC「正文生成」卡片的开关：显示本会话实际用的设置档（会话绑定 > 模式绑定 > 全局），读写它的值
  const profiles = {
    g: { id: 'g', name: 'vertex', provider: 'vertexai', model: 'gemini-4-argon', baseUrl: '', bodyToolTransport: false },
    c: { id: 'c', name: '自建', provider: 'custom', model: 'x', baseUrl: 'https://example.com/v1' },
  };
  const manager = {
    getActiveProfileId: () => 'g',
    getProfileById: id => (profiles[id] ? { ...profiles[id] } : null),
    setProfileBodyToolTransport: async (id, enabled) => { profiles[id].bodyToolTransport = enabled; return true; },
  };
  const presetStore = { getSessionProfileId: (_type, sid) => (sid === 'rp:bound' ? 'c' : ''), getModeProfileId: () => '' };
  let changed = 0;
  const setting = createBodyToolTransportSetting({ getConfigManager: () => manager, presetStore, onChanged: async () => { changed += 1; } });
  assert.deepEqual(setting.describe('rp:free'), { available: true, profileId: 'g', profileName: 'vertex', enabled: false, supported: true });
  assert.deepEqual(setting.describe('rp:bound'), { available: true, profileId: 'c', profileName: '自建', enabled: false, supported: false });
  assert.equal(await setting.set('rp:free', true), true);
  assert.equal(profiles.g.bodyToolTransport, true);
  assert.equal(changed, 1, '写入后通知另一份设置档重新载入');
  assert.equal(setting.describe('rp:free').enabled, true);
  const missing = createBodyToolTransportSetting({ getConfigManager: () => null, presetStore });
  assert.deepEqual(missing.describe('rp:free'), { available: false });
  assert.equal(await missing.set('rp:free', true), false);

  const { renderBodyToolTransportSection } = await import('../../src/scripts/ui/chat/body-tool-transport-control.js');
  const on = renderBodyToolTransportSection({ available: true, profileName: '<vertex>', enabled: true, supported: true });
  assert.match(on, /data-body-tool-transport-toggle/);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /agent-center-switch is-on/);
  assert.match(on, /&lt;vertex&gt;/);
  assert.match(on, /防截断传输/);
  assert.doesNotMatch(on, /不支持函数调用/);
  const off = renderBodyToolTransportSection({ available: true, profileName: '自建', enabled: false, supported: false });
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /当前接口不支持函数调用/);
  assert.equal(renderBodyToolTransportSection({ available: false }), '');
  console.log('ok - body generation card shows and toggles the switch of the profile the session actually uses');
}

{
  // Vertex 较旧模型（实测 gemini-2.5-flash）不认 streamFunctionCallArguments，回 400：
  // 流式在还没吐出内容时去掉参数重试一次，之后同一模型不再带；非流式本来就不需要这个参数
  const config = { provider: 'vertexai', model: 'gemini-2.5-flash', baseUrl: '' };
  const plan = planCreativeBodyFc({ enabled: true, uiMode: 'rp', config, requestOptions: {} });
  assert.equal(plan.requestOptions.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  const calls = [];
  const out = [];
  for await (const chunk of streamCreativeBodyFc({
    provider: 'vertexai',
    model: 'gemini-2.5-flash',
    streamChat: (options) => {
      calls.push(options.toolConfig.functionCallingConfig.streamFunctionCallArguments);
      if (calls.length === 1) return (async function* () { throw new Error('Vertex AI Error: 400 - Streaming function call arguments is not enabled for this model'); })();
      return (async function* () {
        options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: CREATIVE_BODY_FC_TOOL_NAME, args: { content: '整段' } } }] }, finishReason: 'STOP' }] });
        yield '';
      })();
    },
    options: plan.requestOptions,
    decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }),
  })) out.push(chunk);
  assert.deepEqual(calls, [true, undefined]);
  assert.deepEqual(out, ['整段']);
  const again = planCreativeBodyFc({ enabled: true, uiMode: 'rp', config, requestOptions: {} });
  assert.equal(again.requestOptions.toolConfig.functionCallingConfig.streamFunctionCallArguments, undefined, '记住这个模型不支持');
  assert.equal(planCreativeBodyFc({ enabled: true, uiMode: 'rp', config: { ...config, model: 'gemini-4-argon' }, requestOptions: {} })
    .requestOptions.toolConfig.functionCallingConfig.streamFunctionCallArguments, true, '别的模型照旧');

  let seen = 'unset';
  await chatCreativeBodyFc({
    chat: async (options) => {
      seen = options.toolConfig.functionCallingConfig.streamFunctionCallArguments;
      options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: CREATIVE_BODY_FC_TOOL_NAME, args: { content: 'x' } } }] } }] });
      return '';
    },
    options: { toolConfig: { functionCallingConfig: { mode: 'ANY', streamFunctionCallArguments: true } } },
    decoder: createCreativeBodyFcDecoder({ provider: 'vertexai' }),
  });
  assert.equal(seen, undefined, '非流式不带分段参数');
  console.log('ok - creative body FC drops streamed arguments for Vertex models that reject them');
}

{
  // 截断判断以接口回报的结束原因为准（用户记录：Vertex 约 770 条里 152 条是 SAFETY）；
  // 达到输出上限不算（那是上限太低）；没回报结束原因的接口不猜
  const cut = (provider, finishReason, usageReported = true) => classifyReplyTruncation({ provider, finishReason, usageReported });
  assert.deepEqual(cut('vertexai', 'SAFETY'), { truncated: true, reason: 'safety' });
  assert.equal(cut('makersuite', 'PROHIBITED_CONTENT').reason, 'safety');
  assert.equal(cut('vertexai', 'BLOCKLIST').reason, 'safety');
  assert.equal(cut('openai', 'content_filter').reason, 'safety');
  assert.equal(cut('openrouter', 'error').reason, 'stream_cut');
  assert.equal(cut('vertexai', '').reason, 'stream_cut', '有回报用量却没有结束原因：流没有正常结束');
  for (const [provider, reason, reported] of [['vertexai', '', false], ['custom', '', true], ['vertexai', 'STOP', true], ['vertexai', 'MAX_TOKENS', true], ['openrouter', 'length', true], ['deepseek', 'stop', true], ['anthropic', 'end_turn', true]]) {
    assert.equal(cut(provider, reason, reported).truncated, false, `${provider} ${reason || '(空)'} ${reported}`);
  }

  // 提示：开关关着、创意写作、接口支持、被截断，同一会话只提示一次
  const base = { plan: { active: false, reason: 'disabled' }, uiMode: 'rp', config: vertex, usage: { finishReason: 'SAFETY' }, sessionId: 'rp:hint-a' };
  const first = planCreativeBodyFcTruncationHint(base);
  assert.equal(first.show, true);
  assert.match(first.message, /防截断传输/);
  assert.equal(planCreativeBodyFcTruncationHint(base).show, false, '同一会话只提示一次');
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-b', previewOnly: true }).show, false);
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-c', plan: { active: true } }).show, false, '开着时由传输自己的提示处理');
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-d', uiMode: 'chat' }).show, false);
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-e', usage: { finishReason: 'STOP' } }).show, false);
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-f', config: { provider: 'custom', model: 'x', baseUrl: 'https://example.com/v1' } }).show, false, '接口不支持就不提示');
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-g', plan: { active: false, reason: 'caller_tools' } }).show, false, '开着但这轮跳过时已有别的提示');
  assert.equal(planCreativeBodyFcTruncationHint({ ...base, sessionId: 'rp:hint-h', phoneRoute: true }).show, false);
  console.log('ok - truncated replies suggest body tool transport once per session when it is off');
}

{
  // APP 知识：女仆问到截断时知道开关在哪，并能直接打开到开关的位置（不代为切换）
  const { listAppFeatures, buildAppFeatureKnowledgeText } = await import('../../src/scripts/agent/app-feature-catalog.js');
  const { searchMaidCapabilityConcepts } = await import('../../src/scripts/agent/maid-capability-concept-retriever.js');
  const feature = listAppFeatures().find(item => item.id === 'creative.body_tool_transport');
  assert.ok(feature, '功能目录有防截断传输');
  assert.equal(feature.title, '防截断传输');
  assert.deepEqual(feature.tools, ['app.open_panel']);
  assert.match(feature.argsHint, /panel[^。]*agent-center[^。]*focus[^。]*body-tool-transport/u);
  assert.equal(feature.directAction, '', '不抢 app.open_panel 的功能归属');
  assert.equal(feature.writes, false);
  assert.ok(feature.uiPath.includes('正文生成') && feature.uiPath.includes('防截断传输'));
  assert.match(buildAppFeatureKnowledgeText(), /防截断传输/);
  for (const input of ['回复老是被截断怎么办', '写到一半就断了', 'Gemini 的回复总是不完整', '防截断在哪里开']) {
    const ids = searchMaidCapabilityConcepts(input, { features: listAppFeatures() }).map(item => item.id);
    assert.ok(ids.includes('creative.body_tool_transport'), `${input} → 防截断传输（实际：${ids.slice(0, 8).join(', ')}）`);
  }
  console.log('ok - maid app knowledge explains where to turn on body tool transport');
}

{
  // 点通知跳到卡片开关：bridge 发事件，app.js 打开 AC 再交给画板面板定位
  const { readFile } = await import('node:fs/promises');
  const bridge = await readFile(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
  assert.equal((bridge.match(/suggestCreativeBodyFcOnTruncation\(\);/g) || []).length, 2, '流式与非流式结束后都检查');
  assert.match(bridge, /new CustomEvent\('open-body-tool-transport'/);
  const app = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /addEventListener\('open-body-tool-transport'/);
  const panel = await readFile(new URL('../../src/scripts/ui/chat/hopscotch-board-panel.js', import.meta.url), 'utf8');
  assert.match(panel, /openBodyToolTransport: async \(\) => \{/);
  // 女仆 app.open_panel（agent-center + focus）走同一条跳转，并回报有没有定位到开关
  assert.match(app, /'agent-center': options => \(options\?\.focus === 'body-tool-transport'/);
  assert.match(app, /new CustomEvent\('open-body-tool-transport', \{ detail: \{ resolve \} \}\)/);
  assert.match(app, /event\?\.detail\?\.resolve\?\.\(/);
  console.log('ok - clicking the truncation notice opens the body generation card switch');
}
