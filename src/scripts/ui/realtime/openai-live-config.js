import { t } from '../../i18n/index.js';

// GPT-Live is a separate full-duplex protocol, not a Realtime model alias.
export const OPENAI_LIVE_MODEL = 'gpt-live-1';
export const OPENAI_LIVE_BACKEND_MODEL = 'gpt-5.6-luna';
export const isOpenAiLive = profile => (!profile?.provider || profile.provider === 'openai') && profile?.openaiBackend === 'live';
export const isOpenAiLiveModel = value => /^gpt-live-[a-z0-9][\w.-]*$/i.test(String(value || '').trim())
  && !/(?:^|-)(?:transcribe|transcription|translate|tts|asr)(?:-|$)/i.test(value);

const modelIds = items => [...new Set(items.map(item => String(typeof item === 'string' ? item : item?.id || '').trim())
  .filter(id => id && id.length <= 200 && !/[\s<>]/.test(id)))];
export const filterOpenAiLiveModels = items => modelIds(items).filter(isOpenAiLiveModel);
// /models has no capability schema. Keep text candidates broad and editable;
// the API remains authoritative about Responses access for the selected project.
export const filterOpenAiLiveBackendModels = items => modelIds(items).filter(id => /^(?:gpt-|o\d)/i.test(id)
  && !/(?:live|realtime|audio|transcri|tts|image|search|instruct|embedding|moderation)/i.test(id));

export const buildOpenAiLiveSessionConfig = ({ realtimeModel, model, liveBackendModel, voice = 'marin', instructions = '', maidTasks = false } = {}) => {
  const voiceModel = String(realtimeModel || model || OPENAI_LIVE_MODEL).trim();
  const backendModel = String(liveBackendModel || OPENAI_LIVE_BACKEND_MODEL).trim();
  if (!isOpenAiLiveModel(voiceModel)) throw new Error(t('请填写 GPT-Live 模型 ID，例如 gpt-live-1'));
  if (!backendModel || /[\s<>]/.test(backendModel)) throw new Error(t('请填写有效的推理模型 ID'));
  return {
    model: voiceModel,
    instructions: String(instructions),
    audio: { output: { voice } },
    delegation: maidTasks ? { type: 'client' } : {
      type: 'responses',
      responses: {
        model: backendModel,
        instructions: `${instructions}\n\nHelp the voice assistant reason about the caller's request while preserving the character and conversation context. Provide concise information suitable for a spoken reply. You have no external tools; do not claim to have performed external actions.`,
        tools: [],
        tool_choice: 'none',
      },
    },
    store: false,
  };
};
