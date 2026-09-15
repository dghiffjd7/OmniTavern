import { normalizeProviderToolCallDeltas } from '../agent/provider-tool-call-delta-adapter.js';
import { isReasoningStreamEvent } from '../api/native-reasoning.js';

const clone = value => JSON.parse(JSON.stringify(value));
const bodyKeys = ['temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'seed', 'n',
  'frequency_penalty', 'presence_penalty', 'stop', 'parallel_tool_calls', 'reasoning_effort', 'thinking'];
const abortError = () => Object.assign(new Error('生成已取消'), { name: 'AbortError' });

export function isCreativePresetRequest({ presetContext, context = {}, purpose = 'reply' } = {}) {
  return presetContext?.uiMode === 'rp'
    && ['reply', 'script_generate'].includes(purpose)
    && !context.task?.type && context.meta?.skipScripts !== true
    && context.meta?.maidTriggered !== true;
}

const family = provider => ['gemini', 'makersuite', 'vertexai'].includes(provider)
  ? 'gemini' : provider === 'anthropic' ? 'anthropic' : 'openai';
const canonicalTools = tools => (Array.isArray(tools) ? tools : []).flatMap(tool => {
  if (Array.isArray(tool.functionDeclarations)) return tool.functionDeclarations.map(fn => ({ type: 'function', function: fn }));
  if (tool.input_schema) return [{ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.input_schema,
  } }];
  return [tool];
});

export function makePresetRequestBody(messages, options, config, stream) {
  const body = { messages: clone(messages), model: config.model, stream,
    chat_completion_source: config.provider || 'openai' };
  for (const key of bodyKeys) if (options[key] !== undefined) body[key] = clone(options[key]);
  if (options.tools) body.tools = canonicalTools(clone(options.tools));
  if (options.tool_choice !== undefined) {
    const choice = options.tool_choice;
    body.tool_choice = family(config.provider) === 'anthropic' && typeof choice === 'object'
      ? choice.type === 'tool' ? { type: 'function', function: { name: choice.name } }
        : choice.type === 'any' ? 'required' : choice.type
      : clone(choice);
  }
  const choice = options.toolConfig?.functionCallingConfig;
  if (choice) body.tool_choice = choice.mode === 'NONE' ? 'none' : choice.mode === 'ANY'
    ? (choice.allowedFunctionNames?.length === 1
        ? { type: 'function', function: { name: choice.allowedFunctionNames[0] } } : 'required') : 'auto';
  return body;
}

export function applyPresetRequestBody(body, originalOptions, config) {
  const options = { ...originalOptions };
  for (const key of bodyKeys) {
    if (Object.hasOwn(body, key)) options[key] = clone(body[key]);
    else delete options[key];
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const providerFamily = family(config.provider);
  if (providerFamily === 'anthropic') {
    options.tools = tools.map(tool => tool.function ? {
      name: tool.function.name, description: tool.function.description,
      input_schema: tool.function.parameters,
    } : tool);
    const choice = body.tool_choice;
    options.tool_choice = typeof choice === 'object' && choice?.function?.name
      ? { type: 'tool', name: choice.function.name }
      : typeof choice === 'string' ? { type: choice === 'required' ? 'any' : choice } : choice;
  } else if (providerFamily === 'gemini') {
    options.tools = tools.filter(tool => !tool.function);
    const declarations = tools.filter(tool => tool.function).map(tool => tool.function);
    if (declarations.length) options.tools.push({ functionDeclarations: declarations });
    if (body.tool_choice !== undefined) options.toolConfig = { functionCallingConfig: {
      mode: body.tool_choice === 'none' ? 'NONE' : body.tool_choice === 'required' || typeof body.tool_choice === 'object' ? 'ANY' : 'AUTO',
      ...(body.tool_choice?.function?.name ? { allowedFunctionNames: [body.tool_choice.function.name] } : {}),
    } };
    delete options.tool_choice;
  } else {
    options.tools = tools;
    if (body.tool_choice !== undefined) options.tool_choice = body.tool_choice;
    else delete options.tool_choice;
  }
  if (!options.tools?.length) { delete options.tools; delete options.tool_choice; delete options.toolConfig; }
  return { messages: clone(body.messages), options };
}

function makeQueue() {
  const values = [];
  let wake, ended = false, error = null;
  return {
    push(value) { if (!ended) { values.push(value); wake?.(); wake = null; } },
    end(reason) { ended = true; error = reason || null; wake?.(); wake = null; },
    async *read() {
      for (;;) {
        if (values.length) { yield values.shift(); continue; }
        if (ended) { if (error) throw error; return; }
        await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

// Only serializable request data enters the Worker; connection URLs, credentials,
// native request IDs, abort signals and provider callbacks stay with the host.
export class PresetRequestTransport {
  constructor({ post, onTimeout }) { this.post = post; this.onTimeout = onTimeout; this.jobs = new Map(); this.seq = 0; }
  async prepare(payload, { signal, timeoutMs = 15000 } = {}) {
    if (signal?.aborted) throw abortError();
    const id = 'pr_' + Date.now().toString(36) + '_' + (++this.seq);
    const queue = makeQueue();
    let resolvePrepared, rejectPrepared;
    const prepared = new Promise((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
    const job = { id, queue, resolvePrepared, rejectPrepared, ready: false, closed: false };
    const dispose = (error = abortError()) => {
      if (job.closed) return;
      this.post({ type: 'preset_request', id, event: 'cancel', error: error.message });
      this.finish(job, error);
    };
    job.dispose = dispose;
    job.cleanup = () => { clearTimeout(job.timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => dispose(abortError());
    const arm = () => {
      clearTimeout(job.timer);
      job.timer = setTimeout(() => {
        dispose(new Error('预设请求脚本执行超时'));
        this.onTimeout?.();
      }, timeoutMs);
    };
    this.jobs.set(id, job);
    signal?.addEventListener('abort', onAbort, { once: true });
    arm();
    this.post({ ...payload, type: 'preset_request', id, event: 'start' });
    const result = await prepared;
    if (payload.preview || result.bypass) dispose();
    return {
      ...result, dispose,
      read: () => queue.read(),
      data: data => { if (!job.closed) this.post({ type: 'preset_request', id, event: 'data', data }); },
      end: () => { if (!job.closed) { arm(); this.post({ type: 'preset_request', id, event: 'end' }); } },
      get closed() { return job.closed; },
    };
  }
  finish(job, error) {
    if (job.closed) return;
    job.closed = true; job.cleanup(); this.jobs.delete(job.id);
    if (!job.ready) job.rejectPrepared(error || new Error('预设请求未完成准备'));
    job.queue.end(error);
  }
  handle(msg) {
    if (msg.type !== 'preset_request') return false;
    const job = this.jobs.get(msg.id);
    if (!job) return true;
    if (msg.event === 'prepared') {
      job.ready = true; clearTimeout(job.timer);
      job.resolvePrepared({ body: msg.body, bypass: msg.bypass === true });
    } else if (msg.event === 'chunk') job.queue.push(msg.value);
    else if (msg.event === 'done') this.finish(job);
    else if (msg.event === 'error') this.finish(job, new Error(msg.error || '预设请求处理失败'));
    return true;
  }
  reset(error = new Error('脚本运行器已重启')) { for (const job of this.jobs.values()) this.finish(job, error); }
}

// Convert provider tool deltas to an OpenAI-compatible virtual response for
// legacy interceptors. Providers retain ownership of HTTP, usage and reasoning.
function makeToolPackets(config, emit) {
  const calls = [];
  const byId = new Map(), byIndex = new Map();
  return {
    push(raw, meta) {
      for (const delta of normalizeProviderToolCallDeltas(raw, { ...config, ...meta })) {
        if (delta.all) continue;
        const id = delta.toolCallId || delta.id;
        let call = (id && byId.get(id)) || byIndex.get(delta.index);
        if (!call && !delta.toolName && !delta.argumentsDelta) continue;
        if (!call || (delta.toolName && call.name && delta.toolName !== call.name)) {
          call = { index: calls.length, id: id || 'preset_call_' + calls.length, name: '', text: '', started: false };
          calls.push(call);
        }
        if (id) byId.set(id, call);
        byIndex.set(delta.index, call);
        call.name ||= delta.toolName;
        if (call.name && !call.started) {
          call.started = true;
          emit({ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } });
        }
        let text = delta.argumentsText;
        // Anthropic's empty input at block start is a placeholder, not a prefix.
        if (delta.phase === 'start' && text === '{}') text = '';
        if (text && text.startsWith(call.text)) {
          const suffix = text.slice(call.text.length); call.text = text;
          if (suffix) emit({ index: call.index, function: { arguments: suffix } });
        } else if (text && text !== call.text) throw new Error('供应方修改了已输出的工具参数');
        if (delta.argumentsDelta) {
          call.text += delta.argumentsDelta;
          emit({ index: call.index, function: { arguments: delta.argumentsDelta } });
        }
      }
    },
    complete() { return calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.text } })); },
  };
}

export function createPresetGenerationClient({ client, session, config }) {
  if (!session || session.bypass) return client;
  const packet = delta => session.data('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n');
  return {
    prepareChatRequest: (...args) => client.prepareChatRequest?.(...args),
    async chat(messages, options) {
      const tools = makeToolPackets(config, () => {});
      let toolError;
      let geminiResponse;
      // No virtual response is sent until the provider succeeds. Existing host
      // retries can reuse the prepared request without running preset code again.
      const content = await client.chat(messages, { ...options, onProviderToolCallDelta: (raw, meta) => {
        if (Array.isArray(raw?.candidates)) { geminiResponse = raw; return; }
        try { tools.push(raw, meta); } catch (error) { toolError = error; }
      } });
      if (toolError) throw toolError;
      session.data(JSON.stringify(geminiResponse || { choices: [{ message: { role: 'assistant', content, tool_calls: tools.complete() } }] }));
      session.end();
      let result = '';
      for await (const value of session.read()) if (typeof value === 'string') result += value;
      return result;
    },
    async *streamChat(messages, options) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      const tools = makeToolPackets(config, call => packet({ tool_calls: [call] }));
      let toolError;
      let geminiRaw = false;
      const pump = (async () => {
        try {
          for await (const value of client.streamChat(messages, { ...options, signal: controller.signal,
            onProviderToolCallDelta: (raw, meta) => {
              if (Array.isArray(raw?.candidates)) {
                geminiRaw = true;
                session.data('data: ' + JSON.stringify(raw) + '\n\n'); return;
              }
              try { tools.push(raw, meta); } catch (error) { toolError = error; controller.abort(); }
            } })) {
            if (toolError) throw toolError;
            if (geminiRaw) continue;
            if (typeof value === 'string') packet({ content: value });
            else if (isReasoningStreamEvent(value)) packet({ reasoning_content: value.text, __chatapp_reasoning: value });
          }
          if (toolError) throw toolError;
          session.data('data: [DONE]\n\n'); session.end();
        } catch (error) { session.dispose(toolError || error); }
      })();
      try { yield* session.read(); }
      finally { controller.abort(); options.signal?.removeEventListener('abort', abort); session.dispose(); void pump; }
    },
  };
}
