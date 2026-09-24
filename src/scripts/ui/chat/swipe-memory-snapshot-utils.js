import { sortMemoryRowsForSnapshot } from '../../memory/memory-row-order.js';
import { batchCreateMemoriesWithFallback } from '../session-memory-write-utils.js';

const normalizeNumber = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
};

export const buildSwipeMemorySnapshotRows = ({
  rows = [],
  templateId = '',
  scopeFields = {},
  cloneValue = value => value,
} = {}) => (
  sortMemoryRowsForSnapshot(Array.isArray(rows) ? rows : [])
    .map((row) => {
      const tableId = String(row?.table_id || '').trim();
      if (!tableId) return null;
      return {
        id: String(row?.id || '').trim(),
        template_id: String(row?.template_id || templateId).trim() || templateId,
        table_id: tableId,
        contact_id: scopeFields.contact_id ?? null,
        group_id: scopeFields.group_id ?? null,
        row_data: cloneValue(row?.row_data || {}),
        is_active: row?.is_active !== false,
        is_pinned: Boolean(row?.is_pinned),
        priority: normalizeNumber(row?.priority),
        sort_order: normalizeNumber(row?.sort_order),
      };
    })
    .filter(Boolean)
);

export const buildSwipeMemorySnapshot = ({
  rows = [],
  templateId = '',
  scope = 'contact',
  scopeFields = {},
  cloneValue = value => value,
  capturedAt = Date.now(),
} = {}) => ({
  templateId,
  scope,
  rows: buildSwipeMemorySnapshotRows({
    rows,
    templateId,
    scopeFields,
    cloneValue,
  }),
  capturedAt,
});

export const buildSwipeMemorySnapshotInputs = ({
  rows = [],
  templateId = '',
  scopeFields = {},
  cloneValue = value => value,
} = {}) => (
  sortMemoryRowsForSnapshot(Array.isArray(rows) ? rows : [])
    .map((row) => {
      const tableId = String(row?.table_id || '').trim();
      if (!tableId) return null;
      return {
        id: row?.id ? String(row.id) : undefined,
        template_id: templateId,
        table_id: tableId,
        contact_id: scopeFields.contact_id ?? null,
        group_id: scopeFields.group_id ?? null,
        row_data: cloneValue(row?.row_data || {}),
        is_active: row?.is_active !== false,
        is_pinned: Boolean(row?.is_pinned),
        priority: normalizeNumber(row?.priority),
        sort_order: normalizeNumber(row?.sort_order),
      };
    })
    .filter(Boolean)
);

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const memoryRowKey = row => stableStringify({ ...row, id: row?.id ? String(row.id) : '' });

// 现有行与快照逐行一致（同 id、同内容、同顺序与状态）时无需删除重建
export const isScopedMemorySnapshotUnchanged = ({
  existingRows = [],
  snapshotInputs = [],
  templateId = '',
  scopeFields = {},
} = {}) => {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const normalized = buildSwipeMemorySnapshotInputs({ rows: existing, templateId, scopeFields });
  if (normalized.length !== existing.length || normalized.length !== snapshotInputs.length) return false;
  return normalized.every((row, index) => memoryRowKey(row) === memoryRowKey(snapshotInputs[index]));
};

export const replaceScopedMemoriesWithSnapshot = async ({
  memoryTableStore = null,
  existingRows = [],
  snapshotRows = [],
  templateId = '',
  scopeFields = {},
  cloneValue = value => value,
} = {}) => {
  const inputs = buildSwipeMemorySnapshotInputs({
    rows: snapshotRows,
    templateId,
    scopeFields,
    cloneValue,
  });
  // 进房、切换模式都会恢复尾部快照；内容没变时跳过删除重建：不再每次进房重写整张表，
  // 也没有“删完还没建好”的空表窗口。行的 created_at/updated_at 因此保留真实时间。
  if (isScopedMemorySnapshotUnchanged({ existingRows, snapshotInputs: inputs, templateId, scopeFields })) {
    return { deletedIds: [], inputs: [], unchanged: true };
  }
  const ids = (Array.isArray(existingRows) ? existingRows : [])
    .map(row => String(row?.id || '').trim())
    .filter(Boolean);
  if (ids.length) {
    try {
      await memoryTableStore?.batchDeleteMemories?.(ids);
    } catch {
      for (const id of ids) {
        try {
          await memoryTableStore?.deleteMemory?.(id);
        } catch {}
      }
    }
  }

  if (inputs.length) {
    await batchCreateMemoriesWithFallback({ memoryTableStore, inputs });
  }

  return { deletedIds: ids, inputs };
};
