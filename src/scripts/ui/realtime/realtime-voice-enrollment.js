import { t } from '../../i18n/index.js';
import { safeInvoke } from '../../utils/tauri.js';
import { bytesToBase64 } from './realtime-pcm-codec.js';
import { getStepRealtimeApiBase } from './realtime-provider-catalog.js';
const requiredUrl = value => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请填写服务商可访问的 HTTPS 音频 URL'); return url.href; };
export const buildQwenVoiceEnrollment = (profile, { url, prefix }) => {
  if (profile.region !== 'cn-beijing') throw new Error('Qwen 实时声音克隆仅支持北京区域');
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(prefix || '')) throw new Error('声音前缀需要 1–16 位英文字母、数字或下划线');
  const host = profile.workspaceId ? `${profile.workspaceId}.cn-beijing.maas.aliyuncs.com` : 'dashscope.aliyuncs.com';
  return { url: `https://${host}/api/v1/services/audio/tts/customization`, body: { model: 'voice-enrollment', input: { action: 'create_voice', target_model: profile.model, prefix, url: requiredUrl(url) } } };
};
export const buildDoubaoVoiceEnrollment = (profile, credentials, { voiceId, audioBytes, audioFormat, text = '' }) => {
  if (!/^S_[a-zA-Z0-9_-]+$/.test(voiceId || '')) throw new Error('请填写已购买的 S_ 克隆音色槽位');
  if (!['wav', 'mp3'].includes(audioFormat)) throw new Error('请选择 WAV 或 MP3 音频');
  return { url: 'https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload',
    headers: { Authorization: `Bearer; ${credentials.apiKey}`, 'Resource-Id': 'seed-icl-2.0' },
    body: { appid: credentials.appId, speaker_id: voiceId, audios: [{ audio_bytes: audioBytes, audio_format: audioFormat, ...(text ? { text } : {}) }], source: 2, model_type: 4 } };
};
export const buildStepVoiceMultipart = (bytes, audioFormat) => {
  const boundary = `realtime_voice_${crypto.randomUUID()}`; const encoder = new TextEncoder();
  const start = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nstorage\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.${audioFormat}"\r\nContent-Type: ${audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav'}\r\n\r\n`);
  const end = encoder.encode(`\r\n--${boundary}--\r\n`); const body = new Uint8Array(start.length + bytes.length + end.length);
  body.set(start); body.set(bytes, start.length); body.set(end, start.length + bytes.length);
  return { bodyBase64: bytesToBase64(body), contentType: `multipart/form-data; boundary=${boundary}` };
};
export class RealtimeVoiceEnrollment {
  constructor({ invoke = safeInvoke } = {}) { this.invoke = invoke; }
  async request({ url, headers, body, bodyBase64, method = 'POST' }, signal) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const requestId = `realtime_clone_${crypto.randomUUID()}`;
    const abort = () => { void this.invoke('http_abort_request', { requestId }).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.invoke('http_request', { url, method, headers, body: body ? JSON.stringify(body) : null, bodyBase64: bodyBase64 || null, requestId, timeoutMs: 120000 });
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      let data; try { data = JSON.parse(response.body); } catch {}
      if (response.status < 200 || response.status >= 300 || data?.BaseResp?.StatusCode || data?.error || data?.code) {
        const summary = t('声音服务请求失败（HTTP {status}）', { status: `${response.status}${data?.BaseResp?.StatusCode ? ` / ${data.BaseResp.StatusCode}` : ''}` });
        const hint = response.status === 402 ? t('账户余额不足，请检查服务商的 API 余额') : response.status === 401 ? t('鉴权失败，请检查凭证与接入站点') : '';
        let detail = data?.error?.message || data?.message || data?.BaseResp?.StatusMessage || '';
        detail = typeof detail === 'string' ? detail : '';
        for (const value of Object.values(headers || {})) {
          const secret = String(value).replace(/^Bearer;?\s+/i, '');
          if (secret && secret !== 'application/json' && !secret.startsWith('multipart/')) detail = detail.split(secret).join('[redacted]');
        }
        throw new Error([summary, hint, detail.slice(0, 300)].filter(Boolean).join(' · '));
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('声音服务返回了无效响应');
      return data;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async create(profile, credentials, options, signal) {
    const headers = { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
    if (profile.provider === 'qwen_audio_realtime') {
      options.onProgress?.('creating');
      const data = await this.request({ ...buildQwenVoiceEnrollment(profile, options), headers }, signal);
      if (!data.output?.voice_id) throw new Error('Qwen 未返回 Voice ID');
      return { voiceId: data.output.voice_id, status: 'ready' };
    }
    const file = options.file;
    if (!file || file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MB 以内的参考音频');
    const audioFormat = String(file.name).split('.').pop().toLowerCase();
    if (!['wav', 'mp3'].includes(audioFormat)) throw new Error('请选择 WAV 或 MP3 音频');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (profile.provider === 'doubao_realtime') {
      const request = buildDoubaoVoiceEnrollment(profile, credentials, { ...options, audioBytes: bytesToBase64(bytes), audioFormat });
      options.onProgress?.('uploading');
      await this.request({ ...request, headers: { ...request.headers, 'Content-Type': 'application/json' } }, signal);
      return { voiceId: options.voiceId, status: 'training' };
    }
    if (profile.provider === 'step_realtime') {
      const baseUrl = getStepRealtimeApiBase(profile);
      const multipart = buildStepVoiceMultipart(bytes, audioFormat);
      options.onProgress?.('uploading');
      const uploaded = await this.request({ url: `${baseUrl}/files`, headers: { ...headers, 'Content-Type': multipart.contentType }, bodyBase64: multipart.bodyBase64 }, signal);
      if (!uploaded.id) throw new Error('Step 未返回上传文件 ID');
      options.onProgress?.('creating');
      const data = await this.request({ url: `${baseUrl}/audio/voices`, headers, body: { model: 'stepaudio-2.5-tts', file_id: uploaded.id, ...(options.text ? { text: options.text } : {}) } }, signal);
      if (!data.id) throw new Error('Step 未返回克隆声音 ID');
      return { voiceId: data.id, status: 'ready' };
    }
    throw new Error('此服务商请直接登记已有 Voice ID');
  }
  async status(profile, credentials, voiceId, signal) {
    if (profile.provider !== 'doubao_realtime') throw new Error('此服务商无需轮询训练状态');
    const data = await this.request({ url: 'https://openspeech.bytedance.com/api/v1/mega_tts/status',
      headers: { Authorization: `Bearer; ${credentials.apiKey}`, 'Resource-Id': 'seed-icl-2.0', 'Content-Type': 'application/json' }, body: { appid: credentials.appId, speaker_id: voiceId } }, signal);
    return { voiceId, status: [2, 4].includes(data.status) ? 'ready' : data.status === 3 ? 'failed' : 'training' };
  }
}
