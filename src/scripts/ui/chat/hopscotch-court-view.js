import { t, translateUiText } from '../../i18n/index.js';
import { getHopscotchHouseDisplayStatus } from './hopscotch-board-utils.js';
import { hopscotchInactiveLabel, resolveHopscotchActivation } from './hopscotch-activation-utils.js';

export const escapeHopscotchHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeHopscotchHtml;
export const hopscotchStatusLabel = status => ({ queued: t('等待'), running: t('执行中'), succeeded: t('完成'), failed: t('失败'), cancelled: t('已取消'), skipped: t('跳过'), partial: t('部分失败') })[status] || t('待出发');
export const hopscotchHouseLabel = house => house.kind === 'custom_prompt' ? house.label : house.kind === 'variable_rules' ? (house.config?.phase === 'before' ? t('发送前变量规则') : t('回复后变量规则')) : translateUiText(house.label);
export const hopscotchFusedLabel = kind => translateUiText(({ memory_table: '记忆表格', image_prompt: '图片提示', variable: '变量' })[kind] || kind);

// 图标随节点类型着色；SVG 不参与名称与点击目标的识别。
const COURT_ICONS = {
  body: '<path class="hop-glyph-wash" d="m3 10 18-7-7 18-3-8z"/><path d="m3 10 18-7-7 18-3-8zM11 13l5-5"/>',
  custom_prompt: '<path class="hop-glyph-solid" d="M12 2.5c1.8 6 3.5 7.7 9.5 9.5-6 1.8-7.7 3.5-9.5 9.5C10.2 15.5 8.5 13.8 2.5 12c6-1.8 7.7-3.5 9.5-9.5Z"/>',
  memory_table: '<rect class="hop-glyph-wash" x="3" y="4" width="18" height="16" rx="3"/><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10M9 15h12"/>',
  image_prompt: '<path class="hop-glyph-wash" d="m4 16 1 4 4-1L20 8l-4-4Z"/><path d="m4 16 1 4 4-1L20 8l-4-4ZM13 7l4 4M4 4v4M2 6h4"/>',
  variable: '<path d="M5 4v7m0 6v3M12 4v2m0 6v8M19 4v10m0 6v0"/><circle class="hop-glyph-solid" cx="5" cy="14" r="2.5"/><circle class="hop-glyph-solid" cx="12" cy="9" r="2.5"/><circle class="hop-glyph-solid" cx="19" cy="17" r="2.5"/>',
  image_generation: '<rect class="hop-glyph-wash" x="3" y="3" width="18" height="18" rx="4"/><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m4 17 5-5 4 4 3-3 5 5"/><circle class="hop-glyph-solid" cx="16" cy="8" r="1.6"/>',
  summary_compaction: '<path class="hop-glyph-wash" d="m3 7 9-4 9 4-9 4Z"/><path d="m3 7 9-4 9 4-9 4ZM3 12l9 4 9-4M3 17l9 4 9-4"/>',
  format_review: '<circle class="hop-glyph-wash" cx="10.5" cy="10.5" r="7"/><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5m-14-10 2.5 2.5 4-4"/>',
  text_completion: '<path d="M4 5h10M4 10h6M4 15h4m5 3 6-6 3 3-6 6h-3zM16 4v4m-2-2h4"/>',
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
export const renderHopscotchCourt = (board, { editable = false, states = {}, status = '', place = '', taskAttribute = 'data-hop-house', inputSuggestion = null, activation = resolveHopscotchActivation(board) } = {}) => {
  let number = 0;
  const live = Boolean(status) || Object.keys(states).length > 0;
  const stoneRow = live ? resolveStoneRow(board, states) : -1;
  const plus = (index, newRow) => `<button type="button" class="hop-plus ${newRow ? 'hop-gap' : 'hop-side'}" data-hop-add="${index}" data-hop-new="${newRow ? '1' : '0'}" aria-label="${e(newRow ? t('新增一行') : t('新增并行房子'))}">+</button>`;
  const tick = (tail = false) => `<span class="hop-tick${tail ? ' hop-tail' : ''}" aria-hidden="true"></span>`;
  const cellStatus = (displayStatus, extra = '') => {
    const label = displayStatus ? hopscotchStatusLabel(displayStatus) : extra;
    if (!label) return '';
    return `<span class="hop-cell-status">${e(label)}</span>${displayStatus ? `<span class="hop-cell-mark" aria-hidden="true">${glyphFor(displayStatus)}</span>` : ''}`;
  };
  const roofGlyph = !status || status === 'succeeded' ? courtIcon('finish') : glyphFor(status);
  const inactiveBadge = active => active?.enabled === false ? `<span class="hop-disabled-mark" title="${e(hopscotchInactiveLabel(active.reason))}"><span aria-hidden="true">Ⅱ</span>${e(t('已停用'))}</span>` : '';
  const dragAttrs = id => editable ? `data-hop-node="${e(id)}" draggable="false" aria-keyshortcuts="Space"` : '';
  const grip = editable ? `<span class="hop-drag-grip" data-hop-grip title="${e(t('按住拖动；空格键选择落点'))}" aria-hidden="true">⠿</span>` : '';
  return `<div class="hop-court-scroll"><div class="hop-court${live ? ' is-live' : ''}" aria-label="${e(t('从上往下执行，同一行并行'))}">
    <div class="hop-origin" aria-hidden="true"></div>
    ${inputSuggestion ? `<div class="hop-input-stage"><button type="button" class="hop-cell${inputSuggestion.enabled ? '' : ' is-disabled'}" data-hop-kind="text_completion" data-hop-input-suggestion aria-label="${e(t('文本建议'))}" data-hop-enabled="${inputSuggestion.enabled === true}">${courtIcon('text_completion')}<span class="hop-title">${e(t('文本建议'))}</span><span class="hop-input-stage-label">${e(inputSuggestion.enabled ? t('输入时') : t('已停用'))}</span></button></div>${editable ? '' : tick()}` : ''}
    ${board.rows.map((row, ri) => `${editable ? plus(ri, true) : (ri ? tick() : '')}<div class="hop-row${stoneRow === ri ? ' has-stone' : ''}" data-hop-row="${ri}" data-hop-row-id="${e(row.id)}">
      ${stoneRow === ri ? `<span class="hop-stone${status === 'running' ? ' is-hopping' : ''}" aria-hidden="true"></span>` : ''}
      ${row.houses.length > 1 ? `<span class="hop-parallel" aria-hidden="true"><span>${e(t('并行'))}</span></span>` : ''}
      <div class="hop-cells">${row.houses.map(house => {
        const state = states[house.id];
        const active = activation.houses?.[house.id];
        const displayStatus = state ? getHopscotchHouseDisplayStatus(state) : '';
        const mark = `<span class="hop-number">${String(++number).padStart(2, '0')}</span>`;
        const statusHtml = cellStatus(displayStatus, place === 'writing' && house.kind === 'format_review' ? t('仅聊天') : '');
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
        return `<button type="button" class="hop-cell ${house.kind === 'body' ? 'hop-body' : ''} is-${e(displayStatus || 'idle')}${active?.enabled === false ? ' is-disabled' : ''}" data-hop-enabled="${active?.enabled !== false}" data-hop-kind="${e(house.kind)}" ${taskAttribute}="${e(house.id)}" ${dragAttrs(house.id)} aria-label="${e(`${hopscotchHouseLabel(house)} · ${active?.enabled === false ? hopscotchInactiveLabel(active.reason) : hopscotchStatusLabel(displayStatus)}`)}">
          ${grip}${courtIcon(house.kind)}${mark}
          <span class="hop-title" data-i18n-skip="true">${e(hopscotchHouseLabel(house))}</span>
          ${statusHtml}
          ${inactiveBadge(active)}
        </button>`;
      }).join('')}</div>${editable ? plus(ri, false) : ''}</div>`).join('')}
    ${editable ? plus(board.rows.length, true) : tick(true)}
    <div class="hop-roof is-${e(status || 'idle')}" aria-label="${e(hopscotchStatusLabel(status))}"><span aria-hidden="true">${roofGlyph}</span></div>
  </div></div>`;
};
