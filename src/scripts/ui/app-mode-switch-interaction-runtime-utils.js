const MAID_TUMBLE_SRC = 'assets/media/maid-tumble.webp';
const MAID_W = 102;
const MAID_H = 114;
const MAID_DURATION = 3900;

const scheduleSettling = (modeSwitchEl, setTimeoutFn) => {
  if (!modeSwitchEl) return;
  modeSwitchEl.classList.add('is-settling');
  setTimeoutFn?.(() => modeSwitchEl.classList.remove('is-settling'), 250);
};

export function createModeSwitchInteractionRuntime({
  documentRef = globalThis?.document || null,
  modeSwitchEl = null,
  modeSwitchBtnEl = null,
  getViewportSize = () => ({ w: 0, h: 0 }),
  getModeSwitchSize = () => 0,
  getSafeInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  normalizeModeSwitchPos = () => null,
  setModeSwitchPos = () => {},
  setModeSwitchPinned = () => {},
  saveModeSwitchPos = () => {},
  wakeModeSwitch = () => {},
  scheduleModeSwitchSync = () => {},
  enterRpMode = () => {},
  exitRpMode = () => {},
  getUiMode = () => 'chat',
  requestAnimationFrameFn = globalThis?.requestAnimationFrame || null,
  cancelAnimationFrameFn = globalThis?.cancelAnimationFrame || null,
  setTimeoutFn = globalThis?.setTimeout || null,
  clearTimeoutFn = globalThis?.clearTimeout || null,
  matchMediaFn = globalThis?.matchMedia || null,
  nowFn = () => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  },
  randomFn = Math.random,
  vibrate = () => {},
  longPressMs = 560,
  longPressMoveTolerance = 8,
  onLongPress = null,
  onClick = null,
} = {}) {
  let modeSwitchBounceHandle = null;
  let maidBounceCount = 0;
  let maidBounceLastTime = 0;
  let modeSwitchSuppressClick = false;
  let modeSwitchDrag = null;
  let suppressClickTimer = null;
  let longPressTimer = null;

  const scheduleFrame = (fn) => {
    if (typeof requestAnimationFrameFn === 'function') return requestAnimationFrameFn(fn);
    return setTimeoutFn?.(() => fn(), 16) ?? null;
  };

  const cancelFrame = (handle) => {
    if (handle == null) return;
    if (typeof cancelAnimationFrameFn === 'function') {
      cancelAnimationFrameFn(handle);
      return;
    }
    clearTimeoutFn?.(handle);
  };

  const clearSuppressClickTimer = () => {
    if (suppressClickTimer == null) return;
    clearTimeoutFn?.(suppressClickTimer);
    suppressClickTimer = null;
  };

  const clearLongPressTimer = () => {
    if (longPressTimer == null) return;
    clearTimeoutFn?.(longPressTimer);
    longPressTimer = null;
  };

  const scheduleSuppressClickRelease = () => {
    clearSuppressClickTimer();
    suppressClickTimer = setTimeoutFn?.(() => {
      modeSwitchSuppressClick = false;
      suppressClickTimer = null;
    }, 220) ?? null;
  };

  const spawnMaidTumble = (sx, sy, ballVx, ballVy) => {
    const img = documentRef?.createElement?.('img');
    if (!img || !documentRef?.body?.appendChild) return null;
    img.src = MAID_TUMBLE_SRC;
    img.style.cssText = `position:fixed; width:${MAID_W}px; height:${MAID_H}px; z-index:26100; pointer-events:none; object-fit:contain; image-rendering:auto;`;
    documentRef.body.appendChild(img);

    let mx = sx - MAID_W / 2;
    let my = sy - MAID_H / 2;
    let mvx = ballVx * 0.5 + (randomFn() - 0.5) * 6;
    let mvy = ballVy * 0.5 - 3;
    const gravity = 0.35;
    const bounceElasticity = 0.45;
    const drag = 0.993;
    const startTime = nowFn();
    let fadeStarted = false;

    img.style.left = `${Math.round(mx)}px`;
    img.style.top = `${Math.round(my)}px`;

    const step = () => {
      const elapsed = nowFn() - startTime;
      if (!fadeStarted && elapsed > MAID_DURATION - 300) {
        fadeStarted = true;
        img.style.transition = 'opacity 0.3s ease';
        img.style.opacity = '0';
        setTimeoutFn?.(() => img.remove?.(), 350);
      }
      if (elapsed > MAID_DURATION) return;
      const { w, h } = getViewportSize();
      mvx *= drag;
      mvy = mvy * drag + gravity;
      mx += mvx;
      my += mvy;

      if (mx < 0) {
        mx = 0;
        mvx = -mvx * bounceElasticity;
      } else if (mx + MAID_W > w) {
        mx = w - MAID_W;
        mvx = -mvx * bounceElasticity;
      }
      if (my < 0) {
        my = 0;
        mvy = -mvy * bounceElasticity;
      } else if (my + MAID_H > h) {
        my = h - MAID_H;
        mvy = -mvy * bounceElasticity;
      }

      img.style.left = `${Math.round(mx)}px`;
      img.style.top = `${Math.round(my)}px`;
      scheduleFrame(step);
    };

    scheduleFrame(step);
    return img;
  };

  const cancelBounce = () => {
    if (modeSwitchBounceHandle != null) {
      cancelFrame(modeSwitchBounceHandle);
      modeSwitchBounceHandle = null;
    }
    modeSwitchEl?.classList.remove('is-bouncing');
  };

  const settleModeSwitch = () => {
    modeSwitchBounceHandle = null;
    modeSwitchEl?.classList.remove('is-bouncing');
    setModeSwitchPinned(true);
    saveModeSwitchPos();
    scheduleSettling(modeSwitchEl, setTimeoutFn);
  };

  const animateBounce = (startX, startY, vx, vy) => {
    if (!modeSwitchEl) return false;
    const prefersReduced = typeof matchMediaFn === 'function'
      && matchMediaFn('(prefers-reduced-motion: reduce)')?.matches;
    if (prefersReduced) {
      setModeSwitchPinned(true);
      saveModeSwitchPos();
      return false;
    }
    cancelBounce();

    const now = nowFn();
    if (now - maidBounceLastTime > 5000) maidBounceCount = 0;
    maidBounceLastTime = now;
    maidBounceCount += 1;
    if (maidBounceCount >= 6) {
      maidBounceCount = 0;
      spawnMaidTumble(startX, startY, vx, vy);
    }

    modeSwitchEl.classList.add('is-bouncing');
    const bounceElasticity = 0.7;
    const airFriction = 0.992;
    const minVelocity = 0.8;
    let x = startX;
    let y = startY;

    const step = () => {
      const { w, h } = getViewportSize();
      if (!w || !h) {
        modeSwitchBounceHandle = null;
        modeSwitchEl.classList.remove('is-bouncing');
        return;
      }
      const halfSize = getModeSwitchSize() / 2;
      const safeInsets = getSafeInsets();
      const minX = halfSize + safeInsets.left;
      const maxX = w - halfSize - safeInsets.right;
      const minY = halfSize + safeInsets.top;
      const maxY = h - halfSize - safeInsets.bottom;

      vx *= airFriction;
      vy *= airFriction;
      x += vx;
      y += vy;

      let hitBound = false;
      if (x < minX) {
        x = minX;
        vx = -vx * bounceElasticity;
        hitBound = true;
      } else if (x > maxX) {
        x = maxX;
        vx = -vx * bounceElasticity;
        hitBound = true;
      }
      if (y < minY) {
        y = minY;
        vy = -vy * bounceElasticity;
        hitBound = true;
      } else if (y > maxY) {
        y = maxY;
        vy = -vy * bounceElasticity;
        hitBound = true;
      }
      if (hitBound) vibrate?.(15);

      modeSwitchEl.style.left = `${Math.round(x)}px`;
      modeSwitchEl.style.top = `${Math.round(y)}px`;
      setModeSwitchPos(normalizeModeSwitchPos(x, y));

      if (Math.hypot(vx, vy) < minVelocity) {
        settleModeSwitch();
        return;
      }
      modeSwitchBounceHandle = scheduleFrame(step);
    };

    modeSwitchBounceHandle = scheduleFrame(step);
    return true;
  };

  const startDrag = (event, options = {}) => {
    if (!modeSwitchEl || !modeSwitchBtnEl) return false;
    if (event.pointerType === 'mouse' && event.button !== 0) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    cancelBounce();
    wakeModeSwitch();
    const rect = modeSwitchEl.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const now = nowFn();
    modeSwitchDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX,
      originY,
      moved: false,
      prevX: originX,
      prevY: originY,
      prevTime: now,
      lastX: originX,
      lastY: originY,
      lastTime: now,
      longPressActivated: false,
      suppressClickOnEnd: options?.suppressClick === true,
    };
    clearLongPressTimer();
    // 外部标题/拖柄转发的拖拽不参与长按（长按语义只属于模式球本体）。
    if (typeof onLongPress === 'function' && Number(longPressMs) > 0 && options?.suppressLongPress !== true) {
      longPressTimer = setTimeoutFn?.(() => {
        longPressTimer = null;
        if (!modeSwitchDrag || modeSwitchDrag.moved) return;
        modeSwitchDrag.longPressActivated = true;
        modeSwitchSuppressClick = true;
        onLongPress({
          event,
          x: modeSwitchDrag.lastX,
          y: modeSwitchDrag.lastY,
        });
      }, Math.max(0, Number(longPressMs) || 0)) ?? null;
    }
    modeSwitchEl.classList.add('is-dragging');
    modeSwitchBtnEl.setPointerCapture?.(event.pointerId);
    return true;
  };

  const updateDrag = (event) => {
    if (!modeSwitchDrag || !modeSwitchEl) return false;
    if (event.pointerId !== modeSwitchDrag.pointerId) return false;
    const dx = event.clientX - modeSwitchDrag.startX;
    const dy = event.clientY - modeSwitchDrag.startY;
    if (!modeSwitchDrag.moved && Math.hypot(dx, dy) > 4) modeSwitchDrag.moved = true;
    if (Math.hypot(dx, dy) > Math.max(1, Number(longPressMoveTolerance) || 8)) {
      clearLongPressTimer();
    }
    const { w, h } = getViewportSize();
    if (!w || !h) return false;
    const safeInsets = getSafeInsets();
    const base = 8 + getModeSwitchSize() / 2;
    const x = Math.min(w - base - safeInsets.right, Math.max(base + safeInsets.left, modeSwitchDrag.originX + dx));
    const y = Math.min(h - base - safeInsets.bottom, Math.max(base + safeInsets.top, modeSwitchDrag.originY + dy));
    modeSwitchEl.style.left = `${Math.round(x)}px`;
    modeSwitchEl.style.top = `${Math.round(y)}px`;
    modeSwitchEl.style.pointerEvents = 'auto';
    setModeSwitchPinned(true);
    setModeSwitchPos(normalizeModeSwitchPos(x, y));
    modeSwitchDrag.prevX = modeSwitchDrag.lastX;
    modeSwitchDrag.prevY = modeSwitchDrag.lastY;
    modeSwitchDrag.prevTime = modeSwitchDrag.lastTime;
    modeSwitchDrag.lastX = x;
    modeSwitchDrag.lastY = y;
    modeSwitchDrag.lastTime = nowFn();
    return true;
  };

  const endDrag = (event) => {
    if (!modeSwitchDrag || !modeSwitchEl) return false;
    if (event.pointerId !== modeSwitchDrag.pointerId) return false;
    clearLongPressTimer();
    modeSwitchBtnEl?.releasePointerCapture?.(event.pointerId);
    modeSwitchEl.classList.remove('is-dragging');
    if (modeSwitchDrag.longPressActivated) {
      modeSwitchSuppressClick = true;
      scheduleSuppressClickRelease();
    } else if (modeSwitchDrag.moved) {
      modeSwitchSuppressClick = true;
      const dt = Math.max(1, modeSwitchDrag.lastTime - modeSwitchDrag.prevTime);
      const vx = (modeSwitchDrag.lastX - modeSwitchDrag.prevX) / dt * 16;
      const vy = (modeSwitchDrag.lastY - modeSwitchDrag.prevY) / dt * 16;
      const speed = Math.hypot(vx, vy);
      if (speed > 8) {
        animateBounce(modeSwitchDrag.lastX, modeSwitchDrag.lastY, vx, vy);
      } else {
        saveModeSwitchPos();
        scheduleSettling(modeSwitchEl, setTimeoutFn);
      }
      scheduleSuppressClickRelease();
    } else if (modeSwitchDrag.suppressClickOnEnd) {
      modeSwitchSuppressClick = true;
      scheduleSuppressClickRelease();
    }
    modeSwitchDrag = null;
    wakeModeSwitch();
    if (modeSwitchBounceHandle == null) scheduleModeSwitchSync();
    return true;
  };

  const handleClick = () => {
    if (modeSwitchSuppressClick) return false;
    wakeModeSwitch();
    if (onClick?.() === true) return true;
    if (getUiMode() === 'rp') {
      exitRpMode();
    } else {
      enterRpMode();
    }
    return true;
  };

  const bind = () => {
    modeSwitchBtnEl?.addEventListener?.('pointerdown', startDrag);
    modeSwitchBtnEl?.addEventListener?.('pointermove', updateDrag);
    modeSwitchBtnEl?.addEventListener?.('pointerup', endDrag);
    modeSwitchBtnEl?.addEventListener?.('pointercancel', endDrag);
    modeSwitchBtnEl?.addEventListener?.('click', handleClick);
  };

  return {
    spawnMaidTumble,
    cancelBounce,
    animateBounce,
    startDrag,
    updateDrag,
    endDrag,
    handleClick,
    bind,
    isSuppressingClick: () => modeSwitchSuppressClick,
    hasBounceFrame: () => modeSwitchBounceHandle != null,
    getDragState: () => modeSwitchDrag,
    hasLongPressTimer: () => longPressTimer != null,
  };
}
