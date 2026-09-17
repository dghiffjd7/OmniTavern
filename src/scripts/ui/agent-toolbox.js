import { t } from '../i18n/index.js';
import { allowsAgentInvocation, isInputAgent } from '../agent/agent-invocation.js';
import { agentIconMarkup, getAgentIconName } from '../agent/agent-icons.js';
import { agentToolContextKey, isAgentToolReply } from '../agent/agent-tool-targets.js';
import { createMessageClipboardUiRuntime } from './chat/message-clipboard-ui-utils.js';
import { createAgentToolboxView, toolboxEscape as e, toolboxButton as button, toolboxNamedIcon, toolboxManagementMarkup } from './agent-toolbox-view.js';
import { normalizeToolboxPreferences, reconcileToolboxPreferences, getToolboxItems, setToolboxItemVisible,
  isAgentToolToggle, toolboxVisibleCount } from './agent-toolbox-model.js';

const labels = { running:'处理中', ready:'待查看', reviewing:'正在查看', applied:'已应用', ignored:'已收起', failed:'失败', expired:'已过期', cancelled:'已取消', unchanged:'无需修改', succeeded:'已完成', skipped:'未执行' };
const pendingStates = new Set(['running', 'ready', 'reviewing']);
const isNote = job => job?.outputMode === 'note' || job?.kind === 'note';
const sameContext = (a, b) => agentToolContextKey(a) === agentToolContextKey(b);
const sourceHint = (config, snapshot) => snapshot?.targetMode === 'full' || config.target?.mode === 'full' ? '完整回复' : ['tags', 'regex'].includes(config.target?.mode) ? '指定部分' : '正文';

export const createAgentToolbox = ({ input, actions, getContext, getMessages, getInputSnapshot, openAgent, openCenter,
  openFormatResult = openCenter, triggerContainer, anchorEl, targetEventRoot, beforeOpen = () => {}, documentRef = document, storage = globalThis.localStorage } = {}) => {
  const doc = documentRef, win = doc.defaultView, bindings = [], nodes = new Map(), formatJobs = new Map(), toggling = new Set(), invoking = new Set();
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
  let frame = 0, targetFrame = 0, epoch = 0, disposed = false, cardStamp = '', resultStamp = '', returnFocus = null, resume = null;
  const replies = () => {
    const messages = getMessages(getContext().sessionId) || [], result = [];
    for (let i = messages.length - 1; i >= 0 && result.length < 20; i--) if (isAgentToolReply(messages[i])) result.push(messages[i]);
    return result;
  };
  const runs = () => [...(actions.listInputAgentRuns?.() || []), ...(actions.listTextEditRuns?.() || []), ...formatJobs.values()]
    .filter(job => sameContext(job.context, getContext()));
  const currentConfig = () => catalog.find(config => config.id === selectedId);
  const jobFor = (id, jobs = runs()) => jobs.find(job => job.id === selectedRunId && job.agentId === id)
    || jobs.filter(job => job.agentId === id && pendingStates.has(job.status)).at(-1)
    || jobs.filter(job => job.agentId === id && (isInputAgent(catalog.find(config => config.id === id))
      ? job.revision === inputTarget?.revision : job.messageId === target?.messageId)).at(-1);
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
    epoch++; cancelPick(); panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); recording = false; ordering = false;
    panel.classList.remove('is-entering');
  };
  const focusShelf = id => (nodes.get(id) || panel.querySelector('[data-key=manage]'))?.focus({ preventScroll: true });
  const back = ({ dryRun = false } = {}) => {
    if (panel.hidden) return false;
    if (dryRun) return true;
    if (picking) { cancelPick(true); return true; }
    if (recording || ordering) { recording = false; ordering = false; render(); return true; }
    if (mode !== 'shelf') { epoch++; mode = 'shelf'; recording = false; preparing = false; render(); focusShelf(selectedId); }
    else { close(); (returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : entryAnchor).focus({ preventScroll: true }); }
    return true;
  };
  const mountCard = () => {
    cardStamp = ''; resultStamp = '';
    const config = currentConfig();
    if (mode === 'task' && config) {
      card.innerHTML = `<div class="at-card-head">${button('back', '返回', { icon: 'back' })}<div class="at-card-heading">${toolboxNamedIcon(config)}<strong data-i18n-skip>${e(config.title)}</strong></div>${button(`config:${config.id}`, '配置', { icon: 'settings' })}</div>
        <div class="at-scope"></div><div class="at-target"></div><p class="at-status" data-target-status role="status"></p><div class="at-run-actions"></div><div class="at-result" hidden></div>`;
    }
  };
  const renderTarget = config => {
    const job = jobFor(config.id), frozen = prepared?.snapshot, locked = pendingStates.has(job?.status);
    const inputTool = isInputAgent(config), format = config.kind === 'format_review', selected = !format && (frozen?.selected || selectionSnapshot?.selected);
    const preview = inputTool ? inputTarget?.text || '' : frozen?.target?.text || '';
    const previewText = inputTool && inputTarget?.end > inputTarget?.start ? preview.slice(inputTarget.start, inputTarget.end) : preview;
    const scopeLabel = inputTool ? inputTarget?.end > inputTarget?.start ? '已选草稿文字' : '当前草稿'
      : format ? '整轮原始回复' : selected ? '已选文字' : sourceHint(config, frozen);
    const total = format ? frozen?.formatTarget?.sourceMessageIds?.length || 1 : 0;
    const stamp = JSON.stringify([preparing, prepared?.ok, prepared?.message, target?.messageId, preview, previewText, scopeLabel, total, locked, Boolean(selectionSnapshot)]);
    if (stamp !== cardStamp) {
      cardStamp = stamp;
      card.querySelector('.at-scope').innerHTML = `<strong>${e(t(scopeLabel))}</strong><span class="at-count">${total ? e(t('共 {count} 条消息', { count: total })) : previewText ? e(t('{count} 字', { count: Array.from(previewText).length })) : ''}</span>${button('refresh-target', inputTool ? '更新草稿' : '更新处理对象', { icon: 'refresh', disabled: locked || preparing })}`;
      const availableReplies = replies(), currentMessage = availableReplies.find(message => message.id === target?.messageId);
      const picker = !inputTool ? `<select data-key="target" ${locked ? 'disabled' : ''} aria-label="${e(t('处理对象'))}">${!currentMessage ? `<option value="${e(target?.messageId || '')}">${e(t('暂无可处理的回复'))}</option>` : ''}${availableReplies.map((message, index) => `<option value="${e(message.id)}" ${message.id === target?.messageId ? 'selected' : ''}>${e(t(index ? '历史回复' : '最近回复'))} · ${e(String(message.content || '').replace(/<[^>]*>/g, '').slice(0, 36))}</option>`).join('')}</select>` : '';
      const turnIds = format && frozen?.formatTarget?.sourceMessageIds;
      const excerpt = turnIds?.length ? (getMessages(context.sessionId) || []).filter(message => turnIds.includes(message.id))
        .map(message => String(message.content || '').replace(/<[^>]*>/g, '')).join('\n') : previewText;
      const targetHost = card.querySelector('.at-target'), opened = targetHost.querySelector('details')?.open;
      targetHost.innerHTML = `${picker}${preparing ? `<p class="at-status">${e(t('正在提取处理范围…'))}</p>` : previewText ? `<p class="at-target-excerpt" data-i18n-skip>${e(excerpt.slice(0, 160))}${excerpt.length > 160 ? '…' : ''}</p><details${opened ? ' open' : ''}><summary>${e(t('查看处理内容'))}</summary><pre class="at-target-summary" data-i18n-skip tabindex="0">${e(previewText.slice(0, 6000))}${previewText.length > 6000 ? '\n…' : ''}</pre></details>` : ''}
        ${format && selectionSnapshot ? `<p class="at-status">${e(t('选区用于定位回复，格式检查会处理整轮。'))}</p>` : ''}
        <div class="at-target-actions">${!inputTool && !format ? button('pick', '选择文字', { disabled: locked || !controller }) : ''}${selected || selectionSnapshot && !format ? button('clear-selection', '使用配置范围', { disabled: locked }) : ''}</div>`;
    }
    const why = preparing ? '正在提取处理范围…' : invoking.has(config.id) && !locked ? '处理中' : !config.enabled ? '此 Agent 已关闭，可在配置中开启' : !allowsAgentInvocation(config, 'manual') ? '此 Agent 仅自动执行，可在配置中调整调用方式' : !prepared?.ok && !inputTool ? prepared?.message || '暂无可处理的回复' : inputTool && !inputTarget?.text?.trim() ? '请先在输入框填写内容' : '';
    card.querySelector('[data-target-status]').textContent = t(why);
    const canRun = !why && !locked, runHost = card.querySelector('.at-run-actions');
    const runMarkup = locked ? '' : button('execute', format ? '检查格式' : '运行一次', { primary: true, disabled: !canRun });
    if (runHost.innerHTML !== runMarkup) runHost.innerHTML = runMarkup;
  };
  const renderResult = (config, job) => {
    const host = card.querySelector('.at-result');
    const stamp = JSON.stringify([job?.id, job?.status, job?.text, job?.message, Boolean(job?.trace?.steps?.length)]);
    if (stamp === resultStamp) return;
    resultStamp = stamp; host.hidden = !job; if (!job) return;
    const inputJob = job.id.startsWith('input-run'), formatJob = formatJobs.has(job.id), resultText = job.text || job.message || '';
    host.innerHTML = `<div class="at-status" role="status">${e(t(labels[job.status] || '待查看'))}${job.messageId && job.messageId !== target?.messageId ? ` · ${e(t('来自先前选择的回复'))}` : ''}</div>${resultText ? `<pre data-i18n-skip tabindex="0">${e(resultText)}</pre>` : ''}<div class="at-result-actions">
      ${job.status === 'running' ? button(`cancel:${job.id}`, '取消') : ''}
      ${job.status === 'ready' ? isNote(job) ? button(`copy:${job.id}`, '复制结果') + button(`ignore:${job.id}`, '收起结果') : inputJob ? button(`apply:${job.id}`, job.kind === 'rewrite' ? '查看修改' : '采纳') + button(`ignore:${job.id}`, '收起结果') : button(`review:${job.id}`, '查看修改') + button(`ignore:${job.id}`, '收起结果') : ''}
      ${formatJob && job.status === 'succeeded' ? button('format-result', '查看结果') : ''}
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
    const jobs = runs(), ready = jobs.filter(job => job.status === 'ready' || formatJobs.has(job.id) && job.unread).length;
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
      node.toggleAttribute('aria-expanded', !toggle); if (!toggle) node.setAttribute('aria-expanded', String(mode === 'task' && selectedId === config.id));
      const text = `${config.title} · ${t(job ? labels[job.status] || '待查看' : toggle ? config.enabled ? '点击关闭' : '点击开启' : '查看工具')}`;
      node.setAttribute('aria-label', text); node.querySelector('.at-tooltip').textContent = text;
      node.querySelector('.at-tool-state').textContent = job?.status === 'running' ? '…' : job?.status === 'ready' || job?.unread ? '1' : toggle ? config.enabled ? '✓' : '−' : '';
      node.querySelector('.at-tool-state').hidden = !node.querySelector('.at-tool-state').textContent;
    }
    panel.querySelector('[data-key=more]').hidden = items.length <= count;
    panel.querySelector('[data-key=more]').setAttribute('aria-expanded', String(mode === 'more'));
    panel.querySelector('[data-key=manage]').setAttribute('aria-expanded', String(mode === 'manage'));
    const activeJobs = jobs.filter(job => pendingStates.has(job.status) || job.unread);
    inbox.hidden = picking || !activeJobs.length || mode === 'runs';
    const inboxMarkup = button('runs', ready ? t('{count} 个结果待查看', { count: ready }) : t('{count} 个任务处理中', { count: activeJobs.length }));
    if (inbox.innerHTML !== inboxMarkup) inbox.innerHTML = inboxMarkup;
    card.dataset.mode = mode;
    card.hidden = mode === 'shelf' || picking;
    if (!card.hidden) {
      if (mode === 'manage') renderManagement();
      else if (mode === 'runs') {
        const stamp = JSON.stringify([mode, activeJobs.map(job => [job.id, job.status, job.title])]);
        if (cardStamp !== stamp) { cardStamp = stamp; card.innerHTML = `<div class="at-card-head">${button('back', '返回', { icon: 'back' })}<div class="at-card-heading"><strong>${e(t('任务与结果'))}</strong></div></div><div class="at-overflow">${activeJobs.map(job => `<button type="button" data-key="result:${e(job.id)}"><span class="at-result-entry" data-i18n-skip>${e(job.title || catalog.find(config => config.id === job.agentId)?.title || '')}</span><small>${e(t(labels[job.status] || '待查看'))}</small></button>`).join('') || `<p class="at-status">${e(t('暂无待查看的结果'))}</p>`}</div>`; }
      }
      else if (mode === 'more') {
        const stamp = JSON.stringify([mode, count, items, jobs.map(job => [job.id, job.status])]);
        if (cardStamp !== stamp) { cardStamp = stamp; card.innerHTML = `<div class="at-card-head">${button('back', '返回', { icon: 'back' })}<div class="at-card-heading"><strong>${e(t('更多工具'))}</strong></div></div><div class="at-overflow">${items.slice(count).map(config => `<button type="button" data-key="tool:${e(config.id)}">${toolboxNamedIcon(config)}<span data-i18n-skip>${e(config.title)}</span><small>${e(t(config.enabled ? '已开启' : '已关闭'))}</small></button>`).join('')}</div>`; }
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
    const version = ++epoch; prepared = null; preparing = true; render();
    try {
      const result = isInputAgent(config) ? { ok: true } : await actions.prepareAgentToolTarget({ id: config.id, context: { ...context }, messageId: target?.messageId,
        selectionSnapshot: selectionSnapshot || undefined });
      if (disposed || version !== epoch || !sameContext(context, getContext())) return;
      prepared = result; if (result?.ok && result.snapshot) target = { messageId: result.snapshot.messageId };
    } catch (error) { if (version === epoch) prepared = { ok: false, message: String(error.message || error) }; }
    finally { if (version === epoch) { preparing = false; render(); } }
  };
  const showTool = (id, runId = '') => {
    const config = catalog.find(item => item.id === id); if (!config) return;
    selectedId = id; selectedRunId = ''; mode = 'task'; ordering = false; recording = false; notice.hidden = true; mountCard();
    const active = runs().find(job => job.id === runId) || runs().filter(job => job.agentId === id && pendingStates.has(job.status)).at(-1);
    if (active) { selectedRunId = active.id; if (active.messageId) { target = { messageId: active.messageId }; if (selectionSnapshot?.messageId !== active.messageId) selectionSnapshot = null; } }
    if (!isInputAgent(config) && !target?.messageId) target = { messageId: replies()[0]?.id || '' };
    void prepare();
  };
  const open = (options = {}) => {
    context = { ...getContext() }; inputTarget = getInputSnapshot(); returnFocus = options.returnFocus || entryAnchor;
    readCatalog(); beforeOpen();
    const continuing = resume && sameContext(resume.context, context) && !options.selectionSnapshot && !options.messageId ? resume : null;
    resume = null;
    target = options.messageId ? { messageId: options.messageId } : continuing?.target || null;
    selectionSnapshot = options.selectionSnapshot || continuing?.selectionSnapshot || null;
    if (selectionSnapshot) target = { messageId: selectionSnapshot.messageId };
    mode = continuing?.mode === 'manage' ? 'manage' : 'shelf'; ordering = false; recording = false; selectedId = ''; selectedRunId = ''; prepared = null; preparing = false; notice.hidden = true;
    panel.hidden = false; shelf.hidden = false; trigger.setAttribute('aria-expanded', 'true'); panel.classList.add('is-entering');
    if (continuing?.mode === 'task' && catalog.some(config => config.id === continuing.id)) showTool(continuing.id); else render();
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
        const abort = new AbortController(), id = `tool-format:${Date.now()}:${formatJobs.size}`;
        const job = { id, agentId: config.id, title: config.title, context: frozen, messageId: snapshot.messageId, status: 'running', controller: abort };
        formatJobs.set(id, job); selectedRunId = id; render();
        try { result = await actions.runConfiguredFormatReview({ id: config.id, context: frozen, messageId: snapshot.messageId, targetSnapshot: snapshot, signal: abort.signal });
          job.status = abort.signal.aborted ? 'cancelled' : result.status; job.message = result.error || ''; job.unread = job.status === 'succeeded'; }
        catch (error) { job.status = 'failed'; job.message = String(error.message || error); throw error; }
        while (formatJobs.size > 20) { const old = [...formatJobs.values()].find(item => item.status !== 'running'); if (!old) break; formatJobs.delete(old.id); }
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
    const resumeId = picking ? selectedId : '';
    if (!selection.ok) { cancelPick(true); if (panel.hidden) open(); tell(selection.message || '选中文字无法对应原文'); return; }
    cancelPick();
    if (!resumeId) open({ selectionSnapshot: selection.snapshot, messageId: options.messageId, returnFocus: options.returnFocus });
    else { selectionSnapshot = selection.snapshot; target = { messageId: selection.snapshot.messageId }; shelf.hidden = false; showTool(resumeId); }
  };
  const configure = id => {
    resume = { id, mode, context: { ...context }, target, selectionSnapshot };
    close(); openAgent(id, { messageId: target?.messageId, context: { ...context } });
  };
  const listen = (node, type, callback, options) => { node?.addEventListener(type, callback, options); bindings.push(() => node?.removeEventListener(type, callback, options)); };
  listen(trigger, 'click', event => { event.preventDefault(); event.stopPropagation(); panel.hidden ? open({ keyboard: event.detail === 0 }) : close(); });
  listen(doc, 'pointerdown', event => { if (!picking && !panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(); });
  listen(panel, 'change', event => {
    if (event.target.dataset.key !== 'target') return;
    target = { messageId: event.target.value }; selectionSnapshot = null; selectedRunId = ''; void prepare();
  });
  listen(panel, 'click', async event => {
    const control = event.target.closest('[data-key]'), key = control?.dataset.key; if (!key || control.disabled) return;
    try {
      if (key === 'close') close();
      else if (key === 'back') back();
      else if (key === 'dismiss-notice') { notice.hidden = true; place(); }
      else if (key === 'dismiss-legend') { prefs.legendDismissed = true; savePrefs(); render(); }
      else if (key === 'manage' || key === 'more' || key === 'runs') { epoch++; preparing = false; ordering = false; recording = false; mode = key; cardStamp = ''; render(); card.querySelector('button')?.focus({ preventScroll: true }); }
      else if (key === 'center') { close(); openCenter(); }
      else if (key === 'execute') await invoke();
      else if (key === 'pick') startPick();
      else if (key === 'cancel-pick') cancelPick(true);
      else if (key === 'refresh-target' || key === 'clear-selection') {
        if (isInputAgent(currentConfig())) inputTarget = getInputSnapshot();
        else if (key === 'clear-selection') selectionSnapshot = null;
        else { selectionSnapshot = null; target = { messageId: target?.messageId || replies()[0]?.id || '' }; }
        selectedRunId = ''; void prepare();
      }
      else if (key === 'format-result') { const job = jobFor(selectedId); if (job) job.unread = false; close(); openFormatResult(target?.messageId); refreshStatus(); }
      else if (key === 'shortcut') { recording = true; shortcutError = ''; cardStamp = ''; render(); card.querySelector('[data-key=shortcut]')?.focus({ preventScroll: true }); }
      else if (key === 'cancel-shortcut') { recording = false; render(); card.querySelector('[data-key=shortcut]')?.focus({ preventScroll: true }); }
      else if (key === 'clear-shortcut') { prefs.shortcut = null; savePrefs(); cardStamp = ''; render(); }
      else if (key === 'sort') { ordering = !ordering; recording = false; render(); }
      else if (key.startsWith('tool:')) { const config = catalog.find(item => item.id === key.slice(5)); if (config) isAgentToolToggle(config) ? await toggle(config) : showTool(config.id); }
      else if (key.startsWith('config:')) configure(key.slice(7));
      else if (key.startsWith('result:')) { const job = runs().find(item => item.id === key.slice(7)); if (job) showTool(job.agentId, job.id); }
      else if (key.startsWith('visible:')) { const id = key.slice(8); prefs = setToolboxItemVisible(prefs, id, !items.some(config => config.id === id), context); savePrefs(); readCatalog(); render(); }
      else if (key.startsWith('up:') || key.startsWith('down:')) {
        const id = key.slice(key.indexOf(':') + 1), order = items.map(config => config.id), i = order.indexOf(id), next = i + (key.startsWith('up:') ? -1 : 1);
        if (next >= 0 && next < order.length) { [order[i], order[next]] = [order[next], order[i]]; prefs.order = [...order, ...prefs.order.filter(value => !order.includes(value))]; savePrefs(); readCatalog(); render(); }
      }
      else {
        const id = key.slice(key.indexOf(':') + 1), job = runs().find(item => item.id === id); if (!job) return;
        const inputJob = id.startsWith('input-run');
        if (key.startsWith('cancel:')) { if (formatJobs.has(id)) { job.controller.abort(); job.status = 'cancelled'; } else if (inputJob) actions.cancelInputAgentRun(id); else actions.cancelTextEditRun(id); render(); }
        else if (key.startsWith('ignore:')) { inputJob ? actions.ignoreInputAgentRun(id) : actions.ignoreTextEditRun(id); render(); }
        else if (key.startsWith('apply:')) { close(); await actions.applyInputAgentRun(id); refreshStatus(); }
        else if (key.startsWith('review:')) { close(); await actions.openTextEditRun(id); refreshStatus(); }
        else if (key.startsWith('copy:')) { const frozen = { ...context }, copied = await clipboard.copyToClipboard(job.text); if (sameContext(frozen, getContext())) tell(copied ? '已复制' : '复制失败'); }
        else if (key.startsWith('process:')) configure(job.agentId);
      }
    } catch (error) { tell(String(error.message || error)); }
  });
  listen(doc, 'keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); back(); return; }
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
  for (const name of ['agent-input-changed', 'agent-text-edit-changed']) listen(win, name, refreshStatus);
  listen(win, 'agent-feature-settings-changed', () => {
    readCatalog();
    for (const job of formatJobs.values()) if (job.status === 'running' && !catalog.some(config => config.id === job.agentId && config.enabled)) { job.controller.abort(); job.status = 'cancelled'; }
    if (!panel.hidden && mode === 'task') { mountCard(); void prepare(); } else refreshStatus();
  });
  listen(win, 'session-changed', () => { close(); resume = null; selectionSnapshot = null; readCatalog();
    for (const job of formatJobs.values()) if (job.status === 'running' && !sameContext(job.context, getContext())) { job.controller.abort(); job.status = 'cancelled'; } refreshStatus(); });
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
    captureSelectionIdentity: messageId => actions.captureAgentToolSelectionIdentity?.({ messageId }),
    setSelectionController: value => { controller = value; },
    hasSelectionTools: () => catalog.some(config => !isInputAgent(config) && config.enabled),
    dispose: () => { close(); disposed = true; win.cancelAnimationFrame(frame); win.cancelAnimationFrame(targetFrame); bindings.forEach(remove => remove()); observer.disconnect(); targetObserver.disconnect(); for (const job of formatJobs.values()) job.controller.abort(); view.dispose(); },
  };
};
