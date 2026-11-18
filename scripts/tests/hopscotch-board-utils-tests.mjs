import assert from 'node:assert/strict';
import { resolveHopscotchBoardSettings } from '../../src/scripts/ui/chat/hopscotch-settings-utils.js';

import {
  HOPSCOTCH_LIMITS,
  applyHopscotchMemoryPlacement,
  buildDefaultHopscotchBoard,
  compileBoardToLaneTasks,
  extractHouseReferences,
  findBodyRowIndex,
  getHopscotchHouseDisplayStatus,
  isHopscotchMaintenanceRunning,
  normalizeCustomHouseConfig,
  normalizeHopscotchBoard,
  resolveHopscotchBoardMemoryMode,
  validateHopscotchBoard,
} from '../../src/scripts/ui/chat/hopscotch-board-utils.js';

const codes = result => result.errors.map(err => err.code);
const custom = (id, config = {}) => ({ id, kind: 'custom_prompt', label: id, config });
const bodyRow = (fused = []) => ({ id: 'rb', houses: [{ id: 'body', kind: 'body', fused }] });

{
  // 维护在后台进行时宿主照样算完成（不再像正文仍在生成），另由 isHopscotchMaintenanceRunning 标示。
  for (const [childStatus, expected] of [['running', 'succeeded'], ['queued', 'succeeded'], ['succeeded', 'succeeded'], ['skipped', 'succeeded'], ['failed', 'partial'], ['cancelled', 'cancelled']]) {
    const state = { status: 'succeeded', childResults: [{ status: childStatus }] };
    assert.equal(getHopscotchHouseDisplayStatus(state), expected);
    assert.equal(state.status, 'succeeded', '显示子任务状态但不重写主产物交付状态');
  }
  assert.equal(getHopscotchHouseDisplayStatus({ status: 'failed', childResults: [{ status: 'succeeded' }] }), 'failed');
  assert.equal(isHopscotchMaintenanceRunning({ status: 'succeeded', childResults: [{ status: 'running' }] }), true);
  assert.equal(isHopscotchMaintenanceRunning({ status: 'succeeded', childResults: [{ status: 'queued' }] }), true);
  assert.equal(isHopscotchMaintenanceRunning({ status: 'succeeded', childResults: [{ status: 'failed' }] }), false);
  assert.equal(isHopscotchMaintenanceRunning({ status: 'running', childResults: [{ status: 'running' }] }), false);
  console.log('ok - house display includes internal work without rewriting delivery status');
}

{
  const settings = { memoryEnabled: true, memoryStorageMode: 'table', memoryAutoExtract: true, memoryAutoExtractMode: 'inline', memoryTableEnabledChat: true, memoryTableEnabledWriting: false };
  const args = { settings, replyCheck: { enabled: true, triggerMode: 'auto', modelMode: 'profile' }, autoImageEnabled: true };
  const writing = resolveHopscotchBoardSettings(args);
  const chat = resolveHopscotchBoardSettings({ ...args, place: 'chat' });
  assert.equal(writing.memory.storageMode, 'off');
  assert.equal(writing.replyCheck.enabled, true, '共享启用设置保留；创意格式可用性单独判断');
  assert.equal(writing.autoImage.enabled, true);
  assert.equal(chat.memory.storageMode, 'table');
  assert.equal(chat.replyCheck.enabled, true);
  assert.equal(chat.autoImage.enabled, false, '创意写作自动配图不泄露到聊天');
  assert.equal(resolveHopscotchBoardSettings({ settings: { ...settings, memoryEnabled: false } }).memory.storageMode, 'off');
  assert.equal(resolveHopscotchBoardSettings({ settings: { ...settings, memoryStorageMode: 'summary' } }).memory.storageMode, 'summary', '表格位置开关不禁用另一种摘要存储');
  assert.equal(settings.memoryEnabled, true, '解析不写回设置');
  console.log('ok - memory mode/place switches and shared review settings resolve without changing settings');
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
  assert.deepEqual([cfg.promptSource, cfg.presetId], ['prompt', ''], '默认用提示词');
  const preset = normalizeCustomHouseConfig({ promptSource: 'preset', presetId: ' p9 ' });
  assert.deepEqual([preset.promptSource, preset.presetId], ['preset', 'p9']);
  assert.equal(normalizeCustomHouseConfig({ promptSource: 'weird' }).promptSource, 'prompt');
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
  const r4 = validateHopscotchBoard({ version: 99, rows: [bodyRow()] });
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
  for (let i = 0; i < 8; i += 1) rows.push({ id: `x${i}`, houses: [custom(`c${i}`)] });
  assert.equal(validateHopscotchBoard({ rows }).ok, true, '自定义任务可以分在超过六行的顺序流程里');
  const r = validateHopscotchBoard({ rows, policy: { rowConcurrencyMax: 9, houseTimeoutMs: 0 } });
  const got = codes(r);
  assert.ok(got.includes('invalid_concurrency'));
  assert.equal(r.board.policy.houseTimeoutMs, undefined, '旧板的房子超时字段被忽略');
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
  const original = { rows: [bodyRow(['memory_table']), { id: 'summary', houses: [{ id: 'summary', kind: 'summary_compaction' }] },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `custom-row-${i}`, houses: [custom(`custom-${i}`)] }))] };
  assert.equal(validateHopscotchBoard(original).ok, true);
  const separate = applyHopscotchMemoryPlacement(original, { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate' });
  assert.equal(separate.rows.length, 7);
  assert.equal(separate.rows[1].houses[0].kind, 'memory_table');
  assert.equal(validateHopscotchBoard(separate).ok, true, '拆出记忆不能使原本有效的板失效');
  assert.deepEqual(compileBoardToLaneTasks(separate).tasks.filter(task => !task.glue).map(task => task.id),
    ['body', 'memory', 'summary', 'custom-0', 'custom-1', 'custom-2', 'custom-3']);
  console.log('ok - separate memory preserves valid sequential boards beyond six rows');
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

{
  // 记忆融进正文还是单独房子由写作的写表方式决定；板只保留房子位置。
  const on = mode => ({ storageMode: 'table', autoExtract: true, autoExtractMode: mode, placeEnabled: true });
  const kinds = board => board.rows.map(row => row.houses.map(h => h.kind));
  const bodyOf = board => board.rows.flatMap(row => row.houses).find(h => h.kind === 'body');
  const custom = (id, prompt = 'x') => ({ id, kind: 'custom_prompt', config: { prompt } });

  // 融合 → 设定改成独立请求：拆成正文下一行的房子，带上原来的启用状态与模型配置
  const fused = normalizeHopscotchBoard({ rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', fused: ['memory_table', 'variable'], fusedEnabled: { memory_table: false, variable: true }, fusedMembers: { memory_table: { config: { modelMode: 'profile', modelProfileId: 'p9' } } } }] },
    { id: 'r2', houses: [custom('h_note')] },
  ] });
  const before = JSON.stringify(fused);
  const separated = applyHopscotchMemoryPlacement(fused, on('separate'));
  assert.equal(JSON.stringify(fused), before, '不改动传入的板');
  assert.deepEqual(kinds(separated), [['body'], ['custom_prompt', 'memory_table']]);
  assert.deepEqual(bodyOf(separated).fused, ['variable']);
  const memoryHouse = separated.rows[1].houses[1];
  assert.equal(memoryHouse.enabled, false, '沿用融合项的启用状态');
  assert.equal(memoryHouse.config.modelProfileId, 'p9', '沿用融合项的模型配置');
  assert.equal(resolveHopscotchBoardMemoryMode(separated), 'separate');
  assert.equal(validateHopscotchBoard(separated).ok, true);

  // 房子 → 设定改成同回复：并回正文融合组，空行去掉，其余房子不动
  const merged = applyHopscotchMemoryPlacement({ rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', fused: [] }] },
    { id: 'r2', houses: [{ id: 'mem', kind: 'memory_table', enabled: false }] },
    { id: 'r3', houses: [{ id: 'compaction', kind: 'summary_compaction' }, custom('h_edit')] },
  ] }, on('inline'));
  assert.deepEqual(kinds(merged), [['body'], ['summary_compaction', 'custom_prompt']]);
  assert.deepEqual(bodyOf(merged).fused, ['memory_table']);
  assert.equal(bodyOf(merged).fusedEnabled.memory_table, false, '沿用房子的启用状态');
  assert.equal(resolveHopscotchBoardMemoryMode(merged), 'inline');

  // 已在设定要求的位置：原样保留（房子位置不挪）
  const kept = { rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', fused: [] }] },
    { id: 'r2', houses: [custom('h_a')] },
    { id: 'r3', houses: [{ id: 'mem', kind: 'memory_table' }] },
  ] };
  assert.deepEqual(kinds(applyHopscotchMemoryPlacement(kept, on('separate'))), [['body'], ['custom_prompt'], ['memory_table']]);

  // 设定开着自动写表、板上却没有记忆：补上
  const bare = { rows: [{ id: 'r1', houses: [{ id: 'body', kind: 'body', fused: [] }] }] };
  assert.deepEqual(bodyOf(applyHopscotchMemoryPlacement(bare, on('inline'))).fused, ['memory_table']);
  assert.deepEqual(kinds(applyHopscotchMemoryPlacement(bare, on('separate'))), [['body'], ['memory_table']]);

  // 正文下一行已满 4 格、或该行有摘要压缩：在正文后另开一行，保证压缩在记忆之后
  const full = applyHopscotchMemoryPlacement({ rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', fused: [] }] },
    { id: 'r2', houses: Array.from({ length: HOPSCOTCH_LIMITS.maxHousesPerRow }, (_, i) => custom(`h_${i}`)) },
  ] }, on('separate'));
  assert.deepEqual(kinds(full), [['body'], ['memory_table'], Array(HOPSCOTCH_LIMITS.maxHousesPerRow).fill('custom_prompt')]);
  const withCompaction = applyHopscotchMemoryPlacement({ rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', fused: ['memory_table'] }] },
    { id: 'r2', houses: [{ id: 'compaction', kind: 'summary_compaction' }] },
  ] }, on('separate'));
  assert.deepEqual(kinds(withCompaction), [['body'], ['memory_table'], ['summary_compaction']]);
  assert.equal(validateHopscotchBoard(withCompaction).ok, true);

  // 自动写表关着：板上没有记忆就不补；已有的记忆仍按写表方式摆放（显示为停用）
  const off = { ...on('separate'), autoExtract: false };
  assert.equal(resolveHopscotchBoardMemoryMode(applyHopscotchMemoryPlacement(bare, off)), '');
  assert.equal(resolveHopscotchBoardMemoryMode(applyHopscotchMemoryPlacement(fused, off)), 'separate');
  assert.equal(resolveHopscotchBoardMemoryMode(applyHopscotchMemoryPlacement(bare, { ...on('inline'), placeEnabled: false })), '', '写作未启用记忆表格时不补');

  // 同时融合又有房子（旧数据）：只留设定要求的那一种
  const both = applyHopscotchMemoryPlacement({ rows: [
    { id: 'r1', houses: [{ id: 'body', kind: 'body', fused: ['memory_table'] }] },
    { id: 'r2', houses: [{ id: 'mem', kind: 'memory_table' }] },
  ] }, on('inline'));
  assert.deepEqual(kinds(both), [['body']]);
  assert.equal(resolveHopscotchBoardMemoryMode(both), 'inline');
  assert.deepEqual(kinds(applyHopscotchMemoryPlacement(kept, {})), [['body'], ['custom_prompt'], ['memory_table']], '没有写表方式（无设定上下文）时不动板');
  console.log('ok - memory placement on saved boards follows the writing auto-extract mode');
}

console.log('hopscotch-board-utils tests passed');
