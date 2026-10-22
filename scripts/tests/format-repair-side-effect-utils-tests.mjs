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
  resolveReusedImagePromptReplacements,
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

test('image tags pair by content so inserting one before existing tags only executes the new one', () => {
  const original = '甲\n<image_prompt>portrait</image_prompt>\n乙\n<image_prompt>garden</image_prompt>';
  const candidate = '<image_prompt>fairy</image_prompt>\n甲\n<image_prompt>portrait</image_prompt>\n乙\n<image_prompt>garden</image_prompt>';
  const plan = buildFormatFunctionSideEffectPlan({ originalText: original, candidateText: candidate });
  assert.deepEqual(plan.executeEntries.map(entry => entry.after.payload), ['fairy']);
  assert.deepEqual(plan.reuseEntries.map(entry => [entry.after.payload, entry.before.ordinal, entry.after.ordinal]), [['portrait', 1, 2], ['garden', 2, 3]]);
  const changed = buildFormatFunctionSideEffectPlan({ originalText: original, candidateText: original.replace('portrait', 'landscape') });
  assert.deepEqual(changed.executeEntries.map(entry => entry.after.payload), ['landscape']);
  assert.deepEqual(changed.reuseEntries.map(entry => entry.after.payload), ['garden']);
  const dangling = buildFormatFunctionSideEffectPlan({ originalText: '<image_prompt>portrait\n', candidateText: '<image_prompt>portrait\n</image_prompt>' });
  assert.deepEqual(dangling.executeEntries.map(entry => [entry.identity, entry.reason]), [['image_prompt:1', 'newly_valid_block']]);
});

test('app edit writeback generates images from the placeholders the edit put into the body', async () => {
  // 回归：执行步骤原本丢掉正文里的占位、只拿改动的标签重新排占位；正文里找不到对应占位时，
  // 回填会把只含标签的文本当成整条正文，正文被换成只剩图片。
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const resolveFormatFunctionEffectTarget = ');
  const end = app.indexOf('const applyRepairedProtocolTextToChat = ', start);
  const placeholders = [{ prompt: 'fairy', pendingToken: '[img-图片生成中]', tag: '<image_prompt>fairy</image_prompt>' }];
  const message = { id: 'm1', role: 'assistant', rawOriginal: '正文\n<image_prompt>fairy</image_prompt>', rawSource: '正文\n[img-图片生成中]', meta: { autoImagePromptPlaceholders: placeholders } };
  const scheduled = [];
  const sandbox = {
    FORMAT_FUNCTION_BLOCK_KINDS,
    buildFormatFunctionExecutionLedger,
    chatStore: { findMessage: id => (id === 'm1' ? message : null), updateMessage: () => message },
    logger: { warn: () => {} },
    autoImagePromptProcessedSourceIds: new Set(),
    getAutoImagePromptSourceKey: (sid, mid) => `${sid}:${mid}`,
    scheduleAutoImagePromptGenerationForMessage: (source, sid, options) => { scheduled.push({ source, options }); return true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${app.slice(start, end)}\nglobalThis.execute = executeFormatFunctionSideEffectPlan;`, sandbox);
  const run = () => sandbox.execute({
    plan: buildFormatFunctionSideEffectPlan({ originalText: '正文', candidateText: message.rawOriginal }),
    capturedMessages: [{ messageId: 'm1', targetSessionId: 'rp:persona_a' }],
    fallbackSessionId: 'rp:persona_a',
  });
  await run();
  assert.deepEqual(scheduled[0].source.meta.autoImagePromptPlaceholders, placeholders);
  delete message.meta.autoImagePromptPlaceholders;
  await run();
  const empty = scheduled[1].source.meta.autoImagePromptPlaceholders;
  assert.ok(Array.isArray(empty) && empty.length === 0, 'no placeholder in the body means nothing to generate');
  assert.match(app, /resolveReusedImagePromptReplacements\(\{/);
});

test('edit save keeps each unchanged image tag on its own image; a mere mention of <image_prompt> stays text', () => {
  // 回归（0.7.7）：构思里提到 <image_prompt>（没闭合）会被当成第 1 个生图块。
  // 没改到它时整段被换成图片；按标签序号取图时真正的标签取到空，图片消失。
  const kind = FORMAT_FUNCTION_BLOCK_KINDS.imagePrompt;
  const mention = '构思：适当位置输出 `<image_prompt>` 。\n';
  const tag = '<image_prompt>1girl, smile</image_prompt>';
  const original = `${mention}正文一。\n${tag}\n正文二。`;
  const placeholders = [{ prompt: '1girl, smile', pendingToken: '[img-图片生成中]' }];
  const save = (candidateText, options) => {
    const plan = buildFormatFunctionSideEffectPlan({ originalText: original, candidateText });
    const replacements = resolveReusedImagePromptReplacements({ plan, ...options });
    return replaceReusedFormatFunctionBlocks(candidateText, plan, kind, entry => replacements.get(entry));
  };
  const editAfterTag = `${mention}正文一。\n${tag}\n正文二改。`;
  assert.equal(save(editAfterTag, { imageTokens: ['[img-a.png]'], placeholders }), `${mention}正文一。\n[img-a.png]\n正文二改。`,
    '提到标签的那句原样保留，真正的标签换回原来的图');
  const editBeforeTag = `${mention}正文一改。\n${tag}\n正文二。`;
  assert.equal(save(editBeforeTag, { imageTokens: ['[img-a.png]'], placeholders }), `${mention}正文一改。\n[img-a.png]\n正文二。`);

  // 生图记录里存着标签原文：图片 token 已不在正文里（之前存坏了）也能找回；前面混进别的图时也不会拿错
  const assets = [
    { token: '[img-old.png]', prompt: 'style, old', generationParams: { imagePromptDocument: { blocks: [{ kind: 'scene', text: 'old prompt' }] } } },
    { token: '[img-b.png]', prompt: 'style, 1girl, smile', generationParams: { imagePromptDocument: { blocks: [{ kind: 'quality', text: 'best' }, { kind: 'scene', text: '1girl,  smile' }] } } },
  ];
  assert.equal(save(editAfterTag, { imageTokens: ['[img-old.png]'], generatedInlineImages: assets }), `${mention}正文一。\n[img-b.png]\n正文二改。`);
  assert.equal(save(editAfterTag, { imageTokens: [], generatedInlineImages: assets }), `${mention}正文一。\n[img-b.png]\n正文二改。`);

  // 同样的提示词按正文顺序各配各的；还在生成的占位照旧留着
  const twice = '<image_prompt>same</image_prompt>\n中\n<image_prompt>same</image_prompt>';
  const plan = buildFormatFunctionSideEffectPlan({ originalText: twice, candidateText: `前\n${twice}` });
  const replacements = resolveReusedImagePromptReplacements({ plan, imageTokens: ['[img-1.png]', '[img-图片生成中 2]'],
    placeholders: [{ prompt: 'same', pendingToken: '[img-图片生成中]' }, { prompt: 'same', pendingToken: '[img-图片生成中 2]' }] });
  assert.equal(replaceReusedFormatFunctionBlocks(`前\n${twice}`, plan, kind, entry => replacements.get(entry)), '前\n[img-1.png]\n中\n[img-图片生成中 2]');

  // 没有占位记录的旧消息：按闭合标签的序号取图（提到标签的那句不算）
  assert.equal(save(editAfterTag, { imageTokens: ['[img-a.png]'] }), `${mention}正文一。\n[img-a.png]\n正文二改。`);
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
