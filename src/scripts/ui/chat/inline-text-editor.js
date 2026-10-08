import { t } from '../../i18n/index.js';
import {
  applyInlineEditTextChange, cloneInlineEditProvenance, createInlineEditProvenance, inlineEditOps,
  inlineEditSegments, provenanceText, restoreInlineEditDeleted,
} from './inline-edit-provenance.js';

// 快速编辑：在气泡里选中的位置原地编辑。原文只是暂时藏起来（取消时原样放回），
// 编辑框里照常打字，每次输入落定后重画成「绿增红删」；红字点一下恢复。中文拼写中不重画，上屏后再上色。
const css = `
.inline-text-editor{white-space:pre-wrap;overflow-wrap:anywhere;outline:none;border-radius:4px;padding:1px 0;caret-color:var(--app-accent-primary);background:var(--app-accent-soft);box-shadow:0 0 0 2px color-mix(in srgb,var(--app-accent-primary) 55%,transparent);-webkit-user-select:text;user-select:text}
.inline-text-editor ins,.inline-text-editor del{border-radius:3px;text-decoration-thickness:2px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.inline-text-editor ins{color:inherit;text-decoration:none;background:rgba(var(--app-diff-add-rgb,var(--app-success-rgb,46,160,67)),.2);box-shadow:inset 0 -2px 0 rgba(var(--app-diff-add-rgb,var(--app-success-rgb,46,160,67)),.55)}
.inline-text-editor del{color:var(--app-danger-text);text-decoration:line-through;background:rgba(var(--app-diff-del-rgb,var(--app-danger-rgb,207,34,46)),.12);cursor:pointer;-webkit-user-select:none;user-select:none}
.inline-text-editor.plain-view ins{background:none;box-shadow:none}
.inline-text-editor.plain-view del{display:none}
.inline-text-editor-bar{position:fixed;z-index:22000;display:flex;gap:6px;padding:4px;border:1px solid var(--app-border-default);border-radius:999px;background:var(--app-surface-card);box-shadow:var(--app-shadow-md)}
.inline-text-editor-bar[hidden]{display:none}
.inline-text-editor-bar button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--app-text-secondary);cursor:pointer}
.inline-text-editor-bar button:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
.inline-text-editor-bar button:disabled{opacity:.45;cursor:default}
.inline-text-editor-bar button[aria-pressed="true"]{background:var(--app-accent-soft);color:var(--app-accent-primary)}
.inline-text-editor-bar .inline-text-editor-save{background:var(--app-accent-primary);color:var(--app-text-inverse)}
@media(hover:hover){.inline-text-editor-bar button:hover:not(:disabled){background:var(--app-surface-hover);color:var(--app-text-primary)}.inline-text-editor-bar .inline-text-editor-save:hover:not(:disabled){background:var(--app-accent-strong);color:var(--app-text-inverse)}}
`;
const svg = path => `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const MARKS_ICON = svg('<path d="M12 4v16"/><path d="M4 8h5M4 12h5M4 16h5"/><path d="M15 8h5M15 12h5"/>');
const CANCEL_ICON = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const SAVE_ICON = svg('<path d="m5 12 4.5 4.5L19 7"/>');

const escapeHtml = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// 把选区里的原文藏起来：边界处的文字节点先切开，整段落在选区内的最外层节点逐个隐藏，返回还原函数与编辑框应插入的位置。
const hideRange = (range, bubble, win) => {
  let { startContainer: start, startOffset, endContainer: end, endOffset } = range;
  if (end.nodeType === 3 && endOffset < end.length) end.splitText(endOffset);
  if (start.nodeType === 3 && startOffset > 0) {
    const rest = start.splitText(startOffset);
    if (end === start) end = rest;
    start = rest;
  }
  const scope = range.cloneRange();
  if (start.nodeType === 3) scope.setStartBefore(start);
  if (end.nodeType === 3) scope.setEndAfter(end);
  const doc = bubble.ownerDocument, hidden = [];
  const contained = node => {
    const probe = doc.createRange(); probe.selectNode(node);
    return scope.compareBoundaryPoints(win.Range.START_TO_START, probe) <= 0 && scope.compareBoundaryPoints(win.Range.END_TO_END, probe) >= 0;
  };
  const visit = parent => {
    for (const node of Array.from(parent.childNodes)) {
      if (!scope.intersectsNode(node)) continue;
      if (contained(node)) {
        if (node.nodeType === 3) {
          const wrap = doc.createElement('span'); wrap.hidden = true; node.before(wrap); wrap.append(node);
          hidden.push({ node: wrap, restore: () => wrap.replaceWith(node) });
        } else if (node.nodeType === 1) {
          const style = node.getAttribute('style');
          node.style.setProperty('display', 'none', 'important');
          hidden.push({ node, restore: () => { if (style == null) node.removeAttribute('style'); else node.setAttribute('style', style); } });
        }
      } else if (node.nodeType === 1) visit(node);
    }
  };
  visit(scope.commonAncestorContainer.nodeType === 1 ? scope.commonAncestorContainer : scope.commonAncestorContainer.parentNode);
  if (!hidden.length) return null;
  // 选区从斜体、引号等行内样式的开头起选时，编辑框放在样式外面，不沾原文样式
  let anchor = hidden[0].node;
  while (anchor.parentNode !== bubble && !anchor.previousSibling && win.getComputedStyle(anchor.parentNode).display === 'inline') anchor = anchor.parentNode;
  return { anchor, restore: () => { hidden.reverse().forEach(item => item.restore()); bubble.normalize(); } };
};

// getBounds：按钮条可停靠的区域（如聊天列表），不遮住输入栏等其他界面
// 选区首尾的空白里，只有编辑文字自己带着的（能写回原文的）留在选区内；其余空白移出选区，编辑时照常显示。
const narrowToEditable = (range, text, win) => {
  const keepLead = text.length - text.trimStart().length, keepTrail = text.length - text.trimEnd().length;
  const walker = range.startContainer.ownerDocument.createTreeWalker(range.commonAncestorContainer, win.NodeFilter.SHOW_TEXT);
  const spots = [];
  if (range.commonAncestorContainer.nodeType === 3) spots.push(range.commonAncestorContainer);
  else for (let node = walker.nextNode(); node; node = walker.nextNode()) if (range.intersectsNode(node)) spots.push(node);
  const chars = function* (reverse) {
    const nodes = reverse ? [...spots].reverse() : spots;
    for (const node of nodes) {
      const from = node === range.startContainer ? range.startOffset : 0, to = node === range.endContainer ? range.endOffset : node.length;
      if (reverse) { for (let i = to - 1; i >= from; i--) yield { node, i, ch: node.data[i] }; }
      else for (let i = from; i < to; i++) yield { node, i, ch: node.data[i] };
    }
  };
  const edge = (reverse, keep) => {
    const spaces = [];
    for (const item of chars(reverse)) { if (item.ch.trim()) break; spaces.push(item); }
    return spaces.length > keep ? spaces[spaces.length - keep - 1] : null;
  };
  const head = edge(false, keepLead), tail = edge(true, keepTrail), next = range.cloneRange();
  if (head) next.setStart(head.node, head.i + 1);
  if (tail) next.setEnd(tail.node, tail.i);
  return next;
};

export const createInlineTextEditor = ({ documentRef = document, onError = () => {}, getBounds = () => null } = {}) => {
  const win = documentRef.defaultView, style = documentRef.createElement('style');
  style.textContent = css; documentRef.head.append(style);
  const bar = documentRef.createElement('div');
  bar.className = 'inline-text-editor-bar'; bar.hidden = true;
  bar.innerHTML = `<button type="button" class="inline-text-editor-marks" aria-pressed="true">${MARKS_ICON}</button><button type="button" class="inline-text-editor-cancel">${CANCEL_ICON}</button><button type="button" class="inline-text-editor-save">${SAVE_ICON}</button>`;
  documentRef.body.append(bar);
  const [marksButton, cancelButton, saveButton] = bar.querySelectorAll('button');
  const bindings = [];
  const listen = (target, type, fn, options) => { target?.addEventListener(type, fn, options); bindings.push(() => target?.removeEventListener(type, fn, options)); };
  let session = null;

  // 编辑框里当前的文字（红字块不算）与光标位置
  const liveText = el => {
    let text = '';
    const walk = node => { for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.data;
      else if (child.nodeName === 'BR') text += '\n';
      else if (child.nodeName !== 'DEL') walk(child);
    } };
    walk(el); return text.replace(/\r\n?/g, '\n');
  };
  const caretOffset = el => {
    const current = win.getSelection();
    if (!current?.rangeCount) return null;
    const range = current.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    const before = documentRef.createRange(); before.selectNodeContents(el); before.setEnd(range.startContainer, range.startOffset);
    const holder = documentRef.createElement('div'); holder.append(before.cloneContents());
    return liveText(holder).length;
  };
  // 光标放回文字中的位置；正好落在红字块边界时放在它前面，退格删的是前一个正常字
  const placeCaret = (el, at) => {
    const range = documentRef.createRange();
    let remaining = at, placed = false;
    for (const child of el.childNodes) {
      if (child.nodeName === 'DEL') continue;
      const node = child.nodeType === 3 ? child : child.firstChild, length = child.textContent.length;
      if (remaining <= length && node) { range.setStart(node, Math.min(remaining, node.length)); placed = true; break; }
      remaining -= length;
    }
    if (!placed) range.selectNodeContents(el);
    range.collapse(placed);
    const current = win.getSelection(); current.removeAllRanges(); current.addRange(range);
  };
  const position = () => {
    if (!session) return;
    const rects = session.el.getClientRects(), box = session.el.getBoundingClientRect();
    const first = rects[0] || box, last = rects[rects.length - 1] || box;
    const viewport = win.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    const area = getBounds?.(), barWidth = bar.offsetWidth || 128, barHeight = bar.offsetHeight || 46;
    const minTop = Math.max(top, area?.top ?? top) + 8, maxBottom = Math.min(top + height, area?.bottom ?? top + height) - 8;
    // 默认在最后一行下方；放不下就到第一行上方，再放不下就贴着可停靠区域的底边
    let y = last.bottom + 8, line = last;
    if (y + barHeight > maxBottom) {
      const above = first.top - barHeight - 8 >= minTop;
      y = above ? first.top - barHeight - 8 : maxBottom - barHeight; line = above ? first : last;
    }
    bar.style.left = Math.max(left + 8, Math.min(left + width - barWidth - 8, line.right - barWidth)) + 'px';
    bar.style.top = Math.max(minTop, Math.min(maxBottom - barHeight, y)) + 'px';
  };
  const paint = caret => {
    const { el, state } = session;
    el.innerHTML = inlineEditSegments(state).map(segment => segment.type === 'eq' ? escapeHtml(segment.text)
      : segment.type === 'ins' ? `<ins>${escapeHtml(segment.text)}</ins>`
        : `<del contenteditable="false" data-from="${segment.from}" data-to="${segment.to}" title="${escapeHtml(t('点一下恢复'))}">${escapeHtml(segment.text)}</del>`).join('');
    if (documentRef.activeElement === el) placeCaret(el, caret ?? provenanceText(state).length);
    position();
  };
  const remember = caret => {
    session.history = session.history.slice(0, session.cursor + 1);
    session.history.push({ state: cloneInlineEditProvenance(session.state), caret });
    session.cursor = session.history.length - 1;
  };
  const sync = () => {
    if (!session || session.busy) return;
    const caret = caretOffset(session.el), text = liveText(session.el);
    // 文字没变（例如退格碰掉了红字块）也重画，把红字块补回来；只有文字变了才记入撤销历史
    if (applyInlineEditTextChange(session.state, text, caret ?? text.length)) remember(caret);
    paint(caret);
  };
  const step = delta => {
    const next = session.cursor + delta;
    if (next < 0 || next >= session.history.length) return;
    session.cursor = next;
    const entry = session.history[next];
    session.state = cloneInlineEditProvenance(entry.state); paint(entry.caret);
  };
  const end = saved => {
    const current = session; if (!current) return;
    session = null; bar.hidden = true;
    current.el.remove();
    if (!saved) current.restore();
    current.resolve(saved);
  };
  const save = async () => {
    if (!session || session.busy) return;
    const current = session, text = provenanceText(current.state);
    if (text === current.draft.text) { end(false); return; }
    current.busy = true; bar.querySelectorAll('button').forEach(button => { button.disabled = true; });
    current.el.contentEditable = 'false';
    try {
      const saved = await current.draft.save(text, { ops: inlineEditOps(current.state) });
      if (session === current) end(Boolean(saved));
    } catch (error) {
      if (session === current) onError(error.message);
    } finally {
      bar.querySelectorAll('button').forEach(button => { button.disabled = false; });
      if (session === current) { current.busy = false; current.el.contentEditable = current.mode; current.el.focus({ preventScroll: true }); }
    }
  };

  listen(bar, 'pointerdown', event => event.preventDefault());
  listen(marksButton, 'click', () => {
    if (!session) return;
    const hidden = session.el.classList.toggle('plain-view');
    marksButton.setAttribute('aria-pressed', String(!hidden));
  });
  listen(cancelButton, 'click', () => { if (!session?.busy) end(false); });
  listen(saveButton, 'click', save);
  listen(win, 'resize', position); listen(win.visualViewport, 'resize', position); listen(win.visualViewport, 'scroll', position);
  listen(documentRef, 'scroll', position, true);

  const bindEditor = el => {
    el.addEventListener('input', event => { if (!event.isComposing) sync(); });
    el.addEventListener('compositionend', () => setTimeout(sync, 0));
    el.addEventListener('beforeinput', event => {
      if (session?.busy) { event.preventDefault(); return; }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); step(event.inputType === 'historyUndo' ? -1 : 1); }
    });
    el.addEventListener('keydown', event => {
      if (event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!session?.busy) end(false); }
      else if (mod && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); save(); }
      else if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); event.stopPropagation(); step(key === 'y' || event.shiftKey ? 1 : -1); }
    });
    // 点红字：把这段原文放回原位；编辑框内的点击不传给气泡（避免触发消息上的点击动作）
    el.addEventListener('click', event => {
      event.stopPropagation();
      const mark = event.target.closest?.('del[data-from]');
      if (!mark || !session || session.busy) return;
      const caret = restoreInlineEditDeleted(session.state, Number(mark.dataset.from), Number(mark.dataset.to));
      remember(caret); el.focus({ preventScroll: true }); paint(caret);
    });
    el.addEventListener('dblclick', event => event.stopPropagation());
  };

  return {
    // draft：runtime.open 的结果；range：选区（须在 bubble 内）。保存成功返回 true，取消或中途失效返回 false。
    show({ draft, range, bubble }) {
      if (session) return Promise.resolve(false);
      const hidden = hideRange(narrowToEditable(range, draft.text, win), bubble, win);
      if (!hidden) return Promise.resolve(false);
      const el = documentRef.createElement('span');
      el.className = 'inline-text-editor';
      el.contentEditable = 'plaintext-only';
      if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
      el.spellcheck = false;
      el.setAttribute('role', 'textbox'); el.setAttribute('aria-multiline', 'true'); el.setAttribute('aria-label', t('编辑中的文字'));
      hidden.anchor.before(el);
      bindEditor(el);
      const state = createInlineEditProvenance(draft.text);
      marksButton.title = t('显示或隐藏修改标记'); marksButton.setAttribute('aria-label', marksButton.title); marksButton.setAttribute('aria-pressed', 'true');
      cancelButton.title = t('取消（Esc）'); cancelButton.setAttribute('aria-label', t('取消编辑'));
      saveButton.title = t('保存（Ctrl+Enter）'); saveButton.setAttribute('aria-label', t('保存修改'));
      const result = new Promise(resolve => {
        session = { el, draft, state, restore: hidden.restore, resolve, busy: false, mode: el.contentEditable,
          history: [{ state: cloneInlineEditProvenance(state), caret: draft.text.length }], cursor: 0 };
      });
      bar.hidden = false;
      el.focus({ preventScroll: true });
      paint(draft.text.length);
      return result;
    },
    get isOpen() { return Boolean(session); },
    // 编辑框被消息重绘冲掉时结束编辑（原文已随重绘回来，不必再还原）
    get detached() { return Boolean(session && !session.el.isConnected); },
    close() { if (session && !session.busy) end(false); },
    dispose() { if (session) end(false); bindings.forEach(remove => remove()); bar.remove(); style.remove(); },
  };
};
