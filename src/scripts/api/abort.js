export const splitRequestOptions = (options = {}) => {
  const src = (options && typeof options === 'object') ? options : {};
  const signal = src.signal;
  const nativeRequestIdRaw =
    typeof src.nativeRequestId === 'string'
      ? src.nativeRequestId
      : (typeof src.requestId === 'string' ? src.requestId : '');
  const requestId = String(nativeRequestIdRaw || '').trim();
  const onProviderToolCallDelta =
    typeof src.onProviderToolCallDelta === 'function' ? src.onProviderToolCallDelta : null;
  const onProviderSources =
    typeof src.onProviderSources === 'function' ? src.onProviderSources : null;
  const onProviderSearchActivity =
    typeof src.onProviderSearchActivity === 'function' ? src.onProviderSearchActivity : null;
  const {
    requestContext: _requestContext,
    requestParamConstraints: _requestParamConstraints,
    onProviderRequestPrepared: _onProviderRequestPrepared,
    signal: _signal,
    nativeRequestId: _nativeRequestId,
    requestId: _requestId,
    onProviderToolCallDelta: _onProviderToolCallDelta,
    onProviderSources: _onProviderSources,
    onProviderSearchActivity: _onProviderSearchActivity,
    ...rest
  } = src;
  return {
    signal,
    requestId,
    onProviderToolCallDelta,
    onProviderSources,
    onProviderSearchActivity,
    options: rest,
  };
};

let nativeHttpRequestSequence = 0;

const createAbortError = (reason = null) => {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
};

const normalizeNativeHttpRequestId = (value = '') => String(value || '')
  .trim()
  .replace(/[^a-z0-9_-]+/giu, '_')
  .slice(0, 120);

const createNativeHttpRequestId = () => {
  nativeHttpRequestSequence = (nativeHttpRequestSequence + 1) % 0x1000000;
  return normalizeNativeHttpRequestId(
    `http_${Date.now().toString(36)}_${nativeHttpRequestSequence.toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
  );
};

// Tauri 的 http_request 不会自行消费 DOM AbortSignal；为可取消请求补齐唯一 requestId，
// signal 触发时同时结束 JS 等待与 Rust task，避免界面停止后请求仍继续计费。
export const invokeNativeHttpRequest = async ({
  invoker,
  args = {},
  signal = null,
  requestId = '',
} = {}) => {
  if (typeof invoker !== 'function') throw new TypeError('native http invoker is required');
  if (signal?.aborted) throw createAbortError(signal.reason);

  const nativeRequestId = normalizeNativeHttpRequestId(requestId)
    || (signal ? createNativeHttpRequestId() : '');
  let requestPromise;
  try {
    requestPromise = Promise.resolve(invoker('http_request', {
      ...(args && typeof args === 'object' ? args : {}),
      requestId: nativeRequestId || null,
    }));
  } catch (error) {
    throw error;
  }
  if (!signal) return requestPromise;

  let abortReject = null;
  let abortStarted = false;
  const abortPromise = new Promise((_, reject) => {
    abortReject = reject;
  });
  const abortNative = () => {
    if (abortStarted) return;
    abortStarted = true;
    if (nativeRequestId) {
      try {
        Promise.resolve(invoker('http_abort_request', { requestId: nativeRequestId })).catch(() => {});
      } catch {}
    }
    abortReject?.(createAbortError(signal.reason));
  };

  try {
    signal.addEventListener?.('abort', abortNative, { once: true });
    if (signal.aborted) abortNative();
    return await Promise.race([requestPromise, abortPromise]);
  } finally {
    try { signal.removeEventListener?.('abort', abortNative); } catch {}
  }
};

export const createLinkedAbortController = ({ timeoutMs, signal, idle = false } = {}) => {
  const controller = new AbortController();
  const ms = Number(timeoutMs);
  const shouldTimeout = Number.isFinite(ms) && ms > 0;
  let timeoutId = null;

  const abortInner = () => {
    try {
      controller.abort(signal?.reason);
    } catch {
      try { controller.abort(); } catch {}
    }
  };

  if (signal) {
    if (signal.aborted) {
      abortInner();
    } else {
      try { signal.addEventListener('abort', abortInner, { once: true }); } catch {}
    }
  }

  const armTimeout = () => {
    timeoutId = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, ms);
  };

  if (shouldTimeout) {
    armTimeout();
  }

  // idle 模式：timeoutMs 是「无数据空闲上限」而非总时长；每次 touch() 重置计时。
  // 流式请求必须用它——总时长超时会把健康的长流在中途杀死。
  const touch = () => {
    if (!shouldTimeout || idle !== true || controller.signal.aborted) return;
    if (timeoutId) {
      try { clearTimeout(timeoutId); } catch {}
      timeoutId = null;
    }
    armTimeout();
  };

  const cleanup = () => {
    if (timeoutId) {
      try { clearTimeout(timeoutId); } catch {}
      timeoutId = null;
    }
    if (signal) {
      try { signal.removeEventListener('abort', abortInner); } catch {}
    }
  };

  return { controller, cleanup, touch };
};
