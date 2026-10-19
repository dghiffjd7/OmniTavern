// AC「正文生成」卡片里的「防截断传输」区块：开关存在模型设置档里，一拨就生效，不进画板草稿。
import { t } from '../../i18n/index.js';

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const renderBodyToolTransportSection = (view = {}) => {
  if (!view?.available) return '';
  const enabled = view.enabled === true;
  const help = t('正文改走工具调用传回，避免回复被中途截断。开关跟着模型设置档；不要和预设里的同类功能同时开。');
  return `<div class="agent-center-agent-section" data-body-tool-transport>
    <div class="agent-center-agent-section-title has-help" data-help-mode="tap" data-help="${escapeHtml(help)}">${escapeHtml(t('防截断传输'))}</div>
    <div class="agent-center-agent-settings"><div class="agent-center-setting-row hop-body-transport-setting">
      <span class="agent-center-setting-label">${escapeHtml(t('设置档：{name}', { name: view.profileName }))}</span>
      <button type="button" class="agent-center-switch${enabled ? ' is-on' : ''}" role="switch" aria-checked="${enabled}" aria-label="${escapeHtml(t('防截断传输'))}" data-body-tool-transport-toggle><span class="agent-center-switch-track" aria-hidden="true"><span class="agent-center-switch-thumb"></span></span></button>
    </div></div>
    <p class="hop-hint">${escapeHtml(t('正文改走工具调用传回，避免回复被中途截断。不要和预设里的同类功能同时开。'))}</p>
    ${view.supported === false ? `<p class="hop-hint">${escapeHtml(t('当前接口不支持函数调用，开启后仍按普通文字输出。'))}</p>` : ''}
  </div>`;
};

// 区块用事件委派绑在卡片内容上：切换后按最新状态重画这一块
export const bindBodyToolTransportSection = (root, { setting, getSessionId = () => '' } = {}) => {
  if (!root || !setting) return;
  root.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-body-tool-transport-toggle]');
    if (!button || button.disabled) return;
    const sessionId = getSessionId();
    button.disabled = true;
    try {
      await setting.set(sessionId, button.getAttribute('aria-checked') !== 'true');
    } catch {
      window.toastr?.warning?.(t('防截断传输开关保存失败'));
    }
    const section = button.closest('[data-body-tool-transport]');
    if (section?.isConnected) section.outerHTML = renderBodyToolTransportSection(setting.describe(sessionId));
  });
};
