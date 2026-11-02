// 元素手势（自定义工具、动作与手势计划）：AI／用户气泡双击、发送键双击或长按、消息头像点击或双击。
// 只在有绑定的位置生效，没绑就照原本的操作；同一手势只执行一次，长按成功后吞掉随后的点击。
// 气泡：滑鼠用原生 dblclick（顺便清掉双击选到的字）；触控按两次点按的间隔判定，不延迟单击。
// 头像：只绑一种手势时立即执行；点击和双击都绑了，单击才要等一下确定不是双击。
// 发送键：绑了双击时单击要稍等才送出（只影响发送键）；生成中发送键是「停止」，不等待也不触发手势。
// 按钮、链接、输入框、iframe、图片、分支切换等子控件与 iframe 内部不吃手势。

export const GESTURE_DOUBLE_MS = 280;
const STYLE_ID = 'user-tool-gesture-style';
// 按住发送键：在长按时间内渐渐缩小并亮起强调色，放开或取消就回弹
const STYLE = `
.is-tool-holding { transform: scale(.86); color: var(--app-accent-primary, #2563eb) !important; transition: transform 550ms var(--app-ease-out, ease), color 160ms ease; }
body[data-reduced-motion='on'] .is-tool-holding { transform: none; transition: none; }
@media (prefers-reduced-motion: reduce) { .is-tool-holding { transform: none; transition: none; } }
`;
export const GESTURE_LONG_MS = 550;
const MOVE_TOLERANCE = 10;
const TAP_DISTANCE = 28;
const INTERACTIVE = [
  'button', 'a', 'input', 'textarea', 'select', 'summary', 'label', 'video', 'audio', 'iframe',
  '[contenteditable=""]', '[contenteditable="true"]', '.rp-message-actions', '.rp-swipe-indicator',
  'img.previewable', '.chat-inline-generated-image',
].join(', ');

/** 点在哪里：消息头像、气泡（含角色）或都不是。 */
export const locateGestureTarget = (target, scrollEl) => {
  const wrapper = target?.closest?.('.QQ_chat_mymsg, .QQ_chat_charmsg');
  if (!wrapper || (scrollEl && !scrollEl.contains?.(wrapper))) return null;
  const message = wrapper.__chatappMessage;
  const messageId = String(wrapper.dataset?.msgId || message?.id || '');
  if (!messageId) return null;
  if (target.closest('img.QQ_chat_head')) return { position: 'message_avatar', messageId };
  if (target.closest(INTERACTIVE) || !target.closest('.chat-message-stack')) return null;
  return { position: message?.role === 'user' ? 'user_bubble' : 'assistant_bubble', messageId };
};

/**
 * findGesture(position, gesture) → 绑定（含 toolId）或 null；run(toolId, { messageId, trigger })。
 * setSendClickGuard(fn)：发送键的点击守卫（返回 true 就不送出）；performSend() 照原本送出。
 */
export const bindUserToolGestures = ({
  documentRef = globalThis.document,
  scrollEl = null,
  sendBtn = null,
  findGesture = () => null,
  run = () => {},
  isEnabled = () => true,
  isGenerating = () => false,
  setSendClickGuard = () => {},
  performSend = () => {},
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = timer => clearTimeout(timer),
} = {}) => {
  const win = documentRef?.defaultView || globalThis;
  if (documentRef?.head && !documentRef.getElementById?.(STYLE_ID)) {
    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    documentRef.head.appendChild(style);
  }
  const bound = (position, gesture) => (isEnabled() ? findGesture(position, gesture) : null);
  const fire = (binding, messageId = '') => { void run(binding.toolId, { messageId, trigger: 'gesture' }); };
  const clearSelection = () => { try { win.getSelection?.()?.removeAllRanges?.(); } catch {} };
  const listeners = [];
  const listen = (node, type, handler, options) => {
    if (!node?.addEventListener) return;
    node.addEventListener(type, handler, options);
    listeners.push(() => node.removeEventListener(type, handler, options));
  };

  // ---------- 气泡与头像 ----------
  let lastTap = null; // 触控：上一次点按 { messageId, position, at }
  let touchFiredAt = 0; // 触控双击后浏览器可能再补一个 dblclick，忽略
  let avatarPending = null; // { messageId, timer, click }

  const handleBubbleDouble = (spot) => {
    const binding = bound(spot.position, 'double');
    if (!binding) return false;
    clearSelection();
    fire(binding, spot.messageId);
    return true;
  };

  const handleAvatarClick = (spot) => {
    const click = bound('message_avatar', 'click');
    const double = bound('message_avatar', 'double');
    if (!click && !double) return false;
    if (!double) { fire(click, spot.messageId); return true; }
    if (avatarPending && avatarPending.messageId === spot.messageId) {
      cancel(avatarPending.timer);
      avatarPending = null;
      fire(double, spot.messageId);
      return true;
    }
    if (avatarPending) cancel(avatarPending.timer);
    const pending = { messageId: spot.messageId, click };
    pending.timer = schedule(() => {
      if (avatarPending === pending) avatarPending = null;
      if (pending.click) fire(pending.click, pending.messageId);
    }, GESTURE_DOUBLE_MS);
    avatarPending = pending;
    return true;
  };

  const onClick = (event) => {
    const spot = locateGestureTarget(event.target, scrollEl);
    if (!spot) return;
    if (spot.position === 'message_avatar') {
      if (handleAvatarClick(spot)) event.stopPropagation?.();
      return;
    }
    // 滑鼠双击交给 dblclick；触控用两次点按的间隔
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (String(win.getSelection?.() || '').trim()) { lastTap = null; return; }
    const at = now();
    const x = Number(event.clientX) || 0;
    const y = Number(event.clientY) || 0;
    if (lastTap && lastTap.messageId === spot.messageId && lastTap.position === spot.position && at - lastTap.at <= GESTURE_DOUBLE_MS
      && Math.hypot(x - lastTap.x, y - lastTap.y) <= TAP_DISTANCE) {
      lastTap = null;
      if (handleBubbleDouble(spot)) touchFiredAt = at;
      return;
    }
    lastTap = { messageId: spot.messageId, position: spot.position, at, x, y };
  };

  const onDblClick = (event) => {
    if (now() - touchFiredAt < 700) return;
    const spot = locateGestureTarget(event.target, scrollEl);
    if (!spot || spot.position === 'message_avatar') return;
    if (handleBubbleDouble(spot)) event.preventDefault?.();
  };

  listen(scrollEl, 'click', onClick, true);
  listen(scrollEl, 'dblclick', onDblClick);

  // ---------- 发送键 ----------
  let press = null; // { timer, x, y, touch }
  let cancelledTouchAt = -Infinity; // 触屏按住被系统取消的时间（可能是系统长按，见 onContextMenu）
  let suppressClickUntil = 0;
  let pendingSend = null;

  const endPress = () => {
    if (!press) return;
    cancel(press.timer);
    press = null;
    sendBtn?.classList?.remove?.('is-tool-holding');
  };
  const completePress = (binding) => {
    endPress();
    cancelledTouchAt = -Infinity;
    suppressClickUntil = now() + 800;
    fire(binding);
  };
  const onPointerDown = (event) => {
    endPress();
    if (event.button !== undefined && event.button !== 0) return;
    if (isGenerating()) return;
    const binding = bound('send_button', 'long');
    if (!binding) return;
    sendBtn?.classList?.add?.('is-tool-holding');
    press = {
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      touch: event.pointerType === 'touch' || event.pointerType === 'pen',
      timer: schedule(() => completePress(binding), GESTURE_LONG_MS),
    };
  };
  const onPointerMove = (event) => {
    if (press && Math.hypot((Number(event.clientX) || 0) - press.x, (Number(event.clientY) || 0) - press.y) > MOVE_TOLERANCE) endPress();
  };
  const onPointerCancel = () => {
    cancelledTouchAt = press?.touch ? now() : -Infinity;
    endPress();
  };
  const onContextMenu = (event) => {
    // 触屏长按发送键会叫出系统菜单；有长按绑定时拦掉
    const binding = bound('send_button', 'long');
    if (!binding) return;
    event.preventDefault?.();
    // Android WebView 到系统长按时间（约 0.5 秒，跟着系统「触摸和按住延迟」）就先送 pointercancel 再送 contextmenu，
    // 这时手还按着，就算长按成功；滑动造成的取消后面不会有 contextmenu
    if (press?.touch || now() - cancelledTouchAt <= 300) completePress(binding);
  };
  listen(sendBtn, 'pointerdown', onPointerDown);
  listen(sendBtn, 'pointermove', onPointerMove);
  listen(sendBtn, 'pointerup', endPress);
  listen(sendBtn, 'pointercancel', onPointerCancel);
  listen(sendBtn, 'pointerleave', endPress);
  listen(sendBtn, 'contextmenu', onContextMenu);

  const sendClickGuard = () => {
    if (now() < suppressClickUntil) return true;
    if (isGenerating()) return false;
    const double = bound('send_button', 'double');
    if (!double) return false;
    if (pendingSend) {
      cancel(pendingSend);
      pendingSend = null;
      fire(double);
      return true;
    }
    pendingSend = schedule(() => { pendingSend = null; performSend(); }, GESTURE_DOUBLE_MS);
    return true;
  };
  setSendClickGuard(sendClickGuard);

  const onVisibility = () => { endPress(); };
  listen(documentRef, 'visibilitychange', onVisibility);
  listen(win, 'session-changed', () => {
    endPress();
    lastTap = null;
    if (avatarPending) { cancel(avatarPending.timer); avatarPending = null; }
    if (pendingSend) { cancel(pendingSend); pendingSend = null; }
  });

  return {
    sendClickGuard,
    dispose: () => {
      endPress();
      if (pendingSend) cancel(pendingSend);
      if (avatarPending) cancel(avatarPending.timer);
      setSendClickGuard(null);
      listeners.forEach(remove => remove());
    },
  };
};
