import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';

// Internal metadata travels with history through filtering/budgeting. It is
// projected into text only after regexes, macros and depth placement finish.
export const HISTORY_TIMESTAMP_FIELD = '__historyTimestamp';
const ownsTimestamp = message => Object.prototype.hasOwnProperty.call(message || {}, HISTORY_TIMESTAMP_FIELD);

export const resolveHistoryTimestamp = message => {
  const value = Number(ownsTimestamp(message) ? message[HISTORY_TIMESTAMP_FIELD] : message?.timestamp);
  return Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : 0;
};

export const isHistoryTimeContextEnabled = (context = {}, settings = {}) => {
  const mode = String(context?.meta?.uiMode || context?.uiMode || '').trim().toLowerCase();
  const sessionId = String(context?.session?.id || '').trim();
  if (mode === 'rp' || (!mode && sessionId.startsWith('rp:'))) return false;
  if (String(context?.task?.type || '').toLowerCase() === 'moment_comment') return false;
  const enabled = context?.meta?.includeTimeContext;
  return typeof enabled === 'boolean' ? enabled : settings?.promptCurrentTimeEnabled === true;
};

const hasContent = content => Array.isArray(content)
  ? content.some(part => part && (part.type !== 'text' || String(part.text || '').trim()))
  : Boolean(String(content ?? '').trim());

export const prependHistoryTimeLabel = (content, label) => {
  if (!label || !hasContent(content)) return content;
  if (!Array.isArray(content)) return `${label}\n${content}`;
  // Preserve attachment parts and ordering, including attachment-only turns.
  const first = content[0];
  if (first?.type === 'text') return [{ ...first, text: `${label}\n${first.text || ''}` }, ...content.slice(1)];
  return [{ type: 'text', text: label }, ...content];
};

export const createHistoryTimeFormatter = () => {
  const periods = ['early_morning', 'morning', 'afternoon', 'evening']
    .map(key => getLocalizedPromptText(`time_context.period.${key}`));
  const unknown = `[${getLocalizedPromptText('time_context.unknown_date')}]`;
  const labels = new Map();
  const labelFor = message => {
    const timestamp = resolveHistoryTimestamp(message);
    if (!timestamp) return unknown;
    if (labels.has(timestamp)) return labels.get(timestamp);
    const date = new Date(timestamp);
    const pad = value => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const label = `[${day} ${periods[Math.floor(date.getHours() / 6)]}]`;
    labels.set(timestamp, label);
    return label;
  };
  // Stateless predecessor comparison also lets the budget limiter update only
  // the next boundary when a message is removed, without rescanning history.
  const prefixFor = (message, previous = null) => {
    if (!hasContent(message?.content)) return '';
    const label = labelFor(message);
    return previous && hasContent(previous.content) && labelFor(previous) === label ? '' : `${label}\n`;
  };
  return { labelFor, prefixFor };
};

export const projectHistoryTimeMessages = (messages = [], {
  enabled = false,
  formatter = createHistoryTimeFormatter(),
} = {}) => {
  let previous = null;
  return messages.map(message => {
    if (!message || !ownsTimestamp(message)) return message;
    const { [HISTORY_TIMESTAMP_FIELD]: timestamp, ...clean } = message;
    if (!enabled || !hasContent(message.content)) return clean;
    const prefix = formatter.prefixFor(message, previous);
    previous = message;
    return prefix ? { ...clean, content: prependHistoryTimeLabel(clean.content, prefix.trimEnd()) } : clean;
  });
};
