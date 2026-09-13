import { OpenAiLiveSessionClient } from './openai-live-session-client.js';
import { getRealtimeProfileStore } from '../../storage/realtime-profile-store.js';
import { registerRealtimeSettingsTarget } from './realtime-settings-target.js';
import { NativeRealtimeSessionClient } from './native-realtime-session-client.js';
import { OpenAiRealtimeSessionClient } from './openai-realtime-session-client.js';
import { createRealtimeCallPanel } from './realtime-call-panel.js';
import { createRealtimeCallRuntime } from './realtime-call-runtime.js';
import { accumulateRealtimeUsage, createRealtimeUsageTotals } from './realtime-usage-utils.js';

const normalizeText = value => String(value || '').trim();

export const resolveRealtimeCallTarget = ({
  uiMode = 'chat',
  currentSessionId = '',
  activePersonaId = '',
  getRpSessionId = personaId => `rp:${normalizeText(personaId) || 'default'}`,
  scopeId = 'default',
  lifecycleEpoch = 0,
  getContact = () => null,
  formatSessionName = sessionId => sessionId,
  getAssistantAvatar = () => '',
} = {}) => {
  const targetUiMode = normalizeText(uiMode).toLowerCase() === 'rp' ? 'rp' : 'chat';
  const sessionId = targetUiMode === 'rp'
    ? normalizeText(getRpSessionId(activePersonaId))
    : normalizeText(currentSessionId);
  if (!sessionId) {
    return {
      supported: false,
      reason: targetUiMode === 'rp' ? '请先选择一个角色卡' : '请先打开一个角色会话',
    };
  }
  if (targetUiMode === 'chat' && sessionId.startsWith('rp:')) {
    return { supported: false, reason: '请先打开一个角色会话' };
  }
  const contact = getContact(sessionId);
  if (targetUiMode === 'chat' && (Boolean(contact?.isGroup) || sessionId.startsWith('group:'))) {
    return { supported: false, reason: '首版实时语音暂不支持群聊' };
  }
  return {
    supported: true,
    sessionId,
    scopeId: normalizeText(scopeId) || 'default',
    lifecycleEpoch: Number(lifecycleEpoch) || 0,
    uiMode: targetUiMode,
    name: normalizeText(formatSessionName(sessionId, contact)) || '角色',
    avatar: normalizeText(getAssistantAvatar(sessionId)),
  };
};

export const isRealtimeCallTargetMatch = (capturedTarget, currentTarget) => (
  capturedTarget?.supported === true
  && currentTarget?.supported === true
  && normalizeText(capturedTarget.sessionId) === normalizeText(currentTarget.sessionId)
  && normalizeText(capturedTarget.scopeId) === normalizeText(currentTarget.scopeId)
  && Number(capturedTarget.lifecycleEpoch) === Number(currentTarget.lifecycleEpoch)
  && normalizeText(capturedTarget.uiMode) === normalizeText(currentTarget.uiMode)
);

export const createRealtimeCallAppRuntime = ({
  button = null,
  documentRef = globalThis.document,
  windowLike = globalThis.window,
  getCallTarget,
  resolveConnection,
  buildSemanticSnapshot,
  isTargetCurrent,
  commitUserMessage,
  commitAssistantMessage,
  commitLiveTranscript,
  openVoiceSettings = null,
  onLifecycleInvalidated = null,
  toast = null,
  createPanel = createRealtimeCallPanel,
  createRuntime = createRealtimeCallRuntime,
  createSessionClient = callbacks => callbacks.provider && callbacks.provider !== 'openai'
    ? new NativeRealtimeSessionClient(callbacks) : callbacks.openaiBackend === 'live' ? new OpenAiLiveSessionClient(callbacks) : new OpenAiRealtimeSessionClient(callbacks),
} = {}) => {
  let usageTotals = createRealtimeUsageTotals();
  let runtime = null;
  let panel = null;

  const endAndHide = async reason => {
    await runtime?.end?.(reason || 'user');
    panel?.hide?.();
  };

  panel = createPanel({
    documentRef,
    windowLike,
    onToggleMute: () => {
      const muted = runtime?.getState?.().muted === true;
      runtime?.setMicrophoneMuted?.(!muted);
    },
    onToggleOutputMute: () => {
      const muted = runtime?.getState?.().outputMuted === true;
      runtime?.setOutputMuted?.(!muted);
    },
    onInterrupt: () => runtime?.interrupt?.(),
    onEnd: reason => endAndHide(reason),
  });

  runtime = createRuntime({
    createSessionClient,
    resolveConnection: async options => {
      const bound = globalThis.localStorage ? await getRealtimeProfileStore().resolveBinding(options?.target) : null;
      return bound || resolveConnection?.(options);
    },
    buildSemanticSnapshot,
    getCallTarget,
    isTargetCurrent,
    commitUserMessage,
    commitAssistantMessage,
    commitLiveTranscript,
    onStateChange: state => {
      panel?.renderState?.(state);
      if (state.status === 'idle') panel?.hide?.();
      button?.classList?.toggle?.('is-active', state.status !== 'idle');
      button?.setAttribute?.('aria-pressed', String(state.status !== 'idle'));
    },
    onCaption: caption => panel?.setCaption?.(caption),
    onAudioLevel: value => panel?.setAudioLevel?.(value),
    onUsage: event => {
      usageTotals = accumulateRealtimeUsage(usageTotals, event);
      panel?.setUsage?.(usageTotals);
    },
    onWarning: message => {
      panel?.setWarning?.(message);
      toast?.warning?.(message);
    },
    onError: error => {
      const message = String(error?.message || error || 'Realtime 语音发生错误');
      panel?.setWarning?.(message);
      if (error?.code === 'input_transcription_failed') toast?.warning?.(message);
      else toast?.error?.(message);
      if (String(error?.code || '').startsWith('realtime_config_')) void openVoiceSettings?.();
    },
  });

  const syncButtonAvailability = () => {
    if (!button) return;
    const target = getCallTarget?.() || {};
    button.hidden = target.supported !== true;
    button.disabled = target.supported !== true;
  };

  const handleButtonClick = async () => {
    const target = getCallTarget?.() || {};
    if (!target.supported) {
      toast?.warning?.(target.reason || '当前会话暂不支持实时语音');
      return false;
    }
    if (runtime.getState().status !== 'idle') {
      panel.show(target, { expanded: true });
      return true;
    }
    usageTotals = createRealtimeUsageTotals();
    panel.setUsage(usageTotals);
    panel.setWarning('');
    panel.setCaption({ role: '', text: '连接后即可自然说话' });
    panel.show(target, { expanded: true });
    const started = await runtime.start();
    if (!started) panel.hide();
    return started;
  };

  const unregisterSettingsTarget = registerRealtimeSettingsTarget(getCallTarget, handleButtonClick);

  const endForLifecycle = reason => {
    // Live drains timestamped fragments and final usage before invalidation.
    // end() enters 'ending' immediately; target/scope checks still reject a
    // character or archive change during that drain.
    if (runtime?.getState?.().openaiBackend === 'live') {
      return endAndHide(reason).finally(() => onLifecycleInvalidated?.(reason));
    }
    onLifecycleInvalidated?.(reason);
    return endAndHide(reason);
  };
  const handlePageHide = () => { void endForLifecycle('page_hidden'); };
  const handleVisibilityChange = () => {
    if (documentRef?.visibilityState !== 'hidden') return;
    void endForLifecycle('app_background');
  };

  button?.addEventListener?.('click', handleButtonClick);
  windowLike?.addEventListener?.('pagehide', handlePageHide);
  documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
  syncButtonAvailability();

  return {
    runtime,
    panel,
    syncButtonAvailability,
    endAndHide,
    destroy: async () => {
      unregisterSettingsTarget();
      button?.removeEventListener?.('click', handleButtonClick);
      windowLike?.removeEventListener?.('pagehide', handlePageHide);
      documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
      await endAndHide('destroy');
      panel?.destroy?.();
    },
  };
};
