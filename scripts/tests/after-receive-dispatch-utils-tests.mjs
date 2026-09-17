import assert from 'node:assert/strict';

import {
  buildChatBodyQualityAgentRun,
  buildChatBodyQualityMessagePart,
  buildChatFormatGuardianAgentRun,
  buildChatFormatGuardianMessagePart,
  dispatchAfterReceiveEffects,
  resolveChatFormatGuardianInputText,
  resolveAfterReceiveSkipScripts,
  runChatBodyQualityPreview,
  runChatFormatGuardianPreview,
  validateChatFormatGuardianRepairCandidate,
} from '../../src/scripts/ui/chat/after-receive-dispatch-utils.js';
import {
  buildAfterReceiveHookFinishTraceEvent,
  buildAfterReceiveHookStartTraceEvent,
  buildAfterSendHookFinishTraceEvent,
  buildAfterSendHookStartTraceEvent,
  buildBeforeSendHookFinishTraceEvent,
  buildBeforeSendHookStartTraceEvent,
  buildHookLifecycleTraceEvent,
  buildRuntimeHookFinishTraceEvent,
  buildRuntimeHookStartTraceEvent,
  dispatchRuntimeHookLifecycleEvent,
  runRuntimeHookLifecycleEvent,
} from '../../src/scripts/ui/chat/hook-lifecycle-trace-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async (predicate, message = 'condition was not met') => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  assert.fail(message);
};

// Untimed rows are valid. Repair fixtures now omit the required phone shell.
const buildMissingPrivateShellPatches = () => [{
  startLine: 1, endLine: 1,
  originalLines: ['<我和菲伦的私聊>'],
  replacementLines: ['MiPhone_start', 'msg_start', '<我和菲伦的私聊>'],
}, {
  startLine: 3, endLine: 3,
  originalLines: ['</我和菲伦的私聊>'],
  replacementLines: ['</我和菲伦的私聊>', 'msg_end', 'MiPhone_end'],
}];

test('resolveAfterReceiveSkipScripts prefers explicit override', () => {
  assert.equal(resolveAfterReceiveSkipScripts(true, false), true);
  assert.equal(resolveAfterReceiveSkipScripts(false, true), false);
  assert.equal(resolveAfterReceiveSkipScripts(undefined, true), true);
});

test('buildHookLifecycleTraceEvent normalizes hook metadata and drops undefined details', () => {
  const event = buildHookLifecycleTraceEvent({
    phase: ' after_receive.start ',
    hookName: ' message.after_receive ',
    runtimeLabel: ' plugin ',
    sessionId: ' s1 ',
    messageId: ' m1 ',
    status: ' started ',
    summary: ' started ',
    details: { kept: true, dropped: undefined },
  });
  assert.deepEqual(event, {
    category: 'plugin-hooks',
    source: 'hook-lifecycle',
    phase: 'after_receive.start',
    hookName: 'message.after_receive',
    runtimeLabel: 'plugin',
    sessionId: 's1',
    messageId: 'm1',
    status: 'started',
    summary: 'started',
    details: { kept: true },
  });
});

test('hook trace patch builders preserve runtime hook payload contracts', () => {
  assert.deepEqual(buildBeforeSendHookStartTraceEvent({
    runtimeLabel: 'script',
    sessionId: 's1',
    text: 'hello',
    isGroupChat: true,
    hasAttachments: false,
    allowTextOverride: true,
  }), {
    phase: 'before_send.start',
    hookName: 'message.before_send',
    runtimeLabel: 'script',
    sessionId: 's1',
    status: 'started',
    summary: 'message.before_send hook started',
    details: {
      isGroupChat: true,
      hasAttachments: false,
      allowTextOverride: true,
      contentLength: 5,
    },
  });
  assert.deepEqual(buildBeforeSendHookFinishTraceEvent({
    runtimeLabel: 'plugin',
    sessionId: 's1',
    text: 'hello',
    nextText: 'hello!',
    changed: true,
  }), {
    phase: 'before_send.finish',
    hookName: 'message.before_send',
    runtimeLabel: 'plugin',
    sessionId: 's1',
    status: 'success',
    summary: 'message.before_send hook changed content',
    details: {
      changed: true,
      originalLength: 5,
      nextLength: 6,
    },
  });
  assert.deepEqual(buildAfterSendHookStartTraceEvent({
    runtimeLabel: 'plugin',
    sessionId: 's2',
    message: { id: ' m1 ', role: 'user', type: 'text' },
  }), {
    phase: 'after_send.start',
    hookName: 'message.after_send',
    runtimeLabel: 'plugin',
    sessionId: 's2',
    messageId: 'm1',
    status: 'started',
    summary: 'message.after_send hook started',
    details: { role: 'user', type: 'text' },
  });
  assert.deepEqual(buildAfterSendHookFinishTraceEvent({
    runtimeLabel: 'plugin',
    sessionId: 's2',
    messageId: 'm1',
    status: 'queued',
  }), {
    phase: 'after_send.finish',
    hookName: 'message.after_send',
    runtimeLabel: 'plugin',
    sessionId: 's2',
    messageId: 'm1',
    status: 'queued',
    summary: 'message.after_send hook queued',
  });
  assert.deepEqual(buildAfterReceiveHookStartTraceEvent({
    runtimeLabel: 'script',
    sessionId: 's3',
    message: { id: 'm2', role: 'assistant', type: 'text' },
  }), {
    phase: 'after_receive.start',
    hookName: 'message.after_receive',
    runtimeLabel: 'script',
    sessionId: 's3',
    messageId: 'm2',
    status: 'started',
    summary: 'message.after_receive hook started',
    details: { role: 'assistant', type: 'text' },
  });
  assert.deepEqual(buildAfterReceiveHookFinishTraceEvent({
    runtimeLabel: 'script',
    sessionId: 's3',
    messageId: 'm2',
    status: 'error',
    errorMessage: 'failed',
  }), {
    phase: 'after_receive.finish',
    hookName: 'message.after_receive',
    runtimeLabel: 'script',
    sessionId: 's3',
    messageId: 'm2',
    status: 'error',
    summary: 'failed',
  });
  assert.deepEqual(buildRuntimeHookStartTraceEvent({
    runtimeLabel: 'plugin',
    hookName: 'variable.changed',
    sessionId: 's4',
    details: { name: 'mood', dropped: undefined },
  }), {
    phase: 'variable.changed.start',
    hookName: 'variable.changed',
    runtimeLabel: 'plugin',
    sessionId: 's4',
    messageId: '',
    status: 'started',
    summary: 'variable.changed hook started',
    details: { name: 'mood' },
  });
  assert.deepEqual(buildRuntimeHookFinishTraceEvent({
    runtimeLabel: 'plugin',
    hookName: 'prompt.before_build',
    sessionId: 's5',
    status: 'success',
    details: { hasInputOverride: true },
  }), {
    phase: 'prompt.before_build.finish',
    hookName: 'prompt.before_build',
    runtimeLabel: 'plugin',
    sessionId: 's5',
    messageId: '',
    status: 'success',
    summary: 'prompt.before_build hook finished',
    details: { hasInputOverride: true },
  });
});

test('dispatchRuntimeHookLifecycleEvent records queued and async error without exposing payload', async () => {
  const calls = [];
  const trace = [];
  const warnings = [];
  const ok = dispatchRuntimeHookLifecycleEvent({
    runtime: {
      dispatchEvent(event, payload, options) {
        calls.push([event, payload.secret, options?.sessionId]);
        return Promise.reject(new Error('async failed'));
      },
    },
    runtimeLabel: 'plugin',
    hookName: 'variable.changed',
    payload: { secret: 'raw-value' },
    sessionId: 's1',
    details: { name: 'mood', scope: 'chat', raw: undefined },
    logger: { warn: (...args) => warnings.push(args) },
    warningMessage: 'plugin variable.changed failed',
    recordTraceEvent: event => trace.push(event),
  });
  await flushMicrotasks();

  assert.equal(ok, true);
  assert.deepEqual(calls, [['variable.changed', 'raw-value', 's1']]);
  assert.deepEqual(
    trace.map(event => [event.runtimeLabel, event.phase, event.status, event.summary]),
    [
      ['plugin', 'variable.changed.start', 'started', 'variable.changed hook started'],
      ['plugin', 'variable.changed.finish', 'queued', 'variable.changed hook queued'],
      ['plugin', 'variable.changed.finish', 'error', 'async failed'],
    ],
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'plugin variable.changed failed');
  assert.equal(JSON.stringify(trace).includes('raw-value'), false);
});

test('dispatchRuntimeHookLifecycleEvent preserves synchronous dispatch failures', () => {
  const trace = [];
  assert.throws(() => dispatchRuntimeHookLifecycleEvent({
    runtime: {
      dispatchEvent() {
        throw new Error('sync failed');
      },
    },
    runtimeLabel: 'plugin',
    hookName: 'command.parsed',
    payload: { text: '/secret' },
    sessionId: 's1',
    details: { commandLength: 7 },
    recordTraceEvent: event => trace.push(event),
  }), /sync failed/);
  assert.deepEqual(
    trace.map(event => [event.phase, event.status, event.summary]),
    [
      ['command.parsed.start', 'started', 'command.parsed hook started'],
      ['command.parsed.finish', 'error', 'sync failed'],
    ],
  );
  assert.equal(JSON.stringify(trace).includes('/secret'), false);
});

test('runRuntimeHookLifecycleEvent awaits mutable hooks and records non-sensitive result metadata', async () => {
  const trace = [];
  const warnings = [];
  const success = await runRuntimeHookLifecycleEvent({
    runtime: {
      dispatchEvent(event, payload, options) {
        assert.equal(event, 'prompt.before_build');
        assert.equal(payload.input, 'raw prompt');
        assert.equal(options?.sessionId, 's1');
        return Promise.resolve({ input: 'next prompt', context: payload.context });
      },
    },
    runtimeLabel: 'script',
    hookName: 'prompt.before_build',
    payload: { input: 'raw prompt', context: { session: { id: 's1' } } },
    sessionId: 's1',
    details: { inputLength: 10 },
    finishDetails: result => ({
      hasInputOverride: typeof result?.input === 'string',
      inputLength: String(result?.input || '').length,
    }),
    logger: { warn: (...args) => warnings.push(args) },
    recordTraceEvent: event => trace.push(event),
  });
  const failure = await runRuntimeHookLifecycleEvent({
    runtime: {
      dispatchEvent() {
        return Promise.reject(new Error('mutate failed'));
      },
    },
    runtimeLabel: 'plugin',
    hookName: 'prompt.after_build',
    payload: { prompt: [{ content: 'secret prompt' }] },
    sessionId: 's1',
    details: { promptCount: 1 },
    logger: { warn: (...args) => warnings.push(args) },
    warningMessage: 'plugin prompt.after_build failed',
    recordTraceEvent: event => trace.push(event),
  });

  assert.equal(success.dispatched, true);
  assert.equal(success.result.input, 'next prompt');
  assert.equal(failure.dispatched, true);
  assert.equal(failure.error?.message, 'mutate failed');
  assert.deepEqual(
    trace.map(event => [event.runtimeLabel, event.phase, event.status]),
    [
      ['script', 'prompt.before_build.start', 'started'],
      ['script', 'prompt.before_build.finish', 'success'],
      ['plugin', 'prompt.after_build.start', 'started'],
      ['plugin', 'prompt.after_build.finish', 'error'],
    ],
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'plugin prompt.after_build failed');
  assert.equal(JSON.stringify(trace).includes('raw prompt'), false);
  assert.equal(JSON.stringify(trace).includes('secret prompt'), false);
});

test('dispatchAfterReceiveEffects ignores non-assistant messages', () => {
  const calls = [];
  const handled = dispatchAfterReceiveEffects({
    message: { role: 'user' },
    sessionId: 's1',
    applyUpdateVariable: () => calls.push('update'),
  });
  assert.equal(handled, false);
  assert.deepEqual(calls, []);
});

test('dispatchAfterReceiveEffects dispatches runtimes, update apply, and variable rules', async () => {
  const calls = [];
  const trace = [];
  const handled = dispatchAfterReceiveEffects({
    message: { id: 'm1', role: 'assistant' },
    sessionId: 's2',
    defaultSkipScripts: false,
    scriptRuntime: {
      dispatchEvent(event, payload) {
        calls.push(['script', event, payload.sessionId, payload.message.id]);
        return Promise.resolve();
      },
    },
    pluginRuntime: {
      dispatchEvent(event, payload) {
        calls.push(['plugin', event, payload.sessionId, payload.message.id]);
        return Promise.resolve();
      },
    },
    applyUpdateVariable(message, sessionId) {
      calls.push(['update', message.id, sessionId]);
    },
    onVariablesSettled(message, sessionId) {
      calls.push(['var-settled', message.id, sessionId]);
    },
    handleVariableRules(payload) {
      calls.push(['rules', payload.message.id, payload.sessionId, payload.useGlobalVariables]);
      return Promise.resolve();
    },
    useGlobalVariables: true,
    recordTraceEvent: event => trace.push(event),
    logger: { warn() {} },
  });
  await flushMicrotasks();
  assert.equal(handled, true);
  // onVariablesSettled 必须在 applyUpdateVariable 之后、handleVariableRules 之前（变量已就位再拍快照）
  assert.deepEqual(calls, [
    ['script', 'message.after_receive', 's2', 'm1'],
    ['plugin', 'message.after_receive', 's2', 'm1'],
    ['update', 'm1', 's2'],
    ['var-settled', 'm1', 's2'],
    ['rules', 'm1', 's2', true],
  ]);
  assert.deepEqual(
    trace.map(event => [event.runtimeLabel, event.phase, event.status, event.messageId]),
    [
      ['script', 'after_receive.start', 'started', 'm1'],
      ['script', 'after_receive.finish', 'queued', 'm1'],
      ['plugin', 'after_receive.start', 'started', 'm1'],
      ['plugin', 'after_receive.finish', 'queued', 'm1'],
    ],
  );
});

test('dispatchAfterReceiveEffects can suppress plugin hooks during transactional replay', () => {
  const calls = [];
  const handled = dispatchAfterReceiveEffects({
    message: { id: 'm-replay', role: 'assistant' },
    sessionId: 's-replay',
    skipScripts: true,
    skipPlugins: true,
    scriptRuntime: {
      dispatchEvent() {
        calls.push('script');
      },
    },
    pluginRuntime: {
      dispatchEvent() {
        calls.push('plugin');
      },
    },
    applyUpdateVariable() {
      calls.push('variable');
    },
    logger: { warn() {} },
  });
  assert.equal(handled, true);
  assert.deepEqual(calls, ['variable']);
});

test('buildChatFormatGuardianMessagePart summarizes warnings without exposing full content', () => {
  const part = buildChatFormatGuardianMessagePart({
    now: 1000,
    sessionId: 'group:case',
    message: { id: 'm-format' },
    result: {
      status: 'needs_review',
      sourceMessageId: 'm-format',
      summary: '1 chat format event draft(s), 0 error(s), 1 warning(s)',
      eventDrafts: [{
        type: 'group_message',
        surface: 'chat',
        targetId: 'group:case',
        targetName: '调查组',
        speakerId: 'contact:snow',
        speakerName: '雪',
        content: '这是一段非常长的内容，用来确认 sidecar 只保存预览摘要，不把完整正文复制到元数据里。'.repeat(3),
        warnings: ['time is missing'],
      }],
      errors: [],
      warnings: ['time is missing'],
    },
  });

  assert.equal(part.type, 'agent_status');
  assert.equal(part.runId, 'run:chat-format-guardian:m-format');
  assert.equal(part.source, 'chat-format-guardian');
  assert.equal(part.kind, 'chat_format.validate');
  assert.equal(part.status, 'waiting_permission');
  assert.equal(part.title, '聊天格式待确认');
  assert.equal(part.metadata.eventCount, 1);
  assert.deepEqual(part.metadata.countsByType, { group_message: 1 });
  assert.equal(part.metadata.events[0].contentPreview.endsWith('...'), true);
  assert.deepEqual(
    part.metadata.decisionActions.filter(action => action.enabled !== false).map(action => action.id),
    ['swipe_retry', 'review_original', 'edit_user_input_suggestion', 'open_agent_center'],
  );
  assert.equal(part.metadata.inputSuggestion.includes('不要编造缺失的时间'), true);
});

test('buildChatFormatGuardianAgentRun records review state without storing full content', () => {
  const run = buildChatFormatGuardianAgentRun({
    now: 1000,
    sessionId: 'group:case',
    message: { id: 'm-format', role: 'assistant' },
    result: {
      status: 'needs_review',
      sourceMessageId: 'm-format',
      summary: '1 chat format event draft(s), 0 error(s), 1 warning(s)',
      eventDrafts: [{
        type: 'group_message',
        surface: 'chat',
        targetId: 'group:case',
        targetName: '调查组',
        speakerId: 'contact:snow',
        speakerName: '雪',
        content: '这是一段非常长的内容，用来确认 Agent Run 只保存预览摘要，不把完整正文复制到元数据里。'.repeat(3),
        warnings: ['time is missing'],
      }],
      errors: [],
      warnings: ['time is missing'],
    },
  });

  assert.equal(run.id, 'run:chat-format-guardian:m-format');
  assert.equal(run.kind, 'chat_format_guardian');
  assert.equal(run.status, 'waiting_permission');
  assert.equal(run.surface, 'chat');
  assert.equal(run.finishedAt, null);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].type, 'chat_format.validate');
  assert.equal(run.steps[0].status, 'waiting_permission');
  assert.equal(run.metadata.events[0].contentPreview.endsWith('...'), true);
  assert.equal(JSON.stringify(run).includes('非常长的内容'.repeat(2)), false);
});

test('buildChatFormatGuardianAgentRun records bounded model repair return details', () => {
  const candidateText = 'MiPhone_start\nmsg_start\n<{{user}}和老板娘的私聊>\n{{user}}--姐姐--17:23\n</{{user}}和老板娘的私聊>\nmsg_end\nMiPhone_end';
  const run = buildChatFormatGuardianAgentRun({
    now: 1000,
    sessionId: 'contact:boss',
    message: {
      id: 'm-model-format',
      role: 'assistant',
      meta: { protocolParseFailure: true },
    },
    autoApplyRepair: true,
    autoRepairResult: {
      didAnything: false,
      reason: 'no_events',
      eventCount: 0,
    },
    result: {
      status: 'needs_review',
      sourceMessageId: 'm-model-format',
      sourceTextKind: 'rawOriginal',
      hasRawOriginal: true,
      summary: '模型已返回格式修复',
      eventDrafts: [],
      errors: ['missing close tag'],
      warnings: [],
      modelReview: {
        status: 'patch',
        canRepair: true,
        repairSummary: '补齐外层标签和结束标记。',
        candidateText,
        protocolVersion: 'format_patch.v1',
        baseRevision: 'format-run:test-detail',
        rawPreview: '{"status":"patch"}',
        rawText: '{"protocolVersion":"format_patch.v1","status":"patch","linePatches":[...]}',
        issues: [{
          severity: 'error',
          type: 'missing_close_tag',
          message: '缺少私聊闭合标签',
          evidence: '<{{user}}和老板娘的私聊>',
        }],
        linePatches: [{
          startLine: 3,
          endLine: 3,
          originalLines: ['<{{user}}和老板娘的私聊>'],
          replacementLines: ['<{{user}}和老板娘的私聊>', '{{user}}--姐姐--17:23'],
          reason: '补齐可解析内容',
          originalMatches: true,
        }],
      },
    },
  });

  assert.equal(run.metadata.modelReviewDetail.status, 'patch');
  assert.equal(run.metadata.protocolParseFailure, true);
  assert.equal(run.metadata.modelReviewDetail.canRepair, true);
  assert.equal(run.metadata.modelReviewDetail.candidateText, candidateText);
  assert.equal(run.metadata.modelReviewDetail.correctedText, undefined);
  assert.equal(run.metadata.modelReviewDetail.rawText.includes('linePatches'), true);
  assert.equal(run.metadata.modelReviewDetail.linePatches[0].replacementLines[1], '{{user}}--姐姐--17:23');
  assert.equal(run.metadata.modelReviewDetail.linePatches[0].replacementText, undefined);
  assert.deepEqual(run.metadata.autoRepair, {
    autoApplyRepair: true,
    attempted: true,
    didAnything: false,
    reason: 'no_events',
    errorMessage: '',
    eventCount: 0,
    mutatedMoments: false,
  });
  assert.equal(run.metadata.repairCandidate.replacementText, undefined);
});

test('checker malfunction is labeled 格式检查未完成, never 聊天格式错误', () => {
  // 检查器故障与「检查完成且发现问题」共用 invalid 状态：标题必须区分责任方，
  // 否则检查模型自己坏了会被渲染成「聊天格式错误」，指向用户的聊天内容。
  const buildResult = ({ issueType, message, summary = '' }) => ({
    status: 'invalid',
    ...(summary ? { summary } : {}),
    sourceMessageId: 'm-guardian',
    errors: [message],
    warnings: [],
    modelReview: {
      ok: false,
      status: 'invalid',
      canRepair: false,
      issues: [{ severity: 'error', type: issueType, message, evidence: '' }],
    },
  });

  // 请求失败/超时路径（failure builder 形态）
  const timedOut = buildChatFormatGuardianAgentRun({
    now: 1000,
    sessionId: 'contact:boss',
    message: { id: 'm-guardian', role: 'assistant' },
    result: buildResult({
      issueType: 'timeout',
      message: '格式修复请求超时（75 秒）',
      summary: '格式修复请求失败',
    }),
  });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.title, '格式检查未完成');
  assert.equal(timedOut.steps[0].title, '格式检查未完成');
  assert.equal(timedOut.errorMessage, '格式修复请求超时（75 秒）');

  // 模型返回不可解析 JSON 路径（normalize 兜底形态；实际发生过的形态）
  const parseFailed = buildResult({ issueType: 'parse_error', message: '模型未返回可解析的 JSON' });
  assert.equal(
    buildChatFormatGuardianAgentRun({
      now: 1000,
      sessionId: 'contact:boss',
      message: { id: 'm-guardian', role: 'assistant' },
      result: parseFailed,
    }).title,
    '格式检查未完成',
  );
  assert.equal(
    buildChatFormatGuardianMessagePart({
      now: 1000,
      sessionId: 'contact:boss',
      message: { id: 'm-guardian', role: 'assistant' },
      result: parseFailed,
    }).title,
    '格式检查未完成',
  );

  // 检查完成、真实格式问题：标题保持「聊天格式错误」，status 仍是 failed
  const realInvalid = buildChatFormatGuardianAgentRun({
    now: 1000,
    sessionId: 'contact:boss',
    message: { id: 'm-guardian', role: 'assistant' },
    result: buildResult({ issueType: 'missing_wrapper', message: '缺少 msg_start 包裹' }),
  });
  assert.equal(realInvalid.status, 'failed');
  assert.equal(realInvalid.title, '聊天格式错误');

  // 无 modelReview 的解析器级 invalid（未启用模型检查）：同样保持「聊天格式错误」
  assert.equal(
    buildChatFormatGuardianAgentRun({
      now: 1000,
      sessionId: 'contact:boss',
      message: { id: 'm-guardian', role: 'assistant' },
      result: { status: 'invalid', sourceMessageId: 'm-guardian', errors: ['content is required'], warnings: [] },
    }).title,
    '聊天格式错误',
  );
});

test('runChatFormatGuardianPreview keeps ready results silent by default', () => {
  const runs = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-ready',
      role: 'assistant',
      content: [
        '<我和菲伦的私聊>',
        '菲伦--今晚别一个人走。--22:10',
        '</我和菲伦的私聊>',
      ].join('\n'),
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
    },
    now: 1000,
    onChatFormatGuardianRun({ agentRun }) {
      runs.push(agentRun);
    },
  });

  assert.equal(result.result.status, 'ready');
  assert.equal(result.part, null);
  assert.equal(result.patchedMessage, null);
  assert.equal(result.agentRun, null);
  assert.equal(runs.length, 0);
});

test('runChatFormatGuardianPreview validates the full rawOriginal before cleaned content', () => {
  const message = {
    id: 'm-raw-original',
    role: 'assistant',
    content: '菲伦：今晚别一个人走。',
    raw: '菲伦：今晚别一个人走。',
    rawOriginal: [
      '<我和菲伦的私聊>',
      '菲伦--今晚别一个人走。',
      '</我和菲伦的私聊>',
    ].join('\n'),
  };

  assert.deepEqual(resolveChatFormatGuardianInputText(message), {
    text: message.rawOriginal,
    source: 'rawOriginal',
    hasRawOriginal: true,
  });

  const result = runChatFormatGuardianPreview({
    message,
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      manualTrigger: true,
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
    },
    now: 1000,
  });

  assert.equal(result.result.status, 'needs_review');
  assert.equal(result.result.sourceTextKind, 'rawOriginal');
  assert.equal(result.part.metadata.sourceTextKind, 'rawOriginal');
  assert.equal(result.part.metadata.repairCandidate, null);
  assert.equal(
    result.part.metadata.decisionActions.find(action => action.id === 'apply_repair')?.enabled,
    false,
  );
  assert.equal(result.agentRun.steps[0].input.sourceTextKind, 'rawOriginal');
  assert.equal(result.agentRun.metadata.repairCandidate, null);
  assert.equal(result.result.warnings.some(warning => warning.includes('phone shell marker')), true);
});

test('buildChatBodyQualityMessagePart summarizes issues without storing replacement text', () => {
  const part = buildChatBodyQualityMessagePart({
    now: 1000,
    sessionId: 'contact:firen',
    message: { id: 'm-body', role: 'assistant' },
    result: {
      status: 'minor_issues',
      sourceMessageId: 'm-body',
      sourceTextKind: 'rawOriginal',
      hasRawOriginal: true,
      issueCount: 1,
      issues: [{
        id: 'consecutive_duplicate_lines',
        severity: 'warning',
        title: '连续重复句段',
        summary: '发现 1 行连续重复正文。',
        risk: 'low',
        patchable: true,
      }],
      patchCandidate: {
        available: true,
        id: 'body_quality_deterministic_cleanup',
        title: '清理重复正文',
        summary: '移除 1 行连续重复',
        risk: 'low',
        replacementText: 'should not be stored in sidecar metadata',
        preview: '她看了看门口。',
      },
    },
  });
  assert.equal(part.kind, 'chat_body_quality.review');
  assert.equal(part.status, 'waiting_permission');
  assert.equal(part.title, '正文可优化');
  assert.equal(part.metadata.sourceTextKind, 'rawOriginal');
  assert.equal(part.metadata.patchCandidate.summary, '移除 1 行连续重复');
  assert.equal(part.metadata.patchCandidate.replacementText, undefined);
  assert.deepEqual(part.metadata.decisionActions.map(action => action.id), ['apply_body_patch', 'review_original', 'open_agent_center']);
  assert.equal(part.metadata.decisionActions[0].patchCandidate.summary, '移除 1 行连续重复');
  assert.equal(part.metadata.decisionActions[0].patchCandidate.replacementText, undefined);
  assert.equal(JSON.stringify(part).includes('should not be stored in sidecar metadata'), false);
});

test('buildChatBodyQualityAgentRun records review state without full replacement text', () => {
  const run = buildChatBodyQualityAgentRun({
    now: 1000,
    sessionId: 'contact:firen',
    message: { id: 'm-body-run', role: 'assistant' },
    result: {
      status: 'minor_issues',
      sourceMessageId: 'm-body-run',
      sourceTextKind: 'rawOriginal',
      hasRawOriginal: true,
      issueCount: 1,
      issues: [{
        id: 'consecutive_duplicate_lines',
        severity: 'warning',
        title: '连续重复句段',
        summary: '发现 1 行连续重复正文。',
        risk: 'low',
        patchable: true,
      }],
      patchCandidate: {
        available: true,
        id: 'body_quality_deterministic_cleanup',
        title: '清理重复正文',
        summary: '移除 1 行连续重复',
        risk: 'low',
        replacementText: 'hidden replacement',
        preview: '她看了看门口。',
      },
    },
  });
  assert.equal(run.id, 'run:chat-body-quality:m-body-run');
  assert.equal(run.kind, 'chat_body_quality_guardian');
  assert.equal(run.status, 'waiting_permission');
  assert.equal(run.finishedAt, null);
  assert.equal(run.steps[0].type, 'chat_body_quality.review');
  assert.equal(run.metadata.patchCandidate.replacementText, undefined);
  assert.equal(JSON.stringify(run).includes('hidden replacement'), false);
  assert.deepEqual(run.metadata.decisionActions.map(action => action.id), ['apply_body_patch', 'review_original', 'open_agent_center']);
});

test('runChatBodyQualityPreview stays silent for ready text by default', () => {
  const runs = [];
  const result = runChatBodyQualityPreview({
    message: {
      id: 'm-body-ready',
      role: 'assistant',
      content: '菲伦把伞往你这边偏了偏。',
    },
    sessionId: 'contact:firen',
    chatBodyQualityGuardian: { enabled: true },
    now: 1000,
    onChatBodyQualityRun({ agentRun }) {
      runs.push(agentRun);
    },
  });
  assert.equal(result.result.status, 'ready');
  assert.equal(result.part, null);
  assert.equal(result.patchedMessage, null);
  assert.equal(result.agentRun, null);
  assert.equal(runs.length, 0);
});

test('dispatchAfterReceiveEffects attaches chat format preview only through callback', () => {
  const calls = [];
  const message = {
    id: 'm-needs-review',
    role: 'assistant',
    content: [
      '<群聊:调查组>',
      '<成员>我,菲伦,雪</成员>',
      '<聊天内容>',
      '雪--我看到了门口的鞋印。',
      '</聊天内容>',
      '</群聊:调查组>',
    ].join('\n'),
  };

  const handled = dispatchAfterReceiveEffects({
    message,
    sessionId: 'group:case',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      manualTrigger: true,
      userName: '我',
      resolveGroupTargetId: name => (name === '调查组' ? 'group:case' : ''),
      resolveSpeakerId: name => (name === '雪' ? 'contact:snow' : ''),
    },
    onChatFormatGuardianPreview({ patchedMessage, result, part, sessionId }) {
      calls.push(['preview', sessionId, result.status, part.status, patchedMessage.meta.agentMessageParts.length]);
      assert.equal(patchedMessage.id, message.id);
    },
    applyUpdateVariable(received) {
      calls.push(['update', received.id]);
    },
    logger: { warn() {} },
  });

  assert.equal(handled, true);
  assert.equal(message.meta, undefined);
  assert.deepEqual(calls, [
    ['preview', 'group:case', 'needs_review', 'waiting_permission', 1],
    ['update', 'm-needs-review'],
  ]);
});

test('runChatFormatGuardianPreview keeps visible auto-mode bubbles out of format repair', async () => {
  const previews = [];
  const queued = [];
  let modelCalls = 0;
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-visible-delivered',
      role: 'assistant',
      content: '哎，小阿兰，歇过来了没？',
    },
    sessionId: 'contact:isabella',
    chatFormatGuardian: {
      enabled: true,
      userName: '阿兰',
      modelReview: {
        enabled: true,
        reviewNoEvents: true,
        backgroundChat: async () => {
          modelCalls += 1;
          return '{}';
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    onChatFormatGuardianModelReviewQueued(payload) {
      queued.push(payload);
    },
    logger: { warn() {} },
  });

  assert.equal(result.result.status, 'no_events');
  assert.equal(result.part, null);
  assert.equal(result.patchedMessage, null);
  assert.equal(result.agentRun, null);
  assert.equal(previews.length, 0);
  assert.equal(queued.length, 0);
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(modelCalls, 0);
});

test('runChatFormatGuardianPreview always asks permission for model repair of invisible parse failures', async () => {
  const queued = [];
  const previews = [];
  const repairs = [];
  const modelCalls = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-invisible-format',
      role: 'assistant',
      content: '',
      rawOriginal: [
        '<我和菲伦的私聊>',
        '菲伦--今晚别一个人走。',
        '</我和菲伦的私聊>',
      ].join('\n'),
      time: '22:12',
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      baseRevision: 'format-run:test-invisible',
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
      modelReview: {
        enabled: true,
        autoApplyRepair: true,
        enabledFormats: { phoneShell: true, privateChat: true },
        backgroundChat: async (messages) => {
          modelCalls.push(messages);
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'patch',
            baseRevision: 'format-run:test-invisible',
            issues: [{ severity: 'warning', type: 'missing_field', message: 'phone shell marker is missing' }],
            repairSummary: '补齐外壳标签',
            linePatches: buildMissingPrivateShellPatches(),
          });
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    onChatFormatGuardianModelReviewQueued(payload) {
      queued.push(payload);
    },
    onChatFormatGuardianAutoRepair(payload) {
      repairs.push(payload);
      return { didAnything: true, eventCount: 1 };
    },
    logger: { warn() {} },
  });

  assert.equal(result.result.status, 'needs_review');
  assert.equal(result.part, null);
  assert.equal(queued.length, 1);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(modelCalls.length, 1);
  assert.equal(repairs.length, 0);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].part.status, 'waiting_permission');
  assert.match(previews[0].part.metadata.repairCandidate.replacementText, /MiPhone_start/);
});

test('runChatFormatGuardianPreview does not auto-apply even when legacy autoApplyRepair is enabled', async () => {
  const previews = [];
  const runs = [];
  const repairs = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-auto-repair-no-events',
      role: 'assistant',
      content: '',
      rawOriginal: [
        '老板娘: [yy-今晚过来吗？]',
      ].join('\n'),
      time: '17:53',
      meta: { protocolParseFailure: true },
    },
    sessionId: '老板娘',
    chatFormatGuardian: {
      enabled: true,
      baseRevision: 'format-run:test-no-auto-apply',
      userName: '阿兰',
      modelReview: {
        enabled: true,
        autoApplyRepair: true,
        reviewNoEvents: true,
        enabledFormats: { phoneShell: true, privateChat: true },
        backgroundChat: async () => JSON.stringify({
          protocolVersion: 'format_patch.v1',
          status: 'patch',
          baseRevision: 'format-run:test-no-auto-apply',
          issues: [{ severity: 'error', type: 'missing_tag', message: '缺少私聊标签' }],
          repairSummary: '补齐标签',
          linePatches: [{
            startLine: 1,
            endLine: 1,
            originalLines: ['老板娘: [yy-今晚过来吗？]'],
            replacementLines: [
              'MiPhone_start',
              'msg_start',
              '<阿兰和老板娘的私聊>',
              '老板娘--[yy-今晚过来吗？]--17:53',
              '</阿兰和老板娘的私聊>',
              'msg_end',
              'MiPhone_end',
            ],
          }],
        }),
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    onChatFormatGuardianRun(payload) {
      runs.push(payload);
    },
    onChatFormatGuardianAutoRepair() {
      repairs.push(true);
      return { didAnything: true, eventCount: 1 };
    },
    logger: { warn() {} },
  });

  assert.equal(result.result.status, 'no_events');
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(previews.length, 1);
  assert.equal(previews[0].part.status, 'waiting_permission');
  assert.equal(previews[0].part.metadata.autoRepair, null);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentRun.metadata.autoRepair, null);
  assert.equal(repairs.length, 0);
});

test('runChatFormatGuardianPreview records model request failures for invisible parse failures', async () => {
  const queued = [];
  const completed = [];
  const previews = [];
  const runs = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-model-request-fails',
      role: 'assistant',
      content: '',
      rawOriginal: [
        'MiPhone_start',
        'msg_start',
        '<我和菲伦的私聊>',
        '菲伦--今晚别一个人走。--22:12',
        'msg_end',
        'MiPhone_end',
      ].join('\n'),
      meta: { protocolParseFailure: true },
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      userName: '我',
      modelReview: {
        enabled: true,
        reviewNoEvents: true,
        enabledFormats: { phoneShell: true, privateChat: true },
        backgroundChat: async () => {
          throw new Error('network down');
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    onChatFormatGuardianRun(payload) {
      runs.push(payload);
    },
    onChatFormatGuardianModelReviewQueued(payload) {
      queued.push(payload);
    },
    onChatFormatGuardianModelReviewCompleted(payload) {
      completed.push(payload);
    },
    logger: { warn() {} },
  });

  assert.equal(result.result.status, 'no_events');
  assert.equal(result.part, null);
  assert.equal(queued.length, 1);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(previews.length, 1);
  assert.equal(previews[0].result.status, 'invalid_output');
  assert.equal(previews[0].part.metadata.modelReview.canRepair, false);
  assert.match(previews[0].part.metadata.modelReview.issues[0].message, /network down/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentRun.status, 'failed');
  assert.match(runs[0].agentRun.errorMessage, /network down/);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].result.status, 'invalid_output');
});

test('runChatFormatGuardianPreview can attach async model format repair candidate', async () => {
  const previews = [];
  const runs = [];
  const queued = [];
  const modelCalls = [];
  const message = {
    id: 'm-model-format',
    role: 'assistant',
    content: [
      '<我和菲伦的私聊>',
      '菲伦--今晚别一个人走。',
      '</我和菲伦的私聊>',
    ].join('\n'),
    time: '22:12',
  };

  const result = runChatFormatGuardianPreview({
    message,
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      manualTrigger: true,
      baseRevision: 'format-run:test-async-candidate',
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
      modelReview: {
        enabled: true,
        enabledFormats: { phoneShell: true, privateChat: true, groupChat: false },
        formatReminderText: '私聊格式：说话人--正文--HH:mm',
        backgroundChat: async (messages, options) => {
          modelCalls.push({ messages, options });
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'patch',
            baseRevision: 'format-run:test-async-candidate',
            issues: [{
              severity: 'warning',
              type: 'missing_field',
              message: 'phone shell marker is missing',
              evidence: '菲伦--今晚别一个人走。',
            }],
            repairSummary: '补齐私聊外壳标签',
            linePatches: buildMissingPrivateShellPatches(),
          });
        },
        requestOptions: { temperature: 0, maxTokens: 900 },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    onChatFormatGuardianRun(payload) {
      runs.push(payload.agentRun);
    },
    onChatFormatGuardianModelReviewQueued(payload) {
      queued.push(payload);
    },
    logger: { warn() {} },
    now: () => 1000,
  });

  assert.equal(result.result.status, 'needs_review');
  assert.equal(previews.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].result.status, 'needs_review');
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0].messages[1].content, /私聊格式：说话人--正文--HH:mm/);
  assert.match(modelCalls[0].messages[1].content, /待检测 AI 原始回复/);
  assert.equal(previews.length, 2);
  const modelPart = previews[1].part;
  assert.equal(modelPart.metadata.modelReview.status, 'patch');
  assert.equal(modelPart.metadata.modelReview.correctedText, undefined);
  assert.equal(modelPart.metadata.modelReview.patchCount, 2);
  const repairAction = modelPart.metadata.decisionActions.find(action => action.id === 'apply_repair');
  assert.equal(repairAction.repairCandidate.kind, 'model_format_repair');
  assert.match(repairAction.repairCandidate.replacementText, /MiPhone_start/);
  assert.equal(repairAction.repairCandidate.formatTarget, 'private_chat');
  assert.deepEqual(
    repairAction.repairCandidate.formatSourceIds,
    ['phoneShell', 'privateChat', 'sceneFormatReminder'],
  );
  assert.equal(runs.at(-1).metadata.repairCandidate.replacementText, undefined);
  assert.equal(message.meta, undefined);
});

test('runChatFormatGuardianPreview retries one invalid patch response with the original snapshot', async () => {
  const modelCalls = [];
  const previews = [];
  runChatFormatGuardianPreview({
    message: {
      id: 'm-retry-invalid-patch',
      role: 'assistant',
      rawOriginal: [
        '<我和菲伦的私聊>',
        '菲伦--今晚别一个人走。',
        '</我和菲伦的私聊>',
      ].join('\n'),
      time: '22:12',
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      manualTrigger: true,
      baseRevision: 'format-run:test-retry-invalid',
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
      modelReview: {
        enabled: true,
        force: true,
        enabledFormats: { phoneShell: true, privateChat: true },
        backgroundChat: async (messages) => {
          modelCalls.push(messages);
          if (modelCalls.length === 1) {
            return JSON.stringify({
              protocolVersion: 'format_patch.v1',
              status: 'patch',
              baseRevision: 'format-run:test-retry-invalid',
              issues: [],
              repairSummary: '错误地返回完整全文',
              correctedText: 'forbidden',
              linePatches: [],
            });
          }
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'patch',
            baseRevision: 'format-run:test-retry-invalid',
            issues: [{ severity: 'warning', type: 'missing_field', message: '补齐外壳标签' }],
            repairSummary: '补齐外壳标签',
            linePatches: buildMissingPrivateShellPatches(),
          });
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    logger: { warn() {} },
  });

  await waitFor(() => modelCalls.length === 2 && previews.length >= 2, 'format repair retry did not finish');
  assert.match(modelCalls[1].at(-1).content, /Retry Required/);
  assert.match(modelCalls[1].at(-1).content, /corrected_text_forbidden/);
  assert.equal(previews.at(-1).result.status, 'needs_review');
  assert.equal(previews.at(-1).result.modelReview.attemptCount, 2);
  assert.match(previews.at(-1).part.metadata.repairCandidate.replacementText, /MiPhone_start/);
});

test('runChatFormatGuardianPreview closes as cannot_repair when two social candidates still cannot parse', async () => {
  const modelCalls = [];
  const previews = [];
  runChatFormatGuardianPreview({
    message: {
      id: 'm-domain-retry-fails',
      role: 'assistant',
      rawOriginal: '这是一行无法分发的普通文字',
      time: '22:12',
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      manualTrigger: true,
      baseRevision: 'format-run:test-domain-fail',
      repairTarget: {
        sourceKind: 'social_turn_raw',
        sourceSessionId: 'contact:firen',
        turnId: 'turn:test-domain-fail',
        sourceMessageIds: ['m-domain-retry-fails'],
      },
      modelReview: {
        enabled: true,
        force: true,
        enabledFormats: { privateChat: true },
        backgroundChat: async (messages) => {
          modelCalls.push(messages);
          const replacement = modelCalls.length === 1
            ? '仍然不是聊天协议'
            : '第二次仍然不是聊天协议';
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'patch',
            baseRevision: 'format-run:test-domain-fail',
            issues: [{ severity: 'error', type: 'missing_tag', message: '缺少协议结构' }],
            repairSummary: '尝试修复结构',
            linePatches: [{
              startLine: 1,
              endLine: 1,
              originalLines: ['这是一行无法分发的普通文字'],
              replacementLines: [replacement],
            }],
          });
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    logger: { warn() {} },
  });

  await waitFor(() => modelCalls.length === 2 && previews.length >= 1, 'social format recheck retry did not finish');
  assert.match(modelCalls[1].at(-1).content, /format_recheck_failed|格式复查结果/);
  assert.equal(previews.at(-1).result.status, 'cannot_repair');
  assert.equal(previews.at(-1).result.modelReview.canRepair, false);
  assert.equal(previews.at(-1).part.metadata.repairCandidate, null);
});

test('creative rawOriginal accepts a structurally valid patch without a social protocol gate', () => {
  const validation = validateChatFormatGuardianRepairCandidate({
    review: {
      status: 'patch',
      canRepair: true,
      candidateText: '修复后的创意正文',
    },
    inputText: '原始创意正文',
    options: {
      repairTarget: { sourceKind: 'creative_raw_original' },
    },
    modelOptions: {
      uiMode: 'rp',
    },
    formatProfile: {
      target: 'creative_text',
    },
  });
  assert.deepEqual(validation, {
    applicable: false,
    ok: true,
    status: 'creative_writeback_allowed',
    parserReport: null,
  });
});

test('runChatFormatGuardianPreview filters model format reminders by resolved target', async () => {
  const modelCalls = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-model-group-format',
      role: 'assistant',
      content: [
        '<群聊:调查组>',
        '<聊天内容>',
        '雪--我看到了鞋印。',
        '</聊天内容>',
        '</群聊:调查组>',
      ].join('\n'),
      time: '22:12',
    },
    sessionId: 'group:case',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      manualTrigger: true,
      baseRevision: 'format-run:test-profile-filter',
      userName: '我',
      resolveGroupTargetId: name => (name === '调查组' ? 'group:case' : ''),
      resolveSpeakerId: name => (name === '雪' ? 'contact:snow' : ''),
      modelReview: {
        enabled: true,
        enabledFormats: {
          phoneShell: true,
          privateChat: true,
          groupChat: true,
          imagePrompt: true,
        },
        formatReminderSections: [
          { content: '私聊格式提醒', formatIds: ['privateChat'], targets: ['private_chat'] },
          { content: '群聊格式提醒', formatIds: ['groupChat'], targets: ['group_chat'] },
          { content: '生图格式提醒', formatIds: ['imagePrompt'], targets: ['image_prompt'] },
        ],
        customFormatGuide: '调查组回复必须保留案件编号字段',
        backgroundChat: async (messages) => {
          modelCalls.push(messages);
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'cannot_repair',
            baseRevision: 'format-run:test-profile-filter',
            issues: [{ severity: 'warning', type: 'missing_field', message: 'time is missing' }],
            repairSummary: '测试返回',
            linePatches: [],
          });
        },
      },
    },
    logger: { warn() {} },
  });

  assert.equal(result.result.status, 'needs_review');
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(modelCalls.length, 1);
  const userPrompt = modelCalls[0][1].content;
  assert.match(userPrompt, /formatTarget: group_chat/);
  assert.match(userPrompt, /群聊格式提醒/);
  assert.match(userPrompt, /群聊格式/);
  assert.match(userPrompt, /调查组回复必须保留案件编号字段/);
  assert.doesNotMatch(userPrompt, /私聊格式提醒/);
  assert.doesNotMatch(userPrompt, /生图格式提醒/);
  assert.doesNotMatch(userPrompt, /图片提示词格式/);
  console.log('ok - chat format guardian model request filters format reminders by resolved target');
});

test('runChatFormatGuardianPreview asks model to suggest regeneration for empty assistant replies', async () => {
  const modelCalls = [];
  const queued = [];
  const previews = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-empty-format',
      role: 'assistant',
      content: '',
      rawOriginal: '',
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      baseRevision: 'format-run:test-empty',
      userName: '我',
      modelReview: {
        enabled: true,
        reviewNoEvents: true,
        enabledFormats: { phoneShell: true, privateChat: true },
        backgroundChat: async (messages) => {
          modelCalls.push(messages);
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'cannot_repair',
            baseRevision: 'format-run:test-empty',
            issues: [{ severity: 'error', type: 'parse_error', message: '没有可修复的有效内容' }],
            repairSummary: '没有可修复内容，建议重新生成。',
            linePatches: [],
          });
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    onChatFormatGuardianModelReviewQueued(payload) {
      queued.push(payload);
    },
    logger: { warn() {} },
  });

  assert.equal(result.result.status, 'no_events');
  assert.equal(result.part, null);
  assert.equal(queued.length, 1);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0][1].content, /建议用户重新生成/);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].result.status, 'cannot_repair');
  assert.equal(previews[0].part.metadata.modelReview.canRepair, false);
});

test('runChatFormatGuardianPreview skips model review when local format check is ready', async () => {
  let modelCalls = 0;
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-ready-format',
      role: 'assistant',
      content: [
        '<我和菲伦的私聊>',
        '菲伦--今晚别一个人走。--22:12',
        '</我和菲伦的私聊>',
      ].join('\n'),
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
      modelReview: {
        enabled: true,
        backgroundChat: async () => {
          modelCalls += 1;
          return '{}';
        },
      },
    },
    logger: { warn() {} },
  });
  assert.equal(result.result.status, 'ready');
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(modelCalls, 0);
});

test('runChatFormatGuardianPreview can force model review for manual checks', async () => {
  let modelCalls = 0;
  const previews = [];
  const result = runChatFormatGuardianPreview({
    message: {
      id: 'm-manual-ready-format',
      role: 'assistant',
      content: [
        '<我和菲伦的私聊>',
        '菲伦--今晚别一个人走。--22:12',
        '</我和菲伦的私聊>',
      ].join('\n'),
    },
    sessionId: 'contact:firen',
    chatFormatGuardian: {
      enabled: true,
      baseRevision: 'format-run:test-force',
      userName: '我',
      resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
      resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
      modelReview: {
        enabled: true,
        force: true,
        backgroundChat: async () => {
          modelCalls += 1;
          return JSON.stringify({
            protocolVersion: 'format_patch.v1',
            status: 'patch',
            baseRevision: 'format-run:test-force',
            issues: [{ severity: 'warning', type: 'other', message: 'manual repair' }],
            repairSummary: '手动复核修复',
            linePatches: [{
              startLine: 2,
              endLine: 2,
              originalLines: ['菲伦--今晚别一个人走。--22:12'],
              replacementLines: ['菲伦--今晚别一个人走。--22:13'],
            }],
          });
        },
      },
    },
    onChatFormatGuardianPreview(payload) {
      previews.push(payload);
    },
    logger: { warn() {} },
  });
  assert.equal(result.result.status, 'ready');
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(modelCalls, 1);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].part.metadata.repairCandidate.kind, 'model_format_repair');
});

test('dispatchAfterReceiveEffects merges chat format and body quality sidecars', () => {
  const calls = [];
  const runs = [];
  const message = {
    id: 'm-combined-review',
    role: 'assistant',
    rawOriginal: [
      '<群聊:调查组>',
      '<成员>我,菲伦,雪</成员>',
      '<聊天内容>',
      '雪--我看到了门口的鞋印。',
      '雪--我看到了门口的鞋印。',
      '</聊天内容>',
      '</群聊:调查组>',
    ].join('\n'),
    content: '清理后正文',
  };

  dispatchAfterReceiveEffects({
    message,
    sessionId: 'group:case',
    chatFormatGuardian: {
      enabled: true,
      enabledFormats: { phoneShell: true },
      manualTrigger: true,
      userName: '我',
      resolveGroupTargetId: name => (name === '调查组' ? 'group:case' : ''),
      resolveSpeakerId: name => (name === '雪' ? 'contact:snow' : ''),
    },
    chatBodyQualityGuardian: { enabled: true },
    onChatFormatGuardianPreview({ patchedMessage }) {
      calls.push(['format', patchedMessage.meta.agentMessageParts.map(part => part.kind)]);
    },
    onChatBodyQualityPreview({ patchedMessage }) {
      calls.push(['body', patchedMessage.meta.agentMessageParts.map(part => part.kind)]);
    },
    onChatFormatGuardianRun({ agentRun }) {
      runs.push(agentRun.kind);
    },
    onChatBodyQualityRun({ agentRun }) {
      runs.push(agentRun.kind);
    },
    logger: { warn() {} },
  });

  assert.deepEqual(calls, [
    ['format', ['chat_format.validate']],
    ['body', ['chat_format.validate', 'chat_body_quality.review']],
  ]);
  assert.deepEqual(runs, ['chat_format_guardian', 'chat_body_quality_guardian']);
  assert.equal(message.meta, undefined);
});

test('dispatchAfterReceiveEffects respects skipScripts and logs async/sync failures', async () => {
  const warnings = [];
  dispatchAfterReceiveEffects({
    message: { id: 'm2', role: 'assistant' },
    sessionId: 's3',
    skipScripts: true,
    defaultSkipScripts: false,
    scriptRuntime: {
      dispatchEvent() {
        throw new Error('script should be skipped');
      },
    },
    pluginRuntime: {
      dispatchEvent() {
        return Promise.reject(new Error('plugin failed'));
      },
    },
    applyUpdateVariable() {
      throw new Error('update failed');
    },
    handleVariableRules() {
      return Promise.reject(new Error('rules failed'));
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });
  await flushMicrotasks();
  assert.deepEqual(warnings, [
    'UpdateVariable parse failed',
    'plugin message.after_receive failed',
    'variable rules after_receive failed',
  ]);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) process.exit(1);
