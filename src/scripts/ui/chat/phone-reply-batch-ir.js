import { getChatTimeMode } from '../../utils/chat-time-policy.js';
import {
  serializeBuiltinPhoneBatch,
  serializeBuiltinPhoneFormat,
  validateBuiltinPhoneFormat,
} from '../../utils/builtin-phone-format-contract.js';
import {
  PHONE_REPLY_IR_PRIVATE_ITEM_TYPES,
  PHONE_REPLY_IR_VERSION,
  serializePhoneMessageItemContent,
} from './phone-reply-ir.js';

export const PHONE_REPLY_IR_BATCH_TOOL_NAME = 'emit_phone_batch';
export const PHONE_REPLY_IR_BATCH_ITEM_KINDS = Object.freeze([
  'chat',
  'moment_post',
  'moment_comment',
  'private_chat',
  'group_chat',
  'image_prompt',
  'table_edit',
  'variable_update',
  'summary',
]);

const BATCH_SURFACE = 'phone_batch';
const STANDARD_MODES = new Set(['private_chat', 'group_chat']);
const SUPPORTED_MODES = new Set([...STANDARD_MODES, 'moment_comment']);
const DEFAULT_ITEM_TYPES = Object.freeze(['text']);
const MAX_BATCH_ITEMS = 12;
const MAX_MESSAGES = 12;
const MAX_POSTS = 3;
const MAX_COMMENTS = 12;
const MAX_ACTIONS = 20;
const MAX_OPERATIONS = 20;
const MAX_CONTENT_CHARS = 4000;
const MAX_TOTAL_CONTENT_CHARS = 24000;
const TIME_PATTERN = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const PROTOCOL_CONTROL_PATTERN = /(?:MiPhone_(?:start|end)|msg_(?:start|end)|moment_(?:start|end|reply_start|reply_end)|<\s*\/?\s*[^>\n]*的私聊\s*>|<\s*\/?\s*群聊\s*[:：]|<\s*\/?\s*(?:成员|聊天内容|tableEdit|UpdateVariable|image_prompt|details|summary|json_patch)\b)/iu;
const SPECIAL_TOKEN_PATTERN = /^\[(?:img|yy|music|zz|bqb)-[\s\S]*\]$/iu;
const SPECIAL_PAYLOAD_CONTROL_PATTERN = /[\[\]\r\n]/u;

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeText = value => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .trim();

const normalizeName = (value, fallback = '') => normalizeText(value)
  .replace(/\n+/g, ' ')
  .replace(/[<>]/g, '')
  .replace(/--/g, '——')
  .trim() || fallback;

const normalizeContent = value => normalizeText(value).replace(/--/g, '——');

const normalizeReference = value => normalizeText(value)
  .replace(/\n+/g, ' ')
  .replace(/--/g, '——')
  .trim();

const normalizeSource = (source = {}) => ({
  transport: trim(source?.transport, 'provider_fc'),
  provider: trim(source?.provider),
  model: trim(source?.model),
});

const normalizeCapabilities = (value = {}) => ({
  momentPost: value?.momentPost === true,
  momentCommentSideChats: value?.momentCommentSideChats === true,
  imagePrompt: value?.imagePrompt === true,
  tableEdit: value?.tableEdit === true,
  variableUpdate: value?.variableUpdate === true,
  summary: value?.summary === true,
});

const normalizeAllowedItemTypes = (value = DEFAULT_ITEM_TYPES) => {
  const allowed = new Set(PHONE_REPLY_IR_PRIVATE_ITEM_TYPES);
  const out = [];
  (Array.isArray(value) ? value : DEFAULT_ITEM_TYPES).forEach((item) => {
    const type = trim(item).toLowerCase();
    if (allowed.has(type) && !out.includes(type)) out.push(type);
  });
  return out.length ? out : DEFAULT_ITEM_TYPES.slice();
};

const normalizeStickerKeywords = (value = []) => {
  const out = [];
  (Array.isArray(value) ? value : []).forEach((item) => {
    const keyword = normalizeContent(item).replace(/[\[\]\r\n]/g, '').trim();
    if (keyword && !out.includes(keyword)) out.push(keyword);
  });
  return out;
};

const normalizeIdentity = (value = {}) => ({
  id: trim(value?.id),
  name: normalizeName(value?.name || value?.id),
});

const normalizeIdentityList = (value = []) => {
  const out = [];
  const seen = new Set();
  (Array.isArray(value) ? value : []).forEach((item) => {
    const identity = normalizeIdentity(item);
    if (!identity.id || !identity.name || seen.has(identity.id)) return;
    seen.add(identity.id);
    out.push(identity);
  });
  return out;
};

const normalizeGroupTargetList = (value = []) => {
  const out = [];
  const seen = new Set();
  (Array.isArray(value) ? value : []).forEach((item) => {
    const identity = normalizeIdentity(item);
    if (!identity.id || !identity.name || seen.has(identity.id)) return;
    seen.add(identity.id);
    out.push({
      ...identity,
      members: normalizeIdentityList(item?.members),
    });
  });
  return out;
};

const normalizeTableTargetList = (value = []) => {
  const out = [];
  const seen = new Set();
  (Array.isArray(value) ? value : []).forEach((item) => {
    const id = trim(item?.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rowIds = [];
    (Array.isArray(item?.rowIds) ? item.rowIds : []).forEach((rowId) => {
      const normalized = trim(rowId);
      if (normalized && !rowIds.includes(normalized)) rowIds.push(normalized);
    });
    out.push({
      id,
      name: normalizeName(item?.name || id, id),
      rowIds,
    });
  });
  return out;
};

const findIdentity = (list, id) => list.find(item => item.id === trim(id)) || null;

const addUnique = (errors, value) => {
  if (value && !errors.includes(value)) errors.push(value);
};

const cloneJsonValue = (value) => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false, value: null, serialized: '' };
    return { ok: true, value: JSON.parse(serialized), serialized };
  } catch {
    return { ok: false, value: null, serialized: '' };
  }
};

const jsonContainsProtocolControl = (value) => {
  const inspected = cloneJsonValue(value);
  return inspected.ok && PROTOCOL_CONTROL_PATTERN.test(inspected.serialized);
};

const hasUnexpectedFields = (value, allowed) => isPlainObject(value)
  && Object.keys(value).some(key => !allowed.includes(key));

const buildMessageProperties = ({
  itemTypes,
  stickerKeywords,
  speakerIds = [],
  requireSpeaker = false,
  timeMode = getChatTimeMode(),
} = {}) => {
  const supportsSpecialItems = itemTypes.some(type => type !== 'text');
  const properties = {
    ...(supportsSpecialItems
      ? { type: { type: 'string', enum: itemTypes } }
      : {}),
    ...(requireSpeaker
      ? {
          speakerId: {
            type: 'string',
            enum: speakerIds,
            description: 'Choose one frozen member id. Never invent an id.',
          },
        }
      : {}),
    content: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CONTENT_CHARS,
      description: [
        'Payload only; never include MiPhone tags or wrapper prose.',
        itemTypes.includes('sticker') && stickerKeywords.length
          ? `Sticker content must be one of: ${stickerKeywords.join(', ')}.`
          : '',
      ].filter(Boolean).join(' '),
    },
    ...(itemTypes.includes('music')
      ? { artist: { type: 'string', minLength: 1, maxLength: 200 } }
      : {}),
    ...(timeMode==='ai'?{time: { type: 'string', pattern: '^(?:[01]?\\d|2[0-3]):[0-5]\\d$' }}:{}),
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      ...(supportsSpecialItems ? ['type'] : []),
      ...(requireSpeaker ? ['speakerId'] : []),
      'content',
    ],
    properties,
  };
};

const buildCommentsSchema = ({ authorIds = [], requireAuthor = false, requireName = false } = {}) => ({
  type: 'array',
  minItems: 1,
  maxItems: MAX_COMMENTS,
  items: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...(requireAuthor ? ['authorId'] : []),
      ...(requireName ? ['author'] : []),
      'content',
    ],
    properties: {
      ...(requireAuthor ? { authorId: { type: 'string', enum: authorIds } } : {}),
      author: { type: 'string', minLength: 1, maxLength: 100 },
      content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_CHARS },
      replyTo: { type: 'string', maxLength: 200 },
      replyToAuthor: { type: 'string', maxLength: 100 },
    },
  },
});

const buildTableActionSchema = ({ target, action, rowKey = '' } = {}) => {
  const needsData = action !== 'delete';
  const rowIndexes = target.rowIds.map((_, index) => index);
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'action',
      'tableId',
      ...(rowKey ? [rowKey] : []),
      ...(needsData ? ['data'] : []),
    ],
    properties: {
      action: Array.isArray(action)
        ? { type: 'string', enum: action }
        : { type: 'string', const: action },
      tableId: {
        type: 'string',
        const: target.id,
        description: `${target.id}=${target.name}`,
      },
      ...(rowKey === 'rowId'
        ? { rowId: { type: 'string', enum: target.rowIds } }
        : {}),
      ...(rowKey === 'rowIndex'
        ? { rowIndex: { type: 'integer', enum: rowIndexes } }
        : {}),
      ...(needsData ? { data: { type: 'object' } } : {}),
    },
  };
};

const buildTableActionSchemas = (target) => {
  const actions = [buildTableActionSchema({ target, action: ['init', 'insert'] })];
  if (!target.rowIds.length) return actions;
  ['update', 'delete'].forEach((action) => {
    actions.push(buildTableActionSchema({ target, action, rowKey: 'rowId' }));
    actions.push(buildTableActionSchema({ target, action, rowKey: 'rowIndex' }));
  });
  return actions;
};

const buildTableEditSchema = (tableTargets = []) => {
  const targets = normalizeTableTargetList(tableTargets);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'actions'],
    properties: {
      kind: { const: 'table_edit' },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ACTIONS,
        items: {
          oneOf: targets.flatMap(buildTableActionSchemas),
        },
      },
    },
  };
};

const buildVariableUpdateSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'operations'],
  properties: {
    kind: { const: 'variable_update' },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_OPERATIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'path'],
        properties: {
          op: { type: 'string', enum: ['replace', 'delta', 'add', 'remove', 'move'] },
          path: { type: 'string', pattern: '^/' },
          from: { type: 'string', pattern: '^/' },
          value: {},
        },
      },
    },
  },
});

export const buildPhoneReplyBatchProviderToolDefinition = ({
  target = {},
  timeMode = target.timeMode ?? getChatTimeMode(),
  capabilities = {},
  allowedItemTypes = DEFAULT_ITEM_TYPES,
  allowedStickerKeywords = [],
} = {}) => {
  const mode = trim(target?.mode).toLowerCase();
  const caps = normalizeCapabilities(capabilities);
  const itemTypes = normalizeAllowedItemTypes(allowedItemTypes);
  const stickerKeywords = normalizeStickerKeywords(allowedStickerKeywords);
  const members = normalizeIdentityList(target?.members);
  const momentAuthors = normalizeIdentityList(target?.momentAuthors);
  const privateTargets = normalizeIdentityList(target?.privateTargets);
  const groupTargets = normalizeGroupTargetList(target?.groupTargets);
  const tableTargets = normalizeTableTargetList(target?.tableTargets);
  const variants = [];

  if (STANDARD_MODES.has(mode)) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'messages'],
      properties: {
        kind: { const: 'chat' },
        messages: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_MESSAGES,
          items: buildMessageProperties({
            timeMode,
            itemTypes,
            stickerKeywords,
            speakerIds: members.map(item => item.id),
            requireSpeaker: mode === 'group_chat',
          }),
        },
      },
    });
    if (caps.momentPost) {
      const requireAuthor = mode === 'group_chat' || momentAuthors.length > 1;
      variants.push({
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'posts'],
        properties: {
          kind: { const: 'moment_post' },
          posts: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_POSTS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [...(requireAuthor ? ['authorId'] : []), 'content'],
              properties: {
                ...(requireAuthor ? { authorId: { type: 'string', enum: momentAuthors.map(item => item.id) } } : {}),
                content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_CHARS },
                ...(timeMode==='ai'?{time: { type: 'string', pattern: '^(?:[01]?\\d|2[0-3]):[0-5]\\d$' }}:{}),
                views: { type: 'integer', minimum: 0 },
                likes: { type: 'integer', minimum: 0 },
                comments: buildCommentsSchema({ requireName: true }),
              },
            },
          },
        },
      });
    }
  } else if (mode === 'moment_comment') {
    const requireAuthor = momentAuthors.length !== 1;
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'comments'],
      properties: {
        kind: { const: 'moment_comment' },
        comments: buildCommentsSchema({
          authorIds: momentAuthors.map(item => item.id),
          requireAuthor,
        }),
      },
    });
    if (caps.momentCommentSideChats && privateTargets.length) {
      variants.push({
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'targetId', 'messages'],
        properties: {
          kind: { const: 'private_chat' },
          targetId: { type: 'string', enum: privateTargets.map(item => item.id) },
          messages: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_MESSAGES,
            items: buildMessageProperties({ itemTypes, stickerKeywords, timeMode }),
          },
        },
      });
    }
    if (caps.momentCommentSideChats && groupTargets.length) {
      const memberIds = [...new Set(groupTargets.flatMap(item => item.members.map(member => member.id)))];
      variants.push({
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'targetId', 'messages'],
        properties: {
          kind: { const: 'group_chat' },
          targetId: { type: 'string', enum: groupTargets.map(item => item.id) },
          messages: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_MESSAGES,
            items: buildMessageProperties({
            timeMode,
              itemTypes: itemTypes.filter(type => type !== 'transfer'),
              stickerKeywords,
              speakerIds: memberIds,
              requireSpeaker: true,
            }),
          },
        },
      });
    }
  }

  if (caps.imagePrompt) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'prompt'],
      properties: {
        kind: { const: 'image_prompt' },
        prompt: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    });
  }
  if (caps.tableEdit && tableTargets.length) variants.push(buildTableEditSchema(tableTargets));
  if (caps.variableUpdate) variants.push(buildVariableUpdateSchema());
  if (caps.summary) {
    variants.push({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'content'],
      properties: {
        kind: { const: 'summary' },
        content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_CHARS },
      },
    });
  }

  return {
    type: 'function',
    function: {
      name: PHONE_REPLY_IR_BATCH_TOOL_NAME,
      description: 'Submit one fully ordered phone reply batch for the frozen runtime context. Never choose a session or real target outside the provided ids.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH_ITEMS,
            items: { oneOf: variants },
          },
        },
      },
    },
  };
};

const validateMessage = (message, errors, total) => {
  if (!isPlainObject(message) || !PHONE_REPLY_IR_PRIVATE_ITEM_TYPES.includes(trim(message?.type, 'text').toLowerCase())) {
    addUnique(errors, 'item.type.unsupported');
  }
  if (!normalizeName(message?.speaker?.name)) addUnique(errors, 'item.speaker.unknown');
  const content = normalizeContent(message?.content);
  total.value += content.length;
  if (!content) addUnique(errors, 'item.content.empty');
  if (content.length > MAX_CONTENT_CHARS) addUnique(errors, 'item.content.too_long');
  if (PROTOCOL_CONTROL_PATTERN.test(content)) addUnique(errors, 'item.content.protocol_control');
  const type = trim(message?.type, 'text').toLowerCase();
  if (type === 'text' && SPECIAL_TOKEN_PATTERN.test(content)) addUnique(errors, 'item.content.special_token');
  if (type !== 'text' && SPECIAL_PAYLOAD_CONTROL_PATTERN.test(content)) addUnique(errors, 'item.content.special_control');
  if (type === 'music') {
    const artist = normalizeContent(message?.artist);
    if (!artist) addUnique(errors, 'item.music.artist_missing');
    if (artist.length > 200) addUnique(errors, 'item.music.artist_too_long');
    if (PROTOCOL_CONTROL_PATTERN.test(artist)) addUnique(errors, 'item.music.artist_protocol_control');
  }
  const time = trim(message?.time);
  if (time && !TIME_PATTERN.test(time)) addUnique(errors, 'item.time.invalid');
};

const validateComment = (comment, errors, total) => {
  const author = normalizeText(comment?.author?.name);
  if (!isPlainObject(comment) || !normalizeName(author)) addUnique(errors, 'item.author.unknown');
  if (author.length > 100) addUnique(errors, 'item.author.too_long');
  if (PROTOCOL_CONTROL_PATTERN.test(author)) addUnique(errors, 'item.author.protocol_control');
  const content = normalizeContent(comment?.content);
  total.value += content.length;
  if (!content) addUnique(errors, 'item.content.empty');
  if (content.length > MAX_CONTENT_CHARS) addUnique(errors, 'item.content.too_long');
  if (PROTOCOL_CONTROL_PATTERN.test(content)) addUnique(errors, 'item.content.protocol_control');
  const replyTo = normalizeReference(comment?.replyTo);
  const replyToAuthor = normalizeText(comment?.replyToAuthor);
  if (replyTo.length > 200 || replyToAuthor.length > 100) addUnique(errors, 'item.comment.reference_too_long');
  if (PROTOCOL_CONTROL_PATTERN.test(replyTo) || PROTOCOL_CONTROL_PATTERN.test(replyToAuthor)) {
    addUnique(errors, 'item.comment.reference_protocol_control');
  }
};

const ITEM_ORDER = Object.freeze({
  chat: 10,
  moment_comment: 10,
  moment_post: 20,
  private_chat: 20,
  group_chat: 20,
  image_prompt: 30,
  table_edit: 40,
  variable_update: 50,
  summary: 60,
});

export const validatePhoneReplyBatchIr = (ir = {}, { expectedSessionId = '' } = {}) => {
  const errors = [];
  const source = isPlainObject(ir) ? ir : {};
  if (trim(source.version) !== PHONE_REPLY_IR_VERSION) addUnique(errors, 'version.unsupported');
  if (trim(source.surface) !== BATCH_SURFACE) addUnique(errors, 'surface.unsupported');
  const context = isPlainObject(source.context) ? source.context : {};
  const mode = trim(context.mode).toLowerCase();
  if (!SUPPORTED_MODES.has(mode)) addUnique(errors, 'context.mode.unsupported');
  const sessionId = trim(context.sessionId);
  const tableTargets = normalizeTableTargetList(context.tableTargets);
  if (!sessionId) addUnique(errors, 'context.session_missing');
  if (expectedSessionId && sessionId !== trim(expectedSessionId)) addUnique(errors, 'context.session_mismatch');
  if (mode === 'moment_comment' && !trim(context.momentId)) addUnique(errors, 'context.moment_missing');

  const items = Array.isArray(source.items) ? source.items : [];
  if (!items.length) addUnique(errors, 'items.empty');
  if (items.length > MAX_BATCH_ITEMS) addUnique(errors, 'items.too_many');
  let previousOrder = -1;
  const counts = new Map();
  const total = { value: 0 };
  items.forEach((item) => {
    const kind = trim(item?.kind).toLowerCase();
    if (!PHONE_REPLY_IR_BATCH_ITEM_KINDS.includes(kind)) addUnique(errors, 'item.kind.unsupported');
    const order = ITEM_ORDER[kind] ?? -1;
    if (order < previousOrder) addUnique(errors, 'items.wrong_order');
    previousOrder = Math.max(previousOrder, order);
    counts.set(kind, (counts.get(kind) || 0) + 1);
    if (['chat', 'private_chat', 'group_chat'].includes(kind)) {
      const messages = Array.isArray(item?.messages) ? item.messages : [];
      if (!messages.length) addUnique(errors, 'item.messages.empty');
      if (messages.length > MAX_MESSAGES) addUnique(errors, 'item.messages.too_many');
      messages.forEach(message => validateMessage(message, errors, total));
    }
    if (kind === 'moment_post') {
      const posts = Array.isArray(item?.posts) ? item.posts : [];
      if (!posts.length) addUnique(errors, 'item.posts.empty');
      if (posts.length > MAX_POSTS) addUnique(errors, 'item.posts.too_many');
      posts.forEach((post) => {
        if (!normalizeName(post?.author?.name)) addUnique(errors, 'item.author.unknown');
        const content = normalizeContent(post?.content);
        total.value += content.length;
        if (!content) addUnique(errors, 'item.content.empty');
        if (content.length > MAX_CONTENT_CHARS) addUnique(errors, 'item.content.too_long');
        if (PROTOCOL_CONTROL_PATTERN.test(content)) addUnique(errors, 'item.content.protocol_control');
        const time = trim(post?.time);
        if (time && !TIME_PATTERN.test(time)) addUnique(errors, 'item.time.invalid');
        const comments = Array.isArray(post?.comments) ? post.comments : [];
        if (comments.length > MAX_COMMENTS) addUnique(errors, 'item.comments.too_many');
        comments.forEach(comment => validateComment(comment, errors, total));
      });
    }
    if (kind === 'moment_comment') {
      if (trim(item?.momentId) !== trim(context.momentId)) addUnique(errors, 'item.moment_mismatch');
      const comments = Array.isArray(item?.comments) ? item.comments : [];
      if (!comments.length) addUnique(errors, 'item.comments.empty');
      if (comments.length > MAX_COMMENTS) addUnique(errors, 'item.comments.too_many');
      comments.forEach(comment => validateComment(comment, errors, total));
    }
    if (kind === 'image_prompt') {
      const prompt = normalizeContent(item?.prompt);
      total.value += prompt.length;
      if (!prompt) addUnique(errors, 'item.image_prompt.empty');
      if (prompt.length > 2000) addUnique(errors, 'item.image_prompt.too_long');
      if (PROTOCOL_CONTROL_PATTERN.test(prompt)) addUnique(errors, 'item.content.protocol_control');
    }
    if (kind === 'table_edit') {
      const actions = Array.isArray(item?.actions) ? item.actions : [];
      if (!actions.length) addUnique(errors, 'item.table_edit.empty');
      if (actions.length > MAX_ACTIONS) addUnique(errors, 'item.table_edit.too_many');
      actions.forEach((action) => {
        if (!isPlainObject(action)) addUnique(errors, 'item.table_edit.action_invalid');
        if (hasUnexpectedFields(action, ['action', 'tableId', 'rowId', 'data'])) {
          addUnique(errors, 'item.field.unexpected');
        }
        const actionType = trim(action?.action).toLowerCase();
        if (!['init', 'insert', 'update', 'delete'].includes(actionType)) {
          addUnique(errors, 'item.table_edit.action_invalid');
        }
        const identifiers = [action?.tableId, action?.rowId]
          .map(value => normalizeText(value));
        if (identifiers.some(value => value.length > 200)) addUnique(errors, 'item.table_edit.identifier_too_long');
        if (identifiers.some(value => PROTOCOL_CONTROL_PATTERN.test(value))) {
          addUnique(errors, 'item.table_edit.protocol_control');
        }
        const tableTarget = tableTargets.find(item => item.id === trim(action?.tableId)) || null;
        if (!trim(action?.tableId)) addUnique(errors, 'item.table_edit.table_missing');
        else if (!tableTarget) addUnique(errors, 'item.table_edit.table_unknown');
        const rowId = trim(action?.rowId);
        if (rowId && (!tableTarget || !tableTarget.rowIds.includes(rowId))) {
          addUnique(errors, 'item.table_edit.row_unknown');
        }
        if (['update', 'delete'].includes(actionType) && !rowId) {
          addUnique(errors, 'item.table_edit.row_missing');
        }
        if (['init', 'insert'].includes(actionType) && rowId) {
          addUnique(errors, 'item.table_edit.row_unexpected');
        }
        if (['init', 'insert', 'update'].includes(actionType) && !isPlainObject(action?.data)) {
          addUnique(errors, 'item.table_edit.data_invalid');
        }
        if (actionType === 'delete' && Object.hasOwn(action || {}, 'data')) {
          addUnique(errors, 'item.table_edit.data_unexpected');
        }
        if (Object.hasOwn(action || {}, 'data')) {
          const inspected = cloneJsonValue(action.data);
          if (!inspected.ok) addUnique(errors, 'item.table_edit.data_invalid');
          if (inspected.ok && PROTOCOL_CONTROL_PATTERN.test(inspected.serialized)) {
            addUnique(errors, 'item.table_edit.protocol_control');
          }
        }
      });
    }
    if (kind === 'variable_update') {
      const operations = Array.isArray(item?.operations) ? item.operations : [];
      if (!operations.length) addUnique(errors, 'item.variable_update.empty');
      if (operations.length > MAX_OPERATIONS) addUnique(errors, 'item.variable_update.too_many');
      operations.forEach((operation) => {
        const op = trim(operation?.op).toLowerCase();
        if (!['replace', 'delta', 'add', 'remove', 'move'].includes(op)) addUnique(errors, 'item.variable_update.op_invalid');
        const path = trim(operation?.path);
        const from = trim(operation?.from);
        if (!path.startsWith('/')) addUnique(errors, 'item.variable_update.path_invalid');
        if (op === 'move' && !from.startsWith('/')) addUnique(errors, 'item.variable_update.from_invalid');
        if (PROTOCOL_CONTROL_PATTERN.test(path) || PROTOCOL_CONTROL_PATTERN.test(from)) {
          addUnique(errors, 'item.variable_update.protocol_control');
        }
        if (['replace', 'delta', 'add'].includes(op) && !Object.hasOwn(operation || {}, 'value')) {
          addUnique(errors, 'item.variable_update.value_missing');
        }
        if (op === 'delta' && !Number.isFinite(Number(operation?.value))) {
          addUnique(errors, 'item.variable_update.delta_invalid');
        }
        if (Object.hasOwn(operation || {}, 'value')) {
          const inspected = cloneJsonValue(operation.value);
          if (!inspected.ok) addUnique(errors, 'item.variable_update.value_invalid');
          if (inspected.ok && PROTOCOL_CONTROL_PATTERN.test(inspected.serialized)) {
            addUnique(errors, 'item.variable_update.protocol_control');
          }
        }
      });
    }
    if (kind === 'summary') {
      const content = normalizeContent(item?.content);
      total.value += content.length;
      if (!content) addUnique(errors, 'item.summary.empty');
      if (content.length > MAX_CONTENT_CHARS) addUnique(errors, 'item.summary.too_long');
      if (PROTOCOL_CONTROL_PATTERN.test(content)) addUnique(errors, 'item.content.protocol_control');
    }
  });

  const primaryKind = mode === 'moment_comment' ? 'moment_comment' : 'chat';
  if ((counts.get(primaryKind) || 0) !== 1) addUnique(errors, 'items.primary_count');
  ['moment_post', 'image_prompt', 'table_edit', 'variable_update', 'summary'].forEach((kind) => {
    if ((counts.get(kind) || 0) > 1) addUnique(errors, `items.${kind}.duplicate`);
  });
  if ((counts.get('private_chat') || 0) > 3) addUnique(errors, 'items.private_chat.too_many');
  if ((counts.get('group_chat') || 0) > 1) addUnique(errors, 'items.group_chat.too_many');
  if (total.value > MAX_TOTAL_CONTENT_CHARS) addUnique(errors, 'items.content_too_long');
  if (!trim(source?.source?.transport)) addUnique(errors, 'source.transport_missing');
  return { ok: errors.length === 0, errors };
};

const buildNormalizedMessages = ({
  messages,
  requireSpeaker,
  speakers,
  fallbackSpeaker,
  allowedTypes,
  stickerKeywords,
  errors,
} = {}) => (Array.isArray(messages) ? messages : []).map((message) => {
  if (!isPlainObject(message)) addUnique(errors, 'item.message.invalid');
  const type = trim(message?.type, 'text').toLowerCase();
  const allowedFields = ['type', 'content', 'artist', 'time', ...(requireSpeaker ? ['speakerId'] : [])];
  if (hasUnexpectedFields(message, allowedFields)) addUnique(errors, 'item.field.unexpected');
  if (allowedTypes.length > 1 && !trim(message?.type)) addUnique(errors, 'item.type.missing');
  if (!allowedTypes.includes(type)) addUnique(errors, 'item.type.unsupported');
  if (type !== 'music' && Object.hasOwn(message || {}, 'artist')) addUnique(errors, 'item.artist.unexpected');
  const speaker = requireSpeaker ? findIdentity(speakers, message?.speakerId) : fallbackSpeaker;
  if (!speaker) addUnique(errors, 'item.speaker.unknown');
  const content = normalizeContent(message?.content);
  if (type === 'sticker' && (!stickerKeywords.length || !stickerKeywords.includes(content))) {
    addUnique(errors, 'item.sticker.unknown');
  }
  return {
    type,
    speaker: speaker || { id: '', name: '' },
    content,
    ...(type === 'music' ? { artist: normalizeContent(message?.artist) } : {}),
    time: trim(message?.time),
  };
});

const buildNormalizedComments = ({ comments, authors, requireAuthor, fallbackAuthor, errors } = {}) => (
  Array.isArray(comments) ? comments : []
).map((comment) => {
  if (!isPlainObject(comment)) addUnique(errors, 'item.comment.invalid');
  const allowedFields = ['content', 'replyTo', 'replyToAuthor', 'author', ...(requireAuthor ? ['authorId'] : [])];
  if (hasUnexpectedFields(comment, allowedFields)) addUnique(errors, 'item.field.unexpected');
  const suppliedAuthor = normalizeText(comment?.author);
  const suppliedReplyToAuthor = normalizeText(comment?.replyToAuthor);
  if (PROTOCOL_CONTROL_PATTERN.test(suppliedAuthor)) addUnique(errors, 'item.author.protocol_control');
  if (PROTOCOL_CONTROL_PATTERN.test(suppliedReplyToAuthor)) {
    addUnique(errors, 'item.comment.reference_protocol_control');
  }
  const resolvedAuthor = requireAuthor
    ? findIdentity(authors, comment?.authorId)
    : (fallbackAuthor || (trim(comment?.author) ? { id: '', name: normalizeName(comment.author) } : null));
  if (!resolvedAuthor) addUnique(errors, 'item.author.unknown');
  return {
    author: resolvedAuthor || { id: '', name: '' },
    content: normalizeContent(comment?.content),
    replyTo: normalizeReference(comment?.replyTo),
    replyToAuthor: normalizeName(comment?.replyToAuthor),
  };
});

const normalizeTableActions = (actions, errors, tableTargets = []) => (
  Array.isArray(actions) ? actions : []
).map((action) => {
  const source = isPlainObject(action) ? action : {};
  if (!isPlainObject(action)) addUnique(errors, 'item.table_edit.action_invalid');
  if (hasUnexpectedFields(source, ['action', 'tableId', 'rowId', 'rowIndex', 'data'])) {
    addUnique(errors, 'item.field.unexpected');
  }

  const actionType = trim(source.action).toLowerCase();
  if (!['init', 'insert', 'update', 'delete'].includes(actionType)) {
    addUnique(errors, 'item.table_edit.action_invalid');
  }
  const tableId = trim(source.tableId);
  const tableTarget = tableTargets.find(item => item.id === tableId) || null;
  if (!tableId) addUnique(errors, 'item.table_edit.table_missing');
  else if (!tableTarget) addUnique(errors, 'item.table_edit.table_unknown');

  const suppliedRowId = trim(source.rowId);
  const hasRowIndex = Object.hasOwn(source, 'rowIndex');
  const rowIndexValid = !hasRowIndex || (Number.isInteger(source.rowIndex) && source.rowIndex >= 0);
  if (!rowIndexValid) addUnique(errors, 'item.table_edit.index_invalid');
  const indexedRowId = tableTarget && rowIndexValid && hasRowIndex
    ? trim(tableTarget.rowIds[source.rowIndex])
    : '';
  if (hasRowIndex && rowIndexValid && !indexedRowId) addUnique(errors, 'item.table_edit.row_unknown');
  if (suppliedRowId && (!tableTarget || !tableTarget.rowIds.includes(suppliedRowId))) {
    addUnique(errors, 'item.table_edit.row_unknown');
  }
  if (suppliedRowId && indexedRowId && suppliedRowId !== indexedRowId) {
    addUnique(errors, 'item.table_edit.row_mismatch');
  }
  const rowId = suppliedRowId || indexedRowId;
  if (['update', 'delete'].includes(actionType) && !rowId) {
    addUnique(errors, 'item.table_edit.row_missing');
  }
  if (['init', 'insert'].includes(actionType) && (suppliedRowId || hasRowIndex)) {
    addUnique(errors, 'item.table_edit.row_unexpected');
  }

  const hasData = Object.hasOwn(source, 'data');
  const cloned = cloneJsonValue(source.data);
  if (hasData && !cloned.ok) addUnique(errors, 'item.table_edit.data_invalid');
  if (hasData && jsonContainsProtocolControl(source.data)) {
    addUnique(errors, 'item.table_edit.protocol_control');
  }
  if (['init', 'insert', 'update'].includes(actionType) && (!hasData || !isPlainObject(source.data))) {
    addUnique(errors, 'item.table_edit.data_invalid');
  }
  if (actionType === 'delete' && hasData) addUnique(errors, 'item.table_edit.data_unexpected');

  const identifiers = [tableId, suppliedRowId].map(value => normalizeText(value));
  if (identifiers.some(value => PROTOCOL_CONTROL_PATTERN.test(value))) {
    addUnique(errors, 'item.table_edit.protocol_control');
  }
  return {
    action: actionType,
    tableId,
    ...(rowId ? { rowId } : {}),
    ...(hasData ? { data: cloned.value } : {}),
  };
});

const normalizeVariableOperations = (operations, errors) => (Array.isArray(operations) ? operations : []).map((operation) => {
  if (!isPlainObject(operation)) addUnique(errors, 'item.variable_update.op_invalid');
  if (hasUnexpectedFields(operation, ['op', 'path', 'from', 'value'])) addUnique(errors, 'item.field.unexpected');
  const cloned = cloneJsonValue(operation?.value);
  if (Object.hasOwn(operation || {}, 'value') && !cloned.ok) addUnique(errors, 'item.variable_update.value_invalid');
  if (
    PROTOCOL_CONTROL_PATTERN.test(normalizeText(operation?.path))
    || PROTOCOL_CONTROL_PATTERN.test(normalizeText(operation?.from))
    || (Object.hasOwn(operation || {}, 'value') && jsonContainsProtocolControl(operation.value))
  ) {
    addUnique(errors, 'item.variable_update.protocol_control');
  }
  return {
    op: trim(operation?.op).toLowerCase(),
    path: trim(operation?.path),
    ...(trim(operation?.from) ? { from: trim(operation.from) } : {}),
    ...(Object.hasOwn(operation || {}, 'value') ? { value: cloned.value } : {}),
  };
});

export const buildPhoneReplyBatchIr = ({
  args = {},
  target = {},
  capabilities = {},
  allowedItemTypes = DEFAULT_ITEM_TYPES,
  allowedStickerKeywords = [],
  source = {},
} = {}) => {
  const errors = [];
  if (!isPlainObject(args) || Object.keys(args).some(key => key !== 'items')) addUnique(errors, 'args.field.unexpected');
  const mode = trim(target?.mode).toLowerCase();
  const caps = normalizeCapabilities(capabilities);
  const allowedTypes = normalizeAllowedItemTypes(allowedItemTypes);
  const stickerKeywords = normalizeStickerKeywords(allowedStickerKeywords);
  const members = normalizeIdentityList(target?.members);
  const momentAuthors = normalizeIdentityList(target?.momentAuthors);
  const privateTargets = normalizeIdentityList(target?.privateTargets);
  const groupTargets = normalizeGroupTargetList(target?.groupTargets);
  const tableTargets = normalizeTableTargetList(target?.tableTargets);
  const primarySpeaker = normalizeIdentity({
    id: target?.speakerId || target?.sessionId,
    name: target?.speakerName || target?.targetName,
  });
  const rawItems = Array.isArray(args?.items) ? args.items : [];
  const items = rawItems.map((item) => {
    const kind = trim(item?.kind).toLowerCase();
    if (!isPlainObject(item)) addUnique(errors, 'item.invalid');
    if (!PHONE_REPLY_IR_BATCH_ITEM_KINDS.includes(kind)) {
      addUnique(errors, 'item.kind.unsupported');
      return { kind };
    }
    if (kind === 'chat') {
      if (!STANDARD_MODES.has(mode)) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'messages'])) addUnique(errors, 'item.field.unexpected');
      return {
        kind,
        surface: mode,
        target: {
          sessionId: trim(target?.sessionId),
          name: normalizeName(target?.targetName),
          ...(mode === 'group_chat' ? { members } : {}),
        },
        messages: buildNormalizedMessages({
          messages: item?.messages,
          requireSpeaker: mode === 'group_chat',
          speakers: members,
          fallbackSpeaker: primarySpeaker,
          allowedTypes,
          stickerKeywords,
          errors,
        }),
      };
    }
    if (kind === 'moment_post') {
      if (!caps.momentPost || !STANDARD_MODES.has(mode)) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'posts'])) addUnique(errors, 'item.field.unexpected');
      const requireAuthor = mode === 'group_chat' || momentAuthors.length > 1;
      const fallbackAuthor = momentAuthors[0] || primarySpeaker;
      return {
        kind,
        posts: (Array.isArray(item?.posts) ? item.posts : []).map((post) => {
          if (!isPlainObject(post)) addUnique(errors, 'item.post.invalid');
          if (hasUnexpectedFields(post, ['authorId', 'content', 'time', 'views', 'likes', 'comments'])) {
            addUnique(errors, 'item.field.unexpected');
          }
          const author = requireAuthor ? findIdentity(momentAuthors, post?.authorId) : fallbackAuthor;
          if (!author) addUnique(errors, 'item.author.unknown');
          if (Object.hasOwn(post || {}, 'views') && (!Number.isInteger(post.views) || post.views < 0)) {
            addUnique(errors, 'item.moment_post.count_invalid');
          }
          if (Object.hasOwn(post || {}, 'likes') && (!Number.isInteger(post.likes) || post.likes < 0)) {
            addUnique(errors, 'item.moment_post.count_invalid');
          }
          if (Object.hasOwn(post || {}, 'comments')) {
            if (!Array.isArray(post.comments) || !post.comments.length) addUnique(errors, 'item.comments.empty');
            if (Array.isArray(post.comments) && post.comments.length > MAX_COMMENTS) {
              addUnique(errors, 'item.comments.too_many');
            }
          }
          return {
            author: author || { id: '', name: '' },
            content: normalizeContent(post?.content),
            time: trim(post?.time),
            views: Number.isInteger(post?.views) && post.views >= 0 ? post.views : 0,
            likes: Number.isInteger(post?.likes) && post.likes >= 0 ? post.likes : 0,
            comments: buildNormalizedComments({
              comments: post?.comments,
              authors: [],
              requireAuthor: false,
              fallbackAuthor: null,
              errors,
            }),
          };
        }),
      };
    }
    if (kind === 'moment_comment') {
      if (mode !== 'moment_comment') addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'comments'])) addUnique(errors, 'item.field.unexpected');
      const requireAuthor = momentAuthors.length !== 1;
      return {
        kind,
        momentId: trim(target?.momentId),
        comments: buildNormalizedComments({
          comments: item?.comments,
          authors: momentAuthors,
          requireAuthor,
          fallbackAuthor: momentAuthors[0] || primarySpeaker,
          errors,
        }),
      };
    }
    if (kind === 'private_chat') {
      if (mode !== 'moment_comment' || !caps.momentCommentSideChats) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'targetId', 'messages'])) addUnique(errors, 'item.field.unexpected');
      const resolvedTarget = findIdentity(privateTargets, item?.targetId);
      if (!resolvedTarget) addUnique(errors, 'item.target.unknown');
      return {
        kind,
        surface: 'private_chat',
        target: resolvedTarget || { id: '', name: '' },
        messages: buildNormalizedMessages({
          messages: item?.messages,
          requireSpeaker: false,
          fallbackSpeaker: resolvedTarget,
          allowedTypes,
          stickerKeywords,
          errors,
        }),
      };
    }
    if (kind === 'group_chat') {
      if (mode !== 'moment_comment' || !caps.momentCommentSideChats) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'targetId', 'messages'])) addUnique(errors, 'item.field.unexpected');
      const resolvedTarget = groupTargets.find(group => group.id === trim(item?.targetId)) || null;
      if (!resolvedTarget) addUnique(errors, 'item.target.unknown');
      return {
        kind,
        surface: 'group_chat',
        target: resolvedTarget || { id: '', name: '', members: [] },
        messages: buildNormalizedMessages({
          messages: item?.messages,
          requireSpeaker: true,
          speakers: resolvedTarget?.members || [],
          fallbackSpeaker: null,
          allowedTypes: allowedTypes.filter(type => type !== 'transfer'),
          stickerKeywords,
          errors,
        }),
      };
    }
    if (kind === 'image_prompt') {
      if (!caps.imagePrompt) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'prompt'])) addUnique(errors, 'item.field.unexpected');
      return { kind, prompt: normalizeContent(item?.prompt) };
    }
    if (kind === 'table_edit') {
      if (!caps.tableEdit) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'actions'])) addUnique(errors, 'item.field.unexpected');
      return { kind, actions: normalizeTableActions(item?.actions, errors, tableTargets) };
    }
    if (kind === 'variable_update') {
      if (!caps.variableUpdate) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'operations'])) addUnique(errors, 'item.field.unexpected');
      return { kind, operations: normalizeVariableOperations(item?.operations, errors) };
    }
    if (kind === 'summary') {
      if (!caps.summary) addUnique(errors, 'item.kind.unsupported');
      if (hasUnexpectedFields(item, ['kind', 'content'])) addUnique(errors, 'item.field.unexpected');
      return { kind, content: normalizeContent(item?.content) };
    }
    return { kind };
  });

  const ir = {
    version: PHONE_REPLY_IR_VERSION,
    surface: BATCH_SURFACE,
    context: {
      mode,
      sessionId: trim(target?.sessionId),
      targetName: normalizeName(target?.targetName),
      ...(mode === 'moment_comment' ? { momentId: trim(target?.momentId) } : {}),
      userName: normalizeName(target?.userName, '我'),
      ...(tableTargets.length ? { tableTargets } : {}),
    },
    items,
    source: normalizeSource(source),
  };
  const validation = validatePhoneReplyBatchIr(ir, {
    expectedSessionId: trim(target?.sessionId),
  });
  validation.errors.forEach(error => addUnique(errors, error));
  return { ok: errors.length === 0, errors, ir: errors.length === 0 ? ir : null };
};

const serializeMessages = messages => (Array.isArray(messages) ? messages : []).map(message => ({
  speaker: normalizeName(message?.speaker?.name),
  content: serializePhoneMessageItemContent(message),
  time: trim(message?.time),
}));

const serializeComments = comments => (Array.isArray(comments) ? comments : []).map(comment => ({
  author: normalizeName(comment?.author?.name),
  content: normalizeContent(comment?.content),
  replyTo: normalizeReference(comment?.replyTo),
  replyToAuthor: normalizeName(comment?.replyToAuthor),
}));

const serializeTableActions = actions => (Array.isArray(actions) ? actions : []).map((action) => {
  const payload = {
    action: trim(action?.action).toLowerCase(),
    ...(trim(action?.tableId) ? { table_id: trim(action.tableId) } : {}),
    ...(trim(action?.rowId) ? { row_id: trim(action.rowId) } : {}),
    ...(Object.hasOwn(action || {}, 'data') ? { data: action.data } : {}),
  };
  return JSON.stringify(payload);
}).join('\n');

const serializeVariableOperations = operations => [
  '<json_patch>',
  JSON.stringify((Array.isArray(operations) ? operations : []).map(operation => ({
    op: trim(operation?.op).toLowerCase(),
    path: trim(operation?.path),
    ...(trim(operation?.from) ? { from: trim(operation.from) } : {}),
    ...(Object.hasOwn(operation || {}, 'value') ? { value: operation.value } : {}),
  }))),
  '</json_patch>',
].join('\n');

export const serializePhoneReplyBatchIr = (ir = {}, { expectedSessionId = '', timeMode = getChatTimeMode() } = {}) => {
  const validation = validatePhoneReplyBatchIr(ir, { expectedSessionId });
  if (!validation.ok) return { ...validation, raw: '' };
  const mode = trim(ir?.context?.mode).toLowerCase();
  const canonicalItems = ir.items.map((item) => {
    if (item.kind === 'chat') {
      return {
        surface: item.surface,
        payload: item.surface === 'group_chat'
          ? {
              groupName: item.target?.name,
              members: (item.target?.members || []).map(member => member.name),
              messages: serializeMessages(item.messages),
            }
          : {
              userName: ir.context?.userName,
              targetName: item.target?.name,
              messages: serializeMessages(item.messages),
            },
      };
    }
    if (item.kind === 'moment_post') {
      return {
        surface: 'moment_post',
        payload: {
          posts: item.posts.map(post => ({
            author: post.author?.name,
            content: post.content,
            time: post.time,
            views: post.views,
            likes: post.likes,
            comments: serializeComments(post.comments),
          })),
        },
      };
    }
    if (item.kind === 'moment_comment') {
      return {
        surface: 'moment_comment',
        payload: {
          momentId: item.momentId,
          comments: serializeComments(item.comments),
        },
      };
    }
    if (item.kind === 'private_chat') {
      return {
        surface: 'private_chat',
        payload: {
          userName: ir.context?.userName,
          targetName: item.target?.name,
          messages: serializeMessages(item.messages),
        },
      };
    }
    if (item.kind === 'group_chat') {
      return {
        surface: 'group_chat',
        payload: {
          groupName: item.target?.name,
          members: (item.target?.members || []).map(member => member.name),
          messages: serializeMessages(item.messages),
        },
      };
    }
    if (item.kind === 'image_prompt') return { kind: 'image_prompt', content: item.prompt };
    if (item.kind === 'table_edit') return { kind: 'table_edit', content: serializeTableActions(item.actions) };
    if (item.kind === 'variable_update') return { kind: 'variable_update', content: serializeVariableOperations(item.operations) };
    if (item.kind === 'summary') return { kind: 'summary', content: item.content };
    return { kind: item.kind };
  });
  const raw = serializeBuiltinPhoneBatch(canonicalItems, { mode, timeMode });

  if (STANDARD_MODES.has(mode)) {
    const contract = validateBuiltinPhoneFormat(raw, { surface: mode });
    if (!contract.valid) {
      return {
        ok: false,
        errors: contract.issues.map(issue => `canonical.${issue}`),
        raw: '',
      };
    }
    return { ok: true, errors: [], raw, contract };
  }

  const isolatedContracts = canonicalItems
    .filter(item => item?.surface)
    .map((item) => validateBuiltinPhoneFormat(
      serializeBuiltinPhoneFormat(item.surface, {...item.payload,timeMode}),
      { surface: item.surface },
    ));
  const failed = isolatedContracts.find(contract => !contract.valid);
  if (failed) {
    return {
      ok: false,
      errors: failed.issues.map(issue => `canonical.${issue}`),
      raw: '',
    };
  }
  return { ok: true, errors: [], raw, contracts: isolatedContracts };
};
