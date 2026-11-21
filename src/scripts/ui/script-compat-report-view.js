import { t } from '../i18n/index.js';
import { fingerprintCompatGapValue } from '../storage/compat-gap-report-store.js';
import { getTavernFeatureCategoryLabel } from '../import/tavern-feature-report.js';

// 脚本面板的兼容报告：「按代码推测」来自 import/tavern-feature-report（静态分析），
// 「执行时实际打到」来自兼容缺口记录（脚本打到 APP 没有的酒馆接口时，tavern-api-router 记下的）。

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
}[char]));

const STATUS_ORDER = ['unsupported', 'partial', 'supported'];
const statusLabel = status => ({
  supported: t('支持'),
  partial: t('部分支持'),
  unsupported: t('不支持'),
}[status] || String(status || ''));

// 同一脚本经酒馆接口记下的缺口（与 tavern-api-router 的 buildTavernApiGapReport 同一个范围指纹）
export const getScriptRuntimeGapReports = (reports = [], scriptId = '') => {
  const id = String(scriptId || '').trim();
  if (!id) return [];
  const scope = fingerprintCompatGapValue(`script:${id}`);
  return (Array.isArray(reports) ? reports : [])
    .filter(report => report?.phase === 'tavern_api' && report.scopeFingerprint === scope)
    .sort((left, right) => (Number(right.lastSeenAt) || 0) - (Number(left.lastSeenAt) || 0));
};

const countLabel = (status, count) => ({
  supported: () => t('{count} 项支持', { count }),
  partial: () => t('{count} 项部分支持', { count }),
  unsupported: () => t('{count} 项不支持', { count }),
}[status]?.() || String(count));

const countByStatus = (items = []) => {
  const counts = { supported: 0, partial: 0, unsupported: 0 };
  items.forEach((item) => { if (Object.hasOwn(counts, item?.status)) counts[item.status] += 1; });
  return counts;
};

// 卡片上的摘要按钮内容；没有用到酒馆功能、也没有执行时缺口时回空字串（不显示）
export const renderScriptCompatToggleHtml = ({ report = null, gaps = [] } = {}) => {
  const items = Array.isArray(report?.items) ? report.items : [];
  const gapList = Array.isArray(gaps) ? gaps : [];
  if (!items.length && !gapList.length) return '';
  const counts = countByStatus(items);
  const chips = [...STATUS_ORDER].reverse()
    .filter(status => counts[status] > 0)
    .map(status => `<span class="script-compat-count is-${status}">${escapeHtml(countLabel(status, counts[status]))}</span>`);
  if (gapList.length) {
    chips.push(`<span class="script-compat-count is-gap">${escapeHtml(t('执行时缺口 {count}', { count: gapList.length }))}</span>`);
  }
  return `<span class="script-compat-toggle-label">${escapeHtml(t('酒馆功能'))}</span>${chips.join('')}`
    + '<svg class="script-compat-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
};

const renderBadge = status => `<span class="script-compat-badge is-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;

const renderFeatureRow = item => [
  '<li class="script-compat-row">',
  '<div class="script-compat-row-head">',
  renderBadge(item.status),
  // 接口路径、函数名这类代码用等宽字；「酒馆页面元素」这类中文名称用一般字体
  `<span class="script-compat-label${/[\u3400-\u9fff]/.test(String(item.label || '')) ? '' : ' is-code'}">${escapeHtml(item.label)}</span>`,
  `<span class="script-compat-category">${escapeHtml(getTavernFeatureCategoryLabel(item.category))}</span>`,
  '</div>',
  `<div class="script-compat-impact">${escapeHtml(item.impact)}</div>`,
  Array.isArray(item.matches) && item.matches.length
    ? `<div class="script-compat-matches"><span>${escapeHtml(t('识别到：'))}</span>${item.matches.map(form => `<code>${escapeHtml(form)}</code>`).join('')}</div>`
    : '',
  '</li>',
].join('');

const defaultFormatTime = (value) => {
  const timestamp = Number(value) || 0;
  if (!timestamp) return '-';
  try { return new Date(timestamp).toLocaleString(); } catch { return '-'; }
};

const renderGapRow = (gap, formatTime) => [
  '<li class="script-compat-row">',
  '<div class="script-compat-row-head">',
  renderBadge('unsupported'),
  `<span class="script-compat-label is-code">${escapeHtml(gap.api)}</span>`,
  '</div>',
  `<div class="script-compat-impact">${escapeHtml(t('调用 {count} 次，最后一次 {time}', {
    count: Number(gap.confirmedCount) || Number(gap.candidateCount) || 1,
    time: formatTime(gap.lastSeenAt),
  }))}</div>`,
  '</li>',
].join('');

// 展开后的明细：按代码推测（项目、支持状态、影响、识别到的写法）与执行时实际打到的缺口
export const renderScriptCompatDetailHtml = ({ report = null, gaps = [], formatTime = defaultFormatTime } = {}) => {
  const items = (Array.isArray(report?.items) ? report.items : [])
    .slice()
    .sort((left, right) => STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status));
  const gapList = Array.isArray(gaps) ? gaps : [];
  return [
    '<div class="script-compat-section">',
    `<div class="script-compat-section-title">${escapeHtml(t('按代码推测'))}</div>`,
    `<div class="script-compat-hint">${escapeHtml(t('按脚本代码判断用到的酒馆功能；实际会不会用到，要看脚本执行到哪里。'))}</div>`,
    report?.runtime === 'module'
      ? `<div class="script-compat-hint">${escapeHtml(t('这个脚本以模块方式运行（用了 import／export 或顶层 await），能用的酒馆功能比一般脚本少。'))}</div>`
      : '',
    items.length
      ? `<ul class="script-compat-list">${items.map(renderFeatureRow).join('')}</ul>`
      : `<div class="script-compat-empty">${escapeHtml(t('没有认出用到的酒馆功能。'))}</div>`,
    '</div>',
    '<div class="script-compat-section">',
    `<div class="script-compat-section-title">${escapeHtml(t('执行时实际打到'))}</div>`,
    gapList.length
      ? `<ul class="script-compat-list">${gapList.map(gap => renderGapRow(gap, formatTime)).join('')}</ul>`
      : `<div class="script-compat-empty">${escapeHtml(t('还没有记录。脚本调用 APP 没有的酒馆接口时会记在这里。'))}</div>`,
    '</div>',
  ].join('');
};
