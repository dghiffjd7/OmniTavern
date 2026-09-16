import {
  emitLifecycleTraceEvent,
  normalizeLifecycleTraceDetails,
  normalizeLifecycleTraceText,
} from './lifecycle-trace-utils.js';
import { normalizeMomentMentionTarget } from './moment-world-resolver-utils.js';
import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';

const normalizeNameValue = (value) => String(value || '').trim();

const getMomentPromptLine = (key, replacements = {}) => {
  let text = getLocalizedPromptText(key);
  Object.entries(replacements).forEach(([name, value]) => {
    text = text.split(`{${name}}`).join(String(value ?? ''));
  });
  return text;
};

const buildAlphaIndex = (index) => {
  let n = Math.max(0, Math.trunc(Number(index) || 0));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out || 'A';
};

const omitUndefinedTraceDetails = (details = {}) => Object.fromEntries(
  Object.entries(details).filter(([, value]) => value !== undefined),
);

export const buildMomentLifecycleTraceEvent = ({
  phase = '',
  sessionId = '',
  momentId = '',
  status = 'info',
  summary = '',
  details = {},
} = {}) => ({
  category: 'moments',
  source: 'moments-runtime',
  phase: normalizeLifecycleTraceText(phase, 'event'),
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  momentId: normalizeLifecycleTraceText(momentId, ''),
  status: normalizeLifecycleTraceText(status, 'info'),
  summary: normalizeLifecycleTraceText(summary, ''),
  details: normalizeLifecycleTraceDetails(details),
});

export const buildMomentCommentSkippedTraceEvent = ({
  momentId = '',
  reason = '',
  hasMomentId,
  hasText,
} = {}) => ({
  phase: 'comment.skipped',
  momentId: normalizeLifecycleTraceText(momentId, ''),
  status: 'skipped',
  summary: 'moment comment skipped',
  details: omitUndefinedTraceDetails({
    reason: normalizeLifecycleTraceText(reason, ''),
    hasMomentId,
    hasText,
  }),
});

export const buildMomentCommentStartTraceEvent = ({
  sessionId = '',
  momentId = '',
  authorName = '',
  targetSessionId = '',
  targetName = '',
  stream = false,
  isReplyToComment = false,
  userCommentId = '',
  hasRecentComments = false,
} = {}) => ({
  phase: 'comment.start',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  momentId: normalizeLifecycleTraceText(momentId, ''),
  status: 'started',
  summary: 'moment comment generation started',
  details: {
    authorName,
    targetSessionId,
    targetName,
    stream: Boolean(stream),
    isReplyToComment: Boolean(isReplyToComment),
    userCommentId,
    hasRecentComments: Boolean(hasRecentComments),
  },
});

export const buildMomentCommentFinishTraceEvent = ({
  sessionId = '',
  momentId = '',
  status = '',
  authorName = '',
  stream = false,
  isReplyToComment = false,
  userCommentId = '',
  sawMomentReply = false,
  fullRaw = '',
  started = false,
  errorMessage = '',
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, '');
  if (normalizedStatus === 'error') {
    return {
      phase: 'comment.finish',
      sessionId: normalizeLifecycleTraceText(sessionId, ''),
      momentId: normalizeLifecycleTraceText(momentId, ''),
      status: 'error',
      summary: errorMessage || 'moment comment generation failed',
      details: {
        authorName,
        isReplyToComment: Boolean(isReplyToComment),
        userCommentId,
        started: Boolean(started),
      },
    };
  }

  const replyParsed = Boolean(sawMomentReply);
  const finalStatus = normalizedStatus || (replyParsed ? 'success' : 'warning');
  return {
    phase: 'comment.finish',
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    momentId: normalizeLifecycleTraceText(momentId, ''),
    status: finalStatus,
    summary: finalStatus === 'success'
      ? 'moment comment generation finished'
      : 'moment comment reply not parsed',
    details: {
      authorName,
      stream: Boolean(stream),
      isReplyToComment: Boolean(isReplyToComment),
      userCommentId,
      sawMomentReply: replyParsed,
      rawLength: String(fullRaw || '').length,
    },
  };
};

export const buildMomentFeedCommentSkippedTraceEvent = ({
  sessionId = '',
  momentId = '',
  reason = '',
  pending = false,
  hasText,
} = {}) => ({
  phase: 'comment.local.skipped',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  momentId: normalizeLifecycleTraceText(momentId, ''),
  status: 'skipped',
  summary: 'local moment comment skipped',
  details: omitUndefinedTraceDetails({
    reason: normalizeLifecycleTraceText(reason, ''),
    pending: Boolean(pending),
    hasText,
  }),
});

export const buildMomentFeedCommentStartTraceEvent = ({
  sessionId = '',
  momentId = '',
  userCommentId = '',
  isReplyToComment = false,
} = {}) => ({
  phase: 'comment.local.start',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  momentId: normalizeLifecycleTraceText(momentId, ''),
  status: 'started',
  summary: 'local moment comment send started',
  details: {
    userCommentId: normalizeLifecycleTraceText(userCommentId, ''),
    isReplyToComment: Boolean(isReplyToComment),
  },
});

export const buildMomentFeedCommentFinishTraceEvent = ({
  sessionId = '',
  momentId = '',
  status = 'success',
  userCommentId = '',
  isReplyToComment = false,
  errorMessage = '',
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, 'success');
  return {
    phase: 'comment.local.finish',
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    momentId: normalizeLifecycleTraceText(momentId, ''),
    status: normalizedStatus,
    summary:
      normalizedStatus === 'success'
        ? 'local moment comment send finished'
        : 'local moment comment callback failed',
    details: omitUndefinedTraceDetails({
      userCommentId: normalizeLifecycleTraceText(userCommentId, ''),
      isReplyToComment: Boolean(isReplyToComment),
      errorMessage: normalizeLifecycleTraceText(errorMessage, '') || undefined,
    }),
  };
};

export const buildMomentSummaryCompactionSkippedTraceEvent = ({
  phase = 'summary.compaction.skipped',
  reason = '',
  scopeKey = 'global',
  force = false,
  itemCount,
  rawLength,
} = {}) => ({
  phase,
  status: 'skipped',
  summary: 'moment summary compaction skipped',
  details: omitUndefinedTraceDetails({
    reason: normalizeLifecycleTraceText(reason, ''),
    scopeKey,
    force,
    itemCount,
    rawLength,
  }),
});

export const buildMomentSummaryCompactionStartTraceEvent = ({
  scopeKey = 'global',
  force = false,
  itemCount = 0,
} = {}) => ({
  phase: 'summary.compaction.start',
  status: 'started',
  summary: 'moment summary compaction started',
  details: {
    scopeKey,
    force,
    itemCount,
  },
});

export const buildMomentSummaryCompactionFinishTraceEvent = ({
  status = 'success',
  reason = '',
  scopeKey = 'global',
  force = false,
  itemCount,
  keptCount = 0,
  raw,
  summaryText = '',
  errorMessage = '',
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, 'success');
  if (normalizedStatus === 'skipped') {
    return buildMomentSummaryCompactionSkippedTraceEvent({
      phase: 'summary.compaction.finish',
      reason,
      scopeKey,
      force,
      itemCount,
      rawLength: raw === undefined ? undefined : String(raw || '').length,
    });
  }
  if (normalizedStatus === 'error') {
    return {
      phase: 'summary.compaction.finish',
      status: 'error',
      summary: errorMessage || 'moment summary compaction failed',
      details: { scopeKey, force },
    };
  }
  return {
    phase: 'summary.compaction.finish',
    status: 'success',
    summary: 'moment summary compaction finished',
    details: {
      scopeKey,
      force,
      itemCount,
      keptCount,
      rawLength: String(raw || '').length,
      summaryLength: String(summaryText || '').length,
    },
  };
};

const emitMomentLifecycleTrace = (recordTraceEvent, event) => {
  emitLifecycleTraceEvent(recordTraceEvent, buildMomentLifecycleTraceEvent(event));
};

export const resolvePrivateChatTargetSessionIdByName = (
  otherName,
  {
    contactsStore = null,
    normalizeName = normalizeNameValue,
    fallbackSessionId = null,
  } = {},
) => {
  const normalize = typeof normalizeName === 'function' ? normalizeName : normalizeNameValue;
  const other = normalize(otherName);
  if (!other) return fallbackSessionId;

  const byId = contactsStore?.getContact?.(other);
  if (byId?.id) return byId.id;

  try {
    const matches = (contactsStore?.listContacts?.() || []).filter(
      (contact) => normalize(contact?.name || contact?.id) === other,
    );
    if (matches.length === 1) return matches[0].id;
  } catch {}

  return fallbackSessionId;
};

export const resolveMomentReplyTarget = ({
  isReplyToComment = false,
  replyTo = null,
  authorName = '',
  originSessionId = '',
  resolvePrivateChatTargetSessionId = null,
  normalizeName = normalizeNameValue,
} = {}) => {
  const normalize = typeof normalizeName === 'function' ? normalizeName : normalizeNameValue;
  const resolveTarget = typeof resolvePrivateChatTargetSessionId === 'function'
    ? resolvePrivateChatTargetSessionId
    : (() => null);
  if (isReplyToComment) {
    const name = normalize(replyTo?.author);
    const sessionId = resolveTarget(name) || (name === normalize(authorName) ? String(originSessionId || '').trim() : null);
    return {
      name: name || String(authorName || '').trim() || getMomentPromptLine('moment_comment.label.publisher'),
      sessionId: String(sessionId || '').trim(),
    };
  }
  const fallbackSessionId = String(originSessionId || '').trim() || resolveTarget(authorName) || '';
  return {
    name: normalize(authorName) || getMomentPromptLine('moment_comment.label.publisher'),
    sessionId: String(fallbackSessionId || '').trim(),
  };
};

export const buildMomentRecentCommentsText = (
  comments,
  {
    limit = 12,
    normalizeText = value => String(value ?? ''),
  } = {},
) => buildMomentCommentReferenceTable(comments, { limit, normalizeText }).text;

export const buildMomentCommentReferenceTable = (
  comments,
  {
    limit = 12,
    normalizeText = value => String(value ?? ''),
  } = {},
) => {
  const list = Array.isArray(comments) ? comments : [];
  const rows = list
    .map((comment, index) => {
      if (!comment || typeof comment !== 'object') return null;
      const id = String(comment?.id || '').trim();
      return { comment, index, id };
    })
    .filter(Boolean);
  const maxItems = Math.max(0, Math.trunc(Number(limit) || 0));
  const selected = maxItems > 0 ? rows.slice(-maxItems) : rows;
  const byId = new Map(rows.filter(item => item.id).map(item => [item.id, item]));
  const includeKeys = new Set();
  const keyOf = item => item.id || `__idx_${item.index}`;
  const includeWithAncestors = (item) => {
    let current = item;
    const seen = new Set();
    while (current && !seen.has(keyOf(current))) {
      seen.add(keyOf(current));
      includeKeys.add(keyOf(current));
      const parentId = String(current.comment?.replyTo || '').trim();
      current = parentId ? byId.get(parentId) : null;
    }
  };
  selected.forEach(includeWithAncestors);

  const included = rows.filter(item => includeKeys.has(keyOf(item)));
  const includedById = new Map(included.filter(item => item.id).map(item => [item.id, item]));
  const rootIdCache = new Map();
  const resolveRootKey = (item) => {
    const ownKey = keyOf(item);
    if (rootIdCache.has(ownKey)) return rootIdCache.get(ownKey);
    let current = item;
    const seen = new Set();
    while (current && !seen.has(keyOf(current))) {
      seen.add(keyOf(current));
      const parentId = String(current.comment?.replyTo || '').trim();
      const parent = parentId ? includedById.get(parentId) : null;
      if (!parent) break;
      current = parent;
    }
    const rootKey = keyOf(current || item);
    rootIdCache.set(ownKey, rootKey);
    return rootKey;
  };
  const roots = included.filter((item) => {
    const parentId = String(item.comment?.replyTo || '').trim();
    return !parentId || !includedById.has(parentId);
  });
  const idToRef = new Map();
  const refEntries = [];
  const lines = [];
  roots.forEach((root, rootIndex) => {
    const prefix = buildAlphaIndex(rootIndex);
    const members = included
      .filter(item => resolveRootKey(item) === keyOf(root))
      .sort((a, b) => a.index - b.index);
    members.forEach((item) => {
      const isRoot = keyOf(item) === keyOf(root);
      const replyNumber = isRoot ? 0 : members.filter(other => other !== root && other.index <= item.index).length;
      const ref = `${prefix}${replyNumber}`;
      if (item.id) {
        idToRef.set(item.id, ref);
        refEntries.push({
          ref,
          id: item.id,
          author: String(item.comment?.author || '').trim(),
        });
      }
      const author = String(item.comment?.author || '').trim();
      const normalized = normalizeText(item.comment?.content || '');
      const content = String(normalized || '').replace(/\n/g, '<br>');
      const parentId = String(item.comment?.replyTo || '').trim();
      const parentRef = parentId ? idToRef.get(parentId) : '';
      const replyToAuthor = String(item.comment?.replyToAuthor || '').trim();
      const parts = [
        author ? `author::${author}` : '',
        parentRef ? `reply_to::${parentRef}` : (replyToAuthor ? `reply_to_author::${replyToAuthor}` : ''),
        content ? `content::${content}` : '',
      ].filter(Boolean);
      if (parts.length) lines.push(`[${ref}] ${parts.join(' | ')}`);
    });
  });
  return {
    text: lines.join('\n'),
    refs: refEntries,
    refToId: Object.fromEntries(refEntries.map(item => [item.ref, item.id])),
  };
};

const MOMENT_INLINE_IMAGE_TOKEN_RE = /\[img-[\s\S]*?\]/gi;
const MOMENT_BQB_ATTACHMENT_TOKEN_RE = /\[bqb-attachment[^\]\r\n]*\]+/gi;

export const stripMomentImageTokensForPrompt = (value = '') => String(value ?? '')
  .replace(MOMENT_INLINE_IMAGE_TOKEN_RE, ' ')
  .replace(MOMENT_BQB_ATTACHMENT_TOKEN_RE, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const buildMomentPromptContentText = (
  content = '',
  {
    normalizeText = value => String(value ?? ''),
  } = {},
) => {
  const stripped = stripMomentImageTokensForPrompt(content);
  const normalized = String(normalizeText(stripped) || '').trim();
  return stripMomentImageTokensForPrompt(normalized || stripped);
};

export const buildMomentCommentSideEffectInstructions = ({
  enabled = true,
  userName = '{{user}}',
} = {}) => {
  if (enabled === false) return '';
  const displayUser = String(userName || '').trim() || '{{user}}';
  return getMomentPromptLine('moment_comment.side_effects', { user: displayUser });
};

export const buildMomentCommentPromptData = ({
  taskTitle = '',
  authorName = '',
  content = '',
  time = '',
  userSectionTitle = '',
  userLine = '',
  isReplyToComment = false,
  replyTo = null,
  recentComments = '',
  contactList = '',
  groupList = '',
  sideEffectInstructions = '',
} = {}) => `
【${String(taskTitle || '').trim() || getMomentPromptLine('moment_comment.title.reply')}】
${getMomentPromptLine('moment_comment.label.publisher')}: ${String(authorName || '').trim() || getMomentPromptLine('moment_comment.label.publisher')}
${getMomentPromptLine('moment_comment.label.content')}: ${String(content || '').trim()}
${getMomentPromptLine('moment_comment.label.time')}: ${String(time || '').trim() || getMomentPromptLine('moment_comment.label.unknown')}

【${String(userSectionTitle || '').trim() || getMomentPromptLine('moment_comment.section.user_comment')}】
${String(userLine || '').trim()}

${
  isReplyToComment
    ? `【${getMomentPromptLine('moment_comment.section.reply_context')}】
reply_to_author: ${String(replyTo?.author || '').trim()}
reply_to_content: ${String(replyTo?.content || '').trim()}
`
    : ''
}

${
  recentComments
    ? `【${getMomentPromptLine('moment_comment.section.current_comments')}】
${String(recentComments || '').trim()}
`
    : ''
}

【${getMomentPromptLine('moment_comment.section.contacts')}】
${String(contactList || '').trim() || getMomentPromptLine('moment_comment.empty_list')}

${String(groupList || '').trim()
  ? `【${getMomentPromptLine('moment_comment.section.groups')}】\n${String(groupList || '').trim()}\n`
  : ''}

${String(sideEffectInstructions || '').trim()}
`.trim();

const getMomentImageAssetUrl = (asset = {}, { resolveImageUrl = null } = {}) => {
  if (!asset || typeof asset !== 'object') return '';
  if (typeof resolveImageUrl === 'function') {
    try {
      const resolved = String(resolveImageUrl(asset) || '').trim();
      if (resolved) return resolved;
    } catch {}
  }
  const output = asset.output && typeof asset.output === 'object' ? asset.output : {};
  return String(output.dataUrl || output.url || output.path || asset.url || asset.dataUrl || '').trim();
};

const buildMomentImageAssetFromToken = (payload = '') => {
  const raw = String(payload || '').trim();
  if (!raw) return null;
  if (/^(data:image\/|https?:|blob:|file:|asset:|tauri:|app:)/i.test(raw)) {
    return { output: { url: raw, dataUrl: raw.startsWith('data:image/') ? raw : '' } };
  }
  return { output: { path: raw } };
};

export const buildMomentImageAttachmentParts = async (
  moment = {},
  {
    resolveImageUrl = null,
    toLlmImageUrl = async url => url,
    maxImages = 4,
  } = {},
) => {
  const limit = Math.max(0, Math.trunc(Number(maxImages) || 0));
  if (!limit) return [];
  const candidates = [];
  (Array.isArray(moment?.generatedImages) ? moment.generatedImages : []).forEach((asset) => {
    if (asset && typeof asset === 'object') candidates.push(asset);
  });
  const content = String(moment?.content || '');
  const tokenRe = /\[img-([\s\S]+?)\]/gi;
  let match;
  while ((match = tokenRe.exec(content))) {
    const asset = buildMomentImageAssetFromToken(match[1]);
    if (asset) candidates.push(asset);
  }

  const parts = [];
  const seenSource = new Set();
  const seenFinal = new Set();
  for (const candidate of candidates) {
    if (parts.length >= limit) break;
    const sourceUrl = getMomentImageAssetUrl(candidate, { resolveImageUrl });
    if (!sourceUrl || seenSource.has(sourceUrl)) continue;
    seenSource.add(sourceUrl);
    let llmUrl = '';
    try {
      llmUrl = String(await toLlmImageUrl(sourceUrl, candidate) || '').trim();
    } catch {}
    const finalUrl = llmUrl || sourceUrl;
    if (!/^(data:image\/|https?:)/i.test(finalUrl)) continue;
    if (seenFinal.has(finalUrl)) continue;
    seenFinal.add(finalUrl);
    parts.push({ type: 'image_url', image_url: { url: finalUrl } });
  }
  return parts;
};

export const buildMomentCommentContactList = (
  contacts,
  {
    authorName = '',
    maxItems = 16,
  } = {},
) => {
  const names = [];
  [String(authorName || '').trim(), ...(Array.isArray(contacts) ? contacts : [])].forEach((value) => {
    const name = String(value || '').trim();
    if (!name) return;
    if (name.toLowerCase().startsWith('rp:')) return;
    if (names.includes(name)) return;
    names.push(name);
  });
  return names
    .slice(0, Math.max(0, Math.trunc(Number(maxItems) || 0)))
    .map((name) => `- ${name}`)
    .join('\n');
};

const isInternalMomentContact = (contact = {}) => {
  const id = String(contact?.id || '').trim().toLowerCase();
  const name = String(contact?.name || '').trim().toLowerCase();
  return id.startsWith('rp:') || name.startsWith('rp:');
};

export const collectMomentCommentContactList = (
  contactsStore,
  {
    authorName = '',
    maxItems = 16,
    excludeNames = [],
  } = {},
) => {
  const blockedNames = new Set(
    ['我', '用户', 'user', ...(Array.isArray(excludeNames) ? excludeNames : [])]
      .map((name) => String(name || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const contacts = (contactsStore?.listContacts?.() || [])
    .filter((contact) => contact && !contact.isGroup && !isInternalMomentContact(contact))
    .map((contact) => String(contact.name || contact.id || '').trim())
    .filter(Boolean)
    .filter((name) => !blockedNames.has(name.toLowerCase()));
  return buildMomentCommentContactList(contacts, { authorName, maxItems });
};

export const buildMomentCommentGroupList = (
  contactsStore,
  {
    maxItems = 12,
    maxMembers = 20,
  } = {},
) => {
  const rawContacts = contactsStore?.listContacts?.();
  const contacts = Array.isArray(rawContacts) ? rawContacts : [];
  if (!contacts.length) return '';
  const contactById = new Map(
    contacts
      .filter(Boolean)
      .map(contact => [String(contact.id || '').trim(), contact])
      .filter(([id]) => Boolean(id)),
  );
  const resolveMemberName = (memberId = '') => {
    const id = String(memberId || '').trim();
    if (!id) return '';
    const contact = contactsStore?.getContact?.(id) || contactById.get(id) || null;
    const name = String(contact?.name || contact?.id || id).trim();
    if (!name || name.toLowerCase().startsWith('rp:')) return '';
    return name;
  };
  const limit = Math.max(0, Math.trunc(Number(maxItems) || 0));
  const memberLimit = Math.max(0, Math.trunc(Number(maxMembers) || 0));
  return contacts
    .filter(contact => contact && (contact.isGroup || String(contact.id || '').startsWith('group:')))
    .filter(contact => !isInternalMomentContact(contact))
    .slice(0, limit)
    .map((group) => {
      const groupName = String(group?.name || group?.id || '').trim();
      if (!groupName) return '';
      const memberNames = [];
      (Array.isArray(group?.members) ? group.members : []).forEach((memberId) => {
        if (memberNames.length >= memberLimit) return;
        const name = resolveMemberName(memberId);
        if (!name || memberNames.includes(name)) return;
        memberNames.push(name);
      });
      return getMomentPromptLine('moment_comment.group_line', {
        group: groupName,
        members: memberNames.length
          ? memberNames.join(getMomentPromptLine('moment_comment.member_separator'))
          : getMomentPromptLine('moment_comment.members_unlisted'),
      });
    })
    .filter(Boolean)
    .join('\n');
};

export const collectMomentCommentStructuredTargets = (
  contactsStore,
  {
    authorName = '',
    userName = '',
    publishedMoment = false,
    maxContacts = 16,
    maxGroups = 12,
    maxMembers = 20,
  } = {},
) => {
  const rawContacts = contactsStore?.listContacts?.();
  const contacts = Array.isArray(rawContacts) ? rawContacts : [];
  const blockedNames = new Set(
    ['我', '用户', 'user', userName, ...(publishedMoment ? [authorName] : [])]
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const privateTargets = contacts
    .filter(contact => contact && !contact.isGroup && !isInternalMomentContact(contact))
    .map(contact => ({
      id: String(contact?.id || '').trim(),
      name: String(contact?.name || contact?.id || '').trim(),
    }))
    .filter(item => item.id && item.name && !blockedNames.has(item.name.toLowerCase()))
    .slice(0, Math.max(0, Math.trunc(Number(maxContacts) || 0)));
  const contactById = new Map(privateTargets.map(item => [item.id, item]));
  contacts
    .filter(contact => contact && !contact.isGroup && !isInternalMomentContact(contact))
    .forEach((contact) => {
      const id = String(contact?.id || '').trim();
      const name = String(contact?.name || contact?.id || '').trim();
      if (id && name && !contactById.has(id)) contactById.set(id, { id, name });
    });
  const groupTargets = contacts
    .filter(contact => contact && (contact.isGroup || String(contact?.id || '').startsWith('group:')))
    .filter(contact => !isInternalMomentContact(contact))
    .slice(0, Math.max(0, Math.trunc(Number(maxGroups) || 0)))
    .map((group) => {
      const members = [];
      (Array.isArray(group?.members) ? group.members : []).forEach((memberId) => {
        if (members.length >= Math.max(0, Math.trunc(Number(maxMembers) || 0))) return;
        const id = String(memberId || '').trim();
        const fallback = contactsStore?.getContact?.(id) || contactById.get(id) || null;
        const name = String(fallback?.name || fallback?.id || id).trim();
        if (!id || !name || String(id).toLowerCase().startsWith('rp:') || members.some(item => item.id === id)) return;
        members.push({ id, name });
      });
      return {
        id: String(group?.id || '').trim(),
        name: String(group?.name || group?.id || '').trim(),
        members,
      };
    })
    .filter(group => group.id && group.name && group.members.length);
  const authorKey = String(authorName || '').trim().toLowerCase();
  const momentAuthors = publishedMoment
    ? privateTargets.slice()
    : privateTargets.filter(item => item.name.toLowerCase() === authorKey).slice(0, 1);
  return { momentAuthors, privateTargets, groupTargets };
};

export const resolveMomentPublishCommentTarget = ({
  contactsStore = null,
  authorName = '',
  userName = '',
  normalizeName = normalizeNameValue,
} = {}) => {
  const normalize = typeof normalizeName === 'function' ? normalizeName : normalizeNameValue;
  const blockedNames = new Set(
    ['我', '用户', 'user', authorName, userName]
      .map((name) => normalize(name).toLowerCase())
      .filter(Boolean),
  );
  const rawContacts = contactsStore?.listContacts?.();
  const contacts = Array.isArray(rawContacts) ? rawContacts : [];
  for (const contact of contacts) {
    if (!contact || contact.isGroup || isInternalMomentContact(contact)) continue;
    const name = String(contact.name || contact.id || '').trim();
    const normalizedName = normalize(name);
    if (!normalizedName || blockedNames.has(normalizedName.toLowerCase())) continue;
    return {
      name: normalizedName,
      sessionId: String(contact.id || '').trim(),
    };
  }
  return { name: '', sessionId: '' };
};

export const buildMomentCommentTaskContext = ({
  userProfile = null,
  target = null,
  authorName = '',
  originSessionId = '',
  momentId = '',
  promptData = '',
  triggerText = '',
  mode = 'comment',
  userAttachmentParts = [],
  memoryStorageMode = '',
  memoryAutoExtract = false,
  memoryInjectPosition = '',
  memoryInjectDepth = 0,
  memoryGuidePosition = '',
  memoryGuideDepth = 0,
  skipScripts = true,
  isReplyToComment = false,
  replyTo = null,
  mentions = [],
  structuredTargets = null,
  allowSideEffects = false,
} = {}) => {
  const profile = userProfile && typeof userProfile === 'object' ? userProfile : {};
  const resolvedTarget = target && typeof target === 'object' ? target : {};
  const context = {
    user: {
      name: String(profile?.name || '').trim() || '我',
      persona: String(profile?.description || ''),
      personaPosition: profile?.position,
      personaDepth: profile?.depth,
      personaRole: profile?.role,
    },
    character: {
      name: String(resolvedTarget?.name || '').trim()
        || String(authorName || '').trim()
        || getMomentPromptLine('moment_comment.label.publisher'),
    },
    history: [],
    task: {
      type: 'moment_comment',
      mode: String(mode || '').trim() || 'comment',
      momentId: String(momentId || '').trim(),
      targetSessionId: String(resolvedTarget?.sessionId || '').trim(),
      targetName: String(resolvedTarget?.name || '').trim(),
      allowSideEffects: allowSideEffects === true,
      structuredTargets: structuredTargets && typeof structuredTargets === 'object'
        ? {
            momentAuthors: Array.isArray(structuredTargets.momentAuthors)
              ? structuredTargets.momentAuthors.map(item => ({ ...item }))
              : [],
            privateTargets: Array.isArray(structuredTargets.privateTargets)
              ? structuredTargets.privateTargets.map(item => ({ ...item }))
              : [],
            groupTargets: Array.isArray(structuredTargets.groupTargets)
              ? structuredTargets.groupTargets.map(item => ({
                  ...item,
                  members: Array.isArray(item?.members) ? item.members.map(member => ({ ...member })) : [],
                }))
              : [],
          }
        : { momentAuthors: [], privateTargets: [], groupTargets: [] },
      promptData: String(promptData || ''),
      triggerText: String(triggerText || ''),
      mentions: (Array.isArray(mentions) ? mentions : [])
        .map(normalizeMomentMentionTarget)
        .filter(Boolean),
    },
    session: { id: String(originSessionId || '').trim(), isGroup: false },
  };
  const attachments = Array.isArray(userAttachmentParts)
    ? userAttachmentParts.filter((part) => part && typeof part === 'object')
    : [];
  const meta = { uiMode: 'moments' };
  if (skipScripts !== false) {
    meta.skipScripts = true;
  }
  if (attachments.length) {
    meta.userAttachmentParts = attachments;
  }
  const memoryMode = String(memoryStorageMode || '').trim().toLowerCase();
  if (memoryMode) {
    meta.memoryStorageMode = memoryMode;
    meta.memoryAutoExtract = Boolean(memoryAutoExtract);
    meta.memoryContextType = 'global';
    meta.memorySessionId = 'moments';
    const injectPosition = String(memoryInjectPosition || '').trim();
    if (injectPosition) meta.memoryInjectPosition = injectPosition;
    const injectDepth = Math.trunc(Number(memoryInjectDepth));
    if (Number.isFinite(injectDepth)) meta.memoryInjectDepth = Math.max(0, injectDepth);
    const guidePosition = String(memoryGuidePosition || '').trim();
    if (guidePosition) meta.memoryGuidePosition = guidePosition;
    const guideDepth = Math.trunc(Number(memoryGuideDepth));
    if (Number.isFinite(guideDepth)) meta.memoryGuideDepth = Math.max(0, guideDepth);
  }
  if (Object.keys(meta).length) {
    context.meta = meta;
  }
  if (isReplyToComment) {
    context.task.isReplyToComment = true;
    context.task.replyToCommentId = String(replyTo?.id || '').trim();
    context.task.replyToAuthor = String(replyTo?.author || '').trim();
  }
  return context;
};

export const extractMomentSummaryText = (text) => {
  const raw = String(text ?? '');
  const re = /<details>\s*<summary>\s*摘要\s*<\/summary>\s*([\s\S]*?)<\/details>/gi;
  let match;
  let last = null;
  while ((match = re.exec(raw))) last = match[1];
  if (!last) return '';
  const plain = String(last || '').replace(/<[^>]+>/g, ' ');
  return plain
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z]+/g, '')
    .trim();
};

export const sanitizeThinkingForMomentReply = (text) => {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  const closeThinking = '</thinking>';
  const closeThink = '</think>';
  const i1 = lower.lastIndexOf(closeThinking);
  const i2 = lower.lastIndexOf(closeThink);
  const idx = Math.max(i1, i2);
  if (idx === -1) return raw;
  const cut = idx + (idx === i1 ? closeThinking.length : closeThink.length);
  return raw.slice(cut);
};

export const extractMomentReplySegments = (text) => {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  const startMark = 'moment_reply_start';
  const endMark = 'moment_reply_end';
  const chunks = [];
  let idx = 0;
  while (true) {
    const startIdx = lower.indexOf(startMark, idx);
    if (startIdx === -1) break;
    const endIdx = lower.indexOf(endMark, startIdx + startMark.length);
    if (endIdx === -1) break;
    chunks.push(raw.slice(startIdx, endIdx + endMark.length));
    idx = endIdx + endMark.length;
  }
  return chunks.join('\n');
};

export const patchMomentReplyComments = (
  comments,
  {
    isReplyToComment = false,
    replyTo = null,
    targetName = '',
    existingComments = [],
    commentRefMap = {},
    normalizeName = normalizeNameValue,
  } = {},
) => {
  const incoming = Array.isArray(comments) ? comments : [];
  const normalize = typeof normalizeName === 'function' ? normalizeName : normalizeNameValue;
  const sourceComments = Array.isArray(existingComments) ? existingComments : [];
  const replyTarget = replyTo?.id
    ? {
        id: String(replyTo.id || '').trim(),
        author: String(replyTo.author || '').trim(),
      }
    : null;
  const refToComment = (() => {
    const normalizeEntries = entries => new Map(entries.map(([key, value]) => [
      String(key || '').trim().toUpperCase(),
      value,
    ]));
    if (commentRefMap instanceof Map) return normalizeEntries([...commentRefMap.entries()]);
    if (commentRefMap && typeof commentRefMap === 'object') {
      return normalizeEntries(Object.entries(commentRefMap));
    }
    return new Map();
  })();
  const findCommentById = (commentId) => {
    const id = String(commentId || '').trim();
    if (!id) return null;
    const found = sourceComments.find(item => String(item?.id || '').trim() === id);
    if (!found) return null;
    return {
      id,
      author: String(found.author || '').trim(),
    };
  };
  const resolveReplyToRef = (rawReplyTo) => {
    const ref = String(rawReplyTo || '').trim().replace(/^\[|\]$/g, '').toUpperCase();
    if (!ref) return null;
    return findCommentById(refToComment.get(ref));
  };
  const looksReplyRefToken = (rawReplyTo) => {
    const ref = String(rawReplyTo || '').trim().replace(/^\[|\]$/g, '').toUpperCase();
    return /^[A-Z]+[0-9]+$/.test(ref);
  };
  const findExistingReplyTargetByAuthor = (authorName) => {
    const target = normalize(authorName);
    if (!target) return null;
    for (let i = sourceComments.length - 1; i >= 0; i -= 1) {
      const item = sourceComments[i];
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '').trim();
      const author = String(item.author || '').trim();
      if (!id || normalize(author) !== target) continue;
      return { id, author };
    }
    return null;
  };
  const resolveReplyToName = (rawReplyTo, rawReplyToAuthor = '') => {
    const refTarget = resolveReplyToRef(rawReplyTo);
    if (refTarget) return refTarget;
    const directTarget = findCommentById(rawReplyTo);
    if (directTarget) return directTarget;
    const name = normalize(rawReplyTo);
    const authorHint = normalize(rawReplyToAuthor);
    if (!name && !authorHint) return null;
    if (replyTarget && (
      (name && name === normalize(replyTarget.author)) ||
      (authorHint && authorHint === normalize(replyTarget.author))
    )) {
      return replyTarget;
    }
    return findExistingReplyTargetByAuthor(name) || findExistingReplyTargetByAuthor(authorHint);
  };
  return incoming.map((comment) => {
    if (!comment || typeof comment !== 'object') return comment;
    const author = String(comment.author || '').trim();
    const replyToValue = String(comment.replyTo || '').trim();
    const replyToAuthor = String(comment.replyToAuthor || '').trim();
    const resolvedReplyTo = resolveReplyToName(replyToValue, replyToAuthor);
    if (
      resolvedReplyTo &&
      (replyToValue !== resolvedReplyTo.id || (!replyToAuthor && resolvedReplyTo.author))
    ) {
      return {
        ...comment,
        replyTo: resolvedReplyTo.id,
        replyToAuthor: replyToAuthor || resolvedReplyTo.author,
      };
    }
    const invalidRefToken = replyToValue && looksReplyRefToken(replyToValue) && !resolvedReplyTo;
    const baseComment = invalidRefToken ? { ...comment, replyTo: '', replyToAuthor: '' } : comment;
    if (!isReplyToComment || !replyTarget) return baseComment;
    const hasReplyTo = !invalidRefToken && replyToValue.length > 0;
    const isPrimaryReplier =
      author && (author === normalize(replyTarget.author) || author === normalize(targetName));
    if (hasReplyTo || !isPrimaryReplier) return baseComment;
    return {
      ...baseComment,
      replyTo: replyTarget.id,
      replyToAuthor: replyTarget.author,
    };
  });
};

export const resolveMomentReplyEventTarget = ({
  eventMomentId = '',
  currentMomentId = '',
  forceCurrentMomentId = false,
  momentsStore = null,
  logger = null,
  incomingCount = 0,
} = {}) => {
  const rawRequestedId = String(eventMomentId || '').trim();
  const compactRequestedId = rawRequestedId.replace(/\s+/g, '').toLowerCase();
  const isPlaceholderId = Boolean(
    compactRequestedId === '动态id' ||
      compactRequestedId === 'moment_id' ||
      compactRequestedId === 'momentid' ||
      compactRequestedId === 'id' ||
      (rawRequestedId.includes('动态ID') && rawRequestedId.includes('moment_id')),
  );
  const requestedId = forceCurrentMomentId || isPlaceholderId ? '' : rawRequestedId;
  let momentId = requestedId || String(currentMomentId || '').trim();
  let targetMoment = momentsStore?.get?.(momentId);
  if (!targetMoment && currentMomentId && currentMomentId !== momentId) {
    const fallbackMoment = momentsStore?.get?.(currentMomentId);
    if (fallbackMoment) {
      try {
        logger?.warn?.(
          'moment_reply target not found; fallback to current',
          JSON.stringify({
            momentId,
            fallbackId: currentMomentId,
            commentCount: incomingCount,
          }),
        );
      } catch {}
      momentId = String(currentMomentId || '').trim();
      targetMoment = fallbackMoment;
    }
  }
  if (!targetMoment) {
    try {
      const list = (momentsStore?.list?.() || []).map((item) => String(item?.id || '')).filter(Boolean);
      logger?.warn?.(
        'moment_reply target not found',
        JSON.stringify({
          momentId,
          requestedId,
          commentCount: incomingCount,
          knownCount: list.length,
          knownSample: list.slice(0, 6),
        }),
      );
    } catch {}
  }
  return {
    requestedId,
    momentId,
    targetMoment,
  };
};

export const buildMomentPrivateChatMessages = (
  messages,
  {
    getActiveUserName = () => '我',
    normalizeName = normalizeNameValue,
    normalizeLooseName = normalizeNameValue,
    parseSpecialMessage = (content) => ({ type: 'text', content, meta: {} }),
    userAvatar = '',
    assistantAvatar = '',
    getTargetContact = () => null,
    formatNowTime = () => '',
  } = {},
) => {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((message) => {
      const payload = message && typeof message === 'object' ? message : { content: message };
      const speakerRaw = String(payload?.speaker || '').trim();
      const content = String(payload?.content || '').trim();
      if (!content) return null;
      const userDisplayName = String(getActiveUserName?.() || '').trim();
      const speakerKey = normalizeName(speakerRaw).replace(/[：:]/g, '').trim();
      const userKey = normalizeName(userDisplayName).replace(/[：:]/g, '').trim();
      const isMe = Boolean(
        speakerKey &&
          userKey &&
          (speakerKey === userKey || normalizeLooseName(speakerKey) === normalizeLooseName(userKey)),
      );
      const time =
        String(payload?.time || '').trim() ||
        String(formatNowTime?.() || '').trim();
      if (isMe) {
        const parsed = parseSpecialMessage(content);
        return {
          role: 'user',
          message: {
            role: 'user',
            type: 'text',
            ...parsed,
            name: userDisplayName,
            avatar: userAvatar,
            time,
            meta: { ...(parsed.meta || {}), generatedByAssistant: true },
          },
        };
      }
      return {
        role: 'assistant',
        message: {
          role: 'assistant',
          type: 'text',
          ...parseSpecialMessage(content),
          name: '助手',
          avatar: assistantAvatar || getTargetContact?.()?.avatar || '',
          time,
        },
      };
    })
    .filter(Boolean);
};

export const buildMomentGroupChatMessages = (
  messages,
  {
    getActiveUserName = () => '我',
    normalizeName = normalizeNameValue,
    normalizeLooseName = normalizeNameValue,
    parseSpecialMessage = (content) => ({ type: 'text', content, meta: {} }),
    userAvatar = '',
    resolveGroupSpeakerContact = () => null,
    resolveGroupSpeakerAvatar = () => '',
    formatNowTime = () => '',
    targetSessionId = '',
  } = {},
) => {
  const list = Array.isArray(messages) ? messages : [];
  const userDisplayName = String(getActiveUserName?.() || '').trim();
  const userKey = normalizeName(userDisplayName).replace(/[：:]/g, '').trim();
  const sessionId = String(targetSessionId || '').trim();
  return list
    .map((message) => {
      const payload = message && typeof message === 'object' ? message : { content: message };
      const speakerRaw = String(payload?.speaker || '').trim();
      const content = String(payload?.content || '').trim();
      if (!content) return null;
      const speakerKey = normalizeName(speakerRaw).replace(/[：:]/g, '').trim();
      const isMe = Boolean(
        speakerKey &&
          userKey &&
          (speakerKey === userKey || normalizeLooseName(speakerKey) === normalizeLooseName(userKey)),
      );
      const time =
        String(payload?.time || '').trim() ||
        String(formatNowTime?.() || '').trim();
      if (isMe) {
        const parsed = parseSpecialMessage(content);
        return {
          role: 'user',
          message: {
            role: 'user',
            type: 'text',
            ...parsed,
            name: userDisplayName,
            avatar: userAvatar,
            time,
            meta: { ...(parsed.meta || {}), generatedByAssistant: true },
          },
        };
      }
      const speakerContact = resolveGroupSpeakerContact?.(speakerRaw, sessionId) || null;
      const parsed = parseSpecialMessage(content);
      return {
        role: 'assistant',
        message: {
          role: 'assistant',
          type: 'text',
          ...parsed,
          name: speakerRaw || '成员',
          avatar: resolveGroupSpeakerAvatar?.(speakerRaw, sessionId, speakerContact) || '',
          time,
          showName: true,
          speakerContactId: String(speakerContact?.id || '').trim(),
        },
      };
    })
    .filter(Boolean);
};

export const applyMomentCommentEvents = (
  events,
  {
    currentMomentId = '',
    originSessionId = '',
    engagementCount = 0,
    momentsStore = null,
    logger = null,
    normalizeInitialMomentStats = value => value,
    normalizeMomentRecord = value => value,
    normalizeMomentComments = value => value,
    addMoments = () => {},
    addMomentComments = () => null,
    forceCurrentMomentId = false,
    isReplyToComment = false,
    replyTo = null,
    targetName = '',
    commentRefMap = {},
    normalizeName = normalizeNameValue,
    bumpMomentEngagement = () => {},
    resolvePrivateChatTargetSessionId = () => '',
    buildPrivateChatMessages = () => [],
    appendPrivateChatMessage = () => null,
    resolveGroupChatTargetSessionId = () => '',
    buildGroupChatMessages = () => [],
    appendGroupChatMessage = () => null,
    autoMarkReadIfActive = () => {},
    onTouchedChats = () => {},
    onTouchedMoments = () => {},
    allowSideEffects = true,
  } = {},
) => {
  let touchedMoments = false;
  let touchedChats = false;
  (Array.isArray(events) ? events : []).forEach((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'moments') {
      const list = (event.moments || []).map((moment) => {
        const stats = normalizeInitialMomentStats({ views: moment?.views, likes: moment?.likes }, engagementCount);
        return normalizeMomentRecord(
          { ...(moment || {}), ...stats, originSessionId },
          { regexMode: 'output', depth: 0 },
        );
      });
      addMoments(list);
      touchedMoments = true;
      return;
    }
    if (event.type === 'moment_reply') {
      const incoming = Array.isArray(event.comments) ? event.comments : [];
      const { momentId, targetMoment } = resolveMomentReplyEventTarget({
        eventMomentId: event.momentId,
        currentMomentId,
        forceCurrentMomentId,
        momentsStore,
        logger,
        incomingCount: incoming.length,
      });
      if (!targetMoment) return;
      const patched = patchMomentReplyComments(incoming, {
        isReplyToComment,
        replyTo,
        targetName,
        existingComments: targetMoment?.comments || [],
        commentRefMap,
        normalizeName,
      });
      const saved = addMomentComments(
        momentId,
        normalizeMomentComments(patched, { regexMode: 'output', depth: 0 }),
      );
      if (!saved) {
        try {
          logger?.warn?.(
            'moment_reply addComments failed',
            JSON.stringify({
              momentId,
              commentCount: patched.length,
            }),
          );
        } catch {}
        return;
      }
      try {
        bumpMomentEngagement(momentId, engagementCount);
      } catch {}
      touchedMoments = true;
      return;
    }
    if (event.type === 'private_chat') {
      if (allowSideEffects === false) return;
      const targetSessionId = resolvePrivateChatTargetSessionId(event.otherName);
      if (!targetSessionId) return;
      const messages = buildPrivateChatMessages(event.messages, targetSessionId);
      messages.forEach(({ role, message }) => {
        const saved = appendPrivateChatMessage(message, targetSessionId);
        if (role === 'assistant') {
          autoMarkReadIfActive(targetSessionId, saved?.id || message?.id || '');
        }
        touchedChats = true;
      });
    }
    if (event.type === 'group_chat') {
      if (allowSideEffects === false) return;
      const targetSessionId = resolveGroupChatTargetSessionId(event.groupName);
      if (!targetSessionId) return;
      const messages = buildGroupChatMessages(event.messages, targetSessionId);
      messages.forEach(({ role, message }) => {
        const saved = appendGroupChatMessage(message, targetSessionId);
        if (role === 'assistant') {
          autoMarkReadIfActive(targetSessionId, saved?.id || message?.id || '');
        }
        touchedChats = true;
      });
    }
  });
  if (touchedChats) {
    try {
      onTouchedChats();
    } catch {}
  }
  if (touchedMoments) {
    try {
      onTouchedMoments();
    } catch {}
  }
  return { touchedMoments, touchedChats };
};

export const applyMomentSummaryFromRaw = async (
  raw,
  {
    addSummary = () => {},
    runCompaction = () => {},
    notifyUpdated = () => {},
  } = {},
) => {
  const summary = extractMomentSummaryText(raw);
  if (!summary) return '';
  try {
    await addSummary(summary);
  } catch {}
  try {
    await runCompaction();
  } catch {}
  try {
    await notifyUpdated();
  } catch {}
  return summary;
};

export const runMomentReplyRetry = async (
  fullRaw,
  {
    parseText = async () => false,
    logger = null,
  } = {},
) => {
  const source = String(fullRaw || '');
  if (!source) return false;
  const retryText = sanitizeThinkingForMomentReply(source);
  if (retryText && retryText !== source) {
    try {
      logger?.debug?.(
        'moment_reply retry: stripped thinking',
        JSON.stringify({
          originalLen: source.length,
          retryLen: retryText.length,
        }),
      );
    } catch {}
    if (await parseText(retryText)) return true;
  }
  const extracted = extractMomentReplySegments(retryText || source);
  try {
    logger?.debug?.(
      'moment_reply retry: extracted segments',
      JSON.stringify({
        extractedLen: String(extracted || '').length,
        hasStart: String(retryText || source || '').toLowerCase().includes('moment_reply_start'),
        hasEnd: String(retryText || source || '').toLowerCase().includes('moment_reply_end'),
      }),
    );
  } catch {}
  if (!extracted) return false;
  return (await parseText(extracted)) === true;
};

export const runMomentCommentGeneration = async (
  userComment,
  context,
  {
    stream = false,
    generate = async () => '',
    createParser = () => ({ push: () => [] }),
    normalizeChunk = (chunk) => chunk,
    applyEvents = () => ({ touchedMoments: false }),
    saveRaw = async () => {},
    retryUnhandledReply = null,
    logger = null,
  } = {},
) => {
  const parser = createParser();
  let sawMomentReply = false;
  let retryRecovered = false;
  let fullRaw = '';

  if (stream) {
    const streamResult = await generate(userComment, context);
    for await (const chunk of streamResult) {
      const normalizedChunk = normalizeChunk(chunk);
      if (!normalizedChunk?.content) continue;
      fullRaw += normalizedChunk.content;
      const events = parser.push(normalizedChunk.content);
      const result = applyEvents(events);
      if (result?.touchedMoments) sawMomentReply = true;
    }
  } else {
    const raw = await generate(userComment, context);
    fullRaw = String(raw ?? '');
    const events = parser.push(fullRaw);
    const result = applyEvents(events);
    if (result?.touchedMoments) sawMomentReply = true;
  }

  if (fullRaw) {
    try {
      await saveRaw(fullRaw);
    } catch {}
  }

  if (!sawMomentReply && fullRaw) {
    const retry = typeof retryUnhandledReply === 'function'
      ? retryUnhandledReply
      : (raw, parseText) => runMomentReplyRetry(raw, { parseText, logger });
    try {
      const parseMomentReplyFrom = async (text) => {
        if (!text) return false;
        const retryParser = createParser();
        const retryEvents = retryParser.push(text);
        const result = applyEvents(retryEvents);
        if (result?.touchedMoments) sawMomentReply = true;
        return Boolean(result?.touchedMoments);
      };
      const handled = await retry(fullRaw, parseMomentReplyFrom);
      if (handled) {
        sawMomentReply = true;
        retryRecovered = true;
      }
    } catch {}
  }

  return { fullRaw, sawMomentReply, retryRecovered };
};

export const createMomentCommentLifecycleRuntime = ({
  getIsConfigured = () => true,
  isOnline = () => true,
  getConfig = () => ({}),
  getMoment = () => null,
  getCurrentSessionId = () => '',
  getContactCount = () => 1,
  getActiveUserProfile = () => null,
  getActiveUserName = () => '我',
  contactsStore = null,
  momentsStore = null,
  normalizeName = normalizeNameValue,
  normalizeLooseName = normalizeNameValue,
  normalizeStickerTextForPrompt = value => String(value ?? ''),
  normalizeInitialMomentStats = value => value,
  normalizeMomentRecord = value => value,
  normalizeMomentComments = value => value,
  addMoments = list => momentsStore?.addMany?.(list),
  addMomentComments = (momentId, comments) => momentsStore?.addComments?.(momentId, comments),
  bumpMomentEngagement = () => {},
  resolvePrivateChatTargetSessionId = null,
  resolveGroupChatTargetSessionId = () => '',
  resolveGroupSpeakerContact = () => null,
  resolveGroupSpeakerAvatar = () => '',
  parseSpecialMessage = content => ({ type: 'text', content, meta: {} }),
  userAvatar = '',
  resolveAssistantAvatar = () => '',
  formatNowTime = () => '',
  appendPrivateChatMessage = () => null,
  appendGroupChatMessage = () => null,
  autoMarkReadIfActive = () => {},
  onTouchedChats = () => {},
  onTouchedMoments = () => {},
  getAllowMomentCommentSideEffects = () => true,
  generate = async () => '',
  createParser = () => ({ push: () => [] }),
  normalizeChunk = chunk => chunk,
  runGeneration = runMomentCommentGeneration,
  retryMomentReply = runMomentReplyRetry,
  saveRawReply = async () => {},
  buildPublishedMomentAttachmentParts = async () => [],
  flushMoments = async () => {},
  applySummaryFromRaw = applyMomentSummaryFromRaw,
  addSummary = async () => {},
  runSummaryCompaction = async () => {},
  notifySummariesUpdated = async () => {},
  getMemoryStorageMode = () => '',
  isMemoryAutoExtractInline = () => false,
  getMemoryRuntimeConfig = () => ({}),
  handleMemoryEditsFromRaw = null,
  showMissingConfig = () => {},
  showOffline = () => {},
  showMissingMoment = () => {},
  showNoReplyWarning = () => {},
  showError = () => {},
  logger = null,
  recordLifecycleEvent = null,
  recordTraceEvent = null,
} = {}) => {
  const emitRecord = (event) => {
    if (typeof recordLifecycleEvent === 'function') {
      try {
        recordLifecycleEvent(event);
      } catch {}
      return;
    }
    emitMomentLifecycleTrace(recordTraceEvent, event);
  };
  const normalize = typeof normalizeName === 'function' ? normalizeName : normalizeNameValue;
  const normalizeLoose = typeof normalizeLooseName === 'function' ? normalizeLooseName : normalizeNameValue;
  const resolvePrivateTarget = typeof resolvePrivateChatTargetSessionId === 'function'
    ? resolvePrivateChatTargetSessionId
    : otherName => resolvePrivateChatTargetSessionIdByName(otherName, {
      contactsStore,
      normalizeName: normalize,
      fallbackSessionId: null,
    });

  return async (momentId, commentText, meta = null) => {
    const previewOnly = meta?.previewOnly === true;
    const record = previewOnly ? () => {} : emitRecord;
    const id = String(momentId || '').trim();
    const mode = String(meta?.mode || meta?.source || meta?.kind || '').trim().toLowerCase();
    const isPublishedMomentComment =
      mode === 'moment_publish' ||
      mode === 'published_moment' ||
      mode === 'publish_comment' ||
      meta?.publishedMoment === true ||
      meta?.isPublishedMoment === true;
    const userComment = String(commentText || '').trim();
    if (!id || (!userComment && !isPublishedMomentComment)) {
      record(buildMomentCommentSkippedTraceEvent({
        momentId: id,
        reason: 'missing-input',
        hasMomentId: Boolean(id),
        hasText: Boolean(userComment) || Boolean(isPublishedMomentComment),
      }));
      return { ok: false, reason: 'missing-input' };
    }

    if (!previewOnly && !getIsConfigured()) {
      record(buildMomentCommentSkippedTraceEvent({
        momentId: id,
        reason: 'not-configured',
      }));
      if (meta?.suppressMissingConfigUi !== true) showMissingConfig();
      return { ok: false, reason: 'not-configured' };
    }

    if (!previewOnly && !isOnline()) {
      record(buildMomentCommentSkippedTraceEvent({
        momentId: id,
        reason: 'offline',
      }));
      showOffline();
      return { ok: false, reason: 'offline' };
    }

    const moment = getMoment(id);
    if (!moment) {
      record(buildMomentCommentSkippedTraceEvent({
        momentId: id,
        reason: 'moment-not-found',
      }));
      if (!previewOnly) showMissingMoment();
      return { ok: false, reason: 'moment-not-found' };
    }

    const engagementCount = Math.max(1, Number(getContactCount()) || 1);
    try {
      if (!previewOnly) bumpMomentEngagement(id, engagementCount);
    } catch {}

    const authorName = String(moment.author || '').trim() || getMomentPromptLine('moment_comment.label.publisher');
    const originSessionId = String(
      moment.originSessionId || moment.authorId || getCurrentSessionId() || '',
    ).trim();
    const activeUserName = String(getActiveUserName?.() || '').trim();
    const userCommentId = String(meta?.userCommentId || '').trim();
    const replyTo =
      meta && typeof meta === 'object' && meta.replyTo && typeof meta.replyTo === 'object'
        ? {
            id: String(meta.replyTo.id || '').trim(),
            author: String(meta.replyTo.author || '').trim(),
            content: String(meta.replyTo.content || ''),
          }
        : null;
    const isReplyToComment = Boolean(replyTo?.id);
    const contactList = collectMomentCommentContactList(contactsStore, {
      authorName: isPublishedMomentComment ? '' : authorName,
      maxItems: 16,
      excludeNames: isPublishedMomentComment ? [authorName, activeUserName] : [],
    });
    const target = isPublishedMomentComment
      ? resolveMomentPublishCommentTarget({
          contactsStore,
          authorName,
          userName: activeUserName,
          normalizeName: normalize,
        })
      : resolveMomentReplyTarget({
          isReplyToComment,
          replyTo,
          authorName,
          originSessionId,
          resolvePrivateChatTargetSessionId: resolvePrivateTarget,
          normalizeName: normalize,
        });
    const commentReferenceTable = buildMomentCommentReferenceTable(moment.comments, {
      normalizeText: normalizeStickerTextForPrompt,
    });
    const recentComments = commentReferenceTable.text;
    const momentPromptContent = buildMomentPromptContentText(moment.content || '', {
      normalizeText: normalizeStickerTextForPrompt,
    });
    const allowSideEffects = getAllowMomentCommentSideEffects?.() !== false;
    const structuredTargets = collectMomentCommentStructuredTargets(contactsStore, {
      authorName,
      userName: activeUserName,
      publishedMoment: isPublishedMomentComment,
      maxContacts: 16,
      maxGroups: allowSideEffects ? 12 : 0,
      maxMembers: 20,
    });
    if (!isPublishedMomentComment && target?.sessionId && target?.name) {
      structuredTargets.momentAuthors = [{
        id: String(target.sessionId || '').trim(),
        name: String(target.name || '').trim(),
      }];
    }
    const sideEffectInstructions = buildMomentCommentSideEffectInstructions({
      enabled: allowSideEffects,
      userName: activeUserName || '{{user}}',
    });
    const groupList = allowSideEffects
      ? buildMomentCommentGroupList(contactsStore, { maxItems: 12, maxMembers: 20 })
      : '';
    const userLine = isPublishedMomentComment
      ? [
          getMomentPromptLine('moment_comment.published_notice'),
          getMomentPromptLine('moment_comment.published_instruction'),
        ].join('\n')
      : isReplyToComment
      ? getMomentPromptLine('moment_comment.reply_line', { author: replyTo.author })
      : `{{user}}：{{lastUserMessage}}`;
    const promptData = buildMomentCommentPromptData({
      taskTitle: isPublishedMomentComment
        ? getMomentPromptLine('moment_comment.title.published')
        : getMomentPromptLine('moment_comment.title.reply'),
      authorName,
      content: momentPromptContent || getMomentPromptLine('moment_comment.image_only'),
      time: String(moment.time || '').trim(),
      userSectionTitle: isPublishedMomentComment
        ? getMomentPromptLine('moment_comment.section.user_post')
        : getMomentPromptLine('moment_comment.section.user_comment'),
      userLine,
      isReplyToComment,
      replyTo: isReplyToComment
        ? {
            author: replyTo.author,
            content: String(normalizeStickerTextForPrompt(replyTo.content || '') || '').trim(),
          }
        : null,
      recentComments,
      contactList: contactList || getMomentPromptLine('moment_comment.empty_list'),
      groupList,
      sideEffectInstructions,
    });
    const triggerText = [
      authorName,
      momentPromptContent,
      userComment,
      isReplyToComment ? replyTo?.author : '',
      isReplyToComment ? normalizeStickerTextForPrompt(replyTo?.content || '') : '',
      recentComments,
    ].map(item => String(item || '').trim()).filter(Boolean).join('\n');
    const applyEvents = (events = []) => applyMomentCommentEvents(events, {
      currentMomentId: id,
      originSessionId,
      engagementCount,
      momentsStore,
      logger,
      normalizeInitialMomentStats,
      normalizeMomentRecord,
      normalizeMomentComments,
      addMoments,
      addMomentComments,
      forceCurrentMomentId: true,
      isReplyToComment,
      replyTo,
      targetName: target?.name,
      commentRefMap: commentReferenceTable.refToId,
      normalizeName: normalize,
      bumpMomentEngagement,
      resolvePrivateChatTargetSessionId: resolvePrivateTarget,
      buildPrivateChatMessages: (messages, targetSessionId) => buildMomentPrivateChatMessages(messages, {
        getActiveUserName,
        normalizeName: normalize,
        normalizeLooseName: normalizeLoose,
        parseSpecialMessage,
        userAvatar: typeof userAvatar === 'function' ? userAvatar() : userAvatar,
        assistantAvatar: resolveAssistantAvatar(targetSessionId),
        formatNowTime,
      }),
      appendPrivateChatMessage,
      resolveGroupChatTargetSessionId,
      buildGroupChatMessages: (messages, targetSessionId) => buildMomentGroupChatMessages(messages, {
        getActiveUserName,
        normalizeName: normalize,
        normalizeLooseName: normalizeLoose,
        parseSpecialMessage,
        userAvatar: typeof userAvatar === 'function' ? userAvatar() : userAvatar,
        resolveGroupSpeakerContact,
        resolveGroupSpeakerAvatar,
        formatNowTime,
        targetSessionId,
      }),
      appendGroupChatMessage,
      autoMarkReadIfActive,
      onTouchedChats,
      onTouchedMoments,
      allowSideEffects,
    });

    let momentCommentTraceStarted = false;
    try {
      const config = getConfig() || {};
      const userAttachmentParts = isPublishedMomentComment
        ? await Promise.resolve(buildPublishedMomentAttachmentParts(moment, { momentId: id }))
          .then(parts => (Array.isArray(parts) ? parts : []))
          .catch(() => [])
        : [];
      const memoryStorageMode = String(getMemoryStorageMode?.('moments') || '').trim().toLowerCase();
      const memoryRuntimeConfig = getMemoryRuntimeConfig?.('moments') || {};
      const context = buildMomentCommentTaskContext({
        userProfile: getActiveUserProfile(),
        target,
        authorName,
        originSessionId,
        momentId: id,
        promptData,
        triggerText,
        mentions: moment?.mentions || [],
        isReplyToComment,
        replyTo,
        mode: isPublishedMomentComment ? 'published_moment' : 'comment',
        structuredTargets,
        allowSideEffects,
        userAttachmentParts,
        memoryStorageMode,
        memoryAutoExtract: memoryStorageMode === 'table' && isMemoryAutoExtractInline?.('moments') === true,
        memoryInjectPosition: memoryRuntimeConfig.memoryInjectPosition,
        memoryInjectDepth: memoryRuntimeConfig.memoryInjectDepth,
        memoryGuidePosition: memoryRuntimeConfig.memoryGuidePosition,
        memoryGuideDepth: memoryRuntimeConfig.memoryGuideDepth,
      });
      if (previewOnly) return { ok:true, input:isPublishedMomentComment
        ? (momentPromptContent || getMomentPromptLine('moment_comment.image_only')) : userComment,
        context:{ ...context, meta:{ ...context.meta, previewOnly:true, skipScripts:true, macroVariableState:new Map(), agentPromptDraft:meta.agentPromptDraft } } };
      momentCommentTraceStarted = true;
      record(buildMomentCommentStartTraceEvent({
        sessionId: originSessionId,
        momentId: id,
        authorName,
        targetSessionId: target?.sessionId || '',
        targetName: target?.name || '',
        stream: Boolean(config.stream),
        isReplyToComment,
        userCommentId,
        hasRecentComments: Boolean(recentComments),
      }));

      const generationInput = isPublishedMomentComment
        ? (momentPromptContent || getMomentPromptLine('moment_comment.image_only'))
        : userComment;
      const { fullRaw, sawMomentReply } = await runGeneration(generationInput, context, {
        stream: Boolean(config.stream),
        generate,
        createParser,
        normalizeChunk,
        applyEvents,
        saveRaw: raw => {
          const metadata = {
            momentId: id,
            author: authorName,
            time: moment?.time || '',
            comment: isPublishedMomentComment ? '用户发布动态' : userComment,
          };
          if (isPublishedMomentComment) metadata.mode = 'published_moment';
          return saveRawReply(raw, metadata);
        },
        retryUnhandledReply: (raw, parseText) =>
          retryMomentReply(raw, {
            parseText,
            logger,
          }),
        logger,
      });

      if (sawMomentReply) {
        try {
          await flushMoments();
        } catch {}
      } else {
        try {
          logger?.warn?.(
            'moment_reply parse failed',
            JSON.stringify({
              momentId: id,
              hasStart: String(fullRaw || '')
                .toLowerCase()
                .includes('moment_reply_start'),
              hasEnd: String(fullRaw || '')
                .toLowerCase()
                .includes('moment_reply_end'),
              rawLen: String(fullRaw || '').length,
            }),
          );
        } catch {}
        showNoReplyWarning();
      }

      if (fullRaw && typeof handleMemoryEditsFromRaw === 'function') {
        try {
          await handleMemoryEditsFromRaw(fullRaw, {
            sessionId: 'moments',
            isGroup: false,
            contextType: 'global',
            uiMode: 'moments',
            memoryPlace: 'moments',
            useSharedGlobalScope: true,
          });
        } catch (err) {
          try {
            logger?.warn?.('moment memory table update failed', err);
          } catch {}
        }
      }

      let summary = '';
      if (fullRaw) {
        try {
          summary = await applySummaryFromRaw(fullRaw, {
            addSummary,
            runCompaction: runSummaryCompaction,
            notifyUpdated: notifySummariesUpdated,
          });
        } catch {}
      }

      record(buildMomentCommentFinishTraceEvent({
        sessionId: originSessionId,
        momentId: id,
        authorName,
        stream: Boolean(config.stream),
        isReplyToComment,
        userCommentId,
        sawMomentReply,
        fullRaw,
      }));

      return {
        ok: Boolean(sawMomentReply),
        status: sawMomentReply ? 'success' : 'warning',
        fullRaw,
        sawMomentReply,
        summary,
        context,
        promptData,
        target,
      };
    } catch (err) {
      if (previewOnly) throw err;
      record(buildMomentCommentFinishTraceEvent({
        sessionId: originSessionId,
        momentId: id,
        status: 'error',
        authorName,
        isReplyToComment,
        userCommentId,
        started: momentCommentTraceStarted,
        errorMessage: err?.message,
      }));
      try {
        logger?.error?.('动态评论生成失败', err);
      } catch {}
      showError(err);
      return { ok: false, status: 'error', error: err };
    }
  };
};

export const createMomentSummaryCompactionRuntime = ({
  scopeKey = 'global',
  momentSummaryStore = null,
  getIsConfigured = () => true,
  buildMessages = null,
  backgroundChat = null,
  getActiveUserProfile = () => null,
  buildContext = () => null,
  requestCompactionRaw = async () => '',
  parseCompactionResult = () => ({ text: '', valid: false }),
  normalizeItems = (items) => (Array.isArray(items) ? items : []),
  shouldCompact = () => false,
  dispatchUpdated = () => {},
  logger = null,
  recordTraceEvent = null,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  delayMs = 450,
} = {}) => {
  const compacting = new Set();
  return ({ force = false } = {}) => {
    if (compacting.has(scopeKey)) {
      emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionSkippedTraceEvent({
        reason: 'already-compacting',
        scopeKey,
        force,
      }));
      return Promise.resolve(false);
    }
    if (!momentSummaryStore?.getSummaries || !momentSummaryStore?.setCompactedSummary) {
      emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionSkippedTraceEvent({
        reason: 'missing-store',
        scopeKey,
        force,
      }));
      return Promise.resolve(false);
    }
    if (typeof buildMessages !== 'function' || typeof backgroundChat !== 'function') {
      emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionSkippedTraceEvent({
        reason: 'missing-generation-runtime',
        scopeKey,
        force,
      }));
      return Promise.resolve(false);
    }
    if (!getIsConfigured()) {
      emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionSkippedTraceEvent({
        reason: 'not-configured',
        scopeKey,
        force,
      }));
      return Promise.resolve(false);
    }

    const list = momentSummaryStore.getSummaries() || [];
    if (!shouldCompact({ items: list, force })) {
      emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionSkippedTraceEvent({
        reason: 'threshold-not-met',
        scopeKey,
        force,
        itemCount: Array.isArray(list) ? list.length : 0,
      }));
      return Promise.resolve(false);
    }

    compacting.add(scopeKey);
    emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionStartTraceEvent({
      scopeKey,
      force,
      itemCount: Array.isArray(list) ? list.length : 0,
    }));
    return new Promise((resolve) => {
      setTimeoutFn(async () => {
        try {
          const current = momentSummaryStore.getSummaries() || [];
          const arr = Array.isArray(current) ? current : [];
          const compactedPrev = momentSummaryStore.getCompactedSummary?.();
          const compactedText = String(compactedPrev?.text || '').trim();
          const context = buildContext({
            activeUser: getActiveUserProfile(),
            sessionId: 'moment_summary_global',
            characterName: '动态',
            isGroup: false,
          });
          const raw = await requestCompactionRaw({
            items: arr,
            compactedText,
            context,
            buildMessages,
            backgroundChat,
          });
          if (!raw) {
            emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionFinishTraceEvent({
              status: 'skipped',
              reason: 'empty-raw',
              scopeKey,
              force,
              itemCount: arr.length,
            }));
            return resolve(false);
          }
          try {
            momentSummaryStore.setCompactedSummaryRaw?.(raw);
          } catch {}

          const { text, valid } = parseCompactionResult(raw);
          if (!text || !valid) {
            emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionFinishTraceEvent({
              status: 'skipped',
              reason: 'invalid-result',
              scopeKey,
              force,
              itemCount: arr.length,
              raw,
            }));
            return resolve(false);
          }

          try {
            momentSummaryStore.setCompactedSummary(text, { raw });
          } catch {}
          try {
            const keep = normalizeItems(momentSummaryStore.getSummaries?.()).slice(-2);
            momentSummaryStore.setSummaries?.(keep);
          } catch {}
          try {
            dispatchUpdated();
          } catch {}
          emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionFinishTraceEvent({
            status: 'success',
            scopeKey,
            force,
            itemCount: arr.length,
            keptCount: normalizeItems(momentSummaryStore.getSummaries?.()).length,
            raw,
            summaryText: text,
          }));
          resolve(true);
        } catch (error) {
          try {
            logger?.debug?.('moment summary compaction failed', error);
          } catch {}
          emitMomentLifecycleTrace(recordTraceEvent, buildMomentSummaryCompactionFinishTraceEvent({
            status: 'error',
            scopeKey,
            force,
            errorMessage: error?.message,
          }));
          resolve(false);
        } finally {
          compacting.delete(scopeKey);
        }
      }, Number(delayMs || 0));
    });
  };
};
