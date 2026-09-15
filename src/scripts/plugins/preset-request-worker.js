// Serialized into ScriptRuntime's existing Worker. User processors and fetch
// middleware run here, never in the application window or a provider client.
export function createPresetRequestWorker({ send, getFetch, getBaseFetch, getContext,
  waitUntilReady = async () => {}, dispatch = async (_event, data) => data }) {
  const jobs = new Map();
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = value => value instanceof Error ? value : new Error(String(value || '预设请求处理失败'));
  const emit = (job, event, data = {}) => send({ type: 'preset_request', id: job.id, event, ...data });
  const compile = (source, label) => {
    const fn = new Function('return (' + String(source || '').trim().replace(/;\s*$/, '') + '\n)')();
    if (typeof fn !== 'function') throw new Error(label + '必须是函数');
    return fn;
  };
  const normalizeTool = tool => {
    if (!tool || typeof tool.name !== 'string' || !/^[\w.-]{1,128}$/.test(tool.name)) {
      throw new Error('预设工具缺少有效名称');
    }
    return { type: 'function', function: {
      name: tool.name, description: String(tool.description || ''),
      parameters: copy(tool.parameters || { type: 'object', properties: {} }),
    } };
  };
  const prepareSPreset = async (body, preset, settings) => {
    const squash = settings.ChatSquash || {};
    // ChatSquash's message postprocessor also runs when merging is disabled.
    if (squash.enabled === true) throw new Error('此预设启用了尚未兼容的 SPreset 聊天合并；请关闭合并后重试');
    if (squash.squashed_post_script_enable === true) {
      const process = compile(squash.squashed_post_script, '预设消息后处理');
      const value = await process(body.messages);
      if (value !== undefined) {
        if (!Array.isArray(value)) throw new Error('预设消息后处理必须返回消息数组');
        body.messages = value;
      }
    }
    const order = (preset.prompt_order || []).find(item => Number(item.character_id) === 100001)
      || (preset.prompt_order || []).at(-1);
    const enabled = new Set((order?.order || preset.prompts || [])
      .filter(item => item.enabled !== false).map(item => String(item.identifier || item.id || '')));
    const tools = Array.isArray(body.tools) ? body.tools.slice() : [];
    const names = new Set(tools.map(item => item.function?.name));
    for (const [id, binding] of Object.entries(settings.ToolBindings || {})) {
      if (binding.enabled !== true || binding.valid !== true || !enabled.has(id)) continue;
      const definition = new Function(String(binding.code || ''))();
      const tool = normalizeTool(definition);
      if (names.has(tool.function.name)) continue;
      names.add(tool.function.name);
      tools.push(tool);
    }
    if (tools.length) {
      body.tools = tools;
      body.tool_choice ??= 'auto';
    }
    return body;
  };
  const makeOutputProcessor = (settings, stream) => {
    if (settings?.enabled !== true) return async chunk => String(chunk || '');
    const process = compile(settings.script, '预设输出预处理');
    let hold = '', output = '', raw = '', state = {};
    return async (chunk = '', final = false) => {
      raw += chunk;
      const result = await process({ buffer: hold + chunk, chunk, hold, output, raw, state,
        final, stream, channel: 'main' });
      let text;
      if (typeof result === 'string') { text = result; hold = ''; }
      else if (result && typeof result === 'object') {
        const key = ['output', 'emit', 'text', 'content'].find(key => Object.hasOwn(result, key));
        if (!key) throw new Error('预设输出预处理缺少 output');
        text = String(result[key] ?? '');
        hold = String(result.hold ?? '');
        if (result.state !== undefined) state = result.state;
      } else throw new Error('预设输出预处理必须返回字符串或 { output, hold }');
      if (final) { text += hold; hold = ''; }
      output += text;
      return text;
    };
  };
  const argumentText = value => {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length === 1 && typeof parsed[keys[0]] === 'string') return parsed[keys[0]];
    }
    return JSON.stringify(parsed);
  };
  const consumeResponse = async (job, response) => {
    if (!response?.ok) throw new Error('预设请求失败：HTTP ' + (response?.status || 0));
    const settings = job.spreset?.OutputPreprocessing || {};
    const process = makeOutputProcessor(settings, job.stream);
    const calls = new Map();
    let rawText = '';
    const reasoningEvent = text => ({ __chatappStream: true, kind: 'reasoning', text,
      hidden: false, label: '', provider: job.provider?.provider || '' });
    const output = async (text, final = false) => {
      const value = await process(text, final);
      if (value) emit(job, 'chunk', { value });
    };
    const packet = async data => {
      if (Array.isArray(data?.candidates)) {
        const parts = data.candidates[0]?.content?.parts || [];
        for (const [index, part] of parts.entries()) {
          if (typeof part.text === 'string') {
            if (part.thought) emit(job, 'chunk', { value: reasoningEvent(part.text) });
            else { rawText += part.text; await output(part.text); }
          }
          if (!part.functionCall) continue;
          const call = part.functionCall;
          const key = call.id || 'gemini:' + index;
          const current = calls.get(key) || { id: call.id || '', name: call.name || '', arguments: '', partial: {} };
          if (Array.isArray(call.partialArgs)) for (const fragment of call.partialArgs) {
            const path = /^\$\.([\w]+)$/.exec(String(fragment.jsonPath || ''));
            if (!path) throw new Error('预设正文工具暂不支持此 Gemini 参数路径：' + fragment.jsonPath);
            if (typeof fragment.stringValue === 'string') current.partial[path[1]] = (current.partial[path[1]] || '') + fragment.stringValue;
          }
          if (Object.keys(current.partial).length) current.arguments = JSON.stringify(current.partial);
          if (call.args && Object.keys(call.args).length) current.arguments = JSON.stringify(call.args);
          calls.set(key, current);
        }
        return;
      }
      const choice = data?.choices?.[0];
      const message = choice?.delta || choice?.message || {};
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) { rawText += text; await output(text); }
      const reasoning = message.reasoning_content || message.reasoning;
      if (typeof reasoning === 'string' && reasoning) emit(job, 'chunk', { value: message.__chatapp_reasoning || reasoningEvent(reasoning) });
      for (const [ordinal, call] of (message.tool_calls || []).entries()) {
        const index = call.index ?? ordinal;
        const current = calls.get(index) || { id: call.id || '', name: '', arguments: '' };
        current.id ||= call.id || '';
        current.name ||= call.function?.name || '';
        current.arguments += call.function?.arguments || '';
        calls.set(index, current);
      }
    };
    if (job.stream && response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const event = async text => {
        const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
        if (data && data !== '[DONE]') await packet(JSON.parse(data));
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            await event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
          }
          if (done) break;
        }
        if (buffer.trim()) await event(buffer);
      } finally { reader.releaseLock(); }
    } else await packet(await response.json());
    if (calls.size) {
      if (settings.enabled !== true || settings.consumeToolCalls !== true) {
        throw new Error('预设返回了未还原为正文的工具调用，请检查防截断脚本是否启用');
      }
      const list = [...calls.values()];
      let text = list.map(call => argumentText(call.arguments)).join('\n');
      if (settings.toolCallFormatter?.enabled === true) {
        const result = await compile(settings.toolCallFormatter.script, '工具调用格式化')({
          calls: list.map(call => ({ ...call, arguments: JSON.parse(call.arguments) })),
          defaultText: text, stream: job.stream, final: true, channel: 'main', provider: job.provider,
        });
        text = typeof result === 'string' ? result : result?.output ?? result?.text ?? result?.content;
        if (typeof text !== 'string') throw new Error('工具调用格式化必须返回正文');
      }
      await output((rawText && text && !rawText.endsWith('\n') ? '\n' : '') + text);
    }
    await output('', true);
  };
  const finish = (job, error) => {
    if (!jobs.has(job.id)) return;
    jobs.delete(job.id);
    if (error) {
      job.abort.abort();
      try { job.input?.error(fail(error)); } catch {}
      emit(job, 'error', { error: String(error.message || error) });
    } else emit(job, 'done');
  };
  const interceptFetch = (input, init = {}) => {
    const url = String(input?.url || input || '');
    const token = /[?&]chatapp_request=([^&]+)/.exec(url)?.[1];
    if (!token || !jobs.has(token)) return null;
    const job = jobs.get(token);
    return (async () => {
      if (job.prepared) throw new Error('预设重复提交了同一个生成请求');
      // This host-issued job processes a request already authorized by the user.
      // Arbitrary fetch calls still pass guardedFetch's network permission gate.
      const raw = typeof init.body === 'string' ? init.body : await input.clone().text();
      if (raw.length > 1200000) throw new Error('预设请求体过大');
      const body = JSON.parse(raw);
      if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('预设请求缺少 messages');
      job.prepared = true;
      const response = new Response(new ReadableStream({ start(controller) { job.input = controller; } }), {
        headers: { 'content-type': job.stream ? 'text/event-stream' : 'application/json' },
      });
      emit(job, 'prepared', { body });
      return response;
    })();
  };
  const start = async msg => {
    const job = { ...msg, abort: new AbortController(), prepared: false };
    jobs.set(job.id, job);
    try {
      await waitUntilReady();
      if (!jobs.has(job.id)) return;
      const context = getContext();
      if (context.sessionId !== msg.sessionId || context.openaiPresetId !== msg.presetId) {
        throw new Error('会话或预设已切换，请重新发起生成');
      }
      const middleware = getFetch(); // Freeze this request's chain before any await.
      const hasSettings = msg.spreset && Object.keys(msg.spreset).length > 0;
      if (!hasSettings && middleware === getBaseFetch()) {
        emit(job, 'prepared', { body: msg.body, bypass: true });
        finish(job); return;
      }
      let body = copy(msg.body);
      const ready = await dispatch('chat_completion_prompt_ready', { args: [{ chat: body.messages, dryRun: Boolean(job.preview) }] });
      body.messages = ready?.args?.[0]?.chat || body.messages;
      if (hasSettings) body = await prepareSPreset(body, msg.preset || {}, msg.spreset);
      const settingsReady = await dispatch('chat_completion_settings_ready', { args: [body] });
      body = settingsReady?.args?.[0] || body;
      const response = await middleware('/api/backends/chat-completions/generate?chatapp_request=' + job.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: job.abort.signal,
      });
      if (!job.prepared) throw new Error('预设拦截器未提交生成请求');
      if (job.preview) { finish(job); try { await response.body?.cancel(); } catch {} return; }
      await consumeResponse(job, response);
      finish(job);
    } catch (error) { finish(job, fail(error)); }
  };
  return {
    interceptFetch,
    handle(msg) {
      if (msg.type !== 'preset_request') return false;
      if (msg.event === 'start') { void start(msg); return true; }
      const job = jobs.get(msg.id);
      if (!job) return true;
      if (msg.event === 'cancel' || msg.event === 'error') finish(job, new Error(msg.error || '生成已取消'));
      else if (msg.event === 'data') {
        try { job.input.enqueue(new TextEncoder().encode(msg.data)); }
        catch (error) { finish(job, error); }
      } else if (msg.event === 'end') { try { job.input.close(); } catch {} }
      return true;
    },
  };
}
