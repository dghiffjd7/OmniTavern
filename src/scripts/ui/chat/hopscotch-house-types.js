// 跳房子房子类型：点「+」放下的停用房子即草稿，可原位切换类型或套用模板；开启前检查能否运作。
// 大房子自动参与流程；手动房子画成胶囊挂在前一行旁，那一行结束后出现在工具箱。本模块无 DOM、无存储。
import { t } from '../../i18n/index.js';
import { HOPSCOTCH_HOUSE_CATALOG } from './hopscotch-board-utils.js';
import { editHopscotchBoard } from './hopscotch-board-editor-utils.js';
import { hopscotchInactiveLabel } from './hopscotch-activation-utils.js';
import { getAgentInvocationMode } from '../../agent/agent-invocation.js';
import { getAgentIconName } from '../../agent/agent-icons.js';
import { RECAP_AGENT_ID, buildRecapAgentConfig } from '../../agent/recap-agent.js';

export { buildRecapAgentConfig };

// 切换列表只含用户可编辑的类型；内建房子作为对应类型的模板出现。
export const HOPSCOTCH_HOUSE_TYPES = Object.freeze([
  { id: 'custom', kind: 'custom_prompt', size: 'big', icon: 'custom_prompt', label: '自定义提示词' },
  { id: 'rewrite', kind: 'text_edit', invocationMode: 'auto', size: 'big', icon: 'text_edit', label: '修改文本' },
  { id: 'manual', kind: 'text_edit', invocationMode: 'manual', size: 'small', icon: 'manual', label: '手动' },
]);
const TYPE_BY_ID = new Map(HOPSCOTCH_HOUSE_TYPES.map(type => [type.id, type]));
// 摘要压缩属于记忆的内部维护，不作为可新增的模板。
const TEMPLATE_KINDS = HOPSCOTCH_HOUSE_CATALOG.filter(item => !['body', 'summary_compaction', 'text_edit', 'custom_prompt'].includes(item.kind));
const AGENT_LIMIT = 8;
// 校验落点时用的占位 Agent：位置、并行数与自定义房子上限仍按真实修改文本房子计算。
const CANDIDATE_AGENT = 'text-edit:house-type-candidate';

const allHouses = board => (board?.rows || []).flatMap(row => row.houses || []);
const findHouse = (board, id) => allHouses(board).find(house => house.id === id) || null;
const agentOf = (house, textAgents) => house?.kind === 'text_edit' ? textAgents.find(config => config.id === house.config?.agentId) || null : null;

// 默认的前情提要固定挂在正文旁：可停用、删除，但不换成别的类型（换掉后它会被重新补挂）。
export const isHopscotchHouseDraft = house => Boolean(house) && house.enabled === false && !['body', 'variable_rules'].includes(house.kind)
  && !(house.kind === 'text_edit' && house.config?.agentId === RECAP_AGENT_ID);

// 'custom' | 'rewrite' | 'manual'；内建房子返回 'builtin:<kind>'。
export const resolveHopscotchHouseType = (house, textAgents = []) => {
  if (house?.kind === 'custom_prompt') return 'custom';
  if (house?.kind === 'text_edit') return getAgentInvocationMode(agentOf(house, textAgents) || {}) === 'manual' ? 'manual' : 'rewrite';
  return `builtin:${house?.kind || ''}`;
};

// 某个停用房子此处可换成的类型、模板与已有 Agent。返回扁平列表，按 group 分组呈现。
export const listHopscotchHouseChoices = (board, houseId, { textAgents = [], canCreateAgent = true } = {}) => {
  const house = findHouse(board, houseId);
  if (!isHopscotchHouseDraft(house)) return [];
  const current = resolveHopscotchHouseType(house, textAgents);
  const linked = agentOf(house, textAgents);
  const fits = (kind, extra = {}) => editHopscotchBoard(board, { type: 'retype', id: houseId, kind, house: extra }).ok;
  const agentHouse = { config: { agentId: CANDIDATE_AGENT } };
  const canNewAgent = canCreateAgent && textAgents.length < AGENT_LIMIT;
  const choices = [];
  for (const type of HOPSCOTCH_HOUSE_TYPES) {
    const needsAgent = type.kind === 'text_edit' && !linked;
    if (needsAgent && !canNewAgent) continue;
    if (type.id !== current && !fits(type.kind, type.kind === 'text_edit' ? agentHouse : {})) continue;
    choices.push({ key: `type:${type.id}`, group: 'type', type: type.id, kind: type.kind, size: type.size, icon: type.icon, label: type.label, current: type.id === current });
  }
  for (const item of TEMPLATE_KINDS) {
    const variants = item.kind === 'variable_rules' ? ['before', 'after'].map(phase => ({ config: { phase }, key: `builtin:variable_rules:${phase}`, label: phase === 'before' ? '发送前变量规则' : '回复后变量规则' }))
      : [{ key: `builtin:${item.kind}`, label: item.label }];
    for (const variant of variants) {
      if (!fits(item.kind, variant.config ? { config: variant.config } : {})) continue;
      choices.push({ key: variant.key, group: 'template', kind: item.kind, size: 'big', icon: item.kind, label: variant.label, house: variant.config ? { config: variant.config } : {}, current: current === `builtin:${item.kind}` });
    }
  }
  if (canNewAgent && fits('text_edit', agentHouse)) choices.push({ key: 'template:recap', group: 'template', template: 'recap', kind: 'text_edit', size: 'small', icon: 'recap', label: '前情提要', current: false });
  const placed = new Set(allHouses(board).map(item => item.kind === 'text_edit' ? item.config?.agentId : '').filter(Boolean));
  for (const config of textAgents) {
    if (placed.has(config.id) || !fits('text_edit', { config: { agentId: config.id } })) continue;
    const manual = getAgentInvocationMode(config) === 'manual';
    choices.push({ key: `agent:${config.id}`, group: 'agent', agentId: config.id, kind: 'text_edit', size: manual ? 'small' : 'big', icon: manual ? 'manual' : 'text_edit', agentIcon: getAgentIconName(config), label: config.title, custom: true, current: false });
  }
  return choices;
};

export const getHopscotchHouseType = id => TYPE_BY_ID.get(id) || null;

// 开启前检查：返回 { ok, message?, field?, enableAgentId? }。不改动板，也不保存 Agent。
export const checkHopscotchHouseEnable = (board, houseId, { textAgents = [], resolveActivation = () => ({ houses: {} }) } = {}) => {
  const house = findHouse(board, houseId);
  if (!house) return { ok: false, message: t('房子不存在') };
  if (house.kind === 'custom_prompt' && !String(house.config?.prompt || '').trim()) return { ok: false, field: 'prompt', message: t('请先填写提示词') };
  const next = editHopscotchBoard(board, { type: 'toggle', id: houseId, enabled: true });
  if (!next.ok) return { ok: false, message: next.reason };
  if (house.kind === 'text_edit') {
    const agent = agentOf(house, textAgents);
    if (!agent) return { ok: false, message: t('找不到对应的 Agent，请重新选择类型') };
    // 未启用的 Agent 交由配置服务开启，它会说明缺少的任务要求、模型或处理范围。
    if (!agent.enabled) return { ok: true, enableAgentId: agent.id };
  }
  const reason = resolveActivation(next.board)?.houses?.[houseId]?.reason || '';
  if (reason && reason !== 'manual_only') return { ok: false, message: hopscotchInactiveLabel(reason) };
  return { ok: true };
};
