// 创意写作刻度导航（刻度条界面）。只负责画刻度和处理手势；条数、角色、预览内容、跳转由调用方提供。
// 刻度紧凑排列（固定间距、整条居中，手机略放低）；按住时按住处向左鼓出一段弧，悬停不鼓起。
// 手势：悬停/按住刻度看预览；按住省略号展开；按住移到新省略号停一下继续展开；
// 只有在已显示预览的刻度上松开才跳转，其余位置松开即取消并恢复。
// 不在底部时最后一道刻度下面多一个回底箭头。手机上停下后缩成细线（仍可点），细线状态轻点一下只唤醒。
import { t } from '../../i18n/index.js';
import {
  SCRUBBER_ARC,
  buildFollowItems,
  buildZoomItems,
  clipScrubberPreview,
  layoutScrubberItems,
  pickScrubberItem,
  scrubberLens,
  touchArcForContact,
} from './creative-scrubber-model.js';

const HOLD_MS = 320;
const DWELL_MS = 380;
const IDLE_MS = 1600;
// 鼠标单击不该闪一下弧：按住超过这么久才鼓出；手指按下立即鼓出
const MOUSE_LENS_DELAY_MS = 120;
// 细线状态下按下不到这么久、也没拖动就松开＝只唤醒
const TAP_MS = 250;
const RAIL_WIDTH = 40;
const COARSE_RAIL_WIDTH = 30;
// 手机上整条放低一些，方便拇指
const COARSE_CENTER_RATIO = 0.64;
// 刻度长度：[平时, 当前阅读, 指着]
const TICK_LENGTHS = { user: [9, 13, 15], ai: [17, 23, 25], unknown: [13, 13, 15] };

export const createCreativeScrubber = ({
  documentRef = document,
  hostEl = null,
  scrollEl = null,
  // 刻度条下端要停在这些元素（输入框、继续按钮）上方
  getBottomGuards = () => [],
  getTotal = () => 0,
  getCurrent = () => 0,
  getRole = () => '',
  // 已经看到最底部时不显示回底箭头
  isAtBottom = () => true,
  resolvePreview = async () => null,
  onJump = () => {},
  onJumpToBottom = () => {},
  isCoarsePointer = () => Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches),
  prefersReducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
  requestFrame = callback => (typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(callback)
    : setTimeout(callback, 16)),
  cancelFrame = id => (typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame(id)
    : clearTimeout(id)),
} = {}) => {
  if (!hostEl || !scrollEl) return null;
  const rail = documentRef.createElement('nav');
  rail.className = 'creative-scrubber';
  rail.setAttribute('aria-label', t('对话刻度导航'));
  rail.hidden = true;
  const glow = documentRef.createElement('div');
  glow.className = 'creative-scrubber-glow';
  const itemsEl = documentRef.createElement('div');
  itemsEl.className = 'creative-scrubber-items';
  // 只有这一块接收指针：范围是刻度实际占的高度，不占满整个右缘
  const hit = documentRef.createElement('div');
  hit.className = 'creative-scrubber-hit';
  rail.append(glow, itemsEl, hit);
  const preview = documentRef.createElement('div');
  preview.className = 'creative-scrubber-preview';
  preview.dataset.i18nSkip = '';
  preview.hidden = true;
  hostEl.append(rail, preview);

  const now = () => globalThis.performance?.now?.() ?? Date.now();
  let visible = false;
  let zoom = [];
  let hold = null;
  let armTimer = 0;
  let armedKey = '';
  let idleTimer = 0;
  let lensTimer = 0;
  let previewToken = 0;
  let lastSignature = '';
  let railWidth = RAIL_WIDTH;
  let railHeight = 0;
  // 画面上的项目：key -> { item, el, bar, baseY, y, dx, rot, len, op, spawnY, delayUntil, dying, dieY }
  const nodes = new Map();
  // 当前排列（未加凸起）：[{ key, item, y }]，用来判断指针对着哪一项
  let entries = [];
  let pitch = 0;
  let hotKey = '';
  let frame = 0;
  let lensStrength = 0;
  let lensTarget = 0;
  let focusY = 0;
  let focusShown = 0;
  // 当前凸起的弧：鼠标用固定的小弧；手指按住时按接触面大小拉出到手指外面
  let arc = SCRUBBER_ARC;
  let contactMax = 0;
  let edgeAtDown = 0;
  const contactSizeOf = event => Math.max(Number(event?.width) || 0, Number(event?.height) || 0);

  const total = () => Math.max(0, Math.floor(Number(getTotal()) || 0));
  const current = () => Math.max(1, Math.min(total(), Math.floor(Number(getCurrent()) || total())));
  const roleOf = (i) => {
    const role = getRole(i);
    return role === 'user' || role === 'ai' ? role : 'unknown';
  };
  const keyOf = item => (item.t === 'end' ? 'end' : item.t === 'tick' ? `t${item.i}` : `g${item.from}-${item.to}`);
  const covers = (gap, item) => gap.t === 'gap' && (item.t === 'tick'
    ? item.i >= gap.from && item.i <= gap.to
    : item.t === 'gap' && item.from >= gap.from && item.to <= gap.to);
  const isMouseHold = h => !h?.pointerType || h.pointerType === 'mouse';

  // 聊天区跳转过场会临时加上下位移：扣掉它，刻度条不跟着动
  const scrollShiftY = () => {
    try {
      const transform = globalThis.getComputedStyle?.(scrollEl)?.transform;
      return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
    } catch {
      return 0;
    }
  };

  // 刻度条占住聊天区右缘可用的高度；返回高度是否变了
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
    railWidth = isCoarsePointer() ? COARSE_RAIL_WIDTH : RAIL_WIDTH;
    const height = Math.max(120, Math.round(bottom - rect.top - 24));
    rail.style.top = `${Math.round(rect.top - hostRect.top + 12)}px`;
    rail.style.height = `${height}px`;
    rail.style.width = `${railWidth}px`;
    rail.style.right = `${Math.max(0, Math.round(hostRect.right - rect.right + 2))}px`;
    const changed = height !== railHeight;
    railHeight = height;
    return changed;
  };

  const currentItems = () => {
    const items = zoom.length
      ? buildZoomItems(zoom[zoom.length - 1], total(), current())
      : buildFollowItems(current(), total());
    if (!isAtBottom()) items.push({ t: 'end' });
    return items;
  };

  const lengthOf = (node, coarse) => {
    if (node.item.t !== 'tick') return 0;
    const [rest, reading, hot] = TICK_LENGTHS[roleOf(node.item.i)];
    const base = node.key === hotKey ? hot : node.item.i === current() ? reading : rest;
    return coarse ? base * 0.8 : base;
  };

  const makeElement = (item) => {
    const el = documentRef.createElement('button');
    el.type = 'button';
    el.dataset.key = keyOf(item);
    let bar;
    if (item.t === 'tick') {
      el.className = `creative-scrubber-tick is-${roleOf(item.i)}`;
      el.setAttribute('aria-label', t('第 {index} 条', { index: item.i }));
      bar = documentRef.createElement('i');
    } else if (item.t === 'end') {
      el.className = 'creative-scrubber-end';
      el.setAttribute('aria-label', t('回到底部'));
      bar = documentRef.createElement('span');
      bar.className = 'creative-scrubber-chevron';
    } else {
      el.className = 'creative-scrubber-gap';
      el.setAttribute('aria-label', t('按住展开 {count} 条', { count: item.to - item.from + 1 }));
      bar = documentRef.createElement('span');
      bar.className = 'creative-scrubber-dots';
      for (let k = 0; k < 3; k += 1) bar.append(documentRef.createElement('b'));
    }
    el.append(bar);
    return { el, bar };
  };

  const syncHot = () => {
    for (const node of nodes.values()) node.el.classList.toggle('is-hot', node.key === hotKey);
  };
  const markHot = (key) => {
    if (key === hotKey) return;
    hotKey = key;
    syncHot();
    kick();
  };

  const render = () => {
    const items = currentItems();
    const coarse = isCoarsePointer();
    const layout = layoutScrubberItems(items, railHeight, { centerRatio: coarse ? COARSE_CENTER_RATIO : 0.5 });
    pitch = layout.pitch;
    const fresh = nodes.size === 0;
    const startedAt = now();
    const oldGaps = [...nodes.values()].filter(node => !node.dying && node.item.t === 'gap');
    const reading = current();
    const live = new Set();
    entries = items.map((item, k) => {
      const key = keyOf(item);
      live.add(key);
      let node = nodes.get(key);
      if (node?.dying) {
        node.el.remove();
        nodes.delete(key);
        node = null;
      }
      if (!node) {
        // 新出现的刻度从原来那个省略号的位置长出来；第一次画时直接就位
        const from = fresh ? null : oldGaps.find(gap => covers(gap.item, item));
        const y = from ? from.y : layout.ys[k];
        node = {
          key, item, ...makeElement(item),
          baseY: y, y, dx: from ? from.dx : 0, rot: 0, len: 0, op: fresh ? 1 : 0,
          spawnY: y, delayUntil: item.enter ? startedAt + (item.order || 0) * 22 : 0, dying: false, dieY: 0,
        };
        nodes.set(key, node);
        if (fresh) node.len = lengthOf(node, coarse);
      }
      node.item = item;
      node.baseY = layout.ys[k];
      if (item.t === 'tick') node.el.classList.toggle('is-current', item.i === reading);
      return { key, item, y: layout.ys[k] };
    });
    // 消失的项目收进新的省略号里
    for (const node of nodes.values()) {
      if (live.has(node.key) || node.dying) continue;
      node.dying = true;
      node.dieY = entries.find(entry => covers(entry.item, node.item))?.y ?? node.y;
    }
    // DOM 顺序与画面顺序一致（键盘 Tab）
    const ordered = entries.map(entry => nodes.get(entry.key).el);
    const shown = [...itemsEl.children].filter(el => ordered.includes(el));
    if (shown.length !== ordered.length || shown.some((el, k) => el !== ordered[k])) itemsEl.append(...ordered);
    if (entries.length) {
      const first = entries[0].y;
      const last = entries[entries.length - 1].y;
      const extra = coarse ? 8 : 0;
      hit.style.top = `${Math.round(first - pitch / 2 - 8)}px`;
      hit.style.height = `${Math.round(last - first + pitch + 16)}px`;
      hit.style.left = `${-extra}px`;
      hit.style.width = `${railWidth + extra}px`;
    }
    rail.classList.toggle('is-holding', Boolean(hold));
    if (hotKey && !live.has(hotKey)) hotKey = '';
    syncHot();
    kick();
  };

  // 逐帧把每一项缓动到目标位置；按住时套上凸起
  function step() {
    frame = 0;
    if (!visible) return;
    const snap = prefersReducedMotion();
    const coarse = isCoarsePointer();
    const ease = snap ? 1 : 0.28;
    lensStrength = snap ? lensTarget : lensStrength + (lensTarget - lensStrength) * 0.2;
    if (Math.abs(lensTarget - lensStrength) < 0.004) lensStrength = lensTarget;
    focusShown = snap || lensStrength < 0.02 ? focusY : focusShown + (focusY - focusShown) * 0.5;
    const resting = rail.classList.contains('is-rest');
    const at = now();
    let busy = false;
    for (const node of [...nodes.values()]) {
      let y = node.baseY, dx = 0, rot = 0, lenF = 1, op = 1;
      if (node.dying) {
        y = node.dieY;
        lenF = 0;
        op = 0;
      } else if (node.delayUntil && at < node.delayUntil) {
        y = node.spawnY;
        lenF = 0;
        op = 0;
        busy = true;
      } else if (lensStrength > 0.001) {
        const lens = scrubberLens(node.baseY, focusShown, lensStrength, arc);
        y = lens.y;
        dx = lens.dx;
        rot = node.item.t === 'end' ? 0 : lens.rot;
        lenF = lens.lenF;
      }
      if (resting) {
        lenF *= 0.45;
        op = Math.min(op, 0.55);
      }
      const len = lengthOf(node, coarse) * lenF;
      if (snap) {
        Object.assign(node, { y, dx, rot, len, op });
      } else {
        node.y += (y - node.y) * ease;
        node.dx += (dx - node.dx) * ease;
        node.rot += (rot - node.rot) * ease;
        node.len += (len - node.len) * ease;
        node.op += (op - node.op) * 0.25;
      }
      if (Math.abs(y - node.y) > 0.2 || Math.abs(dx - node.dx) > 0.2 || Math.abs(len - node.len) > 0.2 || Math.abs(op - node.op) > 0.01) busy = true;
      node.el.style.transform = `translateY(${node.y.toFixed(2)}px)`;
      node.el.style.opacity = node.op.toFixed(3);
      if (node.item.t === 'tick') node.bar.style.width = `${Math.max(0, node.len).toFixed(2)}px`;
      node.bar.style.transform = `translateX(${(-node.dx).toFixed(2)}px) rotate(${node.rot.toFixed(4)}rad)`;
      if (node.dying && (snap || node.op < 0.03)) {
        node.el.remove();
        nodes.delete(node.key);
      }
    }
    // 弧形背后的光晕：压住正文，让鼓出来的刻度看得清
    const radius = arc.bulge + 56;
    glow.style.width = `${radius * 2}px`;
    glow.style.height = `${radius * 2}px`;
    glow.style.transform = `translate(${railWidth + 2 - radius}px, ${(focusShown - radius).toFixed(2)}px)`;
    glow.style.opacity = lensStrength.toFixed(3);
    if (busy || lensStrength !== lensTarget || (lensStrength > 0 && Math.abs(focusShown - focusY) > 0.3)) kick();
  }
  function kick() {
    if (!frame && visible) frame = requestFrame(step) || 0;
  }

  const hidePreview = () => {
    previewToken += 1;
    preview.hidden = true;
    delete preview.dataset.index;
    delete preview.dataset.end;
  };

  // 预览在刻度左侧、与指着的那一项同高；手指按住时放在手指上方免得被挡住，上面放不下才放到下方
  const placePreview = (entry) => {
    const hostRect = hostEl.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const railTop = railRect.top - hostRect.top;
    const bulge = (arc.bulge + 14) * lensTarget;
    preview.style.right = `${Math.round(hostRect.right - railRect.left + 8 + bulge)}px`;
    const height = preview.offsetHeight || 0;
    let top;
    if (hold && !isMouseHold(hold)) {
      top = railTop + hold.y - height - 44;
      if (top < railTop - 6) top = railTop + hold.y + 44;
    } else {
      top = railTop + (hold && lensTarget > 0 ? hold.y : entry.y) - height / 2;
    }
    const minTop = railTop - 6;
    const maxTop = railTop + railHeight + 6 - height;
    preview.style.top = `${Math.round(Math.max(minTop, Math.min(maxTop, top)))}px`;
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

  const showTickPreview = (index, entry) => {
    if (!preview.hidden && preview.dataset.index === String(index)) {
      placePreview(entry);
      return;
    }
    const token = ++previewToken;
    preview.className = 'creative-scrubber-preview';
    preview.dataset.index = String(index);
    delete preview.dataset.end;
    renderPreview(index, null);
    preview.hidden = false;
    placePreview(entry);
    Promise.resolve()
      .then(() => resolvePreview(index))
      .then((data) => {
        if (token !== previewToken) return;
        renderPreview(index, data);
        placePreview(entry);
      })
      .catch(() => {});
  };

  const showHint = (entry, text) => {
    previewToken += 1;
    preview.className = 'creative-scrubber-preview is-hint';
    delete preview.dataset.index;
    delete preview.dataset.end;
    preview.textContent = text;
    preview.hidden = false;
    placePreview(entry);
  };
  const showGapHint = (entry) => {
    const count = entry.item.to - entry.item.from + 1;
    showHint(entry, hold ? t('停一下展开 · {count} 条', { count }) : t('按住展开 · {count} 条', { count }));
  };
  const showEndHint = (entry) => {
    showHint(entry, hold ? t('松开回到底部') : t('回到底部'));
    preview.dataset.end = '1';
  };

  const toRail = (event) => {
    const rect = rail.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const entryAt = (x, y, h = hold) => pickScrubberItem(entries, {
    x,
    y,
    width: railWidth,
    pitch,
    lenient: Boolean(h) && !isMouseHold(h),
    extraLeft: (arc.bulge + 30) * lensTarget,
  });
  const clampFocus = (y) => {
    if (!entries.length) return y;
    return Math.max(entries[0].y - pitch, Math.min(entries[entries.length - 1].y + pitch, y));
  };

  const disarm = () => {
    clearTimeout(armTimer);
    if (armedKey) nodes.get(armedKey)?.el.classList.remove('is-arming');
    armedKey = '';
  };

  const trackAt = (x, y, { initial = false } = {}) => {
    const entry = entryAt(x, y);
    if (!entry) {
      disarm();
      markHot('');
      hidePreview();
      return;
    }
    markHot(entry.key);
    if (entry.item.t === 'tick') {
      disarm();
      showTickPreview(entry.item.i, entry);
      return;
    }
    if (entry.item.t === 'end') {
      disarm();
      showEndHint(entry);
      return;
    }
    showGapHint(entry);
    if (!hold) return;
    // 展开后刻度重排，手指底下可能又是省略号：要再移动一点才会继续展开
    if (hold.freezeY != null && Math.abs(y - hold.freezeY) < 8) return;
    hold.freezeY = null;
    armGap(entry, initial ? HOLD_MS : DWELL_MS);
  };

  const armGap = (entry, delay) => {
    if (armedKey === entry.key) return;
    disarm();
    armedKey = entry.key;
    nodes.get(entry.key)?.el.classList.add('is-arming');
    const range = { from: entry.item.from, to: entry.item.to };
    armTimer = setTimeout(() => {
      disarm();
      if (!hold) return;
      hold.freezeY = hold.y;
      zoom.push(range);
      render();
      hidePreview();
      trackAt(hold.x, hold.y);
    }, delay);
  };

  const wake = () => {
    clearTimeout(idleTimer);
    if (rail.classList.contains('is-rest')) {
      rail.classList.remove('is-rest');
      kick();
    }
    if (!isCoarsePointer()) return;
    idleTimer = setTimeout(function rest() {
      if (hold) {
        idleTimer = setTimeout(rest, 800);
        return;
      }
      rail.classList.add('is-rest');
      hidePreview();
      markHot('');
      if (zoom.length) {
        zoom = [];
        render();
      }
      kick();
    }, IDLE_MS);
  };

  // 细线状态按下：轻点只唤醒；按住不放或开始拖动才进入刻度操作
  const engage = () => {
    clearTimeout(lensTimer);
    if (!hold?.waking) return;
    hold.waking = false;
    lensTarget = 1;
    trackAt(hold.x, hold.y, { initial: true });
    kick();
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { x, y } = toRail(event);
    hold = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || '',
      x, y, startX: x, startY: y,
      moved: false,
      waking: false,
      freezeY: null,
    };
    try { hit.setPointerCapture(event.pointerId); } catch {}
    rail.classList.add('is-holding');
    // 弧拉多远：位置只按按下处算一次，免得手指往弧那边移时弧又往外跑
    if (isMouseHold(hold)) {
      arc = SCRUBBER_ARC;
    } else {
      edgeAtDown = Math.max(0, railWidth - x);
      contactMax = contactSizeOf(event);
      arc = touchArcForContact({ contact: contactMax, edge: edgeAtDown });
    }
    const resting = rail.classList.contains('is-rest');
    wake();
    focusY = clampFocus(y);
    focusShown = focusY;
    clearTimeout(lensTimer);
    if (isMouseHold(hold)) {
      lensTimer = setTimeout(() => {
        if (!hold) return;
        lensTarget = 1;
        trackAt(hold.x, hold.y);
        kick();
      }, MOUSE_LENS_DELAY_MS);
      trackAt(x, y, { initial: true });
    } else if (resting) {
      hold.waking = true;
      lensTimer = setTimeout(engage, TAP_MS);
    } else {
      lensTarget = 1;
      trackAt(x, y, { initial: true });
    }
    kick();
  };

  const onPointerMove = (event) => {
    const { x, y } = toRail(event);
    if (hold) {
      if (event.pointerId !== hold.pointerId) return;
      hold.x = x;
      hold.y = y;
      if (!hold.moved && Math.hypot(x - hold.startX, y - hold.startY) > 6) hold.moved = true;
      // 按住期间手指压扁、接触面变大时弧跟着拉长，只长不缩
      const size = isMouseHold(hold) ? 0 : contactSizeOf(event);
      if (size > contactMax) {
        contactMax = size;
        arc = touchArcForContact({ contact: contactMax, edge: edgeAtDown });
      }
      if (hold.waking) {
        if (hold.moved) engage();
        return;
      }
      focusY = clampFocus(y);
      trackAt(x, y);
      kick();
      return;
    }
    if (event.pointerType === 'mouse') trackAt(x, y);
  };

  const finish = (event, cancelled) => {
    if (!hold) return;
    const h = hold;
    const { x, y } = toRail(event);
    const active = !cancelled && !h.waking;
    const target = active && preview.dataset.index ? Number(preview.dataset.index) : 0;
    const toBottom = active && preview.dataset.end === '1';
    const entry = target || toBottom ? entryAt(x, y, h) : null;
    const releasedOnPreviewedTick = target > 0 && entry?.item.t === 'tick' && entry.item.i === target;
    const releasedOnEnd = toBottom && entry?.item.t === 'end';
    hold = null;
    clearTimeout(lensTimer);
    disarm();
    try { hit.releasePointerCapture(h.pointerId); } catch {}
    rail.classList.remove('is-holding');
    lensTarget = 0;
    hidePreview();
    markHot('');
    zoom = [];
    render();
    wake();
    if (releasedOnPreviewedTick) onJump(target);
    else if (releasedOnEnd) onJumpToBottom();
  };

  const onPointerUp = event => finish(event, false);
  const onPointerCancel = event => finish(event, true);
  const onPointerLeave = (event) => {
    if (hold || event.pointerType !== 'mouse') return;
    markHot('');
    hidePreview();
  };

  let wheelAt = 0;
  const onWheel = (event) => {
    event.preventDefault();
    if (hold) return;
    const stamp = Date.now();
    if (stamp - wheelAt < 80) return;
    wheelAt = stamp;
    const next = Math.max(1, Math.min(total(), current() + (event.deltaY > 0 ? 1 : -1)));
    if (next !== current()) onJump(next);
  };

  // 键盘：Tab 到刻度看预览、Enter 跳转；省略号 Enter 展开，Esc 收起
  const entryOf = el => entries.find(entry => entry.key === el?.dataset?.key) || null;
  const onClick = (event) => {
    if (event.detail !== 0) return;
    const entry = entryOf(event.target.closest?.('[data-key]'));
    if (!entry) return;
    if (entry.item.t === 'gap') {
      zoom.push({ from: entry.item.from, to: entry.item.to });
      render();
      itemsEl.querySelector('.creative-scrubber-tick')?.focus();
      return;
    }
    zoom = [];
    hidePreview();
    if (entry.item.t === 'end') onJumpToBottom();
    else onJump(entry.item.i);
  };
  const onFocusIn = (event) => {
    const entry = entryOf(event.target.closest?.('[data-key]'));
    if (!entry || hold) return;
    wake();
    markHot(entry.key);
    if (entry.item.t === 'tick') showTickPreview(entry.item.i, entry);
    else if (entry.item.t === 'end') showEndHint(entry);
    else showGapHint(entry);
  };
  const onFocusOut = () => { if (!hold) hidePreview(); };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || !zoom.length || hold) return;
    zoom = [];
    hidePreview();
    render();
  };

  hit.addEventListener('pointerdown', onPointerDown);
  hit.addEventListener('pointermove', onPointerMove);
  hit.addEventListener('pointerup', onPointerUp);
  hit.addEventListener('pointercancel', onPointerCancel);
  hit.addEventListener('pointerleave', onPointerLeave);
  hit.addEventListener('wheel', onWheel, { passive: false });
  rail.addEventListener('click', onClick);
  rail.addEventListener('focusin', onFocusIn);
  rail.addEventListener('focusout', onFocusOut);
  rail.addEventListener('keydown', onKeyDown);

  // 刷新：条数、阅读位置、是否在底部或可用高度变了才重排；按住期间不打断展开中的刻度
  const refresh = ({ force = false } = {}) => {
    if (!visible) return;
    const resized = place();
    if (hold || zoom.length) return;
    const signature = `${total()}:${current()}:${isAtBottom() ? 1 : 0}`;
    if (!force && !resized && signature === lastSignature) return;
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
      disarm();
      clearTimeout(lensTimer);
      clearTimeout(idleTimer);
      zoom = [];
      hold = null;
      lensTarget = 0;
      lensStrength = 0;
      rail.classList.remove('is-holding', 'is-rest');
      lastSignature = '';
      return;
    }
    refresh({ force: true });
    wake();
  };

  return {
    refresh,
    setVisible,
    wake,
    isHolding: () => Boolean(hold),
    destroy() {
      clearTimeout(armTimer);
      clearTimeout(idleTimer);
      clearTimeout(lensTimer);
      if (frame) cancelFrame(frame);
      frame = 0;
      visible = false;
      rail.remove();
      preview.remove();
    },
  };
};
