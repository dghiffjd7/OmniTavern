import assert from 'node:assert/strict';

import {
  buildPhoneBatchStructuredPromptMessages,
  buildPhoneBatchStructuredTransportInstruction,
  normalizePhoneBatchProviderFcCalls,
  preparePhoneBatchProviderFcRoute,
  resolvePhoneBatchProviderFcEligibility,
  runPhoneBatchGenerationWithFallback,
  runPhoneBatchProviderFcAttempt,
  sanitizePhoneBatchSemanticText,
} from '../../src/scripts/ui/chat/phone-batch-provider-fc.js';
import { PHONE_REPLY_IR_BATCH_TOOL_NAME } from '../../src/scripts/ui/chat/phone-reply-batch-ir.js';
import { assembleLegacyTextRequest } from '../../src/scripts/ui/chat/chat-semantic-snapshot-utils.js';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';

const config = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com/v1',
};
const groupTarget = {
  mode: 'group_chat',
  sessionId: 'group:investigation',
  targetName: '调查组',
  userName: '我',
  members: [
    { id: 'contact:frieren', name: '菲伦' },
    { id: 'contact:fern', name: '芙莉莲' },
  ],
  momentAuthors: [
    { id: 'contact:frieren', name: '菲伦' },
    { id: 'contact:fern', name: '芙莉莲' },
  ],
  tableTargets: [{ id: 'event', name: '事件', rowIds: [] }],
};
const capabilities = {
  momentPost: true,
  imagePrompt: true,
  tableEdit: true,
  variableUpdate: true,
  summary: true,
};
const context = {
  uiMode: 'chat',
  surface: 'group_chat',
  responseTarget: 'character',
  usesBuiltinFormat: true,
  usesDefaultPreset: true,
  compatibilityModeEnabled: false,
  protocolParserEnabled: true,
  hasUnsupportedSideEffects: false,
  assistantContinuation: false,
  webSearchEnabled: false,
  hasProviderTools: false,
  formatProfileEnabled: false,
};

{
  [
    config,
    { provider: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com/v1' },
    { provider: 'makersuite', model: 'gemini-3.6-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
    { provider: 'opencode', model: 'glm-5.3', baseUrl: 'https://opencode.ai/zen/go/v1' },
  ].forEach((providerConfig) => {
    const result = resolvePhoneBatchProviderFcEligibility({
      enabled: true,
      config: providerConfig,
      client: { chat() {} },
      messages: [{ role: 'user', content: '测试' }],
      context,
      target: groupTarget,
    });
    assert.equal(result.eligible, true, providerConfig.provider);
  });
  const custom = resolvePhoneBatchProviderFcEligibility({
    enabled: true,
    config: { provider: 'custom', model: 'gemini-3.1-pro-preview', baseUrl: 'https://gcli.example/v1' },
    client: { chat() {} },
    messages: [{ role: 'user', content: '测试' }],
    context,
    target: groupTarget,
  });
  assert.equal(custom.eligible, false);
  assert.equal(custom.reason, 'unverified_custom_endpoint');
  console.log('ok - batch FC allows verified official providers and fails closed for custom gateways');
}

const phoneLayer = '<线上格式>\nMiPhone_start\nmsg_start\nmsg_end\nMiPhone_end\n</线上格式>';
const outputLayer = '在调查组中群聊\nMiPhone_start\nmsg_start\nmsg_end\nMiPhone_end';
const memoryLayer = [
  '<memory_edit_rules>',
  '目标：事件表。仅记录当前状态；只允许 insert/update，不允许 delete。',
  '列定义：event_id:string（必填，作为行身份）；note:string（必填）；score:number（可选）。',
  '更新条件：event_id 相同则 update 对应行，否则 insert 新行。',
  '请在回复末尾严格按以下 XML 文本格式输出，除此之外不要输出解释：',
  '<tableEdit>',
  '{"action":"insert","table_id":"event","data":{"note":"示例"}}',
  '</tableEdit>',
  '表格索引:',
  '[0] 事件 (table_id:event, cols:note:内容)',
  '</memory_edit_rules>',
].join('\n');
const summaryLayer = [
  '每次回复后用一句纯中文概括。',
  '<details><summary>摘要</summary>示例</details>',
  '[summary_format]',
].join('\n');
const imageLayer = '需要新图时输出 <image_prompt>完整提示词</image_prompt>。';

{
  const result = resolvePhoneBatchProviderFcEligibility({
    enabled: true,
    config,
    client: { chat() {} },
    messages: [{ role: 'user', content: '测试' }],
    context: { ...context, hasUnsupportedSideEffects: true },
    target: groupTarget,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unsupported_side_effects');
  console.log('ok - unresolved structured side effects fail closed before any provider tool request');
}

{
  const semantic = sanitizePhoneBatchSemanticText([
    '请根据关系是否足够亲密，判断是否需要私聊。',
    '只输出一个 <content>...</content> 区块。',
    '公开评论仍必须输出 moment_reply_start/moment_reply_end。',
    '评论人--评论内容--reply_to::A0',
    '<我和联系人名的私聊>',
    '联系人名--消息内容',
    '</我和联系人名的私聊>',
    '<群聊：群名>',
    '群成员名--消息内容',
    '</群聊：群名>',
  ].join('\n'));
  assert.match(semantic, /关系是否足够亲密/u);
  assert.match(semantic, /moment_comment item/u);
  assert.doesNotMatch(semantic, /moment_reply_(?:start|end)|<content>|的私聊>|<群聊|--/u);
  console.log('ok - semantic sanitizer keeps moment policy while removing inline legacy transport examples');
}

{
  // 英文摘要提示词的示例标签是 Summary，FC 模式下同样要换成 summary item，不能留下文字格式示例。
  const semantic = sanitizePhoneBatchSemanticText([
    'At the end of every reply, add a one-sentence summary.',
    '<details><summary>Summary</summary>',
    'One sentence.',
    '</details>',
  ].join('\n'));
  assert.match(semantic, /summary item/u);
  assert.doesNotMatch(semantic, /<details>|<summary>/u);
  console.log('ok - semantic sanitizer replaces the English summary example');
}

{
  const instruction = buildPhoneBatchStructuredTransportInstruction({
    target: {
      ...groupTarget,
      tableTargets: [
        { id: 'event', name: '事件', rowIds: ['event-row-1', 'event-row-2'] },
        { id: 'empty', name: '空表', rowIds: [] },
      ],
    },
    capabilities,
    allowedItemTypes: ['text', 'sticker', 'voice', 'music', 'image'],
    allowedStickerKeywords: ['收到'],
  });
  assert.match(instruction, /contact:frieren.*菲伦/u);
  assert.match(instruction, /event=事件（现有 rowIndex：0–1；rowId 见该表 schema）/u);
  assert.match(instruction, /empty=空表（无现有行，只能 init\/insert）/u);
  assert.match(instruction, /chat → moment_post → image_prompt → table_edit → variable_update → summary/u);
  assert.match(instruction, /moment_post item 只能包含 kind 与 posts/u);
  assert.doesNotMatch(instruction, /MiPhone_start|msg_start|<tableEdit>|<image_prompt>/u);
  console.log('ok - batch transport instruction names frozen identities and ordered capabilities without text syntax');
}

{
  const sourceMessages = [
    { role: 'system', content: `角色语义\n\n${phoneLayer}` },
    { role: 'system', content: memoryLayer },
    { role: 'system', content: summaryLayer },
    { role: 'system', content: imageLayer },
    { role: 'user', content: '大家准备好了吗？' },
    { role: 'system', content: outputLayer },
  ];
  const result = buildPhoneBatchStructuredPromptMessages({
    messages: sourceMessages,
    transportPlan: {
      surface: 'group_chat',
      phoneFormatPromptContent: phoneLayer,
      outputFormatReminder: outputLayer,
      removableProtocolBlocks: [
        { id: 'memory', content: memoryLayer },
        { id: 'summary', content: summaryLayer },
        { id: 'image', content: imageLayer },
      ],
      semanticSources: [
        { id: 'memory', content: memoryLayer },
        { id: 'summary', content: summaryLayer },
        { id: 'image', content: imageLayer },
      ],
    },
    instruction: buildPhoneBatchStructuredTransportInstruction({ target: groupTarget, capabilities }),
  });
  assert.equal(result.ok, true, result.reason);
  const combined = result.messages.map(message => String(message?.content || '')).join('\n');
  assert.doesNotMatch(combined, /MiPhone_start|msg_start|<tableEdit>|<image_prompt>|<details>|\[summary_format\]/u);
  assert.match(combined, /角色语义/u);
  assert.match(combined, /目标：事件表/u);
  assert.match(combined, /event_id:string（必填，作为行身份）/u);
  assert.match(combined, /note:string（必填）/u);
  assert.match(combined, /只允许 insert\/update，不允许 delete/u);
  assert.match(combined, /event_id 相同则 update 对应行，否则 insert 新行/u);
  assert.match(combined, /table_id:event/u);
  assert.doesNotMatch(combined, /严格按以下 XML 文本格式输出|除此之外不要输出解释/u);
  assert.match(combined, /每次回复后用一句纯中文概括/u);
  assert.equal(sourceMessages[0].content.includes('MiPhone_start'), true);
  assert.match(result.snapshotFingerprint, /^chat-semantic-v1:/u);
  const fallbackMessages = assembleLegacyTextRequest(result.semanticSnapshot).messages;
  assert.deepEqual(fallbackMessages, sourceMessages);
  assert.equal(fallbackMessages.filter(message => message.content === memoryLayer).length, 1);

  const missingOwnedBlock = buildPhoneBatchStructuredPromptMessages({
    messages: sourceMessages.filter(message => message.content !== memoryLayer),
    transportPlan: {
      surface: 'group_chat',
      phoneFormatPromptContent: phoneLayer,
      outputFormatReminder: outputLayer,
      removableProtocolBlocks: [{ id: 'memory', content: memoryLayer }],
    },
    instruction: '结构化传输',
  });
  assert.equal(missingOwnedBlock.ok, false);
  assert.equal(missingOwnedBlock.reason, 'text_transport_layer_mismatch');
  console.log('ok - batch prompt removes each owned protocol block exactly once and preserves sanitized semantics');
}

{
  const phoneMarker = '\uE000chat-semantic:req-batch:phone_format\uE001';
  const outputMarker = '\uE000chat-semantic:req-batch:output_format\uE001';
  const prepared = preparePhoneBatchProviderFcRoute({
    enabled: true,
    config,
    client: { chat() {} },
    messages: [
      { role: 'system', content: '群聊共享语义' },
      { role: 'system', content: phoneMarker },
      { role: 'user', content: '集合了吗？' },
      { role: 'system', content: outputMarker },
    ],
    transportPlan: {
      surface: 'group_chat',
      phoneFormatPromptContent: phoneLayer,
      outputFormatReminder: outputLayer,
      transportLayersDeferred: true,
      deferredLegacyLayers: [
        { id: 'phone_format', content: phoneLayer, marker: phoneMarker },
        { id: 'output_format', content: outputLayer, marker: outputMarker },
      ],
    },
    context,
    target: groupTarget,
    capabilities: {},
    snapshotContext: {
      requestId: 'req-batch',
      turnId: 'turn-batch',
      sessionId: groupTarget.sessionId,
    },
  });
  assert.equal(prepared.eligible, true, prepared.reason);
  assert.equal(prepared.messages.some(message => String(message?.content || '').includes('chat-semantic:')), false);
  assert.equal(prepared.semanticSnapshot.identity.turnId, 'turn-batch');
  assert.equal(prepared.toolSchemaDiagnostics.redacted, true);
  assert.equal(prepared.toolSchemaDiagnostics.toolName, PHONE_REPLY_IR_BATCH_TOOL_NAME);
  assert.equal(JSON.stringify(prepared.toolSchemaDiagnostics).includes('contact:frieren'), false);
  const legacy = assembleLegacyTextRequest(prepared.semanticSnapshot);
  assert.equal(legacy.messages[1].content, phoneLayer);
  assert.equal(legacy.messages[3].content, outputLayer);
  console.log('ok - batch FC direct assembly consumes deferred named anchors and preserves lazy legacy order');
}

const emitToolCall = (options, args, id = 'call-batch-1') => {
  options.onProviderToolCallDelta({
    choices: [{
      message: {
        tool_calls: [{
          id,
          type: 'function',
          function: { name: PHONE_REPLY_IR_BATCH_TOOL_NAME, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
};

const validArgs = {
  items: [{
    kind: 'chat',
    messages: [{ speakerId: 'contact:frieren', content: '准备好了。', time: '08:10' }],
  }],
};

{
  const normalized = normalizePhoneBatchProviderFcCalls({
    completedToolCalls: [{
      toolName: PHONE_REPLY_IR_BATCH_TOOL_NAME,
      arguments: validArgs,
    }],
    target: groupTarget,
    capabilities,
  });
  assert.equal(normalized.ok, true, normalized.reason);
  const parser = new DialogueStreamParser({ userName: '我' });
  const events = parser.push(normalized.raw);
  assert.equal(events[0].type, 'group_chat');
  assert.equal(events[0].groupName, '调查组');

  const unknownSpeaker = normalizePhoneBatchProviderFcCalls({
    completedToolCalls: [{
      toolName: PHONE_REPLY_IR_BATCH_TOOL_NAME,
      arguments: {
        items: [{ kind: 'chat', messages: [{ speakerId: 'contact:unknown', content: '越权' }] }],
      },
    }],
    target: groupTarget,
    capabilities,
  });
  assert.equal(unknownSpeaker.ok, false);
  assert.equal(unknownSpeaker.reason, 'invalid_phone_reply_ir');

  const repairedQuote = normalizePhoneBatchProviderFcCalls({
    completedToolCalls: [{
      toolName: PHONE_REPLY_IR_BATCH_TOOL_NAME,
      metadata: {
        streamingArgumentsText: '{"items":[{"kind":"chat","messages":[{"speakerId":"contact:frieren","content":"她说"回来吧"。"}]}]}',
      },
    }],
    target: groupTarget,
    capabilities,
  });
  assert.equal(repairedQuote.ok, true, repairedQuote.reason);
  assert.equal(repairedQuote.ir.items[0].messages[0].content, '她说"回来吧"。');
  assert.equal(repairedQuote.argumentRepairApplied, true);
  assert.deepEqual(repairedQuote.argumentRepairKinds, ['unescaped_quote']);

  const missingComma = normalizePhoneBatchProviderFcCalls({
    completedToolCalls: [{
      toolName: PHONE_REPLY_IR_BATCH_TOOL_NAME,
      metadata: {
        streamingArgumentsText: '{"items":[{"kind":"chat" "messages":[]}]}',
      },
    }],
    target: groupTarget,
    capabilities,
  });
  assert.equal(missingComma.ok, false);
  assert.equal(missingComma.reason, 'invalid_arguments_json');
  console.log('ok - batch tool normalization validates frozen targets before canonical serialization');
}

{
  const transportPlan = {
    surface: 'group_chat',
    phoneFormatPromptContent: phoneLayer,
    outputFormatReminder: outputLayer,
  };
  const legacyMessages = [
    { role: 'system', content: `角色语义\n\n${phoneLayer}` },
    { role: 'user', content: '准备好了吗？' },
    { role: 'system', content: outputLayer },
  ];
  const prepared = preparePhoneBatchProviderFcRoute({
    enabled: true,
    config,
    client: { chat() {} },
    messages: legacyMessages,
    transportPlan,
    context,
    target: groupTarget,
    capabilities: {},
  });
  assert.equal(prepared.eligible, true, prepared.reason);

  let calls = 0;
  const success = await runPhoneBatchProviderFcAttempt({
    client: {
      async chat(_messages, options) {
        calls += 1;
        emitToolCall(options, validArgs);
        return '';
      },
    },
    config,
    messages: prepared.messages,
    context,
    target: groupTarget,
    capabilities: {},
  });
  assert.equal(success.ok, true, success.reason);
  assert.equal(calls, 1);

  const invalid = await runPhoneBatchProviderFcAttempt({
    client: {
      async chat(_messages, options) {
        emitToolCall(options, {
          items: [{
            kind: 'chat',
            messages: [{
              type: 'text',
              speakerId: 'contact:frieren',
              content: 'MiPhone_end',
            }],
          }],
        });
        return '';
      },
    },
    config,
    messages: prepared.messages,
    context,
    target: groupTarget,
    capabilities: {},
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid_phone_reply_ir');
  assert.deepEqual(invalid.diagnostics.validationErrorCodes, ['item.content.protocol_control']);
  assert.equal(JSON.stringify(invalid.diagnostics).includes('MiPhone_end'), false);

  let fallbackCalls = 0;
  const fallback = await runPhoneBatchGenerationWithFallback({
    client: { async chat() { return '没有工具调用'; } },
    config,
    messages: prepared.messages,
    context,
    target: groupTarget,
    capabilities: {},
    runTextFallback: async ({ reason }) => {
      fallbackCalls += 1;
      return { ok: true, raw: `legacy:${reason}` };
    },
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.effectiveMode, 'legacy_text');
  assert.equal(fallback.fallbackReason, 'no_tool_call');
  assert.equal(fallbackCalls, 1);
  console.log('ok - batch provider attempt succeeds once and invalid terminal output falls back exactly once before commit');
}

{
  let capturedOptions = null;
  const result = await runPhoneBatchProviderFcAttempt({
    client: {
      async chat(_messages, options) {
        capturedOptions = options;
        emitToolCall(options, validArgs);
        return '';
      },
    },
    config: {
      provider: 'opencode',
      model: 'glm-5.3',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    },
    messages: [{ role: 'user', content: '准备好了吗？' }],
    context,
    target: groupTarget,
    capabilities: {},
    temperature: 0,
  });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(capturedOptions.tool_choice, {
    type: 'function',
    function: { name: PHONE_REPLY_IR_BATCH_TOOL_NAME },
  });
  assert.equal(capturedOptions.parallel_tool_calls, false);
  assert.equal(Object.hasOwn(capturedOptions, 'openaiApi'), false);
  assert.equal(capturedOptions.temperature, 0);
  assert.equal(result.ir.source.provider, 'opencode');
  console.log('ok - OpenCode batch FC uses one pinned terminal tool without changing target identity');
}

{
  const controller = new AbortController();
  let fallbackCalls = 0;
  await assert.rejects(
    runPhoneBatchGenerationWithFallback({
      client: {
        async chat() {
          controller.abort();
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
      config,
      messages: [{ role: 'user', content: '中止' }],
      context,
      target: groupTarget,
      capabilities: {},
      signal: controller.signal,
      runTextFallback: async () => { fallbackCalls += 1; },
    }),
    error => error?.name === 'AbortError',
  );
  assert.equal(fallbackCalls, 0);
  console.log('ok - batch provider abort propagates without fallback or commit');
}

{
  const previewEvents = [];
  let chatCalls = 0;
  const argsText = JSON.stringify(validArgs);
  const result = await runPhoneBatchProviderFcAttempt({
    client: {
      async chat() {
        chatCalls += 1;
        throw new Error('stream preview must not use chat()');
      },
      async *streamChat(_messages, options) {
        options.onProviderToolCallDelta({
          choices: [{ delta: { tool_calls: [{
            index: 0,
            id: 'call-batch-stream',
            type: 'function',
            function: { name: PHONE_REPLY_IR_BATCH_TOOL_NAME, arguments: '' },
          }] } }],
        }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
        for (const fragment of [argsText.slice(0, 48), argsText.slice(48)]) {
          options.onProviderToolCallDelta({
            choices: [{ delta: { tool_calls: [{
              index: 0,
              function: { arguments: fragment },
            }] } }],
          }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
          yield '';
        }
        options.onProviderToolCallDelta({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
      },
    },
    config,
    messages: [{ role: 'user', content: '准备好了吗？' }],
    context,
    target: groupTarget,
    capabilities: {},
    streamPreviewEnabled: true,
    onStructuredPreview: event => previewEvents.push(event),
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(chatCalls, 0);
  assert.ok(previewEvents.some(event => event.phase === 'update' && event.text === '准备好了。'));
  assert.deepEqual(previewEvents.at(-1), {
    phase: 'dispose',
    outcome: 'accepted',
    reason: '',
  });
  assert.equal(result.diagnostics.streamPreviewUsed, true);
  console.log('ok - batch FC uses provider deltas for a disposable first-item preview');
}

{
  let chatCalls = 0;
  let streamCalls = 0;
  let capturedOptions = null;
  const previewEvents = [];
  const argsText = JSON.stringify(validArgs);
  const result = await runPhoneBatchProviderFcAttempt({
    client: {
      async chat() {
        chatCalls += 1;
        throw new Error('Responses stream preview must not use chat()');
      },
      async *streamChat(_messages, options) {
        streamCalls += 1;
        capturedOptions = options;
        options.onProviderToolCallDelta({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc-batch-responses',
            call_id: 'call-batch-responses',
            name: PHONE_REPLY_IR_BATCH_TOOL_NAME,
            arguments: '',
          },
        }, { provider: 'openai', model: 'gpt-5.6-sol', api: 'responses' });
        for (const fragment of [argsText.slice(0, 48), argsText.slice(48)]) {
          options.onProviderToolCallDelta({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc-batch-responses',
            call_id: 'call-batch-responses',
            output_index: 0,
            delta: fragment,
          }, { provider: 'openai', model: 'gpt-5.6-sol', api: 'responses' });
          yield '';
        }
        options.onProviderToolCallDelta({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc-batch-responses',
            call_id: 'call-batch-responses',
            name: PHONE_REPLY_IR_BATCH_TOOL_NAME,
            arguments: argsText,
          },
        }, { provider: 'openai', model: 'gpt-5.6-sol', api: 'responses' });
      },
    },
    config: {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      baseUrl: 'https://api.openai.com/v1',
    },
    messages: [{ role: 'user', content: '准备好了吗？' }],
    context,
    target: groupTarget,
    capabilities: {},
    streamPreviewEnabled: true,
    onStructuredPreview: event => previewEvents.push(event),
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(chatCalls, 0);
  assert.equal(streamCalls, 1);
  assert.equal(capturedOptions.openaiApi, 'responses');
  assert.equal(result.diagnostics.streamPreviewUsed, true);
  assert.ok(previewEvents.some(event => (
    event.phase === 'update' && event.text === '准备好了。'
  )));
  console.log('ok - OpenAI Responses batch FC streams a disposable argument preview before terminal validation');
}

{
  const previewEvents = [];
  let fallbackCalls = 0;
  const argsText = JSON.stringify(validArgs);
  const result = await runPhoneBatchGenerationWithFallback({
    client: {
      async chat() {
        throw new Error('stream preview must not use chat()');
      },
      async *streamChat(_messages, options) {
        options.onProviderToolCallDelta({
          choices: [{ message: { tool_calls: [{
            id: 'call-batch-leak',
            type: 'function',
            function: { name: PHONE_REPLY_IR_BATCH_TOOL_NAME, arguments: argsText },
          }] }, finish_reason: 'tool_calls' }],
        }, { provider: 'deepseek', model: 'deepseek-v4-flash' });
        yield '工具调用外正文';
      },
    },
    config,
    messages: [{ role: 'user', content: '准备好了吗？' }],
    context,
    target: groupTarget,
    capabilities: {},
    streamPreviewEnabled: true,
    onStructuredPreview: event => previewEvents.push(event),
    runTextFallback: async ({ reason }) => {
      fallbackCalls += 1;
      return { ok: true, raw: `legacy:${reason}` };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackReason, 'unexpected_response_text');
  assert.equal(fallbackCalls, 1);
  assert.equal(previewEvents.at(-1)?.outcome, 'fallback');
  assert.equal(previewEvents.at(-1)?.reason, 'unexpected_response_text');
  console.log('ok - invalid streamed terminal output discards preview before one legacy fallback');
}

console.log('phone-batch-provider-fc-tests passed');
