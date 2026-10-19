// 预设选单：搜索 + 按分类折叠（设计页 https://claude.ai/artifact/GuwKVZkqYHALvJMe2KsUkL「预设面板 · 按分类选预设」）。
// 预设面板「当前预设」与 Agent「套用预设」共用；浮层挂在 body、按锚点定位，点外面或 Esc 关闭。
import { buildPresetPickerSections } from '../storage/preset-group-store.js';
import { resolveContactGroupColor } from '../storage/contact-group-color-utils.js';
import { t } from '../i18n/index.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const VIEWPORT_GAP = 8;

let activePicker = null;

export const closePresetPicker = () => activePicker?.close();

export const renderPresetPickerList = ({ sections = [], hasGroups = false, canMove = false } = {}) => {
  if (!sections.length) return `<p class="preset-picker-empty">${escapeHtml(t('没有找到预设'))}</p>`;
  return sections.map(section => {
    const color = section.id ? resolveContactGroupColor(section.color).value : 'var(--app-text-muted)';
    const header = hasGroups ? `<button type="button" class="preset-picker-group" data-preset-picker-group="${escapeHtml(section.id)}" aria-expanded="${section.expanded}">
        <span class="preset-picker-arrow" aria-hidden="true">${section.expanded ? '▾' : '▸'}</span>
        <span class="preset-picker-dot" style="background:${color}" aria-hidden="true"></span>
        <span class="preset-picker-group-name" data-i18n-skip="true">${escapeHtml(section.name)}</span>
        <span class="preset-picker-count">${section.count}</span>
      </button>` : '';
    const rows = section.expanded ? section.items.map(item => `<div class="preset-picker-row${item.selected ? ' is-selected' : ''}">
        <button type="button" role="option" aria-selected="${item.selected}" class="preset-picker-option" data-preset-picker-pick="${escapeHtml(item.id)}">
          <span class="preset-picker-name" data-i18n-skip="true">${escapeHtml(item.name)}</span>
          ${item.selected ? '<span class="preset-picker-check" aria-hidden="true">✓</span>' : ''}
        </button>
        ${canMove ? `<button type="button" class="preset-picker-more" data-preset-picker-move="${escapeHtml(item.id)}" aria-label="${escapeHtml(t('移到分类：{name}', { name: item.name }))}" title="${escapeHtml(t('移到分类'))}">⋯</button>` : ''}
      </div>`).join('') : '';
    return `<div class="preset-picker-section${hasGroups ? ' has-header' : ''}" role="group" aria-label="${escapeHtml(section.name)}">${header}${rows ? `<div class="preset-picker-items">${rows}</div>` : ''}</div>`;
  }).join('');
};

export const openPresetPicker = ({
  anchorEl = null,
  presets = [],
  groups = [],
  currentId = '',
  onSelect = () => {},
  onMove = null,
  onManage = null,
  // 置顶的非预设选项（如「跟随创意写作默认」），value 可为空；搜索时隐藏
  leadingOptions = [],
} = {}) => {
  // 再点同一个按钮＝收起
  if (activePicker && activePicker.anchorEl === anchorEl) {
    activePicker.close();
    return null;
  }
  closePresetPicker();
  if (!anchorEl) return null;
  const doc = anchorEl.ownerDocument || document;
  const win = doc.defaultView || window;
  const state = { query: '', expanded: {} };
  const root = doc.createElement('div');
  root.className = 'preset-picker';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('选择预设'));
  root.innerHTML = `
    <label class="preset-picker-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4-4"></path></svg>
      <input type="search" data-preset-picker-query placeholder="${escapeHtml(t('搜索 {count} 个预设…', { count: presets.length }))}" aria-label="${escapeHtml(t('搜索预设'))}" autocomplete="off">
    </label>
    <div class="preset-picker-list" role="listbox" aria-label="${escapeHtml(t('预设'))}" data-preset-picker-list></div>
    ${onManage ? `<div class="preset-picker-footer"><button type="button" class="preset-picker-manage" data-preset-picker-manage>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>${escapeHtml(t('管理分类'))}</button></div>` : ''}
  `;
  const list = root.querySelector('[data-preset-picker-list]');
  const input = root.querySelector('[data-preset-picker-query]');
  const hasGroups = Array.isArray(groups) && groups.length > 0;

  const renderList = () => {
    const sections = buildPresetPickerSections({
      presets, groups, currentId, query: state.query, expanded: state.expanded, uncategorizedLabel: t('未分类'),
    });
    const leading = state.query.trim() ? '' : (Array.isArray(leadingOptions) ? leadingOptions : []).map(option => {
      const value = String(option?.value ?? '');
      const selected = value === String(currentId ?? '');
      return `<div class="preset-picker-row${selected ? ' is-selected' : ''}"><button type="button" role="option" aria-selected="${selected}" class="preset-picker-option" data-preset-picker-pick="${escapeHtml(value)}">
        <span class="preset-picker-name">${escapeHtml(option?.label ?? value)}</span>${selected ? '<span class="preset-picker-check" aria-hidden="true">✓</span>' : ''}</button></div>`;
    }).join('');
    list.innerHTML = leading + renderPresetPickerList({ sections, hasGroups, canMove: typeof onMove === 'function' });
  };

  const position = () => {
    const rect = anchorEl.getBoundingClientRect();
    // 跟随锚点宽度，但电脑宽面板里不拉满（最宽 640）。
    const width = Math.min(Math.max(rect.width, 280), 640, win.innerWidth - VIEWPORT_GAP * 2);
    const below = win.innerHeight - rect.bottom - VIEWPORT_GAP * 2;
    const above = rect.top - VIEWPORT_GAP * 2;
    const placeBelow = below >= 260 || below >= above;
    const maxHeight = Math.max(200, Math.min(460, placeBelow ? below : above));
    root.style.width = `${width}px`;
    root.style.maxHeight = `${maxHeight}px`;
    root.style.left = `${Math.min(Math.max(VIEWPORT_GAP, rect.left), win.innerWidth - width - VIEWPORT_GAP)}px`;
    const height = Math.min(root.scrollHeight, maxHeight);
    root.style.top = `${placeBelow ? rect.bottom + 6 : Math.max(VIEWPORT_GAP, rect.top - 6 - height)}px`;
  };

  const onPointerDown = (event) => {
    if (root.contains(event.target) || anchorEl.contains(event.target)) return;
    close();
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
    anchorEl.focus?.({ preventScroll: true });
  };
  const onViewport = () => position();

  function close() {
    if (activePicker?.root !== root) return;
    activePicker = null;
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('resize', onViewport);
    root.remove();
    anchorEl.setAttribute('aria-expanded', 'false');
  }

  root.addEventListener('click', (event) => {
    const group = event.target.closest('[data-preset-picker-group]');
    if (group) {
      const id = group.dataset.presetPickerGroup;
      state.expanded = { ...state.expanded, [id]: group.getAttribute('aria-expanded') !== 'true' };
      renderList();
      position();
      return;
    }
    const pick = event.target.closest('[data-preset-picker-pick]');
    if (pick) {
      close();
      onSelect(pick.dataset.presetPickerPick);
      return;
    }
    const move = event.target.closest('[data-preset-picker-move]');
    if (move) {
      close();
      onMove?.(move.dataset.presetPickerMove);
      return;
    }
    if (event.target.closest('[data-preset-picker-manage]')) {
      close();
      onManage?.();
    }
  });
  input.addEventListener('input', () => {
    state.query = input.value;
    renderList();
    position();
  });

  renderList();
  doc.body.appendChild(root);
  position();
  anchorEl.setAttribute('aria-expanded', 'true');
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('resize', onViewport);
  activePicker = { root, close, anchorEl };
  // 手机上直接弹键盘会把选单顶走：只有精确指针（电脑）才自动聚焦搜索框。
  if (win.matchMedia?.('(pointer: fine)')?.matches) input.focus({ preventScroll: true });
  root.querySelector('.preset-picker-row.is-selected')?.scrollIntoView?.({ block: 'nearest' });
  return { close, root };
};
