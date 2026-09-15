import assert from 'node:assert/strict';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const collect = (parser, chunks) => {
  const events = [];
  for (const chunk of chunks) {
    events.push(...(parser.push(chunk) || []));
  }
  events.push(...(parser.flush() || []));
  return events;
};

const phoneReply = content => [
  'MiPhone_start', 'msg_start', '<我和小雨的私聊>',
  `小雨--${content}--13:40`, '</我和小雨的私聊>', 'msg_end', 'MiPhone_end',
].join('\n');

test('skips closed MiPhone shells without extractable content and continues to the real reply', () => {
  const parser = new DialogueStreamParser();
  const events = collect(parser, [
    'MiPhone_start\nMiPhone_end\n',
    'MiPhone_start\n仅说明格式，没有可提取消息。\n<我和小雨的私聊>\n </我和小雨的私聊>\nMiPhone_end\n' + phoneReply('实际回复'),
  ]);
  assert.deepEqual(events.map(event => event.messages[0].content), ['实际回复']);
  assert.equal(parser.ended, true);
});

test('a valid MiPhone shell remains final when its event and end marker arrive in different chunks', () => {
  const parser = new DialogueStreamParser();
  const first = parser.push(phoneReply('先前分块已提取').replace(/MiPhone_end$/, ''));
  assert.equal(first.length, 1);
  assert.equal(parser.ended, false);
  assert.deepEqual(parser.push('MiPhone_end\n' + phoneReply('不应重复提取')), []);
  assert.equal(parser.ended, true);
});

test('filters both standard thinking forms before a valid example can select a shell', () => {
  for (const tag of ['thinking', 'think']) {
    const parser = new DialogueStreamParser();
    const events = collect(parser, [
      `<${tag}>参考：<content>${phoneReply('思考示例')}</content></${tag}>\n${phoneReply('实际回复')}`,
    ]);
    assert.deepEqual(events.map(event => event.messages[0].content), ['实际回复'], tag);
  }
});

test('waits for a chunked thinking close instead of emitting the completed example inside it', () => {
  const parser = new DialogueStreamParser();
  assert.deepEqual(parser.push('<thi'), []);
  assert.deepEqual(parser.push('nk>\n<content>' + phoneReply('思考示例') + '</content>\n</thi'), []);
  assert.equal(parser.inContent, false);
  const events = collect(parser, ['nk>\n' + phoneReply('实际回复')]);
  assert.deepEqual(events.map(event => event.messages[0].content), ['实际回复']);
});

test('handles a prefilled thinking opener before accepting the raw candidate', () => {
  const events = collect(new DialogueStreamParser(), [
    '格式参考：\n' + phoneReply('思考示例') + '\n</thinking>\n' + phoneReply('实际回复'),
  ]);
  assert.deepEqual(events.map(event => event.messages[0].content), ['实际回复']);
});

test('thinking inside an open shell cannot close that shell or emit protocol examples', () => {
  const parser = new DialogueStreamParser();
  assert.deepEqual(parser.push('MiPhone_start\n<think>' + phoneReply('思考示例')), []);
  assert.equal(parser.ended, false);
  const events = collect(parser, [
    '</think>\n<我和小雨的私聊>小雨--实际回复--13:40</我和小雨的私聊>\nMiPhone_end',
  ]);
  assert.deepEqual(events.map(event => event.messages[0].content), ['实际回复']);
  assert.equal(parser.ended, true);
});

test('preserves thinking tag literals inside chat payloads, including split and loose contact tags', () => {
  const body = '原样保留 <thinking>引用内容</thinking> 和 </think>。';
  for (const tagName of ['我和小雨的私聊', '小雨']) {
    const parser = new DialogueStreamParser({ resolveLoosePrivateTag: tag => tag === '小雨' ? tag : '' });
    const events = collect(parser, [
      `MiPhone_start\n<${tagName}>小雨--原样保留 <thinking>`,
      `引用内容</thinking> 和 </think>。--13:40</${tagName}>\nMiPhone_end`,
    ]);
    assert.deepEqual(events.map(event => event.messages[0].content), [body]);
  }
});

test('continues after a leading content block and parses following MiPhone private chat', () => {
  const parser = new DialogueStreamParser({ userName: '阿伟' });
  const events = collect(parser, [
    [
      '<content>',
      '[旁白]|前置剧情不应阻断手机协议',
      '</content>',
      '<state_bar><time>11:36</time></state_bar>',
      'MiPhone_start',
      'msg_start',
      '<阿伟和娜美的私聊>',
      '娜美--哈？你谁啊？--11:36',
      '</阿伟和娜美的私聊>',
      'msg_end',
      'MiPhone_end',
    ].join('\n'),
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'private_chat');
  assert.equal(events[0].otherName, '娜美');
  assert.deepEqual(events[0].messages, [
    { speaker: '娜美', content: '哈？你谁啊？', time: '11:36' },
  ]);
});

test('waits for MiPhone markers that arrive after a closed content block in later chunks', () => {
  const parser = new DialogueStreamParser({ userName: '阿伟' });
  const first = parser.push('<content>\n[旁白]|前置剧情\n</content>\n<state_bar><time>11:36</time></state_bar>\n');
  assert.deepEqual(first, []);

  const events = collect(parser, [
    [
      'MiPhone_start',
      'msg_start',
      '<阿伟和娜美的私聊>',
      '娜美--突然发个Hi过来，想搭讪也得看看对象吧？--11:36',
      '</阿伟和娜美的私聊>',
      'msg_end',
      'MiPhone_end',
    ].join('\n'),
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'private_chat');
  assert.equal(events[0].messages[0]?.content, '突然发个Hi过来，想搭讪也得看看对象吧？');
});

test('accepts ASCII private_chat aliases without removing the Chinese form', () => {
  const parser = new DialogueStreamParser({ userName: 'Alan' });
  const events = collect(parser, [
    [
      '<private_chat:Alan|Lara Croft>',
      'Lara Croft--Ready when you are.--09:15',
      '</private_chat:Alan|Lara Croft>',
    ].join('\n'),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'private_chat');
  assert.equal(events[0].otherName, 'Lara Croft');
  assert.equal(events[0].messages[0]?.content, 'Ready when you are.');
});

test('accepts ASCII group_chat aliases', () => {
  const parser = new DialogueStreamParser({ userName: 'Alan' });
  const events = collect(parser, [
    [
      '<group_chat:Night Watch>',
      '<成员>Alan,Lara</成员>',
      '<聊天内容>Lara--All clear.--23:40</聊天内容>',
      '</group_chat:Night Watch>',
    ].join('\n'),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'group_chat');
  assert.equal(events[0].groupName, 'Night Watch');
  assert.equal(events[0].messages[0]?.speaker, 'Lara');
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
