import { t } from '../../i18n/index.js';
import { batchResult, confirmRequest, resolveNamedTarget, summarizeBatch } from './preset-regex-script-tools.js';

/* 女仆直接改记忆表格的行：读、新增或修改、删除。
   表格与行的认法用会话的记忆动作上下文（与 AI 填表同一份模板与行索引），
   算变化用现有的表格动作预览，写入用现有的表格提交处理器（记下复原快照、发出表格更新事件）。
   冻结预览 → 一次确认（逐行列出改动）→ 执行前核对目标行没被改过 → 读回核对。 */

const trim = value => String(value ?? '').trim();
const clip = (value, max = 40) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const isAllowed = (context = {}, kind = '') => context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind;
const rowTableId = row => trim(row?.table_id ?? row?.tableId);
const rowData = row => (row?.row_data && typeof row.row_data === 'object' ? row.row_data : {});

export const createMemoryTableEditAgentTools = ({
  getCurrentSessionId = () => '',
  getUiMode = () => '',
  loadMemoryContext = null,
  previewMemoryActions = null,
  commitMemory = null,
} = {}) => {
  const snapshots = new WeakMap();
  const sessionOf = (args, context) => trim(args?.sessionId || context?.sessionId || getCurrentSessionId?.());
  const tablesOf = memory => (memory?.tableOrder || []).map(id => memory.tableById?.get?.(id)).filter(Boolean)
    .map(table => ({ id: trim(table.id), name: trim(table.name) || trim(table.id), table }));
  const loadContext = async (sessionId) => {
    if (typeof loadMemoryContext !== 'function') return { error: { ok: false, reason: 'memory_table_unavailable' } };
    const memory = await loadMemoryContext(sessionId);
    if (!memory?.tableById) return { error: { ok: false, reason: 'memory_table_not_configured', sessionId } };
    return { memory };
  };
  const rowsOfTable = (memory, tableId) => (Array.isArray(memory.allRows) ? memory.allRows : []).filter(row => rowTableId(row) === tableId);
  const columnMap = table => {
    const columns = Array.isArray(table?.columns) ? table.columns : [];
    return { columns, byKey: new Map(columns.flatMap(column => [[trim(column.id), trim(column.id)], [trim(column.name), trim(column.id)]]).filter(([key]) => key)) };
  };
  const describeRow = (table, data) => {
    const { columns } = columnMap(table);
    const first = columns.find(column => trim(data?.[column.id]));
    return first ? `${first.name}：${clip(data[first.id], 30)}` : '';
  };

  /* ───────────── memory.rows.read ───────────── */

  const readRows = async (args = {}, context = {}) => {
    const sessionId = sessionOf(args, context);
    if (!sessionId) return { ok: false, reason: 'no_current_session' };
    const loaded = await loadContext(sessionId);
    if (loaded.error) return loaded.error;
    const { memory } = loaded;
    let tables = tablesOf(memory);
    if (trim(args.table)) {
      const found = resolveNamedTarget(tables, args.table);
      if (found.error) return { ok: false, reason: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) };
      tables = [found.item];
    }
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
    return {
      ok: true, sessionId,
      tables: tables.map(({ id, name, table }) => {
        const rows = rowsOfTable(memory, id);
        return {
          id, name, ...(trim(table.scope) ? { scope: trim(table.scope) } : {}),
          columns: columnMap(table).columns.map(column => ({ id: column.id, name: column.name, type: column.type || 'text', ...(Array.isArray(column.options) ? { options: column.options } : {}) })),
          rowCount: rows.length,
          rows: rows.slice(0, limit).map(row => ({
            rowId: trim(row.id), data: rowData(row),
            ...(row.is_pinned ? { pinned: true } : {}), ...(row.is_active === false ? { active: false } : {}),
            shared: !trim(row.contact_id) && !trim(row.group_id),
          })),
          ...(rows.length > limit ? { truncated: rows.length - limit } : {}),
        };
      }),
    };
  };

  /* ───────────── 共用：解析请求 → 预览 ───────────── */

  const capture = async (args = {}, context = {}, mode) => {
    if (typeof previewMemoryActions !== 'function' || typeof commitMemory !== 'function') return { error: { ok: false, reason: 'memory_table_unavailable' } };
    const sessionId = sessionOf(args, context);
    if (!sessionId) return { error: { ok: false, reason: 'no_current_session' } };
    const loaded = await loadContext(sessionId);
    if (loaded.error) return loaded;
    const { memory } = loaded;
    const tables = tablesOf(memory);
    const items = [];
    const actions = [];
    (Array.isArray(args.rows) ? args.rows : []).forEach((raw = {}, index) => {
      const fail = (reason, extra = {}) => items.push({ index, label: trim(raw.table), status: 'failed', reason, ...extra });
      const found = resolveNamedTarget(tables, raw.table);
      if (found.error) return fail(`table_${found.error}`, found.candidates ? { candidates: found.candidates } : {});
      const { id: tableId, name, table } = found.item;
      const rowId = trim(raw.rowId);
      let row = null;
      if (rowId) {
        row = memory.rowsById?.get?.(rowId) || (memory.allRows || []).find(item => trim(item.id) === rowId) || null;
        if (!row || rowTableId(row) !== tableId) return fail('row_not_found', { table: name, rowId });
      } else if (mode === 'delete') return fail('row_id_required', { table: name });
      let data = null;
      if (mode === 'upsert') {
        const { byKey } = columnMap(table);
        data = {};
        const unknown = [];
        (Array.isArray(raw.values) ? raw.values : []).forEach(({ column, value } = {}) => {
          const columnId = byKey.get(trim(column));
          if (!columnId) unknown.push(column);
          else data[columnId] = String(value ?? '');
        });
        if (unknown.length) return fail('unknown_column', { table: name, columns: unknown });
        if (!Object.keys(data).length) return fail('data_required', { table: name });
      }
      const action = mode === 'delete' ? { action: 'delete', tableId, rowId }
        : rowId ? { action: 'update', tableId, rowId, data } : { action: 'insert', tableId, data };
      items.push({ index, label: name, tableId, rowId, status: 'pending', actionIndex: actions.length, before: row ? JSON.stringify(rowData(row)) : null });
      actions.push(action);
    });
    const uiMode = trim(context?.uiMode || getUiMode?.());
    const preview = actions.length ? await previewMemoryActions({ sessionId, actions, updateMode: 'full', uiMode }) : null;
    items.forEach(item => {
      if (item.status !== 'pending') return;
      const entry = (preview?.entries || []).find(candidate => Number(candidate.index) === item.actionIndex);
      if (!entry || entry.skipped) {
        Object.assign(item, { status: entry?.reason === 'unchanged' ? 'skipped' : 'failed', reason: entry?.reason || 'preview_missing' });
        return;
      }
      const table = tablesOf(memory).find(candidate => candidate.id === item.tableId)?.table;
      const { columns } = columnMap(table);
      const nameOf = id => columns.find(column => column.id === id)?.name || id;
      let meta;
      if (entry.kind === 'delete') meta = t('删除：{row}', { row: describeRow(table, entry.diff?.before) || item.rowId });
      else if (entry.kind === 'insert') meta = t('新增：{row}', { row: Object.entries(entry.diff?.after || {}).map(([key, value]) => `${nameOf(key)}=${clip(value, 24)}`).join('、') });
      else {
        const before = entry.diff?.before || {};
        const after = entry.diff?.after || {};
        meta = Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
          .map(key => `${nameOf(key)}：${clip(before[key], 20) || t('（空）')} ⇒ ${clip(after[key], 20)}`).join('；');
      }
      Object.assign(item, { status: 'planned', kind: entry.kind, meta, rowId: entry.rowId || item.rowId, expect: entry.diff?.after || null });
    });
    const plannedActions = items.filter(item => item.status === 'planned').map(item => actions[item.actionIndex]);
    return {
      sessionId, uiMode, items, preview,
      plannedActions, plannedCount: plannedActions.length,
      tableCounts: Object.fromEntries(tables.map(({ id }) => [id, rowsOfTable(memory, id).length])),
    };
  };

  const confirmFor = (snap, kind, mode) => confirmRequest({
    kind, operationType: mode === 'delete' ? 'delete_memory_rows' : 'write_memory_rows', danger: mode === 'delete',
    title: mode === 'delete' ? t('删除记忆表格的行') : t('修改记忆表格'),
    message: t(mode === 'delete' ? '将删除记忆表格中的 {count} 行，删除后无法恢复。' : '将修改记忆表格中的 {count} 行。', { count: snap.plannedCount }),
    confirmText: mode === 'delete' ? t('删除') : t('保存'),
    items: snap.items.map(item => ({ id: item.rowId || `row_${item.index}`, label: item.label, status: item.status, reason: item.reason, meta: item.meta || '' })),
    denyReason: mode === 'delete' ? 'memory_rows_delete_cancelled' : 'memory_rows_upsert_cancelled',
  });

  const execute = async (snap, context, kind) => {
    if (snap.error) return snap.error;
    const strip = ({ actionIndex: _a, before: _b, expect: _e, meta: _m, kind: _k, ...item }) => item;
    const extra = { sessionId: snap.sessionId };
    if (!snap.plannedCount) return batchResult(kind, snap.items.map(strip), { extra });
    if (!isAllowed(context, kind)) return { ok: false, reason: 'confirmation_required', ...extra };
    if (context.signal?.aborted) return batchResult(kind, snap.items.map(item => (item.status === 'planned' ? { ...strip(item), status: 'cancelled', reason: 'user_aborted' } : strip(item))), { extra });
    const now = await loadContext(snap.sessionId);
    if (now.error) return now.error;
    // 确认期间目标行被改过或删掉（例如这一轮又自动填表）就不写
    const changed = snap.items.some(item => item.status === 'planned' && item.before !== null
      && JSON.stringify(rowData(now.memory.rowsById?.get?.(item.rowId) || (now.memory.allRows || []).find(row => trim(row.id) === item.rowId))) !== item.before);
    const missing = snap.items.some(item => item.status === 'planned' && item.before !== null
      && !(now.memory.allRows || []).some(row => trim(row.id) === item.rowId));
    if (changed || missing) return { ok: false, reason: 'target_changed_during_confirmation', ...extra };
    const commit = await commitMemory({
      args: { sessionId: snap.sessionId, actions: snap.plannedActions, updateMode: 'full', uiMode: snap.uiMode },
      previewResult: snap.preview,
    });
    if (commit?.status !== 'committed') return { ok: false, reason: commit?.reason || 'commit_failed', ...extra };
    const after = await loadContext(snap.sessionId);
    const rows = after.memory?.allRows || [];
    const results = snap.items.map(item => {
      if (item.status !== 'planned') return strip(item);
      let ok;
      if (item.kind === 'delete') ok = !rows.some(row => trim(row.id) === item.rowId);
      else if (item.kind === 'update') {
        const row = rows.find(candidate => trim(candidate.id) === item.rowId);
        ok = Boolean(row) && Object.entries(item.expect || {}).every(([key, value]) => JSON.stringify(rowData(row)[key]) === JSON.stringify(value));
      } else {
        ok = rows.some(row => rowTableId(row) === item.tableId && Object.entries(item.expect || {}).every(([key, value]) => JSON.stringify(rowData(row)[key]) === JSON.stringify(value)));
      }
      return ok ? { ...strip(item), status: 'succeeded' } : { ...strip(item), status: 'failed', reason: 'verification_failed' };
    });
    return batchResult(kind, results, { requestedCount: snap.items.length, extra });
  };

  const tableArg = { type: 'string', minLength: 1, maxLength: 120 };
  const upsertTool = {
    name: 'memory.rows.upsert',
    title: 'Edit memory table rows',
    description: 'Add or change rows of the memory tables (记忆表格) of the current conversation with one confirmation. rows[].table = table id or name from memory.rows.read; rowId changes that row, without rowId a new row is added; values[] = {column: column id or name, value: new text} (only the given columns change). Changes are applied with the same rules as AI table filling.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'restore_snapshot', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['rows'], additionalProperties: false,
      properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 200 },
        rows: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', required: ['table', 'values'], additionalProperties: false,
            properties: {
              table: tableArg,
              rowId: { type: 'string', maxLength: 120 },
              values: {
                type: 'array', minItems: 1, maxItems: 30,
                items: {
                  type: 'object', required: ['column', 'value'], additionalProperties: false,
                  properties: { column: { type: 'string', minLength: 1, maxLength: 120 }, value: { type: 'string', maxLength: 8000 } },
                },
              },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_memory_rows', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capture(args, context, 'upsert');
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmFor(snap, 'memory.rows.upsert', 'upsert');
      },
    },
    execute: async (args = {}, context = {}) => execute(snapshots.get(args) || await capture(args, context, 'upsert'), context, 'memory.rows.upsert'),
    summarizeResult: summarizeBatch('memory rows upsert'),
  };

  const deleteTool = {
    name: 'memory.rows.delete',
    title: 'Delete memory table rows',
    description: 'Delete rows of the memory tables (记忆表格) of the current conversation with one dangerous confirmation. rows[] = {table: id or name, rowId} from memory.rows.read.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'restore_snapshot', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['rows'], additionalProperties: false,
      properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 200 },
        rows: {
          type: 'array', minItems: 1, maxItems: 50,
          items: { type: 'object', required: ['table', 'rowId'], additionalProperties: false, properties: { table: tableArg, rowId: { type: 'string', minLength: 1, maxLength: 120 } } },
        },
      },
    },
    safety: {
      operationType: 'delete_memory_rows', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capture(args, context, 'delete');
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmFor(snap, 'memory.rows.delete', 'delete');
      },
    },
    execute: async (args = {}, context = {}) => execute(snapshots.get(args) || await capture(args, context, 'delete'), context, 'memory.rows.delete'),
    summarizeResult: summarizeBatch('memory rows delete'),
  };

  return [
    {
      name: 'memory.rows.read',
      title: 'Read memory tables',
      description: 'Read the memory tables (记忆表格) of the current conversation: each table with its columns and rows (rowId, data by column id, pinned, shared across conversations). table = id or name narrows to one table; limit rows per table (default 30).',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: {
        type: 'object', additionalProperties: false,
        properties: { sessionId: { type: 'string', minLength: 1, maxLength: 200 }, table: tableArg, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
      execute: readRows,
      summarizeResult: result => (result?.ok ? `read ${Number(result.tables?.length || 0)} memory table(s)` : `memory table read failed: ${trim(result?.reason)}`),
    },
    upsertTool,
    deleteTool,
  ];
};

export const registerMemoryTableEditAgentTools = (registry, deps = {}) => registry.registerMany(createMemoryTableEditAgentTools(deps));
