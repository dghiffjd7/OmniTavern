import { t } from '../i18n/index.js';
import { appConfirm } from './app-confirm.js';
import { AGENT_TIMEOUT_MAX_SECONDS } from '../agent/agent-generation-settings.js';
import { bindAgentPresetSourceControls, readAgentPresetSource, renderAgentPresetSourceControl } from './agent-preset-source-control.js';
import { STEWARD_CUSTOM_TASK_LIMIT, STEWARD_TASKS, STEWARD_TRANSLATION_LANGUAGES, createStewardCustomTaskId } from '../agent/steward-tasks.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const statuses = { queued: '等待中', running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已停止' };

export const createUtilityAgentEditor = ({ actions, id, scope = 'local', context, documentRef: doc = document }) => {
  let saved = actions.getAgentConfiguration({ id, scope, context });
  context = saved.context; scope = saved.scope;
  let config = structuredClone(saved.config), disposed = false, pending = false;
  const node = doc.createElement('div'); node.className = 'agent-config-editor'; node.dataset.agentCommonEditor = id;
  node.dataset.agentPresetArea = '';
  const presetServices = actions.getAgentPresetServices?.() || null;
  const options = () => ({ id, scope, context, config, revision: saved.revision });
  const hasDraft = () => JSON.stringify(config) !== JSON.stringify(saved.config);
  const updateDraft = () => { node.querySelector('[name=agent-config-draft]').value = JSON.stringify(config); };
  const status = message => { if (!disposed) node.querySelector('[data-status]').textContent = t(message); };
  const runs = () => {
    if (disposed) return;
    const items = actions.listUtilityAgentRuns?.({ id, context }) || [];
    node.querySelector('[data-runs]').innerHTML = items.slice(-5).reverse().map(job => {
      const tokens = job.usage?.totalTokens ?? (job.usage?.promptTokens != null && job.usage?.completionTokens != null ? job.usage.promptTokens + job.usage.completionTokens : null);
      return `<div class="ac-utility-result"><div class="ac-utility-result-head"><span class="ac-utility-status is-${escape(job.status)}">${escape(t(statuses[job.status] || job.status))}</span>${job.taskTitle ? `<b class="ac-steward-run-task">${escape(t(job.taskTitle))}</b>` : ''}
        <small>${escape([job.model, `${(job.durationMs / 1000).toFixed(1)}s`].filter(Boolean).join(' · '))} · ${tokens == null ? escape(t('未返回用量')) : `${tokens} tokens`}</small>
        ${['queued', 'running'].includes(job.status) ? `<button type="button" class="agent-center-card-action" data-cancel="${escape(job.id)}">${escape(t('停止'))}</button>` : ''}</div>
        ${job.message ? `<p role="status" class="ac-utility-message">${escape(t(job.message))}</p>` : ''}
        ${job.title ? `<p class="ac-utility-title">${escape(job.title)}${job.previewOnly ? ` <span class="ac-utility-flag">${escape(t('仅预览'))}</span>` : ''}</p>` : ''}</div>`;
    }).join('');
  };
  let profileOptions = saved.profiles || [], renderVersion = 0;
  // 重画（保存、改等待方式）后保持各任务设置区的展开状态
  const openSections = new Set();
  const rememberOpenSections = () => node.querySelectorAll('details[data-steward-section]').forEach((el) => {
    if (el.open) openSections.add(el.dataset.stewardSection); else openSections.delete(el.dataset.stewardSection);
  });
  const isOpen = key => (openSections.has(key) ? 'open' : '');
  const taskSettings = taskId => config.tasks?.[taskId] || {};
  // 自定义任务：输入与结果的选项（只显示或填入，不直接改 APP 资料）
  const customInputs = () => [['selection', t('选中文字（没选就用整条消息）')], ['message', t('整条消息')], ['recent', t('最近几条对话')], ['input', t('输入框')]];
  const customOutputs = () => [['popup', t('弹窗显示')], ['bubble', t('显示在气泡下方')], ['input', t('填入输入框')]];
  const optionList = (list, selected) => list.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`).join('');
  const customTasksMarkup = () => {
    const tasks = Array.isArray(config.customTasks) ? config.customTasks : [];
    return `<p class="ac-hint">${escape(t('在 Agent 工具箱里使用；选中文字后点工具箱也能用。结果只显示或填入，不会直接改 APP 资料。'))}</p>
      <div class="ac-steward-custom-list">${tasks.map((task, index) => `
        <section class="ac-steward-custom">
          <div class="ac-steward-custom-head">
            <input name="custom-name" data-custom-index="${index}" value="${escape(task.name)}" maxlength="24" aria-label="${escape(t('任务名称'))}" placeholder="${escape(t('任务名称'))}" data-i18n-skip>
            <label class="ac-utility-toggle"><input type="checkbox" role="switch" name="custom-enabled" data-custom-index="${index}" aria-label="${escape(t('启用'))}" ${task.enabled !== false ? 'checked' : ''}></label>
            <button type="button" class="agent-center-card-action" data-action="custom-remove" data-custom-index="${index}">${escape(t('删除'))}</button>
          </div>
          <div class="ac-row">
            <label>${escape(t('处理什么'))}<select name="custom-input" data-custom-index="${index}">${optionList(customInputs(), task.input)}</select></label>
            ${task.input === 'recent' ? `<label>${escape(t('条数'))}<input type="number" name="custom-count" data-custom-index="${index}" min="2" max="30" value="${Number(task.recentCount) || 8}"></label>` : ''}
            <label>${escape(t('结果放哪'))}<select name="custom-output" data-custom-index="${index}">${optionList(customOutputs(), task.output)}</select></label>
          </div>
          <label>${escape(t('要求'))}<textarea name="custom-prompt" data-custom-index="${index}" rows="3" maxlength="4000" placeholder="${escape(t('例如：把这段话改写得更口语化'))}">${escape(task.prompt)}</textarea></label>
        </section>`).join('')}</div>
      ${tasks.length < STEWARD_CUSTOM_TASK_LIMIT ? `<button type="button" class="agent-center-card-action" data-action="custom-add">${escape(t('新增自定义任务'))}</button>` : ''}`;
  };
  const render = () => {
    const version = ++renderVersion;
    const sample = node.querySelector('[name=sample]')?.value || '';
    rememberOpenSections();
    const presetView = presetServices && config.presetId ? presetServices.describePreset(config.presetId) : null;
    const hidePrompt = config.promptSource === 'preset' && presetView?.ok ? 'hidden' : '';
    const presetHtml = presetServices ? renderAgentPresetSourceControl({ scope: `agent-${id}`, kind: 'archive_naming', mode: config.promptSource, presetId: config.presetId, view: presetView, limitValue: String(config.maxTokens), showActions: false }) : '';
    // 存档命名的补充要求、套用预设与输出上限沿用小管家原本的字段；其他任务只有各自的少量设置
    const taskBody = (task) => {
      if (task.id === 'archive_naming') return `
      ${presetHtml}
      <label data-agent-preset-prompt-part ${hidePrompt}>${escape(t('补充要求（可选）'))}<textarea name="prompt" rows="3">${escape(config.prompt)}</textarea></label>
      <label>${escape(t('最大输出 token'))}<input type="number" name="maxTokens" min="16" max="16000" value="${config.maxTokens}"></label>`;
      if (task.id === 'translate_message') {
        const selected = taskSettings(task.id).targetLanguage || '';
        return `<label>${escape(t('译成'))}<select name="task-language" data-task="${escape(task.id)}"><option value="">${escape(t('跟随界面语言'))}</option>${STEWARD_TRANSLATION_LANGUAGES.map(language => `<option value="${escape(language.id)}" data-i18n-skip ${language.id === selected ? 'selected' : ''}>${escape(language.label)}</option>`).join('')}</select></label>
      <p class="ac-hint">${escape(t('译文显示在气泡下方，不改原文，也不会发给角色模型。'))}</p>`;
      }
      if (task.id === 'archive_overview') return `<p class="ac-hint">${escape(t('概述显示在「聊天与存档」的存档名下一行；离开聊天室时只在有新消息时更新。'))}</p>`;
      if (task.id === 'image_tags') return `<p class="ac-hint">${escape(t('结果先给你看，按「替换」或「追加」才写进提示词。'))}</p>`;
      if (task.id === 'custom_tasks') return customTasksMarkup();
      if (task.id === 'sticker_keywords') return `<p class="ac-hint">${escape(t('要用能看图的模型；共用模型不能看图时，在上面单独指定。默认只补没有关键词的贴图，写入后可一键还原。'))}</p>`;
      return '';
    };
    const taskTrial = task => (task.id === 'archive_naming' ? `
      <details class="ac-utility-disclosure ac-steward-trial" data-steward-section="trial:${escape(task.id)}" ${isOpen(`trial:${task.id}`)}><summary>${escape(t('试运行'))}</summary>
        <div class="ac-steward-task-body">
          <p class="ac-hint">${escape(t('试运行只预览名称，不修改存档。'))}</p>
          ${scope === 'global' && actions.getAgentConfiguration({ id, scope: 'local', context })?.inherited === false ? `<p class="ac-hint">${escape(t('当前聊天有单独配置，试运行按当前聊天的配置执行。'))}</p>` : ''}
          <label>${escape(t('对话摘录'))}<textarea name="sample" rows="6" maxlength="12000"></textarea></label>
          <div class="ac-actions"><button type="button" class="agent-center-card-action" data-action="load">${escape(t('载入最近对话'))}</button><button type="button" class="agent-center-card-action is-primary" data-action="run">${escape(t('试运行'))}</button></div>
        </div>
      </details>` : '');
    const tasksHtml = STEWARD_TASKS.map(task => `
      <article class="ac-utility-card ac-steward-task${config.enabled ? '' : ' is-paused'}" data-steward-task="${escape(task.id)}">
        <div class="ac-steward-task-head">
          <span class="ac-steward-task-copy"><strong>${escape(t(task.title))}</strong><small>${escape(t(task.trigger))}</small></span>
          <label class="ac-utility-toggle" title="${escape(t(task.title))}"><input type="checkbox" role="switch" name="task-enabled" data-task="${escape(task.id)}" aria-label="${escape(t(task.title))}" ${taskSettings(task.id).enabled !== false ? 'checked' : ''}></label>
        </div>
        <details class="ac-utility-disclosure" data-steward-section="settings:${escape(task.id)}" ${isOpen(`settings:${task.id}`)}><summary>${escape(t('任务设置'))}</summary>
          <div class="ac-steward-task-body">
            <label>${escape(t('模型'))}<select name="task-model" data-task="${escape(task.id)}"></select></label>
            ${taskBody(task)}
          </div>
        </details>
        ${taskTrial(task)}
      </article>`).join('');
    node.innerHTML = `<div class="ac-utility-head"><label>${escape(t('配置范围'))}<select name="scope"><option value="local" ${scope === 'local' ? 'selected' : ''}>${escape(t(context.place === 'writing' ? '当前角色' : '当前聊天'))}</option><option value="global" ${scope === 'global' ? 'selected' : ''}>${escape(t('全局'))}</option></select></label>
    <p class="ac-hint">${escape(t('把起名、翻译、转标签这类小任务交给小模型处理；各任务默认用共用模型。'))}</p></div>
    <section class="ac-utility-card ac-steward-shared">
    <label class="ac-switch ac-utility-toggle"><span>${escape(t('启用小管家'))}</span><input type="checkbox" role="switch" name="enabled" ${config.enabled ? 'checked' : ''}></label>
    <label>${escape(t('共用模型'))}<select name="profile"></select></label>
    <details class="ac-utility-disclosure" data-steward-section="generation" ${isOpen('generation')}><summary>${escape(t('生成设置'))}</summary><div class="ac-row"><label>${escape(t('最长等待'))}<select name="timeoutMode"><option value="follow" ${config.timeoutMode !== 'custom' ? 'selected' : ''}>${escape(t('跟随模型配置'))}</option><option value="custom" ${config.timeoutMode === 'custom' ? 'selected' : ''}>${escape(t('自定义'))}</option></select></label>${config.timeoutMode === 'custom' ? `<label>${escape(t('自定义等待（秒）'))}<input type="number" name="timeoutSeconds" min="5" max="${AGENT_TIMEOUT_MAX_SECONDS}" value="${config.timeoutSeconds ?? ''}"></label>` : ''}</div>${config.timeoutMode === 'custom' ? `<p class="ac-hint">${escape(t('自定义优先于 API 配置的请求超时。'))}</p>` : ''}</details>
    </section>
    <h4 class="ac-steward-tasks-title">${escape(t('任务'))}<b>${STEWARD_TASKS.length}</b></h4>
    <div class="ac-steward-tasks">${tasksHtml}</div>
    <div class="ac-actions ac-steward-actions"><button type="button" class="agent-center-card-action is-primary" data-action="save">${escape(t('保存'))}</button><button type="button" class="agent-center-card-action" data-action="reset">${escape(t(scope === 'global' ? '恢复默认' : '跟随全局配置'))}</button><small data-status role="status" aria-live="polite"></small></div>
    <div data-runs class="ac-utility-results" aria-live="polite"></div>`;
    const sampleField = node.querySelector('[name=sample]');
    if (sampleField) sampleField.value = sample;
    const marker = doc.createElement('input'); marker.type = 'text'; marker.hidden = true; marker.name = 'agent-config-draft';
    marker.defaultValue = JSON.stringify(saved.config); marker.value = JSON.stringify(config); node.append(marker);
    const profileOptionsHtml = (selectedId, emptyLabel) => {
      const options = profileOptions.slice();
      if (selectedId && !options.some(profile => profile.id === selectedId)) options.push({ id: selectedId, name: selectedId });
      return `<option value="">${escape(emptyLabel)}</option>` + options.map(profile => `<option value="${escape(profile.id)}" ${profile.id === selectedId ? 'selected' : ''}>${escape(profile.name)}${profile.model ? ` · ${escape(profile.model)}` : ''}</option>`).join('');
    };
    const showProfiles = () => {
      if (disposed || version !== renderVersion) return;
      node.querySelector('[name=profile]').innerHTML = profileOptionsHtml(config.modelProfileId, t('请选择模型配置'));
      node.querySelectorAll('select[name=task-model]').forEach((select) => {
        select.innerHTML = profileOptionsHtml(taskSettings(select.dataset.task).modelProfileId, t('跟随共用模型'));
      });
    };
    showProfiles();
    // Config managers may not be hydrated until the connection panel is opened.
    Promise.resolve(actions.listAgentModelProfiles?.()).then(profiles => { if (Array.isArray(profiles)) { profileOptions = profiles; showProfiles(); } }).catch(error => status(error.message || '加载失败'));
    runs();
    bindAgentPresetSourceControls(node, { services: presetServices });
  };
  render();
  node.addEventListener('input', event => {
    const presetControl = event.target.closest?.('[data-agent-preset-source]');
    if (presetControl) {
      const { mode, presetId } = readAgentPresetSource(presetControl);
      config.promptSource = mode; config.presetId = presetId;
      updateDraft();
      return;
    }
    const field = event.target.name;
    const taskId = event.target.dataset?.task;
    if (field === 'enabled') { config.enabled = event.target.checked; node.querySelectorAll('[data-steward-task]').forEach(el => el.classList.toggle('is-paused', !config.enabled)); }
    else if (field === 'task-enabled' && taskId) config.tasks = { ...config.tasks, [taskId]: { ...config.tasks?.[taskId], enabled: event.target.checked } };
    else if (field === 'task-model' && taskId) config.tasks = { ...config.tasks, [taskId]: { ...config.tasks?.[taskId], modelProfileId: event.target.value } };
    else if (field === 'task-language' && taskId) config.tasks = { ...config.tasks, [taskId]: { ...config.tasks?.[taskId], targetLanguage: event.target.value } };
    else if (String(field).startsWith('custom-') && event.target.dataset?.customIndex !== undefined) {
      const index = Number(event.target.dataset.customIndex);
      const key = { 'custom-name': 'name', 'custom-enabled': 'enabled', 'custom-input': 'input', 'custom-count': 'recentCount', 'custom-output': 'output', 'custom-prompt': 'prompt' }[field];
      const value = field === 'custom-enabled' ? event.target.checked : field === 'custom-count' ? Number(event.target.value) : event.target.value;
      if (key && config.customTasks?.[index]) {
        config.customTasks = config.customTasks.map((task, i) => (i === index ? { ...task, [key]: value } : task));
        // 选「最近几条对话」才显示条数
        if (field === 'custom-input') { updateDraft(); render(); return; }
      }
    }
    else if (field === 'profile') { config.modelMode = event.target.value ? 'profile' : 'none'; config.modelProfileId = event.target.value; }
    else if (field === 'prompt') config.prompt = event.target.value;
    else if (field === 'maxTokens') config.maxTokens = Number(event.target.value);
    else if (field === 'timeoutSeconds') { config.timeoutMode = 'custom'; config.timeoutSeconds = Number(event.target.value); }
    else if (field === 'timeoutMode') {
      config.timeoutMode = event.target.value === 'custom' ? 'custom' : 'follow';
      config.timeoutSeconds = config.timeoutMode === 'custom' ? config.timeoutSeconds || 60 : null;
      openSections.add('generation'); render(); node.querySelector('[name=timeoutMode]')?.focus();
    }
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
    if (action === 'custom-add') {
      config.customTasks = [...(config.customTasks || []), { id: createStewardCustomTaskId(), name: t('新任务'), input: 'message', recentCount: 8, prompt: '', output: 'popup', enabled: true }];
      openSections.add('settings:custom_tasks'); render();
      node.querySelectorAll('input[name=custom-name]')[config.customTasks.length - 1]?.focus();
      return;
    }
    if (action === 'custom-remove') {
      const index = Number(event.target.closest('[data-action]').dataset.customIndex);
      config.customTasks = (config.customTasks || []).filter((_, i) => i !== index);
      render();
      return;
    }
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
        pending = true; const runButton = node.querySelector('[data-action=run]'); if (runButton) runButton.disabled = true;
        const result = await actions.runUtilityAgent({ ...options(), text: node.querySelector('[name=sample]').value });
        status(result.status === 'succeeded' ? '处理完成' : result.reason || '处理失败'); runs();
      }
    } catch (error) { status(error.message || '操作失败'); }
    finally { pending = false; const runButton = disposed ? null : node.querySelector('[data-action=run]'); if (runButton) runButton.disabled = false; }
  });
  doc.defaultView.addEventListener('agent-utility-changed', runs);
  runs();
  return { node, hasDraft, attach: host => host.replaceWith(node), closePreview: () => false,
    dispose: () => { disposed = true; doc.defaultView.removeEventListener('agent-utility-changed', runs); node.remove(); } };
};
