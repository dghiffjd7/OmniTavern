import { t } from '../i18n/index.js';
import { allowsAgentInvocation, isInputAgent } from '../agent/agent-invocation.js';
import { agentIconMarkup, getAgentIconName } from '../agent/agent-icons.js';
import { agentToolContextKey, isAgentToolReply } from '../agent/agent-tool-targets.js';
import { createMessageClipboardUiRuntime } from './chat/message-clipboard-ui-utils.js';
import { createFormatRepairPicker } from './chat/format-repair-picker.js';
import { resolveFormatRepairProfile } from '../agent/format-repair-profiles.js';
import { createAgentToolboxView, toolboxEscape as e, toolboxButton as button, toolboxNamedIcon, toolboxManagementMarkup } from './agent-toolbox-view.js';
import { normalizeToolboxPreferences, reconcileToolboxPreferences, getToolboxItems, setToolboxItemVisible,
  isAgentToolToggle, toolboxVisibleCount } from './agent-toolbox-model.js';

const labels = { running:'处理中', ready:'待查看', reviewing:'正在查看', applying:'正在应用', applied:'已应用', ignored:'已收起', failed:'失败', expired:'已过期', cancelled:'已取消', unchanged:'无需修改', succeeded:'已完成', skipped:'未执行' };
const pendingStates = new Set(['running', 'ready', 'reviewing', 'applying']);
const isNote = job => job?.outputMode === 'note' || job?.kind === 'note';
const sameContext = (a, b) => agentToolContextKey(a) === agentToolContextKey(b);
const sourceHint = (config, snapshot) => snapshot?.targetMode === 'full' || config.target?.mode === 'full' ? '完整回复' : ['tags', 'regex'].includes(config.target?.mode) ? '指定部分' : '正文';

export const createAgentToolbox = ({ input, actions, getContext, getMessages, getInputSnapshot, openAgent, openCenter,
  triggerContainer, anchorEl, targetEventRoot, beforeOpen = () => {}, documentRef = document, storage = globalThis.localStorage } = {}) => {
  const doc = documentRef, win = doc.defaultView, bindings = [], nodes = new Map(), toggling = new Set(), invoking = new Set();
  const clipboard = createMessageClipboardUiRuntime({ documentLike: doc, navigatorLike: win.navigator, execCopyCommand: command => doc.execCommand(command) });
  let prefs;
  try { prefs = normalizeToolboxPreferences(JSON.parse(storage?.getItem('agent_toolbox_ui_v2') || storage?.getItem('agent_toolbox_ui_v1') || '{}')); }
  catch { prefs = normalizeToolboxPreferences(); }
  const savePrefs = () => { try { storage?.setItem('agent_toolbox_ui_v2', JSON.stringify(prefs)); } catch {} };
  const row = input.closest('.chat-input-row'), entryAnchor = anchorEl || row?.querySelector('.voice-btn') || input;
  const view = createAgentToolboxView(doc, triggerContainer || row?.querySelector('.chat-action-inline'), entryAnchor);
  const { trigger, panel, card, icons, shelf, legend, notice, inbox } = view;
  let catalog = [], items = [], context = null, selectedId = '', selectedRunId = '', mode = 'shelf', prepared = null, preparing = false;
  let target = null, inputTarget = null, selectionSnapshot = null, controller = null, picking = false, recording = false, ordering = false;
  let shortcutError = '';
  let repairProfileId = '', rawRange = null, rawSource = '';
  let frame = 0, targetFrame = 0, epoch = 0, disposed = false, cardStamp = '', resultStamp = '', returnFocus = null, resume = null;
  const replies = () => {
    const messages = getMessages(getContext().sessionId) || [], result = [];
    for (let i = messages.length - 1; i >= 0 && result.length < 20; i--) if (isAgentToolReply(messages[i])) result.push(messages[i]);
    return result;
  };
  const runs = () => [...(actions.listInputAgentRuns?.() || []), ...(actions.listTextEditRuns?.() || []), ...(actions.listFormatRepairRuns?.() || [])]
    .filter(job => sameContext(job.context, getContext()));
  const currentConfig = () => { const config = catalog.find(config => config.id === selectedId);
    return config?.kind === 'format_review' && repairProfileId ? resolveFormatRepairProfile(config, repairProfileId) : config; };
  const jobFor = (id, jobs = runs()) => jobs.find(job => job.id === selectedRunId && job.agentId === id)
    || jobs.filter(job => job.agentId === id && (!job.repairProfileId || job.repairProfileId === repairProfileId) && pendingStates.has(job.status)).at(-1)
    || jobs.filter(job => job.agentId === id && (isInputAgent(catalog.find(config => config.id === id))
      ? job.revision === inputTarget?.revision : job.messageId === target?.messageId && (!job.repairProfileId || job.repairProfileId === repairProfileId))).at(-1);
  const formatPicker = createFormatRepairPicker({ root: targetEventRoot, getMessages, getContext, documentRef: doc,
    onChoose: messageId => { target = { messageId }; selectedRunId = ''; selectionSnapshot = null; rawRange = null; rawSource = ''; void prepare(); } });
  const stopFormatPick = () => { if (formatPicker.active) { formatPicker.stop(); controller?.cancel?.(); } };
  const readCatalog = () => {
    catalog = (actions.listAgentConfigurations({ context: getContext() }) || []).map(record => record.config).filter(Boolean);
    const next = reconcileToolboxPreferences(prefs, catalog, getContext());
    if (JSON.stringify(next) !== JSON.stringify(prefs)) { prefs = next; savePrefs(); }
    items = getToolboxItems(prefs, catalog, getContext());
  };
  const visibleWidth = () => Math.max(180, Math.min(396, (win.visualViewport?.width || win.innerWidth) - 24));
  const place = () => {
    if (panel.hidden) return;
    const vv = win.visualViewport, left = vv?.offsetLeft || 0, top = vv?.offsetTop || 0;
    const width = vv?.width || win.innerWidth, height = vv?.height || win.innerHeight, r = entryAnchor.getBoundingClientRect();
    panel.style.width = `${visibleWidth()}px`;
    const available = Math.max(100, Math.min(height - 24, r.top - top - 12));
    panel.style.maxHeight = `${Math.max(100, height - 24)}px`;
    card.style.maxHeight = `${Math.max(90, available - shelf.offsetHeight - inbox.offsetHeight - (notice.hidden ? 0 : notice.offsetHeight + 8) - 20)}px`;
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(left + 12, Math.min(left + width - box.width - 12, r.left))}px`;
    panel.style.top = `${Math.max(top + 12, Math.min(top + height - box.height - 12, r.top - box.height - 8))}px`;
    view.positionTooltips();
  };
  const tell = message => {
    notice.hidden = !message;
    notice.innerHTML = message ? `<span>${e(t(message))}</span>${button('dismiss-notice', '关闭', { icon: 'close' })}` : '';
    place();
  };
  const cancelPick = (restore = false) => {
    if (!picking) return;
    picking = false; controller?.cancel?.(); shelf.hidden = false; notice.hidden = true;
    if (restore) { mode = 'task'; mountCard(); render(); }
  };
  const close = () => {
    epoch++; cancelPick(); stopFormatPick(); panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); recording = false; ordering = false;
    panel.classList.remove('is-entering');
  };
  const focusShelf = id => (nodes.get(id) || panel.querySelector('[data-key=manage]'))?.focus({ preventScroll: true });
  const hideCard = () => {
    epoch++; stopFormatPick(); mode = 'shelf'; recording = false; ordering = false; preparing = false; notice.hidden = true;
    render();
  };
  const back = ({ dryRun = false } = {}) => {
    if (panel.hidden) return false;
    if (formatPicker.rawOpen) return false;
    if (dryRun) return true;
    if (picking) { cancelPick(true); return true; }
    if (recording || ordering) { recording = false; ordering = false; render(); return true; }
    if (mode !== 'shelf') { hideCard(); focusShelf(selectedId); }
    else { close(); (returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : entryAnchor).focus({ preventScroll: true }); }
    return true;
  };
  const mountCard = () => {
    cardStamp = ''; resultStamp = '';
    const config = currentConfig();
    if (mode === 'task' && config) {
      card.innerHTML = `<div class="at-card-head"><div class="at-card-heading">${toolboxNamedIcon(config)}<strong data-i18n-skip>${e(config.kind === 'format_review' ? config.repairProfileName || config.title : config.title)}</strong></div>${button(`config:${config.id}`, '配置', { icon: 'settings' })}</div>
        <div class="at-scope"></div><div class="at-target"></div><p class="at-status" data-target-status role="status"></p><div class="at-run-actions"></div><div class="at-result" hidden></div>`;
    }
  };
  const renderRepairProfiles = () => {
    const config = currentConfig(), profiles = config?.repairProfiles?.items || [];
    const stamp = JSON.stringify(['profiles', profiles.map(item => [item.id, item.name]), config?.enabled]);
    if (cardStamp === stamp) return; cardStamp = stamp;
    card.innerHTML = `<div class="at-card-head"><div class="at-card-heading">${toolboxNamedIcon(config)}<strong>${e(t('格式修复'))}</strong></div>${button('new-repair', '新建方案', { icon: 'plus' })}</div>
      <div class="at-repair-profiles">${profiles.map(item => `<div class="at-repair-profile"><button type="button" data-key="repair:${e(item.id)}"><span data-i18n-skip>${e(item.name)}</span><span aria-hidden="true">›</span></button>${button(`repair-config:${item.id}`, '配置方案', { icon: 'settings' })}</div>`).join('') || `<p class="at-status">${e(t('保存一个修复方案，即可在这里使用。'))}</p>${button('new-repair', '新建方案', { primary: true })}`}</div>`;
  };
  const renderRepairTarget = config => {
    const frozen = prepared?.snapshot, selection = frozen?.formatSelection, job = jobFor(config.id), locked = pendingStates.has(job?.status);
    const label = selection?.fragment ? '已选原文片段' : target?.messageId ? '完整回复' : '选择一条回复';
    const source = selection?.text || frozen?.formatTarget?.sourceText || '';
    const stamp = JSON.stringify([preparing, prepared?.ok, prepared?.message, target?.messageId, label, source, locked, selection?.count]);
    if (stamp !== cardStamp) {
      cardStamp = stamp;
      card.querySelector('.at-scope').innerHTML = `<strong>${e(t(label))}</strong><span class="at-count">${selection?.ok ? e(selection.checkType === 'tableEdit' ? `tableEdit · ${selection.count}` : t('{count} 字', { count: Array.from(source).length })) : ''}</span>${button('repair-profiles', '更换方案', { disabled: locked })}`;
      card.querySelector('.at-target').innerHTML = `${source ? `<p class="at-target-excerpt" data-i18n-skip>${e(source.slice(0, 160))}${source.length > 160 ? '…' : ''}</p>` : `<p class="at-status">${e(t('点选气泡检查完整回复，或选择其中的文字。'))}</p>`}
        ${frozen?.formatTarget?.sourceMessageIds?.length > 1 && !selection?.fragment ? `<p class="at-status">${e(t('同一轮的 {count} 个气泡将一起检查', { count: frozen.formatTarget.sourceMessageIds.length }))}</p>` : ''}
        <div class="at-target-actions">${button('repair-raw', '查看原文 / 选取', { disabled: locked || !source || preparing })}${selection?.fragment ? button('repair-whole', '完整回复', { disabled: locked }) : ''}${button('repair-cancel', '取消选择', { disabled: locked })}</div>`;
    }
    const why = preparing ? '正在提取处理范围…' : !config.enabled ? '此 Agent 已关闭，可在配置中开启' : !allowsAgentInvocation(config, 'manual') ? '此 Agent 仅自动执行，可在配置中调整调用方式'
      : config.modelMode === 'none' ? '此方案尚未选择可用模型' : target?.messageId && !prepared?.ok ? prepared?.message || '请重新选择回复' : '';
    card.querySelector('[data-target-status]').textContent = t(why);
    const markup = locked ? '' : button('execute', '检查格式', { primary: true, disabled: Boolean(why) || !prepared?.ok || invoking.has(config.id) });
    const host = card.querySelector('.at-run-actions'); if (host.innerHTML !== markup) host.innerHTML = markup;
  };
  const renderTarget = config => {
    if (config.kind === 'format_review') { renderRepairTarget(config); return; }
    const job = jobFor(config.id), frozen = prepared?.snapshot, locked = pendingStates.has(job?.status);
    const inputTool = isInputAgent(config), selected = frozen?.selected || selectionSnapshot?.selected;
    const preview = inputTool ? inputTarget?.text || '' : frozen?.target?.text || '';
    const previewText = inputTool && inputTarget?.end > inputTarget?.start ? preview.slice(inputTarget.start, inputTarget.end) : preview;
    const scopeLabel = inputTool ? inputTarget?.end > inputTarget?.start ? '已选草稿文字' : '当前草稿'
      : selected ? '已选文字' : sourceHint(config, frozen);
    const stamp = JSON.stringify([preparing, prepared?.ok, prepared?.message, target?.messageId, preview, previewText, scopeLabel, locked, Boolean(selectionSnapshot)]);
    if (stamp !== cardStamp) {
      cardStamp = stamp;
      card.querySelector('.at-scope').innerHTML = `<strong>${e(t(scopeLabel))}</strong><span class="at-count">${previewText ? e(t('{count} 字', { count: Array.from(previewText).length })) : ''}</span>${button('refresh-target', inputTool ? '更新草稿' : '更新处理对象', { icon: 'refresh', disabled: locked || preparing })}`;
      const availableReplies = replies(), currentMessage = availableReplies.find(message => message.id === target?.messageId);
      const picker = !inputTool ? `<select data-key="target" ${locked ? 'disabled' : ''} aria-label="${e(t('处理对象'))}">${!currentMessage ? `<option value="${e(target?.messageId || '')}">${e(t('暂无可处理的回复'))}</option>` : ''}${availableReplies.map((message, index) => `<option value="${e(message.id)}" ${message.id === target?.messageId ? 'selected' : ''}>${e(t(index ? '历史回复' : '最近回复'))} · ${e(String(message.content || '').replace(/<[^>]*>/g, '').slice(0, 36))}</option>`).join('')}</select>` : '';
      const excerpt = previewText;
      const targetHost = card.querySelector('.at-target'), opened = targetHost.querySelector('details')?.open;
      targetHost.innerHTML = `${picker}${preparing ? `<p class="at-status">${e(t('正在提取处理范围…'))}</p>` : previewText ? `<p class="at-target-excerpt" data-i18n-skip>${e(excerpt.slice(0, 160))}${excerpt.length > 160 ? '…' : ''}</p><details${opened ? ' open' : ''}><summary>${e(t('查看处理内容'))}</summary><pre class="at-target-summary" data-i18n-skip tabindex="0">${e(previewText.slice(0, 6000))}${previewText.length > 6000 ? '\n…' : ''}</pre></details>` : ''}
        <div class="at-target-actions">${!inputTool ? button('pick', '选择文字', { disabled: locked || !controller }) : ''}${selected ? button('clear-selection', '使用配置范围', { disabled: locked }) : ''}</div>`;
    }
    const why = preparing ? '正在提取处理范围…' : invoking.has(config.id) && !locked ? '处理中' : !config.enabled ? '此 Agent 已关闭，可在配置中开启' : !allowsAgentInvocation(config, 'manual') ? '此 Agent 仅自动执行，可在配置中调整调用方式' : !prepared?.ok && !inputTool ? prepared?.message || '暂无可处理的回复' : inputTool && !inputTarget?.text?.trim() ? '请先在输入框填写内容' : '';
    card.querySelector('[data-target-status]').textContent = t(why);
    const canRun = !why && !locked, runHost = card.querySelector('.at-run-actions');
    const runMarkup = locked ? '' : button('execute', '运行一次', { primary: true, disabled: !canRun });
    if (runHost.innerHTML !== runMarkup) runHost.innerHTML = runMarkup;
  };
  const renderResult = (config, job) => {
    const host = card.querySelector('.at-result');
    const stamp = JSON.stringify([job?.id, job?.status, job?.text, job?.message, Boolean(job?.trace?.steps?.length)]);
    if (stamp === resultStamp) return;
    resultStamp = stamp; host.hidden = !job; if (!job) return;
    const inputJob = job.id.startsWith('input-run'), resultText = job.text || job.message || '';
    host.innerHTML = `<div class="at-status" role="status">${e(t(labels[job.status] || '待查看'))}${job.messageId && job.messageId !== target?.messageId ? ` · ${e(t('来自先前选择的回复'))}` : ''}</div>${resultText ? `<pre data-i18n-skip tabindex="0">${e(resultText)}</pre>` : ''}<div class="at-result-actions">
      ${job.status === 'running' ? button(`cancel:${job.id}`, '取消') : ''}
      ${job.status === 'failed' && job.id.startsWith('format-tool-run-') ? button(`ignore:${job.id}`, '收起结果') : ''}
      ${job.status === 'ready' ? isNote(job) ? button(`copy:${job.id}`, '复制结果') + button(`ignore:${job.id}`, '收起结果') : inputJob ? button(`apply:${job.id}`, job.kind === 'rewrite' ? '查看修改' : '采纳') + button(`ignore:${job.id}`, '收起结果') : button(`review:${job.id}`, '查看修改') + button(`ignore:${job.id}`, '收起结果') : ''}
      ${job.trace?.steps?.length ? button(`process:${job.id}`, '执行过程') : ''}</div>`;
  };
  const renderManagement = () => {
    const stamp = JSON.stringify([mode, catalog, items.map(config => config.id), prefs.shortcut, recording, shortcutError, ordering]);
    if (cardStamp === stamp) return;
    cardStamp = stamp;
    const focusedKey = card.contains(doc.activeElement) ? doc.activeElement.dataset.key : '', scrollTop = card.scrollTop;
    const expanded = card.querySelector('.at-hidden-tools')?.open;
    card.innerHTML = toolboxManagementMarkup({ items, catalog, ordering, shortcut: prefs.shortcut, recording, shortcutError, expanded });
    card.scrollTop = scrollTop;
    if (focusedKey) {
      const control = [...card.querySelectorAll('[data-key]')].find(node => node.dataset.key === focusedKey);
      const rowId = /^(?:up|down):(.+)$/.exec(focusedKey)?.[1];
      const fallback = rowId ? [...card.querySelectorAll('.at-config')].find(node => node.dataset.key === `config:${rowId}`)
        : card.querySelector(focusedKey.startsWith('visible:') ? '.at-hidden-tools>summary' : focusedKey.includes('shortcut') ? '[data-key=shortcut]' : '[data-key=sort]');
      const focusTarget = control?.getClientRects().length && !control.disabled ? control : fallback;
      focusTarget?.focus({ preventScroll: true });
    }
  };
  const render = () => {
    if (disposed) return;
    const jobs = runs(), ready = jobs.filter(job => job.status === 'ready' || job.unread).length;
    const badge = trigger.querySelector('small'); badge.hidden = !ready; badge.textContent = String(ready);
    trigger.hidden = !['chat', 'writing'].includes(getContext().place) || !getContext().sessionId;
    view.badge.hidden = !ready || trigger.hidden;
    trigger.setAttribute('aria-label', ready ? `${t('Agent 工具箱')} · ${t('待查看')} ${ready}` : t('Agent 工具箱'));
    if (panel.hidden) return;
    if (!sameContext(context, getContext()) || trigger.hidden) { close(); return; }
    const count = toolboxVisibleCount(visibleWidth(), items.length), visible = items.slice(0, count);
    for (const [id, node] of nodes) if (!visible.some(config => config.id === id)) { node.remove(); nodes.delete(id); }
    for (const [index, config] of visible.entries()) {
      let node = nodes.get(config.id);
      if (!node) { node = doc.createElement('button'); node.type = 'button'; node.className = 'at-tool'; node.dataset.key = `tool:${config.id}`;
        node.innerHTML = `${agentIconMarkup(getAgentIconName(config))}<span class="at-tool-state" aria-hidden="true"></span><span class="at-tooltip" aria-hidden="true"></span>`; nodes.set(config.id, node); }
      const iconName = getAgentIconName(config); if (node.dataset.icon !== iconName) { node.querySelector('svg').outerHTML = agentIconMarkup(iconName); node.dataset.icon = iconName; }
      if (icons.children[index] !== node) icons.insertBefore(node, icons.children[index] || null);
      const job = jobs.filter(item => item.agentId === config.id && (pendingStates.has(item.status) || item.unread)).at(-1);
      const toggle = isAgentToolToggle(config), state = job?.status || (config.enabled ? 'enabled' : 'disabled');
      node.dataset.status = state; node.dataset.enabled = String(config.enabled); node.disabled = toggling.has(config.id);
      node.toggleAttribute('aria-pressed', toggle); if (toggle) node.setAttribute('aria-pressed', String(config.enabled));
      node.toggleAttribute('aria-expanded', !toggle); if (!toggle) node.setAttribute('aria-expanded', String(['task', 'profiles'].includes(mode) && selectedId === config.id));
      const text = `${config.title} · ${t(job ? labels[job.status] || '待查看' : toggle ? config.enabled ? '点击关闭' : '点击开启' : '查看工具')}`;
      node.setAttribute('aria-label', text); node.querySelector('.at-tooltip').textContent = text;
      node.querySelector('.at-tool-state').textContent = job?.status === 'running' ? '…' : job?.status === 'ready' || job?.unread ? '1' : toggle ? config.enabled ? '✓' : '−' : '';
      node.querySelector('.at-tool-state').hidden = !node.querySelector('.at-tool-state').textContent;
    }
    panel.querySelector('[data-key=more]').hidden = items.length <= count;
    panel.querySelector('[data-key=more]').setAttribute('aria-expanded', String(mode === 'more'));
    panel.querySelector('[data-key=manage]').setAttribute('aria-expanded', String(mode === 'manage'));
    const activeJobs = jobs.filter(job => pendingStates.has(job.status) || job.unread);
    inbox.hidden = picking || (!activeJobs.length && mode !== 'runs');
    const inboxLabel = ready ? t('{count} 个结果待查看', { count: ready }) : activeJobs.length ? t('{count} 个任务处理中', { count: activeJobs.length }) : t('任务与结果');
    const inboxButton = inbox.querySelector('[data-key=runs]');
    if (inboxButton.textContent !== inboxLabel) inboxButton.textContent = inboxLabel;
    inboxButton.setAttribute('aria-expanded', String(mode === 'runs'));
    card.dataset.mode = mode;
    card.hidden = mode === 'shelf' || picking;
    if (!card.hidden) {
      if (mode === 'manage') renderManagement();
      else if (mode === 'profiles') renderRepairProfiles();
      else if (mode === 'runs') {
        const stamp = JSON.stringify([mode, activeJobs.map(job => [job.id, job.status, job.title])]);
        if (cardStamp !== stamp) { cardStamp = stamp; card.innerHTML = `<div class="at-card-head"><div class="at-card-heading"><strong>${e(t('任务与结果'))}</strong></div></div><div class="at-overflow">${activeJobs.map(job => `<button type="button" data-key="result:${e(job.id)}"><span class="at-result-entry" data-i18n-skip>${e(job.title || catalog.find(config => config.id === job.agentId)?.title || '')}</span><small>${e(t(labels[job.status] || '待查看'))}</small></button>`).join('') || `<p class="at-status">${e(t('暂无待查看的结果'))}</p>`}</div>`; }
      }
      else if (mode === 'more') {
        const stamp = JSON.stringify([mode, count, items, jobs.map(job => [job.id, job.status])]);
        if (cardStamp !== stamp) { cardStamp = stamp; card.innerHTML = `<div class="at-card-head"><div class="at-card-heading"><strong>${e(t('更多工具'))}</strong></div></div><div class="at-overflow">${items.slice(count).map(config => `<button type="button" data-key="tool:${e(config.id)}">${toolboxNamedIcon(config)}<span data-i18n-skip>${e(config.title)}</span><small>${e(t(config.enabled ? '已开启' : '已关闭'))}</small></button>`).join('')}</div>`; }
      } else {
        const config = currentConfig();
        if (!config) { mode = 'shelf'; card.hidden = true; } else { if (!card.querySelector('.at-target')) mountCard(); renderTarget(config); renderResult(config, jobFor(config.id, jobs)); }
      }
    }
    const showLegend = !picking && mode === 'shelf' && !prefs.legendDismissed && (win.matchMedia('(pointer:coarse)').matches || win.innerWidth <= 600);
    legend.hidden = !showLegend;
    if (showLegend) {
      const markup = `${button('dismiss-legend', '关闭', { icon: 'close' })}<p>${e(t('点图标使用工具，齿轮管理快捷栏。'))}</p><div class="at-legend-list">${items.slice(0, count).map(config => `<span data-i18n-skip>${agentIconMarkup(getAgentIconName(config))}${e(config.title)}</span>`).join('')}</div>`;
      if (legend.innerHTML !== markup) legend.innerHTML = markup;
    }
    if (!items.length && mode === 'shelf' && !picking) { notice.hidden = false; notice.innerHTML = `<span>${e(t('还没有快捷工具'))}</span>${button('center', '添加工具')}`; }
    place();
  };
  const refresh = () => { readCatalog(); win.cancelAnimationFrame(frame); frame = win.requestAnimationFrame(render); };
  const refreshStatus = () => { win.cancelAnimationFrame(frame); frame = win.requestAnimationFrame(render); };
  const prepare = async () => {
    const config = currentConfig(); if (!config || mode !== 'task') return;
    if (config.kind === 'format_review' && !target?.messageId) { prepared = null; preparing = false; render(); return; }
    const version = ++epoch; prepared = null; preparing = true; render();
    try {
      const result = isInputAgent(config) ? { ok: true } : await actions.prepareAgentToolTarget({ id: config.id, context: { ...context }, messageId: target?.messageId,
        selectionSnapshot: selectionSnapshot || undefined, repairProfileId, rawRange, rawSource });
      if (disposed || version !== epoch || !sameContext(context, getContext())) return;
      prepared = result; if (result?.ok && result.snapshot) target = { messageId: result.snapshot.messageId };
      if (config.kind === 'format_review') formatPicker.select(result?.snapshot?.formatTarget?.sourceMessageIds || []);
    } catch (error) { if (version === epoch) prepared = { ok: false, message: String(error.message || error) }; }
    finally { if (version === epoch) { preparing = false; render(); } }
  };
  const showTool = (id, runId = '') => {
    const config = catalog.find(item => item.id === id); if (!config) return;
    stopFormatPick();
    if (config.kind === 'format_review' && !runId) { selectedId = id; selectedRunId = ''; mode = 'profiles'; cardStamp = ''; preparing = false; epoch++; notice.hidden = true; render(); return; }
    selectedId = id; selectedRunId = ''; mode = 'task'; ordering = false; recording = false; notice.hidden = true; mountCard();
    const active = runs().find(job => job.id === runId) || runs().filter(job => job.agentId === id && pendingStates.has(job.status)).at(-1);
    if (active) { selectedRunId = active.id; if (active.repairProfileId) repairProfileId = active.repairProfileId; if (active.messageId) { target = { messageId: active.messageId }; if (selectionSnapshot?.messageId !== active.messageId) selectionSnapshot = null; } mountCard(); }
    if (!isInputAgent(config) && !target?.messageId) target = { messageId: replies()[0]?.id || '' };
    void prepare();
  };
  const chooseRepairProfile = id => {
    repairProfileId = id; selectedRunId = ''; mode = 'task'; prepared = null; cardStamp = ''; notice.hidden = true;
    formatPicker.start(); controller?.start?.({ format: true }); mountCard(); void prepare();
  };
  const open = (options = {}) => {
    context = { ...getContext() }; inputTarget = getInputSnapshot(); returnFocus = options.returnFocus || entryAnchor;
    readCatalog(); beforeOpen();
    const continuing = resume && sameContext(resume.context, context) && !options.selectionSnapshot && !options.messageId ? resume : null;
    resume = null;
    target = options.messageId ? { messageId: options.messageId } : continuing?.target || null;
    selectionSnapshot = options.selectionSnapshot || continuing?.selectionSnapshot || null;
    repairProfileId = continuing?.repairProfileId || ''; rawRange = continuing?.rawRange || null; rawSource = continuing?.rawSource || '';
    if (selectionSnapshot) target = { messageId: selectionSnapshot.messageId };
    mode = continuing?.mode === 'manage' ? 'manage' : 'shelf'; ordering = false; recording = false; selectedId = ''; selectedRunId = ''; prepared = null; preparing = false; notice.hidden = true;
    panel.hidden = false; shelf.hidden = false; trigger.setAttribute('aria-expanded', 'true'); panel.classList.add('is-entering');
    if (['task', 'profiles'].includes(continuing?.mode) && catalog.some(config => config.id === continuing.id)) {
      showTool(continuing.id); if (continuing.mode === 'task' && repairProfileId && currentConfig()?.kind === 'format_review') chooseRepairProfile(repairProfileId);
    } else render();
    const configControl = mode === 'manage' && [...card.querySelectorAll('.at-config')].find(node => node.dataset.key === `config:${continuing.id}` && node.getClientRects().length);
    if (configControl) configControl.focus({ preventScroll: true });
    else if (options.keyboard || triggerContainer?.contains(doc.activeElement)) focusShelf(items[0]?.id);
  };
  const toggle = async config => {
    if (toggling.has(config.id)) return;
    const frozen = { ...context }; toggling.add(config.id); render();
    try {
      const saved = actions.getAgentConfiguration({ id: config.id, context: frozen, scope: 'local' });
      const result = await actions.saveAgentConfiguration({ id: config.id, context: frozen, scope: 'local', revision: saved.revision,
        config: { ...saved.config, enabled: !saved.config.enabled, inputConsent: !saved.config.enabled || saved.config.inputConsent } });
      if (sameContext(frozen, getContext())) {
        readCatalog();
        if (result.ok) win.toastr?.info?.(t(saved.config.enabled ? '已关闭当前会话的输入建议' : '已开启当前会话的输入建议'));
        else win.toastr?.warning?.(t(result.message || '配置已变化，请重新打开'));
      }
    } catch (error) { if (sameContext(frozen, getContext())) win.toastr?.error?.(t(String(error.message || error))); }
    finally { toggling.delete(config.id); render(); }
  };
  const invoke = async () => {
    const config = currentConfig();
    if (!config || preparing || invoking.has(config.id) || !allowsAgentInvocation(config, 'manual') || !sameContext(context, getContext()) || !prepared?.ok) return;
    if (pendingStates.has(jobFor(config.id)?.status)) { render(); return; }
    const frozen = { ...context }, snapshot = prepared.snapshot, savedInput = inputTarget;
    invoking.add(config.id); render();
    try {
      let result;
      if (isInputAgent(config)) result = await actions.runConfiguredInputAgent({ id: config.id, context: frozen, inputTarget: savedInput });
      else if (config.kind === 'text_edit') result = await actions.runTextEditAgent({ id: config.id, context: frozen, messageId: snapshot.messageId, targetSnapshot: snapshot });
      else {
        stopFormatPick();
        result = await actions.runConfiguredFormatReview({ id: config.id, context: frozen, repairProfileId,
          messageId: snapshot.messageId, targetSnapshot: snapshot });
      }
      if (sameContext(frozen, getContext())) {
        if (result?.artifact?.runId) selectedRunId = result.artifact.runId;
        if (result?.status === 'failed' || result?.status === 'skipped') tell(result.reason || '未执行');
      }
    } catch (error) { if (sameContext(frozen, getContext())) tell(String(error.message || error)); }
    finally { invoking.delete(config.id); render(); }
  };
  const startPick = () => {
    if (!controller || !currentConfig() || pendingStates.has(jobFor(selectedId)?.status)) return;
    picking = true; card.hidden = true; shelf.hidden = true; legend.hidden = true; inbox.hidden = true;
    notice.hidden = false; notice.innerHTML = `<span>${e(t('在一条 AI 消息内选择文字，再点选区旁的工具箱。'))}</span>${button('cancel-pick', '取消')}`;
    controller.start?.(); place();
  };
  const useSelection = async options => {
    const frozen = { ...getContext() }, selection = await actions.captureAgentToolSelection({ ...options, context: frozen });
    if (!sameContext(frozen, getContext()) || disposed) return;
    const resumeId = picking || formatPicker.active ? selectedId : '';
    if (!selection.ok) { cancelPick(true); if (panel.hidden) open(); tell(selection.message || '选中文字无法对应原文'); return; }
    cancelPick();
    if (!resumeId) open({ selectionSnapshot: selection.snapshot, messageId: options.messageId, returnFocus: options.returnFocus });
    else { selectionSnapshot = selection.snapshot; target = { messageId: selection.snapshot.messageId }; rawRange = null; rawSource = ''; shelf.hidden = false;
      if (currentConfig()?.kind === 'format_review') chooseRepairProfile(repairProfileId); else showTool(resumeId); }
  };
  const configure = (id, options = {}) => {
    resume = { id, mode, context: { ...context }, target, selectionSnapshot, repairProfileId, rawRange, rawSource };
    const snapshot = prepared?.snapshot;
    close(); openAgent(id, { messageId: target?.messageId, context: { ...context },
      ...(id === 'reply_check' ? { repairProfileId, targetSnapshot: snapshot } : {}), ...options });
  };
  const listen = (node, type, callback, options) => { node?.addEventListener(type, callback, options); bindings.push(() => node?.removeEventListener(type, callback, options)); };
  listen(trigger, 'click', event => { event.preventDefault(); event.stopPropagation(); panel.hidden ? open({ keyboard: event.detail === 0 }) : close(); });
  listen(doc, 'pointerdown', event => { if (!picking && !formatPicker.active && !formatPicker.rawOpen && !panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(); });
  listen(input, 'focus', () => { if (formatPicker.active) close(); });
  listen(panel, 'change', event => {
    if (event.target.dataset.key !== 'target') return;
    target = { messageId: event.target.value }; selectionSnapshot = null; selectedRunId = ''; void prepare();
  });
  listen(panel, 'click', async event => {
    const control = event.target.closest('[data-key]'), key = control?.dataset.key; if (!key || control.disabled) return;
    try {
      if (key === 'close') close();
      else if (key === 'dismiss-notice') { notice.hidden = true; place(); }
      else if (key === 'dismiss-legend') { prefs.legendDismissed = true; savePrefs(); render(); }
      else if (key === 'manage' || key === 'more' || key === 'runs') {
        stopFormatPick();
        if (mode === key) hideCard();
        else { epoch++; preparing = false; ordering = false; recording = false; mode = key; cardStamp = ''; render(); }
        if (control.isConnected && control.getClientRects().length) control.focus({ preventScroll: true });
        else focusShelf(selectedId);
      }
      else if (key === 'center') { close(); openCenter(); }
      else if (key === 'execute') await invoke();
      else if (key === 'new-repair') configure('reply_check', { newRepairProfile: true, repairProfileId: '' });
      else if (key === 'repair-profiles' || key === 'repair-cancel') showTool('reply_check');
      else if (key === 'repair-whole') { selectionSnapshot = null; rawRange = null; rawSource = ''; selectedRunId = ''; void prepare(); }
      else if (key === 'repair-raw') {
        const snapshot = prepared?.snapshot, frozenContext = { ...context }, profile = repairProfileId;
        if (!snapshot?.formatTarget?.ok) return;
        const source = snapshot.formatTarget.sourceText;
        const selected = await formatPicker.showRaw({ source, range: snapshot.formatSelection?.fragment ? snapshot.formatSelection : null,
          checkType: currentConfig().repairCheckType, title: currentConfig().repairProfileName });
        if (selected && sameContext(frozenContext, getContext()) && profile === repairProfileId && !panel.hidden) {
          selectionSnapshot = null; rawSource = source; rawRange = selected.whole ? null : selected; selectedRunId = ''; void prepare();
        }
      }
      else if (key.startsWith('repair-config:')) configure('reply_check', { repairProfileId: key.slice(14) });
      else if (key.startsWith('repair:')) chooseRepairProfile(key.slice(7));
      else if (key === 'pick') startPick();
      else if (key === 'cancel-pick') cancelPick(true);
      else if (key === 'refresh-target' || key === 'clear-selection') {
        if (isInputAgent(currentConfig())) inputTarget = getInputSnapshot();
        else if (key === 'clear-selection') selectionSnapshot = null;
        else { selectionSnapshot = null; target = { messageId: target?.messageId || replies()[0]?.id || '' }; }
        selectedRunId = ''; void prepare();
      }
      else if (key === 'shortcut') { recording = true; shortcutError = ''; cardStamp = ''; render(); card.querySelector('[data-key=shortcut]')?.focus({ preventScroll: true }); }
      else if (key === 'cancel-shortcut') { recording = false; render(); card.querySelector('[data-key=shortcut]')?.focus({ preventScroll: true }); }
      else if (key === 'clear-shortcut') { prefs.shortcut = null; savePrefs(); cardStamp = ''; render(); }
      else if (key === 'sort') { ordering = !ordering; recording = false; render(); }
      else if (key.startsWith('tool:')) {
        const config = catalog.find(item => item.id === key.slice(5));
        if (config) {
          if (isAgentToolToggle(config)) await toggle(config);
          else if (['task', 'profiles'].includes(mode) && selectedId === config.id) { hideCard(); focusShelf(config.id); }
          else showTool(config.id);
        }
      }
      else if (key.startsWith('config:')) configure(key.slice(7));
      else if (key.startsWith('result:')) { const job = runs().find(item => item.id === key.slice(7)); if (job) showTool(job.agentId, job.id); }
      else if (key.startsWith('visible:')) { const id = key.slice(8); prefs = setToolboxItemVisible(prefs, id, !items.some(config => config.id === id), context); savePrefs(); readCatalog(); render(); }
      else if (key.startsWith('up:') || key.startsWith('down:')) {
        const id = key.slice(key.indexOf(':') + 1), order = items.map(config => config.id), i = order.indexOf(id), next = i + (key.startsWith('up:') ? -1 : 1);
        if (next >= 0 && next < order.length) { [order[i], order[next]] = [order[next], order[i]]; prefs.order = [...order, ...prefs.order.filter(value => !order.includes(value))]; savePrefs(); readCatalog(); render(); }
      }
      else {
        const id = key.slice(key.indexOf(':') + 1), job = runs().find(item => item.id === id); if (!job) return;
        const inputJob = id.startsWith('input-run'), formatJob = id.startsWith('format-tool-run-');
        if (key.startsWith('cancel:')) { if (formatJob) actions.cancelFormatRepairRun(id); else if (inputJob) actions.cancelInputAgentRun(id); else actions.cancelTextEditRun(id); render(); }
        else if (key.startsWith('ignore:')) { formatJob ? actions.ignoreFormatRepairRun(id) : inputJob ? actions.ignoreInputAgentRun(id) : actions.ignoreTextEditRun(id); render(); }
        else if (key.startsWith('apply:')) { close(); await actions.applyInputAgentRun(id); refreshStatus(); }
        else if (key.startsWith('review:')) { close(); await (formatJob ? actions.openFormatRepairRun(id) : actions.openTextEditRun(id)); refreshStatus(); }
        else if (key.startsWith('copy:')) { const frozen = { ...context }, copied = await clipboard.copyToClipboard(job.text); if (sameContext(frozen, getContext())) tell(copied ? '已复制' : '复制失败'); }
        else if (key.startsWith('process:')) configure(job.agentId);
      }
    } catch (error) { tell(String(error.message || error)); }
  });
  listen(doc, 'keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && !panel.hidden && !formatPicker.rawOpen) { event.preventDefault(); event.stopPropagation(); back(); return; }
    if (recording) {
      if (event.key === 'Tab') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat || ['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) return;
      if (!(event.ctrlKey || event.altKey || event.metaKey) || !event.code || ['Dead', 'Unidentified'].includes(event.key)) {
        shortcutError = '请按住 Ctrl、Alt 或 ⌘，再按另一个键。'; render(); return;
      }
      prefs.shortcut = { code: event.code, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, shift: event.shiftKey,
        label: [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.metaKey && 'Meta', event.shiftKey && 'Shift', event.key.toUpperCase()].filter(Boolean).join(' + ') };
      recording = false; savePrefs(); cardStamp = ''; render(); return;
    }
    const shortcut = prefs.shortcut;
    if (!event.repeat && shortcut && event.code === shortcut.code && event.ctrlKey === shortcut.ctrl && event.altKey === shortcut.alt && event.metaKey === shortcut.meta && event.shiftKey === shortcut.shift && !trigger.hidden) {
      event.preventDefault(); event.stopPropagation(); open({ keyboard: true });
    }
  }, true);
  listen(panel, 'keydown', event => {
    if (!event.target.closest('.at-shelf') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...shelf.querySelectorAll('button')].filter(node => !node.hidden && !node.disabled);
    const at = buttons.indexOf(doc.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
  });
  listen(panel, 'animationend', event => { if (event.target === panel) panel.classList.contains('is-entering') && panel.classList.remove('is-entering'); });
  listen(panel, 'toggle', place, true);
  listen(win, 'resize', refreshStatus); listen(win.visualViewport, 'resize', refreshStatus); listen(win.visualViewport, 'scroll', place);
  for (const name of ['agent-input-changed', 'agent-text-edit-changed', 'agent-format-repair-changed']) listen(win, name, refreshStatus);
  listen(win, 'agent-feature-settings-changed', () => {
    readCatalog();
    if (!panel.hidden && mode === 'task') {
      if (currentConfig()?.kind === 'format_review' && !currentConfig().repairProfiles.items.some(item => item.id === repairProfileId)) showTool('reply_check');
      else { mountCard(); void prepare(); }
    } else refreshStatus();
  });
  listen(win, 'session-changed', () => { close(); resume = null; selectionSnapshot = null; readCatalog();
    refreshStatus(); });
  const observer = new win.MutationObserver(() => { close(); resume = null; refresh(); });
  observer.observe(doc.body, { attributes: true, attributeFilter: ['data-ui-mode'] });
  const targetObserver = new win.MutationObserver(() => {
    if (panel.hidden || !prepared?.snapshot || targetFrame) return;
    targetFrame = win.requestAnimationFrame(() => {
      targetFrame = 0;
      if (prepared?.snapshot && actions.isAgentToolTargetCurrent?.(prepared.snapshot) === false) {
        prepared = { ok: false, message: '消息、回复分支或存档已变化，请重新选择文字' }; render();
      }
    });
  });
  if (targetEventRoot) targetObserver.observe(targetEventRoot, { childList: true, subtree: true, characterData: true });
  readCatalog(); render();
  return { open, close, back, refresh, trigger, panel, listRuns: runs, useSelection,
    openRun: (id, runId) => { open(); showTool(id, runId); },
    captureSelectionIdentity: messageId => actions.captureAgentToolSelectionIdentity?.({ messageId }),
    setSelectionController: value => { controller = value; },
    hasSelectionTools: () => catalog.some(config => !isInputAgent(config) && config.enabled),
    isFormatPicking: () => formatPicker.active,
    dispose: () => { close(); disposed = true; formatPicker.dispose(); win.cancelAnimationFrame(frame); win.cancelAnimationFrame(targetFrame); bindings.forEach(remove => remove()); observer.disconnect(); targetObserver.disconnect(); view.dispose(); },
  };
};
