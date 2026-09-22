import { REALTIME_SYSTEM_VOICES, OPENAI_LIVE_VOICES, getRealtimeSystemVoices } from './realtime-voice-catalog.js';
import { isOpenAiLive, isOpenAiLiveModel, OPENAI_LIVE_BACKEND_MODEL } from './openai-live-config.js';
import { CUSTOM_REALTIME_PROTOCOL, validateCustomRealtimeProfile, customRealtimeHeaders } from './custom-realtime-config.js';
// Presets are deliberately protocol specific. Voice identifiers remain case sensitive.
const voiceIds = provider => REALTIME_SYSTEM_VOICES[provider].map(voice => voice.id);
export const REALTIME_PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI Realtime', models: ['gpt-realtime-2.1'], voices: voiceIds('openai'), contextMode: 'per_turn' },
  gemini_live: { label: 'Gemini Live', models: ['gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-12-2025'], voices: voiceIds('gemini_live'), inputRate: 16000, outputRate: 24000 },
  doubao_realtime: { label: '豆包 Realtime', models: ['1.2.1.1', '2.2.0.0'], modelLabels: ['O2.0', 'SC2.0'], voices: voiceIds('doubao_realtime'), inputRate: 16000, outputRate: 24000, clone: 'slot' },
  qwen_audio_realtime: { label: 'Qwen Audio Realtime', models: ['qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash'], voices: voiceIds('qwen_audio_realtime'), regions: ['cn-beijing', 'ap-southeast-1'], inputRate: 16000, outputRate: 24000, clone: 'url' },
  step_realtime: { label: 'StepAudio Realtime', models: ['stepaudio-2.5-realtime'], voices: voiceIds('step_realtime'), regions: ['cn', 'global'], regionLabel: 'Step 接入站点', regionLabels: { cn: '中国大陆（stepfun.com）', global: '国际版（stepfun.ai）' }, inputRate: 24000, outputRate: 24000, clone: 'file' },
  xai_voice: { label: 'xAI Grok Voice', models: ['grok-voice-think-fast-2.0'], voices: voiceIds('xai_voice'), inputRate: 24000, outputRate: 24000, clone: 'import' },
  nova_sonic: { label: 'Nova 2 Sonic', models: ['amazon.nova-2-sonic-v1:0'], voices: voiceIds('nova_sonic'), regions: ['us-east-1', 'us-west-2', 'ap-northeast-1'], inputRate: 16000, outputRate: 24000 },
  custom: { label: '自定义', models: ['gpt-realtime-2.1'], voices: ['marin'], inputRate: 24000, outputRate: 24000, contextMode: 'per_turn' },
});
export const isDoubaoSc2 = profile => profile?.provider === 'doubao_realtime' && String(profile.model || '').startsWith('2.');
export const getRealtimeProvider = id => REALTIME_PROVIDERS[id] || null;
// Older Step profiles had no region and always used the mainland endpoint.
export const getStepRealtimeApiBase = profile => {
  if (!profile.region || profile.region === 'cn') return 'https://api.stepfun.com/v1';
  if (profile.region === 'global') return 'https://api.stepfun.ai/v1';
  throw new Error('请选择 Step 接入站点');
};
export const GEMINI_VERTEX_MODELS = ['gemini-live-2.5-flash-native-audio'];
export const GEMINI_VERTEX_REGIONS = ['us-central1', 'us-east1', 'us-east4', 'us-east5', 'us-south1', 'us-west1', 'us-west4', 'europe-central2', 'europe-north1', 'europe-southwest1', 'europe-west1', 'europe-west4', 'europe-west8'];
export const isGeminiVertex = profile => profile?.provider === 'gemini_live' && profile.geminiBackend === 'vertex';
export const usesGeminiServiceAccount = profile => isGeminiVertex(profile) && profile.vertexaiAuthMode === 'service_account';
export const parseRealtimeServiceAccount = value => {
  let account;
  try { account = JSON.parse(value); } catch { throw new Error('Service Account JSON 格式无效'); }
  if (!account?.client_email || !account?.private_key || !String(account.private_key).includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Service Account JSON 缺少 client_email 或有效的 private_key');
  return account;
};
export const makeRealtimeProfile = (provider = 'gemini_live') => {
  const preset = getRealtimeProvider(provider);
  if (!preset) throw new Error('未知实时语音服务商');
  return { id: '', name: preset.label, provider, model: preset.models[0], voice: preset.voices[0], voiceKind: 'system', region: preset.regions?.[0] || '', workspaceId: '', credentialId: '', customVoices: [], idleTimeoutMinutes: 10, replyLanguage: '', transcriptionLanguage: '',
    ...(provider === 'openai' ? { openaiBackend: 'realtime', liveBackendModel: OPENAI_LIVE_BACKEND_MODEL } : {}),
    ...(provider === 'custom' ? { customProtocol: CUSTOM_REALTIME_PROTOCOL, endpoint: '', authMode: 'bearer', authHeader: 'api-key', transcriptionModel: 'gpt-4o-mini-transcribe' } : {}),
    ...(provider === 'gemini_live' ? { geminiBackend: 'developer', vertexaiAuthMode: 'service_account', vertexaiProjectId: '' } : {}) };
};
export const validateRealtimeProfile = profile => {
  const preset = getRealtimeProvider(profile?.provider);
  if (!preset) throw new Error('未知实时语音服务商');
  if (!String(profile.name || '').trim() || !String(profile.model || '').trim()) throw new Error('请填写设置档名称和模型');
  if (profile.provider === 'custom') validateCustomRealtimeProfile(profile);
  if (profile.provider === 'openai') {
    if (!['realtime', 'live'].includes(profile.openaiBackend || 'realtime')) throw new Error('请选择 OpenAI 语音接入方式');
    if (isOpenAiLive(profile)) {
      if (!isOpenAiLiveModel(profile.model)) throw new Error('请填写 GPT-Live 模型 ID，例如 gpt-live-1');
      if (!String(profile.liveBackendModel || '').trim() || /[\s<>]/.test(profile.liveBackendModel)) throw new Error('请填写有效的推理模型 ID');
    } else if (isOpenAiLiveModel(profile.model)) throw new Error('此模型需要选择 GPT-Live 接入方式');
    if (!isOpenAiLive(profile) && OPENAI_LIVE_VOICES.some(voice => voice.id === profile.voice)
      && !REALTIME_SYSTEM_VOICES.openai.some(voice => voice.id === profile.voice)) throw new Error('此声音需要 GPT-Live 接入方式，请重新选择声音并检查角色绑定');
  }
  if (profile.provider === 'gemini_live') {
    if (!['developer', 'vertex'].includes(profile.geminiBackend || 'developer')) throw new Error('请选择 Gemini Live 接入方式');
    if (isGeminiVertex(profile)) {
      if (!['service_account', 'express'].includes(profile.vertexaiAuthMode)) throw new Error('请选择 Vertex AI 连接模式');
      if (!/^[a-zA-Z0-9._-]+$/.test(profile.model) || profile.model.startsWith('gemini-2.5-flash-native-audio') || profile.model === 'gemini-3.1-flash-live-preview') throw new Error('请填写 Vertex AI 的 Live 模型 ID；AI Studio 的模型名称不能直接混用');
      if (usesGeminiServiceAccount(profile)) {
        if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(profile.vertexaiProjectId || '')) throw new Error('请填写有效的 Google Cloud Project ID');
        if (!GEMINI_VERTEX_REGIONS.includes(profile.region)) throw new Error('请选择 Vertex Live 支持的区域');
      }
    }
  }
  if (preset.regions && !preset.regions.includes(profile.region)) throw new Error('请选择受支持的区域');
  if (!String(profile.voice || '').trim()) throw new Error('请选择声音或填写 Voice ID');
  if (profile.provider === 'step_realtime' && profile.voiceKind !== 'custom' && REALTIME_SYSTEM_VOICES.step_realtime.some(voice => voice.id === profile.voice) && !getRealtimeSystemVoices(profile).some(voice => voice.id === profile.voice)) throw new Error('此 Step 系统声音不适用于当前站点或模型，请重新选择声音并检查角色绑定');
  if (profile.provider === 'qwen_audio_realtime' && !/^[a-zA-Z0-9-]*$/.test(profile.workspaceId || '')) throw new Error('Workspace ID 格式无效');
  if (profile.provider === 'nova_sonic' && !/^amazon\.nova[\w.-]*-sonic[\w.:-]*$/.test(profile.model)) throw new Error('请填写 Nova Sonic 模型 ID');
  if (profile.provider === 'doubao_realtime' && !/^\d+(?:\.\d+){3}$/.test(profile.model)) throw new Error('请填写豆包实时模型版本号，例如 1.2.1.1');
  if (isDoubaoSc2(profile) && profile.voiceKind !== 'custom' && !profile.voice.startsWith('saturn_')) throw new Error('SC2.0 需要 saturn_ 系统声音或 S_ 自定义声音');
  if (profile.voiceKind === 'custom') {
    if (!preset.clone) throw new Error('此服务商预设暂不支持自定义声音');
    const voice = profile.customVoices?.find(item => item.voiceId === profile.voice);
    if (!voice) throw new Error('请先将 Voice ID 登记到当前设置档');
    if (voice.status !== 'ready') throw new Error('此声音尚未训练完成，请刷新状态');
    if (voice.region !== profile.region || voice.workspaceId !== profile.workspaceId || voice.credentialId !== profile.credentialId) throw new Error('此声音属于其他账号、区域或工作空间，请重新登记');
    if (profile.provider === 'qwen_audio_realtime' && (voice.targetModel !== profile.model || profile.region !== 'cn-beijing')) throw new Error('Qwen 克隆声音仅支持北京区域，且目标模型必须完全一致');
    if (profile.provider === 'doubao_realtime' && !/^S_/.test(voice.voiceId)) throw new Error('豆包克隆声音需要 S_ 开头的音色 ID');
  }
  return profile;
};
export const validateRealtimeCredentials = (provider, credentials, profile = {}) => {
  if (provider === 'custom') { customRealtimeHeaders(profile, credentials); return credentials; }
  if (isGeminiVertex({ ...profile, provider })) {
    if (profile.vertexaiAuthMode === 'service_account') parseRealtimeServiceAccount(credentials.vertexaiServiceAccount);
    else if (!credentials.vertexaiApiKey) throw new Error('请填写 Vertex AI Express API Key');
  } else if (provider === 'nova_sonic') {
    if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('请填写 AWS Access Key ID 和 Secret Access Key');
  } else if (!credentials.apiKey) throw new Error('请填写 API Key / Access Token');
  if (provider === 'doubao_realtime' && !/^\d+$/.test(credentials.appId || '')) throw new Error('请填写豆包 App ID');
  return credentials;
};
