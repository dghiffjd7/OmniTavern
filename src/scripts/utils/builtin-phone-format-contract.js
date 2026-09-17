import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { getChatTimeMode, normalizeChatProtocolTime } from './chat-time-policy.js';
import { parseProtocolChatRow, parseProtocolMomentHeader } from './protocol-message-row.js';

export const BUILTIN_PHONE_FORMAT_CONTRACT_VERSION = 'miphone.text.v1';

export const BUILTIN_PHONE_FORMAT_SURFACES = Object.freeze({
  privateChat: 'private_chat',
  groupChat: 'group_chat',
  momentPost: 'moment_post',
  momentComment: 'moment_comment',
});

export const BUILTIN_PHONE_FORMAT_SHELL_LINES = Object.freeze([
  'MiPhone_start',
  'msg_start',
  'msg_end',
  'MiPhone_end',
]);

export const BUILTIN_PHONE_FORMAT_FUNCTION_PLACEMENT = Object.freeze({
  imagePrompt: Object.freeze({ region: 'surface_content', order: 0 }),
  tableEdit: Object.freeze({ region: 'postamble', order: 10, immediatelyAfter: 'MiPhone_end' }),
  variableUpdate: Object.freeze({ region: 'postamble', order: 20 }),
  summary: Object.freeze({ region: 'postamble', order: 30 }),
});

const SURFACE_ALIASES = Object.freeze({
  private: BUILTIN_PHONE_FORMAT_SURFACES.privateChat,
  private_chat: BUILTIN_PHONE_FORMAT_SURFACES.privateChat,
  private_message: BUILTIN_PHONE_FORMAT_SURFACES.privateChat,
  chat: BUILTIN_PHONE_FORMAT_SURFACES.privateChat,
  group: BUILTIN_PHONE_FORMAT_SURFACES.groupChat,
  group_chat: BUILTIN_PHONE_FORMAT_SURFACES.groupChat,
  group_message: BUILTIN_PHONE_FORMAT_SURFACES.groupChat,
  moment: BUILTIN_PHONE_FORMAT_SURFACES.momentPost,
  moments: BUILTIN_PHONE_FORMAT_SURFACES.momentPost,
  moment_post: BUILTIN_PHONE_FORMAT_SURFACES.momentPost,
  moment_comment: BUILTIN_PHONE_FORMAT_SURFACES.momentComment,
  moment_reply: BUILTIN_PHONE_FORMAT_SURFACES.momentComment,
});

const normalizeSurface = (value, fallback = BUILTIN_PHONE_FORMAT_SURFACES.privateChat) => {
  const key = String(value ?? '').trim().toLowerCase();
  return SURFACE_ALIASES[key] || fallback;
};

const oneLine = (value, fallback = '') => {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '<br>')
    .trim();
  return text || fallback;
};

const safeName = (value, fallback) => oneLine(value, fallback)
  .replace(/[<>]/g, '')
  .replace(/--/g, '——')
  .trim() || fallback;

const safeContent = (value, fallback = '正文') => oneLine(value, fallback).replace(/--/g, '——');

const timeFields = (payload, value) => {
  if((payload.timeMode ?? getChatTimeMode())!=='ai')return [];
  if(payload.placeholder===true)return ['HH:mm'];
  const time=normalizeChatProtocolTime(value);
  return time?[time]:[];
};

const safeCount = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
};

const list = value => (Array.isArray(value) ? value : []);

const serializePrivateBody = (payload = {}) => {
  const userName = safeName(payload.userName, '我');
  const targetName = safeName(payload.targetName, '联系人名');
  const tagName = `${userName}和${targetName}的私聊`;
  const messages = list(payload.messages).length
    ? payload.messages
    : [{ speaker: payload.speakerName, content: payload.content, time: payload.time }];
  const rows = messages.map(message => [
    safeName(message?.speaker, '说话人'),
    safeContent(message?.content, '正文'),
    ...timeFields(payload,message?.time),
  ].join('--'));
  return [`<${tagName}>`, ...rows, `</${tagName}>`];
};

const serializeGroupBody = (payload = {}) => {
  const groupName = safeName(payload.groupName, '群名');
  const members = list(payload.members).length
    ? payload.members.map(member => safeName(member, '')).filter(Boolean)
    : ['成员1', '成员2'];
  const messages = list(payload.messages).length
    ? payload.messages
    : [{ speaker: payload.speakerName, content: payload.content, time: payload.time }];
  const rows = messages.map(message => [
    safeName(message?.speaker, '说话人'),
    safeContent(message?.content, '正文'),
    ...timeFields(payload,message?.time),
  ].join('--'));
  return [
    `<群聊:${groupName}>`,
    `<成员>${members.join(',')}</成员>`,
    '<聊天内容>',
    ...rows,
    '</聊天内容>',
    `</群聊:${groupName}>`,
  ];
};

const serializeMomentPostBody = (payload = {}) => {
  const posts = list(payload.posts).length ? payload.posts : [{
    author: payload.author,
    content: payload.content,
    time: payload.time,
    views: payload.views,
    likes: payload.likes,
    comments: payload.comments,
  }];
  const rows = [];
  posts.forEach((post) => {
    rows.push([
      safeName(post?.author, '发布者'),
      safeContent(post?.content, '动态正文'),
      ...timeFields(payload,post?.time),
      safeCount(post?.views),
      safeCount(post?.likes),
    ].join('--'));
    list(post?.comments).forEach((comment) => {
      const fields = [
        safeName(comment?.author, '评论者'),
        safeContent(comment?.content, '评论正文'),
      ];
      if (oneLine(comment?.replyTo)) fields.push(`reply_to:: ${oneLine(comment.replyTo)}`);
      if (oneLine(comment?.replyToAuthor)) fields.push(`reply_to_author:: ${safeName(comment.replyToAuthor, '')}`);
      rows.push(fields.join('--'));
    });
  });
  return ['moment_start', ...rows, 'moment_end'];
};

const serializeMomentComment = (payload = {}) => {
  const comments = list(payload.comments).length ? payload.comments : [{
    author: payload.author,
    content: payload.content,
    replyTo: payload.replyTo,
    replyToAuthor: payload.replyToAuthor,
  }];
  const rows = [];
  const momentId = oneLine(payload.momentId);
  if (momentId) rows.push(`moment_id:: ${momentId}`);
  comments.forEach((comment) => {
    const fields = [
      safeName(comment?.author, '评论者'),
      safeContent(comment?.content, '评论正文'),
    ];
    if (oneLine(comment?.replyTo)) fields.push(`reply_to:: ${oneLine(comment.replyTo)}`);
    if (oneLine(comment?.replyToAuthor)) fields.push(`reply_to_author:: ${safeName(comment.replyToAuthor, '')}`);
    rows.push(fields.join('--'));
  });
  return ['moment_reply_start', ...rows, 'moment_reply_end'];
};

const serializePostamble = (payload = {}) => {
  const lines = [];
  if (payload.tableEdit !== undefined && payload.tableEdit !== null) {
    lines.push('<tableEdit>', String(payload.tableEdit), '</tableEdit>');
  }
  if (payload.variableUpdate !== undefined && payload.variableUpdate !== null) {
    lines.push('<UpdateVariable>', String(payload.variableUpdate), '</UpdateVariable>');
  }
  if (payload.summary !== undefined && payload.summary !== null) {
    lines.push(`<details><summary>摘要</summary>${String(payload.summary)}</details>`);
  }
  return lines;
};

export const serializeBuiltinPhoneFormat = (surface, payload = {}) => {
  const normalizedSurface = normalizeSurface(surface);
  if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentComment) {
    return serializeMomentComment(payload).join('\n');
  }
  const body = normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.groupChat
    ? serializeGroupBody(payload)
    : (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentPost
      ? serializeMomentPostBody(payload)
      : serializePrivateBody(payload));
  return [
    'MiPhone_start',
    'msg_start',
    ...body,
    'msg_end',
    'MiPhone_end',
    ...serializePostamble(payload),
  ].join('\n');
};

const serializeBuiltinPhoneBatchSurface = (surface, payload = {}) => {
  const normalizedSurface = normalizeSurface(surface, '');
  if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.privateChat) {
    return serializePrivateBody(payload);
  }
  if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.groupChat) {
    return serializeGroupBody(payload);
  }
  if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentPost) {
    return serializeMomentPostBody(payload);
  }
  if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentComment) {
    return serializeMomentComment(payload);
  }
  return [];
};

const appendBatchImagePrompt = (payload = {}, prompt = '') => {
  const tag = `<image_prompt>${String(prompt ?? '')}</image_prompt>`;
  const messages = list(payload.messages);
  if (!messages.length) {
    return {
      ...payload,
      content: `${String(payload.content ?? '')}${tag}`,
    };
  }
  const nextMessages = messages.map(message => ({ ...(message || {}) }));
  const lastIndex = nextMessages.length - 1;
  nextMessages[lastIndex].content = `${String(nextMessages[lastIndex]?.content ?? '')}${tag}`;
  return { ...payload, messages: nextMessages };
};

export const serializeBuiltinPhoneBatch = (items = [], { mode = '', timeMode = getChatTimeMode() } = {}) => {
  const listItems = Array.isArray(items) ? items : [];
  const normalizedMode = String(mode || '').trim().toLowerCase();
  const commentMode = normalizedMode === BUILTIN_PHONE_FORMAT_SURFACES.momentComment || listItems.some(item => (
    normalizeSurface(item?.surface, '') === BUILTIN_PHONE_FORMAT_SURFACES.momentComment
  ));
  const body = [];
  const postamble = [];
  const imagePrompts = listItems
    .filter(item => String(item?.kind || '').trim().toLowerCase() === 'image_prompt')
    .map(item => String(item?.content ?? '').trim())
    .filter(Boolean);
  const imagePromptTargetSurface = normalizedMode || listItems
    .map(item => normalizeSurface(item?.surface, ''))
    .find(surface => (
      surface === BUILTIN_PHONE_FORMAT_SURFACES.privateChat
      || surface === BUILTIN_PHONE_FORMAT_SURFACES.groupChat
    )) || '';
  const imagePromptTargetIndex = !commentMode && imagePrompts.length
    ? listItems.findIndex(item => normalizeSurface(item?.surface, '') === imagePromptTargetSurface)
    : -1;

  listItems.forEach((item, index) => {
    const surface = normalizeSurface(item?.surface, '');
    if (surface) {
      const payload = index === imagePromptTargetIndex
        ? appendBatchImagePrompt(item?.payload || {}, imagePrompts.join('\n'))
        : (item?.payload || {});
      body.push(...serializeBuiltinPhoneBatchSurface(surface, {...payload,timeMode}));
      return;
    }
    const kind = String(item?.kind || '').trim().toLowerCase();
    const content = String(item?.content ?? '');
    if (kind === 'image_prompt') {
      if (imagePromptTargetIndex < 0) body.push('<image_prompt>', content, '</image_prompt>');
      return;
    }
    if (kind === 'table_edit') {
      postamble.push('<tableEdit>', content, '</tableEdit>');
      return;
    }
    if (kind === 'variable_update') {
      postamble.push('<UpdateVariable>', content, '</UpdateVariable>');
      return;
    }
    if (kind === 'summary') {
      postamble.push(`<details><summary>摘要</summary>${content}</details>`);
    }
  });

  if (commentMode) return [...body, ...postamble].join('\n');
  return [
    'MiPhone_start',
    'msg_start',
    ...body,
    'msg_end',
    'MiPhone_end',
    ...postamble,
  ].join('\n');
};

const guardianSnippets = Object.freeze({
  phoneShell: () => [...BUILTIN_PHONE_FORMAT_SHELL_LINES],
  privateChat: (timeMode) => serializePrivateBody({
    timeMode,
    userName: '{{user}}',
    targetName: getLocalizedPromptText('format_guardian.example.contact'),
    messages: [{
      speaker: getLocalizedPromptText('format_guardian.example.speaker'),
      content: getLocalizedPromptText('format_guardian.example.body'),
      time: 'HH:mm',
    }],
    placeholder: true,
  }),
  groupChat: (timeMode) => serializeGroupBody({
    timeMode,
    groupName: getLocalizedPromptText('format_guardian.example.group'),
    members: [
      getLocalizedPromptText('format_guardian.example.member_1'),
      getLocalizedPromptText('format_guardian.example.member_2'),
    ],
    messages: [{
      speaker: getLocalizedPromptText('format_guardian.example.speaker'),
      content: getLocalizedPromptText('format_guardian.example.body'),
      time: 'HH:mm',
    }],
    placeholder: true,
  }),
  momentPost: (timeMode) => serializeMomentPostBody({
    timeMode,
    posts: [{
      author: getLocalizedPromptText('format_guardian.example.publisher'),
      content: getLocalizedPromptText('format_guardian.example.moment_body'),
      time: 'HH:mm',
      views: 0,
      likes: 0,
    }],
    placeholder: true,
  }),
  momentComment: () => serializeMomentComment({
    momentId: getLocalizedPromptText('format_guardian.example.moment_id'),
    author: getLocalizedPromptText('format_guardian.example.commenter'),
    content: getLocalizedPromptText('format_guardian.example.comment_body'),
    replyTo: getLocalizedPromptText('format_guardian.example.comment_id'),
    replyToAuthor: getLocalizedPromptText('format_guardian.example.replied_author'),
  }),
  tableEdit: () => ['<tableEdit>', getLocalizedPromptText('format_guardian.example.table_content'), '</tableEdit>'],
  imagePrompt: () => ['<image_prompt>', getLocalizedPromptText('format_guardian.example.image_prompt'), '</image_prompt>'],
  variableUpdate: () => ['<UpdateVariable>', getLocalizedPromptText('format_guardian.example.variable_instruction'), '</UpdateVariable>'],
});

export const getBuiltinPhoneFormatGuardianSnippet = (id = '', {timeMode=getChatTimeMode()} = {}) => {
  const build = guardianSnippets[String(id || '').trim()];
  return build ? build(timeMode) : [];
};

export const buildBuiltinPhoneFormatReminder = ({
  surface = BUILTIN_PHONE_FORMAT_SURFACES.privateChat,
  userName = '我',
  targetName = '联系人名',
  groupName = '群名',
  includeTableEdit = false,
  timeMode = getChatTimeMode(),
} = {}) => {
  const normalizedSurface = normalizeSurface(surface);
  const payload = {
    timeMode,
    userName,
    targetName,
    groupName,
    placeholder: true,
    ...(includeTableEdit ? { tableEdit: '记忆表格内容' } : {}),
  };
  return [
    getLocalizedPromptText('transport.contract_preamble')
      .split('{version}').join(BUILTIN_PHONE_FORMAT_CONTRACT_VERSION),
    serializeBuiltinPhoneFormat(normalizedSurface, payload),
  ].join('\n');
};

const buildContinuationReminder = (surface) => {
  const normalizedSurface = normalizeSurface(surface);
  const order = normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentComment
    ? 'moment_reply_start → 评论行 → moment_reply_end'
    : 'MiPhone_start → msg_start → 场景内容 → msg_end → MiPhone_end';
  return [
    getLocalizedPromptText('transport.continuation_head')
      .split('{version}').join(BUILTIN_PHONE_FORMAT_CONTRACT_VERSION),
    getLocalizedPromptText('transport.continuation_no_repeat'),
    getLocalizedPromptText('transport.continuation_order').split('{order}').join(order),
  ].join('\n');
};

export const resolveBuiltinPhoneFormatReminderPlan = ({
  hasPreset = false,
  isDefaultPreset = false,
  contractDisabled = false,
  responseTarget = 'assistant',
  assistantContinuation = false,
  suppressPendingUserTurn = false,
  scenarioReminder = '',
  ...reminderOptions
} = {}) => {
  const empty = {
    systemText: '',
    userScenarioText: '',
    usesBuiltinContract: false,
    deliveryRole: '',
  };
  if (!hasPreset || contractDisabled || String(responseTarget || '').trim().toLowerCase() === 'user') {
    return empty;
  }
  const scenario = String(scenarioReminder || '').trim();
  if (isDefaultPreset) {
    const contract = assistantContinuation
      ? buildContinuationReminder(reminderOptions.surface)
      : buildBuiltinPhoneFormatReminder(reminderOptions);
    return {
      systemText: [scenario, contract].filter(Boolean).join('\n\n'),
      userScenarioText: '',
      usesBuiltinContract: true,
      deliveryRole: 'system',
    };
  }
  if (!scenario) return empty;
  if (assistantContinuation || suppressPendingUserTurn) {
    return {
      ...empty,
      systemText: scenario,
      deliveryRole: 'system',
    };
  }
  return {
    ...empty,
    userScenarioText: scenario,
    deliveryRole: 'user',
  };
};

const escapeRegExp = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const markerMatches = (source, marker) => {
  const pattern = new RegExp(
    `(^|\\n)[\\t ]*(?:<\\s*${escapeRegExp(marker)}\\s*>|${escapeRegExp(marker)})[\\t ]*(?=\\n|$)`,
    'gi',
  );
  const matches = [];
  let match;
  while ((match = pattern.exec(source))) {
    const leading = match[1]?.length || 0;
    matches.push({
      index: match.index + leading,
      end: pattern.lastIndex,
    });
  }
  return matches;
};

const stripOuterContentLines = value => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/^[\t ]*<\/?content\b[^>]*>[\t ]*$/gim, '')
  .trim();

const detectSurfaces = (source) => {
  const detected = [];
  if (/<\s*[^/][^>\n]*的私聊\s*>/i.test(source)) detected.push(BUILTIN_PHONE_FORMAT_SURFACES.privateChat);
  if (/<\s*群聊\s*[:：]/i.test(source)) detected.push(BUILTIN_PHONE_FORMAT_SURFACES.groupChat);
  if (markerMatches(source, 'moment_start').length) detected.push(BUILTIN_PHONE_FORMAT_SURFACES.momentPost);
  if (markerMatches(source, 'moment_reply_start').length) detected.push(BUILTIN_PHONE_FORMAT_SURFACES.momentComment);
  return detected;
};

const hasBalancedTag = (source, tag) => {
  const open = (source.match(new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi')) || []).length;
  const close = (source.match(new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'gi')) || []).length;
  return open === close;
};

const collectPostamble = (source, addIssue) => {
  const specs = [
    { id: 'tableEdit', order: 10, pattern: /^<tableEdit\b[^>]*>[\s\S]*?<\/tableEdit\s*>/i },
    { id: 'variableUpdate', order: 20, pattern: /^<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/i },
    { id: 'summary', order: 30, pattern: /^<details\b[^>]*>\s*<summary\b[^>]*>\s*摘要\s*<\/summary\s*>[\s\S]*?<\/details\s*>/i },
  ];
  const blocks = [];
  let rest = String(source || '').trim();
  let lastOrder = -1;
  while (rest) {
    const spec = specs.find(item => item.pattern.test(rest));
    if (!spec) {
      addIssue('postamble.unexpected_text');
      break;
    }
    const match = rest.match(spec.pattern);
    if (!match) break;
    if (spec.order < lastOrder) addIssue('postamble.wrong_order');
    if (blocks.includes(spec.id)) addIssue('postamble.duplicate_block');
    blocks.push(spec.id);
    lastOrder = Math.max(lastOrder, spec.order);
    rest = rest.slice(match[0].length).trim();
  }
  return blocks;
};

const validatePrivateBlocks = (body, addIssue) => {
  const opens = [...body.matchAll(/<\s*([^/<>\n]+的私聊)\s*>/gi)];
  if (!opens.length) {
    addIssue('private_chat.missing_block');
    return;
  }
  opens.forEach((open) => {
    const tagName = String(open[1] || '').trim();
    const start = (open.index || 0) + open[0].length;
    const closePattern = new RegExp(`<\\s*\\/\\s*${escapeRegExp(tagName)}\\s*>`, 'i');
    const close = closePattern.exec(body.slice(start));
    if (!close) {
      addIssue('private_chat.unclosed_block');
      return;
    }
    const rows = body.slice(start, start + close.index).split('\n').map(line => line.trim()).filter(Boolean);
    if (!rows.length || rows.some(row => !parseProtocolChatRow(row))) {
      addIssue('private_chat.invalid_row');
    }
  });
};

const validateGroupBlocks = (body, addIssue) => {
  const opens = [...body.matchAll(/<\s*群聊\s*[:：]\s*([^<>\n]+)\s*>/gi)];
  if (!opens.length) {
    addIssue('group_chat.missing_block');
    return;
  }
  opens.forEach((open) => {
    const groupName = String(open[1] || '').trim();
    const start = (open.index || 0) + open[0].length;
    const closePattern = new RegExp(`<\\s*\\/\\s*群聊\\s*[:：]\\s*${escapeRegExp(groupName)}\\s*>`, 'i');
    const close = closePattern.exec(body.slice(start));
    if (!close) {
      addIssue('group_chat.unclosed_block');
      return;
    }
    const inner = body.slice(start, start + close.index);
    if (!/<\s*成员\s*>[\s\S]*?<\s*\/\s*成员\s*>/i.test(inner)) addIssue('group_chat.missing_members');
    const chat = inner.match(/<\s*聊天内容\s*>([\s\S]*?)<\s*\/\s*聊天内容\s*>/i);
    if (!chat) {
      addIssue('group_chat.missing_content');
      return;
    }
    const rows = String(chat[1] || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!rows.length || rows.some(row => !parseProtocolChatRow(row))) {
      addIssue('group_chat.invalid_row');
    }
  });
};

const validateMomentPost = (body, addIssue) => {
  const starts = markerMatches(body, 'moment_start');
  const ends = markerMatches(body, 'moment_end');
  if (starts.length !== 1 || ends.length !== 1 || ends[0]?.index <= starts[0]?.index) {
    addIssue('moment_post.invalid_markers');
    return;
  }
  const lines = body.slice(starts[0].end, ends[0].index).split('\n').map(line => line.trim()).filter(Boolean);
  const headers = lines.filter(line => parseProtocolMomentHeader(line));
  if (!headers.length) addIssue('moment_post.invalid_row');
};

const validateMomentComment = (source, addIssue) => {
  if (markerMatches(source, 'MiPhone_start').length || markerMatches(source, 'MiPhone_end').length) {
    addIssue('moment_comment.unexpected_phone_shell');
  }
  const starts = markerMatches(source, 'moment_reply_start');
  const ends = markerMatches(source, 'moment_reply_end');
  if (starts.length !== 1 || ends.length !== 1 || ends[0]?.index <= starts[0]?.index) {
    addIssue('moment_comment.invalid_markers');
    return;
  }
  if (source.slice(0, starts[0].index).trim() || source.slice(ends[0].end).trim()) {
    addIssue('moment_comment.unexpected_text');
  }
  const rows = source.slice(starts[0].end, ends[0].index).split('\n').map(line => line.trim()).filter(Boolean);
  const comments = rows.filter(line => !/^moment_id::\s*.+$/i.test(line));
  if (!comments.length || comments.some((line) => {
    const parts = line.split('--').map(part => part.trim());
    return parts.length < 2 || !parts[0] || !parts[1];
  })) addIssue('moment_comment.invalid_row');
};

export const validateBuiltinPhoneFormat = (raw = '', { surface = '' } = {}) => {
  const source = stripOuterContentLines(raw);
  const normalizedSurface = normalizeSurface(surface, '');
  const issues = [];
  const addIssue = (issue) => {
    if (issue && !issues.includes(issue)) issues.push(issue);
  };
  const detectedSurfaces = detectSurfaces(source);
  let postambleBlocks = [];

  if (!source) addIssue('response.empty');
  if (!Object.values(BUILTIN_PHONE_FORMAT_SURFACES).includes(normalizedSurface)) {
    addIssue('surface.unsupported');
  } else if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentComment) {
    validateMomentComment(source, addIssue);
  } else {
    const markerNames = ['MiPhone_start', 'msg_start', 'msg_end', 'MiPhone_end'];
    const markers = Object.fromEntries(markerNames.map(name => [name, markerMatches(source, name)]));
    markerNames.forEach((name) => {
      if (markers[name].length === 0) addIssue(`shell.missing_${name.toLowerCase()}`);
      if (markers[name].length > 1) addIssue(`shell.duplicate_${name.toLowerCase()}`);
    });
    const ordered = markerNames.map(name => markers[name][0]?.index ?? -1);
    if (ordered.some(index => index < 0) || ordered.some((index, position) => position > 0 && index <= ordered[position - 1])) {
      addIssue('shell.wrong_order');
    }
    const phoneStart = markers.MiPhone_start[0];
    const messageStart = markers.msg_start[0];
    const messageEnd = markers.msg_end[0];
    const phoneEnd = markers.MiPhone_end[0];
    if (phoneStart && source.slice(0, phoneStart.index).trim()) addIssue('shell.unexpected_prefix');
    if (phoneStart && messageStart && messageEnd && phoneEnd && !issues.includes('shell.wrong_order')) {
      const body = source.slice(messageStart.end, messageEnd.index);
      const phoneBody = source.slice(phoneStart.end, phoneEnd.index);
      if (/<\s*\/?\s*(?:tableEdit|UpdateVariable)\b/i.test(phoneBody) || /<details\b/i.test(phoneBody)) {
        addIssue('function_block.invalid_position');
      }
      if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.privateChat) validatePrivateBlocks(body, addIssue);
      if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.groupChat) validateGroupBlocks(body, addIssue);
      if (normalizedSurface === BUILTIN_PHONE_FORMAT_SURFACES.momentPost) validateMomentPost(body, addIssue);
      const postamble = source.slice(phoneEnd.end);
      if (/<\s*\/?\s*image_prompt\b/i.test(postamble)) addIssue('function_block.invalid_position');
      postambleBlocks = collectPostamble(postamble, addIssue);
    }
  }

  if (!hasBalancedTag(source, 'image_prompt')) addIssue('image_prompt.unclosed_block');
  if (!hasBalancedTag(source, 'tableEdit')) addIssue('table_edit.unclosed_block');
  if (!hasBalancedTag(source, 'UpdateVariable')) addIssue('variable_update.unclosed_block');

  return {
    valid: issues.length === 0,
    version: BUILTIN_PHONE_FORMAT_CONTRACT_VERSION,
    surface: normalizedSurface,
    issues,
    detectedSurfaces,
    postambleBlocks,
  };
};
