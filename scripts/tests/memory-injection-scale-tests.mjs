import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

import {
  buildMemoryTablePlan,
  estimateTokens,
  limitSummaryRowsForPrompt,
  resolveMemorySummaryCompactionThreshold,
  resolveMemorySummaryInjectionLimit,
  resolveMemorySummaryRowLimit,
} from '../../src/scripts/memory/memory-prompt-utils.js';
import {
  reflowUnusedRecallToRecent,
  resolveMemoryBudgetEnvelope,
} from '../../src/scripts/memory/memory-budget-allocator-utils.js';
import {
  buildMemoryPromptRowLayers,
  buildSegmentedMemoryTablePlan,
  estimateMemorySegmentDemands,
} from '../../src/scripts/memory/memory-segment-plan-utils.js';
import { buildMemoryKeywordRecallPlan } from '../../src/scripts/memory/memory-keyword-recall-utils.js';
import { limitHistoryByTokenBudget } from '../../src/scripts/ui/chat/llm-history-utils.js';

const tableById = new Map([
  ['rp_summary', {
    id: 'rp_summary',
    name: '剧情摘要',
    columns: [{ id: 'time', name: '轮次' }, { id: 'summary', name: '摘要' }],
  }],
  ['rp_outline', {
    id: 'rp_outline',
    name: '总体大纲',
    columns: [{ id: 'time', name: '轮次' }, { id: 'outline', name: '大纲' }],
  }],
]);

const createRows = (tableId, count, field) => Array.from({ length: count }, (_, index) => ({
  id: `${tableId}-${index + 1}`,
  table_id: tableId,
  row_data: {
    time: `第${index + 1}轮`,
    [field]: `第${index + 1}段内容-${'中文'.repeat(20)}`,
  },
  is_active: true,
  is_pinned: false,
  priority: 0,
  sort_order: index + 1,
  updated_at: index + 1,
  contact_id: 'rp:test',
}));

const summaries = createRows('rp_summary', 3000, 'summary');
const outlines = createRows('rp_outline', 3000, 'outline');

const bridgeLimited = limitSummaryRowsForPrompt([...summaries, ...outlines], 10);
assert.equal(bridgeLimited.filter(row => row.table_id === 'rp_summary').length, 10);
assert.equal(bridgeLimited.filter(row => row.table_id === 'rp_outline').length, 3000);
assert.equal(
  bridgeLimited.find(row => row.table_id === 'rp_summary')?.id,
  'rp_summary-2991',
);

const startedAt = performance.now();
const rowLimited = buildMemoryTablePlan({
  rows: bridgeLimited,
  tableById,
  tableOrder: ['rp_summary', 'rp_outline'],
  autoExtract: true,
  maxRows: 120,
  tokenBudgetData: 1000000,
  tokenMode: 'rough',
});
const elapsedMs = performance.now() - startedAt;
assert.equal(rowLimited.items.length, 120);
assert.equal(rowLimited.truncated.length, 2890);
assert.ok(rowLimited.truncated.every(item => item.reason === 'max_rows'));
assert.equal(rowLimited.rowIndexMap.rp_outline.length, 110);
assert.equal(rowLimited.rowIndexMap.rp_outline[0], 'rp_outline-2891');
assert.equal(rowLimited.rowIndexMap.rp_outline[109], 'rp_outline-3000');
assert.ok(elapsedMs < 3000, `3000 行裁剪耗时过长：${elapsedMs.toFixed(1)}ms`);

const tokenLimited = buildMemoryTablePlan({
  rows: outlines,
  tableById,
  tableOrder: ['rp_outline'],
  autoExtract: true,
  maxRows: 3000,
  tokenBudgetData: 500,
  tokenMode: 'rough',
});
assert.ok(tokenLimited.items.length > 0 && tokenLimited.items.length < outlines.length);
assert.ok(tokenLimited.truncated.some(item => item.reason === 'max_tokens'));
assert.equal(tokenLimited.rowIndexMap.rp_outline.length, tokenLimited.items.length);
assert.ok(
  tokenLimited.items.reduce((sum, item) => sum + Number(item.tokens || 0), 0) <= 500,
);

console.log('ok - 3000-row memory injection obeys bridge summary cap, row/token limits, ordering and row index mapping');


{
  // 端到端总量护栏：任意合成规模下，常驻/中景/远景记忆 + 按需召回 + 裁剪后 history
  // + 世界书配额 + 固定预留 ≤ 用户预算 B（state 未超配的正常形态；state 超配属
  // 显式告警不裁的护栏例外，不在本断言范围）。
  const B = 20000;
  const fullTableById = new Map([
    ...tableById,
    ['rp_tasks', {
      id: 'rp_tasks',
      name: '任务',
      columns: [{ id: 'task', name: '任务' }, { id: 'status', name: '状态' }],
    }],
  ]);
  const fullTableOrder = ['rp_tasks', 'rp_summary', 'rp_outline'];
  for (const scale of [600, 3000]) {
    const stateRows = Array.from({ length: 5 }, (_, index) => ({
      id: `rp_tasks-${index + 1}`,
      table_id: 'rp_tasks',
      row_data: { task: `任务${index + 1}`, status: '进行中' },
      is_active: true,
      sort_order: index + 1,
      contact_id: 'rp:test',
    }));
    const layers = buildMemoryPromptRowLayers([
      ...stateRows,
      ...createRows('rp_summary', scale, 'summary'),
      ...createRows('rp_outline', scale, 'outline'),
    ]);
    const demands = estimateMemorySegmentDemands({
      rows: layers.limitedRows,
      tableById: fullTableById,
      tableOrder: fullTableOrder,
      autoExtract: true,
      tokenMode: 'rough',
    });
    const historyMessages = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `历史消息${index}-${'中文'.repeat(30)}`,
    }));
    const historyDemand = historyMessages.reduce(
      (sum, message) => sum + estimateTokens(message.content, 'rough'),
      0,
    );
    const envelope = resolveMemoryBudgetEnvelope({
      settings: { memoryBudgetMode: 'token', memoryInputBudgetTokens: B },
      maxContextTokens: 200000,
      maxOutputTokens: 1024,
      place: 'writing',
      worldContextPercent: 20,
      worldBudgetCap: 0,
      demands: {
        state: demands.state,
        recent: historyDemand,
        mid: demands.mid,
        far: demands.far,
        recall: Number.POSITIVE_INFINITY,
      },
    });
    assert.equal(envelope.inputBudgetTokens, B);
    const allocations = { ...envelope.allocation.allocations };
    const segmented = buildSegmentedMemoryTablePlan({
      rows: layers.limitedRows,
      tableById: fullTableById,
      tableOrder: fullTableOrder,
      autoExtract: true,
      maxRows: 1000,
      tokenQuotas: allocations,
      tokenMode: 'rough',
      preserveState: true,
    });
    const memoryTokens = estimateTokens(segmented.tableData, 'rough');
    const recallPlan = buildMemoryKeywordRecallPlan({
      rows: layers.recallCandidateRows,
      tableById: fullTableById,
      queryText: `第${scale - 20}段内容`,
      tokenBudget: allocations.recall,
      maxRows: 20,
      tokenMode: 'rough',
    });
    const recallTokens = Math.max(0, Math.trunc(Number(recallPlan.tokens)) || 0);
    const reflowed = reflowUnusedRecallToRecent(allocations, recallTokens).allocations;
    const limitedHistory = limitHistoryByTokenBudget(historyMessages, {
      inputBudgetTokens: reflowed.recent,
      tokenMode: 'rough',
    });
    const total = memoryTokens
      + recallTokens
      + limitedHistory.stats.usedTokens
      + (envelope.worldBudgetTokens ?? 0)
      + envelope.fixedReserveTokens;
    assert.ok(memoryTokens > 0, `scale=${scale} 记忆段为空`);
    assert.ok(limitedHistory.stats.usedTokens > 0, `scale=${scale} history 为空`);
    assert.ok(total <= B, `scale=${scale} 总注入 ${total} 超过预算 ${B}`);
  }
  console.log('ok - end-to-end synthetic pipeline keeps total injection within user budget B');
}

{
  // 聊天一轮很短，摘要条数单独设（默认 20）；写作与动态沿用原来的条数（默认 10）。
  assert.equal(resolveMemorySummaryRowLimit({}, 'chat_summary'), 20);
  assert.equal(resolveMemorySummaryRowLimit({}, 'group_summary'), 20);
  assert.equal(resolveMemorySummaryRowLimit({}, 'rp_summary'), 10);
  assert.equal(resolveMemorySummaryRowLimit({}, 'moment_summary'), 10);
  assert.equal(resolveMemorySummaryRowLimit({}), 10);
  const settings = { memorySummaryRowLimit: 12, memorySummaryRowLimitChat: 30 };
  assert.equal(resolveMemorySummaryRowLimit(settings, 'chat_summary'), 30);
  assert.equal(resolveMemorySummaryRowLimit(settings, 'rp_summary'), 12);
  assert.equal(resolveMemorySummaryRowLimit({ memorySummaryRowLimitChat: 999 }, 'chat_summary'), 50);

  const mk = (tableId, n) => Array.from({ length: n }, (_, i) => ({ id: `${tableId}-${i}`, table_id: tableId, sort_order: i, row_data: {} }));
  const limited = limitSummaryRowsForPrompt([...mk('chat_summary', 25), ...mk('rp_summary', 25)], tableId => resolveMemorySummaryRowLimit({}, tableId));
  assert.equal(limited.filter(row => row.table_id === 'chat_summary').length, 20);
  assert.equal(limited.filter(row => row.table_id === 'rp_summary').length, 10);
  console.log('ok - summary row limit is resolved per table (chat 20, writing 10)');
}

{
  // 压缩失败或还没跑完时摘要会超过条数：保留滚动大总结，裁最旧的普通摘要。
  const rows = [{ id: 'rolling', table_id: 'rp_summary', sort_order: 8, row_data: { _coverage: { from: 1, to: 8 }, _summary_compaction: { level: 'rolling' } } }];
  for (let i = 9; i <= 20; i += 1) rows.push({ id: `r${i}`, table_id: 'rp_summary', sort_order: i, row_data: { _coverage: { from: i, to: i } } });
  const limited = limitSummaryRowsForPrompt(rows, 10).map(row => row.id);
  assert.deepEqual(limited, ['rolling', 'r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r20']);
  console.log('ok - summary row limit always keeps the rolling compacted summary');
}

{
  const rolling = createRows('rp_summary', 5, 'summary').map((row, index) => ({
    ...row,
    id: `rolling-${index}`,
    row_data: { ...row.row_data, _summary_compaction: { level: 'rolling' } },
  }));
  const plain = createRows('rp_summary', 5, 'summary').map(row => ({ ...row, sort_order: row.sort_order + 10 }));
  assert.deepEqual(limitSummaryRowsForPrompt([...rolling.slice(0, 4), ...plain], 4).map(row => row.id),
    rolling.slice(0, 4).map(row => row.id), '滚动摘要用完名额时不能把 -0 当作保留全部普通摘要');
  assert.deepEqual(limitSummaryRowsForPrompt([...rolling, ...plain], 4).map(row => row.id),
    rolling.map(row => row.id), '滚动摘要本身超额时仍保留已有剧情，但不附带普通摘要');
  assert.deepEqual(limitSummaryRowsForPrompt([...rolling.slice(0, 3), ...plain], 4).map(row => row.id),
    [...rolling.slice(0, 3), plain.at(-1)].map(row => row.id));
  assert.equal(limitSummaryRowsForPrompt([...rolling, ...plain], 0).length, 10, '不限条数时仍全量保留');
  console.log('ok - exhausted summary slots exclude plain rows without dropping rolling summaries');
}

{
  // 触发方式默认按条数；按字数时写作/聊天/群聊摘要注入不按条数裁剪（未合并的全部发送），动态摘要仍按条数。
  assert.deepEqual(resolveMemorySummaryCompactionThreshold({}, 'rp_summary'), { trigger: 'rows', rowLimit: 10, minLength: 1000 });
  assert.deepEqual(resolveMemorySummaryCompactionThreshold({ memorySummaryCompactionTrigger: 'chars', memorySummaryCompactionChars: 50 }, 'chat_summary'), { trigger: 'chars', rowLimit: 20, minLength: 200 });
  assert.equal(resolveMemorySummaryCompactionThreshold({ memorySummaryCompactionChars: 99999 }).minLength, 20000);
  assert.equal(resolveMemorySummaryInjectionLimit({}, 'chat_summary'), 20);
  const chars = { memorySummaryCompactionTrigger: 'chars' };
  for (const tableId of ['rp_summary', 'chat_summary', 'group_summary']) assert.equal(resolveMemorySummaryInjectionLimit(chars, tableId), 0, tableId);
  assert.equal(resolveMemorySummaryInjectionLimit(chars, 'moment_summary'), 10);
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, table_id: 'rp_summary', sort_order: index, row_data: { summary: `摘要${index}` } }));
  assert.equal(limitSummaryRowsForPrompt(rows, tableId => resolveMemorySummaryInjectionLimit(chars, tableId)).length, 30);
  assert.equal(limitSummaryRowsForPrompt(rows, tableId => resolveMemorySummaryInjectionLimit({}, tableId)).length, 10);
  console.log('ok - character-triggered compaction sends every unmerged summary row');
}


{
  // 摘要模式（chatStore 摘要）注入条数跟「触发与频率」同一口径：群聊有大总结后也发到设定条数，不再只发 3 条。
  const bridgeSource = readFileSync(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
  const body = bridgeSource.slice(bridgeSource.indexOf('const getSummaryModeInjectionLimits'), bridgeSource.indexOf('const getSessionSummaryItems'));
  assert.match(body, /uiMode === 'rp' \? 'rp_summary' : \(isGroupChat \? 'group_summary' : 'chat_summary'\)/);
  assert.match(body, /resolveMemorySummaryInjectionLimit\(appSettings\.get\(\), tableId\) \|\| Infinity/);
  assert.match(body, /limitPlainGroup: limit, limitWithCompacted: Math\.max\(30, limit\), limitWithCompactedGroup: limit/);
  assert.doesNotMatch(body, /limitWithCompactedGroup: 3/);
  console.log('ok - summary-mode injection follows the configured row limit for group chats');
}

{
  // 摘要模式私聊/写作也要注入大总结（两处拼装：historyRecallBlocks 与非 openai 顺序），否则压缩后被合并的内容会丢。
  const bridgeSource = readFileSync(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
  const marker = "'memory.summary.private_history_header'";
  const starts = [];
  for (let at = bridgeSource.indexOf(marker); at >= 0; at = bridgeSource.indexOf(marker, at + 1)) starts.push(at);
  assert.equal(starts.length, 2);
  for (const at of starts) {
    const before = bridgeSource.slice(bridgeSource.lastIndexOf('} else {', at), at);
    assert.match(before, /if \(compactedText\) rows\.push\(formatMemoryPromptText\(\s*'memory\.summary\.long_line'/);
    assert.match(bridgeSource.slice(at, at + 200), /\$\{rows\.join\('\\n'\)\}/);
  }
  console.log('ok - summary-mode private chats inject the compacted summary');
}
