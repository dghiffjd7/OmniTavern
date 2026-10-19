import { t } from '../../i18n/index.js';
import { cloneData } from '../../utils/clone-data.js';
import { appConfirm } from '../app-confirm.js';
import { bindBackdropActivation } from '../backdrop-activation-utils.js';
import { closeCustomSelectMenu, createCustomSelectWrapper, bindCustomSelectButton } from '../custom-select.js';
import { HOPSCOTCH_HOUSE_CATALOG, HOPSCOTCH_FUSED_KINDS, validateHopscotchBoard, getHopscotchHouseDisplayStatus, isHopscotchMaintenanceRunning } from './hopscotch-board-utils.js';
import { listHopscotchHouseChoices, checkHopscotchHouseEnable, buildRecapAgentConfig, getHopscotchHouseType, isHopscotchHouseDraft } from './hopscotch-house-types.js';
import { getAgentInvocationMode } from '../../agent/agent-invocation.js';
import { RECAP_AGENT_ID } from '../../agent/recap-agent.js';
import { createHopscotchDraftAgents } from './hopscotch-draft-agents.js';
import { editHopscotchBoard } from './hopscotch-board-editor-utils.js';
import { escapeHopscotchHtml as e, hopscotchHouseLabel, hopscotchFusedLabel, hopscotchStatusLabel, renderHopscotchCourt, renderHopscotchTypeTray } from './hopscotch-court-view.js';
import { hopscotchInactiveBadgeLabel, hopscotchInactiveLabel, resolveHopscotchActivation, findManualHopscotchDependencies } from './hopscotch-activation-utils.js';
import { buildHopscotchVariableCard, renderHopscotchVariableInfo } from './hopscotch-variable-card-view.js';
import { bindHopscotchPointerDrag } from './hopscotch-pointer-drag.js';
import { bindAgentPresetSourceControls, readAgentPresetSource, renderAgentPresetSourceControl } from '../agent-preset-source-control.js';
import { bindBodyToolTransportSection, renderBodyToolTransportSection } from './body-tool-transport-control.js';
import { openHopscotchWorkflowTransfer } from './hopscotch-workflow-transfer-view.js';

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
  getInputSuggestion = () => null, openInputSuggestion = null,
  getAgentRuns = () => [], getInputAgents = () => [], createInputAgent = null, openInputAgent = null,
  getFormatReview = () => null, openFormatReview = null,
  createTextAgent = null, openTextAgent = null, listTextAgents = () => [], patchTextAgent = null, removeTextAgent = null, onScopeChange = () => {},
  getStandbyAgents = () => ({ standby: [] }), openStandbyAgent = null, getWritePreviewSwitch = () => false,
  storage = globalThis.localStorage,
  // 自定义房子「提示词 | 套用预设」用的预设服务（agent-preset-services）；没有时不显示
  presetServices = null,
  // 「正文生成」卡片的防截断传输开关（creative-body-fc 的 createBodyToolTransportSetting）；没有时不显示
  bodyToolTransport = null,
  // 工作流文件导出导入（agent-workflow-transfer-service）；没有时只有板 JSON
  workflowTransfer = null,
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
  // 草稿房子的类型托盘；同一房子在类型间来回切换时复用为它新建的 Agent，避免留下多余的 Agent。
  let trayHouseId = '';
  let retyping = false;
  const houseAgents = new Map();
  const draftAgents = createHopscotchDraftAgents({ storage, listAgents: scope => listTextAgents(scope), removeAgent: (id, options) => removeTextAgent?.(id, options) });
  const draftContext = () => `${place}|${sid}`;
  const placedAgents = board => new Set((board?.rows || []).flatMap(row => row.houses).map(house => house.kind === 'text_edit' ? house.config?.agentId : '').filter(Boolean));
  // 草稿结束：保存时保留放进板里的，其余（含放弃、关闭）删除未改过的；清理后刷新列表。
  const settleDraftAgents = (keep = new Set()) => { void draftAgents.settle(draftContext(), keep).then(removed => { if (removed.length && draft) render(); }); };
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
  const sourceLabel = source => ({ session: place === 'writing' ? t('角色卡编排') : t('本会话编排'), persona: t('角色卡编排'), global: place === 'writing' ? (target === 'global' ? t('所有角色卡') : t('跟随所有角色卡')) : t('全局编排'), derived: t('跟随现有设置') })[source];
  const resolveBoard = () => runtime.resolveBoard(target === 'global' ? '' : sid, { place, scope: target, contextSessionId: place === 'chat' && target === 'global' ? '' : sid });
  const scopeOptions = () => place === 'writing'
    ? (sid ? option(boardStore.getPersonaBoard ? 'persona' : 'session', t('当前角色卡'), target) : '') + option('global', t('所有角色卡'), target)
    : option('global', t('聊天全局设置'), target) + (sid ? option('session', t('当前聊天'), target) : '');
  const resolveActivation = board => runtime.resolveActivation?.(board, sid, { place, scope: target === 'global' ? 'global' : 'effective' }) || resolveHopscotchActivation(board);
  const loadDraft = () => {
    const resolved = resolveBoard();
    draft = cloneData(resolved.board);
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
    undoStack.push({ board: cloneData(draft), dirty });
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
    if (!available || !natural || natural <= available) { scroll.classList.remove('is-scaled'); pointTray(); return; }
    const scale = available / natural;
    if (scale < 0.55) { scroll.classList.remove('is-scaled'); pointTray(); return; }
    scroll.classList.add('is-scaled');
    // transform 不改变布局盒：以左上为原点缩放并水平居中，容器高度按缩放后的实际高度收紧
    const offset = Math.max(0, (scroll.clientWidth - natural * scale) / 2);
    court.style.transform = `translateX(${offset.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    court.style.setProperty('--hop-grip-scale', String(1 / scale));
    scroll.style.height = `${Math.ceil(court.getBoundingClientRect().height) + 8}px`;
    pointTray();
  };
  // 托盘居中排在行下方；箭头指向正在编辑的草稿房子（手机两列排布与缩放后同样准确）。
  const pointTray = () => {
    const tray = panel.querySelector('.hop-type-tray');
    const cell = tray && [...panel.querySelectorAll('[data-hop-house]')].find(node => node.dataset.hopHouse === tray.dataset.hopTray);
    if (!cell || typeof tray.getBoundingClientRect !== 'function') return;
    const box = tray.getBoundingClientRect(), target = cell.getBoundingClientRect();
    const scale = tray.offsetWidth ? box.width / tray.offsetWidth : 1;
    const x = (target.left + target.width / 2 - box.left) / (scale || 1);
    tray.style.setProperty('--hop-tray-notch', `${Math.max(16, Math.min(tray.offsetWidth - 16, x)).toFixed(1)}px`);
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
    if (!editable || !isHopscotchHouseDraft(draft?.rows.flatMap(row => row.houses).find(house => house.id === trayHouseId))) trayHouseId = '';
    const textAgents = listTextAgents(target);
    const placedIds = placedAgents(live ? latest.board : draft);
    const scraps = draftAgents.pending(draftContext());
    const standby = live ? [] : [...(getStandbyAgents(target)?.standby || []), ...textAgents.filter(config => !placedIds.has(config.id) && !scraps.has(config.id))
      .map(config => ({ id: config.id, title: config.title, enabled: config.enabled === true, custom: true, manual: getAgentInvocationMode(config) === 'manual' }))];
    panel.dataset.hopPlace = place;
    const iconBtn = (action, label, attrs = '') => button(action, label, `class="hop-icon-only" title="${e(label)}" aria-label="${e(label)}" ${attrs}`);
    // 说明用浮现文字（桌面悬停、手机点一下），不弹窗；不加 title，免得和浮层重复
    const helpText = [t('同行并行，整行结束后进入下一行。长方形内的各项共享一次请求。'),
      place === 'writing' ? t('按住房子查看落点；中心融合，左右并行，上下换行。手机可长按或拖动右上角把手。') : t('聊天模式跟随当前设置；点击房子配置 Agent。'),
      ...(place === 'writing' ? [t('空格开始拖动，方向键选择落点，回车放置，Esc 取消。保存后用于后续轮次。')] : [])].join('\n');
    const helpBtn = button('help', t('说明'), `class="hop-icon-only" aria-label="${e(t('说明'))}" data-help-title="${e(t('从上往下'))}" data-help="${e(helpText)}" data-help-mode="tap"`);
    const saveLabel = dirty ? t('保存并启用') : (resolved.source === 'derived' ? t('保存并启用') : t('已启用'));
    const saveDisabled = !editable || (!dirty && resolved.source !== 'derived');
    panel.innerHTML = `<div class="hop-board-toolbar"><div class="hop-header">
        <span class="hop-source${dirty ? ' is-dirty' : ''}${resolved.source !== 'derived' ? ' is-custom' : ''}" title="${e(dirty ? t('未保存') : sourceLabel(resolved.source))}"><i aria-hidden="true"></i>${e(place === 'writing' ? t('创意写作') : t('聊天模式'))}<span class="hop-sr">${e(dirty ? t('未保存') : sourceLabel(resolved.source))}</span></span>
        <div class="hop-scope"><span class="hop-scope-label has-help" data-help-mode="tap" data-help="${e(place === 'writing' ? t('优先采用当前角色卡的编排，其次是所有角色卡的默认编排。此处管理流程；Agent 卡片内的共享配置沿用各自范围。') : t('按所选聊天范围展示当前设置推导的流程；点击房子可查看对应 Agent 配置。'))}">${e(t('流程作用范围'))}</span><select data-hop-target aria-label="${e(t('流程作用范围'))}" ${saving || busy() || live ? 'disabled' : ''}>${scopeOptions()}</select></div>
        <span class="hop-scope-source">${e(dirty ? t('未保存') : place === 'chat' ? t('设置推导') : sourceLabel(resolved.source))}</span>
        <span class="hop-spacer"></span>
        ${busy() ? button('stop', t('停止'), 'class="hop-danger"') : ''}
        ${place === 'writing' && latest ? (live ? iconBtn('edit-mode', t('编辑'), 'aria-pressed="true"') : iconBtn('run-mode', t('上一轮'), 'aria-pressed="false"')) : ''}
        ${iconBtn('more', t('更多'), 'aria-haspopup="menu" aria-expanded="false"')}
        ${iconBtn('library', t('全部 Agent'))}
        ${helpBtn}
        ${embedded ? '' : iconBtn('close', t('关闭'))}
        ${place === 'writing' ? `<div class="hop-menu hop-secondary-actions" role="menu" hidden>${button('settings', t('执行规则'), 'role="menuitem"' + (editable ? '' : ' disabled'))}${button('transfer', t('导入 / 导出'), 'role="menuitem"' + (editable ? '' : ' disabled'))}${button('reset', target !== 'global' ? t('跟随默认') : t('恢复推导'), 'role="menuitem"' + (editable ? '' : ' disabled'))}</div>`
    : `<div class="hop-menu hop-secondary-actions" role="menu" hidden>${button('transfer', t('导入 / 导出'), 'role="menuitem"' + (workflowTransfer && !busy() && !saving ? '' : ' disabled'))}</div>`}
      </div></div>
      ${renderHopscotchCourt(live ? latest.board : draft, { editable, states, place, activation, inputSuggestion: live ? null : getInputSuggestion(target), inputAgents: live ? [] : getInputAgents(target), agentRuns: getAgentRuns(), canAddInput: !live && !saving && Boolean(createInputAgent), formatReview: live ? null : getFormatReview(target), standby, canAddStandby: !live && !saving && place === 'writing' && (dirty || resolved.source !== 'derived') && Boolean(createTextAgent) && textAgents.length < 8, typeTray: trayHouseId ? { houseId: trayHouseId, choices: houseChoices(trayHouseId) } : null, status: live ? latest.result?.status || 'running' : '' })}
      <p class="hop-error" role="alert">${e(error)}</p>
      ${place === 'writing' ? `<div class="hop-footer hop-board-footer">${undoStack.length ? iconBtn('undo', t('撤销上一步'), editable ? '' : 'disabled') : ''}${button('save', saveLabel, `class="hop-primary" ${saveDisabled ? 'disabled' : ''}`)}</div>` : ''}`;
    fitCourt();
    const targetSelect = panel.querySelector('[data-hop-target]');
    if (targetSelect) targetSelect.onchange = event => {
      const next = event.target.value;
      if (dirty) {
        event.target.value = target;
        frameDetail(t('未保存的修改'), `<p>${e(t('切换范围将丢弃当前草稿。'))}</p>`, button('discard-switch', t('丢弃并切换')));
        detail.querySelector('[data-action="discard-switch"]').onclick = () => { settleDraftAgents(); target = next; loadDraft(); closeDetail(); render(); onScopeChange(); };
      } else { target = next; loadDraft(); render(); onScopeChange(); }
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
    const variableActivity = activation.variable || {};
    const variableInfo = variableCard ? renderHopscotchVariableInfo(variableActivity, active, { execution: member ? '' : house.kind === 'variable_rules' ? 'rules' : 'standalone' }) : '';
    const canToggle = editable && (member || house.kind !== 'body');
    const unavailable = active.requested && !active.enabled && active.reason !== 'manual_only';
    const flowLabel = active.invocationMode ? t('参与自动流程') : t('参与此流程');
    const flowOn = active.invocationMode ? active.requested !== false : active.enabled;
    const toggle = canToggle ? `<div class="agent-center-setting-row is-status hop-flow-toggle-row"><span class="agent-center-setting-label has-help" data-help-mode="tap" data-help="${e(unavailable ? hopscotchInactiveLabel(active.reason) : t('保存后用于后续轮次，房子的位置与配置保留。'))}">${e(flowLabel)}</span><span class="agent-center-setting-value">${e(active.invocationMode === 'manual' ? t('手动') : active.enabled ? t('已启用') : hopscotchInactiveBadgeLabel(active.reason))}</span><button type="button" class="agent-center-switch${flowOn ? ' is-on' : ''}" role="switch" aria-checked="${flowOn}" aria-label="${e(flowLabel)}" data-action="toggle-enabled" ${unavailable ? 'disabled' : ''}><span class="agent-center-switch-track" aria-hidden="true"><span class="agent-center-switch-thumb"></span></span></button></div>` : '';
    const hints = { body: t('融合项与正文共享一次请求。'), custom_prompt: t('每次执行通常增加 1 次文本模型请求。'), memory_table: t('独立请求更新记忆，保留频率规则。'), summary_compaction: t('未达到压缩阈值时跳过。'), format_review: t('生成待确认候选，不自动替换正文。'), image_generation: t('读取正文图片提示，等待所有图片完成。') };
    const front = state ? `<p class="hop-card-status">${e(hopscotchStatusLabel(getHopscotchHouseDisplayStatus(state)))}${isHopscotchMaintenanceRunning(state) ? ` · ${e(t('整理摘要中'))}` : ''}${state.reason ? ` · ${e(state.enabled === false ? hopscotchInactiveLabel(state.reason) : state.reason)}` : ''}</p>
        <p class="hop-hint">${e(state?.usage?.latencyMs != null ? `${state.usage.latencyMs} ms` : '')} · ${e(t('用量'))}: ${e(state?.usage?.providerUsage ? JSON.stringify(state.usage.providerUsage) : t('未知'))}</p>
        <pre class="hop-output" data-i18n-skip="true">${e(state?.artifact?.text || state?.error || (state?.artifact ? JSON.stringify(state.artifact, null, 2) : ''))}</pre>
        ${state?.childResults?.length ? `<pre class="hop-output" data-i18n-skip="true">${e(JSON.stringify(state.childResults, null, 2))}</pre>` : ''}`
      : `<span class="hop-card-mark" aria-hidden="true">${String(number).padStart(2, '0')}</span><p class="hop-card-name" data-i18n-skip="true">${e(hopscotchHouseLabel(house))}</p><p class="hop-hint">${e(hints[house.kind] || '')}</p>${house.fused?.length ? `<p class="hop-fused">${house.fused.map(kind => `<span><i></i>${e(hopscotchFusedLabel(kind))}</span>`).join('')}</p>` : ''}`;
    const cfg = house.config || {};
    // 「提示词 | 套用预设」：预览／试运行按卡片当前（还没点「完成」）的设置组请求
    const bindPresetSource = root => bindAgentPresetSourceControls(root, {
      services: presetServices,
      getContext: () => ({ config: house.kind === 'custom_prompt' ? customUpdate().patch.config : independentConfig() }),
    });
    const independentModel = !member && ['image_prompt', 'variable'].includes(house.kind);
    let content = '';
    if (member) {
      content = '';
    } else if (house.kind === 'custom_prompt') {
      // 套用预设且预设还在时，提示词与系统提示词不发送，先收起（切回提示词时原文还在）。
      const presetView = presetServices && cfg.presetId ? presetServices.describePreset(cfg.presetId) : null;
      const hidePrompt = cfg.promptSource === 'preset' && presetView?.ok ? 'hidden' : '';
      const presetSource = presetServices ? renderAgentPresetSourceControl({
        scope: `house-${id}`, kind: 'custom_house', mode: cfg.promptSource, presetId: cfg.presetId, view: presetView,
      }) : '';
      content = `${field('label', t('名称'), house.label)}<p class="hop-hint" data-i18n-skip="true">${e(id)}</p>
        ${presetSource}
        <label data-agent-preset-prompt-part ${hidePrompt}>${e(t('提示词'))}<textarea name="prompt" data-i18n-skip="true">${e(cfg.prompt)}</textarea></label>
        <p class="hop-hint" data-i18n-skip="true" data-agent-preset-prompt-part ${hidePrompt}>{{user_input}} · {{body}} · {{house:id}} · {{char}} · {{user}}</p>
        <details><summary>${e(t('更多设置'))}</summary><label data-agent-preset-prompt-part ${hidePrompt}>${e(t('系统提示词'))}<textarea name="systemPrompt" data-i18n-skip="true">${e(cfg.systemPrompt)}</textarea></label>
        ${select('model', t('模型配置'), option('', t('跟随当前'), cfg.modelMode === 'profile' ? cfg.modelProfileId : '') + getProfiles().map(profile => option(profile.id, profile.name, cfg.modelProfileId)).join(''))}
        ${field('modelOverride', t('模型覆盖'), cfg.modelOverride)}
        <div class="hop-fields">${select('includeContext', t('上下文'), [['none', t('无')], ['recent', t('最近对话')], ['full', t('全部已载入对话')]].map(([v, l]) => option(v, l, cfg.includeContext)).join(''))}${field('recentMessageCount', t('最近消息数'), cfg.recentMessageCount, 'number', 'min="1" max="50"')}${field('contextTokenBudget', t('输入预算（估算 token）'), cfg.contextTokenBudget, 'number', 'min="100" max="32000"')}${field('maxTokens', t('最大输出 token'), cfg.maxTokens, 'number', 'min="16" max="8192"')}</div></details>
        ${select('outputMode', t('产物'), option('context', t('资料（可供后续引用）'), cfg.output.mode) + option('note', t('附注（只读建议）'), cfg.output.mode))}
        <label class="hop-check"><input type="checkbox" name="injectIntoBody" ${cfg.output.injectIntoBody ? 'checked' : ''}>${e(t('注入正文（仅前置资料）'))}</label><p class="hop-hint">${e(t('每次执行通常增加 1 次文本模型请求。'))}</p>`;
    } else if (house.kind === 'body') {
      content = `<div class="agent-center-agent-settings">${HOPSCOTCH_FUSED_KINDS.map(kind => `<div class="agent-center-setting-row hop-fusion-setting"><span class="agent-center-setting-label">${e(hopscotchFusedLabel(kind))}</span><button type="button" class="agent-center-switch${house.fused.includes(kind) ? ' is-on' : ''}" role="switch" aria-checked="${house.fused.includes(kind)}" aria-label="${e(`${t('融合')} · ${hopscotchFusedLabel(kind)}`)}" data-action="fused:${kind}"><span class="agent-center-switch-track" aria-hidden="true"><span class="agent-center-switch-thumb"></span></span></button></div>`).join('')}</div>`;
    } else {
      content = `<p class="hop-hint">${e(hints[house.kind] || '')}</p>`;
    }
    // 图片提示拖出成单独的房子时可套用预设（规则仍在 AC 的图片提示卡里；套用时不用那份规则）
    if (house.kind === 'image_prompt' && !member && presetServices) {
      const imagePresetView = cfg.presetId ? presetServices.describePreset(cfg.presetId) : null;
      content += renderAgentPresetSourceControl({ scope: `house-${id}`, kind: 'image_prompt_house', mode: cfg.promptSource, presetId: cfg.presetId, view: imagePresetView, limitValue: '4096' });
    }
    if (independentModel) content += `<div class="agent-center-agent-settings"><div class="agent-center-setting-row is-model"><span class="agent-center-setting-label">${e(t('模型配置'))}</span><select name="model" aria-label="${e(t('模型配置'))}">${option('', t('跟随正文'), cfg.modelMode === 'profile' ? cfg.modelProfileId : '')}${getProfiles().map(profile => option(profile.id, profile.name, cfg.modelProfileId)).join('')}</select></div><div class="agent-center-setting-row is-model"><span class="agent-center-setting-label">${e(t('模型覆盖'))}</span><input class="agent-center-agent-input" name="modelOverride" aria-label="${e(t('模型覆盖'))}" value="${e(cfg.modelOverride || '')}"></div></div>`;
    // 摘要压缩使用专用压缩提示，不能把记忆表格模板冒充其共享配置。
    const fusedAgents = { memory_table: 'memory_table_agent', image_prompt: 'image_director' };
    const agentId = house.kind === 'text_edit' ? house.config.agentId : variableCard ? '' : member ? fusedAgents[member] : ({ memory_table: 'memory_table_agent', format_review: 'reply_check', image_generation: 'image_director', image_prompt: 'image_director' })[house.kind];
    const typeChips = editable && !member && isHopscotchHouseDraft(house) ? renderHopscotchTypeTray(id, houseChoices(id)) : '';
    const fields = `<fieldset class="hop-card-fields" data-agent-preset-area ${editable ? '' : 'disabled'}>${typeChips ? `<div class="hop-card-type">${typeChips}</div>` : ''}${content}</fieldset>`;
    const removeButton = editable && house.kind !== 'body' ? button('remove', t('删除房子'), `class="agent-center-icon-button hop-icon-only hop-remove" title="${e(t('删除房子'))}" aria-label="${e(t('删除房子'))}"`) : '';
    const footer = editable ? `${house.kind === 'custom_prompt' ? button('copy', t('复制'), mountAgentCard ? 'class="agent-center-card-action"' : '') : ''}<span class="hop-spacer"></span>${button('apply', t('完成'), mountAgentCard ? 'class="agent-center-card-action is-primary"' : 'class="hop-primary"')}` : '';
    if (mountAgentCard) {
      releaseSharedConfig();
      detailEpoch++;
      detail.onclick = null;
      detail.className = 'hop-detail hop-house-detail hop-agent-detail';
      const boardContent = doc.createElement('div');
      boardContent.className = 'hop-board-card-controls';
      const workflowHelp = house.kind === 'body' && !member ? hints.body : t('保存后用于后续轮次，房子的位置与配置保留。');
      // 位置靠拖拽调整；只有真正可编辑的房子设置才成段显示，纯说明的房子只留一行提示。
      const hasHouseSettings = Boolean(typeChips) || house.kind === 'custom_prompt' || (house.kind === 'body' && !member) || independentModel;
      const settingsSection = hasHouseSettings
        ? `<div class="agent-center-agent-section"><div class="agent-center-agent-section-title has-help" data-help-mode="tap" data-help="${e(workflowHelp)}">${e(house.kind === 'body' && !member ? t('融合') : t('房子设置'))}</div>${fields}</div>`
        : content ? `<div class="agent-center-agent-section">${fields}</div>` : '';
      // 防截断传输存在模型设置档里、一拨就生效，不进画板草稿，所以另起一区
      const bodyTransportSection = place === 'writing' && house.kind === 'body' && !member && bodyToolTransport
        ? renderBodyToolTransportSection(bodyToolTransport.describe(sid)) : '';
      boardContent.innerHTML = `${toggle}${variableInfo}${place === 'writing' ? `${settingsSection}${bodyTransportSection}${footer ? `<div class="agent-center-card-actions hop-card-actions">${footer}</div>` : ''}` : ''}`;
      if (bodyTransportSection) bindBodyToolTransportSection(boardContent, { setting: bodyToolTransport, getSessionId: () => sid });
      bindBoardSelects(boardContent);
      bindPresetSource(boardContent);
      const previewSessionId = sid, previewPlace = place;
      sharedConfig = mountAgentCard(detail, {
        agentId, configScope: target === 'global' ? 'global' : 'local', card: variableCard ? { ...buildHopscotchVariableCard(variableActivity, active), ...(house.kind === 'variable_rules' ? { title: hopscotchHouseLabel(house) } : {}) } : { id: house.kind, title: hopscotchHouseLabel(house), summary: hints[house.kind], detail: [hints[house.kind]], category: place === 'writing' ? 'creative' : 'chat', accent: house.kind === 'summary_compaction' ? 'summary' : 'dialogue', implemented: true, enabled: true },
        workflowState: active,
        frontExtra: toggle + (variableCard ? variableInfo + (state && !member ? `<div class="agent-center-agent-section">${front}</div>` : '') : member ? '' : `<span class="hop-card-mark">${String(number).padStart(2, '0')}</span>` + (state ? `<div class="agent-center-agent-section">${front}</div>` : '')),
        toolbarExtra: member ? '' : removeButton,
        fusedConfigs: house.kind === 'body' && !member ? house.fused.map(kind => ({ id: kind, label: hopscotchFusedLabel(kind), agentId: fusedAgents[kind] })) : [],
        onOpenFused: async kind => {
          if (sharedConfig?.hasDraft() && !await confirmSharedDiscard()) return;
          openHouse(id, true, kind);
        },
        buildPromptPreview: !turn && (agentId || house.kind === 'body') && buildPromptPreview
          ? promptDraft => buildPromptPreview({ sessionId:previewSessionId, place:previewPlace, agentId, house, member, draft:promptDraft }) : null,
        // 记忆与变量的写入预览并入这两个房子（与原“预览记忆和变量变更”是同一开关）
        featureSwitches: getWritePreviewSwitch() && (variableCard || member === 'memory_table' || house.kind === 'memory_table') ? ['write_preview'] : [],
        content: place === 'writing' || variableCard ? boardContent : null, configure: configure && !turn, readOnly: Boolean(turn) || busy() || saving, onClose: () => { void requestDetailClose(); },
      });
      showDetail();
    } else {
      frameDetail(hopscotchHouseLabel(house), fields, footer, front);
      bindPresetSource(detail);
      detail.querySelector('.hop-header .hop-spacer').insertAdjacentHTML('afterend', removeButton);
      if (configure) detail.querySelector('[data-action="flip"]').click();
    }
    // 图片提示／变量房子的模型设置（图片提示另带「套用预设」）
    const independentConfig = () => {
      const profile = detail.querySelector('[name="model"]')?.value || '';
      const presetControl = detail.querySelector('[data-agent-preset-source]');
      const presetSource = presetControl ? readAgentPresetSource(presetControl) : { mode: cfg.promptSource, presetId: cfg.presetId };
      return { ...cfg, modelMode: profile ? 'profile' : 'follow_current', modelProfileId: profile, modelOverride: detail.querySelector('[name="modelOverride"]')?.value || '',
        ...(house.kind === 'image_prompt' ? { promptSource: presetSource.mode, presetId: presetSource.presetId } : {}) };
    };
    const customUpdate = () => {
      const value = name => detail.querySelector(`[name="${name}"]`).value;
      const presetControl = detail.querySelector('[data-agent-preset-source]');
      const presetSource = presetControl ? readAgentPresetSource(presetControl) : { mode: cfg.promptSource, presetId: cfg.presetId };
      return { type: 'update', id, patch: { label: value('label'), config: {
        ...cfg, promptSource: presetSource.mode, presetId: presetSource.presetId,
        prompt: value('prompt'), systemPrompt: value('systemPrompt'), modelMode: value('model') ? 'profile' : 'follow_current', modelProfileId: value('model'), modelOverride: value('modelOverride'), includeContext: value('includeContext'),
        recentMessageCount: Number(value('recentMessageCount')), contextTokenBudget: Number(value('contextTokenBudget')), maxTokens: Number(value('maxTokens')),
        output: { mode: value('outputMode'), injectIntoBody: detail.querySelector('[name="injectIntoBody"]').checked },
      } } };
    };
    detail.onclick = event => {
      const control = event.target.closest('[data-action], [data-hop-retype]');
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
      if (!control || (!action && !control.dataset.hopRetype) || control.matches(':disabled') || action === 'close-detail' || action === 'flip' || !editable || busy() || saving) return;
      if (sharedConfig?.hasDraft()) { showError(t('请先保存共享设置，或关闭卡片放弃修改。')); return; }
      if (control.dataset.hopRetype) {
        void applyChoice(id, control.dataset.hopRetype).then(changed => { if (changed && detail.open) { closeDetail(); openHouse(id, true); } });
        return;
      }
      let operation;
      if (action === 'toggle-enabled') {
        const flipped = Boolean(detail.querySelector('.agent-center-floating-card.is-flipped'));
        const reopen = () => { closeDetail(); openHouse(id, flipped, member); };
        if (active.requested === false && !member) {
          // 先收下卡片里尚未点「完成」的提示词，检查才看得到用户刚写的内容。
          if (house.kind === 'custom_prompt' && !edit(customUpdate())) return;
          void enableHouse(id, reopen);
          return;
        }
        if (edit({ type: 'toggle', id, member, enabled: active.requested === false })) reopen();
        return;
      } else if (action === 'apply') {
        if (independentModel) {
          if (edit({ type: 'update', id, patch: { config: independentConfig() } })) closeDetail();
          return;
        }
        if (house.kind !== 'custom_prompt') { closeDetail(); refreshSettings(); return; }
        operation = customUpdate();
      } else if (action.startsWith('fused:')) {
        const kind = action.slice(6);
        operation = { type: 'fuse', kind, enabled: house.kind !== 'body' || !house.fused.includes(kind) };
      } else if (action.startsWith('move:')) operation = { type: 'move', id, rowIndex: Number(action.slice(5)) };
      else if (action === 'new-before' || action === 'new-after') operation = { type: 'move', id, rowIndex: rowIndex + (action === 'new-after' ? 1 : 0), newRow: true };
      else if (action === 'left' || action === 'right') operation = { type: 'move', id, rowIndex, houseIndex: Math.max(0, board.rows[rowIndex].houses.indexOf(house) + (action === 'left' ? -1 : 1)) };
      else if (action === 'remove' && house.kind === 'text_edit' && house.config?.agentId === RECAP_AGENT_ID) {
        // 默认的前情提要：删除即删除它的 Agent，之后不再自动挂回正文旁。
        void (async () => {
          const isCurrent = captureView();
          if (!await confirm({ title: t('删除前情提要'), message: t('删除后不再自动出现在正文旁；需要时可从「+」的模板加回。'), confirmText: t('删除'), danger: true }) || !isCurrent()) return;
          const result = await removeTextAgent?.(RECAP_AGENT_ID, { scope: configScope() });
          if (!isCurrent()) return;
          if (result && !result.ok) { showError(t(result.message || '删除失败')); return; }
          // 它原本只是补挂在板上；没有其他未保存修改时重新载入即可，不留下空的草稿。
          if (!dirty) { closeDetail(); loadDraft(); render(); }
          else if (edit({ type: 'remove', id })) closeDetail();
        })();
        return;
      }
      else if (action === 'copy' || action === 'remove') operation = { type: action, id };
      if (operation && edit(operation)) { closeDetail(); if (operation.type === 'fuse') openHouse(id, true); }
    };
  };
  const configScope = () => target === 'global' ? 'global' : 'local';
  // 本次草稿里切换出来又没用上的 Agent 不作为「已有 Agent」列出，草稿结束时清理。
  const houseChoices = id => { const scraps = draftAgents.pending(draftContext());
    return listHopscotchHouseChoices(draft, id, { textAgents: listTextAgents(target), canCreateAgent: Boolean(createTextAgent) }).filter(choice => choice.group !== 'agent' || !scraps.has(choice.agentId)); };
  // 异步创建或保存 Agent 后，只在同一会话、范围与视图仍有效时写回草稿。
  const captureView = () => { const context = { sid, place, target, viewEpoch };
    return () => context.viewEpoch === viewEpoch && context.sid === sid && context.sid === String(getSessionId() || '')
      && context.place === place && context.place === getPlace() && context.target === target && !busy() && !saving; };
  // 「+」不弹窗：原位放下一个停用的自定义房子并展开类型托盘；此处放不下自定义房子时退到第一个可放的内建房子。
  const addDraftHouse = (rowIndex, newRow, anchorKind = '') => {
    if (!draft || place !== 'writing' || busy() || saving || sid !== String(getSessionId() || '')) return;
    const placement = { rowIndex, newRow, anchorKind };
    const before = new Set(draft.rows.flatMap(row => row.houses).map(house => house.id));
    const kinds = ['custom_prompt', ...HOPSCOTCH_HOUSE_CATALOG.map(item => item.kind).filter(kind => !['body', 'summary_compaction', 'text_edit', 'custom_prompt', 'variable_rules'].includes(kind))];
    const kind = kinds.find(item => editHopscotchBoard(draft, { type: 'add', kind: item, house: { enabled: false }, ...placement }).ok);
    if (!kind) { showError(t('此处已达编排上限，可先移走或移除房子。')); return; }
    if (!edit({ type: 'add', kind, house: { enabled: false }, ...placement })) return;
    // 在格式修复占位旁新增时，格式修复会一起纳入草稿；托盘只对准刚放下的停用房子。
    trayHouseId = draft.rows.flatMap(row => row.houses).find(house => !before.has(house.id) && house.kind === kind && house.enabled === false)?.id || '';
    render();
    panel.querySelector('.hop-type-tray [aria-pressed="true"], .hop-type-tray button')?.focus({ preventScroll: true });
  };
  const linkedAgentFor = (house, agents) => {
    const id = house.kind === 'text_edit' ? house.config?.agentId : houseAgents.get(house.id);
    return agents.find(config => config.id === id) || null;
  };
  // 切换类型或套用模板；房子保持停用，需要 Agent 的类型复用或新建 Agent。
  const applyChoice = async (houseId, key) => {
    const choice = houseChoices(houseId).find(item => item.key === key);
    const house = draft?.rows.flatMap(row => row.houses).find(item => item.id === houseId);
    if (!choice || !house || choice.current || retyping) return false;
    const isCurrent = captureView(), scope = configScope();
    retyping = true;
    try {
      if (choice.group === 'type' && choice.kind === 'custom_prompt') return edit({ type: 'retype', id: houseId, kind: 'custom_prompt', house: {} });
      if (choice.group === 'template' && choice.kind !== 'text_edit') return edit({ type: 'retype', id: houseId, kind: choice.kind, house: choice.house || {} });
      if (choice.group === 'agent') {
        const agent = listTextAgents(target).find(config => config.id === choice.agentId);
        return Boolean(agent) && edit({ type: 'retype', id: houseId, kind: 'text_edit', house: { label: agent.title, config: { agentId: agent.id } } });
      }
      const invocationMode = getHopscotchHouseType(choice.type)?.invocationMode || 'manual';
      let agent = choice.group === 'type' ? linkedAgentFor(house, listTextAgents(target)) : null;
      if (agent && getAgentInvocationMode(agent) !== invocationMode) {
        const result = await patchTextAgent?.(agent.id, { invocationMode }, { scope });
        if (!isCurrent()) return false;
        if (!result?.ok) { showError(t(result?.message || '保存失败')); return false; }
        draftAgents.restamp(agent.id);
      } else if (!agent) {
        const result = await createTextAgent?.({ scope, config: choice.template === 'recap' ? buildRecapAgentConfig() : { invocationMode } });
        if (!isCurrent()) return false;
        if (!result?.ok) { showError(t(result?.message || '创建失败')); return false; }
        agent = { id: result.id, title: result.config?.title || '' };
        draftAgents.track(result.id, { context: draftContext(), target, scope });
        if (choice.group === 'type') houseAgents.set(houseId, result.id);
      }
      if (house.kind === 'text_edit' && house.config?.agentId === agent.id) { render(); return true; }
      return edit({ type: 'retype', id: houseId, kind: 'text_edit', house: { label: agent.title, config: { agentId: agent.id } } });
    } catch (err) { if (isCurrent()) showError(err.message || t('操作失败')); return false; }
    finally { retyping = false; }
  };
  const showProblem = problem => {
    showError(problem.message);
    const fieldEl = problem.field ? detail.querySelector(`[name="${problem.field}"]`) : null;
    if (!fieldEl) return;
    fieldEl.classList.add('is-invalid');
    fieldEl.setAttribute('aria-invalid', 'true');
    fieldEl.addEventListener('input', () => { fieldEl.classList.remove('is-invalid'); fieldEl.removeAttribute('aria-invalid'); }, { once: true });
    fieldEl.focus({ preventScroll: false });
  };
  // 开启前确认房子能运作；不能时指出缺什么（字段高亮或配置服务给出的原因）。
  const enableHouse = async (id, reopen) => {
    const isCurrent = captureView();
    let check = checkHopscotchHouseEnable(draft, id, { textAgents: listTextAgents(target), resolveActivation });
    if (!check.ok) { showProblem(check); return; }
    if (check.enableAgentId) {
      if (!patchTextAgent) { showProblem({ message: t('请先在 Agent 配置中开启') }); return; }
      const result = await patchTextAgent(check.enableAgentId, { enabled: true }, { scope: configScope() });
      if (!isCurrent()) return;
      if (!result?.ok) { showProblem({ message: t(result?.message || '保存失败') }); return; }
      check = checkHopscotchHouseEnable(draft, id, { textAgents: listTextAgents(target), resolveActivation });
      if (!check.ok) { showProblem(check); return; }
    }
    if (edit({ type: 'toggle', id, enabled: true })) reopen();
  };
  const save = async (reset = false) => {
    if (saving) return;
    if (!reset && findManualHopscotchDependencies(draft, resolveActivation(draft)).length) {
      showError(t('自动流程引用了仅手动的 Agent，请为上游开启自动调用或移除引用'));
      return;
    }
    const epoch = viewEpoch;
    saving = true;
    render();
    try {
      const result = target === 'session' ? await boardStore.setSessionOverride(sid, reset ? null : draft)
        : target === 'persona' ? await boardStore.setPersonaBoard(reset ? null : draft, { sessionId: sid }) : await boardStore.setGlobalBoard(reset ? null : draft);
      if (epoch !== viewEpoch) return;
      if (!result?.ok) throw new Error(result?.reason || t('保存失败'));
      settleDraftAgents(reset ? new Set() : placedAgents(draft));
      if (!reset) await enable(true);
      if (epoch === viewEpoch) loadDraft();
    } catch (err) { if (epoch === viewEpoch) error = err.message || String(err); }
    finally { if (epoch === viewEpoch) { saving = false; render(); } }
  };
  const close = () => {
    // 关闭即放弃草稿（有改动时已先确认）。
    if (draft) settleDraftAgents();
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
    const retype = event.target.closest('[data-hop-retype]');
    if (retype) { if (!retype.disabled) void applyChoice(retype.closest('[data-hop-tray]')?.dataset.hopTray || '', retype.dataset.hopRetype); return; }
    const typeTrigger = event.target.closest('[data-hop-type-trigger]');
    if (typeTrigger) {
      const id = typeTrigger.closest('[data-hop-house]')?.dataset.hopHouse || '';
      trayHouseId = trayHouseId === id ? '' : id;
      render();
      return;
    }
    // 托盘之外的点击收起托盘，再照常处理这次点击。
    if (trayHouseId && !event.target.closest('.hop-type-tray')) { trayHouseId = ''; render(); }
    const inputAgent = event.target.closest('[data-hop-input-agent]');
    if (inputAgent) { openInputAgent?.(inputAgent.dataset.hopInputAgent, { scope: target === 'global' ? 'global' : 'local' }); return; }
    const addInput = event.target.closest('[data-hop-add-input]');
    if (addInput && createInputAgent) {
      const captured = JSON.stringify([sid, place, target]);
      addInput.disabled = true;
      void (async () => {
        try {
          const result = await createInputAgent({ scope: target === 'global' ? 'global' : 'local' });
          if (captured !== JSON.stringify([sid, place, target])) return;
          if (!result?.ok) { showError(result?.message || t('创建失败')); return; }
          render(); openInputAgent?.(result.id, { scope: target === 'global' ? 'global' : 'local' });
        } catch (err) { if (captured === JSON.stringify([sid, place, target])) showError(err.message); }
        finally { addInput.disabled = false; }
      })(); return;
    }
    const addStandby = event.target.closest('[data-hop-add-standby]');
    if (addStandby && createTextAgent) {
      const isCurrent = captureView(), scope = configScope();
      addStandby.disabled = true;
      void (async () => {
        try {
          const result = await createTextAgent({ scope, config: { invocationMode: 'manual' } });
          if (!isCurrent()) return;
          if (!result?.ok) { showError(t(result?.message || '创建失败')); return; }
          render(); openTextAgent?.(result.id, { scope });
        } catch (err) { if (isCurrent()) showError(err.message); }
        finally { addStandby.disabled = false; }
      })(); return;
    }
    const standbyAgent = event.target.closest('[data-hop-standby]');
    if (standbyAgent) {
      const id = standbyAgent.dataset.hopStandby;
      if (id.startsWith('text-edit:')) openTextAgent?.(id, { scope: configScope() });
      else openStandbyAgent?.(id);
      return;
    }
    if (event.target.closest('[data-hop-input-suggestion]')) { openInputSuggestion?.(); return; }
    if (event.target.closest('[data-hop-format-review]')) { openFormatReview?.(); return; }
    const cell = event.target.closest('[data-hop-house]');
    if (cell) { openHouse(cell.dataset.hopHouse, true, event.target.closest('[data-hop-part]')?.dataset.hopPart); return; }
    const add = event.target.closest('[data-hop-add]');
    if (add) { addDraftHouse(Number(add.dataset.hopAdd), add.dataset.hopNew === '1', add.dataset.hopAnchor); return; }
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
    // 聊天模式只有「导入 / 导出」（Agent 配置），其余操作属于创意写作的板子
    if (place !== 'writing' && action !== 'transfer') return;
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
      const legacyBoardImport = (text) => {
        try {
          const result = validateHopscotchBoard(JSON.parse(text));
          if (!result.ok) throw new Error(result.errors.map(item => item.message || item.code).join('\n'));
          const missing = result.board.rows.flatMap(row => row.houses).filter(h => h.config?.modelMode === 'profile' && !getProfiles().some(p => p.id === h.config.modelProfileId));
          if (missing.length) throw new Error(t('指定的模型配置不存在'));
          undoStack.push({ board: cloneData(draft), dirty }); draft = result.board; dirty = true; closeDetail(); render();
        } catch (err) { showError(err.message); }
      };
      if (!workflowTransfer) {
        frameDetail(t('板 JSON'), `<p class="hop-hint">${e(t('复制下方内容导出；粘贴后导入为草稿，不立即生效。'))}</p><textarea name="boardJson" rows="12" data-i18n-skip="true">${e(JSON.stringify(draft, null, 2))}</textarea>`, button('import', t('导入草稿')));
        detail.querySelector('[data-action="import"]').onclick = () => legacyBoardImport(detail.querySelector('[name="boardJson"]').value);
        return;
      }
      void openHopscotchWorkflowTransfer({
        detail, frameDetail, button, option, select, e, t, showError, confirm,
        workflowTransfer, place, target, getDraft: () => draft, isDirty: () => dirty,
        legacyBoardImport,
        // 导入或撤销后：切到导入的范围并重新载入（未保存的草稿已在导入前确认放弃）
        onImported: async (nextTarget) => {
          if (draft && place === 'writing') settleDraftAgents();
          target = nextTarget === 'global' ? 'global' : (place === 'writing' && boardStore.getPersonaBoard ? 'persona' : 'session');
          loadDraft();
          render();
          onScopeChange();
        },
      });
    }
  };
  panel.addEventListener('cancel', event => {
    event.preventDefault();
    if (requestClose(close)) close();
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && trayHouseId && !detail.open) {
      event.preventDefault(); event.stopPropagation();
      const id = trayHouseId; trayHouseId = ''; render();
      [...panel.querySelectorAll('[data-hop-house]')].find(node => node.dataset.hopHouse === id)?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Escape' && !panel.querySelector('.hop-menu')?.hidden) { event.preventDefault(); event.stopPropagation(); closeMenu(); panel.querySelector('[data-action="more"]')?.focus(); }
  });
  panel.ondragstart = event => event.preventDefault();
  const initialize = () => {
    place = getPlace() === 'chat' ? 'chat' : 'writing';
    sid = String(getSessionId() || '');
    // 创作默认编辑当前角色卡，来源角标说明是否继承所有角色卡的编排。
    target = place === 'writing'
      ? (sid && boardStore.getPersonaBoard ? 'persona' : sid && boardStore.getSessionOverride?.(sid) ? 'session' : 'global')
      : (sid ? 'session' : 'global');
    mode = busy() ? 'run' : 'edit'; loadDraft();
    // 上次草稿没走完（如页面重载）留下的 Agent：已保存进自定义板的保留，其余未改过的清理。
    const resolved = resolveBoard();
    settleDraftAgents(resolved.source === 'derived' ? new Set() : placedAgents(resolved.board));
    render();
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
  const onInputSuggestionChanged = event => {
    if (!(['text_completion', 'reply_check'].includes(event?.detail?.id) || /^(input-agent|text-edit):/.test(String(event?.detail?.id))) || !(mounted || panel.open)) return;
    if (event.detail.id !== 'text_completion') refreshSettings();
    if (!dragController.isActive() && !saving) render();
  };
  doc.defaultView?.addEventListener('agent-feature-settings-changed', onInputSuggestionChanged);
  const onAgentRunsChanged = () => { if ((mounted || panel.open) && !detail.open && !saving && !dragController.isActive()) render(); };
  const agentRunEvents = ['agent-input-changed', 'agent-text-edit-changed'];
  agentRunEvents.forEach(type => doc.defaultView?.addEventListener(type, onAgentRunsChanged));
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
    getConfigScope: () => target === 'global' ? 'global' : 'local',
    // 截断提示通知的跳转：打开「正文生成」卡片，捲到防截断传输开关并短暂高亮
    openBodyToolTransport: async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 100));
      for (let index = 0; index < 30 && !mounted; index += 1) await wait();
      if (!mounted || place !== 'writing') return false;
      const body = draft?.rows?.flatMap(row => row.houses).find(house => house.kind === 'body');
      if (!body) return false;
      openHouse(body.id, true);
      for (let index = 0; index < 30; index += 1) {
        const section = doc.querySelector('[data-body-tool-transport]');
        if (section) {
          section.scrollIntoView({ block: 'center' });
          section.classList.add('is-attention');
          setTimeout(() => section.classList.remove('is-attention'), 2400);
          return true;
        }
        await wait();
      }
      return false;
    },
    addTextAgent: config => {
      if (!draft || !config || draft.rows.some(row => row.houses.some(h => h.config?.agentId === config.id))) return;
      const last = draft.rows.length - 1;
      edit({ type: 'add', kind: 'text_edit', house: { label: config.title, config: { agentId: config.id } }, rowIndex: last, newRow: true });
    },
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
    dispose: () => { close(); dragController.dispose(); unsubscribe(); unbindBackdrop(); resizeObserver?.disconnect?.(); doc.defaultView?.removeEventListener('app-settings-changed', onSettingsChanged); doc.defaultView?.removeEventListener('agent-feature-settings-changed', onInputSuggestionChanged); agentRunEvents.forEach(type => doc.defaultView?.removeEventListener(type, onAgentRunsChanged)); variableEvents.forEach(type => doc.defaultView?.removeEventListener(type, onVariablesChanged)); detailLayer?.remove(); detail.remove(); panel.remove(); },
  };
};
