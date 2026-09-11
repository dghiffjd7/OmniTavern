import { microphonePermissionRecovery } from '../microphone-permission-recovery.js';
import { createRealtimeAudioMeter } from './realtime-audio-meter.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
let realtimeRequestSequence = 0;

const getDefaultInvoker = () => {
  const root = typeof globalThis !== 'undefined' ? globalThis : {};
  const invoke = root?.__TAURI__?.core?.invoke
    || root?.__TAURI__?.invoke
    || root?.__TAURI_INVOKE__
    || root?.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? (command, args) => invoke(command, args) : null;
};

const makeAbortError = () => {
  const error = new Error('Realtime connection cancelled');
  error.name = 'AbortError';
  error.cancelled = true;
  return error;
};

const createRealtimeRequestId = () => {
  realtimeRequestSequence = (realtimeRequestSequence + 1) % 0x1000000;
  return `openai_realtime_${Date.now().toString(36)}_${realtimeRequestSequence.toString(36)}`;
};

const invokeRealtimeBroker = async ({ invoke, args, signal }) => {
  const requestId = createRealtimeRequestId();
  if (signal?.aborted) throw makeAbortError();
  let rejectAbort = null;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const abortNative = () => {
    try { Promise.resolve(invoke('http_abort_request', { requestId })).catch(() => {}); } catch {}
    rejectAbort?.(makeAbortError());
  };
  signal?.addEventListener?.('abort', abortNative, { once: true });
  try {
    const requestPromise = Promise.resolve(invoke('openai_realtime_create_call', {
      ...args,
      requestId,
    }));
    if (!signal) return await requestPromise;
    if (signal.aborted) abortNative();
    return await Promise.race([requestPromise, abortPromise]);
  } finally {
    try { signal?.removeEventListener?.('abort', abortNative); } catch {}
  }
};

const waitForDataChannelOpen = (channel, { timeoutMs, signal } = {}) => {
  if (channel?.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      channel?.removeEventListener?.('open', onOpen);
      channel?.removeEventListener?.('error', onError);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onOpen = () => finish(resolve);
    const onError = () => finish(reject, new Error('Realtime data channel failed to open'));
    const onAbort = () => finish(reject, makeAbortError());
    const timer = setTimeout(() => {
      finish(reject, new Error('Realtime connection timed out while opening the data channel'));
    }, timeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
    channel?.addEventListener?.('open', onOpen);
    channel?.addEventListener?.('error', onError);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

export class OpenAiRealtimeSessionClient {
  constructor({
    invoke = undefined,
    peerConnectionClass = globalThis.RTCPeerConnection,
    mediaDevices = globalThis.navigator?.mediaDevices,
    microphoneAccess = microphonePermissionRecovery,
    createAudioElement = () => globalThis.document?.createElement?.('audio') || null,
    onEvent = null,
    onConnectionState = null,
    onAudioLevel = null,
    createMeter = createRealtimeAudioMeter,
  } = {}) {
    this.invoke = invoke === undefined ? getDefaultInvoker() : invoke;
    this.PeerConnection = peerConnectionClass;
    this.mediaDevices = mediaDevices;
    this.microphoneAccess = microphoneAccess;
    this.createAudioElement = createAudioElement;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.onConnectionState = typeof onConnectionState === 'function' ? onConnectionState : null;
    this.onAudioLevel = onAudioLevel;
    this.createMeter = createMeter;
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.closed = true;
    this.handleDataMessage = event => this.receiveDataMessage(event);
  }

  async connect({ config = {}, sessionConfig = {}, signal = null, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    if (typeof this.invoke !== 'function') throw new Error('当前环境不支持 OpenAI Realtime 原生连接');
    if (typeof this.PeerConnection !== 'function') throw new Error('当前 WebView 不支持 WebRTC');
    if (typeof this.mediaDevices?.getUserMedia !== 'function') throw new Error('当前环境无法请求麦克风');
    await this.close();
    if (signal?.aborted) throw makeAbortError();
    this.closed = false;
    this.meter = this.createMeter({ onLevel: value => { if (!this.closed) this.onAudioLevel?.(value); } });

    try {
      const peerConnection = new this.PeerConnection();
      this.peerConnection = peerConnection;
      peerConnection.onconnectionstatechange = () => {
        this.onConnectionState?.(String(peerConnection.connectionState || 'unknown'));
      };
      const remoteAudio = this.createAudioElement?.();
      this.remoteAudio = remoteAudio;
      if (remoteAudio) {
        remoteAudio.autoplay = true;
        remoteAudio.playsInline = true;
        if (remoteAudio.style) remoteAudio.style.display = 'none';
        if (!remoteAudio.isConnected) globalThis.document?.body?.appendChild?.(remoteAudio);
      }
      peerConnection.ontrack = event => {
        if (!this.remoteAudio) return;
        const stream = event?.streams?.[0];
        if (!stream) return;
        this.remoteAudio.srcObject = stream;
        this.meter?.attach('output', stream);
        this.meter?.setMuted('output', this.remoteAudio.muted === true);
        try { this.remoteAudio.play?.()?.catch?.(() => {}); } catch {}
      };

      const localStream = await this.microphoneAccess.acquire({
        mediaDevices: this.mediaDevices,
        constraints: {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        },
      });
      if (signal?.aborted) throw makeAbortError();
      this.localStream = localStream;
      this.meter?.attach('input', localStream);
      const tracks = typeof localStream?.getAudioTracks === 'function'
        ? localStream.getAudioTracks()
        : localStream?.getTracks?.() || [];
      tracks.forEach(track => peerConnection.addTrack(track, localStream));

      const dataChannel = peerConnection.createDataChannel('oai-events');
      this.dataChannel = dataChannel;
      dataChannel.addEventListener?.('message', this.handleDataMessage);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const offerSdp = String(peerConnection.localDescription?.sdp || offer?.sdp || '');
      if (!offerSdp.trim()) throw new Error('WebRTC 未生成 SDP offer');
      const answerSdp = await invokeRealtimeBroker({
        invoke: this.invoke,
        signal,
        args: {
          baseUrl: String(config.baseUrl || '').trim(),
          apiKey: String(config.apiKey || '').trim(),
          sdp: offerSdp,
          sessionJson: JSON.stringify(sessionConfig || {}),
          timeoutMs,
        },
      });
      if (signal?.aborted) throw makeAbortError();
      await peerConnection.setRemoteDescription({ type: 'answer', sdp: String(answerSdp || '') });
      await waitForDataChannelOpen(dataChannel, { timeoutMs, signal });
      return true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  receiveDataMessage(event) {
    const raw = typeof event?.data === 'string' ? event.data : '';
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.onEvent?.(parsed);
    } catch {}
  }

  sendEvent(event = {}) {
    if (this.closed || this.dataChannel?.readyState !== 'open') {
      throw new Error('Realtime data channel 尚未连接');
    }
    this.dataChannel.send(JSON.stringify(event));
    return true;
  }

  setMicrophoneMuted(muted) {
    const tracks = this.localStream?.getAudioTracks?.() || [];
    tracks.forEach(track => { track.enabled = muted !== true; });
    this.meter?.setMuted('input', muted);
    return tracks.length > 0;
  }

  setOutputMuted(muted) {
    if (!this.remoteAudio) return false;
    this.remoteAudio.muted = muted === true;
    this.meter?.setMuted('output', muted);
    return true;
  }

  async close() {
    if (this.closed && !this.peerConnection && !this.localStream && !this.remoteAudio) return;
    this.closed = true;
    const meter = this.meter; this.meter = null;
    const meterClosed = meter?.close();
    try { this.dataChannel?.removeEventListener?.('message', this.handleDataMessage); } catch {}
    try { this.dataChannel?.close?.(); } catch {}
    const tracks = this.localStream?.getTracks?.() || this.localStream?.getAudioTracks?.() || [];
    tracks.forEach(track => {
      try { track.stop?.(); } catch {}
    });
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      try { this.peerConnection.close?.(); } catch {}
    }
    if (this.remoteAudio) {
      try { this.remoteAudio.srcObject = null; } catch {}
      try { this.remoteAudio.remove?.(); } catch {}
    }
    this.dataChannel = null;
    this.localStream = null;
    this.peerConnection = null;
    this.remoteAudio = null;
    await meterClosed;
  }
}
