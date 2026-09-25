import { createChatVoiceRuntime } from './chat/voice-interaction-runtime.js';
import { buildMaidChatResponderMessages } from '../agent/maid-chat-responder.js';
import { appChoice } from './app-confirm.js';
import { t } from '../i18n/index.js';
import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { createMaidVoiceTaskRuntime } from './maid-voice-task-runtime.js';
import { createMaidVoiceOrbUi } from './maid-voice-orb-ui.js';

export const buildMaidVoiceSnapshot = ({ inputText = '', maidPrompt, conversationContext, context = {} } = {}) => {
  const messages = buildMaidChatResponderMessages({ input: inputText, maidPrompt, conversationContext, context });
  const voiceRules = getLocalizedPromptText('maid.voice.conversation');
  return { instructions: [messages[0].content, voiceRules, messages[1].content].join('\n\n'), messages };
};

// Shares voice transports with room calls, while owning maid context, tasks and the original ball surface.
export const createMaidVoiceRuntime = ({
  settingsStore, conversationStore, prepareConversationContext, getAppContext = () => ({}),
  getCommandRuntime, getCallAppRuntime, cancelChatVoice = async () => {},
  skillRuntime = null,
  resolveVoiceConfig, openVoiceConfig, onDebugSnapshot = null, onContextInjected = null,
  toast = {}, createRecorder = createChatVoiceRuntime, choose = appChoice,
  documentRef = globalThis.document, windowLike = globalThis.window, modeSwitchEl = null,
  createOrb = createMaidVoiceOrbUi,
  // 卡内确认：语音托盘显示本通话任务的待确认项；口头“允许”只算允许一次
  getApproval = () => null, onApprovalDecision = null, confirmApproval = () => false,
  cancelPendingAction = () => false,
  makeId = () => globalThis.crypto?.randomUUID?.() || `maid-voice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
} = {}) => {
  let recorder = null, activeTarget = null, callState = 'idle', starting = false;
  const runViews = new Map(); // 语音任务 id（= submissionId）→ 最新运行投影
  let announcedApprovalId = '';
  const orb = createOrb({ documentRef, windowLike, modeSwitchEl,
    onToggleMute: () => { const runtime = getCallAppRuntime()?.runtime; runtime?.setMicrophoneMuted(!runtime.getState().muted); },
    onToggleOutputMute: () => { const runtime = getCallAppRuntime()?.runtime; runtime?.setOutputMuted(!runtime.getState().outputMuted); },
    onEnd: () => endCall(), onStopTask: id => tasks.cancel(id),
    onApprovalDecision: payload => onApprovalDecision?.(payload),
    onOpenInput: () => getCommandRuntime()?.open({ autoFocus: false }), onRetry: () => action('realtime'),
  });
  const tasks = createMaidVoiceTaskRuntime({ getCommandRuntime, captureContext: () => structuredClone(getAppContext()),
    prepareSubmission: skillRuntime?.prepare,
    cancelPendingAction,
    onChange: state => orb?.setTasks(state),
    onResult: update => { if (isTargetCurrent(update.target)) getCallAppRuntime()?.runtime?.notifyTaskUpdate?.(update); },
    confirmApproval: taskIds => confirmApproval((taskIds || []).map(id => runViews.get(id)?.runId).filter(Boolean)) === true,
  });
  const findVoiceApproval = () => {
    for (const [taskId, view] of runViews) {
      const approval = getApproval?.(view.runId);
      if (approval) return { ...approval, taskId };
    }
    return null;
  };
  // 待确认项出现时：托盘展开显示确认块，同时让语音模型口头询问（每条只问一次）
  const refreshApprovals = () => {
    const approval = findVoiceApproval();
    orb?.setApproval?.(approval);
    if (!approval || approval.id === announcedApprovalId) return;
    announcedApprovalId = approval.id;
    const meta = tasks.getTaskMeta(approval.taskId);
    if (!meta || !isTargetCurrent(meta.target)) return;
    getCallAppRuntime()?.runtime?.notifyTaskUpdate?.({
      kind: 'confirmation', task_id: meta.task_id, status: 'awaiting_user_confirmation', request: meta.request,
      message: [approval.title, approval.message].filter(Boolean).join('：'), target: meta.target, requestId: meta.requestId,
    });
  };
  const sync = () => getCommandRuntime?.()?.syncVoiceState?.();
  const getTarget = () => ({ supported: true, uiMode: 'maid', sessionId: 'maid', scopeId: 'default', lifecycleEpoch: 0, name: t('女仆'), avatar: '' });
  const isTargetCurrent = target => target?.uiMode === 'maid' && Boolean(activeTarget?.maidCallId) && target.maidCallId === activeTarget.maidCallId;
  const getState = () => ({ mode: settingsStore.getVoiceInputMode(), recording: recorder?.getRecorderState?.() || 'idle', call: starting && callState === 'idle' ? 'connecting' : callState });
  const cancelInput = () => recorder?.cancel?.();
  const openSettings = async (mode = settingsStore.getVoiceInputMode()) => {
    getCallAppRuntime()?.setSettingsTarget(getTarget());
    await openVoiceConfig?.(mode);
  };
  const ensureRecorder = () => {
    if (!recorder) recorder = createRecorder({
      composerInput: getCommandRuntime()?.getElements?.().inputEl,
      resolveConfig: resolveVoiceConfig, toast,
      openVoiceSettings: () => openSettings('stt'),
      beforeRecording: async () => { await getCallAppRuntime()?.endAndHide('maid_stt'); await cancelChatVoice(); },
      onRecorderStateChange: sync,
    });
    return recorder;
  };
  const beforeRealtimeStart = async target => {
    await cancelInput();
    await cancelChatVoice();
    if (target.uiMode === 'maid') {
      target.maidCallId = makeId();
      skillRuntime?.beginCall(target.maidCallId);
      activeTarget = { ...target };
      getCommandRuntime()?.collapse?.();
    }
  };
  const onCallState = state => {
    if (state.status === 'idle') {
      callState = 'idle';
      const finished = activeTarget; activeTarget = null;
      if (finished) skillRuntime?.endCall(finished.maidCallId);
      if (finished) void conversationStore.finalizeRealtimeConversation(finished.maidCallId).catch(error => toast.error?.(error.message));
    } else if (state.target?.uiMode === 'maid') callState = state.status;
    sync();
  };
  const endCall = () => {
    if (starting || activeTarget) return getCallAppRuntime()?.endAndHide('maid_end');
  };
  const action = async kind => {
    try {
      if (kind === 'end-call') return await endCall();
      if (kind === 'stop-recording' || kind === 'stt') return await ensureRecorder().toggleRecording();
      if (kind === 'realtime' && !starting) {
        // 首次实时通话先说明任务由谁执行；关掉不选视为不开启“交给女仆”，由语音设置档的模型执行
        if (!settingsStore.hasChosenVoiceTaskExecutor?.()) await chooseTaskExecutor();
        starting = true; sync(); getCommandRuntime()?.collapse?.();
        try { return await getCallAppRuntime()?.startCall(getTarget()); }
        finally { starting = false; if (getCallAppRuntime()?.runtime?.getState?.().status === 'idle') onCallState({ status: 'idle' }); sync(); }
      }
    } catch (error) { toast.error?.(error?.message || t('语音操作失败')); }
  };
  const chooseTaskExecutor = async () => {
    const current = settingsStore.getVoiceTaskExecutor?.() || 'voice';
    const choice = await choose({
      title: t('语音里交代的任务由谁执行？'),
      message: [
        t('交给女仆（推荐）：用女仆设置里的模型执行，多步任务更稳，通常也更省。'),
        t('语音模型直接执行：用语音设置档的推理模型执行，不用另外配置，费用计入语音账号；非 OpenAI 的语音服务仍交给女仆。'),
        t('选择独立 Sub-agent 时，使用它绑定的模型与账号。'),
        t('两种方式修改应用内容前都会先请你确认，之后可在“默认语音模式”里更改。'),
      ].join('\n'),
      defaultActionId: settingsStore.hasChosenVoiceTaskExecutor?.() ? current : 'maid',
      actions: [
        { id: 'maid', label: t('交给女仆（推荐）'), primary: true },
        { id: 'voice', label: t('语音模型直接执行') },
      ],
    });
    await settingsStore.setVoiceTaskExecutor?.(choice === 'maid' ? 'maid' : (choice === 'voice' ? 'voice' : current));
  };
  const chooseMode = async () => {
    const mode = settingsStore.getVoiceInputMode();
    const choice = await choose({ title: t('默认语音模式'), defaultActionId: mode,
      actions: [{ id: 'realtime', label: t('实时通话'), primary: mode === 'realtime' },
        { id: 'stt', label: t('语音输入'), primary: mode === 'stt' }, { id: 'executor', label: t('任务执行方式') }, { id: 'settings', label: t('语音配置') }],
    });
    if (choice === 'executor') return chooseTaskExecutor();
    if (choice === 'settings') return openSettings();
    if (!['realtime', 'stt'].includes(choice)) return;
    await settingsStore.setVoiceInputMode(choice); sync();
  };
  const buildSemanticSnapshot = async ({ target, inputText = '' } = {}) => {
    if (!isTargetCurrent(target)) throw new Error(t('通话已结束'));
    const conversationContext = await prepareConversationContext({ input: inputText });
    if (!isTargetCurrent(target)) throw new Error(t('通话已结束'));
    const snapshot = buildMaidVoiceSnapshot({ inputText, maidPrompt: settingsStore.getMaidPrompt(), conversationContext, context: getAppContext() });
    snapshot.instructions += `\n\nCurrent maid task state (application data): ${JSON.stringify(tasks.getState(target.maidCallId))}`;
    onContextInjected?.({ conversationContext });
    onDebugSnapshot?.({ source: 'maid_realtime', input: inputText, requestPrompt: snapshot.instructions });
    return snapshot;
  };
  const commit = async ({ target, role, text, meta = {}, id, previousText = null }) => {
    if (!isTargetCurrent(target)) return { ignored: true };
    return conversationStore.upsertRealtimeTranscript({ id: `${target.maidCallId}:${role}:${id}`, callId: target.maidCallId, role, text, meta, previousText });
  };
  return {
    getSurface: () => orb,
    position: () => orb?.position(),
    setInputOpen: open => orb?.setInputOpen(open),
    prepareOpenInput: () => orb?.closeControls(),
    isCallActive: () => starting || Boolean(activeTarget),
    handleTaskRequest: options => {
      if (!isTargetCurrent(options?.target)) return { ok: false, message: t('通话已结束') };
      const latest = tasks.getState(options.target.maidCallId).latest;
      if (options.delegated && options.args?.action === 'execute' && latest?.has_references
        && /刚才|剛才|刚刚|剛剛|上一张|上一張|那张图|那張圖|这张图|這張圖|同一张|同一張|previous image|same image|that image/i.test(options.args.request || '')) {
        options = { ...options, args: { ...options.args, task_id: latest.task_id } };
      }
      return tasks.request(options);
    },
    submitText: (text, attachments = []) => tasks.request({ target: activeTarget, requestId: makeId(), args: { action: 'execute', request: text }, attachments, preserveDraft: false, showInput: true }),
    getTasks: () => tasks.getState(),
    consumeTrace: view => {
      if (view?.source !== 'maid_realtime') return false;
      const taskId = String(view.submissionId || '').trim();
      if (taskId) {
        runViews.set(taskId, view);
        while (runViews.size > 20) runViews.delete(runViews.keys().next().value);
        refreshApprovals();
      }
      return true;
    },
    canShowApproval: runId => Boolean(orb && (starting || activeTarget) && [...runViews.values()].some(view => view.runId === runId && !view.terminal)),
    refreshApprovals,
    getState, getTarget, isTargetCurrent, sync, action, chooseMode, openSettings, cancelInput, endCall, beforeRealtimeStart, onCallState, buildSemanticSnapshot,
    commitUserMessage: options => commit({ ...options, role: 'user', id: options.meta?.realtimeItemId || makeId() }),
    commitAssistantMessage: options => commit({ ...options, role: 'assistant', id: options.meta?.realtimeResponseId || makeId() }),
    commitLiveTranscript: ({ target, group, meta }) => group.detached ? { ignored: true } : commit({
      target, role: group.role, text: group.text, meta, id: group.id, previousText: group.messageId ? group.savedText : null,
    }),
    executeTranscript: async text => {
      const command = getCommandRuntime();
      if (!command || !String(text || '').trim()) return false;
      // Preserve any existing draft/attachments. The task is queued through the same UI.
      return command.submitVoiceTask(text);
    },
    destroy: async () => { await recorder?.destroy(); await endCall(); orb?.destroy(); },
  };
};
