// A conservative preflight for explicit, unqualified color dislikes. Nuanced
// preferences (e.g. only disliking a background color) remain model decisions.
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
const explicitlyChosen = (input, aliases) => {
  const pattern = new RegExp(colorPattern(aliases), 'iu');
  const clauses = trim(input).split(/[，,。.!；;！？?\n]+/u).filter(part => pattern.test(part));
  const last = clauses.at(-1) || '';
  return Boolean(last) && !dislikes(last, aliases) && !/不要|别用|別用|不想|忘掉|忘记|忘記|取消|do not|don't|without|forget/iu.test(last);
};

export const findMaidVisualPreferenceConflict = ({ input = '', plan = {}, preferences = [] } = {}) => {
  if (plan.toolName !== 'media.generate_image') return null;
  const args = plan.args || {};
  // Do not match negativePrompt: it correctly excludes an unwanted color.
  const design = [args.appearance, args.outfit, args.style, args.prompt].map(trim).join('\n');
  const conflicts = [];
  for (const memory of preferences) {
    if (memory.kind !== 'preference' || memory.status !== 'active' || memory.explicit !== true) continue;
    for (const [label, aliases] of COLORS) {
      if (dislikes(trim(memory.content), aliases) && new RegExp(colorPattern(aliases), 'iu').test(design)
        && !explicitlyChosen(input, aliases)) conflicts.push({ memoryId: memory.id, color: label });
    }
  }
  return conflicts.length ? { subject: trim(args.subject || args.target), conflicts } : null;
};
