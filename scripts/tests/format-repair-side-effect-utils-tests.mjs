import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  FORMAT_FUNCTION_BLOCK_KINDS,
  buildFormatFunctionExecutionLedger,
  buildFormatFunctionExecutionText,
  buildFormatFunctionSideEffectPlan,
  extractFormatFunctionBlocks,
  replaceReusedFormatFunctionBlocks,
  validateFormatRepairFunctionPayloads,
} from '../../src/scripts/ui/chat/format-repair-side-effect-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('extractFormatFunctionBlocks assigns stable kind ordinals to duplicate blocks', () => {
  const blocks = extractFormatFunctionBlocks([
    '<image_prompt>same</image_prompt>',
    '<image_prompt>same</image_prompt>',
    '<UpdateVariable>_.set("a", 1)</UpdateVariable>',
    '<tableEdit>insertRow(0, {"a":1})</tableEdit>',
  ].join('\n'));
  assert.deepEqual(blocks.map(block => block.identity), [
    'image_prompt:1',
    'image_prompt:2',
    'update_variable:1',
    'table_edit:1',
  ]);
  assert.equal(blocks.every(block => block.valid), true);
});

test('unchanged image variable and table blocks are reused instead of replayed', () => {
  const source = [
    '<image_prompt>portrait</image_prompt>',
    '<UpdateVariable>_.set("mood", "calm")</UpdateVariable>',
    '<tableEdit>insertRow(0, {"name":"Alice"})</tableEdit>',
  ].join('\n');
  const plan = buildFormatFunctionSideEffectPlan({
    originalText: source,
    candidateText: source,
  });
  assert.deepEqual(plan.executeKinds, []);
  assert.equal(plan.reuseEntries.length, 3);
});

test('repairing only a dangling table close executes table once and reuses earlier blocks', () => {
  const original = [
    '<image_prompt>portrait</image_prompt>',
    '<UpdateVariable>_.set("mood", "calm")</UpdateVariable>',
    '<tableEdit>',
    'insertRow(0, {"name":"Alice"})',
  ].join('\n');
  const candidate = `${original}\n</tableEdit>`;
  const validation = validateFormatRepairFunctionPayloads({
    originalText: original,
    candidateText: candidate,
  });
  const plan = buildFormatFunctionSideEffectPlan({
    originalText: original,
    candidateText: candidate,
  });
  assert.equal(validation.ok, true);
  assert.deepEqual(plan.executeKinds, [FORMAT_FUNCTION_BLOCK_KINDS.tableEdit]);
  assert.equal(plan.reuseEntries.length, 2);
  assert.match(buildFormatFunctionExecutionText(plan, FORMAT_FUNCTION_BLOCK_KINDS.tableEdit), /insertRow/);
});

test('format repair rejects payload modification and valid block deletion', () => {
  const original = [
    '<image_prompt>portrait</image_prompt>',
    '<UpdateVariable>_.set("mood", "calm")</UpdateVariable>',
  ].join('\n');
  const modified = validateFormatRepairFunctionPayloads({
    originalText: original,
    candidateText: '<image_prompt>landscape</image_prompt>',
  });
  assert.equal(modified.ok, false);
  assert.deepEqual(modified.violations.map(item => item.code), [
    'function_payload_modified',
    'function_block_deleted',
  ]);
});

test('format repair can wrap an existing exact payload but cannot invent a new one', () => {
  const original = 'insertRow(0, {"name":"Alice"})';
  const wrapped = validateFormatRepairFunctionPayloads({
    originalText: original,
    candidateText: `<tableEdit>${original}</tableEdit>`,
  });
  const invented = validateFormatRepairFunctionPayloads({
    originalText: '普通正文',
    candidateText: '<tableEdit>insertRow(0, {"name":"Alice"})</tableEdit>',
  });
  assert.equal(wrapped.ok, true);
  assert.equal(invented.ok, false);
  assert.equal(invented.violations[0].code, 'function_payload_added');
});

test('execution ledger records identity fingerprint and reuse without storing payload text', () => {
  const source = '<image_prompt>portrait</image_prompt>';
  const plan = buildFormatFunctionSideEffectPlan({
    originalText: source,
    candidateText: source,
  });
  const ledger = buildFormatFunctionExecutionLedger({
    plan,
    turnId: 'turn:1',
    messageId: 'm1',
    at: 1000,
  });
  assert.equal(ledger[0].blockIdentity, 'image_prompt:1');
  assert.equal(ledger[0].executionStatus, 'reused');
  assert.match(ledger[0].payloadFingerprint, /^fnv1a32:/);
  assert.equal(JSON.stringify(ledger).includes('portrait'), false);
});

test('reused function blocks can be replaced only in the render copy', () => {
  const source = 'before\n<image_prompt>portrait</image_prompt>\nafter';
  const plan = buildFormatFunctionSideEffectPlan({
    originalText: source,
    candidateText: source,
  });
  const rendered = replaceReusedFormatFunctionBlocks(
    source,
    plan,
    FORMAT_FUNCTION_BLOCK_KINDS.imagePrompt,
    () => '[img-existing]',
  );
  assert.equal(rendered, 'before\n[img-existing]\nafter');
  assert.equal(source.includes('<image_prompt>'), true);
});

test('app edit writeback executes an added tableEdit through the in-scope memory handler', async () => {
  // 回归：executeFormatFunctionSideEffectPlan 在 handleSend 外层，曾调用只存在于 handleSend 内的
  // handleMemoryEditsFromRaw，编辑气泡后新增的 tableEdit 抛 ReferenceError 被吞掉，记忆表格不更新。
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const resolveFormatFunctionEffectTarget = ');
  const end = app.indexOf('const applyRepairedProtocolTextToChat = ', start);
  assert.ok(start >= 0 && end > start, 'app seam: format function side-effect executor');
  const tableEdit = '<tableEdit>\n{"action":"insert","table_id":"rp_important_people","data":{"name":"林念初"}}\n</tableEdit>';
  const message = { id: 'm1', role: 'assistant', rawOriginal: `正文\n\n${tableEdit}`, meta: {} };
  const memoryCalls = [];
  const warnings = [];
  const sandbox = {
    FORMAT_FUNCTION_BLOCK_KINDS,
    buildFormatFunctionExecutionLedger,
    uiMode: 'rp',
    chatStore: { findMessage: id => (id === 'm1' ? message : null), updateMessage: () => message },
    contactsStore: { getContact: () => null },
    logger: { warn: (...args) => warnings.push(args) },
    resolveMessageTimelineTurnNumber: () => 3,
    handleMemoryEditsFromRawForRuntime: async (raw, options) => {
      memoryCalls.push({ raw, options });
      return { actions: [{ action: 'insert' }] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${app.slice(start, end)}\nglobalThis.execute = executeFormatFunctionSideEffectPlan;`, sandbox);
  const plan = buildFormatFunctionSideEffectPlan({ originalText: '正文', candidateText: message.rawOriginal });
  const results = await sandbox.execute({
    plan,
    capturedMessages: [{ messageId: 'm1', targetSessionId: 'rp:persona_a' }],
    fallbackSessionId: 'rp:persona_a',
    turnId: 'edit:m1',
  });
  assert.deepEqual(warnings, [], 'side effect must not fail');
  assert.equal(results['table_edit:1'].status, 'succeeded');
  assert.equal(memoryCalls.length, 1);
  assert.equal(memoryCalls[0].raw, tableEdit);
  assert.equal(memoryCalls[0].options.sessionId, 'rp:persona_a');
  assert.equal(memoryCalls[0].options.memoryPlace, 'writing');
  assert.equal(memoryCalls[0].options.force, true);
  assert.equal(memoryCalls[0].options.timelineMessageId, 'm1');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
  }
}
if (failed) process.exitCode = 1;
