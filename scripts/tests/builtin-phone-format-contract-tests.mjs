import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BUILTIN_PHONE_FORMAT_CONTRACT_VERSION,
  BUILTIN_PHONE_FORMAT_FUNCTION_PLACEMENT,
  BUILTIN_PHONE_FORMAT_SURFACES,
  buildBuiltinPhoneFormatReminder,
  getBuiltinPhoneFormatGuardianSnippet,
  resolveBuiltinPhoneFormatReminderPlan,
  serializeBuiltinPhoneBatch,
  serializeBuiltinPhoneFormat,
  validateBuiltinPhoneFormat,
} from '../../src/scripts/utils/builtin-phone-format-contract.js';
import { DialogueStreamParser } from '../../src/scripts/ui/chat/dialogue-stream-parser.js';

const parse = (raw, userName = '我') => {
  const parser = new DialogueStreamParser({ userName });
  return [...parser.push(raw), ...parser.flush()];
};

{
  assert.equal(BUILTIN_PHONE_FORMAT_CONTRACT_VERSION, 'miphone.text.v1');
  assert.deepEqual(BUILTIN_PHONE_FORMAT_SURFACES, {
    privateChat: 'private_chat',
    groupChat: 'group_chat',
    momentPost: 'moment_post',
    momentComment: 'moment_comment',
  });
  assert.deepEqual(BUILTIN_PHONE_FORMAT_FUNCTION_PLACEMENT, {
    imagePrompt: { region: 'surface_content', order: 0 },
    tableEdit: { region: 'postamble', order: 10, immediatelyAfter: 'MiPhone_end' },
    variableUpdate: { region: 'postamble', order: 20 },
    summary: { region: 'postamble', order: 30 },
  });
  console.log('ok - built-in phone format contract exposes a versioned surface and placement map');
}

{
  const raw = serializeBuiltinPhoneFormat(BUILTIN_PHONE_FORMAT_SURFACES.privateChat, {
    userName: '我',
    targetName: '雪乃',
    messages: [{ speaker: '雪乃', content: '[yy-今晚见]', time: '21:08' }],
  });
  const validation = validateBuiltinPhoneFormat(raw, { surface: 'private_chat' });
  const events = parse(raw);
  assert.equal(validation.valid, true, validation.issues.join(', '));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'private_chat');
  assert.equal(events[0].otherName, '雪乃');
  assert.equal(events[0].messages[0].content, '[yy-今晚见]');
  console.log('ok - private serializer round-trips special messages through the parser');
}

{
  const raw = serializeBuiltinPhoneFormat(BUILTIN_PHONE_FORMAT_SURFACES.groupChat, {
    groupName: '调查组',
    members: ['我', '菲伦', '雪'],
    messages: [{ speaker: '雪', content: '[bqb-收到]', time: '22:11' }],
  });
  const validation = validateBuiltinPhoneFormat(raw, { surface: 'group_chat' });
  const events = parse(raw);
  assert.equal(validation.valid, true, validation.issues.join(', '));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'group_chat');
  assert.equal(events[0].groupName, '调查组');
  assert.deepEqual(events[0].members, ['我', '菲伦', '雪']);
  assert.equal(events[0].messages[0].content, '[bqb-收到]');
  console.log('ok - group serializer round-trips members and special messages through the parser');
}

{
  const raw = serializeBuiltinPhoneFormat(BUILTIN_PHONE_FORMAT_SURFACES.momentPost, {
    posts: [{
      author: '雪乃',
      content: '海边很好看',
      time: '12:30',
      views: 67,
      likes: 32,
      comments: [{ author: '结衣', content: '下次一起去' }],
    }],
  });
  const validation = validateBuiltinPhoneFormat(raw, { surface: 'moment_post' });
  const events = parse(raw);
  assert.equal(validation.valid, true, validation.issues.join(', '));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'moments');
  assert.equal(events[0].moments[0].author, '雪乃');
  assert.equal(events[0].moments[0].content, '海边很好看');
  assert.equal(events[0].moments[0].views, 67);
  assert.equal(events[0].moments[0].comments[0].author, '结衣');
  assert.doesNotMatch(raw, /author::|content::/);
  console.log('ok - moment post serializer matches the parser optional-time row contract');
}

{
  const raw = serializeBuiltinPhoneFormat(BUILTIN_PHONE_FORMAT_SURFACES.momentComment, {
    momentId: 'moment-1',
    comments: [{
      author: '菲伦',
      content: '我会在楼下等你',
      replyTo: 'comment-1',
      replyToAuthor: '雪',
    }],
  });
  const validation = validateBuiltinPhoneFormat(raw, { surface: 'moment_comment' });
  const events = parse(raw);
  assert.equal(validation.valid, true, validation.issues.join(', '));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'moment_reply');
  assert.equal(events[0].momentId, 'moment-1');
  assert.equal(events[0].comments[0].replyTo, 'comment-1');
  assert.equal(events[0].comments[0].replyToAuthor, '雪');
  console.log('ok - moment comment serializer round-trips reply metadata through the parser');
}

{
  const raw = serializeBuiltinPhoneBatch([
    {
      surface: 'group_chat',
      payload: {
        groupName: '调查组',
        members: ['菲伦', '雪'],
        messages: [{ speaker: '菲伦', content: '先确认现场。', time: '08:10' }],
      },
    },
    {
      surface: 'moment_post',
      payload: {
        posts: [{
          author: '雪',
          content: '清晨记录',
          time: '08:11',
          views: 3,
          likes: 1,
          comments: [{ author: '菲伦', content: '收到' }],
        }],
      },
    },
    { kind: 'image_prompt', content: '清晨车站，柔和天光' },
    { kind: 'table_edit', content: '{"action":"insert","table_id":"event","data":{"note":"抵达"}}' },
    { kind: 'variable_update', content: '<json_patch>[{"op":"replace","path":"/mood","value":"calm"}]</json_patch>' },
    { kind: 'summary', content: '调查组抵达清晨车站。' },
  ]);
  const validation = validateBuiltinPhoneFormat(raw, { surface: 'group_chat' });
  const events = parse(raw);
  assert.equal(validation.valid, true, validation.issues.join(', '));
  assert.deepEqual(events.map(event => event.type), ['group_chat', 'moments']);
  assert.deepEqual(validation.detectedSurfaces, ['group_chat', 'moment_post']);
  assert.match(events[0].messages.at(-1).content, /<image_prompt>清晨车站，柔和天光<\/image_prompt>/);
  assert.equal((raw.match(/<image_prompt>/g) || []).length, 1);
  assert.ok(raw.indexOf('<image_prompt>') < raw.indexOf('</群聊:调查组>'));
  assert.ok(raw.indexOf('</群聊:调查组>') < raw.indexOf('moment_start'));
  assert.ok(raw.indexOf('MiPhone_end') < raw.indexOf('<tableEdit>'));
  assert.ok(raw.indexOf('<tableEdit>') < raw.indexOf('<UpdateVariable>'));
  assert.ok(raw.indexOf('<UpdateVariable>') < raw.indexOf('<details><summary>摘要</summary>'));
  console.log('ok - ordered phone batch preserves mixed surface and postamble order');
}

{
  const raw = serializeBuiltinPhoneBatch([
    {
      surface: 'moment_comment',
      payload: {
        momentId: 'moment-2',
        comments: [{ author: '菲伦', content: '我也想去' }],
      },
    },
    {
      surface: 'private_chat',
      payload: {
        userName: '我',
        targetName: '菲伦',
        messages: [{ speaker: '菲伦', content: '晚点私聊。', time: '08:12' }],
      },
    },
  ], { mode: 'moment_comment' });
  const events = parse(raw);
  assert.deepEqual(events.map(event => event.type), ['moment_reply', 'private_chat']);
  assert.equal(events[0].momentId, 'moment-2');
  assert.equal(events[1].otherName, '菲伦');
  assert.doesNotMatch(raw, /MiPhone_start|MiPhone_end/);
  console.log('ok - moment comment batch keeps public reply and chat side effects in one parser stream');
}

{
  const raw = serializeBuiltinPhoneFormat(BUILTIN_PHONE_FORMAT_SURFACES.privateChat, {
    userName: '我',
    targetName: '雪乃',
    messages: [{
      speaker: '雪乃',
      content: '<image_prompt>雪夜车站，银白灯光</image_prompt>',
      time: '21:08',
    }],
    tableEdit: '{"action":"insert","table_id":"event"}',
    variableUpdate: '_.set("mood", "calm")',
    summary: '雪乃约我在雪夜车站见面。',
  });
  const validation = validateBuiltinPhoneFormat(raw, { surface: 'private_chat' });
  assert.equal(validation.valid, true, validation.issues.join(', '));
  assert.ok(raw.indexOf('<image_prompt>') < raw.indexOf('MiPhone_end'));
  assert.ok(raw.indexOf('MiPhone_end') < raw.indexOf('<tableEdit>'));
  assert.ok(raw.indexOf('<tableEdit>') < raw.indexOf('<UpdateVariable>'));
  assert.ok(raw.indexOf('<UpdateVariable>') < raw.indexOf('<details><summary>摘要</summary>'));

  const wrongOrder = raw.replace(
    /(<tableEdit>[\s\S]*?<\/tableEdit>)\n(<UpdateVariable>[\s\S]*?<\/UpdateVariable>)/,
    '$2\n$1',
  );
  const wrongPlacement = raw.replace(
    /MiPhone_end\n(<tableEdit>[\s\S]*?<\/tableEdit>)/,
    '$1\nMiPhone_end',
  );
  assert.equal(validateBuiltinPhoneFormat(wrongOrder, { surface: 'private_chat' }).valid, false);
  assert.ok(validateBuiltinPhoneFormat(wrongOrder, { surface: 'private_chat' }).issues.includes('postamble.wrong_order'));
  assert.equal(validateBuiltinPhoneFormat(wrongPlacement, { surface: 'private_chat' }).valid, false);
  assert.ok(validateBuiltinPhoneFormat(wrongPlacement, { surface: 'private_chat' }).issues.includes('function_block.invalid_position'));
  console.log('ok - validator enforces inline image and ordered postamble placement');
}

{
  const oldGuardianMomentExample = [
    'MiPhone_start',
    'msg_start',
    'moment_start',
    'author:: 雪乃',
    'content:: 海边很好看',
    'moment_end',
    'msg_end',
    'MiPhone_end',
  ].join('\n');
  const result = validateBuiltinPhoneFormat(oldGuardianMomentExample, { surface: 'moment_post' });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes('moment_post.invalid_row'));

  const snippet = getBuiltinPhoneFormatGuardianSnippet('momentPost');
  assert.match(snippet.join('\n'), /发布者--动态正文--0--0/);
  assert.doesNotMatch(snippet.join('\n'), /author::|content::/);
  console.log('ok - validator rejects the stale Guardian moment example and shared snippet is parser-compatible');
}

{
  const reminder = buildBuiltinPhoneFormatReminder({
    surface: 'private_chat',
    userName: '我',
    targetName: '雪乃',
    includeTableEdit: true,
  });
  assert.match(reminder, /内建格式合同/);
  assert.match(reminder, /<我和雪乃的私聊>/);
  assert.match(reminder, /MiPhone_end\n<tableEdit>/);
  assert.equal(validateBuiltinPhoneFormat(
    serializeBuiltinPhoneFormat('private_chat', {
      userName: '我',
      targetName: '雪乃',
      messages: [{ speaker: '雪乃', content: '示例', time: '00:00' }],
    }),
    { surface: 'private_chat' },
  ).valid, true);
  console.log('ok - compact reminder is generated from the same canonical serializer');
}

{
  const common = {
    hasPreset: true,
    surface: 'private_chat',
    scenarioReminder: '正在与雪乃私聊，请遵循私聊格式',
    userName: '我',
    targetName: '雪乃',
  };
  const defaultPlan = resolveBuiltinPhoneFormatReminderPlan({
    ...common,
    isDefaultPreset: true,
  });
  assert.match(defaultPlan.systemText, /MiPhone_start/);
  assert.equal(defaultPlan.userScenarioText, '');
  assert.equal(defaultPlan.usesBuiltinContract, true);

  const customPlan = resolveBuiltinPhoneFormatReminderPlan({
    ...common,
    isDefaultPreset: false,
  });
  assert.equal(customPlan.systemText, '');
  assert.equal(customPlan.userScenarioText, common.scenarioReminder);
  assert.equal(customPlan.usesBuiltinContract, false);

  const disabledPlan = resolveBuiltinPhoneFormatReminderPlan({
    ...common,
    isDefaultPreset: true,
    contractDisabled: true,
  });
  assert.equal(disabledPlan.systemText, '');
  assert.equal(disabledPlan.userScenarioText, '');

  const impersonationPlan = resolveBuiltinPhoneFormatReminderPlan({
    ...common,
    isDefaultPreset: true,
    responseTarget: 'user',
  });
  assert.equal(impersonationPlan.systemText, '');
  assert.equal(impersonationPlan.userScenarioText, '');

  const continuationPlan = resolveBuiltinPhoneFormatReminderPlan({
    ...common,
    isDefaultPreset: true,
    assistantContinuation: true,
    suppressPendingUserTurn: true,
  });
  assert.match(continuationPlan.systemText, /不要重复已经存在的标记/);
  assert.doesNotMatch(continuationPlan.systemText, /MiPhone_start\nmsg_start/);
  assert.equal(continuationPlan.userScenarioText, '');
  assert.equal(continuationPlan.usesBuiltinContract, true);

  const customContinuationPlan = resolveBuiltinPhoneFormatReminderPlan({
    ...common,
    isDefaultPreset: false,
    assistantContinuation: true,
    suppressPendingUserTurn: true,
  });
  assert.equal(customContinuationPlan.systemText, common.scenarioReminder);
  assert.doesNotMatch(customContinuationPlan.systemText, /MiPhone_start/);
  assert.equal(customContinuationPlan.userScenarioText, '');
  console.log('ok - reminder policy respects default custom disabled impersonation and continuation paths');
}

{
  const bridgeSource = await readFile(
    new URL('../../src/scripts/ui/bridge.js', import.meta.url),
    'utf8',
  );
  const appendStart = bridgeSource.indexOf('const appendOutputFormatReminder = () =>');
  const appendEnd = bridgeSource.indexOf('const buildChatGuidePlan = () =>', appendStart);
  const appendBody = bridgeSource.slice(appendStart, appendEnd);
  assert.ok(appendStart > 0 && appendEnd > appendStart);
  assert.match(bridgeSource, /resolveBuiltinPhoneFormatReminderPlan\(\{/);
  assert.match(bridgeSource, /disablePhoneFormat = explicitlyDisablePhoneFormat \|\| isMomentCommentTask \|\| replyTarget === 'user'/);
  assert.match(appendBody, /formatReminderPlan\.systemText/);
  assert.match(bridgeSource, /this\.lastPhoneFormatTransportPlan = \{/);
  assert.match(bridgeSource, /phoneFormatPromptContent:\s*trimEdgeBlankLines\(worldInjectionPlan\?\.phoneFormatPromptContent \|\| ''\)/);
  assert.match(bridgeSource, /outputFormatReminder:\s*String\(formatReminderPlan\.systemText \|\| ''\)/);
  assert.match(bridgeSource, /scenarioReminder:\s*scenarioFormatReminder/);
  assert.match(bridgeSource, /tableTargets:\s*structuredTableTargets/);
  assert.match(bridgeSource, /tableTargets:\s*Array\.isArray\(phoneTransportPlan\.tableTargets\)/);
  assert.match(bridgeSource, /hasUnsupportedBatchSideEffects:\s*includeTableEditInFormatReminder/);
  assert.match(bridgeSource, /const previousLastPhoneFormatTransportPlan = this\.lastPhoneFormatTransportPlan/);
  assert.match(bridgeSource, /this\.lastPhoneFormatTransportPlan = previousLastPhoneFormatTransportPlan/);
  assert.doesNotMatch(bridgeSource, /const buildOutputFormatReminderText = \(\) =>/);
  assert.doesNotMatch(appendBody, /lines\.push\('MiPhone_start'\)/);

  const guardianSource = await readFile(
    new URL('../../src/scripts/ui/chat/chat-format-guardian-utils.js', import.meta.url),
    'utf8',
  );
  assert.match(guardianSource, /getBuiltinPhoneFormatGuardianSnippet\(id, \{ timeMode \}\)/);
  assert.doesNotMatch(guardianSource, /author:: 发布者|content:: 动态正文/);

  const panelSource = await readFile(
    new URL('../../src/scripts/ui/preset-panel.js', import.meta.url),
    'utf8',
  );
  assert.match(panelSource, /buildBuiltinPhoneFormatReminder\(\{/);
  console.log('ok - bridge Guardian and preset preview consume the shared contract instead of local skeletons');
}

{
  const { setPromptLocale } = await import('../../src/scripts/i18n/prompt-locale.js');
  try {
    setPromptLocale('en');
    const plan = resolveBuiltinPhoneFormatReminderPlan({
      hasPreset: true,
      isDefaultPreset: true,
      surface: 'private_chat',
      userName: 'user',
      targetName: 'Lara',
      scenarioReminder: '',
    });
    assert.match(plan.systemText, /The built-in format contract \(miphone\.text\.v1\) follows/);
    assert.match(plan.systemText, /MiPhone_start/, 'protocol skeleton must stay locale-independent');
    const continuation = resolveBuiltinPhoneFormatReminderPlan({
      hasPreset: true,
      isDefaultPreset: true,
      assistantContinuation: true,
      surface: 'private_chat',
      scenarioReminder: '',
    });
    assert.match(continuation.systemText, /Continue the previous unfinished built-in-format reply/);
  } finally {
    setPromptLocale('zh-CN');
  }
  const zhPlan = resolveBuiltinPhoneFormatReminderPlan({
    hasPreset: true,
    isDefaultPreset: true,
    surface: 'private_chat',
    scenarioReminder: '',
  });
  assert.match(zhPlan.systemText, /以下为内建格式合同（miphone\.text\.v1）/);
  console.log('ok - contract instructional text follows prompt locale while protocol markers stay fixed');
}

console.log('builtin-phone-format-contract-tests passed');
