import { t } from '../../i18n/index.js';
import { safeInvoke } from '../../utils/tauri.js';
import { createTauriPluginChannel } from '../app-native-back-button-utils.js';
import { getRealtimeProvider, isGeminiVertex, usesGeminiServiceAccount } from './realtime-provider-catalog.js';
import { bytesToBase64, base64ToBytes } from './realtime-pcm-codec.js';
import { RealtimePcmAudio } from './realtime-pcm-audio.js';
import { createJsonRealtimeProtocol } from './realtime-json-protocol.js';
import { createGeminiLiveProtocol } from './realtime-gemini-protocol.js';
import { createDoubaoRealtimeProtocol } from './realtime-doubao-protocol.js';
import { createNovaSonicProtocol } from './realtime-nova-protocol.js';
const abortError = () => new DOMException('Realtime connection cancelled', 'AbortError');
const createVertexAuth = async config => {
  const { VertexAIProvider } = await import('../../api/providers/vertexai.js');
  return new VertexAIProvider({ vertexaiAuthMode: 'service_account', vertexaiServiceAccount: config.credentials.vertexaiServiceAccount, vertexaiProjectId: config.vertexaiProjectId, vertexaiRegion: config.region, timeout: 20000 });
};
export class NativeRealtimeSessionClient {
  constructor({ onEvent, onConnectionState, onAudioLevel, invoke = safeInvoke, createChannel = callback => createTauriPluginChannel({ callback }), createAudio = options => new RealtimePcmAudio(options), createVertexAuth: vertexAuthFactory = createVertexAuth } = {}) {
    Object.assign(this, { onEvent, onConnectionState, onAudioLevel, invoke, createChannel, createAudio, createVertexAuth: vertexAuthFactory }); this.closed = true; this.generation = 0; this.pendingFinals = new Map(); this.transcripts = new Map();
  }
  async connect({ config, sessionConfig, signal } = {}) {
    await this.close(); this.closed = false; this.config = { ...config, maidTools: sessionConfig.tools }; this.instructions = sessionConfig.instructions; this.history = []; this.resumeHandle = ''; this.activeResponse = '';
    this.authController = new AbortController(); this.vertexAuth = null;
    this.abort = () => { this.rejectReady?.(abortError()); void this.close(); }; this.signal = signal;
    if (signal?.aborted) { await this.close(); throw abortError(); }
    signal?.addEventListener('abort', this.abort, { once: true });
    const preset = getRealtimeProvider(config.provider);
    if (!preset?.inputRate) throw new Error(t('不支持的实时语音服务商'));
    if (this.instructions.length > (config.provider === 'doubao_realtime' ? 24000 : 180000)) throw new Error(t('当前角色上下文超出此实时服务的容量，请缩短上下文后重试'));
    this.audio = this.createAudio({ onFrame: bytes => { if (this.streaming && !this.closed) { try { this.protocol.audio(bytesToBase64(bytes)); } catch (error) { this.fail(error); } } }, onError: error => this.fail(error), onAudioLevel: value => { if (!this.closed) this.onAudioLevel?.(value); } });
    try {
      await this.audio.open({ ...preset, frameMs: config.provider === 'nova_sonic' ? 32 : 20, signal });
      if (this.closed || signal?.aborted) throw abortError();
      await this.openTransport();
      if (this.closed || signal?.aborted) throw abortError();
      signal?.removeEventListener('abort', this.abort);
    } catch (error) { await this.close(); throw error; }
  }
  emit(event, playbackFinished = false) {
    if (this.closed) return;
    if (!playbackFinished && event.type === 'response.done') {
      const delay = Math.max(0, (this.audio?.nextTime || 0) - (this.audio?.context?.currentTime || 0)) * 1000;
      const id = event.response?.id || event.response_id || this.activeResponse;
      if (delay > 20 && id) {
        clearTimeout(this.pendingFinals.get(id)?.timer);
        const timer = setTimeout(() => { this.pendingFinals.delete(id); this.emit(event, true); }, Math.min(delay + 20, 31000));
        this.pendingFinals.set(id, { event, timer }); return;
      }
    }
    if (event.type === 'error') { this.fail(new Error(event.error?.message || t('实时服务返回错误'))); return; }
    if (event.type === 'session.ended') { this.fail(new Error(t('实时语音会话已结束'))); return; }
    if (event.type === 'response.created') { this.activeResponse = event.response?.id || ''; this.transcripts.set(this.activeResponse, ''); }
    const responseId = event.response_id || event.response?.id || this.activeResponse;
    if (event.type === 'response.output_audio_transcript.delta') this.transcripts.set(responseId, (this.transcripts.get(responseId) || '') + (event.delta || ''));
    if (event.type === 'response.output_audio_transcript.done' && event.transcript) this.transcripts.set(responseId, event.transcript);
    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) this.history.push({ role: 'user', text: event.transcript });
    if (['response.done', 'response.cancelled'].includes(event.type)) {
      const transcript = this.transcripts.get(responseId);
      if (transcript) this.history.push({ role: 'assistant', text: transcript });
      this.transcripts.delete(responseId); if (responseId === this.activeResponse) this.activeResponse = '';
    }
    this.onEvent?.(event);
    if (this.renewPending && !this.activeResponse) void this.renew();
  }
  send(frame) {
    if ((this.closed && !this.closing) || !this.id) return;
    if (this.outgoing.length >= 96) throw new Error(t('实时语音发送积压过多，连接已停止'));
    this.outgoing.push(frame);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush().catch(error => this.fail(error)); }, 10);
  }
  async flush() {
    if (this.flushing) return this.flushing;
    const id = this.id;
    this.flushing = (async () => {
      while (this.outgoing.length && id === this.id) {
        const messages = this.outgoing.splice(0, 24);
        await this.invoke('realtime_transport_send', { id, messages });
      }
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }
  async openTransport() {
    const generation = ++this.generation; this.id = `realtime_${crypto.randomUUID()}`; this.outgoing = []; this.streaming = false;
    let resolveReady, rejectReady;
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    readyPromise.catch(() => {});
    this.rejectReady = rejectReady;
    const transportId = this.id;
    const readyTimer = setTimeout(() => rejectReady(new Error(t('实时语音初始化超时'))), 30000);
    const factories = { gemini_live: createGeminiLiveProtocol, doubao_realtime: createDoubaoRealtimeProtocol, nova_sonic: createNovaSonicProtocol };
    this.protocol = (factories[this.config.provider] || createJsonRealtimeProtocol)({
      profile: this.config, instructions: this.instructions, history: this.history.slice(-40), resumeHandle: this.resumeHandle,
      onResumeHandle: handle => { this.resumeHandle = handle; }, renew: () => this.requestRenew(),
      send: message => this.send({ kind: 'text', data: JSON.stringify(message) }), sendBinary: data => this.send({ kind: 'binary', data }),
      emit: event => this.emit(event), ready: () => { if (generation === this.generation && !this.closed) { this.streaming = true; if (this.config.provider !== 'nova_sonic') resolveReady(); } },
      play: (data, rate) => this.audio.play(base64ToBytes(data), rate), clear: () => this.clearPlayback(),
    });
    let receiving = Promise.resolve();
    this.channel = this.createChannel(frame => {
      receiving = receiving.then(async () => {
        if (generation !== this.generation || this.closed) return;
        if (frame.kind === 'open') this.protocol.start();
        else if (frame.kind === 'ready') resolveReady();
        else if (frame.kind === 'error') {
          let message = frame.data || 'Realtime transport failed';
          if (this.config.provider === 'step_realtime') {
            if (message === 'Realtime handshake HTTP 401') message = t('Step 鉴权失败（HTTP 401），请确认 API Key 与所选的中国大陆／国际版站点一致');
            else if (message === 'Realtime handshake HTTP 402') message = t('Step 余额不足（HTTP 402），请到所选站点的控制台检查 API 余额');
          }
          throw new Error(message);
        }
        else if (frame.kind === 'closed') throw new Error(t('实时语音连接已关闭'));
        else await this.protocol.receive(frame.kind === 'binary' ? base64ToBytes(frame.data) : JSON.parse(frame.data));
      }).catch(error => { rejectReady(error); this.fail(error); });
    });
    try {
      if (!this.channel) throw new Error(t('当前环境不支持原生实时语音连接'));
      const config = this.config;
      let credentials = config.credentials;
      if (usesGeminiServiceAccount(config)) {
        const auth = this.vertexAuth || await this.createVertexAuth(config);
        if (this.closed || generation !== this.generation) throw abortError();
        this.vertexAuth = auth;
        // Reuse text Vertex OAuth signing/caching; only the temporary token crosses the WS bridge.
        try { credentials = { accessToken: await Promise.race([auth.getAccessToken({ signal: this.authController.signal }), readyPromise]) }; }
        catch (error) { if (error.name === 'AbortError') throw error; throw new Error(t('Vertex AI 鉴权失败，请检查 Service Account、项目权限与网络')); }
      } else if (isGeminiVertex(config)) credentials = { apiKey: config.credentials.vertexaiApiKey };
      else if (config.provider === 'gemini_live') credentials = { apiKey: config.credentials.apiKey };
      if (this.closed || generation !== this.generation) throw abortError();
      await this.invoke('realtime_transport_open', { id: transportId, connection: { provider: config.provider, model: config.model, region: config.region || '', workspaceId: config.workspaceId || '', geminiBackend: config.geminiBackend || '', vertexaiAuthMode: config.vertexaiAuthMode || '', credentials }, onEvent: this.channel });
      if (this.closed || generation !== this.generation) {
        await this.invoke('realtime_transport_close', { id: transportId }).catch(() => {}); throw abortError();
      }
      await readyPromise; this.rejectReady = null;
      if (this.config.provider === 'nova_sonic') this.renewTimer = setTimeout(() => this.requestRenew(), 7 * 60 * 1000);
    } catch (error) { rejectReady(error); await readyPromise.catch(() => {}); throw error; }
    finally { clearTimeout(readyTimer); }
  }
  requestRenew() {
    if (this.closed || this.renewing || this.renewPending) return;
    if (this.config.provider === 'gemini_live' && !this.resumeHandle) { this.fail(new Error(t('Gemini 未提供可恢复的会话，请重新拨号'))); return; }
    this.renewPending = true;
    if (!this.activeResponse) void this.renew();
    else this.renewDeadline = setTimeout(() => { this.clearPlayback(); this.emit({ type: 'response.cancelled', response_id: this.activeResponse }); }, 15000);
  }
  async renew() {
    if (this.closed || this.renewing) return;
    this.renewing = true; this.renewPending = false; clearTimeout(this.renewDeadline);
    this.onEvent?.({ type: 'warning', message: '实时语音正在续接，稍后可继续说话' });
    try { await this.closeTransport(); if (!this.closed) await this.openTransport(); }
    catch (error) { this.fail(error); }
    finally { this.renewing = false; }
  }
  clearPlayback() {
    this.audio?.clear();
    const pending = [...this.pendingFinals]; this.pendingFinals.clear();
    for (const [id, final] of pending) {
      clearTimeout(final.timer);
      this.emit({ type: 'response.cancelled', response: { ...final.event.response, id, status: 'cancelled' }, response_id: id }, true);
    }
  }
  sendEvent(event) { if (event.type === 'response.cancel') this.protocol?.cancel(); }
  sendToolResults(results) { if (!this.closed) this.protocol?.toolResults?.(results); }
  sendTaskUpdate(text) {
    if (this.closed) return;
    this.history.push({ role: 'user', text });
    this.protocol?.taskUpdate?.(text);
  }
  requestResponse() { if (!this.closed) this.protocol?.respond?.(); }
  setMicrophoneMuted(value) { return this.audio?.setMicrophoneMuted(value) === true; }
  setOutputMuted(value) { return this.audio?.setOutputMuted(value) === true; }
  fail(error) {
    if (this.closed) return;
    this.rejectReady?.(error); this.onEvent?.({ type: 'error', error: { message: error.message, code: 'realtime_transport_failed' } });
    this.onConnectionState?.('failed'); void this.close();
  }
  async closeTransport() {
    this.streaming = false; clearTimeout(this.renewTimer); clearTimeout(this.renewDeadline); clearTimeout(this.flushTimer); this.flushTimer = null;
    const id = this.id; if (!id) return;
    ++this.generation;
    try { this.protocol?.close(); clearTimeout(this.flushTimer); this.flushTimer = null; await this.flush(); } catch {}
    this.id = ''; this.outgoing = [];
    await this.invoke('realtime_transport_close', { id }).catch(() => {});
    if (this.channel?.id != null) globalThis.__TAURI_INTERNALS__?.unregisterCallback?.(this.channel.id);
    this.channel = null;
  }
  async close() {
    if (this.closingPromise) return this.closingPromise;
    this.closed = true; this.closing = true; this.streaming = false; this.renewPending = false;
    this.authController?.abort(); this.vertexAuth = null;
    for (const final of this.pendingFinals.values()) clearTimeout(final.timer); this.pendingFinals.clear(); this.transcripts.clear();
    this.rejectReady?.(abortError()); this.rejectReady = null;
    this.signal?.removeEventListener('abort', this.abort);
    const audio = this.audio; this.audio = null;
    this.closingPromise = (async () => {
      await Promise.allSettled([audio?.close(), this.closeTransport()]);
      this.config = null; this.closing = false;
    })();
    try { await this.closingPromise; } finally { this.closingPromise = null; }
  }
}
