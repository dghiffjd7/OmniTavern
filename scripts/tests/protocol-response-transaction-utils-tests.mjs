import assert from 'node:assert/strict';

import {
  collectProtocolResponseStream,
  runProtocolResponseTransaction,
} from '../../src/scripts/ui/chat/protocol-response-transaction-utils.js';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';
import { buildProtocolRetryCandidates } from '../../src/scripts/ui/chat/protocol-parse-utils.js';
import { buildProtocolPrivateChatBatch } from '../../src/scripts/ui/chat/protocol-batch-utils.js';
import { applyChatModeAssistantRegex } from '../../src/scripts/ui/chat/assistant-message-builder-utils.js';

{
  const phoneReply = content => [
    'MiPhone_start', 'msg_start', '<我和小雨的私聊>',
    `小雨--${content}--13:40`, '</我和小雨的私聊>', 'msg_end', 'MiPhone_end',
  ].join('\n');
  const actual = phoneReply('实际回复');
  const example = phoneReply('思考中的格式示例');
  const cases = [
    ['standard thinking', `<thinking>${example}</thinking>\n${actual}`, 'raw'],
    ['think alias', `<think>${example}</think>\n${actual}`, 'raw'],
    ['prefilled thinking', `${example}\n</thinking>\n${actual}`, 'raw'],
    ['empty shell', `MiPhone_start\nMiPhone_end\n${actual}`, 'raw'],
    ['normalized fallback after an empty shell', `<content>说明\nMiPhone_start\nMiPhone_end\n${actual}`, 'mi_phone'],
  ];
  for (const [label, rawText, expectedSource] of cases) {
    const captured = [];
    const regexInputs = [];
    const seenRaw = [];
    const result = await runProtocolResponseTransaction({
      rawText,
      buildRetryCandidates: original => {
        seenRaw.push(original);
        return buildProtocolRetryCandidates(original);
      },
      createParser: () => new DialogueStreamParser(),
      preflightEvent: event => ({ ok: event.type === 'private_chat' && event.otherName === '小雨' && event.messages.length > 0 }),
      processEvent: async event => {
        const batch = await buildProtocolPrivateChatBatch(event, {
          resolveTargetSessionId: () => 'fixture-only',
          buildAssistantMessageFromText: text => {
            const parts = applyChatModeAssistantRegex(text, {
              applyStoredRegex: source => {
                regexInputs.push(source);
                return source.replace('实际回复', '正则处理后的回复');
              },
            });
            captured.push(parts.stored);
            return { role: 'assistant', content: parts.display };
          },
        });
        return { consumed: batch.items.length > 0, didAnything: batch.items.length > 0 };
      },
    });
    assert.equal(result.handled, true, label);
    assert.equal(result.candidateSource, expectedSource, label);
    assert.deepEqual(captured, ['正则处理后的回复'], label);
    assert.deepEqual(regexInputs, ['实际回复'], label);
    assert.deepEqual(seenRaw, [rawText], label);
  }
  console.log('ok - protocol capture skips empty shells and thinking examples before running bubble regex once');

  for (const rawText of [
    `<think>${example}`,
    `MiPhone_start\nMiPhone_end\n${actual.replace(/MiPhone_end$/, '')}<我和小雨的私聊>未完成`,
  ]) {
    const calls = [];
    const result = await runProtocolResponseTransaction({
      rawText,
      buildRetryCandidates: buildProtocolRetryCandidates,
      createParser: () => new DialogueStreamParser(),
      beginTransaction: () => calls.push('begin'),
      processEvent: () => calls.push('process'),
    });
    assert.equal(result.handled, false);
    assert.deepEqual(calls, []);
  }
  console.log('ok - thinking-only and incomplete replies cannot dispatch through retry extraction');
}

{
  async function* stream() {
    yield { content: 'A' };
    yield { reasoning: 'hidden' };
    yield { content: 'B' };
  }
  const result = await collectProtocolResponseStream({
    stream: stream(),
    normalizeChunk: chunk => chunk,
  });
  assert.deepEqual(result, { fullRaw: 'AB', interrupted: false });
  console.log('ok - protocol stream collection buffers raw text without executing events');
}

{
  const calls = [];
  const result = await runProtocolResponseTransaction({
    rawText: 'bad',
    createParser: () => ({
      push: () => [{ type: 'private_chat' }],
      flush: () => [],
    }),
    preflightEvent: () => ({ ok: false, reason: 'missing_target' }),
    beginTransaction: () => calls.push('begin'),
    processEvent: () => calls.push('process'),
    commitTransaction: () => calls.push('commit'),
    onCommitted: () => calls.push('effects'),
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'protocol_preflight_failed');
  assert.deepEqual(calls, []);
  console.log('ok - protocol transaction rejects the full response before writes when preflight fails');
}

{
  const seen = [];
  const result = await runProtocolResponseTransaction({
    rawText: 'moment-then-reply',
    createParser: () => ({
      push: () => [
        { type: 'moments', moments: [{ id: 'moment-new' }] },
        { type: 'moment_reply', momentId: 'moment-new', comments: [{ content: '同轮回复' }] },
      ],
      flush: () => [],
    }),
    preflightEvent: (event, context) => {
      seen.push([event.type, context.index, context.priorEvents.map(item => item.type)]);
      if (event.type !== 'moment_reply') return { ok: true };
      return {
        ok: context.priorEvents.some(candidate => (
          candidate.type === 'moments'
          && candidate.moments.some(moment => moment.id === event.momentId)
        )),
      };
    },
    beginTransaction: () => true,
    processEvent: () => ({ consumed: true, didAnything: true, mutatedMoments: true }),
    commitTransaction: () => ({ ok: true }),
  });
  assert.equal(result.handled, true);
  assert.deepEqual(seen, [
    ['moments', 0, []],
    ['moment_reply', 1, ['moments']],
  ]);
  console.log('ok - protocol preflight can validate dependencies created earlier in the same response');
}

{
  const calls = [];
  const result = await runProtocolResponseTransaction({
    rawText: [
      'MiPhone_start',
      '<我和雪之下雪乃的私聊>',
      '雪之下雪乃--先把这一段写完。--12:30',
      '</我和雪之下雪乃的私聊>',
      '<我和雪之下雪乃的私聊>',
      '雪之下雪乃--但第二段没有闭合。--12:31',
    ].join('\n'),
    createParser: () => new DialogueStreamParser({ userName: '我' }),
    preflightEvent: () => ({ ok: true }),
    beginTransaction: () => {
      calls.push('begin');
      return true;
    },
    processEvent: () => calls.push('process'),
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'protocol_parse_incomplete');
  assert.deepEqual(calls, []);
  console.log('ok - protocol transaction rejects a complete event followed by an unfinished protocol tail');
}

{
  const calls = [];
  const captured = [{ messageId: 'm1', targetSessionId: 's1' }];
  const result = await runProtocolResponseTransaction({
    rawText: 'two-events',
    createParser: () => ({
      push: () => [{ id: 'a' }, { id: 'b' }],
      flush: () => [],
    }),
    preflightEvent: () => ({ ok: true }),
    beginTransaction: () => {
      calls.push('begin');
      return true;
    },
    beforeDispatch: () => calls.push('before'),
    processEvent: event => {
      calls.push(`process:${event.id}`);
      return event.id === 'a'
        ? { consumed: true, didAnything: true, targetSessionId: 's1' }
        : { consumed: false, didAnything: false };
    },
    afterDispatch: () => calls.push('after'),
    endTransaction: () => captured,
    rollbackCaptured: items => calls.push(`remove:${items[0].messageId}`),
    rollbackTransaction: () => calls.push('rollback'),
    commitTransaction: () => calls.push('commit'),
    onCommitted: () => calls.push('effects'),
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'protocol_dispatch_incomplete');
  assert.deepEqual(calls, [
    'begin',
    'before',
    'process:a',
    'process:b',
    'after',
    'remove:m1',
    'rollback',
  ]);
  console.log('ok - protocol transaction rolls back partial messages and defers effects on dispatch failure');
}

{
  const calls = [];
  const result = await runProtocolResponseTransaction({
    rawText: 'rollback-errors',
    createParser: () => ({
      push: () => [{ id: 'a' }],
      flush: () => [],
    }),
    preflightEvent: () => ({ ok: true }),
    beginTransaction: () => true,
    processEvent: () => ({ consumed: false, didAnything: false }),
    endTransaction: () => [{ messageId: 'm1', targetSessionId: 's1' }],
    rollbackCaptured: () => {
      calls.push('messages');
      throw new Error('message rollback failed');
    },
    rollbackTransaction: () => {
      calls.push('moments');
      throw new Error('moment rollback failed');
    },
  });
  assert.equal(result.handled, false);
  assert.deepEqual(calls, ['messages', 'moments']);
  assert.deepEqual(
    result.rollbackErrors.map(item => item.step),
    ['captured_messages', 'transaction'],
  );
  console.log('ok - protocol rollback attempts every independent restoration step');
}

{
  const calls = [];
  const captured = [
    { messageId: 'm1', targetSessionId: 's1' },
    { messageId: 'm2', targetSessionId: 's2' },
  ];
  const result = await runProtocolResponseTransaction({
    rawText: 'valid',
    createParser: () => ({
      push: () => [{ id: 'a' }, { id: 'b' }],
      flush: () => [],
    }),
    preflightEvent: () => ({ ok: true }),
    beginTransaction: () => true,
    beforeDispatch: () => calls.push('before'),
    processEvent: event => ({
      consumed: true,
      didAnything: true,
      targetSessionId: event.id === 'a' ? 's1' : 's2',
    }),
    afterDispatch: () => calls.push('after'),
    endTransaction: () => captured,
    commitTransaction: () => {
      calls.push('commit');
      return { ok: true };
    },
    onCommitted: details => {
      calls.push(`effects:${details.capturedMessages.length}`);
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.didAnything, true);
  assert.deepEqual(result.targetSessionIds, ['s1', 's2']);
  assert.deepEqual(calls, ['before', 'after', 'commit', 'effects:2']);
  console.log('ok - protocol transaction runs deferred effects only after every event commits');
}

{
  const parsed = [];
  const result = await runProtocolResponseTransaction({
    rawText: 'raw',
    buildRetryCandidates: () => ({ retryText: 'normalized' }),
    createParser: () => ({
      push: (text) => {
        parsed.push(text);
        return text === 'normalized' ? [{ id: 'ok' }] : [];
      },
      flush: () => [],
    }),
    preflightEvent: () => ({ ok: true }),
    beginTransaction: () => true,
    processEvent: () => ({ consumed: true, didAnything: true }),
    endTransaction: () => [],
    commitTransaction: () => ({ ok: true }),
  });
  assert.equal(result.handled, true);
  assert.equal(result.candidateSource, 'retry');
  assert.deepEqual(parsed, ['raw', 'normalized']);
  console.log('ok - protocol transaction may normalize before opening a transaction');
}
