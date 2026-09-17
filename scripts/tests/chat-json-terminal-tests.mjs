import assert from 'node:assert/strict';
import {
  PHONE_REPLY_JSON_FORMAT_MODES,
  buildPhoneReplyJsonEnvelopeSchema,
  derivePhoneReplyJsonFormatCapabilities,
  buildPhoneReplyJsonRequestOptions,
  normalizePhoneReplyJsonResponse,
  preparePhoneReplyJsonRoute,
  resolvePhoneReplyJsonFormatMode,
  runPhoneReplyJsonAttempt,
  sanitizePhoneReplyJsonInheritedRequestOptions,
} from '../../src/scripts/ui/chat/phone-reply-json-terminal.js';

const privateTarget = {
  sessionId: 'session-private',
  userName: '我',
  targetName: '米娅',
  speakerId: 'mia',
  speakerName: '米娅',
};

const envelope = payload => JSON.stringify({
  version: 'phone.reply.ir.v1',
  payload,
});

{
  const schema = buildPhoneReplyJsonEnvelopeSchema({
    adapter: 'private_reply',
    allowedItemTypes: ['text'],
  });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['version', 'payload']);
  assert.equal(schema.properties.version.const, 'phone.reply.ir.v1');
  assert.equal(schema.properties.payload.required.includes('messages'), true);
  assert.equal(schema.additionalProperties, false);
  console.log('ok - JSON terminal wraps the existing phone.reply.ir.v1 arguments schema in an explicit envelope');
}

{
  const content = '引号 " 与中文“”\\路径\n第二行 😀';
  const result = normalizePhoneReplyJsonResponse({
    text: envelope({ messages: [{ content }] }),
    adapter: 'private_reply',
    target: privateTarget,
    source: { provider: 'kimi', model: 'kimi-k3' },
    allowedItemTypes: ['text'],
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.ir.items[0].content, content);
  assert.match(result.raw, /第二行 😀/u);
  assert.equal(result.argumentRepairApplied, false);

  const wrapped = normalizePhoneReplyJsonResponse({
    text: `说明：${envelope({ messages: [{ content: '不应接受' }] })}`,
    adapter: 'private_reply',
    target: privateTarget,
  });
  assert.equal(wrapped.ok, false);
  assert.equal(wrapped.reason, 'invalid_terminal_json');
  console.log('ok - long escaped content round-trips while wrapper prose fails closed');
}

{
  for (let round = 0; round < 24; round += 1) {
    const first = [
      `round=${round}`,
      'ASCII "quotes" / 中文“引号”',
      'C:\\MiPhone\\chat\\reply.json',
      '第一行\n第二行\t带制表符',
      'emoji 😀🧭✨',
      '长正文：',
      '纸墨'.repeat(450 + round),
    ].join(' | ');
    const second = `收尾 ${round}: ${Array.from({ length: 80 }, () => 'x\\"中').join('\n')}`;
    const result = normalizePhoneReplyJsonResponse({
      text: envelope({ messages: [{ content: first }, { content: second }] }),
      adapter: 'private_reply',
      target: privateTarget,
      source: { provider: 'fixture', model: `json-cohort-${round}` },
      allowedItemTypes: ['text'],
    });
    assert.equal(result.ok, true, `round ${round}: ${result.reason}`);
    assert.equal(result.argumentRepairApplied, false, `round ${round} must be strict`);
    assert.deepEqual(result.ir.items.map(item => item.content), [first, second]);
  }
  console.log('ok - 24-round JSON cohort preserves multi-message long text, escapes, newlines, and emoji');
}

{
  const repaired = normalizePhoneReplyJsonResponse({
    text: '{"version":"phone.reply.ir.v1","payload":{"messages":[{"content":"她说 "好"\n下一行"}]}}',
    adapter: 'private_reply',
    target: privateTarget,
  });
  assert.equal(repaired.ok, true, repaired.reason);
  assert.equal(repaired.argumentRepairApplied, true);
  assert.ok(repaired.argumentRepairKinds.length > 0);
  console.log('ok - bounded syntax repair is reported and remains distinguishable from strict evidence success');
}

{
  const groupTarget = {
    mode: 'group_chat',
    sessionId: 'group:json-terminal',
    targetName: 'JSON 测试群',
    userName: '我',
    members: [
      { id: 'contact:a', name: '成员 A' },
      { id: 'contact:b', name: '成员 B' },
    ],
    momentAuthors: [],
    tableTargets: [],
  };
  const group = normalizePhoneReplyJsonResponse({
    text: envelope({
      items: [{
        kind: 'chat',
        messages: [
          { speakerId: 'contact:a', content: '第一句' },
          { speakerId: 'contact:b', content: '第二句' },
        ],
      }],
    }),
    adapter: 'phone_batch',
    target: groupTarget,
  });
  assert.equal(group.ok, true, group.reason);
  assert.deepEqual(group.ir.items[0].messages.map(message => message.speaker.id), [
    'contact:a',
    'contact:b',
  ]);

  const momentTarget = {
    mode: 'moment_comment',
    sessionId: 'contact:origin',
    targetName: '动态评论',
    userName: '我',
    momentId: 'moment:json-terminal',
    momentAuthors: [{ id: 'contact:a', name: '成员 A' }],
    privateTargets: [],
    groupTargets: [],
    tableTargets: [],
  };
  const moment = normalizePhoneReplyJsonResponse({
    text: envelope({
      items: [{
        kind: 'moment_comment',
        comments: [{ content: '动态 JSON 回复' }],
      }],
    }),
    adapter: 'phone_batch',
    target: momentTarget,
  });
  assert.equal(moment.ok, true, `${moment.reason}: ${JSON.stringify(moment.validationErrors || [])}`);
  assert.equal(moment.ir.items[0].momentId, 'moment:json-terminal');
  assert.equal(moment.ir.items[0].comments[0].author.id, 'contact:a');
  console.log('ok - JSON terminal reuses the frozen batch contract for group and moment surfaces');
}

{
  assert.equal(resolvePhoneReplyJsonFormatMode({
    config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-example' },
    capabilities: { jsonSchema: true },
  }), PHONE_REPLY_JSON_FORMAT_MODES.jsonSchema);
  assert.equal(resolvePhoneReplyJsonFormatMode({
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  }), PHONE_REPLY_JSON_FORMAT_MODES.jsonObject);
  assert.equal(resolvePhoneReplyJsonFormatMode({
    config: { provider: 'custom', baseUrl: 'https://relay.example/v1' },
  }), PHONE_REPLY_JSON_FORMAT_MODES.promptJson);

  const schema = buildPhoneReplyJsonEnvelopeSchema({ adapter: 'private_reply' });
  const strict = buildPhoneReplyJsonRequestOptions({
    formatMode: PHONE_REPLY_JSON_FORMAT_MODES.jsonSchema,
    schema,
  });
  assert.equal(strict.response_format.type, 'json_schema');
  assert.equal(strict.response_format.json_schema.strict, true);
  const promptOnly = buildPhoneReplyJsonRequestOptions({
    formatMode: PHONE_REPLY_JSON_FORMAT_MODES.promptJson,
    schema,
  });
  assert.equal(Object.hasOwn(promptOnly, 'response_format'), false);

  const inherited = sanitizePhoneReplyJsonInheritedRequestOptions({
    provider: 'deepseek',
    options: {
      tools: [{ type: 'function' }],
      tool_choice: 'required',
      parallel_tool_calls: false,
      response_format: { type: 'text' },
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
      reasoning: { effort: 'high' },
      temperature: 0.6,
    },
  });
  assert.equal(Object.hasOwn(inherited, 'tools'), false);
  assert.equal(Object.hasOwn(inherited, 'tool_choice'), false);
  assert.equal(Object.hasOwn(inherited, 'parallel_tool_calls'), false);
  assert.equal(Object.hasOwn(inherited, 'response_format'), false);
  assert.equal(inherited.reasoning_effort, 'high');
  assert.deepEqual(inherited.thinking, { type: 'enabled' });
  assert.deepEqual(inherited.reasoning, { effort: 'high' });
  assert.equal(inherited.temperature, 0.6);
  console.log('ok - response_format is sent only for an explicitly known JSON capability');
}

{
  const base = {
    enabled: true,
    client: { chat: async () => '' },
    messages: [],
    context: {
      uiMode: 'chat',
      surface: 'private_chat',
      protocolParserEnabled: true,
      usesDefaultPreset: true,
      usesBuiltinFormat: true,
      responseTarget: 'assistant',
    },
    target: privateTarget,
  };
  assert.equal(preparePhoneReplyJsonRoute({ ...base, adapter: 'unknown_adapter' }).reason, 'json_adapter_unsupported');
  assert.equal(preparePhoneReplyJsonRoute({
    ...base,
    adapter: 'private_reply',
    context: { ...base.context, responseTarget: 'user' },
  }).reason, 'unsupported_response_target');
  console.log('ok - JSON terminal fails closed for unknown adapters and user-target continuations');
}

{
  let firstDeltaCount = 0;
  let deliveryCount = 0;
  const chunks = [
    '  ',
    '{"version":"phone.reply.ir.v1",',
    '"payload":{"messages":[{"content":"流式完成"}]}}',
  ];
  const client = {
    chat: async () => { throw new Error('non-stream path should not run'); },
    async *streamChat() {
      for (const chunk of chunks) yield chunk;
    },
  };
  const attempt = await runPhoneReplyJsonAttempt({
    client,
    config: { provider: 'custom', model: 'json-model' },
    messages: [{ role: 'system', content: 'json contract' }, { role: 'user', content: 'hi' }],
    adapter: 'private_reply',
    target: privateTarget,
    stream: true,
    onFirstProviderDelta: () => { firstDeltaCount += 1; },
    onProviderDelta: () => { deliveryCount += 1; },
  });
  assert.equal(attempt.ok, true, attempt.reason);
  assert.equal(firstDeltaCount, 1);
  assert.equal(deliveryCount, 2, 'all meaningful deltas are measured, blank chunks are ignored');
  assert.equal(attempt.diagnostics.firstMeaningfulDeltaObserved, true);
  assert.match(attempt.raw, /流式完成/u);
  console.log('ok - JSON streaming records the first non-empty text delta but commits only after the full object validates');
}

{
  const cases = [
    ['invalid_terminal_json', '{"version":"phone.reply.ir.v1","payload":', 'length'],
    ['invalid_terminal_envelope', '{"version":"phone.reply.ir.v1","payload":{},"extra":"不得留存"}', 'stop'],
    ['invalid_phone_reply_ir', envelope({ messages: [] }), 'stop'],
  ];
  for (const [reason, response, finishReason] of cases) {
    const attempt = await runPhoneReplyJsonAttempt({
      client: {
        chat: async (_messages, options) => {
          options.onProviderUsage?.({ finishReason, completionTokens: finishReason === 'length' ? 20 : 5 });
          return response;
        },
      },
      config: { provider: 'custom', model: 'failure-shape-fixture' },
      messages: [{ role: 'user', content: '测试' }],
      adapter: 'private_reply',
      target: privateTarget,
      maxTokens: 20,
    });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, reason);
    assert.equal(typeof attempt.diagnostics.failureShape.characterCount, 'number');
    assert.equal(attempt.diagnostics.failureShape.finishReason, finishReason);
    assert.equal(attempt.diagnostics.failureShape.validationCodes.includes(reason), true);
    assert.equal(
      attempt.diagnostics.failureShape.truncationSuspected,
      finishReason === 'length',
    );
    assert.equal(JSON.stringify(attempt.diagnostics.failureShape).includes('不得留存'), false);
  }
  console.log('ok - JSON, envelope, and IR failures share the same redacted failure-shape contract');
}

{
  assert.deepEqual(
    derivePhoneReplyJsonFormatCapabilities({
      provider: 'openrouter',
      metadataKnown: true,
      supportedParameters: ['tools', 'Response_Format', 'structured_outputs'],
    }),
    { jsonSchema: true, jsonObject: true },
  );
  assert.deepEqual(
    derivePhoneReplyJsonFormatCapabilities({
      provider: 'openrouter',
      metadataKnown: false,
      supportedParameters: ['response_format'],
    }),
    {},
  );
  assert.deepEqual(
    derivePhoneReplyJsonFormatCapabilities({
      provider: 'opencode',
      metadataKnown: true,
      supportedParameters: ['response_format'],
    }),
    {},
  );
  assert.equal(
    resolvePhoneReplyJsonFormatMode({
      config: { provider: 'openrouter', model: 'some/model' },
      capabilities: derivePhoneReplyJsonFormatCapabilities({
        provider: 'openrouter',
        metadataKnown: true,
        supportedParameters: ['structured_outputs', 'response_format'],
      }),
    }),
    PHONE_REPLY_JSON_FORMAT_MODES.jsonSchema,
  );
  assert.equal(
    resolvePhoneReplyJsonFormatMode({
      config: { provider: 'openrouter', model: 'some/model' },
      capabilities: derivePhoneReplyJsonFormatCapabilities({
        provider: 'openrouter',
        metadataKnown: true,
        supportedParameters: ['response_format'],
      }),
    }),
    PHONE_REPLY_JSON_FORMAT_MODES.jsonObject,
  );
  assert.equal(
    resolvePhoneReplyJsonFormatMode({
      config: { provider: 'openrouter', model: 'some/model' },
      capabilities: derivePhoneReplyJsonFormatCapabilities({
        provider: 'openrouter',
        metadataKnown: true,
        supportedParameters: ['tools'],
      }),
    }),
    PHONE_REPLY_JSON_FORMAT_MODES.promptJson,
  );
  console.log('ok - OpenRouter supported_parameters metadata drives the three-tier format mode without blind fields');
}

{
  const route = preparePhoneReplyJsonRoute({
    enabled: false,
    config: { provider: 'openrouter', model: 'some/model' },
    adapter: 'private_reply',
    target: privateTarget,
    formatCapabilities: { jsonObject: true },
  });
  assert.equal(route.formatMode, PHONE_REPLY_JSON_FORMAT_MODES.jsonObject);
  console.log('ok - preparePhoneReplyJsonRoute consumes formatCapabilities for non-DeepSeek providers');
}

console.log('chat-json-terminal-tests passed');
