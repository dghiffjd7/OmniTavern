import { t } from '../../i18n/index.js';
import { createRpMessageIconMarkup as icon } from './rp-message-actions-ui-utils.js';

const css = `
.text-fragment-editor{position:fixed;inset:auto;margin:0;width:640px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--app-border-subtle);border-radius:var(--app-radius-lg);background:var(--app-surface-card);color:var(--app-text-primary);box-shadow:var(--app-shadow-md);overflow:hidden;font-family:var(--app-font-family,inherit)}
.text-fragment-editor *{box-sizing:border-box}
.text-fragment-editor[open]{display:flex;flex-direction:column}
.text-fragment-editor::backdrop{background:var(--app-surface-overlay)}
.text-fragment-editor header{display:flex;align-items:center;gap:12px;padding:20px 22px 16px;flex:none}
.text-fragment-editor .fragment-pencil{display:grid;place-items:center;width:38px;height:38px;flex:none;border:1px solid var(--app-border-subtle);border-radius:var(--app-radius-md);color:var(--app-accent-primary);background:var(--app-accent-soft)}
.text-fragment-editor h2{font-size:17px;font-weight:650;line-height:1.35;margin:0;text-wrap:balance}
.text-fragment-editor .fragment-subtitle{margin:4px 0 0;font-size:12px;color:var(--app-text-muted);line-height:1.4}
.text-fragment-editor button{font:inherit;min-height:44px;padding:8px 18px;border:1px solid transparent;border-radius:var(--app-radius-md);background:transparent;color:var(--app-text-secondary);cursor:pointer}
.text-fragment-editor :is(button,summary):focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:3px}
.text-fragment-editor .fragment-close{margin-left:auto;display:grid;place-items:center;width:44px;flex:none;padding:0}
.text-fragment-editor .fragment-body{padding:0 22px 20px;overflow:auto;min-height:0;overscroll-behavior:contain}
.text-fragment-editor .fragment-field{border:1px solid var(--app-border-default);border-radius:var(--app-radius-md);background:var(--app-surface-input);overflow:hidden}
.text-fragment-editor .fragment-field:focus-within{border-color:color-mix(in srgb,var(--app-accent-primary) 55%,var(--app-border-default));box-shadow:0 0 0 3px var(--app-accent-soft)}
.text-fragment-editor .fragment-label{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px 0;font-size:12px;color:var(--app-text-muted)}
.text-fragment-editor .fragment-count{font-variant-numeric:tabular-nums;white-space:nowrap}
.text-fragment-editor textarea{display:block;width:100%;min-height:190px;max-height:340px;margin:0;padding:12px 16px 18px;border:0;outline:none;box-shadow:none;resize:vertical;background:transparent;color:var(--app-text-primary);font:inherit;font-size:16px;line-height:1.9;caret-color:var(--app-accent-primary);overflow-wrap:anywhere}
.text-fragment-editor details{margin-top:12px;border:0;font-size:12px;color:var(--app-text-muted)}
.text-fragment-editor summary{display:flex;align-items:center;gap:5px;min-height:44px;width:fit-content;cursor:pointer;list-style:none}
.text-fragment-editor summary::-webkit-details-marker{display:none}
.text-fragment-editor details[open] summary svg{transform:rotate(90deg)}
.text-fragment-editor pre{font:inherit;font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 14px;margin:3px 0 0;border-left:2px solid var(--app-border-default);color:var(--app-text-secondary);background:var(--app-surface-subtle);border-radius:0 var(--app-radius-sm) var(--app-radius-sm) 0;user-select:text}
.text-fragment-editor .fragment-status{font-size:12px;line-height:1.5;color:var(--app-danger-text);margin:12px 0 0}
.text-fragment-editor .fragment-status:empty{display:none}
.text-fragment-editor footer{display:flex;align-items:center;gap:14px;justify-content:space-between;padding:14px 22px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--app-border-subtle);background:var(--app-surface-subtle);flex:none}
.text-fragment-editor .fragment-scope{font-size:12px;line-height:1.5;color:var(--app-text-muted)}
.text-fragment-editor .fragment-actions{display:flex;gap:8px;flex:none}
.text-fragment-editor .fragment-save{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--app-accent-primary);color:var(--app-text-inverse);font-weight:600;font-size:14px}
.text-fragment-editor button:disabled{opacity:.45;cursor:default}
@media(hover:hover){.text-fragment-editor :is(.fragment-cancel,.fragment-close):hover{background:var(--app-surface-hover)}.text-fragment-editor .fragment-save:hover:not(:disabled){background:var(--app-accent-strong)}}
@media(max-width:560px){.text-fragment-editor header{padding:17px 16px 14px;gap:10px}.text-fragment-editor .fragment-body{padding:0 16px 14px}.text-fragment-editor footer{align-items:stretch;flex-direction:column;gap:10px;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}.text-fragment-editor .fragment-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}.text-fragment-editor textarea{min-height:150px;resize:none}.text-fragment-editor .fragment-scope{font-size:11px}}
`;

export const createTextFragmentEditor = ({ documentRef = document } = {}) => {
  const win = documentRef.defaultView, style = documentRef.createElement('style');
  style.textContent = css; documentRef.head.append(style);
  const dialog = documentRef.createElement('dialog');
  dialog.className = 'text-fragment-editor';
  dialog.setAttribute('aria-labelledby', 'fragment-editor-title');
  dialog.setAttribute('aria-describedby', 'fragment-editor-scope');
  dialog.innerHTML = `<header><span class="fragment-pencil" aria-hidden="true">${icon('edit', { size:18 })}</span><div><h2 id="fragment-editor-title"></h2><p class="fragment-subtitle"></p></div><button type="button" class="fragment-close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div class="fragment-body"><div class="fragment-field"><div class="fragment-label"><label for="fragment-selected-text"></label><span class="fragment-count"></span></div><textarea id="fragment-selected-text" spellcheck="false"></textarea></div><details><summary><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span></span></summary><pre data-i18n-skip></pre></details><p class="fragment-status" role="status"></p></div>
    <footer><span class="fragment-scope" id="fragment-editor-scope"></span><div class="fragment-actions"><button type="button" class="fragment-cancel"></button><button type="button" class="fragment-save">${icon('check', { size:16 })}<span></span></button></div></footer>`;
  documentRef.body.append(dialog);
  const textarea = dialog.querySelector('textarea'), save = dialog.querySelector('.fragment-save');
  const original = dialog.querySelector('details'), status = dialog.querySelector('.fragment-status');
  let draft = null, complete = null, busy = false, didSave = false;
  const bindings = [];
  const listen = (target, type, fn) => { target?.addEventListener(type, fn); bindings.push(() => target?.removeEventListener(type, fn)); };
  const position = () => {
    if (!dialog.open) return;
    const viewport = win.visualViewport, width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
    const panelWidth = Math.min(640, Math.max(0, width - 24));
    dialog.style.width = panelWidth + 'px'; dialog.style.maxWidth = panelWidth + 'px';
    dialog.style.maxHeight = Math.max(0, height - 24) + 'px';
    dialog.style.left = (viewport?.offsetLeft || 0) + (width - panelWidth) / 2 + 'px';
    dialog.style.top = (viewport?.offsetTop || 0) + Math.max(12, width <= 560 ? height - dialog.offsetHeight - 12 : (height - dialog.offsetHeight) / 2) + 'px';
  };
  const sync = () => {
    dialog.querySelector('.fragment-count').textContent = t('{count} 字', { count: Array.from(textarea.value).length });
    dialog.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    save.disabled = busy || !draft || textarea.value === draft.text;
    textarea.readOnly = busy;
  };
  const finish = () => { const resolve = complete; complete = null; draft = null; resolve?.(didSave); };
  listen(textarea, 'input', sync);
  listen(dialog.querySelector('.fragment-close'), 'click', () => dialog.close());
  listen(dialog.querySelector('.fragment-cancel'), 'click', () => dialog.close());
  listen(dialog, 'cancel', event => { if (busy) event.preventDefault(); });
  listen(dialog, 'close', finish);
  listen(original, 'toggle', position);
  listen(win, 'resize', position); listen(win.visualViewport, 'resize', position); listen(win.visualViewport, 'scroll', position);
  listen(save, 'click', async () => {
    if (busy || save.disabled) return;
    busy = true; sync(); status.textContent = '';
    try {
      didSave = await draft.save(textarea.value);
      if (didSave) dialog.close();
    } catch (error) { status.textContent = t(error.message); }
    finally { busy = false; sync(); position(); }
  });
  return {
    show(nextDraft) {
      if (dialog.open) return Promise.resolve(false);
      draft = nextDraft; busy = false; didSave = false;
      dialog.querySelector('h2').textContent = t('编辑片段');
      dialog.querySelector('.fragment-subtitle').textContent = draft.role === 'user' ? t('我的消息 · 所选文字') : t('当前回复 · 所选文字');
      dialog.querySelector('.fragment-close').setAttribute('aria-label', t('取消编辑'));
      dialog.querySelector('label').textContent = t('修改文字');
      dialog.querySelector('summary span').textContent = t('对照原文');
      dialog.querySelector('.fragment-scope').textContent = t('仅替换所选文字');
      dialog.querySelector('.fragment-cancel').textContent = t('取消');
      save.querySelector('span').textContent = t('保存修改');
      textarea.value = draft.text; original.querySelector('pre').textContent = draft.text; original.open = false;
      status.textContent = ''; sync();
      const result = new Promise(resolve => { complete = resolve; });
      dialog.showModal(); position(); textarea.focus(); return result;
    },
    get isOpen() { return dialog.open; },
    close() { if (dialog.open && !busy) dialog.close(); },
    dispose() { dialog.close(); finish(); bindings.forEach(remove => remove()); dialog.remove(); style.remove(); },
  };
};
