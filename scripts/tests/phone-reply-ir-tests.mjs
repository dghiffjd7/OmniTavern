import assert from 'node:assert/strict';

import {
  PHONE_REPLY_IR_PRIVATE_TOOL_NAME,
  PHONE_REPLY_IR_VERSION,
  buildPrivateChatPhoneReplyIr,
  buildPrivateReplyProviderToolDefinition,
  serializePhoneReplyIr,
  validatePhoneReplyIr,
} from '../../src/scripts/ui/chat/phone-reply-ir.js';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';

const frozenTarget = Object.freeze({
  sessionId: 'session-mia',
  targetName: '米娅',
  speakerId: 'contact-mia',
  speakerName: '米娅',
});

const parse = (raw) => {
  const parser = new DialogueStreamParser({ userName: '我' });
  return [...parser.push(raw), ...parser.flush()];
};

{
  const tool = buildPrivateReplyProviderToolDefinition();
  assert.equal(PHONE_REPLY_IR_VERSION, 'phone.reply.ir.v1');
  assert.equal(PHONE_REPLY_IR_PRIVATE_TOOL_NAME, 'emit_private_reply');
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, PHONE_REPLY_IR_PRIVATE_TOOL_NAME);
  assert.deepEqual(tool.function.parameters.required, ['messages']);
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.equal(Object.hasOwn(tool.function.parameters.properties, 'targetName'), false);
  assert.equal(Object.hasOwn(tool.function.parameters.properties, 'sessionId'), false);
  assert.equal(Object.hasOwn(tool.function.parameters.properties.messages.items.properties, 'speakerName'), false);
  console.log('ok - private reply provider tool cannot select its target or speaker');
}

{
  const tool = buildPrivateReplyProviderToolDefinition({
    allowedItemTypes: ['text', 'sticker', 'voice', 'transfer', 'music', 'image'],
    allowedStickerKeywords: ['晚安抱抱', '收到'],
  });
  const itemSchema = tool.function.parameters.properties.messages.items;
  assert.equal(Array.isArray(itemSchema.oneOf), true);
  assert.equal(itemSchema.oneOf.length, 6);
  const textBranch = itemSchema.oneOf.find(branch => branch.properties?.type?.const === 'text');
  const stickerBranch = itemSchema.oneOf.find(branch => branch.properties?.type?.const === 'sticker');
  const musicBranch = itemSchema.oneOf.find(branch => branch.properties?.type?.const === 'music');
  assert.deepEqual(textBranch.required, ['type', 'content']);
  assert.equal(Object.hasOwn(textBranch.properties, 'artist'), false);
  assert.equal(stickerBranch.properties.content.description.includes('晚安抱抱'), true);
  assert.deepEqual(musicBranch.required, ['type', 'content', 'artist']);
  assert.equal(Object.hasOwn(musicBranch.properties, 'artist'), true);
  console.log('ok - private reply provider schema isolates type-specific fields in discriminated branches');
}

{
  const result = buildPrivateChatPhoneReplyIr({
    args: {
      messages: [
        { content: '晚安\n明天见。', time: '22:12' },
        { content: '路上小心。' },
      ],
    },
    target: frozenTarget,
    source: {
      transport: 'provider_fc',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    },
  });
  assert.equal(result.ok, true, result.errors?.join(', '));
  assert.deepEqual(result.ir, {
    version: PHONE_REPLY_IR_VERSION,
    surface: 'private_chat',
    target: { sessionId: 'session-mia', name: '米娅' },
    items: [
      {
        type: 'text',
        speaker: { id: 'contact-mia', name: '米娅' },
        content: '晚安\n明天见。',
        time: '22:12',
      },
      {
        type: 'text',
        speaker: { id: 'contact-mia', name: '米娅' },
        content: '路上小心。',
        time: '',
      },
    ],
    source: {
      transport: 'provider_fc',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    },
  });
  assert.equal(validatePhoneReplyIr(result.ir, {
    expectedSurface: 'private_chat',
    expectedSessionId: 'session-mia',
  }).ok, true);

  const serialized = serializePhoneReplyIr(result.ir, {
    userName: '我',
    expectedSessionId: 'session-mia',
  });
  assert.equal(serialized.ok, true, serialized.errors?.join(', '));
  const events = parse(serialized.raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'private_chat');
  assert.equal(events[0].otherName, '米娅');
  assert.deepEqual(events[0].messages, [
    { speaker: '米娅', content: '晚安\n明天见。', time: '' },
    { speaker: '米娅', content: '路上小心。', time: '' },
  ]);
  console.log('ok - private PhoneReplyIR round-trips through canonical MiPhone and the existing parser');
}

{
  const allowedItemTypes = ['text', 'sticker', 'voice', 'transfer', 'music', 'image'];
  const result = buildPrivateChatPhoneReplyIr({
    args: {
      messages: [
        { type: 'text', content: '晚安。', time: '22:12' },
        { type: 'sticker', content: '晚安抱抱' },
        { type: 'voice', content: '明天见。' },
        { type: 'transfer', content: '52元' },
        { type: 'music', content: '富士山下', artist: '陈奕迅' },
        { type: 'image', content: '窗外的月亮' },
      ],
    },
    target: frozenTarget,
    allowedItemTypes,
    allowedStickerKeywords: ['晚安抱抱', '收到'],
  });
  assert.equal(result.ok, true, result.errors?.join(', '));
  assert.deepEqual(result.ir.items.map(item => item.type), allowedItemTypes);
  const serialized = serializePhoneReplyIr(result.ir, {
    userName: '我',
    expectedSessionId: 'session-mia',
  });
  assert.equal(serialized.ok, true, serialized.errors?.join(', '));
  const [event] = parse(serialized.raw);
  assert.deepEqual(event.messages.map(message => message.content), [
    '晚安。',
    '[bqb-晚安抱抱]',
    '[yy-明天见。]',
    '[zz-52元]',
    '[music-富士山下$陈奕迅]',
    '[img-窗外的月亮]',
  ]);
  assert.match(serialized.raw, /\[bqb-晚安抱抱\]/u);
  assert.match(serialized.raw, /\[music-富士山下\$陈奕迅\]/u);
  console.log('ok - private special-message IR round-trips through canonical raw and parser tokens');
}

{
  const invalidCases = [
    {
      label: 'empty messages',
      args: { messages: [] },
      error: 'items.empty',
    },
    {
      label: 'invalid time',
      args: { messages: [{ content: '晚安', time: '29:80' }] },
      error: 'item.time.invalid',
    },
    {
      label: 'protocol control marker',
      args: { messages: [{ content: '晚安\nMiPhone_end' }] },
      error: 'item.content.protocol_control',
    },
    {
      label: 'private close tag injection',
      args: { messages: [{ content: '</我和米娅的私聊>' }] },
      error: 'item.content.protocol_control',
    },
  ];
  invalidCases.forEach((fixture) => {
    const result = buildPrivateChatPhoneReplyIr({ args: fixture.args, target: frozenTarget });
    assert.equal(result.ok, false, fixture.label);
    assert.ok(result.errors.includes(fixture.error), `${fixture.label}: ${result.errors.join(', ')}`);
  });
  const tooMany = buildPrivateChatPhoneReplyIr({
    args: { messages: Array.from({ length: 13 }, (_, index) => ({ content: `消息 ${index + 1}` })) },
    target: frozenTarget,
  });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.includes('items.too_many'));

  const unsupported = buildPrivateChatPhoneReplyIr({
    args: { messages: [{ type: 'voice', content: '不应启用' }] },
    target: frozenTarget,
  });
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.errors.includes('item.type.unsupported'));

  const unknownSticker = buildPrivateChatPhoneReplyIr({
    args: { messages: [{ type: 'sticker', content: '模型自创贴图' }] },
    target: frozenTarget,
    allowedItemTypes: ['text', 'sticker'],
    allowedStickerKeywords: ['收到'],
  });
  assert.equal(unknownSticker.ok, false);
  assert.ok(unknownSticker.errors.includes('item.sticker.unknown'));

  const missingType = buildPrivateChatPhoneReplyIr({
    args: { messages: [{ content: '未声明类型' }] },
    target: frozenTarget,
    allowedItemTypes: ['text', 'voice'],
  });
  assert.equal(missingType.ok, false);
  assert.ok(missingType.errors.includes('item.type.missing'));

  const unexpectedFields = buildPrivateChatPhoneReplyIr({
    args: {
      targetName: '错误目标',
      messages: [{ type: 'voice', content: '内容', artist: '不应保留', target: '另一个人' }],
    },
    target: frozenTarget,
    allowedItemTypes: ['text', 'voice'],
  });
  assert.equal(unexpectedFields.ok, false);
  assert.ok(unexpectedFields.errors.includes('args.field.unexpected'));
  assert.ok(unexpectedFields.errors.includes('item.field.unexpected'));
  assert.ok(unexpectedFields.errors.includes('item.artist.unexpected'));
  console.log('ok - PhoneReplyIR rejects empty, oversized, malformed-time, and protocol-injection payloads');
}

{
  const result = buildPrivateChatPhoneReplyIr({
    args: { messages: [{ content: '正常回复' }] },
    target: frozenTarget,
  });
  assert.equal(result.ok, true);
  const wrongTarget = serializePhoneReplyIr(result.ir, {
    userName: '我',
    expectedSessionId: 'another-session',
  });
  assert.equal(wrongTarget.ok, false);
  assert.ok(wrongTarget.errors.includes('target.session_mismatch'));
  console.log('ok - serializer fails closed when the frozen session no longer matches');
}

console.log('phone-reply-ir-tests passed');
