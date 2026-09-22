import { t } from '../i18n/index.js';

const svg = path => `<svg class="maid-command-input-icon" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const icons = {
  send: svg('<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
  realtime: svg('<path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/>'),
  stt: svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>'),
};

export const resolveMaidSubmitAction = ({ submitting, hasDraft, available, mode = 'realtime', recording = 'idle', call = 'idle' } = {}) => {
  if (submitting) return { action: 'stop-task', icon: 'stop', label: '停止女仆任务' };
  if (recording !== 'idle') return { action: 'stop-recording', icon: 'stop', label: recording === 'recording' ? '停止录音并转成文字' : '取消语音输入' };
  if (hasDraft || !available) return { action: 'send', icon: 'send', label: '发送给女仆' };
  if (call !== 'idle') return { action: 'end-call', icon: 'stop', label: ['requesting_permission', 'connecting'].includes(call) ? '取消连接' : '结束女仆通话' };
  return mode === 'stt' ? { action: 'stt', icon: 'stt', label: '语音输入' } : { action: 'realtime', icon: 'realtime', label: '与女仆实时通话' };
};

// One primary action. Long press only chooses the default when the button is idle.
export const bindMaidVoiceButton = ({ button, getState, onAction, onChooseMode, schedule = setTimeout, clearSchedule = clearTimeout } = {}) => {
  let timer = null, point = null, suppressClick = false, previousIcon = '', choosing = false;
  const cleanups = [];
  const listen = (name, fn, options) => { button.addEventListener?.(name, fn, options); cleanups.push(() => button.removeEventListener?.(name, fn, options)); };
  const clear = () => { if (timer !== null) clearSchedule(timer); timer = null; point = null; };
  const canChoose = () => ['realtime', 'stt'].includes(resolveMaidSubmitAction(getState()).action);
  const choose = async () => {
    clear();
    if (choosing || !canChoose()) return;
    choosing = true; suppressClick = true;
    try { await onChooseMode?.(); } finally { choosing = false; sync(); }
  };
  const sync = () => {
    const state = getState(), current = resolveMaidSubmitAction(state);
    button.type = current.action === 'send' ? 'submit' : 'button';
    button.dataset.maidAction = current.action;
    if (previousIcon !== current.icon) { button.innerHTML = icons[current.icon]; previousIcon = current.icon; }
    button.disabled = Boolean(state.cancelPending);
    button.setAttribute?.('aria-label', t(current.label));
    button.title = canChoose() ? `${t(current.label)} · ${t('长按或右键切换语音模式')}` : t(current.label);
    button.classList?.toggle?.('is-voice-active', ['stop-recording', 'end-call'].includes(current.action));
    if (!canChoose()) clear();
    return current;
  };
  listen('pointerdown', event => {
    suppressClick = false; clear();
    if (event.button !== 0 || !canChoose()) return;
    point = { x: event.clientX, y: event.clientY };
    timer = schedule(() => void choose(), 550);
  });
  listen('pointermove', event => { if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10) clear(); });
  ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(name => listen(name, clear));
  listen('contextmenu', event => { if (!canChoose()) return; event.preventDefault?.(); event.stopPropagation?.(); void choose(); });
  listen('keydown', event => {
    if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && canChoose()) { event.preventDefault?.(); void choose(); }
  });
  listen('click', event => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault?.(); event.stopImmediatePropagation?.(); return; }
    suppressClick = false;
    const current = sync();
    if (['send', 'stop-task'].includes(current.action)) return;
    event.preventDefault?.(); event.stopImmediatePropagation?.();
    void onAction?.(current.action);
  }, true);
  sync();
  return { sync, cancelGesture: clear, dispose: () => { clear(); cleanups.forEach(fn => fn()); } };
};
