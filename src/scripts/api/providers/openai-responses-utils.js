const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

export const extractOpenAIResponsesText = (data = {}) => {
  if (typeof data?.output_text === 'string') return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  return output
    .filter(item => trim(item?.type) === 'message')
    .flatMap(item => (Array.isArray(item?.content) ? item.content : []))
    .map(part => part?.type === 'refusal' ? part.refusal : (part?.type === 'output_text' ? part.text : ''))
    .filter(text => typeof text === 'string')
    .join('');
};

const toOpenAIResponsesContent = (content, role = 'user') => {
  if (!Array.isArray(content)) return String(content ?? '');
  return content.flatMap((part) => {
    if (!isPlainObject(part)) return [];
    const type = trim(part.type);
    if (type === 'input_text' || type === 'input_image' || type === 'output_text') return [clone(part)];
    if (type === 'text') {
      return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: String(part.text || '') }];
    }
    if (type === 'image_url') {
      const imageUrl = trim(part?.image_url?.url || part?.image_url);
      if (!imageUrl) return [];
      return [{
        type: 'input_image',
        image_url: imageUrl,
        ...(trim(part?.image_url?.detail) ? { detail: trim(part.image_url.detail) } : {}),
      }];
    }
    return [];
  });
};

export const toOpenAIResponsesInput = (messages = []) => (
  (Array.isArray(messages) ? messages : []).flatMap(message => {
    if (!isPlainObject(message)) return [];
    // Native continuation items include reasoning/encrypted content and call IDs.
    if (['reasoning', 'function_call', 'function_call_output', 'item_reference'].includes(trim(message.type))) {
      return [clone(message)];
    }
    const role = trim(message.role);
    if (!role) return [];
    if (role === 'tool') {
      const callId = trim(message.tool_call_id);
      if (!callId) throw new Error('工具结果缺少 tool_call_id');
      return [{ type: 'function_call_output', call_id: callId,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') }];
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const content = toOpenAIResponsesContent(message.content, role);
    const items = toolCalls.length && !content?.length ? [] : [{ role, content }];
    for (const call of toolCalls) {
      const callId = trim(call?.id || call?.call_id);
      if (!callId) throw new Error('工具调用缺少 call_id');
      const fn = isPlainObject(call.function) ? call.function : call;
      items.push({ type: 'function_call', call_id: callId, name: trim(fn.name),
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}) });
    }
    return items;
  })
);

export const toOpenAIResponsesTools = (tools = []) => (
  (Array.isArray(tools) ? tools : []).flatMap((tool) => {
    if (!isPlainObject(tool)) return [];
    const type = trim(tool.type);
    if (type === 'web_search' || type === 'web_search_preview') return [clone(tool)];
    if (trim(tool.type) === 'function' && trim(tool.name)) return [{ ...clone(tool), strict: tool.strict === true }];
    const fn = isPlainObject(tool.function) ? tool.function : {};
    if (trim(tool.type) !== 'function' || !trim(fn.name)) return [];
    return [{
      type: 'function',
      name: trim(fn.name),
      description: trim(fn.description, trim(fn.name)),
      parameters: isPlainObject(fn.parameters)
        ? clone(fn.parameters)
        : { type: 'object', properties: {} },
      strict: fn.strict === true,
    }];
  })
);

export const buildOpenAIResponsesOptions = (options = {}) => {
  const source = isPlainObject(options) ? options : {};
  const out = {};
  const maxOutputTokens = source.max_output_tokens ?? source.max_completion_tokens
    ?? source.max_tokens ?? source.maxTokens;
  if (Number.isFinite(maxOutputTokens)) out.max_output_tokens = Math.max(1, Math.trunc(maxOutputTokens));
  if (Number.isFinite(source.temperature)) out.temperature = source.temperature;
  if (Number.isFinite(source.top_p)) out.top_p = source.top_p;
  const toolChoice = source.tool_choice ?? source.toolChoice;
  if (toolChoice !== undefined) {
    out.tool_choice = toolChoice?.type === 'function' && toolChoice?.function?.name
      ? { type: 'function', name: toolChoice.function.name }
      : clone(toolChoice);
  }
  if (typeof source.parallel_tool_calls === 'boolean') out.parallel_tool_calls = source.parallel_tool_calls;
  if (Number.isFinite(source.max_tool_calls)) out.max_tool_calls = Math.max(1, Math.trunc(source.max_tool_calls));
  if (Array.isArray(source.include)) {
    const include = source.include.map(item => trim(item)).filter(Boolean);
    if (include.length) out.include = [...new Set(include)];
  }
  const tools = toOpenAIResponsesTools(source.tools);
  if (tools.length) out.tools = tools;
  if (isPlainObject(source.reasoning)) out.reasoning = clone(source.reasoning);
  else if (trim(source.reasoning_effort)) out.reasoning = { effort: trim(source.reasoning_effort) };
  if (isPlainObject(source.text)) out.text = clone(source.text);
  if (isPlainObject(source.response_format) && !out.text?.format) {
    const format = source.response_format;
    out.text = { ...out.text, format: format.type === 'json_schema'
      ? { type: 'json_schema', ...clone(format.json_schema || {}) }
      : clone(format) };
  }
  return out;
};

export const buildOpenAIResponsesRequestBody = ({
  model = '',
  messages = [],
  input = [],
  options = {},
  stream = false,
} = {}) => ({
  model: trim(model),
  input: [...toOpenAIResponsesInput(messages), ...(Array.isArray(input) ? clone(input) : [])],
  stream: stream === true,
  store: false,
  ...buildOpenAIResponsesOptions(options),
});
