import { getChatTimeMode } from '../../utils/chat-time-policy.js';
import {
  serializeBuiltinPhoneFormat,
  validateBuiltinPhoneFormat,
} from '../../utils/builtin-phone-format-contract.js';

export const PHONE_REPLY_IR_VERSION = 'phone.reply.ir.v1';
export const PHONE_REPLY_IR_PRIVATE_TOOL_NAME = 'emit_private_reply';
export const PHONE_REPLY_IR_PRIVATE_ITEM_TYPES = Object.freeze([
  'text',
  'sticker',
  'voice',
  'transfer',
  'music',
  'image',
]);

const PRIVATE_SURFACE = 'private_chat';
const DEFAULT_PRIVATE_ITEM_TYPES = Object.freeze(['text']);
const MAX_PRIVATE_ITEMS = 12;
const MAX_ITEM_CONTENT_CHARS = 4000;
const MAX_TOTAL_CONTENT_CHARS = 16000;
const TIME_PATTERN = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const PROTOCOL_CONTROL_PATTERN = /(?:MiPhone_(?:start|end)|msg_(?:start|end)|moment_(?:start|end|reply_start|reply_end)|<\s*\/?\s*[^>\n]*的私聊\s*>|<\s*\/?\s*群聊\s*[:：]|<\s*\/?\s*(?:成员|聊天内容|tableEdit|UpdateVariable|image_prompt|details|summary)\b)/iu;
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

const normalizeSource = (source = {}) => ({
  transport: trim(source?.transport, 'provider_fc'),
  provider: trim(source?.provider),
  model: trim(source?.model),
});

const normalizeAllowedItemTypes = (value = DEFAULT_PRIVATE_ITEM_TYPES) => {
  const source = Array.isArray(value) ? value : DEFAULT_PRIVATE_ITEM_TYPES;
  const allowed = new Set(PHONE_REPLY_IR_PRIVATE_ITEM_TYPES);
  const out = [];
  source.forEach((item) => {
    const type = trim(item).toLowerCase();
    if (allowed.has(type) && !out.includes(type)) out.push(type);
  });
  return out.length ? out : DEFAULT_PRIVATE_ITEM_TYPES.slice();
};

const normalizeStickerKeywords = (value = []) => {
  const out = [];
  (Array.isArray(value) ? value : []).forEach((item) => {
    const keyword = normalizeContent(item).replace(/[\[\]\r\n]/g, '').trim();
    if (keyword && !out.includes(keyword)) out.push(keyword);
  });
  return out;
};

const addUnique = (errors, value) => {
  if (value && !errors.includes(value)) errors.push(value);
};

export const buildPrivateReplyProviderToolDefinition = ({
  timeMode = getChatTimeMode(),
  allowedItemTypes = DEFAULT_PRIVATE_ITEM_TYPES,
  allowedStickerKeywords = [],
} = {}) => {
  const itemTypes = normalizeAllowedItemTypes(allowedItemTypes);
  const stickerKeywords = normalizeStickerKeywords(allowedStickerKeywords);
  const supportsSpecialItems = itemTypes.some(type => type !== 'text');
  const contentNotes = [
    'Message payload only; never include MiPhone tags, target names, or wrapper prose.',
    itemTypes.includes('sticker')
      ? (stickerKeywords.length
        ? `For sticker, use exactly one allowed keyword: ${stickerKeywords.join(', ')}.`
        : 'Sticker is unavailable unless an allowed keyword is supplied.')
      : '',
    itemTypes.includes('music') ? 'For music, content is the song title and artist is required.' : '',
  ].filter(Boolean);
  const buildItemSchema = (itemType, { includeType = true } = {}) => ({
    type: 'object',
    additionalProperties: false,
    required: [
      ...(includeType ? ['type'] : []),
      'content',
      ...(itemType === 'music' ? ['artist'] : []),
    ],
    properties: {
      ...(includeType
        ? {
            type: {
              const: itemType,
              description: 'Message type.',
            },
          }
        : {}),
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ITEM_CONTENT_CHARS,
        description: contentNotes.join(' '),
      },
      ...(itemType === 'music'
        ? {
            artist: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description: 'Music artist.',
            },
          }
        : {}),
      ...(timeMode==='ai'?{time: {
        type: 'string',
        pattern: '^(?:[01]?\\d|2[0-3]):[0-5]\\d$',
        description: 'Optional 24-hour display time such as 22:12.',
      }}:{}),
    },
  });
  const itemSchema = itemTypes.length > 1
    ? { oneOf: itemTypes.map(itemType => buildItemSchema(itemType)) }
    : buildItemSchema(itemTypes[0], { includeType: supportsSpecialItems });
  return {
    type: 'function',
    function: {
      name: PHONE_REPLY_IR_PRIVATE_TOOL_NAME,
      description: 'Return one ordered private-chat reply for the already frozen current contact. Do not choose a target or speaker.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_PRIVATE_ITEMS,
            description: 'Ordered messages spoken by the current contact.',
            items: itemSchema,
          },
        },
      },
    },
  };
};

export const validatePhoneReplyIr = (ir = {}, {
  expectedSurface = '',
  expectedSessionId = '',
} = {}) => {
  const errors = [];
  const source = isPlainObject(ir) ? ir : {};
  if (trim(source.version) !== PHONE_REPLY_IR_VERSION) addUnique(errors, 'version.unsupported');
  if (trim(source.surface) !== PRIVATE_SURFACE) addUnique(errors, 'surface.unsupported');
  if (expectedSurface && trim(source.surface) !== trim(expectedSurface)) {
    addUnique(errors, 'surface.mismatch');
  }

  const target = isPlainObject(source.target) ? source.target : {};
  const sessionId = trim(target.sessionId);
  if (!sessionId) addUnique(errors, 'target.session_missing');
  if (!normalizeName(target.name)) addUnique(errors, 'target.name_missing');
  if (expectedSessionId && sessionId !== trim(expectedSessionId)) {
    addUnique(errors, 'target.session_mismatch');
  }

  const items = Array.isArray(source.items) ? source.items : [];
  if (!items.length) addUnique(errors, 'items.empty');
  if (items.length > MAX_PRIVATE_ITEMS) addUnique(errors, 'items.too_many');
  let totalContentChars = 0;
  items.forEach((item) => {
    const type = trim(item?.type, 'text').toLowerCase();
    if (!isPlainObject(item) || !PHONE_REPLY_IR_PRIVATE_ITEM_TYPES.includes(type)) {
      addUnique(errors, 'item.type.unsupported');
    }
    const speaker = isPlainObject(item?.speaker) ? item.speaker : {};
    if (!normalizeName(speaker.name)) addUnique(errors, 'item.speaker_missing');
    const content = normalizeContent(item?.content);
    totalContentChars += content.length;
    if (!content) addUnique(errors, 'item.content.empty');
    if (content.length > MAX_ITEM_CONTENT_CHARS) addUnique(errors, 'item.content.too_long');
    if (PROTOCOL_CONTROL_PATTERN.test(content)) addUnique(errors, 'item.content.protocol_control');
    if (type === 'text' && SPECIAL_TOKEN_PATTERN.test(content)) {
      addUnique(errors, 'item.content.special_token');
    }
    if (type !== 'text' && SPECIAL_PAYLOAD_CONTROL_PATTERN.test(content)) {
      addUnique(errors, 'item.content.special_control');
    }
    const artist = normalizeContent(item?.artist);
    if (type === 'music' && !artist) addUnique(errors, 'item.music.artist_missing');
    if (artist && (artist.length > 200 || SPECIAL_PAYLOAD_CONTROL_PATTERN.test(artist) || artist.includes('$'))) {
      addUnique(errors, 'item.music.artist_invalid');
    }
    if (type === 'music' && content.includes('$')) addUnique(errors, 'item.music.title_invalid');
    const time = trim(item?.time);
    if (time && !TIME_PATTERN.test(time)) addUnique(errors, 'item.time.invalid');
  });
  if (totalContentChars > MAX_TOTAL_CONTENT_CHARS) addUnique(errors, 'items.content_too_long');

  const irSource = isPlainObject(source.source) ? source.source : {};
  if (!trim(irSource.transport)) addUnique(errors, 'source.transport_missing');
  return { ok: errors.length === 0, errors };
};

export const buildPrivateChatPhoneReplyIr = ({
  args = {},
  target = {},
  source = {},
  allowedItemTypes = DEFAULT_PRIVATE_ITEM_TYPES,
  allowedStickerKeywords = [],
} = {}) => {
  const messages = Array.isArray(args?.messages) ? args.messages : [];
  const allowedTypes = normalizeAllowedItemTypes(allowedItemTypes);
  const stickerKeywords = normalizeStickerKeywords(allowedStickerKeywords);
  const policyErrors = [];
  if (
    isPlainObject(args)
    && Object.keys(args).some(key => key !== 'messages')
  ) {
    addUnique(policyErrors, 'args.field.unexpected');
  }
  messages.forEach((message) => {
    if (!isPlainObject(message)) return;
    const type = trim(message?.type, 'text').toLowerCase();
    if (allowedTypes.length > 1 && !trim(message?.type)) {
      addUnique(policyErrors, 'item.type.missing');
    }
    if (Object.keys(message).some(key => !['type', 'content', 'artist', 'time'].includes(key))) {
      addUnique(policyErrors, 'item.field.unexpected');
    }
    if (type !== 'music' && Object.hasOwn(message, 'artist')) {
      addUnique(policyErrors, 'item.artist.unexpected');
    }
  });
  const targetName = normalizeName(target?.targetName);
  const speakerName = normalizeName(target?.speakerName, targetName);
  const ir = {
    version: PHONE_REPLY_IR_VERSION,
    surface: PRIVATE_SURFACE,
    target: {
      sessionId: trim(target?.sessionId),
      name: targetName,
    },
    items: messages.map(message => ({
      type: trim(message?.type, 'text').toLowerCase(),
      speaker: {
        id: trim(target?.speakerId),
        name: speakerName,
      },
      content: normalizeContent(message?.content),
      ...(trim(message?.type, 'text').toLowerCase() === 'music'
        ? { artist: normalizeContent(message?.artist) }
        : {}),
      time: trim(message?.time),
    })),
    source: normalizeSource(source),
  };
  const validation = validatePhoneReplyIr(ir, {
    expectedSurface: PRIVATE_SURFACE,
    expectedSessionId: trim(target?.sessionId),
  });
  ir.items.forEach((item) => {
    if (!allowedTypes.includes(item.type)) addUnique(policyErrors, 'item.type.unsupported');
    if (
      item.type === 'sticker'
      && (!stickerKeywords.length || !stickerKeywords.includes(item.content))
    ) {
      addUnique(policyErrors, 'item.sticker.unknown');
    }
  });
  const errors = [...validation.errors];
  policyErrors.forEach(error => addUnique(errors, error));
  return {
    ok: errors.length === 0,
    errors,
    ir: errors.length === 0 ? ir : null,
  };
};

export const serializePhoneMessageItemContent = (item = {}) => {
  const type = trim(item?.type, 'text').toLowerCase();
  const content = normalizeContent(item?.content);
  if (type === 'sticker') return `[bqb-${content}]`;
  if (type === 'voice') return `[yy-${content}]`;
  if (type === 'transfer') return `[zz-${content}]`;
  if (type === 'music') return `[music-${content}$${normalizeContent(item?.artist)}]`;
  if (type === 'image') return `[img-${content}]`;
  return content;
};

export const serializePhoneReplyIr = (ir = {}, {
  timeMode = getChatTimeMode(),
  userName = '我',
  expectedSessionId = '',
} = {}) => {
  const validation = validatePhoneReplyIr(ir, {
    expectedSurface: PRIVATE_SURFACE,
    expectedSessionId,
  });
  if (!validation.ok) return { ...validation, raw: '' };

  const raw = serializeBuiltinPhoneFormat(PRIVATE_SURFACE, {
    timeMode,
    userName: normalizeName(userName, '我'),
    targetName: normalizeName(ir.target?.name, '联系人名'),
    messages: ir.items.map(item => ({
      speaker: normalizeName(item?.speaker?.name, ir.target?.name),
      content: serializePhoneMessageItemContent(item),
      time: trim(item?.time),
    })),
  });
  const contract = validateBuiltinPhoneFormat(raw, { surface: PRIVATE_SURFACE });
  if (!contract.valid) {
    return {
      ok: false,
      errors: contract.issues.map(issue => `canonical.${issue}`),
      raw: '',
    };
  }
  return { ok: true, errors: [], raw, contract };
};
