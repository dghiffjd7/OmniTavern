import { t, translateUiText } from '../../i18n/index.js';
import { getHopscotchHouseDisplayStatus } from './hopscotch-board-utils.js';

export const escapeHopscotchHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeHopscotchHtml;
export const hopscotchStatusLabel = status => ({ queued: t('等待'), running: t('执行中'), succeeded: t('完成'), failed: t('失败'), cancelled: t('已取消'), skipped: t('跳过'), partial: t('部分失败') })[status] || t('待出发');
export const hopscotchHouseLabel = house => house.kind === 'custom_prompt' ? house.label : translateUiText(house.label);
export const hopscotchFusedLabel = kind => translateUiText(({ memory_table: '记忆表格', image_prompt: '图片提示', variable: '变量' })[kind] || kind);

// 状态只用图形表达：格底色 + 右上角小标记 + 底边进度线；文字状态仅供辅助技术
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
export const renderHopscotchCourt = (board, { editable = false, states = {}, status = '', place = '', taskAttribute = 'data-hop-house' } = {}) => {
  let number = 0;
  const live = Boolean(status) || Object.keys(states).length > 0;
  const stoneRow = live ? resolveStoneRow(board, states) : -1;
  const plus = (index, newRow) => `<button type="button" class="hop-plus ${newRow ? 'hop-gap' : 'hop-side'}" data-hop-add="${index}" data-hop-new="${newRow ? '1' : '0'}" aria-label="${e(newRow ? t('新增一行') : t('新增并行房子'))}">+</button>`;
  const tick = () => `<span class="hop-tick" aria-hidden="true"></span>`;
  const cellStatus = (displayStatus, extra = '') => {
    const label = displayStatus ? hopscotchStatusLabel(displayStatus) : extra;
    if (!label) return '';
    return `<span class="hop-cell-status">${e(label)}</span>${displayStatus ? `<span class="hop-cell-mark" aria-hidden="true">${glyphFor(displayStatus)}</span>` : ''}`;
  };
  const roofGlyph = status === 'running' ? '' : (status ? glyphFor(status === 'partial' ? 'partial' : status) : '');
  return `<div class="hop-court-scroll"><div class="hop-court${live ? ' is-live' : ''}" aria-label="${e(t('从上往下执行，同一行并行'))}">
    <div class="hop-origin" aria-hidden="true"></div>
    ${board.rows.map((row, ri) => `${editable ? plus(ri, true) : (ri ? tick() : '')}<div class="hop-row${stoneRow === ri ? ' has-stone' : ''}" data-hop-row="${ri}">
      ${stoneRow === ri ? `<span class="hop-stone${status === 'running' ? ' is-hopping' : ''}" aria-hidden="true"></span>` : ''}
      <div class="hop-cells">${row.houses.map(house => {
        const state = states[house.id];
        const displayStatus = state ? getHopscotchHouseDisplayStatus(state) : '';
        const mark = `<span class="hop-number">${String(++number).padStart(2, '0')}</span>`;
        const statusHtml = cellStatus(displayStatus, place === 'writing' && house.kind === 'format_review' ? t('仅聊天') : '');
        if (house.kind === 'body' && house.fused?.length) {
          const members = [{ kind: 'body', label: hopscotchHouseLabel(house) }, ...house.fused.map(kind => ({ kind, label: hopscotchFusedLabel(kind) }))];
          return `<div class="hop-cell hop-body hop-fusion-group is-${e(displayStatus || 'idle')}" role="group" data-hop-kind="body" ${taskAttribute}="${e(house.id)}" aria-label="${e(members.map(member => member.label).join(' · '))}" aria-description="${e(t('融合项与正文共享一次请求。'))}">
            ${mark}<div class="hop-fusion-parts">${members.map(member => `<button type="button" class="hop-fusion-part" data-hop-part="${e(member.kind)}" draggable="${editable && member.kind === 'body' ? 'true' : 'false'}">
              <span class="hop-title" data-i18n-skip="true">${e(member.label)}</span>
            </button>`).join('')}</div>${statusHtml}
          </div>`;
        }
        return `<button type="button" class="hop-cell ${house.kind === 'body' ? 'hop-body' : ''} is-${e(displayStatus || 'idle')}" data-hop-kind="${e(house.kind)}" ${taskAttribute}="${e(house.id)}" ${editable ? 'draggable="true"' : ''} aria-label="${e(`${hopscotchHouseLabel(house)} · ${hopscotchStatusLabel(displayStatus)}`)}">
          ${mark}
          <span class="hop-title" data-i18n-skip="true">${e(hopscotchHouseLabel(house))}</span>
          ${statusHtml}
        </button>`;
      }).join('')}</div>${editable ? plus(ri, false) : ''}</div>`).join('')}
    ${editable ? plus(board.rows.length, true) : ''}
    <div class="hop-roof is-${e(status || 'idle')}" aria-label="${e(status ? hopscotchStatusLabel(status) : '')}"><span aria-hidden="true">${roofGlyph}</span></div>
  </div></div>`;
};
