// ComfyUI 生成途中的预览：WebSocket（/ws?clientId=…）收步数进度（progress 文字消息）与预览图（二进制帧）。
// 二进制帧格式（ComfyUI server.py／protocol.py BinaryEventTypes）：开头 4 字节大端 = 事件类型；
//   1 PREVIEW_IMAGE：接着 4 字节图片类型（1 JPEG、2 PNG），之后是图片；
//   4 PREVIEW_IMAGE_WITH_METADATA：接着 4 字节元数据长度、元数据 JSON（含 image_type、prompt_id），之后是图片。
// 服务端要开 --preview-method 才有预览图；没开时只有步数。连不上时生成照常，只是没有预览。

export const COMFYUI_PREVIEW_CONNECT_TIMEOUT_MS = 1500;

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** 解一个二进制帧：返回 { dataUrl, promptId } 或 null（不是预览图）。 */
export const parseComfyUIPreviewFrame = (buffer) => {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const event = view.getUint32(0);
  if (event === 1) {
    const mime = view.getUint32(4) === 2 ? 'image/png' : 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer, 8))}`, promptId: '' };
  }
  if (event === 4) {
    const length = view.getUint32(4);
    if (8 + length > buffer.byteLength) return null;
    let meta = {};
    try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))); } catch {}
    const mime = /^image\/(png|jpeg|webp)$/.test(meta?.image_type) ? meta.image_type : 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer, 8 + length))}`, promptId: String(meta?.prompt_id || '') };
  }
  return null;
};

/** http(s)://host[/path] → ws(s)://host[/path]/ws?clientId=… */
export const buildComfyUIPreviewSocketUrl = (baseUrl = '', clientId = '') => {
  const url = new URL(String(baseUrl || '').replace(/\/+$/, '') + '/ws');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', clientId);
  return url.toString();
};

/**
 * 打开预览连线。ready：连上（或超时、失败）后完成，返回是否连上；
 * setPromptId 之后只认这个 prompt 的消息；close 关掉。onPreview({ dataUrl, step, total })。
 */
export const openComfyUIPreviewSocket = ({
  baseUrl,
  clientId,
  onPreview,
  WebSocketImpl = globalThis.WebSocket,
  connectTimeoutMs = COMFYUI_PREVIEW_CONNECT_TIMEOUT_MS,
} = {}) => {
  let socket = null;
  let promptId = '';
  const state = { dataUrl: '', step: 0, total: 0 };
  const emit = () => {
    try { onPreview?.({ ...state }); } catch {}
  };
  const ready = new Promise((resolve) => {
    if (typeof WebSocketImpl !== 'function') { resolve(false); return; }
    const timer = setTimeout(() => resolve(false), connectTimeoutMs);
    const done = (ok) => { clearTimeout(timer); resolve(ok); };
    try {
      socket = new WebSocketImpl(buildComfyUIPreviewSocketUrl(baseUrl, clientId));
      socket.binaryType = 'arraybuffer';
    } catch {
      done(false);
      return;
    }
    socket.onopen = () => done(true);
    socket.onerror = () => done(false);
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let message = null;
        try { message = JSON.parse(event.data); } catch { return; }
        const data = message?.data || {};
        if (message?.type !== 'progress' || (promptId && data.prompt_id && data.prompt_id !== promptId)) return;
        state.step = Number(data.value) || 0;
        state.total = Number(data.max) || 0;
        emit();
        return;
      }
      const frame = parseComfyUIPreviewFrame(event.data);
      if (!frame || (promptId && frame.promptId && frame.promptId !== promptId)) return;
      state.dataUrl = frame.dataUrl;
      emit();
    };
  });
  return {
    ready,
    setPromptId: (id) => { promptId = String(id || ''); },
    close: () => { try { socket?.close(); } catch {} },
  };
};
