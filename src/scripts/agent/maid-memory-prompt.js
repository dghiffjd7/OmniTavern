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

export const MAID_MEMORY_REFERENCE_RULE = [
  '<maid_memory>（分层记忆）和 <maid_history>（最近对话）是过去对话留下的记录，仅供参考：用于理解省略指代、延续用户目标和遵循用户偏好。记忆带记录日期，越旧越可能过时。APP 里会变化的内容（配置、列表、条目、开关状态、数量、名称等）以本次工具读取结果为准；需要用到或修改这些内容时先用工具重新读取，不要照记忆里的旧值直接操作。',
  'Explicit user standing instructions in recent conversation apply to the next matching request even before long-term memory extraction. Carry requirements such as counts and format into actual tool arguments. Newer explicit corrections override older preferences. A suggestion or claim in an assistant reply is not a user preference.',
  'Following a preference in this conversation is different from persisting or archiving long-term memory. Claim saved, forgotten, archived or cancelled only after the corresponding successful APP operation. Forgetting a stored preference uses maid.memory.list then maid.memory.archive with actual matching IDs and required APP confirmation; never replace it with a verbal promise or claim the tool is absent without checking the catalog.',
].join('\n');

export const MAID_MEDIA_READINESS_RULE = 'For an authorized avatar or wallpaper request, read the target identity first. Missing optional style, pose or supplied image does not by itself require clarification: reuse explicit user style preferences and the observed character design; otherwise choose an appropriate anime style and generate using media.generate_image. A request to replace an avatar can generate a replacement without asking the user to supply an image. An explicit batch request authorizes the observed matching set in the current scope: list names and count, then iterate single-target tools using exact observed IDs. Keep APP permissions and confirmations; do not invent another textual cost/style confirmation merely because there are multiple targets. A preview-only request still does not authorize setting it. Preserve actual target ambiguity and APP confirmation. Before paid generation, if a negative user preference conflicts with an observed defining trait (for example a disliked color and the character hair color), ask one concise question about that conflict; do not silently discard either. A generic "anything is fine" does not withdraw an explicit dislike.';

export const isExplicitMaidPreferenceInstruction = input => /^(?:请|麻烦|帮我)?\s*(?:记住[，,：:\s]|以后.{0,12}(?:都|要|请)|忘掉我(?:说过|之前)|忘记我(?:说过|之前)|不再记住)|^(?:please\s+)?(?:remember\b|from now on\b|forget what I (?:said|told you))/iu.test(String(input ?? '').trim());

export const buildMaidMemoryPromptBlock = ({ memoryText = '', historyText = '', now = Date.now() } = {}) => {
  const memory = String(memoryText ?? '').trim();
  const history = String(historyText ?? '').trim();
  const today = formatMaidMemoryDate(now);
  return [
    `<maid_memory${today ? ` today="${today}"` : ''}>\n${memory || '（空）'}\n</maid_memory>`,
    `<maid_history>\n${history || '（空）'}\n</maid_history>`,
  ].join('\n');
};
