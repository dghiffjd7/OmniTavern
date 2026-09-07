import { translateUiText } from '../../i18n/index.js';
import { renderHopscotchCourt } from './hopscotch-court-view.js';

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const RUNNING_TASK_STATUSES = new Set(['running', 'queued']);

export const CREATIVE_EXECUTION_STATUS_LABELS = Object.freeze({
  queued: '排队',
  running: '执行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '取消',
  skipped: '跳过',
});

export const CREATIVE_EXECUTION_DEFAULT_LANES = Object.freeze([
  { id: 'request', label: '请求', shortLabel: '请求', icon: 'spark' },
  { id: 'context', label: '上下文', shortLabel: '上下文', icon: 'book' },
  { id: 'model', label: '模型', shortLabel: '模型', icon: 'bolt' },
  { id: 'memory', label: '记忆表', shortLabel: '记忆', icon: 'table' },
  { id: 'profile', label: '画像', shortLabel: '画像', icon: 'portrait' },
  { id: 'variable', label: '变量', shortLabel: '变量', icon: 'braces' },
  { id: 'image', label: '图片', shortLabel: '图片', icon: 'image' },
]);

export const CREATIVE_EXECUTION_DEFAULT_TASKS = Object.freeze([
  {
    id: 'input',
    laneId: 'request',
    label: '请求入列',
    brief: '整理输入、附件与续写目标',
    timeBucket: 0,
    phaseIndex: 0,
    dependsOn: [],
  },
  {
    id: 'context',
    laneId: 'context',
    label: '上下文组装',
    brief: '收集聊天、世界书、记忆和变量',
    timeBucket: 1,
    phaseIndex: 1,
    dependsOn: ['input'],
  },
  {
    id: 'model',
    laneId: 'model',
    label: '正文生成',
    brief: '请求模型并接收正文',
    timeBucket: 2,
    phaseIndex: 2,
    dependsOn: ['context'],
  },
  {
    id: 'memory',
    laneId: 'memory',
    label: '记忆表',
    brief: '抽取并同步记忆表',
    timeBucket: 2,
    phaseIndex: 2,
    dependsOn: ['model'],
  },
  {
    id: 'profile',
    laneId: 'profile',
    label: '画像',
    brief: '检查是否触发画像任务',
    timeBucket: 3,
    phaseIndex: 3,
    dependsOn: ['model'],
  },
  {
    id: 'variable',
    laneId: 'variable',
    label: '变量',
    brief: '应用 before/after 变量规则',
    timeBucket: 3,
    phaseIndex: 3,
    dependsOn: ['model'],
  },
  {
    id: 'image',
    laneId: 'image',
    label: '图片提示',
    brief: '检查自动图片提示词',
    timeBucket: 3,
    phaseIndex: 3,
    dependsOn: ['model'],
  },
]);

const normalizeId = value => String(value || '').trim();
const normalizeExecutionPhase = (value, fallback = 'async') => {
  const phase = normalizeId(value).toLowerCase();
  if (phase === 'sync' || phase === 'async' || phase === 'none') return phase;
  return fallback;
};
const toFiniteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);

const truncateText = (value, limit = 88) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
};

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatTimeLabel = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '未记录';
  const date = new Date(n);
  const pad = num => String(num).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const formatDuration = (start, end) => {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(e) || e <= 0 || e < s) return '未记录';
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

const stringifyCompact = value => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const mergeLogItems = (prev = [], next = []) => {
  const out = Array.isArray(prev) ? prev.slice() : [];
  const incoming = Array.isArray(next) ? next : [next];
  incoming.forEach(item => {
    const text = String(item || '').trim();
    if (text) out.push(text);
  });
  return out.slice(-24);
};

export const isCreativeExecutionTerminalStatus = status => TERMINAL_TASK_STATUSES.has(String(status || ''));

export const shouldShowCreativeExecutionForUiMode = uiMode => String(uiMode || '').trim() === 'rp';

export const normalizeCreativeExecutionTask = (task = {}, index = 0) => {
  const id = normalizeId(task.id) || `task-${index + 1}`;
  const status = normalizeId(task.status) || 'queued';
  return {
    id,
    laneId: normalizeId(task.laneId) || 'request',
    label: truncateText(task.label || id, 28),
    brief: truncateText(task.brief || task.summary || '', 96),
    summary: truncateText(task.summary || '', 140),
    status: CREATIVE_EXECUTION_STATUS_LABELS[status] ? status : 'queued',
    timeBucket: Math.max(0, Math.trunc(toFiniteNumber(task.timeBucket, index))),
    phaseIndex: Math.max(0, Math.trunc(toFiniteNumber(task.phaseIndex, index))),
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(normalizeId).filter(Boolean) : [],
    nodeRef: normalizeId(task.nodeRef),
    startedAt: Math.max(0, Math.trunc(toFiniteNumber(task.startedAt, 0))),
    updatedAt: Math.max(0, Math.trunc(toFiniteNumber(task.updatedAt, 0))),
    finishedAt: Math.max(0, Math.trunc(toFiniteNumber(task.finishedAt, 0))),
    input: task.input ?? null,
    output: task.output ?? null,
    detail: task.detail ?? null,
    error: task.error ? String(task.error) : '',
    logs: Array.isArray(task.logs) ? task.logs.map(item => String(item || '').trim()).filter(Boolean).slice(-24) : [],
  };
};

const normalizeLane = (lane = {}, index = 0) => ({
  id: normalizeId(lane.id) || `lane-${index + 1}`,
  label: truncateText(lane.label || lane.id || `泳道 ${index + 1}`, 18),
  shortLabel: truncateText(lane.shortLabel || lane.label || lane.id || `L${index + 1}`, 8),
  icon: normalizeId(lane.icon),
});

const summarizeRequestText = value => {
  const text = truncateText(value, 72);
  return text ? `请求：${text}` : '准备整理本次创意写作请求';
};

export const buildCreativeExecutionDefaultTasks = ({ executionPlan = {} } = {}) => {
  const memoryPhase = normalizeExecutionPhase(executionPlan.memoryPhase, 'sync');
  const variablePhase = normalizeExecutionPhase(executionPlan.variablePhase, 'sync');
  const bucketForPhase = phase => (phase === 'sync' ? 2 : 3);
  return CREATIVE_EXECUTION_DEFAULT_TASKS.map(task => {
    if (task.id === 'memory') {
      const timeBucket = bucketForPhase(memoryPhase);
      return {
        ...task,
        timeBucket,
        phaseIndex: timeBucket,
      };
    }
    if (task.id === 'variable') {
      const timeBucket = bucketForPhase(variablePhase);
      return {
        ...task,
        timeBucket,
        phaseIndex: timeBucket,
      };
    }
    return task;
  });
};

export const createCreativeExecutionInitialState = ({
  runId = '',
  sessionId = '',
  generationId = 0,
  title = '创意写作执行',
  text = '',
  executionPlan = {},
  lanes: laneOverrides = null,
  tasks: taskOverrides = null,
  board = null,
  now = Date.now(),
} = {}) => {
  const startedAt = Math.max(0, Math.trunc(toFiniteNumber(now, 0)));
  const id = normalizeId(runId) || `creative-execution:${startedAt || Date.now()}`;
  // 跳房子板可传入按板生成的 lanes/tasks（compileBoardToLaneTasks）；缺省沿用固定 7 泳道
  const useOverrides = Array.isArray(taskOverrides) && taskOverrides.length > 0;
  const sourceTasks = useOverrides ? taskOverrides : buildCreativeExecutionDefaultTasks({ executionPlan });
  const tasks = sourceTasks.map((task, index) => normalizeCreativeExecutionTask({
    ...task,
    status: 'queued',
    input: task.id === 'input'
      ? {
          requestPreview: truncateText(text, 160),
          sessionId: normalizeId(sessionId),
          generationId: Number(generationId) || 0,
        }
      : null,
    summary: task.id === 'input' ? summarizeRequestText(text) : '',
  }, index));
  return {
    visible: true,
    expanded: false,
    fullscreen: false,
    selectedTaskId: '',
    userPanned: false,
    ...(board ? { board: structuredClone(board) } : {}),
    run: {
      id,
      sessionId: normalizeId(sessionId),
      generationId: Number(generationId) || 0,
      title: truncateText(title || '创意写作执行', 42),
      status: 'running',
      summary: '准备执行',
      startedAt,
      updatedAt: startedAt,
      finishedAt: 0,
    },
    lanes: (useOverrides && Array.isArray(laneOverrides) && laneOverrides.length ? laneOverrides : CREATIVE_EXECUTION_DEFAULT_LANES).map(normalizeLane),
    tasks,
  };
};

const getProgress = tasks => {
  const total = tasks.length;
  const terminal = tasks.filter(task => TERMINAL_TASK_STATUSES.has(task.status)).length;
  const succeeded = tasks.filter(task => task.status === 'succeeded').length;
  const failed = tasks.filter(task => task.status === 'failed').length;
  return { total, terminal, succeeded, failed };
};

const resolveRunStatus = state => {
  const status = normalizeId(state?.run?.status) || 'idle';
  if (status === 'failed' || status === 'cancelled' || status === 'succeeded') return status;
  const tasks = Array.isArray(state?.tasks) ? state.tasks.map(normalizeCreativeExecutionTask) : [];
  if (tasks.some(task => task.status === 'failed')) return 'failed';
  if (tasks.some(task => task.status === 'running')) return 'running';
  if (tasks.length && tasks.every(task => TERMINAL_TASK_STATUSES.has(task.status))) return 'succeeded';
  return 'queued';
};

export const buildCreativeExecutionProjectionSnapshot = (state = null, { uiMode = '' } = {}) => {
  const runStatus = normalizeId(state?.run?.status);
  const status = CREATIVE_EXECUTION_STATUS_LABELS[runStatus]
    ? runStatus
    : (state?.run ? resolveRunStatus(state) : 'queued');
  return {
    kind: 'creative',
    visible: Boolean(state?.run && state?.visible && shouldShowCreativeExecutionForUiMode(uiMode)),
    expanded: Boolean(state?.expanded),
    runId: normalizeId(state?.run?.id),
    status,
    terminal: status === 'succeeded' || status === 'failed' || status === 'cancelled',
    startedAt: Math.max(0, Math.trunc(toFiniteNumber(state?.run?.startedAt, 0))),
    updatedAt: Math.max(0, Math.trunc(toFiniteNumber(state?.run?.updatedAt, 0))),
  };
};

const resolveCurrentTask = tasks => {
  const running = tasks
    .filter(task => task.status === 'running')
    .sort((a, b) => a.timeBucket - b.timeBucket || a.phaseIndex - b.phaseIndex);
  if (running.length) return running[0];
  const queued = tasks
    .filter(task => task.status === 'queued')
    .sort((a, b) => a.timeBucket - b.timeBucket || a.phaseIndex - b.phaseIndex);
  return queued[0] || tasks[tasks.length - 1] || null;
};

const buildPath = (source, target, orientation, nodeSize) => {
  const sameBucket = source.timeBucket === target.timeBucket;
  if (orientation === 'mobile') {
    if (sameBucket) {
      const sx = source.x + nodeSize.width;
      const sy = source.y + nodeSize.height / 2;
      const tx = target.x;
      const ty = target.y + nodeSize.height / 2;
      const mid = sx + Math.max(36, (tx - sx) / 2);
      return `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`;
    }
    const sx = source.x + nodeSize.width / 2;
    const sy = source.y + nodeSize.height;
    const tx = target.x + nodeSize.width / 2;
    const ty = target.y;
    const mid = sy + Math.max(32, (ty - sy) / 2);
    return `M ${sx} ${sy} C ${sx} ${mid}, ${tx} ${mid}, ${tx} ${ty}`;
  }
  if (sameBucket) {
    const sx = source.x + nodeSize.width / 2;
    const sy = source.y + nodeSize.height;
    const tx = target.x + nodeSize.width / 2;
    const ty = target.y;
    const mid = sy + Math.max(34, (ty - sy) / 2);
    return `M ${sx} ${sy} C ${sx} ${mid}, ${tx} ${mid}, ${tx} ${ty}`;
  }
  const sx = source.x + nodeSize.width;
  const sy = source.y + nodeSize.height / 2;
  const tx = target.x;
  const ty = target.y + nodeSize.height / 2;
  const mid = sx + Math.max(42, (tx - sx) / 2);
  return `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`;
};

export const buildCreativeExecutionLaneViewModel = (state = {}, { orientation = 'desktop' } = {}) => {
  const lanes = (Array.isArray(state.lanes) && state.lanes.length
    ? state.lanes
    : CREATIVE_EXECUTION_DEFAULT_LANES).map(normalizeLane);
  const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
  const tasks = (Array.isArray(state.tasks) ? state.tasks : []).map(normalizeCreativeExecutionTask)
    .filter(task => laneIndex.has(task.laneId))
    .sort((a, b) => a.timeBucket - b.timeBucket || laneIndex.get(a.laneId) - laneIndex.get(b.laneId));
  const currentTask = resolveCurrentTask(tasks);
  const runningTaskCount = tasks.filter(task => task.status === 'running').length;
  const activeBucket = currentTask?.timeBucket ?? 0;
  const progress = getProgress(tasks);
  const status = resolveRunStatus(state);
  const nodeSize = orientation === 'mobile'
    ? { width: 138, height: 74 }
    : { width: 168, height: 74 };
  const pad = orientation === 'mobile'
    ? { left: 116, top: 58, right: 48, bottom: 70 }
    : { left: 132, top: 58, right: 80, bottom: 64 };
  const gapX = orientation === 'mobile' ? 154 : 202;
  const gapY = orientation === 'mobile' ? 98 : 88;
  const maxBucket = tasks.reduce((max, task) => Math.max(max, task.timeBucket), 0);

  const positionedTasks = tasks.map(task => {
    const li = laneIndex.get(task.laneId) || 0;
    const x = orientation === 'mobile'
      ? pad.left + li * gapX
      : pad.left + task.timeBucket * gapX;
    const y = orientation === 'mobile'
      ? pad.top + task.timeBucket * gapY
      : pad.top + li * gapY;
    return {
      ...task,
      lane: lanes[li],
      x,
      y,
      width: nodeSize.width,
      height: nodeSize.height,
      isCurrent: currentTask?.id === task.id,
    };
  });
  const taskById = new Map(positionedTasks.map(task => [task.id, task]));
  const edges = [];
  positionedTasks.forEach(task => {
    task.dependsOn.forEach(sourceId => {
      const source = taskById.get(sourceId);
      if (!source) return;
      const active = task.status === 'running' && (source.status === 'succeeded' || source.status === 'running');
      const failed = task.status === 'failed' || source.status === 'failed';
      edges.push({
        id: `${source.id}->${task.id}`,
        sourceId: source.id,
        targetId: task.id,
        status: failed ? 'failed' : (active ? 'active' : task.status),
        active,
        path: buildPath(source, task, orientation, nodeSize),
      });
    });
  });

  const scene = orientation === 'mobile'
    ? {
        width: pad.left + lanes.length * gapX + nodeSize.width + pad.right,
        height: pad.top + (maxBucket + 1) * gapY + nodeSize.height + pad.bottom,
      }
    : {
        width: pad.left + (maxBucket + 1) * gapX + nodeSize.width + pad.right,
        height: pad.top + lanes.length * gapY + nodeSize.height + pad.bottom,
      };
  const timeMarkers = Array.from(new Set(tasks.map(task => task.timeBucket))).sort((a, b) => a - b).map(bucket => {
    if (orientation === 'mobile') {
      return {
        bucket,
        label: bucket === activeBucket && status === 'running' ? '进行中' : `T+${bucket}`,
        x1: 20,
        x2: scene.width - 28,
        y: pad.top + bucket * gapY + nodeSize.height / 2,
        active: bucket === activeBucket && status === 'running',
      };
    }
    return {
      bucket,
      label: bucket === activeBucket && status === 'running' ? '进行中' : `T+${bucket}`,
      x: pad.left + bucket * gapX + nodeSize.width / 2,
      y1: 22,
      y2: scene.height - 32,
      active: bucket === activeBucket && status === 'running',
    };
  });
  const laneLabels = lanes.map((lane, index) => {
    if (orientation === 'mobile') {
      return {
        ...lane,
        x: pad.left + index * gapX + nodeSize.width / 2,
        y: 18,
      };
    }
    return {
      ...lane,
      x: 22,
      y: pad.top + index * gapY + nodeSize.height / 2,
    };
  });
  const statusText = status === 'succeeded'
    ? '已完成'
    : status === 'failed'
      ? '失败'
      : status === 'cancelled'
        ? '已取消'
        : status === 'running'
          ? '执行中'
          : '准备中';
  const activityTitle = currentTask
    ? `${currentTask.label}${runningTaskCount > 1 ? ` 等 ${runningTaskCount} 项` : ''}`
    : '准备执行';
  const displayTitle = status === 'succeeded'
    ? '已完成 · 执行流程'
    : status === 'failed'
      ? `失败 · ${currentTask?.label || '查看详情'}`
      : status === 'cancelled'
        ? '已取消 · 执行流程'
        : `${statusText} · ${activityTitle}`;
  const summary = status === 'succeeded'
    ? '已完成 · 查看流程'
    : status === 'failed'
      ? `失败 · ${currentTask?.label || '查看详情'}`
      : status === 'cancelled'
        ? '已取消 · 查看流程'
        : (currentTask?.summary || currentTask?.brief || '等待状态更新');
  return {
    orientation,
    status,
    statusText,
    displayTitle,
    summary,
    progress,
    currentTaskId: currentTask?.id || '',
    activeBucket,
    scene,
    nodeSize,
    lanes,
    tasks: positionedTasks,
    edges,
    timeMarkers,
    laneLabels,
    selectedTask: taskById.get(state.selectedTaskId) || null,
  };
};

// 竖式进程卡片栈视图（2026-07-06 重设计）：每个 lane 一行，行内横向滚动看历史，
// 折叠态只显示最新活跃行的当前任务卡；已结束（全部终态）的行不显示。
export const buildCreativeExecutionStackViewModel = (state = {}) => {
  const base = buildCreativeExecutionLaneViewModel(state, { orientation: 'desktop' });
  const lanes = (Array.isArray(state.lanes) && state.lanes.length
    ? state.lanes
    : CREATIVE_EXECUTION_DEFAULT_LANES).map(normalizeLane);
  const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
  const tasks = (Array.isArray(state.tasks) ? state.tasks : []).map(normalizeCreativeExecutionTask)
    .filter(task => laneIndex.has(task.laneId))
    .sort((a, b) => a.timeBucket - b.timeBucket || laneIndex.get(a.laneId) - laneIndex.get(b.laneId));
  const byLane = new Map();
  tasks.forEach((task) => {
    if (!byLane.has(task.laneId)) byLane.set(task.laneId, []);
    byLane.get(task.laneId).push(task);
  });
  const runFinished = ['succeeded', 'failed', 'cancelled'].includes(base.status);
  const rows = lanes
    .map((lane) => {
      const allLaneTasks = byLane.get(lane.id) || [];
      // 未执行的任务不进卡片流：跳过的永不显示；排队中的在运行期也不显示（只看已执行/执行中）
      const laneTasks = allLaneTasks.filter(task => task.status !== 'skipped'
        && (runFinished || task.status !== 'queued'));
      if (!laneTasks.length) return null;
      const done = allLaneTasks.every(task => isCreativeExecutionTerminalStatus(task.status));
      const hasRunning = laneTasks.some(task => task.status === 'running');
      const currentTask = laneTasks.find(task => task.status === 'running')
        || laneTasks[laneTasks.length - 1];
      return { lane, tasks: laneTasks, currentTask, done, hasRunning, flowStatus: currentTask.status };
    })
    .filter(Boolean);
  // run 结束后保留全部行供回看（"已完成·查看流程"点开有内容）；运行中只显示有执行中任务的行
  const activeRows = runFinished ? rows : rows.filter(row => row.hasRunning);
  const rankRow = row => (row.currentTask.status === 'running' ? 2 : row.currentTask.status === 'queued' ? 1 : 0);
  const collapsedRow = activeRows
    .slice()
    .sort((a, b) => (rankRow(b) - rankRow(a))
      || (toFiniteNumber(b.currentTask.updatedAt, 0) - toFiniteNumber(a.currentTask.updatedAt, 0)))[0]
    || rows[rows.length - 1]
    || null;
  const runningTaskCount = tasks.filter(task => task.status === 'running').length;
  return {
    runningTaskCount,
    status: base.status,
    statusText: base.statusText,
    displayTitle: base.displayTitle,
    summary: base.summary,
    progress: base.progress,
    currentTaskId: base.currentTaskId,
    selectedTask: base.selectedTask,
    tasks: base.tasks,
    rows: activeRows,
    allRows: rows,
    collapsedRow,
    extraActiveCount: Math.max(0, activeRows.length - 1),
  };
};

const iconSvg = name => {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const icons = {
    spark: `<svg ${common}><path d="M12 3l1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3z"/><path d="M5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/></svg>`,
    book: `<svg ${common}><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v15H7.5A2.5 2.5 0 0 0 5 20.5V5.5z"/><path d="M5 5.5A2.5 2.5 0 0 0 2.5 3H2v15h.5A2.5 2.5 0 0 1 5 20.5"/><path d="M8 7h8M8 11h7"/></svg>`,
    bolt: `<svg ${common}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,
    table: `<svg ${common}><path d="M4 5h16v14H4z"/><path d="M4 10h16M9 5v14M15 5v14"/></svg>`,
    portrait: `<svg ${common}><path d="M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M3 3h18v18H3z"/></svg>`,
    braces: `<svg ${common}><path d="M8 4c-2 0-3 1-3 3v2c0 1-.5 2-2 2 1.5 0 2 1 2 2v2c0 2 1 3 3 3"/><path d="M16 4c2 0 3 1 3 3v2c0 1 .5 2 2 2-1.5 0-2 1-2 2v2c0 2-1 3-3 3"/></svg>`,
    image: `<svg ${common}><path d="M4 5h16v14H4z"/><path d="M8 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M4 16l5-5 3.5 3.5 2-2L20 18"/></svg>`,
    close: `<svg ${common}><path d="M6 6l12 12M18 6L6 18"/></svg>`,
    expand: `<svg ${common}><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/><path d="M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/></svg>`,
    collapse: `<svg ${common}><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/><path d="M9 9L3 3M15 9l6-6M9 15l-6 6M15 15l6 6"/></svg>`,
    chevron: `<svg ${common}><path d="M6 9l6 6 6-6"/></svg>`,
    panel: `<svg ${common}><path d="M4 6h16v12H4z"/><path d="M14 6v12M7 10h4M7 14h4"/></svg>`,
    locate: `<svg ${common}><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  };
  return icons[name] || icons.spark;
};

const renderStripHtml = (view, state) => {
  const progress = `${view.progress.terminal}/${view.progress.total || 0}`;
  const card = view.collapsedRow?.currentTask || null;
  const title = card ? card.label : view.displayTitle;
  return `
    <button type="button" class="creative-execution-chip is-${escapeHtml(view.status)}" data-cel-toggle="1" aria-expanded="${state.expanded ? 'true' : 'false'}" aria-label="展开创意写作执行流程">
      <span class="creative-execution-chip-mark" aria-hidden="true">创</span>
      <span class="creative-execution-chip-title">${escapeHtml(title)}</span>
      ${view.runningTaskCount > 0 ? `<span class="creative-execution-chip-more" title="运行中任务数">${view.runningTaskCount}</span>` : ''}
      <span class="creative-execution-chip-progress">${escapeHtml(progress)}</span>
      <span class="creative-execution-chip-dot" aria-hidden="true"></span>
    </button>
  `;
};

const renderTaskCardHtml = (task, { lane = null, selected = false, isCurrent = false, entering = false, justDone = false } = {}) => `
  <button type="button"
    class="cel-card is-${escapeHtml(task.status)}${isCurrent ? ' is-current' : ''}${selected ? ' is-selected' : ''}${entering ? ' is-entering' : ''}${justDone ? ' is-just-done' : ''}"
    data-cel-task-id="${escapeHtml(task.id)}"
    aria-selected="${selected ? 'true' : 'false'}"
    aria-label="${escapeHtml(`${task.label}，${CREATIVE_EXECUTION_STATUS_LABELS[task.status] || task.status}`)}">
    <span class="cel-card-head">
      ${lane ? `<span class="cel-card-kicker"><span aria-hidden="true">${iconSvg(lane.icon)}</span>${escapeHtml(lane.shortLabel)}</span>` : ''}
      <span class="cel-card-status"><span class="cel-card-dot" aria-hidden="true"></span>${escapeHtml(CREATIVE_EXECUTION_STATUS_LABELS[task.status] || task.status)}</span>
    </span>
    <span class="cel-card-title">${escapeHtml(task.label)}</span>
  </button>
`;

const renderStackRowsHtml = (view, { enteringTaskIds = new Set(), justDoneTaskIds = new Set(), windowStart = 0, windowSize = 3 } = {}) => {
  if (!view.rows.length) {
    return `<div class="cel-rows is-empty">${escapeHtml(view.summary || '流程已结束')}</div>`;
  }
  const start = Math.max(0, Math.min(windowStart, Math.max(0, view.rows.length - windowSize)));
  const visibleRows = view.rows.slice(start, start + windowSize);
  const moreAbove = start > 0;
  const moreBelow = start + windowSize < view.rows.length;
  return `
    <div class="cel-rows${moreAbove ? ' has-more-above' : ''}${moreBelow ? ' has-more-below' : ''}" data-cel-rows="1">
      ${visibleRows.map(row => `
        <div class="cel-row" data-cel-row="${escapeHtml(row.lane.id)}" data-cel-flow-status="${escapeHtml(row.flowStatus)}">
          <span class="cel-row-flow" aria-hidden="true"><span></span></span>
          <div class="cel-row-scroll" data-cel-row-scroll="${escapeHtml(row.lane.id)}">
            ${row.tasks.map(task => renderTaskCardHtml(task, {
              lane: row.lane,
              selected: view.selectedTask?.id === task.id,
              isCurrent: row.currentTask?.id === task.id,
              entering: enteringTaskIds.has(task.id),
              justDone: justDoneTaskIds.has(task.id),
            })).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
};

const renderDetailsHtml = view => {
  const task = view.selectedTask;
  if (!task) {
    return `
      <aside class="creative-execution-detail is-empty" aria-label="节点详情">
        <div class="creative-execution-detail-empty">
          <span aria-hidden="true">${iconSvg('panel')}</span>
          <strong>选择一个节点</strong>
          <p>节点详情、日志和错误信息会在这里展开。</p>
        </div>
      </aside>
    `;
  }
  const downstream = view.tasks.filter(item => item.dependsOn.includes(task.id));
  const upstreamId = task.dependsOn[0] || '';
  const downstreamId = downstream[0]?.id || '';
  const inputText = stringifyCompact(task.input);
  const outputText = stringifyCompact(task.output);
  const detailText = stringifyCompact(task.detail);
  const logText = stringifyCompact(task.logs);
  const errorText = task.error ? String(task.error) : '';
  return `
    <aside class="creative-execution-detail" aria-label="节点详情">
      <div class="creative-execution-detail-head">
        <div class="creative-execution-detail-kicker">${escapeHtml(task.lane?.label || '')} · ${escapeHtml(CREATIVE_EXECUTION_STATUS_LABELS[task.status] || task.status)}</div>
        <button type="button" class="creative-execution-icon-btn" data-cel-detail-close="1" aria-label="关闭节点详情">${iconSvg('close')}</button>
      </div>
      <h3>${escapeHtml(task.label)}</h3>
      <p>${escapeHtml(task.summary || task.brief || '暂无摘要')}</p>
      <dl class="creative-execution-detail-grid">
        <div><dt>开始</dt><dd>${escapeHtml(formatTimeLabel(task.startedAt))}</dd></div>
        <div><dt>结束</dt><dd>${escapeHtml(formatTimeLabel(task.finishedAt))}</dd></div>
        <div><dt>耗时</dt><dd>${escapeHtml(formatDuration(task.startedAt, task.finishedAt || task.updatedAt))}</dd></div>
        <div><dt>阶段</dt><dd>T+${escapeHtml(task.timeBucket)}</dd></div>
      </dl>
      <div class="creative-execution-detail-actions">
        <button type="button" data-cel-jump-upstream="${escapeHtml(task.id)}" ${upstreamId ? '' : 'disabled'}>${iconSvg('locate')}${escapeHtml(translateUiText('上游'))}</button>
        <button type="button" data-cel-jump-downstream="${escapeHtml(task.id)}" ${downstreamId ? '' : 'disabled'}>${iconSvg('locate')}${escapeHtml(translateUiText('下游'))}</button>
      </div>
      ${errorText ? `<section class="creative-execution-detail-error"><strong>错误摘要</strong><p>${escapeHtml(errorText)}</p></section>` : ''}
      ${inputText ? `<details class="creative-execution-detail-block"><summary>输入摘要</summary><pre>${escapeHtml(inputText)}</pre></details>` : ''}
      ${outputText ? `<details class="creative-execution-detail-block"><summary>输出摘要</summary><pre>${escapeHtml(outputText)}</pre></details>` : ''}
      ${detailText ? `<details class="creative-execution-detail-block"><summary>关键参数</summary><pre>${escapeHtml(detailText)}</pre></details>` : ''}
      ${logText ? `<details class="creative-execution-detail-block"><summary>日志</summary><pre>${escapeHtml(logText)}</pre></details>` : ''}
    </aside>
  `;
};

const renderPanelHtml = (view, state, options = {}) => `
  <section class="creative-execution-stack ${view.selectedTask ? 'has-detail' : ''}${options.opening ? ' is-opening' : ''}" aria-label="创意写作执行流程">
    <div class="creative-execution-stack-head">
      <span class="creative-execution-chip-mark" aria-hidden="true">创</span>
      <div class="creative-execution-stack-kicker">
        <span class="creative-execution-stack-label">CREATIVE · FLOW</span>
        <span class="creative-execution-stack-title">${escapeHtml(view.displayTitle)}</span>
      </div>
      <span class="creative-execution-stack-status is-${escapeHtml(view.status)}"><span aria-hidden="true"></span>${escapeHtml(view.statusText)}</span>
      <div class="creative-execution-stack-controls">
        <span class="creative-execution-stack-progress">${escapeHtml(view.progress.terminal)}/${escapeHtml(view.progress.total)}</span>
        <button type="button" class="creative-execution-icon-btn" data-cel-toggle="1" aria-label="收起执行流程">${iconSvg('chevron')}</button>
        <button type="button" class="creative-execution-icon-btn" data-cel-close="1" aria-label="关闭执行流程">${iconSvg('close')}</button>
      </div>
    </div>
    <div class="creative-execution-stack-body" data-ef-scroll="1">
      ${state.board ? renderHopscotchCourt(state.board, { states: Object.fromEntries(state.tasks.map(task => [task.id, task])), status: view.status, taskAttribute: 'data-cel-task-id' }) : renderStackRowsHtml(view, options)}
      ${renderDetailsHtml(view)}
    </div>
  </section>
`;

const normalizePatchArg = value => {
  if (typeof value === 'string') return { summary: value };
  return isPlainObject(value) ? value : {};
};

const getWindowForDocument = doc => doc?.defaultView || (typeof window !== 'undefined' ? window : null);

export const createCreativeExecutionLaneRuntime = ({
  documentRef,
  inputContainer,
  getUiMode = () => '',
  onStateChange = null,
  now = () => Date.now(),
  requestAnimationFrameFn = null,
  logger = console,
} = {}) => {
  let root = null;
  let state = null;
  let mounted = false;
  let mountContainer = inputContainer || null;
  const doc = documentRef || (typeof document !== 'undefined' ? document : null);
  const raf = requestAnimationFrameFn || getWindowForDocument(doc)?.requestAnimationFrame?.bind(getWindowForDocument(doc));
  const isFlowAttached = () => mountContainer?.classList?.contains?.('exec-flow-creative-host') === true;
  const notifyStateChange = () => {
    if (typeof onStateChange !== 'function') return;
    try {
      onStateChange(buildCreativeExecutionProjectionSnapshot(state, { uiMode: getUiMode() }));
    } catch {}
  };

  const resolveOrientation = () => {
    const win = getWindowForDocument(doc);
    try {
      if (win?.matchMedia?.('(max-width: 720px)')?.matches) return 'mobile';
    } catch {}
    return 'desktop';
  };

  // 降低动画：跟随 APP 设定（body[data-reduced-motion]）与系统偏好双通道
  const prefersReducedMotion = () => {
    try {
      if (doc?.body?.dataset?.reducedMotion === 'on') return true;
      const win = getWindowForDocument(doc);
      if (win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return true;
    } catch {}
    return false;
  };

  // 各进程行滚动到当前任务卡（新任务推入时产生向左滑动的观感）
  const scrollRowsToCurrent = () => {
    if (!root || !state?.expanded) return;
    const run = () => {
      try {
        const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
        root.querySelectorAll('[data-cel-row-scroll]').forEach((row) => {
          const current = row.querySelector('.cel-card.is-current');
          if (!current) return;
          const target = current.offsetLeft + current.offsetWidth - row.clientWidth;
          row.scrollTo({ left: Math.max(0, target + 8), behavior });
        });
      } catch {}
    };
    if (typeof raf === 'function') raf(run);
    else run();
  };

  // 上一次渲染时各进程行的当前任务（用于新任务推入动画标记）；
  // 连续快速 render 会全量重绘，entering/just-done 标记按时间窗口保持避免动画被打断。
  let prevRowCurrentIds = new Map();
  const enteringUntil = new Map();
  const ENTERING_WINDOW_MS = 420;
  let prevTaskStatuses = new Map();
  const justDoneUntil = new Map();
  const JUST_DONE_WINDOW_MS = 520;
  let prevExpanded = false;
  // 步进滚动窗口：固定显示 3 行，滚动累计满一行高整体跳一格（瞬时替换）
  const ROWS_WINDOW_SIZE = 3;
  let rowWindowStart = 0;
  let rowScrollAccum = 0;
  let rowTouchY = null;
  // 跳格方向与行高：render 时驱动"新卡从边缘挤入贴上"的整列位移动画（一次性）
  let rowStepDirection = 0;
  let rowStepPx = 48;

  // 结构指纹：不变时走「原位补丁」而非整棵 innerHTML 重建，避免打断进行中的 CSS 动画与布局抖动。
  let prevStructureKey = '';
  let prevDetailKey = '';
  // 收起时先渐隐再 hidden，避免生硬消失
  let hideTimer = null;
  const HIDE_FADE_MS = 180;
  const cancelPendingHide = () => {
    if (hideTimer === null) return;
    try { clearTimeout(hideTimer); } catch {}
    hideTimer = null;
    root?.classList?.remove?.('is-leaving');
  };
  const scheduleHide = () => {
    if (!root || root.hidden) return;
    if (hideTimer !== null) return;
    if (prefersReducedMotion() || typeof setTimeout !== 'function') {
      root.hidden = true;
      return;
    }
    root.classList.add('is-leaving');
    hideTimer = setTimeout(() => {
      hideTimer = null;
      root.classList.remove('is-leaving');
      root.hidden = true;
    }, HIDE_FADE_MS);
  };

  const computeStructureKey = (view, expanded) => {
    const runId = state?.run?.id || '';
    if (!expanded) {
      return `chip|${runId}|${view.collapsedRow?.lane?.id || ''}|${view.collapsedRow?.currentTask?.id || ''}|${view.runningTaskCount > 0 ? 1 : 0}`;
    }
    const rows = view.rows.map(row => `${row.lane.id}:${row.tasks.map(t => t.id).join(',')}`).join(';');
    return `panel|${runId}|${rowWindowStart}|${view.rows.length}|${rows}`;
  };

  const STATUS_CLASSES = ['is-queued', 'is-running', 'is-succeeded', 'is-failed', 'is-cancelled', 'is-skipped'];
  const setStatusClass = (node, status) => {
    STATUS_CLASSES.forEach(cls => node.classList.remove(cls));
    node.classList.add(`is-${status}`);
  };

  // 原位补丁：结构未变时只更新文本/状态类，保留 DOM 节点（动画不中断）
  const patchDom = (view, { enteringTaskIds, justDoneTaskIds }) => {
    if (!state.expanded) {
      const chip = root.querySelector('.creative-execution-chip');
      if (!chip) return false;
      setStatusClass(chip, view.status);
      const card = view.collapsedRow?.currentTask || null;
      const titleEl = chip.querySelector('.creative-execution-chip-title');
      if (titleEl) titleEl.textContent = card ? card.label : view.displayTitle;
      const briefEl = chip.querySelector('.creative-execution-chip-brief');
      if (briefEl) briefEl.textContent = card ? (card.summary || card.brief || view.summary) : view.summary;
      const progressEl = chip.querySelector('.creative-execution-chip-progress');
      if (progressEl) progressEl.textContent = `${view.progress.terminal}/${view.progress.total || 0}`;
      const moreEl = chip.querySelector('.creative-execution-chip-more');
      if (moreEl) moreEl.textContent = String(view.runningTaskCount);
      return true;
    }
    const panel = root.querySelector('.creative-execution-stack');
    if (!panel) return false;
    panel.classList.toggle('has-detail', Boolean(view.selectedTask));
    const progressEl = panel.querySelector('.creative-execution-stack-progress');
    if (progressEl) progressEl.textContent = `${view.progress.terminal}/${view.progress.total}`;
    const panelTitleEl = panel.querySelector('.creative-execution-stack-title');
    if (panelTitleEl) panelTitleEl.textContent = view.displayTitle;
    const panelStatusEl = panel.querySelector('.creative-execution-stack-status');
    if (panelStatusEl) {
      panelStatusEl.className = `creative-execution-stack-status is-${view.status}`;
      panelStatusEl.innerHTML = `<span aria-hidden="true"></span>${escapeHtml(view.statusText)}`;
    }
    const rowByLane = new Map(view.rows.map(row => [row.lane.id, row]));
    panel.querySelectorAll('[data-cel-row]').forEach((node) => {
      const row = rowByLane.get(node.getAttribute('data-cel-row') || '');
      if (row) node.setAttribute('data-cel-flow-status', row.flowStatus);
    });
    const taskById = new Map((view.tasks || []).map(task => [task.id, task]));
    const currentIds = new Set(view.rows.map(row => row.currentTask?.id).filter(Boolean));
    panel.querySelectorAll('[data-cel-task-id]').forEach((node) => {
      const task = taskById.get(node.getAttribute('data-cel-task-id') || '');
      if (!task) return;
      setStatusClass(node, task.status);
      node.classList.toggle('is-current', currentIds.has(task.id));
      const selected = view.selectedTask?.id === task.id;
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
      node.setAttribute('aria-label', `${task.label}，${CREATIVE_EXECUTION_STATUS_LABELS[task.status] || task.status}`);
      if (!enteringTaskIds.has(task.id)) node.classList.remove('is-entering');
      if (justDoneTaskIds.has(task.id)) {
        if (!node.classList.contains('is-just-done')) node.classList.add('is-just-done');
      } else {
        node.classList.remove('is-just-done');
      }
      const statusEl = node.querySelector('.cel-card-status');
      if (statusEl && statusEl.lastChild && statusEl.lastChild.nodeType === 3) {
        statusEl.lastChild.nodeValue = CREATIVE_EXECUTION_STATUS_LABELS[task.status] || task.status;
      }
      const titleEl = node.querySelector('.cel-card-title');
      if (titleEl) titleEl.textContent = task.label;
    });
    // 详情侧栏：仅在选中任务或其内容变化时重建
    const sel = view.selectedTask;
    const detailKey = sel ? `${sel.id}|${sel.status}|${sel.updatedAt || ''}|${sel.finishedAt || ''}` : '';
    if (detailKey !== prevDetailKey) {
      prevDetailKey = detailKey;
      const currentDetail = panel.querySelector('.creative-execution-detail');
      const template = doc.createElement('template');
      template.innerHTML = renderDetailsHtml(view).trim();
      const nextDetail = template.content.firstElementChild;
      if (nextDetail) {
        if (currentDetail) currentDetail.replaceWith(nextDetail);
        else panel.appendChild(nextDetail);
      }
    }
    return true;
  };

  const render = () => {
    if (!root || !mounted) { notifyStateChange(); return; }
    const visible = Boolean(state?.visible) && shouldShowCreativeExecutionForUiMode(getUiMode());
    if (!visible || !state) {
      scheduleHide();
      notifyStateChange();
      return;
    }
    cancelPendingHide();
    root.hidden = false;
    const orientation = resolveOrientation();
    const view = buildCreativeExecutionStackViewModel(state);
    const ts = toFiniteNumber(now(), Date.now());
    const nextRowCurrentIds = new Map();
    // 用 allRows 记录（含已结束行）：行短暂结束后追加新任务时仍能识别为“推入”而非新行
    view.allRows.forEach((row) => {
      const currentId = row.currentTask?.id || '';
      nextRowCurrentIds.set(row.lane.id, currentId);
      if (currentId && prevRowCurrentIds.has(row.lane.id) && prevRowCurrentIds.get(row.lane.id) !== currentId) {
        enteringUntil.set(currentId, ts + ENTERING_WINDOW_MS);
      }
    });
    prevRowCurrentIds = nextRowCurrentIds;
    const enteringTaskIds = new Set();
    enteringUntil.forEach((until, id) => {
      if (until > ts) enteringTaskIds.add(id);
      else enteringUntil.delete(id);
    });
    // 刚变为完成的任务：短暂闪光反馈
    const nextTaskStatuses = new Map();
    (view.tasks || []).forEach((task) => {
      nextTaskStatuses.set(task.id, task.status);
      if (task.status === 'succeeded' && prevTaskStatuses.has(task.id) && prevTaskStatuses.get(task.id) !== 'succeeded') {
        justDoneUntil.set(task.id, ts + JUST_DONE_WINDOW_MS);
      }
    });
    prevTaskStatuses = nextTaskStatuses;
    const justDoneTaskIds = new Set();
    justDoneUntil.forEach((until, id) => {
      if (until > ts) justDoneTaskIds.add(id);
      else justDoneUntil.delete(id);
    });
    const opening = state.expanded && !prevExpanded;
    prevExpanded = Boolean(state.expanded);
    rowWindowStart = Math.max(0, Math.min(rowWindowStart, Math.max(0, view.rows.length - ROWS_WINDOW_SIZE)));
    root.className = [
      'creative-execution-root',
      isFlowAttached() ? 'is-flow-attached' : '',
      state.expanded ? 'is-expanded' : '',
      `is-${view.status}`,
    ].filter(Boolean).join(' ');
    root.dataset.status = view.status;
    root.dataset.orientation = orientation;
    const structureKey = computeStructureKey(view, state.expanded);
    const canPatch = !state.board && structureKey === prevStructureKey && rowStepDirection === 0 && !opening && root.firstElementChild;
    if (!canPatch || !patchDom(view, { enteringTaskIds, justDoneTaskIds })) {
      root.innerHTML = `${state.expanded ? renderPanelHtml(view, state, { enteringTaskIds, justDoneTaskIds, opening, windowStart: rowWindowStart, windowSize: ROWS_WINDOW_SIZE }) : renderStripHtml(view, state)}`;
      const sel = view.selectedTask;
      prevDetailKey = sel ? `${sel.id}|${sel.status}|${sel.updatedAt || ''}|${sel.finishedAt || ''}` : '';
    }
    prevStructureKey = structureKey;
    if (rowStepDirection !== 0) {
      const rowsEl = root.querySelector('[data-cel-rows]');
      if (rowsEl) {
        rowsEl.style.setProperty('--cel-step', `${rowStepDirection * rowStepPx}px`);
        rowsEl.classList.add('is-stepping');
      }
      rowStepDirection = 0;
    }
    scrollRowsToCurrent();
    notifyStateChange();
  };

  const syncSelectedTaskDom = () => {
    if (!root || !state?.expanded) return false;
    const panel = root.querySelector?.('.creative-execution-stack');
    const body = panel?.querySelector?.('.creative-execution-stack-body') || panel;
    if (!panel || !body) return false;
    const view = buildCreativeExecutionStackViewModel(state);
    panel.classList.toggle('has-detail', Boolean(view.selectedTask));
    root.querySelectorAll?.('[data-cel-task-id]')?.forEach(node => {
      const selected = node.getAttribute('data-cel-task-id') === state.selectedTaskId;
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    const currentDetail = Array.from(body.children || [])
      .find(child => child?.classList?.contains?.('creative-execution-detail'));
    const template = doc.createElement('template');
    template.innerHTML = renderDetailsHtml(view).trim();
    const nextDetail = template.content.firstElementChild;
    if (!nextDetail) return false;
    if (currentDetail) currentDetail.replaceWith(nextDetail);
    else body.appendChild(nextDetail);
    const sel = view.selectedTask;
    prevDetailKey = sel ? `${sel.id}|${sel.status}|${sel.updatedAt || ''}|${sel.finishedAt || ''}` : '';
    return true;
  };

  const touchRun = (patch = {}) => {
    if (!state?.run) return;
    const ts = Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now())));
    state.run = {
      ...state.run,
      ...patch,
      updatedAt: ts,
    };
  };

  const updateTask = (taskId, updater) => {
    if (!state) return null;
    const id = normalizeId(taskId);
    let nextTask = null;
    const ts = Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now())));
    state.tasks = state.tasks.map((task, index) => {
      if (task.id !== id) return task;
      const updated = normalizeCreativeExecutionTask(updater(task, ts) || task, index);
      nextTask = updated;
      return updated;
    });
    if (nextTask) touchRun({ status: nextTask.status === 'failed' ? 'failed' : state.run.status });
    return nextTask;
  };

  const selectTask = taskId => {
    if (!state) return;
    const id = normalizeId(taskId);
    if (!state.tasks.some(task => task.id === id)) return;
    const wasExpanded = state.expanded;
    state.selectedTaskId = id;
    state.expanded = true;
    if (wasExpanded && syncSelectedTaskDom()) return;
    render();
  };

  const setTaskStatus = (taskId, status, patch = {}) => {
    const normalizedStatus = CREATIVE_EXECUTION_STATUS_LABELS[status] ? status : 'queued';
    const task = updateTask(taskId, (prev, ts) => {
      const next = {
        ...prev,
        ...patch,
        status: normalizedStatus,
        summary: truncateText(patch.summary ?? prev.summary, 140),
        brief: truncateText(patch.brief ?? prev.brief, 96),
        input: patch.input ?? prev.input,
        output: patch.output ?? prev.output,
        detail: patch.detail ?? prev.detail,
        error: patch.error ? String(patch.error) : prev.error,
        logs: mergeLogItems(prev.logs, patch.logs || []),
        updatedAt: ts,
      };
      if (normalizedStatus === 'running' && !next.startedAt) next.startedAt = ts;
      if (TERMINAL_TASK_STATUSES.has(normalizedStatus)) {
        next.finishedAt = next.finishedAt || ts;
        if (!next.startedAt) next.startedAt = ts;
      }
      return next;
    });
    if (task) {
      if (normalizedStatus === 'running') touchRun({ status: 'running', summary: task.summary || task.brief || task.label });
      if (normalizedStatus === 'failed') touchRun({ status: 'failed', summary: task.error || task.summary || task.label });
    }
    render();
    return task;
  };

  const finishRemainingTasks = status => {
    if (!state) return;
    const ts = Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now())));
    state.tasks = state.tasks.map((task, index) => {
      if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
      return normalizeCreativeExecutionTask({
        ...task,
        status,
        summary: status === 'skipped' ? '本次未触发' : task.summary,
        startedAt: task.startedAt || ts,
        updatedAt: ts,
        finishedAt: ts,
      }, index);
    });
  };

  const collapseOneLevel = () => {
    if (!state) return false;
    if (state.selectedTaskId) {
      state.selectedTaskId = '';
      if (!syncSelectedTaskDom()) render();
      return true;
    }
    if (state.expanded) {
      state.expanded = false;
      render();
      return true;
    }
    return false;
  };

  const mount = () => {
    if (!doc || !mountContainer) return false;
    if (mounted) return true;
    // 防御：清理容器内残留的旧实例（热重载/异常中断遗留），避免多 root 叠加
    try {
      mountContainer.querySelectorAll?.(':scope > .creative-execution-root').forEach(el => el.remove());
    } catch {}
    root = doc.createElement('div');
    root.className = `creative-execution-root${isFlowAttached() ? ' is-flow-attached' : ''}`;
    root.hidden = true;
    const inputRow = mountContainer.querySelector?.('.chat-input-row') || null;
    if (!isFlowAttached() && inputRow?.parentNode === mountContainer) mountContainer.insertBefore(root, inputRow);
    else mountContainer.appendChild(root);
    root.addEventListener('click', event => {
      const target = event.target;
      const toggle = target.closest?.('[data-cel-toggle]');
      if (toggle) {
        event.preventDefault();
        if (!state) return;
        state.expanded = !state.expanded;
        if (state.expanded) state.userPanned = false;
        render();
        return;
      }
      const close = target.closest?.('[data-cel-close]');
      if (close) {
        event.preventDefault();
        if (!state) return;
        state.visible = false;
        state.expanded = false;
        render();
        return;
      }
      const detailClose = target.closest?.('[data-cel-detail-close]');
      if (detailClose) {
        event.preventDefault();
        if (!state) return;
        state.selectedTaskId = '';
        if (syncSelectedTaskDom()) return;
        render();
        return;
      }
      const node = target.closest?.('[data-cel-task-id]');
      if (node) {
        event.preventDefault();
        selectTask(node.getAttribute('data-cel-task-id'));
        return;
      }
      const upstream = target.closest?.('[data-cel-jump-upstream]');
      if (upstream) {
        event.preventDefault();
        const task = state?.tasks?.find(item => item.id === upstream.getAttribute('data-cel-jump-upstream'));
        if (task?.dependsOn?.[0]) selectTask(task.dependsOn[0]);
        return;
      }
      const downstream = target.closest?.('[data-cel-jump-downstream]');
      if (downstream) {
        event.preventDefault();
        const id = downstream.getAttribute('data-cel-jump-downstream');
        const task = state?.tasks?.find(item => item.dependsOn.includes(id));
        if (task?.id) selectTask(task.id);
      }
    });
    const measureRowStep = () => {
      const row = root?.querySelector?.('.cel-row');
      if (!row) return 48;
      const styles = getWindowForDocument(doc)?.getComputedStyle?.(root.querySelector('.cel-rows'));
      const gap = styles ? parseFloat(styles.rowGap || styles.gap || '5') || 5 : 5;
      return row.offsetHeight + gap;
    };
    const applyRowScrollDelta = (delta) => {
      if (!state?.expanded) return false;
      const view = buildCreativeExecutionStackViewModel(state);
      const maxStart = Math.max(0, view.rows.length - ROWS_WINDOW_SIZE);
      if (maxStart <= 0) return false;
      rowScrollAccum += delta;
      const step = measureRowStep();
      const shift = Math.trunc(rowScrollAccum / step);
      if (!shift) return true;
      rowScrollAccum -= shift * step;
      const next = Math.max(0, Math.min(rowWindowStart + shift, maxStart));
      if (next !== rowWindowStart) {
        rowStepDirection = next > rowWindowStart ? 1 : -1;
        rowStepPx = step;
        rowWindowStart = next;
        render();
      }
      return true;
    };
    root.addEventListener('wheel', (event) => {
      if (!event.target?.closest?.('[data-cel-rows]')) return;
      if (applyRowScrollDelta(event.deltaY)) event.preventDefault();
    }, { passive: false });
    root.addEventListener('touchstart', (event) => {
      if (!event.target?.closest?.('[data-cel-rows]')) return;
      rowTouchY = event.touches?.[0]?.clientY ?? null;
    }, { passive: true });
    root.addEventListener('touchmove', (event) => {
      if (rowTouchY === null || !event.target?.closest?.('[data-cel-rows]')) return;
      const y = event.touches?.[0]?.clientY ?? rowTouchY;
      const delta = rowTouchY - y;
      rowTouchY = y;
      if (applyRowScrollDelta(delta)) event.preventDefault();
    }, { passive: false });
    root.addEventListener('touchend', () => { rowTouchY = null; }, { passive: true });
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !state) return;
      if (collapseOneLevel()) event.stopPropagation?.();
    });
    mounted = true;
    render();
    return true;
  };

  const startRun = options => {
    const startedAt = Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now())));
    state = createCreativeExecutionInitialState({
      ...options,
      now: startedAt,
    });
    setTaskStatus('input', 'running', {
      summary: summarizeRequestText(options?.text),
      logs: ['请求已进入创意写作发送链路'],
    });
    return state.run.id;
  };

  const appendTask = (task = {}) => {
    if (!state) return null;
    const laneIds = new Set((state.lanes || []).map(lane => lane.id));
    const laneId = normalizeId(task.laneId);
    if (!laneIds.has(laneId)) return null;
    const ids = new Set((state.tasks || []).map(item => item.id));
    const baseId = normalizeId(task.id) || `${laneId}-${Math.max(1, state.tasks.length + 1)}`;
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const maxBucket = state.tasks.reduce((max, item) => Math.max(max, Math.trunc(Number(item.timeBucket)) || 0), 0);
    const timeBucket = Math.max(0, Math.trunc(toFiniteNumber(task.timeBucket, maxBucket + 1)));
    const normalized = normalizeCreativeExecutionTask({
      ...task,
      id,
      laneId,
      status: task.status || 'queued',
      timeBucket,
      phaseIndex: Math.max(0, Math.trunc(toFiniteNumber(task.phaseIndex, timeBucket))),
    }, state.tasks.length);
    state.tasks = [...state.tasks, normalized];
    touchRun(normalized.status === 'running' ? { status: 'running', finishedAt: 0 } : {});
    render();
    return normalized;
  };

  const api = {
    mount,
    render,
    syncUiMode: render,
    getState: () => state,
    setExpanded(expanded) {
      if (!state) return;
      state.expanded = Boolean(expanded);
      if (state.expanded) state.userPanned = false;
      render();
    },
    setGenerationId(generationId) {
      if (!state) return;
      state.run.generationId = Number(generationId) || 0;
      state.tasks = state.tasks.map((task, index) => normalizeCreativeExecutionTask({
        ...task,
        input: task.id === 'input' && isPlainObject(task.input)
          ? { ...task.input, generationId: Number(generationId) || 0 }
          : task.input,
      }, index));
      render();
    },
    startRun,
    appendTask,
    activateTask(taskId, patch = {}) {
      return setTaskStatus(taskId, 'running', normalizePatchArg(patch));
    },
    finishTask(taskId, status = 'succeeded', patch = {}) {
      return setTaskStatus(taskId, status, normalizePatchArg(patch));
    },
    skipTask(taskId, patch = {}) {
      return setTaskStatus(taskId, 'skipped', normalizePatchArg(patch));
    },
    failTask(taskId, error, patch = {}) {
      return setTaskStatus(taskId, 'failed', {
        ...normalizePatchArg(patch),
        error: error?.message ? String(error.message) : String(error || ''),
      });
    },
    completeRun(patch = {}) {
      if (!state) return;
      finishRemainingTasks('skipped');
      touchRun({
        status: 'succeeded',
        summary: truncateText(patch.summary || '已完成 · 查看流程', 140),
        finishedAt: Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now()))),
      });
      render();
    },
    failRun(error, patch = {}) {
      if (!state) return;
      const running = state.tasks.find(task => RUNNING_TASK_STATUSES.has(task.status));
      if (running) api.failTask(running.id, error, patch);
      finishRemainingTasks('skipped');
      touchRun({
        status: 'failed',
        summary: truncateText(error?.message || error || patch.summary || '执行失败', 140),
        finishedAt: Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now()))),
      });
      render();
    },
    cancelRun(reason = 'user') {
      if (!state) return;
      state.tasks = state.tasks.map((task, index) => {
        if (task.status === 'running') {
          return normalizeCreativeExecutionTask({
            ...task,
            status: 'cancelled',
            summary: '已取消',
            error: String(reason || ''),
            finishedAt: Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now()))),
          }, index);
        }
        if (task.status === 'queued') {
          return normalizeCreativeExecutionTask({ ...task, status: 'skipped', summary: '取消后跳过' }, index);
        }
        return task;
      });
      touchRun({
        status: 'cancelled',
        summary: '已取消 · 查看流程',
        finishedAt: Math.max(0, Math.trunc(toFiniteNumber(now(), Date.now()))),
      });
      render();
    },
    markPostModelTasksRunning(summary = '模型回复已返回，处理后续任务', taskIds = ['memory']) {
      const ids = Array.isArray(taskIds) && taskIds.length ? taskIds : ['memory'];
      ids.forEach(taskId => {
        const task = state?.tasks?.find(item => item.id === taskId);
        if (task?.status === 'queued') {
          setTaskStatus(taskId, 'running', { summary });
        }
      });
    },
    selectTask,
    collapseOneLevel,
    getProjectionSnapshot: () => buildCreativeExecutionProjectionSnapshot(state, { uiMode: getUiMode() }),
    getElement: () => root,
    setMountContainer(container) {
      if (!container) return false;
      mountContainer = container;
      if (!mounted) return mount();
      if (root?.parentNode !== mountContainer) mountContainer.appendChild(root);
      render();
      return true;
    },
    hide() {
      if (!state) return;
      state.visible = false;
      state.expanded = false;
      render();
    },
  };

  if (!mounted) {
    try {
      mount();
    } catch (err) {
      logger?.warn?.('creative execution lane mount failed', err);
    }
  }
  return api;
};
