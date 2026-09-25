/**
 * 简易会话/消息存储（前端），可扩展到 Tauri FS
 */

import { logger } from '../utils/logger.js';
import { makeScopedKey, normalizeScopeId } from './store-scope.js';
import { appSettings } from './app-settings.js';
const MAX_PERSIST_MESSAGES_PER_SESSION = 400;
const MAX_PERSIST_TOTAL_TEXT_CHARS_PER_SESSION = 600_000;
const MAX_PERSIST_ARCHIVES_PER_SESSION = 80;
const MAX_PERSIST_ARCHIVE_MESSAGES = 400;
const MAX_PERSIST_SUMMARIES_PER_SESSION = 120;
const MAX_PERSIST_STRING_CHARS = 180_000;
const MAX_PERSIST_RAW_SOURCE_CHARS = 600_000;
const MAX_PERSIST_DATA_URL_CHARS = 4096;
const MAX_PERSIST_FIELD_INLINE_CHARS = MAX_PERSIST_STRING_CHARS;
const MAX_PERSIST_DERIVED_RICH_CONTENT_CHARS = 16_000;
const PERSIST_FIELD_PREVIEW_CHARS = 4000;
const V2_SIDECAR_FIELD_CHUNK_CHARS = 160_000;
const MAX_RAW_ORIGINAL_AUTOLOAD = 5;
const CHAT_STORE_V2_VERSION = 1;
const V2_PART_MESSAGE_LIMIT = 160;
const V2_PART_CHAR_LIMIT = 320_000;
const V2_RECENT_PARTS = 2;
const MESSAGE_FIELD_REF_VERSION = 1;
const MESSAGE_FIELD_REF_KIND = 'chat_store_v2_field';
const V2_SIDECAR_FIELDS = ['content', 'raw', 'rawSource', 'raw_source'];

const isConversationMessage = msg =>
  msg && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system');

const isDataUrl = s => typeof s === 'string' && s.startsWith('data:') && s.length > MAX_PERSIST_DATA_URL_CHARS;
const isCreativeAssistant = msg => msg?.role === 'assistant' && msg?.meta?.renderRich;
const DEFAULT_CHAT_BUBBLE_COLOR = '#c9c9c9';
const DEFAULT_CHAT_TEXT_COLOR = '#1F2937';
const DEFAULT_DARK_CHAT_BUBBLE_COLOR = '#000000';
const DEFAULT_DARK_CHAT_TEXT_COLOR = '#ffffff';

const normalizeChatColorMode = (value, fallback = 'theme') => {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'custom' ? 'custom' : fallback;
};

const isDarkThemeMode = () => String(document?.body?.dataset?.themeMode || '').trim().toLowerCase() === 'dark';
const isLegacyLightDefaultColor = (value, kind = 'bubble') => {
  const raw = String(value || '').trim().toLowerCase();
  return kind === 'text'
    ? raw === DEFAULT_CHAT_TEXT_COLOR.toLowerCase()
    : raw === DEFAULT_CHAT_BUBBLE_COLOR.toLowerCase();
};
const isLegacyDarkDefaultColor = (value, kind = 'bubble') => {
  const raw = String(value || '').trim().toLowerCase();
  return kind === 'text'
    ? raw === DEFAULT_DARK_CHAT_TEXT_COLOR.toLowerCase()
    : raw === DEFAULT_DARK_CHAT_BUBBLE_COLOR.toLowerCase();
};
const isThemeManagedChatDefaultColor = (value, kind = 'bubble') =>
  isLegacyLightDefaultColor(value, kind) || isLegacyDarkDefaultColor(value, kind);

const inferChatColorMode = (input = {}, fallback = 'theme') => {
  const explicit = String(input?.chatColorMode || input?.chatDefaultColorMode || '').trim().toLowerCase();
  if (explicit === 'custom' || explicit === 'theme') return explicit;
  const bubble = String(input?.bubbleColor || input?.chatDefaultBubbleColor || '').trim();
  const text = String(input?.textColor || input?.chatDefaultTextColor || '').trim();
  if (!bubble && !text) return fallback;
  return isThemeManagedChatDefaultColor(bubble, 'bubble') && isThemeManagedChatDefaultColor(text, 'text')
    ? 'theme'
    : 'custom';
};

const getThemeAwareChatDefaults = () => (
  isDarkThemeMode()
    ? {
        bubbleColor: DEFAULT_DARK_CHAT_BUBBLE_COLOR,
        textColor: DEFAULT_DARK_CHAT_TEXT_COLOR,
      }
    : {
        bubbleColor: DEFAULT_CHAT_BUBBLE_COLOR,
        textColor: DEFAULT_CHAT_TEXT_COLOR,
      }
);

const getGlobalChatColorDefaults = () => {
  const settings = typeof appSettings.getStored === 'function' ? appSettings.getStored() : {};
  const themeDefaults = getThemeAwareChatDefaults();
  const mode = inferChatColorMode(settings, 'theme');
  const bubbleRaw = String(settings.chatDefaultBubbleColor || '').trim();
  const textRaw = String(settings.chatDefaultTextColor || '').trim();
  const bubble = (mode === 'custom' && bubbleRaw)
    ? bubbleRaw
    : themeDefaults.bubbleColor;
  const text = (mode === 'custom' && textRaw)
    ? textRaw
    : themeDefaults.textColor;
  return { bubbleColor: bubble, textColor: text, chatColorMode: mode };
};

const makeShardKey = (prefix = 't') => {
  const base = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  return `${prefix}_${base}`.replace(/[^a-zA-Z0-9_-]/g, '_');
};

const estimateMessageChars = msg => {
  if (!msg || typeof msg !== 'object') return 0;
  let total = 0;
  const pick = ['content', 'raw', 'rawSource', 'raw_source'];
  for (const key of pick) {
    if (typeof msg[key] === 'string') total += msg[key].length;
  }
  try {
    const meta = msg.meta;
    if (meta && typeof meta === 'object') {
      for (const key of Object.keys(meta)) {
        if (typeof meta[key] === 'string') total += meta[key].length;
      }
    }
  } catch {}
  return total;
};

const normalizeVariableSchema = (raw) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const typeRaw = String(input.type || 'string').trim().toLowerCase();
  const type = ['number', 'string', 'boolean', 'enum', 'array', 'object'].includes(typeRaw) ? typeRaw : 'string';
  const schema = {
    id: String(input.id || input.name || '').trim(),
    name: String(input.name || input.id || '').trim(),
    type,
    default: input.default,
    range: null,
    options: null,
    ui: null,
  };
  if (type === 'number' && input.range && typeof input.range === 'object') {
    const minRaw = input.range.min;
    const maxRaw = input.range.max;
    const minText = minRaw === null || minRaw === undefined ? '' : String(minRaw).trim();
    const maxText = maxRaw === null || maxRaw === undefined ? '' : String(maxRaw).trim();
    const hasMin = minText.length > 0;
    const hasMax = maxText.length > 0;
    const min = hasMin ? Number(minText) : null;
    const max = hasMax ? Number(maxText) : null;
    if (Number.isFinite(min) || Number.isFinite(max)) {
      schema.range = {
        min: Number.isFinite(min) ? min : null,
        max: Number.isFinite(max) ? max : null,
      };
    }
  }
  if (schema.range && schema.range.min === 0 && schema.range.max === 0) {
    const display = String(schema.ui?.display || '').toLowerCase();
    const defNum = Number(input.default);
    if (display === 'card' && Number.isFinite(defNum) && defNum !== 0) {
      schema.range = null;
    }
  }
  if (type === 'enum') {
    const options = Array.isArray(input.options) ? input.options.map(v => String(v)) : [];
    schema.options = options.filter(v => v.trim().length > 0);
  }
  if (input.ui && typeof input.ui === 'object') {
    const display = String(input.ui.display || '').trim().toLowerCase();
    const allowed = new Set(['card', 'chart', 'badge', 'progress', 'ring', 'hidden']);
    schema.ui = {
      display: allowed.has(display) ? display : 'card',
      label: input.ui.label ? String(input.ui.label) : '',
      color: input.ui.color ? String(input.ui.color) : '',
      icon: input.ui.icon ? String(input.ui.icon) : '',
      format: input.ui.format ? String(input.ui.format) : '',
    };
  }
  return schema;
};

const coerceVariableValue = (value, schema) => {
  if (!schema || typeof schema !== 'object') return value;
  const type = schema.type || 'string';
  const fallback = schema.default;
  const applyDefault = (val) => (val === undefined || val === null ? fallback : val);

  if (type === 'number') {
    const raw = typeof value === 'string' ? value.trim() : value;
    let num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num)) {
      num = Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
    }
    if (schema.range) {
      const min = schema.range.min;
      const max = schema.range.max;
      if (Number.isFinite(min)) num = Math.max(min, num);
      if (Number.isFinite(max)) num = Math.min(max, num);
    }
    return num;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value ?? '').trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    return Boolean(applyDefault(false));
  }
  if (type === 'enum') {
    const options = Array.isArray(schema.options) ? schema.options : [];
    const v = String(value ?? '');
    if (options.includes(v)) return v;
    const def = String(fallback ?? '');
    if (options.includes(def)) return def;
    return options.length ? options[0] : v;
  }
  if (type === 'array') {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      const list = value.split(',').map(v => v.trim()).filter(Boolean);
      if (list.length) return list;
    }
    return Array.isArray(fallback) ? fallback : [];
  }
  if (type === 'object') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  }
  const str = String(value ?? applyDefault('') ?? '');
  return str;
};

const snapshotMessage = msg => {
  if (!msg || typeof msg !== 'object') return null;
  const content = typeof msg.content === 'string' ? msg.content.slice(0, 4000) : '';
  return {
    id: msg.id || '',
    role: msg.role || '',
    content,
    timestamp: Number(msg.timestamp || 0) || Date.now(),
    time: msg.time || '',
    name: msg.name || '',
    type: msg.type || '',
    status: msg.status || '',
  };
};

const clampString = (value, max = MAX_PERSIST_STRING_CHARS) => {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
};

const buildPersistPreview = (value, max = PERSIST_FIELD_PREVIEW_CHARS) => {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
};

const makeMessageFieldId = (message, field) => {
  const safeField = String(field || 'field').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'field';
  const safeMessageId = String(message?.id || 'message').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'message';
  const suffix = makeShardKey('f').slice(2);
  return `f_${safeField}_${safeMessageId}_${suffix}`.slice(0, 96);
};

const makeMessageFieldChunkId = (fieldId, index) => (
  `${String(fieldId || '').slice(0, 110)}_${String(index).padStart(4, '0')}`
);

const splitPersistFieldChunks = text => {
  const raw = String(text ?? '');
  if (raw.length <= V2_SIDECAR_FIELD_CHUNK_CHARS) return [raw];
  const chunks = [];
  for (let start = 0; start < raw.length; start += V2_SIDECAR_FIELD_CHUNK_CHARS) {
    chunks.push(raw.slice(start, start + V2_SIDECAR_FIELD_CHUNK_CHARS));
  }
  return chunks;
};

const getMessageFieldRefs = msg => (
  msg?.fieldRefs && typeof msg.fieldRefs === 'object' && !Array.isArray(msg.fieldRefs)
    ? msg.fieldRefs
    : null
);

const cloneMessageFieldRefs = refs => {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return null;
  const out = {};
  for (const [field, ref] of Object.entries(refs)) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    out[field] = { ...ref };
  }
  return Object.keys(out).length ? out : null;
};

const normalizeMessageFieldRef = (entry, thread, field, fieldId, text, preview, chunks = []) => {
  const out = {
    version: MESSAGE_FIELD_REF_VERSION,
    kind: MESSAGE_FIELD_REF_KIND,
    field,
    fieldId,
    sessionDir: entry?.dir || '',
    threadDir: thread?.threadDir || '',
    length: String(text ?? '').length,
    preview,
  };
  if (Array.isArray(chunks) && chunks.length > 1) out.chunks = chunks;
  return out;
};

const isSameMessageFieldRef = (a, b) => {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return String(a.fieldId || '') === String(b.fieldId || '') &&
    String(a.sessionDir || '') === String(b.sessionDir || '') &&
    String(a.threadDir || '') === String(b.threadDir || '');
};

const getRecoverableCreativeSourceLength = msg => {
  if (!isCreativeAssistant(msg)) return 0;
  for (const key of ['rawSource', 'raw_source', 'raw']) {
    if (typeof msg?.[key] === 'string' && msg[key].trim()) return msg[key].length;
  }
  const refs = getMessageFieldRefs(msg);
  for (const key of ['rawSource', 'raw_source', 'raw']) {
    const ref = refs?.[key];
    if (ref && typeof ref === 'object') return Number(ref.length || 1) || 1;
  }
  return 0;
};

const compactDerivedRenderRichContent = msg => {
  if (!msg || typeof msg !== 'object') return msg;
  if (!isCreativeAssistant(msg)) return msg;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.length <= MAX_PERSIST_DERIVED_RICH_CONTENT_CHARS) return msg;
  if (!getRecoverableCreativeSourceLength(msg)) return msg;
  msg.content = buildPersistPreview(content);
  const meta = msg.meta && typeof msg.meta === 'object' ? { ...msg.meta } : {};
  meta.contentPersistMode = 'derived-preview';
  meta.contentOriginalLength = content.length;
  msg.meta = meta;
  return msg;
};

const sanitizeMessageForPersist = (msg, options = {}) => {
  if (!msg || typeof msg !== 'object') return msg;
  const preserveLargeFields = Boolean(options?.preserveLargeFields);
  const out = { ...msg };

  // Never persist very large inline binaries (images/audio/avatars); they will explode KV/localStorage.
  if (isDataUrl(out.content)) out.content = '[binary omitted]';
  // Avoid duplicating avatars per message; avatar should be resolved from contacts/persona at render time.
  delete out.avatar;

  // Many message payloads include huge raw originals; we only keep bounded versions on disk.
  // Keep an explicit empty original: it distinguishes reasoning-only replies from
  // a missing sidecar, and lets the raw editor safely add a body after reload.
  if (typeof out.rawOriginal === 'string' && out.rawOriginal.length) delete out.rawOriginal;
  compactDerivedRenderRichContent(out);
  if (!preserveLargeFields) {
    if (typeof out.rawSource === 'string') out.rawSource = clampString(out.rawSource, MAX_PERSIST_RAW_SOURCE_CHARS);
    if (typeof out.raw_source === 'string' && typeof out.rawSource !== 'string') {
      out.raw_source = clampString(out.raw_source, MAX_PERSIST_RAW_SOURCE_CHARS);
    }
  }

  if (!preserveLargeFields) {
    if (typeof out.content === 'string') out.content = clampString(out.content);
    if (typeof out.raw === 'string') out.raw = clampString(out.raw);
  }

  try {
    if (out.meta && typeof out.meta === 'object') {
      const meta = { ...out.meta };
      if (isDataUrl(meta.url)) meta.url = '[binary omitted]';
      // Avoid persisting extremely large meta strings (rare but catastrophic on Android).
      for (const k of Object.keys(meta)) {
        if (typeof meta[k] === 'string') meta[k] = clampString(meta[k], 40_000);
      }
      out.meta = meta;
    }
  } catch {}

  return out;
};

const sliceTailWithinChars = (arr, getText, { maxItems, maxChars } = {}) => {
  const list = Array.isArray(arr) ? arr : [];
  const limitItems = Number.isFinite(maxItems) ? Math.max(0, Math.trunc(maxItems)) : list.length;
  const limitChars = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : Infinity;

  let total = 0;
  const picked = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (picked.length >= limitItems) break;
    const it = list[i];
    const t = getText(it);
    const len = t ? t.length : 0;
    if (total + len > limitChars && picked.length) break;
    total += len;
    picked.push(it);
  }
  picked.reverse();
  return picked;
};

const MAX_WALLPAPER_DATA_URL_CHARS = 200000;
const LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT = 450_000;

const parseArchiveTimestamp = (archiveId = '') => {
  const raw = String(archiveId || '').split('-')[0];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const formatArchiveTimestamp = (timestamp = Date.now()) => {
  const value = Number(timestamp || 0) || Date.now();
  const d = new Date(value);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(
    2,
    '0',
  )} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const makeRecoveredV2ArchiveMetadata = (archiveId = '', thread = {}) => {
  const id = String(archiveId || '').trim();
  if (!id) return null;
  const timestamp = parseArchiveTimestamp(id) || Number(thread?.lastMessageAt || 0) || Date.now();
  return {
    id,
    name: `存档 (${formatArchiveTimestamp(timestamp)})`,
    timestamp,
    messageCount: Number(thread?.total || 0) || 0,
    summaries: [],
    compactedSummary: null,
  };
};

const sanitizeSessionForPersist = (session, options = {}) => {
  if (!session || typeof session !== 'object') return session;
  const out = { ...session };
  delete out._loadedThreadKey;
  const skipMessages = Boolean(options?.skipMessages);

  const messagesRaw = skipMessages ? [] : Array.isArray(out.messages) ? out.messages : [];
  const sanitizedMessages = messagesRaw.map(sanitizeMessageForPersist);
  out.messages = skipMessages
    ? []
    : sliceTailWithinChars(
        sanitizedMessages,
        m => {
          if (!m || typeof m !== 'object') return '';
          const a = typeof m.content === 'string' ? m.content : '';
          const b = typeof m.raw === 'string' ? m.raw : '';
          return a + b;
        },
        { maxItems: MAX_PERSIST_MESSAGES_PER_SESSION, maxChars: MAX_PERSIST_TOTAL_TEXT_CHARS_PER_SESSION },
      );

  // If lastRead pointer points to a trimmed-away message, fall back to last existing message id.
  if (!skipMessages) {
    try {
      const lr = String(out.lastReadMessageId || '');
      if (lr) {
        const exists = out.messages.some(m => String(m?.id || '') === lr);
        if (!exists) {
          const last = out.messages.length ? out.messages[out.messages.length - 1] : null;
          out.lastReadMessageId = last?.id ? String(last.id) : '';
        }
      }
    } catch {}
  }

  if (typeof out.draft === 'string') out.draft = clampString(out.draft, 20_000);

  try {
    const s = Array.isArray(out.detachedSummaries) ? out.detachedSummaries : [];
    const normalized = s
      .map(it => {
        if (!it) return null;
        if (typeof it === 'string') return { at: 0, text: clampString(it, 6000) };
        const text = String(it.text || '').trim();
        if (!text) return null;
        const at = Number(it.at || 0) || 0;
        return { at, text: clampString(text, 6000) };
      })
      .filter(Boolean);
    out.detachedSummaries = normalized.slice(-MAX_PERSIST_SUMMARIES_PER_SESSION);
  } catch {}

  try {
    const clampCompacted = cs => {
      if (!cs || typeof cs !== 'object') return null;
      const text = String(cs.text || '').trim();
      if (!text) return null;
      const at = Number(cs.at || 0) || 0;
      const raw = typeof cs.raw === 'string' ? clampString(cs.raw, 120_000) : undefined;
      return raw === undefined ? { at, text: clampString(text, 24_000) } : { at, text: clampString(text, 24_000), raw };
    };
    out.compactedSummary = clampCompacted(out.compactedSummary);
    if (out.compactedSummaryLastRaw && typeof out.compactedSummaryLastRaw === 'object') {
      const at = Number(out.compactedSummaryLastRaw.at || 0) || 0;
      const raw = String(out.compactedSummaryLastRaw.raw || '').trim();
      out.compactedSummaryLastRaw = raw ? { at, raw: clampString(raw, 120_000) } : null;
    }
  } catch {}

  // Archives can easily duplicate huge message lists; keep bounded in persisted snapshot.
  try {
    const arcs = Array.isArray(out.archives) ? out.archives : [];
    const sanitized = arcs
      .map(a => {
        if (!a || typeof a !== 'object') return null;
        const arc = { ...a };
        const msgs = skipMessages
          ? []
          : Array.isArray(arc.messages)
          ? arc.messages.map(sanitizeMessageForPersist)
          : [];
        arc.messages = skipMessages
          ? []
          : sliceTailWithinChars(
              msgs,
              m => {
                if (!m || typeof m !== 'object') return '';
                const a = typeof m.content === 'string' ? m.content : '';
                const b = typeof m.raw === 'string' ? m.raw : '';
                return a + b;
              },
              { maxItems: MAX_PERSIST_ARCHIVE_MESSAGES, maxChars: MAX_PERSIST_TOTAL_TEXT_CHARS_PER_SESSION },
            );
        // Snapshot summaries in archive are optional; keep them small if present.
        if (Array.isArray(arc.summaries)) {
          arc.summaries = arc.summaries
            .map(it => {
              if (!it) return null;
              if (typeof it === 'string') return { at: 0, text: clampString(it, 6000) };
              const text = String(it.text || '').trim();
              if (!text) return null;
              const at = Number(it.at || 0) || 0;
              return { at, text: clampString(text, 6000) };
            })
            .filter(Boolean)
            .slice(-MAX_PERSIST_SUMMARIES_PER_SESSION);
        }
        if (arc.compactedSummary && typeof arc.compactedSummary === 'object') {
          const text = String(arc.compactedSummary.text || '').trim();
          if (text) {
            arc.compactedSummary = {
              at: Number(arc.compactedSummary.at || 0) || 0,
              text: clampString(text, 24_000),
              raw:
                typeof arc.compactedSummary.raw === 'string'
                  ? clampString(arc.compactedSummary.raw, 120_000)
                  : undefined,
            };
            if (arc.compactedSummary.raw === undefined) delete arc.compactedSummary.raw;
          } else {
            arc.compactedSummary = null;
          }
        }
        if (arc.compactedSummaryLastRaw && typeof arc.compactedSummaryLastRaw === 'object') {
          const raw = String(arc.compactedSummaryLastRaw.raw || '').trim();
          arc.compactedSummaryLastRaw = raw
            ? { at: Number(arc.compactedSummaryLastRaw.at || 0) || 0, raw: clampString(raw, 120_000) }
            : null;
        }
        return arc;
      })
      .filter(Boolean);
    sanitized.sort((a, b) => (Number(b?.timestamp || 0) || 0) - (Number(a?.timestamp || 0) || 0));
    out.archives = sanitized.slice(0, MAX_PERSIST_ARCHIVES_PER_SESSION);
  } catch {}

  try {
    const settings = out.settings;
    const wallpaper = settings?.wallpaper;
    if (wallpaper && typeof wallpaper === 'object') {
      const path = typeof wallpaper.path === 'string' ? wallpaper.path.trim() : '';
      const url = typeof wallpaper.url === 'string' ? wallpaper.url : '';
      const isDataUrl = url.startsWith('data:');
      const tooLarge = url.length > MAX_WALLPAPER_DATA_URL_CHARS;
      if (!path && (wallpaper.transient || (isDataUrl && tooLarge))) {
        out.settings = { ...(settings || {}), wallpaper: { ...wallpaper } };
        out.settings.wallpaper.url = '';
        out.settings.wallpaper.dataUrl = '';
      }
    }
  } catch {}

  return out;
};

const sanitizeStateForPersist = (state, options = {}) => {
  const src = state && typeof state === 'object' ? state : { sessions: {}, currentId: '' };
  const sessions = src.sessions && typeof src.sessions === 'object' ? src.sessions : {};
  const nextSessions = {};
  for (const [sid, session] of Object.entries(sessions)) {
    nextSessions[sid] = sanitizeSessionForPersist(session, options);
  }
  const globalVariables =
    src.globalVariables && typeof src.globalVariables === 'object' ? { ...src.globalVariables } : {};
  return { ...src, globalVariables, sessions: nextSessions };
};

const getScopeStorageId = (scopeId = '') => normalizeScopeId(scopeId) || 'default';
const getOwnRpSessionIdForScope = (scopeId = '') => `rp:${getScopeStorageId(scopeId)}`;
const isForeignRpSessionForScope = (sessionId = '', scopeId = '') => {
  const sid = String(sessionId || '').trim();
  if (!sid.startsWith('rp:')) return false;
  return sid !== getOwnRpSessionIdForScope(scopeId);
};
const isDefaultScopeId = (scopeId = '') => {
  const scope = normalizeScopeId(scopeId);
  return !scope || scope === 'default';
};

const resolveCurrentId = (state, scopeId = '') => {
  const sessions = state?.sessions && typeof state.sessions === 'object' ? state.sessions : {};
  const raw = String(state?.currentId || '').trim();
  if (
    raw &&
    Object.prototype.hasOwnProperty.call(sessions, raw) &&
    !isForeignRpSessionForScope(raw, scopeId)
  ) {
    return raw;
  }
  const ids = Object.keys(sessions).filter(id => !isForeignRpSessionForScope(id, scopeId));
  return ids.length ? ids[0] : '';
};

const isScopedDataMatch = (data, scopeId) => {
  try {
    const stored = String(data?.scopeId ?? '').trim();
    const scope = normalizeScopeId(scopeId);
    if (!stored) return isDefaultScopeId(scope); // legacy data without scope marker belongs to default/shared only
    return stored === scope;
  } catch {
    return true;
  }
};

const isQuotaError = err => {
  try {
    const name = String(err?.name || '');
    const msg = String(err?.message || '');
    // WebKit: code 22; Firefox: NS_ERROR_DOM_QUOTA_REACHED; Chrome: QuotaExceededError
    return (
      name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      Number(err?.code) === 22 ||
      /quota/i.test(msg)
    );
  } catch {
    return false;
  }
};

const getInvoker = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return g?.__TAURI__?.core?.invoke || g?.__TAURI__?.invoke || g?.__TAURI_INVOKE__ || g?.__TAURI_INTERNALS__?.invoke;
};

const waitForInvoker = async (timeoutMs = 5000) => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  // In plain browser dev mode, don't wait.
  if (!g?.__TAURI__) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const inv = getInvoker();
    if (typeof inv === 'function') return inv;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
};

const safeInvoke = async (cmd, args) => {
  const invoker = getInvoker() || (await waitForInvoker());
  if (typeof invoker !== 'function') throw new Error('Tauri invoke not available');
  return invoker(cmd, args);
};

class ChatStoreV2 {
  constructor({ scopeId = '' } = {}) {
    this.scopeId = normalizeScopeId(scopeId);
    this.index = { version: CHAT_STORE_V2_VERSION, sessions: {} };
    this.available = false;
    this._queue = Promise.resolve();
  }

  _normalizeIndex(raw) {
    if (!raw || typeof raw !== 'object') return { version: CHAT_STORE_V2_VERSION, sessions: {} };
    const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    return { version: CHAT_STORE_V2_VERSION, sessions: { ...sessions } };
  }

  _makeThread() {
    return {
      threadDir: makeShardKey('t'),
      parts: [],
      total: 0,
      lastMessageAt: 0,
      lastMessage: null,
      nextPart: 1,
    };
  }

  async init() {
    try {
      const data = await safeInvoke('chat_store_v2_read_index', { scope: this.scopeId });
      this.index = this._normalizeIndex(data);
      this.available = true;
      return true;
    } catch (err) {
      this.available = false;
      this.index = { version: CHAT_STORE_V2_VERSION, sessions: {} };
      logger.debug('chat store v2 init failed (可能非 Tauri)', err);
      return false;
    }
  }

  async setScope(scopeId = '') {
    this.scopeId = normalizeScopeId(scopeId);
    return this.init();
  }

  enqueue(task) {
    this._queue = this._queue.then(task).catch(err => {
      logger.warn('chat store v2 task failed', err);
    });
    return this._queue;
  }

  ensureSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    if (!this.index.sessions[sid]) {
      this.index.sessions[sid] = { dir: makeShardKey('s'), current: this._makeThread(), archives: {} };
    }
    const entry = this.index.sessions[sid];
    if (!entry.dir) entry.dir = makeShardKey('s');
    if (!entry.current || typeof entry.current !== 'object') entry.current = this._makeThread();
    if (!entry.archives || typeof entry.archives !== 'object') entry.archives = {};
    return entry;
  }

  _ensureThread(entry, archiveId = '') {
    if (!entry) return null;
    const aid = String(archiveId || '').trim();
    if (!aid) return entry.current;
    if (!entry.archives[aid]) entry.archives[aid] = this._makeThread();
    return entry.archives[aid];
  }

  getThread(sessionId, archiveId = '') {
    const entry = this.index.sessions[String(sessionId || '').trim()] || null;
    if (!entry) return null;
    const aid = String(archiveId || '').trim();
    return aid ? entry.archives?.[aid] || null : entry.current || null;
  }

  getThreadParts(sessionId, archiveId = '') {
    const thread = this.getThread(sessionId, archiveId);
    return Array.isArray(thread?.parts) ? thread.parts : [];
  }

  getThreadTotal(sessionId, archiveId = '') {
    const thread = this.getThread(sessionId, archiveId);
    return Number(thread?.total || 0) || 0;
  }

  getLastMessageSnapshot(sessionId) {
    const entry = this.index.sessions[String(sessionId || '').trim()] || null;
    return entry?.current?.lastMessage || null;
  }

  async writeIndex() {
    if (!this.available) return false;
    try {
      await safeInvoke('chat_store_v2_write_index', { scope: this.scopeId, data: this.index });
      return true;
    } catch (err) {
      logger.warn('chat store v2 write index failed', err);
      return false;
    }
  }

  async readPart(entry, thread, partId, options = {}) {
    if (!this.available || !entry || !thread || !partId) return [];
    const data = await safeInvoke('chat_store_v2_read_part', {
      scope: this.scopeId,
      sessionDir: entry.dir,
      threadDir: thread.threadDir,
      partId,
    });
    const list = Array.isArray(data) ? data : [];
    if (options?.hydrate === false) return list;
    return this.hydrateMessageFields(entry, thread, list);
  }

  async writePart(entry, thread, partId, messages) {
    if (!this.available || !entry || !thread || !partId) return false;
    await safeInvoke('chat_store_v2_write_part', {
      scope: this.scopeId,
      sessionDir: entry.dir,
      threadDir: thread.threadDir,
      partId,
      data: messages,
    });
    return true;
  }

  async writeField(entry, thread, fieldId, text) {
    if (!this.available || !entry || !thread || !fieldId) return false;
    const chunks = splitPersistFieldChunks(text);
    const ids = chunks.length > 1
      ? chunks.map((_, idx) => makeMessageFieldChunkId(fieldId, idx))
      : [fieldId];
    for (let i = 0; i < chunks.length; i++) {
      await safeInvoke('chat_store_v2_write_field', {
        scope: this.scopeId,
        sessionDir: entry.dir,
        threadDir: thread.threadDir,
        fieldId: ids[i],
        text: chunks[i],
      });
    }
    return ids;
  }

  async readField(entry, thread, ref) {
    if (!this.available || !entry || !thread || !ref?.fieldId) return null;
    const ids = Array.isArray(ref.chunks) && ref.chunks.length ? ref.chunks : [ref.fieldId];
    const parts = [];
    for (const fieldId of ids) {
      const text = await safeInvoke('chat_store_v2_read_field', {
        scope: this.scopeId,
        sessionDir: ref.sessionDir || entry.dir,
        threadDir: ref.threadDir || thread.threadDir,
        fieldId,
      });
      parts.push(typeof text === 'string' ? text : '');
    }
    return parts.join('');
  }

  async deleteField(entry, thread, ref) {
    if (!this.available || !entry || !thread || !ref?.fieldId) return false;
    const ids = Array.isArray(ref.chunks) && ref.chunks.length ? ref.chunks : [ref.fieldId];
    for (const fieldId of ids) {
      await safeInvoke('chat_store_v2_delete_field', {
        scope: this.scopeId,
        sessionDir: ref.sessionDir || entry.dir,
        threadDir: ref.threadDir || thread.threadDir,
        fieldId,
      });
    }
    return true;
  }

  async hydrateMessageFields(entry, thread, value) {
    const hydrateOne = async msg => {
      if (!msg || typeof msg !== 'object') return msg;
      const refs = getMessageFieldRefs(msg);
      if (!refs) return msg;
      const out = { ...msg, fieldRefs: cloneMessageFieldRefs(refs) || refs };
      for (const field of V2_SIDECAR_FIELDS) {
        const ref = refs[field];
        if (!ref || typeof ref !== 'object') continue;
        try {
          const text = await this.readField(entry, thread, ref);
          if (typeof text === 'string') out[field] = text;
        } catch (err) {
          logger.debug('chat store v2 field hydrate failed', { field, err });
        }
      }
      return out;
    };
    if (Array.isArray(value)) {
      const out = [];
      for (const msg of value) out.push(await hydrateOne(msg));
      return out;
    }
    return hydrateOne(value);
  }

  async prepareMessageForPersist(entry, thread, message) {
    const out = sanitizeMessageForPersist(message, { preserveLargeFields: true });
    if (!out || typeof out !== 'object') return out;
    const refs = cloneMessageFieldRefs(out.fieldRefs) || {};
    for (const field of V2_SIDECAR_FIELDS) {
      const value = out[field];
      const ref = refs[field];
      const refPreview = typeof ref?.preview === 'string' ? ref.preview : '';
      if (field === 'content' && getRecoverableCreativeSourceLength(out)) {
        delete refs[field];
        continue;
      }
      if (ref && typeof value === 'string' && value === refPreview) {
        continue;
      }
      if (typeof value === 'string' && value.length > MAX_PERSIST_FIELD_INLINE_CHARS) {
        const preview = buildPersistPreview(value);
        const fieldId = makeMessageFieldId(out, field);
        const chunks = await this.writeField(entry, thread, fieldId, value);
        refs[field] = normalizeMessageFieldRef(entry, thread, field, fieldId, value, preview, chunks);
        out[field] = preview;
      } else {
        delete refs[field];
      }
    }
    if (Object.keys(refs).length) out.fieldRefs = refs;
    else delete out.fieldRefs;
    return out;
  }

  async deleteMessageFieldRefs(entry, thread, message, nextMessage = null) {
    const refs = getMessageFieldRefs(message);
    if (!refs) return;
    const nextRefs = getMessageFieldRefs(nextMessage) || {};
    for (const field of Object.keys(refs)) {
      const ref = refs[field];
      if (!ref || typeof ref !== 'object') continue;
      if (isSameMessageFieldRef(ref, nextRefs[field])) continue;
      try {
        await this.deleteField(entry, thread, ref);
      } catch (err) {
        logger.debug('chat store v2 field delete failed', { field, err });
      }
    }
  }

  async deletePart(entry, thread, partId) {
    if (!this.available || !entry || !thread || !partId) return false;
    await safeInvoke('chat_store_v2_delete_part', {
      scope: this.scopeId,
      sessionDir: entry.dir,
      threadDir: thread.threadDir,
      partId,
    });
    return true;
  }

  async deleteThread(entry, thread) {
    if (!this.available || !entry || !thread) return false;
    await safeInvoke('chat_store_v2_delete_thread', {
      scope: this.scopeId,
      sessionDir: entry.dir,
      threadDir: thread.threadDir,
    });
    return true;
  }

  async deleteSession(sessionId) {
    if (!this.available) return false;
    const sid = String(sessionId || '').trim();
    const entry = this.index.sessions[sid];
    if (!entry) return false;
    await safeInvoke('chat_store_v2_delete_session', { scope: this.scopeId, sessionDir: entry.dir });
    delete this.index.sessions[sid];
    await this.writeIndex();
    return true;
  }

  _nextPartId(thread) {
    const next = Number(thread?.nextPart || thread?.parts?.length + 1 || 1);
    if (thread) thread.nextPart = next + 1;
    return `part_${String(next).padStart(4, '0')}`;
  }

  _normalizeThreadMeta(thread) {
    if (!thread || typeof thread !== 'object') return null;
    if (!Array.isArray(thread.parts)) thread.parts = [];
    if (!Number.isFinite(thread.total)) thread.total = 0;
    if (!Number.isFinite(thread.lastMessageAt)) thread.lastMessageAt = 0;
    if (!Number.isFinite(thread.nextPart)) thread.nextPart = thread.parts.length + 1;
    return thread;
  }

  async appendMessage(sessionId, archiveId, message) {
    const entry = this.ensureSession(sessionId);
    if (!entry) return null;
    const thread = this._normalizeThreadMeta(this._ensureThread(entry, archiveId));
    if (!thread) return null;
    const storedMessage = await this.prepareMessageForPersist(entry, thread, message);
    const msgChars = estimateMessageChars(storedMessage);
    const parts = Array.isArray(thread.parts) ? thread.parts : [];
    let part = parts.length ? parts[parts.length - 1] : null;
    let createdNewPart = false;
    const shouldRoll =
      !part ||
      (Number(part.count || 0) >= V2_PART_MESSAGE_LIMIT ||
        (Number(part.chars || 0) + msgChars > V2_PART_CHAR_LIMIT && Number(part.count || 0) > 0));
    if (shouldRoll) {
      const partId = this._nextPartId(thread);
      part = { id: partId, count: 0, chars: 0 };
      parts.push(part);
      thread.parts = parts;
      createdNewPart = true;
    }
    const partId = part.id;
    const existing = await this.readPart(entry, thread, partId, { hydrate: false });
    const list = Array.isArray(existing) ? existing : [];
    list.push(storedMessage);
    await this.writePart(entry, thread, partId, list);
    part.count = Number(part.count || 0) + 1;
    part.chars = Number(part.chars || 0) + msgChars;
    thread.total = Number(thread.total || 0) + 1;
    const snap = snapshotMessage(storedMessage);
    if (snap) {
      thread.lastMessage = snap;
      thread.lastMessageAt = Number(snap.timestamp || Date.now());
    }
    await this.writeIndex();
    return { partId, createdNewPart, threadDir: thread.threadDir };
  }

  async updateMessage(sessionId, archiveId, messageId, updater, partId = '') {
    const entry = this.ensureSession(sessionId);
    if (!entry) return null;
    const thread = this._normalizeThreadMeta(this._ensureThread(entry, archiveId));
    if (!thread) return null;
    const targetId = String(messageId || '').trim();
    if (!targetId) return null;
    const ids = partId
      ? [partId]
      : (Array.isArray(thread.parts) ? thread.parts.map(p => p.id).slice().reverse() : []);
    for (const pid of ids) {
      const existing = await this.readPart(entry, thread, pid, { hydrate: false });
      const list = Array.isArray(existing) ? existing : [];
      const idx = list.findIndex(m => String(m?.id || '') === targetId);
      if (idx === -1) continue;
      const prev = list[idx];
      const updated = await this.prepareMessageForPersist(entry, thread, { ...prev, ...updater });
      list[idx] = updated;
      await this.writePart(entry, thread, pid, list);
      await this.deleteMessageFieldRefs(entry, thread, prev, updated);
      const partMeta = (thread.parts || []).find(p => p.id === pid);
      if (partMeta) {
        const diff = estimateMessageChars(updated) - estimateMessageChars(prev);
        partMeta.chars = Number(partMeta.chars || 0) + diff;
      }
      if (thread.lastMessage && String(thread.lastMessage?.id || '') === targetId) {
        const snap = snapshotMessage(updated);
        if (snap) {
          thread.lastMessage = snap;
          thread.lastMessageAt = Number(snap.timestamp || Date.now());
        }
      }
      await this.writeIndex();
      return updated;
    }
    return null;
  }

  async _refreshLastMessage(entry, thread) {
    const parts = Array.isArray(thread?.parts) ? thread.parts : [];
    if (!parts.length) {
      thread.lastMessage = null;
      thread.lastMessageAt = 0;
      thread.total = 0;
      return;
    }
    const lastPart = parts[parts.length - 1];
    const existing = await this.readPart(entry, thread, lastPart.id, { hydrate: false });
    const list = Array.isArray(existing) ? existing : [];
    const last = list.length ? list[list.length - 1] : null;
    const snap = snapshotMessage(last);
    if (snap) {
      thread.lastMessage = snap;
      thread.lastMessageAt = Number(snap.timestamp || Date.now());
    } else {
      thread.lastMessage = null;
      thread.lastMessageAt = 0;
    }
  }

  async deleteMessage(sessionId, archiveId, messageId, partId = '') {
    const entry = this.ensureSession(sessionId);
    if (!entry) return false;
    const thread = this._normalizeThreadMeta(this._ensureThread(entry, archiveId));
    if (!thread) return false;
    const targetId = String(messageId || '').trim();
    if (!targetId) return false;
    const ids = partId
      ? [partId]
      : (Array.isArray(thread.parts) ? thread.parts.map(p => p.id).slice().reverse() : []);
    for (const pid of ids) {
      const existing = await this.readPart(entry, thread, pid, { hydrate: false });
      const list = Array.isArray(existing) ? existing : [];
      const idx = list.findIndex(m => String(m?.id || '') === targetId);
      if (idx === -1) continue;
      const removed = list[idx];
      list.splice(idx, 1);
      await this.deleteMessageFieldRefs(entry, thread, removed);
      const partMetaIdx = (thread.parts || []).findIndex(p => p.id === pid);
      const partMeta = partMetaIdx >= 0 ? thread.parts[partMetaIdx] : null;
      if (list.length) {
        await this.writePart(entry, thread, pid, list);
        if (partMeta) {
          partMeta.count = Math.max(0, Number(partMeta.count || 1) - 1);
          partMeta.chars = Math.max(0, Number(partMeta.chars || 0) - estimateMessageChars(removed));
        }
      } else {
        await this.deletePart(entry, thread, pid);
        if (partMetaIdx >= 0) thread.parts.splice(partMetaIdx, 1);
      }
      thread.total = Math.max(0, Number(thread.total || 1) - 1);
      if (!thread.total) {
        thread.lastMessage = null;
        thread.lastMessageAt = 0;
      } else if (thread.lastMessage && String(thread.lastMessage?.id || '') === targetId) {
        await this._refreshLastMessage(entry, thread);
      }
      await this.writeIndex();
      return true;
    }
    return false;
  }

  async flush() {
    try {
      await this._queue;
    } catch {}
    return this.writeIndex();
  }

  async replaceThreadMessages(sessionId, archiveId, messages = []) {
    const entry = this.ensureSession(sessionId);
    if (!entry) return false;
    const thread = this._normalizeThreadMeta(this._ensureThread(entry, archiveId));
    if (!thread) return false;
    await this.deleteThread(entry, thread);
    thread.parts = [];
    thread.total = 0;
    thread.lastMessage = null;
    thread.lastMessageAt = 0;
    thread.nextPart = 1;

    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      await this.writeIndex();
      return true;
    }
    let bucket = [];
    let chars = 0;
    for (let i = 0; i < list.length; i++) {
      const msg = await this.prepareMessageForPersist(entry, thread, list[i]);
      const msgChars = estimateMessageChars(msg);
      const shouldRoll =
        bucket.length >= V2_PART_MESSAGE_LIMIT ||
        (chars + msgChars > V2_PART_CHAR_LIMIT && bucket.length > 0);
      if (shouldRoll) {
        const partId = this._nextPartId(thread);
        await this.writePart(entry, thread, partId, bucket);
        thread.parts.push({ id: partId, count: bucket.length, chars });
        thread.total += bucket.length;
        bucket = [];
        chars = 0;
      }
      bucket.push(msg);
      chars += msgChars;
    }
    if (bucket.length) {
      const partId = this._nextPartId(thread);
      await this.writePart(entry, thread, partId, bucket);
      thread.parts.push({ id: partId, count: bucket.length, chars });
      thread.total += bucket.length;
    }
    const last = list[list.length - 1];
    const snap = snapshotMessage(last);
    if (snap) {
      thread.lastMessage = snap;
      thread.lastMessageAt = Number(snap.timestamp || Date.now());
    }
    await this.writeIndex();
    return true;
  }

  async cloneCurrentToArchive(sessionId, archiveId) {
    const entry = this.ensureSession(sessionId);
    if (!entry) return false;
    const current = this._normalizeThreadMeta(entry.current);
    if (!current) return false;
    const aid = String(archiveId || '').trim();
    if (!aid) return false;
    const clone = {
      threadDir: current.threadDir,
      parts: Array.isArray(current.parts) ? current.parts.map(p => ({ ...p })) : [],
      total: Number(current.total || 0) || 0,
      lastMessageAt: Number(current.lastMessageAt || 0) || 0,
      lastMessage: current.lastMessage ? { ...current.lastMessage } : null,
      nextPart: Number(current.nextPart || 1) || 1,
    };
    entry.archives[aid] = clone;
    entry.current = this._makeThread();
    await this.writeIndex();
    return true;
  }

  async resetThread(sessionId, archiveId = '') {
    const entry = this.ensureSession(sessionId);
    if (!entry) return false;
    const aid = String(archiveId || '').trim();
    const thread = this._ensureThread(entry, aid);
    if (!thread) return false;
    await this.deleteThread(entry, thread);
    const next = this._makeThread();
    if (aid) entry.archives[aid] = next;
    else entry.current = next;
    await this.writeIndex();
    return true;
  }

  async renameSession(oldId, newId) {
    const from = String(oldId || '').trim();
    const to = String(newId || '').trim();
    if (!from || !to) return false;
    if (!this.index.sessions[from] || this.index.sessions[to]) return false;
    this.index.sessions[to] = this.index.sessions[from];
    delete this.index.sessions[from];
    await this.writeIndex();
    return true;
  }

  async deleteArchive(sessionId, archiveId) {
    const entry = this.ensureSession(sessionId);
    if (!entry) return false;
    const aid = String(archiveId || '').trim();
    const thread = entry.archives?.[aid];
    if (!thread) return false;
    await this.deleteThread(entry, thread);
    delete entry.archives[aid];
    await this.writeIndex();
    return true;
  }
}

const readLocalState = (key) => {
  try {
    const raw = localStorage.getItem(key);
    if (typeof raw === 'string' && raw.length > LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT) {
      logger.warn('chat store local bootstrap skipped: oversized localStorage snapshot', {
        key,
        size: raw.length,
        limit: LOCAL_BOOTSTRAP_JSON_SOFT_LIMIT,
      });
      return null;
    }
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const ensureId = msg => {
  if (!msg) return msg;
  if (!msg.id) {
    msg.id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }
  if (!msg.timestamp) {
    msg.timestamp = Date.now();
  }
  return msg;
};

const dedupeMessagesById = (messages = []) => {
  const out = [];
  const indexById = new Map();
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    const id = String(message?.id || '').trim();
    if (!id) {
      out.push(message);
      return;
    }
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, out.length);
      out.push(message);
      return;
    }
    out[existingIndex] = message;
  });
  return out;
};

const BASE_STORE_KEY = 'chat_store_v1';
const LEGACY_MIGRATION_KEY = `${BASE_STORE_KEY}__scoped_migrated`;

const isLegacyMigrated = () => {
  try {
    return localStorage.getItem(LEGACY_MIGRATION_KEY) === '1';
  } catch {
    return false;
  }
};

const markLegacyMigrated = () => {
  try {
    localStorage.setItem(LEGACY_MIGRATION_KEY, '1');
  } catch {}
};

export class ChatStore {
  constructor({ scopeId = '' } = {}) {
    this.scopeId = normalizeScopeId(scopeId);
    this.storeKey = makeScopedKey(BASE_STORE_KEY, this.scopeId);
    this._scopeToken = 0;
    this.state = sanitizeStateForPersist(this._load());
    if (!this.state.globalVariables || typeof this.state.globalVariables !== 'object') {
      this.state.globalVariables = {};
    }
    this.currentId = resolveCurrentId(this.state, this.scopeId);
    this.state.currentId = this.currentId;
    this._skipMessagePersist = false;
    this._useV2 = false;
    this._v2 = new ChatStoreV2({ scopeId: this.scopeId });
    this._v2ThreadState = new Map();
    this._recentMessageLoads = new Map();
    this._threadLoadEpochs = new Map();
    this._messageStructureRevisions = new WeakMap();
    this._pendingThreadResets = new Map();
    this._diskBacked = false;
    this._lsDisabled = false;
    this._lsQuotaWarned = false;
    this._hydrateRetryCount = 0;
    this._lastArchiveTransition = null;
    this.ready = this._hydrateFromDisk();
    this._v2Ready = this._hydrateV2FromDisk();
    this.fullyReady = Promise.allSettled([this.ready, this._v2Ready]);
  }

  _isScopeStale(token, scopeId) {
    return token !== this._scopeToken || scopeId !== this.scopeId;
  }

  _ensureSession(id) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const defaults = getGlobalChatColorDefaults();
    if (!this.state.sessions[sid]) {
      this.state.sessions[sid] = {
        messages: [],
        draft: '',
        pending: [],
        variables: {},
        initialVariables: {},
        variableSchemas: {},
        variableRules: [],
        stageSchema: null,
      settings: {
          chatColorMode: defaults.chatColorMode,
          bubbleColor: defaults.bubbleColor,
          textColor: defaults.textColor,
        },
        detachedSummaries: [],
        compactedSummary: null,
        compactedSummaryLastRaw: null,
        lastReadMessageId: '',
        lastReadAt: 0,
        unreadCount: 0,
      };
      logger.debug(`[Persona_test] chatStore.sessionCreated sid=${sid} scope=${this.scopeId || 'default'} key=${this.storeKey}`);
      return this.state.sessions[sid];
    }
    const s = this.state.sessions[sid];
    if (!s.messages) s.messages = [];
    if (typeof s.draft !== 'string') s.draft = '';
    if (!Array.isArray(s.pending)) s.pending = [];
    if (!s.variables) s.variables = {};
    if (!s.initialVariables || typeof s.initialVariables !== 'object') s.initialVariables = {};
    if (!s.variableSchemas || typeof s.variableSchemas !== 'object') s.variableSchemas = {};
    if (!Array.isArray(s.variableRules)) s.variableRules = [];
    if (!('stageSchema' in s)) s.stageSchema = null;
    if (typeof s.lastRawResponse !== 'string') s.lastRawResponse = '';
    if (!Number.isFinite(Number(s.lastRawAt))) s.lastRawAt = 0;
    if (typeof s.lastRawTruncated !== 'boolean') s.lastRawTruncated = false;
    if (typeof s.lastRawTurnId !== 'string') s.lastRawTurnId = '';
    if (typeof s.lastRawSourceSessionId !== 'string') s.lastRawSourceSessionId = '';
    if (typeof s.lastRawTargetSessionId !== 'string') s.lastRawTargetSessionId = '';
    if (!Array.isArray(s.lastRawTargetSessionIds)) s.lastRawTargetSessionIds = [];
    if (typeof s.lastRawSourceKind !== 'string') s.lastRawSourceKind = 'social_turn_raw';
    if (!Array.isArray(s.lastRawSourceMessageIds)) s.lastRawSourceMessageIds = [];
    if (typeof s.lastRawPendingRepair !== 'boolean') s.lastRawPendingRepair = false;
    if (!s.settings) s.settings = {};
    if (!s.settings.chatColorMode) {
      s.settings.chatColorMode = inferChatColorMode(s.settings, defaults.chatColorMode || 'theme');
    }
    if (!Array.isArray(s.detachedSummaries)) s.detachedSummaries = [];
    if (typeof s.compactedSummary !== 'object') s.compactedSummary = null;
    if (typeof s.compactedSummaryLastRaw !== 'object') s.compactedSummaryLastRaw = null;
    if (typeof s.lastReadMessageId !== 'string') s.lastReadMessageId = '';
    if (!Number.isFinite(s.lastReadAt)) s.lastReadAt = 0;
    if (!Number.isFinite(s.unreadCount)) s.unreadCount = 0;
    // Normalize legacy summaries (string[]) into objects
    try {
      s.detachedSummaries = (s.detachedSummaries || [])
        .map(it => {
          if (!it) return null;
          if (typeof it === 'string') return { at: 0, text: it };
          const text = String(it.text || '').trim();
          if (!text) return null;
          const at = Number(it.at || 0) || 0;
          return { at, text };
        })
        .filter(Boolean);
    } catch {}
    return s;
  }

  _load() {
    const data = readLocalState(this.storeKey);
    if (data && isScopedDataMatch(data, this.scopeId)) {
      if (this.scopeId) markLegacyMigrated();
      return data;
    }
    if (isDefaultScopeId(this.scopeId) && !isLegacyMigrated()) {
      const legacy = readLocalState(BASE_STORE_KEY);
      if (legacy) {
        markLegacyMigrated();
        return legacy;
      }
    }
    return { sessions: {}, currentId: '' };
  }

  async _hydrateFromDisk() {
    const token = this._scopeToken;
    const storeKey = this.storeKey;
    const scopeId = this.scopeId;
    try {
      let kv = await safeInvoke('load_kv', { name: storeKey });
      if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
      if (kv && !isScopedDataMatch(kv, scopeId)) {
        kv = null;
      }
      if (!kv && isDefaultScopeId(this.scopeId) && !isLegacyMigrated()) {
        const legacy = await safeInvoke('load_kv', { name: BASE_STORE_KEY });
        if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
        if (legacy && legacy.sessions) {
          kv = legacy;
          markLegacyMigrated();
          try {
            await safeInvoke('save_kv', { name: storeKey, data: legacy });
          } catch (err) {
            logger.debug('chat store legacy migrate failed (可能非 Tauri)', err);
          }
        }
      }
      if (kv && kv.sessions) {
        if (token !== this._scopeToken || storeKey !== this.storeKey || scopeId !== this.scopeId) return;
        this.state = sanitizeStateForPersist(kv);
        this.currentId = resolveCurrentId(this.state, scopeId);
        this.state.currentId = this.currentId;
        this._diskBacked = true;
        if (this.scopeId) markLegacyMigrated();
        try {
          localStorage.removeItem(storeKey);
        } catch {}
        logger.debug('chat store hydrated from disk');
        logger.debug(
          `[Persona_test] chatStore.hydrated scope=${scopeId || 'default'} key=${storeKey} sessions=${
            Object.keys(this.state.sessions || {}).length
          } current=${this.currentId || ''}`,
        );
        try {
          window.dispatchEvent(new CustomEvent('store-hydrated', { detail: { store: 'chat' } }));
        } catch {}
      }
    } catch (err) {
      logger.debug('chat store disk load skipped (可能非 Tauri)', err);
      // Retry later if Tauri is present but invoke isn't ready yet (common after hot reload / process restore)
      try {
        const g = typeof globalThis !== 'undefined' ? globalThis : window;
        const msg = String(err?.message || '');
        const canRetry = Boolean(g?.__TAURI__) && msg.includes('invoke not available');
        if (token === this._scopeToken && canRetry && this._hydrateRetryCount < 3) {
          const attempt = ++this._hydrateRetryCount;
          logger.warn(`chat store hydrate retry scheduled (${attempt}/3)`);
          setTimeout(() => {
            this._hydrateFromDisk();
          }, 800 * attempt);
        }
      } catch {}
    }
  }

  _getThreadKey(sessionId, archiveId = '') {
    const sid = String(sessionId || '').trim();
    const aid = String(archiveId || '').trim();
    return `${sid}::${aid || 'current'}`;
  }

  _getThreadState(threadKey, { reset = false } = {}) {
    if (reset || !this._v2ThreadState.has(threadKey)) {
      this._v2ThreadState.set(threadKey, { loadedParts: [], messagePartMap: new Map() });
    }
    return this._v2ThreadState.get(threadKey);
  }

  _clearThreadState(threadKey) {
    if (!threadKey) return;
    this._v2ThreadState.delete(threadKey);
  }

  _getThreadLoadEpoch(threadKey) {
    const key = String(threadKey || '').trim();
    if (!key) return 0;
    if (!this._threadLoadEpochs.has(key)) this._threadLoadEpochs.set(key, 0);
    return Number(this._threadLoadEpochs.get(key) || 0);
  }

  _invalidateThreadLoad(threadKey) {
    const key = String(threadKey || '').trim();
    if (!key) return 0;
    const next = this._getThreadLoadEpoch(key) + 1;
    this._threadLoadEpochs.set(key, next);
    this._recentMessageLoads.delete(`${this._scopeToken}:${key}`);
    return next;
  }

  // 线程重置（clone/reset）在 v2 队列里异步执行；内存清空与索引换空之间的窗口内，
  // 读取方必须把该线程当作权威空态，否则滚动懒加载等路径会从旧索引复活旧消息。
  _beginThreadReset(threadKey) {
    const key = String(threadKey || '').trim();
    if (!key) return () => {};
    const pending = this._pendingThreadResets;
    pending.set(key, Number(pending.get(key) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = Number(pending.get(key) || 0);
      if (count <= 1) pending.delete(key);
      else pending.set(key, count - 1);
    };
  }

  _isThreadResetPending(threadKey) {
    return Number(this._pendingThreadResets.get(String(threadKey || '').trim()) || 0) > 0;
  }

  _invalidateSessionLoads(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const prefix = `${sid}::`;
    const keys = new Set(
      Array.from(this._threadLoadEpochs.keys()).filter(key => key.startsWith(prefix)),
    );
    for (const loadKey of this._recentMessageLoads.keys()) {
      const threadKey = String(loadKey || '').slice(String(this._scopeToken).length + 1);
      if (threadKey.startsWith(prefix)) keys.add(threadKey);
    }
    if (!keys.size) keys.add(this._getThreadKey(sid, ''));
    keys.forEach(key => this._invalidateThreadLoad(key));
  }

  _isThreadLoadStale(threadKey, epoch, token, scopeId) {
    return this._isScopeStale(token, scopeId)
      || this._getThreadLoadEpoch(threadKey) !== epoch;
  }

  getHistoryRevision(id = this.currentId, archiveId = null) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    const aid = archiveId == null
      ? String(this.state.sessions[sid]?.currentArchiveId || '').trim()
      : String(archiveId || '').trim();
    const threadKey = this._getThreadKey(sid, aid);
    return `${this._scopeToken}:${this.scopeId}:${threadKey}:${this._getThreadLoadEpoch(threadKey)}`;
  }

  _recoverV2ArchiveMetadata() {
    if (!this._useV2) return false;
    const sessions = this._v2.index?.sessions || {};
    let changed = false;
    for (const [sid, entry] of Object.entries(sessions)) {
      const sessionId = String(sid || '').trim();
      if (!sessionId || !entry || typeof entry !== 'object') continue;
      const archiveThreads = entry.archives && typeof entry.archives === 'object' ? entry.archives : {};
      const archiveIds = Object.keys(archiveThreads).map(id => String(id || '').trim()).filter(Boolean);
      if (!archiveIds.length) continue;

      const session = this._ensureSession(sessionId);
      if (!session) continue;
      const archives = Array.isArray(session.archives) ? session.archives : [];
      if (!Array.isArray(session.archives)) {
        session.archives = archives;
        changed = true;
      }
      const existingById = new Map();
      for (const archive of archives) {
        const aid = String(archive?.id || '').trim();
        if (aid) existingById.set(aid, archive);
      }

      for (const archiveId of archiveIds) {
        const thread = archiveThreads[archiveId] || {};
        const existing = existingById.get(archiveId);
        if (existing) {
          const total = Number(thread?.total || 0) || 0;
          if (Number.isFinite(total) && Number(existing.messageCount || 0) !== total) {
            existing.messageCount = total;
            changed = true;
          }
          if (!Number(existing.timestamp || 0)) {
            existing.timestamp = parseArchiveTimestamp(archiveId) || Number(thread?.lastMessageAt || 0) || Date.now();
            changed = true;
          }
          continue;
        }
        const recovered = makeRecoveredV2ArchiveMetadata(archiveId, thread);
        if (!recovered) continue;
        session.archives.push(recovered);
        existingById.set(archiveId, recovered);
        changed = true;
      }
    }
    return changed;
  }

  async _hydrateV2FromDisk() {
    const token = this._scopeToken;
    const scopeId = this.scopeId;
    try {
      await this.ready;
    } catch {}
    if (token !== this._scopeToken || scopeId !== this.scopeId) return false;
    const ok = await this._v2.init();
    if (!ok) return false;
    if (token !== this._scopeToken || scopeId !== this.scopeId) return false;
    this._useV2 = true;
    this._skipMessagePersist = true;
    try {
      const v2Sessions = this._v2.index?.sessions || {};
      for (const sid of Object.keys(v2Sessions)) {
        this._ensureSession(sid);
      }
    } catch {}
    try {
      await this._maybeMigrateToV2(token, scopeId);
    } catch (err) {
      logger.warn('chat store v2 migrate failed', err);
    }
    try {
      if (this._recoverV2ArchiveMetadata()) {
        logger.info('chat store v2 archive metadata recovered from sidecar index');
        this._persist();
      }
    } catch (err) {
      logger.warn('chat store v2 archive metadata recover failed', err);
    }
    try {
      if (this._isScopeStale(token, scopeId)) return false;
      for (const sid of Object.keys(this.state.sessions || {})) {
        this.state.sessions[sid].messages = [];
      }
    } catch (err) {
      logger.warn('chat store v2 reset hydrated thread cache failed', err);
    }
    try {
      window.dispatchEvent(new CustomEvent('store-hydrated', { detail: { store: 'chat' } }));
    } catch {}
    return true;
  }

  async _maybeMigrateToV2(token = this._scopeToken, scopeId = this.scopeId) {
    if (!this._useV2) return false;
    if (this._isScopeStale(token, scopeId)) return false;
    const existing = this._v2.index?.sessions || {};
    const sessions = this.state.sessions || {};
    let migrated = false;
    for (const [sid, session] of Object.entries(sessions)) {
      if (this._isScopeStale(token, scopeId)) return false;
      if (existing && Object.prototype.hasOwnProperty.call(existing, sid)) continue;
      const hasMessages = (() => {
        if (Array.isArray(session?.messages) && session.messages.length) return true;
        const arcs = Array.isArray(session?.archives) ? session.archives : [];
        return arcs.some(a => Array.isArray(a?.messages) && a.messages.length);
      })();
      if (!hasMessages) continue;
      await this._migrateSessionToV2(sid, session, { token, scopeId });
      migrated = true;
    }
    if (this._isScopeStale(token, scopeId)) return false;
    if (migrated) {
      await this._v2.writeIndex();
    }
    return migrated;
  }

  async _migrateSessionToV2(sessionId, session, { token = this._scopeToken, scopeId = this.scopeId } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid || !session) return;
    if (this._isScopeStale(token, scopeId)) return;
    this._v2.ensureSession(sid);
    const currentArchiveId = String(session.currentArchiveId || '').trim();
    const archives = Array.isArray(session.archives) ? session.archives : [];
    if (!Number.isFinite(session.lastReadAt)) {
      const lastReadId = String(session.lastReadMessageId || '').trim();
      if (lastReadId) {
        const source = currentArchiveId
          ? (archives.find(a => String(a?.id || '').trim() === currentArchiveId)?.messages || [])
          : session.messages;
        const list = Array.isArray(source) ? source : [];
        const found = list.find(m => String(m?.id || '') === lastReadId);
        if (found && Number.isFinite(found.timestamp)) {
          session.lastReadAt = Number(found.timestamp || 0) || 0;
        }
      }
    }
    const hasCurrentArchive = currentArchiveId && archives.some(a => String(a?.id || '').trim() === currentArchiveId);
    if (!currentArchiveId || !hasCurrentArchive) {
      const raw = Array.isArray(session.messages) ? session.messages : [];
      const messages = raw.slice();
      if (this._isScopeStale(token, scopeId)) return;
      await this._v2.replaceThreadMessages(sid, '', messages);
    }
    for (const arc of archives) {
      if (!arc || typeof arc !== 'object') continue;
      const aid = String(arc.id || '').trim();
      if (!aid) continue;
      const useCurrent = currentArchiveId && aid === currentArchiveId;
      const source = useCurrent ? session.messages : arc.messages;
      const raw = Array.isArray(source) ? source : [];
      const messages = raw.slice();
      if (this._isScopeStale(token, scopeId)) return;
      await this._v2.replaceThreadMessages(sid, aid, messages);
      arc.messageCount = messages.length;
      if (useCurrent && currentArchiveId) {
        const thread = this._v2.getThread(sid, aid);
        if (thread) {
          thread.lastMessageAt = thread.lastMessageAt || Date.now();
        }
      }
    }
    // Reset current thread if we were inside an archive
    if (currentArchiveId) {
      const entry = this._v2.ensureSession(sid);
      if (entry && entry.current && entry.current.total) {
        // keep as-is
      } else if (entry) {
        entry.current = entry.current || this._v2._makeThread();
      }
    }
  }

  async _loadRecentMessages(
    id = this.currentId,
    archiveId = '',
    { partCount = V2_RECENT_PARTS, token = this._scopeToken, scopeId = this.scopeId } = {},
  ) {
    if (!this._useV2) return this.getMessages(id);
    const sid = String(id || '').trim();
    if (!sid) return [];
    if (this._isScopeStale(token, scopeId)) return [];
    const aid = String(archiveId || '').trim();
    const threadKey = this._getThreadKey(sid, aid);
    if (this._isThreadResetPending(threadKey)) return this.getMessages(sid);
    const loadEpoch = this._getThreadLoadEpoch(threadKey);
    const loadKey = `${token}:${threadKey}`;
    const pending = this._recentMessageLoads.get(loadKey);
    if (pending) return pending;
    const loadPromise = (async () => {
      if (this._isThreadLoadStale(threadKey, loadEpoch, token, scopeId)) return [];
      this._ensureSession(sid);
      const entry = this._v2.ensureSession(sid);
      const thread = this._v2.getThread(sid, aid);
      const currentMessages = Array.isArray(this.state.sessions[sid]?.messages) ? this.state.sessions[sid].messages.slice() : [];
      const currentLoadedThreadKey = String(this.state.sessions[sid]?._loadedThreadKey || '').trim();
      if (!entry || !thread) {
        if (this._isThreadLoadStale(threadKey, loadEpoch, token, scopeId)) return [];
        this.state.sessions[sid].messages = [];
        return [];
      }
      const parts = Array.isArray(thread.parts) ? thread.parts : [];
      const ids = parts.slice(-partCount).map(p => p.id);
      const threadState = this._getThreadState(threadKey, { reset: true });
      const merged = [];
      for (const partId of ids) {
        const existing = await this._v2.readPart(entry, thread, partId);
        if (this._isThreadLoadStale(threadKey, loadEpoch, token, scopeId)) return [];
        const list = Array.isArray(existing) ? existing : [];
        for (const msg of list) {
          const mid = String(msg?.id || '');
          if (mid) threadState.messagePartMap.set(mid, partId);
        }
        merged.push(...list);
      }
      const canPreserveInMemoryTail = !currentLoadedThreadKey || currentLoadedThreadKey === threadKey;
      if (canPreserveInMemoryTail && currentMessages.length) {
        const loadedIds = new Set(merged.map(msg => String(msg?.id || '').trim()).filter(Boolean));
        const tail = [];
        for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
          const msg = currentMessages[i];
          const mid = String(msg?.id || '').trim();
          if (mid && loadedIds.has(mid)) break;
          tail.push(msg);
        }
        if (tail.length) {
          tail.reverse();
          merged.push(...tail);
          logger.debug(
            `[chat-store] preserved in-memory tail sid=${sid} scope=${this.scopeId || 'default'} loaded=${ids.length} tail=${tail.length}`
          );
        }
      }
      if (this._isThreadLoadStale(threadKey, loadEpoch, token, scopeId)) return [];
      const nextMessages = dedupeMessagesById(merged);
      threadState.loadedParts = ids;
      this.state.sessions[sid].messages = nextMessages;
      this.state.sessions[sid]._loadedThreadKey = threadKey;
      return nextMessages;
    })();
    this._recentMessageLoads.set(loadKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (this._recentMessageLoads.get(loadKey) === loadPromise) {
        this._recentMessageLoads.delete(loadKey);
      }
    }
  }

  async ensureRecentMessagesLoaded(id = this.currentId, archiveId = '') {
    const token = this._scopeToken;
    const scopeId = this.scopeId;
    const sid = String(id || '').trim();
    if (!sid) return [];
    if (this._isScopeStale(token, scopeId)) return [];
    this._ensureSession(sid);
    const aid = String(archiveId || this.state.sessions[sid]?.currentArchiveId || '').trim();
    const threadKey = this._getThreadKey(sid, aid);
    if (!this._useV2) return this.getMessages(sid);
    if (this._isThreadResetPending(threadKey)) return this.getMessages(sid);
    if (this.state.sessions[sid]._loadedThreadKey === threadKey) return this.getMessages(sid);
    return this._loadRecentMessages(sid, aid, { token, scopeId });
  }

  hasOlderMessages(id = this.currentId, archiveId = '') {
    if (!this._useV2) return false;
    const sid = String(id || '').trim();
    if (!sid) return false;
    const aid = String(archiveId || this.state.sessions[sid]?.currentArchiveId || '').trim();
    if (this._isThreadResetPending(this._getThreadKey(sid, aid))) return false;
    const thread = this._v2.getThread(sid, aid);
    if (!thread || !Array.isArray(thread.parts)) return false;
    const threadKey = this._getThreadKey(sid, aid);
    const state = this._getThreadState(threadKey);
    if (!state?.loadedParts?.length) return thread.parts.length > 0;
    const all = thread.parts.map(p => p.id);
    const oldest = state.loadedParts[0];
    const idx = all.indexOf(oldest);
    return idx > 0;
  }

  async loadOlderMessages(id = this.currentId, archiveId = '', { partCount = 1 } = {}) {
    if (!this._useV2) return [];
    const sid = String(id || '').trim();
    if (!sid) return [];
    const token = this._scopeToken;
    const scopeId = this.scopeId;
    if (this._isScopeStale(token, scopeId)) return [];
    this._ensureSession(sid);
    const aid = String(archiveId || this.state.sessions[sid]?.currentArchiveId || '').trim();
    const entry = this._v2.ensureSession(sid);
    const thread = this._v2.getThread(sid, aid);
    if (!entry || !thread || !Array.isArray(thread.parts) || !thread.parts.length) return [];
    const threadKey = this._getThreadKey(sid, aid);
    if (this._isThreadResetPending(threadKey)) return [];
    const loadEpoch = this._getThreadLoadEpoch(threadKey);
    const state = this._getThreadState(threadKey);
    const all = thread.parts.map(p => p.id);
    const loaded = state.loadedParts || [];
    const oldest = loaded.length ? loaded[0] : null;
    const oldestIdx = oldest ? all.indexOf(oldest) : all.length;
    const start = Math.max(0, oldestIdx - partCount);
    const pick = all.slice(start, oldestIdx);
    if (!pick.length) return [];
    const older = [];
    for (const partId of pick) {
      const existing = await this._v2.readPart(entry, thread, partId);
      if (this._isThreadLoadStale(threadKey, loadEpoch, token, scopeId)) return [];
      const list = Array.isArray(existing) ? existing : [];
      for (const msg of list) {
        const mid = String(msg?.id || '');
        if (mid) state.messagePartMap.set(mid, partId);
      }
      older.push(...list);
    }
    if (this._isThreadLoadStale(threadKey, loadEpoch, token, scopeId)) return [];
    state.loadedParts = pick.concat(loaded);
    const current = dedupeMessagesById(this.state.sessions[sid].messages || []);
    const currentIds = new Set(current.map(message => String(message?.id || '').trim()).filter(Boolean));
    const prepended = dedupeMessagesById(older).filter((message) => {
      const id = String(message?.id || '').trim();
      return !id || !currentIds.has(id);
    });
    this.state.sessions[sid].messages = dedupeMessagesById(prepended.concat(current));
    this.state.sessions[sid]._loadedThreadKey = threadKey;
    return prepended;
  }

  async exportThreadMessages(id = this.currentId, archiveId = '') {
    const sid = String(id || '').trim();
    if (!sid) return [];
    this._ensureSession(sid);
    const aid = String(archiveId || '').trim();
    const session = this.state.sessions[sid];
    if (!this._useV2) {
      if (!aid) return Array.isArray(session?.messages) ? session.messages.slice() : [];
      const archive = Array.isArray(session?.archives)
        ? session.archives.find(item => String(item?.id || '').trim() === aid)
        : null;
      return Array.isArray(archive?.messages) ? archive.messages.slice() : [];
    }
    const entry = this._v2.ensureSession(sid);
    const thread = this._v2.getThread(sid, aid);
    if (!entry || !thread || !Array.isArray(thread.parts) || !thread.parts.length) return [];
    const messages = [];
    for (const part of thread.parts) {
      const partId = String(part?.id || '').trim();
      if (!partId) continue;
      const existing = await this._v2.readPart(entry, thread, partId);
      const list = Array.isArray(existing) ? existing : [];
      messages.push(...list);
    }
    return messages;
  }

  _persist() {
    const token = this._scopeToken;
    const storeKey = this.storeKey;
    const persistable = () => ({
      ...sanitizeStateForPersist(this.state, { skipMessages: this._skipMessagePersist }),
      scopeId: this.scopeId,
    });
    // 1. Fast path: Schedule localStorage shortly (50ms debounce) to skip current frame
    if (this._lsTimer) clearTimeout(this._lsTimer);
    this._lsTimer = setTimeout(() => {
      if (token !== this._scopeToken || storeKey !== this.storeKey) return;
      if (this._diskBacked || this._lsDisabled) return;
      try {
        localStorage.setItem(storeKey, JSON.stringify(persistable()));
      } catch (err) {
        if (isQuotaError(err)) {
          this._lsDisabled = true;
          if (!this._lsQuotaWarned) {
            this._lsQuotaWarned = true;
            logger.warn(
              'chat store: localStorage quota exceeded; disabling localStorage writes and relying on Tauri KV.',
              err,
            );
          }
          try {
            localStorage.removeItem(storeKey);
          } catch {}
        } else {
          logger.warn('chat store persist -> localStorage failed', err);
        }
      }
    }, 50);

    // 2. Slow path: Schedule disk save (2000ms debounce) to avoid frequent fsync on Android
    if (this._diskTimer) clearTimeout(this._diskTimer);
    this._diskTimer = setTimeout(() => {
      if (token !== this._scopeToken || storeKey !== this.storeKey) return;
      safeInvoke('save_kv', { name: storeKey, data: persistable() }).catch(err => {
        logger.debug('chat store save_kv failed (可能非 Tauri)', err);
      });
    }, 2000);
  }

  async flush() {
    const data = {
      ...sanitizeStateForPersist(this.state, { skipMessages: this._skipMessagePersist }),
      scopeId: this.scopeId,
    };
    try {
      if (!this._diskBacked && !this._lsDisabled) {
        localStorage.setItem(this.storeKey, JSON.stringify(data));
      }
    } catch (err) {
      if (isQuotaError(err)) {
        this._lsDisabled = true;
        if (!this._lsQuotaWarned) {
          this._lsQuotaWarned = true;
          logger.warn(
            'chat store: localStorage quota exceeded; disabling localStorage writes and relying on Tauri KV.',
            err,
          );
        }
        try {
          localStorage.removeItem(this.storeKey);
        } catch {}
      } else {
        logger.warn('chat store flush -> localStorage failed', err);
      }
    }
    try {
      await safeInvoke('save_kv', { name: this.storeKey, data });
    } catch (err) {
      logger.debug('chat store flush save_kv failed (可能非 Tauri)', err);
    }
    if (this._useV2) {
      try {
        await this._v2.flush();
      } catch (err) {
        logger.debug('chat store v2 flush failed', err);
      }
    }
  }

  async setScope(scopeId = '') {
    const nextScope = normalizeScopeId(scopeId);
    if (nextScope === this.scopeId) return this.fullyReady || this.ready;
    const prevScope = this.scopeId;
    const prevKey = this.storeKey;
    logger.debug(
      `[Persona_test] chatStore.setScope begin scope=${prevScope || 'default'} key=${prevKey} -> ${nextScope || 'default'}`,
    );
    this._scopeToken += 1;
    try {
      await this.flush();
    } catch {}
    if (this._lsTimer) clearTimeout(this._lsTimer);
    if (this._diskTimer) clearTimeout(this._diskTimer);
    this._lsTimer = null;
    this._diskTimer = null;
    this.scopeId = nextScope;
    this.storeKey = makeScopedKey(BASE_STORE_KEY, this.scopeId);
    this._useV2 = false;
    this._skipMessagePersist = false;
    this._v2ThreadState.clear();
    this._recentMessageLoads.clear();
    this._threadLoadEpochs.clear();
    this._pendingThreadResets = new Map();
    this._v2 = new ChatStoreV2({ scopeId: this.scopeId });
    this._diskBacked = false;
    this._lsDisabled = false;
    this._lsQuotaWarned = false;
    this._hydrateRetryCount = 0;
    this.state = sanitizeStateForPersist(this._load());
    this.currentId = resolveCurrentId(this.state, this.scopeId);
    this.state.currentId = this.currentId;
    this.ready = this._hydrateFromDisk();
    this._v2Ready = this._hydrateV2FromDisk();
    this.fullyReady = Promise.allSettled([this.ready, this._v2Ready]);
    const ready = this.fullyReady;
    ready
      .then(() => {
        logger.debug(
          `[Persona_test] chatStore.setScope ready scope=${this.scopeId || 'default'} key=${
            this.storeKey
          } sessions=${Object.keys(this.state.sessions || {}).length} current=${this.currentId || ''}`,
        );
      })
      .catch(err => {
        const msg = String(err?.message || err || '');
        logger.warn(`[Persona_test] chatStore.setScope hydrate failed scope=${nextScope || 'default'} err=${msg}`);
      });
    return ready;
  }

  _ensureRawOriginalRef(msg, sessionId) {
    if (!msg || !msg.id) return null;
    const sid = String(sessionId || '').trim();
    const mid = String(msg.id || '').trim();
    if (!sid || !mid) return null;
    if (msg.rawOriginalRef && typeof msg.rawOriginalRef === 'object') {
      if (!msg.rawOriginalRef.sessionId) msg.rawOriginalRef.sessionId = sid;
      if (!msg.rawOriginalRef.messageId) msg.rawOriginalRef.messageId = mid;
      return msg.rawOriginalRef;
    }
    const ref = { sessionId: sid, messageId: mid };
    msg.rawOriginalRef = ref;
    return ref;
  }

  _persistRawOriginal(msg, sessionId) {
    if (!msg || msg.role !== 'assistant') return;
    const raw = typeof msg.rawOriginal === 'string' ? msg.rawOriginal : '';
    if (!raw.length) return;
    const ref = this._ensureRawOriginalRef(msg, sessionId);
    if (!ref) return;
    safeInvoke('save_raw_reply', { sessionId: ref.sessionId, messageId: ref.messageId, text: raw }).catch(err => {
      logger.debug('save_raw_reply failed (可能非 Tauri)', err);
    });
  }

  _deleteRawOriginal(msg, sessionId) {
    const ref = msg?.rawOriginalRef || (msg?.id ? { sessionId: String(sessionId || ''), messageId: String(msg.id) } : null);
    if (!ref?.sessionId || !ref?.messageId) return;
    safeInvoke('delete_raw_reply', { sessionId: ref.sessionId, messageId: ref.messageId }).catch(err => {
      logger.debug('delete_raw_reply failed (可能非 Tauri)', err);
    });
  }

  async loadRawOriginal(messageOrId, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    const msg = typeof messageOrId === 'object' ? messageOrId : this.findMessage(messageOrId, sid);
    if (!msg) return '';
    if (typeof msg.rawOriginal === 'string') return msg.rawOriginal;
    const ref = this._ensureRawOriginalRef(msg, sid);
    if (!ref) return '';
    try {
      const loaded = await safeInvoke('load_raw_reply', { sessionId: ref.sessionId, messageId: ref.messageId });
      if (typeof loaded === 'string') {
        msg.rawOriginal = loaded;
        return loaded;
      }
    } catch (err) {
      logger.debug('load_raw_reply failed (可能非 Tauri)', err);
    }
    return '';
  }

  async prefetchRawOriginals(id = this.currentId, { limit = MAX_RAW_ORIGINAL_AUTOLOAD } = {}) {
    const sid = String(id || '').trim();
    if (!sid) return;
    const session = this.state.sessions[sid];
    if (!session || !Array.isArray(session.messages)) return;
    const messages = session.messages;
    const picked = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (picked.length >= limit) break;
      const m = messages[i];
      if (!isCreativeAssistant(m)) continue;
      if (typeof m.rawOriginal === 'string') continue;
      if (!m?.id) continue;
      this._ensureRawOriginalRef(m, sid);
      picked.push(m);
    }
    if (!picked.length) return;
    await Promise.allSettled(picked.map(m => this.loadRawOriginal(m, sid)));
  }

  async prefetchRawOriginalsForMessages(messages = [], id = this.currentId, { limit = MAX_RAW_ORIGINAL_AUTOLOAD } = {}) {
    const sid = String(id || '').trim();
    if (!sid) return;
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return;
    const picked = [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (picked.length >= limit) break;
      const m = list[i];
      if (!isCreativeAssistant(m)) continue;
      if (typeof m.rawOriginal === 'string') continue;
      if (!m?.id) continue;
      this._ensureRawOriginalRef(m, sid);
      picked.push(m);
    }
    if (!picked.length) return;
    await Promise.allSettled(picked.map(m => this.loadRawOriginal(m, sid)));
  }

  listSessions() {
    // Sort by last message time desc
    return Object.keys(this.state.sessions)
      .filter(id => !isForeignRpSessionForScope(id, this.scopeId))
      .sort((a, b) => {
        const ta = this.getLastMessage(a)?.timestamp || 0;
        const tb = this.getLastMessage(b)?.timestamp || 0;
        return tb - ta;
      });
  }

  hasSession(id) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    if (isForeignRpSessionForScope(sid, this.scopeId)) return false;
    return Boolean(this.state?.sessions && Object.prototype.hasOwnProperty.call(this.state.sessions, sid));
  }

  setCurrent(id) {
    const sid = String(id || '').trim();
    if (isForeignRpSessionForScope(sid, this.scopeId)) return false;
    this.currentId = sid;
    this.state.currentId = sid;
    this._persist();
    return true;
  }

  getCurrent() {
    return this.currentId;
  }

  getMessages(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return [];
    return this.state.sessions[sid]?.messages || [];
  }

  // 配合消息数组引用和长度，用于识别原地更新角色/ID 后的索引失效；正文流式更新不增加版本。
  getMessageStructureRevision(id = this.currentId) {
    return this._messageStructureRevisions.get(this.getMessages(id)) || 0;
  }

  getLastMessage(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const msgs = this.getMessages(sid);
    if (msgs.length) return msgs[msgs.length - 1];
    if (this._useV2) {
      const curAid = String(this.state.sessions[sid]?.currentArchiveId || '').trim();
      const thread = this._v2.getThread(sid, curAid);
      const snap = thread?.lastMessage || this._v2.getLastMessageSnapshot(sid);
      if (snap) return snap;
    }
    return null;
  }

  appendMessage(message, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    this._ensureSession(sid);
    const msg = ensureId({ ...message });
    this._persistRawOriginal(msg, sid);
    this.state.sessions[sid].messages.push(msg);
    if (msg?.role === 'assistant') {
      this.state.sessions[sid].unreadCount = Number(this.state.sessions[sid].unreadCount || 0) + 1;
    }
    if (this._useV2) {
      const aid = String(this.state.sessions[sid]?.currentArchiveId || '').trim();
      const threadKey = this._getThreadKey(sid, aid);
      const v2 = this._v2;
      const token = this._scopeToken;
      const scopeId = this.scopeId;
      const messageSnapshot = { ...msg };
      v2.enqueue(async () => {
        const res = await v2.appendMessage(sid, aid, messageSnapshot);
        if (this._isScopeStale(token, scopeId)) return;
        if (this.state.sessions[sid]?._loadedThreadKey === threadKey && res?.partId) {
          const threadState = this._getThreadState(threadKey);
          if (res.createdNewPart && !threadState.loadedParts.includes(res.partId)) {
            threadState.loadedParts.push(res.partId);
          }
          threadState.messagePartMap.set(String(msg?.id || ''), res.partId);
        }
      });
    }
    this._persist();
    return msg;
  }

  insertMessageAfter(anchorMessageId, message, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    if (!Array.isArray(session.messages)) session.messages = [];
    const msg = ensureId({ ...message });
    this._persistRawOriginal(msg, sid);

    const anchorId = String(anchorMessageId || '').trim();
    const anchorIndex = anchorId
      ? session.messages.findIndex(item => String(item?.id || '') === anchorId)
      : -1;
    let insertIndex = anchorIndex >= 0 ? anchorIndex + 1 : session.messages.length;
    if (anchorId && anchorIndex >= 0) {
      while (insertIndex < session.messages.length) {
        const sourceId = String(session.messages[insertIndex]?.meta?.generatedMedia?.sourceMessageId || '').trim();
        if (sourceId !== anchorId) break;
        insertIndex += 1;
      }
    }
    session.messages.splice(insertIndex, 0, msg);
    if (msg?.role === 'assistant') {
      session.unreadCount = Number(session.unreadCount || 0) + 1;
    }

    if (this._useV2) {
      const aid = String(session.currentArchiveId || '').trim();
      const threadKey = this._getThreadKey(sid, aid);
      this._getThreadState(threadKey, { reset: true });
      const messagesSnapshot = session.messages.slice();
      const v2 = this._v2;
      v2.enqueue(async () => {
        await v2.replaceThreadMessages(sid, aid, messagesSnapshot);
      });
    }
    this._persist();
    return msg;
  }

  markRead(id = this.currentId, messageId = '') {
    const sid = String(id || '').trim();
    if (!sid) return;
    this._ensureSession(sid);
    const nextId = String(messageId || '').trim();
    if (nextId) {
      this.state.sessions[sid].lastReadMessageId = nextId;
      this.state.sessions[sid].unreadCount = 0;
      try {
        const m = this.findMessage(nextId, sid);
        if (m && Number.isFinite(m.timestamp)) {
          this.state.sessions[sid].lastReadAt = Number(m.timestamp || 0) || Date.now();
        } else {
          this.state.sessions[sid].lastReadAt = Date.now();
        }
      } catch {
        this.state.sessions[sid].lastReadAt = Date.now();
      }
      this._persist();
      return;
    }
    const last = this.getLastMessage(sid);
    if (last?.id) {
      this.state.sessions[sid].lastReadMessageId = String(last.id);
      this.state.sessions[sid].unreadCount = 0;
      this.state.sessions[sid].lastReadAt = Number(last.timestamp || 0) || Date.now();
      this._persist();
    }
  }

  getLastReadMessageId(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    return String(this.state.sessions[sid]?.lastReadMessageId || '');
  }

  getFirstUnreadMessageId(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    if (!this.state.sessions[sid]) return '';
    const msgs = this.getMessages(sid) || [];
    const lastRead = this.getLastReadMessageId(sid);
    const startIdx = lastRead ? msgs.findIndex(m => String(m?.id || '') === lastRead) : -1;
    if (this._useV2) {
      const unread = Number(this.state.sessions[sid]?.unreadCount || 0);
      if (startIdx === -1 && unread <= 0) return '';
      if (startIdx === -1) {
        const lastReadAt = Number(this.state.sessions[sid]?.lastReadAt || 0);
        if (lastReadAt > 0) {
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (!m || m.role !== 'assistant') continue;
            if (Number(m.timestamp || 0) > lastReadAt) return String(m.id || '');
          }
        }
      }
      if (unread > 0 && startIdx === -1) {
        let count = 0;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m) continue;
          if (m.role !== 'assistant') continue;
          count += 1;
          if (count === unread) return String(m.id || '');
        }
        return '';
      }
    }
    const from = startIdx >= 0 ? startIdx + 1 : 0;
    for (let i = from; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m) continue;
      if (m.role === 'assistant') return String(m.id || '');
    }
    return '';
  }

  getUnreadCount(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return 0;
    if (!this.state.sessions[sid]) return 0;
    if (this._useV2 && Number.isFinite(this.state.sessions[sid]?.unreadCount)) {
      return Number(this.state.sessions[sid].unreadCount || 0);
    }
    const msgs = this.getMessages(sid) || [];
    const lastRead = this.getLastReadMessageId(sid);
    const startIdx = lastRead ? msgs.findIndex(m => String(m?.id || '') === lastRead) : -1;
    const from = startIdx >= 0 ? startIdx + 1 : 0;
    let n = 0;
    for (let i = from; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m) continue;
      if (m.role === 'assistant') n++;
    }
    return n;
  }

  hasMessages(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const msgs = this.getMessages(sid) || [];
    if (msgs.some(isConversationMessage)) return true;
    if (this._useV2) {
      const curAid = String(this.state.sessions[sid]?.currentArchiveId || '').trim();
      if (this._v2.getThreadTotal(sid, curAid) > 0) return true;
      const snap = this._v2.getLastMessageSnapshot(sid);
      if (snap && isConversationMessage(snap)) return true;
    }
    return false;
  }

  setDraft(text, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].draft = text;
    this._persist();
    return true;
  }

  getGlobalVariable(key) {
    const name = String(key || '').trim();
    if (!name) return undefined;
    const globals = this.state.globalVariables || {};
    return globals[name];
  }

  setGlobalVariable(key, value) {
    const name = String(key || '').trim();
    if (!name) return false;
    if (!this.state.globalVariables || typeof this.state.globalVariables !== 'object') {
      this.state.globalVariables = {};
    }
    this.state.globalVariables[name] = value;
    this._persist();
    return true;
  }

  listGlobalVariables() {
    const globals = this.state.globalVariables || {};
    return { ...globals };
  }

  patchGlobalVariables(updates) {
    if (!updates || typeof updates !== 'object') return false;
    if (!this.state.globalVariables || typeof this.state.globalVariables !== 'object') {
      this.state.globalVariables = {};
    }
    Object.entries(updates).forEach(([name, value]) => {
      const key = String(name || '').trim();
      if (!key) return;
      this.state.globalVariables[key] = value;
    });
    this._persist();
    return true;
  }

  deleteGlobalVariable(key) {
    const name = String(key || '').trim();
    if (!name) return false;
    if (!this.state.globalVariables || typeof this.state.globalVariables !== 'object') {
      this.state.globalVariables = {};
    }
    if (!Object.prototype.hasOwnProperty.call(this.state.globalVariables, name)) return false;
    delete this.state.globalVariables[name];
    this._persist();
    return true;
  }

  clearGlobalVariables() {
    this.state.globalVariables = {};
    this._persist();
    return true;
  }

  getInitialVariable(key, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return undefined;
    const name = String(key || '').trim();
    if (!name) return undefined;
    return this.state.sessions[sid]?.initialVariables?.[name];
  }

  setInitialVariable(key, value, id = this.currentId) {
    const sid = String(id || '').trim();
    const name = String(key || '').trim();
    if (!sid || !name) return false;
    this._ensureSession(sid);
    if (!this.state.sessions[sid].initialVariables || typeof this.state.sessions[sid].initialVariables !== 'object') {
      this.state.sessions[sid].initialVariables = {};
    }
    this.state.sessions[sid].initialVariables[name] = value;
    this._persist();
    return true;
  }

  listInitialVariables(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return {};
    const vars = this.state.sessions[sid]?.initialVariables || {};
    return { ...vars };
  }

  deleteInitialVariable(key, id = this.currentId) {
    const sid = String(id || '').trim();
    const name = String(key || '').trim();
    if (!sid || !name) return false;
    this._ensureSession(sid);
    const vars = this.state.sessions[sid].initialVariables || {};
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return false;
    delete vars[name];
    this._persist();
    return true;
  }

  clearInitialVariables(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].initialVariables = {};
    this._persist();
    return true;
  }

  getVariable(key, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return undefined;
    const session = this.state.sessions[sid];
    return session?.variables?.[key];
  }

  setVariable(key, value, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const schemas = this.state.sessions[sid].variableSchemas || {};
    const schema = schemas[String(key || '')];
    const nextValue = schema ? coerceVariableValue(value, schema) : value;
    this.state.sessions[sid].variables[key] = nextValue;
    this._persist();
    return true;
  }

  listVariables(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return {};
    const vars = this.state.sessions[sid]?.variables || {};
    return { ...vars };
  }

  getVariableSchema(key, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const k = String(key || '').trim();
    if (!k) return null;
    const schema = this.state.sessions[sid]?.variableSchemas?.[k];
    return schema ? normalizeVariableSchema(schema) : null;
  }

  listVariableSchemas(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return {};
    const schemas = this.state.sessions[sid]?.variableSchemas || {};
    const out = {};
    Object.entries(schemas).forEach(([k, v]) => {
      out[String(k)] = normalizeVariableSchema(v);
    });
    return out;
  }

  setVariableSchema(key, schema, id = this.currentId, options = {}) {
    const sid = String(id || '').trim();
    const name = String(key || '').trim();
    if (!sid || !name) return false;
    this._ensureSession(sid);
    const normalized = normalizeVariableSchema({ ...(schema || {}), id: name, name });
    this.state.sessions[sid].variableSchemas[name] = normalized;
    const existing = this.state.sessions[sid].variables?.[name];
    if (existing === undefined || existing === null) {
      const nextValue = normalized.default !== undefined ? normalized.default : '';
      this.state.sessions[sid].variables[name] = coerceVariableValue(nextValue, normalized);
    } else if (options?.preserveExistingValue === true) {
      this.state.sessions[sid].variables[name] = existing;
    } else {
      this.state.sessions[sid].variables[name] = coerceVariableValue(existing, normalized);
    }
    this._persist();
    return true;
  }

  deleteVariableSchema(key, id = this.currentId) {
    const sid = String(id || '').trim();
    const name = String(key || '').trim();
    if (!sid || !name) return false;
    this._ensureSession(sid);
    const schemas = this.state.sessions[sid].variableSchemas || {};
    if (!Object.prototype.hasOwnProperty.call(schemas, name)) return false;
    delete schemas[name];
    this._persist();
    return true;
  }

  clearVariableSchemas(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].variableSchemas = {};
    this._persist();
    return true;
  }

  listVariableRules(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return [];
    return Array.isArray(this.state.sessions[sid]?.variableRules)
      ? [...this.state.sessions[sid].variableRules]
      : [];
  }

  setVariableRules(rules, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const list = Array.isArray(rules) ? rules.filter(Boolean) : [];
    this.state.sessions[sid].variableRules = list;
    this._persist();
    return true;
  }

  getStageSchema(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const schema = this.state.sessions[sid]?.stageSchema;
    return schema && typeof schema === 'object' ? { ...schema } : null;
  }

  setStageSchema(schema, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].stageSchema = schema && typeof schema === 'object' ? { ...schema } : null;
    this._persist();
    return true;
  }

  clearStageSchema(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].stageSchema = null;
    this._persist();
    return true;
  }

  deleteVariable(key, id = this.currentId) {
    const k = String(key || '').trim();
    if (!k) return false;
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const vars = this.state.sessions[sid].variables || {};
    if (!Object.prototype.hasOwnProperty.call(vars, k)) return false;
    delete vars[k];
    this._persist();
    return true;
  }

  clearVariables(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].variables = {};
    this._persist();
    return true;
  }

  // C 计划 M1：整表替换会话变量（swipe 快照还原用），单次 persist，应用 schema coerce（与 setVariable 一致）。
  replaceVariables(map = {}, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const next = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
    const schemas = this.state.sessions[sid].variableSchemas || {};
    const out = {};
    Object.entries(next).forEach(([key, value]) => {
      const schema = schemas[String(key || '')];
      out[key] = schema ? coerceVariableValue(value, schema) : value;
    });
    this.state.sessions[sid].variables = out;
    this._persist();
    return true;
  }

  getDraft(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    return this.state.sessions[sid]?.draft || '';
  }

  clear(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return;
    if (this.state.sessions[sid]) {
      this.state.sessions[sid].messages = [];
      this.state.sessions[sid].draft = '';
      this.state.sessions[sid].lastRawResponse = '';
      this.state.sessions[sid].lastRawAt = 0;
      this.state.sessions[sid].lastRawTruncated = false;
      this.state.sessions[sid].lastRawTurnId = '';
      this.state.sessions[sid].lastRawSourceSessionId = '';
      this.state.sessions[sid].lastRawTargetSessionId = '';
      this.state.sessions[sid].lastRawTargetSessionIds = [];
      this.state.sessions[sid].lastRawSourceKind = 'social_turn_raw';
      this.state.sessions[sid].lastRawSourceMessageIds = [];
      this.state.sessions[sid].lastRawPendingRepair = false;
      this.state.sessions[sid].unreadCount = 0;
      if (this._useV2) {
        const aid = String(this.state.sessions[sid]?.currentArchiveId || '').trim();
        const threadKey = this._getThreadKey(sid, aid);
        this._invalidateThreadLoad(threadKey);
        this._clearThreadState(threadKey);
        const v2 = this._v2;
        const releaseThreadReset = this._beginThreadReset(threadKey);
        v2.enqueue(async () => {
          try {
            await v2.resetThread(sid, aid);
          } finally {
            releaseThreadReset();
          }
        });
      }
      this._persist();
    }
  }

  delete(id) {
    const sid = String(id || '').trim();
    if (!sid) return;
    const wasCurrent = String(this.currentId || '').trim() === sid;
    this._invalidateSessionLoads(sid);
    delete this.state.sessions[sid];
    if (wasCurrent) {
      const remaining = this.listSessions();
      const nextId = remaining.length ? remaining[0] : '';
      this.currentId = nextId;
      this.state.currentId = nextId;
    }
    if (this._useV2 && sid) {
      for (const key of this._v2ThreadState.keys()) {
        if (key.startsWith(`${sid}::`)) this._v2ThreadState.delete(key);
      }
      const v2 = this._v2;
      v2.enqueue(async () => {
        await v2.deleteSession(sid);
      });
    }
    this._persist();
  }

  rename(oldId, newId) {
    const from = String(oldId || '').trim();
    const to = String(newId || '').trim();
    if (!from || !to) return;
    if (!this.state.sessions[from]) return;
    if (this.state.sessions[to]) return; // prevent overwrite
    this._invalidateSessionLoads(from);
    this._invalidateSessionLoads(to);
    this.state.sessions[to] = this.state.sessions[from];
    delete this.state.sessions[from];
    if (this.currentId === from) {
      this.currentId = to;
      this.state.currentId = to;
    }
    if (this._useV2) {
      const v2 = this._v2;
      v2.enqueue(async () => {
        await v2.renameSession(from, to);
      });
    }
    this._persist();
  }

  getSessionSettings(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    return this.state.sessions[sid]?.settings || null;
  }

  setSessionSettings(id = this.currentId, settings) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].settings = settings;
    this._persist();
    return true;
  }

  clearMessages(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return;
    if (this.state.sessions[sid]) {
      this.state.sessions[sid].messages = [];
      this.state.sessions[sid].unreadCount = 0;
      if (this._useV2) {
        const aid = String(this.state.sessions[sid]?.currentArchiveId || '').trim();
        const threadKey = this._getThreadKey(sid, aid);
        this._invalidateThreadLoad(threadKey);
        this._clearThreadState(threadKey);
        const v2 = this._v2;
        const releaseThreadReset = this._beginThreadReset(threadKey);
        v2.enqueue(async () => {
          try {
            await v2.resetThread(sid, aid);
          } finally {
            releaseThreadReset();
          }
        });
      }
      this._persist();
    }
  }

  deleteMessage(msgId, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const session = this.state.sessions[sid];
    if (!session || !session.messages) return false;
    const targetId = String(msgId || '').trim();
    if (!targetId) return false;
    const before = session.messages.length;
    const idx = session.messages.findIndex(m => String(m?.id || '') === targetId);
    if (idx === -1) return false;
    const target = session.messages[idx];

    const lastRead = String(session.lastReadMessageId || '');
    const wasLastRead = lastRead && lastRead === targetId;

    session.messages = session.messages.filter(m => String(m?.id || '') !== targetId);
    const changed = session.messages.length !== before;
    if (!changed) return false;

    this._deleteRawOriginal(target, sid);
    if (target?.role === 'assistant' && Number(session.unreadCount || 0) > 0) {
      session.unreadCount = Math.max(0, Number(session.unreadCount || 0) - 1);
    }
    if (this._useV2) {
      const aid = String(session.currentArchiveId || '').trim();
      const threadKey = this._getThreadKey(sid, aid);
      const threadState = this._getThreadState(threadKey);
      const partId = threadState.messagePartMap.get(targetId);
      const v2 = this._v2;
      v2.enqueue(async () => {
        await v2.deleteMessage(sid, aid, targetId, partId || '');
      });
      threadState.messagePartMap.delete(targetId);
    }

    // If we deleted the message that "lastReadMessageId" points to,
    // keep the read pointer stable by moving it to a nearby existing message.
    if (wasLastRead) {
      const fallback =
        idx - 1 >= 0 && session.messages[idx - 1]?.id
          ? String(session.messages[idx - 1].id)
          : session.messages.length
          ? String(session.messages[session.messages.length - 1]?.id || '')
          : '';
      session.lastReadMessageId = fallback;
      if (fallback) {
        const picked = session.messages.find(m => String(m?.id || '') === fallback);
        session.lastReadAt = picked && Number.isFinite(picked.timestamp)
          ? Number(picked.timestamp || 0) || Date.now()
          : Date.now();
      } else {
        session.lastReadAt = 0;
      }
    }

    this._persist();
    return true;
  }

  updateMessage(msgId, updater, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const session = this.state.sessions[sid];
    if (!session || !session.messages) return null;
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx === -1) return null;
    const previous = session.messages[idx];
    const updated = ensureId({ ...previous, ...updater });
    session.messages[idx] = updated;
    if (previous.id !== updated.id || previous.role !== updated.role) {
      this._messageStructureRevisions.set(session.messages, this.getMessageStructureRevision(sid) + 1);
    }
    if (typeof updater?.rawOriginal === 'string') {
      this._persistRawOriginal(updated, sid);
    }
    if (this._useV2) {
      const aid = String(session.currentArchiveId || '').trim();
      const threadKey = this._getThreadKey(sid, aid);
      const threadState = this._getThreadState(threadKey);
      const partId = threadState.messagePartMap.get(String(msgId || ''));
      const v2 = this._v2;
      const patch = { ...updater, id: updated.id, timestamp: updated.timestamp };
      v2.enqueue(async () => {
        await v2.updateMessage(sid, aid, msgId, patch, partId || '');
      });
    }
    this._persist();
    return updated;
  }

  // A local text edit changes one message and, when linked, its original protocol
  // turn. Preserve envelope membership/timestamps; never redistribute the turn.
  updateMessageTextSelection({ messageId, sessionId, patch, sourceEnvelope = null } = {}) {
    if (!this.findMessage(messageId, sessionId)) return null;
    let sourceSession = null;
    if (sourceEnvelope) {
      const { sourceSessionId, expected, text } = sourceEnvelope;
      sourceSession = this.state.sessions[sourceSessionId];
      const current = this.getLastRawResponseEnvelope(sourceSessionId);
      if (!sourceSession || !expected || current.truncated || typeof text !== 'string' || text.length > 220_000 ||
        current.text !== expected.text || current.turnId !== expected.turnId ||
        JSON.stringify(current.sourceMessageIds) !== JSON.stringify(expected.sourceMessageIds) ||
        (expected.archiveId !== undefined && (this.getCurrentArchiveId(sourceSessionId) || '') !== expected.archiveId)) return null;
    }
    // Both in-memory updates are synchronous; updateMessage persists the shared
    // session metadata and queues the existing V2 message/raw-original write.
    if (sourceSession) sourceSession.lastRawResponse = sourceEnvelope.text;
    const updated = this.updateMessage(messageId, patch, sessionId);
    if (updated && patch?.rawOriginal === '') this._deleteRawOriginal(updated, sessionId);
    return updated;
  }

  findMessage(msgId, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    return this.state.sessions[sid]?.messages?.find(m => m.id === msgId) || null;
  }

  switchSession(id) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    if (isForeignRpSessionForScope(sid, this.scopeId)) return false;
    this.setCurrent(sid);
    this._ensureSession(sid);
    this._persist();
    return true;
  }

  setLastRawResponse(text, id = this.currentId, metadata = {}) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const raw = String(text ?? '');
    // keep bounded to reduce quota risks
    const maxLen = 220_000;
    const truncated = raw.length > maxLen;
    const session = this.state.sessions[sid];
    session.lastRawResponse = truncated ? raw.slice(-maxLen) : raw;
    session.lastRawAt = Date.now();
    session.lastRawTruncated = truncated;
    session.lastRawTurnId = String(metadata?.turnId || '').trim();
    session.lastRawSourceSessionId = String(metadata?.sourceSessionId || sid).trim() || sid;
    session.lastRawTargetSessionId = String(metadata?.targetSessionId || '').trim();
    session.lastRawTargetSessionIds = session.lastRawTargetSessionId
      ? [session.lastRawTargetSessionId]
      : [];
    session.lastRawSourceKind = String(metadata?.sourceKind || 'social_turn_raw').trim() || 'social_turn_raw';
    session.lastRawSourceMessageIds = [];
    // 待修复必须由协议驳回现场显式标记：历史信封与普通成功回复都默认 false，不能靠“没有消息 id”反推。
    session.lastRawPendingRepair = false;
    this._persist();
    return true;
  }

  markLastRawResponsePendingRepair({ sourceSessionId = this.currentId, turnId = '' } = {}) {
    const sid = String(sourceSessionId || '').trim();
    const tid = String(turnId || '').trim();
    if (!sid || !tid) return false;
    const session = this.state.sessions[sid];
    if (!session || String(session.lastRawTurnId || '').trim() !== tid) return false;
    session.lastRawPendingRepair = true;
    this._persist();
    return true;
  }

  registerLastRawResponseSourceMessage({
    sourceSessionId = this.currentId,
    targetSessionId = '',
    turnId = '',
    messageId = '',
  } = {}) {
    const sid = String(sourceSessionId || '').trim();
    const tid = String(turnId || '').trim();
    const mid = String(messageId || '').trim();
    if (!sid || !tid || !mid) return false;
    const session = this.state.sessions[sid];
    if (!session || String(session.lastRawTurnId || '').trim() !== tid) return false;
    if (!Array.isArray(session.lastRawSourceMessageIds)) session.lastRawSourceMessageIds = [];
    if (!session.lastRawSourceMessageIds.includes(mid)) session.lastRawSourceMessageIds.push(mid);
    const targetSid = String(targetSessionId || '').trim();
    if (targetSid) {
      if (!Array.isArray(session.lastRawTargetSessionIds)) session.lastRawTargetSessionIds = [];
      if (!session.lastRawTargetSessionIds.includes(targetSid)) session.lastRawTargetSessionIds.push(targetSid);
      if (!session.lastRawTargetSessionId) session.lastRawTargetSessionId = targetSid;
    }
    this._persist();
    return true;
  }

  getPersonaLock(id = this.currentId) {
    try {
      const sid = String(id || '').trim();
      if (!sid) return '';
      const s = this.state.sessions[sid];
      const pid = s?.settings?.personaLockId;
      return pid ? String(pid) : '';
    } catch {
      return '';
    }
  }

  setPersonaLock(id = this.currentId, personaId) {
    const sid = String(id || '').trim();
    const pid = String(personaId || '').trim();
    if (!sid) return false;
    if (!pid) return false;
    this._ensureSession(sid);
    this.state.sessions[sid].settings.personaLockId = pid;
    this._persist();
    return true;
  }

  clearPersonaLock(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    delete this.state.sessions[sid].settings.personaLockId;
    this._persist();
    return true;
  }

  getLastRawResponse(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    return String(this.state.sessions[sid]?.lastRawResponse || '');
  }

  getLastRawAt(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return 0;
    return Number(this.state.sessions[sid]?.lastRawAt || 0) || 0;
  }

  getLastRawResponseEnvelope(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const session = this.state.sessions[sid] || {};
    return {
      text: String(session.lastRawResponse || ''),
      at: Number(session.lastRawAt || 0) || 0,
      truncated: session.lastRawTruncated === true,
      turnId: String(session.lastRawTurnId || '').trim(),
      sourceSessionId: String(session.lastRawSourceSessionId || sid).trim() || sid,
      targetSessionId: String(session.lastRawTargetSessionId || '').trim(),
      targetSessionIds: Array.isArray(session.lastRawTargetSessionIds)
        ? session.lastRawTargetSessionIds.map(item => String(item || '').trim()).filter(Boolean)
        : [],
      sourceKind: String(session.lastRawSourceKind || 'social_turn_raw').trim() || 'social_turn_raw',
      sourceMessageIds: Array.isArray(session.lastRawSourceMessageIds)
        ? session.lastRawSourceMessageIds.map(item => String(item || '').trim()).filter(Boolean)
        : [],
      pendingRepair: session.lastRawPendingRepair === true,
    };
  }

  _tsSuffix() {
    const d = new Date();
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(
      2,
      '0',
    )} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  subscribeArchives(listener) {
    this._archiveListeners ||= new Set();
    this._archiveListeners.add(listener);
    return () => this._archiveListeners.delete(listener);
  }

  _emitArchiveEvent(event) {
    for (const listener of this._archiveListeners || []) {
      try { listener({ ...event, scopeId: this.scopeId }); } catch {}
    }
  }

  archiveCurrentMessages(id = this.currentId, name = '', forceCreate = false, options = {}) {
    const sid = String(id || '').trim();
    if (!sid || !this.state.sessions[sid]) return null;
    const session = this.state.sessions[sid];
    const messages = session.messages || [];
    const currentArchiveId = session.currentArchiveId;
    const totalMessages = this._useV2
      ? Math.max(this._v2.getThreadTotal(sid, currentArchiveId), messages.length)
      : messages.length;
    if (!totalMessages) return null;
    this._lastArchiveTransition = null;

    if (!session.archives) {
      session.archives = [];
    }

    const timestamp = Date.now();
    const suffix = ` (${this._tsSuffix()})`;

    const memoryTableSnapshot = options?.memoryTableSnapshot;

    // 1. Update existing archive (if not forced new and attached)
    if (!forceCreate && currentArchiveId) {
      const idx = session.archives.findIndex(a => a.id === currentArchiveId);
      if (idx !== -1) {
        session.archives[idx].timestamp = timestamp;
        session.archives[idx].messageCount = totalMessages;
        if (memoryTableSnapshot) {
          session.archives[idx].memoryTableSnapshot = memoryTableSnapshot;
        }
        // Snapshot summaries into archive (for attached mode, it's the source of truth)
        try {
          const list = session.archives[idx].summaries;
          if (!Array.isArray(list)) session.archives[idx].summaries = [];
        } catch {}
        if (name) {
          const clean = name.trim();
          session.archives[idx].name = clean;
        }
        this._lastArchiveTransition = {
          sessionId: sid,
          archivedCurrentId: currentArchiveId,
          mode: 'update_existing',
          timestamp,
        };
        this._persist();
        return currentArchiveId;
      }
    }

    // 2. Create new archive
    const archiveId = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const cleanName = String(name || '').trim();
    const baseName = cleanName || `存档${suffix}`;

    const getCurrentSummariesSnapshot = () => {
      try {
        const session = this.state.sessions[sid];
        const curAid = session.currentArchiveId;
        if (curAid && Array.isArray(session.archives)) {
          const arc = session.archives.find(a => a.id === curAid);
          const list = arc?.summaries;
          return Array.isArray(list)
            ? list
                .map(it => {
                  if (!it) return null;
                  if (typeof it === 'string') return { at: 0, text: String(it) };
                  const text = String(it.text || '').trim();
                  if (!text) return null;
                  const at = Number(it.at || 0) || 0;
                  return { at, text };
                })
                .filter(Boolean)
            : [];
        }
        const src = session.detachedSummaries;
        return Array.isArray(src)
          ? src
              .map(it => {
                if (!it) return null;
                if (typeof it === 'string') return { at: 0, text: String(it) };
                const text = String(it.text || '').trim();
                if (!text) return null;
                const at = Number(it.at || 0) || 0;
                return { at, text };
              })
              .filter(Boolean)
          : [];
      } catch {
        return [];
      }
    };
    const getCurrentCompactedSummarySnapshot = () => {
      try {
        const session = this.state.sessions[sid];
        const curAid = session.currentArchiveId;
        if (curAid && Array.isArray(session.archives)) {
          const arc = session.archives.find(a => a.id === curAid);
          const cs = arc?.compactedSummary;
          if (!cs || typeof cs !== 'object') return null;
          const text = String(cs.text || '').trim();
          if (!text) return null;
          const at = Number(cs.at || 0) || 0;
          return { at, text };
        }
        const cs = session.compactedSummary;
        if (!cs || typeof cs !== 'object') return null;
        const text = String(cs.text || '').trim();
        if (!text) return null;
        const at = Number(cs.at || 0) || 0;
        return { at, text };
      } catch {
        return null;
      }
    };

    const nextArchive = {
      id: archiveId,
      name: baseName,
      timestamp,
      messageCount: totalMessages,
      summaries: getCurrentSummariesSnapshot(),
      compactedSummary: getCurrentCompactedSummarySnapshot(),
    };
    if (memoryTableSnapshot) {
      nextArchive.memoryTableSnapshot = memoryTableSnapshot;
    }
    session.archives.push(nextArchive);
    if (this._useV2) {
      const sid = String(id || '').trim();
      const threadKey = this._getThreadKey(sid, '');
      this._getThreadState(threadKey, { reset: true });
      const v2 = this._v2;
      const releaseThreadReset = this._beginThreadReset(threadKey);
      v2.enqueue(async () => {
        try {
          await v2.cloneCurrentToArchive(sid, archiveId);
        } finally {
          releaseThreadReset();
        }
      });
    }

    this._persist();
    this._lastArchiveTransition = {
      sessionId: sid,
      archivedCurrentId: archiveId,
      mode: 'create_new',
      timestamp,
    };
    this._emitArchiveEvent({ type: 'created', sessionId: sid, archiveId, automaticName: !cleanName || options.automaticName === true });
    return archiveId;
  }

  startNewChat(id = this.currentId, archiveName = '', options = {}) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const session = this.state.sessions[sid];
    if (!session) return null;
    if (this._useV2) {
      const previousArchiveId = String(session.currentArchiveId || '').trim();
      this._invalidateThreadLoad(this._getThreadKey(sid, previousArchiveId));
      if (previousArchiveId) this._invalidateThreadLoad(this._getThreadKey(sid, ''));
    }

    let archiveId = null;
    const totalMessages = this._useV2
      ? Math.max(
          this._v2.getThreadTotal(sid, session.currentArchiveId),
          (session.messages || []).length,
        )
      : (session.messages || []).length;
    if (totalMessages > 0) {
      const currentArchiveId = String(session.currentArchiveId || '').trim();
      archiveId = this.archiveCurrentMessages(sid, archiveName, !currentArchiveId, options);
    }

    session.messages = [];
    session.currentArchiveId = null;
    session.detachedSummaries = [];
    session.compactedSummary = null;
    session.draft = '';
    session.lastRawResponse = '';
    session.lastRawAt = 0;
    session.lastRawTruncated = false;
    session.lastRawTurnId = '';
    session.lastRawSourceSessionId = '';
    session.lastRawTargetSessionId = '';
    session.lastRawTargetSessionIds = [];
    session.lastRawSourceKind = 'social_turn_raw';
    session.lastRawSourceMessageIds = [];
    session.lastRawPendingRepair = false;
    session.unreadCount = 0;
    if (this._useV2) {
      const threadKey = this._getThreadKey(sid, '');
      this._getThreadState(threadKey, { reset: true });
    }
    this._persist();
    return archiveId;
  }

  getArchives(id = this.currentId) {
    const sid = String(id || '').trim();
    const list = this.state.sessions[sid]?.archives || [];
    if (this._useV2) {
      for (const arc of list) {
        const aid = String(arc?.id || '').trim();
        if (!aid) continue;
        const thread = this._v2.getThread(sid, aid);
        if (thread && Number.isFinite(thread.total)) arc.messageCount = thread.total;
      }
    }
    return list.sort((a, b) => b.timestamp - a.timestamp);
  }

  renameArchive(archiveId, name = '', id = this.currentId) {
    const sid = String(id || '').trim();
    const aid = String(archiveId || '').trim();
    const cleanName = String(name || '').trim();
    if (!sid || !aid || !cleanName) return false;
    const session = this.state.sessions[sid];
    if (!session || !Array.isArray(session.archives)) return false;
    const archive = session.archives.find(a => String(a?.id || '').trim() === aid);
    if (!archive) return false;
    if (String(archive.name || '') === cleanName) {
      this._emitArchiveEvent({ type: 'renamed', sessionId: sid, archiveId: aid });
      return true;
    }
    archive.name = cleanName;
    archive.updatedAt = Date.now();
    this._persist();
    this._emitArchiveEvent({ type: 'renamed', sessionId: sid, archiveId: aid });
    return true;
  }

  async loadArchivedMessages(archiveId, id = this.currentId, options = {}) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const token = this._scopeToken;
    const scopeId = this.scopeId;
    const session = this.state.sessions[sid];
    if (!session || !session.archives) return false;

    const archive = session.archives.find(a => a.id === archiveId);
    if (!archive) return false;
    this._lastArchiveTransition = null;
    if (this._useV2) {
      const previousArchiveId = String(session.currentArchiveId || '').trim();
      this._invalidateThreadLoad(this._getThreadKey(sid, previousArchiveId));
      this._invalidateThreadLoad(this._getThreadKey(sid, archiveId));
    }

    // Save current state before switching
    const totalMessages = this._useV2
      ? this._v2.getThreadTotal(sid, session.currentArchiveId)
      : (session.messages || []).length;
    let archivedCurrentId = '';
    if (totalMessages > 0) {
      const isDetached = !session.currentArchiveId;
      const autoName = isDetached ? '自动存档' : '';
      archivedCurrentId = String(this.archiveCurrentMessages(sid, autoName, false, { ...options, automaticName: true }) || '').trim();
    }

    session.currentArchiveId = archiveId;
    if (this._useV2) {
      await this._loadRecentMessages(sid, archiveId, { token, scopeId });
    } else {
      session.messages = Array.isArray(archive.messages) ? [...archive.messages] : [];
    }
    if (this._isScopeStale(token, scopeId)) return false;
    this._lastArchiveTransition = {
      sessionId: sid,
      loadedArchiveId: String(archiveId || '').trim(),
      archivedCurrentId,
      mode: 'load_archive',
      timestamp: Date.now(),
    };
    this._persist();
    return true;
  }

  deleteArchive(archiveId, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const session = this.state.sessions[sid];
    if (!session || !session.archives) return false;
    session.archives = session.archives.filter(a => a.id !== archiveId);
    this._emitArchiveEvent({ type: 'deleted', sessionId: sid, archiveId });
    if (session.currentArchiveId === archiveId) {
      session.currentArchiveId = null;
    }
    if (this._useV2) {
      const aid = String(archiveId || '').trim();
      this._invalidateThreadLoad(this._getThreadKey(sid, aid));
      this._clearThreadState(this._getThreadKey(sid, aid));
      const v2 = this._v2;
      v2.enqueue(async () => {
        await v2.deleteArchive(sid, aid);
      });
    }
    this._persist();
    return true;
  }

  getCurrentArchiveId(id = this.currentId) {
    try {
      const sid = String(id || '').trim();
      if (!sid) return null;
      return this.state.sessions[sid]?.currentArchiveId || null;
    } catch {
      return null;
    }
  }

  getLastArchiveTransition(id = this.currentId) {
    try {
      const sid = String(id || '').trim();
      if (!sid) return null;
      const detail = this._lastArchiveTransition;
      if (!detail || String(detail.sessionId || '').trim() !== sid) return null;
      return { ...detail };
    } catch {
      return null;
    }
  }

  getSummaries(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return [];
    const session = this.state.sessions[sid];
    if (!session) return [];
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      const list = arc?.summaries;
      return Array.isArray(list) ? list : [];
    }
    return Array.isArray(session.detachedSummaries) ? session.detachedSummaries : [];
  }

  _setSummariesInternal(nextList, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const next = Array.isArray(nextList) ? nextList : [];
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc) {
        arc.summaries = next;
        this._persist();
        return true;
      }
    }
    session.detachedSummaries = next;
    this._persist();
    return true;
  }

  setSummaries(items, id = this.currentId) {
    const list = Array.isArray(items) ? items : [];
    const normalized = list
      .map(it => {
        if (!it || typeof it !== 'object') return null;
        const text = String(it.text || '').trim();
        if (!text) return null;
        const at = Number(it.at || 0) || Date.now();
        return { at, text };
      })
      .filter(Boolean);
    return this._setSummariesInternal(normalized, id);
  }

  deleteSummaryItems(items, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const picks = Array.isArray(items) ? items : [];
    if (!picks.length) return false;
    const keys = new Set(
      picks
        .map(it => {
          if (!it) return '';
          if (typeof it === 'string') return String(it);
          const at = Number(it.at || 0) || 0;
          const text = String(it.text || '');
          return `${at}|${text}`;
        })
        .filter(Boolean),
    );
    if (!keys.size) return false;
    const cur = this.getSummaries(sid) || [];
    const next = (Array.isArray(cur) ? cur : []).filter(it => {
      const at = typeof it === 'object' && it ? Number(it.at || 0) || 0 : 0;
      const text = String(typeof it === 'string' ? it : it?.text || '');
      return !keys.has(`${at}|${text}`);
    });
    return this._setSummariesInternal(next, sid);
  }

  updateSummaryItems(updates, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const list = Array.isArray(updates) ? updates : [];
    if (!list.length) return false;
    const map = new Map();
    for (const u of list) {
      if (!u || typeof u !== 'object') continue;
      const at = Number(u.at || 0) || 0;
      const fromText = String(u.fromText ?? u.text ?? '');
      const toText = String(u.toText ?? '').trim();
      if (!at || !fromText || !toText) continue;
      map.set(`${at}|${fromText}`, toText);
    }
    if (!map.size) return false;
    const cur = this.getSummaries(sid) || [];
    const next = (Array.isArray(cur) ? cur : []).map(it => {
      const at = typeof it === 'object' && it ? Number(it.at || 0) || 0 : 0;
      const text = String(typeof it === 'string' ? it : it?.text || '');
      const key = `${at}|${text}`;
      if (!map.has(key)) return it;
      const toText = map.get(key);
      if (typeof it === 'string') return toText;
      return { ...(it || {}), at, text: toText };
    });
    return this._setSummariesInternal(next, sid);
  }

  getCompactedSummary(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const session = this.state.sessions[sid];
    if (!session) return null;
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      const cs = arc?.compactedSummary;
      if (cs && typeof cs === 'object') {
        const text = String(cs.text || '').trim();
        if (!text) return null;
        const at = Number(cs.at || 0) || 0;
        const raw = typeof cs.raw === 'string' ? cs.raw : '';
        return { at, text, raw };
      }
      return null;
    }
    const cs = session.compactedSummary;
    if (!cs || typeof cs !== 'object') return null;
    const text = String(cs.text || '').trim();
    if (!text) return null;
    const at = Number(cs.at || 0) || 0;
    const raw = typeof cs.raw === 'string' ? cs.raw : '';
    return { at, text, raw };
  }

  getCompactedSummaryRaw(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return '';
    const session = this.state.sessions[sid];
    if (!session) return '';
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      const cs = arc?.compactedSummary;
      if (cs && typeof cs === 'object' && typeof cs.raw === 'string' && cs.raw.trim()) return cs.raw;
      const lr = arc?.compactedSummaryLastRaw;
      if (lr && typeof lr === 'object' && typeof lr.raw === 'string' && lr.raw.trim()) return lr.raw;
      return '';
    }
    const cs = session.compactedSummary;
    if (cs && typeof cs === 'object' && typeof cs.raw === 'string' && cs.raw.trim()) return cs.raw;
    const lr = session.compactedSummaryLastRaw;
    if (lr && typeof lr === 'object' && typeof lr.raw === 'string' && lr.raw.trim()) return lr.raw;
    return '';
  }

  setCompactedSummaryRaw(raw, id = this.currentId, { at = Date.now() } = {}) {
    const sid = String(id || '').trim();
    const text = String(raw || '').trim();
    if (!sid || !text) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const item = { at: Number(at || Date.now()) || Date.now(), raw: text };
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc) {
        arc.compactedSummaryLastRaw = item;
        this._persist();
        return true;
      }
    }
    session.compactedSummaryLastRaw = item;
    this._persist();
    return true;
  }

  setCompactedSummary(summaryText, id = this.currentId, { at = Date.now(), raw } = {}) {
    const sid = String(id || '').trim();
    const text = String(summaryText || '').trim();
    if (!sid || !text) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const ts = Number(at || Date.now()) || Date.now();
    const rawText = typeof raw === 'string' ? raw : null;
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc) {
        const prevRaw =
          arc.compactedSummary &&
          typeof arc.compactedSummary === 'object' &&
          typeof arc.compactedSummary.raw === 'string'
            ? arc.compactedSummary.raw
            : '';
        arc.compactedSummary = { at: ts, text, raw: rawText == null ? prevRaw : rawText };
        this._persist();
        return true;
      }
    }
    const prevRaw =
      session.compactedSummary &&
      typeof session.compactedSummary === 'object' &&
      typeof session.compactedSummary.raw === 'string'
        ? session.compactedSummary.raw
        : '';
    session.compactedSummary = { at: ts, text, raw: rawText == null ? prevRaw : rawText };
    this._persist();
    return true;
  }

  clearCompactedSummary(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc) {
        arc.compactedSummary = null;
        arc.compactedSummaryLastRaw = null;
        this._persist();
        return true;
      }
    }
    session.compactedSummary = null;
    session.compactedSummaryLastRaw = null;
    this._persist();
    return true;
  }

  addSummary(summaryText, id = this.currentId) {
    const sid = String(id || '').trim();
    const text = String(summaryText || '').trim();
    if (!sid || !text) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const item = { at: Date.now(), text };
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc) {
        if (!Array.isArray(arc.summaries)) arc.summaries = [];
        arc.summaries.push(item);
        this._persist();
        return true;
      }
    }
    if (!Array.isArray(session.detachedSummaries)) session.detachedSummaries = [];
    session.detachedSummaries.push(item);
    this._persist();
    return true;
  }

  removeLastSummary(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc && Array.isArray(arc.summaries) && arc.summaries.length) {
        arc.summaries.pop();
        this._persist();
        return true;
      }
    }
    if (!Array.isArray(session.detachedSummaries) || session.detachedSummaries.length === 0) return false;
    session.detachedSummaries.pop();
    this._persist();
    return true;
  }

  clearSummaries(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    this._ensureSession(sid);
    const session = this.state.sessions[sid];
    const curAid = session.currentArchiveId;
    if (curAid && Array.isArray(session.archives)) {
      const arc = session.archives.find(a => a.id === curAid);
      if (arc) {
        arc.summaries = [];
        this._persist();
        return true;
      }
    }
    session.detachedSummaries = [];
    this._persist();
    return true;
  }

  // ============ Pending Messages Management ============

  /**
   * Add a pending message to the queue (cached, not sent to AI yet)
   */
  addPendingMessage(message, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    this._ensureSession(sid);
    const msg = ensureId({ ...message, status: 'pending' });
    this.state.sessions[sid].pending.push(msg);
    this._persist();
    return msg;
  }

  /**
   * Get all pending messages for a session
   */
  getPendingMessages(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return [];
    return this.state.sessions[sid]?.pending || [];
  }

  /**
   * Remove a specific pending message
   */
  removePendingMessage(msgId, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const session = this.state.sessions[sid];
    if (!session || !Array.isArray(session.pending)) return false;
    const targetId = String(msgId || '').trim();
    if (!targetId) return false;
    const before = session.pending.length;
    session.pending = session.pending.filter(m => String(m?.id || '') !== targetId);
    const changed = session.pending.length !== before;
    if (changed) this._persist();
    return changed;
  }

  /**
   * Update a pending message's content
   */
  updatePendingMessage(msgId, newContent, id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const session = this.state.sessions[sid];
    if (!session || !Array.isArray(session.pending)) return null;
    const idx = session.pending.findIndex(m => String(m?.id || '') === String(msgId));
    if (idx === -1) return null;
    session.pending[idx] = { ...session.pending[idx], content: newContent, timestamp: Date.now() };
    this._persist();
    return session.pending[idx];
  }

  /**
   * Clear all pending messages for a session
   */
  clearPendingMessages(id = this.currentId) {
    const sid = String(id || '').trim();
    if (!sid) return false;
    const session = this.state.sessions[sid];
    if (!session) return false;
    session.pending = [];
    this._persist();
    return true;
  }

  /**
   * Get count of pending messages
   */
  getPendingCount(id = this.currentId) {
    return this.getPendingMessages(id).length;
  }
}

export const __chatStoreStorageInternals = {
  MAX_PERSIST_DERIVED_RICH_CONTENT_CHARS,
  MAX_PERSIST_FIELD_INLINE_CHARS,
  PERSIST_FIELD_PREVIEW_CHARS,
  V2_SIDECAR_FIELD_CHUNK_CHARS,
  buildPersistPreview,
  compactDerivedRenderRichContent,
  getOwnRpSessionIdForScope,
  isDefaultScopeId,
  isForeignRpSessionForScope,
  isScopedDataMatch,
  resolveCurrentId,
  sanitizeMessageForPersist,
  splitPersistFieldChunks,
};
