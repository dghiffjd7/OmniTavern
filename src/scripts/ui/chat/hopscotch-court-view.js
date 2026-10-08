import { t, translateUiText } from '../../i18n/index.js';
import { getHopscotchHouseDisplayStatus } from './hopscotch-board-utils.js';
import { hopscotchInactiveLabel, resolveHopscotchActivation } from './hopscotch-activation-utils.js';
import { agentInvocationLabel } from '../../agent/agent-invocation.js';
import { agentIconMarkup } from '../../agent/agent-icons.js';
import { isHopscotchHouseDraft } from './hopscotch-house-types.js';

export const escapeHopscotchHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeHopscotchHtml;
export const hopscotchStatusLabel = status => ({ queued: t('等待'), running: t('执行中'), succeeded: t('完成'), failed: t('失败'), cancelled: t('已取消'), skipped: t('跳过'), partial: t('部分失败') })[status] || t('待出发');
export const hopscotchHouseLabel = house => house.kind === 'format_review' ? t('格式修复') : ['custom_prompt', 'text_edit'].includes(house.kind) ? house.label : house.kind === 'variable_rules' ? (house.config?.phase === 'before' ? t('发送前变量规则') : t('回复后变量规则')) : translateUiText(house.label);
export const hopscotchFusedLabel = kind => translateUiText(({ memory_table: '记忆表格', image_prompt: '图片提示', variable: '变量' })[kind] || kind);

// 图标随节点类型着色；SVG 不参与名称与点击目标的识别。
const COURT_ICONS = {
  body: '<path class="hop-glyph-wash" d="m3 10 18-7-7 18-3-8z"/><path d="m3 10 18-7-7 18-3-8zM11 13l5-5"/>',
  text_edit: '<path d="m4 17 10-10 3 3L7 20H4v-3ZM13 8l3 3M4 4h8M4 8h4M14 19h6"/>',
  custom_prompt: '<path class="hop-glyph-solid" d="M12 2.5c1.8 6 3.5 7.7 9.5 9.5-6 1.8-7.7 3.5-9.5 9.5C10.2 15.5 8.5 13.8 2.5 12c6-1.8 7.7-3.5 9.5-9.5Z"/>',
  memory_table: '<rect class="hop-glyph-wash" x="3" y="4" width="18" height="16" rx="3"/><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10M9 15h12"/>',
  image_prompt: '<path class="hop-glyph-wash" d="m4 16 1 4 4-1L20 8l-4-4Z"/><path d="m4 16 1 4 4-1L20 8l-4-4ZM13 7l4 4M4 4v4M2 6h4"/>',
  variable: '<path d="M5 4v7m0 6v3M12 4v2m0 6v8M19 4v10m0 6v0"/><circle class="hop-glyph-solid" cx="5" cy="14" r="2.5"/><circle class="hop-glyph-solid" cx="12" cy="9" r="2.5"/><circle class="hop-glyph-solid" cx="19" cy="17" r="2.5"/>',
  image_generation: '<rect class="hop-glyph-wash" x="3" y="3" width="18" height="18" rx="4"/><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m4 17 5-5 4 4 3-3 5 5"/><circle class="hop-glyph-solid" cx="16" cy="8" r="1.6"/>',
  summary_compaction: '<path class="hop-glyph-wash" d="m3 7 9-4 9 4-9 4Z"/><path d="m3 7 9-4 9 4-9 4ZM3 12l9 4 9-4M3 17l9 4 9-4"/>',
  format_review: '<circle class="hop-glyph-wash" cx="10.5" cy="10.5" r="7"/><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5m-14-10 2.5 2.5 4-4"/>',
  text_completion: '<path d="M4 5h10M4 10h6M4 15h4m5 3 6-6 3 3-6 6h-3zM16 4v4m-2-2h4"/>',
  archive_naming: '<rect class="hop-glyph-wash" x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  moment_agent: '<path class="hop-glyph-wash" d="M4 5h16v11H9l-5 4Z"/><path d="M4 5h16v11H9l-5 4ZM8 10h8M8 13h5"/>',
  manual: '<path class="hop-glyph-wash" d="M9 12V5.6a1.6 1.6 0 0 1 3.2 0V11l3.6.6a2.6 2.6 0 0 1 2.2 2.9L17.4 18a3.5 3.5 0 0 1-3.5 3h-2.6a3.5 3.5 0 0 1-2.8-1.4L5.4 16a1.5 1.5 0 0 1 2.2-2.1L9 15.2Z"/><path d="M9 15.2V5.6a1.6 1.6 0 0 1 3.2 0V11l3.6.6a2.6 2.6 0 0 1 2.2 2.9L17.4 18a3.5 3.5 0 0 1-3.5 3h-2.6a3.5 3.5 0 0 1-2.8-1.4L5.4 16a1.5 1.5 0 0 1 2.2-2.1L9 15.2ZM5.6 6.4a5 5 0 0 1 1.6-2.7M15.6 3.7a5 5 0 0 1 1.6 2.7"/>',
  recap: '<path class="hop-glyph-wash" d="M6 3h10a3 3 0 0 1 3 3v15H9a3 3 0 0 1-3-3Z"/><path d="M6 18V3h10a3 3 0 0 1 3 3v15H9a3 3 0 0 1-3-3Zm0 0a3 3 0 0 1 3-3h10M10 7h5M10 10.5h3"/>',
  toolbox: '<rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 7V4h8v3M3 12h18M10 12v3h4v-3"/>',
  finish: '<path d="m5 12 4.5 4.5L19 7"/>',
};
const courtIcon = kind => `<svg class="hop-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${COURT_ICONS[kind === 'variable_rules' ? 'variable' : kind] || COURT_ICONS.custom_prompt}</svg>`;

// 状态用边框、角标和石子表达；文字状态供辅助技术读取。
const STATUS_GLYPH = { succeeded: '✓', failed: '✕', partial: '!', cancelled: '–', skipped: '·', running: '', queued: '' };
const glyphFor = status => STATUS_GLYPH[status] ?? '';

// 「石子」所在行：第一个执行中的行；没有则最后一个已到终态的行
const resolveStoneRow = (board, states) => {
  const rows = board.rows;
  const rowStatus = rows.map(row => row.houses.map(house => getHopscotchHouseDisplayStatus(states[house.id] || {})));
  const running = rowStatus.findIndex(list => list.some(status => status === 'running'));
  if (running >= 0) return running;
  let last = -1;
  rowStatus.forEach((list, index) => { if (list.some(status => status && status !== 'queued')) last = index; });
  return last;
};

// 编辑器、运行面板共享一张板；DOM 与视觉均按执行顺序从上向下。
// 待命区：不参与每轮流程的 Agent——事件触发的内建 Agent，以及在工具箱随时手动调用的自定义 Agent。
const standbyItem = item => {
  const trigger = item.custom ? t('工具箱') : item.trigger;
  const icon = item.custom ? (item.manual ? 'manual' : 'text_edit') : item.id;
  return `<button type="button" class="hop-standby-item${item.enabled ? '' : ' is-off'}${item.custom ? ' is-custom' : ''}" data-hop-standby="${e(item.id)}" data-hop-kind="${e(item.custom ? 'text_edit' : item.id)}" aria-label="${e(`${item.title} · ${trigger} · ${item.enabled ? t('已开启') : t('已关闭')}`)}">
      <span class="hop-standby-icon">${courtIcon(icon)}</span>
      <span class="hop-standby-copy"><strong data-i18n-skip="true">${e(item.title)}</strong>${item.custom ? `<small class="hop-standby-where" aria-hidden="true">${courtIcon('toolbox')}</small>` : `<small>${e(item.trigger)}</small>`}</span>
      <span class="hop-standby-state"><i class="hop-state-dot" aria-hidden="true"></i>${e(item.enabled ? t('已开启') : t('已关闭'))}</span>
    </button>`;
};
export const renderHopscotchStandby = (items = [], { canAdd = false } = {}) => items.length || canAdd ? `<section class="hop-standby" aria-label="${e(t('随时待命'))}">
    <div class="hop-standby-caption"><span>${e(t('随时待命'))}</span></div>
    <div class="hop-standby-list">${items.map(standbyItem).join('')}${canAdd ? `<button type="button" class="hop-standby-add" data-hop-add-standby aria-label="${e(t('新增随时待命 Agent'))}" title="${e(t('新增随时待命 Agent'))}"><span aria-hidden="true">+</span></button>` : ''}</div>
  </section>` : '';

// 草稿房子的类型托盘：类型 | 模板 | 已有 Agent；大小即自动（大）与手动（小）。
export const renderHopscotchTypeTray = (houseId, choices) => {
  const groups = [['type', t('类型')], ['template', t('模板')], ['agent', t('已有 Agent')]].map(([group, label]) => {
    const items = choices.filter(choice => choice.group === group);
    return items.length ? `<div class="hop-type-group" role="group" aria-label="${e(label)}">${items.map(choice => {
      const label = choice.custom ? choice.label : translateUiText(choice.label);
      return `<button type="button" class="hop-type-chip is-${e(choice.size)}" data-hop-retype="${e(choice.key)}" data-hop-kind="${e(choice.kind)}" aria-pressed="${choice.current === true}" aria-label="${e(label)}" title="${e(label)}"><span class="hop-type-chip-house" aria-hidden="true">${choice.agentIcon ? agentIconMarkup(choice.agentIcon) : courtIcon(choice.icon)}</span></button>`;
    }).join('')}</div>` : '';
  }).filter(Boolean);
  return groups.length ? `<div class="hop-type-tray" role="toolbar" aria-label="${e(t('房子类型'))}" data-hop-tray="${e(houseId)}">${groups.join('<i class="hop-type-sep" aria-hidden="true"></i>')}</div>` : '';
};

export const renderHopscotchCourt = (board, { editable = false, states = {}, status = '', place = '', taskAttribute = 'data-hop-house', inputSuggestion = null, inputAgents = [], agentRuns = [], canAddInput = false, formatReview = null, standby = [], canAddStandby = false, typeTray = null, activation = resolveHopscotchActivation(board) } = {}) => {
  let number = 0;
  const live = Boolean(status) || Object.keys(states).length > 0;
  // 手动房子画成胶囊，挂在它前面最近一个有大房子的行旁：那一行结束后即可在工具箱调用。只剩手动房子的行不单独画出。
  const isManual = house => activation.houses?.[house.id]?.invocationMode === 'manual';
  const shownRows = board.rows.map(row => row.houses.some(house => !isManual(house)));
  const lastShownBefore = index => { for (let i = index - 1; i >= 0; i--) if (shownRows[i]) return i; return -1; };
  const pillsByRow = new Map();
  board.rows.forEach((row, ri) => row.houses.filter(isManual).forEach(house => {
    const anchor = lastShownBefore(ri) >= 0 ? lastShownBefore(ri) : ri;
    pillsByRow.set(anchor, [...(pillsByRow.get(anchor) || []), house]);
  }));
  const shownRowOf = id => { const ri = board.rows.findIndex(row => row.houses.some(house => house.id === id)); return ri < 0 ? -1 : shownRows[ri] && !isManual(board.rows[ri].houses.find(house => house.id === id)) ? ri : (lastShownBefore(ri) >= 0 ? lastShownBefore(ri) : ri); };
  const rawStone = live ? resolveStoneRow(board, states) : -1;
  const stoneRow = rawStone >= 0 && !shownRows[rawStone] ? lastShownBefore(rawStone) : rawStone;
  const firstShown = shownRows.indexOf(true);
  const plus = (index, newRow, anchorKind = '') => `<button type="button" class="hop-plus ${newRow ? 'hop-gap' : 'hop-side'}" data-hop-add="${index}" data-hop-new="${newRow ? '1' : '0'}"${anchorKind ? ` data-hop-anchor="${e(anchorKind)}"` : ''} aria-label="${e(newRow ? t('新增一行') : t('新增并行房子'))}" title="${e(newRow ? t('新增一行') : t('新增并行房子'))}">+</button>`;
  const tick = (tail = false) => `<span class="hop-tick${tail ? ' hop-tail' : ''}" aria-hidden="true"></span>`;
  const cellStatus = (displayStatus, extra = '') => {
    const label = displayStatus ? hopscotchStatusLabel(displayStatus) : extra;
    if (!label) return '';
    return `<span class="hop-cell-status">${e(label)}</span>${displayStatus ? `<span class="hop-cell-mark" aria-hidden="true">${glyphFor(displayStatus)}</span>` : ''}`;
  };
  const runBadge = id => {
    const job = [...agentRuns].reverse().find(j => j.agentId === id && ['running', 'ready', 'reviewing'].includes(j.status));
    return job ? `<span class="hop-agent-run-status" role="status" data-running="${job.status === 'running'}">${e(t(job.status === 'running' ? '处理中' : job.status === 'reviewing' ? '正在查看' : '待查看'))}</span>` : '';
  };
  const roofGlyph = !status || status === 'succeeded' ? courtIcon('finish') : glyphFor(status);
  const visibleEnabled = active => active?.enabled !== false || active?.manualEnabled === true;
  const inactiveBadge = active => !visibleEnabled(active) ? `<span class="hop-disabled-mark" title="${e(hopscotchInactiveLabel(active.reason))}"><span aria-hidden="true">Ⅱ</span>${e(t('已停用'))}</span>` : active?.invocationMode && active.invocationMode !== 'manual' ? `<span class="hop-input-stage-label">${e(t(agentInvocationLabel(active)))}</span>` : '';
  // 草稿（停用）房子可原位切换类型。
  const typeBadge = house => editable && isHopscotchHouseDraft(house) ? `<span class="hop-type-badge${typeTray?.houseId === house.id ? ' is-open' : ''}" data-hop-type-trigger aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7 4 4 7l3 3M4 7h12M17 20l3-3-3-3M20 17H8"/></svg></span>` : '';
  const pill = house => {
    const active = activation.houses?.[house.id];
    const on = visibleEnabled(active);
    const job = [...agentRuns].reverse().find(j => j.agentId === (house.kind === 'format_review' ? 'reply_check' : house.config?.agentId) && ['running', 'ready', 'reviewing'].includes(j.status));
    return `<button type="button" class="hop-satellite${on ? '' : ' is-off'}${house.enabled === false ? ' is-draft' : ''}${typeTray?.houseId === house.id ? ' is-typing' : ''}" data-hop-kind="${e(house.kind)}" ${taskAttribute}="${e(house.id)}" aria-label="${e(`${hopscotchHouseLabel(house)} · ${t('手动')} · ${on ? t('已开启') : hopscotchInactiveLabel(active?.reason)}`)}">${typeBadge(house)}${courtIcon('manual')}<span class="hop-satellite-title" data-i18n-skip="true">${e(hopscotchHouseLabel(house))}</span><i class="hop-state-dot"${job ? ` data-run="${e(job.status)}"` : ''} aria-hidden="true"></i></button>`;
  };
  const dragAttrs = id => editable ? `data-hop-node="${e(id)}" draggable="false" aria-keyshortcuts="Space"` : '';
  const grip = editable ? `<span class="hop-drag-grip" data-hop-grip title="${e(t('按住拖动；空格键选择落点'))}" aria-hidden="true">⠿</span>` : '';
  return `<div class="hop-court-scroll"><div class="hop-court${live ? ' is-live' : ''}" aria-label="${e(t('从上往下执行，同一行并行'))}">
    <div class="hop-origin" aria-hidden="true"></div>
    ${inputSuggestion || inputAgents.length ? `<div class="hop-input-stage"><div class="hop-cells">${[...(inputSuggestion ? [{ ...inputSuggestion, id: 'text_completion', title: t('文本建议') }] : []), ...inputAgents].map(config => `<button type="button" class="hop-cell${config.enabled ? '' : ' is-disabled'}${config.invocationMode === 'manual' ? ' is-manual' : ''}" data-hop-kind="text_completion" ${config.id === 'text_completion' ? 'data-hop-input-suggestion' : `data-hop-input-agent="${e(config.id)}"`} aria-label="${e(config.title)}" data-hop-enabled="${config.enabled === true}">${runBadge(config.id)}${courtIcon('text_completion')}<span class="hop-title">${e(config.title)}</span><span class="hop-input-stage-label">${e(config.enabled ? t(agentInvocationLabel(config)) : t('已停用'))}</span></button>`).join('')}</div>${canAddInput ? `<button type="button" class="hop-plus hop-side" data-hop-add-input aria-label="${e(t('新增输入 Agent'))}" title="${e(t('新增输入 Agent'))}">+</button>` : ''}</div>${editable ? '' : tick()}` : ''}
    ${board.rows.map((row, ri) => shownRows[ri] ? `${editable ? plus(ri, true) : (ri > firstShown ? tick() : '')}<div class="hop-row${stoneRow === ri ? ' has-stone' : ''}" data-hop-row="${ri}" data-hop-row-id="${e(row.id)}">
      ${stoneRow === ri ? `<span class="hop-stone${status === 'running' ? ' is-hopping' : ''}" aria-hidden="true"></span>` : ''}
      ${row.houses.filter(house => !isManual(house)).length > 1 ? `<span class="hop-parallel" aria-hidden="true"><span>${e(t('并行'))}</span></span>` : ''}
      <div class="hop-cells">${row.houses.filter(house => !isManual(house)).map(house => {
        const state = states[house.id];
        const active = activation.houses?.[house.id];
        const displayStatus = state ? getHopscotchHouseDisplayStatus(state) : '';
        const mark = `<span class="hop-number">${String(++number).padStart(2, '0')}</span>`;
        const statusHtml = cellStatus(displayStatus);
        if (house.kind === 'body' && house.fused?.length) {
          const members = [{ kind: 'body', label: hopscotchHouseLabel(house) }, ...house.fused.map(kind => ({ kind, label: hopscotchFusedLabel(kind) }))];
          return `<div class="hop-cell hop-body hop-fusion-group is-${e(displayStatus || 'idle')}" role="group" data-hop-kind="body" ${taskAttribute}="${e(house.id)}" aria-label="${e(members.map(member => member.label).join(' · '))}" aria-description="${e(t('融合项与正文共享一次请求。'))}">
            <span class="hop-fusion-caption" aria-hidden="true">${e(t('融合'))}</span>
            <div class="hop-fusion-parts" style="--hop-fused-count: ${house.fused.length}">${members.map(member => {
              const memberActive = member.kind === 'body' ? active : activation.fused?.[member.kind];
              return `<button type="button" class="hop-fusion-part${memberActive?.enabled === false ? ' is-disabled' : ''}" data-hop-part="${e(member.kind)}" data-hop-enabled="${memberActive?.enabled !== false}" ${memberActive?.reason ? `aria-description="${e(hopscotchInactiveLabel(memberActive.reason))}"` : ''} ${dragAttrs(member.kind === 'body' ? house.id : house.fusedMembers?.[member.kind]?.id || `${house.id}__${member.kind}`)}>
              ${grip}${courtIcon(member.kind)}${member.kind === 'body' ? mark : ''}
              <span class="hop-title" data-i18n-skip="true">${e(member.label)}</span>
              ${inactiveBadge(memberActive)}
            </button>`; }).join('')}</div>${statusHtml}
          </div>`;
        }
        return `<button type="button" class="hop-cell ${house.kind === 'body' ? 'hop-body' : ''} is-${e(displayStatus || 'idle')}${!visibleEnabled(active) ? ' is-disabled' : ''}${typeTray?.houseId === house.id ? ' is-typing' : ''}" data-hop-enabled="${active?.enabled !== false}" data-hop-kind="${e(house.kind)}" ${taskAttribute}="${e(house.id)}" ${dragAttrs(house.id)} aria-label="${e(`${hopscotchHouseLabel(house)} · ${!visibleEnabled(active) ? hopscotchInactiveLabel(active.reason) : active?.invocationMode ? t(agentInvocationLabel(active)) : hopscotchStatusLabel(displayStatus)}`)}">
          ${grip}${typeBadge(house)}${runBadge(house.kind === 'text_edit' ? house.config?.agentId : house.kind === 'format_review' ? 'reply_check' : '')}${courtIcon(house.kind)}${mark}
          <span class="hop-title" data-i18n-skip="true">${e(hopscotchHouseLabel(house))}</span>
          ${statusHtml}
          ${inactiveBadge(active)}
        </button>`;
      }).join('')}</div>${editable ? plus(ri, false) : ''}${pillsByRow.has(ri) ? `<div class="hop-satellites">${pillsByRow.get(ri).map(pill).join('')}</div>` : ''}</div>${typeTray && shownRowOf(typeTray.houseId) === ri ? renderHopscotchTypeTray(typeTray.houseId, typeTray.choices || []) : ''}` : '').join('')}
    ${editable ? plus(board.rows.length, true) : tick(true)}
    ${formatReview && !board.rows.some(row => row.houses.some(house => house.kind === 'format_review')) ? `<div class="hop-row hop-input-stage hop-review-stage"><button type="button" class="hop-cell${visibleEnabled(formatReview) ? '' : ' is-disabled'}${formatReview.invocationMode === 'manual' && formatReview.manualEnabled ? ' is-manual' : ''}" data-hop-kind="format_review" data-hop-format-review data-hop-enabled="${formatReview.enabled === true}" aria-label="${e(t('格式修复'))}" aria-description="${e(visibleEnabled(formatReview) ? t(agentInvocationLabel(formatReview)) : hopscotchInactiveLabel(formatReview.reason))}">${runBadge('reply_check')}${courtIcon('format_review')}<span class="hop-title">${e(t('格式修复'))}</span><span class="hop-input-stage-label">${e(visibleEnabled(formatReview) ? t(agentInvocationLabel(formatReview)) : t('已停用'))}</span></button>${editable ? plus(board.rows.length, false, 'format_review') : ''}</div>${editable ? plus(board.rows.length + 1, true, 'format_review') : tick(true)}` : ''}
    <div class="hop-roof is-${e(status || 'idle')}" aria-label="${e(hopscotchStatusLabel(status))}"><span aria-hidden="true">${roofGlyph}</span></div>
  </div></div>${renderHopscotchStandby(standby, { canAdd: canAddStandby })}`;
};
