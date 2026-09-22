import { OpenAiLiveSessionClient } from './openai-live-session-client.js';
import { getRealtimeProfileStore } from '../../storage/realtime-profile-store.js';
import { registerRealtimeSettingsTarget, isRealtimeSettingsCheckActive } from './realtime-settings-target.js';
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
  resolveProfileBinding = target => globalThis.localStorage ? getRealtimeProfileStore().resolveBinding(target) : null,
  buildSemanticSnapshot,
  isTargetCurrent,
  commitUserMessage,
  commitAssistantMessage,
  commitLiveTranscript,
  handleMaidTaskRequest,
  getMaidSurface = () => null,
  registerSettingsTarget = registerRealtimeSettingsTarget,
  openVoiceSettings = null,
  onLifecycleInvalidated = null,
  beforeStart = null,
  onStateChange = null,
  onExecuteTranscript = null,
  toast = null,
  createPanel = createRealtimeCallPanel,
  createRuntime = createRealtimeCallRuntime,
  createSessionClient = callbacks => callbacks.provider && callbacks.provider !== 'openai'
    ? new NativeRealtimeSessionClient(callbacks) : callbacks.openaiBackend === 'live' ? new OpenAiLiveSessionClient(callbacks) : new OpenAiRealtimeSessionClient(callbacks),
} = {}) => {
  let usageTotals = createRealtimeUsageTotals();
  let runtime = null;
  let panel = null;
  let settingsTarget = null;
  let presentationTarget = null;
  let startPending = false;
  let startVersion = 0;
  const surface = () => presentationTarget?.uiMode === 'maid' ? getMaidSurface() : panel;

  const endAndHide = async reason => {
    startVersion++;
    const currentSurface = surface();
    await runtime?.end?.(reason || 'user');
    currentSurface?.hide?.();
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
    onExecuteTranscript: async text => {
      const target = runtime?.getState?.().target;
      if (target?.uiMode !== 'maid' || !text?.trim()) return;
      await endAndHide('maid_task');
      await onExecuteTranscript?.(text, target);
    },
  });

  runtime = createRuntime({
    createSessionClient,
    resolveConnection: async options => {
      const bound = await resolveProfileBinding(options?.target);
      return bound || resolveConnection?.(options);
    },
    buildSemanticSnapshot,
    getCallTarget,
    isTargetCurrent,
    commitUserMessage,
    commitAssistantMessage,
    commitLiveTranscript,
    handleMaidTaskRequest,
    onStateChange: state => {
      surface()?.renderState?.(state);
      if (state.status === 'idle') surface()?.hide?.();
      const active = state.status !== 'idle' && state.target?.uiMode !== 'maid';
      button?.classList?.toggle?.('is-active', active);
      button?.setAttribute?.('aria-pressed', String(active));
      onStateChange?.(state);
    },
    onCaption: caption => surface()?.setCaption?.(caption),
    onAudioLevel: value => surface()?.setAudioLevel?.(value),
    onUsage: event => {
      usageTotals = accumulateRealtimeUsage(usageTotals, event);
      surface()?.setUsage?.(usageTotals);
    },
    onWarning: message => {
      surface()?.setWarning?.(message);
      toast?.warning?.(message);
    },
    onError: error => {
      const message = String(error?.message || error || 'Realtime 语音发生错误');
      surface()?.setWarning?.(message);
      if (error?.code === 'input_transcription_failed') toast?.warning?.(message);
      else toast?.error?.(message);
      if (String(error?.code || '').startsWith('realtime_config_')) void openVoiceSettings?.(settingsTarget);
    },
  });

  const syncButtonAvailability = () => {
    if (!button) return;
    const target = getCallTarget?.() || {};
    button.hidden = target.supported !== true;
    button.disabled = target.supported !== true;
  };

  const startCall = async (target = getCallTarget?.() || {}) => {
    if (isRealtimeSettingsCheckActive()) { toast?.warning?.('实时连接检查中，请稍候或取消检查'); return false; }
    if (!target?.supported) {
      toast?.warning?.(target?.reason || '当前会话暂不支持实时语音');
      return false;
    }
    if (startPending) return false;
    startPending = true;
    try {
      const active = runtime.getState();
      if (active.status !== 'idle' && isRealtimeCallTargetMatch(active.target, target)) {
        if (target.uiMode === 'maid') surface()?.toggleControls?.();
        else panel.show(active.target, { expanded: true });
        return true;
      }
      if (active.status !== 'idle') await endAndHide('switch_target');
      settingsTarget = target;
      presentationTarget = target;
      const version = ++startVersion;
      await beforeStart?.(target);
      if (version !== startVersion) return false;
      usageTotals = createRealtimeUsageTotals();
      surface()?.setUsage?.(usageTotals);
      surface()?.setWarning?.('');
      surface()?.show?.(target, { expanded: true });
      surface()?.setCaption?.({ role: '', text: '连接后即可自然说话' });
      const started = await runtime.start(target);
      if (!started) surface()?.hide?.();
      return started;
    } catch (error) {
      surface()?.hide?.();
      onStateChange?.({ status: 'idle', target: null });
      toast?.error?.(String(error?.message || error));
      return false;
    } finally { startPending = false; }
  };
  const handleButtonClick = () => startCall();

  const getSettingsTarget = () => settingsTarget?.uiMode === 'maid' ? settingsTarget : getCallTarget?.();
  const unregisterSettingsTarget = registerSettingsTarget(getSettingsTarget, () => startCall(getSettingsTarget()), () => startPending || runtime.getState().status !== 'idle');

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
    startCall,
    setSettingsTarget: target => { settingsTarget = target; },
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
