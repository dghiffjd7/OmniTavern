import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildMaidWorldbookComparisonContext, resolveMaidWorldbookComparison } from '../../src/scripts/agent/maid-worldbook-comparison.js';
import { createWorldbookCompareTools, WORLDBOOK_COMPARE_TOOL } from '../../src/scripts/agent/tools/worldbook-compare-tools.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-comparison-observations.json', import.meta.url)));
const restore = record => record.steps.map(({ outputRef, ...step }) => ({ ...step, output: structuredClone(captured.snapshots[outputRef]) }));
const entry = (id, title, content = id) => ({ id, title, content, contentLength: content.length, contentTruncated: false, contentSource: 'content' });
const read = (index, id, entries, extra = {}) => ({ index, toolName: 'worldbook.read', status: 'succeeded', args: { worldbookId: id, includeContent: true },
  output: { ok: true, id, name: id, contentMode: 'content', entryCount: entries.length, returnedEntryCount: entries.length, truncated: false, entries }, ...extra });

for (const record of captured.cases) test(`${record.model}: comparison preserves each captured source instead of blending facts`, () => {
  const steps = restore(record), original = JSON.stringify(steps);
  const result = resolveMaidWorldbookComparison({ steps });
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

test('eligibility comes only from actual reads of two or more books, not from request wording', () => {
  const steps = [read(1, 'a', [entry('a1', 'Shared')]), read(2, 'b', [entry('b1', 'Shared')])];
  assert.equal(buildMaidWorldbookComparisonContext({ steps }).eligible, true);
  assert.equal(buildMaidWorldbookComparisonContext({ steps: steps.slice(0, 1) }).eligible, false);
  assert.equal(resolveMaidWorldbookComparison({ steps: steps.slice(0, 1) }).status, 'not_applicable');
});

test('only actual book IDs select two books; a copy name never sets direction', () => {
  const steps = [read(1, 'a-copy', [entry('a1', 'Same', 'A')]), read(2, 'b-original', [entry('b1', 'Same', 'B')]), read(3, 'c', [entry('c1', 'Other', 'C')])];
  assert.equal(resolveMaidWorldbookComparison({ steps }).status, 'needs_selection');
  for (const comparison of [
    { kind: 'worldbook_entries', leftBookId: 'unknown', rightBookId: 'b-original' },
    { kind: 'worldbook_entries', leftBookId: 'a-copy', rightBookId: 'a-copy' },
    { kind: 'worldbook_entries', leftBookId: 'a-copy', rightBookId: 'b-original', targetBookId: 'c' },
  ]) assert.equal(resolveMaidWorldbookComparison({ steps, comparison }).status, 'needs_selection');
  const comparison = { kind: 'worldbook_entries', leftBookId: 'a-copy', rightBookId: 'b-original', targetBookId: 'b-original' };
  const result = resolveMaidWorldbookComparison({ steps, comparison });
  assert.equal(result.status, 'ready');
  assert.equal(result.report.targetBookId, 'b-original');
  assert.equal(resolveMaidWorldbookComparison({ steps: steps.slice(0, 2) }).report.targetBookId, null);
});

test('duplicate or empty titles remain ambiguous instead of invented pairs or unique entries', () => {
  const steps = [read(1, 'a', [entry('a1', 'Same'), entry('a2', 'Same'), entry('a3', '')]), read(2, 'b', [entry('b1', 'Same'), entry('b2', '')])];
  const result = resolveMaidWorldbookComparison({ steps });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.report.pairs.length, 0);
  assert.equal(result.report.ambiguous.length, 2);
  assert.equal(result.report.leftOnly.length + result.report.rightOnly.length, 0);
});

test('partial content and filtered inventories cannot establish complete or one-sided absence', () => {
  const a = read(1, 'a', [entry('a1', 'Shared', 'A'), entry('a2', 'Only A', 'AA')]);
  const b = read(2, 'b', [entry('b1', 'Shared', 'B')]);
  b.args.query = 'Shared'; b.output.entryCount = 9;
  let result = resolveMaidWorldbookComparison({ steps: [a, b] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.report.leftOnly.length, 0);
  assert.ok(result.report.unverified.some(group => group.reason === 'opposite_inventory_incomplete'));
  b.output.entries[0].contentLength = 20; b.output.entries[0].contentTruncated = true;
  result = resolveMaidWorldbookComparison({ steps: [a, b] });
  assert.equal(result.report.pairs.length, 0);
  assert.ok(result.report.unverified.some(group => group.reason === 'content_incomplete'));
});

test('scope/write invalidation and failed refresh remain authoritative', () => {
  const steps = [read(1, 'a', [entry('a1', 'Same', 'A')]), read(2, 'b', [entry('b1', 'Same', 'B')])];
  for (const boundary of [
    { toolName: 'worldbook.create', status: 'failed', output: { ok: false, worldbookSaved: true } },
    { toolName: 'persona.switch', status: 'succeeded', output: { ok: true } },
    { toolName: 'worldbook.read', status: 'failed', output: { ok: false, reason: 'permission_denied' } },
  ]) assert.equal(resolveMaidWorldbookComparison({ steps: [...steps, boundary] }).status, 'not_applicable');
});

test('visible report is bounded, marks omission, and never cuts a conflict quotation in half', () => {
  const a = read(1, 'a', [entry('a1', 'Large', 'A'.repeat(3000))]);
  const b = read(2, 'b', [entry('b1', 'Large', 'B'.repeat(3000))]);
  const result = resolveMaidWorldbookComparison({ steps: [a, b], maxMessageChars: 800 });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.message.length <= 800);
  assert.equal(result.report.presentation.complete, false);
  assert.ok(result.report.presentation.omittedItems > 0);
  assert.ok(!result.message.includes('A'.repeat(50)) && !result.message.includes('B'.repeat(50)));
  assert.ok(result.message.includes('未完整显示'));
  const same = [read(1, 'a', [entry('a1', 'Same', 'Body')]), read(2, 'b', [entry('b1', 'Same', 'Body')])];
  const short = resolveMaidWorldbookComparison({ steps: same, maxMessageChars: 100 });
  assert.equal(short.status, 'incomplete');
  assert.equal(short.report.presentation.summaryOmitted, true);
  assert.equal(short.report.presentation.complete, false);
  assert.ok(short.message.length <= 100);
  const selection = resolveMaidWorldbookComparison({ steps: [...same, read(3, 'c', [])], maxMessageChars: 10 });
  assert.equal(selection.status, 'needs_selection');
  assert.ok(selection.message.length <= 10);
});

// 11/21：比较报告改成模型自己调用的只读工具。录下的 D06 两轮里读取步骤的功能是 worldbook.read（不是 worldbook.compare），
// 工具自己读两本书的全文，所以不靠模型先前选了什么功能。
const fixtureReader = record => {
  const books = new Map();
  for (const step of restore(record)) {
    if (step.toolName === 'worldbook.read' && step.output?.contentMode === 'content') books.set(step.output.id, step.output);
  }
  const calls = [];
  const executeTool = async (name, args, context) => {
    calls.push({ name, args, context });
    const book = books.get(args.worldbookId);
    return book ? { toolName: name, status: 'succeeded', result: structuredClone(book) }
      : { toolName: name, status: 'succeeded', result: { ok: false, reason: 'worldbook_not_found', worldbookId: args.worldbookId } };
  };
  const card = [...books.values()][0]?.targetSelectionEvidence?.currentCard?.personaId;
  return { executeTool, calls, context: { roleCardId: card }, tool: createWorldbookCompareTools({ executeTool })[0] };
};

for (const record of captured.cases) test(`${record.model}: the comparison tool reads both books itself and returns the APP report`, async () => {
  const { tool, calls, context } = fixtureReader(record);
  const result = await tool.execute({ leftWorldbookId: '奇幻大陆', rightWorldbookId: '奇幻大陆(副本)' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual([result.left.id, result.right.id], ['奇幻大陆', '奇幻大陆(副本)']);
  assert.equal(result.same.length, 6);
  assert.equal(result.different.length, 2);
  assert.deepEqual([result.leftOnly.length, result.rightOnly.length].sort(), [2, 4]);
  assert.equal(result.completeComparison, true);
  assert.equal(result.targetWorldbookId, null);
  assert.deepEqual(calls.map(call => [call.name, call.args.worldbookId, call.args.includeContent]),
    [['worldbook.read', '奇幻大陆', true], ['worldbook.read', '奇幻大陆(副本)', true]]);
  // 同名不同的条目，报告正文附双方原文
  const report = resolveMaidWorldbookComparison({ steps: restore(record), context,
    comparison: { kind: 'worldbook_entries', leftBookId: '奇幻大陆', rightBookId: '奇幻大陆(副本)' } }).report;
  for (const pair of report.pairs.filter(item => item.relation === 'different')) {
    for (const side of [pair.left, pair.right]) assert.ok(result.message.includes(side.content), side.content);
  }
  assert.ok(result.message.length <= 2200);
});

test('the comparison tool records a chosen target only among the two compared books', async () => {
  const { tool, context } = fixtureReader(captured.cases[1]);
  const chosen = await tool.execute({ leftWorldbookId: '奇幻大陆(副本)', rightWorldbookId: '奇幻大陆', targetWorldbookId: '奇幻大陆' }, context);
  assert.equal(chosen.targetWorldbookId, '奇幻大陆');
  assert.match(chosen.message, /这不是写入授权/);
  assert.deepEqual(await tool.execute({ leftWorldbookId: '奇幻大陆', rightWorldbookId: '奇幻大陆(副本)', targetWorldbookId: '别的书' }, context),
    { ok: false, reason: 'target_not_compared', targetWorldbookId: '别的书' });
});

test('the comparison tool reports missing books, same-book requests and another card\'s reads as failures', async () => {
  const { tool, context } = fixtureReader(captured.cases[0]);
  assert.deepEqual(await tool.execute({ leftWorldbookId: '奇幻大陆', rightWorldbookId: '不存在' }, context),
    { ok: false, reason: 'worldbook_not_found', worldbookId: '不存在' });
  assert.equal((await tool.execute({ leftWorldbookId: '奇幻大陆', rightWorldbookId: '奇幻大陆' }, context)).reason, 'same_worldbook');
  assert.equal((await tool.execute({ leftWorldbookId: '奇幻大陆', rightWorldbookId: '奇幻大陆(副本)' }, { roleCardId: 'another-card' })).ok, false);
  assert.equal((await createWorldbookCompareTools({})[0].execute({ leftWorldbookId: 'a', rightWorldbookId: 'b' })).reason, 'worldbook_reader_unavailable');
});

test('the comparison tool is registered read-only and runs without a confirmation card', async () => {
  const { executeTool, context } = fixtureReader(captured.cases[0]);
  const registry = createAgentToolRegistry({ logger: { warn() {} } });
  registry.registerMany(createWorldbookCompareTools({ executeTool }));
  assert.equal(registry.get(WORLDBOOK_COMPARE_TOOL).capabilities.write, false);
  const output = await registry.executeTool(WORLDBOOK_COMPARE_TOOL, { leftWorldbookId: '奇幻大陆', rightWorldbookId: '奇幻大陆(副本)' }, {
    ...context, requestToolConfirmation: () => assert.fail('a read-only comparison asks for no confirmation'),
  });
  assert.equal(output.status, 'succeeded');
  assert.equal(output.result.status, 'ready');
});
