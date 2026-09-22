import { t, translateUiText } from '../i18n/index.js';
import { formatRealtimeUsageText } from './realtime/realtime-usage-utils.js';

const STYLE_ID = 'maid-voice-orb-style';
const STYLE = `
.mode-switch.is-maid-voice-active{opacity:1}
.maid-voice-wave{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:2px;pointer-events:none}
.maid-voice-wave[hidden],.maid-voice-mic[hidden],.maid-voice-orb-ui [hidden]{display:none!important}
.maid-voice-wave i{width:2px;height:12px;border-radius:2px;background:var(--app-accent-primary);transform:scaleY(.16);transition:transform 80ms linear}
.maid-voice-mic{position:absolute;right:-4px;bottom:-4px;z-index:3;width:9px;height:9px;border:2px solid var(--app-surface-card);border-radius:50%;background:var(--app-accent-primary);pointer-events:none}
.maid-voice-mic[data-muted="true"]{background:var(--app-text-muted)}
.maid-voice-mic[data-connecting="true"]{background:var(--app-text-muted);animation:maid-voice-connect 1.4s ease-in-out infinite}
.maid-voice-orb-ui{position:fixed;z-index:26070;inset:0;pointer-events:none;font-size:12px;color:var(--app-text-primary)}
.maid-voice-orb-badge,.maid-voice-orb-controls{position:absolute;pointer-events:auto;background:var(--app-surface-card);border:1px solid var(--app-border-default);box-shadow:0 4px 18px color-mix(in srgb,var(--app-text-primary) 10%,transparent)}
.maid-voice-orb-badge{max-width:min(220px,calc(100vw - 24px));border-radius:12px;padding:5px 9px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--app-text-secondary);font:inherit;cursor:pointer}
.maid-voice-orb-controls{width:min(280px,calc(100vw - 24px));box-sizing:border-box;border-radius:16px;padding:12px;max-height:calc(100dvh - 32px);overflow:auto}
.maid-voice-orb-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.maid-voice-orb-title{font-weight:600}.maid-voice-orb-close{border:0;background:transparent;color:var(--app-text-secondary);min-width:32px;min-height:32px;border-radius:8px;cursor:pointer}
.maid-voice-orb-actions{display:flex;flex-wrap:wrap;gap:6px}
.maid-voice-orb-actions button{flex:1 1 100px;min-height:42px;padding:8px;border:1px solid var(--app-border-default);border-radius:10px;background:var(--app-surface-subtle);color:var(--app-text-primary);font:inherit;cursor:pointer}
.maid-voice-orb-actions button:disabled{opacity:.5;cursor:default}
.maid-voice-orb-actions button[data-action="end"]{color:var(--app-status-danger,var(--app-text-primary))}
.maid-voice-orb-controls button:focus-visible,.maid-voice-orb-badge:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
.maid-voice-orb-status,.maid-voice-orb-warning{margin:8px 0;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.maid-voice-orb-warning{color:var(--app-status-danger,var(--app-text-primary))}
.maid-voice-orb-details{margin-top:10px;color:var(--app-text-secondary)}
.maid-voice-orb-details summary{cursor:pointer;padding:6px 0}
.maid-voice-orb-caption{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:180px;overflow:auto;margin:8px 0}
.maid-voice-orb-usage{white-space:pre-wrap;line-height:1.5;font-size:11px}
@keyframes maid-voice-connect{50%{opacity:.3}}
@media(prefers-reduced-motion:reduce){.maid-voice-wave i{transition:none}.maid-voice-mic{animation:none!important}}
`;

// Enhances the existing mode-switch button; never creates or replaces the ball.
export const createMaidVoiceOrbUi = ({ documentRef = globalThis.document, windowLike = globalThis.window,
  modeSwitchEl, onToggleMute, onToggleOutputMute, onEnd, onStopTask, onOpenInput, onRetry,
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
  const root = make('div', 'maid-voice-orb-ui', documentRef.body);
  const badge = make('button', 'maid-voice-orb-badge', root); badge.type = 'button';
  const controls = make('section', 'maid-voice-orb-controls', root); controls.id = 'maid-voice-orb-controls'; controls.setAttribute('aria-label', t('女仆语音控制'));
  const header = make('div', 'maid-voice-orb-header', controls);
  const title = make('span', 'maid-voice-orb-title', header);
  const close = make('button', 'maid-voice-orb-close', header, '×'); close.type = 'button'; close.setAttribute('aria-label', t('收起'));
  const status = make('div', 'maid-voice-orb-status', controls); status.setAttribute('role', 'status');
  const warning = make('div', 'maid-voice-orb-warning', controls);
  const actions = make('div', 'maid-voice-orb-actions', controls);
  const action = (name, label, callback) => {
    const el = make('button', '', actions, label); el.type = 'button'; el.dataset.action = name;
    el.addEventListener('click', () => { void Promise.resolve().then(() => callback?.()).catch(error => setWarning(error?.message || String(error))); });
    return el;
  };
  const mute = action('mute', t('暂停麦克风'), onToggleMute);
  const output = action('output', t('暂停播报'), onToggleOutputMute);
  const stop = action('stop-task', t('停止当前任务'), onStopTask);
  const end = action('end', t('结束语音'), onEnd);
  const retry = action('retry', t('重新连接'), onRetry);
  action('input', t('记录与输入'), () => { setExpanded(false); return onOpenInput?.(); });
  const details = make('details', 'maid-voice-orb-details', controls);
  make('summary', '', details, t('字幕与用量'));
  const captions = make('div', 'maid-voice-orb-caption', details);
  const usage = make('div', 'maid-voice-orb-usage', details);
  let active = false, expanded = false, inputOpen = false, state = { status: 'idle' }, tasks = { active: [], latest: null }, warningText = '', latestText = '';
  let finishTimer = null;
  let lastLevels = null, lastOutputAt = 0;
  const paintLevels = () => {
    const value = lastLevels;
    const audio = !state.outputMuted && value?.output?.level > (state.muted ? 0 : value?.input?.level || 0) ? value.output : state.muted ? null : value?.input;
    bars.forEach((bar, index) => { const level = Math.max(0, Math.min(1, Number(audio?.bands?.[index * 2] ?? audio?.level) || 0)); bar.style.transform = `scaleY(${.16 + level * .84})`; });
  };
  const captionText = { user: '', assistant: '' };
  const stateLabel = () => {
    if (!active) return t('语音已结束');
    if (state.status === 'ending') return t('正在结束');
    if (['connecting', 'requesting_permission'].includes(state.status)) return t('正在连接');
    if (state.status === 'reconnecting') return t('正在重新连接');
    if (state.status === 'error') return t('连接失败');
    if (state.muted) return t('麦克风已暂停');
    return (state.status === 'speaking' || (state.openaiBackend === 'live' && Date.now() - lastOutputAt < 250)) && !state.outputMuted ? t('正在说话') : state.status === 'thinking' ? t('正在思考') : t('正在聆听');
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
  const render = () => {
    const label = stateLabel();
    title.textContent = label;
    const task = tasks.active.find(item => item.status === 'running') || tasks.active[0];
    const taskText = task ? `${task.message || task.request}${tasks.active.length > 1 ? ` · ${tasks.active.length}` : ''}` : latestText;
    status.textContent = taskText; status.hidden = !taskText;
    warning.textContent = warningText; warning.hidden = !warningText;
    badge.textContent = warningText || taskText || label;
    badge.hidden = expanded || inputOpen || (!active && !taskText && !warningText);
    controls.hidden = !expanded;
    wave.hidden = mic.hidden = !active;
    mic.dataset.muted = String(state.muted === true);
    mic.dataset.connecting = String(['connecting', 'requesting_permission', 'reconnecting'].includes(state.status));
    modeSwitchEl.classList.toggle('is-maid-voice-active', active);
    mute.hidden = output.hidden = end.hidden = !active;
    mute.disabled = output.disabled = !['listening', 'thinking', 'speaking', 'reconnecting'].includes(state.status);
    mute.textContent = state.muted ? t('恢复麦克风') : t('暂停麦克风'); mute.setAttribute('aria-pressed', String(!!state.muted));
    output.textContent = state.outputMuted ? t('恢复播报') : t('暂停播报'); output.setAttribute('aria-pressed', String(!!state.outputMuted));
    stop.hidden = !tasks.active.length; retry.hidden = active;
    badge.setAttribute('aria-label', `${t('女仆语音控制')} · ${badge.textContent}`);
    badge.setAttribute('aria-expanded', String(expanded));
    badge.setAttribute('aria-controls', controls.id);
    position();
  };
  const setExpanded = value => {
    expanded = !!value; render();
    if (expanded) (active ? (mute.disabled ? end : mute) : tasks.active.length ? stop : retry).focus({ preventScroll: true });
  };
  const setWarning = message => { warningText = String(message || ''); render(); };
  const outside = event => {
    if (expanded && !controls.contains(event.target) && !badge.contains(event.target)) setExpanded(false);
  };
  const focusSummary = () => (badge.hidden ? button : badge).focus({ preventScroll: true });
  const escape = event => { if (expanded && event.key === 'Escape') { event.stopPropagation(); setExpanded(false); focusSummary(); } };
  close.addEventListener('click', () => { setExpanded(false); focusSummary(); });
  badge.addEventListener('click', () => setExpanded(true));
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
      active = true; warningText = ''; latestText = ''; captionText.user = captionText.assistant = ''; captions.textContent = ''; expanded = false;
      state = { status: 'connecting' }; lastLevels = null; lastOutputAt = 0; paintLevels(); render();
    },
    hide, position, closeControls: () => setExpanded(false),
    setInputOpen: open => { inputOpen = !!open; if (inputOpen) expanded = false; render(); },
    renderState: value => { state = value; paintLevels(); if (value.status === 'idle') hide(); else render(); },
    setWarning,
    setCaption: value => {
      for (const caption of value.captions || [value]) if (caption.role in captionText) captionText[caption.role] = String(caption.text || '').slice(-4000);
      captions.textContent = [captionText.user, captionText.assistant].filter(Boolean).join('\n\n');
      if (expanded && details.open) position();
    },
    setUsage: value => { usage.textContent = formatRealtimeUsageText(value).split('\n').map(line => translateUiText(line)).join('\n'); },
    setAudioLevel: value => {
      lastLevels = value; if (value?.output?.level > .03 && !state.outputMuted) lastOutputAt = Date.now();
      paintLevels(); if (active && title.textContent !== stateLabel()) render();
    },
    setTasks: value => {
      const changed = tasks.latest?.status !== value.latest?.status || tasks.latest?.task_id !== value.latest?.task_id;
      tasks = value;
      if (!tasks.active.length && tasks.latest && changed) {
        latestText = tasks.latest.message;
        if (finishTimer !== null) clearTimeoutFn(finishTimer);
        finishTimer = setTimeoutFn(() => { finishTimer = null; latestText = ''; render(); }, 5000);
      }
      render();
    },
    destroy: () => {
      hide(); if (finishTimer !== null) clearTimeoutFn(finishTimer);
      documentRef.removeEventListener('pointerdown', outside, true); documentRef.removeEventListener('keydown', escape);
      windowLike?.removeEventListener('resize', position); windowLike?.visualViewport?.removeEventListener('resize', position);
      root.remove(); wave.remove(); mic.remove();
    },
  };
};
