import assert from 'node:assert/strict';

import {
  buildSwipeMemorySnapshot,
  buildSwipeMemorySnapshotInputs,
  buildSwipeMemorySnapshotRows,
  replaceScopedMemoriesWithSnapshot,
} from '../../src/scripts/ui/chat/swipe-memory-snapshot-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('buildSwipeMemorySnapshotRows normalizes rows and clones row_data', () => {
  const source = [
    {
      id: 'row-2',
      template_id: 't-1',
      table_id: 'profile',
      row_data: { name: 'Alice' },
      is_active: false,
      is_pinned: 1,
      priority: '7',
      sort_order: '9',
    },
    {
      id: 'row-1',
      table_id: '',
      row_data: { ignored: true },
    },
  ];
  const rows = buildSwipeMemorySnapshotRows({
    rows: source,
    templateId: 'default-v1',
    scopeFields: { contact_id: 'chat-a', group_id: null },
    cloneValue: value => JSON.parse(JSON.stringify(value)),
  });

  assert.deepEqual(rows, [
    {
      id: 'row-2',
      template_id: 't-1',
      table_id: 'profile',
      contact_id: 'chat-a',
      group_id: null,
      row_data: { name: 'Alice' },
      is_active: false,
      is_pinned: true,
      priority: 7,
      sort_order: 9,
    },
  ]);

  source[0].row_data.name = 'Changed';
  assert.equal(rows[0].row_data.name, 'Alice');
});

test('buildSwipeMemorySnapshot wraps normalized rows into snapshot payload', () => {
  const snapshot = buildSwipeMemorySnapshot({
    rows: [{ id: 'row-1', table_id: 'summary', row_data: { note: 'x' } }],
    templateId: 'default-v1',
    scope: 'group',
    scopeFields: { contact_id: null, group_id: 'group:a' },
    cloneValue: value => JSON.parse(JSON.stringify(value)),
    capturedAt: 123,
  });

  assert.deepEqual(snapshot, {
    templateId: 'default-v1',
    scope: 'group',
    rows: [
      {
        id: 'row-1',
        template_id: 'default-v1',
        table_id: 'summary',
        contact_id: null,
        group_id: 'group:a',
        row_data: { note: 'x' },
        is_active: true,
        is_pinned: false,
        priority: 0,
        sort_order: 0,
      },
    ],
    capturedAt: 123,
  });
});

test('buildSwipeMemorySnapshotInputs prepares create payloads for snapshot restore', () => {
  const inputs = buildSwipeMemorySnapshotInputs({
    rows: [{ id: 'row-1', table_id: 'summary', row_data: { note: 'x' } }],
    templateId: 'default-v1',
    scopeFields: { contact_id: null, group_id: 'group:a' },
    cloneValue: value => JSON.parse(JSON.stringify(value)),
  });

  assert.deepEqual(inputs, [
    {
      id: 'row-1',
      template_id: 'default-v1',
      table_id: 'summary',
      contact_id: null,
      group_id: 'group:a',
      row_data: { note: 'x' },
      is_active: true,
      is_pinned: false,
      priority: 0,
      sort_order: 0,
    },
  ]);
});

test('replaceScopedMemoriesWithSnapshot uses batch APIs when available', async () => {
  const deleted = [];
  const created = [];
  const memoryTableStore = {
    async batchDeleteMemories(ids) {
      deleted.push(ids);
    },
    async batchCreateMemories(inputs) {
      created.push(inputs);
    },
  };

  const result = await replaceScopedMemoriesWithSnapshot({
    memoryTableStore,
    existingRows: [{ id: 'old-1' }, { id: 'old-2' }],
    snapshotRows: [{ id: 'new-1', table_id: 'summary', row_data: { note: 'x' } }],
    templateId: 'default-v1',
    scopeFields: { contact_id: 'chat-a', group_id: null },
    cloneValue: value => JSON.parse(JSON.stringify(value)),
  });

  assert.deepEqual(deleted, [['old-1', 'old-2']]);
  assert.deepEqual(created, [[
    {
      id: 'new-1',
      template_id: 'default-v1',
      table_id: 'summary',
      contact_id: 'chat-a',
      group_id: null,
      row_data: { note: 'x' },
      is_active: true,
      is_pinned: false,
      priority: 0,
      sort_order: 0,
    },
  ]]);
  assert.deepEqual(result.deletedIds, ['old-1', 'old-2']);
  assert.equal(result.inputs.length, 1);
});

test('replaceScopedMemoriesWithSnapshot falls back to per-row delete/create when batch fails', async () => {
  const deleted = [];
  const created = [];
  const memoryTableStore = {
    async batchDeleteMemories() {
      throw new Error('delete fail');
    },
    async deleteMemory(id) {
      deleted.push(id);
    },
    async batchCreateMemories() {
      throw new Error('create fail');
    },
    async createMemory(input) {
      created.push(input);
    },
  };

  await replaceScopedMemoriesWithSnapshot({
    memoryTableStore,
    existingRows: [{ id: 'old-1' }, { id: 'old-2' }],
    snapshotRows: [{ id: 'new-1', table_id: 'summary', row_data: { note: 'x' } }],
    templateId: 'default-v1',
    scopeFields: { contact_id: null, group_id: 'group:a' },
    cloneValue: value => JSON.parse(JSON.stringify(value)),
  });

  assert.deepEqual(deleted, ['old-1', 'old-2']);
  assert.deepEqual(created, [
    {
      id: 'new-1',
      template_id: 'default-v1',
      table_id: 'summary',
      contact_id: null,
      group_id: 'group:a',
      row_data: { note: 'x' },
      is_active: true,
      is_pinned: false,
      priority: 0,
      sort_order: 0,
    },
  ]);
});

test('replaceScopedMemoriesWithSnapshot skips rewriting when rows already match the snapshot', async () => {
  const calls = [];
  const memoryTableStore = {
    async batchDeleteMemories(ids) { calls.push(['delete', ids]); },
    async batchCreateMemories(inputs) { calls.push(['create', inputs.length]); },
  };
  const scopeFields = { contact_id: 'chat-a', group_id: null };
  // 数据库回读：带时间戳，row_data 键顺序与快照不同
  const existingRows = [
    { id: 'r1', template_id: 'default-v1', table_id: 'profile', contact_id: 'chat-a', group_id: null, row_data: { b: 2, a: 1 }, is_active: 1, is_pinned: 0, priority: 0, sort_order: 1, created_at: 100, updated_at: 200 },
    { id: 'r2', template_id: 'default-v1', table_id: 'profile', contact_id: 'chat-a', group_id: null, row_data: { a: 3 }, is_active: 1, is_pinned: 0, priority: 0, sort_order: 2, created_at: 101, updated_at: 300 },
  ];
  const snapshotRows = [
    { id: 'r1', table_id: 'profile', row_data: { a: 1, b: 2 }, is_active: true, is_pinned: false, priority: 0, sort_order: 1 },
    { id: 'r2', table_id: 'profile', row_data: { a: 3 }, is_active: true, is_pinned: false, priority: 0, sort_order: 2 },
  ];
  const same = await replaceScopedMemoriesWithSnapshot({ memoryTableStore, existingRows, snapshotRows, templateId: 'default-v1', scopeFields });
  assert.equal(same.unchanged, true);
  assert.deepEqual(calls, [], '内容一致时不删除也不重建');

  for (const changed of [
    snapshotRows.map((row, index) => (index === 1 ? { ...row, row_data: { a: 4 } } : row)),
    snapshotRows.map((row, index) => (index === 0 ? { ...row, is_pinned: true } : row)),
    snapshotRows.slice(0, 1),
    [...snapshotRows, { id: 'r3', table_id: 'profile', row_data: { a: 5 }, sort_order: 3 }],
    snapshotRows.map((row, index) => (index === 1 ? { ...row, id: 'r9' } : row)),
  ]) {
    calls.length = 0;
    const result = await replaceScopedMemoriesWithSnapshot({ memoryTableStore, existingRows, snapshotRows: changed, templateId: 'default-v1', scopeFields });
    assert.notEqual(result.unchanged, true);
    assert.deepEqual(calls[0], ['delete', ['r1', 'r2']], '有任何差异都照常删除重建');
  }

  calls.length = 0;
  const withBadRow = await replaceScopedMemoriesWithSnapshot({ memoryTableStore, existingRows: [...existingRows, { id: 'orphan', table_id: '' }], snapshotRows, templateId: 'default-v1', scopeFields });
  assert.notEqual(withBadRow.unchanged, true, '现有行里有快照不认的行时照常重建');
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
