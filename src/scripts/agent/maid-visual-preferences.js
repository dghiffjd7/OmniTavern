import { t } from '../i18n/index.js';

// 生图确认卡上的颜色提醒：语义记忆里明确记着不喜欢某颜色，而这次生图的提示参数用到了它。
// 只看生图参数与记忆，不看用户这句话；不中止、不发问，要不要照样生成由用户在确认卡上决定。
// 带限定的偏好（例如只是不喜欢粉色背景）不算。
const COLORS = [
  ['粉色', '粉色|粉红色|粉紅色|粉红|粉紅|pink'],
  ['红色', '红色|紅色|红发|紅髮|red|scarlet'],
  ['蓝色', '蓝色|藍色|蓝发|藍髮|blue'],
  ['绿色', '绿色|綠色|绿发|綠髮|green'],
  ['黄色', '黄色|黃色|黄发|黃髮|yellow'],
  ['紫色', '紫色|紫发|紫髮|purple|violet'],
  ['黑色', '黑色|黑发|黑髮|black'],
  ['白色', '白色|白发|白髮|white'],
  ['橙色', '橙色|橘色|orange'],
];
const trim = value => String(value ?? '').trim();
const colorPattern = aliases => aliases.split('|').map(value => /^[a-z]+$/i.test(value) ? `\\b${value}\\b` : value).join('|');
const dislikes = (text, aliases) => {
  if (/不再|并非|並非|不是|曾经|曾經|以前|no longer|used to|not dislike/iu.test(text)) return false;
  const colors = colorPattern(aliases);
  return new RegExp(`(?:不喜欢|不喜歡|讨厌|討厭|避免|不要)(?:用|使用)?(?:${colors})(?=$|[系。.!，,；;\\s])|\\b(?:dislike|hate|avoid|do not like|don't like)\\s+(?:the colou?r\\s+)?(?:${colors})(?=$|[.!;,\\s])`, 'iu').test(text);
};

export const findMaidVisualPreferenceConflict = ({ args = {}, preferences = [] } = {}) => {
  // negativePrompt 本来就是排除颜色，不算用到
  const design = [args.appearance, args.outfit, args.style, args.prompt].map(trim).join('\n');
  const conflicts = [];
  for (const memory of Array.isArray(preferences) ? preferences : []) {
    if (memory?.kind !== 'preference' || memory.status !== 'active' || memory.explicit !== true) continue;
    for (const [label, aliases] of COLORS) {
      if (dislikes(trim(memory.content), aliases) && new RegExp(colorPattern(aliases), 'iu').test(design)
        && !conflicts.some(item => item.color === label)) conflicts.push({ memoryId: memory.id, color: label });
    }
  }
  return conflicts.length ? { subject: trim(args.subject || args.target), conflicts } : null;
};

export const buildMaidVisualPreferenceReminder = ({ args = {}, preferences = [] } = {}) => {
  const conflict = findMaidVisualPreferenceConflict({ args, preferences });
  if (!conflict) return '';
  return t('记忆里记着你不喜欢{colors}。', { colors: conflict.conflicts.map(item => t(item.color)).join('、') });
};
