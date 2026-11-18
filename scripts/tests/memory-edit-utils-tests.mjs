import assert from 'node:assert/strict';

import {
  buildMemoryConfirmText,
  cloneMemoryUpdateEntry,
  extractSummaryBlock,
  normalizeMemoryCellValue,
  normalizeTableRowData,
  rowDataEquals,
} from '../../src/scripts/ui/chat/memory-edit-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('extractSummaryBlock removes the last summary details block and keeps English words in the summary', () => {
  const result = extractSummaryBlock(
    '正文A\n<details><summary>摘要</summary>Alpha 这是 summary 123</details>\n正文B',
  );

  assert.deepEqual(result, {
    text: '正文A\n\n正文B',
    summary: 'Alpha 这是 summary 123',
  });
});

test('extractSummaryBlock keeps names and reads the English Summary label', () => {
  assert.equal(
    extractSummaryBlock('好的。<details><summary>摘要</summary>Alice 在 Starbucks 用 iPhone 给 Bob 发了消息。</details>').summary,
    'Alice 在 Starbucks 用 iPhone 给 Bob 发了消息。',
  );
  const english = extractSummaryBlock('Sure.\n<details><summary>Summary</summary>\nAlice told Bob she will visit Tokyo.\n</details>');
  assert.deepEqual(english, { text: 'Sure.', summary: 'Alice told Bob she will visit Tokyo.' });
});

test('buildMemoryConfirmText renders readable action lines with truncation notice', () => {
  const tableById = new Map([
    ['memory', { name: '记忆表' }],
  ]);
  const text = buildMemoryConfirmText(
    [
      { action: 'insert', tableId: 'memory', data: { name: 'Alice', note: 'hello' } },
      { action: 'delete', tableId: 'memory', rowIndex: 3 },
    ],
    tableById,
    ['memory'],
    { maxLines: 1 },
  );

  assert.equal(
    text,
    '检测到记忆表格写入指令：\n1. insert -> 记忆表 (memory): {"name":"Alice","note":"hello"}\n... 还有 1 条\n继续执行这些写表指令吗？',
  );
});

test('normalizeTableRowData maps ids, names, and column indexes through shared cell normalization', () => {
  const result = normalizeTableRowData(
    {
      title: '  标题  ',
      note: { a: 1 },
      2: true,
      ignored: 'x',
    },
    [
      { id: 'title', name: '标题' },
      { id: 'note', name: '备注' },
      { id: 'enabled', name: '启用' },
    ],
  );

  assert.deepEqual(result, {
    title: '标题',
    note: '{"a":1}',
    enabled: true,
  });
});

test('cloneMemoryUpdateEntry trims oversized text fields and deep-clones nested payloads', () => {
  const raw = 'x'.repeat(20005);
  const entry = cloneMemoryUpdateEntry({
    at: 1,
    mode: 'full',
    sessionId: 'session-a',
    tableEditRaw: raw,
    raw,
    requestPrompt: raw,
    actions: [{ id: 1 }],
    rollback: { tables: [{ id: 't1' }] },
    rollbackAt: 2,
  });

  assert.equal(entry.tableEditRaw.endsWith('\n...[truncated]'), true);
  assert.equal(entry.raw.endsWith('\n...[truncated]'), true);
  assert.equal(entry.requestPrompt.endsWith('\n...[truncated]'), true);
  assert.notEqual(entry.actions, null);
  assert.deepEqual(entry.actions, [{ id: 1 }]);
  assert.deepEqual(entry.rollback, { tables: [{ id: 't1' }] });
});

test('rowDataEquals compares normalized values instead of raw shapes', () => {
  assert.equal(
    rowDataEquals(
      { a: ' 1 ', b: { x: true }, c: null },
      { a: '1', b: '{"x":true}', c: '' },
    ),
    true,
  );
  assert.equal(
    rowDataEquals(
      { a: '1' },
      { a: '2' },
    ),
    false,
  );
});

test('normalizeMemoryCellValue keeps primitive booleans/numbers and stringifies objects', () => {
  assert.equal(normalizeMemoryCellValue(true), true);
  assert.equal(normalizeMemoryCellValue(3), 3);
  assert.equal(normalizeMemoryCellValue('  hi  '), 'hi');
  assert.equal(normalizeMemoryCellValue({ ok: 1 }), '{"ok":1}');
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
