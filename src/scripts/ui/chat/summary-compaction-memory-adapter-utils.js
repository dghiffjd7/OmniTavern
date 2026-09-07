import { resolveMemoryRowOrderKey } from '../../memory/memory-row-order.js';
import {
  mergeMemoryCoverageIntervals,
  readMemoryCoverageIntervals,
} from '../../memory/memory-coverage-utils.js';

export const resolveMemorySummaryTableId = ({ place = 'chat', isGroup = false } = {}) => {
  const mode = String(place || '').trim().toLowerCase();
  if (mode === 'moments' || mode === 'moment') return 'moment_summary';
  if (mode === 'writing' || mode === 'rp' || mode === 'creative') return 'rp_summary';
  return isGroup ? 'group_summary' : 'chat_summary';
};

const getSummaryText = (row = {}) =>
  String(row?.row_data?.summary ?? row?.row_data?.text ?? '').trim();

// 覆盖区间走统一读取口（含 time 文本兜底）：存量会话的旧摘要行没有 _coverage，
// 压缩时若丢掉兜底区间，压缩产物会把已覆盖轮次变成空洞、触发覆盖线护栏强留原文。
// intervals 保留每行的区间并集：再压缩时不得把源行之间的真实空洞并成连续跨度。
const getCoverage = (row = {}) => {
  const intervals = readMemoryCoverageIntervals(row);
  if (!intervals.length) return { from: null, to: null, intervals: [] };
  return {
    from: intervals[0].from,
    to: intervals[intervals.length - 1].to,
    intervals: intervals.map(({ from, to }) => ({ from, to })),
  };
};

export const normalizeMemorySummaryRows = (rows = [], tableId = '') => (
  (Array.isArray(rows) ? rows : [])
    .filter(row => row?.is_active !== false)
    .filter(row => String(row?.table_id || '').trim() === String(tableId || '').trim())
    .filter(row => row?.row_data?._summary_compaction?.level !== 'rolling')
    .map((row, index) => {
      const text = getSummaryText(row);
      if (!text) return null;
      const coverage = getCoverage(row);
      return {
        id: String(row?.id || '').trim(),
        text,
        at: Number(row?.created_at || row?.updated_at || 0) || 0,
        from: coverage.from,
        to: coverage.to,
        intervals: coverage.intervals,
        order: resolveMemoryRowOrderKey(row, tableId, index),
        row,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.at - b.at || a.id.localeCompare(b.id))
);

const resolveScopeQuery = ({ sessionId, place, isGroup, templateId }) => {
  const base = { template_id: templateId };
  const mode = String(place || '').trim().toLowerCase();
  if (mode === 'moments' || mode === 'moment') return { ...base, scope: 'global' };
  if (isGroup) return { ...base, scope: 'group', group_id: sessionId };
  return { ...base, scope: 'contact', contact_id: sessionId };
};

const resolveScopeFields = ({ sessionId, place, isGroup }) => {
  const mode = String(place || '').trim().toLowerCase();
  if (mode === 'moments' || mode === 'moment') return { contact_id: null, group_id: null };
  if (isGroup) return { contact_id: null, group_id: sessionId };
  return { contact_id: sessionId, group_id: null };
};

export const createMemoryTableSummaryCompactionAdapter = ({
  memoryTableStore = null,
  memoryTemplateStore = null,
  sessionId = '',
  place = 'chat',
  isGroup = false,
  onPersisted = null,
} = {}) => {
  const sid = String(sessionId || '').trim();
  const tableId = resolveMemorySummaryTableId({ place, isGroup });
  let templateId = '';
  let cachedRows = [];

  const ensureTemplateId = async () => {
    if (templateId) return templateId;
    const defaults = await memoryTemplateStore?.getTemplates?.({ is_default: true });
    const record = Array.isArray(defaults) ? defaults[0] : null;
    templateId = String(record?.id || '').trim();
    return templateId;
  };
  const loadRows = async () => {
    const tid = await ensureTemplateId();
    if (!tid || !memoryTableStore?.getMemories) return [];
    const rows = await memoryTableStore.getMemories(resolveScopeQuery({
      sessionId: sid,
      place,
      isGroup,
      templateId: tid,
    }));
    cachedRows = Array.isArray(rows) ? rows : [];
    return cachedRows;
  };
  const findCompactedRow = (rows = cachedRows) => (
    (Array.isArray(rows) ? rows : [])
      .filter(row => row?.is_active !== false)
      .filter(row => String(row?.table_id || '').trim() === tableId)
      .filter(row => row?.row_data?._summary_compaction?.level === 'rolling')
      .sort((a, b) => resolveMemoryRowOrderKey(b, tableId, 0) - resolveMemoryRowOrderKey(a, tableId, 0))[0]
    || null
  );

  return {
    kind: 'memory_table',
    tableId,
    normalizeItems: items => (Array.isArray(items) ? items : []),
    async getItems() {
      return normalizeMemorySummaryRows(await loadRows(), tableId);
    },
    async getCompactedText() {
      const row = findCompactedRow(await loadRows());
      return getSummaryText(row);
    },
    async persist({ text, raw, items = [], keepItems = [], signal = null } = {}) {
      const tid = await ensureTemplateId();
      signal?.throwIfAborted();
      if (!tid || !memoryTableStore?.createMemory || !memoryTableStore?.updateMemory) {
        throw new Error('memory summary compaction store unavailable');
      }
      const keepIds = new Set(
        (Array.isArray(keepItems) ? keepItems : []).map(item => String(item?.id || '')).filter(Boolean),
      );
      // 停用时打系统标记：召回准入只认带标记的 inactive 行（区分用户手动禁用）。
      // update_memory 对 row_data 是整体替换，必须携带原数据合并；拿不到原数据就只停用不打标。
      const deactivateAsCompactionArchive = async (rowId, rowData) => {
        signal?.throwIfAborted();
        const payload = { id: rowId, is_active: false };
        if (rowData && typeof rowData === 'object') {
          payload.row_data = { ...rowData, _archived_by: 'compaction' };
        }
        await memoryTableStore.updateMemory(payload);
      };
      const sourceItems = Array.isArray(items) ? items : [];
      for (const item of sourceItems) {
        const rowId = String(item?.id || '').trim();
        if (!rowId || keepIds.has(rowId)) continue;
        await deactivateAsCompactionArchive(rowId, item?.row?.row_data);
      }
      const previousCompacted = findCompactedRow(await loadRows());
      if (previousCompacted?.id) {
        await deactivateAsCompactionArchive(String(previousCompacted.id), previousCompacted?.row_data);
      }
      // 并集而非 min/max 跨度：源行之间的真实空洞（中间行被停用/删除）必须保留在
      // _coverage.intervals 里，否则覆盖线不再报洞、强留原文护栏失效。
      const coveredIntervals = mergeMemoryCoverageIntervals(
        sourceItems.flatMap(item => (
          Array.isArray(item?.intervals) && item.intervals.length
            ? item.intervals
            : [{ from: item?.from, to: item?.to }]
        )),
      );
      const coveredFrom = coveredIntervals.length ? coveredIntervals[0].from : null;
      const coveredTo = coveredIntervals.length
        ? coveredIntervals[coveredIntervals.length - 1].to
        : null;
      const scopeFields = resolveScopeFields({ sessionId: sid, place, isGroup });
      signal?.throwIfAborted();
      const created = await memoryTableStore.createMemory({
        template_id: tid,
        table_id: tableId,
        ...scopeFields,
        row_data: {
          time: coveredIntervals.length
            ? `第${coveredFrom}-${coveredTo}轮`
            : '滚动压缩',
          summary: String(text || '').trim(),
          _coverage: coveredIntervals.length
            ? {
                from: coveredFrom,
                to: coveredTo,
                source: 'compaction',
                ...(coveredIntervals.length > 1 ? { intervals: coveredIntervals } : {}),
              }
            : null,
          _summary_compaction: {
            level: 'rolling',
            source_row_ids: sourceItems.map(item => String(item?.id || '')).filter(Boolean),
            raw: String(raw || ''),
          },
        },
        is_active: true,
        sort_order: coveredIntervals.length ? coveredTo : Date.now(),
      });
      await onPersisted?.({
        sessionId: sid,
        place,
        tableId,
        created,
        sourceItems,
        keepItems,
      });
      return created;
    },
  };
};
