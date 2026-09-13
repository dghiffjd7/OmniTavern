import { getLocalizedPromptText } from '../i18n/prompt-locale.js';

// The editor and the request builders read the same task text. Keep the
// format-patch transport/validation contract in the format request builder.
export const INPUT_SUGGESTION_TASK = 'Continue the text the user is typing at the cursor. Output only a short continuation in the same language and tone. Keep existing text unchanged. Do not repeat the prefix or suffix. Do not add explanations, quotes, Markdown fences, or answer the user. If no useful continuation is available, output nothing.';
const FORMAT_TASK_KEYS = ['role', 'task', 'scope', 'allowed', 'forbidden'];

export const getBuiltinAgentTask = (id = '') => {
  if (id === 'text_completion') return INPUT_SUGGESTION_TASK;
  if (id === 'reply_check') return FORMAT_TASK_KEYS
    .map(key => getLocalizedPromptText(`format_guardian.system.${key}`)).join('\n');
  return '';
};

export const resolveBuiltinAgentTask = (config = {}, id = config?.id) => {
  const defaults = getBuiltinAgentTask(id);
  const prompt = String(config?.prompt ?? '');
  if (!prompt.trim()) return defaults;
  // Older format configurations stored only extra instructions. Showing their
  // effective task must retain the built-in task until an explicit task edit.
  if (id === 'reply_check' && config?.taskPromptMode !== 'replace') return `${defaults}\n\n${prompt}`;
  return id === 'text_completion' ? prompt.trim() : prompt;
};

export const shouldAddInputSuggestionContract = (settings = {}) => {
  const prompt = String(settings?.prompt ?? '').trim();
  return Boolean((prompt && prompt !== INPUT_SUGGESTION_TASK)
    || (settings?.blocks || []).some(block => block.enabled !== false && String(block.text || '').trim()));
};
