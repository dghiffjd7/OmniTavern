import assert from 'node:assert/strict';

import {
  CHAT_FORMAT_GUARDIAN_TARGETS,
  CHAT_FORMAT_EVENT_TYPES,
  buildChatFormatGuardianModelPrompt,
  extractChatFormatEventDrafts,
  normalizeChatFormatGuardianModelReview,
  resolveChatFormatGuardianFormatProfile,
  validateChatFormatEventDraft,
} from '../../src/scripts/ui/chat/chat-format-guardian-utils.js';

{
  const result = extractChatFormatEventDrafts([
    'MiPhone_start',
    'msg_start',
    '<我和菲伦的私聊>',
    '菲伦--今晚别一个人走。--22:10',
    '</我和菲伦的私聊>',
    'msg_end',
    'MiPhone_end',
  ].join('\n'), {
    userName: '我',
    sourceMessageId: 'assistant-1',
    resolvePrivateTargetId: name => (name === '菲伦' ? 'contact:firen' : ''),
    resolveSpeakerId: name => (name === '菲伦' ? 'contact:firen' : ''),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.eventDrafts.length, 1);
  assert.equal(result.eventDrafts[0].type, CHAT_FORMAT_EVENT_TYPES.privateMessage);
  assert.equal(result.eventDrafts[0].targetId, 'contact:firen');
  assert.equal(result.eventDrafts[0].speakerName, '菲伦');
  assert.equal(result.eventDrafts[0].content, '今晚别一个人走。');
  assert.equal(result.eventDrafts[0].sourceMessageId, 'assistant-1');
  console.log('ok - chat format guardian extracts private chat event drafts');
}

{
  const result = extractChatFormatEventDrafts([
    'MiPhone_start',
    '<我和菲伦的私聊>',
    '菲伦--今晚别一个人走。--22:12',
    '</我和菲伦的私聊>',
    'MiPhone_end',
  ].join('\n'), {
    userName: '我',
    enabledFormats: { phoneShell: true, privateChat: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.eventDrafts.length, 1);
  assert.match(result.warnings.join('\n'), /msg_start/);
  assert.match(result.warnings.join('\n'), /msg_end/);
  console.log('ok - chat format guardian reports missing phone shell markers');
}

{
  const result = extractChatFormatEventDrafts([
    '<群聊:调查组>',
    '<成员>我,菲伦,雪</成员>',
    '<聊天内容>',
    '系统消息: 菲伦加入了群聊',
    '雪--我看到了门口的鞋印。--22:11',
    '</聊天内容>',
    '</群聊:调查组>',
  ].join('\n'), {
    resolveGroupTargetId: name => (name === '调查组' ? 'group:case' : ''),
    resolveSpeakerId: name => (name === '雪' ? 'contact:snow' : ''),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.eventDrafts.length, 2);
  assert.equal(result.eventDrafts[0].type, CHAT_FORMAT_EVENT_TYPES.groupSystemEvent);
  assert.equal(result.eventDrafts[1].type, CHAT_FORMAT_EVENT_TYPES.groupMessage);
  assert.equal(result.eventDrafts[1].targetId, 'group:case');
  assert.equal(result.eventDrafts[1].speakerId, 'contact:snow');
  assert.equal(result.warnings.includes('time is missing'), false);
  console.log('ok - chat format guardian extracts group message and system event drafts');
}

{
  const result = extractChatFormatEventDrafts([
    'moment_reply_start',
    'moment_id:: moment-1',
    '菲伦--我会在楼下等你--reply_to:: comment-1--reply_to_author:: 雪',
    'moment_reply_end',
  ].join('\n'));

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.eventDrafts.length, 1);
  assert.equal(result.eventDrafts[0].type, CHAT_FORMAT_EVENT_TYPES.momentComment);
  assert.equal(result.eventDrafts[0].surface, 'moments');
  assert.equal(result.eventDrafts[0].targetId, 'moment-1');
  assert.equal(result.eventDrafts[0].metadata.replyTo, 'comment-1');
  console.log('ok - chat format guardian extracts moment reply drafts');
}

{
  const result = extractChatFormatEventDrafts('普通正文，没有手机协议');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'no_events');
  assert.equal(result.eventDrafts.length, 0);
  assert.equal(result.summary, 'no chat format events detected');
  console.log('ok - chat format guardian reports no_events without writing');
}

{
  const base = [
    'MiPhone_start',
    'msg_start',
    '<我和菲伦的私聊>',
    '菲伦--今晚别一个人走。--22:10',
    '</我和菲伦的私聊>',
    'msg_end',
    'MiPhone_end',
  ];
  const options = {
    userName: '我',
    enabledFormats: { phoneShell: true, privateChat: true },
    resolvePrivateTargetId: () => 'contact:firen',
    resolveSpeakerId: () => 'contact:firen',
  };
  const valid = extractChatFormatEventDrafts(base.join('\n'), options);
  const wrongPostamble = extractChatFormatEventDrafts([
    ...base.slice(0, -1),
    '<UpdateVariable>',
    '_.set("mood", "calm")',
    '</UpdateVariable>',
    base.at(-1),
  ].join('\n'), options);
  assert.equal(valid.status, 'ready');
  assert.equal(valid.contractValidation.valid, true);
  assert.equal(wrongPostamble.status, 'needs_review');
  assert.equal(wrongPostamble.contractValidation.valid, false);
  assert.ok(wrongPostamble.warnings.includes('built-in contract violation: function_block.invalid_position'));

  const custom = extractChatFormatEventDrafts([
    ...base,
    '<custom_status>mood=calm</custom_status>',
  ].join('\n'), {
    ...options,
    customFormatGuide: '<custom_status>...</custom_status>',
  });
  assert.equal(custom.status, 'ready');
  assert.equal(custom.contractValidation, null);
  console.log('ok - chat format guardian applies strict built-in validation without overriding custom guides');
}

{
  const enabledFormats = {
    phoneShell: true,
    privateChat: true,
    groupChat: true,
    momentComment: true,
    momentPost: true,
    tableEdit: true,
    imagePrompt: true,
    variableUpdate: true,
  };
  const groupProfile = resolveChatFormatGuardianFormatProfile({
    target: CHAT_FORMAT_GUARDIAN_TARGETS.groupChat,
    enabledFormats,
  });
  assert.equal(groupProfile.target, CHAT_FORMAT_GUARDIAN_TARGETS.groupChat);
  assert.deepEqual(groupProfile.enabledFormatIds, ['phoneShell', 'groupChat']);

  const imageProfile = resolveChatFormatGuardianFormatProfile({
    assistantText: '<image_prompt>\n雨夜街道\n</image_prompt>',
    enabledFormats,
  });
  assert.equal(imageProfile.target, CHAT_FORMAT_GUARDIAN_TARGETS.privateChat);
  assert.deepEqual(imageProfile.enabledFormatIds, ['phoneShell', 'privateChat', 'imagePrompt']);

  const memoryProfile = resolveChatFormatGuardianFormatProfile({
    assistantText: '<tableEdit>\nupdate memory\n</tableEdit>',
    enabledFormats,
  });
  assert.equal(memoryProfile.target, CHAT_FORMAT_GUARDIAN_TARGETS.privateChat);
  assert.deepEqual(memoryProfile.enabledFormatIds, ['phoneShell', 'privateChat', 'tableEdit']);

  const creativeProfile = resolveChatFormatGuardianFormatProfile({
    uiMode: 'rp',
    surface: 'creative',
    assistantText: '<tableEdit>\nupdate memory\n</tableEdit>\n<UpdateVariable>\nhp=2\n</UpdateVariable>',
    enabledFormats,
  });
  assert.equal(creativeProfile.target, CHAT_FORMAT_GUARDIAN_TARGETS.creativeText);
  assert.deepEqual(creativeProfile.enabledFormatIds, ['tableEdit', 'variableUpdate']);
  console.log('ok - chat format guardian keeps the scene primary format and appends only related function blocks');
}

{
  const validation = validateChatFormatEventDraft({
    type: 'private_message',
    surface: 'chat',
    content: '',
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.severity, 'error');
  assert.equal(validation.errors.includes('content is required'), true);
  assert.equal(validation.warnings.includes('target is unresolved'), true);
  console.log('ok - chat format guardian validates missing required draft fields');
}

{
  const prompt = buildChatFormatGuardianModelPrompt({
    assistantText: '<我和菲伦的私聊>\n菲伦--今晚别一个人走。\n</我和菲伦的私聊>',
    formatReminderText: '以下为格式输出顺序，请严格遵守\nMiPhone_start\nmsg_start\nmsg_end\nMiPhone_end',
    enabledFormats: {
      phoneShell: true,
      privateChat: true,
      groupChat: false,
      momentComment: false,
      tableEdit: false,
      imagePrompt: false,
    },
    parserReport: {
      status: 'needs_review',
      warnings: ['time is missing'],
      eventDrafts: [{
        type: CHAT_FORMAT_EVENT_TYPES.privateMessage,
        surface: 'chat',
        targetName: '菲伦',
        speakerName: '菲伦',
        content: '今晚别一个人走。',
        warnings: ['time is missing'],
      }],
    },
    userName: '我',
    sessionLabel: '菲伦私聊',
    baseRevision: 'format-run:prompt-test',
  });

  const system = prompt.messages[0].content;
  const user = prompt.messages[1].content;
  assert.equal(prompt.responseFormat, 'json_object');
  assert.deepEqual(prompt.enabledFormatIds, ['phoneShell', 'privateChat']);
  assert.match(system, /格式修复 Agent/);
  assert.match(system, /不得改写正文语义/);
  assert.match(system, /禁止 Markdown 代码块/);
  assert.match(system, /JSON 字符串字段内部不要使用英文双引号/);
  assert.match(system, /truncated_response/);
  assert.match(system, /产物是最小行补丁，不是修复后的完整原文/);
  assert.match(system, /禁止输出 correctedText/);
  assert.match(system, /不要在 MiPhone_end 之后追加额外段落或无关标签/);
  assert.match(system, /本地解析报告可能存在误判或漏判/);
  assert.match(user, /# Task/);
  assert.match(user, /# Required Format Examples/);
  assert.match(user, /# Required Additional Format Rules/);
  assert.match(user, /# Current Invalid Model Output/);
  assert.match(user, /# Output Contract/);
  assert.match(user, /Do not wrap it in Markdown code fences/);
  assert.match(user, /MiPhone_start/);
  assert.match(user, /私聊格式/);
  assert.doesNotMatch(user, /动态评论格式/);
  assert.doesNotMatch(user, /记忆表格写入格式/);
  assert.doesNotMatch(user, /群聊格式/);
  assert.doesNotMatch(user, /图片提示词格式/);
  assert.match(user, /1 \| <我和菲伦的私聊>/);
  assert.match(user, /"linePatches"/);
  assert.match(user, /"originalLines"/);
  assert.match(user, /"protocolVersion": "format_patch\.v1"/);
  assert.match(user, /"baseRevision": "format-run:prompt-test"/);
  assert.match(user, /Never return correctedText/);
  assert.match(user, /Do not place unescaped double quotes/);
  assert.match(user, /<\{\{user\}\}和联系人名的私聊>/);
  assert.match(prompt.messages[0].content, /<\{\{user\}\}和联系人名的私聊>/);
  assert.match(prompt.messages[0].content, /末尾截断/);
  assert.match(user, /time is missing/);
  console.log('ok - chat format guardian model prompt uses only enabled format requirements');
}

{
  const prompt = buildChatFormatGuardianModelPrompt({
    assistantText: '画一张雨夜街道的霓虹灯',
    formatReminderText: '必须使用 <image_prompt> 包裹图片提示词。',
    enabledFormats: {
      phoneShell: false,
      privateChat: false,
      groupChat: false,
      imagePrompt: true,
    },
    parserReport: {
      status: 'no_events',
      summary: 'missing image prompt tag',
      errors: [],
      warnings: [],
      eventDrafts: [],
    },
    formatTarget: CHAT_FORMAT_GUARDIAN_TARGETS.imagePrompt,
  });
  const system = prompt.messages[0].content;
  const user = prompt.messages[1].content;
  assert.deepEqual(prompt.enabledFormatIds, ['imagePrompt']);
  assert.match(user, /formatTarget: image_prompt/);
  assert.match(user, /图片提示词格式/);
  assert.match(user, /<image_prompt>/);
  assert.doesNotMatch(user, /MiPhone_start/);
  assert.doesNotMatch(user, /私聊格式/);
  assert.doesNotMatch(system, /<\{\{user\}\}和联系人名的私聊>/);
  assert.doesNotMatch(system, /MiPhone_end 之后/);
  console.log('ok - chat format guardian image prompt repair omits chat-only requirements');
}

{
  const prompt = buildChatFormatGuardianModelPrompt({
    assistantText: '今天去了海边。',
    enabledFormats: { phoneShell: true, momentPost: true },
    parserReport: { status: 'no_events', eventDrafts: [], errors: [], warnings: [] },
    formatTarget: CHAT_FORMAT_GUARDIAN_TARGETS.momentPost,
    userName: '雪乃',
  });
  assert.deepEqual(prompt.enabledFormatIds, ['phoneShell', 'momentPost']);
  assert.match(prompt.messages[1].content, /雪乃--今天去了海边。--0--0/);
  assert.match(prompt.messages[1].content, /发布者--动态正文--0--0/);
  assert.doesNotMatch(prompt.messages[1].content, /author::|content::/);
  console.log('ok - chat format guardian moment repair uses the parser-compatible shared contract');
}

{
  const prompt = buildChatFormatGuardianModelPrompt({
    assistantText: '',
    enabledFormats: { phoneShell: true, privateChat: true },
    parserReport: {
      status: 'no_events',
      summary: 'empty assistant response',
      errors: [],
      warnings: [],
      eventDrafts: [],
    },
    userName: '我',
    sessionLabel: '菲伦私聊',
  });
  const user = prompt.messages[1].content;
  assert.match(user, /没有发现可提交的完整协议内容/);
  assert.match(user, /status="cannot_repair"/);
  assert.match(user, /建议用户重新生成/);
  assert.match(user, /（空）/);
  console.log('ok - chat format guardian model prompt asks no-events review to suggest regeneration');
}

{
  const prompt = buildChatFormatGuardianModelPrompt({
    assistantText: [
      '菲伦--今晚别一个人走。',
      '菲伦--我送你到门口--22:13',
    ].join('\n'),
    enabledFormats: { phoneShell: true, privateChat: true },
    parserReport: {
      status: 'no_events',
      summary: 'no protocol tags',
      repairFallbackTime: '22:12',
      errors: [],
      warnings: [],
      eventDrafts: [],
    },
    userName: '阿兰',
    sessionLabel: '菲伦',
  });
  const system = prompt.messages[0].content;
  const user = prompt.messages[1].content;
  assert.match(system, /没有任何外层标签/);
  assert.match(system, /优先补齐标签而不是建议重新生成/);
  assert.match(user, /疑似聊天内容/);
  assert.match(user, /可修复的标签缺漏/);
  assert.match(user, /只补齐下方格式范例或格式规则明确要求的标签/);
  assert.match(user, /<阿兰和菲伦的私聊>/);
  assert.match(user, /MiPhone_start \/ msg_start/);
  assert.match(user, /不要生成时间字段/);
  assert.match(user, /1 \| 菲伦--今晚别一个人走。/);
  console.log('ok - chat format guardian model prompt asks loose chat rows to be wrapped');
}

{
  const baseRevision = 'format-run:guardian-wrapper';
  const originalText = [
    '<我和菲伦的私聊>',
    '菲伦--今晚别一个人走。',
    '</我和菲伦的私聊>',
  ].join('\n');
  const review = normalizeChatFormatGuardianModelReview(JSON.stringify({
    protocolVersion: 'format_patch.v1',
    status: 'patch',
    baseRevision,
    issues: [{ severity: 'warning', type: 'missing_field', message: 'time is missing' }],
    repairSummary: '补齐时间字段',
    linePatches: [{
      startLine: 2,
      endLine: 2,
      originalLines: ['菲伦--今晚别一个人走。'],
      replacementLines: ['菲伦--今晚别一个人走。--22:12'],
      reason: '补齐时间',
    }],
  }), {
    originalText,
    baseRevision,
  });
  assert.equal(review.ok, true);
  assert.equal(review.status, 'patch');
  assert.equal(review.canRepair, true);
  assert.equal(review.linePatches.length, 1);
  assert.equal(review.linePatches[0].startLine, 2);
  assert.deepEqual(review.linePatches[0].originalLines, ['菲伦--今晚别一个人走。']);
  assert.equal(review.linePatches[0].originalMatches, true);
  assert.equal(review.candidateText, '<我和菲伦的私聊>\n菲伦--今晚别一个人走。--22:12\n</我和菲伦的私聊>');
  assert.equal(Object.hasOwn(review, 'correctedText'), false);
  console.log('ok - chat format guardian normalizer delegates to patch-only transaction');
}

{
  const review = normalizeChatFormatGuardianModelReview([
    '```json',
    '{"protocolVersion":"format_patch.v1","status":"no_change","baseRevision":"format-run:x","issues":[],"linePatches":[]}',
    '```',
  ].join('\n'), {
    originalText: '原文',
    baseRevision: 'format-run:x',
  });
  assert.equal(review.ok, false);
  assert.equal(review.status, 'invalid_output');
  assert.equal(review.issues[0].type, 'parse_error');
  assert.match(review.rawText, /```json/);
  console.log('ok - chat format guardian refuses loose or fenced model output');
}
