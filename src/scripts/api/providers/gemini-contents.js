// Gemini 格式（Vertex AI／Gemini／AI Studio）共用：把 OpenAI 格式的非 system 消息接到 contents 上。
// assistant 的 tool_calls → functionCall，tool 结果 → functionResponse（连续的结果合在同一个回合，名称按 tool_call_id 对回）。
// 新版 Gemini 会检查历史里函数调用的 thoughtSignature；预设写好的示范调用没有签名，
// 用官方文件给的占位签名跳过检查，模型自己产生、带着签名的照原样送回。

export const GEMINI_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const textOf = (content) => {
  if (Array.isArray(content)) {
    return content.map(part => (part?.type === 'text' ? String(part.text || '') : '')).filter(Boolean).join('\n');
  }
  return String(content ?? '');
};

const parseArguments = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(String(raw ?? ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

// 消息全是 system 时（预设脚本把其余内容都搬进了工具说明），最后一条留在 contents 当 user 回合：
// Gemini 要求 contents 至少一条，酒馆同样至少保留一条消息不移进系统指令。
export const geminiSystemKeptInContents = messages => (
  messages.length && messages.every(msg => msg?.role === 'system') ? messages[messages.length - 1] : null
);

/** toGeminiParts(content) → parts：各 provider 自己的文字／图片转换。 */
export const createGeminiContentsBuilder = (toGeminiParts) => {
  const contents = [];
  const toolNames = new Map();
  const append = (msg) => {
    if (msg.role === 'tool') {
      const name = String(toolNames.get(String(msg.tool_call_id || '')) || msg.name || 'tool');
      const part = { functionResponse: { name, response: { name, content: textOf(msg.content) } } };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts.length && last.parts.every(item => item.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      return;
    }
    const parts = toGeminiParts(msg.content);
    const calls = msg.role === 'assistant' && Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(call => call?.function?.name || call?.name) : [];
    if (!calls.length) {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
      return;
    }
    const callParts = calls.map((call) => {
      const name = String(call.function?.name || call.name);
      if (call.id) toolNames.set(String(call.id), name);
      return {
        functionCall: { name, args: parseArguments(call.function?.arguments ?? call.arguments) },
        thoughtSignature: String(call.thoughtSignature || call.signature || '') || GEMINI_SKIP_THOUGHT_SIGNATURE,
      };
    });
    const kept = parts.filter(part => part.inlineData || String(part.text || '').trim());
    contents.push({ role: 'model', parts: [...kept, ...callParts] });
  };
  return { contents, append };
};
