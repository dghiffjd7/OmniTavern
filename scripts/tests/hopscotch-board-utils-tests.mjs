import assert from 'node:assert/strict';
import { resolveHopscotchBoardSettings } from '../../src/scripts/ui/chat/hopscotch-settings-utils.js';

import {
  HOPSCOTCH_LIMITS,
  buildDefaultHopscotchBoard,
  compileBoardToLaneTasks,
  extractHouseReferences,
  findBodyRowIndex,
  getHopscotchHouseDisplayStatus,
  normalizeCustomHouseConfig,
  normalizeHopscotchBoard,
  validateHopscotchBoard,
} from '../../src/scripts/ui/chat/hopscotch-board-utils.js';

const codes = result => result.errors.map(err => err.code);
const custom = (id, config = {}) => ({ id, kind: 'custom_prompt', label: id, config });
const bodyRow = (fused = []) => ({ id: 'rb', houses: [{ id: 'body', kind: 'body', fused }] });

{
  for (const [childStatus, expected] of [['running', 'running'], ['succeeded', 'succeeded'], ['skipped', 'succeeded'], ['failed', 'partial'], ['cancelled', 'cancelled']]) {
    const state = { status: 'succeeded', childResults: [{ status: childStatus }] };
    assert.equal(getHopscotchHouseDisplayStatus(state), expected);
    assert.equal(state.status, 'succeeded', '显示子任务状态但不重写主产物交付状态');
  }
  assert.equal(getHopscotchHouseDisplayStatus({ status: 'failed', childResults: [{ status: 'succeeded' }] }), 'failed');
  console.log('ok - house display includes internal work without rewriting delivery status');
}

{
  const settings = { memoryEnabled: true, memoryStorageMode: 'table', memoryAutoExtract: true, memoryAutoExtractMode: 'inline', memoryTableEnabledChat: true, memoryTableEnabledWriting: false };
  const args = { settings, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'profile' }, autoImageEnabled: true };
  const writing = resolveHopscotchBoardSettings(args);
  const chat = resolveHopscotchBoardSettings({ ...args, place: 'chat' });
  assert.equal(writing.memory.storageMode, 'off');
  assert.equal(writing.replyCheck.enabled, false);
  assert.equal(writing.autoImage.enabled, true);
  assert.equal(chat.memory.storageMode, 'table');
  assert.equal(chat.replyCheck.enabled, true);
  assert.equal(chat.autoImage.enabled, false, '创意写作自动配图不泄露到聊天');
  assert.equal(resolveHopscotchBoardSettings({ settings: { ...settings, memoryEnabled: false } }).memory.storageMode, 'off');
  assert.equal(resolveHopscotchBoardSettings({ settings: { ...settings, memoryStorageMode: 'summary' } }).memory.storageMode, 'summary', '表格位置开关不禁用另一种摘要存储');
  assert.equal(settings.memoryEnabled, true, '解析不写回设置');
  console.log('ok - memory mode/place switches and chat-only review resolve without changing settings');
}

{
  const cfg = normalizeCustomHouseConfig({ modelMode: 'profile', modelProfileId: ' p1 ', includeContext: 'weird', recentMessageCount: 999, output: { mode: 'note', injectIntoBody: true } });
  assert.equal(cfg.modelMode, 'profile');
  assert.equal(cfg.modelProfileId, 'p1');
  assert.equal(cfg.includeContext, 'recent');
  assert.equal(cfg.recentMessageCount, 50);
  assert.equal(cfg.output.mode, 'note');
  assert.equal(cfg.output.injectIntoBody, false, 'note 产物不能注入正文');
  const follow = normalizeCustomHouseConfig({ modelMode: 'main', modelProfileId: 'p1' });
  assert.equal(follow.modelMode, 'follow_current', '未知模式回落 follow_current');
  assert.equal(follow.modelProfileId, '', 'follow_current 不保留模型档');
  console.log('ok - custom house config normalizes with defaults and enum fallbacks');
}

{
  const board = normalizeHopscotchBoard({ rows: [{ id: 'empty', houses: [] }, bodyRow(['memory_table', 'memory_table'])], policy: { onHouseFailure: 'nope' } });
  assert.equal(board.rows.length, 1, '空行不算执行行');
  assert.deepEqual(board.rows[0].houses[0].fused, ['memory_table'], 'fused 去重');
  assert.equal(board.policy.onHouseFailure, 'continue');
  assert.equal(board.source, 'builtin-default');
  console.log('ok - normalize drops empty rows and fills policy defaults');
}

{
  const ok = validateHopscotchBoard({
    rows: [
      { id: 'r1', houses: [custom('h_analysis', { prompt: '根据 {{user_input}} 列要点', output: { mode: 'context', injectIntoBody: true } })] },
      { id: 'r2', houses: [{ id: 'body', kind: 'body', fused: ['memory_table', 'image_prompt', 'variable'] }, custom('h_side', { prompt: '并行：{{house:h_analysis}}' })] },
      { id: 'r3', houses: [{ id: 'img', kind: 'image_generation' }, { id: 'rev', kind: 'format_review' }, custom('h_edit', { prompt: '编修 {{body}}', output: { mode: 'note' } })] },
      { id: 'r4', houses: [{ id: 'cmp', kind: 'summary_compaction' }] },
    ],
  });
  assert.deepEqual(codes(ok), []);
  assert.equal(ok.ok, true);
  assert.equal(findBodyRowIndex(ok.board), 1);
  console.log('ok - valid board with pre/post/same-row custom houses passes');
}

{
  const r = validateHopscotchBoard({ rows: [{ id: 'r1', houses: [custom('a')] }] });
  assert.ok(codes(r).includes('missing_body'));
  const r2 = validateHopscotchBoard({ rows: [bodyRow(), { id: 'r2', houses: [{ id: 'b2', kind: 'body' }] }] });
  assert.ok(codes(r2).includes('multiple_body'));
  const r3 = validateHopscotchBoard({ rows: [] });
  assert.ok(codes(r3).includes('empty_board'));
  const r4 = validateHopscotchBoard({ version: 2, rows: [bodyRow()] });
  assert.ok(codes(r4).includes('unsupported_version'));
  console.log('ok - body anchor, version and empty board errors');
}

{
  const r = validateHopscotchBoard({ rows: [bodyRow(['variable', 'summary_compaction']), { id: 'r2', houses: [{ id: 'm', kind: 'memory_table' }, { id: 'x', kind: 'nope' }] }] });
  assert.ok(codes(r).includes('invalid_fused'));
  assert.ok(codes(r).includes('unknown_house_kind'));
  const r2 = validateHopscotchBoard({ rows: [bodyRow(['memory_table']), { id: 'r2', houses: [{ id: 'm', kind: 'memory_table' }] }] });
  assert.ok(codes(r2).includes('memory_fused_and_standalone'));
  const r3 = validateHopscotchBoard({ rows: [bodyRow(), { id: 'r2', houses: [{ id: 'm', kind: 'memory_table', fused: ['variable'] }] }] });
  assert.ok(codes(r3).includes('fused_outside_body'));
  console.log('ok - fused whitelist, memory exclusivity and fused-outside-body');
}

{
  const r = validateHopscotchBoard({ rows: [{ id: 'r1', houses: [{ id: 'rev', kind: 'format_review' }, { id: 'body', kind: 'body' }] }, { id: 'r2', houses: [{ id: 'img', kind: 'image_generation' }] }] });
  assert.ok(codes(r).includes('builtin_before_body'), '内建房子不能与正文同行或在其之前');
  assert.ok(codes(r).includes('image_without_prompt'));
  const r2 = validateHopscotchBoard({ rows: [bodyRow(), { id: 'r2', houses: [{ id: 'cmp', kind: 'summary_compaction' }, { id: 'm', kind: 'memory_table' }] }] });
  assert.ok(codes(r2).includes('compaction_not_after_memory'));
  const r3 = validateHopscotchBoard({ rows: [bodyRow(), { id: 'r2', houses: [{ id: 'rev', kind: 'format_review' }] }, { id: 'r3', houses: [{ id: 'rev2', kind: 'format_review' }] }] });
  assert.ok(codes(r3).includes('duplicate_builtin'));
  assert.ok(codes(r3).includes('duplicate_builtin'));
  console.log('ok - builtin position, image prompt dependency, memory/compaction order, builtin uniqueness');
}

{
  const r = validateHopscotchBoard({
    rows: [
      { id: 'r1', houses: [custom('a', { prompt: '{{body}} {{house:b}} {{house:none}}' }), custom('b', { prompt: 'x', output: { mode: 'note' } })] },
      bodyRow(),
      { id: 'r3', houses: [custom('c', { prompt: '{{house:a}}', output: { mode: 'context', injectIntoBody: true } }), custom('d', { modelMode: 'profile' })] },
    ],
  });
  const got = codes(r);
  assert.ok(got.includes('body_ref_before_body'));
  assert.ok(got.includes('house_ref_not_earlier'), '同行引用被拒绝');
  assert.ok(got.includes('house_ref_not_context'), 'note 产物不可引用');
  assert.ok(got.includes('unknown_house_ref'));
  assert.ok(got.includes('inject_not_pre_body'));
  assert.ok(got.includes('missing_model_profile'));
  assert.ok(r.errors.every(err => typeof err.message === 'string' && err.message.length));
  assert.deepEqual(extractHouseReferences('{{ house:a }} and {{house:b-1}}'), ['a', 'b-1']);
  console.log('ok - custom house reference, injection and model profile constraints');
}

{
  const rows = [bodyRow()];
  for (let i = 0; i < HOPSCOTCH_LIMITS.maxRows; i += 1) rows.push({ id: `x${i}`, houses: [custom(`c${i}`)] });
  const r = validateHopscotchBoard({ rows, policy: { rowConcurrencyMax: 9, houseTimeoutMs: 0 } });
  const got = codes(r);
  assert.ok(got.includes('too_many_rows'));
  assert.ok(got.includes('invalid_concurrency'));
  assert.ok(got.includes('invalid_timeout'));
  const wide = validateHopscotchBoard({ rows: [bodyRow(), { id: 'w', houses: [custom('1'), custom('2'), custom('3'), custom('4'), custom('5')] }] });
  assert.ok(codes(wide).includes('too_many_houses'));
  const many = validateHopscotchBoard({ rows: [bodyRow(), { id: 'a', houses: [custom('1'), custom('2'), custom('3'), custom('4')] }, { id: 'b', houses: [custom('5'), custom('6'), custom('7'), custom('8')] }, { id: 'c', houses: [custom('9')] }] });
  assert.ok(codes(many).includes('too_many_custom'));
  const dup = validateHopscotchBoard({ rows: [bodyRow(), { id: 'rb', houses: [custom('body')] }] });
  assert.ok(codes(dup).includes('duplicate_house_id'));
  assert.ok(codes(dup).includes('duplicate_row_id'));
  console.log('ok - limits and duplicate ids');
}

{
  // 默认板推导：与现有硬编码流程对应的四种记忆形态 × 复核 × 图片 × 变量
  const base = { replyCheck: { enabled: false }, autoImage: { enabled: false }, variables: { enabled: false } };
  const inline = buildDefaultHopscotchBoard({ ...base, memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'inline' } });
  assert.deepEqual(inline.rows.map(row => row.houses.map(h => h.kind)), [['body']], '表格同回复只显示正文融合，不额外显示摘要房');
  assert.deepEqual(inline.rows[0].houses[0].fused, ['memory_table']);
  assert.equal(validateHopscotchBoard(inline).ok, true);

  const separate = buildDefaultHopscotchBoard({ ...base, memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate' }, autoImage: { enabled: true }, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'profile' }, variables: { enabled: true } });
  assert.deepEqual(separate.rows.map(row => row.houses.map(h => h.kind)), [['body'], ['image_generation', 'memory_table']], '创意写作不引入聊天格式复核或第二种记忆形态');
  assert.deepEqual(separate.rows[0].houses[0].fused, ['image_prompt', 'variable']);
  assert.equal(validateHopscotchBoard(separate).ok, true);

  const off = buildDefaultHopscotchBoard({ ...base, memory: { storageMode: 'off' } });
  assert.deepEqual(off.rows.map(row => row.houses.map(h => h.kind)), [['body']]);
  assert.deepEqual(off.rows[0].houses[0].fused, []);

  const summary = buildDefaultHopscotchBoard({ ...base, memory: { storageMode: 'summary', autoExtract: true, autoExtractMode: 'inline' }, replyCheck: { enabled: true, triggerMode: 'manual', modelMode: 'profile' } });
  assert.deepEqual(summary.rows.map(row => row.houses.map(h => h.kind)), [['body'], ['summary_compaction']], 'summary 模式无写表房子；手动复核不入板');
  assert.deepEqual(summary.rows[0].houses[0].fused, []);

  const noModelReview = buildDefaultHopscotchBoard({ ...base, memory: { storageMode: 'off' }, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'none' } });
  assert.equal(noModelReview.rows.length, 1, 'modelMode none 不是模型房子');

  const writingDisabled = buildDefaultHopscotchBoard({ ...base, memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate', writingEnabled: false } });
  assert.equal(writingDisabled.rows.some(row => row.houses.some(h => h.kind === 'memory_table')), false, '创意写作位置关闭时无写表房子');
  assert.equal(writingDisabled.source, 'builtin-default');
  assert.deepEqual(writingDisabled.rows.map(row => row.houses.map(h => h.kind)), [['body']]);
  const chat = buildDefaultHopscotchBoard({ place: 'chat', memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'inline' }, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'profile' } });
  assert.deepEqual(chat.rows.map(row => row.houses.map(h => h.kind)), [['body'], ['format_review']]);
  assert.deepEqual(chat.rows[0].houses[0].fused, ['memory_table']);
  const chatSeparate = buildDefaultHopscotchBoard({ place: 'chat', memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate' }, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'profile' } });
  assert.deepEqual(chatSeparate.rows.map(row => row.houses.map(h => h.kind)), [['body'], ['memory_table', 'format_review']]);
  console.log('ok - default board derives from resolved writing settings');
}

{
  const board = {
    rows: [
      { id: 'r1', houses: [custom('a')] },
      bodyRow(['memory_table']),
      { id: 'r3', houses: [{ id: 'img', kind: 'image_generation' }, { id: 'rev', kind: 'format_review' }] },
    ],
  };
  const { lanes, tasks } = compileBoardToLaneTasks(board);
  assert.deepEqual(lanes.map(l => l.id), ['request', 'context', 'a', 'body', 'img', 'rev']);
  assert.deepEqual(tasks.map(t => t.id), ['input', 'context', 'a', 'body', 'img', 'rev']);
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  assert.deepEqual(byId.a.dependsOn, ['context']);
  assert.equal(byId.a.timeBucket, 2);
  assert.deepEqual(byId.body.dependsOn, ['a']);
  assert.equal(byId.body.timeBucket, 3);
  assert.deepEqual(byId.body.detail.fused, ['memory_table']);
  assert.deepEqual(byId.img.dependsOn, ['body']);
  assert.deepEqual(byId.rev.dependsOn, ['body']);
  assert.equal(byId.img.timeBucket, byId.rev.timeBucket, '同行同 bucket');
  assert.equal(byId.input.glue, true);
  console.log('ok - board compiles to lane tasks with row barriers');
}

console.log('hopscotch-board-utils tests passed');
