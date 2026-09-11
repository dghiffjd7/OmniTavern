// Owns viewport placement and pointer/keyboard movement; call state stays in the runtime.
export const bindRealtimeCallFloatingPosition = ({
  layer,
  panel,
  handle,
  windowLike = globalThis.window,
  isExpanded = () => false,
  onExpandedChange = () => {},
} = {}) => {
  const doc = panel.ownerDocument;
  let preferred = { dock: 'top', ratio: .3 };
  let free = null;
  let drag = null;
  let suppressClick = false;
  let frame = null;
  let active = false;
  let observer = null;

  const viewport = () => {
    const visual = windowLike.visualViewport;
    const style = windowLike.getComputedStyle(layer);
    const inset = side => Number.parseFloat(style[side]) || 0;
    const left = (visual?.offsetLeft || 0) + inset('paddingLeft');
    const top = (visual?.offsetTop || 0) + inset('paddingTop');
    return {
      left, top,
      width: Math.max(1, (visual?.width || windowLike.innerWidth) - inset('paddingLeft') - inset('paddingRight')),
      height: Math.max(1, (visual?.height || windowLike.innerHeight) - inset('paddingTop') - inset('paddingBottom')),
    };
  };

  const layout = () => {
    if (!active || layer.hidden) return;
    const bounds = viewport();
    panel.style.setProperty('--realtime-call-available-width', `${bounds.width}px`);
    panel.style.setProperty('--realtime-call-available-height', `${bounds.height}px`);
    panel.dataset.dock = preferred.dock;
    const { width, height } = panel.getBoundingClientRect();
    let anchor;
    if (isExpanded()) anchor = { x: bounds.left + bounds.width / 2, y: bounds.top + (bounds.height - height) / 2 };
    else if (free) anchor = { x: free.x, y: free.y - height / 2 };
    else anchor = {
      x: preferred.dock === 'top' ? bounds.left + bounds.width / 2 : preferred.dock === 'left' ? bounds.left + width / 2 : bounds.left + bounds.width - width / 2,
      y: preferred.dock === 'top' ? bounds.top : bounds.top + preferred.ratio * Math.max(0, bounds.height - height),
    };
    const left = Math.max(bounds.left, Math.min(anchor.x - width / 2, bounds.left + bounds.width - width));
    const top = Math.max(bounds.top, Math.min(anchor.y, bounds.top + bounds.height - height));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };

  const scheduleLayout = () => {
    if (!active || frame != null) return;
    frame = windowLike.requestAnimationFrame(() => { frame = null; layout(); });
  };

  const nearestDock = point => {
    const bounds = viewport();
    if (point.y < bounds.top + Math.min(120, bounds.height * .22)) return 'top';
    return point.x < bounds.left + bounds.width / 2 ? 'left' : 'right';
  };
  const finishDrag = (cancelled = false) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (current.moved) {
      if (cancelled) {
        preferred = current.previous;
        onExpandedChange(current.expanded);
      } else {
        const bounds = viewport(), rect = panel.getBoundingClientRect();
        preferred = { dock: preferred.dock, ratio: Math.max(0, Math.min(1, (rect.top - bounds.top) / Math.max(1, bounds.height - rect.height))) };
      }
    }
    free = null;
    panel.classList.remove('is-dragging');
    try { handle.releasePointerCapture(current.id); } catch {}
    layout();
  };

  const pointerDown = event => {
    if (!active || event.isPrimary === false || event.button !== 0 || drag) return;
    suppressClick = false;
    const rect = panel.getBoundingClientRect();
    drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      previous: preferred, expanded: isExpanded(), moved: false,
    };
  };

  const pointerMove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 7) return;
    if (!drag.moved) {
      drag.moved = true;
      suppressClick = true;
      panel.classList.add('is-dragging');
      onExpandedChange(false);
      try { handle.setPointerCapture(drag.id); } catch {}
    }
    event.preventDefault();
    free = drag.expanded
      ? { x: event.clientX, y: event.clientY }
      : { x: drag.left + drag.width / 2 + dx, y: drag.top + drag.height / 2 + dy };
    preferred = { ...preferred, dock: nearestDock(free) };
    layout();
  };

  const pointerUp = event => { if (drag?.id === event.pointerId) finishDrag(); };
  const pointerCancel = event => { if (drag?.id === event.pointerId) finishDrag(true); };
  const lostCapture = event => {
    // Touch starts with implicit capture on a child (avatar/text). Its bubbling loss
    // when capture transfers to the handle is not the end of this drag.
    if (event.target === handle && drag?.id === event.pointerId) finishDrag();
  };
  const blur = () => finishDrag(true);
  const click = event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const contextMenu = event => event.preventDefault();
  const keyDown = event => {
    if (event.key === 'Escape' && drag) { finishDrag(true); event.preventDefault(); return; }
    if (!event.altKey) return;
    if (event.key === 'Home') preferred = { dock: 'top', ratio: .3 };
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') preferred = { dock: event.key === 'ArrowLeft' ? 'left' : 'right', ratio: preferred.ratio };
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const bounds = viewport(), rect = panel.getBoundingClientRect();
      const ratio = preferred.ratio + (event.key === 'ArrowUp' ? -16 : 16) / Math.max(1, bounds.height - rect.height);
      preferred = { dock: preferred.dock === 'top' ? 'right' : preferred.dock, ratio: Math.max(0, Math.min(1, ratio)) };
    } else return;
    onExpandedChange(false);
    event.preventDefault();
    event.stopPropagation();
    layout();
  };

  const start = () => {
    if (active) { layout(); return; }
    active = true;
    handle.addEventListener('pointerdown', pointerDown);
    handle.addEventListener('lostpointercapture', lostCapture);
    handle.addEventListener('click', click, true);
    handle.addEventListener('contextmenu', contextMenu);
    handle.addEventListener('keydown', keyDown);
    doc.addEventListener('pointermove', pointerMove, { passive: false });
    doc.addEventListener('pointerup', pointerUp);
    doc.addEventListener('pointercancel', pointerCancel);
    windowLike.addEventListener('blur', blur);
    windowLike.addEventListener('resize', scheduleLayout);
    windowLike.visualViewport?.addEventListener('resize', scheduleLayout);
    windowLike.visualViewport?.addEventListener('scroll', scheduleLayout);
    if (windowLike.ResizeObserver) {
      observer = new windowLike.ResizeObserver(scheduleLayout);
      observer.observe(panel);
    }
    layout();
  };

  const stop = () => {
    finishDrag(true);
    active = false;
    suppressClick = false;
    if (frame != null) windowLike.cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
    observer = null;
    handle.removeEventListener('pointerdown', pointerDown);
    handle.removeEventListener('lostpointercapture', lostCapture);
    handle.removeEventListener('click', click, true);
    handle.removeEventListener('contextmenu', contextMenu);
    handle.removeEventListener('keydown', keyDown);
    doc.removeEventListener('pointermove', pointerMove);
    doc.removeEventListener('pointerup', pointerUp);
    doc.removeEventListener('pointercancel', pointerCancel);
    windowLike.removeEventListener('blur', blur);
    windowLike.removeEventListener('resize', scheduleLayout);
    windowLike.visualViewport?.removeEventListener('resize', scheduleLayout);
    windowLike.visualViewport?.removeEventListener('scroll', scheduleLayout);
  };

  return { start, stop, layout };
};
