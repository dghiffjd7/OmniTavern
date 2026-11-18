import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  buildCreativeExecutionDefaultTasks,
  buildCreativeExecutionLaneViewModel,
  buildCreativeExecutionProjectionSnapshot,
  createCreativeExecutionInitialState,
  isCreativeExecutionTerminalStatus,
  normalizeCreativeExecutionTask,
  shouldShowCreativeExecutionForUiMode,
} from '../../src/scripts/ui/chat/creative-execution-lane-runtime-utils.js';

{
  assert.equal(shouldShowCreativeExecutionForUiMode('rp'), true);
  assert.equal(shouldShowCreativeExecutionForUiMode('social'), false);
  assert.equal(shouldShowCreativeExecutionForUiMode(''), false);
  console.log('ok - creative execution lane is scoped to rp ui mode');
}

{
  const state = createCreativeExecutionInitialState({
    runId: 'run-creative-1',
    sessionId: 'rp:alice',
    generationId: 12,
    text: '写一段午后的剧情',
    now: 1000,
  });
  assert.equal(state.run.id, 'run-creative-1');
  assert.equal(state.run.status, 'running');
  assert.deepEqual(state.tasks.map(task => task.id), [
    'input',
    'context',
    'model',
    'memory',
    'profile',
    'variable',
    'image',
  ]);
  assert.equal(state.tasks.find(task => task.id === 'memory').timeBucket, 2);
  assert.equal(state.tasks.find(task => task.id === 'model').label, '正文生成');
  assert.equal(state.tasks.find(task => task.id === 'variable').timeBucket, 2);
  assert.equal(state.tasks.find(task => task.id === 'profile').timeBucket, 3);
  assert.equal(state.tasks.find(task => task.id === 'image').timeBucket, 3);
  console.log('ok - initial state models memory as model-phase follow-up');
}

{
  const tasks = buildCreativeExecutionDefaultTasks({
    executionPlan: {
      memoryPhase: 'async',
      variablePhase: 'async',
    },
  });
  assert.equal(tasks.find(task => task.id === 'memory').timeBucket, 3);
  assert.equal(tasks.find(task => task.id === 'variable').timeBucket, 3);
  console.log('ok - execution plan moves async follow-up tasks into the next time bucket');
}

{
  const state = createCreativeExecutionInitialState({
    runId: 'run-creative-2',
    sessionId: 'rp:bob',
    now: 2000,
  });
  state.tasks = state.tasks.map(task => normalizeCreativeExecutionTask({
    ...task,
    status: task.id === 'model' ? 'running' : (task.timeBucket < 2 ? 'succeeded' : task.status),
    startedAt: 2000 + task.timeBucket * 10,
    updatedAt: 2020 + task.timeBucket * 10,
  }));
  const desktop = buildCreativeExecutionLaneViewModel(state, { orientation: 'desktop' });
  const mobile = buildCreativeExecutionLaneViewModel(state, { orientation: 'mobile' });
  const desktopInput = desktop.tasks.find(task => task.id === 'input');
  const desktopContext = desktop.tasks.find(task => task.id === 'context');
  const desktopModel = desktop.tasks.find(task => task.id === 'model');
  const desktopMemory = desktop.tasks.find(task => task.id === 'memory');
  const desktopVariable = desktop.tasks.find(task => task.id === 'variable');
  assert.equal(desktop.status, 'running');
  assert.equal(desktop.currentTaskId, 'model');
  assert.equal(desktopInput.y < desktopContext.y, true);
  assert.equal(desktopInput.x < desktopModel.x, true);
  assert.equal(desktopMemory.x, desktopModel.x);
  assert.equal(desktopMemory.y > desktopModel.y, true);
  assert.equal(desktopVariable.x, desktopModel.x);
  assert.equal(desktopVariable.y > desktopMemory.y, true);
  const mobileInput = mobile.tasks.find(task => task.id === 'input');
  const mobileModel = mobile.tasks.find(task => task.id === 'model');
  const mobileMemory = mobile.tasks.find(task => task.id === 'memory');
  const mobileVariable = mobile.tasks.find(task => task.id === 'variable');
  assert.equal(mobileInput.y < mobileModel.y, true);
  assert.equal(mobileMemory.y, mobileModel.y);
  assert.equal(mobileMemory.x > mobileModel.x, true);
  assert.equal(mobileVariable.y, mobileModel.y);
  assert.equal(mobileVariable.x > mobileMemory.x, true);
  console.log('ok - view model rotates desktop time axis to mobile time axis');
}

{
  const state = createCreativeExecutionInitialState({
    runId: 'run-creative-3',
    now: 3000,
  });
  state.tasks = state.tasks.map(task => normalizeCreativeExecutionTask({
    ...task,
    status: task.id === 'input' || task.id === 'context' ? 'succeeded' : (task.id === 'model' ? 'running' : 'queued'),
  }));
  const view = buildCreativeExecutionLaneViewModel(state, { orientation: 'desktop' });
  const modelEdge = view.edges.find(edge => edge.targetId === 'model');
  const memoryEdge = view.edges.find(edge => edge.targetId === 'memory');
  assert.equal(modelEdge.active, true);
  assert.equal(memoryEdge.active, false);
  assert.match(modelEdge.path, /^M /);
  assert.equal(view.displayTitle.includes('正文生成'), true);
  console.log('ok - active edge follows the running dependency target only');
}

{
  const state = createCreativeExecutionInitialState({
    runId: 'run-creative-4',
    now: 4000,
  });
  state.tasks = state.tasks.map(task => normalizeCreativeExecutionTask({
    ...task,
    status: task.id === 'memory' || task.id === 'variable'
      ? 'running'
      : (task.timeBucket < 2 || task.id === 'model' ? 'succeeded' : task.status),
  }));
  const view = buildCreativeExecutionLaneViewModel(state, { orientation: 'desktop' });
  assert.equal(view.currentTaskId, 'memory');
  assert.equal(view.displayTitle, '执行中 · 记忆表 等 2 项');
  console.log('ok - parallel running task title uses stable first task plus count');
}

{
  assert.equal(isCreativeExecutionTerminalStatus('succeeded'), true);
  assert.equal(isCreativeExecutionTerminalStatus('skipped'), true);
  assert.equal(isCreativeExecutionTerminalStatus('running'), false);
  const normalized = normalizeCreativeExecutionTask({
    id: 'x',
    status: 'unknown',
    label: 'A very long task title that should not expand forever in a node',
  });
  assert.equal(normalized.status, 'queued');
  assert.equal(normalized.label.length <= 29, true);
  console.log('ok - task normalization clamps invalid status and long labels');
}

{
  const { createCreativeExecutionLaneRuntime } = await import('../../src/scripts/ui/chat/creative-execution-lane-runtime-utils.js');
  const runtime = createCreativeExecutionLaneRuntime({
    documentRef: null,
    getUiMode: () => 'rp',
    now: () => 5000,
    logger: { warn() {}, debug() {} },
  });
  runtime.startRun({ runId: 'run-x', sessionId: 'rp:alice', text: '测试' });
  const state = runtime.getState();
  state.tasks.forEach(task => runtime.finishTask(task.id, 'succeeded', {}));
  runtime.completeRun({ summary: '已完成' });
  assert.equal(runtime.getState().run.status, 'succeeded');

  // 关键回归：run 完成后追加 running 任务（如异步自动生图）必须重新打开 run，
  // 泳道不能在生图仍在进行时显示“已完成”。
  const appended = runtime.appendTask({
    id: 'image-auto-1',
    laneId: 'image',
    label: '自动生图',
    status: 'running',
  });
  assert.ok(appended, '应能追加生图任务');
  assert.equal(runtime.getState().run.status, 'running', '追加 running 任务应重新打开 run');
  assert.equal(runtime.getState().run.finishedAt, 0, '重新打开后 finishedAt 应清零');

  runtime.finishTask('image-auto-1', 'succeeded', { summary: '图片生成完成' });
  const tasks = runtime.getState().tasks;
  assert.ok(tasks.every(task => isCreativeExecutionTerminalStatus(task.status)), '生图完成后所有任务应为终态');
  runtime.completeRun({ summary: '已完成 · 查看流程' });
  assert.equal(runtime.getState().run.status, 'succeeded');
  console.log('ok - async image task reopens completed run and closes it after finishing');
}

{
  const { buildCreativeExecutionStackViewModel } = await import('../../src/scripts/ui/chat/creative-execution-lane-runtime-utils.js');
  const state = {
    run: { status: 'running', title: 'test' },
    lanes: [
      { id: 'model', label: '模型', shortLabel: '模型', icon: 'bolt' },
      { id: 'memory', label: '记忆表', shortLabel: '记忆', icon: 'table' },
      { id: 'image', label: '图片', shortLabel: '图片', icon: 'image' },
    ],
    tasks: [
      { id: 'm1', laneId: 'model', label: '生成', status: 'succeeded', timeBucket: 0, updatedAt: 100 },
      { id: 'm2', laneId: 'model', label: '续写', status: 'running', timeBucket: 1, updatedAt: 300 },
      { id: 'mem1', laneId: 'memory', label: '记忆更新', status: 'succeeded', timeBucket: 1, updatedAt: 200 },
      { id: 'img1', laneId: 'image', label: '生图', status: 'queued', timeBucket: 1, updatedAt: 150 },
    ],
  };
  const view = buildCreativeExecutionStackViewModel(state);
  assert.equal(view.allRows.length, 2, '排队中的行（image 仅 queued）与全终态行仍在 allRows（memory），queued-only 行过滤');
  assert.equal(view.rows.length, 1, '运行期只显示有 running 任务的行');
  assert.ok(!view.rows.some(row => row.lane.id === 'memory'), '全终态行不显示');
  assert.ok(!view.rows.some(row => row.lane.id === 'image'), '仅排队的行不显示');
  const modelRow = view.rows.find(row => row.lane.id === 'model');
  assert.equal(modelRow.currentTask.id, 'm2', '行内当前任务为 running');
  assert.equal(view.collapsedRow.lane.id, 'model', '折叠卡取最新活跃（running 且最新）');
  assert.ok(Array.isArray(view.tasks), '保留 tasks 供详情上下游查找');

  // 完成态回看：全部行与任务（除 skipped）可见
  const finishedView = buildCreativeExecutionStackViewModel({
    ...state,
    run: { status: 'succeeded', title: 'test' },
    tasks: state.tasks.map(t => ({ ...t, status: t.id === 'img1' ? 'skipped' : 'succeeded' })),
  });
  assert.equal(finishedView.rows.length, 2, '回看模式显示全部历史行（skipped-only 行除外）');
  assert.equal(modelRow.flowStatus, 'running', '行连接线应继承当前任务状态');
  console.log('ok - 卡片栈视图：running 过滤/回看模式/折叠卡');
}

{
  const state = createCreativeExecutionInitialState({ runId: 'creative-projection', now: 9000 });
  state.expanded = true;
  const snapshot = buildCreativeExecutionProjectionSnapshot(state, { uiMode: 'rp' });
  assert.deepEqual(snapshot, {
    kind: 'creative',
    visible: true,
    expanded: true,
    runId: 'creative-projection',
    status: 'running',
    terminal: false,
    startedAt: 9000,
    updatedAt: 9000,
  });
  assert.equal(
    buildCreativeExecutionProjectionSnapshot(state, { uiMode: 'chat' }).visible,
    false,
    '非创意写作模式不得参与共享容器仲裁',
  );
  console.log('ok - 创意泳道向共享容器提供独立投影快照');
}

{
  // 执行流程标题是拼出来的中文（状态 · 当前任务）；英文界面靠目录里的模板词条整句翻译
  const { initializeI18n, translateUiText } = await import('../../src/scripts/i18n/index.js');
  const englishCatalog = JSON.parse(await fs.readFile(new URL('../../src/scripts/i18n/locales/en.json', import.meta.url), 'utf8'));
  try {
    await initializeI18n({ preference: 'en', documentLike: null, fetchFn: async () => ({ ok: true, json: async () => englishCatalog }) });
    assert.equal(translateUiText('执行中 · 正文生成'), 'Running · Body generation');
    assert.equal(translateUiText('准备中 · 准备执行'), 'Preparing · Ready to Execute');
    assert.doesNotMatch(translateUiText('执行中 · 记忆表 等 2 项'), /\p{Script=Han}/u);
    assert.equal(translateUiText('失败 · 正文生成'), 'Failed · Body generation');
  } finally {
    await initializeI18n({ preference: 'zh-CN', documentLike: null });
  }
  console.log('ok - running and preparing lane titles translate as a whole in English');
}
