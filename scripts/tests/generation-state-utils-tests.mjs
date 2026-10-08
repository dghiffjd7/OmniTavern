import assert from 'node:assert/strict';

import {
  GENERATION_STALE_GRACE_MS,
  buildCancelledAssistantPartial,
  buildCancelledAssistantPartialMessage,
  buildGenerationCancelTraceEvent,
  commitCancelledGenerationPartial,
  createActiveGenerationRecord,
  isGenerationRecordStale,
  runActiveGenerationCancelFlow,
} from '../../src/scripts/ui/chat/generation-state-utils.js';

const tests = [];

tests.push({
  name: 'isGenerationRecordStale reclaims only records silent longer than their request timeout',
  fn: () => {
    const now = Date.now();
    const record = createActiveGenerationRecord({ id: 1, sessionId: 's1' });
    assert.equal(typeof record.startedAt, 'number');
    assert.equal(isGenerationRecordStale(record), false);
    // 长时间正常生成：开始很久，但一直有输出 → 不回收
    const longRunning = { ...record, requestTimeoutMs: 6_000_000, startedAt: now - 3_600_000, lastActivityAt: now - 5_000 };
    assert.equal(isGenerationRecordStale(longRunning, now), false);
    // 没有输出，但仍在这次请求的超时之内（如思考中的非流式请求）→ 不回收
    const waiting = { ...record, requestTimeoutMs: 6_000_000, startedAt: now - 3_600_000 };
    assert.equal(isGenerationRecordStale(waiting, now), false);
    // 超过请求超时 + 缓冲仍无任何输出 → 残留记录，回收
    const stuck = { ...record, requestTimeoutMs: 120_000, startedAt: now - 600_000, lastActivityAt: now - 120_000 - GENERATION_STALE_GRACE_MS - 1 };
    assert.equal(isGenerationRecordStale(stuck, now), true);
    // 模型配置没填超时时按 provider 默认 60 秒判断
    assert.equal(isGenerationRecordStale({ ...record, startedAt: now - 60_000 - GENERATION_STALE_GRACE_MS - 1 }, now), true);
    // 无 startedAt 的旧记录不误判（宁可保持旧行为）
    assert.equal(isGenerationRecordStale({ id: 2 }), false);
    assert.equal(isGenerationRecordStale(null), false);
  },
});
const test = (name, fn) => tests.push({ name, fn });

test('buildGenerationCancelTraceEvent normalizes cancel trace metadata and details', () => {
  assert.deepEqual(buildGenerationCancelTraceEvent({
    sessionId: ' session-cancel ',
    generationId: 0,
    reason: ' user ',
    status: ' started ',
  }), {
    phase: 'generation.cancel',
    sessionId: 'session-cancel',
    status: 'started',
    summary: 'generation cancel requested',
    details: {
      generationId: 0,
      reason: 'user',
    },
  });
  assert.deepEqual(buildGenerationCancelTraceEvent({
    sessionId: ' session-cancel ',
    generationId: undefined,
    reason: '',
    status: ' success ',
    hasPartial: false,
  }), {
    phase: 'generation.cancel',
    sessionId: 'session-cancel',
    status: 'success',
    summary: 'generation cancel completed',
    details: {
      reason: '',
      hasPartial: false,
    },
  });
});

test('createActiveGenerationRecord keeps caller ownership fields and initializes runtime slots', () => {
  const partialCommitHandler = () => true;
  const swipeTarget = { msgId: 'assistant-1' };
  const result = createActiveGenerationRecord({
    id: 3,
    sessionId: 'session-a',
    userMsgId: 'user-1',
    partialCommitHandler,
    swipeTarget,
  });

  assert.equal(typeof result.startedAt, 'number');
  const { startedAt: _startedAt, ...rest } = result;
  assert.deepEqual(rest, {
    id: 3,
    sessionId: 'session-a',
    userMsgId: 'user-1',
    streamCtrl: null,
    streamText: '',
    streamPayload: null,
    streamMeta: null,
    reattachStream: null,
    partialCommitHandler,
    swipeTarget,
    cancelled: false,
    cancelReason: '',
    lastActivityAt: 0,
    requestTimeoutMs: 0,
  });
});

test('buildCancelledAssistantPartial returns null when there is no cached stream text', () => {
  assert.equal(
    buildCancelledAssistantPartial({
      generation: {
        streamText: '   ',
      },
      assistantAvatar: 'fallback.png',
      fallbackTime: '10:00',
    }),
    null,
  );
});

test('buildCancelledAssistantPartial uses cached meta first and falls back to runtime defaults', () => {
  const partial = buildCancelledAssistantPartial({
    generation: {
      streamText: '部分回复',
      streamCtrl: { id: 'stream-1' },
      streamMeta: {
        id: 'assistant-2',
        name: '小助手',
        avatar: 'assistant.png',
        time: '11:11',
      },
    },
    assistantAvatar: 'fallback.png',
    fallbackTime: '10:00',
  });

  assert.deepEqual(partial, {
    role: 'assistant',
    type: 'text',
    id: 'assistant-2',
    name: '小助手',
    avatar: 'assistant.png',
    time: '11:11',
    content: '部分回复',
    raw: '部分回复',
    rawOriginal: '部分回复',
    rawSource: '部分回复',
    meta: {
      partial: true,
      cancelled: true,
    },
  });
});

test('buildCancelledAssistantPartial preserves raw payload when rendered stream text is empty', () => {
  const partial = buildCancelledAssistantPartial({
    generation: {
      streamText: '',
      streamPayload: {
        content: '',
        raw: 'raw 部分',
        rawSource: 'source 部分',
        rawOriginal: 'original 部分',
        meta: { renderRich: true },
      },
      streamMeta: { id: 'assistant-raw' },
    },
  });

  assert.equal(partial.id, 'assistant-raw');
  assert.equal(partial.content, 'raw 部分');
  assert.equal(partial.raw, 'raw 部分');
  assert.equal(partial.rawSource, 'source 部分');
  assert.equal(partial.rawOriginal, 'original 部分');
  assert.equal(partial.meta.renderRich, true);
});

test('buildCancelledAssistantPartial preserves reasoning-only cached payloads', () => {
  const partial = buildCancelledAssistantPartial({
    generation: {
      streamText: '',
      streamPayload: {
        content: '',
        raw: '',
        meta: { reasoningDisplay: '只生成了思考', renderRich: true },
      },
      streamMeta: { id: 'assistant-reasoning', reasoningLabel: '思考' },
    },
  });

  assert.equal(partial.id, 'assistant-reasoning');
  assert.equal(partial.content, '');
  assert.equal(partial.raw, '');
  assert.equal(partial.meta.reasoningDisplay, '只生成了思考');
  assert.equal(partial.meta.reasoningLabel, '思考');
  assert.equal(partial.meta.cancelled, true);
});

test('buildCancelledAssistantPartial falls back to stream controller id and provided avatar/time', () => {
  const partial = buildCancelledAssistantPartial({
    generation: {
      streamText: '中断内容',
      streamCtrl: { id: 'stream-3' },
      streamMeta: {},
    },
    assistantAvatar: 'fallback.png',
    fallbackTime: '12:34',
  });

  assert.equal(partial.id, 'stream-3');
  assert.equal(partial.avatar, 'fallback.png');
  assert.equal(partial.time, '12:34');
  assert.equal(partial.content, '中断内容');
});

test('buildCancelledAssistantPartialMessage preserves cancel append payload shape', () => {
  const message = buildCancelledAssistantPartialMessage({
    partial: {
      id: ' assistant-1 ',
      name: '助手A',
      avatar: 'assistant.png',
      time: '13:00',
      content: '已生成部分',
      raw: 'raw 部分',
      rawOriginal: 'raw original 部分',
      meta: { partial: false, custom: true },
    },
    assistantAvatar: 'fallback.png',
    fallbackTime: '12:00',
  });

  assert.deepEqual(message, {
    role: 'assistant',
    type: 'text',
    id: 'assistant-1',
    name: '助手A',
    avatar: 'assistant.png',
    time: '13:00',
    content: '已生成部分',
    raw: 'raw 部分',
    rawOriginal: 'raw original 部分',
    rawSource: 'raw 部分',
    meta: {
      partial: true,
      custom: true,
      cancelled: true,
    },
  });
});

test('buildCancelledAssistantPartialMessage falls back to content raw avatar and time', () => {
  const message = buildCancelledAssistantPartialMessage({
    partial: {
      content: 'fallback content',
    },
    assistantAvatar: 'fallback.png',
    fallbackTime: '12:00',
  });

  assert.equal(message.id, undefined);
  assert.equal(message.raw, 'fallback content');
  assert.equal(message.rawOriginal, 'fallback content');
  assert.equal(message.rawSource, 'fallback content');
  assert.equal(message.avatar, 'fallback.png');
  assert.equal(message.time, '12:00');
  assert.equal(buildCancelledAssistantPartialMessage({ partial: { content: '   ' } }), null);
});

test('commitCancelledGenerationPartial appends unhandled user partials and refreshes contacts', () => {
  const appended = [];
  let refreshed = 0;
  const result = commitCancelledGenerationPartial({
    generation: { sessionId: 'session-a' },
    partial: { id: 'partial-1', content: '部分回复' },
    reason: 'user',
    chatStore: {
      findMessage: () => null,
      appendMessage: (message, sessionId) => appended.push({ message, sessionId }),
    },
    getAssistantAvatarForSession: sid => `${sid}.png`,
    formatNowTime: () => '12:00',
    refreshChatAndContacts: () => { refreshed += 1; },
  });

  assert.deepEqual(result, {
    attempted: true,
    sessionId: 'session-a',
    messageId: 'partial-1',
    hasContent: true,
    handledPartial: false,
    appended: true,
    skippedExisting: false,
  });
  assert.equal(refreshed, 1);
  assert.equal(appended[0].sessionId, 'session-a');
  assert.equal(appended[0].message.content, '部分回复');
  assert.equal(appended[0].message.avatar, 'session-a.png');
});

test('commitCancelledGenerationPartial accepts raw-only partials', () => {
  const appended = [];
  const result = commitCancelledGenerationPartial({
    generation: { sessionId: 'session-raw' },
    partial: { id: 'partial-raw', content: '', raw: 'raw-only partial' },
    reason: 'user',
    chatStore: {
      findMessage: () => null,
      appendMessage: (message, sessionId) => appended.push({ message, sessionId }),
    },
  });

  assert.equal(result.hasContent, true);
  assert.equal(result.appended, true);
  assert.equal(appended[0].message.content, 'raw-only partial');
});

test('commitCancelledGenerationPartial accepts reasoning-only partials', () => {
  const appended = [];
  const result = commitCancelledGenerationPartial({
    generation: { sessionId: 'session-reasoning' },
    partial: {
      id: 'partial-reasoning',
      content: '',
      meta: { reasoningDisplay: '只输出了思考', renderRich: true },
    },
    reason: 'user',
    chatStore: {
      findMessage: () => null,
      appendMessage: (message, sessionId) => appended.push({ message, sessionId }),
    },
  });

  assert.equal(result.hasContent, true);
  assert.equal(result.appended, true);
  assert.equal(appended[0].message.content, '');
  assert.equal(appended[0].message.meta.reasoningDisplay, '只输出了思考');
  assert.equal(appended[0].message.meta.cancelled, true);
});

test('commitCancelledGenerationPartial keeps existing handler precedence semantics', () => {
  const calls = [];
  const appended = [];
  const result = commitCancelledGenerationPartial({
    generation: {
      sessionId: 'session-a',
      partialCommitHandler: () => {
        calls.push('partial');
        return true;
      },
      swipeTarget: {
        onPartial() {
          calls.push('swipe');
          return false;
        },
      },
    },
    partial: { content: '会被 swipe false 覆盖为未处理' },
    reason: 'user',
    chatStore: {
      findMessage: () => false,
      appendMessage: (message) => appended.push(message),
    },
  });

  assert.deepEqual(calls, ['partial', 'swipe']);
  assert.equal(result.handledPartial, false);
  assert.equal(result.appended, true);
  assert.equal(appended.length, 1);
});

test('commitCancelledGenerationPartial skips existing messages and non-user cancellations', () => {
  const appended = [];
  const existing = commitCancelledGenerationPartial({
    generation: { sessionId: 'session-a' },
    partial: { id: 'partial-1', content: '已存在' },
    reason: 'user',
    chatStore: {
      findMessage: () => true,
      appendMessage: message => appended.push(message),
    },
  });
  const nonUser = commitCancelledGenerationPartial({
    generation: { sessionId: 'session-a' },
    partial: { content: '不会处理' },
    reason: 'navigation',
  });

  assert.equal(existing.skippedExisting, true);
  assert.equal(existing.appended, false);
  assert.deepEqual(appended, []);
  assert.deepEqual(nonUser, {
    attempted: false,
    sessionId: '',
    messageId: '',
    hasContent: false,
    handledPartial: false,
    appended: false,
    skippedExisting: false,
  });
});

test('runActiveGenerationCancelFlow preserves cancel side-effect order and commits user partials', () => {
  const calls = [];
  const generation = createActiveGenerationRecord({
    id: 9,
    sessionId: 'session-cancel',
    userMsgId: 'user-1',
  });
  generation.streamCtrl = {
    id: 'stream-9',
    cancel(options) {
      calls.push(['stream-cancel', options.keepPartial, generation.cancelled]);
      return {
        id: 'partial-9',
        content: '保留的部分回复',
        raw: '保留的部分回复',
        meta: { source: 'stream' },
      };
    },
  };
  const appended = [];

  const result = runActiveGenerationCancelFlow({
    generation,
    reason: 'user',
    recordTraceEvent: event => calls.push(['trace', event.phase, event.status, event.details]),
    abortMemoryUpdate: sessionId => calls.push(['abort-memory', sessionId]),
    cancelCurrentGeneration: reason => calls.push(['bridge-cancel', reason]),
    chatStore: {
      findMessage: () => false,
      appendMessage: (message, sessionId) => {
        calls.push(['append', message.id, sessionId]);
        appended.push({ message, sessionId });
      },
    },
    getAssistantAvatarForSession: sessionId => `${sessionId}.png`,
    formatNowTime: () => '16:00',
    refreshChatAndContacts: () => calls.push(['refresh']),
    hideTyping: () => calls.push(['hide-typing']),
    setStreamingState: value => calls.push(['streaming', value]),
    setSendingState: value => calls.push(['sending', value]),
  });

  assert.equal(result.cancelled, true);
  assert.equal(generation.cancelReason, 'user');
  assert.equal(result.hasPartial, true);
  assert.equal(result.commitResult.appended, true);
  assert.equal(generation.cancelled, true);
  assert.equal(appended[0].message.meta.partial, true);
  assert.equal(appended[0].message.meta.cancelled, true);
  assert.deepEqual(calls, [
    ['trace', 'generation.cancel', 'started', { generationId: 9, reason: 'user' }],
    ['abort-memory', 'session-cancel'],
    ['bridge-cancel', 'user'],
    ['stream-cancel', true, true],
    ['append', 'partial-9', 'session-cancel'],
    ['refresh'],
    ['trace', 'generation.cancel', 'success', { generationId: 9, reason: 'user', hasPartial: true }],
    ['hide-typing'],
    ['streaming', false],
    ['sending', false],
  ]);
});

test('runActiveGenerationCancelFlow skips partial commit for non-user reasons and no-ops cancelled records', () => {
  const calls = [];
  const generation = createActiveGenerationRecord({
    id: 10,
    sessionId: 'session-cancel',
  });
  generation.streamCtrl = {
    cancel(options) {
      calls.push(['stream-cancel', options.keepPartial]);
      return { id: 'partial-10', content: '不会落库' };
    },
  };

  const result = runActiveGenerationCancelFlow({
    generation,
    reason: 'retract',
    recordTraceEvent: event => calls.push(['trace', event.status, event.details.hasPartial]),
    chatStore: {
      appendMessage: () => calls.push(['append']),
    },
    refreshChatAndContacts: () => calls.push(['refresh']),
  });
  const second = runActiveGenerationCancelFlow({
    generation,
    recordTraceEvent: () => calls.push(['second-trace']),
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.hasPartial, true);
  assert.equal(result.commitResult, null);
  assert.equal(second.cancelled, false);
  assert.deepEqual(calls, [
    ['trace', 'started', undefined],
    ['stream-cancel', false],
    ['trace', 'success', true],
  ]);
});

test('runActiveGenerationCancelFlow cancels stream and delivery without touching committed reveal queues', () => {
  const calls = [];
  const generation = createActiveGenerationRecord({
    id: 11,
    sessionId: 'session-cancel',
  });

  const result = runActiveGenerationCancelFlow({
    generation,
    reason: 'user',
    cancelCurrentGeneration: reason => calls.push(['bridge-cancel', reason]),
    abortMemoryUpdate: sessionId => calls.push(['abort-memory', sessionId]),
    cancelDeliverySequence: () => calls.push(['cancel-delivery']),
    hideTyping: () => calls.push(['hide-typing']),
    setStreamingState: value => calls.push(['streaming', value]),
    setSendingState: value => calls.push(['sending', value]),
  });

  assert.equal(result.cancelled, true);
  // 已提交气泡的揭示队列由独立 session delivery runtime 管理，取消生成不得再触碰它。
  assert.deepEqual(calls, [
    ['abort-memory', 'session-cancel'],
    ['bridge-cancel', 'user'],
    ['cancel-delivery'],
    ['hide-typing'],
    ['streaming', false],
    ['sending', false],
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

if (failed > 0) {
  process.exit(1);
}
