import { t } from '../../i18n/index.js';
import { extractHouseReferences } from './hopscotch-board-utils.js';
import { resolveFormatReviewAvailability } from './format-review-settings-utils.js';
import { allowsAgentInvocation, getAgentInvocationMode } from '../../agent/agent-invocation.js';

// 格子上的短状态：摘要模式单独标出，其余停用原因统一显示「已停用」（完整原因见提示）。
export const hopscotchInactiveBadgeLabel = reason => reason === 'memory_summary_mode' ? t('摘要模式') : t('已停用');

export const hopscotchInactiveLabel = reason => ({
  disabled: t('已停用'),
  variable_runtime_disabled: t('变量功能已关闭'),
  no_variables: t('当前角色暂无变量'),
  no_variable_updates: t('当前变量暂无更新请求'),
  independent_variable_rules: t('此角色使用独立变量规则'),
  memory_disabled: t('记忆表格功能已关闭'),
  memory_summary_mode: t('摘要模式：摘要随正文一起生成，不更新记忆表格'),
  image_prompt_disabled: t('图片提示已停用'),
  auto_image_disabled: t('自动生图已关闭'),
  no_variable_rules: t('当前角色暂无此阶段的变量规则'),
  dependency_disabled: t('依赖的房子已停用'),
  format_guide_missing: t('请先设置格式要求'),
  manual_only: t('手动'),
  model_unavailable: t('请先选择检查模型'),
})[reason] || t('已停用');

// 布局/配置保持完整；该投影在开始一轮时冻结，用户的开关与功能可用性分别保存。
export const resolveHopscotchActivation = (board, settings = {}) => {
  const houses = {}, fused = {};
  const all = (board?.rows || []).flatMap(row => row.houses || []);
  const body = all.find(house => house.kind === 'body');
  const prompt = all.find(house => house.kind === 'image_prompt');
  const memoryOff = settings.memory && (settings.memory.storageMode !== 'table' || settings.memory.placeEnabled === false || settings.memory.writingEnabled === false);
  // 摘要模式下表格更新同样不运行，但要标明是摘要模式而不是被停用。
  const memoryReason = settings.memory?.storageMode === 'summary' ? 'memory_summary_mode' : 'memory_disabled';
  const variable = settings.variables?.activity;
  // 自动生图的开关在设定（与 AC 生图 Agent 卡同一个）；关掉时图片提示与图片生成跟着停用，和记忆、变量一样以设定为准
  const imageOff = settings.autoImage && settings.autoImage.enabled !== true;
  const status = (requested, reason = '') => ({ requested, enabled: requested && !reason, reason: requested ? reason : 'disabled' });
  for (const kind of body?.fused || []) {
    let reason = '';
    if (kind === 'memory_table' && memoryOff) reason = memoryReason;
    if (kind === 'variable' && (variable ? !variable.enabled : settings.variables?.enabled === false)) reason = variable?.reason || 'variable_runtime_disabled';
    if (kind === 'variable' && variable?.available && Array.isArray(variable.updateModes) && !variable.updateModes.includes('inline')) reason = 'independent_variable_rules';
    if (kind === 'image_prompt' && imageOff) reason = 'auto_image_disabled';
    fused[kind] = status(body.fusedEnabled?.[kind] !== false, reason);
  }
  for (const house of all) {
    let reason = '';
    if (house.kind === 'memory_table' && memoryOff) reason = memoryReason;
    if (house.kind === 'format_review' && settings.replyCheck) reason = resolveFormatReviewAvailability(settings.replyCheck, { place: settings.place, hasFormatGuide: settings.replyCheck.hasFormatGuide }).reason;
    if (house.kind === 'variable' && variable && (!variable.enabled || !variable.updateModes?.includes('inline'))) reason = variable.reason || 'no_variable_updates';
    if (house.kind === 'variable_rules' && variable && (!variable.enabled || !variable.rulePhases?.includes(house.config.phase))) reason = variable.reason || 'no_variable_rules';
    if (house.kind === 'image_generation' && (prompt ? prompt.enabled === false : fused.image_prompt?.enabled === false)) reason = 'image_prompt_disabled';
    if ((house.kind === 'image_prompt' || house.kind === 'image_generation') && imageOff) reason = 'auto_image_disabled';
    if (house.kind === 'text_edit') {
      const config = settings.textAgents?.find(c => c.id === house.config?.agentId);
      reason = !config?.enabled ? 'disabled' : config.triggerMode === 'manual' ? 'manual_only' : config.modelMode === 'none' || (config.modelMode === 'profile' && !config.modelProfileId) ? 'model_unavailable' : '';
    }
    if (house.kind === 'custom_prompt') {
      const refs = extractHouseReferences(`${house.config?.prompt || ''}\n${house.config?.systemPrompt || ''}`);
      if (refs.some(id => houses[id]?.enabled === false)) reason = 'dependency_disabled';
    }
    // 修改文本房子的开关与它的 Agent 一起算：Agent 未启用时房子按停用处理，开启时一并开启 Agent。
    const agentOff = house.kind === 'text_edit' && settings.textAgents && !settings.textAgents.find(c => c.id === house.config?.agentId)?.enabled;
    houses[house.id] = status(house.kind === 'body' || (house.enabled !== false && !agentOff), reason);
    const config = house.kind === 'text_edit' ? settings.textAgents?.find(c => c.id === house.config?.agentId) : house.kind === 'format_review' ? settings.replyCheck : null;
    if (config) Object.assign(houses[house.id], { invocationMode: getAgentInvocationMode(config), manualEnabled: allowsAgentInvocation(config, 'manual') });
  }
  return { houses, fused, variable: variable || null };
};

export const getActiveHopscotchFused = (board, activation = resolveHopscotchActivation(board)) => {
  const body = (board?.rows || []).flatMap(row => row.houses || []).find(house => house.kind === 'body');
  return (body?.fused || []).filter(kind => activation.fused?.[kind]?.enabled !== false);
};

// 自动引用只能等待同一轮自动运行的上游。
export const findManualHopscotchDependencies = (board, activation) => (board?.rows || []).flatMap(row => row.houses || [])
  .filter(h => h.kind === 'custom_prompt' && h.enabled !== false)
  .flatMap(h => extractHouseReferences(`${h.config?.prompt || ''}\n${h.config?.systemPrompt || ''}`)
    .filter(id => activation.houses?.[id]?.invocationMode === 'manual')
    .map(id => ({ houseId: h.id, dependencyId: id })));
