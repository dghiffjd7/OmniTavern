import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';

import {
  applyMomentCommentEvents,
  applyMomentSummaryFromRaw,
  buildMomentCommentFinishTraceEvent,
  buildMomentCommentSkippedTraceEvent,
  buildMomentCommentStartTraceEvent,
  buildMomentFeedCommentFinishTraceEvent,
  buildMomentFeedCommentSkippedTraceEvent,
  buildMomentFeedCommentStartTraceEvent,
  buildMomentLifecycleTraceEvent,
  buildMomentCommentContactList,
  buildMomentCommentGroupList,
  buildMomentCommentPromptData,
  buildMomentCommentReferenceTable,
  buildMomentCommentSideEffectInstructions,
  buildMomentCommentTaskContext,
  buildMomentGroupChatMessages,
  buildMomentImageAttachmentParts,
  buildMomentPromptContentText,
  buildMomentPrivateChatMessages,
  buildMomentRecentCommentsText,
  buildMomentSummaryCompactionFinishTraceEvent,
  buildMomentSummaryCompactionSkippedTraceEvent,
  buildMomentSummaryCompactionStartTraceEvent,
  collectMomentCommentContactList,
  collectMomentCommentStructuredTargets,
  createMomentCommentLifecycleRuntime,
  createMomentSummaryCompactionRuntime,
  extractMomentReplySegments,
  extractMomentSummaryText,
  patchMomentReplyComments,
  resolveMomentReplyEventTarget,
  resolveMomentPublishCommentTarget,
  resolveMomentReplyTarget,
  resolvePrivateChatTargetSessionIdByName,
  runMomentCommentGeneration,
  runMomentReplyRetry,
  sanitizeThinkingForMomentReply,
  stripMomentImageTokensForPrompt,
} from '../../src/scripts/ui/chat/moments-runtime-utils.js';

{
  const event = buildMomentLifecycleTraceEvent({
    phase: ' comment.start ',
    sessionId: ' contact:1 ',
    momentId: ' m1 ',
    status: ' started ',
    summary: ' started ',
    details: { kept: true, dropped: undefined },
  });
  assert.deepEqual(event, {
    category: 'moments',
    source: 'moments-runtime',
    phase: 'comment.start',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'started',
    summary: 'started',
    details: { kept: true },
  });
  console.log('ok - buildMomentLifecycleTraceEvent normalizes lifecycle metadata and drops undefined details');
}

{
  assert.deepEqual(buildMomentCommentSkippedTraceEvent({
    momentId: ' m1 ',
    reason: 'missing-input',
    hasMomentId: true,
    hasText: false,
  }), {
    phase: 'comment.skipped',
    momentId: 'm1',
    status: 'skipped',
    summary: 'moment comment skipped',
    details: {
      reason: 'missing-input',
      hasMomentId: true,
      hasText: false,
    },
  });
  assert.deepEqual(buildMomentCommentStartTraceEvent({
    sessionId: ' contact:1 ',
    momentId: ' m1 ',
    authorName: 'Alice',
    targetSessionId: 'contact:bob',
    targetName: 'Bob',
    stream: 1,
    isReplyToComment: true,
    userCommentId: 'uc1',
    hasRecentComments: true,
  }), {
    phase: 'comment.start',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'started',
    summary: 'moment comment generation started',
    details: {
      authorName: 'Alice',
      targetSessionId: 'contact:bob',
      targetName: 'Bob',
      stream: true,
      isReplyToComment: true,
      userCommentId: 'uc1',
      hasRecentComments: true,
    },
  });
  assert.deepEqual(buildMomentCommentFinishTraceEvent({
    sessionId: 'contact:1',
    momentId: 'm1',
    authorName: 'Alice',
    stream: false,
    isReplyToComment: true,
    userCommentId: 'uc1',
    sawMomentReply: false,
    fullRaw: 'RAW',
  }), {
    phase: 'comment.finish',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'warning',
    summary: 'moment comment reply not parsed',
    details: {
      authorName: 'Alice',
      stream: false,
      isReplyToComment: true,
      userCommentId: 'uc1',
      sawMomentReply: false,
      rawLength: 3,
    },
  });
  assert.deepEqual(buildMomentCommentFinishTraceEvent({
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'error',
    authorName: 'Alice',
    isReplyToComment: false,
    userCommentId: '',
    started: true,
    errorMessage: 'failed',
  }), {
    phase: 'comment.finish',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'error',
    summary: 'failed',
    details: {
      authorName: 'Alice',
      isReplyToComment: false,
      userCommentId: '',
      started: true,
    },
  });
  assert.deepEqual(buildMomentFeedCommentSkippedTraceEvent({
    sessionId: ' contact:1 ',
    momentId: ' m1 ',
    reason: ' empty-text ',
    pending: false,
    hasText: false,
  }), {
    phase: 'comment.local.skipped',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'skipped',
    summary: 'local moment comment skipped',
    details: {
      reason: 'empty-text',
      pending: false,
      hasText: false,
    },
  });
  assert.deepEqual(buildMomentFeedCommentStartTraceEvent({
    sessionId: ' contact:1 ',
    momentId: ' m1 ',
    userCommentId: ' uc1 ',
    isReplyToComment: true,
  }), {
    phase: 'comment.local.start',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'started',
    summary: 'local moment comment send started',
    details: {
      userCommentId: 'uc1',
      isReplyToComment: true,
    },
  });
  assert.deepEqual(buildMomentFeedCommentFinishTraceEvent({
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'error',
    userCommentId: 'uc1',
    isReplyToComment: true,
    errorMessage: 'callback failed',
  }), {
    phase: 'comment.local.finish',
    sessionId: 'contact:1',
    momentId: 'm1',
    status: 'error',
    summary: 'local moment comment callback failed',
    details: {
      userCommentId: 'uc1',
      isReplyToComment: true,
      errorMessage: 'callback failed',
    },
  });
  assert.deepEqual(buildMomentSummaryCompactionSkippedTraceEvent({
    reason: 'threshold-not-met',
    scopeKey: 'global',
    force: false,
    itemCount: 2,
  }), {
    phase: 'summary.compaction.skipped',
    status: 'skipped',
    summary: 'moment summary compaction skipped',
    details: {
      reason: 'threshold-not-met',
      scopeKey: 'global',
      force: false,
      itemCount: 2,
    },
  });
  assert.deepEqual(buildMomentSummaryCompactionStartTraceEvent({
    scopeKey: 'global',
    force: true,
    itemCount: 3,
  }), {
    phase: 'summary.compaction.start',
    status: 'started',
    summary: 'moment summary compaction started',
    details: {
      scopeKey: 'global',
      force: true,
      itemCount: 3,
    },
  });
  assert.deepEqual(buildMomentSummaryCompactionFinishTraceEvent({
    status: 'success',
    scopeKey: 'global',
    force: false,
    itemCount: 3,
    keptCount: 2,
    raw: '<summary>ok</summary>',
    summaryText: 'ok',
  }), {
    phase: 'summary.compaction.finish',
    status: 'success',
    summary: 'moment summary compaction finished',
    details: {
      scopeKey: 'global',
      force: false,
      itemCount: 3,
      keptCount: 2,
      rawLength: 21,
      summaryLength: 2,
    },
  });
  assert.deepEqual(buildMomentSummaryCompactionFinishTraceEvent({
    status: 'skipped',
    reason: 'empty-raw',
    scopeKey: 'global',
    force: false,
    itemCount: 3,
  }), {
    phase: 'summary.compaction.finish',
    status: 'skipped',
    summary: 'moment summary compaction skipped',
    details: {
      reason: 'empty-raw',
      scopeKey: 'global',
      force: false,
      itemCount: 3,
    },
  });
  console.log('ok - moment comment feed and summary trace patch builders preserve raw payload contracts');
}

{
  const target = resolveMomentReplyTarget({
    isReplyToComment: true,
    replyTo: { author: '小王' },
    authorName: '发布者',
    originSessionId: 'session:1',
    resolvePrivateChatTargetSessionId: (name) => (name === '小王' ? 'contact:2' : ''),
  });
  assert.deepEqual(target, { name: '小王', sessionId: 'contact:2' });
  console.log('ok - resolveMomentReplyTarget prefers reply author session when replying to a comment');
}

{
  const text = buildMomentRecentCommentsText([
    { id: 'c1', author: '甲', content: '你好\n世界' },
    { id: 'c2', author: '乙', content: '回复甲', replyTo: 'c1', replyToAuthor: '甲' },
    { id: 'c3', author: '甲', content: '第二条主评论' },
    { id: 'c4', author: '丙', content: '回复第二条', replyTo: 'c3', replyToAuthor: '甲' },
  ]);
  assert.equal(text, [
    '[A0] author::甲 | content::你好<br>世界',
    '[A1] author::乙 | reply_to::A0 | content::回复甲',
    '[B0] author::甲 | content::第二条主评论',
    '[B1] author::丙 | reply_to::B0 | content::回复第二条',
  ].join('\n'));
  const table = buildMomentCommentReferenceTable([
    { id: 'root', author: '甲', content: '主评论' },
    { id: 'reply', author: '乙', content: '楼中楼', replyTo: 'root', replyToAuthor: '甲' },
  ]);
  assert.deepEqual(table.refToId, { A0: 'root', A1: 'reply' });
  console.log('ok - buildMomentRecentCommentsText formats reference-coded threaded comments');
}

{
  const text = buildMomentCommentPromptData({
    authorName: '发布者',
    content: '动态内容',
    time: '10:00',
    userLine: '{{user}}：{{lastUserMessage}}',
    isReplyToComment: true,
    replyTo: { author: '甲', content: '原评论' },
    recentComments: '[A0] author::甲 | content::hi',
    contactList: '- 发布者\n- 甲',
    groupList: '- 晚饭群（成员：甲、乙）',
  });
  assert.doesNotMatch(text, /moment_id/);
  assert.match(text, /发布者: 发布者/);
  assert.match(text, /reply_to_author: 甲/);
  assert.match(text, /当前评论列表/);
  assert.match(text, /\[A0\] author::甲/);
  assert.match(text, /可用联系人名单/);
  assert.match(text, /【可用群聊】/);
  assert.match(text, /- 晚饭群（成员：甲、乙）/);
  console.log('ok - buildMomentCommentPromptData builds constrained moment comment prompt payload');
}

{
  const stripped = stripMomentImageTokensForPrompt('正文\n[img-/tmp/generated.png]\n[bqb-attachment_moments_generated_images_a.png]]\n尾声');
  assert.equal(stripped, '正文\n\n尾声');
  const content = buildMomentPromptContentText('今天晴朗\n[img-/tmp/a.png]\n[bqb-attachment_moments_generated_images_b.png]]', {
    normalizeText: value => String(value || '').trim(),
  });
  assert.equal(content, '今天晴朗');
  console.log('ok - moment prompt content strips generated image tokens before sending text');
}

{
  const parts = await buildMomentImageAttachmentParts({
    content: '正文\n[img-/tmp/a.png]\n[img-https://example.test/b.png]',
    generatedImages: [
      { output: { path: '/tmp/a.png' } },
      { output: { dataUrl: 'data:image/png;base64,CCC' } },
    ],
  }, {
    resolveImageUrl: asset => {
      const path = String(asset?.output?.path || '').trim();
      if (path === '/tmp/a.png') return 'asset://a.png';
      return String(asset?.output?.dataUrl || asset?.output?.url || '').trim();
    },
    toLlmImageUrl: async url => (url === 'asset://a.png' ? 'data:image/png;base64,AAA' : url),
    maxImages: 4,
  });
  assert.deepEqual(parts, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,CCC' } },
    { type: 'image_url', image_url: { url: 'https://example.test/b.png' } },
  ]);
  console.log('ok - buildMomentImageAttachmentParts converts generated moment images into prompt image parts');
}

{
  const list = buildMomentCommentContactList(['甲', '乙', '甲', '', 'rp:default', '我', 'user'], {
    authorName: '发布者',
    maxItems: 3,
  });
  assert.equal(list, '- 发布者\n- 甲\n- 乙');
  console.log('ok - buildMomentCommentContactList deduplicates and limits candidates');
}

{
  const list = collectMomentCommentContactList({
    listContacts: () => [
      { id: 'u1', name: '我' },
      { id: 'rp:default', name: '' },
      { id: 'u2', name: '甲' },
      { id: 'u3', name: '乙', isGroup: true },
      { id: 'u4', name: '甲' },
      { id: 'u5', name: '用户' },
      { id: 'u6', name: '丙' },
    ],
  }, {
    authorName: '发布者',
    maxItems: 3,
  });
  assert.equal(list, '- 发布者\n- 甲\n- 丙');
  console.log('ok - collectMomentCommentContactList filters self/group contacts before building prompt list');
}

{
  const list = buildMomentCommentGroupList({
    listContacts: () => [
      { id: 'user:1', name: '我' },
      { id: 'contact:alice', name: 'Alice' },
      { id: 'contact:bob', name: 'Bob' },
      { id: 'group:morning', name: '早安群', isGroup: true, members: ['contact:alice', 'contact:bob'] },
      { id: 'rp:default', name: 'RP群', isGroup: true, members: ['contact:alice'] },
    ],
    getContact: id => ({
      'contact:alice': { id: 'contact:alice', name: 'Alice' },
      'contact:bob': { id: 'contact:bob', name: 'Bob' },
    }[id] || null),
  });
  assert.equal(list, '- 早安群（成员：Alice、Bob）');
  console.log('ok - buildMomentCommentGroupList injects available group names with member names');
}

{
  const target = resolveMomentPublishCommentTarget({
    authorName: '我',
    userName: '我',
    contactsStore: {
      listContacts: () => [
        { id: 'user:1', name: '我' },
        { id: 'rp:default', name: '' },
        { id: 'group:1', name: '群', isGroup: true },
        { id: 'contact:alice', name: 'Alice' },
      ],
    },
  });
  assert.deepEqual(target, { name: 'Alice', sessionId: 'contact:alice' });
  console.log('ok - resolveMomentPublishCommentTarget selects first non-user contact for published moment comments');
}

{
  const ctx = buildMomentCommentTaskContext({
    userProfile: {
      name: '我',
      description: '设定',
      position: 'p',
      depth: 2,
      role: 'r',
    },
    target: { name: '发布者', sessionId: 'contact:1' },
    authorName: '发布者',
    originSessionId: 'contact:1',
    momentId: 'moment:1',
    promptData: 'PROMPT',
    triggerText: '只用于动态世界书触发',
    memoryStorageMode: 'table',
    memoryAutoExtract: true,
    memoryInjectPosition: 'history_depth',
    memoryInjectDepth: 2,
    memoryGuidePosition: 'system_end',
    memoryGuideDepth: 1,
    isReplyToComment: true,
    replyTo: { id: 'c1', author: '甲' },
    mentions: [
      { id: 'contact:alice', name: 'Alice', type: 'contact' },
      { id: 'rp:persona_1', name: '角色房间' },
    ],
    structuredTargets: {
      momentAuthors: [{ id: 'contact:1', name: '发布者' }],
      privateTargets: [{ id: 'contact:2', name: '联系人' }],
      groupTargets: [{
        id: 'group:1',
        name: '群聊',
        members: [{ id: 'contact:1', name: '发布者' }],
      }],
    },
    allowSideEffects: true,
  });
  assert.equal(ctx.user.name, '我');
  assert.equal(ctx.task.type, 'moment_comment');
  assert.equal(ctx.task.momentId, 'moment:1');
  assert.equal(ctx.task.allowSideEffects, true);
  assert.deepEqual(ctx.task.structuredTargets.momentAuthors, [{ id: 'contact:1', name: '发布者' }]);
  assert.equal(ctx.meta?.uiMode, 'moments');
  assert.equal(ctx.meta?.skipScripts, true);
  assert.equal(ctx.meta?.memoryStorageMode, 'table');
  assert.equal(ctx.meta?.memoryAutoExtract, true);
  assert.equal(ctx.meta?.memoryContextType, 'global');
  assert.equal(ctx.meta?.memorySessionId, 'moments');
  assert.equal(ctx.meta?.memoryInjectPosition, 'history_depth');
  assert.equal(ctx.meta?.memoryInjectDepth, 2);
  assert.equal(ctx.meta?.memoryGuidePosition, 'system_end');
  assert.equal(ctx.meta?.memoryGuideDepth, 1);
  assert.equal(ctx.task.replyToCommentId, 'c1');
  assert.equal(ctx.task.replyToAuthor, '甲');
  assert.equal(ctx.task.triggerText, '只用于动态世界书触发');
  assert.deepEqual(ctx.task.mentions, [
    { id: 'contact:alice', name: 'Alice', type: 'contact' },
  ]);
  assert.equal(ctx.character.name, '发布者');
  console.log('ok - buildMomentCommentTaskContext builds task payload with optional reply metadata');
}

{
  const contacts = [
    { id: 'contact:alice', name: 'Alice' },
    { id: 'contact:bob', name: 'Bob' },
    { id: 'group:friends', name: '朋友群', isGroup: true, members: ['contact:alice', 'contact:bob'] },
    { id: 'rp:hidden', name: 'RP 隐藏' },
  ];
  const targets = collectMomentCommentStructuredTargets({
    listContacts: () => contacts,
    getContact: id => contacts.find(item => item.id === id) || null,
  }, {
    authorName: 'Alice',
    userName: '我',
    publishedMoment: false,
  });
  assert.deepEqual(targets.momentAuthors, [{ id: 'contact:alice', name: 'Alice' }]);
  assert.deepEqual(targets.privateTargets.map(item => item.id), ['contact:alice', 'contact:bob']);
  assert.deepEqual(targets.groupTargets, [{
    id: 'group:friends',
    name: '朋友群',
    members: [
      { id: 'contact:alice', name: 'Alice' },
      { id: 'contact:bob', name: 'Bob' },
    ],
  }]);
  console.log('ok - moment structured targets preserve ids while excluding internal contacts');
}

{
  const text = buildMomentCommentSideEffectInstructions({ enabled: true, userName: '我' });
  assert.match(text, /决策/);
  assert.match(text, /话题是否私密或敏感/);
  assert.match(text, /总数不超过 3 个/);
  assert.match(text, /<我和联系人名的私聊>/);
  assert.match(text, /<群聊：群名>/);
  assert.equal(buildMomentCommentSideEffectInstructions({ enabled: false }), '');
  console.log('ok - buildMomentCommentSideEffectInstructions is controlled by setting flag');
}

{
  const patched = patchMomentReplyComments(
    [
      { author: '甲', content: '回复' },
      { author: '乙', content: '旁观', replyTo: 'x' },
    ],
    {
      isReplyToComment: true,
      replyTo: { id: 'comment:1', author: '甲' },
      targetName: '发布者',
    },
  );
  assert.deepEqual(patched, [
    { author: '甲', content: '回复', replyTo: 'comment:1', replyToAuthor: '甲' },
    { author: '乙', content: '旁观', replyTo: 'x' },
  ]);
  const namedPatched = patchMomentReplyComments(
    [
      { author: '甲', content: '回复', replyTo: 'a1' },
      { author: '乙', content: '插话', replyTo: 'B0' },
      { author: '丁', content: '沿用旧格式', replyTo: 'comment:3' },
    ],
    {
      isReplyToComment: true,
      replyTo: { id: 'comment:1', author: '甲' },
      existingComments: [
        { id: 'comment:1', author: '甲' },
        { id: 'comment:3', author: '丙' },
      ],
      commentRefMap: { A1: 'comment:1', B0: 'comment:3' },
    },
  );
  assert.deepEqual(namedPatched, [
    { author: '甲', content: '回复', replyTo: 'comment:1', replyToAuthor: '甲' },
    { author: '乙', content: '插话', replyTo: 'comment:3', replyToAuthor: '丙' },
    { author: '丁', content: '沿用旧格式', replyTo: 'comment:3', replyToAuthor: '丙' },
  ]);
  const invalidRefPatched = patchMomentReplyComments(
    [
      { author: '乙', content: '无效引用', replyTo: 'Z9', replyToAuthor: '未知' },
    ],
    {
      existingComments: [{ id: 'comment:1', author: '甲' }],
      commentRefMap: { A0: 'comment:1' },
    },
  );
  assert.deepEqual(invalidRefPatched, [
    { author: '乙', content: '无效引用', replyTo: '', replyToAuthor: '' },
  ]);
  console.log('ok - patchMomentReplyComments injects and resolves coded reply targets');
}

{
  const warnings = [];
  const store = {
    get(id) {
      return id === 'm1' ? { id: 'm1' } : null;
    },
    list() {
      return [{ id: 'm1' }];
    },
  };
  const result = resolveMomentReplyEventTarget({
    eventMomentId: 'missing',
    currentMomentId: 'm1',
    momentsStore: store,
    logger: { warn: (...args) => warnings.push(args) },
    incomingCount: 2,
  });
  assert.equal(result.momentId, 'm1');
  assert.equal(result.targetMoment?.id, 'm1');
  assert.equal(warnings.length, 1);
  console.log('ok - resolveMomentReplyEventTarget falls back to current moment before warning hard failure');
}

{
  const warnings = [];
  const store = {
    get(id) {
      return id === 'm1' ? { id: 'm1' } : null;
    },
    list() {
      return [{ id: 'm1' }];
    },
  };
  const result = resolveMomentReplyEventTarget({
    eventMomentId: '动态ID',
    currentMomentId: 'm1',
    momentsStore: store,
    logger: { warn: (...args) => warnings.push(args) },
    incomingCount: 2,
  });
  assert.equal(result.momentId, 'm1');
  assert.equal(result.targetMoment?.id, 'm1');
  assert.equal(warnings.length, 0);
  console.log('ok - resolveMomentReplyEventTarget treats copied placeholder moment ids as current without warning');
}

{
  const warnings = [];
  const store = {
    get(id) {
      if (id === 'm1') return { id: 'm1' };
      if (id === 'm2') return { id: 'm2' };
      return null;
    },
    list() {
      return [{ id: 'm1' }, { id: 'm2' }];
    },
  };
  const result = resolveMomentReplyEventTarget({
    eventMomentId: 'm2',
    currentMomentId: 'm1',
    forceCurrentMomentId: true,
    momentsStore: store,
    logger: { warn: (...args) => warnings.push(args) },
    incomingCount: 2,
  });
  assert.equal(result.momentId, 'm1');
  assert.equal(result.targetMoment?.id, 'm1');
  assert.equal(warnings.length, 0);
  console.log('ok - resolveMomentReplyEventTarget can force single-target replies back to current moment');
}

{
  const contactsStore = {
    getContact(id) {
      if (id === 'contact:1') return { id: 'contact:1', name: '甲' };
      return null;
    },
    listContacts() {
      return [{ id: 'contact:1', name: '甲' }, { id: 'contact:2', name: '乙' }];
    },
  };
  assert.equal(
    resolvePrivateChatTargetSessionIdByName('甲', {
      contactsStore,
      normalizeName: (value) => String(value || '').trim(),
    }),
    'contact:1',
  );
  assert.equal(
    resolvePrivateChatTargetSessionIdByName('missing', {
      contactsStore,
      normalizeName: (value) => String(value || '').trim(),
      fallbackSessionId: 'fallback',
    }),
    'fallback',
  );
  console.log('ok - resolvePrivateChatTargetSessionIdByName resolves display names and supports fallback session ids');
}

{
  const messages = buildMomentPrivateChatMessages(
    [
      { speaker: '我', content: '你好', time: '10:00' },
      { speaker: '发布者', content: '回复', time: '10:01' },
    ],
    {
      timeMode: 'ai',
      getActiveUserName: () => '我',
      normalizeName: (value) => String(value || '').trim(),
      normalizeLooseName: (value) => String(value || '').trim(),
      parseSpecialMessage: (content) => ({ type: 'text', content, meta: {} }),
      userAvatar: 'user.png',
      assistantAvatar: 'assistant.png',
      formatNowTime: () => 'NOW',
    },
  );
  for (const item of messages) assert.equal(item.message.meta.chatTime.source, 'ai');
  assert.deepEqual(messages.map(item => {
    const { chatTime, ...meta } = item.message.meta;
    return { ...item, message: { ...item.message, meta } };
  }), [
    {
      role: 'user',
      message: {
        role: 'user',
        type: 'text',
        content: '你好',
        meta: { generatedByAssistant: true },
        name: '我',
        avatar: 'user.png',
        time: '10:00',
      },
    },
    {
      role: 'assistant',
      message: {
        role: 'assistant',
        type: 'text',
        content: '回复',
        meta: {},
        name: '助手',
        avatar: 'assistant.png',
        time: '10:01',
      },
    },
  ]);
  console.log('ok - buildMomentPrivateChatMessages normalizes private chat payloads for chat store append');
}

{
  assert.equal(
    extractMomentSummaryText('<details><summary>摘要</summary> Hello <b>世界</b> ABC </details>'),
    '世界',
  );
  console.log('ok - extractMomentSummaryText strips html and latin text from summary block');
}

{
  assert.equal(
    sanitizeThinkingForMomentReply('<thinking>x</thinking>正文'),
    '正文',
  );
  assert.equal(
    extractMomentReplySegments('a moment_reply_start 1 moment_reply_end b moment_reply_start 2 moment_reply_end'),
    'moment_reply_start 1 moment_reply_end\nmoment_reply_start 2 moment_reply_end',
  );
  console.log('ok - moment reply retry helpers strip thinking and extract tagged segments');
}

{
  const parser = new DialogueStreamParser({ userName: '我' });
  const events = parser.push([
    'moment_reply_start',
    '甲--公开评论',
    'moment_reply_end',
    '',
    '<群聊：港区>',
    '甲--全角冒号群聊消息',
    '乙--收到',
    '</群聊：港区>',
  ].join('\n'));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'moment_reply');
  assert.equal(events[1].type, 'group_chat');
  assert.equal(events[1].groupName, '港区');
  assert.deepEqual(events[1].messages.map(item => [item.speaker, item.content]), [
    ['甲', '全角冒号群聊消息'],
    ['乙', '收到'],
  ]);
  console.log('ok - DialogueStreamParser parses full-width colon group chat tags after moment replies');
}

{
  const calls = [];
  const updated = [];
  const summary = await applyMomentSummaryFromRaw('<details><summary>摘要</summary> 人物关系 </details>', {
    addSummary: async (value) => calls.push(['add', value]),
    runCompaction: async () => calls.push(['compact']),
    notifyUpdated: async () => updated.push('updated'),
  });
  assert.equal(summary, '人物关系');
  assert.deepEqual(calls, [
    ['add', '人物关系'],
    ['compact'],
  ]);
  assert.deepEqual(updated, ['updated']);
  console.log('ok - applyMomentSummaryFromRaw persists summary and triggers follow-up notifications');
}

{
  const parsed = [];
  const ok = await runMomentReplyRetry('<thinking>xx</thinking>a moment_reply_start hi moment_reply_end', {
    parseText: async (text) => {
      parsed.push(text);
      return text.includes('moment_reply_start');
    },
    logger: { debug: () => {} },
  });
  assert.equal(ok, true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0], 'a moment_reply_start hi moment_reply_end');
  console.log('ok - runMomentReplyRetry retries with stripped thinking before extracting tagged reply segments');
}

{
  const pushed = [];
  const saved = [];
  async function* streamSource() {
    yield { content: 'first' };
    yield { content: 'second' };
  }
  const result = await runMomentCommentGeneration('评论', { task: 1 }, {
    stream: true,
    generate: async () => streamSource(),
    createParser: () => ({
      push(text) {
        pushed.push(text);
        return [{ text }];
      },
    }),
    normalizeChunk: (chunk) => chunk,
    applyEvents: (events) => ({ touchedMoments: events.some((event) => event.text === 'second') }),
    saveRaw: async (raw) => saved.push(raw),
  });
  assert.equal(result.fullRaw, 'firstsecond');
  assert.equal(result.sawMomentReply, true);
  assert.equal(result.retryRecovered, false);
  assert.deepEqual(pushed, ['first', 'second']);
  assert.deepEqual(saved, ['firstsecond']);
  console.log('ok - runMomentCommentGeneration streams chunks through parser and saves aggregated raw reply');
}

{
  const parsed = [];
  let retried = false;
  const result = await runMomentCommentGeneration('评论', { task: 1 }, {
    stream: false,
    generate: async () => 'RAW',
    createParser: () => ({
      push(text) {
        parsed.push(text);
        return [{ text }];
      },
    }),
    normalizeChunk: (chunk) => chunk,
    applyEvents: (events) => ({ touchedMoments: events.some((event) => event.text === 'RETRY') }),
    retryUnhandledReply: async (raw, parseText) => {
      retried = raw === 'RAW';
      return parseText('RETRY');
    },
  });
  assert.equal(result.fullRaw, 'RAW');
  assert.equal(result.sawMomentReply, true);
  assert.equal(result.retryRecovered, true);
  assert.equal(retried, true);
  assert.deepEqual(parsed, ['RAW', 'RETRY']);
  console.log('ok - runMomentCommentGeneration retries with a fresh parser when initial parse misses moment replies');
}

{
  const traces = [];
  const warnings = [];
  const runtime = createMomentCommentLifecycleRuntime({
    getIsConfigured: () => false,
    isOnline: () => true,
    showMissingConfig: () => warnings.push('config'),
    recordLifecycleEvent: event => traces.push(event),
  });
  const result = await runtime('m1', '评论');
  assert.deepEqual(result, { ok: false, reason: 'not-configured' });
  assert.equal(warnings[0], 'config');
  assert.deepEqual(traces.map(event => [event.phase, event.status, event.details.reason]), [
    ['comment.skipped', 'skipped', 'not-configured'],
  ]);
  console.log('ok - createMomentCommentLifecycleRuntime gates unconfigured comment generation before side effects');
}

{
  const warnings = [];
  const runtime = createMomentCommentLifecycleRuntime({
    getIsConfigured: () => false,
    isOnline: () => true,
    showMissingConfig: () => warnings.push('config'),
  });
  const result = await runtime('m1', '', {
    mode: 'moment_publish',
    publishedMoment: true,
    suppressMissingConfigUi: true,
  });
  assert.deepEqual(result, { ok: false, reason: 'not-configured' });
  assert.deepEqual(warnings, [], '后台女仆发布路径不得弹出主 API 配置面板');

  const appSource = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const maidPublishStart = appSource.indexOf('registerMomentsAgentTools(agentToolRegistry');
  const maidPublishEnd = appSource.indexOf('const momentSummaryPanel', maidPublishStart);
  const maidPublishSource = appSource.slice(maidPublishStart, maidPublishEnd);
  assert.match(maidPublishSource, /suppressMissingConfigUi:\s*true/,
    '女仆发布评论请求应显式抑制缺配置 UI 副作用');
  assert.match(maidPublishSource, /momentCommentRuntime[\s\S]*?\.then\(\(result\)[\s\S]*?result\?\.ok[\s\S]*?generation skipped/,
    '女仆发布路径必须消费 { ok:false, reason } 并记录跳过原因');
  console.log('ok - 女仆动态评论失败仅记日志且不弹配置面板');
}

{
  const rawReply = [
    'moment_reply_start',
    'moment_id:: m1',
    'Alice--收到',
    'moment_reply_end',
    '<details><summary>摘要</summary> 关系升温 </details>',
  ].join('\n');
  const traces = [];
  const comments = [];
  const chats = [];
  const rawSaves = [];
  const summaries = [];
  const touched = [];
  const bumps = [];
  const runtime = createMomentCommentLifecycleRuntime({
    getIsConfigured: () => true,
    isOnline: () => true,
    getConfig: () => ({ stream: false }),
    getMoment: id => (id === 'm1'
      ? {
          id: 'm1',
          author: 'Alice',
          content: '今天出门',
          time: '10:00',
          originSessionId: 'contact:alice',
          comments: [{ id: 'c1', author: 'Bob', content: '早安' }],
        }
      : null),
    getCurrentSessionId: () => 'contact:current',
    getContactCount: () => 3,
    getActiveUserProfile: () => ({ name: '我', description: '设定' }),
    getActiveUserName: () => '我',
    contactsStore: {
      listContacts: () => [{ id: 'contact:alice', name: 'Alice' }],
      getContact: id => (id === 'contact:alice' ? { id, name: 'Alice' } : null),
    },
    momentsStore: {
      get: id => (id === 'm1' ? { id } : null),
      list: () => [{ id: 'm1' }],
    },
    normalizeName: value => String(value || '').trim(),
    normalizeLooseName: value => String(value || '').trim(),
    normalizeStickerTextForPrompt: value => String(value || '').trim(),
    normalizeMomentComments: value => value,
    addMomentComments: (momentId, nextComments) => {
      comments.push({ momentId, comments: nextComments });
      return { id: momentId };
    },
    bumpMomentEngagement: (momentId, count) => bumps.push([momentId, count]),
    resolvePrivateChatTargetSessionId: name => (
      name === 'Alice' ? 'contact:alice' : name === 'Bob' ? 'contact:bob' : ''
    ),
    parseSpecialMessage: content => ({ type: 'text', content, meta: {} }),
    userAvatar: 'user.png',
    resolveAssistantAvatar: () => 'alice.png',
    formatNowTime: () => 'NOW',
    appendPrivateChatMessage: (message, targetSessionId) => {
      chats.push({ targetSessionId, message });
      return { ...message, id: `chat-${chats.length}` };
    },
    autoMarkReadIfActive: () => {},
    onTouchedChats: () => touched.push('chats'),
    onTouchedMoments: () => touched.push('moments'),
    generate: async (comment, context) => {
      assert.equal(comment, '评论');
      assert.equal(context.task.targetSessionId, 'contact:bob');
      assert.match(context.task.promptData, /今天出门/);
      return rawReply;
    },
    createParser: () => ({
      push: () => [
        { type: 'moment_reply', momentId: 'm1', comments: [{ author: 'Bob', content: '收到' }] },
        { type: 'private_chat', otherName: 'Alice', messages: [{ speaker: 'Alice', content: '私聊' }] },
      ],
    }),
    saveRawReply: async (raw, metadata) => rawSaves.push({ raw, metadata }),
    flushMoments: async () => touched.push('flush'),
    addSummary: async summary => summaries.push(['summary', summary]),
    runSummaryCompaction: async () => summaries.push(['compact']),
    notifySummariesUpdated: async () => summaries.push(['updated']),
    recordLifecycleEvent: event => traces.push(event),
    logger: { warn: () => {}, error: () => {} },
  });

  const result = await runtime('m1', ' 评论 ', {
    userCommentId: 'user-comment-1',
    replyTo: { id: 'c1', author: 'Bob', content: '早安' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.fullRaw, rawReply);
  assert.equal(result.summary, '关系升温');
  assert.deepEqual(traces.map(event => [event.phase, event.status]), [
    ['comment.start', 'started'],
    ['comment.finish', 'success'],
  ]);
  assert.deepEqual(comments[0], {
    momentId: 'm1',
    comments: [{ author: 'Bob', content: '收到', replyTo: 'c1', replyToAuthor: 'Bob' }],
  });
  assert.equal(chats[0].targetSessionId, 'contact:alice');
  assert.equal(chats[0].message.content, '私聊');
  assert.deepEqual(rawSaves[0].metadata, {
    momentId: 'm1',
    author: 'Alice',
    time: '10:00',
    comment: '评论',
  });
  assert.deepEqual(summaries, [
    ['summary', '关系升温'],
    ['compact'],
    ['updated'],
  ]);
  assert.deepEqual(touched, ['chats', 'moments', 'flush']);
  assert.deepEqual(bumps, [['m1', 3], ['m1', 3]]);
  console.log('ok - createMomentCommentLifecycleRuntime orchestrates comment generation events raw save and summary');
}

{
  const rawReply = [
    'moment_reply_start',
    'moment_id:: m2',
    'Alice--看起来不错',
    'moment_reply_end',
  ].join('\n');
  const comments = [];
  const rawSaves = [];
  const memoryCalls = [];
  const runtime = createMomentCommentLifecycleRuntime({
    getIsConfigured: () => true,
    isOnline: () => true,
    getConfig: () => ({ stream: false }),
    getMoment: id => (id === 'm2'
      ? {
          id: 'm2',
          author: '我',
          content: '今天晴朗\n[img-/tmp/hidden-prompt.png]\n[bqb-attachment_moments_generated_images_hidden.png]]',
          time: '12:00',
          originSessionId: 'user:1',
          generatedImages: [{ output: { dataUrl: 'data:image/png;base64,AAA' } }],
          comments: [],
        }
      : null),
    getCurrentSessionId: () => 'user:1',
    getContactCount: () => 2,
    getActiveUserProfile: () => ({ name: '我' }),
    getActiveUserName: () => '我',
    contactsStore: {
      listContacts: () => [
        { id: 'user:1', name: '我' },
        { id: 'contact:alice', name: 'Alice' },
        { id: 'contact:bob', name: 'Bob' },
        { id: 'group:morning', name: '早安群', isGroup: true, members: ['contact:alice', 'contact:bob'] },
      ],
      getContact: id => ({
        'contact:alice': { id: 'contact:alice', name: 'Alice' },
        'contact:bob': { id: 'contact:bob', name: 'Bob' },
      }[id] || null),
    },
    momentsStore: {
      get: id => (id === 'm2' ? { id } : null),
      list: () => [{ id: 'm2' }],
    },
    normalizeName: value => String(value || '').trim(),
    normalizeLooseName: value => String(value || '').trim(),
    normalizeStickerTextForPrompt: value => String(value || '').trim(),
    normalizeMomentComments: value => value,
    addMomentComments: (momentId, nextComments) => {
      comments.push({ momentId, comments: nextComments });
      return { id: momentId };
    },
    generate: async (input, context) => {
      assert.equal(input, '今天晴朗');
      assert.equal(context.task.mode, 'published_moment');
      assert.equal(context.task.targetName, 'Alice');
      assert.match(context.task.promptData, /QQ空间动态发布后评论/);
      assert.doesNotMatch(context.task.promptData, /moment_id/);
      assert.match(context.task.promptData, /【用户发布动态】/);
      assert.match(context.task.promptData, /动态内容: 今天晴朗/);
      assert.doesNotMatch(context.task.promptData, /本轮没有用户评论或楼中楼回复目标/);
      assert.doesNotMatch(context.task.promptData, /reply_to/);
      assert.doesNotMatch(context.task.promptData, /\[img-/);
      assert.doesNotMatch(context.task.promptData, /bqb-attachment/);
      assert.match(context.task.promptData, /【可选联动】/);
      assert.match(context.task.promptData, /【可用群聊】/);
      assert.match(context.task.promptData, /- 早安群（成员：Alice、Bob）/);
      assert.deepEqual(context.meta?.userAttachmentParts, [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ]);
      assert.equal(context.meta?.memoryStorageMode, 'table');
      assert.equal(context.meta?.memoryAutoExtract, true);
      assert.equal(context.meta?.memoryContextType, 'global');
      assert.equal(context.meta?.memorySessionId, 'moments');
      assert.equal(context.meta?.memoryInjectPosition, 'history_depth');
      assert.equal(context.meta?.memoryInjectDepth, 1);
      assert.equal(context.meta?.skipScripts, true);
      assert.doesNotMatch(context.task.promptData, /- 我/);
      return rawReply;
    },
    createParser: () => ({
      push: () => [
        { type: 'moment_reply', momentId: 'm2', comments: [{ author: 'Alice', content: '看起来不错' }] },
      ],
    }),
    saveRawReply: async (raw, metadata) => rawSaves.push({ raw, metadata }),
    buildPublishedMomentAttachmentParts: moment => buildMomentImageAttachmentParts(moment),
    getMemoryStorageMode: place => (place === 'moments' ? 'table' : 'off'),
    isMemoryAutoExtractInline: place => place === 'moments',
    getMemoryRuntimeConfig: () => ({
      memoryInjectPosition: 'history_depth',
      memoryInjectDepth: 1,
    }),
    handleMemoryEditsFromRaw: async (raw, options) => memoryCalls.push({ raw, options }),
    flushMoments: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });

  const result = await runtime('m2', '', {
    mode: 'moment_publish',
    publishedMoment: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(comments[0], {
    momentId: 'm2',
    comments: [{ author: 'Alice', content: '看起来不错' }],
  });
  assert.deepEqual(rawSaves[0].metadata, {
    momentId: 'm2',
    author: '我',
    time: '12:00',
    comment: '用户发布动态',
    mode: 'published_moment',
  });
  assert.deepEqual(memoryCalls, [{
    raw: rawReply,
    options: {
      sessionId: 'moments',
      isGroup: false,
      contextType: 'global',
      uiMode: 'moments',
      memoryPlace: 'moments',
      useSharedGlobalScope: true,
    },
  }]);
  console.log('ok - createMomentCommentLifecycleRuntime handles published moment comment generation without user comment text');
}

{
  const events = [];
  const trace = [];
  const store = {
    summaries: [{ text: '旧1', at: 1 }, { text: '旧2', at: 2 }, { text: '新3', at: 3 }],
    raw: '',
    compacted: null,
    getSummaries() { return this.summaries; },
    setSummaries(next) { this.summaries = next; },
    getCompactedSummary() { return { text: '已有大总结' }; },
    setCompactedSummaryRaw(raw) { this.raw = raw; },
    setCompactedSummary(text, meta) { this.compacted = { text, meta }; },
  };
  const runtime = createMomentSummaryCompactionRuntime({
    momentSummaryStore: store,
    getIsConfigured: () => true,
    buildMessages: () => ['built'],
    backgroundChat: async () => '<summary>【关键事件】\n• 事件: 描述</summary>',
    getActiveUserProfile: () => ({ name: '我' }),
    buildContext: ({ sessionId, characterName }) => ({ sessionId, characterName }),
    requestCompactionRaw: async ({ items, compactedText, context }) => {
      events.push({ items, compactedText, context });
      return '<summary>【关键事件】\n• 事件: 描述</summary>';
    },
    parseCompactionResult: (raw) => ({ text: '【关键事件】\n• 事件: 描述', valid: raw.includes('<summary>') }),
    normalizeItems: (items) => items,
    shouldCompact: ({ items }) => items.length >= 3,
    dispatchUpdated: () => events.push({ updated: true }),
    recordTraceEvent: event => trace.push(event),
    setTimeoutFn: (fn) => { Promise.resolve().then(fn); return 1; },
    delayMs: 0,
  });
  const ok = await runtime();
  assert.equal(ok, true);
  assert.equal(store.raw.includes('<summary>'), true);
  assert.equal(store.compacted?.text, '【关键事件】\n• 事件: 描述');
  assert.deepEqual(store.summaries, [{ text: '旧2', at: 2 }, { text: '新3', at: 3 }]);
  assert.equal(events[0].compactedText, '已有大总结');
  assert.deepEqual(events[0].context, { sessionId: 'moment_summary_global', characterName: '动态' });
  assert.deepEqual(events[1], { updated: true });
  assert.deepEqual(
    trace.map(event => [event.phase, event.status, event.details.itemCount]),
    [
      ['summary.compaction.start', 'started', 3],
      ['summary.compaction.finish', 'success', 3],
    ],
  );
  console.log('ok - createMomentSummaryCompactionRuntime compacts summaries and keeps recent snapshots');
}

{
  const appended = [];
  const momentComments = [];
  let rendered = 0;
  let refreshed = 0;
  const result = applyMomentCommentEvents(
    [
      { type: 'moments', moments: [{ id: 'm2', views: 1, likes: 1 }] },
      { type: 'moment_reply', momentId: 'm2', comments: [{ author: '甲', content: '回复' }] },
      { type: 'private_chat', otherName: '小王', messages: [{ speaker: '小王', content: '私聊' }] },
      { type: 'group_chat', groupName: '群', messages: [{ speaker: '小王', content: '群聊' }] },
    ],
    {
      currentMomentId: 'm1',
      originSessionId: 'contact:1',
      engagementCount: 5,
      momentsStore: {
        get(id) { return id === 'm1' ? { id: 'm1' } : null; },
        list() { return [{ id: 'm1' }]; },
      },
      normalizeInitialMomentStats: (stats) => ({ views: stats.views + 1, likes: stats.likes + 1 }),
      normalizeMomentRecord: (moment) => moment,
      normalizeMomentComments: (comments) => comments,
      addMoments: (list) => appended.push({ kind: 'moments', list }),
      addMomentComments: (momentId, comments) => {
        momentComments.push({ momentId, comments });
        return { id: momentId };
      },
      forceCurrentMomentId: true,
      isReplyToComment: true,
      replyTo: { id: 'c1', author: '甲' },
      targetName: '发布者',
      resolvePrivateChatTargetSessionId: (name) => (name === '小王' ? 'contact:2' : ''),
      buildPrivateChatMessages: (messages) => messages.map(() => ({
        role: 'assistant',
        message: { role: 'assistant', type: 'text', content: '私聊' },
      })),
      appendPrivateChatMessage: (message, sid) => {
        appended.push({ kind: 'chat', sid, message });
        return { ...message, id: 'msg1' };
      },
      resolveGroupChatTargetSessionId: (name) => (name === '群' ? 'group:1' : ''),
      buildGroupChatMessages: (messages, targetSessionId) => buildMomentGroupChatMessages(messages, {
        getActiveUserName: () => '我',
        resolveGroupSpeakerContact: speaker => ({ id: `contact:${speaker}`, name: speaker }),
        resolveGroupSpeakerAvatar: speaker => `avatar:${speaker}`,
        parseSpecialMessage: content => ({ type: 'text', content, meta: {} }),
        targetSessionId,
      }),
      appendGroupChatMessage: (message, sid) => {
        appended.push({ kind: 'group-chat', sid, message });
        return { ...message, id: 'msg2' };
      },
      autoMarkReadIfActive: () => {},
      bumpMomentEngagement: () => {},
      onTouchedChats: () => { refreshed += 1; },
      onTouchedMoments: () => { rendered += 1; },
    },
  );
  assert.equal(result.touchedChats, true);
  assert.equal(result.touchedMoments, true);
  assert.equal(rendered, 1);
  assert.equal(refreshed, 1);
  assert.equal(appended[0].kind, 'moments');
  assert.equal(momentComments[0].momentId, 'm1');
  assert.equal(appended[1].sid, 'contact:2');
  assert.equal(appended[2].sid, 'group:1');
  assert.equal(appended[2].message.name, '小王');
  assert.equal(appended[2].message.showName, true);
  console.log('ok - applyMomentCommentEvents dispatches moment, reply, private chat, and group chat mutations');
}

{
  const appended = [];
  const result = applyMomentCommentEvents(
    [
      { type: 'private_chat', otherName: '小王', messages: [{ speaker: '小王', content: '私聊' }] },
      { type: 'group_chat', groupName: '群', messages: [{ speaker: '小王', content: '群聊' }] },
    ],
    {
      resolvePrivateChatTargetSessionId: () => 'contact:2',
      buildPrivateChatMessages: (messages) => messages.map(() => ({
        role: 'assistant',
        message: { role: 'assistant', type: 'text', content: '私聊' },
      })),
      appendPrivateChatMessage: (message, sid) => appended.push({ sid, message }),
      resolveGroupChatTargetSessionId: () => 'group:1',
      buildGroupChatMessages: (messages) => messages.map(() => ({
        role: 'assistant',
        message: { role: 'assistant', type: 'text', content: '群聊' },
      })),
      appendGroupChatMessage: (message, sid) => appended.push({ sid, message }),
      allowSideEffects: false,
    },
  );
  assert.equal(result.touchedChats, false);
  assert.deepEqual(appended, []);
  console.log('ok - applyMomentCommentEvents respects side-effect setting for private and group chat');
}
