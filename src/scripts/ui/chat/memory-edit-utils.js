export const extractSummaryBlock = (text) => {
  const raw = String(text ?? '');
  // 中文提示词用「摘要」，英文提示词用「Summary」
  const re = /<details>\s*<summary>\s*(?:摘要|Summary)\s*<\/summary>\s*([\s\S]*?)<\/details>/gi;
  let match;
  let last = null;
  while ((match = re.exec(raw))) last = { index: match.index, full: match[0], inner: match[1] };
  if (!last) return { text: raw, summary: '' };

  const inner = String(last.inner || '');
  const plain = inner.replace(/<[^>]+>/g, ' ');
  const summary = plain
    .trim()
    .replace(/\s+/g, ' ');
  const stripped = (raw.slice(0, last.index) + raw.slice(last.index + last.full.length))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, summary };
};

export const formatMemoryEditValue = (value, maxLen = 120) => {
  if (value === null || value === undefined) return '';
  let text = '';
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > maxLen) return `${text.slice(0, maxLen)}…`;
  return text;
};

export const resolveActionTableLabel = (action, tableById, planOrder) => {
  const explicit = String(action?.tableId || action?.tableName || '').trim();
  let tableId = explicit;
  if (!tableId) {
    const index = Number.isFinite(Number(action?.tableIndex)) ? Math.trunc(Number(action.tableIndex)) : null;
    if (index !== null && index >= 0 && index < planOrder.length) {
      tableId = String(planOrder[index] || '').trim();
    }
  }
  const tableName = tableId && tableById?.has(tableId) ? String(tableById.get(tableId)?.name || '').trim() : '';
  if (tableName && tableId) return `${tableName} (${tableId})`;
  if (tableId) return tableId;
  const idx = Number.isFinite(Number(action?.tableIndex)) ? Math.trunc(Number(action.tableIndex)) : null;
  if (idx !== null) return `table#${idx}`;
  return 'table';
};

export const buildMemoryActionLine = (action, index, tableById, planOrder) => {
  const label = resolveActionTableLabel(action, tableById, planOrder);
  const actionType = String(action?.action || '').toLowerCase();
  const rowIndex = Number.isFinite(Number(action?.rowIndex)) ? Math.trunc(Number(action.rowIndex)) : null;
  const rowId = String(action?.rowId || '').trim();
  const data = action?.data && typeof action.data === 'object' ? action.data : null;
  let detail = '';
  if (actionType === 'delete') {
    detail = rowIndex !== null ? `row_index=${rowIndex}` : rowId ? `row_id=${rowId}` : '';
  } else if (actionType === 'insert') {
    detail = data ? formatMemoryEditValue(data) : '';
  } else if (actionType === 'update') {
    const target = rowIndex !== null ? `row_index=${rowIndex}` : rowId ? `row_id=${rowId}` : '';
    const payload = data ? formatMemoryEditValue(data) : '';
    detail = [target, payload].filter(Boolean).join(' ');
  }
  return `${index}. ${actionType || 'edit'} -> ${label}${detail ? `: ${detail}` : ''}`;
};

export const buildMemoryConfirmText = (actions, tableById, planOrder, { title, maxLines } = {}) => {
  const lines = [];
  lines.push(title || '检测到记忆表格写入指令：');
  const limit = Number.isFinite(Number(maxLines)) ? Math.max(1, Math.trunc(Number(maxLines))) : 12;
  actions.slice(0, limit).forEach((action, idx) => {
    lines.push(buildMemoryActionLine(action, idx + 1, tableById, planOrder));
  });
  if (actions.length > limit) {
    lines.push(`... 还有 ${actions.length - limit} 条`);
  }
  lines.push('继续执行这些写表指令吗？');
  return lines.join('\n');
};

export const normalizeMemoryCellValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const normalizeTableRowData = (data, columns) => {
  if (!data || typeof data !== 'object') return {};
  const colIdMap = new Map();
  const colNameMap = new Map();
  const colIndexMap = new Map();
  (columns || []).forEach((col, idx) => {
    const id = String(col?.id || '').trim();
    if (id) colIdMap.set(id.toLowerCase(), id);
    const name = String(col?.name || '').trim();
    if (name) colNameMap.set(name.toLowerCase(), id);
    colIndexMap.set(String(idx), id);
  });
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(data)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    let colId = colIdMap.get(lower) || colNameMap.get(lower);
    if (!colId && /^\d+$/.test(key)) {
      colId = colIndexMap.get(key);
    }
    if (!colId) continue;
    out[colId] = normalizeMemoryCellValue(rawValue);
  }
  return out;
};

export const clonePlainObject = (value) => {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value && typeof value === 'object' ? { ...value } : value;
  }
};

export const cloneMemoryUpdateEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const cloned = clonePlainObject(entry) || {};
  const clip = (value, max = 20000) => {
    const text = typeof value === 'string' ? value : '';
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
  };
  return {
    at: cloned.at || 0,
    mode: cloned.mode,
    sessionId: cloned.sessionId,
    tableEditRaw: clip(cloned.tableEditRaw),
    raw: clip(cloned.raw),
    requestPrompt: clip(cloned.requestPrompt),
    actions: Array.isArray(cloned.actions) ? clonePlainObject(cloned.actions) : [],
    rollback: cloned.rollback ? clonePlainObject(cloned.rollback) : null,
    rollbackAt: cloned.rollbackAt || 0,
  };
};

export const rowDataEquals = (a, b) => {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const lv = normalizeMemoryCellValue(left[key]);
    const rv = normalizeMemoryCellValue(right[key]);
    if (String(lv ?? '') !== String(rv ?? '')) return false;
  }
  return true;
};
