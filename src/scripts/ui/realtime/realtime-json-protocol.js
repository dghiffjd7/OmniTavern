// These three APIs share event names, but their session schemas are not interchangeable.
export const buildJsonRealtimeSession = (profile, instructions) => {
  const session = { instructions, voice: profile.voice };
  if (profile.provider === 'xai_voice') return { ...session,
    turn_detection: { type: 'server_vad', threshold: .85, silence_duration_ms: 600 },
    audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'grok-transcribe' } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
  };
  if (profile.provider === 'qwen_audio_realtime') return { ...session, modalities: ['text', 'audio'], input_audio_format: 'pcm', output_audio_format: 'pcm',
    turn_detection: { type: 'server_vad', threshold: .5, silence_duration_ms: 800 }, max_history_turns: 20 };
  if (profile.provider === 'step_realtime') return { ...session, modalities: ['text', 'audio'], input_audio_format: 'pcm16', output_audio_format: 'pcm16',
    turn_detection: { type: 'server_vad', prefix_padding_ms: 500, silence_duration_ms: 600, energy_awakeness_threshold: 2500 } };
  throw new Error('Unsupported JSON realtime protocol');
};
export const createJsonRealtimeProtocol = ({ profile, instructions, send, emit, ready, play, clear }) => {
  let responseId = '', userId = '', suppressed = false;
  return {
    start: () => send({ type: 'session.update', session: buildJsonRealtimeSession(profile, instructions) }),
    audio: audio => send({ type: 'input_audio_buffer.append', audio }),
    cancel: () => { clear(); suppressed = true; if (responseId) send({ type: 'response.cancel' }); },
    close: () => {},
    receive: event => {
      const type = event.type;
      if (type === 'session.updated') ready();
      if (type === 'response.created') { responseId = event.response?.id || ''; suppressed = false; }
      if (type === 'input_audio_buffer.speech_started') { userId = event.item_id || `input_${crypto.randomUUID()}`; clear(); event = { ...event, item_id: userId }; }
      if (type === 'input_audio_buffer.speech_stopped') event = { ...event, item_id: event.item_id || userId };
      if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
        if (!suppressed && (!event.response_id || event.response_id === responseId)) play(event.delta);
        emit(event); return;
      }
      if (type === 'conversation.item.input_audio_transcription.updated' || type === 'conversation.item.input_audio_transcription.delta') {
        // xAI updated is a cumulative revision; only completed events enter history.
        emit({ type: 'input.transcript.preview', text: event.transcript || event.delta || '' }); return;
      }
      if (type === 'conversation.item.input_audio_transcription.completed') event = { ...event, item_id: event.item_id || userId };
      if (type === 'response.done' || type === 'response.cancelled') responseId = '';
      const aliases = { 'response.audio_transcript.delta': 'response.output_audio_transcript.delta', 'response.audio_transcript.done': 'response.output_audio_transcript.done', 'response.text.delta': 'response.output_text.delta', 'response.text.done': 'response.output_text.done' };
      emit({ ...event, type: aliases[type] || type });
    },
  };
};
