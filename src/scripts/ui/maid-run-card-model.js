/* 女仆运行卡视图模型（纯函数）：把执行流投影转换成“一次任务一个对象”的卡片数据。
   状态靠图标形状 + 颜色 + 头部文字三重表达；过程（已完成步骤、参数、思路）默认折叠，
   当前步、待确认与失败放大。设计见 docs/maid-run-card-design.md。 */

import { t } from '../i18n/index.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

// 已完成步骤超过该数量时收成一行“已完成 N 步”
export const MAID_RUN_FOLD_THRESHOLD = 2;

const RUN_STATE_BY_STATUS = Object.freeze({
  queued: 'running',
  running: 'running',
  waiting_permission: 'waiting',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
});

const ROW_STATUS_BY_STEP = Object.freeze({
  queued: 'queued',
  running: 'running',
  waiting_permission: 'waiting',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
});

export const maidRunStateLabel = state => ({
  running: t('执行中'),
  waiting: t('等你确认'),
  done: t('已完成'),
  failed: t('失败'),
  cancelled: t('已停止'),
}[state] || t('执行中'));

export const formatMaidRunElapsed = (ms = 0) => {
  const value = Math.max(0, Number(ms) || 0) / 1000;
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${String(Math.floor(value % 60)).padStart(2, '0')}s`;
};

// 参数里可能夹带密钥或凭据：按键名脱敏，值只保留短摘要
const SECRET_KEY_PATTERN = /(?:api[-_]?key|secret|token|password|passwd|authorization|credential|cookie)/i;
const TARGET_KEYS = Object.freeze([
  'name', 'names', 'title', 'sessionName', 'sessionNames', 'targetName', 'personaName', 'personaNames',
  'worldbookName', 'worldbook', 'userName', 'query', 'keyword', 'url', 'path',
]);
const MAX_ARG_ENTRIES = 6;

const shortText = (value, max = 80) => {
  const text = trim(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const formatArgValue = (value, max = 80) => {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? t('是') : t('否');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return shortText(value, max);
  if (Array.isArray(value)) {
    const items = value.map(item => formatArgValue(item, 24)).filter(Boolean);
    if (!items.length) return '';
    const head = items.slice(0, 3).join('、');
    return shortText(items.length > 3 ? `${head} +${items.length - 3}` : head, max);
  }
  try {
    return shortText(JSON.stringify(value), max);
  } catch {
    return '';
  }
};

export const summarizeMaidToolArgs = (args = null) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.entries(args)
    .filter(([key]) => !String(key).startsWith('_'))
    .map(([key, value]) => [key, SECRET_KEY_PATTERN.test(key) ? '••••' : formatArgValue(value)])
    .filter(([, value]) => value !== '')
    .slice(0, MAX_ARG_ENTRIES);
};

export const resolveMaidToolTarget = (args = null) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of TARGET_KEYS) {
    if (!(key in args) || SECRET_KEY_PATTERN.test(key)) continue;
    const text = formatArgValue(args[key], 28);
    if (text) return text;
  }
  return '';
};

const stepDuration = (step = {}) => {
  const started = Number(step.startedAt) || 0;
  const finished = Number(step.finishedAt) || 0;
  return started && finished >= started ? finished - started : 0;
};

export const buildMaidRunCardModel = (view = null) => {
  if (!view || !trim(view.runId)) return null;
  const state = RUN_STATE_BY_STATUS[trim(view.status, 'running')] || 'running';
  const terminal = ['done', 'failed', 'cancelled'].includes(state);
  const rows = (Array.isArray(view.steps) ? view.steps : []).map((step, index) => {
    let status = ROW_STATUS_BY_STEP[trim(step?.status, 'running')] || 'running';
    // 等待授权挂在 run 上：把正在执行的那一步显示为“等你确认”
    if (state === 'waiting' && status === 'running') status = 'waiting';
    // run 已结束但步骤未收尾（例如被中止）：不再显示旋转
    if (terminal && ['running', 'queued', 'waiting'].includes(status)) status = state === 'cancelled' ? 'cancelled' : 'skipped';
    const title = trim(step?.title, trim(step?.toolName, t('步骤 {index}', { index: index + 1 })));
    const resultSummary = trim(step?.resultSummary);
    return {
      id: trim(step?.id, `step_${index}`),
      seq: index + 1,
      status,
      title,
      target: resolveMaidToolTarget(step?.args),
      toolName: trim(step?.toolName),
      error: trim(step?.error),
      durationMs: stepDuration(step),
      args: summarizeMaidToolArgs(step?.args),
      result: resultSummary && resultSummary !== title ? resultSummary : '',
    };
  });
  // 进度只数成功完成的步骤：失败/跳过不算“做完”，否则失败任务会显示 5/5
  const doneCount = rows.filter(row => row.status === 'done').length;
  const currentIndex = rows.findIndex(row => ['running', 'waiting'].includes(row.status));
  return {
    runId: trim(view.runId),
    source: trim(view.source),
    executionModel: trim(view.executionModel),
    title: trim(view.title, t('女仆任务')),
    state,
    stateLabel: maidRunStateLabel(state),
    terminal,
    doneCount,
    total: rows.length,
    currentSeq: currentIndex >= 0 ? currentIndex + 1 : Math.min(rows.length, doneCount + 1),
    startedAt: Number(view.startedAt) || 0,
    finishedAt: Number(view.finishedAt) || (terminal ? Number(view.updatedAt) || 0 : 0),
    rows,
  };
};

/* 可见行：进行中时把超过阈值的已完成步骤收成一行；失败时同样保留失败步。
   返回 { foldedCount, rows }，foldedCount>0 时渲染“已完成 N 步”。 */
export const resolveMaidRunVisibleRows = (model = null, { foldOpen = false } = {}) => {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const done = rows.filter(row => row.status === 'done');
  if (foldOpen || model?.state === 'done' || done.length <= MAID_RUN_FOLD_THRESHOLD) {
    return { foldedCount: 0, rows };
  }
  return { foldedCount: done.length, rows: rows.filter(row => row.status !== 'done') };
};

/* 终态后默认收起步骤，只留头部（汇报气泡在卡外显示）；失败保持展开以便看到原因。 */
export const isMaidRunCollapsedByDefault = model => model?.state === 'done' || model?.state === 'cancelled';

/* 语音任务三拍摘要：接收 → 执行 → 汇报。只给一句话，不列步骤。 */
export const buildMaidVoiceTaskSummary = (task = null, { approvalPending = false } = {}) => {
  if (!task) return null;
  const status = trim(task.status, 'running');
  const message = trim(task.message);
  const request = trim(task.request);
  if (approvalPending) {
    return { beat: 1, tone: 'warning', beatLabel: t('等你确认'), line: message || t('需要你确认'), request };
  }
  if (status === 'queued') return { beat: 0, tone: 'accent', beatLabel: t('接收'), line: t('已接收，排队中'), request };
  if (status === 'running') {
    const started = Boolean(message) && message !== t('正在处理');
    return started
      ? { beat: 1, tone: 'accent', beatLabel: t('执行'), line: message, request }
      : { beat: 0, tone: 'accent', beatLabel: t('接收'), line: t('已接收，马上开始'), request };
  }
  if (status === 'succeeded') return { beat: 2, tone: 'success', beatLabel: t('汇报'), line: message || t('已完成。'), request };
  if (status === 'awaiting_confirmation') return { beat: 1, tone: 'warning', beatLabel: t('等你确认'), line: message, request };
  if (status === 'cancelled') return { beat: 1, tone: 'muted', beatLabel: t('已停止'), line: message || t('任务已终止。'), request };
  return { beat: 1, tone: 'danger', beatLabel: t('失败'), line: message || t('执行失败。'), request };
};
