import { VoiceClient } from '../../api/voice-client.js';
import {
  normalizeVoiceCapability,
  normalizeVoiceConnectionMode,
} from '../voice-config-utils.js';
import {
  resolveSpeechChunkMaxChars,
  splitSpeechText,
} from './speech-chunk-utils.js';
import { microphonePermissionRecovery } from '../microphone-permission-recovery.js';

const DEFAULT_MAX_RECORDING_MS = 60000;
export { resolveSpeechChunkMaxChars, splitSpeechText } from './speech-chunk-utils.js';

const makeAbortError = () => {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
  }
};

const isAbortError = error => error?.name === 'AbortError' || /aborted|cancel/i.test(String(error?.message || ''));

export const createVoiceRuntimeConfigResolver = ({
  getMode = () => 'shared',
  sharedManager,
  ttsManager,
  sttManager,
} = {}) => async (capability = 'tts') => {
  const target = normalizeVoiceCapability(capability);
  const mode = normalizeVoiceConnectionMode(getMode?.());
  if (mode === 'shared') {
    const config = await sharedManager?.load?.();
    if (!config) return null;
    return {
      ...config,
      model: target === 'stt' ? config.sttModel : config.ttsModel,
    };
  }
  const manager = target === 'stt' ? sttManager : ttsManager;
  const config = await manager?.load?.();
  return config ? { ...config } : null;
};

export const selectRecorderMimeType = MediaRecorderLike => {
  if (!MediaRecorderLike) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorderLike.isTypeSupported !== 'function') return '';
  return candidates.find(type => MediaRecorderLike.isTypeSupported(type)) || '';
};

export const insertTranscriptAtSelection = (input, transcript) => {
  if (!input) return '';
  const text = String(transcript || '').trim();
  if (!text) return String(input.value || '');
  const value = String(input.value || '');
  const start = Number.isFinite(Number(input.selectionStart)) ? Number(input.selectionStart) : value.length;
  const end = Number.isFinite(Number(input.selectionEnd)) ? Number(input.selectionEnd) : start;
  const before = value.slice(0, Math.max(0, start));
  const after = value.slice(Math.max(start, end));
  const next = `${before}${text}${after}`;
  const caret = before.length + text.length;
  input.value = next;
  input.setSelectionRange?.(caret, caret);
  input.dispatchEvent?.(new Event('input', { bubbles: true }));
  input.focus?.();
  return next;
};

const decodeBasicEntities = value => String(value || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'");

export const normalizeSpeakableText = value => decodeBasicEntities(value)
  .replace(/```[\s\S]*?```/g, '')
  .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/<\s*\/?\s*(?:p|div|br|li|h[1-6]|section|article|blockquote)[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(^|\n)[ \t]{0,3}(?:#{1,6}[ \t]*|>[ \t]*|[-*+][ \t]+)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/[*_~`]/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim();

export const resolveSpeakableMessageText = (message, {
  wrapper = null,
  resolvePlainText,
  getBubbleCopyText,
} = {}) => {
  if (message?.meta?.renderRich && wrapper) {
    try {
      const visibleText = String(getBubbleCopyText?.(wrapper) || '');
      if (visibleText.trim()) return visibleText;
    } catch {}
  }
  const sourceText = resolvePlainText?.(message, { depth: 0, preferRawSource: true });
  return String(sourceText || message?.content || '');
};

const combineBytes = (left, right) => {
  const a = left instanceof Uint8Array ? left : new Uint8Array(left || []);
  const b = right instanceof Uint8Array ? right : new Uint8Array(right || []);
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const next = new Uint8Array(a.length + b.length);
  next.set(a, 0);
  next.set(b, a.length);
  return next;
};

export class PcmStreamPlayer {
  constructor({ AudioContextCtor, sampleRate = 24000, initialBufferMs = 160 } = {}) {
    this.AudioContextCtor = AudioContextCtor || globalThis.AudioContext || globalThis.webkitAudioContext;
    this.sampleRate = Math.max(8000, Number(sampleRate) || 24000);
    this.initialBufferBytes = Math.max(2, Math.round(this.sampleRate * 2 * initialBufferMs / 1000));
    this.context = null;
    this.pending = new Uint8Array(0);
    this.activeSources = new Set();
    this.nextStartAt = 0;
    this.started = false;
    this.streamFinished = false;
    this.stopped = false;
    this.resolveFinished = null;
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
  }

  async start() {
    if (!this.AudioContextCtor) throw new Error('当前装置不支持流式音频播放');
    this.context = new this.AudioContextCtor();
    await this.context.resume?.();
    this.nextStartAt = Number(this.context.currentTime || 0) + 0.04;
  }

  push(bytes) {
    if (this.stopped) return;
    this.pending = combineBytes(this.pending, bytes);
    if (!this.started && this.pending.length < this.initialBufferBytes) return;
    this.started = true;
    this.flush(false);
  }

  flush(final) {
    if (!this.context || this.stopped) return;
    const frameBytes = 2;
    const preferredBytes = Math.max(frameBytes, Math.round(this.sampleRate * frameBytes * 0.1));
    while (this.pending.length >= preferredBytes || (final && this.pending.length >= frameBytes)) {
      const take = final
        ? Math.min(this.pending.length - (this.pending.length % frameBytes), preferredBytes)
        : preferredBytes;
      if (take < frameBytes) break;
      const chunk = this.pending.slice(0, take);
      this.pending = this.pending.slice(take);
      this.schedule(chunk);
    }
  }

  schedule(bytes) {
    const sampleCount = Math.floor(bytes.length / 2);
    if (!sampleCount || !this.context) return;
    const audioBuffer = this.context.createBuffer(1, sampleCount, this.sampleRate);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      this.maybeResolveFinished();
    };
    const startAt = Math.max(this.nextStartAt, Number(this.context.currentTime || 0) + 0.015);
    source.start(startAt);
    this.nextStartAt = startAt + sampleCount / this.sampleRate;
  }

  async finish() {
    if (this.stopped) return;
    this.streamFinished = true;
    if (!this.started && this.pending.length) this.started = true;
    this.flush(true);
    this.maybeResolveFinished();
    await this.finished;
  }

  maybeResolveFinished() {
    if (!this.streamFinished || this.activeSources.size) return;
    this.resolveFinished?.();
    this.resolveFinished = null;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = new Uint8Array(0);
    this.activeSources.forEach((source) => {
      try { source.stop(); } catch {}
    });
    this.activeSources.clear();
    this.resolveFinished?.();
    this.resolveFinished = null;
    try { await this.context?.close?.(); } catch {}
  }
}

const validateRuntimeConfig = (config, capability) => {
  if (!config?.provider || !config?.baseUrl || !config?.model) return false;
  if (capability === 'tts' && !String(config.ttsVoice || '').trim()) return false;
  const provider = String(config.provider || '').trim().toLowerCase();
  if (['openai', 'elevenlabs', 'groq'].includes(provider) && !String(config.apiKey || '').trim()) return false;
  return true;
};

const formatVoiceError = error => {
  const message = String(error?.message || error || '').trim();
  if (/notallowed|permission denied|permission dismissed/i.test(message)) return '麦克风权限未开启。再次点击语音可重新请求，或前往系统设置开启。';
  if (/notfound|devicesnotfound/i.test(message)) return '找不到可用的麦克风。';
  if (/notreadable|trackstart/i.test(message)) return '麦克风正被其他应用占用。';
  if (/HTTP 409|上一段.*(?:处理|生成)|already.*busy/i.test(message)) return '上一段本地语音仍在生成，请稍后再试。';
  return message || '语音操作失败';
};

export const createChatVoiceRuntime = ({
  resolveConfig,
  resolveSpeechConfig = null,
  buildSpeechSegments = null,
  voiceClient = new VoiceClient(),
  composerInput = null,
  recorderButton = null,
  getSpeakableText = () => '',
  openVoiceSettings = () => {},
  toast = {},
  mediaDevices = globalThis.navigator?.mediaDevices,
  microphoneAccess = microphonePermissionRecovery,
  MediaRecorderCtor = globalThis.MediaRecorder,
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  maxRecordingMs = DEFAULT_MAX_RECORDING_MS,
  beforeRecording = null,
  onRecorderStateChange = null,
  playerFactory = options => new PcmStreamPlayer(options),
} = {}) => {
  let mediaRecorder = null;
  let mediaStream = null;
  let recordingChunks = [];
  let recordingTimer = null;
  let discardRecording = false;
  let recordingStopPromise = null;
  let resolveRecordingStop = null;
  let transcriptionController = null;
  let speechController = null;
  let speechPlayer = null;
  let speechButton = null;
  let speechWrapper = null;
  let speechStatusElement = null;
  let speechMessageId = '';
  let speechRunVersion = 0;
  const cleanups = [];
  let recorderState = 'idle', recordingVersion = 0;

  const notify = (level, message) => {
    const handler = toast?.[level] || toast?.info;
    handler?.(String(message || ''));
  };

  const showConfigRequired = (capability) => {
    notify('warning', `请先在 API 设置的语音模型分页完成 ${capability.toUpperCase()} 配置。`);
    openVoiceSettings?.(capability);
  };

  const setRecorderState = state => {
    recorderState = state;
    onRecorderStateChange?.(state);
    if (!recorderButton) return;
    recorderButton.classList?.toggle?.('is-recording', state === 'recording');
    recorderButton.classList?.toggle?.('is-transcribing', state === 'transcribing');
    recorderButton.disabled = state === 'starting';
    const label = state === 'recording'
      ? '停止录音并转成文字'
      : state === 'transcribing'
        ? '正在识别，点击取消'
        : '语音输入';
    recorderButton.setAttribute?.('aria-label', label);
    recorderButton.title = label;
  };

  const clearRecordingTimer = () => {
    if (recordingTimer == null) return;
    clearTimeout(recordingTimer);
    recordingTimer = null;
  };

  const stopTracks = () => {
    mediaStream?.getTracks?.().forEach((track) => {
      try { track.stop(); } catch {}
    });
    mediaStream = null;
  };

  const handleRecordingStopped = async (config, mimeType) => {
    clearRecordingTimer();
    stopTracks();
    const chunks = recordingChunks;
    recordingChunks = [];
    mediaRecorder = null;
    if (discardRecording) {
      discardRecording = false;
      setRecorderState('idle');
      resolveRecordingStop?.(false);
      resolveRecordingStop = null;
      recordingStopPromise = null;
      return;
    }
    const audio = new Blob(chunks, { type: mimeType || chunks[0]?.type || 'audio/webm' });
    if (!audio.size) {
      setRecorderState('idle');
      notify('warning', '没有录到声音，请重试。');
      resolveRecordingStop?.(false);
      resolveRecordingStop = null;
      recordingStopPromise = null;
      return;
    }
    setRecorderState('transcribing');
    const controller = new AbortController();
    transcriptionController = controller;
    try {
      const transcript = await voiceClient.transcribe(config, {
        audio,
        mimeType: audio.type,
        language: config.sttLanguage,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      insertTranscriptAtSelection(composerInput, transcript);
      notify('success', '语音已转成文字');
      resolveRecordingStop?.(true);
    } catch (error) {
      if (!isAbortError(error)) notify('error', formatVoiceError(error));
      resolveRecordingStop?.(false);
    } finally {
      if (transcriptionController === controller) transcriptionController = null;
      resolveRecordingStop?.(false);
      resolveRecordingStop = null;
      recordingStopPromise = null;
      setRecorderState('idle');
    }
  };

  const startRecording = async () => {
    const version = ++recordingVersion;
    setRecorderState('starting');
    try {
      await beforeRecording?.();
      if (version !== recordingVersion) return false;
      const config = await resolveConfig?.('stt');
      if (version !== recordingVersion) return false;
      if (!validateRuntimeConfig(config, 'stt')) {
        setRecorderState('idle');
        showConfigRequired('stt');
        return false;
      }
      if (!mediaDevices?.getUserMedia || !MediaRecorderCtor) {
        setRecorderState('idle');
        notify('error', '当前装置不支持麦克风录音。');
        return false;
      }
      const acquiredStream = await microphoneAccess.acquire({
        mediaDevices,
        constraints: {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        },
      });
      if (version !== recordingVersion) { acquiredStream?.getTracks?.().forEach(track => track.stop()); return false; }
      mediaStream = acquiredStream;
      const mimeType = selectRecorderMimeType(MediaRecorderCtor);
      mediaRecorder = mimeType
        ? new MediaRecorderCtor(mediaStream, { mimeType })
        : new MediaRecorderCtor(mediaStream);
      recordingChunks = [];
      discardRecording = false;
      mediaRecorder.ondataavailable = event => {
        if (event?.data?.size) recordingChunks.push(event.data);
      };
      mediaRecorder.onerror = event => {
        notify('error', formatVoiceError(event?.error || '录音失败'));
      };
      const activeRecorder = mediaRecorder;
      mediaRecorder.onstop = () => { void handleRecordingStopped(config, activeRecorder.mimeType || mimeType); };
      mediaRecorder.start(250);
      setRecorderState('recording');
      recordingTimer = setTimeout(() => {
        if (mediaRecorder?.state === 'recording') void stopRecording({ transcribe: true });
      }, Math.max(1000, Number(maxRecordingMs) || DEFAULT_MAX_RECORDING_MS));
      notify('info', '正在录音，再点一次麦克风即可转成文字。');
      return true;
    } catch (error) {
      if (version !== recordingVersion) return false;
      clearRecordingTimer();
      stopTracks();
      mediaRecorder = null;
      setRecorderState('idle');
      if (!isAbortError(error)) notify('error', formatVoiceError(error));
      return false;
    }
  };

  const stopRecording = ({ transcribe = true } = {}) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return Promise.resolve(false);
    discardRecording = !transcribe;
    clearRecordingTimer();
    recordingStopPromise = new Promise(resolve => { resolveRecordingStop = resolve; });
    mediaRecorder.stop();
    return recordingStopPromise;
  };

  const toggleRecording = async () => {
    if (recorderState === 'starting') { recordingVersion++; setRecorderState('idle'); return false; }
    if (transcriptionController) {
      transcriptionController.abort();
      transcriptionController = null;
      setRecorderState('idle');
      return false;
    }
    if (recordingStopPromise) return recordingStopPromise;
    if (mediaRecorder?.state === 'recording') return stopRecording({ transcribe: true });
    return startRecording();
  };

  const resetSpeechUi = () => {
    speechButton?.classList?.remove?.('is-active', 'is-generating', 'is-playing');
    speechButton?.setAttribute?.('aria-label', '朗读');
    if (speechButton) speechButton.title = '朗读';
    speechWrapper?.classList?.remove?.('is-voice-active');
    if (speechWrapper?.dataset) delete speechWrapper.dataset.voiceState;
    speechStatusElement?.remove?.();
    speechStatusElement = null;
    speechButton = null;
    speechWrapper = null;
    speechMessageId = '';
  };

  const setSpeechState = (state, {
    segmentIndex = 1,
    segmentCount = 1,
    continuing = false,
  } = {}) => {
    const generating = state === 'generating';
    const playing = state === 'playing';
    if (!generating && !playing) {
      resetSpeechUi();
      return;
    }
    speechWrapper?.classList?.add?.('is-voice-active');
    if (speechWrapper?.dataset) speechWrapper.dataset.voiceState = state;
    speechButton?.classList?.add?.('is-active');
    speechButton?.classList?.toggle?.('is-generating', generating);
    speechButton?.classList?.toggle?.('is-playing', playing);
    const buttonLabel = generating ? '停止生成语音' : '停止朗读';
    speechButton?.setAttribute?.('aria-label', buttonLabel);
    if (speechButton) speechButton.title = buttonLabel;

    if (!speechStatusElement && documentLike?.createElement) {
      const actionRow = speechButton?.closest?.('.rp-message-actions')
        || speechWrapper?.querySelector?.('.rp-message-actions');
      if (actionRow) {
        speechStatusElement = documentLike.createElement('span');
        speechStatusElement.className = 'rp-message-voice-status';
        speechStatusElement.setAttribute?.('role', 'status');
        speechStatusElement.setAttribute?.('aria-live', 'polite');
        speechStatusElement.setAttribute?.('aria-atomic', 'true');
        actionRow.prepend?.(speechStatusElement);
      }
    }
    if (speechStatusElement) {
      speechStatusElement.dataset.voiceState = state;
      const progress = segmentCount > 1 ? `（${segmentIndex}/${segmentCount}）` : '';
      speechStatusElement.textContent = generating
        ? `${continuing ? '生成下一段' : '生成语音中'}${progress}…`
        : `播放中${progress}…`;
    }
  };

  const stopSpeechCore = async () => {
    const controller = speechController;
    const player = speechPlayer;
    speechController = null;
    speechPlayer = null;
    resetSpeechUi();
    controller?.abort();
    await player?.stop?.();
  };

  const stopSpeech = async () => {
    speechRunVersion += 1;
    await stopSpeechCore();
  };

  const speak = async (message, { wrapper = null, voiceRefOverride = null } = {}) => {
    const messageId = String(message?.id || '').trim();
    const runVersion = ++speechRunVersion;
    if (speechController && messageId && messageId === speechMessageId) {
      await stopSpeechCore();
      return false;
    }
    await stopSpeechCore();
    if (runVersion !== speechRunVersion) return false;
    const config = typeof resolveSpeechConfig === 'function'
      ? await resolveSpeechConfig({ message, voiceRefOverride })
      : await resolveConfig?.('tts');
    if (runVersion !== speechRunVersion) return false;
    if (!validateRuntimeConfig(config, 'tts')) {
      showConfigRequired('tts');
      return false;
    }
    const text = normalizeSpeakableText(getSpeakableText?.(message, wrapper));
    if (!text) {
      notify('warning', '这条消息没有可朗读的文字。');
      return false;
    }
    const button = wrapper?.querySelector?.('[data-rp-message-action="speak"]') || null;
    let plannedSegments = null;
    try {
      plannedSegments = typeof buildSpeechSegments === 'function'
        ? await buildSpeechSegments({ message, text, wrapper, voiceRefOverride, config })
        : null;
    } catch (error) {
      notify('error', formatVoiceError(error));
      return false;
    }
    const rawSegments = Array.isArray(plannedSegments) && plannedSegments.length
      ? plannedSegments
          .map(item => ({
            text: String(item?.text || ''),
            config: item?.config || config,
            kind: String(item?.kind || ''),
          }))
      : splitSpeechText(text, {
          maxChars: resolveSpeechChunkMaxChars(config),
        }).map(segmentText => ({ text: segmentText, config, kind: '' }));
    const segments = rawSegments.filter(item => (
      item.text.trim() && validateRuntimeConfig(item.config, 'tts')
    ));
    if (!segments.length) {
      showConfigRequired('tts');
      return false;
    }
    const controller = new AbortController();
    const player = playerFactory({ AudioContextCtor, sampleRate: 24000 });
    speechButton = button;
    speechWrapper = wrapper;
    speechMessageId = messageId;
    speechController = controller;
    speechPlayer = player;
    setSpeechState('generating', {
      segmentIndex: 1,
      segmentCount: segments.length,
    });
    try {
      await player.start();
      if (controller.signal.aborted || runVersion !== speechRunVersion) throw makeAbortError();
      for (let index = 0; index < segments.length; index += 1) {
        if (index > 0 && speechController === controller) {
          setSpeechState('generating', {
            segmentIndex: index + 1,
            segmentCount: segments.length,
            continuing: true,
          });
        }
        let receivedSegmentAudio = false;
        const segment = segments[index];
        for await (const bytes of voiceClient.streamSpeech(segment.config, {
          text: segment.text,
          signal: controller.signal,
        })) {
          if (!receivedSegmentAudio && Number(bytes?.byteLength ?? bytes?.length ?? 0) > 0) {
            receivedSegmentAudio = true;
            if (speechController === controller) {
              setSpeechState('playing', {
                segmentIndex: index + 1,
                segmentCount: segments.length,
              });
            }
          }
          player.push(bytes);
        }
      }
      await player.finish();
      return true;
    } catch (error) {
      if (!isAbortError(error)) notify('error', formatVoiceError(error));
      return false;
    } finally {
      await player.stop?.();
      if (speechController === controller) {
        speechController = null;
        speechPlayer = null;
        resetSpeechUi();
      }
    }
  };

  const cancel = async () => {
    recordingVersion++;
    transcriptionController?.abort();
    transcriptionController = null;
    if (recordingStopPromise) {
      discardRecording = true;
      await recordingStopPromise;
    } else if (mediaRecorder?.state === 'recording') {
      await stopRecording({ transcribe: false });
    }
    setRecorderState('idle');
    await stopSpeech();
  };

  const onRecorderClick = event => {
    event?.preventDefault?.();
    void toggleRecording();
  };
  recorderButton?.addEventListener?.('click', onRecorderClick);
  if (recorderButton) cleanups.push(() => recorderButton.removeEventListener?.('click', onRecorderClick));

  const onVisibilityChange = () => {
    if (documentLike?.visibilityState !== 'hidden') return;
    void cancel();
  };
  documentLike?.addEventListener?.('visibilitychange', onVisibilityChange);
  cleanups.push(() => documentLike?.removeEventListener?.('visibilitychange', onVisibilityChange));

  const destroy = async () => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    await cancel();
    stopTracks();
  };
  windowLike?.addEventListener?.('beforeunload', destroy, { once: true });
  cleanups.push(() => windowLike?.removeEventListener?.('beforeunload', destroy));

  return {
    cancel,
    destroy,
    speak,
    stopRecording,
    stopSpeech,
    toggleRecording,
    getRecorderState: () => recorderState,
  };
};
