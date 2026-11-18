import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildRegenerateFinishTraceEvent,
  buildRegenerateStartTraceEvent,
  buildSendBlockedTraceEvent,
  buildSendFlowTraceEvent,
  buildSendFinishTraceEvent,
  buildSendPreflightBlockedTraceEvent,
  buildSendStartTraceEvent,
  buildSendUserMessage,
  collectMaidAssistantMessageRefs,
  createSendGenerationAbortGuard,
  adoptRenderedRegenerateRoundMessages,
  normalizeHandleSendInvocation,
  normalizeHandleSendOptions,
  resolveMaidChatSendCompletionResult,
  resolveRegenerateFromUserIndexPlan,
  resolveSendPreflightBlock,
  isChatSendTargetAvailable,
  resolveSyspromptProtocolFlags,
  runAbortableSendFlow,
  runPendingSendPreparationFlow,
  runRegenerateFromUserIndexFlow,
  runSendCatchFlow,
  runSendFinallyFlow,
} from '../../src/scripts/ui/chat/send-flow-utils.js';
import { isPhoneChatFormatInjected } from '../../src/scripts/ui/chat/prompt-context-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('runAbortableSendFlow relays a tool timeout signal to the active generation and cleans up', async () => {
  const controller = new AbortController();
  const aborts = [];
  let finishSend = null;
  const pending = runAbortableSendFlow({
    signal: controller.signal,
    runSend: () => new Promise(resolve => {
      finishSend = resolve;
    }),
    abortGeneration: reason => aborts.push(reason),
  });

  const timeoutReason = Object.assign(new Error('Agent tool timed out'), {
    code: 'generation_failed',
  });
  controller.abort(timeoutReason);
  finishSend({ ok: false });
  assert.deepEqual(await pending, { ok: false });
  assert.deepEqual(aborts, [timeoutReason]);

  controller.abort(new Error('late abort'));
  assert.equal(aborts.length, 1);
});

test('runAbortableSendFlow removes its abort listener once assistant delivery is terminal', async () => {
  const controller = new AbortController();
  const aborts = [];
  let finishSend = null;
  let disarmAfterDelivery = null;
  const pending = runAbortableSendFlow({
    signal: controller.signal,
    runSend: ({ disarmAbort }) => {
      disarmAfterDelivery = disarmAbort;
      return new Promise(resolve => {
        finishSend = resolve;
      });
    },
    abortGeneration: reason => aborts.push(reason),
  });

  assert.equal(disarmAfterDelivery(), true);
  controller.abort(Object.assign(new Error('late timeout'), { code: 'generation_failed' }));
  assert.deepEqual(aborts, [], 'assistant_delivered 后工具 abort 监听必须解除');
  finishSend({ ok: true, completionOutcome: 'assistant_delivered' });
  assert.equal((await pending).ok, true);
  assert.equal(disarmAfterDelivery(), false, '解除武装必须幂等');
});

test('createSendGenerationAbortGuard only cancels its owned generation and disarms after delivery', () => {
  let activeGeneration = { id: 7, sessionId: 'room-1' };
  const cancelled = [];
  const guard = createSendGenerationAbortGuard({
    getActiveGeneration: () => activeGeneration,
    cancelGeneration: (reason, generationId) => cancelled.push([reason, generationId]),
  });
  const timeout = Object.assign(new Error('timeout'), { code: 'generation_failed' });

  assert.equal(guard.abort(timeout), false, 'generation 建立前不得误取消别轮');
  assert.equal(guard.bindGeneration(7), true);
  assert.equal(guard.abort(timeout), true);
  assert.deepEqual(cancelled, [[timeout, 7]]);

  activeGeneration = { id: 8, sessionId: 'room-1' };
  assert.equal(guard.abort(timeout), false, '旧轮 abort 不得取消同会话新 generation');
  guard.disarm();
  activeGeneration = { id: 7, sessionId: 'room-1' };
  assert.equal(guard.abort(timeout), false, 'assistant_delivered 后迟到 abort 必须完全无动作');
  assert.deepEqual(cancelled, [[timeout, 7]]);
});

test('collectMaidAssistantMessageRefs keeps committed cross-session replies with their session ids', () => {
  const messages = new Map([
    ['source:new', { id: 'source:new', role: 'assistant' }],
    ['other:assistant', { id: 'other:assistant', role: 'assistant' }],
    ['other:user', { id: 'other:user', role: 'user' }],
  ]);
  const refs = collectMaidAssistantMessageRefs({
    sourceSessionId: 'source',
    assistantMessageIdsBefore: ['source:old'],
    currentSessionMessages: [
      { id: 'source:old', role: 'assistant' },
      messages.get('source:new'),
    ],
    trackedMessageRefs: [
      { targetSessionId: 'other', messageId: 'other:assistant' },
      { targetSessionId: 'other', messageId: 'other:user' },
      { targetSessionId: 'other', messageId: 'other:deleted' },
      { targetSessionId: 'source', messageId: 'source:new' },
    ],
    findMessage: (messageId) => messages.get(messageId) || null,
  });
  assert.deepEqual(refs, [
    { sessionId: 'other', messageId: 'other:assistant' },
    { sessionId: 'source', messageId: 'source:new' },
  ]);
});

test('resolveMaidChatSendCompletionResult distinguishes delivered, rejected, and config-blocked outcomes', () => {
  assert.deepEqual(resolveMaidChatSendCompletionResult({
    pipelineSucceeded: true,
    requestTriggered: true,
    protocolEnabled: true,
    protocolAccepted: true,
    assistantMessageIds: ['assistant-1'],
    assistantMessageRefs: [
      { sessionId: 'elf', messageId: 'assistant-1' },
      { sessionId: 'other-room', messageId: 'assistant-2' },
    ],
    sessionId: 'elf',
  }), {
    ok: true,
    sent: true,
    requested: true,
    requestTriggered: true,
    completionOutcome: 'assistant_delivered',
    failureCode: '',
    reason: '',
    message: '角色回复已通过协议验收并落库。',
    assistantMessageIds: ['assistant-1', 'assistant-2'],
    assistantMessageRefs: [
      { sessionId: 'elf', messageId: 'assistant-1' },
      { sessionId: 'other-room', messageId: 'assistant-2' },
    ],
    sessionId: 'elf',
  });
  const rejected = resolveMaidChatSendCompletionResult({
    pipelineSucceeded: false,
    requestTriggered: true,
    protocolEnabled: true,
    protocolAccepted: false,
    sessionId: 'elf',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.sent, true);
  assert.equal(rejected.completionOutcome, 'protocol_rejected');
  assert.equal(rejected.failureCode, 'protocol_rejected');
  const blocked = resolveMaidChatSendCompletionResult({
    blockedReason: 'api-not-configured',
    sessionId: 'elf',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.sent, false);
  assert.equal(blocked.completionOutcome, 'blocked_by_config');
  assert.equal(blocked.failureCode, 'blocked_by_config');
});

test('resolveMaidChatSendCompletionResult keeps the cancelled flag on a post-trigger abort', () => {
  const aborted = resolveMaidChatSendCompletionResult({
    pipelineSucceeded: false,
    requestTriggered: true,
    cancelled: true,
    sessionId: 'elf',
  });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.sent, true, '触发后中止时 sent 仍为 true');
  assert.equal(aborted.cancelled, true, '触发后中止必须携带 cancelled 标志供工具层识别');
  assert.equal(aborted.completionOutcome, 'request_triggered');
  assert.equal(aborted.failureCode, 'user_aborted');
  const delivered = resolveMaidChatSendCompletionResult({
    pipelineSucceeded: true,
    requestTriggered: true,
    sessionId: 'elf',
  });
  assert.equal('cancelled' in delivered, false, '非中止结果不应出现 cancelled 字段');
});

test('resolveMaidChatSendCompletionResult reports target deletion distinctly from user abort', () => {
  const result = resolveMaidChatSendCompletionResult({
    requestTriggered: true,
    cancelled: true,
    cancelReason: 'session_deleted',
    sessionId: 'deleted-room',
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.failureCode, 'session_deleted');
  assert.equal(result.reason, 'session_deleted');
  assert.match(result.message, /聊天室已删除/);
});

test('normalizeHandleSendInvocation treats DOM-style events as empty send arguments', () => {
  const eventLike = {
    preventDefault() {},
  };

  assert.deepEqual(normalizeHandleSendInvocation(eventLike, { overrideText: 'ignored' }), {
    targetMessageId: null,
    options: {},
  });
});

test('buildSendFlowTraceEvent normalizes generation trace metadata and drops undefined details', () => {
  assert.deepEqual(buildSendFlowTraceEvent({
    phase: ' send.start ',
    sessionId: ' s1 ',
    status: ' started ',
    summary: ' started ',
    details: {
      generationId: 1,
      ignored: undefined,
      hasAttachments: false,
    },
  }), {
    category: 'generation',
    source: 'send-flow',
    phase: 'send.start',
    sessionId: 's1',
    status: 'started',
    summary: 'started',
    details: {
      generationId: 1,
      hasAttachments: false,
    },
  });
});

test('send trace patch builders preserve raw start and finish payload contracts', () => {
  assert.deepEqual(buildSendBlockedTraceEvent({
    sessionId: ' session-blocked ',
    activeGenerationId: 6,
  }), {
    phase: 'send.blocked',
    sessionId: 'session-blocked',
    status: 'skipped',
    summary: 'send skipped because generation is active',
    details: {
      activeGenerationId: 6,
    },
  });
  assert.deepEqual(buildSendPreflightBlockedTraceEvent({
    sessionId: ' session-preflight ',
    reason: ' api-not-configured ',
  }), {
    phase: 'send.preflight.blocked',
    sessionId: 'session-preflight',
    status: 'skipped',
    summary: 'send blocked before generation started',
    details: {
      reason: 'api-not-configured',
    },
  });
  assert.deepEqual(buildSendStartTraceEvent({
    sessionId: ' session-send ',
    generationId: 7,
    stream: 1,
    protocolEnabled: true,
    rpUiMode: false,
    isGroupChat: true,
    hasAttachments: true,
    attachmentCount: '2',
    pendingCount: 3,
    suppressUserMessage: false,
    hasContinueTarget: true,
    hasSwipeTarget: false,
  }), {
    phase: 'send.start',
    sessionId: 'session-send',
    status: 'started',
    summary: 'send flow started',
    details: {
      generationId: 7,
      stream: true,
      protocolEnabled: true,
      rpUiMode: false,
      isGroupChat: true,
      hasAttachments: true,
      attachmentCount: 2,
      pendingCount: 3,
      suppressUserMessage: false,
      hasContinueTarget: true,
      hasSwipeTarget: false,
    },
  });
  assert.deepEqual(buildSendFinishTraceEvent({
    sessionId: 'session-send',
    generationId: 7,
    sendSucceeded: true,
  }), {
    phase: 'send.finish',
    sessionId: 'session-send',
    status: 'success',
    summary: 'send flow completed',
    details: {
      generationId: 7,
      sendSucceeded: true,
      cancelled: undefined,
      errorMessage: undefined,
    },
  });
  assert.deepEqual(buildSendFinishTraceEvent({
    sessionId: 'session-send',
    generationId: 8,
    sendSucceeded: false,
    suppressErrorUI: true,
    sendErrorMessage: '用户取消',
  }), {
    phase: 'send.finish',
    sessionId: 'session-send',
    status: 'cancelled',
    summary: 'send flow stopped',
    details: {
      generationId: 8,
      sendSucceeded: false,
      cancelled: true,
      errorMessage: '用户取消',
    },
  });
});

test('regenerate trace patch builders preserve start success and skipped payload contracts', () => {
  assert.deepEqual(buildRegenerateStartTraceEvent({
    sessionId: ' session-regen ',
    userIdx: 2,
    allowEmpty: true,
    regenMessageCount: '3',
  }), {
    phase: 'regenerate.start',
    sessionId: 'session-regen',
    status: 'started',
    summary: 'regenerate flow started',
    details: {
      userIdx: 2,
      allowEmpty: true,
      regenMessageCount: 3,
    },
  });
  assert.deepEqual(buildRegenerateFinishTraceEvent({
    sessionId: 'session-regen',
    status: 'success',
    userIdx: 2,
    allowEmpty: false,
    regenMessageCount: 3,
    resent: true,
  }), {
    phase: 'regenerate.finish',
    sessionId: 'session-regen',
    status: 'success',
    summary: 'regenerate flow completed',
    details: {
      userIdx: 2,
      allowEmpty: false,
      regenMessageCount: 3,
      resent: true,
    },
  });
  assert.deepEqual(buildRegenerateFinishTraceEvent({
    sessionId: 'session-regen',
    status: 'skipped',
    userIdx: 2,
    allowEmpty: true,
    reason: 'empty-user-message',
  }), {
    phase: 'regenerate.finish',
    sessionId: 'session-regen',
    status: 'skipped',
    summary: 'regenerate flow skipped',
    details: {
      userIdx: 2,
      allowEmpty: true,
      reason: 'empty-user-message',
    },
  });
});

test('resolveSendPreflightBlock returns toast-only configured offline ui contracts', () => {
  assert.deepEqual(resolveSendPreflightBlock({
    bridgeConfigured: false,
    online: true,
  }), {
    blocked: true,
    reason: 'api-not-configured',
    toastMessage: '请先配置 API 信息',
    toastTitle: '未配置',
    showConfigPanel: true,
  });

  assert.deepEqual(resolveSendPreflightBlock({
    bridgeConfigured: true,
    online: false,
  }), {
    blocked: true,
    reason: 'offline',
    toastMessage: '离线状态，无法发送',
    toastTitle: '',
    showConfigPanel: false,
  });

  assert.deepEqual(resolveSendPreflightBlock({
    bridgeConfigured: true,
    online: true,
  }), {
    blocked: false,
    reason: '',
    toastMessage: '',
    toastTitle: '',
    showConfigPanel: false,
  });
});

test('buildSendUserMessage preserves sticker and regex user message contracts', () => {
  assert.deepEqual(buildSendUserMessage({
    text: '/贴纸 开心',
    userName: '小明',
    userAvatar: 'user.png',
    time: '10:00',
    isStickerAllowed: () => true,
    parseStickerToken: text => (text.includes('开心') ? '开心' : ''),
    applyInputStoredRegex: () => {
      throw new Error('regex should not run for stickers');
    },
  }), {
    role: 'user',
    type: 'sticker',
    content: '开心',
    raw: '/贴纸 开心',
    rawInput: '/贴纸 开心',
    name: '小明',
    avatar: 'user.png',
    time: '10:00',
  });

  const regexCalls = [];
  assert.deepEqual(buildSendUserMessage({
    text: 'hello',
    userName: '我',
    userAvatar: 'me.png',
    time: '10:01',
    isStickerAllowed: () => false,
    parseStickerToken: () => 'ignored',
    applyInputStoredRegex: (value, opts) => {
      regexCalls.push(['stored', value, opts]);
      return `stored:${value}`;
    },
    applyInputDisplayRegex: (value, opts) => {
      regexCalls.push(['display', value, opts]);
      return `display:${value}`;
    },
  }), {
    role: 'user',
    type: 'text',
    content: 'display:stored:hello',
    raw: 'stored:hello',
    rawInput: 'hello',
    name: '我',
    avatar: 'me.png',
    time: '10:01',
  });
  assert.deepEqual(regexCalls, [
    ['stored', 'hello', { isEdit: false }],
    ['display', 'stored:hello', { isEdit: false, depth: 0 }],
  ]);
});

test('normalizeHandleSendInvocation upgrades object target into options payload', () => {
  const swipeTarget = { msgId: 'assistant-1' };
  const result = normalizeHandleSendInvocation({
    overrideText: '继续',
    swipeTarget,
  });

  assert.equal(result.targetMessageId, null);
  assert.equal(result.options.overrideText, '继续');
  assert.equal(result.options.swipeTarget, swipeTarget);
});

test('normalizeHandleSendOptions preserves valid fields and deduplicates excluded ids', () => {
  const streamFactory = () => ({});
  const partialCommitHandler = () => true;
  const onGenerationStarted = () => {};
  const onAssistantDelivered = () => {};
  const abortController = new AbortController();
  const swipeTarget = { msgId: 'assistant-2' };
  const continueTarget = { messageId: 'assistant-2', prefix: '继续' };

  const result = normalizeHandleSendOptions({
    overrideText: '  保留空格  ',
    ignorePending: 1,
    suppressUserMessage: 'yes',
    existingUserMessageId: 'user-1',
    skipInputRegex: true,
    skipTemplate: true,
    skipScripts: true,
    previewOnly: true,
    previewSessionId: '  rp:persona-1  ',
    suppressAssistantDom: true,
    createAssistantStream: streamFactory,
    continueTarget,
    partialCommitHandler,
    onGenerationStarted,
    onAssistantDelivered,
    abortSignal: abortController.signal,
    swipeTarget,
    excludeMessageIds: ['assistant-2', 'assistant-3', '', null],
    includeAttachments: false,
  });

  assert.equal(result.overrideTextRaw, '  保留空格  ');
  assert.equal(result.hasOverrideText, true);
  assert.equal(result.overrideText, '  保留空格  ');
  assert.equal(result.ignorePending, true);
  assert.equal(result.suppressUserMessage, true);
  assert.equal(result.existingUserMessageId, 'user-1');
  assert.equal(result.skipInputRegex, true);
  assert.equal(result.skipTemplate, true);
  assert.equal(result.skipScripts, true);
  assert.equal(result.previewOnly, true);
  assert.equal(result.previewSessionId, 'rp:persona-1');
  assert.equal(result.suppressAssistantDom, true);
  assert.equal(result.assistantStreamFactory, streamFactory);
  assert.equal(result.continueTarget, continueTarget);
  assert.equal(result.partialCommitHandler, partialCommitHandler);
  assert.equal(result.onGenerationStarted, onGenerationStarted);
  assert.equal(result.onAssistantDelivered, onAssistantDelivered);
  assert.equal(result.abortSignal, abortController.signal);
  assert.equal(result.swipeTarget, swipeTarget);
  assert.deepEqual(result.excludeMessageIds, ['assistant-2', 'assistant-3']);
  assert.equal(result.includeAttachments, false);
});

test('normalizeHandleSendOptions falls back safely for invalid payloads', () => {
  const result = normalizeHandleSendOptions({
    overrideText: '   ',
    existingUserMessageId: 123,
    createAssistantStream: 'not-fn',
    continueTarget: 'bad',
    partialCommitHandler: 'bad',
    onGenerationStarted: 'bad',
    onAssistantDelivered: 'bad',
    abortSignal: null,
    swipeTarget: 'bad',
  });

  assert.equal(result.overrideTextRaw, '   ');
  assert.equal(result.hasOverrideText, true);
  assert.equal(result.overrideText, '');
  assert.equal(result.existingUserMessageId, '');
  assert.equal(result.assistantStreamFactory, null);
  assert.equal(result.continueTarget, null);
  assert.equal(result.partialCommitHandler, null);
  assert.equal(result.onGenerationStarted, null);
  assert.equal(result.onAssistantDelivered, null);
  assert.equal(result.abortSignal, null);
  assert.equal(result.swipeTarget, null);
  assert.deepEqual(result.excludeMessageIds, []);
  assert.equal(result.previewOnly, false);
  assert.equal(result.previewSessionId, '');
  assert.equal(result.includeAttachments, true);
});

test('runPendingSendPreparationFlow restores pending queue, appends input, marks sending, and dispatches hooks', () => {
  const calls = [];
  let nextInputId = 1;
  const store = new Map([
    ['p0', { id: 'p0', status: 'pending', raw: 'history text', content: 'history display' }],
  ]);
  const appendMessage = (message, sessionId) => {
    const id = message.id || `input-${nextInputId++}`;
    const saved = { ...message, id };
    calls.push(['append', sessionId, saved]);
    store.set(id, saved);
    return saved;
  };
  const ui = {
    addMessage(message) {
      calls.push(['ui-add', message.id]);
    },
    updateMessage(messageId, message) {
      calls.push(['ui-update', messageId, message.status]);
    },
  };
  const chatStore = {
    updateMessage(messageId, patch, sessionId) {
      const next = { ...(store.get(messageId) || { id: messageId }), ...patch };
      calls.push(['store-update', sessionId, messageId, patch]);
      store.set(messageId, next);
      return next;
    },
    findMessage(messageId) {
      return store.get(messageId);
    },
  };

  const result = runPendingSendPreparationFlow({
    allMessages: [store.get('p0')],
    pendingQueue: [{ id: 'q1', status: 'queued', content: 'queued text' }],
    sessionId: 'session-a',
    getInputText: () => ' /贴纸 开心 ',
    getActiveUserProfile: () => ({ name: ' 小明 ' }),
    isStickerAllowed: () => true,
    parseStickerToken: () => '开心',
    getReplyTargetForSession: () => ({ messageId: 'assistant-1' }),
    clearReplyTargetForSession: sessionId => calls.push(['clear-reply', sessionId]),
    formatNowTime: () => '10:00',
    userAvatar: 'user.png',
    appendMessage,
    addMessageToUi: message => ui.addMessage(message),
    removePendingMessage: (messageId, sessionId) => calls.push(['remove-pending', sessionId, messageId]),
    clearInput: () => calls.push(['clear-input']),
    buildStickerToken: value => `[贴纸:${value}]`,
    chatStore,
    ui,
    skipScripts: true,
    pluginRuntime: {
      dispatchEvent(event, payload) {
        calls.push(['plugin', event, payload.message.id, payload.sessionId]);
        return Promise.resolve();
      },
    },
    refreshChatAndContacts: options => calls.push(['refresh', options]),
    updatePendingFloat: sessionId => calls.push(['pending-float', sessionId]),
  });

  assert.equal(result.shouldContinue, true);
  assert.equal(result.text, 'history text\nqueued text\n/贴纸 开心');
  assert.deepEqual(result.pendingMessagesToConfirm.map(message => [message.id, message.status]), [
    ['p0', 'sending'],
    ['q1', 'sending'],
    ['input-1', 'sending'],
  ]);
  assert.deepEqual(calls, [
    ['append', 'session-a', { id: 'q1', status: 'pending', content: 'queued text' }],
    ['ui-add', 'q1'],
    ['remove-pending', 'session-a', 'q1'],
    ['append', 'session-a', {
      role: 'user',
      type: 'sticker',
      content: '开心',
      raw: '/贴纸 开心',
      rawInput: '/贴纸 开心',
      status: 'pending',
      avatar: 'user.png',
      name: '小明',
      time: '10:00',
      meta: { replyTo: { messageId: 'assistant-1' } },
      id: 'input-1',
    }],
    ['ui-add', 'input-1'],
    ['clear-input'],
    ['clear-reply', 'session-a'],
    ['store-update', 'session-a', 'p0', { status: 'sending' }],
    ['ui-update', 'p0', 'sending'],
    ['store-update', 'session-a', 'q1', { status: 'sending' }],
    ['ui-update', 'q1', 'sending'],
    ['store-update', 'session-a', 'input-1', { status: 'sending' }],
    ['ui-update', 'input-1', 'sending'],
    ['plugin', 'message.after_send', 'p0', 'session-a'],
    ['plugin', 'message.after_send', 'q1', 'session-a'],
    ['plugin', 'message.after_send', 'input-1', 'session-a'],
    ['refresh', { immediate: true }],
    ['pending-float', 'session-a'],
  ]);
});

test('runPendingSendPreparationFlow reports missing pending target and supports empty continuation sends', () => {
  const errors = [];
  const missing = runPendingSendPreparationFlow({
    allMessages: [{ id: 'p0', status: 'pending', content: 'pending' }],
    targetMessageId: 'missing',
    showError: message => errors.push(message),
  });

  assert.deepEqual(missing, {
    shouldContinue: false,
    text: '',
    pendingMessagesToConfirm: [],
    errorMessage: '未找到指定消息',
  });
  assert.deepEqual(errors, ['未找到指定消息']);

  const emptyBlocked = runPendingSendPreparationFlow({
    allMessages: [],
    getInputText: () => '',
  });
  assert.equal(emptyBlocked.shouldContinue, false);

  const continuation = runPendingSendPreparationFlow({
    allMessages: [],
    getInputText: () => '',
    continueTarget: { messageId: 'assistant-1' },
  });
  assert.deepEqual(continuation, {
    shouldContinue: true,
    text: '',
    pendingMessagesToConfirm: [],
    handledPending: false,
  });
});

test('resolveRegenerateFromUserIndexPlan rejects invalid sending or non-latest user rounds', () => {
  const sending = resolveRegenerateFromUserIndexPlan({
    messages: [{ id: 'u1', role: 'user', status: 'sending' }],
    userIdx: 0,
  });
  assert.equal(sending.canRegenerate, false);
  assert.equal(sending.warningMessage, '发送中的消息无法重生成');
  assert.equal(sending.reason, 'user-message-sending');

  const notLatest = resolveRegenerateFromUserIndexPlan({
    messages: [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
    ],
    userIdx: 0,
  });
  assert.equal(notLatest.canRegenerate, false);
  assert.equal(notLatest.nextUserIdx, 2);
  assert.equal(notLatest.warningMessage, '只能重生成最新一轮回复');
});

test('resolveRegenerateFromUserIndexPlan returns latest assistant and synthetic messages for deletion', () => {
  const syntheticUser = { id: 'su1', role: 'user', meta: { generatedByAssistant: true } };
  const plan = resolveRegenerateFromUserIndexPlan({
    messages: [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      syntheticUser,
      { id: 'meta1', role: 'system' },
    ],
    userIdx: 0,
    isSyntheticUser: message => message?.meta?.generatedByAssistant === true,
  });
  assert.equal(plan.canRegenerate, true);
  assert.equal(plan.prevUser.id, 'u1');
  assert.deepEqual(plan.regenMessages.map(message => message.id), ['a1', 'su1']);
  assert.deepEqual(plan.roundMessages.map(message => message.id), ['a1', 'su1', 'meta1']);
});

test('resolveRegenerateFromUserIndexPlan supports empty assistant rounds only when allowed', () => {
  const rejected = resolveRegenerateFromUserIndexPlan({
    messages: [{ id: 'u1', role: 'user' }],
    userIdx: 0,
    allowEmpty: false,
  });
  assert.equal(rejected.canRegenerate, false);
  assert.equal(rejected.warningMessage, '未找到可重生成的 AI 回复');

  const allowed = resolveRegenerateFromUserIndexPlan({
    messages: [{ id: 'u1', role: 'user' }],
    userIdx: 0,
    allowEmpty: true,
  });
  assert.equal(allowed.canRegenerate, true);
  assert.deepEqual(allowed.regenMessages, []);
});

test('adoptRenderedRegenerateRoundMessages persists DOM-only replies before regenerate', () => {
  const messages = [
    { id: 'u1', role: 'user', raw: '用户消息' },
  ];
  const appended = [];
  const renderedWrapper = {};
  const renderedPartial = {
    id: 'a-partial',
    role: 'assistant',
    type: 'text',
    content: '中止部分',
    meta: { renderRich: true },
  };
  const adopted = adoptRenderedRegenerateRoundMessages({
    messages,
    userIdx: 0,
    renderedMessages: [
      { wrapper: {}, message: messages[0] },
      { wrapper: renderedWrapper, message: renderedPartial },
      { wrapper: {}, message: { id: 'a-empty', role: 'assistant', content: '   ' } },
    ],
    sessionId: 'session-regen',
    chatStore: {
      appendMessage: (message, sessionId) => {
        const saved = { ...message, sessionId };
        appended.push(saved);
        messages.push(saved);
        return saved;
      },
    },
    isSyntheticUser: message => message?.meta?.generatedByAssistant === true,
  });

  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].entry.wrapper, renderedWrapper);
  assert.equal(adopted[0].saved.id, 'a-partial');
  assert.equal(appended[0].sessionId, 'session-regen');
  assert.deepEqual(messages.map(message => message.id), ['u1', 'a-partial']);
  const plan = resolveRegenerateFromUserIndexPlan({
    messages,
    userIdx: 0,
    allowEmpty: false,
    isSyntheticUser: message => message?.meta?.generatedByAssistant === true,
  });
  assert.equal(plan.canRegenerate, true);
  assert.deepEqual(plan.regenMessages.map(message => message.id), ['a-partial']);
});

test('runRegenerateFromUserIndexFlow deletes regen messages restores table memory and resends user text', async () => {
  const calls = [];
  const messages = [
    { id: 'u1', role: 'user', raw: '原始用户消息' },
    { id: 'a1', role: 'assistant' },
    { id: 'synthetic-1', role: 'user', meta: { generatedByAssistant: true } },
  ];

  const result = await runRegenerateFromUserIndexFlow({
    messages,
    userIdx: 0,
    allowEmpty: false,
    isSyntheticUser: message => message?.meta?.generatedByAssistant === true,
    sessionId: 'session-regen',
    chatStore: {
      deleteMessage: (messageId, sessionId) => calls.push(['delete', messageId, sessionId]),
      removeLastSummary: sessionId => calls.push(['remove-summary', sessionId]),
    },
    ui: {
      removeMessage: messageId => calls.push(['remove-ui', messageId]),
    },
    recordTraceEvent: event => calls.push(['trace', event.phase, event.status, event.details]),
    abortMemoryUpdate: async (sessionId, options) => {
      calls.push(['abort-memory', sessionId, options]);
    },
    removeTurnCheckpointsForMessages: async (sessionId, regenMessages, options) => {
      calls.push(['remove-checkpoints', sessionId, regenMessages.map(message => message.id), options]);
    },
    refreshChatAndContacts: () => calls.push(['refresh']),
    getMemoryStorageMode: () => 'table',
    restoreMemoryForActiveThread: async (sessionId, options) => calls.push(['restore-memory', sessionId, options]),
    restoreVariablesForActiveThread: async sessionId => calls.push(['restore-variables', sessionId]),
    getMessageSendText: message => `send:${message.raw}`,
    handleSend: async (targetMessageId, options) => {
      calls.push(['handle-send', targetMessageId, options]);
      return true;
    },
  });

  assert.equal(result.started, true);
  assert.equal(result.resent, true);
  assert.deepEqual(result.plan.regenMessages.map(message => message.id), ['a1', 'synthetic-1']);
  assert.deepEqual(calls, [
    ['trace', 'regenerate.start', 'started', { userIdx: 0, allowEmpty: false, regenMessageCount: 2 }],
    ['abort-memory', 'session-regen', { source: 'regenerate_from_user_index' }],
    ['delete', 'a1', 'session-regen'],
    ['remove-ui', 'a1'],
    ['delete', 'synthetic-1', 'session-regen'],
    ['remove-ui', 'synthetic-1'],
    ['remove-checkpoints', 'session-regen', ['a1', 'synthetic-1'], { prune: true }],
    ['refresh'],
    ['remove-summary', 'session-regen'],
    ['restore-memory', 'session-regen', {
      refreshBaselineWhenNoTail: false,
      source: 'regenerate_from_user_index',
    }],
    ['restore-variables', 'session-regen'],
    ['handle-send', null, {
      overrideText: 'send:原始用户消息',
      ignorePending: true,
      suppressUserMessage: true,
      skipInputRegex: true,
      existingUserMessageId: 'u1',
      includeAttachments: false,
      resendAttachmentParts: [],
    }],
    ['trace', 'regenerate.finish', 'success', {
      userIdx: 0,
      allowEmpty: false,
      regenMessageCount: 2,
      resent: true,
    }],
  ]);
});

test('runRegenerateFromUserIndexFlow restores variables even when memory mode is not table (变量模式无关)', async () => {
  const calls = [];
  const result = await runRegenerateFromUserIndexFlow({
    messages: [
      { id: 'u1', role: 'user', raw: 'hi' },
      { id: 'a1', role: 'assistant' },
    ],
    userIdx: 0,
    sessionId: 'session-novar',
    chatStore: {
      deleteMessage: () => {},
      removeLastSummary: () => {},
    },
    ui: { removeMessage: () => {} },
    removeTurnCheckpointsForMessages: async () => {},
    refreshChatAndContacts: () => {},
    getMemoryStorageMode: () => 'legacy',
    restoreMemoryForActiveThread: async () => calls.push('restore-memory'),
    restoreVariablesForActiveThread: async sessionId => calls.push(`restore-variables:${sessionId}`),
    getMessageSendText: () => 'send',
    handleSend: async () => true,
  });

  assert.equal(result.started, true);
  // 记忆非 table 模式：记忆回滚被跳过，但变量回滚仍执行（严格楼层绑定、模式无关）。
  assert.ok(!calls.includes('restore-memory'));
  assert.ok(calls.includes('restore-variables:session-novar'));
});

test('runRegenerateFromUserIndexFlow warns on invalid plans and traces empty resend skips', async () => {
  const invalidCalls = [];
  const invalid = await runRegenerateFromUserIndexFlow({
    messages: [{ id: 'u1', role: 'user', status: 'sending' }],
    userIdx: 0,
    warn: message => invalidCalls.push(['warn', message]),
    recordTraceEvent: () => invalidCalls.push(['trace']),
  });

  assert.equal(invalid.started, false);
  assert.equal(invalid.reason, 'user-message-sending');
  assert.deepEqual(invalidCalls, [['warn', '发送中的消息无法重生成']]);

  const emptyCalls = [];
  const empty = await runRegenerateFromUserIndexFlow({
    messages: [{ id: 'u1', role: 'user', content: '   ' }],
    userIdx: 0,
    allowEmpty: true,
    sessionId: 'session-empty',
    getMessageSendText: () => '   ',
    warn: message => emptyCalls.push(['warn', message]),
    recordTraceEvent: event => emptyCalls.push(['trace', event.phase, event.status, event.details]),
  });

  assert.equal(empty.started, true);
  assert.equal(empty.resent, false);
  assert.equal(empty.reason, 'empty-user-message');
  assert.deepEqual(emptyCalls, [
    ['trace', 'regenerate.start', 'started', { userIdx: 0, allowEmpty: true, regenMessageCount: 0 }],
    ['trace', 'regenerate.finish', 'skipped', {
      userIdx: 0,
      allowEmpty: true,
      reason: 'empty-user-message',
    }],
    ['warn', '未找到对应的用户消息内容'],
  ]);
});

test('runSendCatchFlow clears active stream queue typing and shows toast error ui', () => {
  const calls = [];
  const error = Object.assign(new Error('Boom'), {
    status: 500,
    response: { code: 'bad' },
  });

  const result = runSendCatchFlow({
    error,
    generationId: 17,
    streamCtrl: {
      cancel: () => calls.push(['stream-cancel']),
    },
    isGenerationInterrupted: generationId => {
      calls.push(['interrupted', generationId]);
      return false;
    },
    sessionId: 'session-error',
    isSessionActive: sessionId => {
      calls.push(['active', sessionId]);
      return true;
    },
    hideTyping: () => calls.push(['hide-typing']),
    fastForwardDelivery: sessionId => calls.push(['fast-forward', sessionId]),
    logger: {
      error: (message, err, meta) => calls.push(['logger', message, err.message, meta]),
    },
    showToastError: (message, title) => calls.push(['toast', message, title]),
  });

  assert.deepEqual(result, {
    sendErrorMessage: 'Boom',
    suppressErrorUI: false,
    generationInterrupted: false,
    cancelled: false,
  });
  assert.deepEqual(calls, [
    ['interrupted', 17],
    ['stream-cancel'],
    ['active', 'session-error'],
    ['hide-typing'],
    ['fast-forward', 'session-error'],
    ['logger', '发送失败', 'Boom', { status: 500, response: { code: 'bad' } }],
    ['toast', 'Boom', '错误'],
  ]);
});

test('runSendCatchFlow suppresses cancelled or interrupted errors without touching stream ui', () => {
  const calls = [];
  const result = runSendCatchFlow({
    error: { cancelled: true, message: '用户取消' },
    generationId: 18,
    streamCtrl: {
      cancel: () => calls.push(['stream-cancel']),
    },
    isGenerationInterrupted: generationId => {
      calls.push(['interrupted', generationId]);
      return true;
    },
    sessionId: 'session-cancel',
    isSessionActive: () => {
      calls.push(['active']);
      return true;
    },
    hideTyping: () => calls.push(['hide-typing']),
    fastForwardDelivery: () => calls.push(['fast-forward']),
    logger: {
      error: () => calls.push(['logger']),
    },
    showToastError: () => calls.push(['toast']),
  });

  assert.deepEqual(result, {
    sendErrorMessage: '用户取消',
    suppressErrorUI: true,
    generationInterrupted: true,
    cancelled: true,
  });
  assert.deepEqual(calls, [
    ['interrupted', 18],
  ]);
});

test('runSendFinallyFlow preserves successful send cleanup order', () => {
  const calls = [];
  let activeGeneration = { id: 12 };
  const pending = [{ id: 'p1' }, { id: 'p2' }];

  const result = runSendFinallyFlow({
    sendSucceeded: true,
    pendingMessagesToConfirm: pending,
    sessionId: 'session-finally',
    isGroupChat: true,
    checkpointTargetMessageId: 'assistant-12',
    generationId: 12,
    sendTraceStarted: true,
    finalizePendingMessages: (sessionId, messages) => calls.push(['finalize-pending', sessionId, messages.map(m => m.id)]),
    movePendingFromHistoryToQueue: sessionId => calls.push(['move-pending', sessionId]),
    refreshChatAndContacts: () => calls.push(['refresh']),
    scriptRuntime: {
      consumeOnce: sessionId => calls.push(['consume-once', sessionId]),
    },
    buildMemoryContext: () => {
      calls.push(['build-memory-context']);
      return { messages: [] };
    },
    runMemoryUpdateAfterChat: (sessionId, isGroupChat, context, options) => {
      calls.push(['memory-update', sessionId, isGroupChat, context, options]);
      return Promise.resolve();
    },
    updatePendingFloat: sessionId => calls.push(['update-pending-float', sessionId]),
    getActiveGeneration: () => activeGeneration,
    setActiveGeneration: next => {
      calls.push(['set-active', next]);
      activeGeneration = next;
    },
    setSendingState: value => calls.push(['sending', value]),
    recordTraceEvent: event => calls.push(['trace', event.phase, event.status, event.details]),
  });

  assert.equal(result, true);
  assert.equal(activeGeneration, null);
  assert.deepEqual(calls, [
    ['finalize-pending', 'session-finally', ['p1', 'p2']],
    ['move-pending', 'session-finally'],
    ['refresh'],
    ['consume-once', 'session-finally'],
    ['build-memory-context'],
    ['memory-update', 'session-finally', true, { messages: [] }, { checkpointMessageId: 'assistant-12' }],
    ['update-pending-float', 'session-finally'],
    ['sending', false],
    ['set-active', null],
    ['trace', 'send.finish', 'success', {
      generationId: 12,
      sendSucceeded: true,
      cancelled: undefined,
      errorMessage: undefined,
    }],
  ]);
});

test('runSendFinallyFlow releases the send lock at commit while background reveal is still pending', async () => {
  let activeGeneration = { id: 42 };
  let isSending = true;
  let revealSettled = false;
  let finishReveal = null;
  const backgroundReveal = new Promise(resolve => {
    finishReveal = () => {
      revealSettled = true;
      resolve();
    };
  });

  const result = runSendFinallyFlow({
    sendSucceeded: true,
    sessionId: 'session-background-reveal',
    generationId: 42,
    getActiveGeneration: () => activeGeneration,
    setActiveGeneration: next => { activeGeneration = next; },
    setSendingState: next => { isSending = next; },
  });

  assert.equal(result, true);
  assert.equal(activeGeneration, null, '提交完成即释放 generation 所有权');
  assert.equal(isSending, false, '发送锁不得等待揭示动画');
  assert.equal(revealSettled, false, '后台揭示仍可独立继续');

  finishReveal();
  await backgroundReveal;
});

test('runSendFinallyFlow skips success-only cleanup and preserves other active generation', () => {
  const calls = [];
  const activeGeneration = { id: 99 };

  const result = runSendFinallyFlow({
    sendSucceeded: false,
    pendingMessagesToConfirm: [{ id: 'p1' }],
    sessionId: 'session-cancelled',
    generationId: 12,
    sendTraceStarted: true,
    suppressErrorUI: true,
    sendErrorMessage: 'ignored cancel text',
    finalizePendingMessages: () => calls.push(['finalize-pending']),
    movePendingFromHistoryToQueue: () => calls.push(['move-pending']),
    refreshChatAndContacts: () => calls.push(['refresh']),
    runMemoryUpdateAfterChat: () => calls.push(['memory-update']),
    updatePendingFloat: sessionId => calls.push(['update-pending-float', sessionId]),
    getActiveGeneration: () => activeGeneration,
    setActiveGeneration: () => calls.push(['set-active']),
    setSendingState: () => calls.push(['sending']),
    recordTraceEvent: event => calls.push(['trace', event.phase, event.status, event.details]),
  });

  assert.equal(result, false);
  assert.deepEqual(calls, [
    ['update-pending-float', 'session-cancelled'],
    ['trace', 'send.finish', 'cancelled', {
      generationId: 12,
      sendSucceeded: false,
      cancelled: true,
      errorMessage: 'ignored cancel text',
    }],
  ]);
});

test('runSendFinallyFlow finalizes pending messages after visible send failure', () => {
  const calls = [];

  const result = runSendFinallyFlow({
    sendSucceeded: false,
    pendingMessagesToConfirm: [{ id: 'p1' }],
    sessionId: 'session-error',
    generationId: 12,
    sendTraceStarted: true,
    suppressErrorUI: false,
    sendErrorMessage: 'network failed',
    finalizePendingMessages: (sessionId, messages) => calls.push(['finalize-pending', sessionId, messages.map(m => m.id)]),
    updatePendingFloat: sessionId => calls.push(['update-pending-float', sessionId]),
    getActiveGeneration: () => ({ id: 12 }),
    setActiveGeneration: next => calls.push(['set-active', next]),
    setSendingState: value => calls.push(['sending', value]),
    recordTraceEvent: event => calls.push(['trace', event.phase, event.status, event.details]),
  });

  assert.equal(result, false);
  assert.deepEqual(calls, [
    ['finalize-pending', 'session-error', ['p1']],
    ['update-pending-float', 'session-error'],
    ['sending', false],
    ['set-active', null],
    ['trace', 'send.finish', 'error', {
      generationId: 12,
      sendSucceeded: false,
      cancelled: undefined,
      errorMessage: 'network failed',
    }],
  ]);
});

test('resolveSyspromptProtocolFlags enables private or group protocol only when matching rules exist', () => {
  assert.deepEqual(
    resolveSyspromptProtocolFlags({
      sysp: {
        dialogue_enabled: true,
        dialogue_rules: '私聊规则',
        group_enabled: true,
        group_rules: '',
        moment_create_enabled: false,
        moment_create_rules: '不会启用',
      },
      rpUiMode: false,
      isGroupChat: false,
      summaryEnabled: true,
    }),
    {
      dialogueEnabled: true,
      groupEnabled: false,
      momentCreateEnabled: false,
      protocolEnabled: true,
      disableSummaryForThis: false,
    },
  );
});

test('resolveSyspromptProtocolFlags lets moment creation override chat mode and disables in rp mode', () => {
  assert.deepEqual(
    resolveSyspromptProtocolFlags({
      sysp: {
        dialogue_enabled: false,
        dialogue_rules: '私聊规则',
        group_enabled: false,
        group_rules: '群聊规则',
        moment_create_enabled: true,
        moment_create_rules: '动态规则',
      },
      rpUiMode: true,
      isGroupChat: true,
      summaryEnabled: false,
    }),
    {
      dialogueEnabled: false,
      groupEnabled: false,
      momentCreateEnabled: true,
      protocolEnabled: false,
      disableSummaryForThis: true,
    },
  );
});

test('resolveSyspromptProtocolFlags parses the reply as protocol whenever the chat format guide was injected', () => {
  // 全新安装：内置系统提示词只适用创意写作，聊天模式解析不到预设（sysp 为空），
  // 但组提示词时仍会注入内置的 QQ聊天格式，模型照格式回复；不按协议解析就会整段原样显示。
  const flags = resolveSyspromptProtocolFlags({ sysp: {}, rpUiMode: false, isGroupChat: false, summaryEnabled: true, phoneChatFormatActive: true });
  assert.equal(flags.protocolEnabled, true);
  assert.equal(resolveSyspromptProtocolFlags({ sysp: {}, rpUiMode: false, isGroupChat: true, phoneChatFormatActive: true }).protocolEnabled, true, 'group chats use the same chat format guide');
  assert.equal(resolveSyspromptProtocolFlags({ sysp: {}, rpUiMode: true, phoneChatFormatActive: true }).protocolEnabled, false, 'creative writing never parses the phone protocol');
  assert.equal(resolveSyspromptProtocolFlags({ sysp: {}, rpUiMode: false }).protocolEnabled, false, 'without the format guide nothing changes');
});

test('isPhoneChatFormatInjected mirrors when buildMessages adds the built-in chat format guide', () => {
  assert.equal(isPhoneChatFormatInjected({ sysp: null }), true, 'no preset resolved: the built-in guide is used');
  assert.equal(isPhoneChatFormatInjected({ sysp: {} }), true);
  assert.equal(isPhoneChatFormatInjected({ sysp: { phone_format_chat_enabled: true, phone_format_chat_rules: '' } }), true, 'empty rules fall back to the built-in seed');
  assert.equal(isPhoneChatFormatInjected({ sysp: { phone_format_chat_enabled: false } }), false, 'turned off in the preset');
  assert.equal(isPhoneChatFormatInjected({ sysp: {}, replyTarget: 'user' }), false, 'replying as the user drops the phone format');
  assert.equal(isPhoneChatFormatInjected({ sysp: {}, disablePhoneFormat: true }), false);
});

test('chat send asks the bridge whether the chat format guide is injected before choosing the protocol path', async () => {
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const bridgeSource = await readFile(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
  const calls = appSource.match(/resolveSyspromptProtocolFlags\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(calls.length >= 2);
  calls.forEach(call => assert.match(call, /phoneChatFormatActive:\s*window\.appBridge\.isPhoneChatFormatActive\?\.\(requestPresetContext\)\s*===\s*true/));
  assert.match(bridgeSource, /isPhoneChatFormatActive\(context = \{\}\) \{[\s\S]*?getResolvedActive\('sysprompt', presetContext\)[\s\S]*?isPhoneChatFormatInjected\(/);
});

test('isChatSendTargetAvailable rejects a deleted target and accepts stored or contact-only sessions', () => {
  const sessions = new Set(['stored-room']);
  const contacts = new Map([['contact-room', { id: 'contact-room' }]]);
  const deps = {
    chatStore: {
      hasSession: id => sessions.has(id),
    },
    contactsStore: {
      getContact: id => contacts.get(id) || null,
    },
  };
  assert.equal(isChatSendTargetAvailable({ sessionId: 'stored-room', ...deps }), true);
  assert.equal(isChatSendTargetAvailable({ sessionId: 'contact-room', ...deps }), true);
  assert.equal(isChatSendTargetAvailable({ sessionId: 'deleted-room', ...deps }), false);
  assert.equal(isChatSendTargetAvailable({ sessionId: 'legacy-room' }), true, '无法检查的旧测试替身保持兼容');
});

test('handleSend timeout wiring keeps pre-creation abort, timeout labeling, and repair-wait race contracts', async () => {
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  // 预中止必须在任何 generation record 建立之前拦截（迟到的超时不得再启动生成）。
  const firstRecordCreation = appSource.indexOf('activeGeneration = createActiveGenerationRecord({');
  assert.ok(firstRecordCreation > 0);
  assert.ok(
    appSource.lastIndexOf('throwIfSendAborted();') < firstRecordCreation,
    'throwIfSendAborted 检查必须全部位于 generation record 创建之前',
  );
  // 工具超时导致的中止必须改写为 generation_failed，不得伪装成 user_aborted。
  assert.match(appSource, /toolTimeoutAborted && result\?\.cancelled === true/);
  assert.match(
    appSource.slice(
      appSource.indexOf('toolTimeoutAborted && result?.cancelled === true'),
      appSource.indexOf('toolTimeoutAborted && result?.cancelled === true') + 600,
    ),
    /failureCode:\s*'generation_failed'/,
  );
  // 被拒路径的修复等待必须与中止信号竞速，超时后在宽限内以 protocol_rejected 收口。
  assert.match(appSource, /Promise\.race\(\[maidProtocolRepairCompletion, abortWait\]\)/);
});

test('handleSend and image generation register target-scoped work before session deletion', async () => {
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /beforeRemove:\s*sessionId\s*=>\s*sessionAsyncWorkRuntime\.cancelAndWait\(sessionId/);
  assert.match(appSource, /holdClosing:\s*true/);
  assert.match(appSource, /kind:\s*'chat_generation'/);
  assert.match(appSource, /kind:\s*'image_generation'/);
  assert.match(appSource, /sessionAsyncWorkRuntime\.isClosing\(sessionId\)/);
  assert.match(appSource, /isChatSendTargetAvailable\(\{\s*sessionId,\s*chatStore,\s*contactsStore\s*\}\)/);
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

if (failed > 0) {
  process.exit(1);
}
