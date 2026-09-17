import { translateUiText as t } from '../../i18n/index.js';
import { createRpMessageIconMarkup } from './rp-message-actions-ui-utils.js';
import { createTextFragmentEditor } from './text-fragment-editor.js';
import { agentIconMarkup } from '../../agent/agent-icons.js';

const controls = 'a[href],button,input,textarea,select,summary,audio,video,canvas,iframe,[contenteditable="true"],.chat-reasoning,.chat-reply-preview,[data-i18n-skip-selection]';
const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;

// Delegated listeners survive pagination/rerenders. Touch scrolling stays native
// until a held finger moves; stationary holds retain ChatUI's original menu.
export const bindBubbleTextSelection = ({ ui, runtime, canEdit = () => true, toolbox = null, documentRef = document,
  onError = message => window.toastr?.info?.(t(message)) } = {}) => {
  const win = documentRef.defaultView, root = ui.scrollEl, selection = () => win.getSelection();
  if (!root) return { dispose() {} };
  const editor = createTextFragmentEditor({ documentRef }), bindings = [];
  const bar = documentRef.createElement('button'); bar.type = 'button'; bar.className = 'bubble-selection-edit'; bar.hidden = true;
  bar.innerHTML = createRpMessageIconMarkup('edit', { size:18 });
  const tools = documentRef.createElement('button'); tools.type = 'button'; tools.className = 'bubble-selection-tools'; tools.hidden = true;
  tools.innerHTML = agentIconMarkup('toolbox'); tools.title = t('使用 Agent 处理所选文字'); tools.setAttribute('aria-label', tools.title);
  const hideBar = () => { bar.hidden = true; tools.hidden = true; };
  const style = documentRef.createElement('style');
  style.textContent = `.bubble-selection-edit,.bubble-selection-tools{position:fixed;z-index:22000;box-sizing:border-box;width:44px;height:44px;padding:10px;align-items:center;justify-content:center;border:1px solid var(--app-border-default);border-radius:var(--app-radius-md);box-shadow:var(--app-shadow-md);background:var(--app-surface-card);color:var(--app-text-primary);cursor:pointer}.bubble-selection-edit:not([hidden]),.bubble-selection-tools:not([hidden]){display:inline-flex}.bubble-selection-edit:focus-visible,.bubble-selection-tools:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:3px}`;
  documentRef.head.append(style); documentRef.body.append(bar, tools);
  const listen = (target, type, fn, options) => { target?.addEventListener(type, fn, options); bindings.push(() => target?.removeEventListener(type, fn, options)); };
  let chosen = null, dragging = false, gesture = null, suppressClick = false, timer = 0, generation = 0, opening = false, picking = false;
  const hideMenu = () => { ui.clearLongPress(); ui.contextMenu.style.display = 'none'; ui.hideReactionPicker?.(); };
  const eligible = bubble => {
    const wrapper = bubble?.closest('[data-msg-id][data-role]');
    return Boolean(bubble?.isConnected && root.contains(bubble) && !ui.selectionMode && !ui.isStreaming && !ui.isSending
      && canEdit(wrapper?.__chatappMessage) && !bubble.closest('[contenteditable="true"]'));
  };
  const bubbleAt = node => {
    const el = elementOf(node);
    if (!el || el.closest(controls)) return null;
    const bubble = el.closest('.QQ_chat_msgdiv');
    return eligible(bubble) ? bubble : null;
  };
  const readSelection = () => {
    const current = selection();
    if (!current?.rangeCount || current.isCollapsed) return null;
    const range = current.getRangeAt(0), bubble = bubbleAt(range.startContainer);
    if (!bubble || bubbleAt(range.endContainer) !== bubble || range.cloneContents().querySelector?.(controls)) return null;
    const text = current.toString(); if (!text.trim()) return null;
    const messageId = bubble.closest('[data-msg-id]').dataset.msgId;
    const unchanged = chosen?.messageId === messageId && chosen.text === text
      && chosen.range.startContainer === range.startContainer && chosen.range.startOffset === range.startOffset
      && chosen.range.endContainer === range.endContainer && chosen.range.endOffset === range.endOffset;
    return { range:range.cloneRange(), bubble, text, messageId,
      toolIdentity: unchanged ? chosen.toolIdentity : toolbox?.captureSelectionIdentity(messageId) };
  };
  const refresh = () => {
    if (dragging || opening || editor.isOpen) { hideBar(); return; }
    chosen = readSelection();
    if (!chosen) { hideBar(); return; }
    const rect = chosen.range.getBoundingClientRect(), viewport = win.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    const bounds = root.getBoundingClientRect();
    if (rect.bottom < Math.max(top, bounds.top) || rect.top > Math.min(top + height, bounds.bottom)) { hideBar(); return; }
    const label = t('编辑所选文字'); bar.title = label; bar.setAttribute('aria-label', label); bar.hidden = false;
    const assistant = chosen.bubble.closest('[data-role]')?.dataset.role === 'assistant';
    tools.hidden = !assistant || !(picking || toolbox?.hasSelectionTools()); bar.hidden = picking;
    const buttonsWidth = !bar.hidden && !tools.hidden ? 92 : 44;
    bar.style.left = Math.max(left + 8, Math.min(left + width - buttonsWidth - 8, rect.left)) + 'px';
    bar.style.top = Math.max(top + 8, Math.min(top + height - 44 - 8, rect.bottom + 8)) + 'px';
    tools.style.left = `${parseFloat(bar.style.left) + (bar.hidden ? 0 : 48)}px`; tools.style.top = bar.style.top;
  };
  const scheduleRefresh = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };
  const reset = () => { generation++; chosen = null; gesture = null; dragging = false; suppressClick = false; picking = false; clearTimeout(timer); hideBar(); ui.clearLongPress(); editor.close(); };
  const caretAt = (point, bubble) => {
    const position = documentRef.caretPositionFromPoint?.(point.clientX, point.clientY);
    let range;
    if (position) { range = documentRef.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); }
    else range = documentRef.caretRangeFromPoint?.(point.clientX, point.clientY);
    return range && bubbleAt(range.startContainer) === bubble ? range : null;
  };
  listen(root, 'pointerdown', event => { if (event.pointerType === 'mouse') suppressClick = false; chosen = null; dragging = true; hideBar(); }, true);
  listen(documentRef, 'pointerup', () => { dragging = false; scheduleRefresh(); });
  listen(documentRef, 'pointercancel', () => { dragging = false; hideBar(); });
  listen(documentRef, 'selectionchange', scheduleRefresh);
  listen(root, 'scroll', () => { hideBar(); scheduleRefresh(); }, { passive:true });
  listen(win, 'resize', scheduleRefresh); listen(win.visualViewport, 'resize', scheduleRefresh);
  listen(win, 'session-changed', reset); listen(win, 'pagehide', reset);
  listen(root, 'touchstart', event => {
    suppressClick = false;
    const bubble = bubbleAt(event.target);
    if (event.touches.length !== 1 || !bubble) { gesture = null; return; }
    const touch = event.changedTouches[0], anchor = caretAt(touch, bubble);
    gesture = anchor ? { id:touch.identifier, x:touch.clientX, y:touch.clientY, at:performance.now(), anchor, bubble, selecting:false, scrolling:false } : null;
  }, { capture:true, passive:true });
  listen(root, 'touchmove', event => {
    const current = gesture;
    if (!current || current.scrolling) return;
    if (event.touches.length !== 1 || !eligible(current.bubble)) { gesture = null; return; }
    const touch = Array.from(event.changedTouches).find(point => point.identifier === current.id);
    if (!touch) return;
    const distance = Math.hypot(touch.clientX - current.x, touch.clientY - current.y);
    if (performance.now() - current.at < 400) { if (distance > 8) current.scrolling = true; return; }
    if (!event.cancelable) { current.scrolling = true; return; }
    event.preventDefault();
    if (!current.selecting && distance < 8) return;
    hideMenu(); hideBar();
    const end = caretAt(touch, current.bubble); if (!end) return;
    const reverse = current.anchor.compareBoundaryPoints(win.Range.START_TO_START, end) > 0;
    const start = reverse ? end : current.anchor, finish = reverse ? current.anchor : end;
    const range = documentRef.createRange(); range.setStart(start.startContainer, start.startOffset); range.setEnd(finish.startContainer, finish.startOffset);
    if (range.cloneContents().querySelector?.(controls)) return;
    selection().removeAllRanges(); selection().addRange(range);
    current.selecting = true; dragging = true; suppressClick = true;
  }, { capture:true, passive:false });
  listen(root, 'touchend', event => {
    if (!gesture || !Array.from(event.changedTouches).some(point => point.identifier === gesture.id)) return;
    const heldMenu = !gesture.scrolling && ui.contextMenu.style.display !== 'none';
    // A completed touch otherwise synthesizes mousedown/click outside the menu,
    // immediately dismissing the very menu opened by this hold.
    if (gesture.selecting || heldMenu) {
      if (event.cancelable) event.preventDefault();
      suppressClick = true; ui.clearLongPress();
      if (gesture.selecting) hideMenu();
    }
    gesture = null; dragging = false; scheduleRefresh();
  }, { capture:true, passive:false });
  listen(root, 'touchcancel', () => {
    if (gesture?.selecting) { selection().removeAllRanges(); chosen = null; }
    gesture = null; dragging = false; hideBar(); ui.clearLongPress();
  }, { capture:true, passive:true });
  listen(root, 'click', event => {
    if (!suppressClick) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  listen(root, 'contextmenu', event => {
    if (gesture?.selecting) { event.preventDefault(); event.stopImmediatePropagation(); ui.clearLongPress(); }
  }, true);
  listen(bar, 'pointerdown', event => event.preventDefault());
  listen(bar, 'click', async () => {
    if (opening || editor.isOpen || !chosen?.bubble.isConnected) return;
    const request = chosen, version = generation;
    opening = true; hideBar(); hideMenu();
    try {
      const draft = await runtime.open({ messageId:request.messageId, selectedText:request.text });
      if (version !== generation || !request.bubble.isConnected) return;
      selection().removeAllRanges(); chosen = null;
      await editor.show(draft);
    } catch (error) { if (version === generation) onError(error.message); }
    finally { opening = false; }
  });
  listen(tools, 'pointerdown', event => event.preventDefault());
  listen(tools, 'click', async () => {
    if (opening || !chosen?.bubble.isConnected) return;
    const request = chosen, version = generation;
    opening = true; hideBar(); hideMenu();
    try {
      await toolbox?.useSelection({ messageId: request.messageId, selectedText: request.text, expectedIdentity: request.toolIdentity });
      if (version === generation) { selection().removeAllRanges(); chosen = null; }
    } catch (error) { if (version === generation) onError(error.message); }
    finally { opening = false; }
  });
  toolbox?.setSelectionController({
    start: () => { picking = true; selection().removeAllRanges(); chosen = null; hideBar(); },
    cancel: () => { picking = false; hideBar(); },
  });
  const observer = new win.MutationObserver(() => { if (chosen && !chosen.bubble.isConnected) { chosen = null; hideBar(); } });
  observer.observe(root, { childList:true, subtree:true });
  return {
    closeEditor({ dryRun = false } = {}) { if (!editor.isOpen) return false; if (!dryRun) editor.close(); return true; },
    dispose() { reset(); toolbox?.setSelectionController(null); observer.disconnect(); bindings.forEach(remove => remove()); bar.remove(); tools.remove(); style.remove(); editor.dispose(); },
  };
};
