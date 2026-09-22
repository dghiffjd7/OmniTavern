import assert from 'node:assert/strict';

import { createDebugTraceTimeline } from '../../src/scripts/ui/debug-trace-timeline-utils.js';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';
import {
  buildMomentLifecycleTraceEvent,
  createMomentCommentLifecycleRuntime,
} from '../../src/scripts/ui/chat/moments-runtime-utils.js';
import { createMomentFeedSendHandler } from '../../src/scripts/ui/moments-feed-interaction-utils.js';

const momentRecord = {
  id: 'm1',
  author: 'Alice',
  content: '今天想出去走走',
  originSessionId: 'contact:alice',
  comments: [
    {
      id: 'c0',
      author: 'Bob',
      content: '早安',
    },
  ],
};
const momentMap = new Map([[momentRecord.id, momentRecord]]);
const chatMessages = new Map();
const summaries = [];
const renders = [];
const savedRaw = [];
let touchedChats = 0;
let touchedMoments = 0;
let compacted = false;
let summariesUpdated = 0;
let now = 4000;
const timeline = createDebugTraceTimeline({
  maxEvents: 80,
  now: () => now,
});
const recordLifecycleEvent = (event) => {
  now += 19;
  return timeline.record(buildMomentLifecycleTraceEvent(event));
};

const momentsStore = {
  get(id) {
    return momentMap.get(id) || null;
  },
  list() {
    return [...momentMap.values()];
  },
  addComments(momentId, comments) {
    const target = this.get(momentId);
    if (!target) return null;
    const startIndex = target.comments.length;
    target.comments.push(
      ...comments.map((comment, index) => ({
        id: comment?.id || `saved-comment-${startIndex + index + 1}`,
        ...comment,
      })),
    );
    return target;
  },
};

const rawReply = `<content>
moment_reply_start
moment_id:: m1
Bob--我也想你
moment_reply_end
<我和Alice的私聊>
Alice--私聊补一句--10:01
我--收到啦--10:02
</我和Alice的私聊>
<details><summary>摘要</summary> 关系升温 </details>
</content>`;

const inputEl = { value: ' 想你了 ' };
const replyTargets = new Map([[
  'm1',
  {
    id: 'c0',
    author: 'Bob',
    content: '早安',
  },
]]);
const openComposer = new Set(['m1']);
const pendingComment = new Set();

let generationResult = null;
const momentCommentRuntime = createMomentCommentLifecycleRuntime({
  getIsConfigured: () => true,
  isOnline: () => true,
  getConfig: () => ({ stream: false }),
  getMoment: id => momentsStore.get(id),
  getCurrentSessionId: () => 'contact:alice',
  getContactCount: () => 3,
  getActiveUserProfile: () => ({ name: '我' }),
  getActiveUserName: () => '我',
  contactsStore: {
    listContacts: () => [{ id: 'contact:alice', name: 'Alice' }],
  },
  momentsStore,
  normalizeName: value => String(value || '').trim(),
  normalizeLooseName: value => String(value || '').trim(),
  normalizeStickerTextForPrompt: value => String(value || '').trim(),
  normalizeMomentComments: comments => comments,
  addMomentComments: (momentId, comments) => momentsStore.addComments(momentId, comments),
  bumpMomentEngagement: (momentId, count) => {
    const target = momentsStore.get(momentId);
    if (target) target.engagement = (target.engagement || 0) + count;
  },
  resolvePrivateChatTargetSessionId: name => (name === 'Alice' ? 'contact:alice' : ''),
  parseSpecialMessage: content => ({ type: 'text', content, meta: {} }),
  userAvatar: 'user.png',
  resolveAssistantAvatar: () => 'alice.png',
  appendPrivateChatMessage: (message, targetSessionId) => {
    const list = chatMessages.get(targetSessionId) || [];
    const saved = {
      ...message,
      id: message.id || `chat-${list.length + 1}`,
    };
    list.push(saved);
    chatMessages.set(targetSessionId, list);
    return saved;
  },
  autoMarkReadIfActive: () => {},
  onTouchedChats: () => { touchedChats += 1; },
  onTouchedMoments: () => { touchedMoments += 1; },
  generate: async (comment, context) => {
    assert.equal(comment, '想你了');
    assert.equal(context.task.targetName, 'Bob');
    assert.equal(context.meta.chatTimeMode, 'local');
    return rawReply;
  },
  createParser: options => new DialogueStreamParser({ userName: '我', ...options }),
  saveRawReply: async raw => savedRaw.push(raw),
  flushMoments: async () => {},
  addSummary: async summary => summaries.push(summary),
  runSummaryCompaction: async () => { compacted = true; },
  notifySummariesUpdated: async () => { summariesUpdated += 1; },
  logger: { warn: () => {}, error: () => {} },
  recordLifecycleEvent,
});
const send = createMomentFeedSendHandler({
  moment: momentRecord,
  inputEl,
  replyTargets,
  openComposer,
  pendingComment,
  store: momentsStore,
  applyMomentStoredRegex: text => text,
  render: options => renders.push(options),
  onUserComment: async (momentId, text, meta) => {
    assert.equal(momentId, 'm1');
    assert.equal(text, '想你了');
    assert.equal(meta.userCommentId, 'user-comment-1');
    assert.equal(meta.replyTo?.id, 'c0');
    generationResult = await momentCommentRuntime(momentId, text, meta);
  },
  recordLifecycleEvent,
  loggerWarn: () => {},
  generateCommentId: () => 'user-comment-1',
});

// The default policy uses local delivery time even when legacy AI timestamps are present.
const deliveredAt = new Date(2026, 8, 18, 9, 30).getTime();
const displayTime = new Date(deliveredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const realNow = Date.now;
let sent;
Date.now = () => deliveredAt;
try {
  sent = await send();
} finally {
  Date.now = realNow;
}

assert.equal(sent, true);
assert.equal(inputEl.value, '');
assert.equal(openComposer.has('m1'), false);
assert.equal(replyTargets.has('m1'), false);
assert.equal(pendingComment.has('m1'), false);
assert.deepEqual(renders, [{ preserveScroll: true }, { preserveScroll: true }]);

const comments = momentsStore.get('m1').comments;
assert.equal(comments.length, 3);
assert.deepEqual(comments[1], {
  id: 'user-comment-1',
  author: '我',
  content: '想你了',
  regexMode: 'input',
  replyTo: 'c0',
  replyToAuthor: 'Bob',
});
assert.deepEqual(comments[2], {
  id: 'saved-comment-3',
  author: 'Bob',
  content: '我也想你',
  replyTo: 'c0',
  replyToAuthor: 'Bob',
  time: displayTime,
  meta: { chatTime: { source: 'local', receivedAt: deliveredAt, deliveredAt } },
});
assert.equal(momentRecord.engagement, 6);

assert.equal(generationResult.fullRaw, rawReply);
assert.equal(generationResult.sawMomentReply, true);
assert.deepEqual(savedRaw, [rawReply]);
assert.deepEqual(summaries, ['关系升温']);
assert.equal(compacted, true);
assert.equal(summariesUpdated, 1);
assert.equal(touchedChats, 1);
assert.equal(touchedMoments, 1);
assert.deepEqual(
  timeline.snapshot({ category: 'moments', momentId: 'm1' }).map(event => [event.phase, event.status]),
  [
    ['comment.local.start', 'started'],
    ['comment.start', 'started'],
    ['comment.finish', 'success'],
    ['comment.local.finish', 'success'],
  ],
);
assert.equal(
  timeline.snapshot().some(event => JSON.stringify(event.details || {}).includes('想你了')),
  false,
);

assert.deepEqual(
  chatMessages.get('contact:alice').map(message => ({
    id: message.id,
    role: message.role,
    content: message.content,
    time: message.time,
    avatar: message.avatar,
    meta: message.meta || {},
  })),
  [
    {
      id: 'chat-1',
      role: 'assistant',
      content: '私聊补一句',
      time: displayTime,
      avatar: 'alice.png',
      meta: { chatTime: { source: 'local', receivedAt: deliveredAt, modelTime: '10:01', deliveredAt } },
    },
    {
      id: 'chat-2',
      role: 'user',
      content: '收到啦',
      time: displayTime,
      avatar: 'user.png',
      meta: {
        chatTime: { source: 'local', receivedAt: deliveredAt, modelTime: '10:02', deliveredAt },
        generatedByAssistant: true,
      },
    },
  ],
);

console.log('ok - moments lifecycle integration sends local comments parses replies stores private chat and saves summary');
