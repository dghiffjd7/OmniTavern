import { t } from '../i18n/index.js';
import { appConfirm } from './app-confirm.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const statuses = { queued: '等待中', running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已停止' };

export const createUtilityAgentEditor = ({ actions, id, scope = 'local', context, documentRef: doc = document }) => {
  let saved = actions.getAgentConfiguration({ id, scope, context });
  context = saved.context; scope = saved.scope;
  let config = structuredClone(saved.config), disposed = false, pending = false;
  const scoring = id === 'reply_scoring';
  const node = doc.createElement('div'); node.className = 'agent-config-editor'; node.dataset.agentCommonEditor = id;
  const options = () => ({ id, scope, context, config, revision: saved.revision });
  const hasDraft = () => JSON.stringify(config) !== JSON.stringify(saved.config);
  const updateDraft = () => { node.querySelector('[name=agent-config-draft]').value = JSON.stringify(config); };
  const status = message => { if (!disposed) node.querySelector('[data-status]').textContent = t(message); };
  const runs = () => {
    if (disposed) return;
    const items = actions.listUtilityAgentRuns?.({ id, context }) || [];
    node.querySelector('[data-runs]').innerHTML = items.slice(-5).reverse().map(job => {
      const tokens = job.usage?.totalTokens ?? (job.usage?.promptTokens != null && job.usage?.completionTokens != null ? job.usage.promptTokens + job.usage.completionTokens : null);
      return `<div class="ac-utility-result"><div class="ac-row"><strong>${escape(t(statuses[job.status] || job.status))}</strong>${['queued', 'running'].includes(job.status) ? `<button type="button" class="agent-center-card-action" data-cancel="${escape(job.id)}">${escape(t('停止'))}</button>` : ''}</div>
        <small>${escape(job.model)} · ${(job.durationMs / 1000).toFixed(1)}s · ${tokens == null ? escape(t('未返回用量')) : `${tokens} tokens`}</small>
        ${job.message ? `<p role="status">${escape(t(job.message))}</p>` : ''}
        ${job.title ? `<p>${escape(job.title)}${job.previewOnly ? ` · ${escape(t('仅预览'))}` : ''}</p>` : ''}
        ${(job.scores || []).map(row => `<div class="ac-utility-score"><div><strong>${escape(row.id)} · ${row.score.toFixed(2)}</strong>${row.score >= job.threshold ? ` <span>${escape(t('建议关注'))}</span>` : ''}</div><p>${escape(row.text)}</p><small>${escape(row.reason)}</small></div>`).join('')}</div>`;
    }).join('');
  };
  let profileOptions = saved.profiles || [], renderVersion = 0;
  const render = () => {
    const version = ++renderVersion;
    const sample = node.querySelector('[name=sample]')?.value || '';
    node.innerHTML = `<label>${escape(t('配置范围'))}<select name="scope"><option value="local" ${scope === 'local' ? 'selected' : ''}>${escape(t(context.place === 'writing' ? '当前角色' : '当前聊天'))}</option><option value="global" ${scope === 'global' ? 'selected' : ''}>${escape(t('全局'))}</option></select></label>
    <p class="ac-hint">${escape(t(scoring ? '分数越高，越建议修改。评分仅供参考，不会修改正文。' : '新存档未填写名称时自动命名；手动名称保持不变。'))}</p>
    <label class="ac-switch"><span>${escape(t(scoring ? '启用评分预览' : '自动命名存档'))}</span><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}></label>
    <label>${escape(t('模型配置'))}<select name="profile"></select></label>
    <label>${escape(t('补充要求（可选）'))}<textarea name="prompt" rows="3">${escape(config.prompt)}</textarea></label>
    ${scoring ? `<label>${escape(t('关注阈值'))}<input type="number" name="scoreThreshold" min="0" max="1" step="0.05" value="${config.scoreThreshold}"></label>` : ''}
    <details><summary>${escape(t('生成设置'))}</summary><div class="ac-row"><label>${escape(t('最大输出 token'))}<input type="number" name="maxTokens" min="16" max="16000" value="${config.maxTokens}"></label><label>${escape(t('超时（秒）'))}<input type="number" name="timeoutSeconds" min="5" max="300" value="${config.timeoutSeconds}"></label></div></details>
    <div class="ac-actions"><button type="button" class="agent-center-card-action" data-action="save">${escape(t('保存'))}</button><button type="button" class="agent-center-card-action" data-action="reset">${escape(t(scope === 'global' ? '恢复默认' : '跟随全局配置'))}</button><small data-status role="status" aria-live="polite"></small></div>
    <details ${scoring ? 'open' : ''}><summary>${escape(t(scoring ? '手动评分' : '试运行'))}</summary>
      <p>${escape(t(scoring ? '按换行分段，最多 40 段、12000 个字符。' : '试运行只预览名称，不修改存档。'))}</p>
      <button type="button" class="agent-center-card-action" data-action="load">${escape(t(scoring ? '载入最近回复' : '载入最近对话'))}</button>
      <label>${escape(t(scoring ? '待评分正文' : '对话摘录'))}<textarea name="sample" rows="6" maxlength="12000"></textarea></label>
      <button type="button" class="agent-center-card-action" data-action="run">${escape(t(scoring ? '开始评分' : '试运行'))}</button>
    </details><div data-runs class="ac-utility-results" aria-live="polite"></div>`;
    node.querySelector('[name=sample]').value = sample;
    const marker = doc.createElement('input'); marker.type = 'text'; marker.hidden = true; marker.name = 'agent-config-draft';
    marker.defaultValue = JSON.stringify(saved.config); marker.value = JSON.stringify(config); node.append(marker);
    const showProfiles = () => {
      if (disposed || version !== renderVersion) return;
      const options = profileOptions.slice();
      if (config.modelProfileId && !options.some(profile => profile.id === config.modelProfileId)) options.push({ id: config.modelProfileId, name: config.modelProfileId });
      node.querySelector('[name=profile]').innerHTML = `<option value="">${escape(t('请选择模型配置'))}</option>` + options.map(profile => `<option value="${escape(profile.id)}" ${profile.id === config.modelProfileId ? 'selected' : ''}>${escape(profile.name)}${profile.model ? ` · ${escape(profile.model)}` : ''}</option>`).join('');
    };
    showProfiles();
    // Config managers may not be hydrated until the connection panel is opened.
    Promise.resolve(actions.listAgentModelProfiles?.()).then(profiles => { if (Array.isArray(profiles)) { profileOptions = profiles; showProfiles(); } }).catch(error => status(error.message || '加载失败'));
    runs();
  };
  render();
  node.addEventListener('input', event => {
    const field = event.target.name;
    if (field === 'enabled') config.enabled = event.target.checked;
    else if (field === 'profile') { config.modelMode = event.target.value ? 'profile' : 'none'; config.modelProfileId = event.target.value; }
    else if (field === 'prompt') config.prompt = event.target.value;
    else if (['maxTokens', 'timeoutSeconds', 'scoreThreshold'].includes(field)) config[field] = Number(event.target.value);
    updateDraft();
  });
  node.addEventListener('change', async event => {
    if (event.target.name !== 'scope') return;
    const nextScope = event.target.value;
    event.target.value = scope;
    if (pending || nextScope === scope) return;
    if (hasDraft() && !await appConfirm({ title: t('未保存的修改'), message: t('切换范围会放弃未保存的修改。'), confirmText: t('放弃修改'), cancelText: t('继续编辑') })) return;
    scope = nextScope; saved = actions.getAgentConfiguration({ id, scope, context }); config = structuredClone(saved.config); render();
  });
  node.addEventListener('click', async event => {
    const cancel = event.target.closest('[data-cancel]');
    if (cancel) { actions.cancelUtilityAgentRun?.(cancel.dataset.cancel); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || pending) return;
    try {
      if (action === 'load') { node.querySelector('[name=sample]').value = actions.getUtilityAgentSample({ id, context }); return; }
      if (action === 'reset') {
        if (!await appConfirm({ title: t(scope === 'global' ? '恢复默认' : '跟随全局配置'), message: t('当前配置将被重置。'), confirmText: t('确认'), cancelText: t('取消') })) return;
        pending = true;
        const result = await actions.resetAgentConfiguration(options());
        if (!result?.ok) throw new Error(result?.message || result?.reason || '保存失败');
        saved = actions.getAgentConfiguration({ id, scope, context }); config = structuredClone(saved.config); render(); status('已保存'); return;
      }
      if (action === 'save') {
        pending = true;
        const submitted = JSON.stringify(config);
        const result = await actions.saveAgentConfiguration(options());
        if (!result?.ok) throw new Error(result?.message || result?.reason || '保存失败');
        const newerDraft = JSON.stringify(config) !== submitted;
        saved = actions.getAgentConfiguration({ id, scope, context });
        if (!newerDraft) config = structuredClone(saved.config);
        render(); status(newerDraft ? '已保存，另有未保存修改' : '已保存'); return;
      }
      if (action === 'run') {
        if (hasDraft()) { status('请先保存配置'); return; }
        pending = true; node.querySelector('[data-action=run]').disabled = true;
        const result = await actions.runUtilityAgent({ ...options(), text: node.querySelector('[name=sample]').value });
        status(result.status === 'succeeded' ? '处理完成' : result.reason || '处理失败'); runs();
      }
    } catch (error) { status(error.message || '操作失败'); }
    finally { pending = false; if (!disposed) node.querySelector('[data-action=run]').disabled = false; }
  });
  doc.defaultView.addEventListener('agent-utility-changed', runs);
  runs();
  return { node, hasDraft, attach: host => host.replaceWith(node), closePreview: () => false,
    dispose: () => { disposed = true; doc.defaultView.removeEventListener('agent-utility-changed', runs); node.remove(); } };
};
