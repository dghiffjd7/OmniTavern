import { formatRealtimeUsageText } from './realtime-usage-utils.js';
import { t, translateUiText } from '../../i18n/index.js';
import { getRealtimeProvider } from './realtime-provider-catalog.js';

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
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const callIcon = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;

export const createRealtimeCallPanel = ({
  documentRef = globalThis.document,
  onToggleMute = null,
  onToggleOutputMute = null,
  onInterrupt = null,
  onEnd = null,
} = {}) => {
  let overlay = null;
  let panel = null;
  let state = { status: 'idle', muted: false, outputMuted: false, startedAt: 0, elapsedMs: 0 };
  let tickTimer = null;

  const ensure = () => {
    if (overlay || !documentRef?.body) return;
    overlay = documentRef.createElement('div');
    overlay.className = 'realtime-call-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="realtime-call-panel" role="dialog" aria-modal="true" aria-labelledby="realtime-call-name">
        <div class="realtime-call-ambient" aria-hidden="true"></div>
        <header class="realtime-call-header">
          <span class="realtime-call-ai-badge">AI 语音</span>
          <button type="button" class="realtime-call-close" data-call-action="end" aria-label="结束并关闭">
            ${callIcon('<path d="M18 6 6 18M6 6l12 12"/>')}
          </button>
        </header>
        <div class="realtime-call-avatar-shell">
          <img class="realtime-call-avatar" alt="">
          <span class="realtime-call-pulse" aria-hidden="true"></span>
        </div>
        <h2 id="realtime-call-name" class="realtime-call-name">角色</h2>
        <div class="realtime-call-status-row">
          <span class="realtime-call-status-dot" aria-hidden="true"></span>
          <span class="realtime-call-status">准备通话</span>
          <span class="realtime-call-duration">00:00</span>
        </div>
        <div class="realtime-call-caption" aria-live="polite">
          <span class="realtime-call-caption-role">字幕</span>
          <p>连接后即可自然说话</p>
        </div>
        <div class="realtime-call-warning" role="status" hidden></div>
        <div class="realtime-call-actions">
          <button type="button" class="realtime-call-action" data-call-action="mute" aria-pressed="false">
            ${callIcon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>')}
            <span>静音</span>
          </button>
          <button type="button" class="realtime-call-action" data-call-action="interrupt">
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
        <div class="realtime-call-usage">本次用量会分别记录语音模型与输入转写</div>
        <small class="realtime-call-disclosure"></small>
      </section>`;
    documentRef.body.appendChild(overlay);
    panel = overlay.querySelector('.realtime-call-panel');
    overlay.addEventListener('click', event => {
      if (event.target !== overlay) return;
      void onEnd?.('backdrop');
    });
    panel.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-call-action]');
      if (!button) return;
      const action = button.dataset.callAction;
      if (action === 'mute') onToggleMute?.();
      else if (action === 'output') onToggleOutputMute?.();
      else if (action === 'interrupt') onInterrupt?.();
      else if (action === 'end') void onEnd?.('user');
    });
  };

  const renderState = nextState => {
    ensure();
    state = { ...state, ...(nextState || {}) };
    if (!panel) return;
    panel.dataset.state = state.status || 'idle';
    const provider = translateUiText(getRealtimeProvider(state.provider)?.label || '当前实时语音服务');
    const status = panel.querySelector('.realtime-call-status');
    if (status) status.textContent = state.status === 'connecting' && state.provider
      ? t('正在连接 {provider}…', { provider }) : translateUiText(STATUS_LABELS[state.status] || '通话中');
    const disclosure = panel.querySelector('.realtime-call-disclosure');
    if (disclosure) disclosure.textContent = t('你与角色的语音由 AI 生成；麦克风音频会发送给 {provider} 处理。', { provider });
    const duration = panel.querySelector('.realtime-call-duration');
    if (duration) duration.textContent = formatDuration(state.elapsedMs);
    const mute = panel.querySelector('[data-call-action="mute"]');
    mute?.setAttribute('aria-pressed', String(state.muted === true));
    mute?.classList.toggle('is-active', state.muted === true);
    const output = panel.querySelector('[data-call-action="output"]');
    output?.setAttribute('aria-pressed', String(state.outputMuted === true));
    output?.classList.toggle('is-active', state.outputMuted === true);
    const interrupt = panel.querySelector('[data-call-action="interrupt"]');
    if (interrupt) interrupt.disabled = !['thinking', 'speaking'].includes(state.status);
  };

  const show = ({ name = '角色', avatar = '' } = {}) => {
    ensure();
    if (!overlay || !panel) return false;
    const nameElement = panel.querySelector('.realtime-call-name');
    if (nameElement) nameElement.textContent = String(name || '角色');
    const avatarElement = panel.querySelector('.realtime-call-avatar');
    if (avatarElement) {
      avatarElement.src = String(avatar || './assets/external/feather-default.png');
      avatarElement.alt = String(name || '角色');
    }
    overlay.hidden = false;
    globalThis.requestAnimationFrame?.(() => overlay?.classList?.add('is-open'));
    if (tickTimer == null) {
      tickTimer = setInterval(() => {
        if (!state.startedAt || state.status === 'idle') return;
        renderState({ elapsedMs: Date.now() - state.startedAt });
      }, 1000);
    }
    return true;
  };

  const hide = () => {
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.hidden = true;
    if (tickTimer != null) clearInterval(tickTimer);
    tickTimer = null;
  };

  const setCaption = ({ role = '', text = '' } = {}) => {
    ensure();
    if (!panel) return;
    const label = panel.querySelector('.realtime-call-caption-role');
    const content = panel.querySelector('.realtime-call-caption p');
    if (label) label.textContent = role === 'user' ? '你' : role === 'assistant' ? '角色' : '字幕';
    if (content) content.textContent = String(text || '') || '…';
  };

  const setWarning = message => {
    ensure();
    const warning = panel?.querySelector?.('.realtime-call-warning');
    if (!warning) return;
    warning.textContent = String(message || '');
    warning.hidden = !message;
  };

  const setUsage = (totals = {}) => {
    ensure();
    const usage = panel?.querySelector?.('.realtime-call-usage');
    if (usage) usage.textContent = formatRealtimeUsageText(totals);
  };

  return { show, hide, renderState, setCaption, setWarning, setUsage };
};
