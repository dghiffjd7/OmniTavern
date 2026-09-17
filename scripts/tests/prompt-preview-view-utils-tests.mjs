import assert from 'node:assert/strict';

import {
  buildFullPromptDocument,
  buildPromptOverviewView,
} from '../../src/scripts/ui/chat/prompt-preview-view-utils.js';
import { initializeI18n } from '../../src/scripts/i18n/index.js';

const request = {
  at: Date.UTC(2026, 7, 1, 3, 4, 5),
  requestId: 'request-42',
  provider: 'custom',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.example.test/v1',
  stream: true,
  session: { id: 'session-1', name: '测试聊天室', isGroup: false },
  configProfile: { id: 'profile-1', source: 'session', bound: true },
  options: { temperature: 0.7, maxTokens: 2048 },
  requestOptions: {
    temperature: 0.6,
    tools: [{ name: 'must-not-expand-tool-schema', description: 'very large schema' }],
  },
  messages: [
    { role: 'system', content: '# 规则\n<format>保持角色</format>' },
    { role: 'user', content: 'OVERVIEW_MUST_NOT_REPEAT_THIS_MESSAGE' },
  ],
  responsePrefix: '<assistant_prefill>',
  webSearch: {
    enabled: true,
    route: 'openrouter_native',
    execution: 'provider_native',
  },
  webSearchStatus: {
    state: 'done',
    execution: 'provider_native',
    engine: 'exa',
  },
  phoneReplyTransport: {
    requestedMode: 'provider_fc',
    effectiveMode: 'fc_fallback',
    fallbackReason: 'invalid_phone_reply_ir',
    providerRolloutReason: '',
    capabilitySource: 'verified_seed',
    snapshotFingerprint: 'chat-semantic-v1:1234abcd:88',
    thinkingRequested: true,
    thinkingEnabled: false,
    thinkingOverrideReason: 'deepseek_forced_tool_choice_incompatible',
    terminalToolSchema: {
      redacted: true,
      toolName: 'emit_private_reply',
      schema: {
        type: 'object',
        properties: {
          targetId: { enum: ['[redacted:2 values]'] },
        },
      },
    },
  },
  injectionAudit: {
    totalEstimateTokens: 1234,
    inputBudgetTokens: 8192,
    segments: [{ id: 'fixed', label: '固定提示词', usedTokens: 1234 }],
  },
  responseDiagnostics: {
    latencyMs: 3100,
    firstTokenLatencyMs: 700,
    outputDurationMs: 2400,
    tokensPerSecond: 50,
    promptTokens: 1200,
    completionTokens: 120,
    systemFingerprint: 'fp_2026_08_01_alpha',
    modelVersion: 'model-version-42',
    responseId: 'response-42',
    responseModel: 'actual-model-42',
    routedProvider: 'upstream-42',
    webSearchRequests: 2,
    webSearchTokens: 320,
    webSearchEngine: 'exa',
    providerCalls: [
      {
        callIndex: 1,
        mode: 'provider_fc',
        outcome: 'fallback',
        provider: 'custom',
        model: 'deepseek-v4-flash',
        latencyMs: 900,
      },
      {
        callIndex: 2,
        mode: 'legacy_text_fallback',
        outcome: 'succeeded',
        provider: 'custom',
        model: 'deepseek-v4-flash',
        latencyMs: 2200,
        completionTokens: 120,
      },
    ],
  },
};

{
  const view = buildPromptOverviewView(request, {
    injectionAuditHtml: '<section data-memory-injection-audit>audit</section>',
    injectionAuditText: '注入总量：约 1234 token',
  });
  assert.equal(view.html.includes('OVERVIEW_MUST_NOT_REPEAT_THIS_MESSAGE'), false);
  assert.equal(view.plain.includes('OVERVIEW_MUST_NOT_REPEAT_THIS_MESSAGE'), false);
  assert.equal(view.html.includes('must-not-expand-tool-schema'), false);
  assert.match(view.html, /本次注入构成/);
  assert.match(view.html, /请求配置/);
  assert.match(view.html, /首字延迟/);
  assert.match(view.html, /700 ms/);
  assert.match(view.html, /50\.0 tok\/s/);
  assert.match(view.html, /fp_2026_08_01_alpha/);
  assert.match(view.html, /model-version-42/);
  assert.match(view.html, /response-42/);
  assert.match(view.html, /Provider calls · 2/);
  assert.match(view.html, /web_search_route/);
  assert.match(view.html, /openrouter_native/);
  assert.match(view.html, /原生搜索次数/);
  assert.match(view.html, />2</);
  assert.match(view.plain, /web search state: done/);
  assert.match(view.plain, /web search engine: exa/);
  assert.match(view.plain, /web search tokens: 320/);
  assert.match(view.html, /legacy_text_fallback/);
  assert.match(view.html, /2 条消息/);
  assert.match(view.html, /FC 失败后文本回退/);
  assert.match(view.html, /invalid_phone_reply_ir/);
  assert.match(view.html, /deepseek_forced_tool_choice_incompatible/);
  assert.match(view.html, /终态工具 Schema（已脱敏）/);
  assert.match(view.html, /emit_private_reply/);
  assert.match(view.html, /redacted:2 values/);
  assert.match(view.plain, /transport: fc_fallback/);
  assert.match(view.plain, /snapshot: chat-semantic-v1:1234abcd:88/);
  assert.match(view.plain, /FC thinking requested: true/);
  assert.match(view.plain, /FC thinking enabled: false/);
  assert.match(view.plain, /FC thinking override: deepseek_forced_tool_choice_incompatible/);
  assert.match(view.plain, /system fingerprint: fp_2026_08_01_alpha/);
  assert.match(view.plain, /model version: model-version-42/);
  assert.match(view.plain, /provider call #2: legacy_text_fallback/);
  console.log('ok - prompt overview summarizes request diagnostics without repeating message bodies');
}

{
  const doc = buildFullPromptDocument(request);
  assert.match(doc.html, /data-prompt-line-number="1"/);
  assert.match(doc.html, /data-prompt-role="system"/);
  assert.match(doc.html, /data-prompt-role="user"/);
  assert.match(doc.html, /prompt-inline-tag/);
  assert.match(doc.html, /data-prompt-wrap-toggle/);
  assert.match(doc.html, /data-prompt-copy-all/);
  assert.match(doc.plain, /\[system\] #1/);
  assert.match(doc.plain, /OVERVIEW_MUST_NOT_REPEAT_THIS_MESSAGE/);
  assert.match(doc.plain, /\[assistant prefill\]/);
  assert.equal(doc.messageCount, 3);
  assert.ok(doc.lineCount >= 7);
  assert.ok(doc.charCount > 0);
  console.log('ok - full prompt document preserves roles, line numbers, prompt text and prefill');
}

{
  const doc = buildFullPromptDocument({
    messages: [{ role: 'user', content: '<script>alert("x")</script>' }],
  });
  assert.equal(doc.html.includes('<script>'), false);
  assert.match(doc.html, /&lt;script&gt;/);
  console.log('ok - full prompt document escapes prompt content before inline highlighting');
}

{
  const jsonRequest = {
    provider: 'kimi',
    model: 'kimi-k3',
    messages: [
      {
        role: 'system',
        content: '本轮使用 JSON 结构化终态；完整回复必须且只能是一个 JSON 对象。\n必须严格满足以下 JSON Schema：{}',
      },
      { role: 'user', content: '你好' },
    ],
    requestOptions: { response_format: { type: 'json_object' }, thinking: { type: 'enabled' } },
    phoneReplyTransport: {
      previewState: 'predicted',
      requestedMode: 'json_terminal',
      effectiveMode: 'json_terminal',
      routeLayer: 'json_after_fc_circuit',
      routeReason: 'circuit_open',
      fallbackFrom: 'provider_fc',
      adapter: 'private_reply',
      evidenceStatus: 'unobserved',
      evidenceStrictSuccessCount: 0,
      circuitOpen: false,
      schemaEstimateTokens: 321,
      jsonContract: {
        version: 'phone.reply.ir.v1',
        formatMode: 'json_object',
        schema: { type: 'object', required: ['version', 'payload'] },
      },
    },
  };
  const view = buildPromptOverviewView(jsonRequest);
  assert.match(view.html, /候选路由（预测）/);
  assert.match(view.html, /JSON 终态/);
  assert.match(view.html, /FC 熔断后降级/);
  assert.match(view.html, /response_format · json_object/);
  assert.match(view.html, /JSON 输出合同/);
  assert.match(view.html, /321 tok/);
  assert.match(view.plain, /route state: predicted/);
  assert.match(view.plain, /route layer: json_after_fc_circuit/);
  assert.match(view.plain, /transport reason: circuit_open/);

  const documentView = buildFullPromptDocument(jsonRequest);
  assert.match(documentView.html, /JSON 输出合同/);
  assert.match(documentView.html, /<details[^>]*class="prompt-document-contract"/);
  assert.match(documentView.plain, /本轮使用 JSON 结构化终态/);
  console.log('ok - predicted JSON route exposes the real contract and collapses it as transport metadata');
}

{
  const disguise = /MiPhone_start|MiPhone_end|msg_start|msg_end|moment_start|moment_reply_start/u;
  const structuredRequests = [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '共享语义与本轮唯一结构化终态说明' },
        { role: 'user', content: '你好' },
      ],
      phoneReplyTransport: {
        previewState: 'actual',
        requestedMode: 'provider_fc',
        effectiveMode: 'provider_fc',
        adapter: 'phone_batch',
        terminalToolSchema: {
          redacted: false,
          toolName: 'emit_phone_batch',
          schema: { type: 'object', properties: { items: { type: 'array' } } },
        },
      },
    },
    {
      provider: 'kimi',
      model: 'kimi-k3',
      messages: [
        { role: 'system', content: '本轮使用 JSON 结构化终态；完整回复必须且只能是一个 JSON 对象。' },
        { role: 'user', content: '你好' },
      ],
      phoneReplyTransport: {
        previewState: 'actual',
        requestedMode: 'json_terminal',
        effectiveMode: 'json_terminal',
        adapter: 'private_reply',
        jsonContract: {
          version: 'phone.reply.ir.v1',
          formatMode: 'json_object',
          schema: { type: 'object', required: ['version', 'payload'] },
        },
      },
    },
  ];
  for (const structuredRequest of structuredRequests) {
    const view = buildPromptOverviewView(structuredRequest);
    const doc = buildFullPromptDocument(structuredRequest);
    assert.doesNotMatch(view.html, disguise);
    assert.doesNotMatch(view.plain, disguise);
    assert.doesNotMatch(doc.html, disguise);
    assert.doesNotMatch(doc.plain, disguise);
  }
  console.log('ok - structured route rendering never fabricates MiPhone text protocol markers');
}

{
  const globalRequest = {
    messages: [
      { role: 'system', content: 'GLOBAL SEMANTIC CONTENT' },
      { role: 'user', content: 'hello' },
    ],
    injectionAudit: {
      totalEstimateTokens: 20,
      globalPrompt: {
        usedTokens: 7,
        injected: [{
          id: 'global-a',
          name: '人物一致性',
          anchor: 'semantic_header',
          content: 'GLOBAL SEMANTIC CONTENT',
          estimatedTokens: 7,
        }],
        skipped: [{
          id: 'global-b',
          name: '旧格式块',
          reason: 'format_protocol_instruction',
          message: '检测到回复格式指令；请放入会话预设',
        }],
      },
    },
  };
  const overview = buildPromptOverviewView(globalRequest);
  const full = buildFullPromptDocument(globalRequest);
  assert.match(overview.html, /全局提示词 ×1/);
  assert.match(overview.html, /全局提示词 ~7 tok/);
  assert.match(overview.plain, /global prompt skipped: 旧格式块/);
  assert.match(full.html, /全局提示词/);
  assert.match(full.html, /人物一致性 · semantic_header/);
  assert.match(full.html, /GLOBAL SEMANTIC CONTENT/);
  console.log('ok - Prompt transparency badges and audits global semantic blocks');
}

{
  const view = buildPromptOverviewView({
    provider: 'deepseek',
    model: 'future-model',
    messages: [{ role: 'system', content: 'FC transport instruction' }],
    requestOptions: {
      tool_choice: { type: 'function', name: 'emit_private_reply' },
      parallel_tool_calls: false,
      reasoning: { effort: 'none' },
    },
    phoneReplyTransport: {
      previewState: 'actual',
      requestedMode: 'provider_fc',
      effectiveMode: 'fc_fallback',
      routeLayer: 'fc_probation',
      fallbackReason: 'no_tool_call',
      schemaEstimateTokens: 435,
      terminalToolSchema: {
        redacted: true,
        toolName: 'emit_private_reply',
        schema: { type: 'object', required: ['messages'] },
      },
    },
    responseDiagnostics: {
      providerCalls: [
        { callIndex: 1, mode: 'provider_fc', outcome: 'fallback', totalTokens: 100 },
        { callIndex: 2, mode: 'legacy_text_fallback', outcome: 'succeeded', totalTokens: 80 },
      ],
    },
  });
  assert.match(view.html, /实际路由/);
  assert.match(view.html, /FC 失败后文本回退/);
  assert.match(view.html, /tool_choice · emit_private_reply/);
  assert.match(view.html, /parallel_tool_calls · false/);
  assert.match(view.html, /reasoning.effort · none/);
  assert.match(view.html, /总计 180 tok/);
  assert.match(view.html, /<details[^>]*open/);
  console.log('ok - actual FC fallback is warning-expanded and reconciles both provider calls');
}

{
  const view = buildPromptOverviewView({
    provider: 'makersuite',
    model: 'gemini-3.7-flash',
    requestOptions: {
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['emit_phone_batch'],
        },
      },
    },
    phoneReplyTransport: {
      previewState: 'predicted',
      requestedMode: 'provider_fc',
      effectiveMode: 'provider_fc',
      routeLayer: 'verified_native_fc',
    },
  });
  assert.match(view.html, /tool_choice · ANY · emit_phone_batch/);
  console.log('ok - Gemini FC prediction renders its actual function-calling policy');
}

{
  const view = buildPromptOverviewView({
    provider: 'opencode',
    model: 'glm-5.2',
    messages: [{ role: 'system', content: 'actual structured request' }],
    phoneReplyTransport: {
      previewState: 'actual',
      requestedMode: 'provider_fc',
      effectiveMode: 'provider_fc',
      routeLayer: 'verified_native_fc',
      semanticMessageEstimateTokens: 1200,
      contractInstructionEstimateTokens: 80,
      schemaEstimateTokens: 435,
      terminalToolSchema: {
        redacted: false,
        toolName: 'emit_phone_batch',
        schema: { type: 'object', properties: { targetId: { const: 'group:actual' } } },
      },
      contractSummary: {
        frozenTarget: {
          targetName: '真实测试群',
          members: [{ id: 'member:1', name: '群成员甲' }],
        },
        allowedItemTypes: ['text', 'sticker'],
        allowedStickerKeywords: ['微笑', '点头'],
        tableTargets: [{ id: 'relations', name: '关系表', rowIds: ['r1', 'r2'] }],
        fixedOrder: ['primary_reply', 'table_edit'],
      },
    },
  });
  assert.match(view.html, /语义消息 ~1,200 tok/);
  assert.match(view.html, /合同指令 ~80 tok/);
  assert.match(view.html, /Schema ~435 tok/);
  assert.match(view.html, /真实测试群/);
  assert.match(view.html, /冻结群成员/);
  assert.match(view.html, /群成员甲/);
  assert.match(view.html, /微笑、点头/);
  assert.match(view.html, /<span data-i18n-skip>关系表<\/span><span>（2 行）<\/span>/);
  assert.match(view.html, /group:actual/);
  assert.doesNotMatch(view.html, /完整 Schema（已脱敏）/);
  assert.match(view.plain, /冻结目标: 真实测试群/);
  console.log('ok - local Prompt transparency shows real per-turn contracts and token attribution');
}

{
  const view = buildPromptOverviewView({
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
    responseDiagnostics: {
      latencyMs: null,
      firstTokenLatencyMs: null,
      tokensPerSecond: null,
      completionTokens: null,
    },
  });
  assert.match(view.plain, /total latency: —/);
  assert.match(view.plain, /first token latency: 未记录/);
  assert.match(view.plain, /output speed: —/);
  assert.match(view.plain, /completion tokens: —/);
  assert.doesNotMatch(view.plain, /0(?:\.0)? (?:ms|tok\/s)/);
  console.log('ok - prompt overview preserves unavailable diagnostics instead of coercing null to zero');
}

{
  for (const stream of [true, false]) {
    const view = buildPromptOverviewView({
      stream,
      responseDiagnostics: { latencyMs: 86394, firstTokenLatencyMs: 86376,
        completionTokens: 4337, outputDurationMs: 18, tokensPerSecond: 240944.4 },
    });
    assert.match(view.plain, /output speed: —/);
    assert.doesNotMatch(view.html, /240944/);
    assert.match(view.html, stream ? /未观察到持续分段输出，无法测量/ : /非流式回复无法测量输出速度/);
  }
  console.log('ok - prompt view suppresses invalid legacy burst TPS without rewriting history');
  await initializeI18n({
    preference: 'en',
    documentLike: null,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        '供应方未返回': 'Not returned by provider',
        '本轮没有改变行为的结构化请求参数': 'No structured request parameters changed behavior for this request',
        '暂无 Prompt 内容': 'No Prompt content',
      }),
    }),
  });
  const view = buildPromptOverviewView({ messages: [], responseDiagnostics: {} });
  assert.match(view.html, /Not returned by provider/);
  assert.match(view.html, /No structured request parameters changed behavior for this request/);
  assert.match(view.plain, /system fingerprint: Not returned by provider/);
  assert.doesNotMatch(view.html, /供应方未返回|本轮没有改变行为的结构化请求参数/);
  const full = buildFullPromptDocument({ messages: [] });
  assert.match(full.html, /No Prompt content/);
  assert.doesNotMatch(full.html, /暂无 Prompt 内容/);
  console.log('ok - unavailable provider identity is localized inside skipped code content');
}
