import assert from 'node:assert/strict';

import {
  buildProtocolSystemMetaMessage,
  buildProtocolRetryCandidates,
  extractMiPhoneBlock,
  normalizeMiPhoneMarkers,
  normalizeProtocolChatMessage,
  sanitizeThinkingForProtocolParse,
} from '../../src/scripts/ui/chat/protocol-parse-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('sanitizeThinkingForProtocolParse withholds unfinished thinking from protocol retries', () => {
  assert.equal(
    sanitizeThinkingForProtocolParse('<thinking>abc'),
    '',
  );
  const retry = buildProtocolRetryCandidates('<think>MiPhone_start\n格式示例\nMiPhone_end');
  assert.equal(retry.retryText, '');
  assert.equal(retry.miPhoneBlock, '');
});

test('sanitizeThinkingForProtocolParse accepts orphan closing markers from preset prefills', () => {
  assert.equal(
    sanitizeThinkingForProtocolParse('head</thinking>tail'),
    'tail',
  );
  assert.equal(
    sanitizeThinkingForProtocolParse('a</thinking>b</think>tail'),
    'tail',
  );
});

test('sanitizeThinkingForProtocolParse removes only standard blocks and preserves surrounding text', () => {
  assert.equal(sanitizeThinkingForProtocolParse('head<THINKING mode="x">分析</THINKING>tail'), 'headtail');
  for (const literal of [
    '<thinking_notes>自定义内容</thinking_notes>',
    '<think-example>示例</think-example>',
    '&lt;thinking&gt;转义标签&lt;/thinking&gt;',
    '<我和小雨的私聊>小雨--引用 <thinking>原文</thinking> 和 </think>--13:40</我和小雨的私聊>',
  ]) {
    assert.equal(sanitizeThinkingForProtocolParse(literal), literal);
  }
});

test('normalizeMiPhoneMarkers normalizes html-escaped and angle-bracket markers', () => {
  assert.equal(
    normalizeMiPhoneMarkers('&lt;MiPhone_start&gt;body&lt;/MiPhone_end&gt;'),
    'MiPhone_startbodyMiPhone_end',
  );
  assert.equal(
    normalizeMiPhoneMarkers('<MiPhone_start>body</MiPhone_end>'),
    'MiPhone_startbodyMiPhone_end',
  );
});

test('extractMiPhoneBlock returns the first bounded block and tolerates missing end markers', () => {
  assert.equal(
    extractMiPhoneBlock('xx MiPhone_start body MiPhone_end yy'),
    'MiPhone_start body MiPhone_end',
  );
  assert.equal(
    extractMiPhoneBlock('prefix <MiPhone_start>body'),
    '<MiPhone_start>body',
  );
  assert.equal(
    extractMiPhoneBlock('no markers'),
    '',
  );
});

test('extractMiPhoneBlock retains later shells so an empty first shell cannot hide the reply', () => {
  const shells = 'MiPhone_start\nMiPhone_end\nMiPhone_start\n可提取的后续块\nMiPhone_end';
  assert.equal(extractMiPhoneBlock('prefix\n' + shells + '\n<tableEdit>tail</tableEdit>'), shells);
});

test('buildProtocolRetryCandidates composes thinking cleanup and MiPhone block extraction', () => {
  assert.deepEqual(
    buildProtocolRetryCandidates('head</thinking>&lt;MiPhone_start&gt;body&lt;/MiPhone_end&gt;'),
    {
      retryText: '&lt;MiPhone_start&gt;body&lt;/MiPhone_end&gt;',
      miPhoneText: 'MiPhone_startbodyMiPhone_end',
      miPhoneBlock: 'MiPhone_startbodyMiPhone_end',
    },
  );
});

test('normalizeProtocolChatMessage normalizes speaker and converts br tags to newlines', () => {
  assert.deepEqual(
    normalizeProtocolChatMessage(
      { speaker: ' Alice ', content: 'a<br>b', time: ' 09:00 ' },
      { normalizeSpeaker: value => String(value || '').trim().toLowerCase() },
    ),
    {
      speaker: 'alice',
      rawContent: 'a\nb',
      content: 'a\nb',
      time: '09:00',
    },
  );
});

test('normalizeProtocolChatMessage strips image prompt from content but keeps rawContent', () => {
  assert.deepEqual(
    normalizeProtocolChatMessage({ speaker: 'bot', content: '正文<image_prompt>prompt</image_prompt>', time: '09:01' }),
    {
      speaker: 'bot',
      rawContent: '正文<image_prompt>prompt</image_prompt>',
      content: '正文',
      time: '09:01',
    },
  );
});

test('buildProtocolSystemMetaMessage sanitizes content and fills fallback time/name', () => {
  assert.deepEqual(
    buildProtocolSystemMetaMessage({
      content: 'a',
      fallbackTime: '09:00',
      sanitizeContent: value => `[${value}]`,
    }),
    {
      role: 'system',
      type: 'meta',
      content: '[a]',
      name: '系统',
      time: '09:00',
    },
  );
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
