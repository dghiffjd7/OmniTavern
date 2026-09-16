import { resolveMemoryRowOrderKey } from './memory-row-order.js';
import { getCurrentLocale, translateUiText } from '../i18n/index.js';
import { getOutlineSectionLabel, isOutlineTableId } from './outline-section-utils.js';
import { parseMemoryCoverageInterval } from './memory-coverage-utils.js';

const MEMORY_PROMPT_POSITIONS = new Set([
  'after_persona',
  'system_end',
  'before_chat',
  'history_before',
  'history_after',
  'history_depth',
  'before_latest_user',
  'after_latest_user',
]);
const SUMMARY_TABLE_IDS = new Set([
  'chat_summary',
  'group_summary',
  'chat_outline',
  'group_outline',
  'rp_summary',
  'rp_outline',
  'moment_summary',
  'moment_outline',
]);
const SUMMARY_LIMIT_TABLE_IDS = new Set(['chat_summary', 'group_summary', 'rp_summary', 'moment_summary']);
const MEMORY_BRIDGE_TABLE_LABELS = {
  character_profile: '角色档案',
  relationship: '关系记录',
  events: '重要事件',
  items: '重要物品',
  chat_summary: '摘要',
  chat_outline: '大纲',
  important_people: '重要人物表',
  group_consensus: '群聊共识',
  group_summary: '摘要',
  group_outline: '大纲',
  moment_summary: '摘要',
  moment_outline: '大纲',
  rp_important_people: '重要人物表',
  rp_tasks: '任务',
  rp_summary: '摘要',
  rp_outline: '大纲',
};

export const isSummaryTableId = (tableId) => {
  const id = String(tableId || '').trim();
  return SUMMARY_TABLE_IDS.has(id);
};

export const isSummaryLimitTableId = (tableId) => {
  const id = String(tableId || '').trim();
  return SUMMARY_LIMIT_TABLE_IDS.has(id);
};

export const limitSummaryRowsForPrompt = (rows = [], limit = 10) => {
  const list = Array.isArray(rows) ? rows : [];
  const safeLimit = Math.max(0, Math.trunc(Number(limit)) || 0);
  if (safeLimit <= 0) return [...list];
  const grouped = new Map();
  const kept = [];
  list.forEach((row, index) => {
    const tableId = String(row?.table_id || '').trim();
    if (!isSummaryLimitTableId(tableId)) {
      kept.push(row);
      return;
    }
    if (!grouped.has(tableId)) grouped.set(tableId, []);
    grouped.get(tableId).push({ row, index });
  });
  grouped.forEach((items, tableId) => {
    items.sort((a, b) => {
      const ak = resolveMemoryRowOrderKey(a.row, tableId, a.index);
      const bk = resolveMemoryRowOrderKey(b.row, tableId, b.index);
      if (ak !== bk) return ak - bk;
      return a.index - b.index;
    });
    items.slice(-safeLimit).forEach(item => kept.push(item.row));
  });
  return kept;
};

export const getMemoryBridgeTablePromptLabel = (tableId, fallback = '') => {
  const id = String(tableId || '').trim();
  const label = MEMORY_BRIDGE_TABLE_LABELS[id] || String(fallback || id || '').trim();
  return translateUiText(label);
};

export const quoteYamlString = (value) => JSON.stringify(String(value ?? ''));

export const buildMemoryBridgeYamlLines = ({
  header = '',
  tables = [],
} = {}) => {
  const title = String(header || '').trim();
  if (!title) return [];
  const tableList = Array.isArray(tables) ? tables : [];
  const bodyLines = [];
  tableList.forEach((table) => {
    const label = String(table?.label || '').trim();
    if (!label) return;
    const rows = (Array.isArray(table?.rows) ? table.rows : [])
      .map(row => String(row || '').trim())
      .filter(Boolean);
    if (!rows.length) return;
    bodyLines.push(`  - ${quoteYamlString(label)}:`);
    rows.forEach((row) => {
      bodyLines.push(`      - ${quoteYamlString(row)}`);
    });
  });
  if (!bodyLines.length) return [];
  return [
    `${quoteYamlString(title)}:`,
    ...bodyLines,
  ];
};

export const normalizeMemoryUpdateMode = (raw, defaultMode = 'full') => {
  const mode = String(raw || '').trim().toLowerCase();
  if (!mode) return defaultMode;
  if (mode === 'summary' || mode === 'summary-only' || mode === 'summary_only') return 'summary';
  if (mode === 'standard' || mode === 'standard-only' || mode === 'standard_only') return 'standard';
  if (mode === 'full' || mode === 'all' || mode === 'unified') return 'full';
  if (mode.includes('summary')) return 'summary';
  if (mode.includes('standard')) return 'standard';
  if (mode.includes('full') || mode.includes('unified') || mode.includes('all')) return 'full';
  return defaultMode;
};

export const parseMemoryPromptPositions = (raw) => {
  if (Array.isArray(raw)) {
    return raw
      .map(item => String(item || '').trim().toLowerCase())
      .filter(pos => MEMORY_PROMPT_POSITIONS.has(pos));
  }
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return [];
  const parts = text.split(/[+,]/).map(part => part.trim()).filter(Boolean);
  const out = [];
  parts.forEach((part) => {
    if (!MEMORY_PROMPT_POSITIONS.has(part)) return;
    if (!out.includes(part)) out.push(part);
  });
  return out;
};

export const normalizeTokenMode = (raw) => {
  const source = raw && typeof raw === 'object' ? raw.mode : raw;
  const mode = String(source || '').trim().toLowerCase();
  return mode === 'strict' ? 'strict' : 'rough';
};

export const resolveTokenEstimateCoefficient = (mode = 'rough', explicitCoefficient = null) => {
  const source = explicitCoefficient ?? (
    mode && typeof mode === 'object' ? mode.coefficient : null
  );
  const coefficient = Number(source);
  return Number.isFinite(coefficient) && coefficient > 0
    ? Math.max(0.25, Math.min(8, coefficient))
    : 1;
};

export const estimateTokens = (text, mode = 'rough', coefficient = null) => {
  const raw = String(text || '');
  if (!raw.trim()) return 0;
  const normalizedMode = normalizeTokenMode(mode);
  const base = normalizedMode === 'strict'
    ? raw.length
    : (() => {
        let ascii = 0;
        let nonAscii = 0;
        for (const ch of raw) {
          if (ch.charCodeAt(0) <= 0x7f) ascii += 1;
          else nonAscii += 1;
        }
        return nonAscii + ascii / 4;
      })();
  return Math.max(1, Math.ceil(base * resolveTokenEstimateCoefficient(mode, coefficient)));
};

export const clampText = (value, max = 140) => {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

export const normalizeMemoryCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizePromptCellText = (value) => normalizeMemoryCell(value).replace(/\s*\r?\n\s*/g, ' / ').trim();

const emptyPromptValue = () => translateUiText('（未填写）');
const joinPromptLabel = (label, value) => (
  getCurrentLocale() === 'en' ? `${label}: ${value}` : `${label}：${value}`
);

const extractTimelineRoundLabel = (value) => {
  // 区间行（滚动压缩大总结）必须整段展示，压成单点会让模型以为只讲末轮；
  // 排序仍由 resolveMemoryRowOrderKey 按区间末端处理，这里只管展示。
  const interval = parseMemoryCoverageInterval(normalizePromptCellText(value));
  if (interval) {
    if (getCurrentLocale() === 'en') {
      return interval.from === interval.to ? `Turn ${interval.from}` : `Turns ${interval.from}-${interval.to}`;
    }
    return interval.from === interval.to ? `第${interval.from}轮` : `第${interval.from}-${interval.to}轮`;
  }
  return normalizePromptCellText(value);
};

const extractTimelineContentText = (rowData, columns) => {
  const summary = normalizePromptCellText(rowData?.summary);
  if (summary) return summary;
  const outline = normalizePromptCellText(rowData?.outline);
  if (outline) return outline;
  for (const col of Array.isArray(columns) ? columns : []) {
    const colId = String(col?.id || '').trim();
    if (!colId || colId === 'time' || colId === 'keywords') continue;
    const text = normalizePromptCellText(rowData?.[colId]);
    if (text) return text;
  }
  return '';
};

const resolveSummaryTablePromptOrderKey = (row, fallback = 0) => {
  return resolveMemoryRowOrderKey(row, row?.table_id || row?.tableId || '', fallback);
};

export const formatMemoryRowText = (rowData, columns, tableId = '', outlineLabels = null) => {
  const id = String(tableId || '').trim();
  if (isOutlineTableId(id) && String(rowData?.section || '').trim()) {
    const content = normalizePromptCellText(rowData?.outline ?? rowData?.content);
    const sectionLabel = outlineLabels?.[rowData.section] ?? getOutlineSectionLabel(rowData.section);
    return joinPromptLabel(sectionLabel, content || emptyPromptValue());
  }
  if (SUMMARY_TABLE_IDS.has(id)) {
    const roundLabel = extractTimelineRoundLabel(rowData?.time);
    const content = extractTimelineContentText(rowData, columns);
    if (roundLabel && content) return joinPromptLabel(roundLabel, content);
    if (content) return content;
    if (roundLabel) return roundLabel;
    return emptyPromptValue();
  }
  const parts = [];
  for (const col of Array.isArray(columns) ? columns : []) {
    const colId = String(col?.id || '').trim();
    if (!colId || colId === 'keywords') continue;
    const label = String(col?.name || colId).trim();
    const rawText = normalizePromptCellText(rowData?.[colId]);
    const optionValues = Array.isArray(col?.options)
      ? col.options.map(value => String(value ?? '').trim())
      : [];
    const text = col?.type === 'select' && optionValues.includes(rawText)
      ? translateUiText(rawText)
      : rawText;
    if (!text) continue;
    parts.push(label ? `${label}: ${text}` : text);
  }
  if (!parts.length) return emptyPromptValue();
  return parts.join(getCurrentLocale() === 'en' ? '; ' : '；');
};

export const buildMemoryTablePlan = ({
  rows,
  tableById,
  tableOrder,
  autoExtract,
  maxRows,
  tokenBudgetData,
  tokenMode,
} = {}) => {
  const nextTableById = new Map(tableById || []);
  const nextTableOrder = Array.isArray(tableOrder) ? [...tableOrder] : [];
  const list = Array.isArray(rows) ? rows : [];
  const items = [];

  for (const row of list) {
    const tableId = String(row?.table_id || '').trim();
    if (!tableId) continue;
    if (!nextTableById.has(tableId)) {
      nextTableById.set(tableId, { id: tableId, name: tableId, columns: [] });
      if (!nextTableOrder.includes(tableId)) nextTableOrder.push(tableId);
    }
    const table = nextTableById.get(tableId);
    const rowText = formatMemoryRowText(row?.row_data || {}, table?.columns || [], tableId, table?.promptOutlineLabels);
    items.push({
      id: String(row?.id || ''),
      tableId,
      tableName: String(table?.name || tableId),
      rowText,
      rowSummary: clampText(rowText, 120),
      rowData: row?.row_data || {},
      isPinned: Boolean(row?.is_pinned),
      priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 0,
      updatedAt: Number.isFinite(Number(row?.updated_at)) ? Number(row.updated_at) : 0,
      scope: row?.contact_id ? 'contact' : row?.group_id ? 'group' : 'global',
    });
  }

  const sortByPriority = (a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return String(b.id).localeCompare(String(a.id));
  };
  const pinned = items.filter(it => it.isPinned).sort(sortByPriority);
  const normal = items.filter(it => !it.isPinned).sort(sortByPriority);
  const ordered = [...pinned, ...normal];
  // 行成本按保守上界记账（前缀取 4 位行号、含行间换行）：逐行累加必须 ≥ 整段
  // estimateTokens(tableData)，否则「总注入 ≤ B」在边界上会被换行/多位行号的零头击穿。
  const rowPrefixTokens = estimateTokens(autoExtract ? '- [0000] \n' : '- \n', tokenMode);

  const selected = [];
  const truncated = [];
  const rowsByTable = new Map();
  const includedTables = new Set();
  let tokenUsed = 0;

  for (const item of ordered) {
    if (selected.length >= maxRows) {
      truncated.push({ ...item, reason: 'max_rows' });
      continue;
    }
    const tableId = item.tableId;
    const table = nextTableById.get(tableId) || { id: tableId, name: tableId };
    const headerLabel = String(table?.name || tableId);
    const headerText = autoExtract ? `【${headerLabel}｜${tableId}】` : `【${headerLabel}】`;
    const headerTokens = includedTables.has(tableId) ? 0 : estimateTokens(`${headerText}\n`, tokenMode);
    const rowTokens = estimateTokens(item.rowText, tokenMode) + rowPrefixTokens;
    const nextTokens = tokenUsed + headerTokens + rowTokens;
    if (nextTokens > tokenBudgetData) {
      truncated.push({ ...item, reason: 'max_tokens' });
      continue;
    }
    if (!includedTables.has(tableId)) includedTables.add(tableId);
    tokenUsed = nextTokens;
    const withTokens = { ...item, tokens: rowTokens };
    selected.push(withTokens);
    if (!rowsByTable.has(tableId)) rowsByTable.set(tableId, []);
    rowsByTable.get(tableId).push(withTokens);
  }

  const tableParts = [];
  const rowIndexMap = {};
  for (const tableId of nextTableOrder) {
    const rowsForTable = rowsByTable.get(tableId) || [];
    if (!rowsForTable.length) continue;
    const table = nextTableById.get(tableId) || { id: tableId, name: tableId };
    const tableLabel = String(table?.name || tableId);
    tableParts.push(autoExtract ? `【${tableLabel}｜${tableId}】` : `【${tableLabel}】`);
    const orderedRows = rowsForTable.slice();
    if (SUMMARY_TABLE_IDS.has(tableId)) {
      orderedRows.sort((a, b) => {
        const ak = resolveSummaryTablePromptOrderKey(a, Number(a?.updatedAt) || 0);
        const bk = resolveSummaryTablePromptOrderKey(b, Number(b?.updatedAt) || 0);
        if (ak !== bk) return ak - bk;
        const au = Number(a?.updatedAt) || 0;
        const bu = Number(b?.updatedAt) || 0;
        if (au !== bu) return au - bu;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
      });
    }
    orderedRows.forEach((row, index) => {
      const line = String(row?.rowText || '').trim();
      const prefix = autoExtract ? `- [${index}] ` : '- ';
      tableParts.push(`${prefix}${line || emptyPromptValue()}`);
      if (autoExtract) {
        if (!rowIndexMap[tableId]) rowIndexMap[tableId] = [];
        rowIndexMap[tableId][index] = row.id;
      }
    });
  }
  const tableData = tableParts.join('\n').trim();

  return {
    items: selected,
    truncated,
    tableData,
    rowIndexMap,
    tableOrder: nextTableOrder,
    tableById: nextTableById,
  };
};
