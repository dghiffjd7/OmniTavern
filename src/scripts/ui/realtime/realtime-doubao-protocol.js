import { isDoubaoSc2 } from './realtime-provider-catalog.js';
import { t } from '../../i18n/index.js';
import { bytesToBase64, base64ToBytes } from './realtime-pcm-codec.js';
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const encodeDoubaoFrame = (event, payload = {}, sessionId = '') => {
  const audio = payload instanceof Uint8Array;
  const body = audio ? payload : encoder.encode(JSON.stringify(payload));
  const id = encoder.encode(sessionId); const hasSession = event >= 100;
  const buffer = new Uint8Array(12 + body.length + (hasSession ? 4 + id.length : 0));
  buffer.set([0x11, audio ? 0x24 : 0x14, audio ? 0 : 0x10, 0]); const view = new DataView(buffer.buffer);
  view.setUint32(4, event); let offset = 8;
  if (hasSession) { view.setUint32(offset, id.length); offset += 4; buffer.set(id, offset); offset += id.length; }
  view.setUint32(offset, body.length); buffer.set(body, offset + 4); return buffer;
};
export const decodeDoubaoFrame = async bytes => {
  if (bytes.length < 8 || bytes[0] >> 4 !== 1) throw new Error('Invalid Doubao frame');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[1] >> 4, flags = bytes[1] & 15; let offset = (bytes[0] & 15) * 4;
  const int = () => { if (offset + 4 > bytes.length) throw new Error('Truncated Doubao frame'); const value = view.getUint32(offset); offset += 4; return value; };
  const block = () => { const size = int(); if (offset + size > bytes.length) throw new Error('Truncated Doubao payload'); const result = bytes.slice(offset, offset + size); offset += size; return result; };
  const code = type === 15 ? int() : 0;
  if (flags & 1) int();
  const event = flags & 4 ? int() : 0;
  let sessionId = '';
  if (event >= 100 || [50, 51, 52].includes(event)) sessionId = decoder.decode(block());
  let payload = block();
  if ((bytes[2] & 15) === 1) {
    const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'));
    payload = new Uint8Array(await new Response(stream).arrayBuffer());
    if (payload.length > 512 * 1024) throw new Error('Doubao payload too large');
  } else if ((bytes[2] & 15) !== 0) throw new Error('Unsupported Doubao compression');
  return { event, code, sessionId, data: bytes[2] >> 4 === 1 ? JSON.parse(decoder.decode(payload)) : payload };
};
export const buildDoubaoSession = (profile, instructions) => ({
  asr: { audio_info: { format: 'pcm', sample_rate: 16000, channel: 1 } },
  tts: { speaker: profile.voice, audio_config: { format: 'pcm_s16le', sample_rate: 24000, channel: 1 } },
  dialog: { ...(isDoubaoSc2(profile) ? { character_manifest: instructions } : { bot_name: '助手', system_role: instructions }),
    extra: { model: profile.model, enable_volc_websearch: false, enable_conversation_truncate: true } },
});
export const createDoubaoRealtimeProtocol = ({ profile, instructions, sendBinary, emit, ready, play, clear }) => {
  const sessionId = crypto.randomUUID(); let responseId = '', userId = '', userText = '', suppressed = false;
  const send = (event, payload) => sendBinary(bytesToBase64(encodeDoubaoFrame(event, payload, sessionId)));
  const begin = id => { if (id && responseId !== id) { responseId = id; suppressed = false; emit({ type: 'response.created', response: { id } }); } };
  return {
    start: () => send(1, {}), audio: audio => send(200, base64ToBytes(audio)),
    cancel: () => { clear(); suppressed = true; },
    close: () => { send(102, {}); send(2, {}); },
    receive: async bytes => {
      const frame = await decodeDoubaoFrame(bytes), data = frame.data;
      if (frame.code || [51, 153].includes(frame.event)) throw new Error(t('豆包实时语音服务错误（{code}）', { code: frame.code || frame.event }));
      if (frame.event === 50) send(100, buildDoubaoSession(profile, instructions));
      if (frame.event === 150) { emit({ type: 'session.created', session: { id: data.dialog_id || sessionId } }); ready(); }
      if ([52, 152].includes(frame.event)) emit({ type: 'session.ended' });
      if (frame.event === 450) { clear(); userId = data.question_id || crypto.randomUUID(); userText = ''; emit({ type: 'input_audio_buffer.speech_started', item_id: userId }); }
      if (frame.event === 451) { const results = data.results || []; userText = results.map(result => result.text || '').join(''); }
      if (frame.event === 459) {
        emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: userId || crypto.randomUUID(), transcript: userText });
        emit({ type: 'input_audio_buffer.speech_stopped' }); userText = '';
      }
      if (frame.event === 550) { begin(data.reply_id); emit({ type: 'response.output_audio_transcript.delta', response_id: responseId, delta: data.content || '' }); }
      if (frame.event === 350) begin(data.reply_id);
      if (frame.event === 352) { if (!suppressed) play(bytesToBase64(data)); emit({ type: 'response.output_audio.delta' }); }
      if (frame.event === 359) { emit({ type: 'response.done', response: { id: data.reply_id || responseId, status: suppressed ? 'cancelled' : 'completed' } }); responseId = ''; }
      if (frame.event === 154) {
        const u = data.usage || {};
        emit({ type: 'usage.delta', usage: { input_tokens: (u.input_text_tokens || 0) + (u.input_audio_tokens || 0), output_tokens: (u.output_text_tokens || 0) + (u.output_audio_tokens || 0), input_token_details: { text_tokens: u.input_text_tokens, audio_tokens: u.input_audio_tokens }, output_token_details: { text_tokens: u.output_text_tokens, audio_tokens: u.output_audio_tokens } } });
      }
    },
  };
};
