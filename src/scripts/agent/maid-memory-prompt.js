/* 女仆记忆注入格式：记忆与最近对话用 XML 标签包裹并注明“仅供参考”，每条记忆带记录日期；
   APP 里会变的内容必须以本次工具读取结果为准，避免模型照着过时的记忆直接操作。 */

// 本地日期 YYYY-MM-DD
export const formatMaidMemoryDate = (value) => {
  const ms = Number(value || 0);
  if (!(ms > 0)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const MAID_MEMORY_REFERENCE_RULE = '<maid_memory>（分层记忆）和 <maid_history>（最近对话）是过去对话留下的记录，仅供参考：用于理解省略指代、延续用户目标和遵循用户偏好。记忆带记录日期，越旧越可能过时。APP 里会变化的内容（配置、列表、条目、开关状态、数量、名称等）以本次工具读取结果为准；需要用到或修改这些内容时先用工具重新读取，不要照记忆里的旧值直接操作。';

export const buildMaidMemoryPromptBlock = ({ memoryText = '', historyText = '', now = Date.now() } = {}) => {
  const memory = String(memoryText ?? '').trim();
  const history = String(historyText ?? '').trim();
  const today = formatMaidMemoryDate(now);
  return [
    `<maid_memory${today ? ` today="${today}"` : ''}>\n${memory || '（空）'}\n</maid_memory>`,
    `<maid_history>\n${history || '（空）'}\n</maid_history>`,
  ].join('\n');
};
