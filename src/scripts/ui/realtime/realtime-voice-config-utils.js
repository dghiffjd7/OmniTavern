import { getRealtimeProvider } from './realtime-provider-catalog.js';
import { isOpenAiLive, OPENAI_LIVE_MODEL, OPENAI_LIVE_BACKEND_MODEL } from './openai-live-config.js';
import { normalizeVoiceTranscriptionLanguages } from '../../api/voice-client.js';

const REALTIME_CONFIG_SCOPES = new Set(['chat', 'voice_shared', 'voice_tts', 'voice_stt']);

export const OPENAI_REALTIME_VOICES = Object.freeze([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);

export const DEFAULT_REALTIME_VOICE_SETTINGS = Object.freeze({
  configRef: Object.freeze({ scope: 'voice_shared', profileId: '' }),
  realtimeModel: 'gpt-realtime-2.1',
  transcriptionModel: 'gpt-4o-mini-transcribe',
  transcriptionLanguage: '',
  replyLanguage: '',
  voice: 'marin',
  vad: Object.freeze({
    mode: 'server_vad',
    threshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 600,
    createResponse: false,
    interruptResponse: true,
  }),
  idleTimeoutMinutes: 10,
  retentionRatio: 0.8,
  postInstructionsTokens: 8000,
});

const clampNumber = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const normalizeModelId = (value, fallback) => String(value || fallback).trim() || fallback;
const normalizeReplyLanguage = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);

export const normalizeRealtimeVadSettings = (value = {}) => {
  const input = value && typeof value === 'object' ? value : {};
  const number = (key, min, max) => clampNumber(
    input[key] === '' || input[key] == null ? undefined : input[key],
    DEFAULT_REALTIME_VOICE_SETTINGS.vad[key], min, max,
  );
  return {
    mode: input.mode === 'semantic_vad' ? 'semantic_vad' : 'server_vad',
    threshold: number('threshold', 0, 1),
    prefixPaddingMs: Math.round(number('prefixPaddingMs', 0, 5000)),
    silenceDurationMs: Math.round(number('silenceDurationMs', 100, 5000)),
    createResponse: false,
    interruptResponse: true,
  };
};

// A spoken-language preference is separate from input transcription. Native audio
// providers (including Gemini) use system instructions rather than languageCode.
export const applyRealtimeReplyLanguage = (instructions, settings = {}) => {
  const language = normalizeReplyLanguage(settings.replyLanguage);
  if (!language) return instructions;
  return `${instructions}\n\n[Realtime reply language]\nUse ${JSON.stringify(language)} for spoken replies throughout this call, unless the user explicitly asks to change language. Keep the character's personality and voice. Names, quotations and brief borrowed words can remain in their original language.`;
};

export const normalizeRealtimeVoiceSettings = (value = {}) => {
  const input = value && typeof value === 'object' ? value : {};
  if (isOpenAiLive(input)) {
    return { ...normalizeRealtimeVoiceSettings({}), ...input, provider: 'openai', openaiBackend: 'live',
      realtimeModel: normalizeModelId(input.realtimeModel || input.model, OPENAI_LIVE_MODEL),
      liveBackendModel: normalizeModelId(input.liveBackendModel, OPENAI_LIVE_BACKEND_MODEL),
      voice: String(input.voice || 'marin').trim(), replyLanguage: normalizeReplyLanguage(input.replyLanguage),
      idleTimeoutMinutes: Math.round(clampNumber(input.idleTimeoutMinutes, 10, 1, 30)),
      transcriptionModel: '', transcriptionLanguage: '', contextMode: 'full_duplex' };
  }
  if (input.provider && input.provider !== 'openai' && getRealtimeProvider(input.provider)) {
    return { ...normalizeRealtimeVoiceSettings({}), ...input, replyLanguage: normalizeReplyLanguage(input.replyLanguage), voice: String(input.voice || '').trim(), contextMode: input.provider === 'custom' ? 'per_turn' : 'session_snapshot',
      ...(input.provider === 'custom' ? { vad: normalizeRealtimeVadSettings({ ...input.vad, mode: 'server_vad' }) } : {}) };
  }
  const configRefInput = input.configRef && typeof input.configRef === 'object' ? input.configRef : {};
  const rawScope = String(configRefInput.scope || '').trim().toLowerCase();
  const scope = REALTIME_CONFIG_SCOPES.has(rawScope)
    ? rawScope
    : DEFAULT_REALTIME_VOICE_SETTINGS.configRef.scope;
  const voiceInput = String(input.voice || '').trim().toLowerCase();
  const vadInput = input.vad && typeof input.vad === 'object' ? input.vad : {};
  return {
    configRef: {
      scope,
      profileId: String(configRefInput.profileId || '').trim(),
    },
    realtimeModel: normalizeModelId(
      input.realtimeModel,
      DEFAULT_REALTIME_VOICE_SETTINGS.realtimeModel,
    ),
    transcriptionModel: normalizeModelId(
      input.transcriptionModel,
      DEFAULT_REALTIME_VOICE_SETTINGS.transcriptionModel,
    ),
    transcriptionLanguage: normalizeVoiceTranscriptionLanguages(input.transcriptionLanguage).join(','),
    replyLanguage: normalizeReplyLanguage(input.replyLanguage),
    voice: OPENAI_REALTIME_VOICES.includes(voiceInput)
      ? voiceInput
      : DEFAULT_REALTIME_VOICE_SETTINGS.voice,
    vad: normalizeRealtimeVadSettings({ ...vadInput, mode: String(vadInput.mode || '').trim().toLowerCase() }),
    idleTimeoutMinutes: Math.round(clampNumber(
      input.idleTimeoutMinutes,
      DEFAULT_REALTIME_VOICE_SETTINGS.idleTimeoutMinutes,
      1,
      30,
    )),
    retentionRatio: clampNumber(
      input.retentionRatio,
      DEFAULT_REALTIME_VOICE_SETTINGS.retentionRatio,
      0.5,
      1,
    ),
    postInstructionsTokens: Math.round(clampNumber(
      input.postInstructionsTokens,
      DEFAULT_REALTIME_VOICE_SETTINGS.postInstructionsTokens,
      1000,
      16000,
    )),
  };
};

export const isRealtimeModelId = value => {
  const id = String(value || '').trim().toLowerCase();
  return Boolean(id) && (/(^|[-_/])realtime(?:[-_/]|$)/.test(id) || /^gpt-realtime/.test(id));
};

export const isRealtimeTranscriptionModelId = value => {
  const id = String(value || '').trim().toLowerCase();
  return id === 'whisper-1'
    || /^gpt-(?:4o(?:-mini)?-)?transcribe(?:-|$)/.test(id)
    || /^gpt-live-transcribe(?:-|$)/.test(id);
};

const uniqueModelIds = values => Array.from(new Set(
  (Array.isArray(values) ? values : [])
    .map(value => String(value?.id || value || '').trim())
    .filter(Boolean),
));

export const filterRealtimeModelIds = values => uniqueModelIds(values).filter(isRealtimeModelId);

export const filterRealtimeTranscriptionModelIds = values => (
  uniqueModelIds(values).filter(isRealtimeTranscriptionModelId)
);

export const buildOpenAiRealtimeSessionConfig = (value = {}) => {
  const settings = normalizeRealtimeVoiceSettings(value);
  const instructions = String(value?.instructions || '').trim();
  const transcriptionLanguages = normalizeVoiceTranscriptionLanguages(settings.transcriptionLanguage);
  const transcriptionModel = String(settings.transcriptionModel || '').trim().toLowerCase();
  const supportsMultipleLanguages = /^(?:gpt-live-transcribe|gpt-transcribe)(?:-|$)/.test(transcriptionModel);
  const transcription = {
    model: settings.transcriptionModel,
    ...(transcriptionLanguages.length
      ? supportsMultipleLanguages
        ? { languages: transcriptionLanguages }
        : { language: transcriptionLanguages[0] }
      : {}),
  };
  const turnDetection = settings.vad.mode === 'semantic_vad'
    ? {
        type: 'semantic_vad',
        eagerness: 'auto',
        create_response: false,
        interrupt_response: true,
      }
    : {
        type: 'server_vad',
        threshold: settings.vad.threshold,
        prefix_padding_ms: settings.vad.prefixPaddingMs,
        silence_duration_ms: settings.vad.silenceDurationMs,
        create_response: false,
        interrupt_response: true,
      };
  return {
    type: 'realtime',
    model: settings.realtimeModel,
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription,
        turn_detection: turnDetection,
      },
      output: { voice: settings.voice },
    },
    truncation: {
      type: 'retention_ratio',
      retention_ratio: settings.retentionRatio,
      token_limits: {
        post_instructions: settings.postInstructionsTokens,
      },
    },
    ...(instructions ? { instructions } : {}),
  };
};

export const resolveRealtimeConfigReference = async ({ settings, managers = {}, profileStore = null } = {}) => {
  if (!profileStore && globalThis.localStorage) {
    const { getRealtimeProfileStore } = await import('../../storage/realtime-profile-store.js');
    profileStore = getRealtimeProfileStore();
  }
  const selected = await profileStore?.resolve();
  if (selected) return selected;
  const normalized = normalizeRealtimeVoiceSettings(settings);
  if (!isRealtimeModelId(normalized.realtimeModel)) {
    return { ok: false, reason: 'realtime_model_invalid', settings: normalized };
  }
  if (!isRealtimeTranscriptionModelId(normalized.transcriptionModel)) {
    return { ok: false, reason: 'transcription_model_invalid', settings: normalized };
  }
  const manager = managers?.[normalized.configRef.scope];
  if (!manager || typeof manager.getRuntimeConfigByProfileId !== 'function') {
    return { ok: false, reason: 'scope_unavailable', settings: normalized };
  }
  if (!normalized.configRef.profileId) {
    return { ok: false, reason: 'profile_missing', settings: normalized };
  }
  const runtime = await manager.getRuntimeConfigByProfileId(normalized.configRef.profileId);
  if (!runtime) return { ok: false, reason: 'profile_not_found', settings: normalized };
  if (String(runtime.provider || '').trim().toLowerCase() !== 'openai') {
    return { ok: false, reason: 'provider_not_openai', settings: normalized };
  }
  const apiKey = String(runtime.apiKey || '').trim();
  if (!apiKey) return { ok: false, reason: 'api_key_missing', settings: normalized };
  const baseUrl = String(runtime.baseUrl || '').trim().replace(/\/+$/, '');
  if (baseUrl !== 'https://api.openai.com/v1') {
    return { ok: false, reason: 'base_url_not_official', settings: normalized };
  }
  return {
    ok: true,
    settings: normalized,
    config: {
      ...runtime,
      provider: 'openai',
      baseUrl,
      apiKey,
    },
  };
};
