import { t } from '../../i18n/index.js';
import { invokeNativeHttpRequest, createLinkedAbortController } from '../../api/abort.js';
import { OpenAiRealtimeSessionClient } from './openai-realtime-session-client.js';

const abortError = () => new DOMException('GPT-Live connection cancelled', 'AbortError');
const latch = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Startup events may arrive while setRemoteDescription is still pending.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

export class OpenAiLiveSessionClient {
  constructor({ onEvent, onConnectionState, createTransport = options => new OpenAiRealtimeSessionClient(options), closeTimeoutMs = 5000, ...options } = {}) {
    this.options = options;
    this.onEvent = onEvent; this.onConnectionState = onConnectionState;
    this.createTransport = createTransport; this.closeTimeoutMs = closeTimeoutMs;
    this.transport = null; this.closing = null; this.started = false; this.finalized = false;
  }

  async connect({ config = {}, sessionConfig = {}, signal, timeoutMs = 30000 } = {}) {
    await this.close();
    if (signal?.aborted) throw abortError();
    this.started = false; this.finalized = false; this.sessionId = ''; this.sequence = 0; this.closeRequested = false;
    this.startAck = latch(); this.closeAck = latch();
    const linked = createLinkedAbortController({ signal, timeoutMs });
    this.connectController = linked.controller;
    const cancelled = () => this.startAck.reject(abortError());
    linked.controller.signal.addEventListener('abort', cancelled, { once: true });
    this.transport = this.createTransport({
      ...this.options, gatherIce: true,
      exchangeOffer: args => this.exchangeOffer(args),
      onEvent: event => this.receive(event),
      onDataChannelClose: () => {
        if (!this.started) this.startAck.reject(new Error(t('GPT-Live 连接已中断')));
        if (!this.finalized) {
          this.closeAck.resolve(false);
          if (!this.closing && this.started) this.onConnectionState?.('failed');
        }
      },
      onConnectionState: value => {
        if (value === 'failed' || value === 'closed') {
          if (!this.started) this.startAck.reject(new Error(t('GPT-Live 连接已中断')));
          if (!this.finalized) this.closeAck.resolve(false);
        }
        this.onConnectionState?.(value);
      },
    });
    try {
      await this.transport.connect({ config, sessionConfig, signal: linked.controller.signal, timeoutMs });
      await this.startAck.promise;
      if (linked.controller.signal.aborted) throw abortError();
      return true;
    } catch (error) {
      const timedOut = error?.name === 'AbortError' && !signal?.aborted && !this.closeRequested;
      await this.close();
      if (timedOut) throw new Error(t('GPT-Live 连接超时，请检查网络与模型权限'));
      throw error;
    } finally {
      linked.controller.signal.removeEventListener('abort', cancelled);
      linked.cleanup(); this.connectController = null;
    }
  }

  async exchangeOffer({ invoke, config, sessionConfig, sdp, signal, timeoutMs }) {
    const response = await invokeNativeHttpRequest({ invoker: invoke, signal, args: {
      url: 'https://api.openai.com/v1/live/sessions', method: 'POST',
      headers: { Authorization: `Bearer ${String(config.apiKey || '').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionConfig, transport: { type: 'webrtc', sdp } }), timeoutMs,
    } });
    let data;
    try { data = JSON.parse(response?.body || '{}'); } catch {}
    if (!(response?.status >= 200 && response.status < 300)) {
      const detail = String(data?.error?.message || '').split(String(config.apiKey || '\0')).join('[redacted]').slice(0, 600);
      throw new Error(t('GPT-Live 连接失败（HTTP {status}）：{message}', { status: response?.status || 0, message: detail || t('请检查凭证、模型权限与网络') }));
    }
    if (data?.transport?.type !== 'webrtc' || !String(data.transport.sdp || '').trim() || !data?.session?.id) throw new Error(t('GPT-Live 返回了无效的连接响应'));
    this.sessionId = String(data.session.id);
    return data.transport.sdp;
  }

  receive(event) {
    if (event.type === 'session.started') {
      this.started = true; this.sessionId = String(event.session?.id || this.sessionId);
      this.startAck.resolve();
    } else if (event.type === 'session.closed') {
      this.finalized = true;
      this.closeAck.resolve(true);
      if (!this.started) this.startAck.reject(new Error(t('GPT-Live 会话在连接完成前已结束')));
    } else if (event.type === 'error' && !this.started) {
      this.startAck.reject(new Error(String(event.error?.message || t('GPT-Live 启动失败'))));
      return;
    }
    this.onEvent?.(event);
  }

  sendEvent(event) {
    if (!this.started || this.closing || this.finalized) throw new Error(t('GPT-Live 会话尚未就绪或正在结束'));
    return this.transport.sendEvent({ event_id: `live_cmd_${++this.sequence}`, ...event });
  }

  setMicrophoneMuted(muted) {
    const applied = this.transport?.setMicrophoneMuted(muted) === true;
    if (applied && this.started && !this.closing && !this.finalized) {
      try { this.sendEvent({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' }); }
      catch (error) { this.onEvent?.({ type: 'error', error: { message: error.message } }); }
    }
    return applied;
  }
  setOutputMuted(muted) { return this.transport?.setOutputMuted(muted) === true; }

  async close() {
    if (this.closing) return this.closing;
    if (!this.transport) return;
    this.closeRequested = true;
    const transport = this.transport;
    this.closing = (async () => {
      this.connectController?.abort();
      let timer;
      try {
        if (this.started && !this.finalized) {
          // Keep tracks, media and the data channel alive until final usage drains.
          transport.sendEvent({ type: 'session.close', event_id: `live_close_${++this.sequence}` });
          await Promise.race([this.closeAck.promise, new Promise(resolve => { timer = setTimeout(resolve, this.closeTimeoutMs); })]);
        }
      } catch {} finally {
        clearTimeout(timer);
        if (!this.finalized && (this.started || this.sessionId)) this.onEvent?.({ type: 'live.finalization.incomplete' });
        await transport.close();
        if (this.transport === transport) this.transport = null;
        this.started = false;
      }
    })();
    try { return await this.closing; } finally { this.closing = null; }
  }
}
