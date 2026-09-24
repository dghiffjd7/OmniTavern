import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  EXEC_FLOW_STATUS_META,
  projectMaidRunToTraceView,
  resolveExecutionFlowActiveKind,
  resolveExecFlowPlacement,
} from '../../src/scripts/ui/chat/execution-flow-runtime-utils.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

{
  const view = projectMaidRunToTraceView({
    id: 'run_1',
    kind: 'maid_assistant',
    status: 'running',
    title: '整理房间',
    metadata: { goal: '把猫从键盘上请走' },
    steps: [
      { id: 's1', status: 'succeeded', summary: '查找会话', input: { toolName: 'app.session.search' } },
      { id: 's2', status: 'running', summary: '', input: { toolName: 'ui.click_element' } },
    ],
  });
  assert.equal(view.title, '把猫从键盘上请走', '标题优先取 metadata.goal');
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0].seq, 1);
  assert.equal(view.steps[1].title, 'ui.click_element', 'summary 为空回退工具名');
  assert.equal(view.stepDone, 1);
  assert.equal(view.stepTotal, 2);
  assert.equal(view.terminal, false);
  assert.equal(view.tone, 'accent');
  console.log('ok - 女仆 run 投影（进行中）');
}

{
  const view = projectMaidRunToTraceView({
    id: 'run_2',
    status: 'failed',
    summary: '女仆执行失败。',
    metadata: { goal: 'x', failureCode: 'timeout' },
    steps: [{ id: 's1', status: 'failed', summary: '发送邮件', errorMessage: '超时' }],
  });
  assert.equal(view.terminal, true);
  assert.equal(view.tone, 'danger');
  assert.equal(view.doneSummary, '女仆执行失败。');
  assert.equal(view.failureCode, 'timeout');
  assert.equal(view.steps[0].error, '超时');
  assert.equal(projectMaidRunToTraceView(null), null);
  console.log('ok - 女仆 run 投影（失败终态与空值）');
}

{
  assert.deepEqual(
    Object.keys(EXEC_FLOW_STATUS_META).sort(),
    ['cancelled', 'failed', 'queued', 'running', 'skipped', 'succeeded', 'waiting_permission'].sort(),
    '状态语义覆盖 agent 七态',
  );
  console.log('ok - 状态语义表');
}

{
  // 球在上半屏 → 面板放正下方；下方被指令条气泡占用 → 翻到正上方；越界被 clamp
  const base = {
    ballRect: { left: 200, top: 100, width: 26, height: 26 },
    viewport: { w: 400, h: 800 },
    panelSize: { width: 332, height: 240 },
  };
  let placed = resolveExecFlowPlacement(base);
  assert.equal(placed.side, 'bottom');
  assert.ok(placed.top > 100, '面板在球下方');
  assert.ok(placed.left >= 12 && placed.left + placed.width <= 400 - 12, '水平 clamp 在视口内');

  placed = resolveExecFlowPlacement({ ...base, occupiedSide: 'bottom' });
  assert.equal(placed.side, 'top', '指令条占用下方时翻到上方');

  placed = resolveExecFlowPlacement({
    ...base,
    ballRect: { left: 380, top: 780, width: 26, height: 26 },
  });
  assert.ok(placed.top + base.panelSize.height <= 800 - 12 + 1, '底部越界被 clamp');
  console.log('ok - 面板贴球定位与避让');
}

{
  const centered = resolveExecFlowPlacement({
    ballRect: { left: 587, top: 167, width: 26, height: 26 },
    viewport: { w: 1200, h: 800 },
    panelSize: { width: 162, height: 34 },
  });
  assert.equal(centered.side, 'bottom');
  assert.equal(centered.left + centered.width / 2, 600,
    '空间足够时应使用缩略图真实宽度与球心正对，不得按展开态宽度向左偏');
  assert.equal(centered.anchorX, centered.width / 2,
    '未触边时锚点应位于缩略图正中央');
  assert.equal(centered.top, 203, '缩略图应贴在球的正下方并保留 10px 呼吸间距');

  const leftEdge = resolveExecFlowPlacement({
    ballRect: { left: 8, top: 387, width: 26, height: 26 },
    viewport: { w: 1200, h: 800 },
    panelSize: { width: 162, height: 34 },
  });
  assert.equal(leftEdge.left, 12, '靠左时浮层本体保持安全边距');
  assert.ok(Math.abs((leftEdge.left + leftEdge.anchorX) - 21) <= 3,
    '浮层被约束时锚点仍应贴近球心，避免视觉断联');

  const rightEdge = resolveExecFlowPlacement({
    ballRect: { left: 1166, top: 387, width: 26, height: 26 },
    viewport: { w: 1200, h: 800 },
    panelSize: { width: 162, height: 34 },
  });
  assert.equal(rightEdge.left + rightEdge.width, 1188, '靠右时浮层本体保持安全边距');
  assert.ok(Math.abs((rightEdge.left + rightEdge.anchorX) - 1179) <= 3,
    '靠右约束时锚点仍应贴近球心');
  console.log('ok - 缩略态真实宽度居中与贴边锚点跟随');
}

{
  const maid = { visible: true, terminal: false, runId: 'maid-1', startedAt: 100, updatedAt: 999 };
  const creative = { visible: true, terminal: false, runId: 'creative-1', startedAt: 200, updatedAt: 220 };
  assert.equal(
    resolveExecutionFlowActiveKind({ maid, creative, preferredKind: 'maid', preferLatestActive: true }),
    'creative',
    '双活跃且新 run 到达时应选择最近启动者，旧 run 的较新更新时间不得抢位',
  );
  assert.equal(
    resolveExecutionFlowActiveKind({ maid, creative, preferredKind: 'maid' }),
    'maid',
    '手动选择在没有新 run 时应保持',
  );
  assert.equal(
    resolveExecutionFlowActiveKind({ maid: { ...maid, terminal: true }, creative, preferredKind: 'maid' }),
    'maid',
    '用户手动选择的终态投影应可在另一投影活跃时回看',
  );
  assert.equal(
    resolveExecutionFlowActiveKind({ maid: { ...maid, terminal: true }, creative }),
    'creative',
    '没有用户选择时仍应优先显示活跃投影',
  );
  assert.equal(
    resolveExecutionFlowActiveKind({
      maid: { ...maid, terminal: true },
      creative: { ...creative, terminal: true },
      preferredKind: 'maid',
    }),
    'maid',
    '两者均结束时保留用户当前选择供回看',
  );
  assert.equal(resolveExecutionFlowActiveKind({ maid: null, creative: null }), '', '无可见投影时隐藏容器');
  console.log('ok - 双投影按活跃状态、启动时间与手动选择仲裁');
}

{
  const [appSource, flowSource, cssSource] = await Promise.all([
    readFile(path.join(projectRoot, 'src/scripts/ui/app.js'), 'utf8'),
    readFile(path.join(projectRoot, 'src/scripts/ui/chat/execution-flow-runtime-utils.js'), 'utf8'),
    readFile(path.join(projectRoot, 'src/assets/css/qq-legacy.css'), 'utf8'),
  ]);
  assert.match(appSource, /createCreativeExecutionLaneRuntime\(\{[\s\S]*inputContainer:\s*null,[\s\S]*onStateChange:\s*snapshot\s*=>\s*executionFlowRuntime\?\.adoptCreativeState/,
    '创意泳道不得再挂到输入框，应把状态投影给共享容器');
  assert.match(appSource, /executionFlowRuntime\.attachCreativeLane\?\.\(creativeExecutionLaneRuntime\)/,
    '共享执行流容器应接管创意泳道 DOM 宿主');
  assert.match(appSource, /const refreshModeSwitchAnchoredUi = \(\) => \{[\s\S]*maidCommandInputRuntime\.position\?\.\(\)[\s\S]*executionFlowRuntime\?\.position\?\.\(\)[\s\S]*\};/,
    '悬浮球锚定 UI 刷新函数应同时重定位指令条与执行流面板');
  assert.match(appSource, /createModeSwitchPositionRuntime\(\{[\s\S]*onPositionChange:\s*refreshModeSwitchAnchoredUi/,
    '悬浮球位置同步完成后应立即重定位指令条与执行流面板');
  assert.match(appSource, /onOpenStateChange:\s*\(\{\s*open(?:,\s*rootEl)?\s*\}\)\s*=>\s*\{[\s\S]*?rearbitrateMaidTrace\?\.\(\{\s*commandInputOpen:\s*open\s*\}\)/,
    '指令条开合必须通知执行流重新仲裁，不能只等下一条 trace 事件');
  assert.doesNotMatch(appSource, /\u0000/,
    'app.js 不应含字面 NUL，围栏哨兵应使用可搜索的转义写法');
  assert.match(flowSource, /class="exec-flow-creative-host"/,
    '共享容器应提供创意泳道插槽');
  assert.match(flowSource, /data-ef-switch="\$\{kind\}"/,
    '双投影同时可见时应提供 chip 切换入口');
  assert.match(flowSource, /createMaidRunCardView\(\{[\s\S]*onStop:[\s\S]*state\.view\?\.terminal !== true[\s\S]*onCancelMaidRun\?\.\(/,
    '女仆运行卡的停止入口只在非终态时转发给与指令条共用的取消回调');
  assert.match(flowSource, /startDrag\(event,\s*\{\s*suppressLongPress:\s*true,\s*suppressClick:\s*true\s*\}\)/,
    '执行流标题转发拖拽时应消费静止单击，避免误触模式切换');
  assert.match(flowSource, /rootEl\.style\.width = 'auto';[\s\S]*?const rect = rootEl\.getBoundingClientRect/,
    '缩略态定位前应先清除展开态固定宽度，再量测真实宽度');
  assert.match(flowSource, /--ef-anchor-x/,
    '共享容器应把动态锚点坐标传给视觉层');
  assert.match(flowSource, /\.exec-flow-root\[data-side='bottom'\]::before[\s\S]*\.exec-flow-root\[data-side='top'\]::before/,
    '共享容器应按上/下方向绘制贴球连接锚点');
  assert.doesNotMatch(cssSource, /\.creative-execution-root\s*\{[\s\S]*?bottom:\s*calc\(100% \+ 6px\)/,
    '创意泳道不得继续定位在输入框上方');
  assert.match(cssSource, /\.creative-execution-chip\s*\{[\s\S]*?border-radius:\s*999px;/,
    '创意泳道缩略态应与女仆投影使用同型 chip');
  assert.match(cssSource, /\.cel-row-flow[\s\S]*repeating-linear-gradient[\s\S]*@keyframes cel-flow-dash/,
    '展开泳道应有状态渐变与流动虚线');
  assert.match(cssSource, /\.cel-card\.is-running::after[\s\S]*animation:\s*cel-card-sheen/,
    '运行中的泳道卡应有低强度横向扫光');
  assert.match(cssSource, /\.cel-row\[data-cel-flow-status='running'\]:not\(:last-child\) \.cel-row-flow::after[\s\S]*animation:\s*cel-flow-particle/,
    '运行中的连接线应有沿线移动的微光点');
  assert.match(cssSource, /@keyframes cel-card-sheen/);
  assert.match(cssSource, /@keyframes cel-flow-particle/);
  console.log('ok - Phase 2 接线、旧定位移除与新视觉契约');
}

// —— onMaidTrace 消费语义：指令条承载女仆流时面板不自开；未消费则面板兜底 ——
{
  const { createExecutionFlowRuntime } = await import('../../src/scripts/ui/chat/execution-flow-runtime-utils.js');
  const fakeRun = {
    id: 'run_x',
    kind: 'maid_assistant',
    status: 'running',
    metadata: { goal: '测试' },
    steps: [{ id: 's1', status: 'running', summary: '步骤', input: { toolName: 't' } }],
  };
  const makeRt = (onMaidTrace) => {
    const listeners = [];
    const rt = createExecutionFlowRuntime({
      documentRef: null,
      agentTaskRuntime: {
        onEvent: (fn) => {
          listeners.push(fn);
          return () => {};
        },
        getRun: () => fakeRun,
      },
      onMaidTrace,
    });
    rt.bind();
    return { rt, emit: event => listeners[0]?.(event) };
  };

  const traces = [];
  const consumed = makeRt((view) => {
    traces.push(view);
    return true;
  });
  consumed.emit({ runId: 'run_x' });
  assert.equal(traces.length, 1, '视图送达指令条');
  assert.equal(traces[0].steps[0].toolName, 't', '投影含工具名');
  assert.equal(traces[0].steps[0].glyph, undefined, '不再投影汉字铭牌');
  assert.equal(consumed.rt.getState().visible, false, '已消费 → 面板不自开');

  const fallback = makeRt(() => false);
  fallback.emit({ runId: 'run_x' });
  assert.equal(fallback.rt.getState().visible, true, '未消费 → 面板兜底自开');
  assert.equal(fallback.rt.getState().expanded, true);

  let shouldConsume = true;
  const handedOff = makeRt(() => shouldConsume);
  handedOff.emit({ runId: 'run_x' });
  assert.equal(handedOff.rt.getState().visible, false, '首帧由打开的指令条消费');
  shouldConsume = false;
  assert.equal(
    handedOff.rt.rearbitrateMaidTrace({ commandInputOpen: false }),
    true,
    '指令条关闭应立即触发再仲裁，不等待下一条 trace',
  );
  assert.equal(handedOff.rt.getState().visible, true, '执行中的同一 run 应立即转交面板兜底');
  assert.equal(handedOff.rt.getState().expanded, true);
  shouldConsume = true;
  assert.equal(
    handedOff.rt.rearbitrateMaidTrace({ commandInputOpen: true }),
    true,
    '指令条重开应主动重放当前完整 trace',
  );
  assert.equal(handedOff.rt.getState().visible, false, '重放被指令条消费后面板立即让位');

  fakeRun.status = 'succeeded';
  fakeRun.summary = '任务完成';
  shouldConsume = false;
  handedOff.emit({ runId: 'run_x' });
  assert.equal(handedOff.rt.getState().visible, true, '关闭期间到达终态时面板继续承载');
  assert.equal(handedOff.rt.getState().view.terminal, true);
  shouldConsume = true;
  assert.equal(
    handedOff.rt.rearbitrateMaidTrace({ commandInputOpen: true }),
    true,
    '终态后即使不再有事件，重开也必须回收完整 trace',
  );
  assert.equal(handedOff.rt.getState().visible, false, '终态 trace 回收后不得永久双窗');
  assert.equal(
    handedOff.rt.rearbitrateMaidTrace({ commandInputOpen: false }),
    false,
    '终态指令条关闭不应重新弹出兜底面板',
  );
  assert.equal(
    handedOff.rt.rearbitrateMaidTrace({ commandInputOpen: true }),
    false,
    '终态已回收并关闭后，全新打开不得反复复活上一条 trace',
  );
  assert.equal(handedOff.rt.getState().visible, false);
  fakeRun.status = 'running'; fakeRun.metadata = { ...fakeRun.metadata, submissionSource: 'maid_realtime' };
  const voiceProjection = makeRt(view => view.source === 'maid_realtime');
  voiceProjection.emit({ runId: 'run_x' });
  assert.equal(voiceProjection.rt.getState().visible, false, 'voice work is consumed by the original ball surface');
  voiceProjection.rt.rearbitrateMaidTrace({ commandInputOpen: false });
  assert.equal(voiceProjection.rt.getState().expanded, false, 'collapsing input never auto-expands a voice trace');
  console.log('ok - onMaidTrace 消费语义（指令条优先、面板兜底）');
}

{
  const { createExecutionFlowRuntime } = await import('../../src/scripts/ui/chat/execution-flow-runtime-utils.js');
  const listeners = new Map();
  const removed = [];
  const root = {
    className: '',
    innerHTML: '',
    classList: { toggle: () => {} },
    dataset: {},
    querySelector: () => null,
    addEventListener: () => {},
    remove: () => {},
  };
  const documentRef = {
    body: { appendChild: () => {} },
    head: {},
    getElementById: () => ({}),
    createElement: () => root,
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type, handler) => removed.push([type, handler]),
  };
  const runtime = createExecutionFlowRuntime({ documentRef });
  runtime.render();
  const escapeHandler = listeners.get('keydown');
  assert.equal(typeof escapeHandler, 'function');
  runtime.destroy();
  assert.deepEqual(removed, [['keydown', escapeHandler]], 'destroy 必须移除 document Escape 监听');
  console.log('ok - execution flow destroy 清理 Escape 监听');
}

console.log('execution-flow-runtime-utils tests passed');
