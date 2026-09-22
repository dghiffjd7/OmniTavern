import { isGeminiVertex, usesGeminiServiceAccount } from './realtime-provider-catalog.js';
import { t } from '../../i18n/index.js';
export const buildGeminiLiveSetup = (profile, instructions, resumeHandle = '') => ({ setup: {
  model: isGeminiVertex(profile)
    ? `${usesGeminiServiceAccount(profile) ? `projects/${profile.vertexaiProjectId}/locations/${profile.region}/` : ''}publishers/google/models/${profile.model}`
    : `models/${profile.model.replace(/^models\//, '')}`,
  generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: profile.voice } } } },
  systemInstruction: { parts: [{ text: instructions }] }, inputAudioTranscription: {}, outputAudioTranscription: {},
  sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  contextWindowCompression: { slidingWindow: {} },
  ...(profile.maidTools?.length ? { tools: [{ functionDeclarations: profile.maidTools.map(({ name, description, parameters }) => ({ name, description, parameters })) }] } : {}),
} });
export const createGeminiLiveProtocol = ({ profile, instructions, send, emit, ready, play, clear, renew, resumeHandle = '', onResumeHandle }) => {
  let responseId = '', userText = '', assistantText = '', suppressed = false;
  const begin = () => { if (!responseId) { responseId = `gemini_${crypto.randomUUID()}`; emit({ type: 'response.created', response: { id: responseId } }); } };
  const user = () => { if (userText.trim()) emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `gemini_input_${crypto.randomUUID()}`, transcript: userText }); userText = ''; };
  return {
    start: () => send(buildGeminiLiveSetup(profile, instructions, resumeHandle)),
    audio: data => send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } }),
    // Gemini has no response.cancel; discard the rest of the current playback locally.
    cancel: () => { clear(); suppressed = true; },
    close: () => send({ realtimeInput: { audioStreamEnd: true } }),
    toolResults: results => send({ toolResponse: { functionResponses: results.map(({ call, result }) => ({ id: call.id, name: call.name, response: result })) } }),
    taskUpdate: text => send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }),
    receive: message => {
      // Gemini also sends UTF-8 JSON in binary WebSocket frames, including setupComplete.
      if (message instanceof Uint8Array) {
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message)); }
        catch { throw new Error(t('Gemini Live 返回了无效的消息格式')); }
      }
      if (message.setupComplete) { ready(); return; }
      if (message.sessionResumptionUpdate?.resumable) onResumeHandle?.(message.sessionResumptionUpdate.newHandle);
      if (message.goAway) renew();
      if (message.error) { emit({ type: 'error', error: { message: 'Gemini Live 返回错误，请检查模型和账号权限', code: String(message.error.code || '') } }); return; }
      if (message.toolCall?.functionCalls?.length) {
        user();
        emit({ type: 'maid.tools.requested', calls: message.toolCall.functionCalls.map(call => ({ id: call.id, name: call.name, arguments: call.args })) });
      }
      if (message.toolCallCancellation) emit({ type: 'maid.tools.cancelled', ids: message.toolCallCancellation.ids || [] });
      const content = message.serverContent || {};
      if (content.interrupted) {
        clear(); user(); if (responseId) emit({ type: 'response.cancelled', response_id: responseId });
        responseId = ''; assistantText = ''; suppressed = false; emit({ type: 'input_audio_buffer.speech_started' });
      }
      if (content.inputTranscription?.text) userText += content.inputTranscription.text;
      if (content.outputTranscription?.text) {
        begin(); assistantText += content.outputTranscription.text;
        emit({ type: 'response.output_audio_transcript.delta', response_id: responseId, delta: content.outputTranscription.text });
      }
      for (const part of content.modelTurn?.parts || []) {
        const audio = part.inlineData;
        if (audio?.data && audio.mimeType?.startsWith('audio/pcm')) {
          begin(); if (!suppressed) play(audio.data, Number(/rate=(\d+)/.exec(audio.mimeType)?.[1] || 24000));
          emit({ type: 'response.output_audio.delta', response_id: responseId });
        }
      }
      if (content.turnComplete) {
        user();
        if (responseId) {
          emit({ type: 'response.output_audio_transcript.done', response_id: responseId, transcript: assistantText });
          emit({ type: 'response.done', response: { id: responseId, status: suppressed ? 'cancelled' : 'completed' } });
        }
        responseId = ''; assistantText = ''; suppressed = false;
      }
      if (message.usageMetadata) {
        const usage = message.usageMetadata;
        emit({ type: 'usage.delta', usage: { input_tokens: usage.promptTokenCount, output_tokens: usage.responseTokenCount, total_tokens: usage.totalTokenCount } });
      }
    },
  };
};
