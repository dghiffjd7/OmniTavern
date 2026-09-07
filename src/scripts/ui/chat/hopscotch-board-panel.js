import { t } from '../../i18n/index.js';
import { appConfirm } from '../app-confirm.js';
import { bindBackdropActivation } from '../backdrop-activation-utils.js';
import { closeCustomSelectMenu, createCustomSelectWrapper, bindCustomSelectButton } from '../custom-select.js';
import { HOPSCOTCH_HOUSE_CATALOG, HOPSCOTCH_FUSED_KINDS, validateHopscotchBoard, getHopscotchHouseDisplayStatus } from './hopscotch-board-utils.js';
import { editHopscotchBoard } from './hopscotch-board-editor-utils.js';
import { escapeHopscotchHtml as e, hopscotchHouseLabel, hopscotchFusedLabel, hopscotchStatusLabel, renderHopscotchCourt } from './hopscotch-court-view.js';
import { hopscotchInactiveLabel, resolveHopscotchActivation } from './hopscotch-activation-utils.js';
import { buildHopscotchVariableCard, renderHopscotchVariableInfo } from './hopscotch-variable-card-view.js';
import { bindHopscotchPointerDrag } from './hopscotch-pointer-drag.js';
import { listHopscotchDropTargets } from './hopscotch-drag-utils.js';

const actionIcon = action => {
  const path = {
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    'close-detail': '<path d="m6 6 12 12M6 18 18 6"/>',
    settings: '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h4m4 0h8M8 3v6m6 0v6M8 15v6"/>',
    transfer: '<path d="M8 3v14m-4-4 4 4 4-4M16 21V7m-4 4 4-4 4 4"/>',
    reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
    undo: '<path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 6 6v3"/>',
    save: '<path d="m5 12 4 4L19 6"/>',
    remove: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    library: '<path d="M4 5h16M4 12h16M4 19h16"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    'run-mode': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'edit-mode': '<path d="M4 20h4l10-10-4-4L4 16v4z"/>',
  }[action];
  return path ? `<svg class="hop-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>` : '';
};

export const createHopscotchBoardPanel = ({
  documentRef = document, boardStore, runtime, getSessionId = () => '', getPlace = () => 'writing', getProfiles = () => [],
  enable = () => {}, getEnabled = () => false,
  embedded = false, onOpen = () => {}, mountAgentCard = null, confirm = appConfirm,
  closeRelatedLayer = () => false, buildPromptPreview = null,
  openVariableSettings = null, openVariablePreviewTools = null,
} = {}) => {
  const doc = documentRef;
  const panel = doc.createElement(embedded ? 'section' : 'dialog');
  panel.className = `hop-dialog${embedded ? ' hop-embedded' : ''}`;
  panel.id = 'hopscotch-board-panel';
  panel.setAttribute('aria-label', t('跳房子编排'));
  const detail = doc.createElement('dialog');
  detail.className = 'hop-dialog hop-detail';
  detail.setAttribute('aria-label', t('房子详情'));
  if (!embedded) doc.body.append(panel);
  const detailLayer = embedded ? doc.createElement('div') : null;
  if (detailLayer) {
    detailLayer.className = 'hop-detail-layer';
    detailLayer.hidden = true;
    detailLayer.append(detail);
    detail.setAttribute('aria-modal', 'true');
    doc.body.append(detailLayer);
  } else doc.body.append(detail);
  let sid = '';
  let place = 'writing';
  let target = 'session';
  let draft = null;
  let dirty = false;
  let mode = 'edit';
  let error = '';
  let saving = false;
  let mounted = false;
  let viewEpoch = 0;
  let detailEpoch = 0;
  let sharedConfig = null;
  let activationStamp = '';
  let detailFocus = null;
  const undoStack = [];
  const capabilities = () => runtime.resolveFusionCapabilities?.(sid, { place }) || {};
  const dragController = bindHopscotchPointerDrag({
    root: panel, getBoard: () => draft, getCapabilities: capabilities, getActivation: board => resolveActivation(board),
    canDrag: () => Boolean(draft && place === 'writing' && getPlace() !== 'chat' && sid === String(getSessionId() || '') && mode === 'edit' && !busy() && !saving && !detail.open),
    onDrop: (id, target) => edit({ type: 'drop', id, target, capabilities: capabilities() }),
  });
  const releaseSharedConfig = () => { sharedConfig?.dispose(); sharedConfig = null; };
  const closeDetail = () => {
    detailEpoch++;
    releaseSharedConfig();
    if (detail.open) closeCustomSelectMenu();
    detail.close();
    if (detailLayer) detailLayer.hidden = true;
    if (detailFocus?.isConnected) detailFocus.focus({ preventScroll: true });
  };
  const confirmSharedDiscard = async () => {
    const epoch = detailEpoch;
    const accepted = await confirm({ title: t('未保存的修改'), message: t('共享设置尚未保存，关闭将丢弃这些修改。'), confirmText: t('丢弃并关闭'), danger: true });
    return accepted && epoch === detailEpoch;
  };
  const requestDetailClose = async () => {
    if (closeRelatedLayer()) return;
    const menu = doc.querySelector('.world-app-select-menu');
    if (menu && menu.style.display !== 'none') { closeCustomSelectMenu(); return; }
    if (sharedConfig?.hasDraft() && !await confirmSharedDiscard()) return;
    closeDetail();
    refreshSettings();
  };
  const unbindBackdrop = detailLayer ? bindBackdropActivation(detailLayer, { onActivate: requestDetailClose }) : () => {};
  detail.addEventListener('cancel', event => { event.preventDefault(); void requestDetailClose(); });
  detail.addEventListener('keydown', event => {
    if (!embedded || event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!sharedConfig?.closePreview?.()) void requestDetailClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...detail.querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')].filter(node => !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const button = (action, label, attrs = '') => `<button type="button" data-action="${action}" ${attrs}>${actionIcon(action)}<span class="hop-button-label">${e(label)}</span></button>`;
  const field = (name, label, value, type = 'text', attrs = '') => `<label>${e(label)}<input name="${name}" type="${type}" value="${e(value)}" ${attrs}></label>`;
  const option = (value, label, current) => `<option value="${e(value)}" ${value === current ? 'selected' : ''}>${e(label)}</option>`;
  const select = (name, label, options) => `<label>${e(label)}<select name="${name}" aria-label="${e(label)}">${options}</select></label>`;
  const bindBoardSelects = root => {
    // 正式 AC 宿主使用应用浮层；独立测试 dialog 的 native top layer 仍保留原生选单。
    if (!embedded) return;
    root.querySelectorAll('select').forEach(selectEl => {
      const label = selectEl.getAttribute('aria-label') || t('请选择');
      const wrapper = createCustomSelectWrapper(selectEl, { placeholder: label });
      wrapper.className = 'hop-select';
      selectEl.replaceWith(wrapper);
      selectEl.hidden = true;
      wrapper.prepend(selectEl);
      const buttonEl = wrapper.querySelector('button');
      buttonEl.setAttribute('aria-label', label);
      bindCustomSelectButton({ buttonEl, selectEl, fallback: label });
    });
  };
  const busy = () => runtime.isSessionBusy(sid);
  const isScopeMenuOpen = () => panel.contains(doc.activeElement)
    && doc.activeElement.matches('.hop-scope .world-app-select-btn')
    && doc.querySelector('.world-app-select-menu')?.style.display === 'block';
  const sourceLabel = source => ({ session: t('本会话覆盖'), global: t('创意写作默认'), derived: t('跟随现有设置') })[source];
  const resolveBoard = () => runtime.resolveBoard(target === 'session' ? sid : '', { place, contextSessionId: sid });
  const resolveActivation = board => runtime.resolveActivation?.(board, sid, { place }) || resolveHopscotchActivation(board);
  const loadDraft = () => {
    const resolved = resolveBoard();
    draft = structuredClone(resolved.board);
    dirty = false;
    undoStack.length = 0;
    error = '';
  };
  const showDetail = () => {
    if (!detail.open) {
      detailFocus = doc.activeElement;
      if (embedded) { detailLayer.hidden = false; detail.show(); }
      else detail.showModal();
    }
    detail.querySelector('[data-action="flip"], [data-action="close-detail"], .agent-center-floating-face:not([inert]) [data-agent-float-flip]')?.focus();
  };
  const frameDetail = (title, content, footer = '', front = null) => {
    releaseSharedConfig();
    detailEpoch++;
    detail.onclick = null;
    detail.className = `hop-dialog hop-detail${front !== null ? ' hop-house-detail' : ''}`;
    const back = `<div class="hop-content">${content}</div>${footer ? `<div class="hop-footer">${footer}</div>` : ''}`;
    detail.innerHTML = `<div class="hop-header"><h2>${e(title)}</h2><span class="hop-spacer"></span>${front !== null ? button('flip', t('配置'), 'aria-pressed="false"') : ''}${button('close-detail', t('关闭'), `class="hop-icon-only" title="${e(t('关闭'))}" aria-label="${e(t('关闭'))}"`)}</div>
      ${front !== null ? `<div class="hop-card-stage"><div class="hop-card-inner"><div class="hop-card-face hop-card-front">${front}</div><div class="hop-card-face hop-card-back" aria-hidden="true" inert>${back}</div></div></div>` : back}<p class="hop-error" role="alert"></p>`;
    detail.querySelector('[data-action="close-detail"]').onclick = () => { void requestDetailClose(); };
    const flip = detail.querySelector('[data-action="flip"]');
    if (flip) flip.onclick = () => {
      const flipped = detail.querySelector('.hop-card-inner').classList.toggle('is-flipped');
      flip.setAttribute('aria-pressed', String(flipped));
      flip.textContent = flipped ? t('详情') : t('配置');
      for (const [selector, hidden] of [['.hop-card-front', flipped], ['.hop-card-back', !flipped]]) {
        const face = detail.querySelector(selector);
        face.inert = hidden;
        face.setAttribute('aria-hidden', String(hidden));
      }
    };
    bindBoardSelects(detail);
    showDetail();
  };
  const showError = message => {
    error = String(message || t('操作失败'));
    (detail.open ? detail : panel).querySelector('.hop-error').textContent = error;
    // 编排校验/共享草稿提示位于背面；正面删除被阻止时需让提示可见。
    if (detail.open) detail.querySelector('.agent-center-floating-face-front:not([inert]) [data-agent-float-flip]')?.click();
  };
  const edit = action => {
    const result = editHopscotchBoard(draft, { ...action, capabilities: capabilities() });
    if (!result.ok) { showError(result.reason); return false; }
    if (result.changed === false || JSON.stringify(result.board) === JSON.stringify(draft)) return true;
    undoStack.push({ board: structuredClone(draft), dirty });
    if (undoStack.length > 30) undoStack.shift();
    draft = result.board;
    dirty = true;
    mode = 'edit';
    error = '';
    render();
    return true;
  };
  // 手机/窄容器：把整张板缩放到一屏，避免横向滚动；过小时退回滚动
  let fitFrame = 0;
  const fitCourt = () => {
    const scroll = panel.querySelector('.hop-court-scroll');
    const court = scroll?.querySelector('.hop-court');
    if (!scroll || !court || typeof court.getBoundingClientRect !== 'function') return;
    court.style.transform = '';
    court.style.setProperty('--hop-grip-scale', '1');
    scroll.style.height = '';
    const available = scroll.clientWidth - 16;
    const natural = court.scrollWidth || court.getBoundingClientRect().width;
    if (!available || !natural || natural <= available) { scroll.classList.remove('is-scaled'); return; }
    const scale = available / natural;
    if (scale < 0.55) { scroll.classList.remove('is-scaled'); return; }
    scroll.classList.add('is-scaled');
    // transform 不改变布局盒：以左上为原点缩放并水平居中，容器高度按缩放后的实际高度收紧
    const offset = Math.max(0, (scroll.clientWidth - natural * scale) / 2);
    court.style.transform = `translateX(${offset.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    court.style.setProperty('--hop-grip-scale', String(1 / scale));
    scroll.style.height = `${Math.ceil(court.getBoundingClientRect().height) + 8}px`;
  };
  const scheduleFit = () => {
    const win = doc.defaultView;
    if (!win?.requestAnimationFrame) { fitCourt(); return; }
    win.cancelAnimationFrame?.(fitFrame);
    fitFrame = win.requestAnimationFrame(fitCourt);
  };
  const resizeObserver = typeof doc.defaultView?.ResizeObserver === 'function' ? new doc.defaultView.ResizeObserver(() => scheduleFit()) : null;
  const closeMenu = () => {
    const menu = panel.querySelector('.hop-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    panel.querySelector('[data-action="more"]')?.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    dragController.cancel();
    if (panel.contains(doc.activeElement) && doc.activeElement.matches('.world-app-select-btn')) closeCustomSelectMenu();
    const latest = place === 'writing' ? runtime.getLatestTurn(sid) : null;
    const live = mode === 'run' && latest;
    const editable = place === 'writing' && !live && !busy() && !saving;
    const states = live ? Object.fromEntries(latest.getHouseStates().map(state => [state.id, state])) : {};
    const activation = live ? latest.activation || resolveActivation(latest.board) : resolveActivation(draft);
    activationStamp = JSON.stringify(activation);
    const resolved = resolveBoard();
    panel.dataset.hopPlace = place;
    const iconBtn = (action, label, attrs = '') => button(action, label, `class="hop-icon-only" title="${e(label)}" aria-label="${e(label)}" ${attrs}`);
    const saveLabel = dirty ? t('保存并启用') : (resolved.source === 'derived' ? t('保存并启用') : t('已启用'));
    const saveDisabled = !editable || (!dirty && resolved.source !== 'derived');
    panel.innerHTML = `<div class="hop-board-toolbar"><div class="hop-header">
        <span class="hop-source${dirty ? ' is-dirty' : ''}${resolved.source !== 'derived' ? ' is-custom' : ''}" title="${e(dirty ? t('未保存') : sourceLabel(resolved.source))}"><i aria-hidden="true"></i>${e(place === 'writing' ? t('创意写作') : t('聊天模式'))}<span class="hop-sr">${e(dirty ? t('未保存') : sourceLabel(resolved.source))}</span></span>
        ${place === 'writing' ? `<div class="hop-scope"><select data-hop-target aria-label="${e(t('保存范围'))}" ${saving ? 'disabled' : ''}>${option('global', t('创意写作默认'), target)}${sid ? option('session', t('本会话'), target) : ''}</select></div>` : ''}
        <span class="hop-spacer"></span>
        ${busy() ? button('stop', t('停止'), 'class="hop-danger"') : ''}
        ${place === 'writing' && latest ? (live ? iconBtn('edit-mode', t('编辑'), 'aria-pressed="true"') : iconBtn('run-mode', t('上一轮'), 'aria-pressed="false"')) : ''}
        ${place === 'writing' ? iconBtn('more', t('更多'), 'aria-haspopup="menu" aria-expanded="false"') : ''}
        ${iconBtn('library', t('全部 Agent'))}
        ${iconBtn('help', t('说明'))}
        ${embedded ? '' : iconBtn('close', t('关闭'))}
        ${place === 'writing' ? `<div class="hop-menu hop-secondary-actions" role="menu" hidden>${button('settings', t('执行规则'), 'role="menuitem"' + (editable ? '' : ' disabled'))}${button('transfer', t('导入 / 导出'), 'role="menuitem"' + (editable ? '' : ' disabled'))}${button('reset', target === 'session' ? t('跟随默认') : t('恢复推导'), 'role="menuitem"' + (editable ? '' : ' disabled'))}</div>` : ''}
      </div></div>
      ${renderHopscotchCourt(live ? latest.board : draft, { editable, states, place, activation, status: live ? latest.result?.status || 'running' : '' })}
      <p class="hop-error" role="alert">${e(error)}</p>
      ${place === 'writing' ? `<div class="hop-footer hop-board-footer">${undoStack.length ? iconBtn('undo', t('撤销上一步'), editable ? '' : 'disabled') : ''}${button('save', saveLabel, `class="hop-primary" ${saveDisabled ? 'disabled' : ''}`)}</div>` : ''}`;
    fitCourt();
    const targetSelect = panel.querySelector('[data-hop-target]');
    if (targetSelect) targetSelect.onchange = event => {
      const next = event.target.value;
      if (dirty) {
        event.target.value = target;
        frameDetail(t('未保存的修改'), `<p>${e(t('切换范围将丢弃当前草稿。'))}</p>`, button('discard-switch', t('丢弃并切换')));
        detail.querySelector('[data-action="discard-switch"]').onclick = () => { target = next; loadDraft(); closeDetail(); render(); };
      } else { target = next; loadDraft(); render(); }
    };
    bindBoardSelects(panel);
  };
  const openHouse = (id, configure = false, fusedKind = '') => {
    const turn = mode === 'run' ? runtime.getLatestTurn(sid) : null;
    const board = turn?.board || draft;
    const rowIndex = board.rows.findIndex(row => row.houses.some(h => h.id === id));
    const house = board.rows[rowIndex]?.houses.find(h => h.id === id);
    if (!house) return;
    const member = house.kind === 'body' && house.fused?.includes(fusedKind) ? fusedKind : '';
    const number = board.rows.flatMap(row => row.houses).findIndex(item => item.id === id) + 1;
    const state = turn?.getHouseStates().find(item => item.id === id);
    const editable = place === 'writing' && !turn && !busy() && !saving;
    const activation = turn?.activation || resolveActivation(board);
    const active = (member ? activation.fused?.[member] : activation.houses?.[id]) || { requested: true, enabled: true };
    const variableCard = member === 'variable' || house.kind === 'variable' || house.kind === 'variable_rules';
    const nodeId = member ? house.fusedMembers[member].id : id;
    const variableActivity = activation.variable || {};
    const variableInfo = variableCard ? renderHopscotchVariableInfo(variableActivity, active, { execution: member ? '' : house.kind === 'variable_rules' ? 'rules' : 'standalone' }) : '';
    const canToggle = editable && (member || house.kind !== 'body');
    const unavailable = active.requested && !active.enabled;
    const toggle = canToggle ? `<div class="hop-flow-toggle-row"><span class="has-help" data-help="${e(unavailable ? hopscotchInactiveLabel(active.reason) : t('保存后用于后续轮次，房子的位置与配置保留。'))}">${e(t('参与此流程'))}</span><button type="button" class="agent-center-switch${active.enabled ? ' is-on' : ''}" role="switch" aria-checked="${active.enabled}" aria-label="${e(t('参与此流程'))}" data-action="toggle-enabled" ${unavailable ? 'disabled' : ''}><span class="agent-center-switch-track" aria-hidden="true"><span class="agent-center-switch-thumb"></span></span></button></div>` : '';
    const hints = { body: t('融合项与正文共享一次请求。'), custom_prompt: t('每次执行通常增加 1 次文本模型请求。'), memory_table: t('独立请求更新记忆，保留频率规则。'), summary_compaction: t('未达到压缩阈值时跳过。'), format_review: t('生成待确认候选，不自动替换正文。'), image_generation: t('读取正文图片提示，等待所有图片完成。') };
    const front = state ? `<p class="hop-card-status">${e(hopscotchStatusLabel(getHopscotchHouseDisplayStatus(state)))}${state.reason ? ` · ${e(state.enabled === false ? hopscotchInactiveLabel(state.reason) : state.reason)}` : ''}</p>
        <p class="hop-hint">${e(state?.usage?.latencyMs != null ? `${state.usage.latencyMs} ms` : '')} · ${e(t('用量'))}: ${e(state?.usage?.providerUsage ? JSON.stringify(state.usage.providerUsage) : t('未知'))}</p>
        <pre class="hop-output" data-i18n-skip="true">${e(state?.artifact?.text || state?.error || (state?.artifact ? JSON.stringify(state.artifact, null, 2) : ''))}</pre>
        ${state?.childResults?.length ? `<pre class="hop-output" data-i18n-skip="true">${e(JSON.stringify(state.childResults, null, 2))}</pre>` : ''}`
      : `<span class="hop-card-mark" aria-hidden="true">${String(number).padStart(2, '0')}</span><p class="hop-card-name" data-i18n-skip="true">${e(hopscotchHouseLabel(house))}</p><p class="hop-hint">${e(hints[house.kind] || '')}</p>${house.fused?.length ? `<p class="hop-fused">${house.fused.map(kind => `<span><i></i>${e(hopscotchFusedLabel(kind))}</span>`).join('')}</p>` : ''}`;
    const cfg = house.config || {};
    const independentModel = !member && ['image_prompt', 'variable'].includes(house.kind);
    let content = '';
    if (member) {
      content = '';
    } else if (house.kind === 'custom_prompt') {
      content = `${field('label', t('名称'), house.label)}<p class="hop-hint" data-i18n-skip="true">${e(id)}</p>
        <label>${e(t('提示词'))}<textarea name="prompt" data-i18n-skip="true">${e(cfg.prompt)}</textarea></label>
        <p class="hop-hint" data-i18n-skip="true">{{user_input}} · {{body}} · {{house:id}} · {{char}} · {{user}}</p>
        <details><summary>${e(t('更多设置'))}</summary><label>${e(t('系统提示词'))}<textarea name="systemPrompt" data-i18n-skip="true">${e(cfg.systemPrompt)}</textarea></label>
        ${select('model', t('模型配置'), option('', t('跟随当前'), cfg.modelMode === 'profile' ? cfg.modelProfileId : '') + getProfiles().map(profile => option(profile.id, profile.name, cfg.modelProfileId)).join(''))}
        ${field('modelOverride', t('模型覆盖'), cfg.modelOverride)}
        <div class="hop-fields">${select('includeContext', t('上下文'), [['none', t('无')], ['recent', t('最近对话')], ['full', t('全部已载入对话')]].map(([v, l]) => option(v, l, cfg.includeContext)).join(''))}${field('recentMessageCount', t('最近消息数'), cfg.recentMessageCount, 'number', 'min="1" max="50"')}${field('contextTokenBudget', t('输入预算（估算 token）'), cfg.contextTokenBudget, 'number', 'min="100" max="32000"')}${field('maxTokens', t('最大输出 token'), cfg.maxTokens, 'number', 'min="16" max="8192"')}${field('timeoutMs', t('超时（毫秒）'), cfg.timeoutMs, 'number', 'min="1000" max="600000"')}</div></details>
        ${select('outputMode', t('产物'), option('context', t('资料（可供后续引用）'), cfg.output.mode) + option('note', t('附注（只读建议）'), cfg.output.mode))}
        <label class="hop-check"><input type="checkbox" name="injectIntoBody" ${cfg.output.injectIntoBody ? 'checked' : ''}>${e(t('注入正文（仅前置资料）'))}</label><p class="hop-hint">${e(t('每次执行通常增加 1 次文本模型请求。'))}</p>`;
    } else if (house.kind === 'body') {
      content = `<p class="hop-hint">${e(t('融合项与正文共享一次请求。'))}</p><div class="hop-move">${HOPSCOTCH_FUSED_KINDS.map(kind => button(`fused:${kind}`, `${house.fused.includes(kind) ? '●' : '○'} ${hopscotchFusedLabel(kind)}`, `aria-pressed="${house.fused.includes(kind)}"`)).join('')}</div>`;
    } else {
      content = `<p class="hop-hint">${e(hints[house.kind] || '')}</p>`;
      if (house.kind === 'memory_table') content += `<div class="hop-move">${button('fused:memory_table', t('叠进正文'))}</div>`;
    }
    if (independentModel) content += `${select('model', t('模型配置'), option('', t('跟随正文'), cfg.modelMode === 'profile' ? cfg.modelProfileId : '') + getProfiles().map(profile => option(profile.id, profile.name, cfg.modelProfileId)).join(''))}${field('modelOverride', t('模型覆盖'), cfg.modelOverride || '')}`;
    // 摘要压缩使用专用压缩提示，不能把记忆表格模板冒充其共享配置。
    const fusedAgents = { memory_table: 'memory_table_agent', image_prompt: 'image_director' };
    const agentId = variableCard ? '' : member ? fusedAgents[member] : ({ memory_table: 'memory_table_agent', format_review: 'reply_check', image_generation: 'image_director', image_prompt: 'image_director' })[house.kind];
    const dropChoices = editable ? listHopscotchDropTargets(board, nodeId, { capabilities: capabilities() }).filter(item => item.ok && item.changed) : [];
    if (editable) {
      content += `<details><summary>${e(t('移动'))}</summary><div class="hop-move">${dropChoices.map((item, index) => button(`drop:${index}`, item.type === 'fuse' ? t('叠进正文') : item.type === 'gap' ? t('独立到第 {value} 行', { value: item.beforeRowId ? board.rows.findIndex(row => row.id === item.beforeRowId) + 1 : board.rows.length + 1 }) : t('第 {value} 行 · {value2}', { value: board.rows.findIndex(row => row.id === item.rowId) + 1, value2: item.beforeId ? hopscotchHouseLabel(board.rows.flatMap(row => row.houses).find(h => h.id === item.beforeId)) + ' ←' : t('末尾') }))).join('')}</div></details>`;
    }
    const fields = `<fieldset class="hop-card-fields" ${editable ? '' : 'disabled'}>${content}</fieldset>`;
    const removeButton = editable && house.kind !== 'body' ? button('remove', t('删除房子'), `class="agent-center-icon-button hop-icon-only hop-remove" title="${e(t('删除房子'))}" aria-label="${e(t('删除房子'))}"`) : '';
    const footer = editable ? `${house.kind === 'custom_prompt' ? button('copy', t('复制')) : ''}<span class="hop-spacer"></span>${button('apply', t('完成'), 'class="hop-primary"')}` : '';
    if (mountAgentCard) {
      releaseSharedConfig();
      detailEpoch++;
      detail.onclick = null;
      detail.className = 'hop-detail hop-house-detail hop-agent-detail';
      const boardContent = doc.createElement('div');
      boardContent.className = 'hop-board-card-controls';
      boardContent.innerHTML = `${toggle}${variableInfo}${place === 'writing' ? `<div class="agent-center-agent-section-title">${e(t('跳房子编排'))}</div>${fields}<div class="hop-footer">${footer}</div>` : ''}`;
      bindBoardSelects(boardContent);
      const previewSessionId = sid, previewPlace = place;
      sharedConfig = mountAgentCard(detail, {
        agentId, card: variableCard ? { ...buildHopscotchVariableCard(variableActivity, active), ...(house.kind === 'variable_rules' ? { title: hopscotchHouseLabel(house) } : {}) } : { id: house.kind, title: hopscotchHouseLabel(house), summary: hints[house.kind], detail: [hints[house.kind]], category: place === 'writing' ? 'creative' : 'chat', accent: house.kind === 'summary_compaction' ? 'summary' : 'dialogue', implemented: true, enabled: true },
        workflowState: active,
        frontExtra: toggle + (variableCard ? variableInfo + (state && !member ? `<div class="agent-center-agent-section">${front}</div>` : '') : member ? '' : `<span class="hop-card-mark">${String(number).padStart(2, '0')}</span>` + (state ? `<div class="agent-center-agent-section">${front}</div>` : '')),
        toolbarExtra: member ? '' : removeButton,
        fusedConfigs: house.kind === 'body' && !member ? house.fused.map(kind => ({ id: kind, label: hopscotchFusedLabel(kind), agentId: fusedAgents[kind] })) : [],
        onOpenFused: async kind => {
          if (sharedConfig?.hasDraft() && !await confirmSharedDiscard()) return;
          openHouse(id, false, kind);
        },
        buildPromptPreview: house.kind === 'body' && !member && !turn && buildPromptPreview
          ? () => buildPromptPreview({ sessionId: previewSessionId, place: previewPlace }) : null,
        content: place === 'writing' || variableCard ? boardContent : null, configure, readOnly: Boolean(turn) || busy() || saving, onClose: () => { void requestDetailClose(); },
      });
      showDetail();
    } else {
      frameDetail(hopscotchHouseLabel(house), fields, footer, front);
      detail.querySelector('.hop-header .hop-spacer').insertAdjacentHTML('afterend', removeButton);
      if (configure) detail.querySelector('[data-action="flip"]').click();
    }
    detail.onclick = event => {
      const control = event.target.closest('[data-action]');
      const action = control?.dataset.action;
      if (action === 'variable-settings' || action === 'variable-preview-tools') {
        if (control.matches(':disabled') || turn || busy() || sid !== String(getSessionId() || '')) return;
        if (action === 'variable-settings') {
          const epoch = detailEpoch, currentSid = sid;
          const flipped = Boolean(detail.querySelector('.agent-center-floating-card.is-flipped'));
          openVariableSettings?.({ sessionId: sid, onClose: () => {
            if (epoch !== detailEpoch || !detail.open || currentSid !== String(getSessionId() || '')) return;
            render();
            openHouse(id, flipped, member);
          } });
        } else {
          closeDetail();
          openVariablePreviewTools?.({ sessionId: sid });
        }
        return;
      }
      if (!action || control.matches(':disabled') || action === 'close-detail' || action === 'flip' || !editable || busy() || saving) return;
      if (sharedConfig?.hasDraft()) { showError(t('请先保存共享设置，或关闭卡片放弃修改。')); return; }
      let operation;
      if (action === 'toggle-enabled') {
        const flipped = Boolean(detail.querySelector('.agent-center-floating-card.is-flipped'));
        if (edit({ type: 'toggle', id, member, enabled: active.requested === false })) { closeDetail(); openHouse(id, flipped, member); }
        return;
      } else if (action === 'apply') {
        if (independentModel) {
          const profile = detail.querySelector('[name="model"]').value;
          if (edit({ type: 'update', id, patch: { config: { ...cfg, modelMode: profile ? 'profile' : 'follow_current', modelProfileId: profile, modelOverride: detail.querySelector('[name="modelOverride"]').value } } })) closeDetail();
          return;
        }
        if (house.kind !== 'custom_prompt') { closeDetail(); refreshSettings(); return; }
        const value = name => detail.querySelector(`[name="${name}"]`).value;
        operation = { type: 'update', id, patch: { label: value('label'), config: {
          ...cfg, prompt: value('prompt'), systemPrompt: value('systemPrompt'), modelMode: value('model') ? 'profile' : 'follow_current', modelProfileId: value('model'), modelOverride: value('modelOverride'), includeContext: value('includeContext'),
          recentMessageCount: Number(value('recentMessageCount')), contextTokenBudget: Number(value('contextTokenBudget')), maxTokens: Number(value('maxTokens')), timeoutMs: Number(value('timeoutMs')),
          output: { mode: value('outputMode'), injectIntoBody: detail.querySelector('[name="injectIntoBody"]').checked },
        } } };
      } else if (action.startsWith('fused:')) {
        const kind = action.slice(6);
        operation = { type: 'fuse', kind, enabled: house.kind !== 'body' || !house.fused.includes(kind) };
      } else if (action.startsWith('drop:')) operation = { type: 'drop', id: nodeId, target: dropChoices[Number(action.slice(5))] };
      else if (action.startsWith('move:')) operation = { type: 'move', id, rowIndex: Number(action.slice(5)) };
      else if (action === 'new-before' || action === 'new-after') operation = { type: 'move', id, rowIndex: rowIndex + (action === 'new-after' ? 1 : 0), newRow: true };
      else if (action === 'left' || action === 'right') operation = { type: 'move', id, rowIndex, houseIndex: Math.max(0, board.rows[rowIndex].houses.indexOf(house) + (action === 'left' ? -1 : 1)) };
      else if (action === 'copy' || action === 'remove') operation = { type: action, id };
      if (operation && edit(operation)) { closeDetail(); if (operation.type === 'fuse') openHouse(id, true); }
    };
  };
  const openPicker = (rowIndex, newRow) => {
    // 压缩是记忆内部维护，不是可新增的 Agent；旧板节点仍可读取和删除。
    const choices = HOPSCOTCH_HOUSE_CATALOG.filter(item => item.kind !== 'body' && item.kind !== 'summary_compaction' && (place !== 'writing' || item.kind !== 'format_review')).flatMap(item => item.kind === 'variable_rules' ? ['before', 'after'].map(phase => ({ ...item, config: { phase } })) : [item]);
    frameDetail(t('新增房子'), `<div class="hop-picker">${choices.map((item, index) => button(`add:${index}`, hopscotchHouseLabel(item), editHopscotchBoard(draft, { type: 'add', kind: item.kind, house: { config: item.config }, rowIndex, newRow }).ok ? '' : 'disabled')).join('')}</div>`);
    detail.onclick = event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action?.startsWith('add:')) return;
      const item = choices[Number(action.slice(4))];
      if (item && edit({ type: 'add', kind: item.kind, house: { config: item.config }, rowIndex, newRow })) closeDetail();
    };
  };
  const save = async (reset = false) => {
    if (saving) return;
    const epoch = viewEpoch;
    saving = true;
    render();
    try {
      const result = target === 'session' ? await boardStore.setSessionOverride(sid, reset ? null : draft) : await boardStore.setGlobalBoard(reset ? null : draft);
      if (epoch !== viewEpoch) return;
      if (!result?.ok) throw new Error(result?.reason || t('保存失败'));
      if (!reset) await enable(true);
      if (epoch === viewEpoch) loadDraft();
    } catch (err) { if (epoch === viewEpoch) error = err.message || String(err); }
    finally { if (epoch === viewEpoch) { saving = false; render(); } }
  };
  const close = () => {
    dragController.cancel();
    closeCustomSelectMenu();
    viewEpoch++;
    saving = false;
    closeDetail();
    if (embedded) panel.remove();
    else panel.close();
    mounted = false;
    draft = null;
    dirty = false;
  };
  const requestClose = continuation => {
    if (saving) return false;
    if (sharedConfig?.hasDraft()) {
      void confirmSharedDiscard().then(accepted => {
        if (!accepted) return;
        releaseSharedConfig();
        if (requestClose(continuation)) continuation();
      });
      return false;
    }
    if (!dirty) return true;
    frameDetail(t('未保存的修改'), `<p>${e(t('关闭将丢弃当前草稿。'))}</p>`, button('discard-close', t('丢弃并关闭')));
    detail.querySelector('[data-action="discard-close"]').onclick = () => { dirty = false; closeDetail(); continuation(); };
    return false;
  };
  panel.onclick = event => {
    const cell = event.target.closest('[data-hop-house]');
    if (cell) { openHouse(cell.dataset.hopHouse, false, event.target.closest('[data-hop-part]')?.dataset.hopPart); return; }
    const add = event.target.closest('[data-hop-add]');
    if (add) { openPicker(Number(add.dataset.hopAdd), add.dataset.hopNew === '1'); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action !== 'more' && !event.target.closest('.hop-menu')) closeMenu();
    if (action === 'more') {
      const menu = panel.querySelector('.hop-menu');
      const open = menu && menu.hidden;
      if (menu) menu.hidden = !open;
      panel.querySelector('[data-action="more"]')?.setAttribute('aria-expanded', String(Boolean(open)));
      if (open) menu.querySelector('button:not(:disabled)')?.focus();
      return;
    }
    if (action === 'library') {
      // 「全部 Agent」目录仍是 AC 的 details，只是入口移到标题栏图标
      const library = panel.parentElement?.querySelector('[data-agent-library]') || doc.querySelector('[data-agent-library]');
      if (library) { library.open = !library.open; if (library.open) library.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }
      return;
    }
    if (action === 'close') {
      if (requestClose(close)) close();
    }
    if (action === 'help') frameDetail(t('从上往下'), `<p class="hop-hint">${e(t('同行并行，整行结束后进入下一行。长方形内的各项共享一次请求。'))}</p><p class="hop-hint">${e(place === 'writing' ? t('按住房子查看落点；中心融合，左右并行，上下换行。手机可长按或拖动右上角把手。') : t('聊天模式跟随当前设置；点击房子配置 Agent。'))}</p>${place === 'writing' ? `<p class="hop-hint">${e(t('空格开始拖动，方向键选择落点，回车放置，Esc 取消。保存后用于后续轮次。'))}</p>` : ''}`);
    if (place !== 'writing') return;
    if (action === 'edit-mode' || action === 'run-mode') { mode = action === 'edit-mode' ? 'edit' : 'run'; render(); }
    if (action === 'stop') runtime.abortSessionTurn(sid);
    if (action === 'undo' && undoStack.length && !busy() && !saving) {
      const previous = undoStack.pop(); draft = previous.board; dirty = previous.dirty; error = ''; render();
    }
    if (action === 'save') void save();
    if (action === 'reset') {
      frameDetail(t('恢复跟随'), `<p>${e(t('将移除此范围的自定义板。'))}</p>`, button('confirm-reset', t('确认恢复')));
      detail.querySelector('[data-action="confirm-reset"]').onclick = () => { closeDetail(); void save(true); };
    }
    if (action === 'settings') {
      frameDetail(t('执行规则'), `<label class="hop-check"><input name="enabled" type="checkbox" ${getEnabled() ? 'checked' : ''}>${e(t('启用自定义编排'))}</label>${field('concurrency', t('同行并发上限'), draft.policy.rowConcurrencyMax, 'number', 'min="1" max="4"')}${select('failure', t('房子失败时'), option('continue', t('继续后续行'), draft.policy.onHouseFailure) + option('stop_following_rows', t('停止后续行'), draft.policy.onHouseFailure))}`, button('apply-policy', t('完成')));
      detail.querySelector('[data-action="apply-policy"]').onclick = () => {
        if (edit({ type: 'policy', patch: { rowConcurrencyMax: Number(detail.querySelector('[name="concurrency"]').value), onHouseFailure: detail.querySelector('[name="failure"]').value } })) {
          enable(detail.querySelector('[name="enabled"]').checked);
          closeDetail();
        }
      };
    }
    if (action === 'transfer') {
      frameDetail(t('板 JSON'), `<p class="hop-hint">${e(t('复制下方内容导出；粘贴后导入为草稿，不立即生效。'))}</p><textarea name="boardJson" rows="12" data-i18n-skip="true">${e(JSON.stringify(draft, null, 2))}</textarea>`, button('import', t('导入草稿')));
      detail.querySelector('[data-action="import"]').onclick = () => {
        try {
          const result = validateHopscotchBoard(JSON.parse(detail.querySelector('[name="boardJson"]').value));
          if (!result.ok) throw new Error(result.errors.map(item => item.message || item.code).join('\n'));
          const missing = result.board.rows.flatMap(row => row.houses).filter(h => h.config?.modelMode === 'profile' && !getProfiles().some(p => p.id === h.config.modelProfileId));
          if (missing.length) throw new Error(t('指定的模型配置不存在'));
          undoStack.push({ board: structuredClone(draft), dirty }); draft = result.board; dirty = true; closeDetail(); render();
        } catch (err) { showError(err.message); }
      };
    }
  };
  panel.addEventListener('cancel', event => {
    event.preventDefault();
    if (requestClose(close)) close();
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.querySelector('.hop-menu')?.hidden) { event.preventDefault(); event.stopPropagation(); closeMenu(); panel.querySelector('[data-action="more"]')?.focus(); }
  });
  panel.ondragstart = event => event.preventDefault();
  const initialize = () => {
    place = getPlace() === 'chat' ? 'chat' : 'writing';
    sid = String(getSessionId() || '');
    // 默认保存到所在模式的全局默认板；只有该会话已存在覆盖时才默认选中「本会话」
    target = sid && boardStore.getSessionOverride?.(sid) ? 'session' : 'global';
    mode = busy() ? 'run' : 'edit'; loadDraft(); render();
  };
  const refreshSettings = () => {
    if (!(mounted || panel.open) || detail.open || saving || dragController.isActive()) return;
    if (dirty) { if (activationStamp !== JSON.stringify(resolveActivation(draft))) render(); return; }
    if (place !== getPlace() || sid !== String(getSessionId() || '')) initialize();
    else if (JSON.stringify(draft) !== JSON.stringify(resolveBoard().board) || activationStamp !== JSON.stringify(resolveActivation(draft))) {
      const focusedHouse = doc.activeElement?.closest('[data-hop-house]')?.dataset.hopHouse;
      const focusedPart = doc.activeElement?.dataset.hopPart;
      loadDraft(); render();
      if (focusedHouse) {
        const cell = [...panel.querySelectorAll('[data-hop-house]')].find(node => node.dataset.hopHouse === focusedHouse);
        const part = [...(cell?.querySelectorAll('[data-hop-part]') || [])].find(node => node.dataset.hopPart === focusedPart);
        (part || cell?.querySelector('button') || cell || panel.querySelector('[data-action="help"]'))?.focus({ preventScroll: true });
      }
    }
  };
  const onSettingsChanged = event => {
    if (/^(memoryEnabled|memoryStorageMode|memoryAutoExtract|memoryAutoExtractMode|memoryTableEnabledChat|memoryTableEnabledWriting)$/.test(event?.detail?.key || '')) refreshSettings();
  };
  doc.defaultView?.addEventListener('app-settings-changed', onSettingsChanged);
  const variableEvents = ['chatapp-variable-changed', 'chatapp-variable-schema-changed', 'chatapp-variable-rules-changed', 'chatapp-stage-schema-changed', 'chatapp-variable-runtime-changed'];
  const onVariablesChanged = event => { if (!event?.detail?.sessionId || event.detail.sessionId === sid) refreshSettings(); };
  variableEvents.forEach(type => doc.defaultView?.addEventListener(type, onVariablesChanged));
  const unsubscribe = runtime.subscribe(changedSid => {
    if ((mounted || panel.open) && changedSid === sid) {
      // 发送时板自动切到运行态；结束后保留结果，直到用户再次编辑或点「编辑」
      if (busy() && !dirty) mode = 'run';
      render();
      if (busy()) {
        detail.querySelectorAll('.hop-card-fields').forEach(node => node.setAttribute('disabled', ''));
        sharedConfig?.setReadOnly();
      }
    }
  });
  return {
    show: () => {
      if (embedded) { onOpen(); return; }
      if (!panel.open) { initialize(); panel.showModal(); resizeObserver?.observe(panel); scheduleFit(); }
    },
    mount: host => {
      if (!embedded || !host) return;
      // 与原 AC 浮卡处于同一层级，预览/资源面板仍可按既有规则覆盖卡片。
      const overlay = host.closest('.agent-center-overlay') || doc.body;
      if (detailLayer.parentElement !== overlay) overlay.append(detailLayer);
      // AC 的后台刷新会重建宿主；保留同一个编辑器节点及草稿，而非重新 show。
      if (!draft) initialize();
      else if (!dirty && !detail.open && !saving && !dragController.isActive()) {
        if (place !== getPlace() || sid !== String(getSessionId() || '')) initialize();
        else { loadDraft(); render(); }
      }
      host.append(panel);
      mounted = true;
      resizeObserver?.observe(panel);
      scheduleFit();
    },
    suspend: () => { dragController.cancel(); mounted = false; closeMenu(); closeCustomSelectMenu(); closeDetail(); resizeObserver?.unobserve?.(panel); },
    requestClose,
    close,
    isOpen: () => (!embedded && panel.open) || detail.open || isScopeMenuOpen(),
    closeTopLayer: () => {
      if (!panel.querySelector('.hop-menu')?.hidden && panel.querySelector('.hop-menu')) { closeMenu(); return true; }
      if (isScopeMenuOpen()) { closeCustomSelectMenu(); return true; }
      if (detail.open) { if (!sharedConfig?.closePreview?.()) void requestDetailClose(); return true; }
      if (!panel.open) return false;
      panel.querySelector('[data-action="close"]').click();
      return true;
    },
    dispose: () => { close(); dragController.dispose(); unsubscribe(); unbindBackdrop(); resizeObserver?.disconnect?.(); doc.defaultView?.removeEventListener('app-settings-changed', onSettingsChanged); variableEvents.forEach(type => doc.defaultView?.removeEventListener(type, onVariablesChanged)); detailLayer?.remove(); detail.remove(); panel.remove(); },
  };
};
