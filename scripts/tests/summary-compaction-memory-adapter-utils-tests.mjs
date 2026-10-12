import assert from 'node:assert/strict';

import {
  createMemoryTableSummaryCompactionAdapter,
  normalizeMemorySummaryRows,
  resolveMemorySummaryTableId,
} from '../../src/scripts/ui/chat/summary-compaction-memory-adapter-utils.js';
import { createSessionSummaryCompactionRuntime } from '../../src/scripts/ui/chat/summary-compaction-runtime-utils.js';
import { buildMemoryCoverageLine } from '../../src/scripts/memory/memory-coverage-utils.js';

assert.equal(resolveMemorySummaryTableId({ place: 'chat', isGroup: false }), 'chat_summary');
assert.equal(resolveMemorySummaryTableId({ place: 'chat', isGroup: true }), 'group_summary');
assert.equal(resolveMemorySummaryTableId({ place: 'writing' }), 'rp_summary');
assert.equal(resolveMemorySummaryTableId({ place: 'moments' }), 'moment_summary');

const rows = Array.from({ length: 4 }, (_, index) => ({
  id: `summary-${index + 1}`,
  table_id: 'rp_summary',
  contact_id: 'rp:test',
  row_data: {
    time: `第${index + 1}轮`,
    summary: `摘要${index + 1}`,
    _coverage: { from: index + 1, to: index + 1, source: 'app' },
  },
  is_active: true,
  sort_order: index + 1,
  created_at: index + 1,
}));
rows.push({
  id: 'compacted-old',
  table_id: 'rp_summary',
  contact_id: 'rp:test',
  row_data: {
    summary: '旧压缩',
    _summary_compaction: { level: 'rolling' },
  },
  is_active: true,
  sort_order: 10,
});

assert.deepEqual(
  normalizeMemorySummaryRows(rows, 'rp_summary').map(item => item.id),
  ['summary-1', 'summary-2', 'summary-3', 'summary-4'],
);

const updateCalls = [];
const createCalls = [];
const memoryTableStore = {
  async getMemories() {
    return rows;
  },
  async updateMemory(payload) {
    updateCalls.push(payload);
    const row = rows.find(item => item.id === payload.id);
    if (row && Object.prototype.hasOwnProperty.call(payload, 'is_active')) {
      row.is_active = payload.is_active;
    }
  },
  async createMemory(payload) {
    createCalls.push(payload);
    const created = { ...payload, id: 'compacted-new', created_at: 20 };
    rows.push(created);
    return created;
  },
};
const adapter = createMemoryTableSummaryCompactionAdapter({
  memoryTableStore,
  memoryTemplateStore: {
    async getTemplates() {
      return [{ id: 'default-v1' }];
    },
  },
  sessionId: 'rp:test',
  place: 'writing',
  isGroup: false,
});
const items = await adapter.getItems();
assert.equal(items.length, 4);
assert.equal(await adapter.getCompactedText(), '旧压缩');
await adapter.persist({
  text: '【关键事件】\n• 进入城市: 开始调查',
  raw: '<summary>...</summary>',
  items,
  keepItems: items.slice(-2),
});
assert.deepEqual(
  updateCalls.filter(call => call.is_active === false).map(call => call.id).sort(),
  ['compacted-old', 'summary-1', 'summary-2'],
);
// 系统停用必须打标：召回准入靠它区分用户手动禁用
for (const call of updateCalls.filter(item => item.is_active === false)) {
  assert.equal(call.row_data?._archived_by, 'compaction', `missing marker on ${call.id}`);
}
assert.equal(
  updateCalls.find(call => call.id === 'summary-1')?.row_data?.summary,
  '摘要1',
);
assert.equal(createCalls.length, 1);
assert.equal(createCalls[0].table_id, 'rp_summary');
assert.deepEqual(createCalls[0].row_data._coverage, {
  from: 1,
  to: 4,
  source: 'compaction',
});
assert.deepEqual(createCalls[0].row_data._summary_compaction.source_row_ids, [
  'summary-1',
  'summary-2',
  'summary-3',
  'summary-4',
]);

{
  const calls = [];
  const tableAdapter = {
    getItems: async () => [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }],
    getCompactedText: async () => '旧压缩',
    normalizeItems: value => value,
    persist: async payload => calls.push(payload),
  };
  const runtime = createSessionSummaryCompactionRuntime({
    getIsSummaryMemoryEnabled: () => false,
    getIsCompactionEnabled: ({ place }) => place === 'writing',
    createAdapter: async ({ place }) => {
      assert.equal(place, 'writing');
      return tableAdapter;
    },
    getIsConfigured: () => true,
    buildMessages: () => [],
    backgroundChat: async () => '',
    buildSessionContext: () => ({}),
    requestCompactionRaw: async () => '<summary>有效</summary>',
    parseCompactionResult: () => ({ text: '有效压缩', valid: true }),
    shouldCompact: () => true,
    setTimeoutFn: async fn => fn(),
    delayMs: 0,
  });
  assert.equal(await runtime('rp:test', { place: 'writing' }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].keepItems.map(item => item.id), ['b', 'c']);
}

{
  // 存量会话：旧摘要行只有模型写的 time 文本、没有 _coverage，压缩后覆盖区间必须经兜底继承
  const legacyRows = [
    {
      id: 'legacy-1',
      table_id: 'chat_summary',
      contact_id: 'chat:test',
      row_data: { time: '第2轮', summary: '旧摘要A' },
      is_active: true,
      sort_order: 2,
      created_at: 2,
    },
    {
      id: 'legacy-2',
      table_id: 'chat_summary',
      contact_id: 'chat:test',
      row_data: { time: '第3-5轮', summary: '旧摘要B' },
      is_active: true,
      sort_order: 5,
      created_at: 5,
    },
  ];
  const legacyCreateCalls = [];
  const legacyAdapter = createMemoryTableSummaryCompactionAdapter({
    memoryTableStore: {
      async getMemories() { return legacyRows; },
      async updateMemory(payload) {
        const row = legacyRows.find(item => item.id === payload.id);
        if (row && Object.prototype.hasOwnProperty.call(payload, 'is_active')) {
          row.is_active = payload.is_active;
        }
      },
      async createMemory(payload) {
        legacyCreateCalls.push(payload);
        const created = { ...payload, id: 'legacy-compacted', created_at: 9 };
        legacyRows.push(created);
        return created;
      },
    },
    memoryTemplateStore: { async getTemplates() { return [{ id: 'default-v1' }]; } },
    sessionId: 'chat:test',
    place: 'chat',
    isGroup: false,
  });
  const legacyItems = await legacyAdapter.getItems();
  assert.deepEqual(legacyItems.map(item => [item.from, item.to]), [[2, 2], [3, 5]]);
  await legacyAdapter.persist({ text: '压缩后', raw: '<summary>...</summary>', items: legacyItems, keepItems: [] });
  assert.equal(legacyCreateCalls.length, 1);
  assert.deepEqual(legacyCreateCalls[0].row_data._coverage, { from: 2, to: 5, source: 'compaction' });
  assert.equal(legacyCreateCalls[0].row_data.time, '第2-5轮');
}

console.log('ok - table memory compaction reads summary rows and writes a rollback-friendly memory row through an adapter');
console.log('ok - legacy time-text summary rows keep coverage through compaction via fallback interval parsing');


{
  // 源行之间有真实空洞（第 3 轮无摘要）：产物 _coverage 必须保留区间并集，
  // 不得并成连续跨度把洞标成已覆盖（吞洞会让覆盖线护栏失效）。
  const holeRows = [
    {
      id: 'hole-1',
      table_id: 'chat_summary',
      contact_id: 'c1',
      row_data: { time: '第1-2轮', summary: '前段', _coverage: { from: 1, to: 2, source: 'app' } },
      is_active: true,
      sort_order: 2,
      created_at: 1,
    },
    {
      id: 'hole-2',
      table_id: 'chat_summary',
      contact_id: 'c1',
      row_data: { time: '第4-5轮', summary: '后段', _coverage: { from: 4, to: 5, source: 'app' } },
      is_active: true,
      sort_order: 5,
      created_at: 2,
    },
  ];
  const holeCreates = [];
  const holeStore = {
    async getMemories() {
      return holeRows;
    },
    async updateMemory(payload) {
      const row = holeRows.find(item => item.id === payload.id);
      if (row && Object.prototype.hasOwnProperty.call(payload, 'is_active')) {
        row.is_active = payload.is_active;
      }
    },
    async createMemory(payload) {
      holeCreates.push(payload);
      const created = { ...payload, id: 'hole-compacted', created_at: 30 };
      holeRows.push(created);
      return created;
    },
  };
  const holeAdapter = createMemoryTableSummaryCompactionAdapter({
    memoryTableStore: holeStore,
    memoryTemplateStore: {
      async getTemplates() {
        return [{ id: 'default-v1' }];
      },
    },
    sessionId: 'c1',
    place: 'chat',
    isGroup: false,
  });
  const holeItems = await holeAdapter.getItems();
  assert.deepEqual(holeItems.map(item => item.intervals), [
    [{ from: 1, to: 2 }],
    [{ from: 4, to: 5 }],
  ]);
  await holeAdapter.persist({ text: '压缩后', raw: '', items: holeItems, keepItems: [] });
  assert.deepEqual(holeCreates[0].row_data._coverage, {
    from: 1,
    to: 5,
    source: 'compaction',
    intervals: [{ from: 1, to: 2 }, { from: 4, to: 5 }],
  });
  const line = buildMemoryCoverageLine({
    summaryRows: [holeCreates[0]],
    fromTurn: 1,
    toTurn: 5,
  });
  assert.deepEqual(line.holes, [{ from: 3, to: 3 }]);
  // 再压缩时产物作为源行，区间并集必须继续传递
  const recompactedItems = normalizeMemorySummaryRows(
    [{ ...holeCreates[0], id: 'hole-compacted', created_at: 30, row_data: { ...holeCreates[0].row_data, _summary_compaction: undefined } }],
    'chat_summary',
  );
  assert.deepEqual(recompactedItems[0].intervals, [{ from: 1, to: 2 }, { from: 4, to: 5 }]);
  console.log('ok - compaction product keeps interval union so coverage holes stay detectable');
}

{
  // 按条数触发：摘要表启用中的行（含滚动摘要）满注入条数才压缩，压缩后的滚动摘要＋保留行始终在注入范围内。
  const countRows = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `c-${index + 1}`, table_id: 'rp_summary', contact_id: 'rp:test', is_active: true, sort_order: index + 1,
      row_data: { summary: `摘要${index + 1}`, _coverage: { from: index + 1, to: index + 1 } },
    })),
    { id: 'c-rolling', table_id: 'rp_summary', contact_id: 'rp:test', is_active: true, sort_order: 0, row_data: { summary: '滚动', _summary_compaction: { level: 'rolling' } } },
    { id: 'c-off', table_id: 'rp_summary', contact_id: 'rp:test', is_active: false, sort_order: 0, row_data: { summary: '已停用' } },
  ];
  const makeAdapter = rowLimit => createMemoryTableSummaryCompactionAdapter({
    memoryTableStore: { getMemories: async () => countRows },
    memoryTemplateStore: { getTemplates: async () => [{ id: 'tpl' }] },
    sessionId: 'rp:test',
    place: 'writing',
    ...(rowLimit === undefined ? {} : { rowLimit }),
  });
  const check = async (rowLimit, force = false) => {
    const adapter = makeAdapter(rowLimit);
    const items = await adapter.getItems();
    return adapter.shouldCompact({ items, force });
  };
  assert.equal(await check(5), true, '4 条摘要＋1 条滚动摘要＝5（停用的不算），满 5 条触发');
  assert.equal(await check(6), false, '未满不触发（不再按字数）');
  assert.equal(await check(undefined), false, '默认 10 条');
  assert.equal(await check(6, true), true, '手动强制压缩不看条数');
  const empty = createMemoryTableSummaryCompactionAdapter({ memoryTableStore: { getMemories: async () => [] }, memoryTemplateStore: { getTemplates: async () => [{ id: 'tpl' }] }, sessionId: 'rp:test', place: 'writing', rowLimit: 4 });
  assert.equal(empty.shouldCompact({ items: await empty.getItems(), force: true }), false, '没有摘要时不压缩');
  console.log('ok - memory table summary compaction triggers when active summary rows (including rolling) reach the row limit');
}

{
  // 按字数触发：只算未合并的摘要（不含滚动摘要），总字数超过上限才压缩，条数不再起作用。
  const rows = [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `w-${index + 1}`, table_id: 'rp_summary', contact_id: 'rp:test', is_active: true, sort_order: index + 1,
      row_data: { summary: '字'.repeat(100), _coverage: { from: index + 1, to: index + 1 } },
    })),
    { id: 'w-rolling', table_id: 'rp_summary', contact_id: 'rp:test', is_active: true, sort_order: 0, row_data: { summary: '滚'.repeat(5000), _summary_compaction: { level: 'rolling' } } },
  ];
  const check = async (charLimit) => {
    const adapter = createMemoryTableSummaryCompactionAdapter({
      memoryTableStore: { getMemories: async () => rows },
      memoryTemplateStore: { getTemplates: async () => [{ id: 'tpl' }] },
      sessionId: 'rp:test', place: 'writing', rowLimit: 4, trigger: 'chars', charLimit,
    });
    return adapter.shouldCompact({ items: await adapter.getItems() });
  };
  assert.equal(await check(299), true, '300 字超过 299');
  assert.equal(await check(300), false, '未超过不压缩；滚动摘要的 5000 字不计入，满 4 条也不触发');
  console.log('ok - memory table summary compaction can trigger by unmerged summary characters');
}

{
  // 写入顺序：先建新的滚动摘要，再停用旧行；开始写入后不理会中止，避免留下「旧行已停用、新总结没建」。
  const makeRows = () => [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `w-${index + 1}`, table_id: 'rp_summary', contact_id: 'rp:test', is_active: true, sort_order: index + 3,
      row_data: { summary: `摘要${index + 1}`, _coverage: { from: index + 3, to: index + 3 } },
    })),
    { id: 'w-rolling', table_id: 'rp_summary', contact_id: 'rp:test', is_active: true, sort_order: 2, row_data: { summary: '旧滚动', _coverage: { from: 1, to: 2 }, _summary_compaction: { level: 'rolling' } } },
  ];
  const makeStore = (rowsRef, log, controller = null) => ({
    async getMemories() { return rowsRef; },
    async createMemory(payload) {
      log.push(`create`);
      controller?.abort();
      const created = { ...payload, id: 'w-new' };
      rowsRef.push(created);
      return created;
    },
    async updateMemory(payload) {
      log.push(`off:${payload.id}`);
      const row = rowsRef.find(item => item.id === payload.id);
      if (row) row.is_active = payload.is_active;
    },
  });
  const run = async (controller, abortBefore = false) => {
    const rowsRef = makeRows();
    const log = [];
    const adapter = createMemoryTableSummaryCompactionAdapter({
      memoryTableStore: makeStore(rowsRef, log, abortBefore ? null : controller),
      memoryTemplateStore: { getTemplates: async () => [{ id: 'tpl' }] },
      sessionId: 'rp:test',
      place: 'writing',
    });
    const items = await adapter.getItems();
    if (abortBefore) controller.abort();
    let error = null;
    try {
      await adapter.persist({ text: '【关键事件】\n• 新', raw: '', items, keepItems: items.slice(-2), signal: controller.signal });
    } catch (err) {
      error = err;
    }
    return { log, error, rowsRef };
  };

  const midway = await run(new AbortController());
  assert.equal(midway.error, null, '已开始写入时中止不应打断');
  assert.equal(midway.log[0], 'create', '必须先建新的滚动摘要');
  assert.deepEqual(midway.log.slice(1).sort(), ['off:w-1', 'off:w-2', 'off:w-rolling']);
  assert.equal(midway.rowsRef.find(row => row.id === 'w-new')?.is_active, true);

  const before = await run(new AbortController(), true);
  assert.ok(before.error, '写入前中止应放弃');
  assert.deepEqual(before.log, [], '写入前中止不得改动任何行');
  console.log('ok - compaction persist creates the new rolling summary before archiving old rows and ignores late aborts');
}
