import { t } from '../../i18n/index.js';
import { microphonePermissionRecovery } from '../microphone-permission-recovery.js';
import { decodePcm16 } from './realtime-pcm-codec.js';
export class RealtimePcmAudio {
  constructor({ onFrame, onError, microphoneAccess = microphonePermissionRecovery } = {}) {
    this.onFrame = onFrame; this.onError = onError; this.microphoneAccess = microphoneAccess; this.sources = new Set(); this.closed = true;
  }
  async open({ inputRate, outputRate, frameMs = 20, signal } = {}) {
    this.closed = false; this.outputRate = outputRate; this.muted = false; this.outputMuted = false;
    const stream = await this.microphoneAccess.acquire({ mediaDevices: globalThis.navigator?.mediaDevices, constraints: { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } } });
    if (this.closed || signal?.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Cancelled', 'AbortError'); }
    this.stream = stream;
    try {
      this.context = new AudioContext(); await this.context.resume();
      await this.context.audioWorklet.addModule(new URL('./realtime-microphone-worklet.js', import.meta.url));
      if (this.closed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.gain = this.context.createGain(); this.gain.connect(this.context.destination);
      this.capture = new AudioWorkletNode(this.context, 'realtime-microphone', { processorOptions: { outputRate: inputRate, frameMs } });
      this.capture.port.onmessage = event => { if (!this.closed) this.onFrame?.(this.muted ? new Uint8Array(event.data.length) : event.data); };
      this.capture.onprocessorerror = () => this.onError?.(new Error(t('麦克风音频处理失败')));
      this.input = this.context.createMediaStreamSource(stream); this.input.connect(this.capture);
      this.silent = this.context.createGain(); this.silent.gain.value = 0; this.capture.connect(this.silent); this.silent.connect(this.context.destination);
      this.nextTime = this.context.currentTime;
    } catch (error) { await this.close(); throw error; }
  }
  play(bytes, rate = this.outputRate) {
    if (this.closed || !this.context || !bytes.length) return;
    if (this.nextTime - this.context.currentTime > 30) throw new Error(t('实时语音播放积压过多，连接已停止'));
    const samples = decodePcm16(bytes);
    const buffer = this.context.createBuffer(1, samples.length, rate); buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain); this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    const start = Math.max(this.context.currentTime + .015, this.nextTime); source.start(start); this.nextTime = start + buffer.duration;
  }
  clear() { for (const source of this.sources) { try { source.stop(); source.disconnect(); } catch {} } this.sources.clear(); this.nextTime = this.context?.currentTime || 0; }
  setMicrophoneMuted(value) { this.muted = value; return true; }
  setOutputMuted(value) { this.outputMuted = value; if (this.gain) this.gain.gain.value = value ? 0 : 1; return true; }
  async close() {
    this.closed = true; this.clear(); this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.capture) { this.capture.port.onmessage = null; this.capture.port.close(); this.capture.disconnect(); } this.capture = null;
    this.input?.disconnect(); this.silent?.disconnect(); this.gain?.disconnect();
    const context = this.context; this.context = null; if (context && context.state !== 'closed') await context.close();
  }
}
