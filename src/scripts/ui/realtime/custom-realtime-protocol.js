// OpenAI Realtime GA over WebSocket. The shared runtime owns per-turn context
// and maid task policy; this adapter owns wire events and audio interruption.
export const createCustomRealtimeProtocol = ({ sessionConfig, send, emit, ready, play, clear, playbackTime = () => 0 }) => {
  let responseId = '', responding = false, suppressed = false, itemId = '', contentIndex = 0;
  let segments = [], completedSeconds = 0;
  const playedMilliseconds = () => {
    const now = playbackTime();
    while (segments.length && segments[0].end <= now) { const part = segments.shift(); completedSeconds += part.end - part.start; }
    return Math.max(0, Math.floor((completedSeconds + segments.reduce((sum, part) => sum + Math.max(0, Math.min(now, part.end) - part.start), 0)) * 1000));
  };
  const cancel = () => {
    const played = playedMilliseconds();
    if (responding) send({ type: 'response.cancel' });
    if (itemId) send({ type: 'conversation.item.truncate', item_id: itemId, content_index: contentIndex, audio_end_ms: played });
    suppressed = true; responding = false; itemId = ''; segments = []; completedSeconds = 0;
    clear();
  };
  const sendEvent = event => event.type === 'response.cancel' ? cancel() : send(event);
  return {
    start: () => {
      const { truncation, ...session } = sessionConfig;
      send({ type: 'session.update', session: { ...session, audio: {
        ...session.audio,
        input: { ...session.audio.input, format: { type: 'audio/pcm', rate: 24000 } },
        output: { ...session.audio.output, format: { type: 'audio/pcm', rate: 24000 } },
      } } });
    },
    audio: audio => send({ type: 'input_audio_buffer.append', audio }),
    sendEvent, cancel, close: () => {},
    toolResults: results => results.forEach(({ call, result }) => send({ type: 'conversation.item.create', item: {
      type: 'function_call_output', call_id: call.id, output: JSON.stringify(result),
    } })),
    taskUpdate: text => send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } }),
    respond: () => send({ type: 'response.create', response: { output_modalities: ['audio'] } }),
    receive: event => {
      if (event.type === 'session.updated') ready();
      if (event.type === 'response.created') {
        responseId = event.response?.id || ''; responding = true; suppressed = false;
        itemId = ''; segments = []; completedSeconds = 0;
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        // Mark the user as speaking before clearing playback emits cancellations;
        // otherwise a queued maid result could start speaking into the new turn.
        emit(event); cancel(); return;
      }
      if (event.type === 'response.output_audio.delta') {
        if (suppressed || (event.response_id && event.response_id !== responseId)) return;
        if (event.item_id && event.item_id !== itemId) { itemId = event.item_id; contentIndex = event.content_index || 0; segments = []; completedSeconds = 0; }
        playedMilliseconds();
        const part = play(event.delta, 24000);
        if (part) segments.push(part);
      }
      if (event.type === 'response.done' && (!event.response?.id || event.response.id === responseId)) responding = false;
      // Server VAD cancellation can win the race against a local cancellation.
      if (event.type === 'error' && event.error?.code === 'response_cancel_not_active') return;
      emit(event);
    },
  };
};
