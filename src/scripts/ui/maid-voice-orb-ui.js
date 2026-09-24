import { t, translateUiText } from '../i18n/index.js';
import { formatRealtimeUsageText } from './realtime/realtime-usage-utils.js';
import { buildMaidVoiceTaskSummary } from './maid-run-card-model.js';
import { MAID_RUN_ICONS } from './maid-run-card-dom.js';

/* 语音女仆：原小球 + 外圈状态环 + 一句话胶囊 + 托盘。
   语音任务只显示“接收 → 执行 → 汇报”三拍摘要，要看步骤时点“查看详情”打开输入胶囊里的运行卡。
   外圈只分状态：执行中蓝色慢转、等你确认琥珀呼吸、汇报完成绿色停留、失败红色保留到查看。 */

const STYLE_ID = 'maid-voice-orb-style';
const DONE_RING_MS = 1200;
const STYLE = `
.mode-switch.is-maid-voice-active{opacity:1}
.maid-voice-wave{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:2px;pointer-events:none}
.maid-voice-wave[hidden],.maid-voice-mic[hidden],.maid-voice-ring[hidden],.maid-voice-orb-ui [hidden]{display:none!important}
.maid-voice-wave i{width:2px;height:12px;border-radius:2px;background:var(--app-accent-primary);transform:scaleY(.16);transition:transform 80ms linear}
.maid-voice-mic{position:absolute;right:-4px;bottom:-4px;z-index:3;width:9px;height:9px;border:2px solid var(--app-surface-card);border-radius:50%;background:var(--app-accent-primary);pointer-events:none}
.maid-voice-mic[data-muted="true"]{background:var(--app-text-muted)}
.maid-voice-mic[data-connecting="true"]{background:var(--app-text-muted);animation:maid-voice-connect 1.4s ease-in-out infinite}
.maid-voice-ring{position:absolute;inset:-7px;z-index:1;border-radius:50%;border:2px solid transparent;pointer-events:none}
.maid-voice-ring[data-state="running"]{border-color:rgba(var(--app-accent-rgb,59,130,246),.18);border-top-color:rgb(var(--app-accent-rgb,59,130,246));animation:maid-voice-ring-spin 1.6s linear infinite}
.maid-voice-ring[data-state="waiting"]{border-color:rgb(var(--app-warning-rgb,217,119,6));animation:maid-voice-ring-breathe 1.6s ease-in-out infinite}
.maid-voice-ring[data-state="done"]{border-color:rgb(var(--app-success-rgb,46,160,67))}
.maid-voice-ring[data-state="failed"]{border-color:rgb(var(--app-danger-rgb,220,38,38))}
@keyframes maid-voice-ring-spin{to{transform:rotate(360deg)}}
@keyframes maid-voice-ring-breathe{50%{box-shadow:0 0 0 4px rgba(var(--app-warning-rgb,217,119,6),.22)}}
.maid-voice-orb-ui{position:fixed;z-index:26070;inset:0;pointer-events:none;font-size:12px;color:var(--app-text-primary)}
.maid-voice-orb-badge,.maid-voice-orb-controls{position:absolute;pointer-events:auto;background:var(--app-surface-card);border:1px solid var(--app-border-default);box-shadow:var(--app-shadow-md,0 10px 30px rgba(15,23,42,.14))}
.maid-voice-orb-badge{display:flex;align-items:center;gap:7px;max-width:min(280px,calc(100vw - 24px));min-height:34px;box-sizing:border-box;border-radius:999px;padding:5px 12px 5px 7px;text-align:left;color:var(--app-text-primary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;box-shadow:var(--app-shadow-sm,0 1px 4px rgba(15,23,42,.08))}
.maid-voice-orb-badge[data-tone="warning"]{border-color:color-mix(in srgb,rgb(var(--app-warning-rgb,217,119,6)) 45%,var(--app-border-default))}
.maid-voice-orb-badge[data-tone="danger"]{border-color:color-mix(in srgb,rgb(var(--app-danger-rgb,220,38,38)) 40%,var(--app-border-default))}
.maid-voice-orb-badge-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mvo-icon{flex:0 0 auto;width:16px;height:16px;display:inline-grid;place-items:center;color:var(--app-text-muted)}
.mvo-icon svg{width:14px;height:14px;display:block}
.mvo-icon[data-tone="accent"]{color:rgb(var(--app-accent-rgb,59,130,246))}
.mvo-icon[data-tone="accent"] svg{animation:maid-voice-ring-spin 1.1s linear infinite}
.mvo-icon[data-tone="warning"]{color:rgb(var(--app-warning-rgb,217,119,6))}
.mvo-icon[data-tone="success"]{color:rgb(var(--app-success-rgb,46,160,67))}
.mvo-icon[data-tone="danger"]{color:rgb(var(--app-danger-rgb,220,38,38))}
.mvo-bars{display:inline-flex;align-items:center;justify-content:center;gap:2px;width:18px;height:16px;flex:0 0 auto}
.mvo-bars i{width:2.5px;height:5px;border-radius:2px;background:rgb(var(--app-accent-rgb,59,130,246));animation:maid-voice-bars .9s ease-in-out infinite}
.mvo-bars i:nth-child(2){animation-delay:.15s}.mvo-bars i:nth-child(3){animation-delay:.3s}.mvo-bars i:nth-child(4){animation-delay:.45s}
.mvo-bars[data-speaking="true"] i{background:rgb(var(--app-success-rgb,46,160,67))}
@keyframes maid-voice-bars{50%{height:14px}}
.maid-voice-orb-controls{width:min(332px,calc(100vw - 24px));box-sizing:border-box;border-radius:16px;padding:0;max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain}
.maid-voice-orb-header{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 12px;border-bottom:1px solid var(--app-border-subtle,var(--app-border-default))}
.maid-voice-orb-title{flex:1 1 auto;min-width:0;font-weight:600;font-size:13px}
.maid-voice-orb-close{border:0;background:transparent;color:var(--app-text-secondary);min-width:32px;min-height:32px;border-radius:8px;cursor:pointer;font:inherit;font-size:16px}
.maid-voice-orb-controls button{font:inherit}
.maid-voice-orb-mic{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:0 12px;border:0;border-radius:999px;background:rgb(var(--app-accent-rgb,59,130,246));color:var(--app-text-on-accent,#fff);font-weight:600;cursor:pointer}
.maid-voice-orb-mic[aria-pressed="true"]{background:var(--app-surface-subtle);color:var(--app-text-secondary)}
.maid-voice-orb-mic:disabled{opacity:.5;cursor:default}
.maid-voice-orb-mic svg{width:12px;height:12px}
.maid-voice-orb-tasks{list-style:none;margin:0;padding:0}
.mvo-task{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-bottom:1px solid var(--app-border-subtle,var(--app-border-default))}
.mvo-task-ask{display:flex;align-items:center;gap:8px;min-width:0}
.mvo-task-ask q{flex:1 1 auto;min-width:0;quotes:"“" "”";font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mvo-task-stop{flex:0 0 auto;width:26px;height:26px;display:inline-grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--app-text-muted);cursor:pointer}
.mvo-task-stop:hover{color:rgb(var(--app-danger-rgb,220,38,38));background:rgba(var(--app-danger-rgb,220,38,38),.08)}
.mvo-task-stop svg{width:11px;height:11px}
.mvo-beats{display:grid;grid-template-columns:auto 1fr auto 1fr auto;align-items:center;gap:6px}
.mvo-beat{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--app-text-muted);white-space:nowrap}
.mvo-beat i{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--app-border-strong,var(--app-border-default));background:var(--app-surface-card);flex:0 0 auto}
.mvo-beat.is-past i{background:var(--app-text-muted);border-color:var(--app-text-muted)}
.mvo-beat.is-on{color:var(--app-text-primary);font-weight:600}
.mvo-beat.is-on i{--mvo-beat:var(--app-accent-rgb,59,130,246);background:rgb(var(--mvo-beat));border-color:rgb(var(--mvo-beat));box-shadow:0 0 0 3px rgba(var(--mvo-beat),.16)}
.mvo-beat.is-on[data-tone="warning"] i{--mvo-beat:var(--app-warning-rgb,217,119,6)}
.mvo-beat.is-on[data-tone="success"] i{--mvo-beat:var(--app-success-rgb,46,160,67)}
.mvo-beat.is-on[data-tone="danger"] i{--mvo-beat:var(--app-danger-rgb,220,38,38)}
.mvo-beat.is-on[data-tone="muted"] i{--mvo-beat:var(--app-text-muted-rgb,148,163,184)}
.mvo-beat-line{height:1.5px;border-radius:1px;background:var(--app-border-default)}
.mvo-beat-line.is-past{background:var(--app-text-muted)}
.mvo-task-say{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:12.5px;color:var(--app-text-secondary);overflow-wrap:anywhere}
.mvo-task-detail{border:0;background:transparent;padding:0;color:rgb(var(--app-accent-rgb,59,130,246));font-size:12px;cursor:pointer}
.mvo-approval{margin:10px;padding:11px 12px;border-radius:12px;background:rgba(var(--app-warning-rgb,217,119,6),.11);display:flex;flex-direction:column;gap:8px}
.mvo-approval-title{margin:0;font-size:13px;font-weight:600}
.mvo-approval-message,.mvo-approval-hint{margin:0;font-size:12px;color:var(--app-text-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.mvo-approval-hint{color:var(--app-text-muted);font-size:11.5px}
.mvo-approval-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px}
.mvo-btn{min-height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--app-border-strong,var(--app-border-default));background:var(--app-surface-card);color:var(--app-text-primary);font-weight:600;cursor:pointer}
.mvo-btn.is-ghost{border-color:transparent;background:transparent;color:var(--app-text-secondary)}
.mvo-btn.is-primary{border-color:var(--app-text-primary);background:var(--app-text-primary);color:var(--app-surface-card)}
.maid-voice-orb-status,.maid-voice-orb-warning{margin:0;padding:8px 12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.maid-voice-orb-status{color:var(--app-text-secondary)}
.maid-voice-orb-warning{color:rgb(var(--app-danger-rgb,220,38,38))}
.maid-voice-orb-caption-line{padding:8px 12px;background:var(--app-surface-subtle);color:var(--app-text-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.maid-voice-orb-caption-line b{font-weight:500;color:var(--app-text-muted);margin-right:4px}
.maid-voice-orb-details{padding:0 12px;color:var(--app-text-secondary)}
.maid-voice-orb-details summary{cursor:pointer;padding:8px 0}
.maid-voice-orb-caption{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:180px;overflow:auto;margin:4px 0 8px}
.maid-voice-orb-usage{white-space:pre-wrap;line-height:1.5;font-size:11px;padding-bottom:8px}
.maid-voice-orb-actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:8px 10px 10px;border-top:1px solid var(--app-border-subtle,var(--app-border-default))}
.maid-voice-orb-actions button{min-height:36px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--app-text-secondary);cursor:pointer}
.maid-voice-orb-actions button:hover{background:var(--app-surface-hover,var(--app-surface-subtle))}
.maid-voice-orb-actions button:disabled{opacity:.5;cursor:default}
.maid-voice-orb-actions button[data-action="end"]{margin-left:auto;color:rgb(var(--app-danger-rgb,220,38,38));font-weight:600}
.maid-voice-orb-controls button:focus-visible,.maid-voice-orb-badge:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
@keyframes maid-voice-connect{50%{opacity:.3}}
body[data-reduced-motion='on'] .maid-voice-ring,body[data-reduced-motion='on'] .maid-voice-orb-ui *{animation:none!important}
@media(prefers-reduced-motion:reduce){.maid-voice-wave i{transition:none}.maid-voice-mic,.maid-voice-ring,.maid-voice-orb-ui *{animation:none!important}}
`;

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TONE_ICON = Object.freeze({
  accent: MAID_RUN_ICONS.running,
  warning: MAID_RUN_ICONS.waiting,
  success: MAID_RUN_ICONS.check,
  danger: MAID_RUN_ICONS.cross,
  muted: MAID_RUN_ICONS.cancelled,
});

const beatsHtml = (summary) => {
  const names = [t('接收'), t('执行'), t('汇报')];
  return `<div class="mvo-beats" aria-label="${escapeHtml(t('进度：{beat}', { beat: summary.beatLabel }))}">${names.map((name, index) => {
    const line = index ? `<span class="mvo-beat-line${index <= summary.beat ? ' is-past' : ''}"></span>` : '';
    const cls = index < summary.beat ? ' is-past' : index === summary.beat ? ' is-on' : '';
    const label = index === summary.beat ? summary.beatLabel : name;
    return `${line}<span class="mvo-beat${cls}" data-tone="${summary.tone}"><i></i>${escapeHtml(label)}</span>`;
  }).join('')}</div>`;
};

// Enhances the existing mode-switch button; never creates or replaces the ball.
export const createMaidVoiceOrbUi = ({ documentRef = globalThis.document, windowLike = globalThis.window,
  modeSwitchEl, onToggleMute, onToggleOutputMute, onEnd, onStopTask, onOpenInput, onRetry,
  onApprovalDecision = null,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) => {
  const button = modeSwitchEl?.querySelector?.('.mode-switch-btn');
  if (!button || !documentRef?.body) return null;
  if (!documentRef.getElementById(STYLE_ID)) {
    const style = documentRef.createElement('style'); style.id = STYLE_ID; style.textContent = STYLE; documentRef.head.appendChild(style);
  }
  const make = (tag, className, parent, content = '') => {
    const el = documentRef.createElement(tag); el.className = className; el.textContent = content; parent.appendChild(el); return el;
  };
  const wave = make('span', 'maid-voice-wave', button); wave.setAttribute('aria-hidden', 'true');
  const bars = Array.from({ length: 4 }, () => make('i', '', wave));
  const mic = make('span', 'maid-voice-mic', button); mic.setAttribute('aria-hidden', 'true');
  const ring = make('span', 'maid-voice-ring', button); ring.setAttribute('aria-hidden', 'true'); ring.hidden = true;
  const root = make('div', 'maid-voice-orb-ui', documentRef.body);
  const badge = make('button', 'maid-voice-orb-badge', root); badge.type = 'button';
  const badgeIcon = make('span', 'mvo-icon', badge);
  const badgeText = make('span', 'maid-voice-orb-badge-text', badge);
  const controls = make('section', 'maid-voice-orb-controls', root); controls.id = 'maid-voice-orb-controls'; controls.setAttribute('aria-label', t('女仆语音控制'));
  const header = make('div', 'maid-voice-orb-header', controls);
  const title = make('span', 'maid-voice-orb-title', header);
  const mute = make('button', 'maid-voice-orb-mic', header); mute.type = 'button'; mute.dataset.action = 'mute';
  const close = make('button', 'maid-voice-orb-close', header, '×'); close.type = 'button'; close.setAttribute('aria-label', t('收起'));
  const taskList = make('ul', 'maid-voice-orb-tasks', controls);
  const approvalEl = make('div', 'mvo-approval', controls); approvalEl.setAttribute('role', 'group');
  const status = make('div', 'maid-voice-orb-status', controls); status.setAttribute('role', 'status');
  const warning = make('div', 'maid-voice-orb-warning', controls);
  const captionLine = make('div', 'maid-voice-orb-caption-line', controls);
  const details = make('details', 'maid-voice-orb-details', controls);
  make('summary', '', details, t('字幕与用量'));
  const captions = make('div', 'maid-voice-orb-caption', details);
  const usage = make('div', 'maid-voice-orb-usage', details);
  const actions = make('div', 'maid-voice-orb-actions', controls);
  const guard = callback => () => { void Promise.resolve().then(() => callback?.()).catch(error => setWarning(error?.message || String(error))); };
  const action = (name, label, callback) => {
    const el = make('button', '', actions, label); el.type = 'button'; el.dataset.action = name;
    el.addEventListener('click', guard(callback));
    return el;
  };
  mute.addEventListener('click', guard(onToggleMute));
  const output = action('output', t('暂停播报'), onToggleOutputMute);
  action('input', t('记录与输入'), () => { setExpanded(false); return onOpenInput?.(); });
  const retry = action('retry', t('重新连接'), onRetry);
  const end = action('end', t('结束语音'), onEnd);
  let active = false, expanded = false, inputOpen = false, state = { status: 'idle' }, tasks = { active: [], latest: null, recent: [] }, warningText = '', latestText = '';
  let approval = null, dismissedApprovalId = '', failedSeenId = '', doneRingUntil = 0;
  let finishTimer = null, ringTimer = null;
  let lastLevels = null, lastOutputAt = 0;
  const paintLevels = () => {
    const value = lastLevels;
    const audio = !state.outputMuted && value?.output?.level > (state.muted ? 0 : value?.input?.level || 0) ? value.output : state.muted ? null : value?.input;
    bars.forEach((bar, index) => { const level = Math.max(0, Math.min(1, Number(audio?.bands?.[index * 2] ?? audio?.level) || 0)); bar.style.transform = `scaleY(${.16 + level * .84})`; });
  };
  const captionText = { user: '', assistant: '', lastRole: '' };
  const isSpeaking = () => (state.status === 'speaking' || (state.openaiBackend === 'live' && Date.now() - lastOutputAt < 250)) && !state.outputMuted;
  const stateLabel = () => {
    if (!active) return t('语音已结束');
    if (state.status === 'ending') return t('正在结束');
    if (['connecting', 'requesting_permission'].includes(state.status)) return t('正在连接');
    if (state.status === 'reconnecting') return t('正在重新连接');
    if (state.status === 'error') return t('连接失败');
    if (state.muted) return t('麦克风已暂停');
    return isSpeaking() ? t('正在说话') : state.status === 'thinking' ? t('正在思考') : t('正在聆听');
  };
  const position = () => {
    const rect = modeSwitchEl.getBoundingClientRect(), viewport = windowLike?.visualViewport;
    const w = viewport?.width || windowLike?.innerWidth || 400, h = viewport?.height || windowLike?.innerHeight || 800;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    for (const el of [badge, controls]) {
      if (el.hidden) continue;
      const width = el.offsetWidth || 220, height = el.offsetHeight || 40;
      el.style.left = `${Math.max(left + 12, Math.min(rect.left + rect.width / 2 - width / 2, left + w - width - 12))}px`;
      el.style.top = `${Math.max(top + 12, Math.min(rect.bottom + height + 10 <= top + h - 12 ? rect.bottom + 10 : rect.top - height - 10, top + h - height - 12))}px`;
    }
  };
  // 当前最值得说的一句：警告 > 待确认 > 执行中的任务 > 刚结束的结果 > 通话状态
  const currentTask = () => tasks.active.find(item => item.status === 'running') || tasks.active[0] || null;
  const approvalTaskId = () => approval?.taskId || '';
  const summarizeTask = task => buildMaidVoiceTaskSummary(task, { approvalPending: Boolean(approval && approvalTaskId() === task?.task_id) });
  const headline = () => {
    if (warningText) return { tone: 'danger', text: warningText };
    if (approval) return { tone: 'warning', text: approval.title };
    const task = currentTask();
    if (task) {
      const summary = summarizeTask(task);
      return { tone: summary.tone, text: `${summary.line}${tasks.active.length > 1 ? ` · +${tasks.active.length - 1}` : ''}` };
    }
    if (latestText) {
      const summary = buildMaidVoiceTaskSummary(tasks.latest);
      return { tone: summary?.tone || 'success', text: latestText };
    }
    return { tone: 'listen', text: stateLabel() };
  };
  const ringState = () => {
    if (!active && !tasks.active.length) return '';
    if (approval) return 'waiting';
    if (tasks.active.length) return 'running';
    const latest = tasks.latest;
    if (latest?.status === 'failed' && latest.task_id !== failedSeenId) return 'failed';
    if (latest?.status === 'succeeded' && Date.now() < doneRingUntil) return 'done';
    return '';
  };
  const renderTasks = () => {
    const recent = Array.isArray(tasks.recent) && tasks.recent.length ? tasks.recent : [tasks.latest].filter(Boolean);
    taskList.innerHTML = recent.map((task) => {
      const summary = summarizeTask(task);
      const running = ['queued', 'running'].includes(task.status);
      return `<li class="mvo-task" data-task-id="${escapeHtml(task.task_id)}">`
        + `<div class="mvo-task-ask"><q>${escapeHtml(task.request || '')}</q>`
        + (running ? `<button type="button" class="mvo-task-stop" data-task-stop="${escapeHtml(task.task_id)}" aria-label="${escapeHtml(t('停止这个任务'))}">${MAID_RUN_ICONS.cross}</button>` : '')
        + '</div>'
        + beatsHtml(summary)
        + `<div class="mvo-task-say"><span>${escapeHtml(summary.line)}</span><button type="button" class="mvo-task-detail" data-task-detail="1">${escapeHtml(t('查看详情'))}</button></div>`
        + '</li>';
    }).join('');
    taskList.hidden = recent.length === 0;
  };
  const renderApproval = () => {
    approvalEl.hidden = !approval;
    approvalEl.innerHTML = approval
      ? `<p class="mvo-approval-title">${escapeHtml(approval.title)}</p>`
        + (approval.message ? `<p class="mvo-approval-message">${escapeHtml(approval.message)}</p>` : '')
        + `<p class="mvo-approval-hint">${escapeHtml(t('也可以直接说“允许”'))}</p>`
        + '<div class="mvo-approval-actions">'
        + `<button type="button" class="mvo-btn is-ghost" data-approval="deny">${escapeHtml(approval.cancelLabel || t('取消'))}</button>`
        + `<button type="button" class="mvo-btn is-primary" data-approval="allow_once">${escapeHtml(approval.confirmLabel || t('允许一次'))}</button>`
        + '</div>'
      : '';
  };
  const render = () => {
    const label = stateLabel();
    title.textContent = label;
    const head = headline();
    if (head.tone === 'listen') {
      badgeIcon.dataset.tone = '';
      badgeIcon.innerHTML = `<span class="mvo-bars" data-speaking="${isSpeaking() ? 'true' : 'false'}"><i></i><i></i><i></i><i></i></span>`;
    } else {
      badgeIcon.dataset.tone = head.tone;
      badgeIcon.innerHTML = TONE_ICON[head.tone] || '';
    }
    badgeText.textContent = head.text;
    badge.dataset.tone = head.tone;
    const task = currentTask();
    status.textContent = !task && !recentCount() ? latestText : '';
    status.hidden = !status.textContent;
    warning.textContent = warningText; warning.hidden = !warningText;
    const hasContent = active || tasks.active.length > 0 || Boolean(latestText) || Boolean(warningText) || Boolean(approval);
    badge.hidden = expanded || inputOpen || !hasContent;
    controls.hidden = !expanded;
    wave.hidden = mic.hidden = !active;
    mic.dataset.muted = String(state.muted === true);
    mic.dataset.connecting = String(['connecting', 'requesting_permission', 'reconnecting'].includes(state.status));
    const ringValue = ringState();
    ring.hidden = !ringValue;
    ring.dataset.state = ringValue;
    modeSwitchEl.classList.toggle('is-maid-voice-active', active);
    mute.hidden = output.hidden = end.hidden = !active;
    mute.disabled = output.disabled = !['listening', 'thinking', 'speaking', 'reconnecting'].includes(state.status);
    mute.innerHTML = `${MAID_RUN_ICONS.mic}<span></span>`;
    const muteLabel = mute.querySelector?.('span');
    if (muteLabel) muteLabel.textContent = state.muted ? t('恢复麦克风') : t('暂停麦克风');
    else mute.textContent = state.muted ? t('恢复麦克风') : t('暂停麦克风');
    mute.setAttribute('aria-pressed', String(!!state.muted));
    output.textContent = state.outputMuted ? t('恢复播报') : t('暂停播报'); output.setAttribute('aria-pressed', String(!!state.outputMuted));
    retry.hidden = active;
    const lastCaption = captionText.lastRole ? captionText[captionText.lastRole] : '';
    captionLine.hidden = !lastCaption;
    captionLine.innerHTML = lastCaption
      ? `<b>${escapeHtml(captionText.lastRole === 'user' ? t('你') : t('女仆'))}</b>${escapeHtml(lastCaption.split('\n').filter(Boolean).at(-1) || '')}`
      : '';
    renderTasks();
    renderApproval();
    badge.setAttribute('aria-label', `${t('女仆语音控制')} · ${badgeText.textContent}`);
    badge.setAttribute('aria-expanded', String(expanded));
    badge.setAttribute('aria-controls', controls.id);
    position();
  };
  const recentCount = () => (Array.isArray(tasks.recent) ? tasks.recent.length : 0) || (tasks.latest ? 1 : 0);
  const setExpanded = value => {
    expanded = !!value;
    // 查看过托盘即视为已看到失败结果，外圈红色随之退场；手动收起的确认不再强制弹出
    if (expanded && tasks.latest?.status === 'failed') failedSeenId = tasks.latest.task_id;
    if (!expanded && approval) dismissedApprovalId = approval.id;
    render();
    if (!expanded) return;
    const focusTarget = approval
      ? approvalEl.querySelector?.('[data-approval="allow_once"]')
      : (active ? (mute.disabled ? end : mute) : retry);
    focusTarget?.focus?.({ preventScroll: true });
  };
  const setWarning = message => { warningText = String(message || ''); render(); };
  const outside = event => {
    if (expanded && !controls.contains(event.target) && !badge.contains(event.target)) setExpanded(false);
  };
  const focusSummary = () => (badge.hidden ? button : badge).focus({ preventScroll: true });
  const escape = event => { if (expanded && event.key === 'Escape') { event.stopPropagation(); setExpanded(false); focusSummary(); } };
  close.addEventListener('click', () => { setExpanded(false); focusSummary(); });
  badge.addEventListener('click', () => setExpanded(true));
  controls.addEventListener('click', (event) => {
    const target = event.target;
    const stopId = target?.closest?.('[data-task-stop]')?.getAttribute?.('data-task-stop');
    if (stopId) { event.preventDefault?.(); guard(() => onStopTask?.(stopId))(); return; }
    if (target?.closest?.('[data-task-detail]')) { event.preventDefault?.(); setExpanded(false); guard(onOpenInput)(); return; }
    const decision = target?.closest?.('[data-approval]')?.getAttribute?.('data-approval');
    if (decision && approval) { event.preventDefault?.(); guard(() => onApprovalDecision?.({ id: approval.id, action: decision, runId: approval.runId }))(); }
  });
  details.addEventListener('toggle', position);
  documentRef.addEventListener('pointerdown', outside, true); documentRef.addEventListener('keydown', escape);
  windowLike?.addEventListener('resize', position); windowLike?.visualViewport?.addEventListener('resize', position);
  const hide = () => {
    active = false; expanded = false; state = { ...state, status: 'idle' };
    render();
  };
  render();
  return {
    show: () => {
      active = true; warningText = ''; latestText = ''; captionText.user = captionText.assistant = captionText.lastRole = ''; captions.textContent = ''; expanded = false;
      state = { status: 'connecting' }; lastLevels = null; lastOutputAt = 0; paintLevels(); render();
    },
    hide, position, closeControls: () => setExpanded(false),
    setInputOpen: open => { inputOpen = !!open; if (inputOpen) expanded = false; render(); },
    renderState: value => { state = value; paintLevels(); if (value.status === 'idle') hide(); else render(); },
    setWarning,
    setCaption: value => {
      for (const caption of value.captions || [value]) {
        if (caption.role in captionText && caption.role !== 'lastRole') {
          captionText[caption.role] = String(caption.text || '').slice(-4000);
          if (caption.text) captionText.lastRole = caption.role;
        }
      }
      captions.textContent = [captionText.user, captionText.assistant].filter(Boolean).join('\n\n');
      if (expanded) render();
    },
    setUsage: value => { usage.textContent = formatRealtimeUsageText(value).split('\n').map(line => translateUiText(line)).join('\n'); },
    setAudioLevel: value => {
      lastLevels = value; if (value?.output?.level > .03 && !state.outputMuted) lastOutputAt = Date.now();
      paintLevels(); if (active && title.textContent !== stateLabel()) render();
    },
    setTasks: value => {
      const changed = tasks.latest?.status !== value.latest?.status || tasks.latest?.task_id !== value.latest?.task_id;
      tasks = { recent: [], ...value };
      if (!tasks.active.length && tasks.latest && changed) {
        latestText = tasks.latest.message;
        if (tasks.latest.status === 'succeeded') {
          doneRingUntil = Date.now() + DONE_RING_MS;
          if (ringTimer !== null) clearTimeoutFn(ringTimer);
          ringTimer = setTimeoutFn(() => { ringTimer = null; render(); }, DONE_RING_MS + 20);
        }
        if (finishTimer !== null) clearTimeoutFn(finishTimer);
        finishTimer = setTimeoutFn(() => { finishTimer = null; latestText = ''; render(); }, 5000);
      }
      render();
    },
    // 卡内确认：新确认到达时自动展开托盘（被用户手动收起的同一条不再强制弹出）
    setApproval: value => {
      const next = value && value.id ? { ...value } : null;
      const isNew = next && next.id !== approval?.id;
      approval = next;
      if (isNew && next.id !== dismissedApprovalId && !inputOpen) {
        expanded = true;
      }
      if (!approval) dismissedApprovalId = '';
      render();
    },
    destroy: () => {
      hide(); if (finishTimer !== null) clearTimeoutFn(finishTimer); if (ringTimer !== null) clearTimeoutFn(ringTimer);
      documentRef.removeEventListener('pointerdown', outside, true); documentRef.removeEventListener('keydown', escape);
      windowLike?.removeEventListener('resize', position); windowLike?.visualViewport?.removeEventListener('resize', position);
      root.remove(); wave.remove(); mic.remove(); ring.remove();
    },
  };
};
