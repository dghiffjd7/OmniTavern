import { safeInvoke } from '../../utils/tauri.js';
import { invokeNativeHttpRequest, createLinkedAbortController } from '../../api/abort.js';
import { t } from '../../i18n/index.js';
import { REALTIME_SYSTEM_VOICES } from './realtime-voice-catalog.js';

export const parseXaiRealtimeVoices = data => {
  if (!Array.isArray(data?.voices) || data.voices.length > 1000) throw new Error(t('音色目录返回了无效响应'));
  const seen = new Set();
  const voices = data.voices.flatMap(row => {
    const id = typeof row?.voice_id === 'string' ? row.voice_id.trim() : '';
    if (!/^[a-z0-9_-]{1,128}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    const known = REALTIME_SYSTEM_VOICES.xai_voice.find(voice => voice.id === id);
    return [{ id, label: typeof row.name === 'string' ? row.name.slice(0,100) : id, gender: '', description: '',
      language: typeof row.language === 'string' ? row.language.slice(0,40) : '', ...known }];
  });
  if (!voices.length) throw new Error(t('目录中没有可用音色；已保留当前列表'));
  return voices;
};

export class RealtimeVoiceDiscovery {
  constructor({ invoke = safeInvoke } = {}) { this.invoke = invoke; }
  async list(profile, credentials, { signal } = {}) {
    if (profile.provider !== 'xai_voice' || profile.voiceKind === 'custom') throw new Error(t('此服务商使用内建音色目录'));
    if (!credentials?.apiKey) throw new Error(t('请填写 API Key / Access Token'));
    const linked = createLinkedAbortController({ signal, timeoutMs: 20000 });
    try {
      let response;
      try {
        response = await invokeNativeHttpRequest({ invoker: this.invoke, signal: linked.controller.signal, args: {
          url: 'https://api.x.ai/v1/tts/voices', method: 'GET', headers: { Authorization: `Bearer ${credentials.apiKey}` }, body: null, timeoutMs: 15000,
        } });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error(t('获取音色列表失败，请检查网络后重试；当前声音不会被覆盖'));
      }
      if (!(response?.status >= 200 && response.status < 300)) throw new Error(t('获取音色列表失败（HTTP {status}），请检查凭证', { status: response?.status || 0 }));
      let data;
      try { data = JSON.parse(response.body); } catch { throw new Error(t('音色目录返回了无效响应')); }
      return parseXaiRealtimeVoices(data);
    } finally { linked.cleanup(); }
  }
}
