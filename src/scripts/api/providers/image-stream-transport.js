// 生图的流式回应（SSE）：生成途中先送中间画面（NovelAI、OpenAI gpt-image 等）。
// Tauri 里经 Rust http_stream_request 一段段读，网页环境退回 fetch。
// 与聊天共用的 parseSSEBuffer 不同，这里保留 event 名称（有的服务用它区分中间图与最终图），data 不是 JSON 时原样给出。
import { createLinkedAbortController } from '../abort.js';

const makeAbortError = () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 拆 SSE：返回 { events: [{ event, data }], rest }；final 时把剩下的也当成完整的一段。 */
export const parseImageSseBuffer = (buffer = '', { final = false } = {}) => {
  const normalized = String(buffer ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const frames = normalized.split(/\n\n+/);
  const rest = final ? '' : (frames.pop() || '');
  const events = [];
  for (const frame of frames) {
    let event = '';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    const text = dataLines.join('\n').trim();
    if (!text || text === '[DONE]') continue;
    let data = text;
    try { data = JSON.parse(text); } catch {}
    events.push({ event, data });
  }
  return { events, rest };
};

const errorFromResponse = (status, body, label) => {
  const detail = String(body || '').trim().slice(0, 500);
  const error = new Error(`${label} API Error: ${status}${detail ? ` - ${detail}` : ''}`);
  error.status = status;
  error.response = String(body || '').slice(0, 65536);
  return error;
};

/**
 * 发出请求并逐个产出 SSE 事件 { event, data }。回应不是 2xx 时抛错（带 status）。
 * 整段回应都不是 SSE、而是一个 JSON（例如中转站忽略了 stream）时，产出 { event: 'json', data }。
 * invoker 有值时走 Rust 原生流式请求；否则用 fetch 读 body。
 */
export async function* streamImageSse({
  url,
  method = 'POST',
  headers = {},
  body = null,
  signal = null,
  timeoutMs = 180000,
  label = 'Image',
  invoker = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (signal?.aborted) throw makeAbortError();
  let buffer = '';
  let raw = ''; // 还没出现任何事件前的原文：最后若是整段 JSON 就照常交回
  let yielded = 0;
  const drain = (final = false) => {
    const parsed = parseImageSseBuffer(buffer, { final });
    buffer = parsed.rest;
    yielded += parsed.events.length;
    if (final && !yielded && raw.trim().startsWith('{')) {
      try { return [{ event: 'json', data: JSON.parse(raw) }]; } catch {}
    }
    return parsed.events;
  };
  const take = (chunk) => {
    buffer += chunk;
    if (!yielded) raw += chunk;
    else raw = '';
  };

  if (typeof invoker === 'function') {
    const requestId = `image_stream_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
    let started = false;
    let status = 0;
    let ok = null;
    let errorBody = '';
    const close = () => {
      if (started) Promise.resolve(invoker('http_stream_request_close', { requestId })).catch(() => {});
    };
    signal?.addEventListener?.('abort', close, { once: true });
    try {
      await invoker('http_stream_request_start', { url, method, headers, body, timeoutMs, requestId });
      started = true;
      while (true) {
        if (signal?.aborted) throw makeAbortError();
        const batch = await invoker('http_stream_request_read', { requestId, maxChunks: 32 });
        if (signal?.aborted) throw makeAbortError();
        if (Number.isFinite(Number(batch?.status))) status = Number(batch.status);
        if (typeof batch?.ok === 'boolean') ok = batch.ok;
        const chunks = Array.isArray(batch?.chunks) ? batch.chunks.map(chunk => String(chunk || '')) : [];
        if (ok === false) {
          errorBody = (errorBody + chunks.join('')).slice(0, 65536);
        } else {
          for (const chunk of chunks) {
            take(chunk);
            yield* drain(false);
          }
        }
        const nativeError = String(batch?.error || '').trim();
        if (nativeError) {
          if (/aborted/iu.test(nativeError)) throw makeAbortError();
          const error = new Error(`native http_stream_request failed: ${nativeError}`);
          error.status = status;
          throw error;
        }
        if (batch?.done) {
          if (ok === false) throw errorFromResponse(status, errorBody, label);
          yield* drain(true);
          return;
        }
        if (!chunks.length) await delay(30);
      }
    } finally {
      signal?.removeEventListener?.('abort', close);
      close();
    }
  }

  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const { controller, cleanup, touch } = createLinkedAbortController({ timeoutMs, signal, idle: true });
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    if (!response.ok) throw errorFromResponse(response.status, await response.text().catch(() => ''), label);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      touch?.();
      if (done) break;
      take(decoder.decode(value, { stream: true }));
      yield* drain(false);
    }
    take(decoder.decode());
    yield* drain(true);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw makeAbortError();
    throw error;
  } finally {
    cleanup();
  }
}

/** base64 图片 → data URL（按文件头判断格式）。 */
export const base64ImageToDataUrl = (base64 = '') => {
  const value = String(base64 || '').replace(/^data:[^,]*,/, '');
  const mime = value.startsWith('/9j/') ? 'image/jpeg'
    : value.startsWith('UklGR') ? 'image/webp'
      : value.startsWith('R0lGOD') ? 'image/gif'
        : 'image/png';
  return `data:${mime};base64,${value}`;
};

/** 把中间画面交给调用方：回调出错不影响生成本身。 */
export const emitImagePreview = (onPreview, preview) => {
  if (typeof onPreview !== 'function') return;
  try { onPreview(preview); } catch {}
};
