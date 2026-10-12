// 记忆表格的手机版视图：表格用标签切换，每行一张卡片（「栏位：内容」），长内容先显示 3 行。
// 只负责把 MemoryTableEditor 整理好的数据画出来，读写与确认仍由编辑器处理。
import { t, translateUiText } from '../i18n/index.js';

export const MEMORY_TABLE_CARD_QUERY = '(max-width: 640px)';

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'),
  push: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'),
  worldbook: svg('<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2.5Z"/><path d="M8 7h8"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

// 卡片标题取第一栏（通常是名称/称呼）；其余有内容的栏位逐行列出。全空时标题显示破折号。
export const buildMemoryRowCardModel = (row = {}, cellViews = []) => {
  const views = Array.isArray(cellViews) ? cellViews : [];
  const filled = views.filter(view => String(view?.value || '').trim() || view?.tags?.length);
  const titleView = views[0] && (String(views[0].value || '').trim() || views[0].tags?.length) ? views[0] : null;
  const title = titleView
    ? (titleView.tags?.length ? titleView.tags.join('、') : String(titleView.value || '').trim())
    : '—';
  const fields = filled.filter(view => view !== titleView).map(view => ({
    id: view.id,
    label: view.label,
    kind: view.kind,
    value: String(view.value || ''),
    tags: Array.isArray(view.tags) ? view.tags.slice() : [],
  }));
  return {
    id: String(row?.id || ''),
    title,
    fields,
    inactive: row?.is_active === false || row?.is_active === 0,
    pinned: Boolean(row?.is_pinned),
    priority: typeof row?.priority === 'number' ? row.priority : 0,
  };
};

// 选中的表格：沿用上次的选择；没有或那张表已不在时，先选第一张有内容的表，都空则第一张。
export const resolveActiveMemoryTableId = (tables = [], previousId = '', getRowCount = () => 0) => {
  const list = Array.isArray(tables) ? tables : [];
  const prev = String(previousId || '');
  if (prev && list.some(table => String(table?.id || '') === prev)) return prev;
  const withRows = list.find(table => Number(getRowCount(table)) > 0);
  return String((withRows || list[0])?.id || '');
};

const el = (documentRef, tag, className = '', text = null) => {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
};

const iconButton = (documentRef, icon, label, onClick) => {
  const button = el(documentRef, 'button', 'memory-cards-icon-btn memory-cards-ctl');
  button.type = 'button';
  button.innerHTML = ICONS[icon];
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick?.();
  });
  return button;
};

const renderRowCard = (documentRef, model, { batchMode = false, selected = false, index = 0, onEdit, onToggleSelect } = {}) => {
  const card = el(documentRef, 'article', 'memory-row-card');
  card.dataset.memoryRowId = model.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.style.setProperty('--memory-card-index', String(Math.min(index, 8)));
  card.classList.toggle('is-inactive', model.inactive);
  card.classList.toggle('is-selected', selected);

  const head = el(documentRef, 'div', 'memory-row-card-head');
  if (batchMode) {
    const check = el(documentRef, 'input', 'memory-row-card-check');
    check.type = 'checkbox';
    check.checked = selected;
    check.setAttribute('aria-label', t('选择 {value}', { value: model.title }));
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => onToggleSelect?.(model.id, check.checked));
    head.appendChild(check);
  }
  const title = el(documentRef, 'span', 'memory-row-card-title', model.title);
  title.dataset.i18nSkip = '';
  head.appendChild(title);
  if (model.pinned) head.appendChild(el(documentRef, 'span', 'memory-row-card-badge is-pinned', '置顶'));
  if (model.inactive) head.appendChild(el(documentRef, 'span', 'memory-row-card-badge', '已停用'));
  if (!batchMode) head.appendChild(iconButton(documentRef, 'edit', t('编辑 {value}', { value: model.title }), () => onEdit?.()));
  card.appendChild(head);

  if (model.fields.length) {
    const list = el(documentRef, 'dl', 'memory-row-card-fields');
    model.fields.forEach((field) => {
      const term = el(documentRef, 'dt', '', translateUiText(field.label));
      term.dataset.i18nSkip = '';
      const detail = el(documentRef, 'dd', `is-${field.kind || 'text'}`);
      detail.dataset.i18nSkip = '';
      if (field.tags.length) {
        field.tags.forEach(tag => detail.appendChild(el(documentRef, 'span', 'memory-row-card-tag', tag)));
      } else {
        detail.textContent = field.value;
      }
      list.append(term, detail);
    });
    card.appendChild(list);
    const more = el(documentRef, 'button', 'memory-row-card-more memory-cards-ctl', '展开');
    more.type = 'button';
    more.hidden = true;
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      const expanded = card.classList.toggle('is-expanded');
      more.textContent = translateUiText(expanded ? '收起' : '展开');
    });
    card.appendChild(more);
  }

  const activate = () => {
    if (batchMode) onToggleSelect?.(model.id, !selected);
    else onEdit?.();
  };
  card.addEventListener('click', activate);
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    activate();
  });
  return card;
};

// 3 行截断后仍有被藏起来的内容，才显示「展开」。须在卡片挂进文档、完成排版后调用。
export const revealOverflowingMemoryCards = (root) => {
  root?.querySelectorAll?.('.memory-row-card').forEach((card) => {
    const more = card.querySelector('.memory-row-card-more');
    if (!more) return;
    more.hidden = ![...card.querySelectorAll('.memory-row-card-fields dd')]
      .some(dd => dd.scrollHeight > dd.clientHeight + 1);
  });
};

export const renderMemoryTableCardView = ({
  documentRef = globalThis.document,
  tables = [],
  activeTableId = '',
  direction = 0,
  getRowCount = () => 0,
  activeRows = [],
  getCellViews = () => [],
  scopeLabel = '',
  maxRows = 0,
  totalRows = 0,
  batchMode = false,
  selectedIds = new Set(),
  searchTerm = '',
  onSelectTable = null,
  onAdd = null,
  onEdit = null,
  onToggleSelect = null,
  onPush = null,
  onExport = null,
} = {}) => {
  const root = el(documentRef, 'div', 'memory-cards');
  const tabs = el(documentRef, 'div', 'memory-cards-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('选择表格'));
  tables.forEach((table) => {
    const id = String(table.id || '');
    const tab = el(documentRef, 'button', 'memory-cards-tab memory-cards-ctl');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.memoryTableId = id;
    const active = id === activeTableId;
    tab.setAttribute('aria-selected', String(active));
    tab.classList.toggle('is-active', active);
    const name = el(documentRef, 'span', '', translateUiText(table.name || id || '记忆表格'));
    name.dataset.i18nSkip = '';
    tab.appendChild(name);
    const count = Number(getRowCount(table)) || 0;
    if (count) tab.appendChild(el(documentRef, 'span', 'memory-cards-tab-count', String(count)));
    tab.addEventListener('click', () => { if (!active) onSelectTable?.(id); });
    tabs.appendChild(tab);
  });
  root.appendChild(tabs);

  const table = tables.find(item => String(item.id || '') === activeTableId);
  if (!table) return root;
  const panel = el(documentRef, 'div', `memory-cards-panel${direction > 0 ? ' is-from-right' : direction < 0 ? ' is-from-left' : ''}`);
  panel.setAttribute('role', 'tabpanel');

  const meta = el(documentRef, 'div', 'memory-cards-meta');
  const metaText = el(documentRef, 'span', 'memory-cards-meta-text has-help',
    t('{name} · {count} 行', { name: translateUiText(table.name || table.id || '记忆表格'), count: maxRows ? `${totalRows}/${maxRows}` : totalRows }));
  metaText.dataset.i18nSkip = '';
  metaText.dataset.helpTitle = t('表格信息');
  metaText.dataset.help = t('表格代号：{id} · {scope}', { id: String(table.id || ''), scope: scopeLabel });
  meta.appendChild(metaText);
  meta.appendChild(iconButton(documentRef, 'push', t('推送到当前对话'), onPush));
  meta.appendChild(iconButton(documentRef, 'worldbook', t('导出成世界书'), onExport));
  panel.appendChild(meta);

  const list = el(documentRef, 'div', 'memory-cards-list');
  list.dataset.memoryTableId = String(table.id || '');
  if (!activeRows.length) {
    list.appendChild(el(documentRef, 'div', 'memory-cards-empty', searchTerm ? '无匹配内容' : '暂无记忆条目'));
  } else {
    activeRows.forEach((row, index) => {
      const model = buildMemoryRowCardModel(row, getCellViews(row));
      list.appendChild(renderRowCard(documentRef, model, {
        batchMode,
        selected: selectedIds.has(row.id),
        index,
        onEdit: () => onEdit?.(row),
        onToggleSelect,
      }));
    });
  }
  panel.appendChild(list);

  const add = el(documentRef, 'button', 'memory-cards-add memory-cards-ctl');
  add.type = 'button';
  add.innerHTML = `${ICONS.plus}<span></span>`;
  add.querySelector('span').textContent = translateUiText('新增一行');
  add.disabled = Boolean(maxRows && totalRows >= maxRows);
  add.addEventListener('click', () => onAdd?.());
  panel.appendChild(add);
  root.appendChild(panel);
  return root;
};
