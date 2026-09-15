const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Inspect only text which the protocol parser has not consumed yet. A complete
// chat/moment payload is opaque here: quoted thinking tags belong to its body.
// Keep unfinished thinking separately so streamed examples cannot select a shell.
export const splitProtocolThinking = (text, {
  allowOrphanClose = true,
  resolveLooseGroupTag = null,
  resolveLoosePrivateTag = null,
} = {}) => {
  const raw = String(text ?? '');
  const tokens = /<\s*(\/?)\s*([^<>]*?)\s*>|\b(moment_reply|moment)_(start|end)\b/gi;
  let output = '';
  let cursor = 0;
  let token;
  while ((token = tokens.exec(raw))) {
    const closing = Boolean(token[1]);
    const tagName = String(token[2] || '').trim();
    const thinking = closing
      ? /^(think|thinking)$/i.exec(tagName)
      : /^(think|thinking)(?:\s[^<>]*)?$/i.exec(tagName);
    if (thinking && !/\/\s*$/.test(tagName)) {
      if (closing) {
        // Some presets prefill the opening tag, so only the closing tag is
        // returned. This is handled before capture, outside message payloads.
        if (allowOrphanClose) {
          output = '';
          cursor = tokens.lastIndex;
        }
      } else {
        output += raw.slice(cursor, token.index);
        const closeRe = new RegExp(`<\\s*\\/\\s*${thinking[1]}\\s*>`, 'gi');
        closeRe.lastIndex = tokens.lastIndex;
        const close = closeRe.exec(raw);
        if (!close) return { text: output, pendingThinking: raw.slice(token.index) };
        cursor = closeRe.lastIndex;
        tokens.lastIndex = cursor;
      }
      continue;
    }

    const isChatTag = tagName && !closing && (
      tagName.endsWith('的私聊') ||
      /^(?:private_chat|group_chat|群聊)\s*[:：]/i.test(tagName) ||
      resolveLooseGroupTag?.(tagName) || resolveLoosePrivateTag?.(tagName)
    );
    const isMomentStart = token[3] && token[4].toLowerCase() === 'start';
    if (!isChatTag && !isMomentStart) continue;
    const closeRe = isChatTag
      ? new RegExp(`<\\s*\\/\\s*${escapeRegExp(tagName)}\\s*>`, 'gi')
      : new RegExp(`\\b${token[3]}_end\\b`, 'gi');
    closeRe.lastIndex = tokens.lastIndex;
    const close = closeRe.exec(raw);
    // The parser also waits for this payload to close. Leave it untouched and
    // inspect it again together with the next chunk, including its opening tag.
    if (!close) break;
    tokens.lastIndex = closeRe.lastIndex;
  }
  return { text: output + raw.slice(cursor), pendingThinking: '' };
};

export const sanitizeThinkingForProtocolParse = text => splitProtocolThinking(text).text;
