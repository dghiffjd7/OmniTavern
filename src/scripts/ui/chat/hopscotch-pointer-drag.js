import { t } from '../../i18n/index.js';
import { listHopscotchDropTargets } from './hopscotch-drag-utils.js';
import { renderHopscotchCourt } from './hopscotch-court-view.js';

// 使用 viewport 坐标：同时适配窄屏缩放、滚动容器和 AC 浮层。
// 拖动期间只更新浮层，草稿仅在松手且落点仍合法时提交一次。
export const bindHopscotchPointerDrag = ({ root, getBoard, canDrag, getCapabilities = () => ({}), getActivation, onDrop }) => {
  const doc = root.ownerDocument, win = doc.defaultView;
  let press = null, drag = null, holdTimer = 0, frame = 0, suppressClickUntil = 0;
  const byData = (selector, key, value) => [...root.querySelectorAll(selector)].find(el => el.dataset[key] === value);
  const rectOf = el => el?.getBoundingClientRect();
  const visibleBoard = () => {
    const court = root.querySelector('.hop-court-scroll'), box = rectOf(court);
    if (!box) return null;
    const bounds = { left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(win.innerWidth, box.right), bottom: Math.min(win.innerHeight, box.bottom) };
    for (let el = court.parentElement; el; el = el.parentElement) {
      const style = win.getComputedStyle(el), rect = rectOf(el);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { bounds.top = Math.max(bounds.top, rect.top); bounds.bottom = Math.min(bounds.bottom, rect.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { bounds.left = Math.max(bounds.left, rect.left); bounds.right = Math.min(bounds.right, rect.right); }
    }
    return bounds;
  };
  const label = target => target.type === 'fuse' ? t('融合 · 共享请求') : target.type === 'gap' ? t('新增一行') : t('并行');
  const place = (el, box) => Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  const stop = () => {
    win.clearTimeout(holdTimer); win.cancelAnimationFrame(frame);
    holdTimer = frame = 0;
    if (drag) {
      suppressClickUntil = Date.now() + 450;
      drag.source.classList.remove('is-drag-source');
      drag.source.removeAttribute('aria-grabbed');
      drag.mergeHost?.classList.remove('is-merge-host');
      drag.layer.remove(); root.classList.remove('is-dragging');
    }
    const previous = press;
    press = null; drag = null;
    try { previous?.element.releasePointerCapture(previous.id); } catch {}
  };
  const geometry = target => {
    const rows = [...root.querySelectorAll('[data-hop-row-id]')];
    if (target.type === 'fuse') {
      const host = byData('[data-hop-house]', 'hopHouse', target.hostId);
      const box = rectOf(host);
      return box ? { ...target, box: { left: box.left - 5, top: box.top - 5, width: box.width + 10, height: box.height + 10 }, x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    }
    if (target.type === 'row') {
      const row = byData('[data-hop-row-id]', 'hopRowId', target.rowId);
      const cells = row?.querySelector('.hop-cells');
      const box = rectOf(cells), before = target.beforeId ? rectOf(byData('[data-hop-house]', 'hopHouse', target.beforeId)) : null;
      if (!box) return null;
      const x = before ? before.left - 7 : box.right + 7;
      return { ...target, box: { left: x - 1.5, top: box.top + 8, width: 3, height: Math.max(32, box.height - 16) }, x, y: box.top + box.height / 2 };
    }
    const next = target.beforeRowId ? rows.find(el => el.dataset.hopRowId === target.beforeRowId) : null;
    const previous = next ? rows[rows.indexOf(next) - 1] : rows.at(-1);
    const nextBox = rectOf(next), previousBox = rectOf(previous);
    if (!nextBox && !previousBox) return null;
    const y = nextBox && previousBox ? (previousBox.bottom + nextBox.top) / 2 : nextBox ? nextBox.top - 22 : previousBox.bottom + 22;
    const boardBox = rectOf(root.querySelector('.hop-court-scroll'));
    const x = boardBox.left + boardBox.width / 2;
    const width = Math.min(210, boardBox.width - 42);
    return { ...target, box: { left: x - width / 2, top: y - 1.5, width, height: 3 }, x, y };
  };
  const paint = () => {
    if (!drag) return;
    drag.bounds = visibleBoard();
    if (drag.bounds) drag.guides.style.clipPath = `inset(${drag.bounds.top}px ${win.innerWidth - drag.bounds.right}px ${win.innerHeight - drag.bounds.bottom}px ${drag.bounds.left}px)`;
    drag.targets.forEach(target => {
      const geo = geometry(target);
      if (!geo) return;
      Object.assign(target, geo); place(target.el, target.box);
      target.el.hidden = !target.ok || !target.changed;
    });
    const { ghost, x, y, offsetX, offsetY } = drag;
    ghost.style.left = `${x - offsetX}px`; ghost.style.top = `${y - offsetY - 9}px`;
  };
  const choose = (target, keyboard = false) => {
    if (!drag) return;
    if (drag.target !== target) {
      drag.target?.el?.classList.remove('is-over', 'is-ready');
      drag.target = target; drag.enteredAt = win.performance.now();
    }
    const ready = target?.ok && target.changed && (target.type !== 'fuse' || keyboard || win.performance.now() - drag.enteredAt >= 300);
    drag.ready = ready;
    target?.el?.classList.add('is-over');
    target?.el?.classList.toggle('is-ready', Boolean(ready));
    const merging = ready && target.type === 'fuse';
    drag.mergePreview.hidden = !merging;
    drag.ghost.style.opacity = merging ? '0' : '';
    if (!merging) { drag.mergeHost?.classList.remove('is-merge-host'); drag.mergeHost = null; }
    else {
      if (drag.previewTarget !== target) {
        const template = doc.createElement('template');
        template.innerHTML = renderHopscotchCourt(target.board, { activation: getActivation?.(target.board) });
        const group = [...template.content.querySelectorAll('[data-hop-house]')].find(el => el.dataset.hopHouse === target.hostId);
        drag.mergePreview.replaceChildren(group);
        const incomingKind = drag.element.dataset.hopPart || drag.element.dataset.hopKind;
        group.querySelector(`[data-hop-part="${incomingKind}"]`)?.classList.add('is-incoming');
        drag.previewTarget = target;
      }
      drag.mergeHost = byData('[data-hop-house]', 'hopHouse', target.hostId);
      drag.mergeHost.classList.add('is-merge-host');
      const box = rectOf(drag.mergeHost), preview = drag.mergePreview;
      const scale = Math.min(1, (drag.bounds.right - drag.bounds.left - 20) / preview.offsetWidth, box.height / preview.offsetHeight);
      Object.assign(preview.style, { left: `${target.x - preview.offsetWidth * scale / 2}px`, top: `${box.top}px`, transform: `scale(${scale})` });
      place(target.el, { left: target.x - preview.offsetWidth * scale / 2 - 5, top: box.top - 5, width: preview.offsetWidth * scale + 10, height: preview.offsetHeight * scale + 10 });
    }
    const tip = !target ? t('拖到亮起的位置') : target.ok ? label(target) : target.reason;
    if (drag.tip.textContent !== tip) drag.tip.textContent = tip;
    drag.tip.classList.toggle('is-invalid', Boolean(target && !target.ok));
    const x = Math.min(win.innerWidth - 135, Math.max(135, target?.x ?? drag.x));
    const y = Math.max(12, Math.min(win.innerHeight - 55, merging ? target.box.top - 42 : Number.isFinite(target?.y) ? target.y - 42 : drag.y - 72));
    Object.assign(drag.tip.style, { left: `${x}px`, top: `${y}px` });
  };
  const hit = () => {
    if (!drag) return null;
    const { x, y } = drag;
    const board = drag.bounds;
    if (!board || x < board.left || x > board.right || y < board.top || y > board.bottom) return null;
    // 中心融合优先；左右边缘始终留给并行插入。
    const fusion = drag.targets.find(target => target.type === 'fuse' && target.changed !== false && target.box
      && Math.abs(x - target.x) < target.box.width * .32 && Math.abs(y - target.y) < target.box.height * .39);
    if (fusion) return fusion;
    let best = null, distance = Infinity;
    for (const target of drag.targets) {
      if (target.type === 'fuse' || !target.box || target.changed === false) continue;
      const dx = Math.max(0, Math.abs(x - target.x) - (target.type === 'gap' ? target.box.width / 2 : 0));
      const dy = Math.max(0, Math.abs(y - target.y) - (target.type === 'row' ? target.box.height / 2 : 0));
      const d = Math.hypot(dx, dy);
      if (d <= 28 && d < distance) { distance = d; best = target; }
    }
    if (best) return best;
    const under = doc.elementFromPoint(x, y)?.closest('[data-hop-node]');
    if (under && root.contains(under) && under.dataset.hopNode !== drag.id) return drag.invalid;
    return null;
  };
  const scrollEdge = () => {
    if (!drag || drag.keyboard) return;
    for (let el = root.querySelector('.hop-court-scroll'); el; el = el.parentElement) {
      const style = win.getComputedStyle(el), box = rectOf(el);
      if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      const top = Math.max(0, box.top), bottom = Math.min(win.innerHeight, box.bottom);
      const delta = drag.y < top + 48 ? -Math.min(13, (top + 48 - drag.y) / 4) : drag.y > bottom - 48 ? Math.min(13, (drag.y - bottom + 48) / 4) : 0;
      if (delta) { const before = el.scrollTop; el.scrollTop += delta; if (el.scrollTop !== before) break; }
    }
  };
  const tick = () => {
    if (!drag) return;
    if (!canDrag() || !root.isConnected || !drag.source.isConnected) { stop(); return; }
    scrollEdge(); paint();
    if (!drag.keyboard) choose(hit());
    frame = win.requestAnimationFrame(tick);
  };
  const start = (keyboard = false) => {
    win.clearTimeout(holdTimer);
    if (!press || !canDrag() || drag) return;
    const { element, x, y } = press;
    const source = element.dataset.hopPart === 'body' ? element.closest('.hop-fusion-group') || element : element;
    const box = rectOf(source), id = element.dataset.hopNode;
    const layer = doc.createElement('div'); layer.className = 'hop-drag-layer hop-dialog hop-court';
    const overlay = root.closest('.agent-center-overlay') || root.closest('dialog') || doc.body;
    overlay.append(layer);
    const ghost = source.cloneNode(true); ghost.classList.add('hop-drag-ghost');
    ghost.removeAttribute('id'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
    const style = win.getComputedStyle(source);
    for (const key of ['--hop-kind', '--hop-violet', '--hop-mint', '--hop-sky', '--hop-amber', '--hop-rose', '--hop-cell-w', '--hop-board-bg']) layer.style.setProperty(key, style.getPropertyValue(key));
    ghost.style.setProperty('--hop-kind', style.getPropertyValue('--hop-kind'));
    const scale = box.width / source.offsetWidth;
    Object.assign(ghost.style, { width: `${source.offsetWidth}px`, height: `${source.offsetHeight}px`, minHeight: '0', padding: style.padding, borderRadius: style.borderRadius, transform: `scale(${scale * 1.035}) rotate(-1.5deg)` });
    const sourceParts = source.querySelectorAll('[data-hop-part]');
    ghost.querySelectorAll('[data-hop-part]').forEach((part, index) => part.style.setProperty('--hop-kind', win.getComputedStyle(sourceParts[index]).getPropertyValue('--hop-kind')));
    const tip = doc.createElement('div'); tip.className = 'hop-drop-tip'; tip.setAttribute('role', 'status'); tip.setAttribute('aria-live', 'polite');
    const guides = doc.createElement('div'); guides.className = 'hop-drop-guides'; layer.append(guides);
    const mergePreview = doc.createElement('div'); mergePreview.className = 'hop-merge-preview'; mergePreview.hidden = true; mergePreview.inert = true; mergePreview.setAttribute('aria-hidden', 'true'); guides.append(mergePreview);
    const targets = listHopscotchDropTargets(getBoard(), id, { capabilities: getCapabilities() }).map(target => {
      const el = doc.createElement('div'); el.className = `hop-drop-target is-${target.type}`; el.setAttribute('aria-hidden', 'true');
      el.dataset.hopDropType = target.type; guides.append(el); return { ...target, el };
    });
    layer.append(ghost, tip);
    drag = { id, element, source, layer, guides, mergePreview, ghost, tip, targets, keyboard, x, y, offsetX: x - box.left, offsetY: y - box.top, target: null, ready: false,
      invalid: { ok: false, reason: t('此房子需要独立请求') } };
    source.classList.add('is-drag-source'); source.setAttribute('aria-grabbed', 'true'); root.classList.add('is-dragging');
    if (!keyboard) { try { element.setPointerCapture(press.id); } catch {} }
    paint(); choose(null); tick();
  };
  const down = event => {
    if (event.button !== 0 || event.isPrimary === false || !canDrag() || drag) return;
    const element = event.target.closest('[data-hop-node]');
    if (!element || !root.contains(element)) return;
    stop();
    suppressClickUntil = 0;
    press = { element, id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, grip: Boolean(event.target.closest('[data-hop-grip]')) };
    holdTimer = win.setTimeout(() => start(), event.pointerType === 'touch' ? 350 : 250);
  };
  const move = event => {
    if (!press || press.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (!drag && distance >= 6) {
      if (press.type === 'touch' && !press.grip) { stop(); return; }
      start();
    }
    if (drag) { event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY; paint(); choose(hit()); }
  };
  const finish = event => {
    if (!press || (event && event.pointerId !== press.id)) return;
    if (!drag) { stop(); return; }
    const { id, target, ready, element } = drag;
    stop();
    if (ready && target) onDrop(id, target);
    const focus = byData('[data-hop-node]', 'hopNode', id) || element;
    if (focus.isConnected) {
      focus.focus({ preventScroll: true });
      if (ready && !win.matchMedia?.('(prefers-reduced-motion: reduce)').matches && doc.body.dataset.reducedMotion !== 'on') {
        const landed = focus.dataset.hopPart === 'body' ? focus.closest('.hop-fusion-group') || focus : focus;
        landed.animate?.([{ transform: 'translateY(-7px) scale(1.035)' }, { transform: 'none' }], { duration: 170, easing: 'ease-out' });
      }
    }
  };
  const click = event => { if (Date.now() < suppressClickUntil && event.target.closest('[data-hop-node]')) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const key = event => {
    const element = event.target.closest('[data-hop-node]');
    if (!drag) suppressClickUntil = 0;
    if (!drag && event.code === 'Space' && element && canDrag()) {
      event.preventDefault(); event.stopPropagation();
      const box = rectOf(element); press = { element, x: box.left + box.width / 2, y: box.top + box.height / 2 };
      start(true); return;
    }
    if (!drag) return;
    if (event.key === 'Escape' || event.key === 'Tab') { event.stopPropagation(); if (event.key === 'Escape') event.preventDefault(); stop(); return; }
    if (!drag.keyboard) return;
    if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); event.stopPropagation(); finish(); return; }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const legal = drag.targets.filter(target => target.ok && target.changed);
    if (!legal.length) return;
    const current = legal.indexOf(drag.target), direction = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? legal.length - 1 : (current + direction + legal.length) % legal.length;
    const target = legal[index];
    const anchor = target.type === 'fuse' ? byData('[data-hop-house]', 'hopHouse', target.hostId) : target.type === 'row' ? byData('[data-hop-row-id]', 'hopRowId', target.rowId) : target.beforeRowId ? byData('[data-hop-row-id]', 'hopRowId', target.beforeRowId) : root.querySelector('.hop-roof');
    anchor?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    paint(); choose(target, true);
    if (target.type !== 'fuse') {
      const rowId = target.type === 'row' ? target.rowId : target.beforeRowId;
      const index = rowId ? getBoard().rows.findIndex(row => row.id === rowId) : getBoard().rows.length;
      drag.tip.textContent = `${t('第 {value} 行', { value: index + 1 })} · ${label(target)}`;
    }
    drag.x = target.x; drag.y = target.y;
  };
  const touch = event => { if (drag && event.cancelable) event.preventDefault(); };
  const context = event => { if (press || drag) event.preventDefault(); };
  root.addEventListener('pointerdown', down); doc.addEventListener('pointermove', move, { passive: false });
  doc.addEventListener('pointerup', finish); doc.addEventListener('pointercancel', stop); win.addEventListener('blur', stop);
  root.addEventListener('click', click, true); root.addEventListener('keydown', key, true);
  root.addEventListener('touchmove', touch, { passive: false }); root.addEventListener('contextmenu', context);
  return { cancel: stop, isActive: () => Boolean(drag || press), dispose: () => {
    stop(); root.removeEventListener('pointerdown', down); doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', finish);
    doc.removeEventListener('pointercancel', stop); win.removeEventListener('blur', stop); root.removeEventListener('click', click, true);
    root.removeEventListener('keydown', key, true); root.removeEventListener('touchmove', touch); root.removeEventListener('contextmenu', context);
  } };
};
