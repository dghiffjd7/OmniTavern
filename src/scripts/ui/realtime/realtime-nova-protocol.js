export const buildNovaStartEvents = (profile, instructions, { promptName, audioName, history = [] }) => {
  const event = (name, data) => ({ event: { [name]: data } });
  const result = [event('sessionStart', { inferenceConfiguration: { maxTokens: 2048, topP: .9, temperature: .7 }, turnDetectionConfiguration: { endpointingSensitivity: 'MEDIUM' } }),
    event('promptStart', { promptName, textOutputConfiguration: { mediaType: 'text/plain' }, audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId: profile.voice, encoding: 'base64', audioType: 'SPEECH' } })];
  if (profile.maidTools?.length) Object.assign(result[1].event.promptStart, {
    toolUseOutputConfiguration: { mediaType: 'application/json' },
    toolConfiguration: { tools: profile.maidTools.map(({ name, description, parameters }) => ({ toolSpec: { name, description, inputSchema: { json: JSON.stringify(parameters) } } })) },
  });
  [{ role: 'SYSTEM', text: instructions }, ...history.map(item => ({ role: item.role.toUpperCase(), text: item.text }))].forEach((item, index) => {
    const contentName = `${promptName}_text_${index}`;
    result.push(event('contentStart', { promptName, contentName, type: 'TEXT', interactive: false, role: item.role, textInputConfiguration: { mediaType: 'text/plain' } }),
      event('textInput', { promptName, contentName, content: item.text }), event('contentEnd', { promptName, contentName }));
  });
  result.push(event('contentStart', { promptName, contentName: audioName, type: 'AUDIO', interactive: true, role: 'USER', audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' } }));
  return result;
};
export const createNovaSonicProtocol = ({ profile, instructions, history, send, emit, ready, play, clear }) => {
  const promptName = crypto.randomUUID(), audioName = crypto.randomUUID();
  const blocks = new Map(); let responseId = '', suppressed = false, lastUsage = { input: 0, output: 0 };
  const wrap = (key, data) => send({ event: { [key]: data } });
  return {
    start: () => { buildNovaStartEvents(profile, instructions, { promptName, audioName, history }).forEach(send); ready(); },
    audio: content => wrap('audioInput', { promptName, contentName: audioName, content }),
    cancel: () => { suppressed = true; clear(); },
    toolResults: results => results.forEach(({ call, result }) => {
      const contentName = crypto.randomUUID();
      wrap('contentStart', { promptName, contentName, interactive: false, type: 'TOOL', role: 'TOOL', toolResultInputConfiguration: { toolUseId: call.id, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } });
      wrap('toolResult', { promptName, contentName, content: JSON.stringify(result) });
      wrap('contentEnd', { promptName, contentName });
    }),
    taskUpdate: text => {
      const contentName = crypto.randomUUID();
      wrap('contentStart', { promptName, contentName, type: 'TEXT', interactive: true, role: 'USER', textInputConfiguration: { mediaType: 'text/plain' } });
      wrap('textInput', { promptName, contentName, content: text });
      wrap('contentEnd', { promptName, contentName });
    },
    close: () => { wrap('contentEnd', { promptName, contentName: audioName }); wrap('promptEnd', { promptName }); wrap('sessionEnd', {}); },
    receive: message => {
      const event = message.event || {};
      if (event.completionStart) {
        responseId = event.completionStart.completionId; suppressed = false;
        emit({ type: 'session.created', session: { id: event.completionStart.sessionId } });
        emit({ type: 'response.created', response: { id: responseId } });
      }
      if (event.contentStart) {
        const content = event.contentStart; let fields = {};
        try { fields = JSON.parse(content.additionalModelFields || '{}'); } catch {}
        blocks.set(content.contentId, { ...content, stage: fields.generationStage, text: '' });
      }
      if (event.textOutput) {
        const content = blocks.get(event.textOutput.contentId);
        // Interruption notifications can arrive inside textOutput instead of contentEnd.
        let interrupted = false;
        try { interrupted = JSON.parse(event.textOutput.content)?.interrupted === true; } catch {}
        if (interrupted) { clear(); emit({ type: 'input_audio_buffer.speech_started' }); }
        else if (content?.stage === 'FINAL') {
          content.text += event.textOutput.content || '';
          if (content.role === 'ASSISTANT') emit({ type: 'response.output_audio_transcript.delta', response_id: content.completionId, delta: event.textOutput.content });
        }
      }
      if (event.audioOutput) { if (!suppressed) play(event.audioOutput.content); emit({ type: 'response.output_audio.delta' }); }
      if (event.toolUse) {
        const tool = event.toolUse, block = blocks.get(tool.contentId);
        if (block) block.tool = { id: tool.toolUseId, name: tool.toolName, arguments: tool.content };
      }
      if (event.contentEnd) {
        const content = blocks.get(event.contentEnd.contentId);
        if (event.contentEnd.stopReason === 'INTERRUPTED') { clear(); emit({ type: 'input_audio_buffer.speech_started' }); }
        if (content?.role === 'USER' && content.stage === 'FINAL') emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: content.contentId, transcript: content.text });
        if (content?.tool && event.contentEnd.stopReason !== 'INTERRUPTED') emit({ type: 'maid.tools.requested', calls: [content.tool] });
        blocks.delete(event.contentEnd.contentId);
      }
      if (event.completionEnd) {
        emit({ type: 'response.done', response: { id: event.completionEnd.completionId || responseId, status: suppressed || event.completionEnd.stopReason === 'INTERRUPTED' ? 'cancelled' : 'completed' } });
        responseId = '';
      }
      if (event.usageEvent) {
        const u = event.usageEvent, delta = u.details?.delta;
        const input = Number(u.totalInputTokens) || 0, output = Number(u.totalOutputTokens) || 0;
        const usage = delta ? { input_tokens: (delta.input?.speechTokens || 0) + (delta.input?.textTokens || 0), output_tokens: (delta.output?.speechTokens || 0) + (delta.output?.textTokens || 0) }
          : { input_tokens: Math.max(0, input - lastUsage.input), output_tokens: Math.max(0, output - lastUsage.output) };
        lastUsage = { input, output }; emit({ type: 'usage.delta', usage });
      }
    },
  };
};
