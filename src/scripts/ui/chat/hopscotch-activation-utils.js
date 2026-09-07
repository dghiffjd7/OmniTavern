import { t } from '../../i18n/index.js';
import { extractHouseReferences } from './hopscotch-board-utils.js';

export const hopscotchInactiveLabel = reason => ({
  disabled: t('已停用'),
  variable_runtime_disabled: t('变量功能已关闭'),
  no_variables: t('当前角色暂无变量'),
  no_variable_updates: t('当前变量暂无更新请求'),
  independent_variable_rules: t('此角色使用独立变量规则'),
  memory_disabled: t('记忆表格功能已关闭'),
  image_prompt_disabled: t('图片提示已停用'),
  no_variable_rules: t('当前角色暂无此阶段的变量规则'),
  dependency_disabled: t('依赖的房子已停用'),
})[reason] || t('已停用');

// 布局/配置保持完整；该投影在开始一轮时冻结，用户的开关与功能可用性分别保存。
export const resolveHopscotchActivation = (board, settings = {}) => {
  const houses = {}, fused = {};
  const all = (board?.rows || []).flatMap(row => row.houses || []);
  const body = all.find(house => house.kind === 'body');
  const prompt = all.find(house => house.kind === 'image_prompt');
  const memoryOff = settings.memory && (settings.memory.storageMode !== 'table' || settings.memory.placeEnabled === false || settings.memory.writingEnabled === false);
  const variable = settings.variables?.activity;
  const status = (requested, reason = '') => ({ requested, enabled: requested && !reason, reason: requested ? reason : 'disabled' });
  for (const kind of body?.fused || []) {
    let reason = '';
    if (kind === 'memory_table' && memoryOff) reason = 'memory_disabled';
    if (kind === 'variable' && (variable ? !variable.enabled : settings.variables?.enabled === false)) reason = variable?.reason || 'variable_runtime_disabled';
    if (kind === 'variable' && variable?.available && Array.isArray(variable.updateModes) && !variable.updateModes.includes('inline')) reason = 'independent_variable_rules';
    fused[kind] = status(body.fusedEnabled?.[kind] !== false, reason);
  }
  for (const house of all) {
    let reason = '';
    if (house.kind === 'memory_table' && memoryOff) reason = 'memory_disabled';
    if (house.kind === 'variable' && variable && (!variable.enabled || !variable.updateModes?.includes('inline'))) reason = variable.reason || 'no_variable_updates';
    if (house.kind === 'variable_rules' && variable && (!variable.enabled || !variable.rulePhases?.includes(house.config.phase))) reason = variable.reason || 'no_variable_rules';
    if (house.kind === 'image_generation' && (prompt ? prompt.enabled === false : fused.image_prompt?.enabled === false)) reason = 'image_prompt_disabled';
    if (house.kind === 'custom_prompt') {
      const refs = extractHouseReferences(`${house.config?.prompt || ''}\n${house.config?.systemPrompt || ''}`);
      if (refs.some(id => houses[id]?.enabled === false)) reason = 'dependency_disabled';
    }
    houses[house.id] = status(house.kind === 'body' || house.enabled !== false, reason);
  }
  return { houses, fused, variable: variable || null };
};

export const getActiveHopscotchFused = (board, activation = resolveHopscotchActivation(board)) => {
  const body = (board?.rows || []).flatMap(row => row.houses || []).find(house => house.kind === 'body');
  return (body?.fused || []).filter(kind => activation.fused?.[kind]?.enabled !== false);
};
