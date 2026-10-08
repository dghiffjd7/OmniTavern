const MESSAGE_INTERACTIVE_TARGET_SELECTOR =
  'a[href], button, input, textarea, select, audio, video, canvas, [contenteditable="true"], .inline-text-editor';

export const createLongPressUiRuntime = ({
  schedule = (handler, delay = 0) => setTimeout(handler, delay),
  clearSchedule = (timerId) => clearTimeout(timerId),
  hasActiveTextSelection = () => {
    try {
      return Boolean(String(globalThis.getSelection?.()?.toString?.() || '').trim());
    } catch {
      return false;
    }
  },
} = {}) => ({
  isInteractiveControlTarget(target = null) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest(MESSAGE_INTERACTIVE_TARGET_SELECTOR));
  },
  isButtonTarget(target = null) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest('button'));
  },
  isSelectableTextTarget(target = null) {
    if (!target || typeof target.closest !== 'function') return false;
    const interactive = target.closest('button, input, textarea, select, audio, video, canvas, [contenteditable="true"], .inline-text-editor');
    if (interactive) return false;
    return Boolean(target.closest('.QQ_chat_msgdiv, .chat-message-content, .chat-rich-fragment'));
  },
  startLongPress({
    selectionMode = false,
    event,
    message,
    getPoint,
    clearExisting,
    setLongPressStart,
    setLongPressTimer,
    onTrigger,
  }) {
    if (selectionMode || this.isInteractiveControlTarget(event?.target)) return false;
    clearExisting?.();
    const point = getPoint?.(event) || null;
    setLongPressStart?.(point);
    const delay = this.isSelectableTextTarget(event?.target) ? 680 : 500;
    const timerId = schedule(() => {
      if (hasActiveTextSelection()) return;
      onTrigger?.(event, message);
    }, delay);
    setLongPressTimer?.(timerId);
    return true;
  },
  clearLongPress({
    getLongPressTimer,
    setLongPressTimer,
    setLongPressStart,
  }) {
    const timerId = getLongPressTimer?.();
    if (timerId) {
      clearSchedule(timerId);
      setLongPressTimer?.(null);
    }
    setLongPressStart?.(null);
  },
  bindMessageContextInteractions({
    wrapper,
    message,
    getLongPressTimer,
    getLongPressStart,
    getPoint,
    clearLongPress,
    startLongPress,
    showContextMenu,
  }) {
    if (!wrapper) return wrapper;
    wrapper.addEventListener('pointerdown', event => startLongPress?.(event, message));
    wrapper.addEventListener(
      'pointermove',
      event => {
        if (!getLongPressTimer?.() || !getLongPressStart?.()) return;
        const point = getPoint?.(event);
        if (!point) return;
        const start = getLongPressStart?.();
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        if (dx * dx + dy * dy > 10 * 10) clearLongPress?.();
      },
      { passive: true },
    );
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => {
      wrapper.addEventListener(type, () => clearLongPress?.());
    });
    wrapper.addEventListener(
      'contextmenu',
      event => {
        if (this.isInteractiveControlTarget(event?.target)) {
          clearLongPress?.();
          if (this.isButtonTarget(event?.target)) {
            try {
              event.preventDefault();
            } catch {}
          }
          return;
        }
        if (this.isSelectableTextTarget(event?.target) && hasActiveTextSelection()) {
          clearLongPress?.();
          return;
        }
        try {
          event.preventDefault();
        } catch {}
        clearLongPress?.();
        showContextMenu?.(event, message);
      },
      { passive: false },
    );
    return wrapper;
  },
});
