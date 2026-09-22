const isCommittedConversationMessage = message => (
  ['user', 'assistant'].includes(String(message?.role || '')) &&
  message?.status !== 'pending' &&
  message?.status !== 'sending'
);

const REASONING_META_KEYS = Object.freeze([
  'reasoning',
  'reasoningDisplay',
  'reasoningSource',
  'reasoningHidden',
  'reasoningLabel',
]);

const resolveActiveSwipeIndex = (meta = {}) => {
  const swipes = Array.isArray(meta?.swipes) ? meta.swipes : [];
  if (!swipes.length) return -1;
  const raw = Math.trunc(Number(meta?.activeSwipe));
  return Number.isFinite(raw)
    ? Math.min(Math.max(0, raw), swipes.length - 1)
    : Math.max(0, swipes.length - 1);
};

// Empty body text is a complete source too. null means the full source is unavailable;
// never fall back to rendered/regex-processed text when opening the raw editor.
export const resolveCreativeMessageRawOriginal = async ({
  message = null,
  sessionId = '',
  findMessage = () => null,
  loadRawOriginal = async () => null,
} = {}) => {
  const current = findMessage(message?.id, sessionId) || message;
  const meta = current?.meta || {};
  const activeBranch = meta.swipes?.[resolveActiveSwipeIndex(meta)];
  if (typeof activeBranch?.rawOriginal === 'string') return activeBranch.rawOriginal;
  if (typeof current?.rawOriginal === 'string') return current.rawOriginal;
  const loaded = await loadRawOriginal(current, sessionId);
  if (typeof current?.rawOriginal === 'string') return current.rawOriginal;
  return typeof loaded === 'string' && loaded.length ? loaded : null;
};

export const buildAssistantBodyReasoningMeta = (meta = {}, parsed = {}) => {
  const next = { ...meta };
  // Provider reasoning is a separate channel, so a body edit cannot remove it.
  if (String(next.reasoningSource || '').startsWith('native')) return next;
  if (parsed.reasoning) {
    next.reasoning = parsed.reasoning;
    next.reasoningDisplay = parsed.reasoningDisplay;
  } else {
    REASONING_META_KEYS.forEach(key => delete next[key]);
  }
  return next;
};

const replaceTaggedReasoningBlock = (value, {
  prefix = '',
  suffix = '',
  text = '',
} = {}) => {
  const raw = String(value ?? '');
  const startMarker = String(prefix ?? '');
  const endMarker = String(suffix ?? '');
  if (!startMarker || !endMarker) return null;
  const start = raw.indexOf(startMarker);
  if (start < 0) return null;
  const bodyStart = start + startMarker.length;
  const end = raw.indexOf(endMarker, bodyStart);
  if (end < 0) return null;
  const replacement = String(text ?? '');
  if (replacement.trim()) {
    return `${raw.slice(0, bodyStart)}${replacement}${raw.slice(end)}`;
  }
  let tail = raw.slice(end + endMarker.length);
  if (!raw.slice(0, start).trim()) tail = tail.replace(/^[ \t]*\r?\n/, '');
  return `${raw.slice(0, start)}${tail}`;
};

export const buildAssistantReasoningEditPatch = ({
  message = null,
  text = '',
  rawOriginal = undefined,
  reasoningPrefix = '',
  reasoningSuffix = '',
  applyReasoningRegex = value => ({ stored: value, display: value }),
} = {}) => {
  if (!message || typeof message !== 'object' || message.role !== 'assistant') return {};
  const sourceMeta = message.meta && typeof message.meta === 'object' ? message.meta : {};
  const nextMeta = { ...sourceMeta };
  const nextText = String(text ?? '');
  const hasReasoning = Boolean(nextText.trim());
  let stored = '';
  let display = '';
  if (hasReasoning) {
    try {
      const result = applyReasoningRegex(nextText, { depth: 0, isEdit: true }) || {};
      stored = String(result.stored ?? nextText);
      display = String(result.display ?? stored);
    } catch {
      stored = nextText;
      display = nextText;
    }
    nextMeta.reasoning = stored;
    nextMeta.reasoningDisplay = display;
  } else {
    REASONING_META_KEYS.forEach(key => delete nextMeta[key]);
    delete nextMeta.reasoningCollapsed;
    delete nextMeta.reasoningExpanded;
  }

  const activeSwipe = resolveActiveSwipeIndex(sourceMeta);
  const swipes = Array.isArray(sourceMeta.swipes)
    ? sourceMeta.swipes.map(item => (item && typeof item === 'object' ? { ...item } : {}))
    : null;
  if (swipes && activeSwipe >= 0) {
    if (hasReasoning) {
      swipes[activeSwipe].reasoning = stored;
      swipes[activeSwipe].reasoningDisplay = display;
      for (const key of ['reasoningSource', 'reasoningHidden', 'reasoningLabel']) {
        if (
          Object.prototype.hasOwnProperty.call(sourceMeta, key) &&
          !Object.prototype.hasOwnProperty.call(swipes[activeSwipe], key)
        ) {
          swipes[activeSwipe][key] = sourceMeta[key];
        }
      }
    } else {
      REASONING_META_KEYS.forEach(key => delete swipes[activeSwipe][key]);
    }
    nextMeta.swipes = swipes;
  }

  const patch = { meta: nextMeta };
  const isNativeReasoning = String(sourceMeta.reasoningSource || '').startsWith('native');
  if (!isNativeReasoning) {
    const activeBranchRaw = activeSwipe >= 0 && typeof swipes?.[activeSwipe]?.rawOriginal === 'string'
      ? swipes[activeSwipe].rawOriginal
      : undefined;
    const sourceRaw = typeof rawOriginal === 'string'
      ? rawOriginal
      : (activeBranchRaw ?? (typeof message.rawOriginal === 'string' ? message.rawOriginal : ''));
    const nextRaw = replaceTaggedReasoningBlock(sourceRaw, {
      prefix: reasoningPrefix,
      suffix: reasoningSuffix,
      text: nextText,
    });
    if (nextRaw !== null && nextRaw !== sourceRaw) {
      patch.rawOriginal = nextRaw;
      if (swipes && activeSwipe >= 0) {
        swipes[activeSwipe].rawOriginal = nextRaw;
        nextMeta.swipes = swipes;
      }
    }
  }
  return patch;
};

export const hasDownstreamConversationContext = (
  messages = [],
  messageId = '',
) => {
  const source = Array.isArray(messages) ? messages : [];
  const id = String(messageId || '');
  const index = source.findIndex(message => String(message?.id || '') === id);
  if (index < 0) return false;
  return source.slice(index + 1).some(isCommittedConversationMessage);
};

export const buildUserMessageEditPatch = ({
  text = '',
  applyStoredRegex = value => value,
  applyDisplayRegex = value => value,
  now = Date.now,
} = {}) => {
  const rawInput = String(text ?? '');
  const storedResult = applyStoredRegex(rawInput, { isEdit: true });
  const raw = String(storedResult ?? rawInput);
  const displayResult = applyDisplayRegex(raw, { isEdit: true, depth: 0 });
  const content = String(displayResult ?? raw);
  const editedAt = Number(typeof now === 'function' ? now() : now) || Date.now();
  return {
    content,
    raw,
    rawInput,
    editedAt,
  };
};
