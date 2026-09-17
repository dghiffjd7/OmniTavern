import assert from 'node:assert/strict';

import {
  buildStructuredFailureShapeDiagnostics,
  classifyProtocolGenerationError,
  createMomentProtocolGenerationDiagnosticsRunner,
  createProtocolGenerationDiagnosticStore,
  createProtocolGenerationDiagnosticsRuntime,
  inspectProtocolHistory,
  inspectProtocolRaw,
  normalizeProtocolRequestFacts,
  redactProviderToolSchemaForDiagnostics,
  summarizeProtocolGenerationDiagnostics,
} from '../../src/scripts/ui/chat/protocol-generation-diagnostics-utils.js';

{
  const truncated = buildStructuredFailureShapeDiagnostics({
    raw: '```json\n{"version":"phone.reply.ir.v1","payload":{"messages":[{"content":"不得留存的正文"}]',
    finishReason: 'length',
    maxTokens: 3200,
    completionTokens: 3200,
    validationErrors: ['payload.messages.required', '含有不得留存的字段值'],
  });
  assert.deepEqual({ ...truncated, characterCount: 0 }, {
    finishReason: 'length',
    characterCount: 0,
    startsWithObject: false,
    endsWithObject: false,
    hasCodeFence: true,
    hasTableEdit: false,
    hasProtocolMarker: false,
    truncationSuspected: true,
    validationCodes: ['payload.messages.required'],
  });
  assert.equal(truncated.characterCount > 0, true);
  const complete = buildStructuredFailureShapeDiagnostics({
    raw: '{"version":"phone.reply.ir.v1","payload":{}}',
    finishReason: 'stop',
    maxTokens: 3200,
    completionTokens: 30,
    validationErrors: ['payload.messages.required'],
  });
  assert.equal(complete.startsWithObject, true);
  assert.equal(complete.endsWithObject, true);
  assert.equal(complete.truncationSuspected, false);
  assert.equal(JSON.stringify(truncated).includes('不得留存'), false);
  console.log('ok - structured failure shape distinguishes truncation without retaining response text');
}

{
  const redacted = redactProviderToolSchemaForDiagnostics({
    type: 'function',
    function: {
      name: 'emit_phone_batch',
      description: 'private runtime target: 米娅',
      parameters: {
        type: 'object',
        required: ['kind', 'targetId'],
        properties: {
          kind: { type: 'string', enum: ['chat', 'moment_post'] },
          targetId: { type: 'string', enum: ['contact:mia', 'contact:alice'] },
          content: { type: 'string', description: '不可进入诊断的正文提示' },
        },
      },
    },
  });
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.toolName, 'emit_phone_batch');
  assert.deepEqual(redacted.schema.properties.kind.enum, ['chat', 'moment_post']);
  assert.deepEqual(redacted.schema.properties.targetId.enum, ['[redacted:2 values]']);
  assert.equal(Object.hasOwn(redacted.schema.properties.content, 'description'), false);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('米娅'), false);
  assert.equal(serialized.includes('contact:mia'), false);
  assert.equal(serialized.includes('不可进入诊断'), false);
  console.log('ok - provider terminal schema diagnostics preserve shape while redacting targets and prose');
}

{
  const store = createProtocolGenerationDiagnosticStore({ maxEntries: 2 });
  store.record({ eventId: 'event-1', category: 'chat_protocol', details: { outcome: 'completed' } });
  store.record({ eventId: 'event-2', category: 'chat_protocol', details: { outcome: 'rejected' } });
  store.update('event-1', { details: { outcome: 'completed', guardianOutcome: 'completed' } });
  assert.equal(store.snapshot().find(event => event.eventId === 'event-1')?.details?.guardianOutcome, 'completed');
  store.record({ eventId: 'event-3', category: 'chat_protocol', details: { outcome: 'failed' } });
  assert.deepEqual(store.snapshot().map(event => event.eventId), ['event-2', 'event-3']);
  store.clear();
  assert.equal(store.snapshot().length, 0);
  console.log('ok - protocol terminal store retains its own bounded events and async patches');
}

{
  const raw = [
    'MiPhone_start',
    'msg_start',
    '<我和雪乃的私聊>',
    '雪乃--这是不可进入诊断的正文--12:30',
    '</我和雪乃的私聊>',
    'msg_end',
    'MiPhone_end',
  ].join('\n');
  const facts = inspectProtocolRaw(raw);
  assert.equal(facts.rawLength, raw.length);
  assert.equal(facts.phoneShellClosed, true);
  assert.equal(facts.messageShellClosed, true);
  assert.equal(facts.appearsTruncated, false);
  assert.deepEqual(facts.detectedSurfaces, ['private_chat']);
  assert.equal(JSON.stringify(facts).includes('不可进入诊断'), false);
  console.log('ok - protocol raw inspection records structure without retaining response text');
}

{
  const makeEvent = (requestId, outcome, overrides = {}) => ({
    category: 'chat_protocol',
    phase: 'generation.terminal',
    details: {
      requestId,
      turnId: `turn-${requestId}`,
      cohortKey: 'deepseek|flash|private_chat|first-protocol-turn|thinking-off',
      contractEligible: true,
      outcome,
      parseSuccess: outcome === 'completed',
      dispatchSuccess: outcome === 'completed',
      retryRecovered: false,
      rejected: outcome === 'rejected',
      guardianQueued: false,
      ...overrides,
    },
  });
  const summary = summarizeProtocolGenerationDiagnostics([
    makeEvent('req-ok', 'completed', { retryRecovered: true }),
    makeEvent('req-rejected', 'rejected', { guardianQueued: true }),
    makeEvent('req-cancelled', 'cancelled'),
    makeEvent('req-timeout', 'timeout'),
    makeEvent('req-ok', 'completed'),
    makeEvent('req-legacy', 'completed', {
      contractEligible: false,
      parseSuccess: null,
      dispatchSuccess: null,
    }),
    { category: 'send', phase: 'finish', details: {} },
  ]);
  assert.equal(summary.totalGenerations, 5);
  assert.equal(summary.contractEligibleGenerations, 4);
  assert.equal(summary.completedResponseDenominator, 2);
  assert.equal(summary.outcomes.completed, 2);
  assert.equal(summary.outcomes.rejected, 1);
  assert.equal(summary.outcomes.cancelled, 1);
  assert.equal(summary.outcomes.timeout, 1);
  assert.equal(summary.parseSuccess.count, 1);
  assert.equal(summary.parseSuccess.rate, 0.5);
  assert.equal(summary.retryRecovered.count, 1);
  assert.equal(summary.guardianQueued.count, 1);
  assert.equal(summary.cohorts.length, 1);
  console.log('ok - protocol diagnostic summary exposes deduplicated cohort denominators and rates');
}

{
  const recorded = [];
  const evidenceFinalizations = [];
  let clock = 5_000;
  let lastRequest = { requestId: 'prior-request' };
  const diagnostics = createProtocolGenerationDiagnosticsRuntime({
    now: () => clock,
    recordEvent: event => {
      recorded.push(event);
      return event;
    },
  });
  const run = createMomentProtocolGenerationDiagnosticsRunner({
    diagnostics,
    getLastRequest: () => lastRequest,
    getHistory: () => inspectProtocolHistory([]),
    finalizeStructuredEvidence: async payload => {
      evidenceFinalizations.push(payload);
    },
    runGeneration: async (_input, _context, options) => {
      await options.generate();
      clock = 5_300;
      options.applyEvents([{ type: 'moment_reply' }]);
      return {
        fullRaw: 'moment_reply_start\nA--B\nmoment_reply_end',
        sawMomentReply: true,
        retryRecovered: true,
      };
    },
  });
  const result = await run('评论', {
    session: { id: 'moments-session' },
    task: { type: 'moment_comment', mode: 'comment' },
  }, {
    generate: async () => {
      lastRequest = {
        requestId: 'moment-request',
        provider: 'deepseek',
        model: 'deepseek-chat',
        session: { id: 'moments-session', isGroup: false },
        presetContext: { uiMode: 'moments' },
        task: { type: 'moment_comment', mode: 'comment' },
        phoneReplyTransport: {
          capabilitySource: 'local_advanced',
          capabilityLayer: 'local_advanced',
          capabilityRuleId: 'local.chat-fc.moment-rule',
          localRuleCircuitOpen: true,
          localRuleFailureCount: 2,
          localRuleLastFailureReason: 'no_tool_call',
          localRuleHealthAction: 'circuit_opened',
        },
      };
      return 'unused';
    },
    applyEvents: () => ({ touchedMoments: true }),
  });
  assert.equal(result.sawMomentReply, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].details.requestId, 'moment-request');
  assert.equal(recorded[0].details.surface, 'moment_comment');
  assert.equal(recorded[0].details.retryRecovered, true);
  assert.equal(recorded[0].details.firstVisibleLatencyMs, 300);
  assert.equal(recorded[0].details.firstUserVisibleRenderLatencyMs, 300);
  assert.equal(recorded[0].details.phoneReplyCapabilityLayer, 'local_advanced');
  assert.equal(recorded[0].details.phoneReplyCapabilityRuleId, 'local.chat-fc.moment-rule');
  assert.equal(recorded[0].details.phoneReplyLocalRuleCircuitOpen, true);
  assert.equal(recorded[0].details.phoneReplyLocalRuleFailureCount, 2);
  assert.equal(recorded[0].details.phoneReplyLocalRuleHealthAction, 'circuit_opened');
  assert.deepEqual(evidenceFinalizations, [{
    requestId: 'moment-request',
    committed: true,
  }]);
  console.log('ok - moment diagnostics adapter covers its independent generation entry point');
}

{
  const facts = inspectProtocolRaw('MiPhone_start\nmsg_start\n<群聊:测试>');
  assert.equal(facts.phoneShellClosed, false);
  assert.equal(facts.messageShellClosed, false);
  assert.equal(facts.appearsTruncated, true);
  assert.deepEqual(facts.detectedSurfaces, ['group_chat']);
  console.log('ok - protocol raw inspection identifies an unfinished group response');
}

{
  const history = inspectProtocolHistory([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '普通开场白' },
    { role: 'assistant', raw: 'MiPhone_start\nmsg_start\nmsg_end\nMiPhone_end' },
  ]);
  assert.equal(history.priorUserCount, 1);
  assert.equal(history.priorAssistantCount, 2);
  assert.equal(history.protocolAssistantRawCount, 1);
  assert.equal(history.hasProtocolAssistantRaw, true);
  assert.equal(history.firstProtocolTurn, false);

  const first = inspectProtocolHistory([{ role: 'assistant', content: '仅有卡片开场白' }]);
  assert.equal(first.firstProtocolTurn, true);
  console.log('ok - protocol history distinguishes ordinary greetings from protocol raw history');
}

{
  const history = inspectProtocolHistory([
    { role: 'user', raw: '今天下雨了' },
    { role: 'assistant', raw: '拆分后的第一条气泡正文' },
    { role: 'assistant', raw: '拆分后的第二条气泡正文' },
  ], {
    lastRawResponse: [
      '<MiPhone_start>',
      '<msg_start><好友的私聊>完整协议回复<msg_end>',
      '<MiPhone_end>',
    ].join('\n'),
  });
  assert.equal(history.priorAssistantCount, 2);
  assert.equal(history.protocolAssistantRawCount, 1);
  assert.equal(history.hasProtocolAssistantRaw, true);
  assert.equal(history.firstProtocolTurn, false);
  console.log('ok - protocol history uses the session raw envelope after chat dispatch splits bubbles');
}

{
  const facts = normalizeProtocolRequestFacts({
    requestId: 'req-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    stream: true,
    configProfile: { id: 'profile-1', source: 'session', bound: true },
    session: { id: 'session-1', name: '不可记录的联系人名', isGroup: false },
    presetContext: { uiMode: 'chat' },
    task: { type: 'moment_comment', mode: 'published_moment', targetName: '不可记录的目标名' },
    options: {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    },
    requestOptions: {
      deepseekPrefix: { mode: 'chat' },
    },
    providerToolRequestSchema: {
      enabled: true,
      format: 'openai_chat_completions',
      internalToolNames: ['contact_profile.get'],
    },
    webSearch: { enabled: true, route: 'fallback', reason: '' },
    responsePrefix: '不可记录的 prefill 正文',
    deepSeekPhonePrefill: {
      experimentEnabled: true,
      eligible: false,
      reason: 'web_search_enabled',
    },
    phoneReplyTransport: {
      requestedMode: 'provider_fc',
      effectiveMode: 'legacy_text',
      routeLayer: 'probation_fc',
      routeReason: 'transport_verified_model_unobserved',
      fallbackFrom: 'provider_fc',
      fallbackReason: 'invalid_phone_reply_ir',
      probationEligible: true,
      probationReason: 'exact_model_unobserved',
      evidenceStatus: 'observing',
      evidenceStrictSuccessCount: 7,
      circuitOpen: true,
      cooldownUntil: 99_000,
      evidenceAction: 'circuit_opened',
      jsonContract: {
        version: 'phone.reply.ir.v1',
        formatMode: 'json_object',
        schema: { description: '不可记录的完整 schema' },
      },
      validationErrorCodes: [
        'item.content.protocol_control',
        '不可记录的正文',
        'item.content.protocol_control',
      ],
      argumentRepairApplied: true,
      argumentRepairKinds: ['unescaped_quote', '不可记录的修复正文', 'unescaped_quote'],
      thinkingRequested: true,
      thinkingEnabled: false,
      thinkingOverrideReason: 'deepseek_forced_tool_choice_incompatible',
      capabilitySource: 'local_advanced',
      capabilityLayer: 'local_advanced',
      capabilityRuleId: 'local.chat-fc.safe-rule',
      localRuleCircuitOpen: true,
      localRuleFailureCount: 2,
      localRuleLastFailureReason: 'invalid_phone_reply_ir',
      localRuleHealthAction: 'circuit_opened',
      eligible: true,
      attempted: true,
    },
    deepSeekFormatDebug: {
      dsFormatInjected: true,
      isDefaultOpenAIPreset: true,
      openaiPresetId: 'default-openai',
      openaiPresetName: '不可记录的预设名称',
      dsFormatTextPreview: '不可记录的格式正文',
    },
    responseDiagnostics: {
      latencyMs: 2300,
      firstTokenLatencyMs: 420,
      firstMeaningfulDeltaLatencyMs: 420,
      outputDurationMs: 1880,
      tokensPerSecond: 95.7,
      outputSpeedStatus: 'measured',
      streamDeltaCount: 12,
      streamObservedDurationMs: 1700,
      promptTokens: 1200,
      completionTokens: 180,
      totalTokens: 1380,
      finishReason: 'length',
      systemFingerprint: 'fp-safe',
      modelVersion: 'model-version-safe',
      responseId: 'response-safe',
      usagePersistenceTarget: 'assistant_message',
      providerCalls: [{
        callIndex: 1,
        mode: 'provider_fc',
        outcome: 'fallback',
        provider: 'deepseek',
        model: 'deepseek-chat',
        latencyMs: 300,
        outputSpeedStatus: 'insufficient_samples',
        streamDeltaCount: 1,
        streamObservedDurationMs: 0,
      }],
    },
    messages: [{ role: 'user', content: '不可记录的用户正文' }],
  });
  assert.equal(facts.requestId, 'req-1');
  assert.equal(facts.uiMode, 'chat');
  assert.equal(facts.taskType, 'moment_comment');
  assert.equal(facts.taskMode, 'published_moment');
  assert.equal(facts.requestedSurface, 'moment_comment');
  assert.equal(facts.thinkingEnabled, true);
  assert.equal(facts.thinkingMode, 'high');
  assert.equal(facts.webSearchEnabled, true);
  assert.equal(facts.providerToolsEnabled, true);
  assert.equal(facts.prefillEnabled, true);
  assert.equal(facts.prefillLength, '不可记录的 prefill 正文'.length);
  assert.equal(facts.phonePrefillExperimentEnabled, true);
  assert.equal(facts.phonePrefillEligible, false);
  assert.equal(facts.phonePrefillSkipReason, 'web_search_enabled');
  assert.equal(facts.phoneReplyRequestedMode, 'provider_fc');
  assert.equal(facts.phoneReplyEffectiveMode, 'legacy_text');
  assert.equal(facts.phoneReplyRouteLayer, 'probation_fc');
  assert.equal(facts.phoneReplyRouteReason, 'transport_verified_model_unobserved');
  assert.equal(facts.phoneReplyFallbackFrom, 'provider_fc');
  assert.equal(facts.phoneReplyFallbackReason, 'invalid_phone_reply_ir');
  assert.equal(facts.phoneReplyProbationEligible, true);
  assert.equal(facts.phoneReplyProbationReason, 'exact_model_unobserved');
  assert.equal(facts.phoneReplyEvidenceStatus, 'observing');
  assert.equal(facts.phoneReplyEvidenceStrictSuccessCount, 7);
  assert.equal(facts.phoneReplyCircuitOpen, true);
  assert.equal(facts.phoneReplyCooldownUntil, 99_000);
  assert.equal(facts.phoneReplyEvidenceAction, 'circuit_opened');
  assert.equal(facts.phoneReplyJsonContractVersion, 'phone.reply.ir.v1');
  assert.equal(facts.phoneReplyJsonFormatMode, 'json_object');
  assert.deepEqual(facts.phoneReplyValidationErrorCodes, ['item.content.protocol_control']);
  assert.equal(facts.phoneReplyArgumentRepairApplied, true);
  assert.deepEqual(facts.phoneReplyArgumentRepairKinds, ['unescaped_quote']);
  assert.equal(facts.phoneReplyThinkingRequested, true);
  assert.equal(facts.phoneReplyThinkingEnabled, false);
  assert.equal(facts.phoneReplyThinkingOverrideReason, 'deepseek_forced_tool_choice_incompatible');
  assert.equal(facts.phoneReplyCapabilitySource, 'local_advanced');
  assert.equal(facts.phoneReplyCapabilityLayer, 'local_advanced');
  assert.equal(facts.phoneReplyCapabilityRuleId, 'local.chat-fc.safe-rule');
  assert.equal(facts.phoneReplyLocalRuleCircuitOpen, true);
  assert.equal(facts.phoneReplyLocalRuleFailureCount, 2);
  assert.equal(facts.phoneReplyLocalRuleLastFailureReason, 'invalid_phone_reply_ir');
  assert.equal(facts.phoneReplyLocalRuleHealthAction, 'circuit_opened');
  assert.equal(facts.formatReminderInjected, true);
  assert.equal(facts.usesDefaultPreset, true);
  assert.equal(facts.truncated, true);
  assert.equal(facts.finishReason, 'length');
  assert.equal(facts.firstMeaningfulDeltaLatencyMs, 420);
  assert.equal(facts.tokensPerSecond, 95.7);
  assert.equal(facts.outputSpeedStatus, 'measured');
  assert.equal(facts.streamDeltaCount, 12);
  assert.equal(facts.streamObservedDurationMs, 1700);
  assert.equal(facts.systemFingerprint, 'fp-safe');
  assert.equal(facts.modelVersion, 'model-version-safe');
  assert.equal(facts.responseId, 'response-safe');
  assert.equal(facts.usagePersistenceTarget, 'assistant_message');
  assert.equal(facts.providerCalls[0].mode, 'provider_fc');
  assert.equal(facts.providerCalls[0].outputSpeedStatus, 'insufficient_samples');
  assert.equal(facts.providerCalls[0].streamDeltaCount, 1);
  assert.equal(facts.providerCalls[0].streamObservedDurationMs, 0);
  const serialized = JSON.stringify(facts);
  assert.equal(serialized.includes('不可记录'), false);
  assert.equal(serialized.includes('messages'), false);
  console.log('ok - request diagnostics retain provider facts while excluding prompt and response content');
}

{
  const recorded = [];
  const updated = [];
  let clock = 1_000;
  const runtime = createProtocolGenerationDiagnosticsRuntime({
    now: () => clock,
    recordEvent: event => {
      const saved = { ...event, eventId: `trace-${recorded.length + 1}` };
      recorded.push(saved);
      return saved;
    },
    updateEvent: (eventId, patch) => {
      updated.push({ eventId, patch });
      return { eventId, ...patch };
    },
  });
  const turnId = runtime.start({
    turnId: 'turn-1',
    generationId: 7,
    sessionId: 'session-1',
    uiMode: 'chat',
    requestedSurface: 'private_chat',
    contractEligible: true,
    requestedMode: 'legacy_text',
    effectiveMode: 'legacy_text',
    history: inspectProtocolHistory([]),
  });
  assert.equal(turnId, 'turn-1');
  runtime.observeRequest(turnId, {
    requestId: 'req-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    stream: true,
    deepSeekPhonePrefill: {
      experimentEnabled: true,
      eligible: true,
      reason: '',
    },
    requestOptions: {
      deepseekPrefix: { mode: 'phone_format_fallback' },
    },
    responseDiagnostics: {
      latencyMs: 900,
      firstTokenLatencyMs: 300,
      finishReason: 'stop',
    },
    phoneReplyTransport: {
      requestedMode: 'provider_fc',
      effectiveMode: 'provider_fc',
      fallbackReason: '',
      eligible: true,
      attempted: true,
    },
  });
  runtime.observeRaw(turnId, [
    'MiPhone_start',
    'msg_start',
    '<我和雪乃的私聊>',
    '雪乃--成功--12:30',
    '</我和雪乃的私聊>',
    'msg_end',
    'MiPhone_end',
  ].join('\n'));
  runtime.observeProtocolResult(turnId, {
    handled: true,
    reason: '',
    eventCount: 1,
    candidateSource: 'retry',
    eventResults: [{ type: 'private_chat', consumed: true, didAnything: true }],
  });
  clock = 2_000;
  const first = runtime.finalize(turnId, { sendSucceeded: true });
  const repeated = runtime.finalize(turnId, { sendSucceeded: true });
  assert.equal(recorded.length, 1, '同一 turn 只能写入一条终态事件');
  assert.equal(first.eventId, repeated.eventId);
  assert.equal(first.details.outcome, 'completed');
  assert.equal(first.details.parseSuccess, true);
  assert.equal(first.details.dispatchSuccess, true);
  assert.equal(first.details.retryRecovered, true);
  assert.equal(first.details.firstProtocolTurn, true);
  assert.equal(first.details.structuralFacts.phoneShellClosed, true);
  assert.equal(first.details.structuralContractSuccess, true);
  assert.equal(first.details.phonePrefillExperimentEnabled, true);
  assert.equal(first.details.phonePrefillEligible, true);
  assert.equal(first.details.prefillMode, 'phone_format_fallback');
  assert.equal(first.details.requestedMode, 'provider_fc');
  assert.equal(first.details.effectiveMode, 'provider_fc');
  assert.equal(first.details.contractVersion, 'miphone.text.v1');
  assert.deepEqual(first.details.contractIssueCodes, []);

  const duplicateTurnId = runtime.start({
    turnId: 'turn-duplicate-request',
    generationId: 8,
    sessionId: 'session-1',
    uiMode: 'chat',
    requestedSurface: 'private_chat',
    contractEligible: true,
    history: inspectProtocolHistory([]),
  });
  runtime.observeRequest(duplicateTurnId, { requestId: 'req-1', provider: 'deepseek' });
  const duplicate = runtime.finalize(duplicateTurnId, { sendSucceeded: true });
  assert.equal(recorded.length, 1, '同一 requestId 即使误绑到另一 turn 也不能重复计数');
  assert.equal(duplicate.eventId, first.eventId);

  clock = 2_250;
  runtime.markFirstVisible(turnId);
  assert.equal(recorded.length, 1);
  assert.equal(updated.at(-1).eventId, first.eventId);
  assert.equal(updated.at(-1).patch.details.firstVisibleLatencyMs, 1250);

  runtime.markGuardianQueued(turnId);
  runtime.markGuardianOutcome(turnId, { status: 'repaired', failed: false });
  assert.equal(recorded.length, 1);
  assert.equal(updated.at(-1).patch.details.guardianQueued, true);
  assert.equal(updated.at(-1).patch.details.guardianOutcome, 'repaired');
  console.log('ok - protocol diagnostics deduplicate terminal events and patch async visibility/guardian facts');
}

{
  const recorded = [];
  const runtime = createProtocolGenerationDiagnosticsRuntime({
    now: () => 10_000,
    recordEvent: event => {
      recorded.push(event);
      return event;
    },
  });
  const turnId = runtime.start({
    turnId: 'fixture-first-turn-missing-shell',
    sessionId: 'fixture-session',
    uiMode: 'chat',
    requestedSurface: 'private_chat',
    contractEligible: true,
    history: inspectProtocolHistory([]),
  });
  runtime.observeRequest(turnId, { requestId: 'fixture-request', provider: 'fixture', model: 'flash' });
  runtime.observeRaw(turnId, '你好，我会直接用自然语言回答。');
  runtime.observeProtocolResult(turnId, {
    handled: false,
    reason: 'no_events',
    eventCount: 0,
    eventResults: [],
  });
  runtime.finalize(turnId, { sendSucceeded: false });
  assert.equal(recorded[0].details.outcome, 'rejected');
  assert.equal(recorded[0].details.firstProtocolTurn, true);
  assert.equal(recorded[0].details.structuralFacts.hasAnyProtocolMarker, false);
  assert.equal(recorded[0].details.structuralContractSuccess, false);
  assert.ok(recorded[0].details.contractIssueCodes.includes('shell.missing_miphone_start'));
  assert.equal(JSON.stringify(recorded[0].details).includes('你好，我会直接用自然语言回答。'), false);
  assert.equal(recorded[0].details.parseSuccess, false);
  console.log('ok - first-turn missing-shell fixture is reproducible and counted as a rejected response');
}

{
  const recorded = [];
  const runtime = createProtocolGenerationDiagnosticsRuntime({
    now: () => 20_000,
    recordEvent: event => {
      recorded.push(event);
      return event;
    },
  });
  const turnId = runtime.start({
    turnId: 'fixture-custom-contract',
    sessionId: 'fixture-custom-session',
    uiMode: 'chat',
    requestedSurface: 'private_chat',
    contractEligible: true,
    formatProfileEnabled: true,
    history: inspectProtocolHistory([]),
  });
  runtime.observeRequest(turnId, { requestId: 'fixture-custom-request' });
  runtime.observeRaw(turnId, 'CUSTOM_START\n雪乃: 你好\nCUSTOM_END');
  runtime.finalize(turnId, { sendSucceeded: true });
  assert.equal(recorded[0].details.contractEligible, false);
  assert.equal(recorded[0].details.structuralContractSuccess, null);
  assert.equal(recorded[0].details.contractVersion, '');
  assert.deepEqual(recorded[0].details.contractIssueCodes, []);
  console.log('ok - custom format generations stay outside the built-in contract denominator');
}

{
  assert.deepEqual(
    classifyProtocolGenerationError(Object.assign(new Error('request timed out'), { status: 504 })),
    { outcome: 'timeout', errorKind: 'Error', httpStatus: 504 },
  );
  assert.deepEqual(
    classifyProtocolGenerationError(Object.assign(new Error('cancel'), { name: 'AbortError', cancelled: true })),
    { outcome: 'cancelled', errorKind: 'AbortError', httpStatus: null },
  );
  assert.deepEqual(
    classifyProtocolGenerationError(new TypeError('secret payload should not be copied')),
    { outcome: 'failed', errorKind: 'TypeError', httpStatus: null },
  );
  console.log('ok - protocol generation errors classify timeout/cancel/failure without retaining messages');
}
