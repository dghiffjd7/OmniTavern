import assert from 'node:assert/strict';
import {
  SELF_REACTION_ACTOR,
  attachReplyTargetToMessage,
  buildOutgoingReplyContexts,
  buildRpFloorAssignments,
  buildReplyTargetSnapshot,
  countReactionActors,
  getRpFloorLabel,
  getMessagePreviewText,
  hasReactionActor,
  normalizeReactionEntries,
  normalizeReplyTarget,
  toggleReactionActor,
} from '../../src/scripts/ui/chat/message-interaction-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('getMessagePreviewText should summarize special message types', () => {
  assert.equal(getMessagePreviewText({ type: 'image' }), '[图片]');
  assert.equal(getMessagePreviewText({ type: 'document', content: '合同.pdf' }), '[文件] 合同.pdf');
  assert.equal(getMessagePreviewText({ type: 'sticker', content: 'happy' }), '[表情]');
});

test('buildReplyTargetSnapshot should keep author, avatar and truncated content', () => {
  const snapshot = buildReplyTargetSnapshot(
    {
      id: 'm1',
      role: 'assistant',
      type: 'text',
      content: '这是一段很长很长的测试内容，用来确认回复摘要会被截断并且保留必要的信息。',
    },
    { author: '测试角色', avatar: 'avatar.png', sessionId: 'contact:test' },
  );
  assert.equal(snapshot.id, 'm1');
  assert.equal(snapshot.author, '测试角色');
  assert.equal(snapshot.avatar, 'avatar.png');
  assert.equal(snapshot.sessionId, 'contact:test');
  assert.ok(snapshot.content.startsWith('这是一段很长很长的测试内容'));
});

test('normalizeReplyTarget should drop empty targets', () => {
  assert.equal(normalizeReplyTarget(null), null);
  assert.equal(normalizeReplyTarget({}), null);
});

test('attachReplyTargetToMessage should clone meta and normalize reply target', () => {
  const source = {
    id: 'u1',
    role: 'user',
    type: 'text',
    content: '回复内容',
    meta: { existing: true },
  };
  const result = attachReplyTargetToMessage(source, {
    id: 'a1',
    role: 'assistant',
    content: '被回复内容',
    author: '助手',
  });

  assert.notEqual(result, source);
  assert.notEqual(result.meta, source.meta);
  assert.deepEqual(result.meta, {
    existing: true,
    replyTo: {
      id: 'a1',
      role: 'assistant',
      type: 'text',
      author: '助手',
      avatar: '',
      content: '被回复内容',
      sessionId: '',
    },
  });
  assert.equal(attachReplyTargetToMessage(source, null), source);
});

test('buildOutgoingReplyContexts should keep prompt-safe user previews and normalized targets', () => {
  const contexts = buildOutgoingReplyContexts([
    {
      id: 'u1',
      type: 'text',
      content: '当前用户消息',
      meta: {
        replyTo: {
          id: 'a1',
          role: 'assistant',
          content: '上一条助手消息',
          author: '助手',
        },
      },
    },
    {
      id: 'u2',
      type: 'sticker',
      content: '开心',
      meta: {},
    },
  ]);

  assert.deepEqual(contexts, [{
    userMessage: '当前用户消息',
    replyTo: {
      id: 'a1',
      role: 'assistant',
      type: 'text',
      author: '助手',
      avatar: '',
      content: '上一条助手消息',
      sessionId: '',
    },
  }]);
});

test('normalizeReactionEntries should merge duplicate emoji and unique actors', () => {
  const normalized = normalizeReactionEntries([
    { emoji: '👍', actors: ['a', 'a'] },
    { emoji: '👍', actors: ['b'] },
    { emoji: '❤️', actors: [] },
  ]);
  assert.deepEqual(normalized, [
    { emoji: '👍', actors: ['a', 'b'] },
  ]);
});

test('toggleReactionActor should add and remove self reactions', () => {
  let next = toggleReactionActor([], '😂');
  assert.equal(countReactionActors(next[0]), 1);
  assert.equal(hasReactionActor(next[0], SELF_REACTION_ACTOR), true);

  next = toggleReactionActor(next, '😂');
  assert.deepEqual(next, []);
});

test('buildRpFloorAssignments should number greeting and dialogue turns consistently', () => {
  const assignments = buildRpFloorAssignments([
    { role: 'assistant', meta: { isGreeting: true } },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' },
  ]);
  assert.deepEqual(assignments, [
    { floor: 0, marker: true },
    { floor: 0, marker: false },
    { floor: 1, marker: true },
    { floor: 1, marker: false },
    { floor: 2, marker: true },
    { floor: 2, marker: false },
  ]);
  assert.equal(getRpFloorLabel(0), '#0 序章');
  assert.equal(getRpFloorLabel(3), '# 3');
});

test('buildRpFloorAssignments should recompute later floors after a user turn is removed', () => {
  const assignments = buildRpFloorAssignments([
    { role: 'assistant', meta: { isGreeting: true } },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' },
    { role: 'assistant' },
  ]);
  assert.deepEqual(assignments, [
    { floor: 0, marker: true },
    { floor: 0, marker: false },
    { floor: 1, marker: true },
    { floor: 1, marker: false },
    { floor: 1, marker: false },
  ]);
});

test('getRpFloorLabel shows the prologue label in the UI language', async () => {
  const { initializeI18n } = await import('../../src/scripts/i18n/index.js');
  try {
    await initializeI18n({
      preference: 'en',
      documentLike: null,
      fetchFn: async () => ({ ok: true, json: async () => ({ 序章: 'Prologue' }) }),
    });
    assert.equal(getRpFloorLabel(0), '#0 Prologue');
    assert.equal(getRpFloorLabel(2), '# 2');
  } finally {
    await initializeI18n({ preference: 'zh-CN', documentLike: null });
  }
  assert.equal(getRpFloorLabel(0), '#0 序章');
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${item.name}`);
    console.error(error);
  }
}

if (failed > 0) process.exit(1);
