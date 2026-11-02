// Serialized into ScriptRuntime's existing Worker. User processors and fetch
// middleware run here, never in the application window or a provider client.
export function createPresetRequestWorker({ send, getFetch, getBaseFetch, getContext,
  waitUntilReady = async () => {}, dispatch = async (_event, data) => data, substitute = text => text }) {
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
  // SPreset ChatSquash（聊天合并）：行为对照上游 inject.js，独立实现。
  // 依赖酒馆内部结构的三项先不支持，遇到时明确报错，不发出与预设设计不同的请求。
  const squashUnsupported = { separate_chat_history: '仅合并聊天记录', parse_clewd: '解析 clewd 标记', re_split: '重新拆分提示词' };
  const isPlainTextPart = part => typeof part === 'string' || (part?.type === 'text' && typeof part.text === 'string'
    && Object.keys(part).every(key => key === 'type' || key === 'text'));
  // 角色之外带其他字段、带图片等非文字段的消息保持原样，不并进文字
  const isNativeSquashMessage = (message, roles) => !roles.includes(message.role)
    || Object.keys(message).some(key => key !== 'role' && key !== 'content' && message[key] != null)
    || (Array.isArray(message.content) && !message.content.every(isPlainTextPart))
    || (message.content != null && typeof message.content === 'object' && !Array.isArray(message.content));
  const removeSquashTag = (messages, tag) => {
    let found = false;
    const strip = value => {
      if (typeof value === 'string') {
        if (!value.includes(tag)) return value;
        found = true;
        return value.split(tag).join('');
      }
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = strip(value[key]);
      return value;
    };
    for (const message of messages) if (message && Object.hasOwn(message, 'content')) message.content = strip(message.content);
    return found;
  };
  const squashSPresetMessages = async (messages, squash) => {
    // 开了条件合并时，prompt 里要有目标标签才合并（标签本身移除）
    if (squash.conditional_enabled === true) {
      const tag = String(squash.conditional_tag || '');
      if (!tag || !removeSquashTag(messages, tag)) return messages;
    }
    const unsupported = Object.keys(squashUnsupported).filter(key => squash[key] === true).map(key => squashUnsupported[key]);
    if (unsupported.length) throw new Error('此预设的 SPreset 聊天合并用到了尚未支持的选项：' + unsupported.join('、') + '；请换用其他预设');
    const affix = {
      user: [substitute(squash.user_prefix || ''), substitute(squash.user_suffix || '')],
      assistant: [substitute(squash.char_prefix || ''), substitute(squash.char_suffix || '')],
      system: [substitute(squash.prefix_system || ''), substitute(squash.suffix_system || '')],
    };
    const roles = Object.keys(affix);
    const follow = squash.role === 'follow';
    let squashRole = follow ? (messages[0]?.role || 'user') : (squash.role || 'assistant');
    const separator = squash.enable_squashed_separator === true && squash.squashed_separator_string
      ? (squash.squashed_separator_regex === true ? new RegExp(squash.squashed_separator_string) : String(squash.squashed_separator_string))
      : null;
    const dropSeparator = text => (separator ? text.replace(separator, '') : text);
    const hasSeparator = text => (separator instanceof RegExp ? separator.test(text) : Boolean(separator) && text.includes(separator));
    const process = squash.squashed_post_script_enable === true ? compile(squash.squashed_post_script, '合并后处理') : null;
    const output = [];
    let merged = '', lastRole = '';
    const flush = async () => {
      if (!merged) return;
      let text = merged + (lastRole ? affix[lastRole][1] : '');
      if (process) {
        text = await process(text);
        if (typeof text !== 'string') throw new Error('合并后处理必须返回文字');
      }
      output.push({ role: squashRole, content: text });
      merged = ''; lastRole = '';
    };
    // 单独成条：先收尾前面合并的段落，跟随角色时改跟这一条
    const standalone = async message => {
      await flush();
      if (follow) squashRole = message.role;
      lastRole = '';
      output.push(message);
    };
    for (const source of messages) {
      if (!source) continue;
      if (isNativeSquashMessage(source, roles)) {
        const content = source.content;
        await standalone({ ...source, ...(typeof content === 'string' ? { content: dropSeparator(content) }
          : Array.isArray(content) ? { content: content.map(part => (typeof part === 'string' ? dropSeparator(part)
            : isPlainTextPart(part) ? { ...part, text: dropSeparator(part.text) } : part)) } : {}) });
        continue;
      }
      if (!source.content) continue;
      const text = Array.isArray(source.content)
        ? source.content.map(part => (typeof part === 'string' ? part : part.text)).join('')
        : String(source.content);
      const role = squash.user_role_system === true && source.role === 'system' ? 'user' : source.role;
      if (hasSeparator(text)) {
        await standalone({ ...source, role, content: dropSeparator(text) });
        continue;
      }
      merged += role === lastRole ? '\n' : (lastRole ? affix[lastRole][1] : '') + affix[role][0];
      merged += text;
      lastRole = role;
    }
    await flush();
    return output;
  };
  const applySquashStopStrings = (body, squash) => {
    if (squash.enable_stop_string !== true || !squash.stop_string) return;
    let stops;
    try { stops = JSON.parse(squash.stop_string); } catch { stops = squash.stop_string; }
    stops = (Array.isArray(stops) ? stops : [stops]).map(String);
    const current = Array.isArray(body.stop) ? body.stop : typeof body.stop === 'string' ? [body.stop] : [];
    body.stop = [...current.filter(item => !stops.includes(item)), ...stops];
  };
  // SPreset 条目条件：开了条件的条目各跑一次脚本，结果只决定这一轮是否启用；出错或不是布尔值的本轮不启用
  const evaluateEntryConditions = async msg => {
    try {
      await waitUntilReady();
      const context = getContext();
      if (context.sessionId !== msg.sessionId || context.openaiPresetId !== msg.presetId) {
        throw new Error('会话或预设已切换，请重新发起生成');
      }
      const decisions = {}, failures = [];
      for (const entry of msg.entries || []) {
        try {
          const result = await compile(entry.spreset_condition_script, '条目条件')({
            model: String(msg.provider?.model || ''), provider: copy(msg.provider || {}),
            source: String(msg.provider?.source || ''), type: String(msg.generationType || 'normal'),
            entry: copy(entry), chat: copy(Array.isArray(context.chat) ? context.chat : []),
          });
          if (typeof result !== 'boolean') throw new Error('条目条件必须返回 true 或 false');
          decisions[entry.identifier] = result;
        } catch (error) {
          decisions[entry.identifier] = false;
          failures.push({ identifier: String(entry.identifier || ''), name: String(entry.name || entry.identifier || ''),
            error: String(error?.message || error) });
        }
      }
      send({ type: 'preset_request', id: msg.id, event: 'entry_conditions', decisions, failures });
    } catch (error) {
      send({ type: 'preset_request', id: msg.id, event: 'error', error: String(error?.message || error) });
    }
  };
  // SPreset 最终请求处理：其他预设脚本都处理完、发出前最后改一次请求；规则照上游
  const processFinalRequest = async (job, request) => {
    const draft = copy(request);
    const result = await compile(job.spreset.FinalRequestProcessing.script, '最终请求处理')({
      request: draft, provider: copy(job.provider || {}),
      model: String(request.model ?? job.provider?.model ?? ''),
      source: String(request.chat_completion_source ?? job.provider?.provider ?? ''),
      stream: request.stream === true, preview: Boolean(job.preview),
    });
    const processed = result === undefined ? draft : result;
    if (!processed || typeof processed !== 'object' || Array.isArray(processed)) {
      throw new Error('最终请求处理必须返回请求对象，或直接修改 request 后不返回');
    }
    const normalized = JSON.parse(JSON.stringify(processed));
    // 流式与来源决定了响应的解析方式，改了会按错误的格式读回复
    if (normalized.stream !== request.stream || normalized.chat_completion_source !== request.chat_completion_source) {
      throw new Error('最终请求处理不能改变 stream 或 chat_completion_source');
    }
    return normalized;
  };
  const prepareSPreset = async (body, preset, settings) => {
    const squash = settings.ChatSquash || {};
    if (squash.enabled === true) {
      body.messages = await squashSPresetMessages(body.messages, squash);
      applySquashStopStrings(body, squash);
    } else if (squash.squashed_post_script_enable === true) {
      // ChatSquash's message postprocessor also runs when merging is disabled.
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
      let body = JSON.parse(raw);
      job.prepared = true;
      if (job.spreset?.FinalRequestProcessing?.enabled === true) {
        try { body = await processFinalRequest(job, body); }
        catch (error) { throw new Error('SPreset 最终请求处理失败：' + (error?.message || String(error))); }
      }
      if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('预设请求缺少 messages');
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
      if (msg.event === 'entry_conditions') { void evaluateEntryConditions(msg); return true; }
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
