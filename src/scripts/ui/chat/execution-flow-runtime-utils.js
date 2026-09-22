/* 执行流面板（Phase 1/2：女仆 ReAct + 创意写作泳道双投影）
   贴靠模式切换悬浮球（女仆位置，可拖拽不遮挡固定区域），订阅 agentTaskRuntime 事件流，
   把女仆 run 的规划/工具步骤/终态投影成卡式轨迹流，实时追加。
   审美取自参考稿 autonomous-agent-architecture-design（卡式时间轴/汉字铭牌/mono 小标签/轨迹线），
   颜色全部映射 --app-* token，明暗双主题与 reduced-motion 均成立。
   两者数据模型不合并，只共享贴球外壳、状态色语义与投影仲裁。 */

const STYLE_ID = 'execution-flow-runtime-style';
const MAID_RUN_KIND = 'maid_assistant';
const PANEL_WIDTH = 332;
const CREATIVE_PANEL_WIDTH = 420;
const VIEWPORT_GUTTER = 12;
const BALL_PANEL_GAP = 10;
const ANCHOR_EDGE_PADDING = 12;

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* 状态语义（与泳道六态同一色系；waiting_permission 归入等待色） */
export const EXEC_FLOW_STATUS_META = Object.freeze({
  queued: { label: '排队', tone: 'muted' },
  running: { label: '执行中', tone: 'accent' },
  waiting_permission: { label: '等待授权', tone: 'warning' },
  succeeded: { label: '完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'warning' },
  skipped: { label: '跳过', tone: 'muted' },
});

const statusMeta = status => EXEC_FLOW_STATUS_META[status] || EXEC_FLOW_STATUS_META.queued;

const projectionStartedAt = projection => (
  Number(projection?.startedAt) || Number(projection?.updatedAt) || 0
);

/* 双投影仲裁（纯函数）：新 run 到达时按活跃启动时间；其余时间保持用户选择。 */
export const resolveExecutionFlowActiveKind = ({
  maid = null,
  creative = null,
  preferredKind = '',
  preferLatestActive = false,
} = {}) => {
  const visible = [
    ['maid', maid],
    ['creative', creative],
  ].filter(([, projection]) => projection?.visible === true);
  if (!visible.length) return '';
  if (!preferLatestActive && visible.some(([kind]) => kind === preferredKind)) return preferredKind;
  const active = visible.filter(([, projection]) => projection?.terminal !== true);
  const candidates = active.length ? active : visible;
  return candidates
    .slice()
    .sort((a, b) => projectionStartedAt(b[1]) - projectionStartedAt(a[1]))[0]?.[0] || '';
};

/* 女仆 run → 轨迹流视图（纯函数，供渲染与测试） */
export const projectMaidRunToTraceView = (run = null) => {
  if (!run || typeof run !== 'object') return null;
  const status = trim(run.status, 'running');
  const steps = (Array.isArray(run.steps) ? run.steps : []).map((step, index) => {
    const stepStatus = trim(step?.status, 'running');
    const stepMeta = statusMeta(stepStatus);
    return {
      id: trim(step?.id, `step_${index}`),
      seq: index + 1,
      title: trim(step?.summary, trim(step?.input?.toolName, `步骤 ${index + 1}`)),
      toolName: trim(step?.input?.toolName),
      status: stepStatus,
      statusLabel: stepMeta.label,
      tone: stepMeta.tone,
      glyph: stepStatus === 'failed' ? '败' : stepStatus === 'succeeded' ? '成' : stepStatus === 'cancelled' ? '止' : '行',
      error: trim(step?.errorMessage),
    };
  });
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
  const doneCount = steps.filter(step => ['succeeded', 'failed', 'cancelled', 'skipped'].includes(step.status)).length;
  return {
    runId: trim(run.id),
    source: trim(run.metadata?.submissionSource),
    submissionId: trim(run.metadata?.submissionId),
    title: trim(run.metadata?.goal, trim(run.title, '女仆任务')),
    status,
    statusLabel: statusMeta(status).label,
    tone: statusMeta(status).tone,
    steps,
    stepDone: doneCount,
    stepTotal: steps.length,
    terminal,
    doneSummary: terminal ? trim(run.summary) : '',
    failureCode: trim(run.metadata?.failureCode),
    startedAt: Number(run.createdAt || run.startedAt || run.metadata?.startedAt) || 0,
    updatedAt: Number(run.updatedAt || run.finishedAt || run.createdAt) || 0,
  };
};

/* 面板贴球定位（纯函数）：优先正下/正上，越界只平移面板，锚点仍朝向球心。 */
export const resolveExecFlowPlacement = ({
  ballRect = { left: 0, top: 0, width: 26, height: 26 },
  viewport = { w: 0, h: 0 },
  panelSize = { width: PANEL_WIDTH, height: 220 },
  occupiedSide = '',
} = {}) => {
  const w = Number(viewport.w) || 0;
  const h = Number(viewport.h) || 0;
  const ballLeft = Number(ballRect.left) || 0;
  const ballTop = Number(ballRect.top) || 0;
  const ballWidth = Math.max(0, Number(ballRect.width) || 0);
  const ballHeight = Math.max(0, Number(ballRect.height) || 0);
  const panelWidth = Math.max(1, Number(panelSize.width) || PANEL_WIDTH);
  const panelHeight = Math.max(1, Number(panelSize.height) || 1);
  const cx = ballLeft + ballWidth / 2;
  const ballBottom = ballTop + ballHeight;
  const width = Math.min(panelWidth, w ? Math.max(1, w - VIEWPORT_GUTTER * 2) : panelWidth);
  const bottomSpace = h ? h - ballBottom - BALL_PANEL_GAP - VIEWPORT_GUTTER : panelHeight;
  const topSpace = h ? ballTop - BALL_PANEL_GAP - VIEWPORT_GUTTER : panelHeight;
  let side = bottomSpace >= panelHeight || bottomSpace >= topSpace ? 'bottom' : 'top';
  if (occupiedSide === side) side = side === 'bottom' ? 'top' : 'bottom';
  const left = w
    ? clamp(cx - width / 2, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, w - width - VIEWPORT_GUTTER))
    : cx - width / 2;
  const top = side === 'bottom'
    ? (h
      ? clamp(ballBottom + BALL_PANEL_GAP, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, h - panelHeight - VIEWPORT_GUTTER))
      : ballBottom + BALL_PANEL_GAP)
    : (h
      ? clamp(ballTop - BALL_PANEL_GAP - panelHeight, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, h - panelHeight - VIEWPORT_GUTTER))
      : ballTop - BALL_PANEL_GAP - panelHeight);
  const anchorPadding = Math.min(ANCHOR_EDGE_PADDING, width / 2);
  const anchorX = clamp(cx - left, anchorPadding, Math.max(anchorPadding, width - anchorPadding));
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    anchorX: Math.round(anchorX),
    side,
  };
};

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.exec-flow-root {
  position: fixed;
  z-index: 26080;
  display: none;
  font-family: inherit;
  --ef-anchor-x: 50%;
  --ef-surface: var(--app-surface-card, #fff);
  --ef-subtle: var(--app-surface-subtle, #f8fafc);
  --ef-border: var(--app-border-default, rgba(148, 163, 184, 0.30));
  --ef-text: var(--app-text-primary, #111827);
  --ef-text-2: var(--app-text-secondary, #475569);
  --ef-muted: var(--app-text-muted, rgba(100, 116, 139, 0.8));
  --ef-accent-rgb: var(--app-accent-rgb, 59, 130, 246);
  --ef-success-rgb: var(--app-success-rgb, 34, 197, 94);
  --ef-danger-rgb: var(--app-danger-rgb, 239, 68, 68);
  --ef-warning-rgb: var(--app-warning-rgb, 245, 158, 11);
}
.exec-flow-root::before,
.exec-flow-root::after {
  content: '';
  position: absolute;
  left: var(--ef-anchor-x);
  z-index: -1;
  pointer-events: none;
}
.exec-flow-root::before {
  width: 2px;
  height: ${BALL_PANEL_GAP}px;
  margin-left: -1px;
  border-radius: 999px;
  opacity: 0.68;
  box-shadow: 0 0 7px rgba(var(--ef-accent-rgb), 0.36);
}
.exec-flow-root::after {
  width: 5px;
  height: 5px;
  margin-left: -2.5px;
  border-radius: 50%;
  background: rgb(var(--ef-accent-rgb));
  box-shadow: 0 0 0 2px rgba(var(--ef-accent-rgb), 0.10), 0 0 8px rgba(var(--ef-accent-rgb), 0.62);
  animation: efAnchorBreathe 1.8s ease-in-out infinite;
}
.exec-flow-root[data-side='bottom']::before {
  top: -${BALL_PANEL_GAP}px;
  background: linear-gradient(to bottom, rgba(var(--ef-accent-rgb), 0.18), rgba(var(--ef-accent-rgb), 0.82));
}
.exec-flow-root[data-side='bottom']::after { top: -12.5px; }
.exec-flow-root[data-side='top']::before {
  bottom: -${BALL_PANEL_GAP}px;
  background: linear-gradient(to top, rgba(var(--ef-accent-rgb), 0.18), rgba(var(--ef-accent-rgb), 0.82));
}
.exec-flow-root[data-side='top']::after { bottom: -12.5px; }
@keyframes efAnchorBreathe {
  0%, 100% { opacity: 0.48; }
  50% { opacity: 0.96; }
}
.exec-flow-root.is-visible {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.exec-flow-projection-switcher {
  display: none;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--ef-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ef-surface) 94%, var(--ef-subtle));
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
}
.exec-flow-root.has-multiple .exec-flow-projection-switcher { display: flex; }
.exec-flow-projection-tab {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px 3px 4px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ef-muted);
  font-size: 10px;
  cursor: pointer;
}
.exec-flow-projection-tab.is-active {
  background: rgba(var(--ef-accent-rgb), 0.12);
  color: var(--ef-text);
}
.exec-flow-projection-tab .exec-flow-mark { width: 17px; height: 17px; font-size: 10px; }
.exec-flow-projection-tab .exec-flow-dot { width: 5px; height: 5px; }
.exec-flow-maid-host[hidden],
.exec-flow-creative-host[hidden] { display: none !important; }
.exec-flow-creative-host { min-width: 0; width: 100%; }
.exec-flow-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 6px 11px 6px 8px;
  border: 1px solid var(--ef-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ef-surface) 94%, var(--ef-subtle));
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.16);
  color: var(--ef-text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.exec-flow-mark {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(var(--ef-accent-rgb), 0.14);
  color: var(--ef-text);
  font-family: Georgia, 'Songti SC', 'Noto Serif SC', serif;
  font-style: italic;
  font-weight: 700;
  font-size: 12px;
}
.exec-flow-chip-title {
  max-width: 148px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
}
.exec-flow-chip-progress {
  font-family: ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--ef-muted);
}
.exec-flow-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.exec-flow-dot[data-tone='accent'] { background: rgb(var(--ef-accent-rgb)); animation: efPulse 1.4s ease-in-out infinite; }
.exec-flow-dot[data-tone='success'] { background: rgb(var(--ef-success-rgb)); }
.exec-flow-dot[data-tone='danger'] { background: rgb(var(--ef-danger-rgb)); }
.exec-flow-dot[data-tone='warning'] { background: rgb(var(--ef-warning-rgb)); animation: efPulse 1.1s ease-in-out infinite; }
.exec-flow-dot[data-tone='muted'] { background: var(--ef-muted); }
@keyframes efPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--ef-accent-rgb), 0.35); }
  50% { box-shadow: 0 0 0 5px rgba(var(--ef-accent-rgb), 0.10); }
}
.exec-flow-panel {
  display: none;
  flex-direction: column;
  max-height: min(46vh, 400px);
  border: 1px solid var(--ef-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--ef-surface) 96%, var(--ef-subtle));
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
  color: var(--ef-text);
  overflow: hidden;
}
.exec-flow-root.is-expanded .exec-flow-chip { display: none; }
.exec-flow-root.is-expanded .exec-flow-panel { display: flex; }
.exec-flow-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  border-bottom: 1px solid var(--ef-border);
  cursor: grab;
}
.exec-flow-kicker {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.exec-flow-kicker-label {
  font-family: ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--ef-muted);
  flex: 0 0 auto;
}
.exec-flow-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 700;
}
.exec-flow-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--ef-text-2);
}
.exec-flow-btn {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ef-muted);
  font-size: 13px;
  cursor: pointer;
}
.exec-flow-btn:hover { background: var(--ef-subtle); color: var(--ef-text); }
.exec-flow-btn.is-stop { color: rgb(var(--ef-danger-rgb)); }
.exec-flow-btn.is-stop svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.exec-flow-btn.is-stop:hover { background: rgba(var(--ef-danger-rgb), 0.10); }
.exec-flow-btn[hidden] { display: none !important; }
.exec-flow-stream {
  overflow-y: auto;
  padding: 10px 12px 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  scrollbar-width: thin;
}
.exec-flow-stream::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: rgba(var(--ef-accent-rgb), 0.20);
}
.exec-step {
  position: relative;
  border: 1px solid var(--ef-border);
  border-radius: 12px;
  background: var(--ef-surface);
  padding: 7px 10px;
  animation: efSlideIn 0.22s ease;
}
.exec-step::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ef-muted);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ef-surface) 96%, var(--ef-subtle));
}
.exec-step[data-tone='accent']::before { background: rgb(var(--ef-accent-rgb)); animation: efPulse 1.4s ease-in-out infinite; }
.exec-step[data-tone='success']::before { background: rgb(var(--ef-success-rgb)); }
.exec-step[data-tone='danger']::before { background: rgb(var(--ef-danger-rgb)); }
.exec-step[data-tone='warning']::before { background: rgb(var(--ef-warning-rgb)); animation: efPulse 1.1s ease-in-out infinite; }
.exec-step[data-tone='danger'] { border-color: rgba(var(--ef-danger-rgb), 0.45); }
@keyframes efSlideIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.exec-step-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.exec-step-glyph {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(var(--ef-accent-rgb), 0.10);
  font-family: Georgia, 'Songti SC', 'Noto Serif SC', serif;
  font-size: 11px;
  font-weight: 700;
}
.exec-step[data-tone='danger'] .exec-step-glyph { background: rgba(var(--ef-danger-rgb), 0.12); }
.exec-step[data-tone='success'] .exec-step-glyph { background: rgba(var(--ef-success-rgb), 0.12); }
.exec-step-label {
  font-family: ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--ef-muted);
  flex: 0 0 auto;
}
.exec-step-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
}
.exec-step-status {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--ef-text-2);
}
.exec-step-body {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--ef-text-2);
  word-break: break-word;
}
.exec-step-body.is-error { color: rgb(var(--ef-danger-rgb)); }
body[data-reduced-motion='on'] .exec-flow-dot,
body[data-reduced-motion='on'] .exec-step::before { animation: none !important; }
body[data-reduced-motion='on'] .exec-step { animation: none !important; }
body[data-reduced-motion='on'] .exec-flow-root::after { animation: none !important; opacity: 0.72; }
@media (prefers-reduced-motion: reduce) {
  .exec-flow-root::after,
  .exec-flow-dot,
  .exec-step,
  .exec-step::before { animation: none !important; }
}
`;
  documentRef.head.appendChild(style);
};

export const createExecutionFlowRuntime = ({
  documentRef = globalThis?.document || null,
  modeSwitchEl = null,
  agentTaskRuntime = null,
  getViewportSize = () => ({ w: 0, h: 0 }),
  getBallDragRuntime = null,
  setTimeoutFn = globalThis?.setTimeout || null,
  // 女仆投影的首选画布：指令条结果流（返回 true 表示已消费，不再自开面板，避免双流）
  onMaidTrace = null,
  onCancelMaidRun = null,
} = {}) => {
  let rootEl = null;
  let chipEl = null;
  let panelEl = null;
  let streamEl = null;
  let headTitleEl = null;
  let headStatusEl = null;
  let cancelMaidBtnEl = null;
  let maidHostEl = null;
  let creativeHostEl = null;
  let switcherEl = null;
  let creativeRuntime = null;
  let unsubscribe = null;
  let keydownHandler = null;
  let maidTraceConsumerRunId = '';
  const state = {
    visible: false,
    expanded: false,
    runId: '',
    view: null,
    signature: '',
    creative: null,
    activeKind: '',
  };

  const maidProjection = () => state.view ? {
    kind: 'maid',
    visible: state.visible,
    expanded: state.expanded,
    runId: state.runId,
    status: state.view.status,
    terminal: state.view.terminal,
    startedAt: state.view.startedAt,
    updatedAt: state.view.updatedAt,
  } : null;

  const reconcileActiveKind = ({ preferLatestActive = false } = {}) => {
    state.activeKind = resolveExecutionFlowActiveKind({
      maid: maidProjection(),
      creative: state.creative,
      preferredKind: state.activeKind,
      preferLatestActive,
    });
    return state.activeKind;
  };

  const activeProjection = () => state.activeKind === 'creative' ? state.creative : maidProjection();
  const activeExpanded = () => Boolean(activeProjection()?.expanded);
  const visibleProjectionKinds = () => [
    maidProjection()?.visible ? 'maid' : '',
    state.creative?.visible ? 'creative' : '',
  ].filter(Boolean);

  const projectionTone = projection => statusMeta(projection?.status).tone;

  const renderSwitcher = () => {
    if (!switcherEl) return;
    const kinds = visibleProjectionKinds();
    switcherEl.hidden = kinds.length < 2;
    if (kinds.length < 2) {
      switcherEl.innerHTML = '';
      return;
    }
    switcherEl.innerHTML = kinds.map((kind) => {
      const projection = kind === 'maid' ? maidProjection() : state.creative;
      const label = kind === 'maid' ? '女仆' : '创作';
      const mark = kind === 'maid' ? '侍' : '创';
      return `<button type="button" class="exec-flow-projection-tab${state.activeKind === kind ? ' is-active' : ''}" data-ef-switch="${kind}" aria-pressed="${state.activeKind === kind ? 'true' : 'false'}"><span class="exec-flow-mark">${mark}</span><span>${label}</span><span class="exec-flow-dot" data-tone="${projectionTone(projection)}"></span></button>`;
    }).join('');
  };

  const ensure = () => {
    if (rootEl || !documentRef?.body) return rootEl;
    injectStyle(documentRef);
    rootEl = documentRef.createElement?.('div');
    if (!rootEl) return null;
    rootEl.className = 'exec-flow-root';
    rootEl.innerHTML = `
      <div class="exec-flow-projection-switcher" data-ef-switcher hidden></div>
      <div class="exec-flow-maid-host">
        <button type="button" class="exec-flow-chip" data-ef-toggle aria-label="展开女仆执行流">
          <span class="exec-flow-mark">侍</span>
          <span class="exec-flow-chip-title" data-ef-chip-title></span>
          <span class="exec-flow-chip-progress" data-ef-chip-progress></span>
          <span class="exec-flow-dot" data-ef-chip-dot data-tone="accent"></span>
        </button>
        <section class="exec-flow-panel" aria-label="女仆执行流">
          <div class="exec-flow-head">
            <span class="exec-flow-mark">侍</span>
            <div class="exec-flow-kicker">
              <span class="exec-flow-kicker-label">MAID · RUN</span>
              <span class="exec-flow-title" data-ef-title></span>
            </div>
            <span class="exec-flow-status" data-ef-status></span>
            <button type="button" class="exec-flow-btn is-stop" data-ef-cancel-maid aria-label="停止女仆任务"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg></button>
            <button type="button" class="exec-flow-btn" data-ef-toggle aria-label="收起">–</button>
            <button type="button" class="exec-flow-btn" data-ef-close aria-label="关闭">×</button>
          </div>
          <div class="exec-flow-stream" data-ef-stream data-ef-scroll="1"></div>
        </section>
      </div>
      <div class="exec-flow-creative-host" hidden></div>
    `;
    switcherEl = rootEl.querySelector?.('[data-ef-switcher]') || null;
    maidHostEl = rootEl.querySelector?.('.exec-flow-maid-host') || null;
    creativeHostEl = rootEl.querySelector?.('.exec-flow-creative-host') || null;
    chipEl = rootEl.querySelector?.('.exec-flow-chip') || null;
    panelEl = rootEl.querySelector?.('.exec-flow-panel') || null;
    streamEl = rootEl.querySelector?.('[data-ef-stream]') || null;
    headTitleEl = rootEl.querySelector?.('[data-ef-title]') || null;
    headStatusEl = rootEl.querySelector?.('[data-ef-status]') || null;
    cancelMaidBtnEl = rootEl.querySelector?.('[data-ef-cancel-maid]') || null;
    rootEl.addEventListener?.('click', (event) => {
      const target = event?.target || null;
      const switchTarget = target?.closest?.('[data-ef-switch]');
      if (switchTarget) {
        const kind = trim(switchTarget.getAttribute?.('data-ef-switch'));
        if (visibleProjectionKinds().includes(kind)) {
          state.activeKind = kind;
          render();
        }
        return;
      }
      if (target?.closest?.('[data-ef-close]')) {
        setVisible(false);
        return;
      }
      if (target?.closest?.('[data-ef-cancel-maid]')) {
        if (state.view?.terminal !== true) {
          void onCancelMaidRun?.({ runId: state.runId, view: state.view });
        }
        return;
      }
      if (target?.closest?.('[data-ef-toggle]')) {
        state.expanded = !state.expanded;
        render();
      }
    });
    // 非交互区按下 → 转发球拖拽（与指令条同通道，面板随球走）
    rootEl.addEventListener?.('pointerdown', (event) => {
      const target = event?.target || null;
      const interactive = typeof target?.closest === 'function'
        ? target.closest('button, a, input, textarea, select, details, summary, [data-ef-scroll], .exec-flow-stream')
        : null;
      if (interactive) return;
      const ballDrag = typeof getBallDragRuntime === 'function' ? getBallDragRuntime() : null;
      if (!ballDrag?.startDrag) return;
      ballDrag.startDrag(event, { suppressLongPress: true, suppressClick: true });
    });
    keydownHandler = (event) => {
      if (event?.key !== 'Escape' || !state.activeKind) return;
      if (state.activeKind === 'creative') {
        creativeRuntime?.collapseOneLevel?.();
        return;
      }
      if (state.expanded) {
        state.expanded = false;
        render();
      }
    };
    documentRef.addEventListener?.('keydown', keydownHandler);
    documentRef.body.appendChild(rootEl);
    return rootEl;
  };

  const setVisible = (next) => {
    state.visible = next === true;
    if (!state.visible) state.expanded = false;
    reconcileActiveKind();
    render();
  };

  const position = () => {
    if (!rootEl || !state.activeKind) return;
    const viewport = getViewportSize?.() || {};
    const w = Number(viewport.w || globalThis?.innerWidth || 0) || 0;
    const h = Number(viewport.h || globalThis?.innerHeight || 0) || 0;
    const ballRect = modeSwitchEl?.getBoundingClientRect?.() || { left: 24, top: 24, width: 26, height: 26 };
    const isExpanded = activeExpanded();
    const desiredWidth = state.activeKind === 'creative' ? CREATIVE_PANEL_WIDTH : PANEL_WIDTH;
    if (isExpanded) {
      const availableWidth = w ? Math.max(1, w - VIEWPORT_GUTTER * 2) : desiredWidth;
      rootEl.style.width = `${Math.round(Math.min(desiredWidth, availableWidth))}px`;
    } else {
      // 展开态留下的 inline width 会污染缩略态量测；先还原自适应宽度再读取实际胶囊尺寸。
      rootEl.style.width = 'auto';
    }
    const rect = rootEl.getBoundingClientRect?.() || {};
    const measuredWidth = Math.max(40, Number(rect.width || 0)
      || (isExpanded ? desiredWidth : Math.min(desiredWidth, 320)));
    const panelHeight = Math.max(40, Number(rect.height || 0) || (isExpanded ? 260 : 36));
    // 指令条打开时其结果气泡占用一侧，翻到对侧避让
    const pill = documentRef?.querySelector?.('.maid-command-input.is-open');
    const occupiedSide = trim(pill?.dataset?.bubbleSide);
    const placed = resolveExecFlowPlacement({
      ballRect,
      viewport: { w, h },
      panelSize: { width: measuredWidth, height: panelHeight },
      occupiedSide,
    });
    rootEl.style.left = `${placed.left}px`;
    rootEl.style.top = `${placed.top}px`;
    rootEl.dataset.side = placed.side;
    rootEl.style.setProperty('--ef-anchor-x', `${placed.anchorX}px`);
    if (isExpanded) rootEl.style.width = `${placed.width}px`;
    else rootEl.style.width = 'auto';
    if (panelEl) panelEl.style.width = state.activeKind === 'maid' && isExpanded ? '100%' : 'auto';
  };

  const renderStepHtml = (step) => {
    const meta = statusMeta(step.status);
    const glyph = step.glyph || '行';
    const label = `TOOL·${String(step.seq).padStart(2, '0')}`;
    const body = step.error
      ? `<div class="exec-step-body is-error">${escapeHtml(step.error)}</div>`
      : (step.toolName && step.toolName !== step.title
        ? `<div class="exec-step-body">${escapeHtml(step.toolName)}</div>`
        : '');
    return `
      <div class="exec-step" data-tone="${meta.tone}" data-ef-step="${escapeHtml(step.id)}">
        <div class="exec-step-head">
          <span class="exec-step-glyph">${glyph}</span>
          <span class="exec-step-label">${label}</span>
          <span class="exec-step-title">${escapeHtml(step.title)}</span>
          <span class="exec-step-status">${meta.label}</span>
        </div>
        ${body}
      </div>
    `;
  };

  const render = () => {
    if (!ensure()) return;
    reconcileActiveKind();
    const visibleKinds = visibleProjectionKinds();
    rootEl.classList.toggle('is-visible', Boolean(state.activeKind));
    rootEl.classList.toggle('is-expanded', activeExpanded());
    rootEl.classList.toggle('has-multiple', visibleKinds.length > 1);
    rootEl.dataset.activeKind = state.activeKind;
    if (maidHostEl) maidHostEl.hidden = state.activeKind !== 'maid';
    if (creativeHostEl) creativeHostEl.hidden = state.activeKind !== 'creative';
    renderSwitcher();
    const view = state.view;
    if (!state.activeKind) {
      position();
      return;
    }
    if (!view) {
      position();
      return;
    }
    const chipTitle = rootEl.querySelector?.('[data-ef-chip-title]');
    const chipProgress = rootEl.querySelector?.('[data-ef-chip-progress]');
    const chipDot = rootEl.querySelector?.('[data-ef-chip-dot]');
    if (chipTitle) chipTitle.textContent = view.title;
    if (chipProgress) chipProgress.textContent = view.stepTotal ? `${view.stepDone}/${view.stepTotal}` : '';
    if (chipDot) chipDot.setAttribute?.('data-tone', view.tone);
    if (headTitleEl) headTitleEl.textContent = view.title;
    if (headStatusEl) {
      headStatusEl.innerHTML = `<span class="exec-flow-dot" data-tone="${view.tone}"></span>${escapeHtml(view.statusLabel)}`;
    }
    if (cancelMaidBtnEl) cancelMaidBtnEl.hidden = view.terminal === true;
    if (streamEl) {
      const signature = JSON.stringify([
        view.runId,
        view.status,
        view.steps.map(step => [step.id, step.status, step.title, step.error]),
        view.doneSummary,
      ]);
      if (signature !== state.signature) {
        state.signature = signature;
        const planCard = `
          <div class="exec-step" data-tone="accent">
            <div class="exec-step-head">
              <span class="exec-step-glyph">计</span>
              <span class="exec-step-label">PLAN</span>
              <span class="exec-step-title">${escapeHtml(view.title)}</span>
            </div>
          </div>
        `;
        const doneCard = view.terminal ? `
          <div class="exec-step" data-tone="${view.tone}">
            <div class="exec-step-head">
              <span class="exec-step-glyph">${view.status === 'succeeded' ? '成' : view.status === 'cancelled' ? '止' : '败'}</span>
              <span class="exec-step-label">${view.status === 'succeeded' ? 'DONE' : view.status.toUpperCase()}</span>
              <span class="exec-step-title">${escapeHtml(view.statusLabel)}</span>
            </div>
            ${view.doneSummary ? `<div class="exec-step-body">${escapeHtml(view.doneSummary)}</div>` : ''}
            ${view.failureCode ? `<div class="exec-step-body is-error">${escapeHtml(view.failureCode)}</div>` : ''}
          </div>
        ` : '';
        const nearBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 48;
        streamEl.innerHTML = planCard + view.steps.map(renderStepHtml).join('') + doneCard;
        if (nearBottom || view.terminal === false) streamEl.scrollTop = streamEl.scrollHeight;
      }
    }
    position();
  };

  const adoptCreativeState = (snapshot = null) => {
    const previousRunId = trim(state.creative?.runId);
    const runId = trim(snapshot?.runId);
    state.creative = snapshot && typeof snapshot === 'object' ? {
      kind: 'creative',
      visible: snapshot.visible === true,
      expanded: snapshot.expanded === true,
      runId,
      status: trim(snapshot.status, 'queued'),
      terminal: snapshot.terminal === true,
      startedAt: Number(snapshot.startedAt) || 0,
      updatedAt: Number(snapshot.updatedAt) || 0,
    } : null;
    const isNewRun = Boolean(runId && runId !== previousRunId && state.creative?.visible);
    reconcileActiveKind({ preferLatestActive: isNewRun });
    render();
  };

  const attachCreativeLane = (runtime) => {
    creativeRuntime = runtime || null;
    if (!creativeRuntime || !ensure() || !creativeHostEl) return false;
    const mounted = creativeRuntime.setMountContainer?.(creativeHostEl) === true;
    adoptCreativeState(creativeRuntime.getProjectionSnapshot?.() || null);
    return mounted;
  };

  const consumeMaidTraceView = (view = null) => {
    const runId = trim(view?.runId);
    if (!runId || typeof onMaidTrace !== 'function') return false;
    let consumed = false;
    try {
      consumed = onMaidTrace(view) === true;
    } catch {}
    if (!consumed) return false;
    maidTraceConsumerRunId = runId;
    state.runId = runId;
    state.view = view;
    state.visible = false;
    state.expanded = false;
    reconcileActiveKind();
    render();
    return true;
  };

  /* 指令条开合也参与仲裁：重开时主动重放当前完整视图；关闭时进行中的 run 立即交给面板。 */
  const rearbitrateMaidTrace = ({ commandInputOpen = false } = {}) => {
    const view = state.view;
    if (!view || !trim(view.runId)) return false;
    if (commandInputOpen) return state.visible || view.source === 'maid_realtime' ? consumeMaidTraceView(view) : false;
    if (view.source === 'maid_realtime') return consumeMaidTraceView(view);
    maidTraceConsumerRunId = '';
    if (view.terminal) return false;
    state.signature = '';
    state.visible = true;
    state.expanded = true;
    reconcileActiveKind();
    render();
    return true;
  };

  const adoptEvent = (event = {}) => {
    const runId = trim(event?.runId);
    if (!runId) return;
    if (state.runId && runId !== state.runId && !state.view?.terminal) return; // 已有活跃 run，不被并发 run 打断
    const run = agentTaskRuntime?.getRun?.(runId);
    if (!run || trim(run.kind) !== MAID_RUN_KIND) return;
    const view = projectMaidRunToTraceView(run);
    if (!view) return;
    if (consumeMaidTraceView(view)) return;
    const wasConsumedByMaidTrace = maidTraceConsumerRunId === runId;
    if (wasConsumedByMaidTrace) maidTraceConsumerRunId = '';
    const isNewRun = runId !== state.runId;
    state.runId = runId;
    state.view = view;
    if (isNewRun || wasConsumedByMaidTrace) {
      state.signature = '';
      state.visible = true;
      state.expanded = true; // 女仆投影实时显示：运行即展开
    }
    reconcileActiveKind({ preferLatestActive: isNewRun });
    render();
  };

  const bind = () => {
    if (unsubscribe || typeof agentTaskRuntime?.onEvent !== 'function') return;
    unsubscribe = agentTaskRuntime.onEvent(adoptEvent);
  };

  const destroy = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (keydownHandler) documentRef?.removeEventListener?.('keydown', keydownHandler);
    keydownHandler = null;
    maidTraceConsumerRunId = '';
    rootEl?.remove?.();
    rootEl = null;
  };

  return {
    bind,
    destroy,
    position,
    render,
    setVisible,
    rearbitrateMaidTrace,
    adoptCreativeState,
    attachCreativeLane,
    getState: () => ({
      ...state,
      view: state.view ? { ...state.view } : null,
      creative: state.creative ? { ...state.creative } : null,
    }),
    getElements: () => ({ rootEl, chipEl, panelEl, streamEl, cancelMaidBtnEl, maidHostEl, creativeHostEl, switcherEl }),
    _adoptEvent: adoptEvent,
  };
};
