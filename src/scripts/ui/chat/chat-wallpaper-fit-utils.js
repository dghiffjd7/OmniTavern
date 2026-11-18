// 聊天壁纸的铺满缩放。
// 壁纸按聊天室的实际尺寸做 cover，再叠上用户调整的缩放、旋转、偏移。
// 只在 window resize 里算不够：resize 当下 fixed 定位的聊天室高度还是旧的（实测慢一帧），
// 会照旧高度缩放，键盘收起或旋转后上下各空一条。所以改为观察聊天室本身的尺寸。

/** 算出壁纸 img 的 transform；尺寸未知时回 null（保持原样）。 */
export const computeChatWallpaperTransform = ({
  containerWidth = 0,
  containerHeight = 0,
  imageWidth = 0,
  imageHeight = 0,
  meta = {},
} = {}) => {
  const cw = Number(containerWidth) || 0;
  const ch = Number(containerHeight) || 0;
  const iw = Number(imageWidth) || 0;
  const ih = Number(imageHeight) || 0;
  if (!cw || !ch || !iw || !ih) return null;
  const baseScale = Math.max(cw / iw, ch / ih);
  const zoom = Number(meta?.zoom || 1);
  const rotate = Number(meta?.rotate || 0);
  const offsetX = Number(meta?.offsetX || 0) * cw;
  const offsetY = Number(meta?.offsetY || 0) * ch;
  return `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px) rotate(${rotate}deg) scale(${baseScale * zoom})`;
};

/** 聊天室尺寸一变就调用 onResize（同一尺寸不重复）；回传停止观察的函数。 */
export const observeChatWallpaperContainer = ({
  containerEl = null,
  onResize = null,
  ResizeObserverCtor = globalThis.ResizeObserver,
} = {}) => {
  if (!containerEl || typeof onResize !== 'function' || typeof ResizeObserverCtor !== 'function') return () => {};
  let lastSize = '';
  const observer = new ResizeObserverCtor((entries) => {
    const box = entries?.[entries.length - 1]?.contentRect;
    const size = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '';
    if (size && size === lastSize) return;
    lastSize = size;
    onResize();
  });
  observer.observe(containerEl);
  return () => observer.disconnect();
};
