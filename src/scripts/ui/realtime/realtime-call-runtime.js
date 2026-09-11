import { t } from '../../i18n/index.js';
import {
  buildOpenAiRealtimeSessionConfig,
  normalizeRealtimeVoiceSettings,
  applyRealtimeReplyLanguage,
} from './realtime-voice-config-utils.js';

const TERMINAL_RESPONSE_STATUSES = new Set(['completed', 'cancelled', 'failed', 'incomplete']);
const MAX_CALL_DURATION_MS = 60 * 60 * 1000;
const MAX_CALL_WARNING_MS = 55 * 60 * 1000;

const extractResponseTranscript = response => {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .map(part => String(part?.transcript || part?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

const normalizeUsage = value => value && typeof value === 'object' ? { ...value } : null;

const makeResponseRecord = (id = '') => ({
  id: String(id || '').trim(),
  transcript: '',
  committed: false,
  terminal: false,
  interrupted: false,
  usage: null,
  usageReported: false,
});

export const createRealtimeCallRuntime = ({
  createSessionClient,
  resolveConnection,
  buildSemanticSnapshot,
  getCallTarget,
  isTargetCurrent = () => true,
  commitUserMessage,
  commitAssistantMessage,
  onStateChange = null,
  onCaption = null,
  onAudioLevel = null,
  onUsage = null,
  onError = null,
  onWarning = null,
  now = () => Date.now(),
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
} = {}) => {
  let state = {
    status: 'idle',
    muted: false,
    outputMuted: false,
    startedAt: 0,
    elapsedMs: 0,
    target: null,
    sessionId: '',
    provider: '',
    error: '',
  };
  let sessionClient = null;
  let target = null;
  let connection = null;
  let responseRecords = new Map();
  let activeResponseId = '';
  let completedInputItems = new Set();
  let committedMessageIds = new Set();
  let eventQueue = Promise.resolve();
  let timeoutTimer = null;
  let lastActivityAt = 0;
  let idleWarned = false;
  let durationWarned = false;
  let endingPromise = null;
  let startGeneration = 0;
  let connectAbortController = null;
  let suppressAssistantCommit = false;
  const pendingNaturalInputs = new Set();
  const deferredNaturalResponses = new Map();
  const isNatural = () => connection?.settings?.contextMode === 'session_snapshot';
  const generationChannel = () => connection?.config?.provider && connection.config.provider !== 'openai'
    ? connection.config.provider : 'openai_realtime';

  const emitState = (status, patch = {}) => {
    state = { ...state, ...patch, status };
    try { onStateChange?.({ ...state }); } catch {}
  };

  const touchActivity = () => {
    lastActivityAt = now();
    idleWarned = false;
  };

  const isCapturedTargetCurrent = () => Boolean(target && isTargetCurrent(target));

  const enqueue = task => {
    eventQueue = eventQueue.then(async () => {
      if (typeof task === 'function') await task();
    }).catch(error => {
      try { onError?.(error); } catch {}
      if (isNatural() && ['user_message_commit_failed', 'assistant_message_commit_failed'].includes(error?.code)) {
        suppressAssistantCommit = true; void end('persistence_failed'); return;
      }
      if (state.status !== 'ending' && state.status !== 'idle') emitState('listening');
    });
    return eventQueue;
  };

  const getResponseRecord = (responseId, { create = true } = {}) => {
    const id = String(responseId || activeResponseId || '').trim();
    if (!id) return null;
    let record = responseRecords.get(id);
    if (!record && create) {
      record = makeResponseRecord(id);
      responseRecords.set(id, record);
    }
    return record || null;
  };

  const reportResponseUsage = record => {
    if (!record?.usage || record.usageReported) return;
    record.usageReported = true;
    try { onUsage?.({ type: 'response', usage: record.usage, responseId: record.id }); } catch {}
  };

  const finalizeAssistant = async (responseId, {
    response = null,
    interrupted = false,
  } = {}) => {
    const record = getResponseRecord(responseId);
    if (!record || record.committed || suppressAssistantCommit) return false;
    if (isNatural() && pendingNaturalInputs.size && !interrupted) { deferredNaturalResponses.set(responseId, { response, interrupted }); return false; }
    if (response?.usage) record.usage = normalizeUsage(response.usage);
    reportResponseUsage(record);
    if (!record.transcript) record.transcript = extractResponseTranscript(response);
    record.interrupted = record.interrupted || interrupted;
    const transcript = String(record.transcript || '').trim();
    if (!transcript || !isCapturedTargetCurrent()) return false;
    if (activeResponseId === record.id) activeResponseId = '';
    const committed = await commitAssistantMessage?.({
      target,
      text: transcript,
      meta: {
        generationChannel: generationChannel(),
        realtimeProvider: connection?.config?.provider || 'openai',
        realtimeContextMode: isNatural() ? 'session_snapshot' : 'per_turn',
        realtimeModel: connection?.settings?.realtimeModel || '',
        transcriptionModel: connection?.settings?.transcriptionModel || '',
        realtimeVoice: connection?.settings?.voice || '',
        realtimeSessionId: state.sessionId || '',
        realtimeResponseId: record.id,
        realtimeInterrupted: record.interrupted === true,
        transcriptApproximate: record.interrupted === true,
        ...(record.usage ? { usage: record.usage } : {}),
      },
    });
    if (!committed) { const error = new Error(t('语音回复保存失败')); error.code = 'assistant_message_commit_failed'; throw error; }
    record.committed = true;
    const committedId = String(committed?.messageId || committed?.id || '').trim();
    if (committedId) committedMessageIds.add(committedId);
    return true;
  };

  const handleInputTranscriptionCompleted = async event => {
    const itemId = String(event?.item_id || event?.item?.id || '').trim();
    const transcript = String(event?.transcript || event?.text || '').trim();
    if (!itemId || completedInputItems.has(itemId)) return;
    completedInputItems.add(itemId);
    if (event?.usage) {
      try { onUsage?.({ type: 'transcription', usage: normalizeUsage(event.usage), itemId }); } catch {}
    }
    if (!transcript) { pendingNaturalInputs.delete(itemId); await flushNaturalResponses(); return; }
    if (state.status === 'ending' || state.status === 'idle') return;
    if (!isCapturedTargetCurrent()) return;
    touchActivity();
    emitState('thinking');
    try { onCaption?.({ role: 'user', text: transcript, final: true }); } catch {}
    const snapshot = isNatural() ? null : await buildSemanticSnapshot?.({
      target,
      inputText: transcript,
      realtimeSessionId: state.sessionId || '',
      excludeMessageIds: Array.from(committedMessageIds),
    });
    if (state.status === 'ending' || state.status === 'idle') return;
    if (!isCapturedTargetCurrent()) return;
    const committed = await commitUserMessage?.({
      target,
      text: transcript,
      meta: {
        generationChannel: generationChannel(),
        realtimeProvider: connection?.config?.provider || 'openai',
        realtimeContextMode: isNatural() ? 'session_snapshot' : 'per_turn',
        realtimeModel: connection?.settings?.realtimeModel || '',
        transcriptionModel: connection?.settings?.transcriptionModel || '',
        realtimeSessionId: state.sessionId || '',
        realtimeItemId: itemId,
        ...(event?.usage ? { transcriptionUsage: normalizeUsage(event.usage) } : {}),
      },
    });
    if (!committed) {
      if (state.status === 'ending' || state.status === 'idle') return;
      if (!isCapturedTargetCurrent()) return;
      if (isNatural()) { suppressAssistantCommit = true; try { sessionClient?.sendEvent?.({ type: 'response.cancel' }); } catch {} }
      const error = new Error('语音消息保存失败，已停止生成');
      error.code = 'user_message_commit_failed';
      throw error;
    }
    const committedId = String(committed?.messageId || committed?.id || '').trim();
    if (committedId) committedMessageIds.add(committedId);
    if (state.status === 'ending' || state.status === 'idle') return;
    if (!isCapturedTargetCurrent()) return;
    if (isNatural()) { pendingNaturalInputs.delete(itemId); await flushNaturalResponses(); return; }
    const instructions = String(snapshot?.instructions || '').trim();
    if (!instructions) throw new Error('本轮语义上下文为空，已停止生成');
    sessionClient?.sendEvent?.({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: applyRealtimeReplyLanguage(instructions, connection.settings),
      },
    });
    sessionClient?.sendEvent?.({
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    });
  };

  const flushNaturalResponses = async () => {
    if (pendingNaturalInputs.size) return;
    for (const [id, options] of deferredNaturalResponses) { deferredNaturalResponses.delete(id); await finalizeAssistant(id, options); }
  };

  const handleServerEvent = event => {
    const type = String(event?.type || '').trim();
    if (!type || state.status === 'idle' || state.status === 'ending') return;
    if (type === 'warning') { onWarning?.(event.message); return; }
    if (type === 'usage.delta') { onUsage?.({ type: 'response', usage: event.usage }); return; }
    if (type === 'input.transcript.preview') { onCaption?.({ role: 'user', text: event.text, final: false }); return; }
    if (type === 'session.created' || type === 'session.updated') {
      const realtimeSessionId = String(event?.session?.id || state.sessionId || '').trim();
      if (realtimeSessionId && realtimeSessionId !== state.sessionId) {
        emitState(state.status, { sessionId: realtimeSessionId });
      }
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      if (isNatural() && event.item_id) pendingNaturalInputs.add(event.item_id);
      touchActivity();
      const interruptedResponseId = activeResponseId;
      enqueue(async () => {
        if (interruptedResponseId) await finalizeAssistant(interruptedResponseId, { interrupted: true });
        emitState('listening');
      });
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      if (event.reason === 'turn_invalid') { pendingNaturalInputs.delete(event.item_id); enqueue(flushNaturalResponses); emitState('listening'); return; }
      touchActivity();
      emitState('thinking');
      return;
    }
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      touchActivity();
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      enqueue(() => handleInputTranscriptionCompleted(event));
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      enqueue(async () => {
        pendingNaturalInputs.delete(event.item_id); await flushNaturalResponses();
        emitState('listening');
        const error = new Error(String(event?.error?.message || '语音转写失败，请重说一次'));
        error.code = 'input_transcription_failed';
        onError?.(error);
      });
      return;
    }
    if (type === 'response.created') {
      const responseId = String(event?.response?.id || '').trim();
      if (responseId) {
        activeResponseId = responseId;
        getResponseRecord(responseId);
      }
      emitState('thinking');
      return;
    }
    if (type === 'response.output_audio_transcript.delta' || type === 'response.output_text.delta') {
      touchActivity();
      const record = getResponseRecord(event?.response_id);
      if (!record || record.committed) return;
      record.transcript += String(event?.delta || '');
      activeResponseId = record.id;
      emitState('speaking');
      try { onCaption?.({ role: 'assistant', text: record.transcript, final: false }); } catch {}
      return;
    }
    if (type === 'response.output_audio_transcript.done' || type === 'response.output_text.done') {
      touchActivity();
      const record = getResponseRecord(event?.response_id);
      if (!record || record.committed) return;
      const transcript = String(event?.transcript || event?.text || '').trim();
      if (transcript) record.transcript = transcript;
      try { onCaption?.({ role: 'assistant', text: record.transcript, final: true }); } catch {}
      if (record.terminal) enqueue(() => finalizeAssistant(record.id));
      return;
    }
    if (type === 'response.done') {
      const response = event?.response || {};
      const responseId = String(response?.id || event?.response_id || activeResponseId || '').trim();
      const record = getResponseRecord(responseId);
      if (record) {
        record.terminal = true;
        if (response?.usage) record.usage = normalizeUsage(response.usage);
        reportResponseUsage(record);
      }
      enqueue(async () => {
        const status = String(response?.status || '').trim().toLowerCase();
        const options = { response, interrupted: status === 'cancelled' || status === 'incomplete' };
        if (isNatural() && pendingNaturalInputs.size) deferredNaturalResponses.set(responseId, options);
        else await finalizeAssistant(responseId, options);
        if (state.status !== 'ending' && state.status !== 'idle') emitState('listening');
      });
      return;
    }
    if (type === 'response.cancelled') {
      const responseId = String(event?.response?.id || event?.response_id || activeResponseId || '').trim();
      const record = getResponseRecord(responseId);
      if (record) {
        record.terminal = true;
        if (event?.response?.usage) record.usage = normalizeUsage(event.response.usage);
        reportResponseUsage(record);
      }
      enqueue(async () => {
        await finalizeAssistant(responseId, { response: event?.response, interrupted: true });
        if (state.status !== 'ending' && state.status !== 'idle') emitState('listening');
      });
      return;
    }
    if (type === 'error') {
      const error = new Error(String(event?.error?.message || event?.message || 'Realtime 服务发生错误'));
      error.code = String(event?.error?.code || 'realtime_server_error');
      try { onError?.(error); } catch {}
      return;
    }
    if (TERMINAL_RESPONSE_STATUSES.has(type)) emitState('listening');
  };

  const handleConnectionState = connectionState => {
    const normalized = String(connectionState || '').trim().toLowerCase();
    if ((normalized === 'failed' || normalized === 'disconnected') && state.status !== 'ending' && state.status !== 'idle') {
      emitState('reconnecting');
      const error = new Error('实时语音连接已中断，请结束后重新拨号');
      error.code = 'connection_lost';
      try { onError?.(error); } catch {}
    }
  };

  const checkTimeouts = (timestamp = now()) => {
    if (!state.startedAt || state.status === 'idle' || state.status === 'ending') return false;
    const elapsedMs = Math.max(0, timestamp - state.startedAt);
    state = { ...state, elapsedMs };
    const idleTimeoutMs = Math.max(1, Number(connection?.settings?.idleTimeoutMinutes || 10)) * 60 * 1000;
    const idleMs = Math.max(0, timestamp - lastActivityAt);
    if (!durationWarned && elapsedMs >= MAX_CALL_WARNING_MS) {
      durationWarned = true;
      try { onWarning?.('通话将在 5 分钟内达到服务上限并自动结束'); } catch {}
    }
    if (elapsedMs >= MAX_CALL_DURATION_MS) {
      void end('duration_limit');
      return true;
    }
    if (!idleWarned && idleMs >= Math.max(0, idleTimeoutMs - 60_000)) {
      idleWarned = true;
      try { onWarning?.('长时间没有检测到语音，通话将在 1 分钟后自动结束'); } catch {}
    }
    if (idleMs >= idleTimeoutMs) {
      void end('idle_timeout');
      return true;
    }
    try { onStateChange?.({ ...state }); } catch {}
    return false;
  };

  const start = async () => {
    if (state.status !== 'idle') return false;
    target = getCallTarget?.() || null;
    if (!target?.supported || !target?.sessionId) {
      const error = new Error(target?.reason || '当前会话暂不支持实时语音通话');
      error.code = 'unsupported_target';
      try { onError?.(error); } catch {}
      return false;
    }
    const generation = ++startGeneration;
    connectAbortController = typeof AbortController === 'function' ? new AbortController() : null;
    const assertStartCurrent = () => {
      if (generation === startGeneration && state.status !== 'ending' && state.status !== 'idle') return;
      const error = new Error('Realtime connection cancelled');
      error.name = 'AbortError';
      error.cancelled = true;
      throw error;
    };
    responseRecords = new Map();
    completedInputItems = new Set();
    committedMessageIds = new Set();
    activeResponseId = '';
    connection = null;
    emitState('requesting_permission', { target: { ...target }, error: '', provider: '' });
    const startedAt = now();
    try {
      const resolved = await resolveConnection?.({ target });
      assertStartCurrent();
      if (!resolved?.config || !resolved?.settings) throw new Error('实时语音配置不可用');
      connection = {
        ...resolved,
        settings: normalizeRealtimeVoiceSettings(resolved.settings),
      };
      const snapshot = await buildSemanticSnapshot?.({
        target,
        inputText: '',
        excludeMessageIds: [],
      });
      assertStartCurrent();
      const snapshotInstructions = String(snapshot?.instructions || '').trim();
      if (!snapshotInstructions) throw new Error('无法构建当前角色的语音上下文');
      const instructions = applyRealtimeReplyLanguage(snapshotInstructions, connection.settings);
      sessionClient = createSessionClient?.({
        provider: connection.config.provider || 'openai',
        onEvent: event => { if (generation === startGeneration) handleServerEvent(event); },
        onConnectionState: value => { if (generation === startGeneration) handleConnectionState(value); },
        onAudioLevel: value => { if (generation === startGeneration) onAudioLevel?.(value); },
      });
      if (!sessionClient) throw new Error('实时语音客户端初始化失败');
      emitState('connecting', { startedAt, elapsedMs: 0, provider: connection.config.provider || 'openai' });
      await sessionClient.connect({
        config: connection.config,
        sessionConfig: isNatural() ? { ...connection.settings, instructions } : buildOpenAiRealtimeSessionConfig({
          ...connection.settings,
          instructions,
        }),
        signal: connectAbortController?.signal || null,
      });
      assertStartCurrent();
      if (!isCapturedTargetCurrent()) throw new Error('连接期间会话已切换');
      lastActivityAt = now();
      durationWarned = false;
      idleWarned = false;
      if (typeof setIntervalFn === 'function') {
        timeoutTimer = setIntervalFn(() => checkTimeouts(), 15_000);
      }
      emitState('listening', { startedAt, elapsedMs: 0 });
      if (generation === startGeneration) connectAbortController = null;
      return true;
    } catch (error) {
      try { await sessionClient?.close?.(); } catch {}
      sessionClient = null;
      if (generation === startGeneration) connectAbortController = null;
      if (error?.name === 'AbortError' || error?.cancelled === true || generation !== startGeneration) {
        if (state.status !== 'idle') emitState('idle', { startedAt: 0, elapsedMs: 0 });
        return false;
      }
      emitState('error', { error: String(error?.message || error) });
      try { onError?.(error); } catch {}
      emitState('idle', { startedAt: 0, elapsedMs: 0 });
      return false;
    }
  };

  const interrupt = async () => {
    if (!sessionClient || state.status === 'ending' || state.status === 'idle') return false;
    try { sessionClient.sendEvent({ type: 'response.cancel' }); } catch {}
    const interruptedResponseId = activeResponseId;
    if (interruptedResponseId) await enqueue(() => finalizeAssistant(interruptedResponseId, { interrupted: true }));
    emitState('listening');
    return true;
  };

  const end = async (reason = 'user') => {
    if (state.status === 'idle') return true;
    if (endingPromise) return endingPromise;
    startGeneration += 1;
    try { connectAbortController?.abort?.(); } catch {}
    connectAbortController = null;
    endingPromise = (async () => {
      emitState('ending', { endReason: String(reason || 'user') });
      if (timeoutTimer != null && typeof clearIntervalFn === 'function') clearIntervalFn(timeoutTimer);
      timeoutTimer = null;
      if (activeResponseId) {
        try { sessionClient?.sendEvent?.({ type: 'response.cancel' }); } catch {}
        await enqueue(() => finalizeAssistant(activeResponseId, { interrupted: true }));
      }
      await eventQueue;
      try { await sessionClient?.close?.(); } catch {}
      sessionClient = null;
      target = null;
      connection = null;
      pendingNaturalInputs.clear(); deferredNaturalResponses.clear(); suppressAssistantCommit = false;
      responseRecords.clear();
      activeResponseId = '';
      completedInputItems.clear();
      committedMessageIds.clear();
      emitState('idle', {
        target: null,
        sessionId: '',
        startedAt: 0,
        elapsedMs: 0,
        muted: false,
        outputMuted: false,
      });
      endingPromise = null;
      return true;
    })();
    return endingPromise;
  };

  const setMicrophoneMuted = muted => {
    const applied = sessionClient?.setMicrophoneMuted?.(muted === true) === true;
    if (applied) emitState(state.status, { muted: muted === true });
    return applied;
  };

  const setOutputMuted = muted => {
    const applied = sessionClient?.setOutputMuted?.(muted === true) === true;
    if (applied) emitState(state.status, { outputMuted: muted === true });
    return applied;
  };

  return {
    start,
    end,
    interrupt,
    setMicrophoneMuted,
    setOutputMuted,
    checkTimeouts,
    getState: () => ({ ...state, target: state.target ? { ...state.target } : null }),
    whenIdle: () => eventQueue,
  };
};
