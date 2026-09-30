import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildMaidWorldbookComparisonContext, resolveMaidWorldbookComparison } from '../../src/scripts/agent/maid-worldbook-comparison.js';

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-comparison-observations.json', import.meta.url)));
const restore = record => record.steps.map(({ outputRef, ...step }) => ({ ...step, output: structuredClone(captured.snapshots[outputRef]) }));
const input = '比较两本世界书并提出合并方案';
const entry = (id, title, content = id) => ({ id, title, content, contentLength: content.length, contentTruncated: false, contentSource: 'content' });
const read = (index, id, entries, extra = {}) => ({ index, toolName: 'worldbook.read', status: 'succeeded', args: { worldbookId: id, includeContent: true },
  output: { ok: true, id, name: id, contentMode: 'content', entryCount: entries.length, returnedEntryCount: entries.length, truncated: false, entries }, ...extra });

for (const record of captured.cases) test(`${record.model}: comparison preserves each captured source instead of blending facts`, () => {
  const steps = restore(record), original = JSON.stringify(steps);
  const result = resolveMaidWorldbookComparison({ input, steps });
  assert.equal(result.status, 'ready');
  assert.equal(result.report.readOnly, true);
  assert.equal(result.report.targetBookId, null);
  assert.equal(result.report.pairs.filter(pair => pair.relation === 'same').length, 6);
  const conflicts = result.report.pairs.filter(pair => pair.relation === 'different');
  assert.equal(conflicts.length, 2);
  assert.deepEqual([result.report.leftOnly.length, result.report.rightOnly.length].sort(), [2, 4]);
  for (const pair of conflicts) for (const source of [pair.left, pair.right]) {
    const step = steps.find(step => step.index === source.sourceStep);
    const actual = step.output.entries.find(entry => entry.id === source.entryId);
    assert.equal(step.output.id, source.bookId);
    assert.equal(source.content, actual.content);
    assert.ok(result.message.includes(actual.content), 'both unmodified conflict bodies must be visible');
  }
  assert.ok(result.message.includes('APP'));
  assert.ok(result.message.length <= 2200);
  assert.equal(JSON.stringify(steps), original);
});

test('only explicit positive comparison requests qualify; copy names and chat do not', () => {
  const steps = [read(1, 'a', [entry('a1', 'Shared')]), read(2, 'b', [entry('b1', 'Shared')])];
  for (const request of ['把山海录的副本合并回去', '请将旧副本并回原本', 'Compare these two worldbooks', 'Please merge the copies']) {
    assert.equal(buildMaidWorldbookComparisonContext({ input: request, steps }).eligible, true, request);
  }
  for (const request of ['这个副本挺好看', '合并是什么意思', '如何合并世界书', '把副本合并回去，不合并了', '不要比较世界书', "Don't merge the copies", '取消']) {
    assert.equal(buildMaidWorldbookComparisonContext({ input: request, steps }).eligible, false, request);
  }
});

test('knowledge and narrative suffixes do not publish a comparison', () => {
  const steps = [read(1, 'a', [entry('a1', 'Shared')]), read(2, 'b', [entry('b1', 'Shared')])];
  for (const input of ['合并是什么意思', '合并后的世界书真好看', '比较好看', '你好，合并后的世界书真好看']) {
    assert.equal(resolveMaidWorldbookComparison({ input, steps }).status, 'not_applicable', input);
  }
});

test('automatic presentation requires an explicit merge request that references observed worldbooks', () => {
  const steps = restore(captured.cases[0]);
  const observed = steps.find(step => step.toolName === 'worldbook.read' && step.output?.name)?.output;
  assert.ok(observed?.id && observed?.name);
  for (const input of ['比较小雪和Luna的人设', '比较两本世界书', '合并这两位联系人', 'Please merge the copies']) {
    assert.equal(resolveMaidWorldbookComparison({ input, steps }).autoPresentEligible, false, input);
  }
  for (const input of ['合并这两本世界书', `把${observed.name}的副本合并回去`, `Please merge ${observed.id} with its copy`]) {
    assert.equal(resolveMaidWorldbookComparison({ input, steps }).autoPresentEligible, true, input);
  }
  const shortIds = [read(1, 'a', [entry('a1', 'Shared')]), read(2, 'b', [entry('b1', 'Shared')])];
  assert.equal(resolveMaidWorldbookComparison({ input: 'merge characters', steps: shortIds }).autoPresentEligible, false);
  assert.equal(resolveMaidWorldbookComparison({ input: '把世界书合并回去，不合并了', steps }).autoPresentEligible, false);
});

test('only actual book IDs select two books; a copy name never sets direction', () => {
  const steps = [read(1, 'a-copy', [entry('a1', 'Same', 'A')]), read(2, 'b-original', [entry('b1', 'Same', 'B')]), read(3, 'c', [entry('c1', 'Other', 'C')])];
  assert.equal(resolveMaidWorldbookComparison({ input, steps }).status, 'needs_selection');
  for (const comparison of [
    { kind: 'worldbook_entries', leftBookId: 'unknown', rightBookId: 'b-original' },
    { kind: 'worldbook_entries', leftBookId: 'a-copy', rightBookId: 'a-copy' },
    { kind: 'worldbook_entries', leftBookId: 'a-copy', rightBookId: 'b-original', targetBookId: 'c' },
  ]) assert.equal(resolveMaidWorldbookComparison({ input, steps, comparison }).status, 'needs_selection');
  const comparison = { kind: 'worldbook_entries', leftBookId: 'a-copy', rightBookId: 'b-original', targetBookId: 'b-original' };
  const result = resolveMaidWorldbookComparison({ input, steps, comparison });
  assert.equal(result.status, 'ready');
  assert.equal(result.report.targetBookId, 'b-original');
  assert.equal(resolveMaidWorldbookComparison({ input, steps: steps.slice(0, 2) }).report.targetBookId, null);
});

test('duplicate or empty titles remain ambiguous instead of invented pairs or unique entries', () => {
  const steps = [read(1, 'a', [entry('a1', 'Same'), entry('a2', 'Same'), entry('a3', '')]), read(2, 'b', [entry('b1', 'Same'), entry('b2', '')])];
  const result = resolveMaidWorldbookComparison({ input, steps });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.report.pairs.length, 0);
  assert.equal(result.report.ambiguous.length, 2);
  assert.equal(result.report.leftOnly.length + result.report.rightOnly.length, 0);
});

test('partial content and filtered inventories cannot establish complete or one-sided absence', () => {
  const a = read(1, 'a', [entry('a1', 'Shared', 'A'), entry('a2', 'Only A', 'AA')]);
  const b = read(2, 'b', [entry('b1', 'Shared', 'B')]);
  b.args.query = 'Shared'; b.output.entryCount = 9;
  let result = resolveMaidWorldbookComparison({ input, steps: [a, b] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.report.leftOnly.length, 0);
  assert.ok(result.report.unverified.some(group => group.reason === 'opposite_inventory_incomplete'));
  b.output.entries[0].contentLength = 20; b.output.entries[0].contentTruncated = true;
  result = resolveMaidWorldbookComparison({ input, steps: [a, b] });
  assert.equal(result.report.pairs.length, 0);
  assert.ok(result.report.unverified.some(group => group.reason === 'content_incomplete'));
});

test('scope/write invalidation and failed refresh remain authoritative', () => {
  const steps = [read(1, 'a', [entry('a1', 'Same', 'A')]), read(2, 'b', [entry('b1', 'Same', 'B')])];
  for (const boundary of [
    { toolName: 'worldbook.create', status: 'failed', output: { ok: false, worldbookSaved: true } },
    { toolName: 'persona.switch', status: 'succeeded', output: { ok: true } },
    { toolName: 'worldbook.read', status: 'failed', output: { ok: false, reason: 'permission_denied' } },
  ]) assert.equal(resolveMaidWorldbookComparison({ input, steps: [...steps, boundary] }).status, 'not_applicable');
});

test('visible report is bounded, marks omission, and never cuts a conflict quotation in half', () => {
  const a = read(1, 'a', [entry('a1', 'Large', 'A'.repeat(3000))]);
  const b = read(2, 'b', [entry('b1', 'Large', 'B'.repeat(3000))]);
  const result = resolveMaidWorldbookComparison({ input, steps: [a, b], maxMessageChars: 800 });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.message.length <= 800);
  assert.equal(result.report.presentation.complete, false);
  assert.ok(result.report.presentation.omittedItems > 0);
  assert.ok(!result.message.includes('A'.repeat(50)) && !result.message.includes('B'.repeat(50)));
  assert.ok(result.message.includes('未完整显示'));
  const same = [read(1, 'a', [entry('a1', 'Same', 'Body')]), read(2, 'b', [entry('b1', 'Same', 'Body')])];
  const short = resolveMaidWorldbookComparison({ input, steps: same, maxMessageChars: 100 });
  assert.equal(short.status, 'incomplete');
  assert.equal(short.report.presentation.summaryOmitted, true);
  assert.equal(short.report.presentation.complete, false);
  assert.ok(short.message.length <= 100);
  const selection = resolveMaidWorldbookComparison({ input, steps: [...same, read(3, 'c', [])], maxMessageChars: 10 });
  assert.equal(selection.status, 'needs_selection');
  assert.ok(selection.message.length <= 10);
});
