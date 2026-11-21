// 序列化进 ScriptRuntime 的 Worker。脚本以为自己在酒馆页面上，会直接 fetch('/api/...')：
// 相对路径（或指向本页同源的完整网址）在这里认出来，经 RPC 交主程式的酒馆接口路由，回酒馆同形状的 Response。
// 完整的外部网址不归这里，仍照「访问网络」权限交给原生 fetch。
// 流式请求（请求体 stream: true）：主程式回 { stream: true } 后，分块以 tavern_stream 讯息送来，接进 Response 的 body；
// 脚本中止（AbortSignal）或取消读流时经 RPC tavern.cancel 中止上游请求。
export function createTavernApiWorker({ callRpc, getOrigin = () => '', getSessionId = () => '',
  getScriptName = () => '', getChatMetadata = () => ({}), bodyLimit = 1200000 }) {
  // 每个脚本编译时带上这个 sourceURL，发请求时从调用堆栈认出是哪个脚本
  const sourcePrefix = 'chatapp-script/';
  const scriptSourceUrl = id => sourcePrefix + encodeURIComponent(String(id || ''))
    .replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) + '.js';
  // 取堆栈里最外层的脚本：同步调用链上它就是发请求的脚本；
  // 请求先经过别的脚本的 fetch 包装、包装里又先 await 过时，只认得到包装所在的脚本
  const findCallerScriptId = () => {
    const limit = Error.stackTraceLimit;
    let stack = '';
    try {
      Error.stackTraceLimit = 64;
      stack = String(new Error().stack || '');
    } catch {} finally {
      Error.stackTraceLimit = limit;
    }
    const matches = stack.match(/chatapp-script\/[^\s/:()]+\.js/g) || [];
    const last = matches[matches.length - 1];
    if (!last) return '';
    try { return decodeURIComponent(last.slice(sourcePrefix.length, -3)); } catch { return ''; }
  };
  const resolvePath = (input) => {
    const raw = String(input?.url || input || '').trim();
    if (!raw) return '';
    let url;
    try { url = new URL(raw, 'http://chatapp.invalid/'); } catch { return ''; }
    // 完整网址只认指向本页同源的写法，例如 new URL('/api/...', location.origin)
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(raw)) {
      const origin = getOrigin();
      if (!origin || !url.href.startsWith(origin + '/')) return '';
    }
    return url.pathname.startsWith('/api/') ? url.pathname : '';
  };
  const abortError = () => {
    try { return new DOMException('The operation was aborted.', 'AbortError'); } catch {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return error;
    }
  };
  const respond = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), {
    status: Number(status) >= 200 && Number(status) <= 599 ? Number(status) : 500,
    headers: { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' },
  });
  let seq = 0;
  const streams = new Map();
  const encoder = new TextEncoder();
  const cancelUpstream = (requestId) => { Promise.resolve(callRpc('tavern.cancel', { requestId })).catch(() => {}); };
  // 先开好流再送 RPC：分块可能比 RPC 结果先到
  const openStream = (requestId) => {
    const slot = { controller: null, detach: () => {} };
    slot.stream = new ReadableStream({
      start(controller) { slot.controller = controller; },
      cancel() {
        if (streams.get(requestId) !== slot) return;
        streams.delete(requestId);
        slot.detach();
        cancelUpstream(requestId);
      },
    });
    streams.set(requestId, slot);
    return slot;
  };
  const closeStream = (requestId, error = null) => {
    const slot = streams.get(requestId);
    if (!slot) return;
    streams.delete(requestId);
    slot.detach();
    try { if (error) slot.controller.error(error); else slot.controller.close(); } catch {}
  };
  const handle = (msg) => {
    if (msg?.type !== 'tavern_stream') return false;
    const slot = streams.get(msg.id);
    if (!slot) return true;
    if (msg.event === 'data') {
      try { slot.controller.enqueue(encoder.encode(String(msg.data ?? ''))); } catch {}
    } else if (msg.event === 'end') closeStream(msg.id);
    return true;
  };
  const readBody = async (input, init) => {
    if (typeof init?.body === 'string') return init.body;
    if (init?.body != null) return new Response(init.body).text();
    if (typeof input?.clone === 'function') return input.clone().text();
    return '';
  };
  const send = async (path, input, init, scriptId, request) => {
    const raw = await readBody(input, init);
    if (raw.length > bodyLimit) return respond(413, { error: { message: `请求体超过 APP 的大小上限，没有处理：${path}` } });
    let body = null;
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch {
        return respond(400, { error: { message: `请求体不是有效的 JSON，APP 没有处理：${path}` } });
      }
    }
    if (request.aborted) throw abortError();
    const slot = body?.stream === true ? openStream(request.id) : null;
    if (slot) request.slot = slot;
    try {
      const result = await callRpc('tavern.request', {
        path, body, scriptId, scriptName: getScriptName(scriptId), sessionId: getSessionId(), requestId: request.id,
        ...(path === '/api/chats/get' ? { chatMetadata: getChatMetadata() } : {}),
      });
      // 分块（甚至结束讯号）可能比 RPC 结果先到：流已关闭时，已收到的分块仍留在流里可读
      if (slot && result?.stream === true) {
        return new Response(slot.stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (slot) closeStream(request.id);
      return respond(result?.status, result?.body);
    } catch (error) {
      if (slot) closeStream(request.id);
      return respond(500, { error: { message: `APP 处理酒馆接口 ${path} 时出错：${String(error?.message || error)}` } });
    }
  };
  const interceptFetch = (input, init = {}) => {
    const path = resolvePath(input);
    if (!path) return null;
    const scriptId = findCallerScriptId();
    const signal = init?.signal || input?.signal || null;
    if (signal?.aborted) return Promise.reject(abortError());
    const request = { id: 'tv_' + Date.now().toString(36) + '_' + (++seq), aborted: false, slot: null };
    const task = send(path, input, init, scriptId, request);
    if (typeof signal?.addEventListener !== 'function') return task;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        request.aborted = true;
        cancelUpstream(request.id);
        closeStream(request.id, abortError());
        reject(abortError());
      };
      const detach = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      task.then((response) => {
        // 流式回应读完（或被取消）前都要能中止
        if (request.slot && streams.get(request.id) === request.slot) request.slot.detach = detach;
        else detach();
        resolve(response);
      }, (error) => { detach(); reject(error); });
    });
  };
  return { interceptFetch, handle, scriptSourceUrl };
}
