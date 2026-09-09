import { t } from '../i18n/index.js';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const requestParamStatusLabel = status => ({
  partially_excluded: t('部分排除'), applied: t('已应用'), disabled: t('已停用'), excluded: t('已排除'), absent: t('请求中无此字段'),
  managed: t('由对应功能管理'), required: t('接口必填'), task: t('按任务设置'),
  preset: t('由预设管理'), partially_preset: t('部分由预设管理'),
  limited: t('按任务上限'), invalid: t('参数名无效'),
})[status] || status;
export const renderRequestParamReport = report => {
  if (!Array.isArray(report) || !report.length) return '';
  return `<dl class="request-param-report">${report.map(item => `<div><dt data-i18n-skip="true">${escapeHtml(item.name)}${item.path && item.path !== item.name ? ` → ${escapeHtml(item.path)}` : ''}${item.presetPaths?.length ? `<small>${escapeHtml(item.presetPaths.join(', '))}</small>` : ''}</dt><dd>${escapeHtml(requestParamStatusLabel(item.status))}${item.limit ? ` · ${escapeHtml(item.limit)}` : ''}</dd></div>`).join('')}</dl>`;
};
