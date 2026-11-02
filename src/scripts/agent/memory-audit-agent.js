// 记忆管家（Agent 资源中心计划 P5）：只读、只用规则检查整张角色卡的记忆，不调模型、不写入。
// 和世界书检查一样排进 Agent 运行（活动里看得到）；发现的问题只报告，由用户去对应位置处理。
// finding：{ type, severity: 'warning'|'info', room?, tableId?, params }，文字由界面按 type 生成。

import { isSummaryTableId } from '../memory/memory-prompt-utils.js';
import { memoryRoomOf } from '../memory/memory-overview-model.js';

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const MEMORY_AUDIT_LIMITS = Object.freeze({
  longSummaryChars: 800,
  similarRatio: 0.9,
  similarMinChars: 12,
  similarMaxRowsPerTable: 300,
  sharedRows: 20,
  examples: 3,
});

const rowText = rowData => (isPlainObject(rowData) ? Object.values(rowData) : [])
  .map(value => String(value ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
// 同一行内容的比较键：列名排序后拼接，忽略空白差异
const rowKey = rowData => (isPlainObject(rowData) ? Object.entries(rowData) : [])
  .map(([key, value]) => [trim(key), String(value ?? '').replace(/\s+/g, ' ').trim()])
  .filter(([key, value]) => key && value)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([key, value]) => `${key}=${value}`).join('|');
const charSet = text => new Set([...String(text)].filter(ch => ch.trim()));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((ch) => { if (b.has(ch)) inter += 1; });
  return inter / (a.size + b.size - inter);
};
const preview = text => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

/**
 * rows：整张卡的全部记忆行（含其他模板）；template：当前默认模板（含 schema.tables）；session：summarizeSessionMemory 的结果。
 * 记忆写入预览 5 分钟就过期、「写表前确认」是写入当下的弹窗，没有会搁置的待确认写表，所以不查「搁置太久」。
 */
export const auditMemoryData = ({ rows = [], templateId = '', template = null, session = null } = {}) => {
  const findings = [];
  const current = trim(templateId);
  const tables = Array.isArray(template?.schema?.tables) ? template.schema.tables : (Array.isArray(template?.tables) ? template.tables : []);
  const tableById = new Map(tables.map(table => [trim(table?.id), table]));
  const all = Array.isArray(rows) ? rows : [];

  // 旧模板留下的行：当前模板不会读取，也不会注入
  const others = new Map();
  all.filter(row => trim(row?.template_id) !== current).forEach((row) => {
    const id = trim(row?.template_id);
    others.set(id, (others.get(id) || 0) + 1);
  });
  others.forEach((count, id) => findings.push({ type: 'old_template_rows', severity: 'warning', params: { templateId: id, count } }));

  const live = all.filter(row => trim(row?.template_id) === current);
  const groups = new Map(); // 聊天室＋表 → 行
  live.forEach((row) => {
    const room = memoryRoomOf(row);
    const key = `${room.key}\u0000${trim(row?.table_id)}`;
    if (!groups.has(key)) groups.set(key, { room, tableId: trim(row?.table_id), rows: [] });
    groups.get(key).rows.push(row);
  });

  groups.forEach(({ room, tableId, rows: tableRows }) => {
    const table = tableById.get(tableId);
    const params = { tableId, tableName: trim(table?.name) || tableId };
    const empty = tableRows.filter(row => !rowText(row?.row_data));
    if (empty.length) findings.push({ type: 'empty_rows', severity: 'warning', room, tableId, params: { ...params, count: empty.length } });

    // 完全相同的行
    const seen = new Map();
    const duplicates = [];
    tableRows.forEach((row) => {
      const key = rowKey(row?.row_data);
      if (!key) return;
      if (seen.has(key)) duplicates.push(row);
      else seen.set(key, row);
    });
    if (duplicates.length) {
      findings.push({ type: 'duplicate_rows', severity: 'warning', room, tableId,
        params: { ...params, count: duplicates.length, examples: duplicates.slice(0, MEMORY_AUDIT_LIMITS.examples).map(row => preview(rowText(row.row_data))) } });
    }

    // 内容几乎相同（字集合相似度）：行太多的表跳过，避免卡顿
    const candidates = [...seen.values()].map(row => ({ text: rowText(row?.row_data) })).filter(item => item.text.length >= MEMORY_AUDIT_LIMITS.similarMinChars);
    if (candidates.length <= MEMORY_AUDIT_LIMITS.similarMaxRowsPerTable) {
      candidates.forEach((item) => { item.set = charSet(item.text); });
      const pairs = [];
      for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
          if (jaccard(candidates[i].set, candidates[j].set) >= MEMORY_AUDIT_LIMITS.similarRatio) pairs.push([candidates[i].text, candidates[j].text]);
        }
      }
      if (pairs.length) {
        findings.push({ type: 'similar_rows', severity: 'info', room, tableId,
          params: { ...params, count: pairs.length, examples: pairs.slice(0, MEMORY_AUDIT_LIMITS.examples).map(([a, b]) => `${preview(a)} ↔ ${preview(b)}`) } });
      }
    }

    const maxRows = Number(table?.maxRows);
    if (Number.isFinite(maxRows) && maxRows > 0 && tableRows.length > maxRows) {
      findings.push({ type: 'over_max_rows', severity: 'warning', room, tableId, params: { ...params, count: tableRows.length, maxRows } });
    }

    if (isSummaryTableId(tableId)) {
      const long = tableRows.map(row => rowText(row?.row_data).length).filter(length => length > MEMORY_AUDIT_LIMITS.longSummaryChars);
      if (long.length) findings.push({ type: 'long_summaries', severity: 'info', room, tableId, params: { ...params, count: long.length, maxChars: Math.max(...long) } });
    }
  });

  // 整张卡都没写过、但这张卡用得到的表：只按卡上已有的聊天室种类判断（只写创意写作的卡不提私聊、群聊的表；动态没法从记忆判断，不提）
  const used = new Set(live.map(row => trim(row?.table_id)));
  const kinds = new Set(live.map(row => memoryRoomOf(row).kind));
  const applies = (table) => {
    const usage = trim(table?.usage) || 'all';
    const scope = trim(table?.scope);
    if (usage === 'all') return true;
    if (usage === 'rp') return kinds.has('rp');
    if (usage === 'chat') return scope === 'group' ? kinds.has('group') : scope === 'contact' ? kinds.has('private') : kinds.has('private') || kinds.has('group');
    return false;
  };
  const unused = tables.filter(table => applies(table) && !used.has(trim(table?.id))).map(table => trim(table?.name) || trim(table?.id));
  if (live.length && unused.length) findings.push({ type: 'unused_tables', severity: 'info', params: { count: unused.length, names: unused } });

  // 当前会话：最近一次发送的注入情况
  const injection = session?.injection;
  if (injection?.state === 'ok') {
    if (injection.trimmedRows > 0) findings.push({ type: 'injection_trimmed', severity: 'info', params: { count: injection.trimmedRows } });
    if (injection.sharedRows >= MEMORY_AUDIT_LIMITS.sharedRows) {
      findings.push({ type: 'shared_heavy', severity: 'info', params: { count: injection.sharedRows, sources: injection.shared.map(item => item.label) } });
    }
  }
  if (session?.storageMode === 'table' && session.autoWrite && session.autoWrite.enabled === false) {
    findings.push({ type: 'auto_write_off', severity: 'info', params: {} });
  }

  return {
    counts: {
      rows: all.length,
      warnings: findings.filter(item => item.severity === 'warning').length,
      infos: findings.filter(item => item.severity === 'info').length,
    },
    findings,
  };
};

export const createMemoryAuditAgent = ({ agentTaskRuntime = null, collect = async () => ({}), now = Date.now } = {}) => ({
  auditMemory: (request = {}) => {
    if (typeof agentTaskRuntime?.enqueue !== 'function') return Promise.reject(new Error('agent task runtime not configured'));
    const sessionId = trim(request?.sessionId);
    return agentTaskRuntime.enqueue({
      kind: 'memory_audit',
      title: '记忆检查',
      sessionId,
      source: 'memory-check',
      trigger: trim(request?.source, 'manual'),
      summary: '只读检查整张卡的记忆',
      metadata: { sessionId },
    }, async ({ runId, startStep, finishStep }) => {
      const loadStep = startStep({ type: 'memory_audit.load', summary: '读取记忆资料' });
      let data;
      try {
        data = await collect({ sessionId });
      } catch (error) {
        finishStep(loadStep.id, { status: 'failed', errorMessage: String(error?.message || error) });
        throw error;
      }
      finishStep(loadStep.id, { status: 'succeeded', output: { rowCount: Array.isArray(data?.rows) ? data.rows.length : 0 } });
      const analyzeStep = startStep({ type: 'memory_audit.analyze', summary: '检查记忆表格' });
      const report = auditMemoryData(data);
      finishStep(analyzeStep.id, { status: 'succeeded', output: { counts: report.counts, findingCount: report.findings.length } });
      return { runId, status: 'succeeded', report, checkedAt: now() };
    });
  },
});
