// 创意写作刻度导航（刻度条界面）。只负责画刻度和处理手势；条数、角色、预览内容、跳转由调用方提供。
// 手势：悬停/按住刻度看预览；按住省略号展开；按住移到新省略号停一下继续展开；
// 只有在已显示预览的刻度上松开才跳转，其余位置松开即取消并恢复。
import { t } from '../../i18n/index.js';
import { buildFollowItems, buildZoomItems, clipScrubberPreview } from './creative-scrubber-model.js';

const HOLD_MS = 320;
const DWELL_MS = 380;
const IDLE_MS = 1600;

export const createCreativeScrubber = ({
  documentRef = document,
  hostEl = null,
  scrollEl = null,
  // 刻度条下端要停在这些元素（输入框、继续按钮）上方
  getBottomGuards = () => [],
  getTotal = () => 0,
  getCurrent = () => 0,
  getRole = () => '',
  resolvePreview = async () => null,
  onJump = () => {},
  isCoarsePointer = () => Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches),
  prefersReducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
} = {}) => {
  if (!hostEl || !scrollEl) return null;
  const rail = documentRef.createElement('nav');
  rail.className = 'creative-scrubber';
  rail.setAttribute('aria-label', t('对话刻度导航'));
  rail.hidden = true;
  const preview = documentRef.createElement('div');
  preview.className = 'creative-scrubber-preview';
  preview.dataset.i18nSkip = '';
  preview.hidden = true;
  hostEl.append(rail, preview);

  let visible = false;
  let zoom = [];
  let hold = null;
  let armTimer = 0;
  let armedNode = null;
  let idleTimer = 0;
  let previewToken = 0;
  let lastSignature = '';

  const total = () => Math.max(0, Math.floor(Number(getTotal()) || 0));
  const current = () => Math.max(1, Math.min(total(), Math.floor(Number(getCurrent()) || total())));
  const roleClass = i => {
    const role = getRole(i);
    return role === 'user' ? 'is-user' : role === 'ai' ? 'is-ai' : 'is-unknown';
  };

  // 聊天区跳转过场会临时加上下位移：扣掉它，刻度条不跟着动
  const scrollShiftY = () => {
    try {
      const transform = globalThis.getComputedStyle?.(scrollEl)?.transform;
      return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
    } catch {
      return 0;
    }
  };

  const place = () => {
    const hostRect = hostEl.getBoundingClientRect();
    const raw = scrollEl.getBoundingClientRect();
    const shift = scrollShiftY();
    const rect = { top: raw.top - shift, bottom: raw.bottom - shift, right: raw.right };
    let bottom = rect.bottom;
    for (const el of getBottomGuards() || []) {
      const guard = el?.getBoundingClientRect?.();
      if (guard && guard.height > 0 && guard.top > rect.top + 120) bottom = Math.min(bottom, guard.top);
    }
    rail.style.top = `${Math.round(rect.top - hostRect.top + 12)}px`;
    rail.style.height = `${Math.max(120, Math.round(bottom - rect.top - 24))}px`;
    rail.style.right = `${Math.max(0, Math.round(hostRect.right - rect.right + 2))}px`;
  };

  const currentItems = () => (zoom.length
    ? buildZoomItems(zoom[zoom.length - 1], total(), current())
    : buildFollowItems(current(), total()));

  const render = () => {
    const cur = current();
    const frag = documentRef.createDocumentFragment();
    for (const item of currentItems()) {
      if (item.t === 'tick') {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = `creative-scrubber-tick ${roleClass(item.i)}${item.i === cur ? ' is-current' : ''}${item.enter ? ' is-entering' : ''}`;
        button.dataset.index = String(item.i);
        if (item.enter) button.style.setProperty('--scrubber-enter-delay', `${(item.order || 0) * 22}ms`);
        button.setAttribute('aria-label', t('第 {index} 条', { index: item.i }));
        button.append(documentRef.createElement('i'));
        frag.append(button);
      } else {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = `creative-scrubber-gap${item.enter ? ' is-entering' : ''}`;
        button.dataset.from = String(item.from);
        button.dataset.to = String(item.to);
        button.setAttribute('aria-label', t('按住展开 {count} 条', { count: item.to - item.from + 1 }));
        for (let k = 0; k < 3; k += 1) button.append(documentRef.createElement('b'));
        frag.append(button);
      }
    }
    rail.replaceChildren(frag);
    rail.classList.toggle('is-holding', Boolean(hold));
    rail.classList.toggle('is-animated', !prefersReducedMotion());
  };

  const hidePreview = () => {
    previewToken += 1;
    preview.hidden = true;
    delete preview.dataset.index;
  };

  const placePreview = anchor => {
    const hostRect = hostEl.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const height = preview.offsetHeight;
    const top = anchorRect.top - hostRect.top + anchorRect.height / 2 - height / 2;
    const minTop = railRect.top - hostRect.top;
    const maxTop = railRect.bottom - hostRect.top - height;
    preview.style.top = `${Math.round(Math.max(minTop, Math.min(maxTop, top)))}px`;
    preview.style.right = `${Math.round(hostRect.right - railRect.left + 8)}px`;
  };

  const renderPreview = (index, data) => {
    preview.replaceChildren();
    const head = documentRef.createElement('div');
    head.className = 'creative-scrubber-preview-head';
    const label = documentRef.createElement('span');
    label.textContent = data?.label || `#${index}`;
    const who = documentRef.createElement('span');
    who.textContent = data?.role === 'user' ? t('你') : data?.role === 'ai' ? 'AI' : '';
    head.append(label, who);
    preview.append(head);
    if (data?.chip) {
      const chip = documentRef.createElement('span');
      chip.className = `creative-scrubber-preview-chip${data.chipKind === 'body' ? ' is-body' : ''}`;
      chip.textContent = data.chip;
      preview.append(chip);
    }
    const text = documentRef.createElement('div');
    text.className = 'creative-scrubber-preview-text';
    text.textContent = data ? clipScrubberPreview(data.text) || t('（没有可显示的文字）') : '…';
    preview.append(text);
  };

  const showTickPreview = (index, anchor) => {
    const token = ++previewToken;
    preview.className = 'creative-scrubber-preview';
    preview.dataset.index = String(index);
    renderPreview(index, null);
    preview.hidden = false;
    placePreview(anchor);
    Promise.resolve()
      .then(() => resolvePreview(index))
      .then((data) => {
        if (token !== previewToken) return;
        renderPreview(index, data);
        if (anchor.isConnected) placePreview(anchor);
      })
      .catch(() => {});
  };

  const showGapHint = node => {
    previewToken += 1;
    const count = Number(node.dataset.to) - Number(node.dataset.from) + 1;
    preview.className = 'creative-scrubber-preview is-hint';
    delete preview.dataset.index;
    preview.textContent = hold ? t('停一下展开 · {count} 条', { count }) : t('按住展开 · {count} 条', { count });
    preview.hidden = false;
    placePreview(node);
  };

  const markHot = node => {
    rail.querySelectorAll('.is-hot').forEach(el => el.classList.remove('is-hot'));
    node?.classList.add('is-hot');
  };

  const nodeAtPoint = (x, y, { lenient = false } = {}) => {
    const rect = rail.getBoundingClientRect();
    // pointer capture 会继续收到刻度条外的移动和松开，先检查真实指针是否仍在条内。
    // 手指按住拖动（lenient）：条很窄，手指容易往左偏，横向放宽；上下拖过头停在第一条/最后一条。
    const left = rect.left - (lenient ? 60 : 0);
    const right = rect.right + (lenient ? 24 : 0);
    if (x < left || x > right) return null;
    let probeY = y;
    if (lenient) {
      const first = rail.children?.[0]?.getBoundingClientRect?.();
      const last = rail.children?.[rail.children.length - 1]?.getBoundingClientRect?.();
      if (first && y < first.top) probeY = first.top + first.height / 2;
      else if (last && y > last.bottom) probeY = last.top + last.height / 2;
    } else if (y < rect.top || y > rect.bottom) {
      return null;
    }
    const el = documentRef.elementFromPoint(rect.right - 12, probeY);
    return el?.closest?.('.creative-scrubber-tick, .creative-scrubber-gap') || null;
  };
  const isLenientHold = () => Boolean(hold && hold.pointerType && hold.pointerType !== 'mouse');

  const disarm = () => {
    clearTimeout(armTimer);
    armedNode?.classList.remove('is-arming');
    armedNode = null;
  };

  const trackAt = (x, y) => {
    const node = nodeAtPoint(x, y, { lenient: isLenientHold() });
    if (!node || !rail.contains(node)) {
      disarm();
      markHot(null);
      hidePreview();
      return;
    }
    markHot(node);
    if (node.classList.contains('creative-scrubber-tick')) {
      disarm();
      showTickPreview(Number(node.dataset.index), node);
      return;
    }
    showGapHint(node);
    if (!hold) return;
    // 展开后刻度重排，手指底下可能又是省略号：要再移动一点才会继续展开
    if (hold.freezeY != null && Math.abs(y - hold.freezeY) < 8) return;
    hold.freezeY = null;
    armGap(node, DWELL_MS);
  };

  const armGap = (node, delay) => {
    if (armedNode === node) return;
    disarm();
    armedNode = node;
    node.classList.add('is-arming');
    const range = { from: Number(node.dataset.from), to: Number(node.dataset.to) };
    armTimer = setTimeout(() => {
      disarm();
      if (!hold) return;
      hold.freezeY = hold.lastY;
      zoom.push(range);
      render();
      hidePreview();
      trackAt(hold.lastX, hold.lastY);
    }, delay);
  };

  const wake = () => {
    rail.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (!isCoarsePointer()) return;
    idleTimer = setTimeout(function fade() {
      if (hold) {
        idleTimer = setTimeout(fade, 800);
        return;
      }
      rail.classList.add('is-idle');
      hidePreview();
    }, IDLE_MS);
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const node = event.target.closest?.('.creative-scrubber-tick, .creative-scrubber-gap');
    if (!node) return;
    event.preventDefault();
    hold = { pointerId: event.pointerId, pointerType: event.pointerType || '', startY: event.clientY, lastX: event.clientX, lastY: event.clientY, freezeY: null };
    try { rail.setPointerCapture(event.pointerId); } catch {}
    rail.classList.add('is-holding');
    wake();
    markHot(node);
    if (node.classList.contains('creative-scrubber-gap')) {
      showGapHint(node);
      armGap(node, HOLD_MS);
    } else {
      showTickPreview(Number(node.dataset.index), node);
    }
  };

  const onPointerMove = (event) => {
    if (hold) {
      hold.lastX = event.clientX;
      hold.lastY = event.clientY;
      trackAt(event.clientX, event.clientY);
      return;
    }
    if (event.pointerType === 'mouse') trackAt(event.clientX, event.clientY);
  };

  const finish = (event, cancelled) => {
    if (!hold) return;
    const { pointerId } = hold;
    const lenient = isLenientHold();
    hold = null;
    disarm();
    try { rail.releasePointerCapture(pointerId); } catch {}
    rail.classList.remove('is-holding');
    const target = !cancelled && preview.dataset.index ? Number(preview.dataset.index) : 0;
    const node = nodeAtPoint(event.clientX, event.clientY, { lenient });
    const releasedOnPreviewedTick = target > 0
      && node?.classList.contains('creative-scrubber-tick')
      && Number(node.dataset.index) === target;
    hidePreview();
    markHot(null);
    zoom = [];
    render();
    if (releasedOnPreviewedTick) onJump(target);
  };

  const onPointerUp = event => finish(event, false);
  const onPointerCancel = event => finish(event, true);
  const onPointerLeave = (event) => {
    if (hold || event.pointerType !== 'mouse') return;
    markHot(null);
    hidePreview();
  };

  let wheelAt = 0;
  const onWheel = (event) => {
    event.preventDefault();
    if (hold) return;
    const now = Date.now();
    if (now - wheelAt < 80) return;
    wheelAt = now;
    const next = Math.max(1, Math.min(total(), current() + (event.deltaY > 0 ? 1 : -1)));
    if (next !== current()) onJump(next);
  };

  // 键盘：Tab 到刻度看预览、Enter 跳转；省略号 Enter 展开，Esc 收起
  const onClick = (event) => {
    if (event.detail !== 0) return;
    const node = event.target.closest?.('.creative-scrubber-tick, .creative-scrubber-gap');
    if (!node) return;
    if (node.classList.contains('creative-scrubber-gap')) {
      zoom.push({ from: Number(node.dataset.from), to: Number(node.dataset.to) });
      render();
      rail.querySelector('.creative-scrubber-tick')?.focus();
      return;
    }
    zoom = [];
    hidePreview();
    onJump(Number(node.dataset.index));
  };
  const onFocusIn = (event) => {
    const node = event.target.closest?.('.creative-scrubber-tick, .creative-scrubber-gap');
    if (!node || hold) return;
    markHot(node);
    if (node.classList.contains('creative-scrubber-tick')) showTickPreview(Number(node.dataset.index), node);
    else showGapHint(node);
  };
  const onFocusOut = () => { if (!hold) hidePreview(); };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || !zoom.length || hold) return;
    zoom = [];
    hidePreview();
    render();
  };

  rail.addEventListener('pointerdown', onPointerDown);
  rail.addEventListener('pointermove', onPointerMove);
  rail.addEventListener('pointerup', onPointerUp);
  rail.addEventListener('pointercancel', onPointerCancel);
  rail.addEventListener('pointerleave', onPointerLeave);
  rail.addEventListener('wheel', onWheel, { passive: false });
  rail.addEventListener('click', onClick);
  rail.addEventListener('focusin', onFocusIn);
  rail.addEventListener('focusout', onFocusOut);
  rail.addEventListener('keydown', onKeyDown);

  // 刷新：条数或阅读位置变了才重画；按住期间不打断展开中的刻度
  const refresh = ({ force = false } = {}) => {
    if (!visible) return;
    place();
    if (hold || zoom.length) return;
    const signature = `${total()}:${current()}`;
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    render();
  };

  const setVisible = (next) => {
    const show = Boolean(next) && total() > 1;
    if (show === visible) {
      // 已经在显示：只按需刷新，不强制重画（滚动时每帧都会走到这里）
      if (show) refresh();
      return;
    }
    visible = show;
    rail.hidden = !show;
    if (!show) {
      hidePreview();
      zoom = [];
      hold = null;
      lastSignature = '';
      return;
    }
    refresh({ force: true });
  };

  return {
    refresh,
    setVisible,
    wake,
    isHolding: () => Boolean(hold),
    destroy() {
      clearTimeout(armTimer);
      clearTimeout(idleTimer);
      rail.remove();
      preview.remove();
    },
  };
};
