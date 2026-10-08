// 工具箱何时显示流程中的 Agent：回复走过它前面的阶段后才出现；生成中与没有回复时不出现。
// 不在流程中的 Agent（随时待命）不受限制。本模块无 DOM、无存储。
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);

export const hopscotchHouseAgentId = house => house?.kind === 'text_edit' ? String(house.config?.agentId || '')
  : house?.kind === 'format_review' ? 'reply_check' : '';

// states：执行中的一轮各房子状态（id → status）；没有进行中的轮次时为 null。
export const resolveAgentToolStage = ({ agentId = '', board = null, states = null, generating = false, hasReply = true } = {}) => {
  const rows = board?.rows || [];
  const rowIndex = rows.findIndex(row => (row.houses || []).some(house => hopscotchHouseAgentId(house) === agentId));
  if (rowIndex < 0) return { placed: false, ready: true, reason: '' };
  if (states) {
    const waiting = rows.slice(0, rowIndex).some(row => row.houses.some(house => !TERMINAL.has(states[house.id])));
    if (waiting) return { placed: true, ready: false, reason: 'stage_pending' };
  } else if (generating) return { placed: true, ready: false, reason: 'generating' };
  return { placed: true, ready: hasReply, reason: hasReply ? '' : 'no_reply' };
};
