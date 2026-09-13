import { collectRenderedAgentExcludedRanges } from './agent-rendered-target.js';

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value, fallback, min, max) => value != null && value !== '' && Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
const ids = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 80);
const cleanLabel = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160);
const abortError = () => Object.assign(new Error('任务已取消'), { name: 'AbortError' });
const checkSignal = signal => { if (signal?.aborted) throw abortError(); };

// Legacy mode/count means messages. An explicit history object opts into rounds;
// normalization must never silently reinterpret an existing eight-message window.
export const normalizeAgentReferenceConfig = (value = {}) => {
  value = record(value) ? value : {};
  const history = record(value.history) ? value.history : null;
  const count = integer(history?.count ?? value.count, history ? 3 : 8, 1, 50);
  const enabled = history ? history.enabled === true : value.mode === 'recent';
  const roles = history && Array.isArray(history.roles)
    ? [...new Set(history.roles.filter(role => ['user', 'assistant'].includes(role)))] : ['user', 'assistant'];
  return {
    mode: enabled ? 'recent' : 'none', count,
    maxChars: integer(value.maxChars, 10000, 500, 40000),
    history: { enabled, unit: history?.unit === 'messages' || !history ? 'messages' : 'turns', count, roles,
      includeTarget: history ? history.includeTarget !== false : false },
    worldbook: { enabled: value.worldbook?.enabled === true, ids: ids(value.worldbook?.ids) },
    prompts: { enabled: value.prompts?.enabled === true, ids: ids(value.prompts?.ids) },
  };
};

const eligibleMessage = message => message && ['user', 'assistant'].includes(message.role)
  && (!message.type || message.type === 'text') && !message.pending && !message.error
  && !['pending', 'sending', 'streaming', 'generating', 'failed', 'error', 'cancelled'].includes(message.status)
  && !message.hidden && !message.deleted && !message.meta?.hidden && !message.meta?.generatedMedia;

const groupRounds = messages => {
  const rounds = [];
  for (const message of messages) {
    const previous = rounds.at(-1);
    // Several chat bubbles from the same side belong to one conversational turn.
    if (!previous || (message.role === 'user' && previous.some(item => item.role === 'assistant'))) rounds.push([message]);
    else previous.push(message);
  }
  return rounds;
};

export const selectAgentReferenceMessages = (messages = [], config = {}, { targetMessageId = '' } = {}) => {
  const settings = normalizeAgentReferenceConfig(config), history = settings.history;
  const all = Array.isArray(messages) ? messages : [];
  const targetId = String(targetMessageId || '');
  const targetIndex = targetId ? all.findIndex(message => String(message?.id || '') === targetId) : -1;
  if (!history.enabled) return { messages: [], turnCount: 0, unit: history.unit, targetMissing: false };
  // A missing historical target is not permission to fall back to the latest chat.
  if (targetId && targetIndex < 0) return { messages: [], turnCount: 0, unit: history.unit, targetMissing: true };
  const cutoff = targetId ? all.slice(0, targetIndex + 1) : all;
  const valid = cutoff.filter(eligibleMessage);
  let selected, selectedRounds;
  if (history.unit === 'messages') {
    selected = valid.filter(message => (!targetId || String(message.id || '') !== targetId) && history.roles.includes(message.role)).slice(-history.count);
    selectedRounds = groupRounds(selected);
  } else {
    let rounds = groupRounds(valid);
    if (targetId && !history.includeTarget) {
      const targetRound = rounds.findIndex(round => round.some(message => String(message.id || '') === targetId));
      if (targetRound >= 0) rounds = rounds.slice(0, targetRound);
      rounds = rounds.filter(round => round.some(message => message.role === 'assistant'));
    }
    selectedRounds = rounds.slice(-history.count);
    selected = selectedRounds.flat().filter(message => (!targetId || String(message.id || '') !== targetId) && history.roles.includes(message.role));
  }
  return { messages: selected, turnCount: selectedRounds.length, unit: history.unit, targetMissing: false };
};

// Keep the original round/depth positions without cloning attachments, swipes or
// old raw replies. String fields are immutable snapshots; nested flags are copied.
export const captureAgentReferenceMessages = (messages = [], config = {}, options = {}) => {
  const all = Array.isArray(messages) ? messages : [];
  const selected = new Set(selectAgentReferenceMessages(all, config, options).messages);
  return all.map(message => {
    if (!message || typeof message !== 'object') return null;
    const include = selected.has(message);
    const captured = { id: message.id, role: message.role, type: message.type, status: message.status,
      pending: Boolean(message.pending), error: Boolean(message.error), hidden: Boolean(message.hidden), deleted: Boolean(message.deleted),
      content: include && typeof message.content === 'string' ? message.content : '',
      meta: { hidden: Boolean(message.meta?.hidden), generatedMedia: Boolean(message.meta?.generatedMedia),
        ...(include ? { renderRich: message.meta?.renderRich } : {}) },
    };
    if (include) for (const key of ['raw', 'rawSource', 'raw_source', 'name', 'time']) {
      if (typeof message[key] === 'string') captured[key] = message[key];
    }
    return captured;
  });
};

const reasoningRanges = (source, boundaries = {}) => {
  const prefix = String(boundaries?.prefix || ''), suffix = String(boundaries?.suffix || '');
  if (!prefix || !suffix) return [];
  const ranges = []; let from = 0;
  while (from < source.length) {
    const start = source.indexOf(prefix, from); if (start < 0) break;
    const closing = source.indexOf(suffix, start + prefix.length);
    const end = closing < 0 ? source.length : closing + suffix.length;
    ranges.push({ start, end }); from = end;
  }
  return ranges;
};

// Conservative non-DOM fallback for legacy callers. Rich-display callers supply
// their actual renderer projection through getMessageText; no markup is executed.
export const sanitizeAgentReferenceText = (value, { reasoningBoundaries = {} } = {}) => {
  const source = String(value || '');
  if (source.length > 240000) return { ok: false, reason: 'message_too_long', message: '参考消息过长，请缩小范围' };
  if (/<(?:iframe|object|embed|link)\b|<style\b[\s\S]*?(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(source))
    return { ok: false, reason: 'display_unavailable', message: '这条消息需要显示正文才能提取' };
  const ranges = collectRenderedAgentExcludedRanges(source, reasoningRanges(source, reasoningBoundaries));
  let cursor = 0, text = '';
  for (const range of ranges) { text += source.slice(cursor, range.start) + '\n'; cursor = range.end; }
  text += source.slice(cursor);
  text = text.replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/\[\[image:[\s\S]*?\]\]|\[img-[^\]\n]+\]|__CHATAPP_STATUS__/gi, '')
    .replace(/<\s*br\s*\/?\s*>|<\s*\/?\s*(?:p|div|article|section|main|li|content|story|narrative)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/?\s*[\p{L}][\p{L}\p{N}_:-]*\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gu, '')
    .replace(/\r\n?/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: true, text };
};

const projectText = (message, options) => {
  const supplied = typeof options.getMessageText === 'function' ? options.getMessageText(message) : null;
  if (supplied && typeof supplied.then === 'function') return { ok: false, message: '参考消息尚未完成读取' };
  if (record(supplied) && supplied.ok === false) return supplied;
  if (typeof options.getMessageText === 'function' && typeof supplied !== 'string' && !(record(supplied) && typeof supplied.text === 'string'))
    return { ok: false, message: '参考消息暂时无法读取' };
  const text = typeof supplied === 'string' ? supplied : record(supplied) ? supplied.text : message.content;
  return sanitizeAgentReferenceText(text, options);
};

const referenceRecord = (value = {}) => ({ id: String(value.id || ''), kind: value.kind,
  title: cleanLabel(value.title), group: cleanLabel(value.group), status: value.status || 'included',
  chars: 0, originalChars: 0, ...(value.messageId ? { messageId: value.messageId, role: value.role } : {}),
  ...(value.message ? { message: String(value.message) } : {}) });

export const buildAgentReferenceContext = (messages = [], config = {}, options = {}) => {
  const settings = normalizeAgentReferenceConfig(config);
  const selection = selectAgentReferenceMessages(messages, settings, options);
  const sourceRecords = [], segments = [], warnings = [];
  if (selection.targetMissing) warnings.push('待处理回复已不存在，已跳过对话参考');
  const catalog = new Map((Array.isArray(options.sources) ? options.sources : []).map(source => [String(source.id || ''), source]));
  // Fixed material comes first; the latest dialogue keeps priority if the shared
  // budget is exhausted. Every omitted/truncated item remains visible in sources.
  for (const [key, kind] of [['worldbook', 'worldbook'], ['prompts', 'prompt']]) {
    for (const id of settings[key].ids) {
      const source = catalog.get(id), meta = referenceRecord({ id, kind, title: source?.title || id, group: source?.group });
      sourceRecords.push(meta);
      if (!settings[key].enabled) { meta.status = 'disabled'; continue; }
      if (!source || source.kind !== kind) { meta.status = 'missing'; continue; }
      if (source.disabled === true) { meta.status = 'disabled'; continue; }
      if (source.covered === true) { meta.status = 'covered'; continue; }
      if (source.available === false) { meta.status = 'unavailable'; meta.message = String(source.message || '参考资料暂时无法读取'); continue; }
      const text = String(source.text || '').trim(); meta.originalChars = text.length;
      if (!text) { meta.status = 'empty'; continue; }
      segments.push({ meta, text, label: `[${kind === 'worldbook' ? '世界书' : '固定提示词'} · ${meta.title}]\n` });
    }
  }
  for (const [index, message] of selection.messages.entries()) {
    const projection = projectText(message, options);
    const meta = referenceRecord({ id: `message:${message.id || index}`, messageId: String(message.id || index),
      role: message.role, kind: 'history', title: message.role === 'user' ? '用户' : '角色' });
    sourceRecords.push(meta);
    if (!projection.ok) { meta.status = 'unavailable'; meta.message = projection.message; continue; }
    const text = String(projection.text || ''); meta.originalChars = text.length;
    if (!text.trim()) { meta.status = 'empty'; continue; }
    segments.push({ meta, text, label: `${message.role}: ` });
  }
  let remaining = settings.maxChars, truncated = false;
  const included = [];
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index], separatorLength = included.length ? 2 : 0;
    const capacity = Math.max(0, remaining - segment.label.length - separatorLength);
    const take = Math.min(capacity, segment.text.length);
    if (!take) { segment.meta.status = 'truncated'; truncated = true; continue; }
    const text = segment.meta.kind === 'history' ? segment.text.slice(-take) : segment.text.slice(0, take);
    segment.meta.chars = text.length;
    if (take < segment.text.length) { segment.meta.status = 'truncated'; truncated = true; }
    included.unshift(segment.label + text); remaining -= segment.label.length + text.length + separatorLength;
  }
  const text = included.join('\n\n');
  if (truncated) warnings.push('参考内容已按字数上限裁剪，优先保留最近对话');
  return { text, chars: text.length, count: sourceRecords.filter(source => source.kind === 'history' && source.chars > 0).length,
    turnCount: selection.turnCount, truncated, sources: sourceRecords, warnings,
    maxChars: settings.maxChars, targetMissing: selection.targetMissing };
};

const withSignal = (promise, signal) => {
  if (!signal) return Promise.resolve(promise);
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
};

export const createAgentReferenceContextBuilder = ({ getMessages = () => [], getMessageText,
  listSources = () => [], getReasoningBoundaries = () => ({}) } = {}) => async ({ config = {}, context = {},
  messages, targetMessageId = '', signal } = {}) => {
  checkSignal(signal);
  const settings = normalizeAgentReferenceConfig(config.context || config);
  const all = Array.isArray(messages) ? messages : await withSignal(getMessages(context.sessionId), signal);
  const selection = selectAgentReferenceMessages(all, settings, { targetMessageId });
  const hasSources = (settings.worldbook.enabled && settings.worldbook.ids.length) || (settings.prompts.enabled && settings.prompts.ids.length);
  const projections = new Map();
  const [sources, boundaries] = await Promise.all([
    hasSources ? withSignal(listSources(context, { config: settings, signal }), signal) : [],
    withSignal(getReasoningBoundaries(context), signal),
    ...selection.messages.map(async message => {
      if (typeof getMessageText !== 'function') return;
      try { projections.set(message, await withSignal(getMessageText(message, context, { signal }), signal)); }
      catch (error) {
        checkSignal(signal);
        if (error?.name === 'AbortError') throw error;
        projections.set(message, { ok: false, message: '参考消息暂时无法读取' });
      }
    }),
  ]);
  checkSignal(signal);
  return buildAgentReferenceContext(all, settings, { targetMessageId, sources, reasoningBoundaries: boundaries,
    ...(typeof getMessageText === 'function' ? { getMessageText: message => projections.has(message)
      ? projections.get(message) : { ok: false, message: '参考消息暂时无法读取' } } : {}) });
};
