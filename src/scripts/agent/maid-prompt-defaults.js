import { getLocalizedPromptText } from '../i18n/prompt-locale.js';

export const DEFAULT_MAID_PROMPT = [
  '你是这个 APP 内的女仆助手。',
  '你可以自然回应用户的普通聊天，也可以简短说明 APP 操作状态。',
  '如果用户要求你直接操作 APP，但当前没有可执行工具，不要假装已经完成；请说明暂时不能直接操作，并给出下一步建议。',
  '回复使用用户的语言，保持简短，最多三句。不要输出 JSON。',
].join('\n');

export const MAID_OPERATION_SAFETY_PROMPT = [
  '操作安全原则：优先选择非破坏性做法，例如读取、打开界面、追加、新建副本、预览或询问澄清。',
  '危险操作包括但不限于删除、覆盖、替换、清空、禁用、大规模批量写入、不可自动撤销的配置变更。',
  '除非用户明确要求删除、覆盖、替换或同等危险动作，否则不要规划或执行危险操作；默认改用追加、新建副本、预览或打开对应界面。',
  '即使用户明确要求危险操作，也必须在执行前用自然语言提醒影响范围，并依赖 APP 确认弹窗或权限确认；未确认时跳过、保留原内容或使用安全替代方案。',
].join('\n');

const samePromptText = (left, right) => String(left ?? '').replace(/\r\n?/g, '\n')
  === String(right ?? '').replace(/\r\n?/g, '\n');

export const getLocalizedMaidPrompt = (value = DEFAULT_MAID_PROMPT, { voiceConversation = false } = {}) => {
  const prompt = String(value || '').trim() || DEFAULT_MAID_PROMPT;
  // Select a voice default only for a complete official prompt. Custom persona
  // text remains intact even when it repeats sentences from the default.
  const isOfficialDefault = samePromptText(prompt, DEFAULT_MAID_PROMPT)
    || (voiceConversation === true && samePromptText(prompt, getLocalizedPromptText('maid.default')));
  return isOfficialDefault
    ? getLocalizedPromptText(voiceConversation === true ? 'maid.voice.default' : 'maid.default')
    : prompt;
};

export const canonicalizeMaidPrompt = (value = DEFAULT_MAID_PROMPT) => {
  const prompt = String(value || '').trim() || DEFAULT_MAID_PROMPT;
  const localized = getLocalizedPromptText('maid.default');
  return samePromptText(prompt, localized) ? DEFAULT_MAID_PROMPT : prompt;
};

export const getLocalizedMaidOperationSafetyPrompt = ({ voiceConversation = false } = {}) =>
  voiceConversation === true
    ? getLocalizedPromptText('maid.voice.safety')
    : getLocalizedPromptText('maid.safety', MAID_OPERATION_SAFETY_PROMPT);

export const getLocalizedMaidOutputLanguagePrompt = () =>
  getLocalizedPromptText('maid.output_language_guard');
