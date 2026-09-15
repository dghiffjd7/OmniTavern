// Exploratory Windows WebView probe. Actual bubble/menu handlers, isolated text,
// trusted CDP input, and a memory-only editor. No production registration or writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const output = 'scripts/dev/tmp/bubble-selection-feasibility';
mkdirSync(output, { recursive: true });
const page = await findAppPageTarget();
if (!page?.webSocketDebuggerUrl) throw Error('Inspectable Windows dev app is not ready');
const pending = new Map();
let client, sequence = 0;
await new Promise((resolve, reject) => {
  client = createWsClient(page.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject,
    onMessage: raw => {
      const message = JSON.parse(raw), entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    },
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  client.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => evaluate('window.__bubbleSelectionLab.snapshot()');
const initial = await evaluate('({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })');
const screenshot = async name => {
  const { data } = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${output}/${name}.png`, Buffer.from(data, 'base64'));
};

const setup = async ({ touchTrial = false } = {}) => {
  window.__bubbleSelectionLab?.dispose();
  const { resolveRenderedAgentTarget, spliceRenderedAgentTarget } = await import('/scripts/agent/agent-rendered-target.js');
  const { createRpMessageIconMarkup } = await import('/scripts/ui/chat/rp-message-actions-ui-utils.js');
  const ui = window.appBridge?.getChatUI?.();
  if (!ui?.buildMessageElement || !ui.contextMenu) throw Error('Actual chat UI is not ready');
  const doc = document, previousFocus = doc.activeElement;
  const previousRanges = Array.from({ length: getSelection().rangeCount }, (_, i) => getSelection().getRangeAt(i).cloneRange());
  const oldMenuChildren = Array.from(ui.contextMenu.childNodes), oldMenuStyle = ui.contextMenu.style.cssText;
  ui.clearLongPress(); ui.contextMenu.style.display = 'none';
  const host = doc.createElement('div'); host.dataset.bubbleSelectionLab = '';
  host.style.cssText = 'position:fixed;inset:0;z-index:19000;background:var(--app-surface-page,#f6f5f2);color:var(--app-text-primary,#222);display:flex;flex-direction:column';
  host.innerHTML = `<style>
    [data-bubble-selection-lab] * {box-sizing:border-box}
    [data-bubble-selection-lab] .lab-header{padding:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--app-border-default,#ddd)}
    [data-bubble-selection-lab] :is(.lab-header button,.lab-edit,.lab-dialog button){font:inherit;padding:8px 12px;min-height:44px;border:1px solid var(--app-border-default);border-radius:var(--app-radius-md);background:var(--app-surface-card);color:inherit;cursor:pointer}
    [data-bubble-selection-lab] :is(button,summary):focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:3px}
    [data-bubble-selection-lab] .lab-scroll{flex:1;min-height:0;overflow:auto;padding:24px 16px;overscroll-behavior:contain}
    [data-bubble-selection-lab] .lab-scroll>[data-msg-id]{max-width:760px;margin:0 auto 30px;display:block}
    [data-bubble-selection-lab] .QQ_chat_msgdiv{font-size:18px;line-height:1.9;max-width:100%}
    [data-bubble-selection-lab] .lab-filler{height:920px;margin:32px auto;max-width:720px;color:var(--app-text-muted,#777);line-height:2.4}
    [data-bubble-selection-lab] .lab-edit{position:fixed;z-index:22000;box-shadow:var(--app-shadow-md);font-size:13px;padding:8px 13px;align-items:center;gap:7px}
    [data-bubble-selection-lab] .lab-edit:not([hidden]){display:inline-flex}
    [data-bubble-selection-lab] .lab-dialog{position:fixed;inset:auto;margin:0;width:640px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--app-border-subtle);border-radius:var(--app-radius-lg);background:var(--app-surface-card);color:var(--app-text-primary);box-shadow:var(--app-shadow-md);overflow:hidden;font-family:var(--app-font-family,inherit)}
    [data-bubble-selection-lab] .lab-dialog[open]{display:flex;flex-direction:column}
    [data-bubble-selection-lab] .lab-dialog::backdrop{background:var(--app-surface-overlay)}
    [data-bubble-selection-lab] .lab-editor-heading{display:flex;align-items:center;gap:12px;padding:20px 22px 16px;flex:none}
    [data-bubble-selection-lab] .lab-pencil{display:grid;place-items:center;width:38px;height:38px;flex:none;border:1px solid var(--app-border-subtle);border-radius:var(--app-radius-md);color:var(--app-accent-primary);background:var(--app-accent-soft)}
    [data-bubble-selection-lab] .lab-editor-heading h2{font-size:17px;font-weight:650;line-height:1.35;margin:0;text-wrap:balance}
    [data-bubble-selection-lab] .lab-editor-subtitle{margin:4px 0 0;font-size:12px;color:var(--app-text-muted);line-height:1.4}
    [data-bubble-selection-lab] .lab-dialog .lab-editor-close{margin-left:auto;display:grid;place-items:center;width:44px;padding:0;border:0;background:transparent;color:var(--app-text-secondary)}
    [data-bubble-selection-lab] .lab-editor-body{padding:0 22px 20px;overflow:auto;min-height:0;overscroll-behavior:contain}
    [data-bubble-selection-lab] .lab-editor-field{border:1px solid var(--app-border-default);border-radius:var(--app-radius-md);background:var(--app-surface-input);overflow:hidden}
    [data-bubble-selection-lab] .lab-editor-field:focus-within{border-color:color-mix(in srgb,var(--app-accent-primary) 55%,var(--app-border-default));box-shadow:0 0 0 3px var(--app-accent-soft)}
    [data-bubble-selection-lab] .lab-editor-label{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px 0;font-size:12px;color:var(--app-text-muted)}
    [data-bubble-selection-lab] .lab-editor-count{font-variant-numeric:tabular-nums;white-space:nowrap}
    [data-bubble-selection-lab] .lab-dialog textarea{display:block;width:100%;min-height:190px;max-height:340px;margin:0;padding:12px 16px 18px;border:0;outline:none;box-shadow:none;resize:vertical;background:transparent;color:var(--app-text-primary);font:inherit;font-size:16px;line-height:1.9;caret-color:var(--app-accent-primary);overflow-wrap:anywhere}
    [data-bubble-selection-lab] .lab-original{margin-top:12px;border:0;border-radius:var(--app-radius-md);font-size:12px;color:var(--app-text-muted)}
    [data-bubble-selection-lab] .lab-original summary{display:flex;align-items:center;gap:5px;min-height:36px;width:fit-content;cursor:pointer;list-style:none}
    [data-bubble-selection-lab] .lab-original summary::-webkit-details-marker{display:none}
    [data-bubble-selection-lab] .lab-original[open] summary svg{transform:rotate(90deg)}
    [data-bubble-selection-lab] .lab-original pre{font:inherit;font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 14px;margin:3px 0 0;border-left:2px solid var(--app-border-default);color:var(--app-text-secondary);background:var(--app-surface-subtle);border-radius:0 var(--app-radius-sm) var(--app-radius-sm) 0;user-select:text}
    [data-bubble-selection-lab] .lab-editor-status{font-size:12px;line-height:1.5;color:var(--app-danger-text);margin:12px 0 0}
    [data-bubble-selection-lab] .lab-editor-status:empty{display:none}
    [data-bubble-selection-lab] .lab-editor-footer{display:flex;align-items:center;gap:14px;justify-content:space-between;padding:14px 22px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--app-border-subtle);background:var(--app-surface-subtle);flex:none}
    [data-bubble-selection-lab] .lab-save-scope{font-size:12px;line-height:1.5;color:var(--app-text-muted)}
    [data-bubble-selection-lab] .lab-editor-actions{display:flex;gap:8px;flex:none}
    [data-bubble-selection-lab] .lab-dialog .lab-secondary{background:transparent;border-color:transparent;color:var(--app-text-secondary);padding-inline:18px}
    [data-bubble-selection-lab] .lab-dialog .lab-primary{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--app-accent-primary);border-color:transparent;color:var(--app-text-inverse);padding-inline:18px;font-weight:600;font-size:14px}
    [data-bubble-selection-lab] .lab-dialog button:disabled{opacity:.45;cursor:default}
    @media(hover:hover){[data-bubble-selection-lab] .lab-dialog :is(.lab-secondary,.lab-editor-close):hover{background:var(--app-surface-hover)}[data-bubble-selection-lab] .lab-dialog .lab-primary:hover:not(:disabled){background:var(--app-accent-strong)}}
    @media(max-width:560px){[data-bubble-selection-lab] .lab-editor-heading{padding:17px 16px 14px;gap:10px}[data-bubble-selection-lab] .lab-editor-body{padding:0 16px 14px}[data-bubble-selection-lab] .lab-editor-footer{align-items:stretch;flex-direction:column;gap:10px;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}[data-bubble-selection-lab] .lab-editor-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}[data-bubble-selection-lab] .lab-dialog textarea{min-height:150px;resize:none}[data-bubble-selection-lab] .lab-save-scope{font-size:11px}}
    [data-bubble-selection-lab] .lab-status{font-size:13px;flex:1;min-width:120px;color:var(--app-text-secondary,#555)}
  </style><div class="lab-header"><strong>气泡文字选择</strong><span class="lab-status">选中文字后点“编辑”；按住不动可观察消息菜单。</span><button data-lab="undo" disabled>撤销</button><button data-lab="close">关闭验证</button></div><div class="lab-scroll"></div>
  <button class="lab-edit" hidden>${createRpMessageIconMarkup('edit', { size: 15 })}<span>编辑所选文字</span></button>
  <dialog class="lab-dialog" aria-labelledby="lab-editor-title" aria-describedby="lab-save-scope">
    <header class="lab-editor-heading"><span class="lab-pencil" aria-hidden="true">${createRpMessageIconMarkup('edit', { size: 18 })}</span><div><h2 id="lab-editor-title">编辑片段</h2><p class="lab-editor-subtitle">当前回复 · 所选文字</p></div><button class="lab-editor-close" data-lab="close-editor" aria-label="取消编辑"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div class="lab-editor-body"><div class="lab-editor-field"><div class="lab-editor-label"><label for="lab-selected-text">修改文字</label><span class="lab-editor-count"></span></div><textarea id="lab-selected-text" aria-label="所选文字" spellcheck="false"></textarea></div><details class="lab-original"><summary><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>对照原文</summary><pre></pre></details><p class="lab-editor-status" role="status"></p></div>
    <footer class="lab-editor-footer"><span class="lab-save-scope" id="lab-save-scope">仅替换所选文字</span><div class="lab-editor-actions"><button class="lab-secondary" data-lab="cancel">取消</button><button class="lab-primary" data-lab="save">${createRpMessageIconMarkup('check', { size: 16 })}<span>保存修改</span></button></div></footer>
  </dialog>`;
  doc.body.append(host);
  const scroll = host.querySelector('.lab-scroll'), bar = host.querySelector('.lab-edit'), dialog = host.querySelector('dialog');
  const editor = dialog.querySelector('textarea'), status = host.querySelector('.lab-status');
  const saveButton = host.querySelector('[data-lab="save"]'), originalPreview = dialog.querySelector('.lab-original');
  const paragraphs = [
    '窗边的灯光照着摊开的书页，她抬起头，看见晚风拂过窗帘。桌上的热茶还冒着白汽，走廊里传来很轻的脚步声。',
    '夜色渐深，她把书签夹在这一页，起身关上窗户。明天还有许多事情要做，今晚却可以先安静地休息一会儿。',
  ];
  const original = '<think>这段隐藏内容必须保留。</think>\r\n\r\n' + paragraphs.join('\r\n\r\n') + '\r\n\r\n<tableEdit>保留表格指令</tableEdit>';
  let raw = original, display = paragraphs.join('\n\n'), wrapper, bubble, chosen = null, frozen = null, history = [];
  let logs = [], started = performance.now(), menus = 0, lastMenuVisible = false, selectionPending = 0, dragging = false;
  let touchGesture = null, suppressTouchClick = false;
  const bindings = [];
  const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); bindings.push(() => target.removeEventListener(type, fn, options)); };
  const selected = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!bubble?.contains(range.startContainer) || !bubble?.contains(range.endContainer)) return null;
    return { range: range.cloneRange(), text: selection.toString() };
  };
  const refreshBar = () => {
    const next = selected();
    if (!next?.text?.trim() || dialog.open || dragging) { bar.hidden = true; return; }
    chosen = next;
    const rect = next.range.getBoundingClientRect();
    bar.hidden = false;
    bar.style.left = Math.max(8, Math.min(innerWidth - bar.offsetWidth - 8, rect.left)) + 'px';
    bar.style.top = Math.max(8, Math.min(innerHeight - 52, rect.bottom + 8)) + 'px';
  };
  const render = () => {
    if (wrapper) { ui.cleanupRichTextMounts(wrapper); wrapper.remove(); }
    const message = { id: 'bubble-selection-isolated', role: 'assistant', type: 'text', content: display, raw, rawSource: raw, status: 'sent', meta: {} };
    wrapper = ui.buildMessageElement(message); scroll.prepend(wrapper);
    bubble = wrapper.querySelector('.QQ_chat_msgdiv') || wrapper.querySelector('.chat-message-content');
    if (!bubble) throw Error('Actual message builder did not create a text bubble');
  };
  render();
  const filler = doc.createElement('div'); filler.className = 'lab-filler';
  filler.textContent = '下方留出阅读滚动区域。\n'.repeat(15); scroll.append(filler);
  const menuObserver = new MutationObserver(() => {
    const visible = ui.contextMenu.style.display !== 'none';
    if (visible && !lastMenuVisible) { menus++; logs.push({ type: 'APP_MENU', ms: Math.round(performance.now() - started), selection: getSelection().toString() }); }
    lastMenuVisible = visible;
  }); menuObserver.observe(ui.contextMenu, { attributes: true, attributeFilter: ['style'] });
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'selectstart']) listen(scroll, type, event => {
    if (logs.length < 60) logs.push({ type, pointerType: event.pointerType, trusted: event.isTrusted, ms: Math.round(performance.now() - started), selection: getSelection().toString(), prevented: event.defaultPrevented });
  }, true);
  listen(scroll, 'pointerdown', () => { dragging = true; bar.hidden = true; }, true);
  listen(doc, 'pointerup', () => { dragging = false; clearTimeout(selectionPending); selectionPending = setTimeout(refreshBar, 90); });
  listen(doc, 'pointercancel', () => { dragging = false; });
  listen(doc, 'selectionchange', () => {
    // The prototype has an explicit selection action; it never opens an editor while dragging.
    clearTimeout(selectionPending); selectionPending = setTimeout(refreshBar, 120);
  });
  // Keep actual menu rendering/positioning, but never dispatch its actions into
  // the user's real session while the exploratory fixture is visible.
  const blockFixtureAction = event => {
    event.preventDefault(); event.stopImmediatePropagation();
    status.textContent = '这里只验证菜单与选字；此菜单的聊天操作未执行。';
  };
  listen(ui.contextMenu, 'click', blockFixtureAction, true);
  listen(host, 'click', event => {
    if (wrapper.contains(event.target) && event.target.closest('button,a')) blockFixtureAction(event);
  }, true);
  if (touchTrial) {
    status.textContent = '直接滑动可滚动；按住后拖动选字；按住不动显示菜单。';
    const caretAt = touch => {
      const position = doc.caretPositionFromPoint?.(touch.clientX, touch.clientY);
      let range;
      if (position) {
        range = doc.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true);
      } else range = doc.caretRangeFromPoint?.(touch.clientX, touch.clientY);
      return range && bubble.contains(range.startContainer) ? range : null;
    };
    const trace = (type, extra = {}) => logs.push({ type, ms: Math.round(performance.now() - started), ...extra });
    listen(scroll, 'touchstart', event => {
      suppressTouchClick = false;
      if (event.touches.length !== 1 || !bubble.contains(event.target) || event.target.closest('button,a,input,textarea,select,summary')) {
        touchGesture = null; return;
      }
      const touch = event.changedTouches[0], anchor = caretAt(touch);
      touchGesture = anchor ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: performance.now(), anchor, selecting: false, scrolling: false } : null;
    }, { capture: true, passive: true });
    listen(scroll, 'touchmove', event => {
      const gesture = touchGesture;
      if (!gesture || gesture.scrolling) return;
      if (event.touches.length !== 1) { touchGesture = null; return; }
      const touch = Array.from(event.changedTouches).find(t => t.identifier === gesture.id);
      if (!touch) return;
      const distance = Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y);
      if (performance.now() - gesture.at < 400) {
        if (distance > 8) { gesture.scrolling = true; trace('TRIAL_READING_SCROLL'); }
        return;
      }
      if (!event.cancelable) { trace('TRIAL_BROWSER_OWNS_GESTURE'); gesture.scrolling = true; return; }
      event.preventDefault();
      if (!gesture.selecting && distance < 8) return;
      ui.clearLongPress(); ui.contextMenu.style.display = 'none'; bar.hidden = true;
      const end = caretAt(touch); if (!end) return;
      const range = doc.createRange();
      const reverse = gesture.anchor.compareBoundaryPoints(Range.START_TO_START, end) > 0;
      const a = reverse ? end : gesture.anchor, b = reverse ? gesture.anchor : end;
      range.setStart(a.startContainer, a.startOffset); range.setEnd(b.startContainer, b.startOffset);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      if (!gesture.selecting) trace('TRIAL_SELECT_START', { trusted: event.isTrusted, cancelable: event.cancelable });
      gesture.selecting = true; dragging = true; suppressTouchClick = true;
    }, { capture: true, passive: false });
    listen(scroll, 'touchend', event => {
      if (touchGesture?.selecting) {
        event.preventDefault(); dragging = false; ui.clearLongPress(); ui.contextMenu.style.display = 'none';
        trace('TRIAL_SELECT_END', { selection: selected()?.text || '' });
        clearTimeout(selectionPending); selectionPending = setTimeout(refreshBar, 90);
      }
      touchGesture = null;
    }, { capture: true, passive: false });
    listen(scroll, 'touchcancel', () => {
      if (touchGesture?.selecting) getSelection().removeAllRanges();
      touchGesture = null; dragging = false; bar.hidden = true; ui.clearLongPress(); trace('TRIAL_CANCEL');
    }, { capture: true, passive: true });
    listen(scroll, 'click', event => {
      if (suppressTouchClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressTouchClick = false; }
    }, true);
  }
  listen(bar, 'pointerdown', event => event.preventDefault());
  const positionEditor = () => {
    if (!dialog.open) return;
    const viewport = window.visualViewport;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const panelWidth = Math.min(640, Math.max(0, width - 24));
    dialog.style.maxWidth = panelWidth + 'px'; dialog.style.width = panelWidth + 'px';
    dialog.style.maxHeight = Math.max(0, height - 24) + 'px';
    dialog.style.left = left + (width - panelWidth) / 2 + 'px';
    dialog.style.top = top + Math.max(12, width <= 560 ? height - dialog.offsetHeight - 12 : (height - dialog.offsetHeight) / 2) + 'px';
  };
  const updateEditorState = () => {
    const count = Array.from(editor.value).length;
    dialog.querySelector('.lab-editor-count').textContent = count + ' 字';
    saveButton.disabled = !frozen || editor.value === frozen.initialText;
  };
  listen(editor, 'input', updateEditorState);
  listen(originalPreview, 'toggle', positionEditor);
  listen(window, 'resize', positionEditor);
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', positionEditor);
    listen(window.visualViewport, 'scroll', positionEditor);
  }
  const openEditor = () => {
    if (!chosen?.text) return false;
    const target = resolveRenderedAgentTarget(raw, chosen.text);
    if (!target.ok) { status.textContent = target.message; return false; }
    frozen = { raw, target, initialText: chosen.text }; editor.value = chosen.text; bar.hidden = true;
    originalPreview.open = false; originalPreview.querySelector('pre').textContent = chosen.text;
    updateEditorState();
    dialog.querySelector('.lab-editor-status').textContent = '';
    ui.clearLongPress(); ui.contextMenu.style.display = 'none';
    dialog.showModal(); positionEditor(); editor.focus(); return true;
  };
  listen(bar, 'click', openEditor);
  listen(host.querySelector('[data-lab="cancel"]'), 'click', () => dialog.close());
  listen(host.querySelector('[data-lab="close-editor"]'), 'click', () => dialog.close());
  listen(saveButton, 'click', () => {
    try {
      if (!frozen || raw !== frozen.raw) throw Error('原文已经变化，请重新选择。');
      const next = spliceRenderedAgentTarget(frozen.target, editor.value);
      history.push({ raw, display }); raw = next;
      display = raw.replace(/^<think>[\s\S]*?<\/think>\r\n\r\n/, '').replace(/\r\n\r\n<tableEdit>[\s\S]*?<\/tableEdit>$/, '').replace(/\r\n/g, '\n');
      dialog.close(); getSelection().removeAllRanges(); chosen = null; render();
      host.querySelector('[data-lab="undo"]').disabled = false; status.textContent = '所选文字已修改。';
    } catch (error) { dialog.querySelector('.lab-editor-status').textContent = error.message; }
  });
  listen(host.querySelector('[data-lab="undo"]'), 'click', () => {
    const previous = history.pop(); if (!previous) return;
    raw = previous.raw; display = previous.display; render(); host.querySelector('[data-lab="undo"]').disabled = !history.length;
  });
  const rangeFor = text => {
    const walker = doc.createTreeWalker(bubble, NodeFilter.SHOW_TEXT), entries = []; let node, all = '';
    while ((node = walker.nextNode())) { entries.push({ node, start: all.length }); all += node.textContent; }
    const at = all.indexOf(text); if (at < 0) throw Error('Fixture text not found: ' + text);
    const locate = offset => { const entry = entries.find(n => offset < n.start + n.node.length) || entries.at(-1); return [entry.node, offset - entry.start]; };
    const range = doc.createRange(); range.setStart(...locate(at)); range.setEnd(...locate(at + text.length)); return range;
  };
  const f = {
    host, bar, editor, dialog, ui,
    points(text) {
      const range = rangeFor(text), begin = range.cloneRange(), end = range.cloneRange(); begin.collapse(true); end.collapse(false);
      const a = begin.getBoundingClientRect(), b = end.getBoundingClientRect();
      return { start: { x: a.left + .8, y: a.top + a.height / 2 }, end: { x: b.left - .8, y: b.top + b.height / 2 } };
    },
    reset() {
      ui.clearLongPress(); ui.contextMenu.style.display = 'none'; if (dialog.open) dialog.close(); getSelection().removeAllRanges();
      clearTimeout(selectionPending); dragging = false; bar.hidden = true; chosen = null; frozen = null; scroll.scrollTop = 0;
      touchGesture = null; suppressTouchClick = false;
      logs = []; menus = 0; lastMenuVisible = false; started = performance.now();
    },
    snapshot() {
      return { touchTrial, selected: selected()?.text || '', globalSelection: getSelection().toString(), bar: !bar.hidden, menu: ui.contextMenu.style.display !== 'none', menus,
        scrollTop: scroll.scrollTop, editorOpen: dialog.open, editorText: editor.value, raw, original, display, history: history.length,
        logs: [...logs], style: { userSelect: getComputedStyle(bubble).userSelect, touchAction: getComputedStyle(bubble).touchAction },
        bubble: { x: bubble.getBoundingClientRect().x, y: bubble.getBoundingClientRect().y, width: bubble.getBoundingClientRect().width, height: bubble.getBoundingClientRect().height } };
    },
    dispose() {
      ui.clearLongPress(); clearTimeout(selectionPending); menuObserver.disconnect(); bindings.forEach(fn => fn()); ui.cleanupRichTextMounts(wrapper);
      if (dialog.open) dialog.close(); host.remove(); ui.contextMenu.replaceChildren(...oldMenuChildren); ui.contextMenu.style.cssText = oldMenuStyle;
      getSelection().removeAllRanges(); for (const range of previousRanges) { try { getSelection().addRange(range); } catch {} }
      previousFocus?.focus?.({ preventScroll: true }); delete window.__bubbleSelectionLab;
    },
  };
  listen(host.querySelector('[data-lab="close"]'), 'click', () => f.dispose());
  window.__bubbleSelectionLab = f;
  return f.snapshot();
};

const reports = [];
let activePointer = '';
const reset = async () => { await evaluate('window.__bubbleSelectionLab.reset()'); await pause(160); };
const points = text => evaluate(`window.__bubbleSelectionLab.points(${JSON.stringify(text)})`);
const mouse = async (type, point, button = 'left') => {
  await command('Input.dispatchMouseEvent', { type, ...point, button, buttons: type === 'mouseReleased' ? 0 : button === 'left' ? 1 : 2, clickCount: 1 });
  activePointer = type === 'mouseReleased' ? '' : 'mouse';
};
const touch = async (type, point) => {
  await command('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
  activePointer = ['touchEnd', 'touchCancel'].includes(type) ? '' : 'touch';
};
const record = async name => {
  const result = { name, ...await state() }; reports.push(result);
  console.log(JSON.stringify({ name, selected: result.selected, menu: result.menu, menus: result.menus, bar: result.bar, scrollTop: result.scrollTop, editorOpen: result.editorOpen, logs: result.logs }));
  return result;
};
const touchTrial = process.argv.includes('--touch-trial');
const showOnly = process.argv.includes('--show');
const check = (value, message) => { if (!value) throw Error(message); };
const tapElement = async selector => {
  const point = await evaluate(`(() => { const r = window.__bubbleSelectionLab.host.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await touch('touchStart', point); await touch('touchEnd'); await pause(150);
};

try {
  await command('Page.bringToFront');
  await evaluate(`(${setup.toString()})(${JSON.stringify({ touchTrial })})`);
  if (showOnly) {
    console.log(JSON.stringify({ demoMounted: true, touchTrial, productionActionsBlocked: true }));
  } else if (!touchTrial) {
  await reset();
  let p = await points('窗边的灯光照着摊开的书页');
  await mouse('mousePressed', p.start); await pause(80);
  await mouse('mouseMoved', p.end); await pause(760);
  await mouse('mouseReleased', p.end); await pause(180);
  const selected = await record('desktop-drag-hold'); await screenshot('desktop-selected');
  if (selected.bar && selected.selected) {
    await evaluate('window.__bubbleSelectionLab.bar.click()');
    await screenshot('desktop-editor');
    await evaluate('window.__bubbleSelectionLab.editor.focus(); window.__bubbleSelectionLab.editor.select()');
    await command('Input.insertText', { text: '暖黄的灯光落在书页上' });
    await evaluate('window.__bubbleSelectionLab.host.querySelector("[data-lab=save]").click()');
    const saved = await record('desktop-edit-memory-only');
    if (!saved.raw.includes('<think>这段隐藏内容必须保留。</think>\r\n\r\n') || !saved.raw.endsWith('\r\n\r\n<tableEdit>保留表格指令</tableEdit>')) throw Error('Hidden source blocks changed');
    await evaluate('window.__bubbleSelectionLab.host.querySelector("[data-lab=undo]").click()');
    if ((await state()).raw !== selected.original) throw Error('Memory-only undo did not restore original');
  }
  await reset(); p = await points('窗边的灯光');
  await mouse('mousePressed', p.start); await pause(800); await record('desktop-stationary-hold'); await screenshot('desktop-menu');
  await mouse('mouseReleased', p.start);

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await reset(); p = await points('窗边的灯光');
  await touch('touchStart', p.start); await pause(800); await record('touch-stationary-hold'); await screenshot('touch-held');
  await touch('touchEnd'); await pause(180);

  await reset(); p = await points('窗边的灯光照着摊开的书页');
  await touch('touchStart', p.start); await pause(460); await touch('touchMove', p.end); await pause(340);
  await touch('touchEnd'); await pause(180); await record('touch-hold-then-drag'); await screenshot('touch-dragged');

  await reset(); p = await points('窗边的灯光照着摊开的书页');
  await touch('touchStart', p.start); await pause(850); await record('touch-late-drag-before-movement');
  await touch('touchMove', p.end); await pause(180); await touch('touchEnd'); await pause(180); await record('touch-late-drag-after-movement');

  await reset(); p = await points('夜色渐深');
  await touch('touchStart', p.start); await pause(40);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', { x: p.start.x, y: p.start.y - i * 18 }); await pause(30); }
  await touch('touchEnd'); await pause(720); await record('touch-reading-scroll');
  } else {
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const phrase = '窗边的灯光照着摊开的书页，她抬起头，看见晚风拂过窗帘。';
    await reset(); let p = await points(phrase);
    await touch('touchStart', p.start); await pause(460); await touch('touchMove', p.end); await pause(300);
    await touch('touchEnd'); await pause(180);
    let result = await record('trial-touch-multiline-selection'); await screenshot('trial-touch-selected');
    check(result.selected === phrase && result.bar && !result.menu && result.menus === 0 && result.scrollTop === 0, 'Held cross-line touch should select without scrolling or menu');
    await tapElement('.lab-edit'); result = await state();
    check(result.editorOpen && result.editorText === phrase, 'Touch edit should open the selected text only');
    await screenshot('trial-touch-editor');
    await evaluate('window.__bubbleSelectionLab.editor.focus(); window.__bubbleSelectionLab.editor.select()');
    const replacement = '她合上书，望着窗外渐暗的天空。';
    await command('Input.insertText', { text: replacement });
    await tapElement('[data-lab="save"]'); result = await record('trial-touch-edit-memory-only');
    check(result.raw === result.original.replace(phrase, replacement), 'Only the selected raw span may change');
    await evaluate('window.__bubbleSelectionLab.host.querySelector("[data-lab=undo]").click()');
    check((await state()).raw === result.original, 'Undo must restore the complete original');

    await reset(); p = await points('窗边的灯光');
    await touch('touchStart', p.start); await pause(850); result = await record('trial-touch-stationary-menu');
    check(result.menu && !result.selected && !result.bar, 'Stationary hold keeps the actual message menu');
    await screenshot('trial-touch-menu');
    const end = (await points('窗边的灯光照着摊开的书页')).end;
    await touch('touchMove', end); await pause(180); await touch('touchEnd'); await pause(180);
    result = await record('trial-touch-drag-after-menu');
    check(result.selected === '窗边的灯光照着摊开的书页' && !result.menu && result.bar && result.menus === 1, 'Moving after menu must close it and enter selection');

    await reset(); p = await points('夜色渐深');
    await touch('touchStart', p.start); await pause(40);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', { x: p.start.x, y: p.start.y - i * 18 }); await pause(30); }
    await touch('touchEnd'); await pause(720); result = await record('trial-touch-reading-scroll');
    check(result.scrollTop > 30 && !result.menu && !result.selected && !result.bar, 'Immediate movement must remain native reading scroll');

    await reset(); p = await points('窗边的灯光照着摊开的书页');
    await touch('touchStart', p.end); await pause(460); await touch('touchMove', p.start); await pause(120);
    result = await record('trial-touch-reverse-drag');
    check(result.selected === '窗边的灯光照着摊开的书页' && !result.menu && !result.bar, 'Reverse drag should select and wait for release');
    await touch('touchCancel'); await pause(200); result = await record('trial-touch-cancel');
    check(!result.selected && !result.bar && !result.menu && result.raw === result.original, 'Canceled gesture must clear preview without edits');
  }
  if (!showOnly) writeFileSync(`${output}/${touchTrial ? 'touch-trial' : 'observations'}.json`, JSON.stringify({ environment: 'Windows WebView2 with CDP touch emulation; not Android', initial, reports, modelRequests: 0, userDataWrites: 0 }, null, 2));
} finally {
  if (activePointer === 'touch') await touch('touchCancel').catch(() => {});
  if (activePointer === 'mouse') await mouse('mouseReleased', { x: 10, y: 10 }).catch(() => {});
  await command('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  await command('Emulation.setDeviceMetricsOverride', { ...initial, mobile: false }).catch(() => {});
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await evaluate('window.__bubbleSelectionLab?.reset()').catch(() => {});
  if (!process.argv.includes('--keep') && !showOnly) await evaluate('window.__bubbleSelectionLab?.dispose()').catch(() => {});
  client.close();
}
