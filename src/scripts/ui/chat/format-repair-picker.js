import { t } from '../../i18n/index.js';
import { isAgentToolReply } from '../../agent/agent-tool-targets.js';
import { mapAgentRawSelection } from '../../agent/agent-text-target.js';
import { createFormatRepairSelection } from '../../agent/format-repair-selection.js';
import { extractFormatFunctionBlocks } from './format-repair-side-effect-utils.js';
import { toolboxEscape as e, toolboxButton as button } from '../agent-toolbox-view.js';

const css = `
.fr-pickable{position:relative;outline:1px dashed var(--app-border-default);outline-offset:4px;border-radius:var(--app-radius-md)}
.fr-pickable.fr-picked{outline:2px solid var(--app-accent-primary);background-color:var(--app-accent-soft)}
.fr-pick-button{position:absolute;inset:0 0 auto auto;z-index:4;min-width:44px;min-height:44px;border:0;background:transparent;color:var(--app-accent-primary);cursor:pointer;display:grid;place-items:center}
.fr-pick-button span{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--app-border-default);border-radius:50%;background:var(--app-surface-card);box-shadow:var(--app-shadow-sm)}
.fr-picked .fr-pick-button span{background:var(--app-accent-primary);color:var(--app-text-inverse)}
.fr-pick-complex>.fr-pick-button{inset:0;width:100%;height:100%;align-items:start;justify-items:end;padding:10px;background:color-mix(in srgb,var(--app-surface-card) 12%,transparent);border-radius:inherit}
.fr-pick-button:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
.fr-source{box-sizing:border-box;position:fixed;inset:0;margin:auto;width:min(880px,calc(100vw - 24px));height:min(740px,calc(100dvh - 24px));max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--app-border-default);border-radius:var(--app-radius-lg);background:var(--app-surface-card);color:var(--app-text-primary);box-shadow:var(--app-shadow-md);overflow:hidden;font:inherit}
.fr-source[open]{display:flex;flex-direction:column}.fr-source::backdrop{background:var(--app-surface-overlay)}
.fr-source *{box-sizing:border-box}.fr-source header,.fr-source footer{display:flex;gap:12px;align-items:center;padding:14px 20px;flex:none}.fr-source header{border-bottom:1px solid var(--app-border-subtle)}.fr-source h2{font-size:16px;margin:0;flex:1}.fr-source button{min-height:44px;min-width:44px;padding:8px 12px;border:1px solid var(--app-border-subtle);border-radius:var(--app-radius-md);background:var(--app-surface-card);color:var(--app-text-primary);font:inherit;cursor:pointer}.fr-source button:disabled{opacity:.45;cursor:default}.fr-source button.at-primary{background:var(--app-accent-primary);color:var(--app-text-inverse);border-color:transparent}.fr-source :is(button,input):focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}.fr-source button svg{width:18px;height:18px}
.fr-source-toolbar{display:flex;align-items:center;gap:8px;padding:10px 20px;flex:none}.fr-source-toolbar input{min-width:0;flex:1;min-height:44px;border:1px solid var(--app-border-default);border-radius:var(--app-radius-md);padding:8px 12px;background:var(--app-surface-input);color:var(--app-text-primary);font:inherit;font-size:16px}
.fr-source-blocks{display:flex;gap:6px;overflow:auto;padding:0 20px 10px;flex:none}.fr-source-blocks:empty{display:none}.fr-source-blocks button{flex:none;font-size:12px}
.fr-source textarea{flex:1;min-height:100px;width:calc(100% - 40px);margin:0 20px;padding:14px;border:1px solid var(--app-border-default);border-radius:var(--app-radius-md);resize:none;outline:none;background:var(--app-surface-input);color:var(--app-text-primary);font:14px/1.8 ui-monospace,Consolas,monospace;tab-size:2;user-select:text;overscroll-behavior:contain}.fr-source textarea:focus{border-color:var(--app-accent-primary)}
.fr-source-status{margin:10px 20px 0;min-height:20px;font-size:12px;color:var(--app-text-muted);line-height:1.6}.fr-source-status[data-error=true]{color:var(--app-danger-text)}.fr-source footer{border-top:1px solid var(--app-border-subtle);margin-top:10px;padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));justify-content:flex-end}.fr-source footer [data-key=whole]{margin-right:auto}
@media(max-width:560px){.fr-source{height:calc(100dvh - 24px)}.fr-source header,.fr-source footer{padding-left:14px;padding-right:14px}.fr-source-toolbar{padding:10px 14px}.fr-source-blocks{padding-left:14px;padding-right:14px}.fr-source textarea{width:calc(100% - 28px);margin:0 14px;font-size:16px}.fr-source footer{gap:6px;flex-wrap:wrap}.fr-source footer button{font-size:13px}.fr-source-status{margin-left:14px;margin-right:14px}}
@media(prefers-reduced-motion:no-preference){.fr-source[open]{animation:fr-source-in 140ms ease-out}@keyframes fr-source-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}}
`;

// Marks existing bubbles; it never rerenders messages or reloads an iframe.
export const createFormatRepairPicker = ({ root, getMessages, getContext, onChoose, documentRef = document } = {}) => {
  const doc = documentRef, win = doc.defaultView, style = doc.createElement('style'), marked = new Map();
  style.textContent = css; doc.head.append(style);
  let active = false, frame = 0, selected = new Set(), observer, dialog = null, dialogFinish = null;
  let down = null;
  const candidates = () => {
    const messages = getMessages(getContext().sessionId) || [], last = [...messages].reverse().find(isAgentToolReply);
    const turn = last?.meta?.formatRepairTurn?.turnId;
    return new Set(messages.filter(message => isAgentToolReply(message) && (message.id === last?.id
      || turn && message.meta?.formatRepairTurn?.turnId === turn)).map(message => message.id));
  };
  const unmark = (bubble, state) => {
    state.button.remove(); bubble.classList.remove('fr-pickable', 'fr-picked', 'fr-pick-complex');
    for (const [node, inert] of state.inert) node.inert = inert;
    marked.delete(bubble);
  };
  const sync = () => {
    frame = 0; if (!active || !root) return;
    const eligible = candidates();
    for (const [bubble, state] of marked) if (!bubble.isConnected || !eligible.has(state.id)) unmark(bubble, state);
    for (const bubble of root.querySelectorAll('.QQ_chat_msgdiv')) {
      const id = bubble.closest('[data-msg-id]')?.dataset.msgId;
      if (!eligible.has(id)) continue;
      let state = marked.get(bubble);
      if (!state) {
        const control = doc.createElement('button'); control.type = 'button'; control.className = 'fr-pick-button';
        control.setAttribute('aria-label', t('选择这条回复')); control.innerHTML = '<span aria-hidden="true">○</span>';
        state = { id, button: control, inert: new Map() }; marked.set(bubble, state);
        bubble.classList.add('fr-pickable'); bubble.append(control);
      }
      const complex = bubble.querySelectorAll('iframe,canvas');
      bubble.classList.toggle('fr-pick-complex', Boolean(complex.length));
      for (const node of complex) if (!state.inert.has(node)) { state.inert.set(node, node.inert); node.inert = true; }
      const checked = selected.has(id);
      bubble.classList.toggle('fr-picked', checked); state.button.setAttribute('aria-pressed', String(checked));
      const glyph = checked ? '✓' : '○'; if (state.button.firstChild.textContent !== glyph) state.button.firstChild.textContent = glyph;
    }
  };
  const schedule = () => { if (!frame && active) frame = win.requestAnimationFrame(sync); };
  const click = event => {
    const bubble = event.target.closest('.QQ_chat_msgdiv'), state = marked.get(bubble);
    if (!state || !event.target.closest('.fr-pick-button') && (event.target.closest('a,button,input,textarea,summary,select,audio,video')
      || !win.getSelection()?.isCollapsed || down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8)) return;
    event.preventDefault(); event.stopImmediatePropagation(); onChoose(state.id);
  };
  const pointerdown = event => { down = { x: event.clientX, y: event.clientY }; };
  const contextmenu = event => { if (event.target.closest('.fr-pickable')) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const stop = () => {
    active = false; observer?.disconnect(); win.cancelAnimationFrame(frame); frame = 0;
    dialogFinish?.(null);
    root?.removeEventListener('click', click, true); root?.removeEventListener('pointerdown', pointerdown, true); root?.removeEventListener('contextmenu', contextmenu, true);
    for (const [bubble, state] of marked) unmark(bubble, state);
  };
  const showRaw = ({ source, range = null, checkType = 'custom', title = '' }) => {
    dialogFinish?.(null);
    const returnFocus = doc.activeElement;
    dialog = doc.createElement('dialog'); const panel = dialog; panel.className = 'fr-source';
    panel.setAttribute('aria-labelledby', 'fr-source-title');
    panel.innerHTML = `<header><h2 id="fr-source-title">${e(t('回复原文'))}${title ? ` · ${e(title)}` : ''}</h2>${button('close', '关闭', { icon: 'close' })}</header>
      <div class="fr-source-toolbar"><input type="search" aria-label="${e(t('查找原文'))}" placeholder="${e(t('查找原文'))}">${button('find', '下一处')}${button('wrap', '自动换行')}</div><div class="fr-source-blocks"></div>
      <textarea readonly spellcheck="false" aria-label="${e(t('回复原文，选择要检查的文字'))}" data-i18n-skip></textarea><p class="fr-source-status" role="status"></p>
      <footer>${button('whole', '使用完整回复')}${button('expand', '包含完整标签')}${button('use', '使用所选文字', { primary: true })}</footer>`;
    doc.body.append(panel);
    const textarea = panel.querySelector('textarea'), status = panel.querySelector('.fr-source-status'), use = panel.querySelector('[data-key=use]'), expand = panel.querySelector('[data-key=expand]');
    textarea.value = source; textarea.wrap = 'soft';
    let plan = null, searching = false;
    const toTextarea = offset => source.slice(0, offset).replace(/\r\n?/g, '\n').length;
    const syncSelection = () => {
      const selectedRange = mapAgentRawSelection(source, textarea.selectionStart, textarea.selectionEnd);
      plan = selectedRange.text ? createFormatRepairSelection(source, { range: selectedRange, checkType }) : null;
      use.disabled = !plan?.ok; expand.hidden = !plan?.expand;
      status.dataset.error = String(Boolean(plan && !plan.ok));
      status.textContent = plan?.ok ? t('已选 {count} 字', { count: Array.from(selectedRange.text).length })
        : plan?.message ? t(plan.message) : t('选择原文，或点击标签快速定位。');
    };
    // Measure only for an explicit jump, including wrapped lines; no mirror is
    // kept in the DOM or updated on scroll/selectionchange.
    const reveal = (start, end) => {
      textarea.focus({ preventScroll: true }); textarea.setSelectionRange(start, end);
      const mirror = doc.createElement('div'), computed = win.getComputedStyle(textarea);
      for (const prop of ['font', 'lineHeight', 'padding', 'border', 'boxSizing', 'letterSpacing', 'tabSize']) mirror.style[prop] = computed[prop];
      Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', width: `${textarea.offsetWidth}px`, whiteSpace: textarea.wrap === 'off' ? 'pre' : 'pre-wrap', overflowWrap: 'break-word' });
      mirror.textContent = textarea.value.slice(0, start); const cursor = doc.createElement('span'); cursor.textContent = '|'; mirror.append(cursor); doc.body.append(mirror);
      textarea.scrollTop = Math.max(0, cursor.offsetTop - textarea.clientHeight / 3); mirror.remove(); syncSelection();
    };
    const blocks = extractFormatFunctionBlocks(source), host = panel.querySelector('.fr-source-blocks');
    host.innerHTML = blocks.slice(0, 60).map((block, index) => `<button type="button" data-block="${index}">${e(block.kind === 'table_edit' ? 'tableEdit' : block.kind)}${blocks.filter(other => other.kind === block.kind).length > 1 ? ` ${blocks.slice(0, index + 1).filter(other => other.kind === block.kind).length}` : ''}</button>`).join('');
    const position = () => {
      const viewport = win.visualViewport;
      panel.style.maxHeight = `${(viewport?.height || win.innerHeight) - 24}px`;
      panel.style.top = `${viewport?.offsetTop || 0}px`;
    };
    return new Promise(resolve => {
      const finish = value => {
        if (dialog !== panel) return;
        dialog = null; dialogFinish = null;
        win.visualViewport?.removeEventListener('resize', position); win.visualViewport?.removeEventListener('scroll', position);
        panel.close(); panel.remove(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); resolve(value);
      };
      dialogFinish = finish;
      panel.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      textarea.addEventListener('select', syncSelection); textarea.addEventListener('keyup', syncSelection); textarea.addEventListener('pointerup', syncSelection);
      const find = () => {
        const value = panel.querySelector('input').value; if (!value) return;
        let index = textarea.value.indexOf(value, searching ? textarea.selectionEnd : 0);
        if (index < 0) index = textarea.value.indexOf(value);
        searching = true;
        if (index < 0) { status.textContent = t('未找到匹配内容'); return; }
        reveal(index, index + value.length);
      };
      panel.querySelector('input').addEventListener('input', () => { searching = false; });
      panel.querySelector('input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find(); } });
      panel.addEventListener('click', event => {
        const control = event.target.closest('button'); if (!control || control.disabled) return;
        const key = control.dataset.key;
        if (control.dataset.block !== undefined) { const block = blocks[Number(control.dataset.block)]; reveal(toTextarea(block.start), toTextarea(block.end)); }
        else if (key === 'close') finish(null);
        else if (key === 'find') find();
        else if (key === 'wrap') { textarea.wrap = textarea.wrap === 'off' ? 'soft' : 'off'; control.setAttribute('aria-pressed', String(textarea.wrap === 'soft')); }
        else if (key === 'expand' && plan?.expand) reveal(toTextarea(plan.expand.start), toTextarea(plan.expand.end));
        else if (key === 'use' && plan?.ok) finish({ start: plan.start, end: plan.end, text: source.slice(plan.start, plan.end) });
        else if (key === 'whole') {
          const whole = createFormatRepairSelection(source, { checkType });
          if (whole.ok) finish({ whole: true }); else { status.textContent = t(whole.message); status.dataset.error = 'true'; }
        }
      });
      panel.querySelector('[data-key=wrap]').setAttribute('aria-pressed', 'true');
      syncSelection(); panel.showModal(); panel.querySelector('[data-key=close]').focus({ preventScroll: true }); position();
      if (range) { textarea.setSelectionRange(toTextarea(range.start), toTextarea(range.end)); syncSelection(); }
      win.visualViewport?.addEventListener('resize', position); win.visualViewport?.addEventListener('scroll', position);
    });
  };
  return { get active() { return active; }, get rawOpen() { return Boolean(dialog); }, showRaw,
    start: () => { if (active || !root) return; active = true; selected.clear(); sync(); observer = new win.MutationObserver(schedule); observer.observe(root, { childList: true, subtree: true }); root.addEventListener('click', click, true); root.addEventListener('pointerdown', pointerdown, true); root.addEventListener('contextmenu', contextmenu, true); },
    select: ids => { selected = new Set(ids || []); schedule(); }, stop,
    dispose: () => { stop(); dialogFinish?.(null); style.remove(); },
  };
};
