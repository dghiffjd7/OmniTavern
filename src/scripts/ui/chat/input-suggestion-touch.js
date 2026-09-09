import { splitInputSuggestionCharacters } from './input-suggestion-runtime.js';

// 在长按开始时测量真实字形；拖动时只读取缓存，滚动偏移参与命中计算。
const measureCharacters = (label, characters) => {
  const doc = label.ownerDocument, walker = doc.createTreeWalker(label, 4), nodes = [];
  let node, length = 0;
  while ((node = walker.nextNode())) { nodes.push({ node, start: length }); length += node.length; }
  const locate = offset => {
    const entry = nodes.find(item => offset <= item.start + item.node.length) || nodes[nodes.length - 1];
    return [entry.node, Math.max(0, Math.min(entry.node.length, offset - entry.start))];
  };
  const bounds = label.getBoundingClientRect(), range = doc.createRange();
  let offset = 0;
  return characters.map(character => {
    range.setStart(...locate(offset)); offset += character.length; range.setEnd(...locate(offset));
    const rect = range.getBoundingClientRect();
    return { left: rect.left - bounds.left + label.scrollLeft, right: rect.right - bounds.left + label.scrollLeft };
  });
};

const prefixAt = (rects, x) => {
  if (!rects.length || x < rects[0].left) return 0;
  let closest = 0, distance = Infinity;
  rects.forEach((rect, index) => {
    const gap = Math.max(rect.left - x, x - rect.right, 0);
    if (gap < distance) { distance = gap; closest = index + 1; }
  });
  return closest;
};

// 手势仅占用建议条。输入框保持焦点，预览阶段只报告范围，松手再由宿主写入。
export const bindInputSuggestionTouch = ({ target, label, getSuggestion, onSelection, onCommit, holdMs = 400 } = {}) => {
  const doc = target.ownerDocument, win = doc.defaultView;
  const preview = doc.createElement('div');
  preview.className = 'input-suggestion-touch-preview'; preview.hidden = true; preview.setAttribute('aria-hidden', 'true');
  const before = doc.createElement('span'), caret = doc.createElement('span'), after = doc.createElement('span');
  before.className = 'input-suggestion-selected'; caret.className = 'input-suggestion-touch-caret';
  after.className = 'input-suggestion-touch-after'; preview.append(before, caret, after); doc.body.append(preview);
  let gesture = null, frame = null, suppressClick = false;
  const bindings = [];
  const listen = (element, type, handler, options) => {
    element.addEventListener(type, handler, options);
    bindings.push(() => element.removeEventListener(type, handler, options));
  };
  const cancel = () => {
    const previous = gesture;
    gesture = null;
    if (previous?.timer != null) win.clearTimeout(previous.timer);
    if (frame != null) win.cancelAnimationFrame(frame);
    frame = null;
    preview.hidden = true;
    if (previous) {
      try { if (target.hasPointerCapture?.(previous.id)) target.releasePointerCapture(previous.id); } catch {}
      label.scrollLeft = 0;
      onSelection(null);
    }
  };
  const current = () => gesture && getSuggestion() === gesture.text;
  const showPreview = state => {
    before.textContent = state.characters.slice(Math.max(0, state.count - 5), state.count).join('');
    after.textContent = state.characters.slice(state.count, state.count + 4).join('');
    preview.hidden = false;
    const viewport = win.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    const rect = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(left + 8, Math.min(left + width - rect.width - 8, state.point.x - rect.width / 2))}px`;
    preview.style.top = `${Math.max(top + 8, Math.min(top + height - rect.height - 8, state.point.y - rect.height - 36))}px`;
  };
  const update = (autoScroll = false) => {
    if (!current()) { cancel(); return; }
    const state = gesture, bounds = label.getBoundingClientRect();
    state.outside = state.point.y < bounds.top - 44 || state.point.y > bounds.bottom + 44;
    if (state.outside) {
      preview.hidden = true;
      if (!state.reportedOutside) onSelection({ ...state, count: 0 });
      state.reportedOutside = true;
      return;
    }
    if (autoScroll) {
      const max = Math.max(0, label.scrollWidth - label.clientWidth), margin = 24;
      const delta = state.point.x > bounds.right - margin ? Math.min(9, (state.point.x - bounds.right + margin) / 3)
        : state.point.x < bounds.left + margin ? -Math.min(9, (bounds.left + margin - state.point.x) / 3) : 0;
      label.scrollLeft = Math.max(0, Math.min(max, label.scrollLeft + delta));
    }
    state.count = prefixAt(state.rects, state.point.x - bounds.left + label.scrollLeft);
    if (state.reportedCount !== state.count || state.reportedOutside) onSelection(state);
    state.reportedCount = state.count; state.reportedOutside = false;
    showPreview(state);
    const canScroll = (state.point.x > bounds.right - 24 && label.scrollLeft < label.scrollWidth - label.clientWidth)
      || (state.point.x < bounds.left + 24 && label.scrollLeft > 0);
    if (canScroll && frame == null) frame = win.requestAnimationFrame(() => { frame = null; update(true); });
  };
  listen(doc, 'pointerdown', event => { if (gesture && gesture.id !== event.pointerId) cancel(); }, true);
  listen(target, 'pointerdown', event => {
    if (event.button !== 0) return;
    // 防止建议按钮取得焦点，保持输入法和原生插入位置。
    event.preventDefault();
    suppressClick = false;
    if (!['touch', 'pen'].includes(event.pointerType)) return;
    suppressClick = true;
    if (!event.isPrimary || gesture) { cancel(); return; }
    const text = getSuggestion();
    if (!text) return;
    const point = { x: event.clientX, y: event.clientY };
    const state = { id: event.pointerId, text, characters: splitInputSuggestionCharacters(text), point, start: point, count: 0, adjusted: false, active: false, timer: null };
    gesture = state;
    onSelection(state);
    try { target.setPointerCapture?.(event.pointerId); } catch {}
    state.timer = win.setTimeout(() => {
      state.timer = null;
      if (gesture !== state || !current()) { cancel(); return; }
      state.active = true;
      onSelection(state);
      state.rects = measureCharacters(label, state.characters);
    }, holdMs);
  }, { passive: false });
  listen(doc, 'pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!current()) { cancel(); return; }
    event.preventDefault();
    const state = gesture;
    state.point = { x: event.clientX, y: event.clientY };
    const moved = Math.hypot(state.point.x - state.start.x, state.point.y - state.start.y);
    if (!state.active) { if (moved > 8) cancel(); return; }
    if (!state.adjusted && moved < 3) return;
    state.adjusted = true;
    update();
  }, { passive: false });
  listen(doc, 'pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    event.preventDefault();
    const state = gesture, valid = current();
    if (state.active && state.adjusted && valid) {
      state.point = { x: event.clientX, y: event.clientY };
      update();
    }
    const tap = !state.active && Math.hypot(event.clientX - state.start.x, event.clientY - state.start.y) <= 8;
    const count = tap ? undefined : state.adjusted && !state.outside ? state.count : 0;
    cancel();
    if (valid && (count === undefined || count > 0)) onCommit(count);
  }, { passive: false });
  listen(doc, 'pointercancel', event => { if (event.pointerId === gesture?.id) cancel(); });
  listen(target, 'lostpointercapture', event => { if (event.pointerId === gesture?.id) cancel(); });
  listen(target, 'contextmenu', event => { if (gesture || suppressClick) event.preventDefault(); });
  listen(target, 'selectstart', event => event.preventDefault());
  listen(target, 'click', event => {
    if (suppressClick && (event.detail !== 0 || ['touch', 'pen'].includes(event.pointerType))) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    onCommit();
  });
  listen(win, 'resize', cancel);
  if (win.visualViewport) listen(win.visualViewport, 'resize', cancel);
  return { cancel, dispose: () => { cancel(); bindings.forEach(unbind => unbind()); preview.remove(); } };
};
