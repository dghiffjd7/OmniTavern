import { collectRenderedAgentExcludedRanges, resolveRenderedAgentTarget, spliceRenderedAgentTarget } from '../../agent/agent-rendered-target.js';
import { extractFormatFunctionBlocks } from './format-repair-side-effect-utils.js';
import { resolveActiveSwipeMessageCore } from './swipe-ui-utils.js';
import { translateUiText as t } from '../../i18n/index.js';

const fields = ['rawOriginal', 'rawInput', 'rawSource', 'raw'];
const stale = () => new Error(t('消息、回复分支或存档已变化，请重新选择文字'));
const unmapped = () => new Error(t('所选文字无法准确对应原文，请缩小选区或使用小铅笔编辑'));
const key = value => JSON.stringify(value);
const textFields = message => Object.fromEntries(fields.filter(name => typeof message?.[name] === 'string').map(name => [name, message[name]]));

export const canEditBubbleText = message => Boolean(message?.id && ['user', 'assistant'].includes(message.role)
  && (!message.type || message.type === 'text') && !message.pending && !message.error
  && !['pending', 'sending'].includes(message.status) && !message.meta?.streaming
  && !message.meta?.swipeRegenerating && !message.meta?.activeSwipeDraft?.active && !message.meta?.generatedMedia);

// Ignore disk-cache hydration and presentation metadata; compare every text mirror
// and the active branch so an async load cannot select a different reply version.
const revision = message => {
  const current = resolveActiveSwipeMessageCore(message);
  return key([current?.id, current?.role, current?.type, current?.status, current?.pending,
    current?.content, current?.rawInput, current?.rawSource, current?.raw,
    current?.meta?.activeSwipe, current?.meta?.swipes?.length, current?.meta?.swipeRegenerating,
    current?.meta?.autoImagePromptRawContent]);
};
const reasoningRanges = (source, { prefix, suffix } = {}) => {
  if (!prefix || !suffix) return [];
  const ranges = []; let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(prefix, cursor); if (start < 0) break;
    const close = source.indexOf(suffix, start + prefix.length);
    const end = close < 0 ? source.length : close + suffix.length;
    ranges.push({ start, end }); cursor = end;
  }
  return ranges;
};
const mapText = (source, selection, boundaries) => {
  const result = resolveRenderedAgentTarget(source, selection, { excludedRanges: reasoningRanges(source, boundaries) });
  if (!result.ok) throw unmapped();
  return result;
};
const replaceText = (target, text, boundaries) => {
  const next = spliceRenderedAgentTarget(target, text);
  const functions = source => extractFormatFunctionBlocks(source).map(block => block.raw);
  const thoughts = source => collectRenderedAgentExcludedRanges(source, reasoningRanges(source, boundaries))
    .map(range => source.slice(range.start, range.end));
  if (key(functions(target.source)) !== key(functions(next)) || key(thoughts(target.source)) !== key(thoughts(next))) {
    throw new Error(t('片段编辑不能新增或修改功能标签，请使用小铅笔编辑原文'));
  }
  return next;
};

// No model, tool registry or DOM dependencies. The host supplies display rendering
// and one synchronous store commit for the message and its optional source turn.
export const createBubbleSelectionEditRuntime = ({ getContext, findMessage, loadOriginal,
  getSourceTurn = async () => null, getEnvelope = () => null, getBoundaries = () => ({}),
  renderContent = message => message.raw ?? message.content, commit, onSaved = () => {} } = {}) => {
  const open = async ({ messageId, selectedText }) => {
    const context = { ...getContext() }, contextKey = key(context);
    const originalMessage = findMessage(messageId, context.sessionId);
    if (!canEditBubbleText(originalMessage)) throw stale();
    const active = resolveActiveSwipeMessageCore(originalMessage);
    if (Number(active.meta?.activeSwipe) > 0 && typeof active.rawOriginal !== 'string'
      && (originalMessage.rawOriginal || originalMessage.rawOriginalRef)) throw unmapped();
    const before = revision(originalMessage);
    const loaded = originalMessage.role === 'assistant' ? await loadOriginal?.(originalMessage, context) : undefined;
    const current = findMessage(messageId, context.sessionId);
    if (key(getContext()) !== contextKey || revision(current) !== before || !canEditBubbleText(current)) throw stale();
    const message = resolveActiveSwipeMessageCore(current);
    if (typeof loaded === 'string' && loaded.length && typeof message.rawOriginal === 'string' && message.rawOriginal.length && message.rawOriginal !== loaded) throw stale();
    const sources = textFields(message);
    if (typeof loaded === 'string' && loaded.length) sources.rawOriginal = loaded;
    if (!Object.values(sources).some(value => value.length)) sources.raw = String(message.content ?? '');
    // Display content is derived later. Persisted raw mirrors must all map exactly;
    // refusing a rewritten/ambiguous source is preferable to updating only half of it.
    const boundaries = { ...getBoundaries(context) }, targets = {};
    for (const [name, source] of Object.entries(sources)) {
      if (source.length) targets[name] = mapText(source, selectedText, boundaries);
    }
    const primary = Object.values(targets)[0];
    if (!primary) throw unmapped();
    const imageSource = message.meta?.autoImagePromptRawContent;
    const imageTarget = typeof imageSource === 'string' && imageSource.length ? mapText(imageSource, primary.text, boundaries) : null;
    const signature = revision(current), sourceSnapshot = key(textFields(resolveActiveSwipeMessageCore(current)));
    const turn = message.role === 'assistant' && context.place !== 'writing' ? await getSourceTurn(current, context) : null;
    let envelope = null, turnTarget = null;
    if (turn?.ok && turn.sourceKind === 'social_turn_raw') {
      envelope = getEnvelope(turn.sourceSessionId);
      if (!envelope || envelope.text !== turn.sourceText || envelope.truncated) throw stale();
      turnTarget = mapText(envelope.text, primary.text, boundaries);
    }
    const fresh = () => {
      const next = findMessage(messageId, context.sessionId);
      return key(getContext()) === contextKey && canEditBubbleText(next) && revision(next) === signature
        && key(textFields(resolveActiveSwipeMessageCore(next))) === sourceSnapshot
        && (!envelope || key(getEnvelope(turn.sourceSessionId)) === key(envelope));
    };
    if (!fresh()) throw stale();
    let used = false;
    return {
      text: primary.text, role: message.role,
      async save(text) {
        if (used || !fresh()) throw stale();
        const value = String(text ?? '');
        if (value === primary.text) return false;
        const patch = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, replaceText(target, value, boundaries)]));
        // Re-read metadata to preserve independent reactions/reading state changes.
        const stored = findMessage(messageId, context.sessionId);
        const latest = resolveActiveSwipeMessageCore(stored);
        const meta = { ...(stored.meta || {}) };
        if (imageTarget) meta.autoImagePromptRawContent = replaceText(imageTarget, value, boundaries);
        const index = Number(latest.meta?.activeSwipe) || 0;
        if (meta.swipes?.length) {
          meta.activeSwipe = index;
          meta.swipes = meta.swipes.map(branch => ({ ...branch }));
          meta.swipes[index] = { ...meta.swipes[index], ...patch };
          if (imageTarget && typeof meta.swipes[index].autoImagePromptRawContent === 'string') {
            meta.swipes[index].autoImagePromptRawContent = meta.autoImagePromptRawContent;
          }
        }
        patch.meta = meta;
        patch.content = String(renderContent({ ...latest, ...patch }, context) ?? '');
        if (meta.swipes?.length) meta.swipes[index].content = patch.content;
        if (latest.role === 'user') patch.editedAt = Date.now();
        const sourceEnvelope = envelope ? { sourceSessionId: turn.sourceSessionId, expected: envelope,
          text: replaceText(turnTarget, value, boundaries) } : null;
        if (sourceEnvelope?.text.length > 220000) throw new Error(t('修改后的原文过长，请缩短片段'));
        if (!fresh()) throw stale();
        const updated = commit({ messageId, sessionId: context.sessionId, patch, sourceEnvelope });
        if (!updated) throw stale();
        used = true; onSaved(updated, context); return true;
      },
    };
  };
  return { open };
};
