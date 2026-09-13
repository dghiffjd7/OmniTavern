import assert from 'node:assert/strict';
import { editHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-editor-utils.js';
import { buildDefaultHopscotchBoard, compileBoardToLaneTasks, HOPSCOTCH_LIMITS } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
import { resolveHopscotchActivation } from '../../src/scripts/ui/chat/hopscotch-activation-utils.js';
import { renderHopscotchCourt } from '../../src/scripts/ui/chat/hopscotch-court-view.js';

const initial = buildDefaultHopscotchBoard({});
{
  const original = structuredClone(initial);
  const placeholder = { enabled: false, reason: 'disabled' };
  const before = renderHopscotchCourt(initial, { editable: true, formatReview: placeholder });
  assert.equal((before.match(/class="hop-plus hop-side"/g) || []).length, 2, '正文和停用格式修复都提供同行新增');
  assert.equal((before.match(/class="hop-plus hop-gap"/g) || []).length, 3, '两行共用中间插入口，保留顶部与底部');
  const parallel = editHopscotchBoard(initial, { type: 'add', kind: 'custom_prompt', anchorKind: 'format_review', newRow: false });
  assert.equal(parallel.ok, true, parallel.reason);
  assert.deepEqual(parallel.board.rows.map(row => row.houses.map(h => h.kind)), [['body'], ['format_review', 'custom_prompt']]);
  const review = parallel.board.rows[1].houses[0];
  const peer = parallel.board.rows[1].houses[1];
  const tasks = compileBoardToLaneTasks(parallel.board).tasks;
  assert.equal(tasks.find(t => t.id === review.id).timeBucket, tasks.find(t => t.id === peer.id).timeBucket);
  assert.deepEqual(tasks.find(t => t.id === peer.id).dependsOn, ['body'], '同一行依赖正文，两者并行');
  assert.equal(resolveHopscotchActivation(parallel.board, { replyCheck: placeholder }).houses[review.id].enabled, false, '新增邻居保留共享功能停用状态');
  const after = editHopscotchBoard(initial, { type: 'add', kind: 'custom_prompt', anchorKind: 'format_review', newRow: true });
  assert.equal(after.ok, true, after.reason);
  assert.deepEqual(after.board.rows.map(row => row.houses.map(h => h.kind)), [['body'], ['format_review'], ['custom_prompt']]);
  const afterTasks = compileBoardToLaneTasks(after.board).tasks;
  assert.deepEqual(afterTasks.find(t => t.id === after.board.rows[2].houses[0].id).dependsOn, [after.board.rows[1].houses[0].id]);
  const above = editHopscotchBoard(initial, { type: 'add', kind: 'custom_prompt', rowIndex: initial.rows.length, newRow: true });
  assert.equal(above.ok, true);
  const aboveHtml = renderHopscotchCourt(above.board, { editable: true, formatReview: placeholder });
  assert(aboveHtml.indexOf('data-hop-house="' + above.board.rows[1].houses[0].id + '"') < aboveHtml.indexOf('data-hop-format-review'));
  const promoted = renderHopscotchCourt(parallel.board, { editable: true, formatReview: placeholder });
  assert.equal((promoted.match(/data-hop-kind="format_review"/g) || []).length, 1, '纳入草稿后只显示一次格式修复');
  assert.doesNotMatch(promoted, /data-hop-anchor=/, '实体行沿用普通行操作');
  assert.equal(editHopscotchBoard(initial, { type: 'add', kind: 'format_review', anchorKind: 'format_review' }).ok, false, '内建 Agent 保持唯一');
  const full = structuredClone(initial);
  while (full.rows.length < HOPSCOTCH_LIMITS.maxRows) full.rows.push({ id: 'extra-' + full.rows.length, houses: [{ id: 'extra-' + full.rows.length, kind: 'custom_prompt' }] });
  assert.equal(editHopscotchBoard(full, { type: 'add', kind: 'custom_prompt', anchorKind: 'format_review' }).ok, false, '展示锚点也遵守行数限制');
  assert.equal(full.rows.length, HOPSCOTCH_LIMITS.maxRows, '失败原子回退');
  assert.deepEqual(initial, original, '浏览、取消或失败均不改写原板');
  console.log('ok - every execution row has add controls; review placeholder promotes atomically with parallel/sequential dependencies and limits');
}
const saved = structuredClone(initial);
let result = editHopscotchBoard(initial, { type: 'add', kind: 'custom_prompt', rowIndex: 0, newRow: true });
assert.equal(result.ok, true);
assert.deepEqual(initial, saved);
let board = result.board;
const pre = board.rows[0].houses[0].id;
assert.equal(editHopscotchBoard(board, { type: 'remove', id: 'body' }).ok, false);
const removed = editHopscotchBoard(board, { type: 'remove', id: pre });
assert.equal(removed.ok, true);
assert.deepEqual(removed.board.rows.flatMap(row => row.houses.map(house => house.id)), ['body'], '删除唯一房子后空行被清除');
assert.ok(board.rows.some(row => row.houses.some(house => house.id === pre)), '删除只生成新草稿，不修改原板');
const dependent = editHopscotchBoard(board, { type: 'add', kind: 'custom_prompt', rowIndex: 2, newRow: true, house: { config: { prompt: `Use {{house:${pre}}}` } } });
assert.equal(dependent.ok, true);
assert.equal(editHopscotchBoard(dependent.board, { type: 'remove', id: pre }).ok, false, '被引用的房子不能静默删除');
assert.equal(editHopscotchBoard(board, { type: 'add', kind: 'image_generation', rowIndex: 0 }).ok, false);
result = editHopscotchBoard(board, { type: 'update', id: pre, patch: { label: '<script>alert(1)</script>', config: { prompt: '分析 {{user_input}}', output: { mode: 'context', injectIntoBody: true } } } });
assert.equal(result.ok, true);
board = result.board;
assert.equal(editHopscotchBoard(board, { type: 'move', id: pre, rowIndex: 1 }).ok, false, '注入资料不能移动到正文同行');
result = editHopscotchBoard(board, { type: 'copy', id: pre });
assert.equal(result.ok, true);
assert.notEqual(result.board.rows[0].houses[1].id, pre);
result = editHopscotchBoard(board, { type: 'fuse', kind: 'image_prompt', enabled: true });
assert.equal(result.ok, true);
board = result.board;
result = editHopscotchBoard(board, { type: 'add', kind: 'image_generation', rowIndex: board.rows.length, newRow: true });
assert.equal(result.ok, true);
board = result.board;
assert.equal(editHopscotchBoard(board, { type: 'fuse', kind: 'image_prompt', enabled: false }).ok, false, '生图依赖提示');
assert.equal(editHopscotchBoard(board, { type: 'policy', patch: { rowConcurrencyMax: 5 } }).ok, false);
const html = renderHopscotchCourt(board, { editable: true });
assert.ok(html.includes('&lt;script&gt;'));
assert.ok(!html.includes('<script>'));
assert.ok(html.includes('data-hop-new="1"'));
assert.match(html, /data-hop-kind="body"/, '房子提供纯呈现身份，供卡片质感和颜色使用');
assert.match(html, /data-hop-kind="custom_prompt"/);
const live = renderHopscotchCourt(board, { states: { [pre]: { status: 'failed' } }, status: 'partial', taskAttribute: 'data-cel-task-id' });
assert.ok(live.includes(`data-cel-task-id="${pre}"`));
assert.ok(live.includes('is-failed'));
assert.ok(!live.includes('data-hop-add'));
console.log('ok - atomic board operations, fusion dependencies, shared safe court renderer');

{
  const fusedBoard = buildDefaultHopscotchBoard({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'inline' }, autoImage: { enabled: true }, variables: { enabled: true } });
  const before = JSON.stringify(fusedBoard);
  const html = renderHopscotchCourt(fusedBoard, { editable: true });
  assert.match(html, /<div[^>]*hop-fusion-group[^>]*role="group"/, '融合组是一个容器，不在按钮中嵌套按钮');
  for (const kind of ['body', 'memory_table', 'image_prompt', 'variable']) {
    assert.match(html, new RegExp('<button[^>]*data-hop-part="' + kind + '"[^>]*>(?:(?!</button>)[\\s\\S])*?<span class="hop-title"'), '每个融合成员都有可读名称和独立点击区域');
  }
  assert.equal((html.match(/data-hop-house="body"/g) || []).length, 1, '融合成员不能被计为额外房子');
  assert.doesNotMatch(html, /class="hop-fused"/, '融合组不再使用小标签');
  const live = renderHopscotchCourt(fusedBoard, { states: { body: { status: 'running' } }, taskAttribute: 'data-cel-task-id' });
  assert.equal((live.match(/data-cel-task-id="body"/g) || []).length, 1, '运行视图仍只对应一个请求任务');
  assert.match(live, /hop-fusion-group is-running/);
  assert.doesNotMatch(live, /draggable="true"/);
  assert.equal(JSON.stringify(fusedBoard), before, '呈现不得改写融合执行数据');
  console.log('ok - fused group has equal member controls without duplicating houses or runtime tasks');
}

{
  const board = buildDefaultHopscotchBoard({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate' } });
  const idle = renderHopscotchCourt(board, { editable: true });
  assert.match(idle, /<div class="hop-origin" aria-hidden="true"><\/div>/, '起点只是一个圆点，不写字');
  assert.doesNotMatch(idle, /起点|终点/, '板上不再出现起点/终点文字');
  assert.doesNotMatch(idle, /hop-stone/, '未运行时没有石子');
  const memoryId = board.rows.flatMap(row => row.houses).find(h => h.kind === 'memory_table').id;
  const live = renderHopscotchCourt(board, { states: { body: { status: 'succeeded' }, [memoryId]: { status: 'running' } }, status: 'running' });
  assert.equal((live.match(/hop-stone/g) || []).length, 1, '石子只落在当前执行行');
  assert.match(live, /<div class="hop-row has-stone" data-hop-row="1" data-hop-row-id="[^"]+">/, '石子在正在执行的第二行');
  assert.match(live, /hop-tick/, '非编辑态行间用刻度表示先后');
  assert.match(live, /is-succeeded[^>]*data-hop-house="body"[\s\S]*?hop-cell-mark" aria-hidden="true">✓</, '完成用记号而非文字');
  assert.match(live, /class="hop-roof is-running"/);
  console.log('ok - court shows origin dot, ticks, stone on the running row and glyph statuses');
}
