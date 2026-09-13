import { formatRealtimeUsageText } from './realtime-usage-utils.js';
import { t, translateUiText, localizeDomSubtree } from '../../i18n/index.js';
import { getRealtimeProvider } from './realtime-provider-catalog.js';
import { bindRealtimeCallFloatingPosition } from './realtime-call-floating-position.js';

const STATUS_LABELS = Object.freeze({
  idle: '通话已结束',
  requesting_permission: '正在请求麦克风权限…',
  connecting: '正在连接语音服务…',
  listening: '正在听',
  thinking: '正在准备回应',
  speaking: '正在说话',
  reconnecting: '连接已中断',
  error: '通话发生错误',
  ending: '正在结束通话…',
});

const formatDuration = milliseconds => {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const callIcon = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
let panelSequence = 0;

export const createRealtimeCallPanel = ({
  documentRef = globalThis.document,
  windowLike = documentRef?.defaultView || globalThis.window,
  onToggleMute = null,
  onToggleOutputMute = null,
  onInterrupt = null,
  onEnd = null,
} = {}) => {
  let layer = null, panel = null, handle = null, body = null, position = null;
  let state = { status: 'idle', muted: false, outputMuted: false, startedAt: 0, elapsedMs: 0 };
  let tickTimer = null;
  let expanded = false;
  let destroyed = false;
  let previousFocus = null;
  let waveBars = [];

  const setExpanded = (value, { restoreFocus = false } = {}) => {
    if (!panel) return;
    expanded = value === true;
    const focusInBody = body.contains(panel.ownerDocument.activeElement) || panel.ownerDocument.activeElement === panel.querySelector('.realtime-call-minimize');
    body.hidden = !expanded;
    panel.classList.toggle('is-expanded', expanded);
    layer.classList.toggle('is-expanded', expanded);
    panel.setAttribute('role', expanded ? 'dialog' : 'region');
    if (expanded) panel.setAttribute('aria-modal', 'true');
    else panel.removeAttribute('aria-modal');
    panel.querySelector('.realtime-call-minimize').hidden = !expanded;
    handle.setAttribute('aria-expanded', String(expanded));
    handle.setAttribute('aria-label', translateUiText(expanded ? '最小化通话' : '展开通话控制'));
    if (!expanded && restoreFocus && focusInBody) handle.focus({ preventScroll: true });
    position?.layout();
  };

  const outsidePointerDown = event => {
    if (layer.hidden || !expanded || panel.contains(event.target) || event.target?.closest?.('.app-help-tip')) return;
    if (event.target === layer) { event.preventDefault(); event.stopPropagation(); }
    setExpanded(false);
  };
  const keyDown = event => {
    if (event.key === 'Tab' && expanded) {
      const items = [...panel.querySelectorAll('button:not(:disabled), summary, [tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = items[0], last = items.at(-1), active = panel.ownerDocument.activeElement;
      if ((event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
      return;
    }
    // Consume Escape only while focus is inside this widget, leaving app navigation available.
    if (event.key !== 'Escape' || !expanded || !panel.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false, { restoreFocus: true });
  };
  const click = event => {
    const button = event.target?.closest?.('[data-call-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.callAction;
    if (action === 'toggle') setExpanded(!expanded, { restoreFocus: true });
    else if (action === 'minimize') { setExpanded(false); handle.focus({ preventScroll: true }); }
    else if (action === 'mute') onToggleMute?.();
    else if (action === 'output') onToggleOutputMute?.();
    else if (action === 'interrupt') onInterrupt?.();
    else if (action === 'end') void onEnd?.('user');
  };

  const ensure = () => {
    if (layer || destroyed || !documentRef?.body) return;
    const id = `realtime-call-${++panelSequence}`;
    layer = documentRef.createElement('div');
    layer.className = 'realtime-call-layer';
    layer.hidden = true;
    layer.innerHTML = `
      <section class="realtime-call-panel" role="region" aria-label="实时通话">
        <button type="button" class="realtime-call-minimize" data-call-action="minimize" aria-label="最小化通话" title="最小化通话" hidden>${callIcon('<path d="M6 12h12"/>')}</button>
        <button type="button" class="realtime-call-handle" data-call-action="toggle"
          aria-expanded="false" aria-controls="${id}-controls" aria-label="展开通话控制"
          aria-describedby="${id}-name ${id}-status ${id}-duration"
          title="拖动收起并吸附到顶部或两侧；Alt + 方向键移动，Alt + Home 回到顶部">
          <span class="realtime-call-avatar-shell">
            <img class="realtime-call-avatar" alt="" draggable="false">
            <span class="realtime-call-muted-mark" aria-hidden="true" hidden>
              ${callIcon('<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 11a7 7 0 0 0 12 5M19 11v2M12 19v3"/>')}
            </span>
          </span>
          <span class="realtime-call-identity">
            <span id="${id}-name" class="realtime-call-name" data-i18n-skip>角色</span>
            <span id="${id}-status" class="realtime-call-status">准备通话</span>
          </span>
          <span class="realtime-call-signal">
            <span class="realtime-call-wave" aria-hidden="true">${'<i></i>'.repeat(9)}</span>
            <span id="${id}-duration" class="realtime-call-duration" aria-label="通话时长">00:00</span>
          </span>
          <span class="realtime-call-alert" aria-label="通话提醒" hidden>!</span>
          <span class="realtime-call-chevron" aria-hidden="true">${callIcon('<path d="m8 10 4 4 4-4"/>')}</span>
        </button>
        <div id="${id}-controls" class="realtime-call-body" hidden>
          <div class="realtime-call-caption" aria-live="polite" aria-atomic="true">
            <span class="realtime-call-caption-role">字幕</span>
            <p data-i18n-skip>连接后即可自然说话</p>
          </div>
          <div class="realtime-call-warning" role="status" hidden></div>
          <div class="realtime-call-actions">
            <button type="button" class="realtime-call-action" data-call-action="mute" aria-pressed="false">
              ${callIcon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>')}
              <span>静音</span>
            </button>
            <button type="button" class="realtime-call-action" data-call-action="interrupt" disabled>
              ${callIcon('<rect x="6" y="6" width="12" height="12" rx="3"/>')}
              <span>打断</span>
            </button>
            <button type="button" class="realtime-call-action" data-call-action="output" aria-pressed="false">
              ${callIcon('<path d="M5 10v4h4l5 4V6l-5 4H5zM18 9a4 4 0 0 1 0 6"/>')}
              <span>扬声器</span>
            </button>
            <button type="button" class="realtime-call-action is-end" data-call-action="end">
              ${callIcon('<path d="M5.2 15.5c4.5-3.2 9.1-3.2 13.6 0l1.7-2.8c-5.7-4.2-11.3-4.2-17 0l1.7 2.8z"/><path d="M7 14l-1 4M17 14l1 4"/>')}
              <span>结束</span>
            </button>
          </div>
          <footer class="realtime-call-footer">
            <span class="realtime-call-disclosure" tabindex="0" data-help-mode="tap">AI 语音</span>
            <details class="realtime-call-details">
              <summary>本次用量</summary>
              <div class="realtime-call-usage"></div>
            </details>
          </footer>
        </div>
      </section>`;
    documentRef.body.appendChild(layer);
    panel = layer.querySelector('.realtime-call-panel');
    handle = panel.querySelector('.realtime-call-handle');
    body = panel.querySelector('.realtime-call-body');
    waveBars = [...panel.querySelectorAll('.realtime-call-wave i')];
    position = bindRealtimeCallFloatingPosition({ layer, panel, handle, windowLike, isExpanded: () => expanded, onExpandedChange: value => setExpanded(value, { restoreFocus: true }) });
    panel.addEventListener('click', click);
    panel.addEventListener('keydown', keyDown);
    localizeDomSubtree(panel);
  };

  const renderState = nextState => {
    ensure();
    state = { ...state, ...(nextState || {}) };
    if (!panel) return;
    panel.dataset.state = state.status || 'idle';
    panel.classList.toggle('is-live', state.openaiBackend === 'live');
    panel.classList.toggle('is-muted', state.muted === true);
    panel.querySelector('.realtime-call-muted-mark').hidden = state.muted !== true;
    const provider = state.provider === 'openai' && state.openaiBackend === 'live' ? 'OpenAI GPT-Live' : translateUiText(getRealtimeProvider(state.provider)?.label || '当前实时语音服务');
    const status = panel.querySelector('.realtime-call-status');
    const statusText = state.status === 'connecting' && state.provider
      ? t('正在连接 {provider}…', { provider })
      : translateUiText(state.status === 'listening' && state.muted ? '麦克风已静音' : state.status === 'listening' && state.openaiBackend === 'live' ? '通话中' : STATUS_LABELS[state.status] || '通话中');
    status.textContent = statusText;
    status.title = statusText;
    const disclosure = panel.querySelector('.realtime-call-disclosure');
    disclosure.dataset.help = t('你与角色的语音由 AI 生成；麦克风音频会发送给 {provider} 处理。', { provider });
    panel.querySelector('.realtime-call-duration').textContent = formatDuration(state.elapsedMs);
    const mute = panel.querySelector('[data-call-action="mute"]');
    mute.setAttribute('aria-pressed', String(state.muted === true));
    mute.classList.toggle('is-active', state.muted === true);
    mute.querySelector('span').textContent = translateUiText(state.muted ? '取消静音' : '静音');
    const output = panel.querySelector('[data-call-action="output"]');
    output.setAttribute('aria-pressed', String(state.outputMuted === true));
    output.classList.toggle('is-active', state.outputMuted === true);
    output.querySelector('span').textContent = translateUiText(state.outputMuted ? '开启扬声器' : '扬声器');
    panel.querySelector('[data-call-action="interrupt"]').disabled = !['thinking', 'speaking'].includes(state.status);
    panel.querySelector('[data-call-action="interrupt"]').hidden = state.openaiBackend === 'live';
  };

  const show = ({ name = '角色', avatar = '' } = {}, { expanded: openControls = true } = {}) => {
    ensure();
    if (!layer || destroyed) return false;
    const nameElement = panel.querySelector('.realtime-call-name');
    nameElement.textContent = String(name || translateUiText('角色'));
    nameElement.title = nameElement.textContent;
    panel.querySelector('.realtime-call-avatar').src = String(avatar || './assets/external/feather-default.png');
    if (layer.hidden) {
      previousFocus = panel.ownerDocument.activeElement;
      layer.hidden = false;
      panel.ownerDocument.addEventListener('pointerdown', outsidePointerDown, true);
      position.start();
    }
    setExpanded(openControls);
    renderState();
    if (openControls) panel.querySelector('.realtime-call-minimize').focus({ preventScroll: true });
    if (tickTimer == null) tickTimer = windowLike.setInterval(() => {
      if (state.startedAt && state.status !== 'idle') {
        state.elapsedMs = Date.now() - state.startedAt;
        panel.querySelector('.realtime-call-duration').textContent = formatDuration(state.elapsedMs);
      }
    }, 1000);
    return true;
  };

  const hide = () => {
    if (!layer) return;
    const hadFocus = panel.contains(panel.ownerDocument.activeElement);
    position.stop();
    setExpanded(false);
    panel.querySelector('.realtime-call-details').open = false;
    layer.hidden = true;
    panel.ownerDocument.removeEventListener('pointerdown', outsidePointerDown, true);
    if (tickTimer != null) windowLike.clearInterval(tickTimer);
    tickTimer = null;
    setAudioLevel();
    if (hadFocus && previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
  };

  const setCaption = ({ role = '', text = '', captions = null } = {}) => {
    ensure();
    if (!panel) return;
    const container = panel.querySelector('.realtime-call-caption');
    container.classList.toggle('is-live-captions', Array.isArray(captions));
    if (Array.isArray(captions)) {
      const wasFollowing = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
      container.replaceChildren();
      for (const caption of captions) {
        const label = documentRef.createElement('span'); label.className = 'realtime-call-caption-role';
        label.textContent = translateUiText(caption.role === 'user' ? '你' : '角色');
        const paragraph = documentRef.createElement('p'); paragraph.textContent = String(caption.text || '');
        container.append(label, paragraph);
      }
      if (wasFollowing) container.scrollTop = container.scrollHeight;
      return;
    }
    if (container.children.length !== 2) {
      const label = documentRef.createElement('span'); label.className = 'realtime-call-caption-role';
      container.replaceChildren(label, documentRef.createElement('p'));
    }
    panel.querySelector('.realtime-call-caption-role').textContent = translateUiText(role === 'user' ? '你' : role === 'assistant' ? '角色' : '字幕');
    const content = panel.querySelector('.realtime-call-caption p');
    content.textContent = String(text || '') || '…';
    if (!role) content.textContent = translateUiText(content.textContent);
  };

  const setWarning = message => {
    ensure();
    if (!panel) return;
    const warning = panel.querySelector('.realtime-call-warning');
    warning.textContent = String(message || '');
    warning.hidden = !message;
    const alert = panel.querySelector('.realtime-call-alert');
    alert.hidden = !message;
    alert.title = warning.textContent;
    panel.classList.toggle('has-warning', Boolean(message));
  };

  const setUsage = (totals = {}) => {
    ensure();
    if (panel) panel.querySelector('.realtime-call-usage').textContent = translateUiText(formatRealtimeUsageText(totals));
  };

  const setAudioLevel = (value = {}) => {
    if (!panel) return;
    const input = state.muted ? null : value.input, output = state.outputMuted ? null : value.output;
    const channel = (output?.level || 0) > (input?.level || 0) ? output : input;
    const clamp = level => Math.max(0, Math.min(1, Number(level) || 0));
    panel.style.setProperty('--call-level', clamp(channel?.level).toFixed(3));
    panel.dataset.audioSource = channel === output && output ? 'output' : 'input';
    waveBars.forEach((bar, index) => bar.style.setProperty('--bar-level', (.12 + .88 * clamp(channel?.bands?.[index])).toFixed(3)));
  };

  const destroy = () => {
    hide();
    panel?.removeEventListener('click', click);
    panel?.removeEventListener('keydown', keyDown);
    layer?.remove();
    destroyed = true;
    layer = panel = handle = body = position = previousFocus = null;
    waveBars = [];
  };

  return { show, hide, renderState, setCaption, setWarning, setUsage, setAudioLevel, destroy };
};
