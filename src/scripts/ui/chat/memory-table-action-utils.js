import {
  buildMemoryTimelineLabel,
  computeNextMemoryRowSortOrder,
  extractMemoryTimelineRound,
  isTimelineMemoryTableId,
} from '../../memory/memory-row-order.js';
import { isSummaryTableId, normalizeMemoryUpdateMode } from '../../memory/memory-prompt-utils.js';
import {
  buildLegacyOutlineMigrationPlan,
  findOutlineSectionRow,
  isOutlineTableId,
  normalizeOutlinePatchData,
} from '../../memory/outline-section-utils.js';
import {
  normalizeMemoryCoverageInterval,
  stampMemoryCoverage,
} from '../../memory/memory-coverage-utils.js';
import {
  normalizeMemoryCellValue,
  normalizeTableRowData,
  rowDataEquals,
} from './memory-edit-utils.js';

export const resolveMemoryActionTableId = ({
  action = null,
  tableById = null,
  tableNameMap = null,
  tableOrder = [],
} = {}) => {
  const rawId = String(action?.tableId || '').trim();
  if (rawId && tableById?.has(rawId)) return rawId;

  const rawName = String(action?.tableName || '')
    .trim()
    .toLowerCase();
  if (rawName && tableNameMap?.has(rawName)) return tableNameMap.get(rawName);

  const idxRaw = action?.tableIndex;
  const idx = Number.isFinite(Number(idxRaw)) ? Math.trunc(Number(idxRaw)) : null;
  if (idx !== null && idx >= 0 && idx < tableOrder.length) {
    const id = String(tableOrder[idx] || '').trim();
    if (id && tableById?.has(id)) return id;
  }

  return '';
};

export const resolveMemoryActionRowId = ({
  action = null,
  tableId = '',
  rowIndexMap = null,
} = {}) => {
  const rowId = String(action?.rowId || '').trim();
  if (rowId) return rowId;

  const rowIndexRaw = action?.rowIndex;
  const rowIndex = Number.isFinite(Number(rowIndexRaw)) ? Math.trunc(Number(rowIndexRaw)) : null;
  if (rowIndex === null || rowIndex < 0) return '';

  const map = rowIndexMap?.[tableId];
  if (Array.isArray(map) && rowIndex < map.length) return String(map[rowIndex] || '').trim();
  return '';
};

export const resolveMemoryActionRowIdByData = ({
  tableId = '',
  scopeKey = '',
  data = null,
  table = null,
  rowsByTableScope = null,
} = {}) => {
  if (!data || typeof data !== 'object') return '';
  const rows = rowsByTableScope?.get?.(`${tableId}:${scopeKey}`) || [];
  if (!rows.length) return '';

  const normalize = value => String(normalizeMemoryCellValue(value ?? '')).trim();
  const candidates = [];
  const preferredKeys = ['name', 'time', 'title', 'id'];
  preferredKeys.forEach((key) => {
    const value = normalize(data[key]);
    if (value) candidates.push({ key, value });
  });
  if (!candidates.length) {
    const firstColId = String(table?.columns?.[0]?.id || '').trim();
    const value = normalize(firstColId ? data[firstColId] : '');
    if (firstColId && value) candidates.push({ key: firstColId, value });
  }

  for (const candidate of candidates) {
    const matches = rows.filter(
      row => normalize(row?.row_data?.[candidate.key]) === candidate.value,
    );
    if (matches.length === 1) return String(matches[0]?.id || '').trim();
    if (matches.length > 1) return '';
  }

  if (rows.length === 1) return String(rows[0]?.id || '').trim();
  return '';
};

export const resolveMemoryTableScope = ({
  table = null,
  useSharedGlobalScope = false,
  sessionId = '',
  isGroup = false,
} = {}) => {
  if (useSharedGlobalScope) return { key: 'global', contactId: null, groupId: null };

  const scope = String(table?.scope || '')
    .trim()
    .toLowerCase();
  if (scope === 'global') return { key: 'global', contactId: null, groupId: null };
  if (scope === 'group') return { key: 'group', contactId: null, groupId: sessionId };
  if (scope === 'contact') return { key: 'contact', contactId: sessionId, groupId: null };
  return isGroup
    ? { key: 'group', contactId: null, groupId: sessionId }
    : { key: 'contact', contactId: sessionId, groupId: null };
};

export const resolveMemoryActionTableContext = ({
  action = null,
  resolveTableId = () => '',
  tableById = null,
  resolveScopeForTable = () => ({ key: '' }),
  allowSummaryTables = true,
  allowStandardTables = true,
  isGroup = false,
} = {}) => {
  const tableId = resolveTableId(action);
  if (!tableId) return null;
  const table = tableById?.get?.(tableId);
  if (!table) return null;
  const tableScope = String(table?.scope || '').trim().toLowerCase();
  if (tableScope === 'group' && !isGroup) return null;
  if (tableScope === 'contact' && isGroup) return null;
  const isSummaryTable = isSummaryTableId(tableId);
  const isOutlineTable = isOutlineTableId(tableId);
  if ((isSummaryTable && !allowSummaryTables) || (!isSummaryTable && !allowStandardTables)) {
    return null;
  }
  const { key: scopeKey, contactId, groupId } = resolveScopeForTable(table) || {};
  if (!scopeKey) return null;
  return {
    tableId,
    table,
    scopeKey,
    contactId: contactId ?? null,
    groupId: groupId ?? null,
    isSummaryTable,
    ...(isOutlineTable ? { isOutlineTable: true } : {}),
  };
};

export const createMemoryActionResolvers = ({
  tableById = null,
  tableNameMap = null,
  tableOrder = [],
  rowIndexMap = null,
  rowsByTableScope = null,
  useSharedGlobalScope = false,
  sessionId = '',
  isGroup = false,
} = {}) => {
  const resolveTableId = action => resolveMemoryActionTableId({
    action,
    tableById,
    tableNameMap,
    tableOrder,
  });
  const resolveRowId = (action, tableId) => resolveMemoryActionRowId({
    action,
    tableId,
    rowIndexMap,
  });
  const resolveRowIdByData = (tableId, scopeKey, data, table) => resolveMemoryActionRowIdByData({
    tableId,
    scopeKey,
    data,
    table,
    rowsByTableScope,
  });
  const resolveScopeForTable = table => resolveMemoryTableScope({
    table,
    useSharedGlobalScope,
    sessionId,
    isGroup,
  });
  const resolveActionContext = ({
    action = null,
    allowSummaryTables = true,
    allowStandardTables = true,
  } = {}) => resolveMemoryActionTableContext({
    action,
    resolveTableId,
    tableById,
    resolveScopeForTable,
    allowSummaryTables,
    allowStandardTables,
    isGroup,
  });
  return {
    resolveActionContext,
    resolveRowId,
    resolveRowIdByData,
    resolveScopeForTable,
    resolveTableId,
  };
};

export const getMemoryRowScopeKey = (row = null) => {
  if (row?.contact_id) return 'contact';
  if (row?.group_id) return 'group';
  return 'global';
};

export const buildMemoryRowBucketKey = (tableId = '', scopeKey = '') =>
  `${String(tableId || '').trim()}:${String(scopeKey || '').trim()}`;

export const buildMemoryRowsIndex = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  const rowsById = new Map();
  const rowsByTableScope = new Map();
  for (const row of list) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    rowsById.set(id, row);
    const tableId = String(row?.table_id || '').trim();
    if (!tableId) continue;
    const scopeKey = getMemoryRowScopeKey(row);
    const bucketKey = buildMemoryRowBucketKey(tableId, scopeKey);
    if (!rowsByTableScope.has(bucketKey)) rowsByTableScope.set(bucketKey, []);
    rowsByTableScope.get(bucketKey).push(row);
  }
  return { rowsById, rowsByTableScope };
};

export const queueMemoryInsert = ({
  createInputs = [],
  rowsByTableScope = null,
  templateId = '',
  tableId = '',
  table = null,
  scopeKey = '',
  contactId = null,
  groupId = null,
  data = null,
  currentTurnNumber = 0,
  coverage = null,
  allowDuplicate = false,
} = {}) => {
  const countKey = buildMemoryRowBucketKey(tableId, scopeKey);
  const maxRows = Number.isFinite(Number(table?.maxRows))
    ? Math.max(0, Math.trunc(Number(table.maxRows)))
    : 0;
  const existingRows = rowsByTableScope?.get?.(countKey) || [];
  const nextData = normalizeTimelineMemoryActionData({
    tableId,
    rowData: data,
    currentTurnNumber,
    coverage,
  });
  if (maxRows && existingRows.length >= maxRows) {
    return { queued: false, skipped: true, reason: 'maxRows' };
  }
  if (!allowDuplicate) {
    const duplicate = existingRows.some(row => rowDataEquals(row?.row_data || {}, nextData));
    if (duplicate) {
      return { queued: false, skipped: true, reason: 'duplicate' };
    }
  }
  const sortOrder = resolveMemoryInsertSortOrder({
    tableId,
    existingRows,
    rowData: nextData,
  });
  if (Array.isArray(createInputs)) {
    createInputs.push({
      template_id: templateId,
      table_id: tableId,
      contact_id: contactId,
      group_id: groupId,
      row_data: nextData,
      is_active: true,
      ...(Number.isFinite(Number(sortOrder)) && Number(sortOrder) > 0
        ? { sort_order: Number(sortOrder) }
        : {}),
    });
  }
  existingRows.push({
    row_data: nextData,
    sort_order: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
  });
  rowsByTableScope?.set?.(countKey, existingRows);
  return { queued: true, skipped: false, sortOrder, rowData: nextData };
};

export const resolveMemoryActionTargetRow = ({
  action = null,
  actionContext = null,
  data = null,
  resolveRowId = () => '',
  resolveRowIdByData = () => '',
  rowsById = null,
  rowsByTableScope = null,
} = {}) => {
  const tableId = String(actionContext?.tableId || '').trim();
  const scopeKey = String(actionContext?.scopeKey || '').trim();
  const table = actionContext?.table || null;
  if (!tableId || !scopeKey) return { rowId: '', row: null, reason: 'missingContext', hasRowsInBucket: false };

  let rowId = resolveRowId(action, tableId);
  if (!rowId && data && typeof data === 'object') {
    rowId = resolveRowIdByData(tableId, scopeKey, data, table);
  }
  if (!rowId) {
    const countKey = buildMemoryRowBucketKey(tableId, scopeKey);
    const existingRows = rowsByTableScope?.get?.(countKey) || [];
    return {
      rowId: '',
      row: null,
      reason: 'missingRowId',
      hasRowsInBucket: existingRows.length > 0,
      countKey,
    };
  }

  const row = rowsById?.get?.(rowId) || null;
  if (!row) return { rowId, row: null, reason: 'missingRow', hasRowsInBucket: false };
  if (String(row?.table_id || '').trim() !== tableId) {
    return { rowId, row, reason: 'tableMismatch', hasRowsInBucket: true };
  }
  if (row?.is_pinned) {
    return { rowId, row, reason: 'pinned', hasRowsInBucket: true };
  }
  return { rowId, row, reason: 'ok', hasRowsInBucket: true };
};

export const buildMemoryRowMergeResult = ({
  row = null,
  data = null,
} = {}) => {
  const nextData = data && typeof data === 'object' ? data : {};
  const merged = { ...(row?.row_data || {}), ...nextData };
  if (rowDataEquals(row?.row_data || {}, merged)) {
    return { changed: false, merged };
  }
  return { changed: true, merged };
};

export const removeMemoryRowFromIndexes = ({
  rowsById = null,
  rowsByTableScope = null,
  rowId = '',
  row = null,
} = {}) => {
  const id = String(rowId || row?.id || '').trim();
  if (!id) return false;
  rowsById?.delete?.(id);
  const tableId = String(row?.table_id || '').trim();
  if (!tableId) return true;
  const rowScopeKey = getMemoryRowScopeKey(row);
  const key = buildMemoryRowBucketKey(tableId, rowScopeKey);
  const list = rowsByTableScope?.get?.(key) || [];
  rowsByTableScope?.set?.(
    key,
    list.filter(item => String(item?.id || '') !== id),
  );
  return true;
};

export const updateMemoryRowInIndexes = ({
  rowsById = null,
  rowsByTableScope = null,
  rowId = '',
  row = null,
  rowData = null,
  sortOrder = undefined,
} = {}) => {
  const id = String(rowId || row?.id || '').trim();
  if (!id) return null;
  const currentRow = row || rowsById?.get?.(id) || null;
  if (!currentRow) return null;
  const nextRow = {
    ...currentRow,
    row_data: rowData && typeof rowData === 'object'
      ? rowData
      : (currentRow?.row_data || {}),
  };
  if (sortOrder !== undefined && sortOrder !== null && Number.isFinite(Number(sortOrder))) {
    nextRow.sort_order = Number(sortOrder);
  }
  rowsById?.set?.(id, nextRow);
  const tableId = String(nextRow?.table_id || '').trim();
  if (!tableId) return nextRow;
  const rowScopeKey = getMemoryRowScopeKey(nextRow);
  const key = buildMemoryRowBucketKey(tableId, rowScopeKey);
  const list = rowsByTableScope?.get?.(key) || [];
  rowsByTableScope?.set?.(
    key,
    list.map(item => (String(item?.id || '') === id ? nextRow : item)),
  );
  return nextRow;
};

export const resolveMemoryActionMutationPlan = ({
  action = null,
  actionContext = null,
  data = null,
  rowsByTableScope = null,
  resolveRowId = () => '',
  resolveRowIdByData = () => '',
  rowsById = null,
} = {}) => {
  const actionType = String(action?.action || '').toLowerCase();
  const tableId = String(actionContext?.tableId || '').trim();
  const scopeKey = String(actionContext?.scopeKey || '').trim();
  const table = actionContext?.table || null;
  const contactId = actionContext?.contactId ?? null;
  const groupId = actionContext?.groupId ?? null;
  const isSummaryTable = Boolean(actionContext?.isSummaryTable);
  const isOutlineTable = Boolean(actionContext?.isOutlineTable);

  if (!tableId || !scopeKey || !table) return { kind: 'skip', reason: 'missingContext' };
  if ((actionType === 'insert' || actionType === 'init' || actionType === 'update') && !Object.keys(data || {}).length) {
    return { kind: 'skip', reason: 'emptyData' };
  }

  if (isOutlineTable && (actionType === 'insert' || actionType === 'init' || actionType === 'update')) {
    const bucketKey = buildMemoryRowBucketKey(tableId, scopeKey);
    const rows = rowsByTableScope?.get?.(bucketKey) || [];
    const sectionRow = findOutlineSectionRow(rows, data?.section);
    if (sectionRow?.id) {
      const { changed, merged } = buildMemoryRowMergeResult({
        row: sectionRow,
        data,
      });
      if (!changed) return { kind: 'skip', reason: 'unchanged' };
      return {
        kind: 'updateRow',
        rowId: String(sectionRow.id),
        row: sectionRow,
        tableId,
        merged,
      };
    }
    if (sectionRow) {
      // 同批已排队的同节写入（尚无 id）：必须并入排队行而不是再排一条——
      // 否则本批会落库两行同节，此后 upsert 永远只更新先找到的那条，另一条成死行。
      const { changed, merged } = buildMemoryRowMergeResult({
        row: sectionRow,
        data,
      });
      if (!changed) return { kind: 'skip', reason: 'unchanged' };
      return {
        kind: 'mergeQueuedInsert',
        tableId,
        queuedRow: sectionRow,
        queuedBefore: { ...(sectionRow.row_data || {}) },
        merged,
      };
    }
    return {
      kind: 'queueInsert',
      tableId,
      table,
      scopeKey,
      contactId,
      groupId,
      data,
      allowDuplicate: false,
    };
  }

  if (isOutlineTable && actionType === 'delete') {
    return { kind: 'skip', reason: 'outlineDeleteForbidden' };
  }

  if (actionType === 'insert' || actionType === 'init') {
    if (actionType === 'init') {
      const countKey = buildMemoryRowBucketKey(tableId, scopeKey);
      const existingRows = rowsByTableScope?.get?.(countKey) || [];
      if (existingRows.length) return { kind: 'skip', reason: 'initExistingRows' };
    }
    return {
      kind: 'queueInsert',
      tableId,
      table,
      scopeKey,
      contactId,
      groupId,
      data,
      allowDuplicate: isSummaryTable && actionType === 'insert',
    };
  }

  if (actionType === 'update') {
    if (isSummaryTable) {
      return {
        kind: 'queueInsert',
        tableId,
        table,
        scopeKey,
        contactId,
        groupId,
        data,
        allowDuplicate: true,
      };
    }
    const target = resolveMemoryActionTargetRow({
      action,
      actionContext,
      data,
      resolveRowId,
      resolveRowIdByData,
      rowsById,
      rowsByTableScope,
    });
    if (!target.rowId) {
      if (!target.hasRowsInBucket) {
        return {
          kind: 'queueInsert',
          tableId,
          table,
          scopeKey,
          contactId,
          groupId,
          data,
          allowDuplicate: false,
        };
      }
      return { kind: 'skip', reason: target.reason || 'missingRowId' };
    }
    if (target.reason !== 'ok' || !target.row) return { kind: 'skip', reason: target.reason || 'invalidTarget' };
    const { changed, merged } = buildMemoryRowMergeResult({
      row: target.row,
      data,
    });
    if (!changed) return { kind: 'skip', reason: 'unchanged' };
    return {
      kind: 'updateRow',
      rowId: target.rowId,
      row: target.row,
      tableId,
      merged,
    };
  }

  if (actionType === 'delete') {
    const target = resolveMemoryActionTargetRow({
      action,
      actionContext,
      resolveRowId,
      resolveRowIdByData,
      rowsById,
      rowsByTableScope,
    });
    if (target.reason !== 'ok' || !target.row) return { kind: 'skip', reason: target.reason || 'invalidTarget' };
    return {
      kind: 'deleteRow',
      rowId: target.rowId,
      row: target.row,
    };
  }

  return { kind: 'skip', reason: 'unsupportedAction' };
};

export const executeMemoryActionMutationPlan = async ({
  plan = null,
  memoryTableStore = null,
  createInputs = [],
  rowsById = null,
  rowsByTableScope = null,
  templateId = '',
  currentTurnNumber = 0,
  coverage = null,
} = {}) => {
  if (!plan || typeof plan !== 'object') {
    return { inserted: 0, updated: 0, deleted: 0, skipped: 1 };
  }

  if (plan.kind === 'queueInsert') {
    const result = queueMemoryInsert({
      createInputs,
      rowsByTableScope,
      templateId,
      tableId: plan.tableId,
      table: plan.table,
      scopeKey: plan.scopeKey,
      contactId: plan.contactId,
      groupId: plan.groupId,
      data: plan.data,
      currentTurnNumber,
      coverage,
      allowDuplicate: plan.allowDuplicate,
    });
    return {
      inserted: 0,
      updated: 0,
      deleted: 0,
      skipped: result.skipped ? 1 : 0,
    };
  }

  if (plan.kind === 'mergeQueuedInsert') {
    // 排队行的 row_data 与 createInputs 里的待建条目共享同一引用：原地合并即两处同步生效
    const rowData = normalizeTimelineMemoryActionData({
      tableId: plan.tableId,
      rowData: plan.merged,
      currentTurnNumber,
      coverage,
    });
    const target = plan.queuedRow?.row_data;
    if (target && typeof target === 'object') {
      Object.keys(target).forEach((key) => { delete target[key]; });
      Object.assign(target, rowData);
    }
    return { inserted: 0, updated: 1, deleted: 0, skipped: 0 };
  }

  if (plan.kind === 'updateRow') {
    if (!memoryTableStore?.updateMemory) {
      return { inserted: 0, updated: 0, deleted: 0, skipped: 1 };
    }
    const rowData = normalizeTimelineMemoryActionData({
      tableId: plan.tableId,
      rowData: plan.merged,
      currentTurnNumber,
      coverage,
    });
    const sortOrder = isTimelineMemoryTableId(plan.tableId)
      ? extractMemoryTimelineRound(rowData?.time)
      : null;
    const payload = { id: plan.rowId, row_data: rowData };
    if (sortOrder !== null) payload.sort_order = sortOrder;
    await memoryTableStore.updateMemory(payload);
    updateMemoryRowInIndexes({
      rowsById,
      rowsByTableScope,
      rowId: plan.rowId,
      row: plan.row,
      rowData,
      sortOrder,
    });
    return { inserted: 0, updated: 1, deleted: 0, skipped: 0 };
  }

  if (plan.kind === 'deleteRow') {
    if (!memoryTableStore?.deleteMemory) {
      return { inserted: 0, updated: 0, deleted: 0, skipped: 1 };
    }
    await memoryTableStore.deleteMemory(plan.rowId);
    removeMemoryRowFromIndexes({
      rowsById,
      rowsByTableScope,
      rowId: plan.rowId,
      row: plan.row,
    });
    return { inserted: 0, updated: 0, deleted: 1, skipped: 0 };
  }

  return { inserted: 0, updated: 0, deleted: 0, skipped: 1 };
};

export const resolveMemoryActionBatchPermissions = (updateMode = 'full') => {
  const normalizedUpdateMode = normalizeMemoryUpdateMode(updateMode, 'full');
  return {
    updateMode: normalizedUpdateMode,
    allowSummaryTables: normalizedUpdateMode === 'summary' || normalizedUpdateMode === 'full',
    allowStandardTables: normalizedUpdateMode === 'standard' || normalizedUpdateMode === 'full',
  };
};

export const executeMemoryActionBatchMutation = async ({
  signal = null,
  actions = [],
  actionContext = null,
  updateMode = 'full',
  memoryTableStore = null,
  createMemories = async () => 0,
  currentTurnNumber = 0,
  coverage = null,
  isGroup = false,
} = {}) => {
  const list = Array.isArray(actions) ? actions : [];
  const createInputs = [];
  const totals = { inserted: 0, updated: 0, deleted: 0, skipped: 0 };
  const permissions = resolveMemoryActionBatchPermissions(updateMode);
  const templateId = String(actionContext?.templateId || '').trim();
  const {
    tableById,
    rowsById,
    rowsByTableScope,
    resolveActionContext,
    resolveRowId,
    resolveRowIdByData,
    resolveScopeForTable,
    resolveTableId,
  } = actionContext || {};

  if (!templateId || typeof resolveActionContext !== 'function') {
    return {
      ...totals,
      skipped: list.length,
      changed: 0,
      templateId,
      createInputs,
      rollbackSnapshot: null,
      ...permissions,
    };
  }

  const rollbackSnapshot = buildMemoryRollbackSnapshot({
    actions: list,
    templateId,
    resolveTableId,
    tableById,
    resolveScopeForTable,
    rowsByTableScope,
    allowSummaryTables: permissions.allowSummaryTables,
    allowStandardTables: permissions.allowStandardTables,
    isGroup,
  });

  const migratedOutlineBuckets = new Set();
  for (const action of list) {
    const actionType = String(action?.action || '').trim().toLowerCase();
    if (!['insert', 'init', 'update'].includes(actionType)) continue;
    const context = resolveActionContext({
      action,
      allowSummaryTables: permissions.allowSummaryTables,
      allowStandardTables: permissions.allowStandardTables,
    });
    if (!context?.isOutlineTable) continue;
    const bucketKey = buildMemoryRowBucketKey(context.tableId, context.scopeKey);
    if (migratedOutlineBuckets.has(bucketKey)) continue;
    migratedOutlineBuckets.add(bucketKey);
    const bucketRows = rowsByTableScope?.get?.(bucketKey) || [];
    const migration = buildLegacyOutlineMigrationPlan({ rows: bucketRows });
    if (!migration.needed) continue;
    for (const row of migration.legacyRows) {
      const rowId = String(row?.id || '').trim();
      if (!rowId || !memoryTableStore?.updateMemory) continue;
      const archivedRowData = row?.row_data && typeof row.row_data === 'object'
        ? { ...row.row_data, _archived_by: 'outline_migration' }
        : null;
      signal?.throwIfAborted();
      await memoryTableStore.updateMemory({
        id: rowId,
        is_active: false,
        ...(archivedRowData ? { row_data: archivedRowData } : {}),
      });
      const nextRow = archivedRowData
        ? { ...row, is_active: false, row_data: archivedRowData }
        : { ...row, is_active: false };
      rowsById?.set?.(rowId, nextRow);
      const currentRows = rowsByTableScope?.get?.(bucketKey) || [];
      rowsByTableScope?.set?.(
        bucketKey,
        currentRows.map(item => (String(item?.id || '') === rowId ? nextRow : item)),
      );
      totals.updated += 1;
    }
    createInputs.push({
      template_id: templateId,
      table_id: context.tableId,
      contact_id: context.contactId,
      group_id: context.groupId,
      row_data: migration.archiveData,
      is_active: true,
      sort_order: Date.now(),
    });
    const currentRows = rowsByTableScope?.get?.(bucketKey) || [];
    currentRows.push({
      table_id: context.tableId,
      contact_id: context.contactId,
      group_id: context.groupId,
      row_data: migration.archiveData,
      is_active: true,
      sort_order: Date.now(),
    });
    rowsByTableScope?.set?.(bucketKey, currentRows);
  }

  for (const action of list) {
    const context = resolveActionContext({
      action,
      allowSummaryTables: permissions.allowSummaryTables,
      allowStandardTables: permissions.allowStandardTables,
    });
    if (!context) {
      totals.skipped += 1;
      continue;
    }
    let data = normalizeTableRowData(action?.data, context.table?.columns || []);
    if (context.isOutlineTable) {
      const outlineField = context.table?.columns?.some?.(column => String(column?.id || '') === 'outline')
        ? 'outline'
        : String(context.table?.columns?.find?.(column => String(column?.id || '') !== 'section')?.id || 'outline');
      data = {
        ...data,
        ...normalizeOutlinePatchData(action?.data, { outlineField }),
      };
    }
    const plan = resolveMemoryActionMutationPlan({
      action,
      actionContext: context,
      data,
      rowsByTableScope,
      resolveRowId,
      resolveRowIdByData,
      rowsById,
    });
    signal?.throwIfAborted();
    const result = await executeMemoryActionMutationPlan({
      plan,
      memoryTableStore,
      createInputs,
      rowsById,
      rowsByTableScope,
      templateId,
      currentTurnNumber,
      coverage,
    });
    totals.updated += Number(result?.updated || 0);
    totals.deleted += Number(result?.deleted || 0);
    totals.skipped += Number(result?.skipped || 0);
  }

  if (createInputs.length && typeof createMemories === 'function') {
    signal?.throwIfAborted();
    const created = await createMemories(createInputs);
    totals.inserted = Number.isFinite(Number(created)) ? Number(created) : 0;
  }

  return {
    ...totals,
    changed: totals.inserted + totals.updated + totals.deleted,
    templateId,
    createInputs,
    rollbackSnapshot,
    ...permissions,
  };
};

const cloneRowsIndexForPreview = ({
  rowsById = null,
  rowsByTableScope = null,
} = {}) => ({
  rowsById: new Map(rowsById instanceof Map ? rowsById : []),
  rowsByTableScope: new Map(
    Array.from(rowsByTableScope instanceof Map ? rowsByTableScope.entries() : [])
      .map(([key, rows]) => [key, Array.isArray(rows) ? rows.slice() : []]),
  ),
});

const normalizeMemoryPreviewActionType = action => String(action?.action || '').trim().toLowerCase() || 'unknown';

const buildMemoryMutationPreviewEntry = ({
  index = 0,
  action = null,
  context = null,
  plan = null,
  previewResult = null,
  rowData = null,
} = {}) => {
  const actionType = normalizeMemoryPreviewActionType(action);
  const tableId = String(context?.tableId || plan?.tableId || '').trim();
  const scope = String(context?.scopeKey || plan?.scopeKey || '').trim();
  const base = {
    index,
    action: actionType,
    tableId,
    scope,
    rowId: String(plan?.rowId || action?.rowId || '').trim(),
  };
  if (!plan || plan.kind === 'skip') {
    return {
      ...base,
      kind: 'skip',
      skipped: true,
      reason: String(plan?.reason || 'invalidAction').trim(),
    };
  }
  if (plan.kind === 'queueInsert') {
    return {
      ...base,
      kind: previewResult?.skipped ? 'skip' : 'insert',
      skipped: previewResult?.skipped === true,
      reason: previewResult?.skipped ? String(previewResult.reason || 'skipped').trim() : '',
      diff: previewResult?.skipped
        ? null
        : {
          before: null,
          after: previewResult?.rowData || rowData || plan.data || {},
        },
    };
  }
  if (plan.kind === 'mergeQueuedInsert') {
    return {
      ...base,
      kind: 'update',
      skipped: false,
      diff: {
        before: plan.queuedBefore || {},
        after: rowData || plan.merged || {},
      },
    };
  }
  if (plan.kind === 'updateRow') {
    return {
      ...base,
      kind: 'update',
      skipped: false,
      diff: {
        before: plan.row?.row_data || {},
        after: rowData || plan.merged || {},
      },
    };
  }
  if (plan.kind === 'deleteRow') {
    return {
      ...base,
      kind: 'delete',
      skipped: false,
      diff: {
        before: plan.row?.row_data || {},
        after: null,
      },
    };
  }
  return {
    ...base,
    kind: 'skip',
    skipped: true,
    reason: 'unsupportedPlan',
  };
};

export const buildMemoryActionBatchPreview = ({
  actions = [],
  actionContext = null,
  updateMode = 'full',
  currentTurnNumber = 0,
  coverage = null,
  isGroup = false,
} = {}) => {
  const list = Array.isArray(actions) ? actions : [];
  const permissions = resolveMemoryActionBatchPermissions(updateMode);
  const totals = { inserted: 0, updated: 0, deleted: 0, skipped: 0 };
  const templateId = String(actionContext?.templateId || '').trim();
  const {
    tableById,
    rowsById,
    rowsByTableScope,
    resolveActionContext,
    resolveRowId,
    resolveRowIdByData,
    resolveScopeForTable,
    resolveTableId,
  } = actionContext || {};

  if (!templateId || typeof resolveActionContext !== 'function') {
    return {
      ...totals,
      skipped: list.length,
      changed: 0,
      templateId,
      entries: list.map((action, index) => buildMemoryMutationPreviewEntry({
        index,
        action,
        plan: { kind: 'skip', reason: 'missingContext' },
      })),
      rollbackSnapshot: null,
      ...permissions,
    };
  }

  const rollbackSnapshot = buildMemoryRollbackSnapshot({
    actions: list,
    templateId,
    resolveTableId,
    tableById,
    resolveScopeForTable,
    rowsByTableScope,
    allowSummaryTables: permissions.allowSummaryTables,
    allowStandardTables: permissions.allowStandardTables,
    isGroup,
  });
  const shadow = cloneRowsIndexForPreview({ rowsById, rowsByTableScope });
  const createInputs = [];
  const entries = [];
  const migratedOutlineBuckets = new Set();

  list.forEach((action) => {
    const actionType = String(action?.action || '').trim().toLowerCase();
    if (!['insert', 'init', 'update'].includes(actionType)) return;
    const context = resolveActionContext({
      action,
      allowSummaryTables: permissions.allowSummaryTables,
      allowStandardTables: permissions.allowStandardTables,
    });
    if (!context?.isOutlineTable) return;
    const bucketKey = buildMemoryRowBucketKey(context.tableId, context.scopeKey);
    if (migratedOutlineBuckets.has(bucketKey)) return;
    migratedOutlineBuckets.add(bucketKey);
    const bucketRows = shadow.rowsByTableScope.get(bucketKey) || [];
    const migration = buildLegacyOutlineMigrationPlan({ rows: bucketRows });
    if (!migration.needed) return;
    const legacyIds = new Set(migration.legacyRows.map(row => String(row?.id || '')).filter(Boolean));
    const migratedRows = bucketRows.map((row) => {
      const rowId = String(row?.id || '');
      if (!legacyIds.has(rowId)) return row;
      const nextRow = row?.row_data && typeof row.row_data === 'object'
        ? { ...row, is_active: false, row_data: { ...row.row_data, _archived_by: 'outline_migration' } }
        : { ...row, is_active: false };
      if (rowId) shadow.rowsById.set(rowId, nextRow);
      return nextRow;
    });
    const archiveInput = {
      template_id: templateId,
      table_id: context.tableId,
      contact_id: context.contactId,
      group_id: context.groupId,
      row_data: migration.archiveData,
      is_active: true,
      sort_order: Date.now(),
    };
    createInputs.push(archiveInput);
    migratedRows.push(archiveInput);
    shadow.rowsByTableScope.set(bucketKey, migratedRows);
    totals.updated += migration.legacyRows.length;
    totals.inserted += 1;
    entries.push({
      index: -1,
      action: 'migrate',
      tableId: context.tableId,
      scope: context.scopeKey,
      rowId: '',
      kind: 'migrate_outline',
      skipped: false,
      legacyCount: migration.legacyRows.length,
      diff: {
        before: migration.legacyRows.map(row => row?.row_data || {}),
        after: migration.archiveData,
      },
    });
  });

  list.forEach((action, index) => {
    const context = resolveActionContext({
      action,
      allowSummaryTables: permissions.allowSummaryTables,
      allowStandardTables: permissions.allowStandardTables,
    });
    if (!context) {
      totals.skipped += 1;
      entries.push(buildMemoryMutationPreviewEntry({
        index,
        action,
        plan: { kind: 'skip', reason: 'invalidContext' },
      }));
      return;
    }
    let data = normalizeTableRowData(action?.data, context.table?.columns || []);
    if (context.isOutlineTable) {
      const outlineField = context.table?.columns?.some?.(column => String(column?.id || '') === 'outline')
        ? 'outline'
        : String(context.table?.columns?.find?.(column => String(column?.id || '') !== 'section')?.id || 'outline');
      data = {
        ...data,
        ...normalizeOutlinePatchData(action?.data, { outlineField }),
      };
    }
    const plan = resolveMemoryActionMutationPlan({
      action,
      actionContext: context,
      data,
      rowsByTableScope: shadow.rowsByTableScope,
      resolveRowId,
      resolveRowIdByData,
      rowsById: shadow.rowsById,
    });
    if (plan.kind === 'queueInsert') {
      const previewResult = queueMemoryInsert({
        createInputs,
        rowsByTableScope: shadow.rowsByTableScope,
        templateId,
        tableId: plan.tableId,
        table: plan.table,
        scopeKey: plan.scopeKey,
        contactId: plan.contactId,
        groupId: plan.groupId,
        data: plan.data,
        currentTurnNumber,
        coverage,
        allowDuplicate: plan.allowDuplicate,
      });
      if (previewResult.skipped) totals.skipped += 1;
      else totals.inserted += 1;
      entries.push(buildMemoryMutationPreviewEntry({
        index,
        action,
        context,
        plan,
        previewResult,
        rowData: previewResult.rowData,
      }));
      return;
    }
    if (plan.kind === 'mergeQueuedInsert') {
      const rowData = normalizeTimelineMemoryActionData({
        tableId: plan.tableId,
        rowData: plan.merged,
        currentTurnNumber,
        coverage,
      });
      const target = plan.queuedRow?.row_data;
      if (target && typeof target === 'object') {
        Object.keys(target).forEach((key) => { delete target[key]; });
        Object.assign(target, rowData);
      }
      totals.updated += 1;
      entries.push(buildMemoryMutationPreviewEntry({
        index,
        action,
        context,
        plan,
        previewResult: null,
        rowData,
      }));
      return;
    }
    if (plan.kind === 'updateRow') {
      const rowData = normalizeTimelineMemoryActionData({
        tableId: plan.tableId,
        rowData: plan.merged,
        currentTurnNumber,
        coverage,
      });
      const sortOrder = isTimelineMemoryTableId(plan.tableId)
        ? extractMemoryTimelineRound(rowData?.time)
        : null;
      updateMemoryRowInIndexes({
        rowsById: shadow.rowsById,
        rowsByTableScope: shadow.rowsByTableScope,
        rowId: plan.rowId,
        row: plan.row,
        rowData,
        sortOrder,
      });
      totals.updated += 1;
      entries.push(buildMemoryMutationPreviewEntry({
        index,
        action,
        context,
        plan,
        rowData,
      }));
      return;
    }
    if (plan.kind === 'deleteRow') {
      removeMemoryRowFromIndexes({
        rowsById: shadow.rowsById,
        rowsByTableScope: shadow.rowsByTableScope,
        rowId: plan.rowId,
        row: plan.row,
      });
      totals.deleted += 1;
      entries.push(buildMemoryMutationPreviewEntry({
        index,
        action,
        context,
        plan,
      }));
      return;
    }
    totals.skipped += 1;
    entries.push(buildMemoryMutationPreviewEntry({
      index,
      action,
      context,
      plan,
    }));
  });

  return {
    ...totals,
    changed: totals.inserted + totals.updated + totals.deleted,
    templateId,
    entries,
    createInputs,
    rollbackSnapshot,
    ...permissions,
  };
};

export const deleteNewestMatchingMemoryRow = async ({
  memoryTableStore = null,
  currentRows = [],
  tableId = '',
  data = null,
} = {}) => {
  if (!memoryTableStore?.deleteMemory) return 0;
  const normalizedTableId = String(tableId || '').trim();
  if (!normalizedTableId || !data || typeof data !== 'object' || !Object.keys(data).length) {
    return 0;
  }
  const scopedRows = (Array.isArray(currentRows) ? currentRows : []).filter(
    row => String(row?.table_id || '').trim() === normalizedTableId,
  );
  const matches = scopedRows.filter(row => rowDataEquals(row?.row_data || {}, data));
  const target = pickNewestMemoryRow(matches);
  if (!target?.id) return 0;
  try {
    await memoryTableStore.deleteMemory(String(target.id || ''));
    return 1;
  } catch {
    return 0;
  }
};

export const serializeMemoryRollbackRow = ({
  row = null,
  templateId = '',
} = {}) => ({
  id: String(row?.id || '').trim(),
  table_id: String(row?.table_id || '').trim(),
  template_id: row?.template_id || templateId,
  contact_id: row?.contact_id ?? null,
  group_id: row?.group_id ?? null,
  row_data: row?.row_data || {},
  is_active: Boolean(row?.is_active),
  is_pinned: Boolean(row?.is_pinned),
  priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 0,
  sort_order: Number.isFinite(Number(row?.sort_order)) ? Number(row.sort_order) : 0,
});

export const buildMemoryRollbackRestorePayload = ({
  row = null,
} = {}) => ({
  row_data: row?.row_data || {},
  is_active: Boolean(row?.is_active),
  is_pinned: Boolean(row?.is_pinned),
  priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 0,
  sort_order: Number.isFinite(Number(row?.sort_order)) ? Number(row.sort_order) : 0,
});

export const buildMemoryRollbackSnapshot = ({
  actions = [],
  templateId = '',
  resolveTableId = () => '',
  tableById = null,
  resolveScopeForTable = () => ({ key: '' }),
  rowsByTableScope = null,
  allowSummaryTables = true,
  allowStandardTables = true,
  isGroup = false,
} = {}) => {
  const tables = [];
  const seen = new Set();
  for (const action of Array.isArray(actions) ? actions : []) {
    const tableId = resolveTableId(action);
    if (!tableId) continue;
    const table = tableById?.get?.(tableId);
    if (!table) continue;
    const tableScope = String(table?.scope || '').trim().toLowerCase();
    if (tableScope === 'group' && !isGroup) continue;
    if (tableScope === 'contact' && isGroup) continue;
    const summaryTable = isSummaryTableId(tableId);
    if ((summaryTable && !allowSummaryTables) || (!summaryTable && !allowStandardTables)) continue;
    const { key: scopeKey } = resolveScopeForTable(table) || {};
    if (!scopeKey) continue;
    const bucketKey = buildMemoryRowBucketKey(tableId, scopeKey);
    if (seen.has(bucketKey)) continue;
    seen.add(bucketKey);
    const rows = rowsByTableScope?.get?.(bucketKey) || [];
    tables.push({
      table_id: tableId,
      scope: scopeKey,
      rows: rows
        .map(row => serializeMemoryRollbackRow({ row, templateId }))
        .filter(row => row.id),
    });
  }
  return tables.length ? { tables } : null;
};

export const buildMemoryRollbackRestorePlan = ({
  templateId = '',
  tableId = '',
  scopeFields = {},
  currentRows = [],
  snapshotRows = [],
} = {}) => {
  const scopedCurrent = Array.isArray(currentRows) ? currentRows : [];
  const scopedSnapshot = Array.isArray(snapshotRows) ? snapshotRows : [];
  const snapshotById = new Map(
    scopedSnapshot
      .map(row => [String(row?.id || '').trim(), row])
      .filter(([id]) => Boolean(id)),
  );
  const currentById = new Map(
    scopedCurrent
      .map(row => [String(row?.id || '').trim(), row])
      .filter(([id]) => Boolean(id)),
  );

  const deleteIds = [];
  for (const row of scopedCurrent) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    if (!snapshotById.has(id)) deleteIds.push(id);
  }

  const updateOps = [];
  const createOps = [];
  for (const snap of scopedSnapshot) {
    const id = String(snap?.id || '').trim();
    if (!id) continue;
    const payload = buildMemoryRollbackRestorePayload({ row: snap });
    const current = currentById.get(id);
    if (current) {
      const sameData = rowDataEquals(current?.row_data || {}, payload.row_data || {});
      const sameActive = Boolean(current?.is_active) === payload.is_active;
      const samePinned = Boolean(current?.is_pinned) === payload.is_pinned;
      const samePriority = Number.isFinite(Number(current?.priority)) ? Number(current.priority) : 0;
      const sameSortOrder = Number.isFinite(Number(current?.sort_order)) ? Number(current.sort_order) : 0;
      if (!sameData || !sameActive || !samePinned || samePriority !== payload.priority || sameSortOrder !== payload.sort_order) {
        updateOps.push({ id, ...payload });
      }
      continue;
    }
    createOps.push({
      template_id: templateId,
      table_id: tableId,
      contact_id: snap?.contact_id ?? scopeFields.contact_id,
      group_id: snap?.group_id ?? scopeFields.group_id,
      ...payload,
    });
  }

  return { deleteIds, updateOps, createOps };
};

export const executeMemoryRollbackRestorePlan = async ({
  memoryTableStore = null,
  plan = null,
} = {}) => {
  if (!memoryTableStore || !plan || typeof plan !== 'object') return 0;
  let changed = 0;

  for (const id of Array.isArray(plan.deleteIds) ? plan.deleteIds : []) {
    try {
      await memoryTableStore.deleteMemory(id);
      changed += 1;
    } catch {}
  }

  for (const op of Array.isArray(plan.updateOps) ? plan.updateOps : []) {
    try {
      await memoryTableStore.updateMemory(op);
      changed += 1;
    } catch {}
  }

  for (const input of Array.isArray(plan.createOps) ? plan.createOps : []) {
    try {
      await memoryTableStore.createMemory(input);
      changed += 1;
    } catch {}
  }

  return changed;
};

export const restoreMemoryRowsFromRollbackSnapshot = async ({
  memoryTableStore = null,
  templateId = '',
  tableId = '',
  scopeFields = {},
  currentRows = [],
  snapshotRows = [],
} = {}) => {
  const plan = buildMemoryRollbackRestorePlan({
    templateId,
    tableId,
    scopeFields,
    currentRows,
    snapshotRows,
  });
  return executeMemoryRollbackRestorePlan({
    memoryTableStore,
    plan,
  });
};

export const countAssistantTurnsForMemoryTimeline = (messages = []) => {
  const list = Array.isArray(messages) ? messages : [];
  let count = 0;
  for (const message of list) {
    if (!message || message.role !== 'assistant') continue;
    if (message.status === 'pending' || message.status === 'sending') continue;
    const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
    if (meta.isGreeting) continue;
    if (String(meta.kind || '').trim() === 'memory-table-push') continue;
    count += 1;
  }
  return count;
};

export const countUserTurnsForMemoryTimeline = (messages = []) => {
  const list = Array.isArray(messages) ? messages : [];
  let count = 0;
  for (const message of list) {
    if (!message || message.role !== 'user') continue;
    const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
    if (meta.generatedByAssistant === true) continue;
    count += 1;
  }
  return count;
};

// 覆盖盖章的锚点消息：轮次由用户消息定义（与 countUserTurnsForMemoryTimeline 同口径），
// 且盖章发生在本轮助手消息 append 之前——此刻助手消息还不存在，取尾部助手消息会锚到上一轮。
// 必须按已解析出的 currentTurnNumber 反查第 N 条用户消息，不能独立取尾部：
// 各链路的轮号解析口径不同（协议链由尾部助手消息推导），独立取尾会与盖上的区间差一轮，
// 首次修复就会把行错误平移。按轮号反查则 anchor 轮号 === 盖章轮号按构造成立。
// 查不到（轮号未知 / 消息不在当前 store）返回空串 → 不盖锚点，退回既有行为。
export const findMemoryTimelineAnchorMessageId = (messages = [], turnNumber = 0) => {
  const target = Math.trunc(Number(turnNumber));
  if (!Number.isFinite(target) || target <= 0) return '';
  let turn = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'user') continue;
    const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
    if (meta.generatedByAssistant === true) continue;
    turn += 1;
    if (turn === target) return String(message.id || '').trim();
  }
  return '';
};

// 盖章锚点解析（两条 applyMemoryEdits 链共用，防口径漂移）：
// 显式 timelineMessageId 优先——滑动重生成 / 继续 / 编辑原文指定的是具体楼层，
// 可能并非尾轮；主发送链没有显式 id，回退到 resolveTimelineMessageId 给出的本轮锚点。
export const resolveMemoryCoverageAnchorMessageId = async ({
  sessionId = '',
  timelineMessageId = '',
  currentTurnNumber = 0,
  resolveTimelineMessageId = null,
} = {}) => {
  const explicit = String(timelineMessageId || '').trim();
  if (explicit) return explicit;
  const sid = String(sessionId || '').trim();
  if (!sid || typeof resolveTimelineMessageId !== 'function') return '';
  try {
    return String((await resolveTimelineMessageId(sid, currentTurnNumber)) || '').trim();
  } catch {
    return '';
  }
};

export const normalizeTimelineMemoryActionData = ({
  tableId = '',
  rowData = null,
  currentTurnNumber = 0,
  coverage = null,
} = {}) => {
  const next = rowData && typeof rowData === 'object' ? { ...rowData } : {};
  if (!isTimelineMemoryTableId(tableId)) return next;
  const interval = normalizeMemoryCoverageInterval(coverage || {});
  const stamped = interval
    ? stampMemoryCoverage(next, {
        ...interval,
        messageId: coverage?.messageId,
        source: coverage?.source || 'app',
      })
    : next;
  if (interval) {
    stamped.time = buildMemoryTimelineLabel(interval.from, interval.to);
    return stamped;
  }
  if (currentTurnNumber > 0) {
    stamped.time = buildMemoryTimelineLabel(currentTurnNumber);
    return stamped;
  }
  const round = extractMemoryTimelineRound(stamped.time);
  if (round !== null) {
    stamped.time = buildMemoryTimelineLabel(round);
    return stamped;
  }
  return stamped;
};

export const resolveMemoryInsertSortOrder = ({
  tableId = '',
  existingRows = [],
  rowData = {},
} = {}) => {
  if (isTimelineMemoryTableId(tableId)) {
    const round = extractMemoryTimelineRound(rowData?.time);
    if (round !== null) return round;
  }
  return computeNextMemoryRowSortOrder(existingRows, tableId);
};

export const pickNewestMemoryRow = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  const scored = list.map((row, idx) => {
    const ts = Number(row?.updated_at || row?.created_at || 0);
    return { row, ts: Number.isFinite(ts) ? ts : 0, idx };
  });
  scored.sort((left, right) => right.ts - left.ts || right.idx - left.idx);
  return scored[0]?.row || null;
};
