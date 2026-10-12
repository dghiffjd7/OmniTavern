// 手机底部面板共用：按住顶部把手往下拖关闭（记忆表格编辑、导出、导入）。
// 底部面板按住顶部把手往下拖关闭：拖过面板高度 30% 或快速下滑就关闭，否则弹回。
export const bindSheetDragToDismiss = ({
  handleEl = null,
  panelEl = null,
  isEnabled = () => true,
  onDismiss = null,
  now = () => Date.now(),
} = {}) => {
  if (!handleEl || !panelEl) return () => {};
  let startY = 0;
  let startAt = 0;
  let lastY = 0;
  let dragging = false;
  const onMove = (event) => {
    if (!dragging) return;
    lastY = event.clientY;
    const dy = Math.max(0, lastY - startY);
    panelEl.style.transform = `translate3d(0, ${dy}px, 0)`;
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panelEl.classList.remove('is-dragging');
    handleEl.ownerDocument?.removeEventListener?.('pointermove', onMove);
    handleEl.ownerDocument?.removeEventListener?.('pointerup', end);
    handleEl.ownerDocument?.removeEventListener?.('pointercancel', end);
    const dy = Math.max(0, lastY - startY);
    const velocity = dy / Math.max(1, now() - startAt);
    const height = panelEl.getBoundingClientRect?.().height || panelEl.offsetHeight || 1;
    // 关闭时保留当前位移，由关闭动画从手指放开处接着往下滑；弹回则清掉位移交给过渡。
    if (dy > height * 0.3 || (dy > 24 && velocity > 0.6)) onDismiss?.({ dragged: dy });
    else panelEl.style.transform = '';
  };
  const onDown = (event) => {
    if (!isEnabled() || (event.button !== undefined && event.button !== 0)) return;
    dragging = true;
    startY = event.clientY;
    lastY = startY;
    startAt = now();
    panelEl.classList.add('is-dragging');
    handleEl.ownerDocument?.addEventListener?.('pointermove', onMove);
    handleEl.ownerDocument?.addEventListener?.('pointerup', end);
    handleEl.ownerDocument?.addEventListener?.('pointercancel', end);
  };
  handleEl.addEventListener('pointerdown', onDown);
  return () => handleEl.removeEventListener('pointerdown', onDown);
};
