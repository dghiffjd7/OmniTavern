import { t } from '../../i18n/index.js';
import { hopscotchInactiveLabel } from './hopscotch-activation-utils.js';
import { escapeHopscotchHtml as e } from './hopscotch-court-view.js';

export const buildHopscotchVariableCard = (activity = {}, active = {}) => ({
  id: 'variable', title: t('变量更新'), category: 'chat', accent: 'preview', implemented: true,
  enabled: active.enabled === true, contextual: true,
  summary: t('当前角色'), detail: [],
  statusLabel: active.enabled ? t('已启用') : t('已停用'),
  statusHelp: active.enabled ? '' : hopscotchInactiveLabel(active.reason || activity.reason),
});

export const renderHopscotchVariableInfo = (activity = {}, active = {}, { execution = '' } = {}) => {
  const kinds = { st: t('ST 兼容变量'), app: t('App 变量') };
  const modes = { inline: t('随正文更新'), model_rule: t('模型规则评估'), local_rule: t('本地规则更新') };
  const effects = { values: t('变量值'), display: t('状态显示'), stage: t('角色与剧情阶段'), prompt: t('提示词条件') };
  const values = [
    [t('类型'), (activity.kinds || []).map(kind => kinds[kind]).filter(Boolean).join(' · ') || '—'],
    [t('变量'), String(activity.variableCount || 0)],
    [t('更新方式'), execution === 'standalone' ? t('独立请求更新') : (activity.updateModes || []).filter(mode => execution !== 'rules' || mode !== 'inline').map(mode => modes[mode]).filter(Boolean).join(' · ') || '—'],
    [t('影响'), (activity.effects || []).map(effect => effects[effect]).filter(Boolean).join(' · ') || '—'],
  ];
  return `<div class="hop-variable-info">
    <div class="agent-center-agent-section-title has-help" data-help="${e(active.enabled ? t('按当前角色的变量、更新约定和启用规则判断；条件规则在触发时执行。') : hopscotchInactiveLabel(active.reason || activity.reason))}">${e(t('角色变量'))}</div>
    <dl>${values.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>
    <div class="agent-center-card-actions"><button type="button" class="agent-center-card-action" data-action="variable-settings">${e(t('变量设置'))}</button><button type="button" class="agent-center-card-action" data-action="variable-preview-tools">${e(t('变更预览工具'))}</button></div>
  </div>`;
};
