// 摘要提示词默认值与旧默认升级。单独放一个没有依赖的模块：预设和 Agent 中心设定都要用。

// 摘要提示词：每次回复末尾输出 <details><summary>摘要</summary>...</details>（中文，专有名词保留原文）
export const DEFAULT_SUMMARY_RULES = [
  '每次输出结束后，**紧跟着**以一句话概括本次互动的摘要，确保<details><summary>摘要</summary>',
  '<内容>',
  '</details>标签顺序正确，摘要用中文书写，人名等专有名词保留原文',
  '[summary_format]',
  '摘要格式示例：',
  '',
  '<details><summary>摘要</summary>',
  '',
  '用一句话概括本条回复的内容，禁止不必要的总结和升华',
].join('\n').trim();

// 旧版默认要求「纯中文、不得夹杂其它语言」，模型会硬译或删掉英文人名；预设里原样没改过的升级成新默认
const LEGACY_DEFAULT_SUMMARY_RULES = DEFAULT_SUMMARY_RULES.replace(
  '摘要用中文书写，人名等专有名词保留原文',
  '摘要**纯中文输出**，不得夹杂其它语言',
);
export const sanitizeSummaryRulesText = value => (
  typeof value === 'string' && value.trim() === LEGACY_DEFAULT_SUMMARY_RULES ? DEFAULT_SUMMARY_RULES : value
);
