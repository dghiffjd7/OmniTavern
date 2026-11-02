// 带「撤销」按钮的通知：沿用 APP 的 toastr（位置、主题跟着设定），按钮点了只做撤销，
// 不触发通知本身的点击行为（全局点击会复制通知文字并停用点击）。
const STYLE_ID = 'user-tool-undo-toast-style';
const STYLE = `
.app-undo-toast-row { display: flex; align-items: center; gap: 10px; }
.app-undo-toast-row span { flex: 1 1 auto; min-width: 0; }
.app-undo-toast-btn { flex: 0 0 auto; padding: 3px 12px; border: 1px solid currentColor; border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: 12.5px; font-weight: 800; cursor: pointer; pointer-events: auto; }
.app-undo-toast-btn:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.app-undo-toast-btn:disabled { opacity: .6; cursor: default; }
`;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** message、actionLabel 由调用方翻译好；onAction 只会被调用一次。返回 { dismiss }。 */
export const showUndoToast = ({ toastr = globalThis.window?.toastr, documentRef = globalThis.document, message = '', actionLabel = '', timeoutMs = 10000, onAction = () => {} } = {}) => {
  if (!toastr?.info) return { dismiss: () => {} };
  if (documentRef?.head && !documentRef.getElementById?.(STYLE_ID)) {
    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    documentRef.head.appendChild(style);
  }
  const html = `<div class="app-undo-toast-row"><span>${escapeHtml(message)}</span><button type="button" class="app-undo-toast-btn">${escapeHtml(actionLabel)}</button></div>`;
  const toast = toastr.info(html, '', { timeOut: timeoutMs, extendedTimeOut: 3000, tapToDismiss: false, closeButton: true, escapeHtml: false, preventDuplicates: false, onclick: null });
  const element = toast?.[0] || toast || null;
  const button = element?.querySelector?.('.app-undo-toast-btn');
  let used = false;
  button?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (used) return;
    used = true;
    button.disabled = true;
    // 按钮取得了焦点：toastr 默认不清掉有焦点的通知，要 force
    try { toastr.clear?.(toast, { force: true }); } catch {}
    void onAction();
  });
  return {
    dismiss: () => { if (!used) { used = true; try { toastr.clear?.(toast, { force: true }); } catch {} } },
  };
};
