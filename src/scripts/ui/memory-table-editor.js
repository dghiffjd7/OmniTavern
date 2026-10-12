import { appSettings } from '../storage/app-settings.js';
import {
  isRpSessionId,
  tableMatchesMemoryContext,
} from '../memory/memory-context-utils.js';
import {
  EDITABLE_OUTLINE_SECTION_IDS,
  getOutlineSectionLabel,
  isOutlineTableId,
  normalizeOutlineSection,
} from '../memory/outline-section-utils.js';
import {
  buildMemoryTimelineLabel,
  computeNextMemoryRowSortOrder,
  extractMemoryTimelineRound,
  getMemoryRowSortOrder,
  isTimelineMemoryTableId,
  sortMemoryRows,
} from '../memory/memory-row-order.js';
import { buildMemoryTimelineRepairPlan } from '../memory/memory-timeline-repair-utils.js';
import { logger } from '../utils/logger.js';
import { translateUiText } from '../i18n/index.js';
import { appConfirm } from './app-confirm.js';
import { getLastMemoryUpdate } from './chat/memory-update-runtime-utils.js';
import { bindCustomSelectButton, createCustomSelectWrapper, refreshCustomSelectButton } from './custom-select.js';
import { buildMemoryImpactText, formatMemoryImpactScopeLabel } from './memory-impact-utils.js';
import { emitMemoryRowsUpdated as emitSharedMemoryRowsUpdated } from './session-memory-event-utils.js';
import { getCurrentWorldId, getGlobalWorldId, setCurrentWorld } from './world-session-runtime-utils.js';
import { bindSheetDragToDismiss } from './bottom-sheet-drag-utils.js';
import {
  MEMORY_TABLE_CARD_QUERY,
  renderMemoryTableCardView,
  resolveActiveMemoryTableId,
  revealOverflowingMemoryCards,
} from './memory-table-card-view.js';

const isReducedMotion = () => globalThis.document?.body?.dataset?.reducedMotion === 'on'
  || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

const scopeLabelMap = {
  global: '全局',
  contact: '私聊',
  group: '群聊',
  rp: 'RP',
};

const getRuntimeScopeLabel = (table, ctx = null) => {
  const scope = String(table?.scope || '').trim().toLowerCase();
  if (scope === 'contact' && ctx?.type === 'rp') return scopeLabelMap.rp;
  return scopeLabelMap[scope] || scope || '未知';
};

const escapeHtml = (value) => (
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

const splitMemoryCellTags = value => String(value || '')
  .split(/[、,，；;\n\r·]+/)
  .map(item => item.trim())
  .filter(Boolean);

const isOutlineSectionColumn = (tableId, column) => (
  isOutlineTableId(tableId)
  && String(column?.id || '').trim() === 'section'
);

const normalizeMemorySelectOption = (option) => {
  const value = String(option ?? '').trim();
  return { value, label: translateUiText(value) };
};

export const buildMemoryTableSelectFieldView = ({
  column = {},
  tableId = '',
  value = '',
} = {}) => {
  const rawValue = String(value ?? '').trim();
  if (isOutlineSectionColumn(tableId, column)) {
    const section = rawValue ? normalizeOutlineSection(rawValue) : '';
    const isArchive = section === 'history';
    return {
      value: section,
      readOnly: isArchive,
      options: (isArchive ? ['history'] : EDITABLE_OUTLINE_SECTION_IDS).map(sectionId => ({
        value: sectionId,
        label: getOutlineSectionLabel(sectionId),
      })),
    };
  }
  return {
    value: rawValue,
    readOnly: false,
    options: (Array.isArray(column?.options) ? column.options : [])
      .map(normalizeMemorySelectOption)
      .filter(option => option.value),
  };
};

export const buildMemoryTableCellViews = (rowData = {}, columns = [], { tableId = '' } = {}) => (
  (Array.isArray(columns) ? columns : []).map((column, index) => {
    const id = String(column?.id || `column-${index + 1}`).trim();
    const outlineSection = isOutlineSectionColumn(tableId, column);
    const label = outlineSection
      ? '大纲类别'
      : String(column?.name || id || '字段').trim() || '字段';
    const type = String(column?.type || 'text').trim().toLowerCase() || 'text';
    const rawValue = String(rowData?.[id] ?? '').trim();
    const value = outlineSection && rawValue
      ? getOutlineSectionLabel(rawValue)
      : rawValue;
    const isTagField = /(?:^|_)(?:keyword|keywords|tag|tags)(?:_|$)/i.test(id);
    const kind = type === 'select'
      ? 'chip'
      : isTagField
        ? 'tag'
        : type === 'multiline'
          ? 'long'
          : type === 'number'
            ? 'number'
            : 'text';
    return {
      id,
      label,
      type,
      kind,
      value,
      tags: kind === 'tag' ? splitMemoryCellTags(value) : [],
    };
  })
);

const formatRowDetail = (rowData, columns) => {
  const parts = [];
  for (const col of columns || []) {
    const label = String(col?.name || col?.id || '').trim();
    const raw = rowData?.[col.id];
    const text = String(raw ?? '').trim().replace(/\s*\r?\n\s*/g, ' / ');
    if (!text) continue;
    parts.push(label ? `${label}: ${text}` : text);
  }
  if (!parts.length) return '（未填写）';
  return parts.join('；');
};

const buildTableDataText = (table, rows) => {
  const header = `【${String(table?.name || table?.id || '记忆表格')}${table?.id ? `｜${table.id}` : ''}】`;
  const lines = rows.map((row, idx) => `- [${idx}] ${formatRowDetail(row?.row_data || {}, table?.columns || [])}`);
  return [header, ...lines].join('\n').trim();
};

const normalizeKeywords = (raw) => {
  if (Array.isArray(raw)) return raw.map(v => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw.split(/[,，\n\r]/).map(v => v.trim()).filter(Boolean);
  }
  return [];
};

const renderExportTemplate = (template, vars) => {
  const raw = String(template || '{{tableData}}');
  return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    return String(vars[key] ?? '');
  });
};

const filterRowsByScope = (rows, table, ctx = null) => {
  const scope = String(table?.scope || '').trim().toLowerCase();
  if (!scope) return rows;
  if (scope === 'global') return rows.filter(row => !row?.contact_id && !row?.group_id);
  if (scope === 'contact') {
    return rows.filter(row => row?.contact_id);
  }
  if (scope === 'group') return rows.filter(row => row?.group_id);
  return rows;
};

const resolveRowSortOrderForSave = ({ tableId = '', rowData = {}, existingRow = null, siblingRows = [] } = {}) => {
  const normalizedTableId = String(tableId || '').trim();
  if (isTimelineMemoryTableId(normalizedTableId)) {
    const round = extractMemoryTimelineRound(rowData?.time);
    if (round !== null) return round;
    const existingOrder = getMemoryRowSortOrder(existingRow);
    if (existingOrder !== null) return existingOrder;
    return computeNextMemoryRowSortOrder(siblingRows, normalizedTableId);
  }
  if (existingRow) {
    const existingOrder = getMemoryRowSortOrder(existingRow);
    if (existingOrder !== null) return existingOrder;
    return null;
  }
  return computeNextMemoryRowSortOrder(siblingRows, normalizedTableId);
};

const normalizeTimelineRowDataForSave = (tableId, rowData = {}, fallbackTurn = null) => {
  if (!isTimelineMemoryTableId(tableId)) return rowData;
  const next = { ...(rowData || {}) };
  const round = extractMemoryTimelineRound(next.time);
  if (round !== null) {
    next.time = buildMemoryTimelineLabel(round);
    return next;
  }
  const fallbackRound = Math.trunc(Number(fallbackTurn));
  if (Number.isFinite(fallbackRound) && fallbackRound >= 0) {
    next.time = buildMemoryTimelineLabel(fallbackRound);
  }
  return next;
};

const buildWorldbookEntriesForTable = (table, rows) => {
  const exportConfig = table?.exportConfig || {};
  const tableName = String(table?.name || table?.id || '记忆表格');
  const tableId = String(table?.id || '');
  const entryBase = String(exportConfig.entryName || tableName || tableId).trim() || tableName;
  const keywords = normalizeKeywords(exportConfig.keywords);
  const splitByRow = exportConfig.splitByRow === true;
  const templateText = String(exportConfig.injectionTemplate || (splitByRow ? '{{rowText}}' : '{{tableData}}'));
  const tableData = buildTableDataText(table, rows);
  const now = Date.now();
  if (!splitByRow) {
    const content = renderExportTemplate(templateText, {
      tableName,
      tableId,
      tableData,
      rowText: '',
      rowIndex: '',
      rowData: '',
    });
    return [{
      id: `memtable-${tableId || 'table'}-${now}`,
      comment: entryBase,
      content,
      key: keywords,
      order: 100,
      depth: 4,
      position: 0,
      constant: keywords.length === 0,
      selective: keywords.length > 0,
      preventRecursion: true,
      disable: false,
    }];
  }
  return rows.map((row, idx) => {
    const rowText = formatRowDetail(row?.row_data || {}, table?.columns || []);
    const rowData = (() => {
      try {
        return JSON.stringify(row?.row_data || {});
      } catch {
        return '';
      }
    })();
    const content = renderExportTemplate(templateText, {
      tableName,
      tableId,
      tableData,
      rowText,
      rowIndex: idx,
      rowData,
    });
    return {
      id: `memtable-${tableId || 'table'}-${now}-${idx}`,
      comment: `${entryBase} #${idx + 1}`,
      content,
      key: keywords,
      order: 100,
      depth: 4,
      position: 0,
      constant: keywords.length === 0,
      selective: keywords.length > 0,
      preventRecursion: true,
      disable: false,
    };
  });
};

export class MemoryTableEditor {
  constructor({
    container,
    getContext,
    memoryStore,
    templateStore,
    contactsStore = null,
    chatStore = null,
    getMessages = null,
    includeGlobal = true,
    onRendered = null,
  } = {}) {
    this.container = container || null;
    this.getContext = typeof getContext === 'function' ? getContext : () => null;
    this.memoryStore = memoryStore || null;
    this.templateStore = templateStore || null;
    this.contactsStore = contactsStore || null;
    this.chatStore = chatStore || null;
    this.getMessages = typeof getMessages === 'function' ? getMessages : null;
    this.includeGlobal = includeGlobal !== false;
    // 每次列表重画后回报「几张表、几行」，供设置页手机版的摘要行使用。
    this.onRendered = typeof onRendered === 'function' ? onRendered : null;
    this.lastOverview = { tableCount: 0, rowCount: 0 };
    // 手机宽度改用标签 + 卡片；记住当前标签，切换方向决定横移动画。
    this.activeTableId = '';
    this.tabDirection = 0;
    this.cardQuery = typeof window !== 'undefined' ? window.matchMedia?.(MEMORY_TABLE_CARD_QUERY) || null : null;
    this.onLayoutChange = () => {
      if (!this.container || this.container.style.display === 'none' || !this.currentContext) return;
      this.renderTableList(this.currentContext);
    };
    this.cardQuery?.addEventListener?.('change', this.onLayoutChange);
    this.template = null;
    this.memories = [];
    this.timelineRepairPlan = null;
    this.timelineRepairCacheKey = '';
    this.timelineRepairCache = null;
    this.timelineRepairPendingKey = '';
    this.timelineRepairCheckToken = 0;
    this.dismissedTimelineRepairKey = '';
    this.batchMode = false;
    this.selectedIds = new Set();
    this.searchTerm = '';
    this.visibleIds = new Set();
    this.currentContext = null;
    this.toolbarWrap = null;
    this.impactEl = null;
    this.timelineRepairWrap = null;
    this.listWrap = null;
    this.searchInput = null;
    this.batchBtn = null;
    this.batchBar = null;
    this.batchCount = null;
    this.batchEnableBtn = null;
    this.batchDisableBtn = null;
    this.batchDeleteBtn = null;
    this.batchSelectAllBtn = null;
    this.batchClearBtn = null;
    this.modalOverlay = null;
    this.modalPanel = null;
    this.modalSave = null;
    this.modalCancel = null;
    this.modalFields = [];
    this.modalMeta = null;
    this.modalImpact = null;
    this.modalHeader = null;
    this.modalSubtitle = null;
    this.modalForm = null;
    this.promptWrap = null;
    this.promptTemplateInput = null;
    this.promptWrapperInput = null;
    this.promptPositionSelect = null;
    this.promptPositionSelectButton = null;
    this.promptPreviewInput = null;
    this.promptSaveBtn = null;
    this.promptRefreshBtn = null;
    this.promptLastRawBtn = null;
    this.promptLastPromptBtn = null;
    this.lastUpdateOverlay = null;
    this.lastUpdatePanel = null;
    this.lastUpdateTitle = null;
    this.lastUpdateMeta = null;
    this.lastUpdateContent = null;
    this.lastUpdateCopyBtn = null;
    this.__onSave = null;
    this.__lastContextKey = '';
    this.__suppressNextMemoryRowsUpdated = false;

    this.onTemplatesUpdated = () => {
      if (!this.container) return;
      if (this.container.style.display === 'none') return;
      this.render().catch(() => {});
    };
    window.addEventListener('memory-templates-updated', this.onTemplatesUpdated);

    this.onMemoriesUpdated = () => {
      if (!this.container) return;
      if (this.container.style.display === 'none') return;
      if (this.__suppressNextMemoryRowsUpdated) {
        this.__suppressNextMemoryRowsUpdated = false;
        return;
      }
      this.renderPreservingScroll().catch(() => {});
    };
    window.addEventListener('memory-rows-updated', this.onMemoriesUpdated);
  }

  isCardLayout() {
    return this.cardQuery?.matches === true;
  }

  reportOverview(overview = { tableCount: 0, rowCount: 0 }) {
    this.lastOverview = overview;
    try {
      this.onRendered?.(overview);
    } catch (err) {
      logger.debug?.('memory table overview callback failed', err);
    }
  }

  destroy() {
    this.cardQuery?.removeEventListener?.('change', this.onLayoutChange);
    window.removeEventListener('memory-templates-updated', this.onTemplatesUpdated);
    window.removeEventListener('memory-rows-updated', this.onMemoriesUpdated);
  }

  async render({ showLoading = true } = {}) {
    if (!this.container) return;
    const ctx = this.getContext();
    if (!ctx) {
      this.ensureLayout();
      if (this.listWrap) {
        this.listWrap.innerHTML = '<div style="color:var(--app-text-muted); font-size:12px;">未获取到会话信息。</div>';
      }
      return;
    }
    this.currentContext = ctx;
    const contextKey = `${ctx.type || ''}:${ctx.uiMode || ''}:${ctx.contactId || ''}:${ctx.groupId || ''}`;
    if (contextKey !== this.__lastContextKey) {
      this.__lastContextKey = contextKey;
      this.batchMode = false;
      this.selectedIds.clear();
      this.searchTerm = '';
      this.activeTableId = '';
      this.timelineRepairCheckToken += 1;
      this.timelineRepairPendingKey = '';
    }
    this.ensureLayout();
    this.setImpactText('manage', ctx);
    this.renderToolbar();
    if (showLoading && this.listWrap) {
      this.listWrap.innerHTML = '<div style="color:var(--app-text-muted); font-size:12px;">加载记忆表格…</div>';
    }
    try {
      await this.loadData(ctx);
      await this.updatePromptSection(ctx);
      this.renderTableList(ctx);
    } catch (err) {
      logger.warn('render memory tables failed', err);
      if (this.listWrap) {
        this.listWrap.innerHTML = '<div style="color:#ef4444; font-size:12px;">加载记忆表格失败</div>';
      }
    }
  }

  captureScrollState() {
    if (!this.container) return null;
    const lists = [...this.container.querySelectorAll?.('.memory-table-row-list[data-memory-table-id]') || []]
      .map((el, index) => ({
        tableId: String(el.dataset?.memoryTableId || ''),
        index,
        scrollTop: Number(el.scrollTop || 0),
        scrollLeft: Number(el.scrollLeft || 0),
      }));
    const ancestors = [];
    let node = this.container;
    while (node) {
      if (
        Number(node.scrollTop || 0) > 0 ||
        Number(node.scrollLeft || 0) > 0 ||
        Number(node.scrollHeight || 0) > Number(node.clientHeight || 0) ||
        Number(node.scrollWidth || 0) > Number(node.clientWidth || 0)
      ) {
        ancestors.push({
          el: node,
          scrollTop: Number(node.scrollTop || 0),
          scrollLeft: Number(node.scrollLeft || 0),
        });
      }
      node = node.parentElement || null;
    }
    return { lists, ancestors };
  }

  restoreScrollState(state = null) {
    if (!state || !this.container) return false;
    for (const item of Array.isArray(state.ancestors) ? state.ancestors : []) {
      if (!item?.el) continue;
      item.el.scrollTop = item.scrollTop;
      item.el.scrollLeft = item.scrollLeft;
    }
    const currentLists = [...this.container.querySelectorAll?.('.memory-table-row-list[data-memory-table-id]') || []];
    for (const item of Array.isArray(state.lists) ? state.lists : []) {
      const target = currentLists.find(el => String(el.dataset?.memoryTableId || '') === item.tableId) || currentLists[item.index];
      if (!target) continue;
      target.scrollTop = item.scrollTop;
      target.scrollLeft = item.scrollLeft;
    }
    return true;
  }

  async renderPreservingScroll() {
    const scrollState = this.captureScrollState();
    await this.render({ showLoading: false });
    this.restoreScrollState(scrollState);
    const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : null;
    if (raf) raf(() => this.restoreScrollState(scrollState));
  }

  async loadData(ctx) {
    const template = await this.loadTemplate();
    this.template = template;
    this.memories = await this.loadMemories(ctx, template);
  }

  async loadTemplate() {
    if (!this.templateStore || typeof this.templateStore.getTemplates !== 'function') return null;
    const list = await this.templateStore.getTemplates({ is_default: true });
    if (Array.isArray(list) && list.length) {
      return this.templateStore.toTemplateDefinition?.(list[0]) || null;
    }
    const fallback = await this.templateStore.getTemplates({ id: 'default-v1' });
    if (Array.isArray(fallback) && fallback.length) {
      return this.templateStore.toTemplateDefinition?.(fallback[0]) || null;
    }
    return null;
  }

  async loadMemories(ctx, template) {
    if (!this.memoryStore || typeof this.memoryStore.getMemories !== 'function') return [];
    const templateId = String(template?.meta?.id || '').trim();
    if (!templateId) return [];
    const out = [];
    if (ctx.type === 'contact' || ctx.type === 'rp') {
      const contactId = String(ctx.contactId || '').trim();
      if (contactId) {
        const rows = await this.memoryStore.getMemories({ scope: 'contact', contact_id: contactId, template_id: templateId });
        out.push(...(Array.isArray(rows) ? rows : []));
      }
      if (this.includeGlobal) {
        const globals = await this.memoryStore.getMemories({ scope: 'global', template_id: templateId });
        out.push(...(Array.isArray(globals) ? globals : []));
      }
    } else if (ctx.type === 'group') {
      const groupId = String(ctx.groupId || '').trim();
      if (groupId) {
        const rows = await this.memoryStore.getMemories({ scope: 'group', group_id: groupId, template_id: templateId });
        out.push(...(Array.isArray(rows) ? rows : []));
      }
      if (this.includeGlobal) {
        const globals = await this.memoryStore.getMemories({ scope: 'global', template_id: templateId });
        out.push(...(Array.isArray(globals) ? globals : []));
      }
    } else if (ctx.type === 'global') {
      const globals = await this.memoryStore.getMemories({ scope: 'global', template_id: templateId });
      out.push(...(Array.isArray(globals) ? globals : []));
    }
    return out;
  }

  renderTableList(ctx) {
    if (!this.container || !this.listWrap) return;
    const template = this.template;
    if (!template || !Array.isArray(template.tables)) {
      this.cancelTimelineRepairCheck();
      this.listWrap.innerHTML = '<div style="color:var(--app-text-muted); font-size:12px;">未找到可用模板。</div>';
      this.reportOverview({ tableCount: 0, rowCount: 0 });
      return;
    }
    const tabsScrollLeft = this.listWrap.querySelector('.memory-cards-tabs')?.scrollLeft || 0;
    this.listWrap.innerHTML = '';
    this.visibleIds = new Set();
    const includeGlobal = this.includeGlobal;
    const tables = template.tables.filter(table => {
      if (ctx.type === 'contact' || ctx.type === 'rp') return table.scope === 'global' || table.scope === 'contact';
      if (ctx.type === 'group') return table.scope === 'global' || table.scope === 'group';
      if (ctx.type === 'global') return table.scope === 'global';
      return false;
    }).filter(table => {
      const sessionId = ctx?.type === 'group' ? ctx?.groupId : ctx?.contactId;
      return tableMatchesMemoryContext(table, {
        sessionId,
        contextType: ctx?.type,
        isGroup: ctx?.type === 'group',
        uiMode: ctx?.uiMode || (ctx?.type === 'rp' || isRpSessionId(sessionId) ? 'rp' : 'chat'),
      });
    }).filter(table => {
      if (!includeGlobal && table.scope === 'global') return false;
      return true;
    });
    if (!tables.length) {
      this.cancelTimelineRepairCheck();
      this.listWrap.innerHTML = '<div style="color:var(--app-text-muted); font-size:12px;">当前模板没有匹配的表格。</div>';
      this.reportOverview({ tableCount: 0, rowCount: 0 });
      return;
    }
    this.scheduleTimelineRepairCheck(ctx, tables);
    const cardLayout = this.isCardLayout();
    this.container.classList.toggle('is-card-layout', cardLayout);
    if (cardLayout) {
      this.listWrap.appendChild(this.renderCardLayout(tables, ctx, { tabsScrollLeft }));
    } else {
      for (const table of tables) {
        this.listWrap.appendChild(this.renderTableBlock(table, ctx));
      }
    }
    this.renderToolbar();
    this.reportOverview({
      tableCount: tables.length,
      rowCount: tables.reduce((sum, table) => sum + this.getScopedTableRows(table, ctx).length, 0),
    });
  }

  getScopedTableRows(table, ctx) {
    const rows = this.memories.filter(row => String(row.table_id || '') === String(table?.id || ''));
    return filterRowsByScope(rows, table, ctx);
  }

  // 手机版：一次只显示一张表，用标签切换；每行一张卡片。读写仍走编辑器原有方法。
  renderCardLayout(tables, ctx, { tabsScrollLeft = 0 } = {}) {
    const activeId = resolveActiveMemoryTableId(tables, this.activeTableId, item => this.getScopedTableRows(item, ctx).length);
    const order = tables.map(table => String(table.id || ''));
    const direction = this.tabDirection;
    this.tabDirection = 0;
    this.activeTableId = activeId;
    const table = tables.find(item => String(item.id || '') === activeId) || null;
    const scopedRows = table ? this.getScopedTableRows(table, ctx) : [];
    const rows = table ? sortMemoryRows(this.filterRows(scopedRows), { tableId: table.id }) : [];
    rows.forEach((row) => { if (row?.id) this.visibleIds.add(row.id); });
    const view = renderMemoryTableCardView({
      documentRef: document,
      tables,
      activeTableId: activeId,
      direction,
      getRowCount: item => this.getScopedTableRows(item, ctx).length,
      activeRows: rows,
      getCellViews: row => buildMemoryTableCellViews(row?.row_data || {}, table?.columns || [], { tableId: table?.id }),
      scopeLabel: table ? getRuntimeScopeLabel(table, ctx) : '',
      maxRows: Number(table?.maxRows) || 0,
      totalRows: scopedRows.length,
      batchMode: this.batchMode,
      selectedIds: this.selectedIds,
      searchTerm: this.searchTerm,
      onSelectTable: (id) => {
        this.tabDirection = order.indexOf(id) > order.indexOf(activeId) ? 1 : -1;
        this.activeTableId = id;
        this.renderTableList(this.currentContext);
      },
      onAdd: () => this.openEditor({ table, ctx, row: null }),
      onEdit: row => this.openEditor({ table, ctx, row }),
      onToggleSelect: (id, selected) => {
        if (selected) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
        this.renderTableList(this.currentContext);
      },
      onPush: () => this.pushTableToChat(table, scopedRows, ctx),
      onExport: () => this.exportTableToWorldbook(table, scopedRows, ctx),
    });
    const settle = () => {
      revealOverflowingMemoryCards(view);
      const tabs = view.querySelector('.memory-cards-tabs');
      const activeTab = tabs?.querySelector('.memory-cards-tab.is-active');
      if (!tabs || !activeTab) return;
      tabs.scrollLeft = tabsScrollLeft;
      const left = activeTab.offsetLeft - tabs.offsetLeft;
      if (left < tabs.scrollLeft || left + activeTab.offsetWidth > tabs.scrollLeft + tabs.clientWidth) {
        tabs.scrollTo?.({ left: Math.max(0, left - 16), behavior: isReducedMotion() ? 'auto' : 'smooth' });
      }
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(settle);
    return view;
  }

  ensureLayout() {
    if (!this.container || this.toolbarWrap) return;
    this.container.innerHTML = '';
    const promptWrap = document.createElement('details');
    promptWrap.className = 'memory-table-prompt-wrap';
    const promptSummary = document.createElement('summary');
    promptSummary.className = 'memory-table-prompt-summary';
    promptSummary.textContent = '记忆表格提示词（可编辑）';
    const promptBody = document.createElement('div');
    promptBody.className = 'memory-table-prompt-body';
    const templateLabel = document.createElement('div');
    templateLabel.className = 'memory-table-prompt-label';
    templateLabel.textContent = '模板（使用 {{tableData}} 插入表格内容）';
    const templateInput = document.createElement('textarea');
    templateInput.className = 'memory-table-prompt-input';
    templateInput.rows = 6;
    templateInput.placeholder = '{{tableData}}';
    const wrapperLabel = document.createElement('div');
    wrapperLabel.className = 'memory-table-prompt-label';
    wrapperLabel.textContent = '包裹模板（可选）';
    const wrapperInput = document.createElement('textarea');
    wrapperInput.className = 'memory-table-prompt-input';
    wrapperInput.rows = 3;
    wrapperInput.placeholder = '<memories>\n{{tableData}}\n</memories>';
    const positionRow = document.createElement('div');
    positionRow.className = 'memory-table-prompt-position';
    const positionLabel = document.createElement('div');
    positionLabel.className = 'memory-table-prompt-label';
    positionLabel.textContent = '注入位置';
    const positionSelect = document.createElement('select');
    positionSelect.className = 'memory-table-prompt-select';
    [
	      { value: 'after_persona', label: '角色设定后' },
	      { value: 'system_end', label: '系统末尾' },
	      { value: 'before_chat', label: '对话前' },
	      { value: 'history_before', label: 'History 前' },
	      { value: 'history_after', label: 'History 后' },
	      { value: 'history_depth', label: '深度注入（History 内）' },
	      { value: 'before_latest_user', label: '最新输入前' },
	      { value: 'after_latest_user', label: '最新输入后' },
	    ].forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      positionSelect.appendChild(option);
    });
    positionRow.appendChild(positionLabel);
    const positionWrap = createCustomSelectWrapper(positionSelect, {
      placeholder: '最新输入前',
      wrapperStyle: 'min-width:160px;',
      buttonStyle: 'min-width:160px;',
    });
    if (positionWrap) {
      bindCustomSelectButton({
        buttonEl: positionWrap.querySelector('button'),
        selectEl: positionSelect,
        fallback: '最新输入前',
      });
      positionRow.appendChild(positionWrap);
    } else {
      positionRow.appendChild(positionSelect);
    }
    const promptActions = document.createElement('div');
    promptActions.className = 'memory-table-prompt-actions';
    const promptRefresh = document.createElement('button');
    promptRefresh.className = 'memory-table-action-btn';
    promptRefresh.textContent = '刷新预览';
    const promptLastRaw = document.createElement('button');
    promptLastRaw.className = 'memory-table-action-btn';
    promptLastRaw.textContent = '查看最近写表原始输出';
    const promptLastPrompt = document.createElement('button');
    promptLastPrompt.className = 'memory-table-action-btn';
    promptLastPrompt.textContent = '查看最近写表请求提示词';
    const promptSave = document.createElement('button');
    promptSave.className = 'memory-table-action-btn memory-table-action-btn-primary';
    promptSave.textContent = '保存模板';
    promptActions.appendChild(promptRefresh);
    promptActions.appendChild(promptLastRaw);
    promptActions.appendChild(promptLastPrompt);
    promptActions.appendChild(promptSave);
    const previewLabel = document.createElement('div');
    previewLabel.className = 'memory-table-prompt-label';
    previewLabel.textContent = '当前会发送的提示词（预览）';
    const previewInput = document.createElement('textarea');
    previewInput.className = 'memory-table-prompt-input is-preview';
    previewInput.rows = 6;
    previewInput.readOnly = true;

    promptBody.appendChild(templateLabel);
    promptBody.appendChild(templateInput);
    promptBody.appendChild(wrapperLabel);
    promptBody.appendChild(wrapperInput);
    promptBody.appendChild(positionRow);
    promptBody.appendChild(promptActions);
    promptBody.appendChild(previewLabel);
    promptBody.appendChild(previewInput);

    promptWrap.appendChild(promptSummary);
    promptWrap.appendChild(promptBody);
    this.container.appendChild(promptWrap);
    this.promptWrap = promptWrap;
    this.promptTemplateInput = templateInput;
    this.promptWrapperInput = wrapperInput;
    this.promptPositionSelect = positionSelect;
    this.promptPositionSelectButton = positionWrap?.querySelector('button') || null;
    this.promptPreviewInput = previewInput;
    this.promptSaveBtn = promptSave;
    this.promptRefreshBtn = promptRefresh;
    this.promptLastRawBtn = promptLastRaw;
    this.promptLastPromptBtn = promptLastPrompt;

    const toolbarWrap = document.createElement('div');
    toolbarWrap.className = 'memory-table-toolbar';
    const row = document.createElement('div');
    row.className = 'memory-table-toolbar-row';
    const search = document.createElement('input');
    search.className = 'memory-table-search';
    search.type = 'text';
    search.placeholder = '搜索记忆…';
    search.oninput = () => {
      this.searchTerm = String(search.value || '');
      this.renderTableList(this.currentContext);
    };
    const batchBtn = document.createElement('button');
    batchBtn.className = 'memory-table-action-btn';
    batchBtn.onclick = () => {
      this.setBatchMode(!this.batchMode);
      this.renderTableList(this.currentContext);
    };
    row.appendChild(search);
    row.appendChild(batchBtn);
    toolbarWrap.appendChild(row);

    const impact = document.createElement('div');
    impact.className = 'memory-scope-badge';
    toolbarWrap.appendChild(impact);

    const bar = document.createElement('div');
    bar.className = 'memory-table-batch-bar';
    bar.style.display = 'none';
    const count = document.createElement('div');
    count.className = 'memory-table-batch-count';
    const selectAll = document.createElement('button');
    selectAll.className = 'memory-table-action-btn';
    selectAll.textContent = '全选';
    selectAll.onclick = () => {
      this.visibleIds.forEach(id => this.selectedIds.add(id));
      this.renderTableList(this.currentContext);
    };
    const clearBtn = document.createElement('button');
    clearBtn.className = 'memory-table-action-btn';
    clearBtn.textContent = '清空';
    clearBtn.onclick = () => {
      this.selectedIds.clear();
      this.renderTableList(this.currentContext);
    };
    const enableBtn = document.createElement('button');
    enableBtn.className = 'memory-table-action-btn';
    enableBtn.textContent = '启用';
    enableBtn.onclick = () => this.applyBatchUpdate({ is_active: true });
    const disableBtn = document.createElement('button');
    disableBtn.className = 'memory-table-action-btn';
    disableBtn.textContent = '禁用';
    disableBtn.onclick = () => this.applyBatchUpdate({ is_active: false });
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'memory-table-action-btn memory-table-row-btn-danger';
    deleteBtn.textContent = '删除';
    deleteBtn.onclick = () => this.applyBatchDelete();
    bar.appendChild(count);
    bar.appendChild(selectAll);
    bar.appendChild(clearBtn);
    bar.appendChild(enableBtn);
    bar.appendChild(disableBtn);
    bar.appendChild(deleteBtn);
    toolbarWrap.appendChild(bar);

    const listWrap = document.createElement('div');
    listWrap.className = 'memory-table-list';
    const timelineRepairWrap = document.createElement('div');
    timelineRepairWrap.className = 'memory-table-timeline-repair';
    timelineRepairWrap.style.display = 'none';
    this.container.appendChild(toolbarWrap);
    this.container.appendChild(timelineRepairWrap);
    this.container.appendChild(listWrap);
    this.toolbarWrap = toolbarWrap;
    this.impactEl = impact;
    this.timelineRepairWrap = timelineRepairWrap;
    this.listWrap = listWrap;
    this.searchInput = search;
    this.batchBtn = batchBtn;
    this.batchBar = bar;
    this.batchCount = count;
    this.batchSelectAllBtn = selectAll;
    this.batchClearBtn = clearBtn;
    this.batchEnableBtn = enableBtn;
    this.batchDisableBtn = disableBtn;
    this.batchDeleteBtn = deleteBtn;
  }

  renderToolbar() {
    if (!this.searchInput || !this.batchBtn || !this.batchBar || !this.batchCount) return;
    this.searchInput.value = this.searchTerm;
    this.batchBtn.textContent = this.batchMode ? '退出批量' : '批量操作';
    this.batchBar.style.display = this.batchMode ? 'flex' : 'none';
    this.batchCount.textContent = `已选 ${this.selectedIds.size} 条`;
    const hasSelected = this.selectedIds.size > 0;
    if (this.batchEnableBtn) this.batchEnableBtn.disabled = !hasSelected;
    if (this.batchDisableBtn) this.batchDisableBtn.disabled = !hasSelected;
    if (this.batchDeleteBtn) this.batchDeleteBtn.disabled = !hasSelected;
  }

  async updatePromptSection(ctx) {
    if (!this.promptTemplateInput || !this.promptWrapperInput || !this.promptPositionSelect) return;
    const template = this.template;
    if (!template || !template.meta) {
      this.promptTemplateInput.value = '';
      this.promptWrapperInput.value = '';
      this.promptPositionSelect.value = 'before_latest_user';
      if (this.promptPreviewInput) this.promptPreviewInput.value = '未找到可用模板。';
      return;
    }
    const injection = template.injection || {};
    const templateText = typeof injection.template === 'string' ? injection.template : '{{tableData}}';
    const wrapperText = typeof injection.wrapper === 'string' ? injection.wrapper : '<memories>\n{{tableData}}\n</memories>';
    const position = typeof injection.position === 'string' ? injection.position : 'before_latest_user';
    this.promptTemplateInput.value = templateText;
    this.promptWrapperInput.value = wrapperText;
    this.promptPositionSelect.value = position;
    if (this.promptPositionSelectButton) {
      refreshCustomSelectButton(this.promptPositionSelectButton, this.promptPositionSelect, '最新输入前');
    }
    if (this.promptSaveBtn) {
      this.promptSaveBtn.onclick = () => this.savePromptTemplate(ctx);
    }
    if (this.promptRefreshBtn) {
      this.promptRefreshBtn.onclick = () => this.refreshPromptPreview(ctx);
    }
    if (this.promptLastRawBtn) {
      this.promptLastRawBtn.onclick = () => this.showLastUpdateModal(ctx, 'raw');
    }
    if (this.promptLastPromptBtn) {
      this.promptLastPromptBtn.onclick = () => this.showLastUpdateModal(ctx, 'prompt');
    }
    await this.refreshPromptPreview(ctx);
  }

  getPromptPreviewContext(ctx) {
    const isMoments = String(ctx?.uiMode || '').trim().toLowerCase() === 'moments';
    const baseSessionId = isMoments ? 'moments' : (ctx?.type === 'group' ? ctx?.groupId : ctx?.contactId);
    const sessionId = String(baseSessionId || window.appBridge?.getActiveSessionId?.() || '').trim();
    const isGroup = ctx?.type === 'group' || String(sessionId).startsWith('group:');
    const isRp = ctx?.type === 'rp' || isRpSessionId(sessionId);
    const contact = sessionId ? this.contactsStore?.getContact?.(sessionId) : null;
    const characterName = String(contact?.name || (isMoments ? '动态' : (isGroup ? sessionId.replace(/^group:/, '') : sessionId)) || '助手');
    const settings = appSettings.get();
    const memoryInjectPosition = String(settings.memoryInjectPosition || 'before_latest_user').toLowerCase();
    const memoryInjectDepthRaw = Math.trunc(Number(settings.memoryInjectDepth));
    const memoryInjectDepth = Number.isFinite(memoryInjectDepthRaw) ? Math.max(0, memoryInjectDepthRaw) : 4;
    const memoryAutoMode = String(settings.memoryAutoExtractMode || 'inline').toLowerCase();
    const memoryPlaceEnabled = isMoments
      ? settings.memoryTableEnabledMoments !== false
      : isRp
        ? settings.memoryTableEnabledWriting !== false
        : settings.memoryTableEnabledChat !== false;
    const memoryAutoExtract = memoryPlaceEnabled && settings.memoryAutoExtract === true && memoryAutoMode !== 'separate';
    return {
      user: { name: '用户' },
      character: { name: characterName },
      session: { id: sessionId, isGroup },
      meta: {
        memoryStorageMode: 'table',
        memoryAutoExtract,
        memoryInjectPosition,
        memoryInjectDepth,
        memoryContextType: isMoments ? 'global' : '',
        memorySessionId: isMoments ? 'moments' : '',
        sharedMemory: false,
        uiMode: isMoments ? 'moments' : (isRp ? 'rp' : 'chat'),
        defaultRpBridgeSessionId: !isRp ? String(window.appBridge?.getRpSessionIdForActivePersona?.() || '').trim() : '',
        defaultChatBridgeSessionId: isRp
          ? String(window.appBridge?.getLastChatSessionId?.() || window.appBridge?.getLastSocialSessionId?.() || '').trim()
          : '',
      },
      group: isGroup ? { id: sessionId, name: characterName, members: [], memberNames: [] } : null,
      history: [],
    };
  }

  resolveSessionId(ctx) {
    if (!ctx) return '';
    if (String(ctx.uiMode || '').trim().toLowerCase() === 'moments') return 'moments';
    if (ctx.type === 'group') return String(ctx.groupId || '').trim();
    if (ctx.type === 'rp') return String(ctx.contactId || '').trim();
    if (ctx.type === 'contact') return String(ctx.contactId || '').trim();
    return String(window.appBridge?.getActiveSessionId?.() || '').trim();
  }

  buildImpactText(action = 'manage', ctx = this.currentContext, table = null) {
    return buildMemoryImpactText({
      contextType: ctx?.type || '',
      uiMode: ctx?.uiMode || '',
      sessionId: this.resolveSessionId(ctx),
      contactId: ctx?.contactId || '',
      groupId: ctx?.groupId || '',
      scope: table?.scope || '',
      action,
    });
  }

  buildImpactScopeLabel(ctx = this.currentContext, table = null) {
    return formatMemoryImpactScopeLabel({
      contextType: ctx?.type || '',
      uiMode: ctx?.uiMode || '',
      sessionId: this.resolveSessionId(ctx),
      contactId: ctx?.contactId || '',
      groupId: ctx?.groupId || '',
      scope: table?.scope || '',
    });
  }

  setImpactText(action = 'manage', ctx = this.currentContext, table = null, target = this.impactEl) {
    if (!target) return;
    const impactText = translateUiText(this.buildImpactText(action, ctx, table));
    target.setAttribute?.('data-i18n-skip', '');
    target.textContent = translateUiText(`作用域：${this.buildImpactScopeLabel(ctx, table)}`);
    target.title = impactText;
    target.setAttribute('aria-label', impactText);
  }

  async syncManualMemoryMutation(ctx, { source = 'manual_memory_edit', templateId = '' } = {}) {
    const sessionId = this.resolveSessionId(ctx);
    const resolvedTemplateId = String(templateId || this.template?.meta?.id || '').trim();
    this.__suppressNextMemoryRowsUpdated = true;
    emitSharedMemoryRowsUpdated({
      target: window,
      sessionId,
      templateId: resolvedTemplateId,
    });
    if (this.__suppressNextMemoryRowsUpdated) this.__suppressNextMemoryRowsUpdated = false;
    if (!sessionId) return false;
    const syncFn = window.appBridge?.syncCurrentMemoryStateAfterTimelineRepair;
    if (typeof syncFn !== 'function') return false;
    try {
      return Boolean(await syncFn(sessionId, {
        source: String(source || 'manual_memory_edit').trim() || 'manual_memory_edit',
      }));
    } catch (err) {
      logger.warn('sync manual memory mutation snapshot failed', err);
      window.toastr?.warning?.('记忆已保存，但同步当前对话快照失败，重新进入后可能需要再次保存');
      return false;
    }
  }

  getScopedTimelineRows(ctx, tables = []) {
    if (!ctx || ctx.type === 'global' || !Array.isArray(tables)) return [];
    const rows = [];
    for (const table of tables) {
      const tableId = String(table?.id || '').trim();
      if (!tableId || !isTimelineMemoryTableId(tableId)) continue;
      if (String(table?.scope || '').trim().toLowerCase() === 'global') continue;
      const allRows = this.memories.filter(row => String(row?.table_id || '') === tableId);
      rows.push(...filterRowsByScope(allRows, table, ctx));
    }
    return rows;
  }

  buildTimelineRepairSignature(ctx, tables = []) {
    const sessionId = this.resolveSessionId(ctx);
    if (!sessionId) return '';
    const rows = this.getScopedTimelineRows(ctx, tables);
    if (!rows.length) return '';
    const rowSig = rows
      .map(row => {
        const id = String(row?.id || '').trim();
        const tableId = String(row?.table_id || '').trim();
        const time = String(row?.row_data?.time || '').trim();
        const order = getMemoryRowSortOrder(row);
        return `${tableId}:${id}:${time}:${order ?? ''}`;
      })
      .join('|');
    return `${ctx?.type || ''}:${sessionId}:${rowSig}`;
  }

  async resolveContextMessagesForTimelineRepair(ctx) {
    const sessionId = this.resolveSessionId(ctx);
    if (!sessionId) return [];
    try {
      if (typeof this.chatStore?.exportThreadMessages === 'function') {
        const exported = await this.chatStore.exportThreadMessages(sessionId, this.chatStore.getCurrentArchiveId?.(sessionId));
        if (Array.isArray(exported) && exported.length) return exported;
      }
    } catch (err) {
      logger.debug('timeline repair full message export failed', err);
    }
    try {
      if (this.getMessages) {
        const result = await this.getMessages(sessionId);
        if (Array.isArray(result)) return result;
      }
    } catch (err) {
      logger.debug('timeline repair getMessages failed', err);
    }
    try {
      const result = this.chatStore?.getMessages?.(sessionId);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  async buildTimelineRepairPlanForContext(ctx, tables = []) {
    const rows = this.getScopedTimelineRows(ctx, tables);
    if (!rows.length) {
      return { checked: 0, assistantCount: 0, repairable: [], unrepairable: [], hasIssues: false };
    }
    const messages = await this.resolveContextMessagesForTimelineRepair(ctx);
    if (!messages.length) {
      return { checked: rows.length, assistantCount: 0, repairable: [], unrepairable: [], hasIssues: false };
    }
    return buildMemoryTimelineRepairPlan({ rows, messages, tables });
  }

  scheduleTimelineRepairCheck(ctx, tables = []) {
    const signature = this.buildTimelineRepairSignature(ctx, tables);
    if (!signature) {
      this.cancelTimelineRepairCheck();
      return;
    }
    if (signature === this.timelineRepairCacheKey && this.timelineRepairCache) {
      this.renderTimelineRepairNotice(this.timelineRepairCache, ctx, signature);
      return;
    }
    if (signature === this.timelineRepairPendingKey) return;
    this.hideTimelineRepairNotice();
    this.timelineRepairPendingKey = signature;
    const token = ++this.timelineRepairCheckToken;
    this.buildTimelineRepairPlanForContext(ctx, tables)
      .then((plan) => {
        if (token !== this.timelineRepairCheckToken) return;
        this.timelineRepairPlan = plan;
        this.timelineRepairCacheKey = signature;
        this.timelineRepairCache = plan;
        this.renderTimelineRepairNotice(plan, ctx, signature);
      })
      .catch((err) => {
        if (token !== this.timelineRepairCheckToken) return;
        logger.warn('timeline repair check failed', err);
        this.hideTimelineRepairNotice();
      })
      .finally(() => {
        if (this.timelineRepairPendingKey === signature) {
          this.timelineRepairPendingKey = '';
        }
      });
  }

  buildTimelineRepairNoticeKey(plan, signature = '') {
    if (!plan?.hasIssues) return '';
    const repairable = (plan.repairable || [])
      .map(item => `${item.rowId}:${item.currentRound ?? ''}:${item.currentSortOrder ?? ''}->${item.expectedRound}`)
      .join('|');
    const unrepairable = (plan.unrepairable || [])
      .map(item => `${item.rowId}:${item.currentRound ?? ''}:${item.reason || ''}`)
      .join('|');
    return `${signature}:${repairable}:${unrepairable}`;
  }

  hideTimelineRepairNotice() {
    if (!this.timelineRepairWrap) return;
    this.timelineRepairWrap.style.display = 'none';
    this.timelineRepairWrap.innerHTML = '';
  }

  cancelTimelineRepairCheck() {
    this.timelineRepairCheckToken += 1;
    this.timelineRepairPendingKey = '';
    this.hideTimelineRepairNotice();
  }

  renderTimelineRepairNotice(plan, ctx, signature = '') {
    if (!this.timelineRepairWrap) return;
    if (!plan?.hasIssues) {
      this.hideTimelineRepairNotice();
      return;
    }
    const noticeKey = this.buildTimelineRepairNoticeKey(plan, signature);
    if (noticeKey && noticeKey === this.dismissedTimelineRepairKey) {
      this.hideTimelineRepairNotice();
      return;
    }
    const repairableCount = Array.isArray(plan.repairable) ? plan.repairable.length : 0;
    const unrepairableCount = Array.isArray(plan.unrepairable) ? plan.unrepairable.length : 0;
    const box = document.createElement('div');
    box.style.cssText = [
      'border:1px solid var(--app-border-default)',
      'border-radius:12px',
      'padding:10px',
      'background:var(--app-surface-card)',
      'box-shadow:inset 3px 0 0 #ca8a04',
      'display:flex',
      'gap:10px',
      'align-items:flex-start',
      'flex-wrap:wrap',
    ].join(';');
    const text = document.createElement('div');
    text.style.cssText = 'flex:1; min-width:180px; color:var(--app-text-primary); font-size:12px; line-height:1.5;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:900; margin-bottom:2px;';
    title.textContent = '检测到记忆表格轮次可能与当前用户请求轮次不一致';
    const detail = document.createElement('div');
    const parts = [];
    if (repairableCount) parts.push(`可自动修正 ${repairableCount} 条`);
    if (unrepairableCount) parts.push(`${unrepairableCount} 条无法可靠匹配`);
    detail.textContent = `${parts.join('，') || '暂无可修正项'}。自动修正只改 time 和排序，不改记忆内容。`;
    text.appendChild(title);
    text.appendChild(detail);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;';
    const repairBtn = document.createElement('button');
    repairBtn.textContent = '修正轮次';
    repairBtn.disabled = repairableCount <= 0;
    repairBtn.style.cssText = 'padding:6px 10px; border:1px solid var(--app-border-default); border-radius:9px; background:var(--app-text-primary); color:var(--app-surface-card); cursor:pointer; font-size:12px; font-weight:800;';
    if (repairBtn.disabled) {
      repairBtn.style.opacity = '0.55';
      repairBtn.style.cursor = 'not-allowed';
    }
    repairBtn.onclick = () => {
      this.repairTimelineRows(plan, ctx).catch((err) => {
        logger.warn('timeline repair apply failed', err);
        window.toastr?.error?.('修正记忆轮次失败');
      });
    };
    const ignoreBtn = document.createElement('button');
    ignoreBtn.textContent = '忽略';
    ignoreBtn.style.cssText = 'padding:6px 10px; border:1px solid var(--app-border-default); border-radius:9px; background:var(--app-surface-subtle); color:var(--app-text-primary); cursor:pointer; font-size:12px;';
    ignoreBtn.onclick = () => {
      this.dismissedTimelineRepairKey = noticeKey;
      this.hideTimelineRepairNotice();
    };
    actions.appendChild(repairBtn);
    actions.appendChild(ignoreBtn);
    box.appendChild(text);
    box.appendChild(actions);
    this.timelineRepairWrap.innerHTML = '';
    this.timelineRepairWrap.appendChild(box);
    this.timelineRepairWrap.style.display = 'block';
  }

  async repairTimelineRows(plan, ctx) {
    const items = Array.isArray(plan?.repairable) ? plan.repairable : [];
    if (!items.length || !this.memoryStore) return;
    const unrepairableCount = Array.isArray(plan?.unrepairable) ? plan.unrepairable.length : 0;
    const ok = await appConfirm({
      title: '修正记忆轮次',
      message: `将按当前聊天记录修正 ${items.length} 条摘要/大纲轮次。${unrepairableCount ? `另有 ${unrepairableCount} 条无法可靠匹配，不会修改。` : ''}\n\n只修改 time 和排序，不修改记忆内容。\n\n${this.buildImpactText('repair', ctx)}`,
    });
    if (!ok) return;
    let changed = 0;
    for (const item of items) {
      if (!item?.rowId || !item?.rowData) continue;
      await this.memoryStore.updateMemory({
        id: item.rowId,
        row_data: item.rowData,
        sort_order: item.sortOrder,
      });
      changed += 1;
    }
    if (changed > 0) {
      const sessionId = this.resolveSessionId(ctx);
      let synced = false;
      const syncFn = window.appBridge?.syncCurrentMemoryStateAfterTimelineRepair;
      if (sessionId && typeof syncFn === 'function') {
        try {
          synced = await syncFn(sessionId, { source: 'manual_timeline_repair' });
        } catch (err) {
          logger.warn('sync manual timeline repair snapshot failed', err);
          window.toastr?.warning?.('记忆轮次已修正，但同步当前对话快照失败，重新进入后可能需要再次修正');
        }
      }
      if (!synced && sessionId) {
        try {
          window.dispatchEvent(new CustomEvent('memory-timeline-repaired', {
            detail: {
              sessionId,
              isGroup: ctx?.type === 'group',
              changed,
              source: 'manual_timeline_repair_event',
            },
          }));
        } catch {}
      }
    }
    this.timelineRepairCacheKey = '';
    this.timelineRepairCache = null;
    this.timelineRepairPendingKey = '';
    this.timelineRepairPlan = null;
    this.dismissedTimelineRepairKey = '';
    if (changed > 0) window.toastr?.success?.(`已修正 ${changed} 条记忆轮次`);
    await this.render();
  }

  pushTableToChat(table, rows, ctx) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      window.toastr?.info?.('当前表格暂无可推送的数据');
      return;
    }
    const sessionId = this.resolveSessionId(ctx);
    if (!sessionId) {
      window.toastr?.error?.('未找到会话，无法推送');
      return;
    }
    const tableData = buildTableDataText(table, list);
    const summary = `记忆表格推送：${String(table?.name || table?.id || '记忆表格')}`;
    const html = [
      '<details>',
      `<summary>${escapeHtml(summary)}</summary>`,
      `<pre>${escapeHtml(tableData)}</pre>`,
      '</details>',
    ].join('');
    window.dispatchEvent(new CustomEvent('memory-table-push', { detail: { sessionId, content: html } }));
    window.toastr?.success?.('已推送到聊天');
  }

  async exportTableToWorldbook(table, rows, ctx) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      window.toastr?.info?.('当前表格暂无可导出的数据');
      return;
    }
    const exportConfig = table?.exportConfig || {};
    if (exportConfig.enabled !== true) {
      const ok = await appConfirm({
        title: '导出确认',
        message: `该表未开启世界书导出，仍要继续导出吗？\n\n${this.buildImpactText('export_worldbook', ctx, table)}`,
      });
      if (!ok) return;
    }
    const worldId = await this.resolveWorldbookIdForTable(table, ctx);
    if (!worldId) return;
    const appBridge = window.appBridge;
    if (!appBridge?.getWorldInfo || !appBridge?.saveWorldInfo) {
      window.toastr?.error?.('世界书不可用，无法导出');
      return;
    }
    try {
      const current = await appBridge.getWorldInfo(worldId);
      const payload = current && typeof current === 'object' ? current : { name: worldId, entries: [] };
      if (!Array.isArray(payload.entries)) payload.entries = [];
      const entries = buildWorldbookEntriesForTable(table, list);
      payload.entries.push(...entries);
      await appBridge.saveWorldInfo(worldId, payload);
      window.toastr?.success?.(`已导出 ${entries.length} 条到世界书`);
    } catch (err) {
      logger.warn('export worldbook failed', err);
      window.toastr?.error?.('导出世界书失败');
    }
  }

  async resolveWorldbookIdForTable(table, ctx) {
    const appBridge = window.appBridge;
    if (!appBridge) return '';
    const scope = String(table?.scope || '').trim().toLowerCase();
    const effectiveScope = scope;
    const sessionId = this.resolveSessionId(ctx);
    if (effectiveScope === 'global') {
      let worldId = getGlobalWorldId(appBridge);
      if (!worldId) {
        const ok = await appConfirm({
          title: '创建世界书',
          message: `未设置全局世界书，是否创建并设为全局世界书？\n\n${this.buildImpactText('export_worldbook', ctx, table)}`,
        });
        if (!ok) return '';
        worldId = 'memory-table-global';
        try {
          const snapshot = await appBridge.getWorldInfoSnapshot?.(worldId);
          if (!snapshot?.exists) {
            await appBridge.saveWorldInfo(worldId, { name: worldId, entries: [] }, snapshot ? {
              expectedRevision: snapshot.revision,
              expectedGeneration: snapshot.generation,
              expectedExists: false,
            } : undefined);
          }
          appBridge.setGlobalWorld?.(worldId);
        } catch {
          return '';
        }
      }
      return worldId;
    }
    let worldId = getCurrentWorldId(appBridge);
    if (!worldId) {
      const ok = await appConfirm({
        title: '创建世界书',
        message: `未设置当前会话世界书，是否创建并设为当前世界书？\n\n${this.buildImpactText('export_worldbook', ctx, table)}`,
      });
      if (!ok) return '';
      const rawId = sessionId || 'default';
      const safeId = rawId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
      worldId = `memory-table-${safeId}`;
      try {
        const snapshot = await appBridge.getWorldInfoSnapshot?.(worldId);
        if (!snapshot?.exists) {
          await appBridge.saveWorldInfo(worldId, { name: worldId, entries: [] }, snapshot ? {
            expectedRevision: snapshot.revision,
            expectedGeneration: snapshot.generation,
            expectedExists: false,
          } : undefined);
        }
        setCurrentWorld(appBridge, worldId, sessionId);
      } catch {
        return '';
      }
    }
    return worldId;
  }

  async refreshPromptPreview(ctx) {
    if (!this.promptPreviewInput) return;
    if (!window.appBridge?.buildMemoryPromptPlan) {
      this.promptPreviewInput.value = '记忆提示词预览不可用。';
      return;
    }
    this.promptPreviewInput.value = '加载中...';
    try {
      const context = this.getPromptPreviewContext(ctx);
      const plan = await window.appBridge.buildMemoryPromptPlan(context);
      if (!plan?.enabled) {
        const reason = String(plan?.reason || '');
        const msg = reason === 'memory_mode'
          ? '当前记忆模式为摘要，请切换到记忆表格'
          : reason === 'missing_template'
            ? '未找到默认模板'
            : reason === 'missing_session'
              ? '未找到会话'
              : '记忆提示词暂不可用';
        this.promptPreviewInput.value = msg;
        return;
      }
      this.promptPreviewInput.value = plan.promptText || '暂无可发送的提示词。';
    } catch (err) {
      logger.warn('memory prompt preview failed', err);
      this.promptPreviewInput.value = '提示词预览失败';
    }
  }

  async savePromptTemplate(ctx) {
    if (!this.templateStore || !this.template) return;
    const templateId = String(this.template?.meta?.id || '').trim();
    if (!templateId) return;
    const templateText = String(this.promptTemplateInput?.value || '').trim() || '{{tableData}}';
    const wrapperText = String(this.promptWrapperInput?.value || '').trim();
    const position = String(this.promptPositionSelect?.value || 'before_latest_user');
    const injection = {
      template: templateText,
      wrapper: wrapperText,
      position,
    };
    try {
      await this.templateStore.updateTemplateInjection(templateId, injection);
      this.template.injection = injection;
      window.dispatchEvent(new CustomEvent('memory-templates-updated', { detail: { templateId } }));
      window.toastr?.success?.('记忆提示词模板已保存');
      await this.refreshPromptPreview(ctx);
    } catch (err) {
      logger.warn('save memory prompt failed', err);
      window.toastr?.error?.('保存提示词失败');
    }
  }

  ensureLastUpdateModal() {
    if (this.lastUpdatePanel) return;
    const overlay = document.createElement('div');
    overlay.className = 'app-themed-overlay memory-last-update-overlay';
    overlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:22000;';
    overlay.addEventListener('click', () => this.hideLastUpdateModal());
    const panel = document.createElement('div');
    panel.className = 'app-themed-panel memory-last-update-panel';
    panel.style.cssText = `
      display:none; position:fixed;
      left: calc(12px + env(safe-area-inset-left, 0px));
      right: calc(12px + env(safe-area-inset-right, 0px));
      bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      max-height: calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
      background:var(--app-surface-card); border-radius:14px; box-shadow:0 10px 40px rgba(0,0,0,0.28);
      z-index:23000;
      overflow:hidden;
      display:flex; flex-direction:column;
    `;
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.innerHTML = `
      <div style="padding:12px 14px; border-bottom:1px solid rgba(0,0,0,0.06); display:flex; align-items:center; gap:10px;">
        <div data-role="title" style="font-weight:900; color:var(--app-text-primary);">最近写表原始输出</div>
        <div data-role="meta" style="margin-left:auto; font-size:12px; color:var(--app-text-muted);"></div>
        <button data-role="copy" style="border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:10px; padding:6px 10px;">复制</button>
        <button data-role="close" style="border:none; background:transparent; font-size:22px; cursor:pointer; color:var(--app-text-primary);">×</button>
      </div>
      <textarea data-role="content" readonly style="flex:1; min-height:0; padding:12px 14px; border:none; resize:none; font-family: monospace; font-size:12px;"></textarea>
    `;
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    this.lastUpdateOverlay = overlay;
    this.lastUpdatePanel = panel;
    this.lastUpdateTitle = panel.querySelector('[data-role="title"]');
    this.lastUpdateMeta = panel.querySelector('[data-role="meta"]');
    this.lastUpdateContent = panel.querySelector('[data-role="content"]');
    this.lastUpdateCopyBtn = panel.querySelector('[data-role="copy"]');
    panel.querySelector('[data-role="close"]')?.addEventListener('click', () => this.hideLastUpdateModal());
    this.lastUpdateCopyBtn?.addEventListener('click', async () => {
      const text = String(this.lastUpdateContent?.value || '');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        window.toastr?.success?.('已复制');
        return;
      } catch {}
      try {
        this.lastUpdateContent?.select?.();
        document.execCommand('copy');
        window.toastr?.success?.('已复制');
      } catch {
        window.toastr?.warning?.('复制失败');
      }
    });
  }

  hideLastUpdateModal() {
    if (this.lastUpdateOverlay) this.lastUpdateOverlay.style.display = 'none';
    if (this.lastUpdatePanel) this.lastUpdatePanel.style.display = 'none';
  }

  showLastUpdateModal(ctx, view = 'raw') {
    this.ensureLastUpdateModal();
    const sessionId = this.resolveSessionId(ctx);
    if (!this.lastUpdateOverlay || !this.lastUpdatePanel || !this.lastUpdateContent || !this.lastUpdateMeta) return;
    const viewType = view === 'prompt' ? 'prompt' : 'raw';
    if (this.lastUpdateTitle) {
      this.lastUpdateTitle.textContent = viewType === 'prompt' ? '最近写表请求提示词' : '最近写表原始输出';
    }
    if (!sessionId) {
      this.lastUpdateMeta.textContent = '未找到会话';
      this.lastUpdateContent.value = '当前页面不是聊天会话。';
      this.lastUpdateOverlay.style.display = 'block';
      this.lastUpdatePanel.style.display = 'flex';
      return;
    }
    const entry = getLastMemoryUpdate(window.appBridge, sessionId);
    if (!entry) {
      this.lastUpdateMeta.textContent = '暂无记录';
      this.lastUpdateContent.value = viewType === 'prompt' ? '尚未记录任何写表请求提示词。' : '尚未记录任何写表输出。';
      this.lastUpdateOverlay.style.display = 'block';
      this.lastUpdatePanel.style.display = 'flex';
      return;
    }
    const when = entry?.at ? new Date(entry.at).toLocaleString() : '';
    const mode = entry?.mode === 'separate' ? '独立请求' : '同请求';
    this.lastUpdateMeta.textContent = [mode, when].filter(Boolean).join(' · ');
    if (viewType === 'prompt') {
      const promptText = String(entry?.requestPrompt || '').trim();
      // textarea 在 DOM 翻译器跳过范围内，兜底文案须在 JS 侧翻译
      this.lastUpdateContent.value = promptText || translateUiText('尚未记录任何写表请求提示词。');
    } else {
      const tableEditRaw = String(entry?.tableEditRaw || '').trim();
      const raw = String(entry?.raw || '').trim();
      const display = tableEditRaw ? `<tableEdit>\n${tableEditRaw}\n</tableEdit>` : raw || translateUiText('（空）');
      this.lastUpdateContent.value = display;
    }
    this.lastUpdateOverlay.style.display = 'block';
    this.lastUpdatePanel.style.display = 'flex';
  }

  renderTableBlock(table, ctx) {
    const block = document.createElement('div');
    block.className = 'memory-table-block';
    block.style.setProperty('--memory-table-index', String(Math.min(this.listWrap?.children?.length || 0, 8)));
    const header = document.createElement('div');
    header.className = 'memory-table-block-header';
    const title = document.createElement('div');
    title.className = 'memory-table-block-title';
    title.dataset.i18nSkip = '';
    title.textContent = translateUiText(table.name || table.id || '记忆表格');
    const titleLine = document.createElement('div');
    titleLine.className = 'memory-table-block-title-line';
    titleLine.appendChild(title);
    if (table.id && String(table.id) !== String(table.name || '')) {
      const key = document.createElement('code');
      key.className = 'memory-table-block-key';
      key.textContent = String(table.id);
      titleLine.appendChild(key);
    }
    const meta = document.createElement('div');
    meta.className = 'memory-table-block-meta';
    const allRows = this.memories.filter(row => String(row.table_id || '') === String(table.id || ''));
    const scopedRows = filterRowsByScope(allRows, table, ctx);
    const appendMetaPill = (text, tone = '') => {
      const pill = document.createElement('span');
      pill.className = `memory-table-meta-pill${tone ? ` is-${tone}` : ''}`;
      pill.textContent = text;
      meta.appendChild(pill);
    };
    appendMetaPill(getRuntimeScopeLabel(table, ctx), 'scope');
    appendMetaPill(`${scopedRows.length}${table.maxRows ? ` / ${table.maxRows}` : ''} 行`);
    appendMetaPill(`${table.columns?.length || 0} 列`);
    const titleWrap = document.createElement('div');
    titleWrap.className = 'memory-table-block-title-wrap';
    titleWrap.appendChild(titleLine);
    titleWrap.appendChild(meta);
    const addBtn = document.createElement('button');
    addBtn.className = 'memory-table-action-btn memory-table-action-btn-soft';
    addBtn.textContent = '新增';
    if (table.maxRows && scopedRows.length >= table.maxRows) {
      addBtn.disabled = true;
    }
    addBtn.onclick = () => this.openEditor({ table, ctx, row: null });
    const pushBtn = document.createElement('button');
    pushBtn.className = 'memory-table-action-btn';
    pushBtn.textContent = '推送';
    pushBtn.onclick = () => this.pushTableToChat(table, scopedRows, ctx);
    const exportBtn = document.createElement('button');
    exportBtn.className = 'memory-table-action-btn memory-table-action-btn-accent';
    exportBtn.textContent = '导出世界书';
    exportBtn.onclick = () => this.exportTableToWorldbook(table, scopedRows, ctx);
    const actionWrap = document.createElement('div');
    actionWrap.className = 'memory-table-block-actions';
    actionWrap.appendChild(addBtn);
    actionWrap.appendChild(pushBtn);
    actionWrap.appendChild(exportBtn);
    header.appendChild(titleWrap);
    header.appendChild(actionWrap);
    block.appendChild(header);

    const list = document.createElement('div');
    list.className = 'memory-table-row-list';
    list.dataset.memoryTableId = String(table.id || '');
    const rows = this.filterRows(scopedRows);
    const orderedRows = sortMemoryRows(rows, { tableId: table.id });
    const columns = buildMemoryTableCellViews({}, table.columns || [], { tableId: table.id });
    const dataTable = document.createElement('table');
    dataTable.className = 'memory-table-data-grid';
    dataTable.setAttribute('aria-label', translateUiText(table.name || table.id || '记忆表格'));
    const tableHead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    if (this.batchMode) {
      const selectHeader = document.createElement('th');
      selectHeader.className = 'memory-table-select-header';
      selectHeader.scope = 'col';
      selectHeader.textContent = '选择';
      headerRow.appendChild(selectHeader);
    }
    columns.forEach((column) => {
      const columnHeader = document.createElement('th');
      columnHeader.className = `memory-table-column-header is-${column.kind}`;
      columnHeader.dataset.columnId = column.id;
      columnHeader.dataset.cellKind = column.kind;
      columnHeader.scope = 'col';
      columnHeader.dataset.i18nSkip = '';
      columnHeader.textContent = translateUiText(column.label);
      headerRow.appendChild(columnHeader);
    });
    const actionHeader = document.createElement('th');
    actionHeader.className = 'memory-table-action-header';
    actionHeader.scope = 'col';
    actionHeader.textContent = '操作';
    headerRow.appendChild(actionHeader);
    tableHead.appendChild(headerRow);
    dataTable.appendChild(tableHead);
    const tableBody = document.createElement('tbody');
    if (!orderedRows.length) {
      const emptyRow = document.createElement('tr');
      emptyRow.className = 'memory-table-empty-row';
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = columns.length + 1 + (this.batchMode ? 1 : 0);
      const empty = document.createElement('div');
      empty.className = 'memory-table-empty';
      empty.textContent = this.searchTerm ? '无匹配内容' : '暂无记忆条目';
      emptyCell.appendChild(empty);
      emptyRow.appendChild(emptyCell);
      tableBody.appendChild(emptyRow);
    } else {
      orderedRows.forEach((row, rowIndex) => {
        if (row?.id) this.visibleIds.add(row.id);
        tableBody.appendChild(this.renderRowItem(row, table, ctx, rowIndex));
      });
    }
    dataTable.appendChild(tableBody);
    list.appendChild(dataTable);
    block.appendChild(list);
    return block;
  }

  filterRows(rows) {
    const term = String(this.searchTerm || '').trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(row => {
      const data = row?.row_data || {};
      const blob = Object.values(data)
        .map(v => String(v ?? '').toLowerCase())
        .join(' ');
      return blob.includes(term);
    });
  }

  renderRowItem(row, table, ctx, rowIndex = 0) {
    const item = document.createElement('tr');
    item.className = 'memory-table-row-item';
    item.classList.toggle('is-inactive', !row.is_active);
    item.classList.toggle('is-selected', this.selectedIds.has(row.id));
    item.style.setProperty('--memory-row-index', String(Math.min(rowIndex, 10)));
    item.dataset.memoryRowId = String(row.id || '');

    if (this.batchMode) {
      const selectCell = document.createElement('td');
      selectCell.className = 'memory-table-select-cell';
      const select = document.createElement('input');
      select.className = 'memory-table-row-check';
      select.type = 'checkbox';
      select.checked = this.selectedIds.has(row.id);
      select.setAttribute('aria-label', '选择记忆');
      select.onchange = () => {
        if (select.checked) this.selectedIds.add(row.id);
        else this.selectedIds.delete(row.id);
        this.renderTableList(this.currentContext);
      };
      selectCell.appendChild(select);
      item.appendChild(selectCell);
    }

    buildMemoryTableCellViews(row.row_data || {}, table.columns || [], { tableId: table.id }).forEach((cellView) => {
      const cell = document.createElement('td');
      cell.className = `memory-table-cell is-${cellView.kind}`;
      cell.dataset.columnId = cellView.id;
      cell.dataset.cellKind = cellView.kind;
      if (!cellView.value) {
        const emptyValue = document.createElement('span');
        emptyValue.className = 'memory-table-cell-empty';
        emptyValue.textContent = '—';
        cell.appendChild(emptyValue);
      } else if (cellView.kind === 'tag') {
        const tagList = document.createElement('span');
        tagList.className = 'memory-table-cell-tags';
        cellView.tags.forEach((tagText) => {
          const tag = document.createElement('span');
          tag.className = 'memory-table-cell-tag';
          tag.textContent = tagText;
          tagList.appendChild(tag);
        });
        cell.appendChild(tagList);
      } else {
        const value = document.createElement('span');
        value.className = `memory-table-cell-value memory-table-row-main${cellView.kind === 'chip' ? ' is-chip' : ''}`;
        value.textContent = cellView.value;
        cell.appendChild(value);
      }
      item.appendChild(cell);
    });

    const actionCell = document.createElement('td');
    actionCell.className = 'memory-table-action-cell';
    const metaParts = [];
    if (!row.is_active) metaParts.push('已停用');
    if (row.is_pinned) metaParts.push('置顶');
    if (typeof row.priority === 'number' && row.priority !== 0) metaParts.push(`优先级 ${row.priority}`);
    if (metaParts.length) {
      const metaLine = document.createElement('div');
      metaLine.className = 'memory-table-row-meta';
      metaLine.textContent = metaParts.join(' · ');
      actionCell.appendChild(metaLine);
    }

    const controls = document.createElement('div');
    controls.className = 'memory-table-row-controls';

    const activeToggle = document.createElement('input');
    activeToggle.className = 'memory-table-row-toggle is-active';
    activeToggle.type = 'checkbox';
    activeToggle.checked = Boolean(row.is_active);
    activeToggle.title = '启用';
    activeToggle.setAttribute('aria-label', '启用记忆');
    activeToggle.onchange = async () => {
      try {
        await this.memoryStore.updateMemory({ id: row.id, is_active: Boolean(activeToggle.checked) });
        await this.syncManualMemoryMutation(ctx, { source: 'manual_memory_active_toggle' });
      } catch (err) {
        logger.warn('update memory active failed', err);
      }
      this.renderPreservingScroll().catch(() => {});
    };
    const activeControl = document.createElement('label');
    activeControl.className = 'memory-table-toggle-control';
    const activeText = document.createElement('span');
    activeText.textContent = '启用';
    activeControl.append(activeToggle, activeText);
    const pinToggle = document.createElement('input');
    pinToggle.className = 'memory-table-row-toggle is-pin';
    pinToggle.type = 'checkbox';
    pinToggle.checked = Boolean(row.is_pinned);
    pinToggle.title = '置顶';
    pinToggle.setAttribute('aria-label', '置顶记忆');
    pinToggle.onchange = async () => {
      try {
        await this.memoryStore.updateMemory({ id: row.id, is_pinned: Boolean(pinToggle.checked) });
        await this.syncManualMemoryMutation(ctx, { source: 'manual_memory_pin_toggle' });
      } catch (err) {
        logger.warn('update memory pinned failed', err);
      }
      this.renderPreservingScroll().catch(() => {});
    };
    const pinControl = document.createElement('label');
    pinControl.className = 'memory-table-toggle-control';
    const pinText = document.createElement('span');
    pinText.textContent = '置顶';
    pinControl.append(pinToggle, pinText);
    const editBtn = document.createElement('button');
    editBtn.className = 'memory-table-row-btn';
    editBtn.textContent = '编辑';
    editBtn.onclick = () => this.openEditor({ table, ctx, row });
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'memory-table-row-btn memory-table-row-btn-danger';
    deleteBtn.textContent = '删除';
    deleteBtn.onclick = async () => {
      const ok = await appConfirm({
        title: '删除记忆',
        message: `确定要删除该记忆条目吗？\n\n${this.buildImpactText('delete', ctx, table)}`,
        danger: true,
      });
      if (!ok) return;
      try {
        await this.memoryStore.deleteMemory(row.id);
        await this.syncManualMemoryMutation(ctx, { source: 'manual_memory_delete' });
      } catch (err) {
        logger.warn('delete memory failed', err);
      }
      this.renderPreservingScroll().catch(() => {});
    };

    if (this.batchMode) {
      activeToggle.disabled = true;
      pinToggle.disabled = true;
      editBtn.disabled = true;
      deleteBtn.disabled = true;
    }

    controls.appendChild(activeControl);
    controls.appendChild(pinControl);
    controls.appendChild(editBtn);
    controls.appendChild(deleteBtn);
    actionCell.appendChild(controls);
    item.appendChild(actionCell);
    return item;
  }

  setBatchMode(enabled) {
    const next = Boolean(enabled);
    this.batchMode = next;
    if (!next) this.selectedIds.clear();
  }

  async applyBatchUpdate(patch) {
    const ids = [...this.selectedIds];
    if (!ids.length) {
      window.toastr?.info?.('未选择任何记忆');
      return;
    }
    const isDisable = patch?.is_active === false;
    const isEnable = patch?.is_active === true;
    if (isDisable || isEnable) {
      const ok = await appConfirm({
        title: '批量修改记忆',
        message: `确定要${isDisable ? '停用' : '启用'}所选记忆（${ids.length} 条）吗？\n\n${this.buildImpactText('batch_update', this.currentContext)}`,
      });
      if (!ok) return;
    }
    try {
      for (const id of ids) {
        await this.memoryStore.updateMemory({ id, ...patch });
      }
      await this.syncManualMemoryMutation(this.currentContext, { source: 'manual_memory_batch_update' });
      this.selectedIds.clear();
      this.renderPreservingScroll().catch(() => {});
    } catch (err) {
      logger.warn('batch update failed', err);
      window.toastr?.error?.('批量操作失败');
    }
  }

  async applyBatchDelete() {
    const ids = [...this.selectedIds];
    if (!ids.length) {
      window.toastr?.info?.('未选择任何记忆');
      return;
    }
    const ok = await appConfirm({
      title: '删除记忆',
      message: `确定要删除所选记忆（${ids.length} 条）吗？\n\n${this.buildImpactText('delete', this.currentContext)}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await this.memoryStore.batchDeleteMemories(ids);
      await this.syncManualMemoryMutation(this.currentContext, { source: 'manual_memory_batch_delete' });
      this.selectedIds.clear();
      this.renderPreservingScroll().catch(() => {});
    } catch (err) {
      logger.warn('batch delete failed', err);
      window.toastr?.error?.('批量删除失败');
    }
  }

  ensureEditorModal() {
    if (this.modalPanel) return;
    this.modalOverlay = document.createElement('div');
    this.modalOverlay.className = 'app-themed-overlay memory-editor-overlay';
    this.modalOverlay.style.display = 'none';
    this.modalOverlay.addEventListener('click', () => this.closeEditor());
    this.modalPanel = document.createElement('div');
    this.modalPanel.className = 'app-themed-panel memory-editor-panel';
    this.modalPanel.style.display = 'none';
    this.modalPanel.setAttribute('role', 'dialog');
    this.modalPanel.setAttribute('aria-modal', 'true');
    this.modalPanel.setAttribute('aria-labelledby', 'memory-editor-dialog-title');
    this.modalPanel.addEventListener('click', (e) => e.stopPropagation());
    this.modalPanel.innerHTML = `
      <span class="memory-editor-grabber" aria-hidden="true"></span>
      <div class="memory-editor-header">
        <span class="memory-editor-mark" aria-hidden="true"></span>
        <div class="memory-editor-heading">
          <div id="memory-editor-dialog-title" data-role="header" class="memory-editor-title">编辑条目</div>
          <div data-role="subtitle" class="memory-editor-subtitle"></div>
        </div>
        <button type="button" data-role="close" class="memory-editor-close" aria-label="关闭">×</button>
      </div>
      <div class="memory-editor-impact">
        <div data-role="impact" class="memory-scope-badge"></div>
      </div>
      <div data-role="form" class="memory-editor-form"></div>
      <div class="memory-editor-footer">
        <span class="memory-editor-footer-note">保存后，发送预览将实时更新</span>
        <div class="memory-editor-footer-actions">
          <button type="button" data-role="delete" class="memory-editor-button is-danger" hidden>删除</button>
          <button type="button" data-role="cancel" class="memory-editor-button">取消</button>
          <button type="button" data-role="save" class="memory-editor-button is-primary">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.modalOverlay);
    document.body.appendChild(this.modalPanel);
    this.modalHeader = this.modalPanel.querySelector('[data-role="header"]');
    this.modalSubtitle = this.modalPanel.querySelector('[data-role="subtitle"]');
    this.modalImpact = this.modalPanel.querySelector('[data-role="impact"]');
    this.modalForm = this.modalPanel.querySelector('[data-role="form"]');
    this.modalSave = this.modalPanel.querySelector('[data-role="save"]');
    this.modalCancel = this.modalPanel.querySelector('[data-role="cancel"]');
    this.modalDelete = this.modalPanel.querySelector('[data-role="delete"]');
    this.modalPanel.querySelector('[data-role="close"]').onclick = () => this.closeEditor();
    this.modalCancel.onclick = () => this.closeEditor();
    // 手机上是底部面板：按住把手或标题区往下拖可关闭。
    for (const handle of [this.modalPanel.querySelector('.memory-editor-grabber'), this.modalPanel.querySelector('.memory-editor-header')]) {
      bindSheetDragToDismiss({
        handleEl: handle,
        panelEl: this.modalPanel,
        isEnabled: () => this.isCardLayout(),
        onDismiss: () => this.closeEditor(),
      });
    }
  }

  openEditor({ table, ctx, row }) {
    this.ensureEditorModal();
    if (!this.modalForm || !this.modalHeader) return;
    const isNew = !row;
    clearTimeout(this.__closeTimer);
    this.modalPanel.classList.remove('is-closing');
    this.modalOverlay?.classList.remove('is-closing');
    this.modalPanel.style.transform = '';
    if (this.modalDelete) {
      this.modalDelete.hidden = isNew;
      this.modalDelete.onclick = isNew ? null : async () => {
        const ok = await appConfirm({
          title: '删除记忆',
          message: `确定要删除该记忆条目吗？删除后无法恢复。\n\n${this.buildImpactText('delete', ctx, table)}`,
          danger: true,
        });
        if (!ok) return;
        try {
          await this.memoryStore.deleteMemory(row.id);
          await this.syncManualMemoryMutation(ctx, { source: 'manual_memory_delete' });
          this.closeEditor();
        } catch (err) {
          logger.warn('delete memory failed', err);
          window.toastr?.error?.('删除失败');
        }
        this.renderPreservingScroll().catch(() => {});
      };
    }
    const tableRows = this.memories.filter(item => String(item?.table_id || '') === String(table?.id || ''));
    const scopedRowsForHeader = filterRowsByScope(tableRows, table, ctx);
    this.modalPanel.dataset.mode = isNew ? 'add' : 'edit';
    this.modalHeader.textContent = isNew ? '新增条目' : '编辑条目';
    if (this.modalSubtitle) {
      const rowCount = `${scopedRowsForHeader.length}${table.maxRows ? `/${table.maxRows}` : ''} 行`;
      this.modalSubtitle.textContent = [
        table.name || table.id || '记忆表格',
        getRuntimeScopeLabel(table, ctx),
        rowCount,
      ].join(' · ');
    }
    this.setImpactText('edit', ctx, table, this.modalImpact);
    this.modalForm.innerHTML = '';
    this.modalFields = [];

    for (const col of table.columns || []) {
      const field = this.createField(col, row?.row_data?.[col.id], { tableId: table.id });
      this.modalForm.appendChild(field.wrapper);
      this.modalFields.push(field);
    }

    const metaWrap = document.createElement('div');
    metaWrap.className = 'memory-editor-meta';
    const metaTitle = document.createElement('div');
    metaTitle.className = 'memory-editor-meta-title';
    metaTitle.textContent = '条目状态';
    const metaControls = document.createElement('div');
    metaControls.className = 'memory-editor-meta-controls';
    const activeBox = document.createElement('label');
    activeBox.className = 'memory-editor-meta-option';
    const activeInput = document.createElement('input');
    activeInput.type = 'checkbox';
    activeInput.className = 'memory-editor-check';
    activeInput.checked = row ? Boolean(row.is_active) : true;
    activeBox.appendChild(activeInput);
    activeBox.appendChild(document.createTextNode('启用'));

    const pinBox = document.createElement('label');
    pinBox.className = 'memory-editor-meta-option';
    const pinInput = document.createElement('input');
    pinInput.type = 'checkbox';
    pinInput.className = 'memory-editor-check';
    pinInput.checked = row ? Boolean(row.is_pinned) : false;
    pinBox.appendChild(pinInput);
    pinBox.appendChild(document.createTextNode('置顶'));

    const priorityWrap = document.createElement('label');
    priorityWrap.className = 'memory-editor-meta-option is-priority';
    const priorityInput = document.createElement('input');
    priorityInput.type = 'number';
    priorityInput.className = 'memory-editor-priority-input';
    priorityInput.min = '-9';
    priorityInput.max = '9';
    priorityInput.step = '1';
    priorityInput.value = row ? String(row.priority ?? 0) : '0';
    priorityWrap.appendChild(document.createTextNode('优先级'));
    priorityWrap.appendChild(priorityInput);

    metaControls.appendChild(activeBox);
    metaControls.appendChild(pinBox);
    metaControls.appendChild(priorityWrap);
    metaWrap.appendChild(metaTitle);
    metaWrap.appendChild(metaControls);
    this.modalForm.appendChild(metaWrap);

    this.modalMeta = { activeInput, pinInput, priorityInput };
    this.__onSave = async () => {
      const rawRowData = {};
      for (const field of this.modalFields) {
        rawRowData[field.id] = field.getValue();
      }
      const allRows = this.memories.filter(item => String(item?.table_id || '') === String(table?.id || ''));
      const scopedRows = filterRowsByScope(allRows, table, ctx).filter(item => String(item?.id || '') !== String(row?.id || ''));
      const fallbackTurn = isTimelineMemoryTableId(table?.id) ? scopedRows.length + (row ? 0 : 1) : null;
      const rowData = normalizeTimelineRowDataForSave(table?.id, rawRowData, fallbackTurn);
      const sortOrder = resolveRowSortOrderForSave({
        tableId: table?.id,
        rowData,
        existingRow: row,
        siblingRows: scopedRows,
      });
      const contactId = table.scope === 'contact' ? String(ctx.contactId || '') : null;
      const groupId = table.scope === 'group' ? String(ctx.groupId || '') : null;
      const payload = {
        template_id: this.template?.meta?.id,
        table_id: table.id,
        contact_id: contactId,
        group_id: groupId,
        row_data: rowData,
        is_active: Boolean(activeInput.checked),
        is_pinned: Boolean(pinInput.checked),
        priority: Number(priorityInput.value || 0) || 0,
        ...(Number.isFinite(Number(sortOrder)) && Number(sortOrder) > 0 ? { sort_order: Number(sortOrder) } : {}),
      };
      try {
        if (row) {
          await this.memoryStore.updateMemory({
            id: row.id,
            row_data: rowData,
            is_active: Boolean(activeInput.checked),
            is_pinned: Boolean(pinInput.checked),
            priority: Number(priorityInput.value || 0) || 0,
            ...(Number.isFinite(Number(sortOrder)) && Number(sortOrder) > 0 ? { sort_order: Number(sortOrder) } : {}),
          });
        } else {
          await this.memoryStore.createMemory(payload);
        }
        await this.syncManualMemoryMutation(ctx, {
          source: row ? 'manual_memory_update' : 'manual_memory_create',
        });
        this.closeEditor();
        this.renderPreservingScroll().catch(() => {});
      } catch (err) {
        logger.warn('save memory failed', err);
        window.toastr?.error?.('保存失败');
      }
    };
    if (this.modalSave) {
      this.modalSave.disabled = false;
      this.modalSave.onclick = () => {
        try {
          this.__onSave?.();
        } catch {}
      };
    }
    if (this.modalOverlay) this.modalOverlay.style.display = 'block';
    if (this.modalPanel) {
      this.modalPanel.classList.add('is-open');
      this.modalPanel.style.display = 'flex';
    }
  }

  createField(column, value, { tableId = '' } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'memory-editor-field';
    const label = document.createElement('label');
    label.className = 'memory-editor-label';
    const labelText = isOutlineSectionColumn(tableId, column)
      ? '大纲类别'
      : String(column.name || column.id || '字段');
    const labelName = document.createElement('span');
    labelName.textContent = labelText;
    label.appendChild(labelName);
    if (column.type === 'multiline') {
      const hint = document.createElement('span');
      hint.className = 'memory-editor-field-hint';
      hint.textContent = '长文本';
      label.appendChild(hint);
    }
    wrapper.appendChild(label);

    let input;
    let selectWrap = null;
    if (column.type === 'multiline') {
      input = document.createElement('textarea');
      input.className = 'memory-editor-input is-textarea';
    } else if (column.type === 'select') {
      input = document.createElement('select');
      input.className = 'memory-editor-input memory-editor-native-select';
      const fieldView = buildMemoryTableSelectFieldView({ column, tableId, value });
      const opts = fieldView.options;
      if (!opts.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（无选项）';
        input.appendChild(opt);
      } else {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '请选择';
        input.appendChild(empty);
        for (const optionView of opts) {
          const opt = document.createElement('option');
          opt.value = optionView.value;
          opt.textContent = optionView.label;
          input.appendChild(opt);
        }
      }
      input.value = fieldView.value;
      input.disabled = fieldView.readOnly;
      selectWrap = createCustomSelectWrapper(input, {
        placeholder: '请选择',
        buttonClass: 'world-app-select-btn memory-editor-input memory-editor-select-button',
        wrapperStyle: '',
      });
      if (selectWrap) {
        selectWrap.className = 'memory-editor-select-wrap';
        bindCustomSelectButton({
          buttonEl: selectWrap.querySelector('button'),
          selectEl: input,
          fallback: '请选择',
        });
      }
    } else {
      input = document.createElement('input');
      input.type = column.type === 'number' ? 'number' : 'text';
      input.className = 'memory-editor-input';
    }
    input.setAttribute('aria-label', labelText);
    if (column.type !== 'select') input.placeholder = `填写${labelText}…`;
    if (column.type !== 'select') {
      input.value = value !== undefined && value !== null ? String(value) : '';
    }
    if (selectWrap) {
      refreshCustomSelectButton(selectWrap.querySelector('button'), input, '请选择');
      wrapper.appendChild(selectWrap);
    } else {
      wrapper.appendChild(input);
    }

    return {
      wrapper,
      id: column.id,
      getValue: () => String(input.value || '').trim(),
    };
  }

  closeEditor() {
    this.__onSave = null;
    const finish = () => {
      clearTimeout(this.__closeTimer);
      if (this.modalOverlay) {
        this.modalOverlay.style.display = 'none';
        this.modalOverlay.classList.remove('is-closing');
      }
      if (this.modalPanel) {
        this.modalPanel.classList.remove('is-open');
        this.modalPanel.classList.remove('is-closing');
        this.modalPanel.style.display = 'none';
        this.modalPanel.style.transform = '';
      }
    };
    // 手机底部面板往下滑出后再隐藏；拖动关闭时从手指放开处接着滑。
    if (this.modalPanel && this.modalPanel.style.display !== 'none' && this.isCardLayout() && !isReducedMotion()) {
      // 不清位移：收起动画的关键帧没有起点，会从当前（含拖动）位置接着滑出。
      this.modalPanel.classList.add('is-closing');
      this.modalOverlay?.classList.add('is-closing');
      clearTimeout(this.__closeTimer);
      this.__closeTimer = setTimeout(finish, 220);
      return;
    }
    finish();
  }
}
