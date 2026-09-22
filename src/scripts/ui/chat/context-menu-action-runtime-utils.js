import { canDeleteCurrentSwipe, resolveViewCodeText } from './context-menu-ui-utils.js';

export const resolveContextMenuCopyText = (message, {
  wrapper,
  getBubbleCopyText,
} = {}) => {
  let text = message?.meta?.renderRich ? getBubbleCopyText?.(wrapper) : message?.content || '';
  if (!String(text || '').trim()) {
    text = message?.rawSource ?? message?.raw_source ?? message?.rawOriginal ?? message?.raw ?? message?.content ?? '';
  }
  return String(text ?? '');
};

export const dispatchContextMenuAction = async ({
  actionKey = '',
  message,
  wrapper = null,
  codeBlock = null,
  hasCode = false,
  inlineGeneratedImage = null,
  tryAction,
  hideMenu,
  clearLongPress,
  openCodeViewer,
  getBubbleCopyText,
  copyToClipboard,
  showCopyToast,
  startInlineEdit,
  enterSelectionMode,
} = {}) => {
  hideMenu?.();
  clearLongPress?.();

  if (actionKey === 'view-code') {
    const handled = await tryAction?.('view-code', { wrapper, codeBlock });
    if (handled) return 'handled';
    openCodeViewer?.({ message, text: resolveViewCodeText(message) });
    return 'view-code';
  }

  if (actionKey === 'copy-text') {
    const handled = await tryAction?.('copy-text', { wrapper, codeBlock });
    if (handled) return 'handled';
    const text = resolveContextMenuCopyText(message, { wrapper, getBubbleCopyText });
    const ok = await copyToClipboard?.(text);
    showCopyToast?.(ok === true);
    return ok ? 'copied' : 'copy-failed';
  }

  if (actionKey === 'reply') {
    await tryAction?.('reply', { wrapper }, { skipFallback: true });
    return 'reply';
  }

  if (actionKey === 'generate-image' || actionKey === 'repeat-image-generation') {
    await tryAction?.(actionKey, { wrapper, inlineGeneratedImage }, { skipFallback: true });
    return actionKey;
  }

  if (actionKey === 'edit') {
    startInlineEdit?.(message);
    return 'edit';
  }

  if (actionKey === 'delete' && message?.role === 'assistant') {
    if (canDeleteCurrentSwipe(message)) {
      const handled = await tryAction?.('delete', { wrapper, deleteScope: 'choose-swipe-or-message' }, { skipFallback: true });
      if (handled) return 'handled';
    }
    enterSelectionMode?.(message?.id);
    return 'delete-selection';
  }

  if (actionKey === 'speak') {
    await tryAction?.('speak', { wrapper }, { skipFallback: true });
    return 'speak';
  }

  await tryAction?.(actionKey, undefined, { skipFallback: true });
  return actionKey || 'noop';
};
