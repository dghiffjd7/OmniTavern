import assert from 'node:assert/strict';
import {
  getChatTimeMode, formatLocalChatTime, initializeProtocolMessageTime,
  resolveProtocolDeliveryTimePatch, createRepairMessageTimeRestorer,
} from '../../src/scripts/utils/chat-time-policy.js';
import { buildContinuationMessageUpdate } from '../../src/scripts/ui/chat/continuation-message-utils.js';
import { appSettings } from '../../src/scripts/storage/app-settings.js';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';
import { serializeBuiltinPhoneFormat, validateBuiltinPhoneFormat } from '../../src/scripts/utils/builtin-phone-format-contract.js';
import { buildPrivateReplyProviderToolDefinition } from '../../src/scripts/ui/chat/phone-reply-ir.js';
import { buildPhoneReplyBatchProviderToolDefinition } from '../../src/scripts/ui/chat/phone-reply-batch-ir.js';
import { deliverProtocolDeliveryItem } from '../../src/scripts/ui/chat/protocol-delivery-plan-utils.js';
import { appendProtocolPrivateChatEventImmediate } from '../../src/scripts/ui/chat/protocol-event-apply-utils.js';
import { getBuiltinPhoneFormatPromptSeed } from '../../src/scripts/storage/builtin-worldbooks.js';
import { projectPhonePromptTime } from '../../src/scripts/utils/phone-format-time-prompt.js';

const parse = (raw, options = {}) => new DialogueStreamParser(options).push(raw);
const wrap = text => `<我和小雨的私聊>\n${text}\n</我和小雨的私聊>`;
assert.equal(appSettings.get().chatAiTimeEnabled, false);
assert.equal(getChatTimeMode({}), 'local');
assert.equal(getChatTimeMode({ chatAiTimeEnabled: true }), 'ai');
assert.equal(getChatTimeMode({ chatAiTimeEnabled: 'false' }), 'local');

for (const timeMode of ['local', 'ai']) {
  for (const [surface, payload] of [
    ['private_chat', { targetName: '小雨', messages: [{ speaker: '小雨', content: '你好', time: '09:15' }] }],
    ['group_chat', { groupName: '朋友', messages: [{ speaker: '小雨', content: '你好', time: '09:15' }] }],
    ['moment_post', { posts: [{ author: '小雨', content: '你好', time: '09:15', views: 4, likes: 2 }] }],
  ]) {
    const raw = serializeBuiltinPhoneFormat(surface, { ...payload, timeMode });
    assert.equal(raw.includes('--09:15'), timeMode === 'ai');
    assert.equal(validateBuiltinPhoneFormat(raw, { surface }).valid, true, raw);
    assert.equal(parse(raw).length, 1);
  }
  const privateSchema = buildPrivateReplyProviderToolDefinition({ timeMode });
  const batchSchema = buildPhoneReplyBatchProviderToolDefinition({ target: { mode: 'private_chat', timeMode }, capabilities: { momentPost: true } });
  assert.equal(JSON.stringify(privateSchema).includes('"time":'), timeMode === 'ai');
  assert.equal(JSON.stringify(batchSchema).includes('"time":'), timeMode === 'ai');
}
assert.doesNotMatch(serializeBuiltinPhoneFormat('private_chat', { timeMode: 'ai', messages: [{ content: 'hello' }] }), /00:00/);
assert.deepEqual(parse(wrap('小雨--正文A--正文B--正文C'))[0].messages, [{ speaker: '小雨', content: '正文A--正文B--正文C', time: '' }]);
assert.deepEqual(parse(wrap('小雨--第一行<br>第二行\n小雨--下一条--9：15'))[0].messages, [
  { speaker: '小雨', content: '第一行\n第二行', time: '' },
  { speaker: '小雨', content: '下一条', time: '09:15' },
]);
assert.equal(parse(wrap('小雨--你好--99:99'))[0].messages[0].time, '');
assert.equal(parse(wrap('小雨--你好--09:15<br>小雨--再见--09:16'))[0].messages.length, 2);
const chunks = new DialogueStreamParser();
assert.deepEqual(chunks.push('<我和小雨的私聊>小雨--半'), []);
assert.equal(chunks.push('行</我和小雨的私聊>')[0].messages[0].content, '半行');
const seed = getBuiltinPhoneFormatPromptSeed();
assert.doesNotMatch(seed.phone_format_chat_rules, /--(?:HH:mm|\d{2}:\d{2})/i);
assert.doesNotMatch(seed.phone_format_moment_rules, /--发言时间/);
assert.match(projectPhonePromptTime(seed.phone_format_chat_rules, { timeMode: 'ai' }), /--HH:mm/);
assert.match(projectPhonePromptTime(seed.phone_format_moment_rules, { timeMode: 'ai', surface: 'moment' }), /--HH:mm--/);
console.log('ok - settings default, both text formats, FC schemas, official prompts and stream boundaries');

const committedAt = new Date(2026, 8, 16, 10, 1).getTime();
const deliveredAt = committedAt + 65_000;
const message = initializeProtocolMessageTime({ id: 'm1', role: 'assistant', content: 'hello', timestamp: committedAt }, {
  timeMode: 'local', modelTime: '03:00', now: committedAt, deferDelivery: true,
});
let persisted = structuredClone(message);
let rendered;
let updates = 0;
const now = Date.now;
Date.now = () => deliveredAt;
try {
  const item = { message, delivery: { kind: 'private', targetSessionId: 'test', role: 'assistant' } };
  const options = {
    alreadyPersisted: true, findMessage: () => persisted,
    updateMessage: (id, patch) => { updates++; return persisted = { ...persisted, ...patch }; },
    isSessionActive: () => true, addUiMessage: value => { rendered = structuredClone(value); },
  };
  deliverProtocolDeliveryItem(item, options);
  assert.equal(rendered.time, formatLocalChatTime(deliveredAt));
  assert.equal(persisted.time, rendered.time);
  assert.equal(persisted.timestamp, committedAt);
  assert.equal(persisted.meta.chatTime.deliveredAt, deliveredAt);
  Date.now = () => deliveredAt + 120_000;
  deliverProtocolDeliveryItem(item, options);
  assert.equal(updates, 1);
  assert.equal(persisted.time, rendered.time);
  const old = { id: 'old', time: '04:20', timestamp: committedAt };
  assert.equal(resolveProtocolDeliveryTimePatch(old), null);
  const ai = initializeProtocolMessageTime({}, { timeMode: 'ai', modelTime: '03:00', now: committedAt, deferDelivery: true });
  assert.equal(ai.time, '03:00');
  assert.equal(resolveProtocolDeliveryTimePatch(ai), null);
  const invalid = initializeProtocolMessageTime({}, { timeMode: 'ai', modelTime: '99:99', now: committedAt });
  assert.equal(invalid.time, formatLocalChatTime(committedAt));
  const continuation = buildContinuationMessageUpdate({ existing: persisted, message: { content: 'continued', time: '23:59' }, targetId: persisted.id });
  assert.equal(continuation.time, persisted.time);
  assert.equal(continuation.meta.chatTime.deliveredAt, deliveredAt);
  const restore = createRepairMessageTimeRestorer([{ sessionId: 'test', message: persisted }]);
  const repaired = initializeProtocolMessageTime({ role: 'assistant', content: 'fixed' });
  restore(repaired, 'test');
  restore(repaired, 'test');
  assert.equal(repaired.time, persisted.time);
  assert.equal(repaired.meta.chatTime.deliveredAt, deliveredAt);
  let received;
  await appendProtocolPrivateChatEventImmediate(parse(wrap('小雨--晚安--03:00'))[0], {
    timeMode: 'local', deferTimeDelivery: true, resolveTargetSessionId: () => 'background',
    buildAssistantMessageFromText: async (content, options) => ({ role: 'assistant', content, time: options.time }),
    appendMessage: message => { received = message; return message; },
  });
  assert.equal(received.meta.chatTime.pendingDelivery, true);
  assert.notEqual(received.time, '03:00');
  deliverProtocolDeliveryItem({ message: received, delivery: { kind: 'private', targetSessionId: 'background' } }, {
    isSessionActive: () => false, appendMessage: message => { received = message; return message; },
  });
  assert.equal(received.meta.chatTime.pendingDelivery, false);
} finally { Date.now = now; }
console.log('ok - persisted first delivery, background receipt, no restamping, AI fallback and repair preservation');

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.__TAURI_INVOKE__ = async () => null;
const { MomentsStore } = await import('../../src/scripts/storage/moments-store.js');
const moments = new MomentsStore({ scopeId: 'chat-time-test' });
await moments.ready;
const raw = 'moment_start\n小雨--同样的正文--07:30--5--2\n朋友--评论\nmoment_end';
const first = moments.addMany(parse(raw, { sourceId: 'turn-a', timeMode: 'local' })[0].moments)[0];
assert.equal(first.meta.chatTime.source, 'local');
assert.notEqual(first.time, '07:30');
assert.ok(first.comments[0].time);
const repeated = moments.addMany(parse(raw, { sourceId: 'turn-a', timeMode: 'local' })[0].moments)[0];
assert.equal(repeated.id, first.id);
assert.equal(repeated.time, first.time);
assert.equal(repeated.timestamp, first.timestamp);
assert.equal(repeated.comments[0].id, first.comments[0].id);
const later = moments.addMany(parse(raw, { sourceId: 'turn-b', timeMode: 'ai' })[0].moments)[0];
assert.notEqual(later.id, first.id);
assert.equal(later.time, '07:30');
assert.equal(moments.list().length, 2);
await moments.flush();
const restoredStore = new MomentsStore({ scopeId: 'chat-time-test' });
await restoredStore.ready;
assert.equal(restoredStore.get(first.id).time, first.time);
console.log('ok - moment source dedupe, independent later posts, comments and persisted time');
