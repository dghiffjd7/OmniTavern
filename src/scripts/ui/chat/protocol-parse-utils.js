import { stripAutoImagePromptTags } from './auto-image-prompt-utils.js';
import { sanitizeThinkingForProtocolParse } from './protocol-thinking-utils.js';

export { sanitizeThinkingForProtocolParse };

export const normalizeMiPhoneMarkers = (text) => {
  const raw = String(text ?? '');
  if (!raw) return raw;
  return raw
    .replace(/&lt;\s*\/?\s*MiPhone_(start|end)\s*\/?\s*&gt;/gi, (_match, token) => `MiPhone_${token}`)
    .replace(/<\s*\/?\s*MiPhone_(start|end)\s*\/?\s*>/gi, (_match, token) => `MiPhone_${token}`);
};

export const extractMiPhoneBlock = (text) => {
  const raw = String(text ?? '');
  const startRe = /<\s*MiPhone_start\s*>|MiPhone_start/i;
  const endRe = /<\s*MiPhone_end\s*>|MiPhone_end/gi;
  const start = startRe.exec(raw);
  if (!start) return '';
  const afterStart = raw.slice(start.index + start[0].length);
  let end;
  let endIdx = -1;
  while ((end = endRe.exec(afterStart))) {
    endIdx = start.index + start[0].length + end.index + end[0].length;
  }
  // Keep following shells available: only the parser can tell whether an
  // earlier shell contains a usable event. It still stops at the first valid one.
  return endIdx === -1 ? raw.slice(start.index) : raw.slice(start.index, endIdx);
};

export const buildProtocolRetryCandidates = (text) => {
  const retryText = sanitizeThinkingForProtocolParse(text);
  const miPhoneText = normalizeMiPhoneMarkers(retryText);
  const miPhoneBlock = extractMiPhoneBlock(miPhoneText);
  return {
    retryText,
    miPhoneText,
    miPhoneBlock,
  };
};

export const normalizeProtocolChatMessage = (
  message,
  { normalizeSpeaker = value => String(value || '').trim() } = {},
) => ({
  speaker: typeof normalizeSpeaker === 'function'
    ? normalizeSpeaker(message?.speaker)
    : String(message?.speaker || '').trim(),
  rawContent: String(message?.content || '').replace(/<br\s*\/?>/gi, '\n'),
  content: stripAutoImagePromptTags(String(message?.content || '').replace(/<br\s*\/?>/gi, '\n')),
  time: String(message?.time || '').trim(),
});

export const buildProtocolSystemMetaMessage = ({
  content = '',
  time = '',
  fallbackTime = '',
  name = '系统',
  sanitizeContent = value => String(value ?? ''),
} = {}) => ({
  role: 'system',
  type: 'meta',
  content: typeof sanitizeContent === 'function'
    ? sanitizeContent(content)
    : String(content ?? ''),
  name: String(name || '系统'),
  time: String(time || fallbackTime || '').trim(),
});
