const CANCEL_ICON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const SAVE_ICON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5"/></svg>';

export const createInlineEditUiRuntime = ({
  documentLike,
  windowLike = null,
  schedule,
  onConfirmEdit,
} = {}) => ({
  startInlineEdit({ scrollEl, message, initialText } = {}) {
    const wrapper = scrollEl?.querySelector?.(`[data-msg-id="${message?.id}"]`);
    const bubble = wrapper?.querySelector?.('.QQ_chat_msgdiv');
    if (!bubble || !documentLike?.createElement) return false;
    if (wrapper?.classList?.contains?.('is-inline-editing')) return false;

    const originalText = initialText == null
      ? (
        typeof message?.rawInput === 'string'
          ? message.rawInput
          : (typeof message?.raw === 'string' ? message.raw : String(message?.content || ''))
      )
      : String(initialText);
    const originalNodes = Array.from(bubble.childNodes || []);
    const originalBubbleStyle = {
      whiteSpace: bubble.style?.whiteSpace || '',
      minWidth: bubble.style?.minWidth || '',
      boxShadow: bubble.style?.boxShadow || '',
      transition: bubble.style?.transition || '',
    };
    // 桌面（精确指针）才把 Enter 提升为保存；触屏软键盘 Enter 保持换行。
    const finePointer = Boolean(windowLike?.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches);
    let settled = false;
    let composing = false;
    let saving = false;
    wrapper?.classList?.add?.('is-inline-editing');
    bubble.classList?.add?.('is-inline-editing');
    // 编辑态保持气泡形态：气泡自身加 accent 描边环，textarea 透明融入。
    bubble.style.minWidth = 'min(320px, calc(100vw - 96px))';
    bubble.style.transition = 'box-shadow 0.15s ease';
    bubble.style.boxShadow = '0 0 0 2px rgba(var(--app-accent-rgb), 0.45), 0 6px 18px rgba(0, 0, 0, 0.1)';
    const shell = documentLike.createElement('div');
    shell.className = 'chat-inline-edit-shell';
    shell.style.cssText = `
      width:100%;
      display:flex;
      flex-direction:column;
      gap:6px;
    `;
    const ta = documentLike.createElement('textarea');
    ta.className = 'chat-inline-edit-textarea';
    if (
      message?.role === 'user'
      && String(documentLike?.body?.dataset?.uiMode || '').trim().toLowerCase() === 'rp'
      && ta.dataset
    ) {
      ta.dataset.viewportKeyboardDiagnostic = 'creative-user-bubble-edit';
    }
    ta.value = originalText;
    ta.style.cssText = `
            width: 100%;
            height: auto;
            min-height: 1.5em;
            max-height: 56vh;
            border: none;
            outline: none;
            margin: 0;
            padding: 0;
            font: inherit;
            line-height: inherit;
            resize: none;
            background: transparent;
            color: inherit;
            caret-color: var(--app-accent-primary);
            box-sizing: border-box;
            white-space: pre-wrap;
        `;
    const status = documentLike.createElement('div');
    status.className = 'chat-inline-edit-status';
    const idleHint = finePointer ? 'Enter 保存 · Esc 取消' : '';
    status.textContent = idleHint;
    status.style.cssText = `
      color:var(--app-text-muted);
      font-size:11px;
      line-height:1.35;
    `;
    const actions = documentLike.createElement('div');
    actions.className = 'chat-inline-edit-actions';
    actions.style.cssText = 'display:flex; justify-content:flex-end; align-items:center; gap:8px;';
    const iconButtonBase = `
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:28px;
      height:28px;
      border-radius:50%;
      padding:0;
      cursor:pointer;
    `;
    const cancelBtn = documentLike.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'chat-inline-edit-cancel';
    cancelBtn.innerHTML = CANCEL_ICON_SVG;
    cancelBtn.setAttribute?.('aria-label', '取消编辑');
    cancelBtn.title = '取消';
    cancelBtn.style.cssText = `${iconButtonBase}
      border:1px solid var(--app-border-default);
      background:var(--app-surface-card);
      color:var(--app-text-secondary);
    `;
    const saveBtn = documentLike.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'chat-inline-edit-save';
    saveBtn.innerHTML = SAVE_ICON_SVG;
    saveBtn.setAttribute?.('aria-label', '保存编辑');
    saveBtn.title = '保存';
    saveBtn.style.cssText = `${iconButtonBase}
      border:none;
      background:var(--app-accent-primary);
      color:var(--app-text-inverse);
    `;
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    shell.appendChild(ta);
    shell.appendChild(status);
    shell.appendChild(actions);

    // 点击气泡外不结束编辑：只有 ✔（保存）或 ×／Esc（放弃）才结束，避免误点丢掉修改
    const cleanupEditState = () => {
      wrapper?.classList?.remove?.('is-inline-editing');
      bubble.classList?.remove?.('is-inline-editing');
      bubble.style.minWidth = originalBubbleStyle.minWidth;
      bubble.style.boxShadow = originalBubbleStyle.boxShadow;
      bubble.style.transition = originalBubbleStyle.transition;
    };

    const restoreOriginal = () => {
      if (settled) return;
      settled = true;
      cleanupEditState();
      bubble.innerHTML = '';
      if (originalNodes.length) {
        originalNodes.forEach(node => bubble.appendChild?.(node));
        bubble.style.whiteSpace = originalBubbleStyle.whiteSpace;
      } else {
        bubble.textContent = originalText;
        bubble.style.whiteSpace = 'pre-wrap';
      }
    };

    // 先收成 auto 量高度时聊天列表会变短，滚在接近底部的列表会被截短滚动位置；量完放回原位置
    const resize = () => {
      const listTop = scrollEl?.scrollTop;
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
      if (typeof listTop === 'number' && scrollEl.scrollTop !== listTop) scrollEl.scrollTop = listTop;
    };
    ta.addEventListener('input', resize);

    const save = async () => {
      if (settled || saving || composing) return false;
      const newText = String(ta.value ?? '');
      if (newText === originalText) {
        restoreOriginal();
        return true;
      }
      saving = true;
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = '正在保存…';
      try {
        const result = await onConfirmEdit?.(message, newText);
        if (result === false) {
          status.textContent = '保存未完成，修改仍保留';
          return false;
        }
        settled = true;
        cleanupEditState();
        return true;
      } catch (error) {
        status.textContent = error?.message || '保存失败，修改仍保留';
        return false;
      } finally {
        saving = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    };

    ta.addEventListener('compositionstart', () => {
      composing = true;
    });
    ta.addEventListener('compositionend', () => {
      composing = false;
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !composing && e.isComposing !== true) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          save();
          return;
        }
        if (finePointer && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          save();
          return;
        }
      }
      if (e.key === 'Escape' && !composing && !saving) {
        e.preventDefault();
        restoreOriginal();
      }
    });
    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', () => {
      if (!saving) restoreOriginal();
    });

    bubble.innerHTML = '';
    bubble.appendChild(shell);
    schedule?.(() => {
      resize();
      ta.focus?.();
      ta.setSelectionRange?.(ta.value.length, ta.value.length);
    });
    return true;
  },
});
