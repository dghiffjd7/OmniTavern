import { t } from '../../i18n/index.js';
import { createInputSuggestionRuntime, splitInputSuggestionCharacters } from './input-suggestion-runtime.js';
import { bindInputSuggestionTouch } from './input-suggestion-touch.js';

// 仅显式传入的主输入框接入。镜像层不写入输入值，接受时沿用原输入事件与撤销栈。
export const bindInputSuggestionComposer = ({ input, getSettings, getContext, request, runtimeOptions = {} } = {}) => {
  if (!input?.parentElement) return { dispose() {} };
  const doc = input.ownerDocument, win = doc.defaultView;
  const mirror = doc.createElement('div');
  mirror.className = 'input-suggestion-mirror'; mirror.hidden = true;
  mirror.setAttribute('aria-hidden', 'true');
  const prefix = doc.createElement('span'), ghost = doc.createElement('span');
  prefix.className = 'input-suggestion-prefix'; ghost.className = 'input-suggestion-text';
  mirror.append(prefix, ghost);
  const accept = doc.createElement('button');
  accept.type = 'button'; accept.className = 'input-suggestion-accept'; accept.hidden = true;
  accept.setAttribute('aria-label', t('采纳输入建议'));
  accept.title = t('点击采纳全部，长按拖选部分；按住 Tab 用左右方向键选择，松开采纳。');
  const label = doc.createElement('span');
  label.className = 'input-suggestion-label'; accept.append(label);
  const createParts = parent => {
    const selected = doc.createElement('span'), remaining = doc.createElement('span');
    selected.className = 'input-suggestion-selected'; remaining.className = 'input-suggestion-remaining';
    parent.append(selected, remaining);
    return { selected, remaining };
  };
  const ghostParts = createParts(ghost), labelParts = createParts(label);
  input.parentElement.append(mirror, accept);
  let composing = false, inserting = false, suggestion = '', tabSelection = null, touchSelection = null, touch = null;
  const snapshot = () => {
    const start = input.selectionStart, end = input.selectionEnd;
    const context = getContext();
    return {
      contextKey: context?.key,
      agentContext: context?.agentContext ? { ...context.agentContext } : undefined,
      requestContext: context?.requestContext,
      referenceContext: context?.referenceContext,
      active: context?.active !== false && doc.activeElement === input && !composing && !input.disabled && !input.readOnly
        && start === end && input.getClientRects().length > 0,
      before: input.value.slice(0, start), after: input.value.slice(end), settings: getSettings(),
    };
  };
  const layout = () => {
    if (mirror.hidden) return;
    const style = win.getComputedStyle(input);
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'direction', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) mirror.style[prop] = style[prop];
    mirror.style.left = `${input.offsetLeft}px`; mirror.style.top = `${input.offsetTop}px`;
    mirror.style.width = `${input.offsetWidth}px`; mirror.style.height = `${input.offsetHeight}px`;
    mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft;
  };
  const render = () => {
    const selection = touchSelection?.active ? touchSelection : tabSelection;
    const selecting = selection?.adjusted === true;
    const selected = selecting ? selection.characters.slice(0, selection.count).join('') : '';
    const remaining = suggestion.slice(selected.length);
    prefix.textContent = input.value.slice(0, input.selectionStart);
    for (const parts of [ghostParts, labelParts]) {
      parts.selected.textContent = selected;
      parts.remaining.textContent = remaining;
    }
    // 光标后有原文时用建议条承载，避免灰字覆盖后文。
    mirror.hidden = !suggestion || input.selectionEnd !== input.value.length;
    accept.hidden = !suggestion;
    accept.classList.toggle('is-selecting', selecting);
    accept.classList.toggle('is-touch-selecting', touchSelection?.active === true);
    layout();
    if (selected && !touchSelection) {
      const rects = labelParts.selected.getClientRects();
      const edge = rects[rects.length - 1], bounds = label.getBoundingClientRect();
      if (edge?.bottom > bounds.bottom) label.scrollTop += edge.bottom - bounds.bottom;
      else if (edge?.top < bounds.top) label.scrollTop -= bounds.top - edge.top;
    } else label.scrollTop = 0;
  };
  const runtime = createInputSuggestionRuntime({
    ...runtimeOptions, getSnapshot: snapshot, request,
    onSuggestion: text => {
      suggestion = text;
      tabSelection = null;
      touch?.cancel();
      render();
    },
  });
  const apply = count => {
    if (composing) return false;
    inserting = true;
    try {
      return runtime.commit(count, text => {
        const original = input.value;
        const inserted = doc.execCommand?.('insertText', false, text);
        if (!inserted || input.value === original) {
          input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
          input.dispatchEvent(new win.Event('input', { bubbles: true }));
        }
      });
    } finally { inserting = false; }
  };
  touch = bindInputSuggestionTouch({
    target: accept, label, getSuggestion: runtime.peek, onCommit: apply,
    onSelection: selection => { touchSelection = selection; tabSelection = null; render(); },
  });
  const bindings = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    bindings.push(() => target.removeEventListener(type, handler, options));
  };
  listen(input, 'input', () => { if (!inserting) runtime.schedule(); });
  listen(input, 'input-suggestion-reset', () => runtime.cancel());
  listen(input, 'compositionstart', () => { composing = true; runtime.cancel(); });
  listen(input, 'compositionend', () => { composing = false; runtime.schedule(); });
  listen(input, 'blur', () => runtime.cancel());
  listen(input, 'pointerdown', () => runtime.cancel());
  listen(input, 'keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (touchSelection) touch.cancel();
    const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'Tab' && plain && runtime.peek()) {
      // Tab 按下/长按保持灰字，直到首个 → 才开始高亮；keyup 一次确认。
      if (!tabSelection) tabSelection = { text: suggestion, characters: splitInputSuggestionCharacters(suggestion), count: 0, adjusted: false };
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (tabSelection && plain && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      if (runtime.peek() !== tabSelection.text) { runtime.cancel(); return; }
      if (event.key === 'ArrowRight') {
        tabSelection.adjusted = true;
        tabSelection.count = Math.min(tabSelection.characters.length, tabSelection.count + 1);
      } else if (tabSelection.adjusted) tabSelection.count = Math.max(0, tabSelection.count - 1);
      render();
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (tabSelection) runtime.cancel();
    if (['Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) runtime.cancel();
  }, true);
  listen(doc, 'keyup', event => {
    if (event.key !== 'Tab' || !tabSelection) return;
    const selection = tabSelection;
    tabSelection = null;
    if (composing || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || runtime.peek() !== selection.text) {
      runtime.cancel(); return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    render();
    if (!selection.adjusted || selection.count > 0) apply(selection.adjusted ? selection.count : undefined);
  }, true);
  listen(input, 'scroll', layout);
  listen(win, 'resize', layout);
  listen(win, 'blur', () => runtime.cancel());
  listen(doc, 'visibilitychange', () => { if (doc.hidden) runtime.cancel(); });
  listen(win, 'agent-feature-settings-changed', event => { if (event.detail?.id === 'text_completion') runtime.reset(); });
  listen(win, 'session-changed', () => runtime.cancel());
  const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(layout) : null;
  resize?.observe(input);
  const modeObserver = new win.MutationObserver(() => runtime.cancel());
  modeObserver.observe(doc.body, { attributes: true, attributeFilter: ['data-ui-mode'] });
  return { cancel: runtime.cancel, dispose: () => { runtime.dispose(); touch.dispose(); bindings.forEach(unbind => unbind()); resize?.disconnect(); modeObserver.disconnect(); mirror.remove(); accept.remove(); } };
};
